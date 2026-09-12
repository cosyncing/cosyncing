#!/usr/bin/env bun
/** Refuse stable promotion unless the prerelease has exactly the signed release asset set. */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertJavaScriptBroker, exactReleaseFiles } from './javascript-release-policy.ts';
import {
  RELEASE_JAVASCRIPT_APP_NAME,
  verifySignedManifest,
  verifyReleasePairing,
} from '../../../packages/typescript/broker/src/updates/release-upgrade.ts';
import {
  BOOTSTRAP_TEMPLATES,
  CLIENT_HOSTS,
  P256_DER_SIGNATURE_SUFFIX,
  P256_PUBLIC_KEY_NAME,
  P256_SIGNATURE_SUFFIX,
  WEB_SIDECAR_NAME,
  parseRenderedClientTable,
  clientAssetName,
  type ClientHost,
} from './release-files.ts';

function usage(): never {
  console.error('Usage: bun run scripts/broker/release/verify-promotion-assets.ts [--candidate] RELEASE_DIRECTORY --version X.Y.Z --commit HEX');
  process.exit(2);
}

export const EXPECTED_CANDIDATE_ASSETS = Object.freeze([
  RELEASE_JAVASCRIPT_APP_NAME,
  `${RELEASE_JAVASCRIPT_APP_NAME}.intoto.jsonl`,
  `${RELEASE_JAVASCRIPT_APP_NAME}.intoto.jsonl.sig`,
  WEB_SIDECAR_NAME,
  `${WEB_SIDECAR_NAME}.intoto.jsonl`,
  `${WEB_SIDECAR_NAME}.intoto.jsonl.sig`,
  'release-manifest.json',
  'release-manifest.json.sig',
  `release-manifest.json${P256_SIGNATURE_SUFFIX}`,
  `release-manifest.json${P256_DER_SIGNATURE_SUFFIX}`,
  'release-key.pem',
  P256_PUBLIC_KEY_NAME,
  'software-inventory.json',
  'software-bom.spdx.json',
  'LICENSE',
  'NOTICE',
  'THIRD_PARTY_NOTICES.txt',
  // Every installer, from the names the assembler renders. Listed from BOOTSTRAP_TEMPLATES rather than
  // typed out, so a fifth installer joins the exact-set check by existing — the point of an exact set is
  // that a forgotten line fails promotion, and a hand-maintained copy of the list can forget one too.
  ...Object.keys(BOOTSTRAP_TEMPLATES),
  'SHA256SUMS',
  'SHA256SUMS.sig',
  `SHA256SUMS${P256_SIGNATURE_SUFFIX}`,
  `SHA256SUMS${P256_DER_SIGNATURE_SUFFIX}`,
].sort());
export const EXPECTED_PROMOTION_ASSETS = Object.freeze([
  ...EXPECTED_CANDIDATE_ASSETS,
].sort());

function exactAssetSetBlocker(directory: string, expected: readonly string[], label: string): string[] {
  try {
    exactReleaseFiles(directory, expected);
    return [];
  } catch (error) {
    return [`${label}: ${error instanceof Error ? error.message : String(error)}`];
  }
}

/**
 * The desktop client assets this directory is expected to hold, resolved from the directory itself.
 *
 * They cannot be named in the fixed list above: a client asset carries the release version and, for the
 * unsigned macOS and Windows builds, a suffix saying so. What IS fixed is the shape — one artifact per
 * host in {@link CLIENT_HOSTS}, named for this release's version, with that host's archive extension — so
 * a stray second client fails the "exactly one" rule and anything else fails the exact-set check around
 * it. `version` comes from the manifest rather than from this checkout, because the thing being verified
 * is a downloaded release directory.
 */
function resolveExpectedClientAssets(
  directory: string,
  version: string,
): { names: string[]; blockers: string[] } {
  const names: string[] = [];
  const blockers: string[] = [];
  for (const [host, extension] of Object.entries(CLIENT_HOSTS) as Array<[ClientHost, string]>) {
    const prefix = `cosyncing-client-${version}-${host}`;
    const matches = [...new Bun.Glob(`${prefix}*${extension}`)
      .scanSync({ cwd: directory, onlyFiles: true })].sort();
    if (matches.length !== 1) {
      blockers.push(
        `expected exactly one ${host} client asset matching ${prefix}*${extension}, found ${matches.length}`,
      );
      continue;
    }
    if (matches[0] !== clientAssetName(host, version)) {
      blockers.push(`unexpected desktop client asset: ${matches[0]}`);
      continue;
    }
    names.push(matches[0]!);
  }
  return { names, blockers };
}

/**
 * The clients the published directory holds must be the clients its installers promise.
 *
 * A client is not in the signed manifest, so the two statements about it are the signed checksum list and
 * the digest baked into each rendered installer. This asserts they agree with the bytes and with each
 * other — including across the four installers, which are rendered from one table and must therefore all
 * name the same client for a host.
 */
