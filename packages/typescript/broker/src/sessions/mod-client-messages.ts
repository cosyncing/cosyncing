/**
 * The client messages a synced Claude session routes to its mod, as one callable function.
 *
 * This block used to live inline in the runtime's client-message loop, which meant the only way
 * to test it was to reach around it. Every suite that claimed to cover an app answer called
 * `ClaudeModService.send` or `answerQuestion` directly, in a shape the app never sends, and the
 * production path stayed broken while the suite stayed green. Pulling the routing out costs the
 * runtime three calls and buys a seam: the real frames from `outbound_frame.dart`, the real
 * service, the real connection, and the real socket under them.
 *
 * Three rules live here, and each is a case in `test:claude-mod-seam`:
 *
 * - A hold is answered by the broker, not by the adapter connection. The adapter never saw the
 *   request, so `respondPermission` on it would close a card the transcript does not contain.
 * - A question answer is *converted* here, against the questions the hold carries. The app sends
 *   positions; Claude's tool takes `{ [question text]: answer }`; only the hold knows which
 *   position belongs to which question.
 * - Nothing is reported as delivered when it was not. An answer that arrived too late is said
 *   out loud, because the alternative is the user believing a question they can see is still
 *   open has been answered.
 */

import type { ClaudeModService } from './claude-mod-service.ts';
import { isModCardRequestId } from './mod-holds.ts';

/** The connection, as far as this routing needs it. Everything else is the adapter's business. */
export interface ModRoutableConnection {
  tool: string;
  id: string;
  respondPermission: (requestId: string, decision: string) => Promise<void> | void;
  answerQuestion?: (requestId: string, answers: string[][]) => Promise<void> | void;
  rejectQuestion?: (requestId: string) => Promise<void> | void;
}

export type ModRoutedMessage =
  | { kind: 'approve'; requestId: string; decision: string }
  | { kind: 'answer'; requestId: string; answers?: string[][] }
  | { kind: 'reject-question'; requestId: string };

export interface ModRouteDeps {
  service: ClaudeModService;
  conn: ModRoutableConnection;
  /** Say something to the seat that asked. A `notice` frame, shaped by the client contract. */
  send: (frame: Record<string, unknown>) => void;
}

/** The mod speaks for Claude rows only; another agent's same-shaped id is never diverted. */
function claudeRow(deps: ModRouteDeps): boolean {
  return deps.conn.tool === 'claude';
}

/** Only a Claude row with a hold behind this request id is mod business. */
function heldByMod(deps: ModRouteDeps, requestId: string): boolean {
  return claudeRow(deps) && deps.service.isHeld(deps.conn.id, requestId);
}

/**
 * A mod card that is no longer held: answered, expired, replaced by a resumed process, or a
 * read-only explanation that never held anything. Still the mod's, so it is refused here and said
 * out loud. Falling through handed it to an adapter connection that never drew the card, which
 * could only close it under a decision nobody made.
 */
function refusedAsSpent(deps: ModRouteDeps, requestId: string, message: string): boolean {
  if (!claudeRow(deps)) return false;
  // A minted id is the mod's by its shape; a question's card carries Claude's call id, which is the
  // mod's only if the broker drew a card under it.
  if (!isModCardRequestId(requestId) && !deps.service.drewCard(deps.conn.id, requestId)) return false;
  // A read-only card was never this app's to answer, so "already answered" would send the person
  // looking for an answer nobody gave. It says where the call is instead.
  deps.send({ kind: 'notice', message: deps.service.isReleasedCard(deps.conn.id, requestId) ? IN_TERMINAL : message });
  return true;
}

const IN_TERMINAL = 'That request is open in your terminal and can only be answered there. Nothing was sent.';
const SPENT_REQUEST = 'That request had already been answered, or its terminal had stopped waiting for it. Nothing was sent.';
const SPENT_QUESTION = 'That question had already been answered, or its terminal had stopped waiting for it. Nothing was sent.';
const UNSENDABLE_DECISION = 'The app can only allow or deny this call, so nothing was sent. Tap Allow or Deny, or answer it in your terminal.';
const MISFIT_ANSWER = 'That answer does not fit the question as Claude asked it, so nothing was sent. Pick from its options, or answer it in your terminal.';

/**
 * Handle an `approve` frame. False means the caller falls through to the adapter connection,
 * which is what every non-mod row and every non-held request must still do.
 */
export function routeModApprove(deps: ModRouteDeps, msg: { requestId: string; decision: string }): boolean {
  if (!heldByMod(deps, msg.requestId)) return refusedAsSpent(deps, msg.requestId, SPENT_REQUEST);
  if (deps.service.approve({ sessionId: deps.conn.id, requestId: msg.requestId, decision: msg.decision })) return true;
  // Refused, but still this request's to refuse: forwarding it to a connection that never saw
  // the hold would have it answer a permission prompt it knows nothing about. And refused out
  // loud, whatever the reason: a decision the mod cannot carry used to be dropped without a word,
  // leaving the seat that tapped believing it had answered.
  const reason = deps.service.refusalReason(msg.decision)
    ?? (heldByMod(deps, msg.requestId) ? UNSENDABLE_DECISION : SPENT_REQUEST);
  deps.send({ kind: 'notice', message: reason });
  return true;
}

/**
 * Handle an `answer` frame for a held `AskUserQuestion`. False falls through to the adapter's
 * own answer transport, which is correct for every other agent.
 */
export function routeModAnswer(deps: ModRouteDeps, msg: { requestId: string; answers?: string[][] }): boolean {
  if (!heldByMod(deps, msg.requestId)) return refusedAsSpent(deps, msg.requestId, SPENT_QUESTION);
  const answered = deps.service.answerQuestion({
    sessionId: deps.conn.id,
    requestId: msg.requestId,
    answers: msg.answers ?? [],
  });
  if (!answered) {
    // Still held means the answer was refused for its shape, not because the question had gone:
    // saying "already answered" there sent the person looking for an answer nobody gave.
    deps.send({ kind: 'notice', message: heldByMod(deps, msg.requestId) ? MISFIT_ANSWER : SPENT_QUESTION });
  }
  return true;
}

/** A `reject-question` on a still-held question closes the hold, not just the card. */
export function routeModRejectQuestion(deps: ModRouteDeps, msg: { requestId: string }): boolean {
  if (!heldByMod(deps, msg.requestId)) return refusedAsSpent(deps, msg.requestId, SPENT_QUESTION);
  // The terminal keeps the question; the app's card closes with it. Rejecting is the only verdict
  // this frame can honestly carry, and it is the one that leaves the human's picker in place.
  deps.service.approve({ sessionId: deps.conn.id, requestId: msg.requestId, decision: 'reject' });
  return true;
}
