/**
 * Headless contract test for the DECOUPLED Codex sync enabler (Sync Refactor D13/D15/D16/D18/FU-3).
 *
 * Replaces the old global `/api/broker/control-mode` picker contract (that endpoint + the `<select>` are
 * deleted by the refactor). Codex sync is now enabled per-agent via `POST /api/agents/codex/sync {enabled}`,
 * persisted durably to `${COSYNCING_HOME}/setup-state.json` (D18), and the broker reads that file
 * BEFORE constructing adapters so a fresh launch needs NO restart (FU-3).
 *
 * The broker runs with COSYNCING_RESTART_DRY_RUN=1 (proves restart INTENT without killing the test-owned
 * process), a throwaway COSYNCING_HOME (never touches a developer's real setup-state), and
 * COSYNCING_OPENCODE_NO_AUTOSERVE=1 (don't spawn a managed opencode serve during the test).
 */
import { join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  captureProcessOutput,
  isolatedBrokerFixtureEnvironment,
  startHealthyFixtureBroker,
} from '../helpers/isolated-broker-fixture.ts';

const ROOT = join(import.meta.dir, '../../../../..');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'cosyncing-enabler-fixture-'));

function fail(message: string): never {
  throw new Error(message);
}

/** Start a broker and read its health payload once.
 *
 *  Readiness runs through the shared starter: a bespoke wall-clock deadline here
 *  is CI flake by another name now that this suite is required in the aggregate,
 *  and the starter additionally absorbs a lost port race or a silent startup
 *  stall by respawning instead of failing the suite. */
async function startBroker(home: string, env: Record<string, string>): Promise<{
  broker: ReturnType<typeof Bun.spawn>;
  base: string;
  health: any;
}> {
  let output!: ReturnType<typeof captureProcessOutput>;
  const { child, port } = await startHealthyFixtureBroker({
    spawn: (attemptPort) => {
      const spawned = spawnBroker(attemptPort, home, env);
      output = captureProcessOutput(spawned, { maxChars: 4_000 });
      return spawned;
    },
    healthUrl: (attemptPort) => `http://127.0.0.1:${attemptPort}/api/health`,
    capture: () => output,
    stop: stopBroker,
  });
  const base = `http://127.0.0.1:${port}`;
  const res = await fetch(`${base}/api/health`);
  if (!res.ok) fail(`healthy broker stopped answering /api/health: status ${res.status}`);
  return { broker: child, base, health: await res.json() };
}

