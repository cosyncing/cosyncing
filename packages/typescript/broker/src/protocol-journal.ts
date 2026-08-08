/**
 * Durable delivery/idempotency bookkeeping for the broker wire protocol.
 *
 * This store deliberately contains no prompt or transcript content. Identities and request bodies
 * are represented only by SHA-256 hashes; terminal wire outcomes contain stable codes/messages.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setupStateHome } from './setup-state.ts';

export interface ProtocolJournalScope {
  identity: string;
  tool: string;
  sessionId: string;
}

export type ProtocolTerminalResult =
  /** DR1: `draftCleared`/`draftRevision` are part of the terminal outcome, not decoration. A
   *  duplicate send — the normal outbox replay after a crash — is answered from this record, so
   *  dropping them would tell the retrying sender its shared draft was cleared when it was not,
   *  and it would delete the local row that retries the clear. */
  | { kind: 'ack'; ack: 'client-message'; clientMessageId: string; draftCleared?: boolean; draftRevision?: number }
  | { kind: 'nack'; code: string; message: string; clientMessageId: string };

interface IdempotencyRecord extends ProtocolJournalScope {
  clientMessageId: string;
  mutationKind: string;
  fingerprint: string;
  state: 'in-flight' | 'terminal';
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  result?: ProtocolTerminalResult;
}

interface TicketRecord extends ProtocolJournalScope {
  ticketHash: string;
  state: 'issued' | 'acked' | 'nacked';
  issuedAt: number;
  updatedAt: number;
}

interface JournalFileV1 {
  version: 1;
  idempotency: IdempotencyRecord[];
  tickets: TicketRecord[];
}

export interface ProtocolJournalOptions {
  path?: string;
  now?: () => number;
  retentionMs?: number;
  maxIdempotencyEntries?: number;
  maxTicketEntries?: number;
  onWarning?: (message: string) => void;
}

export type IdempotencyClaim =
  | { status: 'new' }
  | { status: 'pending' }
  | { status: 'terminal'; result: ProtocolTerminalResult }
  | { status: 'conflict' }
  | { status: 'capacity' };

export type TicketReceipt =
  | { status: 'ok'; duplicate: boolean; receipt: 'ack' | 'nack' }
  | { status: 'unknown' }
  | { status: 'conflict'; prior: 'ack' | 'nack' };

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;

function idempotencyKey(record: Pick<IdempotencyRecord, keyof ProtocolJournalScope | 'clientMessageId'>): string {
  return [record.identity, record.tool, record.sessionId, record.clientMessageId].join('\0');
}

function ticketKey(record: Pick<TicketRecord, keyof ProtocolJournalScope | 'ticketHash'>): string {
  return [record.identity, record.tool, record.sessionId, record.ticketHash].join('\0');
}

