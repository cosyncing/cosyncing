/**
 * Headless regression for the Claude Code adapter's OBSERVE mapping (transcript JSONL → canonical
 * messages). Two halves, both zero-cost (no `claude`, no daemon, no model):
 *
 *   1. Synthetic: a hand-built transcript exercising every trap the ground-truth investigation
 *      surfaced — the TOKEN-COUNT double-count (message.usage repeats byte-identically on every line
 *      of a multi-line turn → emit once per message.id), OLD-version multi-block-per-line packing
 *      (iterate content[], composite keys), tool-result enrichment from the TOP-LEVEL toolUseResult on
 *      the same user line (structuredPatch→diff, Read truncated, Bash has NO exitCode), tool_use_id→
 *      toolName correlation, meta/command-wrapper/isCompactSummary user filtering, compact_boundary→
 *      history-reset, and API-error→error. Sidecar line types must be skipped.
 *   2. Real-data smoke: discover the machine's actual Claude sessions (DEPTH-1 only — sub-agent files
 *      under <uuid>/subagents/ must be excluded) and getHistory() the newest, asserting it parses
 *      without throwing and yields only canonical types. Read-only; prints counts/types, not content.
 *   3. Cross-surface message identity: one logical model message must carry ONE key on the live
 *      stream, in a full history read, and on the Observe tail that continues after that read — the
 *      only way a client joining mid-turn stops seeing the same answer twice. Fixture shapes come from
 *      a captured real trace (message_start.message.id + per-block stream index; sibling transcript
 *      lines repeating that id, one content block each).
 *
 *   bun run packages/typescript/adapters/claude/test/test-claude-jsonl.ts      (exit 0 = all pass)
 */
