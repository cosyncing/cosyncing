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
  verifyReleaseManifest,
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
  releaseTargetArch,
  releaseTargetPlatform,
  sha256,
  RELEASE_TARGETS,
  WEB_SIDECAR_NAME,
  type PackageEvidence,
  type ReleaseTarget,
  type JavaScriptPackageEvidence,
  type WebPackageEvidence,
} from '../../release/release-files.ts';
import {
  candidateAssetBlockers,
  promotionAssetBlockers,
} from '../../release/verify-promotion-assets.ts';
import { PRODUCT_IDENTITY } from '../../../../packages/typescript/protocol/src/product.ts';
import { forbiddenArtifactContent } from '../../release/package-evidence.ts';

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

function artifactScript(version: string, target: ReleaseTarget, commit: string, buildDate: string): string {
  return `#!/usr/bin/env bash
if [ "\${1:-}" = version ] && [ "\${2:-}" = --json ]; then
  cat <<'JSON'
${JSON.stringify({
  schemaVersion: 1,
  product: 'cosyncing',
  binary: 'cosyncing',
  alias: 'cosy',
  version,
  commit,
  buildDate,
  target,
  packaged: true,
  dirty: false,
  schemaVersions: PUBLISHED_SCHEMA_VERSIONS,
  contract: PUBLISHED_BROKER_CONTRACT,
}, null, 2)}
JSON
  exit 0
fi
exit 2
`;
}

/**
 * The JavaScript application fixture: a shell script that answers `version --json` exactly as the real
 * bundle does. The installer runs it through a Bun, never directly, so a fake `bun` on PATH can stand in
 * for the runtime while every other property under test — digests, signatures, evidence — stays real.
 */
function javaScriptAppScript(version: string, commit: string, buildDate: string): string {
  return `#!/usr/bin/env bash
if [ "\${1:-}" = version ] && [ "\${2:-}" = --json ]; then
  cat <<'JSON'
${JSON.stringify({
  schemaVersion: 2,
  product: 'cosyncing',
  binary: 'cosyncing',
  alias: 'cosy',
  version,
  commit,
  buildDate,
  target: RELEASE_JAVASCRIPT_APP_TARGET,
  distribution: 'bootstrap-js',
  packaged: true,
  dirty: false,
  schemaVersions: PUBLISHED_SCHEMA_VERSIONS,
  contract: PUBLISHED_BROKER_CONTRACT,
}, null, 2)}
JSON
  exit 0
fi
exit 2
`;
}

