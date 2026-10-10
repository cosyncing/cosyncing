/**
 * The live Claude connection: the app's side of a session whose terminal is the writer.
 *
 * The transcript is still the whole content stream, so history and tail come from the same
 * read-only connection the Observe row has always used. What a live attach adds is the right to
 * write, and the mod is the only thing that can carry a write into a running Claude. So every
 * mutation here becomes one command handed to the broker's queue for that session, and nothing
 * else: no spawn, no stdin, no second process on the transcript.
 *
 * Three rules are the reason this is its own class rather than a few branches in the observe
 * connection:
 *
 * - A refused command is said out loud. `sendPrompt` that quietly drops the text is the worst
 *   failure available here — the user typed something and the transcript will never show it. The
 *   broker's queue can be full, the registration can have gone stale between the roster frame and
 *   the send, and both are the user's business.
 * - Steering is a DIFFERENT command from a prompt, and it is gated. A mid-turn `session.append`
 *   lands as an `isMeta` transcript row; until the app renders that row as steering, a steer is
 *   a message the user can send and then not see.
 * - A hold's card is not this connection's to answer. The broker's hold store owns the verdict
 *   and the socket reply carries it, so `respondPermission` here only closes a card the app
 *   already decided. It never invents a verdict.
 */

import type {
  AgentMessage,
  AgentMessageHandler,
  CommandResult,
  HistorySourceIdentity,
  ModeOption,
  ModelOption,
  PermissionDecidedBy,
  PermissionDecision,
  PermissionModeName,
  PermissionReleaseReason,
  PromptInput,
  SessionConnection,
  SessionControlState,
  SessionInfo,
  SlashCommand,
  Unsubscribe,
} from '@cosyncing/adapter-api';
import { ClaudeObserveConnection } from './implementation.ts';
import {
  claudeModCommandRefusal,
  type ClaudeModCardNote,
  type ClaudeModCommand,
  type ClaudeModCommandResult,
} from './mod-presence.ts';

/** A steering or prompt write, without the queue's own stamp. */
type OutgoingText = { op: 'prompt' | 'steer'; text: string };

/** A permission or question the broker relayed from the engine, as it arrives for drawing. */
export interface ModConnectionRequest {
  requestId: string;
  kind: 'permission' | 'question';
  toolName?: string;
  title?: string;
  detail?: string;
  questions?: unknown;
  readOnly?: boolean;
  permissionMode?: PermissionModeName;
  releaseReason?: PermissionReleaseReason;
  /** The command, path or URL being approved. Bounded text, not a sentence. */
  inputPreview?: string;
  /**
   * False on a card that explains rather than waits -- the read-only release card. It reaches the
   * frame, because `needs-input` is decided from the frame by whoever holds the session.
   */
  blocking?: boolean;
  /**
   * On a question card: the question is open in the terminal, and the app cannot send the answer
   * it needs. The card shows it read-only and says where to answer it.
   */
  answerInTerminal?: boolean;
  /**
   * Replace the card already drawn under this id, rather than keep it. Honoured only on a read-only
   * card: a restatement takes a card's controls away when its call moved to the terminal, and
   * nothing may hand them back.
   */
  restate?: boolean;
}

/** Claude's structured question, as the mod relays it. */
type AgentQuestionShape = {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiple?: boolean;
  freeText?: false;
};

/**
 * How many unanswered cards one session may hold.
 *
 * A stuck mod that re-offers the same call would otherwise grow this map for the life of the
 * process. The oldest card is dropped rather than the newest: the oldest is the one a reader has
 * most likely already moved past, and dropping a card never blocks anything, because the verdict
 * lives in the broker's hold store and not here.
 */
const PENDING_CARD_CEILING = 100;

