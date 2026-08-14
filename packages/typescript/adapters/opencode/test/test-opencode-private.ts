/**
 * OpenCode private-runtime Observe + Drive regression.
 *
 * No `opencode serve` is started. The adapter discovers local OpenCode storage, opens sessions
 * read-only in Observe mode, and drives only after explicit `?mode=resume` by spawning `opencode run`.
 *
 *   bun run packages/typescript/adapters/opencode/test/test-opencode-private.ts
 */
export {};
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenCodeAdapter } from '../src/index.ts';
import type { AgentMessage } from '../../../adapter-api/src/index.ts';

const root = join('/tmp', `cosyncing-opencode-private-${Math.random().toString(36).slice(2, 8)}`);
const data = join(root, 'data');
const cwd = join(root, 'work');
const binDir = join(root, 'bin');
const project = 'proj_private';
const sessionId = 'ses_private';
const workingId = 'ses_working';
const staleWorkingId = 'ses_stale_working';
const latePartId = 'ses_latepart';
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`);
  else {
    failed++;
    console.error(`FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function seedSession(id: string, title: string, unfinished = false, reverted = false, timeBase = 1): void {
  const suffix = id.replace(/^ses_/, '');
  const userMsg = `msg_u_${suffix}`;
  const assistantMsg = `msg_a_${suffix}`;
  const hiddenMsg = `msg_hidden_${suffix}`;
  writeJson(join(data, 'storage', 'session', project, `${id}.json`), {
    id,
    slug: title.toLowerCase().replace(/\s+/g, '-'),
    directory: cwd,
    title,
    time: { created: timeBase, updated: reverted ? timeBase + 4 : unfinished ? timeBase + 3 : timeBase + 2 },
    revert: reverted ? { messageID: hiddenMsg } : undefined,
  });
  writeJson(join(data, 'storage', 'message', id, `${userMsg}.json`), {
    id: userMsg,
    sessionID: id,
    role: 'user',
    time: { created: timeBase },
  });
  writeJson(join(data, 'storage', 'part', userMsg, `prt_${userMsg}.json`), {
    id: `prt_${userMsg}`,
    sessionID: id,
    messageID: userMsg,
    type: 'text',
    text: `HELLO_${id}`,
  });
  writeJson(join(data, 'storage', 'message', id, `${assistantMsg}.json`), {
    id: assistantMsg,
    sessionID: id,
    role: 'assistant',
    time: unfinished ? { created: timeBase + 1 } : { created: timeBase + 1, completed: timeBase + 2 },
    finish: unfinished ? undefined : 'stop',
  });
  writeJson(join(data, 'storage', 'part', assistantMsg, `prt_${assistantMsg}.json`), {
    id: `prt_${assistantMsg}`,
    sessionID: id,
    messageID: assistantMsg,
    type: 'text',
    text: `ASSIST_${id}`,
  });
  if (reverted) {
    writeJson(join(data, 'storage', 'message', id, `${hiddenMsg}.json`), {
      id: hiddenMsg,
      sessionID: id,
      role: 'assistant',
      time: { created: timeBase + 4 },
    });
    writeJson(join(data, 'storage', 'part', hiddenMsg, `prt_${hiddenMsg}.json`), {
      id: `prt_${hiddenMsg}`,
      sessionID: id,
      messageID: hiddenMsg,
      type: 'text',
      text: `HIDDEN_${id}`,
    });
  }
}

function seedLatePartSession(id: string): void {
  writeJson(join(data, 'storage', 'session', project, `${id}.json`), {
    id,
    slug: 'late-part',
    directory: cwd,
    title: 'Private late part',
    time: { created: 1, updated: 2 },
  });
  writeJson(join(data, 'storage', 'message', id, 'msg_latepart.json'), {
    id: 'msg_latepart',
    sessionID: id,
    role: 'assistant',
    time: { created: 1, completed: 2 },
    finish: 'stop',
  });
}

