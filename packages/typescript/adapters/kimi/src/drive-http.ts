/**
 * The ONLY write door to a Kimi server, allowlisted BY CONSTRUCTION.
 *
 * {@link KimiReadOnlyHttp} proves "this cannot write" by exposing one GET-only
 * operation. The mirror-image property is proved here: {@link KimiDriveHttp}
 * exposes exactly ten named operations and has no generic `post(path, body)`
 * door, no verb parameter, and no escape hatch reaching the underlying fetch.
 * So the set of writes this adapter can perform is not a convention a later
 * refactor could widen — it is the list of methods on this class, and adding an
 * eleventh write means adding an eleventh method, in review, on purpose.
 *
 * Why the bar is that high: two processes writing one Kimi session silently
 * fork its journal. A terminal `kimi -S <id>` resuming a session cosyncing owns
 * appends to the same on-disk wire journal while the server re-folds history
 * from disk — the two writers never see each other's turns. Nine of the ten
 * methods are therefore reachable ONLY from a drive connection on a session
 * this process created (see the ownership model in `implementation.ts`), and a
 * proven foreign write demotes that connection to observe before another write
 * lands. The tenth, {@link KimiDriveHttp.renameSession}, is the reviewed
 * exception: a title is metadata the SERVER applies through its own
 * `ISessionMetadata.setTitle` and broadcasts as `session.meta.updated` — it
 * appends nothing to the wire journal, so it carries none of the fork risk the
 * other nine exist to prevent, and the adapter's rename hook may reach it for
 * any session the server lists.
 *
 * Transport policy is SHARED with the read door rather than restated: the same
 * bearer discipline, the same timeout, the same bounded streaming body read
 * (retention cap plus `reader.cancel()` past the ceiling), and the same
 * envelope decode. A write client with its own numbers would be a second,
 * quietly divergent transport policy for the same server.
 */
import {
  KIMI_HTTP_MAX_BODY_BYTES,
  KIMI_HTTP_TIMEOUT_MS,
  KIMI_OK,
  decodeKimiEnvelope,
  readBoundedBody,
} from './server.ts';

// ── Native request bodies (structural, exactly the upstream schema names) ────

/**
 * `POST /api/v1/sessions` — `sessionCreateSchema`
 * (`protocol/session.ts:73-78`, route `routes/sessions.ts:261-354`).
 *
 * `agent_config` is deliberately ABSENT. The schema accepts it and the handler
 * never reads it (verified: `routes/sessions.ts:275-353` destructures only
 * `metadata.cwd`, `workspace_id`, `title`, and the response always reports
 * `agent_config: {model: ''}` at `routes/sessions.ts:1194`), so sending a model
 * here would look like a model selection that silently did nothing. Model is a
 * per-prompt field on this server; see {@link KimiPromptSubmissionBody}.
 */
export interface KimiCreateSessionBody {
  title?: string;
  /** `cwd` must name an EXISTING directory; the server registers the workspace but never creates it. */
  metadata: { cwd: string };
}

/**
 * One content part of a prompt submission — the text, image, and file members
 * of upstream `messageContentSchema` (`protocol/message.ts:8-63`).
 *
 * Images go INLINE as base64 (`imageSourceSchema` kind `base64`); everything
 * byte-bearing and non-image goes through `POST /api/v1/files` first and rides
 * the prompt as a `file` part carrying the returned `file_id`
 * (`fileContentSchema`). The tool_use/tool_result/thinking members exist on the
 * wire for messages the SERVER writes; a client submission never carries them.
 */
export type KimiPromptContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { kind: 'base64'; media_type: string; data: string } }
  | { type: 'file'; file_id: string; name: string; media_type: string; size: number };

/** `POST /api/v1/sessions/{sid}/prompts` — `promptSubmissionSchema` (`protocol/rest-prompt.ts:46-64`). */
export interface KimiPromptSubmissionBody {
  content: KimiPromptContentPart[];
  model?: string;
  /** Free-form string upstream (`promptThinkingSchema` is `z.string().min(1)`), not an enum. */
  thinking?: string;
  permission_mode?: 'manual' | 'yolo' | 'auto';
  /**
   * Goal creation/control triggers, applied by the prompt service as the prompt
   * launches (`promptService.ts`, `pickAgentStatePatch`). `goal_objective` rides
   * the objective's own kickoff prompt; `goal_control` is accepted on the schema
   * but this adapter sends control through {@link KimiDriveHttp.controlGoal}
   * instead, because a pause/cancel must not enqueue a stray user message.
   */
  goal_objective?: string;
  goal_control?: 'pause' | 'resume' | 'cancel';
}

