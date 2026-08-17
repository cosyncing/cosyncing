/**
 * Claude live-sync via HOOKS — broker wiring end-to-end (NO claude, NO model cost).
 *
 * Drives the REAL broker on a test port with a SIMULATED in-session hook (HTTP POSTs to /claude/hook/*) and a
 * SIMULATED app (a WebSocket client on /api/sessions/claude/<id>/stream). Proves the full loop the production
 * hook relies on: hook relays a permission/question → broker emits the card to the app → app answers →
 * broker resolves the hook's blocking poll → hook gets the decision. Plus the non-intrusive viewers=0 path.
 *
 *   bun run packages/typescript/broker/test/claude/test-claude-hooks.ts   (exit 0 = all pass)
 */
export {};
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeSessionId, CLAUDE_HOOK_SCRIPT } from '../../../adapters/claude/src/index.ts';
import {
  captureProcessOutput,
  isolatedBrokerFixtureEnvironment,
  reserveLoopbackFixturePort,
  startHealthyFixtureBrokerOnPort,
} from '../helpers/isolated-broker-fixture.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REPO = join(import.meta.dir, '..', '..', '..', '..', '..');
const portLease = await reserveLoopbackFixturePort();
const PORT = portLease.port;
const BASE = `http://127.0.0.1:${PORT}`;

// The broker validates transcriptPath is under a Claude projects root (path-traversal guard) → run the broker
// with CLAUDE_CONFIG_DIR=work and place the transcript at <work>/projects/<slug>/session.jsonl.
const work = mkdtempSync(join(tmpdir(), 'claude-hooks-test-'));
const projDir = join(work, 'projects', 'test-proj');
mkdirSync(projDir, { recursive: true });
const transcriptPath = join(projDir, 'session.jsonl');
writeFileSync(transcriptPath, JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }) + '\n');
const id = claudeSessionId(transcriptPath);
const fixtureEnvironment = isolatedBrokerFixtureEnvironment(work, {
  overrides: {
    PORT: String(PORT),
    HOST: '127.0.0.1',
    COSYNCING_MACHINE: 'hooks-test',
    COSYNCING_DEV_MODE: '1',
    COSYNCING_BRIDGE_GRACE_MS: '300',
    CLAUDE_CONFIG_DIR: work,
  },
});

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return res.json().catch(() => ({}));
}
/** The in-session hook: re-post /request until it resolves or the app isn't watching (bounded for the test). */
async function hookRequest(body: any, tries = 6): Promise<any> {
  for (let i = 0; i < tries; i++) {
    const r = await post('/claude/hook/request', body);
    if (r.viewers === 0 || r.resolved || r.error) return r;
    await sleep(200);
  }
  return { resolved: false, timedOut: true };
}

await portLease.release();
// Started through the shared helper so a silent startup stall — alive, not
// listening, nothing written — is retired and respawned once on THIS port
// rather than costing the suite its whole readiness budget. Draining the pipes
// is what makes that provable; they were piped here and never read.
let brokerOutput!: ReturnType<typeof captureProcessOutput>;
const broker = await startHealthyFixtureBrokerOnPort({
  port: PORT,
  healthUrl: `${BASE}/api/health`,
  // Readiness is not one of this suite's assertions, so it gets no wall-clock
  // budget: a broker booting beside other suites is slow, not broken.
  spawn: () => {
    const child = Bun.spawn(['bun', 'packages/typescript/broker/src/main.ts'], {
      cwd: REPO,
      env: fixtureEnvironment,
      stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
    });
    brokerOutput = captureProcessOutput(child);
    return child;
  },
  capture: () => brokerOutput,
  stop: async (child) => { child.kill(); await child.exited.catch(() => undefined); },
});

