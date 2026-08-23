import { createHash, verify as verifySignature } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { BuildInfo } from '../runtime/build-info.ts';
import type { BrokerConfig } from '../runtime/configuration.ts';
import { inspectBrokerConfig } from '../runtime/configuration.ts';
import { brokerTokenPath, inspectBrokerToken, readBrokerToken } from '../security/credentials.ts';
import {
  durableStateLayout,
  inspectDurableSchemas,
  isRuntimeCompatibleConfigV1,
} from '../security/durable-state.ts';
import {
  inspectInstallState,
  writeInstallState,
  type CommittedInstallState,
  type InstalledResourceRecord,
} from '../installation/install-state.ts';
import { acquireInstallationLock, type InstallationLockHandle } from '../installation/installation-lock.ts';
import { PRODUCT_IDENTITY } from '@cosyncing/protocol';
import {
  assertNoSymlinkComponents,
  atomicWriteJsonOwnerOnly,
  atomicWriteOwnerOnly,
  inspectOwnerOnlyFile,
} from '../security/secure-files.ts';

declare const COSYNCING_RELEASE_MANIFEST_URL: string | undefined;
declare const COSYNCING_RELEASE_CHANNEL_MANIFEST_URL: string | undefined;
declare const COSYNCING_RELEASE_KEY_ID: string | undefined;
declare const COSYNCING_RELEASE_PUBLIC_KEY_PEM: string | undefined;

export const RELEASE_MANIFEST_SCHEMA_VERSION = 1 as const;
export const UPGRADE_JOURNAL_SCHEMA_VERSION = 1 as const;
export const MAX_RELEASE_MANIFEST_BYTES = 256 * 1024;
export const MAX_RELEASE_ARTIFACT_BYTES = 256 * 1024 * 1024;

/** Every host target a signed manifest may name. A binary only ever selects the one matching its own build
 *  target, so a mixed linux+darwin manifest verifies unchanged on both and each host ignores the others. */
export const RELEASE_ARTIFACT_TARGETS = Object.freeze(['linux-x64', 'linux-arm64', 'darwin-arm64'] as const);

export interface ReleaseArtifact {
  name: string;
  target: string;
  platform: 'linux' | 'darwin';
  arch: 'x64' | 'arm64';
  size: number;
  sha256: string;
  url: string;
  provenanceUrl: string;
}

export interface ReleaseContractIdentity {
  revision: number;
  minimumClientRevision: number;
  surfaceHash: string;
}

export interface ReleaseWebSidecar {
  name: string;
  mount: '/cosy/';
  size: number;
  sha256: string;
  url: string;
  buildId: string;
  cacheManifestSha256: string;
  mainDartSha256: string;
  directorySha256: string;
  fileCount: number;
}

export interface ReleaseManifest {
  schemaVersion: typeof RELEASE_MANIFEST_SCHEMA_VERSION;
  product: typeof PRODUCT_IDENTITY.productName;
  version: string;
  channel: 'stable';
  sourceCommit: string;
  publishedAt: string;
  artifacts: ReleaseArtifact[];
  /** Present on RG1 release sets. Omitted only by legacy manifests. */
  contract?: ReleaseContractIdentity;
  /** Signed web-client half of the broker/web release pair. */
  webApp?: ReleaseWebSidecar;
  signature: {
    algorithm: 'ed25519';
    keyId: string;
    value: string;
  };
}

export interface VerifiedRelease {
  manifest: ReleaseManifest;
  artifact: ReleaseArtifact;
}

export interface ReleaseUpdateCheckResult {
  schemaVersion: 1;
  status: 'current' | 'update-available' | 'unknown';
  currentVersion: string;
  latestVersion?: string;
  publishedAt?: string;
  checkedAt: string;
  detailCode: string;
}

