/**
 * Pi-family dialect descriptor.
 *
 * The Pi engine (implementation.ts + bridge.ts) serves every pi-compatible RPC
 * dialect — upstream `pi` and the oh-my-pi fork (`omp`) — parameterized by this
 * descriptor. `PI_DIALECT` reproduces the adapter's historical pi behavior
 * exactly; a second dialect supplies only the measured deltas (binary, paths,
 * command aliases, JSONL entry readers, lifecycle surface, bridge install).
 *
 * Scope note: the readiness gate and doctor diagnostics stay per-dialect
 * (runtime-readiness.ts / diagnostics.ts per package); the descriptor carries
 * the engine-facing surface only. The engine hooks (readiness/diagnose) arrive
 * with the resolved runtime, not on the descriptor, because they close over
 * per-package modules.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentSetupDiagnosis, SetupDiagnosisContext } from '@cosyncing/adapter-api';
import type { PiBridgeAssetInspection } from './implementation.ts';

/** Parsed fields of a JSONL `model_change` entry, normalized for the engine's surface scanner. */
export interface PiModelChangeParse {
  provider?: unknown;
  id?: unknown;
  label?: unknown;
}

/** The minimal readiness surface the engine consumes (full result type lives per-dialect). */
export interface PiEngineReadiness {
  ready: boolean;
  message: string;
  detailCode: string;
  executable?: string;
  /** A configuration conflict that also forbids discovery/attach, not only session creation. */
  blocksSessionAccess?: boolean;
}

/** Per-dialect behavior the engine cannot express as data: the readiness gate and doctor. */
export interface PiEngineHooks {
  readiness(): PiEngineReadiness;
  diagnose(
    context: SetupDiagnosisContext,
    inspectBridge: (agentDir: string) => PiBridgeAssetInspection,
  ): Promise<AgentSetupDiagnosis>;
}

/** The embedded bridge extension bytes installed for this dialect, with ownership evidence. */
export interface PiBridgeAsset {
  source: string;
  sha256: string;
  /** Exact bytes of a superseded packaged bridge eligible for confirmed migration (pi only). */
  legacySource?: string;
}

export interface PiDialect {
  /** Broker tool id — keys the hub, bridge routes, and roster rows. */
  toolId: string;
  /** Human-facing name used in engine messages and control-state labels. */
  displayName: string;
  /** Binary resolved on PATH (`pi` / `omp`). */
  bin: string;
  /** Env override naming an explicit binary path (COSYNCING_PI_BIN / COSYNCING_OMP_BIN). */
  binEnvOverride: string;
  /** Env overrides that relocate the sessions root outright, first non-empty wins. */
  sessionsRootEnvOverrides: readonly string[];
  /** Env overrides relocating the whole agent dir, first non-empty wins. */
  agentDirEnvOverrides: readonly string[];
  /** Env override for the session-name scan budget. */
  nameScanBytesEnvOverride: string;
  /** Env override opting out of bridge auto-install (`0|false|no|off`). */
  bridgeAutoinstallEnvOverride: string;
  /** Broker route family the installed bridge asset calls (`/pi/bridge` / `/omp/bridge`). */
  bridgeRoutePrefix: string;
  /** RPC command-type aliases where the dialect renamed a command. */
  rpcAliases: { getCommands: string };
  /** RPC lifecycle commands the dialect exposes (omp removed fork/clone from RPC). */
  lifecycleCommands: { fork: boolean; clone: boolean };
  /**
   * JSONL entry types carrying the session title, read last-write-wins. pi writes `session_info`;
   * omp additionally writes a leading `title` slot and `title_change` entries.
   */
  titleEntryTypes: readonly string[];
  /**
   * How a create-time title is persisted. pi: the engine appends a `session_info` entry when the
   * native process has not recorded the name yet. omp: `set_session_name` only — the engine must
   * not append an entry type omp does not own.
   */
  createTimeTitle: 'session_info' | 'native';
  /** Durable run-summary key namespace (`pi:run:` / `omp:run:`). */
  eventKeyNamespace: string;
  /** `source` labels stamped on mapped messages. */
  eventSources: { rpc: string; jsonl: string; bridge: string };
  /** Parse a JSONL `model_change` entry: pi carries {provider, modelId}, omp a combined "provider/modelId". */
  parseModelChange(entry: any): PiModelChangeParse;
  /** The agent dir when its env override is unset (e.g. `~/.pi/agent`; omp honors PI_CONFIG_DIR). */
  defaultAgentDir(env: NodeJS.ProcessEnv): string;
  /** The sessions root under the resolved agent dir (omp adds the XDG_DATA_HOME redirect). */
  defaultSessionsRoot(ctx: {
    agentDir: string;
    agentDirOverridden: boolean;
    env: NodeJS.ProcessEnv;
  }): string;
}

/** A dialect resolved against the process environment: every path the engine touches. */
export interface PiDialectRuntime {
  dialect: PiDialect;
  hooks: PiEngineHooks;
  bridgeAsset: PiBridgeAsset;
  sessionsRootOverride?: string;
  agentDirOverride?: string;
  agentDirOverrideKey?: string;
  agentDir: string;
  sessionsRoot: string;
  nameScanBytes: number;
  /** `<agentDir>/extensions/cosyncing-bridge/index.ts` — the bridge install target. */
  bridgeInstallPath: string;
}

export interface PiDialectPaths {
  sessionsRootOverride?: string;
  agentDirOverride?: string;
  agentDirOverrideKey?: string;
  agentDir: string;
  sessionsRoot: string;
  bridgeInstallPath: string;
}

