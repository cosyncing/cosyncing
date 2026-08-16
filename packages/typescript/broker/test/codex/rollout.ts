/**
 * Headless regression for the Codex adapter's OBSERVE mapping (rollout JSONL → canonical messages).
 *
 * Two halves, both zero-cost (no `codex`, no daemon, no model):
 *   1. Synthetic: a hand-built rollout exercising the DOUBLE-FREE rule — the same content appears as
 *      both an event_msg and a response_item, and the mapper must emit each exactly once (text/
 *      reasoning/user from event_msg; tool calls/results from response_item; patch/exec detail folded
 *      onto the matching tool-result by call_id, never as a second bubble).
 *   2. Real-data smoke: discover the machine's actual Codex sessions and getHistory() the newest one,
 *      asserting it parses without throwing and yields only valid canonical message types. Read-only;
 *      prints counts/types, never message content.
 *
 *   bun run packages/typescript/broker/test/codex/rollout.ts     (exit 0 = all pass)
 */
export {};
import { strict as assert } from 'node:assert';
import { appendFileSync, chmodSync, closeSync, existsSync, ftruncateSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedBrokerFixtureEnvironment } from '../helpers/isolated-broker-fixture.ts';
import { historySourceStillContainsSnapshot } from '../../src/sessions/history-page-cache.ts';
import type { AgentMessage, HistorySnapshotSink } from '../../../adapter-api/src/index.ts';
import { CANONICAL_MESSAGE_TYPES, isHistorySnapshotRefusal, isOwnershipConflictError } from '../../../adapter-api/src/index.ts';

/** The broker side of a capture, with an optional budget so a refusal can be provoked. */
class CollectingSink implements HistorySnapshotSink {
  readonly messages: AgentMessage[] = [];
  constructor(private readonly limit = Number.POSITIVE_INFINITY) {}
  accept(message: AgentMessage): boolean {
    if (this.messages.length >= this.limit) return false;
    this.messages.push(message);
    return true;
  }
}

