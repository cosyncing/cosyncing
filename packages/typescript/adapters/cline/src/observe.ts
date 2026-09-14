/** Read-only replay and snapshot-reparse tail for one Cline messages document. */
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import type {
  AgentMessage,
  AgentMessageHandler,
  HistoryQuery,
  HistorySnapshotCapture,
  HistorySnapshotPageRead,
  HistorySnapshotPageReader,
  HistorySnapshotRefusal,
  HistorySnapshotSink,
  HistorySourceIdentity,
  PermissionDecision,
  PromptInput,
  SessionConnection,
  SessionInfo,
  Unsubscribe,
} from '@cosyncing/adapter-api';
import { TerminalSummaryRegistry } from '@cosyncing/adapter-api';
import {
  clinePendingToolUse,
  clineSessionUsage,
  mapClineInterruptedTail,
  clineMessageSettled,
  mapClineMessage,
  type ClineTerminalSummary,
  type ClineMapTrace,
} from './mapping.ts';
import {
  clineHistorySourceIdentity,
  clineNativeMessageDigest,
  clinePromptCorrelationHistoryIdentity,
  clineTerminalSummaryHistoryIdentity,
  readClineMessages,
  refreshClineSessionMetadata,
  type ClineMessagesSnapshot,
  type ClinePromptCorrelation,
  type ClinePromptCorrelations,
  type ClineStoredSession,
} from './store.ts';

const REPARSE_DEBOUNCE_MS = 80;
const SNAPSHOT_ATTEMPTS = 4;
const SNAPSHOT_RETRY_MS = 20;
const WATCH_REARM_MS = 100;
const WATCH_REARM_ATTEMPTS = 8;
const WATCH_STABLE_MS = 1_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface ClineObserveOptions {
  session: ClineStoredSession;
  info: SessionInfo;
  trace?: (event: ClineMapTrace | { op: 'observe'; detail: string }) => void;
  watchFactory?: typeof watch;
  watchStableMs?: number;
  processAlive?: (pid: number) => boolean;
  snapshotTestHook?: (attempt: number) => void | Promise<void>;
  promptCorrelations?: ClinePromptCorrelations;
  onPromptCorrelationInvalid?: (detail: string) => void;
  terminalSummaries?: readonly ClineTerminalSummary[];
  terminalSummaryRegistry?: TerminalSummaryRegistry<ClineTerminalSummary>;
  expectedTerminalSummaryBoundary?: HistorySourceIdentity;
  onTerminalSummaryBoundaryInvalid?: () => void;
  notifyTerminalSummaryChanges?: boolean;
}

function sameSnapshot(left: ClineMessagesSnapshot, right: ClineMessagesSnapshot): boolean {
  return left.issues.length === 0
    && right.issues.length === 0
    && left.identity?.sourceId === right.identity?.sourceId
    && left.identity?.revision === right.identity?.revision
    && left.messageEncodings.length === right.messageEncodings.length
    && left.messageEncodings.every((value, index) => value === right.messageEncodings[index]);
}

function prefixMatches(
  previousIds: readonly string[],
  previousEncodings: readonly string[],
  current: ClineMessagesSnapshot,
): boolean {
  if (current.messageIds.length < previousIds.length) return false;
  for (let index = 0; index < previousIds.length; index += 1) {
    if (current.messageIds[index] !== previousIds[index]
      || current.messageEncodings[index] !== previousEncodings[index]) return false;
  }
  return true;
}

class ClineMemoryHistoryReader implements HistorySnapshotPageReader {
  readonly retainedBytes: number;

  constructor(
    private readonly identity: HistorySourceIdentity,
    private readonly messageEncodings: readonly string[],
  ) {
    this.retainedBytes = messageEncodings.reduce(
      (total, encoding) => total + Buffer.byteLength(encoding, 'utf8') + 16,
      0,
    );
  }

