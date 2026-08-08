#!/usr/bin/env bun
/**
 * Stage and pack the npm install channel for the broker.
 *
 * One npm name cannot carry three different binaries at the same version, so this follows the esbuild
 * layout: a per-platform package for each target (`@cosyncing/broker-<os>-<cpu>`, constrained by `os`/`cpu`
 * and carrying only the bare binary), plus the user-facing `cosyncing` package that depends on all three as
 * optionalDependencies. npm installs exactly the one matching the host and silently skips the rest.
 *
 * Direct execution is preserved. `cosyncing`'s `bin/cosyncing` ships as a Node resolver, and its postinstall
 * REPLACES that file with the platform binary; npm links the global command as a symlink to that path, so
 * after the swap every invocation execs the broker with nothing in between — stdio, TTY ownership, signal
 * delivery, and the CLI's distinct exit codes (0/1/2/3/4) all stay untouched. When the swap cannot run
 * (`--ignore-scripts`), the resolver remains and is a faithful launcher rather than a stub.
 *
 * `--local-single-tarball` keeps the previous single self-contained package for physical testing, where
 * publishing is not involved and one installable tarball is the whole point.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { PRODUCT_IDENTITY } from '../../packages/typescript/broker/src/product.ts';
import {
  stageWebSidecarDirectory,
  validateWebBuildShape,
} from '../broker/release/package-web-sidecar.ts';

const ROOT = resolve(import.meta.dir, '../..');
/** One compile target per platform package. `os`/`cpu` in each manifest pin it to its own host. */
const NPM_TARGETS = Object.freeze({
  'bun-linux-x64': { target: 'linux-x64', os: 'linux', cpu: 'x64' },
  'bun-linux-arm64': { target: 'linux-arm64', os: 'linux', cpu: 'arm64' },
  'bun-darwin-arm64': { target: 'darwin-arm64', os: 'darwin', cpu: 'arm64' },
} as const);
type NpmCompileTarget = keyof typeof NPM_TARGETS;
const ALL_COMPILE_TARGETS = Object.keys(NPM_TARGETS) as NpmCompileTarget[];
const DEFAULT_COMPILE_TARGET: NpmCompileTarget = 'bun-linux-x64';
/** Relative to a package root; the binary always lives here in both layouts. */
const PACKAGED_BINARY = `bin/${PRODUCT_IDENTITY.primaryBinary}`;
/** Where the compiled client is served from. Single-sourced in scripts/client/build-web.ts. */
const CANONICAL_WEB_BUILD = join('apps', 'client', 'build', 'web');
/**
 * The web sidecar's directory, relative to a package root.
 *
 * A packaged broker resolves its web root as `dirname(<running executable>)/cosyncing-web-<version>`
 * (resolveFlutterWebRoot in packages/typescript/broker/src/runtime-assets.ts), so the sidecar has to sit
 * beside the binary — which in BOTH npm layouts is this package's own `bin/`:
 *
 *   --local-single-tarball : `bin/cosyncing` IS the binary, so `bin/cosyncing-web-<version>` is adjacent.
 *   published (default)    : the main package's `bin/cosyncing` ships as a Node resolver, and postinstall
 *                            REPLACES it in place with the platform package's binary. The executable that
 *                            ends up running therefore lives at the main package's `bin/cosyncing` too, so
 *                            one shared sidecar in the main package serves every host — the per-platform
 *                            packages carry nothing but their binary and stay ~15MB smaller each.
 *
 * The one path where the executable is NOT there is the `--ignore-scripts` fallback, where the resolver
 * survives and spawns the platform package's own binary; resolver.cjs closes that by exporting
 * COSYNCING_WEB_DIR, which is the same documented override seam setup uses to tell the durable service
 * where its sidecar is. Nothing forks the resolution rule itself.
 */
function webSidecarDirectory(version: string): string {
  return `bin/${PRODUCT_IDENTITY.releaseAssetPrefix}-web-${version}`;
}
/** npm scope for the per-platform packages. Publishing these requires owning the scope on the registry. */
const PLATFORM_SCOPE = '@cosyncing';
const NPM_RUNTIME_DIR = join(import.meta.dir, 'npm-runtime');

function platformPackageName(compileTarget: NpmCompileTarget): string {
  const { os, cpu } = NPM_TARGETS[compileTarget];
  return `${PLATFORM_SCOPE}/broker-${os}-${cpu}`;
}

interface Options {
  compileTarget: NpmCompileTarget;
  /** False (default) stages the publishable multi-package set; true keeps the old single-tarball layout. */
  localSingleTarball: boolean;
  binary?: string;
  binaryDirectory?: string;
  /** False drops the bundled web app; the package then serves no browser client. Default true. */
  web: boolean;
  /** Reuse an already-built /cosy/ web directory instead of running the canonical client build. */
  webDirectory?: string;
  outputDirectory: string;
  stageDirectory: string;
  version?: string;
  buildDate?: string;
  commit?: string;
  requireClean: boolean;
  minify: boolean;
  keepStage: boolean;
  pack: boolean;
  releaseManifestUrl?: string;
  releaseChannelManifestUrl?: string;
  releaseKeyId?: string;
  releasePublicKeyPath?: string;
}

