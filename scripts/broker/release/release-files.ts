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
  verifySignedManifest,
  verifyReleasePairing,
  type ReleaseManifest,
} from '../../../packages/typescript/broker/src/updates/release-upgrade.ts';
import {
  BUN_RELEASE_DOWNLOAD_BASE,
  MINIMUM_BUN_RUNTIME_VERSION,
  PINNED_BUN_RUNTIME_ARCHIVES,
} from '../../../packages/typescript/broker/src/runtime/application-identity.ts';
import {
  PUBLISHED_SCHEMA_VERSIONS,
  type PublishedBrokerContract,
  type PublishedSchemaVersions,
} from '../../../packages/typescript/broker/src/runtime/build-info.ts';
import { PRODUCT_IDENTITY } from '../../../packages/typescript/protocol/src/product.ts';
import {
  createJavaScriptSoftwareInventory,
  createSpdxSoftwareBom,
  createJavaScriptThirdPartyNotices,
} from './software-inventory.ts';

import { assertJavaScriptBroker, exactReleaseFiles } from './javascript-release-policy.ts';

const ROOT = resolve(import.meta.dir, '../../..');

/**
 * What an installer installs. Rendered into `@INSTALL_MODE@` and read by both templates.
 *
 * `all` places the broker AND the desktop GUI client, runs `setup`, and hands the client a pairing.
 * `server` stops after placing the broker's files, which is what the installer did before the client
 * joined the release. Both are rendered from the SAME template, so the server installer is the all-in-one
 * with one branch not taken rather than a second script that can drift from it.
 */
export const INSTALL_MODES = Object.freeze(['all', 'server'] as const);
export type InstallMode = (typeof INSTALL_MODES)[number];

/**
 * The installers this release publishes, by published name.
 *
 * Four outputs, two templates, one substitution table, one set of digests. `install.ps1` is not a fork of
 * `install.sh` and `install-server.sh` is not a fork of `install.sh`: all four are rendered from the same
 * pins in the same step, so a release cannot ship one installer that points at a different artifact from
 * another — the way it could if any of them were assembled separately.
 */
export const BOOTSTRAP_TEMPLATES = Object.freeze({
  'install.sh': { template: join(import.meta.dir, 'bootstrap-template.sh'), mode: 'all' },
  'install-server.sh': { template: join(import.meta.dir, 'bootstrap-template.sh'), mode: 'server' },
  'install.ps1': { template: join(import.meta.dir, 'bootstrap-template.ps1'), mode: 'all' },
  'install-server.ps1': { template: join(import.meta.dir, 'bootstrap-template.ps1'), mode: 'server' },
} as const satisfies Record<string, { template: string; mode: InstallMode }>);

export type BootstrapName = keyof typeof BOOTSTRAP_TEMPLATES;

/**
 * The desktop clients an `all` install can place, and the archive each host is published as.
 *
 * Keyed by CLIENT host rather than by release target: the client's macOS build is named `macos-arm64`
 * where the broker's is `darwin-arm64`, and the client publishes a Windows build where the broker has no
 * native one at all. Linux arm64 is absent because no Linux arm64 client is built — an installer that
 * resolves no row there says so and finishes as a server install rather than failing.
 *
 * The extension is part of the identity, not a guess: the client release publishes an unsigned macOS DMG
 * beside the ZIP, and only the ZIP is what `ditto -x -k` can unpack without mounting a disk image.
 */
export const CLIENT_HOSTS = Object.freeze({
  'linux-x64': '.tar.gz',
  'macos-arm64': '.zip',
  'windows-x64': '.zip',
} as const);
export type ClientHost = keyof typeof CLIENT_HOSTS;

export function clientAssetName(host: ClientHost, version: string): string {
  return `${PRODUCT_IDENTITY.releaseAssetPrefix}-client-${version}-${host}${host === 'linux-x64' ? '' : '-unsigned'}${CLIENT_HOSTS[host]}`;
}

/** One desktop client artifact, as the rendered `@CLIENT_TABLE@` states it. */
export interface ClientArtifact {
  host: ClientHost;
  name: string;
  sha256: string;
  size: number;
}

