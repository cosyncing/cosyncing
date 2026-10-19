/**
 * Offline fake release feed for in-app update tests.
 *
 * R0/R1/R2 are conceptually ordered releases with deterministic fixture versions,
 * not stand-ins for any real product version: no production code may branch on
 * them, and no test here asserts anything about a live channel. The feed exists to
 * make the awkward scenarios cheap:
 *
 *   - optional or entirely absent updater metadata
 *   - contract identities that are mutually incompatible
 *   - per-platform artifacts that exist for one host and not another
 *   - a mutable `latest` pointer that promotes BETWEEN two requests
 *
 * The last one is the whole reason a plan pins an immutable release identity. A
 * fetch that always returned the same body could never show a manifest and a
 * detached signature arriving from two different releases.
 */
import { createHash, generateKeyPairSync, sign, verify as verifySignature } from 'node:crypto';
import { PRODUCT_IDENTITY } from '../../../protocol/src/product.ts';
import {
  RELEASE_JAVASCRIPT_APP_NAME,
  RELEASE_JAVASCRIPT_APP_TARGET,
  releaseManifestSigningPayload,
  type ReleaseArtifact,
  type ReleaseContractIdentity,
  type ReleaseJavaScriptApp,
  type ReleaseManifest,
  type ReleaseWebSidecar,
} from '../../src/updates/release-upgrade.ts';
import {
  desktopClientAssetName,
  type DesktopClientHost,
  type ReleaseDesktopClients,
} from '../../src/updates/desktop-client-types.ts';
import type { ReleaseUpdaterMetadata, UpdaterCapability } from '../../src/updates/updater-metadata.ts';

/** Test-only key material. Never a release key, never reused outside a fixture. */
const keyPair = generateKeyPairSync('ed25519');
export const FEED_KEY_ID = 'test-release-feed';
export const FEED_PUBLIC_KEY_PEM = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
export const FEED_TRUSTED_KEYS: Readonly<Record<string, string>> = { [FEED_KEY_ID]: FEED_PUBLIC_KEY_PEM };
const FEED_PRIVATE_KEY = keyPair.privateKey;

/** Deterministic filler so two fixture releases never share an artifact identity. */
function digest(seed: string, length = 64): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, length);
}

const FEED_BASE = 'https://feed.invalid';

export const FEED_MANIFEST_URL = `${FEED_BASE}/latest/release-manifest.json`;
export const FEED_SIGNATURE_URL = `${FEED_MANIFEST_URL}.sig`;

export interface FeedUpdaterPlatform {
  minimumRuntimeVersion?: string;
  stagingBytes?: number;
  capabilities?: readonly UpdaterCapability[];
}

export interface FeedRelease {
  /** Conceptual identity used in test names: R0, R1, R2. */
  name: string;
  version: string;
  sourceCommit: string;
  publishedAt: string;
  /** Omit to publish a legacy manifest that carries no contract identity. */
  contract?: ReleaseContractIdentity;
  /** Omit to publish a release that makes no in-app update promise. */
  updater?: ReleaseUpdaterMetadata;
  /** Desktop archives this release publishes, and their per-host facts. */
  desktop?: Partial<Record<DesktopClientHost, FeedUpdaterPlatform>>;
  /** Include to publish the JavaScript broker bundle, as a real pair does. */
  jsApp?: boolean;
}

/**
 * One surface identity per revision, shared by the broker contract and the client
 * contract of the same revision.
 *
 * A client advertises the broker's own surface hash, so two peers at the same
 * revision must agree; giving a fixture's client half a different hash would make
 * every happy path look like an equal-revision surface mismatch. A test that wants
 * that mismatch overrides the hash explicitly.
 */
export function feedSurfaceHash(revision: number): string {
  return `fnv1a32:${digest(`surface-${revision}`, 8)}`;
}

function feedContract(revision: number, minimumClientRevision: number): ReleaseContractIdentity {
  return { revision, minimumClientRevision, surfaceHash: feedSurfaceHash(revision) };
}

/**
 * The bytes one release artifact serves, and therefore its true size and digest.
 *
 * Preparation downloads and authenticates pinned artifacts, so the feed has to be able to hand
 * over a body whose digest actually matches the signed manifest. A fixture that served anything
 * else would only ever exercise the mismatch path, which is the opposite of what this is for.
 */
function artifactBytes(seed: string, version: string): Buffer {
  return Buffer.from(`${seed}:${version}\n`.repeat(64));
}

function digestBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function feedArtifact(version: string, target: 'linux-x64' | 'linux-arm64' | 'darwin-arm64'): ReleaseArtifact {
  const [platform, arch] = target.split('-') as ['linux' | 'darwin', 'x64' | 'arm64'];
  const bytes = artifactBytes(`artifact-${target}`, version);
  return {
    name: `${PRODUCT_IDENTITY.releaseAssetPrefix}-${target}`,
    target,
    platform,
    arch,
    size: bytes.byteLength,
    sha256: digestBytes(bytes),
    url: `${FEED_BASE}/${version}/${target}/cosyncing`,
    provenanceUrl: `${FEED_BASE}/${version}/${target}/cosyncing.intoto.jsonl`,
  };
}