  read(locations: readonly number[]): HistorySnapshotPageRead | HistorySnapshotRefusal | undefined {
    const messages: AgentMessage[] = [];
    let bytesRead = 0;
    for (const location of locations) {
      if (!Number.isSafeInteger(location) || location < 0) return undefined;
      const encoding = this.messageEncodings[location];
      if (!encoding) return undefined;
      try {
        messages.push(JSON.parse(encoding) as AgentMessage);
      } catch {
        return undefined;
      }
      bytesRead += Buffer.byteLength(encoding, 'utf8');
    }
    return {
      identity: { ...this.identity },
      messages,
      work: { recordsRead: messages.length, bytesRead },
    };
  }
}

export class ClineObserveConnection implements SessionConnection {
  readonly info: SessionInfo;
  private readonly session: ClineStoredSession;
  private readonly trace?: ClineObserveOptions['trace'];
  private readonly watchFactory: typeof watch;
  private readonly watchStableMs: number;
  private readonly snapshotTestHook?: ClineObserveOptions['snapshotTestHook'];
  private readonly processAlive?: (pid: number) => boolean;
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
  private pagingInvalidated = false;
  private messageIds: string[] = [];
  private messageEncodings: string[] = [];
  private historyIdentity?: HistorySourceIdentity;
  private readonly promptCorrelations?: ClinePromptCorrelations;
  private readonly promptCorrelationUnsubscribe?: Unsubscribe;
  private readonly onPromptCorrelationInvalid?: ClineObserveOptions['onPromptCorrelationInvalid'];
  private readonly terminalSummaryRegistry: TerminalSummaryRegistry<ClineTerminalSummary>;
  private readonly terminalSummaryUnsubscribe?: Unsubscribe;
  private readonly onTerminalSummaryBoundaryInvalid?: () => void;
  private readonly emittedUncorrelatedUserIds = new Set<string>();
  private suppressPromptCorrelationReset = false;

  constructor(options: ClineObserveOptions) {
    this.session = options.session;
    this.info = options.info;
    if (options.trace) this.trace = options.trace;
    if (options.snapshotTestHook) this.snapshotTestHook = options.snapshotTestHook;
    this.watchFactory = options.watchFactory ?? watch;
    this.watchStableMs = options.watchStableMs ?? WATCH_STABLE_MS;
    if (options.processAlive) this.processAlive = options.processAlive;
    this.promptCorrelations = options.promptCorrelations;
    this.onPromptCorrelationInvalid = options.onPromptCorrelationInvalid;
    this.terminalSummaryRegistry = options.terminalSummaryRegistry
      ?? new TerminalSummaryRegistry<ClineTerminalSummary>();
    if (options.expectedTerminalSummaryBoundary) {
      this.terminalSummaryRegistry.hydrate(
        options.expectedTerminalSummaryBoundary,
        options.terminalSummaries ?? [],
      );
    }
    this.onTerminalSummaryBoundaryInvalid = options.onTerminalSummaryBoundaryInvalid;
    if (options.notifyTerminalSummaryChanges !== false) {
      this.terminalSummaryUnsubscribe = this.terminalSummaryRegistry.subscribe(() => {
        if (this.closed) return;
        this.emit({
          type: 'history-reset',
          notice: 'A durable Cline terminal summary changed; reloading the stable transcript.',
        });
      });
    }
    this.promptCorrelationUnsubscribe = this.promptCorrelations?.subscribe?.((nativeMessageId) => {
      if (this.closed || this.suppressPromptCorrelationReset) return;
      if (nativeMessageId !== undefined
        && !this.emittedUncorrelatedUserIds.delete(nativeMessageId)) return;
      this.emittedUncorrelatedUserIds.clear();
      this.primed = false;
      this.messageIds = [];
      this.messageEncodings = [];
      this.historyIdentity = undefined;
      this.emit({
        type: 'history-reset',
        notice: 'A durable Cline prompt correlation arrived; reloading the stable transcript keys.',
      });
    });
  }

