/**
 * The file-read boundary. Every byte this adapter reads from disk comes through here.
 *
 * A lexical path check is NOT a containment check. It proves only that a STRING
 * sits under a prefix, and three things get past it:
 *
 *  - a SYMLINK, at the final component or at any directory above it, pointing
 *    anywhere on the filesystem;
 *  - a FIFO, whose `open()` blocks forever with no writer — which would hang the
 *    whole broker, not just this adapter;
 *  - a file of any SIZE, which a read that allocates the reported length turns
 *    straight into memory exhaustion.
 *
 * So containment is decided on the OPENED DESCRIPTOR rather than on the path:
 *
 *  1. The parent directory is `realpath`-resolved, which collapses every
 *     intermediate symlink, and the RESOLVED result is compared against the
 *     RESOLVED root. A symlinked directory in the middle of the path cannot
 *     survive this.
 *  2. The file is opened `O_NOFOLLOW | O_NONBLOCK`. `O_NOFOLLOW` refuses a
 *     symlink at the final component (the one step 1 cannot see, because
 *     `dirname` stops above it). `O_NONBLOCK` is what makes a FIFO return
 *     immediately instead of blocking.
 *  3. `fstat` runs on the DESCRIPTOR — not on the path, which could be swapped
 *     between the check and the open — and anything that is not a regular file
 *     is refused.
 *  4. Reads are bounded by an explicit per-kind cap, and a read that hits its cap
 *     REPORTS the truncation. A silently short transcript is worse than a stated
 *     one: it looks like a conversation that ended.
 *
 * Every cap below is a measured maximum times a wide margin, so a real file never
 * trips one. The margins are stated at each constant.
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  type Dir,
} from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { AgyTraceSink } from './store.ts';

// ── Caps ─────────────────────────────────────────────────────────────────────
//
// Measured on the real store, 2026-08-25 (29 transcripts, 32 conversations):
//   transcript.jsonl        largest    665,613 B
//   transcript_full.jsonl   largest  1,001,337 B
//   longest single line                 77,711 B
//   conversation_metadata.json          20,044 B
//   settings.json                        5,908 B
//   available_models.json                3,656 B
//   largest settlement message          11,545 B
//   largest settlement inbox                19 entries

/** ~32× the largest real transcript. Big enough that no genuine conversation truncates. */
export const AGY_TRANSCRIPT_MAX_BYTES = 32 * 1024 * 1024;

/** Per-drain ceiling on the live tail, so one enormous append cannot be slurped at once.
 *  The offset advances by what was read, so a larger append is consumed across drains. */
export const AGY_TAIL_READ_MAX_BYTES = 8 * 1024 * 1024;

/** ~400× the observed metadata cache. It scales with conversation count, so the margin is wide. */
export const AGY_METADATA_MAX_BYTES = 8 * 1024 * 1024;

/** ~170× `settings.json` and ~280× the model catalog. Both are small, fixed-shape files. */
export const AGY_SMALL_JSON_MAX_BYTES = 1024 * 1024;

/** ~90× the largest observed settlement message. */
export const AGY_SETTLEMENT_MAX_BYTES = 1024 * 1024;

/** ~27× the largest observed inbox. Bounds the DIRECTORY, which a byte cap cannot. */
export const AGY_SETTLEMENT_MAX_FILES = 512;

/**
 * Ceiling on ONE newline-delimited line, shared by the transcript tail and the
 * child's NDJSON stdout. ~13× the largest line in the real corpus (77,711 B).
 *
 * A line-oriented reader that buffers until a newline arrives has no bound at
 * all if the newline never comes: a writer that emits a gigabyte without one
 * grows the buffer by a gigabyte. Past this, the accumulation is not a line
 * being assembled — it is a stream that has lost framing, and it is dropped
 * rather than held.
 */
export const AGY_MAX_LINE_BYTES = 1024 * 1024;

/** Why a read was refused. Each value names a distinct, real attack or fault. */
export type AgyReadRefusal =
  | 'missing'
  | 'escapes-root'
  | 'symlink'
  | 'not-regular-file';

