/**
 * OpenCode real-serve owner-degrade trace (OPT-IN, real binary, no model turn).
 *
 * Starts a real `opencode serve` on a throwaway port, creates a throwaway shared-server session,
 * attaches through the real broker, kills the real server, and verifies the open app socket downgrades
 * to read-only Observe with no stale owner/sync claim and broker-side prompt rejection.
 *
 *   COSYNCING_OPENCODE_REAL_SERVE_DEGRADE=1 bun run scripts/broker/tests_traces/opencode-real-serve-owner-degrade-trace.ts
 */
export {};
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Assertion,
  check,
  drainProcessOutput,
  freePort,
  hasCommand,
  record,
  sleep,
  waitFrame,
  waitHealth,
} from './_real-tui-app-helpers.ts';

const enabled = process.env.COSYNCING_OPENCODE_REAL_SERVE_DEGRADE === '1';
if (!enabled) {
  console.log('SKIP opencode real-serve owner-degrade - set COSYNCING_OPENCODE_REAL_SERVE_DEGRADE=1 (opt-in: real opencode serve)');
  process.exit(0);
}

const OC_PORT = Number(process.env.COSYNCING_OC_TEST_PORT ?? await freePort());
const BROKER_PORT = Number(process.env.COSYNCING_TEST_PORT ?? await freePort());
const OC = `http://127.0.0.1:${OC_PORT}`;
const BROKER = `http://127.0.0.1:${BROKER_PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const short = randomBytes(3).toString('hex');
const outDir = join(process.cwd(), 'output', 'traces', runId, 'opencode', 'real-serve-owner-degrade');
const framesPath = join(outDir, 'frames.ndjson');
const opencodePath = join(outDir, 'opencode-serve.ndjson');
const brokerPath = join(outDir, 'broker.ndjson');
const tracePath = join(outDir, 'trace.json');
const workspace = mkdtempSync(join(tmpdir(), `cosyncing-opencode-real-degrade-${short}-`));
const model = {
  providerID: process.env.OPENCODE_TRACE_PROVIDER_ID ?? 'vllm-hpc',
  id: process.env.OPENCODE_TRACE_MODEL_ID ?? 'qwen3.6-27B-FP8',
};
const assertions: Assertion[] = [];
const frames: any[] = [];
mkdirSync(outDir, { recursive: true });

let opencode: ReturnType<typeof Bun.spawn> | undefined;
let broker: ReturnType<typeof Bun.spawn> | undefined;
let ws: WebSocket | undefined;
let sessionId = '';
let skipReason: string | null = null;

try {
  if (!(await hasCommand('opencode'))) skip('opencode is not on PATH');

  opencode = Bun.spawn(['opencode', 'serve', '--hostname', '127.0.0.1', '--port', String(OC_PORT), '--print-logs'], {
    cwd: workspace,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  drainProcessOutput(opencode, opencodePath);
  check(assertions, 'real opencode serve starts', await waitHealth(`${OC}/global/health`, 20000), OC);
  if (!assertions.at(-1)?.ok) throw new Error(`opencode serve did not start at ${OC}: ${await fileTail(opencodePath)}`);

  broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(BROKER_PORT),
      HOST: '127.0.0.1',
      OPENCODE_URL: OC,
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  drainProcessOutput(broker, brokerPath);
  check(assertions, 'broker starts against real opencode serve', await waitHealth(`${BROKER}/api/health`, 15000), BROKER);
  if (!assertions.at(-1)?.ok) throw new Error(`broker did not start at ${BROKER}: ${await fileTail(brokerPath)}`);

  sessionId = await createSession();
  check(assertions, 'throwaway OpenCode session created on real serve', /^ses/.test(sessionId), sessionId);

  const row = await waitForBrokerSession(sessionId, 15000);
  check(assertions, 'broker discovers the real OpenCode session', !!row, JSON.stringify(row ?? null));
  check(
    assertions,
    'OpenCode real-serve row starts drivable but not falsely terminal-active',
    row?.control?.drive?.state === 'driving' && row?.control?.terminalSync?.active === false,
    JSON.stringify(row?.control ?? null),
  );

  ws = new WebSocket(`${WSBASE}/api/sessions/opencode/${encodeURIComponent(sessionId)}/stream`);
  ws.onmessage = (e) => {
    try {
      const frame = JSON.parse(String(e.data));
      frames.push(frame);
      record(framesPath, frame);
    } catch {
      /* ignore malformed frames */
    }
  };
  await new Promise<void>((resolve, reject) => {
    ws!.onopen = () => resolve();
    ws!.onerror = () => reject(new Error('broker WebSocket failed'));
  });
  const initial = await waitFrame(frames, (f) => f.kind === 'session', 5000);
  check(assertions, 'attached socket starts as real shared-server drive owner', initial?.info?.control?.drive?.state === 'driving', JSON.stringify(initial?.info?.control ?? null));

  const mark = frames.length;
  opencode.kill();
  await opencode.exited.catch(() => undefined);
  opencode = undefined;
  const degraded = await waitFrame(
    frames,
    (f) =>
      frames.indexOf(f) >= mark &&
      f.kind === 'session' &&
      f.info?.attachMode === 'observe' &&
      f.info?.control?.drive?.state === 'unavailable' &&
      f.info?.control?.terminalSync?.active === false,
    8000,
  );
  check(assertions, 'real opencode serve disappearance downgrades open socket', !!degraded, JSON.stringify(degraded?.info?.control ?? null));

  const visibleError = await waitFrame(frames, (f) => frames.indexOf(f) >= mark && f.kind === 'message' && f.message?.type === 'error' && /disconnect|unavailable|lost|closed/i.test(String(f.message.message ?? '')), 3000);
  check(assertions, 'real OpenCode owner loss emits visible error', !!visibleError, JSON.stringify(visibleError?.message ?? null));

  ws.send(JSON.stringify({ kind: 'prompt', text: 'SHOULD_NOT_REACH_REAL_OPENCODE_AFTER_DEGRADE' }));
  const readOnly = await waitFrame(frames, (f) => frames.indexOf(f) >= mark && f.kind === 'error' && /read-only observe session/.test(String(f.message ?? '')), 3000);
  check(assertions, 'degraded real OpenCode socket rejects prompt at broker boundary', !!readOnly, String(readOnly?.message ?? ''));
} catch (err) {
  if (!skipReason) check(assertions, 'opencode real-serve owner-degrade completed without exception', false, String(err));
} finally {
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  try {
    opencode?.kill();
  } catch {
    /* ignore */
  }
  try {
    broker?.kill();
  } catch {
    /* ignore */
  }
  const failed = assertions.filter((a) => !a.ok).length;
  writeFileSync(tracePath, JSON.stringify({
    agent: 'opencode',
    scenarioIds: ['ST-32'],
    mode: 'real-serve-owner-degrade',
    broker: BROKER,
    opencode: OC,
    workspace,
    sessionId,
    model,
    output: { frames: framesPath, native: opencodePath, broker: brokerPath },
    assertions,
    status: skipReason ? 'skip' : failed ? 'fail' : 'pass',
    skipReason,
  }, null, 2));
  rmSync(workspace, { recursive: true, force: true });
  console.log(`\ntrace: ${tracePath}`);
  console.log(skipReason ? `SKIP ${skipReason}` : `${assertions.length - failed} passed, ${failed} failed`);
  process.exit(skipReason || failed === 0 ? 0 : 1);
}

function skip(reason: string): never {
  skipReason = reason;
  throw new Error(reason);
}

async function createSession(): Promise<string> {
  const res = await fetch(`${OC}/session?directory=${encodeURIComponent(workspace)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: `cosyncing-real-degrade-${short}`,
      model,
      permission: [{ permission: 'bash', pattern: '*', action: 'ask' }],
    }),
  });
  if (!res.ok) throw new Error(`create OpenCode session ${res.status}: ${await res.text()}`);
  const body: any = await res.json();
  return String(body.id ?? '');
}

async function brokerSessions(): Promise<any[]> {
  const body: any = await (await fetch(`${BROKER}/api/sessions`)).json();
  return Array.isArray(body) ? body : body?.sessions ?? [];
}

async function waitForBrokerSession(id: string, ms: number): Promise<any | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const found = (await brokerSessions()).find((s) => s.tool === 'opencode' && s.id === id);
    if (found) return found;
    await sleep(250);
  }
  return undefined;
}

async function fileTail(path: string): Promise<string> {
  try {
    const { readFileSync } = await import('node:fs');
    return readFileSync(path, 'utf8').slice(-2000);
  } catch {
    return '<no output>';
  }
}
