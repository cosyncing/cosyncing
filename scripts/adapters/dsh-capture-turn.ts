/**
 * One model turn of a contract capture, from subscriptions to a frozen verdict.
 *
 * This lived inline in the runner, which is how two ordering races survived a
 * round of review: the prompt could leave before the followed session had a
 * baseline, and a `turn/end` could freeze the evidence while the prompt or an
 * approval POST was still in the air. Both are ordering properties of this
 * function, so this function is where they are decided, with the socket, the
 * HTTP and the clock handed in. Nothing here opens a real connection, so every
 * interleaving the review reproduced is a case in the suite beside it.
 *
 * The rules it enforces:
 *   - both subscriptions are established before the prompt leaves, because the
 *     follow stream's opening snapshot is the baseline every later claim is
 *     measured against, and a turn that is already inside that snapshot is
 *     reported as history rather than as this turn's output;
 *   - an answer is recorded when it is SENT and reclassified when the receipt
 *     lands, so a request in flight at the end is visible as one that never
 *     got an acknowledgement rather than vanishing from the count;
 *   - finalizing waits a bounded moment for receipts already in flight, then
 *     freezes. Nothing changes the reported evidence afterwards.
 */
export {};

import {
  answerApprovalWaterfall, emptyPromptEvidence, modelBackedVerdict, observePromptFrame,
  observePromptReceipt, promptRequest,
  type AnswerRecord, type PromptEvidence,
} from './dsh-capture-prompt.ts';

/** A carrier this module can drive without knowing what a WebSocket is. */
export interface TurnSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'error', handler: (event: { data?: unknown }) => void): void;
}

export interface TurnTransport {
  /** A carrier pointed at `baseUrl`, authenticated by `cookie`. */
  openSocket(baseUrl: string, cookie: string): TurnSocket;
  /** One authenticated unary JSON POST. */
  post(url: string, body: string, cookie: string): Promise<{ status: number; body: string }>;
  setTimeoutImpl?(handler: () => void, ms: number): unknown;
  clearTimeoutImpl?(handle: unknown): void;
}

export interface PromptTurnRequest {
  baseUrl: string;
  cookie: string;
  sessionId: string;
  text: string;
  approval: 'allow-once' | 'deny';
  /** Overall deadline for the turn, including the wait for a baseline. */
  timeoutMs: number;
  /** How long a receipt already in flight gets after the turn ends. */
  receiptGraceMs?: number;
  /** Frames kept in the record; the rest are counted but not stored. */
  maxFrames?: number;
}

/** Why the turn stopped being observed. Recorded rather than guessed later. */
export type TurnStop = 'turn-end' | 'stream-end' | 'deadline' | 'socket-error' | 'prompt-failed';

export interface PromptTurnResult {
  evidence: PromptEvidence;
  answers: AnswerRecord[];
  frames: unknown[];
  /** The prompt POST left this process. Without it the run proves nothing. */
  promptSent: boolean;
  promptState: 'not-sent' | 'pending' | 'accepted' | 'failed';
  promptDetail?: string;
  stoppedBy: TurnStop | null;
  /** Set when the deadline, the grace window or both were what ended the turn. */
  receiptsSettled: boolean;
}

import { APPROVAL_ANSWER_OUTCOMES, CLIENT_REQUEST_TYPE } from './dsh-capture-prompt.ts';

/** Stream ids are the runner's, kept here so the frames and the code agree. */
export const TURN_EVENTS_STREAM = 'cap-turn-events';
export const TURN_FOLLOW_STREAM = 'cap-turn-follow';

const PROMPT_ENDPOINT = 'session/prompt';

/** The one envelope shape the connection layer accepts from a client. */
function clientRequestBody(rpcId: string, method: string, args: unknown): string {
  return JSON.stringify({ type: CLIENT_REQUEST_TYPE, rpcId, method, payload: { args } });
}

