import type {
  AgentMessage,
  HistoryQuery,
  HistorySnapshotPageReader,
  HistorySnapshotSink,
  HistorySourceIdentity,
} from '@cosyncing/adapter-api';
import {
  backwardHistoryCursorBoundary,
  backwardHistoryCursorFromHash,
  backwardHistoryCursorParts,
  BackwardHistoryCursorIndexer,
  type BackwardHistoryPage,
  historyCursorFromHash,
  historyCursorParts,
  isBackwardPageMessage,
  isCursorDurableMessage,
} from './history-delta.ts';

/** One active native-history snapshot may contribute at most this many
 * encoded bytes to the broker paging cache. */
export const HISTORY_PAGE_CACHE_MAX_ENTRY_BYTES = 32 * 1024 * 1024;

/** Aggregate encoded-message and cursor-index budget across active sessions. */
export const HISTORY_PAGE_CACHE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** At most this many active session histories are retained. */
export const HISTORY_PAGE_CACHE_MAX_ENTRIES = 4;

/** Per-entry raw-message count cap. This bounds cursor-string and JavaScript
 * object overhead even for pathological histories made of tiny messages. */
export const HISTORY_PAGE_CACHE_MAX_ENTRY_MESSAGES = 50_000;

/** Idle encoded indexes expire after this sliding deadline. The one-shot
 * expiry is not polling and is unref'd so it cannot keep the broker alive. */
export const HISTORY_PAGE_CACHE_IDLE_TTL_MS = 30_000;

/** Broker protocol hard limit for one decoded response. */
export const HISTORY_PAGE_CACHE_MAX_PAGE_MESSAGES = 500;

/**
 * Compact broker metadata plus adapter-owned native locators per snapshot.
 *
 * This is the SAME per-entry budget as {@link HISTORY_PAGE_CACHE_MAX_ENTRY_BYTES},
 * and it has to be (H1c). The compact index exists to serve histories the
 * encoded shape cannot hold: it retains hashes and native offsets instead of
 * complete encoded messages. Giving it a SMALLER ceiling inverted that — a real
 * 137.8 MiB / 26,984-message Codex rollout, comfortably inside the advertised
 * 256 MiB / 50,000-message native contract, needed ~12.7 MiB of compact index
 * and was refused under a 12 MiB cap while its 32 MiB encoded sibling was
 * nominally admissible. One number for one per-entry budget means the compact
 * path can never refuse a source the public contract advertises.
 */
export const HISTORY_PAGE_CACHE_MAX_INDEX_BYTES =
  HISTORY_PAGE_CACHE_MAX_ENTRY_BYTES;

/** Latest projection/activity keys retained alongside a compact index. */
export const HISTORY_PAGE_CACHE_MAX_PROJECTION_ENTRIES = 2_048;

/** Text-overlap identities retained for CR4 attach/live reconciliation. */
export const HISTORY_PAGE_CACHE_MAX_OVERLAP_ENTRIES = 1_024;

/**
 * Slots one bounded attach frame may spend on state-projection enrichment.
 *
 * The frame's job is the newest transcript. Enrichment — the latest plan, goal
 * and metadata rows that fell out of the window — is a courtesy on top of it,
 * and it must be paid for out of a SMALL fixed allowance rather than out of the
 * window itself. Without an allowance the two requirements fight and the wrong
 * one wins: a fixed point that grows the reserved projection set until it stops
 * moving has no upper bound short of the whole frame, so a history whose newest
 * 100 rows follow 100 distinct projection keys returned 100 projections and
 * NONE of the newest messages (H1c round 3). Reserving the contiguous newest
 * tail first and giving projections only the leftovers is the correct rule, but
 * applied literally it gives them zero slots in EVERY truncated attach — the
 * tail always has more rows available than the bound — which silently retires
 * the accepted H1 behaviour that the latest plan/goal survive a bounded attach.
 *
 * The allowance resolves both: at most this many slots may be spent, so the
 * contiguous newest tail is never shorter than the requested bound minus this
 * number, and a realistic handful of projections still reaches the client. 24
 * is roughly a quarter of a default 100-message attach and under 5% of the
 * 500-message maximum — large enough for every plan/goal/metadata key a real
 * session carries, small enough that it can never be mistaken for the window.
 */
export const HISTORY_PAGE_CACHE_MAX_ATTACH_PROJECTIONS = 24;

type EncodedHistoryMessage = {
  json: string;
  pageable: boolean;
};

export interface HistoryPageCacheStats {
  messageCount: number;
  encodedBytes: number;
}

export type HistoryPageReadFailure = {
  kind: 'source-changed' | 'resource-limit';
};

export interface CompactHistoryAttach {
  messages: AgentMessage[];
  derivedMessages: AgentMessage[];
  reset: boolean;
  cursor: string;
  gap?: {
    reason: 'invalid-cursor' | 'cursor-out-of-range' | 'cursor-prefix-mismatch';
    code: 'HISTORY_CURSOR_INVALID' | 'HISTORY_CURSOR_GONE' | 'HISTORY_CURSOR_DIVERGED';
    message: string;
    since?: string;
  };
  truncated?: { shown: number; total: number };
  olderCursor?: string;
  hasEarlier: boolean;
  /** Latest text lengths the client holds after this attach. A reset contains
   * only identities present in [messages]; an incremental attach also includes
   * its cursor-acknowledged prefix. */
  deliveredText: ReadonlyMap<string, number>;
}

/** Whether both probes describe the exact same native source snapshot. */
export function sameHistorySourceIdentity(
  left: Readonly<HistorySourceIdentity>,
  right: Readonly<HistorySourceIdentity>,
): boolean {
  return left.sourceId === right.sourceId
    && left.revision === right.revision
    && left.appendPosition === right.appendPosition
    && left.rewriteToken === right.rewriteToken;
}

/** Whether [current] can only have appended beyond an immutable snapshot. */
export function historySourceStillContainsSnapshot(
  snapshot: Readonly<HistorySourceIdentity>,
  current: Readonly<HistorySourceIdentity>,
): boolean {
  if (snapshot.sourceId !== current.sourceId) return false;
  if (snapshot.revision === current.revision) {
    return sameHistorySourceIdentity(snapshot, current);
  }
  return snapshot.appendPosition !== undefined
    && current.appendPosition !== undefined
    && current.appendPosition > snapshot.appendPosition
    && snapshot.rewriteToken !== undefined
    && snapshot.rewriteToken === current.rewriteToken;
}

/**
 * The broker's paging budget, applied to one message at a time.
 *
 * This is the ONLY place a native history becomes broker-retained bytes, and it
 * is a sink so that enforcement happens DURING the adapter's read rather than
 * after it. The old shape took a complete `AgentMessage[]`: an adapter had to
 * materialize every message — plus, for a file-backed source, every parsed
 * record behind them — before the 32 MiB / 50k limits could run at all, so the
 * limits bounded what was RETAINED while peak construction stayed unbounded.
 *
 * {@link accept} returns false the moment this snapshot cannot fit. A capturing
 * adapter must stop reading there and report a resource limit; everything
 * accumulated is discarded by {@link finish}.
 */
export class EncodedHistoryPageCacheBuilder implements HistorySnapshotSink {
  private readonly encoded: EncodedHistoryMessage[] = [];
  private readonly cursors: string[];
  private readonly indexer = new BackwardHistoryCursorIndexer();
  private encodedBytes = 0;
  private overflowed = false;

  constructor(
    private readonly maxBytes = HISTORY_PAGE_CACHE_MAX_ENTRY_BYTES,
    private readonly maxMessages = HISTORY_PAGE_CACHE_MAX_ENTRY_MESSAGES,
  ) {
    this.cursors = [this.indexer.openingCursor];
    this.encodedBytes += Buffer.byteLength(this.cursors[0]!, 'utf8');
  }

  /** Whether a stated bound was exceeded. Terminal for this snapshot. */
  get exceededBudget(): boolean {
    return this.overflowed;
  }

  accept(message: AgentMessage): boolean {
    if (this.overflowed) return false;
    // Cursor-transient frames are not part of the cursor space at all, so they
    // are dropped here rather than by every caller in turn.
    if (!isCursorDurableMessage(message)) return true;
    if (this.encoded.length >= this.maxMessages) {
      this.overflowed = true;
      return false;
    }
    const json = JSON.stringify(message);
    const cursor = this.indexer.push(message);
    this.encodedBytes += Buffer.byteLength(json, 'utf8') + 1
      + Buffer.byteLength(cursor, 'utf8');
    if (this.encodedBytes > this.maxBytes) {
      this.overflowed = true;
      return false;
    }
    this.encoded.push({ json, pageable: isBackwardPageMessage(message) });
    this.cursors.push(cursor);
    return true;
  }

  /** The finished cache, or undefined when a bound was exceeded. */
  finish(
    sourceIdentity: Readonly<HistorySourceIdentity>,
  ): EncodedHistoryPageCache | undefined {
    if (this.overflowed) return undefined;
    return EncodedHistoryPageCache.fromBuilderParts(
      sourceIdentity,
      this.encoded,
      this.cursors,
      this.encodedBytes,
    );
  }
}

