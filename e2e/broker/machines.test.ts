/**
 * One roster across machines: `/api/machines` merges this broker's sessions
 * with every configured peer's, says how far each peer can be trusted, and
 * `/api/machines/resolve` routes a session by its composite identity
 * (machine, agent, session) to the broker that owns it.
 *
 * One peer is a real broker. The others are small HTTP peers in this process,
 * each answering the way a peer can go wrong: slow, gone, stale, too old to
 * date its roster, incomplete, unreadable, duplicated, or newly requiring
 * authentication.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BROKER_CONTRACT_REVISION } from '../../packages/typescript/protocol/src/index.ts';
import { type Broker, type BrokerClient, startBroker } from '../harness/index.ts';

const UPGRADE_PEER_TOKEN = `peer-credential-${crypto.randomUUID()}`;

/** In-process peers, one per path prefix: `${url}/<name>/api/sessions`. */
class FakePeers {
  readonly server: ReturnType<typeof Bun.serve>;
  /** The `local` session id, which the `dup` peer reports as its own. */
  localSessionId = '';
  /** `slow` holds its requests until the caller gives up. */
  slowWedged = false;
  /** `upgrade` requires the peer credential from revision 16 on. */
  upgradeRevision = 15;
  readonly seen: { peer: string; contractRevision: string | null; peerToken: string | null }[] = [];

  constructor() {
    this.server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => this.answer(req) });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  private async answer(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const [, peer, ...rest] = url.pathname.split('/');
    if (rest.join('/') !== 'api/sessions') return Response.json({ error: 'not found' }, { status: 404 });
    this.seen.push({
      peer: peer ?? '',
      contractRevision: url.searchParams.get('contractRevision'),
      peerToken: req.headers.get('x-cosyncing-peer-token'),
    });
    const now = Date.now();
    const row = (id: string, tool = 'opencode') => ({ id, tool, title: `${peer} ${id}`, status: 'idle', attachMode: 'observe' });
    switch (peer) {
      case 'fake-a':
        // A Kimi row (an agent older clients cannot decode) and one row that is not a session.
        return Response.json({
          machine: 'fake-a-display', generatedAt: now,
          sessions: [row('fake-a-session'), row('fake-a-kimi', 'kimi'), { malformed: true }],
        });
      case 'slow':
        if (this.slowWedged) {
          await new Promise<void>((resolve) => req.signal.addEventListener('abort', () => resolve(), { once: true }));
          return new Response(null, { status: 499 });
        }
        return Response.json({ machine: 'slow', generatedAt: now, complete: true, sessions: [row('slow-session')] });
      case 'stale':
        return Response.json({ machine: 'stale', generatedAt: 1, sessions: [row('stale-session', 'pi')] });
      case 'legacy':
        return Response.json({ machine: 'legacy', sessions: [], futureAdditiveField: { ignored: true } });
      case 'partial':
        return Response.json({ machine: 'partial', generatedAt: now, complete: false, sessions: [row('partial-session')] });
      case 'garbled':
        return Response.json({ machine: 'garbled', generatedAt: now, complete: 'true', sessions: [row('garbled-session')] });
      case 'twice':
        return Response.json({ machine: 'twice', generatedAt: now, sessions: [row('twice-session'), row('twice-session')] });
      case 'dup':
        return Response.json({ machine: 'dup', generatedAt: now, complete: true, sessions: [row(this.localSessionId, 'pi')] });
      case 'upgrade':
        if (this.upgradeRevision >= 16 && req.headers.get('x-cosyncing-peer-token') !== UPGRADE_PEER_TOKEN) {
          return new Response('unauthorized', { status: 401 });
        }
        return Response.json({ machine: 'upgrade', generatedAt: now, complete: true, sessions: [] });
      case 'twin-1':
      case 'twin-2':
        return Response.json({ machine: peer, generatedAt: now, complete: true, sessions: [row('twin-session')] });
      default:
        return Response.json({ error: 'unknown peer' }, { status: 404 });
    }
  }

  stop(): void {
    this.server.stop(true);
  }
}

