/**
 * The observe connection: replay a transcript, then follow it.
 *
 * Four properties are asserted here:
 *
 *  1. Each step is admitted EXACTLY ONCE across the buffered, cutoff and re-read
 *     paths. The history read and the live tail partition the file at a byte
 *     boundary, and `step_index` is a second, independent fence — so even a
 *     drain racing a re-read cannot double a row.
 *  2. A rewritten or shrunk transcript RE-BASELINES wholesale rather than
 *     splicing two different files together.
 *  3. A `RUNNING` row replayed with no live child reads as interrupted.
 *  4. Durable rows replay; transient control signals do not become chat rows.
 *
 * Every check runs against a temp fixture tree, never a live install.
 *
 *   bun run packages/typescript/adapters/antigravity/test/test-agy-observe.ts   (exit 0 = all pass)
 */
export {};
import { appendFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentMessage } from '@cosyncing/adapter-api';
import {
  AGY_MODES,
  AGY_TAIL_READ_MAX_BYTES,
  AGY_TASK_LOG_MAX_BYTES,
  AGY_TRANSCRIPT_MAX_BYTES,
  AGY_TRUNCATION_NOTE,
  AgyObserveConnection,
  agyStepKey,
  agyStepOffset,
  type AgyStep,
  type AgyTrace,
} from '../src/index.ts';
import { buildAgyFixtureTree, FIXTURE, jsonl } from './fixtures/tree.ts';

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const CONVERSATION = FIXTURE.conversationIds.withTranscript;

function infoFor(id: string) {
  return {
    id,
    nativeId: id,
    tool: 'agy',
    title: 'Demo Project Review',
    status: 'idle' as const,
    attachMode: 'observe' as const,
  };
}

/** Let the debounced fs.watch drain fire. The tail debounce is 80 ms. */
function settle(ms = 260): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until a predicate holds. Test synchronization, not production polling. */
async function waitUntil(predicate: () => boolean, timeoutMs = 6000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

/** Poll until a matching message arrives. Test synchronization, not production polling. */
async function waitForMessage(
  messages: AgentMessage[],
  match: (message: AgentMessage) => boolean,
  timeoutMs = 6000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (messages.some(match)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return messages.some(match);
}

/** Every stable identity a message carries, for exactly-once accounting. */
function identity(message: AgentMessage): string {
  const record = message as unknown as Record<string, unknown>;
  return `${message.type}:${String(record.key ?? record.callId ?? '')}`;
}

function duplicates(messages: AgentMessage[]): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const message of messages) {
    // Keyless control frames (notice, history-reset) are legitimately repeatable.
    const record = message as unknown as Record<string, unknown>;
    if (record.key === undefined && record.callId === undefined) continue;
    const id = identity(message);
    if (seen.has(id)) dupes.push(id);
    seen.add(id);
  }
  return dupes;
}

// ── 1. Replay ───────────────────────────────────────────────────────────────
{
  const tree = buildAgyFixtureTree();
  try {
    const connection = new AgyObserveConnection({
      roots: tree.roots, conversationId: CONVERSATION, info: infoFor(CONVERSATION), trace: () => {},
    });
    const history = await connection.getHistory();
    check('a recorded conversation replays', history.length > 0, `${history.length} messages`);
    check('the replay contains no duplicate keyed rows', duplicates(history).length === 0, duplicates(history).join(', '));
    check('exactly one user bubble', history.filter((m) => m.type === 'user-message').length === 1);
    check('the user bubble uses the step key',
      (history.find((m) => m.type === 'user-message') as { key?: string }).key === agyStepKey(CONVERSATION, 0),
      String((history.find((m) => m.type === 'user-message') as { key?: string }).key));

    // Durable rows replay; the transient control signal is a history-reset, which
    // is a control frame and not a chat bubble.
    check('durable rows (user/model/tool) are present in the replay',
      history.some((m) => m.type === 'model-output')
        && history.some((m) => m.type === 'tool-call')
        && history.some((m) => m.type === 'tool-result'));
    check('the compaction boundary replays as a control history-reset, not a chat row',
      history.some((m) => m.type === 'history-reset'));

    // A second read is idempotent: the fold is rebuilt from the file, so nothing
    // carries over and nothing doubles.
    const second = await connection.getHistory();
    check('a re-read is idempotent (same message count, same keys)',
      second.length === history.length
        && second.map(identity).join('|') === history.map(identity).join('|'),
      `${history.length} vs ${second.length}`);
    await connection.close();
  } finally {
    tree.cleanup();
  }
}