export interface AgyReadResult {
  text: string;
  /** The cap bit: `text` is a PREFIX of the file. Callers must say so, never render it as whole. */
  truncated: boolean;
  /** Bytes actually read into `text`. */
  bytesRead: number;
  /** The descriptor's reported size at read time. */
  size: number;
}

/** A bounded read, UNDECODED. The tail path stays on this all the way to the framer. */
export interface AgyByteReadResult {
  bytes: Buffer;
  /** The cap bit: `bytes` is a PREFIX of what was available. */
  truncated: boolean;
  /** Bytes actually read. Always the true count — never a re-encoded string length. */
  bytesRead: number;
  /** The descriptor's reported size at read time. */
  size: number;
}

/** `\n`. Framing is done on this byte, never on a decoded character. */
const NEWLINE = 0x0a;

export function isAgyReadRefusal(value: unknown): value is AgyReadRefusal {
  return value === 'missing' || value === 'escapes-root' || value === 'symlink' || value === 'not-regular-file';
}

/** An opened, validated descriptor. The caller MUST close it. */
export interface AgyOpenFile {
  fd: number;
  size: number;
}

/**
 * Open a regular file proven to live inside `rootDir`, without following symlinks
 * and without blocking. Returns a refusal rather than throwing, so a hostile or
 * broken path degrades to a stated absence instead of an adapter crash.
 */
export function openContainedRegularFile(
  rootDir: string,
  path: string,
  trace?: AgyTraceSink,
): AgyOpenFile | AgyReadRefusal {
  let resolvedRoot: string;
  try {
    resolvedRoot = realpathSync(resolve(rootDir));
  } catch {
    return 'missing';
  }

  // Step 1: collapse every intermediate symlink, then check the RESOLVED parent.
  // A lexical check on the unresolved string cannot see a symlinked directory.
  let resolvedParent: string;
  try {
    resolvedParent = realpathSync(dirname(resolve(path)));
  } catch {
    return 'missing';
  }
  if (!isWithin(resolvedRoot, resolvedParent)) {
    trace?.({ op: 'read-refused-escapes-root', detail: `${path} resolves outside ${rootDir}` });
    return 'escapes-root';
  }

  // Step 2: O_NOFOLLOW refuses a symlink at the FINAL component — the one the
  // parent resolution above cannot inspect. O_NONBLOCK is what stops a FIFO from
  // hanging the broker on open().
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') {
      trace?.({ op: 'read-refused-symlink', detail: `${path} is a symlink` });
      return 'symlink';
    }
    // ENXIO is a FIFO opened for reading with no writer on some platforms.
    if (code === 'ENXIO') {
      trace?.({ op: 'read-refused-not-regular', detail: `${path} is not a regular file (${code})` });
      return 'not-regular-file';
    }
    return 'missing';
  }

  // Step 3: stat the DESCRIPTOR, never the path — the path could be swapped
  // between a check and an open, and only the descriptor is the thing we hold.
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      closeSync(fd);
      trace?.({ op: 'read-refused-not-regular', detail: `${path} is not a regular file` });
      return 'not-regular-file';
    }
    return { fd, size: stat.size };
  } catch {
    closeSync(fd);
    return 'missing';
  }
}

/**
 * Read a validated file as UTF-8, bounded.
 *
 * Whole-file readers may decode here because they read from offset 0 in ONE
 * range: there is no earlier or later range whose boundary could fall inside a
 * character. A cap CUT can still land mid-character, so the incomplete trailing
 * sequence is dropped rather than decoded into U+FFFD — this reader must never
 * be the thing that introduces a replacement character.
 */
export function readContainedText(
  rootDir: string,
  path: string,
  maxBytes: number,
  trace?: AgyTraceSink,
): AgyReadResult | AgyReadRefusal {
  const read = readContainedBytes(rootDir, path, 0, maxBytes, trace);
  if (isAgyReadRefusal(read)) return read;
  const whole = read.truncated ? read.bytes.subarray(0, completeUtf8Length(read.bytes)) : read.bytes;
  return {
    text: whole.toString('utf8'),
    truncated: read.truncated,
    bytesRead: read.bytesRead,
    size: read.size,
  };
}

