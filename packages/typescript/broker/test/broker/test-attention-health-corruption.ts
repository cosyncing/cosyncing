#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitHealth(base: string): Promise<any> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return response.json();
    } catch {
      /* retry */
    }
    await Bun.sleep(100);
  }
  throw new Error('broker did not become healthy');
}

async function start(home: string, port: number, token: string) {
  const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      COSYNCING_HOME: home,
      COSYNCING_TOKEN: token,
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
      COSYNCING_PI_BRIDGE_AUTOINSTALL: '0',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const publicHealth = await waitHealth(base);
  return { broker, base, publicHealth };
}

const root = mkdtempSync(join(tmpdir(), 'cosyncing-attention-health-corrupt-'));
const home = join(root, 'home');
const token = 'attention-health-test-token';
mkdirSync(home, { recursive: true });
const storePath = join(home, 'attention-events.json');
writeFileSync(storePath, '{not-json');

try {
  const first = await start(home, await freePort(), token);
  try {
    assert.equal(first.publicHealth.ok, true, 'public liveness must remain true after quarantine');
    assert.equal(first.publicHealth.healthStatus, 'degraded');
    assert(readdirSync(home).some((name) => name.startsWith('attention-events.json.') && name.endsWith('.corrupt')),
      'the corrupt source bytes must remain quarantined');

    const diagnosticsResponse = await fetch(`${first.base}/api/broker/health`, {
      headers: { 'x-cosyncing-token': token },
    });
    assert.equal(diagnosticsResponse.status, 200);
    const diagnostics = await diagnosticsResponse.json() as any;
    assert.equal(diagnostics.components['attention-store'].status, 'degraded');
    assert.deepEqual(diagnostics.components['attention-store'].detailCodes, ['startup-corrupt']);
    assert(!JSON.stringify(diagnostics).includes(root), 'authenticated diagnostics must not expose local paths');
    assert.equal((await fetch(`${first.base}/api/broker/health`)).status, 401,
      'component diagnostics remain authenticated');

    // Five sanitized auth failures create an ordinary durable attention event. This proves the
    // quarantined store can recover persistence without erasing the same-process startup episode.
    for (let index = 0; index < 4; index++) {
      await fetch(`${first.base}/api/broker/restart`, { method: 'POST' });
    }
    const writeDeadline = Date.now() + 3_000;
    while (!existsSync(storePath) && Date.now() < writeDeadline) await Bun.sleep(50);
    assert.equal(existsSync(storePath), true, 'the quarantined store must accept a clean replacement snapshot');
    const stillDegraded = await (await fetch(`${first.base}/api/broker/health`, {
      headers: { 'x-cosyncing-token': token },
    })).json() as any;
    assert.equal(stillDegraded.components['attention-store'].status, 'degraded',
      'a same-process store write must not erase the startup corruption episode');
  } finally {
    first.broker.kill();
    await first.broker.exited.catch(() => undefined);
  }

  const restarted = await start(home, await freePort(), token);
  try {
    assert.equal(restarted.publicHealth.ok, true);
    assert.equal(restarted.publicHealth.healthStatus, 'healthy',
      'restart over the clean replacement snapshot must recover startup health');
    const diagnostics = await (await fetch(`${restarted.base}/api/broker/health`, {
      headers: { 'x-cosyncing-token': token },
    })).json() as any;
    assert.equal(diagnostics.components['attention-store'].status, 'healthy');
    assert.deepEqual(diagnostics.components['attention-store'].detailCodes, []);
  } finally {
    restarted.broker.kill();
    await restarted.broker.exited.catch(() => undefined);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('PASS attention corruption quarantine, degraded liveness, sanitized diagnostics, recovery, and restart');
