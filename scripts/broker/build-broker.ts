#!/usr/bin/env bun
import { createPublicKey } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  PUBLISHED_SCHEMA_VERSIONS,
} from '../../packages/typescript/broker/src/build-info.ts';
import { PRODUCT_IDENTITY } from '../../packages/typescript/broker/src/product.ts';
import { BROKER_CONTRACT } from '../../packages/typescript/protocol/src/index.ts';

const COMPILE_TARGETS = Object.freeze({
  'bun-linux-x64': 'linux-x64',
  'bun-linux-arm64': 'linux-arm64',
  'bun-darwin-arm64': 'darwin-arm64',
} as const);

type CompileTarget = keyof typeof COMPILE_TARGETS;

interface BuildOptions {
  outfile: string;
  compileTarget: CompileTarget;
  productTarget: (typeof COMPILE_TARGETS)[CompileTarget];
  /** Candidate/test builds only. Absent means the canonical root package.json version, which is the default
   *  and the only thing the release lane ever uses. */
  version?: string;
  buildDate?: string;
  commit?: string;
  requireClean: boolean;
  minify: boolean;
  alias: boolean;
  releaseManifestUrl?: string;
  releaseChannelManifestUrl?: string;
  releaseKeyId?: string;
  releasePublicKeyPath?: string;
}

function usage(): never {
  console.error(
    `Usage: bun run scripts/broker/build-broker.ts [options]\n\n` +
      `  --outfile PATH                  output binary\n` +
      `  --target bun-linux-x64|bun-linux-arm64|bun-darwin-arm64\n` +
      `  --version X.Y.Z                 candidate/test builds only; defaults to the root package.json\n` +
      `  --build-date ISO-8601           immutable build time (or SOURCE_DATE_EPOCH)\n` +
      `  --commit HEX                    immutable source commit\n` +
      `  --require-clean                 reject a dirty checkout\n` +
      `  --minify                       strip source comments from the release binary\n` +
      `  --no-alias                     do not create the cosy symlink beside the artifact\n` +
      `  --release-manifest-url HTTPS_URL\n` +
      `  --release-channel-manifest-url HTTPS_URL\n` +
      `  --release-key-id ID\n` +
      `  --release-public-key PEM_PATH\n\n` +
      `Default outfile: output/${PRODUCT_IDENTITY.productName}/${PRODUCT_IDENTITY.primaryBinary}`,
  );
  process.exit(2);
}

function nextArg(argv: string[], index: number): string {
  const value = argv[index + 1];
  if (!value) usage();
  return value;
}

function parseCompileTarget(value: string): CompileTarget {
  if (value in COMPILE_TARGETS) return value as CompileTarget;
  throw new Error(
    `unsupported compile target ${JSON.stringify(value)}; ${Object.keys(COMPILE_TARGETS).join(', ')} only`,
  );
}

/** Only consulted when no explicit `--target` was passed, so cross-compiling from any host stays possible. */
function defaultCompileTarget(): CompileTarget {
  if (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64')) {
    return process.arch === 'arm64' ? 'bun-linux-arm64' : 'bun-linux-x64';
  }
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'bun-darwin-arm64';
  throw new Error(`unsupported build host ${process.platform}/${process.arch}; pass an explicit --target`);
}

