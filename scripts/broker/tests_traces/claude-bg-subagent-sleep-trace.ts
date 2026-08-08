/**
 * Claude background-subagent sleep trace (SLOW, real claude-mi).
 *
 * Default run asks Claude to spawn a background subagent that blocks for 5 minutes. Set
 * COSYNCING_TRACE_FAST=1 to shrink the prompt to 60s for iteration. The committed default remains 5m.
 *
 *   CLAUDE_BG_TRACE_JSONL=/path/to/<uuid>.jsonl bun scripts/broker/tests_traces/claude-bg-subagent-sleep-trace.ts
 */
export {};
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const PORT = Number(process.env.COSYNCING_TEST_PORT ?? 23000 + Math.floor(Math.random() * 20000));
const BROKER = `http://127.0.0.1:${PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(process.cwd(), 'output', 'traces', runId, 'claude', 'bg-subagent-sleep');
const framesPath = join(outDir, 'frames.ndjson');
const tracePath = join(outDir, 'trace.json');
const fast = process.env.COSYNCING_TRACE_FAST === '1';
const expectedMs = fast ? 60_000 : 5 * 60_000;
const sleepPhrase = fast ? 'sleep 60s' : 'sleep 5m';
const prompt = `Spawn a background subagent with cheapest model to test extended task execution. Have it run ${sleepPhrase} as a blocking foreground command (not backgrounded), then report completion. The agent should actively wait/occupy the full duration—do not launch the task in background and exit early. I want to observe the wall-clock duration and task completion notification to verify the agent sustains work over time. Report the final duration and token usage.`;
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
  if (process.env.CLAUDE_BG_TRACE_JSONL) return process.env.CLAUDE_BG_TRACE_JSONL;
  const dir = join(homedir(), '.claude-mi', 'projects', '-tmp-ca-mi-ws');
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => join(dir, n))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
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
  if (!transcript || !existsSync(transcript)) throw new Error('No claude-mi transcript found; set CLAUDE_BG_TRACE_JSONL.');
  if (!(await waitHealth(`${BROKER}/api/health`))) throw new Error(`broker did not start at ${BROKER}`);
  const id = Buffer.from(transcript).toString('base64url');
  const frames: any[] = [];
  const activity: Array<{ at: number; status: string; elapsedMs?: number }> = [];
  // Reruns reuse the session: cards from a PREVIOUS run's subagent replay on attach and must not
  // count as this run's activity. Everything seen before the prompt is baseline; only new keys count.
  const baselineAgentKeys = new Set<string>();
  let promptSent = false;
  const ws = new WebSocket(`${WSBASE}/api/sessions/claude/${encodeURIComponent(id)}/stream?mode=resume`);
  ws.onmessage = (e) => {
    try {
      const frame = JSON.parse(String(e.data));
      frames.push(frame);
      record(frame);
      const m = frame.message;
      if (frame.kind === 'message' && m?.type === 'agent-activity' && m.kind === 'subagent') {
        if (!promptSent) baselineAgentKeys.add(String(m.key));
        else if (!baselineAgentKeys.has(String(m.key))) activity.push({ at: Date.now(), status: String(m.status), elapsedMs: m.elapsedMs });
      }
    } catch {
      /* skip malformed frames */
    }
  };
  await openWs(ws);
  await waitFrame(frames, (f) => f.kind === 'session' && f.info?.control?.drive?.state === 'driving', 10000);
  const baselineNotifications = notificationCount(transcript);
  const startedAt = Date.now();
  promptSent = true;
  ws.send(JSON.stringify({ kind: 'prompt', text: prompt }));
  await waitFor(() => notificationCount(transcript) > baselineNotifications, expectedMs + 180_000);
  const notifiedAt = Date.now();
  await waitFrame(frames, (f) => f.kind === 'message' && f.message?.type === 'status' && f.message.status === 'idle', 180000);
  // The card must stay 'running' for the whole blocking sleep. Done may legitimately arrive a
  // moment BEFORE the parent's <task-notification> line: the subagent's own final message
  // (tail-shape 'final-text') is an earlier, equally-true completion signal — what must NEVER
  // happen is a premature done while the sleep is still in flight (the issues-part1 bug showed
  // "✓ done · 4s" within seconds of launch).
  const prematureDone = activity.some((a) => a.status === 'done' && (a.elapsedMs ?? 0) < expectedMs);
  const maxElapsed = Math.max(0, ...activity.map((a) => a.elapsedMs ?? 0));
  check('parent transcript received task-notification', notificationCount(transcript) > baselineNotifications);
  check('activity stream never reported done while the sleep was still running', !prematureDone, JSON.stringify(activity.slice(-10)));
  check('final observed wall-clock duration meets sleep target', notifiedAt - startedAt >= expectedMs, `${notifiedAt - startedAt}ms >= ${expectedMs}ms`);
  check('activity elapsed reached the sleep target when reported', maxElapsed === 0 || maxElapsed >= expectedMs, `${maxElapsed}ms >= ${expectedMs}ms`);
  ws.close();
} catch (err) {
  check('trace driver completed without exception', false, String(err));
} finally {
  broker.kill();
  const failed = assertions.filter((a) => !a.ok).length;
  writeFileSync(tracePath, JSON.stringify({
    scenarioIds: ['CLAUDE-BG-SUBAGENT-SLEEP'],
    agent: 'claude',
    backend: 'claude-mi',
    transcript,
    broker: BROKER,
    fast,
    prompt,
    output: { frames: framesPath },
    assertions,
    status: failed ? 'fail' : 'pass',
  }, null, 2));
  console.log(`\ntrace: ${tracePath}`);
  console.log(`${assertions.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

function notificationCount(path: string): number {
  // COUNT, not includes(): reruns reuse the same session, so a leftover <task-notification> from a
  // previous run must not satisfy this run's wait (it made a rerun "complete" after 0ms).
  try {
    return readFileSync(path, 'utf8').split('<task-notification>').length - 1;
  } catch {
    return 0;
  }
}

async function openWs(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket open timed out')), 10000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket failed')); };
  });
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
    await sleep(250);
  }
  throw new Error('timed out waiting for trace condition');
}
