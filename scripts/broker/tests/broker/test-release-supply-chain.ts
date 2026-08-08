#!/usr/bin/env bun
/** Deterministic release, signature, inventory, and bootstrap acceptance. */
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BROKER_CONTRACT_REVISION } from '../../../../packages/typescript/adapter-api/src/index.ts';
import {
  PUBLISHED_BROKER_CONTRACT,
  PUBLISHED_SCHEMA_VERSIONS,
} from '../../../../packages/typescript/broker/src/build-info.ts';
import { BROKER_CONFIG_SCHEMA_VERSION } from '../../../../packages/typescript/broker/src/configuration.ts';
import { DURABLE_SCHEMA_REGISTRY } from '../../../../packages/typescript/broker/src/durable-state.ts';
import { INSTALL_STATE_SCHEMA_VERSION } from '../../../../packages/typescript/broker/src/install-state.ts';
import {
  RELEASE_MANIFEST_SCHEMA_VERSION,
  UPGRADE_JOURNAL_SCHEMA_VERSION,
  verifyReleaseManifest,
  verifyReleasePairing,
} from '../../../../packages/typescript/broker/src/release-upgrade.ts';
import {
  BROKER_CONTRACT,
  CLIENT_MINIMUM_BROKER_CONTRACT_REVISION,
} from '../../../../packages/typescript/protocol/src/index.ts';
import { SETUP_STATE_SCHEMA_VERSION } from '../../../../packages/typescript/broker/src/setup-state.ts';
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
  type WebPackageEvidence,
} from '../../release/release-files.ts';
import {
  candidateAssetBlockers,
  promotionAssetBlockers,
} from '../../release/verify-promotion-assets.ts';
import { writeStampedWebBuild, STAMPED_WEB_FIXTURE_COMMIT } from '../helpers/stamped-web-build.ts';
import { validateWebBuildShape } from '../../release/package-web-sidecar.ts';
import { PRODUCT_IDENTITY } from '../../../../packages/typescript/broker/src/product.ts';
import { forbiddenArtifactContent } from '../../release/package-evidence.ts';

