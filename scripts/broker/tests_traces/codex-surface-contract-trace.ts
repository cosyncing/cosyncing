/**
 * Codex Observe + Drive surface contract trace.
 *
 * Starts an isolated broker with a fake `codex app-server --stdio` binary and proves the
 * Codex-specific pieces of docs/architecture/client-ui.md without model cost:
 * read-only Observe, explicit Drive ownership, pending approval/question replay, app-server goal
 * history, update_plan task-list rendering, and permission-mode propagation.
 *
 * Writes trace artifacts under output/traces/<run-id>/codex/ST-27-ST-29/.
 *
 *   bun run scripts/broker/tests_traces/codex-surface-contract-trace.ts
 */
export {};
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.COSYNCING_TEST_PORT ?? 24000 + Math.floor(Math.random() * 20000));
const BROKER = `http://127.0.0.1:${PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(process.cwd(), 'output', 'traces', runId, 'codex', 'ST-27-ST-29');
const framesPath = join(outDir, 'frames.ndjson');
const fakePath = join(outDir, 'fake-codex.ndjson');
const rolloutNativePath = join(outDir, 'rollout.ndjson');
const tracePath = join(outDir, 'trace.json');
const THREAD_ID = '019ed666-0000-7000-8000-000000000027';
const TRACE_TOKEN = 'codex-surface-contract-trace-token';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`);
}

function checkCodexPlanPanel(name: string, messages: any[]): void {
  const taskList = messages.find((m: any) => m.type === 'task-list-state' && m.sourceTool === 'update_plan');
  const rawCall = messages.find((m: any) => m.type === 'tool-call' && m.toolName === 'update_plan');
  const rawResult = messages.find((m: any) => m.type === 'tool-result' && m.toolName === 'update_plan');
  check(
    name,
    !!taskList &&
      taskList.key === 'codex:plan' &&
      taskList.title === 'Plan' &&
      taskList.status === 'running' &&
      Array.isArray(taskList.items) &&
      taskList.items.length === 3 &&
      taskList.items[0]?.title === 'Inspect native Codex update_plan trace' &&
      taskList.items[0]?.status === 'done' &&
      taskList.items[1]?.title === 'Render update_plan as a bullet task list' &&
      taskList.items[1]?.status === 'in-progress' &&
      taskList.items[2]?.title === 'Suppress raw update_plan tool cards' &&
      taskList.items[2]?.status === 'open' &&
      !rawCall &&
      !rawResult,
    JSON.stringify({ taskList, rawCall, rawResult }),
  );
}

const tempRoot = mkdtempSync(join(tmpdir(), 'cosyncing-codex-surface-'));
const codexHome = join(tempRoot, 'codex-home');
const workDir = join(tempRoot, 'workspace');
const binDir = join(tempRoot, 'bin');
const fakeCodex = join(binDir, 'codex');
mkdirSync(workDir, { recursive: true });
mkdirSync(binDir, { recursive: true });
writeRollout();
writeFakeCodex();

let broker: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;