export {};
import { writeFileSync, appendFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANONICAL_MESSAGE_TYPES, summarizeDiff } from '../../../adapter-api/src/index.ts';
import { ClaudeAdapter, ClaudeObserveConnection, ClaudeResumeConnection, mapTranscript, enrichClaudeToolResult, structuredPatchToDiff } from '../src/index.ts';
import type { ClaudeStore } from '../src/index.ts';
import type { AgentMessage, SessionInfo } from '../../../adapter-api/src/index.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ── 1. synthetic mapping ────────────────────────────────────────────────────────
{
  const u = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 };
  const lines: any[] = [
    // sidecar app-state — all skipped
    { type: 'ai-title', aiTitle: 'Test session', sessionId: 's1' },
    { type: 'custom-title', customTitle: 'Custom', sessionId: 's1' },
    { type: 'mode', mode: 'build', sessionId: 's1' },
    { type: 'permission-mode', permissionMode: 'default', sessionId: 's1' },
    { type: 'bridge-session', bridgeSessionId: 'cse_x', sessionId: 's1' },
    { type: 'file-history-snapshot', messageId: 'm0', isSnapshotUpdate: false },
    { type: 'attachment', uuid: 'att1', cwd: '/tmp/x', attachment: { type: 'deferred_tools_delta', addedNames: ['X'] } },
    // meta / command-wrapper user lines — skipped (must not render as user-message)
    { type: 'user', uuid: 'um1', isMeta: true, cwd: '/tmp/x', message: { role: 'user', content: '<local-command-caveat>Caveat: ...' } },
    { type: 'user', uuid: 'um2', cwd: '/tmp/x', message: { role: 'user', content: '<system-reminder>hi</system-reminder>' } },
    { type: 'user', uuid: 'um3', cwd: '/tmp/x', message: { role: 'user', content: '<command-name>/compact</command-name>' } },
    // a real user prompt
    { type: 'user', uuid: 'u1', cwd: '/tmp/x', message: { role: 'user', content: 'Please edit the file and run ls.' } },
    // ONE turn (message.id m1) split across 4 lines, usage on EVERY line → exactly ONE token-count
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-opus-4-8', stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: 'Let me think', signature: 'sig' }], usage: u } },
    { type: 'assistant', uuid: 'a2', message: { id: 'm1', stop_reason: 'tool_use', content: [{ type: 'text', text: 'I will edit it.' }], usage: u } },
    { type: 'assistant', uuid: 'a3', message: { id: 'm1', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: { file_path: '/tmp/x/a.ts' } }], usage: u } },
    { type: 'assistant', uuid: 'a4', message: { id: 'm1', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'ls' } }], usage: u } },
    // tool_result lines with rich detail in the TOP-LEVEL toolUseResult (same line, no cross-line map)
    {
      type: 'user',
      uuid: 'ur1',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_edit', content: 'ok' }] },
      toolUseResult: { filePath: '/tmp/x/a.ts', oldString: 'a', newString: 'b\nc', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' ctx', '-a', '+b', '+c'] }] },
    },
    {
      type: 'user',
      uuid: 'ur2',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'file1\nfile2', is_error: false }] },
      toolUseResult: { stdout: 'file1\nfile2', stderr: '', interrupted: false, isImage: false },
    },
    // final answer (NEW message.id m2)
    { type: 'assistant', uuid: 'a5', message: { id: 'm2', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 130, output_tokens: 8 } } },
    // OLD-version packing: text + tool_use in ONE line (message.id m3) → two messages from one line
    { type: 'assistant', uuid: 'a6', message: { id: 'm3', stop_reason: 'tool_use', content: [{ type: 'text', text: 'Reading now.' }, { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/tmp/x/a.ts' } }], usage: { input_tokens: 140, output_tokens: 10 } } },
    {
      type: 'user',
      uuid: 'ur3',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: '<file>' }] },
      toolUseResult: { type: 'text', file: { filePath: '/tmp/x/a.ts', numLines: 2, totalLines: 9999, startLine: 1, content: '…', truncatedByTokenCap: true } },
    },
    // compaction: system boundary → history-reset; injected fat summary user line → suppressed
    { type: 'system', subtype: 'compact_boundary', level: 'info', content: 'Conversation compacted', uuid: 'sys1', compactMetadata: { trigger: 'manual', preTokens: 500000, postTokens: 15000 } },
    { type: 'user', uuid: 'u-cs', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued from a previous conversation…' } },
    // local command output (Claude /compact "nothing to compact") → visible notice, not swallowed sidecar
    { type: 'system', subtype: 'local_command', level: 'info', content: '<local-command-stdout>Not enough messages to compact.</local-command-stdout>', uuid: 'sys-local' },
    // a SUCCESSFUL local command writes stdout as a USER line (verified real /compact) → notice too,
    // with the TUI's SGR color codes stripped; the command-name line becomes a clean user echo.
    { type: 'user', uuid: 'u-cmd', message: { role: 'user', content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>' } },
    { type: 'user', uuid: 'u-cmdout', message: { role: 'user', content: '<local-command-stdout>\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m</local-command-stdout>' } },
    { type: 'user', uuid: 'u-caveat', message: { role: 'user', content: '<local-command-caveat>Caveat: the messages below were generated…</local-command-caveat>' } },
    // a no-op system line → skipped
    { type: 'system', subtype: 'turn_duration', durationMs: 1234, uuid: 'sys2', messageCount: 5 },
    // an injected API-error assistant bubble → error (not model-output, not token-count)
    { type: 'assistant', uuid: 'a7', isApiErrorMessage: true, apiErrorStatus: 429, message: { id: 'm4', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit.\nReset at 5pm." }] } },
    // issues-part2: a message typed while a turn runs exists ONLY as this sidecar — the CLI can even
    // drop it silently (verified live 2.1.202: enqueue → remove, never a user line). Must render, and
    // (item-12 follow-up) as a KEYED queued bubble: a drop keeps it dimmed, a delivery clears it.
    { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-07-06T23:26:36.000Z', content: 'QUEUED-MSG mention this too' },
    { type: 'queue-operation', operation: 'remove', timestamp: '2026-07-06T23:26:56.000Z' },
    // harness-injected enqueues (task-notifications/system-reminders) stay suppressed
    { type: 'queue-operation', operation: 'enqueue', content: '<task-notification>\n<task-id>x</task-id>\n</task-notification>' },
    // item-12 follow-up, DELIVERED case (real shape probed 2.1.207: enqueue → dequeue → user line with
    // the same text): the user line must TAKE OVER the enqueue bubble's key so the queued style clears.
    { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-07-06T23:27:00.000Z', content: 'QUEUED-DELIVERED run the tests' },
    { type: 'queue-operation', operation: 'dequeue', timestamp: '2026-07-06T23:27:10.000Z' },
    { type: 'user', uuid: 'u-qd', timestamp: '2026-07-06T23:27:10.100Z', message: { role: 'user', content: 'QUEUED-DELIVERED run the tests' } },
    // cardinality (lessons §F): two IDENTICAL queued texts must stay two distinct bubbles, matched FIFO
    { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-07-06T23:28:00.000Z', content: 'same words' },
    { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-07-06T23:28:01.000Z', content: 'same words' },
    { type: 'user', uuid: 'u-qs1', timestamp: '2026-07-06T23:28:02.000Z', message: { role: 'user', content: 'same words' } },
    { type: 'user', uuid: 'u-qs2', timestamp: '2026-07-06T23:28:03.000Z', message: { role: 'user', content: 'same words' } },
    // a DRIVEN-session enqueue carries NO content field at all (probed 2.1.207) → nothing rendered
    { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-07-06T23:29:00.000Z' },
    // issues-part2: Esc-interrupt markers (string AND array-content forms) → a notice, not a fake prompt
    { type: 'user', uuid: 'u-int1', message: { role: 'user', content: '[Request interrupted by user]' } },
    { type: 'user', uuid: 'u-int2', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } },
  ];

  const out = mapTranscript(lines);
  const of = (t: string) => out.filter((m) => m.type === t) as any[];

  // token-count emitted ONCE per message.id (m1 spans 4 lines, all with usage). m1,m2,m3 → 3.
  // m4 is the API-error line → error, never a token-count. A naive per-line emit would yield 6+.
  check('token-count deduped per message.id (3, not per-line)', of('token-count').length === 3, `got ${of('token-count').length}`);
  const tc1 = of('token-count').find((m) => m.input === 100);
  check('token-count m1 mapped (input100/output20/cacheRead5/cacheWrite2, emitted once)', !!tc1 && tc1.output === 20 && tc1.cacheRead === 5 && tc1.cacheWrite === 2, JSON.stringify(tc1));

  // user-message: the real prompt plus CLEAN slash-command echoes (round 4: a /compact run in the
  // terminal used to vanish entirely); meta/compact-summary/caveat lines stay filtered.
  const userTexts = of('user-message').map((m) => m.text);
  check('user-message: real prompt kept + clean command echoes, no raw XML', userTexts.includes('Please edit the file and run ls.') && userTexts.filter((t: string) => t === '/compact').length === 2 && !userTexts.some((t: string) => t.includes('<')), JSON.stringify(userTexts));

  // thinking once (signature dropped, text only). a1 is m1's FIRST content block, so its key is the
  // canonical one the live stream builds from message.id + the block's stream index — not the line uuid.
  check('thinking once (signature dropped), keyed claude:<message.id>:<ordinal>:r', of('thinking').length === 1 && of('thinking')[0].text === 'Let me think' && of('thinking')[0].key === 'claude:m1:0:r', JSON.stringify(of('thinking')));

  // model-output: 'I will edit it.' (a2), 'Done.' (a5), 'Reading now.' (a6:0) — the API-error text is NOT one
  check('model-output ×3 (api-error text excluded)', of('model-output').length === 3 && of('model-output').every((m) => m.final === true), JSON.stringify(of('model-output').map((m) => m.text)));

  // multi-block line a6 → model-output + tool-call (toolu_read) from ONE line; the text is m3's block 0
  const mo6 = of('model-output').find((m) => m.text === 'Reading now.');
  check('multi-block line: model-output keyed claude:<message.id>:<ordinal>:t (m3 block 0)', !!mo6 && mo6.key === 'claude:m3:0:t', JSON.stringify(mo6));

  // tool-call ×3 with names recovered
  check('tool-call ×3 (Edit/Bash/Read), Read from the multi-block line', of('tool-call').length === 3 && of('tool-call').map((m) => m.toolName).join(',') === 'Edit,Bash,Read', JSON.stringify(of('tool-call').map((m) => `${m.toolName}#${m.callId}`)));
  check('Claude owns canonical tool display classes (edit/execute/lookup)', of('tool-call').map((m) => m.toolClass).join(',') === 'edit,execute,lookup', JSON.stringify(of('tool-call')));

  const tr = of('tool-result');
  const edit = tr.find((m) => m.callId === 'toolu_edit');
  const bash = tr.find((m) => m.callId === 'toolu_bash');
  const read = tr.find((m) => m.callId === 'toolu_read');
  // Edit: toolName via tool_use_id→name map; path/diff/±/title from the SAME-line toolUseResult.structuredPatch
  check('tool-result Edit enriched (name via id-map, path+diffstat+title from structuredPatch)', !!edit && edit.toolName === 'Edit' && edit.path === '/tmp/x/a.ts' && edit.additions === 2 && edit.deletions === 1 && edit.title === 'Edited a.ts' && edit.isError === false, JSON.stringify(edit));
  // Bash: NO exitCode fabricated; isError false; no path
  check('tool-result Bash: no exitCode fabricated, no path, isError false', !!bash && bash.toolName === 'Bash' && bash.exitCode === undefined && bash.path === undefined && bash.isError === false, JSON.stringify(bash));
  // Read: path + truncated from file.truncatedByTokenCap; title 'Read a.ts'
  check('tool-result Read: path + truncated + title from toolUseResult.file', !!read && read.toolName === 'Read' && read.path === '/tmp/x/a.ts' && read.truncated === true && read.title === 'Read a.ts', JSON.stringify(read));
  check('Claude tool-result display classes match their originating tools', edit?.toolClass === 'edit' && bash?.toolClass === 'execute' && read?.toolClass === 'lookup', JSON.stringify(tr));

  check(
    'compact_boundary → structured compaction history-reset (once)',
    of('history-reset').length === 1
      && of('history-reset')[0]?.semantic?.kind === 'compaction',
    JSON.stringify(of('history-reset')),
  );
  check('local_command stdout → notice', of('notice').some((n: any) => n.message === 'Not enough messages to compact.'), JSON.stringify(of('notice')));
  check('SUCCESS local-command stdout (user line) → notice, SGR stripped', of('notice').some((n: any) => n.message === 'Compacted (ctrl+o to see full summary)'), JSON.stringify(of('notice')));
  check('command-name user line → clean /compact echo', of('user-message').some((u: any) => u.text === '/compact'), JSON.stringify(of('user-message').map((u: any) => u.text)));
  check('local-command-caveat line stays suppressed', !out.some((m: any) => JSON.stringify(m).includes('local-command-caveat')));
  check('API-error assistant line → error (first line only)', of('error').length === 1 && of('error')[0].message === "You've hit your session limit.", JSON.stringify(of('error')));
  // issues-part2 item-12 (+follow-up): a queued-while-running message surfaces as a KEYED queued user
  // bubble; its delivery re-emits the SAME key without the flag (app clears the style in place); a
  // dropped one keeps its dimmed bubble; harness/contentless enqueues stay quiet.
  const queuedBubbles = of('user-message').filter((u: any) => u.queued === true);
  check('enqueue → user-message queued:true (words preserved, no notice)', queuedBubbles.some((u: any) => u.text === 'QUEUED-MSG mention this too') && !of('notice').some((n: any) => /Queued while running/.test(n.message)), JSON.stringify(queuedBubbles.map((u: any) => u.text)));
  const qd = of('user-message').filter((u: any) => u.text === 'QUEUED-DELIVERED run the tests');
  check('delivery takes over the enqueue key (same key, queued → cleared)', qd.length === 2 && qd[0].queued === true && !qd[1].queued && qd[0].key === qd[1].key && String(qd[0].key).startsWith('queued:'), JSON.stringify(qd.map((u: any) => ({ key: u.key, queued: !!u.queued }))));
  const dropped = of('user-message').filter((u: any) => u.text === 'QUEUED-MSG mention this too');
  check('dropped queued message (enqueue→remove) keeps ONE queued bubble', dropped.length === 1 && dropped[0].queued === true, JSON.stringify(dropped));
  const same = of('user-message').filter((u: any) => u.text === 'same words');
  check('cardinality: two IDENTICAL queued texts → two distinct keys, delivered FIFO', same.length === 4 && new Set(same.map((u: any) => u.key)).size === 2 && same[0].key === same[2].key && same[1].key === same[3].key && same[2].queued === undefined && same[3].queued === undefined, JSON.stringify(same.map((u: any) => ({ key: u.key, queued: !!u.queued }))));
  check('contentless (driven) enqueue → nothing rendered', !of('user-message').some((u: any) => u.queued && !String(u.text).trim()));
  check('queue-operation harness enqueue (task-notification) suppressed', !of('user-message').some((u: any) => String(u.text).includes('task-notification')));
  // issues-part2: Esc-interrupt markers render as notices, in BOTH content shapes, never as user bubbles
  check(
    'interrupt markers → unowned structured user interruptions ×2, no fake prompt',
    of('notice').filter((n: any) =>
      n.message === 'Interrupted by user.'
      && n.semantic?.kind === 'interruption'
      && n.semantic?.reason === 'user'
      && n.semantic?.turnId === undefined).length === 2
      && !of('user-message').some((u: any) =>
        u.text.includes('Request interrupted')),
    JSON.stringify(of('notice')),
  );

  // dedup keys: model-output/thinking/user-message are keyed and unique; the ONE sanctioned reuse is
  // a queued bubble upserted by its delivering user line (same key, queued flag → cleared).
  const keyed = out.filter((m: any) => typeof m.key === 'string');
  const seenKeys = new Map<string, any>();
  let badReuse = 0;
  for (const m of keyed as any[]) {
    const prev = seenKeys.get(m.key);
    if (prev && !(prev.type === 'user-message' && prev.queued === true && m.type === 'user-message' && !m.queued)) badReuse++;
    seenKeys.set(m.key, m);
  }
  check('keyed messages have unique keys (queued→delivered upsert exempt)', keyed.length > 0 && badReuse === 0, `${badReuse} bad reuses / ${keyed.length}`);
  const bad = out.map((m) => m.type).filter((t) => !(CANONICAL_MESSAGE_TYPES as readonly string[]).includes(t));
  check('all emitted types are canonical', bad.length === 0, bad.join(',') || 'ok');
}

// ── P6: a pasted image belongs to the prompt it was SENT WITH ───────────────────────────────────
//    An image block became a standalone top-level file-artifact with its own identity, so the client
//    rendered it as a detached agent deliverable next to (not inside) the user's bubble. The artifact
//    now carries `userMessageKey` — the key of the user row it was sent with — as an ownership link;
//    identity stays artifactKey/path. Only a line that actually PRODUCES a user row stamps it.
{
  const lines: any[] = [
    { type: 'user', uuid: 'p6-a', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: 'what is in this screenshot' }] } },
    { type: 'user', uuid: 'p6-b', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'BBBB' } }] } },
    // a meta line produces NO user row → its image must stay unstamped (nothing to own it)
    { type: 'user', uuid: 'p6-c', isMeta: true, message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'CCCC' } }] } },
  ];
  const out = mapTranscript(lines);
  const arts = out.filter((m: any) => m.type === 'file-artifact') as any[];
  const users = out.filter((m: any) => m.type === 'user-message') as any[];
  const withText = users.find((u) => u.text === 'what is in this screenshot');
  const artA = arts.find((a) => a.path === 'image:p6-a:0');
  check('P6: an image sent with text is linked to that user row', !!artA && !!withText && artA.userMessageKey === withText.key, JSON.stringify({ artA, withText }));
  const imageOnly = users.find((u) => u.key === 'p6-b:u');
  const artB = arts.find((a) => a.path === 'image:p6-b:0');
  check('P6: an image-only prompt still gets an (empty-text) user row for the link to target', !!imageOnly && imageOnly.text === '' && imageOnly.imageCount === 1, JSON.stringify(imageOnly));
  check('P6: the image-only artifact is linked to that row', !!artB && artB.userMessageKey === imageOnly?.key, JSON.stringify(artB));
  const artC = arts.find((a) => a.path === 'image:p6-c:0');
  check('P6: a line that produces no user row leaves its artifact unstamped', !!artC && artC.userMessageKey === undefined, JSON.stringify(artC));
  check('P6: the link never becomes the artifact identity', arts.every((a) => a.path.startsWith('image:')));
}

