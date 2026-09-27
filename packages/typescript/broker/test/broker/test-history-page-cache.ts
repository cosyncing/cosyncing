/**
 * H1 deterministic resource proof for continuous backward history paging.
 *
 * Four large native fixtures are read through the real Codex, Claude,
 * OpenCode, and Pi history mappers once (the attach read), then every older
 * page is served from the bounded encoded cursor index. The test fails against
 * pre-H1 because that path had no reusable page cache and called
 * SessionConnection.getHistory() for every request.
 */
import type {
  AgentMessage,
  HistorySnapshotPageReader,
  HistorySourceIdentity,
} from '../../../adapter-api/src/index.ts';
import { mapTranscript } from '../../../adapters/claude/src/index.ts';
import { mapRollout } from '../../../adapters/codex/src/index.ts';
import { OpenCodeAdapter } from '../../../adapters/opencode/src/index.ts';
import { mapPiJsonlText } from '../../../adapters/pi/src/index.ts';
import { mapOpenCodePart } from '../../../opencode-wire/src/mapping.ts';
import {
  backwardHistoryCursor,
  backwardHistoryPage,
  backwardHistoryCursorBoundary,
  capHistoryDelta,
  capHistoryMessages,
  estimatedClientDecodedBytes,
  forwardHistoryPage,
  historyCursorFromHash,
  historyDelta,
  historyRefresh,
  holdRunningTurn,
  isBackwardPageMessage,
  runningTurnHoldEnd,
} from '../../src/sessions/history-delta.ts';
import {
  EncodedHistoryPageCache,
  EncodedHistoryPageCacheBuilder,
  HISTORY_PAGE_CACHE_MAX_ATTACH_PROJECTIONS,
  HISTORY_PAGE_CACHE_MAX_ENTRY_BYTES,
  HISTORY_PAGE_CACHE_MAX_ENTRY_MESSAGES,
  HISTORY_PAGE_CACHE_MAX_PAGE_MESSAGES,
  HistoryPageCachePool,
  HISTORY_PAGE_CACHE_MAX_PROJECTION_ENTRIES,
  historyFitsEncodedPageCache,
  IndexedHistoryPageCacheBuilder,
} from '../../src/sessions/history-page-cache.ts';
import { Database } from 'bun:sqlite';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

const FIXTURE_MESSAGES = 2_500;
const INITIAL_TAIL = 100;
type Tool = 'codex' | 'claude' | 'opencode' | 'pi';

const source = (
  sourceId: string,
  appendPosition: number,
  revision = `${appendPosition}`,
) => ({
  sourceId,
  revision,
  appendPosition,
  rewriteToken: `${sourceId}:prefix`,
});

function cacheFixture(tool: Tool): AgentMessage[] {
  return Array.from({ length: FIXTURE_MESSAGES }, (_, index) => {
    if (index % 97 === 0) {
      return {
        type: 'tool-result',
        callId: `${tool}-call-${index}`,
        toolName: 'read',
        result: `bounded preview ${index}`,
        diffRef: {
          fetchUrl: `https://invalid.example/${tool}/${index}`,
          contentHash: `${tool}-${index}`,
          byteSize: 1_000_000,
        },
      } as AgentMessage;
    }
    return {
      type: index % 2 === 0 ? 'user-message' : 'model-output',
      key: `${tool}-message-${index}`,
      text: `${tool} deterministic history row ${index} ${'x'.repeat(96)}`,
    } as AgentMessage;
  });
}

