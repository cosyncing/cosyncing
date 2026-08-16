#!/usr/bin/env bun
/**
 * Kimi Drive authority across TWO clients on one session, through a real
 * {@link Hub}.
 *
 * This lives on the broker side rather than in the adapter package because the
 * hazard is a composition fact. `Hub.key` folds an ABSENT mode and `'observe'`
 * onto the same bare `tool:id` connection (`hub.ts:996-1000`), and every client
 * that lands on a connection inherits `canMutate` from that connection's
 * `info.control` (`session-owner.ts:34-44`). So an adapter that treats "no mode"
 * as a Drive request does not merely give one caller more than it asked for — it
 * installs a mutating connection on the key that the client's background Observe
 * watcher attaches to, and the watcher is documented to "never restore or
 * acquire Drive" (`session_detail_controller.dart:56-57`). Every later bare
 * attach then folds onto it and inherits write authority nobody requested.
 *
 * Reproducing that with a hand-built pair of connections would prove only that
 * the arrangement matches someone's belief about the broker; driving the real
 * Hub proves it against the broker's actual keying and its actual authority
 * gate. What is pinned:
 *
 *  - a background (no-mode) attach has authority `{canMutate:false,
 *    prompt:'none'}` and issues ZERO writes, on a session cosyncing OWNS;
 *  - an explicit `mode='live'` attach on the SAME session is a DIFFERENT
 *    connection, on the `#live` key, and it can genuinely drive;
 *  - the background socket never gains authority from the foreground one, and a
 *    second background attach folding onto it gains none either.
 *
 * Runs against a fake `kap-server` answering the real envelope shape, with
 * injected timers and sockets: no Kimi process, no model, no real waiting.
 *
 *   bun run packages/typescript/broker/test/kimi/test-kimi-drive-authority.ts
 */
export {};
import { AgentRegistry } from '@cosyncing/adapter-api';
import { KimiAdapter } from '../../../adapters/kimi/src/index.ts';
import type { KimiInstanceScan } from '../../../adapters/kimi/src/server.ts';
import type { KimiSocketLike } from '../../../adapters/kimi/src/observe.ts';
import { KimiDriveConnection } from '../../../adapters/kimi/src/drive.ts';
import { Hub } from '../../src/sessions/hub.ts';
import { sessionConnectionAuthority } from '../../src/sessions/session-owner.ts';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const SERVER_ID = 'srv_authority_fixture';
const CREATED_ID = 'session_authority_0001';
const WORKSPACE = '/fixture/workspace';

/** The server's uniform envelope. `code` carries the business outcome, never the HTTP status. */
const ok = (data: unknown) => ({ code: 0, msg: 'success', data, request_id: 'req_fixture' });

interface Recorded { method: string; path: string }
const requests: Recorded[] = [];
const writes = () => requests.filter((entry) => entry.method === 'POST');

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    requests.push({ method: request.method, path });

    if (path === '/api/v1/healthz') return Response.json(ok({ ok: true }));
    if (request.headers.get('authorization') !== 'Bearer fixture-token') {
      return Response.json({ code: 40101, msg: 'unauthorized', data: null, request_id: 'r' }, { status: 401 });
    }
    if (path === '/api/v1/meta') return Response.json(ok({ server_id: SERVER_ID }));
    if (path === '/api/v2/sessions') {
      return Response.json(ok({
        items: [{
          id: CREATED_ID,
          workspace: { id: 'wd_0001', cwd: WORKSPACE },
          meta: {
            title: 'authority fixture',
            created_at: '2026-08-15T09:00:00.000Z',
            updated_at: '2026-08-15T09:00:00.000Z',
          },
          activity: { status: 'idle' },
        }],
        has_more: false,
      }));
    }
    if (request.method === 'POST' && path === '/api/v1/sessions') {
      return Response.json(ok({
        id: CREATED_ID, workspace_id: 'wd_0001', title: 'authority fixture',
        created_at: '2026-08-15T09:00:00.000Z', updated_at: '2026-08-15T09:00:00.000Z',
        busy: false, pending_interaction: 'none', metadata: { cwd: WORKSPACE },
        agent_config: { model: '' }, usage: {}, permission_rules: [], message_count: 0, last_seq: 0,
      }));
    }

    const session = path.match(/^\/api\/v1\/sessions\/([^/]+?)(?::(\w+))?(?:\/(.*))?$/);
    if (session) {
      const tail = session[3];
      if (request.method === 'POST' && tail === 'prompts') {
        return Response.json(ok({
          prompt_id: 'prompt_1', user_message_id: 'msg_user_1', status: 'running',
          content: [{ type: 'text', text: 'hello' }], created_at: '2026-08-15T09:00:00.000Z',
        }));
      }
      if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });
      if (tail === 'messages') return Response.json(ok({ items: [], has_more: false }));
      if (tail === 'status') {
        return Response.json(ok({ context_tokens: 100, max_context_tokens: 262_144 }));
      }
      if (tail === 'approvals' || tail === 'questions') return Response.json(ok({ items: [] }));
      if (!tail) {
        return Response.json(ok({
          id: CREATED_ID, busy: false, pending_interaction: 'none',
          last_turn_reason: 'completed', metadata: { cwd: WORKSPACE },
        }));
      }
    }
    return Response.json({ code: 40401, msg: 'not found', data: null, request_id: 'r' });
  },
});

