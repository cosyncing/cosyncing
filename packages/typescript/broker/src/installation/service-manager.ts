import { createHash } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  readFileSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path';
import {
  bunSpawnResolvedInvocation,
  resolveInvocation,
  type SetupDiagnosisContext,
} from '@cosyncing/adapter-api';
import type { DistributionKind } from '../runtime/application-identity.ts';
import { buildFingerprint, type BuildInfo } from '../runtime/build-info.ts';
import { PRODUCT_IDENTITY } from '@cosyncing/protocol';
import { embeddedRuntimeAsset } from '../runtime/runtime-assets.ts';
import {
  assertNoSymlinkComponents,
  atomicWriteOwnerOnly,
  ensureOwnerOnlyDirectory,
  inspectOwnerOnlyFile,
} from '../security/secure-files.ts';
import {
  rollbackSetupFiles,
  snapshotSetupFiles,
} from './setup-actions.ts';
import type {
  SetupRollbackRecord,
  SetupTransactionAction,
} from './setup-transaction.ts';
import type { InstalledResourceRecord } from './install-state.ts';
import { managedHostServiceEnvironmentEntries } from './shipped-adapters.ts';
import { windowsServiceInstallPaths } from './windows-service-install.ts';
import { WindowsTaskSchedulerServiceProvider } from './windows-task-scheduler-provider.ts';

export const SYSTEMD_SERVICE_NAME = `${PRODUCT_IDENTITY.serviceName}.service`;
/** launchd job label; also the plist filename stem and the `gui/<uid>/<label>` service target. */
export const LAUNCHD_SERVICE_LABEL = `dev.${PRODUCT_IDENTITY.serviceName}.broker`;
export const LAUNCHD_SERVICE_FILENAME = `${LAUNCHD_SERVICE_LABEL}.plist`;
/** Deadline for the read-only `launchctl print` status probe, which runs inside transition polling loops. */
export const LAUNCHD_PRINT_TIMEOUT_MS = 5_000;
/** Overall wall-clock bound for waiting out one start/stop/restart transition, probe time included. */
export const SERVICE_TRANSITION_TIMEOUT_MS = 30_000;
/**
 * systemd may wait through its own stop timeout before returning. Keep stop-capable mutations bounded, but
 * above systemd's normal service-stop window so a successful late stop is not mistaken for a failed action.
 */
export const SYSTEMD_MUTATION_TIMEOUT_MS = 180_000;
export const SERVICE_COMMAND_OUTPUT_LIMIT = 16 * 1024;

export type DurableServiceProviderId = 'systemd' | 'launchd' | 'task-scheduler';

export interface ServiceCommandResult {
  status: 'ok' | 'error' | 'timeout' | 'unavailable';
  exitCode?: number;
  stdout: string;
  stderr: string;
}

export interface ServiceCommandRunner {
  run(executable: string, args: readonly string[], timeoutMs?: number): Promise<ServiceCommandResult>;
}

export interface DurableServiceStatus {
  provider: DurableServiceProviderId;
  supported: boolean;
  definition: 'missing' | 'current' | 'drifted' | 'unsafe';
  environment: 'missing' | 'current' | 'drifted' | 'unsafe';
  enabled: 'enabled' | 'disabled' | 'unknown';
  active: 'active' | 'inactive' | 'failed' | 'transitioning' | 'unknown';
  lingering: 'enabled' | 'disabled' | 'unknown' | 'unsupported';
}

/**
 * Whether the installed objects are OURS. Deliberately separate from {@link DurableServiceStatus}, which
 * says whether they are HEALTHY: an environment file with unexpected contents is `drifted` and still
 * ours, while a task carrying someone else's ownership marker is `current` for them and not ours at all.
 * Conflating the two lets drift stand in for proof of ownership.
 *
 * `unknown` is not a soft `owned`. It means the provider could not establish the answer, and every caller
 * must treat it exactly as it treats `unowned`.
 */
export interface DurableServiceOwnership {
  definition: 'owned' | 'unowned' | 'unknown';
  environment: 'owned' | 'unowned' | 'unknown';
}

export interface ServiceLogsRequest {
  follow: boolean;
  /** Trailing entries to read when not following; callers bound this before it reaches argv. */
  lines: number;
}

/**
 * The immutable terms a versioned service root is keyed on.
 *
 * The semver cannot identify a build -- a whole release cycle shares one -- so the key hashes every term
 * that distinguishes one artifact from another. An upgrade reads them from the CANDIDATE's own self-check:
 * a key string-formatted from the version would name a directory the candidate itself would never resolve.
 */
export interface DurableServiceVersionBuild {
  version: string;
  commit: string;
  buildDate: string | null;
  target: string;
  dirty: boolean | null;
  distribution: DistributionKind;
}

/**
 * Everything needed to undo an activation from a LATER process, and nothing that cannot be journaled.
 *
 * A crash between the pointer flip and the service restart is recovered by a different invocation of the
 * CLI — possibly a different build of it — so the undo cannot depend on anything the crashed run held in
 * memory, or on the version key whichever binary happens to be running now would compute.
 */
export interface DurableServiceVersionRecord {
  installationId: string;
  fromVersionKey: string;
  toVersionKey: string;
}

export interface DurableServiceVersionActivation {
  /** Journaled before {@link apply} runs, so the pointer can never move without a way back on disk. */
  readonly record: DurableServiceVersionRecord;
  apply(): Promise<void>;
}

/**
 * Moving a durable service from one installed version to another, for the providers that have versions.
 *
 * The Windows Scheduled Task execs a bootstrap that reads `active-install.json` at every start and runs the
 * version root it names, so replacing `<home>\bin\cosyncing` does not change what the service runs. This
 * is the seam through which `upgrade` moves the pointer; `undefined` from the factory means the host keeps
 * no versioned root and replacing the binary is the whole of the change.
 */
export interface DurableServiceVersions {
  /**
   * The record naming the root this upgrade would move to, or undefined when there is no versioned
   * install to move. Computed before anything is written, so the journal can carry it into the phase in
   * which the pointer may have moved.
   */
  plan(build: Readonly<DurableServiceVersionBuild>): DurableServiceVersionActivation | undefined;
  /** Point the service back at `fromVersionKey` and drop the candidate's root. Idempotent. */
  restore(record: Readonly<DurableServiceVersionRecord>): Promise<void>;
  /** Drop the superseded root, only once the new receipt and the health gate have committed. */
  finalize(record: Readonly<DurableServiceVersionRecord>): Promise<void>;
  /** The receipts that name one version root, for the state an upgrade or a recovery commits. */
  resources(versionKey: string): readonly InstalledResourceRecord[];
}