function feedJsApp(version: string): ReleaseJavaScriptApp {
  const bytes = artifactBytes('jsapp', version);
  return {
    name: RELEASE_JAVASCRIPT_APP_NAME,
    target: RELEASE_JAVASCRIPT_APP_TARGET,
    size: bytes.byteLength,
    sha256: digestBytes(bytes),
    url: `${FEED_BASE}/${version}/cosyncing-app.js`,
    provenanceUrl: `${FEED_BASE}/${version}/cosyncing-app.js.intoto.jsonl`,
    minimumBunVersion: '1.3.8',
  };
}

function feedWebSidecar(version: string): ReleaseWebSidecar {
  const bytes = artifactBytes('web', version);
  return {
    name: 'cosyncing-web-app.tar.gz',
    mount: '/cosy/',
    size: bytes.length,
    sha256: digestBytes(bytes),
    url: `${FEED_BASE}/${version}/cosyncing-web-app.tar.gz`,
    buildId: digest(`build-${version}`, 16),
    cacheManifestSha256: digest(`cache-${version}`),
    mainDartSha256: digest(`main-${version}`),
    directorySha256: digest(`dir-${version}`),
    fileCount: 12,
  };
}

function feedDesktop(version: string, hosts: FeedRelease['desktop']): ReleaseDesktopClients | undefined {
  if (!hosts || Object.keys(hosts).length === 0) return undefined;
  const rows: ReleaseDesktopClients = {};
  for (const host of Object.keys(hosts) as DesktopClientHost[]) {
    const name = desktopClientAssetName(host, version);
    rows[host] = { name, version, size: 65_536, sha256: digest(`desktop-${host}-${version}`), url: `${FEED_BASE}/${version}/${name}` };
  }
  return rows;
}

/** Sign one release the way the real assembly does: canonical payload, detached Ed25519. */
function signManifest(unsigned: Omit<ReleaseManifest, 'signature'>): ReleaseManifest {
  const value = Buffer.from(sign(null, releaseManifestSigningPayload(unsigned), FEED_PRIVATE_KEY)).toString('base64');
  return { ...unsigned, signature: { algorithm: 'ed25519', keyId: FEED_KEY_ID, value } };
}

function buildManifest(release: FeedRelease): ReleaseManifest {
  const unsigned: Omit<ReleaseManifest, 'signature'> = {
    schemaVersion: 1,
    product: PRODUCT_IDENTITY.productName,
    version: release.version,
    channel: 'stable',
    sourceCommit: release.sourceCommit,
    publishedAt: release.publishedAt,
    artifacts: [feedArtifact(release.version, 'linux-x64')],
    ...(release.contract ? { contract: release.contract } : {}),
    ...(release.jsApp === false ? {} : { webApp: feedWebSidecar(release.version), jsApp: feedJsApp(release.version) }),
    ...(feedDesktop(release.version, release.desktop) ? { desktopClients: feedDesktop(release.version, release.desktop) } : {}),
    ...(release.updater ? { updater: release.updater } : {}),
  };
  return signManifest(unsigned);
}

export interface FakeReleaseFeed {
  /** Releases in channel order, oldest first. */
  readonly releases: readonly ReleaseManifest[];
  /** The release the mutable pointer resolves to right now. */
  current(): ReleaseManifest;
  /** Move the mutable pointer to the next release. The last one sticks. */
  promote(): boolean;
  /** Resolve an immutable identity without touching the mutable pointer. */
  byReleaseId(releaseId: string): ReleaseManifest | undefined;
  readonly fetch: typeof fetch;
  readonly requests: { manifests: number; signatures: number; total: number };
  /** True when the last manifest/signature pair came from two different releases. */
  lastPairMixed(): boolean;
  verify(manifest: ReleaseManifest, signatureBytes: Uint8Array): boolean;
}

/**
 * A mutable-pointer feed over a fixed set of signed releases.
 *
 * `promoteAfterRequests` advances the pointer once that many manifest fetches have
 * landed, which is how a test makes the channel move underneath an operation that
 * is already in flight. Manifest and detached signature are two separate requests
 * with a real gap between them, exactly like the published channel.
 */