/**
 * Encoded, cursor-indexed history for one stable adapter source revision.
 *
 * Only the requested page is decoded. A complete multi-megabyte
 * `AgentMessage[]` is never retained after cache construction.
 */
export class EncodedHistoryPageCache {
  readonly kind = 'encoded' as const;

  private constructor(
    readonly sourceIdentity: Readonly<HistorySourceIdentity>,
    private readonly messages: EncodedHistoryMessage[],
    private readonly cursors: string[],
    readonly encodedBytes: number,
  ) {}

  /** @internal — the builder is the only constructor path. */
  static fromBuilderParts(
    sourceIdentity: Readonly<HistorySourceIdentity>,
    messages: EncodedHistoryMessage[],
    cursors: string[],
    encodedBytes: number,
  ): EncodedHistoryPageCache {
    return new EncodedHistoryPageCache(
      Object.freeze({ ...sourceIdentity }),
      messages,
      cursors,
      encodedBytes,
    );
  }

  static create(
    sourceIdentity: Readonly<HistorySourceIdentity>,
    messages: AgentMessage[],
    maxBytes = HISTORY_PAGE_CACHE_MAX_ENTRY_BYTES,
    maxMessages = HISTORY_PAGE_CACHE_MAX_ENTRY_MESSAGES,
  ): EncodedHistoryPageCache | undefined {
    const builder = new EncodedHistoryPageCacheBuilder(maxBytes, maxMessages);
    for (const message of messages) if (!builder.accept(message)) break;
    return builder.finish(sourceIdentity);
  }

  get stats(): HistoryPageCacheStats {
    return {
      messageCount: this.messages.length,
      encodedBytes: this.encodedBytes,
    };
  }

  /**
   * Return one chronological page or a typed cursor failure from this exact
   * immutable snapshot. Cursor mistakes never trigger another native parse.
   */
  page(rawCursor: string | undefined, limit = 100): BackwardHistoryPage {
    const boundaryFromCursor = backwardHistoryCursorBoundary(rawCursor);
    if (boundaryFromCursor === undefined || boundaryFromCursor < 0) {
      return {
        messages: [],
        hasMore: false,
        endOfHistory: false,
        gap: {
          reason: 'invalid-cursor',
          code: 'HISTORY_CURSOR_INVALID',
          message: 'backward history cursor is invalid',
          ...(rawCursor ? { cursor: rawCursor } : {}),
        },
      };
    }
    if (boundaryFromCursor >= this.cursors.length) {
      return {
        messages: [],
        hasMore: false,
        endOfHistory: false,
        gap: {
          reason: 'cursor-out-of-range',
          code: 'HISTORY_CURSOR_GONE',
          message: 'backward history cursor is outside the retained session history',
          ...(rawCursor ? { cursor: rawCursor } : {}),
        },
      };
    }
    if (this.cursors[boundaryFromCursor] !== rawCursor) {
      return {
        messages: [],
        hasMore: false,
        endOfHistory: false,
        gap: {
          reason: 'cursor-prefix-mismatch',
          code: 'HISTORY_CURSOR_DIVERGED',
          message: 'backward history cursor no longer matches this session',
          ...(rawCursor ? { cursor: rawCursor } : {}),
        },
      };
    }
    const pageLimit = Math.max(
      1,
      Math.min(
        HISTORY_PAGE_CACHE_MAX_PAGE_MESSAGES,
        Number.isFinite(limit) ? Math.trunc(limit) : 100,
      ),
    );
    const reverse: AgentMessage[] = [];
    let boundary = boundaryFromCursor;
    while (boundary > 0 && reverse.length < pageLimit) {
      boundary -= 1;
      const encoded = this.messages[boundary]!;
      if (encoded.pageable) {
        reverse.push(JSON.parse(encoded.json) as AgentMessage);
      }
    }
    const hasMore = boundary > 0;
    return {
      messages: reverse.reverse(),
      ...(hasMore ? { cursor: this.cursors[boundary] } : {}),
      hasMore,
      endOfHistory: !hasMore,
    };
  }

  async loadPage(
    rawCursor: string | undefined,
    limit = 100,
    _query?: HistoryQuery,
  ): Promise<BackwardHistoryPage> {
    return this.page(rawCursor, limit);
  }
}

type CompactProjection = {
  location: number;
  index: number;
};

type CompactOverlap = {
  key: string;
  length: number;
};

/**
 * Build cursor hashes and native locations without retaining normalized
 * payloads. The adapter owns the matching bounded random-access reader.
 */
export class IndexedHistoryPageCacheBuilder implements HistorySnapshotSink {
  readonly acceptsLocations = true;

  private readonly hashes: string[] = [];
  private readonly locations: number[] = [];
  private readonly pageable: boolean[] = [];
  private readonly indexer = new BackwardHistoryCursorIndexer();
  private readonly projections = new Map<string, CompactProjection>();
  private readonly derived = new Map<string, number>();
  private readonly overlap = new Map<string, CompactOverlap>();
  private indexBytes = 0;
  private overflowed = false;

  constructor(
    private readonly maxBytes = HISTORY_PAGE_CACHE_MAX_INDEX_BYTES,
    private readonly maxMessages = HISTORY_PAGE_CACHE_MAX_ENTRY_MESSAGES,
  ) {
    this.hashes.push(this.indexer.openingHash);
    this.indexBytes = Buffer.byteLength(this.indexer.openingHash, 'utf8');
  }

  get exceededBudget(): boolean {
    return this.overflowed;
  }

  accept(message: AgentMessage, location?: number): boolean {
    if (this.overflowed) return false;
    if (
      location === undefined
      || !Number.isSafeInteger(location)
      || location < 0
    ) {
      this.overflowed = true;
      return false;
    }

    if (!isCursorDurableMessage(message)) {
      const key = `${message.type}\0${(message as { key?: string }).key ?? location}`;
      if (this.derived.has(key)) {
        // Replacement only refreshes recency/location. The retained map still
        // owns one key and one entry, so charging its object overhead again
        // would make a hot activity projection eventually refuse a bounded
        // cache even though retained memory never grew.
        this.derived.delete(key);
      } else {
        this.indexBytes += Buffer.byteLength(key, 'utf8') + 64;
      }
      this.derived.set(key, location);
      if (this.derived.size > HISTORY_PAGE_CACHE_MAX_PROJECTION_ENTRIES) {
        this.overflowed = true;
        return false;
      }
      return this.checkBytes();
    }

    if (this.locations.length >= this.maxMessages) {
      this.overflowed = true;
      return false;
    }
    const index = this.locations.length;
    const hash = this.indexer.pushHash(message);
    this.hashes.push(hash);
    this.locations.push(location);
    this.pageable.push(isBackwardPageMessage(message));
    // Hash bytes, three array slots/values, string/object headers, and a
    // conservative collection-growth allowance. Locations later compact to
    // native integers, but accounting must describe the live retained cache,
    // not only its ideal packed representation.
    this.indexBytes += Buffer.byteLength(hash, 'utf8') + 8 + 1 + 48;

    if (
      message.type === 'task-list-state'
      || message.type === 'goal-state'
      || message.type === 'metadata-update'
    ) {
      const key = `${message.type}\0${(message as { key?: string }).key ?? ''}`;
      if (!this.projections.has(key)) {
        this.indexBytes += Buffer.byteLength(key, 'utf8') + 96;
      }
      this.projections.set(key, { location, index });
      if (this.projections.size > HISTORY_PAGE_CACHE_MAX_PROJECTION_ENTRIES) {
        this.overflowed = true;
        return false;
      }
    }

    if (
      (message.type === 'model-output' || message.type === 'thinking')
      && message.key
    ) {
      const key = `${message.type}:${message.key}`;
      const text = typeof message.text === 'string' ? message.text : '';
      if (!this.overlap.has(key)) {
        this.indexBytes += Buffer.byteLength(key, 'utf8') + 96;
      } else {
        this.overlap.delete(key);
      }
      this.overlap.set(key, { key, length: text.length });
      while (this.overlap.size > HISTORY_PAGE_CACHE_MAX_OVERLAP_ENTRIES) {
        const oldest = this.overlap.keys().next().value;
        if (oldest === undefined) break;
        this.overlap.delete(oldest);
      }
    }
    return this.checkBytes();
  }

  private checkBytes(): boolean {
    if (this.indexBytes > this.maxBytes) {
      this.overflowed = true;
      return false;
    }
    return true;
  }

  finish(
    sourceIdentity: Readonly<HistorySourceIdentity>,
    reader: HistorySnapshotPageReader | undefined,
  ): IndexedHistoryPageCache | undefined {
    if (
      this.overflowed
      || !reader
      || !Number.isSafeInteger(reader.retainedBytes)
      || reader.retainedBytes < 0
      || this.indexBytes + reader.retainedBytes > this.maxBytes
    ) {
      return undefined;
    }
    return new IndexedHistoryPageCache({
      sourceIdentity,
      hashes: this.hashes,
      locations: Uint32Array.from(this.locations),
      pageable: Uint8Array.from(
        this.pageable.map((pageable) => pageable ? 1 : 0),
      ),
      projections: this.projections,
      derived: [...this.derived.values()],
      overlap: [...this.overlap.values()],
      indexBytes: this.indexBytes + reader.retainedBytes,
      reader,
    });
  }
}