function parseArgs(argv: string[]): BuildOptions {
  let outfile = resolve('output', PRODUCT_IDENTITY.productName, PRODUCT_IDENTITY.primaryBinary);
  // Left undefined until every argument is read: an explicit --target must not be pre-empted by the host
  // guard, so a non-Linux (or non-x64/arm64) host can still cross-compile a supported target.
  let compileTarget: CompileTarget | undefined;
  let version: string | undefined;
  let buildDate: string | undefined;
  let commit: string | undefined;
  let requireClean = false;
  let minify = false;
  let alias = true;
  let releaseManifestUrl: string | undefined;
  let releaseChannelManifestUrl: string | undefined;
  let releaseKeyId: string | undefined;
  let releasePublicKeyPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--outfile') outfile = resolve(nextArg(argv, index++));
    else if (arg === '--target') compileTarget = parseCompileTarget(nextArg(argv, index++));
    else if (arg === '--version') version = nextArg(argv, index++);
    else if (arg === '--build-date') buildDate = nextArg(argv, index++);
    else if (arg === '--commit') commit = nextArg(argv, index++);
    else if (arg === '--release-manifest-url') releaseManifestUrl = nextArg(argv, index++);
    else if (arg === '--release-channel-manifest-url') releaseChannelManifestUrl = nextArg(argv, index++);
    else if (arg === '--release-key-id') releaseKeyId = nextArg(argv, index++);
    else if (arg === '--release-public-key') releasePublicKeyPath = resolve(nextArg(argv, index++));
    else if (arg === '--require-clean') requireClean = true;
    else if (arg === '--minify') minify = true;
    else if (arg === '--no-alias') alias = false;
    else usage();
  }
  const resolvedTarget = compileTarget ?? defaultCompileTarget();
  return {
    outfile,
    compileTarget: resolvedTarget,
    productTarget: COMPILE_TARGETS[resolvedTarget],
    ...(version ? { version } : {}),
    ...(buildDate ? { buildDate } : {}),
    ...(commit ? { commit } : {}),
    requireClean,
    minify,
    alias,
    ...(releaseManifestUrl ? { releaseManifestUrl } : {}),
    ...(releaseChannelManifestUrl ? { releaseChannelManifestUrl } : {}),
    ...(releaseKeyId ? { releaseKeyId } : {}),
    ...(releasePublicKeyPath ? { releasePublicKeyPath } : {}),
  };
}

function gitValue(args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'ignore' });
  const value = result.success ? result.stdout.toString().trim() : '';
  return value;
}

function gitCommit(): string {
  return gitValue(['rev-parse', 'HEAD']) || 'unknown';
}

function gitDirty(): boolean {
  const result = Bun.spawnSync(['git', 'status', '--porcelain', '--untracked-files=normal'], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  return !result.success || result.stdout.toString().trim().length > 0;
}

function resolvedBuildDate(explicit?: string): string {
  const epoch = process.env.SOURCE_DATE_EPOCH?.trim();
  const value = explicit ?? (epoch && /^\d+$/.test(epoch)
    ? new Date(Number(epoch) * 1_000).toISOString()
    : new Date().toISOString());
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`build date must be a canonical ISO-8601 instant, received ${JSON.stringify(value)}`);
  }
  return value;
}

function safeHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !/[\0\r\n]/.test(value);
  } catch {
    return false;
  }
}

function releaseDefines(options: BuildOptions): Record<string, string> {
  const supplied = [options.releaseManifestUrl, options.releaseChannelManifestUrl, options.releaseKeyId, options.releasePublicKeyPath]
    .filter((value) => value !== undefined).length;
  if (supplied === 0) return {};
  if (supplied !== 4) throw new Error('release manifest URL, stable-channel manifest URL, key id, and public key must be supplied together');
  if (!safeHttpsUrl(options.releaseManifestUrl!)) throw new Error('release manifest URL must be credential-free HTTPS');
  if (!safeHttpsUrl(options.releaseChannelManifestUrl!)) throw new Error('release channel manifest URL must be credential-free HTTPS');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(options.releaseKeyId!)) throw new Error('release key id is invalid');
  const publicKey = readFileSync(options.releasePublicKeyPath!, 'utf8').trim();
  const parsed = createPublicKey(publicKey);
  if (parsed.asymmetricKeyType !== 'ed25519') throw new Error('release public key must be Ed25519');
  return {
    COSYNCING_RELEASE_MANIFEST_URL: JSON.stringify(options.releaseManifestUrl),
    COSYNCING_RELEASE_CHANNEL_MANIFEST_URL: JSON.stringify(options.releaseChannelManifestUrl),
    COSYNCING_RELEASE_KEY_ID: JSON.stringify(options.releaseKeyId),
    COSYNCING_RELEASE_PUBLIC_KEY_PEM: JSON.stringify(`${publicKey}\n`),
  };
}

