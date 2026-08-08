#!/usr/bin/env bun
/**
 * Stamps the static-cache service worker in a finished Flutter web build (N3).
 *
 * `apps/client/web/sw.js` is the version-controlled source; `flutter build web`
 * copies it verbatim into `build/web/`. This script replaces its three
 * placeholders with the manifest computed from what the build actually
 * produced, and writes an auditable copy of that manifest next to it.
 *
 * Run automatically by `bun run client:build:web`. Running it against a build
 * directory that has already been stamped is a no-op error rather than a silent
 * double-substitution: the placeholders are gone, so it reports and exits 1.
 *
 *   bun run scripts/client/build-web-cache.ts [--build-dir <dir>] [--quiet]
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import packageJson from '../../package.json';
import {
  BROKER_CONTRACT,
  CLIENT_MINIMUM_BROKER_CONTRACT_REVISION,
} from '../../packages/typescript/protocol/src/index.ts';
import { CLIENT_ROOT } from './run-client-command.ts';

/**
 * Files precached atomically at install: everything carrying application
 * identity. Kept small and exact — this set is downloaded in one `addAll`, and
 * one failure aborts the whole install (which is what prevents a mixed-version
 * app).
 */
const PRECACHE_FILES: readonly string[] = [
  'index.html',
  'flutter_bootstrap.js',
  'flutter.js',
  'main.dart.js',
  'manifest.json',
  'favicon.ico',
  'favicon.svg',
  'version.json',
];

/** Directories whose whole contents belong to the atomic precache set. */
const PRECACHE_DIRECTORIES: readonly string[] = ['icons/', 'assets/'];

/**
 * Large immutable engine/runtime binaries. Listed in the manifest — so the
 * worker's allowlist is closed — but fetched lazily into the same
 * version-scoped cache instead of at install time. Precaching every CanvasKit
 * and Skwasm variant would mean ~40 MB per install, almost all of it for
 * renderers this browser will never select.
 */
const RUNTIME_DIRECTORIES: readonly string[] = ['canvaskit/'];
const RUNTIME_FILES: readonly string[] = ['sqlite3.wasm', 'drift_worker.js'];

/**
 * Shipped files that must stay outside the service-worker cache.
 *
 * They are hashed into the build identity and copied into the release sidecar,
 * but are fetched from the broker only when their dedicated surface needs
 * them. Keeping this list separate prevents "not cached" from silently
 * becoming "not released".
 */
export const RELEASE_UNCACHED_FILES: readonly string[] = ['assets/NOTICES'];

/**
 * Never cached, never listed, regardless of which set would otherwise claim
 * them.
 *
 * - `.symbols` / `.map`: multi-megabyte debug artefacts with no runtime role.
 * - `assets/NOTICES`: release-only licence text, bound separately above.
 * - `flutter_service_worker.js`: Flutter's deprecated unregister-only stub.
 *   Caching the script that deletes workers would be actively harmful.
 * - `drift_worker.dart` / `.last_build_id`: build bookkeeping, not served.
 * - `sw.js` itself: the browser owns service-worker script updates; a cached
 *   copy of the worker is how an app pins itself to a dead version forever.
 */
const EXCLUDED_SUFFIXES: readonly string[] = ['.symbols', '.map', '.dart'];
const EXCLUDED_FILES: readonly string[] = [
  'sw.js',
  'flutter_service_worker.js',
  'assets/NOTICES',
  '.last_build_id',
  'cosyncing-cache-manifest.json',
  'cosyncing-build-identity.json',
];

/**
 * Runtime routes that must never appear in the manifest.
 *
 * The worker's scope already excludes them (it is registered under the app's
 * base href, and the broker mounts its API at the origin root), and its fetch
 * handler refuses them again. This is the third, build-time check: if a future
 * build ever emits something under one of these prefixes into the web output,
 * the build fails here rather than shipping a worker that could cache it.
 */
const FORBIDDEN_MANIFEST_PREFIXES: readonly string[] = [
  'api/',
  'v1/',
  'pi/',
  'claude/hook/',
  'ws/',
];

const PLACEHOLDER_VERSION = '__COSYNCING_BUILD_VERSION__';
const PLACEHOLDER_PRECACHE = '__COSYNCING_PRECACHE_URLS__';
const PLACEHOLDER_RUNTIME = '__COSYNCING_RUNTIME_URLS__';
const PLACEHOLDER_HASHES = '__COSYNCING_ASSET_HASHES__';

