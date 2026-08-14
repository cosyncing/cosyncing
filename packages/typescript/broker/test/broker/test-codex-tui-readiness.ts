#!/usr/bin/env bun
/**
 * P4-2B3 onboarding-readiness read-through checks. This suite is read-only and does not
 * spawn processes, mutate files, or touch real /proc.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectCodexTuiReadiness, CODEX_TUI_READINESS_MAX_STALE_PIDS } from '../../../adapters/codex/src/tui-presence.ts';
import { type CodexTuiCandidate } from '../../../adapters/codex/src/tui-presence.ts';
import { type Stats } from 'node:fs';

const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string): void => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const homeRoot = mkdtempSync(join(tmpdir(), 'cosyncing-readiness-'));
let pid = 1200;
const now = 1_000_000;
const socketReadyMs = 500_000;

const makeStat = (ms: number): Stats => ({
  size: 0,
  mode: 0o777,
  blksize: 0,
  blocks: 0,
  atimeMs: ms,
  mtimeMs: ms,
  ctimeMs: ms,
  birthtimeMs: ms,
  atime: new Date(ms),
  mtime: new Date(ms),
  ctime: new Date(ms),
  birthtime: new Date(ms),
  isFile: () => false,
  isDirectory: () => false,
  isSymbolicLink: () => false,
  isBlockDevice: () => false,
  isCharacterDevice: () => false,
  isFIFO: () => false,
  isSocket: () => true,
  isUnknown: () => false,
  uid: 0,
  gid: 0,
  ino: 1,
  dev: 1,
  nlink: 1,
  rdev: 1,
} as Stats);

function candidate(overrides: Partial<CodexTuiCandidate>): CodexTuiCandidate {
  return { pid: pid++, proof: 'unknown', threadIds: [], ...overrides };
}

function readiness(
  candidates: readonly CodexTuiCandidate[],
  env: Record<string, string | undefined> = { CODEX_HOME: homeRoot },
  overrides: {
    nowMs?: number;
    platform?: NodeJS.Platform;
    socketProbeStat?: () => Stats;
    throwScan?: boolean;
    scanResult?: { candidates: readonly CodexTuiCandidate[]; processScanAvailable?: boolean };
  } = {},
) {
  return inspectCodexTuiReadiness({
    env,
    nowMs: overrides.nowMs ?? now,
    platform: overrides.platform,
    socketProbeStat: overrides.socketProbeStat ?? (() => makeStat(socketReadyMs)),
    scan: overrides.throwScan
      ? () => {
        throw new Error('scanner failure');
      }
      : overrides.scanResult
        ? () => overrides.scanResult!
        : () => ({ candidates }),
  });
}

{
  const stale = readiness([candidate({ proof: 'unknown', startedAtMs: 10_000 })], { CODEX_HOME: homeRoot });
  check(
    'pre-daemon unknown candidate => restart-required',
    stale.status === 'restart-required' &&
      stale.staleCandidatePids.length === 1 &&
      stale.message ===
        "cosyncing started Codex's shared server. Close and reopen 1 already-running Codex terminal(s) so they join it. Use Resume to keep working in the same threads. New Codex terminals will connect automatically.",
  );

  const twoStale = readiness(
    [
      candidate({ pid: 1301, proof: 'unknown', startedAtMs: 10_000 }),
      candidate({ pid: 1302, proof: 'unknown', startedAtMs: 10_500 }),
    ],
    { CODEX_HOME: homeRoot },
  );
  check(
    'two stale PIDs => restart-required with plural count',
    twoStale.status === 'restart-required' && twoStale.staleCandidatePids.length === 2,
  );

  const ok = readiness([candidate({ proof: 'shared', startedAtMs: 700_000 })], { CODEX_HOME: homeRoot });
  check('post-daemon shared candidate => ok', ok.status === 'ok', `status=${ok.status}`);
}

{
  const mixed = readiness(
    [
      candidate({ proof: 'shared', startedAtMs: 700_000 }),
      candidate({ proof: 'private', startedAtMs: 700_100 }),
      candidate({ proof: 'unknown', startedAtMs: 10_000 }),
      candidate({ proof: 'shared', startedAtMs: 700_000 }),
    ],
    { CODEX_HOME: homeRoot },
  );
  check(
    'mixed shared + stale counts only stale candidates',
    mixed.status === 'restart-required' &&
      mixed.staleCandidatePids.length === 2,
    JSON.stringify(mixed.staleCandidatePids),
  );
}

{
  const explicitPrivate = readiness([candidate({ proof: 'private', startedAtMs: now })], { CODEX_HOME: homeRoot });
  check(
    'explicit private stays restart-required regardless age',
    explicitPrivate.status === 'restart-required',
    `status=${explicitPrivate.status}`,
  );
}

{
  const afterReadyUnknown = readiness([candidate({ proof: 'unknown', startedAtMs: now })], { CODEX_HOME: homeRoot });
  check(
    'unknown post-ready uses neutral wording',
    afterReadyUnknown.status === 'unknown' &&
      !afterReadyUnknown.message.toLowerCase().includes('behind'),
    afterReadyUnknown.message,
  );

  const missingStart = readiness([candidate({ proof: 'unknown' })], { CODEX_HOME: homeRoot });
  check(
    'missing process start time remains unknown',
    missingStart.status === 'unknown' &&
      !missingStart.message.toLowerCase().includes('behind'),
    missingStart.message,
  );

  const customSocket = readiness(
    [candidate({ proof: 'unknown', startedAtMs: 10_000 })],
    { COSYNCING_CODEX_APP_SERVER_SOCK: '/tmp/custom.sock' },
  );
  check(
    'custom socket restart warning avoids plain auto-discovery claim',
    customSocket.status === 'restart-required' &&
      !customSocket.message.includes('New Codex terminals will connect automatically') &&
      customSocket.message.includes('generated custom remote command'),
    customSocket.message,
  );
}

{
  const missingSocket = readiness(
    [],
    { CODEX_HOME: homeRoot },
    { socketProbeStat: () => {
      throw new Error('missing socket');
    } },
  );
  check(
    'missing socket maps to daemon-unavailable',
    missingSocket.status === 'daemon-unavailable',
    missingSocket.message,
  );

  const unsupported = readiness([], { CODEX_HOME: homeRoot }, { platform: 'win32' });
  check(
    'unsupported platform mapped as unsupported',
    unsupported.status === 'unsupported',
    unsupported.status,
  );

  const scannerError = readiness([], { CODEX_HOME: homeRoot }, { throwScan: true });
  check(
    'scanner failure is caught as unknown',
    scannerError.status === 'unknown',
    scannerError.message,
  );

  const unavailable = readiness([], { CODEX_HOME: homeRoot }, {
    scanResult: {
      candidates: [candidate({ proof: 'private', startedAtMs: 10_000 })],
      processScanAvailable: false,
    },
  });
  check(
    'read process-scan-unavailable is treated as readiness unknown',
    unavailable.status === 'unknown' &&
      unavailable.staleCandidatePids.length === 0 &&
      !unavailable.message.toLowerCase().includes('behind'),
    unavailable.message,
  );
}

{
  const stale = [candidate({ proof: 'unknown', startedAtMs: 10_000 })];
  const scanStates = [
    { candidates: stale },
    { candidates: [candidate({ proof: 'shared', startedAtMs: now })] },
  ];
  let call = 0;
  const first = inspectCodexTuiReadiness({
    env: { CODEX_HOME: homeRoot },
    nowMs: now,
    socketProbeStat: () => makeStat(socketReadyMs),
    scan: () => {
      const entry = scanStates[call];
      call += 1;
      return { candidates: entry?.candidates ?? scanStates[1]!.candidates };
    },
  });
  const second = inspectCodexTuiReadiness({
    env: { CODEX_HOME: homeRoot },
    nowMs: now,
    socketProbeStat: () => makeStat(socketReadyMs),
    scan: () => {
      const entry = scanStates[call];
      call += 1;
      return { candidates: entry?.candidates ?? scanStates[1]!.candidates };
    },
  });
  check(
    're-scan can clear a prior warning',
    first.status === 'restart-required' && second.status === 'ok',
    `first=${first.status}, second=${second.status}`,
  );
}

{
  const pids = Array.from(
    { length: CODEX_TUI_READINESS_MAX_STALE_PIDS + 4 },
    () => candidate({ proof: 'unknown', startedAtMs: 10_000 }).pid,
  );
  const bounded = readiness(pids.map((value) => candidate({ pid: value, proof: 'unknown', startedAtMs: 10_000 })));
  check(
    `bounded stale PIDs stays within ${CODEX_TUI_READINESS_MAX_STALE_PIDS}`,
    bounded.staleCandidatePids.length === CODEX_TUI_READINESS_MAX_STALE_PIDS &&
      bounded.staleCandidateCount === CODEX_TUI_READINESS_MAX_STALE_PIDS + 4 &&
      bounded.message.includes(`${CODEX_TUI_READINESS_MAX_STALE_PIDS + 4} already-running Codex terminal`),
    `pids=${bounded.staleCandidatePids.length}, count=${bounded.staleCandidateCount}, message=${bounded.message}`,
  );
}

rmSync(homeRoot, { recursive: true, force: true });

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length}/${results.length} check(s) failed.`);
  for (const item of failed) {
    console.error(`- ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
  }
  process.exit(1);
}
console.log(`\nPASS ${results.length}/${results.length} codex readiness checks`);