/**
 * Read the client table back out of a RENDERED installer.
 *
 * The installers are the only place a client artifact's expected digest is written down — the release
 * manifest deliberately does not name them — so a reader that wants to check a published directory
 * against what its installers promise has to read the promise from the installer. Both templates spell
 * the assignment differently (`CLIENT_TABLE='…'` and `$CLIENT_TABLE = '…'`) and neither value can contain
 * a quote, because {@link renderBootstraps} refuses to embed one.
 */
export function parseRenderedClientTable(script: string): ClientArtifact[] {
  const table = /CLIENT_TABLE\s*=\s*'([^']*)'/.exec(script)?.[1];
  if (table === undefined) throw new Error('rendered installer carries no client table');
  return table.split('\n').filter((row) => row.trim() !== '').map((row) => {
    const [host, name, digest, size] = row.trim().split(/\s+/);
    if (!host || !(host in CLIENT_HOSTS)) throw new Error(`client table names an unknown host: ${host}`);
    if (!name || !digest || !/^[a-f0-9]{64}$/.test(digest) || !size || !/^[0-9]+$/.test(size)) {
      throw new Error(`client table row is malformed: ${row}`);
    }
    return { host: host as ClientHost, name, sha256: digest, size: Number(size) };
  });
}

/**
 * Resolve exactly one client artifact per desktop host from a directory of built clients.
 *
 * Required for every assembled release: a release that could not hand every desktop host
 * a client would publish an all-in-one installer that silently degrades to a server install on whichever
 * host was forgotten. Matching is by the published prefix AND the host's archive extension, so the DMG the
 * client release publishes beside the macOS ZIP is not a second candidate that makes the match ambiguous.
 */
export function resolveClientArtifacts(directory: string, releaseVersion: string): ClientArtifact[] {
  return (Object.keys(CLIENT_HOSTS) as ClientHost[]).map((host) => {
    const prefix = `${PRODUCT_IDENTITY.releaseAssetPrefix}-client-${releaseVersion}-${host}`;
    const extension = CLIENT_HOSTS[host];
    const matches = [...new Bun.Glob(`${prefix}*${extension}`)
      .scanSync({ cwd: directory, onlyFiles: true })].sort();
    if (matches.length !== 1) {
      throw new Error(
        `expected exactly one ${host} client artifact matching ${prefix}*${extension}, found ${matches.length}`,
      );
    }
    const name = matches[0]!;
    if (name !== clientAssetName(host, releaseVersion)) throw new Error(`unexpected desktop client asset: ${name}`);
    const path = join(directory, name);
    const bytes = readFileSync(path);
    const stats = statSync(path);
    if (!stats.isFile() || stats.size === 0) throw new Error(`client artifact is not a file: ${name}`);
    return { host, name, sha256: sha256(bytes), size: stats.size };
  });
}

/** Legacy native evidence targets. These are host types, never the JavaScript publication inventory. */
export const KNOWN_RELEASE_TARGETS = Object.freeze(['linux-x64', 'linux-arm64', 'darwin-arm64'] as const);
export type ReleaseTarget = (typeof KNOWN_RELEASE_TARGETS)[number];

export function releaseTargetPlatform(target: ReleaseTarget): 'linux' | 'darwin' {
  return target.startsWith('darwin-') ? 'darwin' : 'linux';
}

export function releaseTargetArch(target: ReleaseTarget): 'x64' | 'arm64' {
  return target.endsWith('-x64') ? 'x64' : 'arm64';
}
export const WEB_SIDECAR_NAME = 'cosyncing-web-app.tar.gz' as const;

/**
 * The hosts cosyncing's own installers support, and therefore the hosts the rendered Bun table must cover.
 *
 * The union rather than one list per script, because one substitution table renders both installers. Each
 * one filters the table by the host it resolved, so the rows it cannot use are inert — and a release that
 * published a Bun table missing a host either installer supports would fail assembly rather than ship an
 * installer with nothing to fetch.
 */
const BOOTSTRAP_HOST_TARGETS = Object.freeze([
  'linux-x64',
  'linux-arm64',
  'darwin-arm64',
  'windows-x64',
] as const);

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
/** The same signature in the DER SEQUENCE form `openssl dgst -verify` reads. See {@link p1363ToDer}. */
export const P256_DER_SIGNATURE_SUFFIX = '.p256.der.sig' as const;

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
  /** Built desktop clients, one per {@link CLIENT_HOSTS} entry. See {@link resolveClientArtifacts}. */
  clientDirectory: string;
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