/**
 * Read a validated file up to its LAST COMPLETE LINE, bounded. Returns BYTES.
 *
 * The newline boundary is what keeps the history replay and the live tail from
 * overlapping: a partial trailing line stays out of history and is picked up
 * whole by the tail once its newline lands.
 *
 * The last newline is located in the BYTES, and `boundary` is a real byte count
 * rather than the re-encoded length of a decoded string. Those differ exactly
 * when decoding lost information, which is the case this whole path exists to
 * rule out.
 */
export function readContainedThroughLastNewline(
  rootDir: string,
  path: string,
  maxBytes: number,
  trace?: AgyTraceSink,
): (AgyByteReadResult & { boundary: number }) | AgyReadRefusal {
  const read = readContainedBytes(rootDir, path, 0, maxBytes, trace);
  if (isAgyReadRefusal(read)) return read;
  const lastNewline = read.bytes.lastIndexOf(NEWLINE);
  const boundary = lastNewline >= 0 ? lastNewline + 1 : 0;
  return { ...read, bytes: read.bytes.subarray(0, boundary), boundary };
}

/**
 * Read `[from, to)` from a validated file, bounded per read. Returns RAW BYTES.
 *
 * Deliberately NOT decoded. This is the reader the live tail drains through, one
 * bounded range per drain, and consecutive ranges are cut at an arbitrary byte —
 * so a multibyte character routinely straddles the boundary. Decoding each range
 * on its own turned such a character into U+FFFD on BOTH sides, which corrupted
 * the line and, worse, changed its measured length: re-encoding the replacement
 * characters charged 14 bytes for an 8-byte line, and every `byteOffset` later in
 * that drain drifted by the difference. Those offsets are the queued-send fence
 * that decides whether a transcript line delivers a prompt this connection sent,
 * so the drift did not merely garble text — it undermined ownership.
 *
 * Bytes are joined and framed downstream; decoding happens only once a whole line
 * is in hand.
 */
export function readContainedRange(
  rootDir: string,
  path: string,
  from: number,
  to: number,
  maxBytes: number,
  trace?: AgyTraceSink,
): AgyByteReadResult | AgyReadRefusal {
  return readContainedBytes(rootDir, path, from, Math.min(maxBytes, Math.max(0, to - from)), trace);
}

/** The one place bytes actually come off disk. Every reader above is a view on this. */
export function readContainedBytes(
  rootDir: string,
  path: string,
  from: number,
  maxBytes: number,
  trace?: AgyTraceSink,
): AgyByteReadResult | AgyReadRefusal {
  const opened = openContainedRegularFile(rootDir, path, trace);
  if (isAgyReadRefusal(opened)) return opened;
  try {
    const available = Math.max(0, opened.size - from);
    const wanted = Math.min(available, maxBytes);
    if (wanted === 0) {
      return { bytes: Buffer.alloc(0), truncated: false, bytesRead: 0, size: opened.size };
    }
    // Allocation is bounded by the CAP, never by the file's reported size — that
    // is the whole point: a 40 GiB file must not become a 40 GiB Buffer.
    const buffer = Buffer.alloc(wanted);
    const bytesRead = readSync(opened.fd, buffer, 0, wanted, from);
    const truncated = available > wanted;
    if (truncated) {
      trace?.({
        op: 'read-truncated',
        detail: `${path}: read ${wanted} of ${available} bytes (cap ${maxBytes})`,
      });
    }
    return { bytes: buffer.subarray(0, bytesRead), truncated, bytesRead, size: opened.size };
  } finally {
    closeSync(opened.fd);
  }
}

/**
 * Length of the longest prefix of `bytes` that ends on a COMPLETE UTF-8 sequence.
 *
 * Used only where a cap cut the read short. UTF-8 is self-synchronizing: a lead
 * byte states its own sequence length, and continuation bytes are `10xxxxxx`, so
 * walking back at most three bytes finds the last complete character.
 */
