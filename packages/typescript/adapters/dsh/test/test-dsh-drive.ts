/**
 * The write boundary: exactly what goes on the wire when the app drives a dsh
 * session, and what refuses rather than half-lands.
 *
 * Two things get the most attention here. First, ANSWER CORRELATION: a question
 * or approval is answered by echoing the rpcId of the frame that asked, and the
 * payload carries the resource ids the host needs — get either half wrong and
 * the answer silently settles nothing. Second, ECHO CORRELATION: dsh stamps the
 * prompt's rpcId onto the `user/message` it produces, which is the one handle
 * that lets an optimistic bubble converge instead of doubling.
 *
 * All I/O injected; no dsh process and no network.
 *
 *   bun run packages/typescript/adapters/dsh/test/test-dsh-drive.ts   (exit 0 = all pass)
 */
export {};
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PRODUCT_IDENTITY, type AgentMessage, type SessionInfo } from '@cosyncing/adapter-api';
import { DshRpcClient, type DshFetch } from '../src/server.ts';
import {
  DshDriver,
  DshDriveError,
  DSH_FILE_UNSTAGED,
  DSH_FILE_UNSUPPORTED,
  DSH_FILE_UNTRUSTED,
} from '../src/drive.ts';
import { DshSessionConnection } from '../src/observe.ts';
import { mapDshApproval, mapDshQuestion } from '../src/mapping.ts';

const FIXTURE = await Bun.file(new URL('./fixtures/dsh-0.1.0-rc.6.json', import.meta.url)).json() as {
  errorSessionNotFound: { body: { result: unknown } };
  respondBadResponse: { body: unknown };
};
const SESSION_ID = 'session-7723d8e8-cf1c-4e0a-8748-3a600aa396fc';

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

interface Sent { path: string; body: Record<string, unknown> }

/** A client whose answers are scripted per route, recording every request.
 *
 *  `onRequest` fires while the call is still in flight, which is what makes a
 *  PARKED-REQUEST test possible: it is the only moment that behaves like a
 *  generation ending under an await. */
function client(
  answers: Record<string, unknown> = {},
  options: { newRpcId?: () => string; onRequest?: (path: string) => void } = {},
): {
  rpc: DshRpcClient;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const fetchImpl: DshFetch = async (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const path = new URL(url).pathname.replace('/api/', '');
    sent.push({ path, body });
    options.onRequest?.(path);
    if (path === 'respond') {
      return { status: 200, text: async () => JSON.stringify(answers.respond ?? { accepted: true }) };
    }
    const scripted = answers[path];
    if (scripted !== undefined && (scripted as { result?: unknown }).result !== undefined) {
      return {
        status: 200,
        text: async () => JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: (scripted as { result: unknown }).result }),
      };
    }
    return {
      status: 200,
      text: async () => JSON.stringify({
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: true, value: scripted ?? { accepted: true } },
      }),
    };
  };
  return {
    rpc: new DshRpcClient({
      baseUrl: 'http://h',
      fetchImpl,
      ...(options.newRpcId ? { newRpcId: options.newRpcId } : {}),
    }),
    sent,
  };
}

// ── 1. Prompt ───────────────────────────────────────────────────────────────

{
  const { rpc, sent } = client();
  const driver = new DshDriver(rpc);
  await driver.prompt(SESSION_ID, { text: 'hello' }, { clientTimeZone: 'Europe/London' });
  const payload = sent[0]!.body.payload as Record<string, unknown>;
  check(
    'a prompt posts session.prompt with queue placement and text content',
    sent[0]!.path === 'session.prompt'
      && payload.sessionId === SESSION_ID
      && payload.mode === 'queue'
      && JSON.stringify(payload.content) === JSON.stringify([{ type: 'text', text: 'hello' }])
      && payload.clientTimeZone === 'Europe/London',
    JSON.stringify(payload),
  );

  await driver.prompt(SESSION_ID, { text: 'now' }, { mode: 'steer' });
  check(
    'steering is available as the host queue discipline it is',
    (sent[1]!.body.payload as { mode: string }).mode === 'steer',
  );
}

{
  const { rpc, sent } = client();
  const driver = new DshDriver(rpc);
  let refused: unknown;
  await driver
    .prompt(SESSION_ID, { text: 'see this', files: [{ name: 'notes.pdf', mimeType: 'application/pdf' }] })
    .catch((error: unknown) => { refused = error; });
  check(
    'a non-image file is refused outright rather than sent as text that references a file the agent never got',
    refused instanceof DshDriveError && refused.message.includes(DSH_FILE_UNSUPPORTED) && sent.length === 0,
    refused instanceof Error ? refused.message : String(refused),
  );
}

{
  const { rpc } = client({ 'session.prompt': { result: FIXTURE.errorSessionNotFound.body.result } });
  let failure: unknown;
  await new DshDriver(rpc).prompt(SESSION_ID, { text: 'x' }).catch((error: unknown) => { failure = error; });
  check(
    'a typed host refusal reaches the caller with its native code',
    failure instanceof DshDriveError && failure.code === 'session-not-found' && !failure.retryable,
    failure instanceof DshDriveError ? String(failure.code) : String(failure),
  );
}

// ── 2. Echo correlation ─────────────────────────────────────────────────────

