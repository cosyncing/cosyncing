/**
 * Claude turn-runtime + timestamps (doc-15) — pure mapper/tracker tests. NO claude, NO model cost.
 * Verifies: user-message.sentAt + turnId from transcript timestamps; per-turn run-summary (startedAt/
 * completedAt/totalRuntimeMs/tokens deduped by message.id); runtimeTotals accumulation; exact transcript
 * terminal authority across quiet tools and replay/resync; and the live driven-turn path
 * (startLive→running, finishLive→done + authoritative usage/cost).
 *
 *   bun run packages/typescript/broker/test/claude/test-claude-runtime.ts   (exit 0 = all pass)
 */
export {};
import { appendFileSync, closeSync, existsSync, ftruncateSync, linkSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeSessionStatus, claudeTranscriptTurnAuthorityResult, mapTranscript, ClaudeRuntimeTracker, ClaudeObserveConnection, selectClaudeLiveStatusAfterProbe } from '../../../adapters/claude/src/index.ts';
import { AttentionService } from '../../src/attention/attention-service.ts';
import type { AgentMessage } from '../../../adapter-api/src/index.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const ms = (iso: string) => Date.parse(iso);
const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
};
const T0 = '2026-06-18T17:46:28.834Z';
const T1 = '2026-06-18T17:46:31.361Z'; // assistant a1 (turn 1)
const T2 = '2026-06-18T17:46:33.834Z'; // assistant a2 (turn 1, same message.id → no double-count)
const T3 = '2026-06-18T17:51:08.096Z'; // user prompt P2 (closes turn 1)
const T4 = '2026-06-18T17:51:10.000Z'; // assistant a3 (turn 2)
const T5 = '2026-06-18T17:56:40.000Z'; // tool result after > 2 quiet minutes
const T6 = '2026-06-18T17:56:44.000Z'; // authoritative end_turn
const T7 = '2026-06-18T17:57:00.000Z';
const T8 = '2026-06-18T17:57:01.000Z';
const T9 = '2026-06-18T17:57:03.000Z';
const T10 = '2026-06-18T17:57:04.000Z';

const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 };
const lines = [
  { type: 'mode' }, // non-conversation header — skipped
  { type: 'user', uuid: 'u1', timestamp: T0, message: { role: 'user', content: 'first prompt' } },
  { type: 'assistant', uuid: 'a1', timestamp: T1, message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'thinking…' }], usage } },
  { type: 'assistant', uuid: 'a2', timestamp: T2, message: { id: 'm1', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done one' }], usage } }, // DUP message.id m1
  { type: 'user', uuid: 'u2', timestamp: T3, message: { role: 'user', content: 'second prompt' } },
  { type: 'assistant', uuid: 'a3', timestamp: T4, message: { id: 'm3', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: 'answer two' }, { type: 'tool_use', id: 'quiet-tool', name: 'Bash', input: { command: 'sleep 330' } }], usage: { input_tokens: 100, output_tokens: 7 } } },
];

// ── native-process probe failures are unknown, not an authoritative empty roster ──
{
  const priorMap = new Map([['live-session', { status: 'working' as const }]]);
  const previous = { at: 1_000, map: priorMap };
  check(
    'a transient agents-json failure preserves the last successful live status',
    selectClaudeLiveStatusAfterProbe({ ok: false, map: new Map() }, previous, 5_000, 10_000) === priorMap,
  );
  check(
    'an expired agents-json failure cannot preserve Working forever',
    selectClaudeLiveStatusAfterProbe({ ok: false, map: new Map() }, previous, 12_000, 10_000).size === 0,
  );
  check(
    'a successful empty agents-json result retires stale Working immediately',
    selectClaudeLiveStatusAfterProbe({ ok: true, map: new Map() }, previous, 5_000, 10_000).size === 0,
  );
}

// ── user-message.sentAt + turnId (no tracker needed; mapUser stamps them) ──
{
  const msgs = mapTranscript(lines);
  const u1 = msgs.find((m: any) => m.type === 'user-message' && m.text === 'first prompt') as any;
  check('user-message carries sentAt (epoch ms from ISO) + turnId + key', u1?.sentAt === ms(T0) && u1?.turnId === 'u1' && u1?.key === 'u1', JSON.stringify({ sentAt: u1?.sentAt, turnId: u1?.turnId }));
}