async function readNativeFixture(tool: Tool): Promise<{
  messages: AgentMessage[];
  nativeBytes: number;
}> {
  if (tool === 'codex') {
    const raw = Array.from({ length: FIXTURE_MESSAGES }, (_, index) =>
      JSON.stringify({
        timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: `codex native history row ${index} ${'x'.repeat(96)}`,
        },
      })).join('\n');
    const lines = raw.split('\n').map((line) => JSON.parse(line));
    return { messages: mapRollout(lines), nativeBytes: Buffer.byteLength(raw) };
  }
  if (tool === 'claude') {
    const raw = Array.from({ length: FIXTURE_MESSAGES }, (_, index) =>
      JSON.stringify({
        type: 'user',
        uuid: `claude-user-${index}`,
        timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
        message: {
          role: 'user',
          content: `claude native history row ${index} ${'x'.repeat(96)}`,
        },
      })).join('\n');
    const lines = raw.split('\n').map((line) => JSON.parse(line));
    return { messages: mapTranscript(lines), nativeBytes: Buffer.byteLength(raw) };
  }
  if (tool === 'pi') {
    const raw = Array.from({ length: FIXTURE_MESSAGES }, (_, index) =>
      JSON.stringify({
        type: 'message',
        id: `pi-user-${index}`,
        timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
        message: {
          role: 'user',
          content: [{
            type: 'text',
            text: `pi native history row ${index} ${'x'.repeat(96)}`,
          }],
        },
      })).join('\n');
    return {
      messages: mapPiJsonlText(raw),
      nativeBytes: Buffer.byteLength(raw),
    };
  }

  const root = mkdtempSync(join(tmpdir(), 'cosyncing-h1-opencode-'));
  const storage = join(root, 'storage');
  mkdirSync(storage, { recursive: true });
  const dbPath = join(root, 'opencode.db');
  const db = new Database(dbPath, { create: true });
  try {
    db.exec(`
      create table session (
        id text primary key,
        parent_id text,
        slug text,
        directory text,
        title text,
        model text,
        revert text,
        time_created integer,
        time_updated integer,
        time_archived integer
      );
      create table message (
        id text primary key,
        session_id text,
        time_created integer,
        data text
      );
      create table part (
        id text primary key,
        message_id text,
        session_id text,
        time_created integer,
        data text
      );
    `);
    db.query(
      `insert into session
       (id, slug, directory, title, time_created, time_updated)
       values (?, ?, ?, ?, ?, ?)`,
    ).run('h1-session', 'h1-session', '/tmp/h1', 'H1 fixture', 0, FIXTURE_MESSAGES);
    const insertMessage = db.query(
      'insert into message (id, session_id, time_created, data) values (?, ?, ?, ?)',
    );
    const insertPart = db.query(
      'insert into part (id, message_id, session_id, time_created, data) values (?, ?, ?, ?, ?)',
    );
    db.transaction(() => {
      for (let index = 0; index < FIXTURE_MESSAGES; index += 1) {
        const messageId = `opencode-user-${String(index).padStart(6, '0')}`;
        insertMessage.run(
          messageId,
          'h1-session',
          index,
          JSON.stringify({
            role: 'user',
            time: { created: index },
          }),
        );
        insertPart.run(
          `opencode-part-${String(index).padStart(6, '0')}`,
          messageId,
          'h1-session',
          index,
          JSON.stringify({
            type: 'text',
            text: `opencode native history row ${index} ${'x'.repeat(96)}`,
          }),
        );
      }
    })();
  } finally {
    db.close();
  }
  try {
    const adapter = new OpenCodeAdapter({
      baseUrl: 'http://127.0.0.1:1',
      storageDir: root,
    });
    const connection = await adapter.attach('h1-session', 'observe');
    try {
      return {
        messages: await connection.getHistory(),
        nativeBytes: statSync(dbPath).size,
      };
    } finally {
      await connection.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const tool of ['codex', 'claude', 'opencode', 'pi'] as const) {
  let fullNativeReadParseCount = 0;
  const readNativeHistory = async () => {
    fullNativeReadParseCount += 1;
    return readNativeFixture(tool);
  };

  const startedAt = performance.now();
  const native = await readNativeHistory();
  const history = native.messages;
  // The Pi fixture is bare prompts with no reply, so its transcript ends
  // mid-turn: the mapper truthfully appends ONE `running` run-summary for the
  // trailing open turn (and no completed footers — a prompt the agent never
  // answered carries no run evidence).
  const expectedMessages = tool === 'pi'
    ? FIXTURE_MESSAGES + 1
    : FIXTURE_MESSAGES;
  assert(
    history.length === expectedMessages,
    `${tool}: native mapper produced ${history.length}/${expectedMessages} messages`,
  );
  const cache = EncodedHistoryPageCache.create(
    source(`${tool}:source`, history.length),
    history,
  );
  const buildMs = performance.now() - startedAt;
  assert(cache, `${tool}: deterministic fixture must fit the named entry budget`);
  assert(
    cache.encodedBytes <= HISTORY_PAGE_CACHE_MAX_ENTRY_BYTES,
    `${tool}: encoded cache exceeded its per-entry byte budget`,
  );

  let cursor = backwardHistoryCursor(
    history,
    history.length - INITIAL_TAIL,
  );
  let expectedOldest = history.length - INITIAL_TAIL;
  let pages = 0;
  let transmittedMessages = 0;
  while (true) {
    const page = cache.page(cursor, INITIAL_TAIL);
    assert(page, `${tool}: issued cursor must resolve from the encoded index`);
    pages += 1;
    transmittedMessages += page.messages.length;
    assert(
      page.messages.length <= INITIAL_TAIL
        && page.messages.length <= HISTORY_PAGE_CACHE_MAX_PAGE_MESSAGES,
      `${tool}: broker-to-client page exceeded its message bound`,
    );
    expectedOldest -= page.messages.length;
    if (page.messages.length > 0) {
      assert(
        JSON.stringify(page.messages[0])
          === JSON.stringify(history[expectedOldest]),
        `${tool}: page order/boundary diverged`,
      );
    }
    if (page.endOfHistory) {
      assert(!page.hasMore && !page.cursor, `${tool}: final page shape is not authoritative`);
      break;
    }
    assert(page.hasMore && page.cursor, `${tool}: non-final page lost its cursor`);
    cursor = page.cursor;
  }
  assert(expectedOldest === 0, `${tool}: paging did not reach the true start`);
  assert(
    transmittedMessages === expectedMessages - INITIAL_TAIL,
    `${tool}: paging skipped or duplicated messages`,
  );
  assert(
    fullNativeReadParseCount === 1,
    `${tool}: repeated pages reparsed native history`,
  );
  // This is measurement output, not a timing threshold: CI hardware varies.
  console.log(JSON.stringify({
    tool,
    nativeBytes: native.nativeBytes,
    nativeMessages: history.length,
    nativeReadParseCount: fullNativeReadParseCount,
    cacheBuildMs: Number(buildMs.toFixed(3)),
    cacheEncodedBytes: cache.encodedBytes,
    pages,
    maxPageMessages: INITIAL_TAIL,
  }));
}

{
  const identity = source('repeated-transient', 200_000);
  const builder = new IndexedHistoryPageCacheBuilder();
  const activity: AgentMessage = {
    type: 'agent-activity',
    key: 'agent:hot',
    kind: 'subagent',
    title: 'Hot activity',
    status: 'running',
  };
  for (let location = 0; location < 200_000; location += 1) {
    assert(
      builder.accept(activity, location),
      `same-key transient replacement overflowed at ${location}`,
    );
  }
  assert(
    !builder.exceededBudget,
    '200,000 replacements of one transient key must retain one entry',
  );
  const reader: HistorySnapshotPageReader = {
    retainedBytes: 0,
    read(locations) {
      return {
        identity,
        messages: locations.map((location) => ({
          ...activity,
          title: `Hot activity at ${location}`,
        })),
        work: {
          recordsRead: locations.length,
          bytesRead: locations.length * 32,
        },
      };
    },
  };
  const cache = builder.finish(identity, reader);
  assert(cache, 'same-key transient replacements must produce a cache');
  const attach = await cache.loadAttach(undefined, INITIAL_TAIL);
  assert(!('kind' in attach), 'same-key transient attach must resolve');
  assert(
    attach.derivedMessages.length === 1,
    `same-key transient map retained ${attach.derivedMessages.length} entries`,
  );
  assert(
    attach.derivedMessages[0]?.type === 'agent-activity'
      && attach.derivedMessages[0].title === 'Hot activity at 199999',
    `same-key transient map lost its newest location: ${JSON.stringify(attach.derivedMessages)}`,
  );

  const distinct = new IndexedHistoryPageCacheBuilder();
  for (
    let index = 0;
    index < HISTORY_PAGE_CACHE_MAX_PROJECTION_ENTRIES;
    index += 1
  ) {
    assert(
      distinct.accept({
        ...activity,
        key: `agent:distinct:${index}`,
      }, index),
      `distinct transient key ${index} overflowed before the count bound`,
    );
  }
  assert(
    !distinct.accept({
      ...activity,
      key: 'agent:distinct:overflow',
    }, HISTORY_PAGE_CACHE_MAX_PROJECTION_ENTRIES),
    'a distinct transient key beyond the entry bound must be refused',
  );
  assert(
    distinct.exceededBudget,
    'distinct transient keys must preserve the configured entry bound',
  );
}

{
  const history = cacheFixture('codex').slice(0, 300);
  const cursor = backwardHistoryCursor(history, 200);
  const cache = EncodedHistoryPageCache.create(source('source-a', 300), history)!;
  assert(
    cache.page('forged').gap?.code === 'HISTORY_CURSOR_INVALID',
    'forged cursor must fail closed without another native read',
  );
  assert(cache.page(cursor).messages.length === 100, 'trusted cursor should resolve');

  const pool = new HistoryPageCachePool(2, HISTORY_PAGE_CACHE_MAX_ENTRY_BYTES, 15);
  assert(pool.put('session', cache), 'cache should enter the bounded pool');
  assert(
    pool.get('session', source('source-a', 301)) === cache,
    'append-only source growth must keep the immutable snapshot',
  );
  assert(
    pool.get('session', {
      ...source('source-a', 300),
      rewriteToken: 'rewritten-prefix',
    }) === undefined,
    'same-size/same-revision prefix rewrite must invalidate',
  );
  assert(pool.size === 0, 'rewritten source must be physically released');

  pool.put('session', cache);
  assert(
    pool.get('session', source('source-b', 301)) === undefined,
    'source change must invalidate',
  );
  assert(pool.size === 0, 'invalidated source must be physically released');

  pool.put('session', cache);
  await Bun.sleep(30);
  assert(pool.size === 0, 'idle one-shot expiry must release encoded history');

  const restartedPool = new HistoryPageCachePool();
  assert(
    restartedPool.get('session', source('source-a', 300)) === undefined,
    'broker restart must not resurrect an in-memory cursor index',
  );
}

{
  const tiny = cacheFixture('pi').slice(0, 2);
  assert(
    EncodedHistoryPageCache.create(
      source('message-count-limit', tiny.length),
      tiny,
      HISTORY_PAGE_CACHE_MAX_ENTRY_BYTES,
      1,
    ) === undefined,
    'per-entry message count must bound cursor/object overhead',
  );
  assert(
    HISTORY_PAGE_CACHE_MAX_ENTRY_MESSAGES >= FIXTURE_MESSAGES,
    'native measurement fixture must exercise an allowed entry size',
  );

  const oversized: AgentMessage[] = [{
    type: 'model-output',
    key: 'oversized',
    text: 'x'.repeat(HISTORY_PAGE_CACHE_MAX_ENTRY_BYTES + 1),
  }];
  assert(
    EncodedHistoryPageCache.create(
      source('oversized-source', 1),
      oversized,
    ) === undefined,
    'one source larger than the named entry budget must not be retained',
  );
}

{
  const history = cacheFixture('claude').slice(0, 300);
  const identity = source('single-flight', history.length);
  const pool = new HistoryPageCachePool();
  let nativeBuilds = 0;
  const build = () => pool.getOrCreate('same-session', identity, async () => {
    nativeBuilds += 1;
    await Bun.sleep(10);
    return EncodedHistoryPageCache.create(identity, history);
  });
  const [first, second] = await Promise.all([build(), build()]);
  assert(first && first === second, 'concurrent clients must share one cache build');
  assert(nativeBuilds === 1, 'single-flight must perform one native cache build');
  pool.clear();
}

{
  const oldHistory = cacheFixture('codex').slice(0, 300);
  const currentHistory = cacheFixture('codex').slice(0, 401);
  const oldIdentity = source('append-upgrade', oldHistory.length);
  const currentIdentity = source(
    'append-upgrade',
    currentHistory.length,
  );
  const oldCache = EncodedHistoryPageCache.create(
    oldIdentity,
    oldHistory,
  )!;
  const pool = new HistoryPageCachePool();
  assert(
    pool.put('append-upgrade', oldCache),
    'append ancestor must enter the bounded pool',
  );
  assert(
    pool.get('append-upgrade', currentIdentity) === oldCache,
    'append ancestor must remain usable for an older prefix cursor',
  );
  assert(
    pool.getExact('append-upgrade', currentIdentity) === undefined,
    'exact lookup must distinguish an append ancestor from current history',
  );
  let currentBuilds = 0;
  const currentCache = await pool.getOrCreate(
    'append-upgrade',
    currentIdentity,
    async () => {
      currentBuilds += 1;
      return EncodedHistoryPageCache.create(
        currentIdentity,
        currentHistory,
      );
    },
    { exact: true },
  );
  assert(currentCache, 'current append snapshot must fit the named bounds');
  assert(currentBuilds === 1, 'exact append upgrade must build only once');
  assert(
    currentCache.page(
      backwardHistoryCursor(oldHistory, 200),
      INITIAL_TAIL,
    ).messages.length === INITIAL_TAIL,
    'upgraded snapshot must preserve an older client prefix cursor',
  );
  assert(
    currentCache.page(
      backwardHistoryCursor(currentHistory, 301),
      INITIAL_TAIL,
    ).messages.length === INITIAL_TAIL,
    'upgraded snapshot must resolve the newer truncated attach cursor',
  );
  assert(
    pool.getExact('append-upgrade', currentIdentity) === currentCache,
    'current exact snapshot must replace its append ancestor',
  );
}

{
  const history = cacheFixture('pi').slice(0, 20);
  const firstCache = EncodedHistoryPageCache.create(
    source('rewrite-race', 20, 'revision-a'),
    history,
  )!;
  const secondCache = EncodedHistoryPageCache.create(
    {
      ...source('rewrite-race', 20, 'revision-b'),
      rewriteToken: 'rewritten-prefix',
    },
    history,
  )!;
  const pool = new HistoryPageCachePool();
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const firstBuild = pool.getOrCreate(
    'rewrite-race',
    firstCache.sourceIdentity,
    async () => {
      await firstGate;
      return firstCache;
    },
  );
  const secondBuild = pool.getOrCreate(
    'rewrite-race',
    secondCache.sourceIdentity,
    async () => {
      await secondGate;
      return secondCache;
    },
  );
  releaseSecond();
  assert(
    await secondBuild === secondCache,
    'new source build must win an incompatible in-flight rewrite',
  );
  releaseFirst();
  assert(
    await firstBuild === undefined,
    'superseded source build must fail closed instead of replacing the winner',
  );
  assert(
    pool.get('rewrite-race', secondCache.sourceIdentity) === secondCache,
    'superseded build must not evict the current source snapshot',
  );
}

// ── H1b: the budget is enforced DURING construction, by the receiver ──────────────────────────
// The cache used to be handed a complete `AgentMessage[]`, so an adapter had to build every message
// (and, file-backed, every parsed record behind them) before a single limit ran: the limits bounded
// what was RETAINED while peak construction stayed proportional to the source. The builder is a
// sink, so the same limits now stop the producer mid-read.
{
  const fixture = cacheFixture('codex');

  // 1. The message bound stops the producer at the boundary, not after it.
  const bounded = new EncodedHistoryPageCacheBuilder(HISTORY_PAGE_CACHE_MAX_ENTRY_BYTES, 10);
  let offered = 0;
  for (const message of fixture) {
    offered += 1;
    if (!bounded.accept(message)) break;
  }
  assert(offered === 11, `producer must be stopped at the bound, saw ${offered} offers`);
  assert(bounded.exceededBudget, 'the builder must report the overflow it measured');
  assert(bounded.finish(source('bounded', 1)) === undefined, 'an overflowed builder yields no cache');

  // 2. The byte bound behaves the same way.
  const tiny = new EncodedHistoryPageCacheBuilder(2_048, HISTORY_PAGE_CACHE_MAX_ENTRY_MESSAGES);
  let accepted = 0;
  for (const message of fixture) {
    if (!tiny.accept(message)) break;
    accepted += 1;
  }
  assert(accepted > 0 && accepted < fixture.length, `byte bound must stop mid-stream, took ${accepted}`);
  assert(tiny.finish(source('tiny', 1)) === undefined, 'an overflowed builder yields no cache');

  // 3. Cursor-transient frames are dropped by the builder itself, so no caller filters first.
  const withActivity: AgentMessage[] = [
    fixture[0]!,
    { type: 'agent-activity', activity: [] } as unknown as AgentMessage,
    fixture[1]!,
  ];
  const filtered = EncodedHistoryPageCache.create(source('filtered', 1), withActivity);
  assert(filtered?.stats.messageCount === 2, `builder must drop cursor-transient frames, got ${filtered?.stats.messageCount}`);

  // 4. Streaming and whole-array construction produce the SAME cache: same count, same bytes, and
  //    the same cursor for every boundary, so an existing client cursor still resolves.
  const streamed = new EncodedHistoryPageCacheBuilder();
  for (const message of fixture) assert(streamed.accept(message), 'the real budget fits the fixture');
  const streamedCache = streamed.finish(source('equivalence', 1));
  const wholeArray = EncodedHistoryPageCache.create(source('equivalence', 1), fixture);
  assert(streamedCache && wholeArray, 'both constructions must succeed');
  assert(
    streamedCache!.stats.messageCount === wholeArray!.stats.messageCount
      && streamedCache!.stats.encodedBytes === wholeArray!.stats.encodedBytes,
    'streamed and whole-array caches must be byte-identical in size',
  );
  const streamedPage = streamedCache!.page(undefined, HISTORY_PAGE_CACHE_MAX_PAGE_MESSAGES);
  const wholePage = wholeArray!.page(undefined, HISTORY_PAGE_CACHE_MAX_PAGE_MESSAGES);
  assert(
    JSON.stringify(streamedPage) === JSON.stringify(wholePage),
    'streamed and whole-array caches must serve the identical page and cursor',
  );
}

// ── H1b R1: reset frames are bounded, cursor-complete, and reconcile only delivered text ─────
{
  const indexedHistory: AgentMessage[] = Array.from(
    { length: 130 },
    (_, index) => ({
      type: 'user-message',
      key: `indexed-row-${index}`,
      text: `indexed row ${index}`,
    }),
  );
  indexedHistory[0] = {
    type: 'model-output',
    key: 'live-old',
    text: 'persisted outside the attach tail',
    final: true,
  };
  indexedHistory[4] = {
    type: 'task-list-state',
    key: 'plan-a',
    title: 'Plan',
    status: 'running',
    source: 'tool-call',
    sourceTool: 'update_plan',
    items: [{ id: '1', title: 'Keep paging', status: 'in-progress' }],
  };
  indexedHistory[9] = {
    type: 'goal-state',
    key: 'goal-a',
    title: 'Large history',
    status: 'active',
  };

  const identity = source('indexed-reset', indexedHistory.length);
  const builder = new IndexedHistoryPageCacheBuilder();
  for (let index = 0; index < indexedHistory.length; index += 1) {
    assert(
      builder.accept(indexedHistory[index]!, index),
      `indexed fixture overflowed at ${index}`,
    );
  }
  const reader: HistorySnapshotPageReader = {
    retainedBytes: 0,
    read(locations) {
      return {
        identity,
        messages: locations.map((location) => indexedHistory[location]!),
        work: {
          recordsRead: locations.length,
          bytesRead: locations.reduce(
            (sum, location) =>
              sum + Buffer.byteLength(JSON.stringify(indexedHistory[location])),
            0,
          ),
        },
      };
    },
  };
  const cache = builder.finish(identity, reader);
  assert(cache, 'indexed reset fixture must fit compact metadata bounds');

  const attach = await cache.loadAttach(undefined, INITIAL_TAIL);
  assert(!('kind' in attach), 'indexed reset attach must resolve');
  assert(
    attach.messages.length === INITIAL_TAIL,
    `projection enrichment escaped the 100-entry attach bound: ${attach.messages.length}`,
  );
  assert(
    attach.messages.some((message) =>
      message.type === 'task-list-state' && message.key === 'plan-a'),
    'the latest task projection must survive bounded attach',
  );
  assert(
    attach.messages.some((message) =>
      message.type === 'goal-state' && message.key === 'goal-a'),
    'the latest goal projection must survive bounded attach',
  );
  assert(
    !attach.messages.some((message) =>
      message.type === 'model-output' && message.key === 'live-old'),
    'the old live-overlap fixture must remain outside the reset frame',
  );
  assert(
    !attach.deliveredText.has('model-output:live-old'),
    'reset overlap claims must not include text the client was not sent',
  );
  assert(attach.olderCursor, 'bounded reset must retain an older cursor');

  const paged = await cache.loadPage(
    attach.olderCursor,
    HISTORY_PAGE_CACHE_MAX_PAGE_MESSAGES,
  );
  assert(!('kind' in paged) && !paged.gap, 'issued projection-aware cursor must resolve');
  const reachable = [...paged.messages, ...attach.messages]
    .filter(isBackwardPageMessage)
    .map((message) => JSON.stringify(message));
  const expected = indexedHistory
    .filter(isBackwardPageMessage)
    .map((message) => JSON.stringify(message));
  assert(
    reachable.length === expected.length
      && new Set(reachable).size === expected.length
      && expected.every((message) => reachable.includes(message)),
    'projection slot reservation must leave every transcript row reachable exactly once',
  );

  const reconnect = await cache.loadAttach(attach.cursor, INITIAL_TAIL);
  assert(
    !('kind' in reconnect) && !reconnect.reset,
    'exact compact cursor must take the incremental reconnect path',
  );
  assert(
    reconnect.deliveredText.has('model-output:live-old'),
    'incremental reconnect must still reconcile its cursor-acknowledged prefix',
  );
}

// ── H1c R3: projection enrichment can never displace the newest transcript rows ──────────────
// The reserved-projection fixed point had no ceiling. With more distinct projection keys in front
// of the tail than the attach bound, every slot went to enrichment and the newest messages were
// absent from the frame — the indexed path reproducing the exact H1c symptom the fallback path
// exists to prevent. Fails against the pre-fix loop with hasU1/hasU2 false.
{
  const PROJECTION_KEYS = 100;
  const displacing: AgentMessage[] = [];
  for (let index = 0; index < PROJECTION_KEYS; index += 1) {
    displacing.push({
      type: 'task-list-state',
      key: `plan-${index}`,
      title: `Plan ${index}`,
      status: 'running',
      source: 'tool-call',
      sourceTool: 'update_plan',
      items: [{ id: '1', title: `step ${index}`, status: 'in-progress' }],
    } as unknown as AgentMessage);
  }
  displacing.push({
    type: 'user-message',
    key: 'newest-question',
    text: 'the newest question',
  } as unknown as AgentMessage);
  displacing.push({
    type: 'user-message',
    key: 'newest-followup',
    text: 'the newest follow-up',
  } as unknown as AgentMessage);

  const identity = source('projection-displacement', displacing.length);
  const builder = new IndexedHistoryPageCacheBuilder();
  for (let index = 0; index < displacing.length; index += 1) {
    assert(
      builder.accept(displacing[index]!, index),
      `displacement fixture overflowed at ${index}`,
    );
  }
  const reader: HistorySnapshotPageReader = {
    retainedBytes: 0,
    read(locations) {
      return {
        identity,
        messages: locations.map((location) => displacing[location]!),
        work: { recordsRead: locations.length, bytesRead: 0 },
      };
    },
  };
  const cache = builder.finish(identity, reader);
  assert(cache, 'displacement fixture must fit compact metadata bounds');

  const attach = await cache.loadAttach(undefined, INITIAL_TAIL);
  assert(!('kind' in attach), 'displacement attach must resolve');
  const keys = attach.messages.map(
    (message) => (message as { key?: string }).key ?? '?',
  );
  assert(
    keys.includes('newest-question') && keys.includes('newest-followup'),
    `projection enrichment displaced the newest transcript rows: ${keys.slice(0, 5).join(',')}…`,
  );
  assert(
    attach.messages.length <= INITIAL_TAIL,
    `one frame must stay inside its bound, got ${attach.messages.length}`,
  );
  // The shown window is a CONTIGUOUS suffix ending at the newest message: every
  // non-projection entry in the frame must be the tail, in order, with nothing
  // after the last one.
  // The frame is [contiguous newest tail, then enrichment]. The tail therefore
  // ends at the newest message, and everything after it is the allowance.
  const newestAt = keys.indexOf('newest-followup');
  assert(
    newestAt >= 0 && keys[newestAt - 1] === 'newest-question',
    `the shown window must end at the newest messages: ${keys.slice(-3).join(',')}`,
  );
  const shownTail = keys.slice(0, newestAt + 1);
  const firstShown = displacing.length - shownTail.length;
  assert(
    shownTail.every(
      (key, offset) =>
        key === (displacing[firstShown + offset] as { key?: string }).key,
    ),
    'the shown window must be a contiguous suffix with no holes',
  );
  const projectionsInFrame = attach.messages.length - shownTail.length;
  assert(
    projectionsInFrame <= HISTORY_PAGE_CACHE_MAX_ATTACH_PROJECTIONS,
    `projection enrichment claimed ${projectionsInFrame} slots, above the stated allowance`,
  );
  assert(
    shownTail.length >= INITIAL_TAIL - HISTORY_PAGE_CACHE_MAX_ATTACH_PROJECTIONS,
    `the contiguous newest tail kept only ${shownTail.length} of the slots enrichment did not claim`,
  );
  assert(
    attach.truncated?.shown === attach.messages.length,
    `a truncated frame must report the entries it carries: shown=${attach.truncated?.shown} messages=${attach.messages.length}`,
  );
  assert(
    attach.truncated?.total === displacing.length,
    `truncation total must describe the whole history, got ${attach.truncated?.total}`,
  );

  // Everything displaced stays reachable exactly once behind the older cursor.
  assert(attach.olderCursor, 'a truncated frame must offer an older cursor');
  const paged = await cache.loadPage(
    attach.olderCursor!,
    HISTORY_PAGE_CACHE_MAX_PAGE_MESSAGES,
  );
  assert(!('kind' in paged) && !paged.gap, 'the issued older cursor must resolve');
  const reachable = [...paged.messages, ...attach.messages]
    .filter(isBackwardPageMessage)
    .map((message) => JSON.stringify(message));
  const expected = displacing
    .filter(isBackwardPageMessage)
    .map((message) => JSON.stringify(message));
  assert(
    reachable.length === expected.length
      && new Set(reachable).size === expected.length
      && expected.every((message) => reachable.includes(message)),
    `displaced rows must stay reachable exactly once: reachable=${reachable.length} expected=${expected.length}`,
  );
}

// ── Lane H1d: the indexed attach names its end boundary and fits the client's decoded budget ────
// A bounded client may release an attach frame it can no longer hold. The frame therefore carries
// the backward cursor at its newest row (the same canonical encoding every page cursor uses), and
// a reload with the frame's pageable row count lands on the frame's own older boundary. The frame
// is also bounded by the client's decoded estimate, so a wide tail degrades to a shorter frame
// with the true boundary instead of arriving too large to keep.
{
  const wide: AgentMessage[] = [];
  for (let index = 0; index < 60; index += 1) {
    if (index === 5) {
      wide.push({
        type: 'task-list-state',
        key: 'plan-wide',
        title: 'Plan',
        status: 'running',
        source: 'tool-call',
        sourceTool: 'update_plan',
        items: [{ id: '1', title: 'step', status: 'in-progress' }],
      } as unknown as AgentMessage);
      continue;
    }
    wide.push({
      type: 'model-output',
      key: `wide-${index}`,
      text: `${index}:`.padEnd(40_000, 'w'),
    } as unknown as AgentMessage);
  }
  const identity = source('indexed-end-boundary', wide.length);
  const builder = new IndexedHistoryPageCacheBuilder();
  for (let index = 0; index < wide.length; index += 1) {
    assert(builder.accept(wide[index]!, index), `wide fixture overflowed at ${index}`);
  }
  const reader: HistorySnapshotPageReader = {
    retainedBytes: 0,
    read(locations) {
      return {
        identity,
        messages: locations.map((location) => wide[location]!),
        work: { recordsRead: locations.length, bytesRead: 0 },
      };
    },
  };
  const cache = builder.finish(identity, reader);
  assert(cache, 'wide fixture must fit compact metadata bounds');

  const full = await cache.loadAttach(undefined, INITIAL_TAIL);
  assert(!('kind' in full), 'unbounded-byte attach must resolve');
  assert(
    full.endCursor === backwardHistoryCursor(wide, wide.length),
    'the attach end boundary must be the canonical backward cursor at the newest row',
  );

  const budget = 1024 * 1024;
  const bounded = await cache.loadAttach(undefined, INITIAL_TAIL, undefined, budget);
  assert(!('kind' in bounded), 'byte-bounded attach must resolve');
  const bytes = bounded.messages.reduce((sum, message) => sum + estimatedClientDecodedBytes(message), 0);
  assert(
    bounded.messages.length > 0 && bytes <= budget,
    `the attach frame must fit the decoded budget: ${bytes} > ${budget}`,
  );
  const boundedTail = bounded.messages.filter((message) => message.type !== 'task-list-state');
  assert(
    (boundedTail.at(-1) as { key?: string }).key === 'wide-59',
    'a byte-bounded attach must still end its tail at the newest row',
  );
  // The plan row sits far behind the byte-trimmed tail start. State rows are never
  // backward-pageable, and a replacement frame rebuilds the client's live state from what it
  // carries, so a frame that trimmed it away would lose the plan for good: it must be re-exposed
  // behind the tail exactly as the generic cap does.
  assert(
    bounded.messages.some((message) =>
      message.type === 'task-list-state' && (message as { key?: string }).key === 'plan-wide'),
    'a byte-trimmed indexed attach re-exposes the latest state row it trimmed away',
  );
  const generic = capHistoryMessages(wide, INITIAL_TAIL, wide.length, budget);
  assert(
    JSON.stringify(bounded.messages) === JSON.stringify(generic.messages),
    'the indexed and generic byte bounds deliver the same final frame shape',
  );
  assert(
    bounded.reset && bounded.truncated?.shown === bounded.messages.length
      && bounded.truncated?.total === wide.length && bounded.olderCursor,
    `a byte-bounded attach must report honest truncation: ${JSON.stringify(bounded.truncated)}`,
  );
  assert(bounded.endCursor === full.endCursor, 'byte trimming never moves the end boundary');
  const pageable = bounded.messages.filter(isBackwardPageMessage);
  const reload = await cache.loadPage(bounded.endCursor!, pageable.length);
  assert(!('kind' in reload) && !reload.gap, 'the end boundary must resolve as a page cursor');
  assert(
    JSON.stringify(reload.messages) === JSON.stringify(pageable),
    'a reload from the end boundary returns exactly the frame rows',
  );
  assert(
    reload.cursor === bounded.olderCursor,
    'the reload reconnects with the frame older boundary by cursor equality',
  );
  const before = await cache.loadPage(bounded.olderCursor!, HISTORY_PAGE_CACHE_MAX_PAGE_MESSAGES);
  assert(!('kind' in before) && !before.gap, 'the byte-trimmed older boundary must resolve');
  const reachable = [...before.messages, ...pageable].map((message) => JSON.stringify(message));
  const expected = wide.filter(isBackwardPageMessage).map((message) => JSON.stringify(message));
  assert(
    reachable.length === expected.length && expected.every((message, index) => reachable[index] === message),
    `byte trimming must leave every transcript row reachable exactly once: ${reachable.length}/${expected.length}`,
  );

  // An incremental reconnect whose suffix does not fit becomes a replacement. The client's copy of
  // the prefix — where the plan lives — is about to be replaced, so the replacement must carry the
  // plan from that prefix, on the indexed path and on the generic one alike.
  const since = historyCursorFromHash(10, backwardHistoryCursorHash(wide, 10));
  const reconnect = await cache.loadAttach(since, INITIAL_TAIL, undefined, budget);
  assert(!('kind' in reconnect), 'byte-bounded reconnect must resolve');
  assert(reconnect.reset, 'a reconnect trimmed by the byte bound is a replacement');
  assert(
    reconnect.messages.some((message) => message.type === 'task-list-state'),
    'a byte-trimmed indexed reconnect re-exposes the prefix state row the replacement would lose',
  );
  const genericReconnect = capHistoryDelta(
    historyDelta(wide, since),
    INITIAL_TAIL,
    wide.length,
    budget,
    { history: wide },
  );
  assert(genericReconnect.reset, 'the generic reconnect is also a replacement');
  assert(
    genericReconnect.messages.some((message) => message.type === 'task-list-state'),
    'a byte-trimmed generic reconnect re-exposes the prefix state row the replacement would lose',
  );
  assert(
    JSON.stringify(reconnect.messages) === JSON.stringify(genericReconnect.messages),
    'the indexed and generic reconnect replacements deliver the same frame',
  );
  assert(
    genericReconnect.olderCursor === reconnect.olderCursor,
    'both replacements name the same older boundary',
  );

  // The bound is measured on the shape the client receives: a measure that reports every row as
  // tiny (as a reference-mode egress would for rows whose bodies move behind a reference) keeps the
  // whole count-bounded tail.
  const delivered = await cache.loadAttach(undefined, INITIAL_TAIL, undefined, budget, () => 1_000);
  assert(!('kind' in delivered), 'delivered-shape attach must resolve');
  assert(
    delivered.messages.length === wide.length && !delivered.truncated,
    `the byte bound measures the delivered shape, not the stored one: ${delivered.messages.length}`,
  );
}

// An incremental reconnect that the byte bound turns into a replacement salvages prefix state, but
// never past the count bound: the salvaged rows share the frame's slots with the tail, on the indexed
// path exactly as on the generic one.
{
  const history: AgentMessage[] = [];
  for (let index = 0; index < 30; index += 1) {
    history.push({ type: 'task-list-state', key: `plan${index}`, title: 'P', status: 'running', items: [] } as unknown as AgentMessage);
  }
  for (let index = 0; index < 20; index += 1) {
    history.push({ type: 'model-output', key: `p${index}`, text: 'x' } as unknown as AgentMessage);
  }
  const prefixLength = history.length;
  history.push({ type: 'model-output', key: 'big', text: 'y'.repeat(1_200_000) } as unknown as AgentMessage);
  for (let index = 0; index < 99; index += 1) {
    history.push({ type: 'model-output', key: `s${index}`, text: 'z'.repeat(100) } as unknown as AgentMessage);
  }
  const identity = source('salvage-count-bound', history.length);
  const builder = new IndexedHistoryPageCacheBuilder();
  for (let index = 0; index < history.length; index += 1) {
    assert(builder.accept(history[index]!, index), `salvage fixture overflowed at ${index}`);
  }
  const cache = builder.finish(identity, {
    retainedBytes: 0,
    read(locations) {
      return {
        identity,
        messages: locations.map((location) => history[location]!),
        work: { recordsRead: locations.length, bytesRead: 0 },
      };
    },
  });
  assert(cache, 'salvage fixture must fit compact metadata bounds');
  const since = historyCursorFromHash(prefixLength, backwardHistoryCursorHash(history, prefixLength));
  const budget = 2 * 1024 * 1024;
  const indexed = await cache.loadAttach(since, INITIAL_TAIL, undefined, budget);
  assert(!('kind' in indexed), 'salvaging reconnect must resolve');
  const generic = capHistoryDelta(historyDelta(history, since), INITIAL_TAIL, history.length, budget, { history });
  assert(indexed.reset && generic.reset, 'the oversized reconnect becomes a replacement');
  assert(
    indexed.messages.length <= INITIAL_TAIL && generic.messages.length <= INITIAL_TAIL,
    `salvaged state never exceeds the count bound: ${indexed.messages.length}/${generic.messages.length}`,
  );
  assert(
    indexed.messages.some((message) => (message as { key?: string }).key === 'plan29'),
    'the newest salvaged plan survives inside the bound',
  );
  assert(
    JSON.stringify(indexed.messages) === JSON.stringify(generic.messages)
      && indexed.olderCursor === generic.olderCursor,
    'the indexed and generic salvaging replacements deliver the same frame',
  );
  assert(indexed.truncated?.shown === indexed.messages.length, 'shown counts the delivered rows');
}

// The paging-fit verdict for a frame that builds no cache is reused for the exact same snapshot and
// judged afresh when the source grows or is replaced; without a snapshot fingerprint nothing is
// reused. The sufficient bound never admits a history the exact build would refuse.
{
  let reads = 0;
  const counted = (rows: AgentMessage[]): AgentMessage[] => new Proxy(rows, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const rows = (count: number, prefix = 'fit'): AgentMessage[] => Array.from({ length: count }, (_, index) => ({
    type: 'model-output',
    key: `${prefix}-${index}`,
    text: `row ${index}`,
  }) as unknown as AgentMessage);
  const readsOf = (fn: () => boolean): { fits: boolean; reads: number } => {
    reads = 0;
    const fits = fn();
    return { fits, reads };
  };
  const first: HistorySourceIdentity = { sourceId: 'fit-memo', revision: '1', appendPosition: 40, rewriteToken: 'fit-memo:a' };
  const history = counted(rows(40));
  const fingerprint = historyDelta(rows(40)).cursor;

  const cold = readsOf(() => historyFitsEncodedPageCache(first, history, fingerprint));
  assert(cold.fits && cold.reads >= 40, `a first verdict reads the history: ${cold.reads}`);
  const warm = readsOf(() => historyFitsEncodedPageCache(first, history, fingerprint));
  assert(warm.fits && warm.reads === 0, `the same snapshot reuses its verdict: ${warm.reads}`);

  const grownRows = counted(rows(41));
  const grown = readsOf(() => historyFitsEncodedPageCache(
    { ...first, revision: '2', appendPosition: 41 },
    grownRows,
    historyDelta(rows(41)).cursor,
  ));
  assert(grown.fits && grown.reads >= 41, `a grown source is judged afresh: ${grown.reads}`);
  const replacedRows = counted(rows(40, 'rewritten'));
  const replaced = readsOf(() => historyFitsEncodedPageCache(
    { ...first, revision: '3', rewriteToken: 'fit-memo:b' },
    replacedRows,
    historyDelta(rows(40, 'rewritten')).cursor,
  ));
  assert(replaced.fits && replaced.reads >= 40, `a replaced source is judged afresh: ${replaced.reads}`);
  const unkeyed = readsOf(() => historyFitsEncodedPageCache(first, history));
  assert(unkeyed.fits && unkeyed.reads >= 40, `without a fingerprint nothing is reused: ${unkeyed.reads}`);

  // Over the message cap: refused.
  assert(!historyFitsEncodedPageCache(first, rows(101), undefined, 1024 * 1024, 100), 'a history over the message cap does not fit');
  // Control characters encode as six JSON bytes per UTF-16 unit, three times their estimate. Such a
  // history over the byte cap must be refused even where twice its estimate would fit.
  const control = Array.from({ length: 3 }, (_, index) => ({
    type: 'model-output',
    key: `control-${index}`,
    text: '\u0001'.repeat(60_000),
  }) as unknown as AgentMessage);
  const estimate = control.reduce((sum, message) => sum + estimatedClientDecodedBytes(message), 0);
  assert(2 * estimate < 1024 * 1024, 'precondition: twice the estimate fits the cap');
  assert(
    EncodedHistoryPageCache.create(first, control, 1024 * 1024, 100) === undefined,
    'precondition: the exact build refuses the control-character history',
  );
  assert(
    !historyFitsEncodedPageCache(first, control, undefined, 1024 * 1024, 100),
    'the sufficient bound never admits a history the exact build refuses',
  );
  assert(historyFitsEncodedPageCache(first, control, undefined, 2 * 1024 * 1024, 100), 'the same history fits a larger cap');
}

// ── Revision 28: newer pages and refresh frames, generic and indexed alike ─────────────────────
// A forward walk and a refresh frame must be the same rows with the same boundaries whether the
// session's history is served from the encoded cache, the native index, or the plain durable
// list, so a client cannot tell (and need not care) which one answered.
{
  const history: AgentMessage[] = [];
  for (let index = 0; index < 400; index += 1) {
    if (index % 37 === 5) {
      history.push({ type: 'task-list-state', key: `plan${index % 3}`, title: 'P', status: 'running', items: [] } as unknown as AgentMessage);
    }
    history.push({
      type: index % 3 === 0 ? 'user-message' : 'model-output',
      key: `n${index}`,
      text: `newer paging row ${index} ${'y'.repeat(index % 11 === 0 ? 30_000 : 64)}`,
    } as unknown as AgentMessage);
  }
  history.push({ type: 'model-output', key: 'streaming-tail', text: 'still growing' } as unknown as AgentMessage);
  const identity = source('newer-parity', history.length);
  const encoded = EncodedHistoryPageCache.create(identity, history);
  assert(encoded, 'newer-parity fixture must fit the encoded cache');
  const builder = new IndexedHistoryPageCacheBuilder();
  for (let index = 0; index < history.length; index += 1) {
    assert(builder.accept(history[index]!, index), `newer-parity fixture overflowed at ${index}`);
  }
  const indexed = builder.finish(identity, {
    retainedBytes: 0,
    read(locations) {
      return {
        identity,
        messages: locations.map((location) => history[location]!),
        work: { recordsRead: locations.length, bytesRead: 0 },
      };
    },
  });
  assert(indexed, 'newer-parity fixture must fit the native index');
  const same = (left: unknown, right: unknown, what: string) => {
    assert(JSON.stringify(left) === JSON.stringify(right), `${what}: ${JSON.stringify(left).slice(0, 200)} != ${JSON.stringify(right).slice(0, 200)}`);
  };
  const boundaries = [0, 1, 5, 6, 40, 187, 399, history.length - 1, history.length];
  for (const at of boundaries) {
    const cursor = backwardHistoryCursor(history, at);
    // 4 and 5 end full pages right before a state row (at boundaries 1 and 0).
    for (const limit of [1, 4, 5, 7, 100, 500]) {
      for (const until of [undefined, backwardHistoryCursor(history, Math.min(history.length, at + 50))]) {
        const reference = forwardHistoryPage(history, cursor, limit, until);
        same(await encoded.loadNewerPage(cursor, limit, until), reference, `encoded newer page ${at}/${limit}/${Boolean(until)}`);
        same(await indexed.loadNewerPage(cursor, limit, until), reference, `indexed newer page ${at}/${limit}/${Boolean(until)}`);
      }
    }
  }
  for (const bad of ['nope', backwardHistoryCursor([...history, ...history], history.length + 3)]) {
    same(await encoded.loadNewerPage(bad, 10), forwardHistoryPage(history, bad, 10), 'encoded refusal parity');
    same(await indexed.loadNewerPage(bad, 10), forwardHistoryPage(history, bad, 10), 'indexed refusal parity');
  }

  const measure = (message: AgentMessage) => estimatedClientDecodedBytes(message);
  for (const at of [0, 17, 250, history.length - 2, history.length - 1, history.length]) {
    const since = historyCursorFromHash(at, backwardHistoryCursorHash(history, at));
    for (const max of [1, 50, 100, 500]) {
      for (const holdTrailingText of [false, true]) {
        const options = { max, maxDecodedBytes: 256 * 1024, measure, holdTrailingText };
        const reference = historyRefresh(history, since, options);
        same(await indexed.loadRefresh(since, options), reference, `indexed refresh ${at}/${max}/${holdTrailingText}`);
        same(encoded.loadRefresh(since, options), reference, `encoded refresh ${at}/${max}/${holdTrailingText}`);
      }
    }
  }
  const held = historyRefresh(history, historyCursorFromHash(history.length - 2, backwardHistoryCursorHash(history, history.length - 2)), {
    max: 100,
    holdTrailingText: true,
  });
  assert(!('gap' in held) && held.messages.length === 1 && held.more, 'the streaming tail is held while a turn runs');
  for (const bad of ['nope', historyCursorFromHash(history.length + 1, 'x')]) {
    same(await indexed.loadRefresh(bad, { max: 100 }), historyRefresh(history, bad, { max: 100 }), 'indexed refresh refusal parity');
    same(encoded.loadRefresh(bad, { max: 100 }), historyRefresh(history, bad, { max: 100 }), 'encoded refresh refusal parity');
  }
  const diverged = historyCursorFromHash(10, backwardHistoryCursorHash(history, 11));
  same(await indexed.loadRefresh(diverged, { max: 100 }), historyRefresh(history, diverged, { max: 100 }), 'indexed refresh divergence parity');
  same(encoded.loadRefresh(diverged, { max: 100 }), historyRefresh(history, diverged, { max: 100 }), 'encoded refresh divergence parity');
}

// ── Stable tool slots, generic and indexed alike ─────────────────────────────────────────
// Every native tool reserves its result position while running. Finishing a tool updates
// that position, so even very old pending tools do not hold completed output outside frames.
{
  const tool = (callID: string, status: 'running' | 'completed') => mapOpenCodePart({
    type: 'tool',
    id: `prt_${callID}`,
    callID,
    tool: 'bash',
    state: status === 'completed'
      ? { status, input: { command: `echo ${callID}` }, output: 'done', metadata: { exit: 0, output: 'done' }, time: { start: 1, end: 2 } }
      : { status, input: { command: `echo ${callID}` }, time: { start: 1 } },
  }, { historical: true });
  const text = (id: string, body: string) => mapOpenCodePart({ type: 'text', id, text: body, time: { start: 1, end: 2 } }, { historical: true });
  const finished = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => tool(`${prefix}${index}`, 'completed')).flat();
  const lead = Array.from({ length: 30 }, (_, index) => text(`lead${index}`, `transcript row ${index}`)).flat();
  const cases: Array<{ name: string; history: AgentMessage[]; hold: (history: AgentMessage[]) => number }> = [
    {
      // Twelve finished tools, 24 rows, after the one still running: more than one read of the index.
      name: 'a waiting call among finished ones',
      history: [...lead, ...text('step', 'Running them together.'), ...tool('slow', 'running'), ...finished('quick', 12)],
      hold: (history) => history.at(-1)?.type === 'model-output' ? history.length - 1 : history.length,
    },
    {
      name: 'the later of two calls finished first',
      history: [...lead, ...tool('a', 'running'), ...tool('b', 'completed')],
      hold: (history) => history.length,
    },
    {
      name: 'the earlier of two calls finished first',
      history: [...lead, ...tool('a', 'completed'), ...tool('b', 'running')],
      hold: (history) => history.length,
    },
    {
      name: 'a waiting call, then text still streaming',
      history: [...lead, ...tool('slow', 'running'), ...finished('quick', 3), ...text('streaming', 'still gro')],
      hold: (history) => history.at(-1)?.type === 'model-output' ? history.length - 1 : history.length,
    },
    {
      // A late result must keep its position even after hundreds of later rows.
      name: 'a waiting call further back than the search',
      history: [...lead, ...tool('orphan', 'running'), ...finished('later', 160)],
      hold: (history) => history.length,
    },
    {
      // Many pending tools still occupy durable, reloadable slots.
      name: 'a trailing run of calls longer than the search',
      history: [...lead, ...finished('done', 2), ...Array.from({ length: 70 }, (_, index) => tool(`run${index}`, 'running')).flat()],
      hold: (history) => history.length,
    },
  ];
  const same = (left: unknown, right: unknown, what: string) => {
    assert(JSON.stringify(left) === JSON.stringify(right), `${what}: ${JSON.stringify(left).slice(0, 200)} != ${JSON.stringify(right).slice(0, 200)}`);
  };
  for (const { name, history, hold } of cases) {
    const expected = hold(history);
    assert(expected >= 0, `${name}: the fixture has the call it names`);
    same(runningTurnHoldEnd(0, history.length, (index) => history[index]!), expected, `${name}: the hold`);
    const identity = source(`running-hold-${name}`, history.length);
    const encoded = EncodedHistoryPageCache.create(identity, history);
    assert(encoded, `${name}: the fixture fits the encoded cache`);
    const builder = new IndexedHistoryPageCacheBuilder();
    history.forEach((message, index) => assert(builder.accept(message, index), `${name}: the index overflowed at ${index}`));
    let recordsRead = 0;
    const indexed = builder.finish(identity, {
      retainedBytes: 0,
      read(locations) {
        recordsRead += locations.length;
        return {
          identity,
          messages: locations.map((location) => history[location]!),
          work: { recordsRead: locations.length, bytesRead: 0 },
        };
      },
    });
    assert(indexed, `${name}: the fixture fits the native index`);

    const { framed } = holdRunningTurn(history);
    same(framed.length, expected, `${name}: the whole-array attach ends at the hold`);
    const attach = historyDelta(framed);
    const indexedAttach = await indexed.loadAttach(undefined, 500, undefined, Number.POSITIVE_INFINITY, undefined, true);
    assert(!('kind' in indexedAttach), `${name}: the indexed attach was served`);
    same([indexedAttach.cursor, indexedAttach.endCursor], [attach.cursor, attach.endCursor], `${name}: the indexed attach ends where the whole-array attach does`);

    // Every count bound, from the opening boundary and from one just before the hold: a refresh or
    // a newer page never names a boundary past the hold, and every path names the same one.
    for (const at of [0, Math.max(0, expected - 1)]) {
      const cursor = backwardHistoryCursor(history, at);
      const since = historyCursorFromHash(at, backwardHistoryCursorHash(history, at));
      for (let limit = 1; limit <= history.length - at; limit += 1) {
        const reference = forwardHistoryPage(history, cursor, limit, undefined, { holdTrailingText: true });
        assert(!reference.gap && (backwardHistoryCursorBoundary(reference.cursor) ?? -1) <= Math.max(at, expected),
          `${name}: a newer page of ${limit} from ${at} stops at the hold`);
        same(await encoded.loadNewerPage(cursor, limit, undefined, undefined, { holdTrailingText: true }), reference, `${name}: encoded newer page ${at}/${limit}`);
        same(await indexed.loadNewerPage(cursor, limit, undefined, undefined, { holdTrailingText: true }), reference, `${name}: indexed newer page ${at}/${limit}`);
        const options = { max: limit, holdTrailingText: true };
        const refreshed = historyRefresh(history, since, options);
        assert(!('gap' in refreshed) && (backwardHistoryCursorBoundary(refreshed.endCursor) ?? -1) <= Math.max(at, expected),
          `${name}: a refresh of ${limit} from ${at} stops at the hold`);
        same(await indexed.loadRefresh(since, options), refreshed, `${name}: indexed refresh ${at}/${limit}`);
        same(encoded.loadRefresh(since, options), refreshed, `${name}: encoded refresh ${at}/${limit}`);
      }
    }
    // The index reads only the newest rows the hold looks at, never the whole history.
    recordsRead = 0;
    await indexed.loadNewerPage(backwardHistoryCursor(history, 0), 1, undefined, undefined, { holdTrailingText: true });
    assert(recordsRead <= 17, `${name}: the indexed hold read ${recordsRead} of ${history.length} rows`);
    const completed = history.map((message) => message.type === 'tool-result' && message.pending
      ? { ...message, pending: false, text: 'late completion' } : message);
    for (let at = 1; at <= history.length; at += 1) {
      const cursor = backwardHistoryCursor(history, at);
      const page = backwardHistoryPage(completed, cursor, 1);
      assert(!page.gap, `${name}: completion invalidated boundary ${at}`);
      const original = history[at - 1];
      if (original?.type === 'tool-result' && original.pending) {
        assert(page.messages[0]?.type === 'tool-result' && page.messages[0].pending === false,
          `${name}: reloading a reserved slot returns the completed result`);
      }
    }
  }
}

function backwardHistoryCursorHash(messages: AgentMessage[], boundary: number): string {
  const decoded = JSON.parse(
    Buffer.from(backwardHistoryCursor(messages, boundary), 'base64url').toString('utf8'),
  ) as { h: string };
  return decoded.h;
}

console.log('PASS H1 bounded encoded broker history page cache');
