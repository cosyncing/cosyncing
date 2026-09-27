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
 *   6. Turn attention pairing on a Drive (RPC) connection: each driven turn reaches subscribers as
 *      exactly one live `running` run-summary before exactly one terminal under the same key, a
 *      real AttentionPolicy raises one outcome per turn, and attaching to the finished session
 *      (Drive or Observe) replays those turns without a live `running`.
 *
 * Pure + self-contained: the unit half imports the helpers directly; the wire half starts its OWN
 * broker on a free port and simulates the extension over /pi/bridge/* + a phone WebSocket — no real
 * `pi`, no LLM cost. Scripts import adapters by RELATIVE path (scripts/broker/ isn't a workspace package).
 *
 *   bun run packages/typescript/broker/test/pi/test-tool-result-enrich.ts      (exit 0 = all pass)
 */
export {};
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { summarizeDiff, splitUnifiedDiffFiles, type AgentMessage } from '../../../adapter-api/src/index.ts';
import { enrichPiToolResult, piToolDisplayClass } from '../../../adapters/pi/src/index.ts';
import { PiBridgeConnection, PiBridgeRegistry } from '../../../adapters/pi/src/bridge.ts';
import {
  freshModuleSpecifier,
  captureProcessOutput,
  isolatedBrokerFixtureEnvironment,
  reserveLoopbackFixturePort,
  settledProcessOutput,
  startHealthyFixtureBrokerOnPort,
} from '../helpers/isolated-broker-fixture.ts';