// ── 2. Tail: exactly once across replay and live ────────────────────────────
{
  // Write only the first 25 steps, then append the rest while subscribed.
  const tree = buildAgyFixtureTree({ transcriptSteps: 25 });
  try {
    const connection = new AgyObserveConnection({
      roots: tree.roots, conversationId: CONVERSATION, info: infoFor(CONVERSATION), trace: () => {},
    });
    const live: AgentMessage[] = [];
    connection.subscribe((message) => live.push(message));
    const history = await connection.getHistory();

    appendFileSync(tree.transcriptPath, jsonl(FIXTURE.appendedSteps));
    await settle();

    check('appended steps arrive on the tail', live.length > 0, `${live.length} live messages`);
    check('the appended RUN_COMMAND result arrived with its exit code',
      live.some((m) => m.type === 'tool-result' && (m as { exitCode?: number }).exitCode === 1),
      live.map((m) => m.type).join(','));
    check('the appended final model output arrived',
      live.some((m) => m.type === 'model-output' && String((m as { text?: string }).text).includes('review is complete')));

    const combined = [...history, ...live];
    check('no step is admitted twice across the replay and the tail',
      duplicates(combined).length === 0, duplicates(combined).join(', '));

    // A drain fired again with nothing new must emit nothing.
    const before = live.length;
    appendFileSync(tree.transcriptPath, '');
    await settle();
    check('a watch event with no new bytes emits nothing', live.length === before, `${before} → ${live.length}`);

    // Re-writing the SAME content (same size) must not re-emit either: the step
    // fence catches what a byte offset alone would miss.
    const countBefore = live.length;
    await connection.getHistory();
    await settle();
    check('a fresh getHistory does not cause the tail to re-emit already-seen steps',
      live.length === countBefore, `${countBefore} → ${live.length}`);
    await connection.close();
  } finally {
    tree.cleanup();
  }
}

// ── 3. A partial trailing line is never mapped twice ────────────────────────
{
  const tree = buildAgyFixtureTree({ transcriptSteps: 3 });
  try {
    const connection = new AgyObserveConnection({
      roots: tree.roots, conversationId: CONVERSATION, info: infoFor(CONVERSATION), trace: () => {},
    });
    const live: AgentMessage[] = [];
    connection.subscribe((message) => live.push(message));
    const history = await connection.getHistory();

    // Write half a line, then complete it — the classic double-admit shape.
    const step = JSON.stringify(FIXTURE.transcript[3]);
    const half = step.slice(0, 40);
    appendFileSync(tree.transcriptPath, half);
    await settle();
    check('a partial trailing line emits nothing until its newline lands',
      !live.some((m) => m.type === 'model-output'), live.map((m) => m.type).join(','));

    appendFileSync(tree.transcriptPath, step.slice(40) + '\n');
    await settle();
    check('the completed line is then admitted exactly once',
      live.filter((m) => m.type === 'thinking').length === 1, `${live.filter((m) => m.type === 'thinking').length}`);
    check('replay + tail still has no duplicates', duplicates([...history, ...live]).length === 0);
    await connection.close();
  } finally {
    tree.cleanup();
  }
}

// ── 4. A rewritten transcript re-baselines wholesale ────────────────────────
{
  const tree = buildAgyFixtureTree();
  try {
    const traces: AgyTrace[] = [];
    const connection = new AgyObserveConnection({
      roots: tree.roots, conversationId: CONVERSATION, info: infoFor(CONVERSATION), trace: (t) => traces.push(t),
    });
    const live: AgentMessage[] = [];
    connection.subscribe((message) => live.push(message));
    await connection.getHistory();

    // Replace the file with a SHORTER, different transcript.
    writeFileSync(tree.transcriptPath, jsonl(FIXTURE.transcript.slice(0, 3)));
    await settle();

    check('a shrunk transcript emits a history-reset rather than splicing',
      live.some((m) => m.type === 'history-reset'), live.map((m) => m.type).join(','));
    check('the rewrite left a structured trace',
      traces.some((trace) => trace.op === 'transcript-rewritten'), traces.map((t) => t.op).join(', '));

    // The broker re-reads history after a reset; that read must describe the NEW
    // file. The new file is steps 0-2 only, so no TRANSCRIPT-derived tool call
    // survives — the settlement block does, and correctly so: the inbox is a
    // separate durable source that the transcript rewrite did not touch.
    const rebuilt = await connection.getHistory();
    const transcriptCalls = rebuilt.filter(
      (m) => m.type === 'tool-call' && String((m as { callId: string }).callId).includes(':call:'),
    );
    check('the post-reset history describes the new file: no transcript tool calls survive',
      transcriptCalls.length === 0, `${transcriptCalls.length} of ${rebuilt.length} messages`);
    check('no model output from the discarded steps survives',
      !rebuilt.some((m) => m.type === 'model-output'), rebuilt.map((m) => m.type).join(','));
    check('the settlement block still replays (a separate durable source)',
      rebuilt.some((m) => m.type === 'tool-call' && String((m as { callId: string }).callId).includes(':task:')));
    check('the post-reset history has no duplicates', duplicates(rebuilt).length === 0);
    await connection.close();
  } finally {
    tree.cleanup();
  }
}

