#!/usr/bin/env bun
/**
 * Session-truth conformance boundary — PERMANENT and REQUIRED.
 *
 * This suite is the single deterministic conformance boundary for session run-state truth. It
 * absorbs four former suites into one process:
 *
 *   phase `attach`      — formerly scripts/broker/tests/codex/test-codex-attach-seed-race.ts
 *                         (observe-attach seed race: stat-memo, activity-cache, terminal-presence
 *                         inputs, and the codexBaselineSourceIntact source fence)
 *   phase `repair`      — formerly scripts/broker/tests/broker/test-live-owner-status-repair.ts
 *                         (lanes S/M/O/O2/W/R: stale-owner repair, mark/emit coherence, observe
 *                         retirement ownership rules, watcher first-poll publication, restart
 *                         during a turn — main and subagent)
 *   phase `convergence` — formerly scripts/broker/tests/codex/test-codex-turn-event-interleaving.ts
 *                         (lanes I/D/E/G/K: permutation convergence, duplicates/replays, terminal
 *                         exactly-once, generation fence, transcript identity and run keys)
 *   phase `fold`        — formerly scripts/broker/tests/broker/test-session-status-interleaving.ts
 *                         (lanes F/W/R/E: Hub fold determinism, watcher-position commutativity,
 *                         replacement seed coherence, Hub-level terminal exactly-once; plus lane R2:
 *                         a proven replacement retires its predecessor before publication)
 *   phase `adapters`    — cross-adapter opt-in manifest (scripts/broker/tests/session-truth-conformance.json),
 *                         FAIL CLOSED: every production-registered adapter class must resolve every
 *                         lane of the matrix with real-suite coverage or a reviewed exclusion, and
 *                         every coverage reference must name a live broker-deterministic sub-suite.
 *
 * Coverage spans main sessions and subagents across attach, watcher, replay, reconnect,
 * replacement, duplicate/stale terminals, status convergence, and transcript chronology. Reverting
 * any protected authority or ordering fence MUST fail a named assertion in this file.
 *
 * Process/env discipline: the Codex adapter reads env-derived constants (CODEX_HOME-derived
 * SESSIONS_ROOT, COSYNCING_CODEX_*) at module load time, so ALL env is set ONCE below, before the
 * first dynamic `await import()` of the adapter, against ONE shared temp CODEX_HOME with ONE unix
 * daemon socket inside it. Phases use disjoint session/thread ids so fixtures never cross-talk;
 * the repair and convergence phases each run their own FakeCodexDaemon on the shared socket path,
 * sequentially. Phase `fold` needs no temp dirs or env and runs inline against a fake adapter.
 *
 * Hermetic: no host Claude/Codex/OpenCode/Pi state, no network ports (the unix socket lives inside
 * the temp dir), bounded waits with deadlines, complete cleanup, zero child processes.
 */
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, writeSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Hub, ManagedConn } from '../../../../packages/typescript/broker/src/hub.ts';
import { RosterRevisionStore } from '../../../../packages/typescript/broker/src/roster-revision.ts';
import {
  createRosterPublicationBoundary,
  NativeIncarnationPublicationAuthority,
  type RosterPublicationBoundary,
} from '../../../../packages/typescript/broker/src/roster-publication.ts';
import { AgentRegistry, type AgentMessage, type SessionConnection, type SessionInfo } from '../../../../packages/typescript/adapter-api/src/index.ts';
import { FakeCodexDaemon } from '../helpers/fake-codex-daemon.ts';
import type { CodexTuiScan } from '../../../../packages/typescript/adapters/codex/src/tui-presence.ts';
import { codexBaselineSourceIntact } from '../../../../packages/typescript/adapters/codex/src/run-state-repair.ts';

// ── the ONE shared hermetic environment, fixed before any adapter module loads ─────────────────
const home = mkdtempSync(join(tmpdir(), 'cosyncing-session-truth-'));
const WATCH_MS = 250;
const sock = join(home, 'app-server-control.sock');
const previous = {
  home: process.env.CODEX_HOME,
  sync: process.env.COSYNCING_CODEX_SYNC_SERVER,
  sock: process.env.COSYNCING_CODEX_APP_SERVER_SOCK,
  watch: process.env.COSYNCING_CODEX_SYNC_WATCH_MS,
  grace: process.env.COSYNCING_CODEX_SYNC_DROP_GRACE_POLLS,
};
process.env.CODEX_HOME = home;
process.env.COSYNCING_CODEX_SYNC_SERVER = '1';
process.env.COSYNCING_CODEX_APP_SERVER_SOCK = sock;
process.env.COSYNCING_CODEX_SYNC_WATCH_MS = String(WATCH_MS);
process.env.COSYNCING_CODEX_SYNC_DROP_GRACE_POLLS = '1';

// Distinct per-phase id ranges (019fc81a… attach, 019fc900… repair, 019fca00… convergence) keep
// every fixture disjoint even though all phases share this one CODEX_HOME.
const cwd = join(home, 'workspace');
const sessions = join(home, 'sessions', '2026', '08', '03');

// ── shared helpers (deduplicated from the four absorbed suites) ────────────────────────────────
const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
const meta = (threadId: string): string => line({
  timestamp: '2026-08-03T00:00:00.000Z',
  type: 'session_meta',
  payload: { id: threadId, cwd },
});
const taskStarted = (turnId: string): string => line({
  timestamp: '2026-08-03T00:00:01.000Z',
  type: 'event_msg',
  payload: { type: 'task_started', turn_id: turnId },
});
const taskComplete = (turnId: string): string => line({
  timestamp: '2026-08-03T00:00:09.000Z',
  type: 'event_msg',
  payload: { type: 'task_complete', turn_id: turnId },
});
/** The attach phase's tool-call line (timestamp :02), kept distinct from the repair phase's (:04). */
const attachToolCall = (callId: string): string => line({
  timestamp: '2026-08-03T00:00:02.000Z',
  type: 'response_item',
  payload: { type: 'function_call', call_id: callId, name: 'shell', arguments: '{}' },
});
const repairToolCall = (callId: string): string => line({
  timestamp: '2026-08-03T00:00:04.000Z',
  type: 'response_item',
  payload: { type: 'function_call', call_id: callId, name: 'shell', arguments: '{}' },
});
const encode = (path: string): string => Buffer.from(path, 'utf8').toString('base64url');

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

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(20);
  }
  console.log(`      (timed out waiting for ${label})`);
  return false;
}

/** Bounded wait for a predicate to hold. Returns whether it ever did. */
async function settlesTo(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(5);
  }
  return predicate();
}

let failures = 0;
const check = (label: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  — ${extra}` : ''}`);
  if (!ok) failures++;
};

const REPAIR_MACHINE = 'live-owner-repair';
const FOLD_MACHINE = 'status-interleaving';

let repairDaemon: FakeCodexDaemon | undefined;
let convergenceDaemon: FakeCodexDaemon | undefined;

