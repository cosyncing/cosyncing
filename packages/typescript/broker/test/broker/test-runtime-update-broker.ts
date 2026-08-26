/**
 * Broker contract for managed runtime freshness status + confirmed manual restart.
 * Uses a fake Codex CLI and isolated CODEX_HOME; no real daemon, server, session, or model is touched.
 *
 *   bun run packages/typescript/broker/test/broker/test-runtime-update-broker.ts
 */
export {};
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = join(import.meta.dir, '../../../../..');
const temp = mkdtempSync(join(tmpdir(), 'cosyncing-runtime-broker-'));
const fake = join(temp, 'codex');
const marker = join(temp, 'restarted');
const stopped = join(temp, 'daemon-stopped');
const versionProbes = join(temp, 'version-probes');
const socketPath = join(temp, 'app-server-control', 'app-server-control.sock');
mkdirSync(join(temp, 'app-server-control'), { recursive: true });
writeFileSync(socketPath, 'daemon-generation-1');

writeFileSync(fake, `#!/bin/sh\nif [ "$2 $3" = "daemon version" ]; then\n  printf v >> '${versionProbes}'\n  if [ -f '${stopped}' ]; then exit 1; fi\n  if [ -f '${marker}' ]; then running=0.144.1; else running=0.142.5; fi\n  printf '{"status":"running","cliVersion":"0.144.1","appServerVersion":"%s","socketPath":"${socketPath}","backend":"pid","pid":123}\\n' "$running"\n  exit 0\nfi\nif [ "$2 $3" = "daemon restart" ]; then\n  exit 0\nfi\nif [ "$2 $3" = "daemon stop" ]; then\n  : > '${stopped}'\n  exit 0\nfi\nif [ "$2 $3" = "daemon start" ]; then\n  rm -f '${stopped}'\n  : > '${marker}'\n  printf generation-2 > '${socketPath}'\n  exit 0\nfi\nexit 2\n`);
chmodSync(fake, 0o755);

async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate port');
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