export interface DurableServiceProvider {
  readonly id: DurableServiceProviderId;
  readonly serviceName: string;
  readonly definitionPath: string;
  readonly environmentPath: string;
  readonly persistenceTarget: string;
  /**
   * Complete argv for reading this provider's service output. It is a function of follow/lines because the
   * two providers take opposite shapes — journald selects a unit, launchd tails plain files — and splicing a
   * single fixed argv only ever worked for journalctl.
   */
  logsCommand(request: Readonly<ServiceLogsRequest>): readonly string[];
  expectedDefinition(): string;
  expectedEnvironment(): string;
  /** Files covered by the shared setup journal. Defaults to definitionPath and environmentPath. */
  transactionFilePaths?(): readonly string[];
  /** Provider-owned state that is not represented by files, such as Task Scheduler folders and task XML. */
  captureTransactionState?(): Promise<Record<string, unknown>>;
  /** Restore a snapshot returned by captureTransactionState after journaled files have been restored. */
  restoreTransactionState?(state: Readonly<Record<string, unknown>>): Promise<void>;
  /** Receipt records for providers whose owned objects are not the two legacy service files. */
  installedResources?(): InstalledResourceRecord[];
  /**
   * This provider's own ownership verdict for the objects it installed.
   *
   * Providers whose definition is a FILE (systemd, launchd) omit it: `inspect()` cannot tell our unit file
   * from a lookalike, so ownership rests on the package-hash receipt written at install time and the
   * caller derives the verdict from that.
   *
   * Providers whose owned objects are not files implement it, because only they can answer. The Windows
   * task scheduler is the case: a scheduled task has no file to hash, and its ownership rests on exact
   * receipts, the immutable marker written into the task, folder authority and the security descriptor.
   *
   * Called after {@link inspect}; before that it must answer `unknown`, never `owned`.
   */
  ownership?(): DurableServiceOwnership;
  /** Remove superseded receipt-owned artifacts only after the new receipt and health gate have committed. */
  finalizeCommitted?(): Promise<void>;
  /**
   * Write this version's immutable root and point the service at it, without touching the service
   * manager's own objects.
   *
   * Implemented only where the unit does NOT name the installed binary. systemd and launchd exec
   * `<home>/bin/cosyncing` directly, so replacing that file is the whole of a version change there and
   * there is no root to write.
   */
  stageVersion?(): Promise<void>;
  inspect(): Promise<DurableServiceStatus>;
  installDefinition(): Promise<void>;
  reloadDefinition(): Promise<void>;
  setEnabled(enabled: boolean): Promise<void>;
  enableLingering(): Promise<void>;
  disableLingering(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  uninstall(): Promise<void>;
}

/**
 * Construction inputs shared by durable service providers. Provider-specific options extend this shape;
 * setup, repair, status, and lifecycle commands all pass through the same provider-neutral seam.
 */
export interface DurableServiceProviderOptions {
  context: SetupDiagnosisContext;
  homeDir: string;
  stateHome: string;
  /** Stable receipt identity used by providers that own non-file service-manager objects. */
  installationId?: string;
  /** Exact receipts from which the Windows provider derives folder authority after resolving the current SID. */
  taskSchedulerReceiptResources?: readonly InstalledResourceRecord[];
  /** Immutable version-directory key selected by setup for pointer-based providers. */
  versionKey?: string;
  cacheRoot: string;
  /**
   * The cosyncing APPLICATION the unit must run — always the receipt-owned copy at `<home>/bin/cosyncing`,
   * never the runtime that executes it and never the acquisition artifact.
   */
  executablePath: string;
  /** Acquisition application used only as immutable Windows staging input. */
  acquisitionExecutablePath?: string;
  /**
   * How that application was built, and therefore whether a runtime is mandatory.
   *
   * Required rather than inferred from the presence of `runtimePath`, because inferring it is exactly the
   * bug: a JavaScript install whose runtime failed validation would look identical to a native one and get
   * a native-shaped unit written for it.
   */
  distribution: DistributionKind;
  /**
   * The external runtime that must exec `executablePath`, for distributions that have one.
   *
   * Mandatory for every non-native distribution (a validated absolute Bun) and forbidden for a compiled
   * native build, which embeds its own. It is named explicitly in the unit rather than left to the
   * application's `#!/usr/bin/env bun` shebang, because the service PATH is deliberately restricted and
   * resolving the interpreter through it would make the broker's ability to start depend on PATH ordering.
   */
  runtimePath?: string;
  /**
   * Parent directories of supported agent executables resolved by setup/repair in the operator's shell.
   * These are the only interactive-PATH entries copied into the durable service environment.
   */
  agentExecutableDirectories?: readonly string[];
  /** Absolute executable overrides that supported adapters read instead of their conventional command name. */
  agentExecutableOverrides?: Readonly<ServiceAgentExecutableOverrides>;
  /** Explicit Pi/omp data-path overrides translated into disjoint durable variables. */
  agentDataPathOverrides?: Readonly<ServiceAgentDataPathOverrides>;
  /**
   * Flutter web root, resolved from the ACQUISITION executable. The unit execs the bootstrap copy, which has
   * no sidecar beside it, so the service can only find the web app if it is handed the path.
   */
  webDir: string;
  workingDirectory?: string;
  configHome?: string;
  runner?: ServiceCommandRunner;
  systemctlPath?: string;
  journalctlPath?: string;
  loginctlPath?: string;
  userIdentifier?: string;
}

/** Compatibility alias for external fixtures while the provider-neutral name rolls through the tree. */
export type SystemdProviderOptions = DurableServiceProviderOptions;

export interface LaunchdProviderOptions extends DurableServiceProviderOptions {
  launchctlPath?: string;
  tailPath?: string;
  /** Defaults to `<homeDir>/Library/LaunchAgents`. */
  launchAgentsHome?: string;
  /** Defaults to `<stateHome>/logs`, keeping service output inside the purge/receipt-covered state root. */
  logDirectory?: string;
}

/**
 * Await `work`, giving up after `timeoutMs` and resolving to `onDeadline` instead.
 *
 * The timer handle is held and cleared the moment either side settles. `Promise.race` does NOT cancel the
 * loser, so an armed `setTimeout`/`Bun.sleep` keeps the event loop alive until it fires: a CLI whose command
 * finished in milliseconds would still sit there for the whole deadline before the process could exit. That
 * is invisible in-process — every value is correct and returned promptly — and only shows up as wall time on
 * a short-lived command, which is exactly how it survived until a physical run measured it.
 */
export async function settleWithDeadline<T, D>(
  work: Promise<T>,
  timeoutMs: number,
  onDeadline: D,
): Promise<T | D> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<D>((resolve) => {
        deadline = setTimeout(() => resolve(onDeadline), Math.max(100, timeoutMs));
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

function boundedAppend(current: string, chunk: Uint8Array | string): string {
  const next = current + Buffer.from(chunk).toString('utf8');
  if (Buffer.byteLength(next) <= SERVICE_COMMAND_OUTPUT_LIMIT) return next;
  return Buffer.from(next).subarray(-SERVICE_COMMAND_OUTPUT_LIMIT).toString('utf8');
}

export function createServiceCommandRunner(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ServiceCommandRunner {
  return {
    async run(executable, args, timeoutMs = 15_000): Promise<ServiceCommandResult> {
      if (!isAbsolute(executable) || args.some((arg) => /[\0\r\n]/.test(arg))) {
        return { status: 'unavailable', stdout: '', stderr: '' };
      }
      let child: ReturnType<typeof Bun.spawn>;
      try {
        const invocation = resolveInvocation(executable, { env, platform: process.platform });
        if (!invocation) return { status: 'unavailable', stdout: '', stderr: '' };
        child = bunSpawnResolvedInvocation(invocation, args, {
          env: { ...env },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        });
      } catch {
        return { status: 'unavailable', stdout: '', stderr: '' };
      }
      let stdout = '';
      let stderr = '';
      const stdoutTask = (async () => {
        if (!(child.stdout instanceof ReadableStream)) return;
        const reader = child.stdout.getReader();
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            stdout = boundedAppend(stdout, next.value);
          }
        } finally {
          reader.releaseLock();
        }
      })();
      const stderrTask = (async () => {
        if (!(child.stderr instanceof ReadableStream)) return;
        const reader = child.stderr.getReader();
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            stderr = boundedAppend(stderr, next.value);
          }
        } finally {
          reader.releaseLock();
        }
      })();
      const completed = await settleWithDeadline(
        child.exited.then((exitCode) => ({ kind: 'exit' as const, exitCode })),
        timeoutMs,
        { kind: 'timeout' as const },
      );
      if (completed.kind === 'timeout') {
        child.kill('SIGKILL');
        await child.exited.catch(() => undefined);
        await Promise.allSettled([stdoutTask, stderrTask]);
        return { status: 'timeout', stdout, stderr };
      }
      await Promise.allSettled([stdoutTask, stderrTask]);
      return {
        status: completed.exitCode === 0 ? 'ok' : 'error',
        exitCode: completed.exitCode,
        stdout,
        stderr,
      };
    },
  };
}

/**
 * Every path this module writes into a service definition or its environment. `%` is a systemd specifier
 * marker and `:` is the PATH separator; neither has an escape where these paths land. Application identity
 * is intentionally platform-neutral, and these providers are also exported and constructible on their own,
 * so this serialization boundary refuses both independently — a runtime like `/tmp/a:b/bin/bun` must fail
 * here, not render a PATH whose directory silently split into two bogus entries.
 */
/**
 * `platform` defaults to the host so every existing caller keeps its behaviour, but callers that already
 * KNOW the platform must say so: the bare host `isAbsolute`/`resolve` treat a POSIX path on Windows as
 * absolute and then drive-qualify it, turning `/opt/x/bin/codex` into `C:\opt\x\bin\codex`. A caller
 * that went on to take its `posix.dirname` got `.`, and an agent executable was silently dropped from the
 * service set — a doctor check reporting an agent as not installed on a context that had just resolved it.
 */
function cleanAbsolutePath(value: string, label: string, platform: string = process.platform): string {
  const pathApi = platform === 'win32' ? win32 : posix;
  if (!pathApi.isAbsolute(value) || /[\0\r\n%:]/.test(value)) throw new Error(`invalid ${label} path`);
  return pathApi.resolve(value);
}

function cleanHostPath(value: string, label: string, platform: string): string {
  if (platform !== 'win32') return cleanAbsolutePath(value, label, platform);
  if (!win32.isAbsolute(value) || /[\0\r\n;]/.test(value)) throw new Error(`invalid ${label} path`);
  return win32.resolve(value);
}

/**
 * Quote a value for a directive systemd SPLITS INTO ARGUMENTS — `ExecStart=`, and the `Environment=` entries
 * of the environment file. Quoting is what keeps a value containing spaces a single argument there.
 *
 * `EnvironmentFile=` is NOT one of them: it takes one bare path and is rendered by `systemdBarePath` below.
 */
