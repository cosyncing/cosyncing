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
import type { AgentMessage, SessionInfo } from '@cosyncing/adapter-api';
import { DshRpcClient, type DshFetch } from '../src/server.ts';
import { DshDriver, DshDriveError, DSH_ATTACHMENT_UNSUPPORTED } from '../src/drive.ts';
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

/** A client whose answers are scripted per route, recording every request. */
function client(answers: Record<string, unknown> = {}, options: { newRpcId?: () => string } = {}): {
  rpc: DshRpcClient;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const fetchImpl: DshFetch = async (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const path = new URL(url).pathname.replace('/api/', '');
    sent.push({ path, body });
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
    .prompt(SESSION_ID, { text: 'see this', files: [{ name: 'a.png', mimeType: 'image/png' }] })
    .catch((error: unknown) => { refused = error; });
  check(
    'an attachment is refused outright rather than sent as text that references a file the agent never got',
    refused instanceof DshDriveError && refused.message.includes(DSH_ATTACHMENT_UNSUPPORTED) && sent.length === 0,
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
    'unimplemented seams are absent rather than throwing stubs, so the broker never offers them',
    surface.rejectQuestion === undefined
      && surface.sendFile === undefined
      && surface.listModels === undefined
      && surface.setAgent === undefined
      && surface.respondPlan === undefined,
  );

  const { rpc: cancelRpc, sent } = client();
  const cancelling = new DshSessionConnection(info, { rpc: cancelRpc });
  const commands = await cancelling.listCommands();
  await cancelling.runCommand('stop');
  let unknownCommand = false;
  await cancelling.runCommand('compact').catch(() => { unknownCommand = true; });
  check(
    'the only advertised command is the interrupt the host actually implements',
    JSON.stringify(commands) === JSON.stringify([{ name: 'stop', description: 'Stop the running turn', kind: 'action' }])
      && sent[0]!.path === 'session.cancel'
      && unknownCommand,
    JSON.stringify(commands),
  );
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