// ── bridge line-type regression (Claude 2.1.x claude.ai bridge): a real bridge transcript interleaves ~10
//    sidecar line types the mapper had never seen — they must map to NOTHING and never throw, so a real
//    user prompt + assistant turn still render around them (maintainer's live AIGC session, verified). ──
{
  const REAL_PROMPT = { type: 'user', uuid: 'bu1', message: { role: 'user', content: 'Do the thing.' } };
  const REPLY = { type: 'assistant', uuid: 'ba1', message: { id: 'bm1', role: 'assistant', content: [{ type: 'text', text: 'On it.' }] } };
  const BRIDGE_LINES = [
    { type: 'attachment', attachment: { type: 'task_reminder', content: [], itemCount: 0 } },
    { type: 'mode', mode: 'normal' },
    { type: 'permission-mode', permissionMode: 'auto' },
    { type: 'last-prompt', lastPrompt: 'Do the thing.', leafUuid: 'x' },
    { type: 'bridge-session', bridgeSessionId: 'cse_abc', lastSequenceNum: 0 },
    { type: 'queue-operation', operation: 'dequeue', timestamp: '2026-06-19T00:00:00.000Z' },
    { type: 'system', subtype: 'away_summary', content: 'Goal: …', uuid: 'sy1', isMeta: false },
    { type: 'ai-title', title: 'auto' },
    { type: 'custom-title', title: 'mine' },
    { type: 'file-history-snapshot', messageId: 'fh1' },
  ];
  let threw = '';
  let bout: any[] = [];
  try { bout = mapTranscript([REAL_PROMPT, ...BRIDGE_LINES, REPLY]) as any[]; } catch (e) { threw = String(e); }
  check('bridge sidecar line types parse without throwing', threw === '', threw);
  check('bridge sidecar line types map to NOTHING (only the prompt + reply render)', bout.filter((m) => m.type === 'user-message').length === 1 && bout.some((m) => m.type === 'model-output' && m.text === 'On it.'));
  const bbad = bout.map((m) => m.type).filter((t) => !(CANONICAL_MESSAGE_TYPES as readonly string[]).includes(t));
  check('bridge transcript yields only canonical types', bbad.length === 0, bbad.join(',') || 'ok');
}

