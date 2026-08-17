/**
 * Regression for the shared-surface hardening pass (2026-06-16):
 *   1. summarizeDiff (core) — additions/deletions counting, excluding +++/--- headers.
 *   2. enrichPiToolResult (pi adapter) — maps a Pi tool result's details into the canonical
 *      diff/additions/deletions/exitCode/truncated/path/title chips (the resume path uses this
 *      directly; both the resume adapter and the live bridge share it).
 *   3. The live BRIDGE wire end-to-end: a tool-result event carrying `details`/`args` reaches an
 *      attached phone as an ENRICHED canonical tool-result (diff + diffstat + path), and a `user`
 *      event carrying a `key` reaches it as a keyed user-message (the dedupe contract).
 *   4. Pi bridge command queue: prompts and slash commands queued while running carry deliverAs:'steer'
 *      so the in-session extension uses Pi's streaming-safe injection path.
 *   5. Pi bridge approval wire: permission requests map to canonical cards and app decisions queue
 *      back to the extension as permission commands.
 *
 * Pure + self-contained: the unit half imports the helpers directly; the wire half starts its OWN
 * broker on a free port and simulates the extension over /pi/bridge/* + a phone WebSocket — no real
 * `pi`, no LLM cost. Scripts import adapters by RELATIVE path (scripts/broker/ isn't a workspace package).
 *
 *   bun run packages/typescript/broker/test/pi/test-tool-result-enrich.ts      (exit 0 = all pass)
 */
export {};
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { summarizeDiff, splitUnifiedDiffFiles } from '../../../adapter-api/src/index.ts';
import { enrichPiToolResult, piToolDisplayClass } from '../../../adapters/pi/src/index.ts';
import { PiBridgeConnection, PiBridgeRegistry } from '../../../adapters/pi/src/bridge.ts';
import {
  freshModuleSpecifier,
  captureProcessOutput,
  isolatedBrokerFixtureEnvironment,
  reserveLoopbackFixturePort,
  startHealthyFixtureBrokerOnPort,
} from '../helpers/isolated-broker-fixture.ts';

const BRIDGE_MODULE_PATH = resolve(
  import.meta.dir,
  '../../../adapters/pi/agent-extensions/cosyncing-bridge/index.ts',
);
const brokerFixtureRoot = mkdtempSync(
  join(tmpdir(), 'cosyncing-pi-tool-result-'),
);

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ── 1. summarizeDiff ──────────────────────────────────────────────────────────
{
  const diff = '--- a/f.ts\n+++ b/f.ts\n@@ -1,2 +1,3 @@\n unchanged\n+added one\n+added two\n-removed one\n';
  const { additions, deletions } = summarizeDiff(diff);
  check('summarizeDiff counts +/- body lines, not the +++/--- headers', additions === 2 && deletions === 1, `+${additions} -${deletions}`);
}

