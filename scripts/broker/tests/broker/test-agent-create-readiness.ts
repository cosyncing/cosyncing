#!/usr/bin/env bun
import assert from 'node:assert/strict';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  captureProcessOutput,
  isolatedBrokerFixtureEnvironment,
  reserveLoopbackFixturePort,
  settledProcessOutput,
  waitForBrokerHealth,
} from '../helpers/isolated-broker-fixture.ts';
import { OpenCodeAdapter } from '../../../../packages/typescript/adapters/opencode/src/index.ts';

const root = mkdtempSync(join(tmpdir(), 'cosyncing-create-readiness-'));
const token = 'create-readiness-token';

function executable(path: string, source: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}

function fakePiWithNode(version: string, fixture: string): { pi: string; nodeBin: string } {
  const nodeBin = join(root, fixture, 'node-bin');
  executable(join(nodeBin, 'node'), `#!/bin/sh\nprintf '%s\\n' 'v${version}'\n`);
  const packageRoot = join(root, fixture, 'pi-package');
  const pi = executable(join(packageRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@earendil-works/pi-coding-agent',
    version: '0.84.0',
    engines: { node: '>=22.19.0' },
  }));
  const bin = join(root, fixture, 'pi-bin');
  mkdirSync(bin, { recursive: true });
  symlinkSync(pi, join(bin, 'pi'));
  return { pi: join(bin, 'pi'), nodeBin };
}

