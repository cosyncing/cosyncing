/**
 * The model turn of a contract capture, and what its evidence actually proves.
 *
 * Split out of the runner because the claim "this capture is model-backed" has
 * to be derived from what the host sent back, not from whether somebody typed a
 * prompt flag. The previous runner recorded `modelBacked: false` unconditionally
 * and never called `session/prompt` at all, so the flag was neither a claim nor
 * a lie, just dead text, and handing the child provider credentials would not
 * have changed it.
 *
 * The classifier here takes the frames a real host sent and decides what really
 * happened: did the prompt enter the agent inbox, did any assistant content come
 * back, did the turn stop on an approval or a question. It has no I/O, so all of
 * it is testable without a model, which is the point: the intelligence-heavy
 * part is knowing which observations justify which claim.
 */
export {};

/** What the operator asked the capture to do. */
export interface PromptScenarioRequest {
  sessionId: string;
  text: string;
  content?: readonly unknown[];
  /** How to answer an approval that the turn raises. */
  approval: 'allow-once' | 'deny';
  /** How long to wait for the turn to say something before giving up. */
  timeoutMs: number;
}

/** One frame seen on a capture stream, already parsed. */
export interface CapturedFrame {
  readonly streamId: string;
  readonly value: Record<string, unknown>;
}

export interface PromptEvidence {
  /** `session/prompt` returned `{accepted: true}`. */
  promptAccepted: boolean;
  userMessageEchoed: boolean;
  /**
   * Assistant text from the DURABLE `assistant/message` events, which is what
   * the host considers the finished answer.
   */
  assistantTextBytes: number;
  /** Assistant text with whitespace removed: 0 means nothing a reader could see. */
  assistantVisibleBytes: number;
  assistantChunks: number;
  /**
   * Assistant text from the process-local streaming frames, kept apart from the
   * durable message on purpose. A delta that arrived and a message that
   * committed are two different facts about a turn, and a capture that adds them
   * together cannot tell a committed answer from a stream that was abandoned
   * mid-way.
   */
  streamedChunks: number;
  streamedTextBytes: number;
  streamedVisibleBytes: number;
  /** Records in the follow stream's opening snapshot: history, not this turn. */
  historyRecords: number;
  toolEvents: number;
  /** Approvals the host put to this client on the event stream. */
  approvalsRequested: number;
  /** Approvals the host itself recorded as decided. */
  approvalsAnswered: number;
  questionsRequested: number;
  /** A terminal host frame for the followed session stream. */
  streamEnded: 'end' | 'error' | null;
  /** The turn closed by `turn/end`, which is the only thing that ends a turn. */
  turnEnded: { turn: number; reason: string; detail: string } | null;
  sawReady: boolean;
  readyClientId: string | null;
  /** Approval ids the host raised, in order, for the answer path to use. */
  approvalEventIds: string[];
}

export function emptyPromptEvidence(): PromptEvidence {
  return {
    promptAccepted: false, userMessageEchoed: false, assistantTextBytes: 0, assistantVisibleBytes: 0, assistantChunks: 0,
    streamedChunks: 0, streamedTextBytes: 0, streamedVisibleBytes: 0, historyRecords: 0,
    toolEvents: 0, approvalsRequested: 0, approvalsAnswered: 0, questionsRequested: 0,
    streamEnded: null, turnEnded: null, sawReady: false, readyClientId: null, approvalEventIds: [],
  };
}

/**
 * Pull every text-like string out of a message part list, defensively.
 *
 * Two counts come out of one walk. Streaming a token can legitimately be a
 * single space, so raw length measures what arrived; trimmed length measures
 * whether there was anything to read. A turn whose entire reply is whitespace
 * streamed but said nothing, and only the second count can earn a claim.
 */
