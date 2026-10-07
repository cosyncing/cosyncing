/**
 * What a capture is allowed to claim about a model turn.
 *
 * The property that matters is honesty of provenance, not model behaviour: a run
 * that only created a session must not say it was model-backed, a run whose turn
 * stalled on an approval must say where it stalled, and the only thing that earns
 * the claim is assistant content that came back through the followed stream.
 * None of this needs a model call to test.
 *
 *   bun run scripts/adapters/tests/test-dsh-capture-prompt.ts
 */
export {};
import {
  answerApprovalWaterfall, decodeTurnEndReason, emptyPromptEvidence, eventsResultBody, modelBackedVerdict,
  observePromptFrame, observePromptReceipt, promptRequest,
} from '../dsh-capture-prompt.ts';

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * The frames below are built in the grammar the pinned host actually writes.
 *
 * `SessionFollowFrame` is a union of a snapshot, a wrapped durable event and a
 * process-local assistant frame, and the event stream uses the same `event`
 * WORD for a different thing: a string name on a waterfall, an envelope on the
 * follow stream. A test that hands the classifier `{role, content}` — the shape
 * no stream emits — proves the classifier agrees with itself, which is worth
 * nothing, so every case here is nested the way `dsh-session` nests it.
 */
const frame = (streamId: string, value: Record<string, unknown>) => ({ streamId, value });
const fold = (
  frames: Array<{ streamId: string; value: Record<string, unknown> }>,
  from = emptyPromptEvidence(),
) => frames.reduce((acc, f) => observePromptFrame(acc, f), from);
// A stall is only a stall if the turn actually started, so the stalled and
// earned cases all begin from a host that accepted the prompt.
const acceptedTurn = observePromptReceipt(emptyPromptEvidence(), { result: { ok: true, value: { accepted: true } } });

/** One durable session event, wrapped the way the follow stream wraps it. */
const sessionEvent = (name: string, data: unknown): Record<string, unknown> => ({
  type: 'event',
  event: { type: name, seq: 1, time: 1_700_000_000_000, data },
});
const text = (value: string) => [{ type: 'text', text: value }];
const userMessage = (value: string) => sessionEvent('user/message', { role: 'user', content: text(value), source: { kind: 'user' } });
const assistantMessage = (value: string) => sessionEvent('assistant/message', {
  turn: 1, step: 1, message: { role: 'assistant', content: text(value), source: { kind: 'model', provider: 'fixture', model: 'm' } }, stream: [],
});
// The host writes `reason` as the TurnEndReason sum, keyed by kind; a bare string
// is not something this stream can carry.
const turnEnd = (reason: Record<string, unknown> = { kind: 'completed' }) => sessionEvent('turn/end', { turn: 1, reason });
const textDelta = (value: string) => ({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: value } } });
const READY_FRAME = frame('cap-events', { type: 'ready', clientId: 'client-1', host: { home: '/fixture/home' } });

// The shape the host's descriptor asks for, pinned.
const request = promptRequest({ sessionId: 'session-fixture-001', text: 'say hi', approval: 'allow-once', timeoutMs: 1_000 });
const inner = request['request'] as Record<string, unknown>;
check('the prompt payload matches the descriptor: request.requestId/sessionId/mode/content',
  typeof inner['requestId'] === 'string' && inner['sessionId'] === 'session-fixture-001'
    && inner['mode'] === 'queue'
    && JSON.stringify(inner['content']) === JSON.stringify([{ type: 'text', text: 'say hi' }]),
  JSON.stringify(request));

// 1. Nothing attempted. This is every run before --prompt exists.
const nothing = modelBackedVerdict(emptyPromptEvidence(), false);
check('a run that never prompted is not model-backed and says why',
  nothing.modelBacked === false && nothing.attempted === false
    && nothing.reason === 'no prompt scenario was requested',
  JSON.stringify(nothing));