function evidence(options: {
  artifactPath: string;
  target: ReleaseTarget;
  version: string;
  commit: string;
  buildDate: string;
}): PackageEvidence {
  const bytes = readFileSync(options.artifactPath);
  return {
    schemaVersion: 1,
    product: 'cosyncing',
    artifact: `cosyncing-${options.target}`,
    version: options.version,
    target: options.target,
    sourceCommit: options.commit,
    buildDate: options.buildDate,
    size: bytes.byteLength,
    sha256: sha256(bytes),
    packaged: true,
    dirty: false,
    schemaVersions: PUBLISHED_SCHEMA_VERSIONS,
    contract: PUBLISHED_BROKER_CONTRACT,
    cleanCheckout: true,
    offlineVersionCheck: true,
    forbiddenContentCheck: true,
    runner: {
      os: releaseTargetPlatform(options.target),
      arch: releaseTargetArch(options.target),
      image: `fixture-${options.target}`,
      invocationId: `100${RELEASE_TARGETS.indexOf(options.target) + 1}`,
    },
  };
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
exec bash "$@"
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
exec bash "$@"
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

/** Repoint a rendered installer's pinned Bun table at fixture archives, keeping every other pin real. */
function repinBunTable(installer: string, rows: readonly string[]): void {
  const source = readFileSync(installer, 'utf8');
  const replaced = source.replace(/^BUN_TABLE='[^']*'$/m, `BUN_TABLE='${rows.join('\n')}'`);
  if (replaced === source) throw new Error('installer does not carry a pinned Bun table');
  writeFileSync(installer, replaced, { mode: 0o755 });
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
  for (const target of RELEASE_TARGETS) {
    const name = `cosyncing-${target}`;
    const artifactPath = join(artifactDirectory, name);
    writeFileSync(artifactPath, artifactScript(version, target, commit, buildDate), { mode: 0o755 });
    writeFileSync(
      join(evidenceDirectory, `${name}.evidence.json`),
      `${JSON.stringify(evidence({ artifactPath, target, version, commit, buildDate }), null, 2)}\n`,
    );
  }
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
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const publicKeyPath = join(root, 'release-key.pub.pem');
  writeFileSync(publicKeyPath, publicPem, { mode: 0o600 });
  const p256 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const p256PrivatePem = p256.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const p256PublicPem = p256.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const armEvidencePath = join(
    evidenceDirectory,
    'cosyncing-linux-arm64.evidence.json',
  );
  const originalArmEvidence = readFileSync(armEvidencePath);
  const mismatchedArmEvidence = JSON.parse(originalArmEvidence.toString());
  mismatchedArmEvidence.contract = {
    ...PUBLISHED_BROKER_CONTRACT,
    surfaceHash: 'fnv1a32:00000000',
  };
  writeFileSync(
    armEvidencePath,
    `${JSON.stringify(mismatchedArmEvidence, null, 2)}\n`,
  );
  let mismatchedNativeContractRejected = false;
  try {
    assembleRelease({
      artifactDirectory,
      evidenceDirectory,
      outputDirectory: join(root, 'rejected-native-contract'),
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
    mismatchedNativeContractRejected = /disagrees on broker contract/.test(
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    writeFileSync(armEvidencePath, originalArmEvidence);
  }
  check(
    'native x64 and arm64 evidence must bind the same broker surface',
    mismatchedNativeContractRejected,
  );
  const assembled = assembleRelease({
    artifactDirectory,
    evidenceDirectory,
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
  const originalWebArtifact = readFileSync(webArtifactPath);
  writeFileSync(webArtifactPath, 'swapped candidate web sidecar\n');
  let swappedWebRejected = false;
  try {
    assembleRelease({
      artifactDirectory,
      evidenceDirectory,
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

  check('release manifest publishes every required target, macOS included',
    assembled.manifest.artifacts.map((item) => item.target).join(',') === RELEASE_TARGETS.join(',')
      && assembled.manifest.artifacts.some((item) =>
        item.target === 'darwin-arm64' && item.platform === 'darwin' && item.arch === 'arm64')
      && assembled.publishedFiles.includes('cosyncing-darwin-arm64'),
    assembled.manifest.artifacts.map((item) => `${item.target}/${item.platform}`).join(','));
  check('manifest carries exact version, commit, size, checksum, provenance, and embedded signature',
    assembled.manifest.version === version && assembled.manifest.sourceCommit === commit
      && assembled.manifest.artifacts.every((item) =>
        item.size > 0 && /^[a-f0-9]{64}$/.test(item.sha256)
          && item.provenanceUrl.endsWith(`${item.name}.intoto.jsonl`))
      && assembled.manifest.signature.keyId === 'test-2026');
  check('every published target verifies against the pinned Ed25519 release key',
    RELEASE_TARGETS.every((target) =>
      verifyReleaseManifest({
        value: assembled.manifest,
        target,
        trustedKeys: { 'test-2026': publicPem },
      }).artifact.target === target));

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
  // The whole reason Ed25519 stays. A broker built before the sibling signature existed reads only the
  // manifest, knows only `ed25519`, and trusts only the Ed25519 key id: prove that release is still readable
  // by exactly that reader rather than assuming a sibling FILE cannot disturb it.
  const publishedManifest = JSON.parse(readFileSync(join(releaseDirectory, 'release-manifest.json'), 'utf8'));
  check('a broker built before this change still verifies the manifest with Ed25519 alone',
    publishedManifest.signature.algorithm === 'ed25519'
      && Object.keys(publishedManifest.signature).sort().join(',') === 'algorithm,keyId,value'
      && !('signatures' in publishedManifest) && !('p256Signature' in publishedManifest)
      && verifyReleaseManifest({
        value: publishedManifest,
        target: 'linux-x64',
        trustedKeys: { 'test-2026': publicPem },
      }).manifest.version === version);

  check('the signed manifest carries the JavaScript application beside the compiled set',
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
  check('@clack/prompts 1.7.0 and its reviewed MIT closure are in the compiled inventory',
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
      && assembled.publishedFiles.includes('cosyncing-linux-arm64.intoto.jsonl.sig')
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
    ...new Set([...powerShellInstaller.matchAll(/Get-EnvironmentValue '([A-Z_]+)'/g)].map((m) => m[1])),
  ].sort();
  const providerReads = [
    ...new Set([...powerShellInstaller.matchAll(/\$env:([A-Za-z_]+)/g)].map((m) => m[1])),
  ].sort();
  check('install.ps1 reads exactly the documented environment, and no refusal override',
    environmentReads.join(',') === 'BUN_INSTALL,COSYNCING_BUN_BIN,COSYNCING_HOME,COSYNCING_SKIP_BUN_INSTALL,USERPROFILE'
      && providerReads.join(',') === 'SystemRoot'
      && powerShellInstaller.includes('refusing an elevated install'),
    `${environmentReads.join(',')} | $env:${providerReads.join(',$env:')}`);
  // The shell installer's Windows refusal used to send an operator to WSL. It now names the installer
  // that actually works there, and this is the assertion that keeps the two from drifting apart again.
  check('the shell installer points a Windows shell at install.ps1 rather than at WSL',
    shellInstaller.includes('on Windows x64, run install.ps1 from PowerShell instead')
      && !/install into a WSL distribution/.test(shellInstaller));
  const thirdPartyNotices = readFileSync(
    join(releaseDirectory, 'THIRD_PARTY_NOTICES.txt'),
    'utf8',
  );
  check('release notices cover Bun and every compiled external package',
    thirdPartyNotices.includes('Bun 1.3.8 runtime')
      && thirdPartyNotices.includes('JavaScriptCore')
      && thirdPartyNotices.includes('provide your application in an object')
      && inventory.packages
        .filter((item: any) => !item.internal)
        .every((item: any) => thirdPartyNotices.includes(`${item.name}@${item.version}`)));
  // The Bun section embeds a TRACKED licence file, and a checkout with `core.autocrlf=true` — every
  // hosted Windows runner — delivers that file CRLF. It used to be hashed as-checked-out, which failed
  // the digest pin inside `assembleRelease` and meant no release could be assembled on a Windows
  // checkout at all. The pin is over the licence text now, and this asserts the consequence: that
  // section is the same bytes whichever host assembled the release.
  //
  // Scoped to that section on purpose. The dependency closure below it carries each package's licence
  // exactly as npm published it, CRLF included, and rewriting a third party's licence bytes to satisfy
  // a test would be the wrong fix — those come from the tarball, not from this checkout, so they do not
  // vary by host anyway.
  const bunNoticeSection = thirdPartyNotices.slice(
    thirdPartyNotices.indexOf('Bun 1.3.8 runtime'),
    thirdPartyNotices.indexOf('Compiled npm dependency closure'),
  );
  check('the tracked Bun licence is emitted host-independently, with no carriage return',
    bunNoticeSection.length > 1000 && !bunNoticeSection.includes('\r'),
    `${bunNoticeSection.length} bytes, ${bunNoticeSection.split('\r').length - 1} carriage returns`);

  const fakeBin = join(root, 'fake-bin');
  mkdirSync(fakeBin);
  writeFakeCurl(join(fakeBin, 'curl'));
  writeFakeBun(join(fakeBin, 'bun'));
  const home = join(root, 'install-home');
  mkdirSync(home);
  writeFileSync(join(home, '.bashrc'), '# preserve\n');
  const install = await run(['bash', join(releaseDirectory, 'install.sh')], {
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
      && install.stdout.includes(`${binary} setup`) && install.stdout.includes('PATH was not changed'));
  check('a capable openssl reports the signature as verified, not merely checked',
    /Release signature: verified/.test(install.stdout)
      && /Artifact digests: matched/.test(install.stdout),
    install.stdout.trim().split('\n').slice(-4).join(' | '));

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
  const libreSsl = await run(['bash', join(releaseDirectory, 'install.sh')], {
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
  const noSignature = await run(['bash', join(releaseDirectory, 'install.sh')], {
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
  repinBunTable(join(bunInstallRelease, 'install.sh'),
    [`linux-x64 bun-linux-x64.zip ${workingArchive.sha256}`]);
  const bunInstallHome = join(root, 'bun-install-home');
  mkdirSync(bunInstallHome);
  const bunInstall = await run(['bash', join(bunInstallRelease, 'install.sh')], {
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

  // One host target is not one binary: musl and pre-AVX2 hosts need a different build of the same release.
  // A build that cannot run here is the wrong candidate, not a failed install.
  const bunFallbackRelease = join(root, 'bun-fallback-release');
  cpSync(releaseDirectory, bunFallbackRelease, { recursive: true });
  const unrunnable = writeFakeBunArchive(bunFallbackRelease, 'bun-linux-x64.zip');
  const fallback = writeFakeBunArchive(bunFallbackRelease, 'bun-linux-x64-musl.zip', {
    version: MINIMUM_BUN_RUNTIME_VERSION,
  });
  repinBunTable(join(bunFallbackRelease, 'install.sh'), [
    `linux-x64 bun-linux-x64.zip ${unrunnable.sha256}`,
    `linux-x64 bun-linux-x64-musl.zip ${fallback.sha256}`,
  ]);
  const bunFallbackHome = join(root, 'bun-fallback-home');
  mkdirSync(bunFallbackHome);
  const bunFallback = await run(['bash', join(bunFallbackRelease, 'install.sh')], {
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
  // Moved onto a compiled artifact's `sha256`, so the document still contains a literal
  // `"sha256": "<the application's digest>"` — the exact shape a scan of the whole file would accept.
  misboundManifest.artifacts[0].sha256 = trueApplicationDigest;
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
  const appleSilicon = await run(['bash', join(releaseDirectory, 'install.sh')], {
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

  // The npm distribution's own assertions live in scripts/broker/tests/release/test-npm-package.ts.
  //
  // They used to be here because npm packaging WAS release packaging: the published package carried
  // per-platform `bun build --compile` executables, so every claim about it was a claim about compiled
  // artifacts, provenance evidence, and the resolver that selected between them. The npm package now
  // ships one universal JavaScript bundle and no compiled artifact at all, which shares nothing with the
  // signed native release this suite governs. Keeping both here would tie a JavaScript packaging change
  // to the native release gate and vice versa; the native lane's assertions above are unchanged.
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((item) => !item.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length}/${results.length} release supply-chain checks failed.`);
  process.exit(1);
}
console.log(`\nPASS ${results.length}/${results.length} release supply-chain checks`);
