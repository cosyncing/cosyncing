import { homedir } from 'node:os';
import { join } from 'node:path';
import { lstatSync, type Stats } from 'node:fs';
import {
  codexTuiPresenceSupported,
  scanCodexRemoteTuis,
  type CodexTuiCandidate,
} from '@cosyncing/adapter-codex/tui-presence';

export type CodexTuiReadinessStatus = 'ok' | 'restart-required' | 'unknown' | 'daemon-unavailable' | 'unsupported';

export interface CodexTuiReadinessReport {
  status: CodexTuiReadinessStatus;
  customSocket: boolean;
  staleCandidatePids: number[];
  /** True stale/private candidate count; the PID diagnostic payload remains capped. */
  staleCandidateCount?: number;
  message: string;
}

export interface CodexTuiReadinessDependencies {
  env?: Readonly<NodeJS.ProcessEnv>;
  nowMs?: number;
  platform?: NodeJS.Platform;
  procRoot?: string;
  socketProbeStat?: (socketPath: string) => Stats;
  scan?: (
    socketPath: string,
    procRoot: string,
    nowMs: number,
  ) => {
    candidates: readonly CodexTuiCandidate[];
    processScanAvailable?: boolean;
  };
}

export const CODEX_TUI_READINESS_TOLERANCE_MS = 2_000;
export const CODEX_TUI_READINESS_MAX_STALE_PIDS = 8;

interface DaemonSocketDescriptor {
  path: string;
  customSocket: boolean;
}

function defaultEnv(): Readonly<NodeJS.ProcessEnv> {
  return process.env;
}

function defaultScan(
  socketPath: string,
  procRoot: string,
  nowMs: number,
): { candidates: readonly CodexTuiCandidate[]; processScanAvailable: boolean } {
  return scanCodexRemoteTuis(socketPath, procRoot, nowMs);
}

function resolveDaemonSocket(env: Readonly<NodeJS.ProcessEnv> = defaultEnv()): DaemonSocketDescriptor {
  const explicit = env.COSYNCING_CODEX_APP_SERVER_SOCK?.trim();
  if (explicit) {
    return { path: explicit, customSocket: true };
  }
  const codexHome = env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  return {
    customSocket: false,
    path: join(codexHome, 'app-server-control', 'app-server-control.sock'),
  };
}

function socketReadyTimeMs(
  socketPath: string,
  probe: (path: string) => Stats,
): number | undefined {
  const stat = probe(socketPath);
  const birthtimeMs = stat.birthtimeMs;
  if (birthtimeMs > 0 && Number.isFinite(birthtimeMs)) return birthtimeMs;
  if (Number.isFinite(stat.ctimeMs) && stat.ctimeMs > 0) return stat.ctimeMs;
  return undefined;
}

function restartMessage(count: number, customSocket: boolean, socketPath: string): string {
  const countText = `${count} already-running Codex terminal(s)`;
  if (customSocket) {
    return `cosyncing started Codex's shared server. Close and reopen ${countText} using the generated custom remote command --remote=unix://${socketPath} so they join it. Use Resume to keep working in the same threads.`;
  }
  return `cosyncing started Codex's shared server. Close and reopen ${countText} so they join it. Use Resume to keep working in the same threads. New Codex terminals will connect automatically.`;
}

function unknownStatusMessage(customSocket: boolean): string {
  if (customSocket) {
    return `Could not confirm whether all running Codex terminals are connected to this custom socket.`;
  }
  return 'Could not confirm whether all running Codex terminals are connected to the shared Codex server yet.';
}

function unsupportedMessage(): string {
  return 'Codex terminal readiness detection is unavailable on this platform.';
}

function daemonUnavailableMessage(customSocket: boolean, socketPath: string): string {
  if (customSocket) {
    return `Configured Codex app-server socket is unavailable: ${socketPath}. Could not confirm terminal readiness.`;
  }
  return `No local Codex app-server socket was found at ${socketPath}. Could not confirm terminal readiness.`;
}

function renderReadinessMessage(
  status: CodexTuiReadinessStatus,
  customSocket: boolean,
  staleCount: number,
  socketPath: string,
): string {
  switch (status) {
    case 'restart-required':
      return restartMessage(staleCount, customSocket, socketPath);
    case 'unknown':
      return unknownStatusMessage(customSocket);
    case 'daemon-unavailable':
      return daemonUnavailableMessage(customSocket, socketPath);
    case 'unsupported':
      return unsupportedMessage();
    case 'ok':
      return 'All detected Codex terminals are attached to the shared server.';
    default:
      return 'Could not confirm Codex terminal readiness.';
  }
}

