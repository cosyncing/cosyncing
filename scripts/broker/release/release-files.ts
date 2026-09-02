import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  RELEASE_JAVASCRIPT_APP_NAME,
  RELEASE_JAVASCRIPT_APP_TARGET,
  releaseManifestSigningPayload,
  verifyReleaseManifest,
  verifyReleasePairing,
  type ReleaseArtifact,
  type ReleaseManifest,
} from '../../../packages/typescript/broker/src/updates/release-upgrade.ts';
import { MINIMUM_BUN_RUNTIME_VERSION } from '../../../packages/typescript/broker/src/runtime/application-identity.ts';
import {
  PUBLISHED_SCHEMA_VERSIONS,
  type PublishedBrokerContract,
  type PublishedSchemaVersions,
} from '../../../packages/typescript/broker/src/runtime/build-info.ts';
import { PRODUCT_IDENTITY } from '../../../packages/typescript/protocol/src/product.ts';
import {
  createCompiledSoftwareInventory,
  createSpdxSoftwareBom,
  createThirdPartyNotices,
} from './software-inventory.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const BOOTSTRAP_TEMPLATE = join(import.meta.dir, 'bootstrap-template.sh');

/**
 * Targets every assembled release MUST publish; assembly fails without all of them. macOS is a first-class
 * broker host, so darwin-arm64 is part of the required set rather than an optional extra — a release that
 * cannot be installed or upgraded on a Mac is not a release that supports macOS. Intel is out of scope.
 */
export const RELEASE_TARGETS = Object.freeze(['linux-x64', 'linux-arm64', 'darwin-arm64'] as const);
/** Kept as the schema-level alias of the required set; every known target is now published. */
export const KNOWN_RELEASE_TARGETS = RELEASE_TARGETS;
export type ReleaseTarget = (typeof RELEASE_TARGETS)[number];

export function releaseTargetPlatform(target: ReleaseTarget): 'linux' | 'darwin' {
  return target.startsWith('darwin-') ? 'darwin' : 'linux';
}

export function releaseTargetArch(target: ReleaseTarget): 'x64' | 'arm64' {
  return target.endsWith('-x64') ? 'x64' : 'arm64';
}
export const WEB_SIDECAR_NAME = 'cosyncing-web-app.tar.gz' as const;

/**
 * The second signature, emitted as a SIBLING FILE rather than a second manifest field.
 *
 * A shipped broker hard-rejects any manifest whose `signature.algorithm` is not `ed25519`, so switching the
 * manifest to another algorithm would strand every installed broker behind a channel it can no longer read —
 * including the release that would have taught it the new algorithm. Ed25519 therefore stays, unchanged, and
 * the manifest schema does not grow a second signature field.
 *
 * What this adds is a detached ECDSA P-256 signature over the same bytes, for a consumer that cannot verify
 * Ed25519 at all: Windows PowerShell. PowerShell 5.1 runs on .NET Framework 4.x, Windows CNG exposes no
 * Ed25519 algorithm identifier, and Windows ships no system OpenSSL — so a PowerShell installer has no way to
 * check the Ed25519 signature and no WSL to hand off to. P-256 is verifiable there with no dependency.
 *
 * Each consumer verifies exactly ONE signature: the broker's own self-update path and `install.sh` verify
 * Ed25519 as they always have and are untouched; a PowerShell installer verifies P-256. Nobody verifies both,
 * and neither signature is a fallback for the other.
 */
export const P256_PUBLIC_KEY_NAME = 'release-key-p256.pem' as const;
/** Suffix of a detached P-256 signature file: `<payload>.p256.sig` beside `<payload>.sig`. */
export const P256_SIGNATURE_SUFFIX = '.p256.sig' as const;

export interface PackageEvidence {
  schemaVersion: 1;
  product: typeof PRODUCT_IDENTITY.productName;
  artifact: string;
  version: string;
  target: ReleaseTarget;
  sourceCommit: string;
  buildDate: string;
  size: number;
  sha256: string;
  packaged: true;
  dirty: false;
  schemaVersions: PublishedSchemaVersions;
  contract: PublishedBrokerContract;
  cleanCheckout: true;
  offlineVersionCheck: true;
  forbiddenContentCheck: true;
  runner: {
    os: 'linux' | 'darwin';
    arch: 'x64' | 'arm64';
    image: string;
    invocationId: string;
  };
}