function seedOpenCodeUiSurfaces(id: string): void {
  const suffix = id.replace(/^ses_/, '');
  const assistantMsg = `msg_a_${suffix}`;
  const todos = [
    { content: 'Verify native event shape', priority: 'high', status: 'completed' },
    { content: 'Map OpenCode todowrite', priority: 'medium', status: 'in_progress' },
    { content: 'Add regression test', priority: 'low', status: 'pending' },
  ];
  writeJson(join(data, 'storage', 'part', assistantMsg, 'prt_todo_private.json'), {
    id: 'prt_todo_private',
    sessionID: id,
    messageID: assistantMsg,
    type: 'tool',
    tool: 'todowrite',
    callID: 'call_todo_private',
    state: { status: 'completed', input: { todos }, output: JSON.stringify(todos) },
  });
  writeJson(join(data, 'storage', 'part', assistantMsg, 'prt_task_private.json'), {
    id: 'prt_task_private',
    sessionID: id,
    messageID: assistantMsg,
    type: 'tool',
    tool: 'task',
    callID: 'call_task_private',
    state: {
      status: 'completed',
      input: { subagent_type: 'general', description: 'Research adapter surface' },
      output: '<task id="ses_child_private" state="completed"><task_result>Done</task_result></task>',
    },
  });
}