/**
 * `POST /api/v1/files` — one multipart `file` field (`routes/files.ts:88-131`).
 *
 * The door builds the form itself: the multipart field names are wire schema,
 * so they live here with the path rather than in the caller. `expires_in_sec`
 * and the `name` override field exist upstream and are deliberately unused —
 * the part's filename IS the name, and the store's default expiry is the
 * server's business.
 */
export interface KimiFileUpload {
  name: string;
  mediaType: string;
  bytes: Uint8Array;
}

/** Upload response `data` — `fileMetaSchema` (`protocol/file.ts`). Only the fields this adapter reads. */
export interface KimiUploadedFileMeta {
  id: string;
  name: string;
  media_type: string;
  size: number;
}

/**
 * Goal pause/resume/cancel through `POST /api/v1/sessions/{sid}/profile` — the
 * `agent_config` half of `updateSessionProfileRequestSchema`, dispatched by
 * `applySessionAgentConfig` (`routes/sessionAgentConfig.ts:70-84`) straight to
 * the goal service. Unlike a prompt-body `goal_control` this appends NOTHING to
 * the transcript: no user row, no turn — which is exactly what pausing or
 * cancelling a goal must not do.
 */
export interface KimiGoalControlBody {
  agent_config: { goal_control: 'pause' | 'resume' | 'cancel' };
}

/**
 * `POST /api/v1/sessions/{sid}/skills/{name}:activate` —
 * `activateSkillRequestSchema` (`protocol/rest-skill.ts`). The `attachments`
 * field exists upstream and is deliberately unused: a slash command carries an
 * argument string, and attachments belong to the prompt that carries them.
 */
export interface KimiSkillActivateBody {
  args?: string;
}

/** `POST /api/v1/sessions/{sid}/approvals/{id}` — `approvalResponseSchema` (`protocol/approval.ts:24-29`). */
export interface KimiApprovalResolveBody {
  decision: 'approved' | 'rejected' | 'cancelled';
  /** `'session'` is the only value the schema accepts (`protocol/approval.ts:8`). */
  scope?: 'session';
}

/** One answer for one question item — `questionAnswerSchema` (`protocol/question.ts:35-45`). */
export type KimiQuestionAnswer =
  | { kind: 'single'; option_id: string }
  | { kind: 'multi'; option_ids: string[] }
  | { kind: 'other'; text: string }
  | { kind: 'multi_with_other'; option_ids: string[]; other_text: string }
  | { kind: 'skipped' };

/** `POST /api/v1/sessions/{sid}/questions/{id}` — `questionResponseSchema` (`protocol/question.ts:51-55`). */
export interface KimiQuestionAnswerBody {
  answers: Record<string, KimiQuestionAnswer>;
}

/**
 * `POST /api/v1/sessions/{sid}/profile` — the title half of
 * `updateSessionProfileRequestSchema` (`sessionProtocol.ts`; route
 * `routes/sessionProfile.ts`).
 *
 * Only `title` is modeled. The schema also accepts `metadata`, `agent_config`,
 * and `permission_rules`, none of which this adapter has a reviewed use for —
 * the request type stays as narrow as the write it names. The schema requires
 * a non-empty string, so a CLEARED title is the caller's problem to resolve
 * into one, not something this body can express.
 */
export interface KimiRenameSessionBody {
  title: string;
}

// ── Outcomes ────────────────────────────────────────────────────────────────