/**
 * Evidence for the JavaScript application bundle, alongside the native and web shapes.
 *
 * It records `distribution` where the native shape records `target`, because that is the term that actually
 * distinguishes this artifact from the identical-looking bundle npm publishes. `runner` describes the host
 * that produced the bytes and is provenance only: the artifact itself is bound to no machine code.
 */
export interface JavaScriptPackageEvidence {
  schemaVersion: 1;
  product: typeof PRODUCT_IDENTITY.productName;
  artifact: typeof RELEASE_JAVASCRIPT_APP_NAME;
  version: string;
  target: typeof RELEASE_JAVASCRIPT_APP_TARGET;
  distribution: 'bootstrap-js';
  sourceCommit: string;
  buildDate: string;
  size: number;
  sha256: string;
  minimumBunVersion: string;
  packaged: true;
  dirty: false;
  schemaVersions: PublishedSchemaVersions;
  contract: PublishedBrokerContract;
  cleanCheckout: true;
  offlineVersionCheck: true;
  forbiddenContentCheck: true;
  runner: {
    os: 'linux' | 'darwin';
    arch: 'x64' | 'arm64';
    image: string;
    invocationId: string;
  };
}

export interface WebPackageEvidence {
  schemaVersion: 1;
  product: typeof PRODUCT_IDENTITY.productName;
  artifact: typeof WEB_SIDECAR_NAME;
  version: string;
  sourceCommit: string;
  buildDate: string;
  size: number;
  sha256: string;
  baseHref: '/cosy/';
  contract: {
    revision: number;
    minimumClientRevision: number;
    clientMinimumBrokerRevision: number;
    surfaceHash: string;
  };
  buildId: string;
  cacheManifestSha256: string;
  mainDartSha256: string;
  directorySha256: string;
  fileCount: number;
  cleanCheckout: true;
}

export interface ReleaseAssemblyOptions {
  artifactDirectory: string;
  evidenceDirectory: string;
  outputDirectory: string;
  baseUrl: string;
  version: string;
  sourceCommit: string;
  publishedAt: string;
  keyId: string;
  privateKeyPem: string;
  publicKeyPem: string;
  /** ECDSA P-256 key pair for the sibling signatures. See {@link P256_PUBLIC_KEY_NAME}. */
  p256PrivateKeyPem: string;
  p256PublicKeyPem: string;
}

