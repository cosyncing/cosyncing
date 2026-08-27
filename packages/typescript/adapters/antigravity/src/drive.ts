/**
 * Drive: a long-lived `agy` child reading NDJSON on stdin, writing NDJSON on stdout.
 *
 * Extends {@link AgyObserveConnection} rather than reimplementing it, so the
 * transcript replay and the transcript tail are literally the same code on both
 * postures — which is what makes a demotion to observe a change of AUTHORITY
 * rather than a change of machinery.
 *
 * ── The child (MEASURED, agy 1.1.17 and re-pinned on 1.1.20, 2026-08-25) ─────
 *
 *   agy --conversation <id> --output-format=stream-json --input-format=stream-json
 *
 * `--print` is NEVER passed. On ≤1.1.17 `--print` takes the prompt as its VALUE,
 * so `agy --print --model X` makes `--model` the prompt: the run succeeds, answers
 * a question nobody asked, and records `--model` as the user request. On 1.1.18+
 * it is an outright error. Either way it must be omitted in stream-json mode, and
 * {@link agyDriveArgs} is a pure function so a test can assert that byte for byte.
 *
 * Input is one NDJSON line per turn: `{"event":"user","message":{"role":"user",
 * "content":"…"}}` — `event`, not claude's `type`.
 *
 * Output is `init` (carrying `conversation_id` as a SIBLING, plus `model`, `cwd`,
 * `permission_mode`, `tools[]`), `step_update` (`conversation_id`, `step_index`,
 * `state`, `step_type`, `text_delta?`, `duration_seconds?`, `usage?` on the final
 * `agent_response` update), and exactly one `result` per turn (`status`,
 * `response`, `duration_seconds`, `num_turns`, `usage{input,output,thinking,
 * cache_read}`). A second invocation with `--conversation` resumes in place:
 * `step_index` continues, `num_turns` increments, and the pre-response system step
 * is `system_message` rather than `checkpoint`.
 *
 * ── EXIT CODES ARE DIAGNOSTIC ONLY ──────────────────────────────────────────
 * 1.1.18 and 1.1.20 both changed print-mode exit semantics: benign tool errors and
 * permission denials no longer produce a non-zero status, while a dropped
 * agent-state stream now does. So turn outcome is read from the `result` event and
 * from nothing else. The exit code is recorded in a trace and never interpreted.
 *
 * ── THE SILENT-FAILURE TRAP ─────────────────────────────────────────────────
 * An unrecognized input `event` makes agy exit 0 after emitting only `init`, with
 * a warning on stderr and NO `result` at all (MEASURED, unchanged on 1.1.20). An
 * adapter that simply waits for `result` therefore hangs forever with nothing to
 * show. "The stream closed while a submitted turn was outstanding" is treated as a
 * FAILURE with a visible error and a structured trace (reflection §8).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
  AgentMessage,
  PermissionDecision,
  PromptInput,
  SessionControlState,
  SessionInfo,
} from '@cosyncing/adapter-api';
import { AgyObserveConnection, type AgyObserveOptions } from './observe.ts';
import {
  AGY_CANCELED_STATUS,
  AGY_PENDING_SEND_LIMIT,
  agySourceForStepType,
  createAgyMapState,
  createAgyQueuedSends,
  mapAgyStep,
  normalizeAgyStreamStepType,
  pushAgyQueuedSend,
  retireAgyQueuedSend,
  type AgyMapState,
  type AgyQueuedSends,
  type AgyStep,
} from './mapping.ts';
import { AGY_MAX_LINE_BYTES, AgyLineFramer, truncateToUtf8Bytes } from './safe-read.ts';

/**
 * Ceiling on ONE step's accumulated `text_delta`s. ~4× the largest whole
 * `transcript_full.jsonl` in the corpus (1,001,337 B), so no real response
 * approaches it, and a child that streams without end cannot grow this process.
 */
export const AGY_MAX_STEP_TEXT_BYTES = 4 * 1024 * 1024;

/**
 * Ceiling on steps open at once. A turn advances its steps in sequence, so the
 * real number is one or two; 256 is a wide margin around that. The map is keyed
 * by `step_index`, and a child that reports ever-increasing indices without ever
 * settling them would otherwise grow it forever.
 */
const AGY_MAX_OPEN_STEPS = 256;

/**
 * Build the child's argv. Pure, and exported, so the "never `--print`" rule is
 * asserted by a test rather than trusted to a reviewer.
 */
export function agyDriveArgs(
  conversationId: string | undefined,
  options: { model?: string; mode?: string } = {},
): string[] {
  const args: string[] = [];
  // A brand-new session omits `--conversation` and adopts the id agy reports in
  // its `init` event; a resume names the conversation and continues it in place.
  if (conversationId) args.push('--conversation', conversationId);
  args.push('--output-format=stream-json', '--input-format=stream-json');
  if (options.model) args.push('--model', options.model);
  if (options.mode) args.push('--mode', options.mode);
  return args;
}

