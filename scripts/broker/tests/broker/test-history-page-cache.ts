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
} from '../../../../packages/typescript/adapter-api/src/index.ts';
import { mapTranscript } from '../../../../packages/typescript/adapters/claude/src/index.ts';
import { mapRollout } from '../../../../packages/typescript/adapters/codex/src/index.ts';
import { OpenCodeAdapter } from '../../../../packages/typescript/adapters/opencode/src/index.ts';
import { mapPiJsonlText } from '../../../../packages/typescript/adapters/pi/src/index.ts';
import {
  backwardHistoryCursor,
  isBackwardPageMessage,
} from '../../../../packages/typescript/broker/src/history-delta.ts';
import {
  EncodedHistoryPageCache,
  EncodedHistoryPageCacheBuilder,
  HISTORY_PAGE_CACHE_MAX_ATTACH_PROJECTIONS,
  HISTORY_PAGE_CACHE_MAX_ENTRY_BYTES,
  HISTORY_PAGE_CACHE_MAX_ENTRY_MESSAGES,
  HISTORY_PAGE_CACHE_MAX_PAGE_MESSAGES,
  HistoryPageCachePool,
  HISTORY_PAGE_CACHE_MAX_PROJECTION_ENTRIES,
  IndexedHistoryPageCacheBuilder,
} from '../../../../packages/typescript/broker/src/history-page-cache.ts';
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
  assert(
    history.length === FIXTURE_MESSAGES,
    `${tool}: native mapper produced ${history.length}/${FIXTURE_MESSAGES} messages`,
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
    transmittedMessages === FIXTURE_MESSAGES - INITIAL_TAIL,
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

console.log('PASS H1 bounded encoded broker history page cache');
