/**
 * The order a capture turn happens in, which is the whole content of review G2/G3.
 *
 * Nothing here talks to a host. A fake carrier and deferred HTTP responses let a
 * test decide whether the follow baseline arrives before the event client, whether
 * a receipt lands before or after `turn/end`, or whether it lands at all. Those
 * interleavings are what produced "the host accepted my prompt" reported as false
 * and an approval answer that never showed up in its own count.
 *
 *   bun run scripts/adapters/tests/test-dsh-capture-turn.ts
 */
export {};

import { runPromptTurn, TURN_EVENTS_STREAM, TURN_FOLLOW_STREAM, type TurnSocket, type TurnTransport } from '../dsh-capture-turn.ts';

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
}

class FakeSocket implements TurnSocket {
  readonly sent: Array<Record<string, unknown>> = [];
  closes = 0;
  private readonly handlers = new Map<string, Array<(event: { data?: unknown }) => void>>();

  addEventListener(type: 'open' | 'message' | 'error', handler: (event: { data?: unknown }) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.closes += 1;
  }

  fireOpen(): void {
    for (const handler of this.handlers.get('open') ?? []) handler({});
  }

  fireError(): void {
    for (const handler of this.handlers.get('error') ?? []) handler({});
  }

  frame(value: Record<string, unknown>): void {
    const data = JSON.stringify(value);
    for (const handler of this.handlers.get('message') ?? []) handler({ data });
  }

  openedEndpoints(): string[] {
    return this.sent.filter((frame) => frame['type'] === 'open').map((frame) => String(frame['endpoint']));
  }
}

interface Posted {
  url: string;
  body: string;
  settle: (value: { status: number; body: string }) => void;
  fail: (error: Error) => void;
}

function harness(): {
  socket: FakeSocket;
  posts: Posted[];
  transport: TurnTransport;
  promptPosts: Posted[];
  answerPosts: Posted[];
} {
  const socket = new FakeSocket();
  const posts: Posted[] = [];
  const transport: TurnTransport = {
    openSocket: () => socket,
    post: (url, body) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      posts.push({
        url,
        body,
        settle: resolve,
        fail: reject,
      });
    }),
  };
  return {
    socket,
    posts,
    transport,
    promptPosts: [],
    answerPosts: [],
  };
}

const acceptedPrompt = JSON.stringify({ type: 'server-response', rpcId: 'r', result: { ok: true, value: { accepted: true } } });
const acceptedAnswer = JSON.stringify({ type: 'server-response', rpcId: 'r', result: { ok: true, value: null } });
const snapshot = { streamId: TURN_FOLLOW_STREAM, type: 'snapshot', cursor: 7, records: [] };
const ready = { streamId: TURN_EVENTS_STREAM, type: 'ready', clientId: 'client-1' };
const assistantText = {
  streamId: TURN_FOLLOW_STREAM,
  type: 'event',
  event: { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'done' }] } } },
};
const turnEnd = { streamId: TURN_FOLLOW_STREAM, type: 'event', event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } };
const approvalRequest = { streamId: TURN_EVENTS_STREAM, type: 'waterfall', event: 'approval/request', eventId: 'evt-1' };

const request = {
  baseUrl: 'http://dsh.invalid',
  cookie: 'dsh-auth-fixture=v1',
  sessionId: 'session-fixture-001',
  text: 'say hi',
  approval: 'allow-once' as const,
  timeoutMs: 250,
  receiptGraceMs: 40,
};

/** Let the module's promise callbacks run without a wall-clock wait. */
const tick = async (times = 4): Promise<void> => {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
};

function postsTo(posts: Posted[], fragment: string): Posted[] {
  return posts.filter((post) => post.url.includes(fragment));
}

// ── G2: what has to be true before the model is asked anything ─────────────────

{
  const h = harness();
  const done = runPromptTurn(h.transport, request);
  h.socket.fireOpen();
  await tick();
  check('both subscriptions open before anything else happens',
    JSON.stringify(h.socket.openedEndpoints()) === JSON.stringify(['$events', 'session/follow']),
    JSON.stringify(h.socket.openedEndpoints()));
  h.socket.frame(ready);
  await tick();
  check('an event client on its own does not start the turn',
    postsTo(h.posts, '/api/session/prompt').length === 0,
    String(postsTo(h.posts, '/api/session/prompt').length) + ' prompts sent');
  h.socket.frame(snapshot);
  await tick();
  const prompt = postsTo(h.posts, '/api/session/prompt')[0];
  check('the followed baseline is what starts the turn', prompt !== undefined);
  const envelope = JSON.parse(prompt?.body ?? '{}') as Record<string, unknown>;
  const payload = envelope['payload'] as { args: { request: { sessionId: string } } } | undefined;
  check('the prompt is a client-request carrying the descriptor payload',
    envelope['type'] === 'client-request' && envelope['method'] === 'session/prompt'
      && payload?.args.request.sessionId === 'session-fixture-001',
    JSON.stringify(envelope).slice(0, 90));
  prompt?.settle({ status: 200, body: acceptedPrompt });
  h.socket.frame(assistantText);
  h.socket.frame(turnEnd);
  const turn = await done;
  check('a settled turn reports the acceptance the host actually sent',
    turn.evidence.promptAccepted === true && turn.promptState === 'accepted' && turn.stoppedBy === 'turn-end',
    JSON.stringify({ promptState: turn.promptState, stoppedBy: turn.stoppedBy }));
}