const baseUrl = `http://127.0.0.1:${server.port ?? 0}`;
const scan: KimiInstanceScan = {
  live: [{ baseUrl, port: server.port ?? 0, serverId: SERVER_ID, hostVersion: '0.35.0' }],
  stale: 0, invalid: 0, truncated: false,
};

/**
 * A socket that actually completes its handshake, on the next macrotask, the
 * way a real loopback WebSocket does.
 *
 * It has to open: a live attach whose stream never opens is REFUSED, because
 * approval requests arrive on that stream and it is also how a second writer is
 * detected — mutation authority without it would be authority over a session
 * this process can neither answer for nor watch. So a suite about who holds
 * that authority needs a connection that legitimately holds it.
 */
class FakeSocket implements KimiSocketLike {
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor() {
    setTimeout(() => {
      for (const listener of [...(this.listeners.get('open') ?? [])]) listener({});
    }, 0);
  }
  send(): void {}
  close(): void {}
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
}

const threw = async (work: () => Promise<unknown>): Promise<Error | undefined> =>
  work().then(() => undefined, (error: Error) => error);

let hub: Hub | undefined;
try {
  // The narrowed type is the gate stated in the type system: `createSession` is
  // an optional property that only EXISTS behind `drive`, so a reader who
  // forgets the flag gets a compile error rather than a runtime one.
  const adapter = new KimiAdapter({
    env: {}, homeDir: '/fixture/home',
    // The DRIVE GATE, asked for explicitly: it is default-off, and with it off
    // nothing can create a session, so there would be no owned session for this
    // suite's whole question to be about.
    drive: true,
    instanceScan: () => scan,
    readToken: () => 'fixture-token',
    // A ceiling, not a wait: the fake socket opens on the next macrotask, so the
    // attach returns as soon as its stream is up and this suite does no real
    // waiting.
    liveAttachSocketMs: 500,
    observe: {
      socketFactory: () => new FakeSocket(),
      // Captured and never fired: no poll tick may run inside this suite, so
      // every request below is one an attach or an assertion asked for.
      setInterval: () => 1,
      clearInterval: () => {},
    },
  }) as KimiAdapter & Required<Pick<KimiAdapter, 'createSession'>>;
  const registry = new AgentRegistry();
  registry.register(adapter);
  hub = new Hub(registry);

  // Owned by construction: this process created it, which is the ONLY thing that
  // makes Drive available at all. Everything below is about whether that
  // permission is enough on its own — it must not be.
  const created = await adapter.createSession({ directory: WORKSPACE });
  check('the fixture session is created and owned',
    created.id === CREATED_ID && created.control?.drive.supported === true,
    JSON.stringify(created.control));

  // ── The background watcher: no mode, therefore no authority ───────────────

  const beforeBackground = writes().length;
  const background = await hub.ensure('kimi', CREATED_ID);
  const backgroundAuthority = sessionConnectionAuthority(background.conn.info);
  check('a background (no-mode) attach on an OWNED session gets no mutation authority',
    JSON.stringify(backgroundAuthority) === JSON.stringify({ canMutate: false, prompt: 'none' }),
    JSON.stringify(backgroundAuthority));
  check('the background attach is an observe connection, not a drive one',
    !(background.conn instanceof KimiDriveConnection)
      && background.conn.info.attachMode === 'observe'
      && background.conn.info.control?.drive.state === 'observing'
      // Still SUPPORTED: the client should see that Drive is available for this
      // session. It simply was not requested on this socket.
      && background.conn.info.control.drive.supported === true,
    `${background.conn.constructor.name} ${JSON.stringify(background.conn.info.control)}`);

  // NEGATIVE CONTROL: prove the ABSENCE of a write. A background watcher that
  // acquired Drive would not necessarily write — the point is that it cannot.
  const backgroundWrite = await threw(() => background.conn.sendPrompt({ text: 'should never send' }));
  check('the background connection refuses to mutate, and issued ZERO writes',
    !!backgroundWrite && writes().length === beforeBackground,
    `${backgroundWrite?.message} writes=${writes().length - beforeBackground}`);

  // ── The foreground attach: an EXPLICIT request, on its own key ────────────

  const foreground = await hub.ensure('kimi', CREATED_ID, 'live');
  const foregroundAuthority = sessionConnectionAuthority(foreground.conn.info);
  check('an explicit mode=live attach on the same session CAN drive',
    foreground.conn instanceof KimiDriveConnection
      && JSON.stringify(foregroundAuthority) === JSON.stringify({ canMutate: true, prompt: 'full' }),
    `${foreground.conn.constructor.name} ${JSON.stringify(foregroundAuthority)}`);
  // The two must be distinct owners on distinct keys. Had the bare attach
  // produced a driving connection, `Hub.ensure` would have FOLDED this `#live`
  // request onto it — a bare owner already reporting `drive.state:'driving'` is
  // joined rather than duplicated (hub.ts:1685-1695) — and the two clients would
  // then share one connection and one authority. That fold IS the defect: the
  // authority a foreground client asks for would arrive on the key every
  // background watcher attaches to.
  const owners = new Map(hub.liveSnapshot().map((entry) => [entry.key, entry.info]));
  const bareInfo = owners.get(`kimi:${CREATED_ID}`);
  const liveInfo = owners.get(`kimi:${CREATED_ID}#live`);
  check('the two attaches are DISTINCT connections, on the bare and the #live keys',
    foreground !== background
      && !!bareInfo && !!liveInfo
      && sessionConnectionAuthority(bareInfo).canMutate === false
      && sessionConnectionAuthority(liveInfo).canMutate === true,
    `keys=${[...owners.keys()].join(',')} same=${foreground === background}`);

  const beforeDrivePrompt = writes().length;
  await foreground.conn.sendPrompt({ text: 'a real prompt' });
  check('the foreground connection genuinely writes, so authority was withheld and not removed',
    writes().length === beforeDrivePrompt + 1,
    `writes=${writes().length - beforeDrivePrompt}`);

  // ── The background socket never inherits ─────────────────────────────────

  const backgroundAfter = sessionConnectionAuthority(background.conn.info);
  check('the background socket still has no authority once a driving one exists',
    JSON.stringify(backgroundAfter) === JSON.stringify({ canMutate: false, prompt: 'none' }),
    JSON.stringify(backgroundAfter));
  const stillRefused = await threw(() => background.conn.sendPrompt({ text: 'still no' }));
  check('the background connection still refuses to mutate after the drive attach',
    !!stillRefused, stillRefused?.message ?? '(did not throw)');

  // The fold itself: a SECOND background attach lands on the same bare key, which
  // is precisely why that key must never carry write authority.
  const secondBackground = await hub.ensure('kimi', CREATED_ID);
  const secondAuthority = sessionConnectionAuthority(secondBackground.conn.info);
  check('a second background attach folds onto the same connection and gains no authority',
    secondBackground === background
      && JSON.stringify(secondAuthority) === JSON.stringify({ canMutate: false, prompt: 'none' }),
    `folded=${secondBackground === background} ${JSON.stringify(secondAuthority)}`);

  // An explicit observe attach is the same posture, reached deliberately — and
  // the hub keys it onto the same bare connection, which is the other half of
  // why an absent mode cannot mean something stronger.
  const explicitObserve = await hub.ensure('kimi', CREATED_ID, 'observe');
  check('an explicit observe attach keys onto the same authority-free connection',
    explicitObserve === background
      && sessionConnectionAuthority(explicitObserve.conn.info).canMutate === false,
    `folded=${explicitObserve === background}`);
} catch (error) {
  check('test harness completed', false, error instanceof Error ? error.message : String(error));
} finally {
  await hub?.dispose();
  server.stop(true);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
