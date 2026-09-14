#!/usr/bin/env bun
/**
 * Verify the INSTALLED Cline binary still matches what the adapter assumes.
 *
 * Every Cline suite in the gate is fixture-based, which is deliberate: the gate
 * must not depend on a machine having a particular CLI installed. The cost is
 * that the version floor gates every write path on a build that nothing
 * automated ever actually runs. When 3.0.61 removed `--cline-hub-daemon`, no
 * suite noticed; the lane died in a browser instead, and the cause took a long
 * time to find because the failure surfaced as "host-not-ready-in-time".
 *
 * This closes that gap without putting an environment dependency in the gate.
 * It is opt-in, run by hand or after an upgrade, and it checks the assumptions
 * the adapter makes about the real binary:
 *
 *   1. `--version` reads at or above CLINE_MINIMUM_SUPPORTED_VERSION through the same
 *      reader the gate uses.
 *   2. The descriptor's launch argv+env actually brings up a Hub.
 *   3. That Hub reports a core version at or above the floor, protocol v1, and binds the
 *      host/port/pathname it was told to — so the address controls still work.
 *   4. The removed flag is still rejected, which is why argv no longer has it.
 *
 * It binds an EPHEMERAL high port, never 25463 (the owner's Hub) or 25464 (the
 * broker's managed Hub), and reaps its own child.
 *
 * Usage: bun run scripts/adapters/verify-cline-launch-surface.ts
 */
export {};
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLINE_HUB_CORE_MINIMUM_VERSION,
  CLINE_HUB_PROTOCOL_VERSION,
  clineHubCoreVersionSupported,
  CLINE_MANAGED_HUB_PORT,
  CLINE_OWNER_DEFAULT_HUB_PORT,
} from '../../packages/typescript/adapters/cline/src/hub.ts';
import { CLINE_MINIMUM_SUPPORTED_VERSION } from '../../packages/typescript/adapters/cline/src/store.ts';
import { clineVerifiedInvocation } from '../../packages/typescript/adapters/cline/src/version.ts';
import { clineVersionAllowsDrive } from '../../packages/typescript/adapters/cline/src/store.ts';
import { reportedProductVersion, resolveInvocation } from '../../packages/typescript/adapter-api/src/index.ts';

let failures = 0;
let total = 0;

function check(name: string, ok: boolean, detail?: string): void {
  total += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

/** A port that is neither the owner's Hub nor the broker's managed Hub. */
const PROBE_PORT = 25_487;
if (PROBE_PORT === CLINE_OWNER_DEFAULT_HUB_PORT || PROBE_PORT === CLINE_MANAGED_HUB_PORT) {
  throw new Error('probe port must not collide with the owner or managed Hub');
}

const command = process.env.COSYNCING_CLINE_BIN?.trim() || 'cline';
const invocation = resolveInvocation(command, { env: process.env });
if (!invocation) {
  console.log(`SKIP  no Cline binary resolvable from ${JSON.stringify(command)}`);
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), 'cosyncing-cline-surface-'));
let child: ReturnType<typeof Bun.spawn> | undefined;

