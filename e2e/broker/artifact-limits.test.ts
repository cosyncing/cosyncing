/**
 * The artifact store's bounds and failure behaviour, as a user meets them.
 *
 * Artifacts are kept in a durable, bounded store (an index plus content-
 * addressed blobs under the cache directory). These tests start brokers with
 * small bounds through the documented `COSYNCING_ARTIFACT_CACHE_*` settings,
 * send files from a Pi session, and assert what a client is replayed, what
 * still downloads, what the health surface reports, and what is left on disk
 * for the next start to read.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Broker, type BrokerClient, eventually, type SessionStream, startBroker } from '../harness/index.ts';
import { PiBridgeSession } from '../harness/fakes/pi-bridge-driver.ts';

const POSIX = process.platform !== 'win32';

const names = (stream: SessionStream): string[] =>
  stream.messages().filter((message) => message?.type === 'file-artifact').map((message) => String(message.name));

async function attachSettled(client: BrokerClient, id: string): Promise<SessionStream> {
  const stream = await client.attach('pi', id, { artifactMode: 'reference' });
  await stream.waitForKind('history');
  // Replayed artifacts follow the history frame; a refused interaction comes back after them.
  const barrier = await stream.sendAndAwait({
    kind: 'artifact-interaction',
    artifactKey: 'e2e-barrier',
    interaction: { type: 'action', action: 'noop' },
  });
  expect(barrier.code).toBe('ARTIFACT_INTERACTION_NOT_FOUND');
  return stream;
}

async function send(pi: PiBridgeSession, name: string, bytes: string | Buffer): Promise<number> {
  writeFileSync(join(pi.cwd, name), bytes);
  return (await pi.sendFile(join(pi.cwd, name))).status;
}

function filesBelow(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

const indexRecords = (cache: string): any[] =>
  JSON.parse(readFileSync(join(cache, 'artifacts', 'index.json'), 'utf8')).records;

async function artifactHealth(broker: Broker): Promise<{ status: string; detailCodes: string[] }> {
  const health = await broker.client().get('/api/broker/health');
  expect(health.status).toBe(200);
  return health.body.components['artifact-store'];
}

describe('record and replay bounds', () => {
  let broker: Broker;
  let cache: string;
  let owner: PiBridgeSession;
  let peer: PiBridgeSession;
  const sent = Array.from({ length: 6 }, (_, index) => `tiny-${index}.txt`);

  beforeAll(async () => {
    broker = await startBroker({
      name: 'artifact-bounds',
      env: (paths) => ({
        COSYNCING_CACHE_DIR: join(paths.root, 'cache'),
        COSYNCING_ARTIFACT_CACHE_MAX_RECORDS: '5',
        COSYNCING_ARTIFACT_SESSION_REPLAY_LIMIT: '3',
      }),
    });
    cache = join(broker.paths.root, 'cache');
    const cwd = join(broker.paths.root, 'workspace');
    mkdirSync(cwd);
    owner = await PiBridgeSession.open(broker.client(), { cwd, title: 'owner' });
    peer = await PiBridgeSession.open(broker.client(), { cwd, title: 'peer' });
  });
  afterAll(() => broker?.stop());

  test('tiny and empty artifacts still count: the index keeps five records and a reattach replays the newest three', async () => {
    // Empty files used to slip past the byte ceiling indefinitely.
    for (const [index, name] of sent.entries()) {
      expect(await send(owner, name, index % 2 === 0 ? '' : `${index}`)).toBe(200);
    }
    expect(indexRecords(cache)).toHaveLength(5);
    const stream = await attachSettled(broker.client(), owner.id);
    expect(names(stream)).toEqual(sent.slice(-3));
    stream.close();
  });

  test('the bounded replay survives a restart and never crosses to a session sharing the workspace', async () => {
    await broker.restart();
    await owner.rehello();
    await peer.rehello();
    const ownerStream = await attachSettled(broker.client(), owner.id);
    const peerStream = await attachSettled(broker.client(), peer.id);
    expect(names(ownerStream)).toEqual(sent.slice(-3));
    expect(names(peerStream)).toEqual([]);
    ownerStream.close();
    peerStream.close();
  });
});

describe('store failures, capacity and a damaged index', () => {
  let broker: Broker;
  let cache: string;
  let pi: PiBridgeSession;

  beforeAll(async () => {
    broker = await startBroker({
      name: 'artifact-store',
      setup: (paths) => {
        mkdirSync(join(paths.root, 'cache'), { recursive: true });
        // A URL-signing secret left empty by an interrupted first run. On Windows a file the test
        // writes carries an inherited DACL, which the broker rightly refuses rather than repairs.
        if (POSIX) writeFileSync(join(paths.root, 'cache', 'artifact-url-secret'), '', { mode: 0o644 });
      },
      env: (paths) => ({
        COSYNCING_CACHE_DIR: join(paths.root, 'cache'),
        COSYNCING_ARTIFACT_CACHE_MAX_BYTES: '1024',
      }),
    });
    cache = join(broker.paths.root, 'cache');
    const cwd = join(broker.paths.root, 'workspace');
    mkdirSync(cwd);
    pi = await PiBridgeSession.open(broker.client(), { cwd });
  });
  afterAll(() => broker?.stop());

  test.skipIf(!POSIX)('an empty signing secret is replaced at start with 256 random bits, owner-only, and the store starts healthy', async () => {
    expect(broker.output()).not.toContain('artifact cache unavailable');
    const secretPath = join(cache, 'artifact-url-secret');
    expect(Buffer.from(readFileSync(secretPath, 'utf8').trim(), 'base64').length).toBeGreaterThanOrEqual(32);
    expect(statSync(secretPath).mode & 0o777).toBe(0o600);
    expect((await artifactHealth(broker)).status).toBe('healthy');
  });

  test('a failed index write refuses the file, shows in health, leaves no blob, and the store recovers', async () => {
    const index = join(cache, 'artifacts', 'index.json');
    rmSync(index, { force: true });
    mkdirSync(index); // the atomic replace cannot land on a directory
    const blobsBefore = filesBelow(join(cache, 'artifacts', 'blobs'));
    expect(await send(pi, 'blocked.txt', 'blocked bytes')).toBe(400);
    const health = await artifactHealth(broker);
    expect(health.status).toBe('critical');
    expect(health.detailCodes).toContain('write-failed');
    expect(filesBelow(join(cache, 'artifacts', 'blobs'))).toEqual(blobsBefore);

    rmSync(index, { recursive: true, force: true });
    const stream = await attachSettled(broker.client(), pi.id);
    expect(await send(pi, 'recovered.txt', 'recovered bytes')).toBe(200);
    const recovered = await stream.waitForMessage((message) => message?.name === 'recovered.txt');
    const fetched = await fetch(new URL(recovered.fetchUrl, broker.url));
    expect(await fetched.text()).toBe('recovered bytes');
    expect(indexRecords(cache).map((record) => record.name)).toEqual(['recovered.txt']);
    expect(readdirSync(join(cache, 'artifacts')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    stream.close();
  });

  test('a file larger than the whole cache is refused without touching the index or leaving a ghost after restart', async () => {
    expect(await send(pi, 'keep.txt', 'keep bytes')).toBe(200);
    const indexBefore = readFileSync(join(cache, 'artifacts', 'index.json'), 'utf8');
    const blobsBefore = filesBelow(join(cache, 'artifacts', 'blobs'));
    expect(await send(pi, 'too-big.txt', Buffer.alloc(2048, 0x62))).toBe(400);
    expect(readFileSync(join(cache, 'artifacts', 'index.json'), 'utf8')).toBe(indexBefore);
    expect(filesBelow(join(cache, 'artifacts', 'blobs'))).toEqual(blobsBefore);

    await broker.restart();
    await pi.rehello();
    const stream = await attachSettled(broker.client(), pi.id);
    expect(names(stream).sort()).toEqual(['keep.txt', 'recovered.txt']);
    stream.close();
  });

  test('a corrupt index is set aside as evidence, reported in health, replays nothing, and new files are accepted', async () => {
    await broker.stop({ keepState: true });
    writeFileSync(join(cache, 'artifacts', 'index.json'), '{not-json');
    await broker.start();
    await pi.rehello();
    const health = await artifactHealth(broker);
    expect(health.status).toBe('critical');
    const backups = readdirSync(join(cache, 'artifacts')).filter((name) => name.startsWith('index.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(cache, 'artifacts', backups[0]!), 'utf8')).toBe('{not-json');

    const stream = await attachSettled(broker.client(), pi.id);
    expect(names(stream)).toEqual([]);
    expect(await send(pi, 'after-corruption.txt', 'fresh bytes')).toBe(200);
    const fresh = await stream.waitForMessage((message) => message?.name === 'after-corruption.txt');
    expect(await (await fetch(new URL(fresh.fetchUrl, broker.url))).text()).toBe('fresh bytes');
    expect(indexRecords(cache).map((record) => record.name)).toEqual(['after-corruption.txt']);
    stream.close();
  });
});

describe('index size bound', () => {
  const MAX_INDEX_BYTES = 2600;
  const oversized = JSON.stringify({ version: 1, records: [], padding: 'x'.repeat(MAX_INDEX_BYTES) });
  let broker: Broker;
  let cache: string;
  let pi: PiBridgeSession;

  beforeAll(async () => {
    broker = await startBroker({
      name: 'artifact-index',
      setup: (paths) => {
        mkdirSync(join(paths.root, 'cache', 'artifacts'), { recursive: true });
        writeFileSync(join(paths.root, 'cache', 'artifacts', 'index.json'), oversized);
      },
      env: (paths) => ({
        COSYNCING_CACHE_DIR: join(paths.root, 'cache'),
        COSYNCING_ARTIFACT_CACHE_MAX_INDEX_BYTES: String(MAX_INDEX_BYTES),
      }),
    });
    cache = join(broker.paths.root, 'cache');
    const cwd = join(broker.paths.root, 'workspace');
    mkdirSync(cwd);
    pi = await PiBridgeSession.open(broker.client(), { cwd });
  });
  afterAll(() => broker?.stop());

  test('an index over the load bound fails closed at start and its bytes are kept as evidence', async () => {
    const backups = readdirSync(join(cache, 'artifacts')).filter((name) => name.startsWith('index.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(cache, 'artifacts', backups[0]!), 'utf8')).toBe(oversized);
    expect(existsSync(join(cache, 'artifacts', 'index.json'))).toBe(false);
    expect((await artifactHealth(broker)).status).toBe('critical');
  });

  test('byte pressure evicts the oldest records, every written index stays loadable, and a restart replays exactly what was kept', async () => {
    const sent = Array.from({ length: 5 }, (_, index) => `bounded-${index}.txt`);
    for (const name of sent) {
      expect(await send(pi, name, name)).toBe(200);
      expect(statSync(join(cache, 'artifacts', 'index.json')).size).toBeLessThanOrEqual(MAX_INDEX_BYTES);
    }
    const kept = indexRecords(cache).map((record) => String(record.name));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(sent.length);
    expect(kept).toEqual(sent.slice(-kept.length));

    await broker.restart();
    await pi.rehello();
    const stream = await attachSettled(broker.client(), pi.id);
    expect(names(stream)).toEqual(kept);
    stream.close();
  });
});

describe('age bound', () => {
  const MAX_AGE_DAYS = 0.00001; // 864 ms
  let broker: Broker;
  let cache: string;
  let pi: PiBridgeSession;

  beforeAll(async () => {
    broker = await startBroker({
      name: 'artifact-age',
      env: (paths) => ({
        COSYNCING_CACHE_DIR: join(paths.root, 'cache'),
        COSYNCING_ARTIFACT_CACHE_MAX_AGE_DAYS: String(MAX_AGE_DAYS),
      }),
    });
    cache = join(broker.paths.root, 'cache');
    const cwd = join(broker.paths.root, 'workspace');
    mkdirSync(cwd);
    pi = await PiBridgeSession.open(broker.client(), { cwd });
  });
  afterAll(() => broker?.stop());

  test('an artifact nobody touched past the age bound leaves the disk at the next write, and is never advertised with a dead URL', async () => {
    const blobs = join(cache, 'artifacts', 'blobs');
    const stream = await attachSettled(broker.client(), pi.id);
    expect(await send(pi, 'old.txt', 'old bytes')).toBe(200);
    const sentAt = Date.now();
    const old = await stream.waitForMessage((message) => message?.name === 'old.txt');
    const [oldBlob] = filesBelow(blobs);
    await eventually(() => Date.now() > sentAt + MAX_AGE_DAYS * 24 * 60 * 60 * 1000 + 50, { what: 'the age bound to pass' });

    expect(await send(pi, 'new.txt', 'new bytes')).toBe(200);
    expect(existsSync(oldBlob!)).toBe(false);
    expect(filesBelow(blobs)).toHaveLength(1);
    expect((await fetch(new URL(old.fetchUrl, broker.url))).status).toBe(404);
    stream.close();
    // A reattach still lists the evicted file, but never advertises a URL that can only 404.
    const reattached = await attachSettled(broker.client(), pi.id);
    const replayed = reattached.messages().filter((message) => message?.type === 'file-artifact');
    expect(replayed.map((message) => [message.name, typeof message.fetchUrl])).toEqual([['old.txt', 'undefined'], ['new.txt', 'string']]);
    reattached.close();
  });
});
