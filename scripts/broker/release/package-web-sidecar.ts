#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BROKER_CONTRACT,
  CLIENT_MINIMUM_BROKER_CONTRACT_REVISION,
} from '../../../packages/typescript/protocol/src/index.ts';
import {
  RELEASE_UNCACHED_FILES,
} from '../../client/build-web-cache.ts';
import {
  WEB_SIDECAR_NAME,
  type WebPackageEvidence,
} from './release-files.ts';

interface Options {
  buildDirectory: string;
  artifactPath: string;
  evidencePath: string;
  version: string;
  sourceCommit: string;
  buildDate: string;
}

interface CacheManifest {
  buildVersion: string;
  precache: string[];
  runtime: string[];
  hashes: Record<string, string>;
  precacheBytes: number;
  runtimeBytes: number;
}

function usage(): never {
  console.error(
    'Usage: bun run scripts/broker/release/package-web-sidecar.ts '
    + '--build-dir DIR --artifact PATH --evidence PATH --version X.Y.Z '
    + '--commit HEX --build-date ISO',
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) usage();
    values.set(key, value);
  }
  const buildDirectory = values.get('--build-dir');
  const artifactPath = values.get('--artifact');
  const evidencePath = values.get('--evidence');
  const version = values.get('--version');
  const sourceCommit = values.get('--commit');
  const buildDate = values.get('--build-date');
  if (!buildDirectory || !artifactPath || !evidencePath || !version
      || !sourceCommit || !buildDate) usage();
  return {
    buildDirectory: resolve(buildDirectory),
    artifactPath: resolve(artifactPath),
    evidencePath: resolve(evidencePath),
    version,
    sourceCommit,
    buildDate,
  };
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitClean(): boolean {
  const result = Bun.spawnSync(
    ['git', 'status', '--porcelain', '--untracked-files=normal'],
    { stdout: 'pipe', stderr: 'ignore' },
  );
  return result.success && result.stdout.toString().trim() === '';
}

function canonicalDirectoryDigest(
  buildDirectory: string,
  paths: readonly string[],
): string {
  const digest = createHash('sha256');
  for (const path of [...paths].sort()) {
    digest.update(path);
    digest.update('\0');
    digest.update(sha256(readFileSync(join(buildDirectory, path))));
    digest.update('\n');
  }
  return digest.digest('hex');
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function safeManifestPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
    return false;
  }
  return path.split('/').every(
    (segment) => segment.length > 0 && segment !== '.' && segment !== '..',
  );
}

function buildVersionFor(hashes: Readonly<Record<string, string>>): string {
  const digest = createHash('sha256');
  for (const path of Object.keys(hashes).sort()) {
    digest.update(path);
    digest.update('\0');
    digest.update(hashes[path]!);
    digest.update('\n');
  }
  return digest.digest('hex').slice(0, 16);
}

interface ValidatedWebBuild {
  identity: any;
  cacheManifest: CacheManifest;
  paths: string[];
  expectedContract: {
    revision: number;
    minimumClientRevision: number;
    clientMinimumBrokerRevision: number;
    surfaceHash: string;
  };
}

/**
 * Everything that must be true of ANY servable web build, whoever is shipping it: the cache manifest is a
 * safe closed set, every listed byte still hashes to what the manifest says, the worker encodes exactly that
 * manifest, the build identity describes its own bytes, and the shell is mounted at `/cosy/`.
 *
 * Split out from `validateWebBuildForPackaging` so the npm packaging path can reuse the identical closed set
 * and the identical `/cosy/` protection without also asserting the release lane's provenance (an exact source
 * commit and a clean checkout), which a local `--local-single-tarball` build legitimately does not have.
 */
