#!/usr/bin/env bun
/**
 * Stage and pack the npm distribution: ONE publishable `cosyncing` package.
 *
 * The previous design published four packages — a per-platform `@cosyncing/broker-<os>-<cpu>` carrying a
 * `bun build --compile` executable, plus a main package whose postinstall swapped the matching binary in.
 * Each of those executables embedded the Bun runtime, and therefore JavaScriptCore/WebKit, which is what
 * `docs/legal/binary-distribution-readiness.md` governs.
 *
 * This lane ships the application as what it already is: JavaScript. `scripts/broker/build-broker-bundle.ts`
 * produces one self-contained bundle with a Bun shebang, the operator installs Bun themselves, and the
 * package carries no interpreter at all. One npm name can hold one universal JavaScript file, so the
 * platform packages, the resolver, and the postinstall binary swap are all gone with it — along with the
 * whole class of failure where an install succeeds but resolves no runnable broker.
 *
 * What did NOT change: the web sidecar still ships beside the application, `cosyncing` and `cosy` are still
 * both npm bin entries, the package is still Apache-2.0, and the version still comes from the canonical root
 * package.json. Compiling a native executable is still possible for CI and a future approved release — it is
 * simply not reachable from here (see scripts/broker/build-broker.ts).
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
import { PRODUCT_IDENTITY } from '../../packages/typescript/protocol/src/product.ts';
import {
  SUPPORTED_BROKER_PACKAGE_CPU,
  SUPPORTED_BROKER_PACKAGE_OS,
  supportedBrokerHostList,
} from '../../packages/typescript/broker/src/installation/supported-hosts.ts';
import {
  createCompiledSoftwareInventory,
  createJavaScriptThirdPartyNotices,
} from '../broker/release/software-inventory.ts';
import {
  stageWebSidecarDirectory,
  validateWebBuildShape,
} from '../broker/release/package-web-sidecar.ts';

const ROOT = resolve(import.meta.dir, '../..');
/** Relative to the package root. The command name, the receipt-owned copy, and this file all share it. */
const PACKAGED_APPLICATION = `bin/${PRODUCT_IDENTITY.primaryBinary}`;
/** Where the compiled client is served from. Single-sourced in scripts/client/build-web.ts. */
const CANONICAL_WEB_BUILD = join('apps', 'client', 'build', 'web');
const THIRD_PARTY_NOTICES = 'THIRD_PARTY_NOTICES.txt';
/**
 * The Bun floor this package requires, read from the canonical root manifest rather than restated here.
 *
 * npm does not enforce `engines.bun`, so this is documentation plus a machine-readable declaration — the
 * enforcement an operator actually experiences is that the shebang finds no `bun` at all, or that Bun refuses
 * the bundle. Restating the floor in two places is how those two would drift.
 */
function requiredBunRange(): string {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    engines?: { bun?: unknown };
  };
  const range = typeof manifest.engines?.bun === 'string' ? manifest.engines.bun.trim() : '';
  if (!range) throw new Error('the root package.json must declare engines.bun for the npm package to require it');
  return range;
}

/**
 * The web sidecar's directory, relative to the package root.
 *
 * A packaged broker resolves its web root as `dirname(<application>)/cosyncing-web-<version>`
 * (resolveFlutterWebRoot in packages/typescript/broker/src/runtime/runtime-assets.ts). The application is this
 * package's own `bin/cosyncing` — there is no longer a swap that could move it elsewhere — so the sidecar
 * sits beside it and one directory serves every host.
 */
function webSidecarDirectory(version: string): string {
  return `bin/${PRODUCT_IDENTITY.releaseAssetPrefix}-web-${version}`;
}

