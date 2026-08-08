/**
 * Pi true-sync scenario trace driver.
 *
 * Simulates the Pi bridge extension over /pi/bridge/* and a browser over the broker WebSocket.
 * Writes trace artifacts under output/traces/<run-id>/pi/ST-03-ST-04-ST-14/.
 *
 *   bun run scripts/broker/tests_traces/pi-bridge-true-sync-trace.ts
 */
export {};
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.COSYNCING_TEST_PORT ?? 18000 + Math.floor(Math.random() * 20000));
const BROKER = `http://127.0.0.1:${PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(process.cwd(), 'output', 'traces', runId, 'pi', 'ST-03-ST-04-ST-14');
const framesPath = join(outDir, 'frames.ndjson');
const nativePath = join(outDir, 'extension.ndjson');
const tracePath = join(outDir, 'trace.json');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const scenarioIds = ['ST-03', 'ST-04', 'ST-14'];
const steps = [
  'start isolated broker',
  'simulate Pi bridge hello for a live terminal session',
  'attach a browser WebSocket client',
  'send terminal-originated user text and observe app frame',
  'send app-originated prompt and observe extension command',
  'emit extension echo for app prompt',
  'emit bridge permission request',
  'attach a second browser while the permission is pending',
  'approve from app and observe extension permission command',
  'emit permission resolved event',
  'repeat the approval path for reject',
  'emit bridge question request',
  'answer from app and observe extension answer command',
  'emit question resolved event',
];

interface Assertion {
  name: string;
  ok: boolean;
  detail?: string;
}

const assertions: Assertion[] = [];

mkdirSync(outDir, { recursive: true });

function record(path: string, obj: unknown): void {
  appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...(obj as Record<string, unknown>) }) + '\n');
}

function check(name: string, ok: boolean, detail = ''): void {
  assertions.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', COSYNCING_BRIDGE_GRACE_MS: '700' },
  stdout: 'pipe',
  stderr: 'pipe',
});

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

const post = async (path: string, body: unknown): Promise<Response> => {
  record(nativePath, { direction: 'extension->broker', path, body });
  return fetch(`${BROKER}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
};

const getCommands = async (id: string): Promise<any[]> => {
  const r = await fetch(`${BROKER}/pi/bridge/commands?id=${encodeURIComponent(id)}`);
  const body = await r.json().catch(() => ({}));
  const commands = Array.isArray(body?.commands) ? body.commands : [];
  record(nativePath, { direction: 'broker->extension', path: '/pi/bridge/commands', commands });
  return commands;
};