{
  const { rpc } = client({
    'session.history': { events: [], hasMore: false },
    'session.prompt': { accepted: true },
  }, { newRpcId: () => 'minted-rpc-id' });
  const info: SessionInfo = { id: SESSION_ID, tool: 'dsh', title: 't', status: 'idle', attachMode: 'live' };
  const connection = new DshSessionConnection(info, { rpc });
  const seen: AgentMessage[] = [];
  connection.subscribe((message) => seen.push(message));
  await connection.getHistory();
  await connection.sendPrompt({ text: 'drive me', clientMessageId: 'broker-key-7' });

  connection.handleMuxFrame({
    stream: 'mux',
    rpcId: 'push-1',
    frameType: 'session/event',
    bytes: 0,
    payload: {
      type: 'session/event',
      sessionId: SESSION_ID,
      event: {
        type: 'user/message',
        seq: 50,
        time: 5,
        data: { content: [{ type: 'text', text: 'drive me' }], source: { kind: 'user', rpcId: 'minted-rpc-id' }, id: 'm50' },
        surfaceOp: 'append',
      },
    },
  });
  const echo = seen.find((message) => message.type === 'user-message') as { clientKey?: string; text: string };
  check(
    'the echo of an app-sent prompt carries the broker correlation key',
    echo?.clientKey === 'broker-key-7' && echo.text === 'drive me',
    JSON.stringify(echo),
  );

  connection.handleMuxFrame({
    stream: 'mux',
    rpcId: 'push-2',
    frameType: 'session/event',
    bytes: 0,
    payload: {
      type: 'session/event',
      sessionId: SESSION_ID,
      event: {
        type: 'user/message',
        seq: 51,
        time: 6,
        data: { content: [{ type: 'text', text: 'typed in the browser' }], source: { kind: 'user', rpcId: 'someone-elses-rpc' }, id: 'm51' },
        surfaceOp: 'append',
      },
    },
  });
  const foreign = seen.filter((message) => message.type === 'user-message')[1] as { clientKey?: string };
  check(
    'a message typed in another client is NOT claimed as this app’s echo',
    foreign.clientKey === undefined,
    JSON.stringify(foreign),
  );
}

// ── 3. Cancel, create, rename ───────────────────────────────────────────────

{
  const { rpc, sent } = client({
    'session.create': { sessionId: 'session-new', agentPreset: 'standard' },
    'session.rename': { title: 'Tidied title', seq: 3 },
  });
  const driver = new DshDriver(rpc);
  await driver.cancel(SESSION_ID);
  check(
    'cancel posts session.cancel for the one session',
    sent[0]!.path === 'session.cancel' && (sent[0]!.body.payload as { sessionId: string }).sessionId === SESSION_ID,
  );

  const created = await driver.create('workspace-1');
  check(
    'create posts a workspace-scoped session.create and returns the host id',
    sent[1]!.path === 'session.create'
      && (sent[1]!.body.payload as { workspaceId: string }).workspaceId === 'workspace-1'
      && created.sessionId === 'session-new' && created.agentPreset === 'standard',
    JSON.stringify(created),
  );

  const renamed = await driver.rename(SESSION_ID, '  Tidied title  ');
  check(
    'rename returns the title the host actually accepted, not the one we asked for',
    renamed === 'Tidied title',
    renamed,
  );
}

{
  const { rpc } = client({ 'session.create': {} });
  let failure: unknown;
  await new DshDriver(rpc).create('workspace-1').catch((error: unknown) => { failure = error; });
  check(
    'a create answering with no sessionId fails closed as drift',
    failure instanceof DshDriveError && failure.failure.kind === 'transport',
    failure instanceof Error ? failure.message : String(failure),
  );
}

// ── 4. Answers ──────────────────────────────────────────────────────────────

{
  const { rpc, sent } = client();
  const driver = new DshDriver(rpc);
  const question = mapDshQuestion('rpc-q-9', {
    sessionId: SESSION_ID,
    questions: [
      { id: 'native-a', question: 'One?', options: [{ label: 'Yes' }, { label: 'No' }] },
      { id: 'native-b', question: 'Two?', options: [{ label: 'Left' }], multiSelect: true },
    ],
  })!;
  await driver.answerQuestion(question, [['Yes'], ['Left']]);
  const body = sent[0]!.body as { type: string; rpcId: string; result: { value: { sessionId: string; answer: { answers: Array<{ id: string; selected: string[] }> } } } };
  check(
    'a question answer echoes the asking rpcId and re-attaches selections to their native ids',
    sent[0]!.path === 'respond'
      && body.type === 'client-response' && body.rpcId === 'rpc-q-9'
      && body.result.value.sessionId === SESSION_ID
      && JSON.stringify(body.result.value.answer.answers)
        === JSON.stringify([{ id: 'native-a', selected: ['Yes'] }, { id: 'native-b', selected: ['Left'] }]),
    JSON.stringify(body.result.value),
  );

  const approval = mapDshApproval('rpc-ap-9', { sessionId: SESSION_ID, approvalId: 'ap-9', toolName: 'bash' })!;
  await driver.respondApproval(approval, true);
  await driver.respondApproval(approval, false);
  const allowed = sent[1]!.body as { result: { value: { outcome: string; approvalId: string } } };
  const rejected = sent[2]!.body as { result: { value: { outcome: string } } };
  check(
    'an approval answer carries the approvalId and one of the two real outcomes',
    allowed.result.value.approvalId === 'ap-9'
      && allowed.result.value.outcome === 'allowed-once'
      && rejected.result.value.outcome === 'rejected',
    JSON.stringify([allowed.result.value, rejected.result.value]),
  );
}

{
  const { rpc } = client({
    'session.history': { events: [], hasMore: false },
    respond: { accepted: false, reason: 'not-pending' },
  });
  const info: SessionInfo = { id: SESSION_ID, tool: 'dsh', title: 't', status: 'idle', attachMode: 'live' };
  const connection = new DshSessionConnection(info, { rpc });
  const seen: AgentMessage[] = [];
  connection.subscribe((message) => seen.push(message));
  await connection.getHistory();
  connection.handleMuxFrame({
    stream: 'mux',
    rpcId: 'rpc-ap-x',
    frameType: 'approval/requested',
    bytes: 0,
    payload: { type: 'approval/requested', sessionId: SESSION_ID, approvalId: 'ap-x', toolName: 'bash' },
  });
  let threw = false;
  await connection.respondPermission('rpc-ap-x', 'approve').catch(() => { threw = true; });
  // not-pending is authoritative: another client settled the prompt, and if it
  // did so while we were disconnected the resolution frame will NEVER arrive
  // (the reconnect replay carries only still-pending prompts). The card must
  // clear now, as resolved-elsewhere, rather than wait for that frame.
  const settled = seen.find((message) => message.type === 'permission-resolved') as { requestId?: string; decision?: string } | undefined;
  check(
    'a not-pending receipt is not an error, and clears the card as settled elsewhere',
    !threw
      && !connection.pendingRpcIds().includes('rpc-ap-x')
      && settled?.requestId === 'rpc-ap-x'
      && settled?.decision === 'external',
    JSON.stringify({ pending: connection.pendingRpcIds(), settled }),
  );

  let unknownThrew = false;
  await connection.answerQuestion('never-asked', [['x']]).catch(() => { unknownThrew = true; });
  check('answering a prompt that is not pending is refused', unknownThrew);

  connection.handleMuxFrame({
    stream: 'mux',
    rpcId: 'rpc-ap-y',
    frameType: 'approval/requested',
    bytes: 0,
    payload: { type: 'approval/requested', sessionId: SESSION_ID, approvalId: 'ap-y', toolName: 'bash' },
  });
  let wrongKind = false;
  await connection.answerQuestion('rpc-ap-y', [['x']]).catch(() => { wrongKind = true; });
  check('an approval cannot be settled through the question path', wrongKind);
}

