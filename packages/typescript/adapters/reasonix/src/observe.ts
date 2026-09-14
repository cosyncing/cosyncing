/** Read-only replay and append tail for one Reasonix transcript. */
import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type {
  AgentMessage,
  AgentMessageHandler,
  HistorySnapshotCapture,
  HistorySnapshotPageRead,
  HistorySnapshotPageReader,
  HistorySnapshotRefusal,
  HistorySnapshotSink,
  HistorySourceIdentity,
  HistoryQuery,
  PermissionDecision,
  PromptInput,
  SessionConnection,
  SessionInfo,
  Unsubscribe,
} from '@cosyncing/adapter-api';
import {
  mapReasonixRecord,
  mapReasonixInterruptedTail,
  mapReasonixTranscript,
  reasonixMessageKey,
  type ReasonixDisplayEntry,
  type ReasonixMapTrace,
  type ReasonixTranscriptRecord,
} from './mapping.ts';
import {
  REASONIX_CORRELATION_MAX_ENTRIES_PER_SESSION,
  type ReasonixCorrelationRegistry,
} from './correlation.ts';
import {
  readReasonixTranscript,
  readReasonixAcpPosture,
  reasonixHistorySourceIdentity,
  reasonixSessionUsageValue,
  type ReasonixApprovalMode,
  type ReasonixSessionUsage,
  type ReasonixStoredSession,
  type ReasonixTranscriptRead,
} from './store.ts';

