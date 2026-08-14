#!/usr/bin/env bun
/**
 * Build the JavaScript broker application: ONE self-contained bundle, executed by a separately installed
 * Bun runtime.
 *
 * This is the artifact the published npm package ships. It is `bun build --target=bun` WITHOUT `--compile`,
 * so nothing of Bun, JavaScriptCore, or WebKit is copied into it — the operator installs Bun themselves and
 * the package carries only cosyncing's own code plus its JavaScript dependencies.
 *
 * Self-contained is a hard requirement, not a size preference. Setup copies this file to
 * `~/.cosyncing/bin/cosyncing` and the durable service execs THAT copy; a bundle with externalized
 * dependencies would leave the receipt-owned copy reaching back into the npm package's `node_modules`,
 * which `npm update`/`npm uninstall` move out from under a running service. Nothing is externalized.
 *
 * The compiled native executable is a different artifact from a different builder
 * (`scripts/broker/build-broker.ts`) and stays behind its own distribution gate.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PRODUCT_IDENTITY } from '../../packages/typescript/protocol/src/product.ts';
import {
  BROKER_CONTRACT,
  PUBLISHED_SCHEMA_VERSIONS,
  buildDefines,
  resolveBuildIdentity,
} from './lib/build-metadata.ts';

/**
 * A single JavaScript file runs anywhere a supported Bun runs, so the artifact has no machine-code target.
 * Stamping the packaging host's `linux-x64` would be a false claim about the bytes AND would make the build
 * name a signed native release artifact it must never install.
 */
const UNIVERSAL_TARGET = 'universal';

/**
 * `#!/usr/bin/env bun` rather than an absolute path: the operator's Bun may be under `~/.bun/bin`, a
 * version manager, Homebrew, or a distro package, and only PATH resolution finds all of them. The durable
 * service does not depend on this line at all — its unit execs the validated absolute Bun explicitly — so a
 * PATH-less service environment cannot be broken by it.
 */
const BUN_SHEBANG = '#!/usr/bin/env bun';

interface BundleOptions {
  outfile: string;
  version?: string;
  buildDate?: string;
  commit?: string;
  requireClean: boolean;
  minify: boolean;
  releaseManifestUrl?: string;
  releaseChannelManifestUrl?: string;
  releaseKeyId?: string;
  releasePublicKeyPath?: string;
}

function usage(): never {
  console.error(
    `Usage: bun run scripts/broker/build-broker-bundle.ts [options]\n\n` +
      `  --outfile PATH                  output JavaScript application bundle\n` +
      `  --version X.Y.Z                 candidate/test builds only; defaults to the root package.json\n` +
      `  --build-date ISO-8601           immutable build time (or SOURCE_DATE_EPOCH)\n` +
      `  --commit HEX                    immutable source commit\n` +
      `  --require-clean                 reject a dirty checkout\n` +
      `  --minify                        strip source comments from the released bundle\n` +
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

function parseArgs(argv: string[]): BundleOptions {
  let outfile = resolve('output', PRODUCT_IDENTITY.productName, PRODUCT_IDENTITY.primaryBinary);
  let version: string | undefined;
  let buildDate: string | undefined;
  let commit: string | undefined;
  let requireClean = false;
  let minify = false;
  let releaseManifestUrl: string | undefined;
  let releaseChannelManifestUrl: string | undefined;
  let releaseKeyId: string | undefined;
  let releasePublicKeyPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--outfile') outfile = resolve(nextArg(argv, index++));
    else if (arg === '--version') version = nextArg(argv, index++);
    else if (arg === '--build-date') buildDate = nextArg(argv, index++);
    else if (arg === '--commit') commit = nextArg(argv, index++);
    else if (arg === '--release-manifest-url') releaseManifestUrl = nextArg(argv, index++);
    else if (arg === '--release-channel-manifest-url') releaseChannelManifestUrl = nextArg(argv, index++);
    else if (arg === '--release-key-id') releaseKeyId = nextArg(argv, index++);
    else if (arg === '--release-public-key') releasePublicKeyPath = resolve(nextArg(argv, index++));
    else if (arg === '--require-clean') requireClean = true;
    else if (arg === '--minify') minify = true;
    else usage();
  }
  return {
    outfile,
    ...(version ? { version } : {}),
    ...(buildDate ? { buildDate } : {}),
    ...(commit ? { commit } : {}),
    requireClean,
    minify,
    ...(releaseManifestUrl ? { releaseManifestUrl } : {}),
    ...(releaseChannelManifestUrl ? { releaseChannelManifestUrl } : {}),
    ...(releaseKeyId ? { releaseKeyId } : {}),
    ...(releasePublicKeyPath ? { releasePublicKeyPath } : {}),
  };
}

const options = parseArgs(process.argv.slice(2));
const identity = resolveBuildIdentity(options);

mkdirSync(dirname(options.outfile), { recursive: true });
const result = await Bun.build({
  entrypoints: [resolve('packages/typescript/broker/src/cli/cli.ts')],
  target: 'bun',
  // No `compile:` key. Adding one would embed the Bun runtime and turn this into the native distribution,
  // which is exactly what the npm lane must never publish; scripts/broker/tests/release/test-npm-package.ts
  // asserts the produced artifact is text with a Bun shebang and no ELF/Mach-O header.
  outdir: dirname(options.outfile),
  naming: { entry: '[dir]/[name].[ext]' },
  define: buildDefines({
    identity,
    distribution: 'bun-js',
    target: UNIVERSAL_TARGET,
    release: options,
  }),
  banner: BUN_SHEBANG,
  minify: options.minify,
  sourcemap: 'none',
  // Everything cosyncing needs at runtime goes IN. The receipt-owned copy under ~/.cosyncing/bin must not
  // depend on the acquisition package's node_modules; Bun and Node builtins are the only externals.
  external: [],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
  throw new Error('broker bundle build failed');
}

// Bun names the entry after its source file (`cli.js`). The product's command name is `cosyncing`, and the
// extensionless name is intentional: the npm bin entry, the receipt-owned copy, the service ExecStart and
// the release artifact all address one filename, and Bun loads an extensionless file as JavaScript.
const emitted = result.outputs.find((output) => output.kind === 'entry-point');
if (!emitted) throw new Error('broker bundle build produced no entry point');
const bundle = readFileSync(emitted.path);
if (!bundle.subarray(0, BUN_SHEBANG.length).equals(Buffer.from(BUN_SHEBANG))) {
  throw new Error('broker bundle is missing its Bun shebang');
}
writeFileSync(options.outfile, bundle, { mode: 0o755 });
chmodSync(options.outfile, 0o755);
if (resolve(emitted.path) !== resolve(options.outfile)) {
  const { rmSync } = await import('node:fs');
  rmSync(emitted.path, { force: true });
}

console.log(JSON.stringify({
  product: PRODUCT_IDENTITY.productName,
  version: identity.version,
  commit: identity.commit,
  dirty: identity.dirty,
  buildDate: identity.buildDate,
  distribution: 'bun-js',
  target: UNIVERSAL_TARGET,
  schemaVersions: PUBLISHED_SCHEMA_VERSIONS,
  contract: BROKER_CONTRACT,
  application: options.outfile,
  bytes: bundle.byteLength,
}));