export function validateWebBuildShape(
  options: Pick<Options, 'buildDirectory'>,
): ValidatedWebBuild {
  const identity = JSON.parse(
    readFileSync(
      join(options.buildDirectory, 'cosyncing-build-identity.json'),
      'utf8',
    ),
  );
  const cacheManifestBytes = readFileSync(
    join(options.buildDirectory, 'cosyncing-cache-manifest.json'),
  );
  const parsedManifest: unknown = JSON.parse(
    cacheManifestBytes.toString('utf8'),
  );
  if (!plainObject(parsedManifest)
      || !exactKeys(parsedManifest, [
        'buildVersion',
        'precache',
        'runtime',
        'hashes',
        'precacheBytes',
        'runtimeBytes',
      ])
      || typeof parsedManifest.buildVersion !== 'string'
      || !/^[a-f0-9]{16}$/.test(parsedManifest.buildVersion)
      || !Array.isArray(parsedManifest.precache)
      || !Array.isArray(parsedManifest.runtime)
      || !plainObject(parsedManifest.hashes)
      || !Number.isSafeInteger(parsedManifest.precacheBytes)
      || Number(parsedManifest.precacheBytes) < 0
      || !Number.isSafeInteger(parsedManifest.runtimeBytes)
      || Number(parsedManifest.runtimeBytes) < 0) {
    throw new Error('web cache manifest has an invalid or open schema');
  }
  const cacheManifest = parsedManifest as unknown as CacheManifest;
  const cachedPaths = [...cacheManifest.precache, ...cacheManifest.runtime];
  if (cachedPaths.some((path) => typeof path !== 'string' || !safeManifestPath(path))
      || new Set(cachedPaths).size !== cachedPaths.length
      || cacheManifest.precache.join('\0')
        !== [...cacheManifest.precache].sort().join('\0')
      || cacheManifest.runtime.join('\0')
        !== [...cacheManifest.runtime].sort().join('\0')
      || Object.keys(cacheManifest.hashes).sort().join('\0')
        !== [...cachedPaths].sort().join('\0')) {
    throw new Error('web cache manifest paths are not a safe closed set');
  }
  const recomputedHashes: Record<string, string> = {};
  let precacheBytes = 0;
  let runtimeBytes = 0;
  for (const path of cachedPaths) {
    const fullPath = join(options.buildDirectory, ...path.split('/'));
    const stats = lstatSync(fullPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`web cache entry is not a regular file: ${path}`);
    }
    const digest = sha256(readFileSync(fullPath));
    if (cacheManifest.hashes[path] !== digest) {
      throw new Error(`web cache entry no longer matches its manifest hash: ${path}`);
    }
    recomputedHashes[path] = digest;
    if (cacheManifest.precache.includes(path)) precacheBytes += stats.size;
    else runtimeBytes += stats.size;
  }
  if (cacheManifest.precacheBytes !== precacheBytes
      || cacheManifest.runtimeBytes !== runtimeBytes
      || cacheManifest.buildVersion !== buildVersionFor(recomputedHashes)) {
    throw new Error('web cache manifest aggregate identity does not match its files');
  }
  const worker = readFileSync(join(options.buildDirectory, 'sw.js'), 'utf8');
  const expectedWorkerFragments = [
    `const BUILD_VERSION = '${cacheManifest.buildVersion}';`,
    `const PRECACHE_URLS = ${JSON.stringify(cacheManifest.precache, null, 2)};`,
    `const RUNTIME_URLS = ${JSON.stringify(cacheManifest.runtime, null, 2)};`,
    `const ASSET_HASHES = ${JSON.stringify(cacheManifest.hashes, null, 2)};`,
  ];
  const realPlaceholders = [
    '__COSYNCING_BUILD_VERSION__',
    '__COSYNCING_PRECACHE_URLS__',
    '__COSYNCING_RUNTIME_URLS__',
    '__COSYNCING_ASSET_HASHES__',
  ];
  if (expectedWorkerFragments.some((fragment) => !worker.includes(fragment))
      || realPlaceholders.some((placeholder) => worker.includes(placeholder))) {
    throw new Error('stamped worker does not encode the exact web cache manifest');
  }
  const expectedContract = {
    ...BROKER_CONTRACT,
    clientMinimumBrokerRevision: CLIENT_MINIMUM_BROKER_CONTRACT_REVISION,
  };
  const indexHtml = readFileSync(
    join(options.buildDirectory, 'index.html'),
    'utf8',
  );
  const mainDart = readFileSync(join(options.buildDirectory, 'main.dart.js'));
  const expectedReleaseFiles = Object.fromEntries(
    RELEASE_UNCACHED_FILES.map((path) => [
      path,
      sha256(
        readFileSync(
          join(options.buildDirectory, ...path.split('/')),
        ),
      ),
    ]),
  );
  if (identity.schemaVersion !== 1 || identity.product !== 'cosyncing'
      || typeof identity.version !== 'string' || identity.version.length === 0
      || identity.baseHref !== '/cosy/'
      || !indexHtml.includes('<base href="/cosy/">')
      || JSON.stringify(identity.contract) !== JSON.stringify(expectedContract)
      || identity.buildId !== cacheManifest.buildVersion
      || identity.cacheManifestSha256 !== sha256(cacheManifestBytes)
      || identity.mainDartSha256
        !== sha256(mainDart)
      || !mainDart.includes(Buffer.from(expectedContract.surfaceHash, 'utf8'))
      || !mainDart.includes(Buffer.from(identity.version, 'utf8'))
      || JSON.stringify(identity.releaseFiles)
        !== JSON.stringify(expectedReleaseFiles)) {
    throw new Error('web build identity does not describe its own bytes');
  }
  const paths = [
    ...cachedPaths,
    ...RELEASE_UNCACHED_FILES,
    'sw.js',
    'cosyncing-cache-manifest.json',
    'cosyncing-build-identity.json',
  ].sort();
  if (new Set(paths).size !== paths.length
      || paths.some((path) => !safeManifestPath(path))) {
    throw new Error('web cache manifest does not describe a safe closed sidecar');
  }
  for (const path of paths) {
    const stats = lstatSync(join(options.buildDirectory, ...path.split('/')));
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`web sidecar entry is not a regular file: ${path}`);
    }
  }
  return { identity, cacheManifest, paths, expectedContract };
}

