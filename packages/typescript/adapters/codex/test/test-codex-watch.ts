#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionInfo } from '../../../adapter-api/src/index.ts';
import type { CodexTuiScan } from '../src/tui-presence.ts';

const home = mkdtempSync(join(tmpdir(), 'cosyncing-codex-watch-'));
const previous = {
  home: process.env.CODEX_HOME,
  sync: process.env.COSYNCING_CODEX_SYNC_SERVER,
  sock: process.env.COSYNCING_CODEX_APP_SERVER_SOCK,
  interval: process.env.COSYNCING_CODEX_SYNC_WATCH_MS,
  grace: process.env.COSYNCING_CODEX_SYNC_DROP_GRACE_POLLS,
};
process.env.CODEX_HOME = home;
process.env.COSYNCING_CODEX_SYNC_SERVER = '1';
process.env.COSYNCING_CODEX_APP_SERVER_SOCK = join(home, 'app-server-control.sock');
process.env.COSYNCING_CODEX_SYNC_WATCH_MS = '250';
process.env.COSYNCING_CODEX_SYNC_DROP_GRACE_POLLS = '1';

const THREAD_A = '019f5701-0000-7000-8000-00000000000a';
const THREAD_B = '019f5702-0000-7000-8000-00000000000b';
const cwd = '/tmp/cosyncing-codex-watch';
const sessions = join(home, 'sessions', '2026', '07', '17');
mkdirSync(sessions, { recursive: true });
const writeRollout = (threadId: string) => writeFileSync(
  join(sessions, `rollout-2026-07-17T00-00-00-${threadId}.jsonl`),
  `${JSON.stringify({
    timestamp: '2026-07-17T00:00:00.000Z',
    type: 'session_meta',
    payload: { id: threadId, cwd },
  })}\n`,
);
writeRollout(THREAD_A);
writeRollout(THREAD_B);

const emptyScan = (): CodexTuiScan => ({
  attributed: new Set(),
  unattributed: [],
  privateThreadIds: new Set(),
  privateUnattributed: [],
  unknownUnattributed: [],
  unknownThreadIds: new Set(),
  candidates: [],
  socketDiagAvailable: true,
  processScanAvailable: true,
});

let scanCalls = 0;
let activeScans = 0;
let maxActiveScans = 0;
const scanPresence = async (): Promise<CodexTuiScan> => {
  const call = ++scanCalls;
  activeScans += 1;
  maxActiveScans = Math.max(maxActiveScans, activeScans);
  await Bun.sleep(320);
  activeScans -= 1;
  // Initial: neither session. Call 2: A joins. Call 3: A's raw PID/start identity churns.
  // Call 4: B becomes daemon-loaded while still absent. Call 5: B's terminal joins.
  const sharedIds = call >= 5 ? [THREAD_A, THREAD_B] : call >= 2 ? [THREAD_A] : [];
  const scan = emptyScan();
  for (const [index, threadId] of sharedIds.entries()) {
    scan.attributed.add(threadId);
    scan.candidates.push({
      pid: 10_000 + call * 10 + index,
      threadIds: [threadId],
      cwd,
      startedAtMs: 1_700_000_000_000 + call * 100 + index,
      proof: 'shared',
    });
  }
  return scan;
};

let loadedCalls = 0;
const queryLoadedThreadIds = async () => {
  const call = ++loadedCalls;
  return new Set(call >= 4 ? [THREAD_A, THREAD_B] : [THREAD_A]);
};

let stop: (() => void) | undefined;
try {
  const { CodexAdapter } = await import('../src/index.ts');
  const adapter = new CodexAdapter({ queryLoadedThreadIds, scanCodexTuiPresence: scanPresence });
  const changes: SessionInfo[] = [];
  stop = adapter.watchSessionInfo((info) => changes.push(info));
  const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 6_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}; scans=${scanCalls} changes=${changes.length}`);
      await Bun.sleep(10);
    }
  };

  // R0c.4: the FIRST poll publishes the state it derived instead of silently seeding its
  // fingerprints. Before that, a restarted broker's watcher could observe the correct state for an
  // unowned row and never say so — the state only reached the journal at some later input edge.
  // Only the daemon-loaded set — A at this point — is what the first poll's probes attest to; B is
  // on disk but unloaded and belongs to discovery until a real transition affects it.
  await waitFor(() => changes.length >= 1, 'first-poll publication');
  const seeded = changes.splice(0, changes.length);
  assert.deepEqual(
    seeded.map((info) => info.nativeId),
    [THREAD_A],
    'the first poll publishes the daemon-loaded row exactly once and nothing else',
  );

  // Wait on observed scan/change milestones rather than assuming that a fixed number of timer
  // ticks fit in one sleep. The interval remains intentionally shorter than the 320ms probe so
  // a flaky implementation that overlaps polls would be exposed by maxActiveScans below.
  await waitFor(() => scanCalls >= 2 && changes.length >= 1, 'A presence change');
  assert.equal(changes[0]?.nativeId, THREAD_A, 'A-only presence change emits A');
  await waitFor(() => scanCalls >= 4 && changes.length >= 2, 'B loaded-set transition');
  assert.equal(changes[1]?.nativeId, THREAD_B, 'loaded-set transition emits affected B row');
  await waitFor(() => scanCalls >= 5 && changes.length >= 3, 'B presence change');
  assert.equal(changes[2]?.nativeId, THREAD_B, 'B-only presence change emits B');
  const changesAfterPresence = changes.length;
  await waitFor(() => scanCalls >= 6 && activeScans === 0, 'post-churn scan');
  stop();
  stop = undefined;

  assert.equal(maxActiveScans, 1, 'periodic async presence scans must not overlap');
  assert.equal(changesAfterPresence, 3, 'raw candidate PID/start churn does not rebroadcast unchanged rows');
  assert.equal(changes.length, changesAfterPresence, 'post-churn scan emits no extra unchanged rows');
  console.log('PASS: Codex watch diffs derived rows, preserves loaded transitions, and serializes async scans');
} finally {
  // Also stop the watcher when an assertion fails, so this focused test cannot leave a timer
  // running while its temporary CODEX_HOME is being removed.
  stop?.();
  stop = undefined;
  if (previous.home == null) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous.home;
  if (previous.sync == null) delete process.env.COSYNCING_CODEX_SYNC_SERVER; else process.env.COSYNCING_CODEX_SYNC_SERVER = previous.sync;
  if (previous.sock == null) delete process.env.COSYNCING_CODEX_APP_SERVER_SOCK; else process.env.COSYNCING_CODEX_APP_SERVER_SOCK = previous.sock;
  if (previous.interval == null) delete process.env.COSYNCING_CODEX_SYNC_WATCH_MS; else process.env.COSYNCING_CODEX_SYNC_WATCH_MS = previous.interval;
  if (previous.grace == null) delete process.env.COSYNCING_CODEX_SYNC_DROP_GRACE_POLLS; else process.env.COSYNCING_CODEX_SYNC_DROP_GRACE_POLLS = previous.grace;
  rmSync(home, { recursive: true, force: true });
}