function systemdQuote(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error('invalid systemd value');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * Render a value for a directive that takes ONE bare path — `WorkingDirectory=`.
 *
 * These are not argument-split and are not unquoted: systemd hands the literal remainder of the line to its
 * path parser, so a quoted value arrives with the quote characters attached and is rejected as
 * "path is not absolute". Real systemd 255 refused every start with exactly that error. Spaces need no
 * escaping precisely because the whole remainder is the value; leading or trailing whitespace would be
 * absorbed, so it is refused rather than silently reinterpreted.
 */
function systemdBarePath(value: string): string {
  if (/[\0\r\n]/.test(value) || value !== value.trim() || value.length === 0) {
    throw new Error('invalid systemd path value');
  }
  return value;
}

function environmentLine(name: string, value: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error('invalid service environment name');
  return `${name}=${systemdQuote(value)}`;
}

function servicePathDirectory(value: string, platform: string = process.platform): string {
  // Refuse the selected platform's PATH separator before the directory reaches durable environment state.
  // The POSIX branch additionally rejects systemd's `%` specifier marker; a Windows drive colon is valid.
  return cleanHostPath(value, 'agent executable directory', platform);
}

export interface ServiceAgentExecutable {
  id: 'codex' | 'opencode' | 'pi' | 'claude';
  executablePath: string;
  directory: string;
  overrideVariable?: ServiceAgentExecutableOverrideName;
}

export const SERVICE_AGENT_EXECUTABLE_OVERRIDE_NAMES = [
  'COSYNCING_CODEX_BIN',
  'COSYNCING_CLAUDE_BIN',
  'COSYNCING_PI_BIN',
] as const;

export type ServiceAgentExecutableOverrideName = typeof SERVICE_AGENT_EXECUTABLE_OVERRIDE_NAMES[number];

export type ServiceAgentExecutableOverrides = Partial<Record<ServiceAgentExecutableOverrideName, string>>;

export const SERVICE_AGENT_DATA_PATH_OVERRIDE_NAMES = [
  'COSYNCING_PI_AGENT_DIR',
  'COSYNCING_OMP_AGENT_DIR',
  'COSYNCING_PI_SESSIONS_ROOT',
  'COSYNCING_OMP_SESSIONS_ROOT',
] as const;

export type ServiceAgentDataPathOverrideName = typeof SERVICE_AGENT_DATA_PATH_OVERRIDE_NAMES[number];
export type ServiceAgentDataPathOverrides = Partial<Record<ServiceAgentDataPathOverrideName, string>>;

/**
 * Translate explicit/shared Pi-family path inputs into durable dialect-specific variables. Omp's
 * PI_CONFIG_DIR and existing-XDG decisions must also be frozen here: the managed service deliberately
 * does not inherit either variable, so asking it to resolve those defaults again would move its files.
 */
export function serviceAgentDataPathOverrides(options: {
  env: Readonly<Record<string, string | undefined>>;
  piAgentDir: string;
  ompAgentDir: string;
  piSessionsRoot: string;
  ompSessionsRoot: string;
}): ServiceAgentDataPathOverrides {
  const set = (name: string) => !!options.env[name]?.trim();
  const ompUsesNativeDerivedPath = set('PI_CONFIG_DIR')
    || resolve(options.ompSessionsRoot) !== resolve(join(options.ompAgentDir, 'sessions'));
  return {
    ...(set('COSYNCING_PI_AGENT_DIR') || set('PI_CODING_AGENT_DIR')
      ? { COSYNCING_PI_AGENT_DIR: options.piAgentDir } : {}),
    ...(set('COSYNCING_OMP_AGENT_DIR') || set('PI_CODING_AGENT_DIR') || ompUsesNativeDerivedPath
      ? { COSYNCING_OMP_AGENT_DIR: options.ompAgentDir } : {}),
    ...(set('COSYNCING_PI_SESSIONS_ROOT') || set('PI_CODING_AGENT_SESSION_DIR')
      ? { COSYNCING_PI_SESSIONS_ROOT: options.piSessionsRoot } : {}),
    ...(set('COSYNCING_OMP_SESSIONS_ROOT') || set('PI_CODING_AGENT_SESSION_DIR') || ompUsesNativeDerivedPath
      ? { COSYNCING_OMP_SESSIONS_ROOT: options.ompSessionsRoot } : {}),
  };
}

function serviceEnvValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: string,
): string | undefined {
  if (platform !== 'win32') return env[name];
  const wanted = name.toLowerCase();
  for (const key of Object.keys(env).sort()) {
    if (key.toLowerCase() === wanted) return env[key];
  }
  return undefined;
}

function executableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep the command path the shell actually found, even when it is a symlink. Diagnosis canonicalizes that
 * path so it can inspect package metadata, but PATH needs the directory containing the command name/shim;
 * the real target may be `node_modules/.../cli.js`, whose directory has no `codex` command to find.
 */
function executableInvocationPath(
  command: string,
  canonicalExecutable: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: string = process.platform,
): string {
  const pathApi = platform === 'win32' ? win32 : posix;
  let canonical: string;
  try { canonical = realpathSync(canonicalExecutable); } catch { canonical = pathApi.resolve(canonicalExecutable); }
  const candidate = resolveInvocation(command, {
    env,
    platform,
    canonicalize: (path) => path,
  })?.originalPath;
  const candidates = candidate ? [candidate] : [];
  for (const candidate of candidates) {
    if (platform !== 'win32' && !executableFile(candidate)) continue;
    let target: string;
    try { target = realpathSync(candidate); } catch { target = pathApi.resolve(candidate); }
    if (target === canonical) return pathApi.resolve(candidate);
  }
  return canonical;
}

/**
 * Resolve only supported coding-agent commands from the interactive setup/repair context. The context's
 * resolver proves each result is an executable absolute path; this boundary revalidates the path shape
 * before any parent directory can enter a boot-service PATH. The whole interactive PATH is never copied.
 */
export function resolveServiceAgentExecutables(
  context: Pick<SetupDiagnosisContext, 'env' | 'resolveExecutable'> & { platform?: string },
): ServiceAgentExecutable[] {
  const platform = context.platform ?? process.platform;
  const pathApi = platform === 'win32' ? win32 : posix;
  const commands = [
    ['codex', serviceEnvValue(context.env, 'COSYNCING_CODEX_BIN', platform)?.trim() || 'codex', 'COSYNCING_CODEX_BIN'],
    ['opencode', 'opencode', undefined],
    ['pi', serviceEnvValue(context.env, 'COSYNCING_PI_BIN', platform)?.trim() || 'pi', 'COSYNCING_PI_BIN'],
    ['claude', serviceEnvValue(context.env, 'COSYNCING_CLAUDE_BIN', platform)?.trim() || 'claude', 'COSYNCING_CLAUDE_BIN'],
  ] as const;
  return commands.flatMap(([id, command, overrideVariable]): ServiceAgentExecutable[] => {
    const resolvedExecutable = context.resolveExecutable(command);
    if (!resolvedExecutable || !pathApi.isAbsolute(resolvedExecutable) || /[\0\r\n]/.test(resolvedExecutable)) return [];
    try {
      const cleanExecutable = cleanHostPath(
        executableInvocationPath(command, resolvedExecutable, context.env, platform),
        `${id} executable`,
        platform,
      );
      return [{
        id,
        executablePath: cleanExecutable,
        directory: servicePathDirectory(pathApi.dirname(cleanExecutable), platform),
        ...(overrideVariable && serviceEnvValue(context.env, overrideVariable, platform)?.trim()
          ? { overrideVariable }
          : {}),
      }];
    } catch {
      return [];
    }
  });
}

export function serviceAgentExecutableDirectories(
  context: Pick<SetupDiagnosisContext, 'env' | 'resolveExecutable'> & { platform?: string },
): string[] {
  const platform = context.platform ?? process.platform;
  const pathApi = platform === 'win32' ? win32 : posix;
  const executables = resolveServiceAgentExecutables(context);
  const directories = executables.map((agent) => agent.directory);
  if (executables.some((agent) => executableUsesEnvNode(agent.executablePath))) {
    const resolvedNode = context.resolveExecutable('node');
    if (resolvedNode && pathApi.isAbsolute(resolvedNode) && !/[\0\r\n]/.test(resolvedNode)) {
      try {
        const invocation = executableInvocationPath('node', resolvedNode, context.env, platform);
        // An npm launcher can live beside an older `node` binary after the user upgrades Node through a
        // different manager. Preserve the interpreter setup actually resolved: /usr/bin/env selects the
        // first match, so its directory must precede every launcher directory in the durable PATH.
        directories.unshift(servicePathDirectory(pathApi.dirname(invocation), platform));
      } catch {
        // A missing or unsafe interpreter stays absent. Doctor then reports
        // the agent runtime unavailable instead of copying arbitrary PATH.
      }
    }
  }
  return [...new Set(directories)];
}