const TAIL_DEBOUNCE_MS = 80;
const HISTORY_CAPTURE_ATTEMPTS = 4;
const HISTORY_RETRY_MS = 20;
const WATCH_REARM_MS = 100;
const WATCH_REARM_ATTEMPTS = 8;
const WATCH_STABLE_MS = 1_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface FileBoundary {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

export interface ReasonixObserveOptions {
  session: ReasonixStoredSession;
  info: SessionInfo;
  trace?: (event: ReasonixMapTrace | { op: 'observe'; detail: string }) => void;
  /** Deterministic race injection for the synthetic snapshot tests. */
  captureTestHook?: () => void | Promise<void>;
  /** Deterministic race injection for ordinary replay/tail snapshot tests. */
  snapshotTestHook?: (attempt: number) => void | Promise<void>;
  /** Deterministic watcher failure injection for lifecycle tests. */
  watchFactory?: typeof watch;
  watchStableMs?: number;
  correlationRegistry?: ReasonixCorrelationRegistry;
}

async function fileBoundary(path: string): Promise<FileBoundary | undefined> {
  try {
    const value = await stat(path, { bigint: true });
    if (!value.isFile()) return undefined;
    return {
      dev: value.dev,
      ino: value.ino,
      size: value.size,
      mtimeNs: value.mtimeNs,
      ctimeNs: value.ctimeNs,
    };
  } catch {
    return undefined;
  }
}

function sameFileBoundary(left: FileBoundary | undefined, right: FileBoundary | undefined): boolean {
  return left !== undefined
    && right !== undefined
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameOptionalFileBoundary(left: FileBoundary | undefined, right: FileBoundary | undefined): boolean {
  return (left === undefined && right === undefined) || sameFileBoundary(left, right);
}

function sameSourceIdentity(
  left: HistorySourceIdentity | undefined,
  right: HistorySourceIdentity | undefined,
): left is HistorySourceIdentity {
  return left !== undefined
    && right !== undefined
    && left.sourceId === right.sourceId
    && left.revision === right.revision
    && left.appendPosition === right.appendPosition
    && left.rewriteToken === right.rewriteToken;
}

class ReasonixMemoryHistoryReader implements HistorySnapshotPageReader {
  readonly retainedBytes: number;

  constructor(
    private readonly identity: HistorySourceIdentity,
    private readonly messages: readonly AgentMessage[],
  ) {
    this.retainedBytes = Buffer.byteLength(JSON.stringify(messages), 'utf8') + messages.length * 16;
  }

  read(locations: readonly number[]): HistorySnapshotPageRead | HistorySnapshotRefusal | undefined {
    const messages: AgentMessage[] = [];
    let bytesRead = 0;
    for (const location of locations) {
      if (!Number.isSafeInteger(location) || location < 0) return undefined;
      const message = this.messages[location];
      if (!message) return undefined;
      messages.push(message);
      bytesRead += Buffer.byteLength(JSON.stringify(message), 'utf8');
    }
    return {
      identity: { ...this.identity },
      messages,
      work: { recordsRead: messages.length, bytesRead },
    };
  }
}

function displayPrefix(entries: readonly ReasonixDisplayEntry[], count: number): string {
  return JSON.stringify(entries
    .filter((entry) => entry.index < count)
    .map((entry) => [
      entry.index,
      entry.offset,
      entry.length,
      entry.role ?? null,
    ]));
}

function sameDurablePrefix(current: Buffer, accepted: Buffer): boolean {
  return current.length >= accepted.length
    && current.subarray(0, accepted.length).equals(accepted);
}

function sidecarsCoverRead(read: ReasonixTranscriptRead, display: FileBoundary | undefined): boolean {
  if (read.eventJournalReconciled === true) {
    if (read.issues.length > 0) return false;
    const indexes = new Set(read.displayEntries.map((entry) => entry.index));
    return read.displayEntries.length === read.records.length
      && indexes.size === read.records.length
      && read.records.every((_record, index) => indexes.has(index));
  }
  if (
    read.eventRevision !== undefined
    && read.displayRevision !== undefined
    && read.eventRevision !== read.displayRevision
  ) return false;
  if (display === undefined) return true;
  if (read.issues.some((issue) => issue.includes('display index'))) return false;
  if (read.displayEntries.length !== read.records.length) return false;
  const indexes = new Set(read.displayEntries.map((entry) => entry.index));
  return indexes.size === read.records.length
    && read.records.every((_record, index) => indexes.has(index));
}

export interface StableReasonixSnapshot {
  read: ReasonixTranscriptRead;
  identity: HistorySourceIdentity;
}

export class ReasonixObserveConnection implements SessionConnection {
  readonly info: SessionInfo;
  protected readonly session: ReasonixStoredSession;
  protected readonly trace?: ReasonixObserveOptions['trace'];
  protected readonly correlationRegistry?: ReasonixCorrelationRegistry;
  private readonly captureTestHook?: ReasonixObserveOptions['captureTestHook'];
  private readonly snapshotTestHook?: ReasonixObserveOptions['snapshotTestHook'];
  private readonly handlers = new Set<AgentMessageHandler>();
  private watcher?: FSWatcher;
  private pendingDrain?: ReturnType<typeof setTimeout>;
  private pendingWatcherRearm?: ReturnType<typeof setTimeout>;
  private pendingWatcherStable?: ReturnType<typeof setTimeout>;
  private watcherRearmAttempts = 0;
  private draining = false;
  private drainAgain = false;
  private closed = false;
  private primed = false;
  private recordCount = 0;
  private durablePrefixValue: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private displayPrefixValue = '[]';
  private sourceId?: string;
  private appendPosition = 0;
  private revision?: string;
  private readonly watchFactory: typeof watch;
  private readonly watchStableMs: number;
  private readonly uncorrelatedRows = new Set<string>();
  private unsubscribeCorrelation?: () => void;
  private correlationResetPending = false;
  private usageSignature: string;
  private currentMode?: string;

  constructor(options: ReasonixObserveOptions) {
    this.session = options.session;
    this.info = options.info;
    if (options.trace) this.trace = options.trace;
    if (options.correlationRegistry) {
      this.correlationRegistry = options.correlationRegistry;
      this.unsubscribeCorrelation = options.correlationRegistry.subscribe(this.session.id, ({ rowIdentity }) => {
        if (!this.uncorrelatedRows.delete(rowIdentity)) return;
        this.correlationResetPending = true;
        this.flushCorrelationReset();
      });
    }
    if (options.captureTestHook) this.captureTestHook = options.captureTestHook;
    if (options.snapshotTestHook) this.snapshotTestHook = options.snapshotTestHook;
    this.watchFactory = options.watchFactory ?? watch;
    this.watchStableMs = options.watchStableMs ?? WATCH_STABLE_MS;
    this.usageSignature = JSON.stringify(reasonixSessionUsageValue(this.session.usage) ?? null);
    this.currentMode = this.session.currentMode;
  }

  async getHistory(_query?: HistoryQuery): Promise<AgentMessage[]> {
    const snapshot = await this.readStableSnapshot();
    if (!snapshot) throw new Error('Reasonix history files did not converge on one supported revision.');
    const { read, identity } = snapshot;
    const rewritten = this.primed && this.isHistoryRewrite(read, identity);
    if (rewritten) {
      this.onHistoryRewrite();
      this.emitHistoryReset();
    }
    const messages = mapReasonixTranscript(
      this.session.id,
      read.records,
      read.displayEntries,
      this.trace,
    );
    const interrupted = await this.interruptedTail(read);
    if (interrupted) messages.push(interrupted);
    const usage = reasonixSessionUsageValue(this.session.usage);
    if (usage) messages.push({ type: 'metadata-update', key: 'sessionUsage', value: usage });
    this.onHistorySnapshot(read.records, read.displayEntries, messages, read.byteLength, snapshot);
    this.applySnapshotCorrelations(read, identity, messages);
    this.markCorrelationReplaySynchronized();
    for (const issue of read.issues) messages.unshift({ type: 'notice', message: `Reasonix history: ${issue}.` });
    // A replay can race the debounced watcher for another attached client.
    // Do not consume an ordinary append from the subscription cursor: the
    // watcher must still publish it. Initial priming and an authoritative
    // rewrite reset are the only replay-side cursor transitions.
    if (!this.primed || rewritten) this.setTailCursor(read, identity);
    return messages;
  }

  getHistorySourceIdentity() {
    return reasonixHistorySourceIdentity(this.session);
  }

  /**
   * Non-consuming stable replay inspection for Drive admission. It runs the
   * same ownership/rewrite hooks as getHistory but leaves ordinary appended
   * rows on the watcher cursor so existing subscribers still receive them.
   */
  protected async inspectHistoryForDrive(): Promise<ReasonixTranscriptRead> {
    const snapshot = await this.readStableSnapshot();
    if (!snapshot) throw new Error('Reasonix history files did not converge on one supported revision.');
    const { read, identity } = snapshot;
    const rewritten = this.primed && this.isHistoryRewrite(read, identity);
    if (rewritten) {
      this.onHistoryRewrite();
      this.emitHistoryReset();
    }
    const messages = mapReasonixTranscript(
      this.session.id,
      read.records,
      read.displayEntries,
      this.trace,
    );
    this.onHistorySnapshot(read.records, read.displayEntries, messages, read.byteLength, snapshot);
    this.applySnapshotCorrelations(read, identity, messages);
    this.markCorrelationReplaySynchronized();
    if (!this.primed || rewritten) this.setTailCursor(read, identity);
    return read;
  }

  async captureHistorySnapshot(
    sink: HistorySnapshotSink,
    _query?: HistoryQuery,
  ): Promise<HistorySnapshotCapture | HistorySnapshotRefusal | undefined> {
    for (let attempt = 0; attempt < HISTORY_CAPTURE_ATTEMPTS; attempt += 1) {
      const [identityBefore, transcriptBefore, displayBefore, eventBefore, eventLogBefore, metaBefore] = await Promise.all([
        reasonixHistorySourceIdentity(this.session),
        fileBoundary(this.session.transcriptPath),
        fileBoundary(this.session.displayIndexPath),
        fileBoundary(this.session.eventIndexPath),
        fileBoundary(this.session.eventLogPath),
        fileBoundary(this.session.metaPath),
      ]);
      const read = await readReasonixTranscript(this.session);
      await this.captureTestHook?.();
      const confirmedRead = await readReasonixTranscript(this.session);
      const [identityAfter, transcriptAfter, displayAfter, eventAfter, eventLogAfter, metaAfter] = await Promise.all([
        reasonixHistorySourceIdentity(this.session),
        fileBoundary(this.session.transcriptPath),
        fileBoundary(this.session.displayIndexPath),
        fileBoundary(this.session.eventIndexPath),
        fileBoundary(this.session.eventLogPath),
        fileBoundary(this.session.metaPath),
      ]);
      if (
        !sameSourceIdentity(identityBefore, identityAfter)
        || !sameFileBoundary(transcriptBefore, transcriptAfter)
        || read.byteLength !== confirmedRead.byteLength
        || !read.durablePrefixBytes.equals(confirmedRead.durablePrefixBytes)
        || !sameFileBoundary(displayBefore, displayAfter)
        || !sameFileBoundary(eventBefore, eventAfter)
        || !sameOptionalFileBoundary(eventLogBefore, eventLogAfter)
        || !sameOptionalFileBoundary(metaBefore, metaAfter)
        || identityBefore.appendPosition !== read.byteLength
        || read.issues.length > 0
        || !sidecarsCoverRead(read, displayBefore)
      ) {
        if (attempt + 1 < HISTORY_CAPTURE_ATTEMPTS) await sleep(HISTORY_RETRY_MS);
        continue;
      }

      const messages = mapReasonixTranscript(
        this.session.id,
        read.records,
        read.displayEntries,
        this.trace,
      );
      const interrupted = await this.interruptedTail(read);
      if (interrupted) messages.push(interrupted);
      const rewritten = this.primed && this.isHistoryRewrite(read, identityBefore);
      if (rewritten) {
        this.onHistoryRewrite();
        this.emitHistoryReset();
      }
      const usage = reasonixSessionUsageValue(this.session.usage);
      if (usage) messages.push({ type: 'metadata-update', key: 'sessionUsage', value: usage });
      this.onHistorySnapshot(read.records, read.displayEntries, messages, read.byteLength, {
        read,
        identity: identityBefore,
      });
      this.applySnapshotCorrelations(read, identityBefore, messages);
      if (!this.primed || rewritten) this.setTailCursor(read, identityBefore);

      for (let location = 0; location < messages.length; location += 1) {
        const message = messages[location];
        if (!message || !sink.accept(message, sink.acceptsLocations ? location : undefined)) {
          return { refusal: 'resource-limit' };
        }
      }
      this.markCorrelationReplaySynchronized();
      return {
        identity: { ...identityBefore },
        ...(sink.acceptsLocations
          ? { reader: new ReasonixMemoryHistoryReader(identityBefore, messages) }
          : {}),
      };
    }
    this.trace?.({ op: 'observe', detail: 'history capture could not establish one immutable sidecar prefix' });
    return undefined;
  }

  subscribe(handler: AgentMessageHandler): Unsubscribe {
    this.handlers.add(handler);
    this.flushCorrelationReset();
    if (!this.watcher && !this.closed) this.startWatcher();
    return () => this.handlers.delete(handler);
  }

  async sendPrompt(_input: PromptInput): Promise<void> {
    throw new Error('Reasonix Observe is read-only; attach with resume to send a prompt.');
  }

  async respondPermission(_requestId: string, _decision: PermissionDecision): Promise<void> {
    throw new Error('Reasonix Observe cannot answer permissions.');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.pendingDrain) clearTimeout(this.pendingDrain);
    this.pendingDrain = undefined;
    if (this.pendingWatcherRearm) clearTimeout(this.pendingWatcherRearm);
    this.pendingWatcherRearm = undefined;
    if (this.pendingWatcherStable) clearTimeout(this.pendingWatcherStable);
    this.pendingWatcherStable = undefined;
    this.watcher?.close();
    this.watcher = undefined;
    this.unsubscribeCorrelation?.();
    this.unsubscribeCorrelation = undefined;
    this.uncorrelatedRows.clear();
    this.handlers.clear();
  }

  /** Drive observes durable user echoes here; Observe has no extra work. */
  protected onTailRecord(
    _record: import('./mapping.ts').ReasonixTranscriptRecord,
    _lineIndex: number,
    _display: ReasonixDisplayEntry | undefined,
    _messages: readonly AgentMessage[],
    _snapshot?: StableReasonixSnapshot,
  ): void {}

  /** Drive reconciles pending durable echoes before replay appends its remaining queue. */
  protected onHistorySnapshot(
    _records: readonly import('./mapping.ts').ReasonixTranscriptRecord[],
    _displayEntries: readonly ReasonixDisplayEntry[],
    _messages: readonly AgentMessage[],
    _byteLength: number,
    _snapshot?: StableReasonixSnapshot,
  ): void {}

  /** A rewritten transcript starts a new cumulative-telemetry generation. */
  protected onHistoryRewrite(): void {
    this.correlationRegistry?.invalidate(this.session.id);
    this.session.usage = undefined;
    this.usageSignature = JSON.stringify(null);
  }

  /**
   * A Drive created before its first durable row may publish that first
   * snapshot live. `undefined` defers without priming the cursor: the created
   * owner still needs a later complete snapshot from its bounded probe.
   */
  protected async publishInitialSnapshot(_read: ReasonixTranscriptRead): Promise<boolean | undefined> {
    return false;
  }

  /** Drive may request the same serialized drain when a bounded fallback detects a missed fs event. */
  protected refreshFromStore(): Promise<void> {
    return this.drain();
  }

  /** Drive overrides this so an in-flight owned turn is never called interrupted. */
  protected ownsLiveWriter(): boolean {
    return false;
  }

  /** Drive may revoke ownership when a fresh native posture proves another writer. */
  protected onNativePosture(_posture: Awaited<ReturnType<typeof readReasonixAcpPosture>>): boolean {
    return true;
  }

  /** Drive may reject a stale disk mode while its ACP child owns the writer. */
  protected acceptsNativeMode(_mode: ReasonixApprovalMode): boolean {
    return true;
  }

  protected recordCurrentMode(mode: ReasonixApprovalMode, emit = true): void {
    if (mode === this.currentMode || !this.acceptsNativeMode(mode)) return;
    this.setCurrentMode(mode, emit);
  }

  /** ACP session/load and set_config_option acknowledgements outrank disk posture. */
  protected recordAuthoritativeMode(mode: ReasonixApprovalMode, emit = true): void {
    if (mode === this.currentMode) return;
    this.setCurrentMode(mode, emit);
  }

  private setCurrentMode(mode: ReasonixApprovalMode, emit: boolean): void {
    this.currentMode = mode;
    this.session.currentMode = mode;
    this.info.currentMode = mode;
    if (emit) this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { currentMode: mode } });
  }

  protected recordSessionUsage(usage: ReasonixSessionUsage, emit = true): void {
    const current = this.session.usage;
    const merged: ReasonixSessionUsage = { ...(current ?? {}) };
    for (const [key, value] of Object.entries(usage) as Array<
      [keyof ReasonixSessionUsage, ReasonixSessionUsage[keyof ReasonixSessionUsage]]
    >) {
      if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
    }
    // `cumulative` is session-lifetime telemetry. A delayed sidecar snapshot
    // must not move any measured cumulative bucket backwards after a live ACP
    // status frame has already advanced it. Omitted buckets retain their last
    // value; otherwise a partial posture snapshot would erase newer totals.
    for (const key of [
      'promptTokens',
      'completionTokens',
      'reasoningTokens',
      'cacheHitTokens',
      'cacheMissTokens',
      'events',
      'pricedEvents',
    ] as const) {
      const before = current?.[key];
      const after = merged[key];
      if (before !== undefined && after !== undefined && after < before) return;
    }
    const value = reasonixSessionUsageValue(merged);
    if (!value) return;
    const signature = JSON.stringify(value);
    this.session.usage = merged;
    if (signature === this.usageSignature) return;
    this.usageSignature = signature;
    if (emit) this.emit({ type: 'metadata-update', key: 'sessionUsage', value });
  }

  private async interruptedTail(read: ReasonixTranscriptRead): Promise<AgentMessage | undefined> {
    const posture = await readReasonixAcpPosture(this.session);
    if (!posture?.driveEligible || posture.status !== 'idle' || this.ownsLiveWriter()) return undefined;
    this.info.status = posture.status;
    return mapReasonixInterruptedTail(this.session.id, read.records, read.displayEntries);
  }

  private startWatcher(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.pendingWatcherStable) clearTimeout(this.pendingWatcherStable);
    this.pendingWatcherStable = undefined;
    try {
      const transcriptName = basename(this.session.transcriptPath);
      const watchedNames = new Set([
        transcriptName,
        basename(this.session.metaPath),
        basename(this.session.acpMetadataPath),
        basename(this.session.eventIndexPath),
        basename(this.session.eventLogPath),
        basename(this.session.displayIndexPath),
      ]);
      const watcher = this.watchFactory(dirname(this.session.transcriptPath), { persistent: false }, (eventType, filename) => {
        const changedName = filename === null || filename === undefined ? undefined : String(filename);
        if (changedName !== undefined && !watchedNames.has(changedName)) return;
        if (this.pendingDrain || this.closed) return;
        this.pendingDrain = setTimeout(() => {
          this.pendingDrain = undefined;
          void this.drain();
        }, TAIL_DEBOUNCE_MS);
        if (eventType === 'rename' && (changedName === undefined || changedName === transcriptName)) {
          this.scheduleWatcherRearm();
        }
      });
      this.watcher = watcher;
      this.pendingWatcherStable = setTimeout(() => {
        this.pendingWatcherStable = undefined;
        if (!this.closed && this.watcher === watcher) this.watcherRearmAttempts = 0;
      }, this.watchStableMs);
      this.pendingWatcherStable.unref?.();
      watcher.on('error', (error) => {
        this.trace?.({ op: 'observe', detail: `watch failed: ${error.message}` });
        this.scheduleWatcherRearm();
      });
    } catch (error) {
      this.trace?.({ op: 'observe', detail: `watch unavailable: ${error instanceof Error ? error.message : String(error)}` });
      this.scheduleWatcherRearm();
    }
  }

  private scheduleWatcherRearm(): void {
    if (this.closed || this.handlers.size === 0 || this.pendingWatcherRearm) return;
    if (this.watcherRearmAttempts >= WATCH_REARM_ATTEMPTS) {
      this.trace?.({ op: 'observe', detail: 'watch re-arm limit reached after transcript replacement' });
      return;
    }
    this.watcherRearmAttempts += 1;
    this.pendingWatcherRearm = setTimeout(() => {
      this.pendingWatcherRearm = undefined;
      if (!this.closed && this.handlers.size > 0) this.startWatcher();
    }, WATCH_REARM_MS);
  }

  private emit(message: AgentMessage): void {
    for (const handler of this.handlers) {
      try {
        handler(message);
      } catch (error) {
        this.trace?.({ op: 'observe', detail: `subscriber threw: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  }

  private async drain(): Promise<void> {
    if (this.closed) return;
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.drainAgain = false;
        const snapshot = await this.readStableSnapshot();
        if (!snapshot) {
          this.trace?.({ op: 'observe', detail: 'tail drain deferred until Reasonix sidecars converge' });
          // Fail closed and wait for the next transcript/sidecar watcher event. A permanent mismatch
          // must not turn one read-only connection into an unbounded filesystem polling loop.
          continue;
        }
        const { read, identity } = snapshot;
        const rewritten = this.primed && this.isHistoryRewrite(read, identity);
        if (rewritten) {
          // A rewrite starts a new telemetry/correlation generation. Clear the
          // old one before reading posture so the replacement snapshot can
          // publish lower counters without being rejected as stale.
          this.onHistoryRewrite();
          this.emitHistoryReset();
          this.setTailCursor(read, identity);
          this.scheduleWatcherRearm();
        }
        const posture = await readReasonixAcpPosture(this.session);
        if (posture?.currentMode) this.recordCurrentMode(posture.currentMode);
        if (posture?.usage) this.recordSessionUsage(posture.usage);
        if (posture && posture.status !== this.info.status && this.onNativePosture(posture)) {
          this.info.status = posture.status;
          if (posture.status === 'needs-input') {
            this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { status: 'needs-input' } });
          } else {
            this.emit({ type: 'status', status: posture.status === 'idle' ? 'idle' : 'running' });
          }
        }
        if (!this.primed) {
          const publishInitial = await this.publishInitialSnapshot(read);
          if (publishInitial === undefined) continue;
          if (publishInitial) {
            const displayByIndex = new Map(read.displayEntries.map((entry) => [entry.index, entry]));
            for (let lineIndex = 0; lineIndex < read.records.length; lineIndex += 1) {
              const record = read.records[lineIndex];
              if (!record) continue;
              const display = displayByIndex.get(lineIndex);
              const messages = mapReasonixRecord(record, {
                sessionId: this.session.id,
                lineIndex,
                display,
                trace: this.trace,
              });
              this.onTailRecord(record, lineIndex, display, messages, snapshot);
              this.applyRecordCorrelation(read, identity, record, lineIndex, display, messages);
              for (const message of messages) this.emit(message);
            }
            for (const issue of read.issues) this.emit({ type: 'notice', message: `Reasonix history: ${issue}.` });
          }
          this.setTailCursor(read, identity);
          continue;
        }

        if (rewritten) continue;

        const displayByIndex = new Map(read.displayEntries.map((entry) => [entry.index, entry]));
        for (let lineIndex = this.recordCount; lineIndex < read.records.length; lineIndex += 1) {
          const record = read.records[lineIndex];
          if (!record) continue;
          const display = displayByIndex.get(lineIndex);
          const messages = mapReasonixRecord(record, {
            sessionId: this.session.id,
            lineIndex,
            display,
            trace: this.trace,
          });
          this.onTailRecord(record, lineIndex, display, messages, snapshot);
          this.applyRecordCorrelation(read, identity, record, lineIndex, display, messages);
          for (const message of messages) this.emit(message);
        }
        for (const issue of read.issues) this.emit({ type: 'notice', message: `Reasonix history: ${issue}.` });
        this.setTailCursor(read, identity);
      } while (this.drainAgain && !this.closed);
    } catch (error) {
      this.trace?.({ op: 'observe', detail: `tail drain failed: ${error instanceof Error ? error.message : String(error)}` });
      this.emit({ type: 'notice', message: 'Reasonix history could not be refreshed.' });
    } finally {
      this.draining = false;
    }
  }

  private applySnapshotCorrelations(
    read: ReasonixTranscriptRead,
    identity: HistorySourceIdentity,
    messages: readonly AgentMessage[],
  ): void {
    if (!this.correlationRegistry) return;
    const displayByIndex = new Map(read.displayEntries.map((entry) => [entry.index, entry]));
    for (let lineIndex = 0; lineIndex < read.records.length; lineIndex += 1) {
      const record = read.records[lineIndex];
      if (!record) continue;
      this.applyRecordCorrelation(
        read, identity, record, lineIndex, displayByIndex.get(lineIndex), messages,
      );
    }
  }

  private applyRecordCorrelation(
    read: ReasonixTranscriptRead,
    identity: HistorySourceIdentity,
    record: ReasonixTranscriptRecord,
    lineIndex: number,
    display: ReasonixDisplayEntry | undefined,
    messages: readonly AgentMessage[],
  ): void {
    if (!this.correlationRegistry || record.role !== 'user' || !display) return;
    if (this.correlationRegistry.applyRecord(
      this.session.id, read, identity, record, lineIndex, display, messages,
    )) return;
    const text = typeof record.raw_content === 'string' ? record.raw_content
      : typeof record.content === 'string' ? record.content
        : undefined;
    if (text === undefined) return;
    const nativeKey = reasonixMessageKey(this.session.id, display.index);
    if (!messages.some((message) => message.type === 'user-message' && message.key === nativeKey)) return;
    const rowIdentity = this.correlationRegistry.rowIdentity(read, identity, display, text);
    if (rowIdentity) {
      this.uncorrelatedRows.delete(rowIdentity);
      this.uncorrelatedRows.add(rowIdentity);
      while (this.uncorrelatedRows.size > REASONIX_CORRELATION_MAX_ENTRIES_PER_SESSION) {
        const oldest = this.uncorrelatedRows.values().next().value;
        if (oldest === undefined) break;
        this.uncorrelatedRows.delete(oldest);
      }
    }
  }

  private markCorrelationReplaySynchronized(): void {
    if (!this.correlationResetPending) return;
    this.correlationResetPending = false;
  }

  private flushCorrelationReset(): void {
    if (!this.correlationResetPending || this.closed || this.handlers.size === 0) return;
    this.correlationResetPending = false;
    this.uncorrelatedRows.clear();
    this.emitHistoryReset();
  }

  private isHistoryRewrite(
    read: ReasonixTranscriptRead,
    identity: HistorySourceIdentity | undefined,
  ): boolean {
    return read.records.length < this.recordCount
      || (this.sourceId !== undefined && identity?.sourceId !== this.sourceId)
      || (identity?.appendPosition ?? read.byteLength) < this.appendPosition
      || !sameDurablePrefix(read.durablePrefixBytes, this.durablePrefixValue)
      || displayPrefix(read.displayEntries, this.recordCount) !== this.displayPrefixValue
      || (read.records.length === this.recordCount
        && this.revision !== undefined
        && identity?.revision !== this.revision);
  }

  private setTailCursor(
    read: ReasonixTranscriptRead,
    identity: HistorySourceIdentity | undefined,
  ): void {
    this.recordCount = read.records.length;
    this.durablePrefixValue = read.durablePrefixBytes;
    this.displayPrefixValue = displayPrefix(read.displayEntries, this.recordCount);
    this.sourceId = identity?.sourceId;
    this.appendPosition = identity?.appendPosition ?? read.byteLength;
    this.revision = identity?.revision;
    this.primed = true;
  }

  protected emitHistoryReset(): void {
    this.emit({
      type: 'history-reset',
      notice: 'The Reasonix transcript changed outside this connection; reloading it.',
      semantic: { kind: 'rollback' },
    });
  }

  private async readStableSnapshot(): Promise<StableReasonixSnapshot | undefined> {
    for (let attempt = 0; attempt < HISTORY_CAPTURE_ATTEMPTS; attempt += 1) {
      const [identityBefore, transcriptBefore, displayBefore, eventBefore, eventLogBefore, metaBefore] = await Promise.all([
        reasonixHistorySourceIdentity(this.session),
        fileBoundary(this.session.transcriptPath),
        fileBoundary(this.session.displayIndexPath),
        fileBoundary(this.session.eventIndexPath),
        fileBoundary(this.session.eventLogPath),
        fileBoundary(this.session.metaPath),
      ]);
      const read = await readReasonixTranscript(this.session);
      await this.snapshotTestHook?.(attempt);
      const confirmedRead = await readReasonixTranscript(this.session);
      const [identityAfter, transcriptAfter, displayAfter, eventAfter, eventLogAfter, metaAfter] = await Promise.all([
        reasonixHistorySourceIdentity(this.session),
        fileBoundary(this.session.transcriptPath),
        fileBoundary(this.session.displayIndexPath),
        fileBoundary(this.session.eventIndexPath),
        fileBoundary(this.session.eventLogPath),
        fileBoundary(this.session.metaPath),
      ]);
      if (
        identityBefore !== undefined
        && sameSourceIdentity(identityBefore, identityAfter)
        && sameFileBoundary(transcriptBefore, transcriptAfter)
        && read.byteLength === confirmedRead.byteLength
        && read.durablePrefixBytes.equals(confirmedRead.durablePrefixBytes)
        && sameOptionalFileBoundary(displayBefore, displayAfter)
        && sameOptionalFileBoundary(eventBefore, eventAfter)
        && sameOptionalFileBoundary(eventLogBefore, eventLogAfter)
        && sameOptionalFileBoundary(metaBefore, metaAfter)
        && identityBefore.appendPosition === read.byteLength
        && sidecarsCoverRead(read, displayBefore)
      ) return { read, identity: identityBefore };
      if (attempt + 1 < HISTORY_CAPTURE_ATTEMPTS) await sleep(HISTORY_RETRY_MS);
    }
    return undefined;
  }
}