function readWebEvidence(path: string, options: ReleaseAssemblyOptions): WebPackageEvidence {
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<WebPackageEvidence>;
  if (value.schemaVersion !== 1 || value.product !== PRODUCT_IDENTITY.productName
      || value.artifact !== WEB_SIDECAR_NAME || value.version !== options.version
      || value.sourceCommit !== options.sourceCommit || value.buildDate !== options.publishedAt
      || value.baseHref !== '/cosy/' || value.cleanCheckout !== true
      || !value.contract || !Number.isSafeInteger(value.contract.revision)
      || !Number.isSafeInteger(value.contract.minimumClientRevision)
      || !Number.isSafeInteger(value.contract.clientMinimumBrokerRevision)
      || value.contract.clientMinimumBrokerRevision < 0
      || value.contract.clientMinimumBrokerRevision > value.contract.revision
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
      || value.contract.revision !== PUBLISHED_SCHEMA_VERSIONS.brokerContract
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
 * .NET's `ECDsa.VerifyData(byte[], byte[], HashAlgorithmName)` — the only overload Windows PowerShell 5.1's
 * .NET Framework 4.x offers — reads exactly this layout, so a PowerShell installer verifies with two lines
 * and no ASN.1 parsing.
 */
function detachedP256Signature(bytes: Uint8Array, privateKeyPem: string): Uint8Array {
  return sign('sha256', bytes, { key: createPrivateKey(privateKeyPem), dsaEncoding: 'ieee-p1363' });
}

/**
 * The same signature re-encoded as the DER SEQUENCE `openssl dgst -verify` reads.
 *
 * Two encodings exist because the two consumers can each read only one natively, and neither can be asked to
 * transcode: PowerShell 5.1 has no DER overload, and openssl has no P1363 input. Encoding here rather than
 * in either consumer keeps ASN.1 out of a shell installer, where getting it wrong is a security bug.
 *
 * It is a TRANSCODE of one signature, never a second signing. ECDSA is randomized, so signing twice would
 * produce two independent signatures that could disagree — one valid and one not — and a host would have no
 * way to tell which encoding was the broken one. Re-encoding the same `r` and `s` makes the two files two
 * spellings of a single fact, and both are verified against their own encoder before either is written.
 */
function p1363ToDer(signature: Uint8Array): Uint8Array {
  if (signature.length !== 64) throw new Error('P-256 P1363 signature must be 64 bytes');
  const integer = (raw: Uint8Array): number[] => {
    let start = 0;
    while (start < raw.length - 1 && raw[start] === 0) start += 1;
    const body = Array.from(raw.subarray(start));
    // DER integers are signed, so a leading byte with the high bit set needs a zero ahead of it or it
    // would decode as negative.
    if ((body[0]! & 0x80) !== 0) body.unshift(0);
    return [0x02, body.length, ...body];
  };
  const r = integer(signature.subarray(0, 32));
  const s = integer(signature.subarray(32));
  // A P-256 SEQUENCE is at most 70 bytes, so the length is always a single byte.
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);
}

function writeP256Signature(path: string, bytes: Uint8Array, options: {
  privateKeyPem: string;
  publicKeyPem: string;
  derPath: string;
}): void {
  const signature = detachedP256Signature(bytes, options.privateKeyPem);
  const der = p1363ToDer(signature);
  const publicKey = createPublicKey(options.publicKeyPem);
  // Self-verify BOTH encodings before either is written. The installer's macOS path now depends on the DER
  // one, and a transcoding bug there would degrade a verified install into a refused one on exactly the
  // hosts this signature exists to protect.
  if (!verify('sha256', bytes, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)
      || !verify('sha256', bytes, { key: publicKey, dsaEncoding: 'der' }, der)) {
    throw new Error(`P-256 signature failed its own verification: ${basename(path)}`);
  }
  writeFileSync(path, signature, { mode: 0o644 });
  writeFileSync(options.derPath, der, { mode: 0o644 });
}

function renderBootstraps(options: {
  version: string;
  baseUrl: string;
  keyId: string;
  publicKeyPem: string;
  p256PublicKeyPem: string;
  minimumBunVersion: string;
  // The installer places exactly these two files. It no longer selects among per-host machine-code
  // artifacts: one JavaScript bundle runs on every supported host, and the web client it is paired with
  // is the same archive everywhere too, so the host only decides whether the install is supported at all.
  application: { name: string; sha256: string; size: number };
  webApp: { name: string; sha256: string; size: number };
  // The desktop clients an `all` install may place, one row per host. A `server` install carries the same
  // rows and reads none of them: one substitution table renders all four installers.
  clients: readonly ClientArtifact[];
}): Record<BootstrapName, string> {
  const publicKeyB64 = Buffer.from(options.publicKeyPem.trim() + '\n', 'utf8').toString('base64');
  // Both trust anchors are baked in, for the same reason: the installer must verify against the key IT
  // carries, never one fetched alongside the thing being verified.
  const p256PublicKeyB64 = Buffer.from(options.p256PublicKeyPem.trim() + '\n', 'utf8').toString('base64');
  // Bake the per-artifact digests into the script itself. Stock macOS ships LibreSSL, which cannot load an
  // Ed25519 public key at all, so an installer whose ONLY integrity check is an openssl signature simply
  // cannot run there. The embedded table gives every host a real, mandatory check on the bytes it is about
  // to install, with the script — delivered over TLS — as its trust root; signature verification remains
  // required wherever openssl can actually perform it.
  //
  // Rows are keyed by asset NAME rather than by target. The old table was keyed by target because the
  // installer picked one machine-code artifact out of several; keyed that way, the web sidecar — which has
  // no target — could not be listed at all, which is why the installer never checked it.
  const rows = [options.application, options.webApp];
  const artifactTable = rows.map((row) => `${row.name} ${row.sha256} ${row.size}`).join('\n');
  // The client table is keyed by HOST, unlike the artifact table above: an installer resolves its own host
  // first and then asks which client belongs to it, where the broker artifacts are the same bytes
  // everywhere. Client digests are pinned here for the same reason every other digest is — the signed
  // checksum list is the other statement, and a client is installed only when the two agree.
  const clientTable = options.clients
    .map((client) => `${client.host} ${client.name} ${client.sha256} ${client.size}`)
    .join('\n');
  if (new Set(options.clients.map((client) => client.host)).size !== options.clients.length) {
    throw new Error('client table repeats a host');
  }
  // The Bun the installer may place is pinned by the same rule as everything else it places. Rendering it
  // from the runtime constant rather than restating it here is what keeps the installer's pin and the
  // floor the application enforces from drifting apart.
  const bunRows = BOOTSTRAP_HOST_TARGETS.flatMap((host) => {
    const builds = PINNED_BUN_RUNTIME_ARCHIVES[host];
    if (!builds || builds.length === 0) {
      throw new Error(`no pinned Bun build is published for installer host ${host}`);
    }
    return builds.map((build) => {
      if (!/^[a-z0-9][a-z0-9.-]*\.zip$/.test(build.asset) || !/^[a-f0-9]{64}$/.test(build.sha256)) {
        throw new Error(`pinned Bun build is malformed for ${host}`);
      }
      return `${host} ${build.asset} ${build.sha256}`;
    });
  });
  if (new Set(bunRows).size !== bunRows.length) throw new Error('pinned Bun table repeats a build');
  const bunTable = bunRows.join('\n');
  const embedded = [
    artifactTable,
    clientTable,
    bunTable,
    BUN_RELEASE_DOWNLOAD_BASE,
    options.version,
    options.baseUrl,
    options.keyId,
    options.minimumBunVersion,
    options.application.name,
    options.webApp.name,
  ].join('\n');
  // Every one of these is interpolated into a single-quoted assignment in BOTH templates. PowerShell
  // escapes `'` by doubling it rather than with a backslash, so the two languages need different escapes
  // and neither is applied: the values are digests, URLs, asset names and versions, which never
  // legitimately contain either character, so one refusal covers both templates.
  if (/['\\]/.test(embedded)) throw new Error('bootstrap substitution is not safe to embed');
  if (!/^\d+\.\d+\.\d+$/.test(options.minimumBunVersion)) {
    throw new Error('minimum Bun version is not a release version');
  }
  // ONE table, both installers. `@PUBLIC_KEY_B64@` is in it and appears only in the shell template:
  // Windows CNG has no Ed25519 algorithm identifier and .NET Framework no implementation, so the
  // PowerShell installer omits that token rather than embedding a trust anchor it cannot use. The
  // no-token-left assertion below is what keeps that an omission rather than an oversight.
  const substitutions: ReadonlyArray<readonly [string, string]> = [
    ['@VERSION@', options.version],
    ['@BASE_URL@', options.baseUrl],
    ['@KEY_ID@', options.keyId],
    ['@PUBLIC_KEY_B64@', publicKeyB64],
    ['@P256_PUBLIC_KEY_B64@', p256PublicKeyB64],
    ['@APP_ASSET@', options.application.name],
    ['@WEB_ASSET@', options.webApp.name],
    ['@MINIMUM_BUN@', options.minimumBunVersion],
    ['@ARTIFACT_TABLE@', artifactTable],
    ['@CLIENT_TABLE@', clientTable],
    ['@BUN_TABLE@', bunTable],
    ['@BUN_RELEASE_BASE@', BUN_RELEASE_DOWNLOAD_BASE],
  ];
  const rendered = {} as Record<BootstrapName, string>;
  for (const [name, spec] of Object.entries(BOOTSTRAP_TEMPLATES) as Array<
    [BootstrapName, { template: string; mode: InstallMode }]
  >) {
    let script = readFileSync(spec.template, 'utf8');
    // Mode LAST is not an ordering detail: it is the only substitution that differs between two outputs
    // rendered from one template, so it is applied per output while everything above is shared.
    for (const [token, value] of [...substitutions, ['@INSTALL_MODE@', spec.mode] as const]) {
      script = script.replaceAll(token, value);
    }
    // A template that grew a token nobody renders would publish an installer carrying the literal
    // `@SOMETHING@` where a digest or a URL belongs, and would fail at the operator rather than here.
    const unresolved = /@[A-Z0-9_]+@/.exec(script);
    if (unresolved) throw new Error(`${name} still carries the unrendered token ${unresolved[0]}`);
    rendered[name] = script;
  }
  // Stated as an assertion, not as a comment: no Windows installer may carry the Ed25519 key. Written
  // over every `.ps1` output rather than over `install.ps1` by name, so a fifth PowerShell installer is
  // covered by existing rather than by somebody remembering to add it here.
  for (const name of Object.keys(rendered) as BootstrapName[]) {
    if (name.endsWith('.ps1') && rendered[name].includes(publicKeyB64)) {
      throw new Error(`${name} embeds the Ed25519 release key, which it cannot verify`);
    }
  }
  return rendered;
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

/** Assemble, sign, and self-verify the JavaScript release; native broker publication is not supported. */
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

  const payloads = [RELEASE_JAVASCRIPT_APP_NAME, WEB_SIDECAR_NAME];
  const evidenceFiles = payloads.map((name) => `${name}.evidence.json`);
  if (resolve(options.artifactDirectory) === resolve(options.evidenceDirectory)) {
    exactReleaseFiles(options.artifactDirectory, [...payloads, ...evidenceFiles]);
  } else {
    exactReleaseFiles(options.artifactDirectory, payloads);
    exactReleaseFiles(options.evidenceDirectory, evidenceFiles);
  }
  const clients = resolveClientArtifacts(options.clientDirectory, releaseVersion);
  exactReleaseFiles(options.clientDirectory, clients.map((client) => client.name));
  mkdirSync(options.outputDirectory, { recursive: true });
  exactReleaseFiles(options.outputDirectory, []);
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
  const inventory = createJavaScriptSoftwareInventory({
    version: releaseVersion,
    sourceCommit: options.sourceCommit,
    generatedAt: publishedAt,
    releaseArtifacts: [
      { name: RELEASE_JAVASCRIPT_APP_NAME, kind: 'javascript-broker' },
      { name: WEB_SIDECAR_NAME, kind: 'flutter-web' },
      ...clients.map((client) => ({ name: client.name, kind: 'flutter-desktop' as const })),
    ],
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
    createJavaScriptThirdPartyNotices(inventory),
    { mode: 0o644 },
  );

  const jsEvidence = readJavaScriptEvidence(
    join(options.evidenceDirectory, `${RELEASE_JAVASCRIPT_APP_NAME}.evidence.json`),
    options,
  );
  const jsArtifactPath = join(options.artifactDirectory, RELEASE_JAVASCRIPT_APP_NAME);
  const jsBytes = readFileSync(jsArtifactPath);
  assertJavaScriptBroker(jsBytes);
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
  if (!exactObject(webBrokerContract, jsEvidence.contract)) {
    throw new Error('JavaScript and web package evidence disagree on broker contract identity');
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
    artifacts: [],
    contract: { ...jsEvidence.contract },
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
  verifySignedManifest(manifest, { [options.keyId]: options.publicKeyPem });
  const paired = verifyReleasePairing(manifest);
  const manifestName = 'release-manifest.json';
  const manifestBytes = writeJson(join(options.outputDirectory, manifestName), manifest);
  writeSignature(join(options.outputDirectory, `${manifestName}.sig`), manifestBytes, options.privateKeyPem);
  writeP256Signature(
    join(options.outputDirectory, `${manifestName}${P256_SIGNATURE_SUFFIX}`),
    manifestBytes,
    {
      privateKeyPem: options.p256PrivateKeyPem,
      publicKeyPem: options.p256PublicKeyPem,
      derPath: join(options.outputDirectory, `${manifestName}${P256_DER_SIGNATURE_SUFFIX}`),
    },
  );

  // The desktop clients, copied in BEFORE the installers are rendered because their digests are baked
  // into the rendered scripts. They are deliberately NOT in the release manifest: the manifest describes
  // what a broker can upgrade ITSELF to, and a GUI client is not a broker upgrade. The signed SHA256SUMS
  // row plus the digest baked into the installer is the whole guarantee, and both release signatures
  // already cover SHA256SUMS.
  for (const client of clients) {
    writeFileSync(
      join(options.outputDirectory, client.name),
      readFileSync(join(options.clientDirectory, client.name)),
      { mode: 0o644 },
    );
  }

  const bootstraps = renderBootstraps({
    version: releaseVersion,
    baseUrl: releaseBase,
    keyId: options.keyId,
    publicKeyPem: options.publicKeyPem,
    p256PublicKeyPem: options.p256PublicKeyPem,
    minimumBunVersion: paired.jsApp.minimumBunVersion,
    application: paired.jsApp,
    webApp: paired.webApp,
    clients,
  });
  const bootstrapNames = Object.keys(bootstraps).sort() as BootstrapName[];
  for (const name of bootstrapNames) {
    // 0o755 for both. `install.ps1` is never exec'd through a mode bit — PowerShell reads it — but the
    // release directory is served over HTTPS and a file another local user cannot read is not publishable.
    writeFileSync(join(options.outputDirectory, name), bootstraps[name], { mode: 0o755 });
    chmodSync(join(options.outputDirectory, name), 0o755);
  }

  const checksumCandidates = [
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
    `${manifestName}${P256_DER_SIGNATURE_SUFFIX}`,
    ...bootstrapNames,
    ...clients.map((client) => client.name),
  ].sort();
  const checksums = `${checksumCandidates.map((name) =>
    `${sha256(readFileSync(join(options.outputDirectory, name)))}  ${name}`).join('\n')}\n`;
  const checksumBytes = Buffer.from(checksums, 'utf8');
  writeFileSync(join(options.outputDirectory, 'SHA256SUMS'), checksumBytes, { mode: 0o644 });
  writeSignature(join(options.outputDirectory, 'SHA256SUMS.sig'), checksumBytes, options.privateKeyPem);
  writeP256Signature(
    join(options.outputDirectory, `SHA256SUMS${P256_SIGNATURE_SUFFIX}`),
    checksumBytes,
    {
      privateKeyPem: options.p256PrivateKeyPem,
      publicKeyPem: options.p256PublicKeyPem,
      derPath: join(options.outputDirectory, `SHA256SUMS${P256_DER_SIGNATURE_SUFFIX}`),
    },
  );

  const publishedFiles = [
    ...checksumCandidates,
    'SHA256SUMS',
    'SHA256SUMS.sig',
    `SHA256SUMS${P256_SIGNATURE_SUFFIX}`,
    `SHA256SUMS${P256_DER_SIGNATURE_SUFFIX}`,
  ].sort();
  exactReleaseFiles(options.outputDirectory, publishedFiles);
  return { manifest, outputDirectory: options.outputDirectory, publishedFiles };
}

export function canonicalProductVersion(): string {
  const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version?: unknown };
  return version(String(packageJson.version ?? ''));
}