const BRIDGE_MODULE_PATH = resolve(
  import.meta.dir,
  '../../../pi-engine/agent-extensions/cosyncing-bridge/index.ts',
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
      JSON.stringify(req?.options) === '["approve","approve-session","reject"]' &&
      pendingBeforeResolve.some((m) => m.type === 'permission-request' && m.requestId === 'p1') &&
      c?.kind === 'permission' &&
      c.decision === 'approve' &&
      resolved?.decision === 'approve' &&
      pendingAfterResolve.length === 0,
    `pendingBefore=${pendingBeforeResolve.length} cmd=${JSON.stringify(c)} pendingAfter=${pendingAfterResolve.length}`,
  );
}
{
  // Advertisement of the third answer on the BRIDGED card — live AND on the hello backfill, so a card
  // still open when a phone attaches offers the same three buttons it would have offered live. The
  // decision must cross to the extension verbatim; section 8 pins the extension's end of that promise.
  const conn = new PiBridgeConnection({ id: 'q-permission-session', tool: 'pi', title: 'permission', status: 'idle', attachMode: 'live' });
  const seen: any[] = [];
  const unsub = conn.subscribe((m) => seen.push(m));
  conn.ingestHistory([{ t: 'permission-request', requestId: 'p0', toolName: 'bash', title: 'Run shell command?', detail: 'sudo -n true' }]);
  conn.ingest({ t: 'permission-request', requestId: 'p2', toolName: 'bash', title: 'Run shell command?', detail: 'sudo -n true' });
  await conn.respondPermission('p2', 'approve-session');
  const cmds = await conn.takeCommands();
  const history = await conn.getHistory();
  unsub();
  await conn.close();
  const live = seen.find((m) => m.type === 'permission-request');
  const replayed = history.find((m: any) => m.type === 'permission-request');
  const advertised = JSON.stringify(live?.options);
  check(
    'bridge approval advertisement: live + backfill cards offer approve/approve-session/reject and the session decision queues verbatim',
    advertised === '["approve","approve-session","reject"]' &&
      JSON.stringify((replayed as any)?.options) === advertised &&
      cmds[0]?.kind === 'permission' &&
      cmds[0]?.decision === 'approve-session',
    `live=${advertised} backfill=${JSON.stringify((replayed as any)?.options)} cmd=${JSON.stringify(cmds[0])}`,
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
  await broker.exited.catch(() => undefined);
  await settledProcessOutput(brokerOutput);
}

// ── 7. Pi live bridge ask_user tool ───────────────────────────────────────────
{
  const originalFetch = globalThis.fetch;
  const handlers = new Map<string, (event?: any, ctx?: any) => unknown>();
  const tools = new Map<string, any>();
  const events: any[] = [];
  let requestId = '';
  let answered = false;
  let terminalDismissed = false;
  let bridgeReady = false;
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
    const signal = new AbortController().signal;
    const ctx = {
      cwd: '/tmp/pi-ask-user',
      mode: 'tui',
      hasUI: true,
      signal,
      sessionManager: { getSessionFile: () => '/tmp/pi-ask-user/session.jsonl', entries: [] },
      model: { provider: 'fake', id: 'reasoner', name: 'Reasoner', reasoning: true, thinkingLevelMap: {} },
      modelRegistry: { getAvailable: () => [], find: () => undefined },
      ui: {
        setStatus: (_key: string, value?: string) => {
          if (value?.includes('bridged')) bridgeReady = true;
        },
        select: (_title: string, _options: string[], opts?: { signal?: AbortSignal }) => new Promise<string | undefined>((resolve) => {
          const dismiss = () => {
            terminalDismissed = true;
            resolve(undefined);
          };
          if (opts?.signal?.aborted) dismiss();
          else opts?.signal?.addEventListener('abort', dismiss, { once: true });
        }),
      },
      isIdle: () => true,
    };
    await handlers.get('session_start')?.({}, ctx);
    while (!bridgeReady) await sleep(10);
    const askUser = tools.get('ask_user');
    const result = await askUser.execute('tool-ask', { question: 'Continue?', options: ['Proceed'] }, signal, undefined, ctx);
    await handlers.get('session_shutdown')?.({ reason: 'quit' }, ctx);
    const question = events.find((ev) => ev.t === 'question-request');
    const resolved = events.find((ev) => ev.t === 'question-resolved' && ev.requestId === question?.requestId);
    check(
      'Pi live bridge ask_user tool round-trips app question answers',
      !!question &&
        question.questions?.[0]?.question === 'Continue?' &&
        resolved?.requestId === question.requestId &&
        terminalDismissed &&
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

// ── 7b. Pi live bridge ask_user terminal answer ──────────────────────────────
{
  const originalFetch = globalThis.fetch;
  const handlers = new Map<string, (event?: any, ctx?: any) => unknown>();
  const tools = new Map<string, any>();
  const events: any[] = [];
  let terminalShown = false;
  let bridgeReady = false;
  try {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/pi/bridge/hello')) return Response.json({ id: 'bridge-terminal-answer' });
      if (url.endsWith('/pi/bridge/events')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        events.push(...(body.events ?? []));
        return Response.json({ ok: true });
      }
      if (url.includes('/pi/bridge/commands')) {
        await sleep(10);
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
    const signal = new AbortController().signal;
    const ctx = {
      cwd: '/tmp/pi-ask-user-terminal',
      mode: 'tui',
      hasUI: true,
      signal,
      sessionManager: { getSessionFile: () => '/tmp/pi-ask-user-terminal/session.jsonl', entries: [] },
      model: { provider: 'fake', id: 'reasoner', name: 'Reasoner', reasoning: true, thinkingLevelMap: {} },
      modelRegistry: { getAvailable: () => [], find: () => undefined },
      ui: {
        setStatus: (_key: string, value?: string) => {
          if (value?.includes('bridged')) bridgeReady = true;
        },
        select: async (title: string, options: string[]) => {
          terminalShown = title === 'Continue?' && options.includes('Proceed');
          return 'Proceed';
        },
      },
      isIdle: () => true,
    };
    await handlers.get('session_start')?.({}, ctx);
    while (!bridgeReady) await sleep(10);
    const askUser = tools.get('ask_user');
    const result = await askUser.execute('tool-ask-terminal', { question: 'Continue?', options: ['Proceed'] }, signal, undefined, ctx);
    await handlers.get('session_shutdown')?.({ reason: 'quit' }, ctx);
    const question = events.find((ev) => ev.t === 'question-request');
    const resolved = events.find((ev) => ev.t === 'question-resolved' && ev.requestId === question?.requestId);
    check(
      'Pi live bridge ask_user accepts the native terminal answer and closes the app card',
      terminalShown &&
        !!question &&
        resolved?.requestId === question.requestId &&
        result?.details?.answers?.[0]?.[0] === 'Proceed',
      `terminalShown=${terminalShown} question=${JSON.stringify(question)} result=${JSON.stringify(result)}`,
    );
  } catch (err) {
    check('Pi live bridge ask_user accepts the native terminal answer and closes the app card', false, String(err));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ── 7c. Pi ask_user remains usable when the Cosyncing broker is unavailable ──
{
  const tools = new Map<string, any>();
  try {
    const bridge = await import(
      freshModuleSpecifier(BRIDGE_MODULE_PATH, brokerFixtureRoot)
    );
    bridge.default({
      on: () => undefined,
      registerTool(tool: any) { tools.set(tool.name, tool); },
    } as any);
    const askUser = tools.get('ask_user');
    const signal = new AbortController().signal;
    const ctx = {
      mode: 'tui',
      hasUI: true,
      signal,
      ui: { input: async () => 'Howard' },
    };
    const result = await askUser.execute('tool-ask-offline', { question: 'Your name?' }, signal, undefined, ctx);
    check(
      'Pi ask_user falls back to the native terminal when the bridge is offline',
      result?.details?.answers?.[0]?.[0] === 'Howard' && /Howard/.test(String(result?.content?.[0]?.text ?? '')),
      `result=${JSON.stringify(result)}`,
    );
  } catch (err) {
    check('Pi ask_user falls back to the native terminal when the bridge is offline', false, String(err));
  }
}

// ── 8. Pi live bridge approve-session: the extension honors what the card advertises ──────────
// The bridged card now offers a third button. Pi is the one adapter where the remembering is OURS,
// so the promise behind that button is pinned here, against the REAL extension: the decision is
// honored, its scope is the exact tool PLUS the exact input, and it lives only as long as this
// bridge registration (a broker restart re-hellos, which clears the set).
{
  const originalFetch = globalThis.fetch;
  const handlers = new Map<string, (event?: any, ctx?: any) => unknown>();
  const events: any[] = [];
  const answered = new Set<string>();
  const nextDecisions: string[] = [];
  // The extension only polls for commands once its registration id is SET, so a poll — not the hello
  // response — is the signal that the bridge is live. Gating on the hello alone races: `tool_call`
  // short-circuits on `!id` and silently asks for no approval at all.
  const polledIds: string[] = [];
  let helloCount = 0;
  let forgetOnce = false;
  const requests = () => events.filter((ev) => ev.t === 'permission-request');
  const waitUntil = async (pred: () => boolean, ms = 5000): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pred()) return true;
      await sleep(25);
    }
    return pred();
  };
  try {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/pi/bridge/hello')) {
        helloCount += 1;
        return Response.json({ id: `bridge-approve-session-${helloCount}` });
      }
      if (url.endsWith('/pi/bridge/bye')) return Response.json({ ok: true });
      if (url.endsWith('/pi/bridge/events')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        events.push(...(body.events ?? []));
        return Response.json({ ok: true });
      }
      if (url.includes('/pi/bridge/commands')) {
        polledIds.push(new URL(url).searchParams.get('id') ?? '');
        if (forgetOnce) {
          forgetOnce = false; // one 404 = the broker restarted and forgot this registration
          return new Response('unknown bridge', { status: 404 });
        }
        await sleep(20); // stand in for the broker's long poll so the loop doesn't spin hot
        const open = requests().find((ev) => !answered.has(ev.requestId));
        if (open && nextDecisions.length) {
          answered.add(String(open.requestId));
          return Response.json({ commands: [{ kind: 'permission', requestId: open.requestId, decision: nextDecisions.shift() }] });
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
      registerTool() { /* not exercised here */ },
      getThinkingLevel() { return 'medium'; },
      sendUserMessage: async () => undefined,
      setModel: async () => true,
      setThinkingLevel: () => undefined,
    };
    (bridge as any).default(fakePi as any);
    const ctx = {
      cwd: '/tmp/pi-approve-session',
      signal: new EventTarget(),
      sessionManager: { getSessionFile: () => '/tmp/pi-approve-session/session.jsonl', entries: [] },
      model: { provider: 'fake', id: 'reasoner', name: 'Reasoner', reasoning: true, thinkingLevelMap: {} },
      modelRegistry: { getAvailable: () => [], find: () => undefined },
      ui: { setStatus: () => undefined },
      isIdle: () => true,
    };
    await handlers.get('session_start')?.({}, ctx);
    const live = await waitUntil(() => polledIds.includes('bridge-approve-session-1'));
    check('bridge extension: fake bridge registered and polling', live, `hellos=${helloCount} polls=${polledIds.length}`);
    const toolCall = handlers.get('tool_call') as (event: any, c: any) => Promise<any>;
    const danger = { toolName: 'bash', input: { command: 'sudo -n true' } };

    nextDecisions.push('approve-session');
    const first = await toolCall(danger, ctx);
    const afterFirst = requests().length;
    const second = await toolCall({ toolName: 'bash', input: { command: 'sudo -n true' } }, ctx);
    await sleep(120); // a second card would have been flushed by now (60ms coalescing)
    const afterSecond = requests().length;
    await waitUntil(() => events.some((ev) => ev.t === 'permission-resolved'));
    const resolved = events.find((ev) => ev.t === 'permission-resolved');
    check(
      'bridge extension: approve-session approves once, resolves with the session decision, and never prompts that exact call again',
      first === undefined && second === undefined && afterFirst === 1 && afterSecond === 1 && resolved?.decision === 'approve-session',
      `first=${JSON.stringify(first)} second=${JSON.stringify(second)} cards=${afterFirst}/${afterSecond} resolved=${JSON.stringify(resolved)}`,
    );

    // Exact-input scope: a DIFFERENT command is a different scope and prompts again.
    nextDecisions.push('reject');
    const other = await toolCall({ toolName: 'bash', input: { command: 'sudo -n false' } }, ctx);
    check(
      'bridge extension: the approved scope is tool + exact input — a different command prompts again',
      requests().length === 2 && other?.block === true,
      `cards=${requests().length} result=${JSON.stringify(other)}`,
    );

    // Lifetime: the memory is this registration's. A broker restart (404 → re-hello) clears it.
    forgetOnce = true;
    const reHelloed = await waitUntil(() => polledIds.includes('bridge-approve-session-2'), 10000);
    nextDecisions.push('approve');
    const afterRestart = await toolCall({ toolName: 'bash', input: { command: 'sudo -n true' } }, ctx);
    check(
      'bridge extension: session approval lasts only as long as this bridge registration (re-hello clears it)',
      reHelloed && requests().length === 3 && afterRestart === undefined,
      `hellos=${helloCount} cards=${requests().length} result=${JSON.stringify(afterRestart)}`,
    );
    await handlers.get('session_shutdown')?.({ reason: 'quit' }, ctx);
  } catch (err) {
    check('bridge extension: approve-session honored, exact-input scoped, registration-lived', false, String(err));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ── 9. Turn attention pairing on a Drive (RPC) connection ─────────────────────
// The broker raises "Turn finished"/"Turn failed" only for a LIVE `running` run-summary followed by
// a terminal one under the same key. So each turn this connection drives must reach its subscribers
// as exactly that pair, and attaching to a session whose turns already ended must replay them as
// history only: a live `running` there would notify for an old turn. The engine runs against a fake
// RPC Pi (readiness is stubbed — the engine is under test, not the host's Node qualification), and
// exactly what the subscribers received is fed to a real AttentionPolicy.
{
  const { PiEngineAdapter, PI_DIALECT, resolvePiDialectRuntime } = await import('../../../adapters/pi/src/index.ts');
  const { AttentionPolicy } = await import('../../src/attention/attention-policy.ts');
  const { AttentionStore } = await import('../../src/attention/attention-store.ts');
  const root = join(brokerFixtureRoot, 'turn-attention');
  const cwd = join(root, 'work');
  const fakePi = join(root, 'pi');
  const sessionFile = join(root, 'sessions', '2026-09-23T00-00-00-000Z_attention.jsonl');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(root, 'sessions'), { recursive: true });
  // One turn finished before any connection saw it.
  writeFileSync(sessionFile, [
    { type: 'session', version: 3, id: 'attention', timestamp: '2026-09-23T09:00:00.000Z', cwd },
    { type: 'message', id: 'prior-user', parentId: null, timestamp: '2026-09-23T09:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'finished before attach' }], timestamp: Date.parse('2026-09-23T09:00:01.000Z') } },
    { type: 'message', id: 'prior-assistant', parentId: 'prior-user', timestamp: '2026-09-23T09:00:03.000Z', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'already done' }] } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');
  // Persists each prompt's entries the way Pi does, so a later attach finds the finished turns.
  // `degraded` omits the user message_start and assistant message_end, the engine's fallback path.
  writeFileSync(fakePi, `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const file = args[args.indexOf('--session') + 1];
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
let parentId = 'prior-assistant';
let seq = 0;
let clock = Date.parse('2026-09-23T10:00:00.000Z');
const persist = (message, at) => {
  const id = 'rpc-' + (++seq);
  appendFileSync(file, JSON.stringify({ type: 'message', id, parentId, timestamp: new Date(at).toISOString(), message }) + '\\n');
  parentId = id;
};
let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  const lines = buffered.split('\\n');
  buffered = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    if (req.type === 'get_state') {
      send({ type: 'response', id: req.id, command: 'get_state', success: true, data: { model: { provider: 'fake', id: 'attention', name: 'Attention' }, thinkingLevel: 'off', sessionFile: file } });
    } else if (req.type === 'get_session_stats') {
      send({ type: 'response', id: req.id, command: 'get_session_stats', success: true, data: { contextUsage: { tokens: 10, contextWindow: 1000 } } });
    } else if (req.type === 'prompt') {
      send({ type: 'response', id: req.id, command: 'prompt', success: true });
      const text = String(req.message ?? '');
      const at = (clock += 10000);
      const degraded = text.includes('degraded');
      const failed = text.includes('error');
      const user = { role: 'user', content: [{ type: 'text', text }], timestamp: at };
      const assistant = {
        role: 'assistant',
        stopReason: failed ? 'error' : 'stop',
        ...(failed ? { error: { message: 'fixture failure' } } : {}),
        content: [{ type: 'text', text: 'reply: ' + text }],
        usage: { input: 1, output: 1 },
        timestamp: at,
      };
      persist(user, at);
      send({ type: 'agent_start', timestamp: at });
      send({ type: 'turn_start', timestamp: at });
      if (!degraded) send({ type: 'message_start', timestamp: at, message: user });
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'reply: ' + text } });
      if (!degraded) send({ type: 'message_end', timestamp: at + 2000, message: assistant });
      persist(assistant, at + 2000);
      send({ type: 'agent_end', timestamp: at + 2000 });
    } else {
      send({ type: 'response', id: req.id, command: req.type, success: req.type === 'abort' });
    }
  }
});
process.stdin.resume();
`);
  chmodSync(fakePi, 0o755);
  const runtime = resolvePiDialectRuntime(PI_DIALECT, { HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent') }, {
    hooks: {
      readiness: () => ({ ready: true, executable: fakePi, message: 'fixture Pi', detailCode: 'ready' }),
      diagnose: async () => { throw new Error('not exercised'); },
    },
    bridgeAsset: { source: '', sha256: '' },
  });
  const adapter = new PiEngineAdapter(runtime, { brokerUrl: 'http://127.0.0.1:1' });
  const sessionId = Buffer.from(sessionFile, 'utf8').toString('base64url');
  const store = new AttentionStore({ path: join(root, 'attention-events.json') });
  const policy = new AttentionPolicy(store);
  const summaries = (frames: AgentMessage[]) =>
    frames.filter((m): m is Extract<AgentMessage, { type: 'run-summary' }> => m.type === 'run-summary');
  // key → statuses, in the order the subscriber received them.
  const pairs = (frames: AgentMessage[]) => {
    const out = new Map<string, string[]>();
    for (const m of summaries(frames)) out.set(m.key, [...(out.get(m.key) ?? []), m.status]);
    return out;
  };
  const waitUntil = async (pred: () => boolean, ms = 5000): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end && !pred()) await sleep(25);
    return pred();
  };
  const deliver = async (info: any, frames: AgentMessage[]) => {
    for (const m of frames) await policy.handleMessage(info, m);
  };
  const drive = await adapter.attach(sessionId, 'resume');
  try {
    const attachFrames: AgentMessage[] = [];
    const turnFrames: AgentMessage[] = [];
    let sink = attachFrames;
    drive.subscribe((m) => sink.push(m));
    const attachHistory = await drive.getHistory();
    await sleep(150);
    check(
      'Drive attach to a finished turn replays it as history only, never as a live running summary',
      summaries(attachFrames).length === 0
        && summaries(attachHistory).some((m) => m.key === 'pi:run:u0' && m.status === 'done'),
      JSON.stringify({ live: summaries(attachFrames), history: summaries(attachHistory) }),
    );

    sink = turnFrames;
    const turns = [
      { text: 'attention done', key: 'pi:run:u1', terminal: 'done' },
      { text: 'attention error', key: 'pi:run:u2', terminal: 'error' },
      { text: 'attention degraded', key: 'pi:run:u3', terminal: 'done' },
    ];
    for (const turn of turns) {
      await drive.sendPrompt({ text: turn.text });
      await waitUntil(() => summaries(turnFrames).some((m) => m.key === turn.key && m.status !== 'running'));
    }
    const live = pairs(turnFrames);
    const livePair = (key: string, terminal: string) =>
      JSON.stringify(live.get(key)) === JSON.stringify(['running', terminal]);
    check(
      'each driven Pi turn reaches subscribers as one live running, then one terminal, under one key',
      live.size === 3 && livePair('pi:run:u1', 'done') && livePair('pi:run:u2', 'error')
        && summaries(turnFrames).every((m) => m.source === 'pi-rpc'),
      JSON.stringify([...live]),
    );
    check(
      'a degraded RPC stream (no user start, no assistant end) still pairs its fallback running',
      livePair('pi:run:u3', 'done'),
      JSON.stringify(live.get('pi:run:u3')),
    );

    await deliver(drive.info, [...attachFrames, ...turnFrames]);
    const events = store.listEvents();
    const outcome = (kind: string, key: string) =>
      events.filter((event) => event.kind === kind && event.dedupeKey === `${kind}:pi:${sessionId}:${key}`).length;
    check(
      'a real AttentionPolicy raises exactly one outcome per driven Pi turn',
      events.length === 3
        && outcome('run-finished', 'pi:run:u1') === 1
        && outcome('run-failed', 'pi:run:u2') === 1
        && outcome('run-finished', 'pi:run:u3') === 1
        && store.listObservations().length === 0,
      JSON.stringify({ events: events.map((event) => event.dedupeKey), open: store.listObservations().map((o) => o.key) }),
    );
  } finally {
    await drive.close();
  }

  // Catch-up: the three turns are finished and persisted. Attaching again, in either mode, must
  // deliver them through history under the SAME keys and put no running summary on the live stream.
  for (const mode of ['resume', 'observe'] as const) {
    const again = await adapter.attach(sessionId, mode);
    try {
      const frames: AgentMessage[] = [];
      again.subscribe((m) => frames.push(m));
      const history = await again.getHistory();
      await sleep(300);
      const replayed = pairs(history);
      const eventsBefore = store.listEvents().length;
      const openBefore = store.listObservations().length;
      await deliver(again.info, frames);
      check(
        `${mode === 'resume' ? 'Drive' : 'Observe'} re-attach to finished Pi turns emits no live running and raises nothing`,
        summaries(frames).length === 0
          && JSON.stringify(replayed.get('pi:run:u1')) === '["done"]'
          && JSON.stringify(replayed.get('pi:run:u2')) === '["error"]'
          && JSON.stringify(replayed.get('pi:run:u3')) === '["done"]'
          && store.listEvents().length === eventsBefore
          && store.listObservations().length === openBefore,
        JSON.stringify({ live: summaries(frames), history: [...replayed] }),
      );
    } finally {
      await again.close();
    }
  }
}

// ── Live keys equal history keys on a Drive (RPC) connection ─────────────────
// A client merges rows by key, so a live row and its session-file copy must carry one key, or a
// history refresh or reconnect frame restating the copy shows it twice. The fake streams turns and
// persists them the way Pi does (see `pi-rpc-turn-fixture.ts` for the source of each shape): steps
// with thinking, text and tool calls, a steer injected mid-turn, a refused prompt, a message with
// two text blocks around a call and one whose first text block stays empty. Everything is
// compared through the real connection's live mapping and its real history read.
{
  const { PiEngineAdapter, PI_DIALECT, resolvePiDialectRuntime } = await import('../../../adapters/pi/src/index.ts');
  const { ManagedConn } = await import('../../src/sessions/hub.ts');
  const { historyRefreshRequest } = await import('../../src/sessions/history-delta.ts');
  const { PI_RPC_TURN_FIXTURE_SOURCE } = await import('../helpers/pi-rpc-turn-fixture.ts');
  const { auditLiveAgainstHistory } = await import('../helpers/live-history-key-audit.ts');
  const root = join(brokerFixtureRoot, 'live-history-keys');
  const cwd = join(root, 'work');
  const fakePi = join(root, 'pi');
  const sessionFile = join(root, 'sessions', '2026-09-26T00-00-00-000Z_keys.jsonl');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(root, 'sessions'), { recursive: true });
  writeFileSync(sessionFile, [
    { type: 'session', version: 3, id: 'keys', timestamp: '2026-09-26T09:00:00.000Z', cwd },
    { type: 'message', id: 'a1b2c3d4', parentId: null, timestamp: '2026-09-26T09:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'before attach' }], timestamp: Date.parse('2026-09-26T09:00:01.000Z') } },
    { type: 'message', id: 'e5f6a7b8', parentId: 'a1b2c3d4', timestamp: '2026-09-26T09:00:03.000Z', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'answered before attach' }], timestamp: Date.parse('2026-09-26T09:00:02.000Z') } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');
  writeFileSync(fakePi, `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
${PI_RPC_TURN_FIXTURE_SOURCE}
const args = process.argv.slice(2);
const file = args[args.indexOf('--session') + 1];
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const fixture = createPiRpcTurnFixture({ file, emit: send, correlated: false });
let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  const lines = buffered.split('\\n');
  buffered = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    if (req.type === 'prompt') fixture.handlePrompt(req, send);
    else if (req.type === 'get_state') send({ type: 'response', id: req.id, command: 'get_state', success: true, data: { model: { provider: 'fixture', id: 'keys', name: 'Keys' }, thinkingLevel: 'off', sessionFile: file } });
    else if (req.type === 'get_session_stats') send({ type: 'response', id: req.id, command: 'get_session_stats', success: true, data: {} });
    else send({ type: 'response', id: req.id, command: req.type, success: req.type === 'abort' });
  }
});
process.stdin.resume();
`);
  chmodSync(fakePi, 0o755);
  const runtime = resolvePiDialectRuntime(PI_DIALECT, { HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent') }, {
    hooks: {
      readiness: () => ({ ready: true, executable: fakePi, message: 'fixture Pi', detailCode: 'ready' }),
      diagnose: async () => { throw new Error('not exercised'); },
    },
    bridgeAsset: { source: '', sha256: '' },
  });
  const adapter = new PiEngineAdapter(runtime, { brokerUrl: 'http://127.0.0.1:1' });
  const sessionId = Buffer.from(sessionFile, 'utf8').toString('base64url');
  const waitUntil = async (pred: () => boolean, ms = 5000): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end && !pred()) await sleep(20);
    return pred();
  };
  const drive = await adapter.attach(sessionId, 'resume');
  try {
    const live: AgentMessage[] = [];
    drive.subscribe((m) => live.push(m));
    const attachHistory = await drive.getHistory();
    const idleCount = () => live.filter((m) => m.type === 'status' && m.status === 'idle').length;
    const echoKey = (clientKey: string) => (live.find((m) => m.type === 'user-message'
      && (m as { clientKey?: string }).clientKey === clientKey) as { key?: string } | undefined)?.key;
    const delivered = (clientKey: string) => live.filter((m) => m.type === 'user-message'
      && (m as { clientKey?: string }).clientKey === clientKey && (m as { queued?: boolean }).queued === false).length;
    await drive.sendPrompt({ text: 'first prompt', clientMessageId: 'keys-first' });
    await waitUntil(() => idleCount() >= 1);
    await drive.sendPrompt({ text: 'long task', clientMessageId: 'keys-long' });
    await waitUntil(() => live.some((m) => m.type === 'model-output' && (m as { delta?: string }).delta !== undefined));
    await drive.sendPrompt({ text: 'steered in', clientMessageId: 'keys-steer' });
    await waitUntil(() => idleCount() >= 2);
    let refused = false;
    try {
      await drive.sendPrompt({ text: 'refuse this prompt', clientMessageId: 'keys-refused' });
    } catch {
      refused = true;
    }
    await drive.sendPrompt({ text: 'blocks please', clientMessageId: 'keys-blocks' });
    await waitUntil(() => idleCount() >= 3);
    await drive.sendPrompt({ text: 'same clock please', clientMessageId: 'keys-same-clock' });
    await waitUntil(() => idleCount() >= 4);
    // Stamped like the answer already in the file before this connection started.
    const oldClockPrompt = `clock ${Date.parse('2026-09-26T09:00:02.000Z')}`;
    await drive.sendPrompt({ text: oldClockPrompt, clientMessageId: 'keys-old-clock' });
    await waitUntil(() => idleCount() >= 5);
    // Taken by an extension command: Pi answers the RPC and writes nothing, so the next prompt's
    // entry must not take this one's key.
    await drive.sendPrompt({ text: '/handled-by-extension', clientMessageId: 'keys-handled' });
    await drive.sendPrompt({ text: 'after the handled one', clientMessageId: 'keys-after-handled' });
    await waitUntil(() => idleCount() >= 6);
    // A steer sent after the loop's last queue check runs in a continuation after agent_end.
    const streamedText = () => live.map((m) => (m.type === 'model-output' ? (m as { delta?: string }).delta ?? '' : '')).join('');
    await drive.sendPrompt({ text: 'strand the next steer', clientMessageId: 'keys-strand' });
    await waitUntil(() => streamedText().includes('answered strand the next steer'));
    await drive.sendPrompt({ text: 'stranded steer', clientMessageId: 'keys-stranded' });
    await waitUntil(() => idleCount() >= 8);
    const idlesAfterStrand = idleCount();
    // Pi turns a prompt away and the same text is sent straight again: a new prompt with its own
    // echo, and nothing matched since the refusal to move the history read past the refused one.
    let refusedAgain = false;
    try {
      await drive.sendPrompt({ text: 'refuse then resend', clientMessageId: 'keys-refused-again' });
    } catch {
      refusedAgain = true;
    }
    await drive.sendPrompt({ text: 'refuse then resend', clientMessageId: 'keys-resent' });
    await waitUntil(() => idleCount() >= 9);
    // The entry of the prompt after another extension-handled one reaches the file before this
    // connection reads the events announcing it. A history read then must not give it the key of
    // the handled prompt still queued ahead of it.
    await drive.sendPrompt({ text: '/handled again', clientMessageId: 'keys-handled-again' });
    await drive.sendPrompt({ text: 'late start', clientMessageId: 'keys-late' });
    await waitUntil(() => readFileSync(sessionFile, 'utf8').includes('"text":"late start"'));
    const raced = await drive.getHistory();
    const announcedByRead = delivered('keys-late');
    await waitUntil(() => idleCount() >= 10);
    const racedRow = raced.find((m) => m.type === 'user-message' && m.text === 'late start') as { key?: string; clientKey?: string } | undefined;
    check(
      'a history read that finds a prompt entry before its events keeps that prompt echo key, not the queued handled one',
      announcedByRead === 0 && racedRow?.key === echoKey('keys-late') && racedRow?.clientKey === 'keys-late',
      JSON.stringify({ announcedByRead, key: racedRow?.key, late: echoKey('keys-late'), handled: echoKey('keys-handled-again') }),
    );
    const history = await drive.getHistory();
    const audit = auditLiveAgainstHistory({ attachHistory, live, history });
    check(
      'Pi RPC streams every transcript row under its session-file key (only the refused and extension-handled prompts stay live-only)',
      refused && refusedAgain
        && JSON.stringify([...audit.liveOnly].sort()) === JSON.stringify([
          `user-message:key:${echoKey('keys-refused')}`,
          `user-message:key:${echoKey('keys-refused-again')}`,
          `user-message:key:${echoKey('keys-handled')}`,
          `user-message:key:${echoKey('keys-handled-again')}`,
        ].sort()),
      JSON.stringify({ refused, refusedAgain, liveOnly: audit.liveOnly }),
    );
    const historyKey = (text: string) => (history.find((m) => m.type === 'user-message'
      && (m as { text?: string }).text === text) as { key?: string } | undefined)?.key;
    check(
      'a prompt resent after Pi refused it keeps its own echo key in history, not the refused one',
      historyKey('refuse then resend') === echoKey('keys-resent')
        && echoKey('keys-resent') !== echoKey('keys-refused-again')
        && history.filter((m) => m.type === 'user-message' && m.text === 'refuse then resend').length === 1,
      JSON.stringify([historyKey('refuse then resend'), echoKey('keys-refused-again'), echoKey('keys-resent')]),
    );
    check(
      'the prompt after an extension-handled one keeps its own echo key, live and in history',
      historyKey('after the handled one') === echoKey('keys-after-handled')
        && delivered('keys-after-handled') === 1 && delivered('keys-handled') === 0,
      JSON.stringify([historyKey('after the handled one'), echoKey('keys-handled'), echoKey('keys-after-handled')]),
    );
    check(
      'a steer Pi runs in a continuation after agent_end keeps its echo key in history',
      idlesAfterStrand === 8
        && history.some((m) => m.type === 'model-output' && m.text === 'answered the late steer')
        && historyKey('stranded steer') === echoKey('keys-stranded'),
      JSON.stringify({ idles: idlesAfterStrand, key: historyKey('stranded steer'), echo: echoKey('keys-stranded') }),
    );
    check(
      'Pi RPC text and thinking keys come from the message timestamp and non-empty block ordinal',
      ['looking at first prompt', 'before the call', 'after the call', 'after an empty block'].every((text) =>
        history.some((m) => m.type === 'model-output' && m.text === text && /^a\d+:t:\d$/.test(m.key ?? '')))
        && history.some((m) => m.type === 'model-output' && m.text === 'after the call' && m.key?.endsWith(':t:1'))
        && history.some((m) => m.type === 'model-output' && m.text === 'after an empty block' && m.key?.endsWith(':t:0'))
        && history.some((m) => m.type === 'thinking' && m.text === 'only this one counts' && m.key?.endsWith(':r:0')),
      JSON.stringify(history.filter((m) => m.type === 'model-output' || m.type === 'thinking').map((m) => [(m as { key?: string }).key, (m as { text?: string }).text])),
    );
    const keyOf = (text: string) => (history.find((m) => m.type === 'model-output' && m.text === text) as { key?: string } | undefined)?.key;
    check(
      'two Pi RPC messages sharing one timestamp keep separate rows, the later under an occurrence suffix',
      /^a\d+:t:0$/.test(keyOf('first under one clock') ?? '')
        && keyOf('second under the same clock') === keyOf('first under one clock')!.replace(/:t:0$/, '~1:t:0'),
      JSON.stringify([keyOf('first under one clock'), keyOf('second under the same clock')]),
    );
    check(
      'a Pi RPC answer repeating a timestamp from before the connection started takes the next suffix',
      /^a\d+:t:0$/.test(keyOf('answered before attach') ?? '')
        && keyOf('answered on an old clock') === keyOf('answered before attach')!.replace(/:t:0$/, '~1:t:0'),
      JSON.stringify([keyOf('answered before attach'), keyOf('answered on an old clock')]),
    );
    const rowKeys = new Set(history.filter((m) => m.type === 'model-output' || m.type === 'thinking').map((m) => (m as { key?: string }).key));
    const summaryTargets = history.filter((m) => m.type === 'run-summary').map((m) => (m as { assistantMessageKey?: string }).assistantMessageKey);
    check(
      'every Pi run summary names an answer row its history has, after an empty first text block too',
      summaryTargets.length >= 6 && summaryTargets.every((key) => key !== undefined && rowKeys.has(key)),
      JSON.stringify(summaryTargets),
    );
    const at = (type: string, text: string) => history.findIndex((m) => m.type === type && (m as { text?: string }).text === text);
    check(
      'a Pi RPC prompt keeps its echo key and app correlation in history, steered prompt included',
      ['first prompt', 'long task', 'steered in', 'blocks please', 'same clock please', oldClockPrompt,
        'after the handled one', 'strand the next steer', 'stranded steer', 'refuse then resend', 'late start'].every((text) => {
        const row = history.find((m) => m.type === 'user-message' && m.text === text) as { key?: string; clientKey?: string } | undefined;
        return !!row?.key?.startsWith('u:sent:') && typeof row.clientKey === 'string' && row.clientKey.startsWith('keys-');
      })
        // The steer really was injected mid-turn: its entry sits between the long task's steps.
        && at('model-output', 'starting the long task') < at('user-message', 'steered in')
        && at('user-message', 'steered in') < at('model-output', 'long task finished'),
      JSON.stringify(history.filter((m) => m.type === 'user-message')),
    );
    check(
      'a history refresh from the attach cursor and a reconnect frame show no Pi RPC row twice or under another text',
      audit.refreshRows !== undefined && audit.refreshRows > 0
        && audit.duplicatesAfterRefresh.length === 0
        && audit.duplicatesAfterReconnect.length === 0
        && audit.textMismatches.length === 0,
      JSON.stringify(audit),
    );
    const managed = new ManagedConn(drive);
    const request = historyRefreshRequest({ cursor: 'cursor' }, managed);
    check(
      'the broker serves a history refresh on a Pi RPC connection',
      drive.liveRowsRekeyedInHistory === undefined
        && managed.historyRefreshRefusal() === undefined
        && 'since' in request,
      JSON.stringify(request),
    );
  } finally {
    await drive.close();
  }

  // A later Drive connection on the same session keeps keying the earlier connection's prompts as
  // their echoes: the correlations live with the adapter, not with one connection.
  const again = await adapter.attach(sessionId, 'resume');
  let echoedIdentity: unknown;
  try {
    const history = await again.getHistory();
    echoedIdentity = await again.getHistorySourceIdentity?.();
    const prompts = history.filter((m) => m.type === 'user-message') as Array<{ key?: string; text?: string }>;
    check(
      'a replacement Pi Drive connection keys the earlier prompts by their echo keys',
      prompts.filter((m) => m.key?.startsWith('u:sent:')).length === 11
        && prompts.some((m) => m.text === 'before attach' && m.key === 'a1b2c3d4'),
      JSON.stringify(prompts),
    );
  } finally {
    await again.close();
  }

  // An adapter without those correlations keys the same bytes by entry id, so its history must name
  // a different source, or a cursor or cached page from the other keying would be taken as current.
  const fresh = await new PiEngineAdapter(runtime, { brokerUrl: 'http://127.0.0.1:1' }).attach(sessionId, 'resume');
  try {
    const prompts = (await fresh.getHistory()).filter((m) => m.type === 'user-message') as Array<{ key?: string }>;
    const freshIdentity = await fresh.getHistorySourceIdentity?.();
    check(
      'the same Pi session file read without the echo correlations names a different history source',
      prompts.length === 12 && !prompts.some((m) => m.key?.startsWith('u:sent:'))
        && echoedIdentity !== undefined && freshIdentity !== undefined
        && JSON.stringify(freshIdentity) !== JSON.stringify(echoedIdentity),
      JSON.stringify({ echoedIdentity, freshIdentity }),
    );
  } finally {
    await fresh.close();
  }
}

rmSync(brokerFixtureRoot, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
