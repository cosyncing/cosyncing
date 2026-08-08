/**
 * Shared, provider-independent construction of the canonical {@link ToolSemantic}
 * envelope.
 *
 * Every adapter maps its own native event shape, but the *bounds* and the
 * clamping rules live here exactly once, so retained wire bytes are identical
 * whichever provider produced the event and a new adapter cannot invent a looser
 * limit. Nothing in this module inspects a native tool name — callers decide the
 * family, this module only normalizes and bounds the fields.
 *
 * Bound budget for one tool message (worst case, all fields present):
 *   stdout 16 KiB + stderr 16 KiB + preview 16 KiB
 *   + 20 groups × (10 matches × 512 B) ≈ 100 KiB search
 *   + 10 web results × ~1.2 KiB ≈ 12 KiB
 * A single semantic is then clipped as a whole to TOOL_SEMANTIC_MAX_BYTES so no
 * combination can exceed one bounded frame.
 */
import type {
  ToolCommandSemantic,
  ToolCommandState,
  ToolFileReadSemantic,
  ToolOutputStream,
  ToolReadUnavailableReason,
  ToolSearchGroup,
  ToolSearchMatch,
  ToolSearchSemantic,
  ToolSemantic,
  ToolWebResult,
  ToolWebSemantic,
} from '@cosyncing/protocol';

/** Retained bytes per separately identified command stream, tail-first. */
export const COMMAND_STREAM_MAX_BYTES = 16 * 1024;
/** Retained lines of a file-read preview. */
export const FILE_PREVIEW_MAX_LINES = 200;
/** Retained bytes of a file-read preview. */
export const FILE_PREVIEW_MAX_BYTES = 16 * 1024;
/** Retained per-file groups in one search result. */
export const SEARCH_MAX_GROUPS = 20;
/** Retained matches inside one group. */
export const SEARCH_MAX_MATCHES_PER_GROUP = 10;
/** Retained bytes of one match snippet. */
export const SEARCH_SNIPPET_MAX_BYTES = 512;
/** Retained web results in one lookup. */
export const WEB_MAX_RESULTS = 10;
/** Retained characters of a web result title. */
export const WEB_TITLE_MAX_CHARS = 200;
/** Retained characters of a URL (result or fetched page). */
export const URL_MAX_CHARS = 500;
/** Retained bytes of a web result snippet. */
export const WEB_SNIPPET_MAX_BYTES = 512;
/** Retained characters of a command line. */
export const COMMAND_MAX_CHARS = 4 * 1024;
/** Retained characters of a path, cwd, query, or scope. */
export const PATH_MAX_CHARS = 1024;
/**
 * Whole-envelope ceiling. Reached only by a pathological combination; the
 * builder drops optional detail newest-cost-first rather than shipping an
 * unbounded frame, and always keeps the truncation flags that prove it did.
 */
export const TOOL_SEMANTIC_MAX_BYTES = 64 * 1024;

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** Clip to at most `maxBytes` UTF-8 bytes from the head, never splitting a code point. */
export function clipHeadBytes(value: string, maxBytes: number): string {
  if (utf8Length(value) <= maxBytes) return value;
  const buffer = Buffer.from(value, 'utf8').subarray(0, maxBytes);
  // Decoding a mid-code-point cut yields U+FFFD; drop the trailing replacement.
  const decoded = buffer.toString('utf8');
  return decoded.endsWith('�') ? decoded.slice(0, -1) : decoded;
}

/** Clip to at most `maxBytes` UTF-8 bytes from the tail, never splitting a code point. */
export function clipTailBytes(value: string, maxBytes: number): string {
  if (utf8Length(value) <= maxBytes) return value;
  const buffer = Buffer.from(value, 'utf8');
  const decoded = buffer.subarray(buffer.length - maxBytes).toString('utf8');
  return decoded.startsWith('�') ? decoded.slice(1) : decoded;
}