export interface ReleaseAssemblyResult {
  manifest: ReleaseManifest;
  outputDirectory: string;
  publishedFiles: string[];
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalIso(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO-8601 instant`);
  }
  return value;
}

function version(value: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) || value === '0.0.0') {
    throw new Error('release version is invalid');
  }
  return value;
}

function baseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('release base URL is invalid');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('release base URL must be credential-free HTTPS without query or fragment');
  }
  return value.replace(/\/+$/, '');
}

function exactObject(value: unknown, expected: unknown): boolean {
  return JSON.stringify(value) === JSON.stringify(expected);
}

function readEvidence(path: string, target: ReleaseTarget, options: ReleaseAssemblyOptions): PackageEvidence {
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<PackageEvidence>;
  const artifact = `${PRODUCT_IDENTITY.releaseAssetPrefix}-${target}`;
  if (value.schemaVersion !== 1 || value.product !== PRODUCT_IDENTITY.productName
      || value.artifact !== artifact || value.version !== options.version || value.target !== target
      || value.sourceCommit !== options.sourceCommit || value.buildDate !== options.publishedAt
      || value.packaged !== true || value.dirty !== false || value.cleanCheckout !== true
      || value.offlineVersionCheck !== true || value.forbiddenContentCheck !== true
      || !exactObject(value.schemaVersions, PUBLISHED_SCHEMA_VERSIONS)
      || !value.contract || !Number.isSafeInteger(value.contract.revision)
      || !Number.isSafeInteger(value.contract.minimumClientRevision)
      || typeof value.contract.surfaceHash !== 'string'
      || !/^fnv1a32:[a-f0-9]{8}$/.test(value.contract.surfaceHash)
      || !value.runner || value.runner.os !== releaseTargetPlatform(target)
      || value.runner.arch !== releaseTargetArch(target)
      || typeof value.runner.image !== 'string' || !value.runner.image
      || typeof value.runner.invocationId !== 'string' || !value.runner.invocationId
      || !Number.isSafeInteger(value.size) || Number(value.size) <= 0
      || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error(`package evidence is invalid for ${target}`);
  }
  return value as PackageEvidence;
}

function readWebEvidence(path: string, options: ReleaseAssemblyOptions): WebPackageEvidence {
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<WebPackageEvidence>;
  if (value.schemaVersion !== 1 || value.product !== PRODUCT_IDENTITY.productName
      || value.artifact !== WEB_SIDECAR_NAME || value.version !== options.version
      || value.sourceCommit !== options.sourceCommit || value.buildDate !== options.publishedAt
      || value.baseHref !== '/cosy/' || value.cleanCheckout !== true
      || !value.contract || !Number.isSafeInteger(value.contract.revision)
      || !Number.isSafeInteger(value.contract.minimumClientRevision)
      || !Number.isSafeInteger(value.contract.clientMinimumBrokerRevision)
      || typeof value.contract.surfaceHash !== 'string'
      || !/^fnv1a32:[a-f0-9]{8}$/.test(value.contract.surfaceHash)
      || typeof value.buildId !== 'string' || !/^[a-f0-9]{16}$/.test(value.buildId)
      || typeof value.cacheManifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.cacheManifestSha256)
      || typeof value.mainDartSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.mainDartSha256)
      || typeof value.directorySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.directorySha256)
      || !Number.isSafeInteger(value.fileCount) || Number(value.fileCount) <= 0
      || !Number.isSafeInteger(value.size) || Number(value.size) <= 0
      || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error('web package evidence is invalid');
  }
  return value as WebPackageEvidence;
}

function readJavaScriptEvidence(
  path: string,
  options: ReleaseAssemblyOptions,
): JavaScriptPackageEvidence {
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<JavaScriptPackageEvidence>;
  if (value.schemaVersion !== 1 || value.product !== PRODUCT_IDENTITY.productName
      || value.artifact !== RELEASE_JAVASCRIPT_APP_NAME || value.version !== options.version
      || value.target !== RELEASE_JAVASCRIPT_APP_TARGET
      // The published bundle must be the installer-owned kind. `packaged` is true for the npm build too, so
      // it cannot tell them apart, and an npm-owned bundle signed into this channel would tell every curl
      // install to run `npm update` on files npm never placed.
      || value.distribution !== 'bootstrap-js'
      || value.sourceCommit !== options.sourceCommit || value.buildDate !== options.publishedAt
      || value.packaged !== true || value.dirty !== false || value.cleanCheckout !== true
      || value.offlineVersionCheck !== true || value.forbiddenContentCheck !== true
      || typeof value.minimumBunVersion !== 'string'
      || !/^\d+\.\d+\.\d+$/.test(value.minimumBunVersion)
      || !exactObject(value.schemaVersions, PUBLISHED_SCHEMA_VERSIONS)
      || !value.contract || !Number.isSafeInteger(value.contract.revision)
      || !Number.isSafeInteger(value.contract.minimumClientRevision)
      || typeof value.contract.surfaceHash !== 'string'
      || !/^fnv1a32:[a-f0-9]{8}$/.test(value.contract.surfaceHash)
      || !value.runner || (value.runner.os !== 'linux' && value.runner.os !== 'darwin')
      || (value.runner.arch !== 'x64' && value.runner.arch !== 'arm64')
      || typeof value.runner.image !== 'string' || !value.runner.image
      || typeof value.runner.invocationId !== 'string' || !value.runner.invocationId
      || !Number.isSafeInteger(value.size) || Number(value.size) <= 0
      || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error('JavaScript package evidence is invalid');
  }
  return value as JavaScriptPackageEvidence;
}

function writeJson(path: string, value: unknown): Uint8Array {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  writeFileSync(path, bytes, { mode: 0o644 });
  return bytes;
}

function detachedSignature(bytes: Uint8Array, privateKeyPem: string): Uint8Array {
  return sign(null, bytes, createPrivateKey(privateKeyPem));
}

function writeSignature(path: string, bytes: Uint8Array, privateKeyPem: string): void {
  writeFileSync(path, detachedSignature(bytes, privateKeyPem), { mode: 0o644 });
}

/**
 * Detached ECDSA P-256 signature in IEEE P1363 form — the raw 64-byte `r || s`, not a DER SEQUENCE.
 *
 * The format is chosen by the one consumer this signature exists for. .NET's `ECDsa.VerifyData(byte[],
 * byte[], HashAlgorithmName)` — the only overload Windows PowerShell 5.1's .NET Framework 4.x offers — reads
 * exactly this layout, so a PowerShell installer verifies with two lines and no ASN.1 parsing. DER would be
 * the friendlier choice for `openssl dgst -verify`, but no Unix consumer needs this signature: on Unix the
 * Ed25519 signature is the one that is checked, and it is unchanged.
 */
function detachedP256Signature(bytes: Uint8Array, privateKeyPem: string): Uint8Array {
  return sign('sha256', bytes, { key: createPrivateKey(privateKeyPem), dsaEncoding: 'ieee-p1363' });
}

function writeP256Signature(path: string, bytes: Uint8Array, options: {
  privateKeyPem: string;
  publicKeyPem: string;
}): void {
  const signature = detachedP256Signature(bytes, options.privateKeyPem);
  // Self-verify every P-256 signature as it is written. Nothing in this repository consumes these files yet,
  // so a silently malformed signature would first be discovered by a Windows operator months from now.
  if (!verify(
    'sha256',
    bytes,
    { key: createPublicKey(options.publicKeyPem), dsaEncoding: 'ieee-p1363' },
    signature,
  )) {
    throw new Error(`P-256 signature failed its own verification: ${basename(path)}`);
  }
  writeFileSync(path, signature, { mode: 0o644 });
}

function renderBootstrap(options: {
  version: string;
  baseUrl: string;
  keyId: string;
  publicKeyPem: string;
  artifacts: readonly ReleaseArtifact[];
}): string {
  const publicKeyB64 = Buffer.from(options.publicKeyPem.trim() + '\n', 'utf8').toString('base64');
  // Bake the per-artifact digests into the script itself. Stock macOS ships LibreSSL, which cannot load an
  // Ed25519 public key at all, so an installer whose ONLY integrity check is an openssl signature simply
  // cannot run there. The embedded table gives every host a real, mandatory check on the bytes it is about
  // to install, with the script — delivered over TLS — as its trust root; signature verification remains
  // required wherever openssl can actually perform it.
  const artifactTable = options.artifacts
    .map((artifact) => `${artifact.target} ${artifact.sha256} ${artifact.size}`)
    .join('\n');
  if (/['\\]/.test(artifactTable)) throw new Error('artifact table is not safe to embed');
  return readFileSync(BOOTSTRAP_TEMPLATE, 'utf8')
    .replaceAll('@VERSION@', options.version)
    .replaceAll('@BASE_URL@', options.baseUrl)
    .replaceAll('@KEY_ID@', options.keyId)
    .replaceAll('@PUBLIC_KEY_B64@', publicKeyB64)
    .replaceAll('@ARTIFACT_TABLE@', artifactTable);
}

function provenance(options: {
  evidence: PackageEvidence;
  artifact: ReleaseArtifact;
  inventorySha256: string;
  sbomSha256: string;
}): Record<string, unknown> {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: options.artifact.name, digest: { sha256: options.artifact.sha256 } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'https://cosyncing.dev/build/bun-compile/v1',
        externalParameters: {
          version: options.evidence.version,
          target: options.evidence.target,
          schemaVersions: options.evidence.schemaVersions,
          contract: options.evidence.contract,
        },
        internalParameters: {
          buildDate: options.evidence.buildDate,
          cleanCheckout: options.evidence.cleanCheckout,
          softwareInventorySha256: options.inventorySha256,
          spdxSbomSha256: options.sbomSha256,
        },
        resolvedDependencies: [{
          uri: 'git+https://github.com/cosyncing/cosyncing',
          digest: { gitCommit: options.evidence.sourceCommit },
        }],
      },
      runDetails: {
        builder: { id: `https://github.com/cosyncing/cosyncing/actions/runs/${options.evidence.runner.invocationId}` },
        metadata: {
          invocationId: options.evidence.runner.invocationId,
          startedOn: options.evidence.buildDate,
          finishedOn: options.evidence.buildDate,
        },
        byproducts: [{
          name: 'native-package-evidence',
          content: {
            runnerImage: options.evidence.runner.image,
            runnerArchitecture: options.evidence.runner.arch,
            offlineVersionCheck: true,
            forbiddenContentCheck: true,
          },
        }],
      },
    },
  };
}

