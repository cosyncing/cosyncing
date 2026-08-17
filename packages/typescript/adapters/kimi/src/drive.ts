/**
 * Broker-arbitrated Drive over one Kimi session THIS process created.
 *
 * Everything the observe connection does, this connection does too — the
 * bounded pull refresh, the cursor discipline, the transport generations, the
 * telemetry sidecar — and on top of it a narrow, enumerated set of writes.
 * Extending rather than forking is the point: a drive connection that read its
 * transcript differently from an observe connection would be a second Kimi
 * reader to keep correct.
 *
 * Three properties earn the right to write at all:
 *
 *  1. OWNERSHIP. Only sessions created through `KimiAdapter.createSession` in
 *     this process reach this class. Everything else — terminal-created, from
 *     a previous broker run, from another tool — is foreign and stays observe,
 *     because a session whose live owner is unknown must never gain a second
 *     writer.
 *  2. AN ALLOWLISTED DOOR. Writes go through {@link KimiDriveHttp}, which has
 *     six methods and no generic post.
 *  3. DIVERGENCE DETECTION. Ownership is an in-memory belief, and a terminal
 *     `kimi -S <id>` can silently falsify it at any moment: the CLI runs its
 *     own in-process event bus and journal (verified upstream), so its turns
 *     reach this connection through the REST re-fold and produce ZERO WS
 *     frames. When a user-role message appears that neither we nor the server
 *     can account for, this connection stops writing and says so — see
 *     {@link KimiDriveConnection.onWalkedRows}.
 *
 * Demotion is one-way and removes the session from the adapter's owned set, so
 * a diverged session cannot regain Drive by reattaching.
 */
import type {
  AgentMessage,
  CommandInput,
  CommandResult,
  ModeOption,
  ModelOption,
  PermissionDecision,
  PromptInput,
  SessionInfo,
  SlashCommand,
} from '@cosyncing/adapter-api';
import {
  KimiObserveConnection,
  type KimiObserveOptions,
  type KimiPendingSnapshot,
} from './observe.ts';
import { KimiReadOnlyHttp } from './server.ts';
import {
  isKimiIdempotentWriteCode,
  isKimiWriteError,
  type KimiDriveHttp,
  type KimiPromptSubmissionBody,
} from './drive-http.ts';
import {
  KIMI_FOREIGN_WRITER_REASON,
  boundedKimiErrorMessage,
  kimiDemotedControlState,
  mapKimiModelCatalog,
  mapKimiQuestionAnswers,
  mapKimiRunState,
  type KimiMappedRow,
  type KimiV1Session,
} from './mapping.ts';

// ── Constants ───────────────────────────────────────────────────────────────

/**
 * Prompts, echo ids, and correlation tokens this connection remembers.
 *
 * Each entry is one prompt the app sent through this connection. A user does
 * not send 256 prompts in a session without the older ones having long since
 * been echoed, fenced, and forgotten, so this is a leak bound, not a working
 * set. Oldest-first eviction is right for the same reason: the entry most
 * likely to be stale is the one submitted longest ago.
 */
export const KIMI_PROMPT_MEMORY_LIMIT = 256;

/**
 * User-message ids the divergence detector treats as accounted for.
 *
 * Sized well above the ids one attach's bounded history read can produce
 * (`KIMI_HISTORY_MAX_PAGES × KIMI_HISTORY_PAGE_SIZE` = 1000 native messages, of
 * which only the user-role ones land here), so a normal baseline never evicts
 * itself. An evicted id can at worst be re-suspected, which the confirmation
 * rule then has to prove all over again.
 */
export const KIMI_DIVERGENCE_ID_LIMIT = 1_024;

/**
 * Unexplained user messages tracked at once, in EITHER collection.
 *
 * One foreign writer produces one suspect per foreign prompt, and two or three
 * are already conclusive; a session generating dozens of unexplained prompts
 * has diverged whatever the exact count. Bounding this keeps a pathological
 * source from turning the detector into the leak it exists to prevent.
 *
 * ONE overflow rule for both collections, and it is DEMOTE rather than evict or
 * stop: the row that does not fit is the 65th prompt nobody can account for,
 * which is not a race. A bounded memory must never forgive what it cannot hold.
 */
export const KIMI_DIVERGENCE_SUSPECT_LIMIT = 64;

/**
 * Completed polls a suspect must survive before it is proof.
 *
 * Two, because ONE poll cannot distinguish a foreign write from REST simply
 * running ahead of the WS: the REST fold reads the journal from disk on every
 * request, while the server's own frames for the same turn are dispatched from
 * an in-process bus that may not have reached us yet. Surviving a second poll
 * with the stream demonstrably healthy and demonstrably silent is what turns
 * "we have not heard about this yet" into "the server never knew about this".
 */
export const KIMI_DIVERGENCE_CONFIRM_POLLS = 2;

/**
 * Interaction-reconciliation passes one invocation will spend.
 *
 * Coalescing alone does not end an incident whose stream keeps flapping: every
 * break landing during a pass buys another one, and two reads apiece against a
 * server that is already unwell is a loop this connection must not enter. Three
 * covers the case this exists for — a break, and one more during the reads it
 * triggered — with a pass to spare, and a stream that outruns it still has its
 * NEXT discontinuity to reconcile from.
 *
 * The ceiling and the reasoning mirror `KIMI_RESYNC_RECOVERY_PASS_MAX`
 * (`observe.ts`); it is a separate constant because it bounds a different
 * incident — two cheap card reads, not a deep force-loading walk.
 */
export const KIMI_INTERACTION_RECONCILE_PASS_MAX = 3;

/**
 * How long a CONTENT write waits for a stream that is down before refusing.
 *
 * Every write here depends on the socket for something the write itself cannot
 * carry: an approval card comes back over it, a foreign writer is detected
 * against it, and a turn's completion arrives on it. So a write with no stream
 * is not a write that merely runs unobserved — it is one whose consequences the
 * user cannot answer and this connection cannot police.
 *
 * Two seconds because this is a LOOPBACK handshake to a server the identity gate
 * has already spoken to, and because the cost of waiting longer lands on a user
 * who pressed send: a refusal they can retry beats a send button that hangs.
 * Shorter than `KIMI_LIVE_ATTACH_SOCKET_MS` (`implementation.ts`) for the same
 * reason — an attach is a background step, a prompt is not.
 */
export const KIMI_WRITE_STREAM_WAIT_MS = 2_000;

/** Said once, when driving stops. States the hazard, not the mechanism. */
export const KIMI_DIVERGENCE_MESSAGE =
  'Another program wrote to this Kimi session — most likely a terminal running `kimi -S`. '
  + 'cosyncing has stopped driving it and is now observing only: two writers on one Kimi session '
  + 'silently fork its history. Quit the other program and reopen this session to drive it again.';

/** Refusal text for every write attempted after demotion. */
export const KIMI_DEMOTED_REFUSAL =
  'this Kimi session is being written by another program, so cosyncing is observing it only';

/**
 * Refusal for a content write attempted with the safety stream down.
 *
 * Names the DEPENDENCY rather than the mechanism: the live stream is how an
 * approval request reaches the user and how a second writer is noticed, so a
 * write sent without it is a turn the user may not be able to answer and a
 * session this connection can no longer prove it owns alone. See
 * {@link KIMI_WRITE_STREAM_WAIT_MS}.
 */
export const KIMI_NO_STREAM_REFUSAL =
  'cosyncing is not connected to this Kimi session\'s live stream right now, so it will not send: '
  + 'approval requests arrive on that stream and it is also how cosyncing notices another program '
  + 'writing the same session. Try again in a moment.';

/**
 * Refusal while ANY prompt in this session is still unattributed.
 *
 * Deliberately silent about WHY the row is unattributed. A row first seen with
 * the stream down and a row first seen under a healthy stream are the same claim
 * from the user's side — cosyncing cannot yet prove it is the only writer — and
 * naming the outage would be plainly false for the healthy case, where the
 * stream is up and the row is simply unexplained.
 *
 * The connection is not claiming a foreign writer — it is claiming it cannot yet
 * rule one out, which is the state in which a second writer does its damage.
 */
export const KIMI_OPEN_PROVENANCE_REFUSAL =
  'cosyncing saw a prompt in this Kimi session that it cannot account for, and is re-verifying that '
  + 'nothing else is writing the session. It will not send until that settles, because two writers on '
  + 'one Kimi session silently fork its history.';

/** File and image input are a later round; the refusal says so rather than dropping the attachment. */
export const KIMI_NO_FILE_INPUT_MESSAGE =
  'sending files or images to Kimi is not supported yet; send the text prompt on its own';

/** Notices the stop command returns to its requester. */
export const KIMI_STOP_NOTICE = 'Stopped the running turn.';
export const KIMI_STOP_ALREADY_DONE_NOTICE = 'The turn had already finished.';

/**
 * The permission modes this server accepts, verbatim
 * (`promptPermissionModeSchema` — defined at
 * `agent-core-v2/src/app/sessionLegacy/sessionProtocol.ts:29`, re-exported
 * through `kap-server/src/protocol/rest-prompt.ts:29`).
 *
 * The broker validates a requested mode against {@link KimiDriveConnection.listModes}
 * before it reaches us; this list is the second gate, because a value that
 * slipped through would be rejected by the server as a schema violation and
 * cost the user their whole prompt rather than one ignored option.
 */
