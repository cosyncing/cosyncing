/**
 * Claude OBSERVE pending-input surface trace (maintainer's bug: a blocked observe session showed a generic
 * "Blocked in terminal — permission prompt" notice for an AskUserQuestion instead of the actual question).
 *
 * Through the FULL stack (real broker → real Claude adapter, fake `claude` only for the `agents --json`
 * waiting overlay — NO model cost): a session blocked on an AskUserQuestion is discovered as needs-input,
 * and on Observe attach the broker replays the REAL question as a read-only question-request (question +
 * options), NOT the generic notice. A session blocked WITHOUT a transcript question (a genuine permission
 * prompt, which is not a transcript event and has no channel in Observe) still falls back to the read-only
 * notice. Proves the answer to "can the question render in observe?" — yes, for questions.
 *
 * Writes output/traces/<run-id>/claude/ST-CLAUDE-OBSERVE-QUESTION/{trace.json,frames.ndjson}.
 *
 *   bun run scripts/broker/tests_traces/claude-observe-question-trace.ts
 */
export {};
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.COSYNCING_TEST_PORT ?? 25000 + Math.floor(Math.random() * 20000));
const BROKER = `http://127.0.0.1:${PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(process.cwd(), 'output', 'traces', runId, 'claude', 'ST-CLAUDE-OBSERVE-QUESTION');
const framesPath = join(outDir, 'frames.ndjson');
const fakePath = join(outDir, 'fake-claude.ndjson');
const tracePath = join(outDir, 'trace.json');
const UUID_Q = '0aaaaaaa-0000-4000-8000-observequest';
const UUID_P = '0bbbbbbb-0000-4000-8000-observepermn';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

const tempRoot = mkdtempSync(join(tmpdir(), 'cosyncing-claude-obsq-'));
const configDir = join(tempRoot, 'claude-config');
const workDirQ = join(tempRoot, 'wsq');
const workDirP = join(tempRoot, 'wsp');
const binDir = join(tempRoot, 'bin');
const fakeClaude = join(binDir, 'claude');
const slugDir = join(configDir, 'projects', 'proj-slug');
mkdirSync(workDirQ, { recursive: true });
mkdirSync(workDirP, { recursive: true });
mkdirSync(binDir, { recursive: true });
mkdirSync(slugDir, { recursive: true });
writeTranscripts();
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
  const rowQ = sessions.find((s: any) => s.tool === 'claude' && s.cwd === workDirQ);
  const rowP = sessions.find((s: any) => s.tool === 'claude' && s.cwd === workDirP);
  check('blocked-on-question session discovered as needs-input', rowQ?.status === 'needs-input', JSON.stringify(rowQ?.status));
  check('blocked-on-permission session discovered as needs-input', rowP?.status === 'needs-input', JSON.stringify(rowP?.status));

  // ── A blocked-on-QUESTION observe session surfaces the REAL question (read-only), not a generic notice ──
  const obsQ = await attach(rowQ.id);
  await obsQ.waitFrame((f) => f.kind === 'history', 5000);
  const q = await obsQ.waitFrame((f) => f.kind === 'message' && f.message?.type === 'question-request', 5000);
  check('Observe replays the REAL AskUserQuestion as a question-request', !!q && q.message?.requestId === 'toolu_q1', JSON.stringify(q?.message?.requestId));
  check('  it is READ-ONLY and carries the real question + options (not "Blocked in terminal")', q?.message?.readOnly === true && q?.message?.questions?.[0]?.question === 'Which approach?' && (q?.message?.questions?.[0]?.options?.length ?? 0) === 2, JSON.stringify(q?.message?.questions?.[0]));
  const genericOnQ = obsQ.frames.some((f) => f.kind === 'message' && f.message?.type === 'permission-request' && f.message?.requestId === 'observe-block');
  check('  the misleading generic "Blocked in terminal" notice is NOT emitted for a question', !genericOnQ);
  obsQ.close();

  // ── A blocked-on-PERMISSION observe session (no transcript question) still gets the read-only notice ──
  const obsP = await attach(rowP.id);
  await obsP.waitFrame((f) => f.kind === 'history', 5000);
  const notice = await obsP.waitFrame((f) => f.kind === 'message' && f.message?.type === 'permission-request' && f.message?.requestId === 'observe-block', 5000);
  // The notice is HONEST: the live turn is held off the local transcript; no old "Blocked in terminal" wording;
  // it does NOT promise Drive answers it (driving discards the pending question); and the title does not start
  // with "Waiting for input" (the app prepends that prefix to read-only cards → would stutter otherwise).
  const noticeText = String(notice?.message?.title ?? '') + String(notice?.message?.detail ?? '');
  check('Observe on a genuine permission block falls back to the honest read-only notice', !!notice && notice.message?.readOnly === true && !/Blocked in terminal/.test(noticeText) && !/^Waiting for input/.test(String(notice?.message?.title ?? '')) && /local transcript/.test(noticeText) && /won't answer this pending question/.test(noticeText), JSON.stringify(notice?.message?.title));
  const questionOnP = obsP.frames.some((f) => f.kind === 'message' && f.message?.type === 'question-request');
  check('  no phantom question-request for a permission-only block', !questionOnP);
  obsP.close();
} catch (err) {
  check('trace driver completed without exception', false, String(err));
} finally {
  broker?.kill();
  const failed = assertions.filter((a) => !a.ok).length;
  writeFileSync(tracePath, JSON.stringify({
    scenarioIds: ['ST-CLAUDE-OBSERVE-QUESTION'],
    agent: 'claude',
    version: { cosyncing: 'local-source', claude: 'fake-agents-overlay' },
    broker: BROKER,
    configDir,
    steps: [
      'seed two blocked transcripts: one with an unanswered AskUserQuestion, one without (genuine permission)',
      'start broker with a fake claude whose `agents --json` reports both as waiting',
      'prove Observe surfaces the REAL question (read-only) for the question block, not a generic notice',
      'prove Observe falls back to the read-only "blocked in terminal" notice for the permission block',
    ],
    output: { frames: framesPath, fakeClaude: fakePath },
    assertions,
    status: failed ? 'fail' : 'pass',
    skipReason: null,
  }, null, 2));
  rmSync(tempRoot, { recursive: true, force: true });
  console.log(`\ntrace: ${tracePath}`);
  console.log(`${assertions.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

function writeTranscripts(): void {
  const qLines = [
    { type: 'user', uuid: 'uq', cwd: workDirQ, sessionId: UUID_Q, message: { role: 'user', content: 'pick an approach' } },
    { type: 'assistant', uuid: 'aq', cwd: workDirQ, sessionId: UUID_Q, message: { id: 'mq', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_q1', name: 'AskUserQuestion', input: { questions: [{ question: 'Which approach?', header: 'Approach', multiSelect: false, options: [{ label: 'MVP first', description: 'smallest slice' }, { label: 'Risk first', description: 'tackle unknowns' }] }] } }] } },
  ];
  const pLines = [
    { type: 'user', uuid: 'up', cwd: workDirP, sessionId: UUID_P, message: { role: 'user', content: 'do a thing' } },
    { type: 'assistant', uuid: 'ap', cwd: workDirP, sessionId: UUID_P, message: { id: 'mp', role: 'assistant', content: [{ type: 'text', text: 'about to run a command' }] } },
  ];
  writeFileSync(join(slugDir, `${UUID_Q}.jsonl`), qLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  writeFileSync(join(slugDir, `${UUID_P}.jsonl`), pLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function writeFakeClaude(): void {
  writeFileSync(fakeClaude, `#!/usr/bin/env bun
// Fake claude: only 'agents --json' is exercised (Observe needs no resume) → both sessions report WAITING so
// the adapter's status overlay flags them needs-input + sets waitingFor. No model turn, no cost.
const args = process.argv.slice(2);
const record = (o) => { try { require('node:fs').appendFileSync('${fakePath}', JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\\n"); } catch {} };
if (args.includes('agents')) {
  record({ call: 'agents --json' });
  console.log(JSON.stringify([
    { sessionId: '${UUID_Q}', status: 'waiting', waitingFor: 'permission prompt' },
    { sessionId: '${UUID_P}', status: 'waiting', waitingFor: 'permission prompt' },
  ]));
  process.exit(0);
}
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
type Attach = { frames: any[]; send: (obj: unknown) => void; waitFrame: (pred: (f: any) => boolean, ms: number) => Promise<any>; close: () => void };
function attach(sessionId: string, mode?: string): Promise<Attach> {
  return new Promise((resolve, reject) => {
    const query = mode ? `?mode=${encodeURIComponent(mode)}` : '';
    const ws = new WebSocket(`${WSBASE}/api/sessions/claude/${encodeURIComponent(sessionId)}/stream${query}`);
    const frames: any[] = [];
    const out: Attach = {
      frames,
      send: (obj) => ws.send(JSON.stringify(obj)),
      waitFrame: (pred, ms) => waitFrame(frames, pred, ms),
      close: () => { try { ws.close(); } catch {} },
    };
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