export function completeUtf8Length(bytes: Buffer): number {
  const limit = Math.min(3, bytes.length);
  for (let back = 0; back < limit; back += 1) {
    const index = bytes.length - 1 - back;
    const byte = bytes[index]!;
    if ((byte & 0xc0) === 0x80) continue; // a continuation byte; keep walking back
    const width = byte < 0x80 ? 1 : (byte & 0xe0) === 0xc0 ? 2 : (byte & 0xf0) === 0xe0 ? 3 : 4;
    // The character is whole only if all of its bytes are present.
    return index + width <= bytes.length ? bytes.length : index;
  }
  return bytes.length;
}

/**
 * List a directory inside the root, bounded by an ENTRY count.
 *
 * Enumerated ITERATIVELY, and this is the whole point. `readdirSync` materializes
 * every name in the directory before the caller can look at any of them, so
 * slicing its result caps the RETURNED array while the filesystem work and the
 * peak memory stay proportional to the directory — which is the cost a cap on a
 * directory exists to bound. A million-entry inbox would be fully read and fully
 * allocated, and only then trimmed to 512.
 *
 * `opendirSync` + `readSync` stops at `maxEntries + 1` instead. The `+ 1` is the
 * only extra entry ever read, and it is what distinguishes "exactly at the cap"
 * from "over it" so truncation can be REPORTED rather than guessed. The handle is
 * closed on every path, including the throwing one.
 */
export function listContainedDirectory(
  rootDir: string,
  path: string,
  maxEntries: number,
  trace?: AgyTraceSink,
): { names: string[]; truncated: boolean } | AgyReadRefusal {
  let resolvedRoot: string;
  let resolvedDir: string;
  try {
    resolvedRoot = realpathSync(resolve(rootDir));
    resolvedDir = realpathSync(resolve(path));
  } catch {
    return 'missing';
  }
  if (!isWithin(resolvedRoot, resolvedDir)) {
    trace?.({ op: 'read-refused-escapes-root', detail: `${path} resolves outside ${rootDir}` });
    return 'escapes-root';
  }

  let dir: Dir;
  try {
    dir = opendirSync(resolvedDir);
  } catch {
    return 'missing';
  }
  const names: string[] = [];
  let truncated = false;
  try {
    // Read at most one PAST the cap: enough to know the directory is bigger,
    // never enough for its size to drive this loop.
    while (names.length <= maxEntries) {
      const entry = dir.readSync();
      if (entry === null) break;
      names.push(entry.name);
    }
    if (names.length > maxEntries) {
      truncated = true;
      names.length = maxEntries;
    }
  } catch {
    return 'missing';
  } finally {
    try {
      dir.closeSync();
    } catch {
      /* the handle is going away with this scope either way */
    }
  }

  if (truncated) {
    trace?.({
      op: 'directory-truncated',
      detail: `${path}: stopped after ${maxEntries} entries; the directory holds more`,
    });
  }
  return { names, truncated };
}

/** Prefix containment on already-resolved paths, separator-aware so `…-evil` is not a child of `…`. */
export function isWithin(resolvedRoot: string, resolvedCandidate: string): boolean {
  if (resolvedCandidate === resolvedRoot) return true;
  return resolvedCandidate.startsWith(resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep);
}

// ── Line framing ─────────────────────────────────────────────────────────────

/** One framed line, kept or dropped. `bytes` is what it occupied, so byte offsets stay honest either way. */
export interface AgyFrame {
  /** The line. Empty when `dropped` — a dropped frame's text is deliberately not retained. */
  text: string;
  /**
   * Bytes the line occupied in the ORIGINAL stream, excluding its newline.
   *
   * Taken from the raw byte slice, never from re-encoding `text`. Those two agree
   * only while decoding is lossless, and the whole reason this framer is
   * byte-native is that at a chunk boundary it is not.
   */
  bytes: number;
  dropped: boolean;
  /** An over-cap line, or the tail of one already cut. */
  reason?: 'oversized' | 'resync';
}