function hashTicket(ticket: string): string {
  return createHash('sha256').update(ticket).digest('base64url');
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function canonicalize(value: unknown, key?: string): unknown {
  if (key === 'clientMessageId') return undefined;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (plainObject(value)) {
    const normalized: Record<string, unknown> = {};
    for (const entryKey of Object.keys(value).sort()) {
      const entry = canonicalize(value[entryKey], entryKey);
      if (entry !== undefined) normalized[entryKey] = entry;
    }
    return normalized;
  }
  if (value === undefined) return null;
  return value;
}

/** Hash a mutation without retaining prompt text, credentials, or other frame content. */
export function mutationFingerprint(message: unknown): string {
  const canonical = JSON.stringify(canonicalize(message));
  return createHash('sha256').update(canonical ?? 'null').digest('base64url');
}

function validTerminalResult(value: unknown): value is ProtocolTerminalResult {
  if (!plainObject(value) || typeof value.clientMessageId !== 'string') return false;
  if (value.kind === 'ack') {
    if (value.ack !== 'client-message') return false;
    // DR1 draft-handoff outcome. A record whose failure flag survived but whose retry target did
    // not is worse than no record: the sender would retry an unconditional clear. Reject the whole
    // file instead, so the journal reloads empty and every replay re-executes honestly.
    // Same shape the wire parser accepts (`parseDraftBaseRevision`): a negative
    // or unsafe revision would be dropped as unparseable when the sender
    // replayed it, degrading a conditional clear into a legacy unconditional
    // one that empties whatever another device typed since.
    const revisionOk = (raw: unknown): boolean => typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0;
    if (value.draftCleared !== undefined && typeof value.draftCleared !== 'boolean') return false;
    if (value.draftRevision !== undefined && !revisionOk(value.draftRevision)) return false;
    return value.draftCleared !== false || revisionOk(value.draftRevision);
  }
  return value.kind === 'nack' && typeof value.code === 'string' && typeof value.message === 'string';
}

function validScope(value: Record<string, unknown>): boolean {
  return typeof value.identity === 'string' && typeof value.tool === 'string' && typeof value.sessionId === 'string';
}

function parseFile(raw: unknown): JournalFileV1 | null {
  if (!plainObject(raw) || raw.version !== 1 || !Array.isArray(raw.idempotency) || !Array.isArray(raw.tickets)) return null;
  const idempotency: IdempotencyRecord[] = [];
  for (const value of raw.idempotency) {
    if (
      !plainObject(value) || !validScope(value) || typeof value.clientMessageId !== 'string' ||
      typeof value.mutationKind !== 'string' || typeof value.fingerprint !== 'string' ||
      (value.state !== 'in-flight' && value.state !== 'terminal') ||
      typeof value.createdAt !== 'number' || typeof value.updatedAt !== 'number' || typeof value.expiresAt !== 'number' ||
      (value.state === 'terminal' && !validTerminalResult(value.result))
    ) return null;
    idempotency.push(value as unknown as IdempotencyRecord);
  }
  const tickets: TicketRecord[] = [];
  for (const value of raw.tickets) {
    if (
      !plainObject(value) || !validScope(value) || typeof value.ticketHash !== 'string' ||
      !['issued', 'acked', 'nacked'].includes(String(value.state)) ||
      typeof value.issuedAt !== 'number' || typeof value.updatedAt !== 'number'
    ) return null;
    tickets.push(value as unknown as TicketRecord);
  }
  return { version: 1, idempotency, tickets };
}

export class ProtocolJournal {
  readonly path: string;
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly maxIdempotencyEntries: number;
  private readonly maxTicketEntries: number;
  private readonly onWarning: (message: string) => void;
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly tickets = new Map<string, TicketRecord>();

  constructor(options: ProtocolJournalOptions = {}) {
    this.path = options.path ?? join(setupStateHome(), 'protocol-journal.json');
    this.now = options.now ?? Date.now;
    this.retentionMs = Math.max(60_000, options.retentionMs ?? DEFAULT_RETENTION_MS);
    this.maxIdempotencyEntries = Math.max(1, options.maxIdempotencyEntries ?? DEFAULT_MAX_ENTRIES);
    this.maxTicketEntries = Math.max(1, options.maxTicketEntries ?? DEFAULT_MAX_ENTRIES);
    this.onWarning = options.onWarning ?? ((message) => console.warn(message));
    this.load();
  }

  claim(scope: ProtocolJournalScope, clientMessageId: string, mutationKind: string, fingerprint: string): IdempotencyClaim {
    this.prune();
    const key = idempotencyKey({ ...scope, clientMessageId });
    const prior = this.idempotency.get(key);
    if (prior) {
      if (prior.mutationKind !== mutationKind || prior.fingerprint !== fingerprint) return { status: 'conflict' };
      if (prior.state === 'in-flight') return { status: 'pending' };
      return { status: 'terminal', result: prior.result! };
    }
    if (!this.makeIdempotencyRoom()) return { status: 'capacity' };
    const now = this.now();
    this.idempotency.set(key, {
      ...scope,
      clientMessageId,
      mutationKind,
      fingerprint,
      state: 'in-flight',
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.retentionMs,
    });
    this.save();
    return { status: 'new' };
  }

  complete(scope: ProtocolJournalScope, clientMessageId: string, result: ProtocolTerminalResult): void {
    const key = idempotencyKey({ ...scope, clientMessageId });
    const record = this.idempotency.get(key);
    if (!record) throw new Error('idempotency journal completion has no matching claim');
    const now = this.now();
    record.state = 'terminal';
    record.result = result;
    record.updatedAt = now;
    record.expiresAt = now + this.retentionMs;
    this.save();
  }

  issueTicket(scope: ProtocolJournalScope, ticket: string): void {
    this.prune();
    const ticketHash = hashTicket(ticket);
    const key = ticketKey({ ...scope, ticketHash });
    if (this.tickets.has(key)) return;
    this.makeTicketRoom();
    const now = this.now();
    this.tickets.set(key, { ...scope, ticketHash, state: 'issued', issuedAt: now, updatedAt: now });
    this.save();
  }

  receiveTicket(scope: ProtocolJournalScope, ticket: string, receipt: 'ack' | 'nack'): TicketReceipt {
    this.prune();
    const key = ticketKey({ ...scope, ticketHash: hashTicket(ticket) });
    const record = this.tickets.get(key);
    if (!record) return { status: 'unknown' };
    const targetState = receipt === 'ack' ? 'acked' : 'nacked';
    if (record.state === targetState) return { status: 'ok', duplicate: true, receipt };
    if (record.state !== 'issued') {
      return { status: 'conflict', prior: record.state === 'acked' ? 'ack' : 'nack' };
    }
    record.state = targetState;
    record.updatedAt = this.now();
    this.save();
    return { status: 'ok', duplicate: false, receipt };
  }

  latestCommittedTicket(scope: ProtocolJournalScope): { issuedAt: number; updatedAt: number } | undefined {
    return [...this.tickets.values()]
      .filter((record) => record.identity === scope.identity && record.tool === scope.tool && record.sessionId === scope.sessionId && record.state === 'acked')
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }

  snapshot(): { idempotency: number; tickets: number } {
    return { idempotency: this.idempotency.size, tickets: this.tickets.size };
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = parseFile(JSON.parse(readFileSync(this.path, 'utf8')));
      if (!parsed) throw new Error('unsupported or malformed protocol journal');
      for (const record of parsed.idempotency) this.idempotency.set(idempotencyKey(record), record);
      for (const record of parsed.tickets) this.tickets.set(ticketKey(record), record);
      // A crash between dispatch and terminal persistence has an unknowable outcome. Never dispatch
      // it again under the same id: make that uncertainty a durable terminal nack.
      let recovered = false;
      for (const record of this.idempotency.values()) {
        if (record.state !== 'in-flight') continue;
        record.state = 'terminal';
        record.updatedAt = this.now();
        record.expiresAt = record.updatedAt + this.retentionMs;
        record.result = {
          kind: 'nack',
          code: 'CLIENT_MESSAGE_OUTCOME_UNKNOWN',
          message: 'broker restarted before the mutation outcome was durably recorded',
          clientMessageId: record.clientMessageId,
        };
        recovered = true;
      }
      const pruned = this.prune(false);
      if (recovered || pruned) this.save();
    } catch (error) {
      const quarantine = `${this.path}.corrupt-${this.now()}-${randomUUID().slice(0, 8)}`;
      try { renameSync(this.path, quarantine); } catch { /* preserve startup availability */ }
      this.idempotency.clear();
      this.tickets.clear();
      this.onWarning(`protocol journal quarantined after startup validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private prune(save = true): boolean {
    const cutoff = this.now() - this.retentionMs;
    let changed = false;
    for (const [key, record] of this.idempotency) {
      if (record.state === 'terminal' && record.updatedAt < cutoff) {
        this.idempotency.delete(key);
        changed = true;
      }
    }
    for (const [key, record] of this.tickets) {
      if (record.updatedAt < cutoff) {
        this.tickets.delete(key);
        changed = true;
      }
    }
    if (changed && save) this.save();
    return changed;
  }

  private makeIdempotencyRoom(): boolean {
    while (this.idempotency.size >= this.maxIdempotencyEntries) {
      const terminal = [...this.idempotency.entries()]
        .filter(([, record]) => record.state === 'terminal')
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
      if (!terminal) return false;
      this.idempotency.delete(terminal[0]);
    }
    return true;
  }

  private makeTicketRoom(): void {
    while (this.tickets.size >= this.maxTicketEntries) {
      const oldest = [...this.tickets.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
      if (!oldest) return;
      this.tickets.delete(oldest[0]);
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    const file: JournalFileV1 = {
      version: 1,
      idempotency: [...this.idempotency.values()],
      tickets: [...this.tickets.values()],
    };
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