// ── 5. A RUNNING row with no live child ─────────────────────────────────────
{
  const tree = buildAgyFixtureTree();
  try {
    const connection = new AgyObserveConnection({
      roots: tree.roots, conversationId: CONVERSATION, info: infoFor(CONVERSATION), trace: () => {},
    });
    const history = await connection.getHistory();
    check('observe never reports a running status frame for a replayed RUNNING row',
      !history.some((m) => m.type === 'status' && (m as { status: string }).status === 'running'),
      history.filter((m) => m.type === 'status').map((m) => JSON.stringify(m)).join(','));

    // The RUNNING planner row (step 24) opened a `git status` call that never
    // resolved; it must render as a call, not as a spinner that never stops.
    check('the RUNNING row still renders its content and its call',
      history.some((m) => m.type === 'tool-call' && (m as { toolName: string }).toolName === 'run_command'));
    await connection.close();
  } finally {
    tree.cleanup();
  }
}

// ── 6. Truncation: recovered when possible, STATED when not ─────────────────
{
  const withFull = buildAgyFixtureTree();
  try {
    const connection = new AgyObserveConnection({
      roots: withFull.roots, conversationId: CONVERSATION, info: infoFor(CONVERSATION), trace: () => {},
    });
    const history = await connection.getHistory();
    const view = history.find((m) => m.type === 'tool-result' && (m as { toolName: string }).toolName === 'view_file') as {
      result?: unknown; truncated?: boolean;
    };
    check('a truncated field is recovered from transcript_full.jsonl',
      String(view.result).includes('A small example used by the adapter test fixtures'),
      String(view.result).slice(-70));
    check('a recovered row is no longer marked truncated', view.truncated === undefined, String(view.truncated));
    await connection.close();
  } finally {
    withFull.cleanup();
  }

  const withoutFull = buildAgyFixtureTree({ withoutTranscriptFull: true });
  try {
    const traces: AgyTrace[] = [];
    const connection = new AgyObserveConnection({
      roots: withoutFull.roots, conversationId: CONVERSATION, info: infoFor(CONVERSATION), trace: (t) => traces.push(t),
    });
    const history = await connection.getHistory();
    const view = history.find((m) => m.type === 'tool-result' && (m as { toolName: string }).toolName === 'view_file') as {
      result?: unknown; truncated?: boolean;
    };
    check('with no transcript_full, the truncation is STATED rather than silently short',
      String(view.result).includes(AGY_TRUNCATION_NOTE), String(view.result).slice(-90));
    check('the row is flagged truncated', view.truncated === true, String(view.truncated));
    check('the missing full transcript left a structured trace',
      traces.some((trace) => trace.op === 'transcript-full-missing'), traces.map((t) => t.op).join(', '));
    await connection.close();
  } finally {
    withoutFull.cleanup();
  }
}

