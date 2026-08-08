export class DownloadRangeError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export interface DownloadByteRange {
  start: number;
  end: number;
}

/** Parse one RFC 9110 byte range. Multipart ranges are intentionally unsupported and fail 416. */
export function parseDownloadRange(raw: string | null, size: number): DownloadByteRange | undefined {
  if (!raw) return undefined;
  if (!Number.isSafeInteger(size) || size < 0) throw new DownloadRangeError('invalid representation size');
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw.trim());
  if (!match || raw.includes(',')) throw new DownloadRangeError('only one bytes range is supported');
  const first = match[1]!;
  const last = match[2]!;
  if (!first && !last) throw new DownloadRangeError('byte range has no boundary');
  if (size === 0) throw new DownloadRangeError('empty representation has no satisfiable byte range');

  if (!first) {
    const suffix = Number(last);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new DownloadRangeError('invalid suffix byte range');
    const length = Math.min(suffix, size);
    return { start: size - length, end: size - 1 };
  }

  const start = Number(first);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) throw new DownloadRangeError('byte range starts beyond the representation');
  if (!last) return { start, end: size - 1 };
  const requestedEnd = Number(last);
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) throw new DownloadRangeError('invalid byte range end');
  return { start, end: Math.min(requestedEnd, size - 1) };
}

/** If-Range permits a partial response only for an exact strong ETag or an HTTP date that is not
 * older than the representation. Weak validators never satisfy If-Range. */
export function ifRangeMatches(raw: string | null, etag: string, mtimeMs: number): boolean {
  if (!raw) return true;
  const value = raw.trim();
  if (!value || value.startsWith('W/')) return false;
  if (value.startsWith('"')) return value === etag;
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return false;
  return Math.floor(mtimeMs / 1000) <= Math.floor(dateMs / 1000);
}
