#!/usr/bin/env bun
/**
 * Kimi across TWO cosyncing clients: one Drive connection, two sockets.
 *
 * Reported on the 2026-08-20 physical pass — same session, one client showing
 * Drive and the other showing Observe forever. The roster agreed; the session
 * view did not. The cause was not a stale control snapshot but a missing
 * capability: `Hub.sessionDetailFrame` offers `joinExisting` only when the
 * backend declares `supportsCrossClientDriveSharing`, and Kimi declared it
 * false — so a second client was never offered the join and stayed on its own
 * read-only observe connection with nothing it could do about it.
 *
 * What makes the share safe is that the join hands the second socket the
 * EXISTING drive connection (`Hub.joinExisting` never attaches), so the Kimi
 * session still has exactly one writer — the invariant the whole ownership
 * boundary in the adapter exists to protect. See `kimiCapabilities()`.
 *
 * Runs the REAL adapter against a fake Kimi host, so the capability, the
 * ownership rule (only a session this process created may be driven), the
 * live-attach socket precondition, and the broker's owner/authority split are
 * all the production ones. No Kimi process, no network beyond loopback.
 *
 *   bun run packages/typescript/broker/test/broker/test-kimi-cross-client-join.ts
 */
export {};
import { Hub, type WireEvent } from '../../src/sessions/hub.ts';
import { JoinExistingError } from '../../src/sessions/session-owner.ts';
import { AgentRegistry } from '../../../adapter-api/src/index.ts';
import type { AttachMode, SessionConnection } from '../../../adapter-api/src/index.ts';
import { KimiAdapter } from '../../../adapters/kimi/src/index.ts';
import type { KimiSocketLike } from '../../../adapters/kimi/src/observe.ts';

let failures = 0;
const check = (label: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  — ${extra}` : ''}`);
  if (!ok) failures += 1;
};

// ── Fake Kimi host ──────────────────────────────────────────────────────────
//
// The identity gate is a precondition of this suite, not its subject: the
// registry record's start time and the `/meta` body that binds to it are a
// realistic PAIR (sibling ids, meta 200ms later), exactly as `test-kimi-server.ts`
// requires a fixture to buy the gate rather than make it true by construction.

const SERVER_ID = 'srv_join_fixture';
const SERVER_STARTED_AT = 1_786_657_461_604;
const SERVER_META = {
  server_version: '0.35.0',
  server_id: 'api_join_fixture',
  started_at: new Date(SERVER_STARTED_AT + 200).toISOString(),
  capabilities: { websocket: true },
  dangerous_bypass_auth: false,
};
const WORKSPACE = '/fixture/workspace';
const ok = (data: unknown) => ({ code: 0, msg: 'success', data, request_id: 'req_fixture' });

let nextSessionOrdinal = 0;
const createdIds: string[] = [];

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    if (path === '/api/v1/healthz') return Response.json(ok({ ok: true }));
    if (request.headers.get('authorization') !== 'Bearer fixture-token') {
      return Response.json({ code: 40101, msg: 'unauthorized', data: null, request_id: 'r' }, { status: 401 });
    }
    if (path === '/api/v1/meta') return Response.json(ok(SERVER_META));
    if (path === '/api/v1/models') {
      return Response.json(ok({ items: [{ provider: 'managed:kimi-code', model: 'kimi-code/k3', display_name: 'K3' }] }));
    }
    if (path === '/api/v2/sessions') {
      return Response.json(ok({
        items: createdIds.map((id) => ({
          id,
          workspace: { id: 'wd_0001', cwd: WORKSPACE },
          meta: { title: id, created_at: '2026-08-14T09:00:00.000Z', updated_at: '2026-08-14T09:00:00.000Z' },
          activity: { status: 'idle' },
        })),
        has_more: false,
      }));
    }
    if (request.method === 'POST' && path === '/api/v1/sessions') {
      nextSessionOrdinal += 1;
      const id = `session_join_${nextSessionOrdinal}`;
      createdIds.push(id);
      return Response.json(ok({
        id, workspace_id: 'wd_0001', title: 'from cosyncing',
        created_at: '2026-08-14T09:00:00.000Z', updated_at: '2026-08-14T09:00:00.000Z',
        busy: false, pending_interaction: 'none', metadata: { cwd: WORKSPACE },
        agent_config: { model: '' }, usage: {}, permission_rules: [], message_count: 0, last_seq: 0,
      }));
    }
    const session = path.match(/^\/api\/v1\/sessions\/([^/]+?)(?:\/(.*))?$/);
    if (session && request.method === 'GET') {
      const tail = session[2];
      if (tail === 'messages') return Response.json(ok({ items: [], has_more: false }));
      if (tail === 'status') {
        return Response.json(ok({ context_tokens: 10, max_context_tokens: 262_144, model: 'kimi-code/k3' }));
      }
      if (tail === 'approvals' || tail === 'questions') return Response.json(ok({ items: [] }));
      if (tail === 'skills') return Response.json(ok({ skills: [] }));
      if (!tail) {
        return Response.json(ok({
          id: session[1], busy: false, pending_interaction: 'none', last_turn_reason: 'completed',
          metadata: { cwd: WORKSPACE }, title: 'from cosyncing',
        }));
      }
    }
    return Response.json({ code: 40401, msg: 'not found', data: null, request_id: 'r' });
  },
});

