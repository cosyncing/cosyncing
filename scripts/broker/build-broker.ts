#!/usr/bin/env bun
/**
 * Build the COMPILED NATIVE broker executable: one `bun build --compile` artifact with the Bun runtime
 * embedded in it.
 *
 * This is not the npm distribution. Publishing this artifact is governed by
 * `docs/legal/binary-distribution-readiness.md` and stays gated; the script remains because ephemeral CI and
 * a future approved standalone release both need it. The published npm package is built by
 * `scripts/broker/build-broker-bundle.ts`, which produces plain JavaScript and embeds no runtime.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { PRODUCT_IDENTITY } from '../../packages/typescript/broker/src/product.ts';
import {
  BROKER_CONTRACT,
  PUBLISHED_SCHEMA_VERSIONS,
  buildDefines,
  resolveBuildIdentity,
} from './lib/build-metadata.ts';

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
// The canonical root version is the default and the only value the release lane uses. An explicit
// --version exists so a candidate build (e.g. proving a signed 0.1.1 upgrade against a 0.1.0 tree) reports
// the bumped version from its own offline self-check without mutating package.json to get there.
const { version, commit, buildDate, dirty } = resolveBuildIdentity(options);

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
    define: buildDefines({
      identity: { version, commit, buildDate, dirty },
      // The compiled artifact embeds Bun and is bound to one machine-code target, so both terms are true of
      // this builder alone. The JavaScript bundle stamps `bun-js`/`universal` from the same shared helper.
      distribution: 'native',
      target: options.productTarget,
      release: options,
    }),
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
  distribution: 'native',
  target: options.productTarget,
  compileTarget: options.compileTarget,
  schemaVersions: PUBLISHED_SCHEMA_VERSIONS,
  contract: BROKER_CONTRACT,
  binary: options.outfile,
  ...(aliasPath ? { alias: aliasPath } : {}),
}));
