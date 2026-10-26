import { closeSync, fstatSync, readSync, statSync } from 'node:fs';
import { openRegularFileSync } from './store-file.ts';
import { TitleRecordProjection } from './title-record-projection.ts';

/** Display-only preview. Never write this over an explicit native name. */
export function sessionPromptPreview(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const normalized = text.replace(/[\p{Cc}\p{Z}\s]+/gu, ' ').trim();
  return normalized ? Array.from(normalized).slice(0, 160).join('') : undefined;
}

/** Machine context occasionally transported as a user message. Adapters add their own rules. */
export function isSessionInstruction(text: string): boolean {
  return /^\s*(?:# AGENTS\.md instructions|<environment_context>|<system-reminder>|<developer_instructions>|<user_instructions>|This session is being continued from a previous conversation|You are running headless)/i.test(text);
}

export interface SessionTitleCoverage {
  headThrough: number;
  complete: boolean;
  /** This generation has a previously complete snapshot to retain on growth. */
  previouslyComplete: boolean;
  /** Beginning of the one cold suffix, when its appended continuation is caught up. */
  tailFrom: number;
}

export interface SessionTitleRead<T> {
  facts: T;
  complete: boolean;
  coverage: SessionTitleCoverage;
}

interface Options<T> {
  stopWhen?: (facts: T) => boolean;
  tail?: boolean;
  /** Deterministic source-race seam; never changes the production budget. */
  afterChunk?: (path: string) => void;
  now?: () => number;
}

interface Cursor {
  offset: number;
  recordStart: number;
  record: TitleRecordProjection;
  /** A cold suffix starts inside a record whose prefix the forward cursor owns. */
  discard: boolean;
  boundary?: Buffer;
}
interface Entry<T> {
  generation: string;
  size: number;
  mtime: number;
  initialEnd: number;
  forward: Cursor;
  append?: Cursor;
  tailFrom: number;
  prefix?: Buffer;
  facts: T;
  published?: T;
  settled: boolean;
  opaque?: boolean;
}
const CHUNK_BYTES = 128 * 1024;
const SOURCE_BYTES = 16 * 1024 * 1024;
const TAIL_BYTES = 1024 * 1024;
const ELAPSED_MS = 250;
const cursor = (offset: number): Cursor => ({ offset, recordStart: offset, record: new TitleRecordProjection(), discard: false });

/** One forward backlog, one appended range, and one cold suffix. Growth never
 * moves either cursor backwards or invalidates already validated prefix facts. */
export class SessionTitleCache<T extends object> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly reading = new Map<string, Promise<SessionTitleRead<T>>>();
  constructor(
    private readonly empty: () => T,
    private readonly observe: (row: any, facts: T, offset: number) => void,
    private readonly openFile?: (path: string) => number | undefined | Promise<{ fd: number; close(): Promise<void> } | undefined>,
    private readonly options: Options<T> = {},
  ) {}

  async read(path: string, signal?: AbortSignal): Promise<T> {
    const result = await this.readResult(path, signal);
    return result.complete ? result.facts : structuredClone(this.entries.get(path)?.published ?? this.empty());
  }

  async readResult(path: string, signal?: AbortSignal): Promise<SessionTitleRead<T>> {
    const held = this.reading.get(path);
    if (held) { await held.catch(() => undefined); signal?.throwIfAborted(); return this.readResult(path, signal); }
    const work = this.scan(path, signal);
    this.reading.set(path, work);
    try { return await work; } finally { this.reading.delete(path); }
  }

  private result(entry?: Entry<T>, available = true): SessionTitleRead<T> {
    const framed = (position: Cursor): boolean => !position.discard && position.record.bytes === 0;
    const complete = available && !!entry && !entry.opaque && (entry.settled || (entry.forward.offset >= entry.initialEnd
      && framed(entry.forward) && (entry.append ? entry.append.offset >= entry.size && framed(entry.append) : entry.forward.offset >= entry.size)));
    const headThrough = entry && entry.forward.offset >= entry.initialEnd && framed(entry.forward)
      ? Math.max(entry.forward.recordStart, entry.append && !entry.append.discard ? entry.append.recordStart : 0)
      : entry?.forward.recordStart ?? 0;
    return { facts: structuredClone(entry?.opaque ? entry.published ?? this.empty() : entry?.facts ?? this.empty()), complete,
      coverage: { complete, previouslyComplete: entry?.published !== undefined, headThrough,
        tailFrom: available && entry && !entry.opaque && entry.append && entry.append.offset >= entry.size ? entry.tailFrom : Infinity } };
  }

  private async scan(path: string, signal?: AbortSignal): Promise<SessionTitleRead<T>> {
    let entry = this.entries.get(path);
    let fd: number | undefined;
    let handle: { fd: number; close(): Promise<void> } | undefined;
    try {
      signal?.throwIfAborted();
      const opened = this.openFile ? await this.openFile(path) : openRegularFileSync(path);
      if (opened === undefined) return this.result(entry, false);
      if (typeof opened === 'number') fd = opened;
      else { handle = opened; fd = handle.fd; }
      const st = fstatSync(fd);
      const generation = `${st.dev}:${st.ino}:${st.birthtimeMs}`;
      const matches = (bytes: Buffer | undefined, start: number): boolean => {
        if (!bytes) return true;
        const current = Buffer.alloc(bytes.length);
        return start >= 0 && readSync(fd!, current, 0, current.length, start) === current.length && current.equals(bytes);
      };
      const anchorsMatch = (candidate: Entry<T>): boolean => matches(candidate.prefix, 0)
        && [candidate.forward, candidate.append].every((position) => !position
          || matches(position.boundary, position.offset - (position.boundary?.length ?? 0)));
      if (entry && (entry.generation !== generation || st.size < entry.size || !anchorsMatch(entry))) {
        this.entries.delete(path);
        entry = undefined;
      }
      const cold = !entry;
      entry ??= { generation, size: st.size, mtime: st.mtimeMs, initialEnd: st.size,
        forward: cursor(0), tailFrom: Infinity, facts: this.empty(), settled: false };
      entry.size = st.size;
      entry.mtime = st.mtimeMs;
      this.entries.delete(path);
      this.entries.set(path, entry);
      if (this.entries.size > 8192) this.entries.delete(this.entries.keys().next().value!);
      const now = this.options.now ?? (() => performance.now());
      const deadline = now() + ELAPSED_MS;
      let scanned = 0;
      const observe = (record: TitleRecordProjection, offset: number): void => {
        if (entry!.opaque) return;
        const result = record.finish();
        if (result.kind === 'opaque') { entry!.opaque = true; return; }
        if (result.kind === 'record') {
          try { this.observe(result.value, entry!.facts, offset); } catch { /* unsupported/malformed row */ }
        }
      };
      const consume = async (position: Cursor, end: number): Promise<void> => {
        const length = Math.min(CHUNK_BYTES, end - position.offset, SOURCE_BYTES - scanned);
        if (length <= 0) return;
        const bytes = Buffer.alloc(length);
        const start = position.offset;
        const count = readSync(fd!, bytes, 0, length, start);
        if (count !== length) throw new Error('Session source shortened during a read.');
        scanned += count;
        if (start === 0) entry!.prefix = Buffer.from(bytes.subarray(0, Math.min(count, 256)));
        position.offset += count;
        position.boundary = Buffer.from(bytes.subarray(Math.max(0, count - 256), count));
        let from = 0;
        for (let newline = bytes.indexOf(0x0a); newline >= 0; newline = bytes.indexOf(0x0a, from)) {
          if (!position.discard) {
            position.record.append(bytes.subarray(from, newline));
            observe(position.record, position.recordStart);
          }
          from = newline + 1;
          position.recordStart = start + from;
          position.record = new TitleRecordProjection();
          position.discard = false;
          if (!entry!.opaque && this.options.stopWhen?.(entry!.facts)) { entry!.settled = true; break; }
        }
        if (!entry!.settled && !position.discard) position.record.append(bytes.subarray(from));
        this.options.afterChunk?.(path);
        await new Promise<void>((resolve) => setImmediate(resolve));
        signal?.throwIfAborted();
      };
      if (cold) {
        await consume(entry.forward, entry.initialEnd);
        if (this.options.tail && !entry.settled) {
          if (entry.forward.offset >= st.size) {
            entry.tailFrom = 0;
            entry.append = { ...entry.forward, record: entry.forward.record.clone() };
          } else {
          const start = Math.max(entry.forward.offset, st.size - TAIL_BYTES);
          const bytes = Buffer.alloc(st.size - start);
          if (readSync(fd, bytes, 0, bytes.length, start) !== bytes.length) throw new Error('Session suffix shortened.');
          scanned += bytes.length;
          const raw = bytes.toString('latin1');
          const first = start === 0 ? 0 : raw.indexOf('\n') + 1;
          const last = raw.lastIndexOf('\n') + 1;
          const whole = start === 0 || first > 0;
          if (whole && last >= first) {
            let offset = start + first;
            for (const line of raw.slice(first, last).split('\n')) {
              const record = new TitleRecordProjection();
              record.append(line);
              observe(record, offset);
              offset += line.length + 1;
            }
            entry.tailFrom = start + first;
          }
          entry.append = cursor(st.size);
          entry.append.recordStart = start + last;
          entry.append.discard = !whole;
          if (whole) entry.append.record.append(raw.slice(last));
          entry.append.boundary = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 256)));
          }
        }
      }
      // Appended bytes get a bounded share; they cannot starve the original backlog.
      if (entry.append) {
        const backlogDone = entry.forward.offset >= entry.initialEnd;
        const appendDeadline = backlogDone ? deadline : Math.min(deadline, now() + ELAPSED_MS / 4);
        const appendBudget = backlogDone ? SOURCE_BYTES : Math.min(SOURCE_BYTES, scanned + SOURCE_BYTES / 4);
        while (entry.append.offset < st.size && scanned < appendBudget && now() < appendDeadline) {
          await consume(entry.append, st.size);
        }
      }
      // A record that crossed the cold EOF still belongs to the forward
      // cursor. Join its appended continuation before certifying any later row.
      if (entry.forward.offset >= entry.initialEnd && (!entry.append || entry.forward.record.bytes > 0)) entry.initialEnd = st.size;
      while (!entry.settled && entry.forward.offset < entry.initialEnd && scanned < SOURCE_BYTES && now() < deadline) {
        await consume(entry.forward, entry.initialEnd);
      }
      const current = statSync(path);
      const openedNow = fstatSync(fd);
      if (current.dev !== st.dev || current.ino !== st.ino || openedNow.dev !== st.dev || openedNow.ino !== st.ino
        || current.size < st.size || openedNow.size < st.size || !anchorsMatch(entry)) {
        this.entries.delete(path);
        return this.result(undefined, false);
      }
      // An ordinary append leaves both cursors and the last published facts intact.
      entry.size = st.size;
      const result = this.result(entry);
      if (result.complete) entry.published = structuredClone(entry.facts);
      return result;
    } catch {
      signal?.throwIfAborted();
      return this.result(entry, false);
    } finally {
      if (handle) await handle.close();
      else if (fd !== undefined) closeSync(fd);
    }
  }
}
