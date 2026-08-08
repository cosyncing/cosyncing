/**
 * Claude TodoWrite → canonical task-list-state panel (NO claude, NO model cost; pure mapper).
 * Closes the Observe-layer todos gap: a TodoWrite renders as ONE upserted ledger panel, not a stack of raw
 * tool cards, and the raw tool-call/result is suppressed (like the Workflow noise). Helps observe + synced + drive.
 *
 *   bun run scripts/broker/tests/claude/test-claude-todos.ts   (exit 0 = all pass)
 */
export {};
import { mapTranscript, todoListState } from '../../../../packages/typescript/adapters/claude/src/index.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const todoCall = (todos: unknown, id = 'toolu_t1') => ({ type: 'assistant', uuid: 'a' + id, message: { id: 'm' + id, role: 'assistant', content: [{ type: 'tool_use', id, name: 'TodoWrite', input: { todos } }] } });
const todoResult = (id = 'toolu_t1') => ({ type: 'user', uuid: 'u' + id, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Todos have been modified successfully' }] } });

// ── a normal multi-status TodoWrite ──
{
  const msgs = mapTranscript([
    todoCall([
      { content: 'Investigate queue health', status: 'completed', activeForm: 'Investigating queue health' },
      { content: 'Add the guard', status: 'in_progress', activeForm: 'Adding the guard' },
      { content: 'Write tests', status: 'pending', activeForm: 'Writing tests' },
    ]),
    todoResult(),
  ]) as any[];
  const panel = msgs.find((m) => m.type === 'task-list-state');
  check('TodoWrite → ONE task-list-state panel', !!panel && panel.key === 'claude:todos' && panel.sourceTool === 'TodoWrite' && panel.source === 'tool-call', JSON.stringify(panel && { key: panel.key, status: panel.status }));
  check('panel status = running (not all done)', panel?.status === 'running', panel?.status);
  check('3 items, statuses mapped pending→open / in_progress→in-progress / completed→done',
    panel?.items?.length === 3 && panel.items[0].status === 'done' && panel.items[1].status === 'in-progress' && panel.items[2].status === 'open',
    JSON.stringify(panel?.items?.map((i: any) => i.status)));
  check('item titles come from `content`', panel?.items?.[0]?.title === 'Investigate queue health' && panel.items[2].title === 'Write tests');
  check('raw TodoWrite tool-call is SUPPRESSED (no noise)', !msgs.some((m) => m.type === 'tool-call' && m.toolName === 'TodoWrite'));
  check('raw TodoWrite tool-result is SUPPRESSED', !msgs.some((m) => m.type === 'tool-result' && m.toolName === 'TodoWrite'));
}

// ── all completed → status done ──
{
  const msgs = mapTranscript([todoCall([{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }])]) as any[];
  check('all-completed TodoWrite → status done', msgs.find((m) => m.type === 'task-list-state')?.status === 'done');
}

// ── empty todos → cleared ──
{
  const msgs = mapTranscript([todoCall([])]) as any[];
  check('empty TodoWrite → status cleared (removes the panel)', msgs.find((m) => m.type === 'task-list-state')?.status === 'cleared');
}

// ── malformed (no todos array) → falls through to a normal tool-call, not dropped ──
{
  const msgs = mapTranscript([{ type: 'assistant', uuid: 'aX', message: { id: 'mX', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bad', name: 'TodoWrite', input: { wrong: true } }] } }]) as any[];
  check('malformed TodoWrite → falls through to a tool-call (not silently dropped)', msgs.some((m) => m.type === 'tool-call' && m.toolName === 'TodoWrite') && !msgs.some((m) => m.type === 'task-list-state'));
  check('todoListState(malformed) returns null', todoListState({ input: { wrong: true } }) === null);
}

// ── upsert: a later TodoWrite uses the SAME key so the app replaces (not stacks) ──
{
  const msgs = mapTranscript([
    todoCall([{ content: 'x', status: 'pending' }], 'toolu_a'),
    todoCall([{ content: 'x', status: 'completed' }], 'toolu_b'),
  ]) as any[];
  const panels = msgs.filter((m) => m.type === 'task-list-state');
  check('two TodoWrites share key claude:todos (app upserts → last wins)', panels.length === 2 && panels.every((p) => p.key === 'claude:todos') && panels[1].status === 'done');
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
