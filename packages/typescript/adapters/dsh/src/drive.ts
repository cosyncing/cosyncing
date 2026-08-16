/**
 * Every write this package performs.
 *
 * All five of them live here rather than beside the read paths so the mutating
 * surface is one file long and can be read in a sitting: prompt, cancel, create,
 * rename, and the answer route that settles a question or an approval.
 *
 * Two properties matter more than the code:
 *
 *  - THE HOST IS THE SINGLE OWNER. dsh is server-first: the one `dsh web`
 *    process owns the append-only log, and every client — including its own
 *    browser UI — writes by RPC into it. So there is no ownership arbitration to
 *    perform here and no fork-on-write hazard; a write either lands in the one
 *    log or fails with a typed code.
 *  - ANSWERS ARE CORRELATED BY rpcId. A question or approval arrives as a
 *    server-request on the mux stream; the answer is a client-response echoing
 *    that exact rpcId. The payload carries the resource ids the host needs, but
 *    the ROUTING is the rpcId, and the host replays pending frames with the same
 *    rpcId on every reconnect.
 */
import type { PromptInput } from '@cosyncing/adapter-api';
import {
  describeDshFailure,
  type DshFailure,
  type DshPromptMode,
  type DshReceipt,
  type DshRpcClient,
} from './server.ts';
import type { DshPendingApproval, DshPendingQuestion } from './mapping.ts';

/** A write the host refused, carrying the native code so callers can branch. */
export class DshDriveError extends Error {
  constructor(action: string, readonly failure: DshFailure) {
    super(`dsh ${action} failed — ${describeDshFailure(failure)}`);
    this.name = 'DshDriveError';
  }

  /** The host's own typed error code, when the failure was a business error. */
  get code(): string | undefined {
    return this.failure.kind === 'rpc' ? this.failure.code : undefined;
  }

  /** A transport fault the caller may sensibly re-issue after a re-baseline. */
  get retryable(): boolean {
    return this.failure.kind === 'transport' && this.failure.retryable;
  }
}

/**
 * Attachments are refused rather than silently dropped.
 *
 * dsh does accept inline images on `session.prompt`, and durable attachments
 * through `session.attachment`, but neither is wired this round. Sending the
 * text alone would deliver a prompt that references a file the agent never
 * received, which reads to the user as the agent ignoring them.
 */
export const DSH_ATTACHMENT_UNSUPPORTED =
  'This build of the DeepSeek Harness integration cannot send files or images yet; send the text on its own.';

export interface DshPromptOptions {
  /** `queue` hands the message to the next turn claim; `steer` injects into the running one. */
  mode?: DshPromptMode;
  /** IANA zone the host stamps onto the request context. */
  clientTimeZone?: string;
  /** Called with the rpcId dsh will stamp on the resulting `user/message`. */
  onRpcId?: (rpcId: string) => void;
}

export class DshDriver {
  constructor(private readonly rpc: DshRpcClient) {}

  /**
   * Send one prompt.
   *
   * `mode` is the host's own queue discipline, not a cosyncing invention: an
   * idle session claims a queued message immediately, and a running one holds it
   * until the turn boundary — which is exactly the queued-then-delivered
   * lifecycle the canonical `user-message.queued` flag describes.
   */
  async prompt(sessionId: string, input: PromptInput, options: DshPromptOptions = {}): Promise<void> {
    if ((input.files?.length ?? 0) > 0 || (input.images?.length ?? 0) > 0) {
      throw new DshDriveError('prompt', {
        kind: 'rpc',
        code: 'attachment-unsupported',
        message: DSH_ATTACHMENT_UNSUPPORTED,
      });
    }
    const text = input.text ?? '';
    const outcome = await this.rpc.call<{ accepted: true }>(
      'session.prompt',
      {
        sessionId,
        mode: options.mode ?? 'queue',
        content: [{ type: 'text', text }],
        ...(options.clientTimeZone ? { clientTimeZone: options.clientTimeZone } : {}),
      },
      options.onRpcId ? { onRpcId: options.onRpcId } : undefined,
    );
    if (!outcome.ok) throw new DshDriveError('prompt', outcome.failure);
  }

