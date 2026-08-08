/**
 * OpenCode private-runtime Observe + Drive scenario trace.
 *
 * No `opencode serve` is started. This runs an isolated cosyncing broker against synthetic
 * OpenCode storage plus a fake `opencode run` binary, then proves:
 * - private sessions are discovered as read-only Observe;
 * - Observe cannot send prompts;
 * - `?mode=resume` opens a separate drivable owner;
 * - Drive streams through `opencode run --session ... --format json` and persists to storage;
 * - the broker records enough wire/native evidence to debug a failure.
 *
 *   bun run scripts/broker/tests_traces/opencode-private-observe-drive-trace.ts
 */
export {};
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.COSYNCING_TEST_PORT ?? 21000 + Math.floor(Math.random() * 20000));
const BROKER = `http://127.0.0.1:${PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(process.cwd(), 'output', 'traces', runId, 'opencode', 'ST-27-private-observe-drive');
const framesPath = join(outDir, 'frames.ndjson');
const nativePath = join(outDir, 'opencode-private.ndjson');
const storagePath = join(outDir, 'storage-snapshot.json');
const tracePath = join(outDir, 'trace.json');
const scenarioIds = ['ST-27'];
const steps = [
  'seed local OpenCode storage with one reverted private session and one unfinished working session',
  'start isolated cosyncing broker without opencode serve',
  'verify OpenCode is not advertised as app-creatable in private mode',
  'attach an Observe WebSocket and replay disk history',
  'verify Observe rejects prompts',
  'attach the same session with ?mode=resume',
  'send a Drive prompt and observe fake opencode run output, todo state, and subagent activity',
  'send a long private Drive prompt and stop it through the broker command channel',
  'verify Drive persists the continuation to OpenCode storage and broker roster overlays app ownership',
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Assertion {
  name: string;
  ok: boolean;
  detail?: string;
}

const assertions: Assertion[] = [];
mkdirSync(outDir, { recursive: true });

const root = join('/tmp', `cosyncing-opencode-private-trace-${Math.random().toString(36).slice(2, 8)}`);
const data = join(root, 'data');
const cwd = join(root, 'work');
const binDir = join(root, 'bin');
const project = 'proj_trace';
const sessionId = 'ses_trace_private';
const workingId = 'ses_trace_working';

function record(path: string, obj: unknown): void {
  appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...(obj as Record<string, unknown>) }) + '\n');
}

function check(name: string, ok: boolean, detail = ''): void {
  assertions.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function seedSession(id: string, title: string, unfinished = false, reverted = false): void {
  const suffix = id.replace(/^ses_trace_/, '');
  const userMsg = `msg_u_${suffix}`;
  const assistantMsg = `msg_a_${suffix}`;
  const hiddenMsg = `msg_hidden_${suffix}`;
  writeJson(join(data, 'storage', 'session', project, `${id}.json`), {
    id,
    slug: title.toLowerCase().replace(/\s+/g, '-'),
    directory: cwd,
    title,
    time: { created: 1, updated: reverted ? 4 : unfinished ? 3 : 2 },
    revert: reverted ? { messageID: hiddenMsg } : undefined,
  });
  writeJson(join(data, 'storage', 'message', id, `${userMsg}.json`), {
    id: userMsg,
    sessionID: id,
    role: 'user',
    time: { created: 1 },
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
    time: unfinished ? { created: 2 } : { created: 2, completed: 3 },
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
      time: { created: 4 },
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

function seedOpenCodeUiSurfaces(id: string): void {
  const suffix = id.replace(/^ses_trace_/, '');
  const assistantMsg = `msg_a_${suffix}`;
  const todos = [
    { content: 'Verify native trace shape', priority: 'high', status: 'completed' },
    { content: 'Map OpenCode todowrite', priority: 'medium', status: 'in_progress' },
    { content: 'Trace canonical task list', priority: 'low', status: 'pending' },
  ];
  writeJson(join(data, 'storage', 'part', assistantMsg, 'prt_todo_trace.json'), {
    id: 'prt_todo_trace',
    sessionID: id,
    messageID: assistantMsg,
    type: 'tool',
    tool: 'todowrite',
    callID: 'call_todo_trace',
    state: { status: 'completed', input: { todos }, output: JSON.stringify(todos) },
  });
  writeJson(join(data, 'storage', 'part', assistantMsg, 'prt_task_trace.json'), {
    id: 'prt_task_trace',
    sessionID: id,
    messageID: assistantMsg,
    type: 'tool',
    tool: 'task',
    callID: 'call_task_trace',
    state: {
      status: 'completed',
      input: { subagent_type: 'general', description: 'Research adapter trace surface' },
      output: '<task id="ses_trace_child" state="completed"><task_result>Done</task_result></task>',
    },
  });
}

function installFakeOpenCode(): void {
  mkdirSync(binDir, { recursive: true });
  const fake = join(binDir, 'opencode');
  writeFileSync(fake, `#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const session = args[args.indexOf('--session') + 1];