const ROOT = resolve(import.meta.dir, '../../../..');
/** Where the binary lives inside either npm layout; mirrors PACKAGED_BINARY in build-npm-package.ts. */
const PACKAGED_BINARY_PATH = `bin/${PRODUCT_IDENTITY.primaryBinary}`;
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
} = {}): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const stage = options.stage ?? command.slice(0, 3).join(' ');
  const timeoutMs = options.timeoutMs ?? 20_000;
  console.log(`STAGE ${stage} start (deadline ${timeoutMs}ms)`);
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
  if (child.timedOut || child.strays) {
    throw new Error(
      `${stage} ${child.timedOut ? `timed out after ${timeoutMs}ms` : 'left subprocesses behind'}`,
    );
  }
  return { exitCode: child.exitCode, stdout: child.stdout, stderr: child.stderr };
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
  const webArtifactPath = join(artifactDirectory, WEB_SIDECAR_NAME);
  writeFileSync(webArtifactPath, 'deterministic fixture web sidecar\n');
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
  check('bootstrap verifies, installs user-owned binary+relative alias, and records ownership',
    install.exitCode === 0 && existsSync(binary) && lstatSync(binary).isFile()
      && lstatSync(alias).isSymbolicLink() && readlinkSync(alias) === 'cosyncing'
      && readFileSync(join(home, '.cosyncing', 'bootstrap-receipt'), 'utf8').includes(`sha256=${sha256(readFileSync(binary))}`),
    install.stderr.trim());
  check('bootstrap never edits shell startup files and prints the absolute setup command',
    readFileSync(join(home, '.bashrc'), 'utf8') === '# preserve\n'
      && install.stdout.includes(`${binary} setup`) && install.stdout.includes('PATH was not changed'));
  check('a capable openssl reports the signature as verified, not merely checked',
    /Release signature: verified/.test(install.stdout)
      && /Artifact digest: matched/.test(install.stdout),
    install.stdout.trim().split('\n').slice(-4).join(' | '));

  // Stock macOS ships LibreSSL, which cannot load an Ed25519 SPKI key at all — the real physical failure.
  // The installer must still work there, must SAY it skipped signature verification, and must still gate the
  // download on the digest baked into the script. `openssl pkey -pubin` failing is the capability probe.
  const libreSslBin = join(root, 'libressl-bin');
  mkdirSync(libreSslBin);
  writeFakeCurl(join(libreSslBin, 'curl'));
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
      && /Artifact digest: matched/.test(libreSsl.stdout)
      && /delivered over TLS/.test(libreSsl.stdout),
    `${libreSsl.exitCode}: ${libreSsl.stdout.trim().split('\n').slice(-4).join(' | ')}`);

  // The embedded digest is the whole trust root on LibreSSL, so it must still refuse a corrupted artifact.
  const corruptRelease = join(root, 'libressl-corrupt-release');
  cpSync(releaseDirectory, corruptRelease, { recursive: true });
  const corruptAsset = join(corruptRelease, 'cosyncing-linux-x64');
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
      && /checksum verification failed|artifact size does not match/.test(corrupted.stderr)
      && !existsSync(join(corruptHome, '.cosyncing', 'bin', 'cosyncing')),
    corrupted.stderr.trim().slice(0, 160));

  const tamperedArtifactRelease = join(root, 'tampered-artifact-release');
  cpSync(releaseDirectory, tamperedArtifactRelease, { recursive: true });
  writeFileSync(join(tamperedArtifactRelease, 'cosyncing-linux-x64'), '\n# modified\n', { flag: 'a' });
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
      && /checksum verification failed|artifact size does not match/.test(tamperedArtifact.stderr)
      && !existsSync(join(tamperedArtifactHome, '.cosyncing')),
    tamperedArtifact.stderr.trim().slice(0, 120));

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
  check('bootstrap installs the darwin-arm64 artifact on Apple Silicon',
    appleSilicon.exitCode === 0
      && existsSync(join(appleSiliconHome, '.cosyncing', 'bin', 'cosyncing'))
      && readFileSync(appleSiliconReceipt, 'utf8').includes('target=darwin-arm64'),
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
    timeoutMs: 30_000,
  });
  const second = await run([...buildArgs, '--outfile', secondPath], {
    stage: 'reproducibility-build-second',
    timeoutMs: 30_000,
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

  // --binary-dir names reviewed release artifacts. A missing one must stop the run, never be replaced by a
  // freshly compiled, un-attested binary in a tarball the operator believes carries the reviewed build.
  {
    const partial = join(root, 'npm-prebuilts');
    mkdirSync(partial, { recursive: true });
    // Only one of the three expected prebuilts exists.
    writeFileSync(join(partial, 'cosyncing-linux-x64'), 'fixture prebuilt\n', { mode: 0o755 });
    const refused = await run([
      'bun', 'run', 'scripts/release/build-npm-package.ts',
      '--binary-dir', partial, '--output-dir', join(root, 'npm-refused'), '--no-pack',
    ], { cwd: ROOT, timeoutMs: 60_000 });
    check('npm packaging refuses --binary-dir with missing prebuilts instead of compiling substitutes',
      refused.exitCode !== 0
        && /expected prebuilt binaries are missing/.test(refused.stderr)
        && /cosyncing-linux-arm64/.test(refused.stderr)
        && /cosyncing-darwin-arm64/.test(refused.stderr)
        && !existsSync(join(root, 'npm-refused', 'platform-linux-arm64', 'bin', 'cosyncing')),
      refused.stderr.trim().split('\n').slice(0, 2).join(' | ').slice(0, 200));
  }

  // The web app ships WITH the broker: a plain `npm i -g cosyncing` must serve the real client at /cosy/.
  // A packaged broker resolves its web root as `dirname(<running executable>)/cosyncing-web-<version>`, so
  // the sidecar has to land beside the binary in whichever package the executable ends up in — and it must
  // be enumerated in `files`, or npm pack silently drops it and the tarball ships a broker with no app.
  {
    const webFixture = join(root, 'npm-web-build');
    mkdirSync(webFixture, { recursive: true });
    await writeStampedWebBuild(webFixture);
    const sidecar = `cosyncing-web-${version}`;
    const staged = join(root, 'npm-web-stage');
    // Reuses the linux-x64 binary this suite already built, so the pin costs no second compile.
    const packaged = await run([
      'bun', 'run', 'scripts/release/build-npm-package.ts',
      '--local-single-tarball', '--target', 'bun-linux-x64', '--binary', firstPath,
      '--web-dir', webFixture, '--commit', STAMPED_WEB_FIXTURE_COMMIT,
      '--output-dir', staged, '--no-pack', '--keep-stage',
    ], { cwd: ROOT, timeoutMs: 120_000 });
    const stagedPackage = join(staged, 'package');
    const manifest = packaged.exitCode === 0
      ? JSON.parse(readFileSync(join(stagedPackage, 'package.json'), 'utf8'))
      : {};
    check('the single-tarball layout stages the web sidecar beside its own bin/cosyncing',
      packaged.exitCode === 0
        && existsSync(join(stagedPackage, 'bin', PRODUCT_IDENTITY.primaryBinary))
        && existsSync(join(stagedPackage, 'bin', sidecar, 'index.html'))
        && readFileSync(join(stagedPackage, 'bin', sidecar, 'index.html'), 'utf8')
          .includes('<base href="/cosy/">')
        && (manifest.files ?? []).includes(`bin/${sidecar}`),
      `exit=${packaged.exitCode} files=${JSON.stringify(manifest.files)} ${packaged.stderr.trim().slice(0, 200)}`);

    // A build that is not mounted at /cosy/ must not reach a tarball at all, however it was produced.
    const rootShell = join(root, 'npm-web-root-shell');
    mkdirSync(rootShell, { recursive: true });
    await writeStampedWebBuild(rootShell, '/');
    const refusedShell = await run([
      'bun', 'run', 'scripts/release/build-npm-package.ts',
      '--local-single-tarball', '--target', 'bun-linux-x64', '--binary', firstPath,
      '--web-dir', rootShell, '--commit', STAMPED_WEB_FIXTURE_COMMIT,
      '--output-dir', join(root, 'npm-web-refused'), '--no-pack',
    ], { cwd: ROOT, timeoutMs: 120_000 });
    check('npm packaging refuses a web build that is not mounted at /cosy/',
      refusedShell.exitCode !== 0 && /web build identity/.test(refusedShell.stderr),
      `exit=${refusedShell.exitCode} ${refusedShell.stderr.trim().slice(0, 160)}`);

    // --no-web is the only way to get a package with no app, and it must also drop the `files` entry —
    // npm pack fails outright on a `files` entry that names a directory which is not there.
    const withoutWeb = await run([
      'bun', 'run', 'scripts/release/build-npm-package.ts',
      '--local-single-tarball', '--target', 'bun-linux-x64', '--binary', firstPath,
      '--no-web', '--commit', commit,
      '--output-dir', join(root, 'npm-no-web'), '--no-pack', '--keep-stage',
    ], { cwd: ROOT, timeoutMs: 120_000 });
    const bareManifest = withoutWeb.exitCode === 0
      ? JSON.parse(readFileSync(join(root, 'npm-no-web', 'package', 'package.json'), 'utf8'))
      : {};
    check('--no-web drops both the staged sidecar and its files entry',
      withoutWeb.exitCode === 0
        && !existsSync(join(root, 'npm-no-web', 'package', 'bin', sidecar))
        && !(bareManifest.files ?? []).some((entry: string) => entry.includes('-web-')),
      `exit=${withoutWeb.exitCode} files=${JSON.stringify(bareManifest.files)}`);

    // One package, one source revision. The version cannot enforce that — a release cycle shares one semver,
    // so a client built from an older or dirty tree passes the version check and ships beside newer broker
    // binaries with nothing in the tarball recording the skew. `--web-dir` is exactly the door for it.
    const skewed = await run([
      'bun', 'run', 'scripts/release/build-npm-package.ts',
      '--local-single-tarball', '--target', 'bun-linux-x64', '--binary', firstPath,
      '--web-dir', webFixture, '--commit', 'a'.repeat(40),
      '--output-dir', join(root, 'npm-web-skew'), '--no-pack',
    ], { cwd: ROOT, timeoutMs: 120_000 });
    check('npm packaging refuses a web build from a different commit than the broker binaries',
      skewed.exitCode !== 0
        && skewed.stderr.includes(STAMPED_WEB_FIXTURE_COMMIT)
        && skewed.stderr.includes('a'.repeat(40)),
      `exit=${skewed.exitCode} ${skewed.stderr.trim().slice(0, 200)}`);

    // Dirtiness is legitimate for a local build and fatal for a release. --require-clean is the gate
    // build-broker.ts already applies to the binary; it has to cover the client shipped beside it.
    const dirtyWeb = join(root, 'npm-web-dirty');
    mkdirSync(dirtyWeb, { recursive: true });
    await writeStampedWebBuild(dirtyWeb);
    const dirtyIdentityPath = join(dirtyWeb, 'cosyncing-build-identity.json');
    const dirtyIdentity = JSON.parse(readFileSync(dirtyIdentityPath, 'utf8'));
    writeFileSync(dirtyIdentityPath, `${JSON.stringify({ ...dirtyIdentity, dirty: true }, null, 2)}\n`);
    const refusedDirty = await run([
      'bun', 'run', 'scripts/release/build-npm-package.ts',
      '--local-single-tarball', '--target', 'bun-linux-x64', '--binary', firstPath,
      '--web-dir', dirtyWeb, '--commit', STAMPED_WEB_FIXTURE_COMMIT, '--require-clean',
      '--output-dir', join(root, 'npm-web-dirty-out'), '--no-pack',
    ], { cwd: ROOT, timeoutMs: 120_000 });
    check('--require-clean refuses a web build produced from a dirty checkout',
      refusedDirty.exitCode !== 0 && /dirty checkout/.test(refusedDirty.stderr),
      `exit=${refusedDirty.exitCode} ${refusedDirty.stderr.trim().slice(0, 200)}`);

    // Everything above exercises --local-single-tarball, which is never published. The layout real users
    // install is the multi-platform one, and nothing asserted it: deleting stageWebSidecar(mainStage) left
    // every check green while `npm i -g cosyncing` shipped a broker with no app. So stage the ACTUAL
    // publishable set and inspect the MAIN package itself.
    //
    // The two non-host binaries are header-only stubs. Packaging never executes a cross-compiled artifact
    // (verifyStagedBinary skips what this host cannot run) but it does check every binary's format, so the
    // stubs carry real ELF/Mach-O headers and nothing else. The host binary is the real one this suite
    // already compiled, so the one probe that DOES run gets a genuine broker.
    const prebuilts = join(root, 'npm-multi-prebuilts');
    mkdirSync(prebuilts, { recursive: true });
    copyFileSync(firstPath, join(prebuilts, 'cosyncing-linux-x64'));
    const elfArm64 = Buffer.alloc(64);
    elfArm64.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
    elfArm64.writeUInt16LE(0xb7, 18);
    writeFileSync(join(prebuilts, 'cosyncing-linux-arm64'), elfArm64, { mode: 0o755 });
    const machOArm64 = Buffer.alloc(64);
    machOArm64.set([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01], 0);
    writeFileSync(join(prebuilts, 'cosyncing-darwin-arm64'), machOArm64, { mode: 0o755 });

    /**
     * The provenance the release lane emits beside each artifact. The packager cannot execute a
     * cross-compiled binary, so this file is the only thing binding those bytes to a commit — and it is
     * required, not optional: without it the two stubs above would ship entirely unattested.
     */
    const writeEvidence = (
      target: string,
      overrides: Record<string, unknown> = {},
    ): void => {
      const artifactPath = join(prebuilts, `cosyncing-${target}`);
      const bytes = readFileSync(artifactPath);
      writeFileSync(`${artifactPath}.evidence.json`, `${JSON.stringify({
        schemaVersion: 1,
        product: 'cosyncing',
        artifact: `cosyncing-${target}`,
        version,
        target,
        sourceCommit: commit,
        buildDate,
        size: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        packaged: true,
        dirty: false,
        ...overrides,
      }, null, 2)}\n`);
    };
    writeEvidence('linux-arm64');
    writeEvidence('darwin-arm64');

    const multiOut = join(root, 'npm-multi');
    // Packs for real: the staging assertions below need --keep-stage, and the install assertions further
    // down need the actual tarballs. One run serves both.
    const multi = await run([
      'bun', 'run', 'scripts/release/build-npm-package.ts',
      '--binary-dir', prebuilts, '--web-dir', webFixture, '--commit', STAMPED_WEB_FIXTURE_COMMIT,
      '--output-dir', multiOut, '--keep-stage',
    ], { cwd: ROOT, timeoutMs: 300_000 });
    const mainStage = join(multiOut, 'package');
    const mainManifest = multi.exitCode === 0
      ? JSON.parse(readFileSync(join(mainStage, 'package.json'), 'utf8'))
      : {};
    const shippedSidecar = join(mainStage, 'bin', sidecar);
    // The closed set the validator authorized, compared against what actually landed in the package.
    const expectedPaths = [...validateWebBuildShape({ buildDirectory: webFixture }).paths].sort();
    const shippedPaths = (): string[] => {
      const found: string[] = [];
      const walk = (directory: string, prefix: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(join(directory, entry.name), relative);
          else found.push(relative);
        }
      };
      if (existsSync(shippedSidecar)) walk(shippedSidecar, '');
      return found.sort();
    };
    check('the publishable multi-platform main package ships the validated web sidecar',
      multi.exitCode === 0
        && existsSync(shippedSidecar)
        && JSON.stringify(shippedPaths()) === JSON.stringify(expectedPaths)
        && (mainManifest.files ?? []).includes(`bin/${sidecar}`),
      `exit=${multi.exitCode} shipped=${shippedPaths().length} expected=${expectedPaths.length} `
        + `files=${JSON.stringify(mainManifest.files)} ${multi.stderr.trim().slice(0, 200)}`);

    // The postinstall swap replaces the main package's bin/cosyncing with the platform binary, so the broker
    // resolves `dirname(<executable>)/cosyncing-web-<version>` and must land exactly on the shipped sidecar.
    // The platform packages must NOT carry their own copy — that would triple the published web bytes.
    check('the swapped-in binary finds the sidecar beside it, and no platform package duplicates it',
      existsSync(join(mainStage, 'bin', PRODUCT_IDENTITY.primaryBinary))
        && existsSync(join(shippedSidecar, 'index.html'))
        && readFileSync(join(shippedSidecar, 'index.html'), 'utf8').includes('<base href="/cosy/">')
        && ['linux-x64', 'linux-arm64', 'darwin-arm64'].every((target) =>
          !existsSync(join(multiOut, `platform-${target}`, 'bin', sidecar))),
      `sidecar=${shippedSidecar}`);

    // The --ignore-scripts path: the resolver survives and execs the PLATFORM package's binary, whose own
    // directory holds no sidecar. It must hand over THIS package's shipped directory, not a fabricated one.
    const swapless = join(mainStage, 'node_modules', '@cosyncing', `broker-${process.platform}-${process.arch}`, 'bin');
    mkdirSync(swapless, { recursive: true });
    writeFileSync(join(swapless, 'cosyncing'), `#!/usr/bin/env bash
printf 'web=%s\\n' "\${COSYNCING_WEB_DIR:-unset}"
`, { mode: 0o755 });
    const resolved = await run(['node', join(mainStage, 'bin', PRODUCT_IDENTITY.primaryBinary)], { cwd: mainStage });
    check('the --ignore-scripts resolver points at the sidecar this package actually shipped',
      resolved.stdout.trim() === `web=${shippedSidecar}`,
      `${resolved.stdout.trim()} want=web=${shippedSidecar}`);

    // ---- Everything above inspects a STAGED directory. What users get is a tarball npm expands, so the
    // last word belongs to a real install: npm pack output, installed offline into a throwaway prefix, with
    // the postinstall swap actually running. That is the default path a plain `npm i -g cosyncing` takes;
    // the --ignore-scripts path is covered by the resolver check above against the same staged package.
    const tarballs = readdirSync(multiOut).filter((entry) => entry.endsWith('.tgz'));
    const mainTarball = tarballs.find((entry) => entry.startsWith(`${PRODUCT_IDENTITY.productName}-${version}`));
    const hostTarball = tarballs.find((entry) => entry.includes(`broker-${process.platform}-${process.arch}`));

    // What npm pack actually PUT IN the tarball, against what the manifest promised. `files` is a promise;
    // the member list is the delivery, and the sidecar is the entry most likely to be silently dropped.
    const members = mainTarball
      ? (await run(['tar', '-tzf', join(multiOut, mainTarball)], { cwd: multiOut })).stdout
        .trim().split('\n')
      : [];
    const sidecarMembers = members.filter((entry) => entry.startsWith(`package/bin/${sidecar}/`));
    check('npm pack delivers every file the main manifest promises, sidecar included',
      !!mainTarball && !!hostTarball
        && members.includes(`package/${PACKAGED_BINARY_PATH}`)
        && members.includes('package/install.cjs')
        && sidecarMembers.length === expectedPaths.length
        && expectedPaths.every((path) => sidecarMembers.includes(`package/bin/${sidecar}/${path}`)),
      `main=${mainTarball} host=${hostTarball} members=${members.length} sidecar=${sidecarMembers.length}`);

    // A real, offline, registry-free install of exactly those two tarballs. The main package's other two
    // optionalDependencies cannot resolve offline and npm skips them, which is precisely what it does on a
    // real host that has only one platform's binary published for it.
    const prefix = join(root, 'npm-install-prefix');
    mkdirSync(prefix, { recursive: true });
    const installed = mainTarball && hostTarball
      ? await run([
        'npm', 'install', join(multiOut, mainTarball), join(multiOut, hostTarball),
        '--prefix', prefix, '--global', '--no-audit', '--no-fund', '--offline',
      ], {
        cwd: multiOut,
        timeoutMs: 300_000,
        env: hermeticEnvironment({ HOME: prefix, npm_config_cache: join(prefix, '.npm-cache') }),
      })
      : { exitCode: 1, stdout: '', stderr: 'no tarballs to install' };
    const installedPackage = join(prefix, 'lib', 'node_modules', PRODUCT_IDENTITY.productName);
    const installedBinary = join(installedPackage, PACKAGED_BINARY_PATH);
    const installedSidecar = join(installedPackage, 'bin', sidecar);
    check('the packed tarballs install offline and the postinstall swap replaces the resolver',
      installed.exitCode === 0
        && existsSync(installedBinary)
        // The resolver is Node source; after the swap this is the compiled broker itself.
        && readFileSync(installedBinary).subarray(0, 4).toString('hex') === '7f454c46'
        && existsSync(join(prefix, 'bin', PRODUCT_IDENTITY.primaryBinary)),
      `exit=${installed.exitCode} ${installed.stderr.trim().slice(0, 200)}`);
    check('the installed package carries the sidecar beside the swapped-in binary',
      existsSync(join(installedSidecar, 'index.html'))
        && readFileSync(join(installedSidecar, 'index.html'), 'utf8').includes('<base href="/cosy/">'),
      installedSidecar);

    // The installed global command, executed. This is the only assertion in the file that observes what an
    // operator actually gets, and it must be the build this package was assembled from.
    const installedVersion = await run(
      [join(prefix, 'bin', PRODUCT_IDENTITY.primaryBinary), 'version', '--json'],
      { cwd: prefix, env: hermeticEnvironment({ HOME: join(prefix, 'run-home') }) },
    );
    const reported = installedVersion.exitCode === 0
      ? JSON.parse(installedVersion.stdout) as Record<string, unknown>
      : {};
    check('running the installed global command answers as the build that was packaged',
      reported.version === version && reported.commit === commit
        && reported.packaged === true && reported.product === PRODUCT_IDENTITY.productName,
      `exit=${installedVersion.exitCode} ${JSON.stringify({
        version: reported.version, commit: reported.commit,
      })} ${installedVersion.stderr.trim().slice(0, 160)}`);

    // The web app always ships. A published package with no client is not a smaller install, it is a broken
    // one, and an operator cannot add the app afterwards — so the publishable lane must refuse --no-web
    // outright rather than quietly producing it. Local single-tarball builds keep the escape hatch (asserted
    // above), which is what makes this a policy and not a removal.
    const publishedNoWeb = await run([
      'bun', 'run', 'scripts/release/build-npm-package.ts',
      '--binary-dir', prebuilts, '--no-web',
      '--output-dir', join(root, 'npm-multi-no-web'), '--no-pack',
    ], { cwd: ROOT, timeoutMs: 180_000 });
    check('the publishable multi-platform lane refuses --no-web and names the policy',
      publishedNoWeb.exitCode !== 0
        && /--no-web/.test(publishedNoWeb.stderr)
        && /--local-single-tarball/.test(publishedNoWeb.stderr)
        && !existsSync(join(root, 'npm-multi-no-web', 'package', 'package.json')),
      `exit=${publishedNoWeb.exitCode} ${publishedNoWeb.stderr.trim().slice(0, 200)}`);

    // --commit is a CLAIM about what is being packaged. The web build is validated against it, so if
    // nothing validates the binaries against it too, a caller can name any commit and ship binaries from
    // another one — the tarball's own metadata disagreeing with every executable in it. Where this host can
    // run the artifact, its stamped BuildInfo is the ground truth and must win over the claim.
    const foreignCommit = 'a'.repeat(40);
    const foreignWeb = join(root, 'npm-web-foreign-commit');
    mkdirSync(foreignWeb, { recursive: true });
    await writeStampedWebBuild(foreignWeb);
    const foreignIdentityPath = join(foreignWeb, 'cosyncing-build-identity.json');
    // Move the WEB identity to the claimed commit so the web check passes and the BINARY check is what runs.
    writeFileSync(foreignIdentityPath, `${JSON.stringify({
      ...JSON.parse(readFileSync(foreignIdentityPath, 'utf8')), sourceCommit: foreignCommit,
    }, null, 2)}\n`);
    const claimedCommit = await run([
      'bun', 'run', 'scripts/release/build-npm-package.ts',
      '--local-single-tarball', '--target', 'bun-linux-x64', '--binary', firstPath,
      '--web-dir', foreignWeb, '--commit', foreignCommit,
      '--output-dir', join(root, 'npm-claimed-commit'), '--no-pack',
    ], { cwd: ROOT, timeoutMs: 120_000 });
    check('packaging refuses a binary whose stamped commit is not the commit --commit claims',
      claimedCommit.exitCode !== 0
        && claimedCommit.stderr.includes(commit)
        && claimedCommit.stderr.includes(foreignCommit),
      `exit=${claimedCommit.exitCode} ${claimedCommit.stderr.trim().slice(0, 200)}`);

    // A binary this host cannot execute is attested by the release lane's evidence file or it does not ship.
    // Fail-closed: absent evidence is a refusal, never a silent skip.
    const unattested = join(root, 'npm-unattested-prebuilts');
    mkdirSync(unattested, { recursive: true });
    for (const name of ['cosyncing-linux-x64', 'cosyncing-linux-arm64', 'cosyncing-darwin-arm64']) {
      copyFileSync(join(prebuilts, name), join(unattested, name));
    }
    copyFileSync(join(prebuilts, 'cosyncing-linux-arm64.evidence.json'),
      join(unattested, 'cosyncing-linux-arm64.evidence.json'));
    const missingEvidence = await run([
      'bun', 'run', 'scripts/release/build-npm-package.ts',
      '--binary-dir', unattested, '--web-dir', webFixture, '--commit', STAMPED_WEB_FIXTURE_COMMIT,
      '--output-dir', join(root, 'npm-unattested-out'), '--no-pack',
    ], { cwd: ROOT, timeoutMs: 180_000 });
    check('packaging refuses a cross-compiled prebuilt that carries no provenance evidence',
      missingEvidence.exitCode !== 0
        && /provenance evidence/.test(missingEvidence.stderr)
        && /darwin-arm64/.test(missingEvidence.stderr),
      `exit=${missingEvidence.exitCode} ${missingEvidence.stderr.trim().slice(0, 200)}`);

    // Evidence has to describe THESE bytes, not merely exist beside them.
    const swapped = join(root, 'npm-swapped-prebuilts');
    mkdirSync(swapped, { recursive: true });
    for (const entry of readdirSync(prebuilts)) copyFileSync(join(prebuilts, entry), join(swapped, entry));
    writeFileSync(join(swapped, 'cosyncing-darwin-arm64'),
      Buffer.concat([machOArm64, Buffer.from('tampered')]), { mode: 0o755 });
    const tampered = await run([
      'bun', 'run', 'scripts/release/build-npm-package.ts',
      '--binary-dir', swapped, '--web-dir', webFixture, '--commit', STAMPED_WEB_FIXTURE_COMMIT,
      '--output-dir', join(root, 'npm-swapped-out'), '--no-pack',
    ], { cwd: ROOT, timeoutMs: 180_000 });
    check('packaging refuses a prebuilt whose bytes do not match its evidence',
      tampered.exitCode !== 0 && /does not describe the staged/.test(tampered.stderr),
      `exit=${tampered.exitCode} ${tampered.stderr.trim().slice(0, 200)}`);

    // --require-clean is the gate build-broker.ts applies to a binary it builds; it must also cover a
    // binary it was handed. The evidence records the checkout state the artifact was built from.
    const dirtyPrebuilts = join(root, 'npm-dirty-prebuilts');
    mkdirSync(dirtyPrebuilts, { recursive: true });
    for (const entry of readdirSync(prebuilts)) copyFileSync(join(prebuilts, entry), join(dirtyPrebuilts, entry));
    const dirtyEvidencePath = join(dirtyPrebuilts, 'cosyncing-darwin-arm64.evidence.json');
    writeFileSync(dirtyEvidencePath, `${JSON.stringify({
      ...JSON.parse(readFileSync(dirtyEvidencePath, 'utf8')), dirty: true,
    }, null, 2)}\n`);
    const dirtyPrebuilt = await run([
      'bun', 'run', 'scripts/release/build-npm-package.ts',
      '--binary-dir', dirtyPrebuilts, '--web-dir', webFixture, '--commit', STAMPED_WEB_FIXTURE_COMMIT,
      '--require-clean', '--output-dir', join(root, 'npm-dirty-prebuilt-out'), '--no-pack',
    ], { cwd: ROOT, timeoutMs: 180_000 });
    check('--require-clean refuses a prebuilt whose evidence records a dirty checkout',
      dirtyPrebuilt.exitCode !== 0 && /dirty checkout/.test(dirtyPrebuilt.stderr),
      `exit=${dirtyPrebuilt.exitCode} ${dirtyPrebuilt.stderr.trim().slice(0, 200)}`);
  }

  // npm launcher fidelity. A single npm name cannot carry three binaries at one version, so `cosyncing`
  // depends on per-platform packages and its bin/cosyncing ships as a Node resolver that postinstall
  // replaces with the real binary. Both states must behave identically to running the binary directly,
  // because `--ignore-scripts` (and any manager that skips lifecycle scripts) leaves the resolver in place.
  {
    const npmRoot = join(root, 'npm-launcher');
    const platformPackage = join(
      npmRoot, 'node_modules', '@cosyncing', `broker-${process.platform}-${process.arch}`, 'bin',
    );
    mkdirSync(platformPackage, { recursive: true });
    // Stands in for the compiled broker: reports argv, exits with a chosen code, and can block on a signal.
    writeFileSync(join(platformPackage, 'cosyncing'), `#!/usr/bin/env bash
if [ "\${1:-}" = block ]; then
  exec sleep 30
fi
printf 'argv=%s\\n' "$*"
exit "\${1:-0}"
`, { mode: 0o755 });
    mkdirSync(join(npmRoot, 'bin'), { recursive: true });
    const launcher = join(npmRoot, 'bin', 'cosyncing');
    copyFileSync(join(ROOT, 'scripts/release/npm-runtime/resolver.cjs'), launcher);
    chmodSync(launcher, 0o755);

    const passthrough = await run(['node', launcher, '0', 'setup', '--yes'], { cwd: npmRoot });
    const exitCode = await run(['node', launcher, '3'], { cwd: npmRoot });
    check('the npm resolver execs the platform binary, passing argv and its exact exit code through',
      passthrough.exitCode === 0 && passthrough.stdout.includes('argv=0 setup --yes')
        && exitCode.exitCode === 3,
      `${passthrough.stdout.trim()} / exit=${exitCode.exitCode}`);

    // A terminating signal must reach the child AND be re-raised, so a supervising shell sees 128+15.
    const signalProbe = join(npmRoot, 'signal-probe.sh');
    writeFileSync(signalProbe, `#!/usr/bin/env bash
node ${JSON.stringify(launcher)} block >/dev/null 2>&1 &
PID=$!
sleep 1
kill -TERM "$PID" 2>/dev/null
wait "$PID"
printf 'status=%s\\n' "$?"
`, { mode: 0o755 });
    const signalled = await run(['bash', signalProbe], { cwd: npmRoot, timeoutMs: 30_000 });
    // 143 == 128 + SIGTERM. The child has no trap, so it dies of the signal; the launcher must re-raise
    // rather than translate it, or a supervisor would see a plain exit where a signal death occurred.
    check('the npm resolver forwards SIGTERM and dies of the same signal rather than swallowing it',
      /status=143\b/.test(signalled.stdout),
      signalled.stdout.trim());

    // No platform package for this host: a named, actionable refusal, not a stack trace.
    const bareRoot = join(root, 'npm-launcher-bare');
    mkdirSync(join(bareRoot, 'bin'), { recursive: true });
    const bareLauncher = join(bareRoot, 'bin', 'cosyncing');
    copyFileSync(join(ROOT, 'scripts/release/npm-runtime/resolver.cjs'), bareLauncher);
    const unsupported = await run(['node', bareLauncher, 'version'], { cwd: bareRoot });
    check('the npm resolver refuses a host with no platform package by name',
      unsupported.exitCode === 1
        && /no broker binary is installed/.test(unsupported.stderr)
        && /--ignore-scripts/.test(unsupported.stderr),
      unsupported.stderr.trim().slice(0, 160));

    // A supported host with NO platform package must fail the install rather than report success and leave
    // `npm install -g cosyncing` with no usable broker.
    copyFileSync(join(ROOT, 'scripts/release/npm-runtime/install.cjs'), join(bareRoot, 'install.cjs'));
    const missingPlatform = await run(['node', join(bareRoot, 'install.cjs')], { cwd: bareRoot });
    check('postinstall fails loudly when the host is supported but its platform package is absent',
      missingPlatform.exitCode === 1
        && /was not installed/.test(missingPlatform.stderr)
        && /--omit=optional/.test(missingPlatform.stderr)
        && /lockfile/.test(missingPlatform.stderr),
      `exit=${missingPlatform.exitCode} ${missingPlatform.stderr.trim().slice(0, 120)}`);

    // Why both of those messages are written with fs.writeSync rather than process.stderr.write.
    //
    // Those two checks are exactly the ones that failed on a reviewer's machine and passed here, and this
    // pin explains the difference rather than repeating the coin flip. Node makes fd 2 synchronous for
    // files and TTYs, and for pipes it depends on whether the descriptor ended up blocking: this suite's
    // supervisor hands the child a BLOCKING pipe, so the old pattern survived here, while a shell pipeline
    // — what npm and CI actually put a postinstall script behind — hands it a non-blocking one, where
    // `process.exit()` on the next line drops whatever has not drained.
    //
    // So the probe runs behind a real shell pipeline and sizes the message past the pipe buffer, making the
    // loss deterministic instead of ambient. `wc -c` reports what a consumer would actually have received.
    const flushProbe = (body: string): string => `${body}\nprocess.exit(1);\n`;
    const probeBytes = 200_000;
    writeFileSync(join(bareRoot, 'flush-async.cjs'),
      flushProbe(`process.stderr.write('E'.repeat(${probeBytes}));`));
    writeFileSync(join(bareRoot, 'flush-sync.cjs'),
      flushProbe(`require('node:fs').writeSync(2, 'E'.repeat(${probeBytes}));`));
    const piped = async (script: string): Promise<number> => {
      const result = await run(
        ['sh', '-c', `node ${join(bareRoot, script)} 2>&1 >/dev/null | wc -c`],
        { cwd: bareRoot },
      );
      return Number(result.stdout.trim());
    };
    const asyncDelivered = await piped('flush-async.cjs');
    const syncDelivered = await piped('flush-sync.cjs');
    check('a fast-exiting child\'s stderr reaches a pipe consumer only when written synchronously',
      syncDelivered === probeBytes && asyncDelivered < probeBytes,
      `writeSync=${syncDelivered} stderr.write=${asyncDelivered} of ${probeBytes}`);

    // The shared sidecar lives beside the MAIN package's bin/cosyncing, because that is the path postinstall
    // swaps the platform binary into. On the --ignore-scripts path the resolver survives and execs the
    // PLATFORM package's binary instead, whose directory holds nothing but the binary — so the resolver has
    // to hand the answer over through COSYNCING_WEB_DIR, the same override setup gives the durable service.
    {
      writeFileSync(join(npmRoot, 'package.json'), `${JSON.stringify({ version }, null, 2)}\n`);
      writeFileSync(join(platformPackage, 'cosyncing'), `#!/usr/bin/env bash
printf 'web=%s\\n' "\${COSYNCING_WEB_DIR:-unset}"
`, { mode: 0o755 });
      const withoutSidecar = await run(['node', launcher], { cwd: npmRoot });
      const sidecarRoot = join(npmRoot, 'bin', `cosyncing-web-${version}`);
      mkdirSync(sidecarRoot, { recursive: true });
      writeFileSync(join(sidecarRoot, 'index.html'), '<!doctype html><base href="/cosy/">\n');
      const withSidecar = await run(['node', launcher], { cwd: npmRoot });
      const operatorOverride = await run(['node', launcher], {
        cwd: npmRoot,
        env: hermeticEnvironment({ COSYNCING_WEB_DIR: '/operator/choice' }),
      });
      check('the resolver points the platform binary at the bundled sidecar, and never over an operator override',
        withoutSidecar.stdout.includes('web=unset')
          && withSidecar.stdout.includes(`web=${sidecarRoot}`)
          && operatorOverride.stdout.includes('web=/operator/choice'),
        [withoutSidecar.stdout, withSidecar.stdout, operatorOverride.stdout]
          .map((line) => line.trim()).join(' | '));
      // Restore the argv/exit-code probe the swap check below asserts against.
      writeFileSync(join(platformPackage, 'cosyncing'), `#!/usr/bin/env bash
if [ "\${1:-}" = block ]; then
  exec sleep 30
fi
printf 'argv=%s\\n' "$*"
exit "\${1:-0}"
`, { mode: 0o755 });
    }

    // The postinstall swap must leave the command AS the binary, so steady state has no interposed process.
    copyFileSync(join(ROOT, 'scripts/release/npm-runtime/install.cjs'), join(npmRoot, 'install.cjs'));
    const swap = await run(['node', join(npmRoot, 'install.cjs')], { cwd: npmRoot });
    const swapped = readFileSync(launcher, 'utf8');
    const afterSwap = await run([launcher, '0', 'direct'], { cwd: npmRoot });
    check('postinstall replaces the resolver with the binary itself, leaving no Node process in between',
      swap.exitCode === 0 && !swapped.includes('require(') && swapped.startsWith('#!/usr/bin/env bash')
        && afterSwap.exitCode === 0 && afterSwap.stdout.includes('argv=0 direct'),
      `${swap.exitCode}/${afterSwap.exitCode}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((item) => !item.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length}/${results.length} release supply-chain checks failed.`);
  process.exit(1);
}
console.log(`\nPASS ${results.length}/${results.length} release supply-chain checks`);