/**
 * Compact source-native history index. Only requested locations are decoded
 * into normalized messages; no complete encoded transcript is retained.
 */
export class IndexedHistoryPageCache {
  readonly kind = 'indexed' as const;
  readonly sourceIdentity: Readonly<HistorySourceIdentity>;
  readonly encodedBytes: number;
  private readonly hashes: readonly string[];
  private readonly locations: Uint32Array;
  private readonly pageable: Uint8Array;
  private readonly projections: ReadonlyMap<string, CompactProjection>;
  private readonly derived: readonly number[];
  private readonly overlap: readonly CompactOverlap[];
  private readonly reader: HistorySnapshotPageReader;
  private _lastReadWork:
    | { recordsRead: number; bytesRead: number }
    | undefined;

  constructor(parts: {
    sourceIdentity: Readonly<HistorySourceIdentity>;
    hashes: readonly string[];
    locations: Uint32Array;
    pageable: Uint8Array;
    projections: ReadonlyMap<string, CompactProjection>;
    derived: readonly number[];
    overlap: readonly CompactOverlap[];
    indexBytes: number;
    reader: HistorySnapshotPageReader;
  }) {
    this.sourceIdentity = Object.freeze({ ...parts.sourceIdentity });
    this.hashes = parts.hashes;
    this.locations = parts.locations;
    this.pageable = parts.pageable;
    this.projections = parts.projections;
    this.derived = parts.derived;
    this.overlap = parts.overlap;
    this.encodedBytes = parts.indexBytes;
    this.reader = parts.reader;
  }

  get stats(): HistoryPageCacheStats {
    return {
      messageCount: this.locations.length,
      encodedBytes: this.encodedBytes,
    };
  }

  /** Most recent bounded native read, exposed for deterministic resource tests. */
  get lastReadWork():
    | { recordsRead: number; bytesRead: number }
    | undefined {
    return this._lastReadWork;
  }

  private olderBoundary(
    rawCursor: string | undefined,
  ): number | BackwardHistoryPage {
    const parsed = backwardHistoryCursorParts(rawCursor);
    if (!parsed || parsed.boundary < 0) {
      return {
        messages: [],
        hasMore: false,
        endOfHistory: false,
        gap: {
          reason: 'invalid-cursor',
          code: 'HISTORY_CURSOR_INVALID',
          message: 'backward history cursor is invalid',
          ...(rawCursor ? { cursor: rawCursor } : {}),
        },
      };
    }
    if (parsed.boundary >= this.hashes.length) {
      return {
        messages: [],
        hasMore: false,
        endOfHistory: false,
        gap: {
          reason: 'cursor-out-of-range',
          code: 'HISTORY_CURSOR_GONE',
          message: 'backward history cursor is outside the retained session history',
          ...(rawCursor ? { cursor: rawCursor } : {}),
        },
      };
    }
    if (this.hashes[parsed.boundary] !== parsed.hash) {
      return {
        messages: [],
        hasMore: false,
        endOfHistory: false,
        gap: {
          reason: 'cursor-prefix-mismatch',
          code: 'HISTORY_CURSOR_DIVERGED',
          message: 'backward history cursor no longer matches this session',
          ...(rawCursor ? { cursor: rawCursor } : {}),
        },
      };
    }
    return parsed.boundary;
  }

  private async resolve(
    locations: readonly number[],
    query?: HistoryQuery,
  ): Promise<AgentMessage[] | HistoryPageReadFailure> {
    const result = await Promise.resolve(this.reader.read(locations, query))
      .catch(() => undefined);
    if (!result) return { kind: 'source-changed' };
    if ('refusal' in result) return { kind: 'resource-limit' };
    if (
      !sameHistorySourceIdentity(result.identity, this.sourceIdentity)
      || result.messages.length !== locations.length
    ) {
      return { kind: 'source-changed' };
    }
    this._lastReadWork = result.work;
    return result.messages;
  }

  async loadPage(
    rawCursor: string | undefined,
    limit = 100,
    query?: HistoryQuery,
  ): Promise<BackwardHistoryPage | HistoryPageReadFailure> {
    const resolvedBoundary = this.olderBoundary(rawCursor);
    if (typeof resolvedBoundary !== 'number') return resolvedBoundary;
    const pageLimit = Math.max(
      1,
      Math.min(
        HISTORY_PAGE_CACHE_MAX_PAGE_MESSAGES,
        Number.isFinite(limit) ? Math.trunc(limit) : 100,
      ),
    );
    const reverseLocations: number[] = [];
    let boundary = resolvedBoundary;
    while (boundary > 0 && reverseLocations.length < pageLimit) {
      boundary -= 1;
      if (this.pageable[boundary] === 1) {
        reverseLocations.push(this.locations[boundary]!);
      }
    }
    const locations = reverseLocations.reverse();
    const messages = await this.resolve(locations, query);
    if (!Array.isArray(messages)) return messages;
    const hasMore = boundary > 0;
    return {
      messages,
      ...(hasMore
        ? {
            cursor: backwardHistoryCursorFromHash(
              boundary,
              this.hashes[boundary]!,
            ),
          }
        : {}),
      hasMore,
      endOfHistory: !hasMore,
    };
  }

  async loadAttach(
    since: string | undefined,
    max: number,
    query?: HistoryQuery,
  ): Promise<CompactHistoryAttach | HistoryPageReadFailure> {
    const count = this.locations.length;
    const parsed = historyCursorParts(since);
    let start = 0;
    let reset = true;
    let gap: CompactHistoryAttach['gap'];
    if (parsed === null) {
      gap = {
        reason: 'invalid-cursor',
        code: 'HISTORY_CURSOR_INVALID',
        message: 'history cursor is invalid; full replay was sent',
        ...(since ? { since } : {}),
      };
    } else if (parsed) {
      if (
        !Number.isInteger(parsed.boundary)
        || parsed.boundary < 0
        || parsed.boundary > count
      ) {
        gap = {
          reason: 'cursor-out-of-range',
          code: 'HISTORY_CURSOR_GONE',
          message: 'history cursor is outside the retained session history; full replay was sent',
          ...(since ? { since } : {}),
        };
      } else if (this.hashes[parsed.boundary] !== parsed.hash) {
        gap = {
          reason: 'cursor-prefix-mismatch',
          code: 'HISTORY_CURSOR_DIVERGED',
          message: 'history cursor no longer matches this session; full replay was sent',
          ...(since ? { since } : {}),
        };
      } else {
        start = parsed.boundary;
        reset = false;
      }
    }

    const boundedMax = Math.min(
      HISTORY_PAGE_CACHE_MAX_PAGE_MESSAGES,
      Number.isFinite(max) && max > 0
        ? Math.max(1, Math.trunc(max))
        : 100,
    );
    const available = count - start;
    let shownStart = start;
    let truncated: { shown: number; total: number } | undefined;
    if (available > boundedMax) {
      shownStart = count - boundedMax;
      reset = true;
      truncated = { shown: boundedMax, total: count };
    }

    let projectionLocations: number[] = [];
    if (truncated) {
      // Projection enrichment belongs INSIDE the requested attach bound, and it
      // may never buy its slots from the newest transcript rows.
      //
      // Two earlier shapes were both wrong. Appending projections AFTER
      // selecting the newest `boundedMax` entries overflowed the bound, so the
      // client kept 100 of 102 entries and dropped two tail rows it could never
      // page back to. Growing `shownStart` until the reserved projection set
      // stopped moving stayed inside the bound but had no ceiling: with 100
      // distinct projection keys in front of the tail the fixed point consumed
      // every slot and the newest messages vanished from the attach frame
      // entirely (H1c round 3) — the exact failure this lane exists to remove.
      //
      // The rule now: the shown window is always a contiguous suffix ending at
      // the newest message, and projections may claim at most
      // {@link HISTORY_PAGE_CACHE_MAX_ATTACH_PROJECTIONS} of the frame's slots.
      // `spent` is the number of slots handed to enrichment; the tail keeps the
      // rest. Spending a slot moves `shownStart` forward, which can expose one
      // more projection, so this walks `spent` upward to the first point where
      // the exposed projections fit in what has been spent — a fixed point that
      // is bounded by construction because `spent` never exceeds the allowance.
      // Displaced rows stay reachable exactly once through `olderCursor`:
      // projections are not backward-pageable, so re-sending one here cannot
      // duplicate a row that backward paging will also return.
      //
      // The PRESENTATION trade, stated plainly. The frame is laid out as
      // [contiguous newest tail, then enrichment], so with 100 projection keys
      // in front of the tail a 100-slot attach returns p26…u2 followed by
      // p2…p25: the newest transcript rows are all present and contiguous, but
      // the enriched projections FOLLOW them in the array rather than sitting
      // at their original older positions. Spending those slots also pushes up
      // to HISTORY_PAGE_CACHE_MAX_ATTACH_PROJECTIONS otherwise-newest rows
      // behind `olderCursor`. Nothing is lost — every displaced row is still
      // reachable exactly once by paging — but a client that renders frame
      // order verbatim shows stale state rows after the newest message. That is
      // the accepted cost of keeping the H1 guarantee that the latest
      // plan/goal survives a bounded attach; it is not free, and callers that
      // order by identity rather than by array position are unaffected.
      const projectionBudget = Math.max(
        0,
        Math.min(HISTORY_PAGE_CACHE_MAX_ATTACH_PROJECTIONS, boundedMax - 1),
      );
      const projections = [...this.projections.values()]
        .sort((left, right) => left.index - right.index);
      for (let spent = 0; spent <= projectionBudget; spent += 1) {
        const candidateStart = count - (boundedMax - spent);
        const exposed = projections
          .filter((projection) => projection.index < candidateStart);
        if (exposed.length <= spent || spent === projectionBudget) {
          shownStart = candidateStart;
          projectionLocations = (
            exposed.length <= spent ? exposed : exposed.slice(exposed.length - spent)
          ).map((projection) => projection.location);
          break;
        }
      }
      // The frame carries the contiguous tail plus whatever enrichment fit, so
      // `shown` has to be that count and not the requested bound.
      truncated = {
        shown: (count - shownStart) + projectionLocations.length,
        total: count,
      };
    }
    const locations = [
      ...Array.from(this.locations.slice(shownStart)),
      ...projectionLocations,
    ];
    const messages = await this.resolve(locations, query);
    if (!Array.isArray(messages)) return messages;
    const derivedMessages = await this.resolve(this.derived, query);
    if (!Array.isArray(derivedMessages)) return derivedMessages;
    const cursor = historyCursorFromHash(count, this.hashes[count]!);
    return {
      messages,
      derivedMessages,
      reset,
      cursor,
      ...(gap ? { gap } : {}),
      ...(truncated ? { truncated } : {}),
      ...(truncated
        ? {
            olderCursor: backwardHistoryCursorFromHash(
              shownStart,
              this.hashes[shownStart]!,
            ),
          }
        : {}),
      hasEarlier: Boolean(truncated),
      deliveredText: reset
        ? deliveredTextFrom(messages)
        : new Map(this.overlap.map(({ key, length }) => [key, length])),
    };
  }
}

