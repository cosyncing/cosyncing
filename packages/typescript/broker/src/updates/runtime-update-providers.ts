import {
  codexThreadActivityFromNative,
  parseCodexDaemonVersionOutput,
  type CodexLoadedThreadActivity,
  type CodexDaemonVersion,
} from '@cosyncing/adapter-codex';
import type { CodexUpdatePolicy } from '../installation/setup-state.ts';
import {
  RUNTIME_UPDATE_OCCURRENCE_FINGERPRINT,
  type RuntimeUpdateInspection,
  type RuntimeUpdateProvider,
} from './runtime-update.ts';

export { parseCodexDaemonVersionOutput };
export { codexThreadActivityFromNative };
export type { CodexDaemonVersion, CodexLoadedThreadActivity };

const CODEX_RESTART_WARNING =
  'Remote terminals attached to the daemon will disconnect and must be resumed explicitly.';

export function inspectionFromVersions(input: {
  agent: string;
  displayName: string;
  runtimeKind?: string;
  restartWarning?: string;
  managed: boolean;
  installedVersion: string;
  runningVersion: string;
  safe: boolean;
  blockers?: number;
  blockerComposition?: RuntimeUpdateInspection['blockerComposition'];
  blockerDetails?: RuntimeUpdateInspection['blockerDetails'];
  pendingChanges?: RuntimeUpdateInspection['pendingChanges'];
  occurrenceFingerprint?: string;
  detail?: string;
}): RuntimeUpdateInspection {
  const pendingChanges = input.pendingChanges
    ?? (input.installedVersion !== input.runningVersion ? ['binary-version'] : []);
  const updateAvailable = pendingChanges.length > 0;
  const inspection: RuntimeUpdateInspection = {
    agent: input.agent,
    displayName: input.displayName,
    ...(input.runtimeKind ? { runtimeKind: input.runtimeKind } : {}),
    ...(input.restartWarning ? { restartWarning: input.restartWarning } : {}),
    managed: input.managed,
    state: updateAvailable ? 'pending' : 'current',
    updateAvailable,
    autoRestartReady: updateAvailable && input.safe,
    ...(pendingChanges.length ? { pendingChanges } : {}),
    installedVersion: input.installedVersion,
    runningVersion: input.runningVersion,
    ...(input.blockers == null ? {} : { blockers: input.blockers }),
    ...(input.blockerComposition ? { blockerComposition: input.blockerComposition } : {}),
    ...(input.blockerDetails ? { blockerDetails: input.blockerDetails } : {}),
    ...(input.detail ? { detail: input.detail } : {}),
    checkedAt: Date.now(),
  };
  if (input.occurrenceFingerprint) {
    inspection[RUNTIME_UPDATE_OCCURRENCE_FINGERPRINT] = input.occurrenceFingerprint;
  }
  return inspection;
}

export interface CodexRuntimeDependencies {
  readVersion(): Promise<CodexDaemonVersion | undefined>;
  readConfigFreshness?(version: CodexDaemonVersion): Promise<{
    changed: boolean;
    detail: string;
    fingerprint: string;
  }>;
  loadedThreads(): Promise<CodexLoadedThreadActivity[]>;
  policy(): CodexUpdatePolicy;
  restart(): Promise<void>;
}