const KIMI_PERMISSION_MODES = Object.freeze(['manual', 'yolo', 'auto'] as const);

/**
 * The mode picker's options.
 *
 * Static because the server's enum is closed and carries no labels of its own.
 * `category` is the protocol's universal grouping, so the client can describe
 * the three postures without knowing what Kimi calls them.
 */
const KIMI_MODE_OPTIONS: readonly ModeOption[] = Object.freeze([
  { value: 'manual', label: 'Manual approvals', category: 'ask-permission' },
  { value: 'auto', label: 'Auto-approve tools', category: 'approve-for-me' },
  { value: 'yolo', label: 'Approve everything', category: 'full-access' },
] as const);

/**
 * The only command this connection offers.
 *
 * `kind: 'action'` rather than `'prompt'`: it hits an endpoint and starts no
 * turn. Rename, fork, compact, and undo all exist upstream as sibling action
 * suffixes on the same route and are deliberately NOT here — each needs its own
 * transcript semantics on the cosyncing side, and an action that silently
 * rewrote history would be worse than an absent one.
 */
const KIMI_STOP_COMMAND: SlashCommand = {
  name: 'stop',
  description: 'Stop the running turn',
  kind: 'action',
};

export interface KimiDriveOptions extends KimiObserveOptions {
  /**
   * A model the create request asked for, applied to the FIRST prompt.
   *
   * The server ignores `agent_config` on create (verified: the handler never
   * reads it), so a session's model can only be set per prompt. Carrying the
   * request forward here is what makes "create with model X" mean anything at
   * all; it is cleared once spent, so later prompts use whatever the session
   * settled on rather than pinning the create-time choice forever.
   */
  pendingModel?: PromptInput['model'];
  /**
   * Told when this connection stops driving, so the adapter can drop the
   * session from its owned set.
   *
   * Injected rather than reached for: the connection must not hold the adapter,
   * or a connection could revive, re-own, or re-attach a session behind the
   * adapter's back.
   */
  onDemoted?: (sessionId: string, reason: string) => void;
  /**
   * Told when the create-time model request has actually been SPENT — on the
   * first successful prompt — so the adapter can forget it.
   *
   * Same injection discipline as {@link onDemoted}, and for the same reason: the
   * connection must not hold the adapter. It exists because handing a connection
   * out is not spending anything. A connection that closed before its first
   * prompt (a client that opened the session and backed out, a socket that died
   * during attach) took the user's create-time choice with it, and the next
   * attach then ran the first turn on the session default with no way to know
   * a model had ever been asked for.
   */
  onModelConsumed?: (sessionId: string) => void;
  /** Injected only by tests: the write gate's stream ceiling. See {@link KIMI_WRITE_STREAM_WAIT_MS}. */
  writeStreamWaitMs?: number;
}

/** One suspected foreign write, and the stream conditions it was observed under. */
interface KimiDivergenceSuspect {
  /** The continuity mark at observation. A different one later means the stream had a hole. */
  mark: number;
  /** The server-liveness counter at observation. A different one later means the server was busy. */
  activity: number;
  /** Completed polls this suspect has survived. */
  polls: number;
  /**
   * Was this row first seen while the stream was NOT healthy, or interrupted by
   * a break since?
   *
   * Provenance changes what counts as an explanation. For a row observed under a
   * healthy, silent stream, "the view had a hole" is genuinely exculpatory — the
   * frame that would have accounted for it may have been in the hole. For a row
   * whose whole problem IS that the view had a hole, the same fact explains
   * nothing and must not forgive it.
   */
  unresolved?: boolean;
}

export class KimiDriveConnection extends KimiObserveConnection {
  private demoted = false;
  private readonly onDemoted?: (sessionId: string, reason: string) => void;

  /** `prompt_id`s submitted here that have not seen their terminal event. */
  private readonly pendingPrompts = new Set<string>();
  /** `user_message_id`s this connection caused, so their echoes are never suspects. */
  private readonly sentUserMessageIds = new Set<string>();
  /** `user_message_id` → the send's `clientMessageId`, stamped onto the echo row. */
  private readonly clientKeys = new Map<string, string>();
  private pendingModel?: PromptInput['model'];
  private readonly onModelConsumed?: (sessionId: string) => void;

  /** User-message ids that are accounted for: baselined by history, or already evaluated. */
  private readonly knownUserMessageIds = new Set<string>();
  private readonly suspects = new Map<string, KimiDivergenceSuspect>();
  /**
   * User rows this connection cannot attribute BECAUSE the stream was down,
   * each with the earliest {@link liveActivity} baseline it was held with.
   *
   * Held apart from {@link suspects} because they are a different claim. A
   * suspect is a row observed under a healthy, silent stream and is on its way
   * to a verdict; these are rows the detector never got to watch at all, and
   * nothing about them has been decided. They are not `known` — recording them
   * as accounted for is precisely the bug this set exists to undo — and they
   * leave here only for a verdict or for evidence, never for a timeout.
   *
   * The activity reading is the row's share of the explanation window. The
   * first healthy walk after a break ARMS these rows with the counter as it
   * stands at walk's end, and a frame that crossed that walk is already
   * counted in it — arming would make the suspect carry its own answer as its
   * baseline and confirm against it. Against the hold-time reading instead,
   * any server activity since the row was held is the server answering for
   * the row, whenever in the recovery it landed.
   *
   * Bounded at {@link KIMI_DIVERGENCE_SUSPECT_LIMIT}, and the overflow rule is
   * DEMOTE rather than evict: 64 prompts nobody can account for is not a race,
   * and a bounded memory must never forgive what it cannot hold.
   */
  private readonly unresolvedSuspects = new Map<string, number>();

  /** One repair at a time; a burst of discontinuities is one incoherent state, not N. */
  private repairing = false;
  /** One interaction reconciliation at a time; see {@link reconcileInteractions}. */
  private reconciling = false;
  /**
   * A reconciliation asked for while one was already running.
   *
   * Held rather than dropped, exactly like {@link heldRefresh}: the request is
   * evidence that something changed after the running pass took its snapshot,
   * and the pass in flight cannot answer for it. See
   * {@link reconcileInteractions}.
   */
  private reconcileRequested = false;
  /**
   * Waiters for the NEXT socket `open`, drained by {@link onStreamRestored}.
   *
   * A list rather than a one-shot promise because the waits are not all
   * first-open waits: the attach waits for the first stream, and every later
   * content write waits for whichever stream is current. A first-open-only
   * promise resolves once and then answers instantly forever, which is the same
   * class of mistake as reading `socket !== undefined` for liveness.
   */
  private readonly streamOpenWaiters = new Set<(opened: boolean) => void>();
  private readonly writeStreamWaitMs: number;

  /** Submit POSTs whose response has not landed yet. See {@link refresh}. */
  private inFlightSubmits = 0;
  /** A refresh the fence above held. Exactly one runs when the fence lifts. */
  private heldRefresh = false;

  constructor(
    info: SessionInfo,
    http: KimiReadOnlyHttp,
    wsUrl: string,
    token: string | undefined,
    options: KimiDriveOptions = {},
  ) {
    super(info, http, wsUrl, token, options);
    if (options.pendingModel) this.pendingModel = options.pendingModel;
    if (options.onDemoted) this.onDemoted = options.onDemoted;
    if (options.onModelConsumed) this.onModelConsumed = options.onModelConsumed;
    this.writeStreamWaitMs = options.writeStreamWaitMs && options.writeStreamWaitMs > 0
      ? options.writeStreamWaitMs
      : KIMI_WRITE_STREAM_WAIT_MS;
  }

  protected override get driving(): boolean {
    return !this.demoted && !this.closed;
  }

  /** True once a foreign writer was proven. Exposed for deterministic tests, never for the broker. */
  get demotedToObserve(): boolean {
    return this.demoted;
  }

  /**
   * The user rows the detector currently counts as accounted for.
   *
   * Exposed for deterministic tests, never for the broker — same rule as
   * {@link demotedToObserve} and for a sharper reason: FORGIVENESS IS INVISIBLE
   * from the outside. A row wrongly recorded here can never be suspected again,
   * and nothing a caller can do afterwards distinguishes that from a row that
   * was correctly cleared, so the only way to prove the overflow rows were not
   * forgiven is to look at the set itself.
   */
  get accountedUserMessageIds(): ReadonlySet<string> {
    return this.knownUserMessageIds;
  }

  // ── Cold attach ───────────────────────────────────────────────────────────

  /**
   * Start the stream and wait, BOUNDED, for a socket to actually OPEN.
   *
   * The answer is the attach's verdict, not a status line: a live attach whose
   * socket never opened has no way to deliver an approval card and no way to
   * see a second writer, and the caller REFUSES the attach on `false` (see
   * `implementation.ts`). Returning such a connection is what let a client be
   * handed mutation authority over a session it could neither monitor nor
   * answer — poll-only is an honest posture for OBSERVE, where nothing can be
   * written, and a dishonest one for Drive.
   *
   * Still bounded, and still never a bare await: a server that accepts the TCP
   * connection and then says nothing must cost the attach a ceiling, not the
   * attach itself.
   */
  async waitForStream(timeoutMs: number): Promise<boolean> {
    this.start();
    return this.awaitStreamOpen(timeoutMs);
  }

