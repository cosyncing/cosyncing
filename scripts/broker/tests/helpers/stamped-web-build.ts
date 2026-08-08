/**
 * A complete, internally consistent stamped web build, small enough to write in a test.
 *
 * Both the release sidecar and the npm package validate a build through the same closed-set checks, so both
 * suites need a build those checks accept. `baseHref` is a parameter so a caller can produce one that is
 * self-consistent in every other respect and differs ONLY in where the shell is mounted — a `/`-mounted
 * build assembled by hand trips a hash check first and proves nothing about the `/cosy/` guard.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import packageJson from '../../../../package.json';
import {
  BROKER_CONTRACT,
  CLIENT_MINIMUM_BROKER_CONTRACT_REVISION,
} from '../../../../packages/typescript/protocol/src/index.ts';
import {
  buildCacheManifest,
  stampWorkerSource,
} from '../../../client/build-web-cache.ts';

const ROOT = resolve(import.meta.dir, '../../../..');
/** The one commit every fixture claims; release-lane validation compares against exactly this. */
export const STAMPED_WEB_FIXTURE_COMMIT = '1'.repeat(40);

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function write(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

export async function writeStampedWebBuild(
  directory: string,
  baseHref: '/cosy/' | '/' = '/cosy/',
): Promise<{ buildVersion: string; sourceCommit: string; version: string }> {
  write(
    join(directory, 'index.html'),
    `<!doctype html><base href="${baseHref}"><title>fixture</title>\n`,
  );
  write(
    join(directory, 'main.dart.js'),
    `compiled fixture ${packageJson.version} ${BROKER_CONTRACT.surfaceHash}\n`,
  );
  write(join(directory, 'assets', 'fixture.txt'), 'precache fixture\n');
  write(join(directory, 'assets', 'NOTICES'), 'release-only licence fixture\n');
  write(join(directory, 'canvaskit', 'canvaskit.wasm'), 'runtime fixture\n');
  const workerSource = readFileSync(join(ROOT, 'apps/client/web/sw.js'), 'utf8');
  write(join(directory, 'sw.js'), workerSource);
  const manifest = await buildCacheManifest(directory);
  write(join(directory, 'sw.js'), stampWorkerSource(workerSource, manifest));
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  write(join(directory, 'cosyncing-cache-manifest.json'), manifestBytes);
  const mainDart = readFileSync(join(directory, 'main.dart.js'));
  const identity = {
    schemaVersion: 1,
    product: 'cosyncing',
    version: packageJson.version,
    sourceCommit: STAMPED_WEB_FIXTURE_COMMIT,
    dirty: false,
    baseHref,
    contract: {
      ...BROKER_CONTRACT,
      clientMinimumBrokerRevision: CLIENT_MINIMUM_BROKER_CONTRACT_REVISION,
    },
    buildId: manifest.buildVersion,
    cacheManifestSha256: sha256(manifestBytes),
    mainDartSha256: sha256(mainDart),
    releaseFiles: {
      'assets/NOTICES': sha256('release-only licence fixture\n'),
    },
  };
  write(
    join(directory, 'cosyncing-build-identity.json'),
    `${JSON.stringify(identity, null, 2)}\n`,
  );
  return {
    buildVersion: manifest.buildVersion,
    sourceCommit: STAMPED_WEB_FIXTURE_COMMIT,
    version: packageJson.version,
  };
}
