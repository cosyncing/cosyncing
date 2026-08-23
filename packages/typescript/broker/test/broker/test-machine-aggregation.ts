#!/usr/bin/env bun
/**
 * W9 multi-machine aggregator foundation.
 * Proves /api/machines is token-gated, merges local + peer rosters, redacts peer tokens,
 * and classifies slow/unreachable peers without adding remote control.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BROKER_CONTRACT_REVISION } from '@cosyncing/protocol';
import {
  aggregatedMachines,
  fetchPeerMachineRoster,
  localMachineRoster,
  parseMachinePeers,
  resolveMachineSession,
} from '../../src/roster/machine-aggregation.ts';

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name} - ${err instanceof Error ? err.message : String(err)}`);
    failures++;
  }
}

let failures = 0;

await test('machine peer reports revision-16 authentication migration and recovers with a revocable credential', async () => {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let revision = 15;
  let sawPeerCredential = false;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch(req) {
      if (new URL(req.url).pathname !== '/api/sessions') return new Response('not found', { status: 404 });
      sawPeerCredential = req.headers.get('x-cosyncing-peer-token') === 'revocable-peer-token';
      if (revision >= 16 && !sawPeerCredential) return new Response('unauthorized', { status: 401 });
      return Response.json({ machine: 'peer-upgrade', generatedAt: Date.now(), sessions: [] });
    },
  });
  try {
    const tokenless = parseMachinePeers(JSON.stringify([{ id: 'peer-upgrade', url: baseUrl }]))[0]!;
    assert.equal((await fetchPeerMachineRoster(tokenless)).status, 'ok');
    revision = 16;
    const protectedRoster = await fetchPeerMachineRoster(tokenless);
    assert.equal(protectedRoster.code, 'MACHINE_PEER_BAD_CONFIG');
    assert.match(protectedRoster.error ?? '', /authentication required.*credential/);
    const credentialed = parseMachinePeers(JSON.stringify([{
      id: 'peer-upgrade',
      url: baseUrl,
      credential: { kind: 'peer-token', value: 'revocable-peer-token' },
    }]))[0]!;
    assert.equal((await fetchPeerMachineRoster(credentialed)).status, 'ok');
    assert.equal(sawPeerCredential, true);
  } finally {
    server.stop(true);
  }
});

await test('composite identity makes cross-machine duplicates valid and same-owner duplicates ambiguous', () => {
  const session = { id: 'same', tool: 'opencode', title: 'same', status: 'idle', attachMode: 'observe' } as const;
  const first = localMachineRoster('machine-a', [session], 'http://machine-a.test', 1000);
  const second = localMachineRoster('machine-b', [session], 'http://machine-b.test', 1000);
  const aggregate = aggregatedMachines('machine-a', [first, second], 1000);
  const routed = resolveMachineSession(aggregate, { machineId: 'machine-b', tool: 'opencode', sessionId: 'same' });
  assert.equal(routed.status, 'resolved');
  assert.notEqual(first.sessions[0]!.identity.key, second.sessions[0]!.identity.key);

  const duplicateSession = localMachineRoster('machine-c', [session, session], 'http://machine-c.test', 1000);
  assert.equal(duplicateSession.code, 'MACHINE_PEER_DUPLICATE_SESSION');
  assert.equal(resolveMachineSession(aggregatedMachines('machine-a', [duplicateSession]), {
    machineId: 'machine-c', tool: 'opencode', sessionId: 'same',
  }).code, 'MACHINE_ROUTE_AMBIGUOUS');

  const duplicateMachine = aggregatedMachines('machine-a', [
    localMachineRoster('machine-d', [session], 'http://owner-1.test', 1000),
    localMachineRoster('machine-d', [session], 'http://owner-2.test', 1000),
  ]);
  assert.equal(resolveMachineSession(duplicateMachine, {
    machineId: 'machine-d', tool: 'opencode', sessionId: 'same',
  }).code, 'MACHINE_ROUTE_AMBIGUOUS');

  const stale = localMachineRoster('machine-stale', [session], 'http://stale.test', 1000);
  stale.role = 'peer';
  stale.status = 'degraded';
  stale.freshness = 'stale';
  stale.code = 'MACHINE_PEER_STALE';
  stale.sessions[0]!.owner = { ...stale.sessions[0]!.owner, role: 'peer', route: 'stale', authoritative: false };
  assert.equal(resolveMachineSession(aggregatedMachines('machine-a', [stale]), {
    machineId: 'machine-stale', tool: 'opencode', sessionId: 'same',
  }).code, 'MACHINE_ROUTE_STALE');
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('could not allocate port');
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return addr.port;
}

async function waitHealthy(base: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      /* wait */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('broker did not become healthy');
}