// ── per-turn run-summary via exact end_turn; prompt replacement never invents completion ──
{
  const tracker = new ClaudeRuntimeTracker('sess', 'claude-transcript');
  const out = mapTranscript(lines, tracker);
  const runs = out.filter((m: any) => m.type === 'run-summary') as any[];
  const r1 = runs.find((r) => r.turnId === 'u1' && r.status === 'done');
  check('turn 1 → run-summary done with native start/complete + total runtime', r1?.status === 'done' && r1?.startedAt === ms(T0) && r1?.completedAt === ms(T2) && r1?.totalRuntimeMs === ms(T2) - ms(T0), JSON.stringify({ s: r1?.status, total: r1?.totalRuntimeMs }));
  // assistantMessageKey must RESOLVE to a row the same pass rendered — the turn projection links a turn
  // to its answer by that key, so a key built from anything but the mapper's own output links nothing.
  const renderedKeys = new Set(out.filter((m: any) => (m.type === 'model-output' || m.type === 'thinking') && typeof m.key === 'string').map((m: any) => m.key));
  check('turn 1 run-summary key/userMessageKey are stable + assistantMessageKey resolves to a rendered row', r1?.key === 'sess:run:u1' && r1?.userMessageKey === 'u1' && renderedKeys.has(r1?.assistantMessageKey), JSON.stringify({ key: r1?.key, umk: r1?.userMessageKey, amk: r1?.assistantMessageKey }));
  check('turn 1 tokens summed + DEDUPED by message.id (m1 counted once)', r1?.tokens?.input === 10 && r1?.tokens?.output === 20 && r1?.tokens?.cacheRead === 5 && r1?.tokens?.cacheWrite === 3, JSON.stringify(r1?.tokens));
  check('agent/execution split OMITTED (no fake zeros)', r1?.agentRuntimeMs === undefined && r1?.executionRuntimeMs === undefined);
  const totals = out.filter((m: any) => m.type === 'metadata-update' && m.key === 'runtimeTotals') as any[];
  check('runtimeTotals emitted after a turn closes (turnCount 1, durable total)', totals.length >= 1 && totals.at(-1).value.turnCount === 1 && totals.at(-1).value.totalRuntimeMs === ms(T2) - ms(T0), JSON.stringify(totals.at(-1)?.value));
  const running = runs.find((r) => r.turnId === 'u2' && r.status === 'running');
  check('trailing exact tool turn stays running with no footer metadata', running?.completedAt === undefined && running?.totalRuntimeMs === undefined, JSON.stringify(running));
  check('flush/replay cannot synthesize a terminal summary', tracker.flush().length === 0);
}

// ── failures, interruption, and exact replacement stay distinct ──
{
  const tracker = new ClaudeRuntimeTracker('distinct', 'claude-transcript');
  const failureLines = [
    { type: 'user', uuid: 'uf', timestamp: T0, message: { role: 'user', content: 'fail' } },
    { type: 'assistant', uuid: 'af', timestamp: T1, isApiErrorMessage: true, message: { id: 'mf', role: 'assistant', content: [{ type: 'text', text: 'rate limited' }] } },
    { type: 'user', uuid: 'ui', timestamp: T2, message: { role: 'user', content: 'interrupt' } },
    { type: 'user', uuid: 'ii', timestamp: T3, message: { role: 'user', content: '[Request interrupted by user for tool use]' } },
    { type: 'user', uuid: 'ur1', timestamp: T4, message: { role: 'user', content: 'open then replaced' } },
    { type: 'user', uuid: 'ur2', timestamp: T5, message: { role: 'user', content: 'replacement' } },
  ];
  const runs = mapTranscript(failureLines, tracker).filter((m: any) => m.type === 'run-summary') as any[];
  check('API failure closes only its exact turn as error', runs.some((r) => r.turnId === 'uf' && r.status === 'error' && r.completedAt === ms(T1)));
  check('user interruption closes only its exact turn as cancelled', runs.some((r) => r.turnId === 'ui' && r.status === 'cancelled' && r.completedAt === ms(T3)));
  check('replacement fences an unterminated turn without a fake completion time', runs.some((r) => r.turnId === 'ur1' && r.status === 'cancelled' && r.completedAt === undefined) && runs.some((r) => r.turnId === 'ur2' && r.status === 'running'));
}