/** Read only the bounded shebang needed to identify npm-style env-node shims. */
function executableUsesEnvNode(path: string): boolean {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    const prefix = Buffer.alloc(256);
    const length = readSync(descriptor, prefix, 0, prefix.length, 0);
    const firstLine = prefix.subarray(0, length).toString('utf8').split(/\r?\n/, 1)[0] ?? '';
    return /^#!\s*\/usr\/bin\/env(?:\s+-S)?\s+node(?:\s|$)/.test(firstLine);
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function serviceAgentExecutableOverrides(
  context: Pick<SetupDiagnosisContext, 'env' | 'resolveExecutable'> & { platform?: string },
): ServiceAgentExecutableOverrides {
  const overrides: ServiceAgentExecutableOverrides = {};
  for (const executable of resolveServiceAgentExecutables(context)) {
    if (executable.overrideVariable) overrides[executable.overrideVariable] = executable.executablePath;
  }
  return overrides;
}

export function servicePathEntries(
  homeDir: string,
  executablePath: string,
  agentExecutableDirectories: readonly string[],
  runtimePath?: string,
  platform: string = process.platform,
): string[] {
  const pathApi = platform === 'win32' ? win32 : posix;
  const entries = platform === 'win32' ? [
    ...agentExecutableDirectories.map((entry) => servicePathDirectory(entry, platform)),
    pathApi.dirname(executablePath),
    ...(runtimePath ? [pathApi.dirname(runtimePath)] : []),
  ] : [
    ...agentExecutableDirectories.map((entry) => servicePathDirectory(entry, platform)),
    join(homeDir, '.local', 'bin'),
    join(homeDir, 'bin'),
    join(homeDir, '.bun', 'bin'),
    join(homeDir, '.npm-global', 'bin'),
    dirname(executablePath),
    // The runtime's own directory. Not needed to START the broker — the unit execs Bun by absolute path —
    // but a version-manager Bun lives outside every fixed entry above, and without this a JavaScript install
    // would run the broker with a PATH that has no `bun` on it for the subprocesses it spawns. Still one
    // directory, still enumerated, still nothing like the interactive PATH.
    ...(runtimePath ? [dirname(runtimePath)] : []),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  return [...new Set(entries.map((entry) => cleanHostPath(entry, 'PATH entry', platform)))];
}

/** PATH is ordered state: equal membership with a different order can select a different interpreter. */
export function servicePathMatchesExpected(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return actual.length === expected.length
    && actual.every((entry, index) => entry === expected[index]);
}

function minimalServicePath(
  homeDir: string,
  executablePath: string,
  agentExecutableDirectories: readonly string[],
  runtimePath?: string,
  platform: string = process.platform,
): string {
  return servicePathEntries(homeDir, executablePath, agentExecutableDirectories, runtimePath, platform)
    .join(platform === 'win32' ? ';' : ':');
}

function serviceAgentOverrideEntries(
  overrides: Readonly<ServiceAgentExecutableOverrides>,
  platform: string = process.platform,
): Array<readonly [ServiceAgentExecutableOverrideName, string]> {
  return SERVICE_AGENT_EXECUTABLE_OVERRIDE_NAMES.flatMap((name) => {
    const executable = overrides[name];
    return executable ? [[name, cleanHostPath(executable, `${name} executable`, platform)] as const] : [];
  });
}

function serviceAgentDataPathOverrideEntries(
  overrides: Readonly<ServiceAgentDataPathOverrides>,
  platform: string = process.platform,
): Array<readonly [ServiceAgentDataPathOverrideName, string]> {
  return SERVICE_AGENT_DATA_PATH_OVERRIDE_NAMES.flatMap((name) => {
    const path = overrides[name];
    return path ? [[name, cleanHostPath(path, `${name} path`, platform)] as const] : [];
  });
}

/**
 * The exact, minimal environment a managed broker runs with. Both providers derive from this single list, so
 * the owner-only `service/broker.env` file and its `service-environment` receipt are byte-identical whichever
 * manager owns the host. `COSYNCING_SERVICE_PROVIDER` is deliberately absent: each provider stamps it into
 * its own definition (systemd `Environment=`, launchd `EnvironmentVariables`) so the marker cannot drift from
 * the manager that is actually running the process.
 */
export function brokerServiceEnvironmentEntries(options: {
  homeDir: string;
  stateHome: string;
  cacheRoot: string;
  executablePath: string;
  runtimePath?: string;
  agentExecutableDirectories?: readonly string[];
  agentExecutableOverrides?: Readonly<ServiceAgentExecutableOverrides>;
  /** Explicit Pi/omp data-path overrides translated into disjoint durable variables. */
  agentDataPathOverrides?: Readonly<ServiceAgentDataPathOverrides>;
  webDir: string;
  platform?: string;
}): Array<readonly [string, string]> {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === 'win32' ? win32 : posix;
  const stateHome = cleanHostPath(options.stateHome, 'state', platform);
  return [
    ['HOME', cleanHostPath(options.homeDir, 'home', platform)],
    ['PATH', minimalServicePath(
      options.homeDir,
      options.executablePath,
      options.agentExecutableDirectories ?? [],
      options.runtimePath,
      platform,
    )],
    ...serviceAgentOverrideEntries(options.agentExecutableOverrides ?? {}, platform),
    ...serviceAgentDataPathOverrideEntries(options.agentDataPathOverrides ?? {}, platform),
    ['COSYNCING_HOME', stateHome],
    ['COSYNCING_CACHE_DIR', cleanHostPath(options.cacheRoot, 'cache', platform)],
    ['COSYNCING_TOKEN_FILE', pathApi.join(stateHome, 'secrets', 'broker-token')],
    ['COSYNCING_PI_INTEGRATION_FILE', pathApi.join(stateHome, 'secrets', 'pi-integration.json')],
    ['COSYNCING_OMP_INTEGRATION_FILE', pathApi.join(stateHome, 'secrets', 'omp-integration.json')],
    // Not derivable inside the service. `executablePath` above is the bootstrap copy the unit execs, and no
    // web sidecar is ever placed beside it; the sidecar sits beside the acquisition executable, which is
    // exactly where setup measured it. Without this entry a packaged service install serves "no web app" on
    // a host where setup told the operator the app was there.
    ['COSYNCING_WEB_DIR', cleanHostPath(options.webDir, 'web', platform)],
    // Managed external hosts, on by default for the service the installer owns.
    //
    // The alternative was an installed broker that can see a `kimi web` or
    // `dsh web` host and use it, but cannot start one, recover a crashed one, or
    // stop the one it started — which is the same as those agents not working
    // unless the operator keeps a terminal open. Derived from what the adapters
    // declare, so this list does not need editing when one is added.
    ...managedHostServiceEnvironmentEntries(),
  ];
}

function renderEnvironmentFile(entries: ReadonlyArray<readonly [string, string]>): string {
  return `${entries.map(([name, value]) => environmentLine(name, value)).join('\n')}\n`;
}

/**
 * The ONE launch command both durable providers write.
 *
 * systemd renders it as an `ExecStart=` argument list and launchd as `ProgramArguments`, but the argv itself
 * is computed here so a Linux and a macOS install cannot disagree about whether the runtime is part of the
 * command. Every element is revalidated as an absolute path even though the caller resolved it: this is the
 * last boundary before the value becomes a file on disk that a service manager will exec.
 */
export function brokerServiceLaunchArgv(options: {
  executablePath: string;
  distribution: DistributionKind;
  runtimePath?: string;
}): string[] {
  const application = cleanAbsolutePath(options.executablePath, 'executable');
  if (options.distribution === 'native') {
    // A compiled build is its own interpreter. Naming a runtime for it would exec Bun against a native
    // executable, which is not a script, so the unit is refused rather than written.
    if (options.runtimePath) throw new Error('a native build has no external runtime to record');
    return [application, 'broker'];
  }
  // The fail-closed boundary. Omitting the runtime here does not produce a broken unit that reports an
  // error — it produces `ExecStart=<application> broker`, which is a VALID unit that resolves the
  // interpreter through the deliberately restricted service PATH via the `#!/usr/bin/env bun` shebang.
  // Setup would report success and the service would never start, so the definition is refused instead.
  if (!options.runtimePath) {
    throw new Error(`a ${options.distribution} build cannot be installed as a service without a validated Bun runtime`);
  }
  return [cleanAbsolutePath(options.runtimePath, 'runtime'), application, 'broker'];
}

/** XML text escaping for the plist. Control characters are refused rather than encoded. */
function plistText(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error('invalid launchd plist value');
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function renderPlistEnvironment(entries: ReadonlyArray<readonly [string, string]>): string {
  return entries.map(([name, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error('invalid service environment name');
    return `    <key>${name}</key>\n    <string>${plistText(value)}</string>`;
  }).join('\n');
}

/**
 * Read a top-level property out of `launchctl print` output.
 *
 * `print` nests sub-dictionaries (endpoints, sockets, spawn info) that reuse the SAME key names at deeper
 * indentation — notably an endpoint's `state = active`, which is not a job state at all. Matching the first
 * occurrence therefore reads whichever line happens to come first and silently mixes the two vocabularies.
 * Selecting the shallowest-indented match instead pins this to the job's own property regardless of how the
 * nested blocks are ordered or how deep they go.
 */
function launchdPrintProperty(stdout: string, key: string): string | undefined {
  const pattern = new RegExp(`^([ \\t]*)${key}[ \\t]*=[ \\t]*(.+)$`, 'gm');
  let shallowest: { indent: number; value: string } | undefined;
  for (const match of stdout.matchAll(pattern)) {
    const indent = match[1]!.length;
    if (!shallowest || indent < shallowest.indent) {
      shallowest = { indent, value: match[2]!.trim() };
    }
  }
  return shallowest?.value;
}

/**
 * Map one `launchctl print gui/<uid>/<label>` result onto the shared status vocabulary, defensively: any
 * output shape this does not recognise becomes `unknown` rather than a guess or a throw. launchd exits 113
 * ("Could not find service") for a job that is simply not bootstrapped — that is a fact, not a parse failure.
 *
 * `enabled` is derived from loadedness because `print` does not report the disable override; the provider
 * keeps that honest by booting the job out whenever it disables it.
 */
export function parseLaunchdPrintState(result: Readonly<ServiceCommandResult>): {
  enabled: DurableServiceStatus['enabled'];
  active: DurableServiceStatus['active'];
} {
  if (result.status === 'unavailable' || result.status === 'timeout') {
    return { enabled: 'unknown', active: 'unknown' };
  }
  if (result.status === 'error') {
    const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
    return result.exitCode === 113 || text.includes('could not find service')
      ? { enabled: 'disabled', active: 'inactive' }
      : { enabled: 'unknown', active: 'unknown' };
  }
  const state = launchdPrintProperty(result.stdout, 'state')?.toLowerCase();
  // A job that has not run yet reports `last exit code = (never exited)`. Only a real non-zero integer is
  // evidence of a crash; any non-numeric value means "no exit recorded", never a failure.
  const lastExit = launchdPrintProperty(result.stdout, 'last exit (?:code|status)');
  const crashed = !!lastExit && /^-?\d{1,10}$/.test(lastExit) && lastExit !== '0';
  // `spawn scheduled` is launchd holding a queued spawn intent: real, sometimes long-lived (a throttled
  // job sits there for its ThrottleInterval), and genuinely in-between — so it is transitional and the
  // wait loop polls through it rather than treating it as unknown. `spawn failed` is launchd reporting it
  // could not exec the program at all, which is terminal and maps to failed.
  const active: DurableServiceStatus['active'] = state === 'running'
    ? 'active'
    : state === 'not running'
      ? (crashed ? 'failed' : 'inactive')
      : state === 'waiting'
        ? (crashed ? 'failed' : 'transitioning')
        : state === 'spawn failed'
          ? 'failed'
          : state === 'spawn scheduled' || state === 'spawning' || state === 'exited'
            ? 'transitioning'
            : 'unknown';
  // A printable job is bootstrapped into the domain. Only an unparseable print leaves that unknown.
  return { enabled: state === undefined ? 'unknown' : 'enabled', active };
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function fileState(path: string, expected: string): DurableServiceStatus['definition'] {
  const inspection = inspectOwnerOnlyFile(path);
  if (inspection.status === 'missing') return 'missing';
  if (inspection.status !== 'ok') return 'unsafe';
  try {
    return readFileSync(path, 'utf8') === expected ? 'current' : 'drifted';
  } catch {
    return 'unsafe';
  }
}

function outputWord(result: ServiceCommandResult): string {
  return `${result.stdout}\n${result.stderr}`.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
}

function requireCommand(result: ServiceCommandResult, code: string): void {
  if (result.status !== 'ok') throw new Error(code);
}

export class SystemdUserServiceProvider implements DurableServiceProvider {
  readonly id = 'systemd' as const;
  readonly serviceName = SYSTEMD_SERVICE_NAME;
  readonly definitionPath: string;
  readonly environmentPath: string;
  readonly persistenceTarget: string;
  private readonly journalctlPath: string;
  private readonly systemctlPath: string;
  private readonly loginctlPath?: string;
  private readonly userIdentifier: string;
  private readonly runner: ServiceCommandRunner;
  private readonly definition: string;
  private readonly environment: string;

  constructor(readonly options: DurableServiceProviderOptions) {
    const configHome = options.configHome?.trim()
      || options.context.env.XDG_CONFIG_HOME?.trim()
      || join(options.homeDir, '.config');
    this.definitionPath = join(cleanAbsolutePath(configHome, 'configuration'), 'systemd', 'user', SYSTEMD_SERVICE_NAME);
    this.environmentPath = join(cleanAbsolutePath(options.stateHome, 'state'), 'service', 'broker.env');
    this.systemctlPath = cleanAbsolutePath(
      options.systemctlPath ?? options.context.resolveExecutable('systemctl') ?? '/usr/bin/systemctl',
      'systemctl',
    );
    const loginctl = options.loginctlPath ?? options.context.resolveExecutable('loginctl');
    this.loginctlPath = loginctl ? cleanAbsolutePath(loginctl, 'loginctl') : undefined;
    const userIdentifier = options.userIdentifier
      ?? (typeof process.getuid === 'function' ? String(process.getuid()) : options.context.env.USER?.trim());
    if (!userIdentifier || !/^[A-Za-z0-9._-]{1,128}$/.test(userIdentifier)) {
      throw new Error('invalid service user identifier');
    }
    this.userIdentifier = userIdentifier;
    this.persistenceTarget = `systemd-user-linger:${userIdentifier}`;
    this.journalctlPath = cleanAbsolutePath(
      options.journalctlPath ?? options.context.resolveExecutable('journalctl') ?? '/usr/bin/journalctl',
      'journalctl',
    );
    this.runner = options.runner ?? createServiceCommandRunner(options.context.env);
    const executable = cleanAbsolutePath(options.executablePath, 'executable');
    const launchArgv = brokerServiceLaunchArgv(options);
    const workingDirectory = cleanAbsolutePath(options.workingDirectory ?? options.homeDir, 'working directory');
    this.environment = renderEnvironmentFile(brokerServiceEnvironmentEntries({
      homeDir: options.homeDir,
      stateHome: options.stateHome,
      cacheRoot: options.cacheRoot,
      executablePath: executable,
      ...(options.runtimePath ? { runtimePath: options.runtimePath } : {}),
      agentExecutableDirectories: options.agentExecutableDirectories,
      agentExecutableOverrides: options.agentExecutableOverrides,
      agentDataPathOverrides: options.agentDataPathOverrides,
      webDir: options.webDir,
    }));
    const template = embeddedRuntimeAsset('service/systemd/cosyncing.service').content;
    if (template == null) throw new Error('systemd service template is unavailable');
    this.definition = template
      .replaceAll('{{PRODUCT_NAME}}', PRODUCT_IDENTITY.productName)
      // ExecStart= is argument-split, so every element is quoted individually; a JavaScript install renders
      // `"<bun>" "<application>" "broker"` and a native one renders `"<executable>" "broker"`.
      .replaceAll('{{EXEC_START}}', launchArgv.map(systemdQuote).join(' '))
      .replaceAll('{{WORKING_DIRECTORY}}', systemdBarePath(workingDirectory))
      // Bare, like WorkingDirectory. A quoted EnvironmentFile= is worse than a fatal error: systemd logs
      // "path is not absolute, ignoring" and starts the unit anyway, so the broker would come up with none
      // of its environment — no COSYNCING_HOME, no token file — instead of failing loudly.
      .replaceAll('{{ENVIRONMENT_FILE}}', systemdBarePath(this.environmentPath));
    if (this.definition.includes('{{')) throw new Error('systemd template placeholder remains unresolved');
  }

  expectedDefinition(): string { return this.definition; }
  expectedEnvironment(): string { return this.environment; }

  logsCommand(request: Readonly<ServiceLogsRequest>): readonly string[] {
    return request.follow
      ? [this.journalctlPath, '--user', '-u', SYSTEMD_SERVICE_NAME, '-f']
      : [this.journalctlPath, '--user', '-u', SYSTEMD_SERVICE_NAME, '-n', String(request.lines), '--no-pager'];
  }

  private async systemctl(
    args: readonly string[],
    timeoutMs?: number,
  ): Promise<ServiceCommandResult> {
    return this.runner.run(this.systemctlPath, ['--user', ...args], timeoutMs);
  }

  private async loginctl(args: readonly string[]): Promise<ServiceCommandResult> {
    if (!this.loginctlPath) return { status: 'unavailable', stdout: '', stderr: '' };
    return this.runner.run(this.loginctlPath, args);
  }

  async inspect(): Promise<DurableServiceStatus> {
    const [enabledResult, activeResult, lingerResult] = await Promise.all([
      this.systemctl(['is-enabled', SYSTEMD_SERVICE_NAME]),
      this.systemctl(['is-active', SYSTEMD_SERVICE_NAME]),
      this.loginctl(['show-user', this.userIdentifier, '--property=Linger', '--value']),
    ]);
    const enabledWord = outputWord(enabledResult);
    const activeWord = outputWord(activeResult);
    const lingerWord = outputWord(lingerResult);
    return {
      provider: 'systemd',
      supported: enabledResult.status !== 'unavailable' && activeResult.status !== 'unavailable',
      definition: fileState(this.definitionPath, this.definition),
      environment: fileState(this.environmentPath, this.environment),
      enabled: enabledWord === 'enabled' || enabledWord === 'static'
        ? 'enabled'
        : enabledWord === 'disabled' || enabledWord === 'not-found' ? 'disabled' : 'unknown',
      active: activeWord === 'active'
        ? 'active'
        : activeWord === 'inactive' ? 'inactive'
            : activeWord === 'failed' ? 'failed'
            : activeWord === 'activating' || activeWord === 'deactivating' ? 'transitioning' : 'unknown',
      lingering: lingerResult.status === 'unavailable'
        ? 'unknown'
        : ['yes', 'true', '1'].includes(lingerWord) ? 'enabled'
          : ['no', 'false', '0'].includes(lingerWord) ? 'disabled' : 'unknown',
    };
  }

  async installDefinition(): Promise<void> {
    atomicWriteOwnerOnly(this.environmentPath, this.environment, { mode: 0o600 });
    atomicWriteOwnerOnly(this.definitionPath, this.definition, { mode: 0o600 });
    await this.reloadDefinition();
    await this.setEnabled(true);
  }

  async reloadDefinition(): Promise<void> {
    requireCommand(await this.systemctl(['daemon-reload']), 'systemd-daemon-reload-failed');
  }

  async setEnabled(enabled: boolean): Promise<void> {
    requireCommand(
      await this.systemctl([enabled ? 'enable' : 'disable', SYSTEMD_SERVICE_NAME]),
      enabled ? 'systemd-enable-failed' : 'systemd-disable-failed',
    );
  }

  async enableLingering(): Promise<void> {
    requireCommand(await this.loginctl(['enable-linger', this.userIdentifier]), 'systemd-enable-linger-failed');
  }

  async disableLingering(): Promise<void> {
    requireCommand(await this.loginctl(['disable-linger', this.userIdentifier]), 'systemd-disable-linger-failed');
  }

  async start(): Promise<void> {
    requireCommand(await this.systemctl(['start', SYSTEMD_SERVICE_NAME]), 'systemd-start-failed');
  }

  async stop(): Promise<void> {
    const status = await this.inspect();
    if (status.active === 'inactive') return;
    requireCommand(
      await this.systemctl(['stop', SYSTEMD_SERVICE_NAME], SYSTEMD_MUTATION_TIMEOUT_MS),
      'systemd-stop-failed',
    );
  }

  async restart(): Promise<void> {
    requireCommand(
      await this.systemctl(['restart', SYSTEMD_SERVICE_NAME], SYSTEMD_MUTATION_TIMEOUT_MS),
      'systemd-restart-failed',
    );
  }

  async uninstall(): Promise<void> {
    await this.systemctl(
      ['disable', '--now', SYSTEMD_SERVICE_NAME],
      SYSTEMD_MUTATION_TIMEOUT_MS,
    );
    for (const path of [this.definitionPath, this.environmentPath]) {
      if (!existsSync(path)) continue;
      assertNoSymlinkComponents(path, false);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('unsafe service uninstall target');
      unlinkSync(path);
    }
    await this.reloadDefinition();
  }
}

/**
 * macOS LaunchAgent provider. It owns exactly one plist in `~/Library/LaunchAgents` and drives it through the
 * modern `launchctl` domain verbs against `gui/<uid>` — the per-user GUI domain, which exists from GUI login
 * to logout. That is the honest limit of this provider: there is no lingering to enable, and cosyncing does
 * NOT emulate boot persistence with a root LaunchDaemon (that would run the broker outside the user's own
 * session and privileges). `lingering` is reported `unsupported` and the setup wizard never offers it.
 *
 * Log retention: launchd writes StandardOutPath/StandardErrorPath and never rotates them. They are placed
 * inside the state root so purge and receipts already cover them, and `logs` only ever reads a bounded tail.
 */
export class LaunchdUserServiceProvider implements DurableServiceProvider {
  readonly id = 'launchd' as const;
  readonly serviceName = LAUNCHD_SERVICE_LABEL;
  readonly definitionPath: string;
  readonly environmentPath: string;
  readonly persistenceTarget: string;
  readonly logDirectory: string;
  readonly standardOutPath: string;
  readonly standardErrorPath: string;
  private readonly launchctlPath: string;
  private readonly tailPath: string;
  private readonly domainTarget: string;
  private readonly serviceTarget: string;
  private readonly runner: ServiceCommandRunner;
  private readonly definition: string;
  private readonly environment: string;

  constructor(readonly options: LaunchdProviderOptions) {
    const homeDir = cleanAbsolutePath(options.homeDir, 'home');
    const stateHome = cleanAbsolutePath(options.stateHome, 'state');
    this.definitionPath = join(
      cleanAbsolutePath(options.launchAgentsHome ?? join(homeDir, 'Library', 'LaunchAgents'), 'LaunchAgents'),
      LAUNCHD_SERVICE_FILENAME,
    );
    this.environmentPath = join(stateHome, 'service', 'broker.env');
    this.logDirectory = cleanAbsolutePath(options.logDirectory ?? join(stateHome, 'logs'), 'log directory');
    this.standardOutPath = join(this.logDirectory, 'broker.out.log');
    this.standardErrorPath = join(this.logDirectory, 'broker.err.log');
    this.launchctlPath = cleanAbsolutePath(
      options.launchctlPath ?? options.context.resolveExecutable('launchctl') ?? '/bin/launchctl',
      'launchctl',
    );
    this.tailPath = cleanAbsolutePath(
      options.tailPath ?? options.context.resolveExecutable('tail') ?? '/usr/bin/tail',
      'tail',
    );
    // The gui domain is addressed by numeric uid only; a username would silently target nothing.
    const userIdentifier = options.userIdentifier
      ?? (typeof process.getuid === 'function' ? String(process.getuid()) : '');
    if (!/^\d{1,10}$/.test(userIdentifier)) throw new Error('invalid launchd gui domain user identifier');
    this.domainTarget = `gui/${userIdentifier}`;
    this.serviceTarget = `${this.domainTarget}/${LAUNCHD_SERVICE_LABEL}`;
    this.persistenceTarget = `launchd-gui-session:${userIdentifier}`;
    this.runner = options.runner ?? createServiceCommandRunner(options.context.env);
    const executable = cleanAbsolutePath(options.executablePath, 'executable');
    const launchArgv = brokerServiceLaunchArgv(options);
    const workingDirectory = cleanAbsolutePath(options.workingDirectory ?? homeDir, 'working directory');
    const entries = brokerServiceEnvironmentEntries({
      homeDir,
      stateHome,
      cacheRoot: options.cacheRoot,
      executablePath: executable,
      ...(options.runtimePath ? { runtimePath: options.runtimePath } : {}),
      agentExecutableDirectories: options.agentExecutableDirectories,
      agentExecutableOverrides: options.agentExecutableOverrides,
      agentDataPathOverrides: options.agentDataPathOverrides,
      webDir: options.webDir,
    });
    // The env file is the receipt-owned source of truth for what the service environment IS; launchd has no
    // EnvironmentFile, so the identical pairs are also materialized into the plist, which is what takes
    // effect. Drift in either one shows up as a non-'current' status and repair rewrites both together.
    this.environment = renderEnvironmentFile(entries);
    const template = embeddedRuntimeAsset('service/launchd/cosyncing.plist').content;
    if (template == null) throw new Error('launchd service template is unavailable');
    this.definition = template
      .replaceAll('{{LABEL}}', plistText(LAUNCHD_SERVICE_LABEL))
      // Same argv systemd renders, in launchd's own array form: one <string> per argument, so a path
      // containing spaces stays one argument here exactly as quoting keeps it one there.
      .replaceAll(
        '{{PROGRAM_ARGUMENTS}}',
        launchArgv.map((argument) => `    <string>${plistText(argument)}</string>`).join('\n'),
      )
      .replaceAll('{{WORKING_DIRECTORY}}', plistText(workingDirectory))
      .replaceAll('{{ENVIRONMENT_VARIABLES}}', renderPlistEnvironment([
        ...entries,
        ['COSYNCING_SERVICE_PROVIDER', 'launchd'],
      ]))
      .replaceAll('{{STANDARD_OUT_PATH}}', plistText(this.standardOutPath))
      .replaceAll('{{STANDARD_ERROR_PATH}}', plistText(this.standardErrorPath));
    if (this.definition.includes('{{')) throw new Error('launchd template placeholder remains unresolved');
  }

  expectedDefinition(): string { return this.definition; }
  expectedEnvironment(): string { return this.environment; }

  logsCommand(request: Readonly<ServiceLogsRequest>): readonly string[] {
    return [
      this.tailPath,
      ...(request.follow ? ['-f'] : []),
      '-n',
      String(request.lines),
      this.standardOutPath,
      this.standardErrorPath,
    ];
  }

  private async launchctl(args: readonly string[], timeoutMs?: number): Promise<ServiceCommandResult> {
    return this.runner.run(this.launchctlPath, args, timeoutMs);
  }

  /**
   * `launchctl bootout` acknowledges the request before the label necessarily leaves the GUI domain. A
   * bootstrap issued in that window fails because launchd still considers the old label loaded. Poll the
   * domain membership itself—not merely process activity, since an inactive-but-loaded job still blocks a
   * replacement—and keep the whole transition bounded.
   */
  private async awaitUnloaded(): Promise<void> {
    const deadline = Date.now() + SERVICE_TRANSITION_TIMEOUT_MS;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('launchd-bootout-timeout');
      const printed = await this.launchctl(
        ['print', this.serviceTarget],
        Math.min(LAUNCHD_PRINT_TIMEOUT_MS, remaining),
      );
      const state = parseLaunchdPrintState(printed);
      if (state.enabled === 'disabled' && state.active === 'inactive') return;
      const waitMs = Math.min(100, deadline - Date.now());
      if (waitMs <= 0) throw new Error('launchd-bootout-timeout');
      await Bun.sleep(waitMs);
    }
  }

  async inspect(): Promise<DurableServiceStatus> {
    // A read-only probe runs inside polling loops, so it gets its own shorter deadline: a wedged `print`
    // must degrade to `unknown` and be retried, not stall a lifecycle command for the full command timeout.
    const printed = await this.launchctl(['print', this.serviceTarget], LAUNCHD_PRINT_TIMEOUT_MS);
    const state = parseLaunchdPrintState(printed);
    return {
      provider: 'launchd',
      supported: printed.status !== 'unavailable',
      definition: fileState(this.definitionPath, this.definition),
      environment: fileState(this.environmentPath, this.environment),
      enabled: state.enabled,
      active: state.active,
      lingering: 'unsupported',
    };
  }

  async installDefinition(): Promise<void> {
    atomicWriteOwnerOnly(this.environmentPath, this.environment, { mode: 0o600 });
    atomicWriteOwnerOnly(this.definitionPath, this.definition, { mode: 0o600 });
    // launchd refuses to start a job whose StandardOutPath directory does not exist.
    ensureOwnerOnlyDirectory(this.logDirectory);
    // Boot out any stale copy first: bootstrap on an already-loaded label fails, and a reload must pick up
    // the plist just written. A job that was never loaded makes this a tolerated no-op.
    await this.launchctl(['bootout', this.serviceTarget]);
    await this.awaitUnloaded();
    requireCommand(await this.launchctl(['enable', this.serviceTarget]), 'launchd-enable-failed');
    requireCommand(
      await this.launchctl(['bootstrap', this.domainTarget, this.definitionPath]),
      'launchd-bootstrap-failed',
    );
  }

  /** Re-read the on-disk definition. With the plist gone (uninstall/rollback) this only boots the job out. */
  async reloadDefinition(): Promise<void> {
    await this.launchctl(['bootout', this.serviceTarget]);
    await this.awaitUnloaded();
    if (!existsSync(this.definitionPath)) return;
    requireCommand(
      await this.launchctl(['bootstrap', this.domainTarget, this.definitionPath]),
      'launchd-bootstrap-failed',
    );
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (!enabled) {
      // Boot out before disabling so the reported status actually follows: `launchctl print` reports a loaded
      // job whether or not the domain's disable override is set.
      await this.launchctl(['bootout', this.serviceTarget]);
      requireCommand(await this.launchctl(['disable', this.serviceTarget]), 'launchd-disable-failed');
      return;
    }
    requireCommand(await this.launchctl(['enable', this.serviceTarget]), 'launchd-enable-failed');
    if ((await this.inspect()).enabled === 'enabled') return;
    requireCommand(
      await this.launchctl(['bootstrap', this.domainTarget, this.definitionPath]),
      'launchd-bootstrap-failed',
    );
  }

  async enableLingering(): Promise<void> { throw new Error('launchd-lingering-unsupported'); }
  async disableLingering(): Promise<void> { throw new Error('launchd-lingering-unsupported'); }

  async start(): Promise<void> {
    requireCommand(await this.launchctl(['kickstart', this.serviceTarget]), 'launchd-start-failed');
  }

  /** SIGTERM, not bootout: the job stays loaded, and KeepAlive{SuccessfulExit:false} leaves a clean exit down. */
  async stop(): Promise<void> {
    const status = await this.inspect();
    if (status.active === 'inactive') return;
    const killed = await this.launchctl(['kill', 'SIGTERM', this.serviceTarget]);
    // `launchctl kill` fails when the job holds no live process — a job launchd has only SCHEDULED, or one
    // that exited between the probe above and this call. That is not a stop failure: the job is already not
    // running, which is what was asked for. Only a genuine command failure is escalated.
    if (killed.status === 'ok') return;
    if ((await this.inspect()).active === 'inactive') return;
    throw new Error('launchd-stop-failed');
  }

  async restart(): Promise<void> {
    requireCommand(await this.launchctl(['kickstart', '-k', this.serviceTarget]), 'launchd-restart-failed');
  }

  async uninstall(): Promise<void> {
    await this.launchctl(['bootout', this.serviceTarget]);
    for (const path of [this.definitionPath, this.environmentPath]) {
      if (!existsSync(path)) continue;
      assertNoSymlinkComponents(path, false);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('unsafe service uninstall target');
      unlinkSync(path);
    }
  }
}

interface DurableServiceRollbackData extends Record<string, unknown> {
  files: SetupRollbackRecord;
  wasEnabled: boolean;
  wasActive: boolean;
  lingering: 'enabled' | 'disabled' | 'unknown';
  providerState?: Record<string, unknown>;
}

function serviceRollback(record: Readonly<SetupRollbackRecord>): DurableServiceRollbackData {
  if (record.kind !== 'systemd-service-v1' || !record.data.files
      || typeof record.data.wasEnabled !== 'boolean' || typeof record.data.wasActive !== 'boolean'
      || !['enabled', 'disabled', 'unknown'].includes(String(record.data.lingering))
      || (record.data.providerState !== undefined
        && (!record.data.providerState || typeof record.data.providerState !== 'object'
          || Array.isArray(record.data.providerState)))) {
    throw new Error('invalid systemd rollback record');
  }
  return record.data as DurableServiceRollbackData;
}

export interface DurableServiceSetupActionOptions {
  desired: 'installed' | 'absent';
  enableLingering: boolean;
  lingeringAlreadyOwned: boolean;
}

/** Compatibility alias for callers that still use the pre-Phase-4 API name. */
export type SystemdSetupActionOptions = DurableServiceSetupActionOptions;

/** `service-systemd` / `service-launchd`: the receipt naming the definition file this provider owns. */
export function serviceDefinitionResourceId(provider: Pick<DurableServiceProvider, 'id'>): string {
  return `service-${provider.id}`;
}

/** Every receipt id a durable-service install can commit; setup/uninstall drop them together. */
export const SERVICE_RESOURCE_IDS: readonly string[] = Object.freeze([
  'service-systemd',
  'service-launchd',
  'service-task-scheduler',
  'service-task-scheduler-sid-folder',
  'service-task-scheduler-shared-folder',
  'service-windows-bootstrap',
  'service-windows-active-install',
  'service-windows-version',
  'service-environment',
  'service-systemd-linger',
]);

/**
 * The durable provider this host can own. Chosen by platform, not by preference: launchd is the only user
 * service manager on darwin, and systemd is the only one v1 supports on linux.
 */
export function durableServiceProviderId(platform: string): DurableServiceProviderId {
  return platform === 'win32' ? 'task-scheduler' : platform === 'darwin' ? 'launchd' : 'systemd';
}

export function createDurableServiceProvider(options: DurableServiceProviderOptions): DurableServiceProvider {
  const provider = durableServiceProviderId(options.context.platform);
  if (provider === 'launchd') return new LaunchdUserServiceProvider(options);
  if (provider === 'systemd') return new SystemdUserServiceProvider(options);
  if (!options.versionKey) throw new Error('Task Scheduler provider requires a version key');
  const paths = windowsServiceInstallPaths(options.stateHome, options.versionKey);
  return new WindowsTaskSchedulerServiceProvider({
    ...options,
    versionKey: options.versionKey,
    environmentEntries: brokerServiceEnvironmentEntries({
      homeDir: options.homeDir,
      stateHome: options.stateHome,
      cacheRoot: options.cacheRoot,
      executablePath: paths.applicationPath,
      runtimePath: options.runtimePath,
      agentExecutableDirectories: options.agentExecutableDirectories,
      agentExecutableOverrides: options.agentExecutableOverrides,
      agentDataPathOverrides: options.agentDataPathOverrides,
      webDir: paths.webRoot,
      platform: 'win32',
    }),
  });
}

export function createDurableServiceSetupAction(
  provider: DurableServiceProvider,
  options: Readonly<DurableServiceSetupActionOptions>,
): SetupTransactionAction {
  return {
    id: 'service.systemd',
    async prepare(context) {
      const status = await provider.inspect();
      const providerState = await provider.captureTransactionState?.();
      return {
        kind: 'systemd-service-v1',
        data: {
          files: snapshotSetupFiles(
            context,
            'service.systemd',
            provider.transactionFilePaths?.() ?? [provider.definitionPath, provider.environmentPath],
          ),
          wasEnabled: status.enabled === 'enabled',
          wasActive: status.active === 'active',
          lingering: status.lingering === 'enabled' || status.lingering === 'disabled'
            ? status.lingering
            : 'unknown',
          ...(providerState ? { providerState } : {}),
        } satisfies DurableServiceRollbackData,
      };
    },
    async apply() {
      const status = await provider.inspect();
      if (status.active === 'active' || status.active === 'failed' || status.active === 'transitioning') {
        await provider.stop();
      }
      if (options.desired === 'absent') {
        await provider.uninstall();
        if (options.lingeringAlreadyOwned && status.lingering === 'enabled') {
          await provider.disableLingering();
        }
        return { resources: [] };
      }
      await provider.installDefinition();
      const enabledLingeringNow = options.enableLingering && status.lingering === 'disabled';
      if (enabledLingeringNow) await provider.enableLingering();
      return {
        resources: provider.installedResources?.() ?? [
          {
            id: serviceDefinitionResourceId(provider),
            kind: 'service',
            target: provider.definitionPath,
            ownership: { proof: 'package-hash', installedSha256: hash(provider.expectedDefinition()) },
          },
          {
            id: 'service-environment',
            kind: 'environment-file',
            target: provider.environmentPath,
            ownership: { proof: 'package-hash', installedSha256: hash(provider.expectedEnvironment()) },
          },
          ...((options.lingeringAlreadyOwned || enabledLingeringNow) ? [{
            id: 'service-systemd-linger',
            kind: 'other' as const,
            target: provider.persistenceTarget,
            ownership: { proof: 'receipt' as const },
          }] : []),
        ] satisfies InstalledResourceRecord[],
      };
    },
    async verify() {
      const status = await provider.inspect();
      if (options.desired === 'absent') {
        return status.supported && status.definition === 'missing' && status.environment === 'missing'
          && status.enabled === 'disabled' && status.active === 'inactive'
          && (!options.lingeringAlreadyOwned || status.lingering === 'disabled');
      }
      // `launchctl bootstrap` loads AND (RunAtLoad) starts the job in one step, so an active job right after
      // apply is the expected launchd posture. systemd's `enable` never starts, so an active unit there still
      // means a racing writer and must fail the check.
      const startsWhenInstalled = provider.id === 'launchd';
      return status.supported && status.definition === 'current' && status.environment === 'current'
        && status.enabled === 'enabled'
        && (startsWhenInstalled || status.active !== 'active') && status.active !== 'failed'
        && (!options.enableLingering || status.lingering === 'enabled');
    },
    async rollback(_context, record) {
      const prior = serviceRollback(record);
      await provider.stop();
      await provider.uninstall();
      rollbackSetupFiles(prior.files);
      if (provider.restoreTransactionState && prior.providerState) {
        await provider.restoreTransactionState(prior.providerState);
      } else {
        await provider.reloadDefinition();
      }
      const restored = await provider.inspect();
      // Nothing was on disk before this transaction, so there is no posture to restore: uninstall plus the
      // file rollback already left the host as it was, and enable/disable against an absent definition only
      // errors. Bail before touching the manager.
      if (restored.definition !== 'missing') {
        // Reloading is NOT posture-neutral on every provider. launchd's reload bootstraps the restored plist
        // and RunAtLoad starts the job as part of loading it, so a prior disabled or inactive posture would
        // silently come back enabled and running. Both states are therefore re-asserted in both directions
        // rather than assumed to have survived, and each is driven to the exact recorded value.
        if (prior.wasEnabled !== (restored.enabled === 'enabled')) await provider.setEnabled(prior.wasEnabled);
        const afterEnable = await provider.inspect();
        if (prior.wasActive) {
          if (afterEnable.active !== 'active') await provider.start();
          await awaitServiceState({ provider, expected: 'active' });
        } else if (afterEnable.active !== 'inactive') {
          // Loading the definition can START the job (launchd honours RunAtLoad on bootstrap), and the
          // spawn is asynchronous. Signalling it mid-spawn is what left a Mac stuck in `spawn scheduled`:
          // launchctl kill finds no process yet, launchd keeps the queued spawn intent, and a broker killed
          // before it installs its SIGTERM handler dies BY SIGNAL — which KeepAlive{SuccessfulExit:false}
          // treats as a crash and restarts. Let the spawn finish first, then stop a fully-started broker,
          // which exits 0 and stays down. Waiting also short-circuits on `failed`, so a job that cannot
          // start is not waited out twice.
          await awaitServiceState({ provider, expected: 'active' });
          await provider.stop();
          await awaitServiceState({ provider, expected: 'inactive' });
        }
        // A rollback that cannot reach the recorded posture must say so rather than report success and
        // leave the operator with a service in a state no journal describes.
        const settled = await provider.inspect();
        if (settled.enabled !== (prior.wasEnabled ? 'enabled' : 'disabled')
            || settled.active !== (prior.wasActive ? 'active' : 'inactive')) {
          throw new Error('service-rollback-posture-unrestored');
        }
      }
      const current = await provider.inspect();
      if (prior.lingering === 'enabled' && current.lingering === 'disabled') await provider.enableLingering();
      if (prior.lingering === 'disabled' && current.lingering === 'enabled') await provider.disableLingering();
    },
  };
}

/**
 * Legacy API alias. The action id and rollback kind remain systemd-shaped on purpose: they are persisted
 * journal identifiers, not descriptions of the selected provider. Changing them requires a versioned
 * recovery migration for transactions written by older releases.
 */
export const createSystemdSetupAction = createDurableServiceSetupAction;

/**
 * Wait for a just-issued lifecycle command to actually reach its target state.
 *
 * This exists because the two providers differ in when their verbs return. `systemctl start/stop/restart`
 * block until the job transition completes, so a single sample immediately afterwards was always correct on
 * Linux. launchd's verbs do NOT block: `kickstart` returns once the spawn is requested and `kill` returns
 * once the signal is delivered, both well before the process has bound its port or exited. Sampling once at
 * that moment reads the PRE-transition state and reports failure for a command that in fact succeeded.
 *
 * Polling costs systemd nothing — it satisfies the check on the first sample — and it is the only correct
 * shape for launchd. `failed` short-circuits so a crash-looping job is reported promptly instead of after
 * the full deadline, and an `unknown` sample (a wedged or unparseable probe) simply retries.
 *
 * The bound is wall-clock, not just an attempt count: each probe can itself burn its own command deadline,
 * so counting attempts alone would let a wedged `launchctl` stretch one lifecycle command into minutes
 * (40 probes x a 5s print deadline). The attempt count remains as a secondary cap for fast probes.
 */
export async function awaitServiceState(options: {
  provider: DurableServiceProvider;
  expected: 'active' | 'inactive';
  attempts?: number;
  delayMs?: number;
  timeoutMs?: number;
}): Promise<DurableServiceStatus> {
  const attempts = Math.max(1, options.attempts ?? 40);
  const delayMs = Math.max(1, options.delayMs ?? 250);
  const deadline = Date.now() + Math.max(1, options.timeoutMs ?? SERVICE_TRANSITION_TIMEOUT_MS);
  let status = await options.provider.inspect();
  for (let index = 1; index < attempts && status.active !== options.expected; index += 1) {
    if (options.expected === 'active' && status.active === 'failed') return status;
    if (Date.now() >= deadline) return status;
    await Bun.sleep(delayMs);
    status = await options.provider.inspect();
  }
  return status;
}

/**
 * Post-commit service verification. It reports WHY it gave up, not just that it did: this is the check that
 * failed on a physical Linux install, and a bare `false` reached the operator as "setup failed" with nothing
 * naming the service, its posture, or the health probe that never answered.
 */
export interface ServiceStartVerification {
  ok: boolean;
  /** Operator-facing reason, present only when `ok` is false. */
  detail?: string;
}

/**
 * A healthy `ok: true` proves only that SOMETHING is answering the broker port — and after a binary
 * replacement the most likely something is the previous build, whose process survives the file swap and
 * keeps serving until the unit is actually restarted. Binding the responder's reported build identity to
 * the installed one is what makes this check proof about the running PROCESS rather than about the port.
 *
 * @param expectedBuild the BuildInfo of the artifact setup just installed at the unit's ExecStart path.
 *   The whole record is taken rather than a field or two because no single field identifies a build: a
 *   release cycle shares one semver, and two binaries from one commit still differ across dirty/clean,
 *   target, packaged, and build date. {@link buildFingerprint} is the one definition of that identity and
 *   is what `/api/health` reports, so the surface and this check cannot drift into two field lists.
 *   Compared verbatim — both sides are the same function over the same stamped record, so normalizing here
 *   could only mask a genuine mismatch.
 */
export async function startAndVerifyDurableService(options: {
  provider: DurableServiceProvider;
  context: SetupDiagnosisContext;
  internalUrl: string;
  healthHeaders?: Readonly<Record<string, string>>;
  expectedBuild: Readonly<Omit<BuildInfo, 'schemaVersions' | 'contract'>>;
  attempts?: number;
}): Promise<ServiceStartVerification> {
  await options.provider.start();
  const attempts = Math.max(1, options.attempts ?? 30);
  const expected = buildFingerprint(options.expectedBuild);
  let lastActive: DurableServiceStatus['active'] = 'unknown';
  let lastHealth = 'not-probed';
  let lastBuild = 'not-reported';
  for (let index = 0; index < attempts; index += 1) {
    const [status, health] = await Promise.all([
      options.provider.inspect(),
      options.context.fetchJson(
        new URL('/api/health', options.internalUrl).toString(),
        options.healthHeaders,
      ),
    ]);
    const body = health.status === 'ok' && health.json && typeof health.json === 'object' && !Array.isArray(health.json)
      ? health.json as Record<string, unknown>
      : {};
    const healthy = body.ok === true;
    const answered = typeof body.buildFingerprint === 'string' ? body.buildFingerprint : undefined;
    lastActive = status.active;
    lastHealth = health.status === 'ok' && !healthy ? 'unhealthy-body' : health.status;
    if (healthy) lastBuild = answered ?? 'absent';
    if (status.active === 'active' && healthy && answered === expected) return { ok: true };
    if (status.active === 'failed') {
      return {
        ok: false,
        detail: `the ${options.provider.id} broker service entered the failed state after start `
          + `(active=failed, health=${lastHealth})`,
      };
    }
    await Bun.sleep(250);
  }
  // A healthy answer from the WRONG build is a different failure from silence, and conflating them is what
  // let a stale process pass this gate: name the build that answered so the operator sees which one is
  // still holding the port.
  if (lastHealth === 'ok' && lastBuild !== expected) {
    return {
      ok: false,
      detail: `the loopback health check was answered by ${PRODUCT_IDENTITY.productName} `
        + `${lastBuild}, not the just-installed ${expected}; a previous build is still `
        + `serving this port (active=${lastActive})`,
    };
  }
  return {
    ok: false,
    detail: `the ${options.provider.id} broker service did not answer a healthy loopback health check within `
      + `${attempts} attempts (active=${lastActive}, health=${lastHealth}, build=${lastBuild})`,
  };
}


/** Compatibility alias for callers that still use the pre-Phase-4 API name. */
export const startAndVerifySystemdService = startAndVerifyDurableService;