// 2. Credentials alone prove nothing: the flag was asked for, the host refused.
const refused = observePromptReceipt(emptyPromptEvidence(), { type: 'server-response', result: { ok: false, error: { code: 'x', message: 'no provider' } } });
const refusedVerdict = modelBackedVerdict(refused, true);
check('a prompt the host did not accept is not model-backed',
  refused.promptAccepted === false && refusedVerdict.modelBacked === false
    && refusedVerdict.stalledOn === 'prompt-not-accepted',
  JSON.stringify(refusedVerdict));
check('the acceptance proof is the host value, not the HTTP status',
  modelBackedVerdict(observePromptReceipt(emptyPromptEvidence(), { result: { ok: true } }), true).modelBacked === false);

// 3. Accepted but silent.
check('an accepted prompt with no reply is not model-backed',
  modelBackedVerdict(acceptedTurn, true).modelBacked === false
    && modelBackedVerdict(acceptedTurn, true).stalledOn === 'no-assistant-output',
  JSON.stringify(modelBackedVerdict(acceptedTurn, true)));

const stalled = fold([
  READY_FRAME,
  frame('cap-events', { type: 'waterfall', event: 'approval/request', eventId: 'evt-a1', agentId: 'session-fixture-001', request: {} }),
  frame('cap-follow', { type: 'end' }),
], acceptedTurn);
const stalledVerdict = modelBackedVerdict(stalled, true);
check('a turn that died on an unanswered approval names the approval',
  stalled.approvalsRequested === 1 && stalled.approvalEventIds.join(',') === 'evt-a1'
    && stalledVerdict.modelBacked === false && stalledVerdict.stalledOn === 'approval',
  JSON.stringify({ stalled: stalledVerdict, ids: stalled.approvalEventIds }));

// The host's own name for it, taken from the pinned remote event table. A
// classifier that guesses `userQuestions` reports a waiting question as silence.
const questioned = fold([
  frame('cap-events', { type: 'waterfall', event: 'user-questions/request', eventId: 'evt-q1', agentId: 'session-fixture-001', request: {} }),
], acceptedTurn);
check('a turn waiting on a user question says so instead of claiming silence',
  questioned.questionsRequested === 1 && modelBackedVerdict(questioned, true).stalledOn === 'user-question',
  JSON.stringify(questioned));