export interface ReleaseUpdateCheckDependencies {
  buildInfo: Readonly<BuildInfo>;
  manifestUrl?: string;
  trustedKeys?: Readonly<Record<string, string>>;
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface UpgradeServiceController {
  inspect(): Promise<{ active: boolean }>;
  stop(): Promise<void>;
  start(): Promise<void>;
}

export interface UpgradeBinaryResult {
  status: 'ok' | 'error' | 'timeout' | 'unavailable';
  exitCode?: number;
  stdout: string;
  stderr: string;
}

export interface UpgradeCommandResult {
  schemaVersion: 1;
  status: 'complete' | 'already-current' | 'blocked' | 'failed' | 'rolled-back' | 'cleanup-required';
  exitCode: 0 | 1 | 3 | 4;
  detailCode: string;
  summary: string;
  fromVersion: string;
  toVersion?: string;
  recoveredInterruptedUpgrade: boolean;
}

interface UpgradeJournal {
  schemaVersion: typeof UPGRADE_JOURNAL_SCHEMA_VERSION;
  product: typeof PRODUCT_IDENTITY.productName;
  phase: 'prepared' | 'switching' | 'switched';
  fromVersion: string;
  toVersion: string;
  targetPath: string;
  previousPath: string;
  stagingPath: string;
  expectedSha256: string;
  previousSha256: string;
  serviceWasActive: boolean;
  updatedAt: string;
}

export interface UpgradeDependencies {
  home: string;
  cacheRoot?: string;
  buildInfo: Readonly<BuildInfo>;
  executablePath: string;
  manifestUrl?: string;
  trustedKeys?: Readonly<Record<string, string>>;
  fetch?: typeof fetch;
  runBinary?: (executable: string, args: readonly string[]) => Promise<UpgradeBinaryResult>;
  service?: UpgradeServiceController;
  verifyBrokerVersion?: (config: BrokerConfig, expectedVersion: string) => Promise<boolean>;
  healthAttempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  acquireLock?: (options: { command: 'upgrade'; home: string }) => InstallationLockHandle;
  now?: () => Date;
  /** Deterministic crash injection for the upgrade acceptance lane. */
  faultAfter?: 'journal-prepared' | 'service-stopped' | 'binary-switched' | 'receipt-committed';
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

export function releaseManifestSigningPayload(manifest: Omit<ReleaseManifest, 'signature'>): Uint8Array {
  return Buffer.from(canonicalJson(manifest), 'utf8');
}

function safeHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2_048 || /[\0\r\n]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function validVersion(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    return false;
  }
  const [core] = value.split('-', 1);
  return core!.split('.').every((part) => Number.isSafeInteger(Number(part)));
}

function validSha(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validReleaseArtifact(value: unknown): value is ReleaseArtifact {
  if (!plainObject(value)) return false;
  return typeof value.name === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.name)
    && typeof value.target === 'string'
    && (RELEASE_ARTIFACT_TARGETS as readonly string[]).includes(value.target)
    && (value.platform === 'linux' || value.platform === 'darwin')
    && (value.arch === 'x64' || value.arch === 'arm64')
    && Number.isSafeInteger(value.size) && (value.size as number) > 0
    && (value.size as number) <= MAX_RELEASE_ARTIFACT_BYTES
    && validSha(value.sha256)
    && safeHttpsUrl(value.url)
    && safeHttpsUrl(value.provenanceUrl);
}

function validReleaseContract(value: unknown): value is ReleaseContractIdentity {
  if (!plainObject(value)) return false;
  return Number.isSafeInteger(value.revision) && (value.revision as number) >= 0
    && Number.isSafeInteger(value.minimumClientRevision)
    && (value.minimumClientRevision as number) >= 0
    && (value.minimumClientRevision as number) <= (value.revision as number)
    && typeof value.surfaceHash === 'string'
    && /^fnv1a32:[a-f0-9]{8}$/.test(value.surfaceHash);
}

function validReleaseWebSidecar(value: unknown): value is ReleaseWebSidecar {
  if (!plainObject(value)) return false;
  return value.name === 'cosyncing-web-app.tar.gz'
    && value.mount === '/cosy/'
    && Number.isSafeInteger(value.size) && (value.size as number) > 0
    && (value.size as number) <= MAX_RELEASE_ARTIFACT_BYTES
    && validSha(value.sha256)
    && safeHttpsUrl(value.url)
    && typeof value.buildId === 'string'
    && /^[a-f0-9]{16}$/.test(value.buildId)
    && validSha(value.cacheManifestSha256)
    && validSha(value.mainDartSha256)
    && validSha(value.directorySha256)
    && Number.isSafeInteger(value.fileCount)
    && (value.fileCount as number) > 0
    && (value.fileCount as number) <= 100_000;
}

function parseManifest(value: unknown): ReleaseManifest {
  if (!plainObject(value)
      || value.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION
      || value.product !== PRODUCT_IDENTITY.productName
      || !validVersion(value.version)
      || value.channel !== 'stable'
      || typeof value.sourceCommit !== 'string' || !/^[a-f0-9]{7,64}$/.test(value.sourceCommit)
      || typeof value.publishedAt !== 'string' || !Number.isFinite(Date.parse(value.publishedAt))
      || !Array.isArray(value.artifacts) || value.artifacts.length < 1 || value.artifacts.length > 8
      || !value.artifacts.every(validReleaseArtifact)
      || ((value.contract === undefined) !== (value.webApp === undefined))
      || (value.contract !== undefined && !validReleaseContract(value.contract))
      || (value.webApp !== undefined && !validReleaseWebSidecar(value.webApp))
      || !plainObject(value.signature)
      || value.signature.algorithm !== 'ed25519'
      || typeof value.signature.keyId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(value.signature.keyId)
      || typeof value.signature.value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.signature.value)) {
    throw new Error('release-manifest-invalid');
  }
  const manifest = value as unknown as ReleaseManifest;
  if (new Set(manifest.artifacts.map((artifact) => artifact.target)).size !== manifest.artifacts.length) {
    throw new Error('release-manifest-duplicate-target');
  }
  return manifest;
}

/** RG1 promotion gate. Runtime verification still accepts legacy native-only manifests. */
export function verifyReleasePairing(manifest: ReleaseManifest): {
  contract: ReleaseContractIdentity;
  webApp: ReleaseWebSidecar;
} {
  if (!manifest.contract || !manifest.webApp) {
    throw new Error('release-broker-web-pairing-missing');
  }
  return { contract: manifest.contract, webApp: manifest.webApp };
}

