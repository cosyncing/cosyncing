/**
 * The optional, versioned updater block inside the signed release manifest.
 *
 * It exists because the update engine needs three facts a product semver cannot
 * carry: which update-management contract this release's broker serves, which
 * helper version may execute its desktop handoff, and which session contract the
 * client builds of this release speak. All three evolve independently of the
 * product version, and none of them may be guessed from an OS name.
 *
 * The block is additive and its absence is meaningful. `parseManifest` ignores
 * keys it does not know and `canonicalJson` signs every key it does, so an old
 * reader verifies a manifest carrying this block exactly as it verifies one
 * without it, and a new reader must treat an absent block as "this release makes
 * no internal-update promise" rather than as a zero-capability default. That is
 * why `schemaVersion` here is NOT the manifest `schemaVersion`: bumping the
 * manifest number would strand every reader already deployed.
 */
import { DESKTOP_CLIENT_HOSTS, type DesktopClientHost } from './desktop-client-types.ts';

export const RELEASE_UPDATER_SCHEMA_VERSION = 1 as const;

/** Capabilities a desktop handoff may advertise. Add one only with physical acceptance. */
export const UPDATER_CAPABILITIES = [
  'prepare',
  'client-replace',
  'client-relaunch',
  'broker-restart',
] as const;
export type UpdaterCapability = (typeof UPDATER_CAPABILITIES)[number];

/** Per-host facts about installing this release's desktop client on that host. */
export interface ReleaseUpdaterPlatform {
  /** Runtime the packaged build needs, e.g. the Bun floor for a JavaScript engine. */
  minimumRuntimeVersion?: string;
  minimumOsVersion?: string;
  /** Free bytes the host needs for staging plus the previous copy. */
  stagingBytes?: number;
  /** Proven handoff abilities. Absent means nothing may be claimed. */
  capabilities: readonly UpdaterCapability[];
}

/**
 * Contract identity of the client builds a release publishes.
 *
 * `minimumBrokerRevision` is the whole reason this exists: without it the
 * planner can evaluate the current pair but not the pair the operation ENDS on,
 * which is the only pair that can strand a user.
 */
export interface ReleaseUpdaterClientContract {
  revision: number;
  minimumBrokerRevision: number;
  surfaceHash?: string;
}

/**
 * A block written by a newer release process than this build understands.
 *
 * Kept as data rather than turned into a throw, because a reader that cannot read
 * the updater block must still be able to verify and install the broker half of the
 * manifest exactly as it did before the block existed. Refusing the in-app plan is
 * the planner's call; refusing the release would be a self-inflicted outage and
 * would teach the next schema bump to be smuggled in behind a version bump.
 */
export interface UnsupportedReleaseUpdater {
  schemaVersion: number;
  unsupported: true;
}

export type ReleaseUpdaterBlock = ReleaseUpdaterMetadata | UnsupportedReleaseUpdater;

/**
 * Whether this build can read the block.
 *
 * Both the marker and the number are checked so a block that merely carries a
 * higher schema version -- reconstructed from a journal, or built by a caller that
 * never ran the parser -- is still treated as unreadable rather than trusted.
 */
export function isSupportedReleaseUpdater(block: ReleaseUpdaterBlock): block is ReleaseUpdaterMetadata {
  return !('unsupported' in block && block.unsupported)
    && block.schemaVersion <= RELEASE_UPDATER_SCHEMA_VERSION;
}

export interface ReleaseUpdaterMetadata {
  schemaVersion: typeof RELEASE_UPDATER_SCHEMA_VERSION;
  /** Immutable release identity. Never a mutable `latest` pointer or a tag alias. */
  releaseId: string;
  /** Update-management contract version this release's broker serves. */
  managementContractVersion: number;
  /** Oldest trusted helper that may run this release's desktop handoff. */
  minimumHelperVersion: string;
  clientContract?: ReleaseUpdaterClientContract;
  /** Absent host: this release advertises no internal desktop update for it. */
  desktop?: Partial<Record<DesktopClientHost, ReleaseUpdaterPlatform>>;
  /**
   * Whether the previous build may run against this release's durable state.
   *
   * Absent is false-by-consequence rather than false-by-declaration: a release
   * that says nothing has not earned a rollback, so the engine keeps its
   * existing migration and authorization fences instead of assuming one.
   */
  safeDowngrade?: boolean;
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validReleaseId(value: unknown): value is string {
  // A release identity has to survive being written into a journal and read back
  // years later, so it is bounded and printable rather than arbitrarily shaped.
  return typeof value === 'string' && value.length >= 1 && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._:+@/-]*$/.test(value);
}

function validPlatform(value: unknown): value is ReleaseUpdaterPlatform {
  if (!plainObject(value) || !Array.isArray(value.capabilities)) return false;
  if (!value.capabilities.every((item) => (UPDATER_CAPABILITIES as readonly string[]).includes(item as string))) {
    return false;
  }
  for (const key of ['minimumRuntimeVersion', 'minimumOsVersion'] as const) {
    const entry = value[key];
    if (entry !== undefined && (typeof entry !== 'string' || !VERSION_PATTERN.test(entry))) return false;
  }
  if (value.stagingBytes !== undefined
      && (!Number.isSafeInteger(value.stagingBytes)
        || (value.stagingBytes as number) <= 0
        || (value.stagingBytes as number) > 512 * 1024 * 1024)) {
    return false;
  }
  return true;
}