interface CacheManifest {
  readonly buildVersion: string;
  readonly precache: readonly string[];
  readonly runtime: readonly string[];
  /** SHA-256 of every cached file, keyed by manifest path. */
  readonly hashes: Readonly<Record<string, string>>;
  readonly precacheBytes: number;
  readonly runtimeBytes: number;
}

export interface WebBuildIdentity {
  readonly schemaVersion: 1;
  readonly product: 'cosyncing';
  readonly version: string;
  readonly sourceCommit: string;
  readonly dirty: boolean;
  readonly baseHref: '/cosy/';
  readonly contract: {
    readonly revision: number;
    readonly minimumClientRevision: number;
    readonly clientMinimumBrokerRevision: number;
    readonly surfaceHash: string;
  };
  readonly buildId: string;
  readonly cacheManifestSha256: string;
  readonly mainDartSha256: string;
  /** Hashes of shipped files deliberately excluded from the worker cache. */
  readonly releaseFiles: Readonly<Record<string, string>>;
}

/** Git provenance compiled into and stamped alongside one web build. */
export interface WebSourceIdentity {
  readonly sourceCommit: string;
  readonly dirty: boolean;
}

function argValue(name: string): string | undefined {
  const index = Bun.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : Bun.argv[index + 1];
}

/** Lists every file under `dir`, as `/`-separated paths relative to it. */
async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(dir, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relPath = prefix === '' ? entry.name : `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(dir, `${relPath}/`)));
    } else if (entry.isFile()) {
      files.push(relPath);
    }
  }
  return files;
}

function isExcluded(path: string): boolean {
  if (EXCLUDED_FILES.includes(path)) return true;
  return EXCLUDED_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

function inAnyDirectory(path: string, directories: readonly string[]): boolean {
  return directories.some((directory) => path.startsWith(directory));
}

function classify(path: string): 'precache' | 'runtime' | 'skip' {
  if (isExcluded(path)) return 'skip';
  if (PRECACHE_FILES.includes(path)) return 'precache';
  if (inAnyDirectory(path, PRECACHE_DIRECTORIES)) return 'precache';
  if (RUNTIME_FILES.includes(path)) return 'runtime';
  if (inAnyDirectory(path, RUNTIME_DIRECTORIES)) return 'runtime';
  return 'skip';
}

/**
 * Strips comments so a source check reads code, not prose.
 *
 * `sw.js` documents at length why it does NOT call `skipWaiting`, and
 * `index.html` documents the same about the handoff coordinator. A naive scan
 * would match those explanations and refuse every build, which is how a
 * fail-proof gets deleted instead of fixed. Deliberately conservative: it
 * removes block comments and line-comment tails and leaves string literals
 * alone, so at worst it fails closed on a URL containing a double slash.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => {
      const marker = line.indexOf('//');
      return marker === -1 ? line : line.slice(0, marker);
    })
    .join('\n');
}

/**
 * Refuses to stamp a worker that could activate over a live page (N3, N3b).
 *
 * `skipWaiting` is the single call that turns the whole coherence model off: it
 * promotes a new worker over documents still executing the previous build's
 * `main.dart.js`, and the activate handler then deletes the cache those
 * documents are reading from. N3b removes the need for a user to close tabs; it
 * does not make this call safe, and the automatic handoff would quietly become
 * pointless if a future edit reintroduced it. A runtime test proves the handler
 * never calls it; this proves the call is not in the shipped bytes at all.
 */
export function assertNoSkipWaiting(workerSource: string): void {
  const code = withoutComments(workerSource);
  if (/\bskipWaiting\s*\(/.test(code)) {
    throw new Error(
      'refusing to stamp a service worker that calls skipWaiting — it would ' +
        'activate a new build over pages still running the previous one',
    );
  }
}

/**
 * Marker the handoff coordinator carries, and the sibling path it moves to.
 *
 * The destination must stay OUTSIDE the worker's `/cosy/` scope, and the broker
 * must serve it at the matching path. `test-web-update-handoff.ts` checks that
 * this literal equals the broker's own `WEB_HANDOFF_PATH`; this check makes the
 * build fail if the shell stops shipping the coordinator at all.
 */
const HANDOFF_MARKER = 'cosyncing-handoff-coordinator';
const HANDOFF_SIBLING_PATH = '../cosy-handoff';

/** Refuses to stamp a shell that cannot hand its tabs over (N3b). */
export function assertHandoffCoordinator(indexHtml: string): void {
  if (!indexHtml.includes(HANDOFF_MARKER)) {
    throw new Error(
      `refusing to stamp a web build whose index.html carries no ${HANDOFF_MARKER} — ` +
        'an update would strand every open tab on the previous build',
    );
  }
  if (!indexHtml.includes(HANDOFF_SIBLING_PATH)) {
    throw new Error(
      `refusing to stamp a web build whose handoff destination is not ${HANDOFF_SIBLING_PATH} — ` +
        'a destination inside the worker scope is a controlled client and can never let it retire',
    );
  }
}

/** Fails the build if a manifest entry looks like a broker/runtime route. */
export function assertNoRuntimeRoutes(paths: readonly string[]): void {
  const offenders = paths.filter((path) =>
    FORBIDDEN_MANIFEST_PREFIXES.some((prefix) => path.startsWith(prefix)),
  );
  if (offenders.length > 0) {
    throw new Error(
      `refusing to stamp a static cache manifest containing runtime routes: ${offenders.join(', ')}`,
    );
  }
}

/**
 * SHA-256 of each cached file, keyed by its manifest path.
 *
 * The worker checks every response it is about to cache against this map.
 * Flutter web content-hashes no URL, so this is the only way for a worker to
 * tell its own build's `canvaskit.wasm` from the next build's.
 */
async function computeAssetHashes(
  buildDir: string,
  paths: readonly string[],
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const path of [...paths].sort()) {
    const bytes = await readFile(join(buildDir, ...path.split('/')));
    hashes[path] = createHash('sha256').update(bytes).digest('hex');
  }
  return hashes;
}

/**
 * Deterministic build identity: a hash over every cached file's path AND
 * content. Flutter web content-hashes nothing, so a byte change in
 * main.dart.js with an unchanged file list must still produce a new cache
 * name — otherwise the worker would keep serving the previous build forever.
 */
function computeBuildVersion(hashes: Readonly<Record<string, string>>): string {
  const digest = createHash('sha256');
  for (const path of Object.keys(hashes).sort()) {
    digest.update(path);
    digest.update('\0');
    digest.update(hashes[path]!);
    digest.update('\n');
  }
  return digest.digest('hex').slice(0, 16);
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function gitValue(args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  return result.success ? result.stdout.toString().trim() : '';
}

/** Reads the source provenance once, before a release build starts. */
export function readWebSourceIdentity(): WebSourceIdentity {
  const sourceCommit = gitValue(['rev-parse', 'HEAD']) || 'unknown';
  const status = Bun.spawnSync(
    ['git', 'status', '--porcelain', '--untracked-files=normal'],
    { stdout: 'pipe', stderr: 'ignore' },
  );
  return {
    sourceCommit,
    dirty: !status.success || status.stdout.toString().trim().length > 0,
  };
}

async function totalBytes(buildDir: string, paths: readonly string[]): Promise<number> {
  let total = 0;
  for (const path of paths) {
    total += (await stat(join(buildDir, ...path.split('/')))).size;
  }
  return total;
}

/** Builds the manifest for a finished web build directory. */
export async function buildCacheManifest(buildDir: string): Promise<CacheManifest> {
  const all = await listFiles(buildDir);
  const precache: string[] = [];
  const runtime: string[] = [];
  for (const path of all.sort()) {
    switch (classify(path)) {
      case 'precache':
        precache.push(path);
        break;
      case 'runtime':
        runtime.push(path);
        break;
      default:
        break;
    }
  }
  assertNoRuntimeRoutes([...precache, ...runtime]);
  if (!precache.includes('index.html')) {
    throw new Error(`no index.html in ${buildDir} — is this a finished web build?`);
  }
  const hashes = await computeAssetHashes(buildDir, [...precache, ...runtime]);
  return {
    buildVersion: computeBuildVersion(hashes),
    precache,
    runtime,
    hashes,
    precacheBytes: await totalBytes(buildDir, precache),
    runtimeBytes: await totalBytes(buildDir, runtime),
  };
}

/** Substitutes the manifest into the copied worker source. */
export function stampWorkerSource(source: string, manifest: CacheManifest): string {
  for (const placeholder of [
    PLACEHOLDER_VERSION,
    PLACEHOLDER_PRECACHE,
    PLACEHOLDER_RUNTIME,
    PLACEHOLDER_HASHES,
  ]) {
    if (!source.includes(placeholder)) {
      throw new Error(
        `sw.js is missing ${placeholder} — the build output was already stamped or hand-edited`,
      );
    }
  }
  assertNoSkipWaiting(source);
  return source
    .replace(PLACEHOLDER_VERSION, manifest.buildVersion)
    .replace(PLACEHOLDER_PRECACHE, JSON.stringify(manifest.precache, null, 2))
    .replace(PLACEHOLDER_RUNTIME, JSON.stringify(manifest.runtime, null, 2))
    .replace(PLACEHOLDER_HASHES, JSON.stringify(manifest.hashes, null, 2));
}

/** Stamps a finished web build in place. Returns a process exit code. */
export async function stampWebCache(
  options: {
    readonly buildDir?: string;
    readonly quiet?: boolean;
    /** The same provenance passed to the Dart compiler for this build. */
    readonly sourceIdentity?: WebSourceIdentity;
  } = {},
): Promise<number> {
  const buildDir = resolve(options.buildDir ?? join(CLIENT_ROOT, 'build', 'web'));
  const quiet = options.quiet ?? false;
  const workerPath = join(buildDir, 'sw.js');

  if (!(await Bun.file(join(buildDir, 'index.html')).exists())) {
    console.error(`No web build at ${buildDir}. Run the client web build first.`);
    return 1;
  }
  if (!(await Bun.file(workerPath).exists())) {
    console.error(`No sw.js in ${buildDir}. Is apps/client/web/sw.js present?`);
    return 1;
  }

  const manifest = await buildCacheManifest(buildDir);
  const stamped = stampWorkerSource(await readFile(workerPath, 'utf8'), manifest);
  const indexHtml = await readFile(join(buildDir, 'index.html'), 'utf8');
  if (!indexHtml.includes('<base href="/cosy/">')) {
    console.error('Refusing to stamp a web build without the canonical /cosy/ base href.');
    return 1;
  }
  try {
    assertHandoffCoordinator(indexHtml);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const mainDart = await readFile(join(buildDir, 'main.dart.js'));
  const source = options.sourceIdentity ?? readWebSourceIdentity();
  if (!mainDart.includes(Buffer.from(BROKER_CONTRACT.surfaceHash, 'utf8'))) {
    console.error(
      'Compiled main.dart.js does not carry the generated client contract surface hash.',
    );
    return 1;
  }
  if (!mainDart.includes(Buffer.from(source.sourceCommit, 'utf8'))) {
    console.error(
      'Compiled main.dart.js does not carry the stamped source commit. ' +
        'Rebuild it through scripts/client/build-web.ts.',
    );
    return 1;
  }
  if (!mainDart.includes(Buffer.from('cosyncingExecutingClientBuildIdentity', 'utf8'))) {
    console.error(
      'Compiled main.dart.js does not publish its executing-client build identity.',
    );
    return 1;
  }
  const cacheManifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  const releaseFiles = await computeAssetHashes(
    buildDir,
    RELEASE_UNCACHED_FILES,
  );
  const buildIdentity: WebBuildIdentity = {
    schemaVersion: 1,
    product: 'cosyncing',
    version: packageJson.version,
    ...source,
    baseHref: '/cosy/',
    contract: {
      ...BROKER_CONTRACT,
      clientMinimumBrokerRevision:
        CLIENT_MINIMUM_BROKER_CONTRACT_REVISION,
    },
    buildId: manifest.buildVersion,
    cacheManifestSha256: sha256(cacheManifestBytes),
    mainDartSha256: sha256(mainDart),
    releaseFiles,
  };
  await writeFile(workerPath, stamped, 'utf8');
  await writeFile(
    join(buildDir, 'cosyncing-cache-manifest.json'),
    cacheManifestBytes,
    'utf8',
  );
  await writeFile(
    join(buildDir, 'cosyncing-build-identity.json'),
    `${JSON.stringify(buildIdentity, null, 2)}\n`,
    'utf8',
  );

  if (!quiet) {
    const mib = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
    console.log(
      `static cache ${manifest.buildVersion}: ` +
        `${manifest.precache.length} precached (${mib(manifest.precacheBytes)} MiB), ` +
        `${manifest.runtime.length} runtime (${mib(manifest.runtimeBytes)} MiB) ` +
        `-> ${relative(process.cwd(), workerPath).split(sep).join('/')}`,
    );
  }
  return 0;
}

if (import.meta.main) {
  process.exit(
    await stampWebCache({
      buildDir: argValue('build-dir'),
      quiet: Bun.argv.includes('--quiet'),
    }),
  );
}