export function verifyReleaseManifest(options: {
  value: unknown;
  target: string;
  trustedKeys: Readonly<Record<string, string>>;
}): VerifiedRelease {
  const manifest = parseManifest(options.value);
  const trustedKey = options.trustedKeys[manifest.signature.keyId];
  if (!trustedKey) throw new Error('release-signing-key-untrusted');
  const { signature, ...unsigned } = manifest;
  let verified = false;
  try {
    verified = verifySignature(
      null,
      releaseManifestSigningPayload(unsigned),
      trustedKey,
      Buffer.from(signature.value, 'base64'),
    );
  } catch {
    verified = false;
  }
  if (!verified) throw new Error('release-manifest-signature-invalid');
  const artifact = manifest.artifacts.find((candidate) => candidate.target === options.target);
  if (!artifact) throw new Error('release-target-unavailable');
  if (artifact.name !== `${PRODUCT_IDENTITY.releaseAssetPrefix}-${artifact.target}`) {
    throw new Error('release-artifact-name-invalid');
  }
  if (artifact.target !== `${artifact.platform}-${artifact.arch}`) throw new Error('release-artifact-target-invalid');
  return { manifest, artifact };
}

function releaseKeys(): Readonly<Record<string, string>> {
  const keyId = typeof COSYNCING_RELEASE_KEY_ID === 'undefined' ? '' : COSYNCING_RELEASE_KEY_ID?.trim();
  const key = typeof COSYNCING_RELEASE_PUBLIC_KEY_PEM === 'undefined' ? '' : COSYNCING_RELEASE_PUBLIC_KEY_PEM?.trim();
  return keyId && key ? { [keyId]: key } : {};
}

function defaultManifestUrl(): string | undefined {
  const channel = typeof COSYNCING_RELEASE_CHANNEL_MANIFEST_URL === 'undefined'
    ? ''
    : COSYNCING_RELEASE_CHANNEL_MANIFEST_URL?.trim();
  if (channel) return channel;
  const pinned = typeof COSYNCING_RELEASE_MANIFEST_URL === 'undefined' ? '' : COSYNCING_RELEASE_MANIFEST_URL?.trim();
  return pinned || undefined;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function boundedDownload(fetcher: typeof fetch, url: string, maximum: number): Promise<Uint8Array> {
  if (!safeHttpsUrl(url)) throw new Error('release-url-invalid');
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { accept: 'application/json, application/octet-stream' },
      // GitHub release assets, including /releases/latest/download, redirect to an immutable HTTPS
      // asset URL. No credentials are sent, and the manifest signature/artifact hash remain authoritative.
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error('release-download-unavailable');
  }
  if (!response.ok) throw new Error('release-download-unavailable');
  if (response.url && !safeHttpsUrl(response.url)) throw new Error('release-url-invalid');
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maximum) throw new Error('release-download-too-large');
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new Error('release-download-too-large');
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'release-download-too-large') throw error;
    throw new Error('release-download-unavailable');
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The single manifest artifact this build may install. Every other target in the manifest is ignored. */
function currentTarget(buildInfo: Readonly<BuildInfo>): string {
  if ((RELEASE_ARTIFACT_TARGETS as readonly string[]).includes(buildInfo.target)) return buildInfo.target;
  throw new Error('upgrade-host-unsupported');
}

export interface PackageManagerUpdateGuidance {
  detailCode: string;
  /** The exact command that moves the acquisition package, and the setup that adopts it. */
  updateCommand: string;
  setupCommand: string;
  summary: string;
}

/**
 * What "update me" actually means for a distribution cosyncing does not own the acquisition of.
 *
 * The JavaScript package is installed, moved, and removed by a package manager. cosyncing replacing that
 * package from inside itself would fight the tool that owns those files — and the signed-artifact channel it
 * would have to use ships compiled native binaries this distribution must never install. So the honest
 * answer is instructions, and every surface that could otherwise imply "an update was applied" returns this
 * same text: the CLI's `upgrade`, the app-triggered handoff, and the release-channel probe.
 *
 * `bun install --global` is not offered as an alternative here for the same reason npm is named exactly:
 * whichever manager placed the package is the one that must move it, and only the caller's own install
 * record knows which that was. Naming npm — the published channel — plus `setup` keeps the guidance true
 * for the documented path without inventing a claim about the operator's machine.
 */
export function packageManagerUpdateGuidance(
  buildInfo: Readonly<Pick<BuildInfo, 'distribution'>>,
): PackageManagerUpdateGuidance | undefined {
  if (buildInfo.distribution !== 'bun-js') return undefined;
  const updateCommand = `npm update --global ${PRODUCT_IDENTITY.productName}`;
  const setupCommand = `${PRODUCT_IDENTITY.primaryBinary} setup`;
  return {
    detailCode: 'upgrade-package-manager-owned',
    updateCommand,
    setupCommand,
    summary: `This ${PRODUCT_IDENTITY.productName} build is a JavaScript package your package manager owns, `
      + `so it is not replaced from inside the broker. Run \`${updateCommand}\` (or the equivalent for the `
      + `manager you installed it with), then \`${setupCommand}\` to adopt the new version.`,
  };
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string): { core: number[]; prerelease?: string[] } => {
    const [core, prerelease] = value.split('-', 2);
    return { core: core!.split('.').map(Number), ...(prerelease ? { prerelease: prerelease.split('.') } : {}) };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}

