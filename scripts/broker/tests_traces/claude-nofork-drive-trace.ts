/**
 * Claude no-fork Drive trace (SLOW, real claude-mi).
 *
 * Attaches through an isolated broker to an existing claude-mi transcript with no live owner, drives two
 * turns across a reconnect, and proves Drive resumes in place:
 *   - no new sibling *.jsonl appears,
 *   - the original transcript grows after both turns,
 *   - the second turn can recall context from the first.
 *
 * Defaults to the handover's existing workspace. Override with:
 *   CLAUDE_NOFORK_TRACE_JSONL=/path/to/<uuid>.jsonl bun scripts/broker/tests_traces/claude-nofork-drive-trace.ts
 */
export {};
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const PORT = Number(process.env.COSYNCING_TEST_PORT ?? 22000 + Math.floor(Math.random() * 20000));
const BROKER = `http://127.0.0.1:${PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(process.cwd(), 'output', 'traces', runId, 'claude', 'nofork-drive');
const framesPath = join(outDir, 'frames.ndjson');
const tracePath = join(outDir, 'trace.json');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Assertion { name: string; ok: boolean; detail?: string }
const assertions: Assertion[] = [];
mkdirSync(outDir, { recursive: true });

function check(name: string, ok: boolean, detail = ''): void {
  assertions.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`);
}

function record(obj: unknown): void {
  appendFileSync(framesPath, JSON.stringify({ ts: new Date().toISOString(), ...(obj as Record<string, unknown>) }) + '\n');
}

function defaultTranscript(): string | null {
  if (process.env.CLAUDE_NOFORK_TRACE_JSONL) return process.env.CLAUDE_NOFORK_TRACE_JSONL;
  const dir = join(homedir(), '.claude-mi', 'projects', '-tmp-ca-mi-ws');
  try {
    const rows = readdirSync(dir)
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => join(dir, n))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

const transcript = defaultTranscript();
const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
  stdout: 'pipe',
  stderr: 'pipe',
});

try {
  if (!transcript || !existsSync(transcript)) throw new Error('No claude-mi transcript found; set CLAUDE_NOFORK_TRACE_JSONL.');
  if (!(await waitHealth(`${BROKER}/api/health`))) throw new Error(`broker did not start at ${BROKER}`);

  const projectDir = dirname(transcript);
  const originalName = basename(transcript);
  const beforeFiles = jsonlNames(projectDir);
  const beforeSize = statSync(transcript).size;
  const id = Buffer.from(transcript).toString('base64url');

  const first = await driveTurn(id, "Remember the word 'grapefruit'. Reply with exactly: remembered grapefruit.", /remembered|grapefruit/i);
  const afterFirstSize = statSync(transcript).size;
  check('turn A appended to original transcript', afterFirstSize > beforeSize, `${beforeSize} -> ${afterFirstSize}`);

  first.close();
  await sleep(500);

  const second = await driveTurn(id, 'What word did I ask you to remember? Reply with the single word only.', /grapefruit/i);
  const afterSecondSize = statSync(transcript).size;
  check('turn B appended to original transcript', afterSecondSize > afterFirstSize, `${afterFirstSize} -> ${afterSecondSize}`);
  check('turn B remembered grapefruit after reconnect', /grapefruit/i.test(second.text), second.text.slice(-300));
  second.close();

  const afterFiles = jsonlNames(projectDir);
  const newFiles = afterFiles.filter((n) => !beforeFiles.includes(n));
  check('no sibling fork transcript was created', newFiles.length === 0, newFiles.join(', '));
  check('trace targeted original file', afterFiles.includes(originalName), originalName);
} catch (err) {
  check('trace driver completed without exception', false, String(err));
} finally {
  broker.kill();
  const failed = assertions.filter((a) => !a.ok).length;
  writeFileSync(tracePath, JSON.stringify({
    scenarioIds: ['CLAUDE-NOFORK-DRIVE'],
    agent: 'claude',
    backend: 'claude-mi',
    transcript,
    broker: BROKER,
    output: { frames: framesPath },
    assertions,
    status: failed ? 'fail' : 'pass',
  }, null, 2));
  console.log(`\ntrace: ${tracePath}`);
  console.log(`${assertions.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

async function driveTurn(id: string, text: string, expect: RegExp): Promise<{ close: () => void; text: string }> {
  const frames: any[] = [];
  let combined = '';
  const ws = new WebSocket(`${WSBASE}/api/sessions/claude/${encodeURIComponent(id)}/stream?mode=resume`);
  ws.onmessage = (e) => {
    try {
      const frame = JSON.parse(String(e.data));
      frames.push(frame);
      record(frame);
      const m = frame.message;
      if (frame.kind === 'message' && m?.type === 'model-output') combined += String(m.delta ?? m.text ?? '');
    } catch {
      /* skip malformed frames */
    }
  };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket open timed out')), 10000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket failed')); };
  });
  await waitFrame(frames, (f) => f.kind === 'session' && f.info?.control?.drive?.state === 'driving', 10000);
  ws.send(JSON.stringify({ kind: 'prompt', text }));
  await waitFor(() => expect.test(combined), 120000);
  await waitFrame(frames, (f) => f.kind === 'message' && f.message?.type === 'status' && f.message.status === 'idle', 120000);
  return { close: () => ws.close(), text: combined };
}

async function waitHealth(url: string): Promise<boolean> {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      /* not ready */
    }
    await sleep(250);
  }
  return false;
}

async function waitFrame(frames: any[], pred: (f: any) => boolean, ms: number): Promise<any> {
  let found: any;
  await waitFor(() => {
    found = frames.find(pred);
    return !!found;
  }, ms);
  return found;
}

async function waitFor(pred: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() <= end) {
    if (pred()) return;
    await sleep(100);
  }
  throw new Error('timed out waiting for trace condition');
}

function jsonlNames(dir: string): string[] {
  return readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort();
}
