/** Read-only Kilo SQLite replay and WAL-triggered re-snapshot tail. */
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
import {
  readKiloHistory,
  kiloHistorySourceIdentity,
  refreshKiloStoredSession,
  type KiloHistorySnapshot,
  type KiloStoredSession,
} from './store.ts';

const DEBOUNCE_MS = 80;
const RETRY_MS = 250;
const MAX_RECOVERY_ATTEMPTS = 3;

export interface KiloObserveOptions {
  session: KiloStoredSession;
  info: SessionInfo;
  watchFactory?: typeof watch;
  trace?: (event: { op: 'observe'; detail: string }) => void;
}

class EncodedHistoryReader implements HistorySnapshotPageReader {
  readonly retainedBytes: number;

  constructor(
    private readonly identity: HistorySourceIdentity,
    private readonly encodings: readonly string[],
  ) {
    this.retainedBytes = encodings.reduce((sum, encoding) => sum + Buffer.byteLength(encoding, 'utf8') + 16, 0);
  }

  read(locations: readonly number[]): HistorySnapshotPageRead | HistorySnapshotRefusal | undefined {
    const messages: AgentMessage[] = [];
    let bytesRead = 0;
    for (const location of locations) {
      if (!Number.isSafeInteger(location) || location < 0) return undefined;
      const encoding = this.encodings[location];
      if (!encoding) return undefined;
      try { messages.push(JSON.parse(encoding) as AgentMessage); } catch { return undefined; }
      bytesRead += Buffer.byteLength(encoding, 'utf8');
    }
    return { identity: { ...this.identity }, messages, work: { recordsRead: messages.length, bytesRead } };
  }
}

function prefixMatches(previous: readonly string[], current: readonly string[]): boolean {
  return current.length >= previous.length && previous.every((encoding, index) => current[index] === encoding);
}

export class KiloObserveConnection implements SessionConnection {
  readonly info: SessionInfo;
  private readonly session: KiloStoredSession;
  private readonly watchFactory: typeof watch;
  private readonly trace?: KiloObserveOptions['trace'];
  private readonly handlers = new Set<AgentMessageHandler>();
  private watcher?: FSWatcher;
  private pending?: ReturnType<typeof setTimeout>;
  private encodings: string[] = [];
  private revision?: string;
  private sourceIdentity?: string;
  private primed = false;
  private pagingInvalidated = false;
  private draining = false;
  private drainAgain = false;
  private snapshotFailures = 0;
  private watcherFailures = 0;
  private closed = false;

  constructor(options: KiloObserveOptions) {
    this.session = options.session;
    this.info = options.info;
    this.watchFactory = options.watchFactory ?? watch;
    if (options.trace) this.trace = options.trace;
  }

  async getHistory(_query?: HistoryQuery): Promise<AgentMessage[]> {
    await this.refreshInfo();
    const snapshot = await readKiloHistory(this.session);
    if (!snapshot) throw new Error('Kilo SQLite snapshot is unavailable or unsupported.');
    if (this.sourceReplaced(snapshot) || (this.primed && !prefixMatches(this.encodings, snapshot.encodings))) {
      this.invalidatePaging();
    }
    this.setCursor(snapshot);
    return snapshot.messages;
  }

  async getHistorySourceIdentity(): Promise<HistorySourceIdentity | undefined> {
    if (this.pagingInvalidated) return undefined;
    const snapshot = await readKiloHistory(this.session);
    return snapshot ? this.identity(snapshot) : undefined;
  }

  async captureHistorySnapshot(
    sink: HistorySnapshotSink,
    _query?: HistoryQuery,
  ): Promise<HistorySnapshotCapture | HistorySnapshotRefusal | undefined> {
    if (this.pagingInvalidated) return undefined;
    await this.refreshInfo();
    const snapshot = await readKiloHistory(this.session);
    if (!snapshot) return undefined;
    if (this.sourceReplaced(snapshot) || (this.primed && !prefixMatches(this.encodings, snapshot.encodings))) {
      this.invalidatePaging();
      this.setCursor(snapshot);
      return undefined;
    }
    const retained: string[] = [];
    for (let location = 0; location < snapshot.messages.length; location += 1) {
      const message = snapshot.messages[location];
      if (!message || !sink.accept(message, sink.acceptsLocations ? location : undefined)) return { refusal: 'resource-limit' };
      if (sink.acceptsLocations) retained.push(snapshot.encodings[location]!);
    }
    this.setCursor(snapshot);
    const identity = this.identity(snapshot);
    return { identity, ...(sink.acceptsLocations ? { reader: new EncodedHistoryReader(identity, retained) } : {}) };
  }

  subscribe(handler: AgentMessageHandler): Unsubscribe {
    this.handlers.add(handler);
    if (!this.watcher && !this.closed) this.startWatcher();
    return () => this.handlers.delete(handler);
  }

  async getPending(): Promise<AgentMessage[]> { return []; }

  async sendPrompt(_input: PromptInput): Promise<void> {
    throw new Error('Kilo Code Observe is read-only; attach a broker-owned root session in live mode to send prompts.');
  }

