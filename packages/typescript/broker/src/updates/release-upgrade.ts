import { createHash, verify as verifySignature } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { BuildInfo } from '../runtime/build-info.ts';
import { bunVersionAtLeast, type DistributionKind } from '../runtime/application-identity.ts';
import { resolveFlutterWebRoot } from '../runtime/runtime-assets.ts';
import type { BrokerConfig } from '../runtime/configuration.ts';
import { inspectBrokerConfig } from '../runtime/configuration.ts';
import { brokerTokenPath, inspectBrokerToken, readBrokerToken } from '../security/credentials.ts';
import { authorizationMigrationRollbackFenceActive } from '../runtime/broker-instance.ts';
import {
  durableStateLayout,
  inspectDurableSchemas,
  isRuntimeCompatibleConfigV1,
  isRuntimeSecurityMigrationV1,
} from '../security/durable-state.ts';
import {
  inspectInstallState,
  writeInstallState,
  type CommittedInstallState,
  type InstalledResourceRecord,
} from '../installation/install-state.ts';
import { acquireInstallationLock, type InstallationLockHandle } from '../installation/installation-lock.ts';
import type {
  DurableServiceVersionActivation,
  DurableServiceVersionBuild,
  DurableServiceVersionRecord,
  DurableServiceVersions,
} from '../installation/service-manager.ts';
import { PRODUCT_IDENTITY } from '@cosyncing/protocol';
import {
  assertNoSymlinkComponents,
  atomicWriteJsonOwnerOnly,
  atomicWriteOwnerOnly,
  enforceOwnerOnlyTree,
  ensureOwnerOnlyDirectory,
  inspectOwnerOnlyDirectory,
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

/** The single JavaScript application artifact a signed release publishes, for every host at once. */
export const RELEASE_JAVASCRIPT_APP_NAME = 'cosyncing-app.js' as const;
/** Its declared target. One bundle runs under any supported Bun, so it names no machine-code binding. */
export const RELEASE_JAVASCRIPT_APP_TARGET = 'universal' as const;

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

/**
 * The signed JavaScript application artifact: ONE universal bundle, executed by a separately installed Bun.
 *
 * It sits beside the compiled artifacts rather than among them, for the same reason `webApp` does: the
 * `artifacts` array is a per-host machine-code set, keyed by target and selected by matching this build's
 * own target. A JavaScript bundle has no machine-code target to match, so putting it in that array would
 * mean inventing a fake one — which is exactly the false claim `universal` exists to avoid.
 */
export interface ReleaseJavaScriptApp {
  name: typeof RELEASE_JAVASCRIPT_APP_NAME;
  target: typeof RELEASE_JAVASCRIPT_APP_TARGET;
  size: number;
  sha256: string;
  url: string;
  provenanceUrl: string;
  /**
   * The oldest Bun that may execute this bundle.
   *
   * A compiled artifact carries its own interpreter, so replacing one can never raise the runtime
   * requirement out from under a host. A JavaScript artifact can: a release built against a newer Bun would
   * land on a machine whose Bun cannot run it, and the swap would report success while taking the service
   * down. Carried inside the SIGNED manifest so the floor cannot be lowered by whoever serves the download.
   */
  minimumBunVersion: string;
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
  /** Signed JavaScript application. Omitted only by manifests published before the JS channel existed. */
  jsApp?: ReleaseJavaScriptApp;
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
  /**
   * Moving the service from the installed version to the candidate, where the two are not the same thing.
   *
   * Attached to the controller rather than passed separately because the invariant is exactly that: the
   * component that starts the service is the component that decides which version starts. Absent on a host
   * whose unit execs the installed binary directly.
   */
  versions?: DurableServiceVersions;
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
  /**
   * `activating` is written BEFORE the service pointer can move, exactly as `switching` is written before
   * the binary is replaced. It is therefore the only phase in which `active-install.json` may name the
   * candidate, and the only one whose recovery writes that file at all.
   */
  phase: 'prepared' | 'switching' | 'switched' | 'activating';
  fromVersion: string;
  toVersion: string;
  targetPath: string;
  previousPath: string;
  stagingPath: string;
  expectedSha256: string;
  previousSha256: string;
  serviceWasActive: boolean;
  /** False means this upgrade may be the one that crossed the revision-16 rollback fence. */
  authorizationFenceWasActive?: boolean;
  /** Absent on a host that keeps no versioned service root, and on every journal written before it did. */
  serviceVersion?: DurableServiceVersionRecord;
  updatedAt: string;
}

export interface UpgradeDependencies {
  home: string;
  cacheRoot?: string;
  buildInfo: Readonly<BuildInfo>;
  executablePath: string;
  /**
   * The external runtime that must execute a JavaScript application, and the version it proved it is.
   *
   * Required to swap a JavaScript build and unused by a compiled one, which embeds its interpreter. Both
   * come from the single application-identity resolver: the candidate is exercised through the SAME Bun the
   * service runs under, and the manifest's interpreter floor is compared against a version that runtime
   * actually reported rather than one PATH might answer with.
   */
  runtimePath?: string;
  runtimeVersion?: string;
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
  faultAfter?: 'journal-prepared' | 'service-stopped' | 'binary-switched' | 'version-activated'
    | 'receipt-committed';
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

function validReleaseJavaScriptApp(value: unknown): value is ReleaseJavaScriptApp {
  if (!plainObject(value)) return false;
  return value.name === RELEASE_JAVASCRIPT_APP_NAME
    && value.target === RELEASE_JAVASCRIPT_APP_TARGET
    && Number.isSafeInteger(value.size) && (value.size as number) > 0
    && (value.size as number) <= MAX_RELEASE_ARTIFACT_BYTES
    && validSha(value.sha256)
    && safeHttpsUrl(value.url)
    && safeHttpsUrl(value.provenanceUrl)
    && typeof value.minimumBunVersion === 'string'
    && /^\d+\.\d+\.\d+$/.test(value.minimumBunVersion);
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
      || (value.jsApp !== undefined && !validReleaseJavaScriptApp(value.jsApp))
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

/**
 * RG1 promotion gate. Runtime verification still accepts legacy native-only manifests.
 *
 * The JavaScript application joins the pair rather than sitting outside it: a release that publishes an
 * installer pointed at a JS bundle, but no JS bundle, would pass every other check and fail at the moment an
 * operator ran the one-liner.
 */
export function verifyReleasePairing(manifest: ReleaseManifest): {
  contract: ReleaseContractIdentity;
  webApp: ReleaseWebSidecar;
  jsApp: ReleaseJavaScriptApp;
} {
  if (!manifest.contract || !manifest.webApp || !manifest.jsApp) {
    throw new Error('release-broker-web-pairing-missing');
  }
  return { contract: manifest.contract, webApp: manifest.webApp, jsApp: manifest.jsApp };
}

/** Structure and signature only; which artifact class a build may take from it is the caller's decision. */
function verifySignedManifest(
  value: unknown,
  trustedKeys: Readonly<Record<string, string>>,
): ReleaseManifest {
  const manifest = parseManifest(value);
  const trustedKey = trustedKeys[manifest.signature.keyId];
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
  return manifest;
}

export function verifyReleaseManifest(options: {
  value: unknown;
  target: string;
  trustedKeys: Readonly<Record<string, string>>;
}): VerifiedRelease {
  const manifest = verifySignedManifest(options.value, options.trustedKeys);
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

/** The single compiled artifact this build may install. Every other target in the manifest is ignored. */
function currentTarget(buildInfo: Readonly<Pick<BuildInfo, 'target'>>): string {
  if ((RELEASE_ARTIFACT_TARGETS as readonly string[]).includes(buildInfo.target)) return buildInfo.target;
  throw new Error('upgrade-host-unsupported');
}

/** Everything an upgrade needs to know about the ONE artifact this build may install. */
export interface UpgradeCandidate {
  manifest: ReleaseManifest;
  name: string;
  target: string;
  size: number;
  sha256: string;
  url: string;
  /** What the downloaded artifact must report as its own kind before it is allowed to replace anything. */
  expectedDistribution: DistributionKind;
  /** Present only for a JavaScript candidate, whose interpreter is external and can be too old. */
  minimumBunVersion?: string;
}

/**
 * Pick the artifact class this distribution installs, out of one signed manifest.
 *
 * A manifest publishes two application classes: the per-host compiled set, and one universal JavaScript
 * bundle. Which one a build may take is decided by HOW that build was installed, never by what the manifest
 * happens to offer — so a JavaScript install can no more reach the compiled set than a compiled one can
 * reach the bundle, whatever a served manifest contains.
 */
export function verifyUpgradeCandidate(options: {
  value: unknown;
  buildInfo: Readonly<Pick<BuildInfo, 'distribution' | 'target'>>;
  trustedKeys: Readonly<Record<string, string>>;
}): UpgradeCandidate {
  if (options.buildInfo.distribution === 'bootstrap-js') {
    const manifest = verifySignedManifest(options.value, options.trustedKeys);
    const jsApp = manifest.jsApp;
    if (!jsApp) throw new Error('release-javascript-artifact-unavailable');
    return {
      manifest,
      name: jsApp.name,
      target: jsApp.target,
      size: jsApp.size,
      sha256: jsApp.sha256,
      url: jsApp.url,
      expectedDistribution: 'bootstrap-js',
      minimumBunVersion: jsApp.minimumBunVersion,
    };
  }
  const verified = verifyReleaseManifest({
    value: options.value,
    target: currentTarget(options.buildInfo),
    trustedKeys: options.trustedKeys,
  });
  return {
    manifest: verified.manifest,
    name: verified.artifact.name,
    target: verified.artifact.target,
    size: verified.artifact.size,
    sha256: verified.artifact.sha256,
    url: verified.artifact.url,
    expectedDistribution: 'native',
  };
}

/** Remove a path only when it is provably a plain directory owned by this user at exactly that path. */
function removeOwnedDirectory(path: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(path); } catch { return; }
  assertNoSymlinkComponents(path, false);
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (stat.isSymbolicLink() || !stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) {
    throw new Error('release-web-sidecar-target-unsafe');
  }
  rmSync(path, { recursive: true, force: true });
}

/**
 * Install the signed web client that belongs to the incoming version.
 *
 * The web client is versioned WITH the application — a packaged broker resolves its web root from its own
 * version — so an upgrade that replaced only the application would leave the new version looking for a
 * directory nothing ever created, and the operator with a broker that reports a successful upgrade and then
 * serves no web client at all. The sidecar is verified against the same signed manifest as the application
 * and unpacked before the upgrade journal opens, so a failure here still means nothing has changed.
 *
 * The destination comes from the same resolver setup, lifecycle, and the CLI use. A private copy of that
 * rule here is exactly the drift that would put the client in a directory the service never reads.
 */
async function installReleaseWebSidecar(options: {
  applicationPath: string;
  version: string;
  webApp: ReleaseWebSidecar;
  fetcher: typeof fetch;
}): Promise<void> {
  const bytes = await boundedDownload(options.fetcher, options.webApp.url, MAX_RELEASE_ARTIFACT_BYTES);
  if (bytes.byteLength !== options.webApp.size) throw new Error('release-web-sidecar-size-mismatch');
  if (sha256(bytes) !== options.webApp.sha256) throw new Error('release-web-sidecar-checksum-mismatch');
  const binDirectory = dirname(resolve(options.applicationPath));
  const staging = join(
    binDirectory,
    `.${PRODUCT_IDENTITY.releaseAssetPrefix}-web.staging-${options.version}`,
  );
  removeOwnedDirectory(staging);
  // `mkdirSync(..., { mode })` is a no-op on Windows, so the staging directory used to be created with
  // whatever its parent handed down and the whole unpacked tree inherited that. Every other directory this
  // product creates goes through the owner-only primitive; this one now does too.
  ensureOwnerOnlyDirectory(staging);
  try {
    const archive = join(staging, 'sidecar.tar.gz');
    atomicWriteOwnerOnly(archive, bytes, { mode: 0o600 });
    // The archive holds one `app/` tree. `tar` is spawned rather than reimplemented: it is present on every
    // host this distribution installs on, and it is the same tool the bootstrap installer already uses.
    const unpack = Bun.spawnSync(['tar', '-xzf', archive, '-C', staging], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    if (!unpack.success) throw new Error('release-web-sidecar-unpack-failed');
    const unpacked = join(staging, 'app');
    if (!existsSync(join(unpacked, 'index.html'))) throw new Error('release-web-sidecar-invalid');
    // `tar` writes the tree with the archive's own modes, and on Windows with the ACEs the staging
    // directory handed down -- inherited access, which is exactly what the owner-only inspection refuses.
    // Tighten every node BEFORE the tree is published, so the directory the broker serves from is
    // owner-only at the instant it appears rather than a moment afterwards.
    enforceOwnerOnlyTree(unpacked);
    const target = resolveFlutterWebRoot({
      packaged: true,
      executablePath: options.applicationPath,
      version: options.version,
    });
    removeOwnedDirectory(target);
    renameSync(unpacked, target);
    // Proven, not assumed: a rename within one volume is supposed to carry the descriptor with the object,
    // and that property is what the tightening above rests on.
    if (inspectOwnerOnlyDirectory(target).status !== 'ok') {
      throw new Error('release-web-sidecar-target-unsafe');
    }
  } finally {
    try { removeOwnedDirectory(staging); } catch { /* never mask the failure that brought us here */ }
  }
}

/**
 * Drop web roots that no version still in play needs.
 *
 * Two are kept and both are load-bearing: the version now installed, and the one the RUNNING service is
 * still configured to serve. `setup` has not re-run yet, so the service environment still names the old
 * directory — deleting it would blank the web client of a broker serving it at that moment. Anything older
 * belongs to a previous upgrade and nothing references it.
 */
/**
 * The web root belonging to a version this run installed and then abandoned.
 *
 * Resolved through the SAME rule that installed it, never by re-deriving the directory name here: two
 * spellings of one path is how a cleanup comes to miss the thing it was written to remove.
 *
 * Removing it is unconditionally safe on any path that ends at the previous version. A candidate version
 * is strictly greater than the installed one, so this directory can never be the root the running service
 * is serving, and nothing else names it: the receipt in force after a rollback is the one from before the
 * upgrade, which knows nothing about it.
 */
function abandonedCandidateWebRoot(applicationPath: string, version: string): string {
  return resolveFlutterWebRoot({ packaged: true, executablePath: applicationPath, version });
}

/** The install state with the rollback copy's receipt dropped, for a path that removes the file with it. */
function withoutPreviousBinaryReceipt(state: CommittedInstallState): CommittedInstallState {
  return {
    ...state,
    resources: state.resources.filter((resource) => resource.id !== 'broker-binary-previous'),
  };
}

function pruneReleaseWebRoots(applicationPath: string, keep: readonly string[]): void {
  const binDirectory = dirname(resolve(applicationPath));
  const kept = new Set(keep.map((version) => `${PRODUCT_IDENTITY.releaseAssetPrefix}-web-${version}`));
  const pattern = new RegExp(
    `^${PRODUCT_IDENTITY.releaseAssetPrefix}-web-\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$`,
  );
  let entries: string[];
  try { entries = readdirSync(binDirectory); } catch { return; }
  for (const entry of entries) {
    if (kept.has(entry) || !pattern.test(entry)) continue;
    // A superseded web root is inert, so failing to remove one must never fail a completed upgrade.
    try { removeOwnedDirectory(join(binDirectory, entry)); } catch { /* leave it for repair */ }
  }
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
 * The npm package is installed, moved, and removed by a package manager. cosyncing replacing that package
 * from inside itself would fight the tool that owns those files, leaving the manager's record of what is
 * installed permanently false. So the honest answer is instructions, and every surface that could otherwise
 * imply "an update was applied" returns this same text: the CLI's `upgrade`, the app-triggered handoff, and
 * the release-channel probe.
 *
 * This is keyed on `bun-js` EXACTLY, never on "is a JavaScript build". `bootstrap-js` is the same bytes,
 * placed by cosyncing's own signed installer into a directory nothing else claims, and there the honest
 * answer is the opposite one: cosyncing may replace what cosyncing installed. Two acquisition methods, two
 * answers, and the distribution kind is the only thing that separates them.
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
  // Before any network call: an npm-owned install cannot apply anything the manifest offers, because the
  // package manager owns those files. Reporting "update available" there is what would make the app's
  // update surface offer a swap that can never happen. An installer-owned JavaScript build is not in that
  // position — cosyncing placed its own files — so it probes the channel exactly as the compiled one does.
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
    const verified = verifyUpgradeCandidate({
      value: manifestValue,
      buildInfo: dependencies.buildInfo,
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

/**
 * The installation and version identifiers a service-version undo is driven from.
 *
 * Validated to the same shape the Windows service layer accepts, here rather than there: a journal is
 * read back by a LATER process from a file on disk, so what it carries is input, not a value this run
 * placed. A malformed record must fail the journal rather than reach a path that removes directories.
 */
function validServiceVersionRecord(value: unknown): boolean {
  if (!plainObject(value)) return false;
  const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  const identifiers = ['installationId', 'fromVersionKey', 'toVersionKey'] as const;
  return identifiers.every((key) => typeof value[key] === 'string' && safeId.test(value[key] as string))
    && Object.keys(value).every((key) => (identifiers as readonly string[]).includes(key));
}

/**
 * The candidate's own build terms, taken from the self-check it has just passed.
 *
 * The version alone cannot identify a build, so a versioned service root is keyed on all of them. Reading
 * them from the candidate is the only honest source: a key string-formatted from the version would name a
 * directory the candidate itself would never resolve.
 */
function candidateBuildTerms(
  value: Record<string, unknown> | undefined,
): DurableServiceVersionBuild | undefined {
  const term = (candidate: unknown): candidate is string =>
    typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 128
      && !/[\0\r\n]/.test(candidate);
  if (!value || !term(value.version) || !term(value.commit) || !term(value.target)
      || !term(value.distribution)
      || (value.buildDate !== null && !term(value.buildDate))
      || (value.dirty !== null && typeof value.dirty !== 'boolean')) return undefined;
  return {
    version: value.version,
    commit: value.commit,
    buildDate: value.buildDate as string | null,
    target: value.target,
    dirty: value.dirty as boolean | null,
    distribution: value.distribution as DistributionKind,
  };
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
      || !['prepared', 'switching', 'switched', 'activating'].includes(String(value.phase))
      || !validVersion(value.fromVersion) || !validVersion(value.toVersion)
      || typeof value.targetPath !== 'string' || resolve(value.targetPath) !== resolve(targetPath)
      || typeof value.previousPath !== 'string'
      || resolve(value.previousPath) !== resolve(join(home, 'bin', `${PRODUCT_IDENTITY.primaryBinary}.previous`))
      || typeof value.stagingPath !== 'string'
      || resolve(value.stagingPath) !== resolve(join(home, 'bin', `${PRODUCT_IDENTITY.primaryBinary}.staging-${String(value.toVersion)}`))
      || !validSha(value.expectedSha256) || !validSha(value.previousSha256)
      || typeof value.serviceWasActive !== 'boolean'
      || (value.authorizationFenceWasActive !== undefined
        && typeof value.authorizationFenceWasActive !== 'boolean')
      || (value.serviceVersion !== undefined && !validServiceVersionRecord(value.serviceVersion))
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
  // A journal written before this field existed is necessarily from the revision-16 updater. If
  // broker-instance v2 now exists, the candidate crossed the one-way security fence: restoring or
  // starting the recorded revision-16 binary would reactivate whatever v1 store failed to migrate.
  if (authorizationMigrationRollbackFenceActive(options.home)
      && journal.authorizationFenceWasActive !== true) {
    throw new Error('upgrade-authorization-fence-crossed');
  }
  // Before the restore, and only past `prepared`: at that phase the transaction had not stopped the
  // service yet and the old build is what is running, so touching it would be a mutation with no cause.
  // At `switching`/`switched` the transaction already stopped it and this is idempotent; at `activating`
  // it is required, because the crashed run may have started the candidate and `versions.restore` below
  // deletes the version root it is executing from. Tolerated failure, as in the rollback path: a service
  // that will not stop must not by itself abandon a recovery that can still put the machine back.
  if (journal.phase !== 'prepared' && journal.serviceWasActive && options.service) {
    try { await options.service.stop(); } catch { /* the restore below is still the best outcome */ }
  }
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
  // The rollback copy is removed below, so its receipt goes with it. Only when THIS journal wrote the
  // copy: at `prepared` the file on disk is still whatever an earlier successful upgrade left, and that
  // one is measured by a receipt that is still true.
  if (journal.phase !== 'prepared') resources.delete('broker-binary-previous');
  // `activating` is the only phase in which the service pointer can name the candidate, so it is the only
  // one whose recovery writes that file. The receipts move with it: a crash after the candidate's were
  // committed would otherwise leave the state naming a version root this is about to delete.
  if (journal.phase === 'activating' && journal.serviceVersion && options.service?.versions) {
    await options.service.versions.restore(journal.serviceVersion);
    for (const record of options.service.versions.resources(journal.serviceVersion.fromVersionKey)) {
      resources.set(record.id, record);
    }
  }
  const installer = plainObject(install.state.installer) ? install.state.installer : {};
  writeInstallState({
    ...install.state,
    resources: [...resources.values()].sort((left, right) => left.id.localeCompare(right.id)),
    installer: { ...installer, version: journal.fromVersion },
  }, options.home);
  if (journal.serviceWasActive && options.service) await options.service.start();
  unlinkRegular(journal.stagingPath);
  // The journal goes before the rollback copy it names. Removing the copy first would leave a journal
  // whose recovery source is missing, and the NEXT run reads that as a failed recovery needing manual
  // cleanup -- on a machine whose binary has already been correctly restored.
  unlinkRegular(upgradeJournalPath(options.home));
  if (journal.phase !== 'prepared') unlinkRegular(journal.previousPath);
  try {
    removeOwnedDirectory(abandonedCandidateWebRoot(journal.targetPath, journal.toVersion));
  } catch { /* an unreferenced web root is inert; never fail a completed recovery for one */ }
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
  additional: readonly InstalledResourceRecord[] = [],
): CommittedInstallState {
  const resources = new Map(state.resources.map((resource) => [resource.id, resource]));
  for (const record of additional) resources.set(record.id, record);
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
  // Downloading a signed artifact and writing it over `~/.cosyncing/bin/cosyncing` is meaningful for exactly
  // two distributions: the compiled `native` one, and `bootstrap-js`, whose files cosyncing's own signed
  // installer placed there and which nothing else claims.
  //
  // This comment used to say "exactly one", and that was terminal for a specific reason rather than a
  // cautious one: the only signed channel published compiled native binaries, so a swap from a JavaScript
  // install would have replaced a Bun-executed bundle with machine code the acquisition package never
  // delivered. The manifest now carries a signed JavaScript application as its own artifact class, which
  // removes that premise exactly — a `bootstrap-js` build downloads a JavaScript bundle and writes it over a
  // JavaScript bundle. The fence was widened deliberately, and only that far: `verifyUpgradeCandidate` still
  // refuses to let a JavaScript build near the compiled set, and the candidate's self-check still asserts
  // the kind exactly.
  //
  // What did NOT change is the npm case, and it is not a subset of this one. `bun-js` is the same bytes
  // installed by a package manager that owns, moves and removes them, so it still gets instructions.
  // `runBinary` still cannot override any of this — it exists so a source checkout can exercise the lane in
  // tests, not so the fence can be bypassed.
  //
  // It comes first because for the npm distribution it remains the TERMINAL answer, not one precondition
  // among several. "Run setup before upgrading" is true but useless there: no amount of setup will ever
  // make this command replace the package, so the operator would satisfy that instruction only to be told
  // the same thing afterwards.
  const packageManagerOwned = packageManagerUpdateGuidance(dependencies.buildInfo);
  if (packageManagerOwned) {
    return result('blocked', 1, packageManagerOwned.detailCode, packageManagerOwned.summary, fromVersion, false);
  }
  const install = inspectInstallState(dependencies.home);
  if (!install.committed) {
    return result('blocked', 1, 'upgrade-installation-uncommitted', 'Run cosyncing setup before upgrading.', fromVersion, false);
  }
  const javaScriptCandidate = dependencies.buildInfo.distribution === 'bootstrap-js';
  if (dependencies.buildInfo.distribution !== 'native' && !javaScriptCandidate && !dependencies.runBinary) {
    return result('blocked', 1, 'upgrade-source-build-unsupported', 'Upgrade applies only to an installed packaged build.', fromVersion, false);
  }
  // A JavaScript candidate is run by an interpreter this build does not contain, so the swap needs the SAME
  // validated Bun the service was installed with — not whatever `bun` PATH resolves to, and not the
  // bundle's own shebang. Without a proven runtime there is nothing to exercise the candidate with and
  // nothing to compare the release's interpreter floor against, so refuse before anything is downloaded.
  if (javaScriptCandidate && (!dependencies.runtimePath || !dependencies.runtimeVersion)) {
    return result('blocked', 1, 'upgrade-runtime-unresolved', 'The Bun runtime that must execute cosyncing could not be resolved; run cosyncing doctor.', fromVersion, false);
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
    } catch (error) {
      if (error instanceof Error && error.message === 'upgrade-authorization-fence-crossed') {
        return result(
          'cleanup-required',
          4,
          'upgrade-authorization-fence-crossed',
          'An interrupted authorization migration crossed its one-way rollback fence; the previous broker was not restored.',
          fromVersion,
          false,
        );
      }
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
        && !isRuntimeCompatibleConfigV1(store)
        // Revision 17 owns these fail-closed migrations at startup. Allow the candidate to reach
        // that boundary; the old schema is never accepted as current authorization state.
        && !isRuntimeSecurityMigrationV1(store));
    if (schemaProblems.length > 0) {
      return result('blocked', 1, 'upgrade-schema-repair-required', 'Repair or migrate durable state before changing binary versions.', fromVersion, recovered);
    }

    const manifestUrl = dependencies.manifestUrl ?? defaultManifestUrl();
    const trustedKeys = dependencies.trustedKeys ?? releaseKeys();
    if (!manifestUrl || Object.keys(trustedKeys).length === 0) {
      return result('blocked', 1, 'release-channel-unconfigured', 'This build has no trusted release channel metadata.', fromVersion, recovered);
    }
    let candidate: UpgradeCandidate;
    let artifactBytes: Uint8Array;
    try {
      const manifestBytes = await boundedDownload(dependencies.fetch ?? fetch, manifestUrl, MAX_RELEASE_MANIFEST_BYTES);
      let manifestValue: unknown;
      try { manifestValue = JSON.parse(Buffer.from(manifestBytes).toString('utf8')); }
      catch { throw new Error('release-manifest-malformed'); }
      candidate = verifyUpgradeCandidate({ value: manifestValue, buildInfo: dependencies.buildInfo, trustedKeys });
      if (compareVersions(candidate.manifest.version, fromVersion) === 0) {
        return result('already-current', 0, 'release-already-current', `cosyncing ${fromVersion} is already current.`, fromVersion, recovered, fromVersion);
      }
      if (compareVersions(candidate.manifest.version, fromVersion) < 0) throw new Error('release-downgrade-refused');
      // The interpreter floor is checked BEFORE the download, and against the version the running runtime
      // reported. A JavaScript release may raise the Bun it needs; installing one whose floor this host
      // cannot meet would swap in a bundle that fails at exec, after the service has already been stopped.
      if (candidate.minimumBunVersion
          && !bunVersionAtLeast(dependencies.runtimeVersion ?? '', candidate.minimumBunVersion)) {
        throw new Error('release-runtime-too-old');
      }
      artifactBytes = await boundedDownload(dependencies.fetch ?? fetch, candidate.url, MAX_RELEASE_ARTIFACT_BYTES);
      if (artifactBytes.byteLength !== candidate.size) throw new Error('release-artifact-size-mismatch');
      if (sha256(artifactBytes) !== candidate.sha256) throw new Error('release-artifact-checksum-mismatch');
    } catch (error) {
      const code = error instanceof Error ? error.message : 'release-verification-failed';
      return result('failed', 1, code, 'The release was unavailable or failed verification; the installed binary was not changed.', fromVersion, recovered);
    }

    const toVersion = candidate.manifest.version;
    const binDirectory = dirname(targetPath);
    const stagingPath = join(binDirectory, `${PRODUCT_IDENTITY.primaryBinary}.staging-${toVersion}`);
    const previousPath = join(binDirectory, `${PRODUCT_IDENTITY.primaryBinary}.previous`);
    let candidateBuild: DurableServiceVersionBuild | undefined;
    try {
      unlinkRegular(stagingPath);
      atomicWriteOwnerOnly(stagingPath, artifactBytes, { mode: 0o700 });
      // A compiled candidate identifies itself. A JavaScript one cannot: it carries no interpreter, and
      // exec'ing it would resolve `bun` through PATH — possibly a different runtime from the one this
      // install records and the service runs under. Hand it to that exact runtime instead, so the check
      // proves the pair that will actually run rather than the bundle alone.
      const runCandidate = dependencies.runBinary ?? defaultRunBinary;
      const selfCheck = javaScriptCandidate && dependencies.runtimePath
        ? await runCandidate(dependencies.runtimePath, [stagingPath, 'version', '--json'])
        : await runCandidate(stagingPath, ['version', '--json']);
      let selfCheckBuild: Record<string, unknown> | undefined;
      try { selfCheckBuild = JSON.parse(selfCheck.stdout) as Record<string, unknown>; } catch { /* handled below */ }
      // `packaged` is true for the npm JavaScript distribution as well, so it can never be the whole test.
      // The kind is compared against the one THIS distribution is allowed to install: a compiled build
      // written over by a bundle could not start, and a bundle written over by machine code could not
      // either, so each lane refuses the other's artifact by name rather than by inference.
      if (selfCheck.status !== 'ok' || selfCheckBuild?.version !== toVersion
          || selfCheckBuild?.target !== candidate.target || selfCheckBuild?.packaged !== true
          || selfCheckBuild?.distribution !== candidate.expectedDistribution) {
        throw new Error('release-offline-self-check-failed');
      }
      candidateBuild = candidateBuildTerms(selfCheckBuild);
      // Required only where a versioned service root is keyed on these terms. Demanding them everywhere
      // would turn fields this check has never read into a new way for an upgrade to be refused.
      if (!candidateBuild && dependencies.service?.versions) {
        throw new Error('release-offline-self-check-failed');
      }
    } catch (error) {
      try { unlinkRegular(stagingPath); } catch { /* report original pre-switch failure */ }
      return result('failed', 1, error instanceof Error ? error.message : 'release-offline-self-check-failed', 'The candidate failed its offline self-check; the installed binary was not changed.', fromVersion, recovered, toVersion);
    }

    // Which version root the service would move to, read while a refusal still costs nothing: the journal
    // has not opened, the service is running, and not one byte on this machine has changed. Planning after
    // the switch would turn an unreadable pointer into a rollback rather than a refusal.
    let activation: DurableServiceVersionActivation | undefined;
    try {
      activation = candidateBuild ? dependencies.service?.versions?.plan(candidateBuild) : undefined;
    } catch (error) {
      try { unlinkRegular(stagingPath); } catch { /* report the original pre-switch failure */ }
      return result(
        'blocked',
        1,
        error instanceof Error ? error.message : 'service-version-unresolved',
        'The installed service could not say which version it runs; run cosyncing doctor.',
        fromVersion,
        recovered,
        toVersion,
      );
    }

    // The web client is versioned with the application, so a swap that moved only the application would
    // leave the new version resolving a web root nothing ever created. Install the paired sidecar while a
    // failure still costs nothing: the journal has not opened and the service has not been stopped.
    if (javaScriptCandidate) {
      try {
        await installReleaseWebSidecar({
          applicationPath: targetPath,
          version: toVersion,
          webApp: verifyReleasePairing(candidate.manifest).webApp,
          fetcher: dependencies.fetch ?? fetch,
        });
      } catch (error) {
        try { unlinkRegular(stagingPath); } catch { /* report the original pre-switch failure */ }
        return result('failed', 1, error instanceof Error ? error.message : 'release-web-sidecar-failed', 'The paired web client failed verification or could not be installed; the installed build was not changed.', fromVersion, recovered, toVersion);
      }
    }

    const previousBytes = readFileSync(targetPath);
    const previousSha256 = sha256(previousBytes);
    const now = () => (dependencies.now?.() ?? new Date()).toISOString();
    let serviceWasActive = false;
    // The rollback copy is written mid-transaction, so a failure before that point leaves whatever an
    // earlier upgrade put at `previousPath` -- a file its own receipt still measures. Only a run that
    // overwrote it may remove it.
    let previousWritten = false;
    let serviceVersion: DurableServiceVersionRecord | undefined;
    const authorizationFenceWasActive = authorizationMigrationRollbackFenceActive(dependencies.home);
    // One journal, written at each phase from the transaction's own live state. The four writes used to be
    // four copies of the same object literal, which is one copy per opportunity for a later field to be
    // carried by three of them.
    const journalAt = (phase: UpgradeJournal['phase']): void => writeJournal(dependencies.home, {
      schemaVersion: UPGRADE_JOURNAL_SCHEMA_VERSION,
      product: PRODUCT_IDENTITY.productName,
      phase,
      fromVersion,
      toVersion,
      targetPath,
      previousPath,
      stagingPath,
      expectedSha256: candidate.sha256,
      previousSha256,
      serviceWasActive,
      authorizationFenceWasActive,
      ...(serviceVersion ? { serviceVersion } : {}),
      updatedAt: now(),
    });
    try {
      serviceWasActive = dependencies.service ? (await dependencies.service.inspect()).active : false;
      journalAt('prepared');
      if (dependencies.faultAfter === 'journal-prepared') throw new Error('upgrade-fixture-interrupted');
      if (serviceWasActive && dependencies.service) await dependencies.service.stop();
      if (dependencies.faultAfter === 'service-stopped') throw new Error('upgrade-fixture-interrupted');
      atomicWriteOwnerOnly(previousPath, previousBytes, { mode: 0o700 });
      previousWritten = true;
      journalAt('switching');
      atomicWriteOwnerOnly(targetPath, readFileSync(stagingPath), { mode: 0o700 });
      journalAt('switched');
      if (dependencies.faultAfter === 'binary-switched') throw new Error('upgrade-fixture-interrupted');
      // Replacing the binary is the whole of a version change only where the service execs it. On Windows
      // the Scheduled Task execs a bootstrap that reads `active-install.json` at every start and runs the
      // version root named there, so a service restarted now would come back on the version it already
      // had -- and the health poll below would read that old version thirty times and roll a perfectly
      // good candidate back. That is what `upgrade` did on every Windows host.
      //
      // The record is journaled BEFORE the pointer can move, exactly as `switching` precedes the binary
      // write, so a crash anywhere inside the activation leaves a state recovery can put back.
      if (activation) {
        serviceVersion = activation.record;
        journalAt('activating');
        await activation.apply();
        if (dependencies.faultAfter === 'version-activated') throw new Error('upgrade-fixture-interrupted');
      }
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
        candidate.sha256,
        previousSha256,
        // The version root and its environment file move with the binary, in the same write. A root left
        // on disk without its receipt is the same defect a rollback used to leave behind, in a new place.
        serviceVersion ? dependencies.service?.versions?.resources(serviceVersion.toVersionKey) ?? [] : [],
      ), dependencies.home);
      if (dependencies.faultAfter === 'receipt-committed') throw new Error('upgrade-fixture-interrupted');
      unlinkRegular(stagingPath);
      unlinkRegular(upgradeJournalPath(dependencies.home));
      // Only once the upgrade is committed, and only web roots no version in play still needs.
      if (javaScriptCandidate) pruneReleaseWebRoots(targetPath, [toVersion, fromVersion]);
      // Strictly after the journal is gone: until that moment the superseded root is what a recovery
      // would point the service back at. A superseded root is inert, so failing to remove one must never
      // fail an upgrade that has already committed.
      if (serviceVersion && dependencies.service?.versions) {
        try {
          await dependencies.service.versions.finalize(serviceVersion);
        } catch { /* leave it for repair */ }
      }
      return result('complete', 0, 'upgrade-complete', `Upgraded cosyncing from ${fromVersion} to ${toVersion}.`, fromVersion, recovered, toVersion);
    } catch (error) {
      if (!authorizationFenceWasActive
          && authorizationMigrationRollbackFenceActive(dependencies.home)) {
        try {
          if (serviceWasActive && dependencies.service) await dependencies.service.stop();
        } catch {
          // The one-way fence still prevents the previous broker from starting. Preserve every
          // recovery artifact and report manual cleanup even when service control also failed.
        }
        return result(
          'cleanup-required',
          4,
          'upgrade-authorization-fence-crossed',
          'The authorization migration crossed its one-way rollback fence; the previous broker was not restored. Repair or retry with a revision-17-or-later candidate.',
          fromVersion,
          recovered,
          toVersion,
        );
      }
      if (error instanceof Error && error.message === 'upgrade-fixture-interrupted') {
        return result('cleanup-required', 4, 'upgrade-interrupted', 'Upgrade was interrupted; the durable journal will restore the previous release on the next run.', fromVersion, recovered, toVersion);
      }
      // Before anything is restored, because the candidate may still be alive: a health check fails when
      // the candidate is slow as well as when it is broken, `start` on a running unit is a no-op on both
      // systemd and launchd, and `versions.restore` below deletes the version root a live candidate is
      // executing from. The failure is tolerated -- a service that will not stop must not by itself turn a
      // rollback that can still put the binary and the pointer back into `cleanup-required`.
      try {
        if (serviceWasActive && dependencies.service) await dependencies.service.stop();
      } catch { /* the restore below is still the best available outcome */ }
      let rollbackComplete = false;
      try {
        if (sha256(previousBytes) !== previousSha256) throw new Error('rollback-binary-mismatch');
        atomicWriteOwnerOnly(targetPath, previousBytes, { mode: 0o700 });
        // Before the service is started, and for the same reason the activation had to precede it: a
        // rollback that restored the binary and left the pointer would start the CANDIDATE and then
        // report the previous release restored.
        if (serviceVersion && dependencies.service?.versions) {
          await dependencies.service.versions.restore(serviceVersion);
        }
        // The pre-upgrade state, minus the rollback copy this run overwrote and removes below. Restoring
        // it unchanged would republish a receipt that measures bytes the copy no longer holds: after one
        // successful upgrade `broker-binary-previous` names the build before THAT one, and this run wrote
        // a different build over the same path.
        writeInstallState(
          previousWritten ? withoutPreviousBinaryReceipt(installState) : installState,
          dependencies.home,
        );
        if (serviceWasActive && dependencies.service) await dependencies.service.start();
        unlinkRegular(stagingPath);
        // The journal goes before the rollback copy it names, for the same reason it does in recovery.
        unlinkRegular(upgradeJournalPath(dependencies.home));
        // Nothing owns either of these once the previous release is back: the restored receipt is the one
        // from before the upgrade, and it names neither. Leaving them is how `uninstall` came to report a
        // clean removal while a stale binary copy and a whole web root survived under the state home.
        if (previousWritten) unlinkRegular(previousPath);
        try {
          removeOwnedDirectory(abandonedCandidateWebRoot(targetPath, toVersion));
        } catch { /* an unreferenced web root is inert; never fail a completed rollback for one */ }
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
  /** The paired classes a real release always publishes. Omitted by tests exercising a manifest without them. */
  contract?: ReleaseContractIdentity;
  webApp?: ReleaseWebSidecar;
  jsApp?: ReleaseJavaScriptApp;
}): ReleaseManifest {
  const unsigned: Omit<ReleaseManifest, 'signature'> = {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    product: PRODUCT_IDENTITY.productName,
    version: options.version,
    channel: 'stable',
    sourceCommit: options.sourceCommit,
    publishedAt: options.publishedAt,
    artifacts: [options.artifact],
    ...(options.contract ? { contract: options.contract } : {}),
    ...(options.webApp ? { webApp: options.webApp } : {}),
    ...(options.jsApp ? { jsApp: options.jsApp } : {}),
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