/**
 * Nonzero envelope codes that mean THE WORK IS ALREADY DONE, not that the call
 * failed. All three answer HTTP 200 with a success-shaped `data` payload:
 *
 *  - 40902 `APPROVAL_ALREADY_RESOLVED` — another client answered first
 *    (`protocol/error-codes.ts:79`; also reused for questions,
 *    `routes/questions.ts:216-222`), `data {resolved:false}`.
 *  - 40903 `PROMPT_ALREADY_COMPLETED` — the turn had finished
 *    (`protocol/error-codes.ts:81`), `data {aborted:false}`.
 *  - 40909 `QUESTION_DISMISSED` — the dismiss SUCCEEDED
 *    (`protocol/error-codes.ts:93`, `routes/questions.ts:232-245`),
 *    `data {dismissed:true}`.
 *
 * They are returned rather than thrown, carrying their code, so the caller can
 * turn each into the right user-facing notice. Treating them as failures would
 * make an idempotent retry look broken to the user; swallowing them into a
 * plain success would lose the distinction the notices are built on.
 */
export const KIMI_IDEMPOTENT_WRITE_CODES = Object.freeze([40902, 40903, 40909] as const);

export function isKimiIdempotentWriteCode(code: number): boolean {
  return (KIMI_IDEMPOTENT_WRITE_CODES as readonly number[]).includes(code);
}

/** A write the server accepted, or declared already done. `code` is 0 for the former. */
export interface KimiWriteOutcome {
  code: number;
  data: unknown;
  requestId?: string;
}

export type KimiWriteFailure =
  | 'unauthorized'
  | 'unreachable'
  | 'too-large'
  | 'invalid-response'
  | 'http-error'
  | 'business-error';

/**
 * How far a server error message may travel into a thrown error.
 *
 * The message reaches a user-facing surface, and the envelope's `msg` is
 * written by another product: bounding it here is the same discipline every
 * read in this package applies to a body. 200 characters is one sentence of
 * explanation, which is what a caller can act on.
 */
export const KIMI_WRITE_MESSAGE_CAP = 200;

/**
 * A write that did not happen. Carries the machine-readable pieces (`reason`,
 * envelope `code`, HTTP `status`) so a caller can route an unauthorized answer
 * into the transport-generation machinery instead of parsing English.
 */
export class KimiWriteError extends Error {
  constructor(
    message: string,
    readonly reason: KimiWriteFailure,
    readonly code?: number,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'KimiWriteError';
  }
}

/**
 * Cross-realm-safe predicate, the same shape the adapter-api errors use: an
 * adapter and its tests can resolve different copies of this module, and class
 * identity does not survive that boundary.
 */
export function isKimiWriteError(error: unknown): error is KimiWriteError {
  return error instanceof KimiWriteError
    || (error instanceof Error && error.name === 'KimiWriteError' && 'reason' in error);
}

export function isKimiUnauthorizedWrite(error: unknown): boolean {
  return isKimiWriteError(error) && error.reason === 'unauthorized';
}

/**
 * The write door's injected fetch.
 *
 * Deliberately a SEPARATE type from {@link KimiFetch}: that one pins the GET
 * verb in its own signature, which is half of what makes the read door
 * structurally read-only, and widening it to a verb union would erase that
 * proof. The real `fetch` satisfies both; a test fake declares whichever door
 * it is standing in for.
 */
export type KimiWriteFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string | FormData; signal: AbortSignal },
) => Promise<{
  status: number;
  body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}>;

export interface KimiDriveHttpOptions {
  baseUrl: string;
  /** Bearer token read from `<KIMI_CODE_HOME>/server.token`. Never logged, never surfaced in evidence. */
  token?: string;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: KimiWriteFetch;
}

export class KimiDriveHttp {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly fetchImpl: KimiWriteFetch;