interface Options {
  /** Reuse a prebuilt JavaScript application bundle instead of building one. */
  application?: string;
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
      `  Stages the single publishable ${PRODUCT_IDENTITY.productName} JavaScript package.\n\n` +
      `  --application PATH              reuse a prebuilt JavaScript application bundle\n` +
      `                                  (env ${PRODUCT_IDENTITY.environmentVariablePrefix}NPM_BROKER_APPLICATION)\n` +
      `  --web-dir DIR                   reuse a prebuilt /cosy/ web build (default: run\n` +
      `                                  scripts/client/build-web.ts into ${CANONICAL_WEB_BUILD})\n` +
      `  --no-web                        do not bundle the web app (local and test builds only)\n` +
      `  --output-dir DIR                tarball destination (env ${PRODUCT_IDENTITY.environmentVariablePrefix}NPM_OUTPUT_DIR,\n` +
      `                                  default output/npm)\n` +
      `  --stage-dir DIR                 staged package root (default <output-dir>/package)\n` +
      `  --version X.Y.Z                 override the canonical root package version\n` +
      `  --build-date ISO-8601           forwarded to build-broker-bundle.ts\n` +
      `  --commit HEX                    forwarded to build-broker-bundle.ts\n` +
      `  --require-clean                 forwarded to build-broker-bundle.ts\n` +
      `  --minify                        forwarded to build-broker-bundle.ts\n` +
      `  --release-manifest-url HTTPS_URL         forwarded to build-broker-bundle.ts\n` +
      `  --release-channel-manifest-url HTTPS_URL forwarded to build-broker-bundle.ts\n` +
      `  --release-key-id ID                      forwarded to build-broker-bundle.ts\n` +
      `  --release-public-key PEM_PATH            forwarded to build-broker-bundle.ts\n` +
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
  const environmentApplication = process.env[`${PRODUCT_IDENTITY.environmentVariablePrefix}NPM_BROKER_APPLICATION`]?.trim();
  const environmentOutput = process.env[`${PRODUCT_IDENTITY.environmentVariablePrefix}NPM_OUTPUT_DIR`]?.trim();
  let application = environmentApplication ? resolve(ROOT, environmentApplication) : undefined;
  let web = true;
  let webDirectory: string | undefined;
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
    if (arg === '--application') application = resolve(ROOT, nextArg(argv, index++));
    else if (arg === '--web-dir') webDirectory = resolve(ROOT, nextArg(argv, index++));
    else if (arg === '--no-web') web = false;
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
    ...(application ? { application } : {}),
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
 * The commit the application in this package is (or was) stamped with.
 *
 * Deliberately the same expression the bundle builder evaluates, because that is literally the commit it
 * will stamp when this script invokes it; the release lane passes the same `--commit` explicitly when it
 * supplies a prebuilt.
 */
function effectiveBrokerCommit(): string {
  if (options.commit?.trim()) return options.commit.trim();
  const result = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'ignore' });
  return (result.success ? result.stdout.toString().trim() : '') || 'unknown';
}