  async getHistory(_query?: HistoryQuery): Promise<AgentMessage[]> {
    await this.refreshMetadata();
    const snapshot = await this.readStableSnapshot();
    if (!snapshot) throw new Error('Cline messages snapshot did not converge on one immutable revision.');
    const appendLineageProved = this.primed
      && prefixMatches(this.messageIds, this.messageEncodings, snapshot);
    if (this.primed && !appendLineageProved) {
      this.invalidatePagingAndReset();
    }
    const summaries = this.readTerminalSummaries(snapshot, appendLineageProved);
    const messages = this.messagesFor(snapshot, summaries);
    this.setCursor(snapshot);
    return messages;
  }

  async getHistorySourceIdentity(): Promise<HistorySourceIdentity | undefined> {
    if (this.pagingInvalidated) return undefined;
    const identity = await clineHistorySourceIdentity(this.session);
    return identity
      ? clinePromptCorrelationHistoryIdentity(identity, this.promptCorrelations)
      : undefined;
  }

  /** Identity of the exact immutable snapshot returned by the last history read. */
  lastHistorySourceIdentity(): HistorySourceIdentity | undefined {
    return this.historyIdentity ? { ...this.historyIdentity } : undefined;
  }

  async captureHistorySnapshot(
    sink: HistorySnapshotSink,
    _query?: HistoryQuery,
  ): Promise<HistorySnapshotCapture | HistorySnapshotRefusal | undefined> {
    if (this.pagingInvalidated) return undefined;
    await this.refreshMetadata();
    const snapshot = await this.readStableSnapshot();
    if (!snapshot?.identity) return undefined;
    const appendLineageProved = this.primed
      && prefixMatches(this.messageIds, this.messageEncodings, snapshot);
    if (this.primed && !appendLineageProved) {
      this.invalidatePagingAndReset();
      this.setCursor(snapshot);
      return undefined;
    }
    const encodings: string[] = [];
    let location = 0;
    const summaries = this.readTerminalSummaries(snapshot, appendLineageProved);
    const accepted = this.forEachSnapshotMessage(snapshot, summaries, (message) => {
      if (!sink.accept(message, sink.acceptsLocations ? location : undefined)) return false;
      if (sink.acceptsLocations) encodings.push(JSON.stringify(message));
      location += 1;
      return true;
    });
    if (!accepted) return { refusal: 'resource-limit' };
    this.setCursor(snapshot);
    const identity = clinePromptCorrelationHistoryIdentity(snapshot.identity, this.promptCorrelations);
    return {
      identity,
      ...(sink.acceptsLocations ? { reader: new ClineMemoryHistoryReader(identity, encodings) } : {}),
    };
  }

  subscribe(handler: AgentMessageHandler): Unsubscribe {
    this.handlers.add(handler);
    if (!this.watcher && !this.closed) this.startWatcher();
    return () => this.handlers.delete(handler);
  }

  /**
   * THROWS when the snapshot will not settle, the same way `getHistory` sixty
   * lines above does.
   *
   * `readStableSnapshot` answers `undefined` only on FAILURE — four attempts
   * 20ms apart without the file settling — which is the signature of a
   * transcript being written, i.e. mid-turn, i.e. exactly when a tool is
   * waiting for approval. The broker distinguishes the two answers: a throw is
   * "unknown, keep what you have" (`hub.ts` `catch { return; }`), while an
   * empty array is authoritative and clears `pendingInput`. Returning `[]` here
   * therefore dismissed a live approval card, and `refreshPendingQueuedUsers`
   * runs on attach, on transport swap and on every `history-reset` — so the
   * card could vanish with nothing left to answer, which is the harm the
   * comment at that call site already describes for the sibling case.
   */
  async getPending(): Promise<AgentMessage[]> {
    await this.refreshMetadata();
    const snapshot = await this.readStableSnapshot();
    if (!snapshot) {
      throw new Error('Cline messages snapshot did not converge; the pending set is unknown, not empty.');
    }
    const pending = clinePendingToolUse(snapshot.messages);
    return pending ? [pending] : [];
  }