try {
  mkdirSync(sessions, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // Phase `attach` — the Codex observe-attach seed race.
  //
  // `attach()` seeds an Observe owner's status from a point-in-time qualification: `statSafe` plus the
  // stat-cached `rolloutFacts` memo plus the <=5s activity cache. Several awaits later
  // `CodexObserveConnection.start()` fixes the live tail at the then-current EOF. A `task_started`
  // written inside that window is BEHIND the tail — it is never emitted as `running` — while the seed
  // still says Idle. The owner then latches Idle, every fence protects it, and tool events keep
  // streaming into a session the roster calls idle. That is the 2026-08-03 reproduction.
  //
  // The window is reproduced exactly, and without a clock, by making the memo stale relative to the
  // bytes: the rollout is written with filler of the same length as the `task_started` record, the
  // memo is warmed at that (size, mtime), and the record is then written IN PLACE with the mtime
  // restored. Size and mtime are unchanged, so the stat-keyed memo still answers `idle` — which is
  // precisely "a qualification snapshot that predates the task_started" — while the baseline scan
  // reads the real bytes.
  //
  // The control is a byte-identical sibling rollout that was never memoized: it must be Working
  // through the ordinary path, so a failure on the memoized twin isolates the seed race rather than
  // the rollout reader.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('── Phase attach: observe-attach seed race ──');
  const attachPhaseStart = failures;
  {
    const MEMOIZED = '019fc81a-0000-7000-8000-00000000aaaa';
    const CONTROL = '019fc81a-0000-7000-8000-00000000bbbb';
    /** Whole seconds so `utimesSync` round-trips the stat key exactly. */
    const FROZEN_MTIME = 1_785_500_000;

    const openTurn = taskStarted('turn-seed-race');
    // Filler of EXACTLY the record's byte length: overwriting it in place cannot change the size.
    const filler = `${'#'.repeat(openTurn.length - 1)}\n`;
    assert.equal(Buffer.byteLength(filler), Buffer.byteLength(openTurn), 'filler must match the record length');

    const memoized = join(sessions, `rollout-2026-08-03T00-00-00-${MEMOIZED}.jsonl`);
    writeFileSync(memoized, meta(MEMOIZED) + filler);
    utimesSync(memoized, FROZEN_MTIME, FROZEN_MTIME);
    const before = statSync(memoized);

    const { CodexAdapter } = await import('../../../../packages/typescript/adapters/codex/src/index.ts');
    const adapter = new CodexAdapter({
      // Both seams are injected so the adapter never reaches the operator's daemon. An empty activity
      // list means "unknown for this thread", which is the qualification context the reproduction had.
      queryLoadedThreadIds: async () => new Set([MEMOIZED, CONTROL]),
      queryLoadedThreadActivities: async () => [],
      scanCodexTuiPresence: async () => emptyScan(),
    });

    // Warm the stat-keyed qualification memo while the rollout has no open turn.
    const seedIdle = await adapter.attach(encode(memoized), 'observe');
    try {
      check('base seed: a rollout with no open turn attaches Idle', seedIdle.info.status === 'idle', `status=${seedIdle.info.status}`);
    } finally {
      await seedIdle.close().catch(() => {});
    }

    // The turn starts INSIDE the seed window: the record lands, the stat key does not move.
    const fd = openSync(memoized, 'r+');
    try {
      writeSync(fd, Buffer.from(openTurn, 'utf8'), 0, Buffer.byteLength(openTurn), Buffer.byteLength(meta(MEMOIZED)));
    } finally {
      closeSync(fd);
    }
    utimesSync(memoized, FROZEN_MTIME, FROZEN_MTIME);
    const after = statSync(memoized);
    check(
      'the qualification memo is stale: size and mtime are unchanged across the task_started write',
      after.size === before.size && after.mtimeMs === before.mtimeMs,
      `size ${before.size}->${after.size} mtimeMs ${before.mtimeMs}->${after.mtimeMs}`,
    );

    // The control: byte-identical content the memo never saw.
    const control = join(sessions, `rollout-2026-08-03T00-00-00-${CONTROL}.jsonl`);
    writeFileSync(control, meta(CONTROL) + openTurn);
    const controlConn = await adapter.attach(encode(control), 'observe');
    try {
      check(
        'control: an unmemoized rollout with the same unmatched task_started attaches Working',
        controlConn.info.status === 'working',
        `status=${controlConn.info.status}`,
      );
    } finally {
      await controlConn.close().catch(() => {});
    }

    const raced = await adapter.attach(encode(memoized), 'observe');
    try {
      // The connection is handed out by `attach`, so asserting on the returned info — before any
      // subscribe — is asserting on the state the Hub will seed its live-owner overlay from.
      check(
        'an observe attach whose qualification snapshot predates task_started is Working before the connection is handed out',
        raced.info.status === 'working',
        `status=${raced.info.status}`,
      );

      // The reproduction's other half: tool events after the baseline still stream. They must not be
      // what makes the session Working — the seed already was — but their absence would mean the tail
      // baseline moved, i.e. the fix bought Working by breaking live delivery.
      const streamed: string[] = [];
      const stop = raced.subscribe((message: any) => streamed.push(String(message?.type ?? '')));
      appendFileSync(memoized, attachToolCall('call-after-baseline'));
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !streamed.includes('tool-call')) await Bun.sleep(25);
      stop();
      check('tool events appended after the tail baseline still stream on the same connection', streamed.includes('tool-call'), `types=${streamed.join(',')}`);
    } finally {
      await raced.close().catch(() => {});
    }

    // The correction is a fresher input to the SAME decision, not a second rule: with no open turn at
    // the boundary the re-derived seed must still be Idle, never a fabricated Working.
    const settled = join(sessions, `rollout-2026-08-03T00-00-00-019fc81a-0000-7000-8000-00000000cccc.jsonl`);
    writeFileSync(
      settled,
      meta('019fc81a-0000-7000-8000-00000000cccc')
      + openTurn
      + line({ timestamp: '2026-08-03T00:00:09.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-seed-race' } }),
    );
    const settledConn = await adapter.attach(encode(settled), 'observe');
    try {
      check('a matched terminal at the boundary still seeds Idle', settledConn.info.status === 'idle', `status=${settledConn.info.status}`);
    } finally {
      await settledConn.close().catch(() => {});
    }

    // A `turn_context` is settings persistence, not lifecycle evidence: it must not admit Working.
    const contextOnly = join(sessions, `rollout-2026-08-03T00-00-00-019fc81a-0000-7000-8000-00000000dddd.jsonl`);
    writeFileSync(
      contextOnly,
      meta('019fc81a-0000-7000-8000-00000000dddd')
      + line({ timestamp: '2026-08-03T00:00:01.000Z', type: 'turn_context', payload: { turn_id: 'turn-context-only', model: 'fake' } }),
    );
    const contextConn = await adapter.attach(encode(contextOnly), 'observe');
    try {
      check('a trailing turn_context is not lifecycle evidence and seeds Idle', contextConn.info.status === 'idle', `status=${contextConn.info.status}`);
    } finally {
      await contextConn.close().catch(() => {});
    }

    // ── the OTHER half of the same race: the <=5s native-activity cache ───────────────────────────
    // `qualifyCodexRolloutStatus` checks exact native idle first and unconditionally, so a cached idle
    // captured BEFORE the turn began demotes the start marker the scan just read — the identical
    // TOCTOU on a different input. The seed must weigh both inputs at one instant. R0c.3's rule that a
    // fresh exact idle retires durable Working has to survive that unchanged, so both directions are
    // pinned here.
    const CACHED = '019fc81a-0000-7000-8000-00000000eeee';
    const cachedPath = join(sessions, `rollout-2026-08-03T00-00-00-${CACHED}.jsonl`);
    writeFileSync(cachedPath, meta(CACHED) + openTurn);
    let activity: 'idle' | 'working' = 'idle';
    let activityProbes = 0;
    const cacheAdapter = new CodexAdapter({
      queryLoadedThreadIds: async () => new Set([CACHED]),
      queryLoadedThreadActivities: async () => {
        activityProbes += 1;
        return [{ id: CACHED, status: activity }];
      },
      scanCodexTuiPresence: async () => emptyScan(),
    });

    // The runtime is genuinely idle right now, so the durable unmatched start is stale evidence and
    // must still be retired — the R0c.3 demotion, unchanged.
    const freshIdle = await cacheAdapter.attach(encode(cachedPath), 'observe');
    try {
      check(
        'a FRESH exact native idle still demotes an unmatched start marker',
        freshIdle.info.status === 'idle',
        `status=${freshIdle.info.status} probes=${activityProbes}`,
      );
    } finally {
      await freshIdle.close().catch(() => {});
    }

    // The turn begins. The activity cache still holds the idle captured before it did; the rollout
    // already holds the start marker. Attaching now is exactly the reproduction.
    activity = 'working';
    const probesBeforeRace = activityProbes;
    const racedByCache = await cacheAdapter.attach(encode(cachedPath), 'observe');
    try {
      check(
        'a cached native Idle predating the scanned start marker seeds Working, not Idle',
        racedByCache.info.status === 'working',
        `status=${racedByCache.info.status}`,
      );
      check(
        'the seed re-probed the runtime instead of trusting the cached activity',
        activityProbes > probesBeforeRace,
        `probes ${probesBeforeRace}->${activityProbes}`,
      );
    } finally {
      await racedByCache.close().catch(() => {});
    }

    // The re-probe is scoped to the contradiction: a rollout with no open turn has nothing that could
    // be demoted, so the seed must not pay for an extra runtime round-trip.
    const quietPath = join(sessions, `rollout-2026-08-03T00-00-00-019fc81a-0000-7000-8000-00000000ffff.jsonl`);
    writeFileSync(quietPath, meta('019fc81a-0000-7000-8000-00000000ffff'));
    const probesBeforeQuiet = activityProbes;
    const quietConn = await cacheAdapter.attach(encode(quietPath), 'observe');
    try {
      check(
        'a rollout with no open turn seeds Idle without an extra runtime probe',
        quietConn.info.status === 'idle' && activityProbes === probesBeforeQuiet,
        `status=${quietConn.info.status} probes ${probesBeforeQuiet}->${activityProbes}`,
      );
    } finally {
      await quietConn.close().catch(() => {});
    }

    // ── the THIRD superseded input: terminal presence ─────────────────────────────────────────────
    // The qualifier's tail branch is `terminalPresence === 'absent' ? 'idle' : 'working'`, so for a
    // thread the daemon does not hold, presence alone decides. A snapshot taken before the TUI
    // launched classifies it absent, and that stale absent demotes a start marker the baseline scan
    // then reads. Refreshing only the activity left this half open; the seed has to re-take EVERY
    // dynamic input the qualifier consults, at one instant.
    const TUI_MAIN = '019fc81a-0000-7000-8000-000000001111';
    const TUI_CHILD = '019fc81a-0000-7000-8000-000000002222';
    const childMeta = (threadId: string, parent: string): string => line({
      timestamp: '2026-08-03T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: threadId,
        cwd,
        thread_source: 'subagent',
        source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } },
      },
    });

    let terminalRunning = false;
    /** When armed, the NEXT scan still reports absent and the terminal appears immediately after —
     *  the exact window between the attach-time classification and the tail baseline scan. */
    let terminalLaunchesAfterNextScan = false;
    let presenceScans = 0;
    const tuiScan = (): CodexTuiScan => {
      presenceScans += 1;
      const scan = emptyScan();
      // The TUI owns the PARENT thread; a subagent has no terminal of its own, which is why the
      // agent-owned branch qualifies through the parent's presence.
      if (terminalRunning) scan.attributed.add(TUI_MAIN.toLowerCase());
      if (terminalLaunchesAfterNextScan) {
        terminalLaunchesAfterNextScan = false;
        terminalRunning = true;
      }
      return scan;
    };
    const tuiAdapter = new CodexAdapter({
      // Neither thread is daemon-loaded, so presence is the only owner evidence there is.
      queryLoadedThreadIds: async () => new Set<string>(),
      queryLoadedThreadActivities: async () => [],
      scanCodexTuiPresence: async () => tuiScan(),
    });

    for (const variant of [
      { name: 'main', threadId: TUI_MAIN, body: (id: string) => meta(id) + taskStarted('turn-tui-main') },
      { name: 'subagent', threadId: TUI_CHILD, body: (id: string) => childMeta(id, TUI_MAIN) + taskStarted('turn-tui-child') },
    ] as const) {
      const path = join(sessions, `rollout-2026-08-03T00-00-00-${variant.threadId}.jsonl`);
      writeFileSync(path, variant.body(variant.threadId));

      // No terminal anywhere: nothing owns the rollout, so the durable start is stale and Idle is
      // right. This also primes the presence snapshot the next attach would otherwise reuse.
      terminalRunning = false;
      const absent = await tuiAdapter.attach(encode(path), 'observe');
      try {
        check(`${variant.name}: with no terminal present the unmatched start still seeds Idle`,
          absent.info.status === 'idle', `status=${absent.info.status}`);
      } finally {
        await absent.close().catch(() => {});
      }

      // The terminal launches INSIDE the attach window: the attach-time classification still reports
      // absent, the terminal appears immediately after, and the baseline scan then reads an open turn.
      terminalRunning = false;
      terminalLaunchesAfterNextScan = true;
      const scansBefore = presenceScans;
      const raced = await tuiAdapter.attach(encode(path), 'observe');
      try {
        check(`${variant.name}: a terminal appearing inside the attach window seeds Working, not Idle`,
          raced.info.status === 'working', `status=${raced.info.status}`);
        check(`${variant.name}: the seed re-scanned presence instead of trusting the snapshot`,
          presenceScans > scansBefore + 1, `scans ${scansBefore}->${presenceScans}`);
      } finally {
        await raced.close().catch(() => {});
      }
    }

    // ── the baseline scan's own source fence ──────────────────────────────────────────────────────
    // The scan that fixes the tail boundary is now run-state authority, so it has to know whether the
    // bytes it read still describe the file this path names. Asserted on the rule rather than by
    // racing a live scan: the window is a few microseconds inside one private call, so a timing-based
    // reproduction would be exactly the flaky wall-clock test this lane keeps removing. The call site
    // is a single application of this predicate.
    {
      const at = (over: Partial<{ dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }> = {}) =>
        ({ dev: 1, ino: 100, size: 4096, mtimeMs: 1_700_000_000_000, ctimeMs: 1_700_000_000_000, ...over });
      const before = at();

      check('fence: an untouched source is intact',
        codexBaselineSourceIntact(before, at(), at(), 4096));
      check('fence: an append during the scan stays intact — the scanned prefix is unchanged',
        codexBaselineSourceIntact(before, at({ size: 9000, mtimeMs: 1_700_000_001_000, ctimeMs: 1_700_000_001_000 }), at({ size: 9000, mtimeMs: 1_700_000_001_000, ctimeMs: 1_700_000_001_000 }), 4096));
      // The descriptor still names the OLD inode after a rename, so this is exactly the case an
      // fd-only comparison could never catch: the fd's own stat is unchanged.
      check('fence: an atomic replacement during the scan invalidates the baseline',
        !codexBaselineSourceIntact(before, at(), at({ ino: 777 }), 4096));
      check('fence: a same-size in-place rewrite invalidates the baseline',
        !codexBaselineSourceIntact(before, at({ mtimeMs: 1_700_000_005_000, ctimeMs: 1_700_000_005_000 }), at({ mtimeMs: 1_700_000_005_000, ctimeMs: 1_700_000_005_000 }), 4096));
      // `utimes` puts the mtime back but cannot rewind ctime — the earlier fixture blocks in this
      // very suite restore mtimes exactly this way. mtime-only fencing accepts this rewrite.
      check('fence: a same-size rewrite that RESTORES the mtime still invalidates the baseline',
        !codexBaselineSourceIntact(before, at({ ctimeMs: 1_700_000_006_000 }), at({ ctimeMs: 1_700_000_006_000 }), 4096));
      check('fence: truncation invalidates the baseline',
        !codexBaselineSourceIntact(before, at({ size: 10 }), at({ size: 10 }), 4096));
      check('fence: an unlinked path invalidates the baseline',
        !codexBaselineSourceIntact(before, at(), undefined, 4096));
      check('fence: a replacement onto a different device invalidates the baseline',
        !codexBaselineSourceIntact(before, at(), at({ dev: 2 }), 4096));
    }
  }
  console.log(failures === attachPhaseStart
    ? 'PASS: Codex observe attach derives its seed from the read that fixes the tail baseline'
    : `FAIL: ${failures - attachPhaseStart} attach-seed-race check(s) failed`);

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // Phase `repair` — the live owner's repair channel.
  //
  // R0c/R0c.1 made the live Hub owner the single run-state authority and R0c.1..R0c.3 fenced every
  // weaker source away from it. What was missing is recovery: the owner's own state is edge-triggered,
  // so one missed edge latched permanently and the fences then protected the wrong value. These lanes
  // pin the repair channel and the two feeds that reach it, against the PRODUCTION Hub, publication
  // boundary, revision journal, Codex adapter, and watcher.
  //
  //   S  stale-owner repair — an attached owner incorrectly Idle, an unmatched native `task_started`,
  //      and a `thread/read` reporting an in-progress turn: roster, Session Detail, watcher, and
  //      direct discovery all become Working within one watcher interval, and the retirement rule is
  //      unchanged (an exact native idle retires the admitted turn only with a matching terminal).
  //   M  mark/emit coherence — after an adapter-internal `markIdle` that emits no frame (the native
  //      reconciliation path), the owner's published status equals `conn.info.status`.
  //   W  watcher first-poll publication — an unowned session's derived state reaches the journal from
  //      the first poll, with no owner and no discovery pass.
  //   R  restart during an active turn — a fresh broker over the same rollouts comes up Working for a
  //      main AND a subagent session with an unmatched turn, and does not resurrect a completed one.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('── Phase repair: live-owner status repair (lanes S, M, O, O2, W, R) ──');
  const repairPhaseStart = failures;
  {
    const LATCHED = '019fc900-0000-7000-8000-0000000000a1';
    const UNOWNED = '019fc900-0000-7000-8000-0000000000a2';
    const MAIN = '019fc900-0000-7000-8000-0000000000a3';
    const SUBAGENT = '019fc900-0000-7000-8000-0000000000a4';
    const SETTLED = '019fc900-0000-7000-8000-0000000000a5';
    const COHERENCE = '019fc900-0000-7000-8000-0000000000a6';
    const OBSERVE_LIVE = '019fc900-0000-7000-8000-0000000000a7';
    const OBSERVE_DEAD = '019fc900-0000-7000-8000-0000000000a8';
    const DAEMON_IDLE_MAIN = '019fc900-0000-7000-8000-0000000000a9';
    const DAEMON_IDLE_SUB = '019fc900-0000-7000-8000-0000000000aa';

    const rolloutPath = (threadId: string): string => join(sessions, `rollout-2026-08-03T00-00-00-${threadId}.jsonl`);
    function writeRollout(threadId: string, body = '', subagentParent?: string): string {
      const path = rolloutPath(threadId);
      writeFileSync(path, line({
        timestamp: '2026-08-03T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: threadId,
          cwd,
          ...(subagentParent
            ? { thread_source: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: subagentParent, depth: 1 } } } }
            : {}),
        },
      }) + body);
      return path;
    }

    /** The newest journaled status for one session id, or undefined when it was never journaled. */
    function journaledStatus(store: RosterRevisionStore, after: number, sessionId: string): string | undefined {
      let status: string | undefined;
      for (const delta of store.eventsAfter(after).deltas) {
        if (delta.sessionId !== sessionId || delta.removed) continue;
        if (delta.session?.status) status = String(delta.session.status);
      }
      return status;
    }

    interface Wiring {
      hub: Hub;
      boundary: RosterPublicationBoundary;
      rosterRevision: RosterRevisionStore;
      adapter: any;
      stopWatch: () => void;
      watched: SessionInfo[];
      detail: { id: string; status: string }[];
      dispose: () => Promise<void>;
    }

    /** The production wiring, assembled exactly as `runtime.ts` does. */
    async function wire(options: {
      loadedThreadIds: () => Promise<Set<string>>;
      activities: () => Promise<{ id: string; status: 'idle' | 'working' | 'needs-input' | 'unknown' }[]>;
      presence?: () => CodexTuiScan;
      watch?: boolean;
    }): Promise<Wiring> {
      const { CodexAdapter } = await import('../../../../packages/typescript/adapters/codex/src/index.ts');
      const adapter = new CodexAdapter({
        queryLoadedThreadIds: options.loadedThreadIds,
        queryLoadedThreadActivities: options.activities,
        scanCodexTuiPresence: async () => options.presence?.() ?? emptyScan(),
      });
      const registry = new AgentRegistry();
      registry.register(adapter);
      const rosterRevision = new RosterRevisionStore(4096);
      const decorate = (info: SessionInfo): SessionInfo => structuredClone({ ...info, machine: REPAIR_MACHINE });
      const detail: { id: string; status: string }[] = [];
      let boundary!: RosterPublicationBoundary;
      const hub = new Hub(registry, 15_000, undefined, {
        onSessionInfo: (info) => {
          // Stands in for a Session Detail socket: the same frame the client stream carries.
          detail.push({ id: info.id, status: String(info.status) });
          boundary.publishOwnerFrame(info);
        },
      });
      const nativeAuthority = new NativeIncarnationPublicationAuthority();
      boundary = createRosterPublicationBoundary({
        liveOwners: () => hub.liveSnapshot(),
        publish: (info) => { rosterRevision.observe(decorate(info), REPAIR_MACHINE); },
        acceptWatcher: (info) => nativeAuthority.acceptsWatcher(info),
        reconcile: (info) => hub.refreshExternalSession(decorate(info)),
        onReconcileError: () => {},
      });
      const watched: SessionInfo[] = [];
      const stopWatch = options.watch === false
        ? () => {}
        : adapter.watchSessionInfo((info: SessionInfo) => {
            watched.push(structuredClone(info));
            boundary.submitWatcherSnapshot(info);
          }) ?? (() => {});
      return {
        hub,
        boundary,
        rosterRevision,
        adapter,
        stopWatch,
        watched,
        detail,
        dispose: async () => {
          stopWatch();
          await boundary.settle().catch(() => {});
          await hub.dispose?.().catch?.(() => {});
        },
      };
    }

    let live: Wiring | undefined;
    let restarted: Wiring | undefined;
    let deadActivity: 'idle' | 'working' = 'working';
    repairDaemon = new FakeCodexDaemon(sock);
    await repairDaemon.start();
    try {
      // ── Lane S — stale-owner repair ───────────────────────────────────────────────────────────
      // The owner attaches to a thread with no open turn and a runtime that reports idle: it latches
      // Idle correctly. The turn then starts WITHOUT the `turn/started` notification ever arriving —
      // the missed edge — so the rollout gains an unmatched task_started and `thread/read` reports the
      // turn, while the owner keeps publishing Idle with every fence protecting it.
      const latchedPath = writeRollout(LATCHED);
      writeRollout(UNOWNED, taskStarted('turn-unowned'));
      let nativeActive = false;
      repairDaemon.configure({
        loadedThreadIds: [LATCHED],
        resumeResult: () => ({ thread: { id: LATCHED, name: 'latched', status: { type: 'idle' } }, model: 'fake-model', modelProvider: 'fake-provider' }),
        readResult: () => (nativeActive
          ? { thread: { id: LATCHED, status: { type: 'active' }, turns: [{ id: 'turn-latched', status: 'in_progress', startedAt: '2026-08-03T00:00:01.000Z' }] } }
          : { thread: { id: LATCHED, status: { type: 'idle' }, turns: [] } }),
        turnsResult: () => ({ data: nativeActive ? [{ id: 'turn-latched', status: 'in_progress', startedAt: '2026-08-03T00:00:01.000Z' }] : [] }),
      });

      live = await wire({
        loadedThreadIds: async () => new Set([LATCHED]),
        activities: async () => [{ id: LATCHED, status: nativeActive ? 'working' : 'idle' }],
      });
      const latchedId = encode(latchedPath);
      const owner = await live.hub.ensure('codex', latchedId);
      check('S the owner starts Idle for a thread the runtime reports idle', owner.status === 'idle', `status=${owner.status}`);
      // A repaired transition is a real turn boundary, so the canonical stream must carry the same run
      // lifecycle a delivered one does: the footer, the Attention observation, and the run key whose
      // release is what lets zero-client retention end.
      const frames: any[] = [];
      const stopFrames = owner.conn.subscribe((message: any) => frames.push(message));
      const runSummaries = (turnId: string, terminal: boolean): any[] => frames.filter((message) =>
        message?.type === 'run-summary' && message.turnId === turnId
        && (terminal ? message.status !== 'running' : message.status === 'running'));

      const baseline = live.rosterRevision.revision;
      const detailFrom = live.detail.length;
      const watchedFrom = live.watched.length;
      // The turn starts. Only the durable rollout and the runtime know; the owner's stream carries
      // nothing — this is the edge the R0c.4 reproduction lost.
      appendFileSync(latchedPath, taskStarted('turn-latched'));
      nativeActive = true;

      const repaired = await waitFor(() => live!.hub.getConn('codex', latchedId)?.status === 'working', 'owner repair');
      check('S the owner repairs to Working from exact native evidence within one watcher interval', repaired,
        `status=${String(live.hub.getConn('codex', latchedId)?.status)}`);
      await live.boundary.settle();

      check('S Session Detail receives the Working projection',
        live.detail.slice(detailFrom).some((frame) => frame.id === latchedId && frame.status === 'working'),
        JSON.stringify(live.detail.slice(detailFrom)));
      check('S the roster journal ends on Working for the repaired session',
        journaledStatus(live.rosterRevision, baseline, latchedId) === 'working',
        `journaled=${String(journaledStatus(live.rosterRevision, baseline, latchedId))}`);
      const watchedWorking = await waitFor(
        () => live!.watched.slice(watchedFrom).some((info) => info.nativeId === LATCHED && info.status === 'working'),
        'watcher Working row',
      );
      check('S the watcher publishes Working for the repaired session', watchedWorking);
      const discovered = (await live.adapter.discoverSessions()).find((info: SessionInfo) => info.nativeId === LATCHED);
      check('S direct discovery reports Working for the repaired session', discovered?.status === 'working', `status=${String(discovered?.status)}`);

      check('S the repaired Working opens a run summary for the exact turn',
        runSummaries('turn-latched', false).length === 1,
        `running summaries=${runSummaries('turn-latched', false).length}`);
      check('S the repaired Working holds attention retention open',
        owner.requiresAttentionRetention === true);

      // Repointing: the runtime reports a DIFFERENT turn in progress. The turn this owner held is over,
      // so its run key must close — otherwise the old lifecycle stays open behind the new one forever.
      repairDaemon.configure({
        readResult: () => ({
          thread: {
            id: LATCHED,
            status: { type: 'active' },
            turns: [
              { id: 'turn-latched', status: 'completed', completedAt: '2026-08-03T00:00:05.000Z' },
              { id: 'turn-latched-2', status: 'in_progress', startedAt: '2026-08-03T00:00:06.000Z' },
            ],
          },
        }),
      });
      await (live.hub.getConn('codex', latchedId)!.conn as any).requestRunStateRepair();
      check('S repointing to a newly discovered turn closes the superseded run lifecycle',
        runSummaries('turn-latched', true).length === 1,
        `terminal summaries for the superseded turn=${runSummaries('turn-latched', true).length}`);
      check('S repointing opens the new turn’s run lifecycle and stays Working',
        runSummaries('turn-latched-2', false).length === 1 && live.hub.getConn('codex', latchedId)?.status === 'working',
        `running summaries=${runSummaries('turn-latched-2', false).length} status=${String(live.hub.getConn('codex', latchedId)?.status)}`);

      // Retirement is unchanged: an exact native idle alone does not retire an admitted turn — only a
      // MATCHING terminal for that exact turn id does. This is the R0c.1/R0c.2 rule the repair must not
      // weaken, so the same channel is driven with the turn still unaccounted for.
      repairDaemon.configure({ readResult: () => ({ thread: { id: LATCHED, status: { type: 'idle' }, turns: [] } }) });
      nativeActive = false;
      await (live.hub.getConn('codex', latchedId)!.conn as any).requestRunStateRepair();
      check('S an exact native idle WITHOUT a matching terminal cannot retire the admitted turn',
        live.hub.getConn('codex', latchedId)?.status === 'working',
        `status=${String(live.hub.getConn('codex', latchedId)?.status)}`);

      repairDaemon.configure({
        readResult: () => ({
          thread: {
            id: LATCHED,
            status: { type: 'idle' },
            turns: [{ id: 'turn-latched-2', status: 'completed', completedAt: '2026-08-03T00:00:12.000Z' }],
          },
        }),
      });
      await (live.hub.getConn('codex', latchedId)!.conn as any).requestRunStateRepair();
      check('S an exact native idle WITH the matching terminal retires it exactly once',
        live.hub.getConn('codex', latchedId)?.status === 'idle',
        `status=${String(live.hub.getConn('codex', latchedId)?.status)}`);
      check('S the repaired terminal emits exactly one terminal run summary for that turn',
        runSummaries('turn-latched-2', true).length === 1,
        `terminal summaries=${runSummaries('turn-latched-2', true).length}`);
      check('S the repaired terminal releases attention retention',
        owner.requiresAttentionRetention === false,
        `retention=${owner.requiresAttentionRetention}`);
      // A repeated repair round must not manufacture a second terminal for the same turn.
      await (live.hub.getConn('codex', latchedId)!.conn as any).requestRunStateRepair();
      check('S a repeated repair round adds no second terminal run summary',
        runSummaries('turn-latched-2', true).length === 1 && runSummaries('turn-latched', true).length === 1,
        `t2=${runSummaries('turn-latched-2', true).length} t1=${runSummaries('turn-latched', true).length}`);
      stopFrames();

      // ── Lane M — mark/emit coherence ──────────────────────────────────────────────────────────
      // `thread/status/changed active` with no exact turn marks unknown and reconciles from native; the
      // reconciliation's markIdle mutates `info.status` and emits NO frame, so the Hub's edge-triggered
      // fold never hears about it. This lane is deliberately isolated from BOTH repair feeds — the
      // watcher is off and native activity is unknown, so nothing can trigger a repair probe — leaving
      // the Hub's own observation of `conn.info.status` as the only way the two can agree.
      await live.dispose();
      live = undefined;
      const coherencePath = writeRollout(COHERENCE);
      repairDaemon.configure({
        loadedThreadIds: [COHERENCE],
        resumeResult: () => ({ thread: { id: COHERENCE, name: 'coherence' }, model: 'fake-model', modelProvider: 'fake-provider' }),
        readResult: () => ({ thread: { id: COHERENCE, status: { type: 'idle' }, turns: [] } }),
        turnsResult: () => ({ data: [] }),
      });
      const coherenceWiring = await wire({
        loadedThreadIds: async () => new Set([COHERENCE]),
        activities: async () => [],
        watch: false,
      });
      try {
        const coherenceId = encode(coherencePath);
        const managed = await coherenceWiring.hub.ensure('codex', coherenceId);
        check('M the coherence owner starts Idle', managed.status === 'idle', `published=${managed.status}`);
        // Each phase is awaited on its own EVIDENCE, never on the end state: the owner already reads
        // Idle at the start, so a predicate that only names the end state is satisfied before anything
        // has happened and would pass with the fold removed.
        const emitted: string[] = [];
        const stopFrames = managed.conn.subscribe((message: any) => {
          if (message?.type === 'status') emitted.push(String(message.status));
        });
        try {
          repairDaemon.notify('thread/status/changed', { threadId: COHERENCE, status: { type: 'active', activeFlags: [] } });
          const admitted = await waitFor(() => emitted.includes('running'), 'the exact running frame');
          // Only that the frame was DELIVERED is asserted, never that Working is still observable: the
          // reconciliation that follows can land first on a fast host, and the coherence property under
          // test does not depend on catching the intermediate state.
          check('M the active thread status delivers an exact running frame the Hub folds',
            admitted, `frames=${emitted.join(',')}`);
          // The reconciliation's markIdle mutates `info.status` and emits NOTHING; waiting on the
          // adapter-side value is therefore waiting on the divergence itself.
          const silentlyIdle = await waitFor(
            () => managed.conn.info.status === 'idle',
            'the silent adapter-side markIdle',
          );
          check('M the adapter marked itself idle without emitting a status frame',
            silentlyIdle && !emitted.slice(emitted.indexOf('running')).includes('idle'),
            `frames=${emitted.join(',')} conn.info.status=${managed.conn.info.status}`);
          check('M after an adapter-internal markIdle with no status frame, the published status equals conn.info.status',
            managed.status === 'idle' && managed.status === managed.conn.info.status,
            `published=${managed.status} conn.info.status=${managed.conn.info.status}`);
        } finally {
          stopFrames();
        }
      } finally {
        await coherenceWiring.dispose();
      }

      // ── Lane O — observe-owner retirement needs both exact sources to agree ────────────────────
      // An Observe owner's Idle is the status-flip class this lane exists to close. An exact open turn
      // retires on exactly two grounds: the rollout accounting for it with a matching terminal, or the
      // corroborated ABSENCE of every possible owner. Frozen bytes are explicitly NOT a ground — a quiet
      // tool call or a subagent can append nothing for many intervals while genuinely working, and a
      // daemon's idle says nothing about a turn a terminal owns, because they are different processes.
      {
        const livePath = writeRollout(OBSERVE_LIVE, taskStarted('turn-observe-live'));
        let terminalAttached = true;
        const presence = (): CodexTuiScan => {
          const scan = emptyScan();
          // A plain TUI writing this rollout: not joined to the daemon (so it is absent from the
          // activity map), but provably present as a process.
          if (terminalAttached) scan.attributed.add(OBSERVE_LIVE.toLowerCase());
          return scan;
        };
        const observeWiring = await wire({
          loadedThreadIds: async () => new Set([OBSERVE_DEAD]),
          // OBSERVE_LIVE is deliberately absent from the daemon's view — the quiet-tool case is a turn
          // the daemon does not own at all, so its silence must not read as an idle owner.
          activities: async () => [{ id: OBSERVE_DEAD, status: deadActivity }],
          presence,
          watch: false, // the repair rounds are driven explicitly so each one is a known observation
        });
        try {
          const liveId = encode(livePath);
          const owner = await observeWiring.hub.ensure('codex', liveId, 'observe');
          const repair = (): Promise<void> => (owner.conn as any).requestRunStateRepair();
          check('O the observe owner starts Working from its unmatched start', owner.status === 'working', `status=${owner.status}`);

          // THE QUIET-TOOL CLASS. Nothing is appended for round after round while a terminal owns the
          // turn. An owner exists, so no number of identical observations may retire it.
          let quietHeld = true;
          for (let round = 0; round < 5; round++) {
            await repair();
            if (owner.status !== 'working') quietHeld = false;
          }
          check('O a quiet turn with a terminal present stays Working across repeated identical rounds',
            quietHeld && owner.status === 'working', `status=${owner.status}`);

          // Appending changes nothing about the rule — the owner is what holds it, not the bytes.
          appendFileSync(livePath, repairToolCall('call-live-1'));
          await repair();
          check('O an append with the terminal still present keeps it Working',
            owner.status === 'working', `status=${owner.status}`);

          // The terminal exits without writing a terminal marker: now NO owner can be writing this
          // rollout — the daemon does not hold the thread and no process is present. That is R0c.3's
          // dead-turn class, and it must still retire.
          terminalAttached = false;
          await repair();
          check('O owner absence alone does not retire on the first observation',
            owner.status === 'working', `status=${owner.status}`);
          await repair();
          check('O corroborated absence of every owner retires the abandoned turn',
            owner.status === 'idle', `status=${owner.status}`);
          await observeWiring.boundary.settle();

          // A matching terminal in the rollout retires on the FIRST round, with no corroboration and
          // regardless of ownership — and proves the probe bypasses the ≤5s activity cache, which was
          // primed with Working by the attach moments earlier.
          const deadPath = writeRollout(OBSERVE_DEAD, taskStarted('turn-observe-dead'));
          const deadId = encode(deadPath);
          const deadOwner = await observeWiring.hub.ensure('codex', deadId, 'observe');
          check('O the second observe owner starts Working', deadOwner.status === 'working', `status=${deadOwner.status}`);
          appendFileSync(deadPath, taskComplete('turn-observe-dead'));
          deadActivity = 'idle';
          await (deadOwner.conn as any).requestRunStateRepair();
          check('O a matching terminal in the rollout retires on the first round',
            deadOwner.status === 'idle', `status=${deadOwner.status}`);
        } finally {
          await observeWiring.dispose();
        }
      }

      // ── Lane O2 — daemon Idle is not owner absence while a terminal is present (round 4) ───────
      // Rule (b) is OWNER absence. A daemon reporting the thread idle has proven only that the DAEMON
      // is not running the turn: a present terminal — for a subagent, the PARENT's terminal — is still
      // a possible owner whose turn the daemon cannot see, because they are different processes. The
      // round-3 O-lane kept the live session out of the activity map entirely; this lane puts an exact
      // daemon Idle IN the map and requires the present terminal to hold Working anyway, for the main
      // and the agent-owned child alike. Only the terminal's exit turns daemon Idle into owner absence.
      {
        const mainPath = writeRollout(DAEMON_IDLE_MAIN, taskStarted('turn-di-main'));
        const subPath = writeRollout(DAEMON_IDLE_SUB, taskStarted('turn-di-sub'), DAEMON_IDLE_MAIN);
        let terminalAttached = true;
        const wiring = await wire({
          loadedThreadIds: async () => new Set([DAEMON_IDLE_MAIN, DAEMON_IDLE_SUB]),
          activities: async () => [
            { id: DAEMON_IDLE_MAIN, status: 'idle' },
            { id: DAEMON_IDLE_SUB, status: 'idle' },
          ],
          presence: () => {
            const scan = emptyScan();
            if (terminalAttached) scan.attributed.add(DAEMON_IDLE_MAIN.toLowerCase());
            return scan;
          },
          watch: false,
        });
        try {
          const mainOwner = await wiring.hub.ensure('codex', encode(mainPath), 'observe');
          const subOwner = await wiring.hub.ensure('codex', encode(subPath), 'observe');
          const repairBoth = async (): Promise<void> => {
            await (mainOwner.conn as any).requestRunStateRepair();
            await (subOwner.conn as any).requestRunStateRepair();
          };
          check('O2 the main session starts Working from its unmatched start', mainOwner.status === 'working', `status=${mainOwner.status}`);
          check('O2 the subagent starts Working from its unmatched start', subOwner.status === 'working', `status=${subOwner.status}`);

          let held = true;
          for (let round = 0; round < 4; round++) {
            await repairBoth();
            if (mainOwner.status !== 'working' || subOwner.status !== 'working') held = false;
          }
          check('O2 an exact daemon Idle with the terminal PRESENT does not retire the main turn',
            held && mainOwner.status === 'working', `status=${mainOwner.status}`);
          check('O2 an exact daemon Idle with the parent terminal PRESENT does not retire the subagent turn',
            held && subOwner.status === 'working', `status=${subOwner.status}`);

          // The terminal exits: daemon idle + no possible owner is rule (b), corroborated as usual.
          terminalAttached = false;
          await repairBoth();
          await repairBoth();
          check('O2 after the terminal exits, daemon Idle retires the main turn as owner absence',
            mainOwner.status === 'idle', `status=${mainOwner.status}`);
          check('O2 after the terminal exits, daemon Idle retires the subagent turn as owner absence',
            subOwner.status === 'idle', `status=${subOwner.status}`);
        } finally {
          await wiring.dispose();
        }
      }

      // ── Lane W — watcher first-poll publication for an unowned session ─────────────────────────
      // A separate wiring so the poll under test IS a first poll. No owner exists for UNOWNED and no
      // discovery pass runs, so only the watcher can put it in the journal.
      const unownedWiring = await wire({
        loadedThreadIds: async () => new Set([UNOWNED]),
        activities: async () => [{ id: UNOWNED, status: 'working' }],
      });
      try {
        const unownedId = encode(rolloutPath(UNOWNED));
        const reached = await waitFor(
          () => journaledStatus(unownedWiring.rosterRevision, 0, unownedId) !== undefined,
          'watcher first-poll journal row',
        );
        check('W the watcher first poll publishes an unowned session into the revision journal', reached,
          `journaled=${String(journaledStatus(unownedWiring.rosterRevision, 0, unownedId))}`);
        check('W that first-poll row carries the exact native Working state',
          journaledStatus(unownedWiring.rosterRevision, 0, unownedId) === 'working',
          `journaled=${String(journaledStatus(unownedWiring.rosterRevision, 0, unownedId))}`);
        check('W no owner was created for the unowned session',
          unownedWiring.hub.getConn('codex', unownedId) === undefined);
      } finally {
        await unownedWiring.dispose();
      }

      // ── Lane R — restart during an active turn (main and subagent) ─────────────────────────────
      // The "restart" is a fresh Hub, boundary, adapter, and watcher over the SAME rollouts: nothing of
      // the previous broker's in-memory turn state survives, which is exactly what a restart destroys.
      const mainPath = writeRollout(MAIN, taskStarted('turn-main'));
      const subagentPath = writeRollout(SUBAGENT, taskStarted('turn-sub'), MAIN);
      writeRollout(SETTLED, taskStarted('turn-settled') + taskComplete('turn-settled'));
      repairDaemon.configure({ loadedThreadIds: [] });
      restarted = await wire({
        loadedThreadIds: async () => new Set([MAIN, SUBAGENT]),
        activities: async () => [],
        watch: false,
      });
      for (const [label, path] of [['main', mainPath], ['subagent', subagentPath]] as const) {
        const id = encode(path);
        const conn = await restarted.hub.ensure('codex', id, 'observe');
        check(`R a ${label} session with an unmatched turn comes up Working after restart`,
          conn.status === 'working', `status=${conn.status}`);
      }
      // The restarted broker's first roster pass: discovery rows qualified through the same publication
      // boundary the runtime uses, so this asserts what the journal — and therefore /api/sessions —
      // actually carries after a restart, not just the owner's in-memory state.
      for (const info of await restarted.adapter.discoverSessions()) restarted.boundary.publishOwnerFrame(info);
      await restarted.boundary.settle();
      for (const [label, path] of [['main', mainPath], ['subagent', subagentPath]] as const) {
        const id = encode(path);
        check(`R the restarted roster journals Working for the ${label} session`,
          journaledStatus(restarted.rosterRevision, 0, id) === 'working',
          `journaled=${String(journaledStatus(restarted.rosterRevision, 0, id))}`);
      }
      const settledConn = await restarted.hub.ensure('codex', encode(rolloutPath(SETTLED)), 'observe');
      check('R a completed turn is not resurrected by the restart', settledConn.status === 'idle', `status=${settledConn.status}`);
    } finally {
      await live?.dispose().catch(() => {});
      await restarted?.dispose().catch(() => {});
      await repairDaemon.stop().catch(() => {});
      repairDaemon = undefined;
    }
  }
  console.log(failures === repairPhaseStart
    ? 'PASS: live-owner status repair held across stale-owner, coherence, watcher first-poll, and restart lanes'
    : `FAIL: ${failures - repairPhaseStart} live-owner repair check(s) failed`);

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // Phase `convergence` — Codex daemon-event interleaving and terminal exactly-once.
  //
  // Run-state correctness is an event-ORDERING property, which is why the R0c series kept regressing:
  // each round pinned the interleaving that had just failed, and the next timing change found a new
  // one. Phase `fold` sweeps orderings at the Hub/publication boundary; this phase does it one layer
  // down, at the PRODUCTION `CodexResumeConnection` fed by a real unix-socket daemon, where the turn
  // vocabulary actually lives.
  //
  //   I  interleaving convergence — every permutation of one turn's notifications (`turn/started`,
  //      `turn/completed`, and `thread/status/changed` active/idle/notLoaded) converges to the
  //      derivation of the complete record, at the adapter AND at the Hub fold.
  //   D  duplicates and replays — delivering the whole set twice, in two different orders, still
  //      converges and still yields exactly one terminal run-summary.
  //   E  terminal exactly-once — while a turn is admitted, weak idle/notLoaded frames, a foreign
  //      completion, an id-less completion, and duplicate completions add no Idle transition; the
  //      matching terminal adds exactly one.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('── Phase convergence: turn-event interleaving (lanes I, D, E, G, K) ──');
  const convergencePhaseStart = failures;
  {
    const THREAD = '019fca00-0000-7000-8000-00000000000f';
    const TURN = 'turn-interleaved';
    const FOREIGN_TURN = 'turn-foreign';
    const rollout = join(sessions, `rollout-2026-08-03T00-00-00-${THREAD}.jsonl`);

    type Event = { name: string; method: string; params: unknown };

    const EVENTS: Event[] = [
      { name: 'started', method: 'turn/started', params: { threadId: THREAD, turn: { id: TURN } } },
      { name: 'active', method: 'thread/status/changed', params: { threadId: THREAD, status: { type: 'active', activeFlags: [] } } },
      { name: 'idle', method: 'thread/status/changed', params: { threadId: THREAD, status: { type: 'idle' } } },
      { name: 'notLoaded', method: 'thread/status/changed', params: { threadId: THREAD, status: { type: 'notLoaded' } } },
      {
        name: 'completed',
        method: 'turn/completed',
        params: {
          threadId: THREAD,
          turn: { id: TURN, status: 'completed', createdAt: '2026-08-03T00:00:00.000Z', completedAt: '2026-08-03T00:00:08.000Z' },
        },
      },
    ];

    function permutations<T>(items: T[]): T[][] {
      if (items.length <= 1) return [items];
      const out: T[][] = [];
      for (let i = 0; i < items.length; i++) {
        const rest = [...items.slice(0, i), ...items.slice(i + 1)];
        for (const tail of permutations(rest)) out.push([items[i]!, ...tail]);
      }
      return out;
    }

    convergenceDaemon = new FakeCodexDaemon(sock, {
      loadedThreadIds: [THREAD],
      // No status in the resume result: the seed is deliberately empty so the notifications under test
      // are the ONLY run-state evidence the connection has.
      resumeResult: () => ({ thread: { id: THREAD, name: 'interleaved' }, model: 'fake-model', modelProvider: 'fake-provider' }),
      // The runtime's own truth for the complete record: the turn ran and completed. A reconciliation
      // triggered by an out-of-order `active` frame must therefore agree with the derivation, not fight
      // it — that agreement is what "converges" means here.
      readResult: () => ({ thread: { id: THREAD, status: { type: 'idle' }, turns: [{ id: TURN, status: 'completed' }] } }),
      turnsResult: () => ({ data: [{ id: TURN, status: 'completed' }] }),
    });

    let sentinel = 0;
    /** Deliver `events` in order, then a sentinel whose canonical message proves the whole batch was
     *  consumed — the socket preserves order, so no wall-clock settle is needed. */
    async function deliver(events: Event[], seen: AgentMessage[]): Promise<boolean> {
      for (const event of events) convergenceDaemon!.notify(event.method, event.params);
      const marker = ++sentinel * 1_000;
      convergenceDaemon!.notify('thread/tokenUsage/updated', { threadId: THREAD, tokenUsage: { total: { inputTokens: marker, outputTokens: 0, cachedInputTokens: 0 } } });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (seen.some((m: any) => m?.type === 'token-count' && m.input === marker)) return true;
        await Bun.sleep(5);
      }
      return false;
    }

    const rolloutLine = (value: unknown): string => `${JSON.stringify({ timestamp: '2026-08-03T01:00:00.000Z', ...(value as object) })}\n`;

    async function withOwner(
      fn: (conn: SessionConnection, managed: ManagedConn, seen: AgentMessage[]) => Promise<void>,
    ): Promise<void> {
      const { CodexAdapter } = await import('../../../../packages/typescript/adapters/codex/src/index.ts');
      const adapter = new CodexAdapter({
        queryLoadedThreadIds: async () => new Set([THREAD]),
        queryLoadedThreadActivities: async () => [],
        scanCodexTuiPresence: async () => emptyScan(),
      });
      const conn = await adapter.attach(encode(rollout));
      const seen: AgentMessage[] = [];
      // The production Hub wrapper, so the assertions cover the fold the roster publishes from — not
      // just the adapter's private state.
      const managed = new ManagedConn(conn);
      const stop = conn.subscribe((message) => seen.push(message));
      try {
        await fn(conn, managed, seen);
      } finally {
        stop();
        await managed.dispose().catch(() => {});
      }
    }

    const statusFrames = (seen: AgentMessage[]): string[] =>
      seen.filter((m: any) => m?.type === 'status').map((m: any) => String(m.status));
    const terminalSummaries = (seen: AgentMessage[]): any[] =>
      seen.filter((m: any) => m?.type === 'run-summary' && m.turnId === TURN && m.status !== 'running');

    writeFileSync(rollout, `${JSON.stringify({
      timestamp: '2026-08-03T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: THREAD, cwd },
    })}\n`);
    await convergenceDaemon.start();
    try {
      // ── Lane I — every permutation converges to the complete-record derivation ─────────────────
      const orders = permutations(EVENTS);
      const divergent: string[] = [];
      const multipleTerminals: string[] = [];
      for (const order of orders) {
        await withOwner(async (conn, managed, seen) => {
          const delivered = await deliver(order, seen);
          const names = order.map((event) => event.name).join(',');
          if (!delivered) {
            divergent.push(`${names}: delivery never settled`);
            return;
          }
          // The complete record is "turn TURN started and completed", whose derivation is Idle.
          //
          // Awaited, not sampled: an out-of-order `active` frame starts a native reconciliation whose
          // reply travels after this batch's sentinel, so a permutation ending on `active` is legitimately
          // mid-flight at this point. CONVERGENCE is the property under test, and a bounded wait cannot
          // mask a real divergence — an interleaving that settles on the wrong state settles there and
          // stays, so the wait expires and the permutation is still recorded.
          if (!await settlesTo(() => conn.info.status === 'idle' && managed.status === 'idle')) {
            divergent.push(`${names}: adapter=${conn.info.status} hub=${managed.status}`);
          }
          const terminals = terminalSummaries(seen);
          if (terminals.length !== 1) multipleTerminals.push(`${names}: ${terminals.length}`);
        });
      }
      check(`I all ${orders.length} permutations of one turn's notifications converge to the complete-record derivation`,
        divergent.length === 0, divergent.slice(0, 4).join(' | '));
      check('I every permutation emits exactly one terminal run-summary for the turn',
        multipleTerminals.length === 0, multipleTerminals.slice(0, 4).join(' | '));

      // ── Lane D — duplicates and replays ───────────────────────────────────────────────────────
      await withOwner(async (conn, managed, seen) => {
        const forward = [...EVENTS];
        const reversed = [...EVENTS].reverse();
        const first = await deliver(forward, seen);
        const second = await deliver(reversed, seen);
        const third = await deliver(forward, seen);
        const converged = await settlesTo(() => conn.info.status === 'idle' && managed.status === 'idle');
        check('D a replayed and re-ordered redelivery of the same turn still converges to Idle',
          first && second && third && converged,
          `adapter=${conn.info.status} hub=${managed.status}`);
        check('D three deliveries of the same turn still yield exactly one terminal run-summary',
          terminalSummaries(seen).length === 1, `terminals=${terminalSummaries(seen).length}`);
      });

      // ── Lane E — terminal exactly-once while a turn is admitted ───────────────────────────────
      await withOwner(async (conn, managed, seen) => {
        const admitted = await deliver([EVENTS[0]!], seen);
        check('E the turn is admitted Working from its exact start', admitted && managed.status === 'working', `hub=${managed.status}`);
        const beforeIdles = statusFrames(seen).filter((status) => status === 'idle').length;

        await deliver([
          EVENTS[2]!, // weak thread idle
          EVENTS[3]!, // weak notLoaded
          EVENTS[2]!, // duplicate weak idle
          { name: 'foreign', method: 'turn/completed', params: { threadId: THREAD, turn: { id: FOREIGN_TURN, status: 'completed' } } },
          { name: 'idless', method: 'turn/completed', params: { threadId: THREAD, turn: { status: 'completed' } } },
        ], seen);
        check('E weak idle/notLoaded, a foreign completion, and an id-less completion add no Idle transition',
          statusFrames(seen).filter((status) => status === 'idle').length === beforeIdles && managed.status === 'working',
          `idles=${statusFrames(seen).filter((s) => s === 'idle').length} before=${beforeIdles} hub=${managed.status}`);

        await deliver([EVENTS[4]!, EVENTS[4]!, EVENTS[4]!], seen);
        check('E the exact matching terminal adds exactly one Idle transition, duplicates add none',
          statusFrames(seen).filter((status) => status === 'idle').length === beforeIdles + 1 && managed.status === 'idle',
          `idles=${statusFrames(seen).filter((s) => s === 'idle').length} expected=${beforeIdles + 1} hub=${managed.status}`);
        check('E the completed turn produced exactly one terminal run-summary',
          terminalSummaries(seen).length === 1, `terminals=${terminalSummaries(seen).length}`);
        check('E the adapter projection and the Hub fold agree after the terminal',
          conn.info.status === managed.status, `adapter=${conn.info.status} hub=${managed.status}`);
      });

      // ── Lane G — generation fence on a reused turn id ─────────────────────────────────────────
      // The replay guard settles Idle for any start bearing a recently-completed id, which is right for
      // a redelivered start and wrong for a runtime that genuinely reuses the id — the real turn would
      // be swallowed and the session would sit Idle through it. The runtime's own timestamps separate
      // the two: a start that began after the recorded completion cannot be that completion's start.
      await withOwner(async (conn, managed, seen) => {
        await deliver([EVENTS[0]!, EVENTS[4]!], seen);
        check('G the first generation completes normally', managed.status === 'idle' && terminalSummaries(seen).length === 1,
          `hub=${managed.status} terminals=${terminalSummaries(seen).length}`);

        // A redelivery of that same start — no timestamp, so nothing proves a new turn.
        await deliver([EVENTS[0]!], seen);
        check('G a redelivered start with no timestamp is still treated as a replay',
          managed.status === 'idle' && terminalSummaries(seen).length === 1,
          `hub=${managed.status} terminals=${terminalSummaries(seen).length}`);

        // A start whose own timestamp PREDATES the recorded completion is likewise an old start.
        await deliver([{
          name: 'stale-start',
          method: 'turn/started',
          params: { threadId: THREAD, turn: { id: TURN, startedAt: '2026-08-03T00:00:00.000Z' } },
        }], seen);
        check('G a start older than the recorded completion is still a replay',
          managed.status === 'idle', `hub=${managed.status}`);

        // A start that began AFTER the recorded completion is a new turn reusing the id.
        await deliver([{
          name: 'new-generation',
          method: 'turn/started',
          params: { threadId: THREAD, turn: { id: TURN, startedAt: '2026-08-03T00:00:30.000Z' } },
        }], seen);
        check('G a start newer than the recorded completion admits a new generation as Working',
          conn.info.status === 'working' && managed.status === 'working',
          `adapter=${conn.info.status} hub=${managed.status}`);

        // The new generation owns its own terminal: the retired record must not swallow it.
        await deliver([{
          name: 'new-generation-completed',
          method: 'turn/completed',
          params: {
            threadId: THREAD,
            turn: { id: TURN, status: 'completed', createdAt: '2026-08-03T00:00:30.000Z', completedAt: '2026-08-03T00:00:38.000Z' },
          },
        }], seen);
        check('G the new generation emits its own terminal and settles Idle',
          managed.status === 'idle' && terminalSummaries(seen).length === 2,
          `hub=${managed.status} terminals=${terminalSummaries(seen).length}`);
      });

      // ── Lane K — a reused turn id keeps two generations' transcript identities apart ───────────
      // Admitting the second generation is only half the job: its prompt and answer must be distinct
      // canonical rows from the first's, its footer must name its OWN prompt, and — because a client
      // rebuilds the same session from the rollout after a reconnect — the live keys and the replayed
      // keys must be the same ordered sequence. The prompt ordinal is what carries that: it counts per
      // turn id across the whole file, so it must NOT restart at zero for a new generation.
      await withOwner(async (conn, _managed, seen) => {
        const userKeys = (): string[] => seen.filter((m: any) => m?.type === 'user-message').map((m: any) => String(m.key));
        const assistantKeys = (): string[] => seen.filter((m: any) => m?.type === 'model-output' && m.text).map((m: any) => String(m.key));
        const summaryFor = (completedAt: string): any => seen.filter((m: any) =>
          m?.type === 'run-summary' && m.turnId === TURN && m.status !== 'running'
          && m.completedAt === Date.parse(completedAt)).at(-1);

        // Generation one: prompt, answer, terminal.
        await deliver([
          EVENTS[0]!,
          { name: 'g1-user', method: 'item/started', params: { threadId: THREAD, turnId: TURN, item: { type: 'userMessage', id: 'item-u-g1', content: [{ type: 'text', text: 'first generation prompt' }] } } },
          { name: 'g1-answer', method: 'item/completed', params: { threadId: THREAD, turnId: TURN, item: { type: 'agentMessage', id: 'item-a-g1', text: 'first generation answer' } } },
          {
            name: 'g1-completed',
            method: 'turn/completed',
            params: { threadId: THREAD, turn: { id: TURN, status: 'completed', createdAt: '2026-08-03T01:00:00.000Z', completedAt: '2026-08-03T01:00:08.000Z' } },
          },
        ], seen);
        const generationOneUser = [...userKeys()];
        const generationOneAssistant = [...assistantKeys()];
        check('K generation one published one prompt and one answer',
          generationOneUser.length === 1 && generationOneAssistant.length === 1,
          `user=${generationOneUser.join(',')} assistant=${generationOneAssistant.join(',')}`);

        // Generation two reuses the id, proven new by its own start timestamp.
        await deliver([
          { name: 'g2-start', method: 'turn/started', params: { threadId: THREAD, turn: { id: TURN, startedAt: '2026-08-03T01:00:30.000Z' } } },
          { name: 'g2-user', method: 'item/started', params: { threadId: THREAD, turnId: TURN, item: { type: 'userMessage', id: 'item-u-g2', content: [{ type: 'text', text: 'second generation prompt' }] } } },
          { name: 'g2-answer', method: 'item/completed', params: { threadId: THREAD, turnId: TURN, item: { type: 'agentMessage', id: 'item-a-g2', text: 'second generation answer' } } },
          {
            name: 'g2-completed',
            method: 'turn/completed',
            params: { threadId: THREAD, turn: { id: TURN, status: 'completed', createdAt: '2026-08-03T01:00:30.000Z', completedAt: '2026-08-03T01:00:38.000Z' } },
          },
        ], seen);
        const liveUser = userKeys();
        const liveAssistant = assistantKeys();
        check('K generation one’s published keys are unchanged by the second generation',
          liveUser[0] === generationOneUser[0] && liveAssistant[0] === generationOneAssistant[0],
          `user=${liveUser.join(',')} assistant=${liveAssistant.join(',')}`);
        check('K the second generation’s prompt and answer are DISTINCT canonical rows',
          liveUser.length === 2 && liveUser[1] !== liveUser[0]
          && liveAssistant.length === 2 && liveAssistant[1] !== liveAssistant[0],
          `user=${liveUser.join(',')} assistant=${liveAssistant.join(',')}`);
        check('K the second generation’s footer names its OWN prompt, not the first’s',
          summaryFor('2026-08-03T01:00:38.000Z')?.userMessageKey === liveUser[1],
          `summary=${JSON.stringify(summaryFor('2026-08-03T01:00:38.000Z') ?? null)} expected=${liveUser[1]}`);
        check('K the first generation’s footer still names the first prompt',
          summaryFor('2026-08-03T01:00:08.000Z')?.userMessageKey === liveUser[0],
          `summary=${JSON.stringify(summaryFor('2026-08-03T01:00:08.000Z') ?? null)} expected=${liveUser[0]}`);

        // Convergence: the same two generations as the rollout would persist them. A reconnecting client
        // rebuilds from these bytes, so the replayed identities must be the live ones.
        appendFileSync(rollout, [
          rolloutLine({ type: 'event_msg', payload: { type: 'task_started', turn_id: TURN } }),
          rolloutLine({ type: 'event_msg', payload: { type: 'user_message', message: 'first generation prompt' } }),
          rolloutLine({ type: 'event_msg', payload: { type: 'task_complete', turn_id: TURN } }),
          rolloutLine({ type: 'event_msg', payload: { type: 'task_started', turn_id: TURN } }),
          rolloutLine({ type: 'event_msg', payload: { type: 'user_message', message: 'second generation prompt' } }),
          rolloutLine({ type: 'event_msg', payload: { type: 'task_complete', turn_id: TURN } }),
        ].join(''));
        const history = await conn.getHistory();
        const historyUser = history.filter((m: any) => m?.type === 'user-message').map((m: any) => String(m.key));
        check('K a rollout replay of the reused id yields the SAME ordered keys the live path published',
          historyUser.join(',') === liveUser.join(','),
          `history=${historyUser.join(',')} live=${liveUser.join(',')}`);
        // The replay's own footers must attach per generation too, for the same reason the live ones do:
        // a client rebuilding from these bytes would otherwise show the second turn owning the first
        // turn's prompt. The generation boundary here is visible purely in record order — a start for an
        // id whose terminal already appeared — which is what lets both paths agree without sharing state.
        const historySummaries: any[] = history.filter((m: any) =>
          m?.type === 'run-summary' && m.turnId === TURN && m.status !== 'running');
        check('K the replay attaches each generation’s footer to its own prompt',
          historySummaries.length === 2
          && historySummaries[0]?.userMessageKey === historyUser[0]
          && historySummaries[1]?.userMessageKey === historyUser[1],
          `summaries=${JSON.stringify(historySummaries.map((m: any) => m.userMessageKey))} users=${historyUser.join(',')}`);

        // Canonical RUN identity (round 4). Distinct emissions are not enough: canonical identity
        // downstream is exactly type+key — the Flutter reducer merges equal pairs (the second footer
        // would REPLACE the first) and Attention derives its observation/dedupe identity from this key.
        // The two generations must therefore mint distinct run keys, identically on both paths.
        const liveTerminalRunKeys = seen.filter((m: any) =>
          m?.type === 'run-summary' && m.turnId === TURN && m.status !== 'running')
          .map((m: any) => String(m.key));
        check('K the two generations carry DISTINCT canonical run keys',
          liveTerminalRunKeys.length === 2 && liveTerminalRunKeys[0] !== liveTerminalRunKeys[1],
          `keys=${liveTerminalRunKeys.join(',')}`);
        const historyRunKeys = historySummaries.map((m: any) => String(m.key));
        check('K the replay mints the SAME per-generation run keys the live path published',
          historyRunKeys.join(',') === liveTerminalRunKeys.join(','),
          `history=${historyRunKeys.join(',')} live=${liveTerminalRunKeys.join(',')}`);

        // A reused generation that also repeats an ITEM id is a new prompt, not a redelivery: the
        // idempotent re-delivery memory is generation-scoped (round 4). With it left intact across the
        // boundary, liveUserMessageKey answers with the PREVIOUS generation's key and merges the two
        // prompts into one row.
        const REUSED = 'turn-reused-item';
        await deliver([
          { name: 'r1-start', method: 'turn/started', params: { threadId: THREAD, turn: { id: REUSED, startedAt: '2026-08-03T02:00:00.000Z' } } },
          { name: 'r1-user', method: 'item/started', params: { threadId: THREAD, turnId: REUSED, item: { type: 'userMessage', id: 'item-u-shared', content: [{ type: 'text', text: 'reused-item generation one' }] } } },
          { name: 'r1-completed', method: 'turn/completed', params: { threadId: THREAD, turn: { id: REUSED, status: 'completed', createdAt: '2026-08-03T02:00:00.000Z', completedAt: '2026-08-03T02:00:05.000Z' } } },
          { name: 'r2-start', method: 'turn/started', params: { threadId: THREAD, turn: { id: REUSED, startedAt: '2026-08-03T02:00:30.000Z' } } },
          { name: 'r2-user', method: 'item/started', params: { threadId: THREAD, turnId: REUSED, item: { type: 'userMessage', id: 'item-u-shared', content: [{ type: 'text', text: 'reused-item generation two' }] } } },
          { name: 'r2-completed', method: 'turn/completed', params: { threadId: THREAD, turn: { id: REUSED, status: 'completed', createdAt: '2026-08-03T02:00:30.000Z', completedAt: '2026-08-03T02:00:35.000Z' } } },
        ], seen);
        const sharedItemKeys = seen.filter((m: any) =>
          m?.type === 'user-message' && String(m.key).startsWith(`codex:${REUSED}:`))
          .map((m: any) => String(m.key));
        check('K a repeated item id in a NEW generation is a new prompt with a new key',
          sharedItemKeys.length === 2 && sharedItemKeys[0] !== sharedItemKeys[1],
          `keys=${sharedItemKeys.join(',')}`);
      });
    } finally {
      await convergenceDaemon.stop().catch(() => {});
      convergenceDaemon = undefined;
    }
  }
  console.log(failures === convergencePhaseStart
    ? 'PASS: Codex turn-event delivery is order-invariant and its terminal is exactly-once'
    : `FAIL: ${failures - convergencePhaseStart} turn-event interleaving check(s) failed`);

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // Phase `fold` — session-status interleaving invariance (queued R0c.4's standing guard).
  //
  // The R0c series kept regressing because run-state correctness is an event-ORDERING property:
  // every fix pinned the specific interleaving that had just failed, and the next unrelated timing
  // change found a new one. This phase pins the ordering-independent invariants of the live-owner
  // status pipeline — the production Hub/ManagedConn fold, the roster publication boundary, and the
  // revision journal, composed with equivalent status-journal wiring (runtime.ts additionally runs
  // `onWatcherAccepted` caches and full-discovery `nativePublicationAuthority.reconcile()`, which are
  // not part of the invariants asserted here) — so a new interleaving cannot pass silently. Pure
  // in-process: a fake adapter, no temp dirs, no env, no daemon.
  //
  //   F  fold determinism — after EVERY delivered owner frame, the managed status equals a small
  //      reference fold of the documented rules (status frames own running/idle and clear the
  //      provisional needs-input seed; a real permission/question is authoritative until its exact
  //      resolution; orphan/duplicate resolutions and duplicate status frames are no-ops), and the
  //      journaled trail equals the fold's transition sequence.
  //   W  watcher-position commutativity — an inferred watcher snapshot (idle / working /
  //      needs-input, observe- and live-class) inserted at ANY position in an owned session's frame
  //      sequence may only ever re-publish the owner's CURRENT qualified status (a truthful no-op
  //      row the trail collapse absorbs unless it is the session's first row); it never journals any
  //      other run state and never changes the owner's managed status. R0c.1 proved single
  //      positions; this sweeps all of them.
  //   R  replacement seed coherence — replacing the owner connection mid-turn with an exact
  //      working/needs-input projection never journals an Idle gap at any point, the provisional
  //      needs-input seed clears on the first authoritative frame, and the eventual exact terminal
  //      journals exactly one Idle revision.
  //   E  terminal exactly-once — duplicate idle frames and orphan resolutions add no second Idle
  //      revision and no extra status flips.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('── Phase fold: Hub fold / watcher / replacement invariance (lanes F, W, R, E) ──');
  const foldPhaseStart = failures;
  {
    // ── production Hub/publication components, equivalent status-journal wiring ──────────────────
    const rosterRevision = new RosterRevisionStore(4096);
    const decorate = (info: SessionInfo): SessionInfo => structuredClone({ ...info, machine: FOLD_MACHINE });
    const observeRosterViews = (info: SessionInfo): void => {
      rosterRevision.observe(decorate(info), FOLD_MACHINE);
    };

    type Emitter = SessionConnection & { emit: (m: AgentMessage) => void };
    function fakeConn(info: SessionInfo): Emitter {
      const handlers = new Set<(m: AgentMessage) => void>();
      const conn: any = {
        info: structuredClone(info),
        emit: (m: AgentMessage) => { for (const h of [...handlers]) h(m); },
        getHistory: async () => [],
        subscribe: (h: (m: AgentMessage) => void) => { handlers.add(h); return () => handlers.delete(h); },
        sendPrompt: async () => {},
        respondPermission: async () => {},
        close: async () => {},
      };
      return conn as Emitter;
    }

    const attachPlans = new Map<string, () => Emitter>();
    const registry = new AgentRegistry();
    registry.register({
      id: 'codex',
      displayName: 'Codex (fake)',
      capabilities: {} as any,
      isAvailable: async () => true,
      discoverSessions: async () => [],
      attach: async (id: string) => {
        const plan = attachPlans.get(id);
        if (!plan) throw new Error(`no attach plan for ${id}`);
        return plan();
      },
    } as any);

    let boundary: {
      publishOwnerFrame(info: SessionInfo): void;
      submitWatcherSnapshot(info: SessionInfo): void;
      settle(): Promise<void>;
    };
    const hub = new Hub(registry, 15000, undefined, {
      onSessionInfo: (info) => boundary.publishOwnerFrame(info),
    });
    const nativeAuthority = new NativeIncarnationPublicationAuthority();
    boundary = createRosterPublicationBoundary({
      liveOwners: () => hub.liveSnapshot(),
      publish: observeRosterViews,
      acceptWatcher: (info: SessionInfo) => nativeAuthority.acceptsWatcher(info),
      reconcile: (info: SessionInfo) => hub.refreshExternalSession(decorate(info)),
      onReconcileError: () => {},
    });

    const codexInfo = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
      id,
      tool: 'codex',
      title: `interleave ${id}`,
      cwd: '/tmp/cosyncing-interleave',
      nativeId: `thread-${id}`,
      status: 'idle',
      attachMode: 'live',
      updatedAt: 10_000,
      control: {
        drive: { supported: true, state: 'driving' },
        terminalSync: { supported: true, syncAvailable: true, active: false },
      },
      ...over,
    } as SessionInfo);

    /** Every status value journaled for one session after `after`, consecutive duplicates collapsed. */
    function statusTrail(after: number, sessionId: string): string[] {
      const trail: string[] = [];
      for (const delta of rosterRevision.eventsAfter(after).deltas) {
        if (delta.sessionId !== sessionId || delta.removed) continue;
        const status = String(delta.session?.status ?? '');
        if (trail.at(-1) !== status) trail.push(status);
      }
      return trail;
    }
    function idleRevisions(after: number, sessionId: string): number {
      return rosterRevision.eventsAfter(after).deltas.filter((delta) =>
        delta.sessionId === sessionId && !delta.removed &&
        (delta.changedFields.includes('status') || delta.changedFields.includes('session')) &&
        delta.session?.status === 'idle').length;
    }

    // ── reference fold: the DOCUMENTED ManagedConn run-state rules, nothing more ─────────────────
    type Step = string; // 'run' | 'idle' | 'perm:<id>' | 'res:<id>' | 'q:<id>' | 'resq:<id>'
    interface FoldState { running: boolean; provisional: boolean; pending: Set<string> }
    const foldStatus = (s: FoldState): string =>
      s.provisional || s.pending.size > 0 ? 'needs-input' : s.running ? 'working' : 'idle';
    function foldSeed(seedStatus: string): FoldState {
      return { running: seedStatus !== 'idle', provisional: seedStatus === 'needs-input', pending: new Set() };
    }
    function foldStep(s: FoldState, step: Step): void {
      const [kind, id] = step.split(':');
      if (kind === 'run') { s.provisional = false; s.running = true; }
      else if (kind === 'idle') { s.provisional = false; s.running = false; }
      else if (kind === 'perm' || kind === 'q') { s.provisional = false; s.pending.add(String(id)); }
      else if (kind === 'res' || kind === 'resq') { s.pending.delete(String(id)); }
      else throw new Error(`unknown step ${step}`);
    }
    function frameFor(step: Step): AgentMessage {
      const [kind, id] = step.split(':');
      if (kind === 'run') return { type: 'status', status: 'running' } as AgentMessage;
      if (kind === 'idle') return { type: 'status', status: 'idle' } as AgentMessage;
      if (kind === 'perm') return { type: 'permission-request', requestId: String(id), title: 'fake' } as AgentMessage;
      if (kind === 'res') return { type: 'permission-resolved', requestId: String(id) } as AgentMessage;
      if (kind === 'q') return { type: 'question-request', requestId: String(id), questions: [] } as AgentMessage;
      return { type: 'question-resolved', requestId: String(id) } as AgentMessage;
    }
    /** The fold's deduped transition trail from a seed, matching the journal's collapse rule. */
    function foldTrail(seedStatus: string, steps: Step[]): string[] {
      const s = foldSeed(seedStatus);
      const trail: string[] = [];
      let last = foldStatus(s);
      for (const step of steps) {
        foldStep(s, step);
        const now = foldStatus(s);
        if (now !== last) { trail.push(now); last = now; }
      }
      return trail;
    }

    let nextId = 0;
    async function ownedSession(seedStatus: SessionInfo['status'] = 'idle'): Promise<{ id: string; conn: Emitter }> {
      const id = `s-${String(++nextId).padStart(3, '0')}`;
      const conn = fakeConn(codexInfo(id, { status: seedStatus }));
      attachPlans.set(id, () => conn);
      await hub.ensure('codex', id);
      return { id, conn };
    }

    // ── Lane F — fold determinism after every frame ──────────────────────────────────────────────
    const FOLD_SEQUENCES: { name: string; seed: SessionInfo['status']; steps: Step[] }[] = [
      { name: 'plain turn', seed: 'idle', steps: ['run', 'idle'] },
      { name: 'permission inside the turn', seed: 'idle', steps: ['run', 'perm:p1', 'res:p1', 'idle'] },
      { name: 'permission outlives the status idle', seed: 'idle', steps: ['run', 'perm:p1', 'idle', 'res:p1'] },
      { name: 'request before the running frame', seed: 'idle', steps: ['perm:p1', 'run', 'res:p1', 'idle'] },
      { name: 'question flow', seed: 'idle', steps: ['run', 'q:q1', 'resq:q1', 'idle'] },
      { name: 'orphan resolution is a no-op', seed: 'idle', steps: ['run', 'res:zz', 'idle'] },
      { name: 'duplicate status frames are no-ops', seed: 'idle', steps: ['run', 'run', 'idle', 'idle'] },
      { name: 'duplicate request ids resolve once', seed: 'idle', steps: ['perm:p1', 'perm:p1', 'res:p1', 'res:p1', 'idle'] },
      { name: 'needs-input seed is provisional', seed: 'needs-input', steps: ['run', 'idle'] },
      { name: 'working seed carries the active turn', seed: 'working', steps: ['perm:p1', 'res:p1', 'idle'] },
    ];
    for (const seq of FOLD_SEQUENCES) {
      const { id, conn } = await ownedSession(seq.seed);
      const start = rosterRevision.revision;
      const model = foldSeed(seq.seed);
      let stepwiseOk = true;
      let detail = '';
      for (const step of seq.steps) {
        conn.emit(frameFor(step));
        foldStep(model, step);
        const got = hub.getConn('codex', id)?.status;
        if (got !== foldStatus(model)) {
          stepwiseOk = false;
          detail = `after ${step}: managed=${String(got)} fold=${foldStatus(model)}`;
          break;
        }
      }
      check(`F ${seq.name}: managed status equals the reference fold after every frame`, stepwiseOk, detail);
      const expectedTrail = foldTrail(seq.seed, seq.steps);
      const trail = statusTrail(start, id);
      check(`F ${seq.name}: journaled trail equals the fold's transitions`,
        trail.join('→') === expectedTrail.join('→'),
        `journal=${trail.join('→') || '(none)'} fold=${expectedTrail.join('→') || '(none)'}`);
    }

    // ── Lane W — watcher-position commutativity ──────────────────────────────────────────────────
    const W_STEPS: Step[] = ['run', 'perm:p1', 'res:p1', 'idle'];
    /** Expected trail with one watcher insertion at `position`: the watcher may add ONLY a truthful
     *  re-publication of the owner's current status, which the collapse absorbs unless it is the
     *  session's first journal row. */
    function expectedTrailWithWatcherAt(position: number): string {
      const s = foldSeed('idle');
      const trail: string[] = [];
      for (let i = 0; i <= W_STEPS.length; i++) {
        if (i === position && trail.at(-1) !== foldStatus(s)) trail.push(foldStatus(s));
        if (i < W_STEPS.length) {
          foldStep(s, W_STEPS[i]!);
          if (trail.at(-1) !== foldStatus(s)) trail.push(foldStatus(s));
        }
      }
      return trail.join('→');
    }
    const watcherVariants: { name: string; status: SessionInfo['status']; attachMode: string }[] = [
      { name: 'observe idle', status: 'idle', attachMode: 'observe' },
      { name: 'observe working', status: 'working', attachMode: 'observe' },
      { name: 'observe needs-input', status: 'needs-input', attachMode: 'observe' },
      { name: 'live idle', status: 'idle', attachMode: 'live' },
      { name: 'live working', status: 'working', attachMode: 'live' },
      { name: 'live needs-input', status: 'needs-input', attachMode: 'live' },
    ];
    for (const variant of watcherVariants) {
      let allOk = true;
      let detail = '';
      for (let position = 0; position <= W_STEPS.length; position++) {
        const { id, conn } = await ownedSession('idle');
        const start = rosterRevision.revision;
        const model = foldSeed('idle');
        for (let i = 0; i <= W_STEPS.length; i++) {
          if (i === position) {
            boundary.submitWatcherSnapshot(codexInfo(id, {
              status: variant.status,
              attachMode: variant.attachMode,
              updatedAt: 99_000,
              control: {
                drive: { supported: true, state: variant.attachMode === 'live' ? 'driving' : 'observing' },
                terminalSync: { supported: true, syncAvailable: true, active: false },
              },
            } as Partial<SessionInfo>));
            await boundary.settle();
            const managed = hub.getConn('codex', id)?.status;
            if (managed !== foldStatus(model)) {
              allOk = false;
              detail = `position ${position}: watcher moved the managed status to ${String(managed)}`;
              break;
            }
          }
          if (i < W_STEPS.length) {
            conn.emit(frameFor(W_STEPS[i]!));
            foldStep(model, W_STEPS[i]!);
          }
        }
        if (!allOk) break;
        const trail = statusTrail(start, id).join('→');
        const expected = expectedTrailWithWatcherAt(position);
        if (trail !== expected) {
          allOk = false;
          detail = `position ${position}: ${trail || '(none)'} vs expected ${expected}`;
          break;
        }
      }
      check(`W a ${variant.name} watcher snapshot at any of ${W_STEPS.length + 1} positions republishes only the owner's current status`,
        allOk, detail);
    }

    // ── Lane R — replacement seed coherence ──────────────────────────────────────────────────────
    {
      const { id, conn } = await ownedSession('idle');
      const start = rosterRevision.revision;
      conn.emit(frameFor('run'));
      const replacement = fakeConn(codexInfo(id, { status: 'working' }));
      attachPlans.set(id, () => replacement);
      hub.getConn('codex', id)!.replaceConnection(replacement);
      const midTrail = statusTrail(start, id);
      check('R replacing the owner with an exact working projection journals no Idle gap',
        !midTrail.includes('idle') && hub.getConn('codex', id)?.status === 'working',
        `trail=${midTrail.join('→')} status=${String(hub.getConn('codex', id)?.status)}`);
      replacement.emit(frameFor('idle'));
      check('R the exact terminal after replacement journals exactly one Idle revision',
        idleRevisions(start, id) === 1 && statusTrail(start, id).at(-1) === 'idle',
        `idleRevisions=${idleRevisions(start, id)} trail=${statusTrail(start, id).join('→')}`);
    }
    {
      const { id, conn } = await ownedSession('idle');
      const start = rosterRevision.revision;
      conn.emit(frameFor('run'));
      const replacement = fakeConn(codexInfo(id, { status: 'needs-input' }));
      attachPlans.set(id, () => replacement);
      hub.getConn('codex', id)!.replaceConnection(replacement);
      check('R a needs-input replacement seed projects Needs input without an Idle gap',
        hub.getConn('codex', id)?.status === 'needs-input' && !statusTrail(start, id).includes('idle'),
        `status=${String(hub.getConn('codex', id)?.status)} trail=${statusTrail(start, id).join('→')}`);
      replacement.emit(frameFor('run'));
      check('R the first authoritative frame clears the provisional seed to Working',
        hub.getConn('codex', id)?.status === 'working' && !statusTrail(start, id).includes('idle'),
        `status=${String(hub.getConn('codex', id)?.status)} trail=${statusTrail(start, id).join('→')}`);
      replacement.emit(frameFor('perm:p9'));
      replacement.emit(frameFor('res:p9'));
      replacement.emit(frameFor('idle'));
      const trail = statusTrail(start, id);
      check('R the full replacement round journals exactly one Idle revision',
        idleRevisions(start, id) === 1 && trail.at(-1) === 'idle',
        `idleRevisions=${idleRevisions(start, id)} trail=${trail.join('→')}`);
    }

    // ── Lane E — terminal exactly-once under duplicates and orphans ──────────────────────────────
    {
      const { id, conn } = await ownedSession('idle');
      const start = rosterRevision.revision;
      for (const step of ['run', 'idle', 'idle', 'res:orphan', 'resq:orphan'] as Step[]) conn.emit(frameFor(step));
      check('E duplicate idle frames and orphan resolutions journal exactly one Idle revision',
        idleRevisions(start, id) === 1 && statusTrail(start, id).join('→') === 'working→idle',
        `idleRevisions=${idleRevisions(start, id)} trail=${statusTrail(start, id).join('→')}`);
    }

    // ── Lane R2 — a proven replacement retires its predecessor BEFORE publication ───────────────
    // Two owned sessions share ONE exact native id (the adapter-id swap a native runtime's new
    // incarnation produces). The production sequence (runtime.ts): a generation-aware canonical
    // discovery selects the replacement, `Hub.retireSupersededOwners` retires the predecessor, its
    // journal row is removed, and only then is the replacement published through the publication
    // boundary. Reversing that order exposes both logical owners for one revision window and leaves
    // the superseded row actionable.
    {
      const INCARNATION = 'thread-incarnation-shared';
      const OLD = 's-incarnation-old';
      const NEW = 's-incarnation-new';
      const oldConn = fakeConn(codexInfo(OLD, { nativeId: INCARNATION }));
      attachPlans.set(OLD, () => oldConn);
      await hub.ensure('codex', OLD);
      // The predecessor is a live Working owner, journaled — the row the replacement must supersede.
      oldConn.emit(frameFor('run'));
      // The replacement owner exists in the Hub but has emitted nothing, so nothing of it is
      // journaled yet — exactly the position of a discovered-but-unpublished incarnation.
      const newConn = fakeConn(codexInfo(NEW, { nativeId: INCARNATION }));
      attachPlans.set(NEW, () => newConn);
      await hub.ensure('codex', NEW);
      await boundary.settle();
      const start = rosterRevision.revision;

      const replacementInfo = codexInfo(NEW, { nativeId: INCARNATION });
      const canonical = nativeAuthority.reconcile([replacementInfo]);
      const retired = await hub.retireSupersededOwners(canonical);
      check('R2 a proven replacement retires exactly the superseded predecessor owner',
        retired.length === 1 && retired[0]?.id === OLD
        && hub.getConn('codex', OLD) === undefined && hub.getConn('codex', NEW) !== undefined,
        `retired=${JSON.stringify(retired.map((info) => info.id))}`);
      for (const info of retired) rosterRevision.remove(FOLD_MACHINE, info.tool, info.id);
      boundary.publishOwnerFrame(replacementInfo);
      await boundary.settle();

      // Exactly-once: a repeated retirement round over the same canonical replacement retires
      // nothing more and journals no second removal.
      const retiredAgain = await hub.retireSupersededOwners(nativeAuthority.reconcile([replacementInfo]));
      for (const info of retiredAgain) rosterRevision.remove(FOLD_MACHINE, info.tool, info.id);
      const deltas = rosterRevision.eventsAfter(start).deltas;
      const removals = deltas.filter((delta) => delta.sessionId === OLD && delta.removed);
      check('R2 the predecessor retires exactly once — one removal transition, none from a repeated round',
        retiredAgain.length === 0 && removals.length === 1,
        `removals=${removals.length} retiredAgain=${retiredAgain.length}`);

      const removalIndex = deltas.findIndex((delta) => delta.sessionId === OLD && delta.removed);
      const replacementIndex = deltas.findIndex((delta) => delta.sessionId === NEW && !delta.removed);
      check('R2 the roster journal orders the predecessor removal BEFORE the replacement publication',
        removalIndex !== -1 && replacementIndex !== -1 && removalIndex < replacementIndex,
        `removal@${removalIndex} replacement@${replacementIndex}`);

      const current = new Map<string, SessionInfo>();
      for (const delta of rosterRevision.eventsAfter(start).deltas) {
        if (delta.removed) current.delete(delta.sessionId);
        else if (delta.session) current.set(delta.sessionId, delta.session as SessionInfo);
      }
      const visible = [...current.values()].filter((info) => info.nativeId === INCARNATION);
      const liveOwners = hub.liveSnapshot().filter((entry) => entry.info.nativeId === INCARNATION);
      check('R2 exactly one visible current incarnation remains for the shared native id',
        visible.length === 1 && visible[0]?.id === NEW
        && liveOwners.length === 1 && liveOwners[0]?.info.id === NEW,
        `journal=${visible.map((info) => info.id).join(',')} owners=${liveOwners.map((entry) => entry.info.id).join(',')}`);
    }

    await boundary.settle();
    await hub.dispose?.();
  }
  console.log(failures === foldPhaseStart
    ? 'PASS: session-status interleaving invariance held across fold, watcher-position, replacement, and terminal lanes'
    : `FAIL: ${failures - foldPhaseStart} interleaving invariance check(s) failed`);

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // Phase `adapters` — cross-adapter opt-in manifest, FAIL CLOSED.
  //
  // The lane matrix (native-identity, terminal-authority, history-live-chronology, replacement,
  // hub-authority) is only as strong as its coverage per production adapter. The manifest
  // (scripts/broker/tests/session-truth-conformance.json) is the reviewed opt-in record: every
  // adapter class the production broker registers must resolve every lane with real-suite coverage
  // or a dated, reasoned exclusion. Every check here fails CLOSED — a silently removed adapter, a
  // renamed/removed sub-suite, a lane left dangling, or a parse drift in the roster scrape all turn
  // red instead of passing silently.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('── Phase adapters: cross-adapter conformance manifest (fail-closed) ──');
  const adaptersPhaseStart = failures;
  {
    const CONFORMANCE_LANES = ['native-identity', 'terminal-authority', 'history-live-chronology', 'replacement', 'hub-authority'];

    // The production roster, scraped from runtime.ts rather than restated: a drift between this
    // regex and the real registration call shape must fail, never match zero and pass. An
    // indirect registration (`const adapter = new FooAdapter(); registry.register(adapter);`)
    // matches only the total count below, so the two counts diverge and the phase fails closed
    // instead of letting an adapter escape the manifest.
    const runtimeSource = readFileSync(resolve(import.meta.dir, '../../../../packages/typescript/broker/src/runtime.ts'), 'utf8');
    const registered = [...runtimeSource.matchAll(/registry\.register\(new\s+(\w+Adapter)\b/g)].map((match) => match[1]!);
    const registerCalls = [...runtimeSource.matchAll(/registry\.register\(/g)].length;
    check('A the production adapter roster parses to at least one registered adapter class',
      registered.length > 0, `registered=${registered.join(',')}`);
    check('A every registry.register call uses the supported direct-constructor form',
      registerCalls === registered.length,
      `registerCalls=${registerCalls} directConstructor=${registered.length}`);
    check('A registered adapter class names are unique',
      new Set(registered).size === registered.length,
      `duplicates=${registered.filter((name, index) => registered.indexOf(name) !== index).join(',') || '(none)'}`);

    interface ManifestExclusion { reason?: string; reviewed?: string }
    interface ManifestEntry {
      coverage?: Record<string, string[]>;
      exclusions?: Record<string, ManifestExclusion>;
    }
    interface Manifest {
      schemaVersion?: number;
      lanes?: string[];
      adapters?: Record<string, ManifestEntry>;
    }
    const manifest = JSON.parse(
      readFileSync(resolve(import.meta.dir, '../session-truth-conformance.json'), 'utf8'),
    ) as Manifest;
    check('A the manifest declares the supported schema version and the exact conformance lane matrix',
      manifest.schemaVersion === 1
      && Array.isArray(manifest.lanes)
      && [...manifest.lanes].sort().join(',') === [...CONFORMANCE_LANES].sort().join(','),
      `schemaVersion=${String(manifest.schemaVersion)} lanes=${(manifest.lanes ?? []).join(',')}`);

    const lanes = manifest.lanes ?? [];
    const entries = Object.keys(manifest.adapters ?? {});
    check('A every production-registered adapter class has a manifest entry',
      registered.every((name) => entries.includes(name)),
      `missing=${registered.filter((name) => !entries.includes(name)).join(',') || '(none)'}`);
    check('A every manifest entry names a production-registered adapter class',
      entries.every((name) => registered.includes(name)),
      `stray=${entries.filter((name) => !registered.includes(name)).join(',') || '(none)'}`);

    // Coverage is only real while the named sub-suite still runs in the broker-deterministic gate.
    const graph = JSON.parse(
      readFileSync(resolve(import.meta.dir, '../../../verification/verification-graph.json'), 'utf8'),
    ) as { gates?: { id?: string; subSuites?: { id?: string }[] }[] };
    const gate = (graph.gates ?? []).find((candidate) => candidate.id === 'broker-deterministic');
    const subSuiteIds = new Set((gate?.subSuites ?? []).map((suite) => String(suite.id)));
    check('A the broker-deterministic gate sub-suite roster parses from the verification graph',
      subSuiteIds.size > 0, `count=${subSuiteIds.size}`);

    const unresolved: string[] = [];
    const unknownSuites: string[] = [];
    const badExclusions: string[] = [];
    for (const [name, entry] of Object.entries(manifest.adapters ?? {})) {
      for (const lane of lanes) {
        const coverage = entry.coverage?.[lane] ?? [];
        const exclusion = entry.exclusions?.[lane];
        if (coverage.length === 0 && !exclusion) unresolved.push(`${name}:${lane}`);
        for (const suite of coverage) {
          if (!subSuiteIds.has(suite)) unknownSuites.push(`${name}:${lane}→${suite}`);
        }
        if (exclusion && (!String(exclusion.reason ?? '').trim() || !String(exclusion.reviewed ?? '').trim())) {
          badExclusions.push(`${name}:${lane}`);
        }
      }
    }
    check('A every adapter resolves every lane with coverage or a reviewed exclusion',
      unresolved.length === 0, unresolved.slice(0, 6).join(' | '));
    check('A every coverage reference names a sub-suite in the broker-deterministic gate',
      unknownSuites.length === 0, unknownSuites.slice(0, 6).join(' | '));
    check('A every exclusion carries a non-empty reason and a reviewed date',
      badExclusions.length === 0, badExclusions.slice(0, 6).join(' | '));
  }
  console.log(failures === adaptersPhaseStart
    ? 'PASS: every production adapter resolves the session-truth lane matrix'
    : `FAIL: ${failures - adaptersPhaseStart} adapters manifest check(s) failed`);

  console.log(failures === 0
    ? 'PASS: session-truth conformance held across attach, repair, convergence, fold, and adapters phases'
    : `FAIL: ${failures} session-truth conformance check(s) failed`);
} catch (error) {
  failures++;
  console.log(`FAIL  session-truth conformance threw — ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  await repairDaemon?.stop().catch(() => {});
  await convergenceDaemon?.stop().catch(() => {});
  if (previous.home == null) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous.home;
  if (previous.sync == null) delete process.env.COSYNCING_CODEX_SYNC_SERVER; else process.env.COSYNCING_CODEX_SYNC_SERVER = previous.sync;
  if (previous.sock == null) delete process.env.COSYNCING_CODEX_APP_SERVER_SOCK; else process.env.COSYNCING_CODEX_APP_SERVER_SOCK = previous.sock;
  if (previous.watch == null) delete process.env.COSYNCING_CODEX_SYNC_WATCH_MS; else process.env.COSYNCING_CODEX_SYNC_WATCH_MS = previous.watch;
  if (previous.grace == null) delete process.env.COSYNCING_CODEX_SYNC_DROP_GRACE_POLLS; else process.env.COSYNCING_CODEX_SYNC_DROP_GRACE_POLLS = previous.grace;
  rmSync(home, { recursive: true, force: true });
}
process.exit(failures === 0 ? 0 : 1);