// ── 1b. splitUnifiedDiffFiles: range-safe multi-file boundaries (T1b finding 5) ─
{
  // Two files as a PLAIN unified diff (no `diff --git`) with RANGE-LESS hunks: the `--- `/`+++ `
  // header pair must start file 2, not fold into file 1's body (the bug returned one file +3 −3).
  const diff = [
    '--- a/f1', '+++ b/f1', '@@ ctx', '+a1', '-r1',
    '--- a/f2', '+++ b/f2', '@@ ctx', '+a2', '-r2',
  ].join('\n');
  const files = splitUnifiedDiffFiles(diff);
  const agg = summarizeDiff(diff);
  check(
    'splitUnifiedDiffFiles: range-less multi-file (no diff --git) splits into 2 files',
    files.length === 2 && files[0]?.path === 'f1' && files[1]?.path === 'f2' &&
      files[0]?.additions === 1 && files[0]?.deletions === 1 &&
      files[1]?.additions === 1 && files[1]?.deletions === 1,
    JSON.stringify(files.map((f) => ({ p: f.path, a: f.additions, d: f.deletions }))),
  );
  check('summarizeDiff: range-less two-file aggregate is +2 −2 (not +3 −3)', agg.additions === 2 && agg.deletions === 2, `+${agg.additions} -${agg.deletions}`);
}
{
  // A lone `--- <content>` inside a range-less hunk (removing a `-- `-prefixed line) is NOT a header
  // pair (no following `+++ `) and must stay a single file's deletion — content, not a boundary.
  const diff = ['--- a/only.ts', '+++ b/only.ts', '@@ ctx', ' keep', '--- removed dashes', '+added'].join('\n');
  const files = splitUnifiedDiffFiles(diff);
  check(
    'splitUnifiedDiffFiles: a lone `--- ` body line does not spuriously split the file',
    files.length === 1 && files[0]?.path === 'only.ts' && files[0]?.deletions === 1 && files[0]?.additions === 1,
    JSON.stringify(files.map((f) => ({ p: f.path, a: f.additions, d: f.deletions }))),
  );
}
{
  // A range-less BODY pair (removed `-- old value` / added `++ new value`, rendered `--- old value` /
  // `+++ new value`) with NO following `@@` must stay ONE file — the `@@`-follows requirement stops the
  // header-pair heuristic from splitting legitimate content into a fake second file (T1b R3 finding 1).
  const diff = ['--- a/x.txt', '+++ b/x.txt', '@@ context', '--- old value', '+++ new value'].join('\n');
  const files = splitUnifiedDiffFiles(diff);
  check(
    'splitUnifiedDiffFiles: a range-less `--- `/`+++ ` body pair is NOT split into a fake file',
    files.length === 1 && files[0]?.path === 'x.txt' && files[0]?.additions === 1 && files[0]?.deletions === 1,
    JSON.stringify(files.map((f) => ({ p: f.path, a: f.additions, d: f.deletions }))),
  );
}
{
  // A body pair with NON-credible paths (`old value`, `new value`) FOLLOWED BY a second range-less
  // hunk must still be ONE file — the credible-a/·b/ path restriction beats the `@@`-follows heuristic
  // that would otherwise mis-split it (T1b R4 finding 3).
  const diff = ['--- a/x.txt', '+++ b/x.txt', '@@ first', '--- old value', '+++ new value', '@@ second'].join('\n');
  const files = splitUnifiedDiffFiles(diff);
  check(
    'splitUnifiedDiffFiles: a body pair before a 2nd hunk is content, not a fake file (credible-path)',
    files.length === 1 && files[0]?.path === 'x.txt' && files[0]?.additions === 1 && files[0]?.deletions === 1,
    JSON.stringify(files.map((f) => ({ p: f.path, a: f.additions, d: f.deletions }))),
  );
}
{
  // A genuine range-less multi-file split WITH credible a/·b/ paths still works (regression guard).
  const diff = ['--- a/f1', '+++ b/f1', '@@ ctx', '+a1', '--- a/f2', '+++ b/f2', '@@ ctx', '+a2'].join('\n');
  const files = splitUnifiedDiffFiles(diff);
  check(
    'splitUnifiedDiffFiles: credible a/·b/ header pair still splits a range-less multi-file diff',
    files.length === 2 && files[0]?.path === 'f1' && files[1]?.path === 'f2',
    JSON.stringify(files.map((f) => f.path)),
  );
}

// ── 2. enrichPiToolResult ──────────────────────────────────────────────────────
{
  const diff = '--- a/src/x.ts\n+++ b/src/x.ts\n@@\n+one\n+two\n-old\n';
  const e = enrichPiToolResult('edit', { text: 'ok', details: { diff }, args: { path: 'src/x.ts' } });
  check('edit: diff + diffstat + path(from args) + title',
    e.diff === diff && e.additions === 2 && e.deletions === 1 && e.path === 'src/x.ts' && e.title === 'Edited x.ts',
    `+${e.additions} -${e.deletions} path=${e.path} title=${e.title}`);
  // Range-less `@@` (no line numbers) still counts +/- body and yields a single-file change set.
  check('edit: fileChanges[edit] single file (range-less hunk counted)',
    e.fileChanges?.length === 1 && e.fileChanges[0]?.operation === 'edit' && e.fileChanges[0]?.path === 'src/x.ts' && e.fileChanges[0]?.additions === 2 && e.fileChanges[0]?.deletions === 1,
    JSON.stringify(e.fileChanges));
}
{
  // details.patch (no .diff) is honored; path recovered from the diff header when args are absent.
  const patch = '--- a/lib/y.ts\n+++ b/lib/y.ts\n@@\n+added\n';
  const e = enrichPiToolResult('apply_patch', { text: 'ok', details: { patch } });
  check('patch fallback + path recovered from +++ header', e.diff === patch && e.path === 'lib/y.ts' && e.additions === 1, `path=${e.path} +${e.additions}`);
}
{
  const e = enrichPiToolResult('bash', { text: 'boom\nCommand exited with code 2', isError: true, details: { truncation: { truncated: true } } });
  check('bash: exitCode parsed from error text + truncated flag', e.exitCode === 2 && e.truncated === true, `exit=${e.exitCode} truncated=${e.truncated}`);
}
{
  const e = enrichPiToolResult('bash', { text: 'done', details: { exitCode: 0, duration: { secs: 2, nanos: 500_000_000 } } });
  check('bash: numeric details.exitCode + native duration honored (success path)', e.exitCode === 0 && e.durationMs === 2500, `exit=${e.exitCode} duration=${e.durationMs}`);
}
{
  check(
    'Pi owns canonical tool display classes (execute/edit/lookup/other)',
    piToolDisplayClass('bash') === 'execute' && piToolDisplayClass('write') === 'edit' && piToolDisplayClass('grep') === 'lookup' && piToolDisplayClass('custom') === 'other',
  );
}
{
  // A plain read with no rich details must NOT invent fields (no opaque-JSON regression in reverse).
  const e = enrichPiToolResult('read', { text: 'file contents' });
  check('plain result with no details → no spurious fields', e.diff === undefined && e.exitCode === undefined && e.path === undefined && e.truncated === undefined, JSON.stringify(e));
}
{
  // grep/ls overload `path` to mean a SEARCH dir — it must NOT become a path chip / filename title.
  const e = enrichPiToolResult('grep', { text: 'match', args: { pattern: 'foo', path: 'src' } });
  check('grep: search-dir `path` arg is NOT mislabeled as a file path/title', e.path === undefined && e.title === undefined, `path=${e.path} title=${e.title}`);
}
{
  // The exit code must come from the LAST "exited with code" (Pi appends the status line last),
  // not a number the command's own output happened to mention first.
  const e = enrichPiToolResult('bash', { text: 'log: a job exited with code 137 earlier\n\nCommand exited with code 2', isError: true });
  check('bash: exitCode takes the LAST match, not output noise', e.exitCode === 2, `exit=${e.exitCode}`);
}