// ── enrichment unit checks ───────────────────────────────────────────────────────
{
  const diff = structuredPatchToDiff([{ lines: [' a', '+b', '+c', '-d'] }, { lines: ['+e'] }]);
  check('structuredPatchToDiff joins git-prefixed hunk lines (header-less hunks unchanged)', diff === ' a\n+b\n+c\n-d\n+e', JSON.stringify(diff));

  // Real Claude hunks carry oldStart/oldLines/newStart/newLines — emit the `@@ -a,b +c,d @@`
  // header they imply so the client can line-number the diff instead of numbering from 1.
  const withHeaders = structuredPatchToDiff([
    { oldStart: 10, oldLines: 3, newStart: 10, newLines: 4, lines: [' ctx', '-old', '+new', '+added'] },
    { oldStart: 40, oldLines: 1, newStart: 41, newLines: 1, lines: ['-gone', '+here'] },
  ]);
  check(
    'structuredPatchToDiff emits @@ headers from hunk metadata',
    withHeaders.startsWith('@@ -10,3 +10,4 @@\n ctx\n-old\n+new\n+added\n@@ -40,1 +41,1 @@\n-gone\n+here') && summarizeDiff(withHeaders).additions === 3 && summarizeDiff(withHeaders).deletions === 2,
    JSON.stringify(withHeaders),
  );

  const create = enrichClaudeToolResult('Write', { type: 'create', filePath: '/tmp/x/new.ts', content: 'l1\nl2\nl3', structuredPatch: [] });
  check('Write create: emits real create diff (not just a count), title "Created"', create.path === '/tmp/x/new.ts' && create.additions === 3 && create.deletions === 0 && create.title === 'Created new.ts', JSON.stringify(create));
  check('Write create: diff has /dev/null base + added body lines (slash-safe absolute path)', create.diff === '--- /dev/null\n+++ b/tmp/x/new.ts\n+l1\n+l2\n+l3', JSON.stringify(create.diff));
  check('Write create: fileChanges[create] single file', create.fileChanges?.length === 1 && create.fileChanges[0]?.operation === 'create' && create.fileChanges[0]?.path === '/tmp/x/new.ts' && create.fileChanges[0]?.additions === 3, JSON.stringify(create.fileChanges));
  const edit = enrichClaudeToolResult('Edit', { filePath: '/tmp/x/a.ts', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' ctx', '-a', '+b', '+c'] }] });
  check('Edit: fileChanges[edit] single file with diff/stats', edit.fileChanges?.length === 1 && edit.fileChanges[0]?.operation === 'edit' && edit.fileChanges[0]?.path === '/tmp/x/a.ts' && edit.fileChanges[0]?.additions === 2 && edit.fileChanges[0]?.deletions === 1, JSON.stringify(edit.fileChanges));

  const sendfile = enrichClaudeToolResult('SendUserFile', { attachments: [{ path: 'r.png' }], caption: 'Here is the report\nsecond line' });
  check('SendUserFile: caption (first line) becomes the title', sendfile.title === 'Here is the report', JSON.stringify(sendfile));

  const bash = enrichClaudeToolResult('Bash', { stdout: 'x', stderr: '', interrupted: false, isImage: false });
  check('Bash enrich: no path/diff/exit (binary status comes from is_error/interrupted)', bash.path === undefined && bash.diff === undefined && bash.additions === undefined, JSON.stringify(bash));

  // Image Read: toolUseResult is {type:'image'} with NO file path — recover it from the call input.
  const imgRead = enrichClaudeToolResult('Read', { type: 'image' }, { file_path: '/tmp/x/shot.png' });
  check('image Read: path/title recovered from call input file_path', imgRead.path === '/tmp/x/shot.png' && imgRead.title === 'Read shot.png', JSON.stringify(imgRead));
  // Grep's input.path is a search DIRECTORY — must NOT become an edited-file chip.
  const grep = enrichClaudeToolResult('Grep', { numFiles: 3 }, { pattern: 'foo', path: '/tmp/x/src' });
  check('Grep: input.path (a dir) is NOT promoted to a file path', grep.path === undefined && grep.title === undefined, JSON.stringify(grep));
}

