/**
 * The attention store across restarts and damage: what a user still sees after the broker
 * restarts over a corrupt, foreign or unwritable store, and how broker-health problems become one
 * durable episode in the feed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Broker, type BrokerClient, eventually, startBroker } from '../harness/index.ts';
import { PiBridgeSession } from '../harness/fakes/pi-bridge-session.ts';

const STORE = 'attention-events.json';

async function feed(client: BrokerClient, clientId = 'durability'): Promise<any[]> {
  const events: any[] = [];
  let after: number | undefined;
  for (;;) {
    const query = new URLSearchParams({ clientId, limit: '200', ...(after !== undefined ? { after: String(after) } : {}) });
    const response = await client.get(`/api/attention-events?${query}`);
    expect(response.status).toBe(200);
    events.push(...response.body.events);
    if (!response.body.hasMore) return events;
    after = response.body.cursor;
  }
}

async function health(broker: Broker): Promise<any> {
  const response = await broker.client().get('/api/broker/health');
  expect(response.status).toBe(200);
  return response.body;
}

/** A finished turn in a fresh Pi session; resolves once its outcome is in the feed. */
async function savedTurn(broker: Broker, name: string): Promise<any> {
  const pi = await PiBridgeSession.open(broker.client(), broker.paths.root, name);
  await pi.turn(name);
  return eventually(async () => (await feed(broker.client())).find((event) => event.turnId === name), {
    what: `the outcome of ${name}`,
  });
}

describe('a corrupt store', () => {
  let broker: Broker;
  beforeAll(async () => {
    broker = await startBroker({
      name: 'attention-corrupt',
      token: true,
      setup: (paths) => writeFileSync(join(paths.cosyncingHome, STORE), '{not json', { mode: 0o600 }),
    });
  });
  afterAll(() => broker?.stop());

  test('is set aside with its bytes kept, while the broker stays live and names the store without a path', async () => {
    const aside = readdirSync(broker.paths.cosyncingHome).filter((name) => name.startsWith(`${STORE}.`) && name.endsWith('.corrupt'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(broker.paths.cosyncingHome, aside[0]!), 'utf8')).toBe('{not json');

    const anonymous = await broker.client({ kind: 'none' }).get('/api/health');
    expect(anonymous.body.ok).toBe(true);
    expect(anonymous.body.healthStatus).toBeUndefined();
    expect((await broker.client().get('/api/health')).body.healthStatus).toBe('degraded');
    const detail = await health(broker);
    expect(detail.components['attention-store']).toMatchObject({ status: 'degraded', detailCodes: ['startup-corrupt'] });
    expect(JSON.stringify(detail)).not.toContain(broker.paths.root);
    expect(await feed(broker.client())).toEqual([]);
  });

  test('takes new events at once, and is healthy again after a restart over the clean store', async () => {
    const saved = await savedTurn(broker, 'after-corruption');
    expect(existsSync(join(broker.paths.cosyncingHome, STORE))).toBe(true);
    // The startup episode stands for the life of this process.
    expect((await health(broker)).components['attention-store'].status).toBe('degraded');

    await broker.restart();
    expect((await broker.client().get('/api/health')).body.healthStatus).toBe('healthy');
    expect((await health(broker)).components['attention-store']).toMatchObject({ status: 'healthy', detailCodes: [] });
    expect((await feed(broker.client())).map((event) => event.id)).toContain(saved.id);
  });
});

describe('a store a newer broker wrote', () => {
  let broker: Broker;
  const now = Date.now();
  beforeAll(async () => {
    broker = await startBroker({
      name: 'attention-newer',
      setup: (paths) => writeFileSync(join(paths.cosyncingHome, STORE), JSON.stringify({
        version: 1,
        nextCursor: 2,
        prunedThroughCursor: 0,
        events: [{
          id: 'future-1', cursor: 1, revision: 1, presentationRevision: 1,
          kind: 'future-attention-kind', state: 'resolved', severity: 'informational',
          dedupeKey: 'future:1', createdAt: now, updatedAt: now, resolvedAt: now,
          title: 'From a newer broker', action: { kind: 'open-attention-inbox' },
          futureScope: { keep: true },
        }],
        observations: [], clientStates: [], deliveries: [],
      }), { mode: 0o600 }),
    });
  });
  afterAll(() => broker?.stop());

  test('keeps an unknown kind and its unknown fields through a read and a restart', async () => {
    const [listed] = await feed(broker.client(), 'phone');
    expect(listed).toMatchObject({ id: 'future-1', kind: 'future-attention-kind', futureScope: { keep: true } });
    expect(listed.sessionTitle).toBeUndefined();
    expect(listed.notificationType).toBeUndefined();

    expect((await broker.client().post('/api/attention-events/future-1/ack', { clientId: 'phone' })).status).toBe(200);
    await broker.restart();
    const [reloaded] = await feed(broker.client(), 'phone');
    expect(reloaded).toMatchObject({ id: 'future-1', kind: 'future-attention-kind', futureScope: { keep: true } });
    expect(reloaded.readAt).toBeNumber();
  });
});

