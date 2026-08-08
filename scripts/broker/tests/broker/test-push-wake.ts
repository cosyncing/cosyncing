#!/usr/bin/env bun
/**
 * W7 push wake-token broker tests.
 *
 * Uses a local webhook as the provider stub; no APNs/FCM credentials or network required.
 */
import { strict as assert } from 'node:assert';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchWakePush } from '../../../../packages/typescript/broker/src/push-wake.ts';

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
      COSYNCING_HOME: home,
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