// ── 3. live-tail across the attach boundary (history⟷tail partition, dedup, callId correlation) ──
await (async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ca-claude-'));
  const slug = join(dir, 'projects', '-tmp-proj');
  mkdirSync(slug, { recursive: true });
  const file = join(slug, 'sess-live.jsonl');
  const uu = { input_tokens: 50, output_tokens: 10 };
  // HISTORY: a prompt + a turn (m1, split) whose tool_use's RESULT will arrive live
  const hist = [
    { type: 'user', uuid: 'h1', cwd: '/tmp/proj', message: { role: 'user', content: 'do it' } },
    { type: 'assistant', uuid: 'h2', message: { id: 'm1', stop_reason: 'tool_use', content: [{ type: 'text', text: 'working' }], usage: uu } },
    { type: 'assistant', uuid: 'h3', message: { id: 'm1', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_A', name: 'Edit', input: { file_path: '/tmp/proj/x.ts' } }], usage: uu } },
  ];
  writeFileSync(file, hist.map((l) => JSON.stringify(l)).join('\n') + '\n');

  // Construct the connection directly (attach()'s containment guard rejects /tmp — tested separately).
  const id = Buffer.from(file, 'utf8').toString('base64url');
  const conn = new ClaudeObserveConnection(file, { id, tool: 'claude', title: 't', cwd: '/tmp/proj', status: 'idle', attachMode: 'observe' });
  const history = await conn.getHistory(); // primes the tail at the newline boundary
  const live: any[] = [];
  conn.subscribe((m) => live.push(m));

  const tail = [
    // tool_result for toolu_A — its tool_use was in HISTORY → name must resolve to 'Edit'
    { type: 'user', uuid: 'l1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_A', content: 'ok' }] }, toolUseResult: { filePath: '/tmp/proj/x.ts', structuredPatch: [{ lines: ['+a', '+b'] }] } },
    // a brand-new turn m2
    { type: 'assistant', uuid: 'l2', message: { id: 'm2', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 70, output_tokens: 5 } } },
  ];
  appendFileSync(file, tail.map((l) => JSON.stringify(l)).join('\n') + '\n');
  // poll until the live tail delivers the new turn (fs.watch + 80ms debounce), cap ~2s
  for (let i = 0; i < 40 && !live.some((m) => m.type === 'model-output'); i++) await new Promise((r) => setTimeout(r, 50));
  await conn.close();

  const histTok = history.filter((m) => m.type === 'token-count').length;
  const liveTok = live.filter((m: any) => m.type === 'token-count').length;
  const liveTR = live.find((m: any) => m.type === 'tool-result') as any;
  const liveMO = live.find((m: any) => m.type === 'model-output') as any;
  check('live-tail: history has m1 token-count once', histTok === 1, `histTok=${histTok}`);
  check('live-tail: m1 NOT re-emitted, m2 token-count emitted once live', liveTok === 1, `liveTok=${liveTok}`);
  check('live-tail: tool-result name resolves from a history tool_use (Edit, path, +2)', !!liveTR && liveTR.toolName === 'Edit' && liveTR.path === '/tmp/proj/x.ts' && liveTR.additions === 2, JSON.stringify(liveTR));
  check('live-tail: new model-output keyed claude:<message.id>:<ordinal>:t (m2 block 0)', !!liveMO && liveMO.key === 'claude:m2:0:t' && liveMO.text === 'done', JSON.stringify(liveMO));
  // Content partitions without overlap. The exact run-summary intentionally reuses its key for the
  // history `running` → live `done` transition; that is an upserted state frame, not content replay.
  const histKeys = new Set(history
    .filter((m: any) => m.type !== 'run-summary' && typeof m.key === 'string')
    .map((m: any) => m.key));
  const relive = live
    .filter((m: any) => m.type !== 'run-summary' && typeof m.key === 'string' && histKeys.has(m.key))
    .map((m: any) => m.key);
  check('live-tail: no history content re-emitted live (no shared key)', relive.length === 0, JSON.stringify(relive));

  // attach() containment guard: an id resolving outside the projects root is rejected.
  let rejected = false;
  try {
    await new ClaudeAdapter().attach(Buffer.from('/etc/passwd', 'utf8').toString('base64url'));
  } catch {
    rejected = true;
  }
  check('attach() rejects an id resolving outside the projects root', rejected, `rejected=${rejected}`);
})();

