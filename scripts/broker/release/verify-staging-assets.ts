#!/usr/bin/env bun
/** Refuse candidate assembly unless the draft release contains exactly the JavaScript staging inputs. */
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { assertJavaScriptBroker, exactReleaseFiles } from './javascript-release-policy.ts';
import { RELEASE_JAVASCRIPT_APP_NAME } from '../../../packages/typescript/broker/src/updates/release-upgrade.ts';
import {
  WEB_SIDECAR_NAME,
} from './release-files.ts';

function usage(): never {
  console.error('Usage: bun run scripts/broker/release/verify-staging-assets.ts STAGING_DIRECTORY');
  process.exit(2);
}

export const EXPECTED_STAGING_ASSETS = Object.freeze(
  [
    RELEASE_JAVASCRIPT_APP_NAME,
    `${RELEASE_JAVASCRIPT_APP_NAME}.evidence.json`,
    WEB_SIDECAR_NAME,
    `${WEB_SIDECAR_NAME}.evidence.json`,
  ].sort(),
);

export function stagingAssetBlockers(directory: string): string[] {
  try {
    exactReleaseFiles(directory, EXPECTED_STAGING_ASSETS);
    assertJavaScriptBroker(readFileSync(resolve(directory, RELEASE_JAVASCRIPT_APP_NAME)));
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
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