let ws: WebSocket | undefined;
try {
  check('broker up', true, `:${PORT}`);

  // 2) hook hello → session adopted as a pinned, synced live connection
  const hello = await post('/claude/hook/hello', { transcriptPath, sessionUuid: 'sess-1', cwd: work, title: 'hooks test', model: 'claude-haiku-4-5', effort: 'low' });
  check('hello adopts session', hello.ok === true && hello.id === id, `id match=${hello.id === id}`);

  // 2b) HARDENING (adversarial-review fixes): reject a transcriptPath outside the projects root (traversal),
  //     and require an explicit action on the settings endpoint.
  const rawStatus = async (path: string, body: unknown) => (await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status;
  check('rejects transcriptPath outside projects root (path-traversal guard)', (await rawStatus('/claude/hook/hello', { transcriptPath: '/tmp/evil/../../etc/passwd' })) === 400);
  check('rejects /api/claude/hooks POST with no explicit action', (await rawStatus('/api/claude/hooks', {})) === 400);

  // 3) viewers=0 BEFORE any app attaches → the hook passes through to the terminal
  const noViewer = await post('/claude/hook/request', { id, requestId: 'pre', kind: 'permission', toolName: 'Bash', detail: 'echo hi', transcriptPath });
  check('viewers=0 before attach (passthrough)', noViewer.viewers === 0, JSON.stringify(noViewer));

  // 4) attach the simulated app (WebSocket) and collect frames
  const frames: any[] = [];
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/sessions/claude/${id}/stream`);
  await new Promise<void>((resolve, reject) => { ws!.onopen = () => resolve(); ws!.onerror = (e) => reject(new Error('ws error ' + String((e as any)?.message ?? e))); setTimeout(() => reject(new Error('ws open timeout')), 8000); });
  ws.onmessage = (ev) => { try { frames.push(JSON.parse(String(ev.data))); } catch { /* ignore */ } };
  await sleep(600); // let history/options frames land
  const wsMsg = (pred: (m: any) => boolean) => frames.find((f) => f.kind === 'message' && pred(f.message))?.message;
  const waitForMsg = async (pred: (m: any) => boolean, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const m = wsMsg(pred); if (m) return m; await sleep(150); } return undefined; };
  check('app attached (session synced)', frames.some((f) => f.kind === 'session' && f.info?.control?.terminalSync?.active === true), 'saw synced session frame');
  const syncedSession = frames.find((f) => f.kind === 'session' && f.info?.control?.terminalSync?.active === true)?.info;
  check(
    'hook hello model metadata seeds synced session',
    syncedSession?.currentModel?.modelID === 'claude-haiku-4-5'
      && syncedSession?.currentModel?.reasoningEffort === 'low',
    JSON.stringify(syncedSession?.currentModel ?? null),
  );

  // answer-only: a crafted NEW-PROMPT frame is rejected at the broker (cards still answerable below).
  ws.send(JSON.stringify({ kind: 'prompt', text: 'inject a new turn' }));
  await sleep(500);
  check('answer-only: broker REJECTS a new-prompt frame (no live-inject)', frames.some((f) => f.kind === 'error' && /answers prompts and questions only|terminal/i.test(String(f.message))), 'expected an error frame');

  // 5) PERMISSION: hook relays → app sees the card → app approves → hook gets allow
  const permP = hookRequest({ id, requestId: 'tu-perm', kind: 'permission', toolName: 'Bash', title: 'Run command', detail: 'echo hi', toolInput: { command: 'echo hi' }, transcriptPath });
  const toolCall = await waitForMsg((m) => m.type === 'tool-call' && m.callId === 'tu-perm');
  check('app received hook-originated tool-call before permission', !!toolCall && toolCall.toolName === 'Bash' && toolCall.args?.command === 'echo hi', JSON.stringify(toolCall ?? null));
  const permCard = await waitForMsg((m) => m.type === 'permission-request' && m.requestId === 'tu-perm');
  check('app received permission-request', !!permCard, permCard ? `title="${permCard.title}" detail="${permCard.detail}"` : 'none');
  ws.send(JSON.stringify({ kind: 'approve', requestId: 'tu-perm', decision: 'approve' }));
  const permRes = await permP;
  check('hook got permission decision=approve', permRes.resolved === true && permRes.kind === 'permission' && permRes.decision === 'approve', JSON.stringify(permRes));
  const permResolved = await waitForMsg((m) => m.type === 'permission-resolved' && m.requestId === 'tu-perm');
  check('app saw permission-resolved (card clears)', !!permResolved, JSON.stringify(permResolved ?? {}));

  // 6) QUESTION: hook relays → app sees options → app answers BRAVO → hook gets the answers array
  const qBody = { id, requestId: 'tu-q', kind: 'question', transcriptPath, questions: [{ question: 'Pick one', header: 'Pick', options: [{ label: 'ALPHA' }, { label: 'BRAVO' }], multiSelect: false }] };
  const qP = hookRequest(qBody);
  const qCard = await waitForMsg((m) => m.type === 'question-request' && m.requestId === 'tu-q');
  check('app received question-request', !!qCard && Array.isArray(qCard.questions) && qCard.questions[0]?.options?.length === 2, JSON.stringify(qCard?.questions ?? {}));
  ws.send(JSON.stringify({ kind: 'answer', requestId: 'tu-q', answers: [['BRAVO']] }));
  const qRes = await qP;
  check('hook got answer=[[BRAVO]]', qRes.resolved === true && qRes.kind === 'answer' && JSON.stringify(qRes.answers) === JSON.stringify([['BRAVO']]), JSON.stringify(qRes));

  // 7) REJECT a question → hook gets reject (→ deny in the real hook)
  const rjP = hookRequest({ id, requestId: 'tu-rj', kind: 'question', transcriptPath, questions: [{ question: 'Q', options: [{ label: 'X' }] }] });
  await waitForMsg((m) => m.type === 'question-request' && m.requestId === 'tu-rj');
  ws.send(JSON.stringify({ kind: 'reject-question', requestId: 'tu-rj' }));
  const rjRes = await rjP;
  check('hook got reject', rjRes.resolved === true && rjRes.kind === 'reject', JSON.stringify(rjRes));

  // 8) decision-before-poll race: answer arrives, THEN the hook polls → still resolved (resolved-map)
  const racePre = ws; // app answers an as-yet-unseen request id is not possible (no card), so emulate the
  // common race differently: ingest via a quick request, answer, then a late re-poll returns the stored decision.
  const raceP = hookRequest({ id, requestId: 'tu-race', kind: 'permission', toolName: 'Bash', detail: 'ls', transcriptPath });
  await waitForMsg((m) => m.type === 'permission-request' && m.requestId === 'tu-race');
  racePre.send(JSON.stringify({ kind: 'approve', requestId: 'tu-race', decision: 'approve-session' }));
  const raceRes = await raceP;
  check('approve-session maps through', raceRes.resolved === true && raceRes.decision === 'approve-session', JSON.stringify(raceRes));

  // 8b) PRODUCTION hook script end-to-end: run the REAL cosyncing-hook.ts against the broker + app and
  //     assert it emits the exact decision JSON Claude honors (validates its HTTP + mapping, no claude).
  const runProductionHook = async (stdinObj: any, broker = BASE): Promise<{ json: any; raw: string }> => {
    const proc = Bun.spawn(['bun', CLAUDE_HOOK_SCRIPT, 'request'], {
      env: { ...fixtureEnvironment, COSYNCING_BROKER: broker },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    proc.stdin!.write(JSON.stringify(stdinObj)); proc.stdin!.end();
    const raw = await new Response(proc.stdout).text();
    await proc.exited;
    let json: any = undefined; try { json = JSON.parse(raw); } catch { /* may be empty (passthrough) */ }
    return { json, raw };
  };
  const permHookP = runProductionHook({ session_id: 's', transcript_path: transcriptPath, cwd: work, permission_mode: 'default', tool_name: 'Bash', tool_use_id: 'prod-perm', tool_input: { command: 'echo hi' } });
  await waitForMsg((m) => m.type === 'permission-request' && m.requestId === 'prod-perm');
  ws.send(JSON.stringify({ kind: 'approve', requestId: 'prod-perm', decision: 'approve' }));
  const permHookOut = (await permHookP).json;
  check('production hook → allow JSON', permHookOut?.hookSpecificOutput?.permissionDecision === 'allow', JSON.stringify(permHookOut));

  const qHookP = runProductionHook({ session_id: 's', transcript_path: transcriptPath, cwd: work, permission_mode: 'default', tool_name: 'AskUserQuestion', tool_use_id: 'prod-q', tool_input: { questions: [{ question: 'Pick one', header: 'Pick', options: [{ label: 'ALPHA' }, { label: 'BRAVO' }], multiSelect: false }] } });
  await waitForMsg((m) => m.type === 'question-request' && m.requestId === 'prod-q');
  ws.send(JSON.stringify({ kind: 'answer', requestId: 'prod-q', answers: [['BRAVO']] }));
  const qHookOut = (await qHookP).json;
  const injected = qHookOut?.hookSpecificOutput?.updatedInput?.answers;
  check('production hook → answer injection (Pick one=BRAVO)', qHookOut?.hookSpecificOutput?.permissionDecision === 'allow' && injected && injected['Pick one'] === 'BRAVO', JSON.stringify(qHookOut?.hookSpecificOutput?.updatedInput ?? qHookOut));

  // 8c) fail-OPEN: with the broker UNREACHABLE the hook must emit NOTHING (exit 0 → the terminal handles
  //     it), NEVER an auto-allow. (A 'Bash' tool so it would relay if it could reach a broker.)
  const failOpen = await runProductionHook({ session_id: 's', transcript_path: transcriptPath, cwd: work, permission_mode: 'default', tool_name: 'Bash', tool_use_id: 'prod-unreach', tool_input: { command: 'echo x' } }, 'http://127.0.0.1:9');
  check('production hook fails OPEN on unreachable broker (no auto-allow)', failOpen.raw.trim() === '', `raw="${failOpen.raw.slice(0, 60)}"`);

  // 8d) bypassPermissions mode → the hook passes through immediately (never relays).
  const bypass = await runProductionHook({ session_id: 's', transcript_path: transcriptPath, cwd: work, permission_mode: 'bypassPermissions', tool_name: 'Bash', tool_use_id: 'prod-bypass', tool_input: { command: 'echo z' } });
  check('production hook respects bypassPermissions (passthrough)', bypass.raw.trim() === '', `raw="${bypass.raw.slice(0, 60)}"`);

  // 9) detach the app → viewers=0 again (non-intrusive)
  ws.close();
  await sleep(500);
  const afterDetach = await post('/claude/hook/request', { id, requestId: 'post', kind: 'permission', toolName: 'Bash', detail: 'echo x', transcriptPath });
  check('viewers=0 after detach (passthrough)', afterDetach.viewers === 0, JSON.stringify(afterDetach));

  // 10) bye tears the bridge down
  const bye = await post('/claude/hook/bye', { id, reason: 'quit' });
  check('bye ok', bye.ok === true, JSON.stringify(bye));
} catch (e) {
  check('no exception', false, String(e));
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  // Awaiting the exit is the point: signalling and returning left the broker
  // and its children alive past this process, for the lane to reap.
  try { broker.kill(); await broker.exited; } catch { /* ignore */ }
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? `❌ ${failed.length}/${results.length} FAILED` : `✅ ${results.length}/${results.length} passed`}`);
process.exit(failed.length ? 1 : 0);