  async respondPermission(_requestId: string, _decision: PermissionDecision): Promise<void> {
    throw new Error('Kilo Code Observe cannot answer native permissions.');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.pending) clearTimeout(this.pending);
    this.watcher?.close();
    this.handlers.clear();
  }

  private identity(snapshot: KiloHistorySnapshot): HistorySourceIdentity {
    return kiloHistorySourceIdentity(this.session, snapshot);
  }

  private setCursor(snapshot: KiloHistorySnapshot): void {
    this.primed = true;
    this.encodings = [...snapshot.encodings];
    this.revision = snapshot.revision;
    this.sourceIdentity = snapshot.sourceIdentity;
  }

  private sourceReplaced(snapshot: KiloHistorySnapshot): boolean {
    return this.primed && this.sourceIdentity !== snapshot.sourceIdentity;
  }

  private invalidatePaging(): void {
    this.pagingInvalidated = true;
    this.emit({
      type: 'history-reset',
      notice: 'The Kilo Code SQLite history changed before the retained prefix; reloading the current snapshot.',
      semantic: { kind: 'rollback' },
    });
  }

  private emit(message: AgentMessage): void {
    for (const handler of this.handlers) {
      try { handler(message); } catch (error) {
        this.trace?.({ op: 'observe', detail: `subscriber threw: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  }

  private async refreshInfo(): Promise<void> {
    const previous = this.info.status;
    if (!await refreshKiloStoredSession(this.session)) return;
    this.info.status = this.session.status;
    if (this.session.updatedAt !== undefined) this.info.updatedAt = this.session.updatedAt;
    else delete this.info.updatedAt;
    if (this.session.model) this.info.model = this.session.model;
    else delete this.info.model;
    if (this.session.currentModel) this.info.currentModel = this.session.currentModel;
    else delete this.info.currentModel;
    if (this.session.currentAgent) this.info.currentAgent = this.session.currentAgent;
    else delete this.info.currentAgent;
    if (previous !== this.info.status) this.emit({ type: 'status', status: this.info.status === 'working' ? 'running' : 'idle' });
  }

  private scheduleDrain(delay = DEBOUNCE_MS): void {
    if (this.pending || this.closed) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      void this.drain();
    }, delay);
    this.pending.unref?.();
  }

  private recoverWatcher(detail: string): void {
    this.trace?.({ op: 'observe', detail });
    try { this.watcher?.close(); } catch { /* best effort */ }
    this.watcher = undefined;
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = undefined;
    }
    this.watcherFailures += 1;
    if (this.watcherFailures > MAX_RECOVERY_ATTEMPTS) {
      this.emit({ type: 'error', message: 'Kilo Code history watching stopped after repeated filesystem errors.' });
      return;
    }
    if (this.closed) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      if (this.startWatcher()) void this.drain();
    }, RETRY_MS);
    this.pending.unref?.();
  }

  private startWatcher(): boolean {
    const expected = new Set([
      basename(this.session.databasePath),
      `${basename(this.session.databasePath)}-wal`,
      `${basename(this.session.databasePath)}-shm`,
      `${basename(this.session.databasePath)}-journal`,
    ]);
    try {
      this.watcher = this.watchFactory(dirname(this.session.databasePath), { persistent: false }, (_event, filename) => {
        const changed = filename == null ? undefined : String(filename);
        if (changed !== undefined && !expected.has(changed)) return;
        this.snapshotFailures = 0;
        this.watcherFailures = 0;
        this.scheduleDrain();
      });
      this.watcher.on('error', (error) => this.recoverWatcher(`watch failed: ${error.message}`));
      return true;
    } catch (error) {
      this.recoverWatcher(`watch unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private async drain(): Promise<void> {
    if (this.closed) return;
    if (this.draining) { this.drainAgain = true; return; }
    this.draining = true;
    try {
      do {
        this.drainAgain = false;
        await this.refreshInfo();
        const snapshot = await readKiloHistory(this.session);
        if (!snapshot) {
          this.snapshotFailures += 1;
          if (this.snapshotFailures <= MAX_RECOVERY_ATTEMPTS) this.scheduleDrain(RETRY_MS);
          else {
            this.trace?.({ op: 'observe', detail: 'snapshot remained unavailable after the bounded retry window' });
            this.emit({ type: 'error', message: 'Kilo Code history could not be refreshed after repeated snapshot failures.' });
          }
          break;
        }
        this.snapshotFailures = 0;
        if (!this.primed) { this.setCursor(snapshot); continue; }
        if (this.sourceReplaced(snapshot) || !prefixMatches(this.encodings, snapshot.encodings)) {
          this.invalidatePaging();
          this.setCursor(snapshot);
          continue;
        }
        for (let index = this.encodings.length; index < snapshot.messages.length; index += 1) {
          const message = snapshot.messages[index];
          if (message) this.emit(message);
        }
        if (snapshot.revision !== this.revision) this.setCursor(snapshot);
      } while (this.drainAgain && !this.closed);
    } finally {
      this.draining = false;
    }
  }
}