function usage(): never {
  console.error(
    `Usage: bun run scripts/release/build-npm-package.ts [options]\n\n` +
      `  (default) stage every platform package plus the main resolver package\n` +
      `  --local-single-tarball          one self-contained package for --target (physical testing)\n` +
      `  --target ${Object.keys(NPM_TARGETS).join('|')}\n` +
      `                                  single-tarball compile target (default ${DEFAULT_COMPILE_TARGET})\n` +
      `  --binary-dir DIR                reuse prebuilt binaries named cosyncing-<target> from DIR\n` +
      `  --binary PATH                   single-tarball only: prebuilt binary for --target\n` +
      `                                  (env ${PRODUCT_IDENTITY.environmentVariablePrefix}NPM_BROKER_BINARY)\n` +
      `  --web-dir DIR                   reuse a prebuilt /cosy/ web build (default: run\n` +
      `                                  scripts/client/build-web.ts into ${CANONICAL_WEB_BUILD})\n` +
      `  --no-web                        --local-single-tarball only: do not bundle the web app\n` +
      `                                  (published packages always ship the client)\n` +
      `  --output-dir DIR                tarball destination (env ${PRODUCT_IDENTITY.environmentVariablePrefix}NPM_OUTPUT_DIR,\n` +
      `                                  default output/npm)\n` +
      `  --stage-dir DIR                 staged package root (default <output-dir>/package)\n` +
      `  --version X.Y.Z                 override the canonical root package version\n` +
      `  --build-date ISO-8601           forwarded to build-broker.ts\n` +
      `  --commit HEX                    forwarded to build-broker.ts\n` +
      `  --require-clean                 forwarded to build-broker.ts\n` +
      `  --minify                        forwarded to build-broker.ts\n` +
      `  --release-manifest-url HTTPS_URL        forwarded to build-broker.ts\n` +
      `  --release-channel-manifest-url HTTPS_URL forwarded to build-broker.ts\n` +
      `  --release-key-id ID                      forwarded to build-broker.ts\n` +
      `  --release-public-key PEM_PATH            forwarded to build-broker.ts\n` +
      `  --keep-stage                    keep the staged package directory after packing\n` +
      `  --no-pack                       stage only; do not run npm pack\n`,
  );
  process.exit(2);
}

function nextArg(argv: string[], index: number): string {
  const value = argv[index + 1];
  if (!value) usage();
  return value;
}

function parseArgs(argv: string[]): Options {
  const environmentBinary = process.env[`${PRODUCT_IDENTITY.environmentVariablePrefix}NPM_BROKER_BINARY`]?.trim();
  const environmentOutput = process.env[`${PRODUCT_IDENTITY.environmentVariablePrefix}NPM_OUTPUT_DIR`]?.trim();
  let binary = environmentBinary ? resolve(ROOT, environmentBinary) : undefined;
  let binaryDirectory: string | undefined;
  let web = true;
  let webDirectory: string | undefined;
  let localSingleTarball = false;
  let compileTarget: NpmCompileTarget = DEFAULT_COMPILE_TARGET;
  let outputDirectory = resolve(ROOT, environmentOutput || join('output', 'npm'));
  let stageDirectory: string | undefined;
  let version: string | undefined;
  let buildDate: string | undefined;
  let commit: string | undefined;
  let requireClean = false;
  let minify = false;
  let keepStage = false;
  let pack = true;
  let releaseManifestUrl: string | undefined;
  let releaseChannelManifestUrl: string | undefined;
  let releaseKeyId: string | undefined;
  let releasePublicKeyPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--target') {
      const value = nextArg(argv, index++);
      if (!(value in NPM_TARGETS)) usage();
      compileTarget = value as NpmCompileTarget;
    } else if (arg === '--binary') binary = resolve(ROOT, nextArg(argv, index++));
    else if (arg === '--binary-dir') binaryDirectory = resolve(ROOT, nextArg(argv, index++));
    else if (arg === '--web-dir') webDirectory = resolve(ROOT, nextArg(argv, index++));
    else if (arg === '--no-web') web = false;
    else if (arg === '--local-single-tarball') localSingleTarball = true;
    else if (arg === '--output-dir') outputDirectory = resolve(ROOT, nextArg(argv, index++));
    else if (arg === '--stage-dir') stageDirectory = resolve(ROOT, nextArg(argv, index++));
    else if (arg === '--version') version = nextArg(argv, index++);
    else if (arg === '--build-date') buildDate = nextArg(argv, index++);
    else if (arg === '--commit') commit = nextArg(argv, index++);
    else if (arg === '--release-manifest-url') releaseManifestUrl = nextArg(argv, index++);
    else if (arg === '--release-channel-manifest-url') releaseChannelManifestUrl = nextArg(argv, index++);
    else if (arg === '--release-key-id') releaseKeyId = nextArg(argv, index++);
    else if (arg === '--release-public-key') releasePublicKeyPath = resolve(ROOT, nextArg(argv, index++));
    else if (arg === '--require-clean') requireClean = true;
    else if (arg === '--minify') minify = true;
    else if (arg === '--keep-stage') keepStage = true;
    else if (arg === '--no-pack') pack = false;
    else usage();
  }
  return {
    compileTarget,
    localSingleTarball,
    ...(binary ? { binary } : {}),
    ...(binaryDirectory ? { binaryDirectory } : {}),
    web,
    ...(webDirectory ? { webDirectory } : {}),
    outputDirectory,
    stageDirectory: stageDirectory ?? join(outputDirectory, 'package'),
    ...(version ? { version } : {}),
    ...(buildDate ? { buildDate } : {}),
    ...(commit ? { commit } : {}),
    requireClean,
    minify,
    keepStage,
    pack,
    ...(releaseManifestUrl ? { releaseManifestUrl } : {}),
    ...(releaseChannelManifestUrl ? { releaseChannelManifestUrl } : {}),
    ...(releaseKeyId ? { releaseKeyId } : {}),
    ...(releasePublicKeyPath ? { releasePublicKeyPath } : {}),
  };
}

