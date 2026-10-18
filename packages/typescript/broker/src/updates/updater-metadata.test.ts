/**
 * The additive `updater` block on the signed release manifest.
 *
 * The interesting property is not that a new reader can read it -- it is that a
 * reader from before it existed keeps working on a manifest that carries it, and
 * that a release which never described an in-app update can never be read as
 * having described one. Both are proven against the frozen 0.6.4 reader body
 * rather than against a mock of it.
 */
import { expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, sign, verify as verifySignature } from 'node:crypto';
import { PRODUCT_IDENTITY } from '@cosyncing/protocol';
import {
  RELEASE_JAVASCRIPT_APP_NAME,
  RELEASE_JAVASCRIPT_APP_TARGET,
  releaseManifestForTests,
  releaseManifestSigningPayload,
  verifySignedManifest,
  type ReleaseArtifact,
  type ReleaseManifest,
} from './release-upgrade.ts';
import {
  compareReleaseVersions,
  parseReleaseUpdaterMetadata,
  satisfiesMinimum,
  type ReleaseUpdaterMetadata,
} from './updater-metadata.ts';
import {
  legacyReleaseManifestSigningPayload,
  legacyVerifySignedManifest,
} from '../../test/helpers/legacy-064-release-manifest.ts';

const keyPair = generateKeyPairSync('ed25519');
const keyId = 'test-updater-key';
const publicPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const trustedKeys = { [keyId]: publicPem };
const artifact: ReleaseArtifact = {
  name: `${PRODUCT_IDENTITY.releaseAssetPrefix}-linux-x64`,
  target: 'linux-x64',
  platform: 'linux',
  arch: 'x64',
  size: 4_096,
  sha256: 'a'.repeat(64),
  url: 'https://releases.example/cosyncing',
  provenanceUrl: 'https://releases.example/cosyncing.intoto.jsonl',
};
const pair = {
  revision: 30,
  minimumClientRevision: 17,
  surfaceHash: `fnv1a32:${'b'.repeat(8)}`,
};
const webApp = {
  name: 'cosyncing-web-app.tar.gz',
  mount: '/cosy/' as const,
  size: 1_024,
  sha256: '1'.repeat(64),
  url: 'https://releases.example/cosyncing-web-app.tar.gz',
  buildId: 'c'.repeat(16),
  cacheManifestSha256: '2'.repeat(64),
  mainDartSha256: '3'.repeat(64),
  directorySha256: '4'.repeat(64),
  fileCount: 10,
};
const jsApp = {
  name: RELEASE_JAVASCRIPT_APP_NAME,
  target: RELEASE_JAVASCRIPT_APP_TARGET,
  size: 8_192,
  sha256: 'd'.repeat(64),
  url: 'https://releases.example/cosyncing-app.js',
  provenanceUrl: 'https://releases.example/cosyncing-app.js.intoto.jsonl',
  minimumBunVersion: '1.3.8',
};

const updater: ReleaseUpdaterMetadata = {
  schemaVersion: 1,
  releaseId: 'rel-1.1.0+abcdefa',
  managementContractVersion: 1,
  minimumHelperVersion: '1.4.0',
  clientContract: { revision: 31, minimumBrokerRevision: 30, surfaceHash: `fnv1a32:${'e'.repeat(8)}` },
  desktop: { 'linux-x64': { minimumRuntimeVersion: '1.3.8', stagingBytes: 268_435_456, capabilities: ['prepare', 'client-replace', 'client-relaunch'] } },
  safeDowngrade: true,
};

function manifest(options: { updater?: unknown } = {}): ReleaseManifest {
  return releaseManifestForTests({
    version: '1.1.0',
    sourceCommit: 'abcdefa',
    publishedAt: '2026-01-10T12:00:00.000Z',
    artifact,
    keyId,
    sign: (payload) => sign(null, payload, keyPair.privateKey),
    contract: pair,
    webApp,
    jsApp,
    ...(options.updater === undefined ? {} : { updater: options.updater as ReleaseUpdaterMetadata }),
  });
}

test('a manifest without the block verifies and stays byte-identical to the pre-feature shape', () => {
  const value = manifest();
  expect(value.updater).toBeUndefined();
  expect(verifySignedManifest(JSON.parse(JSON.stringify(value)), trustedKeys).version).toBe('1.1.0');
});

test('a reader from before the block existed verifies a manifest that carries it', () => {
  const value = manifest({ updater });
  // The 0.6.4 verifier is a frozen copy of that release's parser and signature
  // payload, so this is the deployed old reader, not an approximation of one.
  const legacy = legacyVerifySignedManifest(JSON.parse(JSON.stringify(value)), trustedKeys);
  expect(legacy.version).toBe('1.1.0');
  // Both readers sign the same canonical bytes, unknown key included, so an old
  // client that ignores the block still rejects a tampered one.
  const { signature: _signature, ...unsigned } = value;
  expect(releaseManifestSigningPayload(unsigned)).toEqual(legacyReleaseManifestSigningPayload(unsigned));
});