/** Resolve only the filesystem surface, so setup and collision diagnostics use the engine's rules. */
export function resolvePiDialectPaths(dialect: PiDialect, env: NodeJS.ProcessEnv): PiDialectPaths {
  const sessionsRootOverride = dialect.sessionsRootEnvOverrides
    .map((key) => env[key]?.trim())
    .find((value) => !!value) || undefined;
  const agentDirOverrideEntry = dialect.agentDirEnvOverrides
    .map((key) => ({ key, value: env[key]?.trim() }))
    .find((entry) => !!entry.value);
  const agentDirOverride = agentDirOverrideEntry?.value || undefined;
  const agentDir = agentDirOverride ?? dialect.defaultAgentDir(env);
  const sessionsRoot = sessionsRootOverride
    ?? dialect.defaultSessionsRoot({ agentDir, agentDirOverridden: agentDirOverride !== undefined, env });
  return {
    ...(sessionsRootOverride ? { sessionsRootOverride } : {}),
    ...(agentDirOverride ? {
      agentDirOverride,
      agentDirOverrideKey: agentDirOverrideEntry!.key,
    } : {}),
    agentDir,
    sessionsRoot,
    bridgeInstallPath: join(agentDir, 'extensions', 'cosyncing-bridge', 'index.ts'),
  };
}

/**
 * Freeze a dialect against the environment. Resolution happens once per package module load,
 * exactly as the pi adapter's module-level constants always did (tests set env, then import).
 */
export function resolvePiDialectRuntime(
  dialect: PiDialect,
  env: NodeJS.ProcessEnv,
  extras: { hooks: PiEngineHooks; bridgeAsset: PiBridgeAsset },
): PiDialectRuntime {
  const paths = resolvePiDialectPaths(dialect, env);
  const nameScanBytes = Math.max(
    256 * 1024,
    Number(env[dialect.nameScanBytesEnvOverride] ?? 4 * 1024 * 1024) || 0,
  );
  return {
    dialect,
    hooks: extras.hooks,
    bridgeAsset: extras.bridgeAsset,
    ...paths,
    nameScanBytes,
  };
}

/** pi's `model_change` entries carry structured fields; the `model` fallback predates them. */
function piParseModelChange(entry: any): PiModelChangeParse {
  return {
    provider: entry?.provider,
    id: entry?.modelId ?? entry?.modelID ?? entry?.model,
    label: entry?.name ?? entry?.modelName,
  };
}

export const PI_DIALECT: PiDialect = {
  toolId: 'pi',
  displayName: 'Pi',
  bin: 'pi',
  binEnvOverride: 'COSYNCING_PI_BIN',
  sessionsRootEnvOverrides: ['COSYNCING_PI_SESSIONS_ROOT', 'PI_CODING_AGENT_SESSION_DIR'],
  agentDirEnvOverrides: ['COSYNCING_PI_AGENT_DIR', 'PI_CODING_AGENT_DIR'],
  nameScanBytesEnvOverride: 'COSYNCING_PI_NAME_SCAN_BYTES',
  bridgeAutoinstallEnvOverride: 'COSYNCING_PI_BRIDGE_AUTOINSTALL',
  bridgeRoutePrefix: '/pi/bridge',
  rpcAliases: { getCommands: 'get_commands' },
  lifecycleCommands: { fork: true, clone: true },
  titleEntryTypes: ['session_info'],
  createTimeTitle: 'session_info',
  eventKeyNamespace: 'pi:run:',
  eventSources: { rpc: 'pi-rpc', jsonl: 'pi-jsonl', bridge: 'pi-bridge' },
  parseModelChange: piParseModelChange,
  // env.HOME first: os.homedir() ignores process.env.HOME under Bun, which breaks env-injected
  // resolution (tests and review harnesses). Production passes process.env, so behavior is identical.
  defaultAgentDir: (env) => join(env.HOME?.trim() || homedir(), '.pi', 'agent'),
  defaultSessionsRoot: ({ agentDir }) => join(agentDir, 'sessions'),
};

/**
 * omp (oh-my-pi) sessions-root rule, mirrored from `@oh-my-pi/pi-utils` dirs.ts (v1: default
 * profile only — `OMP_PROFILE` sessions are out of scope): with no agent-dir override, on
 * Linux/macOS a migrated install redirects `<configRoot>/agent/sessions` to
 * `$XDG_DATA_HOME/omp/sessions`, but only once `$XDG_DATA_HOME/omp` exists.
 */
export function ompDefaultSessionsRoot(ctx: {
  agentDir: string;
  agentDirOverridden: boolean;
  env: NodeJS.ProcessEnv;
}): string {
  if (!ctx.agentDirOverridden && (process.platform === 'linux' || process.platform === 'darwin')) {
    const xdgDataHome = ctx.env.XDG_DATA_HOME?.trim();
    if (xdgDataHome && existsSync(join(xdgDataHome, 'omp'))) {
      return join(xdgDataHome, 'omp', 'sessions');
    }
  }
  return join(ctx.agentDir, 'sessions');
}

/** omp's `model_change` carries one combined "provider/modelId" string — split on the FIRST `/`. */
export function ompParseModelChange(entry: any): PiModelChangeParse {
  const combined = typeof entry?.model === 'string' ? entry.model : undefined;
  if (!combined) return piParseModelChange(entry);
  const slash = combined.indexOf('/');
  if (slash === -1) return { provider: '', id: combined };
  return { provider: combined.slice(0, slash), id: combined.slice(slash + 1) };
}
