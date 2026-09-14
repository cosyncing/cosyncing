/** Read-only replay and append tail for one Grok updates.jsonl transcript. */
import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
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
  grokContextUsage,
  grokMessageKey,
  grokPromptId,
  grokTurnId,
  isGrokSessionUpdateMethod,
  mapGrokInterruptedTail,
  mapGrokTranscript,
  mapGrokUpdate,
  turnPromptIds,
  type GrokMapTrace,
  type GrokUpdateEntry,
} from './mapping.ts';
import {
  grokHistorySourceIdentity,
  readGrokSignals,
  readGrokUpdates,
  type GrokStoredSession,
  type GrokUpdatesRead,
} from './store.ts';

const TAIL_DEBOUNCE_MS = 80;
const HISTORY_CAPTURE_ATTEMPTS = 4;
const HISTORY_RETRY_MS = 20;
const WATCH_REARM_MS = 100;
const WATCH_REARM_ATTEMPTS = 8;
const WATCH_STABLE_MS = 1_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function grokUserText(record: GrokUpdateEntry['record']): string | undefined {
  if (!isGrokSessionUpdateMethod(record.method) || !isRecord(record.params)
    || !isRecord(record.params.update)) return undefined;
  const update = record.params.update;
  if (update.sessionUpdate !== 'user_message_chunk') return undefined;
  if (typeof update.content === 'string') return update.content;
  return isRecord(update.content) && typeof update.content.text === 'string'
    ? update.content.text
    : undefined;
}
export type GrokTerminalSummary = Extract<AgentMessage, { type: 'run-summary' }> & {
  status: 'done' | 'error' | 'cancelled';
};

interface FileBoundary {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface StableGrokSnapshot {
  read: GrokUpdatesRead;
  identity: HistorySourceIdentity;
}

export interface GrokObserveOptions {
  session: GrokStoredSession;
  info: SessionInfo;
  trace?: (event: GrokMapTrace | { op: 'observe'; detail: string }) => void;
  captureTestHook?: () => void | Promise<void>;
  snapshotTestHook?: (attempt: number) => void | Promise<void>;
  watchFactory?: typeof watch;
  watchStableMs?: number;
  replayCorrelations?: GrokReplayCorrelations;
  terminalSummaries?: readonly GrokTerminalSummary[];
  terminalSummaryRegistry?: TerminalSummaryRegistry<GrokTerminalSummary>;
  expectedTerminalSummaryBoundary?: HistorySourceIdentity;
  onTerminalSummaryBoundaryInvalid?: () => void;
  notifyTerminalSummaryChanges?: boolean;
}

export interface GrokReplayCorrelation {
  key: string;
  text: string;
  clientKey?: string;
}

type GrokReplayCorrelationHandler = (nativeKey: string, correlation: GrokReplayCorrelation) => void;

export type GrokReplayCorrelations = Map<string, GrokReplayCorrelation> & {
  subscribe?: (handler: GrokReplayCorrelationHandler) => Unsubscribe;
};

/** Per-session correlation registry shared by Drive and every live Observe connection. */
export class GrokReplayCorrelationRegistry extends Map<string, GrokReplayCorrelation> {
  private readonly handlers = new Set<GrokReplayCorrelationHandler>();

  override set(nativeKey: string, correlation: GrokReplayCorrelation): this {
    const previous = this.get(nativeKey);
    super.set(nativeKey, correlation);
    if (previous?.key !== correlation.key
      || previous.text !== correlation.text
      || previous.clientKey !== correlation.clientKey) {
      for (const handler of this.handlers) handler(nativeKey, correlation);
    }
    return this;
  }