/** One capture into a fresh unbounded sink. */
async function capture(conn: any): Promise<{ sink: CollectingSink; outcome: unknown }> {
  const sink = new CollectingSink();
  return { sink, outcome: await conn.captureHistorySnapshot?.(sink) };
}
import { CodexAdapter, captureFileHistoryInto, codexAttachMode, inferRolloutStatus, inferRolloutStatusResult, codexSessionOrigin, mapRollout } from '../../../adapters/codex/src/index.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
// Mirrors codexLiveSyncEnabled(): sync is ON BY DEFAULT (issues-part2) — an unset env means enabled;
// only an explicit falsy value disables it.
const syncEnv = (process.env.COSYNCING_CODEX_SYNC_SERVER ?? process.env.COSYNCING_CODEX_LIVE ?? '').trim();
const syncServerEnabled = syncEnv === '' ? true : /^(1|true|yes|on)$/i.test(syncEnv);
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ── 1. synthetic double-free mapping ────────────────────────────────────────────
{
  const lines = [
    { type: 'session_meta', payload: { cwd: '/tmp/x', id: 'abc' } },
    { timestamp: '2026-06-18T10:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'hello' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } }, // must SKIP
    { timestamp: '2026-06-18T10:00:02.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
    { type: 'event_msg', payload: { type: 'agent_reasoning', content: 'thinking through it' } },
    { type: 'response_item', payload: { type: 'reasoning', summary: [] } }, // must SKIP
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: '{"command":"ls"}' } },
    { type: 'event_msg', payload: { type: 'exec_command_end', call_id: 'c1', exit_code: 2, duration: { secs: 1, nanos: 250_000_000 } } }, // enrich only
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'boom' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'apply_patch', call_id: 'c2', arguments: '{}' } },
    { type: 'event_msg', payload: { type: 'patch_apply_end', call_id: 'c2', success: true, changes: { '/tmp/x/a.ts': { type: 'add', content: 'l1\nl2' } } } }, // enrich only
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c2', output: 'ok' } },
    { timestamp: '2026-06-18T10:00:08.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Done.', phase: 'final_answer' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } }, // must SKIP
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 2 } } } },
    { timestamp: '2026-06-18T10:00:10.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } },
  ];
  const out = mapRollout(lines);
  const of = (t: string) => out.filter((m) => m.type === t);

  // 13 emitted: user, status(running/idle), run-summary(running/done), thinking, tool-call×2,
  // tool-result×2, model-output, token-count, metadata-update/runtimeTotals.
  // The 2 response_item/message + 1 response_item/reasoning are dropped → no doubles.
  check('double-free plus runtime: exactly 13 messages (no event_msg/response_item duplication)', out.length === 13, `got ${out.length}`);
  check(
    'user-message once with native sentAt',
    of('user-message').length === 1 && (of('user-message')[0] as any).text === 'hello' && (of('user-message')[0] as any).sentAt === Date.parse('2026-06-18T10:00:00.000Z'),
    JSON.stringify(of('user-message')),
  );
  check('thinking once (not doubled by response_item/reasoning)', of('thinking').length === 1, `count=${of('thinking').length}`);
  check('model-output once (not doubled by response_item/message)', of('model-output').length === 1 && (of('model-output')[0] as any).text === 'Done.', `count=${of('model-output').length}`);
  check('tool-call×2 with names', of('tool-call').length === 2 && (of('tool-call')[0] as any).toolName === 'exec_command' && (of('tool-call')[1] as any).toolName === 'apply_patch', JSON.stringify(of('tool-call').map((m: any) => m.toolName)));
  check('tool-call display classes are adapter-owned (execute/edit)', (of('tool-call')[0] as any).toolClass === 'execute' && (of('tool-call')[1] as any).toolClass === 'edit', JSON.stringify(of('tool-call')));

  const tr = of('tool-result') as any[];
  const c1 = tr.find((m) => m.callId === 'c1');
  const c2 = tr.find((m) => m.callId === 'c2');
  check('tool-result c1 enriched from exec_command_end (exitCode 2, isError, name)', !!c1 && c1.exitCode === 2 && c1.isError === true && c1.toolName === 'exec_command', JSON.stringify(c1));
  check('tool-result c1 carries native duration + execute class', c1?.durationMs === 1250 && c1?.toolClass === 'execute', JSON.stringify(c1));
  check('tool-result c2 enriched from patch_apply_end (create title + synthesized additions from content, not errored)', !!c2 && c2.path === '/tmp/x/a.ts' && c2.title === 'Created a.ts' && c2.additions === 2 && c2.deletions === 0 && c2.isError === false && c2.toolName === 'apply_patch', JSON.stringify(c2));
  check('status running then idle', of('status').length === 2 && (of('status')[0] as any).status === 'running' && (of('status')[1] as any).status === 'idle', JSON.stringify(of('status').map((m: any) => m.status)));
  check('token-count mapped', of('token-count').length === 1 && (of('token-count')[0] as any).input === 10 && (of('token-count')[0] as any).output === 5, JSON.stringify(of('token-count')));
  const runs = of('run-summary') as any[];
  check(
    'run-summary upserts by turn id and maps native rollout runtime',
    runs.length === 2 &&
      runs[0].key === 'codex:run:t1' &&
      runs[1].key === 'codex:run:t1' &&
      runs[0].status === 'running' &&
      runs[1].status === 'done' &&
      runs[1].startedAt === Date.parse('2026-06-18T10:00:02.000Z') &&
      runs[1].completedAt === Date.parse('2026-06-18T10:00:10.000Z') &&
      runs[1].totalRuntimeMs === 8000 &&
      runs[1].userMessageKey === 'c1' &&
      runs[1].assistantMessageKey === 'c12',
    JSON.stringify(runs),
  );
  const totals = of('metadata-update').find((m: any) => m.key === 'runtimeTotals') as any;
  check('runtimeTotals metadata maps completed Codex rollout runtime', totals?.value?.totalRuntimeMs === 8000 && totals?.value?.turnCount === 1, JSON.stringify(totals));

  // Content keys are the line index → unique and stable for history/live dedupe. run-summary keys are
  // intentionally reused so running→done updates the same runtime pill.
  const lineKeyed = out.filter((m: any) => /^c\d+$/.test(m.key || ''));
  const uniqueLineKeys = new Set(lineKeyed.map((m: any) => m.key));
  check('every line-keyed content message has a unique line-index key', lineKeyed.length > 0 && uniqueLineKeys.size === lineKeyed.length, `${uniqueLineKeys.size}/${lineKeyed.length}`);

  // every emitted type is a real canonical type (would-break-render-gate guard)
  const bad = out.map((m) => m.type).filter((t) => !(CANONICAL_MESSAGE_TYPES as readonly string[]).includes(t));
  check('all emitted types are canonical', bad.length === 0, bad.join(',') || 'ok');
}
// ── H1b: history messages and their identity come from ONE captured rollout prefix ─────────────
// The broker used to read `getHistory()` and `getHistorySourceIdentity()` separately and then pair
// them. A Codex rollout appends WHILE it is being indexed, so that pairing failed routinely and the
// broker could not tell it apart from a rewrite: it answered `HISTORY_PAGE_RESOURCE_LIMIT` and
// stamped the socket permanently unpageable. A captured prefix removes the ambiguity — later bytes
// simply are not in the snapshot — while a rewrite still fails closed.
{
  const dir = mkdtempSync(join(tmpdir(), 'cosyncing-h1b-'));
  const path = join(dir, 'rollout-h1b.jsonl');
  const line = (index: number) =>
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: `row ${index}` } });
  try {
    writeFileSync(path, `${Array.from({ length: 40 }, (_, i) => line(i)).join('\n')}\n`);
    const adapter = new CodexAdapter();
    const conn: any = await adapter.attach(Buffer.from(path, 'utf8').toString('base64url'), 'observe');
    try {
      const captured = await capture(conn);
      check(
        'a Codex connection can capture a history prefix',
        Boolean((captured.outcome as any)?.identity) && captured.sink.messages.length === 40,
        `${typeof captured.outcome} messages=${captured.sink.messages.length}`,
      );
      const identity = (captured.outcome as any).identity;
      const capturedBytes = statSync(path).size;
      check(
        'the captured identity describes exactly the bytes the messages came from',
        identity.appendPosition === capturedBytes && captured.sink.messages.length === 40,
        `appendPosition=${identity.appendPosition} bytes=${capturedBytes} messages=${captured.sink.messages.length}`,
      );

      // An ordinary append: the agent is still working.
      appendFileSync(path, `${line(40)}\n${line(41)}\n`);
      const afterAppend = conn.getHistorySourceIdentity!();
      check(
        'an append leaves the captured prefix usable (paging keeps working)',
        historySourceStillContainsSnapshot(identity, afterAppend!),
        `${JSON.stringify(identity)} vs ${JSON.stringify(afterAppend)}`,
      );
      const grown = await capture(conn);
      check(
        'a later capture sees the appended rows and is itself append-compatible',
        grown.sink.messages.length === 42
          && historySourceStillContainsSnapshot(identity, (grown.outcome as any).identity),
        `messages=${grown.sink.messages.length}`,
      );

      // The streamed capture is the SAME mapping as the whole-file one. Two chunked passes with a
      // one-record lookahead replaced "parse every line into an array, then map the array", so this
      // is what proves enrichment and next-line pairing survived the change.
      const wholeFile = mapRollout(
        readFileSync(path, 'utf8').split('\n').filter((raw) => raw !== '').map((raw) => JSON.parse(raw)),
      );
      check(
        'the streamed capture equals the whole-file mapping, message for message',
        JSON.stringify(grown.sink.messages) === JSON.stringify(wholeFile),
        `streamed=${grown.sink.messages.length} whole=${wholeFile.length}`,
      );

      // The receiver's budget stops the READ, not just what is retained. A sink that refuses at
      // message 5 must end the capture there with a typed refusal.
      const bounded = new CollectingSink(5);
      const refusedBySink = await conn.captureHistorySnapshot?.(bounded);
      check(
        'a sink that runs out of budget ends the capture with a typed refusal',
        isHistorySnapshotRefusal(refusedBySink) && bounded.messages.length === 5,
        `${JSON.stringify(refusedBySink)} accepted=${bounded.messages.length}`,
      );

      // A prefix rewrite (compaction/revert) must NOT be mistaken for an append.
      writeFileSync(path, `${Array.from({ length: 5 }, (_, i) => line(1000 + i)).join('\n')}\n`);
      const afterRewrite = conn.getHistorySourceIdentity!();
      check(
        'a rewritten prefix fails closed instead of masquerading as an append',
        !historySourceStillContainsSnapshot(identity, afterRewrite!),
        `${JSON.stringify(afterRewrite)}`,
      );

      // A source past the capture ceiling is refused with a TYPED answer, before any read. It used
      // to be allocated whole — one `Buffer.alloc(size)`, one string, one `split` — and an
      // allocation failure there was reported as "the source changed", which the client retries
      // forever against bytes that will never fit.
      const huge = join(dir, 'rollout-huge.jsonl');
      const hugeFd = openSync(huge, 'w');
      try {
        // Sparse: 256 MiB + 1 of apparent size, ~0 bytes on disk.
        ftruncateSync(hugeFd, 256 * 1024 * 1024 + 1);
      } finally {
        closeSync(hugeFd);
      }
      const attachRssBefore = process.memoryUsage().rss;
      const attachStartedAt = performance.now();
      const hugeConn: any = await adapter.attach(
        Buffer.from(huge, 'utf8').toString('base64url'),
        'observe',
      );
      const attachElapsedMs = performance.now() - attachStartedAt;
      const attachRssGrowth = Math.max(
        0,
        process.memoryUsage().rss - attachRssBefore,
      );
      try {
        const startedAt = performance.now();
        const refused = await hugeConn.captureHistorySnapshot?.(new CollectingSink());
        const elapsedMs = performance.now() - startedAt;
        check(
          'a source past the capture ceiling is refused as a resource limit, not a source change',
          isHistorySnapshotRefusal(refused) && refused.refusal === 'resource-limit',
          JSON.stringify(refused),
        );
        check(
          'the refusal is decided from the stat, without reading the source',
          elapsedMs < 250,
          `${elapsedMs.toFixed(1)}ms`,
        );
        check(
          'observe attach does not materialize a source before the capture ceiling can refuse it',
          attachElapsedMs < 250 && attachRssGrowth < 64 * 1024 * 1024,
          `attach=${attachElapsedMs.toFixed(1)}ms rssGrowth=${attachRssGrowth}`,
        );
      } finally {
        await hugeConn.close().catch(() => {});
        rmSync(huge, { force: true });
      }
    } finally {
      await conn.close().catch(() => {});
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── H1b hardening: the two-pass capture is digest-verified and bounded BEFORE the sink ─────────
// An open descriptor does not freeze file contents: the enrichment pass and the mapping pass can
// observe different same-size data, and byte-count equality alone would pair one revision's
// enrichment with another's messages under the original identity. And before this round, `held`
// could grow to the whole source on a newline-less record, and enrichment retained unbounded
// entries and diff bodies before the first message ever reached the sink.
{
  const dir = mkdtempSync(join(tmpdir(), 'cosyncing-h1b-hardening-'));
  const line = (index: number) =>
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: `row ${index}` } });
  try {
    // 1. A SAME-SIZE rewrite between the passes is detected by content, not length. The flip is in
    //    the last row, far beyond the identity prefix, so only the pass digests can see it.
    const racy = join(dir, 'rollout-racy.jsonl');
    const original = `${Array.from({ length: 40 }, (_, i) => line(i)).join('\n')}\n`;
    const rewritten = original.replace('row 39', 'row XX');
    assert.equal(original.length, rewritten.length, 'the rewrite must preserve the byte length');
    writeFileSync(racy, original);
    const racySink = new CollectingSink();
    const raced = await captureFileHistoryInto(racy, racySink, undefined, {
      betweenPasses: () => writeFileSync(racy, rewritten),
    });
    check(
      'a same-size rewrite between the passes yields no identity and no refusal (retriable)',
      raced === undefined,
      JSON.stringify(raced) ?? 'undefined',
    );
    const settledSink = new CollectingSink();
    const settled = await captureFileHistoryInto(racy, settledSink);
    check(
      'the very next capture of the settled content succeeds',
      Boolean((settled as any)?.identity) && settledSink.messages.length === 40,
      `messages=${settledSink.messages.length}`,
    );

    // 1b. A same-size rewrite BEFORE the first pass leaves both passes agreeing on the
    //     rewritten bytes, so no digest can see it — only the metadata revision moving at an
    //     unchanged size can. The original is backdated so the rewrite's fresh mtime differs
    //     deterministically, whatever the filesystem's timestamp granularity.
    const early = join(dir, 'rollout-early-rewrite.jsonl');
    writeFileSync(early, original);
    const backdated = new Date(Date.now() - 10_000);
    utimesSync(early, backdated, backdated);
    const earlySink = new CollectingSink();
    const earlyRaced = await captureFileHistoryInto(early, earlySink, undefined, {
      beforeFirstPass: () => writeFileSync(early, rewritten),
    });
    check(
      'a same-size rewrite before the first pass is retried on its metadata revision',
      earlyRaced === undefined,
      JSON.stringify(earlyRaced) ?? 'undefined',
    );
    const earlySettledSink = new CollectingSink();
    const earlySettled = await captureFileHistoryInto(early, earlySettledSink);
    check(
      'the next capture of the early-rewritten content succeeds with the rewritten row',
      Boolean((earlySettled as any)?.identity)
        && earlySettledSink.messages.length === 40
        && JSON.stringify(earlySettledSink.messages).includes('row XX'),
      `messages=${earlySettledSink.messages.length}`,
    );
    rmSync(early, { force: true });

    // 2. One record larger than the paging-cache entry budget is refused as a typed resource
    //    limit — it can never produce a servable snapshot, and it used to accumulate whole in
    //    `held` because it has no newline.
    const oversized = join(dir, 'rollout-oversized-line.jsonl');
    writeFileSync(
      oversized,
      `${line(0)}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'x'.repeat(33 * 1024 * 1024) } })}\n`,
    );
    const oversizedSink = new CollectingSink();
    check(
      'a single oversized record is refused as a resource limit, not accumulated',
      isHistorySnapshotRefusal(await captureFileHistoryInto(oversized, oversizedSink)),
      'expected typed refusal',
    );
    rmSync(oversized, { force: true });

    // 3. More unique enrichment records than the message budget could ever serve are refused in
    //    the PRE-pass — proven with a sink that accepts only one message, so the sink's own budget
    //    cannot be what stopped it.
    const manyCalls = join(dir, 'rollout-many-calls.jsonl');
    const callLine = (index: number) =>
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: `call-${index}`, name: 'exec' } });
    writeFileSync(manyCalls, `${Array.from({ length: 50_001 }, (_, i) => callLine(i)).join('\n')}\n`);
    const oneMessageSink = new CollectingSink(1);
    check(
      'enrichment entries beyond the message budget refuse before the sink is even consulted',
      isHistorySnapshotRefusal(await captureFileHistoryInto(manyCalls, oneMessageSink))
        && oneMessageSink.messages.length === 0,
      `accepted=${oneMessageSink.messages.length}`,
    );
    rmSync(manyCalls, { force: true });

    // 4. Retained enrichment BYTES are bounded too: a few records carrying huge patch bodies are
    //    refused even though the entry count is tiny.
    const bigPatches = join(dir, 'rollout-big-patches.jsonl');
    const patchBody = `*** Update File: big.txt\n${`+${'a'.repeat(80)}\n`.repeat(13_000)}`;
    const patchLine = (index: number) =>
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: `patch-${index}`, name: 'apply_patch', input: patchBody } });
    writeFileSync(bigPatches, `${Array.from({ length: 40 }, (_, i) => patchLine(i)).join('\n')}\n`);
    const patchSink = new CollectingSink(1);
    check(
      'retained enrichment bytes beyond the entry budget refuse in the pre-pass',
      isHistorySnapshotRefusal(await captureFileHistoryInto(bigPatches, patchSink))
        && patchSink.messages.length === 0,
      `accepted=${patchSink.messages.length}`,
    );
    rmSync(bigPatches, { force: true });

    // 5. The ceilings are UTF-8 BYTES, not UTF-16 code units. '嗨' is one code unit but three
    //    bytes: 11.5M of them are ~34.5 MB — over the 32 MiB byte budget while far under a 32M
    //    code-unit count, which would have admitted ~96 MiB of source as a "32 MiB" record.
    const wideRecord = join(dir, 'rollout-wide-record.jsonl');
    writeFileSync(
      wideRecord,
      `${line(0)}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: '嗨'.repeat(11_500_000) } })}\n`,
    );
    const wideSink = new CollectingSink();
    check(
      'a record under the code-unit count but over the byte budget is refused',
      isHistorySnapshotRefusal(await captureFileHistoryInto(wideRecord, wideSink)),
      'expected typed refusal',
    );
    rmSync(wideRecord, { force: true });

    // 6. Retained enrichment is measured in UTF-8 bytes too: 12 CJK patch bodies are only ~12M
    //    code units, but ~36 MB retained.
    const widePatches = join(dir, 'rollout-wide-patches.jsonl');
    const wideBody = `*** Update File: wide.txt\n+${'嗨'.repeat(1_000_000)}\n`;
    writeFileSync(
      widePatches,
      `${Array.from({ length: 12 }, (_, i) =>
        JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: `wide-${i}`, name: 'apply_patch', input: wideBody } })).join('\n')}\n`,
    );
    const widePatchSink = new CollectingSink(1);
    check(
      'enrichment retention over the byte budget refuses even under the code-unit count',
      isHistorySnapshotRefusal(await captureFileHistoryInto(widePatches, widePatchSink))
        && widePatchSink.messages.length === 0,
      `accepted=${widePatchSink.messages.length}`,
    );
    rmSync(widePatches, { force: true });

    // 7. Byte-domain record splitting must still decode multibyte content that straddles the
    //    1 MiB chunk boundary from its exact byte range.
    const multibyte = join(dir, 'rollout-multibyte.jsonl');
    const wideMessage = `${'界'.repeat(700_000)}end`;
    writeFileSync(
      multibyte,
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: wideMessage } })}\n`,
    );
    const multibyteSink = new CollectingSink();
    const multibyteCaptured = await captureFileHistoryInto(multibyte, multibyteSink);
    const multibyteText = JSON.stringify(multibyteSink.messages);
    check(
      'a multibyte record spanning chunk reads decodes intact',
      Boolean((multibyteCaptured as any)?.identity)
        && multibyteText.includes('界界界')
        && multibyteText.includes('界end'),
      `messages=${multibyteSink.messages.length}`,
    );
    rmSync(multibyte, { force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── CR4b: one logical PROMPT, one identity across live delivery and saved history ─────────────
// Measured on a real 21k-line rollout: `event_msg/user_message` carries no `turn_id` and no `id`,
// and the `response_item/message` with `role: 'user'` beside it carries no `id` either. The prompt's
// only rebuildable identity is therefore `(turnId, ordinal)` — the turn is already open when the
// prompt line is written (`turn_context`/`task_started` precede it), and the app-server reports the
// same `turnId` on `item/started`. Same real rollout: `task_started` is written BEFORE the prompt,
// so binding a run summary to "the last user message seen" named the PREVIOUS turn's prompt.
{
  const turn = (turnId: string, prompt: string, answerId: string, answer: string) => [
    { type: 'turn_context', payload: { turn_id: turnId } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
    { type: 'event_msg', payload: { type: 'user_message', message: prompt } },
    { type: 'event_msg', payload: { type: 'agent_message', message: answer, phase: 'final_answer' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', id: answerId, phase: 'final_answer', content: [{ type: 'output_text', text: answer }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } },
  ];

  {
    const out = mapRollout([...turn('t1', 'first prompt', 'msg_a', 'first answer')]);
    const prompt = out.find((m) => m.type === 'user-message') as any;
    check(
      'a replayed prompt rebuilds the canonical (turn, ordinal) identity the app-server also emits',
      prompt?.key === 'codex:t1:u0' && prompt.turnId === 't1',
      JSON.stringify(prompt),
    );
    const done = out.filter((m) => m.type === 'run-summary').find((m: any) => m.status === 'done') as any;
    check(
      'the terminal run summary names its OWN prompt, not the previous turn\'s',
      done?.userMessageKey === 'codex:t1:u0' && done.assistantMessageKey === 'codex:t1:msg_a:t',
      JSON.stringify(done),
    );
  }

  {
    // One turn steered far past the per-turn bookkeeping bound. The record is O(1) per turn now
    // (opening key + counter), so this must stay correct AND not depend on retaining every key:
    // every steer keeps its own ordinal, and the summary still names the prompt that opened it.
    const steers = 500;
    const long = [
      { type: 'turn_context', payload: { turn_id: 'tl' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'tl' } },
      ...Array.from({ length: steers }, (_, index) => ({
        type: 'event_msg',
        payload: { type: 'user_message', message: `steer ${index}` },
      })),
      { type: 'event_msg', payload: { type: 'agent_message', message: 'answer', phase: 'final_answer' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'msg_l', phase: 'final_answer', content: [{ type: 'output_text', text: 'answer' }] } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'tl' } },
    ];
    const out = mapRollout(long);
    const keys = out.filter((m) => m.type === 'user-message').map((m: any) => m.key);
    const done = out.find((m: any) => m.type === 'run-summary' && m.status === 'done') as any;
    check(
      'a heavily steered turn keeps one distinct identity per prompt',
      keys.length === steers && new Set(keys).size === steers && keys[0] === 'codex:tl:u0' && keys.at(-1) === `codex:tl:u${steers - 1}`,
      `emitted=${keys.length} distinct=${new Set(keys).size} first=${keys[0]} last=${keys.at(-1)}`,
    );
    check(
      'a heavily steered turn is still owned by the prompt that opened it',
      done?.userMessageKey === 'codex:tl:u0',
      JSON.stringify(done?.userMessageKey),
    );
  }

  {
    // Two turns, and a `task_started` that precedes each prompt — the ordering that produced the
    // off-by-one. Turn 2's summary must not claim turn 1's prompt.
    const out = mapRollout([
      ...turn('t1', 'first prompt', 'msg_a', 'first answer'),
      ...turn('t2', 'second prompt', 'msg_b', 'second answer'),
    ]);
    const summaries = out.filter((m: any) => m.type === 'run-summary' && m.status === 'done') as any[];
    check(
      'consecutive turns each own their own prompt',
      summaries.length === 2 &&
        summaries[0].userMessageKey === 'codex:t1:u0' &&
        summaries[1].userMessageKey === 'codex:t2:u0',
      JSON.stringify(summaries.map((s) => [s.turnId, s.userMessageKey])),
    );
  }

  {
    // Identity is structural, never textual: the same bytes sent twice stay two prompts.
    const out = mapRollout([
      ...turn('t1', 'same text', 'msg_a', 'a'),
      ...turn('t2', 'same text', 'msg_b', 'b'),
    ]);
    const prompts = out.filter((m: any) => m.type === 'user-message') as any[];
    check(
      'two byte-identical prompts remain two distinct messages',
      prompts.length === 2 && prompts[0].key !== prompts[1].key && prompts[0].text === prompts[1].text,
      JSON.stringify(prompts.map((p) => p.key)),
    );
  }

  {
    // A mid-turn steer is a second prompt INSIDE one turn: distinct ordinal, and the run summary
    // still points at the prompt that opened the turn.
    const out = mapRollout([
      { type: 'turn_context', payload: { turn_id: 't1' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'opening prompt' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'mid-turn steer' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'ok', phase: 'final_answer' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'msg_a', phase: 'final_answer', content: [{ type: 'output_text', text: 'ok' }] } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } },
    ]);
    const prompts = out.filter((m: any) => m.type === 'user-message') as any[];
    const done = out.find((m: any) => m.type === 'run-summary' && m.status === 'done') as any;
    check(
      'a mid-turn steer gets its own ordinal inside the same turn',
      prompts.length === 2 && prompts[0].key === 'codex:t1:u0' && prompts[1].key === 'codex:t1:u1',
      JSON.stringify(prompts.map((p) => p.key)),
    );
    check(
      'the turn summary still opens on the prompt that started the turn',
      done?.userMessageKey === 'codex:t1:u0',
      JSON.stringify(done),
    );
  }

  {
    // Fail closed: a turn-less head keeps the line-index fallback rather than inventing a turn.
    const out = mapRollout([
      { type: 'event_msg', payload: { type: 'user_message', message: 'orphan prompt' } },
    ]);
    const prompt = out.find((m: any) => m.type === 'user-message') as any;
    check(
      'a prompt with no open turn falls back to its line index instead of guessing',
      prompt?.key === 'c0' && prompt.turnId === undefined,
      JSON.stringify(prompt),
    );
  }
}

// ── CR4: one logical answer, one identity across live delivery and saved history ──────────────
// The app-server delivers an assistant item as `codex:<turnId>:<itemId>:t`. The rollout persists the
// same item as an `event_msg/agent_message` followed by the `response_item/message` that carries the
// native id. Rebuilding that exact key from the rollout is what keeps a final which has already
// reached history — while the live accumulator still holds it — ONE message for a joining client.
// Verified against real data: the paired record is always the very next line, and for one traced
// session the key rebuilt here is byte-identical to the key its live app-server frames used.
{
  const assistantPair = (turn: string, id: string, text: string, phase = 'final_answer') => [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turn } },
    { type: 'event_msg', payload: { type: 'agent_message', message: text, phase } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', id, phase, content: [{ type: 'output_text', text }] } },
  ];
  const outputs = (lines: any[]) => mapRollout(lines).filter((m) => m.type === 'model-output') as any[];

  {
    const out = mapRollout([
      ...assistantPair('t1', 'msg_abc', 'Done.'),
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } },
    ]);
    const answer = out.find((m) => m.type === 'model-output') as any;
    check(
      'a paired assistant record adopts the identity the app-server also delivers',
      answer?.key === 'codex:t1:msg_abc:t' && answer.text === 'Done.' && answer.final === true,
      JSON.stringify(answer),
    );
    // The completed run points back at the answer it produced; that reference has to name the same
    // identity the client stored the answer under, or the runtime pill attaches to nothing.
    const completed = (out.filter((m) => m.type === 'run-summary') as any[]).at(-1);
    check(
      'the completed run summary points at that same assistant identity',
      completed?.assistantMessageKey === 'codex:t1:msg_abc:t',
      String(completed?.assistantMessageKey),
    );
  }

  {
    // Real rollouts leave ~1% of mid-turn commentary unpaired; it must stay visible on the fallback.
    const answer = outputs([
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'Unpaired.', phase: 'commentary' } },
      { type: 'event_msg', payload: { type: 'token_count', info: {} } },
    ])[0];
    check(
      'an unpaired assistant record keeps the line-index key and its text',
      answer?.key === 'c1' && answer.text === 'Unpaired.',
      JSON.stringify(answer),
    );
  }

  {
    const answer = outputs([
      { type: 'event_msg', payload: { type: 'agent_message', message: 'No turn here.' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'msg_abc', content: [{ type: 'output_text', text: 'No turn here.' }] } },
    ])[0];
    check(
      'a turn-less head falls back rather than inventing a turn for the key',
      answer?.key === 'c0' && answer.text === 'No turn here.',
      JSON.stringify(answer),
    );
  }

  {
    // Borrowing an id that belongs to different text would rename someone else's message.
    const answer = outputs([
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'One thing.' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'msg_abc', content: [{ type: 'output_text', text: 'Something else entirely.' }] } },
    ])[0];
    check(
      'a record whose text disagrees never lends its id',
      answer?.key === 'c1',
      JSON.stringify(answer),
    );
  }

  {
    // Older rollouts persist the pair without native ids — still exactly one readable message.
    const out = mapRollout([
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'Legacy.' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Legacy.' }] } },
    ]);
    const answers = out.filter((m) => m.type === 'model-output') as any[];
    check(
      'a legacy pair with no native id stays one readable message on the fallback key',
      answers.length === 1 && answers[0].key === 'c1' && answers[0].text === 'Legacy.',
      JSON.stringify(answers),
    );
  }

  {
    // Identity is never text: the same answer produced twice is two messages.
    const answers = outputs([
      ...assistantPair('t1', 'msg_first', 'Yes.'),
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } },
      ...assistantPair('t2', 'msg_second', 'Yes.'),
    ]);
    check(
      'byte-identical answers from two turns remain two messages',
      answers.length === 2 && answers[0].key === 'codex:t1:msg_first:t' && answers[1].key === 'codex:t2:msg_second:t',
      JSON.stringify(answers.map((m) => m.key)),
    );
  }

  {
    // A blank or unparseable segment holds an index but is not a record, so it answers nothing about
    // what followed the assistant line. Treating it as "no pair here" would key this answer `c1` while
    // the live app-server delivers it natively — the duplicate, from the other side.
    const answer = outputs([
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'Split.' } },
      null,
      { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'msg_abc', content: [{ type: 'output_text', text: 'Split.' }] } },
    ])[0];
    check(
      'a blank slot between the pair does not defeat adoption',
      answer?.key === 'codex:t1:msg_abc:t',
      JSON.stringify(answer),
    );
  }

  {
    // A REAL intervening record does block it: the pair is written together, so a record in between
    // means this response item belongs to something else and its id is not this answer's.
    const answer = outputs([
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'Split.' } },
      { type: 'event_msg', payload: { type: 'token_count', info: {} } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'msg_abc', content: [{ type: 'output_text', text: 'Split.' }] } },
    ])[0];
    check(
      'a non-adjacent record does not pair (the real format never separates them)',
      answer?.key === 'c1',
      JSON.stringify(answer),
    );
  }

  {
    // The turn the key names must be the turn that is RUNNING. A turn that already completed is not
    // one the app-server can still deliver items under, so a record landing after it belongs to no
    // turn and must fall back — borrowing the finished turn's id would mint an identity no live
    // frame ever used, which is the duplicate this lane removes, reintroduced from the other side.
    const answer = outputs([
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'Outside.' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'msg_outside', content: [{ type: 'output_text', text: 'Outside.' }] } },
    ])[0];
    check(
      'a paired record after the turn completed falls back rather than adopting the finished turn',
      answer?.key === 'c2' && answer.text === 'Outside.',
      JSON.stringify(answer),
    );
  }

  {
    // An abort ends the turn just as completion does.
    const answer = outputs([
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
      { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 't1', reason: 'interrupted' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'After abort.' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'msg_after', content: [{ type: 'output_text', text: 'After abort.' }] } },
    ])[0];
    check(
      'a paired record after an aborted turn falls back too',
      answer?.key === 'c2',
      JSON.stringify(answer),
    );
  }

  {
    // The other half of the same rule: inside a running turn the native key is still adopted, and a
    // NEW turn after a completed one keys its own answers, not the previous turn's.
    const answers = outputs([
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'Inside.' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'msg_inside', content: [{ type: 'output_text', text: 'Inside.' }] } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 't2' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'Next turn.' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'msg_next', content: [{ type: 'output_text', text: 'Next turn.' }] } },
    ]);
    check(
      'a paired record INSIDE an active turn still adopts the native key, per turn',
      answers.length === 2 && answers[0].key === 'codex:t1:msg_inside:t' && answers[1].key === 'codex:t2:msg_next:t',
      JSON.stringify(answers.map((m) => m.key)),
    );
  }

  {
    // turn_context is a turn opener: it declares the turn in effect (and never disagreed with the
    // enclosing task_started across 1,515 real samples), so an answer under it keys natively.
    const answer = outputs([
      { type: 'turn_context', payload: { turn_id: 't-ctx', approval_policy: 'never' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'Contextual.' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'msg_ctx', content: [{ type: 'output_text', text: 'Contextual.' }] } },
    ])[0];
    check(
      'turn_context opens a turn for identity purposes',
      answer?.key === 'codex:t-ctx:msg_ctx:t',
      JSON.stringify(answer),
    );
  }
}
{
  const out = mapRollout([{ type: 'event_msg', payload: { type: 'context_compacted' } }]);
  check('context_compacted → history-reset', out.length === 1 && out[0]!.type === 'history-reset', JSON.stringify(out));
}
{
  // A compaction makes the broker re-pull and re-push the whole transcript (hub.resync). Every answer
  // that survives it therefore crosses the wire a second time, and has to arrive under the identity
  // the client already stored — otherwise compaction itself duplicates the transcript it compacted.
  const lines = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Before.' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'msg_before', content: [{ type: 'output_text', text: 'Before.' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } },
    { type: 'event_msg', payload: { type: 'context_compacted' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 't2' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'After.' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'msg_after', content: [{ type: 'output_text', text: 'After.' }] } },
  ];
  const keysOf = () => (mapRollout(lines).filter((m) => m.type === 'model-output') as any[]).map((m) => m.key);
  const first = keysOf();
  check(
    'answers either side of a compaction keep their native identities, and the reset stays between them',
    JSON.stringify(first) === JSON.stringify(['codex:t1:msg_before:t', 'codex:t2:msg_after:t']) &&
      mapRollout(lines).findIndex((m) => m.type === 'history-reset') > 0,
    JSON.stringify(first),
  );
  check(
    'a post-compaction re-read reproduces them exactly (resync re-pushes the whole transcript)',
    JSON.stringify(keysOf()) === JSON.stringify(first),
    JSON.stringify(keysOf()),
  );
}
{
  // issues-part2: goal lifecycle from the ROLLOUT (observe/replay) — the TUI's "• Goal paused
  // Objective: …" line must reach the app, not only the live thread/goal/updated notification.
  const goal = { threadId: 't-goal', objective: 'resume the last goal • please resume the unfinished goal', status: 'paused', tokensUsed: 12971511, timeUsedSeconds: 69811, createdAt: 1783006625, updatedAt: 1783117677 };
  const out = mapRollout([{ type: 'event_msg', payload: { type: 'thread_goal_updated', threadId: 't-goal', goal } }]);
  const gs = out.find((m) => m.type === 'goal-state') as any;
  check('thread_goal_updated (rollout) → goal-state paused with objective + elapsed', !!gs && gs.status === 'paused' && gs.key === 't-goal' && /resume the last goal/.test(gs.title) && gs.elapsedMs === 69811 * 1000, JSON.stringify(gs));
  const done = mapRollout([{ type: 'event_msg', payload: { type: 'thread_goal_updated', goal: { ...goal, status: 'completed' } } }]).find((m) => m.type === 'goal-state') as any;
  check('rollout goal status "completed" maps to done', !!done && done.status === 'done', JSON.stringify(done));
}
{
  // issues-part2: an interrupted turn shows the TUI's "Conversation interrupted" marker, not silence.
  const out = mapRollout([
    { timestamp: '2026-06-26T22:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'ta' } },
    { timestamp: '2026-06-26T22:00:06.714Z', type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'ta', reason: 'interrupted', duration_ms: 2595 } },
  ]);
  const notice = out.find((m) => m.type === 'notice') as any;
  check(
    'turn_aborted(interrupted) → structured visible interruption notice',
    !!notice
      && /Conversation interrupted/.test(notice.message)
      && notice.semantic?.kind === 'interruption'
      && notice.semantic?.reason === 'generic'
      && notice.semantic?.turnId === 'ta',
    JSON.stringify(notice),
  );
}
{
  const automaticDenial =
    'exec_command failed for bun run test:broker-live-session-coherence: '
    + 'CreateProcess { message: "Rejected(\\"Automatic approval review denied. '
    + 'The workspace approval policy forbids granting escalated host execution.\\")" }';
  const out = mapRollout([
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'denied-turn' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'deny-1', arguments: '{}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'deny-1', output: automaticDenial } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'deny-2', arguments: '{}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'deny-2', output: automaticDenial } },
    { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'denied-turn', reason: 'interrupted' } },
  ]);
  const notice = out.find((m) => m.type === 'notice') as any;
  check(
    'repeated automatic approval denials explain the interruption',
    notice?.message === 'Conversation interrupted because automatic permission approval was denied repeatedly.'
      && notice.semantic?.kind === 'interruption'
      && notice.semantic?.reason === 'automatic-approval-denied-repeatedly'
      && notice.semantic?.turnId === 'denied-turn',
    JSON.stringify(notice),
  );
}
{
  const quotedAutomaticDenial =
    'exec_command failed for bun run test:broker-live-session-coherence: '
    + 'CreateProcess { message: "Rejected(\\"Automatic approval review denied. '
    + 'The workspace approval policy forbids granting escalated host execution.\\")" }';
  const out = mapRollout([
    {
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'quoted-denial-turn' },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'read_mcp_resource',
        call_id: 'quote-1',
        arguments: '{}',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'quote-1',
        output: quotedAutomaticDenial,
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'web_search',
        call_id: 'quote-2',
        arguments: '{}',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'quote-2',
        output: quotedAutomaticDenial,
      },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'turn_aborted',
        turn_id: 'quoted-denial-turn',
        reason: 'interrupted',
      },
    },
  ]);
  const notice = out.find((message) => message.type === 'notice') as any;
  check(
    'lookup results quoting denial text keep the interruption generic',
    notice?.message === 'Conversation interrupted.'
      && notice.semantic?.kind === 'interruption'
      && notice.semantic?.reason === 'generic',
    JSON.stringify(notice),
  );
}
{
  const automaticDenial =
    'exec_command failed: CreateProcess Rejected because the approval policy '
    + 'forbids escalated host execution.';
  const out = mapRollout([
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'first-turn' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'deny-1', output: automaticDenial } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'first-turn' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'next-turn' } },
    { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'next-turn', reason: 'interrupted' } },
  ]);
  const notices = out.filter((m) => m.type === 'notice') as any[];
  check(
    'one denial and a completed prior turn never leak a reason into a later interruption',
    notices.length === 1 && notices[0]?.message === 'Conversation interrupted.',
    JSON.stringify(notices),
  );
}
{
  const lines = [
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'update_plan',
        call_id: 'plan1',
        arguments: JSON.stringify({
          explanation: 'Plan the Codex task-list mapping.',
          plan: [
            { status: 'completed', step: 'Inspect Codex update_plan shape' },
            { status: 'in_progress', step: 'Map plan items to task-list-state' },
            { status: 'pending', step: 'Add regression tests and docs' },
          ],
        }),
      },
    },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'plan1', output: 'ok' } },
  ];
  const out = mapRollout(lines);
  const taskList = out.find((m) => m.type === 'task-list-state') as any;
  check(
    'Codex update_plan maps to one task-list-state panel',
    taskList?.key === 'codex:plan' &&
      taskList?.title === 'Plan' &&
      taskList?.sourceTool === 'update_plan' &&
      taskList?.semantic?.kind === 'plan' &&
      taskList?.semantic?.planKey === 'codex:plan' &&
      Object.values(taskList?.semantic?.actions ?? {}).every((supported) => supported === false) &&
      taskList?.status === 'running' &&
      taskList?.items?.length === 3 &&
      taskList.items[0].status === 'done' &&
      taskList.items[1].status === 'in-progress' &&
      taskList.items[2].status === 'open',
    JSON.stringify(out),
  );
  check('Codex update_plan suppresses raw tool-call card', !out.some((m) => m.type === 'tool-call' && (m as any).toolName === 'update_plan'), JSON.stringify(out));
  check('Codex update_plan suppresses raw tool-result card', !out.some((m) => m.type === 'tool-result' && (m as any).toolName === 'update_plan'), JSON.stringify(out));
}
{
  const out = mapRollout([
    { timestamp: '2026-06-18T10:20:00.000Z', type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: '2026-06-18T10:20:02.000Z', type: 'event_msg', payload: { type: 'task_complete' } },
  ]);
  const done = out.find((m) => m.type === 'run-summary' && (m as any).status === 'done') as any;
  check(
    'task_complete without turn_id closes the only active rollout run',
    done?.key === 'codex:run:line:0' && done?.totalRuntimeMs === 2000,
    JSON.stringify(out),
  );
}
{
  // apply_patch (the primary file-edit tool) arrives as a custom_tool_call, NOT function_call —
  // dropping it would render no edit in ~55% of real sessions. Must map call + enriched result.
  const lines = [
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'p1', input: '*** Begin Patch\n*** Add File: src/new.ts\n+const a = 1;\n+const b = 2;\n*** End Patch' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'p1', output: 'Success' } },
  ];
  const out = mapRollout(lines);
  const call = out.find((m) => m.type === 'tool-call') as any;
  const res = out.find((m) => m.type === 'tool-result') as any;
  check('custom_tool_call → tool-call (apply_patch, not dropped)', !!call && call.toolName === 'apply_patch' && call.callId === 'p1' && call.toolClass === 'edit', JSON.stringify(call));
  check('custom_tool_call_output → tool-result enriched (path + diffstat from patch body)', !!res && res.callId === 'p1' && res.toolName === 'apply_patch' && res.toolClass === 'edit' && res.path === 'src/new.ts' && res.additions === 2 && res.deletions === 0, JSON.stringify(res));
  check('apply_patch Add → create title + git-style header (new file, /dev/null base)', res?.title === 'Created new.ts' && res.diff.includes('diff --git a/src/new.ts b/src/new.ts') && res.diff.includes('--- /dev/null') && res.diff.includes('+++ b/src/new.ts'), JSON.stringify(res?.diff));
  check('apply_patch Add → fileChanges[create] with per-file diff + stats', res?.fileChanges?.length === 1 && res.fileChanges[0].operation === 'create' && res.fileChanges[0].path === 'src/new.ts' && res.fileChanges[0].additions === 2 && res.fileChanges[0].deletions === 0 && res.fileChanges[0].diff.includes('+++ b/src/new.ts'), JSON.stringify(res?.fileChanges));
}
{
  // apply_patch on an ABSOLUTE path must not emit a malformed `b//abs` header.
  const lines = [
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'abs1', input: '*** Begin Patch\n*** Add File: /tmp/x/a.ts\n+one\n*** End Patch' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'abs1', output: 'Success' } },
  ];
  const res = mapRollout(lines).find((m) => m.type === 'tool-result') as any;
  check('apply_patch absolute path → single-slash git header (no b//abs)', res?.path === '/tmp/x/a.ts' && res.diff.includes('diff --git a/tmp/x/a.ts b/tmp/x/a.ts') && res.diff.includes('+++ b/tmp/x/a.ts') && !res.diff.includes('b//tmp') && !res.diff.includes('a//tmp'), JSON.stringify(res?.diff));
}
{
  // apply_patch Update: V4A `@@ context` + ±/space body → git-style diff, "Edited" title, diffstat.
  const lines = [
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'u1', input: '*** Begin Patch\n*** Update File: src/a.ts\n@@ class A\n keep\n-old line\n+new line\n*** End Patch' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'u1', output: 'Success' } },
  ];
  const res = mapRollout(lines).find((m) => m.type === 'tool-result') as any;
  check('apply_patch Update → edit title + git-style headers + diffstat', res?.path === 'src/a.ts' && res.title === 'Edited a.ts' && res.additions === 1 && res.deletions === 1 && res.diff.includes('--- a/src/a.ts') && res.diff.includes('+++ b/src/a.ts'), JSON.stringify(res));
}
{
  // apply_patch Delete: no body content in V4A → deleted-file headers, "Deleted" title, no false diffstat.
  const lines = [
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'd1', input: '*** Begin Patch\n*** Delete File: src/gone.ts\n*** End Patch' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'd1', output: 'Success' } },
  ];
  const res = mapRollout(lines).find((m) => m.type === 'tool-result') as any;
  check('apply_patch Delete → delete title + deleted-file headers (/dev/null target)', res?.path === 'src/gone.ts' && res.title === 'Deleted gone.ts' && res.diff.includes('deleted file') && res.diff.includes('--- a/src/gone.ts') && res.diff.includes('+++ /dev/null'), JSON.stringify(res));
  check('apply_patch Delete → fileChanges[delete]', res?.fileChanges?.length === 1 && res.fileChanges[0].operation === 'delete' && res.fileChanges[0].path === 'src/gone.ts', JSON.stringify(res?.fileChanges));
}
{
  // patch_apply_end for a delete that carries the removed content → synthesized removed-body lines,
  // event-time (from the result event), NEVER reconstructed from Git.
  const lines = [
    { type: 'response_item', payload: { type: 'function_call', name: 'apply_patch', call_id: 'del2', arguments: '{}' } },
    { type: 'event_msg', payload: { type: 'patch_apply_end', call_id: 'del2', success: true, changes: { 'src/bye.ts': { type: 'delete', content: 'line one\nline two' } } } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'del2', output: 'ok' } },
  ];
  const res = mapRollout(lines).find((m) => m.type === 'tool-result') as any;
  check('patch_apply_end delete with content → removed body lines synthesized', res?.title === 'Deleted bye.ts' && res.deletions === 2 && res.diff.includes('-line one') && res.diff.includes('-line two') && res.fileChanges?.[0]?.operation === 'delete', JSON.stringify(res));
}
{
  // patch_apply_end for an UPDATE that carries only new-file `content` (no diff): `content` is the
  // whole new file, NOT a diff — synthesizing `+content` would render an edit as a brand-new file
  // (T1b finding 4). With no event-time diff we omit the body honestly (edit title, no fabricated +).
  const lines = [
    { type: 'response_item', payload: { type: 'function_call', name: 'apply_patch', call_id: 'up1', arguments: '{}' } },
    { type: 'event_msg', payload: { type: 'patch_apply_end', call_id: 'up1', success: true, changes: { 'src/edit.ts': { type: 'update', content: 'line one\nline two\nline three' } } } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'up1', output: 'ok' } },
  ];
  const res = mapRollout(lines).find((m) => m.type === 'tool-result') as any;
  check(
    'patch_apply_end update with only content → Edited, NOT fabricated as a create',
    res?.title === 'Edited edit.ts' &&
      res.fileChanges?.[0]?.operation === 'edit' &&
      !res.diff.includes('/dev/null') &&
      !res.diff.includes('new file') &&
      !res.diff.includes('+line one') &&
      (res.additions ?? 0) === 0,
    JSON.stringify(res),
  );
}
{
  // patch_apply_end for an update that DOES carry an event-time unified_diff: use it verbatim
  // (an honest edit body), not the header-only fallback.
  const lines = [
    { type: 'response_item', payload: { type: 'function_call', name: 'apply_patch', call_id: 'up2', arguments: '{}' } },
    { type: 'event_msg', payload: { type: 'patch_apply_end', call_id: 'up2', success: true, changes: { 'src/e2.ts': { type: 'update', unified_diff: '@@ -1,1 +1,1 @@\n-was\n+now' } } } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'up2', output: 'ok' } },
  ];
  const res = mapRollout(lines).find((m) => m.type === 'tool-result') as any;
  check(
    'patch_apply_end update with a carried unified_diff → uses it (edit, +1 −1)',
    res?.title === 'Edited e2.ts' && res.fileChanges?.[0]?.operation === 'edit' && res.diff.includes('-was') && res.diff.includes('+now') && res.additions === 1 && res.deletions === 1,
    JSON.stringify(res),
  );
}
{
  // apply_patch rename via `*** Move to:` → path follows the new name, git header spans old→new.
  const lines = [
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'r1', input: '*** Begin Patch\n*** Update File: src/old.ts\n*** Move to: src/new-name.ts\n@@ header\n keep\n+added\n*** End Patch' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'r1', output: 'Success' } },
  ];
  const res = mapRollout(lines).find((m) => m.type === 'tool-result') as any;
  check('apply_patch rename → new path + git header old→new', res?.path === 'src/new-name.ts' && res.diff.includes('diff --git a/src/old.ts b/src/new-name.ts') && res.diff.includes('--- a/src/old.ts') && res.diff.includes('+++ b/src/new-name.ts'), JSON.stringify(res));
  check('apply_patch rename → Renamed title + fileChanges[rename] with previousPath', res?.title === 'Renamed new-name.ts' && res.fileChanges?.[0]?.operation === 'rename' && res.fileChanges[0].previousPath === 'src/old.ts' && res.fileChanges[0].path === 'src/new-name.ts' && res.diff.includes('rename from src/old.ts') && res.diff.includes('rename to src/new-name.ts'), JSON.stringify(res));
}
{
  // apply_patch multi-file: two sections keep their own git boundaries (old code merged them into one blob).
  const lines = [
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'mf1', input: '*** Begin Patch\n*** Update File: src/one.ts\n@@ a\n keep\n-x\n+y\n*** Add File: src/two.ts\n+brand new\n*** End Patch' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'mf1', output: 'Success' } },
  ];
  const res = mapRollout(lines).find((m) => m.type === 'tool-result') as any;
  const twoBoundary = res?.diff.indexOf('diff --git a/src/two.ts b/src/two.ts') ?? -1;
  const oneBoundary = res?.diff.indexOf('diff --git a/src/one.ts b/src/one.ts') ?? -1;
  check('apply_patch multi-file → both sections keep distinct git boundaries in order', oneBoundary >= 0 && twoBoundary > oneBoundary && res.diff.includes('+++ b/src/two.ts') && res.additions === 2 && res.deletions === 1, JSON.stringify(res?.diff));
  check('apply_patch multi-file → fileChanges[2] per-file (edit one.ts + create two.ts) + count title', res?.fileChanges?.length === 2 && res.fileChanges[0].path === 'src/one.ts' && res.fileChanges[0].operation === 'edit' && res.fileChanges[1].path === 'src/two.ts' && res.fileChanges[1].operation === 'create' && res.title === 'Changed 2 files', JSON.stringify({ t: res?.title, fc: res?.fileChanges }));
}
{
  // A blank/malformed line must STILL consume its index so the next message is keyed by raw position
  // — this is what keeps the history snapshot and the live tail's per-segment counter aligned (dedupe).
  const lines = [
    { type: 'event_msg', payload: { type: 'user_message', message: 'hi' } }, // index 0 → c0
    null, // blank → index 1 consumed, no emit
    null, // malformed → index 2 consumed, no emit
    { type: 'event_msg', payload: { type: 'agent_message', message: 'yo' } }, // index 3 → c3
  ];
  const out = mapRollout(lines);
  const user = out.find((m) => m.type === 'user-message') as any;
  const model = out.find((m) => m.type === 'model-output') as any;
  check('blank/malformed slots preserve line-index keys (history/live alignment)', user?.key === 'c0' && model?.key === 'c3', `user=${user?.key} model=${model?.key}`);
}
{
  // A steer delivered during one native turn is a real source boundary, not a queued next-turn
  // prompt. Adapter mapping must retain exact rollout order and canonical turn ordinals.
  const lines = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-steer' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'open' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'before' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'msg-before', content: [{ type: 'output_text', text: 'before' }] } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'steer' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'after' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'msg-after', content: [{ type: 'output_text', text: 'after' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-steer' } },
  ];
  const chronologicalKeys = mapRollout(lines)
    .filter((message) => message.type === 'user-message' || message.type === 'model-output')
    .map((message: any) => message.key);
  check(
    'native mid-turn steer preserves exact canonical key order at the adapter boundary',
    chronologicalKeys.join(',') === [
      'codex:turn-steer:u0',
      'codex:turn-steer:msg-before:t',
      'codex:turn-steer:u1',
      'codex:turn-steer:msg-after:t',
    ].join(','),
    chronologicalKeys.join(','),
  );
}
{
  const lines = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'terminal-a' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'terminal-a' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'terminal-a' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'terminal-b' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'terminal-a' } },
    { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'terminal-b', reason: 'interrupted' } },
    { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'terminal-b', reason: 'interrupted' } },
  ];
  const out = mapRollout(lines);
  const idleCount = out.filter((message: any) => message.type === 'status' && message.status === 'idle').length;
  const terminalRuns = out.filter((message: any) => message.type === 'run-summary' && message.status !== 'running');
  check(
    'matching terminals retire each exact turn once; duplicate and stale terminals emit no footer/status',
    idleCount === 2 &&
      terminalRuns.length === 2 &&
      terminalRuns.map((message: any) => message.turnId).join(',') === 'terminal-a,terminal-b',
    JSON.stringify({ idleCount, terminalRuns: terminalRuns.map((message: any) => [message.turnId, message.status]) }),
  );
}
{
  const dir = `/tmp/cosyncingcodexrollout${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'rollout-2026-06-16T00-00-00-019ed00e-aac3-78f1-b373-cd365cf6a9b2.jsonl');
  const base = [
    { type: 'session_meta', payload: { cwd: '/tmp/x', id: '019ed00e-aac3-78f1-b373-cd365cf6a9b2' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
  ];
  try {
    writeFileSync(path, base.map((line) => JSON.stringify(line)).join('\n') + '\n');
    check('discover status infers working from unmatched task_started', await inferRolloutStatus(path) === 'working', await inferRolloutStatus(path));
    const progressLine = JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'x'.repeat(1024) } }) + '\n';
    const progress = progressLine.repeat(Math.ceil((9 * 1024 * 1024) / Buffer.byteLength(progressLine)));
    appendFileSync(path, progress);
    const quiet = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(path, quiet, quiet);
    check(
      'more than 8 MiB of valid progress cannot evict an admitted task_started',
      Buffer.byteLength(progress) > 8 * 1024 * 1024 && await inferRolloutStatus(path) === 'working',
      JSON.stringify({ appendedBytes: Buffer.byteLength(progress), status: await inferRolloutStatus(path) }),
    );
    appendFileSync(path, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } }) + '\n');
    check('exact task_complete after the 8 MiB boundary retires the turn', await inferRolloutStatus(path) === 'idle', await inferRolloutStatus(path));

    appendFileSync(path, [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 't2' } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n');
    check(
      'stale and duplicate terminals cannot overwrite a newer unmatched active turn',
      await inferRolloutStatus(path) === 'working',
      await inferRolloutStatus(path),
    );
    appendFileSync(path, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't2' } }) + '\n');
    check('the exact matching terminal retires the newer authority once', await inferRolloutStatus(path) === 'idle', await inferRolloutStatus(path));
    appendFileSync(path, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't2' } }) + '\n');
    check('a duplicate matching terminal cannot create a second status transition', await inferRolloutStatus(path) === 'idle', await inferRolloutStatus(path));

    const coldPath = join(dir, 'rollout-2026-06-16T00-00-01-019ed00e-aac3-78f1-b373-cd365cf6a9b3.jsonl');
    writeFileSync(coldPath, base.map((line) => JSON.stringify(line)).join('\n') + '\n' + progress);
    utimesSync(coldPath, quiet, quiet);
    check(
      'cold first read recovers task_started beyond the newest 8 MiB',
      Buffer.byteLength(progress) > 8 * 1024 * 1024 && await inferRolloutStatus(coldPath) === 'working',
      JSON.stringify({ appendedBytes: Buffer.byteLength(progress), status: await inferRolloutStatus(coldPath) }),
    );
    appendFileSync(coldPath, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } }) + '\n');
    check(
      'cold-recovered task retires on its exact completion',
      await inferRolloutStatus(coldPath) === 'idle',
      await inferRolloutStatus(coldPath),
    );

    const duplicateStartPath = join(dir, 'rollout-2026-06-16T00-00-02-019ed00e-aac3-78f1-b373-cd365cf6a9b4.jsonl');
    writeFileSync(duplicateStartPath, [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'duplicate-start' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'duplicate-start' } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'duplicate-start' } },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n');
    check(
      'cold reverse scan keeps a terminal matched across duplicate task_started markers',
      await inferRolloutStatus(duplicateStartPath) === 'idle',
      await inferRolloutStatus(duplicateStartPath),
    );

    const supersededOrphanPath = join(dir, 'rollout-2026-06-16T00-00-03-019ed00e-aac3-78f1-b373-cd365cf6a9b5.jsonl');
    writeFileSync(supersededOrphanPath, [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'lost-terminal' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'newer-turn' } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'newer-turn' } },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n');
    check(
      'a newer completed turn supersedes an older orphaned task_started after cold restart',
      await inferRolloutStatus(supersededOrphanPath) === 'idle',
      await inferRolloutStatus(supersededOrphanPath),
    );

    writeFileSync(path, base.map((line) => JSON.stringify(line)).join('\n') + '\n');
    check('truncation resets authority and admits the replacement task', await inferRolloutStatus(path) === 'working', await inferRolloutStatus(path));
    appendFileSync(path, JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 't1' } }) + '\n');
    check('discover status returns idle after turn_aborted', await inferRolloutStatus(path) === 'idle', await inferRolloutStatus(path));

    const replacement = join(dir, 'replacement.jsonl');
    writeFileSync(replacement, base.map((line) => JSON.stringify(line)).join('\n') + '\n');
    renameSync(replacement, path);
    check('atomic source replacement resets and admits its exact task', await inferRolloutStatus(path) === 'working', await inferRolloutStatus(path));
    appendFileSync(path, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } }) + '\n');
    check('replacement task completion retires only the replacement authority', await inferRolloutStatus(path) === 'idle', await inferRolloutStatus(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const dir = mkdtempSync(join(tmpdir(), 'cosyncing-codex-observe-authority-'));
  try {
    const fixtures = [
      { label: 'main', id: '33333333-3333-4333-8333-333333333333', source: 'cli' },
      { label: 'subagent', id: '44444444-4444-4444-8444-444444444444', source: 'subagent' },
    ];
    const adapter = new CodexAdapter({
      // The main thread is owned by the native daemon. The child has no separate process; its
      // parent owns its writer, so exact child lifecycle authority remains valid without one.
      queryLoadedThreadIds: async () => new Set([fixtures[0]!.id]),
    });
    const statuses: Array<[string, string]> = [];
    for (const fixture of fixtures) {
      const path = join(dir, `rollout-2026-08-03T12-00-00-${fixture.id}.jsonl`);
      writeFileSync(path, [
        { timestamp: '2026-08-03T12:00:00.000Z', type: 'session_meta', payload: { id: fixture.id, cwd: dir, thread_source: fixture.source, ...(fixture.source === 'subagent' ? { parent_thread_id: fixtures[0]!.id } : {}) } },
        { timestamp: '2026-08-03T12:00:01.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: `turn-${fixture.label}` } },
        { timestamp: '2026-08-03T12:00:02.000Z', type: 'event_msg', payload: { type: 'user_message', message: fixture.label } },
      ].map((line) => JSON.stringify(line)).join('\n') + '\n');
      const conn = await adapter.attach(Buffer.from(path).toString('base64url'), 'observe');
      statuses.push([fixture.label, conn.info.status]);
      await conn.close();
    }
    check(
      'Observe owner seeds exact unmatched authority for a daemon-owned main and its subagent',
      statuses.every(([, status]) => status === 'working'),
      JSON.stringify(statuses),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const dir = mkdtempSync(join(tmpdir(), 'cosyncing-codex-authority-bound-'));
  const markerFree = join(dir, 'rollout-marker-free.jsonl');
  const sourceBytes = 256 * 1024 * 1024;
  let fd: number | undefined;
  try {
    fd = openSync(markerFree, 'w');
    ftruncateSync(fd, sourceBytes);
    const newline = Buffer.from('\n');
    for (let at = 512 * 1024 - 1; at < sourceBytes; at += 512 * 1024) {
      writeSync(fd, newline, 0, 1, at);
    }
    closeSync(fd);
    fd = undefined;

    let ticks = 0;
    const heartbeat = setInterval(() => { ticks += 1; }, 10);
    const started = performance.now();
    const bounded = await inferRolloutStatusResult(markerFree);
    const elapsedMs = performance.now() - started;
    clearInterval(heartbeat);
    check(
      'cold marker-free 256 MiB recovery yields and returns a typed admission fallback',
      bounded.kind === 'fallback'
        && (bounded.reason === 'source-limit' || bounded.reason === 'time-limit')
        && bounded.scannedBytes <= 64 * 1024 * 1024
        && ticks > 0
        && elapsedMs < 1000,
      JSON.stringify({ bounded, ticks, elapsedMs: Math.round(elapsedMs) }),
    );

    const timeLimited = join(dir, 'rollout-marker-free-time-limit.jsonl');
    linkSync(markerFree, timeLimited);
    const timed = await inferRolloutStatusResult(timeLimited, {
      maxSourceBytes: sourceBytes,
      maxElapsedMs: 1,
    });
    check(
      'cold Codex recovery has a distinct typed wall-clock fallback',
      timed.kind === 'fallback'
        && timed.reason === 'time-limit'
        && timed.scannedBytes < sourceBytes,
      JSON.stringify(timed),
    );

    const raced = join(dir, 'rollout-raced.jsonl');
    const retiredLine = JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'same-size' } }) + '\n';
    const replacementLine = JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'same-size' } }) + '\n';
    writeFileSync(raced, retiredLine);
    const racedStat = statSync(raced);
    const changed = await inferRolloutStatusResult(raced, {
      beforeValidation: () => {
        writeFileSync(raced, replacementLine);
        utimesSync(raced, racedStat.atime, racedStat.mtime);
      },
    });
    check(
      'cold Codex scan rejects a same-inode/same-size boundary rewrite before publication',
      changed.kind === 'fallback'
        && changed.reason === 'source-changed'
        && Buffer.byteLength(retiredLine) === Buffer.byteLength(replacementLine)
        && await inferRolloutStatus(raced) === 'idle',
      JSON.stringify(changed),
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const dir = mkdtempSync(join(tmpdir(), 'cosyncing-codex-authority-warm-bound-'));
  const path = join(dir, 'rollout-warm-large-append.jsonl');
  const taskStarted = JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'warm-large' } }) + '\n';
  const appendBytes = 512 * 1024 * 1024;
  let fd: number | undefined;
  try {
    writeFileSync(path, taskStarted);
    const seeded = await inferRolloutStatusResult(path);
    check(
      'warm Codex resource fixture seeds exact active authority',
      seeded.kind === 'authority' && seeded.status === 'working',
      JSON.stringify(seeded),
    );

    const seedSize = statSync(path).size;
    fd = openSync(path, 'r+');
    const incompleteStart = Buffer.from('{');
    writeSync(fd, incompleteStart, 0, incompleteStart.length, seedSize);
    ftruncateSync(fd, seedSize + appendBytes);
    closeSync(fd);
    fd = undefined;

    let ticks = 0;
    const heartbeat = setInterval(() => { ticks += 1; }, 10);
    const startedAt = performance.now();
    const bounded = await inferRolloutStatusResult(path, { maxElapsedMs: 1000 });
    const elapsedMs = performance.now() - startedAt;
    clearInterval(heartbeat);
    check(
      'warm Codex 512 MiB incomplete append yields and reports bounded source work',
      bounded.kind === 'fallback'
        && bounded.status === 'working'
        && bounded.reason === 'source-limit'
        && bounded.scannedBytes > 0
        && bounded.scannedBytes <= 64 * 1024 * 1024
        && ticks > 0
        && elapsedMs < 1000,
      JSON.stringify({ bounded, ticks, elapsedMs: Math.round(elapsedMs) }),
    );

    let caughtUpBytes = bounded.scannedBytes;
    let catchupPasses = 1;
    let catchup = bounded;
    while (caughtUpBytes < appendBytes && catchupPasses < 16) {
      catchup = await inferRolloutStatusResult(path, { maxElapsedMs: 1000 });
      caughtUpBytes += catchup.scannedBytes;
      catchupPasses += 1;
      if (catchup.scannedBytes === 0) break;
    }
    check(
      'unchanged warm Codex fallback advances to EOF in bounded passes without rescanning processed bytes',
      catchup.kind === 'fallback'
        && catchup.status === 'working'
        && catchup.reason === 'record-limit'
        && caughtUpBytes === appendBytes
        && catchupPasses === appendBytes / (64 * 1024 * 1024),
      JSON.stringify({ catchup, caughtUpBytes, catchupPasses }),
    );

    const settled = await inferRolloutStatusResult(path);
    check(
      'settled opaque Codex fallback performs zero repeated source work',
      settled.kind === 'fallback'
        && settled.status === 'working'
        && settled.reason === 'record-limit'
        && settled.scannedBytes === 0,
      JSON.stringify(settled),
    );

    appendFileSync(path, '\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'warm-large' } }) + '\n');
    const completed = await inferRolloutStatusResult(path);
    check(
      'exact Codex completion after an opaque warm append promptly restores terminal authority',
      completed.kind === 'authority'
        && completed.status === 'idle'
        && completed.scannedBytes > 0
        && completed.scannedBytes < 1024,
      JSON.stringify(completed),
    );

    const beyondBudget = join(dir, 'rollout-warm-terminal-beyond-budget.jsonl');
    writeFileSync(beyondBudget, taskStarted);
    await inferRolloutStatusResult(beyondBudget);
    const progress = Buffer.from(JSON.stringify({
      type: 'response_item',
      payload: { type: 'reasoning', encrypted_content: 'x'.repeat(512 * 1024) },
    }) + '\n');
    const progressTarget = 70 * 1024 * 1024;
    let progressBytes = 0;
    fd = openSync(beyondBudget, 'a');
    while (progressBytes < progressTarget) {
      writeSync(fd, progress);
      progressBytes += progress.length;
    }
    const exactCompletion = Buffer.from(JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'warm-large' },
    }) + '\n');
    writeSync(fd, exactCompletion);
    closeSync(fd);
    fd = undefined;

    const firstBudget = await inferRolloutStatusResult(beyondBudget, { maxElapsedMs: 1000 });
    const secondBudget = await inferRolloutStatusResult(beyondBudget, { maxElapsedMs: 1000 });
    check(
      'warm Codex scan resumes beyond 64 MiB and publishes an already-present exact completion',
      firstBudget.kind === 'fallback'
        && firstBudget.status === 'working'
        && firstBudget.reason === 'source-limit'
        && firstBudget.scannedBytes === 64 * 1024 * 1024
        && secondBudget.kind === 'authority'
        && secondBudget.status === 'idle'
        && secondBudget.scannedBytes > progressBytes - firstBudget.scannedBytes
        && secondBudget.scannedBytes < 8 * 1024 * 1024,
      JSON.stringify({ firstBudget, secondBudget, progressBytes }),
    );

    const recordLimited = join(dir, 'rollout-warm-record-limit.jsonl');
    writeFileSync(recordLimited, taskStarted);
    await inferRolloutStatusResult(recordLimited);
    const recordSeedSize = statSync(recordLimited).size;
    fd = openSync(recordLimited, 'r+');
    writeSync(fd, incompleteStart, 0, incompleteStart.length, recordSeedSize);
    ftruncateSync(fd, recordSeedSize + 2 * 1024 * 1024);
    closeSync(fd);
    fd = undefined;
    const recordBounded = await inferRolloutStatusResult(recordLimited);
    check(
      'warm Codex oversized record has a distinct typed record fallback',
      recordBounded.kind === 'fallback'
        && recordBounded.status === 'working'
        && recordBounded.reason === 'record-limit'
        && recordBounded.scannedBytes === 2 * 1024 * 1024,
      JSON.stringify(recordBounded),
    );

    const timeLimited = join(dir, 'rollout-warm-time-limit.jsonl');
    writeFileSync(timeLimited, taskStarted);
    await inferRolloutStatusResult(timeLimited);
    const timeSeedSize = statSync(timeLimited).size;
    fd = openSync(timeLimited, 'r+');
    writeSync(fd, incompleteStart, 0, incompleteStart.length, timeSeedSize);
    ftruncateSync(fd, timeSeedSize + 256 * 1024 * 1024);
    closeSync(fd);
    fd = undefined;
    const timeBounded = await inferRolloutStatusResult(timeLimited, {
      maxSourceBytes: 256 * 1024 * 1024,
      maxElapsedMs: 1,
    });
    check(
      'warm Codex append has a distinct typed wall-clock fallback',
      timeBounded.kind === 'fallback'
        && timeBounded.status === 'working'
        && timeBounded.reason === 'time-limit'
        && timeBounded.scannedBytes > 0
        && timeBounded.scannedBytes < 256 * 1024 * 1024,
      JSON.stringify(timeBounded),
    );

    const raced = join(dir, 'rollout-warm-raced.jsonl');
    const replacementActive = JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'warm-large' } }) + '\n';
    const replacementTerminal = JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'warm-large' } }) + '\n';
    writeFileSync(raced, taskStarted);
    await inferRolloutStatusResult(raced);
    appendFileSync(raced, replacementActive);
    const racedStat = statSync(raced);
    const changed = await inferRolloutStatusResult(raced, {
      beforeValidation: () => {
        writeFileSync(raced, taskStarted + replacementTerminal);
        utimesSync(raced, racedStat.atime, racedStat.mtime);
      },
    });
    check(
      'warm Codex scan rejects a same-inode/same-size rewrite before publication',
      changed.kind === 'fallback'
        && changed.reason === 'source-changed'
        && Buffer.byteLength(replacementActive) === Buffer.byteLength(replacementTerminal)
        && await inferRolloutStatus(raced) === 'idle',
      JSON.stringify(changed),
    );

    const appendRaced = join(dir, 'rollout-warm-append-raced.jsonl');
    const progressLine = JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'append-race' } }) + '\n';
    const lateProgressLine = JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'late-append' } }) + '\n';
    writeFileSync(appendRaced, taskStarted);
    await inferRolloutStatusResult(appendRaced);
    appendFileSync(appendRaced, progressLine);
    const appendChanged = await inferRolloutStatusResult(appendRaced, {
      beforeValidation: () => {
        appendFileSync(appendRaced, lateProgressLine);
      },
    });
    const appendSettled = await inferRolloutStatusResult(appendRaced);
    check(
      'append racing an admitted warm Codex scan keeps published active authority',
      appendChanged.kind === 'fallback'
        && appendChanged.reason === 'source-changed'
        && appendChanged.status === 'working'
        && appendSettled.kind === 'authority'
        && appendSettled.status === 'working',
      JSON.stringify({ appendChanged, appendSettled }),
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const guardianMeta = {
    id: '019ed00d-4d60-7d20-8f6a-bbe3b9140776',
    parent_thread_id: '019ed007-ac77-7771-88cc-532074250b9c',
    cwd: '/workspace/cosyncing',
    source: { subagent: { other: 'guardian' } },
    thread_source: 'subagent',
  };
  const normalMeta = {
    id: '019ed007-ac77-7771-88cc-532074250b9c',
    cwd: '/workspace/cosyncing',
    source: 'cli',
    thread_source: 'user',
  };
  const namedSubagentMeta = {
    id: '019ed15e-8869-7cf1-be9f-189faf8d97d2',
    forked_from_id: '019ed00e-aac3-78f1-b373-cd365cf6a9b2',
    parent_thread_id: '019ed00e-aac3-78f1-b373-cd365cf6a9b2',
    cwd: '/mnt/h/Developing/Agent/Tokdash_Project/tokdash',
    source: { subagent: { thread_spawn: { parent_thread_id: '019ed00e-aac3-78f1-b373-cd365cf6a9b2', depth: 1, agent_nickname: 'Popper' } } },
    thread_source: 'subagent',
    agent_nickname: 'Popper',
  };
  // Tag-not-drop (issues-part3 subagent display): discovery EMITS auto sessions with an origin tag —
  // the app hides subagent/exec by default. Shapes pinned from maintainer's 646 real rollouts.
  const g = codexSessionOrigin(guardianMeta);
  check('guardian auto-review child classifies origin subagent + parent id', g.origin === 'subagent' && g.parentThreadId === guardianMeta.parent_thread_id, JSON.stringify(g));
  const named = codexSessionOrigin(namedSubagentMeta);
  check('named Codex subagent classifies origin subagent + parent id', named.origin === 'subagent' && named.parentThreadId === namedSubagentMeta.parent_thread_id, JSON.stringify(named));
  check('normal Codex sessions carry NO origin tag', codexSessionOrigin(normalMeta).origin === undefined, JSON.stringify(codexSessionOrigin(normalMeta)));
  const oldShape = { id: 'x', originator: 'codex_vscode', source: { subagent: { thread_spawn: { parent_thread_id: 'p-old', depth: 1 } } } }; // 2026-03 era: no thread_source, parent nested in source
  const oldTag = codexSessionOrigin(oldShape);
  check('OLD object-shape subagent meta (no thread_source) still classifies with its nested parent', oldTag.origin === 'subagent' && oldTag.parentThreadId === 'p-old', JSON.stringify(oldTag));
  // R1c: the roster nests on `child.parentThreadId === parent.nativeId`, so the CURRENT
  // (`parent_thread_id` + `thread_source`) and LEGACY (parent nested under `source.subagent.thread_spawn`,
  // no `thread_source`) metadata shapes must resolve to the SAME parent relation for the same thread.
  const currentShape = codexSessionOrigin({
    id: 'kid-1',
    parent_thread_id: '019ed00e-aac3-78f1-b373-cd365cf6a9b2',
    thread_source: 'subagent',
  });
  const legacyShape = codexSessionOrigin({
    id: 'kid-1',
    originator: 'codex_vscode',
    source: { subagent: { thread_spawn: { parent_thread_id: '019ed00e-aac3-78f1-b373-cd365cf6a9b2', depth: 1 } } },
  });
  check(
    'CURRENT and LEGACY subagent metadata resolve to the SAME parent relation',
    currentShape.origin === legacyShape.origin && currentShape.parentThreadId === legacyShape.parentThreadId,
    JSON.stringify({ current: currentShape, legacy: legacyShape }),
  );
  check(
    'that shared parent relation is the parent thread id the roster resolves against',
    currentShape.parentThreadId === '019ed00e-aac3-78f1-b373-cd365cf6a9b2' && currentShape.origin === 'subagent',
    JSON.stringify(currentShape),
  );
  // A nested grandchild is just another subagent row naming its own parent: depth is the client's
  // concern, so the adapter must not flatten a 2-level chain to the top-level thread.
  const grandchild = codexSessionOrigin({ id: 'kid-2', parent_thread_id: 'kid-1', thread_source: 'subagent' });
  check(
    'a nested subagent names its IMMEDIATE parent, not the root thread',
    grandchild.parentThreadId === 'kid-1',
    JSON.stringify(grandchild),
  );
  check('codex_exec runs classify origin exec', codexSessionOrigin({ originator: 'codex_exec', thread_source: 'user' }).origin === 'exec');
  check('thread_source exec classifies origin exec (vscode-launched exec)', codexSessionOrigin({ originator: 'codex_vscode', thread_source: 'exec' }).origin === 'exec');
  check('vscode extension sessions classify origin vscode', codexSessionOrigin({ originator: 'codex_vscode', thread_source: 'user' }).origin === 'vscode');
  check('KNOWN agent/probe originators classify origin exec (hide auto, show human)', codexSessionOrigin({ originator: 'cosyncing-trace-probe', thread_source: 'user' }).origin === 'exec' && codexSessionOrigin({ originator: 'cosyncing-trace-probe', thread_source: 'user' }).origin === 'exec' && codexSessionOrigin({ originator: 'Claude Code', thread_source: 'vscode' }).origin === 'exec');
  check('an UNKNOWN front-end originator fails OPEN to displayed (hypothetical Cursor — hiding needs positive automation evidence)', codexSessionOrigin({ originator: 'cursor', thread_source: 'user' }).origin === undefined && codexSessionOrigin({ originator: 'some-future-ide', thread_source: 'vscode' }).origin === undefined);
  check('an unknown originator STILL hides when the thread_source proves automation', codexSessionOrigin({ originator: 'cursor', thread_source: 'exec' }).origin === 'exec' && codexSessionOrigin({ originator: 'cursor', thread_source: 'subagent', parent_thread_id: 'p9' }).origin === 'subagent');
  check("the app's own created sessions carry NO origin tag", codexSessionOrigin({ originator: 'cosyncing', thread_source: 'user' }).origin === undefined);
  check('TUI + cli_rs sessions carry NO origin tag', codexSessionOrigin({ originator: 'codex-tui', thread_source: 'user' }).origin === undefined && codexSessionOrigin({ originator: 'codex_cli_rs', thread_source: 'cli' }).origin === undefined);
}
{
  check('working Codex TUI sessions are observe-only, not app-driven resume', codexAttachMode(true, 'working') === 'observe', codexAttachMode(true, 'working'));
  check('idle Codex sessions open observe-first until explicit Drive', codexAttachMode(true, 'idle') === 'observe', codexAttachMode(true, 'idle'));
  check('Codex without app-server falls back to observe', codexAttachMode(false, 'idle') === 'observe', codexAttachMode(false, 'idle'));
  check('daemon-loaded Codex threads advertise live sync when detected', codexAttachMode(true, 'working', true) === 'live', codexAttachMode(true, 'working', true));
}
{
  const dir = `/tmp/cosyncingcodexdefault${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'rollout-2026-06-16T00-00-00-019ed00e-aac3-78f1-b373-cd365cf6a9b2.jsonl');
  const fakeCodex = join(dir, 'codex');
  const previousBin = process.env.COSYNCING_CODEX_BIN;
  try {
    // Drive availability is what this fixture exercises. Do not inherit the
    // developer or hosted runner's Codex installation as an undeclared test
    // prerequisite; Observe never executes this inert binary.
    writeFileSync(fakeCodex, '#!/bin/sh\nexit 0\n');
    chmodSync(fakeCodex, 0o755);
    process.env.COSYNCING_CODEX_BIN = fakeCodex;
    writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { cwd: dir, id: '019ed00e-aac3-78f1-b373-cd365cf6a9b2' } }) + '\n');
    const conn = await new CodexAdapter().attach(Buffer.from(path, 'utf8').toString('base64url'));
    try {
      check('default Codex attach is observe/read-only even when idle', conn.info.attachMode === 'observe', conn.info.attachMode);
      check('default Codex control state is observing and drivable', conn.info.control?.drive.state === 'observing' && conn.info.control?.drive.supported === true, JSON.stringify(conn.info.control?.drive));
      check(
        syncServerEnabled ? 'Codex true-sync state is explicit when enabled but not daemon-loaded' : 'Codex true-sync state is explicit even when disabled',
        conn.info.control?.terminalSync.active === false && conn.info.control?.terminalSync.supported === syncServerEnabled,
        JSON.stringify(conn.info.control?.terminalSync),
      );
    } finally {
      await conn.close();
    }
  } finally {
    if (previousBin == null) delete process.env.COSYNCING_CODEX_BIN;
    else process.env.COSYNCING_CODEX_BIN = previousBin;
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const dir = `/tmp/cosyncingcodexsurface${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'rollout-2026-06-16T00-00-00-019ed00e-aac3-78f1-b373-cd365cf6a9b2.jsonl');
  try {
    writeFileSync(
      path,
      [
        { type: 'session_meta', payload: { cwd: dir, id: '019ed00e-aac3-78f1-b373-cd365cf6a9b2', model: 'gpt-5.3-codex-spark', model_provider: 'openai', model_reasoning_effort: 'low' } },
        { type: 'turn_context', payload: { turn_id: 't1', approval_policy: 'never', sandbox_policy: { type: 'dangerFullAccess' } } },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n') + '\n',
    );
    const conn = await new CodexAdapter().attach(Buffer.from(path, 'utf8').toString('base64url'), 'observe');
    try {
      const models = await Promise.resolve(conn.listModels?.() ?? []);
      const modes = await Promise.resolve(conn.listModes?.() ?? []);
      check(
        'Observe SessionInfo exposes Codex rollout model/effort and locked mode',
        conn.info.model === 'gpt-5.3-codex-spark' &&
          conn.info.currentModel?.providerID === 'openai' &&
          conn.info.currentModel?.modelID === 'gpt-5.3-codex-spark' &&
          conn.info.currentModel?.reasoningEffort === 'low' &&
          conn.info.currentMode === 'full-access',
        JSON.stringify(conn.info),
      );
      check(
        'Observe listModels/listModes expose only metadata-backed locked options',
        models.length === 1 &&
          models[0]?.modelID === 'gpt-5.3-codex-spark' &&
          models[0]?.providerID === 'openai' &&
          models[0]?.reasoningEfforts?.[0]?.effort === 'low' &&
          modes.length === 1 &&
          modes[0]?.value === 'full-access' &&
          modes[0]?.category === 'full-access',
        `models=${JSON.stringify(models)} modes=${JSON.stringify(modes)}`,
      );
    } finally {
      await conn.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const dir = `/tmp/cosyncingcodexnofake${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'rollout-2026-06-16T00-00-00-019ed00e-aac3-78f1-b373-cd365cf6a9b2.jsonl');
  try {
    writeFileSync(
      path,
      [
        { type: 'session_meta', payload: { cwd: dir, id: '019ed00e-aac3-78f1-b373-cd365cf6a9b2', model_provider: 'openai' } },
        { type: 'turn_context', payload: { turn_id: 't1', approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write' } } },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n') + '\n',
    );
    const conn = await new CodexAdapter().attach(Buffer.from(path, 'utf8').toString('base64url'), 'observe');
    try {
      const models = await Promise.resolve(conn.listModels?.() ?? []);
      const modes = await Promise.resolve(conn.listModes?.() ?? []);
      check('Observe does not invent a model when rollout metadata only has provider', conn.info.model == null && conn.info.currentModel == null && models.length === 0, JSON.stringify({ info: conn.info, models }));
      check('Observe still maps known Codex approval/sandbox metadata to locked permission category', conn.info.currentMode === 'ask-permission' && modes[0]?.category === 'ask-permission', JSON.stringify(modes));
    } finally {
      await conn.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 1h. subagent lifecycle → agent-activity bars (spawn_agent / wait_agent) ──────
//   Codex spawns named child threads via spawn_agent and joins them via wait_agent, all in the PARENT
//   rollout (call_id-correlated like any tool). They must surface as the canonical `agent-activity`
//   subagent bars (the same type Claude's Task subagents use) — running on the spawn output, done on
//   the wait output — and the raw spawn/wait control cards must NOT leak as tool cards.
{
  const lines = [
    { type: 'session_meta', payload: { cwd: '/tmp/x', id: 'parent-subs' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'research', turn_id: 't1' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' }, timestamp: '2026-03-20T23:45:00.000Z' },
    { type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'cs1', arguments: JSON.stringify({ agent_type: 'explorer', model: 'gpt-5.4-mini', reasoning_effort: 'high', message: 'verify claims' }) }, timestamp: '2026-03-20T23:45:01.000Z' },
    { type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'cs2', arguments: JSON.stringify({ agent_type: 'coder', message: 'patch it' }) }, timestamp: '2026-03-20T23:45:01.500Z' },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'cs1', output: JSON.stringify({ agent_id: 'kid-A', nickname: 'Turing' }) }, timestamp: '2026-03-20T23:45:02.000Z' },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'cs2', output: JSON.stringify({ agent_id: 'kid-B', nickname: 'Carson' }) }, timestamp: '2026-03-20T23:45:02.200Z' },
    // first join: A done, B still running → B's bar must stay running
    { type: 'response_item', payload: { type: 'function_call', name: 'wait_agent', call_id: 'cw1', arguments: JSON.stringify({ ids: ['kid-A', 'kid-B'], timeout_ms: 120000 }) }, timestamp: '2026-03-20T23:45:30.000Z' },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'cw1', output: JSON.stringify({ status: { 'kid-A': { completed: 'Found.' }, 'kid-B': { status: 'running' } } }) }, timestamp: '2026-03-20T23:46:11.000Z' },
    // second join: B done
    { type: 'response_item', payload: { type: 'function_call', name: 'wait_agent', call_id: 'cw2', arguments: JSON.stringify({ ids: ['kid-B'], timeout_ms: 120000 }) }, timestamp: '2026-03-20T23:46:20.000Z' },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'cw2', output: JSON.stringify({ status: { 'kid-B': { completed: 'Patched.' } } }) }, timestamp: '2026-03-20T23:46:40.000Z' },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' }, timestamp: '2026-03-20T23:46:41.000Z' },
  ];
  const out = mapRollout(lines) as any[];
  const acts = out.filter((m) => m.type === 'agent-activity');
  const final = new Map<string, any>(); // the app upserts by key → last frame per key is what renders
  for (const a of acts) final.set(a.key, a);
  const A = final.get('agent:kid-A');
  const B = final.get('agent:kid-B');
  const leaked = out.some((m) => (m.type === 'tool-call' || m.type === 'tool-result') && (m.toolName === 'spawn_agent' || m.toolName === 'wait_agent'));
  check('subagent: both children surface as subagent agent-activity bars', final.size === 2 && [...final.values()].every((a) => a.kind === 'subagent'), `keys=${[...final.keys()].join(',')}`);
  check('subagent: spawn output sets nickname title + agent_type subtitle', A?.title === 'Turing' && A?.subtitle === 'explorer' && B?.title === 'Carson' && B?.subtitle === 'coder', JSON.stringify({ A: { t: A?.title, s: A?.subtitle }, B: { t: B?.title, s: B?.subtitle } }));
  check('subagent: a running child is NOT marked done by an unrelated wait (B running through cw1)', acts.some((a) => a.key === 'agent:kid-B' && a.status === 'running'), 'expected an intermediate running B frame');
  check('subagent: wait_agent completion → done bar with first→last elapsed', A?.status === 'done' && A?.elapsedMs === 69000 && B?.status === 'done' && B?.elapsedMs === 97800, JSON.stringify({ A: { st: A?.status, e: A?.elapsedMs }, B: { st: B?.status, e: B?.elapsedMs } }));
  check('subagent: raw spawn_agent/wait_agent control cards are suppressed (no tool cards leak)', !leaked, leaked ? 'a spawn/wait tool card leaked' : '');
  // the child's RETURNED REPORT is preserved as a `subagent` tool-result (the bar has no body field) — not dropped.
  const reports = out.filter((m) => m.type === 'tool-result' && m.toolName === 'subagent') as any[];
  const repA = reports.find((m) => m.callId === 'subagent:kid-A');
  const repB = reports.find((m) => m.callId === 'subagent:kid-B');
  check('subagent: the child report is preserved as a `subagent` tool-result', reports.length === 2 && repA?.result === 'Found.' && repB?.result === 'Patched.', `reports=${JSON.stringify(reports.map((r) => ({ id: r.callId, t: r.title, res: r.result })))}`);
  // idempotence: re-waiting an already-resolved child must NOT duplicate its report or bar.
  const dupWait = mapRollout([
    ...lines,
    { type: 'response_item', payload: { type: 'function_call', name: 'wait_agent', call_id: 'cw3', arguments: JSON.stringify({ ids: ['kid-A'] }) }, timestamp: '2026-03-20T23:47:00.000Z' },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'cw3', output: JSON.stringify({ status: { 'kid-A': { completed: 'Found again.' } } }) }, timestamp: '2026-03-20T23:47:10.000Z' },
  ]) as any[];
  const aReports = dupWait.filter((m) => m.type === 'tool-result' && m.callId === 'subagent:kid-A');
  check('subagent: re-waiting a resolved child does not duplicate its report/bar (idempotent)', aReports.length === 1 && aReports[0].result === 'Found.', `aReports=${aReports.length}`);
}