/** One prompt this connection accepted and has not yet seen delivered. */
interface AgyPendingRow {
  key: string;
  text: string;
  sentAt: number;
  queued: boolean;
}

/** A step being assembled from `step_update` deltas. */
interface AgyOpenStep {
  type: string;
  text: string;
  /** UTF-8 bytes of `text`, carried forward so the cap check stays linear. */
  textBytes: number;
  status: string;
  createdAt: string;
  /** Deltas past the cap were discarded, so the rendered step must say so. */
  textTruncated: boolean;
}

/** What a step says when its own output outgrew what this session will hold. */
export const AGY_STEP_TRUNCATION_NOTE =
  '[Antigravity streamed more output for this step than the session can hold; the rest was dropped.]';

export interface AgyDriveOptions extends AgyObserveOptions {
  /** Absolute path to the `agy` binary. Tests point this at a scripted fake; the real one is never spawned. */
  binary: string;
  /** Called when this connection closes, so the adapter can deregister it compare-and-swap on identity. */
  onClose?: (connection: AgyDriveConnection) => void;
  /** Launch model/mode when the caller chose them at attach. */
  model?: string;
  mode?: string;
}

export class AgyDriveConnection extends AgyObserveConnection {
  /** Identity for the adapter's compare-and-swap registry. A stale close must not evict a replacement. */
  readonly identity = randomUUID();

  private readonly binary: string;
  private readonly onCloseHook?: (connection: AgyDriveConnection) => void;

  /**
   * Per-CONNECTION queued-send state, which is what makes Q14 sound.
   *
   * Two sockets sharing this connection share this table, so a peer socket's
   * prompt is written by the same writer, keyed from the same map, and read back
   * by the same replay. It can never look like a foreign write, because it is
   * not one.
   */
  private readonly queuedSends: AgyQueuedSends = createAgyQueuedSends();
  private readonly pendingRows: AgyPendingRow[] = [];
  private readonly connNonce = randomUUID().slice(0, 8);
  private drivenSendSeq = 0;

  private proc?: ChildProcessWithoutNullStreams;
  /** Frames the child's stdout into NDJSON lines, bounding each one as it closes. */
  private stdoutFramer = new AgyLineFramer(AGY_MAX_LINE_BYTES);
  private readonly openSteps = new Map<number, AgyOpenStep>();
  private running = false;
  /** Submitted turns still awaiting their `result`. A child that dies owing one is a surfaced failure. */
  private awaitingResult = 0;
  private demoted = false;
  private launchModel?: string;
  private launchMode?: string;

  constructor(options: AgyDriveOptions) {
    super(options);
    this.binary = options.binary;
    if (options.onClose) this.onCloseHook = options.onClose;
    if (options.model) this.launchModel = options.model;
    if (options.mode) this.launchMode = options.mode;
    this.info.control = this.controlState();
  }

  /** The fold runs with THIS connection's queued-send table and knows a child may own the session. */
  protected override buildMapState(): AgyMapState {
    return createAgyMapState(this.conversationId, {
      liveChild: this.proc !== undefined,
      queuedSends: this.queuedSends,
      ...(this.trace ? { trace: this.trace } : {}),
    });
  }

  /**
   * The accepted-but-undelivered prompts, replayed as part of history.
   *
   * `getHistory()` and NOT `getHistoryOverlays()`: an ordinary attach replays
   * `getHistory()` and nothing else, so an overlay never reaches a reloaded page
   * (reflection §6, the fact that decided claude's design). This is the only
   * reason a refreshed browser still shows words the user typed a second ago.
   */
  protected override extraHistoryRows(): AgentMessage[] {
    return this.pendingRows.map((row) => ({
      type: 'user-message' as const,
      text: row.text,
      key: row.key,
      ...(row.queued ? { queued: true } : {}),
      sentAt: row.sentAt,
    }));
  }

