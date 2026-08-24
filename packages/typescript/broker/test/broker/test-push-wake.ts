#!/usr/bin/env bun
/**
 * W7 push wake-token broker tests.
 *
 * Uses a local webhook as the provider stub; no APNs/FCM credentials or network required.
 */
import { strict as assert } from 'node:assert';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dispatchWakePush,
  WAKE_REGISTRATION_PEER_MAX,
  WakePushError,
  WakePushRegistry,
} from '../../src/transport/push-wake.ts';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('could not allocate test port');
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return (addr as any).port;
}

async function waitHealthy(base: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      /* keep waiting */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('broker did not become healthy');
}

async function run(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name} - ${err instanceof Error ? err.message : String(err)}`);
    failures++;
  }
}

let failures = 0;
const TOKEN = 'w7-push-token';

await run('legacy ownerless wake registrations are dropped before dispatch', () => {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-w7-push-legacy-'));
  const path = join(home, 'push-wake-tokens.json');
  try {
    writeFileSync(path, JSON.stringify({
      version: 1,
      registrations: [{
        deviceId: 'attacker-phone',
        platform: 'fcm',
        token: 'legacy-attacker-token',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }],
    }), { mode: 0o600 });
    const registry = new WakePushRegistry(home);
    assert.deepEqual(registry.list({ kind: 'owner' }), []);
    assert.deepEqual(registry.listForDispatch(), []);
    assert.throws(() => registry.getForDispatch('attacker-phone'), /not found/i);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 2, registrations: [] });
    const replacement = registry.register({ deviceId: 'owner-phone', platform: 'fcm', token: 'new-token' }, { kind: 'owner' });
    assert.equal(replacement.deviceId, 'owner-phone');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

await run('peer wake registrations require stable ids, are bounded, idempotent, and generation-checked', () => {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-w7-push-bounds-'));
  let active = true;
  let now = Date.parse('2026-08-24T00:00:00Z');
  try {
    const registry = new WakePushRegistry(home, {
      now: () => now,
      isPeerGenerationActive: (peerId, generation) => active && peerId === 'peer-a' && generation === 7,
    });
    const peer = { kind: 'peer' as const, peerId: 'peer-a', authGeneration: 7 };
    assert.throws(
      () => registry.register({ platform: 'fcm', token: 'missing-id' }, peer),
      (error) => error instanceof WakePushError && error.status === 400,
    );
    const first = registry.register({ deviceId: 'phone-0', platform: 'fcm', token: 'token-0' }, peer);
    const path = join(home, 'push-wake-tokens.json');
    const beforeIdempotent = readFileSync(path, 'utf8');
    now += 1_000;
    const repeated = registry.register({ deviceId: 'phone-0', platform: 'fcm', token: 'token-0' }, peer);
    assert.deepEqual(repeated, first);
    assert.equal(readFileSync(path, 'utf8'), beforeIdempotent, 'an unchanged registration does not rewrite durable state');
    for (let i = 1; i < WAKE_REGISTRATION_PEER_MAX; i++) {
      registry.register({ deviceId: `phone-${i}`, platform: 'fcm', token: `token-${i}` }, peer);
    }
    assert.throws(
      () => registry.register({ deviceId: 'phone-over-limit', platform: 'fcm', token: 'extra' }, peer),
      (error) => error instanceof WakePushError && error.status === 429,
    );
    assert.equal(registry.listForDispatch().length, WAKE_REGISTRATION_PEER_MAX);
    active = false;
    assert.deepEqual(registry.listForDispatch(), [], 'inactive peer generations are never dispatched');
    assert.throws(() => registry.getForDispatch(first.deviceId), /not found/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

await run('wake registration global and write-rate limits return 429 without eviction', () => {
  const globalHome = mkdtempSync(join(tmpdir(), 'cosyncing-w7-push-global-limit-'));
  const rateHome = mkdtempSync(join(tmpdir(), 'cosyncing-w7-push-rate-limit-'));
  try {
    const globalRegistry = new WakePushRegistry(globalHome, { globalMax: 2 });
    globalRegistry.register({ deviceId: 'owner-a', platform: 'fcm', token: 'a' }, { kind: 'owner' });
    globalRegistry.register({ deviceId: 'owner-b', platform: 'fcm', token: 'b' }, { kind: 'owner' });
    assert.throws(
      () => globalRegistry.register({ deviceId: 'owner-c', platform: 'fcm', token: 'c' }, { kind: 'owner' }),
      (error) => error instanceof WakePushError && error.status === 429,
    );
    assert.equal(globalRegistry.list({ kind: 'owner' }).length, 2);

    const peer = { kind: 'peer' as const, peerId: 'peer-rate', authGeneration: 1 };
    const rateRegistry = new WakePushRegistry(rateHome, { mutationsPerMinute: 2 });
    rateRegistry.register({ deviceId: 'phone', platform: 'fcm', token: 'one' }, peer);
    rateRegistry.register({ deviceId: 'phone', platform: 'fcm', token: 'two' }, peer);
    assert.throws(
      () => rateRegistry.register({ deviceId: 'phone', platform: 'fcm', token: 'three' }, peer),
      (error) => error instanceof WakePushError && error.status === 429,
    );
    assert.match(readFileSync(join(rateHome, 'push-wake-tokens.json'), 'utf8'), /"token": "two"/);
  } finally {
    rmSync(globalHome, { recursive: true, force: true });
    rmSync(rateHome, { recursive: true, force: true });
  }
});

await run('wake registrations are principal-scoped and peer revocation removes only that peer', () => {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-w7-push-registry-'));
  try {
    const registry = new WakePushRegistry(home);
    const peerA = { kind: 'peer' as const, peerId: 'peer-a', authGeneration: 1 };
    const peerB = { kind: 'peer' as const, peerId: 'peer-b', authGeneration: 1 };
    const a = registry.register({ deviceId: 'phone', platform: 'apns', token: 'token-a' }, peerA);
    const b = registry.register({ deviceId: 'phone', platform: 'fcm', token: 'token-b' }, peerB);
    assert.notEqual(a.deviceId, b.deviceId, 'caller device ids must be namespaced under the principal');
    assert.deepEqual(registry.list(peerA).map((entry) => entry.deviceId), [a.deviceId]);
    assert.deepEqual(registry.list(peerB).map((entry) => entry.deviceId), [b.deviceId]);
    assert.throws(() => registry.get(b.deviceId, peerA), /not found/i);
    assert.equal(registry.revoke(b.deviceId, peerA), false);
    assert.equal(registry.list({ kind: 'owner' }).length, 2);
    assert.equal(registry.revokePeer('peer-a'), 1);
    assert.deepEqual(registry.list({ kind: 'owner' }).map((entry) => entry.deviceId), [b.deviceId]);

    const reloaded = new WakePushRegistry(home);
    assert.deepEqual(reloaded.list(peerA), []);
    assert.deepEqual(reloaded.list(peerB).map((entry) => entry.deviceId), [b.deviceId]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

await run('wake push webhook dispatch times out instead of hanging indefinitely', async () => {
  const webhookPort = await freePort();
  const webhook = Bun.serve({
    hostname: '127.0.0.1',
    port: webhookPort,
    async fetch() {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return Response.json({ ok: true });
    },
  });
  const previous = process.env.COSYNCING_WAKE_PUSH_WEBHOOK;
  process.env.COSYNCING_WAKE_PUSH_WEBHOOK = `http://127.0.0.1:${webhookPort}/wake`;
  try {
    await assert.rejects(
      () => dispatchWakePush({
        deviceId: 'phone-timeout',
        owner: { kind: 'owner' },
        platform: 'apns',
        token: 'timeout-token',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, { reason: 'timeout-test', timeoutMs: 50 }),
      /timed out|PUSH_DELIVERY_FAILED/i,
    );
  } finally {
    if (previous == null) delete process.env.COSYNCING_WAKE_PUSH_WEBHOOK;
    else process.env.COSYNCING_WAKE_PUSH_WEBHOOK = previous;
    webhook.stop(true);
  }
});