function trimmed(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function nonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

/**
 * A bounded tail buffer for output that arrives incrementally.
 *
 * `append` costs O(fragment) — the retained tail is only re-clipped when it
 * actually exceeds the bound, and the clip touches at most `maxBytes`, never the
 * whole accumulated history. `replace` is for native sources that redeliver the
 * complete accumulated output each frame: it takes a bounded tail slice instead
 * of rescanning, so per-frame work stays proportional to the bound.
 */
export class BoundedOutputTail {
  constructor(private readonly maxBytes: number = COMMAND_STREAM_MAX_BYTES) {}

  private tail = '';
  private droppedBytes = 0;
  private seenBytes = 0;

  /** Appends one newly produced fragment. */
  append(fragment: string): void {
    if (!fragment) return;
    this.seenBytes += utf8Length(fragment);
    this.tail += fragment;
    const size = utf8Length(this.tail);
    if (size <= this.maxBytes) return;
    this.droppedBytes += size - this.maxBytes;
    this.tail = clipTailBytes(this.tail, this.maxBytes);
  }

  /** Replaces the buffer with the bounded tail of a redelivered whole output. */
  replace(whole: string): void {
    const size = utf8Length(whole);
    this.seenBytes = size;
    if (size <= this.maxBytes) {
      this.droppedBytes = 0;
      this.tail = whole;
      return;
    }
    this.droppedBytes = size - this.maxBytes;
    this.tail = clipTailBytes(whole, this.maxBytes);
  }

  /** The current bounded stream, or undefined when nothing was produced. */
  stream(): ToolOutputStream | undefined {
    if (!this.tail && this.droppedBytes === 0) return undefined;
    return {
      text: this.tail,
      ...(this.droppedBytes > 0 ? { truncated: true } : {}),
      ...(this.seenBytes > 0 ? { totalBytes: this.seenBytes } : {}),
    };
  }
}

/** Builds a bounded stream from one already-complete output blob. */
export function boundedStream(
  value: unknown,
  maxBytes: number = COMMAND_STREAM_MAX_BYTES,
): ToolOutputStream | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const tail = new BoundedOutputTail(maxBytes);
  tail.replace(value);
  return tail.stream();
}

const COMMAND_STATES: readonly ToolCommandState[] = [
  'running',
  'completed',
  'failed',
  'interrupted',
  'unknown',
];

/** Normalizes an adapter-supplied lifecycle, failing closed to `unknown`. */
export function commandState(value: unknown): ToolCommandState {
  return COMMAND_STATES.includes(value as ToolCommandState)
    ? (value as ToolCommandState)
    : 'unknown';
}

/** Builds a bounded command semantic, or undefined without a real command line. */
export function commandSemantic(input: {
  command: unknown;
  cwd?: unknown;
  state?: unknown;
  stdout?: ToolOutputStream | undefined;
  stderr?: ToolOutputStream | undefined;
}): ToolCommandSemantic | undefined {
  const command = trimmed(input.command, COMMAND_MAX_CHARS);
  if (!command) return undefined;
  const cwd = trimmed(input.cwd, PATH_MAX_CHARS);
  return {
    kind: 'command',
    command,
    ...(cwd ? { cwd } : {}),
    state: commandState(input.state),
    ...(input.stdout ? { stdout: input.stdout } : {}),
    ...(input.stderr ? { stderr: input.stderr } : {}),
  };
}

/** Bounds a preview body to the line and byte caps, head-first. */
export function boundedPreview(value: unknown): {
  preview?: string;
  previewTruncated?: boolean;
} {
  if (typeof value !== 'string' || !value) return {};
  const lines = value.split('\n');
  let preview = lines.length > FILE_PREVIEW_MAX_LINES
    ? lines.slice(0, FILE_PREVIEW_MAX_LINES).join('\n')
    : value;
  const clipped = clipHeadBytes(preview, FILE_PREVIEW_MAX_BYTES);
  const truncated = clipped !== value;
  preview = clipped;
  return { preview, ...(truncated ? { previewTruncated: true } : {}) };
}