// ── 3. cross-surface message identity (CR4) ─────────────────────────────────────
//
// Shapes are the captured real trace's: live `message_start.message.id` + one content_block per stream
// `index`, and a transcript that records that same id on SIBLING lines with distinct uuids, one content
// block each, in stream-index order. Nothing here may dedupe by text.
{
  const asst = (uuid: string, id: string | undefined, content: any[]) => ({ type: 'assistant', uuid, message: { ...(id ? { id } : {}), role: 'assistant', content } });
  const think = (t: string) => ({ type: 'thinking', thinking: t, signature: 'sig' });
  const text = (t: string) => ({ type: 'text', text: t });
  const tool = (id: string) => ({ type: 'tool_use', id, name: 'Read', input: { file_path: '/tmp/x' } });
  const keysOf = (msgs: any[], ...types: string[]) => msgs.filter((m) => types.includes(m.type)).map((m) => `${m.type}#${m.key}`);

  // one message split across sibling lines, thinking then text — the captured trace's exact shape
  {
    const out = mapTranscript([asst('s1', 'msg_A', [think('reasoning')]), asst('s2', 'msg_A', [text('answer')])]) as any[];
    const rows = out.filter((m) => m.type === 'thinking' || m.type === 'model-output');
    check('identity: sibling lines of one message → 2 rows with ordinals 0 and 1', rows.length === 2 && rows[0].key === 'claude:msg_A:0:r' && rows[1].key === 'claude:msg_A:1:t', JSON.stringify(rows.map((m) => m.key)));
  }

  // multi-text and multi-thinking under one id must NOT collapse (108 and 164 real messages measured)
  {
    const two = mapTranscript([asst('s1', 'msg_B', [text('one')]), asst('s2', 'msg_B', [text('two')])]) as any[];
    check('identity: a message with two text blocks stays two rows', keysOf(two, 'model-output').join(',') === 'model-output#claude:msg_B:0:t,model-output#claude:msg_B:1:t', JSON.stringify(keysOf(two, 'model-output')));
    const th = mapTranscript([asst('s1', 'msg_D', [think('a')]), asst('s2', 'msg_D', [think('b')])]) as any[];
    check('identity: a message with two thinking blocks stays two rows', keysOf(th, 'thinking').join(',') === 'thinking#claude:msg_D:0:r,thinking#claude:msg_D:1:r', JSON.stringify(keysOf(th, 'thinking')));
  }

  // identity is never text: byte-identical blocks stay distinct rows, in one message and across messages
  {
    const same = mapTranscript([asst('s1', 'msg_C', [text('same words')]), asst('s2', 'msg_C', [text('same words')]), asst('s3', 'msg_H', [text('same words')])]) as any[];
    const mo = same.filter((m) => m.type === 'model-output');
    check('identity: three byte-identical texts stay three rows with three keys', mo.length === 3 && new Set(mo.map((m: any) => m.key)).size === 3, JSON.stringify(mo.map((m: any) => m.key)));
  }

  // ordinals count EVERY block type, so a text block after a tool_use keeps the stream's index; and the
  // count continues INSIDE a line that packs several blocks as well as across sibling lines
  {
    const withTool = mapTranscript([asst('s1', 'msg_E', [think('why')]), asst('s2', 'msg_E', [tool('toolu_1')]), asst('s3', 'msg_E', [text('after the tool')])]) as any[];
    const mo = withTool.find((m: any) => m.type === 'model-output') as any;
    check('identity: tool_use blocks consume an ordinal (text after a tool is block 2)', mo?.key === 'claude:msg_E:2:t', JSON.stringify(mo?.key));
    const packed = mapTranscript([asst('s1', 'msg_F', [text('first'), tool('toolu_2')]), asst('s2', 'msg_F', [text('third')])]) as any[];
    check('identity: ordinals continue across a multi-block line into its sibling', keysOf(packed, 'model-output').join(',') === 'model-output#claude:msg_F:0:t,model-output#claude:msg_F:2:t', JSON.stringify(keysOf(packed, 'model-output')));
  }

  // no message.id (37/20,106 real lines are uuid-form, older transcripts may lack it): keep the legacy
  // line-uuid key. A fallback costs the duplicate this lane removes — never a lost or merged message.
  {
    const legacy = mapTranscript([asst('n1', undefined, [text('legacy single')]), asst('n2', undefined, [text('legacy first'), tool('toolu_3')])]) as any[];
    check('identity: a line with no message.id falls back to the line-uuid key', keysOf(legacy, 'model-output').join(',') === 'model-output#n1,model-output#n2:0', JSON.stringify(keysOf(legacy, 'model-output')));
  }
}

