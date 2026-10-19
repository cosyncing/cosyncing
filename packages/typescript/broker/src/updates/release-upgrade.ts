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
import { validDesktopClients, type ReleaseDesktopClients, type DesktopClientOutcome } from './desktop-client-types.ts';
import {
  parseReleaseUpdaterMetadata,
  compareReleaseVersions,
  type ReleaseUpdaterBlock,
  type ReleaseUpdaterMetadata,
} from './updater-metadata.ts';
import {
  assertDesktopClientStopped, assertDesktopClientUnchanged, inspectDesktopClient,
  DesktopClientRunningError, skippedDesktopClient,
  reconcileDesktopClient, type DesktopClientContext, type PreparedDesktopClient,
} from './desktop-client.ts';
import { inspectBrokerConfig } from '../runtime/configuration.ts';
import { brokerTokenPath, inspectBrokerToken, readBrokerToken } from '../security/credentials.ts';
import { authorizationMigrationRollbackFenceActive } from '../runtime/broker-instance.ts';
import {
  durableStateLayout,
  inspectDurableSchemas,
  durableStateProblemSummary,
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
import { claudeModRefreshEnvironment } from '../installation/claude-mod-ownership.ts';
import { bunRuntimesReceipt, ownedBunRuntimesPresent } from '../installation/bun-runtime-receipt.ts';
import { planServiceRuntimeEnvironment, planServiceWebEnvironment, ServiceWebEnvironmentError, validServiceWebChanges, writeServiceWebEnvironment, type ServiceWebEnvironmentChange } from '../installation/service-web-environment.ts';
import {
  bunRuntimeHost,
  installBunRuntime,
  ownedBunRuntimePath,
  planBunRuntimeUpgrade,
  planLauncherRuntimeChanges,
  pruneOwnedBunRuntimes,
  removeAbandonedBunRuntime,
  validLauncherChanges,
  validReleaseBunRuntime,
  writeLauncherChanges,
  type BunRuntimeUpgradePlan,
  type InstalledBunRuntime,
  type LauncherRuntimeChange,
  type ReleaseBunRuntime,
} from './bun-runtime-upgrade.ts';
import type { BunRuntimeProbe } from '../runtime/application-identity.ts';
import {
  checkInstalledBroker,
  type BrokerCheckOutcome,
  type SetupCheckOutcome,
  type UpgradeProgressEvent,
} from './post-upgrade-check.ts';
import { readSetupState } from '../installation/setup-state.ts';
import { windowsServiceInstallPaths } from '../installation/windows-service-install.ts';
import type {
  DurableServiceVersionActivation,
  DurableServiceVersionBuild,
  DurableServiceVersionRecord,
  DurableServiceVersions,
} from '../installation/service-manager.ts';
import { PRODUCT_IDENTITY, type UpdateComponent } from '@cosyncing/protocol';
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
/** A pinned Bun archive is ~35 MB, so it gets far longer than the 30 s a manifest or bundle does. */
const BUN_RUNTIME_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/**
 * Ceiling on the delegated Claude mod refresh. Longer than the 15 s a version probe gets: this child
 * reads Claude's own diagnosis and runs four `claude plugin` commands, and a slow-but-fine refresh is
 * worth waiting for rather than reporting as a failure the operator has to chase.
 */
const CLAUDE_MOD_REFRESH_TIMEOUT_MS = 60_000;

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
  /**
   * The official Bun archives, per installer host, for a Bun that meets {@link minimumBunVersion}: the same
   * pinned table the release's installers carry, signed with the release.
   *
   * It has to travel WITH the release because the updater that needs it is always the older build: its own
   * compiled pins describe the runtime it was built for, not the one this release requires. Absent from
   * manifests published before `cosy update` could install a runtime; old updaters ignore it.
   */
  bunRuntime?: ReleaseBunRuntime;
}

/** Accepted Android client carried by the stable release channel.
 *
 * Brokers never select or install this artifact. It lives beside the broker
 * payload so an Android client can discover one promoted APK without listing
 * GitHub releases or taking ownership of GitHub's `latest` pointer.
 */
export interface ReleaseAndroidApp {
  name: string;
  applicationId: 'com.cosyncing.client';
  versionCode: number;
  size: number;
  sha256: string;
  url: string;
  signerSha256: string;
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
  /** Signed Android update metadata. Omitted by releases predating in-app Android updates. */
  androidApp?: ReleaseAndroidApp;
  /** Optional installer-owned desktop archives, covered by the full manifest signature. */
  desktopClients?: ReleaseDesktopClients;
  /**
   * Optional in-app update engine metadata, covered by the full manifest signature.
   *
   * Absent means the release makes no internal-update promise; it is NOT a zero
   * default. Readers that predate it ignore the key and verify the signature over
   * the canonical payload unchanged, so this is additive in both directions.
   */
  updater?: ReleaseUpdaterBlock;
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
  /**
   * `unknown` with `detailCode: release-runtime-upgrade-required` (and `latestVersion` set) is a newer
   * release this install cannot apply until its Bun is upgraded by hand -- reported as that, never as a
   * plain `update-available` that would only fail when tried.
   */
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
  /** The Bun executing this build, as it reported itself; compared against a release's signed floor. */
  runtimeVersion?: string;
  runtimePath?: string;
  /** True when that runtime was chosen with COSYNCING_BUN_BIN, which `cosy update` never replaces. */
  runtimeOverridden?: boolean;
  /** Installer host key for the pinned runtime table. Defaults to this process's platform and arch. */
  runtimeHost?: string;
}

export interface UpgradeServiceController {
  /** `enabled: false` only when the manager says disabled; absent means it is not known to be. */
  inspect(): Promise<{ active: boolean; enabled?: boolean }>;
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
  /**
   * Make the service manager re-read a definition file the transaction just rewrote: launchd's plist after
   * its environment or program arguments changed, systemd's unit after its `ExecStart=` runtime moved.
   */
  reloadDefinition?: (wasActive: boolean) => Promise<void>;
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
  /**
   * What happened to the cosyncing Claude mod, when this host has one.
   *
   * Recorded rather than folded into `status`: the broker upgrade itself committed and health-checked
   * before the mod was touched, and a mod Claude refused to install must not read as a failed upgrade.
   * Includes stated skips when the mod was declined, disabled, unavailable or unsafe.
   */
  claudeMod?: { status: 'installed' | 'refreshed' | 'current' | 'skipped' | 'failed'; detailCode: string };
  /** Independent desktop reconciliation, after the broker is committed and healthy. CLI only. */
  desktopClient?: { status: DesktopClientOutcome['status']; detailCode: string };
  /**
   * Whether the installed broker is running and answering at the end of the run, and what was done if it
   * was stopped. Reported beside `status` for the same reason as the mod: an upgrade that committed is not
   * undone by a service that will not start afterwards. Absent in foreground mode.
   */
  brokerCheck?: BrokerCheckOutcome;
  /** Anything setup installed that the installed build now finds out of date, from its own doctor. */
  setupCheck?: SetupCheckOutcome;
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
  /**
   * Service files rewritten through journaled before/after pairs: the web pin and, with a runtime switch,
   * the runtime the definition and its PATH name. The field kept its original name so a journal written by
   * an earlier build still recovers.
   */
  serviceWebEnvironment?: ServiceWebEnvironmentChange[];
  /** Present when this upgrade also moves the service and launchers to a newly installed Bun runtime. */
  runtime?: UpgradeRuntimeSwitch;
  updatedAt: string;
}