/**
 * Newest-tail replay budget used when NO index can be built.
 *
 * Deliberately the client's own active-window contract — five 100-message pages
 * and 4 MiB of decoded transcript — because that is the most a client could
 * hold anyway. Nothing here is a new public bound: it is the existing client
 * window, applied at the broker so a refusal still has something truthful to
 * send.
 */
export const HISTORY_TAIL_REPLAY_MAX_MESSAGES =
  HISTORY_PAGE_CACHE_MAX_PAGE_MESSAGES;
export const HISTORY_TAIL_REPLAY_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Share of the shared payload budget one OVER-BUDGET entry may claim.
 *
 * Only entries that alone exceed the whole budget are clipped, and such an
 * entry has to be given less than the whole budget or the fitting window
 * around it is evicted to pay for it — which is the same empty-transcript
 * outcome by another route. Half leaves half the window intact, which for the
 * production 4 MiB budget is 2 MiB of the oversized message plus 2 MiB of the
 * messages before it. Nothing else is clipped: a message that merely does not
 * fit ALONGSIDE others is handled by ordinary oldest-first eviction, exactly as
 * before.
 */
export const HISTORY_TAIL_OVERSIZED_ENTRY_SHARE = 0.5;

/**
 * Message variants a bounded stand-in may be built for, and the ONLY fields of
 * each that may be shortened.
 *
 * This table is the whole safety argument, so it is an allow-list and not a
 * heuristic. The previous version picked the heaviest non-identity property of
 * any message and clipped or DELETED it, which produced structurally invalid
 * frames: an oversized `task-list-state` lost `items` (its heaviest field, and
 * one the Dart decoder requires — `agent_message.dart` returns null when
 * `items` is not an Iterable), so the stand-in vanished from client state while
 * still holding a cursor position. The same trap exists for
 * `question-request.questions`, `metadata-update.value`, and every future
 * variant with a required structured field.
 *
 * A variant qualifies only when BOTH hold:
 *
 *  1. Shortening the listed fields cannot change the message's SHAPE — each
 *     listed field is a plain string, and every other field, required or not,
 *     structured or not, is copied verbatim.
 *  2. The Flutter client renders a localized "shortened" indicator for it, so a
 *     substitute is never presented as the complete message. The three entries
 *     here are exactly the three the client annotates
 *     (`transcript_message_widgets.dart`); adding a fourth means adding its
 *     indicator in the same commit, or the clip becomes silent.
 *
 * Anything absent from this table takes the conservative path in
 * {@link BoundedTailHistorySnapshotSink.accept}: no substitute at all. That
 * includes `tool-result`, whose bulk can sit in `semantic`, `fileChanges` or a
 * non-string `result`; `terminal-output`, `fs-edit` and `notice`, which are
 * shape-safe but have no indicator; and every type not explicitly cleared.
 */
const TAIL_CLIPPABLE_FIELDS_BY_TYPE: ReadonlyMap<string, readonly string[]> =
  new Map([
    // `text` only. `delta` was listed in round 4 and is deliberately gone
    // (round 5, blocker 3): the thinking renderer resolves its body from
    // ['content','thought','text','status'] and never reads `delta`, so a
    // delta-only clipped thinking row expanded to an empty body AND no
    // truncation note - a clip with no indicator anywhere, which is exactly
    // what rule 2 below forbids. Nothing is lost by removing it: `delta` is a
    // LIVE streaming fragment. Every adapter emits it from a stream event, and
    // every history mapper on the capture path (codex `mapLine`, the only
    // adapter wired to this sink) materializes assembled `text` instead, so a
    // replayed body is never delta-only.
    ['model-output', ['text']],
    ['thinking', ['text']],
    // `text` is required but stays a string, so the shape is unchanged.
    ['user-message', ['text']],
  ]);

/** State variants whose latest value per key is replayed as enrichment. */
function tailStateProjectionKey(message: AgentMessage): string | undefined {
  if (
    message.type !== 'task-list-state'
    && message.type !== 'goal-state'
    && message.type !== 'metadata-update'
  ) return undefined;
  return `${message.type}\0${(message as { key?: string }).key ?? ''}`;
}

type TailEntry = {
  /**
   * The retained wire payload, or `undefined` for an OMITTED message.
   *
   * An omitted entry keeps its place in the tail — the boundary arithmetic in
   * {@link BoundedTailHistoryReplay.hashAt} indexes by position, so a hole
   * would silently misresolve every cursor after it — but carries no payload
   * and costs no bytes. It is how a message too large to send, and of a variant
   * no stand-in may be built for, is represented without either destroying the
   * window around it or shipping something malformed.
   */
  json: string | undefined;
  /** Prefix hash of every durable message up to and including this one. */
  hashAfter: string;
  /** Boundary index after this message, i.e. how many durable messages precede the next one. */
  boundaryAfter: number;
  bytes: number;
  /** A bounded stand-in was retained because the real entry exceeded the budget. */
  clipped: boolean;
  /** Projection key, for state variants whose latest value per key is replayed. */
  stateKey?: string;
  /**
   * Why this row's payload was withheld, or `undefined` if it was not.
   *
   * Distinct from an omission: a withheld row is not oversized and could have
   * been replayed. Sending it would assert stale state as current, which is a
   * different and worse failure than an admitted hole.
   *
   *  - `superseded`: a NEWER same-key update could not be sent (round 5).
   *  - `unverified`: a native record was skipped, so the capture cannot prove
   *    this is still the latest value for its key (round 6, P1-2).
   */
  withheld?: TailWithheldReason;
};

/** Why a retained row's payload is being withheld from the frame. */
type TailWithheldReason = 'superseded' | 'unverified';

type TailProjection = {
  /** Zero-based durable position of the message this projection came from. */
  index: number;
  json: string;
  bytes: number;
};

type TailDerived = {
  json: string;
  bytes: number;
};

/**
 * Encoded size of one retained entry, including its wire separator.
 *
 * The `+ 1` matches {@link EncodedHistoryPageCacheBuilder}: without it the
 * budget is short by one byte per message against the array the client actually
 * receives, so a "within budget" claim would be a rounding error rather than a
 * fact.
 */
function tailEntryBytes(json: string): number {
  return Buffer.byteLength(json, 'utf8') + 1;
}

/** Bytes one string costs INSIDE a JSON object, excluding its two quotes. */
function encodedStringContentBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8') - 2;
}