// ── 2b. JSONL chronology + run-summary evidence (mapPiJsonlText) ──────────────
// Pi's native causal order is the FILE order (the parent chain flattened).
// Nothing may sort by wall clock: an assistant entry's embedded timestamp is
// its request-creation time and routinely EQUALS — or precedes — the previous
// entry's clock. And a run summary may only claim completion from evidence.
{
  const jsonl = (obj: unknown): string => `${JSON.stringify(obj)}\n`;
  const fixture = [
    jsonl({ type: 'session', version: 3, id: 'chrono', timestamp: '2026-06-20T00:00:00.000Z', cwd: '/tmp' }),
    jsonl({ type: 'message', id: 'cu1', timestamp: '2026-06-20T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'go' }], timestamp: Date.parse('2026-06-20T00:00:01.000Z') } }),
    // Equal clocks: the assistant's embedded timestamp EQUALS the user entry's.
    jsonl({ type: 'message', id: 'ca1', timestamp: '2026-06-20T00:00:03.000Z', message: { role: 'assistant', stopReason: 'toolUse', timestamp: Date.parse('2026-06-20T00:00:01.000Z'), content: [{ type: 'text', text: 'first text' }, { type: 'toolCall', id: 'cc1', name: 'bash', arguments: { command: 'ls' } }] } }),
    // Older clock than the entry BEFORE it: sorting by time would move it.
    jsonl({ type: 'message', id: 'cr1', timestamp: '2026-06-20T00:00:02.500Z', message: { role: 'toolResult', toolCallId: 'cc1', toolName: 'bash', content: [{ type: 'text', text: 'listing' }] } }),
    jsonl({ type: 'message', id: 'ca2', timestamp: '2026-06-20T00:00:05.000Z', message: { role: 'assistant', stopReason: 'stop', timestamp: Date.parse('2026-06-20T00:00:02.500Z'), content: [{ type: 'text', text: 'after tools' }] } }),
  ].join('');
  const { mapPiJsonlText } = await import('../../../adapters/pi/src/index.ts');
  const mapped = mapPiJsonlText(fixture);
  const order = mapped
    .filter((m) => ['user-message', 'model-output', 'tool-call', 'tool-result'].includes(m.type))
    .map((m) => (m.type === 'model-output' ? `text:${(m as any).text}` : m.type === 'tool-call' ? `call:${(m as any).callId}` : m.type === 'tool-result' ? `result:${(m as any).callId}` : 'user'));
  check(
    'JSONL mapping preserves file order under equal and older clocks',
    JSON.stringify(order) === JSON.stringify(['user', 'text:first text', 'call:cc1', 'result:cc1', 'text:after tools']),
    JSON.stringify(order),
  );
  const summary = mapped.filter((m) => m.type === 'run-summary');
  check(
    'one turn-level summary spans user entry → final assistant entry',
    summary.length === 1
      && summary[0]?.status === 'done'
      && (summary[0] as any)?.key === 'pi:run:u0'
      && (summary[0] as any)?.turnId === 'u0'
      && (summary[0] as any)?.userMessageKey === 'cu1'
      && summary[0]?.startedAt === Date.parse('2026-06-20T00:00:01.000Z')
      && summary[0]?.completedAt === Date.parse('2026-06-20T00:00:05.000Z')
      && summary[0]?.totalRuntimeMs === 4000,
    JSON.stringify(summary),
  );
  check(
    'mapping the same bytes twice is identical (reload convergence)',
    JSON.stringify(mapPiJsonlText(fixture)) === JSON.stringify(mapped),
  );

  // A window that ends mid-run (trailing toolUse) must not claim completion.
  const midRun = fixture.split('\n').filter(Boolean).slice(0, 4).join('\n');
  const midMapped = mapPiJsonlText(midRun);
  const midSummary = midMapped.filter((m) => m.type === 'run-summary');
  check(
    'a mid-run window reports the trailing turn running with no duration',
    midSummary.length === 1
      && midSummary[0]?.status === 'running'
      && midSummary[0]?.totalRuntimeMs === undefined
      && midSummary[0]?.completedAt === undefined,
    JSON.stringify(midSummary),
  );

  // Contradictory clocks (final entry written "before" the prompt) omit the
  // duration rather than invent a negative-or-zero one.
  const contradictory = [
    jsonl({ type: 'message', id: 'xu1', timestamp: '2026-06-20T01:00:10.000Z', message: { role: 'user', content: [{ type: 'text', text: 'go' }], timestamp: Date.parse('2026-06-20T01:00:10.000Z') } }),
    jsonl({ type: 'message', id: 'xa1', timestamp: '2026-06-20T01:00:05.000Z', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'time went backwards' }] } }),
  ].join('');
  const contradictorySummary = mapPiJsonlText(contradictory).filter((m) => m.type === 'run-summary');
  check(
    'contradictory clocks omit the duration',
    contradictorySummary.length === 1
      && contradictorySummary[0]?.status === 'done'
      && contradictorySummary[0]?.totalRuntimeMs === undefined,
    JSON.stringify(contradictorySummary),
  );

  // An aborted final entry is terminal evidence: cancelled, with its real span.
  const aborted = [
    jsonl({ type: 'message', id: 'bu1', timestamp: '2026-06-20T02:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'go' }], timestamp: Date.parse('2026-06-20T02:00:00.000Z') } }),
    jsonl({ type: 'message', id: 'ba1', timestamp: '2026-06-20T02:00:07.000Z', message: { role: 'assistant', stopReason: 'aborted', content: [{ type: 'text', text: 'stopped' }] } }),
  ].join('');
  const abortedSummary = mapPiJsonlText(aborted).filter((m) => m.type === 'run-summary');
  check(
    'an aborted turn closes as cancelled with its recorded span',
    abortedSummary.length === 1
      && abortedSummary[0]?.status === 'cancelled'
      && abortedSummary[0]?.totalRuntimeMs === 7000,
    JSON.stringify(abortedSummary),
  );
}

// ── 3. Pi bridge command queue ────────────────────────────────────────────────
{
  const conn = new PiBridgeConnection({ id: 'q-idle', tool: 'pi', title: 'queue', status: 'idle', attachMode: 'live' });
  await conn.sendPrompt({ text: 'idle prompt' });
  const cmds = await conn.takeCommands();
  await conn.close();
  const c = cmds[0];
  check('bridge queue: idle prompt has no deliverAs', c?.kind === 'prompt' && c.text === 'idle prompt' && c.deliverAs === undefined, JSON.stringify(c));
}
{
  const conn = new PiBridgeConnection({ id: 'q-busy-prompt', tool: 'pi', title: 'queue', status: 'idle', attachMode: 'live' });
  conn.ingest({ t: 'status', running: true });
  await conn.sendPrompt({ text: 'busy prompt' });
  const cmds = await conn.takeCommands();
  await conn.close();
  const c = cmds[0];
  check('bridge queue: running prompt uses deliverAs=steer', c?.kind === 'prompt' && c.text === 'busy prompt' && c.deliverAs === 'steer', JSON.stringify(c));
}
{
  const conn = new PiBridgeConnection({ id: 'q-busy-command', tool: 'pi', title: 'queue', status: 'idle', attachMode: 'live' });
  conn.ingest({ t: 'status', running: true });
  await conn.runCommand('skill:test', 'arg');
  const cmds = await conn.takeCommands();
  await conn.close();
  const c = cmds[0];
  check(
    'bridge queue: running slash command uses deliverAs=steer',
    c?.kind === 'command' && c.name === 'skill:test' && c.args === 'arg' && c.deliverAs === 'steer',
    JSON.stringify(c),
  );
}
{
  const conn = new PiBridgeConnection({ id: 'q-model', tool: 'pi', title: 'model', status: 'idle', attachMode: 'live' });
  const seen: any[] = [];
  const unsub = conn.subscribe((m) => seen.push(m));
  conn.setModelOptions([
    { providerID: 'fake', modelID: 'reasoner', label: 'Pi Reasoner', reasoning: true, thinkingLevelMap: { minimal: null } },
    { providerID: 'fake', modelID: 'plain', label: 'Plain', reasoning: false },
  ], 'medium');
  conn.ingest({
    t: 'model',
    model: { providerID: 'native', modelID: 'native-pi-model', label: 'Native Pi Model', reasoning: true, thinkingLevelMap: { low: true, high: true } },
    thinkingLevel: 'low',
  });
  const nativeUpdate = seen.find((m) => m.type === 'metadata-update' && m.key === 'sessionInfo');
  const models = await conn.listModels?.();
  await conn.sendPrompt({ text: 'use model', model: { providerID: 'fake', modelID: 'reasoner', reasoningEffort: 'high' } });
  const cmds = await conn.takeCommands();
  await conn.runCommand('skill:reason', 'arg', { model: { providerID: 'fake', modelID: 'reasoner', reasoningEffort: 'low' } });
  const commandCmds = await conn.takeCommands();
  const appOverrideUpdate = seen.filter((m) => m.type === 'metadata-update' && m.key === 'sessionInfo').at(-1);
  unsub();
  await conn.close();
  check(
    'bridge model wire: native model event emits sessionInfo and catalog exposes supported efforts',
    nativeUpdate?.value?.currentModel?.providerID === 'native' &&
      nativeUpdate?.value?.currentModel?.modelID === 'native-pi-model' &&
      nativeUpdate?.value?.currentModel?.reasoningEffort === 'low' &&
      conn.info.model === 'reasoner' &&
      appOverrideUpdate?.value?.currentModel?.modelID === 'reasoner' &&
      !!models?.some((m) =>
      m.providerID === 'fake' &&
      m.modelID === 'reasoner' &&
      m.defaultReasoningEffort === 'medium' &&
      m.reasoningEfforts?.some((e) => e.effort === 'high') &&
      !m.reasoningEfforts?.some((e) => e.effort === 'minimal')
    ),
    `native=${JSON.stringify(nativeUpdate)} appOverride=${JSON.stringify(appOverrideUpdate)} models=${JSON.stringify(models)}`,
  );
  check(
    'bridge model wire: prompt/command queue model switch before text',
      cmds[0]?.kind === 'set-model' &&
      cmds[0]?.providerID === 'fake' &&
      cmds[0]?.modelID === 'reasoner' &&
      cmds[0]?.reasoningEffort === 'high' &&
      cmds[1]?.kind === 'prompt' &&
      commandCmds[0]?.kind === 'set-model' &&
      commandCmds[0]?.reasoningEffort === 'low' &&
      commandCmds[1]?.kind === 'command',
    `cmds=${JSON.stringify(cmds)} commandCmds=${JSON.stringify(commandCmds)}`,
  );
}
{
  const registry = new PiBridgeRegistry(() => undefined);
  const conn = registry.hello('same', {
    id: 'same',
    tool: 'pi',
    title: 'first',
    cwd: '/tmp/old',
    status: 'idle',
    attachMode: 'live',
    currentModel: { providerID: 'old', modelID: 'stale' },
  });
  const same = registry.hello('same', { id: 'same', tool: 'pi', title: 'second', status: 'idle', attachMode: 'live' });
  check(
    'bridge registry re-hello replaces info instead of retaining omitted stale fields',
    same === conn && same.info.title === 'second' && same.info.cwd === undefined && same.info.currentModel === undefined,
    JSON.stringify(same.info),
  );
}
{
  const conn = new PiBridgeConnection({ id: 'q-permission', tool: 'pi', title: 'permission', status: 'idle', attachMode: 'live' });
  const seen: any[] = [];
  const unsub = conn.subscribe((m) => seen.push(m));
  conn.ingest({ t: 'permission-request', requestId: 'p1', toolName: 'bash', title: 'Run shell command?', detail: 'sudo true' });
  const pendingBeforeResolve = conn.getPending();
  await conn.respondPermission('p1', 'approve');
  const cmds = await conn.takeCommands();
  conn.ingest({ t: 'permission-resolved', requestId: 'p1', decision: 'approve' });
  const pendingAfterResolve = conn.getPending();
  unsub();
  await conn.close();
  const req = seen.find((m) => m.type === 'permission-request');
  const resolved = seen.find((m) => m.type === 'permission-resolved');
  const c = cmds[0];
  check(
    'bridge approval wire: request maps to card, replays pending, decision queues, resolution clears',
    req?.requestId === 'p1' &&
      req?.toolName === 'bash' &&
      pendingBeforeResolve.some((m) => m.type === 'permission-request' && m.requestId === 'p1') &&
      c?.kind === 'permission' &&
      c.decision === 'approve' &&
      resolved?.decision === 'approve' &&
      pendingAfterResolve.length === 0,
    `pendingBefore=${pendingBeforeResolve.length} cmd=${JSON.stringify(c)} pendingAfter=${pendingAfterResolve.length}`,
  );
}
{
  const conn = new PiBridgeConnection({ id: 'q-question', tool: 'pi', title: 'question', status: 'idle', attachMode: 'live' });
  const seen: any[] = [];
  const unsub = conn.subscribe((m) => seen.push(m));
  conn.ingest({
    t: 'question-request',
    requestId: 'q1',
    questions: [{ header: 'Trace choice', question: 'Continue?', options: [{ label: 'Yes', description: 'Continue' }] }],
  });
  const pendingBeforeResolve = conn.getPending();
  await conn.answerQuestion('q1', [['Yes']]);
  const cmds = await conn.takeCommands();
  conn.ingest({ t: 'question-resolved', requestId: 'q1' });
  const pendingAfterResolve = conn.getPending();
  unsub();
  await conn.close();
  const req = seen.find((m) => m.type === 'question-request');
  const resolved = seen.find((m) => m.type === 'question-resolved');
  const c = cmds[0];
  check(
    'bridge question wire: request maps to card, answer queues natively, resolution clears',
    req?.requestId === 'q1' &&
      req?.questions?.[0]?.options?.[0]?.label === 'Yes' &&
      pendingBeforeResolve.some((m) => m.type === 'question-request' && m.requestId === 'q1') &&
      c?.kind === 'answer' &&
      c.requestId === 'q1' &&
      c.answers?.[0]?.[0] === 'Yes' &&
      resolved?.requestId === 'q1' &&
      pendingAfterResolve.length === 0,
    `pendingBefore=${pendingBeforeResolve.length} cmd=${JSON.stringify(c)} pendingAfter=${pendingAfterResolve.length}`,
  );
}
{
  const conn = new PiBridgeConnection({ id: 'q-runtime', tool: 'pi', title: 'runtime', status: 'idle', attachMode: 'live' });
  const seen: any[] = [];
  const unsub = conn.subscribe((m) => seen.push(m));
  conn.ingest({ t: 'user', text: 'timed prompt', key: 'u-runtime', sentAt: 1000 });
  conn.ingest({
    t: 'run-summary',
    key: 'pi:run:t1',
    turnId: 't1',
    userMessageKey: 'u-runtime',
    assistantMessageKey: 't1:t',
    status: 'done',
    startedAt: 1000,
    completedAt: 3500,
    tokens: { input: 7, output: 3 },
  });
  conn.ingest({ t: 'runtime-totals', value: { totalRuntimeMs: 2500, turnCount: 1, source: 'pi-bridge-test' } });
  const history = await conn.getHistory();
  unsub();
  await conn.close();
  check(
    'bridge runtime wire: user sentAt, run-summary, and runtime totals map canonically',
    seen.some((m) => m.type === 'user-message' && m.key === 'u-runtime' && m.sentAt === 1000) &&
      seen.some((m) => m.type === 'run-summary' && m.turnId === 't1' && m.totalRuntimeMs === 2500 && m.tokens?.input === 7) &&
      seen.some((m) => m.type === 'metadata-update' && m.key === 'runtimeTotals' && m.value?.totalRuntimeMs === 2500) &&
      history.some((m) => m.type === 'run-summary' && m.turnId === 't1'),
    JSON.stringify(seen),
  );
}

// ── 4. Pi bridge approval policy helpers ─────────────────────────────────────
{
  const bridgeModule = await import(
    freshModuleSpecifier(BRIDGE_MODULE_PATH, brokerFixtureRoot)
  ) as any;
  const dangerousBashCommand = bridgeModule.dangerousBashCommand as (command: string) => boolean;
  check('bridge approval policy: detects rm -fr', dangerousBashCommand('rm -fr /tmp/cosyncing-danger'));
  check('bridge approval policy: detects split rm -f -r', dangerousBashCommand('rm -f -r /tmp/cosyncing-danger'));
  check('bridge approval policy: detects long rm --force --recursive', dangerousBashCommand('/bin/rm --force --recursive /tmp/cosyncing-danger'));
  check('bridge approval policy: detects sudo', dangerousBashCommand('sudo -n true'));
  check('bridge approval policy: does not flag quoted text', !dangerousBashCommand("printf 'rm -fr /tmp/cosyncing-danger'"));
}

// ── 5. live BRIDGE wire end-to-end ─────────────────────────────────────────────
const portLease = await reserveLoopbackFixturePort();
const PORT = Number(process.env.COSYNCING_TEST_PORT ?? portLease.port);
const BROKER = `http://127.0.0.1:${PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await portLease.release();
// Started through the shared helper: a silent startup stall — alive, not
// listening, nothing written — is retired and respawned once on THIS port
// instead of costing the suite its whole readiness budget.
let brokerOutput!: ReturnType<typeof captureProcessOutput>;
const broker = await startHealthyFixtureBrokerOnPort({
  port: PORT,
  healthUrl: `${BROKER}/api/health`,
  spawn: () => {
    const child = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
      env: isolatedBrokerFixtureEnvironment(brokerFixtureRoot, {
        overrides: { PORT: String(PORT), HOST: '127.0.0.1' },
      }),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    brokerOutput = captureProcessOutput(child);
    return child;
  },
  capture: () => brokerOutput,
  stop: async (child) => { child.kill(); await child.exited.catch(() => undefined); },
});
const post = (path: string, body: unknown) =>
  fetch(`${BROKER}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

try {
  const sf = `/tmp/cabridge-enrich-${Math.random().toString(36).slice(2, 8)}.jsonl`;
  const id = String((await (await post('/pi/bridge/hello', {
    sessionFile: sf,
    cwd: '/tmp',
    title: 'enrich-test',
    model: { providerID: 'fake', modelID: 'reasoner', label: 'Pi Reasoner', reasoning: true, reasoningEffort: 'medium' },
    thinkingLevel: 'medium',
    models: [
      { providerID: 'fake', modelID: 'reasoner', label: 'Pi Reasoner', reasoning: true, thinkingLevelMap: { minimal: null } },
      { providerID: 'fake', modelID: 'plain', label: 'Plain', reasoning: false },
    ],
  })).json()).id);

  const frames: any[] = [];
  const ws = new WebSocket(`${WSBASE}/api/sessions/pi/${encodeURIComponent(id)}/stream`);
  ws.onmessage = (e) => { try { frames.push(JSON.parse(String(e.data))); } catch { /* skip */ } };
  await new Promise<void>((res) => { ws.onopen = () => res(); });
  await sleep(400); // attach completes (session + history)

  const diff = '--- a/app.ts\n+++ b/app.ts\n@@\n+new line\n+another\n-gone\n';
  await post('/pi/bridge/events', {
    id,
    events: [
      { t: 'user', text: 'edit the file', key: 'msg-123' },
      { t: 'run-summary', key: 'pi:run:t1', turnId: 't1', userMessageKey: 'msg-123', status: 'done', startedAt: 1000, completedAt: 4000, tokens: { input: 3, output: 4 } },
      { t: 'runtime-totals', value: { totalRuntimeMs: 3000, turnCount: 1, source: 'pi-bridge-wire' } },
      { t: 'tool-result', callId: 'c1', name: 'edit', result: 'ok', isError: false, details: { diff }, args: { path: 'app.ts' } },
      { t: 'tool-result', callId: 'c2', name: 'bash', result: 'fail\nCommand exited with code 1', isError: true, details: { truncation: { truncated: true } } },
    ],
  });

  const waitFor = async (pred: (f: any) => boolean): Promise<any> => {
    const end = Date.now() + 3000;
    for (;;) { const f = frames.find(pred); if (f) return f; if (Date.now() > end) return undefined; await sleep(60); }
  };
  const toolMsg = (callId: string) => (f: any) => f.kind === 'message' && f.message?.type === 'tool-result' && f.message?.callId === callId;
  const sessionFrame = await waitFor((f) => f.kind === 'session');
  const optionsFrame = await waitFor((f) => f.kind === 'options');
  const userFrame = await waitFor((f) => f.kind === 'message' && f.message?.type === 'user-message');
  const runFrame = await waitFor((f) => f.kind === 'message' && f.message?.type === 'run-summary');
  const totalsFrame = await waitFor((f) => f.kind === 'message' && f.message?.type === 'metadata-update' && f.message?.key === 'runtimeTotals');
  const editFrame = await waitFor(toolMsg('c1'));
  const bashFrame = await waitFor(toolMsg('c2'));
  ws.close();

  const u = userFrame?.message;
  check(
    'bridge: session/options frames expose current model and model-effort options through broker',
    sessionFrame?.info?.currentModel?.modelID === 'reasoner' &&
      sessionFrame?.info?.currentModel?.reasoningEffort === 'medium' &&
      optionsFrame?.models?.some((m: any) =>
        m.providerID === 'fake' &&
        m.modelID === 'reasoner' &&
        m.reasoningEfforts?.some((e: any) => e.effort === 'high') &&
        !m.reasoningEfforts?.some((e: any) => e.effort === 'minimal')
      ) &&
      Array.isArray(optionsFrame?.modes) &&
      optionsFrame.modes.length === 0,
    `session=${JSON.stringify(sessionFrame?.info?.currentModel)} options=${JSON.stringify(optionsFrame)}`,
  );
  check('bridge: user-message carries the relayed key', !!u && u.key === 'msg-123', `key=${u?.key}`);
  const run = runFrame?.message;
  const totals = totalsFrame?.message;
  check('bridge: run-summary and runtime totals cross the broker wire', run?.totalRuntimeMs === 3000 && run?.tokens?.input === 3 && totals?.value?.totalRuntimeMs === 3000, `run=${JSON.stringify(run)} totals=${JSON.stringify(totals)}`);
  const em = editFrame?.message;
  check('bridge: edit tool-result enriched (diff + diffstat + path)',
    !!em && em.diff === diff && em.additions === 2 && em.deletions === 1 && em.path === 'app.ts',
    `+${em?.additions} -${em?.deletions} path=${em?.path}`);
  const bm = bashFrame?.message;
  check('bridge: bash tool-result enriched (exitCode + truncated)', !!bm && bm.exitCode === 1 && bm.truncated === true, `exit=${bm?.exitCode} truncated=${bm?.truncated}`);
} catch (err) {
  check('bridge wire end-to-end', false, 'threw: ' + String(err));
} finally {
  broker.kill();
}

// ── 7. Pi live bridge ask_user tool ───────────────────────────────────────────
{
  const originalFetch = globalThis.fetch;
  const handlers = new Map<string, (event?: any, ctx?: any) => unknown>();
  const tools = new Map<string, any>();
  const events: any[] = [];
  let requestId = '';
  let answered = false;
  try {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/pi/bridge/hello')) return Response.json({ id: 'bridge-ask-user' });
      if (url.endsWith('/pi/bridge/events')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        events.push(...(body.events ?? []));
        const q = (body.events ?? []).find((ev: any) => ev.t === 'question-request');
        if (q) requestId = String(q.requestId);
        return Response.json({ ok: true });
      }
      if (url.includes('/pi/bridge/commands')) {
        const end = Date.now() + 1000;
        while (!requestId && Date.now() < end) await sleep(10);
        if (requestId && !answered) {
          answered = true;
          return Response.json({ commands: [{ kind: 'answer', requestId, answers: [['Proceed']] }] });
        }
        return Response.json({ commands: [] });
      }
      return Response.json({});
    }) as typeof fetch;
    const bridge = await import(
      freshModuleSpecifier(BRIDGE_MODULE_PATH, brokerFixtureRoot)
    );
    const fakePi = {
      on(name: string, cb: (event?: any, ctx?: any) => unknown) { handlers.set(name, cb); },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      getThinkingLevel() { return 'medium'; },
      sendUserMessage: async () => undefined,
      setModel: async () => true,
      setThinkingLevel: () => undefined,
    };
    bridge.default(fakePi as any);
    const signal = new EventTarget();
    const ctx = {
      cwd: '/tmp/pi-ask-user',
      signal,
      sessionManager: { getSessionFile: () => '/tmp/pi-ask-user/session.jsonl', entries: [] },
      model: { provider: 'fake', id: 'reasoner', name: 'Reasoner', reasoning: true, thinkingLevelMap: {} },
      modelRegistry: { getAvailable: () => [], find: () => undefined },
      ui: { setStatus: () => undefined },
      isIdle: () => true,
    };
    await handlers.get('session_start')?.({}, ctx);
    const askUser = tools.get('ask_user');
    const result = await askUser.execute('tool-ask', { question: 'Continue?', options: ['Proceed'] }, ctx);
    await handlers.get('session_shutdown')?.({ reason: 'quit' }, ctx);
    const question = events.find((ev) => ev.t === 'question-request');
    const resolved = events.find((ev) => ev.t === 'question-resolved' && ev.requestId === question?.requestId);
    check(
      'Pi live bridge ask_user tool round-trips app question answers',
      !!question &&
        question.questions?.[0]?.question === 'Continue?' &&
        resolved?.requestId === question.requestId &&
        result?.details?.answers?.[0]?.[0] === 'Proceed' &&
        /Proceed/.test(String(result?.content?.[0]?.text ?? '')),
      `question=${JSON.stringify(question)} result=${JSON.stringify(result)}`,
    );
  } catch (err) {
    check('Pi live bridge ask_user tool round-trips app question answers', false, String(err));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

rmSync(brokerFixtureRoot, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