export function inspectCodexTuiReadiness(
  dependencies: Readonly<CodexTuiReadinessDependencies> = {},
): CodexTuiReadinessReport {
  const env = dependencies.env ?? process.env;
  const procRoot = dependencies.procRoot ?? env.COSYNCING_CODEX_PROC_ROOT?.trim() ?? '/proc';
  const platform = dependencies.platform ?? process.platform;
  const nowMs = dependencies.nowMs ?? Date.now();
  const socketDescriptor = resolveDaemonSocket(env);
  const scan = dependencies.scan ?? defaultScan;
  const probe = dependencies.socketProbeStat ?? ((socketPath: string): Stats => lstatSync(socketPath));

  if (!codexTuiPresenceSupported(platform)) {
    const message = unsupportedMessage();
    return {
      status: 'unsupported',
      customSocket: socketDescriptor.customSocket,
      staleCandidatePids: [],
      staleCandidateCount: 0,
      message,
    };
  }

  let readyMs: number | undefined;
  try {
    readyMs = socketReadyTimeMs(socketDescriptor.path, probe);
    if (!Number.isFinite(readyMs ?? NaN)) {
      return {
        status: 'daemon-unavailable',
        customSocket: socketDescriptor.customSocket,
        staleCandidatePids: [],
        staleCandidateCount: 0,
        message: daemonUnavailableMessage(socketDescriptor.customSocket, socketDescriptor.path),
      };
    }
  } catch {
    return {
      status: 'daemon-unavailable',
      customSocket: socketDescriptor.customSocket,
      staleCandidatePids: [],
      staleCandidateCount: 0,
      message: daemonUnavailableMessage(socketDescriptor.customSocket, socketDescriptor.path),
    };
  }
  if (readyMs === undefined) {
    return {
      status: 'daemon-unavailable',
      customSocket: socketDescriptor.customSocket,
      staleCandidatePids: [],
      message: daemonUnavailableMessage(socketDescriptor.customSocket, socketDescriptor.path),
    };
  }

  try {
    const scanResult = scan(socketDescriptor.path, procRoot, nowMs);

    if (scanResult.processScanAvailable === false) {
      return {
        status: 'unknown',
        customSocket: socketDescriptor.customSocket,
        staleCandidatePids: [],
        staleCandidateCount: 0,
        message: unknownStatusMessage(socketDescriptor.customSocket),
      };
    }

    const stalePidSet = new Set<number>();
    let hasUnknownCandidate = false;

    for (const candidate of scanResult.candidates) {
      const proof = candidate.proof;
      const clearlyBeforeReadiness =
        candidate.startedAtMs !== undefined &&
        candidate.startedAtMs <= (readyMs - CODEX_TUI_READINESS_TOLERANCE_MS);
      if (proof === 'private') {
        stalePidSet.add(candidate.pid);
        continue;
      }
      if (proof === 'unknown') {
        if (clearlyBeforeReadiness) {
          stalePidSet.add(candidate.pid);
          continue;
        }
        hasUnknownCandidate = true;
      }
    }

    const staleCandidateCount = stalePidSet.size;
    const staleCandidatePids = [...stalePidSet].sort((a, b) => a - b).slice(0, CODEX_TUI_READINESS_MAX_STALE_PIDS);
    let status: CodexTuiReadinessStatus = 'ok';
    if (staleCandidatePids.length > 0) {
      status = 'restart-required';
    } else if (hasUnknownCandidate) {
      status = 'unknown';
    }

    return {
      status,
      customSocket: socketDescriptor.customSocket,
      staleCandidatePids,
      staleCandidateCount,
      message: renderReadinessMessage(
        status,
        socketDescriptor.customSocket,
        staleCandidateCount,
        socketDescriptor.path,
      ),
    };
  } catch {
    return {
      status: 'unknown',
      customSocket: socketDescriptor.customSocket,
      staleCandidatePids: [],
      staleCandidateCount: 0,
      message: 'Could not confirm Codex terminal readiness due to an internal metadata scan failure.',
    };
  }
}