function clientPinBlockers(directory: string, names: readonly string[]): string[] {
  const blockers: string[] = [];
  const checksums = new Map(
    readFileSync(resolve(directory, 'SHA256SUMS'), 'utf8').split('\n')
      .filter((row) => row.trim() !== '')
      .map((row) => row.trim().split(/\s+/))
      .map(([digest, name]) => [name ?? '', digest ?? '']),
  );
  let reference = '';
  for (const installer of Object.keys(BOOTSTRAP_TEMPLATES).sort()) {
    let rendered: string;
    try {
      rendered = parseRenderedClientTable(readFileSync(resolve(directory, installer), 'utf8'))
        .map((client) => `${client.host} ${client.name} ${client.sha256} ${client.size}`)
        .sort()
        .join('\n');
    } catch (error) {
      blockers.push(`${installer}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (reference === '') reference = rendered;
    else if (rendered !== reference) blockers.push(`${installer} pins a different client set`);
  }
  if (blockers.length > 0) return blockers;
  const pinned = new Map(reference.split('\n').map((row) => {
    const [, name, digest, size] = row.split(' ');
    return [name ?? '', { digest: digest ?? '', size: Number(size ?? '-1') }];
  }));
  for (const name of names) {
    const pin = pinned.get(name);
    if (!pin) {
      blockers.push(`the installers do not pin the published client ${name}`);
      continue;
    }
    const bytes = readFileSync(resolve(directory, name));
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== pin.digest || bytes.byteLength !== pin.size) {
      blockers.push(`client ${name} does not match the digest the installers carry`);
    }
    if (checksums.get(name) !== digest) {
      blockers.push(`client ${name} is missing from the signed checksum list or disagrees with it`);
    }
  }
  return blockers;
}

function signedPairingBlockers(directory: string): string[] {
  try {
    const manifest = JSON.parse(
      readFileSync(resolve(directory, 'release-manifest.json'), 'utf8'),
    );
    const publicKey = readFileSync(
      resolve(directory, 'release-key.pem'),
      'utf8',
    );
    const keyId = manifest?.signature?.keyId;
    if (typeof keyId !== 'string') return ['release signing key id is missing'];
    const verified = verifySignedManifest(manifest, { [keyId]: publicKey });
    if (verified.artifacts.length !== 0) return ['JavaScript release must not describe native broker artifacts'];
    const pairing = verifyReleasePairing(verified);
    const webPath = resolve(directory, pairing.webApp.name);
    const webBytes = readFileSync(webPath);
    const digest = createHash('sha256').update(webBytes).digest('hex');
    if (statSync(webPath).size !== pairing.webApp.size
        || digest !== pairing.webApp.sha256) {
      return ['signed web sidecar size or digest does not match the candidate'];
    }
    const jsPath = resolve(directory, pairing.jsApp.name);
    const jsBytes = readFileSync(jsPath);
    assertJavaScriptBroker(jsBytes);
    if (statSync(jsPath).size !== pairing.jsApp.size
        || createHash('sha256').update(jsBytes).digest('hex') !== pairing.jsApp.sha256) {
      return ['signed JavaScript application size or digest does not match the candidate'];
    }
    for (const [name, digest, contract, buildType] of [
      [pairing.jsApp.name, pairing.jsApp.sha256, pairing.contract, 'bun-bundle'],
      [pairing.webApp.name, pairing.webApp.sha256, pairing.contract, 'flutter-web-sidecar'],
    ] as const) {
      const statement = JSON.parse(readFileSync(resolve(directory, `${name}.intoto.jsonl`), 'utf8'));
      const definition = statement?.predicate?.buildDefinition;
      const parameters = definition?.externalParameters;
      const evidenceContract = parameters?.contract;
      if (statement?.subject?.length !== 1 || statement.subject[0].name !== name
          || statement.subject[0].digest?.sha256 !== digest
          || definition?.buildType !== `https://cosyncing.dev/build/${buildType}/v1`
          || parameters?.version !== verified.version
          || definition?.resolvedDependencies?.[0]?.digest?.gitCommit !== verified.sourceCommit
          || evidenceContract?.revision !== contract.revision
          || evidenceContract?.minimumClientRevision !== contract.minimumClientRevision
          || evidenceContract?.surfaceHash !== contract.surfaceHash
          || (name === pairing.jsApp.name && (parameters?.distribution !== 'bootstrap-js'
            || parameters?.target !== 'universal'
            || parameters?.minimumBunVersion !== pairing.jsApp.minimumBunVersion))) {
        return [`signed provenance disagrees with the broker/web manifest: ${name}`];
      }
    }
    return [];
  } catch (error) {
    return [
      `signed broker/web pairing is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }
}

function signatureAndChecksumBlockers(directory: string, expected: readonly string[]): string[] {
  try {
    const read = (name: string) => readFileSync(resolve(directory, name));
    const key = createPublicKey(read('release-key.pem'));
    const p256 = createPublicKey(read(P256_PUBLIC_KEY_NAME));
    if (key.asymmetricKeyType !== 'ed25519' || p256.asymmetricKeyType !== 'ec'
        || p256.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('release key algorithms are invalid');
    for (const name of ['release-manifest.json', 'SHA256SUMS',
      `${RELEASE_JAVASCRIPT_APP_NAME}.intoto.jsonl`, `${WEB_SIDECAR_NAME}.intoto.jsonl`]) {
      if (!verify(null, read(name), key, read(`${name}.sig`))) throw new Error(`invalid signature: ${name}`);
    }
    for (const name of ['release-manifest.json', 'SHA256SUMS']) {
      for (const [suffix, dsaEncoding] of [[P256_SIGNATURE_SUFFIX, 'ieee-p1363'], [P256_DER_SIGNATURE_SUFFIX, 'der']] as const) {
        if (!verify('sha256', read(name), { key: p256, dsaEncoding }, read(`${name}${suffix}`))) {
          throw new Error(`invalid signature: ${name}${suffix}`);
        }
      }
    }
    const rows = read('SHA256SUMS').toString('utf8').trimEnd().split('\n');
    const names: string[] = [];
    for (const row of rows) {
      const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(row);
      if (!match || !expected.includes(match[2]!)) throw new Error('invalid checksum row');
      names.push(match[2]!);
      if (createHash('sha256').update(read(match[2]!)).digest('hex') !== match[1]) {
        throw new Error(`checksum mismatch: ${match[2]}`);
      }
    }
    const covered = expected.filter((name) => !name.startsWith('SHA256SUMS')).sort();
    if (JSON.stringify(names.sort()) !== JSON.stringify(covered)) throw new Error('checksum inventory is not exact');
    return [];
  } catch (error) {
    return [`signed release integrity is invalid: ${error instanceof Error ? error.message : String(error)}`];
  }
}

/** The manifest's own version, or '' when the directory has no readable manifest. */
function publishedVersion(directory: string): string {
  try {
    const manifest = JSON.parse(readFileSync(resolve(directory, 'release-manifest.json'), 'utf8'));
    return typeof manifest?.version === 'string' ? manifest.version : '';
  } catch {
    return '';
  }
}

function assetBlockers(directory: string, label: 'candidate' | 'promotion'): string[] {
  const version = publishedVersion(directory);
  if (version === '') return [`${label} release manifest is missing or states no version`];
  const clients = resolveExpectedClientAssets(directory, version);
  if (clients.blockers.length > 0) return clients.blockers;
  const expected = [
    ...(label === 'candidate' ? EXPECTED_CANDIDATE_ASSETS : EXPECTED_PROMOTION_ASSETS),
    ...clients.names,
  ].sort();
  const blockers = exactAssetSetBlocker(directory, expected, label);
  if (blockers.length > 0) return blockers;
  const pairing = signedPairingBlockers(directory);
  if (pairing.length > 0) return pairing;
  const integrity = signatureAndChecksumBlockers(directory, expected);
  if (integrity.length > 0) return integrity;
  return clientPinBlockers(directory, clients.names);
}

export function candidateAssetBlockers(directory: string): string[] {
  return assetBlockers(directory, 'candidate');
}

export function promotionAssetBlockers(directory: string): string[] {
  return assetBlockers(directory, 'promotion');
}

if (import.meta.main) {
  const candidateOnly = process.argv[2] === '--candidate';
  const directoryArg = candidateOnly ? process.argv[3] : process.argv[2];
  const directory = directoryArg ? resolve(directoryArg) : usage();
  const blockers = candidateOnly ? candidateAssetBlockers(directory) : promotionAssetBlockers(directory);
  // The workflow supplies the checked-out tag's identity; a valid signature on another release is insufficient.
  const versionIndex = process.argv.indexOf('--version');
  const commitIndex = process.argv.indexOf('--commit');
  if (versionIndex < 0 || commitIndex < 0) usage();
  try {
    const manifest = JSON.parse(readFileSync(resolve(directory, 'release-manifest.json'), 'utf8'));
    if (!process.argv[versionIndex + 1] || !process.argv[commitIndex + 1]
        || manifest.version !== process.argv[versionIndex + 1]
        || manifest.sourceCommit !== process.argv[commitIndex + 1]) blockers.push('release does not match the expected tag identity');
  } catch { blockers.push('release identity is unreadable'); }
  if (blockers.length > 0) {
    for (const blocker of blockers) console.error(blocker);
    process.exit(1);
  }
  const expected = (candidateOnly ? EXPECTED_CANDIDATE_ASSETS : EXPECTED_PROMOTION_ASSETS).length
    + Object.keys(CLIENT_HOSTS).length;
  console.log(`PASS: exact ${candidateOnly ? 'candidate' : 'promotion'} asset set (${expected} files)`);
}
