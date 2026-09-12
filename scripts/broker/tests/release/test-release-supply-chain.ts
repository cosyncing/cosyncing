#!/usr/bin/env bun
/** Deterministic release, signature, inventory, and bootstrap acceptance. */
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BROKER_CONTRACT_REVISION } from '../../../../packages/typescript/adapter-api/src/index.ts';
import {
  PUBLISHED_BROKER_CONTRACT,
  PUBLISHED_SCHEMA_VERSIONS,
} from '../../../../packages/typescript/broker/src/runtime/build-info.ts';
import { BROKER_CONFIG_SCHEMA_VERSION } from '../../../../packages/typescript/broker/src/runtime/configuration.ts';
import { DURABLE_SCHEMA_REGISTRY } from '../../../../packages/typescript/broker/src/security/durable-state.ts';
import { INSTALL_STATE_SCHEMA_VERSION } from '../../../../packages/typescript/broker/src/installation/install-state.ts';
import {
  RELEASE_JAVASCRIPT_APP_NAME,
  RELEASE_JAVASCRIPT_APP_TARGET,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  UPGRADE_JOURNAL_SCHEMA_VERSION,
  verifySignedManifest,
  verifyUpgradeCandidate,
  verifyReleasePairing,
} from '../../../../packages/typescript/broker/src/updates/release-upgrade.ts';
import { MINIMUM_BUN_RUNTIME_VERSION } from '../../../../packages/typescript/broker/src/runtime/application-identity.ts';
import {
  BROKER_CONTRACT,
  CLIENT_MINIMUM_BROKER_CONTRACT_REVISION,
} from '../../../../packages/typescript/protocol/src/index.ts';
import { SETUP_STATE_SCHEMA_VERSION } from '../../../../packages/typescript/broker/src/installation/setup-state.ts';
import {
  insideSupervisedProcessGroup,
  runSupervised,
} from '../../../verification/supervised-process.ts';
import {
  assembleRelease,
  canonicalProductVersion,
  parseRenderedClientTable,
  resolveClientArtifacts,
  sha256,
  BOOTSTRAP_TEMPLATES,
  CLIENT_HOSTS,
  WEB_SIDECAR_NAME,
  type ClientHost,
  type JavaScriptPackageEvidence,
  type WebPackageEvidence,
} from '../../release/release-files.ts';
import {
  candidateAssetBlockers,
  promotionAssetBlockers,
} from '../../release/verify-promotion-assets.ts';
import { PRODUCT_IDENTITY } from '../../../../packages/typescript/protocol/src/product.ts';
import { forbiddenArtifactContent } from '../../release/package-evidence.ts';

import { javaScriptReleaseRegressions } from './javascript-release-regressions.ts';

const ROOT = resolve(import.meta.dir, '../../../..');
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * The ambient environment minus every override the PRODUCT legitimately honors.
 *
 * These assertions are about what the package ships and what the resolver derives from it, so a developer
 * shell that exports `COSYNCING_WEB_DIR` (this repo's do) must not change the answer. It did: the resolver
 * correctly declines to override an operator's own setting, so the no-sidecar and bundled-sidecar cases
 * silently became the operator-override case and the suite reported 36/37 on exactly the machines most
 * likely to be running it. The override case sets the variable back, explicitly.
 */
function hermeticEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment = { ...process.env, ...overrides };
  for (const key of ['COSYNCING_WEB_DIR', 'COSYNCING_NPM_BROKER_BINARY', 'COSYNCING_NPM_OUTPUT_DIR']) {
    if (!(key in overrides)) delete environment[key];
  }
  return environment;
}

async function run(command: string[], options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stage?: string;
  timeoutMs?: number;
  timeoutAttempts?: number;
  /** Grace for a child the command has already asked to exit; see runSupervised. */
  strayGraceMs?: number;
  beforeTimeoutRetry?: () => void;
} = {}): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const stage = options.stage ?? command.slice(0, 3).join(' ');
  const timeoutMs = options.timeoutMs ?? 20_000;
  const timeoutAttempts = options.timeoutAttempts ?? 1;
  for (let attempt = 1; attempt <= timeoutAttempts; attempt += 1) {
    console.log(
      `STAGE ${stage} start (deadline ${timeoutMs}ms, attempt ${attempt}/${timeoutAttempts})`,
    );
    const child = await runSupervised(command, {
      cwd: options.cwd ?? ROOT,
      env: options.env ?? hermeticEnvironment(),
      timeoutMs,
      maxBufferBytes: 8 << 20,
      strayGraceMs: options.strayGraceMs,
      isolateProcessGroup: !insideSupervisedProcessGroup(),
    });
    console.log(
      `STAGE ${stage} done exit=${child.exitCode} timedOut=${child.timedOut} strays=${child.strays}`,
    );
    if (child.strays) {
      throw new Error(`${stage} left subprocesses behind`);
    }
    if (child.timedOut) {
      if (attempt < timeoutAttempts) {
        options.beforeTimeoutRetry?.();
        console.log(`RETRY ${stage} after bounded compiler timeout`);
        continue;
      }
      throw new Error(`${stage} timed out after ${timeoutMs}ms`);
    }
    return { exitCode: child.exitCode, stdout: child.stdout, stderr: child.stderr };
  }
  throw new Error(`${stage} exhausted its timeout attempts`);
}

/** Executable JavaScript fixture; only the runtime version probe is simulated. */
function javaScriptAppScript(
  version: string,
  commit: string,
  buildDate: string,
  /** `bun-js` is what npm ships and what `cosyncing setup` copies into the state home. */
  distribution: 'bootstrap-js' | 'bun-js' = 'bootstrap-js',
): string {
  return `#!/usr/bin/env bun
const [command, ...args] = process.argv.slice(2);
const identity = ${JSON.stringify({
  schemaVersion: 2, product: 'cosyncing', binary: 'cosyncing', alias: 'cosy',
  version, commit, buildDate, target: RELEASE_JAVASCRIPT_APP_TARGET, distribution,
  packaged: true, dirty: false, schemaVersions: PUBLISHED_SCHEMA_VERSIONS,
  contract: PUBLISHED_BROKER_CONTRACT,
})};
if (command === 'version' && args[0] === '--json') console.log(JSON.stringify(identity, null, 2));
else if (command === 'setup') console.log('fixture setup completed');
else if (command === 'status') console.log(JSON.stringify({schemaVersion: 2,
  listener: {host: '127.0.0.1', port: 7734, url: 'http://127.0.0.1:7734', ready: true}}));
else if (command === 'pair' && args[0] === '--json' && args[1] === '--broker-url') {
  console.log(JSON.stringify({schemaVersion: 1, pairingId: 'fixture-pairing',
    qr: 'https://pair.example/v3#fixture', expiresAt: '2026-07-17T00:05:00.000Z',
    brokerUrl: args[2], advertisedUrl: args[2], tokenScope: 'observe-drive-files-v1'}));
} else process.exit(2);
`;
}

/**
 * A Bun stand-in for the installer's two uses of one: the `--revision` capability probe, and running the
 * verified bundle. `version` lets a test present a runtime that is too old without installing one.
 */
function writeFakeBun(path: string, version = '1.3.14'): void {
  writeFileSync(path, `#!/usr/bin/env bash
if [ "\${1:-}" = --revision ]; then
  echo '${version}+fixturebuild'
  exit 0
fi
# The all-in-one tail reads the broker's own JSON with \`bun -e\`, and that is real Bun code rather than a
# fixture affordance — a shell stand-in for it would be testing a JSON reader this installer does not have.
# So \`-e\` goes to the Bun running this suite; everything else stays the shell fixture.
if [ "\${1:-}" = -e ]; then
  exec '${process.execPath}' "$@"
fi
exec '${process.execPath}' "$@"
`, { mode: 0o755 });
}

/**
 * Stands in for an official Bun release archive: a real zip holding `<asset without .zip>/bun`, the layout
 * the installer unpacks. Omitting `version` yields a build that cannot run on this host — the case the
 * installer must survive by trying the next pinned candidate.
 */
function writeFakeBunArchive(
  directory: string,
  asset: string,
  options: { version?: string } = {},
): { path: string; sha256: string } {
  const name = asset.replace(/\.zip$/, '');
  const staging = join(directory, `${asset}.staging`);
  mkdirSync(join(staging, name), { recursive: true });
  writeFileSync(join(staging, name, 'bun'), options.version === undefined
    ? '#!/usr/bin/env bash\nexit 1\n'
    : `#!/usr/bin/env bash
if [ "\${1:-}" = --revision ]; then
  echo '${options.version}+fixturebuild'
  exit 0
fi
exec '${process.execPath}' "$@"
`, { mode: 0o755 });
  const path = join(directory, asset);
  const zipped = Bun.spawnSync(['zip', '-q', '-r', path, name], {
    cwd: staging,
    stdout: 'ignore',
    stderr: 'pipe',
  });
  if (!zipped.success) throw new Error(`Bun archive fixture could not be zipped: ${zipped.stderr.toString()}`);
  rmSync(staging, { recursive: true, force: true });
  return { path, sha256: sha256(readFileSync(path)) };
}

/** Repoint every rendered shell installer's pinned Bun table, keeping every other pin real. */
function repinBunTable(releaseDirectory: string, rows: readonly string[]): void {
  for (const name of Object.keys(BOOTSTRAP_TEMPLATES).filter((item) => item.endsWith('.sh'))) {
    const installer = join(releaseDirectory, name);
    const source = readFileSync(installer, 'utf8');
    const replaced = source.replace(/^BUN_TABLE='[^']*'$/m, `BUN_TABLE='${rows.join('\n')}'`);
    if (replaced === source) throw new Error(`${name} does not carry a pinned Bun table`);
    writeFileSync(installer, replaced, { mode: 0o755 });
  }
}

/**
 * The three desktop clients a release publishes, in the layouts the real ones have.
 *
 * Real archives rather than opaque blobs, for the reason the web sidecar became one: the all-in-one
 * installer UNPACKS these and refuses a tree without the expected executable, so an opaque fixture would
 * no longer exercise the code under test. The names carry the same `-unsigned` suffixes the client release
 * publishes, which is what proves discovery matches on the prefix and extension rather than on an exact
 * name nobody produces.
 */