/** Everything needed to undo a runtime switch from a later process. */
interface UpgradeRuntimeSwitch {
  /** The runtime the service named before the switch. Never touched by the switch, so always restorable. */
  fromPath: string;
  /** The owned runtime the switch moves to: exactly `<home>/runtime/bun-<toVersion>/bun`. */
  toPath: string;
  toVersion: string;
  /** True when this transaction created `toPath`'s directory, so abandoning the switch removes it. */
  installed: boolean;
  /** The bootstrap receipt's `runtime=` before the switch, when the install has that receipt. */
  receiptRuntime?: string;
  /** The installer's command launchers, before and after. */
  launchers: LauncherRuntimeChange[];
}

function validAbsoluteRuntimePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\0\r\n]/.test(value)
    && (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value));
}

function validRuntimeSwitch(value: unknown, home: string): value is UpgradeRuntimeSwitch {
  if (!plainObject(value)) return false;
  const keys = ['fromPath', 'toPath', 'toVersion', 'installed', 'receiptRuntime', 'launchers'];
  return Object.keys(value).every((key) => keys.includes(key))
    && validAbsoluteRuntimePath(value.fromPath)
    && typeof value.toVersion === 'string' && /^\d+\.\d+\.\d+$/.test(value.toVersion)
    && typeof value.toPath === 'string'
    && resolve(value.toPath) === resolve(ownedBunRuntimePath(home, value.toVersion))
    && typeof value.installed === 'boolean'
    && (value.receiptRuntime === undefined || validAbsoluteRuntimePath(value.receiptRuntime))
    && validLauncherChanges(value.launchers, home);
}

interface BootstrapReceipt {
  path: string;
  target: string;
  host: string;
  application: string;
  runtime: string;
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
  /**
   * True when that runtime was chosen with COSYNCING_BUN_BIN. An operator-pinned runtime is never replaced:
   * a release whose floor it does not meet is refused with instructions instead.
   */
  runtimeOverridden?: boolean;
  /** Installer host key for the pinned runtime table; defaults to the bootstrap receipt's, then this process's. */
  runtimeHost?: string;
  /** How a newly installed runtime proves it runs here. Defaults to spawning `--revision`. Tests inject it. */
  runtimeProbe?: BunRuntimeProbe;
  /** Host facts that order the pinned builds (musl, AVX2). Defaults to probing this host. */
  runtimeFacts?: { musl?: boolean; avx2?: boolean };
  manifestUrl?: string;
  trustedKeys?: Readonly<Record<string, string>>;
  fetch?: typeof fetch;
  /**
   * Runs the candidate's self-check and, after commit, its `claude-mod refresh`. The fourth argument is the
   * environment the child gets; when it is omitted the child gets HOME and PATH only, which is right for the
   * self-check and wrong for the refresh, so the refresh always passes one.
   */
  runBinary?: (
    executable: string,
    args: readonly string[],
    timeoutMs?: number,
    env?: Readonly<Record<string, string>>,
  ) => Promise<UpgradeBinaryResult>;
  /** The environment the refresh child's allowlist is taken from. Defaults to this process's own. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Native process/filesystem seams for installer-owned desktop acceptance. */
  desktop?: Pick<DesktopClientContext, 'isRunning' | 'rename' | 'writeReceipt' | 'remove'>;
  /**
   * Which components this run may touch, when the caller is not a human at a terminal.
   *
   * Absent preserves the historical behaviour: `cosyncing upgrade` reconciles the
   * installer-owned desktop beside the broker, which is what a person typing that
   * command expects. Anyone who is NOT that person has to say what they asked for.
   * The app's update button means "update this server", and a phone has no claim on
   * the desktop app installed on the machine it happens to be reaching -- so the
   * scope has to be a fact of the run rather than a hope that the manifest carries no
   * desktop archive for this host, or that no app happens to be running there.
   */
  components?: readonly UpdateComponent[];
  /**
   * An immutable release identity this run must install, when the caller is not a person.
   *
   * Absent means "install whatever the channel serves", which is what `cosyncing upgrade`
   * has always meant. A caller acting on somebody's reviewed consent cannot mean that: the
   * channel is mutable and may have promoted something else between the review and this
   * process starting, and installing it would be a different action than the one approved.
   * A pin that does not match the served release is a refusal, never a substitution.
   */
  pinnedReleaseId?: string;
  service?: UpgradeServiceController;
  /** Told as each long step starts, so a terminal can say what the run is waiting on. */
  progress?: (event: UpgradeProgressEvent) => void;
  verifyBrokerVersion?: (config: BrokerConfig, expectedVersion: string) => Promise<boolean>;
  verifyWebVersion?: (config: BrokerConfig, expectedVersion: string) => Promise<boolean>;
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
    && /^\d+\.\d+\.\d+$/.test(value.minimumBunVersion)
    // Pins that could not satisfy the floor they travel with are a malformed release, not a fallback.
    && (value.bunRuntime === undefined
      || (validReleaseBunRuntime(value.bunRuntime)
        && bunVersionAtLeast(value.bunRuntime.version, value.minimumBunVersion)));
}

function validReleaseAndroidApp(value: unknown): value is ReleaseAndroidApp {
  if (!plainObject(value)) return false;
  return typeof value.name === 'string'
    && /^cosyncing-client-\d+\.\d+\.\d+-android\.apk$/.test(value.name)
    && value.applicationId === 'com.cosyncing.client'
    && Number.isSafeInteger(value.versionCode) && (value.versionCode as number) > 0
    && Number.isSafeInteger(value.size) && (value.size as number) > 0
    && (value.size as number) <= MAX_RELEASE_ARTIFACT_BYTES
    && validSha(value.sha256)
    && safeHttpsUrl(value.url)
    && validSha(value.signerSha256);
}