try {
  // 1. The version the pin compares with ===.
  const versionProbe = Bun.spawnSync({
    cmd: [invocation.executable, ...invocation.prefixArgs ?? [], '--version'],
    env: { ...process.env, CLINE_NO_AUTO_UPDATE: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const reported = reportedProductVersion(
    `${new TextDecoder().decode(versionProbe.stdout)}\n${new TextDecoder().decode(versionProbe.stderr)}`,
    ['cline'],
  );
  // Floored to match the product. Pinned, this script reported a FALSE failure
  // on the next Cline self-update -- asserting a contract stricter than the one
  // the adapter enforces, against the real binary.
  check('the installed binary reports the floor or newer',
    reported !== undefined && clineVersionAllowsDrive(reported),
    `reported=${String(reported)} floor=${CLINE_MINIMUM_SUPPORTED_VERSION}`);
  check('the adapter therefore admits it for write paths',
    clineVerifiedInvocation(command, process.env) !== undefined);

  // 4. The flag the adapter stopped passing. Checked BEFORE the daemon start so
  //    a rejection here cannot be confused with the daemon failing to come up.
  //    The old four-flag argv is passed verbatim: `--help` cannot be used to
  //    probe it, because help short-circuits option parsing and exits 0, which
  //    reads as "the flag was accepted" when nothing parsed it at all.
  const removedFlag = Bun.spawnSync({
    cmd: [
      invocation.executable, ...invocation.prefixArgs ?? [],
      '--cline-hub-daemon', '--cwd', root,
      '--host', '127.0.0.1', '--port', String(PROBE_PORT), '--pathname', '/hub',
    ],
    env: { ...process.env, CLINE_NO_AUTO_UPDATE: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const removedFlagOutput = `${new TextDecoder().decode(removedFlag.stdout)}`
    + `${new TextDecoder().decode(removedFlag.stderr)}`;
  check('the removed daemon flag is still rejected, so argv is right to omit it',
    removedFlag.exitCode !== 0 && /unknown option/i.test(removedFlagOutput),
    `exit=${removedFlag.exitCode} output=${JSON.stringify(removedFlagOutput.slice(0, 120))}`);

  // 2. The descriptor's launch shape, as the managed host would spawn it.
  const profile = join(root, 'profile');
  child = Bun.spawn({
    cmd: [invocation.executable, ...invocation.prefixArgs ?? [], '--cwd', root],
    cwd: root,
    env: {
      ...process.env,
      CLINE_NO_AUTO_UPDATE: '1',
      CLINE_RUN_AS_HUB_DAEMON: '1',
      CLINE_DATA_DIR: profile,
      CLINE_SESSION_DATA_DIR: join(profile, 'sessions'),
      CLINE_HUB_PORT: String(PROBE_PORT),
      CLINE_HUB_HOST: '127.0.0.1',
      CLINE_HUB_PATHNAME: '/hub',
      CLINE_NO_INTERACTIVE: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let health: Record<string, unknown> | undefined;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await Bun.sleep(500);
    try {
      const response = await fetch(`http://127.0.0.1:${PROBE_PORT}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) { health = await response.json() as Record<string, unknown>; break; }
    } catch { /* not up yet */ }
  }

  check('the descriptor launch shape brings a Hub up', health !== undefined,
    health === undefined ? 'no /health within 30s' : 'ready');

  if (health) {
    check('the Hub reports a core version at or above the floor',
      clineHubCoreVersionSupported(health.coreVersion),
      `reported=${String(health.coreVersion)} floor=${CLINE_HUB_CORE_MINIMUM_VERSION}`);
    check('the Hub speaks the pinned protocol',
      health.protocolVersion === CLINE_HUB_PROTOCOL_VERSION,
      `reported=${String(health.protocolVersion)}`);
    // 3. The address controls are the whole isolation guarantee now that they
    //    live in the environment rather than in argv.
    check('the environment address controls are honored',
      health.host === '127.0.0.1' && health.port === PROBE_PORT
        && health.url === `ws://127.0.0.1:${PROBE_PORT}/hub`,
      `host=${String(health.host)} port=${String(health.port)} url=${String(health.url)}`);
  }
} finally {
  // Killing the spawned process is NOT enough, and getting this wrong once is
  // what proved it: `cline` is a Node resolver that spawnSync's the platform
  // binary, so the listener is a GRANDCHILD. Signalling only the launcher
  // leaves the daemon holding the port with nothing left to reap it — the exact
  // orphan this adapter's ownership code exists to prevent. Reap by address:
  // whoever holds the probe port is the thing this script started.
  if (child) {
    child.kill('SIGTERM');
    await Promise.race([child.exited, Bun.sleep(5_000)]);
    child.kill('SIGKILL');
  }
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    const holder = Bun.spawnSync({
      cmd: ['ss', '-lntpH', `sport = :${PROBE_PORT}`],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const pid = Number(/pid=(\d+)/.exec(new TextDecoder().decode(holder.stdout))?.[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) break;
    try { process.kill(pid, signal); } catch { /* already gone */ }
    await Bun.sleep(1_500);
  }
  const stillHeld = Bun.spawnSync({
    cmd: ['ss', '-lntH', `sport = :${PROBE_PORT}`],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (new TextDecoder().decode(stillHeld.stdout).trim().length > 0) {
    console.log(`WARN  port ${PROBE_PORT} is still held; reap it by hand`);
  }
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? '✅' : '❌'} ${total - failures}/${total} Cline launch-surface checks passed.`);
if (failures > 0) process.exit(1);