/**
 * Metadata-only stable-channel probe. It verifies the same signed manifest and target binding as
 * upgrade, but never downloads an artifact and never throws for channel/network failures.
 */
export async function checkReleaseUpdate(
  dependencies: ReleaseUpdateCheckDependencies,
): Promise<ReleaseUpdateCheckResult> {
  const currentVersion = dependencies.buildInfo.version;
  const checkedAt = (dependencies.now?.() ?? new Date()).toISOString();
  const unknown = (detailCode: string): ReleaseUpdateCheckResult => ({
    schemaVersion: 1,
    status: 'unknown',
    currentVersion,
    checkedAt,
    detailCode,
  });
  // Before any network call: the signed manifest describes compiled native artifacts, so probing it from a
  // JavaScript install could only ever produce a version this build must not install. Reporting that as
  // "update available" is what would make the app's update surface offer a native swap that cannot happen.
  const guidance = packageManagerUpdateGuidance(dependencies.buildInfo);
  if (guidance) return unknown(guidance.detailCode);
  const manifestUrl = dependencies.manifestUrl ?? defaultManifestUrl();
  const trustedKeys = dependencies.trustedKeys ?? releaseKeys();
  if (!manifestUrl || Object.keys(trustedKeys).length === 0) {
    return unknown('release-channel-unconfigured');
  }
  try {
    const manifestBytes = await boundedDownload(
      dependencies.fetch ?? fetch,
      manifestUrl,
      MAX_RELEASE_MANIFEST_BYTES,
    );
    let manifestValue: unknown;
    try {
      manifestValue = JSON.parse(Buffer.from(manifestBytes).toString('utf8'));
    } catch {
      throw new Error('release-manifest-malformed');
    }
    const verified = verifyReleaseManifest({
      value: manifestValue,
      target: currentTarget(dependencies.buildInfo),
      trustedKeys,
    });
    const comparison = compareVersions(verified.manifest.version, currentVersion);
    return {
      schemaVersion: 1,
      status: comparison > 0 ? 'update-available' : 'current',
      currentVersion,
      latestVersion: verified.manifest.version,
      publishedAt: verified.manifest.publishedAt,
      checkedAt,
      detailCode: comparison > 0
        ? 'release-update-available'
        : comparison < 0 ? 'release-channel-behind' : 'release-already-current',
    };
  } catch (error) {
    return unknown(error instanceof Error ? error.message : 'release-check-failed');
  }
}

async function defaultRunBinary(executable: string, args: readonly string[]): Promise<UpgradeBinaryResult> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([executable, ...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
  } catch {
    return { status: 'unavailable', stdout: '', stderr: '' };
  }
  const completed = await Promise.race([
    child.exited.then((exitCode) => ({ timedOut: false as const, exitCode })),
    Bun.sleep(15_000).then(() => ({ timedOut: true as const, exitCode: undefined })),
  ]);
  if (completed.timedOut) child.kill('SIGKILL');
  const streamText = (value: number | ReadableStream<Uint8Array> | undefined): Promise<string> =>
    value instanceof ReadableStream ? new Response(value).text() : Promise.resolve('');
  const [stdout, stderr] = await Promise.all([
    streamText(child.stdout),
    streamText(child.stderr),
  ]);
  if (completed.timedOut) {
    await child.exited.catch(() => undefined);
    return { status: 'timeout', stdout: stdout.slice(-16_384), stderr: stderr.slice(-16_384) };
  }
  return {
    status: completed.exitCode === 0 ? 'ok' : 'error',
    exitCode: completed.exitCode,
    stdout: stdout.slice(-16_384),
    stderr: stderr.slice(-16_384),
  };
}

/**
 * Resolve the one file an upgrade may replace: the receipt-owned canonical binary at `<home>/bin/cosyncing`.
 *
 * The upgrade target is identified by the RECEIPT plus that fixed path, never by what is currently running.
 * Since setup's bootstrap copy, the running executable is routinely a mere launcher for the installed copy —
 * an `npm i -g` artifact under `node_modules`, or the `cosy` alias — and after the first successful upgrade
 * the acquisition artifact is deliberately left behind at its old version. Requiring
 * `executablePath === target` therefore rejected exactly the invocations the install channel makes normal.
 * The safety that matters is unchanged and enforced below: absolute canonical path inside the owner-only
 * state home, our exact product basename, no symlink components, a regular file owned by this user, and a
 * measured sha256 that matches the receipt.
 */