/**
 * Assemble newline-delimited frames from a text stream, bounding EVERY frame.
 *
 * The bug this exists to make unrepresentable: checking the cap only on the
 * unterminated remainder. A line larger than the cap that arrives COMPLETE — in
 * one chunk, or split across chunks that happen to end on its newline — is
 * consumed by the framing loop before any check runs. That enforces the
 * advertised cap on exactly the case that does not matter and skips the one that
 * does, so whether the cap holds depends on how the writer happened to chunk its
 * bytes. Here the cap is applied as each frame CLOSES, which no chunking can
 * route around.
 *
 * Accounting is in UTF-8 BYTES, never code units: a cap documented in bytes and
 * compared against `String.length` admits multibyte text at up to ~3× the stated
 * limit.
 *
 * A dropped frame is reported rather than silently skipped, and the framer then
 * RESYNCS — the remainder of a cut line is discarded up to its newline instead of
 * being parsed as a line of its own, which would report a headless fragment as
 * malformed input and name the wrong cause.
 */
export class AgyLineFramer {
  private buf: Buffer = Buffer.alloc(0);
  /** An over-cap line was cut; discard bytes until its newline arrives. */
  private resyncing = false;

  constructor(private readonly maxBytes: number) {}

  /** Bytes held in the incomplete-frame buffer. Never exceeds the cap. */
  get buffered(): number {
    return this.buf.length;
  }

  /**
   * Feed RAW BYTES; get back every frame they completed, in order.
   *
   * Framing on the byte `0x0A` is safe precisely because UTF-8 is
   * self-synchronizing: every byte of a multibyte sequence has its high bit set,
   * so `0x0A` can only ever be an actual newline and never a fragment of some
   * other character. That is what lets a chunk boundary fall anywhere at all —
   * a half-delivered character simply stays in `buf` until the rest arrives.
   *
   * Decoding happens ONLY on a completed, retained frame, where the bytes are a
   * whole line by construction.
   */
  push(chunk: Buffer): AgyFrame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames: AgyFrame[] = [];

    let start = 0;
    let nl: number;
    while ((nl = this.buf.indexOf(NEWLINE, start)) !== -1) {
      const raw = this.buf.subarray(start, nl);
      start = nl + 1;
      const bytes = raw.length;
      if (this.resyncing) {
        // The tail of a line already cut. Its head is gone, so it is not a line.
        this.resyncing = false;
        frames.push({ text: '', bytes, dropped: true, reason: 'resync' });
        continue;
      }
      if (bytes > this.maxBytes) {
        frames.push({ text: '', bytes, dropped: true, reason: 'oversized' });
        continue;
      }
      frames.push({ text: raw.toString('utf8'), bytes, dropped: false });
    }
    // Copy rather than retain a view: `subarray` shares the parent's memory, so a
    // long-lived remainder would pin every chunk it was ever concatenated with.
    this.buf = start === 0 ? this.buf : Buffer.from(this.buf.subarray(start));

    // The remainder has no newline yet. Once it alone passes the cap this frame
    // can never be legal however it ends, so cut it now rather than hold it.
    if (this.buf.length > this.maxBytes) {
      const bytes = this.buf.length;
      this.buf = Buffer.alloc(0);
      this.resyncing = true;
      frames.push({ text: '', bytes, dropped: true, reason: 'oversized' });
    }
    return frames;
  }

  /** Drop everything buffered — used when the underlying file is re-baselined. */
  reset(): void {
    this.buf = Buffer.alloc(0);
    this.resyncing = false;
  }
}

// ── UTF-8 byte budgets ───────────────────────────────────────────────────────

/**
 * Truncate to a UTF-8 BYTE budget without ever splitting a code point.
 *
 * `String.prototype.slice` counts UTF-16 code units, so slicing to a byte cap
 * both overshoots the budget — roughly 3× on CJK, 4× on emoji — and can cut
 * between the halves of a surrogate pair, producing a lone surrogate that is not
 * valid UTF-8 and that travels all the way to the client.
 *
 * `for…of` walks CODE POINTS, so a cut can never land inside one. The result is
 * always valid UTF-8 and always within budget.
 */
export function truncateToUtf8Bytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: '', truncated: text.length > 0 };
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };

  let used = 0;
  let out = '';
  for (const codePoint of text) {
    const width = Buffer.byteLength(codePoint, 'utf8');
    if (used + width > maxBytes) break;
    out += codePoint;
    used += width;
  }
  return { text: out, truncated: true };
}