export function createCodexRuntimeUpdateProvider(deps: CodexRuntimeDependencies): RuntimeUpdateProvider {
  return {
    agent: 'codex',
    async inspect() {
      let version: CodexDaemonVersion | undefined;
      try {
        version = await deps.readVersion();
      } catch (error) {
        return {
          agent: 'codex',
          displayName: 'Codex',
          runtimeKind: 'daemon',
          managed: false,
          state: 'error',
          updateAvailable: false,
          autoRestartReady: false,
          detail: error instanceof Error ? error.message : String(error),
          checkedAt: Date.now(),
        };
      }
      if (!version || version.status !== 'running') {
        return {
          agent: 'codex',
          displayName: 'Codex',
          runtimeKind: 'daemon',
          managed: false,
          state: 'unavailable',
          updateAvailable: false,
          autoRestartReady: false,
          detail: 'Codex managed daemon is not running.',
          checkedAt: Date.now(),
        };
      }
      let configFreshness: { changed: boolean; detail: string; fingerprint: string } = {
        changed: false,
        detail: 'Codex user configuration probe is not configured.',
        fingerprint: 'unconfigured',
      };
      if (deps.readConfigFreshness) {
        try {
          configFreshness = await deps.readConfigFreshness(version);
        } catch (error) {
          return {
            agent: 'codex',
            displayName: 'Codex',
            runtimeKind: 'daemon',
            managed: true,
            state: 'error',
            updateAvailable: false,
            autoRestartReady: false,
            detail: `Codex user-config freshness probe failed: ${error instanceof Error ? error.message : String(error)}`,
            checkedAt: Date.now(),
          };
        }
      }
      const pendingChanges: RuntimeUpdateInspection['pendingChanges'] = [
        ...(version.cliVersion !== version.appServerVersion ? ['binary-version' as const] : []),
        ...(configFreshness.changed ? ['configuration' as const] : []),
      ];
      if (pendingChanges.length === 0) {
        return inspectionFromVersions({
          agent: 'codex',
          displayName: 'Codex',
          runtimeKind: 'daemon',
          restartWarning: CODEX_RESTART_WARNING,
          managed: true,
          installedVersion: version.cliVersion,
          runningVersion: version.appServerVersion,
          safe: false,
          detail: deps.readConfigFreshness ? configFreshness.detail : undefined,
        });
      }
      try {
        const loaded = await deps.loadedThreads();
        const policy = deps.policy();
        const blockerComposition = {
          idle: loaded.filter((entry) => entry.status === 'idle').length,
          working: loaded.filter((entry) => entry.status === 'working').length,
          needsInput: loaded.filter((entry) => entry.status === 'needs-input').length,
          unknown: loaded.filter((entry) => entry.status === 'unknown').length,
        };
        const safe = policy === 'when-detached'
          ? loaded.length === 0
          : loaded.every((entry) => entry.status === 'idle');
        return inspectionFromVersions({
          agent: 'codex',
          displayName: 'Codex',
          runtimeKind: 'daemon',
          restartWarning: CODEX_RESTART_WARNING,
          managed: true,
          installedVersion: version.cliVersion,
          runningVersion: version.appServerVersion,
          pendingChanges,
          ...(configFreshness.changed
            ? { occurrenceFingerprint: configFreshness.fingerprint }
            : {}),
          safe,
          blockers: loaded.length,
          blockerComposition,
          blockerDetails: loaded,
          detail: `${configFreshness.changed ? `${configFreshness.detail} ` : ''}${loaded.length
            ? `${loaded.length} daemon-loaded thread${loaded.length === 1 ? '' : 's'}: ${blockerComposition.idle} idle, ${blockerComposition.working} working, ${blockerComposition.needsInput} waiting for input, ${blockerComposition.unknown} unknown. Policy: ${policy}.`
            : 'No daemon-loaded threads remain.'}`,
        });
      } catch (error) {
        return inspectionFromVersions({
          agent: 'codex',
          displayName: 'Codex',
          runtimeKind: 'daemon',
          restartWarning: CODEX_RESTART_WARNING,
          managed: true,
          installedVersion: version.cliVersion,
          runningVersion: version.appServerVersion,
          pendingChanges,
          ...(configFreshness.changed
            ? { occurrenceFingerprint: configFreshness.fingerprint }
            : {}),
          safe: false,
          detail: `${configFreshness.changed ? `${configFreshness.detail} ` : ''}Loaded-thread safety probe failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
    restart: deps.restart,
  };
}

export interface OpencodeRuntimeDependencies {
  readVersions(): Promise<{ managed: boolean; installedVersion?: string; runningVersion?: string; detail?: string }>;
  isBusy(): boolean;
  restart(): Promise<void>;
}

export function createOpencodeRuntimeUpdateProvider(deps: OpencodeRuntimeDependencies): RuntimeUpdateProvider {
  return {
    agent: 'opencode',
    async inspect() {
      let versions: Awaited<ReturnType<OpencodeRuntimeDependencies['readVersions']>>;
      try {
        versions = await deps.readVersions();
      } catch (error) {
        return {
          agent: 'opencode',
          displayName: 'OpenCode',
          runtimeKind: 'serve',
          managed: false,
          state: 'error',
          updateAvailable: false,
          autoRestartReady: false,
          detail: error instanceof Error ? error.message : String(error),
          checkedAt: Date.now(),
        };
      }
      if (!versions.managed || !versions.installedVersion || !versions.runningVersion) {
        return {
          agent: 'opencode',
          displayName: 'OpenCode',
          runtimeKind: 'serve',
          managed: false,
          state: 'unavailable',
          updateAvailable: false,
          autoRestartReady: false,
          detail: versions.detail || 'OpenCode serve is not managed by this broker.',
          checkedAt: Date.now(),
        };
      }
      let busy = true;
      try {
        busy = deps.isBusy();
      } catch {
        busy = true;
      }
      return inspectionFromVersions({
        agent: 'opencode',
        displayName: 'OpenCode',
        runtimeKind: 'serve',
        managed: true,
        installedVersion: versions.installedVersion,
        runningVersion: versions.runningVersion,
        safe: !busy,
        detail: busy ? 'A managed OpenCode session is working or needs input.' : 'Managed OpenCode serve is idle.',
      });
    },
    restart: deps.restart,
  };
}