function canonicalVersion(explicit?: string): string {
  const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version?: unknown };
  const value = (explicit ?? (typeof packageJson.version === 'string' ? packageJson.version : '')).trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) || value === '0.0.0') {
    throw new Error(`refusing to package invalid canonical version ${JSON.stringify(value)}`);
  }
  return value;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (!result.success) {
    process.stderr.write(result.stderr.toString());
    throw new Error(`command failed: ${command.join(' ')}`);
  }
  return result.stdout.toString();
}

/**
 * The commit the broker binaries in this package are (or were) stamped with.
 *
 * Deliberately the same expression scripts/broker/build-broker.ts:218 evaluates, because that is literally
 * the commit it will stamp when this script invokes it, and the release lane passes the same `--commit`
 * explicitly when it supplies prebuilts. build-broker.ts cannot be imported for it: the module runs a build
 * at top level.
 */
function effectiveBrokerCommit(): string {
  if (options.commit?.trim()) return options.commit.trim();
  const result = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'ignore' });
  return (result.success ? result.stdout.toString().trim() : '') || 'unknown';
}

/**
 * Refuse to ship a tarball whose binary is not the machine code its `os`/`cpu` promise. ELF and Mach-O are
 * checked from their own headers; a mismatch here is the difference between a failed install and a silently
 * unrunnable global command.
 */
function assertBinaryFormat(path: string, compileTarget: NpmCompileTarget): void {
  const header = readFileSync(path).subarray(0, 20);
  const { target, os, cpu } = NPM_TARGETS[compileTarget];
  let ok: boolean;
  if (os === 'darwin') {
    // 64-bit Mach-O little-endian magic 0xfeedfacf, then cputype at offset 4: 0x0100000c is arm64.
    const machO = header[0] === 0xcf && header[1] === 0xfa && header[2] === 0xed && header[3] === 0xfe;
    ok = machO && header[4] === 0x0c && header[5] === 0x00 && header[6] === 0x00 && header[7] === 0x01;
  } else {
    const elf = header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46;
    // e_machine at offset 18 (little-endian, 64-bit): 0x3e is x86-64, 0xb7 is aarch64.
    const machine = cpu === 'x64' ? 0x3e : 0xb7;
    ok = elf && header[4] === 2 && header[18] === machine && header[19] === 0x00;
  }
  if (!ok) {
    throw new Error(`staged binary is not a ${os === 'darwin' ? 'Mach-O' : 'ELF'} ${target} executable: ${path}`);
  }
}

function buildBroker(options: Options, outfile: string): void {
  run([
    'bun',
    'run',
    join('scripts', 'broker', 'build-broker.ts'),
    '--target',
    options.compileTarget,
    '--outfile',
    outfile,
    // The alias is an npm bin entry, not a symlink beside the artifact.
    '--no-alias',
    ...(options.buildDate ? ['--build-date', options.buildDate] : []),
    ...(options.commit ? ['--commit', options.commit] : []),
    ...(options.requireClean ? ['--require-clean'] : []),
    ...(options.minify ? ['--minify'] : []),
    ...(options.releaseManifestUrl ? ['--release-manifest-url', options.releaseManifestUrl] : []),
    ...(options.releaseChannelManifestUrl
      ? ['--release-channel-manifest-url', options.releaseChannelManifestUrl]
      : []),
    ...(options.releaseKeyId ? ['--release-key-id', options.releaseKeyId] : []),
    ...(options.releasePublicKeyPath ? ['--release-public-key', options.releasePublicKeyPath] : []),
  ], ROOT);
}

function stagePrebuiltBinary(source: string, outfile: string): void {
  if (!existsSync(source)) throw new Error(`prebuilt broker binary is missing: ${source}`);
  const stat = lstatSync(source);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`prebuilt broker binary must be a regular file: ${source}`);
  }
  copyFileSync(source, outfile);
}