// ── 4b. Single-select answers carry at most one selected, or custom ─────────

{
  // Upstream rejects a single-select answer that carries BOTH `selected` and
  // `custom`; zero or one selected value is permitted. The encoder enforces the
  // shape at the boundary: free text wins outright, otherwise the FIRST offered
  // selection survives, deduplicated.
  const { rpc, sent } = client();
  const driver = new DshDriver(rpc);
  const question = mapDshQuestion('rpc-q-single', {
    sessionId: SESSION_ID,
    questions: [
      { id: 'one', question: 'Pick one?', options: [{ label: 'Yes' }, { label: 'No' }] },
      { id: 'many', question: 'Pick any?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true },
    ],
  })!;
  check(
    'the pending question keeps each native multiSelect flag for the answer path',
    JSON.stringify(question.multiSelect) === JSON.stringify([false, true]),
  );

  await driver.answerQuestion(question, [['Yes', 'custom words'], ['A', 'A', 'B', 'extra']]);
  const both = sent[0]!.body as {
    result: { value: { answer: { answers: Array<{ id: string; selected: string[]; custom?: string }> } } };
  };
  check(
    'a single-select answer with free text sends ONLY custom; multi-select dedupes and keeps both fields',
    JSON.stringify(both.result.value.answer.answers)
      === JSON.stringify([
        { id: 'one', selected: [], custom: 'custom words' },
        { id: 'many', selected: ['A', 'B'], custom: 'extra' },
      ]),
    JSON.stringify(both.result.value.answer.answers),
  );

  await driver.answerQuestion(question, [['Yes', 'No', 'Yes'], []]);
  const doubled = sent[1]!.body as {
    result: { value: { answer: { answers: Array<{ id: string; selected: string[]; custom?: string }> } } };
  };
  check(
    'a single-select answer with several selections keeps at most one',
    JSON.stringify(doubled.result.value.answer.answers)
      === JSON.stringify([{ id: 'one', selected: ['Yes'] }, { id: 'many', selected: [] }]),
    JSON.stringify(doubled.result.value.answer.answers),
  );
}

// ── 4c. Free-text answers and malformed-answer receipts ─────────────────────

{
  // Entries that match the question's offered labels ride `selected`; anything
  // else is the user's own text and must ride the wire's `custom` field — the
  // host validates labels STRICTLY and rejects an unoffered one outright.
  const { rpc, sent } = client();
  const driver = new DshDriver(rpc);
  const question = mapDshQuestion('rpc-q-custom', {
    sessionId: SESSION_ID,
    questions: [
      { id: 'pick', question: 'Which?', options: [{ label: 'Yes' }, { label: 'No' }] },
      { id: 'free', question: 'Anything else?', options: [{ label: 'Skip' }] },
    ],
  })!;
  await driver.answerQuestion(question, [['Yes'], ['use the blue theme']]);
  const body = sent[0]!.body as {
    result: { value: { answer: { answers: Array<{ id: string; selected: string[]; custom?: string }> } } };
  };
  check(
    'a free-text answer travels as custom, never as a label the host would reject',
    JSON.stringify(body.result.value.answer.answers)
      === JSON.stringify([
        { id: 'pick', selected: ['Yes'] },
        { id: 'free', selected: [], custom: 'use the blue theme' },
      ]),
    JSON.stringify(body.result.value.answer.answers),
  );
}

{
  // The captured receipt is a REAL `bad-response` from the live host. Unlike
  // not-pending (someone else answered — normal), bad-response means OUR answer
  // was malformed and the prompt is still pending; swallowing it would leave the
  // user staring at a card that silently ignored their click.
  const { rpc } = client({
    'session.history': { events: [], hasMore: false },
    respond: FIXTURE.respondBadResponse.body,
  });
  const info: SessionInfo = { id: SESSION_ID, tool: 'dsh', title: 't', status: 'idle', attachMode: 'live' };
  const connection = new DshSessionConnection(info, { rpc });
  await connection.getHistory();
  connection.handleMuxFrame({
    stream: 'mux',
    rpcId: 'rpc-ap-bad',
    frameType: 'approval/requested',
    bytes: 0,
    payload: { type: 'approval/requested', sessionId: SESSION_ID, approvalId: 'ap-bad', toolName: 'bash' },
  });
  connection.handleMuxFrame({
    stream: 'mux',
    rpcId: 'rpc-q-bad',
    frameType: 'question/requested',
    bytes: 0,
    payload: {
      type: 'question/requested',
      sessionId: SESSION_ID,
      questions: [{ id: 'q', question: 'Which?', options: [{ label: 'A' }] }],
    },
  });
  let approvalThrew = false;
  await connection.respondPermission('rpc-ap-bad', 'approve').catch(() => { approvalThrew = true; });
  let questionThrew = false;
  await connection.answerQuestion('rpc-q-bad', [['A']]).catch(() => { questionThrew = true; });
  check(
    'a bad-response receipt throws for both prompt kinds and keeps the card pending',
    approvalThrew && questionThrew
      && connection.pendingRpcIds().includes('rpc-ap-bad')
      && connection.pendingRpcIds().includes('rpc-q-bad'),
    JSON.stringify(connection.pendingRpcIds()),
  );
}

// ── 5. Capability absence is absence ────────────────────────────────────────

{
  const { rpc } = client();
  const info: SessionInfo = { id: SESSION_ID, tool: 'dsh', title: 't', status: 'idle', attachMode: 'live' };
  const connection = new DshSessionConnection(info, { rpc });
  const surface = connection as unknown as Record<string, unknown>;
  check(
    'seams the host genuinely lacks stay absent rather than becoming throwing stubs',
    surface.rejectQuestion === undefined
      && surface.sendFile === undefined
      && surface.setAgent === undefined
      && surface.respondPlan === undefined,
  );

  const { rpc: cancelRpc, sent } = client();
  const cancelling = new DshSessionConnection(info, { rpc: cancelRpc });
  await cancelling.runCommand('stop');
  check(
    'the interrupt is served locally through session.cancel, never as a slash line',
    sent.length === 1 && sent[0]!.path === 'session.cancel',
    JSON.stringify(sent.map((entry) => entry.path)),
  );
}

// ── 6. Models, modes, commands, images ──────────────────────────────────────
//
// The four capabilities wired against the installed host (0.1.0-rc.6), and the
// properties that make them safe rather than merely present: a selector is a
// DURABLE session change on this host, so it must be validated before it is
// sent and must never fire from a socket without live authority.

/** Script a business value whose own shape contains `result`, which the bare
 *  form of {@link client} would otherwise read as the envelope's result slot. */
function ok(value: unknown): { result: { ok: true; value: unknown } } {
  return { result: { ok: true, value } };
}

const INFO: SessionInfo = { id: SESSION_ID, tool: 'dsh', title: 't', status: 'idle', attachMode: 'live' };

const CATALOG = {
  current: { provider: 'minimax-cn', model: 'MiniMax-M3' },
  routable: true,
  groups: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        {
          id: 'deepseek-v4-flash',
          name: 'DeepSeek-V4-Flash',
          reasoning: {
            efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }],
            defaultEffort: 'high',
          },
        },
      ],
    },
    { id: 'minimax-cn', name: 'MiniMax CN', models: [{ id: 'MiniMax-M3', name: 'MiniMax-M3' }] },
  ],
  failures: [],
};

