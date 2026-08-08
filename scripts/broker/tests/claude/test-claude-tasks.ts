/**
 * Claude task tools (TaskCreate/TaskUpdate — the TodoWrite replacement in Claude ≥2.1.19x) →
 * canonical task-list-state panel (NO claude, NO model cost; pure mapper).
 *
 * Unlike TodoWrite (whole ledger per call), the task tools are INCREMENTAL: TaskCreate assigns the
 * task id in its RESULT text ("Task #1 created successfully: …") and TaskUpdate mutates one task by
 * id. The adapter accumulates them into one upserted panel; the raw tool rows are suppressed like
 * TodoWrite/Workflow (a failed call stays visible as an error row).
 *
 *   bun run scripts/broker/tests/claude/test-claude-tasks.ts   (exit 0 = all pass)
 */
export {};
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeResumeConnection, ClaudeTaskLedger, mapTranscript, type ClaudeStore } from '../../../../packages/typescript/adapters/claude/src/index.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

let n = 0;
const call = (name: string, input: unknown, id: string) => ({ type: 'assistant', uuid: 'a' + ++n, message: { id: 'm' + n, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, content: unknown, isError = false) => ({ type: 'user', uuid: 'u' + ++n, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] } });

const LINES = [
  call('TaskCreate', { subject: 'Profile roster loading', description: 'measure discovery' }, 'tc1'),
  result('tc1', 'Task #1 created successfully: Profile roster loading'),
  call('TaskCreate', { subject: 'Fix session open', activeForm: 'Fixing session open' }, 'tc2'),
  result('tc2', [{ type: 'text', text: 'Task #2 created successfully: Fix session open' }]),
  call('TaskCreate', { subject: 'Throwaway task' }, 'tc3'),
  result('tc3', 'Task #3 created successfully: Throwaway task'),
  call('TaskUpdate', { taskId: '1', status: 'in_progress' }, 'tu1'),
  result('tu1', 'Updated task #1 status'),
  call('TaskUpdate', { taskId: '1', status: 'completed' }, 'tu2'),
  result('tu2', 'Updated task #1 status'),
  call('TaskUpdate', { taskId: '2', subject: 'Fix session open (capped)' }, 'tu3'),
  result('tu3', 'Updated task #2'),
  call('TaskUpdate', { taskId: '3', status: 'deleted' }, 'tu4'),
  result('tu4', 'Task #3 deleted'),
  // a FAILED update: must stay visible as an error row and not corrupt the ledger
  call('TaskUpdate', { taskId: '99', status: 'completed' }, 'tu5'),
  result('tu5', 'Task #99 not found', true),
  // read-only queries are panel-covered noise → suppressed when successful
  call('TaskList', {}, 'tl1'),
  result('tl1', '#1 [completed] Profile roster loading\n#2 [pending] Fix session open (capped)'),
];

// ── history mapping ──
{
  const msgs = mapTranscript(LINES) as any[];
  const panels = msgs.filter((m) => m.type === 'task-list-state');
  const last = panels[panels.length - 1];
  check('task tools → task-list-state panel(s) emitted', panels.length > 0, `panels=${panels.length}`);
  check('panel key/sourceTool identify the task tools', last?.key === 'claude:tasks' && last?.sourceTool === 'TaskCreate', JSON.stringify(last && { key: last.key, sourceTool: last.sourceTool }));
  check('final panel: task 1 done', last?.items?.some((i: any) => i.title === 'Profile roster loading' && i.status === 'done'), JSON.stringify(last?.items));
  check('final panel: task 2 renamed and still open', last?.items?.some((i: any) => i.title === 'Fix session open (capped)' && i.status === 'open'));
  check('final panel: deleted task 3 removed', !last?.items?.some((i: any) => /Throwaway/.test(i.title)));
  check('final panel status = running (task 2 open)', last?.status === 'running', last?.status);
  check('raw TaskCreate/TaskUpdate/TaskList tool-calls are SUPPRESSED', !msgs.some((m) => m.type === 'tool-call' && /^Task(Create|Update|List|Get)$/.test(String(m.toolName))));
  check('successful task-tool results are SUPPRESSED', !msgs.some((m) => m.type === 'tool-result' && /^Task(Create|Update|List|Get)$/.test(String(m.toolName)) && !m.isError));
  check('FAILED TaskUpdate stays visible as an error result', msgs.some((m) => m.type === 'tool-result' && m.isError && /99 not found/.test(JSON.stringify(m.result ?? ''))));
}