/**
 * Provenance for a binary this host cannot execute, read from the evidence the RELEASE lane already emits.
 *
 * `scripts/broker/release/package-evidence.ts` writes `<artifact>.evidence.json` beside each artifact, on
 * the matching runner, after executing it — so it is the one thing that can bind a cross-compiled binary's
 * bytes to a commit. This reuses that file and that naming rather than inventing a second provenance
 * format; only the subset the npm lane can independently verify is checked, and the sha256 is recomputed
 * from the bytes actually being staged so the evidence must describe THIS file.
 *
 * Missing or mismatched evidence is a refusal, never a skip. A packager that shrugs at unverifiable
 * provenance is exactly how an unattested binary reaches a tarball.
 */
function prebuiltProvenance(
  stagedPath: string,
  prebuiltSource: string,
  version: string,
  compileTarget: NpmCompileTarget,
): Record<string, unknown> {
  const { target } = NPM_TARGETS[compileTarget];
  const evidencePath = `${prebuiltSource}.evidence.json`;
  if (!existsSync(evidencePath)) {
    throw new Error(
      `no provenance evidence for the ${target} prebuilt this host cannot execute: expected ${evidencePath}. `
        + 'Release artifacts carry <artifact>.evidence.json from scripts/broker/release/package-evidence.ts; '
        + 'package from a directory that includes it.',
    );
  }
  let evidence: Record<string, unknown>;
  try {
    evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new Error(`provenance evidence is not readable JSON: ${evidencePath}`);
  }
  const measured = sha256(readFileSync(stagedPath));
  const brokerCommit = effectiveBrokerCommit();
  if (evidence.schemaVersion !== 1 || evidence.product !== PRODUCT_IDENTITY.productName
      || evidence.artifact !== `${PRODUCT_IDENTITY.releaseAssetPrefix}-${target}`
      || evidence.version !== version || evidence.target !== target
      || evidence.packaged !== true || evidence.sha256 !== measured) {
    throw new Error(
      `provenance evidence does not describe the staged ${target} binary (${evidencePath}); `
        + `expected sha256 ${measured}`,
    );
  }
  if (evidence.sourceCommit !== brokerCommit) {
    throw new Error(
      `the ${target} prebuilt was built from commit ${JSON.stringify(evidence.sourceCommit)} but this `
        + `package is being built as ${JSON.stringify(brokerCommit)}`,
    );
  }
  if (options.requireClean && evidence.dirty !== false) {
    throw new Error(`the ${target} prebuilt was built from a dirty checkout; --require-clean forbids it`);
  }
  return evidence;
}

/**
 * Offline identity check: the packaged binary must report the version, target, and SOURCE the package
 * advertises.
 *
 * `--commit` is a claim about what is being packaged, not proof — and the web build is validated against
 * that same claim, so if nothing checks the binaries themselves a caller can name any commit and ship
 * binaries from another one, with the tarball's own metadata disagreeing with every file in it. The
 * binary's stamped BuildInfo is the ground truth, so where this host can run the artifact it is executed
 * and its own answer is what must match. Where it cannot, accompanying release evidence stands in.
 */
function verifyStagedBinary(
  path: string,
  version: string,
  compileTarget: NpmCompileTarget,
  prebuiltSource?: string,
): Record<string, unknown> | undefined {
  const { target, os, cpu } = NPM_TARGETS[compileTarget];
  if (process.platform !== os || process.arch !== cpu) {
    // A binary this script compiled is bound by construction: buildBroker forwards this same --commit (and
    // --require-clean) to build-broker.ts, which stamps it. A binary handed to us is bound by evidence.
    return prebuiltSource ? prebuiltProvenance(path, prebuiltSource, version, compileTarget) : undefined;
  }
  const output = run([path, 'version', '--json'], ROOT);
  const info = JSON.parse(output) as Record<string, unknown>;
  if (info.version !== version || info.target !== target || info.packaged !== true
      || info.product !== PRODUCT_IDENTITY.productName) {
    throw new Error('staged binary does not report the packaged version, target, and product it is packaged as');
  }
  const brokerCommit = effectiveBrokerCommit();
  if (info.commit !== brokerCommit) {
    throw new Error(
      `the staged ${target} binary reports commit ${JSON.stringify(info.commit)} but this package is being `
        + `built as ${JSON.stringify(brokerCommit)}; --commit names what is packaged, it does not restamp it.`,
    );
  }
  if (options.requireClean && info.dirty !== false) {
    throw new Error(
      `the staged ${target} binary was built from a dirty checkout; --require-clean forbids shipping it.`,
    );
  }
  return info;
}

const PACKAGE_COMMON = Object.freeze({
  license: 'Apache-2.0',
  homepage: 'https://github.com/cosyncing/cosyncing',
  repository: { type: 'git', url: 'git+https://github.com/cosyncing/cosyncing.git' },
  bugs: { url: 'https://github.com/cosyncing/cosyncing/issues' },
});

