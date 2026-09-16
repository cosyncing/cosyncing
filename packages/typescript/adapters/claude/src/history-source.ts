import { open, stat, type FileHandle } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';

const CHUNK_BYTES = 256 * 1024;
const GUARD_BYTES = 4096;
const MAX_ENTRY_BYTES = 192 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
// Native progress/metadata rows count too, not just visible transcript messages.
const MAX_RECORDS = 100_000;
const IDLE_MS = 120_000;

type SourceStat = { dev: bigint; ino: bigint; size: number; mtimeNs: bigint; ctimeNs: bigint };
function sourceStat(value: BigIntStats): SourceStat {
  const size = Number(value.size);
  if (!Number.isSafeInteger(size)) throw new Error('History source is too large');
  return { dev: value.dev, ino: value.ino, size, mtimeNs: value.mtimeNs, ctimeNs: value.ctimeNs };
}

type Snapshot = {
  path: string;
  stat: SourceStat;
  boundary: number;
  lines: any[];
  head: Buffer;
  edge: Buffer;
  weight: number;
};

// This is a working set, not a second archive. Eviction drops parsed native
// records only; connections, live streams, and ownership are independent.
const retained = new Map<JsonlHistorySource, { weight: number; timer: ReturnType<typeof setTimeout> }>();
let retainedBytes = 0;

function release(source: JsonlHistorySource): void {
  const previous = retained.get(source);
  if (!previous) return;
  retained.delete(source);
  retainedBytes -= previous.weight;
  clearTimeout(previous.timer);
  source.forget();
}

function retain(source: JsonlHistorySource, snapshot: Snapshot): void {
  release(source);
  if (snapshot.weight > MAX_ENTRY_BYTES || snapshot.lines.length > MAX_RECORDS) return;
  while (retained.size >= 4 || retainedBytes + snapshot.weight > MAX_TOTAL_BYTES) {
    const oldest = retained.keys().next().value;
    if (!oldest) break;
    release(oldest);
  }
  source.remember(snapshot);
  const timer = setTimeout(() => release(source), IDLE_MS);
  timer.unref?.();
  retained.set(source, { weight: snapshot.weight, timer });
  retainedBytes += snapshot.weight;
}

const sameFile = (a: SourceStat, b: SourceStat) => a.dev === b.dev && a.ino === b.ino;
const sameRevision = (a: SourceStat, b: SourceStat) => sameFile(a, b)
  && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

async function bytesAt(file: FileHandle, offset: number, size: number): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  let filled = 0;
  while (filled < size) {
    const read = await file.read(bytes, filled, size - filled, offset + filled);
    if (!read.bytesRead) throw new Error('History source changed during read');
    filled += read.bytesRead;
  }
  return bytes;
}

/** Parsed complete native records, never normalized messages. Replaying still
 * rebuilds mapper state, tool enrichment, and external-file overlays exactly as
 * a cold read does. An append reuses parsing of the immutable JSONL prefix;
 * replacement, shrink, same-size edits, or changed prefix/edge rebuild it.
 * As with native tail readers, append continuation assumes the writer does not
 * edit an interior prefix while also growing the same file. */
export class JsonlHistorySource {
  private snapshot?: Snapshot;
  private flight?: Promise<{ lines: any[]; boundary: number }>;
  private closed = false;
  /** Content-free work counters for deterministic performance tests. */
  lastRead = { bytes: 0, records: 0, reusedRecords: 0 };

  forget(): void { this.snapshot = undefined; }
  remember(snapshot: Snapshot): void { this.snapshot = snapshot; }
  close(): void { this.closed = true; release(this); }

  read(path: string, parse: (raw: string, offset: number) => any): Promise<{ lines: any[]; boundary: number }> {
    if (this.flight) return this.flight;
    const flight = this.readSnapshot(path, parse).finally(() => { this.flight = undefined; });
    this.flight = flight;
    return flight;
  }

  private async readSnapshot(path: string, parse: (raw: string, offset: number) => any) {
    this.lastRead = { bytes: 0, records: 0, reusedRecords: 0 };
    let file: FileHandle;
    try { file = await open(path, 'r'); } catch (error) {
      release(this);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { lines: [], boundary: 0 };
      throw error;
    }
    try {
      const before = sourceStat(await file.stat({ bigint: true }));
      const old = this.snapshot?.path === path ? this.snapshot : undefined;
      let guarded = false;
      if (old && sameFile(old.stat, before) && before.size >= old.boundary) {
        const head = await bytesAt(file, 0, old.head.length);
        const edge = await bytesAt(file, old.boundary - old.edge.length, old.edge.length);
        this.lastRead.bytes += head.length + edge.length;
        guarded = head.equals(old.head) && edge.equals(old.edge);
      }
      if (old && guarded && sameRevision(old.stat, before)) {
        this.lastRead.reusedRecords = old.lines.length;
        if (!this.closed) retain(this, old);
        return { lines: old.lines, boundary: old.boundary };
      }
      const append = old !== undefined && guarded && before.size > old.stat.size;
      const lines: any[] = append ? old!.lines.slice() : [];
      let boundary = append ? old!.boundary : 0;
      let weight = append ? old!.weight : 0;
      this.lastRead.reusedRecords = lines.length;
      const chunks: Buffer[] = [];
      let pendingBytes = 0;
      let lineStart = boundary;
      for (let offset = boundary; offset < before.size;) {
        const chunk = await bytesAt(file, offset, Math.min(CHUNK_BYTES, before.size - offset));
        this.lastRead.bytes += chunk.length;
        let start = 0;
        for (let nl = chunk.indexOf(10); nl !== -1; nl = chunk.indexOf(10, start)) {
          const part = chunk.subarray(start, nl);
          const raw = chunks.length ? Buffer.concat([...chunks, part], pendingBytes + part.length) : part;
          const record = parse(raw.toString('utf8'), lineStart);
          if (record != null) {
            lines.push(record);
            // Native text plus a per-record object/array allowance. Row count
            // is bounded independently so tiny records cannot evade retention.
            weight += raw.length + 1024;
          }
          this.lastRead.records += 1;
          chunks.length = 0;
          pendingBytes = 0;
          boundary = offset + nl + 1;
          lineStart = boundary;
          start = nl + 1;
        }
        if (start < chunk.length) {
          const remaining = Buffer.from(chunk.subarray(start));
          chunks.push(remaining);
          pendingBytes += remaining.length;
        }
        offset += chunk.length;
        // File reads yield on Bun/Node; an explicit turn also bounds parsing
        // even when the filesystem promise resolves from a warm cache.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const after = sourceStat(await file.stat({ bigint: true }));
      const current = sourceStat(await stat(path, { bigint: true }));
      if (!sameFile(before, current) || after.size < before.size
        || (after.size === before.size && !sameRevision(before, after))) {
        release(this);
        throw new Error('History source changed during read');
      }
      const head = await bytesAt(file, 0, Math.min(boundary, GUARD_BYTES));
      const edge = await bytesAt(file, Math.max(0, boundary - GUARD_BYTES), Math.min(boundary, GUARD_BYTES));
      if (!this.closed) retain(this, { path, stat: before, boundary, lines, head, edge, weight });
      return { lines, boundary };
    } finally { await file.close(); }
  }
}
