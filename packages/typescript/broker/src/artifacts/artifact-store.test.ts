/**
 * Artifact store behaviour no running broker can be steered into.
 *
 * `e2e/broker/artifacts.test.ts` and `artifact-limits.test.ts` drive the store
 * through a real broker. What stays here: reading an index written by a
 * release that keyed records by advertised URL (an upgrade and its rollback),
 * eviction when two records share one wall-clock millisecond, the export
 * ingestion check that only a hostile caller inside the broker could trip, and
 * which records the start sweep of export attachments may touch in a cache
 * another broker also wrote.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@cosyncing/adapter-api';
import { ArtifactStore } from './artifact-store.ts';

type Artifact = AgentMessage & { type: 'file-artifact' };

const root = mkdtempSync(join(tmpdir(), 'cosyncing-artifact-store-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const LEGACY = 'https://legacy.tailnet.ts.net';
const STABLE = 'broker-instance:broker_fixture_stable_identity_1234567890';

function file(name: string, artifactKey?: string): Artifact {
  return { type: 'file-artifact', name, path: name, mimeType: 'text/plain', ...(artifactKey ? { artifactKey } : {}) } as Artifact;
}

async function download(store: ArtifactStore, session: { tool: string; id: string }, reference: Artifact, base = 'http://127.0.0.1:7734') {
  const url = new URL(String(reference.fetchUrl), base);
  const response = store.serve(session.tool, session.id, String(reference.artifactKey), url.searchParams.get('expires'), url.searchParams.get('sig'));
  return { status: response.status, text: response.status === 200 ? await response.text() : '' };
}

describe('an index written before the stable broker identity', () => {
  const session = { tool: 'pi', id: 'legacy-session' };

  test('is adopted after the upgrade, old URLs stop working, and a rollback still reads it', async () => {
    const cache = join(root, 'migration');
    const legacy = new ArtifactStore(LEGACY, cache);
    const before = legacy.putBytes(session, file('before-upgrade.txt'), Buffer.from('survives identity migration'), 'text/plain') as Artifact;

    const upgraded = new ArtifactStore(STABLE, cache, { legacyBrokerSources: [LEGACY] });
    const adopted = upgraded.toReference(session, before) as Artifact;
    expect(await download(upgraded, session, adopted)).toEqual({ status: 200, text: 'survives identity migration' });
    expect((await download(upgraded, session, before, LEGACY)).status).toBe(403);

    const rolledBack = new ArtifactStore(LEGACY, cache);
    expect(await download(rolledBack, session, before, LEGACY)).toEqual({ status: 200, text: 'survives identity migration' });
  });

  test('replays one record per key once the stable identity rewrites it', () => {
    const cache = join(root, 'dedupe');
    const options = { sessionQualified: true };
    new ArtifactStore(LEGACY, cache).putBytes(session, file('legacy.txt', 'same-key'), Buffer.from('legacy'), 'text/plain', undefined, options);
    const stable = new ArtifactStore(STABLE, cache, { legacyBrokerSources: [LEGACY] });
    stable.putBytes(session, file('stable.txt', 'same-key'), Buffer.from('stable'), 'text/plain', undefined, options);
    expect(stable.sessionQualifiedArtifacts(session).map((artifact) => artifact.name)).toEqual(['stable.txt']);
  });
});

describe('two records written in the same millisecond', () => {
  test('under index pressure, the record just acknowledged is the one kept, downloadable, and replayed after restart', async () => {
    const cache = join(root, 'frozen-clock');
    const session = { tool: 'pi', id: 'owner' };
    const options = { maxIndexBytes: 1_000, maxRecords: 10, sessionReplayLimit: 10 };
    const realNow = Date.now;
    Date.now = () => 1_900_000_000_000;
    try {
      const store = new ArtifactStore('http://persist-collision.test', cache, options);
      store.putBytes(session, file('older-z.txt', 'z'), Buffer.from('older-z'), 'text/plain', undefined, { sessionQualified: true });
      // `a` sorts before `z`: a timestamp-then-key eviction would drop the record it just acknowledged.
      const accepted = store.putBytes(session, file('newer-a.txt', 'a'), Buffer.from('newer-a'), 'text/plain', undefined, { sessionQualified: true });
      const index = JSON.parse(readFileSync(join(cache, 'artifacts', 'index.json'), 'utf8'));
      expect(index.records.map((record: { artifactKey: string }) => record.artifactKey)).toEqual(['a']);
      expect(await download(store, session, accepted, 'http://broker.test')).toEqual({ status: 200, text: 'newer-a' });

      const restarted = new ArtifactStore('http://persist-collision.test', cache, options);
      expect(restarted.sessionQualifiedArtifacts(session).map((artifact) => artifact.artifactKey)).toEqual(['a']);
      expect(await download(restarted, session, accepted, 'http://broker.test')).toEqual({ status: 200, text: 'newer-a' });
    } finally {
      Date.now = realNow;
    }
  });
});

describe('export ingestion', () => {
  test('takes only a regular file inside the export\'s own temp root', () => {
    const store = new ArtifactStore('http://127.0.0.1:7734', join(root, 'export-cache'));
    const tempRoot = mkdtempSync(join(root, 'export-temp-'));
    const outside = mkdtempSync(join(root, 'export-outside-'));
    writeFileSync(join(outside, 'secret.json'), '{"secret":true}');
    const meta = { name: 'x', format: 'json' as const, retentionMs: 60_000 };
    const session = { tool: 'fake', id: 's1' };
    expect(() => store.putExportAttachment(session, meta, join(outside, 'secret.json'), tempRoot)).toThrow('escapes');
    if (process.platform !== 'win32') {
      symlinkSync(join(outside, 'secret.json'), join(tempRoot, 'linked.json'));
      expect(() => store.putExportAttachment(session, meta, join(tempRoot, 'linked.json'), tempRoot)).toThrow('symlink');
    }
    mkdirSync(join(tempRoot, 'inside'));
    writeFileSync(join(tempRoot, 'inside', 'export.json'), '{}');
    expect(store.putExportAttachment(session, meta, join(tempRoot, 'inside', 'export.json'), tempRoot).deliveryClass).toBe('export-attachment');
  });
});

describe('export attachments left by an earlier broker process', () => {
  test('are never served and are swept with their files; other artifacts and other brokers\' exports stay', async () => {
    const cache = join(root, 'export-restart');
    const session = { tool: 'fake', id: 's1' };
    const meta = { name: 'x', format: 'json' as const, retentionMs: 60_000 };
    const exportFile = (text: string): [string, string] => {
      const tempRoot = mkdtempSync(join(root, 'export-restart-temp-'));
      writeFileSync(join(tempRoot, 'export.json'), text);
      return [join(tempRoot, 'export.json'), tempRoot];
    };
    const blobOf = (artifactKey: unknown): string => {
      const index = JSON.parse(readFileSync(join(cache, 'artifacts', 'index.json'), 'utf8'));
      return index.records.find((record: { artifactKey: string }) => record.artifactKey === artifactKey).filePath;
    };

    // Another broker sharing the cache delivered an export first; this one loads its record.
    new ArtifactStore('broker-instance:another_broker_sharing_the_cache_000', cache)
      .putExportAttachment(session, meta, ...exportFile('{"another":"broker"}'));
    const before = new ArtifactStore(STABLE, cache);
    const delivered = before.putExportAttachment(session, meta, ...exportFile('{"earlier":"process"}'));
    const kept = before.putBytes(session, file('kept.txt'), Buffer.from('not an export'), 'text/plain') as Artifact;
    const deliveredBlob = blobOf(delivered.artifactKey);
    const otherBlob = JSON.parse(readFileSync(join(cache, 'artifacts', 'index.json'), 'utf8')).records
      .find((record: { brokerSource: string }) => record.brokerSource !== STABLE).filePath;
    expect(await download(before, session, delivered)).toEqual({ status: 200, text: '{"earlier":"process"}' });

    // The process ended without clearing it (a crash): the next one never serves it, even before its sweep.
    const after = new ArtifactStore(STABLE, cache);
    expect((await download(after, session, delivered)).status).toBe(404);
    expect(after.refreshDownloadTicket(session, String(delivered.artifactKey), { principalId: 'owner', authGeneration: 0 })).toBeUndefined();

    expect(after.sweepStaleExportAttachments()).toBe(1);
    expect(existsSync(deliveredBlob)).toBe(false);
    expect(await download(after, session, kept)).toEqual({ status: 200, text: 'not an export' });
    expect(existsSync(otherBlob)).toBe(true);
    const index = JSON.parse(readFileSync(join(cache, 'artifacts', 'index.json'), 'utf8'));
    expect(index.records.filter((record: { brokerSource: string; deliveryClass?: string }) =>
      record.brokerSource === STABLE && record.deliveryClass === 'export-attachment')).toEqual([]);
    expect(after.sweepStaleExportAttachments()).toBe(0);

    // This process's own export is current, and stays downloadable through its own sweep.
    const fresh = after.putExportAttachment(session, meta, ...exportFile('{"this":"process"}'));
    expect(after.sweepStaleExportAttachments()).toBe(0);
    expect(await download(after, session, fresh)).toEqual({ status: 200, text: '{"this":"process"}' });
  });
});