/** Self-contained package: binary, os/cpu constraint, and both bin entries. Used by --local-single-tarball. */
function packageManifest(
  version: string,
  compileTarget: NpmCompileTarget,
  web: boolean,
): Record<string, unknown> {
  const { os, cpu } = NPM_TARGETS[compileTarget];
  return {
    name: PRODUCT_IDENTITY.productName,
    version,
    description:
      `View and drive CLI coding-agent sessions through your own ${PRODUCT_IDENTITY.productName} broker.`,
    ...PACKAGE_COMMON,
    keywords: ['cosyncing', 'coding-agent', 'broker', 'cli'],
    os: [os],
    cpu: [cpu],
    bin: {
      [PRODUCT_IDENTITY.primaryBinary]: PACKAGED_BINARY,
      [PRODUCT_IDENTITY.aliasBinary]: PACKAGED_BINARY,
    },
    files: [
      PACKAGED_BINARY,
      ...(web ? [webSidecarDirectory(version)] : []),
      'README.md',
      'LICENSE',
      'NOTICE',
    ],
  };
}

/**
 * One platform package: nothing but the binary and the constraint that keeps it off other hosts. It
 * declares NO `bin` (the main package owns the commands) and NO `exports`, so the main package can
 * `require.resolve` the binary by subpath wherever the package manager placed it.
 */
function platformPackageManifest(version: string, compileTarget: NpmCompileTarget): Record<string, unknown> {
  const { target, os, cpu } = NPM_TARGETS[compileTarget];
  return {
    name: platformPackageName(compileTarget),
    version,
    description: `Compiled ${target} ${PRODUCT_IDENTITY.productName} broker binary.`,
    ...PACKAGE_COMMON,
    os: [os],
    cpu: [cpu],
    files: [PACKAGED_BINARY, 'LICENSE', 'NOTICE'],
    preferUnplugged: true,
  };
}

/**
 * The package users install. It carries no binary of its own: npm resolves exactly one optional dependency
 * for the host and skips the others, and postinstall swaps that binary in as the command target.
 */
function mainPackageManifest(version: string, web: boolean): Record<string, unknown> {
  return {
    name: PRODUCT_IDENTITY.productName,
    version,
    description:
      `View and drive CLI coding-agent sessions through your own ${PRODUCT_IDENTITY.productName} broker.`,
    ...PACKAGE_COMMON,
    keywords: ['cosyncing', 'coding-agent', 'broker', 'cli'],
    bin: {
      [PRODUCT_IDENTITY.primaryBinary]: PACKAGED_BINARY,
      [PRODUCT_IDENTITY.aliasBinary]: PACKAGED_BINARY,
    },
    scripts: { postinstall: 'node install.cjs' },
    optionalDependencies: Object.fromEntries(
      ALL_COMPILE_TARGETS.map((candidate) => [platformPackageName(candidate), version]),
    ),
    files: [
      PACKAGED_BINARY,
      ...(web ? [webSidecarDirectory(version)] : []),
      'install.cjs',
      'README.md',
      'LICENSE',
      'NOTICE',
    ],
  };
}

function readme(version: string, compileTarget?: NpmCompileTarget): string {
  const primary = PRODUCT_IDENTITY.primaryBinary;
  const single = compileTarget ? NPM_TARGETS[compileTarget] : undefined;
  const shipsLine = single
    ? `This package ships one compiled ${single.target} broker binary. It installs two`
    : 'This package installs two';
  const hostsLine = single
    ? `${single.os === 'darwin' ? 'macOS' : 'Linux'} ${single.cpu} only. The package refuses to install elsewhere.`
    : 'Supported hosts: Linux x64, Linux arm64, and Apple Silicon macOS. The matching\n'
      + 'broker binary is fetched as an optional dependency; other hosts are refused.';
  return `# ${PRODUCT_IDENTITY.productName}

A self-hosted broker that lets you view and drive local CLI coding-agent sessions
(Claude Code, Codex, OpenCode, Pi) from your own client.

${shipsLine}
commands: \`${primary}\` and its alias \`${PRODUCT_IDENTITY.aliasBinary}\`.

## Install

    npm install -g ${PRODUCT_IDENTITY.productName}

${hostsLine}

## First command

    ${primary} setup

Setup inspects the machine, shows exactly what it will change, and applies the
whole plan or none of it. The broker refuses to start until setup has committed.

Among other things, setup copies the broker binary to
\`\$COSYNCING_HOME/bin/${primary}\` (default \`~/.cosyncing/bin/${primary}\`).
That copy is the installed broker: the service runs it, \`${primary} upgrade\`
replaces it, and \`${primary} uninstall\` removes it. The npm package stays a
plain acquisition artifact and is never modified.

Other entry points before setup: \`${primary} doctor\` (read-only diagnosis),
\`${primary} version\`, \`${primary} help\`.

## Browser client

The web app ships in this package and is served by your own broker at
\`/cosy/\` — nothing is downloaded at runtime and no third-party host is
involved. Setup prints the URL. Android and desktop clients are separate
downloads.

## Update

    ${primary} upgrade     # verified signed release, applied to the installed copy

\`${primary} upgrade\` updates the installed copy in place; it does not update
this npm package. To move the package itself, run
\`npm update -g ${PRODUCT_IDENTITY.productName}\` and then \`${primary} setup\`
to re-copy the newly acquired binary.

## Uninstall

Both steps are needed — they remove different things:

    ${primary} uninstall   # removes what setup created, incl. the installed copy; preserves your data
    npm uninstall -g ${PRODUCT_IDENTITY.productName}   # removes this package and its \`${primary}\` command

Version ${version}. Licensed under Apache-2.0; see LICENSE and NOTICE.
`;
}

