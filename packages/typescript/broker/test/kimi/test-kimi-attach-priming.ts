#!/usr/bin/env bun
/**
 * The Kimi attach ORDER, through a real {@link ManagedConn}.
 *
 * This lives on the broker side rather than in the adapter package because the
 * property under test is a composition fact, not an adapter fact: `ManagedConn`
 * subscribes in its CONSTRUCTOR and the runtime reads history afterwards, so
 * live rows can arrive before the history reset that will also contain them.
 * Reproducing that with a hand-arranged subscribe/read order would prove only
 * that the arrangement matches someone's belief about the broker; driving the
 * real wrapper proves it against the broker's actual sequence.
 *
 * Before the adapter's priming boundary, a poll tick landing in that window
 * emitted rows the following history reset then repeated, and the client stored
 * each of them twice.
 *
 * Runs against a fake Kimi server replaying sanitized 0.35.0 captures, with
 * injected timers and sockets: no Kimi process, no model, no real waiting.
 *
 *   bun run packages/typescript/broker/test/kimi/test-kimi-attach-priming.ts
 */
export {};
import { KimiAdapter } from '../../../adapters/kimi/src/index.ts';
import { decodeKimiInstanceRecord, type KimiInstanceScan } from '../../../adapters/kimi/src/server.ts';
import type { KimiObserveConnection, KimiSocketLike } from '../../../adapters/kimi/src/observe.ts';
import { ManagedConn, type WireEvent } from '../../src/sessions/hub.ts';

const FIXTURE = await Bun.file(
  new URL('../../../adapters/kimi/test/fixtures/kimi-0.35.0.json', import.meta.url),
).json() as {
  kimiVersion: string;
  sessionId: string;
  rest: Record<string, { code: number; msg: string; data: unknown }>;
  instanceRecord: Record<string, unknown>;
};

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });
    if (url.pathname === '/api/v1/healthz') return Response.json(FIXTURE.rest.healthz);
    if (request.headers.get('authorization') !== 'Bearer fixture-token') {
      return Response.json(FIXTURE.rest.metaUnauthorized, { status: 401 });
    }
    if (url.pathname === '/api/v1/meta') return Response.json(FIXTURE.rest.meta);
    if (url.pathname === '/api/v2/sessions') return Response.json(FIXTURE.rest.v2Sessions);
    if (url.pathname === `/api/v1/sessions/${FIXTURE.sessionId}/status`) {
      return Response.json(FIXTURE.rest.status);
    }
    if (url.pathname === `/api/v1/sessions/${FIXTURE.sessionId}/messages`) {
      const beforeId = url.searchParams.get('before_id');
      const pageSize = Number(url.searchParams.get('page_size') ?? '100');
      // Real 0.35.0 paging: items are NEWEST-FIRST and `before_id` walks back.
      const all = (FIXTURE.rest.messagesAll!.data as { items: Array<{ id: string }> }).items;
      const start = beforeId ? all.findIndex((item) => item.id === beforeId) + 1 : 0;
      const window = all.slice(start, start + pageSize);
      return Response.json({
        code: 0,
        msg: 'success',
        data: { items: window, has_more: start + window.length < all.length },
        request_id: 'fixture',
      });
    }
    return Response.json(FIXTURE.rest.messagesUnknownSession);
  },
});

const listenPort = server.port ?? 0;
const baseUrl = `http://127.0.0.1:${listenPort}`;
// The registry record AS CAPTURED: its `server_id` is upstream's own and
// differs from the one the captured `/api/v1/meta` echoes. Only the address is
// redirected at the fake server.
const FIXTURE_RECORD = decodeKimiInstanceRecord(FIXTURE.instanceRecord)!;
const scan: KimiInstanceScan = {
  live: [{
    baseUrl,
    port: listenPort,
    pid: FIXTURE_RECORD.pid,
    serverId: FIXTURE_RECORD.serverId,
    hostVersion: FIXTURE_RECORD.hostVersion,
    startedAt: FIXTURE_RECORD.startedAt,
  }],
  stale: 0,
  invalid: 0,
  truncated: false,
};

class FakeSocket implements KimiSocketLike {
  send(): void {}
  close(): void {}
  addEventListener(): void {}
}

try {
  let intervalHandler: (() => void) | undefined;
  const adapter = new KimiAdapter({
    env: {}, homeDir: '/fixture/home',
    instanceScan: () => scan,
    readToken: () => 'fixture-token',
    observe: {
      socketFactory: () => new FakeSocket(),
      setInterval: (handler) => { intervalHandler = handler; return 1; },
      clearInterval: () => { intervalHandler = undefined; },
    },
  });

  const conn = await adapter.attach(FIXTURE.sessionId) as KimiObserveConnection;
  const managed = new ManagedConn(conn); // subscribes NOW, exactly as the broker does
  const wire: WireEvent[] = [];
  managed.addClient((event) => wire.push(event));

  // A live refresh lands BEFORE any history read — the production race.
  intervalHandler?.();
  await Bun.sleep(60);
  const liveBeforeHistory = wire.filter((event) => event.kind === 'message');
  check('live rows are withheld until history primes the connection',
    liveBeforeHistory.length === 0, `${liveBeforeHistory.length} early rows`);

  const history = await conn.getHistory();
  await Bun.sleep(60);
  const liveTexts = wire
    .filter((event): event is Extract<WireEvent, { kind: 'message' }> => event.kind === 'message')
    .map((event) => JSON.stringify(event.message));
  const historyTexts = history.map((message) => JSON.stringify(message));
  const duplicated = liveTexts.filter((row) => historyTexts.includes(row));
  check('no row is delivered both live and in the history reset',
    duplicated.length === 0, duplicated.slice(0, 2).join(' | '));
  check('the history read still returned the transcript',
    history.some((m) => m.type === 'user-message'), `${history.length} rows`);

  // After priming, live delivery resumes normally.
  const grown = structuredClone(FIXTURE.rest.messagesAll) as { data: { items: Array<Record<string, unknown>> } };
  grown.data.items.unshift({
    id: 'msg_after_priming', session_id: FIXTURE.sessionId, role: 'assistant',
    content: [{ type: 'text', text: 'arrived after priming' }],
    created_at: '2026-08-14T00:00:00.000Z',
  });
  const restore = FIXTURE.rest.messagesAll!;
  FIXTURE.rest.messagesAll = grown as never;
  intervalHandler?.();
  await Bun.sleep(60);
  FIXTURE.rest.messagesAll = restore;
  const primedRows = wire.filter((event) => event.kind === 'message'
    && JSON.stringify(event.message).includes('arrived after priming'));
  check('a post-priming row is delivered live, exactly once',
    primedRows.length === 1, `${primedRows.length} deliveries`);

  await managed.dispose();
} catch (error) {
  check('test harness completed', false, error instanceof Error ? error.message : String(error));
} finally {
  server.stop(true);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