{
  // The order the review could not distinguish: readiness first or baseline first.
  const h = harness();
  const done = runPromptTurn(h.transport, request);
  h.socket.fireOpen();
  h.socket.frame(snapshot);
  await tick();
  check('a baseline without an event client does not start the turn either',
    postsTo(h.posts, '/api/session/prompt').length === 0);
  h.socket.frame(ready);
  await tick();
  check('the later of the two readiness signals is the one that starts it',
    postsTo(h.posts, '/api/session/prompt').length === 1);
  postsTo(h.posts, '/api/session/prompt')[0]?.settle({ status: 200, body: acceptedPrompt });
  h.socket.frame(turnEnd);
  await done;
}

{
  const h = harness();
  const done = runPromptTurn(h.transport, request);
  h.socket.fireOpen();
  await tick();
  h.socket.frame(ready);
  await tick();
  h.socket.fireError();
  const turn = await done;
  check('a carrier that dies before the baseline asks the model nothing',
    turn.promptSent === false && turn.stoppedBy === 'socket-error' && h.posts.length === 0,
    JSON.stringify({ promptSent: turn.promptSent, stoppedBy: turn.stoppedBy, posts: h.posts.length }));
  check('a run that never prompted is reported as not sent rather than as unanswered',
    turn.promptState === 'not-sent' && turn.answers.length === 0, turn.promptState);
}

{
  const h = harness();
  const started = Date.now();
  const done = runPromptTurn(h.transport, { ...request, timeoutMs: 60 });
  h.socket.fireOpen();
  h.socket.frame(ready);
  const turn = await done;
  check('a baseline that never arrives ends the turn without prompting',
    turn.promptSent === false && turn.stoppedBy === 'deadline'
      && postsTo(h.posts, '/api/session/prompt').length === 0,
    JSON.stringify({ promptSent: turn.promptSent, stoppedBy: turn.stoppedBy }));
  check('that wait is the deadline the caller asked for', Date.now() - started < 150,
    String(Date.now() - started) + 'ms');
}

// ── G3: receipts, and what the report may say once they are in the air ─────────

{
  const h = harness();
  const done = runPromptTurn(h.transport, request);
  h.socket.fireOpen();
  await tick();
  h.socket.frame(approvalRequest);
  await tick();
  check('an approval raised before readiness waits instead of being dropped',
    postsTo(h.posts, '$events/result').length === 0);
  h.socket.frame(ready);
  await tick();
  const answers = postsTo(h.posts, '$events/result');
  check('the queued approval is answered the moment a client id exists',
    answers.length === 1, String(answers.length) + ' answers sent');
  answers[0]?.settle({ status: 200, body: acceptedAnswer });
  h.socket.frame(snapshot);
  await tick();
  postsTo(h.posts, '/api/session/prompt')[0]?.settle({ status: 200, body: acceptedPrompt });
  h.socket.frame(turnEnd);
  const turn = await done;
  check('an answered approval is reported as delivered',
    turn.answers.length === 1 && turn.answers[0]?.state === 'delivered',
    JSON.stringify(turn.answers));
}

{
  // The exact interleaving that reported a completed turn as unaccepted.
  const h = harness();
  const done = runPromptTurn(h.transport, request);
  h.socket.fireOpen();
  h.socket.frame(ready);
  h.socket.frame(snapshot);
  await tick();
  const prompt = postsTo(h.posts, '/api/session/prompt')[0]!;
  h.socket.frame(assistantText);
  h.socket.frame(turnEnd);
  await tick();
  prompt.settle({ status: 200, body: acceptedPrompt });
  const turn = await done;
  check('a receipt already in flight lands before the turn is written down',
    turn.evidence.promptAccepted === true && turn.promptState === 'accepted' && turn.stoppedBy === 'turn-end',
    JSON.stringify({ accepted: turn.evidence.promptAccepted, state: turn.promptState }));
}