function validClientContract(value: unknown): value is ReleaseUpdaterClientContract {
  if (!plainObject(value)) return false;
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0
      || !Number.isSafeInteger(value.minimumBrokerRevision) || (value.minimumBrokerRevision as number) < 0
      || (value.minimumBrokerRevision as number) > (value.revision as number)) {
    return false;
  }
  return value.surfaceHash === undefined
    || (typeof value.surfaceHash === 'string' && /^fnv1a32:[a-f0-9]{8}$/.test(value.surfaceHash));
}

/**
 * Validate the optional block. Throws only on a malformed block that is present.
 *
 * A present-but-invalid block must NOT degrade to "no updater metadata": that
 * would let a corrupt or truncated feed silently look like a legacy release and
 * drop a capable installation back to manual guidance while the user is mid-flow.
 */
export function parseReleaseUpdaterMetadata(value: unknown): ReleaseUpdaterBlock {
  if (!plainObject(value) || !Number.isSafeInteger(value.schemaVersion)
      || (value.schemaVersion as number) < 1) {
    throw new Error('release-updater-metadata-invalid');
  }
  if ((value.schemaVersion as number) > RELEASE_UPDATER_SCHEMA_VERSION) {
    return { schemaVersion: value.schemaVersion as number, unsupported: true };
  }
  if (!validReleaseId(value.releaseId)
      || !Number.isSafeInteger(value.managementContractVersion)
      || (value.managementContractVersion as number) < 1
      || typeof value.minimumHelperVersion !== 'string'
      || !VERSION_PATTERN.test(value.minimumHelperVersion)
      || (value.clientContract !== undefined && !validClientContract(value.clientContract))
      || (value.safeDowngrade !== undefined && typeof value.safeDowngrade !== 'boolean')) {
    throw new Error('release-updater-metadata-invalid');
  }
  let desktop: ReleaseUpdaterMetadata['desktop'];
  if (value.desktop !== undefined) {
    if (!plainObject(value.desktop)) throw new Error('release-updater-metadata-invalid');
    desktop = {};
    for (const [host, platform] of Object.entries(value.desktop)) {
      if (!(DESKTOP_CLIENT_HOSTS as readonly string[]).includes(host) || !validPlatform(platform)) {
        throw new Error('release-updater-metadata-invalid');
      }
      // Rebuilt field by field rather than passed through: whoever serves the feed
      // does not get to add a key this build has not decided to honour, and a later
      // reader must not act on a field that validation never looked at.
      const entry = platform;
      desktop[host as DesktopClientHost] = {
        ...(typeof entry.minimumRuntimeVersion === 'string' ? { minimumRuntimeVersion: entry.minimumRuntimeVersion } : {}),
        ...(typeof entry.minimumOsVersion === 'string' ? { minimumOsVersion: entry.minimumOsVersion } : {}),
        ...(entry.stagingBytes === undefined ? {} : { stagingBytes: entry.stagingBytes as number }),
        capabilities: [...(entry.capabilities as readonly UpdaterCapability[])],
      };
    }
  }
  const clientContract = value.clientContract as ReleaseUpdaterClientContract | undefined;
  return {
    schemaVersion: RELEASE_UPDATER_SCHEMA_VERSION,
    releaseId: value.releaseId,
    managementContractVersion: value.managementContractVersion as number,
    minimumHelperVersion: value.minimumHelperVersion as string,
    ...(clientContract === undefined
      ? {}
      : {
        clientContract: {
          revision: clientContract.revision,
          minimumBrokerRevision: clientContract.minimumBrokerRevision,
          ...(clientContract.surfaceHash === undefined ? {} : { surfaceHash: clientContract.surfaceHash }),
        },
      }),
    ...(desktop ? { desktop } : {}),
    ...((value.safeDowngrade === undefined) ? {} : { safeDowngrade: value.safeDowngrade as boolean }),
  };
}

/** Whether the block is present. Kept separate from validation so absence stays a first-class answer. */
export function hasReleaseUpdaterMetadata(manifest: { updater?: unknown }): boolean {
  return manifest.updater !== undefined;
}

/**
 * Numeric semver ordering, exported so the engine has one answer.
 *
 * Pre-release sorts below its release, matching the existing upgrade comparison;
 * two orders of the same core are equal, which is why callers pin a `releaseId`
 * rather than trusting a version string to distinguish rebuilds.
 */
export function compareReleaseVersions(left: string, right: string): number {
  const parse = (value: string): { core: number[]; prerelease?: string[] } => {
    const [core, prerelease] = value.split('-', 2);
    return { core: core!.split('.').map(Number), ...(prerelease ? { prerelease: prerelease.split('.') } : {}) };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}

/** Whether `actual` meets a stated floor. An unreadable `actual` never meets one. */
export function satisfiesMinimum(actual: string | undefined, minimum: string | undefined): boolean {
  if (minimum === undefined) return true;
  if (actual === undefined || !VERSION_PATTERN.test(actual)) return false;
  return compareReleaseVersions(actual, minimum) >= 0;
}