const PERMISSIONS = {
  options: [
    { value: 'read-only', name: 'read-only' },
    { value: 'workspace-write', name: 'workspace-write' },
    { value: 'danger-full-access', name: 'danger-full-access' },
  ],
  currentValue: 'workspace-write',
};

const IMAGE_LIMITS = {
  maxImageBytes: 5_242_880,
  maxImagesPerMessage: 2,
  maxMessageImageBytes: 8_000_000,
  mediaTypes: ['image/png', 'image/jpeg'],
};

/** An attached connection whose projections carry the host's published blocks. */
async function attached(
  answers: Record<string, unknown> = {},
  values: Record<string, unknown> = { permissions: PERMISSIONS, imageLimits: IMAGE_LIMITS },
  options: { mutationReady?: () => boolean; onRequest?: (path: string) => void } = {},
): Promise<{ connection: DshSessionConnection; sent: Sent[] }> {
  const { rpc, sent } = client(
    {
      'session.history': { events: [], hasMore: false, projections: { asOfSeq: 1, values } },
      ...answers,
    },
    options.onRequest ? { onRequest: options.onRequest } : {},
  );
  const connection = new DshSessionConnection(INFO, {
    rpc,
    ...(options.mutationReady ? { mutationReady: options.mutationReady } : {}),
  });
  await connection.getHistory();
  sent.length = 0; // the seed itself is not the subject of these checks
  return { connection, sent };
}

{
  const { connection } = await attached({ 'session.models': CATALOG });
  const models = await connection.listModels();
  check(
    'the model catalog flattens the host provider groups, qualifying each label with its provider',
    models.length === 2
      && models[0]!.providerID === 'deepseek-official'
      && models[0]!.modelID === 'deepseek-v4-flash'
      && models[0]!.label === 'DeepSeek-V4-Flash (DeepSeek)'
      && JSON.stringify(models[0]!.reasoningEfforts) === JSON.stringify([
        { effort: 'off', label: 'Off' },
        { effort: 'high', label: 'High' },
      ])
      && models[0]!.defaultReasoningEffort === 'high'
      && models[1]!.providerID === 'minimax-cn'
      && models[1]!.reasoningEfforts === undefined,
    JSON.stringify(models),
  );
}

{
  // `routable:false` says no adapter serves the current route, so no turn can
  // start. A picker there would promise a send that is going to fail.
  const { connection } = await attached({ 'session.models': { ...CATALOG, routable: false } });
  check('a session the host cannot route advertises no models at all', (await connection.listModels()).length === 0);
}

{
  const { connection } = await attached({
    'session.models': {
      current: { provider: 'p', model: 'm' },
      routable: true,
      groups: [
        null,
        { name: 'no id' },
        { id: 'ok', name: 'OK', models: [null, { name: 'no id' }, { id: 'good', name: 'Good' }] },
      ],
    },
  });
  const models = await connection.listModels();
  check(
    'one malformed catalog row does not cost the user every other model on the host',
    models.length === 1 && models[0]!.providerID === 'ok' && models[0]!.modelID === 'good',
    JSON.stringify(models),
  );
}

{
  // A non-boolean `routable` fails closed: it gates whether a turn can start,
  // and guessing `true` offers a composer the host will refuse.
  const { connection } = await attached({ 'session.models': { ...CATALOG, routable: 'yes' } });
  check('a non-boolean routable is not read as routable', (await connection.listModels()).length === 0);
}