/**
 * A bounded stand-in for a message that alone exceeds the whole payload budget.
 *
 * Without one, {@link BoundedTailHistorySnapshotSink.evictToBudget} was forced
 * to evict the entire fitting window to pay for the newest row and then evict
 * that row too, so ONE 4-32 MiB Codex record produced a notice above an empty
 * transcript - the precise H1c symptom, reached through the path built to
 * prevent it (round 3, finding 3).
 *
 * Type-aware and strictly additive-free. Only a variant listed in
 * {@link TAIL_CLIPPABLE_FIELDS_BY_TYPE} may be substituted at all, only that
 * variant's listed string fields are shortened, every other field is copied
 * verbatim, and no field the variant does not define is ever introduced. The
 * result is therefore the same message with less text in known places - never a
 * different shape. A `bodyTruncated` flag marks it so the client can say so in
 * ITS OWN language; the broker injects no prose into message content, because
 * English text inside a transcript body is the S2 defect this lane removed from
 * the gap notice (round 4, finding 3).
 *
 * Returns `undefined` when no substitute may or can be built - an unlisted
 * variant, or a listed one still too large after every listed field is gone.
 * The caller then omits the message rather than shipping something malformed.
 *
 * Cost is O(targetBytes), not O(message): every measurement after the first is
 * taken on an already-clipped copy, so a 32 MiB record is stringified once.
 */
function clipMessageWithinBytes(
  message: AgentMessage,
  targetBytes: number,
): AgentMessage | undefined {
  const clippable = TAIL_CLIPPABLE_FIELDS_BY_TYPE.get(message.type);
  if (!clippable) return undefined;
  const copy = { ...(message as unknown as Record<string, unknown>) };
  // Heaviest listed field first, so the fewest of them are shortened.
  const weighed = clippable
    .filter((field) => typeof copy[field] === 'string')
    .map((field) => ({
      field,
      bytes: encodedStringContentBytes(copy[field] as string),
    }))
    .sort((left, right) => right.bytes - left.bytes);
  if (weighed.length === 0) return undefined;

  // Flag FIRST, so its bytes are reserved by every measurement below. Setting it
  // afterwards made the finished substitute overshoot `targetBytes` by exactly
  // the flag's width and be thrown away, silently turning every clippable
  // message back into an omitted one.
  copy.bodyTruncated = true;
  let shortened = false;
  for (const { field } of weighed) {
    if (tailEntryBytes(JSON.stringify(copy)) <= targetBytes) break;
    const value = copy[field] as string;
    // Room for this field's escaped content, measured with the field present
    // but empty so its key, quotes and separators are already paid for. The
    // field is never DELETED: an absent field is a different shape from an
    // empty one, and only the latter is safe to promise.
    copy[field] = '';
    const room = targetBytes - tailEntryBytes(JSON.stringify(copy));
    if (room <= 0) {
      shortened = shortened || value.length > 0;
      continue;
    }
    // Each character removed frees at least one encoded byte, so subtracting
    // the measured overage in characters always converges; the guard only
    // covers heavily escaped text, where it converges faster than it must.
    let keep = Math.min(value.length, room);
    for (let guard = 0; guard < 4 && keep > 0; guard += 1) {
      const over = encodedStringContentBytes(value.slice(0, keep)) - room;
      if (over <= 0) break;
      keep = Math.max(0, keep - over);
    }
    copy[field] = value.slice(0, keep);
    shortened = shortened || keep < value.length;
  }
  if (!shortened) return undefined;
  if (tailEntryBytes(JSON.stringify(copy)) > targetBytes) return undefined;
  return copy as unknown as AgentMessage;
}

/**
 * A streaming sink that keeps only the NEWEST bounded window of a history.
 *
 * This is the answer to "the index does not fit". Every other sink in this file
 * refuses when a source outgrows its budget, and a refusal used to become an
 * empty `reset: true` replay — the client then cleared its transcript and
 * rendered *full replay*, *Start of session*, and *No messages* at once, none
 * of which were true (H1c).
 *
 * This sink NEVER refuses for size. It folds every message into the same
 * rolling cursor chain the paging cache uses (O(1) state, so the cursors it
 * issues are genuine and interoperate with an index built later), and evicts
 * the moment the retained payload exceeds its bounds. Peak retention is one
 * bounded window — never the whole native history — so it is admissible
 * precisely where an index is not.
 *
 * [maxBytes] governs EVERY byte this sink will hand to a client: the tail, the
 * retained state projections, and the derived activity overlays share one
 * budget. Counting only the tail made {@link retainedBytes} understate a
 * 3,793-byte replay as 758 bytes, which is not a bound at all — it is a bound
 * on one of three contributors. Eviction spends the cheapest thing first:
 * decorative activity overlays, then state projections, then the oldest tail
 * rows. The tail is contiguous with the newest message, so a message larger
 * than the whole budget leaves an EMPTY tail rather than a single row that
 * blows the bound and that the client's identical window budget would discard
 * anyway.
 *
 * What it cannot do is serve an OLDER page: there is no retained boundary
 * behind the window. That is reported as earlier-history-present with no
 * reload cursor, which is exactly what is true.
 */
export class BoundedTailHistorySnapshotSink implements HistorySnapshotSink {
  /** Asks the adapter for the degraded whole-source read this sink can absorb. */
  readonly readsBoundedTailOnly = true;

  private readonly indexer = new BackwardHistoryCursorIndexer();
  private readonly tail: TailEntry[] = [];
  private readonly derived = new Map<string, TailDerived>();
  private readonly overlap = new Map<string, number>();
  private readonly projections = new Map<string, TailProjection>();
  private count = 0;
  private tailBytes = 0;
  private projectionBytes = 0;
  private derivedBytes = 0;
  private headBoundary = 0;
  private headHash: string;
  private latestHash: string;
  /**
   * An unsendable latest-wins update made incremental replay unsafe.
   *
   * Never cleared. The history cursor does not acknowledge state delivered on
   * the live stream, so even a withheld row beyond that cursor may replace a
   * value the client already saw live. Only a replacement frame can retract
   * that value (round 6 follow-up, P1-1/P1-2).
   */
  private stateRetractionLatched = false;
  /** A skipped native record left every latest-wins state claim unprovable. */
  private stateAuthorityUnverified = false;

  constructor(
    private readonly maxMessages = HISTORY_TAIL_REPLAY_MAX_MESSAGES,
    private readonly maxBytes = HISTORY_TAIL_REPLAY_MAX_BYTES,
  ) {
    this.headHash = this.indexer.openingHash;
    this.latestHash = this.indexer.openingHash;
  }

  /** Total durable messages observed, including evicted ones. */
  get durableCount(): number {
    return this.count;
  }

  /**
   * Retained window size, for deterministic bound tests.
   *
   * Counts rows that carry a PAYLOAD. An omitted row holds a cursor boundary
   * and nothing else, so counting it here would report a window larger than the
   * one a client receives.
   */
  get retainedMessages(): number {
    let retained = 0;
    for (const entry of this.tail) if (entry.json !== undefined) retained += 1;
    return retained;
  }

  /**
   * Retained rows kept only as a bounded, shortened stand-in.
   *
   * Threaded outward so the frame's own gap notice can state, in the client's
   * language, that some of the newest messages were shortened.
   */
  get clippedMessages(): number {
    let clipped = 0;
    for (const entry of this.tail) if (entry.clipped) clipped += 1;
    return clipped;
  }

  /**
   * Rows inside the retained window that carry no payload at all.
   *
   * A message too large to send whose variant no stand-in may be built for. The
   * frame must admit these: they are counted in `truncated.total` and in the
   * cursor chain, so silence would make `shown` and `total` disagree for no
   * stated reason.
   */
  get omittedMessages(): number {
    let omitted = 0;
    for (const entry of this.tail) {
      if (entry.json === undefined && !entry.withheld) omitted += 1;
    }
    return omitted;
  }

  /**
   * Rows withheld because a newer same-key state update could not be sent.
   *
   * Counted apart from {@link omittedMessages} on purpose: these rows were not
   * too large and the budget is not why they are missing. Replaying them would
   * assert superseded state as current, so the honest frame carries neither the
   * new value nor the old one, and says so with the right reason.
   */
  get withheldMessages(): number {
    let withheld = 0;
    for (const entry of this.tail) if (entry.withheld) withheld += 1;
    return withheld;
  }

  /** Withheld because a newer same-key update could not be sent (round 5). */
  get supersededMessages(): number {
    let superseded = 0;
    for (const entry of this.tail) {
      if (entry.withheld === 'superseded') superseded += 1;
    }
    return superseded;
  }

  /**
   * State rows withheld because a skipped native record makes them unverifiable.
   *
   * A separate reason from supersession, and the prose has to say so: nothing
   * newer was seen for these keys, the capture simply could not read part of
   * the source and therefore cannot prove these are still current. Both reasons
   * add up to {@link withheldMessages}, which is the honest total.
   */
  get unverifiedStateMessages(): number {
    let unverified = 0;
    for (const entry of this.tail) {
      if (entry.withheld === 'unverified') unverified += 1;
    }
    return unverified;
  }