await test('multi-machine roster is token-gated, merged, timeout-bounded, and token-redacted', async () => {
  const token = `w9-broker-${Date.now()}`;
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-machine-aggregation-'));
  const peerToken = `peer-token-${Date.now()}`;
  const brokerPort = await freePort();
  const peerPort = await freePort();
  const slowPeerPort = await freePort();
  const downPeerPort = await freePort();
  const stalePeerPort = await freePort();
  const legacyPeerPort = await freePort();

  let sawPeerToken = false;
  // What revision this broker declared when it asked its peer. A peer filters
  // its roster to what the CALLER can decode, so a broker that asks bare is read
  // as the oldest possible client and is served no Kimi or dsh sessions at all.
  let sawPeerRevision: string | null = null;
  const healthyPeer = Bun.serve({
    hostname: '127.0.0.1',
    port: peerPort,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== '/api/sessions') return Response.json({ error: 'not found' }, { status: 404 });
      sawPeerToken = req.headers.get('x-cosyncing-token') === peerToken;
      sawPeerRevision = url.searchParams.get('contractRevision');
      if (!sawPeerToken) return Response.json({ error: 'unauthorized' }, { status: 401 });
      return Response.json({
        machine: 'peer-a',
        generatedAt: Date.now(),
        sessions: [
          {
            id: 'peer-session',
            tool: 'opencode',
            title: 'Peer session',
            status: 'idle',
            attachMode: 'observe',
          },
          // An agent with a declared minimum client revision. It must reach a
          // current client and must NOT reach one that cannot decode its row.
          {
            id: 'peer-kimi-session',
            tool: 'kimi',
            title: 'Peer kimi session',
            status: 'idle',
            attachMode: 'observe',
          },
          { malformed: true },
        ],
      });
    },
  });
  const slowPeer = Bun.serve({
    hostname: '127.0.0.1',
    port: slowPeerPort,
    async fetch() {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return Response.json({ machine: 'slow-peer', sessions: [] });
    },
  });
  const stalePeer = Bun.serve({
    hostname: '127.0.0.1',
    port: stalePeerPort,
    fetch() {
      return Response.json({
        machine: 'stale-display',
        generatedAt: 1,
        sessions: [{ id: 'stale-session', tool: 'pi', title: 'Stale', status: 'idle', attachMode: 'observe' }],
      });
    },
  });
  const legacyPeer = Bun.serve({
    hostname: '127.0.0.1',
    port: legacyPeerPort,
    fetch() {
      return Response.json({ machine: 'legacy-display', sessions: [], futureAdditiveField: { ignored: true } });
    },
  });

  const peers = [
    { id: 'peer-a-config', url: `http://127.0.0.1:${peerPort}?token=must-not-leak`, token: peerToken },
    { id: 'slow-peer-config', url: `http://127.0.0.1:${slowPeerPort}` },
    { id: 'down-peer-config', url: `http://127.0.0.1:${downPeerPort}` },
    { id: 'stale-peer-config', url: `http://127.0.0.1:${stalePeerPort}` },
    { id: 'legacy-peer-config', url: `http://127.0.0.1:${legacyPeerPort}` },
  ];
  const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(brokerPort),
      HOST: '127.0.0.1',
      COSYNCING_TOKEN: token,
      COSYNCING_TOKEN_FILE: '',
      COSYNCING_PI_INTEGRATION_FILE: '',
      COSYNCING_HOME: home,
      COSYNCING_MACHINE: 'local-machine',
      COSYNCING_MACHINE_PEERS: JSON.stringify(peers),
      COSYNCING_MACHINE_PEER_TIMEOUT_MS: '150',
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });

  try {
    const base = `http://127.0.0.1:${brokerPort}`;
    await waitHealthy(base);

    const unauth = await fetch(`${base}/api/machines`);
    assert.equal(unauth.status, 401);

    const res = await fetch(`${base}/api/machines`, { headers: { 'x-cosyncing-token': token } });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text.includes(peerToken), false);
    assert.equal(text.includes('must-not-leak'), false);

    const body = JSON.parse(text) as any;
    assert.equal(body.ok, true);
    assert.equal(body.machine, 'local-machine');
    assert.equal(Array.isArray(body.machines), true);
    assert.equal(sawPeerToken, true);
    // The broker asks its peer as the client it actually is.
    assert.equal(sawPeerRevision, String(BROKER_CONTRACT_REVISION));

    // ── the aggregate is projected for the client that asked for it ─────────
    //
    // A machine roster carries this machine's sessions AND every peer's, so a
    // client that cannot decode an agent must not receive its sessions through
    // this route either. Asked as a current client, the peer's Kimi session
    // arrives; asked as an older one — or as one that declares nothing — it does
    // not, while every other session still does.
    const machinesAt = async (query: string): Promise<string[]> => {
      const response = await fetch(`${base}/api/machines${query}`, {
        headers: { 'x-cosyncing-token': token },
      });
      assert.equal(response.status, 200);
      const parsed = JSON.parse(await response.text()) as any;
      return parsed.machines.flatMap((entry: any) => (entry.sessions ?? []).map((session: any) => session.id));
    };
    const currentClient = await machinesAt(`?contractRevision=${BROKER_CONTRACT_REVISION}`);
    const legacyClient = await machinesAt('?contractRevision=13');
    const undeclaredClient = await machinesAt('');
    assert.equal(currentClient.includes('peer-kimi-session'), true);
    assert.equal(legacyClient.includes('peer-kimi-session'), false);
    assert.equal(undeclaredClient.includes('peer-kimi-session'), false);
    // ...and hiding one agent never costs a client the others.
    assert.equal(legacyClient.includes('peer-session'), true);
    assert.equal(undeclaredClient.includes('peer-session'), true);

    const local = body.machines.find((m: any) => m.machine === 'local-machine');
    assert.equal(local.role, 'local');
    assert.equal(local.status, 'ok');

    const peer = body.machines.find((m: any) => m.machine === 'peer-a');
    assert.equal(peer.role, 'peer');
    assert.equal(peer.status, 'degraded');
    assert.equal(peer.code, 'MACHINE_PEER_PARTIAL');
    assert.equal(peer.invalidSessionCount, 1);
    assert.equal(peer.sessionCount, 1);
    assert.equal(peer.sessions[0].machine, 'peer-a');
    assert.equal(peer.machineId, 'peer-a-config');
    assert.equal(peer.sessions[0].identity.machineId, 'peer-a-config');
    assert.equal(peer.sessions[0].owner.route, 'direct');
    assert.equal(peer.sessions[0].owner.authoritative, true);
    assert.equal(peer.sessions[0].owner.requiresIndependentAuthentication, true);
    assert.equal(peer.sessions[0].owner.streamUrl, `ws://127.0.0.1:${peerPort}/api/sessions/opencode/peer-session/stream`);
    assert.equal(peer.baseUrl, `http://127.0.0.1:${peerPort}`);

    const slow = body.machines.find((m: any) => m.machine === 'slow-peer-config');
    assert.equal(slow.status, 'degraded');
    assert.equal(slow.code, 'MACHINE_PEER_TIMEOUT');

    const down = body.machines.find((m: any) => m.machine === 'down-peer-config');
    assert.equal(down.status, 'degraded');
    assert.equal(down.code, 'MACHINE_PEER_UNREACHABLE');

    const stale = body.machines.find((m: any) => m.machineId === 'stale-peer-config');
    assert.equal(stale.status, 'degraded');
    assert.equal(stale.code, 'MACHINE_PEER_STALE');
    assert.equal(stale.freshness, 'stale');
    assert.equal(stale.sessions[0].owner.route, 'stale');

    const legacy = body.machines.find((m: any) => m.machineId === 'legacy-peer-config');
    assert.equal(legacy.status, 'ok');
    assert.equal(legacy.freshness, 'unknown', 'older peer without generatedAt remains backward compatible');

    const unauthResolve = await fetch(`${base}/api/machines/resolve?machineId=peer-a-config&tool=opencode&sessionId=peer-session`);
    assert.equal(unauthResolve.status, 401);

    const resolvePeer = await fetch(`${base}/api/machines/resolve?machineId=peer-a-config&tool=opencode&sessionId=peer-session`, {
      headers: { 'x-cosyncing-token': token },
    });
    assert.equal(resolvePeer.status, 200);
    const resolvedPeer = await resolvePeer.json() as any;
    assert.equal(resolvedPeer.status, 'resolved');
    assert.equal(resolvedPeer.identity.key, peer.sessions[0].identity.key);
    assert.equal(resolvedPeer.owner.baseUrl, `http://127.0.0.1:${peerPort}`);

    const wrongDisplayId = await fetch(`${base}/api/machines/resolve?machineId=peer-a&tool=opencode&sessionId=peer-session`, {
      headers: { 'x-cosyncing-token': token },
    });
    assert.equal(wrongDisplayId.status, 404, 'routing must use configured machineId, not display machine name');
    assert.equal((await wrongDisplayId.json() as any).code, 'MACHINE_ROUTE_NOT_FOUND');

    const unreachableOwner = await fetch(`${base}/api/machines/resolve?machineId=down-peer-config&tool=opencode&sessionId=peer-session`, {
      headers: { 'x-cosyncing-token': token },
    });
    assert.equal(unreachableOwner.status, 503);
    assert.equal((await unreachableOwner.json() as any).code, 'MACHINE_OWNER_UNREACHABLE');

    const staleOwner = await fetch(`${base}/api/machines/resolve?machineId=stale-peer-config&tool=pi&sessionId=stale-session`, {
      headers: { 'x-cosyncing-token': token },
    });
    assert.equal(staleOwner.status, 503);
    assert.equal((await staleOwner.json() as any).code, 'MACHINE_ROUTE_STALE');
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
    healthyPeer.stop(true);
    slowPeer.stop(true);
    stalePeer.stop(true);
    legacyPeer.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
});

if (failures) {
  console.error(`\nFAIL: ${failures} test(s) failed`);
  process.exit(1);
}

console.log('\nPASS: machine aggregation tests passed');