  async sendPrompt(_input: PromptInput): Promise<void> {
    throw new Error('Cline Observe is read-only; attach an eligible broker-created root session in Resume mode to send prompts.');
  }

  async respondPermission(_requestId: string, _decision: PermissionDecision): Promise<void> {
    throw new Error('Cline Observe cannot answer native approvals.');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.pendingDrain) clearTimeout(this.pendingDrain);
    if (this.pendingWatcherRearm) clearTimeout(this.pendingWatcherRearm);
    if (this.pendingWatcherStable) clearTimeout(this.pendingWatcherStable);
    this.pendingDrain = undefined;
    this.pendingWatcherRearm = undefined;
    this.pendingWatcherStable = undefined;
    this.watcher?.close();
    this.watcher = undefined;
    this.promptCorrelationUnsubscribe?.();
    this.terminalSummaryUnsubscribe?.();
    this.emittedUncorrelatedUserIds.clear();
    this.handlers.clear();
  }

  private messagesFor(
    snapshot: ClineMessagesSnapshot,
    terminalSummaries: readonly ClineTerminalSummary[],
  ): AgentMessage[] {
    const messages: AgentMessage[] = [];
    this.forEachSnapshotMessage(snapshot, terminalSummaries, (message) => {
      messages.push(message);
      return true;
    });
    return messages;
  }

  private forEachSnapshotMessage(
    snapshot: ClineMessagesSnapshot,
    terminalSummaries: readonly ClineTerminalSummary[],
    accept: (message: AgentMessage) => boolean,
  ): boolean {
    const nativeTerminalTurnIds = new Set<string>();
    for (let nativeIndex = 0; nativeIndex < snapshot.messages.length; nativeIndex += 1) {
      const native = snapshot.messages[nativeIndex];
      if (!native) continue;
      const mappedMessages = mapClineMessage(native, {
        sessionId: this.session.id,
        trace: this.trace,
        settled: clineMessageSettled(native, nativeIndex < snapshot.messages.length - 1),
      });
      const correlation = this.promptCorrelations?.get(native.id);
      let correlationApplied = false;
      if (correlation) {
        const userRows = mappedMessages.filter((message) => message.type === 'user-message');
        if (native.role === 'user' && userRows.length === 1
          && clineNativeMessageDigest(native) === correlation.nativeMessageDigest) {
          userRows[0]!.key = correlation.key;
          if (correlation.clientKey) userRows[0]!.clientKey = correlation.clientKey;
          userRows[0]!.queued = false;
          correlationApplied = true;
        } else {
          this.invalidatePromptCorrelations(
            'The exact native Cline prompt row changed after its durable app correlation was recorded.',
          );
        }
      }
      for (const mapped of mappedMessages) {
        if (mapped.type === 'run-summary') nativeTerminalTurnIds.add(mapped.turnId);
        if (!accept(mapped)) return false;
        if (!correlationApplied && native.role === 'user' && mapped.type === 'user-message') {
          this.emittedUncorrelatedUserIds.add(native.id);
        }
      }
    }
    const interrupted = mapClineInterruptedTail(this.session, snapshot.messages);
    const terminalTurnIds = new Set(terminalSummaries.map((summary) => summary.turnId));
    if (interrupted?.type === 'run-summary'
      && !terminalTurnIds.has(interrupted.turnId)
      && !accept(interrupted)) return false;
    for (const summary of terminalSummaries) {
      if (nativeTerminalTurnIds.has(summary.turnId)) continue;
      if (!accept({ ...summary })) return false;
    }
    const usage = clineSessionUsage(this.session.usage);
    return !usage || accept(usage);
  }

  private async refreshMetadata(): Promise<{ interruptedBecameTrue: boolean }> {
    const previousStatus = this.info.status;
    const previousMode = this.info.currentMode;
    const previousModel = this.info.currentModel;
    const previousInterrupted = this.session.interrupted;
    const refreshed = await refreshClineSessionMetadata(
      this.session,
      this.processAlive,
    );
    if (!refreshed) {
      this.trace?.({ op: 'observe', detail: 'Cline metadata refresh failed identity/schema validation' });
      return { interruptedBecameTrue: false };
    }
    const status = this.session.status === 'running' ? 'working' : 'idle';
    this.info.status = status;
    if (this.session.updatedAt !== undefined) this.info.updatedAt = this.session.updatedAt;
    if (this.session.model) this.info.model = this.session.model;
    else delete this.info.model;
    if (this.session.currentModel) {
      const native = this.session.currentModel;
      const label = previousModel?.providerID === native.providerID
        && previousModel.modelID === native.modelID
        ? previousModel.label
        : undefined;
      this.info.currentModel = { ...native, ...(label ? { label } : {}) };
    }
    else delete this.info.currentModel;
    if (this.session.currentMode) this.info.currentMode = this.session.currentMode;
    else delete this.info.currentMode;
    const modelChanged = JSON.stringify(previousModel) !== JSON.stringify(this.info.currentModel);
    const modeChanged = previousMode !== this.info.currentMode;
    if (modelChanged || modeChanged) {
      this.emit({
        type: 'metadata-update',
        key: 'sessionInfo',
        value: {
          ...(modelChanged ? { currentModel: this.info.currentModel, model: this.info.model } : {}),
          ...(modeChanged ? { currentMode: this.info.currentMode } : {}),
        },
      });
    }
    if (status !== previousStatus) this.emit({ type: 'status', status: status === 'working' ? 'running' : 'idle' });
    return { interruptedBecameTrue: !previousInterrupted && this.session.interrupted };
  }

  private async readStableSnapshot(): Promise<ClineMessagesSnapshot | undefined> {
    for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
      const before = await readClineMessages(this.session);
      await this.snapshotTestHook?.(attempt);
      const after = await readClineMessages(this.session);
      if (sameSnapshot(before, after)) return before;
      if (attempt + 1 < SNAPSHOT_ATTEMPTS) await sleep(SNAPSHOT_RETRY_MS);
    }
    this.trace?.({ op: 'observe', detail: 'messages snapshot did not stabilize within the bounded retry window' });
    return undefined;
  }

  private setCursor(snapshot: ClineMessagesSnapshot): void {
    this.primed = true;
    this.messageIds = [...snapshot.messageIds];
    this.messageEncodings = [...snapshot.messageEncodings];
    this.historyIdentity = snapshot.identity ? { ...snapshot.identity } : undefined;
  }

  private invalidatePagingAndReset(): void {
    this.pagingInvalidated = true;
    this.terminalSummaryRegistry.clear();
    this.invalidatePromptCorrelations(
      'The Cline transcript was compacted or rewritten after its durable ownership boundary.',
    );
    this.historyIdentity = undefined;
    this.emit({
      type: 'history-reset',
      notice: 'The Cline transcript was compacted or rewritten; reloading the current snapshot.',
      semantic: { kind: 'rollback' },
    });
  }

  private readTerminalSummaries(
    snapshot: ClineMessagesSnapshot,
    appendLineageProved: boolean,
  ): ClineTerminalSummary[] {
    if (!snapshot.identity) return [];
    const result = this.terminalSummaryRegistry.read(
      clineTerminalSummaryHistoryIdentity(this.session.id, snapshot.messages),
      appendLineageProved,
    );
    if (!result.valid) this.onTerminalSummaryBoundaryInvalid?.();
    return result.rows;
  }

  private invalidatePromptCorrelations(detail: string): void {
    if (!this.promptCorrelations) return;
    this.suppressPromptCorrelationReset = true;
    try {
      this.promptCorrelations.clear();
    } finally {
      this.suppressPromptCorrelationReset = false;
    }
    this.emittedUncorrelatedUserIds.clear();
    this.trace?.({ op: 'observe', detail });
    this.onPromptCorrelationInvalid?.(detail);
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

  private startWatcher(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.pendingWatcherStable) clearTimeout(this.pendingWatcherStable);
    this.pendingWatcherStable = undefined;
    try {
      const names = new Set([
        basename(this.session.messagesPath),
        ...(this.session.metadataPath ? [basename(this.session.metadataPath)] : []),
      ]);
      const messagesName = basename(this.session.messagesPath);
      const watcher = this.watchFactory(dirname(this.session.messagesPath), { persistent: false }, (eventType, filename) => {
        const changed = filename === null || filename === undefined ? undefined : String(filename);
        if (changed !== undefined && !names.has(changed)) return;
        if (!this.pendingDrain && !this.closed) {
          this.pendingDrain = setTimeout(() => {
            this.pendingDrain = undefined;
            void this.drain();
          }, REPARSE_DEBOUNCE_MS);
          this.pendingDrain.unref?.();
        }
        if (eventType === 'rename' && (changed === undefined || changed === messagesName)) this.scheduleWatcherRearm();
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
      this.trace?.({ op: 'observe', detail: 'watch re-arm limit reached after Cline snapshot replacement' });
      return;
    }
    this.watcherRearmAttempts += 1;
    this.pendingWatcherRearm = setTimeout(() => {
      this.pendingWatcherRearm = undefined;
      if (!this.closed && this.handlers.size > 0) this.startWatcher();
    }, WATCH_REARM_MS);
    this.pendingWatcherRearm.unref?.();
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
        const metadataChange = await this.refreshMetadata();
        const snapshot = await this.readStableSnapshot();
        if (!snapshot) continue;
        if (!this.primed) {
          this.setCursor(snapshot);
          continue;
        }
        if (!prefixMatches(this.messageIds, this.messageEncodings, snapshot)) {
          this.invalidatePagingAndReset();
          this.setCursor(snapshot);
          this.scheduleWatcherRearm();
          continue;
        }
        for (let index = this.messageIds.length; index < snapshot.messages.length; index += 1) {
          const message = snapshot.messages[index];
          if (!message) continue;
          const mappedMessages = mapClineMessage(message, {
            sessionId: this.session.id,
            trace: this.trace,
            settled: clineMessageSettled(message, index < snapshot.messages.length - 1),
          });
          const correlation = this.promptCorrelations?.get(message.id);
          let correlationApplied = false;
          if (correlation && message.role === 'user') {
            const users = mappedMessages.filter((mapped) => mapped.type === 'user-message');
            if (users.length === 1 && clineNativeMessageDigest(message) === correlation.nativeMessageDigest) {
              users[0]!.key = correlation.key;
              if (correlation.clientKey) users[0]!.clientKey = correlation.clientKey;
              users[0]!.queued = false;
              correlationApplied = true;
            } else {
              this.invalidatePromptCorrelations(
                'The exact native Cline prompt row changed while tailing its durable correlation.',
              );
            }
          }
          for (const mapped of mappedMessages) {
            this.emit(mapped);
            if (!correlationApplied && message.role === 'user' && mapped.type === 'user-message') {
              this.emittedUncorrelatedUserIds.add(message.id);
            }
          }
        }
        if (metadataChange.interruptedBecameTrue) {
          const interrupted = mapClineInterruptedTail(this.session, snapshot.messages);
          if (interrupted) this.emit(interrupted);
        }
        const usage = clineSessionUsage(this.session.usage);
        if (usage) this.emit(usage);
        this.setCursor(snapshot);
      } while (this.drainAgain && !this.closed);
    } finally {
      this.draining = false;
    }
  }
}
