/**
 * Headless regression for the Codex adapter's rollout handling that the mapping corpus
 * (`e2e/adapters/mapping/codex.test.ts`) does not express: history capture and its resource bounds,
 * page-cache cursors, canonical (turn, ordinal) identity, tail/pair timing, run-state inference
 * (the 8 MiB window, cold and warm scans), `codexSessionOrigin`, `codexAttachMode`, and the
 * subagent Observe boundary. Pure rollout-to-message mapping lives in the corpus.
 *
 * Zero-cost: no `codex`, no daemon, no model, and no host session data.
 *
 *   bun run packages/typescript/broker/test/codex/rollout.ts     (exit 0 = all pass)
 */
export {};
import { strict as assert } from 'node:assert';
import { appendFileSync, chmodSync, closeSync, existsSync, ftruncateSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { isolatedBrokerFixtureEnvironment } from '../helpers/isolated-broker-fixture.ts';
import { historySourceStillContainsSnapshot, IndexedHistoryPageCacheBuilder } from '../../src/sessions/history-page-cache.ts';
import { backwardHistoryCursor, cursorDurableHistory } from '../../src/sessions/history-delta.ts';
import type { AgentMessage, HistorySnapshotSink } from '../../../adapter-api/src/index.ts';
import { isHistorySnapshotRefusal, isOwnershipConflictError } from '../../../adapter-api/src/index.ts';
import { mergeCodexNativeRunEvidence, readCodexNativeRunEvidence } from '../../../adapters/codex/src/run-state-repair.ts';

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
import { CodexAdapter, captureFileHistoryInto, codexAttachMode, codexRolloutToolItem, inferRolloutStatus, inferRolloutStatusResult, codexSessionOrigin, mapRollout, rolloutHasExactTerminalTurn } from '../../../adapters/codex/src/index.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
// Mirrors codexLiveSyncEnabled(): sync is ON BY DEFAULT (issues-part2) — an unset env means enabled;
// only an explicit falsy value disables it.
const syncEnv = (process.env.COSYNCING_CODEX_SYNC_SERVER ?? process.env.COSYNCING_CODEX_LIVE ?? '').trim();
const syncServerEnabled = syncEnv === '' ? true : /^(1|true|yes|on)$/i.test(syncEnv);
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

{
  const merged = mergeCodexNativeRunEvidence(
    readCodexNativeRunEvidence({ thread: { status: { type: 'idle' }, turns: [] } }),
    readCodexNativeRunEvidence({ data: [{ id: 'turn-paged', status: 'completed' }] }),
  );
  check(
    'paged Codex turn evidence keeps exact Idle status and recovers the matching terminal',
    merged.statusType === 'idle'
      && merged.terminalTurnIds.has('turn-paged')
      && merged.activeTurnId === undefined,
  );
}


// ── Reasoning: one row per reasoning item, from the item, under the key the live path uses ───────
// Rollouts carry reasoning in up to three forms: `event_msg/agent_reasoning` (one `{type, text}`
// event per summary part, older builds only), `event_msg/item_completed` with a `Reasoning` item
// (newer builds), and `response_item/reasoning` (every build). History used to read only the first,
// and read it wrong, so no rollout ever showed reasoning. The shapes below are the ones real
// rollouts write (inner parts `summary_text` / `reasoning_text`); the content is invented.
{
  const summary = (...texts: string[]) => texts.map((text) => ({ type: 'summary_text', text }));
  const raw = (...texts: string[]) => texts.map((text) => ({ type: 'reasoning_text', text }));
  const completed = (turn: string, id: string, summaryText: string[], rawContent: string[]) => ({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: 'thread-r',
      turn_id: turn,
      started_at_ms: 1_700_000_000_000,
      completed_at_ms: 1_700_000_000_500,
      item: { type: 'Reasoning', id, summary_text: summaryText, raw_content: rawContent },
    },
  });
  const lines: any[] = [
    { type: 'session_meta', payload: { id: 'thread-r', cwd: '/tmp/r' } },
    { timestamp: '2026-09-01T10:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'first prompt' } },
    { timestamp: '2026-09-01T10:00:01.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-old' } },
    // Older build: an event per summary part, then the item — with no id.
    { type: 'event_msg', payload: { type: 'agent_reasoning', text: 'Old part one.' } },
    { type: 'event_msg', payload: { type: 'agent_reasoning', text: 'Old part two.' } },
    { type: 'response_item', payload: { type: 'reasoning', summary: summary('Old part one.', 'Old part two.'), content: null, encrypted_content: 'opaque-1' } },
    // Older build whose item carries an id but no turn metadata: the open turn names it.
    { type: 'event_msg', payload: { type: 'agent_reasoning', text: 'Old identified part.' } },
    { type: 'response_item', payload: { type: 'reasoning', id: 'rs_old_2', summary: summary('Old identified part.'), encrypted_content: 'opaque-2' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'first answer' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'msg_old', content: [{ type: 'output_text', text: 'first answer' }] } },
    { timestamp: '2026-09-01T10:00:05.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-old' } },
    { timestamp: '2026-09-01T10:01:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-new' } },
    // Newer build: the completed item, then the response item, both naming id and turn.
    completed('turn-new', 'rs_new_1', [], ['New raw step.', 'New raw step two.']),
    { type: 'response_item', payload: { type: 'reasoning', id: 'rs_new_1', summary: [], content: raw('New raw step.', 'New raw step two.'), encrypted_content: null, internal_chat_message_metadata_passthrough: { turn_id: 'turn-new' } } },
    // Encrypted only: nothing to render, live or here.
    completed('turn-new', 'rs_new_2', [], []),
    { type: 'response_item', payload: { type: 'reasoning', id: 'rs_new_2', summary: [], encrypted_content: 'opaque-3', internal_chat_message_metadata_passthrough: { turn_id: 'turn-new' } } },
    completed('turn-new', 'rs_new_3', ['New summary.'], []),
    { type: 'response_item', payload: { type: 'reasoning', id: 'rs_new_3', summary: summary('New summary.'), content: null, encrypted_content: null, internal_chat_message_metadata_passthrough: { turn_id: 'turn-new' } } },
    // The `metadata` spelling some builds write.
    { type: 'response_item', payload: { type: 'reasoning', id: 'rs_new_4', summary: summary('Metadata spelling.'), encrypted_content: 'opaque-4', metadata: { turn_id: 'turn-new' } } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'second answer' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'msg_new', content: [{ type: 'output_text', text: 'second answer' }] } },
    { timestamp: '2026-09-01T10:01:09.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-new' } },
  ];
  const expected = [
    { key: 'c5', text: 'Old part one.\nOld part two.' },
    { key: 'codex:turn-old:rs_old_2:r', text: 'Old identified part.' },
    { key: 'codex:turn-new:rs_new_1:r', text: 'New raw step.\nNew raw step two.' },
    { key: 'codex:turn-new:rs_new_3:r', text: 'New summary.' },
    { key: 'codex:turn-new:rs_new_4:r', text: 'Metadata spelling.' },
  ];
  const thinkingOf = (rows: AgentMessage[]) => rows
    .filter((m) => m.type === 'thinking')
    .map((m: any) => ({ key: m.key, text: m.text }));
  const mapped = mapRollout(lines);
  check(
    'reasoning: one row per reasoning item with text, in order, under the live key (line key when the item has no id)',
    JSON.stringify(thinkingOf(mapped)) === JSON.stringify(expected),
    JSON.stringify(thinkingOf(mapped)),
  );
  check(
    'reasoning: agent_reasoning events and item_completed records add no row of their own',
    thinkingOf(mapRollout(lines.filter((line) => line.type !== 'response_item' || line.payload?.type !== 'reasoning'))).length === 0,
    JSON.stringify(thinkingOf(mapRollout(lines.filter((line) => line.type !== 'response_item' || line.payload?.type !== 'reasoning')))),
  );
  check(
    'reasoning: no two rows share a key',
    new Set(mapped.filter((m) => m.type === 'thinking').map((m: any) => m.key)).size === expected.length,
    JSON.stringify(thinkingOf(mapped).map((row) => row.key)),
  );
  // A read that starts inside a turn (no `task_started` seen) still keys an item by the turn it
  // names for itself: the id and that turn are the pair the live notification carries.
  const midTurn = mapRollout(lines.slice(12));
  check(
    'reasoning: an item read without its turn opening keys itself by its own turn',
    JSON.stringify(thinkingOf(midTurn)) === JSON.stringify(expected.slice(2)),
    JSON.stringify(thinkingOf(midTurn)),
  );

  // The indexed attach and native pages rebuild each row from its own record: the same keys and
  // text as the full read, and every older cursor issued before reasoning rows existed fails
  // closed once it names a boundary past one (a changed prefix), never a shifted page.
  const dir = mkdtempSync(join(tmpdir(), 'cosyncing-reasoning-'));
  const path = join(dir, 'rollout-reasoning.jsonl');
  const filler = Array.from({ length: 30 }, (_, index) => [
    { type: 'event_msg', payload: { type: 'agent_message', message: `filler ${index}` } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', id: `msg_f${index}`, content: [{ type: 'output_text', text: `filler ${index}` }] } },
  ]).flat();
  const fileLines = [...lines.slice(0, -1), ...filler, lines.at(-1)];
  try {
    writeFileSync(path, `${fileLines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    const builder = new IndexedHistoryPageCacheBuilder();
    const sink: HistorySnapshotSink = {
      acceptsLocations: true,
      accept: (message: AgentMessage, location?: number) => builder.accept(message, location),
    };
    const captured = await captureFileHistoryInto(path, sink);
    const cache = captured && !('refusal' in captured) && captured.reader
      ? builder.finish(captured.identity, captured.reader)
      : undefined;
    const paged: AgentMessage[] = [];
    let attachOk = false;
    if (cache) {
      const attach = await cache.loadAttach(undefined, 8);
      if (!('kind' in attach)) {
        attachOk = attach.messages.length > 0 && Boolean(attach.olderCursor);
        paged.push(...attach.messages);
        let cursor = attach.olderCursor;
        while (cursor) {
          const page = await cache.loadPage(cursor, 5);
          if ('kind' in page || page.gap) break;
          paged.unshift(...page.messages);
          cursor = page.cursor;
        }
      }
    }
    check(
      'reasoning: the indexed attach and native pages return the same reasoning rows as a full read',
      attachOk && JSON.stringify(thinkingOf(paged)) === JSON.stringify(expected),
      JSON.stringify(thinkingOf(paged)),
    );

    const full = mapRollout(fileLines);
    const withoutReasoning = cursorDurableHistory(full.filter((m) => m.type !== 'thinking')).durable;
    const firstReasoning = cursorDurableHistory(full).durable.findIndex((m) => m.type === 'thinking');
    const outcomes: string[] = [];
    let misplaced = 0;
    if (cache) {
      for (let boundary = 1; boundary <= withoutReasoning.length; boundary += 1) {
        const stale = backwardHistoryCursor(withoutReasoning, boundary);
        const page = await cache.loadPage(stale, 5);
        if ('kind' in page) {
          outcomes.push(`${boundary}:${page.kind}`);
          continue;
        }
        if (page.gap) {
          if (boundary <= firstReasoning) misplaced += 1;
          outcomes.push(`${boundary}:${page.gap.code}`);
          continue;
        }
        // Accepted: only where the prefix before it is unchanged.
        if (boundary > firstReasoning) misplaced += 1;
      }
    }
    const refusedCodes = new Set(outcomes.map((outcome) => outcome.split(':')[1]));
    check(
      'reasoning: a cursor issued before reasoning rows existed is refused past the first one and honoured before it',
      Boolean(cache)
        && firstReasoning > 0
        && misplaced === 0
        && outcomes.length === withoutReasoning.length - firstReasoning
        && [...refusedCodes].every((code) => code === 'HISTORY_CURSOR_DIVERGED' || code === 'HISTORY_CURSOR_GONE'),
      `first=${firstReasoning} misplaced=${misplaced} refused=${outcomes.length}/${withoutReasoning.length} codes=${[...refusedCodes].join(',')}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// Observe tails the same rollout live: a reasoning item tailed after the attach must keep the key a
// later history read of the settled file gives it — including an item with an id but no turn
// metadata, whose turn opened BEFORE the attach.
await (async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cosyncing-reasoning-tail-'));
  const path = join(dir, 'rollout-2026-09-01T00-00-00-00000000-0000-4000-8000-0000000000r1.jsonl');
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;
  writeFileSync(
    path,
    line({ type: 'session_meta', payload: { id: '00000000-0000-4000-8000-0000000000r1', cwd: dir } })
      + line({ type: 'event_msg', payload: { type: 'user_message', message: 'prompt' } })
      + line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-tail' } }),
  );
  const messages: any[] = [];
  const conn = await new CodexAdapter().attach(Buffer.from(path, 'utf8').toString('base64url'), 'observe');
  const unsubscribe = conn.subscribe((m: any) => messages.push(m));
  const tailed = () => messages.filter((m) => m.type === 'thinking').map((m) => ({ key: m.key, text: m.text }));
  try {
    appendFileSync(
      path,
      line({ type: 'event_msg', payload: { type: 'item_completed', thread_id: 't', turn_id: 'turn-tail', started_at_ms: 1, completed_at_ms: 2, item: { type: 'Reasoning', id: 'rs_tail_1', summary_text: ['Tailed summary.'], raw_content: [] } } })
        + line({ type: 'response_item', payload: { type: 'reasoning', id: 'rs_tail_1', summary: [{ type: 'summary_text', text: 'Tailed summary.' }], content: null, encrypted_content: null, internal_chat_message_metadata_passthrough: { turn_id: 'turn-tail' } } })
        + line({ type: 'response_item', payload: { type: 'reasoning', id: 'rs_tail_2', summary: [{ type: 'summary_text', text: 'No turn metadata.' }], encrypted_content: 'opaque' } }),
    );
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && tailed().length < 2) await new Promise((r) => setTimeout(r, 25));
    const history = ((await conn.getHistory()) as any[])
      .filter((m) => m.type === 'thinking')
      .map((m) => ({ key: m.key, text: m.text }));
    check(
      'reasoning: a tailed reasoning item and the later history read of it share one key',
      tailed().length === 2
        && tailed()[0]?.key === 'codex:turn-tail:rs_tail_1:r'
        && JSON.stringify(history) === JSON.stringify(tailed()),
      `tail=${JSON.stringify(tailed())} history=${JSON.stringify(history)}`,
    );
  } finally {
    unsubscribe();
    await conn.close();
    rmSync(dir, { recursive: true, force: true });
  }
})();
// ── Tool calls the model did not issue: history rebuilds the rows the live stream produced ───────
// A nested call made inside a code-mode `exec` cell (`exec-<uuid>` ids) and a user shell command
// (bare uuid ids) are written ONLY as `event_msg/item_completed`. The app-server streams each one as
// an item, started then completed, which the live connection maps to a tool-call and a tool-result
// under callId = the item id. Each triple below is one item from the real app-server (0.157.1): its
// rollout record, then the started and the completed item it streamed. The content was invented for
// the capture and the working directory is rewritten to /work/proj.
const APP_SERVER_TOOL_ITEMS: Array<[any, any, any]> = [
  [
    {"type": "CommandExecution", "id": "f2f435b6-4091-4c0b-a29f-5b1cc649a388", "command": ["/bin/bash", "-lc", "printf 'shell out\\n'"], "cwd": "file:///work/proj", "parsed_cmd": [{"type": "unknown", "cmd": "printf 'shell out\\n'"}], "source": "user_shell", "status": "completed", "stdout": "shell out\n", "stderr": "", "aggregated_output": "shell out\n", "exit_code": 0, "duration": {"secs": 0, "nanos": 8153766}, "formatted_output": "shell out\n"},
    {"type": "commandExecution", "id": "f2f435b6-4091-4c0b-a29f-5b1cc649a388", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc \"printf 'shell out\\\\n'\"", "cwd": "/work/proj", "processId": null, "source": "userShell", "status": "inProgress", "commandActions": [{"type": "unknown", "command": "printf 'shell out\\n'"}], "aggregatedOutput": null, "exitCode": null, "durationMs": null},
    {"type": "commandExecution", "id": "f2f435b6-4091-4c0b-a29f-5b1cc649a388", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc \"printf 'shell out\\\\n'\"", "cwd": "/work/proj", "processId": null, "source": "userShell", "status": "completed", "commandActions": [{"type": "unknown", "command": "printf 'shell out\\n'"}], "aggregatedOutput": "shell out\n", "exitCode": 0, "durationMs": 8},
  ],
  [
    {"type": "CommandExecution", "id": "exec-c07db339-435a-4268-86ca-c6c6de654033", "process_id": "2866", "command": ["/bin/bash", "-lc", "echo 'it''s' \"$X\""], "cwd": "file:///work/proj", "parsed_cmd": [{"type": "unknown", "cmd": "echo 'it''s' \"$X\""}], "source": "unified_exec_startup", "status": "completed", "stdout": "its \n", "stderr": "", "aggregated_output": "its \n", "exit_code": 0, "duration": {"secs": 0, "nanos": 27070}, "formatted_output": "its \n"},
    {"type": "commandExecution", "id": "exec-c07db339-435a-4268-86ca-c6c6de654033", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc \"echo 'it''s' \\\"\"'$X\"'", "cwd": "/work/proj", "processId": "2866", "source": "unifiedExecStartup", "status": "inProgress", "commandActions": [{"type": "unknown", "command": "echo 'it''s' \"$X\""}], "aggregatedOutput": null, "exitCode": null, "durationMs": null},
    {"type": "commandExecution", "id": "exec-c07db339-435a-4268-86ca-c6c6de654033", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc \"echo 'it''s' \\\"\"'$X\"'", "cwd": "/work/proj", "processId": "2866", "source": "unifiedExecStartup", "status": "completed", "commandActions": [{"type": "unknown", "command": "echo 'it''s' \"$X\""}], "aggregatedOutput": "its \n", "exitCode": 0, "durationMs": 0},
  ],
  [
    {"type": "CommandExecution", "id": "exec-363e271c-0bd4-4667-ab5a-ed7f1ac6d8b7", "process_id": "24554", "command": ["/bin/bash", "-lc", "echo `date +%s` !x ^y"], "cwd": "file:///work/proj", "parsed_cmd": [{"type": "unknown", "cmd": "echo `date +%s` !x ^y"}], "source": "unified_exec_startup", "status": "completed", "stdout": "1790447730 !x ^y\n", "stderr": "", "aggregated_output": "1790447730 !x ^y\n", "exit_code": 0, "duration": {"secs": 0, "nanos": 22270}, "formatted_output": "1790447730 !x ^y\n"},
    {"type": "commandExecution", "id": "exec-363e271c-0bd4-4667-ab5a-ed7f1ac6d8b7", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc 'echo `date +%s` !x ''^y'", "cwd": "/work/proj", "processId": "24554", "source": "unifiedExecStartup", "status": "inProgress", "commandActions": [{"type": "unknown", "command": "echo `date +%s` !x ^y"}], "aggregatedOutput": null, "exitCode": null, "durationMs": null},
    {"type": "commandExecution", "id": "exec-363e271c-0bd4-4667-ab5a-ed7f1ac6d8b7", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc 'echo `date +%s` !x ''^y'", "cwd": "/work/proj", "processId": "24554", "source": "unifiedExecStartup", "status": "completed", "commandActions": [{"type": "unknown", "command": "echo `date +%s` !x ^y"}], "aggregatedOutput": "1790447730 !x ^y\n", "exitCode": 0, "durationMs": 0},
  ],
  [
    {"type": "CommandExecution", "id": "exec-a6c3867e-a437-4785-816e-cd2b4c33a40f", "process_id": "87402", "command": ["/bin/bash", "-lc", "^leading caret"], "cwd": "file:///work/proj", "parsed_cmd": [{"type": "unknown", "cmd": "^leading caret"}], "source": "unified_exec_startup", "status": "failed", "stdout": "/bin/bash: line 1: ^leading: command not found\n", "stderr": "", "aggregated_output": "/bin/bash: line 1: ^leading: command not found\n", "exit_code": 127, "duration": {"secs": 0, "nanos": 27730}, "formatted_output": "/bin/bash: line 1: ^leading: command not found\n"},
    {"type": "commandExecution", "id": "exec-a6c3867e-a437-4785-816e-cd2b4c33a40f", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc '^leading caret'", "cwd": "/work/proj", "processId": "87402", "source": "unifiedExecStartup", "status": "inProgress", "commandActions": [{"type": "unknown", "command": "^leading caret"}], "aggregatedOutput": null, "exitCode": null, "durationMs": null},
    {"type": "commandExecution", "id": "exec-a6c3867e-a437-4785-816e-cd2b4c33a40f", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc '^leading caret'", "cwd": "/work/proj", "processId": "87402", "source": "unifiedExecStartup", "status": "failed", "commandActions": [{"type": "unknown", "command": "^leading caret"}], "aggregatedOutput": "/bin/bash: line 1: ^leading: command not found\n", "exitCode": 127, "durationMs": 0},
  ],
  [
    {"type": "CommandExecution", "id": "exec-8d1a7c1d-a0f0-4958-aa4a-380d61ebc781", "process_id": "99168", "command": ["/bin/bash", "-lc", "echo café ☕ ünï"], "cwd": "file:///work/proj", "parsed_cmd": [{"type": "unknown", "cmd": "echo café ☕ ünï"}], "source": "unified_exec_startup", "status": "completed", "stdout": "café ☕ ünï\n", "stderr": "", "aggregated_output": "café ☕ ünï\n", "exit_code": 0, "duration": {"secs": 0, "nanos": 21421}, "formatted_output": "café ☕ ünï\n"},
    {"type": "commandExecution", "id": "exec-8d1a7c1d-a0f0-4958-aa4a-380d61ebc781", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc 'echo café ☕ ünï'", "cwd": "/work/proj", "processId": "99168", "source": "unifiedExecStartup", "status": "inProgress", "commandActions": [{"type": "unknown", "command": "echo café ☕ ünï"}], "aggregatedOutput": null, "exitCode": null, "durationMs": null},
    {"type": "commandExecution", "id": "exec-8d1a7c1d-a0f0-4958-aa4a-380d61ebc781", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc 'echo café ☕ ünï'", "cwd": "/work/proj", "processId": "99168", "source": "unifiedExecStartup", "status": "completed", "commandActions": [{"type": "unknown", "command": "echo café ☕ ünï"}], "aggregatedOutput": "café ☕ ünï\n", "exitCode": 0, "durationMs": 0},
  ],
  [
    {"type": "CommandExecution", "id": "exec-3affb845-7f7d-45fe-ac31-8d2ed0c3f629", "process_id": "25235", "command": ["/bin/bash", "-lc", "printf \"tab\\there\"; printf \"\\n\""], "cwd": "file:///work/proj", "parsed_cmd": [{"type": "unknown", "cmd": "printf \"tab\\there\"; printf \"\\n\""}], "source": "unified_exec_startup", "status": "completed", "stdout": "tab\there\n", "stderr": "", "aggregated_output": "tab\there\n", "exit_code": 0, "duration": {"secs": 0, "nanos": 28200}, "formatted_output": "tab\there\n"},
    {"type": "commandExecution", "id": "exec-3affb845-7f7d-45fe-ac31-8d2ed0c3f629", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc \"printf \\\"tab\\\\there\\\"; printf \\\"\\\\n\\\"\"", "cwd": "/work/proj", "processId": "25235", "source": "unifiedExecStartup", "status": "inProgress", "commandActions": [{"type": "unknown", "command": "printf \"tab\\there\"; printf \"\\n\""}], "aggregatedOutput": null, "exitCode": null, "durationMs": null},
    {"type": "commandExecution", "id": "exec-3affb845-7f7d-45fe-ac31-8d2ed0c3f629", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc \"printf \\\"tab\\\\there\\\"; printf \\\"\\\\n\\\"\"", "cwd": "/work/proj", "processId": "25235", "source": "unifiedExecStartup", "status": "completed", "commandActions": [{"type": "unknown", "command": "printf \"tab\\there\"; printf \"\\n\""}], "aggregatedOutput": "tab\there\n", "exitCode": 0, "durationMs": 0},
  ],
  [
    {"type": "CommandExecution", "id": "exec-a91216d2-b567-4d28-931a-ec635c35fc04", "process_id": "82296", "command": ["/bin/bash", "-lc", "plainword"], "cwd": "file:///work/proj", "parsed_cmd": [{"type": "unknown", "cmd": "plainword"}], "source": "unified_exec_startup", "status": "failed", "stdout": "/bin/bash: line 1: plainword: command not found\n", "stderr": "", "aggregated_output": "/bin/bash: line 1: plainword: command not found\n", "exit_code": 127, "duration": {"secs": 0, "nanos": 19050}, "formatted_output": "/bin/bash: line 1: plainword: command not found\n"},
    {"type": "commandExecution", "id": "exec-a91216d2-b567-4d28-931a-ec635c35fc04", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc plainword", "cwd": "/work/proj", "processId": "82296", "source": "unifiedExecStartup", "status": "inProgress", "commandActions": [{"type": "unknown", "command": "plainword"}], "aggregatedOutput": null, "exitCode": null, "durationMs": null},
    {"type": "commandExecution", "id": "exec-a91216d2-b567-4d28-931a-ec635c35fc04", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc plainword", "cwd": "/work/proj", "processId": "82296", "source": "unifiedExecStartup", "status": "failed", "commandActions": [{"type": "unknown", "command": "plainword"}], "aggregatedOutput": "/bin/bash: line 1: plainword: command not found\n", "exitCode": 127, "durationMs": 0},
  ],
  [
    {"type": "CommandExecution", "id": "exec-7549260e-b80f-4e10-859f-fb7d1413d3b8", "process_id": "68441", "command": ["/bin/bash", "-lc", "sleep 0.3006"], "cwd": "file:///work/proj", "parsed_cmd": [{"type": "unknown", "cmd": "sleep 0.3006"}], "source": "unified_exec_startup", "status": "completed", "stdout": "", "stderr": "", "aggregated_output": "", "exit_code": 0, "duration": {"secs": 0, "nanos": 153530850}, "formatted_output": ""},
    {"type": "commandExecution", "id": "exec-7549260e-b80f-4e10-859f-fb7d1413d3b8", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc 'sleep 0.3006'", "cwd": "/work/proj", "processId": "68441", "source": "unifiedExecStartup", "status": "inProgress", "commandActions": [{"type": "unknown", "command": "sleep 0.3006"}], "aggregatedOutput": null, "exitCode": null, "durationMs": null},
    {"type": "commandExecution", "id": "exec-7549260e-b80f-4e10-859f-fb7d1413d3b8", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc 'sleep 0.3006'", "cwd": "/work/proj", "processId": "68441", "source": "unifiedExecStartup", "status": "completed", "commandActions": [{"type": "unknown", "command": "sleep 0.3006"}], "aggregatedOutput": null, "exitCode": 0, "durationMs": 153},
  ],
  [
    {"type": "CommandExecution", "id": "exec-da090ad6-8573-4e62-a156-24651f4db879", "process_id": "16131", "command": ["/bin/bash", "-lc", "ls sub"], "cwd": "file:///work/proj", "parsed_cmd": [{"type": "list_files", "cmd": "ls sub", "path": "sub"}], "source": "unified_exec_startup", "status": "completed", "stdout": "", "stderr": "", "aggregated_output": "", "exit_code": 0, "duration": {"secs": 0, "nanos": 39941}, "formatted_output": ""},
    {"type": "commandExecution", "id": "exec-da090ad6-8573-4e62-a156-24651f4db879", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc 'ls sub'", "cwd": "/work/proj", "processId": "16131", "source": "unifiedExecStartup", "status": "inProgress", "commandActions": [{"type": "listFiles", "command": "ls sub", "path": "sub"}], "aggregatedOutput": null, "exitCode": null, "durationMs": null},
    {"type": "commandExecution", "id": "exec-da090ad6-8573-4e62-a156-24651f4db879", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc 'ls sub'", "cwd": "/work/proj", "processId": "16131", "source": "unifiedExecStartup", "status": "completed", "commandActions": [{"type": "listFiles", "command": "ls sub", "path": "sub"}], "aggregatedOutput": null, "exitCode": 0, "durationMs": 0},
  ],
  [
    {"type": "CommandExecution", "id": "exec-a4f6c175-0082-48bb-839a-3286ec2c37c2", "process_id": "71413", "command": ["/bin/bash", "-lc", "rg -n old a.txt"], "cwd": "file:///work/proj", "parsed_cmd": [{"type": "search", "cmd": "rg -n old a.txt", "query": "old", "path": "a.txt"}], "source": "unified_exec_startup", "status": "completed", "stdout": "1:old\n", "stderr": "", "aggregated_output": "1:old\n", "exit_code": 0, "duration": {"secs": 0, "nanos": 22860}, "formatted_output": "1:old\n"},
    {"type": "commandExecution", "id": "exec-a4f6c175-0082-48bb-839a-3286ec2c37c2", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc 'rg -n old a.txt'", "cwd": "/work/proj", "processId": "71413", "source": "unifiedExecStartup", "status": "inProgress", "commandActions": [{"type": "search", "command": "rg -n old a.txt", "query": "old", "path": "a.txt"}], "aggregatedOutput": null, "exitCode": null, "durationMs": null},
    {"type": "commandExecution", "id": "exec-a4f6c175-0082-48bb-839a-3286ec2c37c2", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc 'rg -n old a.txt'", "cwd": "/work/proj", "processId": "71413", "source": "unifiedExecStartup", "status": "completed", "commandActions": [{"type": "search", "command": "rg -n old a.txt", "query": "old", "path": "a.txt"}], "aggregatedOutput": "1:old\n", "exitCode": 0, "durationMs": 0},
  ],
  [
    {"type": "CommandExecution", "id": "exec-ac2b4ae7-638a-4b55-bf7b-a3fd74541ce1", "process_id": "73473", "command": ["/bin/bash", "-lc", "pwd"], "cwd": "file:///work/proj/d%C3%ADr-%C3%BCn%C3%AF%2520pct", "parsed_cmd": [{"type": "unknown", "cmd": "pwd"}], "source": "unified_exec_startup", "status": "completed", "stdout": "/work/proj/dír-ünï%20pct\n", "stderr": "", "aggregated_output": "/work/proj/dír-ünï%20pct\n", "exit_code": 0, "duration": {"secs": 0, "nanos": 26411}, "formatted_output": "/work/proj/dír-ünï%20pct\n"},
    {"type": "commandExecution", "id": "exec-ac2b4ae7-638a-4b55-bf7b-a3fd74541ce1", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc pwd", "cwd": "/work/proj/dír-ünï%20pct", "processId": "73473", "source": "unifiedExecStartup", "status": "inProgress", "commandActions": [{"type": "unknown", "command": "pwd"}], "aggregatedOutput": null, "exitCode": null, "durationMs": null},
    {"type": "commandExecution", "id": "exec-ac2b4ae7-638a-4b55-bf7b-a3fd74541ce1", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc pwd", "cwd": "/work/proj/dír-ünï%20pct", "processId": "73473", "source": "unifiedExecStartup", "status": "completed", "commandActions": [{"type": "unknown", "command": "pwd"}], "aggregatedOutput": "/work/proj/dír-ünï%20pct\n", "exitCode": 0, "durationMs": 0},
  ],
  [
    {"type": "CommandExecution", "id": "exec-30ec4462-13d0-44a4-b72d-d21a0cb6fba6", "process_id": "77039", "command": ["/bin/bash", "-c", "echo nologin"], "cwd": "file:///work/proj", "parsed_cmd": [{"type": "unknown", "cmd": "echo nologin"}], "source": "unified_exec_startup", "status": "completed", "stdout": "nologin\n", "stderr": "", "aggregated_output": "nologin\n", "exit_code": 0, "duration": {"secs": 0, "nanos": 18590}, "formatted_output": "nologin\n"},
    {"type": "commandExecution", "id": "exec-30ec4462-13d0-44a4-b72d-d21a0cb6fba6", "pluginId": null, "scriptPath": null, "command": "/bin/bash -c 'echo nologin'", "cwd": "/work/proj", "processId": "77039", "source": "unifiedExecStartup", "status": "inProgress", "commandActions": [{"type": "unknown", "command": "echo nologin"}], "aggregatedOutput": null, "exitCode": null, "durationMs": null},
    {"type": "commandExecution", "id": "exec-30ec4462-13d0-44a4-b72d-d21a0cb6fba6", "pluginId": null, "scriptPath": null, "command": "/bin/bash -c 'echo nologin'", "cwd": "/work/proj", "processId": "77039", "source": "unifiedExecStartup", "status": "completed", "commandActions": [{"type": "unknown", "command": "echo nologin"}], "aggregatedOutput": "nologin\n", "exitCode": 0, "durationMs": 0},
  ],
  [
    {"type": "CommandExecution", "id": "exec-b0d6b3a9-d22e-4c4e-bcd0-848436adcf32", "process_id": "36815", "command": ["/usr/bin/sh", "-lc", "echo sh"], "cwd": "file:///work/proj", "parsed_cmd": [{"type": "unknown", "cmd": "echo sh"}], "source": "unified_exec_startup", "status": "completed", "stdout": "sh\n", "stderr": "", "aggregated_output": "sh\n", "exit_code": 0, "duration": {"secs": 0, "nanos": 18721}, "formatted_output": "sh\n"},
    {"type": "commandExecution", "id": "exec-b0d6b3a9-d22e-4c4e-bcd0-848436adcf32", "pluginId": null, "scriptPath": null, "command": "/usr/bin/sh -lc 'echo sh'", "cwd": "/work/proj", "processId": "36815", "source": "unifiedExecStartup", "status": "inProgress", "commandActions": [{"type": "unknown", "command": "echo sh"}], "aggregatedOutput": null, "exitCode": null, "durationMs": null},
    {"type": "commandExecution", "id": "exec-b0d6b3a9-d22e-4c4e-bcd0-848436adcf32", "pluginId": null, "scriptPath": null, "command": "/usr/bin/sh -lc 'echo sh'", "cwd": "/work/proj", "processId": "36815", "source": "unifiedExecStartup", "status": "completed", "commandActions": [{"type": "unknown", "command": "echo sh"}], "aggregatedOutput": "sh\n", "exitCode": 0, "durationMs": 0},
  ],
  [
    {"type": "FileChange", "id": "exec-df20ff01-890b-4fe4-8e78-419a64fcdc2f", "changes": {"/work/proj/a.txt": {"type": "update", "unified_diff": "@@ -1,2 +1,2 @@\n-old\n+new\n line2\n", "move_path": null}, "/work/proj/mv-src.txt": {"type": "update", "unified_diff": "@@ -1 +1 @@\n-one\n+two\n", "move_path": "/work/proj/mv-dst.txt"}, "/work/proj/alpha.txt": {"type": "add", "content": "a\n"}, "/work/proj/zeta.txt": {"type": "add", "content": "z\n"}, "/work/proj/mid dir/mu.txt": {"type": "add", "content": "m\n"}, "/work/proj/gone.txt": {"type": "delete", "content": "bye\n"}}, "status": "completed", "stdout": "Success. Updated the following files:\nA zeta.txt\nA alpha.txt\nA mid dir/mu.txt\nM a.txt\nM mv-dst.txt\nD gone.txt\n", "stderr": ""},
    {"type": "fileChange", "id": "exec-df20ff01-890b-4fe4-8e78-419a64fcdc2f", "changes": [{"path": "/work/proj/a.txt", "kind": {"type": "update", "move_path": null}, "diff": "@@ -1,2 +1,2 @@\n-old\n+new\n line2\n"}, {"path": "/work/proj/alpha.txt", "kind": {"type": "add"}, "diff": "a\n"}, {"path": "/work/proj/gone.txt", "kind": {"type": "delete"}, "diff": "bye\n"}, {"path": "/work/proj/mid dir/mu.txt", "kind": {"type": "add"}, "diff": "m\n"}, {"path": "/work/proj/mv-src.txt", "kind": {"type": "update", "move_path": "/work/proj/mv-dst.txt"}, "diff": "@@ -1 +1 @@\n-one\n+two\n\n\nMoved to: /work/proj/mv-dst.txt"}, {"path": "/work/proj/zeta.txt", "kind": {"type": "add"}, "diff": "z\n"}], "status": "inProgress"},
    {"type": "fileChange", "id": "exec-df20ff01-890b-4fe4-8e78-419a64fcdc2f", "changes": [{"path": "/work/proj/a.txt", "kind": {"type": "update", "move_path": null}, "diff": "@@ -1,2 +1,2 @@\n-old\n+new\n line2\n"}, {"path": "/work/proj/alpha.txt", "kind": {"type": "add"}, "diff": "a\n"}, {"path": "/work/proj/gone.txt", "kind": {"type": "delete"}, "diff": "bye\n"}, {"path": "/work/proj/mid dir/mu.txt", "kind": {"type": "add"}, "diff": "m\n"}, {"path": "/work/proj/mv-src.txt", "kind": {"type": "update", "move_path": "/work/proj/mv-dst.txt"}, "diff": "@@ -1 +1 @@\n-one\n+two\n\n\nMoved to: /work/proj/mv-dst.txt"}, {"path": "/work/proj/zeta.txt", "kind": {"type": "add"}, "diff": "z\n"}], "status": "completed"},
  ],
  [
    {"type": "ImageView", "id": "exec-293474d2-3d3b-4762-b8c1-ccf048b24c84", "path": "file:///work/proj/pic%20dir/shot%20%C3%A9.png"},
    {"type": "imageView", "id": "exec-293474d2-3d3b-4762-b8c1-ccf048b24c84", "path": "/work/proj/pic dir/shot é.png"},
    {"type": "imageView", "id": "exec-293474d2-3d3b-4762-b8c1-ccf048b24c84", "path": "/work/proj/pic dir/shot é.png"},
  ],
  [
    {"type": "CommandExecution", "id": "f8b963f9-777d-4f05-b4a0-5b33902aa2db", "command": ["/bin/bash", "-lc", "echo $SHELL_X; exit 4"], "cwd": "file:///work/proj", "parsed_cmd": [{"type": "unknown", "cmd": "echo $SHELL_X; exit 4"}], "source": "user_shell", "status": "failed", "stdout": "\n", "stderr": "", "aggregated_output": "\n", "exit_code": 4, "duration": {"secs": 0, "nanos": 8547511}, "formatted_output": "\n"},
    {"type": "commandExecution", "id": "f8b963f9-777d-4f05-b4a0-5b33902aa2db", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc 'echo $SHELL_X; exit 4'", "cwd": "/work/proj", "processId": null, "source": "userShell", "status": "inProgress", "commandActions": [{"type": "unknown", "command": "echo $SHELL_X; exit 4"}], "aggregatedOutput": null, "exitCode": null, "durationMs": null},
    {"type": "commandExecution", "id": "f8b963f9-777d-4f05-b4a0-5b33902aa2db", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc 'echo $SHELL_X; exit 4'", "cwd": "/work/proj", "processId": null, "source": "userShell", "status": "failed", "commandActions": [{"type": "unknown", "command": "echo $SHELL_X; exit 4"}], "aggregatedOutput": "\n", "exitCode": 4, "durationMs": 8},
  ],
  [
    {"type": "FileChange", "id": "exec-e00f2d5d-5928-42fd-9461-295747da2a0b", "changes": {"/work/proj/😀.txt": {"type": "add", "content": "x\n"}, "/work/proj/.txt": {"type": "add", "content": "x\n"}, "/work/proj/q/r.txt": {"type": "add", "content": "x\n"}, "/work/proj/é.txt": {"type": "add", "content": "x\n"}, "/work/proj/q/a-b.txt": {"type": "add", "content": "x\n"}, "/work/proj/q-r.txt": {"type": "add", "content": "x\n"}, "/work/proj/sub/m1.txt": {"type": "update", "unified_diff": "@@ -1 +1 @@\n-one\n+two\n", "move_path": "/work/proj/sub/m2.txt"}, "/work/proj/q r.txt": {"type": "add", "content": "x\n"}, "/work/proj/z.txt": {"type": "add", "content": "x\n"}, "/work/proj/q/a/b.txt": {"type": "add", "content": "x\n"}, "/work/proj/Q.txt": {"type": "add", "content": "x\n"}, "/work/proj/q.txt": {"type": "add", "content": "x\n"}}, "status": "completed", "stdout": "Success. Updated the following files:\nA q-r.txt\nA q/r.txt\nA q.txt\nA Q.txt\nA é.txt\nA z.txt\nA q r.txt\nA q/a-b.txt\nA q/a/b.txt\nA 😀.txt\nA .txt\nM sub/m2.txt\n", "stderr": ""},
    {"type": "fileChange", "id": "exec-e00f2d5d-5928-42fd-9461-295747da2a0b", "changes": [{"path": "/work/proj/Q.txt", "kind": {"type": "add"}, "diff": "x\n"}, {"path": "/work/proj/q r.txt", "kind": {"type": "add"}, "diff": "x\n"}, {"path": "/work/proj/q-r.txt", "kind": {"type": "add"}, "diff": "x\n"}, {"path": "/work/proj/q.txt", "kind": {"type": "add"}, "diff": "x\n"}, {"path": "/work/proj/q/a-b.txt", "kind": {"type": "add"}, "diff": "x\n"}, {"path": "/work/proj/q/a/b.txt", "kind": {"type": "add"}, "diff": "x\n"}, {"path": "/work/proj/q/r.txt", "kind": {"type": "add"}, "diff": "x\n"}, {"path": "/work/proj/sub/m1.txt", "kind": {"type": "update", "move_path": "/work/proj/sub/m2.txt"}, "diff": "@@ -1 +1 @@\n-one\n+two\n\n\nMoved to: /work/proj/sub/m2.txt"}, {"path": "/work/proj/z.txt", "kind": {"type": "add"}, "diff": "x\n"}, {"path": "/work/proj/é.txt", "kind": {"type": "add"}, "diff": "x\n"}, {"path": "/work/proj/.txt", "kind": {"type": "add"}, "diff": "x\n"}, {"path": "/work/proj/😀.txt", "kind": {"type": "add"}, "diff": "x\n"}], "status": "inProgress"},
    {"type": "fileChange", "id": "exec-e00f2d5d-5928-42fd-9461-295747da2a0b", "changes": [{"path": "/work/proj/Q.txt", "kind": {"type": "add"}, "diff": "x\n"}, {"path": "/work/proj/q r.txt", "kind": {"type": "add"}, "diff": "x\n"}, {"path": "/work/proj/q-r.txt", "kind": {"type": "add"}, "diff": "x\n"}, {"path": "/work/proj/q.txt", "kind": {"type": "add"}, "diff": "x\n"}, {"path": "/work/proj/q/a-b.txt", "kind": {"type": "add"}, "diff": "x\n"}, {"path": "/work/proj/q/a/b.txt", "kind": {"type": "add"}, "diff": "x\n"}, {"path": "/work/proj/q/r.txt", "kind": {"type": "add"}, "diff": "x\n"}, {"path": "/work/proj/sub/m1.txt", "kind": {"type": "update", "move_path": "/work/proj/sub/m2.txt"}, "diff": "@@ -1 +1 @@\n-one\n+two\n\n\nMoved to: /work/proj/sub/m2.txt"}, {"path": "/work/proj/z.txt", "kind": {"type": "add"}, "diff": "x\n"}, {"path": "/work/proj/é.txt", "kind": {"type": "add"}, "diff": "x\n"}, {"path": "/work/proj/.txt", "kind": {"type": "add"}, "diff": "x\n"}, {"path": "/work/proj/😀.txt", "kind": {"type": "add"}, "diff": "x\n"}], "status": "completed"},
  ],
  [
    {"type": "CommandExecution", "id": "exec-05dbc9fb-e054-41c2-97aa-18fe5a2a804c", "process_id": "31641", "command": ["/bin/bash", "-lc", "cat ./a.txt"], "cwd": "file:///work/proj", "parsed_cmd": [{"type": "read", "cmd": "cat ./a.txt", "name": "a.txt", "path": "./a.txt"}], "source": "unified_exec_startup", "status": "completed", "stdout": "old\n", "stderr": "", "aggregated_output": "old\n", "exit_code": 0, "duration": {"secs": 0, "nanos": 31451}, "formatted_output": "old\n"},
    {"type": "commandExecution", "id": "exec-05dbc9fb-e054-41c2-97aa-18fe5a2a804c", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc 'cat ./a.txt'", "cwd": "/work/proj", "processId": "31641", "source": "unifiedExecStartup", "status": "inProgress", "commandActions": [{"type": "read", "command": "cat ./a.txt", "name": "a.txt", "path": "/work/proj/a.txt"}], "aggregatedOutput": null, "exitCode": null, "durationMs": null},
    {"type": "commandExecution", "id": "exec-05dbc9fb-e054-41c2-97aa-18fe5a2a804c", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc 'cat ./a.txt'", "cwd": "/work/proj", "processId": "31641", "source": "unifiedExecStartup", "status": "completed", "commandActions": [{"type": "read", "command": "cat ./a.txt", "name": "a.txt", "path": "/work/proj/a.txt"}], "aggregatedOutput": "old\n", "exitCode": 0, "durationMs": 0},
  ],
  [
    {"type": "CommandExecution", "id": "exec-0c6998da-ce43-4029-827e-5eb9e2df3c5e", "process_id": "86436", "command": ["/bin/bash", "-lc", "cat sub/../a.txt"], "cwd": "file:///work/proj", "parsed_cmd": [{"type": "read", "cmd": "cat sub/../a.txt", "name": "a.txt", "path": "sub/../a.txt"}], "source": "unified_exec_startup", "status": "completed", "stdout": "old\n", "stderr": "", "aggregated_output": "old\n", "exit_code": 0, "duration": {"secs": 0, "nanos": 24001}, "formatted_output": "old\n"},
    {"type": "commandExecution", "id": "exec-0c6998da-ce43-4029-827e-5eb9e2df3c5e", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc 'cat sub/../a.txt'", "cwd": "/work/proj", "processId": "86436", "source": "unifiedExecStartup", "status": "inProgress", "commandActions": [{"type": "read", "command": "cat sub/../a.txt", "name": "a.txt", "path": "/work/proj/a.txt"}], "aggregatedOutput": null, "exitCode": null, "durationMs": null},
    {"type": "commandExecution", "id": "exec-0c6998da-ce43-4029-827e-5eb9e2df3c5e", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc 'cat sub/../a.txt'", "cwd": "/work/proj", "processId": "86436", "source": "unifiedExecStartup", "status": "completed", "commandActions": [{"type": "read", "command": "cat sub/../a.txt", "name": "a.txt", "path": "/work/proj/a.txt"}], "aggregatedOutput": "old\n", "exitCode": 0, "durationMs": 0},
  ],
  [
    {"type": "CommandExecution", "id": "exec-9ceaedf0-a8c5-459a-a7c5-4ca468c5226a", "process_id": "44046", "command": ["/bin/bash", "-lc", "cat a.txt"], "cwd": "file:///work/proj/sub", "parsed_cmd": [{"type": "read", "cmd": "cat a.txt", "name": "a.txt", "path": "a.txt"}], "source": "unified_exec_startup", "status": "completed", "stdout": "sub a\n", "stderr": "", "aggregated_output": "sub a\n", "exit_code": 0, "duration": {"secs": 0, "nanos": 19860}, "formatted_output": "sub a\n"},
    {"type": "commandExecution", "id": "exec-9ceaedf0-a8c5-459a-a7c5-4ca468c5226a", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc 'cat a.txt'", "cwd": "/work/proj/sub", "processId": "44046", "source": "unifiedExecStartup", "status": "inProgress", "commandActions": [{"type": "read", "command": "cat a.txt", "name": "a.txt", "path": "/work/proj/sub/a.txt"}], "aggregatedOutput": null, "exitCode": null, "durationMs": null},
    {"type": "commandExecution", "id": "exec-9ceaedf0-a8c5-459a-a7c5-4ca468c5226a", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc 'cat a.txt'", "cwd": "/work/proj/sub", "processId": "44046", "source": "unifiedExecStartup", "status": "completed", "commandActions": [{"type": "read", "command": "cat a.txt", "name": "a.txt", "path": "/work/proj/sub/a.txt"}], "aggregatedOutput": "sub a\n", "exitCode": 0, "durationMs": 0},
  ],
  [
    {"type": "McpToolCall", "id": "exec-ac6157df-19bd-42cc-a7c9-22cc44df13c4", "server": "fake", "tool": "lookup", "arguments": {"query": "alpha", "topn": 2}, "status": "completed", "result": {"content": [{"type": "text", "text": "found alpha"}], "structuredContent": {"hits": [{"title": "one"}], "total": 1}, "isError": false}, "duration": {"secs": 0, "nanos": 1113078}},
    {"type": "mcpToolCall", "id": "exec-ac6157df-19bd-42cc-a7c9-22cc44df13c4", "server": "fake", "tool": "lookup", "status": "inProgress", "arguments": {"query": "alpha", "topn": 2}, "appContext": null, "mcpAppUi": null, "pluginId": null, "readOnlyHint": null, "result": null, "error": null, "durationMs": null},
    {"type": "mcpToolCall", "id": "exec-ac6157df-19bd-42cc-a7c9-22cc44df13c4", "server": "fake", "tool": "lookup", "status": "completed", "arguments": {"query": "alpha", "topn": 2}, "appContext": null, "mcpAppUi": null, "pluginId": null, "readOnlyHint": null, "result": {"content": [{"type": "text", "text": "found alpha"}], "structuredContent": {"hits": [{"title": "one"}], "total": 1}, "_meta": null}, "error": null, "durationMs": 1},
  ],
  [
    {"type": "McpToolCall", "id": "exec-934a0235-d025-4829-a043-a7bdeec28c7c", "server": "fake", "tool": "flaky", "arguments": {}, "status": "failed", "result": {"content": [{"type": "text", "text": "tool said no"}], "isError": true}, "duration": {"secs": 0, "nanos": 671251}},
    {"type": "mcpToolCall", "id": "exec-934a0235-d025-4829-a043-a7bdeec28c7c", "server": "fake", "tool": "flaky", "status": "inProgress", "arguments": {}, "appContext": null, "mcpAppUi": null, "pluginId": null, "readOnlyHint": null, "result": null, "error": null, "durationMs": null},
    {"type": "mcpToolCall", "id": "exec-934a0235-d025-4829-a043-a7bdeec28c7c", "server": "fake", "tool": "flaky", "status": "failed", "arguments": {}, "appContext": null, "mcpAppUi": null, "pluginId": null, "readOnlyHint": null, "result": {"content": [{"type": "text", "text": "tool said no"}], "structuredContent": null, "_meta": null}, "error": null, "durationMs": 0},
  ],
  [
    {"type": "McpToolCall", "id": "exec-722638a2-9760-43ed-9003-6f3fb3cf6aca", "server": "fake", "tool": "broken", "arguments": {}, "status": "failed", "error": {"message": "tool call error: tool call failed for `fake/broken`\n\nCaused by:\n    Mcp error: -32000: protocol failure"}, "duration": {"secs": 0, "nanos": 629511}},
    {"type": "mcpToolCall", "id": "exec-722638a2-9760-43ed-9003-6f3fb3cf6aca", "server": "fake", "tool": "broken", "status": "inProgress", "arguments": {}, "appContext": null, "mcpAppUi": null, "pluginId": null, "readOnlyHint": null, "result": null, "error": null, "durationMs": null},
    {"type": "mcpToolCall", "id": "exec-722638a2-9760-43ed-9003-6f3fb3cf6aca", "server": "fake", "tool": "broken", "status": "failed", "arguments": {}, "appContext": null, "mcpAppUi": null, "pluginId": null, "readOnlyHint": null, "result": null, "error": {"message": "tool call error: tool call failed for `fake/broken`\n\nCaused by:\n    Mcp error: -32000: protocol failure"}, "durationMs": 0},
  ],
];
{
  const canon = (value: unknown): string => JSON.stringify(value, (_key, v) => (
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
      : v
  ));
  const mismatched = APP_SERVER_TOOL_ITEMS.filter(([record, started, completed]) => {
    const converted = codexRolloutToolItem(record);
    return !converted || canon(converted.started) !== canon(started) || canon(converted.completed) !== canon(completed);
  });
  check(
    'tool items: each rollout record converts to exactly the started and completed items the app-server streamed',
    APP_SERVER_TOOL_ITEMS.length === 23 && mismatched.length === 0,
    mismatched.map(([record, , completed]) => {
      const converted = codexRolloutToolItem(record);
      return `${record.id}: expected ${canon(completed).slice(0, 300)} got ${canon(converted?.completed).slice(0, 300)}`;
    }).join(' | '),
  );

  const turn = '01a0defd-e83e-78a3-82d8-30487a0277bc';
  const done = (item: any) => ({ type: 'event_msg', payload: { type: 'item_completed', thread_id: 't', turn_id: turn, started_at_ms: 1, completed_at_ms: 2, item } });
  const lines: any[] = [
    { type: 'session_meta', payload: { id: 'thread-tools', cwd: '/work/proj' } },
    { timestamp: '2026-09-26T10:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'go' } },
    { timestamp: '2026-09-26T10:00:01.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: turn } },
    // A model-issued call: its item_completed record repeats it and must add nothing.
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call_model1', arguments: JSON.stringify({ cmd: 'ls' }) } },
    done({ ...APP_SERVER_TOOL_ITEMS[0]![0], id: 'call_model1', source: 'unified_exec_startup' }),
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_model1', output: 'a\n' } },
    // The same for a provider whose call ids do not start with `call_`.
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'fc-other-1', input: '*** Begin Patch\n*** End Patch\n', status: 'completed' } },
    done({ ...APP_SERVER_TOOL_ITEMS[16]![0], id: 'fc-other-1' }),
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'fc-other-1', output: 'ok' } },
    // A code-mode cell and the nested calls it made.
    { type: 'response_item', payload: { type: 'custom_tool_call', status: 'completed', call_id: 'call_cell1', name: 'exec', input: 'await tools.exec_command({ cmd: "ls" })' } },
    ...APP_SERVER_TOOL_ITEMS.map(([record]) => done(record)),
    done({ type: 'Extension', id: 'exec-5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e', kind: 'web.search', query: 'weather', action: { type: 'search', query: 'weather', queries: ['weather'] }, results: [{ type: 'page', ref_id: 'r1', title: 'Weather', url: 'https://example.com/', domain: 'example.com', snippet: 'sunny' }] }),
    done({ type: 'Extension', id: 'exec-6e6e6e6e-6e6e-4e6e-8e6e-6e6e6e6e6e6e', kind: 'clock.sleep', durationMs: 100 }),
    done({ type: 'SubAgentActivity', id: '7e7e7e7e-7e7e-4e7e-8e7e-7e7e7e7e7e7e', kind: 'started', agent_path: 'a', agent_thread_id: 'b' }),
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_cell1', output: [{ type: 'input_text', text: 'Script completed' }] } },
    { timestamp: '2026-09-26T10:00:09.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: turn } },
  ];
  const nestedIds = [
    ...APP_SERVER_TOOL_ITEMS.map(([record]) => String(record.id)),
    'exec-5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e',
  ];
  const tools = (rows: AgentMessage[]) => rows
    .filter((m) => m.type === 'tool-call' || m.type === 'tool-result')
    .map((m: any) => `${m.type}:${m.callId}`);
  const mapped = mapRollout(lines);
  const rows = tools(mapped);
  check(
    'tool items: each nested or user shell item yields one tool-call then one tool-result under its own id, in rollout order',
    JSON.stringify(rows) === JSON.stringify([
      'tool-call:call_model1', 'tool-result:call_model1',
      'tool-call:fc-other-1', 'tool-result:fc-other-1',
      'tool-call:call_cell1',
      ...nestedIds.flatMap((id) => [`tool-call:${id}`, `tool-result:${id}`]),
      'tool-result:call_cell1',
    ]),
    JSON.stringify(rows),
  );
  const byId = (id: string, type: string) => mapped.find((m: any) => m.callId === id && m.type === type) as any;
  const quoted = byId(APP_SERVER_TOOL_ITEMS[1]![0].id, 'tool-call');
  const moved = byId(APP_SERVER_TOOL_ITEMS[16]![0].id, 'tool-result');
  const mcp = byId(APP_SERVER_TOOL_ITEMS[20]![0].id, 'tool-result');
  const search = byId('exec-5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e', 'tool-result');
  check(
    'tool items: the rows carry what the live rows carry (quoted command, decoded paths, sorted changes, MCP result)',
    quoted?.title === APP_SERVER_TOOL_ITEMS[1]![2].command
      && quoted?.args?.cwd === '/work/proj'
      && Array.isArray(moved?.fileChanges) && moved.fileChanges.length >= 2
      && moved.fileChanges.map((c: any) => c.path).join('|') === [...moved.fileChanges.map((c: any) => c.path)].sort((a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))).join('|')
      && mcp?.result?.isError === undefined && mcp?.toolName === 'fake.lookup'
      && search?.toolName === 'web_search',
    JSON.stringify({ title: quoted?.title, cwd: quoted?.args?.cwd, moved: moved?.fileChanges?.map((c: any) => c.path), mcp: mcp?.result, search: search?.toolName }),
  );
  // A read that starts after a model-issued call (an attach boundary between the two records)
  // still adds nothing for its `item_completed` record.
  const split = tools(mapRollout(lines.slice(4)));
  check(
    'tool items: a read starting between a model call and its item_completed adds no row for that call',
    split.filter((row) => row.endsWith(':call_model1')).join(',') === 'tool-result:call_model1',
    JSON.stringify(split.filter((row) => row.endsWith(':call_model1'))),
  );

  // The indexed attach and native pages rebuild each row from its record alone: the same rows as a
  // full read. A cursor issued before these rows existed is refused past the first one.
  const dir = mkdtempSync(join(tmpdir(), 'cosyncing-tool-items-'));
  const path = join(dir, 'rollout-tool-items.jsonl');
  const filler = Array.from({ length: 20 }, (_, index) => [
    { type: 'event_msg', payload: { type: 'agent_message', message: `filler ${index}` } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', id: `msg_t${index}`, content: [{ type: 'output_text', text: `filler ${index}` }] } },
  ]).flat();
  const fileLines = [...lines.slice(0, 3), ...filler, ...lines.slice(3)];
  try {
    writeFileSync(path, `${fileLines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    const builder = new IndexedHistoryPageCacheBuilder();
    const sink: HistorySnapshotSink = {
      acceptsLocations: true,
      accept: (message: AgentMessage, location?: number) => builder.accept(message, location),
    };
    const captured = await captureFileHistoryInto(path, sink);
    const cache = captured && !('refusal' in captured) && captured.reader
      ? builder.finish(captured.identity, captured.reader)
      : undefined;
    const paged: AgentMessage[] = [];
    if (cache) {
      const attach = await cache.loadAttach(undefined, 10);
      if (!('kind' in attach)) {
        paged.push(...attach.messages);
        let cursor = attach.olderCursor;
        while (cursor) {
          const page = await cache.loadPage(cursor, 7);
          if ('kind' in page || page.gap) break;
          paged.unshift(...page.messages);
          cursor = page.cursor;
        }
      }
    }
    const full = mapRollout(fileLines).filter((m) => m.type === 'tool-call' || m.type === 'tool-result');
    const pagedTools = paged.filter((m) => m.type === 'tool-call' || m.type === 'tool-result');
    check(
      'tool items: the indexed attach and native pages return the same tool rows as a full read',
      pagedTools.length === full.length && canon(pagedTools) === canon(full),
      `paged=${pagedTools.length} full=${full.length}`,
    );

    const isNew = (m: any) => (m.type === 'tool-call' || m.type === 'tool-result') && nestedIds.includes(m.callId);
    const before = cursorDurableHistory(mapRollout(fileLines).filter((m) => !isNew(m))).durable;
    const firstNew = cursorDurableHistory(mapRollout(fileLines)).durable.findIndex(isNew);
    let misplaced = 0;
    let refused = 0;
    const codes = new Set<string>();
    if (cache) {
      for (let boundary = 1; boundary <= before.length; boundary += 1) {
        const page = await cache.loadPage(backwardHistoryCursor(before, boundary), 5);
        const gap = 'kind' in page ? page.kind : page.gap?.code;
        if (gap) {
          refused += 1;
          codes.add(gap);
          if (boundary <= firstNew) misplaced += 1;
        } else if (boundary > firstNew) {
          misplaced += 1;
        }
      }
    }
    check(
      'tool items: a cursor issued before these rows existed is refused past the first one and honoured before it',
      Boolean(cache) && firstNew > 0 && misplaced === 0 && refused === before.length - firstNew
        && [...codes].every((code) => code === 'HISTORY_CURSOR_DIVERGED' || code === 'HISTORY_CURSOR_GONE'),
      `first=${firstNew} misplaced=${misplaced} refused=${refused}/${before.length} codes=${[...codes].join(',')}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// Observe tails the rollout live: a nested call tailed after the attach carries the rows a later
// history read of the settled file gives it.
await (async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cosyncing-tool-items-tail-'));
  const path = join(dir, 'rollout-2026-09-26T00-00-00-00000000-0000-4000-8000-0000000000e1.jsonl');
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;
  writeFileSync(
    path,
    line({ type: 'session_meta', payload: { id: '00000000-0000-4000-8000-0000000000e1', cwd: dir } })
      + line({ type: 'event_msg', payload: { type: 'user_message', message: 'prompt' } })
      + line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-tool-tail' } })
      + line({ type: 'response_item', payload: { type: 'custom_tool_call', status: 'completed', call_id: 'call_cell_tail', name: 'exec', input: 'x' } }),
  );
  const messages: any[] = [];
  const conn = await new CodexAdapter().attach(Buffer.from(path, 'utf8').toString('base64url'), 'observe');
  const unsubscribe = conn.subscribe((m: any) => messages.push(m));
  const tailed = () => messages.filter((m) => (m.type === 'tool-call' || m.type === 'tool-result') && m.callId !== 'call_cell_tail');
  try {
    const [record] = APP_SERVER_TOOL_ITEMS[16]!;
    appendFileSync(path, line({ type: 'event_msg', payload: { type: 'item_completed', thread_id: 't', turn_id: 'turn-tool-tail', started_at_ms: 1, completed_at_ms: 2, item: record } }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && tailed().length < 2) await new Promise((r) => setTimeout(r, 25));
    const history = ((await conn.getHistory()) as any[])
      .filter((m) => (m.type === 'tool-call' || m.type === 'tool-result') && m.callId !== 'call_cell_tail');
    check(
      'tool items: a tailed nested call and the later history read of it are the same rows',
      tailed().length === 2 && tailed()[0]?.callId === record.id
        && JSON.stringify(history) === JSON.stringify(tailed()),
      `tail=${JSON.stringify(tailed().map((m) => `${m.type}:${m.callId}`))} history=${JSON.stringify(history.map((m) => `${m.type}:${m.callId}`))}`,
    );
  } finally {
    unsubscribe();
    await conn.close();
    rmSync(dir, { recursive: true, force: true });
  }
})();
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
      // Memory, not wall time, shows the source was never read: reading it would hold 256 MiB.
      const attachRssBefore = process.memoryUsage().rss;
      const hugeConn: any = await adapter.attach(
        Buffer.from(huge, 'utf8').toString('base64url'),
        'observe',
      );
      const attachRssGrowth = Math.max(
        0,
        process.memoryUsage().rss - attachRssBefore,
      );
      try {
        const captureRssBefore = process.memoryUsage().rss;
        const refused = await hugeConn.captureHistorySnapshot?.(new CollectingSink());
        const captureRssGrowth = Math.max(
          0,
          process.memoryUsage().rss - captureRssBefore,
        );
        check(
          'a source past the capture ceiling is refused as a resource limit, not a source change',
          isHistorySnapshotRefusal(refused) && refused.refusal === 'resource-limit',
          JSON.stringify(refused),
        );
        check(
          'the refusal is decided from the stat, without reading the source',
          captureRssGrowth < 64 * 1024 * 1024,
          `rssGrowth=${captureRssGrowth}`,
        );
        check(
          'observe attach does not materialize a source before the capture ceiling can refuse it',
          attachRssGrowth < 64 * 1024 * 1024,
          `rssGrowth=${attachRssGrowth}`,
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
    // PR-2b: measured reload shape — answered, two empty Stop turns, answered.
    const stopped = (turnId: string) => [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
      { type: 'event_msg', payload: { type: 'user_message', message: `stop ${turnId}` } },
      { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: turnId, reason: 'interrupted' } },
    ];
    const out = mapRollout([
      ...turn('answered-before', 'first', 'before-answer', 'first reply'),
      ...stopped('stop-app'),
      ...stopped('stop-terminal'),
      ...turn('answered-after', 'last', 'after-answer', 'last reply'),
    ]);
    const summaries = out.filter((m): m is Extract<AgentMessage, { type: 'run-summary' }> => m.type === 'run-summary' && m.status !== 'running');
    check(
      'PR-2b answered and empty stopped turns own only their own assistant keys',
      summaries.length === 4 && summaries.every((run) =>
        run.userMessageKey === `codex:${run.turnId}:u0`
        && run.status === (run.turnId.startsWith('stop-') ? 'cancelled' : 'done')
        && run.assistantMessageKey === (
          run.turnId === 'answered-before' ? 'codex:answered-before:before-answer:t'
          : run.turnId === 'answered-after' ? 'codex:answered-after:after-answer:t'
          : undefined
        )),
      JSON.stringify(summaries),
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
    check(
      'cold rollout proof identifies the exact completed turn for live-owner repair',
      await rolloutHasExactTerminalTurn(path, 't2')
        && !await rolloutHasExactTerminalTurn(path, 't1'),
    );
    appendFileSync(path, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't2' } }) + '\n');
    check('a duplicate matching terminal cannot create a second status transition', await inferRolloutStatus(path) === 'idle', await inferRolloutStatus(path));

    appendFileSync(path, JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't3' } }) + '\n');
    check(
      'cold rollout proof refuses a completed older turn while a newer turn is open',
      !await rolloutHasExactTerminalTurn(path, 't2')
        && !await rolloutHasExactTerminalTurn(path, 't3'),
    );

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
        && ticks > 0,
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
        // A loaded host can reach the 1 s budget before the 64 MiB one; both are bounded work.
        && (bounded.reason === 'source-limit' || bounded.reason === 'time-limit')
        && bounded.scannedBytes > 0
        && bounded.scannedBytes <= 64 * 1024 * 1024
        && ticks > 0,
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
  const previousSocket = process.env.COSYNCING_CODEX_APP_SERVER_SOCK;
  try {
    // Drive availability is what this fixture exercises. Do not inherit the
    // developer or hosted runner's Codex installation as an undeclared test
    // prerequisite; Observe never executes this inert binary.
    writeFileSync(fakeCodex, '#!/bin/sh\nexit 0\n');
    chmodSync(fakeCodex, 0o755);
    process.env.COSYNCING_CODEX_BIN = fakeCodex;
    process.env.COSYNCING_CODEX_APP_SERVER_SOCK = join(dir, 'absent.sock');
    writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { cwd: dir, id: '019ed00e-aac3-78f1-b373-cd365cf6a9b2' } }) + '\n');
    const conn = await new CodexAdapter().attach(Buffer.from(path, 'utf8').toString('base64url'));
    try {
      check('default Codex attach is observe/read-only even when idle', conn.info.attachMode === 'observe', conn.info.attachMode);
      check('default Codex control state is observing and drivable', conn.info.control?.drive.state === 'observing' && conn.info.control?.drive.supported === true, JSON.stringify(conn.info.control?.drive));
      check(
        syncServerEnabled ? 'Codex sync is unavailable when the shared daemon socket is absent' : 'Codex true-sync state is explicit even when disabled',
        conn.info.control?.terminalSync.active === false && conn.info.control?.terminalSync.supported === false
          && (!syncServerEnabled || /daemon/.test(conn.info.control?.terminalSync.reason ?? '')),
        JSON.stringify(conn.info.control?.terminalSync),
      );
    } finally {
      await conn.close();
    }
  } finally {
    if (previousBin == null) delete process.env.COSYNCING_CODEX_BIN;
    else process.env.COSYNCING_CODEX_BIN = previousBin;
    if (previousSocket == null) delete process.env.COSYNCING_CODEX_APP_SERVER_SOCK;
    else process.env.COSYNCING_CODEX_APP_SERVER_SOCK = previousSocket;
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
    appendFileSync(
      path,
      line({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't-tail' } }) +
        line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't-empty-stop' } }) +
        line({ type: 'event_msg', payload: { type: 'user_message', message: 'Stop' } }) +
        line({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 't-empty-stop' } }),
    );
    const terminal = () => messages.filter((m) => m.type === 'run-summary' && m.status !== 'running');
    const finished = await settle(() => terminal().length === 2, 4000);
    check(
      'PR-2b a primed Observe turn keeps its own answer and the next empty Stop has none',
      finished && terminal()[0]?.turnId === 't-tail'
        && terminal()[0]?.status === 'done'
        && terminal()[0]?.assistantMessageKey === answers()[1]?.key
        && terminal()[1]?.turnId === 't-empty-stop'
        && terminal()[1]?.status === 'cancelled'
        && terminal()[1]?.assistantMessageKey === undefined,
      JSON.stringify(terminal()),
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
  const socketPath = join(dir, 'daemon.sock');
  // Loaded ids are injected below; the join offer also requires a real reachable socket.
  const socket = createServer((connection) => connection.end());

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.listen(socketPath, resolve);
    });
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
          COSYNCING_CODEX_APP_SERVER_SOCK: socketPath, // an explicit socket keeps discovery from managing a daemon
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
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
})();


const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