// ── 1i. a timed-out wait_agent (empty status) is reaped at turn end (no stuck "running" bar) ──────
{
  const lines = [
    { type: 'session_meta', payload: { cwd: '/tmp/x', id: 'parent-timeout' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' }, timestamp: '2026-03-20T23:45:00.000Z' },
    { type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'cs1', arguments: JSON.stringify({ agent_type: 'explorer', message: 'go' }) }, timestamp: '2026-03-20T23:45:01.000Z' },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'cs1', output: JSON.stringify({ agent_id: 'kid-T', nickname: 'Aquinas' }) }, timestamp: '2026-03-20T23:45:02.000Z' },
    // wait TIMES OUT → empty status map, child never resolved here
    { type: 'response_item', payload: { type: 'function_call', name: 'wait_agent', call_id: 'cw1', arguments: JSON.stringify({ ids: ['kid-T'], timeout_ms: 1000 }) }, timestamp: '2026-03-20T23:45:30.000Z' },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'cw1', output: JSON.stringify({ status: {}, timed_out: true }) }, timestamp: '2026-03-20T23:45:31.000Z' },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' }, timestamp: '2026-03-20T23:46:00.000Z' },
  ];
  const out = mapRollout(lines) as any[];
  const acts = out.filter((m) => m.type === 'agent-activity');
  const final = new Map<string, any>();
  for (const a of acts) final.set(a.key, a);
  const T = final.get('agent:kid-T');
  check('subagent: a timed-out child is reaped to a terminal state at task_complete (not stuck running)', T?.status === 'done', `final Aquinas=${JSON.stringify(T)}`);
}