function javaScriptProvenance(options: {
  evidence: JavaScriptPackageEvidence;
  inventorySha256: string;
  sbomSha256: string;
}): Record<string, unknown> {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: options.evidence.artifact, digest: { sha256: options.evidence.sha256 } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        // A distinct build type from the compiled one, and deliberately so: this artifact is produced
        // WITHOUT `--compile`, embeds no runtime, and is not governed by the compiled-binary control.
        buildType: 'https://cosyncing.dev/build/bun-bundle/v1',
        externalParameters: {
          version: options.evidence.version,
          target: options.evidence.target,
          distribution: options.evidence.distribution,
          minimumBunVersion: options.evidence.minimumBunVersion,
          schemaVersions: options.evidence.schemaVersions,
          contract: options.evidence.contract,
        },
        internalParameters: {
          buildDate: options.evidence.buildDate,
          cleanCheckout: options.evidence.cleanCheckout,
          softwareInventorySha256: options.inventorySha256,
          spdxSbomSha256: options.sbomSha256,
        },
        resolvedDependencies: [{
          uri: 'git+https://github.com/cosyncing/cosyncing',
          digest: { gitCommit: options.evidence.sourceCommit },
        }],
      },
      runDetails: {
        builder: { id: `https://github.com/cosyncing/cosyncing/actions/runs/${options.evidence.runner.invocationId}` },
        metadata: {
          invocationId: options.evidence.runner.invocationId,
          startedOn: options.evidence.buildDate,
          finishedOn: options.evidence.buildDate,
        },
        byproducts: [{
          name: 'javascript-package-evidence',
          content: {
            runnerImage: options.evidence.runner.image,
            runnerArchitecture: options.evidence.runner.arch,
            offlineVersionCheck: true,
            forbiddenContentCheck: true,
          },
        }],
      },
    },
  };
}