// ── 7. Settlement blocks replay ─────────────────────────────────────────────
{
  const tree = buildAgyFixtureTree();
  try {
    const connection = new AgyObserveConnection({
      roots: tree.roots, conversationId: CONVERSATION, info: infoFor(CONVERSATION), trace: () => {},
    });
    const history = await connection.getHistory();
    const settlement = history.filter((m) =>
      (m.type === 'tool-call' || m.type === 'tool-result')
      && String((m as { callId: string }).callId).includes('task-7'));
    check('a finished background task replays as a self-contained tool block',
      settlement.length === 2, `${settlement.length} rows`);
    check('the settlement is never a user message',
      !history.some((m) => m.type === 'user-message' && String((m as { text: string }).text).includes('finished with result')));
    check('read.json and undelivered/ are not mistaken for messages',
      history.filter((m) => m.type === 'tool-call'
        && String((m as { callId: string }).callId).includes(':task:')).length === 1);
    await connection.close();
  } finally {
    tree.cleanup();
  }

  const bare = buildAgyFixtureTree({ withoutSettlement: true });
  try {
    const connection = new AgyObserveConnection({
      roots: bare.roots, conversationId: CONVERSATION, info: infoFor(CONVERSATION), trace: () => {},
    });
    const history = await connection.getHistory();
    check('a conversation with no inbox replays cleanly',
      !history.some((m) => String((m as { callId?: string }).callId ?? '').includes(':task:')));
    await connection.close();
  } finally {
    bare.cleanup();
  }
}

// ── 8. Read-only, and close is terminal ─────────────────────────────────────
{
  const tree = buildAgyFixtureTree();
  try {
    const connection = new AgyObserveConnection({
      roots: tree.roots, conversationId: CONVERSATION, info: infoFor(CONVERSATION), trace: () => {},
    });
    let promptRefused = false;
    try {
      await connection.sendPrompt({ text: 'this must not be accepted' });
    } catch {
      promptRefused = true;
    }
    check('sendPrompt is refused on an observe connection', promptRefused);

    let permissionRefused = false;
    try {
      await connection.respondPermission('req-1', 'approve');
    } catch {
      permissionRefused = true;
    }
    check('respondPermission is refused on an observe connection', permissionRefused);

    const live: AgentMessage[] = [];
    const unsubscribe = connection.subscribe((message) => live.push(message));
    await connection.getHistory();
    unsubscribe();
    appendFileSync(tree.transcriptPath, jsonl(FIXTURE.appendedSteps));
    await settle();
    check('an unsubscribed handler stops receiving', live.length === 0, `${live.length}`);

    await connection.close();
    const after = live.length;
    appendFileSync(tree.transcriptPath, jsonl([FIXTURE.transcript[0]!]));
    await settle();
    check('close stops the tail', live.length === after, `${after} → ${live.length}`);
  } finally {
    tree.cleanup();
  }
}

// ── 9. A missing transcript observes without crashing ───────────────────────
{
  const tree = buildAgyFixtureTree();
  try {
    const id = FIXTURE.conversationIds.withoutTranscript;
    const connection = new AgyObserveConnection({
      roots: tree.roots, conversationId: id, info: infoFor(id), trace: () => {},
    });
    const live: AgentMessage[] = [];
    connection.subscribe((message) => live.push(message));
    const history = await connection.getHistory();
    check('a missing transcript replays a notice and does not throw',
      history.length === 1 && history[0]!.type === 'notice', JSON.stringify(history));
    await settle(120);
    check('subscribing to a missing transcript emits nothing and does not crash', live.length === 0);
    await connection.close();
  } finally {
    tree.cleanup();
  }
}

// ── 10. The transcript read is bounded and its boundary is honest ───────────
//
// The transcript is the one file this adapter reads with no bound on who wrote
// it or how large it grew. These pin the two outcomes that must never be silent:
// a file too big to replay whole SAYS it was capped, and a transcript path that
// resolves to something other than a regular file inside the store is REFUSED
// with a stated reason rather than rendered as an empty conversation.
{
  const tree = buildAgyFixtureTree();
  try {
    // Lines are made large rather than numerous so the FILE cap is reached in a
    // few hundred parseable steps: what is under test here is the file-level byte
    // boundary, not the parser. Each line stays well under the per-LINE cap —
    // those two bounds are independent, and a fixture that tripped the line cap
    // would be measuring the wrong one (it did: at 1 MiB per line every line was
    // dropped as over-cap and the replay delivered nothing).
    const chunk = 'y'.repeat(256 * 1024);
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 160; i += 1) {
      rows.push({
        step_index: 900 + i,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-08-15T10:10:23Z',
        content: chunk,
      });
    }
    writeFileSync(tree.transcriptPath, jsonl(rows));

    const traces: AgyTrace[] = [];
    const connection = new AgyObserveConnection({
      roots: tree.roots,
      conversationId: CONVERSATION,
      info: infoFor(CONVERSATION),
      trace: (trace) => traces.push(trace),
    });
    const history = await connection.getHistory();
    const notice = history.find(
      (message) => message.type === 'notice' && /replay limit/.test((message as { message: string }).message),
    );
    check(
      'a transcript past the replay cap replays a prefix and SAYS it was capped',
      notice !== undefined && traces.some((trace) => trace.op === 'transcript-oversized'),
      traces.map((trace) => trace.op).join(','),
    );
    const replayed = history.filter((message) => message.type === 'model-output').length;
    check(
      'the capped replay still delivers the steps that fit',
      replayed > 0 && replayed < rows.length,
      `${replayed} of ${rows.length} steps`,
    );
    check(
      'the cap is below the file, so the whole file was never allocated',
      AGY_TRANSCRIPT_MAX_BYTES < rows.length * chunk.length,
      `cap ${AGY_TRANSCRIPT_MAX_BYTES} < file ~${rows.length * chunk.length}`,
    );
    await connection.close();
  } finally {
    tree.cleanup();
  }
}

