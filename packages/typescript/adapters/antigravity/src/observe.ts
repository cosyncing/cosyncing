/**
 * Read-only observe over the JSONL transcript.
 *
 * The shape follows the repository's other transcript-tailing adapter, because
 * the problem is the same one: replay an append-only file as history, then follow
 * its appends, and never let a step be admitted twice across the buffered,
 * cutoff and re-read paths. What differs is the exactly-once key — claude
 * partitions by byte offset alone, agy also has a real step identity
 * (`step_index`, unique within every one of the 29 corpus transcripts, MEASURED
 * 2026-08-25), so the tail is fenced by BOTH: the offset bounds the work, and
 * the step set makes a double-admit impossible even if the offset is wrong.
 */
import { existsSync, statSync, watch, type FSWatcher } from 'node:fs';
import type {
  AgentMessage,
  AgentMessageHandler,
  HistoryQuery,
  PermissionDecision,
  PromptInput,
  SessionConnection,
  SessionInfo,
  Unsubscribe,
} from '@cosyncing/adapter-api';
import {
  createAgyMapState,
  mapAgySettlement,
  mapAgyStep,
  parseAgySettlement,
  parseAgyStep,
  type AgyMapState,
  type AgyStep,
} from './mapping.ts';
import {
  AGY_MAX_LINE_BYTES,
  AGY_SETTLEMENT_MAX_BYTES,
  AGY_TAIL_READ_MAX_BYTES,
  AGY_TRANSCRIPT_MAX_BYTES,
  AgyLineFramer,
  isAgyReadRefusal,
  readContainedRange,
  readContainedThroughLastNewline,
  type AgyFrame,
} from './safe-read.ts';
import {
  agyTranscriptFullPath,
  agyTranscriptPath,
  listAgySettlementFiles,
  readAgyTextFile,
  type AgyRoots,
  type AgyTraceSink,
} from './store.ts';

/** Debounce on the fs watch, mirroring claude's 80 ms. */
const TAIL_DEBOUNCE_MS = 80;

export interface AgyObserveOptions {
  roots: AgyRoots;
  conversationId: string;
  info: SessionInfo;
  trace?: AgyTraceSink;
  /**
   * Per-drain read ceiling. Defaults to {@link AGY_TAIL_READ_MAX_BYTES}.
   *
   * A seam, not a knob: the interesting behaviour lives exactly at this boundary
   * — a multibyte character straddling one drain's cut — and materializing 8 MiB
   * to reach the real one costs a suite far more than the assertion is worth.
   * Production never passes it, and a test asserts the default IS the constant so
   * the shrunken bound cannot drift away from what ships.
   */
  tailReadMaxBytes?: number;
}

export class AgyObserveConnection implements SessionConnection {
  readonly info: SessionInfo;

  protected readonly roots: AgyRoots;
  protected readonly conversationId: string;
  protected readonly trace?: AgyTraceSink;
  private readonly handlers = new Set<AgentMessageHandler>();
  protected readonly path: string;

  private watcher?: FSWatcher;
  protected closed = false;
  /** Bytes consumed by the live tail. Baselined by `getHistory()`; reset by a re-baseline. */
  private offset = 0;
  /** File size seen at the last baseline, so a SHRINK is detectable as a rewrite. */
  private baselineSize = 0;
  /** Frames the tail's bytes into lines, bounding each one as it closes. */
  private readonly tailFramer = new AgyLineFramer(AGY_MAX_LINE_BYTES);
  /** Per-drain read ceiling. The production value unless a test injects a reachable one. */
  readonly tailReadMaxBytes: number;
  /** The tail stays inert until `getHistory()` has partitioned the file. */
  private primed = false;
  protected state: AgyMapState;
  private pendingDrain?: ReturnType<typeof setTimeout>;
  private draining = false;

  constructor(options: AgyObserveOptions) {
    this.roots = options.roots;
    this.conversationId = options.conversationId;
    this.info = options.info;
    if (options.trace) this.trace = options.trace;
    this.tailReadMaxBytes = options.tailReadMaxBytes ?? AGY_TAIL_READ_MAX_BYTES;
    this.path = agyTranscriptPath(options.roots, options.conversationId);
    this.state = this.buildMapState();
  }