  subscribe(handler: GrokReplayCorrelationHandler): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
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

function sameBoundary(left: FileBoundary | undefined, right: FileBoundary | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left !== undefined
    && right !== undefined
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameIdentity(
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

function prefixUnchanged(current: Buffer, accepted: Buffer): boolean {
  return current.length >= accepted.length
    && current.subarray(0, accepted.length).equals(accepted);
}

class GrokMemoryHistoryReader implements HistorySnapshotPageReader {
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

export class GrokObserveConnection implements SessionConnection {
  readonly info: SessionInfo;
  protected readonly session: GrokStoredSession;
  protected readonly trace?: GrokObserveOptions['trace'];
  private readonly captureTestHook?: GrokObserveOptions['captureTestHook'];
  private readonly snapshotTestHook?: GrokObserveOptions['snapshotTestHook'];
  private readonly watchFactory: typeof watch;
  private readonly watchStableMs: number;
  private readonly replayCorrelations?: GrokReplayCorrelations;
  protected readonly terminalSummaryRegistry: TerminalSummaryRegistry<GrokTerminalSummary>;
  private readonly terminalSummaryUnsubscribe?: Unsubscribe;
  private readonly onTerminalSummaryBoundaryInvalid?: () => void;
  private readonly replayCorrelationUnsubscribe?: Unsubscribe;
  private readonly emittedUncorrelatedUserKeys = new Set<string>();
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
  private entryCount = 0;
  private tailTurnUserKey: string | undefined;
  private readonly tailPromptUserKeys = new Map<string, string>();
  private durablePrefix: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private sourceId?: string;
  private appendPosition = 0;

  constructor(options: GrokObserveOptions) {
    this.session = options.session;
    this.info = options.info;
    if (options.trace) this.trace = options.trace;
    if (options.captureTestHook) this.captureTestHook = options.captureTestHook;
    if (options.snapshotTestHook) this.snapshotTestHook = options.snapshotTestHook;
    this.watchFactory = options.watchFactory ?? watch;
    this.watchStableMs = options.watchStableMs ?? WATCH_STABLE_MS;
    this.replayCorrelations = options.replayCorrelations;
    this.terminalSummaryRegistry = options.terminalSummaryRegistry
      ?? new TerminalSummaryRegistry<GrokTerminalSummary>();
    if (options.expectedTerminalSummaryBoundary) {
      this.terminalSummaryRegistry.hydrate(
        options.expectedTerminalSummaryBoundary,
        options.terminalSummaries ?? [],
      );
    }
    this.onTerminalSummaryBoundaryInvalid = options.onTerminalSummaryBoundaryInvalid;
    if (options.notifyTerminalSummaryChanges !== false) {
      this.terminalSummaryUnsubscribe = this.terminalSummaryRegistry.subscribe(() => {
        if (!this.closed) this.emitHistoryReset();
      });
    }
    this.replayCorrelationUnsubscribe = this.replayCorrelations?.subscribe?.((nativeKey) => {
      if (!this.emittedUncorrelatedUserKeys.delete(nativeKey) || this.closed) return;
      this.emitHistoryReset();
    });
  }

  async getHistory(_query?: HistoryQuery): Promise<AgentMessage[]> {
    const snapshot = await this.readStableSnapshot();
    if (!snapshot) throw new Error('Grok updates log did not converge on one immutable prefix.');
    const rewritten = this.primed && this.isHistoryRewrite(snapshot.read, snapshot.identity);
    if (rewritten) {
      this.handleHistoryRewrite();
      this.emitHistoryReset();
    }
    this.onHistoryIntegrity(readIntegrity(snapshot.read));
    const summaries = this.readTerminalSummaries(snapshot.identity, this.primed && !rewritten);
    const messages = await this.messagesFor(snapshot.read, summaries);
    this.onHistorySnapshot(snapshot.read.entries, messages, snapshot.read.byteLength);
    this.rememberUncorrelatedUserKeys(this.applyReplayCorrelations(messages).values());
    this.setTailCursor(snapshot.read, snapshot.identity);
    return messages;
  }

  getHistorySourceIdentity() {
    return grokHistorySourceIdentity(this.session);
  }

  protected async inspectHistoryForDrive(): Promise<GrokUpdatesRead> {
    const snapshot = await this.readStableSnapshot();
    if (!snapshot) throw new Error('Grok updates log did not converge on one immutable prefix.');
    const rewritten = this.primed && this.isHistoryRewrite(snapshot.read, snapshot.identity);
    if (rewritten) {
      this.onHistoryRewrite();
      this.emitHistoryReset();
    }
    this.onHistoryIntegrity(readIntegrity(snapshot.read));
    const messages = mapGrokTranscript(this.session.id, snapshot.read.entries, this.trace);
    this.onHistorySnapshot(snapshot.read.entries, messages, snapshot.read.byteLength);
    this.setTailCursor(snapshot.read, snapshot.identity);
    return snapshot.read;
  }

  async captureHistorySnapshot(
    sink: HistorySnapshotSink,
    _query?: HistoryQuery,
  ): Promise<HistorySnapshotCapture | HistorySnapshotRefusal | undefined> {
    for (let attempt = 0; attempt < HISTORY_CAPTURE_ATTEMPTS; attempt += 1) {
      const [identityBefore, boundaryBefore] = await Promise.all([
        grokHistorySourceIdentity(this.session),
        fileBoundary(this.session.updatesPath),
      ]);
      const read = await readGrokUpdates(this.session);
      await this.captureTestHook?.();
      const confirmed = await readGrokUpdates(this.session);
      this.onHistoryIntegrity(readIntegrity(read) ?? readIntegrity(confirmed));
      const [identityAfter, boundaryAfter] = await Promise.all([
        grokHistorySourceIdentity(this.session),
        fileBoundary(this.session.updatesPath),
      ]);
      if (!sameIdentity(identityBefore, identityAfter)
        || !sameBoundary(boundaryBefore, boundaryAfter)
        || read.byteLength !== confirmed.byteLength
        || !read.durablePrefixBytes.equals(confirmed.durablePrefixBytes)
        || read.durablePrefixBytes.length !== read.byteLength
        || identityBefore.appendPosition !== read.byteLength
        || read.issues.length > 0) {
        if (attempt + 1 < HISTORY_CAPTURE_ATTEMPTS) await sleep(HISTORY_RETRY_MS);
        continue;
      }
      const rewritten = this.primed && this.isHistoryRewrite(read, identityBefore);
      if (rewritten) {
        this.handleHistoryRewrite();
        this.emitHistoryReset();
      }
      const summaries = this.readTerminalSummaries(identityBefore, this.primed && !rewritten);
      const messages = await this.messagesFor(read, summaries);
      this.onHistorySnapshot(read.entries, messages, read.byteLength);
      const uncorrelated = this.applyReplayCorrelations(messages);
      this.setTailCursor(read, identityBefore);
      for (let location = 0; location < messages.length; location += 1) {
        const message = messages[location];
        if (!message || !sink.accept(message, sink.acceptsLocations ? location : undefined)) {
          return { refusal: 'resource-limit' };
        }
        const nativeKey = uncorrelated.get(message);
        if (nativeKey) this.emittedUncorrelatedUserKeys.add(nativeKey);
      }
      return {
        identity: { ...identityBefore },
        ...(sink.acceptsLocations ? { reader: new GrokMemoryHistoryReader(identityBefore, messages) } : {}),
      };
    }
    this.trace?.({ op: 'observe', detail: 'history capture could not establish one immutable update-log prefix' });
    return undefined;
  }

  subscribe(handler: AgentMessageHandler): Unsubscribe {
    this.handlers.add(handler);
    if (!this.watcher && !this.closed) this.startWatcher();
    return () => this.handlers.delete(handler);
  }

  async sendPrompt(_input: PromptInput): Promise<void> {
    throw new Error('Grok Observe is read-only; attach with resume to send a prompt.');
  }

  async respondPermission(_requestId: string, _decision: PermissionDecision): Promise<void> {
    throw new Error('Grok Observe cannot answer permissions.');
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
    this.replayCorrelationUnsubscribe?.();
    this.terminalSummaryUnsubscribe?.();
    this.emittedUncorrelatedUserKeys.clear();
    this.handlers.clear();
  }

  protected onTailEntry(_entry: GrokUpdateEntry, messages: readonly AgentMessage[]): readonly AgentMessage[] {
    return messages;
  }
  protected onHistorySnapshot(
    _entries: readonly GrokUpdateEntry[],
    _messages: readonly AgentMessage[],
    _byteLength: number,
  ): void {}
  protected onHistoryRewrite(): void {}
  protected onHistoryIntegrity(_failure: GrokHistoryIntegrityFailure | undefined): void {}
  protected ownsLiveWriter(): boolean { return false; }

  protected rememberTerminalSummary(
    summary: GrokTerminalSummary,
    boundary: HistorySourceIdentity,
  ): void {
    this.terminalSummaryRegistry.publish(boundary, summary);
  }

  protected rememberTerminalSummaryBoundary(boundary: HistorySourceIdentity): void {
    this.terminalSummaryRegistry.publish(boundary);
  }

  protected emitHistoryReset(): void {
    this.emit({
      type: 'history-reset',
      notice: 'The Grok transcript changed outside this connection; reloading it.',
      semantic: { kind: 'rollback' },
    });
  }

  private async messagesFor(
    read: GrokUpdatesRead,
    terminalSummaries: readonly GrokTerminalSummary[],
  ): Promise<AgentMessage[]> {
    let messages = mapGrokTranscript(this.session.id, read.entries, this.trace);
    const nativeTerminalFallbackKeys = new Set<string>();
    const fallbackKeys = new Set(terminalSummaries
      .map((summary) => summary.key)
      .filter((key) => key.endsWith(':acp-terminal')));
    const unmatchedUserKeys = new Set<string>();
    const userTurnIds = new Map<string, string>();
    for (const entry of read.entries) {
      if (grokUserText(entry.record) !== undefined) {
        const userKey = grokMessageKey(this.session.id, entry.record, entry.lineIndex);
        unmatchedUserKeys.add(userKey);
        userTurnIds.set(userKey, grokTurnId(this.session.id, entry.record, entry.lineIndex));
      }
      const nativeSummaries = mapGrokUpdate(entry.record, {
        sessionId: this.session.id,
        lineIndex: entry.lineIndex,
        trace: this.trace,
      }).filter((message): message is Extract<AgentMessage, { type: 'run-summary' }> =>
        message.type === 'run-summary');
      for (const nativeSummary of nativeSummaries) {
        if (grokPromptId(entry.record) !== undefined) {
          const matchedUserKey = [...unmatchedUserKeys].find((userKey) =>
            userTurnIds.get(userKey) === nativeSummary.turnId);
          if (matchedUserKey) {
            const fallbackKey = `${matchedUserKey}:acp-terminal`;
            if (fallbackKeys.has(fallbackKey)) nativeTerminalFallbackKeys.add(fallbackKey);
            unmatchedUserKeys.delete(matchedUserKey);
          }
        } else if (unmatchedUserKeys.size === 1) {
          const matchedUserKey = unmatchedUserKeys.values().next().value as string;
          const fallbackKey = `${matchedUserKey}:acp-terminal`;
          if (fallbackKeys.has(fallbackKey)) nativeTerminalFallbackKeys.add(fallbackKey);
          unmatchedUserKeys.delete(matchedUserKey);
        }
      }
    }
    const nativeSummaryKeys = new Set(messages
      .filter((message): message is Extract<AgentMessage, { type: 'run-summary' }> =>
        message.type === 'run-summary')
      .map((message) => message.key));
    const nativeSummaryTurnIds = new Set(messages
      .filter((message): message is Extract<AgentMessage, { type: 'run-summary' }> =>
        message.type === 'run-summary')
      .map((message) => message.turnId));
    const replaySummaries = terminalSummaries
      .filter((summary) => !nativeSummaryKeys.has(summary.key)
        && !nativeSummaryTurnIds.has(summary.turnId)
        && !nativeTerminalFallbackKeys.has(summary.key));
    const terminalTurnIds = new Set([
      ...messages
        .filter((message): message is Extract<AgentMessage, { type: 'run-summary' }> =>
          message.type === 'run-summary')
        .map((message) => message.turnId),
      ...replaySummaries.map((message) => message.turnId),
    ]);
    if (!this.ownsLiveWriter()) {
      const interrupted = mapGrokInterruptedTail(this.session.id, read.entries);
      if (interrupted?.type === 'run-summary'
        && !terminalTurnIds.has(interrupted.turnId)) messages.push(interrupted);
    }
    messages.push(...replaySummaries.map((summary) => ({ ...summary })));
    const usage = grokContextUsage(await readGrokSignals(this.session));
    if (usage) messages.push(usage);
    for (const issue of [...read.issues].reverse()) {
      messages.unshift({ type: 'notice', message: `Grok history: ${issue}.` });
    }
    return messages;
  }

  private startWatcher(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.pendingWatcherStable) clearTimeout(this.pendingWatcherStable);
    this.pendingWatcherStable = undefined;
    try {
      const watched = new Set([
        basename(this.session.updatesPath),
        basename(this.session.summaryPath),
        basename(this.session.signalsPath),
      ]);
      const updatesName = basename(this.session.updatesPath);
      const watcher = this.watchFactory(dirname(this.session.updatesPath), { persistent: false }, (eventType, filename) => {
        const changed = filename === null || filename === undefined ? undefined : String(filename);
        if (changed !== undefined && !watched.has(changed)) return;
        if (!this.pendingDrain && !this.closed) {
          this.pendingDrain = setTimeout(() => {
            this.pendingDrain = undefined;
            void this.drain();
          }, TAIL_DEBOUNCE_MS);
        }
        if (eventType === 'rename' && (changed === undefined || changed === updatesName)) this.scheduleWatcherRearm();
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
      this.trace?.({ op: 'observe', detail: 'watch re-arm limit reached after update-log replacement' });
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
          this.trace?.({ op: 'observe', detail: 'tail drain deferred until the update log stabilizes' });
          continue;
        }
        const { read, identity } = snapshot;
        if (!this.primed) {
          this.setTailCursor(read, identity);
          continue;
        }
        if (this.isHistoryRewrite(read, identity)) {
          this.handleHistoryRewrite();
          this.emitHistoryReset();
          this.setTailCursor(read, identity);
          this.scheduleWatcherRearm();
          continue;
        }
        this.onHistoryIntegrity(readIntegrity(read));
        // Resolve id-less prompt rows the same way `mapGrokTranscript` does.
        // Emitting them one record at a time gave them `turn-line:N` while
        // replay walked forward to the turn's real prompt id, so live and
        // replay disagreed about which turn a prompt belonged to. This drain
        // holds the whole read, so the walk is available here too; it resolves
        // nothing when the resolving record has not landed yet, which is the
        // honest answer at that moment.
        const drainPromptIds = turnPromptIds(read.entries);
        for (let index = this.entryCount; index < read.entries.length; index += 1) {
          const entry = read.entries[index];
          if (!entry) continue;
          // Bind through the prompt id, not through "most recent user row" -- see the same
          // reasoning in drive.ts: an id-less terminal must not claim a newer turn's prompt.
          if (grokUserText(entry.record) !== undefined) {
            this.tailTurnUserKey = grokMessageKey(this.session.id, entry.record, entry.lineIndex);
          }
          const tailPromptId = grokPromptId(entry.record);
          if (tailPromptId !== undefined && this.tailTurnUserKey !== undefined
            && !this.tailPromptUserKeys.has(tailPromptId)) {
            this.tailPromptUserKeys.set(tailPromptId, this.tailTurnUserKey);
            while (this.tailPromptUserKeys.size > 64) {
              const oldest = this.tailPromptUserKeys.keys().next().value;
              if (oldest === undefined) break;
              this.tailPromptUserKeys.delete(oldest);
            }
          }
          const tailUserKey = tailPromptId === undefined
            ? undefined
            : this.tailPromptUserKeys.get(tailPromptId);
          const drainPromptId = drainPromptIds.get(entry.lineIndex);
          const messages = mapGrokUpdate(entry.record, {
            sessionId: this.session.id,
            lineIndex: entry.lineIndex,
            trace: this.trace,
            ...(drainPromptId === undefined ? {} : { turnPromptId: drainPromptId }),
            ...(tailUserKey === undefined ? {} : { turnUserMessageKey: tailUserKey }),
          });
          const admitted = this.onTailEntry(entry, messages);
          const uncorrelated = this.applyReplayCorrelations(admitted);
          for (const message of admitted) this.emit(message);
          this.rememberUncorrelatedUserKeys(uncorrelated.values());
        }
        const usage = grokContextUsage(await readGrokSignals(this.session));
        if (usage) this.emit(usage);
        for (const issue of read.issues) this.emit({ type: 'notice', message: `Grok history: ${issue}.` });
        this.setTailCursor(read, identity);
      } while (this.drainAgain && !this.closed);
    } catch (error) {
      this.trace?.({ op: 'observe', detail: `tail drain failed: ${error instanceof Error ? error.message : String(error)}` });
      this.emit({ type: 'notice', message: 'Grok history could not be refreshed.' });
    } finally {
      this.draining = false;
    }
  }

  private isHistoryRewrite(read: GrokUpdatesRead, identity: HistorySourceIdentity | undefined): boolean {
    const initialLazyCreation = this.isInitialLazyCreation(identity);
    return read.entries.length < this.entryCount
      || (!initialLazyCreation && this.sourceId !== undefined && identity?.sourceId !== this.sourceId)
      || (identity?.appendPosition ?? read.byteLength) < this.appendPosition
      || !prefixUnchanged(read.durablePrefixBytes, this.durablePrefix);
  }

  private handleHistoryRewrite(): void {
    this.replayCorrelations?.clear();
    this.terminalSummaryRegistry.clear();
    this.emittedUncorrelatedUserKeys.clear();
    this.onHistoryRewrite();
  }

  private readTerminalSummaries(
    identity: HistorySourceIdentity,
    appendLineageProved: boolean,
  ): GrokTerminalSummary[] {
    const result = this.terminalSummaryRegistry.read(identity, appendLineageProved);
    if (!result.valid) this.onTerminalSummaryBoundaryInvalid?.();
    return result.rows;
  }

  private applyReplayCorrelations(messages: readonly AgentMessage[]): Map<AgentMessage, string> {
    const uncorrelated = new Map<AgentMessage, string>();
    const users = messages.filter((message): message is Extract<AgentMessage, { type: 'user-message' }> =>
      message.type === 'user-message' && typeof message.key === 'string');
    const mismatch = users.find((message) => {
      const correlation = this.replayCorrelations?.get(message.key!);
      return correlation !== undefined && correlation.text !== message.text;
    });
    if (mismatch) {
      this.replayCorrelations?.clear();
      this.trace?.({ op: 'observe', detail: 'discarded Grok replay correlations after a native key changed content' });
      for (const message of users) uncorrelated.set(message, message.key!);
      return uncorrelated;
    }
    for (const message of users) {
      const nativeKey = message.key!;
      const correlation = this.replayCorrelations?.get(nativeKey);
      if (!correlation) {
        uncorrelated.set(message, nativeKey);
        continue;
      }
      if (correlation.text !== message.text) {
        continue;
      }
      message.key = correlation.key;
      message.queued = false;
      if (correlation.clientKey) message.clientKey = correlation.clientKey;
    }
    // A summary names the row that opened its turn, and replay names it by the
    // NATIVE key -- the one this method just rewrote out of existence. Left
    // alone the anchor points at a row no reader holds, which is how a turn's
    // only token usage came to be published and still bind to nothing. Resolve
    // through the registry, not through this batch: the tail drain delivers the
    // summary in a later batch than the prompt it names.
    for (const message of messages) {
      if (message.type !== 'run-summary' || typeof message.userMessageKey !== 'string') continue;
      const correlation = this.replayCorrelations?.get(message.userMessageKey);
      if (correlation) message.userMessageKey = correlation.key;
    }
    return uncorrelated;
  }

  private rememberUncorrelatedUserKeys(nativeKeys: Iterable<string>): void {
    for (const nativeKey of nativeKeys) this.emittedUncorrelatedUserKeys.add(nativeKey);
  }

  private isInitialLazyCreation(identity: HistorySourceIdentity | undefined): boolean {
    return this.entryCount === 0
      && this.durablePrefix.length === 0
      && this.appendPosition === 0
      && this.sourceId?.endsWith(':absent') === true
      && identity !== undefined
      && !identity.sourceId.endsWith(':absent');
  }

  private setTailCursor(read: GrokUpdatesRead, identity: HistorySourceIdentity | undefined): void {
    this.entryCount = read.entries.length;
    this.durablePrefix = read.durablePrefixBytes;
    this.sourceId = identity?.sourceId;
    this.appendPosition = identity?.appendPosition ?? read.byteLength;
    this.primed = true;
  }

  private async readStableSnapshot(): Promise<StableGrokSnapshot | undefined> {
    for (let attempt = 0; attempt < HISTORY_CAPTURE_ATTEMPTS; attempt += 1) {
      const [identityBefore, boundaryBefore] = await Promise.all([
        grokHistorySourceIdentity(this.session),
        fileBoundary(this.session.updatesPath),
      ]);
      const read = await readGrokUpdates(this.session);
      await this.snapshotTestHook?.(attempt);
      const confirmed = await readGrokUpdates(this.session);
      const [identityAfter, boundaryAfter] = await Promise.all([
        grokHistorySourceIdentity(this.session),
        fileBoundary(this.session.updatesPath),
      ]);
      if (identityBefore !== undefined
        && sameIdentity(identityBefore, identityAfter)
        && sameBoundary(boundaryBefore, boundaryAfter)
        && read.byteLength === confirmed.byteLength
        && read.durablePrefixBytes.equals(confirmed.durablePrefixBytes)
        && identityBefore.appendPosition === read.byteLength) return { read, identity: identityBefore };
      if (attempt + 1 < HISTORY_CAPTURE_ATTEMPTS) await sleep(HISTORY_RETRY_MS);
    }
    return undefined;
  }
}

export interface GrokHistoryIntegrityFailure {
  issues: readonly string[];
  incompleteTail: boolean;
}

function readIntegrity(read: GrokUpdatesRead): GrokHistoryIntegrityFailure | undefined {
  const incompleteTail = read.durablePrefixBytes.length !== read.byteLength;
  return read.issues.length > 0 || incompleteTail
    ? { issues: read.issues, incompleteTail }
    : undefined;
}