  async cancel(sessionId: string): Promise<void> {
    const outcome = await this.rpc.call<{ accepted: true }>('session.cancel', { sessionId });
    if (!outcome.ok) throw new DshDriveError('cancel', outcome.failure);
  }

  /** Create a session inside an existing workspace. Returns the host-issued id. */
  async create(workspaceId: string): Promise<{ sessionId: string; agentPreset?: string }> {
    const outcome = await this.rpc.call<{ sessionId?: unknown; agentPreset?: unknown }>(
      'session.create',
      { workspaceId },
    );
    if (!outcome.ok) throw new DshDriveError('session create', outcome.failure);
    const sessionId = typeof outcome.value?.sessionId === 'string' ? outcome.value.sessionId : '';
    if (!sessionId) {
      throw new DshDriveError('session create', {
        kind: 'transport',
        reason: 'invalid-envelope',
        retryable: false,
        detail: 'session.create returned no sessionId',
      });
    }
    return {
      sessionId,
      ...(typeof outcome.value?.agentPreset === 'string' ? { agentPreset: outcome.value.agentPreset } : {}),
    };
  }

  /** Rename natively. The host normalizes the title and answers with what it accepted. */
  async rename(sessionId: string, title: string): Promise<string> {
    const outcome = await this.rpc.call<{ title?: unknown }>('session.rename', { sessionId, title });
    if (!outcome.ok) throw new DshDriveError('rename', outcome.failure);
    return typeof outcome.value?.title === 'string' ? outcome.value.title : title;
  }

  /**
   * Answer one question.
   *
   * `answers` arrives as one array of selections per question, in the order the
   * card presented them; the native ids captured at mapping time re-attach each
   * array to its question. The host validates STRICTLY — a label it never
   * offered is rejected as `bad-response` — so entries matching the question's
   * offered labels travel as `selected` and anything else travels as the wire's
   * `custom` free-text field (multiple free-text entries join as lines).
   *
   * For a single-select question the host also rejects `selected` and `custom`
   * TOGETHER, so at most one of the two survives: an explicit free-text entry
   * wins (it is the stronger signal of intent), otherwise the first offered
   * selection. For a multi-select question both may ride together,
   * deduplicated.
   */
  async answerQuestion(pending: DshPendingQuestion, answers: string[][]): Promise<DshReceipt> {
    const payload = {
      sessionId: pending.sessionId,
      answer: {
        answers: pending.ids.map((id, index) => {
          const given = [...new Set(answers[index] ?? [])];
          const labels = pending.optionLabels[index] ?? [];
          const selected = given.filter((entry) => labels.includes(entry));
          const custom = given.filter((entry) => !labels.includes(entry)).join('\n');
          if (pending.multiSelect[index] !== true) {
            return custom ? { id, selected: [], custom } : { id, selected: selected.slice(0, 1) };
          }
          return { id, selected, ...(custom ? { custom } : {}) };
        }),
      },
    };
    return this.settle('question answer', pending.rpcId, payload);
  }

  /**
   * Settle one approval. The wire has exactly two outcomes, so a session-wide
   * grant is mapped to a single allow rather than to a promise the host cannot
   * keep; the card advertises only the two real options.
   */
  async respondApproval(pending: DshPendingApproval, allow: boolean): Promise<DshReceipt> {
    return this.settle('approval', pending.rpcId, {
      sessionId: pending.sessionId,
      approvalId: pending.approvalId,
      outcome: allow ? 'allowed-once' : 'rejected',
    });
  }

  /**
   * The one answer path. A `not-pending` receipt is returned, not thrown:
   * another client answering first is normal in a multi-client product, and
   * the caller settles the local card itself — the resolved frame cannot be
   * relied on, because a resolution that happened while this client was
   * disconnected is never replayed.
   */
  private async settle(action: string, rpcId: string, value: unknown): Promise<DshReceipt> {
    const outcome = await this.rpc.respond(rpcId, value);
    if (!outcome.ok) throw new DshDriveError(action, outcome.failure);
    return outcome.value;
  }
}
