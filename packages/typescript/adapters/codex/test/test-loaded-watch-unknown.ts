#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionInfo } from '../../../adapter-api/src/index.ts';

const home = mkdtempSync(join(tmpdir(), 'cosyncing-codex-loaded-unknown-'));
const previous = {
  home: process.env.CODEX_HOME,
  sync: process.env.COSYNCING_CODEX_SYNC_SERVER,
  interval: process.env.COSYNCING_CODEX_SYNC_WATCH_MS,
  grace: process.env.COSYNCING_CODEX_SYNC_DROP_GRACE_POLLS,
  sock: process.env.COSYNCING_CODEX_APP_SERVER_SOCK,
};
process.env.CODEX_HOME = home;
process.env.COSYNCING_CODEX_SYNC_SERVER = '1';
process.env.COSYNCING_CODEX_SYNC_WATCH_MS = '250';
process.env.COSYNCING_CODEX_SYNC_DROP_GRACE_POLLS = '1';
// Without a sock the watcher's readScan never consults the injected scanner and presence reads as
// scans-unavailable 'unknown' — a possible owner, which round 4 makes a retirement gate.
process.env.COSYNCING_CODEX_APP_SERVER_SOCK = join(home, 'absent.sock');

try {
  const threadId = '019f-test-loaded-thread';
  const dir = join(home, 'sessions', '2026', '07', '11');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-2026-07-11T00-00-00-${threadId}.jsonl`), `${JSON.stringify({
    timestamp: '2026-07-11T00:00:00.000Z',
    type: 'session_meta',
    payload: { id: threadId, cwd: '/tmp/cosyncing-codex-watch' },
  })}\n${JSON.stringify({
    timestamp: '2026-07-11T00:00:01.000Z',
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: 'native-watch-turn' },
  })}\n`);

  let mode: 'loaded' | 'failure' | 'empty' = 'loaded';
  let nativeActivity: 'working' | 'idle' = 'working';
  // Every probe the watcher makes is counted, so each phase waits on the watcher's own progress
  // (a number of further polls in that mode) instead of a fixed sleep that a loaded box can outrun.
  const probes = { loaded: 0, failure: 0, empty: 0 };
  const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}; probes=${JSON.stringify(probes)} changes=${changes.length}`);
      await Bun.sleep(10);
    }
  };
  const { CodexAdapter } = await import('../src/index.ts');
  const adapter = new CodexAdapter({
    queryLoadedThreadIds: async () => {
      probes[mode] += 1;
      if (mode === 'failure') throw new Error('daemon transport failed');
      return mode === 'loaded' ? new Set([threadId]) : new Set();
    },
    queryLoadedThreadActivities: async () => [{ id: threadId, status: nativeActivity }],
    // R0c.4 round 4: native Idle retires an open turn only with proven OWNER absence, so the
    // no-terminal half of that rule must be explicit — without this the suite consults the real
    // host process scan, and a developer's own codex TUIs make the downgrade nondeterministic.
    scanCodexTuiPresence: async () => ({
      attributed: new Set<string>(),
      unattributed: [],
      privateThreadIds: new Set<string>(),
      privateUnattributed: [],
      unknownUnattributed: [],
      unknownThreadIds: new Set<string>(),
      candidates: [],
      socketDiagAvailable: true,
      processScanAvailable: true,
    }),
  });
  const changes: SessionInfo[] = [];
  const stop = adapter.watchSessionInfo((info) => changes.push(info));
  await waitFor(() => changes.length >= 1, 'the first-poll publication (authoritative loaded state)');
  // R0c.4: the first poll PUBLISHES the state it derived. That seed row is the loaded/Working
  // baseline this test then perturbs, so consume it and keep asserting on later publications only.
  assert.equal(changes.length, 1, 'the first poll publishes the derived loaded row');
  assert.equal(changes[0]?.status, 'working', 'the first-poll seed carries the exact native Working');
  changes.length = 0;

  mode = 'failure';
  // Several failed probes, beyond the one-poll drop grace.
  await waitFor(() => probes.failure >= 3, 'several failed probes');

  mode = 'empty';
  nativeActivity = 'idle';
  // The authoritative empty list is the sentinel: it must publish, and only it may have published
  // since the failed probes (they would otherwise have added their own rows before it).
  await waitFor(() => changes.length >= 1, 'the downgrade publication');
  const downgradedAt = probes.empty;
  await waitFor(() => probes.empty >= downgradedAt + 2, 'two further empty polls');
  assert.equal(changes.length, 1, 'probe errors remain unknown and never synthesize an empty loaded list; an authoritative empty loaded list still publishes the real downgrade exactly once');
  assert.equal(changes[0]?.control?.terminalSync.active, false);
  assert.equal(changes[0]?.status, 'idle', 'point-in-time native Idle retires the sticky rollout start');
  stop();
  console.log('PASS: Codex loaded-list probe failure is unknown; authoritative empty still downgrades');
} finally {
  if (previous.home == null) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous.home;
  if (previous.sync == null) delete process.env.COSYNCING_CODEX_SYNC_SERVER; else process.env.COSYNCING_CODEX_SYNC_SERVER = previous.sync;
  if (previous.interval == null) delete process.env.COSYNCING_CODEX_SYNC_WATCH_MS; else process.env.COSYNCING_CODEX_SYNC_WATCH_MS = previous.interval;
  if (previous.grace == null) delete process.env.COSYNCING_CODEX_SYNC_DROP_GRACE_POLLS; else process.env.COSYNCING_CODEX_SYNC_DROP_GRACE_POLLS = previous.grace;
  if (previous.sock == null) delete process.env.COSYNCING_CODEX_APP_SERVER_SOCK; else process.env.COSYNCING_CODEX_APP_SERVER_SOCK = previous.sock;
  rmSync(home, { recursive: true, force: true });
}