function textOf(value: unknown): { bytes: number; visibleBytes: number } {
  const pieces: string[] = [];
  if (typeof value === 'string') pieces.push(value);
  else if (Array.isArray(value)) {
    for (const part of value) {
      if (!part || typeof part !== 'object') continue;
      const record = part as Record<string, unknown>;
      if (typeof record['text'] === 'string') pieces.push(record['text']);
    }
  }
  const joined = pieces.join('');
  return { bytes: joined.length, visibleBytes: joined.trim().length };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function stringOf(value: Record<string, unknown> | null, key: string): string {
  const candidate = value?.[key];
  return typeof candidate === 'string' ? candidate : '';
}

/** The `text` of one streaming chunk, and only if it IS visible text.
 *
 * `dsh-llm`'s StreamChunk is a sum over block-start, text-delta, reasoning-delta
 * and tool-call-delta. Counting a reasoning delta as assistant text would credit
 * the model with words it did not say out loud.
 */
function deltaText(chunk: unknown): string {
  const value = record(chunk);
  if (!value || stringOf(value, 'type') !== 'text-delta') return '';
  return typeof value['text'] === 'string' ? value['text'] : '';
}

function addText(
  target: { bytes: number; visibleBytes: number; chunks: number },
  bytes: number,
  visibleBytes: number,
): void {
  target.bytes += bytes;
  target.visibleBytes += visibleBytes;
  if (visibleBytes > 0 || bytes > 0) target.chunks += 1;
}

/**
 * Decode why the host says the turn ended.
 *
 * `turn/end`'s reason is the `TurnEndReason` sum in `dsh-session`:
 * `completed`, `aborted` (with a nested cancel cause), `blocked`, `error` (with a
 * structured LLM failure), `max-tokens`, `interrupted` and `forked`, each keyed by
 * `kind`. Reading it with a string lookup turns all seven into one indistinguishable
 * `unknown`, which throws away the difference between a turn that finished and a turn
 * that died mid-call — the exact fact a capture is asked about. An unrecognised shape
 * keeps what it can rather than inventing a kind.
 */
export function decodeTurnEndReason(value: unknown): { kind: string; detail: string } {
  const reason = record(value);
  if (!reason) {
    return {
      kind: 'unknown',
      detail: value === undefined ? 'no reason field' : `unrecognised reason ${JSON.stringify(value).slice(0, 120)}`,
    };
  }
  const kind = stringOf(reason, 'kind') || 'unknown';
  if (kind === 'error') {
    const failure = record(reason['error']);
    const code = stringOf(failure, 'code');
    const message = stringOf(failure, 'message');
    return { kind, detail: [code, message].filter((part) => part.length > 0).join(': ') };
  }
  if (kind === 'aborted') {
    const cause = record(reason['reason']);
    return { kind, detail: `cause ${stringOf(cause, 'kind') || 'unknown'}` };
  }
  return { kind, detail: '' };
}

/**
 * Fold one durable Session event.
 *
 * These are the events the host appended to the session log, named by
 * `dsh-session`'s own event map: `user/message`, `assistant/message`,
 * `tool/call`, `tool/result`, `turn/end`, and the approval audit pair. Every
 * one of them arrives wrapped, on the follow stream and in the opening snapshot
 * alike, as `{type:'event', event:{type, data}}`.
 */
function observeSessionEvent(
  next: PromptEvidence,
  name: string,
  data: unknown,
  assistant: { bytes: number; visibleBytes: number; chunks: number },
): void {
  const payload = record(data);
  if (name === 'turn/end') {
    const turn = typeof payload?.['turn'] === 'number' ? payload['turn'] : -1;
    const decoded = decodeTurnEndReason(payload?.['reason']);
    next.turnEnded = { turn, reason: decoded.kind, detail: decoded.detail };
    return;
  }
  if (name === 'tool/call' || name === 'tool/result') {
    next.toolEvents += 1;
    return;
  }
  // The service logs the question and the decision as an audit pair. The asked
  // half is the same question the event stream already put to this client, so
  // counting it here would count one approval twice; the decided half is the
  // only answer evidence that does not depend on what this client believes it
  // sent, so it is counted.
  if (name === 'approval/decided') {
    next.approvalsAnswered += 1;
    return;
  }
  if (name === 'user/message') {
    const counted = textOf(payload?.['content']);
    const content = payload?.['content'];
    if (counted.bytes > 0 || (Array.isArray(content) && content.some((part) => record(part)?.['type'] === 'image'))) next.userMessageEchoed = true;
    return;
  }
  if (name === 'assistant/message') {
    // `{turn, step, message, stream, usage}`: the message is nested, and the
    // compact raw stream beside it is the same text again.
    const counted = textOf(record(payload?.['message'])?.['content']);
    addText(assistant, counted.bytes, counted.visibleBytes);
  }
}

/**
 * Fold one frame off either of the two streams a prompt turn is watched on.
 *
 * Strict about meaning, but it has to be told which grammar it is looking at
 * rather than guess, because the two use the same words for different things:
 * the event stream's `{type:'waterfall', event:'approval/request'}` names the
 * event in a string field, and the follow stream's `{type:'event', event:{…}}`
 * names it inside an object. Reading one as the other finds no conversation and
 * reports a silent turn.
 */
export function observePromptFrame(evidence: PromptEvidence, frame: CapturedFrame): PromptEvidence {
  const value = record(frame.value);
  if (!value) return evidence;
  const next: PromptEvidence = { ...evidence, approvalEventIds: [...evidence.approvalEventIds] };
  const assistant = { bytes: 0, visibleBytes: 0, chunks: 0 };
  const streamed = { bytes: 0, visibleBytes: 0, chunks: 0 };
  const flush = (): PromptEvidence => {
    next.assistantChunks += assistant.chunks;
    next.assistantTextBytes += assistant.bytes;
    next.assistantVisibleBytes += assistant.visibleBytes;
    next.streamedChunks += streamed.chunks;
    next.streamedTextBytes += streamed.bytes;
    next.streamedVisibleBytes += streamed.visibleBytes;
    return next;
  };

  const type = stringOf(value, 'type');

  // ── The forwarded event stream (`$events`) ────────────────────────────────
  if (type === 'ready') {
    next.sawReady = true;
    const clientId = stringOf(value, 'clientId');
    if (clientId) next.readyClientId = clientId;
    return flush();
  }
  if (type === 'waterfall' || type === 'emit') {
    // `user-questions/request` is the host's name for it, listed alongside
    // `approval/request` in the pinned remote event table. A near-miss here is
    // a question that never shows up as the reason a turn stopped.
    const name = stringOf(value, 'event');
    if (name === 'approval/request') {
      next.approvalsRequested += 1;
      const eventId = stringOf(value, 'eventId');
      if (eventId) next.approvalEventIds.push(eventId);
    } else if (name === 'user-questions/request') {
      next.questionsRequested += 1;
    }
    return flush();
  }

  // ── The followed session stream (`session/follow`) ────────────────────────
  if (type === 'event') {
    const event = record(value['event']);
    observeSessionEvent(next, stringOf(event, 'type'), event?.['data'], assistant);
    return flush();
  }
  if (type === 'snapshot') {
    // The opening window is the log BEFORE this turn, so it is recorded as
    // history and never folded in as though the model had produced it now.
    const records = Array.isArray(value['records']) ? value['records'] : [];
    next.historyRecords += records.length;
    return flush();
  }
  if (type === 'assistant-stream') {
    const inner = record(value['frame']);
    const innerType = stringOf(inner, 'type');
    if (innerType === 'chunk') {
      const text = deltaText(inner?.['chunk']);
      if (text) addText(streamed, text.length, text.trim().length);
    }
    return flush();
  }
  if (type === 'end') {
    next.streamEnded = next.streamEnded ?? 'end';
    return flush();
  }
  if (type === 'error') {
    next.streamEnded = next.streamEnded ?? 'error';
    return flush();
  }
  return flush();
}

/** Fold the unary `session/prompt` reply, which is the only proof of acceptance. */
export function observePromptReceipt(evidence: PromptEvidence, envelope: unknown): PromptEvidence {
  const result = (envelope as { result?: { ok?: boolean; value?: unknown } } | undefined)?.result;
  const accepted = result?.ok === true
    && (result.value as { accepted?: unknown } | undefined)?.accepted === true;
  return { ...evidence, promptAccepted: accepted };
}

/**
 * The honest provenance line for a run.
 *
 * A prompt the host never accepted proves nothing, and a turn that produced no
 * assistant content proves nothing about streaming, so neither counts as
 * model-backed. A turn that stalled on an approval the capture refused is still
 * real evidence about the approval path, and `stalledOn` says so rather than
 * rounding the whole run down to false.
 */
export function modelBackedVerdict(
  evidence: PromptEvidence,
  attempted: boolean,
  notAttemptedReason?: string,
): {
  modelBacked: boolean;
  attempted: boolean;
  stalledOn: string | null;
  reason: string;
} {
  if (!attempted) {
    return {
      modelBacked: false, attempted: false, stalledOn: null,
      reason: notAttemptedReason ?? 'no prompt scenario was requested',
    };
  }
  if (!evidence.promptAccepted) {
    return { modelBacked: false, attempted: true, stalledOn: 'prompt-not-accepted', reason: 'the host did not accept the prompt' };
  }
  // An unanswered interaction outranks anything the turn managed to say. A model
  // that writes a preamble and then waits forever for permission did produce
  // text, and a verdict that lets that text buy the claim has read a stall as a
  // success. Order matters more than here being text: the turn is not over until
  // the turn says it is.
  if (evidence.approvalsRequested > evidence.approvalsAnswered) {
    return {
      modelBacked: false, attempted: true, stalledOn: 'approval',
      reason: 'the turn is waiting on an approval this capture did not answer',
    };
  }
  if (evidence.questionsRequested > 0 && evidence.turnEnded?.reason !== 'completed') {
    return {
      modelBacked: false, attempted: true, stalledOn: 'user-question',
      reason: 'the turn is waiting on a question this capture cannot answer',
    };
  }
  const streamedText = evidence.streamedVisibleBytes > 0;
  if (evidence.assistantVisibleBytes === 0 && !streamedText) {
    const stalledOn = evidence.turnEnded !== null ? 'turn-ended-without-text' : evidence.streamEnded ?? 'no-assistant-output';
    return { modelBacked: false, attempted: true, stalledOn, reason: 'the turn returned no assistant content' };
  }
  // Streaming that never committed is real output and an unfinished turn, so it
  // is reported as the former without pretending to be the latter.
  if (evidence.assistantVisibleBytes === 0) {
    return {
      modelBacked: true, attempted: true, stalledOn: evidence.turnEnded === null ? 'turn-unfinished' : null,
      reason: `${String(evidence.streamedChunks)} streamed chunks, ${String(evidence.streamedVisibleBytes)} readable bytes, no committed message`,
    };
  }
  return {
    modelBacked: true, attempted: true, stalledOn: evidence.turnEnded === null ? 'turn-unfinished' : null,
    reason: `${String(evidence.assistantChunks)} assistant messages, ${String(evidence.assistantVisibleBytes)} readable bytes`
      + (evidence.streamedVisibleBytes > 0 ? `, ${String(evidence.streamedVisibleBytes)} streamed` : ''),
  };
}

/**
 * One approval answer, and what the host made of it.
 *
 * `attempted` is this client's own action; only `delivered` says the gateway took
 * the decision. A provenance field built from attempts claims answers the
 * waterfall never saw, which is the one thing a capture must not do to its own
 * evidence.
 */
export interface AnswerRecord {
  eventId: string;
  outcome: string;
  state: 'attempted' | 'delivered' | 'failed';
  detail?: string;
  raw?: { status: number; body: string };
}

/**
 * What the capture does with an approval, in the host's own vocabulary.
 *
 * `ApprovalOutcome` in the pinned `dsh-user-approval` types is the closed set
 * `allowed-once | rejected | cancelled | unavailable`. There is no `denied`, so a
 * capture that sends one is not declining the tool: it is sending a value the
 * answerer chain cannot match, and the chain falls through to its own
 * `unavailable` while the capture reports a decision it never made.
 */
export const APPROVAL_ANSWER_OUTCOMES = Object.freeze({
  'allow-once': 'allowed-once',
  deny: 'rejected',
} as const);

/** The endpoint a waterfall answer travels on. Unary, like every other RPC. */
export const EVENTS_RESULT_ENDPOINT = '$events/result';

/**
 * The direction discriminator the pinned connection layer accepts from a client.
 *
 * `clientRequestSchema` in the installed `dsh-client-connection` is
 * `{ type: 'client-request', rpcId, method, payload }` and nothing else, so
 * these four keys, with this literal type, are the whole outer contract.
 */
export const CLIENT_REQUEST_TYPE = 'client-request';

/** Build the exact body the gateway's result parser accepts. */
export function eventsResultBody(request: {
  rpcId: string; clientId: string; eventId: string; outcome: string;
}): { body: string; path: string; method: string } {
  return {
    path: `/api/${EVENTS_RESULT_ENDPOINT}`,
    method: EVENTS_RESULT_ENDPOINT,
    // `client-request`, and not the `client-response` this once said. The
    // connection layer parses the outer envelope with `clientRequestSchema`
    // BEFORE the gateway ever looks at the endpoint, so a request aimed at
    // `$events/result` with the wrong direction is rejected as a malformed
    // message and no approval is ever settled. `client-response` is the
    // direction the HOST writes in; a client has no such message.
    // Exactly one `args` field, or the gateway refuses the payload before it
    // ever looks at the clientId inside it.
    body: JSON.stringify({
      type: CLIENT_REQUEST_TYPE,
      rpcId: request.rpcId,
      method: EVENTS_RESULT_ENDPOINT,
      payload: {
        args: {
          clientId: request.clientId,
          eventId: request.eventId,
          outcome: { kind: 'result', value: request.outcome },
        },
      },
    }),
  };
}

export interface ApprovalTransport {
  (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }): Promise<{
    status: number; body: string;
  }>;
}