const baseUrl = `http://127.0.0.1:${server.port ?? 0}`;

/** A socket that OPENS on the next macrotask, the way a real loopback one does. */
class FakeSocket implements KimiSocketLike {
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  send(): void { /* the live-attach gate only needs the stream to be up */ }
  close(): void { this.fire('close', {}); }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  fire(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

const adapter = new KimiAdapter({
  env: {},
  homeDir: '/fixture/home',
  instanceScan: () => ({
    live: [{
      baseUrl, port: server.port ?? 0, pid: process.pid,
      serverId: SERVER_ID, hostVersion: '0.35.0', startedAt: SERVER_STARTED_AT,
    }],
    stale: 0, invalid: 0, truncated: false,
  }),
  readToken: () => 'fixture-token',
  liveAttachSocketMs: 2_000,
  observe: {
    socketFactory: () => {
      const socket = new FakeSocket();
      setTimeout(() => socket.fire('open', {}), 0);
      return socket;
    },
    // No real timers: the poll would keep reading the fixture for the whole run.
    setInterval: () => 1,
    clearInterval: () => {},
  },
});

// Counted around the REAL attach, because "the join performs no native attach"
// is the property that makes one writer stay one writer.
let attachCalls = 0;
const realAttach = adapter.attach.bind(adapter);
adapter.attach = ((id: string, mode?: AttachMode, options?: unknown): Promise<SessionConnection> => {
  attachCalls += 1;
  return realAttach(id, mode, options as never);
}) as typeof adapter.attach;

const registry = new AgentRegistry();
registry.register(adapter);
const hub = new Hub(registry, 15_000);

try {
  // ── A. Owner first, observer second ───────────────────────────────────────
  {
    const created = await adapter.createSession!({ directory: WORKSPACE });
    const driver = await hub.ensure('kimi', created.id, 'live');
    driver.addClient(() => {});
    const driverFrame = hub.sessionDetailFrame(driver, true);
    check('A1 the live attach is the session-level Drive owner',
      driverFrame.info.sessionOwner?.state === 'drive' && driverFrame.authority?.canMutate === true,
      JSON.stringify({ owner: driverFrame.info.sessionOwner, authority: driverFrame.authority }));

    // The second client lands on its own observe connection — the bare
    // `kimi:<id>` key — which is read-only by construction.
    const observer = await hub.ensure('kimi', created.id);
    observer.addClient(() => {});
    check('A2 the second client gets a DIFFERENT connection, not the driver',
      observer !== driver && attachCalls === 2, `attachCalls=${attachCalls}`);

    const observerFrame = hub.sessionDetailFrame(observer, true);
    check('A3 the observing socket stays explicitly read-only',
      observerFrame.authority?.canMutate === false && observerFrame.authority.prompt === 'none',
      JSON.stringify(observerFrame.authority));
    check('A4 ...and is offered the join action Kimi used not to advertise',
      observerFrame.joinExisting?.ownerRevision !== undefined,
      JSON.stringify(observerFrame.joinExisting));

    const joined = hub.joinExisting('kimi', created.id, observerFrame.joinExisting!.ownerRevision);
    check('A5 the join reuses the EXACT drive connection — still one writer',
      joined === driver, `same=${joined === driver}`);
    check('A6 ...and performs no native attach', attachCalls === 2, `attachCalls=${attachCalls}`);

    const joinedFrame = hub.sessionDetailFrame(joined, true);
    check('A7 both sockets now report mutation authority',
      joinedFrame.authority?.canMutate === true
        && hub.sessionDetailFrame(driver, true).authority?.canMutate === true,
      JSON.stringify(joinedFrame.authority));
    check('A8 the joined socket is offered no second join',
      joinedFrame.joinExisting === undefined, JSON.stringify(joinedFrame.joinExisting));

    // Fails closed on a revision the client did not observe: the owner may have
    // changed between the frame and the click.
    let staleCode = '';
    try {
      hub.joinExisting('kimi', created.id, {
        ...observerFrame.joinExisting!.ownerRevision,
        seq: observerFrame.joinExisting!.ownerRevision.seq + 1,
      });
    } catch (error) {
      staleCode = error instanceof JoinExistingError ? error.code : String(error);
    }
    check('A9 a stale owner revision fails closed, with no native attach',
      staleCode === 'JOIN_OWNER_STALE' && attachCalls === 2, `code=${staleCode} attachCalls=${attachCalls}`);
  }

  // ── B. Observer first, owner second ───────────────────────────────────────
  //
  // The reported order. An already-open observer must LEARN that a sibling took
  // Drive — the broker pushes the owner projection to every matching connection
  // — and the join must then be offered on its next session frame, without that
  // socket re-attaching anything.
  {
    const created = await adapter.createSession!({ directory: WORKSPACE });
    const before = attachCalls;
    const observer = await hub.ensure('kimi', created.id);
    const seen: Array<Extract<WireEvent, { kind: 'session' }>> = [];
    observer.addClient((event) => {
      if (event.kind === 'session') seen.push(event as Extract<WireEvent, { kind: 'session' }>);
    });
    const beforeJoinOffer = hub.sessionDetailFrame(observer, true);
    check('B1 an observer with no owner yet is offered nothing to join',
      beforeJoinOffer.joinExisting === undefined && beforeJoinOffer.authority?.canMutate === false,
      JSON.stringify(beforeJoinOffer.joinExisting));

    const driver = await hub.ensure('kimi', created.id, 'live');
    driver.addClient(() => {});
    const afterOwner = hub.sessionDetailFrame(observer, true);
    check('B2 the sibling taking Drive is pushed to the open observer as a session frame',
      seen.some((event) => event.info.sessionOwner?.state === 'drive'),
      JSON.stringify(seen.map((event) => event.info.sessionOwner)));
    check('B3 ...and that observer is now offered the join, having re-attached nothing',
      afterOwner.joinExisting?.ownerRevision !== undefined && attachCalls === before + 2,
      `join=${JSON.stringify(afterOwner.joinExisting)} attachCalls=${attachCalls - before}`);
    check('B4 the observer socket is still read-only until it actually joins',
      afterOwner.authority?.canMutate === false, JSON.stringify(afterOwner.authority));

    const joined = hub.joinExisting('kimi', created.id, afterOwner.joinExisting!.ownerRevision);
    check('B5 joining in this order also reuses the one drive connection',
      joined === driver && attachCalls === before + 2, `same=${joined === driver} attachCalls=${attachCalls - before}`);
    check('B6 ...and the joined socket can now mutate',
      hub.sessionDetailFrame(joined, true).authority?.canMutate === true);
  }

  // ── C. A socket that may not act is offered no join ───────────────────────
  //
  // Sharing Drive is not a way around a socket that cannot hold authority. The
  // runtime passes `allowJoinAction = credentialAuthenticated && !readOnly`
  // (`runtime.ts`, the per-socket `session` re-envelope), so an unauthenticated
  // or incompatible socket asks for the frame with the action suppressed — and
  // the frame it gets back must carry no join, whatever the owner is doing.
  {
    const created = await adapter.createSession!({ directory: WORKSPACE });
    const driver = await hub.ensure('kimi', created.id, 'live');
    driver.addClient(() => {});
    const observer = await hub.ensure('kimi', created.id);
    const suppressed = hub.sessionDetailFrame(observer, false);
    check('C1 with the join action suppressed the socket is offered no join',
      suppressed.joinExisting === undefined && suppressed.authority?.canMutate === false,
      JSON.stringify({ join: suppressed.joinExisting, authority: suppressed.authority }));
    // ...and the owner truth is still published to it, which is what lets the
    // client say WHO is driving instead of silently offering nothing.
    check('C2 ...while the session owner is still reported to it',
      suppressed.info.sessionOwner?.state === 'drive', JSON.stringify(suppressed.info.sessionOwner));
    // A declared read-only socket keeps its authority denial even when the
    // action is allowed — the two are separate facts, and the runtime ties them
    // together on the socket's behalf.
    const declaredReadOnly = hub.sessionDetailFrame(observer, true, observer.conn.info, true);
    check('C3 a declared read-only socket is never given mutation authority',
      declaredReadOnly.authority?.canMutate === false, JSON.stringify(declaredReadOnly.authority));
  }
} finally {
  await hub.dispose();
  server.stop(true);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`);
process.exit(failures ? 1 : 0);