export interface ClaudeModConnectionOptions {
  info: SessionInfo;
  transcriptPath: string;
  /** Claude's own session id, which is what the mod registry is keyed by. */
  nativeSessionId: string;
  send: (command: ClaudeModCommand) => { ok: boolean; code?: string };
  steeringEnabled: () => boolean;
  /**
   * Whether a turn is RUNNING in that terminal right now, as the mod last said.
   *
   * Steering only makes sense while there is a turn to steer. The connection could guess from
   * `info.status`, and used to, which meant a stale or folded status decided the shape of what the
   * person typed: with a leftover `needs-input` on the row, every prompt became a mid-turn append.
   * The broker knows the turn from the mod's own `turn.start` / `turn.complete`, so it says.
   * Absent means the caller has no turn knowledge, and the status guess is all there is.
   */
  turnRunning?: () => boolean;
  /**
   * When the mod last said the terminal's main turn ended, if it has. History restates an open run
   * cancelled only when it started before this, because "no turn running" also describes a terminal
   * whose `turn.start` has not reached the broker yet, and a mod reloaded mid-turn that has not yet
   * adopted the turn it is in.
   */
  turnEndedAt?: () => number | undefined;
  /** What the broker remembers about one of this session's cards, which the transcript does not
   *  record. A reload is drawn from the transcript, so this is what lets it draw the card as it was. */
  cardNote?: (requestId: string) => ClaudeModCardNote | undefined;
  /** Id source for queued commands. Injectable so a suite can pin it. */
  nextRequestId?: () => string;
  /** How long a reported turn end waits for the transcript's own closing row. A suite shortens it. */
  turnEndGraceMs?: number;
  /** Called when this connection is torn down, so the adapter can forget it. Mirrors the resume
   *  connection's `onClosed`, which owns the same problem: the adapter tracks a connection whose
   *  death it does not otherwise observe. */
  onClosed?: () => void;
  /** The control to publish while the mod is gone. Built by the adapter, which owns the reason
   *  and the resume command; the connection only knows THAT the mod is away. (Not imported:
   *  these two files already import each other, and a value import across that cycle can resolve
   *  to undefined at module-evaluation time.) */
  lostControl?: () => SessionControlState;
  /** The control of a live sync, as a closure so a re-promotion publishes the adapter's own
   *  reading rather than a copy this file kept. */
  syncedControl?: () => SessionControlState;
}

/** The turn-stop action, spelled the way the app looks it up (`stop` preferred over `abort`). */
const CLAUDE_STOP_COMMANDS = new Set(['stop', 'abort', 'interrupt']);

let requestSeq = 0;

export class ClaudeModConnection implements SessionConnection {
  readonly info: SessionInfo;
  private readonly content: ClaudeObserveConnection;
  private readonly handlers = new Set<AgentMessageHandler>();
  private contentUnsub?: Unsubscribe;
  private readonly options: ClaudeModConnectionOptions;
  /** Cards drawn for this session and not yet answered, in arrival order. */
  private readonly pending = new Map<string, AgentMessage>();
  /** Request ids already answered here, so a late replay does not re-open a closed card. */
  private readonly resolved = new Set<string>();
  /**
   * The transcript's resolution of each question it closed, as it went out, so a cancel from the
   * band that reaches the broker after it can still say where the question was answered.
   */
  private readonly transcriptResolutions = new Map<string, Extract<AgentMessage, { type: 'question-resolved' }>>();
  /**
   * The registration these cards belong to, as the broker last said.
   *
   * Hold ids restart at `cm-1` in every process. When a session is taken over -- a `kill -9` and
   * a `claude --resume` inside the freshness window does it in seconds -- the new process opens a
   * hold with the dead one's id, and a `resolved` set still holding that id would drop the new
   * card on the floor: the terminal sits parked on a call the app never shows.
   */
  private modGeneration = 0;
  /** While set, this attach is read-only: its mod is away. See {@link noteModLive}. */
  private modGone = false;

  constructor(options: ClaudeModConnectionOptions) {
    this.options = options;
    this.info = options.info;
    this.content = new ClaudeObserveConnection(
      options.transcriptPath,
      options.info,
      undefined,
      options.turnEndGraceMs !== undefined ? { turnEndGraceMs: options.turnEndGraceMs } : {},
    );
  }