const prompt = args.at(-1) ?? '';
const data = process.env.OPENCODE_DATA;
const native = process.env.COSYNCING_TRACE_NATIVE;
function log(obj) {
  if (native) appendFileSync(native, JSON.stringify({ ts: new Date().toISOString(), fakeOpencode: obj }) + '\\n');
}
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
log({ args, session, prompt });
if (prompt.includes('STOP_TRACE_PROMPT')) {
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
console.log(JSON.stringify({ type: 'tool_use', timestamp: now + 4, sessionID: session, part: { id: taskPart, sessionID: session, messageID: assistant, type: 'tool', tool: 'task', callID: 'call_task_' + now, state: { status: 'completed', input: { subagent_type: 'general', description: 'Inspect OpenCode child session' }, output: '<task id="ses_child_trace_drive" state="completed"><task_result>Done</task_result></task>' } } }));
console.log(JSON.stringify({ type: 'tool_use', timestamp: now + 5, sessionID: session, part: { id: toolPart, sessionID: session, messageID: assistant, type: 'tool', tool: 'bash', callID: 'call_drive_' + now, state: { status: 'completed', input: { command: 'echo DRIVE_TOOL_OK' }, metadata: { exit: 0, output: 'DRIVE_TOOL_OK' }, output: 'DRIVE_TOOL_OK' } } }));
console.log(JSON.stringify({ type: 'step_finish', timestamp: now + 6, sessionID: session, part: { id: 'prt_step_finish_' + now, sessionID: session, messageID: assistant, type: 'step-finish', tokens: { input: 10, output: 5, cache: { read: 2, write: 0 } }, cost: 0 } }));
	`);
  chmodSync(fake, 0o755);
}

mkdirSync(cwd, { recursive: true });
seedSession(sessionId, 'Private observe drive trace', false, true);
seedOpenCodeUiSurfaces(sessionId);
seedSession(workingId, 'Private working trace', true);
installFakeOpenCode();
record(nativePath, { seeded: { root, data, cwd, sessionId, workingId } });

const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    OPENCODE_URL: 'http://127.0.0.1:1',
    OPENCODE_DATA: data,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    COSYNCING_TRACE_NATIVE: nativePath,
  },
  stdout: 'pipe',
  stderr: 'pipe',
});

try {
  if (!(await waitHealth())) throw new Error(`broker did not start on ${BROKER}`);

  const agents = await getJson('/api/agents');
  const opencode = (agents as any[]).find((a) => a.id === 'opencode');
  check('private OpenCode does not advertise + New create', opencode?.canCreateSession === false, JSON.stringify(opencode));

  const roster = await getJson('/api/sessions');
  const sessions = Array.isArray((roster as any).sessions) ? (roster as any).sessions : [];
  const visible = sessions.find((s: any) => s.id === sessionId);
  const working = sessions.find((s: any) => s.id === workingId);
  check('private session appears as observe row', visible?.attachMode === 'observe' && visible?.control?.drive?.state === 'observing', JSON.stringify(visible?.control));
  check('private terminal sync is not falsely available', visible?.control?.terminalSync?.supported === false, JSON.stringify(visible?.control?.terminalSync));
  check('private working status is inferred from disk', working?.status === 'working', `status=${working?.status}`);

  const observeFrames: any[] = [];
  const observeWs = openWs(`${WSBASE}/api/sessions/opencode/${encodeURIComponent(sessionId)}/stream`, observeFrames);
  await observeWs.opened;
  const observeSession = await waitFrame(observeFrames, (f) => f.kind === 'session', 5000);
  check('observe WebSocket session frame is read-only', observeSession?.info?.attachMode === 'observe' && observeSession.info.control?.drive?.state === 'observing', JSON.stringify(observeSession?.info?.control));
  const observeHistory = await waitFrame(observeFrames, (f) => f.kind === 'history', 5000);
  const observeMessages = observeHistory?.messages ?? [];
  const historyText = JSON.stringify(observeMessages);
  check('observe history replays visible disk messages', historyText.includes(`HELLO_${sessionId}`) && historyText.includes(`ASSIST_${sessionId}`));
  check('observe history filters reverted hidden rows', !historyText.includes(`HIDDEN_${sessionId}`));
  check('observe history maps OpenCode todowrite to task-list-state', observeMessages.some((m: any) => m.type === 'task-list-state' && (m.items ?? []).some((item: any) => item.title === 'Map OpenCode todowrite' && item.status === 'in-progress')));
  check('observe history suppresses stale task agent-activity', !observeMessages.some((m: any) => m.type === 'agent-activity'));
  observeWs.ws.send(JSON.stringify({ kind: 'prompt', text: 'OBSERVE_SHOULD_NOT_SEND' }));
  const observeError = await waitFrame(observeFrames, (f) => f.kind === 'error' && /read-only/i.test(f.message ?? ''), 3000);
  check('observe prompt is rejected by broker/session owner', !!observeError, observeError?.message ?? '');
  observeWs.ws.close();

  const driveFrames: any[] = [];
  const driveWs = openWs(`${WSBASE}/api/sessions/opencode/${encodeURIComponent(sessionId)}/stream?mode=resume`, driveFrames);
  await driveWs.opened;
  const driveSession = await waitFrame(driveFrames, (f) => f.kind === 'session', 5000);
  check('resume WebSocket session frame is drivable', driveSession?.info?.attachMode === 'resume' && driveSession.info.control?.drive?.state === 'driving', JSON.stringify(driveSession?.info?.control));
  const driveCommands = await waitFrame(driveFrames, (f) => f.kind === 'commands', 5000);
  check('private Drive advertises stop command through broker', (driveCommands?.commands ?? []).some((c: any) => c.name === 'stop' && c.kind === 'action'), JSON.stringify(driveCommands?.commands ?? []));
  driveWs.ws.send(JSON.stringify({ kind: 'prompt', text: 'DRIVE_TRACE_PROMPT' }));
  const driveUser = await waitFrame(driveFrames, (f) => f.kind === 'message' && f.message?.type === 'user-message' && /DRIVE_TRACE_PROMPT/.test(f.message.text ?? ''), 5000);
  check('drive prompt emits user-message', !!driveUser, driveUser?.message?.key ?? '');
  const driveOutput = await waitFrame(driveFrames, (f) => f.kind === 'message' && f.message?.type === 'model-output' && /DRIVE_OK DRIVE_TRACE_PROMPT/.test(f.message.text ?? ''), 5000);
  check('drive streams opencode run output', !!driveOutput, driveOutput?.message?.key ?? '');
  const driveTaskList = await waitFrame(driveFrames, (f) => f.kind === 'message' && f.message?.type === 'task-list-state' && (f.message?.items ?? []).some((item: any) => item.title === 'Show task list panel' && item.status === 'in-progress'), 5000);
  check('drive maps OpenCode todowrite to task-list-state', !!driveTaskList, JSON.stringify(driveTaskList?.message ?? null));
  const driveActivityRunning = await waitFrame(driveFrames, (f) => f.kind === 'message' && f.message?.type === 'agent-activity' && f.message?.status === 'running' && /Inspect OpenCode child session/.test(f.message?.title ?? ''), 5000);
  const driveActivityDone = await waitFrame(driveFrames, (f) => f.kind === 'message' && f.message?.type === 'agent-activity' && f.message?.status === 'done' && /Inspect OpenCode child session/.test(f.message?.title ?? ''), 5000);
  check('drive maps OpenCode task progress to agent-activity', !!driveActivityRunning && !!driveActivityDone, JSON.stringify({ running: driveActivityRunning?.message, done: driveActivityDone?.message }));
  const driveTool = await waitFrame(driveFrames, (f) => f.kind === 'message' && f.message?.type === 'tool-result' && f.message?.toolName === 'bash' && /DRIVE_TOOL_OK/.test(String(f.message?.result ?? '')), 5000);
  check('drive maps raw opencode run tool results', !!driveTool, driveTool?.message?.callId ?? '');
  const driveTokens = await waitFrame(driveFrames, (f) => f.kind === 'message' && f.message?.type === 'token-count' && f.message?.input === 10 && f.message?.output === 5, 5000);
  check('drive maps raw opencode run token usage', !!driveTokens, JSON.stringify(driveTokens?.message ?? null));
  const driveHistory = await waitFrame(driveFrames, (f) => f.kind === 'history' && JSON.stringify(f.messages ?? []).includes('DRIVE_OK DRIVE_TRACE_PROMPT'), 5000);
  check('drive continuation persists to storage and resyncs history', !!driveHistory);
  check('drive does not surface raw todowrite tool-result cards', !driveFrames.some((f) => f.kind === 'message' && f.message?.type === 'tool-result' && f.message?.toolName === 'todowrite'));

  const stopStart = driveFrames.length;
  driveWs.ws.send(JSON.stringify({ kind: 'prompt', text: 'STOP_TRACE_PROMPT' }));
  const stopUser = await waitFrameAfter(driveFrames, stopStart, (f) => f.kind === 'message' && f.message?.type === 'user-message' && /STOP_TRACE_PROMPT/.test(f.message?.text ?? ''), 5000);
  const stopRunning = await waitFrameAfter(driveFrames, stopStart, (f) => f.kind === 'message' && f.message?.type === 'status' && f.message?.status === 'running', 5000);
  check('private Drive stop scenario reaches running status', !!stopUser && !!stopRunning, stopUser?.message?.key ?? '');
  const commandStart = driveFrames.length;
  driveWs.ws.send(JSON.stringify({ kind: 'command', name: 'stop' }));
  const stopNotice = await waitFrameAfter(driveFrames, commandStart, (f) => f.kind === 'notice' && /Stopped/.test(f.message ?? ''), 5000);
  check('private Drive stop command returns notice', !!stopNotice, stopNotice?.message ?? '');
  const stopIdle = await waitFrameAfter(driveFrames, commandStart, (f) => f.kind === 'message' && f.message?.type === 'status' && f.message?.status === 'idle', 5000);
  check('private Drive stop returns session to idle', !!stopIdle);

  const ownedRoster = await getJson('/api/sessions');
  const owned = ((ownedRoster as any).sessions ?? []).find((s: any) => s.id === sessionId);
  check('broker roster overlays app-owned Drive connection', owned?.attachMode === 'resume' && owned?.control?.drive?.state === 'driving', JSON.stringify(owned?.control));
  driveWs.ws.close();
} catch (err) {
  check('trace driver completed without exception', false, String(err));
} finally {
  await writeStorageSnapshot();
  broker.kill();
  rmSync(root, { recursive: true, force: true });
  const failed = assertions.filter((a) => !a.ok).length;
  writeFileSync(tracePath, JSON.stringify({
    scenarioIds,
    agent: 'opencode',
    version: { cosyncing: 'local-source', opencode: 'fake-run-binary' },
    broker: BROKER,
    steps,
    output: { frames: framesPath, native: nativePath, storage: storagePath },
    assertions,
    status: failed ? 'fail' : 'pass',
    skipReason: null,
  }, null, 2));
  console.log(`\ntrace: ${tracePath}`);
  console.log(`${assertions.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

function openWs(url: string, frames: any[]): { ws: WebSocket; opened: Promise<void> } {
  const ws = new WebSocket(url);
  ws.onmessage = (e) => {
    try {
      const frame = JSON.parse(String(e.data));
      frames.push(frame);
      record(framesPath, { url, ...frame });
    } catch {
      /* skip malformed */
    }
  };
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`websocket error: ${url}`));
  });
  return { ws, opened };
}