// live stream ⟷ history agreement, attach overlap, and restart stability
await (async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ca-claude-id-'));
  const store: ClaudeStore = { configDir: dir, projectsRoot: join(dir, 'projects'), bin: 'claude', isDefault: true };
  const file = join(dir, 'sess.jsonl');
  writeFileSync(file, '');
  const info = (): SessionInfo => ({ id: 'sess', tool: 'claude', title: 't', cwd: dir, status: 'idle', attachMode: 'resume' });

  // The captured live frame sequence for ONE message: thinking at index 0, text at index 1.
  const STREAM = [
    { type: 'message_start', message: { id: 'msg_LIVE', role: 'assistant' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reasoning' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } },
    { type: 'content_block_stop', index: 1 },
  ];
  /** Drive the stream through a fresh connection and return what it emitted (no spawn, no model). */
  async function liveEmit(): Promise<AgentMessage[]> {
    const conn = new ClaudeResumeConnection(store, file, info());
    const msgs: AgentMessage[] = [];
    conn.subscribe((m) => msgs.push(m));
    for (const event of STREAM) (conn as any).handleEvent({ type: 'stream_event', event });
    await conn.close();
    return msgs;
  }
  const live = await liveEmit();
  const finals = live.filter((m: any) => m.delta === undefined) as any[];
  const deltas = live.filter((m: any) => m.delta !== undefined) as any[];

  // The transcript Claude writes for that same message: sibling lines repeating message.id.
  const SIBLINGS = [
    { type: 'assistant', uuid: 'w1', message: { id: 'msg_LIVE', role: 'assistant', content: [{ type: 'thinking', thinking: 'reasoning', signature: 'sig' }] } },
    { type: 'assistant', uuid: 'w2', message: { id: 'msg_LIVE', role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
  ];
  const hist = (mapTranscript(SIBLINGS) as any[]).filter((m) => m.type === 'thinking' || m.type === 'model-output');

  // THE core invariant — asserted as equality between the two surfaces, not against a literal.
  const pair = (m: any) => `${m.type}#${m.key}`;
  check('identity: live finals and a history read of the same message agree key-for-key', finals.map(pair).join(',') === hist.map(pair).join(','), `live=${JSON.stringify(finals.map(pair))} history=${JSON.stringify(hist.map(pair))}`);
  check('identity: a block’s deltas carry the same key as its final', deltas.map(pair).join(',') === finals.map(pair).join(','), JSON.stringify(deltas.map(pair)));

  // ATTACH OVERLAP: the block is already persisted while the live accumulator still holds it. The
  // client reduces by key, so the union of both surfaces must be one row per block — not two.
  {
    writeFileSync(file, SIBLINGS.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const obs = new ClaudeObserveConnection(file, { id: 'x', tool: 'claude', title: 't', cwd: dir, status: 'idle', attachMode: 'observe' });
    const saved = (await obs.getHistory()).filter((m) => m.type === 'thinking' || m.type === 'model-output');
    await obs.close();
    const rows = new Set([...saved, ...finals].map((m: any) => m.key));
    check('identity: attach overlap (saved history + live snapshot) reduces to one row per block', saved.length === 2 && rows.size === 2, `saved=${saved.length} live=${finals.length} rows=${rows.size} keys=${JSON.stringify([...rows])}`);
  }

  // RESTART/RECONNECT: keys must come from the transcript's own identity, not connection-local counters,
  // so a rebuilt connection replaying the same stream produces byte-identical keys.
  {
    const again = (await liveEmit()).filter((m: any) => m.delta === undefined) as any[];
    check('identity: a rebuilt connection replaying the same stream emits identical keys', again.map(pair).join(',') === finals.map(pair).join(','), JSON.stringify(again.map(pair)));
  }

  // A message_start with NO id keeps the synthetic per-connection key (unchanged behaviour), and the
  // block index still separates its blocks so nothing merges.
  {
    const conn = new ClaudeResumeConnection(store, file, info());
    const msgs: AgentMessage[] = [];
    conn.subscribe((m) => msgs.push(m));
    for (const event of [{ type: 'message_start', message: { role: 'assistant' } }, ...STREAM.slice(1)]) (conn as any).handleEvent({ type: 'stream_event', event });
    await conn.close();
    const k = msgs.filter((m: any) => m.delta === undefined).map((m: any) => m.key);
    check('identity: an id-less message_start falls back to the synthetic per-block key', k.length === 2 && k[0] === 'r1:0' && k[1] === 'r1:1', JSON.stringify(k));
    await new Promise((r) => setTimeout(r, 0));
  }
})();

// observe tail ⟷ history: a sibling line arriving AFTER the history read continues the same ordinal
await (async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ca-claude-tail-'));
  const file = join(dir, 'sess-tail.jsonl');
  const THINK = { type: 'assistant', uuid: 'g1', message: { id: 'msg_G', role: 'assistant', content: [{ type: 'thinking', thinking: 'first block', signature: 'sig' }] } };
  const TEXT = { type: 'assistant', uuid: 'g2', message: { id: 'msg_G', role: 'assistant', content: [{ type: 'text', text: 'second block' }] } };
  writeFileSync(file, [{ type: 'user', uuid: 'p1', message: { role: 'user', content: 'go' } }, THINK].map((l) => JSON.stringify(l)).join('\n') + '\n');

  const conn = new ClaudeObserveConnection(file, { id: 'x', tool: 'claude', title: 't', cwd: dir, status: 'idle', attachMode: 'observe' });
  const first = await conn.getHistory(); // baselines the tail after msg_G's FIRST block
  const live: any[] = [];
  conn.subscribe((m) => live.push(m));
  appendFileSync(file, JSON.stringify(TEXT) + '\n');
  for (let i = 0; i < 40 && !live.some((m) => m.type === 'model-output'); i++) await new Promise((r) => setTimeout(r, 50));
  const tailed = live.find((m) => m.type === 'model-output') as any;

  // A fresh reader of the finished file is the authority: the tail must have produced the same key, or a
  // client that attached before the append and one that attached after hold two rows for one block.
  const fresh = new ClaudeObserveConnection(file, { id: 'x', tool: 'claude', title: 't', cwd: dir, status: 'idle', attachMode: 'observe' });
  const whole = (await fresh.getHistory()).find((m) => m.type === 'model-output') as any;
  await fresh.close();
  check('identity: the tail continues the ordinal for a sibling line after the history read', !!tailed && !!whole && tailed.key === whole.key, `tail=${tailed?.key} wholeFile=${whole?.key}`);
  check('identity: that continued ordinal is the SECOND block, not a restarted 0', tailed?.key === 'claude:msg_G:1:t', JSON.stringify(tailed?.key));
  check('identity: the history read before the append kept the first block at ordinal 0', (first.find((m) => m.type === 'thinking') as any)?.key === 'claude:msg_G:0:r', JSON.stringify((first.find((m) => m.type === 'thinking') as any)?.key));

  // A history-reset resync re-reads lines the tail already consumed; re-feeding a line must not shift it.
  const second = await conn.getHistory();
  await conn.close();
  check('identity: a resync re-read keys the tailed line identically (ordinals are idempotent per line)', (second.find((m) => m.type === 'model-output') as any)?.key === tailed?.key, `resync=${(second.find((m) => m.type === 'model-output') as any)?.key} tail=${tailed?.key}`);
})();

// ── 2. real-data smoke (read-only; no content printed) ──────────────────────────
await (async () => {
  const adapter = new ClaudeAdapter();
  if (!(await adapter.isAvailable())) {
    check('real-data smoke (skipped — no ~/.claude/projects on this machine)', true, 'skipped');
    return;
  }
  // The smoke intentionally inspects the operator's real transcripts read-only. Durable selector
  // writes are covered in the isolated broker fixture, never against the host store.
  const previousSelectorReadOnly = process.env.COSYNCING_CLAUDE_NATIVE_SELECTOR_READ_ONLY;
  process.env.COSYNCING_CLAUDE_NATIVE_SELECTOR_READ_ONLY = '1';
  let sessions: Awaited<ReturnType<typeof adapter.discoverSessions>>;
  try {
    sessions = await adapter.discoverSessions();
  } finally {
    if (previousSelectorReadOnly === undefined) delete process.env.COSYNCING_CLAUDE_NATIVE_SELECTOR_READ_ONLY;
    else process.env.COSYNCING_CLAUDE_NATIVE_SELECTOR_READ_ONLY = previousSelectorReadOnly;
  }
  check('discovery finds real Claude sessions', sessions.length > 0, `${sessions.length} sessions`);
  if (!sessions.length) return;

  // The SESSION sweep is still depth-1: a sub-agent transcript under <uuid>/subagents/ may appear only
  // as a lineage-tagged CHILD row (observe-only, `origin:'subagent'` + a parentThreadId to nest under),
  // never as a top-level session. See test-claude-roster-subagents.ts for the fixture-level contract.
  const dec = (s: string) => Buffer.from(s, 'base64url').toString('utf8');
  const nested = sessions.filter((s) => /\/subagents\//.test(dec(s.id)));
  const leaked = nested.filter((s) => s.origin !== 'subagent' || !s.parentThreadId || !s.nativeId);
  check('nested subagents/ transcripts are only ever child rows, never top-level sessions', leaked.length === 0, `${leaked.length} leaked of ${nested.length} children`);

  const newest = [...sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]!;
  const conn = await adapter.attach(newest.id);
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
  check('getHistory() on a real transcript parses without throwing', threw === '', threw);
  check('real history yields only canonical message types', bad.length === 0, `types=[${types.join(',')}] msgs=${history.length}`);
})();

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