function writeClientArtifacts(directory: string, version: string): void {
  mkdirSync(directory, { recursive: true });
  const staging = join(directory, 'staging');
  const linuxTree = `cosyncing-client-${version}-linux-x64`;
  mkdirSync(join(staging, linuxTree), { recursive: true });
  writeFileSync(join(staging, linuxTree, 'cosyncing'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(staging, linuxTree, 'LICENSE.txt'), 'fixture licence\n');
  const packed = Bun.spawnSync([
    'tar', '--format=ustar', '--sort=name', '--mtime=@1750000000',
    '--owner=0', '--group=0', '--numeric-owner',
    '-czf', join(directory, `${linuxTree}.tar.gz`), '-C', staging, linuxTree,
  ], { stdout: 'ignore', stderr: 'pipe' });
  if (!packed.success) throw new Error(`linux client fixture: ${packed.stderr.toString()}`);

  const macTree = 'Cosyncing.app';
  mkdirSync(join(staging, macTree, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(staging, macTree, 'Contents', 'MacOS', 'Cosyncing'), 'fixture\n', { mode: 0o755 });
  const windowsTree = `cosyncing-client-${version}-windows-x64`;
  mkdirSync(join(staging, windowsTree), { recursive: true });
  writeFileSync(join(staging, windowsTree, 'cosyncing.exe'), 'MZ desktop fixture\n', { mode: 0o755 });
  for (const [tree, asset] of [
    [macTree, `cosyncing-client-${version}-macos-arm64-unsigned.zip`],
    [windowsTree, `cosyncing-client-${version}-windows-x64-unsigned.zip`],
  ] as const) {
    const zipped = Bun.spawnSync(['zip', '-q', '-r', join(directory, asset), tree], {
      cwd: staging,
      stdout: 'ignore',
      stderr: 'pipe',
    });
    if (!zipped.success) throw new Error(`${asset} fixture: ${zipped.stderr.toString()}`);
  }
  rmSync(staging, { recursive: true, force: true });
}

/** A PATH that reaches the host's real tools but no `bun`, for the case where the host has none. */
function pathWithoutBun(first: string): string {
  const entries = (process.env.PATH ?? '/usr/bin:/bin')
    .split(':')
    .filter((entry) => entry !== '' && !existsSync(join(entry, 'bun')));
  return [first, ...entries].join(':');
}

function writeFakeCurl(path: string): void {
  writeFileSync(path, `#!/usr/bin/env bash
set -eu
OUT=''
URL=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) OUT="$2"; shift 2 ;;
    https://*) URL="$1"; shift ;;
    *) shift ;;
  esac
done
[ -n "$OUT" ] && [ -n "$URL" ]
cp "$FAKE_RELEASE_ROOT/\${URL##*/}" "$OUT"
`, { mode: 0o755 });
}

const root = mkdtempSync(join(tmpdir(), 'cosyncing-release-supply-chain-'));
try {
  const timeoutRetryMarker = join(root, 'timeout-retry-marker');
  let timeoutRetryCleanupCalls = 0;
  const timeoutRetryControl = await run([
    'bash',
    '-c',
    'if [ ! -e "$1" ]; then touch "$1"; while :; do :; done; fi',
    'timeout-retry-control',
    timeoutRetryMarker,
  ], {
    stage: 'timeout-retry-control',
    timeoutMs: 100,
    timeoutAttempts: 2,
    beforeTimeoutRetry: () => {
      timeoutRetryCleanupCalls += 1;
    },
  });
  check(
    'a supervised compiler timeout gets one bounded retry after cleanup',
    timeoutRetryControl.exitCode === 0 && timeoutRetryCleanupCalls === 1,
  );

  const hostedMacHome = ['', 'Users', 'runner'].join('/');
  const scanContext = {
    root: '/fixture/checkout',
    home: hostedMacHome,
    hostname: 'fixture.example',
    environment: {} as Record<string, string | undefined>,
  };
  const upstreamWebKitPath = `${hostedMacHome}/work/_temp/webkit-release/WTF/Headers/wtf/CheckedRef.h`;
  check('darwin evidence permits only Bun upstream WebKit assertion paths under the hosted runner home',
    forbiddenArtifactContent(Buffer.from(upstreamWebKitPath), 'darwin-arm64', scanContext) === undefined);
  check('the Bun upstream exception does not permit a cosyncing checkout under the hosted runner home',
    forbiddenArtifactContent(
      Buffer.from(`${hostedMacHome}/work/cosyncing/cosyncing/packages/private.ts`),
      'darwin-arm64',
      scanContext,
    ) === 'build home');
  check('the Bun upstream exception does not permit another private path under the hosted runner home',
    forbiddenArtifactContent(
      Buffer.from(`${hostedMacHome}/.config/private-token`),
      'darwin-arm64',
      scanContext,
    ) === 'build home');
  check('the Bun upstream exception is unavailable to non-darwin artifacts',
    forbiddenArtifactContent(Buffer.from(upstreamWebKitPath), 'linux-arm64', scanContext) === 'build home');
  check('an allowed Bun upstream path cannot mask a separate forbidden value',
    forbiddenArtifactContent(
      Buffer.from(`${upstreamWebKitPath}\nfixture-secret-value`),
      'darwin-arm64',
      { ...scanContext, environment: { RELEASE_SECRET: 'fixture-secret-value' } },
    ) === 'environment secret RELEASE_SECRET');

  const artifactDirectory = join(root, 'artifacts');
  const evidenceDirectory = join(root, 'evidence');
  const releaseDirectory = join(root, 'release');
  mkdirSync(artifactDirectory, { recursive: true });
  mkdirSync(evidenceDirectory, { recursive: true });
  const version = canonicalProductVersion();
  const commit = '1'.repeat(40);
  const buildDate = '2026-07-17T00:00:00.000Z';
  const jsArtifactPath = join(artifactDirectory, RELEASE_JAVASCRIPT_APP_NAME);
  writeFileSync(jsArtifactPath, javaScriptAppScript(version, commit, buildDate), { mode: 0o755 });
  const jsBytes = readFileSync(jsArtifactPath);
  const jsEvidence: JavaScriptPackageEvidence = {
    schemaVersion: 1,
    product: 'cosyncing',
    artifact: RELEASE_JAVASCRIPT_APP_NAME,
    version,
    target: RELEASE_JAVASCRIPT_APP_TARGET,
    distribution: 'bootstrap-js',
    sourceCommit: commit,
    buildDate,
    size: jsBytes.byteLength,
    sha256: sha256(jsBytes),
    minimumBunVersion: MINIMUM_BUN_RUNTIME_VERSION,
    packaged: true,
    dirty: false,
    schemaVersions: PUBLISHED_SCHEMA_VERSIONS,
    contract: PUBLISHED_BROKER_CONTRACT,
    cleanCheckout: true,
    offlineVersionCheck: true,
    forbiddenContentCheck: true,
    runner: { os: 'linux', arch: 'x64', image: 'fixture-universal', invocationId: '1004' },
  };
  writeFileSync(
    join(evidenceDirectory, `${RELEASE_JAVASCRIPT_APP_NAME}.evidence.json`),
    `${JSON.stringify(jsEvidence, null, 2)}\n`,
  );

  // A real gzipped ustar archive holding the one `app/` tree the installer unpacks. The sidecar stopped
  // being an opaque blob the moment install.sh had to extract it, so an opaque fixture would no longer
  // exercise the code under test.
  const webArtifactPath = join(artifactDirectory, WEB_SIDECAR_NAME);
  {
    const staging = join(root, 'web-fixture');
    mkdirSync(join(staging, 'app', 'assets'), { recursive: true });
    writeFileSync(join(staging, 'app', 'index.html'), '<html><base href="/cosy/"></html>\n');
    writeFileSync(join(staging, 'app', 'assets', 'NOTICES'), 'fixture notices\n');
    const packed = Bun.spawnSync([
      'tar', '--format=ustar', '--sort=name', '--mtime=@1750000000',
      '--owner=0', '--group=0', '--numeric-owner',
      '-czf', webArtifactPath, '-C', staging, 'app',
    ], { stdout: 'ignore', stderr: 'pipe' });
    if (!packed.success) {
      throw new Error(`web sidecar fixture could not be packed: ${packed.stderr.toString()}`);
    }
  }
  const webBytes = readFileSync(webArtifactPath);
  const webEvidence: WebPackageEvidence = {
    schemaVersion: 1,
    product: 'cosyncing',
    artifact: WEB_SIDECAR_NAME,
    version,
    sourceCommit: commit,
    buildDate,
    size: webBytes.byteLength,
    sha256: sha256(webBytes),
    baseHref: '/cosy/',
    contract: {
      ...BROKER_CONTRACT,
      clientMinimumBrokerRevision:
        CLIENT_MINIMUM_BROKER_CONTRACT_REVISION,
    },
    buildId: '0123456789abcdef',
    cacheManifestSha256: '2'.repeat(64),
    mainDartSha256: '3'.repeat(64),
    directorySha256: '4'.repeat(64),
    fileCount: 12,
    cleanCheckout: true,
  };
  writeFileSync(
    join(evidenceDirectory, `${WEB_SIDECAR_NAME}.evidence.json`),
    `${JSON.stringify(webEvidence, null, 2)}\n`,
  );
  const clientDirectory = join(root, 'clients');
  writeClientArtifacts(clientDirectory, version);

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const publicKeyPath = join(root, 'release-key.pub.pem');
  writeFileSync(publicKeyPath, publicPem, { mode: 0o600 });
  const p256 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const p256PrivatePem = p256.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const p256PublicPem = p256.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const webEvidencePath = join(
    evidenceDirectory,
    `${WEB_SIDECAR_NAME}.evidence.json`,
  );
  const originalWebEvidence = readFileSync(webEvidencePath);
  const mismatchedWebEvidence = JSON.parse(originalWebEvidence.toString());
  mismatchedWebEvidence.contract = {
    ...webEvidence.contract,
    surfaceHash: 'fnv1a32:00000000',
  };
  writeFileSync(
    webEvidencePath,
    `${JSON.stringify(mismatchedWebEvidence, null, 2)}\n`,
  );
  let mismatchedWebContractRejected = false;
  try {
    assembleRelease({
      artifactDirectory,
      evidenceDirectory,
      clientDirectory,
      outputDirectory: join(root, 'rejected-web-contract'),
      baseUrl: `https://releases.example/cosyncing/v${version}`,
      version,
      sourceCommit: commit,
      publishedAt: buildDate,
      keyId: 'test-2026',
      privateKeyPem: privatePem,
      publicKeyPem: publicPem,
      p256PrivateKeyPem: p256PrivatePem,
      p256PublicKeyPem: p256PublicPem,
    });
  } catch (error) {
    mismatchedWebContractRejected = /disagree on broker contract/.test(
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    writeFileSync(webEvidencePath, originalWebEvidence);
  }
  check(
    'JavaScript and web evidence must bind the same broker surface',
    mismatchedWebContractRejected,
  );
  const assembled = assembleRelease({
    artifactDirectory,
    evidenceDirectory,
    clientDirectory,
    outputDirectory: releaseDirectory,
    baseUrl: `https://releases.example/cosyncing/v${version}`,
    version,
    sourceCommit: commit,
    publishedAt: buildDate,
    keyId: 'test-2026',
    privateKeyPem: privatePem,
    publicKeyPem: publicPem,
    p256PrivateKeyPem: p256PrivatePem,
    p256PublicKeyPem: p256PublicPem,
  });
  javaScriptReleaseRegressions({
    artifactDirectory, evidenceDirectory, clientDirectory, outputDirectory: releaseDirectory,
    baseUrl: `https://releases.example/cosyncing/v${version}`, version, sourceCommit: commit,
    publishedAt: buildDate, keyId: 'test-2026', privateKeyPem: privatePem, publicKeyPem: publicPem,
    p256PrivateKeyPem: p256PrivatePem, p256PublicKeyPem: p256PublicPem,
  });
  const originalWebArtifact = readFileSync(webArtifactPath);
  writeFileSync(webArtifactPath, 'swapped candidate web sidecar\n');
  let swappedWebRejected = false;
  try {
    assembleRelease({
      artifactDirectory,
      evidenceDirectory,
      clientDirectory,
      outputDirectory: join(root, 'swapped-web-release'),
      baseUrl: `https://releases.example/cosyncing/v${version}`,
      version,
      sourceCommit: commit,
      publishedAt: buildDate,
      keyId: 'test-2026',
      privateKeyPem: privatePem,
      publicKeyPem: publicPem,
      p256PrivateKeyPem: p256PrivatePem,
      p256PublicKeyPem: p256PublicPem,
    });
  } catch (error) {
    swappedWebRejected = /web sidecar no longer matches/.test(
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    writeFileSync(webArtifactPath, originalWebArtifact);
  }
  check(
    'candidate assembly rejects a web sidecar swapped after evidence',
    swappedWebRejected,
  );
  check(
    'candidate and promotion gates accept the exact signed paired release',
    candidateAssetBlockers(releaseDirectory).length === 0
      && promotionAssetBlockers(releaseDirectory).length === 0,
  );

  check('release publishes a complete JavaScript pair with no native descriptors or payloads',
    assembled.manifest.artifacts.length === 0
      && assembled.manifest.jsApp?.name === RELEASE_JAVASCRIPT_APP_NAME
      && !assembled.publishedFiles.some((name) => /^cosyncing-(linux|darwin)-/.test(name)));
  check('manifest carries exact version, commit and embedded signature',
    assembled.manifest.version === version && assembled.manifest.sourceCommit === commit
      && assembled.manifest.signature.keyId === 'test-2026');
  check('JavaScript release verifies against the pinned Ed25519 key',
    verifyUpgradeCandidate({value: assembled.manifest,
      buildInfo: {distribution: 'bootstrap-js', target: 'universal'},
      trustedKeys: {'test-2026': publicPem}}).name === RELEASE_JAVASCRIPT_APP_NAME);

  // The sibling P-256 signature, published in two encodings because the two consumers can each read only
  // one: PowerShell 5.1 has no DER overload, and openssl has no P1363 input. The installer's macOS path
  // depends on the DER one, so it is no longer an unverified emit.
  const p256PublicKeyObject = createPublicKey(
    readFileSync(join(releaseDirectory, 'release-key-p256.pem'), 'utf8'),
  );
  const verifiesP256 = (payload: string, signature: string): boolean => verify(
    'sha256',
    readFileSync(join(releaseDirectory, payload)),
    { key: p256PublicKeyObject, dsaEncoding: 'ieee-p1363' },
    readFileSync(join(releaseDirectory, signature)),
  );
  const verifiesP256Der = (payload: string, signature: string): boolean => verify(
    'sha256',
    readFileSync(join(releaseDirectory, payload)),
    { key: p256PublicKeyObject, dsaEncoding: 'der' },
    readFileSync(join(releaseDirectory, signature)),
  );
  // The DER file must be a re-encoding of the SAME signature, not a second one. ECDSA is randomized, so two
  // signings would produce two independent signatures that could disagree — one valid and one not — and a
  // host would have no way to tell which encoding was broken. Decoding r and s back out and comparing them
  // to the P1363 halves is what proves they are two spellings of one fact.
  const derToRawScalars = (der: Uint8Array): string => {
    if (der[0] !== 0x30) throw new Error('P-256 DER signature is not a SEQUENCE');
    const scalars: string[] = [];
    let at = 2;
    for (let index = 0; index < 2; index += 1) {
      if (der[at] !== 0x02) throw new Error('P-256 DER signature member is not an INTEGER');
      const length = der[at + 1]!;
      const body = Buffer.from(der.subarray(at + 2, at + 2 + length));
      scalars.push(body.toString('hex').replace(/^0+/, '').padStart(64, '0'));
      at += 2 + length;
    }
    if (at !== der.length) throw new Error('P-256 DER signature has trailing bytes');
    return scalars.join('');
  };
  check('both P-256 encodings verify and carry the same signature, not two independent ones',
    ['release-manifest.json', 'SHA256SUMS'].every((payload) => {
      const p1363 = readFileSync(join(releaseDirectory, `${payload}.p256.sig`));
      const der = readFileSync(join(releaseDirectory, `${payload}.p256.der.sig`));
      return p1363.byteLength === 64
        && verifiesP256Der(payload, `${payload}.p256.der.sig`)
        && derToRawScalars(der) === p1363.toString('hex');
    }));
  check('the manifest and checksum list carry sibling P-256 signatures a PowerShell host can verify',
    verifiesP256('release-manifest.json', 'release-manifest.json.p256.sig')
      && verifiesP256('SHA256SUMS', 'SHA256SUMS.p256.sig')
      // IEEE P1363 is what .NET Framework's ECDsa.VerifyData reads: raw r || s, never a DER SEQUENCE.
      && statSync(join(releaseDirectory, 'release-manifest.json.p256.sig')).size === 64
      && statSync(join(releaseDirectory, 'SHA256SUMS.p256.sig')).size === 64);
  check('the published P-256 key is the one that signed, and is not the Ed25519 key',
    readFileSync(join(releaseDirectory, 'release-key-p256.pem'), 'utf8').trim() === p256PublicPem.trim()
      && readFileSync(join(releaseDirectory, 'release-key.pem'), 'utf8').trim() === publicPem.trim());
  check('a tampered manifest fails the sibling signature as well as the Ed25519 one',
    !verify(
      'sha256',
      Buffer.concat([readFileSync(join(releaseDirectory, 'release-manifest.json')), Buffer.from(' ')]),
      { key: p256PublicKeyObject, dsaEncoding: 'ieee-p1363' },
      readFileSync(join(releaseDirectory, 'release-manifest.json.p256.sig')),
    ));
  const publishedManifest = JSON.parse(readFileSync(join(releaseDirectory, 'release-manifest.json'), 'utf8'));
  check('manifest signature encoding stays Ed25519; old nonempty-native parsers require reinstall',
    publishedManifest.signature.algorithm === 'ed25519'
      && publishedManifest.artifacts.length === 0
      && verifySignedManifest(publishedManifest, {'test-2026': publicPem}).version === version);

  check('the signed manifest carries the JavaScript application without a compiled set',
    assembled.manifest.jsApp?.name === RELEASE_JAVASCRIPT_APP_NAME
      && assembled.manifest.jsApp?.target === RELEASE_JAVASCRIPT_APP_TARGET
      && assembled.manifest.jsApp?.sha256 === jsEvidence.sha256
      && assembled.manifest.jsApp?.size === jsEvidence.size
      && assembled.manifest.jsApp?.minimumBunVersion === MINIMUM_BUN_RUNTIME_VERSION
      // It is NOT in the per-host array: that array is machine-code, keyed by target, and a universal
      // bundle placed there would have to claim a machine-code binding it does not have.
      && !assembled.manifest.artifacts.some((item) => item.name === RELEASE_JAVASCRIPT_APP_NAME)
      && assembled.publishedFiles.includes(RELEASE_JAVASCRIPT_APP_NAME)
      && assembled.publishedFiles.includes(`${RELEASE_JAVASCRIPT_APP_NAME}.intoto.jsonl.sig`),
    JSON.stringify(assembled.manifest.jsApp));

  const pairing = verifyReleasePairing(assembled.manifest);
  check(
    'signed manifest binds broker contract and the exact /cosy/ web sidecar',
    JSON.stringify(pairing.contract) === JSON.stringify(BROKER_CONTRACT)
      && pairing.webApp.name === WEB_SIDECAR_NAME
      && pairing.webApp.mount === '/cosy/'
      && pairing.webApp.sha256 === webEvidence.sha256
      && pairing.webApp.buildId === webEvidence.buildId,
  );

  const inventory = JSON.parse(readFileSync(join(releaseDirectory, 'software-inventory.json'), 'utf8'));
  check('@clack/prompts 1.7.0 and its reviewed MIT closure are in the JavaScript inventory',
    inventory.reviewedSupplyChain?.clackPrompts?.root === '@clack/prompts@1.7.0'
      && inventory.reviewedSupplyChain.clackPrompts.licenses?.join(',') === 'MIT'
      && inventory.reviewedSupplyChain.clackPrompts.packages?.length === 6);
  const sbom = JSON.parse(readFileSync(join(releaseDirectory, 'software-bom.spdx.json'), 'utf8'));
  check('final assets contain an SPDX 2.3 SBOM with Apache-2.0 first-party packages',
    sbom.spdxVersion === 'SPDX-2.3'
      && sbom.dataLicense === 'CC0-1.0'
      && sbom.packages.some((item: any) =>
        item.name === '@cosyncing/broker' && item.licenseDeclared === 'Apache-2.0'));
  check('checksums cover every publication payload and detached signatures are present',
    assembled.publishedFiles.includes('SHA256SUMS.sig')
      && assembled.publishedFiles.includes('release-manifest.json.sig')
      && assembled.publishedFiles.includes('release-key.pem')
      && assembled.publishedFiles.includes('software-bom.spdx.json')
      && assembled.publishedFiles.includes('LICENSE')
      && assembled.publishedFiles.includes('NOTICE')
      && assembled.publishedFiles.includes('THIRD_PARTY_NOTICES.txt')
      && assembled.publishedFiles.includes(`${RELEASE_JAVASCRIPT_APP_NAME}.intoto.jsonl.sig`)
      && assembled.publishedFiles.includes(WEB_SIDECAR_NAME)
      && assembled.publishedFiles.includes(`${WEB_SIDECAR_NAME}.intoto.jsonl.sig`)
      && readFileSync(join(releaseDirectory, 'SHA256SUMS'), 'utf8').includes('  install.sh\n'));

  // The PowerShell installer, asserted from Linux. Nothing here runs it — that is the windows-broker
  // lane's job — but every property that is decided at RENDER time is decided on this gate, which is the
  // one that runs on every change.
  const shellInstaller = readFileSync(join(releaseDirectory, 'install.sh'), 'utf8');
  const powerShellInstaller = readFileSync(join(releaseDirectory, 'install.ps1'), 'utf8');
  const singleQuoted = (source: string, assignment: string): string =>
    new RegExp(`^${assignment}'([^']*)'$`, 'm').exec(source)?.[1] ?? '';
  check('the PowerShell installer is published and checksummed beside the shell one',
    assembled.publishedFiles.includes('install.ps1')
      && readFileSync(join(releaseDirectory, 'SHA256SUMS'), 'utf8').includes('  install.ps1\n')
      && candidateAssetBlockers(releaseDirectory).length === 0);
  check('the PowerShell installer has every token substituted',
    !/@[A-Z0-9_]+@/.test(powerShellInstaller)
      && singleQuoted(powerShellInstaller, '\\$VERSION = ') === version
      && singleQuoted(powerShellInstaller, '\\$KEY_ID = ') === 'test-2026'
      && singleQuoted(powerShellInstaller, '\\$BASE_URL = ')
        === `https://releases.example/cosyncing/v${version}`
      && singleQuoted(powerShellInstaller, '\\$MINIMUM_BUN = ') === MINIMUM_BUN_RUNTIME_VERSION,
    /@[A-Z0-9_]+@/.exec(powerShellInstaller)?.[0] ?? 'no unrendered token');
  // Windows CNG exposes no Ed25519 algorithm identifier, so the Ed25519 key in this installer would be a
  // trust anchor it cannot use and a reader could believe it had been checked. Its absence is the claim.
  const p256KeyB64 = Buffer.from(`${p256PublicPem.trim()}\n`, 'utf8').toString('base64');
  const ed25519KeyB64 = Buffer.from(`${publicPem.trim()}\n`, 'utf8').toString('base64');
  check('the PowerShell installer carries the P-256 key and not the Ed25519 one',
    singleQuoted(powerShellInstaller, '\\$P256_PUBLIC_KEY_B64 = ') === p256KeyB64
      && !powerShellInstaller.includes(ed25519KeyB64)
      && !/PUBLIC_KEY_B64\s*=\s*'-----|\$PUBLIC_KEY_B64/.test(powerShellInstaller)
      // The shell installer is unchanged: it still carries both, because openssl can use either.
      && shellInstaller.includes(ed25519KeyB64) && shellInstaller.includes(p256KeyB64));
  check('the PowerShell installer carries the windows-x64 Bun rows it will fetch',
    singleQuoted(powerShellInstaller, '\\$BUN_TABLE = ').split('\n')
      .filter((row) => row.startsWith('windows-x64 '))
      .map((row) => row.split(' ')[1])
      .join(',') === 'bun-windows-x64.zip,bun-windows-x64-baseline.zip',
    singleQuoted(powerShellInstaller, '\\$BUN_TABLE = ').replaceAll('\n', ' | '));
  // One release, two installers, ONE set of digests. Rendered from one substitution table, so this is
  // true by construction — asserted anyway, because the failure it guards against (a Windows installer
  // pointing at a different artifact from the Unix one) is silent and only reachable on Windows.
  check('install.ps1 and install.sh were rendered from the same artifact and Bun tables',
    singleQuoted(powerShellInstaller, '\\$ARTIFACT_TABLE = ')
        === singleQuoted(shellInstaller, 'ARTIFACT_TABLE=')
      && singleQuoted(powerShellInstaller, '\\$BUN_TABLE = ') === singleQuoted(shellInstaller, 'BUN_TABLE=')
      && singleQuoted(powerShellInstaller, '\\$APP_ASSET = ') === RELEASE_JAVASCRIPT_APP_NAME
      && singleQuoted(powerShellInstaller, '\\$WEB_ASSET = ') === WEB_SIDECAR_NAME
      && singleQuoted(powerShellInstaller, '\\$ARTIFACT_TABLE = ').split('\n').length === 2,
    singleQuoted(powerShellInstaller, '\\$ARTIFACT_TABLE = ').replaceAll('\n', ' | '));
  // The host refusal has to ask the kernel, and this gate is the only place that can check it: the
  // Windows suite cannot make its host be an ARM64 machine, so it stubs the probe's answer and would
  // still pass against a script that asked the wrong API. `RuntimeInformation.OSArchitecture` on .NET
  // Framework is `GetNativeSystemInfo`, which reports the EMULATED architecture to an x64 process on an
  // ARM64 machine — so an installer deciding on it alone would admit the host the product refuses.
  check('install.ps1 asks the same kernel export brokerHostVerdict does about the native machine',
    powerShellInstaller.includes('IsWow64Process2')
      && powerShellInstaller.includes('0xAA64')
      // Present only as the fallback, and never the value a refusal is taken on.
      && !/^\s*\$machine(Architecture)? = \[System\.Runtime\.InteropServices\.RuntimeInformation\]/m
        .test(powerShellInstaller),
    powerShellInstaller.includes('IsWow64Process2') ? 'asks the kernel' : 'does not ask the kernel');
  // The template refuses to depend on module auto-load, because a 5.1 session that inherited a
  // PowerShell 7 PSModulePath cannot do it. `Get-Acl` was the known case; `Expand-Archive` is the same
  // dependency in Microsoft.PowerShell.Archive, on the one path that runs only when a host has no usable
  // Bun. `tar.exe` is already a hard requirement and bsdtar reads zip, so nothing needs either module.
  // Comments stripped, because the template NAMES these cmdlets to explain why it does not call them.
  const powerShellCode = powerShellInstaller
    .replace(/<#[\s\S]*?#>/g, '')
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n');
  const moduleBackedCall = /^\s*(Expand-Archive|Compress-Archive|Get-Acl|Set-Acl|Import-Module)\b/m
    .exec(powerShellCode);
  check('install.ps1 depends on no auto-loaded PowerShell module',
    moduleBackedCall === null,
    moduleBackedCall?.[1] ?? 'no module-backed cmdlet');
  // Every host refusal in this installer is replaceable only by rewriting the rendered script, never by
  // setting a variable — a refusal an environment variable can switch off is not a refusal. The way to
  // hold that is to pin the whole set of variables the script reads, so a future override cannot be added
  // quietly to make some test easier. `USERPROFILE` and `SystemRoot` are Windows' own.
  const environmentReads = [
    ...new Set([...powerShellInstaller.matchAll(/Get-EnvironmentValue '([A-Za-z_]+)'/g)].map((m) => m[1])),
  ].sort();
  const providerReads = [
    ...new Set([...powerShellInstaller.matchAll(/\$env:([A-Za-z_]+)/g)].map((m) => m[1])),
  ].sort();
  // `LOCALAPPDATA` joined when the all-in-one gained a desktop client: it is where Windows puts a
  // per-user unpackaged application, and it is Windows' own variable rather than a cosyncing knob.
  check('install.ps1 reads exactly the documented environment, and no refusal override',
    environmentReads.join(',')
        === 'APPDATA,BUN_INSTALL,COSYNCING_BUN_BIN,COSYNCING_HOME,COSYNCING_SKIP_BUN_INSTALL,LOCALAPPDATA,USERPROFILE'
      && providerReads.join(',') === 'SystemRoot'
      && powerShellInstaller.includes('refusing an elevated install'),
    `${environmentReads.join(',')} | $env:${providerReads.join(',$env:')}`);
  // On macOS a REOPENED /dev/tty delivers nothing to a reader that has put the terminal in raw mode, so
  // `setup < /dev/tty` drew its first question and could never be answered — a wizard frozen at the
  // language prompt. The descriptors the script inherited are fine, and `curl … | sh` only replaces stdin,
  // so setup takes its terminal from stdout or stderr and keeps /dev/tty only for the case where both were
  // redirected. This suite cannot give itself a terminal, so what is pinned here is the shape; the
  // behaviour is verified on a real host in the physical pass.
  check('setup is handed an inherited terminal, not a reopened /dev/tty, wherever one exists',
    /setup_with_terminal 0<&1 \|\| SETUP_STATUS=\$\?/.test(shellInstaller)
      && /setup_with_terminal 0<&2 \|\| SETUP_STATUS=\$\?/.test(shellInstaller)
      && /setup_with_terminal < \/dev\/tty \|\| SETUP_STATUS=\$\?/.test(shellInstaller)
      && /if \[ ! -t 1 \] && \[ ! -t 2 \] &&/.test(shellInstaller)
      // the old unconditional invocation must be gone, or the macOS path silently returns
      && !/"\$APPLICATION" setup < \/dev\/tty/.test(shellInstaller));

  // The npm takeover exists in both installers or Windows npm users keep hitting the wall the shell
  // installer just learned to get past. That the env list above is UNCHANGED is the other half of this:
  // consent is read from the console, and no variable answers it.
  check('install.ps1 offers the same npm takeover, answered on the console and by nothing else',
    /function Approve-NpmApplicationTakeover/.test(powerShellInstaller)
      && /-cne 'bun-js'/.test(powerShellInstaller)
      && /Read-Host "Replace it with cosyncing \$Version\? \[y\/N\]"/.test(powerShellInstaller)
      && /\[Console\]::IsInputRedirected/.test(powerShellInstaller)
      && /npm uninstall -g cosyncing/.test(powerShellInstaller)
      && /adopt_npm_application/.test(shellInstaller)
      && /npm uninstall -g cosyncing/.test(shellInstaller));

  // The web client is version-stamped, so an upgrade adds a root beside the previous one and used to
  // abandon it: two 38 MB trees on a Mac after one upgrade, referenced by nothing. Removing it is only
  // safe AFTER setup has pointed the service at the new root, so the ordering is pinned here, in both
  // installers, rather than only the fact that a removal exists somewhere.
  const shellPruneAt = shellInstaller.indexOf('Removed the superseded web client');
  const shellSetupAt = shellInstaller.indexOf('setup did not complete');
  const powerShellPruneAt = powerShellInstaller.indexOf('Removed the superseded web client');
  const powerShellSetupAt = powerShellInstaller.indexOf('setup did not complete');
  check('both installers retire superseded web roots, after setup rather than before it',
    /for SUPERSEDED in "\$INSTALL_DIR"\/cosyncing-web-\*/.test(shellInstaller)
      && shellPruneAt > shellSetupAt && shellSetupAt > 0
      && /function Get-SupersededWebRoot/.test(powerShellInstaller)
      && powerShellPruneAt > powerShellSetupAt && powerShellSetupAt > 0,
    `sh ${shellSetupAt}->${shellPruneAt} | ps1 ${powerShellSetupAt}->${powerShellPruneAt}`);

  // An application that is already open keeps running the bytes it started with: macOS `open -a`
  // activates it rather than restarting it, and on Windows its own open executable makes the directory
  // rename fail outright. Neither installer may report a launch that did not happen.
  check('an already-open desktop client is named, not silently left on the previous version',
    /pgrep -f "\$CLIENT_LAUNCH"/.test(shellInstaller)
      && /the desktop client is already running/.test(shellInstaller)
      && /it was already running, so the window on screen is still the previous version/
        .test(shellInstaller)
      && /Get-Process -Name 'cosyncing'/.test(powerShellInstaller)
      && /Windows cannot replace it while it /.test(powerShellInstaller));

  // Linux gets a .desktop entry and macOS an .app that LaunchServices indexes; Windows got neither, so
  // the client was reachable only from the run that launched it — after that first install there was
  // nowhere to open it from. Both halves are pinned: the entry itself, and the relocated-home launcher,
  // because the Start Menu starts the client with its own environment exactly as the desktop menu does.
  check('install.ps1 writes a Start Menu entry, carrying a relocated COSYNCING_HOME like the Linux launcher',
    /Join-Path \$appData 'Microsoft\\Windows\\Start Menu\\Programs'/.test(powerShellInstaller)
      && /'cosyncing\.lnk'/.test(powerShellInstaller)
      && /\$shortcut\.Save\(\)/.test(powerShellInstaller)
      && /Start Menu: \$shortcutPath/.test(powerShellInstaller)
      && /cosyncing-launch\.cmd/.test(powerShellInstaller)
      && /COSYNCING_HOME=\$stateHome/.test(powerShellInstaller)
      && /Exec=env COSYNCING_HOME=/.test(shellInstaller));

  // Windows has no rc file to append a line to, so an operator whose PATH lacks the install directory
  // has no convenient way to fix it -- `cosy` and `cosyncing` were simply not commands, in cmd or in
  // PowerShell. The installer that placed the binary now places the PATH entry too. Three properties are
  // pinned because each one, wrong, breaks something: the registry write preserves the existing value
  // KIND (rewriting user PATH as REG_SZ stops every other %VARIABLE% entry expanding), the presence test
  // is entry-wise rather than a substring match, and the change is broadcast (a terminal started from
  // Explorer inherits a cached environment, so without WM_SETTINGCHANGE the operator must sign out).
  check('install.ps1 puts the install directory on the user PATH, preserving the value kind',
    /Microsoft\.Win32\.Registry\]::CurrentUser\.OpenSubKey\('Environment', \$true\)/.test(powerShellInstaller)
      && /GetValueKind\('Path'\)/.test(powerShellInstaller)
      && /\$key\.SetValue\('Path', \$next, \$kind\)/.test(powerShellInstaller)
      && /DoNotExpandEnvironmentNames/.test(powerShellInstaller)
      && /-split ';'/.test(powerShellInstaller)
      && /0x001A/.test(powerShellInstaller)
      && /Add-UserPathEntry -Directory \$installDir/.test(powerShellInstaller));

  // A client left open cannot be replaced, and that used to be discovered at the very end: the operator
  // sat through the download, the signature check and the whole broker install to be told to close an app
  // and start again — and because the Start Menu entry is written by the step that was refused, the run
  // also left no way to open the client afterwards. The refusal now happens in preflight. Pinned by
  // position, since a check that runs late is exactly the bug: it must precede the install it guards.
  {
    const rule = powerShellInstaller.indexOf('function Assert-ClientNotRunning');
    const preflight = powerShellInstaller.indexOf('Assert-ClientNotRunning -ClientRoot $preflightRoot');
    const placement = powerShellInstaller.indexOf('Assert-ClientNotRunning -ClientRoot $CLIENT_ROOT');
    const installed = powerShellInstaller.indexOf('Write-Output "Installed cosyncing');
    check('install.ps1 refuses a running desktop client in preflight, before it installs anything',
      rule >= 0 && preflight >= 0 && placement >= 0 && installed >= 0
        && preflight < installed && installed < placement,
      `rule=${rule} preflight=${preflight} installed=${installed} placement=${placement}`);
  }

  // The shell installer's Windows refusal used to send an operator to WSL. It now names the installer
  // that actually works there, and this is the assertion that keeps the two from drifting apart again.
  check('the shell installer points a Windows shell at install.ps1 rather than at WSL',
    shellInstaller.includes('on Windows x64, run install.ps1 from PowerShell instead')
      && !/install into a WSL distribution/.test(shellInstaller));

  // ---- The four installers, and the clients they carry ----------------------------------------------
  //
  // Four published names, two templates, one substitution table. The all-in-one and the server installer
  // for a platform are the SAME script with one token rendered differently, which is what makes the pair
  // impossible to drift apart — so that is what is asserted, rather than the absence of a string that a
  // shared template necessarily contains in both.
  const installers = Object.fromEntries(
    Object.keys(BOOTSTRAP_TEMPLATES).map((name) =>
      [name, readFileSync(join(releaseDirectory, name), 'utf8')] as const),
  );
  const signedChecksums = readFileSync(join(releaseDirectory, 'SHA256SUMS'), 'utf8');
  check('all four installers are published, checksummed, and fully rendered',
    Object.keys(BOOTSTRAP_TEMPLATES).sort().join(',')
        === 'install-server.ps1,install-server.sh,install.ps1,install.sh'
      && Object.keys(installers).every((name) =>
        assembled.publishedFiles.includes(name)
          && signedChecksums.includes(`  ${name}\n`)
          && !/@[A-Z0-9_]+@/.test(installers[name]!)),
    Object.keys(installers).sort().join(','));
  check('each installer carries the mode its published name promises',
    singleQuoted(installers['install.sh']!, 'INSTALL_MODE=') === 'all'
      && singleQuoted(installers['install-server.sh']!, 'INSTALL_MODE=') === 'server'
      && singleQuoted(installers['install.ps1']!, '\\$INSTALL_MODE = ') === 'all'
      && singleQuoted(installers['install-server.ps1']!, '\\$INSTALL_MODE = ') === 'server');
  // A server installer is the all-in-one with one token changed. Anything else in it is a fork.
  check('the server installer differs from the all-in-one by exactly its mode',
    installers['install-server.sh']!.replace(/^INSTALL_MODE='server'$/m, "INSTALL_MODE='all'")
        === installers['install.sh']
      && installers['install-server.ps1']!
        .replace(/^\$INSTALL_MODE = 'server'$/m, "$INSTALL_MODE = 'all'")
        === installers['install.ps1']);

  const expectedClients = resolveClientArtifacts(clientDirectory, version);
  check('the release publishes one desktop client per host, discovered by prefix and extension',
    expectedClients.map((client) => `${client.host}:${client.name}`).join(',')
        === `linux-x64:cosyncing-client-${version}-linux-x64.tar.gz,`
          + `macos-arm64:cosyncing-client-${version}-macos-arm64-unsigned.zip,`
          + `windows-x64:cosyncing-client-${version}-windows-x64-unsigned.zip`
      && Object.keys(CLIENT_HOSTS).join(',') === 'linux-x64,macos-arm64,windows-x64',
    expectedClients.map((client) => client.name).join(', '));
  const clientRowText = (rows: ReturnType<typeof parseRenderedClientTable>): string =>
    rows.map((row) => `${row.host} ${row.name} ${row.sha256} ${row.size}`).sort().join('\n');
  const expectedClientRows = clientRowText(expectedClients);
  check('every installer carries the same client table, with the digests the clients actually have',
    Object.values(installers)
      .every((script) => clientRowText(parseRenderedClientTable(script)) === expectedClientRows)
      && expectedClients.every((client) =>
        sha256(readFileSync(join(releaseDirectory, client.name))) === client.sha256
          && statSync(join(releaseDirectory, client.name)).size === client.size),
    expectedClientRows.replaceAll('\n', ' | '));
  check('the signed checksum list covers every client artifact',
    expectedClients.every((client) =>
      signedChecksums.includes(`${client.sha256}  ${client.name}\n`))
      // Not in the manifest, and deliberately: the manifest describes what a broker can upgrade ITSELF
      // to, and a GUI client is not a broker upgrade.
      && !readFileSync(join(releaseDirectory, 'release-manifest.json'), 'utf8')
        .includes('cosyncing-client-'));
  // A release assembled with a client missing for one host must fail rather than publish an all-in-one
  // installer that silently degrades to a server install wherever the gap is.
  const incompleteClients = join(root, 'clients-incomplete');
  mkdirSync(incompleteClients, { recursive: true });
  cpSync(
    join(clientDirectory, `cosyncing-client-${version}-linux-x64.tar.gz`),
    join(incompleteClients, `cosyncing-client-${version}-linux-x64.tar.gz`),
  );
  let incompleteRejected = '';
  try {
    assembleRelease({
      artifactDirectory,
      evidenceDirectory,
      clientDirectory: incompleteClients,
      outputDirectory: join(root, 'incomplete-client-release'),
      baseUrl: `https://releases.example/cosyncing/v${version}`,
      version,
      sourceCommit: commit,
      publishedAt: buildDate,
      keyId: 'test-2026',
      privateKeyPem: privatePem,
      publicKeyPem: publicPem,
      p256PrivateKeyPem: p256PrivatePem,
      p256PublicKeyPem: p256PublicPem,
    });
  } catch (error) {
    incompleteRejected = error instanceof Error ? error.message : String(error);
  }
  check('assembly refuses a client set missing a desktop host',
    /expected exactly one macos-arm64 client artifact/.test(incompleteRejected),
    incompleteRejected.slice(0, 160));
  const thirdPartyNotices = readFileSync(
    join(releaseDirectory, 'THIRD_PARTY_NOTICES.txt'),
    'utf8',
  );
  check('release inventory and notices distinguish external Bun from distributed dependencies',
    inventory.format === 'cosyncing-javascript-software-inventory'
      && inventory.externalRuntime.bundled === false
      && inventory.releaseArtifacts.length === 5
      && thirdPartyNotices.includes('Bun is installed separately')
      && !thirdPartyNotices.includes('Bun 1.3.8 runtime')
      && thirdPartyNotices.includes('app/assets/NOTICES')
      && inventory.packages.filter((item: any) => !item.internal)
        .every((item: any) => thirdPartyNotices.includes(`${item.name}@${item.version}`)));

  const fakeBin = join(root, 'fake-bin');
  mkdirSync(fakeBin);
  writeFakeCurl(join(fakeBin, 'curl'));
  writeFakeBun(join(fakeBin, 'bun'));
  const home = join(root, 'install-home');
  mkdirSync(home);
  writeFileSync(join(home, '.bashrc'), '# preserve\n');
  const install = await run(['bash', join(releaseDirectory, 'install-server.sh')], {
    cwd: root,
    env: {
      PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: home,
      FAKE_RELEASE_ROOT: releaseDirectory,
      LANG: 'C.UTF-8',
    },
  });
  const binary = join(home, '.cosyncing', 'bin', 'cosyncing');
  const alias = join(home, '.cosyncing', 'bin', 'cosy');
  if (install.exitCode !== 0) throw new Error(`fixture installation failed: ${install.stderr} ${install.stdout}`);
  const installedReceipt = readFileSync(join(home, '.cosyncing', 'bootstrap-receipt'), 'utf8');
  check('bootstrap verifies, installs user-owned bundle+relative alias, and records ownership',
    install.exitCode === 0 && existsSync(binary) && lstatSync(binary).isFile()
      && lstatSync(alias).isSymbolicLink() && readlinkSync(alias) === 'cosyncing'
      && installedReceipt.includes(`sha256=${sha256(readFileSync(binary))}`),
    install.stderr.trim());
  // A packaged broker resolves its web client as `<directory of the application>/cosyncing-web-<version>`.
  // Before this change the installer placed no web client at all, so every curl install came up with a
  // broker whose own UI was missing and no error saying so.
  const installedWebRoot = join(home, '.cosyncing', 'bin', `cosyncing-web-${version}`);
  check('bootstrap installs the paired web client where a packaged broker looks for it',
    existsSync(join(installedWebRoot, 'index.html'))
      && existsSync(join(installedWebRoot, 'assets', 'NOTICES'))
      && lstatSync(installedWebRoot).isDirectory() && !lstatSync(installedWebRoot).isSymbolicLink()
      && install.stdout.includes(`Web client: ${installedWebRoot}`),
    install.stdout.trim().split('\n').slice(-6).join(' | '));
  check('the receipt records the installer-owned distribution, the web root, and the resolved runtime',
    installedReceipt.includes('schemaVersion=2\n')
      && installedReceipt.includes('distribution=bootstrap-js\n')
      && installedReceipt.includes('target=universal\n')
      && installedReceipt.includes(`webRoot=${installedWebRoot}\n`)
      && installedReceipt.includes(`runtime=${join(fakeBin, 'bun')}\n`),
    installedReceipt.trim().replaceAll('\n', ' | '));
  check('bootstrap never edits shell startup files and prints the absolute setup command',
    readFileSync(join(home, '.bashrc'), 'utf8') === '# preserve\n'
      && install.stdout.includes(`'${binary}' setup`) && install.stdout.includes('PATH was not changed'));
  check('a capable openssl reports the signature as verified, not merely checked',
    /Release signature: verified/.test(install.stdout)
      && /Artifact digests: matched/.test(install.stdout),
    install.stdout.trim().split('\n').slice(-4).join(' | '));
  // The server installer is the broker half and nothing else: no client, no setup, no pairing offer.
  check('the server installer places no client and hands setup back to the operator',
    !existsSync(join(home, '.cosyncing', 'client'))
      && !existsSync(join(home, '.cosyncing', 'client-pairing.json'))
      && !existsSync(join(home, '.local', 'share', 'applications', 'cosyncing.desktop'))
      && install.stdout.includes('PATH was not changed')
      && !/Desktop client|Pairing handoff|Running setup/.test(install.stdout));

  // ---- Taking over an npm install ------------------------------------------------------------------
  //
  // The npm package is an acquisition artifact and `cosyncing setup` copies its bundle to exactly the path
  // this installer owns, writing no receipt. So a missing receipt is the ordinary state of every npm
  // install, and refusing all of them refused the whole installed base — before the desktop-client step,
  // so neither half was updated. These pin the three outcomes: refuse when it cannot ask, refuse when told
  // no, and replace exactly one file when told yes.
  const npmApplication = javaScriptAppScript(version, commit, buildDate, 'bun-js');
  function npmOwnedHome(name: string, application: string): string {
    const home = join(root, name);
    const state = join(home, '.cosyncing');
    mkdirSync(join(state, 'bin'), { recursive: true });
    // The installer refuses a state home another user can read, and mkdir honours the suite's umask.
    chmodSync(state, 0o700);
    chmodSync(join(state, 'bin'), 0o700);
    writeFileSync(join(state, 'bin', 'cosyncing'), application, { mode: 0o755 });
    // The state a takeover must not touch. Compared byte for byte afterwards.
    writeFileSync(join(state, 'config.json'), '{"fixture":"config"}\n');
    writeFileSync(join(state, 'transport-peers.json'), '{"fixture":"peers"}\n');
    return home;
  }
  // The terminal is the one host property this suite cannot give itself, so the rendered script's
  // `/dev/tty` is repointed at a file holding the answer — the same technique the handoff case below uses
  // to reach the other side of the same branch.
  function releaseAnswering(name: string, answer: string): string {
    const directory = join(root, name);
    cpSync(releaseDirectory, directory, { recursive: true });
    const answerPath = join(directory, 'tty-answer');
    writeFileSync(answerPath, answer);
    writeFileSync(
      join(directory, 'install-server.sh'),
      readFileSync(join(directory, 'install-server.sh'), 'utf8').replaceAll('/dev/tty', answerPath),
      { mode: 0o755 },
    );
    return directory;
  }
  async function installOver(home: string, from: string): Promise<{
    exitCode: number; stdout: string; stderr: string;
  }> {
    return run(['bash', join(from, 'install-server.sh')], {
      cwd: root,
      stage: 'npm takeover',
      env: {
        PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        HOME: home,
        FAKE_RELEASE_ROOT: from,
        LANG: 'C.UTF-8',
      },
    });
  }
  function stateSurvived(home: string): boolean {
    return readFileSync(join(home, '.cosyncing', 'config.json'), 'utf8') === '{"fixture":"config"}\n'
      && readFileSync(join(home, '.cosyncing', 'transport-peers.json'), 'utf8') === '{"fixture":"peers"}\n';
  }

  const npmUnattendedHome = npmOwnedHome('npm-unattended-home', npmApplication);
  const npmUnattended = await installOver(npmUnattendedHome, releaseDirectory);
  check('a run that cannot ask refuses the npm install and names the way to stay on npm',
    npmUnattended.exitCode !== 0
      && npmUnattended.stderr.includes('npm update -g cosyncing')
      && !existsSync(join(npmUnattendedHome, '.cosyncing', 'bootstrap-receipt'))
      && readFileSync(join(npmUnattendedHome, '.cosyncing', 'bin', 'cosyncing'), 'utf8') === npmApplication
      && stateSurvived(npmUnattendedHome),
    npmUnattended.stderr.trim().slice(0, 220));

  const declinedHome = npmOwnedHome('npm-declined-home', npmApplication);
  const declined = await installOver(declinedHome, releaseAnswering('npm-declined-release', 'n\n'));
  check('answering no leaves the npm install exactly where it was',
    declined.exitCode !== 0
      && declined.stderr.includes('left the npm install in place')
      && !existsSync(join(declinedHome, '.cosyncing', 'bootstrap-receipt'))
      && readFileSync(join(declinedHome, '.cosyncing', 'bin', 'cosyncing'), 'utf8') === npmApplication
      && stateSurvived(declinedHome),
    declined.stderr.trim().slice(0, 220));

  const adoptedHome = npmOwnedHome('npm-adopted-home', npmApplication);
  const adopted = await installOver(adoptedHome, releaseAnswering('npm-adopted-release', 'y\n'));
  const adoptedBinary = join(adoptedHome, '.cosyncing', 'bin', 'cosyncing');
  const adoptedReceipt = existsSync(join(adoptedHome, '.cosyncing', 'bootstrap-receipt'))
    ? readFileSync(join(adoptedHome, '.cosyncing', 'bootstrap-receipt'), 'utf8')
    : '';
  check('answering yes replaces the application, records ownership, and touches nothing else',
    adopted.exitCode === 0
      && readFileSync(adoptedBinary, 'utf8') !== npmApplication
      && adoptedReceipt.includes('distribution=bootstrap-js\n')
      && adoptedReceipt.includes(`sha256=${sha256(readFileSync(adoptedBinary))}`)
      && adopted.stdout.includes(`Installed cosyncing ${version} at ${adoptedBinary}`)
      && stateSurvived(adoptedHome),
    `${adopted.exitCode} | ${adopted.stderr.trim().slice(0, 160)}`);

  // The prompt is not a general overwrite. A file that will not identify itself as a packaged npm
  // cosyncing is refused with the original message, whatever the operator would have answered.
  const foreignHome = npmOwnedHome('foreign-home', '#!/usr/bin/env bash\nexit 3\n');
  const foreign = await installOver(foreignHome, releaseAnswering('foreign-release', 'y\n'));
  check('an application that does not identify as an npm cosyncing is still refused outright',
    foreign.exitCode !== 0
      && foreign.stderr.includes('no safe bootstrap ownership receipt')
      && !existsSync(join(foreignHome, '.cosyncing', 'bootstrap-receipt'))
      && readFileSync(join(foreignHome, '.cosyncing', 'bin', 'cosyncing'), 'utf8')
        === '#!/usr/bin/env bash\nexit 3\n',
    foreign.stderr.trim().slice(0, 220));

  // An install this installer already owns keeps upgrading with no question asked: the receipt is there,
  // so the takeover branch is never reached.
  const reinstalled = await installOver(adoptedHome, releaseDirectory);
  check('an install the receipt already covers upgrades without asking anything',
    reinstalled.exitCode === 0
      && !/Replace it with cosyncing|installed from the npm package|npm update -g/.test(reinstalled.stdout)
      && stateSurvived(adoptedHome),
    `${reinstalled.exitCode} | ${reinstalled.stdout.trim().split('\n').slice(-3).join(' | ')}`);

  // ---- The all-in-one installer -----------------------------------------------------------------
  //
  // `runSupervised` execs through `setsid`, so this child is in a session of its own with no controlling
  // terminal — which is exactly the `curl … | sh` case the tty branch exists for, arrived at honestly
  // rather than by an environment override. So the default all-in-one run here places the client and then
  // stops at setup, and the run that gets past setup is the one that stubs the terminal below.
  const allInOneHome = join(root, 'all-in-one-home');
  mkdirSync(allInOneHome);
  const allInOne = await run(['bash', join(releaseDirectory, 'install.sh')], {
    cwd: root,
    stage: 'all-in-one install',
    env: {
      PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: allInOneHome,
      DISPLAY: ':0',
      FAKE_RELEASE_ROOT: releaseDirectory,
      LANG: 'C.UTF-8',
    },
  });
  const installedClient = join(allInOneHome, '.cosyncing', 'client');
  const desktopEntry = join(
    allInOneHome, '.local', 'share', 'applications', 'cosyncing.desktop',
  );
  check('the all-in-one installs the desktop client beside the broker, with a launcher entry',
    allInOne.exitCode === 0
      && existsSync(join(allInOneHome, '.cosyncing', 'bin', 'cosyncing'))
      && lstatSync(installedClient).isDirectory() && !lstatSync(installedClient).isSymbolicLink()
      && existsSync(join(installedClient, 'cosyncing'))
      && existsSync(join(installedClient, 'LICENSE.txt'))
      && readFileSync(desktopEntry, 'utf8').includes(`Exec=${join(installedClient, 'cosyncing')}\n`)
      && allInOne.stdout.includes(`Desktop client: ${installedClient}`),
    `${allInOne.exitCode}: ${allInOne.stdout.trim().split('\n').slice(-4).join(' | ')} ${allInOne.stderr.trim().slice(0, 200)}`);

  // The desktop menu and LaunchServices both start the client with their own environment, not the one the
  // installer ran in. A relocated home therefore has to travel in the launcher, or the client reads
  // ~/.cosyncing, finds no handoff, and asks the operator to pair by hand for no visible reason.
  const relocatedHome = join(root, 'relocated-home');
  const relocatedState = join(relocatedHome, 'elsewhere');
  mkdirSync(relocatedHome);
  const relocated = await run(['sh', join(releaseDirectory, 'install.sh')], {
    cwd: root,
    stage: 'all-in-one relocated home',
    env: {
      PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: relocatedHome,
      COSYNCING_HOME: relocatedState,
      DISPLAY: ':0',
      FAKE_RELEASE_ROOT: releaseDirectory,
      LANG: 'C.UTF-8',
    },
  });
  const relocatedEntry = join(relocatedHome, '.local', 'share', 'applications', 'cosyncing.desktop');
  check('a relocated home travels in the launcher entry, so the client can still find the handoff',
    relocated.exitCode === 0
      && readFileSync(relocatedEntry, 'utf8').includes(
        `Exec=env COSYNCING_HOME=${relocatedState} ${join(relocatedState, 'client', 'cosyncing')}\n`),
    `${relocated.exitCode}: ${readFileSync(relocatedEntry, 'utf8').split('\n').find((line) => line.startsWith('Exec=')) ?? 'no Exec line'}`);

  // The macOS half of the same rule cannot run here, so pin the call instead: `open` starts the app with
  // LaunchServices' environment and drops the caller's.
  check('the macOS launch hands COSYNCING_HOME to open(1) rather than relying on inheritance',
    /open --env "COSYNCING_HOME=\$STATE_HOME" -a/.test(installers['install.sh']!),
    installers['install.sh']!.split('\n')
      .filter((line) => /^\s*(?:if |elif )?open /.test(line)).join(' | ').slice(0, 200));

  // A sandboxed macOS client does not have this script's $HOME: the kernel rewrites it to the app's
  // container, so an offer written into the broker's state home is one the client is denied. Proven on a
  // real Mac with two identical copies, only the container one ever read. The offer therefore goes where
  // the client's own home resolves to — and the launch must then NOT pass COSYNCING_HOME, because
  // pointing a sandboxed process at an absolute path outside its container only makes the read fail.
  // The identifier comes from the placed bundle and the entitlement from its signature, so an unsandboxed
  // build of the same client keeps the ordinary path with no second rule to maintain.
  check('a sandboxed macOS client is handed the offer in its container, and no home to look outside it',
    /CLIENT_CONTAINER="\$HOME\/Library\/Containers\/\$BUNDLE_ID\/Data"/.test(shellInstaller)
      && /PlistBuddy -c 'Print :CFBundleIdentifier'/.test(shellInstaller)
      && /codesign -d --entitlements - --xml "\$CLIENT_ROOT"/.test(shellInstaller)
      && /HANDOFF_HOME="\$CLIENT_CONTAINER\/\.cosyncing"/.test(shellInstaller)
      && /PAIRING_FILE="\$HANDOFF_HOME\/client-pairing\.json"/.test(shellInstaller)
      // the container launch is its own branch, and it carries no --env
      && /elif \[ -n "\$CLIENT_CONTAINER" \]; then\n(?:.*\n)*?\s+if open -a "\$CLIENT_LAUNCH"/
        .test(shellInstaller)
      // and the offer is never staged anywhere but the home the client actually reads
      && !/mktemp "\$STATE_HOME\/\.client-pairing/.test(shellInstaller));

  // Consent is the point of `setup`, and a pipeline has no terminal to give it. The installer must stop
  // and say so rather than passing --yes on the operator's behalf.
  check('with no terminal the all-in-one stops at setup instead of consenting for the operator',
    allInOne.stdout.includes('No terminal is attached, so setup was not run')
      && allInOne.stdout.includes(`'${join(allInOneHome, '.cosyncing', 'bin', 'cosyncing')}' setup`)
      && !allInOne.stdout.includes('fixture setup completed')
      && !existsSync(join(allInOneHome, '.cosyncing', 'client-pairing.json')),
    allInOne.stdout.trim().split('\n').slice(-3).join(' | '));
  // Stopping is a normal outcome here, so it must read like one. The probe that decides it opens
  // /dev/tty, and on a host where that open fails the shell complains unless stderr is silenced first.
  check('stopping at setup is quiet: the headless probe leaks no shell error',
    allInOne.stderr.trim() === '',
    allInOne.stderr.trim().slice(0, 300));
  // Comments stripped, because both templates NAME these flags to explain why they are never passed.
  const withoutComments = (script: string): string => script
    .replace(/<#[\s\S]*?#>/g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n');
  check('no installer ever passes setup a consent flag on the operator\'s behalf',
    Object.values(installers).map(withoutComments).every((script) =>
      !script.includes('--yes') && !script.includes('--accept-managed-runtime-ownership')));

  // A machine with no display server is where the BROKER belongs and the client does not. Skipped and
  // said out loud, not a failure: the install that matters on such a host has already succeeded.
  const headlessHome = join(root, 'headless-home');
  mkdirSync(headlessHome);
  const headless = await run(['bash', join(releaseDirectory, 'install.sh')], {
    cwd: root,
    stage: 'all-in-one headless',
    env: {
      PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: headlessHome,
      FAKE_RELEASE_ROOT: releaseDirectory,
      LANG: 'C.UTF-8',
    },
  });
  check('a headless Linux host gets the broker, is told why it gets no client, and still succeeds',
    headless.exitCode === 0
      && existsSync(join(headlessHome, '.cosyncing', 'bin', 'cosyncing'))
      && !existsSync(join(headlessHome, '.cosyncing', 'client'))
      && /Desktop client: skipped — this host has no display server/.test(headless.stdout),
    `${headless.exitCode}: ${headless.stdout.trim().split('\n').slice(-3).join(' | ')}`);

  // The documented one-liner pipes into `sh`, and on Debian and Ubuntu `sh` is dash. Running every case
  // under bash hid a fatal defect: `:` is a POSIX special built-in, so a redirection error on one exits
  // the shell outright, and dash left the headless path dead at exit 2 with the broker installed and
  // nothing said. macOS never showed it, because there `sh` is bash. Run the headless path under the
  // shell the docs actually name.
  const shHome = join(root, 'headless-home-sh');
  mkdirSync(shHome);
  const headlessSh = await run(['sh', join(releaseDirectory, 'install.sh')], {
    cwd: root,
    stage: 'all-in-one headless under sh',
    env: {
      PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: shHome,
      FAKE_RELEASE_ROOT: releaseDirectory,
      LANG: 'C.UTF-8',
    },
  });
  check('the headless path reaches its own stop message under sh, not only under bash',
    headlessSh.exitCode === 0
      && existsSync(join(shHome, '.cosyncing', 'bin', 'cosyncing'))
      && headlessSh.stdout.includes('No terminal is attached, so setup was not run')
      && headlessSh.stderr.trim() === '',
    `${headlessSh.exitCode}: ${headlessSh.stdout.trim().split('\n').slice(-3).join(' | ')} ${headlessSh.stderr.trim().slice(0, 200)}`);

  // A script the docs tell people to pipe into `sh` must say it is an sh script, or the two disagree and
  // only one of them is tested.
  check('the shell installers declare the shell the documentation pipes them into',
    Object.entries(installers)
      .filter(([name]) => name.endsWith('.sh'))
      .every(([, script]) => script.startsWith('#!/bin/sh\n')),
    Object.entries(installers)
      .filter(([name]) => name.endsWith('.sh'))
      .map(([name, script]) => `${name}: ${script.split('\n')[0]}`).join(' | '));

  // Linux arm64 publishes no client. The all-in-one finishes as a server install and names the reason,
  // which is the difference between an unsupported host and a broken release.
  const armUname = join(root, 'uname-linux-arm64');
  mkdirSync(armUname, { recursive: true });
  writeFileSync(join(armUname, 'uname'),
    '#!/usr/bin/env bash\ncase "${1:-}" in\n  -m) echo aarch64 ;;\n  *) echo Linux ;;\nesac\n',
    { mode: 0o755 });
  const armHome = join(root, 'linux-arm64-home');
  mkdirSync(armHome);
  const armInstall = await run(['bash', join(releaseDirectory, 'install.sh')], {
    cwd: root,
    stage: 'all-in-one linux-arm64',
    env: {
      PATH: `${armUname}:${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: armHome,
      DISPLAY: ':0',
      FAKE_RELEASE_ROOT: releaseDirectory,
      LANG: 'C.UTF-8',
    },
  });
  check('a host this release publishes no client for finishes as a server install and says so',
    armInstall.exitCode === 0
      && existsSync(join(armHome, '.cosyncing', 'bin', 'cosyncing'))
      && !existsSync(join(armHome, '.cosyncing', 'client'))
      && /Desktop client: skipped — this release publishes no desktop client for linux-arm64/
        .test(armInstall.stdout),
    `${armInstall.exitCode}: ${armInstall.stdout.trim().split('\n').slice(-3).join(' | ')}`);

  // A client is held to the artifacts' own rule. Nothing about it being "just the GUI" relaxes the pin.
  const tamperedClientRelease = join(root, 'tampered-client-release');
  cpSync(releaseDirectory, tamperedClientRelease, { recursive: true });
  writeFileSync(
    join(tamperedClientRelease, `cosyncing-client-${version}-linux-x64.tar.gz`),
    'swapped client\n',
  );
  const tamperedClientHome = join(root, 'tampered-client-home');
  mkdirSync(tamperedClientHome);
  const tamperedClient = await run(['bash', join(tamperedClientRelease, 'install.sh')], {
    cwd: root,
    stage: 'all-in-one tampered client',
    env: {
      PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: tamperedClientHome,
      DISPLAY: ':0',
      FAKE_RELEASE_ROOT: tamperedClientRelease,
      LANG: 'C.UTF-8',
    },
  });
  check('a substituted desktop client is refused against the digest embedded in the installer',
    tamperedClient.exitCode !== 0
      && /checksum verification failed|size does not match/.test(tamperedClient.stderr)
      && !existsSync(join(tamperedClientHome, '.cosyncing', 'client')),
    tamperedClient.stderr.trim().slice(0, 200));

  // The whole tail, end to end. The terminal is the one host property this suite cannot give itself, so
  // the RENDERED script is rewritten in a copy — the same technique the PowerShell suite uses for the
  // machine architecture — and every other step is the real one: setup runs, the broker is asked for its
  // listener URL and a pairing offer, and the offer is written where the client reads it.
  const handoffRelease = join(root, 'handoff-release');
  cpSync(releaseDirectory, handoffRelease, { recursive: true });
  writeFileSync(
    join(handoffRelease, 'install.sh'),
    readFileSync(join(handoffRelease, 'install.sh'), 'utf8').replaceAll('/dev/tty', '/dev/null'),
    { mode: 0o755 },
  );
  const handoffHome = join(root, 'handoff-home');
  mkdirSync(handoffHome);
  const handoff = await run(['bash', join(handoffRelease, 'install.sh')], {
    cwd: root,
    stage: 'all-in-one handoff',
    // The installer launches the client at the very end and detaches it. The fixture client exits at
    // once, so this is the "already on its way out" case the grace window exists for, not a leak.
    strayGraceMs: 5_000,
    env: {
      PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: handoffHome,
      DISPLAY: ':0',
      FAKE_RELEASE_ROOT: handoffRelease,
      LANG: 'C.UTF-8',
    },
  });
  const handoffFile = join(handoffHome, '.cosyncing', 'client-pairing.json');
  const handoffDocument = existsSync(handoffFile)
    ? JSON.parse(readFileSync(handoffFile, 'utf8'))
    : null;
  check('with a terminal the all-in-one runs setup and launches the client it installed',
    handoff.exitCode === 0
      && handoff.stdout.includes('Running setup. It shows its plan and asks before changing anything.')
      && handoff.stdout.includes('fixture setup completed')
      && handoff.stdout.includes(`Started ${join(handoffHome, '.cosyncing', 'client', 'cosyncing')}`),
    `${handoff.exitCode}: ${handoff.stdout.trim().split('\n').slice(-4).join(' | ')} ${handoff.stderr.trim().slice(0, 200)}`);
  // A host with no client and a terminal to run setup on. The broker install and setup are the point
  // there; an offer written for a client that does not exist would be a one-use credential on disk that
  // nothing can redeem.
  const headlessHandoffHome = join(root, 'headless-handoff-home');
  mkdirSync(headlessHandoffHome);
  const headlessHandoff = await run(['bash', join(handoffRelease, 'install.sh')], {
    cwd: root,
    stage: 'all-in-one headless handoff',
    env: {
      PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: headlessHandoffHome,
      FAKE_RELEASE_ROOT: handoffRelease,
      LANG: 'C.UTF-8',
    },
  });
  check('a host with no client runs setup and writes no pairing offer for a client that is not there',
    headlessHandoff.exitCode === 0
      && headlessHandoff.stdout.includes('fixture setup completed')
      && headlessHandoff.stdout.includes('Pairing handoff: not needed, no desktop client was installed')
      && !existsSync(join(headlessHandoffHome, '.cosyncing', 'client-pairing.json'))
      && !existsSync(join(headlessHandoffHome, '.cosyncing', 'client')),
    `${headlessHandoff.exitCode}: ${headlessHandoff.stdout.trim().split('\n').slice(-3).join(' | ')}`);
  check('the pairing offer is written where the client reads it, owner-only, with the fields it needs',
    handoffDocument?.qr === 'https://pair.example/v3#fixture'
      && handoffDocument?.brokerUrl === 'http://127.0.0.1:7734'
      && handoffDocument?.expiresAt === '2026-07-17T00:05:00.000Z'
      && (statSync(handoffFile).mode & 0o777) === 0o600
      && handoff.stdout.includes(`Pairing handoff: ${handoffFile}`),
    handoffDocument === null
      ? 'no handoff document'
      : `${JSON.stringify(handoffDocument)} mode=${(statSync(handoffFile).mode & 0o777).toString(8)}`);

  // The upgrade case, end to end. A version change lands the new web client BESIDE the previous root
  // rather than over it, so the fixture puts two of them in the install directory — one shaped like a
  // release this installer placed, one a symlink that must be skipped rather than followed — and the
  // next run has to clear the first and leave the second. Headless, so no client is placed and no launch
  // is attempted: the property under test is the web root, and setup still runs.
  const supersededHome = join(root, 'superseded-web-home');
  mkdirSync(supersededHome);
  async function installIntoSuperseded(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return run(['bash', join(handoffRelease, 'install.sh')], {
      cwd: root,
      stage: 'superseded web root',
      env: {
        PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        HOME: supersededHome,
        FAKE_RELEASE_ROOT: handoffRelease,
        LANG: 'C.UTF-8',
      },
    });
  }
  const supersededBin = join(supersededHome, '.cosyncing', 'bin');
  await installIntoSuperseded();
  const abandonedWeb = join(supersededBin, 'cosyncing-web-0.0.0-previous');
  mkdirSync(abandonedWeb);
  writeFileSync(join(abandonedWeb, 'index.html'), 'the previous release\n');
  // A directory outside the install tree, reached only through a link that carries the matching name.
  // Removing what a symlink points at is how a prune becomes a delete of someone else's data.
  const linkTarget = join(supersededHome, 'somewhere-else');
  mkdirSync(linkTarget);
  writeFileSync(join(linkTarget, 'index.html'), 'not ours\n');
  symlinkSync(linkTarget, join(supersededBin, 'cosyncing-web-0.0.0-linked'));
  const supersededUpgrade = await installIntoSuperseded();
  check('an upgrade clears the superseded web roots beside the new one, and follows no symlink out',
    supersededUpgrade.exitCode === 0
      && !existsSync(abandonedWeb)
      && existsSync(join(linkTarget, 'index.html'))
      && existsSync(join(supersededBin, 'cosyncing-web-0.0.0-linked'))
      && existsSync(join(supersededBin, `cosyncing-web-${version}`))
      && existsSync(join(supersededBin, 'cosyncing'))
      && supersededUpgrade.stdout.includes(`Removed the superseded web client: ${abandonedWeb}`)
      && !supersededUpgrade.stdout.includes('cosyncing-web-0.0.0-linked'),
    `${supersededUpgrade.exitCode}: ${supersededUpgrade.stdout.trim().split('\n').slice(-3).join(' | ')}`);

  // The server installer does not run setup, so the service is still the previous broker and still
  // serving out of one of these. It names them and removes nothing.
  const namedOnlyWeb = join(supersededBin, 'cosyncing-web-0.0.0-named-only');
  mkdirSync(namedOnlyWeb);
  const serverUpgrade = await run(['bash', join(handoffRelease, 'install-server.sh')], {
    cwd: root,
    stage: 'superseded web root, server install',
    env: {
      PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: supersededHome,
      FAKE_RELEASE_ROOT: handoffRelease,
      LANG: 'C.UTF-8',
    },
  });
  check('the server installer names a superseded web root and removes nothing, having run no setup',
    serverUpgrade.exitCode === 0
      && existsSync(namedOnlyWeb)
      && serverUpgrade.stdout.includes(`A previous web client is still at ${namedOnlyWeb}`)
      && !serverUpgrade.stdout.includes('Removed the superseded web client'),
    `${serverUpgrade.exitCode}: ${serverUpgrade.stdout.trim().split('\n').slice(-3).join(' | ')}`);

  // A client that is already open. `pgrep` is the one host fact this suite cannot arrange without
  // leaving a real process behind, so it is stubbed to answer for the installed client path and for
  // nothing else — the same technique the terminal and the machine architecture use above.
  const runningClientBin = join(root, 'running-client-bin');
  mkdirSync(runningClientBin);
  writeFileSync(join(runningClientBin, 'pgrep'), `#!/usr/bin/env bash
# A pgrep that reports the desktop client as running, and nothing else.
for argument in "$@"; do
  case "$argument" in */.cosyncing/client/cosyncing) exit 0 ;; esac
done
exit 1
`, { mode: 0o755 });
  const runningClientHome = join(root, 'running-client-home');
  mkdirSync(runningClientHome);
  const runningClient = await run(['bash', join(handoffRelease, 'install.sh')], {
    cwd: root,
    stage: 'already-running client',
    env: {
      PATH: `${runningClientBin}:${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: runningClientHome,
      DISPLAY: ':0',
      FAKE_RELEASE_ROOT: handoffRelease,
      LANG: 'C.UTF-8',
    },
  });
  check('an open client is updated on disk, told about, and handed no offer it cannot read',
    runningClient.exitCode === 0
      && existsSync(join(runningClientHome, '.cosyncing', 'client', 'cosyncing'))
      && runningClient.stdout.includes('the desktop client is already running')
      && runningClient.stdout.includes('it was already running, so the window on screen is still the')
      && !existsSync(join(runningClientHome, '.cosyncing', 'client-pairing.json'))
      && !/^Started |^Launched /m.test(runningClient.stdout),
    `${runningClient.exitCode}: ${runningClient.stdout.trim().split('\n').slice(-4).join(' | ')}`);

  // Stock macOS ships LibreSSL, which cannot load an Ed25519 SPKI key at all — the real physical failure.
  // It has no trouble with ECDSA P-256, so the stub refuses Ed25519 SPECIFICALLY rather than refusing every
  // key: a stub that failed both would model a host that does not exist and would hide the branch that
  // matters. Every Mac takes this path, and it is the one that decides whether a Mac gets a cryptographic
  // check or bytes delivered by TLS alone.
  const libreSslBin = join(root, 'libressl-bin');
  mkdirSync(libreSslBin);
  writeFakeCurl(join(libreSslBin, 'curl'));
  writeFakeBun(join(libreSslBin, 'bun'));
  const libreSslOpenssl = `#!/usr/bin/env bash
# Reproduces LibreSSL 3.3.6: every other subcommand works, and so does every other key type, but anything
# that must LOAD an Ed25519 public key fails the way LibreSSL fails ("unable to load Public Key").
subject=''
previous=''
for argument in "$@"; do
  case "$previous" in
    -in|-inkey|-verify) subject="$argument" ;;
  esac
  previous="$argument"
done
case "\${1:-}" in
  pkey|pkeyutl)
    if [ -z "$subject" ] || /usr/bin/openssl pkey -pubin -in "$subject" -noout -text 2>/dev/null \
        | grep -qi 'ED25519'; then
      echo 'unable to load Public Key' >&2
      echo 'digital envelope routines: unsupported algorithm' >&2
      exit 1
    fi ;;
esac
exec /usr/bin/openssl "$@"
`;
  writeFileSync(join(libreSslBin, 'openssl'), libreSslOpenssl, { mode: 0o755 });

  // A host whose openssl can load NEITHER algorithm is the only one that may degrade. Separated from the
  // LibreSSL stub above so "degrades" and "verifies with the other algorithm" cannot be confused.
  const noSignatureBin = join(root, 'no-signature-bin');
  mkdirSync(noSignatureBin);
  writeFakeCurl(join(noSignatureBin, 'curl'));
  writeFakeBun(join(noSignatureBin, 'bun'));
  writeFileSync(join(noSignatureBin, 'openssl'), `#!/usr/bin/env bash
case "\${1:-}" in
  pkey|pkeyutl|dgst)
    echo 'unable to load Public Key' >&2
    exit 1 ;;
esac
exec /usr/bin/openssl "$@"
`, { mode: 0o755 });
  const libreSslHome = join(root, 'libressl-home');
  mkdirSync(libreSslHome);
  const libreSsl = await run(['bash', join(releaseDirectory, 'install-server.sh')], {
    cwd: root,
    env: {
      PATH: `${libreSslBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: libreSslHome,
      FAKE_RELEASE_ROOT: releaseDirectory,
      LANG: 'C.UTF-8',
    },
  });
  const libreSslBinary = join(libreSslHome, '.cosyncing', 'bin', 'cosyncing');
  // The install a Mac actually gets. Before the P-256 signature was wired in, this host had no cryptographic
  // check at all and rested on digests delivered by TLS — which the script's own comment conceded was an
  // artifact pin, not an independent trust root.
  check('a LibreSSL host verifies the release with P-256 rather than resting on TLS alone',
    libreSsl.exitCode === 0 && existsSync(libreSslBinary)
      && /Release signature: verified \(ECDSA P-256 over the signed release manifest and checksum list\)/
        .test(libreSsl.stdout)
      && !/delivered over TLS/.test(libreSsl.stdout),
    `${libreSsl.exitCode}: ${libreSsl.stdout.trim().split('\n').slice(-4).join(' | ')}`);

  // Degrading is now reserved for a host that can load NEITHER algorithm, and it must still say so plainly
  // and still gate the download on the embedded digest.
  const noSignatureHome = join(root, 'no-signature-home');
  mkdirSync(noSignatureHome);
  const noSignature = await run(['bash', join(releaseDirectory, 'install-server.sh')], {
    cwd: root,
    env: {
      PATH: `${noSignatureBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: noSignatureHome,
      FAKE_RELEASE_ROOT: releaseDirectory,
      LANG: 'C.UTF-8',
    },
  });
  check('an openssl that can load neither algorithm degrades and says which check was skipped',
    noSignature.exitCode === 0
      && existsSync(join(noSignatureHome, '.cosyncing', 'bin', 'cosyncing'))
      && /Release signature: skipped \(this openssl can verify neither Ed25519 nor ECDSA P-256\)/
        .test(noSignature.stdout)
      && /Artifact digests: matched/.test(noSignature.stdout)
      && /delivered over TLS/.test(noSignature.stdout),
    `${noSignature.exitCode}: ${noSignature.stdout.trim().split('\n').slice(-4).join(' | ')}`);

  // A P-256 signature failure must be as fatal as an Ed25519 one. Only inability to verify may degrade, and
  // a Mac must never fall back to "skipped" because the signature it could check did not match.
  const p256TamperRelease = join(root, 'p256-tampered-release');
  cpSync(releaseDirectory, p256TamperRelease, { recursive: true });
  writeFileSync(join(p256TamperRelease, 'release-manifest.json'), ' ', { flag: 'a' });
  const p256TamperHome = join(root, 'p256-tampered-home');
  mkdirSync(p256TamperHome);
  const p256Tamper = await run(['bash', join(p256TamperRelease, 'install.sh')], {
    cwd: root,
    env: {
      PATH: `${libreSslBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: p256TamperHome,
      FAKE_RELEASE_ROOT: p256TamperRelease,
      LANG: 'C.UTF-8',
    },
  });
  check('a tampered manifest is fatal on the P-256 path too, never a silent degrade',
    p256Tamper.exitCode !== 0
      && /manifest signature verification failed/.test(p256Tamper.stderr)
      && !/skipped/.test(p256Tamper.stdout)
      && !existsSync(join(p256TamperHome, '.cosyncing')),
    `${p256Tamper.exitCode}: ${p256Tamper.stderr.trim().slice(0, 160)}`);

  // The embedded digest is the whole trust root on LibreSSL, so it must still refuse a corrupted artifact.
  const corruptRelease = join(root, 'libressl-corrupt-release');
  cpSync(releaseDirectory, corruptRelease, { recursive: true });
  const corruptAsset = join(corruptRelease, RELEASE_JAVASCRIPT_APP_NAME);
  const corruptBytes = readFileSync(corruptAsset);
  corruptBytes[corruptBytes.length - 1] = (corruptBytes[corruptBytes.length - 1] ?? 0) ^ 0xff;
  writeFileSync(corruptAsset, corruptBytes);
  const corruptHome = join(root, 'libressl-corrupt-home');
  mkdirSync(corruptHome);
  const corrupted = await run(['bash', join(corruptRelease, 'install.sh')], {
    cwd: root,
    env: {
      PATH: `${libreSslBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: corruptHome,
      FAKE_RELEASE_ROOT: corruptRelease,
      LANG: 'C.UTF-8',
    },
  });
  check('the embedded digest still refuses a flipped byte when no signature check is possible',
    corrupted.exitCode !== 0
      && /checksum verification failed|size does not match/.test(corrupted.stderr)
      && !existsSync(join(corruptHome, '.cosyncing', 'bin', 'cosyncing')),
    corrupted.stderr.trim().slice(0, 160));

  const tamperedArtifactRelease = join(root, 'tampered-artifact-release');
  cpSync(releaseDirectory, tamperedArtifactRelease, { recursive: true });
  writeFileSync(join(tamperedArtifactRelease, RELEASE_JAVASCRIPT_APP_NAME), '\n# modified\n', { flag: 'a' });
  const tamperedArtifactHome = join(root, 'tampered-artifact-home');
  mkdirSync(tamperedArtifactHome);
  const tamperedArtifact = await run(['bash', join(tamperedArtifactRelease, 'install.sh')], {
    env: {
      PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: tamperedArtifactHome,
      FAKE_RELEASE_ROOT: tamperedArtifactRelease,
      LANG: 'C.UTF-8',
    },
  });
  // Appended bytes now trip the embedded SIZE check before the digest is even computed — an earlier
  // rejection for the same tamper, so either message is a correct refusal.
  check('bootstrap rejects a modified artifact before installation',
    tamperedArtifact.exitCode !== 0
      && /checksum verification failed|size does not match/.test(tamperedArtifact.stderr)
      && !existsSync(join(tamperedArtifactHome, '.cosyncing')),
    tamperedArtifact.stderr.trim().slice(0, 120));

  // The application is fetched and verified before the sidecar, so a corrupted sidecar is the case where
  // the installer already holds a good bundle and must still refuse rather than leave a broker with no UI.
  const tamperedWebRelease = join(root, 'tampered-web-release');
  cpSync(releaseDirectory, tamperedWebRelease, { recursive: true });
  const tamperedWebAsset = join(tamperedWebRelease, WEB_SIDECAR_NAME);
  const tamperedWebBytes = readFileSync(tamperedWebAsset);
  tamperedWebBytes[tamperedWebBytes.length - 1] =
    (tamperedWebBytes[tamperedWebBytes.length - 1] ?? 0) ^ 0xff;
  writeFileSync(tamperedWebAsset, tamperedWebBytes);
  const tamperedWebHome = join(root, 'tampered-web-home');
  mkdirSync(tamperedWebHome);
  const tamperedWeb = await run(['bash', join(tamperedWebRelease, 'install.sh')], {
    env: {
      PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: tamperedWebHome,
      FAKE_RELEASE_ROOT: tamperedWebRelease,
      LANG: 'C.UTF-8',
    },
  });
  check('bootstrap refuses a corrupted web sidecar and installs no application either',
    tamperedWeb.exitCode !== 0
      && /checksum verification failed|size does not match/.test(tamperedWeb.stderr)
      && !existsSync(join(tamperedWebHome, '.cosyncing', 'bin', 'cosyncing')),
    tamperedWeb.stderr.trim().slice(0, 160));

  // The bundle carries no interpreter, so a Bun meeting the signed floor is a hard prerequisite. Bun is
  // downloaded from bun.sh rather than bundled: shipping one would put a JavaScriptCore build back into the
  // artifact set. The fake bun.sh serves through the same stub curl, keyed on the URL's last path segment.
  const staleBunBin = join(root, 'stale-bun-bin');
  mkdirSync(staleBunBin);
  writeFakeCurl(join(staleBunBin, 'curl'));
  writeFakeBun(join(staleBunBin, 'bun'), '1.2.99');

  // The runtime that executes every verified artifact is held to the artifacts' own rule. A rendered
  // installer carries Bun's real published digests for the pinned tag, so a substituted archive is refused
  // with nothing repointed: the fixture zip simply is not the bytes Bun published.
  const bunTamperRelease = join(root, 'bun-tamper-release');
  cpSync(releaseDirectory, bunTamperRelease, { recursive: true });
  writeFakeBunArchive(bunTamperRelease, 'bun-linux-x64.zip', { version: MINIMUM_BUN_RUNTIME_VERSION });
  const bunTamperHome = join(root, 'bun-tamper-home');
  mkdirSync(bunTamperHome);
  const bunTamper = await run(['bash', join(bunTamperRelease, 'install.sh')], {
    env: {
      PATH: `${staleBunBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: bunTamperHome,
      FAKE_RELEASE_ROOT: bunTamperRelease,
      LANG: 'C.UTF-8',
    },
  });
  check('a substituted Bun archive is refused against the checksum embedded in the installer',
    bunTamper.exitCode !== 0
      && /does not match the checksum embedded in this installer/.test(bunTamper.stderr)
      && !existsSync(join(bunTamperHome, '.bun', 'bin', 'bun'))
      && !existsSync(join(bunTamperHome, '.cosyncing', 'bin', 'cosyncing')),
    bunTamper.stderr.trim().slice(0, 200));

  // The pinned table names real ~90 MB Bun archives, which no deterministic suite can host. Repointing it
  // at fixture archives — and at their true digests — exercises fetch, verify, unpack and probe exactly as
  // rendered; the check above is what proves the REAL pins are enforced.
  const bunInstallRelease = join(root, 'bun-install-release');
  cpSync(releaseDirectory, bunInstallRelease, { recursive: true });
  const workingArchive = writeFakeBunArchive(bunInstallRelease, 'bun-linux-x64.zip', {
    version: MINIMUM_BUN_RUNTIME_VERSION,
  });
  repinBunTable(bunInstallRelease, [`linux-x64 bun-linux-x64.zip ${workingArchive.sha256}`]);
  const bunInstallHome = join(root, 'bun-install-home');
  mkdirSync(bunInstallHome);
  const bunInstall = await run(['bash', join(bunInstallRelease, 'install-server.sh')], {
    env: {
      PATH: `${staleBunBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: bunInstallHome,
      FAKE_RELEASE_ROOT: bunInstallRelease,
      LANG: 'C.UTF-8',
    },
  });
  const installedBun = join(bunInstallHome, '.bun', 'bin', 'bun');
  check('a host whose Bun is below the floor gets the pinned archive, not the stale runtime',
    bunInstall.exitCode === 0
      && existsSync(installedBun)
      && readFileSync(join(bunInstallHome, '.cosyncing', 'bootstrap-receipt'), 'utf8')
        .includes(`runtime=${installedBun}\n`)
      && bunInstall.stdout.includes('Installing the pinned Bun')
      && bunInstall.stdout.includes(`Bun runtime: installed by this script (${MINIMUM_BUN_RUNTIME_VERSION}`),
    `${bunInstall.exitCode}: ${bunInstall.stdout.trim().split('\n').slice(-4).join(' | ')} ${bunInstall.stderr.trim().slice(0, 160)}`);

  // A fresh shell has no Bun command at all. Execute the printed command unchanged, under both POSIX sh
  // and bash, with spaces and apostrophes in the runtime and application paths.
  const noBunPath = join(root, 'tools-without-bun');
  mkdirSync(noBunPath);
  for (const name of ['bash', 'sh', 'id', 'openssl', 'base64', 'uname', 'stat', 'mktemp', 'awk', 'sed',
    'tar', 'gzip', 'sha256sum', 'wc', 'tr', 'sort', 'head', 'grep', 'mkdir', 'chmod', 'dirname', 'cp', 'mv',
    'rm', 'unzip', 'readlink', 'ln', 'rmdir', 'cat', 'basename', 'env', 'setsid']) {
    const executable = Bun.which(name);
    if (!executable) throw new Error(`fresh-host fixture requires ${name}`);
    symlinkSync(executable, join(noBunPath, name));
  }
  writeFakeCurl(join(noBunPath, 'curl'));
  for (const installer of ['install-server.sh', 'install.sh']) {
    const freshHome = join(root, `fresh host's ${installer}`);
    mkdirSync(freshHome);
    const freshEnvironment = {
      PATH: noBunPath, HOME: freshHome, FAKE_RELEASE_ROOT: bunInstallRelease,
      BUN_INSTALL: join(freshHome, "Bun's runtime"),
      COSYNCING_HOME: join(freshHome, "broker's state"), LANG: 'C.UTF-8',
    };
    const absent = await run(['sh', '-c', 'command -v bun'], { env: freshEnvironment });
    const fresh = await run(['sh', join(bunInstallRelease, installer)], { env: freshEnvironment });
    const printed = fresh.stdout.trim().split('\n').at(-1)?.trim() ?? '';
    check(`${installer} downloads Bun outside PATH and prints its absolute setup command`,
      absent.exitCode !== 0 && fresh.exitCode === 0 && fresh.stdout.includes('Installing the pinned Bun')
        && printed.endsWith(' setup'), `${fresh.exitCode}: ${fresh.stderr.trim().slice(0, 180)}`);
    for (const shell of ['sh', 'bash']) {
      const setup = await run([shell, '-c', printed], { env: freshEnvironment });
      check(`${installer} printed setup runs in ${shell} with quoted paths and no Bun on PATH`,
        setup.exitCode === 0 && setup.stdout.trim() === 'fixture setup completed', setup.stderr.trim());
    }
  }

  const nativeHome = join(root, 'compiled-receipt-home');
  const nativeState = join(nativeHome, '.cosyncing');
  mkdirSync(join(nativeState, 'bin'), { recursive: true, mode: 0o700 });
  const nativeFiles = new Map([
    [join(nativeState, 'bin/cosyncing'), 'native executable fixture'],
    [join(nativeState, 'bootstrap-receipt'), 'schemaVersion=1\nproduct=cosyncing\n'],
    [join(nativeState, 'settings.json'), '{"preserveState":true}\n'],
  ]);
  for (const [path, bytes] of nativeFiles) writeFileSync(path, bytes, { mode: 0o600 });
  const nativeRefusal = await run(['sh', join(releaseDirectory, 'install-server.sh')], {
    env: { PATH: `${fakeBin}:${process.env.PATH}`, HOME: nativeHome, FAKE_RELEASE_ROOT: releaseDirectory },
  });
  check('schema-1 native installation is refused without replacing its application, receipt or state',
    nativeRefusal.exitCode !== 0 && nativeRefusal.stderr.includes('this path holds a compiled cosyncing install')
      && [...nativeFiles].every(([path, bytes]) => readFileSync(path, 'utf8') === bytes), nativeRefusal.stderr.trim());

  // One host target is not one binary: musl and pre-AVX2 hosts need a different build of the same release.
  // A build that cannot run here is the wrong candidate, not a failed install.
  const bunFallbackRelease = join(root, 'bun-fallback-release');
  cpSync(releaseDirectory, bunFallbackRelease, { recursive: true });
  const unrunnable = writeFakeBunArchive(bunFallbackRelease, 'bun-linux-x64.zip');
  const fallback = writeFakeBunArchive(bunFallbackRelease, 'bun-linux-x64-musl.zip', {
    version: MINIMUM_BUN_RUNTIME_VERSION,
  });
  repinBunTable(bunFallbackRelease, [
    `linux-x64 bun-linux-x64.zip ${unrunnable.sha256}`,
    `linux-x64 bun-linux-x64-musl.zip ${fallback.sha256}`,
  ]);
  const bunFallbackHome = join(root, 'bun-fallback-home');
  mkdirSync(bunFallbackHome);
  const bunFallback = await run(['bash', join(bunFallbackRelease, 'install-server.sh')], {
    env: {
      PATH: `${staleBunBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: bunFallbackHome,
      FAKE_RELEASE_ROOT: bunFallbackRelease,
      LANG: 'C.UTF-8',
    },
  });
  check('a pinned build that cannot run on this host advances to the next pinned build',
    bunFallback.exitCode === 0
      && existsSync(join(bunFallbackHome, '.bun', 'bin', 'bun'))
      && /does not run on this host; trying the next pinned build/.test(bunFallback.stdout),
    `${bunFallback.exitCode}: ${bunFallback.stdout.trim().split('\n').slice(-5).join(' | ')} ${bunFallback.stderr.trim().slice(0, 160)}`);

  // An operator who does not want this script installing a runtime gets a refusal that names the floor,
  // rather than a silent install of a bundle nothing on the host can execute.
  const optOutHome = join(root, 'bun-opt-out-home');
  mkdirSync(optOutHome);
  const optOut = await run(['bash', join(bunInstallRelease, 'install.sh')], {
    env: {
      PATH: `${staleBunBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: optOutHome,
      FAKE_RELEASE_ROOT: bunInstallRelease,
      COSYNCING_SKIP_BUN_INSTALL: '1',
      LANG: 'C.UTF-8',
    },
  });
  check('COSYNCING_SKIP_BUN_INSTALL=1 refuses by naming the floor instead of downloading a runtime',
    optOut.exitCode !== 0
      && optOut.stderr.includes(`Bun ${MINIMUM_BUN_RUNTIME_VERSION} or newer is required`)
      && optOut.stderr.includes('COSYNCING_SKIP_BUN_INSTALL=1')
      && !existsSync(join(optOutHome, '.bun'))
      && !existsSync(join(optOutHome, '.cosyncing', 'bin', 'cosyncing')),
    optOut.stderr.trim().slice(0, 200));

  // A host with no Bun at all and no reachable release archive must fail loudly. The release copy used here
  // carries no Bun archive, so the stub curl fails the fetch exactly as an offline host would.
  const noBunBin = join(root, 'no-bun-bin');
  mkdirSync(noBunBin);
  writeFakeCurl(join(noBunBin, 'curl'));
  const noBunHome = join(root, 'no-bun-home');
  mkdirSync(noBunHome);
  const noBun = await run(['bash', join(releaseDirectory, 'install.sh')], {
    env: {
      PATH: pathWithoutBun(noBunBin),
      HOME: noBunHome,
      FAKE_RELEASE_ROOT: releaseDirectory,
      LANG: 'C.UTF-8',
    },
  });
  check('an unreachable Bun archive fails the install rather than leaving an unrunnable bundle behind',
    noBun.exitCode !== 0
      && /could not download bun-linux-x64\.zip/.test(noBun.stderr)
      && !existsSync(join(noBunHome, '.cosyncing', 'bin', 'cosyncing')),
    noBun.stderr.trim().slice(0, 200));

  // Defence in depth, and the one case only the signing key could reach: a manifest that STATES the wrong
  // digest for the application while the right digest sits elsewhere in the same document. A check that
  // scanned for the digest anywhere would pass this and call it agreement; reading it from the object the
  // asset names is what makes the manifest's statement about this artifact rather than about a string.
  // Re-signed with the fixture key, because an unsigned edit would be refused by the signature first and
  // would prove nothing about the cross-check.
  const misboundRelease = join(root, 'misbound-manifest-release');
  cpSync(releaseDirectory, misboundRelease, { recursive: true });
  const misboundManifest = JSON.parse(
    readFileSync(join(misboundRelease, 'release-manifest.json'), 'utf8'),
  );
  const trueApplicationDigest = misboundManifest.jsApp.sha256;
  misboundManifest.jsApp.sha256 = 'f'.repeat(64);
  // Moved onto the web sidecar's `sha256`, so the document still contains a literal
  // `"sha256": "<the application's digest>"` — the exact shape a scan of the whole file would accept.
  misboundManifest.webApp.sha256 = trueApplicationDigest;
  const misboundBytes = Buffer.from(`${JSON.stringify(misboundManifest, null, 2)}\n`, 'utf8');
  writeFileSync(join(misboundRelease, 'release-manifest.json'), misboundBytes);
  writeFileSync(
    join(misboundRelease, 'release-manifest.json.sig'),
    sign(null, misboundBytes, privateKey),
  );
  const misboundHome = join(root, 'misbound-manifest-home');
  mkdirSync(misboundHome);
  const misbound = await run(['bash', join(misboundRelease, 'install.sh')], {
    env: {
      PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: misboundHome,
      FAKE_RELEASE_ROOT: misboundRelease,
      LANG: 'C.UTF-8',
    },
  });
  check('the manifest cross-check reads the digest from the object that names the asset',
    misbound.exitCode !== 0
      && /signed manifest and checksum list disagree about/.test(misbound.stderr)
      && !existsSync(join(misboundHome, '.cosyncing', 'bin', 'cosyncing')),
    `${misbound.exitCode}: ${misbound.stderr.trim().slice(0, 160)}`);

  // The checksum list refuses a repeated row for one asset; the manifest side must refuse a repeated object
  // the same way rather than resolving it by taking the first. Reachable only with the signing key, so this
  // is about the rule being right, not about an exposure.
  const duplicateRelease = join(root, 'duplicate-manifest-release');
  cpSync(releaseDirectory, duplicateRelease, { recursive: true });
  const duplicateManifest = JSON.parse(
    readFileSync(join(duplicateRelease, 'release-manifest.json'), 'utf8'),
  );
  duplicateManifest.artifacts.push({
    ...duplicateManifest.artifacts[0],
    name: RELEASE_JAVASCRIPT_APP_NAME,
    sha256: 'e'.repeat(64),
  });
  const duplicateBytes = Buffer.from(`${JSON.stringify(duplicateManifest, null, 2)}\n`, 'utf8');
  writeFileSync(join(duplicateRelease, 'release-manifest.json'), duplicateBytes);
  writeFileSync(
    join(duplicateRelease, 'release-manifest.json.sig'),
    sign(null, duplicateBytes, privateKey),
  );
  const duplicateHome = join(root, 'duplicate-manifest-home');
  mkdirSync(duplicateHome);
  const duplicate = await run(['bash', join(duplicateRelease, 'install.sh')], {
    env: {
      PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: duplicateHome,
      FAKE_RELEASE_ROOT: duplicateRelease,
      LANG: 'C.UTF-8',
    },
  });
  check('a signed manifest that names one asset twice is refused, not resolved to the first entry',
    duplicate.exitCode !== 0
      && /signed manifest names cosyncing-app\.js more than once/.test(duplicate.stderr)
      && !existsSync(join(duplicateHome, '.cosyncing', 'bin', 'cosyncing')),
    `${duplicate.exitCode}: ${duplicate.stderr.trim().slice(0, 160)}`);

  const tamperedManifestRelease = join(root, 'tampered-manifest-release');
  cpSync(releaseDirectory, tamperedManifestRelease, { recursive: true });
  writeFileSync(join(tamperedManifestRelease, 'release-manifest.json'), ' ', { flag: 'a' });
  const tamperedManifestHome = join(root, 'tampered-manifest-home');
  mkdirSync(tamperedManifestHome);
  const tamperedManifest = await run(['bash', join(tamperedManifestRelease, 'install.sh')], {
    env: {
      PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: tamperedManifestHome,
      FAKE_RELEASE_ROOT: tamperedManifestRelease,
      LANG: 'C.UTF-8',
    },
  });
  check('bootstrap rejects a modified manifest before artifact download or installation',
    tamperedManifest.exitCode !== 0 && /manifest signature verification failed/.test(tamperedManifest.stderr)
      && !existsSync(join(tamperedManifestHome, '.cosyncing')));

  // Host selection. `uname -s`/`-m` drive the target, so a stub uname is enough to exercise every branch
  // from Linux. Apple Silicon installs the darwin artifact; Intel is refused by name.
  const unameBin = (name: string, machine: string): string => {
    const dir = join(root, `uname-${name}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'uname'), `#!/usr/bin/env bash\ncase "\${1:-}" in\n  -m) echo ${machine} ;;\n  *) echo Darwin ;;\nesac\n`, { mode: 0o755 });
    return dir;
  };

  const appleSiliconHome = join(root, 'darwin-arm64-home');
  mkdirSync(appleSiliconHome);
  const appleSilicon = await run(['bash', join(releaseDirectory, 'install-server.sh')], {
    env: {
      PATH: `${unameBin('arm64', 'arm64')}:${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: appleSiliconHome,
      FAKE_RELEASE_ROOT: releaseDirectory,
      LANG: 'C.UTF-8',
    },
  });
  const appleSiliconReceipt = join(appleSiliconHome, '.cosyncing', 'bootstrap-receipt');
  // One universal bundle now serves every supported host, so `uname` no longer picks an artifact. It still
  // decides whether the host is supported at all, and the receipt records which host it ran on.
  check('bootstrap installs the one universal bundle on Apple Silicon and records the host',
    appleSilicon.exitCode === 0
      && existsSync(join(appleSiliconHome, '.cosyncing', 'bin', 'cosyncing'))
      && readFileSync(appleSiliconReceipt, 'utf8').includes('host=darwin-arm64\n')
      && readFileSync(appleSiliconReceipt, 'utf8').includes('target=universal\n'),
    `${appleSilicon.exitCode}: ${appleSilicon.stderr.trim().slice(0, 160)}`);

  const intelHome = join(root, 'darwin-x64-home');
  mkdirSync(intelHome);
  const intel = await run(['bash', join(releaseDirectory, 'install.sh')], {
    env: {
      PATH: `${unameBin('x86_64', 'x86_64')}:${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: intelHome,
      FAKE_RELEASE_ROOT: releaseDirectory,
      LANG: 'C.UTF-8',
    },
  });
  check('bootstrap refuses Intel macOS by name rather than installing an arm64 artifact',
    intel.exitCode !== 0 && /only Apple Silicon macOS is supported/.test(intel.stderr)
      && !existsSync(join(intelHome, '.cosyncing')));

  const builds = join(root, 'repro-builds');
  mkdirSync(builds);
  const buildArgs = [
    'bun', 'run', 'scripts/broker/build-broker.ts', '--target', 'bun-linux-x64',
    '--build-date', buildDate, '--commit', commit, '--minify', '--no-alias',
    '--release-manifest-url', `https://releases.example/cosyncing/v${version}/release-manifest.json`,
    '--release-channel-manifest-url', 'https://releases.example/cosyncing/stable/release-manifest.json',
    '--release-key-id', 'test-2026', '--release-public-key', publicKeyPath,
  ];
  const firstPath = join(builds, 'first');
  const secondPath = join(builds, 'second');
  const first = await run([...buildArgs, '--outfile', firstPath], {
    stage: 'reproducibility-build-first',
    timeoutMs: 60_000,
    timeoutAttempts: 2,
    beforeTimeoutRetry: () => rmSync(firstPath, { force: true }),
  });
  const second = await run([...buildArgs, '--outfile', secondPath], {
    stage: 'reproducibility-build-second',
    timeoutMs: 60_000,
    timeoutAttempts: 2,
    beforeTimeoutRetry: () => rmSync(secondPath, { force: true }),
  });
  if (first.exitCode !== 0 || second.exitCode !== 0 || !existsSync(firstPath) || !existsSync(secondPath)) {
    const detail = [
      `first: exit=${first.exitCode} artifact=${existsSync(firstPath)}`,
      first.stderr.trim(),
      `second: exit=${second.exitCode} artifact=${existsSync(secondPath)}`,
      second.stderr.trim(),
    ].filter(Boolean).join('\n');
    throw new Error(`reproducibility build subprocess failed before artifact comparison\n${detail}`);
  }
  const firstBytes = readFileSync(firstPath);
  const secondBytes = readFileSync(secondPath);
  const hostMarker = hostname();
  const leaked = [
    ROOT,
    process.env.HOME ?? '',
    ...(/[.0-9_:-]/.test(hostMarker) || hostMarker.length > 20 ? [hostMarker] : []),
  ]
    .filter((value) => value.length >= 4)
    .find((value) => firstBytes.includes(Buffer.from(value)));
  check('identical inputs produce byte-identical minified Linux artifacts',
    first.exitCode === 0 && second.exitCode === 0
      && createHash('sha256').update(firstBytes).digest('hex') === createHash('sha256').update(secondBytes).digest('hex'),
    `${first.stderr.toString()}${second.stderr.toString()}`.trim().slice(0, 160));
  check('release artifact contains no absolute checkout/home path or private build hostname', !leaked, leaked);
  check('release binary embeds only the public trust anchor plus pinned and stable-channel manifest URLs',
    firstBytes.includes(Buffer.from(`https://releases.example/cosyncing/v${version}/release-manifest.json`))
      && firstBytes.includes(Buffer.from('https://releases.example/cosyncing/stable/release-manifest.json'))
      && firstBytes.includes(Buffer.from('test-2026'))
      && !firstBytes.includes(Buffer.from(privatePem)));
  const versionOutput = await run([firstPath, 'version', '--json'], { cwd: root, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
  const versionJson = JSON.parse(versionOutput.stdout);
  check('packaged version JSON matches manifest identity and injected schemas',
    versionOutput.exitCode === 0 && versionJson.version === assembled.manifest.version
      && versionJson.target === 'linux-x64'
      && versionJson.commit === commit && versionJson.buildDate === buildDate
      && JSON.stringify(versionJson.schemaVersions) === JSON.stringify(PUBLISHED_SCHEMA_VERSIONS)
      && JSON.stringify(versionJson.contract) === JSON.stringify(PUBLISHED_BROKER_CONTRACT));

  const brokerPackage = JSON.parse(readFileSync(join(ROOT, 'packages/typescript/broker/package.json'), 'utf8'));
  check('root package version is the only broker product version truth',
    version === JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
      && brokerPackage.private === true && !('version' in brokerPackage));
  check('published schema inventory matches every governed runtime schema constant',
    PUBLISHED_SCHEMA_VERSIONS.brokerConfig === BROKER_CONFIG_SCHEMA_VERSION
      && PUBLISHED_SCHEMA_VERSIONS.setupState === SETUP_STATE_SCHEMA_VERSION
      && PUBLISHED_SCHEMA_VERSIONS.installState === INSTALL_STATE_SCHEMA_VERSION
      && PUBLISHED_SCHEMA_VERSIONS.releaseManifest === RELEASE_MANIFEST_SCHEMA_VERSION
      && PUBLISHED_SCHEMA_VERSIONS.upgradeJournal === UPGRADE_JOURNAL_SCHEMA_VERSION
      && PUBLISHED_SCHEMA_VERSIONS.brokerContract === BROKER_CONTRACT_REVISION
      && DURABLE_SCHEMA_REGISTRY.every((item) =>
        PUBLISHED_SCHEMA_VERSIONS.durableStores[item.id] === item.currentVersion));
  check('release directory has no generated cache or unexpected publication payload',
    readdirSync(releaseDirectory).sort().join(',') === assembled.publishedFiles.join(','));

  // npm acquisition and ownership have their own acceptance suite in test-npm-package.ts.
  // Native builds above are ephemeral reproducibility evidence, never assembled release assets.
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((item) => !item.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length}/${results.length} release supply-chain checks failed.`);
  process.exit(1);
}
console.log(`\nPASS ${results.length}/${results.length} release supply-chain checks`);