  /**
   * Notice a `USER_EXPLICIT` line this connection did not submit.
   *
   * TWO decisions live here, and they are scoped DIFFERENTLY — conflating them
   * was a real defect:
   *
   *  - **Retirement is source-independent.** Whichever path admits the line that
   *    delivers our prompt, the transcript now carries it and our minted copy has
   *    to go. Gating this on the tail meant a delivery admitted by a REPLAY
   *    consumed the mapper's byte-fenced link (the mapper does that on every
   *    path) while leaving `pendingRows` untouched — so `extraHistoryRows()`
   *    appended the row a second time and `getHistory()` returned two identical
   *    rows under one key. Reachable with no subscriber attached at all.
   *  - **Demotion is tail-ONLY.** Every user line in a replay is by definition
   *    history; a replay that treated them as foreign would demote itself the
   *    instant it attached to any conversation that had ever been used.
   *
   * Exoneration has ONE ground: the line claimed one of our minted pending keys,
   * which the mapper only grants to a line appended past the byte fence recorded
   * when we accepted that prompt. Anything else is a second writer — a terminal
   * took the conversation — and the single writer rule says we stop writing
   * rather than race it.
   *
   * There is deliberately no "the text matches something we sent recently"
   * fallback. It looked like a safety net and was in fact a hole: the claim is
   * consumed exactly once, so it distinguishes OUR prompt's delivery from a
   * SECOND arrival of the same words, while a text comparison cannot. Prompts
   * recur verbatim — "continue", "run the tests", "fix it" are the normal case —
   * so any user who typed one in a terminal after we sent the same one would be
   * exonerated forever, and the takeover we exist to notice would go unnoticed.
   * One fact, one code path (reflection §5): the byte-fenced claim is the fact.
   */
  protected override onStepAdmitted(step: AgyStep, messages: AgentMessage[], source: 'replay' | 'tail'): void {
    if (step.source !== 'USER_EXPLICIT' || step.type !== 'USER_INPUT') return;

    const echo = messages.find((message) => message.type === 'user-message') as
      | { key?: string; text: string }
      | undefined;
    if (!echo) return;
    // Claimed one of our minted keys → it is the delivery of our own prompt.
    // Retired on BOTH paths: the row's job was to stand in until the transcript
    // carried the prompt, and it now does regardless of who noticed first.
    if (echo.key?.startsWith(this.pendingKeyPrefix())) {
      this.retirePendingRow(echo.key);
      return;
    }

    // Past here we are looking at a user line that is not ours. Only a line
    // arriving LIVE says a second writer is active right now.
    if (source !== 'tail') return;
    this.demote(`a prompt this connection did not send appeared in the transcript at step ${step.step_index}`);
  }

  private pendingKeyPrefix(): string {
    return `queued:agy:${this.connNonce}.`;
  }

  // ── Posture ────────────────────────────────────────────────────────────────

  private controlState(): SessionControlState {
    const driving = !this.demoted;
    return {
      drive: {
        state: driving ? 'driving' : 'observing',
        supported: driving,
        ...(this.demoted
          ? {
            reason: 'Another writer took this conversation in a terminal, so the app released it.',
            takeoverAvailable: true,
          }
          : {}),
        handoffAvailable: driving,
      },
      terminalSync: {
        // agy has no bridge, no daemon and no socket — there is nothing that could
        // ever make a live terminal mirror this session, so this is a structural
        // no rather than a "not right now".
        supported: false,
        syncAvailable: false,
        active: false,
        label: 'Resume in terminal',
        command: `agy --conversation ${this.conversationId}`,
      },
    };
  }

