#!/usr/bin/env bun
/** Refuse candidate assembly unless the draft release contains exactly the native staging inputs. */
import { resolve } from 'node:path';
import { PRODUCT_IDENTITY } from '../../../packages/typescript/protocol/src/product.ts';
import {
  RELEASE_TARGETS,
  WEB_SIDECAR_NAME,
} from './release-files.ts';

function usage(): never {
  console.error('Usage: bun run scripts/broker/release/verify-staging-assets.ts STAGING_DIRECTORY');
  process.exit(2);
}

export const EXPECTED_STAGING_ASSETS = Object.freeze(
  [
    ...RELEASE_TARGETS.flatMap((target) => {
    const artifact = `${PRODUCT_IDENTITY.releaseAssetPrefix}-${target}`;
    return [artifact, `${artifact}.evidence.json`];
    }),
    WEB_SIDECAR_NAME,
    `${WEB_SIDECAR_NAME}.evidence.json`,
  ].sort(),
);

export function stagingAssetBlockers(directory: string): string[] {
  const actual = [...new Bun.Glob('*').scanSync({ cwd: directory, onlyFiles: true })].sort();
  if (JSON.stringify(actual) === JSON.stringify(EXPECTED_STAGING_ASSETS)) return [];
  return [
    `staging asset set mismatch; expected: ${EXPECTED_STAGING_ASSETS.join(', ')}; actual: ${actual.join(', ')}`,
  ];
}

if (import.meta.main) {
  const directory = process.argv[2] ? resolve(process.argv[2]) : usage();
  const blockers = stagingAssetBlockers(directory);
  if (blockers.length > 0) {
    for (const blocker of blockers) console.error(blocker);
    process.exit(1);
  }
  console.log(`PASS: exact draft staging asset set (${EXPECTED_STAGING_ASSETS.length} files)`);
}