/**
 * Settle one approval on the host, and report which of three things happened.
 *
 * `$events/result` is special-cased by the gateway's unary dispatch, and the
 * stream side of the carrier special-cases only `$events`. Opening it as a stream
 * therefore does not answer anything: the frame goes to a stream lookup that has
 * no such method, and the waterfall stays open while the capture congratulates
 * itself on having answered it. This is an authenticated POST, and its receipt is
 * the only thing that can move a record from `attempted` to `delivered`.
 */
export async function answerApprovalWaterfall(
  transport: ApprovalTransport,
  request: {
    baseUrl: string;
    cookie: string;
    clientId: string;
    eventId: string;
    approval: 'allow-once' | 'deny';
    newRpcId?: () => string;
  },
): Promise<AnswerRecord> {
  const outcome = APPROVAL_ANSWER_OUTCOMES[request.approval];
  const record: AnswerRecord = { eventId: request.eventId, outcome, state: 'attempted' };
  const rpcId = (request.newRpcId ?? (() => `capture-${String(Math.random().toString(36).slice(2, 10))}`))();
  const request_ = eventsResultBody({ rpcId, clientId: request.clientId, eventId: request.eventId, outcome });
  let response: { status: number; body: string };
  try {
    response = await transport(`${request.baseUrl}${request_.path}`, {
      method: 'POST',
      headers: { cookie: request.cookie, 'content-type': 'application/json' },
      body: request_.body,
    });
  } catch (error) {
    record.state = 'failed';
    record.detail = error instanceof Error ? error.message : String(error);
    return record;
  }
  record.raw = { status: response.status, body: response.body.slice(0, 500) };
  let accepted = false;
  let code: string | undefined;
  try {
    const envelope = JSON.parse(response.body) as { result?: { ok?: boolean; error?: { code?: string } } };
    accepted = envelope.result?.ok === true;
    code = envelope.result?.error?.code;
  } catch {
    record.detail = `the answer route answered ${String(response.status)} without an envelope`;
    record.state = 'failed';
    return record;
  }
  if (!accepted) {
    // A result naming no active event stream is the host's way of saying the
    // generation moved on. The approval is not this client's to answer any more.
    record.state = 'failed';
    record.detail = code ?? `status ${String(response.status)}`;
    return record;
  }
  record.state = 'delivered';
  return record;
}

/** Build the `session/prompt` payload exactly as the descriptor wants it. */
export function promptRequest(request: PromptScenarioRequest): Record<string, unknown> {
  return {
    request: {
      requestId: `capture-${randomId()}`,
      sessionId: request.sessionId,
      mode: 'queue',
      content: request.content ?? [{ type: 'text', text: request.text }],
    },
  };
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}