const options = parseArgs(process.argv.slice(2));
const version = canonicalVersion(options.version);

interface PackedPackage {
  name: string;
  stage: string;
  tarball?: {
    path: string;
    size: number;
    sha256: string;
    entries: string[];
    webSidecarEntries?: number;
  };
}

function copyLegalFiles(stage: string): void {
  for (const name of ['LICENSE', 'NOTICE']) {
    copyFileSync(join(ROOT, name), join(stage, name));
    chmodSync(join(stage, name), 0o644);
  }
}

function prebuiltPathFor(compileTarget: NpmCompileTarget): string | undefined {
  return options.binaryDirectory
    ? join(options.binaryDirectory, `${PRODUCT_IDENTITY.productName}-${NPM_TARGETS[compileTarget].target}`)
    : undefined;
}

/**
 * Refuse to package unless EVERY expected prebuilt is present.
 *
 * `--binary-dir` means "package exactly these reviewed release artifacts". Falling back to a fresh compile
 * for whichever ones happen to be missing would silently substitute an un-attested binary into a tarball
 * that the operator believes carries the reviewed build — the whole point of pointing at the directory.
 * Missing inputs are a supply-chain error, so name all of them at once and stop.
 */
function assertPrebuiltsPresent(compileTargets: readonly NpmCompileTarget[]): void {
  if (!options.binaryDirectory) return;
  const missing = compileTargets
    .map((compileTarget) => prebuiltPathFor(compileTarget))
    .filter((path): path is string => !!path && !existsSync(path));
  if (missing.length > 0) {
    throw new Error(
      `--binary-dir was supplied but these expected prebuilt binaries are missing:\n  ${missing.join('\n  ')}\n`
        + 'Refusing to substitute a freshly compiled, un-attested binary. Omit --binary-dir to build instead.',
    );
  }
}

/**
 * The validated `/cosy/` web build, produced once and reused by every staged package.
 *
 * `--web-dir` mirrors `--binary-dir`: package exactly this reviewed artifact. Otherwise the canonical client
 * build runs, because it is the ONE definition of the release web build — base href, dart-defines and the
 * service-worker stamp all come from scripts/client/build-web.ts, and a hand-rolled `flutter build web` here
 * would silently produce a differently-shaped bundle. Either way the result goes through the same closed-set
 * validation the signed release sidecar uses, so a non-`/cosy/` shell can never reach an npm tarball.
 */
function resolveWebBuild(): { directory: string; paths: readonly string[]; source: string } {
  let directory: string;
  let source: string;
  if (options.webDirectory) {
    if (!existsSync(join(options.webDirectory, 'index.html'))) {
      throw new Error(`--web-dir has no web build in it: ${options.webDirectory}`);
    }
    directory = options.webDirectory;
    source = options.webDirectory;
  } else {
    run(['bun', 'run', join('scripts', 'client', 'build-web.ts')], ROOT);
    directory = join(ROOT, CANONICAL_WEB_BUILD);
    source = 'built by scripts/client/build-web.ts';
  }
  const validated = validateWebBuildShape({ buildDirectory: directory });
  if (validated.identity.version !== version) {
    throw new Error(
      `web build reports version ${JSON.stringify(validated.identity.version)} but this package is `
        + `${JSON.stringify(version)}; the sidecar directory name and the app's own version would disagree.`,
    );
  }
  // The version is not enough to prove the client and the broker are the same software. A whole release
  // cycle shares one semver, so `--web-dir` could hand over a client built from an older (or dirty) tree and
  // it would ship beside newer broker binaries reporting the identical version — one package, two source
  // revisions, and nothing in the tarball saying so. `validateWebBuildShape` deliberately does not assert
  // provenance (a local build legitimately has no clean tree), so the provenance the NPM lane can prove is
  // asserted here: same commit as the binaries, always.
  const brokerCommit = effectiveBrokerCommit();
  if (validated.identity.sourceCommit !== brokerCommit) {
    throw new Error(
      `web build was built from commit ${JSON.stringify(validated.identity.sourceCommit)} but this package `
        + `carries broker binaries from ${JSON.stringify(brokerCommit)}; package a web build from the same `
        + 'commit, or pass --commit to name the commit being packaged.',
    );
  }
  // Dirtiness is the one provenance term a local build may legitimately carry, so it is refused only where
  // the caller has already declared this is a release: --require-clean is the same gate build-broker.ts
  // applies to the binary, and it must cover the client shipped beside it.
  if (options.requireClean && validated.identity.dirty !== false) {
    throw new Error(
      'web build was produced from a dirty checkout; --require-clean forbids shipping it beside a release '
        + 'binary. Commit or stash the client tree and rebuild the web app.',
    );
  }
  return { directory, paths: validated.paths, source };
}