// ── 1j. token_count → contextUsage metadata (the context meter's only data source) ──────
// Each case below is a trap verified against ~42k real rollout events; getting any of them wrong
// produces a plausible-looking but wrong meter, which is worse than showing none.
{
  const ctxOf = (info: any) => {
    const lines = [{ type: 'event_msg', payload: { type: 'token_count', info } }];
    return (mapRollout(lines) as any[]).find((m) => m.type === 'metadata-update' && m.key === 'contextUsage');
  };

  const usage = (input: number, cached: number, output: number, total?: number) => ({
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: total ?? input + output,
  });

  const basic = ctxOf({ last_token_usage: usage(9013, 7872, 217), total_token_usage: usage(9013, 7872, 217), model_context_window: 972800 });
  check(
    'contextUsage used = last input+output (cached_input_tokens is a SUBSET here, never added)',
    basic?.value?.used === 9230 && basic?.value?.max === 972800,
    JSON.stringify(basic?.value),
  );

  // The 0-1 vs 0-100 bug class: 9230/972800 is ~0.95%, and must stay under 1 — never 95%.
  const pct = (basic!.value.used / basic!.value.max) * 100;
  check('contextUsage stays a true ratio (0.95%, not 95%)', pct > 0.9 && pct < 1.0, `${pct.toFixed(3)}%`);

  // total_token_usage accumulates across the whole session and reached 160406% of the window on a
  // real measured session; only last_token_usage is resident, so the cumulative bucket must be ignored.
  const cumulative = ctxOf({ last_token_usage: usage(26000, 20000, 832), total_token_usage: usage(414_000_000, 0, 489_505), model_context_window: 258400 });
  check(
    'contextUsage ignores the cumulative total_token_usage and reads last_token_usage',
    cumulative?.value?.used === 26832,
    JSON.stringify(cumulative?.value),
  );

  // Observed sentinel: every bucket zero while total_tokens equals the window → a false 100%.
  const sentinel = ctxOf({ last_token_usage: usage(0, 0, 0, 121600), total_token_usage: usage(0, 0, 0, 121600), model_context_window: 121600 });
  check('contextUsage skips the all-zero sentinel row rather than reporting 100%', sentinel === undefined, JSON.stringify(sentinel));

  check('contextUsage omitted when the window size is unknown', ctxOf({ last_token_usage: usage(100, 0, 20) }) === undefined);
  check('contextUsage omitted when last_token_usage is absent', ctxOf({ total_token_usage: usage(100, 0, 20), model_context_window: 200000 }) === undefined);
  check(
    'token-count still emitted alongside contextUsage (cost/telemetry path unchanged)',
    (mapRollout([{ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(10, 2, 5), last_token_usage: usage(10, 2, 5), model_context_window: 1000 } } }]) as any[]).filter((m) => m.type === 'token-count').length === 1,
  );
}

