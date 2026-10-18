/**
 * The fake release feed is test infrastructure, so its own seams get pinned.
 *
 * A feed that silently always returned the same body would make every
 * "the channel moved mid-operation" assertion below it vacuously true, which is
 * the one failure mode this fixture exists to expose.
 */
import { expect, test } from 'bun:test';
import {
  FEED_SIGNATURE_URL,
  FEED_TRUSTED_KEYS,
  FEED_MANIFEST_URL,
  createFakeReleaseFeed,
  feedUpdater,
  releaseIdFor,
} from './update-release-feed.ts';
import { verifySignedManifest } from '../../src/updates/release-upgrade.ts';
import { desktopClientAssetName } from '../../src/updates/desktop-client-types.ts';

/** Per-host facts shared by the artifact table and the updater block of one release. */
const R1_DESKTOP = { 'linux-x64': { minimumRuntimeVersion: '1.3.8', capabilities: ['prepare', 'client-replace', 'client-relaunch'] } } as const;
const R2_DESKTOP = { 'macos-arm64': { capabilities: ['prepare', 'client-replace', 'client-relaunch'] } } as const;

const releases = [
  {
    name: 'R0',
    version: '1.0.0',
    sourceCommit: 'aaaaaaa',
    publishedAt: '2026-01-01T00:00:00.000Z',
    // A genuine legacy shape: native artifact only, no contract, no web sidecar, no
    // updater block. The published pair rule ties contract and web sidecar together,
    // so a fixture claiming to be old has to be old in the same way.
    jsApp: false,
  },
  {
    name: 'R1',
    version: '1.1.0',
    sourceCommit: 'bbbbbbb',
    publishedAt: '2026-01-02T00:00:00.000Z',
    contract: { revision: 31, minimumClientRevision: 30, surfaceHash: 'fnv1a32:11111111' },
    desktop: R1_DESKTOP,
    updater: feedUpdater({
      version: '1.1.0',
      sourceCommit: 'bbbbbbb',
      clientContract: { revision: 31, minimumBrokerRevision: 30 },
      desktop: R1_DESKTOP,
    }),
  },
  {
    name: 'R2',
    version: '1.2.0',
    sourceCommit: 'ccccccc',
    publishedAt: '2026-01-03T00:00:00.000Z',
    // A current release publishes the broker/web pair together, so it carries a
    // contract identity; only the legacy shape above is allowed to omit both.
    contract: { revision: 32, minimumClientRevision: 31, surfaceHash: 'fnv1a32:22222222' },
    desktop: R2_DESKTOP,
    updater: feedUpdater({ version: '1.2.0', sourceCommit: 'ccccccc', desktop: R2_DESKTOP }),
  },
];

async function json(feed: ReturnType<typeof createFakeReleaseFeed>, url = FEED_MANIFEST_URL) {
  const response = await feed.fetch(url);
  return response.json() as Promise<Record<string, unknown>>;
}
async function bytes(feed: ReturnType<typeof createFakeReleaseFeed>, url: string) {
  return new Uint8Array(await (await feed.fetch(url)).arrayBuffer());
}

test('every fixture release verifies against the fixture trust root', () => {
  const feed = createFakeReleaseFeed({ releases });
  for (const release of feed.releases) {
    expect(verifySignedManifest(JSON.parse(JSON.stringify(release)), FEED_TRUSTED_KEYS).version).toBe(release.version);
  }
  expect(feed.releases.map((release) => release.version)).toEqual(['1.0.0', '1.1.0', '1.2.0']);
});

test('a release published without updater metadata stays without it', async () => {
  const feed = createFakeReleaseFeed({ releases });
  expect(await json(feed)).toHaveProperty('version', '1.0.0');
  expect(feed.current().updater).toBeUndefined();
  expect(feed.current().contract).toBeUndefined();
});

test('per-host desktop artifacts are published only for the hosts a release names', () => {
  const feed = createFakeReleaseFeed({ releases });
  const [r0, r1, r2] = [feed.releases[0]!, feed.releases[1]!, feed.releases[2]!];
  expect(r0.desktopClients).toBeUndefined();
  expect(Object.keys(r1.desktopClients ?? {})).toEqual(['linux-x64']);
  expect(r1.desktopClients?.['linux-x64']?.name).toBe(desktopClientAssetName('linux-x64', '1.1.0'));
  expect(r2.desktopClients?.['macos-arm64']).toBeDefined();
  // A host with no artifact for this release must stay absent rather than borrow another's.
  expect(r2.desktopClients?.['linux-x64']).toBeUndefined();
});

test('the mutable pointer advances between calls, so a plan can watch the channel move', async () => {
  const feed = createFakeReleaseFeed({ releases, promoteAfterRequests: 1 });
  expect((await json(feed)).version).toBe('1.0.0');
  expect((await json(feed)).version).toBe('1.1.0');
  expect((await json(feed)).version).toBe('1.2.0');
  // Promotion sticks at the last release rather than wrapping.
  expect((await json(feed)).version).toBe('1.2.0');
});

test('a promotion between the manifest and its signature produces a mixed pair that fails verification', async () => {
  const feed = createFakeReleaseFeed({ releases });
  const manifest = await json(feed); // resolves R0 under the mutable pointer
  feed.promote(); // the channel promotes while the check sits between its two requests
  const signature = await bytes(feed, FEED_SIGNATURE_URL); // now R1's detached signature
  expect(feed.lastPairMixed()).toBe(true);
  // A reader that pairs them anyway gets a verification failure rather than a mixed
  // release, so the only honest recovery is to rediscover a consistent pair.
  expect(feed.verify(manifest as never, signature)).toBe(false);
  expect(feed.verify(manifest as never, Buffer.from(feed.releases[0]!.signature.value, 'base64'))).toBe(true);
  expect(verifySignedManifest(manifest, FEED_TRUSTED_KEYS).version).toBe('1.0.0');
});

test('an immutable identity still resolves after the mutable pointer has moved on', () => {
  const feed = createFakeReleaseFeed({ releases });
  const pinnedId = releaseIdFor('1.1.0', 'bbbbbbb');
  expect(feed.byReleaseId(pinnedId)?.version).toBe('1.1.0');
  feed.promote();
  feed.promote();
  expect(feed.current().version).toBe('1.2.0');
  // A reviewed plan executes its own release or asks to be replanned; it never follows `latest`.
  expect(feed.byReleaseId(pinnedId)?.version).toBe('1.1.0');
  expect(feed.byReleaseId('rel-9.9.9+zzzzzzz')).toBeUndefined();
});

test('the fixture feed asks for the same two URLs the published channel does', async () => {
  const feed = createFakeReleaseFeed({ releases });
  await json(feed);
  await bytes(feed, FEED_SIGNATURE_URL);
  expect(feed.requests).toEqual({ manifests: 1, signatures: 1, total: 2 });
  expect((await feed.fetch('https://feed.invalid/whatever')).status).toBe(404);
});