export function createFakeReleaseFeed(options: {
  releases: readonly FeedRelease[];
  promoteAfterRequests?: number;
}): FakeReleaseFeed {
  if (options.releases.length === 0) throw new Error('fake release feed needs at least one release');
  const built: readonly ReleaseManifest[] = options.releases.map(buildManifest);
  const releaseIds = options.releases.map((release) => releaseIdFor(release.version, release.sourceCommit));
  const at = (index: number): ReleaseManifest => {
    const release = built[index];
    if (!release) throw new Error(`fake release feed has no release at ${index}`);
    return release;
  };
  let pointer = 0;
  let manifests = 0;
  let signatures = 0;
  let lastManifestRelease = -1;
  let lastSignatureRelease = -1;
  // Every artifact URL the signed manifests publish, served from memory at its true digest.
  const artifactBodies = new Map<string, Buffer>();
  for (const release of built) {
    for (const artifact of release.artifacts) {
      artifactBodies.set(artifact.url, artifactBytes(`artifact-${artifact.target}`, release.version));
    }
    if (release.jsApp) artifactBodies.set(release.jsApp.url, artifactBytes('jsapp', release.version));
    if (release.webApp) artifactBodies.set(release.webApp.url, artifactBytes('web', release.version));
  }
  const requests = { get manifests() { return manifests; }, get signatures() { return signatures; }, get total() { return manifests + signatures; } };

  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url === FEED_MANIFEST_URL) {
      if (options.promoteAfterRequests !== undefined && manifests > 0 && manifests % options.promoteAfterRequests === 0) {
        pointer = Math.min(pointer + 1, built.length - 1);
      }
      manifests += 1;
      lastManifestRelease = pointer;
      const body = JSON.stringify(at(pointer));
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const body = artifactBodies.get(url);
    if (body) {
      return new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    }
    if (url === FEED_SIGNATURE_URL) {
      signatures += 1;
      lastSignatureRelease = pointer;
      const signature = at(pointer).signature.value;
      return new Response(Buffer.from(signature, 'base64'), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    }
    return new Response('not found', { status: 404 });
  };

  return {
    releases: built,
    current: () => at(pointer),
    promote: () => {
      if (pointer >= built.length - 1) return false;
      pointer += 1;
      return true;
    },
    byReleaseId: (releaseId) => {
      const index = releaseIds.indexOf(releaseId);
      return index < 0 ? undefined : at(index);
    },
    // Matches the existing fake-fetch seam: only the call signature is honoured.
    fetch: fetchImpl as unknown as typeof fetch,
    requests,
    lastPairMixed: () => lastManifestRelease !== lastSignatureRelease,
    // Same payload the readers sign: the unsigned manifest, canonical key order.
    verify: (manifest, signatureBytes) => {
      const { signature: _signature, ...unsigned } = manifest;
      return verifySignature(
        null,
        releaseManifestSigningPayload(unsigned),
        FEED_PUBLIC_KEY_PEM,
        Buffer.from(signatureBytes),
      );
    },
  };
}

/**
 * The immutable identity a plan pins.
 *
 * Derived from the commit rather than the version so a re-taggered version cannot
 * masquerade as the release a user reviewed, while staying readable in a log line.
 */
export function releaseIdFor(version: string, sourceCommit: string): string {
  return `rel-${version}+${sourceCommit.slice(0, 7)}`;
}

export const FEED_CONTRACT = feedContract;

/** Deterministic updater block with the defaults most tests do not care to repeat. */
export function feedUpdater(options: {
  version: string;
  sourceCommit: string;
  managementContractVersion?: number;
  minimumHelperVersion?: string;
  clientContract?: { revision: number; minimumBrokerRevision: number };
  desktop?: Partial<Record<DesktopClientHost, FeedUpdaterPlatform>>;
  safeDowngrade?: boolean;
}): ReleaseUpdaterMetadata {
  const desktop: ReleaseUpdaterMetadata['desktop'] = {};
  for (const host of Object.keys(options.desktop ?? {}) as DesktopClientHost[]) {
    const platform = options.desktop![host]!;
    desktop[host] = {
      ...(platform.minimumRuntimeVersion === undefined ? {} : { minimumRuntimeVersion: platform.minimumRuntimeVersion }),
      ...(platform.stagingBytes === undefined ? {} : { stagingBytes: platform.stagingBytes }),
      capabilities: platform.capabilities ?? ['prepare', 'client-replace', 'client-relaunch', 'broker-restart'],
    };
  }
  const clientContract = options.clientContract
    ? {
      revision: options.clientContract.revision,
      minimumBrokerRevision: options.clientContract.minimumBrokerRevision,
      surfaceHash: `fnv1a32:${digest(`client-surface-${options.clientContract.revision}`, 8)}`,
    }
    : undefined;
  return {
    schemaVersion: 1,
    releaseId: releaseIdFor(options.version, options.sourceCommit),
    managementContractVersion: options.managementContractVersion ?? 1,
    minimumHelperVersion: options.minimumHelperVersion ?? '1.0.0',
    ...(clientContract ? { clientContract } : {}),
    ...(Object.keys(desktop).length > 0 ? { desktop } : {}),
    ...(options.safeDowngrade === undefined ? {} : { safeDowngrade: options.safeDowngrade }),
  };
}
