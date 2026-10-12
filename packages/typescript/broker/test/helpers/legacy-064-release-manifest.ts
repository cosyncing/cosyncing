/** Frozen parser/verifier bodies from public Prepare release 0.6.4
 *  3b2a635dd3b8265d808367fe678c46f116537ff3. Only local function names were prefixed.
 *  This exercises the legacy unknown-field/signature behavior, not a released binary.
 */
import { verify as verifySignature } from 'node:crypto';
import { PRODUCT_IDENTITY } from '../../../protocol/src/product.ts';
import type {
  ReleaseArtifact, ReleaseContractIdentity, ReleaseWebSidecar,
  ReleaseJavaScriptApp, ReleaseAndroidApp, ReleaseManifest,
} from '../../src/updates/release-upgrade.ts';
// These values are frozen with the legacy function bodies rather than imported from today's updater.
const RELEASE_MANIFEST_SCHEMA_VERSION = 1 as const;
const MAX_RELEASE_ARTIFACT_BYTES = 256 * 1024 * 1024;
const RELEASE_ARTIFACT_TARGETS = Object.freeze(['linux-x64', 'linux-arm64', 'darwin-arm64'] as const);
const RELEASE_JAVASCRIPT_APP_NAME = 'cosyncing-app.js' as const;
const RELEASE_JAVASCRIPT_APP_TARGET = 'universal' as const;

function legacyPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function legacyCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(legacyCanonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${legacyCanonicalJson(item)}`)
    .join(',')}}`;
}

export function legacyReleaseManifestSigningPayload(manifest: Omit<ReleaseManifest, 'signature'>): Uint8Array {
  return Buffer.from(legacyCanonicalJson(manifest), 'utf8');
}

function legacySafeHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2_048 || /[\0\r\n]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function legacyValidVersion(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    return false;
  }
  const [core] = value.split('-', 1);
  return core!.split('.').every((part) => Number.isSafeInteger(Number(part)));
}

function legacyValidSha(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function legacyValidReleaseArtifact(value: unknown): value is ReleaseArtifact {
  if (!legacyPlainObject(value)) return false;
  return typeof value.name === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.name)
    && typeof value.target === 'string'
    && (RELEASE_ARTIFACT_TARGETS as readonly string[]).includes(value.target)
    && (value.platform === 'linux' || value.platform === 'darwin')
    && (value.arch === 'x64' || value.arch === 'arm64')
    && Number.isSafeInteger(value.size) && (value.size as number) > 0
    && (value.size as number) <= MAX_RELEASE_ARTIFACT_BYTES
    && legacyValidSha(value.sha256)
    && legacySafeHttpsUrl(value.url)
    && legacySafeHttpsUrl(value.provenanceUrl);
}

function legacyValidReleaseContract(value: unknown): value is ReleaseContractIdentity {
  if (!legacyPlainObject(value)) return false;
  return Number.isSafeInteger(value.revision) && (value.revision as number) >= 0
    && Number.isSafeInteger(value.minimumClientRevision)
    && (value.minimumClientRevision as number) >= 0
    && (value.minimumClientRevision as number) <= (value.revision as number)
    && typeof value.surfaceHash === 'string'
    && /^fnv1a32:[a-f0-9]{8}$/.test(value.surfaceHash);
}

function legacyValidReleaseWebSidecar(value: unknown): value is ReleaseWebSidecar {
  if (!legacyPlainObject(value)) return false;
  return value.name === 'cosyncing-web-app.tar.gz'
    && value.mount === '/cosy/'
    && Number.isSafeInteger(value.size) && (value.size as number) > 0
    && (value.size as number) <= MAX_RELEASE_ARTIFACT_BYTES
    && legacyValidSha(value.sha256)
    && legacySafeHttpsUrl(value.url)
    && typeof value.buildId === 'string'
    && /^[a-f0-9]{16}$/.test(value.buildId)
    && legacyValidSha(value.cacheManifestSha256)
    && legacyValidSha(value.mainDartSha256)
    && legacyValidSha(value.directorySha256)
    && Number.isSafeInteger(value.fileCount)
    && (value.fileCount as number) > 0
    && (value.fileCount as number) <= 100_000;
}