{
  // An approval answer whose POST is still out when the host closes the turn.
  const h = harness();
  const done = runPromptTurn(h.transport, request);
  h.socket.fireOpen();
  h.socket.frame(ready);
  h.socket.frame(snapshot);
  await tick();
  postsTo(h.posts, '/api/session/prompt')[0]?.settle({ status: 200, body: acceptedPrompt });
  h.socket.frame(approvalRequest);
  await tick();
  const answer = postsTo(h.posts, '$events/result')[0]!;
  h.socket.frame({
    streamId: TURN_FOLLOW_STREAM,
    type: 'event',
    event: { type: 'approval/decided', data: { id: 'r1', toolName: 'bash', outcome: 'allowed-once' } },
  });
  h.socket.frame(turnEnd);
  await tick();
  answer.settle({ status: 200, body: acceptedAnswer });
  const turn = await done;
  check('an answer still in flight at the end of the turn is counted, then settled',
    turn.answers.length === 1 && turn.answers[0]?.state === 'delivered',
    JSON.stringify(turn.answers));
}

{
  // And the version where it never comes back at all. The count must still show
  // the request, classified as one that got no acknowledgement.
  const h = harness();
  const started = Date.now();
  const done = runPromptTurn(h.transport, { ...request, timeoutMs: 60, receiptGraceMs: 40 });
  h.socket.fireOpen();
  h.socket.frame(ready);
  h.socket.frame(snapshot);
  await tick();
  postsTo(h.posts, '/api/session/prompt')[0]?.settle({ status: 200, body: acceptedPrompt });
  h.socket.frame(approvalRequest);
  await tick();
  const pending = postsTo(h.posts, '$events/result')[0]!;
  h.socket.frame(turnEnd);
  const turn = await done;
  const answer = turn.answers[0];
  check('an answer whose receipt never arrives is failed rather than invisible',
    turn.answers.length === 1 && answer?.state === 'failed' && (answer.detail ?? '').includes('no receipt'),
    JSON.stringify(turn.answers));
  check('waiting for a receipt is bounded, not indefinite', Date.now() - started < 220,
    String(Date.now() - started) + 'ms');

  // A receipt that arrives after the report exists cannot rewrite the report.
  pending.settle({ status: 200, body: acceptedAnswer });
  await tick();
  check('a receipt that lands after the turn was written down does not rewrite it',
    turn.answers[0]?.state === 'failed', JSON.stringify(turn.answers[0]));
}

{
  // The host repeats an unanswered waterfall. One request is one decision.
  const h = harness();
  const done = runPromptTurn(h.transport, request);
  h.socket.fireOpen();
  h.socket.frame(ready);
  h.socket.frame(snapshot);
  await tick();
  postsTo(h.posts, '/api/session/prompt')[0]?.settle({ status: 200, body: acceptedPrompt });
  h.socket.frame(approvalRequest);
  h.socket.frame(approvalRequest);
  h.socket.frame(approvalRequest);
  await tick();
  check('one approval request is one answer however often the host repeats it',
    postsTo(h.posts, '$events/result').length === 1,
    String(postsTo(h.posts, '$events/result').length) + ' answers sent');
  postsTo(h.posts, '$events/result')[0]?.settle({ status: 200, body: acceptedAnswer });
  h.socket.frame(turnEnd);
  const turn = await done;
  check('the repeated request still leaves one answer on the record',
    turn.answers.length === 1, String(turn.answers.length));
}

{
  const h = harness();
  const content = [{ type: 'image', mediaType: 'image/png', data: 'fixture-bytes' }];
  const done = runPromptTurn(h.transport, { ...request, replaceFollowDuringTurn: true, content });
  h.socket.fireOpen(); h.socket.frame(ready); h.socket.frame(snapshot); await tick();
  const prompt = postsTo(h.posts, '/api/session/prompt')[0]!;
  check('explicit image content reaches the capture prompt unchanged',
    JSON.stringify(JSON.parse(prompt.body).payload.args.request.content) === JSON.stringify(content));
  prompt.settle({ status: 200, body: acceptedPrompt });
  const chunk = { streamId: TURN_FOLLOW_STREAM, type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'partial' } } };
  h.socket.frame(chunk); h.socket.frame(chunk); await tick();
  const followOpens = h.socket.sent.filter((f) => f['type'] === 'open' && f['endpoint'] === 'session/follow');
  check('the bounded reconnect scenario replaces follow once while retaining the event authority',
    followOpens.length === 2 && h.socket.sent.filter((f) => f['type'] === 'cancel').length === 1
      && h.socket.sent.filter((f) => f['type'] === 'open' && f['endpoint'] === '$events').length === 1);
  h.socket.frame(turnEnd); await done;
}

const failed = results.filter((entry) => !entry.ok);
console.log('\n' + String(results.length - failed.length) + ' passed, ' + String(failed.length) + ' failed');
if (failed.length > 0) process.exit(1);
