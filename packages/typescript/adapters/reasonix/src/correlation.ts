import { createHash } from 'node:crypto';
import type { AgentMessage, HistorySourceIdentity } from '@cosyncing/adapter-api';
import { reasonixMessageKey, type ReasonixDisplayEntry, type ReasonixTranscriptRecord } from './mapping.ts';
import type { ReasonixTranscriptRead } from './store.ts';

export const REASONIX_CORRELATION_MAX_SESSIONS = 128;
export const REASONIX_CORRELATION_MAX_ENTRIES_PER_SESSION = 256;

interface ReasonixCorrelationEntry {
  offset: number;
  displayIndex: number;
  key: string;
  clientKey?: string;
  textDigest: string;
  prefixDigest: string;
}

interface ReasonixSessionCorrelations {
  sourceId: string;
  entries: Map<number, ReasonixCorrelationEntry>;
}

export interface ReasonixCorrelationValue {
  key: string;
  clientKey?: string;
}

export interface ReasonixCorrelationRemembered {
  sessionId: string;
  rowIdentity: string;
}

export interface ReasonixCorrelationRegistryOptions {
  maxSessions?: number;
  maxEntriesPerSession?: number;
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('base64url');
}

function durablePrefixDigest(
  read: ReasonixTranscriptRead,
  display: ReasonixDisplayEntry,
): string | undefined {
  const end = display.offset + display.length;
  if (!Number.isSafeInteger(display.offset) || display.offset < 0
      || !Number.isSafeInteger(display.length) || display.length <= 0
      || !Number.isSafeInteger(end) || end > read.durablePrefixBytes.length) return undefined;
  return digest(read.durablePrefixBytes.subarray(0, end));
}

function recordText(record: ReasonixTranscriptRecord): string | undefined {
  return typeof record.raw_content === 'string' ? record.raw_content
    : typeof record.content === 'string' ? record.content
      : undefined;
}

/**
 * Process-local bridge from a Drive-owned optimistic row to later Observe
 * replays. Entries are bounded and qualified by the transcript inode plus the
 * exact durable byte prefix through the claimed row, so an append preserves a
 * correlation while a replacement or accepted-prefix rewrite cannot inherit
 * it.
 */
export class ReasonixCorrelationRegistry {
  private readonly sessions = new Map<string, ReasonixSessionCorrelations>();
  private readonly subscribers = new Map<string, Set<(event: ReasonixCorrelationRemembered) => void>>();
  private readonly maxSessions: number;
  private readonly maxEntriesPerSession: number;

  constructor(options: ReasonixCorrelationRegistryOptions = {}) {
    this.maxSessions = Math.max(1, Math.min(
      options.maxSessions ?? REASONIX_CORRELATION_MAX_SESSIONS,
      REASONIX_CORRELATION_MAX_SESSIONS,
    ));
    this.maxEntriesPerSession = Math.max(1, Math.min(
      options.maxEntriesPerSession ?? REASONIX_CORRELATION_MAX_ENTRIES_PER_SESSION,
      REASONIX_CORRELATION_MAX_ENTRIES_PER_SESSION,
    ));
  }

  remember(
    sessionId: string,
    read: ReasonixTranscriptRead,
    identity: HistorySourceIdentity,
    display: ReasonixDisplayEntry,
    text: string,
    value: ReasonixCorrelationValue,
  ): void {
    const prefixDigest = durablePrefixDigest(read, display);
    if (!prefixDigest || !value.key) return;
    const rowIdentity = this.rowIdentity(read, identity, display, text);
    if (!rowIdentity) return;
    let session = this.sessions.get(sessionId);
    if (!session || session.sourceId !== identity.sourceId) {
      this.sessions.delete(sessionId);
      session = { sourceId: identity.sourceId, entries: new Map() };
    } else {
      this.sessions.delete(sessionId);
    }
    this.sessions.set(sessionId, session);
    const entry: ReasonixCorrelationEntry = {
      offset: display.offset,
      displayIndex: display.index,
      key: value.key,
      ...(value.clientKey ? { clientKey: value.clientKey } : {}),
      textDigest: digest(text),
      prefixDigest,
    };
    session.entries.delete(display.offset);
    session.entries.set(display.offset, entry);
    while (session.entries.size > this.maxEntriesPerSession) {
      const oldest = session.entries.keys().next().value;
      if (oldest === undefined) break;
      session.entries.delete(oldest);
    }
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    for (const subscriber of this.subscribers.get(sessionId) ?? []) {
      try { subscriber({ sessionId, rowIdentity }); } catch { /* one reader cannot block another */ }
    }
  }

  applyRecord(
    sessionId: string,
    read: ReasonixTranscriptRead,
    identity: HistorySourceIdentity,
    record: ReasonixTranscriptRecord,
    lineIndex: number,
    display: ReasonixDisplayEntry | undefined,
    messages: readonly AgentMessage[],
  ): boolean {
    if (record.role !== 'user' || !display) return false;
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.sourceId !== identity.sourceId) {
      this.sessions.delete(sessionId);
      return false;
    }
    const entry = session.entries.get(display.offset);
    if (!entry) return false;
    const text = recordText(record);
    const prefixDigest = durablePrefixDigest(read, display);
    if (entry.displayIndex !== display.index || text === undefined
        || entry.textDigest !== digest(text) || prefixDigest !== entry.prefixDigest) {
      session.entries.delete(display.offset);
      if (session.entries.size === 0) this.sessions.delete(sessionId);
      return false;
    }
    const nativeKey = reasonixMessageKey(sessionId, display.index ?? lineIndex);
    const message = messages.find((candidate) => candidate.type === 'user-message'
      && (candidate.key === nativeKey || candidate.key === entry.key));
    if (message?.type !== 'user-message') return false;
    message.key = entry.key;
    message.queued = false;
    if (entry.clientKey) message.clientKey = entry.clientKey;
    return true;
  }

  rowIdentity(
    read: ReasonixTranscriptRead,
    identity: HistorySourceIdentity,
    display: ReasonixDisplayEntry,
    text: string,
  ): string | undefined {
    const prefixDigest = durablePrefixDigest(read, display);
    if (!prefixDigest) return undefined;
    return [
      identity.sourceId,
      String(display.offset),
      String(display.index),
      digest(text),
      prefixDigest,
    ].join('\u0000');
  }

  subscribe(
    sessionId: string,
    subscriber: (event: ReasonixCorrelationRemembered) => void,
  ): () => void {
    const sessionSubscribers = this.subscribers.get(sessionId) ?? new Set();
    sessionSubscribers.add(subscriber);
    this.subscribers.set(sessionId, sessionSubscribers);
    return () => {
      sessionSubscribers.delete(subscriber);
      if (sessionSubscribers.size === 0) this.subscribers.delete(sessionId);
    };
  }

  invalidate(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