/** Recomputes every identity-bearing byte before a sidecar can be signed. */
export function validateWebBuildForPackaging(
  options: Pick<
    Options,
    'buildDirectory' | 'version' | 'sourceCommit'
  >,
): ValidatedWebBuild {
  const validated = validateWebBuildShape(options);
  const { identity } = validated;
  // Release provenance, on top of the shape: this exact version, built from this exact commit, from a tree
  // with nothing uncommitted in it. Only the signed release lane can make that claim.
  if (identity.version !== options.version
      || identity.sourceCommit !== options.sourceCommit
      || identity.dirty !== false) {
    throw new Error('web build identity does not match the release request');
  }
  return validated;
}

/** Copy exactly the validated closed set, and nothing else, under `targetDirectory`. */
function copySidecarTree(
  buildDirectory: string,
  targetDirectory: string,
  paths: readonly string[],
): void {
  for (const path of paths) {
    const target = join(targetDirectory, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(buildDirectory, ...path.split('/')), target);
  }
}

/**
 * The sidecar as a plain directory rather than a signed tarball.
 *
 * The npm channel ships the web app inside the package instead of as a separately downloaded release asset,
 * so it needs the same closed set laid out on disk. Same validated `paths`, same `/cosy/` shell, same
 * refusal to copy anything the cache manifest does not name — only the container differs.
 */
export function stageWebSidecarDirectory(options: {
  buildDirectory: string;
  targetDirectory: string;
  paths: readonly string[];
}): void {
  rmSync(options.targetDirectory, { recursive: true, force: true });
  copySidecarTree(options.buildDirectory, options.targetDirectory, options.paths);
  for (const path of options.paths) {
    chmodSync(join(options.targetDirectory, ...path.split('/')), 0o644);
  }
}

function run(command: string[]): void {
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe' });
  if (!result.success) {
    throw new Error(
      `${command[0]} failed: ${result.stderr.toString().trim().slice(0, 500)}`,
    );
  }
}

export function writeWebSidecarArchive(options: {
  buildDirectory: string;
  artifactPath: string;
  buildDate: string;
  paths: readonly string[];
}): void {
  const staging = mkdtempSync(join(tmpdir(), 'cosyncing-web-sidecar-'));
  try {
    copySidecarTree(options.buildDirectory, join(staging, 'app'), options.paths);
    mkdirSync(dirname(options.artifactPath), { recursive: true });
    const tarPath = join(staging, 'sidecar.tar');
    const epoch = Math.floor(Date.parse(options.buildDate) / 1_000);
    run([
      'tar',
      '--format=ustar',
      '--sort=name',
      `--mtime=@${epoch}`,
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '-C',
      staging,
      '-cf',
      tarPath,
      'app',
    ]);
    run(['gzip', '-n', '-9', tarPath]);
    copyFileSync(`${tarPath}.gz`, options.artifactPath);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function packageWebSidecar(options: Options): WebPackageEvidence {
  if (!gitClean()) throw new Error('web sidecar evidence requires a clean checkout');
  if (options.artifactPath.split('/').at(-1) !== WEB_SIDECAR_NAME) {
    throw new Error(`web sidecar artifact must be named ${WEB_SIDECAR_NAME}`);
  }
  if (!Number.isFinite(Date.parse(options.buildDate))
      || new Date(options.buildDate).toISOString() !== options.buildDate) {
    throw new Error('web sidecar build date must be canonical ISO-8601');
  }
  const {
    identity,
    paths,
    expectedContract,
  } = validateWebBuildForPackaging(options);

  writeWebSidecarArchive({
    buildDirectory: options.buildDirectory,
    artifactPath: options.artifactPath,
    buildDate: options.buildDate,
    paths,
  });

  const artifactBytes = readFileSync(options.artifactPath);
  const evidence: WebPackageEvidence = {
    schemaVersion: 1,
    product: 'cosyncing',
    artifact: WEB_SIDECAR_NAME,
    version: options.version,
    sourceCommit: options.sourceCommit,
    buildDate: options.buildDate,
    size: statSync(options.artifactPath).size,
    sha256: sha256(artifactBytes),
    baseHref: '/cosy/',
    contract: expectedContract,
    buildId: identity.buildId,
    cacheManifestSha256: identity.cacheManifestSha256,
    mainDartSha256: identity.mainDartSha256,
    directorySha256: canonicalDirectoryDigest(options.buildDirectory, paths),
    fileCount: paths.length,
    cleanCheckout: true,
  };
  mkdirSync(dirname(options.evidencePath), { recursive: true });
  writeFileSync(
    options.evidencePath,
    `${JSON.stringify(evidence, null, 2)}\n`,
    { mode: 0o644 },
  );
  return evidence;
}

if (import.meta.main) {
  try {
    console.log(
      JSON.stringify(packageWebSidecar(parseArgs(process.argv.slice(2)))),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
