/**
 * H1b scalable Codex paging.
 *
 * The synthetic fixture deterministically normalizes past 32 MiB and exposes
 * more than 200 consecutive 100-message pages, and always runs. The real-host
 * half is opt-in and never discovered: see resolveRealRollout below.
 */
import { strict as assert } from 'node:assert';
import {
  appendFileSync,
  closeSync,
  existsSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type {
  AgentMessage,
  HistorySnapshotSink,
} from '../../../adapter-api/src/index.ts';
import {
  captureFileHistoryInto,
} from '../../../adapters/codex/src/index.ts';
import {
  backwardHistoryCursorFromHash,
} from '../../src/sessions/history-delta.ts';
import {
  HISTORY_PAGE_CACHE_MAX_ENTRY_BYTES,
  HISTORY_PAGE_CACHE_MAX_INDEX_BYTES,
  HistoryPageCachePool,
  historySourceStillContainsSnapshot,
  IndexedHistoryPageCacheBuilder,
  type IndexedHistoryPageCache,
} from '../../src/sessions/history-page-cache.ts';

const PAGE_MESSAGES = 100;
const SYNTHETIC_MESSAGES = 20_600;
const MIN_CONSECUTIVE_PAGES = 200;
const REAL_ROLLOUT_FLAG = 'COSYNCING_TEST_REAL_ROLLOUT';
const REAL_ROLLOUT_PATH = 'COSYNCING_TEST_REAL_ROLLOUT_PATH';

/**
 * The operator-supplied real rollout, or nothing.
 *
 * Reading a real Codex session requires BOTH an explicit opt-in flag and an
 * explicit absolute path. Nothing is ever discovered from a home directory, so
 * no operator's own session path can enter this tree or be read by accident.
 * Neither variable set is the default: the real-host block below skips and the
 * hermetic proof still runs in full. Exactly one variable set is a
 * configuration error rather than a silent skip — a half-configured opt-in
 * would otherwise quietly stop covering the thing it was set up to cover.
 */
function resolveRealRollout(): string | undefined {
  const flag = process.env[REAL_ROLLOUT_FLAG] ?? '';
  const path = process.env[REAL_ROLLOUT_PATH] ?? '';
  const optedIn = flag !== '' && flag !== '0' && flag.toLowerCase() !== 'false';
  const pinned = path !== '';
  if (!optedIn && !pinned) return undefined;
  if (optedIn !== pinned) {
    throw new Error(
      `real-rollout opt-in is half-configured (${REAL_ROLLOUT_FLAG}=`
      + `${JSON.stringify(flag)}, ${REAL_ROLLOUT_PATH}=${JSON.stringify(path)}`
      + `): set BOTH ${REAL_ROLLOUT_FLAG}=1 and ${REAL_ROLLOUT_PATH}=`
      + '<absolute path to a rollout .jsonl>, or neither. '
      + `An unset, empty, "0" or "false" ${REAL_ROLLOUT_FLAG} counts as off.`,
    );
  }
  if (!isAbsolute(path)) {
    throw new Error(`${REAL_ROLLOUT_PATH} must be absolute, got ${JSON.stringify(path)}`);
  }
  if (!existsSync(path)) {
    throw new Error(`${REAL_ROLLOUT_PATH} does not exist: ${path}`);
  }
  return path;
}

const REAL_FIXTURE = resolveRealRollout();

type CaptureMeasurement = {
  cache: IndexedHistoryPageCache;
  normalizedBytes: number;
};

async function captureIndexed(
  path: string,
  hooks?: Parameters<typeof captureFileHistoryInto>[3],
): Promise<CaptureMeasurement> {
  const builder = new IndexedHistoryPageCacheBuilder();
  let normalizedBytes = 0;
  const sink: HistorySnapshotSink = {
    acceptsLocations: true,
    accept(message: AgentMessage, location?: number): boolean {
      normalizedBytes += Buffer.byteLength(JSON.stringify(message), 'utf8');
      return builder.accept(message, location);
    },
  };
  const captured = await captureFileHistoryInto(path, sink, undefined, hooks);
  assert(captured && !('refusal' in captured), 'native index capture must succeed');
  assert(captured.reader, 'location capture must return its random-access reader');
  const cache = builder.finish(captured.identity, captured.reader);
  assert(cache, 'compact Codex metadata must fit the named index budget');
  return { cache, normalizedBytes };
}

async function pageToStart(
  cache: IndexedHistoryPageCache,
  olderCursor: string,
): Promise<{ pages: number; messages: number; maxRecords: number; maxBytes: number }> {
  let cursor: string | undefined = olderCursor;
  let pages = 0;
  let messages = 0;
  let maxRecords = 0;
  let maxBytes = 0;
  while (cursor) {
    const page = await cache.loadPage(cursor, PAGE_MESSAGES);
    assert(!('kind' in page), `native page failed: ${JSON.stringify(page)}`);
    assert(!page.gap, `issued cursor diverged: ${JSON.stringify(page.gap)}`);
    assert(page.messages.length <= PAGE_MESSAGES, 'one page exceeded 100 messages');
    pages += 1;
    messages += page.messages.length;
    const work = cache.lastReadWork;
    assert(work, 'native page must report bounded read work');
    maxRecords = Math.max(maxRecords, work.recordsRead);
    maxBytes = Math.max(maxBytes, work.bytesRead);
    assert(
      work.recordsRead <= 4_096,
      `page reread ${work.recordsRead} records instead of its bounded range`,
    );
    assert(
      work.bytesRead < HISTORY_PAGE_CACHE_MAX_ENTRY_BYTES,
      `page decoded ${work.bytesRead} bytes`,
    );
    cursor = page.cursor;
    if (!page.hasMore) {
      assert(page.endOfHistory && !page.cursor, 'true start must be authoritative');
    }
  }
  return { pages, messages, maxRecords, maxBytes };
}

const temp = mkdtempSync('/tmp/cosyncing-h1b-large-');
const synthetic = join(temp, 'rollout-large.jsonl');
try {
  const fd = openSync(synthetic, 'w');
  try {
    for (let base = 0; base < SYNTHETIC_MESSAGES; base += 400) {
      const rows: string[] = [];
      for (
        let index = base;
        index < Math.min(base + 400, SYNTHETIC_MESSAGES);
        index += 1
      ) {
        rows.push(JSON.stringify({
          timestamp: '2026-07-28T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: `large row ${index} ${'x'.repeat(1_700)}`,
          },
        }));
      }
      writeSync(fd, `${rows.join('\n')}\n`);
    }
  } finally {
    closeSync(fd);
  }

  const measured = await captureIndexed(synthetic);
  assert(
    measured.normalizedBytes > HISTORY_PAGE_CACHE_MAX_ENTRY_BYTES,
    `fixture normalized to only ${measured.normalizedBytes} bytes`,
  );
  assert(
    measured.cache.encodedBytes <= HISTORY_PAGE_CACHE_MAX_INDEX_BYTES,
    'retained compact index exceeded its explicit per-entry bound',
  );
  const retentionPool = new HistoryPageCachePool();
  let indexBuilds = 0;
  const coalesced = await Promise.all([
    retentionPool.getOrCreate(
      'large',
      measured.cache.sourceIdentity,
      async () => {
        indexBuilds += 1;
        await Bun.sleep(1);
        return measured.cache;
      },
      { exact: true },
    ),
    retentionPool.getOrCreate(
      'large',
      measured.cache.sourceIdentity,
      async () => {
        indexBuilds += 1;
        return measured.cache;
      },
      { exact: true },
    ),
  ]);
  assert.equal(indexBuilds, 1, 'concurrent index construction must single-flight');
  assert(coalesced.every((cache) => cache === measured.cache));
  assert.equal(retentionPool.size, 1);
  assert.equal(retentionPool.encodedBytes, measured.cache.encodedBytes);
  retentionPool.clear();

  const attach = await measured.cache.loadAttach(undefined, PAGE_MESSAGES);
  assert(!('kind' in attach), `bounded attach failed: ${JSON.stringify(attach)}`);
  assert.equal(attach.messages.length, PAGE_MESSAGES);
  assert.equal(attach.truncated?.total, SYNTHETIC_MESSAGES);
  assert(attach.olderCursor, 'truncated attach must issue an older cursor');
  assert(
    (measured.cache.lastReadWork?.recordsRead ?? Infinity)
      <= 2 * PAGE_MESSAGES + 1,
    'initial newest-100 attach read the complete rollout',
  );
  const firstCursor = attach.olderCursor;
  const paged = await pageToStart(measured.cache, firstCursor);
  assert(
    paged.pages >= MIN_CONSECUTIVE_PAGES,
    `only ${paged.pages} consecutive older pages were reachable`,
  );
  assert.equal(paged.messages, SYNTHETIC_MESSAGES - PAGE_MESSAGES);
  assert(
    paged.maxRecords <= 2 * PAGE_MESSAGES + 1,
    'plain-message pages must read only their records plus one-line lookahead',
  );

  // A truncate after the reader's identity/prefix check but before its first
  // native record read is source movement, not page-budget exhaustion. The
  // broker may retry this outcome on the same socket; a resource limit would
  // be cached as terminal for the source revision.
  const moving = join(temp, 'rollout-moving.jsonl');
  writeFileSync(
    moving,
    `${Array.from({ length: 180 }, (_, index) => JSON.stringify({
      timestamp: '2026-07-28T00:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: `moving row ${index} ${'m'.repeat(256)}`,
      },
    })).join('\n')}\n`,
  );
  let truncatedDuringPageRead = false;
  const movingCapture = await captureIndexed(moving, {
    beforePageRecordReads: () => {
      if (truncatedDuringPageRead) return;
      truncatedDuringPageRead = true;
      const movingFd = openSync(moving, 'r+');
      try {
        ftruncateSync(movingFd, 128);
      } finally {
        closeSync(movingFd);
      }
    },
  });
  const movingAttach = await movingCapture.cache.loadAttach(
    undefined,
    PAGE_MESSAGES,
  );
  assert(
    'kind' in movingAttach && movingAttach.kind === 'source-changed',
    `truncate-between-check-and-read became terminal: ${JSON.stringify(movingAttach)}`,
  );

  // An append does not invalidate any cursor inside the immutable captured
  // prefix, and the same reader remains usable.
  appendFileSync(
    synthetic,
    `${JSON.stringify({
      timestamp: '2026-07-28T00:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'active append' },
    })}\n`,
  );
  const afterAppend = await captureIndexed(synthetic);
  assert(
    historySourceStillContainsSnapshot(
      measured.cache.sourceIdentity,
      afterAppend.cache.sourceIdentity,
    ),
    'an append must preserve the captured prefix',
  );
  const appendPage = await measured.cache.loadPage(firstCursor, PAGE_MESSAGES);
  assert(!('kind' in appendPage), 'old prefix cursor must survive an append');

  // Forged hash, same-size rewrite, and shrink/compaction all fail closed.
  const divergent = await measured.cache.loadPage(
    backwardHistoryCursorFromHash(SYNTHETIC_MESSAGES - PAGE_MESSAGES, 'forged'),
    PAGE_MESSAGES,
  );
  assert(
    !('kind' in divergent)
      && divergent.gap?.code === 'HISTORY_CURSOR_DIVERGED',
    'cursor divergence must fail before native decoding',
  );
  const sizeAfterAppend = statSync(synthetic).size;
  const rewriteFd = openSync(synthetic, 'r+');
  try {
    writeSync(rewriteFd, Buffer.from('Y'), 0, 1, 160);
  } finally {
    closeSync(rewriteFd);
  }
  assert.equal(statSync(synthetic).size, sizeAfterAppend);
  const rewritten = await measured.cache.loadPage(firstCursor, PAGE_MESSAGES);
  assert(
    'kind' in rewritten && rewritten.kind === 'source-changed',
    'same-size rewrite must invalidate the retained reader',
  );

  const rewrittenCapture = await captureIndexed(synthetic);
  const rewrittenAttach = await rewrittenCapture.cache.loadAttach(
    undefined,
    PAGE_MESSAGES,
  );
  assert(!('kind' in rewrittenAttach) && rewrittenAttach.olderCursor);
  const compactFd = openSync(synthetic, 'r+');
  try {
    ftruncateSync(compactFd, Math.trunc(sizeAfterAppend / 2));
  } finally {
    closeSync(compactFd);
  }
  const compacted = await rewrittenCapture.cache.loadPage(
    rewrittenAttach.olderCursor,
    PAGE_MESSAGES,
  );
  assert(
    'kind' in compacted && compacted.kind === 'source-changed',
    'compaction must invalidate native locations',
  );

  const restartedPool = new HistoryPageCachePool();
  assert.equal(
    restartedPool.get('large', measured.cache.sourceIdentity),
    undefined,
    'restart must not resurrect an in-memory native index',
  );

  console.log(JSON.stringify({
    fixture: 'synthetic',
    sourceBytes: sizeAfterAppend,
    normalizedBytes: measured.normalizedBytes,
    retainedBytes: measured.cache.encodedBytes,
    durableMessages: attach.truncated?.total ?? attach.messages.length,
    pages: paged.pages,
    pagedMessages: paged.messages,
    maxPageRecordsRead: paged.maxRecords,
    maxPageBytesRead: paged.maxBytes,
  }));

  if (REAL_FIXTURE) {
    const real = await captureIndexed(REAL_FIXTURE);
    assert(
      real.normalizedBytes > HISTORY_PAGE_CACHE_MAX_ENTRY_BYTES,
      'the production fixture must exercise the former 32 MiB failure',
    );
    const realAttach = await real.cache.loadAttach(undefined, PAGE_MESSAGES);
    assert(!('kind' in realAttach), 'real fixture newest-100 attach must succeed');
    assert.equal(
      realAttach.messages.length,
      PAGE_MESSAGES,
      'real fixture projection enrichment must remain inside the attach bound',
    );
    assert(realAttach.olderCursor, 'real fixture must expose older history');
    const realPaged = await pageToStart(real.cache, realAttach.olderCursor);
    assert(realPaged.pages > 0 && realPaged.messages > 0);
    console.log(JSON.stringify({
      fixture: REAL_FIXTURE,
      sourceBytes: statSync(REAL_FIXTURE).size,
      normalizedBytes: real.normalizedBytes,
      retainedBytes: real.cache.encodedBytes,
      durableMessages:
        realAttach.truncated?.total ?? realAttach.messages.length,
      pages: realPaged.pages,
      pagedMessages: realPaged.messages,
      maxPageRecordsRead: realPaged.maxRecords,
      maxPageBytesRead: realPaged.maxBytes,
    }));
  } else {
    console.log(JSON.stringify({
      fixture: null,
      skipped:
        `real-rollout block skipped: set ${REAL_ROLLOUT_FLAG}=1 and `
        + `${REAL_ROLLOUT_PATH}=<absolute rollout .jsonl> to run it`,
    }));
  }

  console.log('PASS H1b compact source-native Codex history paging');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