// 4. The turn that earns the claim, in the grammar the stream writes.
const good = fold([
  READY_FRAME,
  { streamId: 'cap-follow', value: {
    type: 'snapshot', header: { version: 1, id: 'session-fixture-001', createdAt: 1, isSeeded: false },
    cursor: 7, hasMore: false, projections: {},
    records: [userMessage('an earlier exchange'), assistantMessage('an earlier reply')],
  } },
  frame('cap-follow', userMessage('say hi')),
  frame('cap-follow', textDelta('he')),
  frame('cap-follow', { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a1', revision: 1, index: 1, time: 2, chunk: { type: 'reasoning-delta', index: 0, text: 'thoughts' } } }),
  frame('cap-follow', assistantMessage('llo')),
  frame('cap-follow', sessionEvent('tool/call', { turn: 1, step: 1, callId: 'c1', toolName: 'bash', args: {} })),
  frame('cap-events', { type: 'waterfall', event: 'approval/request', eventId: 'evt-a2', agentId: 'session-fixture-001', request: {} }),
  frame('cap-follow', sessionEvent('approval/decided', { id: 'r1', toolName: 'bash', outcome: 'allowed-once' })),
  frame('cap-follow', turnEnd()),
], acceptedTurn);
const goodVerdict = modelBackedVerdict(good, true);
check('native durable assistant content through the followed stream earns the claim',
  good.userMessageEchoed && good.assistantChunks === 1 && good.assistantTextBytes === 3
    && good.toolEvents === 1 && good.approvalsRequested === 1 && good.approvalsAnswered === 1
    && good.turnEnded?.reason === 'completed' && goodVerdict.modelBacked === true && goodVerdict.stalledOn === null,
  JSON.stringify({ verdict: goodVerdict, evidence: good }));
check('the opening snapshot is history and is never credited to this turn',
  good.historyRecords === 2 && good.assistantTextBytes === 3 && good.userMessageEchoed === true,
  JSON.stringify({ history: good.historyRecords, bytes: good.assistantTextBytes }));
check('streaming text is kept apart from the committed message',
  good.streamedChunks === 1 && good.streamedTextBytes === 2 && good.streamedVisibleBytes === 2
    && good.assistantVisibleBytes === 3,
  JSON.stringify({ streamed: good.streamedTextBytes, committed: good.assistantVisibleBytes }));
check('reasoning is not counted as something the model said out loud',
  good.streamedTextBytes === 2, JSON.stringify(good.streamedTextBytes));

// 5. An approval still open outranks the text the turn did produce.
const preamble = fold([
  READY_FRAME,
  frame('cap-follow', assistantMessage('let me check that for you')),
  frame('cap-events', { type: 'waterfall', event: 'approval/request', eventId: 'evt-a3', agentId: 'session-fixture-001', request: {} }),
], acceptedTurn);
const preambleVerdict = modelBackedVerdict(preamble, true);
check('a visible preamble with an unanswered approval is a stall, not a model-backed turn',
  preamble.assistantVisibleBytes > 0 && preambleVerdict.modelBacked === false
    && preambleVerdict.stalledOn === 'approval',
  JSON.stringify(preambleVerdict));

// 6. Content that is not the assistant\u2019s does not count as the assistant\u2019s.
const notAssistant = fold([
  frame('cap-follow', userMessage('a prompt the user typed')),
  frame('cap-follow', sessionEvent('developer/message', { turn: 1, step: 1, message: { role: 'developer', content: text('injected context') } })),
  frame('cap-follow', sessionEvent('system/message', { turn: 1, step: 1, message: { role: 'system', content: text('the rendered prompt') } })),
  frame('cap-follow', assistantMessage('   ')),
], acceptedTurn);
check('user, developer and system text never count as assistant output',
  notAssistant.assistantChunks === 1 && notAssistant.userMessageEchoed === true
    && notAssistant.assistantVisibleBytes === 0,
  JSON.stringify(notAssistant));
check('whitespace-only assistant text streams but earns nothing',
  notAssistant.assistantTextBytes === 3 && notAssistant.assistantVisibleBytes === 0
    && modelBackedVerdict(notAssistant, true).modelBacked === false,
  JSON.stringify(modelBackedVerdict(notAssistant, true)));

// 7. Terminal frames and the event generation.
const ended = fold([
  frame('cap-events', { type: 'ready', clientId: 'client-9' }),
  frame('cap-follow', assistantMessage('partial')),
  frame('cap-follow', { type: 'error', error: { code: 'remote/stream-failed', message: 'gone', details: {} } }),
  frame('cap-follow', { type: 'end' }),
], acceptedTurn);
check('the first terminal frame wins and the ready clientId is recorded',
  ended.streamEnded === 'error' && ended.sawReady && ended.readyClientId === 'client-9'
    && ended.assistantTextBytes === 7,
  JSON.stringify(ended));

// 8. A turn that ended without saying anything is its own answer, not a timeout.
const silentTurn = fold([
  READY_FRAME,
  frame('cap-follow', turnEnd({ kind: 'max-tokens' })),
], acceptedTurn);
check('a turn/end with no assistant text is reported as ended rather than as waiting',
  silentTurn.turnEnded?.reason === 'max-tokens'
    && modelBackedVerdict(silentTurn, true).stalledOn === 'turn-ended-without-text',
  JSON.stringify(modelBackedVerdict(silentTurn, true)));

// 9. Tool-only turns, and the frame a stream writes when it only streams.
const toolOnly = fold([frame('cap-follow', sessionEvent('tool/call', { callId: 'c1', toolName: 'bash' }))], acceptedTurn);
check('a tool event is counted but does not manufacture assistant text',
  toolOnly.toolEvents === 1 && toolOnly.assistantTextBytes === 0
    && modelBackedVerdict(toolOnly, true).modelBacked === false);

const streamedOnly = fold([READY_FRAME, frame('cap-follow', textDelta('hello there'))], acceptedTurn);
check('a stream that delivered text but committed no message says so',
  streamedOnly.streamedVisibleBytes === 11 && streamedOnly.assistantVisibleBytes === 0
    && modelBackedVerdict(streamedOnly, true).modelBacked === true
    && modelBackedVerdict(streamedOnly, true).stalledOn === 'turn-unfinished',
  JSON.stringify(modelBackedVerdict(streamedOnly, true)));

// ── The answer transport (review F3) ─────────────────────────────────────────
//
// The frame this capture writes is as much a contract as the frames it reads.
// `$events/result` is special-cased by the gateway's UNARY dispatch while the
// stream side special-cases only `$events`, so opening it as a stream asks the
// carrier to look up a stream method that does not exist: the approval stays
// open and the run reports an answer that never arrived.

{
  const sent: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
  const transport = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    sent.push({ url, init });
    return { status: 200, body: JSON.stringify({ type: 'server-response', rpcId: 'x', result: { ok: true, value: null } }) };
  };
  const allowed = await answerApprovalWaterfall(transport, {
    baseUrl: 'http://dsh.invalid', cookie: 'dsh-auth-fixture=v1',
    clientId: 'client-1', eventId: 'evt-a1', approval: 'allow-once', newRpcId: () => 'rpc-1',
  });
  const posted = JSON.parse(sent[0]!.init.body) as {
    type: string; rpcId: string; method: string; payload: { args: Record<string, unknown> };
  };
  const args = posted.payload.args as { clientId: string; eventId: string; outcome: { kind: string; value: string } };
  check('an approval answer is an authenticated unary POST to the result route',
    sent.length === 1 && sent[0]!.url === 'http://dsh.invalid/api/$events/result'
      && sent[0]!.init.method === 'POST' && sent[0]!.init.headers['cookie'] === 'dsh-auth-fixture=v1'
      && posted.method === '$events/result' && posted.rpcId === 'rpc-1',
    JSON.stringify({ url: sent[0]?.url, method: sent[0]?.init.method }));
  check('the payload is exactly one args field naming this generation and this request',
    JSON.stringify(Object.keys(posted.payload)) === JSON.stringify(['args'])
      && args.clientId === 'client-1' && args.eventId === 'evt-a1'
      && args.outcome.kind === 'result' && args.outcome.value === 'allowed-once',
    JSON.stringify(posted.payload));
  // The inner payload can be perfect and the request still dead: the connection layer
  // parses the OUTER envelope first, and it accepts exactly one direction.
  check('the answer the capture actually sends is an envelope the pinned parser accepts',
    clientRequestRejection(JSON.parse(sent[0]!.init.body)) === '',
    clientRequestRejection(JSON.parse(sent[0]!.init.body)) || 'accepted');
  check('a receipt the host accepted is what moves the answer to delivered',
    allowed.state === 'delivered' && allowed.raw?.status === 200, JSON.stringify(allowed));

  // The host's rejection value, pinned. `denied` is not in ApprovalOutcome, so
  // a capture that sends one has not refused the tool — the answerer chain has
  // fallen through to `unavailable` on its own.
  const denied = await answerApprovalWaterfall(transport, {
    baseUrl: 'http://dsh.invalid', cookie: 'dsh-auth-fixture=v1',
    clientId: 'client-1', eventId: 'evt-a2', approval: 'deny', newRpcId: () => 'rpc-2',
  });
  const deniedArgs = (JSON.parse(sent[1]!.init.body) as { payload: { args: { outcome: { value: string } } } }).payload.args;
  check('the deny branch sends the host\u2019s own rejection value, not an invented one',
    deniedArgs.outcome.value === 'rejected' && denied.outcome === 'rejected',
    JSON.stringify(deniedArgs.outcome));

  const refused = await answerApprovalWaterfall(async () => ({
    status: 200, body: JSON.stringify({ result: { ok: false, error: { code: 'gateway/unknown-endpoint' } } }),
  }), {
    baseUrl: 'http://dsh.invalid', cookie: 'c', clientId: 'client-1', eventId: 'evt-a3', approval: 'deny',
  });
  check('a refused answer is failed with the host\u2019s reason, never counted as an answer',
    refused.state === 'failed' && refused.detail === 'gateway/unknown-endpoint', JSON.stringify(refused));

  const unreachable = await answerApprovalWaterfall(async () => {
    throw new Error('connection reset');
  }, {
    baseUrl: 'http://dsh.invalid', cookie: 'c', clientId: 'client-1', eventId: 'evt-a4', approval: 'allow-once',
  });
  check('an answer that never reached the host is failed rather than attempted-and-forgotten',
    unreachable.state === 'failed' && unreachable.detail === 'connection reset', JSON.stringify(unreachable));

  const notEnvelope = await answerApprovalWaterfall(async () => ({ status: 502, body: '<html>bad gateway' }), {
    baseUrl: 'http://dsh.invalid', cookie: 'c', clientId: 'client-1', eventId: 'evt-a5', approval: 'allow-once',
  });
  check('an answer with no envelope says so instead of assuming success',
    notEnvelope.state === 'failed' && notEnvelope.detail?.includes('502') === true, JSON.stringify(notEnvelope));

  const shaped = eventsResultBody({ rpcId: 'r', clientId: 'c1', eventId: 'e1', outcome: 'allowed-once' });
  check('the posted envelope is a client-request the pinned parser accepts',
    clientRequestRejection(JSON.parse(shaped.body)) === '',
    clientRequestRejection(JSON.parse(shaped.body)) || 'accepted');
  // A guard that cannot fail proves nothing, so feed it the envelope that used to be
  // sent here. The installed parser answered gateway/bad-request, and no approval on
  // the host was ever settled by it.
  check('the wrong direction is rejected, which is what this file used to send',
    clientRequestRejection({ ...JSON.parse(shaped.body), type: 'client-response' })
      === 'the envelope direction is client-response',
    clientRequestRejection({ ...JSON.parse(shaped.body), type: 'client-response' }));
  check('an envelope with a spare key is rejected',
    clientRequestRejection({ ...JSON.parse(shaped.body), cookie: 'x' })
      === 'the envelope carries the wrong keys: cookie,method,payload,rpcId,type',
    clientRequestRejection({ ...JSON.parse(shaped.body), cookie: 'x' }));
  check('the route and the endpoint name are the same string the gateway dispatches on',
    shaped.path === '/api/$events/result' && shaped.method === '$events/result', JSON.stringify(shaped));
}

/**
 * The outer HTTP envelope the installed connection layer accepts, stated here.
 *
 * clientRequestSchema in the pinned dsh-client-connection is
 * { type: 'client-request', rpcId: non-empty string, method: string, payload: unknown }
 * and nothing else, and it runs before the gateway dispatches the endpoint, so a
 * wrong type means $events/result is never reached and no approval is settled.
 * It is spelled out rather than imported because the installed host is not a
 * dependency of this repository, and a check written against the builder's own
 * assumptions would let the mistake this replaces pass. It is also confirmed to
 * REJECT: the direction case below is fed the value this file used to send.
 */
function clientRequestRejection(envelope: unknown): string {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return 'the envelope is not an object';
  const value = envelope as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'method,payload,rpcId,type') return 'the envelope carries the wrong keys: ' + keys;
  if (value['type'] !== 'client-request') return 'the envelope direction is ' + String(value['type']);
  if (typeof value['rpcId'] !== 'string' || value['rpcId'].length === 0) return 'rpcId is not a non-empty string';
  if (typeof value['method'] !== 'string') return 'method is not a string';
  const payload = value['payload'] as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== 'object' || Object.keys(payload).join(',') !== 'args') {
    return 'payload must hold exactly one args field';
  }
  return '';
}

