/**
 * OpenCode owner-disappearance/degrade trace (deterministic, no real opencode, no model).
 *
 * Starts a fake `opencode serve`, attaches through the real broker WebSocket, then closes the fake
 * server/event stream. The live socket must receive an honest degraded session frame and reject
 * further mutation attempts; it must not keep claiming a drivable shared-server owner or active
 * terminal sync.
 *
 *   bun run scripts/broker/tests_traces/opencode-owner-degrade-trace.ts
 */
export {};
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OC_PORT = Number(process.env.COSYNCING_OC_TEST_PORT ?? 23000 + Math.floor(Math.random() * 10000));
const BROKER_PORT = Number(process.env.COSYNCING_TEST_PORT ?? 34000 + Math.floor(Math.random() * 10000));
const OC = `http://127.0.0.1:${OC_PORT}`;
const BROKER = `http://127.0.0.1:${BROKER_PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(process.cwd(), 'output', 'traces', runId, 'opencode', 'ST-32-owner-degrade');
const framesPath = join(outDir, 'frames.ndjson');
const nativePath = join(outDir, 'opencode.ndjson');
const brokerPath = join(outDir, 'broker.ndjson');
const tracePath = join(outDir, 'trace.json');
const SESSION = {
  id: 'ses_owner_degrade',
  slug: 'owner-degrade',
  directory: '/tmp/cosyncing-opencode-owner-degrade',
  title: 'owner degrade session',
  model: { id: 'gpt-5.2', providerID: 'openai', modelID: 'gpt-5.2' },
  time: { created: 1, updated: 2 },
};
const DELETED_SESSION = {
  id: 'ses_deleted_degrade',
  slug: 'deleted-degrade',
  directory: '/tmp/cosyncing-opencode-deleted-degrade',
  title: 'deleted degrade session',
  model: { id: 'gpt-5.2', providerID: 'openai', modelID: 'gpt-5.2' },
  time: { created: 1, updated: 2 },
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const assertions: { name: string; ok: boolean; detail?: string }[] = [];
const promptBodies: Array<{ sessionId: string; body: any }> = [];
const eventControllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
const enc = new TextEncoder();
mkdirSync(outDir, { recursive: true });
const opencodeData = join(outDir, 'opencode-data');
mkdirSync(join(opencodeData, 'storage', 'session'), { recursive: true });

function record(path: string, obj: unknown): void {
  appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...(obj as Record<string, unknown>) }) + '\n');
}

function check(name: string, ok: boolean, detail = ''): void {
  assertions.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const fake = Bun.serve({
  hostname: '127.0.0.1',
  port: OC_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    record(nativePath, { method: req.method, path: url.pathname });
    if (url.pathname === '/global/event') {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          eventControllers.add(controller);
        },
        cancel() {
          /* closeEventStreams prunes controllers; the cancel argument is only a reason. */
        },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.pathname === '/project') return Response.json([{ worktree: SESSION.directory }, { worktree: DELETED_SESSION.directory }]);
    if (url.pathname === '/session' && req.method === 'GET') return Response.json([SESSION, DELETED_SESSION]);
    const target = [SESSION, DELETED_SESSION].find((s) => url.pathname === `/session/${s.id}` || url.pathname.startsWith(`/session/${s.id}/`));
    if (target && url.pathname === `/session/${target.id}` && req.method === 'GET') return Response.json(target);
    if (target && url.pathname === `/session/${target.id}/message`) return Response.json([]);
    if (target && url.pathname === `/session/${target.id}/prompt_async` && req.method === 'POST') {
      promptBodies.push({ sessionId: target.id, body: await req.json() });
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/question' || url.pathname === '/permission' || url.pathname === '/agent') return Response.json([]);
    if (url.pathname === '/api/model') return Response.json({ data: [] });
    return new Response('not found', { status: 404 });
  },
});

const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
  env: {
    ...process.env,
    PORT: String(BROKER_PORT),
    HOST: '127.0.0.1',
    OPENCODE_URL: OC,
    COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
    OPENCODE_DATA: opencodeData,
  },
  stdout: 'pipe',
  stderr: 'pipe',
});
void drain(broker.stdout, 'stdout');
void drain(broker.stderr, 'stderr');

try {
  if (!(await waitHealth())) throw new Error(`broker did not start at ${BROKER}`);
  const sessions = await brokerSessions();
  const row = sessions.find((s: any) => s.tool === 'opencode' && s.id === SESSION.id);
  check('fake shared-server row is discovered', !!row, JSON.stringify(sessions.filter((s: any) => s.tool === 'opencode').map((s: any) => s.id)));
  check('OpenCode row is sync-available but not falsely active before owner loss', row?.control?.terminalSync?.syncAvailable === true && row.control.terminalSync.active === false, JSON.stringify(row?.control?.terminalSync));

  const deletedFrames: any[] = [];
  const deletedWs = new WebSocket(`${WSBASE}/api/sessions/opencode/${encodeURIComponent(DELETED_SESSION.id)}/stream`);
  deletedWs.onmessage = (e) => {
    try {
      const frame = JSON.parse(String(e.data));
      deletedFrames.push(frame);
      record(framesPath, { phase: 'session-deleted', frame });
    } catch {
      /* ignore */
    }
  };
  await new Promise<void>((resolve, reject) => {
    deletedWs.onopen = () => resolve();
    deletedWs.onerror = () => reject(new Error('deleted-session broker WebSocket failed'));
  });
  const deletedInitial = await waitFrame(deletedFrames, (f) => f.kind === 'session', 5000);
  check('deleted-session probe starts as shared-server drive owner', deletedInitial?.info?.control?.drive?.state === 'driving', JSON.stringify(deletedInitial?.info?.control));
  const markDeleted = deletedFrames.length;
  sendEvent({ type: 'session.deleted', properties: { sessionID: DELETED_SESSION.id } });
  const deletedDegrade = await waitFrame(
    deletedFrames,
    (f) =>
      deletedFrames.indexOf(f) >= markDeleted &&
      f.kind === 'session' &&
      f.info?.attachMode === 'observe' &&
      f.info?.status === 'idle' &&
      f.info?.control?.drive?.state === 'unavailable' &&
      f.info?.control?.terminalSync?.active === false,
    5000,
  );
  check('session.deleted downgrades open OpenCode socket while server stays alive', !!deletedDegrade, JSON.stringify(deletedDegrade?.info?.control));
  const deletedErr = await waitFrame(deletedFrames, (f) => deletedFrames.indexOf(f) >= markDeleted && f.kind === 'message' && f.message?.type === 'error' && /deleted/i.test(f.message.message ?? ''), 2000);
  check('session.deleted emits visible deleted-session error', !!deletedErr, JSON.stringify(deletedErr?.message));
  deletedWs.send(JSON.stringify({ kind: 'prompt', text: 'SHOULD_NOT_REACH_DELETED_OPENCODE' }));
  const deletedReadOnly = await waitFrame(deletedFrames, (f) => deletedFrames.indexOf(f) >= markDeleted && f.kind === 'error' && /read-only observe session/.test(String(f.message ?? '')), 3000);
  check(
    'deleted OpenCode socket rejects prompt before HTTP send',
    !!deletedReadOnly && !promptBodies.some((p) => p.sessionId === DELETED_SESSION.id),
    `error=${deletedReadOnly?.message ?? ''} prompts=${promptBodies.filter((p) => p.sessionId === DELETED_SESSION.id).length}`,
  );
  deletedWs.close();

  const frames: any[] = [];
  const ws = new WebSocket(`${WSBASE}/api/sessions/opencode/${encodeURIComponent(SESSION.id)}/stream`);
  ws.onmessage = (e) => {
    try {
      const frame = JSON.parse(String(e.data));
      frames.push(frame);
      record(framesPath, frame);
    } catch {
      /* ignore */
    }
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('broker WebSocket failed'));
  });
  const initial = await waitFrame(frames, (f) => f.kind === 'session', 5000);
  check('attached socket starts as shared-server drive owner', initial?.info?.control?.drive?.state === 'driving' && initial.info.control.terminalSync.active === false, JSON.stringify(initial?.info?.control));

  const mark = frames.length;
  closeEventStreams();
  fake.stop(true);
  const degraded = await waitFrame(
    frames,
    (f) =>
      frames.indexOf(f) >= mark &&
      f.kind === 'session' &&
      f.info?.attachMode === 'observe' &&
      f.info?.status === 'idle' &&
      f.info?.control?.drive?.state === 'unavailable' &&
      f.info?.control?.terminalSync?.active === false,
    5000,
  );
  check('shared-server disappearance downgrades open OpenCode socket', !!degraded, JSON.stringify(degraded?.info?.control));
  const err = await waitFrame(frames, (f) => frames.indexOf(f) >= mark && f.kind === 'message' && f.message?.type === 'error' && /disconnected/i.test(f.message.message ?? ''), 2000);
  check('OpenCode owner loss emits visible error message', !!err, JSON.stringify(err?.message));

  ws.send(JSON.stringify({ kind: 'prompt', text: 'SHOULD_NOT_REACH_DEAD_OPENCODE' }));
  const readOnly = await waitFrame(frames, (f) => frames.indexOf(f) >= mark && f.kind === 'error' && /read-only observe session/.test(String(f.message ?? '')), 3000);
  check('degraded OpenCode socket rejects prompt at broker boundary', !!readOnly, `error=${readOnly?.message ?? ''} prompts=${promptBodies.filter((p) => p.sessionId === SESSION.id).length}`);

  const after = (await brokerSessions()).find((s: any) => s.tool === 'opencode' && s.id === SESSION.id);
  check('roster overlay has no stale active sync after owner loss', after?.control?.terminalSync?.active === false && after?.control?.drive?.state === 'unavailable', JSON.stringify(after?.control));
  ws.close();
} catch (err) {
  check('trace driver completed without exception', false, String(err));
} finally {
  try { fake.stop(true); } catch { /* already stopped */ }
  broker.kill();
  const failed = assertions.filter((a) => !a.ok).length;
  writeFileSync(tracePath, JSON.stringify({
    scenarioIds: ['ST-32'],
    agent: 'opencode',
    version: { cosyncing: 'local-source', opencode: 'simulated-http-sse' },
    broker: BROKER,
    opencode: OC,
    output: { frames: framesPath, native: nativePath, broker: brokerPath },
    assertions,
    status: failed ? 'fail' : 'pass',
    skipReason: null,
  }, null, 2));
  console.log(`\ntrace: ${tracePath}`);
  console.log(`${assertions.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

function closeEventStreams(): void {
  for (const c of [...eventControllers]) {
    try {
      c.enqueue(enc.encode('event: close\ndata: {}\n\n'));
      c.close();
    } catch {
      /* stream already closed */
    }
    eventControllers.delete(c);
  }
}

function sendEvent(event: unknown): void {
  const payload = enc.encode(`data: ${JSON.stringify({ payload: event })}\n\n`);
  for (const c of [...eventControllers]) {
    try {
      c.enqueue(payload);
    } catch {
      eventControllers.delete(c);
    }
  }
}

async function waitHealth(): Promise<boolean> {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${BROKER}/api/health`)).ok) return true;
    } catch {
      /* broker not ready */
    }
    await sleep(100);
  }
  return false;
}

async function brokerSessions(): Promise<any[]> {
  const body = await (await fetch(`${BROKER}/api/sessions`)).json();
  return Array.isArray(body) ? body : body?.sessions ?? [];
}

async function waitFrame(frames: any[], pred: (f: any) => boolean, ms: number): Promise<any> {
  const end = Date.now() + ms;
  for (;;) {
    const frame = frames.find(pred);
    if (frame) return frame;
    if (Date.now() > end) return undefined;
    await sleep(50);
  }
}

async function drain(stream: ReadableStream<Uint8Array>, label: string): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text) record(brokerPath, { stream: label, text });
    }
  } catch {
    /* process ended */
  }
}