  /**
   * Every byte this sink would hand to a client, across all three retentions.
   *
   * This is the number {@link maxBytes} actually bounds, so a test that pins it
   * pins the real replay payload rather than one contributor to it.
   */
  get retainedBytes(): number {
    return this.tailBytes + this.projectionBytes + this.derivedBytes;
  }

  accept(message: AgentMessage): boolean {
    if (!isCursorDurableMessage(message)) {
      const key = `${message.type}\0${(message as { key?: string }).key ?? ''}`;
      const json = JSON.stringify(message);
      const previous = this.derived.get(key);
      if (previous) this.derivedBytes -= previous.bytes;
      this.derived.delete(key);
      const bytes = tailEntryBytes(json);
      this.derived.set(key, { json, bytes });
      this.derivedBytes += bytes;
      while (this.derived.size > HISTORY_PAGE_CACHE_MAX_PROJECTION_ENTRIES) {
        if (!this.evictOldestDerived()) break;
      }
      this.evictToBudget();
      return true;
    }
    // The cursor chain is folded from the REAL message, always and first, so a
    // clipped stand-in below cannot move a boundary hash. An append or a
    // reconnect resolves against exactly the same chain an index built from the
    // same prefix would produce.
    const index = this.count;
    this.latestHash = this.indexer.pushHash(message);
    this.count += 1;

    // A message that alone exceeds the whole payload budget cannot be retained
    // as-is and cannot be evicted around: paying for it costs every fitting row
    // before it and then it is dropped too, leaving a notice above an empty
    // transcript (H1c round 3, finding 3).
    //
    // Two answers, decided by VARIANT (round 4, finding 3). A message whose
    // shape survives shortening gets a bounded stand-in. Anything else -
    // task-list-state, question-request, metadata-update, tool-result, and
    // every variant not explicitly cleared - is OMITTED: it keeps its place
    // and its cursor boundary but carries no payload, because a stand-in with
    // a required structured field missing decodes to nothing on the client and
    // is strictly worse than an honest hole. Either way the window around it
    // survives, which is the whole point.
    let retained = message;
    let json: string | undefined = JSON.stringify(message);
    let bytes = tailEntryBytes(json);
    let clipped = false;
    let omitted = false;
    if (bytes > this.maxBytes) {
      const substitute = clipMessageWithinBytes(
        message,
        Math.max(1, Math.floor(this.maxBytes * HISTORY_TAIL_OVERSIZED_ENTRY_SHARE)),
      );
      const substituteJson = substitute ? JSON.stringify(substitute) : undefined;
      if (substitute && substituteJson && tailEntryBytes(substituteJson) < bytes) {
        retained = substitute;
        json = substituteJson;
        bytes = tailEntryBytes(substituteJson);
        clipped = true;
      } else {
        // No substitute may be built. Omit the payload and charge nothing, so
        // `evictToBudget` has no reason to spend the fitting window on it.
        json = undefined;
        bytes = 0;
        omitted = true;
      }
    }

    const stateKey = tailStateProjectionKey(message);
    this.tail.push({
      json,
      hashAfter: this.latestHash,
      boundaryAfter: this.count,
      bytes,
      clipped,
      ...(stateKey !== undefined ? { stateKey } : {}),
    });
    this.tailBytes += bytes;

    if (stateKey !== undefined) {
      if (json !== undefined) {
        const previous = this.projections.get(stateKey);
        if (previous) this.projectionBytes -= previous.bytes;
        this.projections.delete(stateKey);
        this.projections.set(stateKey, { index, json, bytes });
        this.projectionBytes += bytes;
        while (this.projections.size > HISTORY_PAGE_CACHE_MAX_PROJECTION_ENTRIES) {
          if (!this.evictOldestProjection()) break;
        }
      } else {
        // The newest value of this state key could not be sent. Leaving the
        // older same-key projection registered, and the older same-key row
        // replayable, made the frame present SUPERSEDED state as current: a
        // 400-item plan that outgrew the budget replayed as the one-item plan
        // it replaced (round 5, blocker 1). Silence about the newest value is
        // honest; asserting the old one is not.
        this.supersedeState(stateKey);
      }
    }
    if (
      (message.type === 'model-output' || message.type === 'thinking')
      && message.key
    ) {
      const key = `${message.type}:${message.key}`;
      // The RETAINED text, not the original: this map answers "how much of this
      // message has the client already got", and after a clip that is the
      // stand-in's length - after an omission, nothing at all. Claiming the
      // original would over-report an overlap the client was never sent.
      const retainedText = omitted
        ? undefined
        : (retained as { text?: unknown }).text;
      const text = typeof retainedText === 'string' ? retainedText : '';
      this.overlap.delete(key);
      this.overlap.set(key, text.length);
      while (this.overlap.size > HISTORY_PAGE_CACHE_MAX_OVERLAP_ENTRIES) {
        const oldest = this.overlap.keys().next();
        if (oldest.done) break;
        this.overlap.delete(oldest.value);
      }
    }

    this.evictToBudget();
    return true;
  }

  private evictOldestDerived(): boolean {
    const oldest = this.derived.entries().next();
    if (oldest.done) return false;
    this.derivedBytes -= oldest.value[1].bytes;
    this.derived.delete(oldest.value[0]);
    return true;
  }

  /**
   * Blank one retained row's payload, keeping its position in the chain.
   *
   * The entry keeps its boundary and hash, so the cursor arithmetic in
   * {@link BoundedTailHistoryReplay.hashAt} is untouched; only the bytes and
   * the payload go. Retraction safety is latched by the operation that caused
   * the withholding; it cannot be inferred from this row's cursor position
   * because live delivery does not advance the stored history cursor.
   */
  private withholdEntry(entry: TailEntry, reason: TailWithheldReason): void {
    if (entry.json !== undefined) {
      this.tailBytes -= entry.bytes;
      entry.bytes = 0;
      entry.json = undefined;
      // No longer a stand-in either: nothing of it is being sent.
      entry.clipped = false;
    }
    entry.withheld = reason;
  }

  /**
   * Drop every retained trace of one state key whose newest value cannot ship.
   *
   * Unregisters the enrichment projection and blanks the payload of any older
   * same-key rows still in the window. Bounded work: the tail is at most
   * `maxMessages` long and this runs only when a state update is unsendable.
   */
  private supersedeState(stateKey: string): void {
    // Latch even when the older row has left the bounded tail and survives only
    // as projection enrichment. A client may already hold that projection, and
    // the next incremental frame has no tombstone with which to retract it.
    this.stateRetractionLatched = true;
    const projection = this.projections.get(stateKey);
    if (projection) {
      this.projectionBytes -= projection.bytes;
      this.projections.delete(stateKey);
    }
    for (const entry of this.tail) {
      if (entry.stateKey !== stateKey || entry.json === undefined) continue;
      this.withholdEntry(entry, 'superseded');
    }
  }

  /**
   * Give up every latest-wins state claim this capture cannot vouch for.
   *
   * Called when the adapter skipped a native record (round 6, P1-2). A skipped
   * record is invisible to this sink: it never reaches `accept`, so a newer
   * `update_plan` inside it cannot supersede anything, and the older projection
   * would replay as CURRENT. The sink cannot tell which keys the unread bytes
   * touched, so it fails closed on all of them.
   *
   * Transcript rows are deliberately untouched. They are positional and their
   * absence is already reported truthfully by the skipped-record count; only
   * latest-wins state asserts currency, and only that claim is unsafe here.
   */
  suppressStateAuthority(): void {
    this.stateAuthorityUnverified = true;
    for (const [, projection] of this.projections) {
      this.projectionBytes -= projection.bytes;
    }
    this.projections.clear();
    for (const entry of this.tail) {
      if (entry.stateKey === undefined || entry.json === undefined) continue;
      this.withholdEntry(entry, 'unverified');
    }
  }

  private evictOldestProjection(): boolean {
    const oldest = this.projections.entries().next();
    if (oldest.done) return false;
    this.projectionBytes -= oldest.value[1].bytes;
    this.projections.delete(oldest.value[0]);
    return true;
  }

  /**
   * Spend the shared payload budget cheapest-first.
   *
   * Activity overlays are decoration, state projections are enrichment, and the
   * tail is the transcript itself — so they are given up in that order. The
   * tail is a contiguous suffix ending at the newest message, so the longest
   * suffix that fits is the best answer available.
   *
   * Entries that alone exceed the budget never reach this loop intact: `accept`
   * has already replaced them with a marked stand-in sized to a share of the
   * budget, so eviction can no longer be forced to spend the entire fitting
   * window on one row and then discard that row as well. What remains here is
   * ordinary oldest-first eviction, including the genuinely starved case where
   * not even a stand-in fits — an empty tail is then the honest answer, not one
   * row that silently breaks the bound and that the client's own identical
   * window budget would drop on arrival.
   */
  private evictToBudget(): void {
    while (this.tail.length > this.maxMessages) this.evictOldestTail();
    if (this.retainedBytes <= this.maxBytes) return;
    while (this.retainedBytes > this.maxBytes && this.evictOldestDerived()) {
      /* decoration first */
    }
    while (this.retainedBytes > this.maxBytes && this.evictOldestProjection()) {
      /* then enrichment */
    }
    while (this.retainedBytes > this.maxBytes && this.tail.length > 0) {
      this.evictOldestTail();
    }
  }