  subscribe(handler: AgentMessageHandler): Unsubscribe {
    this.handlers.add(handler);
    if (!this.contentUnsub) {
      this.contentUnsub = this.content.subscribe((message) => this.fanContent(message));
    }
    return () => {
      this.handlers.delete(handler);
    };
  }

  private fan(message: AgentMessage): void {
    for (const handler of this.handlers) {
      try {
        handler(message);
      } catch {
        /* one bad subscriber must not stop the others */
      }
    }
  }

  /**
   * A transcript line, on its way to the app.
   *
   * A held question's card and the transcript's own card for the same `AskUserQuestion` share
   * Claude's call id. The transcript's copy is read-only, and a copy that arrived after the held
   * one replaced it in the Hub's pending set, so a socket that joined later was drawn a question it
   * could not answer. While this connection holds the card, or has settled it, the transcript's
   * copy is dropped. The transcript's resolution passes: it is the call's own end.
   */
  private fanContent(message: AgentMessage): void {
    if (message.type === 'question-request'
      && (this.pending.has(message.requestId) || this.resolved.has(message.requestId))) {
      return;
    }
    if (message.type === 'question-resolved' && this.pending.delete(message.requestId)) {
      this.markResolved(message.requestId);
    }
    // The transcript's resolution says what was answered and not who answered it. It arrives after
    // the broker's own, which did say, and it replaces that one in every seat.
    const outgoing = this.withCardNote(message);
    if (outgoing.type === 'question-resolved') this.rememberTranscriptResolution(outgoing);
    this.fan(outgoing);
  }

  private nextRequestId(): string {
    if (this.options.nextRequestId) return this.options.nextRequestId();
    requestSeq += 1;
    return `mod-cmd-${Date.now().toString(36)}-${requestSeq.toString(36)}`;
  }

  /** Hand one command to the mod, and say so when it cannot go. */
  private deliver(command: ClaudeModCommand): { ok: boolean; code?: string } {
    // After the mod is gone the broker's queue still exists and still expires, so a command pushed
    // into it would report success and then vanish. The registry refuses a stale row too, but by
    // then the write has already been accepted somewhere; refusing here is the difference between
    // saying "not sent" and forwarding it into a dead-letter box.
    if (this.modGone) {
      this.fan({
        type: 'error',
        message: 'This session is mirrored read-only right now: the cosyncing mod in its terminal '
          + 'has stopped reporting. Nothing was sent. Open Claude in that terminal and the sync '
          + 'comes back on its own.',
      });
      return { ok: false, code: 'stale_registration' };
    }
    const result = this.options.send(command);
    if (!result.ok) {
      this.fan({ type: 'error', message: claudeModCommandRefusal(result.code) });
    }
    return result;
  }