/** Put the target's binary in place: the required prebuilt, or a fresh build when no --binary-dir was given. */
function stageBinaryFor(compileTarget: NpmCompileTarget, outfile: string): string {
  const prebuilt = prebuiltPathFor(compileTarget);
  if (prebuilt) {
    // Presence was already proven by assertPrebuiltsPresent; stagePrebuiltBinary re-checks it is a safe file.
    stagePrebuiltBinary(prebuilt, outfile);
    return prebuilt;
  }
  buildBroker({ ...options, compileTarget }, outfile);
  return 'built by scripts/broker/build-broker.ts';
}

function packStage(name: string, stage: string): PackedPackage {
  if (!options.pack) return { name, stage };
  const packed = JSON.parse(run(
    ['npm', 'pack', '--json', '--ignore-scripts', '--pack-destination', options.outputDirectory],
    stage,
  )) as Array<{ filename?: unknown }>;
  const filename = typeof packed[0]?.filename === 'string' ? packed[0].filename : undefined;
  if (!filename) throw new Error(`npm pack did not report a tarball filename for ${name}`);
  const tarball = join(options.outputDirectory, filename);
  if (!existsSync(tarball)) throw new Error(`npm pack tarball is missing: ${tarball}`);
  const tarballBytes = readFileSync(tarball);
  // Recorded so an install tree can be diffed against exactly what was shipped. The web sidecar is hundreds
  // of Flutter asset files; listing each one would bury the package's own contents, so it is counted instead
  // (its byte-level identity is the validated closed set, reported under `summary.web`).
  const listing = run(['tar', '-tzvf', tarball], options.outputDirectory).trimEnd().split('\n');
  const sidecarPrefix = `package/${webSidecarDirectory(version)}/`;
  const sidecarEntries = listing.filter((entry) => entry.includes(sidecarPrefix));
  const result: PackedPackage = {
    name,
    stage,
    tarball: {
      path: tarball,
      size: statSync(tarball).size,
      sha256: sha256(tarballBytes),
      entries: listing.filter((entry) => !entry.includes(sidecarPrefix)),
      ...(sidecarEntries.length > 0 ? { webSidecarEntries: sidecarEntries.length } : {}),
    },
  };
  if (!options.keepStage) rmSync(stage, { recursive: true, force: true });
  return result;
}

mkdirSync(options.outputDirectory, { recursive: true });
const summary: Record<string, unknown> = {
  product: PRODUCT_IDENTITY.productName,
  version,
  layout: options.localSingleTarball ? 'single-tarball' : 'multi-platform',
  bin: [PRODUCT_IDENTITY.primaryBinary, PRODUCT_IDENTITY.aliasBinary],
  releaseChannel: options.releaseManifestUrl ? 'configured' : 'unconfigured',
};

assertPrebuiltsPresent(options.localSingleTarball ? [options.compileTarget] : ALL_COMPILE_TARGETS);

// Policy: the web app always ships. A published `cosyncing` that serves no browser client is not a
// smaller install, it is a broken one — the CLI's whole point is the client at /cosy/, and an operator has
// no way to add the app afterwards. `--no-web` therefore exists only for local and test builds, which is
// exactly what --local-single-tarball already means (that layout is never published: one npm name cannot
// carry three binaries at one version).
if (!options.web && !options.localSingleTarball) {
  throw new Error(
    'refusing to build the publishable multi-platform package set without the web app: the client ships '
      + 'with every published package. --no-web is available for --local-single-tarball builds only.',
  );
}

// The web app ships WITH the broker: a plain `npm i -g cosyncing` must serve the real client at /cosy/.
// Built once and staged into whichever package the running executable resolves from.
const webBuild = options.web ? resolveWebBuild() : undefined;

/** Lay the shared sidecar beside this package's `bin/cosyncing`, which is where the broker looks for it. */
function stageWebSidecar(stage: string): void {
  if (!webBuild) return;
  stageWebSidecarDirectory({
    buildDirectory: webBuild.directory,
    targetDirectory: join(stage, webSidecarDirectory(version)),
    paths: webBuild.paths,
  });
}

if (webBuild) {
  summary.web = {
    directory: webSidecarDirectory(version),
    files: webBuild.paths.length,
    source: webBuild.source,
  };
} else {
  summary.web = 'omitted (--no-web): this package serves no browser client';
}

