#!/usr/bin/env bun
/** Refuse stable promotion unless the prerelease has exactly the signed release asset set. */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { PRODUCT_IDENTITY } from '../../../packages/typescript/protocol/src/product.ts';
import {
  RELEASE_JAVASCRIPT_APP_NAME,
  verifyReleaseManifest,
  verifyReleasePairing,
} from '../../../packages/typescript/broker/src/updates/release-upgrade.ts';
import {
  BOOTSTRAP_TEMPLATES,
  CLIENT_HOSTS,
  P256_DER_SIGNATURE_SUFFIX,
  P256_PUBLIC_KEY_NAME,
  P256_SIGNATURE_SUFFIX,
  RELEASE_TARGETS,
  WEB_SIDECAR_NAME,
  parseRenderedClientTable,
  type ClientHost,
} from './release-files.ts';

function usage(): never {
  console.error('Usage: bun run scripts/broker/release/verify-promotion-assets.ts [--candidate] RELEASE_DIRECTORY');
  process.exit(2);
}

const artifacts = RELEASE_TARGETS.map((target) => `${PRODUCT_IDENTITY.releaseAssetPrefix}-${target}`);
export const EXPECTED_CANDIDATE_ASSETS = Object.freeze([
  ...artifacts,
  ...artifacts.flatMap((name) => [`${name}.intoto.jsonl`, `${name}.intoto.jsonl.sig`]),
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
  const actual = [...new Bun.Glob('*').scanSync({ cwd: directory, onlyFiles: true })].sort();
  if (JSON.stringify(actual) === JSON.stringify(expected)) return [];
  return [`${label} asset set mismatch; expected: ${expected.join(', ')}; actual: ${actual.join(', ')}`];
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
    const verified = verifyReleaseManifest({
      value: manifest,
      target: RELEASE_TARGETS[0],
      trustedKeys: { [keyId]: publicKey },
    });
    const pairing = verifyReleasePairing(verified.manifest);
    const webPath = resolve(directory, pairing.webApp.name);
    const webBytes = readFileSync(webPath);
    const digest = createHash('sha256').update(webBytes).digest('hex');
    if (statSync(webPath).size !== pairing.webApp.size
        || digest !== pairing.webApp.sha256) {
      return ['signed web sidecar size or digest does not match the candidate'];
    }
    const jsPath = resolve(directory, pairing.jsApp.name);
    const jsBytes = readFileSync(jsPath);
    if (statSync(jsPath).size !== pairing.jsApp.size
        || createHash('sha256').update(jsBytes).digest('hex') !== pairing.jsApp.sha256) {
      return ['signed JavaScript application size or digest does not match the candidate'];
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
  if (blockers.length > 0) {
    for (const blocker of blockers) console.error(blocker);
    process.exit(1);
  }
  const expected = (candidateOnly ? EXPECTED_CANDIDATE_ASSETS : EXPECTED_PROMOTION_ASSETS).length
    + Object.keys(CLIENT_HOSTS).length;
  console.log(`PASS: exact ${candidateOnly ? 'candidate' : 'promotion'} asset set (${expected} files)`);
}