  private evictOldestTail(): void {
    const evicted = this.tail.shift();
    if (!evicted) return;
    this.tailBytes -= evicted.bytes;
    this.headBoundary = evicted.boundaryAfter;
    this.headHash = evicted.hashAfter;
  }

  /** The finished bounded replay for one captured prefix. */
  finish(
    sourceIdentity: Readonly<HistorySourceIdentity>,
  ): BoundedTailHistoryReplay {
    return new BoundedTailHistoryReplay({
      sourceIdentity,
      stateAuthorityUnverified: this.stateAuthorityUnverified,
      stateRetractionLatched: this.stateRetractionLatched,
      tail: this.tail,
      derived: [...this.derived.values()].map((entry) => entry.json),
      projections: [...this.projections.values()]
        .sort((left, right) => left.index - right.index),
      overlap: this.overlap,
      count: this.count,
      headBoundary: this.headBoundary,
      headHash: this.headHash,
      latestHash: this.latestHash,
    });
  }
}

/**
 * A bounded newest-tail replay, with no older-page capability.
 *
 * The cursor it issues is the ordinary reconnect cursor for the FULL captured
 * prefix, so a later attach whose index does fit resolves it normally, and a
 * later fallback resolves it incrementally whenever it still lands inside the
 * retained window.
 */
export class BoundedTailHistoryReplay {
  readonly sourceIdentity: Readonly<HistorySourceIdentity>;
  private readonly tail: readonly TailEntry[];
  private readonly derivedJson: readonly string[];
  private readonly projections: readonly TailProjection[];
  private readonly overlap: ReadonlyMap<string, number>;
  private readonly count: number;
  private readonly headBoundary: number;
  private readonly headHash: string;
  private readonly latestHash: string;
  private readonly stateRetractionLatched: boolean;
  private readonly stateAuthorityUnverifiedFlag: boolean;

  constructor(parts: {
    sourceIdentity: Readonly<HistorySourceIdentity>;
    tail: readonly TailEntry[];
    derived: readonly string[];
    projections: readonly TailProjection[];
    overlap: ReadonlyMap<string, number>;
    count: number;
    headBoundary: number;
    headHash: string;
    latestHash: string;
    stateRetractionLatched?: boolean;
    stateAuthorityUnverified?: boolean;
  }) {
    this.sourceIdentity = Object.freeze({ ...parts.sourceIdentity });
    this.tail = [...parts.tail];
    this.derivedJson = [...parts.derived];
    this.projections = [...parts.projections];
    this.overlap = new Map(parts.overlap);
    this.count = parts.count;
    this.headBoundary = parts.headBoundary;
    this.headHash = parts.headHash;
    this.latestHash = parts.latestHash;
    this.stateRetractionLatched = parts.stateRetractionLatched === true;
    this.stateAuthorityUnverifiedFlag = parts.stateAuthorityUnverified === true;
  }

  /** A skipped native record left every latest-wins state claim unprovable. */
  get stateAuthorityUnverified(): boolean {
    return this.stateAuthorityUnverifiedFlag;
  }

  /**
   * Whether an incremental frame could leave stale state on screen.
   *
   * `supersedeState` and `suppressStateAuthority` remove a stale row from THIS
   * capture's payload, but a reconnecting client was given that row by an
   * EARLIER capture and an incremental frame never retracts anything. So the
   * frame has to escalate to a replacement whenever the client may be holding a
   * row this capture has since withheld (round 6, P1-1).
   *
   * The ordinary cursor cannot narrow that question: live state messages are
   * appended without advancing the stored history cursor. Any unsendable state
   * update therefore latches retraction for the capture, including one whose
   * older value survives only as projection enrichment. A skipped native record
   * also fails closed because every state key becomes unverifiable.
   *
   * CLIPPED rows deliberately do not trigger this. The client's earlier full
   * copy is strictly better than the stand-in and is not semantically stale, so
   * escalating for a mere clip would make reconnect expensive for no gain.
   */
  private stateRetractionRequired(): boolean {
    return this.stateRetractionLatched || this.stateAuthorityUnverifiedFlag;
  }

  /** Total durable messages in the captured prefix. */
  get durableCount(): number {
    return this.count;
  }

  /** Retained rows kept only as a bounded, shortened stand-in. */
  get clippedMessages(): number {
    let clipped = 0;
    for (const entry of this.tail) if (entry.clipped) clipped += 1;
    return clipped;
  }

  /** Retained rows too large to send that no stand-in may be built for. */
  get omittedMessages(): number {
    let omitted = 0;
    for (const entry of this.tail) {
      if (entry.json === undefined && !entry.withheld) omitted += 1;
    }
    return omitted;
  }

  /** Retained rows whose payload was withheld, for either reason. */
  get withheldMessages(): number {
    let withheld = 0;
    for (const entry of this.tail) if (entry.withheld) withheld += 1;
    return withheld;
  }

  /** Withheld because a newer same-key state update could not ship. */
  get supersededMessages(): number {
    let superseded = 0;
    for (const entry of this.tail) {
      if (entry.withheld === 'superseded') superseded += 1;
    }
    return superseded;
  }

  /** State rows withheld because a skipped record makes them unverifiable. */
  get unverifiedStateMessages(): number {
    let unverified = 0;
    for (const entry of this.tail) {
      if (entry.withheld === 'unverified') unverified += 1;
    }
    return unverified;
  }

  /**
   * Hash of the boundary at [boundary], or undefined when it was evicted.
   *
   * Positional arithmetic, which is why an omitted message still occupies a
   * tail slot: removing it would shift every later entry and silently resolve
   * every cursor behind it to the wrong hash.
   */
  private hashAt(boundary: number): string | undefined {
    if (boundary === this.headBoundary) return this.headHash;
    if (boundary < this.headBoundary || boundary > this.count) return undefined;
    return this.tail[boundary - this.headBoundary - 1]?.hashAfter;
  }

  /**
   * One bounded attach frame.
   *
   * Never returns an authoritative empty replay for a non-empty history, and
   * never issues an older cursor it cannot serve.
   */
  attach(since: string | undefined, max: number): CompactHistoryAttach {
    const parsed = historyCursorParts(since);
    let reset = true;
    let start = this.headBoundary;
    let gap: CompactHistoryAttach['gap'];
    if (parsed === null) {
      gap = {
        reason: 'invalid-cursor',
        code: 'HISTORY_CURSOR_INVALID',
        message: 'history cursor is invalid; the newest available history was sent',
        ...(since ? { since } : {}),
      };
    } else if (parsed) {
      const hash = this.hashAt(parsed.boundary);
      if (
        !Number.isInteger(parsed.boundary)
        || parsed.boundary < 0
        || parsed.boundary > this.count
      ) {
        gap = {
          reason: 'cursor-out-of-range',
          code: 'HISTORY_CURSOR_GONE',
          message: 'history cursor is outside the retained session history; the newest available history was sent',
          ...(since ? { since } : {}),
        };
      } else if (hash === undefined) {
        // Inside the prefix but older than the retained window. This is NOT a
        // divergence: the cursor is still valid, the broker simply cannot
        // prove it here. Reported as out-of-range so the client keeps a
        // truthful "there is more, it cannot be reached" boundary.
        gap = {
          reason: 'cursor-out-of-range',
          code: 'HISTORY_CURSOR_GONE',
          message: 'history cursor is older than the newest window this session can serve; the newest available history was sent',
          ...(since ? { since } : {}),
        };
      } else if (hash !== parsed.hash) {
        gap = {
          reason: 'cursor-prefix-mismatch',
          code: 'HISTORY_CURSOR_DIVERGED',
          message: 'history cursor no longer matches this session; the newest available history was sent',
          ...(since ? { since } : {}),
        };
      } else {
        start = parsed.boundary;
        reset = false;
      }
    }

    // An incremental frame adds messages; it never retracts one. If this
    // capture withheld state the client may have seen in history or live,
    // staying incremental leaves that stale row on screen forever. Escalate to
    // a replacement window instead: the client's copy is replaced wholesale, so
    // nothing this capture cannot vouch for survives the reconnect.
    if (!reset && this.stateRetractionRequired()) {
      reset = true;
      start = this.headBoundary;
    }

    const boundedMax = Math.min(
      HISTORY_PAGE_CACHE_MAX_PAGE_MESSAGES,
      Number.isFinite(max) && max > 0 ? Math.max(1, Math.trunc(max)) : 100,
    );
    // The retained tail wins every slot it needs, and only then does projection
    // enrichment spend what is left. The previous fixed point sized the window
    // from the FULL history index while the tail had already been byte-evicted,
    // so ten older projections in front of a three-message tail consumed all
    // five slots and the two newest messages were dropped from the frame
    // outright. Nothing may displace the newest messages — they are the entire
    // reason this path exists.
    const shownStart = Math.max(
      start,
      this.headBoundary,
      this.count - boundedMax,
    );
    if (shownStart > start) reset = true;

    // Omitted rows drop out here and nowhere else. They stay in `this.tail` so
    // the boundary arithmetic above keeps working, but they have no payload to
    // send, so they are simply not part of the frame (H1c round 4, finding 3).
    const shownTail = this.tail.slice(shownStart - this.headBoundary);
    const tailJson = shownTail
      .map((entry) => entry.json)
      .filter((json): json is string => json !== undefined);
    // Genuinely free slots only — and never more of them than the indexed path
    // allows either. A byte-evicted three-row tail leaves 497 slots free in a
    // 500-message request, and filling all of them turns a transcript frame
    // into a wall of stale state rows. One allowance, stated once, governs both
    // attach paths (H1c round 3).
    const freeSlots = Math.min(
      HISTORY_PAGE_CACHE_MAX_ATTACH_PROJECTIONS,
      Math.max(0, boundedMax - tailJson.length),
    );
    const projectionJson = reset && freeSlots > 0
      ? this.projections
          .filter((projection) => projection.index < shownStart)
          .slice(-freeSlots)
          .map((projection) => projection.json)
      : [];

    const messages = [...projectionJson, ...tailJson]
      .map((json) => JSON.parse(json) as AgentMessage);

    // Only a REPLACEMENT frame describes a window; an incremental delta says
    // nothing about how much history exists, and claiming otherwise would put
    // "Showing the newest N of M" on a frame carrying three new messages.
    const truncated = reset && (shownStart > 0 || messages.length < this.count)
      ? { shown: messages.length, total: this.count }
      : undefined;
    return {
      messages,
      derivedMessages: this.derivedJson.map(
        (json) => JSON.parse(json) as AgentMessage,
      ),
      reset,
      cursor: historyCursorFromHash(this.count, this.latestHash),
      ...(gap ? { gap } : {}),
      ...(truncated ? { truncated } : {}),
      // Deliberately NO `olderCursor`: without an index there is no boundary
      // this broker can serve, and issuing one would offer a reload that can
      // only ever fail.
      hasEarlier: Boolean(truncated),
      deliveredText: reset
        ? deliveredTextFrom(messages)
        : new Map(this.overlap),
    };
  }
}

