import type { AgentMessage } from '@cosyncing/adapter-api';

/**
 * Non-negotiable hard cap on a stashed diff body, independent of the env
 * overrides below: even a mis-set `COSYNCING_MAX_REFERENCED_DIFF_BYTES` or
 * `COSYNCING_INLINE_DIFF_CAP_BYTES` can never raise the bound past this, so the
 * client's fetch is bounded end to end (T1b R3/R4). The client uses a matching
 * ceiling, so a legitimately-clipped body always fits.
 */
export const HARD_MAX_REFERENCED_DIFF_BYTES = 4 * 1024 * 1024;

/**
 * Above this many bytes, a tool-result's aggregate diff body is moved behind a
 * content-hashed fetch reference instead of shipping inline. Measured on real
 * edit payloads: typical edits are a few KB; this cap sits above the client's
 * 400-line render cap, so anything referenced was already beyond a full render.
 * Override with COSYNCING_INLINE_DIFF_CAP_BYTES — but CLAMPED to the hard
 * ceiling, so a too-high inline cap can never let a huge diff ship inline and
 * bypass the referenced-body bound (T1b R4 finding 2).
 */
export const INLINE_DIFF_CAP = (() => {
  const raw = Number(process.env.COSYNCING_INLINE_DIFF_CAP_BYTES);
  const requested = Number.isFinite(raw) && raw > 0 ? raw : 32 * 1024;
  return Math.min(requested, HARD_MAX_REFERENCED_DIFF_BYTES);
})();

/**
 * Effective ceiling on the bytes a single referenced diff body may occupy — the
 * end-to-end fetch bound. A phone expands one diff at a time; the body is clipped
 * here at a line boundary and the reference flagged `truncated`. Default 1 MiB,
 * tunable DOWN via COSYNCING_MAX_REFERENCED_DIFF_BYTES but always clamped to
 * {@link HARD_MAX_REFERENCED_DIFF_BYTES}. Sits far above the client's 400-line
 * render cap, so realistic multi-file diffs are never clipped.
 */
export const MAX_REFERENCED_DIFF_BYTES = (() => {
  const raw = Number(process.env.COSYNCING_MAX_REFERENCED_DIFF_BYTES);
  const requested = Number.isFinite(raw) && raw > 0 ? raw : 1024 * 1024;
  return Math.min(requested, HARD_MAX_REFERENCED_DIFF_BYTES);
})();

/** A content-addressed, signed reference to a stashed diff body. */
export interface StashedDiff {
  fetchUrl: string;
  contentHash: string;
  byteSize: number;
}

/** Clip `s` to at most `maxBytes` UTF-8 bytes, cutting back to the last newline so a hunk line is
 *  never split mid-line. Binary-searches the char length whose UTF-8 encoding fits. */
function clipToLineBoundary(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(s.slice(0, mid), 'utf8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  let clipped = s.slice(0, lo);
  const nl = clipped.lastIndexOf('\n');
  if (nl > 0) clipped = clipped.slice(0, nl + 1);
  return clipped;
}

/**
 * If a tool-result's aggregate diff body exceeds [cap], move it behind a signed
 * fetch reference (produced by [stash]) and return a NEW message with the inline
 * `diff` and every `fileChanges[].diff` stripped — keeping per-file metadata for
 * the collapsed summary. Otherwise returns the message unchanged. Never mutates
 * the input (it is shared with the replay ring and every other client).
 *
 * The stashed body is the aggregate diff (the inline `diff`, or the concatenation
 * of the `fileChanges[].diff` bodies), so the client can fetch and render it as a
 * single multi-file diff on expansion. Event-time only — the body is exactly what
 * the adapter emitted, never reconstructed.
 */
export function buildDiffRefMessage(
  message: Extract<AgentMessage, { type: 'tool-result' }>,
  cap: number,
  stash: (body: string) => StashedDiff,
): AgentMessage {
  const inline = typeof message.diff === 'string' && message.diff ? message.diff : undefined;
  const fileChanges = Array.isArray(message.fileChanges) ? message.fileChanges : undefined;
  const aggregate =
    inline ??
    (fileChanges
      ? fileChanges
          .map((f) => f?.diff)
          .filter((d): d is string => typeof d === 'string' && d.length > 0)
          .join('\n')
      : undefined);
  if (!aggregate) return message;
  if (Buffer.byteLength(aggregate, 'utf8') <= cap) return message;
  // Bound what the client can ever download: clip a pathologically large aggregate at a line boundary
  // before stashing, so the stashed blob (and every fetch of it) is byte-bounded. Realistic diffs sit
  // well under the ceiling and pass through whole.
  const body = clipToLineBoundary(aggregate, MAX_REFERENCED_DIFF_BYTES);
  const truncated = body.length < aggregate.length;
  const ref = stash(body);
  const { diff: _diff, fileChanges: _fc, ...rest } = message;
  const stripped = fileChanges?.map(({ diff: _d, ...meta }) => meta);
  return {
    ...rest,
    ...(stripped ? { fileChanges: stripped } : {}),
    diffRef: {
      fetchUrl: ref.fetchUrl,
      contentHash: ref.contentHash,
      byteSize: ref.byteSize,
      lineCount: body.split('\n').length,
      ...(truncated ? { truncated: true } : {}),
    },
  };
}