// ── live driven turn (resume/Drive): stream events have no native ts → broker wall clock ──
{
  const tracker = new ClaudeRuntimeTracker('uuidX', 'claude-transcript');
  const start = tracker.startLive('live1', 1_000_000) as any;
  check('startLive → run-summary running (startedAt, no completedAt)', start.type === 'run-summary' && start.turnId === 'live1' && start.key === 'uuidX:run:live1' && start.status === 'running' && start.startedAt === 1_000_000 && start.completedAt === undefined);
  const fin = tracker.finishLive('done', 1_003_000, { input: 50, output: 9, cost: 0.0123 });
  const rf = fin.find((m: any) => m.type === 'run-summary') as any;
  check('finishLive → run-summary done + total runtime + authoritative usage/cost', rf?.status === 'done' && rf?.totalRuntimeMs === 3000 && rf?.tokens?.input === 50 && rf?.tokens?.output === 9 && rf?.tokens?.cost === 0.0123);
  check('finishLive also emits runtimeTotals', fin.some((m: any) => m.type === 'metadata-update' && m.key === 'runtimeTotals' && m.value.turnCount === 1 && m.value.totalRuntimeMs === 3000));
  const fin2 = tracker.finishLive('done', 9_999_999);
  check('finishLive with no open turn → no-op (no phantom summary)', fin2.length === 0);
}