async function spawnBroker(options: {
  fixture: string;
  opencodeBin?: string;
  opencodeUrl: string;
  noAutoserve?: boolean;
  startupTimeoutMs?: number;
  pi: { pi: string; nodeBin: string };
}): Promise<{
  child: ReturnType<typeof Bun.spawn>;
  output: ReturnType<typeof captureProcessOutput>;
  base: string;
}> {
  const fixtureRoot = join(root, options.fixture);
  const lease = await reserveLoopbackFixturePort();
  const port = lease.port;
  const env = isolatedBrokerFixtureEnvironment(fixtureRoot, {
    overrides: {
      PORT: String(port),
      HOST: '127.0.0.1',
      COSYNCING_TOKEN: token,
      OPENCODE_URL: options.opencodeUrl,
      COSYNCING_OPENCODE_NO_AUTOSERVE: options.noAutoserve ? '1' : '0',
      COSYNCING_OPENCODE_STARTUP_TIMEOUT_MS: String(options.startupTimeoutMs ?? 2_000),
      COSYNCING_PI_BIN: options.pi.pi,
      PATH: `${options.pi.nodeBin}:${options.opencodeBin ? dirname(options.opencodeBin) + ':' : ''}${process.env.PATH ?? ''}`,
      COSYNCING_CODEX_SYNC_SERVER: '0',
    },
  });
  await lease.release();
  const child = Bun.spawn(['bun', 'packages/typescript/broker/src/main.ts'], {
    cwd: process.cwd(),
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = captureProcessOutput(child, { maxChars: 12_000 });
  const base = `http://127.0.0.1:${port}`;
  await waitForBrokerHealth(child, `${base}/api/health`);
  return { child, output, base };
}

async function stopBroker(broker: Awaited<ReturnType<typeof spawnBroker>>): Promise<string> {
  broker.child.kill();
  await broker.child.exited.catch(() => undefined);
  return settledProcessOutput(broker.output);
}

function createHeaders(): Record<string, string> {
  return { 'content-type': 'application/json', 'x-cosyncing-token': token };
}

try {
  const badPi = fakePiWithNode('22.14.0', 'bad-pi');

  // Managed startup: broker health is already ready while the child is held behind a gate.
  const managedRoot = join(root, 'managed');
  const gate = join(managedRoot, 'release');
  const createLog = join(managedRoot, 'creates.log');
  const opencodeBin = executable(join(managedRoot, 'bin', 'opencode'), `#!/usr/bin/env bun
import { appendFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.17.19'); process.exit(0); }
if (args[0] !== 'serve') process.exit(2);
while (!existsSync(${JSON.stringify(gate)})) await Bun.sleep(20);
const port = Number(args[args.indexOf('--port') + 1]);
const hostname = args[args.indexOf('--hostname') + 1];
Bun.serve({ hostname, port, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/global/health') return Response.json({ healthy: true, version: '1.17.19' });
  if (path === '/session' && request.method === 'GET') return Response.json([]);
  if (path === '/session' && request.method === 'POST') {
    appendFileSync(${JSON.stringify(createLog)}, 'create\\n');
    return Response.json({ id: 'managed-created', title: 'Managed', directory: ${JSON.stringify(root)}, time: { created: 1, updated: 1 } });
  }
  return new Response('not found', { status: 404 });
}});
`);
  const managedPortLease = await reserveLoopbackFixturePort();
  const managedPort = managedPortLease.port;
  await managedPortLease.release();
  const managed = await spawnBroker({
    fixture: 'managed-broker',
    opencodeBin,
    opencodeUrl: `http://127.0.0.1:${managedPort}`,
    pi: badPi,
  });
  try {
    const agents = await (await fetch(`${managed.base}/api/agents`)).json() as any[];
    assert.equal(agents.find((agent) => agent.id === 'opencode')?.canCreateSession, false);
    assert.equal(agents.find((agent) => agent.id === 'pi')?.canCreateSession, false,
      'live broker readiness must not advertise Pi under Node 22.14');

    let settled = false;
    const request = fetch(`${managed.base}/api/sessions/opencode`, {
      method: 'POST',
      headers: createHeaders(),
      body: JSON.stringify({ directory: root }),
    }).then(async (response) => {
      settled = true;
      return { status: response.status, body: await response.json() as any };
    });
    await Bun.sleep(150);
    assert.equal(settled, false, 'immediate create must wait at the managed readiness boundary');
    writeFileSync(gate, 'ready');
    const created = await request;
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.session?.id, 'managed-created');
    assert.equal(readFileSync(createLog, 'utf8').trim().split('\n').length, 1,
      'the adapter readiness probe must leave exactly one create POST');
  } finally {
    await stopBroker(managed);
  }

  // Permanent managed absence: the startup deadline and request both terminate with a typed 503.
  const absentRoot = join(root, 'absent');
  const absentBin = executable(join(absentRoot, 'bin', 'opencode'), `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.17.19'); process.exit(0); }
await Bun.sleep(60_000);
`);
  const absentPortLease = await reserveLoopbackFixturePort();
  const absentPort = absentPortLease.port;
  await absentPortLease.release();
  const absent = await spawnBroker({
    fixture: 'absent-broker',
    opencodeBin: absentBin,
    opencodeUrl: `http://127.0.0.1:${absentPort}`,
    startupTimeoutMs: 350,
    pi: badPi,
  });
  try {
    const started = Date.now();
    const response = await fetch(`${absent.base}/api/sessions/opencode`, {
      method: 'POST',
      headers: createHeaders(),
      body: JSON.stringify({ directory: root }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 503);
    assert.equal(body.code, 'SESSION_CREATE_TEMPORARILY_UNAVAILABLE');
    assert.equal(body.errorType, undefined, 'temporary creation uses the established broker code field');
    assert.equal(body.detailCode, 'opencode-server-connection-unavailable');
    assert.ok(Date.now() - started < 3_000, 'permanent absence must remain bounded');
  } finally {
    await stopBroker(absent);
  }

  // Externally managed server: no managed wait/ownership change, still exactly one create.
  let externalCreates = 0;
  const external = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/session' && request.method === 'GET') return Response.json([]);
      if (path === '/session' && request.method === 'POST') {
        externalCreates += 1;
        return Response.json({ id: 'external-created', title: 'External', directory: root });
      }
      if (path === '/global/health') return Response.json({ healthy: true, version: '1.17.19' });
      return new Response('not found', { status: 404 });
    },
  });
  const externalBroker = await spawnBroker({
    fixture: 'external-broker',
    opencodeUrl: `http://127.0.0.1:${external.port}`,
    noAutoserve: true,
    pi: fakePiWithNode('22.19.0', 'good-pi'),
  });
  try {
    const agents = await (await fetch(`${externalBroker.base}/api/agents`)).json() as any[];
    assert.equal(agents.find((agent) => agent.id === 'opencode')?.canCreateSession, true);
    assert.equal(agents.find((agent) => agent.id === 'pi')?.canCreateSession, true);
    const response = await fetch(`${externalBroker.base}/api/sessions/opencode`, {
      method: 'POST',
      headers: createHeaders(),
      body: JSON.stringify({ directory: root }),
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal(externalCreates, 1);
  } finally {
    await stopBroker(externalBroker);
    external.stop(true);
  }

  // HTTP/application answers are authoritative: they are neither classified as startup connection
  // failures nor retried through the managed readiness boundary.
  let readinessGets = 0;
  let createPosts = 0;
  let managedWaits = 0;
  const httpFailure = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== '/session') return new Response('not found', { status: 404 });
      if (request.method === 'GET') {
        readinessGets += 1;
        return new Response('application not ready', { status: 503 });
      }
      createPosts += 1;
      return new Response('invalid model', { status: 422 });
    },
  });
  try {
    const adapter = new OpenCodeAdapter({
      baseUrl: `http://127.0.0.1:${httpFailure.port}`,
      waitForManagedCreateReadiness: async () => { managedWaits += 1; },
    });
    await assert.rejects(adapter.prepareCreateSession(), /HTTP 503/);
    assert.equal(readinessGets, 1, 'an OpenCode HTTP response must not be retried as startup');
    assert.equal(managedWaits, 0, 'an OpenCode HTTP response must not enter the managed startup wait');
    await assert.rejects(adapter.createSession({ directory: root }), /422/);
    assert.equal(createPosts, 1, 'an OpenCode application/model failure must issue one POST only');
  } finally {
    httpFailure.stop(true);
  }

  assert.equal(existsSync(createLog), true);
  console.log('PASS: managed/external OpenCode and Pi live create readiness are bounded and truthful');
} catch (error) {
  try { appendFileSync(join(root, 'failure.log'), String(error)); } catch { /* diagnostic only */ }
  throw error;
} finally {
  rmSync(root, { recursive: true, force: true });
}