{
  const tree = buildAgyFixtureTree();
  try {
    // The transcript path now names a SYMLINK pointing out of the store. The
    // string is unchanged and passes every lexical check; the bytes are not ours.
    const outside = join(tree.dir, 'not-a-transcript.jsonl');
    writeFileSync(outside, jsonl([{
      step_index: 1,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-08-15T10:10:23Z',
      content: 'PLANTED',
    }]));
    rmSync(tree.transcriptPath, { force: true });
    symlinkSync(outside, tree.transcriptPath);

    const traces: AgyTrace[] = [];
    const connection = new AgyObserveConnection({
      roots: tree.roots,
      conversationId: CONVERSATION,
      info: infoFor(CONVERSATION),
      trace: (trace) => traces.push(trace),
    });
    const history = await connection.getHistory();
    check(
      'a symlinked transcript is refused rather than followed out of the store',
      !JSON.stringify(history).includes('PLANTED')
      && traces.some((trace) => trace.op === 'read-refused-symlink'),
      traces.map((trace) => trace.op).join(','),
    );
    check(
      'the refusal is STATED to the user, not rendered as an empty conversation',
      history.some(
        (message) => message.type === 'notice'
          && /could not be read safely/.test((message as { message: string }).message),
      ),
      JSON.stringify(history.filter((message) => message.type === 'notice')).slice(0, 140),
    );
    await connection.close();
  } finally {
    tree.cleanup();
  }
}

// ── 11. The per-LINE cap holds however the bytes arrive ─────────────────────
//
// The defect: complete lines were framed and processed BEFORE the size check,
// which only ever looked at the unterminated remainder. An over-cap line that
// arrived with its newline — in one write, or split across writes ending on it —
// went through whole, past the advertised cap, with nothing traced. Whether the
// bound held was a property of the WRITER's chunking, not of this reader.
//
// The transcript cap and the line cap are independent: these lines sit far below
// the 32 MiB file cap, so only the line rule can be what refuses them.
{
  const tree = buildAgyFixtureTree({ transcriptSteps: 2 });
  try {
    const traces: AgyTrace[] = [];
    const connection = new AgyObserveConnection({
      roots: tree.roots,
      conversationId: CONVERSATION,
      info: infoFor(CONVERSATION),
      trace: (trace) => traces.push(trace),
    });
    const seen: AgentMessage[] = [];
    connection.subscribe((message) => seen.push(message));
    await connection.getHistory();

    // ONE write: the whole over-cap line, newline included, lands at once.
    const huge = '日'.repeat(800_000); // 3 bytes each → ~2.4 MB, over the 1 MiB line cap
    appendFileSync(tree.transcriptPath, jsonl([{
      step_index: 700,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-08-15T10:10:23Z',
      content: huge,
    }]));
    await settle(400);
    check(
      'an over-cap line arriving COMPLETE is dropped, with a trace',
      traces.some((trace) => trace.op === 'transcript-line-oversized'),
      traces.map((trace) => trace.op).join(','),
    );
    check(
      'the over-cap line is never emitted',
      !seen.some((m) => m.type === 'model-output' && String((m as { text?: string }).text).includes('日日日')),
      seen.map((m) => m.type).join(','),
    );

    // SPLIT: the same size, written in pieces, with the newline arriving last.
    const before = traces.filter((trace) => trace.op === 'transcript-line-oversized').length;
    const piece = '月'.repeat(200_000);
    const opening = `{"step_index":701,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE",`
      + `"created_at":"2026-08-15T10:10:23Z","content":"`;
    appendFileSync(tree.transcriptPath, opening);
    await settle(150);
    for (let i = 0; i < 4; i += 1) {
      appendFileSync(tree.transcriptPath, piece);
      await settle(150);
    }
    appendFileSync(tree.transcriptPath, '"}\n');
    await settle(400);
    check(
      'an over-cap line arriving SPLIT across writes is dropped too',
      traces.filter((trace) => trace.op === 'transcript-line-oversized').length > before,
      `${before} → ${traces.filter((trace) => trace.op === 'transcript-line-oversized').length}`,
    );

    // The reader must resync: an ordinary line after the dropped ones still lands.
    appendFileSync(tree.transcriptPath, jsonl([{
      step_index: 702,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-08-15T10:10:23Z',
      content: 'back to normal',
    }]));
    check(
      'the tail resyncs and the NEXT ordinary line is still delivered',
      await waitForMessage(seen, (m) => m.type === 'model-output'
        && String((m as { text?: string }).text).includes('back to normal')),
      seen.map((m) => m.type).join(','),
    );
    await connection.close();
  } finally {
    tree.cleanup();
  }
}

