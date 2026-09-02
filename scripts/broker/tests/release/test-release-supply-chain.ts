#!/usr/bin/env bun
/** Deterministic release, signature, inventory, and bootstrap acceptance. */
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
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
 * Stands in for `https://bun.sh/install`. Records the release tag it was pinned to and drops a working fake
 * Bun into the prefix Bun's own installer would use, so the download path can be exercised without
 * fetching a real runtime.
 */
function writeFakeBunInstaller(path: string, options: { version: string; argLog: string }): void {
  writeFileSync(path, `#!/usr/bin/env bash
set -eu
printf '%s\\n' "\${1:-}" > '${options.argLog}'
mkdir -p "\$BUN_INSTALL/bin"
cat > "\$BUN_INSTALL/bin/bun" <<'BUN'
#!/usr/bin/env bash
if [ "\${1:-}" = --revision ]; then
  echo '${options.version}+fixturebuild'
  exit 0
fi
exec bash "$@"
BUN
chmod 755 "\$BUN_INSTALL/bin/bun"
`, { mode: 0o755 });
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

  // The sibling P-256 signature. Nothing in this repository verifies it yet — the PowerShell installer that
  // will is a separate lane — so these are the only checks standing between a malformed signature and a
  // Windows operator discovering it months from now.
  const p256PublicKeyObject = createPublicKey(
    readFileSync(join(releaseDirectory, 'release-key-p256.pem'), 'utf8'),
  );
  const verifiesP256 = (payload: string, signature: string): boolean => verify(
    'sha256',
    readFileSync(join(releaseDirectory, payload)),
    { key: p256PublicKeyObject, dsaEncoding: 'ieee-p1363' },
    readFileSync(join(releaseDirectory, signature)),
  );
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
  // The installer must still work there, must SAY it skipped signature verification, and must still gate the
  // download on the digest baked into the script. `openssl pkey -pubin` failing is the capability probe.
  const libreSslBin = join(root, 'libressl-bin');
  mkdirSync(libreSslBin);
  writeFakeCurl(join(libreSslBin, 'curl'));
  writeFakeBun(join(libreSslBin, 'bun'));
  writeFileSync(join(libreSslBin, 'openssl'), `#!/usr/bin/env bash
# Reproduces LibreSSL 3.3.6: every other subcommand works, but anything that must LOAD an Ed25519 public
# key fails the way LibreSSL fails ("unable to load Public Key").
case "\${1:-}" in
  pkey|pkeyutl)
    echo 'unable to load Public Key' >&2
    echo 'digital envelope routines: unsupported algorithm' >&2
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
  check('bootstrap installs on a LibreSSL host and states plainly that the signature was not verified',
    libreSsl.exitCode === 0 && existsSync(libreSslBinary)
      && /Release signature: skipped \(this openssl cannot verify Ed25519\)/.test(libreSsl.stdout)
      && /Artifact digests: matched/.test(libreSsl.stdout)
      && /delivered over TLS/.test(libreSsl.stdout),
    `${libreSsl.exitCode}: ${libreSsl.stdout.trim().split('\n').slice(-4).join(' | ')}`);

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
  const bunDownloadRelease = join(root, 'bun-download-release');
  cpSync(releaseDirectory, bunDownloadRelease, { recursive: true });
  const bunInstallerArgLog = join(root, 'bun-installer-arg');
  writeFakeBunInstaller(join(bunDownloadRelease, 'install'), {
    version: MINIMUM_BUN_RUNTIME_VERSION,
    argLog: bunInstallerArgLog,
  });
  const staleBunBin = join(root, 'stale-bun-bin');
  mkdirSync(staleBunBin);
  writeFakeCurl(join(staleBunBin, 'curl'));
  writeFakeBun(join(staleBunBin, 'bun'), '1.2.99');
  const bunDownloadHome = join(root, 'bun-download-home');
  mkdirSync(bunDownloadHome);
  const bunDownload = await run(['bash', join(bunDownloadRelease, 'install.sh')], {
    env: {
      PATH: `${staleBunBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: bunDownloadHome,
      FAKE_RELEASE_ROOT: bunDownloadRelease,
      LANG: 'C.UTF-8',
    },
  });
  const downloadedBun = join(bunDownloadHome, '.bun', 'bin', 'bun');
  check('a host whose Bun is below the floor gets the pinned Bun from bun.sh, not the stale one',
    bunDownload.exitCode === 0
      && existsSync(downloadedBun)
      && readFileSync(bunInstallerArgLog, 'utf8').trim() === `bun-v${MINIMUM_BUN_RUNTIME_VERSION}`
      && readFileSync(join(bunDownloadHome, '.cosyncing', 'bootstrap-receipt'), 'utf8')
        .includes(`runtime=${downloadedBun}\n`)
      && bunDownload.stdout.includes('Installing Bun')
      && bunDownload.stdout.includes(`Bun runtime: installed by this script (${MINIMUM_BUN_RUNTIME_VERSION}`),
    `${bunDownload.exitCode}: ${bunDownload.stdout.trim().split('\n').slice(-4).join(' | ')} ${bunDownload.stderr.trim().slice(0, 120)}`);

  // An operator who does not want this script installing a runtime gets a refusal that names the floor,
  // rather than a silent install of a bundle nothing on the host can execute.
  const optOutHome = join(root, 'bun-opt-out-home');
  mkdirSync(optOutHome);
  const optOut = await run(['bash', join(bunDownloadRelease, 'install.sh')], {
    env: {
      PATH: `${staleBunBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: optOutHome,
      FAKE_RELEASE_ROOT: bunDownloadRelease,
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

  // A host with no Bun at all and no reachable bun.sh must fail loudly. The release copy used here has no
  // `install` file, so the stub curl fails the bun.sh fetch exactly as an offline host would.
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
  check('an unreachable bun.sh fails the install rather than leaving an unrunnable bundle behind',
    noBun.exitCode !== 0
      && /could not download the Bun installer|Bun installer from https:\/\/bun.sh failed/.test(noBun.stderr)
      && !existsSync(join(noBunHome, '.cosyncing', 'bin', 'cosyncing')),
    noBun.stderr.trim().slice(0, 200));

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