async function waitHealth(): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BROKER}/api/health`)).ok) return true;
    } catch {
      /* broker not ready */
    }
    await sleep(250);
  }
  return false;
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${BROKER}${path}`);
  const body = await res.json().catch(() => ({}));
  record(nativePath, { direction: 'trace->broker', path, status: res.status, body });
  return body;
}

async function waitFrame(frames: any[], pred: (f: any) => boolean, ms: number): Promise<any | undefined> {
  return waitFrameAfter(frames, 0, pred, ms);
}

async function waitFrameAfter(frames: any[], startIndex: number, pred: (f: any) => boolean, ms: number): Promise<any | undefined> {
  const start = Date.now();
  let seen = startIndex;
  for (;;) {
    for (let i = seen; i < frames.length; i++) {
      if (pred(frames[i])) return frames[i];
    }
    seen = frames.length;
    if (Date.now() - start > ms) return undefined;
    await sleep(25);
  }
}

async function writeStorageSnapshot(): Promise<void> {
  const snapshot = {
    sessions: readJsonTree(join(data, 'storage', 'session'), 2),
    messages: readJsonTree(join(data, 'storage', 'message'), 2),
    parts: readJsonTree(join(data, 'storage', 'part'), 2),
  };
  writeFileSync(storagePath, JSON.stringify(snapshot, null, 2));
}

function readJsonTree(dir: string, maxDepth: number): any[] {
  if (maxDepth < 0) return [];
  try {
    if (!existsSync(dir)) return [];
    const out: any[] = [];
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) out.push(...readJsonTree(full, maxDepth - 1));
      else if (ent.isFile() && ent.name.endsWith('.json')) {
        try {
          out.push(JSON.parse(readFileSync(full, 'utf8')));
        } catch {
          /* skip */
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}