{
  const { connection, sent } = await attached({ 'session.models': CATALOG });
  await connection.sendPrompt({ text: 'go', model: { providerID: 'minimax-cn', modelID: 'MiniMax-M3' } });
  check(
    'a model override matching what the session already runs costs no selection write',
    !sent.some((entry) => entry.path === 'session.selectModel')
      && sent[sent.length - 1]!.path === 'session.prompt',
    JSON.stringify(sent.map((entry) => entry.path)),
  );
}

{
  const { connection, sent } = await attached({ 'session.models': CATALOG, 'session.selectModel': { selected: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' } } });
  await connection.sendPrompt({
    text: 'go',
    model: { providerID: 'deepseek-official', modelID: 'deepseek-v4-flash', reasoningEffort: 'high' },
  });
  const select = sent.find((entry) => entry.path === 'session.selectModel');
  const order = sent.map((entry) => entry.path);
  check(
    'a changed model is selected BEFORE the prompt, in the host vocabulary',
    JSON.stringify(select?.body.payload) === JSON.stringify({
      sessionId: SESSION_ID,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
    })
      && order.indexOf('session.selectModel') < order.indexOf('session.prompt'),
    JSON.stringify(order),
  );
}

{
  // The live host answers an unknown route `model-unavailable`. The prompt must
  // NOT go out afterwards: it would run under the old model while the UI shows
  // the new one.
  const { connection, sent } = await attached({
    'session.models': CATALOG,
    'session.selectModel': { result: { ok: false, error: { code: 'model-unavailable', message: 'no adapter registered' } } },
  });
  let failure: unknown;
  await connection
    .sendPrompt({ text: 'go', model: { providerID: 'gone', modelID: 'gone' } })
    .catch((error: unknown) => { failure = error; });
  check(
    'a refused model selection surfaces its native code and suppresses the prompt',
    failure instanceof DshDriveError
      && failure.code === 'model-unavailable'
      && !sent.some((entry) => entry.path === 'session.prompt'),
    `${failure instanceof DshDriveError ? failure.code : String(failure)} / ${JSON.stringify(sent.map((e) => e.path))}`,
  );
}

{
  const { connection } = await attached();
  const modes = await connection.listModes();
  check(
    'permission modes come from the projection the connection already holds, with universal categories',
    JSON.stringify(modes) === JSON.stringify([
      { value: 'read-only', label: 'read-only', category: 'ask-permission' },
      { value: 'workspace-write', label: 'workspace-write', category: 'approve-for-me' },
      { value: 'danger-full-access', label: 'danger-full-access', category: 'full-access' },
    ]),
    JSON.stringify(modes),
  );
}

{
  const { connection, sent } = await attached({}, { imageLimits: IMAGE_LIMITS });
  const modes = await connection.listModes();
  check(
    'a deployment composing no permission service offers no modes and asks the host nothing',
    modes.length === 0 && sent.length === 0,
  );
}

{
  // An unadvertised preset is a caller bug. Composing it into a slash line
  // would hand the host free text under the guise of a picker value.
  const { connection, sent } = await attached({ 'commands/list': [{ name: 'permission', description: 'switch' }] });
  let refused: unknown;
  await connection
    .sendPrompt({ text: 'go', permissionMode: 'root-everything' })
    .catch((error: unknown) => { refused = error; });
  check(
    'a permission mode the host never advertised is refused, and nothing is sent',
    refused instanceof Error && refused.message.includes('root-everything') && sent.length === 0,
    `${refused instanceof Error ? refused.message : String(refused)} / ${JSON.stringify(sent.map((e) => e.path))}`,
  );
}

{
  const { connection, sent } = await attached({
    'commands/list': [{ name: 'permission', description: 'Switch the permission preset' }],
    'commands/execute': ok({ commandId: 'cmd-p', result: { kind: 'success' } }),
  });
  await connection.sendPrompt({ text: 'go', permissionMode: 'read-only' });
  const execute = sent.find((entry) => entry.path === 'commands/execute');
  const order = sent.map((entry) => entry.path);
  check(
    'a changed permission mode runs the host switch command before the prompt',
    JSON.stringify(execute?.body.payload) === JSON.stringify({
      args: { agentId: SESSION_ID, line: '/permission read-only' },
    })
      && order.indexOf('commands/execute') < order.indexOf('session.prompt'),
    JSON.stringify(order),
  );
}

{
  const { connection, sent } = await attached();
  await connection.sendPrompt({ text: 'go', permissionMode: 'workspace-write' });
  check(
    'a permission mode equal to the current one costs no command',
    !sent.some((entry) => entry.path === 'commands/execute')
      && sent.some((entry) => entry.path === 'session.prompt'),
    JSON.stringify(sent.map((entry) => entry.path)),
  );
}

{
  // Modes advertised with no switch registered is a real deployment shape.
  // Skipping the switch silently would run the turn under the wrong policy.
  const { connection, sent } = await attached({ 'commands/list': [{ name: 'compact', description: 'c' }] });
  let refused: unknown;
  await connection
    .sendPrompt({ text: 'go', permissionMode: 'read-only' })
    .catch((error: unknown) => { refused = error; });
  check(
    'advertised modes with no switch command refuse the send rather than running under the old policy',
    refused instanceof Error && !sent.some((entry) => entry.path === 'session.prompt'),
    `${refused instanceof Error ? refused.message : String(refused)} / ${JSON.stringify(sent.map((e) => e.path))}`,
  );
}

{
  const { connection } = await attached({
    'commands/list': [
      { name: 'compact', description: 'Compact older conversation history' },
      { name: 'stop', description: 'a host command shadowing the local interrupt' },
      { name: '', description: 'nameless' },
      null,
    ],
  });
  const commands = await connection.listCommands();
  check(
    'the roster is the host registry plus the local interrupt, with collisions and junk dropped',
    JSON.stringify(commands) === JSON.stringify([
      { name: 'stop', description: 'Stop the running turn', kind: 'action' },
      { name: 'compact', description: 'Compact older conversation history', kind: 'action' },
    ]),
    JSON.stringify(commands),
  );
}

{
  // Losing the ability to stop a running turn because a roster lookup failed
  // would be strictly worse than a short list.
  const { connection } = await attached({ 'commands/list': { not: 'an array' } });
  const commands = await connection.listCommands();
  check(
    'a malformed roster still leaves the interrupt reachable',
    commands.length === 1 && commands[0]!.name === 'stop',
    JSON.stringify(commands),
  );
}

{
  const { connection, sent } = await attached({ 'commands/list': [{ name: 'compact', description: 'c' }] });
  let refused: unknown;
  await connection.runCommand('rm-rf').catch((error: unknown) => { refused = error; });
  check(
    'a name the live roster does not carry never becomes a slash line',
    refused instanceof Error && !sent.some((entry) => entry.path === 'commands/execute'),
    `${refused instanceof Error ? refused.message : String(refused)} / ${JSON.stringify(sent.map((e) => e.path))}`,
  );
}

{
  const { connection, sent } = await attached({
    'commands/list': [{ name: 'goal', description: 'set or view the goal' }],
    'commands/execute': ok({ commandId: 'cmd-1', result: { kind: 'success', text: 'Goal set' } }),
  });
  const result = await connection.runCommand('goal', '  ship it  ');
  const executes = sent.filter((entry) => entry.path === 'commands/execute');
  check(
    'a command executes exactly once, with the argument text on the advertised name',
    executes.length === 1
      && JSON.stringify(executes[0]!.body.payload) === JSON.stringify({
        args: { agentId: SESSION_ID, line: '/goal ship it' },
      })
      && JSON.stringify(result) === JSON.stringify({ notice: 'Goal set' }),
    `${executes.length} / ${JSON.stringify(result)}`,
  );
}

{
  // The host mints a commandId and appends lifecycle records the moment it
  // accepts the line, so a failure after that point is indistinguishable from
  // one before it. Retrying could compact a session twice.
  const { connection, sent } = await attached({
    'commands/list': [{ name: 'compact', description: 'c' }],
    'commands/execute': { result: { ok: false, error: { code: 'internal', message: 'boom' } } },
  });
  await connection.runCommand('compact').catch(() => {});
  check(
    'a failed execution is never retried',
    sent.filter((entry) => entry.path === 'commands/execute').length === 1,
    JSON.stringify(sent.map((entry) => entry.path)),
  );
}

{
  const { connection } = await attached({
    'commands/list': [{ name: 'export', description: 'e' }],
    'commands/execute': ok({ commandId: 'cmd-2', result: { kind: 'error', text: 'nothing to export' } }),
  });
  let failure: unknown;
  await connection.runCommand('export').catch((error: unknown) => { failure = error; });
  check(
    'a command the host rejects surfaces as a failure, not as a success notice',
    failure instanceof Error && failure.message.includes('nothing to export'),
    failure instanceof Error ? failure.message : String(failure),
  );
}

{
  const { rpc, sent } = client();
  const driver = new DshDriver(rpc);
  await driver.prompt(
    SESSION_ID,
    { text: 'look', images: [{ data: 'aGVsbG8=', mimeType: 'image/PNG', name: 'shot.png' }] },
    { imageLimits: IMAGE_LIMITS },
  );
  const content = (sent[0]!.body.payload as { content: unknown[] }).content;
  check(
    'an image rides the prompt as a host content part, after the text, with a normalized media type',
    JSON.stringify(content) === JSON.stringify([
      { type: 'text', text: 'look' },
      { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=', name: 'shot.png' },
    ]),
    JSON.stringify(content),
  );
}

for (const [name, images, needle] of [
  ['count', [1, 2, 3].map(() => ({ data: 'aGk=', mimeType: 'image/png' })), 'at most 2 images'],
  ['type', [{ data: 'aGk=', mimeType: 'image/tiff' }], 'does not accept image/tiff'],
  ['size', [{ data: 'a'.repeat(8_000_000), mimeType: 'image/png', name: 'big.png' }], 'larger than'],
] as const) {
  const { rpc, sent } = client();
  let refused: unknown;
  await new DshDriver(rpc)
    .prompt(SESSION_ID, { text: 'x', images: [...images] }, { imageLimits: IMAGE_LIMITS })
    .catch((error: unknown) => { refused = error; });
  check(
    `an image breaching the host ${name} limit fails the prompt before any upload, quoting the host's own bound`,
    refused instanceof DshDriveError && refused.message.includes(needle) && sent.length === 0,
    refused instanceof Error ? refused.message : String(refused),
  );
}

{
  // No attachment service composed: the host documents that case as "skip the
  // pre-check and let the host answer", so an absent policy must not invent one.
  const { rpc, sent } = client();
  await new DshDriver(rpc).prompt(SESSION_ID, {
    text: 'x',
    images: [{ data: 'aGk=', mimeType: 'image/tiff' }],
  });
  check('an absent intake policy admits the prompt instead of inventing a bound', sent.length === 1);
}

// The app has ONE attachment affordance and it stages everything as a file, so
// these are the checks that decide whether the host's image intake is reachable
// from the product at all — and whether reaching it can be abused into reading
// a file the user never attached.

{
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-attach-'));
  const inbox = join(workspace, PRODUCT_IDENTITY.repositoryDirectoryName, 'inbox');
  mkdirSync(inbox, { recursive: true });
  const staged = join(inbox, 'shot.png');
  writeFileSync(staged, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const { rpc, sent } = client();
  await new DshDriver(rpc).prompt(
    SESSION_ID,
    { text: 'look', files: [{ name: 'shot.png', mimeType: 'image/png', brokerPath: staged }] },
    { imageLimits: IMAGE_LIMITS, sessionCwd: workspace },
  );
  const content = (sent[0]!.body.payload as { content: unknown[] }).content;
  check(
    'a staged image is read from the inbox and inlined, so the app’s one attach control reaches the host',
    JSON.stringify(content) === JSON.stringify([
      { type: 'text', text: 'look' },
      { type: 'image', mediaType: 'image/png', data: 'iVBORw==', name: 'shot.png' },
    ]),
    JSON.stringify(content),
  );

  // The containment check is the reason a client-supplied path can never be
  // opened. `dirname` must equal the inbox exactly, so a resolved `..` — which
  // lands anywhere else on the disk — is refused before any read.
  const outside = join(workspace, 'secret.png');
  writeFileSync(outside, Buffer.from([1, 2, 3]));
  for (const [name, brokerPath] of [
    ['a traversal out of the inbox', join(inbox, '..', 'secret.png')],
    ['an absolute path elsewhere', outside],
    ['a nested path under the inbox', join(inbox, 'nested', 'x.png')],
  ] as const) {
    const { rpc: r, sent: s } = client();
    let refused: unknown;
    await new DshDriver(r)
      .prompt(
        SESSION_ID,
        { text: 'x', files: [{ name: 'x.png', mimeType: 'image/png', brokerPath }] },
        { imageLimits: IMAGE_LIMITS, sessionCwd: workspace },
      )
      .catch((error: unknown) => { refused = error; });
    check(
      `${name} is refused before any byte is read`,
      refused instanceof DshDriveError && refused.message.includes(DSH_FILE_UNTRUSTED) && s.length === 0,
      refused instanceof Error ? refused.message : String(refused),
    );
  }

  {
    const { rpc: r, sent: s } = client();
    let refused: unknown;
    await new DshDriver(r)
      .prompt(
        SESSION_ID,
        { text: 'x', files: [{ name: 'x.png', mimeType: 'image/png' }] },
        { imageLimits: IMAGE_LIMITS, sessionCwd: workspace },
      )
      .catch((error: unknown) => { refused = error; });
    check(
      'an attachment that never went through staging is refused',
      refused instanceof DshDriveError && refused.message.includes(DSH_FILE_UNSTAGED) && s.length === 0,
      refused instanceof Error ? refused.message : String(refused),
    );
  }

  // A symlink is refused by the OPEN, not by a check that precedes it: the
  // leaf is opened with O_NOFOLLOW, so a link swapped in after any check would
  // still fail. Both directions are refused — the broker writes real files into
  // the inbox and never a link, so there is no legitimate case to preserve, and
  // "points somewhere allowed" is not a judgement worth making at all.
  for (const [name, target] of [
    ['out of the inbox', outside],
    ['at another file inside the inbox', staged],
  ] as const) {
    const link = join(inbox, `link-${name.replace(/\W+/g, '-')}.png`);
    symlinkSync(target, link);
    const { rpc: r, sent: s } = client();
    let refused: unknown;
    await new DshDriver(r)
      .prompt(
        SESSION_ID,
        { text: 'x', files: [{ name: 'x.png', mimeType: 'image/png', brokerPath: link }] },
        { imageLimits: IMAGE_LIMITS, sessionCwd: workspace },
      )
      .catch((error: unknown) => { refused = error; });
    check(
      `a symlink in the inbox pointing ${name} is refused, and nothing is read through it`,
      refused instanceof DshDriveError && refused.message.includes(DSH_FILE_UNTRUSTED) && s.length === 0,
      refused instanceof Error ? refused.message : String(refused),
    );
  }

  {
    // A type the host will not take is refused on the TYPE, before the path is
    // even considered — so the message names the real problem.
    const { rpc: r, sent: s } = client();
    let refused: unknown;
    await new DshDriver(r)
      .prompt(
        SESSION_ID,
        { text: 'x', files: [{ name: 'notes.pdf', mimeType: 'application/pdf', brokerPath: staged }] },
        { imageLimits: IMAGE_LIMITS, sessionCwd: workspace },
      )
      .catch((error: unknown) => { refused = error; });
    check(
      'a non-image staged file is refused on its type, not on its path',
      refused instanceof DshDriveError && refused.message.includes(DSH_FILE_UNSUPPORTED) && s.length === 0,
      refused instanceof Error ? refused.message : String(refused),
    );
  }

  rmSync(workspace, { recursive: true, force: true });
}

{
  const { rpc, sent } = client();
  const driver = new DshDriver(rpc);
  await driver.prompt(
    SESSION_ID,
    { text: 'x', images: [{ data: 'aGk=', mimeType: 'image/png', name: '../../escape.png' }] },
    { imageLimits: IMAGE_LIMITS },
  );
  const part = ((sent[0]!.body.payload as { content: Record<string, unknown>[] }).content)[1]!;
  check(
    'an image part carries only bytes, a media type, and a display name — never a path field',
    JSON.stringify(Object.keys(part).sort()) === JSON.stringify(['data', 'mediaType', 'name', 'type']),
    JSON.stringify(Object.keys(part)),
  );
}

// ── 7. Live authority ───────────────────────────────────────────────────────
//
// Every new selector is a WRITE on this host. A socket without live authority,
// a generation that has been replaced, and a session the host removed must all
// perform zero HTTP writes — proven by counting requests, not by reading code.

{
  const { connection, sent } = await attached(
    { 'session.models': CATALOG, 'commands/list': [{ name: 'permission', description: 'p' }] },
    { permissions: PERMISSIONS, imageLimits: IMAGE_LIMITS },
    { mutationReady: () => false },
  );
  const refusals: string[] = [];
  const record = (error: unknown) => { refusals.push(error instanceof Error ? error.message : String(error)); };
  await connection.sendPrompt({ text: 'x' }).catch(record);
  await connection.sendPrompt({ text: 'x', model: { providerID: 'deepseek-official', modelID: 'deepseek-v4-flash' } }).catch(record);
  await connection.sendPrompt({ text: 'x', permissionMode: 'read-only' }).catch(record);
  await connection.runCommand('stop').catch(record);
  await connection.runCommand('permission', 'read-only').catch(record);
  check(
    'a stale generation performs zero HTTP writes across every mutating surface',
    refusals.length === 5
      && refusals.every((message) => message.includes('re-verifying'))
      && sent.length === 0,
    `${refusals.length} refusals / ${JSON.stringify(sent.map((entry) => entry.path))}`,
  );
}

{
  const { connection, sent } = await attached({ 'session.models': CATALOG });
  (connection as unknown as { removed: boolean }).removed = true;
  const refusals: string[] = [];
  const record = (error: unknown) => { refusals.push(error instanceof Error ? error.message : String(error)); };
  await connection.sendPrompt({ text: 'x', model: { providerID: 'deepseek-official', modelID: 'deepseek-v4-flash' } }).catch(record);
  await connection.sendPrompt({ text: 'x', permissionMode: 'read-only' }).catch(record);
  await connection.runCommand('permission', 'read-only').catch(record);
  check(
    'a session the host removed performs zero HTTP writes, selectors included',
    refusals.length === 3
      && refusals.every((message) => message.includes('removed from the DeepSeek Harness host'))
      && sent.length === 0,
    `${refusals.length} refusals / ${JSON.stringify(sent.map((entry) => entry.path))}`,
  );
}

{
  // Reads stay reachable while mutation is gated: a picker that blanks itself
  // during a re-verify would look like a host with no models.
  const { connection, sent } = await attached(
    { 'session.models': CATALOG },
    { permissions: PERMISSIONS, imageLimits: IMAGE_LIMITS },
    { mutationReady: () => false },
  );
  const models = await connection.listModels();
  const modes = await connection.listModes();
  check(
    'discovery still answers while mutation is gated, and writes nothing',
    models.length === 2
      && modes.length === 3
      && sent.every((entry) => entry.path === 'session.models'),
    JSON.stringify(sent.map((entry) => entry.path)),
  );
}

// ── 8. Authority lost under an await ────────────────────────────────────────
//
// A guard taken BEFORE a wait proves nothing about the moment after it. Every
// selector on this adapter reads first and writes second, so each one parks a
// request in between — and a generation can end while it is parked. These flip
// `mutationReady` DURING the read and assert the write that would have followed
// never goes out.
//
// The reads themselves are allowed to complete; it is only the write that must
// notice. Each case therefore asserts on the route that comes AFTER the flip.

for (const [name, parkOn, forbidden] of [
  ['the model catalog', 'session.models', 'session.selectModel'],
  ['the model selection itself', 'session.selectModel', 'session.prompt'],
] as const) {
  let ready = true;
  const { connection, sent } = await attached(
    {
      'session.models': CATALOG,
      'session.selectModel': { selected: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
    },
    { permissions: PERMISSIONS, imageLimits: IMAGE_LIMITS },
    { mutationReady: () => ready, onRequest: (path) => { if (path === parkOn) ready = false; } },
  );
  let refused: unknown;
  await connection
    .sendPrompt({ text: 'go', model: { providerID: 'deepseek-official', modelID: 'deepseek-v4-flash' } })
    .catch((error: unknown) => { refused = error; });
  const paths = sent.map((entry) => entry.path);
  check(
    `a generation lost during ${name} stops the send before ${forbidden}`,
    refused instanceof Error
      && refused.message.includes('re-verifying')
      && !paths.includes(forbidden),
    `${refused instanceof Error ? refused.message : String(refused)} / ${JSON.stringify(paths)}`,
  );
}

for (const [name, parkOn, forbidden] of [
  ['command discovery', 'commands/list', 'commands/execute'],
  ['the permission switch itself', 'commands/execute', 'session.prompt'],
] as const) {
  let ready = true;
  const { connection, sent } = await attached(
    {
      'commands/list': [{ name: 'permission', description: 'Switch the permission preset' }],
      'commands/execute': ok({ commandId: 'cmd-x', result: { kind: 'success' } }),
    },
    { permissions: PERMISSIONS, imageLimits: IMAGE_LIMITS },
    { mutationReady: () => ready, onRequest: (path) => { if (path === parkOn) ready = false; } },
  );
  let refused: unknown;
  await connection
    .sendPrompt({ text: 'go', permissionMode: 'read-only' })
    .catch((error: unknown) => { refused = error; });
  const paths = sent.map((entry) => entry.path);
  check(
    `a generation lost during ${name} stops the send before ${forbidden}`,
    refused instanceof Error
      && refused.message.includes('re-verifying')
      && !paths.includes(forbidden),
    `${refused instanceof Error ? refused.message : String(refused)} / ${JSON.stringify(paths)}`,
  );
}

{
  // The same hazard on the command path: the roster read is awaited, so the
  // execution it authorizes needs its own guard.
  let ready = true;
  const { connection, sent } = await attached(
    {
      'commands/list': [{ name: 'compact', description: 'c' }],
      'commands/execute': ok({ commandId: 'cmd-y', result: { kind: 'success' } }),
    },
    { permissions: PERMISSIONS, imageLimits: IMAGE_LIMITS },
    { mutationReady: () => ready, onRequest: (path) => { if (path === 'commands/list') ready = false; } },
  );
  let refused: unknown;
  await connection.runCommand('compact').catch((error: unknown) => { refused = error; });
  check(
    'a generation lost during a runCommand roster read stops the execution',
    refused instanceof Error
      && refused.message.includes('re-verifying')
      && !sent.some((entry) => entry.path === 'commands/execute'),
    `${refused instanceof Error ? refused.message : String(refused)} / ${JSON.stringify(sent.map((e) => e.path))}`,
  );
}

{
  // The unchanged-selector path must ALSO re-guard: it skips the write but
  // still awaited the catalog, and the prompt after it is a write.
  let ready = true;
  const { connection, sent } = await attached(
    { 'session.models': CATALOG },
    { permissions: PERMISSIONS, imageLimits: IMAGE_LIMITS },
    { mutationReady: () => ready, onRequest: (path) => { if (path === 'session.models') ready = false; } },
  );
  let refused: unknown;
  await connection
    .sendPrompt({ text: 'go', model: { providerID: 'minimax-cn', modelID: 'MiniMax-M3' } })
    .catch((error: unknown) => { refused = error; });
  check(
    'a generation lost during a NO-OP model check still stops the prompt',
    refused instanceof Error && !sent.some((entry) => entry.path === 'session.prompt'),
    `${refused instanceof Error ? refused.message : String(refused)} / ${JSON.stringify(sent.map((e) => e.path))}`,
  );
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