function safeInstalledBinaryPath(
  home: string,
  state: CommittedInstallState,
  verifyInstalledHash = true,
): string {
  const resource = state.resources.find((candidate) => candidate.id === 'broker-binary');
  if (!resource || resource.kind !== 'binary'
      || !['receipt', 'package-hash'].includes(resource.ownership.proof)
      || !validSha(resource.ownership.installedSha256)) {
    throw new Error('installed-binary-receipt-invalid');
  }
  const target = resolve(resource.target);
  const expectedDirectory = resolve(join(home, 'bin'));
  if (!isAbsolute(target)
      || dirname(target) !== expectedDirectory || basename(target) !== PRODUCT_IDENTITY.primaryBinary) {
    throw new Error('installed-binary-receipt-invalid');
  }
  assertNoSymlinkComponents(target, false);
  if (!existsSync(target)) throw new Error('installed-binary-missing');
  const stat = lstatSync(target);
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (stat.isSymbolicLink() || !stat.isFile() || (uid !== undefined && stat.uid !== uid)) {
    throw new Error('installed-binary-unsafe');
  }
  if (verifyInstalledHash && sha256(readFileSync(target)) !== resource.ownership.installedSha256) {
    throw new Error('installed-binary-hash-drift');
  }
  return target;
}

function upgradeJournalPath(home: string): string {
  return join(home, 'upgrade-journal.json');
}

function writeJournal(home: string, journal: UpgradeJournal): void {
  atomicWriteJsonOwnerOnly(upgradeJournalPath(home), journal);
}

function parseJournal(home: string, targetPath: string): UpgradeJournal | undefined {
  const path = upgradeJournalPath(home);
  const inspection = inspectOwnerOnlyFile(path);
  if (inspection.status === 'missing') return undefined;
  if (inspection.status !== 'ok') throw new Error('upgrade-journal-unsafe');
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('upgrade-journal-malformed'); }
  if (!plainObject(value)
      || value.schemaVersion !== UPGRADE_JOURNAL_SCHEMA_VERSION
      || value.product !== PRODUCT_IDENTITY.productName
      || !['prepared', 'switching', 'switched'].includes(String(value.phase))
      || !validVersion(value.fromVersion) || !validVersion(value.toVersion)
      || typeof value.targetPath !== 'string' || resolve(value.targetPath) !== resolve(targetPath)
      || typeof value.previousPath !== 'string'
      || resolve(value.previousPath) !== resolve(join(home, 'bin', `${PRODUCT_IDENTITY.primaryBinary}.previous`))
      || typeof value.stagingPath !== 'string'
      || resolve(value.stagingPath) !== resolve(join(home, 'bin', `${PRODUCT_IDENTITY.primaryBinary}.staging-${String(value.toVersion)}`))
      || !validSha(value.expectedSha256) || !validSha(value.previousSha256)
      || typeof value.serviceWasActive !== 'boolean'
      || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error('upgrade-journal-malformed');
  }
  return value as unknown as UpgradeJournal;
}

function unlinkRegular(path: string): void {
  if (!existsSync(path)) return;
  assertNoSymlinkComponents(path, false);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('upgrade-cleanup-target-unsafe');
  unlinkSync(path);
}

async function recoverUpgrade(options: {
  home: string;
  targetPath: string;
  service?: UpgradeServiceController;
}): Promise<boolean> {
  const journal = parseJournal(options.home, options.targetPath);
  if (!journal) return false;
  if (journal.phase !== 'prepared') {
    assertNoSymlinkComponents(journal.previousPath, false);
    if (!existsSync(journal.previousPath)) throw new Error('upgrade-rollback-binary-missing');
    const previousStat = lstatSync(journal.previousPath);
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (previousStat.isSymbolicLink() || !previousStat.isFile()
        || (uid !== undefined && previousStat.uid !== uid)) {
      throw new Error('upgrade-rollback-binary-unsafe');
    }
    const previous = readFileSync(journal.previousPath);
    if (sha256(previous) !== journal.previousSha256) throw new Error('upgrade-rollback-binary-mismatch');
    atomicWriteOwnerOnly(journal.targetPath, previous, { mode: 0o700 });
  }
  const install = inspectInstallState(options.home);
  if (!install.committed) throw new Error('upgrade-rollback-receipt-missing');
  const resources = new Map(install.state.resources.map((resource) => [resource.id, resource]));
  const priorBinary = resources.get('broker-binary');
  resources.set('broker-binary', {
    id: 'broker-binary',
    kind: 'binary',
    target: journal.targetPath,
    ownership: {
      proof: priorBinary?.ownership.proof === 'receipt' ? 'receipt' : 'package-hash',
      installedSha256: journal.previousSha256,
    },
  });
  const installer = plainObject(install.state.installer) ? install.state.installer : {};
  writeInstallState({
    ...install.state,
    resources: [...resources.values()].sort((left, right) => left.id.localeCompare(right.id)),
    installer: { ...installer, version: journal.fromVersion },
  }, options.home);
  if (journal.serviceWasActive && options.service) await options.service.start();
  unlinkRegular(journal.stagingPath);
  unlinkRegular(upgradeJournalPath(options.home));
  return true;
}