  /**
   * Publish the current posture to EVERY subscriber, on promotion and on demotion.
   *
   * Reflection §11: an attach snapshot describes the SESSION's posture, not the
   * requester's mode, and a posture change that is only recorded on the changing
   * connection leaves every other client reading a stale one forever. Rides a
   * `metadata-update`, which is the only shape the broker folds onto `SessionInfo`.
   */
  private broadcastPosture(): void {
    const control = this.controlState();
    this.info.control = control;
    this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { control } });
  }

  /** Give up write authority without giving up the session. */
  private demote(reason: string): void {
    if (this.demoted) return;
    this.demoted = true;
    this.trace?.({ op: 'drive-demoted', detail: reason });
    // Stop being a writer: a second stdin against a conversation a terminal now
    // owns is the two-writer collision the single-owner rule exists to prevent.
    this.killChild();
    // The TAIL keeps running and the pending rows stay. Every accepted prompt was
    // already written to the child's stdin, so killing the child proves nothing
    // about what it buffered — clearing the rows would lose the user's words on
    // reload if the line never lands, and re-key them if it lands late
    // (reflection §6, a decision a third review reversed).
    this.emit({
      type: 'notice',
      message: 'This conversation was taken over in a terminal, so the app switched to watching it.',
    });
    // The child we just killed may have owed a `result`. Nothing else will settle
    // that turn — see settleGeneration — so a demotion that skipped this left the
    // session Running forever, under an observing posture, with no writer left to
    // finish it.
    this.settleGeneration({
      op: 'drive-turn-abandoned-by-demotion',
      detail: reason,
      message:
        'That turn was still running when the conversation was taken over, so Antigravity never reported its '
        + 'result. Whatever it did is in the terminal session.',
    });
    this.broadcastPosture();
  }

  /**
   * Close out the CURRENT child generation's turn accounting.
   *
   * This is the only settler, and it has to be, because the child's own `exit`
   * handler cannot do it for a child we replaced or killed on purpose:
   * {@link killChild} clears `this.proc` FIRST, so by the time `exit` fires the
   * handler's `this.proc !== proc` guard is true and it returns. That guard is
   * correct — a dead child's exit must never end the turn its REPLACEMENT is
   * running — but it means a deliberate kill settles nothing at all unless the
   * killer settles it.
   *
   * What was left behind without this: `awaitingResult` stayed elevated, so the
   * NEXT turn's `result` decremented it to a non-zero number and never published
   * idle; `running` stayed true; and the client showed a turn in flight that
   * nothing was ever going to finish. Reflection §8 — a failure that leaves no
   * trace is the worst kind — so the abandoned turn is named to the user, not
   * just to the log.
   *
   * A no-op when nothing was in flight, which is why the cold-start path can call
   * it unconditionally.
   */
  private settleGeneration(reason: { op: string; detail: string; message: string }): void {
    if (this.awaitingResult > 0) {
      const owed = this.awaitingResult;
      this.awaitingResult = 0;
      this.trace?.({ op: reason.op, detail: `${reason.detail}; ${owed} turn(s) never reported a result` });
      this.emit({ type: 'error', message: reason.message });
    }
    if (this.running) {
      this.running = false;
      this.emit({ type: 'status', status: 'idle' });
    }
  }

  /** Is this connection still the writer? Read by the tests and by the adapter's roster projection. */
  get driving(): boolean {
    return !this.demoted;
  }

  // ── Sending ────────────────────────────────────────────────────────────────

  override async sendPrompt(input: PromptInput): Promise<void> {
    const text = (input.text ?? '').trim();
    if (!text) return;
    if (this.closed) throw new Error('This Antigravity session is closed.');
    if (this.demoted) {
      throw new Error('This conversation was taken over in a terminal, so the app can no longer send to it.');
    }

    // Relaunch for a cold start or an EXPLICIT per-turn model/mode switch only —
    // never merely because a configured default differs from what the warm child
    // was launched with, which would kill a live turn mid-conversation.
    const explicitModel = input.model?.modelID;
    const explicitMode = input.permissionMode;
    if (
      !this.proc
      || (explicitModel && explicitModel !== this.launchModel)
      || (explicitMode && explicitMode !== this.launchMode)
    ) {
      this.relaunch(
        explicitModel ?? this.launchModel ?? this.info.currentModel?.modelID,
        explicitMode ?? this.launchMode ?? this.info.currentMode,
      );
    }

    // P1c: REFUSE BEFORE TOUCHING RUN STATE. A failed spawn leaves no child, and
    // writing to a missing stdin is a silent no-op — proceeding would publish a
    // running turn and drop the prompt under a Running badge. Throwing makes the
    // broker answer the send with an error instead of an ack. Deliberately NOT a
    // bare try/catch around the write.
    if (!this.proc || this.proc.killed || !this.proc.stdin.writable) {
      throw new Error('Antigravity could not be launched, so the prompt was not sent.');
    }

    const wasRunning = this.running;
    this.running = true;
    this.awaitingResult += 1;
    this.emit({ type: 'status', status: 'running' });

    // Mint BEFORE the write. The pending row's key is the only thing that will
    // exonerate this prompt's own echo, and the echo can land before this call
    // returns — so the claim has to exist first.
    this.mintPendingRow(text, wasRunning);
    this.writeLine({ event: 'user', message: { role: 'user', content: text } });
  }

  /**
   * Give an accepted prompt a durable, replayable row of its own (Q7).
   *
   * The adapter mints this because agy will not: its own `history.jsonl` is
   * workspace-scoped rather than conversation-scoped and cannot correlate, so
   * until the child writes the transcript line there is NO record anywhere that
   * the user said this. Without the row, a page refresh deletes their words.
   *
   * The fence is the transcript's byte size RIGHT NOW: the line that delivers
   * this prompt cannot already exist, so only a line appended past this offset
   * may claim the key. Clock-free by construction, which matters because
   * repeated prompts recur verbatim and a timestamp comparison would let an
   * older identical line take a newer send's key.
   */
  private mintPendingRow(text: string, queued: boolean): void {
    const key = `${this.pendingKeyPrefix()}${++this.drivenSendSeq}`;
    const sentAt = Date.now();
    const notBeforeOffset = existsSync(this.path) ? (statSync(this.path).size ?? 0) : 0;

    // The row and its correlation link are bounded TOGETHER: an evicted row must
    // never leave a link behind whose only remaining power is to lend its key to
    // a later repeat of the same words.
    const evicted = pushAgyQueuedSend(this.queuedSends, { text, key, notBeforeOffset });
    for (const goneKey of evicted) this.dropPendingRow(goneKey);
    this.pendingRows.push({ key, text, sentAt, queued });
    while (this.pendingRows.length > AGY_PENDING_SEND_LIMIT) {
      const gone = this.pendingRows.shift()!;
      retireAgyQueuedSend(this.queuedSends, gone.key);
    }

    this.emit({ type: 'user-message', text, key, ...(queued ? { queued: true } : {}), sentAt });
  }

  /** The transcript line arrived: the row is durable upstream now, so stop replaying ours. */
  private retirePendingRow(key: string): void {
    this.dropPendingRow(key);
    retireAgyQueuedSend(this.queuedSends, key);
  }

  private dropPendingRow(key: string): void {
    const index = this.pendingRows.findIndex((row) => row.key === key);
    if (index >= 0) this.pendingRows.splice(index, 1);
  }

  /** Write one NDJSON line. Throws rather than swallowing — the caller has already proved the child is writable. */
  private writeLine(payload: unknown): void {
    const proc = this.proc;
    if (!proc || !proc.stdin.writable) {
      throw new Error('The Antigravity child is not accepting input, so the prompt was not sent.');
    }
    proc.stdin.write(JSON.stringify(payload) + '\n');
  }

  // ── The child ──────────────────────────────────────────────────────────────

  /**
   * (Re)launch. Returns true only when a child was actually installed.
   *
   * CANCEL-AND-SETTLE, not refuse. The precedent is claude's: a model or mode
   * switch mid-turn restarts the backing process there too, and the turn it was
   * running does not survive. What claude gets for free is the settlement — its
   * run state is a BOOLEAN that the next `result` clears outright, so an
   * abandoned turn self-corrects. This connection counts outstanding turns
   * instead (agy can have several queued behind one child), and a counter never
   * self-corrects: an un-decremented turn poisons every later one. So the
   * accounting is closed explicitly, here, before the old child goes.
   */
  private relaunch(model?: string, mode?: string): boolean {
    // Before the old child is unreachable: whatever it owed is not coming.
    // A cold start settles nothing, because nothing is in flight.
    this.settleGeneration({
      op: 'drive-turn-abandoned-by-relaunch',
      detail: `relaunching for model=${model ?? 'default'} mode=${mode ?? 'default'}`,
      message:
        'Antigravity was restarted to change the model or mode while a turn was running, so that turn was '
        + 'cancelled without a result. Send it again.',
    });
    this.killChild();
    // A fresh child is a fresh stream: anything half-framed belonged to the old
    // one, and carrying it across would splice two processes' bytes into one line.
    this.stdoutFramer = new AgyLineFramer(AGY_MAX_LINE_BYTES);
    this.openSteps.clear();

    const args = agyDriveArgs(this.conversationId, {
      ...(model ? { model } : {}),
      ...(mode ? { mode } : {}),
    });
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(this.binary, args, {
        // `--conversation` resolves against the workspace, and the turn should run
        // in the session's own directory anyway.
        ...(this.info.cwd && existsSync(this.info.cwd) ? { cwd: this.info.cwd } : {}),
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      this.trace?.({ op: 'drive-spawn-failed', detail: `${this.binary}: ${String(error)}` });
      this.emit({ type: 'error', message: `Antigravity could not be launched: ${String(error)}` });
      return false;
    }

    this.proc = proc;
    this.launchModel = model;
    this.launchMode = mode;
    proc.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    proc.stderr.on('data', (chunk: Buffer) => {
      // stderr carries the "ignoring unsupported stream input message event" warning
      // that accompanies the exit-0 silent failure. Traced, never interpreted.
      this.trace?.({ op: 'drive-stderr', detail: chunk.toString('utf8').trim().slice(0, 400) });
    });
    proc.on('error', (error) => {
      this.trace?.({ op: 'drive-process-error', detail: String(error) });
      this.emit({ type: 'error', message: `Antigravity process error: ${String(error)}` });
    });
    proc.on('exit', (code) => {
      // A child we already replaced exits LATER; its exit must be a no-op or it
      // would end the turn the NEW child is running.
      if (this.proc !== proc) return;
      this.proc = undefined;
      this.onChildGone(code);
    });
    return true;
  }

  /**
   * The child is gone. Decide the turn's fate WITHOUT reading the exit code.
   *
   * 1.1.18 and 1.1.20 changed print-mode exit semantics in both directions —
   * benign tool errors and permission denials stopped being non-zero, a dropped
   * agent-state stream started being non-zero — so an exit status cannot say
   * whether a turn succeeded. The only fact that matters here is whether a
   * submitted turn is still owed a `result`.
   */
  private onChildGone(code: number | null): void {
    this.trace?.({ op: 'drive-child-exit', detail: `exit code ${String(code)} (diagnostic only)` });
    // The exit-0 silent-failure trap. Without this the client shows a turn that
    // never ends and no error anywhere.
    this.settleGeneration({
      op: 'drive-stream-closed-without-result',
      detail: `the child exited owing a result; exit code ${String(code)}`,
      message: 'Antigravity stopped without reporting the result of that turn, so it may not have run. Send it again.',
    });
  }

  private killChild(): void {
    const proc = this.proc;
    this.proc = undefined;
    if (!proc) return;
    try {
      proc.stdin.end();
    } catch {
      /* already closed; the kill below is what matters */
    }
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }

  // ── The stream ─────────────────────────────────────────────────────────────

  /**
   * Pump the child's NDJSON stdout, line by line, through the BOUNDED framer.
   *
   * The child is a subprocess whose output this process does not control: a bug,
   * a binary blob accidentally written to stdout, or a hostile `agy` on PATH can
   * all emit megabytes without a separator. Framing is delegated so the cap is
   * applied as each line CLOSES rather than only to an unterminated remainder —
   * the earlier spelling let an over-cap line through whenever it happened to
   * arrive with its newline, which made the bound a property of the writer's
   * chunking rather than of this reader.
   *
   * A dropped line is said out loud (§8: data really is being discarded), and the
   * framer resyncs at the next newline rather than handing us the tail of a line
   * whose head is gone.
   */
  private onStdout(chunk: Buffer): void {
    // The child's bytes go to the framer UNDECODED, so a pipe write that splits a
    // multibyte character mid-sequence cannot produce U+FFFD: the half-character
    // simply waits in the framer until the rest arrives. This also retires the
    // streaming TextDecoder — one decode site, on whole lines, rather than two
    // places that both had to be right.
    for (const frame of this.stdoutFramer.push(chunk)) {
      if (frame.dropped) {
        // A resync fragment is the remainder of a line already reported. Saying
        // it again would count one loss twice.
        if (frame.reason === 'resync') {
          this.trace?.({
            op: 'drive-stream-line-resync',
            detail: `discarded ${frame.bytes} bytes continuing an over-cap line`,
          });
          continue;
        }
        this.trace?.({
          op: 'drive-stream-line-oversized',
          detail: `dropped a ${frame.bytes}-byte stream line (cap ${AGY_MAX_LINE_BYTES})`,
        });
        this.emit({
          type: 'error',
          message: 'Antigravity sent a stream line too large to read, so part of this turn is missing.',
        });
        continue;
      }
      if (!frame.text.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(frame.text);
      } catch {
        this.trace?.({ op: 'drive-stream-unparseable', detail: frame.text.slice(0, 200) });
        continue;
      }
      try {
        this.handleStreamEvent(parsed as Record<string, unknown>);
      } catch (error) {
        // Isolate a mapper fault so one bad event cannot kill the stdout pump.
        this.trace?.({ op: 'drive-stream-handler-failed', detail: String(error) });
      }
    }
  }

  private handleStreamEvent(event: Record<string, unknown>): void {
    if (!event || typeof event !== 'object') return;
    const kind = classifyAgyStreamEvent(event);
    switch (kind) {
      case 'init':
        return this.handleInit(event);
      case 'step_update':
        return this.handleStepUpdate(event);
      case 'result':
        return this.handleResult(event);
      case 'unknown':
        this.trace?.({
          op: 'drive-stream-unknown-event',
          detail: `unrecognized stream envelope with keys: ${Object.keys(event).join(',')}`,
        });
        return;
    }
  }

  /**
   * `init` names the conversation, the model and the permission mode.
   *
   * The model is re-derived HERE rather than trusted from whatever the attach
   * decided: a value a create returned and nothing re-reads is not state
   * (reflection §5, dsh P9a). `permission_mode` is published as `currentMode` —
   * the contract field — and never as `permissionMode`, which is the
   * `PromptInput` key whose misuse blanked kimi's picker.
   */
  private handleInit(event: Record<string, unknown>): void {
    const patch: Partial<SessionInfo> = {};
    const model = typeof event.model === 'string' ? event.model : undefined;
    if (model) {
      this.launchModel = model;
      patch.currentModel = { providerID: 'google-antigravity', modelID: model };
    }
    const mode = typeof event.permission_mode === 'string' ? event.permission_mode : undefined;
    if (mode) {
      this.launchMode = mode;
      patch.currentMode = mode;
    }
    if (Object.keys(patch).length === 0) return;
    Object.assign(this.info, patch);
    this.emit({ type: 'metadata-update', key: 'sessionInfo', value: patch });
  }

  /**
   * Accumulate one step's deltas, and flush it through the SHARED fold when it settles.
   *
   * The stream names steps in lower snake case and the transcript in upper, and
   * `agent_response` ↔ `PLANNER_RESPONSE` is not a case fold — so the event is
   * normalized into the transcript's own record shape at this boundary and
   * everything downstream is the same `mapAgyStep()` the replay uses, keyed by
   * the same `agyStepKey()`. `step_index` agrees exactly between the two for the
   * same run, which is what makes that sound.
   */
  private handleStepUpdate(event: Record<string, unknown>): void {
    const stepIndex = typeof event.step_index === 'number' ? event.step_index : undefined;
    if (stepIndex === undefined) {
      this.trace?.({ op: 'drive-step-update-unindexed', detail: JSON.stringify(event).slice(0, 200) });
      return;
    }
    const stepType = normalizeAgyStreamStepType(
      typeof event.step_type === 'string' ? event.step_type : '',
    );
    const open = this.openSteps.get(stepIndex) ?? {
      type: stepType,
      text: '',
      textBytes: 0,
      status: 'RUNNING',
      createdAt: new Date().toISOString(),
      textTruncated: false,
    };
    open.type = stepType || open.type;
    if (typeof event.text_delta === 'string') {
      // One step's text is one response. A child that streams deltas without ever
      // settling the step would otherwise grow this string without limit, and the
      // growth is invisible until the process dies.
      //
      // Accounted in UTF-8 BYTES. The cap is documented in bytes, and comparing
      // it against `String.length` measured UTF-16 code units instead — so CJK
      // text overshot the stated budget by ~3× and emoji by ~4×, and a
      // `.slice()` cut could land between the halves of a surrogate pair and ship
      // a lone surrogate. `textBytes` is carried forward rather than recomputed,
      // so a long stream stays linear.
      const room = AGY_MAX_STEP_TEXT_BYTES - open.textBytes;
      if (room <= 0) {
        if (!open.textTruncated) {
          open.textTruncated = true;
          this.trace?.({
            op: 'drive-step-text-oversized',
            detail: `step ${stepIndex} passed the ${AGY_MAX_STEP_TEXT_BYTES}-byte cap; later deltas dropped`,
          });
        }
      } else {
        const fitted = truncateToUtf8Bytes(event.text_delta, room);
        open.text += fitted.text;
        open.textBytes += Buffer.byteLength(fitted.text, 'utf8');
        if (fitted.truncated) {
          open.textTruncated = true;
          this.trace?.({
            op: 'drive-step-text-oversized',
            detail: `step ${stepIndex} reached the ${AGY_MAX_STEP_TEXT_BYTES}-byte cap`,
          });
        }
      }
    }
    const state = typeof event.state === 'string' ? event.state : '';
    open.status = agyStepStatusForState(state);
    this.openSteps.set(stepIndex, open);
    this.evictOldestOpenSteps();
    if (isTerminalStreamState(state)) this.flushStep(stepIndex);
  }

  /**
   * Keep the open-step table bounded.
   *
   * Steps settle in order, so this never fires on a real turn. It exists because
   * the table is keyed by a number the CHILD chooses: a child reporting
   * ever-increasing `step_index` values that never reach a terminal state would
   * grow it forever. The oldest is flushed rather than deleted — reflection §9,
   * collapse never delete — so whatever it had accumulated is still rendered, and
   * the eviction itself is traced.
   */
  private evictOldestOpenSteps(): void {
    while (this.openSteps.size > AGY_MAX_OPEN_STEPS) {
      const oldest = this.openSteps.keys().next().value as number | undefined;
      if (oldest === undefined) return;
      this.trace?.({
        op: 'drive-open-steps-overflow',
        detail: `flushing step ${oldest}: more than ${AGY_MAX_OPEN_STEPS} steps open at once`,
      });
      this.flushStep(oldest);
      // `flushStep` already removes it. Repeating the delete makes this loop
      // provably terminate without depending on that.
      this.openSteps.delete(oldest);
    }
  }

  /** Fold one settled step and emit it, exactly once. */
  private flushStep(stepIndex: number): void {
    const open = this.openSteps.get(stepIndex);
    if (!open) return;
    this.openSteps.delete(stepIndex);
    // The transcript tail will ALSO see this step when agy writes it to the file.
    // `seenSteps` is shared fold state, so whichever path reaches it first admits
    // it and the other skips it — the exactly-once guarantee spans both.
    if (this.state.seenSteps.has(stepIndex)) return;
    this.state.seenSteps.add(stepIndex);
    // A capped step is rendered WITH its cap stated. A silently short step reads
    // as a model that stopped mid-sentence, which is a different bug entirely.
    const content = open.textTruncated
      ? `${open.text}\n\n${AGY_STEP_TRUNCATION_NOTE}`
      : open.text;
    const step: AgyStep = {
      step_index: stepIndex,
      source: agySourceForStepType(open.type),
      type: open.type,
      status: open.status,
      created_at: open.createdAt,
      ...(content ? { content } : {}),
    };
    // The fold reports a live child, so a RUNNING row reads as running here — the
    // same row replayed later with no child reads as interrupted.
    this.state.liveChild = true;
    for (const message of mapAgyStep(step, this.state)) this.emit(message);
  }

  /**
   * One `result` ends one turn. This is the ONLY place a turn's outcome is decided.
   */
  private handleResult(event: Record<string, unknown>): void {
    for (const stepIndex of [...this.openSteps.keys()]) this.flushStep(stepIndex);

    const usage = (event.usage ?? {}) as Record<string, unknown>;
    const input = numberOrUndefined(usage.input);
    const output = numberOrUndefined(usage.output);
    const cacheRead = numberOrUndefined(usage.cache_read);
    if (input !== undefined || output !== undefined || cacheRead !== undefined) {
      // `usage.thinking` is a fourth bucket agy reports and the protocol has no
      // field for. It is deliberately NOT folded into `output`: inventing a sum
      // is exactly the class of error the token-count contract warns about, and a
      // reading nobody can attribute is worse than one field being absent.
      this.emit({
        type: 'token-count',
        ...(input !== undefined ? { input } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(cacheRead !== undefined ? { cacheRead } : {}),
      });
    }

    this.awaitingResult = Math.max(0, this.awaitingResult - 1);
    const status = typeof event.status === 'string' ? event.status : '';
    // Outcome from the RESULT EVENT, never from an exit code.
    if (status && !/^success$/i.test(status)) {
      const detail = typeof event.error === 'string' && event.error ? `: ${event.error}` : '';
      this.emit({ type: 'error', message: `Antigravity reported ${status}${detail}` });
    }
    if (this.awaitingResult === 0 && this.running) {
      this.running = false;
      this.emit({ type: 'status', status: 'idle' });
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  override async respondPermission(_requestId: string, _decision: PermissionDecision): Promise<void> {
    // agy publishes no permission channel over stream-json, and answering by
    // writing a prompt would put words in the conversation the user never typed.
    throw new Error('Antigravity approvals must be answered where the session runs; this build cannot relay them.');
  }

  /**
   * Close: the ONLY thing that drops the accepted prompts.
   *
   * A demotion keeps them (they were already written to stdin, so killing the
   * child proves nothing about what it buffered). A close means this connection
   * is finished and nobody will replay them again.
   */
  override async close(): Promise<void> {
    this.killChild();
    this.pendingRows.length = 0;
    this.queuedSends.pending.length = 0;
    this.queuedSends.byStep.clear();
    await super.close();
    this.onCloseHook?.(this);
  }
}

/**
 * Which of the three measured envelopes this line is.
 *
 * The three event names are MEASURED; how they are DISCRIMINATED is the one part
 * of the envelope the probe recorded loosely (the capture shows `conversation_id`
 * as a sibling of an `init` object, which is consistent with both a nested-object
 * envelope and a flat `type`/`event` tag). Both spellings are therefore accepted,
 * and anything matching neither is traced rather than guessed at — so if upstream
 * turns out to use a third shape, it shows up as an unknown envelope in the log
 * instead of as a silently empty transcript.
 */
export function classifyAgyStreamEvent(
  event: Record<string, unknown>,
): 'init' | 'step_update' | 'result' | 'unknown' {
  const tag = typeof event.type === 'string'
    ? event.type
    : typeof event.event === 'string'
      ? event.event
      : undefined;
  if (tag === 'init' || tag === 'step_update' || tag === 'result') return tag;
  if ('init' in event) return 'init';
  if ('step_update' in event) return 'step_update';
  if ('result' in event) return 'result';
  // Flat envelopes with no tag at all: infer from the fields that only one of the
  // three carries. `step_index` is unique to a step update; `num_turns` to a result.
  if (typeof event.step_index === 'number') return 'step_update';
  if ('num_turns' in event) return 'result';
  if ('tools' in event && 'cwd' in event) return 'init';
  return 'unknown';
}

/**
 * Terminal stream states, matched loosely because only `STEP_DONE` was captured.
 *
 * Exported so the test can assert this and {@link agyStepStatusForState} AGREE.
 * They disagreed once — `CANCEL` matched here and fell through to `RUNNING`
 * there — and the result was a step that flushed as terminal while carrying a
 * running status, i.e. a spinner nothing would ever stop.
 */
export function isTerminalStreamState(state: string): boolean {
  return /DONE|COMPLETE|ERROR|FAIL|CANCEL|ABORT|INTERRUPT/i.test(state);
}

/**
 * Map a stream `state` onto the transcript's own `status` vocabulary.
 *
 * Four values out, not three. The file corpus only ever carries `DONE`,
 * `RUNNING` and `ERROR`, but the STREAM has a fourth state the files do not
 * record — a step that was stopped part-way — and it needs its own terminal
 * spelling rather than borrowing `RUNNING` (which renders as in-flight) or
 * `ERROR` (which says the host failed when it did what it was told).
 *
 * Every state {@link isTerminalStreamState} accepts MUST return a terminal
 * status here. That is the invariant the cancel case broke.
 */
export function agyStepStatusForState(state: string): string {
  if (/ERROR|FAIL/i.test(state)) return 'ERROR';
  if (/CANCEL|ABORT|INTERRUPT/i.test(state)) return AGY_CANCELED_STATUS;
  if (/DONE|COMPLETE/i.test(state)) return 'DONE';
  return 'RUNNING';
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