if (options.localSingleTarball) {
  // Physical-testing layout: one installable tarball carrying its own binary. Never published — a single
  // npm name cannot hold three different binaries at the same version.
  rmSync(options.stageDirectory, { recursive: true, force: true });
  mkdirSync(join(options.stageDirectory, 'bin'), { recursive: true });
  const stagedBinary = join(options.stageDirectory, PACKAGED_BINARY);
  let source: string;
  if (options.binary) {
    stagePrebuiltBinary(options.binary, stagedBinary);
    source = options.binary;
  } else {
    source = stageBinaryFor(options.compileTarget, stagedBinary);
  }
  chmodSync(stagedBinary, 0o755);
  assertBinaryFormat(stagedBinary, options.compileTarget);
  // The prebuilt's ORIGINAL path, not the staged copy: its evidence file sits beside it.
  const prebuiltOrigin = options.binary ?? prebuiltPathFor(options.compileTarget);
  const buildInfo = verifyStagedBinary(
    stagedBinary, version, options.compileTarget, ...(prebuiltOrigin ? [prebuiltOrigin] : []),
  );
  // `bin/cosyncing` IS the executable here, so the sidecar beside it is exactly what resolveFlutterWebRoot
  // computes from `dirname(process.execPath)`.
  stageWebSidecar(options.stageDirectory);
  writeFileSync(
    join(options.stageDirectory, 'package.json'),
    `${JSON.stringify(packageManifest(version, options.compileTarget, options.web), null, 2)}\n`,
    { mode: 0o644 },
  );
  writeFileSync(
    join(options.stageDirectory, 'README.md'),
    readme(version, options.compileTarget),
    { mode: 0o644 },
  );
  copyLegalFiles(options.stageDirectory);
  const binaryBytes = readFileSync(stagedBinary);
  summary.target = NPM_TARGETS[options.compileTarget].target;
  summary.binary = {
    path: stagedBinary,
    size: binaryBytes.byteLength,
    sha256: sha256(binaryBytes),
    source,
  };
  if (buildInfo) summary.buildInfo = buildInfo;
  summary.packages = [packStage(PRODUCT_IDENTITY.productName, options.stageDirectory)];
} else {
  const packages: PackedPackage[] = [];
  const binaries: Record<string, unknown> = {};
  for (const compileTarget of ALL_COMPILE_TARGETS) {
    const name = platformPackageName(compileTarget);
    const stage = join(options.outputDirectory, `platform-${NPM_TARGETS[compileTarget].target}`);
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(join(stage, 'bin'), { recursive: true });
    const stagedBinary = join(stage, PACKAGED_BINARY);
    const source = stageBinaryFor(compileTarget, stagedBinary);
    chmodSync(stagedBinary, 0o755);
    // Every tarball's bytes are format-checked on every host; only the matching host can also execute it.
    assertBinaryFormat(stagedBinary, compileTarget);
    const prebuiltOrigin = prebuiltPathFor(compileTarget);
    const buildInfo = verifyStagedBinary(
      stagedBinary, version, compileTarget, ...(prebuiltOrigin ? [prebuiltOrigin] : []),
    );
    writeFileSync(
      join(stage, 'package.json'),
      `${JSON.stringify(platformPackageManifest(version, compileTarget), null, 2)}\n`,
      { mode: 0o644 },
    );
    copyLegalFiles(stage);
    const binaryBytes = readFileSync(stagedBinary);
    binaries[NPM_TARGETS[compileTarget].target] = {
      size: binaryBytes.byteLength,
      sha256: sha256(binaryBytes),
      source,
      ...(buildInfo ? { buildInfo } : {}),
    };
    packages.push(packStage(name, stage));
  }

  // The main package carries no binary of its own: the resolver ships as bin/cosyncing and postinstall
  // replaces it with whichever platform binary npm resolved for this host.
  const mainStage = join(options.outputDirectory, 'package');
  rmSync(mainStage, { recursive: true, force: true });
  mkdirSync(join(mainStage, 'bin'), { recursive: true });
  copyFileSync(join(NPM_RUNTIME_DIR, 'resolver.cjs'), join(mainStage, PACKAGED_BINARY));
  chmodSync(join(mainStage, PACKAGED_BINARY), 0o755);
  copyFileSync(join(NPM_RUNTIME_DIR, 'install.cjs'), join(mainStage, 'install.cjs'));
  chmodSync(join(mainStage, 'install.cjs'), 0o644);
  // One shared sidecar, in the package postinstall swaps the platform binary INTO — never duplicated per
  // platform package, which would triple the published web bytes for no resolution any host would use.
  stageWebSidecar(mainStage);
  writeFileSync(
    join(mainStage, 'package.json'),
    `${JSON.stringify(mainPackageManifest(version, options.web), null, 2)}\n`,
    { mode: 0o644 },
  );
  writeFileSync(join(mainStage, 'README.md'), readme(version), { mode: 0o644 });
  copyLegalFiles(mainStage);
  packages.push(packStage(PRODUCT_IDENTITY.productName, mainStage));

  summary.binaries = binaries;
  summary.platformPackages = ALL_COMPILE_TARGETS.map(platformPackageName);
  summary.packages = packages;
}

console.log(JSON.stringify(summary, null, 2));