async function defaultVerifyBrokerVersion(home: string, config: BrokerConfig, expectedVersion: string): Promise<boolean> {
  const tokenInspection = inspectBrokerToken(brokerTokenPath(home));
  if (tokenInspection.status !== 'ok') return false;
  try {
    const response = await fetch(new URL('/api/health', config.broker.internalUrl), {
      headers: { [PRODUCT_IDENTITY.tokenHeader]: readBrokerToken(tokenInspection.path) },
      redirect: 'error',
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return false;
    const body = await response.json() as Record<string, unknown>;
    return body.ok === true && body.product === PRODUCT_IDENTITY.productName
      && body.version === expectedVersion && body.machine === config.broker.machineLabel;
  } catch {
    return false;
  }
}

function updateBinaryReceipt(
  state: CommittedInstallState,
  targetPath: string,
  previousPath: string,
  version: string,
  installedSha256: string,
  previousSha256: string,
): CommittedInstallState {
  const resources = new Map(state.resources.map((resource) => [resource.id, resource]));
  resources.set('broker-binary', {
    id: 'broker-binary',
    kind: 'binary',
    target: targetPath,
    ownership: { proof: 'package-hash', installedSha256 },
  });
  resources.set('broker-binary-previous', {
    id: 'broker-binary-previous',
    kind: 'binary',
    target: previousPath,
    ownership: { proof: 'package-hash', installedSha256: previousSha256 },
  });
  const installer = plainObject(state.installer) ? state.installer : {};
  return {
    ...state,
    resources: [...resources.values()].sort((left, right) => left.id.localeCompare(right.id)),
    installer: { ...installer, version },
  };
}

function result(
  status: UpgradeCommandResult['status'],
  exitCode: UpgradeCommandResult['exitCode'],
  detailCode: string,
  summary: string,
  fromVersion: string,
  recoveredInterruptedUpgrade: boolean,
  toVersion?: string,
): UpgradeCommandResult {
  return { schemaVersion: 1, status, exitCode, detailCode, summary, fromVersion, recoveredInterruptedUpgrade, ...(toVersion ? { toVersion } : {}) };
}

/** Signed-manifest, checksum-first, rollback-capable binary upgrade. */
export async function runUpgrade(dependencies: UpgradeDependencies): Promise<UpgradeCommandResult> {
  const fromVersion = dependencies.buildInfo.version;
  // The distribution fence, ahead of EVERY other consideration and with no injectable escape hatch.
  //
  // Downloading a signed compiled artifact and writing it over `~/.cosyncing/bin/cosyncing` is meaningful
  // for exactly one distribution: the native one. Doing it from a JavaScript install would replace a
  // Bun-executed bundle with machine code the acquisition package never delivered, leaving the package
  // manager's record of what is installed permanently false. `runBinary` deliberately cannot override this
  // — it exists so a source checkout can exercise the native lane in tests, not so this fence can be
  // bypassed.
  //
  // It comes first because for this distribution it is the TERMINAL answer, not one precondition among
  // several. "Run setup before upgrading" is true but useless here: no amount of setup will ever make this
  // command replace the package, so the operator would satisfy that instruction only to be told the same
  // thing afterwards.
  const packageManagerOwned = packageManagerUpdateGuidance(dependencies.buildInfo);
  if (packageManagerOwned) {
    return result('blocked', 1, packageManagerOwned.detailCode, packageManagerOwned.summary, fromVersion, false);
  }
  const install = inspectInstallState(dependencies.home);
  if (!install.committed) {
    return result('blocked', 1, 'upgrade-installation-uncommitted', 'Run cosyncing setup before upgrading.', fromVersion, false);
  }
  if (dependencies.buildInfo.distribution !== 'native' && !dependencies.runBinary) {
    return result('blocked', 1, 'upgrade-source-build-unsupported', 'Upgrade applies only to an installed packaged binary.', fromVersion, false);
  }
  let installState = install.state;
  let targetPath: string;
  try { targetPath = safeInstalledBinaryPath(dependencies.home, installState, false); }
  catch (error) {
    return result('blocked', 1, error instanceof Error ? error.message : 'installed-binary-invalid', 'The installed binary receipt is missing or unsafe.', fromVersion, false);
  }

  const acquire = dependencies.acquireLock ?? ((options) => acquireInstallationLock(options));
  let lock: InstallationLockHandle;
  try { lock = acquire({ command: 'upgrade', home: dependencies.home }); }
  catch {
    return result('blocked', 1, 'installation-lock-unavailable', 'Another installation mutation is active or the lock is unsafe.', fromVersion, false);
  }
  let recovered = false;
  try {
    try {
      recovered = await recoverUpgrade({ home: dependencies.home, targetPath, service: dependencies.service });
    } catch {
      return result('cleanup-required', 4, 'upgrade-recovery-failed', 'An interrupted upgrade needs manual recovery; the journal was preserved.', fromVersion, false);
    }
    const currentInstall = inspectInstallState(dependencies.home);
    if (!currentInstall.committed) {
      return result('cleanup-required', 4, 'upgrade-installation-receipt-lost', 'The installed binary receipt changed during recovery; repair is required.', fromVersion, recovered);
    }
    installState = currentInstall.state;
    try { targetPath = safeInstalledBinaryPath(dependencies.home, installState); }
    catch (error) {
      return result('blocked', 1, error instanceof Error ? error.message : 'installed-binary-invalid', 'The installed binary differs from its ownership receipt; run cosyncing repair.', fromVersion, recovered);
    }
    if (recovered) {
      return result('rolled-back', 3, 'upgrade-interrupted-recovered', 'Recovered an interrupted upgrade and restored the previous release; rerun upgrade to try again.', fromVersion, true);
    }

    const schemaProblems = inspectDurableSchemas(durableStateLayout({ stateRoot: dependencies.home, cacheRoot: dependencies.cacheRoot }))
      .filter((store) => store.status !== 'ok'
        && store.status !== 'missing'
        // Config v1 remains an intentionally supported runtime input. An upgrade must not require
        // persisting v2 before switching binaries, because the previous service needs v1 intact if
        // candidate health fails and rollback restores it.
        && !isRuntimeCompatibleConfigV1(store));
    if (schemaProblems.length > 0) {
      return result('blocked', 1, 'upgrade-schema-repair-required', 'Repair or migrate durable state before changing binary versions.', fromVersion, recovered);
    }

    const manifestUrl = dependencies.manifestUrl ?? defaultManifestUrl();
    const trustedKeys = dependencies.trustedKeys ?? releaseKeys();
    if (!manifestUrl || Object.keys(trustedKeys).length === 0) {
      return result('blocked', 1, 'release-channel-unconfigured', 'This build has no trusted release channel metadata.', fromVersion, recovered);
    }
    let verified: VerifiedRelease;
    let artifactBytes: Uint8Array;
    try {
      const manifestBytes = await boundedDownload(dependencies.fetch ?? fetch, manifestUrl, MAX_RELEASE_MANIFEST_BYTES);
      let manifestValue: unknown;
      try { manifestValue = JSON.parse(Buffer.from(manifestBytes).toString('utf8')); }
      catch { throw new Error('release-manifest-malformed'); }
      verified = verifyReleaseManifest({ value: manifestValue, target: currentTarget(dependencies.buildInfo), trustedKeys });
      if (compareVersions(verified.manifest.version, fromVersion) === 0) {
        return result('already-current', 0, 'release-already-current', `cosyncing ${fromVersion} is already current.`, fromVersion, recovered, fromVersion);
      }
      if (compareVersions(verified.manifest.version, fromVersion) < 0) throw new Error('release-downgrade-refused');
      artifactBytes = await boundedDownload(dependencies.fetch ?? fetch, verified.artifact.url, MAX_RELEASE_ARTIFACT_BYTES);
      if (artifactBytes.byteLength !== verified.artifact.size) throw new Error('release-artifact-size-mismatch');
      if (sha256(artifactBytes) !== verified.artifact.sha256) throw new Error('release-artifact-checksum-mismatch');
    } catch (error) {
      const code = error instanceof Error ? error.message : 'release-verification-failed';
      return result('failed', 1, code, 'The release was unavailable or failed verification; the installed binary was not changed.', fromVersion, recovered);
    }

    const toVersion = verified.manifest.version;
    const binDirectory = dirname(targetPath);
    const stagingPath = join(binDirectory, `${PRODUCT_IDENTITY.primaryBinary}.staging-${toVersion}`);
    const previousPath = join(binDirectory, `${PRODUCT_IDENTITY.primaryBinary}.previous`);
    try {
      unlinkRegular(stagingPath);
      atomicWriteOwnerOnly(stagingPath, artifactBytes, { mode: 0o700 });
      const selfCheck = await (dependencies.runBinary ?? defaultRunBinary)(stagingPath, ['version', '--json']);
      let selfCheckBuild: Record<string, unknown> | undefined;
      try { selfCheckBuild = JSON.parse(selfCheck.stdout) as Record<string, unknown>; } catch { /* handled below */ }
      // `packaged` is true for the npm JavaScript distribution as well, so it can no longer be the whole
      // test. This lane replaces a native executable in place; a candidate that is a JavaScript bundle
      // would be written over the running binary and could not start, so the kind is checked exactly.
      if (selfCheck.status !== 'ok' || selfCheckBuild?.version !== toVersion
          || selfCheckBuild?.target !== verified.artifact.target || selfCheckBuild?.packaged !== true
          || selfCheckBuild?.distribution !== 'native') {
        throw new Error('release-offline-self-check-failed');
      }
    } catch (error) {
      try { unlinkRegular(stagingPath); } catch { /* report original pre-switch failure */ }
      return result('failed', 1, error instanceof Error ? error.message : 'release-offline-self-check-failed', 'The candidate failed its offline self-check; the installed binary was not changed.', fromVersion, recovered, toVersion);
    }

    const previousBytes = readFileSync(targetPath);
    const previousSha256 = sha256(previousBytes);
    const now = () => (dependencies.now?.() ?? new Date()).toISOString();
    let serviceWasActive = false;
    try {
      serviceWasActive = dependencies.service ? (await dependencies.service.inspect()).active : false;
      writeJournal(dependencies.home, {
        schemaVersion: UPGRADE_JOURNAL_SCHEMA_VERSION,
        product: PRODUCT_IDENTITY.productName,
        phase: 'prepared',
        fromVersion,
        toVersion,
        targetPath,
        previousPath,
        stagingPath,
        expectedSha256: verified.artifact.sha256,
        previousSha256,
        serviceWasActive,
        updatedAt: now(),
      });
      if (dependencies.faultAfter === 'journal-prepared') throw new Error('upgrade-fixture-interrupted');
      if (serviceWasActive && dependencies.service) await dependencies.service.stop();
      if (dependencies.faultAfter === 'service-stopped') throw new Error('upgrade-fixture-interrupted');
      atomicWriteOwnerOnly(previousPath, previousBytes, { mode: 0o700 });
      writeJournal(dependencies.home, {
        schemaVersion: UPGRADE_JOURNAL_SCHEMA_VERSION,
        product: PRODUCT_IDENTITY.productName,
        phase: 'switching',
        fromVersion,
        toVersion,
        targetPath,
        previousPath,
        stagingPath,
        expectedSha256: verified.artifact.sha256,
        previousSha256,
        serviceWasActive,
        updatedAt: now(),
      });
      atomicWriteOwnerOnly(targetPath, readFileSync(stagingPath), { mode: 0o700 });
      writeJournal(dependencies.home, {
        schemaVersion: UPGRADE_JOURNAL_SCHEMA_VERSION,
        product: PRODUCT_IDENTITY.productName,
        phase: 'switched',
        fromVersion,
        toVersion,
        targetPath,
        previousPath,
        stagingPath,
        expectedSha256: verified.artifact.sha256,
        previousSha256,
        serviceWasActive,
        updatedAt: now(),
      });
      if (dependencies.faultAfter === 'binary-switched') throw new Error('upgrade-fixture-interrupted');
      if (serviceWasActive && dependencies.service) await dependencies.service.start();
      const config = inspectBrokerConfig(dependencies.home);
      if (serviceWasActive) {
        if (config.status !== 'ok') throw new Error('upgrade-health-config-invalid');
        let healthy = false;
        for (let attempt = 0; attempt < Math.max(1, dependencies.healthAttempts ?? 30); attempt += 1) {
          healthy = dependencies.verifyBrokerVersion
            ? await dependencies.verifyBrokerVersion(config.config, toVersion)
            : await defaultVerifyBrokerVersion(dependencies.home, config.config, toVersion);
          if (healthy) break;
          await (dependencies.sleep ?? Bun.sleep)(100);
        }
        if (!healthy) throw new Error('upgrade-health-check-failed');
      }
      writeInstallState(updateBinaryReceipt(
        installState,
        targetPath,
        previousPath,
        toVersion,
        verified.artifact.sha256,
        previousSha256,
      ), dependencies.home);
      if (dependencies.faultAfter === 'receipt-committed') throw new Error('upgrade-fixture-interrupted');
      unlinkRegular(stagingPath);
      unlinkRegular(upgradeJournalPath(dependencies.home));
      return result('complete', 0, 'upgrade-complete', `Upgraded cosyncing from ${fromVersion} to ${toVersion}.`, fromVersion, recovered, toVersion);
    } catch (error) {
      if (error instanceof Error && error.message === 'upgrade-fixture-interrupted') {
        return result('cleanup-required', 4, 'upgrade-interrupted', 'Upgrade was interrupted; the durable journal will restore the previous release on the next run.', fromVersion, recovered, toVersion);
      }
      let rollbackComplete = false;
      try {
        if (sha256(previousBytes) !== previousSha256) throw new Error('rollback-binary-mismatch');
        atomicWriteOwnerOnly(targetPath, previousBytes, { mode: 0o700 });
        writeInstallState(installState, dependencies.home);
        if (serviceWasActive && dependencies.service) await dependencies.service.start();
        unlinkRegular(stagingPath);
        unlinkRegular(upgradeJournalPath(dependencies.home));
        rollbackComplete = true;
      } catch {
        rollbackComplete = false;
      }
      return rollbackComplete
        ? result('rolled-back', 3, 'upgrade-rolled-back', 'The candidate failed after switching; the previous binary was restored.', fromVersion, recovered, toVersion)
        : result('cleanup-required', 4, 'upgrade-rollback-incomplete', 'Upgrade rollback is incomplete; preserve the journal and previous binary for manual recovery.', fromVersion, recovered, toVersion);
    }
  } finally {
    lock.release();
  }
}

export function releaseManifestForTests(options: {
  version: string;
  sourceCommit: string;
  publishedAt: string;
  artifact: ReleaseArtifact;
  keyId: string;
  sign: (payload: Uint8Array) => Uint8Array;
}): ReleaseManifest {
  const unsigned: Omit<ReleaseManifest, 'signature'> = {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    product: PRODUCT_IDENTITY.productName,
    version: options.version,
    channel: 'stable',
    sourceCommit: options.sourceCommit,
    publishedAt: options.publishedAt,
    artifacts: [options.artifact],
  };
  return {
    ...unsigned,
    signature: {
      algorithm: 'ed25519',
      keyId: options.keyId,
      value: Buffer.from(options.sign(releaseManifestSigningPayload(unsigned))).toString('base64'),
    },
  };
}
