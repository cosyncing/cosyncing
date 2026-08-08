#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttentionStore } from '../../../../packages/typescript/broker/src/attention-store.ts';
import { ATTENTION_BULK_DISMISS_MAX } from '../../../../packages/typescript/protocol/src/index.ts';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', () => resolve()).once('error', reject));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('no port');
  return address.port;
}

async function waitHealthy(base: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* retry */ }
    await Bun.sleep(100);
  }
  throw new Error('broker did not start');
}

const token = 'attention-test-token';
const auth = { 'x-cosyncing-token': token };
const home = mkdtempSync(join(tmpdir(), 'cosyncing-attention-broker-home-'));
const cache = mkdtempSync(join(tmpdir(), 'cosyncing-attention-broker-cache-'));
const seeded = new AttentionStore({ home, idFactory: () => 'seed-event' });
const seed = await seeded.upsertEvent({
  dedupeKey: 'seed:permission', kind: 'permission-required', state: 'active',
  severity: 'action-required', title: 'Permission required',
  sessionTitle: 'Review session',
  action: { kind: 'open-session', tool: 'codex', sessionId: 's1' },
  presentationRevision: 1, presentationStage: 'immediate',
});

const quotaServer = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch(req) {
    assert.equal(req.method, 'GET');
    assert.equal(new URL(req.url).pathname, '/api/quota');
    return Response.json({
      enabled: true, timestamp: 1,
      providers: {
        codex: {
          provider: 'codex', network_enabled: false, status: 'ok', status_detail: null,
          status_at: 1, updated_at: 1, sources: ['codex_session'], estimated: true,
          buckets: [{
            account: 'local', bucket: '5h', bucket_label: '5 hour', used_percent: 80,
            remaining_percent: 20, resets_at: 123, captured_at: 1, source: 'codex_session', status: 'ok',
          }],
        },
      },
    });
  },
});
const port = await freePort();
const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
  env: {
    ...process.env,
    PORT: String(port), HOST: '127.0.0.1', COSYNCING_TOKEN: token,
    COSYNCING_HOME: home, COSYNCING_CACHE_DIR: cache,
    COSYNCING_TOKDASH_URL: `http://127.0.0.1:${quotaServer.port}`,
    COSYNCING_OPENCODE_NO_AUTOSERVE: '1', COSYNCING_RUNTIME_UPDATE_POLL_MS: '3600000',
  },
  stdout: 'ignore', stderr: 'pipe',
});
const base = `http://127.0.0.1:${port}`;

try {
  await waitHealthy(base);
  for (const path of [
    '/api/attention-events?clientId=phone',
    '/api/broker/health',
    '/api/tokdash/quota',
    '/api/tokdash/quota-preference',
  ]) assert.equal((await fetch(base + path)).status, 401, `${path} must be authenticated`);
  assert.equal((await fetch(`${base}/api/attention-events/dismiss-batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'phone', events: [] }),
  })).status, 401, 'bulk dismissal must be authenticated');

  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.ok, true);
  assert.match(health.healthStatus, /^(healthy|degraded|critical)$/);
  const detail = await (await fetch(`${base}/api/broker/health`, { headers: auth })).json();
  assert.equal(detail.ok, true);
  assert.equal(JSON.stringify(detail).includes(home), false, 'health details must not expose state paths');
  assert.equal(JSON.stringify(detail).includes(cache), false, 'health details must not expose cache paths');

  const page = await (await fetch(`${base}/api/attention-events?after=0&clientId=phone`, { headers: auth })).json();
  assert.equal(page.events[0].id, seed.event.id);
  assert.equal(page.events[0].sessionTitle, 'Review session');
  assert.equal(page.baselineThroughCursor, page.cursor, 'new clients should receive the current feed head as baseline');
  const cursor = page.cursor;
  const waiting = fetch(`${base}/api/attention-events?after=${cursor}&waitMs=5000&clientId=phone`, { headers: auth });
  await Bun.sleep(30);
  const ack = await fetch(`${base}/api/attention-events/${seed.event.id}/ack`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ clientId: 'phone' }),
  });
  assert.equal(ack.status, 200);
  const changed = await (await waiting).json();
  assert.equal(changed.events[0].id, seed.event.id, 'client-state mutation wakes the long poll');
  assert.ok(changed.events[0].readAt);

  const bulk = await fetch(`${base}/api/attention-events/dismiss-batch`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      clientId: 'phone',
      events: [{ eventId: seed.event.id, revision: seed.event.revision }],
    }),
  });
  assert.equal(bulk.status, 200);
  const bulkBody = await bulk.json() as any;
  assert.equal(bulkBody.accepted[0].eventId, seed.event.id);
  const afterBulk = await (await fetch(
    `${base}/api/attention-events?after=${changed.cursor}&clientId=phone`,
    { headers: auth },
  )).json() as any;
  assert.ok(afterBulk.events[0].dismissedAt,
    'the route publishes one durable client-state mutation');

  const oversized = await fetch(`${base}/api/attention-events/dismiss-batch`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      clientId: 'phone',
      events: Array.from(
        { length: ATTENTION_BULK_DISMISS_MAX + 1 },
        (_, index) => ({ eventId: `oversized-${index}`, revision: 1 }),
      ),
    }),
  });
  assert.equal(oversized.status, 400, 'the HTTP surface enforces the hard request bound');

  const preference = await (await fetch(`${base}/api/tokdash/quota-preference`, { headers: auth })).json();
  assert.equal(preference.enabled, false);
  const enabled = await fetch(`${base}/api/tokdash/quota-preference`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }),
  });
  assert.equal(enabled.status, 200);
  const quota = await (await fetch(`${base}/api/tokdash/quota`, { headers: auth })).json();
  assert.equal(quota.ok, true);
  assert.equal(quota.data.providers.codex.buckets[0].remaining_percent, 20);
  const afterQuota = await (await fetch(`${base}/api/attention-events?after=${changed.cursor}&clientId=phone`, { headers: auth })).json();
  assert.ok(afterQuota.events.some((event: any) => event.kind === 'usage-threshold'));
  assert.equal(afterQuota.baselineThroughCursor, afterQuota.cursor, 'continuation pages should return an updated baseline for downstream clients');

  const badClient = await fetch(`${base}/api/attention-events?clientId=bad%20id`, { headers: auth });
  assert.equal(badClient.status, 400);
  console.log('PASS: broker attention/auth/long-poll/health/quota contract');
} finally {
  broker.kill();
  await broker.exited.catch(() => undefined);
  quotaServer.stop(true);
  rmSync(home, { recursive: true, force: true });
  rmSync(cache, { recursive: true, force: true });
}