// ── 12. A multibyte character straddling a DRAIN boundary ──────────────────
//
// The per-drain read cuts the file at an arbitrary byte, so a multibyte
// character routinely lands across two ranges. Decoding each range on its own
// produced U+FFFD on both sides — and re-encoding those replacement characters
// changed the line's measured length, so every `byteOffset` after it in that
// drain drifted. Those offsets are the queued-send fence that decides whether a
// transcript line delivers a prompt this connection sent, so the drift did not
// merely garble text: it undermined ownership.
//
// The drain bound is injected here because the interesting behaviour is exactly
// AT the boundary and materializing 8 MiB to reach the real one costs far more
// than the assertion is worth. The next block asserts the default IS the
// production constant, so the shrunken bound cannot drift from what ships.
{
  /** Records what the fold actually admitted, with each step's byte offset. */
  class OffsetSpy extends AgyObserveConnection {
    readonly admitted: Array<{ index: number; offset: number | undefined; content: string }> = [];
    protected override onStepAdmitted(step: AgyStep, _messages: AgentMessage[], _source: 'replay' | 'tail'): void {
      this.admitted.push({
        index: step.step_index,
        offset: agyStepOffset(step),
        content: step.content ?? '',
      });
    }
  }

  const tree = buildAgyFixtureTree({ transcriptSteps: 1 });
  try {
    // The line whose CJK run the drain boundary has to cut. The bound is derived
    // FROM the line rather than searched for: a JSON envelope is ~125 bytes on its
    // own, so a guessed bound smaller than that can never reach the content field.
    const first = Buffer.from(JSON.stringify({
      step_index: 800,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-08-15T10:10:23Z',
      content: '界面处理系统',
    }) + '\n', 'utf8');
    // First byte of the CJK run, then step one byte into it so the cut lands
    // between a lead byte and its continuations.
    const cjkStart = first.indexOf(Buffer.from('界', 'utf8'));
    const DRAIN = cjkStart + 1;
    check('the fixture cuts the drain boundary INSIDE a multibyte character',
      cjkStart > 0 && (first[DRAIN]! & 0xc0) === 0x80 && DRAIN < first.length,
      `drain=${DRAIN}, byte=0x${first[DRAIN]!.toString(16)}`);

    const traces: AgyTrace[] = [];
    const connection = new OffsetSpy({
      roots: tree.roots,
      conversationId: CONVERSATION,
      info: infoFor(CONVERSATION),
      trace: (trace) => traces.push(trace),
      tailReadMaxBytes: DRAIN,
    });
    connection.subscribe(() => {});
    await connection.getHistory();
    const baseline = statSync(tree.transcriptPath).size;
    const second = Buffer.from(jsonl([{
      step_index: 801,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-08-15T10:10:23Z',
      content: 'the line after the split',
    }]), 'utf8');
    appendFileSync(tree.transcriptPath, Buffer.concat([first, second]));

    check('both lines across the drain boundary are admitted',
      await waitUntil(() => connection.admitted.some((row) => row.index === 801)),
      JSON.stringify(connection.admitted.map((r) => r.index)));

    const split = connection.admitted.find((row) => row.index === 800);
    check('(1) the split multibyte line decodes INTACT — no replacement characters',
      split !== undefined && split.content === '界面处理系统' && !split.content.includes('�'),
      JSON.stringify(split?.content));

    // (2) The following step's offset must be the ORIGINAL file offset. Under the
    // old decode-per-range this drifted by the re-encoding of the U+FFFDs.
    const next = connection.admitted.find((row) => row.index === 801);
    check('(2) the FOLLOWING step carries its true file byte offset',
      next?.offset === baseline + first.length,
      `${next?.offset} vs expected ${baseline + first.length}`);
    check('the split line itself starts at the true offset too',
      split?.offset === baseline, `${split?.offset} vs ${baseline}`);
    check('no drain reported a dropped or truncated frame',
      !traces.some((t) => t.op === 'transcript-line-oversized' || t.op === 'transcript-line-resync'),
      traces.map((t) => t.op).join(','));

    await connection.close();
  } finally {
    tree.cleanup();
  }
}