// ── in_progress mapping + live-tail incremental feed ──
{
  const ledger = new ClaudeTaskLedger();
  const emitted: any[] = [];
  for (const ln of [
    call('TaskCreate', { subject: 'Live task' }, 'lc1'),
    result('lc1', 'Task #7 created successfully: Live task'),
    call('TaskUpdate', { taskId: '7', status: 'in_progress' }, 'lu1'),
    result('lu1', 'Updated task #7 status'),
  ]) emitted.push(...ledger.feed(ln));
  const last = emitted.filter((m) => m.type === 'task-list-state').pop();
  check('live tail: create+update emit incremental panels', !!last, JSON.stringify(last));
  check('live tail: in_progress → in-progress', last?.items?.[0]?.status === 'in-progress', JSON.stringify(last?.items));
  check('live tail: id parsed from the result text (#7)', last?.items?.[0]?.id === '7', JSON.stringify(last?.items?.[0]));
}

// ── malformed TaskCreate (no subject) falls through to a normal tool-call ──
{
  const msgs = mapTranscript([call('TaskCreate', { wrong: true }, 'bad1'), result('bad1', 'Task #9 created successfully: ?')]) as any[];
  check('malformed TaskCreate falls through to a tool-call (not silently dropped)', msgs.some((m) => m.type === 'tool-call' && m.toolName === 'TaskCreate'));
}

// ── resume replay + live stream-json feed use the same ledger surface ──
{
  const root = '/tmp/ca-claude-task-resume';
  mkdirSync(root, { recursive: true });
  const path = join(root, '11111111-2222-4333-8444-555555555555.jsonl');
  writeFileSync(path, LINES.map((ln) => JSON.stringify(ln)).join('\n') + '\n');
  const store: ClaudeStore = { configDir: root, projectsRoot: root, bin: 'claude', isDefault: true };
  const conn = new ClaudeResumeConnection(store, path, {
    id: Buffer.from(path).toString('base64url'),
    tool: 'claude',
    title: 'task resume',
    status: 'idle',
    attachMode: 'resume',
  });
  const msgs = (await conn.getHistory()) as any[];
  const last = msgs.filter((m) => m.type === 'task-list-state').pop();
  check('resume history replay emits task-list-state panel', last?.items?.some((i: any) => i.id === '2' && /capped/.test(i.title)), JSON.stringify(last?.items));
  await conn.close();
}

{
  const root = '/tmp/ca-claude-task-live';
  mkdirSync(root, { recursive: true });
  const path = join(root, '22222222-2222-4333-8444-555555555555.jsonl');
  writeFileSync(path, '');
  const store: ClaudeStore = { configDir: root, projectsRoot: root, bin: 'claude', isDefault: true };
  const conn = new ClaudeResumeConnection(store, path, {
    id: Buffer.from(path).toString('base64url'),
    tool: 'claude',
    title: 'task live',
    status: 'idle',
    attachMode: 'resume',
  });
  const emitted: any[] = [];
  const unsub = conn.subscribe((m) => emitted.push(m));
  (conn as any).handleEvent(call('TaskCreate', { subject: 'Live driven task' }, 'rtc1'));
  (conn as any).handleEvent(result('rtc1', 'Task #12 created successfully: Live driven task'));
  const last = emitted.filter((m) => m.type === 'task-list-state').pop();
  check('resume live stream emits task-list-state panel', last?.items?.[0]?.id === '12' && last.items[0].title === 'Live driven task', JSON.stringify(last?.items));
  check('resume live stream suppresses raw successful TaskCreate rows', !emitted.some((m) => (m.type === 'tool-call' || m.type === 'tool-result') && m.toolName === 'TaskCreate' && !m.isError));
  unsub();
  await conn.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
