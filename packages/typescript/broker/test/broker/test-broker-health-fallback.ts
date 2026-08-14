#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const socket = createServer();
await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', () => resolve()));
const address = socket.address();
await new Promise<void>((resolve) => socket.close(() => resolve()));
if (!address || typeof address === 'string') throw new Error('no port');

const root = mkdtempSync(join(tmpdir(), 'cosyncing-health-fallback-'));
const home = join(root, 'home');
const blockedCache = join(root, 'cache-is-a-file');
writeFileSync(blockedCache, 'blocked');
const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
  env: {
    ...process.env,
    PORT: String(address.port), HOST: '127.0.0.1',
    COSYNCING_HOME: home, COSYNCING_CACHE_DIR: blockedCache,
    COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
  },
  stdout: 'ignore', stderr: 'pipe',
});
const base = `http://127.0.0.1:${address.port}`;
try {
  let response: Response | undefined;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      response = await fetch(`${base}/api/health`);
      if (response.ok) break;
    } catch { /* retry */ }
    await Bun.sleep(100);
  }
  assert.equal(response?.status, 200, 'broker stays live with an unavailable configured artifact root');
  const health = await response!.json() as any;
  assert.equal(health.ok, true, 'liveness remains true while degraded');
  assert.equal(health.healthStatus, 'critical');
  const detail = await (await fetch(`${base}/api/broker/health`)).json() as any;
  assert.equal(detail.components['artifact-filesystem'].status, 'critical');
  assert.equal(JSON.stringify(detail).includes(blockedCache), false);
  console.log('PASS: broker-health starts degraded with process-local artifact fallback and preserves liveness');
} finally {
  broker.kill();
  await broker.exited.catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
