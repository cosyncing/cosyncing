#!/usr/bin/env bun
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { OpenCodeAdapter } from '../../../adapters/opencode/src/index.ts';
import {
  ensureManagedOpencodeServe,
  __setOpencodeBinOverrideForTest,
  restartManagedOpencodeRuntime,
  stopManagedOpencodeServe,
  waitForManagedOpencodeCreateReadiness,
} from '../../../adapters/opencode/src/managed-server.ts';
import '../../src/runtime/managed-runtime-state.ts';
import { reserveLoopbackFixturePort } from '../helpers/isolated-broker-fixture.ts';

const root = mkdtempSync(join(tmpdir(), 'cosyncing-opencode-ready-restart-'));
const starts = join(root, 'starts');
const restartGate = join(root, 'restart-ready');
const creates = join(root, 'creates');
const bin = join(root, 'bin', 'opencode');
mkdirSync(dirname(bin), { recursive: true });
writeFileSync(bin, `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.17.19'); process.exit(0); }
let generation = 1;
try { generation = Number(readFileSync(${JSON.stringify(starts)}, 'utf8')) + 1; } catch {}
writeFileSync(${JSON.stringify(starts)}, String(generation));
if (generation > 1) while (!existsSync(${JSON.stringify(restartGate)})) await Bun.sleep(20);
const port = Number(args[args.indexOf('--port') + 1]);
const hostname = args[args.indexOf('--hostname') + 1];
Bun.serve({ hostname, port, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/session' && request.method === 'GET') return Response.json([]);
  if (path === '/session' && request.method === 'POST') {
    appendFileSync(${JSON.stringify(creates)}, 'create\\n');
    return Response.json({ id: 'after-restart', title: 'Restarted', directory: ${JSON.stringify(root)} });
  }
  if (path === '/global/health') return Response.json({ healthy: true, version: '1.17.19' });
  return new Response('not found', { status: 404 });
}});
`);
chmodSync(bin, 0o755);

const original = {
  PATH: process.env.PATH,
  OPENCODE_URL: process.env.OPENCODE_URL,
  COSYNCING_HOME: process.env.COSYNCING_HOME,
  COSYNCING_OPENCODE_NO_AUTOSERVE: process.env.COSYNCING_OPENCODE_NO_AUTOSERVE,
};
const lease = await reserveLoopbackFixturePort();
const port = lease.port;
await lease.release();

try {
  process.env.PATH = `${dirname(bin)}:${original.PATH ?? ''}`;
  process.env.OPENCODE_URL = `http://127.0.0.1:${port}`;
  process.env.COSYNCING_HOME = join(root, 'state');
  process.env.COSYNCING_OPENCODE_NO_AUTOSERVE = '0';
  __setOpencodeBinOverrideForTest(bin);
  await ensureManagedOpencodeServe();
  assert.equal(readFileSync(starts, 'utf8'), '1');

  const adapter = new OpenCodeAdapter({
    waitForManagedCreateReadiness: waitForManagedOpencodeCreateReadiness,
  });
  assert.equal(await adapter.canCreateSession(), true);

  const restart = restartManagedOpencodeRuntime();
  for (let attempt = 0; attempt < 100 && (!existsSync(starts) || readFileSync(starts, 'utf8') !== '2'); attempt += 1) {
    await Bun.sleep(20);
  }
  assert.equal(readFileSync(starts, 'utf8'), '2', 'second managed child must reach the gated restart');

  let readySettled = false;
  const ready = adapter.prepareCreateSession().then(() => { readySettled = true; });
  await Bun.sleep(100);
  assert.equal(readySettled, false, 'create readiness must wait through a managed runtime restart');
  writeFileSync(restartGate, 'ready');
  await Promise.all([restart, ready]);

  const session = await adapter.createSession({ directory: root });
  assert.equal(session.id, 'after-restart');
  assert.equal(readFileSync(creates, 'utf8').trim().split('\n').length, 1,
    'restart readiness must still issue exactly one create POST');
  console.log('PASS: OpenCode create readiness follows the bounded managed restart boundary');
} finally {
  await stopManagedOpencodeServe().catch(() => undefined);
  __setOpencodeBinOverrideForTest(null);
  if (original.PATH === undefined) delete process.env.PATH; else process.env.PATH = original.PATH;
  if (original.OPENCODE_URL === undefined) delete process.env.OPENCODE_URL; else process.env.OPENCODE_URL = original.OPENCODE_URL;
  if (original.COSYNCING_HOME === undefined) delete process.env.COSYNCING_HOME; else process.env.COSYNCING_HOME = original.COSYNCING_HOME;
  if (original.COSYNCING_OPENCODE_NO_AUTOSERVE === undefined) delete process.env.COSYNCING_OPENCODE_NO_AUTOSERVE;
  else process.env.COSYNCING_OPENCODE_NO_AUTOSERVE = original.COSYNCING_OPENCODE_NO_AUTOSERVE;
  rmSync(root, { recursive: true, force: true });
}