try {
  if (!(await waitHealth())) throw new Error(`broker did not start on ${BROKER}`);

  const sessionFile = `/tmp/cosyncing-pi-trace-${Math.random().toString(36).slice(2, 8)}.jsonl`;
  const hello = await post('/pi/bridge/hello', { sessionFile, cwd: '/tmp', title: 'pi bridge trace' });
  const id = String((await hello.json()).id);
  check('bridge hello returns session id', !!id, id);

  const frames: any[] = [];
  const ws = new WebSocket(`${WSBASE}/api/sessions/pi/${encodeURIComponent(id)}/stream`);
  ws.onmessage = (e) => {
    try {
      const frame = JSON.parse(String(e.data));
      frames.push(frame);
      record(framesPath, frame);
    } catch {
      /* skip malformed */
    }
  };
  await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });
  await waitFrame(frames, (f) => f.kind === 'session', 3000);

  const info = frames.find((f) => f.kind === 'session')?.info;
  check('session frame proves terminal sync active', info?.control?.terminalSync?.active === true, JSON.stringify(info?.control));
  check('true-sync session does not present Drive takeover ownership', info?.control?.drive?.supported === false && info.control.drive.state === 'unavailable', JSON.stringify(info?.control?.drive));

  await post('/pi/bridge/events', { id, events: [{ t: 'user', text: 'TERMINAL_TRACE_PROMPT', key: 'term-u1' }] });
  const terminalUser = await waitFrame(frames, (f) => f.kind === 'message' && f.message?.type === 'user-message' && /TERMINAL_TRACE_PROMPT/.test(f.message.text ?? ''), 3000);
  check('terminal-to-app user message streams live', !!terminalUser, terminalUser?.message?.key);

  ws.send(JSON.stringify({ kind: 'prompt', text: 'APP_TRACE_PROMPT' }));
  const promptCommands = await waitCommands(id, (cmds) => cmds.some((c) => c.kind === 'prompt' && c.text === 'APP_TRACE_PROMPT'), 3000);
  const promptCmd = promptCommands.find((c) => c.kind === 'prompt');
  check('app-to-terminal prompt is queued for extension', promptCmd?.text === 'APP_TRACE_PROMPT', JSON.stringify(promptCmd));

  await post('/pi/bridge/events', { id, events: [{ t: 'user', text: 'APP_TRACE_PROMPT', key: 'app-u1' }] });
  const appEcho = await waitFrame(frames, (f) => f.kind === 'message' && f.message?.type === 'user-message' && f.message.key === 'app-u1', 3000);
  check('extension echo reconciles app prompt as user-message', !!appEcho, appEcho?.message?.text);

  await post('/pi/bridge/events', {
    id,
    events: [{ t: 'permission-request', requestId: 'perm-allow', toolName: 'bash', title: 'Run shell command?', detail: 'sudo true' }],
  });
  const perm = await waitFrame(frames, (f) => f.kind === 'message' && f.message?.type === 'permission-request' && f.message.requestId === 'perm-allow', 3000);
  check('bridge permission request reaches app', !!perm, perm?.message?.detail);

  const lateFrames: any[] = [];
  const late = new WebSocket(`${WSBASE}/api/sessions/pi/${encodeURIComponent(id)}/stream`);
  late.onmessage = (e) => {
    try {
      const frame = JSON.parse(String(e.data));
      lateFrames.push(frame);
      record(framesPath, { late: true, ...frame });
    } catch {
      /* skip malformed */
    }
  };
  await new Promise<void>((resolve) => { late.onopen = () => resolve(); });
  await waitFrame(lateFrames, (f) => f.kind === 'session', 3000);
  const latePerm = await waitFrame(lateFrames, (f) => f.kind === 'message' && f.message?.type === 'permission-request' && f.message.requestId === 'perm-allow', 3000);
  const latePermCount = lateFrames.filter((f) => f.kind === 'message' && f.message?.type === 'permission-request' && f.message.requestId === 'perm-allow').length;
  check('late true-sync tab replays pending permission exactly once', !!latePerm && latePermCount === 1, `count=${latePermCount}`);
  late.close();

  ws.send(JSON.stringify({ kind: 'approve', requestId: 'perm-allow', decision: 'approve' }));
  const approveCommands = await waitCommands(id, (cmds) => cmds.some((c) => c.kind === 'permission' && c.requestId === 'perm-allow'), 3000);
  const approveCmd = approveCommands.find((c) => c.kind === 'permission' && c.requestId === 'perm-allow');
  check('app approval reaches extension command queue', approveCmd?.decision === 'approve', JSON.stringify(approveCmd));
  await post('/pi/bridge/events', { id, events: [{ t: 'permission-resolved', requestId: 'perm-allow', decision: 'approve' }] });
  const allowResolved = await waitFrame(frames, (f) => f.kind === 'message' && f.message?.type === 'permission-resolved' && f.message.requestId === 'perm-allow', 3000);
  check('approval resolution reaches app', !!allowResolved, allowResolved?.message?.decision);

  await post('/pi/bridge/events', {
    id,
    events: [{ t: 'permission-request', requestId: 'perm-reject', toolName: 'bash', title: 'Run shell command?', detail: 'rm -rf /tmp/nope' }],
  });
  await waitFrame(frames, (f) => f.kind === 'message' && f.message?.type === 'permission-request' && f.message.requestId === 'perm-reject', 3000);
  ws.send(JSON.stringify({ kind: 'approve', requestId: 'perm-reject', decision: 'reject' }));
  const rejectCommands = await waitCommands(id, (cmds) => cmds.some((c) => c.kind === 'permission' && c.requestId === 'perm-reject'), 3000);
  const rejectCmd = rejectCommands.find((c) => c.kind === 'permission' && c.requestId === 'perm-reject');
  check('app rejection reaches extension command queue', rejectCmd?.decision === 'reject', JSON.stringify(rejectCmd));
  await post('/pi/bridge/events', { id, events: [{ t: 'permission-resolved', requestId: 'perm-reject', decision: 'reject' }] });
  const rejectResolved = await waitFrame(frames, (f) => f.kind === 'message' && f.message?.type === 'permission-resolved' && f.message.requestId === 'perm-reject', 3000);
  check('rejection resolution reaches app', !!rejectResolved, rejectResolved?.message?.decision);

  await post('/pi/bridge/events', {
    id,
    events: [{
      t: 'question-request',
      requestId: 'question-continue',
      questions: [{ header: 'Trace decision', question: 'Continue?', options: [{ label: 'Proceed', description: 'Continue the trace' }] }],
    }],
  });
  const question = await waitFrame(frames, (f) => f.kind === 'message' && f.message?.type === 'question-request' && f.message.requestId === 'question-continue', 3000);
  check('bridge question request reaches app', !!question && question.message.questions?.[0]?.options?.[0]?.label === 'Proceed', JSON.stringify(question?.message?.questions ?? []));
  ws.send(JSON.stringify({ kind: 'answer', requestId: 'question-continue', answers: [['Proceed']] }));
  const answerCommands = await waitCommands(id, (cmds) => cmds.some((c) => c.kind === 'answer' && c.requestId === 'question-continue'), 3000);
  const answerCmd = answerCommands.find((c) => c.kind === 'answer' && c.requestId === 'question-continue');
  check('app question answer reaches extension command queue', answerCmd?.answers?.[0]?.[0] === 'Proceed', JSON.stringify(answerCmd));
  await post('/pi/bridge/events', { id, events: [{ t: 'question-resolved', requestId: 'question-continue' }] });
  const questionResolved = await waitFrame(frames, (f) => f.kind === 'message' && f.message?.type === 'question-resolved' && f.message.requestId === 'question-continue', 3000);
  check('question resolution reaches app', !!questionResolved, questionResolved?.message?.requestId);

  ws.close();
} catch (err) {
  check('trace driver completed without exception', false, String(err));
} finally {
  broker.kill();
  const failed = assertions.filter((a) => !a.ok).length;
  writeFileSync(tracePath, JSON.stringify({
    scenarioIds,
    agent: 'pi',
    version: { cosyncing: 'local-source', pi: 'bridge-simulated' },
    broker: BROKER,
    steps,
    output: { frames: framesPath, extension: nativePath },
    assertions,
    status: failed ? 'fail' : 'pass',
    skipReason: null,
  }, null, 2));
  console.log(`\ntrace: ${tracePath}`);
  console.log(`${assertions.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

async function waitFrame(frames: any[], pred: (f: any) => boolean, ms: number): Promise<any> {
  const end = Date.now() + ms;
  for (;;) {
    const frame = frames.find(pred);
    if (frame) return frame;
    if (Date.now() > end) return undefined;
    await sleep(60);
  }
}

async function waitCommands(id: string, pred: (cmds: any[]) => boolean, ms: number): Promise<any[]> {
  const end = Date.now() + ms;
  for (;;) {
    const cmds = await getCommands(id);
    if (pred(cmds)) return cmds;
    if (Date.now() > end) return [];
    await sleep(80);
  }
}