/**
 * Watch one prompt turn through to a settled record.
 *
 * Resolves exactly once, with the evidence frozen at that moment. The returned
 * `promptSent` is what makes the provenance honest: a run whose subscriptions
 * never came up never asked the model anything, and must not be scored as a
 * turn that failed to answer.
 */
export async function runPromptTurn(
  transport: TurnTransport,
  request: PromptTurnRequest,
): Promise<PromptTurnResult> {
  const setTimeoutImpl = transport.setTimeoutImpl
    ?? ((handler: () => void, ms: number): unknown => setTimeout(handler, ms));
  const clearTimeoutImpl = transport.clearTimeoutImpl
    ?? ((handle: unknown): void => { if (handle !== undefined) clearTimeout(handle as ReturnType<typeof setTimeout>); });
  const maxFrames = request.maxFrames ?? 400;
  const graceMs = request.receiptGraceMs ?? 5_000;

  const answers: AnswerRecord[] = [];
  const frames: unknown[] = [];
  const inFlight = new Set<Promise<void>>();
  const taken = new Set<string>();
  const queuedApprovals: string[] = [];
  let evidence = emptyPromptEvidence();
  let clientId: string | null = null;
  let baseline = false;
  let promptSent = false;
  let promptState: PromptTurnResult['promptState'] = 'not-sent';
  let promptDetail: string | undefined;
  let stoppedBy: TurnStop | null = null;
  let phase: 'running' | 'settling' | 'done' = 'running';
  let deadlineHandle: unknown;
  let graceHandle: unknown;
  let resolveResult!: (value: PromptTurnResult) => void;
  const settled = new Promise<PromptTurnResult>((resolve) => { resolveResult = resolve; });

  const track = (operation: Promise<void>): void => {
    inFlight.add(operation);
    const forget = (): void => { inFlight.delete(operation); };
    operation.then(forget, forget);
  };

  /** Send one approval decision, recording the attempt BEFORE the request. */
  const answerApproval = async (eventId: string): Promise<void> => {
    if (phase !== 'running' || clientId === null) return;
    const record: AnswerRecord = {
      eventId, outcome: APPROVAL_ANSWER_OUTCOMES[request.approval], state: 'attempted',
    };
    answers.push(record);
    const finished = await answerApprovalWaterfall(
      async (url, init) => transport.post(url, init.body, request.cookie),
      {
        baseUrl: request.baseUrl, cookie: request.cookie, clientId, eventId, approval: request.approval,
        newRpcId: () => 'capture-answer-' + String(answers.length),
      },
    );
    // The reported list was copied at freeze time, so a receipt that lands after
    // the report exists cannot quietly rewrite what was already claimed.
    Object.assign(record, finished);
  };

  /**
   * Take on an answer, and count it as work in flight.
   *
   * An answer the capture sent but never heard back from is exactly the case that
   * used to disappear from its own accounting, so the request has to be something
   * a stopping turn knows about rather than a floating promise.
   */
  const launchAnswer = (eventId: string): void => {
    track(answerApproval(eventId));
  };

  const sendPrompt = (): void => {
    if (phase !== 'running' || promptSent || clientId === null || !baseline) return;
    promptSent = true;
    promptState = 'pending';
    const body = clientRequestBody('capture-prompt-1', PROMPT_ENDPOINT, promptRequest({
      sessionId: request.sessionId, text: request.text, approval: request.approval, timeoutMs: request.timeoutMs,
    }));
    track((async (): Promise<void> => {
      let posted: { status: number; body: string };
      try {
        posted = await transport.post(request.baseUrl + '/api/' + PROMPT_ENDPOINT, body, request.cookie);
      } catch (error) {
        promptState = 'failed';
        promptDetail = error instanceof Error ? error.message : String(error);
        stop('prompt-failed');
        return;
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(posted.body) as unknown;
      } catch {
        envelope = undefined;
      }
      evidence = observePromptReceipt(evidence, envelope);
      const accepted = evidence.promptAccepted;
      promptState = accepted ? 'accepted' : 'failed';
      if (!accepted) {
        promptDetail = 'the host did not accept the prompt (status ' + String(posted.status) + ')';
        stop('prompt-failed');
      }
    })());
  };

  const foldFrame = (streamId: string, value: Record<string, unknown>): void => {
    if (phase === 'done') return;
    if (frames.length < maxFrames) frames.push({ streamId, value });
    evidence = observePromptFrame(evidence, { streamId, value });

    if (streamId === TURN_EVENTS_STREAM && value['type'] === 'ready' && clientId === null) {
      const announced = value['clientId'];
      if (typeof announced === 'string' && announced.length > 0) {
        clientId = announced;
        for (const eventId of queuedApprovals.splice(0)) launchAnswer(eventId);
        sendPrompt();
      }
    }
    // The follow stream's opening snapshot is the baseline. Prompting before it
    // exists means the turn can arrive inside the snapshot, where it is history.
    if (streamId === TURN_FOLLOW_STREAM && value['type'] === 'snapshot' && !baseline) {
      baseline = true;
      sendPrompt();
    }

    const raised = typeof value['event'] === 'string' ? value['event'] as string : '';
    const eventId = typeof value['eventId'] === 'string' ? value['eventId'] as string : '';
    if (streamId === TURN_EVENTS_STREAM && raised === 'approval/request' && eventId !== '' && !taken.has(eventId)) {
      taken.add(eventId);
      if (clientId === null) queuedApprovals.push(eventId);
      else launchAnswer(eventId);
    }

    if (evidence.turnEnded !== null) stop('turn-end');
    else if (evidence.streamEnded !== null) stop('stream-end');
  };

  /** Stop observing, but let receipts already in flight land first. */
  const stop = (reason: TurnStop): void => {
    if (phase !== 'running') return;
    stoppedBy = reason;
    phase = 'settling';
    clearTimeoutImpl(deadlineHandle);
    const receipts = new Promise<void>((resolve) => {
      if (inFlight.size === 0) resolve();
      else Promise.allSettled([...inFlight]).then(() => resolve(), () => resolve());
    });
    // Bounded, so a host that answers nothing cannot hold the capture open; the
    // overall deadline still ends the turn, and this only extends it by graceMs.
    const grace = new Promise<void>((resolve) => { graceHandle = setTimeoutImpl(() => resolve(), graceMs); });
    Promise.race([receipts, grace]).then(freeze, freeze);
  };

  const freeze = (): void => {
    if (phase === 'done') return;
    phase = 'done';
    clearTimeoutImpl(graceHandle);
    for (const record of answers) {
      if (record.state !== 'attempted') continue;
      record.state = 'failed';
      record.detail = 'sent, but no receipt arrived before the capture stopped';
    }
    if (promptState === 'pending') {
      promptState = 'failed';
      promptDetail = 'sent, but no acceptance receipt arrived before the capture stopped';
    }
    try { socket.close(); } catch { /* already gone */ }
    resolveResult({
      evidence,
      answers: answers.map((record) => ({ ...record })),
      frames: frames.slice(0, maxFrames),
      promptSent,
      promptState,
      promptDetail,
      stoppedBy,
      receiptsSettled: inFlight.size === 0,
    });
  };

  const socket = transport.openSocket(request.baseUrl, request.cookie);
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'open', streamId: TURN_EVENTS_STREAM, endpoint: '$events', payload: { args: {} } }));
    socket.send(JSON.stringify({
      type: 'open', streamId: TURN_FOLLOW_STREAM, endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId: request.sessionId }, assistantStream: true } } },
    }));
  });
  socket.addEventListener('message', (event) => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(String(event.data)) as Record<string, unknown>;
    } catch {
      return;
    }
    const streamId = typeof frame['streamId'] === 'string' ? frame['streamId'] as string : '';
    foldFrame(streamId, (frame['value'] ?? frame) as Record<string, unknown>);
  });
  socket.addEventListener('error', () => stop('socket-error'));
  deadlineHandle = setTimeoutImpl(() => stop('deadline'), request.timeoutMs);

  return settled;
}