  /**
   * Resolve once the stream is up, or `false` at the ceiling. Registers a
   * waiter that {@link onStreamRestored} drains and {@link close} settles, so a
   * caller cannot be left waiting on a connection that will never open one.
   */
  private awaitStreamOpen(timeoutMs: number): Promise<boolean> {
    if (this.socketLive) return Promise.resolve(true);
    if (this.closed) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = (opened: boolean): void => {
        if (settled) return;
        settled = true;
        this.streamOpenWaiters.delete(waiter);
        if (timer) clearTimeout(timer);
        resolve(opened);
      };
      timer = setTimeout(() => waiter(false), timeoutMs);
      this.streamOpenWaiters.add(waiter);
    });
  }

  /** Tell every waiter how it ended. Called on `open` (true) and on `close` (false). */
  private settleStreamWaiters(opened: boolean): void {
    for (const waiter of [...this.streamOpenWaiters]) waiter(opened);
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  override async sendPrompt(input: PromptInput): Promise<void> {
    this.assertWritable();
    // Checked BEFORE the transport is touched, so a refused prompt issues no
    // HTTP at all: half-sending an attachment-bearing prompt as text-only would
    // silently drop the attachment the user was told about.
    if ((input.files?.length ?? 0) > 0 || (input.images?.length ?? 0) > 0) {
      throw new Error(KIMI_NO_FILE_INPUT_MESSAGE);
    }
    // An explicit per-prompt model wins over the create-time request: the user
    // picked it just now, and the pending one is a default from earlier.
    const model = input.model ?? this.pendingModel;
    const permissionMode = (KIMI_PERMISSION_MODES as readonly string[]).includes(input.permissionMode ?? '')
      ? input.permissionMode as KimiPromptSubmissionBody['permission_mode']
      : undefined;
    // Built BEFORE the door, so a refusal still costs zero HTTP and nothing
    // that could fail is left between the door's last check and the POST.
    const body: KimiPromptSubmissionBody = {
      content: [{ type: 'text', text: input.text }],
      ...(model?.modelID ? { model: model.modelID } : {}),
      // Upstream `thinking` is a free string, not an enum, so the canonical
      // reasoning effort passes through as itself.
      ...(model?.reasoningEffort ? { thinking: model.reasoningEffort } : {}),
      ...(permissionMode ? { permission_mode: permissionMode } : {}),
    };
    // THE SUBMISSION FENCE opens INSIDE the write's own frame, one statement
    // before the POST leaves. Upstream can publish `prompt.completed` for a turn
    // it blocked or failed BEFORE this request's response is written
    // (`promptService.ts:141-148` races the launch against the completion, and
    // `:274-278` completes a hook-blocked prompt inside that race, all before
    // `routes/prompts.ts:285` sends the reply). That event is a refresh trigger,
    // and a refresh landing here would walk the user row this very call is about
    // to learn the id of — delivering it with no `clientKey`, so the client's
    // optimistic bubble never converges and the row shows twice, and briefly
    // showing our own echo to the detector as a prompt nobody sent.
    //
    // Raised in the callback rather than before the door because a REFUSED write
    // never runs the callback: a door that turned the prompt away would otherwise
    // leave the fence standing over a POST that never happened, holding every
    // transcript walk on this connection until another submit closed it.
    let fenced = false;
    let outcome;
    try {
      outcome = await this.withContentWrite((drive) => {
        this.inFlightSubmits += 1;
        fenced = true;
        return drive.submitPrompt(this.info.id, body);
      });
    } catch (error) {
      if (fenced) this.endSubmission();
      throw error;
    }
    // Cleared only on SUCCESS: a submit that threw never applied the model, and
    // dropping it there would silently lose the create-time choice.
    //
    // The adapter's copy is dropped HERE too, at the moment the request is
    // actually spent, rather than when this connection was handed out. Both
    // halves move together on purpose: a session whose connection still holds
    // the request while the adapter has forgotten it (or the reverse) is a
    // create-time model that applies to one attach and not the next. This fires
    // for a prompt that carried an EXPLICIT model as well — the user chose
    // something else for the session's first turn, so the create-time default
    // has been answered and pinning it onto turn two is the bug the clearing
    // exists to prevent.
    this.pendingModel = undefined;
    this.onModelConsumed?.(this.info.id);
    const data = (outcome.data ?? {}) as { prompt_id?: unknown; user_message_id?: unknown };
    if (typeof data.prompt_id === 'string' && data.prompt_id) {
      boundedAdd(this.pendingPrompts, data.prompt_id, KIMI_PROMPT_MEMORY_LIMIT);
    }
    if (typeof data.user_message_id === 'string' && data.user_message_id) {
      boundedAdd(this.sentUserMessageIds, data.user_message_id, KIMI_PROMPT_MEMORY_LIMIT);
      // Accounted for by construction, so the echo can never look foreign.
      boundedAdd(this.knownUserMessageIds, data.user_message_id, KIMI_DIVERGENCE_ID_LIMIT);
      // ...including retroactively. A submit whose response was slower than the
      // refresh that walked its row leaves that row sitting in the unresolved
      // set (or as a promoted suspect); the id arriving here is the evidence
      // that resolves it, and it resolves it at whatever point it lands.
      this.exonerate(data.user_message_id);
      if (input.clientMessageId) {
        boundedSet(this.clientKeys, data.user_message_id, input.clientMessageId, KIMI_PROMPT_MEMORY_LIMIT);
      }
    }
    // Nothing synthetic is emitted here. The server writes the user-message row
    // itself and the refresh delivers it; a locally invented echo would be a
    // second row for one prompt the moment the real one arrived.
    //
    // The fence closes LAST, with the correlation recorded: the held refresh
    // that runs from here can no longer mistake this connection's own echo for
    // an uncorrelated row, which is the whole point of holding it.
    this.endSubmission();
  }

  override async respondPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    // Built BEFORE the door, like every other content write's body: a refusal
    // must cost zero HTTP, and nothing may sit between the door's last check and
    // the POST.
    const body = decision === 'reject'
      ? { decision: 'rejected' as const }
      : decision === 'approve-session'
        // `'session'` is the only scope the schema accepts; it is what makes an
        // approval apply to later calls of the same tool in this session.
        ? { decision: 'approved' as const, scope: 'session' as const }
        : { decision: 'approved' as const };
    let claimed = false;
    let outcome;
    try {
      // 40902 means another client answered first. The card is already settled,
      // so this is the outcome the caller asked for, not a failure to report.
      outcome = await this.withContentWrite((drive) => {
        // Recorded IN THE WRITE'S OWN FRAME, one statement before the POST: the
        // resolution event can arrive while the request is still in flight, and
        // a resolution we caused must never be reported to the client as
        // somebody else's. A door refusal never runs this, so it leaves no claim
        // behind for a card this connection did not answer.
        this.selfResolvedRequests.add(requestId);
        claimed = true;
        return drive.resolveApproval(this.info.id, requestId, body);
      });
    } catch (error) {
      if (claimed) this.selfResolvedRequests.delete(requestId);
      throw error;
    }
    // ...but the claim above is then FALSE: the decision the server broadcasts
    // is the other client's, not ours. Releasing the claim is what makes the
    // resolution report as `'external'`, which is exactly what it was. Keeping
    // it would attribute a terminal user's reject to this user's approve — the
    // right outcome shown under the wrong hand.
    if (isKimiIdempotentWriteCode(outcome.code)) this.selfResolvedRequests.delete(requestId);
    // Settled either way — by us, or by whoever won the 40902 race — so the card
    // is no longer something a reconciliation could find missing and retract.
    this.openInteractions.delete(requestId);
  }

  async answerQuestion(requestId: string, answers: string[][]): Promise<void> {
    this.assertWritable();
    const record = this.questionRecords.get(requestId);
    // Refused BEFORE any HTTP: without the native item and option ids there is
    // nothing to send but invented ones, and an invented option id is a wrong
    // answer delivered confidently.
    if (!record) {
      throw new Error(`kimi cannot answer question ${requestId}: its options are no longer known to this connection`);
    }
    // Translated BEFORE the transport is touched, and deliberately not inside
    // the call closure below. `mapKimiQuestionAnswers` is the fail-closed gate
    // for an unkeyable question and for a selection the native union cannot
    // express, and a refusal that had already resolved a write client would have
    // spent an identity round-trip on a call it was never going to make — so
    // "zero HTTP" would stop being literally true.
    const body = { answers: mapKimiQuestionAnswers(record, answers) };
    let claimed = false;
    try {
      await this.withContentWrite((drive) => {
        this.selfResolvedRequests.add(requestId);
        claimed = true;
        return drive.answerQuestion(this.info.id, requestId, body);
      });
    } catch (error) {
      if (claimed) this.selfResolvedRequests.delete(requestId);
      throw error;
    }
    this.questionRecords.delete(requestId);
    this.openInteractions.delete(requestId);
  }

  async rejectQuestion(requestId: string): Promise<void> {
    let claimed = false;
    try {
      // Dismiss reports success as envelope code 40909, which the write client
      // already classifies as an outcome rather than an error.
      await this.withContentWrite((drive) => {
        this.selfResolvedRequests.add(requestId);
        claimed = true;
        return drive.dismissQuestion(this.info.id, requestId);
      });
    } catch (error) {
      if (claimed) this.selfResolvedRequests.delete(requestId);
      throw error;
    }
    this.questionRecords.delete(requestId);
    this.openInteractions.delete(requestId);
  }

  async listCommands(): Promise<SlashCommand[]> {
    return [KIMI_STOP_COMMAND];
  }

  async runCommand(name: string, _args?: string, _input?: CommandInput): Promise<CommandResult> {
    // `abort` is accepted as an alias for the same reason OpenCode accepts it:
    // it is what the stop affordance is called on several surfaces, and a
    // command that exists under one name and not the other is a broken button.
    if (name !== 'stop' && name !== 'abort') {
      throw new Error(`kimi has no '${name}' command`);
    }
    this.assertWritable();
    // EXEMPT from the content-write gate, uniquely and deliberately. Every other
    // write ADDS something a user then has to be able to answer; this one takes
    // something back — it is the defensive write, the way out of a turn that is
    // running away. Refusing it because the safety stream is down would leave a
    // runaway turn running for exactly as long as the outage lasts, which is the
    // opposite of what the gate is protecting. `closed` and `demoted` still
    // refuse it (see `assertWritable`): a session with a proven second writer
    // must receive nothing at all, including an abort.
    const drive = await this.writeClient();
    const outcome = await this.write(() => drive.abortSession(this.info.id));
    if (isKimiIdempotentWriteCode(outcome.code)) return { notice: KIMI_STOP_ALREADY_DONE_NOTICE };
    // The session-level abort answers `{aborted:true}` unconditionally in
    // 0.35.0 — even when idle, where it is a no-op — so a `false` can only come
    // from a server that reports honestly. Reading the field rather than
    // assuming it keeps the notice correct if that ever changes.
    const aborted = (outcome.data as { aborted?: unknown } | undefined)?.aborted;
    return { notice: aborted === false ? KIMI_STOP_ALREADY_DONE_NOTICE : KIMI_STOP_NOTICE };
  }

  async listModels(): Promise<ModelOption[]> {
    if (this.transportInvalid && !(await this.ensureTransport())) return [];
    const result = await this.transport.http.getJson<unknown>('/api/v1/models');
    if (!result.ok) {
      this.noteUnauthorized(result.reason);
      return [];
    }
    return mapKimiModelCatalog(result.data);
  }

  async listModes(): Promise<ModeOption[]> {
    return [...KIMI_MODE_OPTIONS];
  }

  // ── The submission fence ──────────────────────────────────────────────────

  /**
   * Hold the transcript walk while a submit POST is in flight.
   *
   * Every path that could deliver this connection's own user row funnels through
   * {@link KimiObserveConnection.refresh} — the poll tick, the WS refresh
   * triggers, the socket-close recovery, the idle settle — so holding it here
   * holds all of them with one gate rather than one guard per trigger.
   *
   * Held, never dropped: the flag records that something asked, and exactly ONE
   * walk runs when the fence lifts (see {@link endSubmission}). Dropping the
   * request instead would lose the very refresh the `prompt.completed` asked
   * for, and an immediately-blocked turn would then sit unshown until the next
   * tick. Counted rather than boolean because a client may submit again while
   * the first POST is still out.
   *
   * NOT held: {@link KimiObserveConnection.getHistory} (the client attach flow
   * reads an authoritative page and seeds its own dedupe — it is not the live
   * tail and cannot deliver an uncorrelated echo twice) and the run-state repair
   * (a session-row read, no rows in it).
   */
  override async refresh(): Promise<void> {
    // THE RECONCILE RETRY RIDES HERE, and deliberately ahead of the fence: a
    // reconciliation is two cheap card reads that have nothing to do with the
    // transcript walk the fence holds, and a fenced refresh returning early
    // would otherwise strand the retry for as long as a submit is in flight.
    //
    // Every poll tick and every lifecycle trigger funnels through this method,
    // so the pacing is already the poll interval and the bound is already the
    // pass ceiling — no new timer, and at most ONE start per call, because
    // `reconcileInteractions` takes its `reconciling` flag synchronously. A
    // closed or demoted connection starts nothing: `driving` answers false for
    // both, which is also what cancels a retry that was pending when either
    // happened.
    if (this.reconcileRequested && !this.reconciling && this.driving && this.primed) {
      void this.reconcileInteractions();
    }
    if (this.inFlightSubmits > 0) {
      this.heldRefresh = true;
      return;
    }
    await super.refresh();
  }

  /** Close one submission, and release the held walk when the last one closes. */
  private endSubmission(): void {
    this.inFlightSubmits -= 1;
    if (this.inFlightSubmits > 0 || !this.heldRefresh) return;
    this.heldRefresh = false;
    void this.refresh();
  }

  // ── Completion fencing and run-state repair ───────────────────────────────

  protected override onPromptSettled(promptId: string, aborted: boolean): void {
    const fenced = this.pendingPrompts.delete(promptId);
    if (!aborted || !fenced) return;
    // A stop the user asked for is a TURN INTERRUPTION, and the protocol proves
    // that with `semantic`, never with English text. Keyed by prompt id so a
    // `turn.ended reason:'cancelled'` for the same incident dedupes against it
    // rather than producing a second notice for one stop.
    this.emit(
      { type: 'notice', message: KIMI_STOP_NOTICE, semantic: { kind: 'interruption', reason: 'user' } },
      `notice:kimi-interrupted:${promptId}`,
    );
  }

  /**
   * Idle is the fence the client renders against, so it must arrive AFTER the
   * turn's last rows.
   *
   * The server orders `work_changed{busy:false}` after `turn.ended` with an
   * explicit microtask defer, which makes it a safe idle signal — but the rows
   * themselves come from REST, and the walk carrying them may still be running.
   * Settling the content first is what keeps "idle" from meaning "idle, and the
   * last thing the model said is still on its way".
   */
  protected override applyRunState(status: SessionInfo['status']): void {
    if (status !== 'idle' || this.closed) {
      super.applyRunState(status);
      return;
    }
    void this.settleContent().then(
      () => super.applyRunState('idle'),
      // A failed settle is a stale transcript, not a reason to withhold the
      // status: the fence still has to land or the client stays "working"
      // forever.
      () => super.applyRunState('idle'),
    );
  }

  protected override beforeRunState(status: SessionInfo['status']): void {
    // The server says nothing is running. Any fence still standing belongs to a
    // prompt whose terminal event we will never see.
    if (status === 'idle') this.pendingPrompts.clear();
  }

  /**
   * Reconcile after a discontinuity — a replacement socket, a new journal
   * epoch, or a conceded resync gap.
   *
   * A Kimi restart kills the in-flight turn AND loses the event journal, so the
   * `prompt.completed` that would have cleared a fence is never sent by anyone.
   * Without this the connection would hold that fence forever and the session
   * would read as permanently working. ONE read of the session row answers it,
   * and only when a fence is actually outstanding: a healthy reconnect costs
   * nothing.
   */
  protected override onStreamRestored(): void {
    // Everyone waiting on a stream — the attach, and every content write that
    // found it down — learns here that there is one.
    this.settleStreamWaiters(true);
    // Interactions the outage swallowed are re-read now, whether or not a
    // completion fence is standing: the two repairs answer different questions
    // (what is the turn doing / what is it waiting for) and a session can be
    // blocked on an approval with no prompt of ours outstanding at all.
    void this.reconcileInteractions();
    if (this.pendingPrompts.size === 0) return;
    void this.repairRunState();
  }

  /**
   * Re-read the OPEN interaction cards after a discontinuity, once.
   *
   * The events that carry an approval or a question exist only on the stream —
   * unlike transcript rows, which the REST re-fold recovers on the next tick,
   * an `event.approval.requested` that landed in a hole is simply gone. A
   * driving connection that missed one leaves the user looking at a session
   * that has stopped for no visible reason, with the answer it is waiting for
   * unreachable.
   *
   * Delivered through {@link KimiObserveConnection.emit} under the SAME
   * identities the socket path uses, so a card recovered here and then replayed
   * by the cursor is one card: the dedupe is the identity, not a timing
   * assumption. The reading itself comes from
   * {@link KimiObserveConnection.readPendingSnapshot}, the same reader
   * `getPending` uses — one reader, one mapping, one registry of native ids to
   * answer against.
   *
   * IT ALSO RETRACTS. A card this connection SHOWED and that the snapshot no
   * longer lists was settled while the view was down — another client of the
   * shared owner answered it, or the turn holding it ended — and the resolution
   * event that would have closed it is exactly what the outage swallowed.
   * Emitting nothing leaves an actionable card on screen forever, waiting for an
   * answer the server will refuse. See {@link applyPendingSnapshot}.
   *
   * COALESCED, NOT DROPPED, and bounded: one pass in flight, two reads per pass,
   * and only for a driving primed connection — at entry AND between passes, so a
   * demotion proven while a read was out ends the loop instead of buying another
   * pair of force-loading reads for a connection that can answer nothing. The
   * pass in flight when that happens still applies its reading; see
   * {@link applyPendingSnapshot}. A request arriving mid-pass sets
   * {@link reconcileRequested} and the pass runs again when it lands. Returning
   * instead — which is what this did — silently discarded the second stream
   * break: the reads already in flight were issued for the PREVIOUS generation
   * and describe the session as it was before it, so a card opened after their
   * snapshot stayed undiscovered until some later discontinuity happened to
   * reconcile it, and the user sat in front of a session stopped for no visible
   * reason.
   *
   * The generation is watched by OBJECT IDENTITY, because that is exactly how it
   * changes: {@link KimiObserveConnection.ensureTransport} replaces
   * `this.transport` wholesale, so a snapshot taken before the reads and
   * compared after them answers "was this pass reading the server we are now
   * talking to" without any bookkeeping of its own. It is the second trigger for
   * a rerun, alongside the flag.
   *
   * Run-state is NOT touched here; the fence repair owns that and duplicating it
   * would cost a third read to learn what it already knows.
   */
  private async reconcileInteractions(): Promise<void> {
    if (this.closed || !this.driving || !this.primed) return;
    // THE ZERO-SUBSCRIBER GUARD, the same rule {@link KimiObserveConnection.refresh}
    // applies and for the same reason: both pending reads FORCE-LOAD the session
    // into the Kimi server, making it a second live owner alongside any terminal
    // holding the session. A ceiling retry or a reconnect that lands after the
    // last client left would otherwise pay that coexistence cost for a session
    // nobody is watching — and it buys nothing, because there is no handler for
    // the card it would recover.
    //
    // The demand is HELD rather than dropped: the discontinuity happened, the
    // cards it swallowed are still missing, and the first refresh after a
    // subscriber returns runs the work. `getPending` is deliberately NOT guarded
    // this way — that is the broker explicitly asking on a client's behalf, not
    // a background read.
    if (!this.hasSubscribers) {
      this.reconcileRequested = true;
      return;
    }
    if (this.reconciling) {
      this.reconcileRequested = true;
      return;
    }
    this.reconciling = true;
    let passes = 0;
    try {
      let rerun = true;
      while (rerun && passes < KIMI_INTERACTION_RECONCILE_PASS_MAX) {
        // Consumed BEFORE the reads, so a request that arrives during them buys
        // the next pass rather than being cleared by the one it interrupted.
        this.reconcileRequested = false;
        passes += 1;
        const generation = this.transport;
        // Captured BEFORE the reads begin, and it is HALF of the retraction
        // rule. A card requested DURING the reads is legitimately absent from a
        // snapshot taken before it existed, so retracting on the snapshot alone
        // would cancel a live card the user is looking at right now. Only an id
        // open at BOTH points — before the reads and at apply time — and absent
        // from the snapshot has been proven settled.
        const openAtStart = new Map(this.openInteractions);
        try {
          const snapshot = await this.readPendingSnapshot();
          if (this.closed) return;
          // DISCARDED BEFORE ANYTHING IS EMITTED, if the generation behind this
          // read was replaced while it was in flight. The cards describe a
          // server this connection has stopped talking to, and a card that no
          // longer exists on the current one — an approval another client
          // resolved, or one belonging to a server process that is gone — would
          // be delivered as ACTIONABLE with nothing left that could ever retract
          // it: the resolution event that would have closed it was the old
          // server's to send. The rerun below re-reads the same question against
          // the generation that can answer it. A discarded read likewise
          // retracts NOTHING: its silence about a card is the old server's
          // silence, which is not evidence about this one.
          //
          // Only a GENERATION change discards. A rerun demanded by
          // {@link reconcileRequested} alone is an in-place break — same server,
          // same process — and those results are still true.
          //
          // An `undefined` snapshot is a read that failed, refused, or came back
          // half: no additions, no retractions, no registry changes at all.
          if (snapshot && this.transport === generation) {
            this.applyPendingSnapshot(snapshot, openAtStart);
          }
        } catch {
          // A failed reconciliation is a card still missing, not a dead
          // connection. A pending rerun still runs; otherwise the next
          // discontinuity reads again.
        }
        // A DEMOTION LANDS HERE THE SAME WAY A CLOSE DOES: the pass that crossed
        // it has applied its reading read-only, and there the incident ends. A
        // further pass would force-load the session into the Kimi server for a
        // connection the entry gate above would refuse outright — the same
        // force-load rationale, mid-loop rather than at entry — to recover cards
        // nobody here can answer. The rerun demand is left standing and is inert:
        // {@link refresh} consults `driving` before acting on it.
        if (this.closed || !this.driving) return;
        // Emission identities are unchanged across passes, so a card two passes
        // both see is still one card: the dedupe is the identity, never a count.
        rerun = this.reconcileRequested || this.transport !== generation;
      }
      // THE CEILING MUST NOT SWALLOW THE WORK. Exiting here with a rerun still
      // demanded — a request that landed during the last pass, or a generation
      // replaced under it — used to clear `reconciling` and drop the demand, so
      // without ANOTHER discontinuity the card nobody had read for was never
      // read for at all. The flag is left standing instead, and {@link refresh}
      // starts a FRESH invocation (fresh pass budget) on the next poll tick.
      if (rerun) this.reconcileRequested = true;
    } finally {
      this.reconciling = false;
    }
  }

  /**
   * Apply one validated snapshot: register, emit, then RETRACT — in ONE
   * synchronous block, so nothing can open or settle a card part way through it.
   *
   * The retraction is the half a pending read cannot perform on its own. A card
   * missing from the snapshot is either a card that was never shown — the
   * overwhelming majority, and nothing to do about them — or one THIS connection
   * put in front of the user and that has since been settled by another client
   * of the shared owner. {@link KimiObserveConnection.openInteractions} is what
   * separates the two, and the TWO-POINT MEMBERSHIP RULE is what keeps a card
   * that arrived mid-read out of it: an id must have been open before the reads
   * began AND still be open now.
   *
   * THE SAME RULE GATES THE REGISTRATION, in the other direction. An id that was
   * open before the reads and is gone now SETTLED while they were out — the
   * frame handler deleted it and emitted the resolution — so the snapshot listing
   * it is a reading the server took before that happened. Re-registering it
   * would put the card back in the open set and, for a question, restore the
   * record a late answer would then be sent against. It is skipped entirely: no
   * `present` entry, no emission, no record, no tracking. The retraction loop
   * needs nothing for it either — `!this.openInteractions.has(requestId)` already
   * reads it as settled-between-the-points and leaves the one resolution that
   * was already emitted standing alone. See
   * {@link KimiObserveConnection.settledDuringRead}, including the eviction edge
   * it accepts.
   *
   * The resolutions are the socket path's own, verbatim and under ITS
   * identities: an approval settles as `decision: 'external'` — the value the
   * protocol reserves for "settled by another client of the shared owner", which
   * is exactly what happened (see `mapKimiApprovalResolved`) — and a question
   * settles as a bare `question-resolved`. Same shape, same identity, so a WS
   * replay of the real resolution afterwards is the same resolution and not a
   * second one.
   *
   * A PASS THAT CROSSED A DEMOTION still applies, in READ-ONLY form. The reads
   * are awaited and {@link demoteToObserve} runs in place, so the posture can
   * flip between the reading and this block. The cards are still EMITTED — the
   * user should see what the session is blocked on, and the demotion has already
   * flipped the sessionInfo control state, so a read-only box is the consistent
   * story rather than a silence — but nothing is REGISTERED: no open-set entry,
   * no answering record. The retraction loop needs no guard of its own; the
   * demotion cleared {@link KimiObserveConnection.openInteractions}, so the
   * already-settled test short-circuits every entry it walks.
   */
  private applyPendingSnapshot(
    snapshot: KimiPendingSnapshot,
    openAtStart: ReadonlyMap<string, 'approval' | 'question'>,
  ): void {
    // THE POSTURE AT APPLY TIME, read once for the whole block. A pass that
    // CROSSED a demotion — the transcript walk proved a foreign writer while the
    // two card reads were out — still lands here, and its cards were mapped
    // against the posture the pass started with. Emitting them as they were read
    // would put actionable-looking boxes in front of the user on a connection
    // that now refuses every answer before it reaches the wire, and re-populate
    // the open set `demoteToObserve` had just cleared.
    //
    // HARDENING ONLY: it may ADD `readOnly`, never remove it. The question mapper
    // already marks an unanswerable card read-only for a driving connection, so
    // recomputing the flag from posture would strip that. Posture is monotone the
    // other way too — `driving` only ever flips false — so captured-driving,
    // applied-demoted is the only stale combination this can meet.
    const driving = this.driving;
    const present = new Set<string>();
    for (const card of snapshot.approvals) {
      // SETTLED WHILE THE READS WERE OUT, so the reading that still lists it was
      // taken before the resolution existed. Registering it would reopen a card
      // this connection has already closed, and nothing could close it again:
      // the resolution's emission identity is in the seen-set, so a later
      // retraction dedupes to silence.
      if (this.settledDuringRead(openAtStart, card.requestId)) continue;
      present.add(card.requestId);
      this.emit(driving ? card : { ...card, readOnly: true }, `permission-request:${card.requestId}`);
      // Tracked whether or not the emission deduped: a card this connection
      // already showed is still one it is answerable for, and a card recovered
      // here is one it is showing now. NOT on a pass that crossed a demotion:
      // this connection answers nothing more, so an entry here would only
      // re-fill the set the demotion cleared and re-arm a retraction rule for a
      // card it can never settle.
      if (driving) this.trackInteraction(card.requestId, 'approval');
    }
    for (const question of snapshot.questions) {
      // ...and for a question the damage is worse than a reopened card: the
      // record below is the ANSWERING surface, so restoring it would let a late
      // answer be sent confidently to a question the server has already settled.
      if (this.settledDuringRead(openAtStart, question.message.requestId)) continue;
      present.add(question.message.requestId);
      // The record is what makes the card ANSWERABLE — without the native item
      // and option ids there is nothing to send but invented ones. A pass that
      // crossed a demotion adds NONE: a demoted connection answers nothing, so a
      // fresh answering surface built from a stale reading buys the user nothing
      // and the registry an entry no path can spend. Records that were already
      // standing are left alone — the demotion does not retract them, and this is
      // only about not ADDING from a reading taken under the old posture.
      if (driving) this.rememberQuestion(question.record);
      this.emit(
        driving ? question.message : { ...question.message, readOnly: true },
        `question-request:${question.message.requestId}`,
      );
      if (driving) this.trackInteraction(question.message.requestId, 'question');
    }
    for (const [requestId, kind] of openAtStart) {
      if (present.has(requestId)) continue;
      // Settled between the two points — a WS resolution that landed during the
      // reads, or this connection's own answer — so it is already retracted and
      // this would be a second resolution for one card.
      if (!this.openInteractions.has(requestId)) continue;
      this.openInteractions.delete(requestId);
      // The claim goes with it: there is no resolution of ours left in flight to
      // attribute, and a stale claim would make the NEXT card with this id
      // report as ours.
      this.selfResolvedRequests.delete(requestId);
      if (kind === 'approval') {
        this.emit(
          { type: 'permission-resolved', requestId, decision: 'external' },
          `permission-resolved:${requestId}`,
        );
        continue;
      }
      // The registry entry is the answering surface, and answering a question
      // that no longer exists on the server is a wrong answer sent confidently.
      // Dropping it makes a late answer refuse as unknown, which is the truth.
      this.questionRecords.delete(requestId);
      this.emit({ type: 'question-resolved', requestId }, `question-resolved:${requestId}`);
    }
  }

  private async repairRunState(): Promise<void> {
    if (this.repairing || this.closed || this.pendingPrompts.size === 0) return;
    this.repairing = true;
    try {
      if (this.transportInvalid && !(await this.ensureTransport())) return;
      const result = await this.transport.http.getJson<KimiV1Session>(
        `/api/v1/sessions/${encodeURIComponent(this.info.id)}`,
      );
      if (!result.ok) {
        this.noteUnauthorized(result.reason);
        return;
      }
      if (this.closed) return;
      const row = result.data ?? {};
      const status = mapKimiRunState(row.busy, row.pending_interaction);
      // A row whose liveness fields are not readable is not a session that is
      // idle: it is a repair that found no evidence. The fence STAYS standing —
      // clearing it here would end a turn on the strength of a drifted payload,
      // which is exactly the failure the fence exists to survive. The repair has
      // already run for this discontinuity, so this returns rather than retrying
      // and cannot loop; the next discontinuity reads again.
      if (status === undefined) return;
      if (status === 'idle') {
        // `last_turn_reason` is the only trace a killed turn leaves. Saying so
        // is the difference between a turn that ended and a turn that vanished.
        if (row.last_turn_reason === 'failed') {
          this.emit(
            {
              type: 'error',
              message: boundedKimiErrorMessage(row.last_turn_reason) === undefined
                ? 'The Kimi turn failed.'
                : 'The Kimi turn failed while the live stream was down.',
            },
            `error:kimi-repair-failed:${this.streamMark}`,
          );
        }
      }
      // `applyRunState` clears the fences on idle and dedupes an unchanged
      // status, so a repair that finds the server still busy costs one read and
      // changes nothing.
      this.applyRunState(status);
    } finally {
      this.repairing = false;
    }
  }

  // ── Divergence detection ──────────────────────────────────────────────────

  protected override noteStreamBreak(): void {
    // Every suspect was recorded on the claim that the stream was healthy and
    // silent, and a break falsifies that claim for all of them at once. It does
    // NOT falsify the row: a prompt nobody can account for is still a prompt
    // nobody can account for, and the outage is the reason the question is open
    // rather than an answer to it. So the suspicion is MOVED, not dropped —
    // dropping it is what let an unexplained user row be quietly recorded as
    // known and then never be suspectable again, which is a foreign writer this
    // connection has agreed in advance never to notice.
    // The move carries each suspect's ORIGINAL activity baseline with it: a
    // frame observed after the row was first questioned is evidence the break
    // must not re-baseline away, or the reconnect would arm the row with its
    // own answer as the starting point and confirm against it.
    for (const [id, suspect] of this.suspects) this.addUnresolved(id, suspect.activity);
    this.suspects.clear();
    super.noteStreamBreak();
    // A break that happened IN PLACE — the socket is still open, so no `open`
    // event is coming — has no other moment to reconcile from. The oversized
    // frame this connection refused to parse may have been the approval card
    // itself.
    if (this.socketLive) void this.reconcileInteractions();
  }

  protected override onHistoryRows(rows: KimiMappedRow[]): void {
    // The authoritative read is the baseline: everything in it predates this
    // connection's watch and can never be evidence of a foreign write.
    for (const row of rows) {
      if (row.nativeRole !== 'user') continue;
      // ...with one exception, and it is the whole point of the unresolved set.
      // A re-read is not evidence about WHO wrote a row — it is the same REST
      // fold that produced the row in the first place — so baselining an
      // unattributed prompt here would forgive it for having been read twice.
      // A client reattaching (which is what runs this) must not be able to clear
      // a divergence suspicion.
      if (this.unresolvedSuspects.has(row.nativeMessageId)) continue;
      boundedAdd(this.knownUserMessageIds, row.nativeMessageId, KIMI_DIVERGENCE_ID_LIMIT);
    }
  }

  /**
   * Hold one row as unattributed, or DEMOTE if there is no room left to hold it.
   *
   * The cap is not a working set — one foreign writer produces one row per
   * foreign prompt, and two are already conclusive. Reaching 64 means the
   * session is producing prompts this connection cannot account for faster than
   * it can resolve them, which is the thing being watched for. Evicting the
   * oldest instead would silently forgive exactly the evidence the bound was
   * supposed to preserve.
   *
   * The {@link liveActivity} reading is taken NOW so the walk that later arms
   * the row can tell "the server has said nothing since the row was held"
   * from "the answer arrived before the watch could be armed". A row moved in
   * from {@link suspects} brings the baseline it was armed with instead — the
   * break that moved it is not a reason to forget activity already observed —
   * and a row that already HAS a baseline keeps it: the earliest reading is
   * the one that separates "nothing since the row was first questioned" from
   * later evidence.
   */
  private addUnresolved(id: string, activity = this.liveActivity): void {
    if (this.unresolvedSuspects.has(id) || this.sentUserMessageIds.has(id)) return;
    if (this.unresolvedSuspects.size >= KIMI_DIVERGENCE_SUSPECT_LIMIT) {
      this.demoteToObserve(KIMI_FOREIGN_WRITER_REASON);
      return;
    }
    this.unresolvedSuspects.set(id, activity);
  }

  /** Evidence arrived for one row: it was ours after all. Clears it from both sets. */
  private exonerate(id: string): void {
    this.unresolvedSuspects.delete(id);
    this.suspects.delete(id);
  }

  /**
   * The detector proper, run once per completed bounded walk.
   *
   * Restricted to USER-role rows on purpose. Every foreign turn begins with a
   * user prompt the server never saw, while assistant and tool rows arrive as
   * fragments whose absence from the stream proves nothing. It is also safe in
   * the other direction: `GET .../messages` folds the MAIN agent alone
   * (`services/messages/messageHistory.ts:125-136`, `ensureMainAgent`), so a
   * subagent's work cannot appear here as a REST-only row at all, and subagent
   * turns never carry a user origin regardless (`runAgentTurn.ts:31-34`).
   *
   * DISARMED until history has primed the connection: before the baseline
   * exists, every pre-existing user message in the transcript looks new.
   */
  protected override onWalkedRows(rows: KimiMappedRow[]): void {
    if (!this.driving || !this.primed) {
      // Still record what was seen, so arming the detector later does not
      // suspect rows that were already on screen.
      for (const row of rows) {
        if (row.nativeRole === 'user') boundedAdd(this.knownUserMessageIds, row.nativeMessageId, KIMI_DIVERGENCE_ID_LIMIT);
      }
      return;
    }
    const mark = this.streamMark;
    const activity = this.liveActivity;
    // A poll taken while the stream is down proves nothing in either direction:
    // poll-only rows are EXPECTED there, and the interval cannot be called
    // silent when nothing could have spoken.
    const healthy = this.socketLive;

    if (healthy) {
      for (const [id, suspect] of [...this.suspects]) {
        if (this.sentUserMessageIds.has(id)) {
          this.suspects.delete(id);
          continue;
        }
        // The server reported activity for this session in the interval, so it
        // ran something that can account for the row — REST simply arrived
        // ahead of the WS. Exonerating, whatever the row's provenance: this is
        // the server itself answering for it.
        if (suspect.activity !== activity) {
          this.suspects.delete(id);
          continue;
        }
        // The view had a hole. For a suspect first seen under a healthy stream
        // that is exculpatory — the frame accounting for it may have been in
        // the hole — but for one whose provenance is ALREADY a hole it explains
        // nothing, so it goes back to being unattributed rather than forgiven.
        //
        // In practice `noteStreamBreak` has moved the suspect out before a walk
        // can observe a stale mark; this is the same fact checked at the point
        // where it decides a verdict, in the same spirit as `answerQuestion`
        // re-proving an item id it was already told it had.
        if (suspect.mark !== mark) {
          this.suspects.delete(id);
          // Same rule as the move in `noteStreamBreak`: the hole does not
          // re-baseline the row, so the activity reading it was armed with
          // goes back into the hold with it.
          if (suspect.unresolved) this.addUnresolved(id, suspect.activity);
          continue;
        }
        suspect.polls += 1;
        if (suspect.polls >= KIMI_DIVERGENCE_CONFIRM_POLLS) {
          this.demoteToObserve(KIMI_FOREIGN_WRITER_REASON);
          return;
        }
      }

      // The stream is back. Rows the outage left unattributed now get what the
      // outage denied them: a real watch, under a stream that is demonstrably
      // up, starting from this interval. They carry their provenance with them
      // so a SECOND outage re-arms them rather than clearing them.
      for (const [id, heldActivity] of [...this.unresolvedSuspects]) {
        this.unresolvedSuspects.delete(id);
        if (this.sentUserMessageIds.has(id)) continue;
        // The explanation may already BE here: a frame that crossed THIS walk
        // is counted in `activity`, and a suspect armed with that reading as
        // its baseline would count the answer as part of the silence — it
        // would then confirm against the very frame that accounted for the
        // row. The row's open question is whether the server answered for
        // this session at any point since the row was held, and a moved
        // counter is that answer — the same REST-leads-WS exoneration the
        // suspects above get, measured from the hold instead of from the
        // arming. The row is accounted for, not armed.
        if (activity !== heldActivity) {
          boundedAdd(this.knownUserMessageIds, id, KIMI_DIVERGENCE_ID_LIMIT);
          continue;
        }
        this.suspects.set(id, { mark, activity, polls: 1, unresolved: true });
      }

      for (const row of rows) {
        if (row.nativeRole !== 'user') continue;
        const id = row.nativeMessageId;
        if (this.knownUserMessageIds.has(id) || this.sentUserMessageIds.has(id)) continue;
        if (this.suspects.has(id)) continue;
        // AT THE CAP, DEMOTE — the same rule `addUnresolved` follows, for the
        // same reason, and the 65th unexplained row is the trigger on both
        // sides. Stopping the loop instead let the tail below record the
        // overflow rows as KNOWN, which forgave them permanently: a burst large
        // enough to fill this map was the one shape of foreign write the
        // detector agreed in advance never to see. Returning here is what keeps
        // the tail from running at all, so no row of this walk is recorded.
        if (this.suspects.size >= KIMI_DIVERGENCE_SUSPECT_LIMIT) {
          this.demoteToObserve(KIMI_FOREIGN_WRITER_REASON);
          return;
        }
        this.suspects.set(id, { mark, activity, polls: 1 });
      }
    }

    // AFTER evaluation, never before: an id marked known first could never
    // become a suspect at all.
    for (const row of rows) {
      if (row.nativeRole !== 'user') continue;
      const id = row.nativeMessageId;
      const accounted = this.knownUserMessageIds.has(id) || this.sentUserMessageIds.has(id);
      // While the stream is DOWN, an unexplained row must not be recorded as
      // accounted for. Nothing has accounted for it — the detector was blind for
      // this interval, which is exactly why the row is being held instead. Rows
      // that are ours, or that were already known, register as they always did.
      if (!healthy) {
        if (!accounted) this.addUnresolved(id);
        else boundedAdd(this.knownUserMessageIds, id, KIMI_DIVERGENCE_ID_LIMIT);
        continue;
      }
      // ...and while it is UP, only a row that is accounted for or TRACKED may
      // be recorded. A tracked row — one in `suspects` — is on its way to a
      // verdict, and marking it known is what makes a later exoneration
      // permanent. An unexplained, untracked row is neither: with the cap above
      // demoting rather than breaking, this walk cannot produce one, and this
      // condition is the proof rather than a second policy.
      if (!accounted && !this.suspects.has(id)) continue;
      boundedAdd(this.knownUserMessageIds, id, KIMI_DIVERGENCE_ID_LIMIT);
    }
  }

  /**
   * Stop driving, in place, and say why.
   *
   * The connection stays OPEN and keeps observing: the user still wants to see
   * the session, and closing it would look like a crash. It sends NOTHING more
   * — no abort, no "cosyncing is leaving" prompt — because a write to a session
   * that already has two writers is the exact hazard this is avoiding.
   */
  private demoteToObserve(reason: string): void {
    if (this.demoted) return;
    this.demoted = true;
    this.suspects.clear();
    // Both sets: the verdict is in, and nothing after it turns on whether a
    // particular row was ever attributed. Leaving the unresolved set standing
    // would also keep the content-write gate refusing with the WRONG reason —
    // "still re-verifying" instead of "this session has another writer".
    this.unresolvedSuspects.clear();
    this.pendingPrompts.clear();
    // This connection answers nothing more, so it has nothing left to retract:
    // the cards it showed belong to whoever is still writing the session, and no
    // reconciliation pass STARTS on a demoted connection. A pass already in
    // flight is the one exception, and it is why the set stays empty rather than
    // merely being emptied here: it applies its reading read-only and registers
    // nothing (see {@link applyPendingSnapshot}), then stops the loop.
    this.openInteractions.clear();
    // The adapter's owned set is the single source of drive eligibility, so a
    // demoted session must leave it or the next attach would drive it again.
    this.onDemoted?.(this.info.id, reason);
    this.info.attachMode = 'observe';
    this.info.control = kimiDemotedControlState(
      this.info.control?.terminalSync
        ?? { supported: false, syncAvailable: false, active: false, reason },
    );
    this.emit(
      {
        type: 'metadata-update',
        key: 'sessionInfo',
        value: { status: this.info.status, attachMode: this.info.attachMode, control: this.info.control },
      },
      'metadata:kimi-demoted',
    );
    this.emit({ type: 'error', message: KIMI_DIVERGENCE_MESSAGE }, 'error:kimi-demoted');
  }

  // ── Echo correlation ──────────────────────────────────────────────────────

  protected override decorateRow(row: KimiMappedRow): AgentMessage {
    if (row.message.type !== 'user-message') return row.message;
    const clientKey = this.clientKeys.get(row.nativeMessageId);
    if (!clientKey) return row.message;
    // Consumed: the correlation exists to converge ONE optimistic bubble, and
    // the row it belongs to is delivered exactly once.
    this.clientKeys.delete(row.nativeMessageId);
    return { ...row.message, clientKey };
  }

  // ── Plumbing ──────────────────────────────────────────────────────────────

  /** Every mutating entry point starts here. A demoted or closed connection writes nothing. */
  private assertWritable(): void {
    if (this.demoted) throw new Error(KIMI_DEMOTED_REFUSAL);
    if (this.closed) throw new Error('this Kimi connection is closed');
  }

  /**
   * The second gate, for CONTENT writes only — everything that adds to the
   * session rather than stopping it.
   *
   * Two conditions, in cost order:
   *
   *  1. PROVENANCE. A prompt this connection cannot account for — under an
   *     outage or under a healthy stream, it makes no difference — means it
   *     cannot currently prove it is the session's only writer. Writing anyway
   *     is how a fork becomes two forks. The check is in-memory and instant, so
   *     it goes first.
   *  2. THE STREAM. A content write needs the socket that carries its approvals
   *     back and its foreign writers in. If it is down, ONE reconnect is
   *     attempted right here — waiting out a whole poll interval for the tick to
   *     do it would turn a one-second blip into a refused prompt — and the write
   *     proceeds if it comes up inside {@link KIMI_WRITE_STREAM_WAIT_MS}.
   *
   * NOT the first thing {@link withContentWrite} runs any more: the write client
   * is resolved ahead of this, so that a flagged invalidation is repaired before
   * the wait below waits on a socket that would then be retired with the
   * generation it belongs to. The zero-cost-refusal property is preserved by
   * that door's own in-memory provenance fast-check, which runs before it
   * touches the transport; the provenance check HERE is the one that catches a
   * suspect appearing during the stream wait.
   *
   * `runCommand('stop')` takes neither; see the comment at that call site.
   */
  private async assertContentWritable(): Promise<void> {
    if (this.provenancePending) throw new Error(KIMI_OPEN_PROVENANCE_REFUSAL);
    if (this.socketLive) return;
    // The waiter is registered BEFORE the reconnect is asked for: restoreSocket
    // yields, and a socket that opened while it did would otherwise resolve
    // against nobody and leave this write waiting out its whole ceiling.
    const opened = this.awaitStreamOpen(this.writeStreamWaitMs);
    void this.restoreSocket();
    if (await opened) {
      // Re-taken after the wait: the connection can have been demoted or closed
      // while it ran, and a write must not slip through on a gate it passed
      // before either happened.
      this.assertWritable();
      if (this.provenancePending) throw new Error(KIMI_OPEN_PROVENANCE_REFUSAL);
      return;
    }
    throw new Error(KIMI_NO_STREAM_REFUSAL);
  }

  /**
   * Is there a user row whose provenance is still open?
   *
   * EITHER collection non-empty answers yes, and the {@link
   * KimiDivergenceSuspect.unresolved} flag has no say here. A row held in
   * {@link unresolvedSuspects} and an ordinary suspect working through the
   * verdict machinery are the same sentence — "cosyncing has not yet
   * re-established that it is the only writer" — and where the doubt came from
   * changes nothing about what may be written during it. The flag still decides
   * the mark-movement asymmetry in {@link onWalkedRows}, which is a question
   * about EVIDENCE; this is a question about WRITES.
   *
   * The cost is that the transient REST-leads-WS race — the server's own turn
   * whose frames are behind the disk re-fold — suspends content writes for the
   * one poll it takes `activity` to move. That is accepted: the confirmation
   * window is precisely the interval in which a foreign write is plausible and
   * unrefuted, and it is not a state to send a prompt into. Writes resume the
   * moment the verdict machinery empties the collections — server activity
   * exonerates, our own late POST exonerates — and a demotion refuses through
   * {@link assertWritable} instead, with the stronger message.
   */
  private get provenancePending(): boolean {
    return this.unresolvedSuspects.size > 0 || this.suspects.size > 0;
  }

  /**
   * THE CONTENT-WRITE DOOR: both gates, the write client, and — in ONE
   * SYNCHRONOUS FRAME with the dispatch — the final re-checks.
   *
   * The operation is passed IN rather than the client handed OUT, and that is
   * the whole correctness argument. A door that returns a client leaves its
   * caller to dispatch after an await resumption, and an await resumption is a
   * separate microtask: a concurrent read's `ensureTransport` continuation can
   * run in that gap, replace `this.transport`, and retire the socket the gate
   * had just passed (`observe.ts`, `retireSocket`) — while the caller still
   * holds, and then invokes, the RETIRED client. The write then lands on a
   * server whose approvals come back somewhere nobody is listening and whose
   * foreign writers nothing is watching for.
   *
   * So the last five checks and the dispatch share one frame, with no `await`
   * between them. JS run-to-completion is what makes that airtight:
   * {@link write} invokes its callback synchronously, and
   * {@link KimiDriveHttp} dispatches `fetchImpl` before its own first await, so
   * nothing can be interleaved between the checks and the request leaving.
   *
   * ONE OF THOSE FIVE IS `transportInvalid`, and it is not redundant with the
   * identity check beside it. {@link KimiObserveConnection.noteUnauthorized}
   * only SETS the flag — the replacement and the socket retirement happen later,
   * whenever some caller runs `ensureTransport` — so a concurrent read's 401
   * continuation landing in the microtask gaps below leaves the transport object
   * unchanged and the socket still open. Identity and stream would both pass on
   * a generation the server has already refused.
   *
   * WHAT IT GUARANTEES, stated exactly: CHECK-TO-DISPATCH atomicity, never
   * check-to-response. A generation replaced after the request is on the wire is
   * a write this connection can no longer recall — bytes already sent cannot be
   * unsent — and the response path (`write` → `noteUnauthorized`) is what handles
   * that case, not this gate.
   *
   * TWO attempts, never a loop, and each attempt RESOLVES BEFORE IT WAITS: the
   * write client is acquired first — which is where a flagged invalidation is
   * repaired — and only then does the stream gate wait, so it waits for the
   * socket of the generation this write will dispatch through. That ordering is
   * what makes two attempts sufficient. Where the flag was already standing at
   * entry, attempt 1 re-verifies and dispatches; where it lands in the final
   * microtask gaps of attempt 1, the frame catches it and attempt 2 re-verifies
   * first, waits for the replacement socket, and dispatches; where the transport
   * is replaced during the wait itself (a dead socket that `restoreSocket`
   * repairs mid-wait, or a concurrent replacement), the stale `drive` fails the
   * identity check and attempt 2 re-gates. The accepted cost is that the
   * dead-socket path now spends one more gate pass than it did before, which is
   * still inside the two. A generation (or a socket) that will not settle across
   * both is a connection whose identity is not settling, so it refuses with the
   * stream refusal rather than chasing it — and a re-verification that FAILS
   * refuses earlier still, with {@link writeClient}'s own message.
   *
   * `runCommand('stop')` does not come through here; see the comment at that
   * call site for why the defensive write keeps its exemption.
   */
  private async withContentWrite<T>(operation: (drive: KimiDriveHttp) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.assertWritable();
      // CHEAP, IN-MEMORY, AND FIRST, so that a provenance refusal still costs
      // zero transport work now that the write client is resolved ahead of the
      // stream gate. `assertContentWritable` re-checks it after its wait, which
      // is the check that catches a suspect appearing DURING the wait.
      if (this.provenancePending) throw new Error(KIMI_OPEN_PROVENANCE_REFUSAL);
      // RESOLVES A FLAGGED INVALIDATION NOW, before anything waits on a socket.
      // `noteUnauthorized` only SETS `transportInvalid`; the replacement, the
      // socket retirement, and the immediate reopen all happen inside
      // `ensureTransport`, which is what this call runs. Doing it here — rather
      // than after the stream gate — is what makes the wait below wait for the
      // socket of the generation this write will actually dispatch through.
      const drive = await this.writeClient();
      await this.assertContentWritable();
      // ── NO AWAIT BEYOND THIS POINT. Everything below runs to completion. ──
      // The generation was refused while the gates above ran, and the swap has
      // NOT happened yet: `noteUnauthorized` sets the flag and returns, leaving
      // the same transport object in place with its socket still open. So the
      // identity check below would pass and the stream check would pass, on a
      // generation the server has already told this connection it will not
      // accept. The next attempt re-verifies first.
      if (this.transportInvalid) continue;
      // BY OBJECT IDENTITY, the same way `reconcileInteractions` watches it —
      // but anchored on the door being DISPATCHED THROUGH rather than on the
      // transport that held it, because that is the object the operation closes
      // over. `driveHttp` is a plain field assigned at transport construction,
      // never a getter, so the comparison is an identity test and nothing else;
      // it also catches a replacement to a generation with no write door at all.
      if (drive !== this.transport.driveHttp) continue;
      // Re-taken because both awaits above yield: the connection can have been
      // demoted or closed, and a prompt this connection cannot account for can
      // have appeared, since either gate passed.
      this.assertWritable();
      if (this.provenancePending) throw new Error(KIMI_OPEN_PROVENANCE_REFUSAL);
      // ...and the SOCKET can have died in the same gap, without the generation
      // changing at all. A content write with no live stream is exactly what the
      // stream gate refuses, so it is refused here too rather than sent into an
      // outage the gate happened to miss.
      if (!this.socketLive) continue;
      return this.write(() => operation(drive));
    }
    throw new Error(KIMI_NO_STREAM_REFUSAL);
  }

  /**
   * The CURRENT generation's write door, re-resolved first when the previous
   * one was refused.
   *
   * The same gate the reads use, for the same reason: a write sent with a
   * credential the server has already rejected is a write that did not happen,
   * reported as one that did.
   */
  private async writeClient(): Promise<KimiDriveHttp> {
    if (this.transportInvalid && !(await this.ensureTransport())) {
      throw new Error('the Kimi server could not be re-verified, so cosyncing will not write to it');
    }
    const drive = this.transport.driveHttp;
    if (!drive) throw new Error('this Kimi connection has no write client');
    return drive;
  }

  /**
   * Close, and tell every stream waiter it is over.
   *
   * A closed connection opens no further socket, so an attach or a write still
   * waiting on one would otherwise sit out its whole ceiling to learn what this
   * call already knows.
   */
  override async close(): Promise<void> {
    await super.close();
    this.settleStreamWaiters(false);
  }

  /** Route an unauthorized write into the SAME transport invalidation the reads use. */
  private async write<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (isKimiWriteError(error) && error.reason === 'unauthorized') this.noteUnauthorized('unauthorized');
      throw error;
    }
  }
}

/** Insertion-ordered add with an oldest-first ceiling. Sets iterate in insertion order. */
function boundedAdd(set: Set<string>, value: string, limit: number): void {
  set.add(value);
  while (set.size > limit) {
    const oldest = set.values().next();
    if (oldest.done) break;
    set.delete(oldest.value);
  }
}

function boundedSet(map: Map<string, string>, key: string, value: string, limit: number): void {
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}