/** Text identities proven to be present in one reset frame. */
function deliveredTextFrom(
  messages: readonly AgentMessage[],
): ReadonlyMap<string, number> {
  const delivered = new Map<string, number>();
  for (const message of messages) {
    if (
      (message.type !== 'model-output' && message.type !== 'thinking')
      || !message.key
    ) continue;
    const key = `${message.type}:${message.key}`;
    const length = typeof message.text === 'string' ? message.text.length : 0;
    delivered.set(key, Math.max(delivered.get(key) ?? 0, length));
  }
  return delivered;
}

export type HistoryPageCache =
  | EncodedHistoryPageCache
  | IndexedHistoryPageCache;

type CacheEntry = {
  scope: string;
  cache: HistoryPageCache;
  touchedAt: number;
  generation: number;
  expiry?: ReturnType<typeof setTimeout>;
};

type CacheBuild = {
  sourceIdentity: Readonly<HistorySourceIdentity>;
  promise: Promise<HistoryPageCache | undefined>;
};

/**
 * Small broker-wide LRU for active paging sessions.
 *
 * Entries are replaced on source identity changes, evicted under both count
 * and encoded-byte caps, and removed by a one-shot idle expiry. There is no
 * polling or periodic cleanup task.
 */
export class HistoryPageCachePool {
  private readonly entries = new Map<string, CacheEntry>();
  private totalBytes = 0;
  private generation = 0;
  private readonly builds = new Map<string, CacheBuild>();

  constructor(
    private readonly maxEntries = HISTORY_PAGE_CACHE_MAX_ENTRIES,
    private readonly maxTotalBytes = HISTORY_PAGE_CACHE_MAX_TOTAL_BYTES,
    private readonly idleTtlMs = HISTORY_PAGE_CACHE_IDLE_TTL_MS,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get encodedBytes(): number {
    return this.totalBytes;
  }

  get(
    scope: string,
    sourceIdentity: Readonly<HistorySourceIdentity>,
  ): HistoryPageCache | undefined {
    const entry = this.entries.get(scope);
    if (!entry) return undefined;
    if (!historySourceStillContainsSnapshot(
      entry.cache.sourceIdentity,
      sourceIdentity,
    )) {
      this.delete(scope);
      return undefined;
    }
    entry.touchedAt = Date.now();
    entry.generation = ++this.generation;
    this.armExpiry(entry);
    return entry.cache;
  }

  /**
   * Returns only a cache built from [sourceIdentity] itself.
   *
   * An append ancestor remains useful for an older client's prefix cursor, but
   * it cannot resolve a newer truncated attach cursor beyond its last
   * boundary. Exact lookup leaves that ancestor resident while one
   * single-flight current build is in progress.
   */
  getExact(
    scope: string,
    sourceIdentity: Readonly<HistorySourceIdentity>,
  ): HistoryPageCache | undefined {
    const entry = this.entries.get(scope);
    if (!entry) return undefined;
    if (!historySourceStillContainsSnapshot(
      entry.cache.sourceIdentity,
      sourceIdentity,
    )) {
      this.delete(scope);
      return undefined;
    }
    if (!sameHistorySourceIdentity(
      entry.cache.sourceIdentity,
      sourceIdentity,
    )) {
      return undefined;
    }
    entry.touchedAt = Date.now();
    entry.generation = ++this.generation;
    this.armExpiry(entry);
    return entry.cache;
  }

  put(scope: string, cache: HistoryPageCache): boolean {
    if (
      this.maxEntries <= 0
      || cache.encodedBytes > this.maxTotalBytes
    ) {
      return false;
    }
    this.delete(scope);
    const entry: CacheEntry = {
      scope,
      cache,
      touchedAt: Date.now(),
      generation: ++this.generation,
    };
    this.entries.set(scope, entry);
    this.totalBytes += cache.encodedBytes;
    this.armExpiry(entry);
    this.evictToBounds();
    return this.entries.get(scope) === entry;
  }

  /** Builds at most one native snapshot per scope/source revision. */
  async getOrCreate<T extends HistoryPageCache>(
    scope: string,
    sourceIdentity: Readonly<HistorySourceIdentity>,
    create: () => Promise<T | undefined>,
    options?: { exact?: boolean },
  ): Promise<T | undefined>;
  async getOrCreate(
    scope: string,
    sourceIdentity: Readonly<HistorySourceIdentity>,
    create: () => Promise<HistoryPageCache | undefined>,
    options: { exact?: boolean } = {},
  ): Promise<HistoryPageCache | undefined> {
    const exact = options.exact === true;
    const cached = exact
      ? this.getExact(scope, sourceIdentity)
      : this.get(scope, sourceIdentity);
    if (cached) return cached;
    const inFlight = this.builds.get(scope);
    if (
      inFlight
      && (exact
        ? sameHistorySourceIdentity(inFlight.sourceIdentity, sourceIdentity)
        : historySourceStillContainsSnapshot(
            inFlight.sourceIdentity,
            sourceIdentity,
          ))
    ) {
      return inFlight.promise;
    }
    const promise = create().then((cache) => {
      const current = this.builds.get(scope);
      if (current?.promise !== promise) return undefined;
      if (cache) this.put(scope, cache);
      return cache;
    }).finally(() => {
      const current = this.builds.get(scope);
      if (current?.promise === promise) this.builds.delete(scope);
    });
    this.builds.set(scope, {
      sourceIdentity: Object.freeze({ ...sourceIdentity }),
      promise,
    });
    return promise;
  }

  delete(scope: string): void {
    const entry = this.entries.get(scope);
    if (!entry) return;
    entry.expiry && clearTimeout(entry.expiry);
    this.entries.delete(scope);
    this.totalBytes -= entry.cache.encodedBytes;
  }

  clear(): void {
    for (const scope of [...this.entries.keys()]) this.delete(scope);
    this.builds.clear();
  }

  private armExpiry(entry: CacheEntry): void {
    if (entry.expiry) clearTimeout(entry.expiry);
    if (this.idleTtlMs <= 0) {
      this.delete(entry.scope);
      return;
    }
    const generation = entry.generation;
    entry.expiry = setTimeout(() => {
      const current = this.entries.get(entry.scope);
      if (current === entry && current.generation === generation) {
        this.delete(entry.scope);
      }
    }, this.idleTtlMs);
    entry.expiry.unref?.();
  }

  private evictToBounds(): void {
    while (
      this.entries.size > this.maxEntries
      || this.totalBytes > this.maxTotalBytes
    ) {
      let oldest: CacheEntry | undefined;
      for (const entry of this.entries.values()) {
        if (!oldest || entry.generation < oldest.generation) oldest = entry;
      }
      if (!oldest) return;
      this.delete(oldest.scope);
    }
  }
}