  constructor(options: KimiDriveHttpOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    if (options.token) this.token = options.token;
    this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : KIMI_HTTP_TIMEOUT_MS;
    this.maxBytes = options.maxBytes && options.maxBytes > 0 ? options.maxBytes : KIMI_HTTP_MAX_BODY_BYTES;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as ReturnType<KimiWriteFetch>);
  }

  /** The origin this client writes to. Safe to log; carries no credential. */
  get origin(): string {
    return this.baseUrl;
  }

  // ── The allowlist. Ten operations, no eleventh door. ──────────────────────

  /** Create a session. One of `workspace_id`/`metadata.cwd` is required; this adapter always sends cwd. */
  createSession(body: KimiCreateSessionBody): Promise<KimiWriteOutcome> {
    return this.#post('/api/v1/sessions', body);
  }

  /** Submit a prompt. NEVER rejects as busy — a prompt sent mid-turn is queued natively. */
  submitPrompt(sessionId: string, body: KimiPromptSubmissionBody): Promise<KimiWriteOutcome> {
    return this.#post(`/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts`, body);
  }

  /**
   * Cancel the active turn. The colon is a literal ACTION SUFFIX on the session
   * id, not a path separator (`routes/sessions.ts:716-905`, action list at
   * `:748`), so the id is encoded and the suffix appended after it.
   */
  abortSession(sessionId: string): Promise<KimiWriteOutcome> {
    return this.#post(`/api/v1/sessions/${encodeURIComponent(sessionId)}:abort`, {});
  }

  resolveApproval(
    sessionId: string,
    approvalId: string,
    body: KimiApprovalResolveBody,
  ): Promise<KimiWriteOutcome> {
    return this.#post(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`,
      body,
    );
  }

  answerQuestion(
    sessionId: string,
    questionId: string,
    body: KimiQuestionAnswerBody,
  ): Promise<KimiWriteOutcome> {
    return this.#post(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(questionId)}`,
      body,
    );
  }

  /** Dismiss a question. Succeeds with envelope code 40909 rather than 0; see {@link KIMI_IDEMPOTENT_WRITE_CODES}. */
  dismissQuestion(sessionId: string, questionId: string): Promise<KimiWriteOutcome> {
    return this.#post(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(questionId)}:dismiss`,
      {},
    );
  }

  /**
   * Rename a session. The one write reachable OUTSIDE a drive connection — see
   * the file header: the server applies the title to its own metadata document
   * and broadcasts `session.meta.updated`, so the journal-fork case the other
   * nine methods are gated against does not exist here.
   */
  renameSession(sessionId: string, body: KimiRenameSessionBody): Promise<KimiWriteOutcome> {
    return this.#post(`/api/v1/sessions/${encodeURIComponent(sessionId)}/profile`, body);
  }

  /**
   * Upload a file's bytes — `POST /api/v1/files`, one multipart `file` field
   * whose filename and content-type carry the name and media type
   * (`routes/files.ts:104-124`). The answer's `data` is a `FileMeta`; the
   * caller turns it into a prompt `file` content part. Session-less by design:
   * the store is server-global with its own expiry, so the upload appends
   * nothing to any session's journal.
   */
  uploadFile(file: KimiFileUpload): Promise<KimiWriteOutcome> {
    const form = new FormData();
    form.append('file', new Blob([file.bytes.slice()], { type: file.mediaType }), file.name);
    return this.#postMultipart('/api/v1/files', form);
  }

  /**
   * Pause, resume, or cancel the session's goal through the profile route's
   * `agent_config` dispatch. Shares the path with {@link renameSession} but not
   * its exemption: a goal control is answered for the session's agent, so it is
   * reachable only from a drive connection, like the other eight.
   */
  controlGoal(sessionId: string, body: KimiGoalControlBody): Promise<KimiWriteOutcome> {
    return this.#post(`/api/v1/sessions/${encodeURIComponent(sessionId)}/profile`, body);
  }

  /**
   * Activate a skill — starts a turn whose user row carries the
   * `skill_activation` origin (`routes/skills.ts`, `IAgentSkillService`). The
   * colon is the literal ACTION SUFFIX on the skill name, same convention as
   * {@link abortSession} uses on the session id.
   */
  activateSkill(sessionId: string, name: string, body: KimiSkillActivateBody): Promise<KimiWriteOutcome> {
    return this.#post(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/skills/${encodeURIComponent(name)}:activate`,
      body,
    );
  }

  // ── The single transport, private on purpose ──────────────────────────────

  /**
   * An ECMAScript PRIVATE method, and that is the whole allowlist mechanism: no
   * caller outside this class can name a path, so the reachable write set is
   * exactly the ten methods above.
   *
   * `#post` rather than `private post`, deliberately. TypeScript's `private` is
   * erased at compile time — the method still lands on the prototype and
   * `(client as any).post('/anything', body)` reaches it at runtime, which is a
   * review convention wearing a compiler's clothes. A `#` field is absent from
   * the prototype and unreachable by name, so the write set is closed in the
   * running program and not merely in the type checker. The structural suite
   * asserts the prototype surface for exactly this reason.
   */
  async #post(path: string, body: unknown): Promise<KimiWriteOutcome> {
    return this.#send(path, JSON.stringify(body), 'application/json');
  }

  /**
   * The multipart half of the transport, for {@link uploadFile} alone. No
   * `content-type` header: `fetch` sets it with the form's boundary, and a
   * header written here would REPLACE that and leave the body unparsable.
   */
  async #postMultipart(path: string, form: FormData): Promise<KimiWriteOutcome> {
    return this.#send(path, form);
  }

  /**
   * The one dispatch every write funnels through: timeout, bearer, bounded
   * body read, envelope decode. The body is already serialized — JSON by
   * {@link #post}, multipart by {@link #postMultipart} — so the verb and the
   * failure taxonomy live exactly once.
   */
  async #send(path: string, body: string | FormData, contentType?: string): Promise<KimiWriteOutcome> {
    let url: string;
    try {
      url = new URL(path.startsWith('/') ? path : `/${path}`, `${this.baseUrl}/`).toString();
    } catch {
      throw new KimiWriteError('unresolvable request url', 'invalid-response');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let status: number;
    let text: string;
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          ...(contentType ? { 'content-type': contentType } : {}),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body,
        signal: controller.signal,
      });
      status = response.status;
      // Refused on the STATUS alone, before a byte of body is read — the same
      // rule the read door follows. The body of an unauthorized answer carries
      // nothing this client acts on, and leaving the stream unread but open
      // keeps a server we have not authenticated feeding us for as long as it
      // likes, so the transport is torn down rather than merely ignored.
      if (status === 401 || status === 403) {
        controller.abort();
        throw new KimiWriteError('the Kimi server refused this credential', 'unauthorized', undefined, status);
      }
      const read = await readBoundedBody(response, this.maxBytes);
      if (read.outcome !== 'ok') {
        throw new KimiWriteError(`the Kimi server answer was ${read.outcome}`, read.outcome, undefined, status);
      }
      text = read.text;
    } catch (error) {
      if (isKimiWriteError(error)) throw error;
      throw new KimiWriteError('the Kimi server could not be reached', 'unreachable');
    } finally {
      clearTimeout(timer);
    }

    const envelope = decodeKimiEnvelope(text);
    if (envelope.outcome === 'invalid-response') {
      throw new KimiWriteError(
        'the Kimi server answered something that is not an envelope',
        status >= 400 && envelope.shape !== 'not-an-object' ? 'http-error' : 'invalid-response',
        undefined,
        status,
      );
    }
    if (envelope.outcome === 'unauthorized') {
      throw new KimiWriteError(
        boundedMessage(envelope.message) ?? 'the Kimi server refused this credential',
        'unauthorized',
        envelope.code,
        status,
      );
    }
    if (envelope.outcome === 'ok') {
      return { code: KIMI_OK, data: envelope.data, ...(envelope.requestId ? { requestId: envelope.requestId } : {}) };
    }
    // The three idempotent codes ride a nonzero envelope with a success-shaped
    // payload, so they are RESULTS, not failures. Everything else is a genuine
    // refusal and throws with its code attached.
    if (isKimiIdempotentWriteCode(envelope.code)) {
      return {
        code: envelope.code,
        data: (envelope as { data?: unknown }).data,
        ...(envelope.requestId ? { requestId: envelope.requestId } : {}),
      };
    }
    throw new KimiWriteError(
      boundedMessage(envelope.message) ?? `the Kimi server refused the request (code ${envelope.code})`,
      'business-error',
      envelope.code,
      status,
    );
  }
}

/** First line only, capped: an envelope `msg` is another product's text on a user-facing path. */
function boundedMessage(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const firstLine = message.split('\n', 1)[0]!.trim();
  if (!firstLine) return undefined;
  return firstLine.length > KIMI_WRITE_MESSAGE_CAP
    ? `${firstLine.slice(0, KIMI_WRITE_MESSAGE_CAP)}…`
    : firstLine;
}