// A turn that finished, a turn the user stopped, a turn that could not proceed and a
// turn that died in a model call are four different facts about one run, and which one
// happened is exactly what a capture gets asked.
const endings: Array<{ name: string; reason: Record<string, unknown>; kind: string; detail: string }> = [
  { name: 'completed', reason: { kind: 'completed' }, kind: 'completed', detail: '' },
  { name: 'aborted by the user', reason: { kind: 'aborted', reason: { kind: 'user' } }, kind: 'aborted', detail: 'cause user' },
  { name: 'blocked', reason: { kind: 'blocked' }, kind: 'blocked', detail: '' },
  {
    name: 'failed in the model call',
    reason: { kind: 'error', error: { code: 'rate_limited', message: 'too many requests' } },
    kind: 'error', detail: 'rate_limited: too many requests',
  },
  { name: 'out of output tokens', reason: { kind: 'max-tokens' }, kind: 'max-tokens', detail: '' },
  { name: 'orphaned by a crash', reason: { kind: 'interrupted' }, kind: 'interrupted', detail: '' },
];
for (const ending of endings) {
  const ended = fold([frame('cap-follow', userMessage('hi')), frame('cap-follow', turnEnd(ending.reason))]);
  check('the ' + ending.name + ' ending survives the decoder',
    ended.turnEnded !== null && ended.turnEnded.reason === ending.kind && ended.turnEnded.detail === ending.detail,
    JSON.stringify(ended.turnEnded));
}
const endingsDistinct = new Set(endings.map((ending) =>
  JSON.stringify(fold([frame('cap-follow', turnEnd(ending.reason))]).turnEnded))).size;