try {
  broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      CODEX_HOME: codexHome,
      COSYNCING_CODEX_BIN: fakeCodex,
      COSYNCING_CODEX_SYNC_SERVER: '0',
      COSYNCING_TOKEN: TRACE_TOKEN,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  drainBrokerOutput(broker);
  if (!(await waitHealth())) throw new Error(`broker did not start at ${BROKER}`);

  const sessionsBody = await (await fetch(`${BROKER}/api/sessions`)).json();
  const sessions = Array.isArray(sessionsBody) ? sessionsBody : sessionsBody.sessions ?? [];
  const row = sessions.find((s: any) => s.tool === 'codex' && s.cwd === workDir);
  check('Codex row is discovered from isolated rollout', !!row, JSON.stringify(sessions.filter((s: any) => s.tool === 'codex')));
  check('default Codex row is observe-first and drivable', row?.attachMode === 'observe' && row?.control?.drive?.state === 'observing', JSON.stringify(row?.control));
  check('true-sync is disabled unless sync-server mode is enabled', row?.control?.terminalSync?.supported === false && row?.control?.terminalSync?.active === false, JSON.stringify(row?.control?.terminalSync));
  check('Codex roster row exposes rollout-backed model and locked mode', row?.currentModel?.modelID === 'fake-model' && row?.currentModel?.reasoningEffort === 'low' && row?.currentMode === 'ask-permission', JSON.stringify({ model: row?.currentModel, mode: row?.currentMode }));

  const observe = await attach(row.id);
  const observeSession = await observe.waitFrame((f) => f.kind === 'session', 5000);
  const observeHistory = await observe.waitFrame((f) => f.kind === 'history', 5000);
  const observeOptions = await observe.waitFrame((f) => f.kind === 'options', 5000);
  check('Observe session frame carries locked Codex model/mode metadata', observeSession?.info?.currentModel?.modelID === 'fake-model' && observeSession?.info?.currentMode === 'ask-permission', JSON.stringify(observeSession?.info));
  check(
    'Observe options frame exposes metadata-backed locked model/mode',
    observeOptions?.models?.[0]?.providerID === 'fake-provider' &&
      observeOptions?.models?.[0]?.modelID === 'fake-model' &&
      observeOptions?.models?.[0]?.reasoningEfforts?.[0]?.effort === 'low' &&
      observeOptions?.modes?.[0]?.value === 'ask-permission' &&
      observeOptions?.modes?.[0]?.category === 'ask-permission',
    JSON.stringify(observeOptions),
  );
  const observeMessages = observeHistory?.messages ?? [];
  checkCodexPlanPanel('Observe history replays Codex update_plan as renderable task-list-state', observeMessages);
  observe.send({ kind: 'prompt', text: 'SHOULD_NOT_MUTATE_OBSERVE' });
  const observeError = await observe.waitFrame((f) => f.kind === 'error' && /read-only observe session/.test(String(f.message)), 5000);
  check('crafted prompt is rejected in Observe at broker boundary', !!observeError, String(observeError?.message ?? ''));
  observe.close();

  const drive = await attach(row.id, 'resume');
  const sessionFrame = await drive.waitFrame((f) => f.kind === 'session', 5000);
  const historyFrame = await drive.waitFrame((f) => f.kind === 'history', 5000);
  const commandsFrame = await drive.waitFrame((f) => f.kind === 'commands', 5000);
  const optionsFrame = await drive.waitFrame((f) => f.kind === 'options', 5000);
  check('Drive attach reports app-owned resume control', sessionFrame?.info?.attachMode === 'resume' && sessionFrame.info.control?.drive?.state === 'driving', JSON.stringify(sessionFrame?.info?.control));
  const historyMessages = historyFrame?.messages ?? [];
  check(
    'Drive history replays rollout plus app-server goal state',
    historyMessages.some((m: any) => m.type === 'user-message' && /surface history prompt/.test(m.text ?? '')) &&
      historyMessages.some((m: any) => m.type === 'model-output' && /surface history answer/.test(m.text ?? '')) &&
      historyMessages.some((m: any) => m.type === 'goal-state' && m.status === 'active'),
    `${historyMessages.length} messages`,
  );
  checkCodexPlanPanel('Drive history replays Codex update_plan as renderable task-list-state', historyMessages);
  check('Codex slash commands are advertised after Drive', (commandsFrame?.commands ?? []).some((c: any) => c.name === 'stop') && (commandsFrame?.commands ?? []).some((c: any) => c.name === 'compact'), JSON.stringify(commandsFrame?.commands));
  const modeCats = new Set((optionsFrame?.modes ?? []).map((m: any) => m.category));
  check('Codex permission modes expose universal categories', modeCats.has('ask-permission') && modeCats.has('approve-for-me') && modeCats.has('full-access'), JSON.stringify(optionsFrame?.modes));

  const markPrompt = drive.frames.length;
  drive.send({ kind: 'prompt', text: 'DRIVE_SURFACE_PROMPT', permissionMode: 'full-access' });
  const permission = await drive.waitFrame((f) => drive.frames.indexOf(f) >= markPrompt && f.kind === 'message' && f.message?.type === 'permission-request', 5000);
  const question = await drive.waitFrame((f) => drive.frames.indexOf(f) >= markPrompt && f.kind === 'message' && f.message?.type === 'question-request', 5000);
  check('Drive receives actionable Codex approval request', !!permission, permission?.message?.detail ?? '');
  check('Drive receives actionable Codex question request', !!question, JSON.stringify(question?.message?.questions ?? []));

  const late = await attach(row.id, 'resume');
  await late.waitFrame((f) => f.kind === 'history', 5000);
  const replayedPermission = await late.waitFrame((f) => f.kind === 'message' && f.message?.type === 'permission-request' && f.message.requestId === permission?.message?.requestId, 5000);
  const replayedQuestion = await late.waitFrame((f) => f.kind === 'message' && f.message?.type === 'question-request' && f.message.requestId === question?.message?.requestId, 5000);
  const attachWindowPermission = await late.waitFrame((f) => f.kind === 'message' && f.message?.type === 'permission-request' && f.message.requestId === 'codex:p:53:race', 5000);
  check('late Drive tab replays pending approval', !!replayedPermission, replayedPermission?.message?.requestId ?? '');
  check('late Drive tab replays pending question', !!replayedQuestion, replayedQuestion?.message?.requestId ?? '');
  await sleep(150);
  const replayedPermissionCount = late.frames.filter((f) => f.kind === 'message' && f.message?.type === 'permission-request' && f.message.requestId === permission?.message?.requestId).length;
  const replayedQuestionCount = late.frames.filter((f) => f.kind === 'message' && f.message?.type === 'question-request' && f.message.requestId === question?.message?.requestId).length;
  const attachWindowPermissionCount = late.frames.filter((f) => f.kind === 'message' && f.message?.type === 'permission-request' && f.message.requestId === 'codex:p:53:race').length;
  check('late Drive tab receives each pending card exactly once', replayedPermissionCount === 1 && replayedQuestionCount === 1, `permission=${replayedPermissionCount} question=${replayedQuestionCount}`);
  check('attach-window pending card is not double-delivered', !!attachWindowPermission && attachWindowPermissionCount === 1, `race=${attachWindowPermissionCount}`);
  late.close();

  const laterObserve = await attach(row.id);
  await laterObserve.waitFrame((f) => f.kind === 'history', 5000);
  const afterObserveSessions = await (await fetch(`${BROKER}/api/sessions`)).json();
  const afterObserveRow = (afterObserveSessions.sessions ?? []).find((s: any) => s.tool === 'codex' && s.cwd === workDir);
  check('later Observe attach does not downgrade Drive roster ownership', afterObserveRow?.control?.drive?.state === 'driving', JSON.stringify(afterObserveRow?.control));
  laterObserve.close();

  drive.send({ kind: 'approve', requestId: 'codex:p:53:race', decision: 'reject' });
  drive.send({ kind: 'approve', requestId: permission?.message?.requestId, decision: 'approve-session' });
  drive.send({ kind: 'answer', requestId: question?.message?.requestId, answers: [['Proceed']] });
  const output = await drive.waitFrame((f) => f.kind === 'message' && f.message?.type === 'model-output' && /SURFACE_DONE/.test(String(f.message.text ?? '') + String(f.message.delta ?? '')), 5000);
  const permissionResolved = await drive.waitFrame((f) => f.kind === 'message' && f.message?.type === 'permission-resolved' && f.message.requestId === permission?.message?.requestId, 5000);
  const questionResolved = await drive.waitFrame((f) => f.kind === 'message' && f.message?.type === 'question-resolved' && f.message.requestId === question?.message?.requestId, 5000);
  check('approval resolves through Codex response channel', !!permissionResolved, permissionResolved?.message?.decision ?? '');
  check('question resolves through Codex response channel', !!questionResolved, questionResolved?.message?.requestId ?? '');
  check('selected full-access mode reaches Codex turn/start', /approval=never/.test(output?.message?.text ?? output?.message?.delta ?? '') && /reviewer=user/.test(output?.message?.text ?? output?.message?.delta ?? '') && /sandbox=dangerFullAccess/.test(output?.message?.text ?? output?.message?.delta ?? ''), output?.message?.text ?? output?.message?.delta ?? '');

  const markSkill = drive.frames.length;
  drive.send({
    kind: 'command',
    name: 'trace-skill',
    args: 'use safe mode',
    permissionMode: 'ask-permission',
    model: { providerID: 'fake-provider', modelID: 'fake-model', reasoningEffort: 'low' },
  });
  const skillPermission = await drive.waitFrame((f) => drive.frames.indexOf(f) >= markSkill && f.kind === 'message' && f.message?.type === 'permission-request', 5000);
  const skillQuestion = await drive.waitFrame((f) => drive.frames.indexOf(f) >= markSkill && f.kind === 'message' && f.message?.type === 'question-request', 5000);
  drive.send({ kind: 'approve', requestId: skillPermission?.message?.requestId, decision: 'approve' });
  drive.send({ kind: 'answer', requestId: skillQuestion?.message?.requestId, answers: [['Proceed']] });
  const skillOutput = await drive.waitFrame((f) => drive.frames.indexOf(f) >= markSkill && f.kind === 'message' && f.message?.type === 'model-output' && /SURFACE_DONE/.test(String(f.message.text ?? '') + String(f.message.delta ?? '')), 5000);
  check(
    'Codex skill command carries selected permission mode and model',
    /approval=on-request/.test(skillOutput?.message?.text ?? skillOutput?.message?.delta ?? '') &&
      /reviewer=user/.test(skillOutput?.message?.text ?? skillOutput?.message?.delta ?? '') &&
      /sandbox=workspaceWrite/.test(skillOutput?.message?.text ?? skillOutput?.message?.delta ?? '') &&
      /model=fake-model/.test(skillOutput?.message?.text ?? skillOutput?.message?.delta ?? '') &&
      /effort=low/.test(skillOutput?.message?.text ?? skillOutput?.message?.delta ?? '') &&
      /skill:trace-skill/.test(skillOutput?.message?.text ?? skillOutput?.message?.delta ?? ''),
    skillOutput?.message?.text ?? skillOutput?.message?.delta ?? '',
  );
  drive.close();
} catch (err) {
  check('trace driver completed without exception', false, String(err));
} finally {
  broker?.kill();
  const failed = assertions.filter((a) => !a.ok).length;
  writeFileSync(tracePath, JSON.stringify({
    scenarioIds: ['ST-12', 'ST-13', 'ST-14', 'ST-15', 'ST-27', 'ST-29'],
    agent: 'codex',
    version: { cosyncing: 'local-source', codex: 'fake-app-server-stdio' },
    broker: BROKER,
    codexHome,
    steps: [
      'create isolated rollout-backed Codex session',
      'seed native Codex update_plan rollout data and preserve it as rollout.ndjson',
      'start broker with fake codex app-server binary',
      'prove Observe roster/session/options frames expose locked metadata-backed model and permission mode',
      'prove default attach is Observe/read-only',
      'prove Observe history exposes update_plan as one task-list-state panel, not raw tool cards',
      'prove Drive attach owns input and advertises Codex controls',
      'prove Drive history exposes update_plan as one task-list-state panel, not raw tool cards',
      'prove goal-state history snapshot from app-server',
      'prove pending approval/question replay to a late Drive tab',
      'prove attach-window pending cards are deduped against getPending replay',
      'prove full-access permission mode reaches turn/start',
      'prove prompt-like slash commands carry selected model and permission mode',
    ],
    output: { frames: framesPath, fakeCodex: fakePath, nativeRollout: rolloutNativePath },
    assertions,
    status: failed ? 'fail' : 'pass',
    skipReason: null,
  }, null, 2));
  rmSync(tempRoot, { recursive: true, force: true });
  console.log(`\ntrace: ${tracePath}`);
  console.log(`${assertions.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

function writeRollout(): void {
  const dir = join(codexHome, 'sessions', '2026', '06', '17');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-06-17T00-00-00-${THREAD_ID}.jsonl`);
  const lines = [
    { timestamp: '2026-06-17T00:00:00.000Z', type: 'session_meta', payload: { id: THREAD_ID, cwd: workDir, cli_version: 'trace', model: 'fake-model', model_provider: 'fake-provider', model_reasoning_effort: 'low' } },
    { timestamp: '2026-06-17T00:00:00.500Z', type: 'turn_context', payload: { turn_id: 'trace-turn', approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write' } } },
    { timestamp: '2026-06-17T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'surface history prompt' } },
    {
      timestamp: '2026-06-17T00:00:01.500Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'update_plan',
        call_id: 'plan-trace',
        arguments: JSON.stringify({
          explanation: 'Trace Codex task-list rendering.',
          plan: [
            { status: 'completed', step: 'Inspect native Codex update_plan trace' },
            { status: 'in_progress', step: 'Render update_plan as a bullet task list' },
            { status: 'pending', step: 'Suppress raw update_plan tool cards' },
          ],
        }),
      },
    },
    { timestamp: '2026-06-17T00:00:01.600Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'plan-trace', output: 'ok' } },
    { timestamp: '2026-06-17T00:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'surface history answer' } },
  ];
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  writeFileSync(rolloutNativePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
}

function writeFakeCodex(): void {
  writeFileSync(fakeCodex, `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const enc = new TextDecoder();
let buf = '';
let approvalResult = null;
let questionResult = null;
let lastMode = { approval: '', reviewer: '', sandbox: '', model: '', provider: '', effort: '', input: '' };
let goalGetCount = 0;
let raceApprovalSent = false;
const send = (o) => console.log(JSON.stringify(o));
const record = (o) => appendFileSync('${fakePath}', JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\\n");
function sendGoal(id) {
  send({ id, result: { goal: { threadId: '${THREAD_ID}', objective: 'Complete Codex surface trace', status: 'active', tokenBudget: 1000, tokensUsed: 12, timeUsedSeconds: 5, createdAt: 1800000000, updatedAt: 1800000005 } } });
}
function maybeFinish() {
  if (!approvalResult || !questionResult) return;
  const text = 'SURFACE_DONE approval=' + lastMode.approval + ' reviewer=' + lastMode.reviewer + ' sandbox=' + lastMode.sandbox + ' model=' + lastMode.model + ' provider=' + lastMode.provider + ' effort=' + lastMode.effort + ' input=' + lastMode.input + ' decision=' + JSON.stringify(approvalResult) + ' answer=' + JSON.stringify(questionResult);
  send({ method: 'item/agentMessage/delta', params: { threadId: '${THREAD_ID}', turnId: 'turn1', itemId: 'answer1', delta: text } });
  send({ method: 'item/completed', params: { threadId: '${THREAD_ID}', turnId: 'turn1', item: { type: 'agentMessage', id: 'answer1', text } } });
  send({ method: 'thread/goal/updated', params: { threadId: '${THREAD_ID}', turnId: 'turn1', goal: { threadId: '${THREAD_ID}', objective: 'Complete Codex surface trace', status: 'complete', tokenBudget: 1000, tokensUsed: 42, timeUsedSeconds: 65, createdAt: 1800000000, updatedAt: 1800000065 } } });
  send({ method: 'thread/goal/cleared', params: { threadId: '${THREAD_ID}' } });
  send({ method: 'turn/completed', params: { threadId: '${THREAD_ID}', turn: { id: 'turn1', status: 'completed' } } });
}
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    record({ direction: 'broker->fake', method: msg.method, id: msg.id, params: msg.params });
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') send({ id: msg.id, result: { thread: { name: 'Codex surface trace' }, model: 'fake-model', modelProvider: 'fake-provider', approvalPolicy: 'untrusted', sandbox: { type: 'workspaceWrite' }, reasoningEffort: 'low' } });
    else if (msg.method === 'thread/goal/get') {
      goalGetCount += 1;
      if (goalGetCount >= 2 && !raceApprovalSent) {
        raceApprovalSent = true;
        setTimeout(() => send({ id: 53, method: 'item/commandExecution/requestApproval', params: { threadId: '${THREAD_ID}', turnId: 'turn1', itemId: 'race', command: 'printf RACE', cwd: '${workDir}', availableDecisions: ['acceptForSession'] } }), 20);
        setTimeout(() => sendGoal(msg.id), 120);
      } else {
        sendGoal(msg.id);
      }
    }
    else if (msg.method === 'model/list') send({ id: msg.id, result: { data: [{ model: 'fake-model', providerID: 'fake-provider', displayName: 'Fake Model', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low' }], nextCursor: null } });
    else if (msg.method === 'config/read') send({ id: msg.id, result: { config: { model_provider: 'fake-provider', model: 'fake-model' }, origins: {}, layers: null } });
    else if (msg.method === 'skills/list') send({ id: msg.id, result: { data: [{ cwd: '${workDir}', skills: [{ name: 'trace-skill', path: '${workDir}/SKILL.md', enabled: true, shortDescription: 'Trace skill' }], errors: [] }] } });
    else if (msg.method === 'turn/start') {
      approvalResult = null;
      questionResult = null;
      lastMode = {
        approval: String(msg.params.approvalPolicy || ''),
        reviewer: String(msg.params.approvalsReviewer || ''),
        sandbox: String(msg.params.sandboxPolicy?.type || 'none'),
        model: String(msg.params.model || ''),
        provider: String(msg.params.modelProvider || ''),
        effort: String(msg.params.effort || ''),
        input: (msg.params.input || []).map((part) => part.type === 'skill' ? 'skill:' + part.name : (part.text || '')).join('|'),
      };
      send({ id: msg.id, result: { turn: { id: 'turn1' } } });
      send({ method: 'turn/started', params: { threadId: '${THREAD_ID}', turn: { id: 'turn1' } } });
      send({ method: 'thread/goal/updated', params: { threadId: '${THREAD_ID}', turnId: 'turn1', goal: { threadId: '${THREAD_ID}', objective: 'Complete Codex surface trace', status: 'active', tokenBudget: 1000, tokensUsed: 18, timeUsedSeconds: 8, createdAt: 1800000000, updatedAt: 1800000008 } } });
      send({ id: 51, method: 'item/commandExecution/requestApproval', params: { threadId: '${THREAD_ID}', turnId: 'turn1', itemId: 'cmd1', command: 'printf SURFACE', cwd: '${workDir}', availableDecisions: ['acceptForSession'] } });
      send({ id: 52, method: 'item/tool/requestUserInput', params: { threadId: '${THREAD_ID}', turnId: 'turn1', itemId: 'ask1', questions: [{ id: 'choice', header: 'Trace decision', question: 'Continue?', options: [{ label: 'Proceed', description: 'Continue the trace' }] }] } });
    } else if (msg.id === 51 && msg.result) {
      approvalResult = msg.result;
      maybeFinish();
    } else if (msg.id === 52 && msg.result) {
      questionResult = msg.result;
      maybeFinish();
    } else {
      send({ id: msg.id, result: {} });
    }
  }
}
`);
  chmodSync(fakeCodex, 0o755);
}

function drainBrokerOutput(proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>): void {
  void (async () => {
    for (const stream of [proc.stdout, proc.stderr]) {
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
        /* process ended */
      }
    }
  })();
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

type Attach = {
  frames: any[];
  send: (obj: unknown) => void;
  waitFrame: (pred: (frame: any) => boolean, timeoutMs: number) => Promise<any>;
  close: () => void;
};

function attach(sessionId: string, mode?: string): Promise<Attach> {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams({ token: TRACE_TOKEN, ...(mode ? { mode } : {}) });
    const ws = new WebSocket(`${WSBASE}/api/sessions/codex/${encodeURIComponent(sessionId)}/stream?${query}`);
    const frames: any[] = [];
    const out: Attach = {
      frames,
      send: (obj) => ws.send(JSON.stringify(obj)),
      waitFrame: (pred, timeoutMs) => waitFrame(frames, pred, timeoutMs),
      close: () => { try { ws.close(); } catch {} },
    };
    ws.onmessage = (e) => {
      try {
        const frame = JSON.parse(String(e.data));
        frames.push(frame);
        record(framesPath, { mode: mode ?? 'observe', frame });
      } catch {
        /* skip malformed */
      }
    };
    ws.onerror = () => reject(new Error('websocket error'));
    ws.onopen = () => resolve(out);
  });
}

async function waitFrame(frames: any[], pred: (frame: any) => boolean, timeoutMs: number): Promise<any> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const frame = frames.find(pred);
    if (frame) return frame;
    if (Date.now() > end) return undefined;
    await sleep(60);
  }
}