/** ELF, Mach-O, and PE magic. Any of them in this package means an embedded runtime came back. */
const EXECUTABLE_MAGIC: ReadonlyArray<{ label: string; bytes: readonly number[] }> = Object.freeze([
  { label: 'ELF', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { label: 'Mach-O 64-bit', bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { label: 'Mach-O 64-bit big-endian', bytes: [0xfe, 0xed, 0xfa, 0xcf] },
  { label: 'Mach-O universal', bytes: [0xca, 0xfe, 0xba, 0xbe] },
  { label: 'PE', bytes: [0x4d, 0x5a] },
]);

/**
 * Refuse to ship anything but plain JavaScript as the executable entry.
 *
 * This is the check that makes the migration irreversible by accident: point the builder back at
 * `--compile`, or hand `--application` a compiled artifact, and the staged file gains a machine-code header
 * and this throws. It is the packaging-side twin of the assertion the old script made — which demanded the
 * file BE an ELF/Mach-O executable — and inverting it is the point.
 */
function assertJavaScriptApplication(path: string): void {
  const bytes = readFileSync(path);
  for (const { label, bytes: magic } of EXECUTABLE_MAGIC) {
    if (magic.every((byte, index) => bytes[index] === byte)) {
      throw new Error(
        `staged application is a ${label} executable, not JavaScript: ${path}. `
          + 'The npm distribution ships one plain JavaScript bundle and never an embedded runtime.',
      );
    }
  }
  const shebang = '#!/usr/bin/env bun';
  if (!bytes.subarray(0, shebang.length).equals(Buffer.from(shebang))) {
    throw new Error(`staged application does not begin with ${JSON.stringify(shebang)}: ${path}`);
  }
}

function buildApplication(outfile: string): void {
  run([
    'bun',
    'run',
    join('scripts', 'broker', 'build-broker-bundle.ts'),
    '--outfile',
    outfile,
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

function stagePrebuiltApplication(source: string, outfile: string): void {
  if (!existsSync(source)) throw new Error(`prebuilt application bundle is missing: ${source}`);
  const stat = lstatSync(source);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`prebuilt application bundle must be a regular file: ${source}`);
  }
  copyFileSync(source, outfile);
}

/**
 * Offline identity check: the staged application must report the version, distribution, and SOURCE the
 * package advertises.
 *
 * Unlike the compiled lane, this needs no cross-compilation evidence file. One universal JavaScript bundle
 * runs on the packaging host by definition, so the artifact's own stamped BuildInfo is always available as
 * ground truth and is always what gets checked. `--commit` remains a claim about what is being packaged,
 * never a restamp.
 */
function verifyStagedApplication(path: string, version: string): Record<string, unknown> {
  const output = run(['bun', path, 'version', '--json'], ROOT);
  const info = JSON.parse(output) as Record<string, unknown>;
  if (info.version !== version || info.product !== PRODUCT_IDENTITY.productName) {
    throw new Error('staged application does not report the version and product it is packaged as');
  }
  if (info.distribution !== 'bun-js' || info.packaged !== true) {
    throw new Error(
      `staged application reports distribution ${JSON.stringify(info.distribution)}; the npm package ships `
        + 'the bun-js distribution only, so a native or source build must never be staged here.',
    );
  }
  if (info.target !== 'universal') {
    throw new Error(
      `staged application claims build target ${JSON.stringify(info.target)}; one JavaScript bundle has no `
        + 'machine-code target and must not name the packaging host as one.',
    );
  }
  const brokerCommit = effectiveBrokerCommit();
  if (info.commit !== brokerCommit) {
    throw new Error(
      `the staged application reports commit ${JSON.stringify(info.commit)} but this package is being `
        + `built as ${JSON.stringify(brokerCommit)}; --commit names what is packaged, it does not restamp it.`,
    );
  }
  if (options.requireClean && info.dirty !== false) {
    throw new Error(
      'the staged application was built from a dirty checkout; --require-clean forbids shipping it.',
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

/**
 * The one published manifest.
 *
 * No `optionalDependencies`, no `@cosyncing/broker-*`, and no `scripts` at all — there is nothing left for a
 * lifecycle script to do, and an install script that can swap an executable is precisely the mechanism this
 * migration removed. `os`/`cpu` exclude Windows, which npm can express; Intel macOS cannot be excluded by
 * those fields without also excluding Apple Silicon, so the product refuses it at diagnosis instead (see
 * packages/typescript/broker/src/installation/supported-hosts.ts).
 */
function packageManifest(version: string, web: boolean): Record<string, unknown> {
  return {
    name: PRODUCT_IDENTITY.productName,
    version,
    description:
      `View and drive CLI coding-agent sessions through your own ${PRODUCT_IDENTITY.productName} broker.`,
    ...PACKAGE_COMMON,
    keywords: ['cosyncing', 'coding-agent', 'broker', 'cli'],
    engines: { bun: requiredBunRange() },
    os: [...SUPPORTED_BROKER_PACKAGE_OS],
    cpu: [...SUPPORTED_BROKER_PACKAGE_CPU],
    bin: {
      [PRODUCT_IDENTITY.primaryBinary]: PACKAGED_APPLICATION,
      [PRODUCT_IDENTITY.aliasBinary]: PACKAGED_APPLICATION,
    },
    files: [
      PACKAGED_APPLICATION,
      ...(web ? [webSidecarDirectory(version)] : []),
      'README.md',
      'LICENSE',
      'NOTICE',
      THIRD_PARTY_NOTICES,
    ],
  };
}

function readme(version: string): string {
  const primary = PRODUCT_IDENTITY.primaryBinary;
  return `# ${PRODUCT_IDENTITY.productName}

A self-hosted broker that lets you view and drive local CLI coding-agent sessions
(Claude Code, Codex, OpenCode, Pi) from your own client.

This package is one self-contained JavaScript application. It does **not** bundle a
runtime: install Bun first, then install this package. It provides two commands,
\`${primary}\` and its alias \`${PRODUCT_IDENTITY.aliasBinary}\`.

## Requirements

- Bun \`${requiredBunRange()}\` — install it from <https://bun.sh>.
- A supported broker host: ${supportedBrokerHostList()}.

Windows x64 runs the broker natively; WSL is no longer required. Windows ARM64 is not
qualified yet, and neither is Intel macOS — \`${primary} doctor\` says so by name rather
than failing later.

## Install

    npm install --global ${PRODUCT_IDENTITY.productName}
    ${primary} setup

Setup inspects the machine, shows exactly what it will change, and applies the whole
plan or none of it. The broker refuses to start until setup has committed.

Among other things, setup copies this application to
\`\$COSYNCING_HOME/bin/${primary}\` (default \`~/.cosyncing/bin/${primary}\`). That copy is
the installed broker: the durable service runs it with your Bun, and
\`${primary} uninstall\` removes it. This npm package stays a plain acquisition
artifact and is never modified.

Other entry points before setup: \`${primary} doctor\` (read-only diagnosis),
\`${primary} version\`, \`${primary} help\`.

## Browser client

The web app ships in this package and is served by your own broker at \`/cosy/\` —
nothing is downloaded at runtime and no third-party host is involved. Setup prints
the URL. Android and desktop clients are separate downloads.

## Update

    npm update --global ${PRODUCT_IDENTITY.productName}
    ${primary} setup

Your package manager owns this package, so \`${primary} upgrade\` does not replace it;
it prints exactly the two commands above. The \`setup\` step re-copies the newly
acquired application and reconciles the service.

## Uninstall

Both steps are needed — they remove different things:

    ${primary} uninstall   # removes what setup created, incl. the installed copy; preserves your data
    npm uninstall --global ${PRODUCT_IDENTITY.productName}   # removes this package and its commands

Neither step touches Bun. It was installed separately and stays that way.

Version ${version}. Licensed under Apache-2.0; see LICENSE, NOTICE, and
${THIRD_PARTY_NOTICES}.
`;
}

const options = parseArgs(process.argv.slice(2));
const version = canonicalVersion(options.version);

function copyLegalFiles(stage: string, commit: string): void {
  for (const name of ['LICENSE', 'NOTICE']) {
    copyFileSync(join(ROOT, name), join(stage, name));
    chmodSync(join(stage, name), 0o644);
  }
  // Removing the embedded runtime removes Bun's notice obligation from this artifact. It does not remove the
  // obligation for the JavaScript dependencies that ARE bundled into the application, so their exact licence
  // texts are emitted from the same inventory the compiled lane uses.
  const inventory = createCompiledSoftwareInventory({
    version,
    sourceCommit: /^[a-f0-9]{40,64}$/.test(commit) ? commit : '0'.repeat(40),
    generatedAt: '1970-01-01T00:00:00.000Z',
  });
  writeFileSync(join(stage, THIRD_PARTY_NOTICES), createJavaScriptThirdPartyNotices(inventory), { mode: 0o644 });
}

/**
 * The validated `/cosy/` web build, produced once and staged beside the application.
 *
 * `--web-dir` means "package exactly this reviewed artifact". Otherwise the canonical client build runs,
 * because it is the ONE definition of the release web build — base href, dart-defines, and the
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
  // it would ship beside a newer application reporting the identical version — one package, two source
  // revisions, and nothing in the tarball saying so.
  const brokerCommit = effectiveBrokerCommit();
  if (validated.identity.sourceCommit !== brokerCommit) {
    throw new Error(
      `web build was built from commit ${JSON.stringify(validated.identity.sourceCommit)} but this package `
        + `carries an application from ${JSON.stringify(brokerCommit)}; package a web build from the same `
        + 'commit, or pass --commit to name the commit being packaged.',
    );
  }
  // Dirtiness is the one provenance term a local build may legitimately carry, so it is refused only where
  // the caller has already declared this is a release.
  if (options.requireClean && validated.identity.dirty !== false) {
    throw new Error(
      'web build was produced from a dirty checkout; --require-clean forbids shipping it beside a release '
        + 'application. Commit or stash the client tree and rebuild the web app.',
    );
  }
  return { directory, paths: validated.paths, source };
}

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

// The web app ships WITH the broker: a plain `npm i -g cosyncing` must serve the real client at /cosy/. A
// published package that serves no browser client is not a smaller install, it is a broken one — the CLI's
// whole point is the client at /cosy/, and an operator has no way to add the app afterwards. `--no-web`
// therefore exists only for local and test builds, and never produces something intended for publication.
const webBuild = options.web ? resolveWebBuild() : undefined;

rmSync(options.stageDirectory, { recursive: true, force: true });
mkdirSync(join(options.stageDirectory, 'bin'), { recursive: true });
const stagedApplication = join(options.stageDirectory, PACKAGED_APPLICATION);
let applicationSource: string;
if (options.application) {
  stagePrebuiltApplication(options.application, stagedApplication);
  applicationSource = options.application;
} else {
  buildApplication(stagedApplication);
  applicationSource = 'built by scripts/broker/build-broker-bundle.ts';
}
chmodSync(stagedApplication, 0o755);
assertJavaScriptApplication(stagedApplication);
const buildInfo = verifyStagedApplication(stagedApplication, version);

if (webBuild) {
  stageWebSidecarDirectory({
    buildDirectory: webBuild.directory,
    targetDirectory: join(options.stageDirectory, webSidecarDirectory(version)),
    paths: webBuild.paths,
  });
}

writeFileSync(
  join(options.stageDirectory, 'package.json'),
  `${JSON.stringify(packageManifest(version, options.web), null, 2)}\n`,
  { mode: 0o644 },
);
writeFileSync(join(options.stageDirectory, 'README.md'), readme(version), { mode: 0o644 });
copyLegalFiles(options.stageDirectory, effectiveBrokerCommit());

const applicationBytes = readFileSync(stagedApplication);
const summary: Record<string, unknown> = {
  product: PRODUCT_IDENTITY.productName,
  version,
  layout: 'single-javascript-package',
  distribution: 'bun-js',
  requiredRuntime: { name: 'bun', range: requiredBunRange(), bundled: false },
  supportedHosts: supportedBrokerHostList(),
  bin: [PRODUCT_IDENTITY.primaryBinary, PRODUCT_IDENTITY.aliasBinary],
  releaseChannel: options.releaseManifestUrl ? 'configured' : 'unconfigured',
  application: {
    path: stagedApplication,
    size: applicationBytes.byteLength,
    sha256: sha256(applicationBytes),
    source: applicationSource,
  },
  buildInfo,
  web: webBuild
    ? {
      directory: webSidecarDirectory(version),
      files: webBuild.paths.length,
      source: webBuild.source,
    }
    : 'omitted (--no-web): this package serves no browser client',
  packages: [packStage(PRODUCT_IDENTITY.productName, options.stageDirectory)],
};

console.log(JSON.stringify(summary, null, 2));