await run('direct wake dispatch drops every caller-controlled reason', async () => {
  let captured: Record<string, unknown> | undefined;
  const previous = process.env.COSYNCING_WAKE_PUSH_WEBHOOK;
  process.env.COSYNCING_WAKE_PUSH_WEBHOOK = 'http://127.0.0.1:1/wake';
  try {
    await dispatchWakePush({
      deviceId: 'phone-private',
      owner: { kind: 'owner' },
      platform: 'fcm',
      token: 'private-token',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, {
      reason: 'permission-required:session-secret',
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        captured = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });
    assert.deepEqual(captured, { platform: 'fcm', token: 'private-token', type: 'wake' });
    assert.equal(Object.hasOwn(captured ?? {}, 'reason'), false);
  } finally {
    if (previous == null) delete process.env.COSYNCING_WAKE_PUSH_WEBHOOK;
    else process.env.COSYNCING_WAKE_PUSH_WEBHOOK = previous;
  }
});

await run('wake-token registration is token-gated, redacted in list, and dispatches no payload', async () => {
  const webhookBodies: any[] = [];
  const webhookPort = await freePort();
  const webhook = Bun.serve({
    hostname: '127.0.0.1',
    port: webhookPort,
    fetch: async (req) => {
      webhookBodies.push(await req.json().catch(() => ({})));
      return Response.json({ ok: true });
    },
  });

  const home = mkdtempSync(join(tmpdir(), 'cosyncing-w7-push-home-'));
  const brokerPort = await freePort();
  const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(brokerPort),
      HOST: '127.0.0.1',
      COSYNCING_TOKEN: TOKEN,
      COSYNCING_TOKEN_FILE: '',
      COSYNCING_HOME: home,
      COSYNCING_PI_INTEGRATION_FILE: '',
      COSYNCING_WAKE_PUSH_WEBHOOK: `http://127.0.0.1:${webhookPort}/wake`,
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const base = `http://127.0.0.1:${brokerPort}`;

  try {
    await waitHealthy(base);

    const unauthList = await fetch(`${base}/api/push/wake-tokens`);
    assert.equal(unauthList.status, 401);
    const unauthPost = await fetch(`${base}/api/push/wake-tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'phone-1', platform: 'apns', token: 'raw-secret-token-123456' }),
    });
    assert.equal(unauthPost.status, 401);

    const register = await fetch(`${base}/api/push/wake-tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cosyncing-token': TOKEN },
      body: JSON.stringify({ deviceId: 'phone-1', platform: 'apns', token: 'raw-secret-token-123456', label: 'Test phone' }),
    });
    assert.equal(register.status, 201);
    const registered = await register.json();
    assert.equal(registered.ok, true);
    assert.equal(registered.registration.deviceId, 'phone-1');
    assert.equal(registered.registration.platform, 'apns');
    assert.equal(JSON.stringify(registered).includes('raw-secret-token-123456'), false);

    const listed = await (await fetch(`${base}/api/push/wake-tokens`, { headers: { 'x-cosyncing-token': TOKEN } })).json();
    assert.equal(listed.registrations.length, 1);
    assert.equal(JSON.stringify(listed).includes('raw-secret-token-123456'), false);
    assert.match(listed.registrations[0].tokenPreview, /^raw-se/);

    const wake = await fetch(`${base}/api/push/wake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cosyncing-token': TOKEN },
      body: JSON.stringify({
        deviceId: 'phone-1',
        reason: 'needs-input',
        sessionId: 'must-not-forward',
        prompt: 'must-not-forward',
      }),
    });
    assert.equal(wake.status, 202);
    assert.equal(webhookBodies.length, 1);
    assert.deepEqual(Object.keys(webhookBodies[0]).sort(), ['platform', 'token', 'type'].sort());
    assert.equal(webhookBodies[0].platform, 'apns');
    assert.equal(webhookBodies[0].token, 'raw-secret-token-123456');
    assert.equal(webhookBodies[0].type, 'wake');
    assert.equal(Object.hasOwn(webhookBodies[0], 'reason'), false);
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
    webhook.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
});

if (failures) {
  console.error(`\nFAIL: ${failures} push wake test(s) failed`);
  process.exit(1);
}
console.log('\nPASS: push wake tests passed');
