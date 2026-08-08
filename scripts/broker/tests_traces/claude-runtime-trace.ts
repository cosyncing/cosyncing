/**
 * Claude turn-runtime + timestamps product trace (doc-15). Through the full stack (real broker → real Claude
 * adapter; fake `claude` only for the empty `agents --json` overlay — NO model cost): an Observe attach to a
 * transcript with native ISO timestamps replays per-turn `run-summary` frames (completed turn → done with
 * authoritative startedAt/completedAt/totalRuntimeMs + tokens), the session `runtimeTotals` metadata-update,
 * and `user-message.sentAt`. Because the discovered row is idle, the trailing turn is finalized from the
 * last assistant timestamp; working rows are covered by the mapper/unit suite and stay running.
 *
 * Writes output/traces/<run-id>/claude/ST-CLAUDE-RUNTIME/{trace.json,frames.ndjson}.
 *
 *   bun run scripts/broker/tests_traces/claude-runtime-trace.ts
 */
export {};
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.COSYNCING_TEST_PORT ?? 25000 + Math.floor(Math.random() * 20000));
const BROKER = `http://127.0.0.1:${PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(process.cwd(), 'output', 'traces', runId, 'claude', 'ST-CLAUDE-RUNTIME');
const framesPath = join(outDir, 'frames.ndjson');
const tracePath = join(outDir, 'trace.json');
const UUID = '0aaaaaaa-0000-4000-8000-runtimetrace';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const T = (s: string) => Date.parse(s);
const T0 = '2026-06-18T17:46:28.834Z';
const T1 = '2026-06-18T17:46:34.834Z'; // turn 1 last assistant → 6000ms turn
const T2 = '2026-06-18T17:51:08.096Z'; // turn 2 prompt (closes turn 1)
const T3 = '2026-06-18T17:51:11.096Z'; // turn 2 assistant

interface Assertion { name: string; ok: boolean; detail?: string }
const assertions: Assertion[] = [];
mkdirSync(outDir, { recursive: true });
function record(path: string, obj: unknown): void {
  appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...(obj as Record<string, unknown>) }) + '\n');
}
function check(name: string, ok: boolean, detail = ''): void {
  assertions.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`);
}

const tempRoot = mkdtempSync(join(tmpdir(), 'cosyncing-claude-runtime-'));
const configDir = join(tempRoot, 'claude-config');
const workDir = join(tempRoot, 'workspace');
const binDir = join(tempRoot, 'bin');
const fakeClaude = join(binDir, 'claude');
const slugDir = join(configDir, 'projects', 'proj-slug');
mkdirSync(workDir, { recursive: true });
mkdirSync(binDir, { recursive: true });
mkdirSync(slugDir, { recursive: true });
writeTranscript();
writeFakeClaude();