check('every turn ending is distinguishable from every other', endingsDistinct === endings.length,
  String(endingsDistinct) + ' of ' + String(endings.length));
const bareError = fold([frame('cap-follow', turnEnd({ kind: 'error' }))]);
check('an error ending with no failure attached says so rather than naming one',
  bareError.turnEnded?.reason === 'error' && bareError.turnEnded.detail === '', JSON.stringify(bareError.turnEnded));
const unreadable = fold([frame('cap-follow', sessionEvent('turn/end', { turn: 4, reason: 'stop' }))]);
check('a reason this grammar does not define is kept as unrecognised, not renamed',
  unreadable.turnEnded?.reason === 'unknown' && unreadable.turnEnded.detail.includes('stop') === true
    && unreadable.turnEnded.turn === 4, JSON.stringify(unreadable.turnEnded));
check('the decoder is the same one the fold uses',
  JSON.stringify(decodeTurnEndReason({ kind: 'aborted', reason: { kind: 'cancel-request' } }))
    === JSON.stringify({ kind: 'aborted', detail: 'cause cancel-request' }),
  JSON.stringify(decodeTurnEndReason({ kind: 'aborted', reason: { kind: 'cancel-request' } })));

const answeredQuestion = fold([
  frame('cap-follow', assistantMessage('Answered.')),
  frame('cap-follow', turnEnd({ kind: 'completed' })),
], questioned);
check('a completed turn after a question is not reported as still waiting for it', modelBackedVerdict(answeredQuestion, true).stalledOn === null);
const imageEcho = fold([frame('cap-follow', sessionEvent('user/message', { source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: 'fixture-image' } }] }))]);
check('an image-only durable user message counts as an echo', imageEcho.userMessageEchoed);

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${String(results.length - failed.length)} passed, ${String(failed.length)} failed`);
if (failed.length > 0) process.exit(1);