function parseManifest(value: unknown): ReleaseManifest {
  if (!plainObject(value)
      || value.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION
      || value.product !== PRODUCT_IDENTITY.productName
      || !validVersion(value.version)
      || value.channel !== 'stable'
      || typeof value.sourceCommit !== 'string' || !/^[a-f0-9]{7,64}$/.test(value.sourceCommit)
      || typeof value.publishedAt !== 'string' || !Number.isFinite(Date.parse(value.publishedAt))
      || !Array.isArray(value.artifacts) || value.artifacts.length > 8
      || !value.artifacts.every(validReleaseArtifact)
      // Native-free releases are complete broker/web pairs, never an empty channel entry.
      || (value.artifacts.length === 0
        && (value.jsApp === undefined || value.contract === undefined || value.webApp === undefined))
      || ((value.contract === undefined) !== (value.webApp === undefined))
      || (value.contract !== undefined && !validReleaseContract(value.contract))
      || (value.webApp !== undefined && !validReleaseWebSidecar(value.webApp))
      || (value.jsApp !== undefined && !validReleaseJavaScriptApp(value.jsApp))
      || (value.androidApp !== undefined && !validReleaseAndroidApp(value.androidApp))
      || (value.desktopClients !== undefined && !validDesktopClients(value.desktopClients, value.version as string))
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
  // A block that is merely absent stays absent. A block that is present and malformed is a
  // verification failure with its own code: degrading it to "no updater metadata" would let a
  // truncated feed present a capable release as a legacy one mid-operation.
  if (manifest.updater !== undefined) manifest.updater = parseReleaseUpdaterMetadata(manifest.updater);
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
export function verifySignedManifest(
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

export function releaseKeys(): Readonly<Record<string, string>> {
  const keyId = typeof COSYNCING_RELEASE_KEY_ID === 'undefined' ? '' : COSYNCING_RELEASE_KEY_ID?.trim();
  const key = typeof COSYNCING_RELEASE_PUBLIC_KEY_PEM === 'undefined' ? '' : COSYNCING_RELEASE_PUBLIC_KEY_PEM?.trim();
  return keyId && key ? { [keyId]: key } : {};
}

export function defaultManifestUrl(): string | undefined {
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

async function boundedDownload(
  fetcher: typeof fetch,
  url: string,
  maximum: number,
  timeoutMs = 30_000,
): Promise<Uint8Array> {
  if (!safeHttpsUrl(url)) throw new Error('release-url-invalid');
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { accept: 'application/json, application/octet-stream' },
      // GitHub release assets, including /releases/latest/download, redirect to an immutable HTTPS
      // asset URL. No credentials are sent, and the manifest signature/artifact hash remain authoritative.
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
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
  /** The release's own signed runtime pins, when it carries them. */
  bunRuntime?: ReleaseBunRuntime;
}

/**
 * The immutable handle for a verified manifest.
 *
 * Derived from the commit rather than the version, so a re-tagged version cannot masquerade
 * as the release a person reviewed. Both the update-management surface and the installer
 * compute it the same way: a pin that meant one thing where it was written and another where
 * it is honoured is worse than no pin at all.
 */
export function releaseIdFromManifest(manifest: { version: string; sourceCommit: string }): string {
  return `rel-${manifest.version}+${manifest.sourceCommit.slice(0, 7)}`;
}

/** The shape a release id may take on a command line, and nothing that looks like an argument. */
const RELEASE_ID_PATTERN = /^rel-\d+\.\d+\.\d+\+[A-Za-z0-9]{7,40}$/;

export function isReleaseId(value: string): boolean {
  return RELEASE_ID_PATTERN.test(value);
}

/**
 * `rel-1.2.3+abcdefa` back to `1.2.3`. Unparsable stays unknown rather than guessed.
 *
 * Here rather than beside the job that uses it because the release id is a channel identity
 * before it is a job field: the handoff has to name the version to the upgrader it delegates to,
 * and a launcher that parsed it independently would be a second, drift-prone reader of the format.
 */
export function releaseIdVersion(releaseId: string): string | undefined {
  const match = /^rel-(\d+\.\d+\.\d+)\+/.exec(releaseId);
  return match?.[1];
}

/**
 * The commit a release id pins, shortened the way the id was built.
 *
 * Version alone cannot identify a build: two commits can carry the same version string, and only
 * one of them is the release anybody reviewed. Settling a job therefore needs both.
 */
export function releaseIdCommit(releaseId: string): string | undefined {
  const match = /^rel-\d+\.\d+\.\d+\+([A-Za-z0-9]{7,40})$/.exec(releaseId);
  return match?.[1]?.slice(0, 7).toLowerCase();
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
      ...(jsApp.bunRuntime ? { bunRuntime: jsApp.bunRuntime } : {}),
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
 * Keep the installed and previous versions for rollback, plus any custom directory still pinned in the
 * service environment. A custom pin may name an older installer directory and must survive pruning.
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

function pruneReleaseWebRoots(applicationPath: string, keep: readonly string[], pinnedRoot?: string): void {
  const binDirectory = dirname(resolve(applicationPath));
  const kept = new Set(keep.map((version) => `${PRODUCT_IDENTITY.releaseAssetPrefix}-web-${version}`));
  const pattern = new RegExp(
    `^${PRODUCT_IDENTITY.releaseAssetPrefix}-web-\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$`,
  );
  let entries: string[];
  try { entries = readdirSync(binDirectory); } catch { return; }
  for (const entry of entries) {
    if (kept.has(entry) || !pattern.test(entry)
        || (pinnedRoot && resolve(join(binDirectory, entry)) === resolve(pinnedRoot))) continue;
    // A superseded web root is inert, so failing to remove one must never fail a completed upgrade.
    try { removeOwnedDirectory(join(binDirectory, entry)); } catch { /* leave it for repair */ }
  }
}

export interface PackageManagerUpdateGuidance {
  detailCode: string;
  summary: string;
}

/** Old npm installations retain their ownership boundary until the operator migrates them. */
export function packageManagerUpdateGuidance(
  buildInfo: Readonly<Pick<BuildInfo, 'distribution'>>,
): PackageManagerUpdateGuidance | undefined {
  if (buildInfo.distribution !== 'bun-js') return undefined;
  return {
    detailCode: 'upgrade-package-manager-owned',
    summary: `This ${PRODUCT_IDENTITY.productName} installation is owned by npm. `
      + 'Run the signed installer from https://cosyncing.com/#install and confirm migration; '
      + 'after setup succeeds, use `cosy update` for future updates.',
  };
}

// One semver ordering for the whole engine: the updater floors and the channel probe must
// never disagree about which of two versions is newer.
const compareVersions = compareReleaseVersions;


/** The installer host whose pinned runtime this machine would install: an explicit one, else this process's. */
function runtimeHostFor(explicit?: string): string | undefined {
  return explicit ?? bunRuntimeHost();
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
    // A newer release that needs a newer Bun is still an ordinary update where `cosy update` installs that
    // Bun itself. Where it cannot -- the operator pinned the runtime -- offering the update would only
    // produce a refusal, so the check says which state this is instead.
    if (comparison > 0) {
      const runtime = planBunRuntimeUpgrade({
        ...(verified.minimumBunVersion ? { minimumBunVersion: verified.minimumBunVersion } : {}),
        ...(dependencies.runtimeVersion ? { runtimeVersion: dependencies.runtimeVersion } : {}),
        ...(dependencies.runtimePath ? { runtimePath: dependencies.runtimePath } : {}),
        runtimeOverridden: dependencies.runtimeOverridden === true,
        ...(verified.bunRuntime ? { releaseRuntime: verified.bunRuntime } : {}),
        ...(runtimeHostFor(dependencies.runtimeHost) ? { host: runtimeHostFor(dependencies.runtimeHost)! } : {}),
        toVersion: verified.manifest.version,
      });
      if (runtime.kind === 'refused') {
        return {
          schemaVersion: 1,
          status: 'unknown',
          currentVersion,
          latestVersion: verified.manifest.version,
          publishedAt: verified.manifest.publishedAt,
          checkedAt,
          detailCode: runtime.detailCode,
        };
      }
    }
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

export async function defaultRunBinary(
  executable: string,
  args: readonly string[],
  timeoutMs = 15_000,
  env?: Readonly<Record<string, string>>,
): Promise<UpgradeBinaryResult> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([executable, ...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: env ? { ...env } : { HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
  } catch {
    return { status: 'unavailable', stdout: '', stderr: '' };
  }
  const completed = await Promise.race([
    child.exited.then((exitCode) => ({ timedOut: false as const, exitCode })),
    Bun.sleep(timeoutMs).then(() => ({ timedOut: true as const, exitCode: undefined })),
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
 * Read the standalone installer's receipt when this installation has one.
 *
 * The setup receipt is the lifecycle authority, but the standalone installer deliberately keeps its own
 * narrow ownership proof so it never overwrites an unrelated file. A bootstrap-js self-upgrade changes the
 * file both receipts describe, so leaving this second receipt behind makes the next signed installer reject
 * a legitimate upgraded application as drift. Missing is valid for acquisition paths that never used the
 * standalone installer; a present receipt must be exactly the installer-owned schema before upgrade may
 * rewrite it.
 */
function inspectBootstrapReceipt(home: string, targetPath: string): BootstrapReceipt | undefined {
  const path = join(home, 'bootstrap-receipt');
  const inspection = inspectOwnerOnlyFile(path);
  if (inspection.status === 'missing') return undefined;
  if (inspection.status !== 'ok') throw new Error('upgrade-bootstrap-receipt-unsafe');

  const values = new Map<string, string>();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error('upgrade-bootstrap-receipt-invalid');
    const key = line.slice(0, separator);
    if (values.has(key)) throw new Error('upgrade-bootstrap-receipt-invalid');
    values.set(key, line.slice(separator + 1));
  }
  const expectedKeys = [
    'schemaVersion', 'product', 'version', 'target', 'distribution',
    'host', 'application', 'webRoot', 'runtime', 'sha256',
  ];
  if (values.size !== expectedKeys.length || expectedKeys.some((key) => !values.has(key))
      || values.get('schemaVersion') !== '2'
      || values.get('product') !== PRODUCT_IDENTITY.productName
      || values.get('distribution') !== 'bootstrap-js'
      || values.get('target') !== RELEASE_JAVASCRIPT_APP_TARGET
      || !validVersion(values.get('version'))
      || !validSha(values.get('sha256'))
      || resolve(values.get('application') ?? '') !== resolve(targetPath)
      || resolve(values.get('webRoot') ?? '')
        !== resolve(join(dirname(targetPath), `cosyncing-web-${values.get('version') ?? ''}`))
      || !isAbsolute(values.get('runtime') ?? '')
      || !/^[a-z0-9]+-[a-z0-9]+$/.test(values.get('host') ?? '')) {
    throw new Error('upgrade-bootstrap-receipt-invalid');
  }
  return {
    path,
    target: values.get('target')!,
    host: values.get('host')!,
    application: values.get('application')!,
    runtime: values.get('runtime')!,
  };
}

function writeBootstrapReceipt(
  receipt: BootstrapReceipt | undefined,
  targetPath: string,
  version: string,
  installedSha256: string,
  runtime: string = receipt?.runtime ?? '',
): void {
  if (!receipt) return;
  const webRoot = join(dirname(targetPath), `cosyncing-web-${version}`);
  atomicWriteOwnerOnly(receipt.path, [
    'schemaVersion=2',
    `product=${PRODUCT_IDENTITY.productName}`,
    `version=${version}`,
    `target=${receipt.target}`,
    'distribution=bootstrap-js',
    `host=${receipt.host}`,
    `application=${receipt.application}`,
    `webRoot=${webRoot}`,
    `runtime=${runtime}`,
    `sha256=${installedSha256}`,
    '',
  ].join('\n'), { mode: 0o600 });
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
  const runtimes = ['fromRuntimePath', 'toRuntimePath'] as const;
  return identifiers.every((key) => typeof value[key] === 'string' && safeId.test(value[key] as string))
    // A runtime switch names both ends or neither: restoring needs the runtime to move the task back to.
    && ((value.fromRuntimePath === undefined) === (value.toRuntimePath === undefined))
    && runtimes.every((key) => value[key] === undefined || validAbsoluteRuntimePath(value[key]))
    && Object.keys(value).every((key) => ([...identifiers, ...runtimes] as readonly string[]).includes(key));
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

/**
 * Whether this host is in the middle of an upgrade transaction it has not committed.
 *
 * The journal is written before the first byte moves and removed in the same path that commits
 * the receipts naming the new build, so its presence is the installer's own "not yet" marker and
 * its absence is the end of the transaction -- committed, or rolled back and restored. Nothing
 * here parses it: a journal this build cannot read is still a journal, and still means somebody
 * has unfinished work to look at.
 */
export function upgradeTransactionOpen(home: string): boolean {
  return existsSync(upgradeJournalPath(home));
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
      || (value.runtime !== undefined && !validRuntimeSwitch(value.runtime, home))
      || (value.serviceWebEnvironment !== undefined && (() => {
        const install = inspectInstallState(home);
        return !install.committed || !validServiceWebChanges(value.serviceWebEnvironment, install.state);
      })())
      || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error('upgrade-journal-malformed');
  }
  return value as unknown as UpgradeJournal;
}

/** A rewritten definition the service manager must be told to re-read before the next start. */
function definitionReloadNeeded(change: ServiceWebEnvironmentChange): boolean {
  return change.resource.id === 'service-launchd' || change.resource.id === 'service-systemd';
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
  const bootstrapReceipt = inspectBootstrapReceipt(options.home, journal.targetPath);
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
  if (journal.serviceWebEnvironment) {
    for (const record of writeServiceWebEnvironment(journal.serviceWebEnvironment, true)) resources.set(record.id, record);
    if (journal.serviceWebEnvironment.some((change) => definitionReloadNeeded(change))) await options.service?.reloadDefinition?.(journal.serviceWasActive);
  }
  // The launchers go back to the runtime they named. Best effort: a launcher an operator has since edited
  // is theirs, and the runtime it names is kept below so it still starts.
  let launchersRestored = true;
  if (journal.runtime) {
    try { writeLauncherChanges(journal.runtime.launchers, true); } catch { launchersRestored = false; }
  }
  const installer = plainObject(install.state.installer) ? install.state.installer : {};
  writeInstallState({
    ...install.state,
    resources: [...resources.values()].sort((left, right) => left.id.localeCompare(right.id)),
    installer: { ...installer, version: journal.fromVersion },
  }, options.home);
  writeBootstrapReceipt(
    bootstrapReceipt,
    journal.targetPath,
    journal.fromVersion,
    journal.previousSha256,
    journal.runtime?.receiptRuntime ?? bootstrapReceipt?.runtime,
  );
  if (journal.serviceWasActive && options.service) await options.service.start();
  // Nothing names the abandoned runtime any more. Removing it can fail on Windows when the process running
  // this recovery is executing from it; an unreferenced runtime is inert and the next update reuses it.
  if (journal.runtime?.installed && launchersRestored) {
    try { removeAbandonedBunRuntime(options.home, journal.runtime.toPath); } catch { /* inert */ }
  }
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

async function defaultVerifyWebVersion(config: BrokerConfig, expectedVersion: string): Promise<boolean> {
  try {
    const response = await fetch(new URL('/cosy/version.json', config.broker.internalUrl), {
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return false;
    const body = await response.json() as Record<string, unknown>;
    return body.version === expectedVersion;
  } catch { return false; }
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
  claudeMod?: UpgradeCommandResult['claudeMod'],
  desktopClient?: DesktopClientOutcome,
): UpgradeCommandResult {
  return {
    schemaVersion: 1,
    status,
    exitCode,
    detailCode,
    summary,
    fromVersion,
    recoveredInterruptedUpgrade,
    ...(toVersion ? { toVersion } : {}),
    ...(claudeMod ? { claudeMod: { status: claudeMod.status, detailCode: claudeMod.detailCode } } : {}),
    ...(desktopClient ? { desktopClient: { status: desktopClient.status, detailCode: desktopClient.detailCode } } : {}),
  };
}

/**
 * Bring the cosyncing Claude mod along with the broker, by asking the NEW binary to do it.
 *
 * The marketplace copy is what Claude loads in place, and it is written from the marketplace embedded
 * in whichever build ran setup. The OLD process cannot update it -- the copy embedded in it IS the old
 * mod -- so the freshly switched binary runs its own `claude-mod refresh`. The child decides from
 * the recorded setup choice and ownership, including a wanted copy that is missing.
 *
 * Called after the journal is gone and the receipts are committed, with the upgrade's installation lock
 * already released so the child can take its own: the broker upgrade has succeeded by then, and a mod
 * Claude refuses to install is reported, never rolled back.
 */
async function refreshInstalledClaudeMod(options: {
  home: string;
  targetPath: string;
  toVersion: string;
  javaScriptCandidate: boolean;
  runtimePath?: string;
  runBinary: NonNullable<UpgradeDependencies['runBinary']>;
  env: Readonly<Record<string, string | undefined>>;
  progress?: UpgradeDependencies['progress'];
}): Promise<{ status: 'installed' | 'refreshed' | 'current' | 'skipped' | 'failed'; detailCode: string; clause: string }> {
  const requested = readSetupState(options.home).claudeModRequested === true;
  const clause = (text: string): string => requested ? text : '';
  if (requested) options.progress?.({ step: 'refreshing-claude-mod' });
  // The same launch pair the self-check used: a JavaScript bundle carries no interpreter, so it goes to
  // the validated runtime rather than whatever `bun` PATH happens to resolve.
  const launch = options.javaScriptCandidate && options.runtimePath
    ? [options.runtimePath, options.targetPath]
    : [options.targetPath];
  // The child gets the operator's Claude-relevant environment, not the self-check's HOME and PATH. With only
  // those two it ran `claude plugin` against the default `~/.claude` whatever CLAUDE_CONFIG_DIR said, used a
  // bare `claude` whatever COSYNCING_CLAUDE_BIN said, and resolved its own state home from scratch. One
  // allowlist, defined beside the mod's ownership rules, so the parent and the child agree on what passes.
  let ran: UpgradeBinaryResult;
  try {
    ran = await options.runBinary(
      launch[0] as string,
      [...launch.slice(1), 'claude-mod', 'refresh', '--json', '--home', options.home],
      CLAUDE_MOD_REFRESH_TIMEOUT_MS,
      claudeModRefreshEnvironment(options.env),
    );
  } catch {
    return { status: 'failed', detailCode: 'claude-mod-refresh-launch-failed',
      clause: clause(' The cosyncing Claude mod could not be reconciled; run cosy doctor, then cosy setup.') };
  }
  let parsed: { status?: unknown; detailCode?: unknown } | undefined;
  try {
    parsed = JSON.parse(ran.stdout) as { status?: unknown; detailCode?: unknown };
  } catch { /* a child that printed nothing parseable answered nothing */ }
  const reported = typeof parsed?.detailCode === 'string' ? parsed.detailCode : undefined;
  const raw = parsed?.status;
  if (ran.status !== 'ok') {
    return {
      status: 'failed',
      detailCode: reported ?? `claude-mod-refresh-${ran.status}`,
      clause: clause(' The cosyncing Claude mod could not be reconciled; run cosy doctor, then cosy setup.'),
    };
  }
  if (raw === 'installed' || raw === 'refreshed') {
    return {
      status: raw,
      detailCode: typeof reported === 'string' ? reported : `claude-mod-${raw}`,
      clause: clause(` The cosyncing Claude mod was ${raw} to ${options.toVersion}.`),
    };
  }
  if (raw === 'current' || raw === 'skipped') {
    return {
      status: raw,
      detailCode: typeof reported === 'string' ? reported : `claude-mod-refresh-${raw}`,
      clause: clause(raw === 'current' ? ' The cosyncing Claude mod is current.'
        : reported === 'claude-mod-refresh-skipped-disabled' ? ' The cosyncing Claude mod is switched off in Claude and was left alone.'
          : ' The cosyncing Claude mod was left alone. Run cosy doctor for details.'),
    };
  }
  // The child answered ok but not with a refresh outcome: either it is an older binary without the
  // verb (an upgrade FROM a pre-mod release cannot refresh anything) or it said something unexpected.
  // Say which, and leave the reconciliation to setup.
  return {
    status: 'failed',
    detailCode: reported ?? 'claude-mod-refresh-unparsable',
    clause: clause(' The cosyncing Claude mod could not be reconciled; run cosy doctor, then cosy setup.'),
  };
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

  // A scope that excludes the broker is not this function's job, and the answer comes
  // before any installation inspection: runUpgrade IS the broker installer, so quietly
  // doing the broker half anyway would turn a client-only retry into an unrequested
  // service restart of a server that is already healthy.
  if (dependencies.components && !dependencies.components.includes('broker')) {
    return result('blocked', 1, 'upgrade-component-scope-unsupported',
      "A client-only update is installed by this machine's own updater, not by the broker upgrade path.",
      fromVersion, false);
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

  // Absent scope keeps the historical implicit reconciliation.
  const reconcilesDesktop = dependencies.components === undefined || dependencies.components.includes('client');
  const desktopContext: DesktopClientContext = { home: dependencies.home,
    ...(dependencies.env ? { env: dependencies.env } : {}), ...dependencies.desktop };
  let desktop: PreparedDesktopClient | undefined;
  let desktopProblem: DesktopClientOutcome | undefined;
  if (reconcilesDesktop) {
    try {
      desktop = inspectDesktopClient(desktopContext);
      assertDesktopClientStopped(desktop, desktopContext);
    } catch (error) {
      if (error instanceof DesktopClientRunningError) {
        return result('blocked', 1, error.detailCode, error.message, fromVersion, false);
      }
      desktopProblem = skippedDesktopClient(error);
      desktop = undefined;
    }
  }
  /**
   * The desktop half of the report, honouring the scope.
   *
   * Out of scope is a stated skip rather than silence: a caller that asked for a
   * server-only update is entitled to be told the desktop was not part of it, in the
   * same place the report says what happened to everything that WAS.
   */
  const desktopOutcomeFor = async (manifest: ReleaseManifest): Promise<DesktopClientOutcome> => {
    if (!reconcilesDesktop) {
      return {
        status: 'skipped',
        detailCode: 'desktop-client-out-of-scope',
        clause: ' Desktop client: not part of this operation, so nothing here was inspected or replaced.',
      };
    }
    if (desktopProblem) return desktopProblem;
    return reconcileDesktopClient({
      prepared: desktop,
      context: desktopContext,
      ...(desktop ? { row: manifest.desktopClients?.[desktop.receipt.host] } : {}),
      download: (url, maximum) => boundedDownload(dependencies.fetch ?? fetch, url, maximum),
      compareVersions,
    });
  };

  // A terminal that can no longer be written to must not change what the upgrade does, and a throw from
  // inside the transaction would read as a failed candidate and roll a good one back.
  const progress = (event: UpgradeProgressEvent): void => {
    try { dependencies.progress?.(event); } catch { /* progress is commentary, never control flow */ }
  };
  /**
   * Close a run that ends with a build installed by asking that build whether its broker is up, and whether
   * setup has anything to refresh. Called with the installation lock released so the children can take it.
   * Never throws: on the success path a throw would reach the rollback.
   */
  const withInstalledChecks = async (
    outcome: UpgradeCommandResult,
    installed: { runtimePath?: string; version: string; healthVerified: boolean },
  ): Promise<UpgradeCommandResult> => {
    try {
      const config = inspectBrokerConfig(dependencies.home);
      const checks = await checkInstalledBroker({
        launch: javaScriptCandidate && installed.runtimePath ? [installed.runtimePath, targetPath] : [targetPath],
        runBinary: dependencies.runBinary ?? defaultRunBinary,
        env: dependencies.env ?? process.env,
        ...(dependencies.service ? { service: dependencies.service } : {}),
        healthVerified: installed.healthVerified,
        version: installed.version,
        ...(config.status === 'ok' ? { url: config.config.broker.internalUrl } : {}),
        progress,
      });
      return { ...outcome, ...checks };
    } catch {
      return outcome;
    }
  };

  const acquire = dependencies.acquireLock ?? ((options) => acquireInstallationLock(options));
  let lock: InstallationLockHandle;
  try { lock = acquire({ command: 'upgrade', home: dependencies.home }); }
  catch {
    return result('blocked', 1, 'installation-lock-unavailable', 'Another installation mutation is active or the lock is unsafe.', fromVersion, false);
  }
  let recovered = false;
  try {
    try { if (reconcilesDesktop && !desktopProblem) assertDesktopClientUnchanged(desktop, desktopContext); }
    catch (error) {
      if (error instanceof DesktopClientRunningError) {
        return result('blocked', 1, error.detailCode, error.message, fromVersion, false);
      }
      desktopProblem = skippedDesktopClient(error);
      desktop = undefined;
    }
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
    let bootstrapReceipt: BootstrapReceipt | undefined;
    try {
      bootstrapReceipt = javaScriptCandidate
        ? inspectBootstrapReceipt(dependencies.home, targetPath)
        : undefined;
    } catch (error) {
      return result(
        'blocked',
        1,
        error instanceof Error ? error.message : 'upgrade-bootstrap-receipt-invalid',
        'The standalone installer ownership receipt is unsafe or invalid; repair is required.',
        fromVersion,
        recovered,
      );
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
      return result('blocked', 1, 'upgrade-schema-repair-required', schemaProblems.map(durableStateProblemSummary).join(' '), fromVersion, recovered);
    }

    const manifestUrl = dependencies.manifestUrl ?? defaultManifestUrl();
    const trustedKeys = dependencies.trustedKeys ?? releaseKeys();
    if (!manifestUrl || Object.keys(trustedKeys).length === 0) {
      return result('blocked', 1, 'release-channel-unconfigured', 'This build has no trusted release channel metadata.', fromVersion, recovered);
    }
    let candidate: UpgradeCandidate;
    let artifactBytes: Uint8Array;
    let runtimePlan: BunRuntimeUpgradePlan = { kind: 'satisfied' };
    try {
      const manifestBytes = await boundedDownload(dependencies.fetch ?? fetch, manifestUrl, MAX_RELEASE_MANIFEST_BYTES);
      let manifestValue: unknown;
      try { manifestValue = JSON.parse(Buffer.from(manifestBytes).toString('utf8')); }
      catch { throw new Error('release-manifest-malformed'); }
      candidate = verifyUpgradeCandidate({ value: manifestValue, buildInfo: dependencies.buildInfo, trustedKeys });
      // A pinned run installs its pin or nothing, decided before any comparison against the
      // running version: a channel that moved underneath this caller is a conflict to report,
      // not a newer build to adopt and not an "already current" answer about something else.
      const candidateReleaseId = releaseIdFromManifest(candidate.manifest);
      if (dependencies.pinnedReleaseId !== undefined && dependencies.pinnedReleaseId !== candidateReleaseId) {
        return result('blocked', 1, 'release-target-moved',
          `The channel now serves ${candidateReleaseId}; the pinned ${dependencies.pinnedReleaseId} was not installed.`,
          fromVersion, recovered);
      }
      if (compareVersions(candidate.manifest.version, fromVersion) === 0) {
        const client = await desktopOutcomeFor(candidate.manifest);
        // "Already current" is exactly when an operator reruns update because something is broken, so this
        // answer closes with the same checks as a real upgrade instead of returning before looking.
        lock.release();
        return await withInstalledChecks(result(client.status === 'updated' ? 'complete' : 'already-current', 0,
          client.status === 'updated' ? 'desktop-client-only-updated' : 'release-already-current',
          `cosyncing ${fromVersion} is already current.${client.clause}`, fromVersion, recovered, fromVersion,
          undefined, client), { ...(dependencies.runtimePath ? { runtimePath: dependencies.runtimePath } : {}),
          version: fromVersion, healthVerified: false });
      }
      if (compareVersions(candidate.manifest.version, fromVersion) < 0) throw new Error('release-downgrade-refused');
      // The interpreter floor is checked BEFORE the download, and against the version the running runtime
      // reported. A JavaScript release may raise the Bun it needs; swapping in a bundle whose floor this
      // host cannot meet would fail at exec, after the service has already been stopped. So either this
      // update installs the release's pinned Bun as part of the same transaction, or -- where the runtime is
      // not cosyncing's to replace -- it stops here and says exactly what to do.
      runtimePlan = javaScriptCandidate
        ? planBunRuntimeUpgrade({
          ...(candidate.minimumBunVersion ? { minimumBunVersion: candidate.minimumBunVersion } : {}),
          ...(dependencies.runtimeVersion ? { runtimeVersion: dependencies.runtimeVersion } : {}),
          ...(dependencies.runtimePath ? { runtimePath: dependencies.runtimePath } : {}),
          runtimeOverridden: dependencies.runtimeOverridden === true,
          ...(candidate.bunRuntime ? { releaseRuntime: candidate.bunRuntime } : {}),
          ...(runtimeHostFor(dependencies.runtimeHost ?? bootstrapReceipt?.host)
            ? { host: runtimeHostFor(dependencies.runtimeHost ?? bootstrapReceipt?.host)! } : {}),
          toVersion: candidate.manifest.version,
        })
        : { kind: 'satisfied' };
      if (runtimePlan.kind === 'refused') {
        return result('blocked', 1, runtimePlan.detailCode, runtimePlan.summary, fromVersion, recovered, candidate.manifest.version);
      }
      progress({ step: 'downloading', version: candidate.manifest.version });
      artifactBytes = await boundedDownload(dependencies.fetch ?? fetch, candidate.url, MAX_RELEASE_ARTIFACT_BYTES);
      if (artifactBytes.byteLength !== candidate.size) throw new Error('release-artifact-size-mismatch');
      if (sha256(artifactBytes) !== candidate.sha256) throw new Error('release-artifact-checksum-mismatch');
    } catch (error) {
      const code = error instanceof Error ? error.message : 'release-verification-failed';
      return result('failed', 1, code, 'The release was unavailable or failed verification; the installed binary was not changed.', fromVersion, recovered);
    }

    const toVersion = candidate.manifest.version;
    // The release's pinned Bun, placed next to the runtime in use and verified before it is unpacked.
    // Still before the journal: a failure here leaves the service, the broker and every launcher exactly
    // as they were, and removes the directory this run created.
    let runtimeInstall: InstalledBunRuntime | undefined;
    if (runtimePlan.kind === 'install') {
      try {
        runtimeInstall = await installBunRuntime({
          home: dependencies.home,
          version: runtimePlan.version,
          archives: runtimePlan.archives,
          download: (url, maximum) => boundedDownload(dependencies.fetch ?? fetch, url, maximum, BUN_RUNTIME_DOWNLOAD_TIMEOUT_MS),
          ...(dependencies.runtimeProbe ? { probe: dependencies.runtimeProbe } : {}),
          ...(dependencies.runtimeFacts ? { facts: dependencies.runtimeFacts } : {}),
          ...(dependencies.runtimePath ? { currentRuntimePath: dependencies.runtimePath } : {}),
        });
      } catch (error) {
        return result('failed', 1, error instanceof Error ? error.message : 'release-runtime-install-failed',
          `The Bun ${runtimePlan.version} runtime this release needs could not be downloaded, verified or run here; `
            + 'nothing was changed.', fromVersion, recovered, toVersion);
      }
    }
    // The runtime the candidate is exercised with and, after the switch, the one the service runs.
    const effectiveRuntimePath = runtimeInstall?.path ?? dependencies.runtimePath;
    /** Undo the runtime install of a transaction that never reached its journal. */
    const abandonRuntime = (): void => {
      if (!runtimeInstall?.installed) return;
      try { removeAbandonedBunRuntime(dependencies.home, runtimeInstall.path); } catch { /* inert, reused next time */ }
    };
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
      const selfCheck = javaScriptCandidate && effectiveRuntimePath
        ? await runCandidate(effectiveRuntimePath, [stagingPath, 'version', '--json'])
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
      abandonRuntime();
      return result('failed', 1, error instanceof Error ? error.message : 'release-offline-self-check-failed', 'The candidate failed its offline self-check; the installed binary was not changed.', fromVersion, recovered, toVersion);
    }

    // Which version root the service would move to, read while a refusal still costs nothing: the journal
    // has not opened, the service is running, and not one byte on this machine has changed. Planning after
    // the switch would turn an unreadable pointer into a rollback rather than a refusal.
    let activation: DurableServiceVersionActivation | undefined;
    try {
      activation = candidateBuild
        ? dependencies.service?.versions?.plan(candidateBuild, runtimeInstall && dependencies.runtimePath
          ? { fromRuntimePath: dependencies.runtimePath, toRuntimePath: runtimeInstall.path }
          : undefined)
        : undefined;
    } catch (error) {
      try { unlinkRegular(stagingPath); } catch { /* report the original pre-switch failure */ }
      abandonRuntime();
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

    let webPlan: ReturnType<typeof planServiceWebEnvironment>;
    let runtimeSwitch: UpgradeRuntimeSwitch | undefined;
    try {
      webPlan = planServiceWebEnvironment({
        state: installState,
        fromRoot: resolveFlutterWebRoot({ packaged: true, executablePath: targetPath, version: fromVersion }),
        toRoot: resolveFlutterWebRoot({ packaged: true, executablePath: targetPath, version: toVersion }),
        versionedService: !!activation,
        ...(activation ? { versionedInstallerRoot: windowsServiceInstallPaths(dependencies.home, activation.record.fromVersionKey).webRoot } : {}),
      });
      // The runtime moves in the same files, composed onto the web pin so each file has ONE before/after.
      if (runtimeInstall) {
        const serviceRuntime = planServiceRuntimeEnvironment({
          state: installState,
          changes: webPlan.changes,
          executablePath: targetPath,
          toRuntime: runtimeInstall.path,
        });
        webPlan = { ...webPlan, changes: serviceRuntime.changes };
        const launchers = planLauncherRuntimeChanges({
          home: dependencies.home,
          applicationPath: targetPath,
          toRuntime: runtimeInstall.path,
        });
        runtimeSwitch = {
          fromPath: serviceRuntime.fromRuntime ?? bootstrapReceipt?.runtime ?? dependencies.runtimePath ?? runtimeInstall.path,
          toPath: runtimeInstall.path,
          toVersion: runtimeInstall.version,
          installed: runtimeInstall.installed,
          ...(bootstrapReceipt ? { receiptRuntime: bootstrapReceipt.runtime } : {}),
          launchers,
        };
      }
    } catch (error) {
      unlinkRegular(stagingPath);
      abandonRuntime();
      return result('blocked', 1, error instanceof Error ? error.message : 'upgrade-service-environment-invalid',
        error instanceof ServiceWebEnvironmentError
          ? `The service file "${error.target}" could not be safely updated. Run cosy setup to reconcile it.`
          : 'The service environment could not be safely updated. Run cosy setup to reconcile it.', fromVersion, recovered, toVersion);
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
        abandonRuntime();
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
      ...(webPlan.changes.length ? { serviceWebEnvironment: webPlan.changes } : {}),
      ...(runtimeSwitch ? { runtime: runtimeSwitch } : {}),
      updatedAt: now(),
    });
    try {
      serviceWasActive = dependencies.service ? (await dependencies.service.inspect()).active : false;
      journalAt('prepared');
      if (dependencies.faultAfter === 'journal-prepared') throw new Error('upgrade-fixture-interrupted');
      if (serviceWasActive) progress({ step: 'restarting', version: toVersion });
      if (serviceWasActive && dependencies.service) await dependencies.service.stop();
      if (dependencies.faultAfter === 'service-stopped') throw new Error('upgrade-fixture-interrupted');
      atomicWriteOwnerOnly(previousPath, previousBytes, { mode: 0o700 });
      previousWritten = true;
      journalAt('switching');
      atomicWriteOwnerOnly(targetPath, readFileSync(stagingPath), { mode: 0o700 });
      writeServiceWebEnvironment(webPlan.changes);
      if (runtimeSwitch) writeLauncherChanges(runtimeSwitch.launchers);
      if (webPlan.changes.some(definitionReloadNeeded)) await dependencies.service?.reloadDefinition?.(serviceWasActive);
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
        progress({ step: 'verifying', version: toVersion });
        let healthy = false;
        for (let attempt = 0; attempt < Math.max(1, dependencies.healthAttempts ?? 30); attempt += 1) {
          healthy = dependencies.verifyBrokerVersion
            ? await dependencies.verifyBrokerVersion(config.config, toVersion)
            : await defaultVerifyBrokerVersion(dependencies.home, config.config, toVersion);
          if (healthy && candidate.manifest.webApp && webPlan.checkServedVersion) {
            healthy = dependencies.verifyWebVersion
              ? await dependencies.verifyWebVersion(config.config, toVersion)
              : await defaultVerifyWebVersion(config.config, toVersion);
          }
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
        [...(serviceVersion ? dependencies.service?.versions?.resources(serviceVersion.toVersionKey) ?? [] : []),
          ...webPlan.changes.map(({ resource, after }) => ({ ...resource, ownership: { ...resource.ownership, installedSha256: sha256(Buffer.from(after)) } })),
          // The runtime directory joins the receipt in the same write that commits the switch to it, so a
          // non-purge uninstall takes back a runtime an update placed exactly as one the installer placed.
          ...(ownedBunRuntimesPresent(dependencies.home) ? [bunRuntimesReceipt(dependencies.home)] : [])],
      ), dependencies.home);
      writeBootstrapReceipt(bootstrapReceipt, targetPath, toVersion, candidate.sha256, runtimeSwitch?.toPath ?? bootstrapReceipt?.runtime);
      if (dependencies.faultAfter === 'receipt-committed') throw new Error('upgrade-fixture-interrupted');
      unlinkRegular(stagingPath);
      unlinkRegular(upgradeJournalPath(dependencies.home));
      // Committed: the runtime now in use and the one it replaced stay -- as does the one running this
      // command, if that is yet another -- and any older owned runtime goes.
      if (runtimeSwitch) {
        try {
          pruneOwnedBunRuntimes(dependencies.home, [runtimeSwitch.toPath, runtimeSwitch.fromPath,
            ...(dependencies.runtimePath ? [dependencies.runtimePath] : [])]);
        } catch { /* inert */ }
      }
      // Only once the upgrade is committed, and only web roots no version in play still needs.
      if (javaScriptCandidate) pruneReleaseWebRoots(targetPath, [toVersion, fromVersion], webPlan.pinnedRoot);
      // Strictly after the journal is gone: until that moment the superseded root is what a recovery
      // would point the service back at. A superseded root is inert, so failing to remove one must never
      // fail an upgrade that has already committed.
      if (serviceVersion && dependencies.service?.versions) {
        try {
          await dependencies.service.versions.finalize(serviceVersion);
        } catch { /* leave it for repair */ }
      }
      const clientOutcome = await desktopOutcomeFor(candidate.manifest);
      // The upgrade is committed and healthy: journal gone, receipts written, candidate answering on its
      // own port. Release the installation lock BEFORE delegating the mod refresh so the child can take
      // its own -- one lock, one owner at a time -- and a refused refresh stays a note on a complete
      // upgrade rather than becoming a reason to roll a healthy broker back. The release really is first:
      // it used to sit after the refresh, so the child always found the lock held and refreshed nothing.
      // `release()` is idempotent, so the `finally` below is a no-op on this path.
      lock.release();
      const modOutcome = await refreshInstalledClaudeMod({
        home: dependencies.home,
        targetPath,
        toVersion,
        javaScriptCandidate,
        ...(effectiveRuntimePath ? { runtimePath: effectiveRuntimePath } : {}),
        runBinary: dependencies.runBinary ?? defaultRunBinary,
        env: dependencies.env ?? process.env,
        progress,
      });
      // A service that was stopped before the update was switched but never started; the checks start it,
      // through the new build's own `start`, and confirm it answers.
      return await withInstalledChecks(result(
        'complete',
        0,
        'upgrade-complete',
        `Upgraded cosyncing from ${fromVersion} to ${toVersion}.${clientOutcome.clause}${modOutcome.clause}`,
        fromVersion,
        recovered,
        toVersion,
        modOutcome,
        clientOutcome,
      ), { ...(effectiveRuntimePath ? { runtimePath: effectiveRuntimePath } : {}),
        version: toVersion, healthVerified: serviceWasActive });
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
      let launchersRestored = true;
      try {
        if (sha256(previousBytes) !== previousSha256) throw new Error('rollback-binary-mismatch');
        atomicWriteOwnerOnly(targetPath, previousBytes, { mode: 0o700 });
        // Before the service is started, and for the same reason the activation had to precede it: a
        // rollback that restored the binary and left the pointer would start the CANDIDATE and then
        // report the previous release restored.
        if (serviceVersion && dependencies.service?.versions) {
          await dependencies.service.versions.restore(serviceVersion);
        }
        writeServiceWebEnvironment(webPlan.changes, true);
        if (webPlan.changes.some(definitionReloadNeeded)) await dependencies.service?.reloadDefinition?.(serviceWasActive);
        // Best effort, like recovery: a launcher an operator edited since is theirs, and the runtime it
        // names is then kept so it still starts.
        if (runtimeSwitch) {
          try { writeLauncherChanges(runtimeSwitch.launchers, true); } catch { launchersRestored = false; }
        }
        // The pre-upgrade state, minus the rollback copy this run overwrote and removes below. Restoring
        // it unchanged would republish a receipt that measures bytes the copy no longer holds: after one
        // successful upgrade `broker-binary-previous` names the build before THAT one, and this run wrote
        // a different build over the same path.
        writeInstallState(
          previousWritten ? withoutPreviousBinaryReceipt(installState) : installState,
          dependencies.home,
        );
        writeBootstrapReceipt(bootstrapReceipt, targetPath, fromVersion, previousSha256, runtimeSwitch?.receiptRuntime ?? bootstrapReceipt?.runtime);
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
        // The service and launchers run the previous runtime again; the one this run installed is unowned.
        if (launchersRestored) abandonRuntime();
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
  artifact?: ReleaseArtifact;
  keyId: string;
  sign: (payload: Uint8Array) => Uint8Array;
  /** The paired classes a real release always publishes. Omitted by tests exercising a manifest without them. */
  contract?: ReleaseContractIdentity;
  webApp?: ReleaseWebSidecar;
  jsApp?: ReleaseJavaScriptApp;
  desktopClients?: ReleaseDesktopClients;
  /** Signed in-app update metadata. Absent reproduces the pre-feature feed byte for byte. */
  updater?: ReleaseUpdaterMetadata;
}): ReleaseManifest {
  const unsigned: Omit<ReleaseManifest, 'signature'> = {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    product: PRODUCT_IDENTITY.productName,
    version: options.version,
    channel: 'stable',
    sourceCommit: options.sourceCommit,
    publishedAt: options.publishedAt,
    artifacts: options.artifact ? [options.artifact] : [],
    ...(options.contract ? { contract: options.contract } : {}),
    ...(options.webApp ? { webApp: options.webApp } : {}),
    ...(options.jsApp ? { jsApp: options.jsApp } : {}),
    ...(options.desktopClients ? { desktopClients: options.desktopClients } : {}),
    ...(options.updater ? { updater: options.updater } : {}),
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