  async getHistory(): Promise<AgentMessage[]> {
    const history = this.withCardNotes(await this.content.getHistory());
    // A turn stopped from the app writes no interruption row, so the file alone replays it as still
    // running: a reload, a resync or a fresh attach drew a spinner for a turn that had ended. The
    // mod is what knows: when it says no turn is running, and it said the turn ended after the newest
    // run started, that run is restated cancelled under its own key. No completion time is given,
    // because none is known. Without the mod's word the file stands, running.
    if (!this.options.turnRunning || this.options.turnRunning()) return history;
    const endedAt = this.options.turnEndedAt?.();
    if (endedAt === undefined) return history;
    let newest: Extract<AgentMessage, { type: 'run-summary' }> | undefined;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const message = history[i]!;
      if (message.type === 'run-summary') {
        newest = message;
        break;
      }
    }
    if (newest?.status !== 'running') return history;
    if (typeof newest.startedAt === 'number' && newest.startedAt >= endedAt) return history;
    // A running summary carries no completion time or runtime, so the restatement invents neither.
    return [...history, { ...newest, status: 'cancelled' }];
  }

  /**
   * The transcript's cards, as the broker drew them.
   *
   * The transcript draws Claude's question under the call's own id, which is the id the broker drew
   * the same question under. What it cannot say is that the question went to Claude's own picker,
   * so a reload drew a question answered at the keyboard as settled "in your terminal or another
   * app". The broker remembers; this puts it back on the history copy.
   */
  private withCardNotes(history: AgentMessage[]): AgentMessage[] {
    if (!this.options.cardNote) return history;
    return history.map((message) => this.withCardNote(message));
  }

  /**
   * One transcript card, as the broker drew it: a question it left to Claude's picker says so, and
   * a resolution says who closed it. Only what the transcript does not already say is added.
   */
  private withCardNote(message: AgentMessage): AgentMessage {
    if (message.type !== 'question-request' && message.type !== 'question-resolved') return message;
    let said: ClaudeModCardNote | undefined;
    try {
      said = this.options.cardNote?.(message.requestId);
    } catch {
      return message;
    }
    if (!said) return message;
    if (message.type === 'question-request') {
      return said.inTerminal ? { ...message, readOnly: true, answerInTerminal: true } : message;
    }
    if (message.decidedBy || message.releaseReason || (!said.decidedBy && !said.releaseReason)) return message;
    return {
      ...message,
      ...(said.decidedBy ? { decidedBy: said.decidedBy } : {}),
      ...(said.releaseReason ? { releaseReason: said.releaseReason } : {}),
    };
  }

  /** The main turn is running, even if its transcript has not reached the tail yet. */
  noteModTurnStarted(): void {
    this.fan({ type: 'status', status: 'running' });
  }

  /** The mod owns session status; the transcript tail still decides what run that closes. */
  noteModTurnEnded(ended: { turnId?: string; aborted: boolean; endedAt?: number }): void {
    this.content.noteModTurnEnded(ended);
    // An end remembered at registration must not idle a newer turn already reported by the mod.
    if (ended.endedAt !== undefined && this.options.turnRunning?.()) return;
    this.fan({ type: 'status', status: 'idle' });
  }

  getHistorySourceIdentity(): HistorySourceIdentity | undefined {
    return this.content.getHistorySourceIdentity();
  }

  async sendPrompt(input: PromptInput): Promise<void> {
    const text = typeof input.text === 'string' ? input.text : '';
    if (!text.trim()) return;
    // Mid-turn means steering, but only once the app can show what steering leaves behind, and
    // only while a turn is genuinely running. A turn that has ended takes this as an ordinary
    // prompt, which Claude reads at its next input boundary; `session.append` into an idle session
    // is a write into nothing, and the mod answers it with a refusal the person would never see.
    const midTurn = this.options.turnRunning
      ? this.options.turnRunning()
      : this.info.status === 'working' || this.info.status === 'needs-input';
    const outgoing: OutgoingText = midTurn && this.options.steeringEnabled()
      ? { op: 'steer', text }
      : { op: 'prompt', text };
    this.deliver({
      requestId: this.nextRequestId(),
      op: outgoing.op,
      text: outgoing.text,
      queuedAt: Date.now(),
    });
  }

  /**
   * Close a card the app already answered.
   *
   * The verdict itself travels over the mod socket from the broker's hold store, so this cannot
   * approve anything; it exists so the card leaves the transcript in every seat that has it.
   */
  async respondPermission(
    requestId: string,
    decision: PermissionDecision | 'external',
    info?: { decidedBy?: PermissionDecidedBy; releaseReason?: PermissionReleaseReason },
  ): Promise<void> {
    if (!this.stillOpen(requestId)) return;
    // A read-only card explains a call the terminal is deciding; nothing a client sends can decide
    // it. Only the broker closes one, with `external`, when the turn it explained is over. An
    // approve that reached here used to go out as "Approved" to every seat, for a dialog still
    // open in the terminal.
    if (this.isReadOnly(requestId) && decision !== 'external') return;
    this.pending.delete(requestId);
    this.markResolved(requestId);
    this.fan({
      type: 'permission-resolved',
      requestId,
      decision,
      ...(info?.decidedBy ? { decidedBy: info.decidedBy } : {}),
      ...(info?.releaseReason ? { releaseReason: info.releaseReason } : {}),
    });
  }

  async answerQuestion(
    requestId: string,
    answers: string[][],
    info?: { decidedBy?: PermissionDecidedBy; releaseReason?: PermissionReleaseReason },
  ): Promise<void> {
    if (!this.stillOpen(requestId)) return;
    // Answered in the terminal, and only there: see `respondPermission`.
    if (this.isReadOnly(requestId)) return;
    this.pending.delete(requestId);
    this.markResolved(requestId);
    // The rows the hold was answered with, read back from the map Claude was given. Every seat,
    // the one that tapped included, draws the settled card with them, and with who answered.
    this.fan({
      type: 'question-resolved',
      requestId,
      ...(answers.length > 0 ? { answers } : {}),
      ...(info?.decidedBy ? { decidedBy: info.decidedBy } : {}),
      ...(info?.releaseReason ? { releaseReason: info.releaseReason } : {}),
    });
  }

  async rejectQuestion(
    requestId: string,
    info?: { decidedBy?: PermissionDecidedBy; releaseReason?: PermissionReleaseReason },
  ): Promise<void> {
    if (!this.stillOpen(requestId)) return;
    this.pending.delete(requestId);
    this.markResolved(requestId);
    this.fan({
      type: 'question-resolved',
      requestId,
      ...(info?.decidedBy ? { decidedBy: info.decidedBy } : {}),
      ...(info?.releaseReason ? { releaseReason: info.releaseReason } : {}),
    });
  }

  /**
   * Is this still a card somebody can act on?
   *
   * Two seats answer one hold, and the slower one used to be told its answer happened: a
   * `permission-resolved` went out for an id that was already closed or never drawn, which reads
   * on the screen as "Approved" for a call that seat never saw. An unknown or spent id is refused
   * here, quietly, because the honest answer for the late seat is that nothing happened here and
   * the other one decided.
   */
  private stillOpen(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /** Whether the card under this id was drawn read-only. */
  private isReadOnly(requestId: string): boolean {
    return (this.pending.get(requestId) as { readOnly?: boolean } | undefined)?.readOnly === true;
  }

  /**
   * The broker relayed an engine prompt or question for this session. Draw it.
   *
   * The hold is the broker's; this only puts the card in front of the user and keeps it replayable
   * to a second socket that opens mid-hold. `readOnly` arrives on the card the broker raised for a
   * call it did NOT answer, and it survives to the frame: a card with buttons for a decision that
   * is already closed is a lie the user can act on.
   */
  ingestRequest(request: ModConnectionRequest): void {
    if (this.resolved.has(request.requestId)) {
      if (request.kind === 'question' && request.restate === true && request.answerInTerminal === true) {
        this.correctLateTerminalAnswer(request.requestId);
      }
      return;
    }
    // A held card restated read-only replaces itself, in place and still open: the Hub replaces a
    // pending entry by its id, so every seat, and every socket that joins later, is drawn the card
    // as it is now. It is not answered, so it is not marked resolved.
    const restating = request.restate === true && request.readOnly === true;
    if (this.pending.has(request.requestId) && !restating) return;
    if (request.kind === 'question') {
      this.remember(request.requestId, {
        type: 'question-request',
        requestId: request.requestId,
        ...(request.readOnly ? { readOnly: true } : {}),
        ...(request.blocking === false ? { blocking: false } : {}),
        ...(request.answerInTerminal ? { answerInTerminal: true } : {}),
        // The broker forwards Claude's own question shape, which the mod has already narrowed to
        // {question, options:[{label}]}. Passed through untouched: the client owns the rendering,
        // and a wrong shape is the mod's to refuse before it ever sends one.
        questions: (request.questions as AgentQuestionShape[] | undefined) ?? [],
      });
      return;
    }
    this.remember(request.requestId, {
      type: 'permission-request',
      requestId: request.requestId,
      // Data, never a phrase: the tool's own name, or nothing, which every client draws with its own
      // localized fallback. `${tool} permission` was an English sentence on a five-locale app.
      title: request.title || request.toolName || '',
      ...(request.toolName ? { toolName: request.toolName } : {}),
      ...(request.detail ? { detail: request.detail } : {}),
      ...(request.inputPreview ? { inputPreview: request.inputPreview } : {}),
      ...(request.readOnly ? { readOnly: true } : {}),
      ...(request.blocking === false ? { blocking: false } : {}),
      ...(request.permissionMode ? { permissionMode: request.permissionMode } : {}),
      ...(request.releaseReason ? { releaseReason: request.releaseReason } : {}),
    });
  }

  private remember(requestId: string, frame: AgentMessage): void {
    if (this.pending.size >= PENDING_CARD_CEILING) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    this.pending.set(requestId, frame);
    this.fan(frame);
  }

  /**
   * One line the terminal has to say for itself.
   *
   * The send succeeded, so the app has already been told; the refusal happened a poll later, in
   * the only process that can carry the command. Fanning it as an error is what stops the app's
   * "sent" from becoming a lie.
   */
  noteModNotice(message: string): void {
    this.fan({ type: 'error', message });
  }

  /**
   * Cards this session is still holding, for a socket that joins mid-hold.
   *
   * A second window opened while the first is holding a permission prompt has to show the same
   * prompt or it reads as a session that is working when it is waiting. Bounded by the same
   * ceiling as the pending set, and emptied by whatever answers the card.
   */
  getPending(): AgentMessage[] {
    return [...this.pending.values()];
  }

  async runCommand(name: string): Promise<CommandResult | void> {
    const bare = name.replace(/^\//, '').trim().toLowerCase();
    if (!CLAUDE_STOP_COMMANDS.has(bare)) {
      this.fan({
        type: 'error',
        message: `Claude sessions synced through the cosyncing mod run their own slash commands in the terminal. (${name})`,
      });
      return;
    }
    this.deliver({
      requestId: this.nextRequestId(),
      op: 'abort',
      queuedAt: Date.now(),
    });
  }

  /**
   * The stop action is the one command a mod-synced session offers.
   *
   * Claude's on-disk command catalogue describes what the CLI can run for a NEW launch; a live
   * mod cannot run those, so offering them would put buttons on the app that cannot be pressed.
   * `listCommands` is also how the app finds the turn-stop action, so this returns exactly that
   * one and nothing else.
   */
  async listCommands(): Promise<SlashCommand[]> {
    return [{ name: 'stop', description: 'Stop the turn running in your terminal', kind: 'action' }];
  }

  async listModels(): Promise<ModelOption[]> {
    return this.content.listModels();
  }

  async listModes(): Promise<ModeOption[]> {
    return this.content.listModes();
  }

  /**
   * Point the row at a newer SessionInfo without rebuilding the tail.
   *
   * The content connection holds the SAME info object, so mutating in place updates both; a fresh
   * assignment would leave the tail describing the session as it was at attach. Precedent: the
   * hooks overlay's `replaceInfo`.
   */
  replaceInfo(info: SessionInfo): void {
    for (const key of Object.keys(this.info)) delete (this.info as unknown as Record<string, unknown>)[key];
    Object.assign(this.info, info);
  }

  /**
   * Restate the row when the mod behind it disappears, or comes back.
   *
   * An attach is a decision made once, and true sync can end underneath it. The terminal closes,
   * or its poll chain stops and 60 s later the registry calls the row stale. Neither writes a
   * transcript line, so nothing the tail delivers can carry that news, and this connection used to
   * keep publishing the control it was born with: a row reading "Synced with your terminal" above
   * a terminal that had shut down, with a composer whose prompts were refused and a Take over
   * refused on the grounds that a mod was sharing the session. The spec's promise is Observe
   * within about a minute, which means the row has to be able to change its mind.
   *
   * It may change it in both directions, but only on the registry's word. `live` is true solely
   * for a fresh registration whose kernel-proven process is polling, which is the same evidence a
   * fresh attach demands, so a re-promotion is not a flag flipped back on a connection that has
   * already told the user their write was refused -- it is the fact that made the attach
   * legitimate again. The two control shapes come from the adapter for the same reason: they are
   * its readings, and a second copy here would be a second opinion.
   */
  noteModLive(live: boolean): void {
    if (live === !this.modGone) return;
    if (!live && !this.options.lostControl) return;
    if (live && !this.options.syncedControl) return;
    this.modGone = !live;
    this.info.attachMode = live ? 'live' : 'observe';
    this.info.control = live ? this.options.syncedControl!() : this.options.lostControl!();
    // The hub applies this patch to `conn.info` and broadcasts it, which is what reaches every
    // seat holding the row -- and there may be several -- without waiting for a roster poll.
    this.fan({
      type: 'metadata-update',
      key: 'sessionInfo',
      value: { attachMode: this.info.attachMode, control: this.info.control },
    });
    // Nothing more. The restated control above is what the row shows: Observe, with its reason and
    // Take over. An error row here used to be appended on every normal exit -- the person closes
    // their terminal and the app reports a failure that "sent nothing" when nothing was being sent.
    // A write attempted while the mod is away is still refused out loud, by `deliver`.
  }

  /** True while this attach is demoted because its mod is away. */
  get modIsGone(): boolean {
    return this.modGone;
  }

  /**
   * Note which registration the session's holds now belong to.
   *
   * A change means every id this connection has settled was a different process's card, so the
   * set is emptied. The broker cancels the old holds and closes their cards before it registers
   * the new row, so nothing answered is forgotten -- only the memory that would otherwise
   * recognise the new process's first id as already spent.
   */
  noteModGeneration(generation: number): void {
    if (generation === this.modGeneration) return;
    this.modGeneration = generation;
    this.resolved.clear();
  }

  /**
   * The band handed this question to Claude's picker, but the picker's answer reached the transcript
   * first, so the card already closed with nothing to say who answered it: "settled in your terminal
   * or another app", while a reload said "your terminal". The broker's own word arrives now, and the
   * card is closed again under the same id with it, keeping the answer it closed with.
   */
  private correctLateTerminalAnswer(requestId: string): void {
    const settled = this.transcriptResolutions.get(requestId);
    if (!settled || settled.decidedBy || settled.releaseReason) return;
    const corrected: Extract<AgentMessage, { type: 'question-resolved' }> = { ...settled, releaseReason: 'band' };
    this.transcriptResolutions.set(requestId, corrected);
    this.fan(corrected);
  }

  private rememberTranscriptResolution(message: Extract<AgentMessage, { type: 'question-resolved' }>): void {
    this.transcriptResolutions.delete(message.requestId);
    this.transcriptResolutions.set(message.requestId, message);
    if (this.transcriptResolutions.size > 64) {
      const oldest = this.transcriptResolutions.keys().next().value;
      if (oldest !== undefined) this.transcriptResolutions.delete(oldest);
    }
  }

  /** Mark a request answered so a later replay of the same id cannot re-open a closed card. */
  private markResolved(requestId: string): void {
    this.resolved.add(requestId);
    if (this.resolved.size > 500) {
      const oldest = this.resolved.values().next().value;
      if (oldest !== undefined) this.resolved.delete(oldest);
    }
  }

  async close(): Promise<void> {
    try {
      this.options.onClosed?.();
    } catch {
      /* the adapter forgetting a connection cannot fail its close */
    }
    try {
      this.contentUnsub?.();
    } catch {
      /* nothing left to unhook */
    }
    this.contentUnsub = undefined;
    this.handlers.clear();
    try {
      await this.content.close();
    } catch {
      /* the tail is already gone */
    }
  }
}

/** Exported for the suite, which asserts a refused command reaches the user. */
export type { ClaudeModCommandResult };