{
  // The injected bound above is only trustworthy if the DEFAULT is what ships.
  const tree = buildAgyFixtureTree({ transcriptSteps: 1 });
  try {
    const connection = new AgyObserveConnection({
      roots: tree.roots,
      conversationId: CONVERSATION,
      info: infoFor(CONVERSATION),
      trace: () => {},
    });
    check('the production drain bound is what a default connection uses',
      connection.tailReadMaxBytes === AGY_TAIL_READ_MAX_BYTES,
      `${connection.tailReadMaxBytes} vs ${AGY_TAIL_READ_MAX_BYTES}`);
    await connection.close();
  } finally {
    tree.cleanup();
  }
}

// ── The background-task ledger reaches history (P2c) ───────────────────────
//
// The panel is built from two sources that live in different files: the
// conversation's own `manage_task` calls, and the settlements in its inbox. Only
// the settlement proves an ending, so the fold has to read the inbox FIRST — and
// a second `getHistory()` has to produce the same rows, not doubled ones.
{
  const tree = buildAgyFixtureTree({ withSettlementTaxonomy: true, withTaskLog: true });
  try {
    const connection = new AgyObserveConnection({
      roots: tree.roots,
      conversationId: CONVERSATION,
      info: infoFor(CONVERSATION),
    });
    const history = await connection.getHistory();
    const panels = history.filter((message) => message.type === 'task-list-state') as Array<{
      key: string;
      status: string;
      items: Array<{ id?: string; status: string; title: string }>;
    }>;
    check('history carries exactly one background-task panel', panels.length === 1, String(panels.length));
    const items = new Map(panels[0]!.items.map((item) => [item.id!, item]));
    check('the settled task reports the outcome the settlement recorded',
      items.get('task-7')?.status === 'done', JSON.stringify(items.get('task-7')));
    check('a task the host said it CANCELED reports cancelled, not done',
      items.get('task-9')?.status === 'cancelled', JSON.stringify(items.get('task-9')));

    // The taxonomy, end to end: five settlements are in the inbox and only the
    // two task ones may become ledger entries.
    check('the subagent, `system` and senderless settlements produce no ledger entries',
      panels[0]!.items.length === 2, JSON.stringify(panels[0]!.items.map((item) => item.id)));
    // Rendering follows the taxonomy (round-2b review finding 4): a tool block
    // is a record of WORK — the two tasks and the subagent — while `system` and
    // senderless settlements name no task and no conversation, so a tool block
    // for one would invent a background task that never existed.
    const settlementBlocks = history.filter((message) => message.type === 'tool-result'
      && String((message as { callId: string }).callId).includes(':task:'));
    check('the two task settlements and the subagent settlement render as durable tool blocks',
      settlementBlocks.length === 3,
      JSON.stringify(settlementBlocks.map((message) => (message as { callId: string }).callId)));
    check('no tool block was invented for the `system` settlement',
      !settlementBlocks.some((message) =>
        String((message as { callId: string }).callId).endsWith(':task:system')),
      JSON.stringify(settlementBlocks.map((message) => (message as { callId: string }).callId)));
    const notices = history.filter((message) => message.type === 'notice') as Array<{ message: string }>;
    check('the `system` settlement renders as a notice carrying the host\'s own words',
      notices.some((notice) => notice.message.includes('All your subagents have been stopped')),
      JSON.stringify(notices.map((notice) => notice.message)));
    check('the senderless settlement is stated as a notice, never silently dropped',
      notices.some((notice) => notice.message.includes('A notice with no sender')),
      JSON.stringify(notices.map((notice) => notice.message)));

    // The settled task's captured output rides its tool-result, read lazily —
    // at attach, not at discovery — through the safe-read caps.
    const withBody = history.filter((message) => message.type === 'tool-result'
      && typeof (message as { result: unknown }).result === 'object') as Array<{ result: { log: string } }>;
    check('exactly the task WITH a log on disk carries a log body', withBody.length === 1, String(withBody.length));
    check('the body is the log file\'s own bytes, CRLF and all',
      withBody[0]!.result.log.includes('Step 2 of 2 complete.\r\n'),
      JSON.stringify(withBody[0]!.result.log).slice(0, 80));

    const again = await connection.getHistory();
    check('a second replay produces the same panel, not a second one',
      again.filter((message) => message.type === 'task-list-state').length === 1);
    check('a second replay does not double the ledger\'s entries',
      JSON.stringify((again.find((message) => message.type === 'task-list-state') as { items: unknown[] }).items)
        === JSON.stringify(panels[0]!.items));
    await connection.close();
  } finally {
    tree.cleanup();
  }
}