async function waitUntil(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

mkdirSync(cwd, { recursive: true });
mkdirSync(binDir, { recursive: true });
seedSession(sessionId, 'Private idle', false, true);
seedOpenCodeUiSurfaces(sessionId);
seedSession(workingId, 'Private working', true, false, Date.now());
seedSession(staleWorkingId, 'Private stale working', true, false, Date.now() - 60 * 60 * 1000);
seedLatePartSession(latePartId);

const fakeOpencode = join(binDir, 'opencode');
writeFileSync(fakeOpencode, `#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const session = args[args.indexOf('--session') + 1];
const prompt = args.at(-1) ?? '';
const data = process.env.OPENCODE_DATA;
if (!data || !session) process.exit(2);
function clearRevert(dir) {
  if (!existsSync(dir)) return false;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (clearRevert(full)) return true;
    } else if (ent.isFile() && ent.name === session + '.json') {
      const obj = JSON.parse(readFileSync(full, 'utf8'));
      delete obj.revert;
      writeFileSync(full, JSON.stringify(obj));
      return true;
    }
  }
  return false;
}
const now = Date.now();
const user = 'msg_drive_user_' + now;
const assistant = 'msg_drive_assistant_' + now;
const livePart = 'prt_drive_text_' + now;
const todoPart = 'prt_drive_todo_' + now;
const taskPart = 'prt_drive_task_' + now;
const toolPart = 'prt_drive_tool_' + now;
const driveTodos = [
  { content: 'Map OpenCode todowrite', priority: 'high', status: 'completed' },
  { content: 'Show task list panel', priority: 'medium', status: 'in_progress' },
  { content: 'Keep raw todo card hidden', priority: 'low', status: 'pending' }
];
if (prompt.includes('STOP_ME')) {
  await new Promise((r) => setTimeout(r, 30000));
  process.exit(0);
}
clearRevert(join(data, 'storage', 'session'));
mkdirSync(join(data, 'storage', 'message', session), { recursive: true });
mkdirSync(join(data, 'storage', 'part', user), { recursive: true });
mkdirSync(join(data, 'storage', 'part', assistant), { recursive: true });
writeFileSync(join(data, 'storage', 'message', session, user + '.json'), JSON.stringify({ id: user, sessionID: session, role: 'user', time: { created: now } }));
writeFileSync(join(data, 'storage', 'part', user, 'prt_' + user + '.json'), JSON.stringify({ id: 'prt_' + user, sessionID: session, messageID: user, type: 'text', text: prompt }));
writeFileSync(join(data, 'storage', 'message', session, assistant + '.json'), JSON.stringify({ id: assistant, sessionID: session, role: 'assistant', time: { created: now + 1, completed: now + 2 }, finish: 'stop' }));
writeFileSync(join(data, 'storage', 'part', assistant, 'prt_' + assistant + '.json'), JSON.stringify({ id: 'prt_' + assistant, sessionID: session, messageID: assistant, type: 'text', text: 'DRIVE_OK ' + prompt }));
console.log(JSON.stringify({ type: 'step_start', timestamp: now, sessionID: session, part: { id: 'prt_step_start_' + now, sessionID: session, messageID: assistant, type: 'step-start' } }));
console.log(JSON.stringify({ type: 'text', timestamp: now + 1, sessionID: session, part: { id: livePart, sessionID: session, messageID: assistant, type: 'text', text: 'DRIVE_OK ' + prompt } }));
console.log(JSON.stringify({ type: 'tool_use', timestamp: now + 2, sessionID: session, part: { id: todoPart, sessionID: session, messageID: assistant, type: 'tool', tool: 'todowrite', callID: 'call_todo_' + now, state: { status: 'completed', input: { todos: driveTodos }, output: JSON.stringify(driveTodos) } } }));
console.log(JSON.stringify({ type: 'tool_use', timestamp: now + 3, sessionID: session, part: { id: taskPart, sessionID: session, messageID: assistant, type: 'tool', tool: 'task', callID: 'call_task_' + now, state: { status: 'running', input: { subagent_type: 'general', description: 'Inspect OpenCode child session' } } } }));
console.log(JSON.stringify({ type: 'tool_use', timestamp: now + 4, sessionID: session, part: { id: taskPart, sessionID: session, messageID: assistant, type: 'tool', tool: 'task', callID: 'call_task_' + now, state: { status: 'completed', input: { subagent_type: 'general', description: 'Inspect OpenCode child session' }, output: '<task id="ses_child_drive" state="completed"><task_result>Done</task_result></task>' } } }));
console.log(JSON.stringify({ type: 'tool_use', timestamp: now + 5, sessionID: session, part: { id: toolPart, sessionID: session, messageID: assistant, type: 'tool', tool: 'bash', callID: 'call_drive_' + now, time: { start: now + 4, end: now + 5 }, state: { status: 'completed', input: { command: 'echo DRIVE_TOOL_OK' }, metadata: { exit: 0, output: 'DRIVE_TOOL_OK' }, output: 'DRIVE_TOOL_OK' } } }));
console.log(JSON.stringify({ type: 'step_finish', timestamp: now + 6, sessionID: session, part: { id: 'prt_step_finish_' + now, sessionID: session, messageID: assistant, type: 'step-finish', tokens: { input: 10, output: 5, cache: { read: 2, write: 0 } }, cost: 0 } }));
`);
chmodSync(fakeOpencode, 0o755);

const oldPath = process.env.PATH ?? '';
const oldData = process.env.OPENCODE_DATA;
process.env.PATH = `${binDir}:${oldPath}`;
process.env.OPENCODE_DATA = data;

try {
  const adapter = new OpenCodeAdapter({ baseUrl: 'http://127.0.0.1:1', storageDir: data });
  check('adapter available from disk without opencode serve', await adapter.isAvailable());
  check('private mode does not advertise app new-session create', !(await adapter.canCreateSession()));
  const sessions = await adapter.discoverSessions();
  const idle = sessions.find((s) => s.id === sessionId);
  const working = sessions.find((s) => s.id === workingId);
  const staleWorking = sessions.find((s) => s.id === staleWorkingId);
  check('discovers private disk session', !!idle, `count=${sessions.length}`);
  check('private session is observe-first', idle?.attachMode === 'observe' && idle.control?.drive.state === 'observing', JSON.stringify(idle?.control));
  check('private session does not pretend true sync is available without serve', idle?.control?.terminalSync.supported === false, JSON.stringify(idle?.control?.terminalSync));
  check('private status ignores reverted unfinished rows', idle?.status === 'idle', `status=${idle?.status}`);
  check('unfinished assistant message marks private session working', working?.status === 'working', `status=${working?.status}`);
  check('stale unfinished private session is idle', staleWorking?.status === 'idle', `status=${staleWorking?.status}`);

  const observe = await adapter.attach(sessionId);
  const history = await observe.getHistory();
  check('observe history reads user and assistant from disk', JSON.stringify(history).includes(`HELLO_${sessionId}`) && JSON.stringify(history).includes(`ASSIST_${sessionId}`));
  check('observe history applies OpenCode revert pointer', !JSON.stringify(history).includes(`HIDDEN_${sessionId}`));
  check('observe maps OpenCode user sentAt', history.some((m) => m.type === 'user-message' && m.key === 'msg_u_private' && m.sentAt === 1000));
  check(
    'observe maps OpenCode run-summary and runtime totals',
    history.some((m) => m.type === 'run-summary' && m.turnId === 'msg_a_private' && m.userMessageKey === 'msg_u_private' && m.totalRuntimeMs === 1000) &&
      history.some((m) => m.type === 'metadata-update' && m.key === 'runtimeTotals' && (m.value as any).totalRuntimeMs === 1000 && (m.value as any).turnCount === 1),
    JSON.stringify(history.filter((m) => m.type === 'run-summary' || (m.type === 'metadata-update' && m.key === 'runtimeTotals'))),
  );
  const taskList = history.find((m) => m.type === 'task-list-state');
  check('observe maps historical OpenCode todowrite to task-list-state', taskList?.items.length === 3 && taskList.items.some((item) => item.title === 'Map OpenCode todowrite' && item.status === 'in-progress'), JSON.stringify(taskList ?? null));
  check('observe suppresses raw todowrite tool-result cards', !history.some((m) => m.type === 'tool-result' && m.toolName === 'todowrite'));
  check('observe does not fabricate historical OpenCode task activity bars', !history.some((m) => m.type === 'agent-activity'));
  let readOnly = false;
  try {
    await observe.sendPrompt({ text: 'NOPE' });
  } catch (err) {
    readOnly = /read-only/i.test(String(err));
  }
  check('observe mode rejects prompts', readOnly);
  await observe.close();

  const lateObserve = await adapter.attach(latePartId);
  let resetSeen = false;
  lateObserve.subscribe((m) => {
    if (m.type === 'history-reset') resetSeen = true;
  });
  await lateObserve.getHistory();
  writeJson(join(data, 'storage', 'part', 'msg_latepart', 'prt_msg_latepart.json'), {
    id: 'prt_msg_latepart',
    sessionID: latePartId,
    messageID: 'msg_latepart',
    type: 'text',
    text: 'LATE_PART_READY',
  });
  check('observe watches new OpenCode part dirs after attach', await waitUntil(() => resetSeen, 1000));
  check('late part is visible after observe resync', JSON.stringify(await lateObserve.getHistory()).includes('LATE_PART_READY'));
  await lateObserve.close();

  const drive = await adapter.attach(sessionId, 'resume');
  const live: AgentMessage[] = [];
  drive.subscribe((m) => live.push(m));
  await drive.sendPrompt({ text: 'DRIVE_PROMPT' });
  check('drive emits live output from opencode run json', live.some((m) => m.type === 'model-output' && /DRIVE_OK DRIVE_PROMPT/.test(m.text ?? '')));
  check('drive maps raw OpenCode todowrite records to task-list-state', live.some((m) => m.type === 'task-list-state' && m.items.some((item) => item.title === 'Show task list panel' && item.status === 'in-progress')));
  check('drive maps raw OpenCode task progress to live agent-activity', live.some((m) => m.type === 'agent-activity' && m.status === 'running' && /Inspect OpenCode child session/.test(m.title)) && live.some((m) => m.type === 'agent-activity' && m.status === 'done' && /Inspect OpenCode child session/.test(m.title)));
  check('drive suppresses raw todowrite tool-result cards', !live.some((m) => m.type === 'tool-result' && m.toolName === 'todowrite'));
  check('drive maps raw opencode run tool_use records + D9 metadata', live.some((m) => m.type === 'tool-result' && m.toolName === 'bash' && m.toolClass === 'execute' && m.durationMs === 1 && /DRIVE_TOOL_OK/.test(String(m.result ?? ''))));
  check('drive maps raw opencode run step_finish tokens', live.some((m) => m.type === 'token-count' && m.input === 10 && m.output === 5 && m.cacheRead === 2));
  check('drive emits OpenCode live run summaries', live.some((m) => m.type === 'run-summary' && m.status === 'running') && live.some((m) => m.type === 'run-summary' && m.status === 'done' && typeof m.totalRuntimeMs === 'number'));
  const drivenHistory = await drive.getHistory();
  check('drive continuation is persisted to OpenCode storage', JSON.stringify(drivenHistory).includes('DRIVE_OK DRIVE_PROMPT'));
  await drive.close();

  const stopDrive = await adapter.attach(sessionId, 'resume');
  const stopCommands = await stopDrive.listCommands?.();
  check('private Drive advertises stop command', stopCommands?.some((c) => c.name === 'stop' && c.kind === 'action') === true);
  const stopLive: AgentMessage[] = [];
  stopDrive.subscribe((m) => stopLive.push(m));
  const stopPrompt = stopDrive.sendPrompt({ text: 'STOP_ME' });
  check('private Drive stop test reaches running state', await waitUntil(() => stopLive.some((m) => m.type === 'status' && m.status === 'running'), 1000));
  const stopResult = await stopDrive.runCommand?.('stop');
  await stopPrompt;
  check(
    'private Drive stop kills running opencode run',
    /Stopped/.test(String(stopResult?.notice ?? '')) && stopLive.some((m) => m.type === 'status' && m.status === 'idle'),
    JSON.stringify(stopLive.filter((m) => m.type === 'status' || m.type === 'error')),
  );
  await stopDrive.close();
} finally {
  process.env.PATH = oldPath;
  if (oldData == null) delete process.env.OPENCODE_DATA;
  else process.env.OPENCODE_DATA = oldData;
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${failed ? 'FAIL' : 'PASS'}`);
process.exit(failed ? 1 : 0);
