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
  P256_PUBLIC_KEY_NAME,
  P256_SIGNATURE_SUFFIX,
  RELEASE_TARGETS,
  WEB_SIDECAR_NAME,
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
  'release-key.pem',
  P256_PUBLIC_KEY_NAME,
  'software-inventory.json',
  'software-bom.spdx.json',
  'LICENSE',
  'NOTICE',
  'THIRD_PARTY_NOTICES.txt',
  'install.sh',
  'SHA256SUMS',
  'SHA256SUMS.sig',
  `SHA256SUMS${P256_SIGNATURE_SUFFIX}`,
].sort());
export const EXPECTED_PROMOTION_ASSETS = Object.freeze([
  ...EXPECTED_CANDIDATE_ASSETS,
].sort());

function exactAssetSetBlocker(directory: string, expected: readonly string[], label: string): string[] {
  const actual = [...new Bun.Glob('*').scanSync({ cwd: directory, onlyFiles: true })].sort();
  if (JSON.stringify(actual) === JSON.stringify(expected)) return [];
  return [`${label} asset set mismatch; expected: ${expected.join(', ')}; actual: ${actual.join(', ')}`];
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

export function candidateAssetBlockers(directory: string): string[] {
  const blockers = exactAssetSetBlocker(
    directory,
    EXPECTED_CANDIDATE_ASSETS,
    'candidate',
  );
  if (blockers.length > 0) return blockers;
  return signedPairingBlockers(directory);
}

export function promotionAssetBlockers(directory: string): string[] {
  const blockers = exactAssetSetBlocker(directory, EXPECTED_PROMOTION_ASSETS, 'promotion');
  if (blockers.length > 0) return blockers;
  return signedPairingBlockers(directory);
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
  const expected = candidateOnly ? EXPECTED_CANDIDATE_ASSETS : EXPECTED_PROMOTION_ASSETS;
  console.log(`PASS: exact ${candidateOnly ? 'candidate' : 'promotion'} asset set (${expected.length} files)`);
}