// ── A conversation with no tasks gets no panel ─────────────────────────────
{
  const tree = buildAgyFixtureTree({ transcriptSteps: 3, withoutSettlement: true });
  try {
    const connection = new AgyObserveConnection({
      roots: tree.roots,
      conversationId: CONVERSATION,
      info: infoFor(CONVERSATION),
    });
    const history = await connection.getHistory();
    check('no `manage_task` call and no settlement means no panel at all',
      !history.some((message) => message.type === 'task-list-state'));
    await connection.close();
  } finally {
    tree.cleanup();
  }
}

// ── A task log past the cap is stated, never silently short ────────────────
{
  const tree = buildAgyFixtureTree({ withTaskLog: true });
  try {
    const tasks = join(tree.roots.appData, 'brain', CONVERSATION, '.system_generated', 'tasks');
    // One byte past the ceiling, so the reader must stop and say it did.
    writeFileSync(join(tasks, 'task-7.log'), 'x'.repeat(AGY_TASK_LOG_MAX_BYTES + 1));
    const traces: AgyTrace[] = [];
    const connection = new AgyObserveConnection({
      roots: tree.roots,
      conversationId: CONVERSATION,
      info: infoFor(CONVERSATION),
      trace: (trace) => traces.push(trace),
    });
    const history = await connection.getHistory();
    const row = history.find((message) => message.type === 'tool-result'
      && typeof (message as { result: unknown }).result === 'object') as { truncated?: boolean };
    check('an oversized task log is delivered truncated AND flagged', row?.truncated === true, JSON.stringify(row));
    check('the truncation is traced, so a silent short read is impossible',
      traces.some((trace) => trace.op === 'task-log-oversized'),
      traces.map((trace) => trace.op).join(','));
    await connection.close();
  } finally {
    tree.cleanup();
  }
}

// ── The pickers are available on OBSERVE (P2a/P2b) ─────────────────────────
//
// Listing is a read. An observe connection that answered nothing would render an
// EMPTY picker, which reads as "no models" rather than "not available here" —
// reflection §2. Choosing one is still refused, because that is the mutation.
{
  const tree = buildAgyFixtureTree();
  try {
    const connection = new AgyObserveConnection({
      roots: tree.roots,
      conversationId: CONVERSATION,
      info: infoFor(CONVERSATION),
    });
    const models = await connection.listModels();
    check('an observe connection lists models rather than an empty picker', models.length > 0, String(models.length));
    check('the observe list carries the same effort grouping the adapter publishes',
      models.some((model) => (model.reasoningEfforts?.length ?? 0) >= 2),
      models.map((model) => `${model.label}:${model.reasoningEfforts?.length ?? 0}`).join(' | '));
    const modes = await connection.listModes();
    check('an observe connection lists the three modes',
      JSON.stringify(modes) === JSON.stringify(AGY_MODES), modes.map((mode) => mode.value).join(','));

    let refused = false;
    try {
      await connection.sendPrompt({ text: 'hello' });
    } catch {
      refused = true;
    }
    check('listing a model does not make an observe connection writable', refused);
    await connection.close();
  } finally {
    tree.cleanup();
  }
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