function webProvenance(options: {
  evidence: WebPackageEvidence;
  inventorySha256: string;
  sbomSha256: string;
}): Record<string, unknown> {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{
      name: options.evidence.artifact,
      digest: { sha256: options.evidence.sha256 },
    }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'https://cosyncing.dev/build/flutter-web-sidecar/v1',
        externalParameters: {
          version: options.evidence.version,
          mount: options.evidence.baseHref,
          contract: options.evidence.contract,
        },
        internalParameters: {
          buildDate: options.evidence.buildDate,
          buildId: options.evidence.buildId,
          directorySha256: options.evidence.directorySha256,
          softwareInventorySha256: options.inventorySha256,
          spdxSbomSha256: options.sbomSha256,
        },
        resolvedDependencies: [{
          uri: 'git+https://github.com/cosyncing/cosyncing',
          digest: { gitCommit: options.evidence.sourceCommit },
        }],
      },
      runDetails: {
        builder: { id: 'https://github.com/cosyncing/cosyncing/actions' },
        metadata: {
          invocationId: `web-${options.evidence.sourceCommit.slice(0, 12)}`,
          startedOn: options.evidence.buildDate,
          finishedOn: options.evidence.buildDate,
        },
      },
    },
  };
}

/** Assemble, sign, and self-verify the publication directory from two native-runner artifacts. */
export function assembleRelease(options: ReleaseAssemblyOptions): ReleaseAssemblyResult {
  const releaseVersion = version(options.version);
  if (!/^[a-f0-9]{40,64}$/.test(options.sourceCommit)) throw new Error('release source commit must be full hexadecimal');
  const publishedAt = canonicalIso(options.publishedAt, 'publishedAt');
  const releaseBase = baseUrl(options.baseUrl);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(options.keyId)) throw new Error('release key id is invalid');
  const privateKey = createPrivateKey(options.privateKeyPem);
  const publicKey = createPublicKey(options.publicKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('release signing keys must be Ed25519');
  }
  const keyProbe = Buffer.from('cosyncing-release-key-check', 'utf8');
  if (!verify(null, keyProbe, publicKey, sign(null, keyProbe, privateKey))) {
    throw new Error('release signing key pair does not match');
  }
  // The P-256 pair is validated BESIDE the Ed25519 guard above, never in place of it. Relaxing that guard
  // into "either algorithm" would let a release signed with only the P-256 key through, and every installed
  // broker would reject it — the exact failure keeping Ed25519 avoids.
  const p256PrivateKey = createPrivateKey(options.p256PrivateKeyPem);
  const p256PublicKey = createPublicKey(options.p256PublicKeyPem);
  if (p256PrivateKey.asymmetricKeyType !== 'ec' || p256PublicKey.asymmetricKeyType !== 'ec'
      || p256PrivateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
      || p256PublicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('release sibling signing keys must be ECDSA P-256');
  }
  if (!verify(
    'sha256',
    keyProbe,
    { key: p256PublicKey, dsaEncoding: 'ieee-p1363' },
    sign('sha256', keyProbe, { key: p256PrivateKey, dsaEncoding: 'ieee-p1363' }),
  )) {
    throw new Error('release sibling signing key pair does not match');
  }

  mkdirSync(options.outputDirectory, { recursive: true });
  const publicKeyName = 'release-key.pem';
  writeFileSync(
    join(options.outputDirectory, publicKeyName),
    `${options.publicKeyPem.trim()}\n`,
    { mode: 0o644 },
  );
  writeFileSync(
    join(options.outputDirectory, P256_PUBLIC_KEY_NAME),
    `${options.p256PublicKeyPem.trim()}\n`,
    { mode: 0o644 },
  );
  const inventory = createCompiledSoftwareInventory({
    version: releaseVersion,
    sourceCommit: options.sourceCommit,
    generatedAt: publishedAt,
  });
  const inventoryName = 'software-inventory.json';
  const inventoryBytes = writeJson(join(options.outputDirectory, inventoryName), inventory);
  const inventoryHash = sha256(inventoryBytes);
  const sbomName = 'software-bom.spdx.json';
  const sbomBytes = writeJson(
    join(options.outputDirectory, sbomName),
    createSpdxSoftwareBom(inventory),
  );
  const sbomHash = sha256(sbomBytes);
  const licenseName = 'LICENSE';
  const noticeName = 'NOTICE';
  const thirdPartyNoticesName = 'THIRD_PARTY_NOTICES.txt';
  writeFileSync(
    join(options.outputDirectory, licenseName),
    readFileSync(join(ROOT, licenseName)),
    { mode: 0o644 },
  );
  writeFileSync(
    join(options.outputDirectory, noticeName),
    readFileSync(join(ROOT, noticeName)),
    { mode: 0o644 },
  );
  writeFileSync(
    join(options.outputDirectory, thirdPartyNoticesName),
    createThirdPartyNotices(inventory),
    { mode: 0o644 },
  );

  const artifacts: ReleaseArtifact[] = [];
  const evidenceByTarget = new Map<ReleaseTarget, PackageEvidence>();
  for (const target of RELEASE_TARGETS) {
    const name = `${PRODUCT_IDENTITY.releaseAssetPrefix}-${target}`;
    const artifactPath = join(options.artifactDirectory, name);
    const evidencePath = join(options.evidenceDirectory, `${name}.evidence.json`);
    const evidence = readEvidence(evidencePath, target, options);
    const bytes = readFileSync(artifactPath);
    const stats = statSync(artifactPath);
    if (!stats.isFile() || stats.size !== evidence.size || sha256(bytes) !== evidence.sha256) {
      throw new Error(`artifact no longer matches native package evidence: ${name}`);
    }
    writeFileSync(join(options.outputDirectory, name), bytes, { mode: 0o755 });
    artifacts.push({
      name,
      target,
      platform: releaseTargetPlatform(target),
      arch: releaseTargetArch(target),
      size: stats.size,
      sha256: evidence.sha256,
      url: `${releaseBase}/${name}`,
      provenanceUrl: `${releaseBase}/${name}.intoto.jsonl`,
    });
    evidenceByTarget.set(target, evidence);
  }
  const nativeContract = evidenceByTarget.get('linux-x64')!.contract;
  if (RELEASE_TARGETS.some((target) => !exactObject(evidenceByTarget.get(target)!.contract, nativeContract))) {
    throw new Error('native package evidence disagrees on broker contract identity');
  }

  for (const artifact of artifacts) {
    const name = `${artifact.name}.intoto.jsonl`;
    const statement = provenance({
      evidence: evidenceByTarget.get(artifact.target as ReleaseTarget)!,
      artifact,
      inventorySha256: inventoryHash,
      sbomSha256: sbomHash,
    });
    const bytes = Buffer.from(`${JSON.stringify(statement)}\n`, 'utf8');
    writeFileSync(join(options.outputDirectory, name), bytes, { mode: 0o644 });
    writeSignature(join(options.outputDirectory, `${name}.sig`), bytes, options.privateKeyPem);
  }

  // The JavaScript application, assembled beside the compiled set and bound to the same broker contract.
  const jsEvidence = readJavaScriptEvidence(
    join(options.evidenceDirectory, `${RELEASE_JAVASCRIPT_APP_NAME}.evidence.json`),
    options,
  );
  if (!exactObject(jsEvidence.contract, nativeContract)) {
    throw new Error('native and JavaScript package evidence disagree on broker contract identity');
  }
  const jsArtifactPath = join(options.artifactDirectory, RELEASE_JAVASCRIPT_APP_NAME);
  const jsBytes = readFileSync(jsArtifactPath);
  const jsStats = statSync(jsArtifactPath);
  if (!jsStats.isFile() || jsStats.size !== jsEvidence.size || sha256(jsBytes) !== jsEvidence.sha256) {
    throw new Error('JavaScript application no longer matches package evidence');
  }
  writeFileSync(join(options.outputDirectory, RELEASE_JAVASCRIPT_APP_NAME), jsBytes, { mode: 0o755 });
  const jsProvenanceName = `${RELEASE_JAVASCRIPT_APP_NAME}.intoto.jsonl`;
  const jsStatementBytes = Buffer.from(
    `${JSON.stringify(javaScriptProvenance({
      evidence: jsEvidence,
      inventorySha256: inventoryHash,
      sbomSha256: sbomHash,
    }))}\n`,
    'utf8',
  );
  writeFileSync(join(options.outputDirectory, jsProvenanceName), jsStatementBytes, { mode: 0o644 });
  writeSignature(
    join(options.outputDirectory, `${jsProvenanceName}.sig`),
    jsStatementBytes,
    options.privateKeyPem,
  );

  const webEvidence = readWebEvidence(
    join(options.evidenceDirectory, `${WEB_SIDECAR_NAME}.evidence.json`),
    options,
  );
  const {
    clientMinimumBrokerRevision: _clientMinimumBrokerRevision,
    ...webBrokerContract
  } = webEvidence.contract;
  if (!exactObject(webBrokerContract, nativeContract)) {
    throw new Error('native and web package evidence disagree on broker contract identity');
  }
  const webArtifactPath = join(options.artifactDirectory, WEB_SIDECAR_NAME);
  const webBytes = readFileSync(webArtifactPath);
  const webStats = statSync(webArtifactPath);
  if (!webStats.isFile() || webStats.size !== webEvidence.size
      || sha256(webBytes) !== webEvidence.sha256) {
    throw new Error('web sidecar no longer matches package evidence');
  }
  writeFileSync(
    join(options.outputDirectory, WEB_SIDECAR_NAME),
    webBytes,
    { mode: 0o644 },
  );
  const webProvenanceName = `${WEB_SIDECAR_NAME}.intoto.jsonl`;
  const webStatementBytes = Buffer.from(
    `${JSON.stringify(webProvenance({
      evidence: webEvidence,
      inventorySha256: inventoryHash,
      sbomSha256: sbomHash,
    }))}\n`,
    'utf8',
  );
  writeFileSync(
    join(options.outputDirectory, webProvenanceName),
    webStatementBytes,
    { mode: 0o644 },
  );
  writeSignature(
    join(options.outputDirectory, `${webProvenanceName}.sig`),
    webStatementBytes,
    options.privateKeyPem,
  );

  const unsigned: Omit<ReleaseManifest, 'signature'> = {
    schemaVersion: 1,
    product: PRODUCT_IDENTITY.productName,
    version: releaseVersion,
    channel: 'stable',
    sourceCommit: options.sourceCommit,
    publishedAt,
    artifacts,
    contract: { ...nativeContract },
    jsApp: {
      name: RELEASE_JAVASCRIPT_APP_NAME,
      target: RELEASE_JAVASCRIPT_APP_TARGET,
      size: jsEvidence.size,
      sha256: jsEvidence.sha256,
      url: `${releaseBase}/${RELEASE_JAVASCRIPT_APP_NAME}`,
      provenanceUrl: `${releaseBase}/${jsProvenanceName}`,
      minimumBunVersion: jsEvidence.minimumBunVersion,
    },
    webApp: {
      name: WEB_SIDECAR_NAME,
      mount: '/cosy/',
      size: webEvidence.size,
      sha256: webEvidence.sha256,
      url: `${releaseBase}/${WEB_SIDECAR_NAME}`,
      buildId: webEvidence.buildId,
      cacheManifestSha256: webEvidence.cacheManifestSha256,
      mainDartSha256: webEvidence.mainDartSha256,
      directorySha256: webEvidence.directorySha256,
      fileCount: webEvidence.fileCount,
    },
  };
  const manifest: ReleaseManifest = {
    ...unsigned,
    signature: {
      algorithm: 'ed25519',
      keyId: options.keyId,
      value: Buffer.from(detachedSignature(
        releaseManifestSigningPayload(unsigned),
        options.privateKeyPem,
      )).toString('base64'),
    },
  };
  for (const target of RELEASE_TARGETS) {
    verifyReleaseManifest({ value: manifest, target, trustedKeys: { [options.keyId]: options.publicKeyPem } });
  }
  verifyReleasePairing(manifest);
  const manifestName = 'release-manifest.json';
  const manifestBytes = writeJson(join(options.outputDirectory, manifestName), manifest);
  writeSignature(join(options.outputDirectory, `${manifestName}.sig`), manifestBytes, options.privateKeyPem);
  writeP256Signature(
    join(options.outputDirectory, `${manifestName}${P256_SIGNATURE_SUFFIX}`),
    manifestBytes,
    { privateKeyPem: options.p256PrivateKeyPem, publicKeyPem: options.p256PublicKeyPem },
  );

  const bootstrapName = 'install.sh';
  const bootstrap = renderBootstrap({
    version: releaseVersion,
    baseUrl: releaseBase,
    keyId: options.keyId,
    publicKeyPem: options.publicKeyPem,
    artifacts,
  });
  writeFileSync(join(options.outputDirectory, bootstrapName), bootstrap, { mode: 0o755 });
  chmodSync(join(options.outputDirectory, bootstrapName), 0o755);

  const checksumCandidates = [
    ...artifacts.map((artifact) => artifact.name),
    ...artifacts.flatMap((artifact) => [`${artifact.name}.intoto.jsonl`, `${artifact.name}.intoto.jsonl.sig`]),
    RELEASE_JAVASCRIPT_APP_NAME,
    jsProvenanceName,
    `${jsProvenanceName}.sig`,
    WEB_SIDECAR_NAME,
    webProvenanceName,
    `${webProvenanceName}.sig`,
    inventoryName,
    sbomName,
    licenseName,
    noticeName,
    thirdPartyNoticesName,
    publicKeyName,
    P256_PUBLIC_KEY_NAME,
    manifestName,
    `${manifestName}.sig`,
    `${manifestName}${P256_SIGNATURE_SUFFIX}`,
    bootstrapName,
  ].sort();
  const checksums = `${checksumCandidates.map((name) =>
    `${sha256(readFileSync(join(options.outputDirectory, name)))}  ${name}`).join('\n')}\n`;
  const checksumBytes = Buffer.from(checksums, 'utf8');
  writeFileSync(join(options.outputDirectory, 'SHA256SUMS'), checksumBytes, { mode: 0o644 });
  writeSignature(join(options.outputDirectory, 'SHA256SUMS.sig'), checksumBytes, options.privateKeyPem);
  writeP256Signature(
    join(options.outputDirectory, `SHA256SUMS${P256_SIGNATURE_SUFFIX}`),
    checksumBytes,
    { privateKeyPem: options.p256PrivateKeyPem, publicKeyPem: options.p256PublicKeyPem },
  );

  const publishedFiles = [
    ...checksumCandidates,
    'SHA256SUMS',
    'SHA256SUMS.sig',
    `SHA256SUMS${P256_SIGNATURE_SUFFIX}`,
  ].sort();
  const actualFiles = [...new Bun.Glob('*').scanSync({ cwd: options.outputDirectory, onlyFiles: true })].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(publishedFiles)) {
    throw new Error(`release directory contains unexpected files: ${actualFiles.join(', ')}`);
  }
  return { manifest, outputDirectory: options.outputDirectory, publishedFiles };
}

export function canonicalProductVersion(): string {
  const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version?: unknown };
  return version(String(packageJson.version ?? ''));
}