function legacyValidReleaseJavaScriptApp(value: unknown): value is ReleaseJavaScriptApp {
  if (!legacyPlainObject(value)) return false;
  return value.name === RELEASE_JAVASCRIPT_APP_NAME
    && value.target === RELEASE_JAVASCRIPT_APP_TARGET
    && Number.isSafeInteger(value.size) && (value.size as number) > 0
    && (value.size as number) <= MAX_RELEASE_ARTIFACT_BYTES
    && legacyValidSha(value.sha256)
    && legacySafeHttpsUrl(value.url)
    && legacySafeHttpsUrl(value.provenanceUrl)
    && typeof value.minimumBunVersion === 'string'
    && /^\d+\.\d+\.\d+$/.test(value.minimumBunVersion);
}

function legacyValidReleaseAndroidApp(value: unknown): value is ReleaseAndroidApp {
  if (!legacyPlainObject(value)) return false;
  return typeof value.name === 'string'
    && /^cosyncing-client-\d+\.\d+\.\d+-android\.apk$/.test(value.name)
    && value.applicationId === 'com.cosyncing.client'
    && Number.isSafeInteger(value.versionCode) && (value.versionCode as number) > 0
    && Number.isSafeInteger(value.size) && (value.size as number) > 0
    && (value.size as number) <= MAX_RELEASE_ARTIFACT_BYTES
    && legacyValidSha(value.sha256)
    && legacySafeHttpsUrl(value.url)
    && legacyValidSha(value.signerSha256);
}

function legacyParseManifest(value: unknown): ReleaseManifest {
  if (!legacyPlainObject(value)
      || value.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION
      || value.product !== PRODUCT_IDENTITY.productName
      || !legacyValidVersion(value.version)
      || value.channel !== 'stable'
      || typeof value.sourceCommit !== 'string' || !/^[a-f0-9]{7,64}$/.test(value.sourceCommit)
      || typeof value.publishedAt !== 'string' || !Number.isFinite(Date.parse(value.publishedAt))
      || !Array.isArray(value.artifacts) || value.artifacts.length > 8
      || !value.artifacts.every(legacyValidReleaseArtifact)
      // Native-free releases are complete broker/web pairs, never an empty channel entry.
      || (value.artifacts.length === 0
        && (value.jsApp === undefined || value.contract === undefined || value.webApp === undefined))
      || ((value.contract === undefined) !== (value.webApp === undefined))
      || (value.contract !== undefined && !legacyValidReleaseContract(value.contract))
      || (value.webApp !== undefined && !legacyValidReleaseWebSidecar(value.webApp))
      || (value.jsApp !== undefined && !legacyValidReleaseJavaScriptApp(value.jsApp))
      || (value.androidApp !== undefined && !legacyValidReleaseAndroidApp(value.androidApp))
      || !legacyPlainObject(value.signature)
      || value.signature.algorithm !== 'ed25519'
      || typeof value.signature.keyId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(value.signature.keyId)
      || typeof value.signature.value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.signature.value)) {
    throw new Error('release-manifest-invalid');
  }
  const manifest = value as unknown as ReleaseManifest;
  if (new Set(manifest.artifacts.map((artifact) => artifact.target)).size !== manifest.artifacts.length) {
    throw new Error('release-manifest-duplicate-target');
  }
  return manifest;
}

export function legacyVerifySignedManifest(
  value: unknown,
  trustedKeys: Readonly<Record<string, string>>,
): ReleaseManifest {
  const manifest = legacyParseManifest(value);
  const trustedKey = trustedKeys[manifest.signature.keyId];
  if (!trustedKey) throw new Error('release-signing-key-untrusted');
  const { signature, ...unsigned } = manifest;
  let verified = false;
  try {
    verified = verifySignature(
      null,
      legacyReleaseManifestSigningPayload(unsigned),
      trustedKey,
      Buffer.from(signature.value, 'base64'),
    );
  } catch {
    verified = false;
  }
  if (!verified) throw new Error('release-manifest-signature-invalid');
  return manifest;
}