function installAlias(outfile: string): string {
  const aliasPath = join(dirname(outfile), PRODUCT_IDENTITY.aliasBinary);
  if (aliasPath === outfile) throw new Error('alias path collides with the primary binary');
  if (existsSync(aliasPath)) {
    const existing = lstatSync(aliasPath);
    if (!existing.isSymbolicLink()) throw new Error(`refusing to replace non-symlink alias path: ${aliasPath}`);
    unlinkSync(aliasPath);
  }
  symlinkSync(basename(outfile), aliasPath);
  return aliasPath;
}

const options = parseArgs(process.argv.slice(2));
const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version?: unknown };
// The canonical root version is the default and the only value the release lane uses. An explicit
// --version exists so a candidate build (e.g. proving a signed 0.1.1 upgrade against a 0.1.0 tree) reports
// the bumped version from its own offline self-check without mutating package.json to get there.
const version = (options.version ?? (typeof packageJson.version === 'string' ? packageJson.version : '')).trim();
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || version === '0.0.0') {
  throw new Error(`refusing to package invalid canonical root version ${JSON.stringify(version)}`);
}
const buildDate = resolvedBuildDate(options.buildDate);
const commit = options.commit?.trim() || gitCommit();
if (commit !== 'unknown' && !/^[a-f0-9]{7,64}$/.test(commit)) throw new Error('build commit must be lowercase hexadecimal');
const dirty = gitDirty();
if (options.requireClean && dirty) throw new Error('release build requires a clean checkout');

mkdirSync(dirname(options.outfile), { recursive: true });
// Bun 1.3 can emit a sparse zero-filled executable when compiling directly across filesystems
// (notably a WSL workspace to /tmp). Compile beside the repository, then copy the complete artifact.
mkdirSync(resolve('output'), { recursive: true });
const stagingDirectory = mkdtempSync(resolve('output', `.${PRODUCT_IDENTITY.productName}-build-`));
const stagedBinary = join(stagingDirectory, PRODUCT_IDENTITY.primaryBinary);
try {
  const result = await Bun.build({
    entrypoints: [resolve('packages/typescript/broker/src/cli.ts')],
    compile: { outfile: stagedBinary, target: options.compileTarget as Bun.Build.CompileTarget },
    define: {
      COSYNCING_BUILD_VERSION: JSON.stringify(version),
      COSYNCING_BUILD_COMMIT: JSON.stringify(commit),
      COSYNCING_BUILD_DATE: JSON.stringify(buildDate),
      COSYNCING_BUILD_TARGET: JSON.stringify(options.productTarget),
      COSYNCING_BUILD_PACKAGED: 'true',
      COSYNCING_BUILD_DIRTY: dirty ? 'true' : 'false',
      COSYNCING_BUILD_SCHEMA_VERSIONS: JSON.stringify(JSON.stringify(PUBLISHED_SCHEMA_VERSIONS)),
      COSYNCING_BUILD_CONTRACT: JSON.stringify(JSON.stringify(BROKER_CONTRACT)),
      ...releaseDefines(options),
    },
    minify: options.minify,
    sourcemap: 'none',
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exitCode = 1;
    throw new Error('broker compilation failed');
  }
  copyFileSync(stagedBinary, options.outfile);
  chmodSync(options.outfile, 0o755);
} finally {
  rmSync(stagingDirectory, { recursive: true, force: true });
}

const aliasPath = options.alias ? installAlias(options.outfile) : undefined;
console.log(JSON.stringify({
  product: PRODUCT_IDENTITY.productName,
  version,
  commit,
  dirty,
  buildDate,
  target: options.productTarget,
  compileTarget: options.compileTarget,
  schemaVersions: PUBLISHED_SCHEMA_VERSIONS,
  contract: BROKER_CONTRACT,
  binary: options.outfile,
  ...(aliasPath ? { alias: aliasPath } : {}),
}));