test('a tampered updater block breaks the signature an old reader would still accept', () => {
  const value = manifest({ updater });
  const tampered = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  (tampered.updater as Record<string, unknown>).minimumHelperVersion = '0.0.1';
  expect(() => verifySignedManifest(tampered, trustedKeys)).toThrow('release-manifest-signature-invalid');
});

test('a malformed block is a verification failure and never degrades to an absent one', () => {
  const malformed = [
    { ...updater, releaseId: '' },
    { ...updater, releaseId: 'has space' },
    { ...updater, managementContractVersion: 0 },
    { ...updater, minimumHelperVersion: 'latest' },
    { ...updater, desktop: { 'linux-x64': { capabilities: ['arbitrary-shell-command'] } } },
    { ...updater, desktop: { 'windows-arm64': { capabilities: ['prepare'] } } },
    { ...updater, clientContract: { revision: 5, minimumBrokerRevision: 9 } },
    { ...updater, schemaVersion: 0 },
  ];
  for (const block of malformed) {
    expect(() => parseReleaseUpdaterMetadata(block)).toThrow('release-updater-metadata-invalid');
    expect(() => verifySignedManifest(JSON.parse(JSON.stringify(
      releaseManifestForTests({
        version: '1.1.0', sourceCommit: 'abcdefa', publishedAt: '2026-01-10T12:00:00.000Z',
        artifact, keyId, sign: (payload) => sign(null, payload, keyPair.privateKey),
        contract: pair, webApp, jsApp, updater: block as ReleaseUpdaterMetadata,
      }),
    )), trustedKeys)).toThrow('release-updater-metadata-invalid');
  }
});

test('a newer schema version is carried through as unreadable rather than rejected outright', () => {
  // Refusing the whole manifest would be worse than the feature never existing: the
  // broker half is still installable, and only the in-app plan needs to be refused.
  const block = parseReleaseUpdaterMetadata({ ...updater, schemaVersion: 2 });
  expect(block).toEqual({ schemaVersion: 2, unsupported: true });
  const value = releaseManifestForTests({
    version: '1.1.0', sourceCommit: 'abcdefa', publishedAt: '2026-01-10T12:00:00.000Z',
    artifact, keyId, sign: (payload) => sign(null, payload, keyPair.privateKey),
    contract: pair, webApp, jsApp, updater: block as ReleaseUpdaterMetadata,
  });
  expect(verifySignedManifest(JSON.parse(JSON.stringify(value)), trustedKeys).updater).toEqual({
    schemaVersion: 2, unsupported: true,
  });
});

test('an unknown key inside a known schema is dropped rather than trusted', () => {
  const block = parseReleaseUpdaterMetadata({ ...updater, autoApplyOnIdle: true }) as ReleaseUpdaterMetadata;
  expect(Object.keys(block)).not.toContain('autoApplyOnIdle');
});

test('the parser keeps only what it validated, so a feed cannot smuggle a path or URL through', () => {
  const block = parseReleaseUpdaterMetadata({
    ...updater,
    desktop: { 'linux-x64': { capabilities: ['prepare'], installPath: '/usr/bin', url: 'https://evil.example/x' } },
  }) as ReleaseUpdaterMetadata;
  expect(block.desktop?.['linux-x64']).toEqual({ capabilities: ['prepare'] });
});

test('runtime floors compare with the same rules the channel probe uses', () => {
  expect(compareReleaseVersions('1.10.0', '1.9.9')).toBe(1);
  expect(compareReleaseVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
  expect(compareReleaseVersions('1.0.0', '1.0.0')).toBe(0);
  expect(satisfiesMinimum('1.3.14', '1.3.8')).toBe(true);
  expect(satisfiesMinimum('1.3.0', '1.3.8')).toBe(false);
  // An unreadable or absent runtime never clears a floor; guessing here is how a
  // swap ends up reporting success while taking the service down.
  expect(satisfiesMinimum(undefined, '1.3.8')).toBe(false);
  expect(satisfiesMinimum('unknown', '1.3.8')).toBe(false);
  expect(satisfiesMinimum('1.0.0', undefined)).toBe(true);
});

test('the block stays inside the signature the release assembly already produces', () => {
  const value = manifest({ updater });
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  expect(bytes.length).toBeLessThan(256 * 1024);
  expect(createHash('sha256').update(bytes).digest('hex')).toHaveLength(64);
  const { signature, ...unsigned } = value;
  expect(verifySignature(null, releaseManifestSigningPayload(unsigned), publicPem,
    Buffer.from(signature.value, 'base64'))).toBe(true);
});