  /**
   * Build the fold state for a (re)play.
   *
   * A hook rather than an inline literal so the DRIVE subclass can inject its
   * per-connection queued-send table and its live-child flag — and so that
   * injection happens in exactly one place for both the replay and the tail,
   * which is what keeps "one fact, one code path" true across them.
   *
   * Observe never owns a child, so a `RUNNING` row replayed here is interrupted
   * rather than running (see `agyIsErrorRow` in the mapper).
   */
  protected buildMapState(): AgyMapState {
    return createAgyMapState(this.conversationId, {
      liveChild: false,
      ...(this.trace ? { trace: this.trace } : {}),
    });
  }

  /** Rows appended AFTER the transcript replay. Drive returns its minted pending prompts here,
   *  because an ordinary attach replays `getHistory()` and nothing else (reflection §6). */
  protected extraHistoryRows(): AgentMessage[] {
    return [];
  }

  /** Called for every step admitted on either path, after it is mapped. Drive uses it to notice a
   *  `USER_EXPLICIT` line it did not submit — the foreign-write signal. */
  protected onStepAdmitted(_step: AgyStep, _messages: AgentMessage[], _source: 'replay' | 'tail'): void {
    /* observe has nothing to correlate */
  }

  subscribe(handler: AgentMessageHandler): Unsubscribe {
    this.handlers.add(handler);
    if (!this.watcher && !this.closed) this.startTail();
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Replay the transcript.
   *
   * ONE read, up to the last complete line. A partial trailing line being
   * written right now is excluded from history and picked up whole by the tail
   * once its newline lands, so the two paths partition the file rather than
   * overlapping it.
   *
   * A conversation with a store and NO transcript — 2 of 27 CLI conversations
   * measured 2026-08-25 — returns a STATED notice, never a blank session. That
   * is spec §4's "failure traces" requirement and reflection §8's: degrading is
   * fine, degrading silently is not.
   */
  async getHistory(_query?: HistoryQuery): Promise<AgentMessage[]> {
    // Every replay starts from a fresh fold, so a re-read is idempotent: the
    // pending-call queue and the admitted-step set are rebuilt from the file
    // rather than carried over from a previous pass. The queued-send table is
    // the deliberate exception — it is per-connection live state the drive
    // subclass owns, and `buildMapState` re-attaches the SAME object.
    this.state = this.buildMapState();

    if (!existsSync(this.path)) {
      this.trace?.({ op: 'transcript-missing', detail: `no transcript.jsonl for ${this.conversationId}` });
      this.primed = true;
      this.offset = 0;
      this.baselineSize = 0;
      return [
        {
          type: 'notice',
          message:
            'Antigravity kept no JSONL transcript for this conversation, so its history cannot be replayed here. '
            + 'The conversation itself is intact in the CLI — resume it in a terminal to read it.',
        },
        ...this.settlementMessages(),
        ...this.extraHistoryRows(),
      ];
    }

    const read = readContainedThroughLastNewline(
      this.roots.appData,
      this.path,
      AGY_TRANSCRIPT_MAX_BYTES,
      this.trace,
    );
    // The file existed a moment ago, so a refusal here is not absence: it is a
    // path that resolves outside the store, a symlink, or a non-regular file.
    // Say which rather than rendering an empty conversation.
    if (isAgyReadRefusal(read)) {
      this.primed = true;
      this.offset = 0;
      this.baselineSize = 0;
      return [
        {
          type: 'notice',
          message:
            'Antigravity’s transcript for this conversation could not be read safely, so its history is not shown. '
            + `The file at the expected path was refused (${read}).`,
        },
        ...this.settlementMessages(),
        ...this.extraHistoryRows(),
      ];
    }
    const { bytes, boundary, size, truncated } = read;
    const out: AgentMessage[] = [];
    // Byte offsets are tracked line by line: they are the drive path's clock-free
    // fence for deciding whether a `USER_INPUT` line delivers a prompt we sent.
    // Framed from RAW BYTES through the same framer as the tail, so the two paths
    // agree on what a line is and neither measures a re-encoded string.
    let lineOffset = 0;
    const framer = new AgyLineFramer(AGY_MAX_LINE_BYTES);
    for (const frame of framer.push(bytes)) {
      const startedAt = lineOffset;
      // A dropped frame still ADVANCES the offset by what it occupied: the fence
      // describes positions in the file, not in what we chose to parse.
      lineOffset += frame.bytes + 1;
      if (frame.dropped) {
        this.traceDroppedFrame(frame, startedAt);
        continue;
      }
      const step = parseAgyStep(frame.text, startedAt);
      if (!step) continue;
      if (this.state.seenSteps.has(step.step_index)) continue;
      this.state.seenSteps.add(step.step_index);
      const mapped = this.withTruncationFallback(step);
      this.onStepAdmitted(step, mapped, 'replay');
      out.push(...mapped);
    }

    // A capped replay stops mid-conversation, which looks exactly like a
    // conversation that ended. Say that it did not. The remainder is not lost:
    // `offset` sits at the cap, so the bounded tail carries the rest forward.
    if (truncated) {
      out.push({
        type: 'notice',
        message:
          `This conversation’s transcript is ${size} bytes, past the ${AGY_TRANSCRIPT_MAX_BYTES}-byte replay limit. `
          + 'The earlier part is shown above; the rest streams in as it is read.',
      });
      this.trace?.({
        op: 'transcript-oversized',
        detail: `${this.path}: replayed ${boundary} of ${size} bytes`,
      });
    }

    this.offset = boundary;
    this.baselineSize = size;
    this.tailFramer.reset();
    this.primed = true;
    // Catch anything appended DURING this read — and, after a capped replay,
    // everything past the cap.
    if (this.watcher) this.scheduleDrain(0);

    return [...out, ...this.settlementMessages(), ...this.extraHistoryRows()];
  }

  protected emit(message: AgentMessage): void {
    for (const handler of this.handlers) {
      try {
        handler(message);
      } catch {
        /* isolate one bad subscriber */
      }
    }
  }

  /**
   * Say that a line was dropped, and why.
   *
   * A bounded reader that silently discards input is indistinguishable from a
   * transcript that never held the step (reflection §8). The two reasons are kept
   * apart on purpose: `oversized` is a real step this session refused to hold,
   * while `resync` is the tail of one already refused — reporting the second as a
   * dropped step would double-count one loss.
   */
  private traceDroppedFrame(frame: AgyFrame, offset: number): void {
    this.trace?.({
      op: frame.reason === 'resync' ? 'transcript-line-resync' : 'transcript-line-oversized',
      detail: frame.reason === 'resync'
        ? `${this.path}: discarded ${frame.bytes} bytes continuing an over-cap line at offset ${offset}`
        : `${this.path}: dropped a ${frame.bytes}-byte line at offset ${offset} (cap ${AGY_MAX_LINE_BYTES})`,
    });
  }

  private startTail(): void {
    try {
      this.watcher = watch(this.path, () => this.scheduleDrain(TAIL_DEBOUNCE_MS));
    } catch {
      // fs.watch is unavailable here (a missing file, an unsupported filesystem):
      // history still works, the session just does not follow live.
      this.trace?.({ op: 'tail-watch-unavailable', detail: `cannot watch ${this.path}` });
    }
  }

  private scheduleDrain(delayMs: number): void {
    if (this.closed) return;
    if (this.pendingDrain) clearTimeout(this.pendingDrain);
    this.pendingDrain = setTimeout(() => {
      this.pendingDrain = undefined;
      void this.drainTail();
    }, delayMs);
  }

  /**
   * Read what was appended past `offset` and emit each newly-complete step once.
   *
   * Three fences, and all three are needed:
   *  - `primed` keeps the tail inert until history has partitioned the file.
   *  - `offset` bounds the read so a growing file is not re-scanned from zero.
   *  - `seenSteps` is the identity fence: even if the offset is wrong (a
   *    debounced double-fire, a drain racing a `getHistory()`), a step already
   *    admitted cannot be emitted a second time.
   */
  private async drainTail(): Promise<void> {
    if (!this.primed || this.closed || this.draining) return;
    this.draining = true;
    try {
      let size: number;
      try {
        size = statSync(this.path).size;
      } catch {
        return;
      }

      // A SHRINK means the file was replaced or rewritten, not appended to. The
      // offset now points into unrelated bytes and the admitted-step set describes
      // a file that no longer exists, so the only correct move is to re-baseline
      // WHOLESALE and tell every client to reload — a partial re-read would splice
      // two different transcripts together.
      if (size < this.baselineSize) {
        this.trace?.({
          op: 'transcript-rewritten',
          detail: `size fell from ${this.baselineSize} to ${size}; re-baselining ${this.conversationId}`,
        });
        this.offset = 0;
        this.baselineSize = 0;
        this.tailFramer.reset();
        this.primed = false;
        this.emit({ type: 'history-reset', notice: 'The Antigravity transcript was rewritten; reloading it.' });
        return;
      }
      if (size <= this.offset) return;

      const readFrom = this.offset;
      const chunk = readContainedRange(
        this.roots.appData,
        this.path,
        this.offset,
        size,
        this.tailReadMaxBytes,
        this.trace,
      );
      if (isAgyReadRefusal(chunk)) return;
      // RAW BYTES, deliberately. Consecutive drains cut the file at an arbitrary
      // offset, so a multibyte character routinely straddles that cut; decoding
      // each range on its own produced U+FFFD on both sides and changed the
      // line's measured length, drifting every later `byteOffset` in the drain.
      this.offset = readFrom + chunk.bytesRead;
      this.baselineSize = size;
      // The read is capped, so a huge append is consumed across drains rather
      // than in one allocation. Keep draining until the offset catches up.
      if (chunk.truncated) this.scheduleDrain(0);
      // Where the buffered remainder STARTS in the file, so every line drained
      // below carries its true byte offset — the drive fence needs the absolute
      // position, not one relative to this read.
      let lineOffset = readFrom - this.tailFramer.buffered;

      // The framer enforces the per-line cap as each line CLOSES. The previous
      // loop checked only the unterminated remainder afterwards, so a line past
      // the cap that arrived with its newline — in one chunk, or split across
      // chunks ending on it — was framed and emitted whole, cap untouched and
      // nothing traced. Whether the bound held depended on the writer's chunking.
      for (const frame of this.tailFramer.push(chunk.bytes)) {
        const startedAt = lineOffset;
        // A dropped frame still advances the offset by what it occupied: the
        // fence describes positions in the file, not in what we chose to parse.
        lineOffset += frame.bytes + 1;
        if (frame.dropped) {
          this.traceDroppedFrame(frame, startedAt);
          continue;
        }
        const step = parseAgyStep(frame.text, startedAt);
        if (!step) continue;
        if (this.state.seenSteps.has(step.step_index)) continue;
        this.state.seenSteps.add(step.step_index);
        const mapped = this.withTruncationFallback(step);
        this.onStepAdmitted(step, mapped, 'tail');
        for (const message of mapped) this.emit(message);
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Fill a truncated field from `transcript_full.jsonl` when that file has it.
   *
   * `truncated_fields` names what `transcript.jsonl` elided (363 of 2,664 lines,
   * always `["content"]`). The untruncated variant exists for only 25 of 29
   * conversations, so this recovers what it can and the mapper states the
   * truncation for the rest — never a silently short row.
   */
  private withTruncationFallback(step: ReturnType<typeof parseAgyStep> & object): AgentMessage[] {
    const truncated = step.truncated_fields ?? [];
    if (truncated.length === 0) return mapAgyStep(step, this.state);
    const full = this.fullStep(step.step_index);
    if (!full) return mapAgyStep(step, this.state);
    const repaired = { ...step };
    let recovered = false;
    for (const field of truncated) {
      if (field === 'content' && typeof full.content === 'string') {
        repaired.content = full.content;
        recovered = true;
      } else if (field === 'thinking' && typeof full.thinking === 'string') {
        repaired.thinking = full.thinking;
        recovered = true;
      }
    }
    // Only clear the marker for fields actually recovered; a field named in
    // `truncated_fields` that the full transcript does not carry stays stated.
    if (recovered) {
      const unrecovered = truncated.filter(
        (field) => !((field === 'content' || field === 'thinking') && typeof full[field] === 'string'),
      );
      if (unrecovered.length > 0) repaired.truncated_fields = unrecovered;
      else delete repaired.truncated_fields;
    }
    return mapAgyStep(repaired, this.state);
  }

  /** Lazily-built index of `transcript_full.jsonl` by step index. */
  private fullIndex?: Map<number, NonNullable<ReturnType<typeof parseAgyStep>>>;

  private fullStep(stepIndex: number): NonNullable<ReturnType<typeof parseAgyStep>> | undefined {
    if (!this.fullIndex) {
      this.fullIndex = new Map();
      const fullPath = agyTranscriptFullPath(this.roots, this.conversationId);
      const read = readAgyTextFile(this.roots.appData, fullPath, AGY_TRANSCRIPT_MAX_BYTES, this.trace);
      if (read === undefined) {
        this.trace?.({
          op: 'transcript-full-missing',
          detail: `no transcript_full.jsonl for ${this.conversationId}; truncations will be stated`,
        });
      } else {
        // A capped read may end mid-line; that partial line simply fails to parse
        // and the step it would have repaired keeps its stated truncation, which
        // is the same outcome as the file being absent.
        if (read.truncated) {
          this.trace?.({
            op: 'transcript-full-oversized',
            detail: `${fullPath} exceeds the ${AGY_TRANSCRIPT_MAX_BYTES}-byte cap; later truncations stay stated`,
          });
        }
        for (const line of read.text.split('\n')) {
          const step = parseAgyStep(line);
          if (step) this.fullIndex.set(step.step_index, step);
        }
      }
    }
    return this.fullIndex.get(stepIndex);
  }

  /**
   * Finished background tasks, as self-contained tool blocks.
   *
   * These are durable: a settled task leaves its inbox file behind permanently,
   * so unlike claude's finished subagents (reflection §9, still open there) an
   * agy background task still renders after it completes.
   */
  private settlementMessages(): AgentMessage[] {
    const out: AgentMessage[] = [];
    for (const file of listAgySettlementFiles(this.roots, this.conversationId, this.trace)) {
      const read = readAgyTextFile(this.roots.appData, file, AGY_SETTLEMENT_MAX_BYTES, this.trace);
      if (read === undefined) continue;
      // A truncated settlement is a truncated JSON document: unparseable, and
      // reporting it as unparseable would name the wrong cause.
      if (read.truncated) {
        this.trace?.({
          op: 'settlement-oversized',
          detail: `${file} exceeds the ${AGY_SETTLEMENT_MAX_BYTES}-byte cap`,
        });
        continue;
      }
      const settlement = parseAgySettlement(read.text);
      if (!settlement) {
        this.trace?.({ op: 'settlement-unparseable', detail: file });
        continue;
      }
      out.push(...mapAgySettlement(settlement, this.conversationId));
    }
    return out;
  }

  // ── Observe is read-only ───────────────────────────────────────────────────

  // Declared with the SPI's own parameter lists rather than as zero-arg stubs, so
  // the Drive subclass can override them: a narrower base signature would make
  // the real implementation unassignable.
  async sendPrompt(_input: PromptInput): Promise<void> {
    throw new Error('This is a read-only view of the session. Tap “Drive” to take it over and send prompts.');
  }

  // Defense in depth: a read-only attach must not silently swallow a mutation
  // that bypassed the broker's own ownership gate.
  async respondPermission(_requestId: string, _decision: PermissionDecision): Promise<void> {
    throw new Error('This is a read-only view of the session. Tap “Drive” to take it over to approve actions.');
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.pendingDrain) {
      clearTimeout(this.pendingDrain);
      this.pendingDrain = undefined;
    }
    this.watcher?.close();
    this.watcher = undefined;
    this.handlers.clear();
  }
}