// ── 1k. Codex 0.146 assistant compatibility: new-only, old-only, dual ─────────────
// Codex 0.146 writes item_completed + response_item/message and may omit the legacy
// event_msg/agent_message entirely. These fixtures copy only that public record shape; no path or
// text from the maintainer's recorded sessions enters the repository.
await (async () => {
  type AssistantEmission = 'new-only' | 'old-only' | 'dual';
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;
  const assistantRows = (
    emission: AssistantEmission,
    id: string,
    text: string,
    phase: 'commentary' | 'final_answer',
  ): any[] => {
    const legacy = {
      type: 'event_msg',
      payload: { type: 'agent_message', message: text, phase },
    };
    const response = {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        id,
        phase,
        content: [{ type: 'output_text', text }],
      },
    };
    switch (emission) {
      case 'new-only':
        return [
          { type: 'event_msg', payload: { type: 'item_completed' } },
          response,
        ];
      case 'old-only':
        return [legacy];
      case 'dual':
        return [legacy, response];
    }
  };
  const transcript = (messages: any[]) => messages.filter((message) =>
    message.type === 'model-output'
      || message.type === 'tool-call'
      || message.type === 'tool-result');
  const signature = (messages: any[]) => transcript(messages).map((message) =>
    message.type === 'model-output'
      ? `${message.type}:${message.text}`
      : `${message.type}:${message.callId}`);

  for (const emission of ['new-only', 'old-only', 'dual'] as const) {
    const dir = join(
      '/tmp',
      `cosyncing-codex-0146-${emission}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(dir, { recursive: true });
    const path = join(
      dir,
      'rollout-2026-08-10T00-00-00-00000000-0000-4000-8000-000000000146.jsonl',
    );
    const coldRows = [
      { type: 'session_meta', payload: { id: '00000000-0000-4000-8000-000000000146', cwd: dir } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: `cold-${emission}` } },
      ...assistantRows(emission, `msg_cold_${emission}`, 'Cold answer.', 'commentary'),
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: `call_cold_${emission}`, arguments: '{}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: `call_cold_${emission}`, output: 'ok' } },
      ...assistantRows(emission, `msg_cold_final_${emission}`, 'Cold final.', 'final_answer'),
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: `cold-${emission}` } },
    ];
    writeFileSync(path, coldRows.map(line).join(''));

    const id = Buffer.from(path, 'utf8').toString('base64url');
    const conn = await new CodexAdapter().attach(id, 'observe');
    const liveMessages: any[] = [];
    const unsubscribe = conn.subscribe((message: any) => liveMessages.push(message));
    try {
      const first = await conn.getHistory() as any[];
      const coldSignature = signature(first);
      check(
        `Codex 0.146 ${emission} cold history keeps assistant text and tools in order`,
        JSON.stringify(coldSignature) === JSON.stringify([
          'model-output:Cold answer.',
          `tool-call:call_cold_${emission}`,
          `tool-result:call_cold_${emission}`,
          'model-output:Cold final.',
        ]),
        JSON.stringify(coldSignature),
      );
      const coldAnswers = first.filter((message) => message.type === 'model-output');
      check(
        `Codex 0.146 ${emission} cold history emits each assistant item exactly once`,
        coldAnswers.length === 2 && new Set(coldAnswers.map((message) => message.key)).size === 2,
        JSON.stringify(coldAnswers.map((message) => message.key)),
      );
      const repeated = (await conn.getHistory() as any[])
        .filter((message) => message.type === 'model-output')
        .map((message) => message.key);
      check(
        `Codex 0.146 ${emission} cold replay keeps stable assistant keys`,
        JSON.stringify(repeated) === JSON.stringify(coldAnswers.map((message) => message.key)),
        JSON.stringify(repeated),
      );

      appendFileSync(
        path,
        [
          { type: 'event_msg', payload: { type: 'task_started', turn_id: `live-${emission}` } },
          ...assistantRows(emission, `msg_live_${emission}`, 'Live answer.', 'commentary'),
          { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: `call_live_${emission}`, arguments: '{}' } },
          { type: 'response_item', payload: { type: 'function_call_output', call_id: `call_live_${emission}`, output: 'ok' } },
          ...assistantRows(emission, `msg_live_final_${emission}`, 'Live final.', 'final_answer'),
          { type: 'event_msg', payload: { type: 'task_complete', turn_id: `live-${emission}` } },
        ].map(line).join(''),
      );
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline && transcript(liveMessages).length < 4) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const liveSignature = signature(liveMessages);
      check(
        `Codex 0.146 ${emission} live follow keeps assistant text and tools in order`,
        JSON.stringify(liveSignature) === JSON.stringify([
          'model-output:Live answer.',
          `tool-call:call_live_${emission}`,
          `tool-result:call_live_${emission}`,
          'model-output:Live final.',
        ]),
        JSON.stringify(liveSignature),
      );
      const liveAnswers = liveMessages.filter((message) => message.type === 'model-output');
      check(
        `Codex 0.146 ${emission} live follow emits each assistant item exactly once`,
        liveAnswers.length === 2 && new Set(liveAnswers.map((message) => message.key)).size === 2,
        JSON.stringify(liveAnswers.map((message) => message.key)),
      );
      const replay = (await conn.getHistory() as any[])
        .filter((message) => message.type === 'model-output');
      check(
        `Codex 0.146 ${emission} live and replay assistant keys agree`,
        JSON.stringify(replay.slice(-2).map((message) => message.key))
          === JSON.stringify(liveAnswers.map((message) => message.key)),
        `history=${JSON.stringify(replay.slice(-2).map((message) => message.key))} live=${JSON.stringify(liveAnswers.map((message) => message.key))}`,
      );
    } finally {
      unsubscribe();
      await conn.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
})();

// ── 1k2. Codex 0.147 user-message compatibility: item_completed/UserMessage ─────────────
// Codex 0.147 stopped writing `event_msg/user_message`: the prompt's only durable event is now
// `item_completed` whose `item.type` is `UserMessage` (it carries `turn_id`, a native item id, and
// `content: [{type:'text', …}]`), while `response_item/message` `role:'user'` still also carries
// bootstrap/developer context that is NOT the prompt. These fixtures copy only that public record
// shape; no path or text from the maintainer's recorded sessions enters the repository.
{
  // The durable prompt pair exactly as 0.147 writes it: the (ignored) response_item twin, then the
  // authoritative completed item. `started_at_ms` is a fixed sanitized epoch, not a recorded one.
  const userItemRows = (turnId: string, itemId: string, text: string, extraContent: any[] = []) => [
    { type: 'response_item', payload: { type: 'message', role: 'user', id: itemId, content: [{ type: 'input_text', text }] } },
    {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: '00000000-0000-4000-8000-000000000147',
        turn_id: turnId,
        started_at_ms: 1_755_200_000_000,
        completed_at_ms: 1_755_200_000_001,
        item: { type: 'UserMessage', id: itemId, content: [{ type: 'text', text, text_elements: [] }, ...extraContent] },
      },
    },
  ];
  const assistantRows147 = (turnId: string, itemId: string, text: string) => [
    { type: 'event_msg', payload: { type: 'item_completed', thread_id: '00000000-0000-4000-8000-000000000147', turn_id: turnId, item: { type: 'AgentMessage', id: itemId, content: [{ type: 'Text', text }], phase: 'final_answer' } } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', id: itemId, phase: 'final_answer', content: [{ type: 'output_text', text }] } },
  ];
  const turn147 = (turnId: string, prompt: string, ordinalTag: string) => [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
    { type: 'response_item', payload: { type: 'message', role: 'developer', id: `dev_${ordinalTag}`, content: [{ type: 'input_text', text: 'bootstrap developer context' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', id: `boot_${ordinalTag}`, content: [{ type: 'input_text', text: 'bootstrap environment context' }] } },
    { type: 'turn_context', payload: { turn_id: turnId, model: 'gpt-5.3-codex-spark' } },
    ...userItemRows(turnId, `item_${ordinalTag}`, prompt),
    ...assistantRows147(turnId, `msg_${ordinalTag}`, `answer ${ordinalTag}`),
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } },
  ];
  const promptsOf = (out: any[]) => out.filter((m: any) => m.type === 'user-message');

  {
    // New-only format — the 0.147 regression itself. Before the item_completed/UserMessage case
    // this mapped to ZERO user rows (the bootstrap response_item is rightly ignored, the legacy
    // event never arrives), which is exactly the observed failure: assistant output without the
    // prompt that caused it.
    const out = mapRollout([
      { type: 'session_meta', payload: { id: '00000000-0000-4000-8000-000000000147', cwd: '/tmp/x' } },
      ...turn147('t147', 'new-format prompt', 'a0'),
    ]) as any[];
    const prompts = promptsOf(out);
    check(
      'Codex 0.147 new-only: item_completed/UserMessage maps to exactly one user-message',
      prompts.length === 1 && prompts[0].text === 'new-format prompt',
      JSON.stringify(prompts.map((p: any) => [p.key, p.text])),
    );
    check(
      'Codex 0.147 new-only: the prompt rebuilds the canonical (turn, ordinal) identity',
      prompts[0]?.key === 'codex:t147:u0' && prompts[0]?.turnId === 't147',
      JSON.stringify(prompts[0]),
    );
    check(
      'Codex 0.147 new-only: sentAt falls back to the completed item\'s started_at_ms',
      prompts[0]?.sentAt === 1_755_200_000_000,
      JSON.stringify(prompts[0]?.sentAt),
    );
    const done = out.find((m: any) => m.type === 'run-summary' && m.status === 'done');
    check(
      'Codex 0.147 new-only: the terminal run summary names the canonical opening prompt key',
      done?.userMessageKey === 'codex:t147:u0',
      JSON.stringify(done?.userMessageKey),
    );
    const answers = out.filter((m: any) => m.type === 'model-output');
    check(
      'Codex 0.147 new-only: item_completed/AgentMessage stays ignored (answer emitted once)',
      answers.length === 1 && answers[0].key === 'codex:t147:msg_a0:t',
      JSON.stringify(answers.map((m: any) => m.key)),
    );
  }

  {
    // Bootstrap-only: response_item role:user context with NO authoritative user completion must
    // not fabricate a prompt bubble — the measured rollout has two role:user response items but
    // only one real prompt.
    const out = mapRollout([
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'tboot' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', id: 'boot_only', content: [{ type: 'input_text', text: 'bootstrap environment context' }] } },
      ...assistantRows147('tboot', 'msg_boot', 'unprompted answer'),
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'tboot' } },
    ]) as any[];
    check(
      'Codex 0.147 bootstrap response_item role:user alone fabricates no user bubble',
      promptsOf(out).length === 0,
      JSON.stringify(promptsOf(out)),
    );
  }

  {
    // Legacy-only stays exactly as before this lane.
    const out = mapRollout([
      { type: 'turn_context', payload: { turn_id: 'tleg' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'tleg' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'legacy prompt' }] } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'legacy prompt' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'ok', phase: 'final_answer' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'msg_leg', phase: 'final_answer', content: [{ type: 'output_text', text: 'ok' }] } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'tleg' } },
    ]) as any[];
    const prompts = promptsOf(out);
    check(
      'Codex 0.147 legacy-only keeps exactly one user-message with the same identity as before',
      prompts.length === 1 && prompts[0].key === 'codex:tleg:u0' && prompts[0].text === 'legacy prompt',
      JSON.stringify(prompts.map((p: any) => p.key)),
    );
  }

  {
    // Hypothetical dual format: one prompt written in BOTH durable forms must stay one row —
    // in either order — while the pairing never crosses forms' boundaries wider than the
    // prompt's own records.
    for (const order of ['legacy-first', 'item-first'] as const) {
      const twin = { type: 'response_item', payload: { type: 'message', role: 'user', id: 'item_dual', content: [{ type: 'input_text', text: 'dual prompt' }] } };
      const legacy = { type: 'event_msg', payload: { type: 'user_message', message: 'dual prompt' } };
      const item = {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          turn_id: 'tdual',
          started_at_ms: 1_755_200_000_000,
          completed_at_ms: 1_755_200_000_001,
          item: { type: 'UserMessage', id: 'item_dual', content: [{ type: 'text', text: 'dual prompt', text_elements: [] }] },
        },
      };
      const out = mapRollout([
        { type: 'turn_context', payload: { turn_id: 'tdual' } },
        { type: 'event_msg', payload: { type: 'task_started', turn_id: 'tdual' } },
        ...(order === 'legacy-first' ? [twin, legacy, item] : [twin, item, legacy]),
        ...assistantRows147('tdual', 'msg_dual', 'ok'),
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'tdual' } },
      ]) as any[];
      const prompts = promptsOf(out);
      const done = out.find((m: any) => m.type === 'run-summary' && m.status === 'done');
      check(
        `Codex 0.147 dual format (${order}) emits one logical user-message`,
        prompts.length === 1 && prompts[0].key === 'codex:tdual:u0' && prompts[0].text === 'dual prompt',
        JSON.stringify(prompts.map((p: any) => p.key)),
      );
      check(
        `Codex 0.147 dual format (${order}) run summary still owns the canonical opening key`,
        done?.userMessageKey === 'codex:tdual:u0',
        JSON.stringify(done?.userMessageKey),
      );
    }
  }

  {
    // TWO SEPARATE identical prompts — one legacy, one new-format, each preceded by its own
    // response_item twin — must stay two rows. The twin after a durable form means a second
    // prompt's representation is opening, so it must disarm the dual-format pairing; an earlier
    // draft let a byte-equal twin bridge the pairing and collapsed this sequence into one row.
    const out = mapRollout([
      { type: 'turn_context', payload: { turn_id: 'tsep' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'tsep' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'same' }] } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'same' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', id: 'item_sep', content: [{ type: 'input_text', text: 'same' }] } },
      { type: 'event_msg', payload: { type: 'item_completed', turn_id: 'tsep', started_at_ms: 1_755_200_000_000, completed_at_ms: 1_755_200_000_001, item: { type: 'UserMessage', id: 'item_sep', content: [{ type: 'text', text: 'same', text_elements: [] }] } } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'tsep' } },
    ]) as any[];
    const prompts = promptsOf(out);
    check(
      'Codex 0.147 a legacy prompt and a separate identical new-format prompt stay u0 and u1',
      prompts.length === 2 && prompts[0].key === 'codex:tsep:u0' && prompts[1].key === 'codex:tsep:u1',
      JSON.stringify(prompts.map((p: any) => p.key)),
    );
  }

  {
    // Unknown-turn evidence never suppresses: a durable form whose enclosing turn cannot be
    // matched to the other form's exact turn is not proof of one prompt, in either direction.
    const legacyFirst = mapRollout([
      { type: 'event_msg', payload: { type: 'user_message', message: 'orphan' } },
      { type: 'event_msg', payload: { type: 'item_completed', turn_id: 'tx', item: { type: 'UserMessage', id: 'item_x', content: [{ type: 'text', text: 'orphan', text_elements: [] }] } } },
    ]) as any[];
    const itemFirst = mapRollout([
      { type: 'event_msg', payload: { type: 'item_completed', turn_id: 'ty', item: { type: 'UserMessage', id: 'item_y', content: [{ type: 'text', text: 'orphan', text_elements: [] }] } } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'orphan' } },
    ]) as any[];
    check(
      'Codex 0.147 a turn-less legacy prompt is never paired away by an adjacent completed item',
      promptsOf(legacyFirst).length === 2,
      JSON.stringify(promptsOf(legacyFirst).map((p: any) => p.key)),
    );
    check(
      'Codex 0.147 a completed item never pairs away an adjacent legacy prompt outside its turn',
      promptsOf(itemFirst).length === 2,
      JSON.stringify(promptsOf(itemFirst).map((p: any) => p.key)),
    );
  }

  {
    // Identity stays structural in the new format too: the same bytes sent in two different turns
    // are two prompts with two distinct canonical keys.
    const out = mapRollout([
      ...turn147('t147a', 'same text', 'b1'),
      ...turn147('t147b', 'same text', 'b2'),
    ]) as any[];
    const prompts = promptsOf(out);
    check(
      'Codex 0.147 two byte-identical prompts in different turns keep two distinct keys',
      prompts.length === 2 && prompts[0].key === 'codex:t147a:u0' && prompts[1].key === 'codex:t147b:u0',
      JSON.stringify(prompts.map((p: any) => p.key)),
    );
  }

  {
    // A mid-turn steer in the new format keeps its own ordinal — even byte-identical and adjacent
    // to the opening prompt, which is the sharpest guard that dual-format pairing never becomes a
    // text merge (same form twice is two real prompts, never a pair).
    const out = mapRollout([
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'tsteer' } },
      { type: 'turn_context', payload: { turn_id: 'tsteer' } },
      ...userItemRows('tsteer', 'item_s0', 'do the thing'),
      ...userItemRows('tsteer', 'item_s1', 'do the thing'),
      ...assistantRows147('tsteer', 'msg_steer', 'ok'),
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'tsteer' } },
    ]) as any[];
    const prompts = promptsOf(out);
    const done = out.find((m: any) => m.type === 'run-summary' && m.status === 'done');
    check(
      'Codex 0.147 opening prompt and mid-turn steer keep ordinals u0 and u1',
      prompts.length === 2 && prompts[0].key === 'codex:tsteer:u0' && prompts[1].key === 'codex:tsteer:u1',
      JSON.stringify(prompts.map((p: any) => p.key)),
    );
    check(
      'Codex 0.147 steered turn is still owned by the prompt that opened it',
      done?.userMessageKey === 'codex:tsteer:u0',
      JSON.stringify(done?.userMessageKey),
    );
  }

  {
    // Image content in the completed item keeps the live path's image-count behavior
    // (`local_image` is the rollout spelling of the app-server's `localImage`).
    const out = mapRollout([
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'timg' } },
      ...userItemRows('timg', 'item_img', 'look at this', [{ type: 'local_image', path: '/tmp/fixture.png' }]),
    ]) as any[];
    const prompt = promptsOf(out)[0];
    check(
      'Codex 0.147 completed item image content maps to imageCount',
      prompt?.imageCount === 1 && prompt?.text === 'look at this\n[image]',
      JSON.stringify(prompt),
    );
  }
}

// ── 1k3. Codex 0.147 history/live-tail overlap: one prompt, one identity across both ─────
await (async () => {
  const dir = join('/tmp', `cosyncing-codex-0147-tail-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'rollout-2026-08-15T00-00-00-00000000-0000-4000-8000-000000000147.jsonl');
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;
  writeFileSync(
    path,
    line({ type: 'session_meta', payload: { id: '00000000-0000-4000-8000-000000000147', cwd: dir } }) +
      line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't147live' } }),
  );

  const messages: any[] = [];
  const conn = await new CodexAdapter().attach(Buffer.from(path, 'utf8').toString('base64url'), 'observe');
  const unsubscribe = conn.subscribe((m: any) => messages.push(m));
  const prompts = () => messages.filter((m: any) => m.type === 'user-message');
  const settle = async (predicate: () => boolean, ms: number) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return predicate();
  };

  try {
    appendFileSync(
      path,
      [
        { type: 'turn_context', payload: { turn_id: 't147live', model: 'gpt-5.3-codex-spark' } },
        { type: 'response_item', payload: { type: 'message', role: 'user', id: 'item_live', content: [{ type: 'input_text', text: 'tailed prompt' }] } },
        { type: 'event_msg', payload: { type: 'item_completed', turn_id: 't147live', started_at_ms: 1_755_200_000_000, completed_at_ms: 1_755_200_000_001, item: { type: 'UserMessage', id: 'item_live', content: [{ type: 'text', text: 'tailed prompt', text_elements: [] }] } } },
        { type: 'event_msg', payload: { type: 'item_completed', turn_id: 't147live', item: { type: 'AgentMessage', id: 'msg_live147', content: [{ type: 'Text', text: 'tailed answer' }], phase: 'final_answer' } } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'msg_live147', phase: 'final_answer', content: [{ type: 'output_text', text: 'tailed answer' }] } },
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't147live' } },
      ].map(line).join(''),
    );
    const tailed = await settle(() => prompts().length > 0 && messages.some((m: any) => m.type === 'run-summary' && m.status === 'done'), 4000);
    check(
      'Codex 0.147 live tail emits the new-format prompt once with the canonical identity',
      tailed && prompts().length === 1 && prompts()[0].key === 'codex:t147live:u0',
      JSON.stringify(prompts().map((p: any) => p.key)),
    );
    const doneLive = messages.find((m: any) => m.type === 'run-summary' && m.status === 'done');
    check(
      'Codex 0.147 live tail terminal summary owns the tailed prompt',
      doneLive?.userMessageKey === 'codex:t147live:u0',
      JSON.stringify(doneLive?.userMessageKey),
    );
    const replayPrompts = ((await conn.getHistory()) as any[]).filter((m: any) => m.type === 'user-message');
    check(
      'Codex 0.147 history replay re-derives the exact key the tail already published',
      replayPrompts.length === 1 && replayPrompts[0].key === prompts()[0]?.key,
      `history=${JSON.stringify(replayPrompts.map((p: any) => p.key))} live=${JSON.stringify(prompts().map((p: any) => p.key))}`,
    );
  } finally {
    unsubscribe();
    await conn.close();
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ── 1b. live tail identity (CR4): the tail must decide identity exactly as a whole-file map does ──
// The native id lives on the record AFTER the assistant event, which a tail has not read yet when it
// reaches the event. Emitting immediately would key the same line differently here than getHistory()
// does for anyone attaching later — the two would then be two messages in one client's transcript.
await (async () => {
  const dir = join('/tmp', `cosyncing-codex-tail-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'rollout-2026-07-25T00-00-00-00000000-0000-4000-8000-00000000000a.jsonl');
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;
  writeFileSync(
    path,
    line({ type: 'session_meta', payload: { id: '00000000-0000-4000-8000-00000000000a', cwd: dir } }) +
      line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't-tail' } }),
  );

  const messages: any[] = [];
  const conn = await new CodexAdapter().attach(Buffer.from(path, 'utf8').toString('base64url'), 'observe');
  const unsubscribe = conn.subscribe((m: any) => messages.push(m));
  const answers = () => messages.filter((m) => m.type === 'model-output');
  const settle = async (predicate: () => boolean, ms: number) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return predicate();
  };

  try {
    // Codex appends the pair together, so one drain sees both — deferral resolves with no delay.
    appendFileSync(
      path,
      line({ type: 'event_msg', payload: { type: 'agent_message', message: 'Tailed.', phase: 'final_answer' } }) +
        line({ type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'msg_tail', phase: 'final_answer', content: [{ type: 'output_text', text: 'Tailed.' }] } }),
    );
    const tailed = await settle(() => answers().length > 0, 4000);
    check(
      'a tailed answer adopts the paired native identity, not the line index',
      tailed && answers()[0].key === 'codex:t-tail:msg_tail:t',
      JSON.stringify(answers()[0] ?? null),
    );

    // The same line, mapped by a fresh whole-file read: both surfaces must agree, or a client that
    // attaches later stores this answer under a second identity.
    const replayed = (mapRollout(
      readFileSync(path, 'utf8').split('\n').filter(Boolean).map((s) => JSON.parse(s)),
    ) as any[]).filter((m) => m.type === 'model-output');
    check(
      'the tail and a fresh history read agree on that identity',
      replayed.length === 1 && replayed[0].key === answers()[0]?.key,
      `history=${replayed[0]?.key} tail=${answers()[0]?.key}`,
    );

    // An answer whose paired record never arrives is emitted anyway: a differing key costs a
    // duplicate, a withheld line costs the text itself.
    appendFileSync(path, line({ type: 'event_msg', payload: { type: 'agent_message', message: 'Never paired.', phase: 'commentary' } }));
    const flushed = await settle(() => answers().length > 1, 4000);
    check(
      'an unpaired tailed answer is still emitted, on the line-index fallback',
      flushed && answers()[1]?.key === 'c4' && answers()[1]?.text === 'Never paired.',
      JSON.stringify(answers()[1] ?? null),
    );
  } finally {
    unsubscribe();
    await conn.close();
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ── 1b2. a blank slot between the pair is not an answer about what followed ──
// The tail advances its index for every newline segment, parseable or not. Settling a held line on a
// null slot would key that answer by line index while the app-server delivers it natively — the same
// duplicate, reached by a different route.
await (async () => {
  const dir = join('/tmp', `cosyncing-codex-tail-blank-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'rollout-2026-07-25T00-00-00-00000000-0000-4000-8000-000000000010.jsonl');
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;
  writeFileSync(
    path,
    line({ type: 'session_meta', payload: { id: '00000000-0000-4000-8000-000000000010', cwd: dir } }) +
      line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't-blank' } }),
  );

  const messages: any[] = [];
  const conn = await new CodexAdapter().attach(Buffer.from(path, 'utf8').toString('base64url'), 'observe');
  const unsubscribe = conn.subscribe((m: any) => messages.push(m));
  const answers = () => messages.filter((m) => m.type === 'model-output');
  try {
    appendFileSync(
      path,
      line({ type: 'event_msg', payload: { type: 'agent_message', message: 'Blanked.', phase: 'final_answer' } }) +
        '\n' +
        line({ type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'msg_blank', phase: 'final_answer', content: [{ type: 'output_text', text: 'Blanked.' }] } }),
    );
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && answers().length === 0) await new Promise((r) => setTimeout(r, 25));
    check(
      'a blank slot does not settle a held tail line: the pair behind it is still adopted',
      answers()[0]?.key === 'codex:t-blank:msg_blank:t' && answers()[0]?.text === 'Blanked.',
      JSON.stringify(answers()[0] ?? null),
    );
    const replayed = ((await conn.getHistory()) as any[]).filter((m) => m.type === 'model-output');
    check(
      'and a history read of that same file agrees',
      replayed.length === 1 && replayed[0].key === answers()[0]?.key,
      `history=${replayed[0]?.key} tail=${answers()[0]?.key}`,
    );
  } finally {
    unsubscribe();
    await conn.close();
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ── 1c. the tail's primed turn must be an ACTIVE turn, not merely the last one seen ──
// Attaching to a rollout whose last turn already finished leaves NO turn in effect. A record that
// arrives afterwards belongs to no turn the app-server is delivering under, so keying it by the
// completed turn would mint an identity no live frame ever used.
await (async () => {
  const dir = join('/tmp', `cosyncing-codex-tail-done-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'rollout-2026-07-25T00-00-00-00000000-0000-4000-8000-00000000000b.jsonl');
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;
  writeFileSync(
    path,
    line({ type: 'session_meta', payload: { id: '00000000-0000-4000-8000-00000000000b', cwd: dir } }) +
      line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't-done' } }) +
      line({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't-done' } }),
  );

  const messages: any[] = [];
  const conn = await new CodexAdapter().attach(Buffer.from(path, 'utf8').toString('base64url'), 'observe');
  const unsubscribe = conn.subscribe((m: any) => messages.push(m));
  const answers = () => messages.filter((m) => m.type === 'model-output');
  try {
    appendFileSync(
      path,
      line({ type: 'event_msg', payload: { type: 'agent_message', message: 'Stray.', phase: 'commentary' } }) +
        line({ type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'msg_stray', content: [{ type: 'output_text', text: 'Stray.' }] } }),
    );
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && answers().length === 0) await new Promise((r) => setTimeout(r, 25));
    check(
      'a tail primed after the last turn completed falls back instead of reviving that turn',
      answers()[0]?.key === 'c3' && answers()[0]?.text === 'Stray.',
      JSON.stringify(answers()[0] ?? null),
    );
    // Same rule from the other surface, so the two never disagree about this line.
    const replayed = (mapRollout(
      readFileSync(path, 'utf8').split('\n').filter(Boolean).map((s) => JSON.parse(s)),
    ) as any[]).filter((m) => m.type === 'model-output');
    check(
      'a fresh history read agrees that a post-completion record has no turn',
      replayed.length === 1 && replayed[0].key === 'c3',
      `history=${replayed[0]?.key}`,
    );
  } finally {
    unsubscribe();
    await conn.close();
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ── 1d. getHistory() at the pair boundary (CR4): the narrow duplicate window ──
// Codex writes the assistant event and its paired response item as two appends. A history read that
// lands between them sees only the event, would key it by line index, and the joining client would
// then hold the SAME answer twice — once under `c<n>` and once under the native key the live
// app-server is still delivering it with. History waits out that gap while the file is being written.
await (async () => {
  const dir = join('/tmp', `cosyncing-codex-history-race-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'rollout-2026-07-25T00-00-00-00000000-0000-4000-8000-00000000000c.jsonl');
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;
  writeFileSync(
    path,
    line({ type: 'session_meta', payload: { id: '00000000-0000-4000-8000-00000000000c', cwd: dir } }) +
      line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't-race' } }),
  );

  const conn = await new CodexAdapter().attach(Buffer.from(path, 'utf8').toString('base64url'), 'observe');
  try {
    // The turn's answer is persisted; the record carrying its native id has not been appended yet.
    appendFileSync(path, line({ type: 'event_msg', payload: { type: 'agent_message', message: 'Raced.', phase: 'final_answer' } }));
    const pending = conn.getHistory(); // a client attaches INSIDE the gap
    await new Promise((r) => setTimeout(r, 60)); // comfortably inside the wait, which is sized to the append itself
    appendFileSync(path, line({ type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'msg_race', phase: 'final_answer', content: [{ type: 'output_text', text: 'Raced.' }] } }));

    const answers = ((await pending) as any[]).filter((m) => m.type === 'model-output');
    check(
      "a history read landing between the pair's two appends still resolves the native identity",
      answers.length === 1 && answers[0].key === 'codex:t-race:msg_race:t' && answers[0].text === 'Raced.',
      JSON.stringify(answers.map((m) => m.key)),
    );
  } finally {
    await conn.close();
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ── 1e. …and that wait must cost a SETTLED session nothing ──
// Assistant records that are never paired at all (all mid-turn commentary, and carrying no native id
// anywhere) end 21 of 117 real sessions. Attaching to a settled one must map immediately, so the wait
// is gated on the file still being written rather than on the record's shape alone.
await (async () => {
  const dir = join('/tmp', `cosyncing-codex-history-idle-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'rollout-2026-07-25T00-00-00-00000000-0000-4000-8000-00000000000d.jsonl');
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;
  writeFileSync(
    path,
    line({ type: 'session_meta', payload: { id: '00000000-0000-4000-8000-00000000000d', cwd: dir } }) +
      line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't-idle' } }) +
      line({ type: 'event_msg', payload: { type: 'agent_message', message: 'Never paired.', phase: 'commentary' } }),
  );
  const stale = new Date(Date.now() - 60_000);
  utimesSync(path, stale, stale);

  const conn = await new CodexAdapter().attach(Buffer.from(path, 'utf8').toString('base64url'), 'observe');
  try {
    const started = Date.now();
    const answers = ((await conn.getHistory()) as any[]).filter((m) => m.type === 'model-output');
    const elapsed = Date.now() - started;
    check(
      'a settled rollout ending on a never-paired record maps immediately, on the fallback key',
      answers.length === 1 && answers[0].key === 'c2' && elapsed < 250,
      `key=${answers[0]?.key} elapsedMs=${elapsed}`,
    );
  } finally {
    await conn.close();
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ── 1f. the LIVE branch of that wait, which is the one an active session actually pays ──
// A rollout being written right now that ends on a never-paired record cannot break out early: the
// mtime gate says "still appending", so the read polls until the bound. That is the branch every
// attach AND every older-page prepend on a live session pays (handleHistoryPage re-reads history), so
// the bound has to be measured here, not only on the stale-mtime path that returns immediately.
await (async () => {
  const dir = join('/tmp', `cosyncing-codex-history-live-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'rollout-2026-07-25T00-00-00-00000000-0000-4000-8000-00000000000e.jsonl');
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;
  writeFileSync(
    path,
    line({ type: 'session_meta', payload: { id: '00000000-0000-4000-8000-00000000000e', cwd: dir } }) +
      line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't-live' } }) +
      line({ type: 'event_msg', payload: { type: 'agent_message', message: 'Never paired.', phase: 'commentary' } }),
  );
  // mtime is NOW, so nothing short-circuits the poll — this is the full-cost path.

  const conn = await new CodexAdapter().attach(Buffer.from(path, 'utf8').toString('base64url'), 'observe');
  try {
    const started = Date.now();
    const answers = ((await conn.getHistory()) as any[]).filter((m) => m.type === 'model-output');
    const elapsed = Date.now() - started;
    check(
      'an actively-written rollout ending on a never-paired record still maps within the bound',
      answers.length === 1 && answers[0].key === 'c2' && elapsed < 400,
      `key=${answers[0]?.key} elapsedMs=${elapsed}`,
    );
  } finally {
    await conn.close();
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ── 1g. one connection, one identity per line — even when the pair is split wider than the wait ──
// The tail's deferral timer and a history read's settle deadline are separate clocks. Split the pair
// by more than the bound and they decide differently: the tail flushes the fallback, and a later
// getHistory() of the now-settled file would resolve the native key. That is one answer under two
// identities in ONE client's transcript. Whichever surface published first has to bind the other.
await (async () => {
  const dir = join('/tmp', `cosyncing-codex-split-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'rollout-2026-07-25T00-00-00-00000000-0000-4000-8000-00000000000f.jsonl');
  const id = Buffer.from(path, 'utf8').toString('base64url');
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;
  writeFileSync(
    path,
    line({ type: 'session_meta', payload: { id: '00000000-0000-4000-8000-00000000000f', cwd: dir } }) +
      line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't-split' } }),
  );

  const messages: any[] = [];
  const conn = await new CodexAdapter().attach(id, 'observe');
  const unsubscribe = conn.subscribe((m: any) => messages.push(m));
  const answers = () => messages.filter((m) => m.type === 'model-output');
  const settle = async (predicate: () => boolean, ms: number) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return predicate();
  };

  try {
    appendFileSync(path, line({ type: 'event_msg', payload: { type: 'agent_message', message: 'Split answer.', phase: 'final_answer' } }));
    const flushed = await settle(() => answers().length > 0, 4000);
    check(
      'a pair split past the wait flushes the tailed answer on the fallback rather than withholding it',
      flushed && answers()[0]?.key === 'c2' && answers()[0]?.text === 'Split answer.',
      JSON.stringify(answers()[0] ?? null),
    );

    // …and only now does the record carrying the native id land.
    appendFileSync(path, line({ type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'msg_split', phase: 'final_answer', content: [{ type: 'output_text', text: 'Split answer.' }] } }));
    await new Promise((r) => setTimeout(r, 300)); // let the tail drain the pair's second half

    const replayed = ((await conn.getHistory()) as any[]).filter((m) => m.type === 'model-output');
    check(
      'a later history read on the same connection reproduces the identity already published',
      replayed.length === 1 && replayed[0].key === answers()[0]?.key,
      `history=${replayed[0]?.key} tail=${answers()[0]?.key} tailCopies=${answers().length}`,
    );
    check(
      'the tail did not restate that answer under the identity the settled file now implies',
      answers().length === 1,
      JSON.stringify(answers().map((m) => m.key)),
    );

    // The record is per-connection: line indices only mean anything inside one append-only file, and a
    // client attaching fresh has stored nothing yet, so it must get the identity the file now supports.
    unsubscribe();
    await conn.close();
    const fresh = await new CodexAdapter().attach(id, 'observe');
    try {
      const freshAnswers = ((await fresh.getHistory()) as any[]).filter((m) => m.type === 'model-output');
      check(
        'the published record does not leak past close(): a fresh connection decides from the file',
        freshAnswers.length === 1 && freshAnswers[0].key === 'codex:t-split:msg_split:t',
        `key=${freshAnswers[0]?.key}`,
      );
    } finally {
      await fresh.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ── 1k. subagent threads are Observe-only, advertised and enforced ──
// A subagent rollout is a child thread the spawning agent owns and writes. Those rollouts are event-
// heavy and record almost no response items, so most of their assistant records have no native id on
// EITHER side of the pair: history keys them `c<line>` while live app-server delivery keys the same
// answer `codex:<turnId>:<itemId>:t`. Being hidden by default is not the guard — background origins
// are un-hideable in Settings and an ORPHANED child (no parent in the roster) is surfaced at top
// level regardless of the filter — so the boundary is Drive itself. Tag-not-drop is unchanged: the
// session stays listed and fully readable.
await (async () => {
  const dir = join('/tmp', `cosyncing-codex-subagent-${Math.random().toString(36).slice(2, 8)}`);
  const sessionsDir = join(dir, 'sessions', '2026', '07', '25');
  const binDir = join(dir, 'bin');
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;
  const CHILD = '00000000-0000-4000-8000-0000000000c1';
  const PARENT = '00000000-0000-4000-8000-0000000000a0'; // deliberately NOT written: this child is an orphan
  const NORMAL = '00000000-0000-4000-8000-0000000000b2';
  const LOADED = '00000000-0000-4000-8000-0000000000b3'; // a normal session in the same loaded set: the control for "loaded ⇒ live"
  const childPath = join(sessionsDir, `rollout-2026-07-25T00-00-00-${CHILD}.jsonl`);
  const normalPath = join(sessionsDir, `rollout-2026-07-25T00-00-00-${NORMAL}.jsonl`);
  const loadedPath = join(sessionsDir, `rollout-2026-07-25T00-00-00-${LOADED}.jsonl`);
  // The spawn shape real child rollouts carry (session_meta.source.subagent.thread_spawn).
  writeFileSync(
    childPath,
    line({ type: 'session_meta', payload: { id: CHILD, cwd: dir, source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1 } } } } }) +
      line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }) +
      line({ type: 'event_msg', payload: { type: 'user_message', message: 'Investigate the flake.' } }) +
      line({ type: 'event_msg', payload: { type: 'agent_message', message: 'Found it.', phase: 'final_answer' } }) +
      line({ type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'msg_child1', phase: 'final_answer', content: [{ type: 'output_text', text: 'Found it.' }] } }) +
      line({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } }),
  );
  writeFileSync(normalPath, line({ type: 'session_meta', payload: { id: NORMAL, cwd: dir, thread_source: 'user' } }));
  writeFileSync(loadedPath, line({ type: 'session_meta', payload: { id: LOADED, cwd: dir, thread_source: 'user' } }));
  const marker = join(dir, 'spawned.log');
  const fakeCodex = join(binDir, 'codex');
  writeFileSync(fakeCodex, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${marker}\nexit 0\n`);
  chmodSync(fakeCodex, 0o755);
  const encodedChild = Buffer.from(childPath, 'utf8').toString('base64url');

  try {
    // (a) readable in Observe, and (b) the SessionInfo an observe attach produces refuses Drive.
    const conn = await new CodexAdapter().attach(encodedChild, 'observe');
    let tailed: any[] = [];
    let historyKeys: string[] = [];
    try {
      const history = (await conn.getHistory()) as any[];
      const answers = history.filter((m) => m.type === 'model-output');
      const asked = history.filter((m) => m.type === 'user-message');
      check(
        'an orphan-visible subagent session is fully readable in Observe',
        answers.length === 1 && answers[0].text === 'Found it.' && asked.length === 1 && asked[0].text === 'Investigate the flake.',
        `answers=${answers.length} user=${asked.length}`,
      );
      check(
        'its origin tag and parent linkage survive the attach (the roster needs both to place an orphan)',
        conn.info.origin === 'subagent' && conn.info.parentThreadId === PARENT,
        JSON.stringify({ origin: conn.info.origin, parentThreadId: conn.info.parentThreadId }),
      );
      check(
        'an observe attach on a subagent session advertises observe and NO Drive',
        conn.info.attachMode === 'observe' &&
          conn.info.control?.drive.supported === false &&
          conn.info.control?.drive.state === 'unavailable' &&
          /owned by the agent that spawned it/.test(conn.info.control?.drive.reason ?? ''),
        JSON.stringify({ attachMode: conn.info.attachMode, drive: conn.info.control?.drive }),
      );

      // (d) history + live tail still yield ONE copy of an assistant answer on the surface that remains.
      const messages: any[] = [];
      const unsubscribe = conn.subscribe((m: any) => messages.push(m));
      try {
        appendFileSync(
          childPath,
          line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't2' } }) +
            line({ type: 'event_msg', payload: { type: 'agent_message', message: 'And fixed it.', phase: 'final_answer' } }) +
            line({ type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'msg_child2', phase: 'final_answer', content: [{ type: 'output_text', text: 'And fixed it.' }] } }),
        );
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline && messages.filter((m) => m.type === 'model-output').length === 0) await new Promise((r) => setTimeout(r, 25));
        tailed = messages.filter((m) => m.type === 'model-output');
        historyKeys = ((await conn.getHistory()) as any[]).filter((m) => m.type === 'model-output').map((m) => m.key);
      } finally {
        unsubscribe();
      }
    } finally {
      await conn.close();
    }
    // Two answers exist; the tail delivered the second one under the identity history gives it. A
    // client folding both sources by key therefore holds each answer once, never a `c<line>` twin.
    check(
      'Observe history and the live tail agree on one identity per answer for a subagent session',
      tailed.length === 1 &&
        tailed[0].key === 'codex:t2:msg_child2:t' &&
        historyKeys.length === 2 &&
        historyKeys[0] === 'codex:t1:msg_child1:t' &&
        historyKeys[1] === tailed[0].key &&
        new Set([...historyKeys, ...tailed.map((m: any) => m.key)]).size === 2,
      `history=${JSON.stringify(historyKeys)} tail=${JSON.stringify(tailed.map((m: any) => m.key))}`,
    );

    // (c) a direct resume/live attach is refused BEFORE the daemon probe: the adapter's two probes
    // are instrumented, so a refusal that ran late would show up as a call count here.
    const previousBin = process.env.COSYNCING_CODEX_BIN;
    const previousSync = process.env.COSYNCING_CODEX_SYNC_SERVER;
    process.env.COSYNCING_CODEX_BIN = fakeCodex; // Bun.which snapshots PATH at process start; the PATH form is proven in the child probe below
    process.env.COSYNCING_CODEX_SYNC_SERVER = '1'; // 'live' must be refused on capability, not on a disabled sync server
    let daemonProbes = 0;
    let presenceScans = 0;
    const refusals: string[] = [];
    try {
      const guarded = new CodexAdapter({
        queryLoadedThreadIds: async () => {
          daemonProbes++;
          return new Set<string>();
        },
        scanCodexTuiPresence: async () => {
          presenceScans++;
          return { attributed: new Set(), unattributed: [], privateThreadIds: new Set(), privateUnattributed: [], unknownUnattributed: [], unknownThreadIds: new Set(), candidates: [], socketDiagAvailable: false, processScanAvailable: false };
        },
      });
      for (const mode of ['resume', 'live'] as const) {
        try {
          const driven = await guarded.attach(encodedChild, mode);
          await driven.close();
          refusals.push(`${mode}:ATTACHED`);
        } catch (e) {
          refusals.push(`${mode}:${(e as Error).message}`);
          check(
            `a direct ${mode} attach on a subagent session is refused as a capability boundary`,
            !isOwnershipConflictError(e) && /Observe-only/.test((e as Error).message) && /owned by the agent that spawned it/.test((e as Error).message),
            (e as Error).message,
          );
        }
      }
      // A reason-tagged Drive restore is the same adapter call with opts — it must not slip past either.
      try {
        const restored = await guarded.attach(encodedChild, 'resume', { reason: 'app-restore' });
        await restored.close();
        refusals.push('restore:ATTACHED');
      } catch (e) {
        refusals.push(`restore:${(e as Error).message}`);
        check('an automatic Drive restore cannot re-open the driving path either', /Observe-only/.test((e as Error).message), (e as Error).message);
      }
    } finally {
      if (previousBin == null) delete process.env.COSYNCING_CODEX_BIN; else process.env.COSYNCING_CODEX_BIN = previousBin;
      if (previousSync == null) delete process.env.COSYNCING_CODEX_SYNC_SERVER; else process.env.COSYNCING_CODEX_SYNC_SERVER = previousSync;
    }
    check('no daemon call was made before refusing', daemonProbes === 0 && presenceScans === 0, `daemonProbes=${daemonProbes} presenceScans=${presenceScans}`);

    // The roster row itself, plus the no-spawn proof with the fake first on a real PATH. Both need a
    // child process: CODEX_HOME and the PATH `codex` resolves to are both fixed at process start.
    // The child thread is reported DAEMON-LOADED here, which is the state that would otherwise make
    // it drivable on both surfaces: the roster maps loaded → attachMode 'live' + drive 'driving', and
    // a mode-less attach on a loaded thread becomes the mutable daemon-proxy owner. LOADED is a normal
    // session in the same loaded set — it must still show exactly that, or this proves nothing.
    // The probe ALSO covers Terminal Sync / Join. Sync-server mode is on in its env, so a normal row
    // there really does advertise `supported/syncAvailable` + a `join` action + a copyable
    // `codex resume --remote …` command — the exact offer that must be absent on the child row on all
    // three meta-derived surfaces (discovery, the watch's live-ids projection, and attach()). Join is
    // not cosmetic: it loads the thread into the managed daemon, the mutable surface Drive is refused.
    const probe = join(dir, 'subagent-probe.ts');
    writeFileSync(
      probe,
      `import { CodexAdapter } from ${JSON.stringify(join(import.meta.dir, '../../../adapters/codex/src/index.ts'))};\n` +
        `const encoded = ${JSON.stringify(encodedChild)};\n` +
        `const LOADED_IDS = new Set([${JSON.stringify(CHILD)}, ${JSON.stringify(LOADED)}]);\n` +
        'const emptyScan = () => ({ attributed: new Set<string>(), unattributed: [], privateThreadIds: new Set<string>(), privateUnattributed: [], unknownUnattributed: [], unknownThreadIds: new Set<string>(), candidates: [], socketDiagAvailable: true, processScanAvailable: true }) as any;\n' +
        // Every surface reports the SAME fields, so a row that lost its offer on one and kept it on
        // another is visible in the output rather than hidden behind a differently-shaped projection.
        'const surface = (r: any) => ({ nativeId: r.nativeId, origin: r.origin, parentThreadId: r.parentThreadId, attachMode: r.attachMode, drive: r.control?.drive, sync: r.control?.terminalSync, hint: r.terminalSyncHint });\n' +
        'const adapter = new CodexAdapter({ queryLoadedThreadIds: async () => LOADED_IDS, scanCodexTuiPresence: async () => emptyScan() });\n' +
        'const rows = (await adapter.discoverSessions()).map(surface);\n' +
        'const attaches: string[] = [];\n' +
        "for (const mode of ['resume', 'live'] as const) {\n" +
        '  try {\n' +
        '    const conn = await adapter.attach(encoded, mode);\n' +
        '    await conn.close();\n' +
        "    attaches.push(mode + ':ATTACHED');\n" +
        '  } catch (e) {\n' +
        "    attaches.push(mode + ':' + (e as Error).message);\n" +
        '  }\n' +
        '}\n' +
        'let modeless: any = null;\n' +
        'try {\n' +
        '  const conn = await adapter.attach(encoded);\n' +
        '  modeless = surface(conn.info);\n' +
        '  await conn.close();\n' +
        '} catch (e) {\n' +
        "  modeless = { threw: (e as Error).message };\n" +
        '}\n' +
        // The watch's live-ids projection (`sessionInfosForLiveIds`) is private; the ONLY way to reach
        // it is a loaded-set transition, so the first poll sees nothing loaded and the second sees the
        // child and the normal control together. Both affected rows are then emitted.
        'let poll = 0;\n' +
        'const watched: any[] = [];\n' +
        'const watcher = new CodexAdapter({ queryLoadedThreadIds: async () => (++poll <= 1 ? new Set<string>() : LOADED_IDS), scanCodexTuiPresence: async () => emptyScan() });\n' +
        'const stop = watcher.watchSessionInfo((info) => watched.push(surface(info)));\n' +
        'const deadline = Date.now() + 8000;\n' +
        'while (Date.now() < deadline && !(watched.some((w) => w.nativeId === ' + JSON.stringify(CHILD) + ') && watched.some((w) => w.nativeId === ' + JSON.stringify(LOADED) + '))) await new Promise((r) => setTimeout(r, 25));\n' +
        'stop();\n' +
        "console.log(JSON.stringify({ which: Bun.which('codex'), attaches, modeless, rows, watched }));\n",
    );
    const proc = Bun.spawn(['bun', 'run', probe], {
      // The probe's environment is built rather than inherited: this spawns a
      // real adapter with a sync server, and the operator's own `CODEX_*` and
      // `COSYNCING_*` settings would otherwise decide what it discovers. The
      // owned roots go beside the fake codex home, not inside it, so nothing
      // new appears under the `sessions/` tree this case reads back.
      env: isolatedBrokerFixtureEnvironment(join(dir, 'env'), {
        overrides: {
          CODEX_HOME: dir,
          PATH: `${binDir}:${process.env.PATH ?? ''}`, // the fake wins resolution, so a driving attach would spawn IT
          COSYNCING_CODEX_BIN: undefined, // PATH resolution is the point here
          COSYNCING_CODEX_SYNC_SERVER: '1',
          COSYNCING_CODEX_SYNC_WATCH_MS: '250', // the watch needs two polls to publish a loaded-set transition
          COSYNCING_CODEX_APP_SERVER_SOCK: join(dir, 'absent.sock'), // an explicit socket keeps discovery from managing a daemon
        },
      }),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    let probed: { which?: string; attaches?: string[]; modeless?: any; rows?: any[]; watched?: any[] } = {};
    try {
      probed = JSON.parse(stdout.trim().split('\n').pop() ?? '{}');
    } catch {
      probed = {};
    }
    const rows = probed.rows ?? [];
    const attaches = probed.attaches ?? [];
    check('the fake codex is the one PATH resolves in the probe (the refusal has something to prevent)', probed.which === fakeCodex, `${probed.which} ${stderr.trim().slice(0, 200)}`);
    check(
      'resume and live are refused there too, and no owner process was started',
      attaches.length === 2 && attaches.every((a) => /Observe-only/.test(a)) && !existsSync(marker),
      `${attaches.join(' | ')} — marker=${existsSync(marker) ? readFileSync(marker, 'utf8').trim() : 'absent'} — inProcess=${refusals.join(' | ')}`,
    );
    const child = rows.find((r) => r.nativeId === CHILD);
    const normal = rows.find((r) => r.nativeId === NORMAL);
    const loaded = rows.find((r) => r.nativeId === LOADED);
    check(
      'discovery still LISTS the subagent session, tagged with its parent',
      !!child && child.origin === 'subagent' && child.parentThreadId === PARENT,
      JSON.stringify(child ?? { rows: rows.length, stderr: stderr.trim().slice(0, 200) }),
    );
    check(
      'the discovered subagent row advertises observe and NO Drive',
      child?.attachMode === 'observe' && child?.drive?.supported === false && child?.drive?.state === 'unavailable' && /owned by the agent that spawned it/.test(child?.drive?.reason ?? ''),
      JSON.stringify(child ?? null),
    );
    check(
      'a normal session discovered alongside it still offers Drive (the boundary is origin, not the scan)',
      normal?.attachMode === 'observe' && normal?.drive?.supported === true && normal?.drive?.state === 'observing',
      JSON.stringify(normal ?? null),
    );
    check(
      'a daemon-loaded NORMAL session still maps loaded → live + driving (the loaded set really is in effect)',
      loaded?.attachMode === 'live' && loaded?.drive?.supported === true && loaded?.drive?.state === 'driving',
      JSON.stringify(loaded ?? null),
    );
    check(
      'being daemon-loaded does not make the subagent row drivable',
      child?.attachMode === 'observe' && child?.drive?.supported === false,
      JSON.stringify(child ?? null),
    );
    check(
      'a mode-less attach on that loaded subagent thread stays a read-only Observe connection',
      probed.modeless?.attachMode === 'observe' && probed.modeless?.drive?.supported === false && probed.modeless?.drive?.state === 'unavailable',
      JSON.stringify(probed.modeless ?? null),
    );

    // ── Terminal Sync / Join is part of the SAME boundary ──
    // Drive said "unavailable" while terminalSync kept saying "supported + syncAvailable + join +
    // command", and the client renders sync-available BEFORE observing — so a child row still showed
    // a Join button with a copyable `codex resume --remote …`. Joining loads the child into the
    // managed daemon: the live surface Drive is refused for. `label` is asserted absent too, because
    // the pill copy is what a user reads as "this is joinable".
    const noJoinOffer = (row: any): boolean =>
      row?.sync?.supported === false &&
      row?.sync?.syncAvailable === false &&
      row?.sync?.active === false &&
      row?.sync?.action === undefined &&
      row?.sync?.command === undefined &&
      row?.sync?.label === undefined &&
      row?.hint === undefined &&
      /owned by the agent that spawned it/.test(row?.sync?.reason ?? '');
    // The control: sync-server mode is ON in the probe, so a NORMAL row carries the full offer. If a
    // future predicate widened past `origin === 'subagent'`, this is what would fail first.
    const fullJoinOffer = (row: any): boolean =>
      row?.sync?.supported === true &&
      row?.sync?.syncAvailable === true &&
      row?.sync?.action === 'join' &&
      typeof row?.sync?.command === 'string' &&
      /codex resume --remote/.test(row.sync.command) &&
      typeof row?.hint?.command === 'string' &&
      /codex resume --remote/.test(row.hint.command);
    check(
      'a NORMAL discovered row still advertises Terminal Sync with a join action and a copyable command',
      fullJoinOffer(normal) && fullJoinOffer(loaded),
      JSON.stringify({ normal: { sync: normal?.sync, hint: normal?.hint }, loaded: { sync: loaded?.sync, hint: loaded?.hint } }),
    );
    check(
      'the discovered subagent row offers NO Terminal Sync: no join action, no command, no top-level hint',
      noJoinOffer(child),
      JSON.stringify({ sync: child?.sync, hint: child?.hint }),
    );
    check(
      'the mode-less attach SessionInfo for the subagent thread offers no join either',
      noJoinOffer(probed.modeless),
      JSON.stringify({ sync: probed.modeless?.sync, hint: probed.modeless?.hint }),
    );
    const watched = probed.watched ?? [];
    const watchedChild = watched.find((r) => r.nativeId === CHILD);
    const watchedLoaded = watched.find((r) => r.nativeId === LOADED);
    check(
      "the watch's live-ids projection published both affected rows on the loaded-set transition",
      !!watchedChild && !!watchedLoaded,
      JSON.stringify(watched.map((r) => r.nativeId)),
    );
    check(
      'the live-ids projection keeps the full join offer on the NORMAL loaded row',
      fullJoinOffer(watchedLoaded) && watchedLoaded?.attachMode === 'live' && watchedLoaded?.drive?.supported === true && watchedLoaded?.drive?.state === 'driving',
      JSON.stringify(watchedLoaded ?? null),
    );
    check(
      'the live-ids projection suppresses the join offer AND the hint on the subagent row',
      noJoinOffer(watchedChild) && watchedChild?.attachMode === 'observe' && watchedChild?.drive?.supported === false,
      JSON.stringify(watchedChild ?? null),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// ── 2. real-data smoke (read-only; no content printed) ──────────────────────────
await (async () => {
  const adapter = new CodexAdapter();
  if (!(await adapter.isAvailable())) {
    check('real-data smoke (skipped — no ~/.codex/sessions on this machine)', true, 'skipped');
    return;
  }
  const sessions = await adapter.discoverSessions();
  if (sessions.length === 0 && process.env.CODEX_HOME) {
    check(
      'real-data smoke (skipped — explicit CODEX_HOME has no sessions)',
      true,
      'skipped',
    );
    return;
  }
  check('discovery finds real Codex sessions', sessions.length > 0, `${sessions.length} sessions`);
  const liveRows = sessions.filter((s) => s.attachMode === 'live');
  // `active` is presence-based (a TUI must be attached RIGHT NOW), so on a real machine a
  // daemon-loaded row may honestly be active:false — the loaded list is a one-way latch that
  // survives terminal exits, and claiming "synced with terminal" then was the stuck-badge bug.
  // Drive follows presence too: terminal attached ⇒ unavailable (sync is the input path);
  // no terminal ⇒ driving (the live daemon conn is the app's mutable path).
  check(
    'daemon-loaded Codex roster rows advertise sync and map Drive to terminal presence',
    !syncServerEnabled || liveRows.length === 0 || liveRows.every((s) =>
      s.control?.terminalSync.syncAvailable === true &&
      (s.control.terminalSync.active
        ? s.control.drive.state === 'unavailable' && s.control.drive.supported === false
        : s.control.drive.state === 'driving' && s.control.drive.supported === true)),
    syncServerEnabled ? `${liveRows.length} live rows` : 'sync disabled',
  );
  if (!sessions.length) return;
  // newest by updatedAt
  const newest = [...sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]!;
  const conn = await adapter.attach(newest.id, 'observe');
  let history: any[] = [];
  let threw = '';
  try {
    history = await conn.getHistory();
  } catch (e) {
    threw = String(e);
  }
  await conn.close();
  const types = [...new Set(history.map((m) => m.type))];
  const bad = types.filter((t) => !(CANONICAL_MESSAGE_TYPES as readonly string[]).includes(t));
  check('getHistory() on a real rollout parses without throwing', threw === '', threw);
  check('real history yields only canonical message types', bad.length === 0, `types=[${types.join(',')}] msgs=${history.length}`);
})();

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