let broker: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;
try {
  broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', HOME: tempRoot, CLAUDE_CONFIG_DIR: configDir, COSYNCING_CLAUDE_BIN: fakeClaude },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  drainBrokerOutput(broker);
  if (!(await waitHealth())) throw new Error(`broker did not start at ${BROKER}`);

  const sessionsBody = await (await fetch(`${BROKER}/api/sessions`)).json();
  const sessions = Array.isArray(sessionsBody) ? sessionsBody : sessionsBody.sessions ?? [];
  const row = sessions.find((s: any) => s.tool === 'claude' && s.cwd === workDir);
  check('runtime transcript session discovered', !!row, JSON.stringify(row?.id));

  const obs = await attach(row.id);
  const history = await obs.waitFrame((f) => f.kind === 'history', 5000);
  const msgs: any[] = history?.messages ?? [];

  const u1 = msgs.find((m) => m.type === 'user-message' && m.text === 'first prompt');
  check('user bubble carries authoritative sentAt + turnId', u1?.sentAt === T(T0) && u1?.turnId === 'u1', JSON.stringify({ sentAt: u1?.sentAt, turnId: u1?.turnId }));

  const runs = msgs.filter((m) => m.type === 'run-summary');
  const r1 = runs.find((r) => r.turnId === 'u1');
  check('completed turn 1 → run-summary done with native total runtime', r1?.status === 'done' && r1?.startedAt === T(T0) && r1?.completedAt === T(T1) && r1?.totalRuntimeMs === T(T1) - T(T0), JSON.stringify({ status: r1?.status, total: r1?.totalRuntimeMs }));
  check('turn 1 run-summary carries per-turn tokens + omits the agent/exec split (no fake zeros)', r1?.tokens?.input === 10 && r1?.tokens?.output === 20 && r1?.agentRuntimeMs === undefined && r1?.executionRuntimeMs === undefined, JSON.stringify(r1?.tokens));
  const r2 = runs.find((r) => r.turnId === 'u2');
  check('idle Observe trailing turn 2 finalizes with native total runtime', r2?.status === 'done' && r2?.completedAt === T(T3) && r2?.totalRuntimeMs === T(T3) - T(T2), JSON.stringify({ status: r2?.status, total: r2?.totalRuntimeMs }));

  const totals = msgs.filter((m) => m.type === 'metadata-update' && m.key === 'runtimeTotals');
  check('session runtimeTotals reflect both idle completed turns (turnCount 2)', totals.length >= 1 && totals.at(-1).value.turnCount === 2 && totals.at(-1).value.totalRuntimeMs === (T(T1) - T(T0)) + (T(T3) - T(T2)), JSON.stringify(totals.at(-1)?.value));
  obs.close();
} catch (err) {
  check('trace driver completed without exception', false, String(err));
} finally {
  broker?.kill();
  const failed = assertions.filter((a) => !a.ok).length;
  writeFileSync(tracePath, JSON.stringify({
    scenarioIds: ['ST-CLAUDE-RUNTIME'],
    agent: 'claude',
    version: { cosyncing: 'local-source', claude: 'fake-agents-overlay' },
    broker: BROKER,
    configDir,
    steps: [
      'seed a transcript with native ISO timestamps + two turns in an idle session',
      'start broker with a fake claude (empty agents --json overlay)',
      'Observe attach → assert per-turn run-summary (done+total for both turns), tokens, sentAt, runtimeTotals',
    ],
    output: { frames: framesPath },
    assertions,
    status: failed ? 'fail' : 'pass',
    skipReason: null,
  }, null, 2));
  rmSync(tempRoot, { recursive: true, force: true });
  console.log(`\ntrace: ${tracePath}`);
  console.log(`${assertions.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

function writeTranscript(): void {
  const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 };
  const lines = [
    { type: 'user', uuid: 'u1', cwd: workDir, sessionId: UUID, timestamp: T0, message: { role: 'user', content: 'first prompt' } },
    { type: 'assistant', uuid: 'a1', cwd: workDir, sessionId: UUID, timestamp: T1, message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'first answer' }], usage } },
    { type: 'user', uuid: 'u2', cwd: workDir, sessionId: UUID, timestamp: T2, message: { role: 'user', content: 'second prompt' } },
    { type: 'assistant', uuid: 'a3', cwd: workDir, sessionId: UUID, timestamp: T3, message: { id: 'm3', role: 'assistant', content: [{ type: 'text', text: 'second answer' }], usage } },
  ];
  writeFileSync(join(slugDir, `${UUID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function writeFakeClaude(): void {
  writeFileSync(fakeClaude, `#!/usr/bin/env bun
// Fake claude: only 'agents --json' is exercised (Observe) → empty roster (no waiting, no cost).
if (process.argv.slice(2).includes('agents')) { console.log('[]'); process.exit(0); }
process.exit(0);
`);
  chmodSync(fakeClaude, 0o755);
}

function drainBrokerOutput(proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>): void {
  void (async () => {
    for (const stream of [proc.stdout, proc.stderr]) {
      const reader = stream.getReader();
      try { for (;;) { const { done } = await reader.read(); if (done) break; } } catch { /* ended */ }
    }
  })();
}
async function waitHealth(): Promise<boolean> {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BROKER}/api/health`)).ok) return true; } catch { /* not ready */ }
    await sleep(100);
  }
  return false;
}
type Attach = { frames: any[]; waitFrame: (pred: (f: any) => boolean, ms: number) => Promise<any>; close: () => void };
function attach(sessionId: string, mode?: string): Promise<Attach> {
  return new Promise((resolve, reject) => {
    const query = mode ? `?mode=${encodeURIComponent(mode)}` : '';
    const ws = new WebSocket(`${WSBASE}/api/sessions/claude/${encodeURIComponent(sessionId)}/stream${query}`);
    const frames: any[] = [];
    const out: Attach = { frames, waitFrame: (pred, ms) => waitFrame(frames, pred, ms), close: () => { try { ws.close(); } catch {} } };
    ws.onmessage = (e) => { try { const f = JSON.parse(String(e.data)); frames.push(f); record(framesPath, { mode: mode ?? 'observe', frame: f }); } catch {} };
    ws.onerror = () => reject(new Error('websocket error'));
    ws.onopen = () => resolve(out);
  });
}
async function waitFrame(frames: any[], pred: (f: any) => boolean, ms: number): Promise<any> {
  const end = Date.now() + ms;
  for (;;) {
    const f = frames.find(pred);
    if (f) return f;
    if (Date.now() > end) return undefined;
    await sleep(60);
  }
}