async function jsonPost(base: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function getJson(base: string, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function spawnBroker(port: number, home: string, env: Record<string, string>) {
  return Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    cwd: ROOT,
    // Scrubbed fixture environment, not ...process.env: an inherited developer
    // environment lets the broker reach real Claude/Codex/Pi host state and
    // spawn adapter probes that can outlive SIGTERM — the stray-process class
    // the audited deterministic lane fails on.
    env: isolatedBrokerFixtureEnvironment(fixtureRoot, {
      overrides: {
        HOST: '127.0.0.1',
        PORT: String(port),
        COSYNCING_HOME: home,
        COSYNCING_RESTART_DRY_RUN: '1',
        COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
        // Keep Claude hook auto-install OFF during the test.
        COSYNCING_CLAUDE_HOOKS: '0',
        ...env,
      },
    }),
    stdin: 'ignore',
    // Piped, and drained by the starter's reader: a silent startup stall can
    // only be told from a slow one by proving nothing was written.
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

/** SIGTERM, bounded wait, then SIGKILL — the broker must not outlive its suite. */
async function stopBroker(broker: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (broker.exitCode === null) broker.kill('SIGTERM');
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let exited = await Promise.race([broker.exited.then(() => true).catch(() => true), sleep(5_000).then(() => false)]);
  if (!exited && broker.exitCode === null) {
    broker.kill('SIGKILL');
    exited = await Promise.race([broker.exited.then(() => true).catch(() => true), sleep(5_000).then(() => false)]);
  }
  if (!exited) fail('broker did not exit after SIGTERM/SIGKILL');
}

const home = mkdtempSync(join(tmpdir(), 'cosyncing-enabler-'));
const setupStatePath = join(home, 'setup-state.json');

// Outer cleanup: an assertion failure inside either phase must not strand the
// temporary directories.
try {

// ── Phase 1: the per-agent enabler endpoint, against a broker started WITHOUT Codex sync ──────────────
{
  const { broker, base, health } = await startBroker(home, { COSYNCING_CODEX_SYNC_SERVER: '0' });
  try {
    if (health.codexSyncServer !== false) fail('phase1: expected Codex sync-server disabled at boot');

    const before = await getJson(base, '/api/agents/codex/sync');
    if (before.status !== 200 || before.body.enabled !== false) fail(`phase1: GET enabler should report enabled:false, got ${JSON.stringify(before.body)}`);

    const badType = await jsonPost(base, '/api/agents/codex/sync', { enabled: 'yes' });
    if (badType.status !== 400) fail(`phase1: non-boolean enabled should 400, got ${badType.status}`);

    const enable = await jsonPost(base, '/api/agents/codex/sync', { enabled: true });
    if (enable.status !== 202) fail(`phase1: enabling against a running observe-broker should require restart (202), got ${enable.status}`);
    if (enable.body.enabled !== true) fail('phase1: enable response lost enabled:true');
    if (enable.body.agent !== 'codex') fail('phase1: enable response should name the codex agent');
    if (enable.body.restartRequired !== true) fail('phase1: enabling against a running broker should require a restart');
    if (enable.body.restartScheduled !== false || enable.body.dryRun !== true) fail('phase1: dry-run must NOT spawn a replacement broker');

    // Intent persisted durably to setup-state.json (D18) — survives restart/cache wipe.
    const persisted = JSON.parse(readFileSync(setupStatePath, 'utf8'));
    if (persisted?.agents?.codex !== true) fail(`phase1: setup-state should persist agents.codex=true, got ${JSON.stringify(persisted)}`);

    // Disabling: dry-run never applied the enable, so the running env is still off → no restart needed.
    const disable = await jsonPost(base, '/api/agents/codex/sync', { enabled: false });
    if (disable.status !== 200) fail(`phase1: disabling when already-off should 200 (no restart), got ${disable.status}`);
    if (disable.body.restartRequired !== false) fail('phase1: disabling an already-off broker should not restart');
    const persisted2 = JSON.parse(readFileSync(setupStatePath, 'utf8'));
    if (persisted2?.agents?.codex !== false) fail('phase1: setup-state should now persist agents.codex=false');

    // /api/agents advertises ability + the per-agent enablement flag (D16).
    const agents = await getJson(base, '/api/agents');
    const codex = Array.isArray(agents.body) ? agents.body.find((a: any) => a.id === 'codex') : undefined;
    if (!codex) fail('phase1: /api/agents missing codex');
    if (codex.syncEnabled !== false) fail(`phase1: /api/agents codex.syncEnabled should be false, got ${codex.syncEnabled}`);
    if (typeof codex.capabilities?.supportsLiveAttach !== 'boolean') fail('phase1: /api/agents codex should advertise capabilities.supportsLiveAttach');

    console.log('PASS phase1 — Codex per-agent sync enabler (endpoint + dry-run restart intent + durable persist)');
  } finally {
    await stopBroker(broker);
  }
}

// ── Phase 2: FU-3 pre-start — a fresh broker reads persisted enablement and needs NO restart ──────────
{
  // Seed setup-state to enabled and start a broker WITHOUT COSYNCING_CODEX_SYNC_SERVER in the env.
  mkdirSync(home, { recursive: true });
  writeFileSync(setupStatePath, JSON.stringify({ agents: { codex: true } }, null, 2) + '\n');
  const env: Record<string, string> = {};
  // Deliberately do NOT set COSYNCING_CODEX_SYNC_SERVER — the broker must derive it from setup-state pre-start.
  delete (process.env as any).COSYNCING_CODEX_SYNC_SERVER;
  const { broker, base, health } = await startBroker(home, env);
  try {
    if (health.codexSyncServer !== true) fail('phase2 (FU-3): a broker launched with persisted codex=true must come up with Codex sync ON, no restart');

    const agents = await getJson(base, '/api/agents');
    const codex = Array.isArray(agents.body) ? agents.body.find((a: any) => a.id === 'codex') : undefined;
    if (!codex) fail('phase2: /api/agents missing codex');
    if (codex.capabilities?.supportsLiveAttach !== true) fail('phase2 (FU-3): codex should advertise supportsLiveAttach:true after pre-start enablement');
    if (codex.syncEnabled !== true) fail('phase2: codex.syncEnabled should be true after pre-start enablement');

    console.log('PASS phase2 — FU-3 pre-start: persisted Codex sync enablement applied at construction, no restart');
  } finally {
    await stopBroker(broker);
  }
}

} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(fixtureRoot, { recursive: true, force: true });
}
console.log('PASS Codex sync enabler contract (decoupled from the deleted control-mode picker)');