describe('broker health episodes', () => {
  let broker: Broker;
  let cache = '';
  beforeAll(async () => {
    broker = await startBroker({
      name: 'attention-health',
      env: (paths) => {
        // An artifact cache path that is a file: the artifact filesystem is unusable.
        cache = join(paths.root, 'artifact-cache');
        writeFileSync(cache, 'not a directory');
        return { COSYNCING_CACHE_DIR: cache };
      },
    });
  });
  afterAll(() => broker?.stop());

  const episodes = async () => (await feed(broker.client())).filter((event) => event.kind === 'broker-health');

  test('a failing component opens one episode, a restart keeps that one, and recovery resolves it', async () => {
    const [opened] = await eventually(async () => {
      const found = await episodes();
      return found.length > 0 ? found : undefined;
    }, { what: 'a broker-health episode' });
    expect(opened).toMatchObject({
      state: 'active',
      severity: 'action-required',
      title: 'Broker health needs attention',
      action: { kind: 'open-broker-health' },
      notificationType: 'server_problem',
      collapseKey: opened.dedupeKey,
    });
    // The artifact filesystem and the artifact store both fail.
    expect(opened.summary).toBe('Broker persistence is critical (2 components).');

    await broker.restart();
    expect((await broker.client().get('/api/health')).body.healthStatus).toBe('critical');
    await savedTurn(broker, 'after-restart');
    expect((await episodes()).map((event) => [event.id, event.state])).toEqual([[opened.id, 'active']]);

    rmSync(cache, { force: true });
    mkdirSync(cache);
    await broker.restart();
    const recovered = await eventually(async () => {
      const found = await episodes();
      return found.every((event) => event.state === 'resolved') ? found : undefined;
    }, { what: 'the episode resolved' });
    expect(recovered.map((event) => event.id)).toEqual([opened.id]);
    expect((await broker.client().get('/api/health')).body.healthStatus).toBe('healthy');
  });
});

describe('episodes an earlier run left open', () => {
  let broker: Broker;
  const now = Date.now();
  const episode = (id: string, cursor: number, createdAt: number) => ({
    id, cursor, revision: 1, presentationRevision: 1, presentationStage: 'immediate',
    kind: 'broker-health', state: 'active', severity: 'maintenance', dedupeKey: `broker-health:earlier:${createdAt}`,
    createdAt, updatedAt: createdAt, title: 'Broker health degraded', action: { kind: 'open-broker-health' },
  });
  beforeAll(async () => {
    broker = await startBroker({
      name: 'attention-episodes',
      env: (paths) => {
        const cache = join(paths.root, 'artifact-cache');
        writeFileSync(cache, 'not a directory');
        return { COSYNCING_CACHE_DIR: cache };
      },
      setup: (paths) => writeFileSync(join(paths.cosyncingHome, STORE), JSON.stringify({
        version: 1, nextCursor: 3, prunedThroughCursor: 0,
        events: [episode('older', 1, now - 2_000), episode('newer', 2, now - 1_000)],
        observations: [], clientStates: [], deliveries: [],
      }), { mode: 0o600 }),
    });
  });
  afterAll(() => broker?.stop());

  test('a broker still unhealthy carries on the oldest episode and resolves the others', async () => {
    const episodes = await eventually(async () => {
      const found = (await feed(broker.client())).filter((event) => event.kind === 'broker-health');
      return found.some((event) => event.id === 'newer' && event.state === 'resolved') ? found : undefined;
    }, { what: 'the extra episode resolved' });
    expect(episodes.map((event) => [event.id, event.state]).sort()).toEqual([['newer', 'resolved'], ['older', 'active']]);
    const carried = await eventually(async () => {
      const older = (await feed(broker.client())).find((event) => event.id === 'older');
      return older?.severity === 'action-required' ? older : undefined;
    }, { what: 'the oldest episode carrying the current state' });
    expect(carried.summary).toBe('Broker persistence is critical (2 components).');
  });
});

describe('a store that cannot be written', () => {
  let broker: Broker;
  beforeAll(async () => {
    broker = await startBroker({ name: 'attention-unwritable' });
  });
  afterAll(() => broker?.stop());

  test('an event that could not be saved is never served, health says why, and the next saved event is', async () => {
    const first = await savedTurn(broker, 'first');
    const path = join(broker.paths.cosyncingHome, STORE);
    const aside = `${path}.e2e-aside`;
    renameSync(path, aside);
    mkdirSync(path);
    try {
      const pi = await PiBridgeSession.open(broker.client(), broker.paths.root, 'lost');
      await pi.turn('lost');
      await eventually(async () => (await health(broker)).components['attention-store'].detailCodes.includes('write-failed'), {
        what: 'the failed write reported',
      });
      expect((await health(broker)).components['attention-store'].status).toBe('critical');
    } finally {
      rmSync(path, { recursive: true, force: true });
      renameSync(aside, path);
    }
    const after = await savedTurn(broker, 'after');
    const listed = (await feed(broker.client())).map((event) => event.turnId);
    expect(listed).toContain(first.turnId);
    expect(listed).toContain(after.turnId);
    expect(listed).not.toContain('lost');

    await broker.restart();
    expect((await feed(broker.client())).map((event) => event.turnId)).not.toContain('lost');
  });
});
