/**
 * The per-agent Codex sync preference (`POST /api/agents/codex/sync`).
 *
 * Enabling or disabling Codex terminal sync is a durable preference in the broker's
 * `setup-state.json`, not a global control-mode picker. Turning it on against a broker that booted
 * without sync asks for a restart (here a dry run: the intent is reported and no replacement broker
 * is spawned), a restart-free disable of an already-off broker reports no restart, and a broker that
 * boots over a persisted "enabled" applies it before it builds its adapters, so a fresh launch needs
 * no restart. Replaced the legacy sync-enabler broker script.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Broker, type BrokerClient, type FixturePaths, startBroker } from '../harness/index.ts';

const posix = process.platform !== 'win32';

const savedPreference = (broker: Broker): any =>
  JSON.parse(readFileSync(join(broker.paths.cosyncingHome, 'setup-state.json'), 'utf8'));
const seedPreference = (paths: FixturePaths, enabled: boolean): void => {
  mkdirSync(paths.cosyncingHome, { recursive: true });
  writeFileSync(join(paths.cosyncingHome, 'setup-state.json'), `${JSON.stringify({ agents: { codex: enabled } }, null, 2)}\n`);
};
const codexRow = async (client: BrokerClient): Promise<any> => {
  const agents = await client.get('/api/agents');
  expect(agents.status, agents.text).toBe(200);
  const row = (agents.body as any[]).find((agent) => agent.id === 'codex');
  expect(row, 'codex is advertised').toBeDefined();
  return row;
};
const health = async (broker: Broker): Promise<any> => (await fetch(`${broker.url}/api/health`)).json();

describe('Codex sync preference', () => {
  let off: Broker;
  let persistedOn: Broker;

  beforeAll(async () => {
    // Two independent brokers, started together: one booted with sync off, one over a persisted "on".
    // The first pins sync off in its environment; the second leaves it unset so the broker has to
    // derive it from the persisted preference before it builds its adapters.
    [off, persistedOn] = await Promise.all([
      startBroker({
        name: 'codex-sync-off',
        setup: (paths) => seedPreference(paths, false),
        env: { COSYNCING_CODEX_SYNC_SERVER: '0', COSYNCING_RESTART_DRY_RUN: '1', COSYNCING_CLAUDE_HOOKS: '0' },
      }),
      startBroker({
        name: 'codex-sync-persisted',
        setup: (paths) => seedPreference(paths, true),
        env: { COSYNCING_RESTART_DRY_RUN: '1', COSYNCING_CLAUDE_HOOKS: '0' },
      }),
    ]);
  });
  afterAll(async () => {
    await Promise.all([off?.stop(), persistedOn?.stop()]);
  });

  test('a broker booted with sync off reports it off, and rejects a non-boolean preference', async () => {
    const client = off.client();
    expect((await health(off)).codexSyncServer).toBe(false);
    const before = await client.get('/api/agents/codex/sync');
    expect(before.status).toBe(200);
    expect((before.body as any).enabled).toBe(false);
    const badType = await client.post('/api/agents/codex/sync', { enabled: 'yes' });
    expect(badType.status).toBe(400);
    expect((await codexRow(client)).syncEnabled).toBe(false);
  });

  test.if(posix)('enabling it against that running broker persists the intent and asks for a restart without spawning one', async () => {
    const enable = await off.client().post('/api/agents/codex/sync', { enabled: true });
    expect(enable.status, enable.text).toBe(202);
    expect(enable.body).toMatchObject({ enabled: true, agent: 'codex', restartRequired: true, restartScheduled: false, dryRun: true });
    expect(savedPreference(off).agents.codex).toBe(true);
  });

  test.if(!posix)('Windows has no Codex sync: enabling is refused, explained, and changes nothing', async () => {
    const saved = readFileSync(join(off.paths.cosyncingHome, 'setup-state.json'), 'utf8');
    const enable = await off.client().post('/api/agents/codex/sync', { enabled: true });
    expect(enable.status).toBe(409);
    expect(typeof (enable.body as any).error).toBe('string');
    expect((enable.body as any).restartRequired || (enable.body as any).restartScheduled).toBeFalsy();
    expect(readFileSync(join(off.paths.cosyncingHome, 'setup-state.json'), 'utf8')).toBe(saved);
  });

  test('disabling a broker that is still running with sync off needs no restart, persists off, and /api/agents advertises the ability', async () => {
    // The dry run never applied the enable, so the running broker is still off.
    const disable = await off.client().post('/api/agents/codex/sync', { enabled: false });
    expect(disable.status, disable.text).toBe(200);
    expect((disable.body as any).restartRequired).toBe(false);
    expect(savedPreference(off).agents.codex).toBe(false);
    const row = await codexRow(off.client());
    expect(row.syncEnabled).toBe(false);
    expect(typeof row.capabilities?.supportsLiveAttach).toBe('boolean');
  });

  test('a fresh broker over a persisted "enabled" applies it at construction, no restart (the platform default on Windows)', async () => {
    const expected = posix;
    expect((await health(persistedOn)).codexSyncServer).toBe(expected);
    const row = await codexRow(persistedOn.client());
    expect(row.capabilities?.supportsLiveAttach).toBe(expected);
    expect(row.syncEnabled).toBe(expected);
  });
});