/** Builds a bounded file-read semantic, or undefined without a path. */
export function fileReadSemantic(input: {
  path: unknown;
  startLine?: unknown;
  preview?: unknown;
  totalLines?: unknown;
  previewTruncated?: boolean;
  unavailable?: ToolReadUnavailableReason;
}): ToolFileReadSemantic | undefined {
  const path = trimmed(input.path, PATH_MAX_CHARS);
  if (!path) return undefined;
  const bounded = input.unavailable ? {} : boundedPreview(input.preview);
  const startLine = nonNegativeInt(input.startLine);
  const totalLines = nonNegativeInt(input.totalLines);
  const previewTruncated = bounded.previewTruncated === true
    || (input.previewTruncated === true && bounded.preview !== undefined);
  return {
    kind: 'file-read',
    path,
    ...(startLine !== undefined && startLine > 0 ? { startLine } : {}),
    ...(bounded.preview !== undefined ? { preview: bounded.preview } : {}),
    ...(totalLines !== undefined ? { totalLines } : {}),
    ...(previewTruncated ? { previewTruncated: true } : {}),
    ...(input.unavailable ? { unavailable: input.unavailable } : {}),
  };
}

/** Bounds one raw match into a snippet. */
function boundedMatch(raw: unknown): ToolSearchMatch | undefined {
  if (raw == null) return undefined;
  const source = typeof raw === 'string' ? { text: raw } : (raw as Record<string, unknown>);
  const text = typeof source.text === 'string' ? source.text : undefined;
  if (text === undefined) return undefined;
  const clipped = clipHeadBytes(text, SEARCH_SNIPPET_MAX_BYTES);
  const line = nonNegativeInt(source.line);
  return {
    ...(line !== undefined && line > 0 ? { line } : {}),
    text: clipped,
    ...(clipped !== text ? { truncated: true } : {}),
  };
}

/** Bounds one raw group into per-file matches. */
export function searchGroup(input: {
  path: unknown;
  matchCount?: unknown;
  matches?: readonly unknown[];
}): ToolSearchGroup | undefined {
  const path = trimmed(input.path, PATH_MAX_CHARS);
  if (!path) return undefined;
  const source = Array.isArray(input.matches) ? input.matches : [];
  const matches: ToolSearchMatch[] = [];
  for (const raw of source) {
    if (matches.length >= SEARCH_MAX_MATCHES_PER_GROUP) break;
    const match = boundedMatch(raw);
    if (match) matches.push(match);
  }
  const dropped = source.length > matches.length;
  const matchCount = nonNegativeInt(input.matchCount);
  return {
    path,
    ...(matchCount !== undefined ? { matchCount } : {}),
    ...(matches.length ? { matches } : {}),
    ...(dropped ? { truncated: true } : {}),
  };
}

/** Builds a bounded search semantic. Always defined: an empty result is a truthful state. */
export function searchSemantic(input: {
  query?: unknown;
  scope?: unknown;
  matchCount?: unknown;
  fileCount?: unknown;
  groups?: readonly (ToolSearchGroup | undefined)[];
}): ToolSearchSemantic {
  const source = (input.groups ?? []).filter((group): group is ToolSearchGroup => !!group);
  const groups = source.slice(0, SEARCH_MAX_GROUPS);
  const query = trimmed(input.query, PATH_MAX_CHARS);
  const scope = trimmed(input.scope, PATH_MAX_CHARS);
  const matchCount = nonNegativeInt(input.matchCount);
  const fileCount = nonNegativeInt(input.fileCount);
  return {
    kind: 'search',
    ...(query ? { query } : {}),
    ...(scope ? { scope } : {}),
    ...(matchCount !== undefined ? { matchCount } : {}),
    ...(fileCount !== undefined ? { fileCount } : {}),
    ...(groups.length ? { groups } : {}),
    ...(source.length > groups.length ? { truncated: true } : {}),
  };
}

/** Bounds one raw web result, or undefined without a URL.
 *
 *  Every one of the three text fields can be clipped here, so each clip is
 *  recorded: a 4 KiB snippet reduced to {@link WEB_SNIPPET_MAX_BYTES} must not
 *  reach the client looking like the whole snippet the source published. */