// ── full Observe: quiet foreground tool survives >2 min plus replay/resync; exact end_turn closes once ──
{
  const dir = mkdtempSync(join(tmpdir(), 'ca-claude-runtime-'));
  const file = join(dir, 'sess.jsonl');
  writeFileSync(file, lines.filter((ln) => ln.type !== 'mode').map((ln) => JSON.stringify(ln)).join('\n') + '\n');
  try {
    const old = new Date(ms(T4));
    utimesSync(file, old, old);
    check('quiet exact tool turn outranks stale file freshness', await claudeSessionStatus(file, 'working', ms(T5)) === 'working');
    check('needs-input refines, but does not retire, the exact active turn', await claudeSessionStatus(file, 'needs-input', ms(T5)) === 'needs-input');
    check('an explicit native Idle retires an abandoned open transcript', await claudeSessionStatus(file, 'idle', ms(T5)) === 'idle');
    check('a missing native process cannot make an abandoned open transcript Working', await claudeSessionStatus(file, undefined, ms(T5)) === 'idle');
    const progressLine = JSON.stringify({ type: 'progress', timestamp: T5, data: { message: 'ordinary progress', chunk: 'x'.repeat(1024) } }) + '\n';
    const progress = progressLine.repeat(Math.ceil((640 * 1024) / Buffer.byteLength(progressLine)));
    appendFileSync(file, progress);
    const tenMinutesOld = new Date(ms(T5));
    utimesSync(file, tenMinutesOld, tenMinutesOld);
    check(
      'more than 512 KiB of valid progress cannot evict an admitted Claude tool turn',
      Buffer.byteLength(progress) > 512 * 1024 && await claudeSessionStatus(file, 'working', ms(T5) + 10 * 60 * 1000) === 'working',
      JSON.stringify({ appendedBytes: Buffer.byteLength(progress), status: await claudeSessionStatus(file, 'working', ms(T5) + 10 * 60 * 1000) }),
    );

    const coldFile = join(dir, 'cold-sess.jsonl');
    writeFileSync(coldFile, lines.filter((ln) => ln.type !== 'mode').map((ln) => JSON.stringify(ln)).join('\n') + '\n' + progress);
    utimesSync(coldFile, tenMinutesOld, tenMinutesOld);
    check(
      'cold first read recovers an open Claude tool beyond the newest 512 KiB',
      Buffer.byteLength(progress) > 512 * 1024 && await claudeSessionStatus(coldFile, 'working', ms(T5) + 10 * 60 * 1000) === 'working',
      JSON.stringify({ appendedBytes: Buffer.byteLength(progress), status: await claudeSessionStatus(coldFile, 'working', ms(T5) + 10 * 60 * 1000) }),
    );
    appendFileSync(coldFile, [
      { type: 'user', uuid: 'cold-tr', timestamp: T5, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'quiet-tool', content: 'finished' }] } },
      { type: 'assistant', uuid: 'cold-a4', timestamp: T6, message: { id: 'cold-m4', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done after the quiet tool.' }] } },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n');
    check(
      'cold-recovered Claude tool retires on exact end_turn',
      await claudeSessionStatus(coldFile, 'working', ms(T6) + 1) === 'idle',
      await claudeSessionStatus(coldFile, 'working', ms(T6) + 1),
    );

    const largeRecordFile = join(dir, 'large-record.jsonl');
    writeFileSync(largeRecordFile, [
      { type: 'user', uuid: 'large-old-u', timestamp: T0, message: { role: 'user', content: 'completed prompt' } },
      { type: 'assistant', uuid: 'large-old-a', timestamp: T1, message: { id: 'large-old-m', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'completed' }] } },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n');
    check(
      'large-record fixture starts from terminal authority',
      await claudeSessionStatus(largeRecordFile, 'working', ms(T1) + 1) === 'idle',
      await claudeSessionStatus(largeRecordFile, 'working', ms(T1) + 1),
    );
    const largePrompt = {
      type: 'user',
      uuid: 'large-new-u',
      timestamp: T7,
      message: { role: 'user', content: `new prompt ${'x'.repeat(200 * 1024)}` },
    };
    appendFileSync(largeRecordFile, JSON.stringify(largePrompt) + '\n');
    check(
      'incremental scanner admits a valid 200 KiB user record spanning read chunks',
      await claudeSessionStatus(largeRecordFile, 'working', ms(T7) + 1) === 'working',
      await claudeSessionStatus(largeRecordFile, 'working', ms(T7) + 1),
    );
    appendFileSync(largeRecordFile, JSON.stringify({
      type: 'assistant',
      uuid: 'large-new-a',
      timestamp: T8,
      message: { id: 'large-new-m', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'completed large prompt' }] },
    }) + '\n');
    check(
      'large appended turn retires on exact end_turn',
      await claudeSessionStatus(largeRecordFile, 'working', ms(T8) + 1) === 'idle',
      await claudeSessionStatus(largeRecordFile, 'working', ms(T8) + 1),
    );

    const markerFree = join(dir, 'marker-free-256m.jsonl');
    const sourceBytes = 256 * 1024 * 1024;
    const markerFreeFd = openSync(markerFree, 'w');
    ftruncateSync(markerFreeFd, sourceBytes);
    const newline = Buffer.from('\n');
    for (let at = 512 * 1024 - 1; at < sourceBytes; at += 512 * 1024) {
      writeSync(markerFreeFd, newline, 0, 1, at);
    }
    closeSync(markerFreeFd);
    let ticks = 0;
    const heartbeat = setInterval(() => { ticks += 1; }, 10);
    const boundedStarted = performance.now();
    const bounded = await claudeTranscriptTurnAuthorityResult(markerFree);
    const boundedElapsedMs = performance.now() - boundedStarted;
    clearInterval(heartbeat);
    check(
      'cold marker-free 256 MiB recovery yields and returns a typed admission fallback',
      bounded.kind === 'fallback'
        && (bounded.reason === 'source-limit' || bounded.reason === 'time-limit')
        && bounded.scannedBytes <= 64 * 1024 * 1024
        && ticks > 0
        && boundedElapsedMs < 1000,
      JSON.stringify({ bounded, ticks, elapsedMs: Math.round(boundedElapsedMs) }),
    );

    const timeLimited = join(dir, 'marker-free-time-limit.jsonl');
    linkSync(markerFree, timeLimited);
    const timed = await claudeTranscriptTurnAuthorityResult(timeLimited, {
      maxSourceBytes: sourceBytes,
      maxElapsedMs: 1,
    });
    check(
      'cold Claude recovery has a distinct typed wall-clock fallback',
      timed.kind === 'fallback'
        && timed.reason === 'time-limit'
        && timed.scannedBytes < sourceBytes,
      JSON.stringify(timed),
    );

    const racedFile = join(dir, 'raced-source.jsonl');
    const interruptText = '[Request interrupted by user for tool use]';
    const racedActive = JSON.stringify({
      type: 'user',
      uuid: 'same-size-user',
      timestamp: T7,
      message: { role: 'user', content: 'x'.repeat(interruptText.length) },
    }) + '\n';
    const racedTerminal = JSON.stringify({
      type: 'user',
      uuid: 'same-size-user',
      timestamp: T7,
      message: { role: 'user', content: interruptText },
    }) + '\n';
    writeFileSync(racedFile, racedActive);
    const racedStat = statSync(racedFile);
    const changed = await claudeTranscriptTurnAuthorityResult(racedFile, {
      beforeValidation: () => {
        writeFileSync(racedFile, racedTerminal);
        utimesSync(racedFile, racedStat.atime, racedStat.mtime);
      },
    });
    check(
      'cold Claude scan rejects a same-inode/same-size boundary rewrite before publication',
      changed.kind === 'fallback'
        && changed.reason === 'source-changed'
        && Buffer.byteLength(racedActive) === Buffer.byteLength(racedTerminal)
        && await claudeSessionStatus(racedFile, 'working', ms(T8) + 1) === 'idle',
      JSON.stringify(changed),
    );

    const warmBoundedFile = join(dir, 'warm-large-append.jsonl');
    const warmActiveLines = [
      { type: 'user', uuid: 'warm-u', timestamp: T7, message: { role: 'user', content: 'warm bounded prompt' } },
      { type: 'assistant', uuid: 'warm-a', timestamp: T8, message: { id: 'warm-m', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'warm-tool', name: 'Bash', input: { command: 'sleep 1' } }] } },
    ];
    writeFileSync(warmBoundedFile, warmActiveLines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    const warmSeeded = await claudeTranscriptTurnAuthorityResult(warmBoundedFile);
    check(
      'warm Claude resource fixture seeds exact active authority',
      warmSeeded.kind === 'authority' && warmSeeded.authority === 'active',
      JSON.stringify(warmSeeded),
    );

    const warmSeedSize = statSync(warmBoundedFile).size;
    const warmAppendBytes = 512 * 1024 * 1024;
    const warmFd = openSync(warmBoundedFile, 'r+');
    const incompleteStart = Buffer.from('{');
    writeSync(warmFd, incompleteStart, 0, incompleteStart.length, warmSeedSize);
    ftruncateSync(warmFd, warmSeedSize + warmAppendBytes);
    closeSync(warmFd);

    let warmTicks = 0;
    const warmHeartbeat = setInterval(() => { warmTicks += 1; }, 10);
    const warmStartedAt = performance.now();
    const warmBounded = await claudeTranscriptTurnAuthorityResult(warmBoundedFile, { maxElapsedMs: 1000 });
    const warmElapsedMs = performance.now() - warmStartedAt;
    clearInterval(warmHeartbeat);
    check(
      'warm Claude 512 MiB incomplete append yields and reports bounded source work',
      warmBounded.kind === 'fallback'
        && warmBounded.authority === 'active'
        && warmBounded.reason === 'source-limit'
        && warmBounded.scannedBytes > 0
        && warmBounded.scannedBytes <= 64 * 1024 * 1024
        && warmTicks > 0
        && warmElapsedMs < 1000,
      JSON.stringify({ warmBounded, ticks: warmTicks, elapsedMs: Math.round(warmElapsedMs) }),
    );

    let warmCaughtUpBytes = warmBounded.scannedBytes;
    let warmCatchupPasses = 1;
    let warmCatchup = warmBounded;
    while (warmCaughtUpBytes < warmAppendBytes && warmCatchupPasses < 16) {
      warmCatchup = await claudeTranscriptTurnAuthorityResult(warmBoundedFile, { maxElapsedMs: 1000 });
      warmCaughtUpBytes += warmCatchup.scannedBytes;
      warmCatchupPasses += 1;
      if (warmCatchup.scannedBytes === 0) break;
    }
    check(
      'unchanged warm Claude fallback advances to EOF in bounded passes without rescanning processed bytes',
      warmCatchup.kind === 'fallback'
        && warmCatchup.authority === 'active'
        && warmCatchup.reason === 'record-limit'
        && warmCaughtUpBytes === warmAppendBytes
        && warmCatchupPasses === warmAppendBytes / (64 * 1024 * 1024),
      JSON.stringify({ warmCatchup, warmCaughtUpBytes, warmCatchupPasses }),
    );

    const warmSettled = await claudeTranscriptTurnAuthorityResult(warmBoundedFile);
    check(
      'settled opaque Claude fallback performs zero repeated source work',
      warmSettled.kind === 'fallback'
        && warmSettled.authority === 'active'
        && warmSettled.reason === 'record-limit'
        && warmSettled.scannedBytes === 0,
      JSON.stringify(warmSettled),
    );

    appendFileSync(warmBoundedFile, '\n' + [
      { type: 'user', uuid: 'warm-result', timestamp: T9, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'warm-tool', content: 'finished' }] } },
      { type: 'assistant', uuid: 'warm-done', timestamp: T10, message: { id: 'warm-done-m', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Warm done.' }] } },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n');
    const warmCompleted = await claudeTranscriptTurnAuthorityResult(warmBoundedFile);
    check(
      'exact Claude completion after an opaque warm append promptly restores terminal authority',
      warmCompleted.kind === 'authority'
        && warmCompleted.authority === 'terminal'
        && warmCompleted.scannedBytes > 0
        && warmCompleted.scannedBytes < 2048,
      JSON.stringify(warmCompleted),
    );

    const warmBeyondBudgetFile = join(dir, 'warm-terminal-beyond-budget.jsonl');
    writeFileSync(warmBeyondBudgetFile, warmActiveLines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    await claudeTranscriptTurnAuthorityResult(warmBeyondBudgetFile);
    const warmProgress = Buffer.from(JSON.stringify({
      type: 'progress',
      timestamp: T9,
      data: { message: 'catch-up', chunk: 'x'.repeat(512 * 1024) },
    }) + '\n');
    const warmProgressTarget = 70 * 1024 * 1024;
    let warmProgressBytes = 0;
    const warmBeyondBudgetFd = openSync(warmBeyondBudgetFile, 'a');
    while (warmProgressBytes < warmProgressTarget) {
      writeSync(warmBeyondBudgetFd, warmProgress);
      warmProgressBytes += warmProgress.length;
    }
    const warmExactCompletion = Buffer.from(JSON.stringify({
      type: 'assistant',
      uuid: 'warm-beyond-done',
      timestamp: T10,
      message: {
        id: 'warm-beyond-done-m',
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Caught up.' }],
      },
    }) + '\n');
    writeSync(warmBeyondBudgetFd, warmExactCompletion);
    closeSync(warmBeyondBudgetFd);

    const warmFirstBudget = await claudeTranscriptTurnAuthorityResult(warmBeyondBudgetFile, { maxElapsedMs: 1000 });
    const warmSecondBudget = await claudeTranscriptTurnAuthorityResult(warmBeyondBudgetFile, { maxElapsedMs: 1000 });
    check(
      'warm Claude scan resumes beyond 64 MiB and publishes an already-present exact completion',
      warmFirstBudget.kind === 'fallback'
        && warmFirstBudget.authority === 'active'
        && warmFirstBudget.reason === 'source-limit'
        && warmFirstBudget.scannedBytes === 64 * 1024 * 1024
        && warmSecondBudget.kind === 'authority'
        && warmSecondBudget.authority === 'terminal'
        && warmSecondBudget.scannedBytes > warmProgressBytes - warmFirstBudget.scannedBytes
        && warmSecondBudget.scannedBytes < 8 * 1024 * 1024,
      JSON.stringify({ warmFirstBudget, warmSecondBudget, warmProgressBytes }),
    );

    const warmRecordLimitedFile = join(dir, 'warm-record-limit.jsonl');
    writeFileSync(warmRecordLimitedFile, warmActiveLines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    await claudeTranscriptTurnAuthorityResult(warmRecordLimitedFile);
    const warmRecordSeedSize = statSync(warmRecordLimitedFile).size;
    const warmRecordFd = openSync(warmRecordLimitedFile, 'r+');
    writeSync(warmRecordFd, incompleteStart, 0, incompleteStart.length, warmRecordSeedSize);
    ftruncateSync(warmRecordFd, warmRecordSeedSize + 2 * 1024 * 1024);
    closeSync(warmRecordFd);
    const warmRecordBounded = await claudeTranscriptTurnAuthorityResult(warmRecordLimitedFile);
    check(
      'warm Claude oversized record has a distinct typed record fallback',
      warmRecordBounded.kind === 'fallback'
        && warmRecordBounded.authority === 'active'
        && warmRecordBounded.reason === 'record-limit'
        && warmRecordBounded.scannedBytes === 2 * 1024 * 1024,
      JSON.stringify(warmRecordBounded),
    );

    const warmTimeLimitedFile = join(dir, 'warm-time-limit.jsonl');
    writeFileSync(warmTimeLimitedFile, warmActiveLines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    await claudeTranscriptTurnAuthorityResult(warmTimeLimitedFile);
    const warmTimeSeedSize = statSync(warmTimeLimitedFile).size;
    const warmTimeFd = openSync(warmTimeLimitedFile, 'r+');
    writeSync(warmTimeFd, incompleteStart, 0, incompleteStart.length, warmTimeSeedSize);
    ftruncateSync(warmTimeFd, warmTimeSeedSize + 256 * 1024 * 1024);
    closeSync(warmTimeFd);
    const warmTimeBounded = await claudeTranscriptTurnAuthorityResult(warmTimeLimitedFile, {
      maxSourceBytes: 256 * 1024 * 1024,
      maxElapsedMs: 1,
    });
    check(
      'warm Claude append has a distinct typed wall-clock fallback',
      warmTimeBounded.kind === 'fallback'
        && warmTimeBounded.authority === 'active'
        && warmTimeBounded.reason === 'time-limit'
        && warmTimeBounded.scannedBytes > 0
        && warmTimeBounded.scannedBytes < 256 * 1024 * 1024,
      JSON.stringify(warmTimeBounded),
    );

    const warmRacedFile = join(dir, 'warm-raced-source.jsonl');
    const warmReplacementActive = JSON.stringify({
      type: 'user',
      uuid: 'warm-same-size-user',
      timestamp: T9,
      message: { role: 'user', content: 'x'.repeat(interruptText.length) },
    }) + '\n';
    const warmReplacementTerminal = JSON.stringify({
      type: 'user',
      uuid: 'warm-same-size-user',
      timestamp: T9,
      message: { role: 'user', content: interruptText },
    }) + '\n';
    const warmSeedText = warmActiveLines.map((line) => JSON.stringify(line)).join('\n') + '\n';
    writeFileSync(warmRacedFile, warmSeedText);
    await claudeTranscriptTurnAuthorityResult(warmRacedFile);
    appendFileSync(warmRacedFile, warmReplacementActive);
    const warmRacedStat = statSync(warmRacedFile);
    const warmChanged = await claudeTranscriptTurnAuthorityResult(warmRacedFile, {
      beforeValidation: () => {
        writeFileSync(warmRacedFile, warmSeedText + warmReplacementTerminal);
        utimesSync(warmRacedFile, warmRacedStat.atime, warmRacedStat.mtime);
      },
    });
    check(
      'warm Claude scan rejects a same-inode/same-size rewrite before publication',
      warmChanged.kind === 'fallback'
        && warmChanged.reason === 'source-changed'
        && Buffer.byteLength(warmReplacementActive) === Buffer.byteLength(warmReplacementTerminal)
        && await claudeSessionStatus(warmRacedFile, 'working', ms(T10) + 1) === 'idle',
      JSON.stringify(warmChanged),
    );

    const warmAppendRacedFile = join(dir, 'warm-append-raced.jsonl');
    const warmProgressLine = JSON.stringify({
      type: 'progress',
      timestamp: T9,
      data: { message: 'append race' },
    }) + '\n';
    const warmLateProgressLine = JSON.stringify({
      type: 'progress',
      timestamp: T10,
      data: { message: 'late append' },
    }) + '\n';
    writeFileSync(warmAppendRacedFile, warmSeedText);
    await claudeTranscriptTurnAuthorityResult(warmAppendRacedFile);
    appendFileSync(warmAppendRacedFile, warmProgressLine);
    const warmAppendChanged = await claudeTranscriptTurnAuthorityResult(warmAppendRacedFile, {
      beforeValidation: () => {
        appendFileSync(warmAppendRacedFile, warmLateProgressLine);
      },
    });
    const warmAppendSettled = await claudeTranscriptTurnAuthorityResult(warmAppendRacedFile);
    check(
      'append racing an admitted warm Claude scan keeps published active authority',
      warmAppendChanged.kind === 'fallback'
        && warmAppendChanged.reason === 'source-changed'
        && warmAppendChanged.authority === 'active'
        && warmAppendSettled.kind === 'authority'
        && warmAppendSettled.authority === 'active',
      JSON.stringify({ warmAppendChanged, warmAppendSettled }),
    );

    const observe = new ClaudeObserveConnection(file, { id: 'sess', tool: 'claude', title: 'quiet', status: 'idle', attachMode: 'observe' });
    const live: AgentMessage[] = [];
    const attention = new AttentionService({ store: { home: join(dir, 'attention') } });
    const attentionWork: Promise<void>[] = [];
    observe.subscribe((message) => {
      live.push(message);
      attentionWork.push(attention.handleMessage(observe.info, message));
    });
    const firstHistory = await observe.getHistory();
    const replayHistory = await observe.getHistory();
    const open = (history: AgentMessage[]) => history.filter((m: any) => m.type === 'run-summary' && m.turnId === 'u2');
    check(
      'discovery status, attach status, replay, and resync cannot finalize a quiet open tool',
      [firstHistory, replayHistory].every((history) => open(history).some((m: any) => m.status === 'running') && !open(history).some((m: any) => m.status !== 'running')),
      JSON.stringify([open(firstHistory), open(replayHistory)]),
    );

    appendFileSync(file, [
      { type: 'user', uuid: 'tr', timestamp: T5, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'quiet-tool', content: 'finished' }] } },
      { type: 'assistant', uuid: 'a4', timestamp: T6, message: { id: 'm4', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done after the quiet tool.' }] } },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n');
    const terminalArrived = await waitFor(() => live.some((m: any) => m.type === 'run-summary' && m.turnId === 'u2' && m.status === 'done'), 3000);
    const terminal = live.filter((m: any) => m.type === 'run-summary' && m.turnId === 'u2' && m.status === 'done') as any[];
    const idle = live.filter((m: any) => m.type === 'status' && m.status === 'idle');
    check(
      'tool_result plus end_turn emits one Idle and one footer at authoritative completion time',
      terminalArrived && idle.length === 1 && terminal.length === 1 && terminal[0]?.completedAt === ms(T6) && terminal[0]?.totalRuntimeMs === ms(T6) - ms(T3),
      JSON.stringify({ idle: idle.length, terminal }),
    );
    check('terminal transcript authority promptly projects Idle', await claudeSessionStatus(file, 'working', ms(T6) + 1) === 'idle');

    appendFileSync(file, [
      { type: 'user', uuid: 'u3', timestamp: T7, message: { role: 'user', content: 'third prompt' } },
      { type: 'assistant', uuid: 'a5', timestamp: T8, message: { id: 'm5', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tool-3', name: 'Bash', input: { command: 'true' } }] } },
      { type: 'user', uuid: 'tr3', timestamp: T9, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-3', content: 'ok' }] } },
      { type: 'assistant', uuid: 'a6', timestamp: T10, message: { id: 'm6', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Third done.' }] } },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n');
    await waitFor(() => live.some((m: any) => m.type === 'run-summary' && m.turnId === 'u3' && m.status === 'done'), 3000);
    await Promise.all(attentionWork);
    const attentionEvent = attention.store.findByDedupeKey('run-finished:claude:sess:u3');
    check(
      'one exact live running→done pair creates one turn-fenced Attention event',
      attentionEvent?.turnId === 'u3' && attentionEvent.presentationRevision === 1,
      JSON.stringify(attentionEvent),
    );
    attention.dispose();
    await observe.close();

    const resetActive = [
      { type: 'user', uuid: 'reset-u', timestamp: T7, message: { role: 'user', content: 'replacement prompt' } },
      { type: 'assistant', uuid: 'reset-a', timestamp: T8, message: { id: 'reset-m', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'reset-tool', name: 'Bash', input: { command: 'sleep 1' } }] } },
    ];
    writeFileSync(file, resetActive.map((line) => JSON.stringify(line)).join('\n') + '\n');
    check('transcript truncation resets and admits the replacement tool turn', await claudeSessionStatus(file, 'working', ms(T9)) === 'working');
    appendFileSync(file, JSON.stringify({ type: 'assistant', uuid: 'reset-done', timestamp: T9, message: { id: 'reset-done-m', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } }) + '\n');
    check('truncated replacement closes on its own exact end_turn', await claudeSessionStatus(file, 'working', ms(T10)) === 'idle');

    const replacement = join(dir, 'replacement.jsonl');
    writeFileSync(replacement, resetActive.map((line) => JSON.stringify(line)).join('\n') + '\n');
    renameSync(replacement, file);
    check('atomic transcript replacement resets and admits its exact tool turn', await claudeSessionStatus(file, 'working', ms(T9)) === 'working');
    appendFileSync(file, JSON.stringify({ type: 'assistant', uuid: 'replacement-done', timestamp: T10, message: { id: 'replacement-done-m', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } }) + '\n');
    check('atomic replacement closes on its own exact end_turn', await claudeSessionStatus(file, 'working', ms(T10) + 1) === 'idle');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── real-data smoke (best-effort; SKIPS when no local transcript is present, e.g. CI) ──
{
  const projects = join(homedir(), '.claude', 'projects');
  let smoked = false;
  try {
    if (existsSync(projects)) {
      const slugs = readdirSync(projects, { withFileTypes: true }).filter((d) => d.isDirectory());
      outer: for (const slug of slugs) {
        const dir = join(projects, slug.name);
        for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl')).slice(0, 12)) {
          const lines = readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((s) => { try { return JSON.parse(s); } catch { return null; } });
          const tracker = new ClaudeRuntimeTracker(f.replace(/\.jsonl$/, ''), 'claude-transcript');
          const out = [...mapTranscript(lines, tracker), ...tracker.flush()];
          const runs = out.filter((m: any) => m.type === 'run-summary') as any[];
          const userMsgs = out.filter((m: any) => m.type === 'user-message') as any[];
          // need a real session with at least one completed turn carrying a positive duration
          const done = runs.filter((r) => r.status === 'done' && typeof r.totalRuntimeMs === 'number');
          if (done.length >= 1 && userMsgs.length >= 1) {
            const totals = out.filter((m: any) => m.type === 'metadata-update' && m.key === 'runtimeTotals') as any[];
            check(`real-data smoke (${slug.name}/${f.slice(0, 8)}): durations ≥ 0, totals ≥ turns, sentAt sane`,
              done.every((r) => r.totalRuntimeMs >= 0) &&
              runs.every((r) => r.startedAt === undefined || r.completedAt === undefined || r.completedAt >= r.startedAt) &&
              userMsgs.every((u) => u.sentAt === undefined || u.sentAt > 0) &&
              totals.length >= 1 && totals.at(-1).value.turnCount === done.length,
              `${done.length} completed turns, ${userMsgs.length} prompts`);
            smoked = true;
            break outer;
          }
        }
      }
    }
  } catch (e) {
    check('real-data smoke ran without throwing', false, String(e));
    smoked = true;
  }
  if (!smoked) console.log('SKIP  real-data smoke — no local transcript with a completed turn found (hermetic env)');
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