async function waitFor(base: string, path: string): Promise<any> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}${path}`);
      if (response.ok) return response.json();
    } catch { /* broker starting */ }
    await delay(100);
  }
  throw new Error(`timed out waiting for ${path}`);
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
  cwd: ROOT,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    CODEX_HOME: temp,
    COSYNCING_HOME: temp,
    COSYNCING_CODEX_BIN: fake,
    COSYNCING_CODEX_SYNC_SERVER: '0',
    COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
    COSYNCING_CLAUDE_HOOKS: '0',
    COSYNCING_TOKEN: '',
    COSYNCING_TOKEN_FILE: '',
    COSYNCING_PI_INTEGRATION_FILE: '',
    COSYNCING_PI_INTEGRATION_TOKEN: '',
    COSYNCING_RUNTIME_UPDATE_POLL_MS: '600000',
    COSYNCING_RUNTIME_UPDATE_STATUS_TTL_MS: '600000',
    COSYNCING_CODEX_DAEMON_RESTART_VERIFY_MS: '0',
    COSYNCING_RESTART_DRY_RUN: '1',
  },
  stdin: 'ignore',
  stdout: 'ignore',
  stderr: 'ignore',
});

try {
  await waitFor(base, '/api/health');

  const defaultPolicyResponse = await fetch(`${base}/api/agent-runtime-update-policy`);
  const defaultPolicy: any = await defaultPolicyResponse.json();
  if (!defaultPolicyResponse.ok || defaultPolicy.codexUpdatePolicy !== 'when-detached') {
    throw new Error(`expected default when-detached policy, got ${defaultPolicyResponse.status} ${JSON.stringify(defaultPolicy)}`);
  }
  const invalidPolicy = await fetch(`${base}/api/agent-runtime-update-policy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ codexUpdatePolicy: 'when-convenient' }),
  });
  if (invalidPolicy.status !== 400) throw new Error(`invalid update policy must return 400, got ${invalidPolicy.status}`);
  const savedPolicyResponse = await fetch(`${base}/api/agent-runtime-update-policy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ codexUpdatePolicy: 'when-idle' }),
  });
  const savedPolicy: any = await savedPolicyResponse.json();
  if (!savedPolicyResponse.ok || savedPolicy.codexUpdatePolicy !== 'when-idle') {
    throw new Error(`policy POST did not persist when-idle: ${savedPolicyResponse.status} ${JSON.stringify(savedPolicy)}`);
  }
  const initial = await waitFor(base, '/api/agent-runtime-updates');
  const codex = initial.updates?.find((entry: any) => entry.agent === 'codex');
  if (codex?.state !== 'pending' || codex?.autoRestartReady !== false) {
    throw new Error(`expected fail-closed pending Codex drift, got ${JSON.stringify(initial)}`);
  }
  const probesBeforeCachedGets = readFileSync(versionProbes, 'utf8').length;
  await fetch(`${base}/api/agent-runtime-updates`);
  await fetch(`${base}/api/agent-runtime-updates`);
  const probesAfterCachedGets = readFileSync(versionProbes, 'utf8').length;
  if (probesAfterCachedGets !== probesBeforeCachedGets) {
    throw new Error(`fresh status GETs should reuse checkedAt cache: before=${probesBeforeCachedGets} after=${probesAfterCachedGets}`);
  }
  // ?fresh=1 must bypass the TTL cache and run a real native probe (2026-07-11, test-UI Refresh status).
  await fetch(`${base}/api/agent-runtime-updates?fresh=1`);
  const probesAfterFreshGet = readFileSync(versionProbes, 'utf8').length;
  if (probesAfterFreshGet <= probesAfterCachedGets) {
    throw new Error(`?fresh=1 must force a native probe: cached=${probesAfterCachedGets} fresh=${probesAfterFreshGet}`);
  }

  const unconfirmed = await fetch(`${base}/api/agent-runtime-updates/codex/restart`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmRestart: false }),
  });
  if (unconfirmed.status !== 400 || existsSync(marker)) throw new Error('unconfirmed runtime restart must be rejected without mutation');

  const confirmed = await fetch(`${base}/api/agent-runtime-updates/codex/restart`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmRestart: true }),
  });
  const body: any = await confirmed.json();
  if (!confirmed.ok || !existsSync(marker) || body.update?.state !== 'current') {
    throw new Error(`confirmed runtime restart did not re-probe current: ${confirmed.status} ${JSON.stringify(body)}`);
  }

  const configPath = join(temp, 'config.toml');
  writeFileSync(configPath, 'model = "config-only-drift"\n');
  const configOnlyResponse = await fetch(`${base}/api/agent-runtime-updates?fresh=1`);
  const configOnlyBody: any = await configOnlyResponse.json();
  const configOnly = configOnlyBody.updates?.find((entry: any) => entry.agent === 'codex');
  if (!configOnlyResponse.ok
      || configOnly?.state !== 'pending'
      || configOnly?.runningVersion !== configOnly?.installedVersion
      || configOnly?.pendingChanges?.join(',') !== 'configuration') {
    throw new Error(`config-only drift was not exposed through the broker contract: ${configOnlyResponse.status} ${JSON.stringify(configOnlyBody)}`);
  }
  rmSync(configPath, { force: true });
  const revertedConfigResponse = await fetch(`${base}/api/agent-runtime-updates?fresh=1`);
  const revertedConfigBody: any = await revertedConfigResponse.json();
  const revertedConfig = revertedConfigBody.updates?.find((entry: any) => entry.agent === 'codex');
  if (!revertedConfigResponse.ok || revertedConfig?.state !== 'current') {
    throw new Error(`reverting to the daemon-generation config baseline did not clear drift: ${revertedConfigResponse.status} ${JSON.stringify(revertedConfigBody)}`);
  }
  rmSync(marker, { force: true });

  const unconfirmedAll = await fetch(`${base}/api/broker/restart-all`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmRestart: false }),
  });
  if (unconfirmedAll.status !== 400 || existsSync(marker)) {
    throw new Error('unconfirmed Restart everything must be rejected before restarting Codex');
  }

  const restartAll = await fetch(`${base}/api/broker/restart-all`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmRestart: true }),
  });
  const restartAllBody: any = await restartAll.json();
  if (
    !restartAll.ok ||
    !existsSync(marker) ||
    restartAllBody.components?.codex?.ok !== true ||
    restartAllBody.components?.opencode?.strategy !== 'broker-relaunch' ||
    restartAllBody.components?.opencode?.restartsWithBroker !== false ||
    String(restartAllBody.message || '').includes('Managed OpenCode will be replaced') ||
    restartAllBody.components?.broker?.scheduled !== false ||
    restartAllBody.components?.broker?.dryRun !== true
  ) {
    throw new Error(`Restart everything contract/order failed: ${restartAll.status} ${JSON.stringify(restartAllBody)}`);
  }

  rmSync(marker, { force: true });
  writeFileSync(stopped, 'stopped');
  const restartStopped = await fetch(`${base}/api/broker/restart-all`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmRestart: true }),
  });
  const stoppedBody: any = await restartStopped.json();
  if (
    !restartStopped.ok ||
    existsSync(marker) ||
    stoppedBody.components?.codex?.ok !== true ||
    stoppedBody.components?.codex?.skipped !== true ||
    !String(stoppedBody.components?.codex?.reason || '').includes('not running')
  ) {
    throw new Error(`stopped Codex daemon should be skipped without starting it: ${restartStopped.status} ${JSON.stringify(stoppedBody)}`);
  }
  console.log('PASS runtime-update policy + status + manual runtime restart + Restart everything broker contracts');
} finally {
  broker.kill();
  await broker.exited.catch(() => undefined);
  rmSync(temp, { recursive: true, force: true });
}