export function webResult(raw: unknown): ToolWebResult | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const source = raw as Record<string, unknown>;
  const rawUrl = typeof source.url === 'string' ? source.url.trim() : '';
  const url = trimmed(source.url, URL_MAX_CHARS);
  if (!url) return undefined;
  const rawTitle = typeof source.title === 'string' ? source.title.trim() : '';
  const title = trimmed(source.title, WEB_TITLE_MAX_CHARS);
  const rawSnippet = typeof source.snippet === 'string' ? source.snippet.trim() : '';
  const snippet = rawSnippet ? clipHeadBytes(rawSnippet, WEB_SNIPPET_MAX_BYTES) : undefined;
  const truncated = url !== rawUrl
    || (title !== undefined && title !== rawTitle)
    || (snippet !== undefined && snippet !== rawSnippet);
  return {
    url,
    ...(title ? { title } : {}),
    ...(snippet ? { snippet } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

/** Builds a bounded web semantic. Always defined: a zero-result lookup is truthful. */
export function webSemantic(input: {
  query?: unknown;
  url?: unknown;
  results?: readonly unknown[];
}): ToolWebSemantic {
  const source = Array.isArray(input.results) ? input.results : [];
  const results: ToolWebResult[] = [];
  for (const raw of source) {
    if (results.length >= WEB_MAX_RESULTS) break;
    const result = webResult(raw);
    if (result) results.push(result);
  }
  const query = trimmed(input.query, PATH_MAX_CHARS);
  const url = trimmed(input.url, URL_MAX_CHARS);
  return {
    kind: 'web',
    ...(query ? { query } : {}),
    ...(url ? { url } : {}),
    ...(results.length ? { results } : {}),
    ...(source.length > results.length ? { truncated: true } : {}),
  };
}

/** Bytes one identity string may keep once collections are being shed. */
const SEMANTIC_SHED_FIELD_BYTES = 256;
/** Bytes one identity string may keep in the last-resort skeleton. */
const SEMANTIC_MINIMAL_FIELD_BYTES = 2 * 1024;

/** Encoded size of a candidate envelope, in the same UTF-8 bytes the frame costs. */
function semanticBytes(semantic: ToolSemantic): number {
  return utf8Length(JSON.stringify(semantic));
}

/** An emptied-but-honest stream: the body is gone, the fact of it is not. */
function shedStream(stream: ToolOutputStream | undefined): ToolOutputStream | undefined {
  if (!stream) return undefined;
  return {
    text: '',
    truncated: true,
    ...(stream.totalBytes !== undefined ? { totalBytes: stream.totalBytes } : {}),
  };
}

/** Stage 1 — halve the bodies, keep every structure. */
function shedBodies(semantic: ToolSemantic): ToolSemantic {
  switch (semantic.kind) {
    case 'command': {
      const half = Math.floor(COMMAND_STREAM_MAX_BYTES / 2);
      const shrink = (stream?: ToolOutputStream): ToolOutputStream | undefined => {
        if (!stream) return undefined;
        const text = clipTailBytes(stream.text, half);
        return { ...stream, text, ...(text !== stream.text ? { truncated: true } : {}) };
      };
      return {
        ...semantic,
        ...(semantic.stdout ? { stdout: shrink(semantic.stdout)! } : {}),
        ...(semantic.stderr ? { stderr: shrink(semantic.stderr)! } : {}),
      };
    }
    case 'file-read': {
      const { preview: _preview, ...rest } = semantic;
      return { ...rest, previewTruncated: true };
    }
    case 'search': {
      const groups = (semantic.groups ?? []).map((group) => {
        const { matches: _matches, ...rest } = group;
        return { ...rest, truncated: true };
      });
      return { ...semantic, ...(groups.length ? { groups } : {}), truncated: true };
    }
    case 'web': {
      const results = (semantic.results ?? []).map(({ snippet: _snippet, ...rest }) => ({
        ...rest,
        truncated: true,
      }));
      return { ...semantic, ...(results.length ? { results } : {}), truncated: true };
    }
  }
}

/** Stage 2 — drop every body and clip what survives by BYTES.
 *
 *  The per-field caps above count CHARACTERS, so 20 CJK group paths can carry
 *  three times the bytes their char bound suggests. This is where that is
 *  clipped, and the caller re-measures afterwards rather than assuming it fit. */
function shedCollections(semantic: ToolSemantic): ToolSemantic {
  const clip = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : clipHeadBytes(value, SEMANTIC_SHED_FIELD_BYTES);
  switch (semantic.kind) {
    case 'command':
      return {
        ...semantic,
        ...(semantic.stdout ? { stdout: shedStream(semantic.stdout)! } : {}),
        ...(semantic.stderr ? { stderr: shedStream(semantic.stderr)! } : {}),
      };
    case 'file-read': {
      const { preview: _preview, ...rest } = semantic;
      return { ...rest, previewTruncated: true };
    }
    case 'search': {
      const groups = (semantic.groups ?? [])
        .slice(0, SEARCH_MAX_GROUPS)
        .map((group) => ({
          path: clip(group.path)!,
          ...(group.matchCount !== undefined ? { matchCount: group.matchCount } : {}),
          truncated: true,
        }));
      return {
        ...semantic,
        ...(clip(semantic.query) ? { query: clip(semantic.query)! } : {}),
        ...(clip(semantic.scope) ? { scope: clip(semantic.scope)! } : {}),
        ...(groups.length ? { groups } : {}),
        truncated: true,
      };
    }
    case 'web': {
      const results = (semantic.results ?? [])
        .slice(0, WEB_MAX_RESULTS)
        .map((result) => ({ url: clip(result.url)!, truncated: true }));
      return {
        ...semantic,
        ...(clip(semantic.query) ? { query: clip(semantic.query)! } : {}),
        ...(clip(semantic.url) ? { url: clip(semantic.url)! } : {}),
        ...(results.length ? { results } : {}),
        truncated: true,
      };
    }
  }
}

/** Stage 3 — identity only. Provably bounded: at most two clipped identity
 *  strings survive, so even all-escaped input stays far below the ceiling. */
function minimalSemantic(semantic: ToolSemantic): ToolSemantic {
  const clip = (value: string): string => clipHeadBytes(value, SEMANTIC_MINIMAL_FIELD_BYTES);
  switch (semantic.kind) {
    case 'command':
      return {
        kind: 'command',
        command: clip(semantic.command),
        ...(semantic.cwd ? { cwd: clip(semantic.cwd) } : {}),
        state: semantic.state,
        ...(semantic.stdout ? { stdout: shedStream(semantic.stdout)! } : {}),
        ...(semantic.stderr ? { stderr: shedStream(semantic.stderr)! } : {}),
      };
    case 'file-read':
      return {
        kind: 'file-read',
        path: clip(semantic.path),
        ...(semantic.startLine !== undefined ? { startLine: semantic.startLine } : {}),
        ...(semantic.totalLines !== undefined ? { totalLines: semantic.totalLines } : {}),
        previewTruncated: true,
        ...(semantic.unavailable ? { unavailable: semantic.unavailable } : {}),
      };
    case 'search':
      return {
        kind: 'search',
        ...(semantic.query ? { query: clip(semantic.query) } : {}),
        ...(semantic.scope ? { scope: clip(semantic.scope) } : {}),
        ...(semantic.matchCount !== undefined ? { matchCount: semantic.matchCount } : {}),
        ...(semantic.fileCount !== undefined ? { fileCount: semantic.fileCount } : {}),
        truncated: true,
      };
    case 'web':
      return {
        kind: 'web',
        ...(semantic.query ? { query: clip(semantic.query) } : {}),
        ...(semantic.url ? { url: clip(semantic.url) } : {}),
        truncated: true,
      };
  }
}

/**
 * Final whole-envelope guard, and an ABSOLUTE one.
 *
 * The per-field bounds above sum to roughly 144 KiB in the worst case, which is
 * more than {@link TOOL_SEMANTIC_MAX_BYTES}; multibyte text pushes it further,
 * because several of those bounds count characters. So this does not shed once
 * and hope — it re-measures after every stage and keeps escalating, ending at an
 * identity-only skeleton small enough that no input can push it over.
 *
 * Every stage keeps (and adds) truncation flags, so a shed envelope can never be
 * presented as the complete one the source published.
 */
export function boundToolSemantic(semantic: ToolSemantic | undefined): ToolSemantic | undefined {
  if (!semantic) return undefined;
  if (semanticBytes(semantic) <= TOOL_SEMANTIC_MAX_BYTES) return semantic;
  for (const stage of [shedBodies, shedCollections, minimalSemantic]) {
    const candidate = stage(semantic);
    if (semanticBytes(candidate) <= TOOL_SEMANTIC_MAX_BYTES) return candidate;
  }
  // Unreachable: the skeleton holds at most two 2 KiB-clipped strings. Dropping
  // the envelope is still the only answer that honors the ceiling, and the row
  // stays renderable from its canonical `toolClass` fields.
  return undefined;
}