async function openPiSession(broker: Broker, name: string): Promise<string> {
  const client = broker.client();
  const hello = await client.post('/pi/bridge/hello', {
    sessionFile: join(broker.paths.root, `${name}.jsonl`), cwd: broker.paths.home, title: name,
  });
  expect(hello.status).toBe(200);
  // A bridged session enters the roster with its first frame.
  await client.post('/pi/bridge/events', { id: hello.body.id, events: [{ t: 'status', running: false }] });
  const id = String(hello.body.id);
  await client.waitForSession((session) => session.id === id);
  return id;
}

const byId = (body: any, machineId: string): any[] => body.machines.filter((machine: any) => machine.machineId === machineId);
const one = (body: any, machineId: string): any => {
  const found = byId(body, machineId);
  expect(found).toHaveLength(1);
  return found[0];
};

describe('the machine roster', () => {
  let peer: Broker;
  let local: Broker;
  let owner: BrokerClient;
  const fakes = new FakePeers();
  let peerSessionId = '';
  let localSessionId = '';

  beforeAll(async () => {
    peer = await startBroker({ name: 'machines-peer', token: true, env: { COSYNCING_MACHINE: 'peer-display' } });
    peerSessionId = await openPiSession(peer, 'peer-session');
    const peers = [
      // A real broker, addressed with a URL that carries a query no response may repeat.
      { id: 'peer-real', url: `${peer.url}?token=must-not-leak`, token: peer.token },
      { id: 'fake-a', url: `${fakes.url}/fake-a` },
      { id: 'slow', url: `${fakes.url}/slow` },
      // Nothing listens on port 1.
      { id: 'down', url: 'http://127.0.0.1:1' },
      { id: 'stale', url: `${fakes.url}/stale` },
      { id: 'legacy', url: `${fakes.url}/legacy` },
      { id: 'partial', url: `${fakes.url}/partial` },
      { id: 'garbled', url: `${fakes.url}/garbled` },
      { id: 'twice', url: `${fakes.url}/twice` },
      { id: 'dup', url: `${fakes.url}/dup` },
      { id: 'upgrade-bare', url: `${fakes.url}/upgrade` },
      { id: 'upgrade-credentialed', url: `${fakes.url}/upgrade`, credential: { kind: 'peer-token', value: UPGRADE_PEER_TOKEN } },
      { id: 'twin', url: `${fakes.url}/twin-1` },
      { id: 'twin', url: `${fakes.url}/twin-2` },
    ];
    local = await startBroker({
      name: 'machines-local',
      token: true,
      env: {
        COSYNCING_MACHINE: 'local-machine',
        COSYNCING_MACHINE_PEERS: JSON.stringify(peers),
        // Generous: only a peer that never answers may reach it.
        COSYNCING_MACHINE_PEER_TIMEOUT_MS: '3000',
      },
    });
    owner = local.client();
    localSessionId = await openPiSession(local, 'local-session');
    fakes.localSessionId = localSessionId;
  });
  afterAll(async () => {
    await local?.stop();
    await peer?.stop();
    fakes.stop();
  });

  const machines = async (query = `?contractRevision=${BROKER_CONTRACT_REVISION}`) => {
    const response = await owner.get(`/api/machines${query}`);
    expect(response.status).toBe(200);
    return response;
  };
  const resolve = (machineId: string, tool: string, sessionId: string) =>
    owner.get(`/api/machines/resolve?${new URLSearchParams({ machineId, tool, sessionId })}`);

  test('only the owner may read or resolve it', async () => {
    for (const client of [local.client({ kind: 'none' }), local.client({ kind: 'owner', token: 'not-the-token' })]) {
      expect((await client.get('/api/machines')).status).toBe(401);
      expect((await client.get(`/api/machines/resolve?machineId=peer-real&tool=pi&sessionId=${peerSessionId}`)).status).toBe(401);
    }
  });

  test('it merges this machine with every peer, says how far each can be trusted, and never repeats a credential', async () => {
    const response = await machines();
    for (const secret of [peer.token!, 'must-not-leak', UPGRADE_PEER_TOKEN, local.token!]) {
      expect(response.text).not.toContain(secret);
    }
    const body = response.body;
    expect(body).toMatchObject({ ok: true, machine: 'local-machine', machineId: 'local-machine' });

    const self = one(body, 'local-machine');
    expect(self).toMatchObject({ role: 'local', status: 'ok', freshness: 'fresh' });
    const own = self.sessions.find((session: any) => session.id === localSessionId);
    expect(own.owner).toMatchObject({ route: 'local', authoritative: true, requiresIndependentAuthentication: false });

    // The real peer: asked as the client this broker is, with the credential it was given.
    const real = one(body, 'peer-real');
    expect(real).toMatchObject({ role: 'peer', machine: 'peer-display', status: 'ok', freshness: 'fresh', baseUrl: peer.url });
    const remote = real.sessions.find((session: any) => session.id === peerSessionId);
    expect(remote.machine).toBe('peer-display');
    expect(remote.identity).toMatchObject({ machineId: 'peer-real', tool: 'pi', sessionId: peerSessionId });
    expect(remote.owner).toMatchObject({
      route: 'direct', authoritative: true, requiresIndependentAuthentication: true, baseUrl: peer.url,
      streamUrl: `${peer.wsUrl}/api/sessions/pi/${peerSessionId}/stream`,
    });
    expect(fakes.seen.find((request) => request.peer === 'fake-a')?.contractRevision).toBe(String(BROKER_CONTRACT_REVISION));

    expect(one(body, 'fake-a')).toMatchObject({ status: 'degraded', code: 'MACHINE_PEER_PARTIAL', invalidSessionCount: 1, sessionCount: 2 });
    expect(one(body, 'slow')).toMatchObject({ status: 'ok' });
    expect(one(body, 'down')).toMatchObject({ status: 'degraded', code: 'MACHINE_PEER_UNREACHABLE', sessions: [] });
    const stale = one(body, 'stale');
    expect(stale).toMatchObject({ status: 'degraded', code: 'MACHINE_PEER_STALE', freshness: 'stale' });
    expect(stale.sessions[0].owner.route).toBe('stale');
    // A peer too old to date its roster is not punished for it.
    expect(one(body, 'legacy')).toMatchObject({ status: 'ok', freshness: 'unknown' });
    const partial = one(body, 'partial');
    expect(partial).toMatchObject({ status: 'degraded', code: 'MACHINE_PEER_PARTIAL', sessionCount: 1 });
    expect(partial.error).toMatch(/incomplete/);
    const garbled = one(body, 'garbled');
    expect(garbled).toMatchObject({ status: 'degraded', code: 'MACHINE_PEER_PARTIAL' });
    expect(garbled.error).toMatch(/malformed/);
    expect(one(body, 'twice')).toMatchObject({ status: 'degraded', code: 'MACHINE_PEER_DUPLICATE_SESSION' });
    expect(one(body, 'dup')).toMatchObject({ status: 'ok' });
    for (const twin of byId(body, 'twin')) expect(twin).toMatchObject({ status: 'degraded', code: 'MACHINE_PEER_DUPLICATE_MACHINE' });
    expect(byId(body, 'twin')).toHaveLength(2);
    expect(one(body, 'upgrade-bare')).toMatchObject({ status: 'ok' });
  });

  test('a client is sent only the agents it can decode, from every machine', async () => {
    const sessionIds = (body: any): string[] =>
      body.machines.flatMap((machine: any) => machine.sessions.map((session: any) => session.id));
    const current = sessionIds((await machines()).body);
    expect(current).toEqual(expect.arrayContaining(['fake-a-kimi', 'fake-a-session', peerSessionId, localSessionId]));
    for (const query of ['?contractRevision=13', '']) {
      const older = sessionIds((await machines(query)).body);
      expect(older).not.toContain('fake-a-kimi');
      expect(older).toEqual(expect.arrayContaining(['fake-a-session', peerSessionId, localSessionId]));
    }
  });

  test('a peer that stops answering times out, and its sessions cannot be routed', async () => {
    fakes.slowWedged = true;
    try {
      const body = (await machines()).body;
      expect(one(body, 'slow')).toMatchObject({ status: 'degraded', code: 'MACHINE_PEER_TIMEOUT', sessions: [] });
      const routed = await resolve('slow', 'opencode', 'slow-session');
      expect(routed.status).toBe(503);
      expect(routed.body.code).toBe('MACHINE_OWNER_UNREACHABLE');
    } finally {
      fakes.slowWedged = false;
    }
    expect(one((await machines()).body, 'slow')).toMatchObject({ status: 'ok' });
  });

  test('a peer that starts requiring authentication says so, and a peer credential recovers it', async () => {
    fakes.upgradeRevision = 16;
    const body = (await machines()).body;
    const bare = one(body, 'upgrade-bare');
    expect(bare).toMatchObject({ status: 'degraded', code: 'MACHINE_PEER_BAD_CONFIG' });
    expect(bare.error).toMatch(/authentication required.*credential/);
    expect(one(body, 'upgrade-credentialed')).toMatchObject({ status: 'ok' });
    expect(fakes.seen.some((request) => request.peer === 'upgrade' && request.peerToken === UPGRADE_PEER_TOKEN)).toBe(true);
  });

  test('resolve routes by composite identity and never denies what a partial owner did not look for', async () => {
    const remote = await resolve('peer-real', 'pi', peerSessionId);
    expect(remote.status).toBe(200);
    expect(remote.body).toMatchObject({
      ok: true, status: 'resolved',
      identity: { machineId: 'peer-real', tool: 'pi', sessionId: peerSessionId },
      owner: { baseUrl: peer.url, route: 'direct' },
    });

    const mine = await resolve('local-machine', 'pi', localSessionId);
    expect(mine.status).toBe(200);
    expect(mine.body.owner.route).toBe('local');

    // The same session id on two machines is two sessions.
    const elsewhere = await resolve('dup', 'pi', localSessionId);
    expect(elsewhere.status).toBe(200);
    expect(elsewhere.body.identity.key).not.toBe(mine.body.identity.key);

    // Routing uses the configured machine id, never a peer's display name.
    const display = await resolve('peer-display', 'pi', peerSessionId);
    expect([display.status, display.body.code]).toEqual([404, 'MACHINE_ROUTE_NOT_FOUND']);

    const twice = await resolve('twice', 'opencode', 'twice-session');
    expect([twice.status, twice.body.code]).toEqual([409, 'MACHINE_ROUTE_AMBIGUOUS']);
    const twin = await resolve('twin', 'opencode', 'twin-session');
    expect([twin.status, twin.body.code]).toEqual([409, 'MACHINE_ROUTE_AMBIGUOUS']);

    const down = await resolve('down', 'opencode', 'anything');
    expect([down.status, down.body.code]).toEqual([503, 'MACHINE_OWNER_UNREACHABLE']);
    const stale = await resolve('stale', 'pi', 'stale-session');
    expect([stale.status, stale.body.code]).toEqual([503, 'MACHINE_ROUTE_STALE']);

    // An incomplete roster confirms what it carries and denies nothing.
    expect((await resolve('partial', 'opencode', 'partial-session')).body.status).toBe('resolved');
    const unread = await resolve('partial', 'codex', 'not-listed');
    expect([unread.status, unread.body.code]).toEqual([503, 'MACHINE_ROUTE_STALE']);
    // A whole roster's absence is a real "not found".
    const absent = await resolve('dup', 'codex', 'not-listed');
    expect([absent.status, absent.body.code]).toEqual([404, 'MACHINE_ROUTE_NOT_FOUND']);

    expect((await owner.get('/api/machines/resolve?machineId=peer-real&tool=pi')).status).toBe(400);
  });

  test("a peer session's stream URL reaches the session on the peer, with the peer's own credential", async () => {
    const remote = await resolve('peer-real', 'pi', peerSessionId);
    expect(remote.body.owner.streamUrl).toStartWith(peer.wsUrl);
    const stream = await peer.client().attach('pi', peerSessionId);
    expect((await stream.waitForKind('history')).kind).toBe('history');
    stream.close();
  });
});
