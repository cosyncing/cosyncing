import packageJson from '../../../../package.json';
import contractRevisions from '../../../../contracts/contract-revisions.json';
import { isDistributionKind, type DistributionKind } from './application-identity.ts';

declare const COSYNCING_BUILD_VERSION: string | undefined;
declare const COSYNCING_BUILD_COMMIT: string | undefined;
declare const COSYNCING_BUILD_DATE: string | undefined;
declare const COSYNCING_BUILD_TARGET: string | undefined;
declare const COSYNCING_BUILD_DISTRIBUTION: string | undefined;
declare const COSYNCING_BUILD_DIRTY: boolean | undefined;
declare const COSYNCING_BUILD_SCHEMA_VERSIONS: string | undefined;
declare const COSYNCING_BUILD_CONTRACT: string | undefined;

/**
 * 2 replaced the single `packaged` boolean with an explicit `distribution` kind.
 *
 * The wire contract is untouched: nothing in the broker/client protocol carries BuildInfo, so the protocol
 * revision does not move. What DOES read this number is the release manifest's provenance and `version
 * --json`, and both gain the new field. A v1 reader sees `packaged` exactly where it was — it is still
 * emitted, now derived — so old consumers keep working while new ones can tell a JavaScript distribution
 * from a compiled one, which `packaged` alone never could.
 */
export const BUILD_INFO_SCHEMA_VERSION = 2 as const;

/** Public compatibility versions stamped into every packaged binary and release provenance. */
export const PUBLISHED_SCHEMA_VERSIONS = Object.freeze({
  buildInfo: BUILD_INFO_SCHEMA_VERSION,
  brokerConfig: 1,
  setupState: 1,
  installState: 1,
  durableStores: Object.freeze({
    config: 1,
    setup: 1,
    install: 1,
    schedules: 1,
    attention: 1,
    peers: 1,
    artifacts: 1,
  }),
  releaseManifest: 1,
  upgradeJournal: 1,
  // Kept equal to core's BROKER_CONTRACT_REVISION by BPC10/BPC13 acceptance. Importing the large
  // runtime contract here would make a read-only CLI import create Bun's transpilation cache.
  brokerContract: 10,
} as const);

export type PublishedSchemaVersions = typeof PUBLISHED_SCHEMA_VERSIONS;

export interface PublishedBrokerContract {
  revision: number;
  minimumClientRevision: number;
  surfaceHash: string;
}

const latestContractRevision = contractRevisions.revisions.at(-1);
if (!latestContractRevision) {
  throw new Error('contract revision registry is empty');
}

/** Small immutable contract identity embedded in every source or packaged CLI. */
export const PUBLISHED_BROKER_CONTRACT: Readonly<PublishedBrokerContract> =
  Object.freeze({
    revision: latestContractRevision.revision,
    minimumClientRevision: latestContractRevision.minimumClientRevision,
    surfaceHash: latestContractRevision.surfaceHash,
  });

export interface BuildInfo {
  schemaVersion: typeof BUILD_INFO_SCHEMA_VERSION;
  version: string;
  commit: string;
  buildDate: string | null;
  /**
   * The ARTIFACT's host target, not the host it happens to be running on.
   *
   * A `bun-js` bundle is one universal JavaScript file, so its target is `universal`: stamping the packaging
   * host's `linux-x64` would claim a machine-code binding the artifact does not have, and would also make it
   * name a signed native release artifact it must never install. Runtime host information belongs to doctor
   * and `/api/health`, which report it separately.
   */
  target: string;
  /** How the artifact was produced and what may execute it. See {@link DistributionKind}. */
  distribution: DistributionKind;
  /** Derived from `distribution`: every distribution except a contributor checkout is an installable product. */
  packaged: boolean;
  dirty: boolean | null;
  schemaVersions: PublishedSchemaVersions;
  contract: PublishedBrokerContract;
}

function definedString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

const sourceTarget = `${process.platform}-${process.arch}`;

function definedSchemaVersions(value: unknown): PublishedSchemaVersions {
  if (typeof value !== 'string' || !value.trim()) return PUBLISHED_SCHEMA_VERSIONS;
  try {
    const parsed = JSON.parse(value);
    return JSON.stringify(parsed) === JSON.stringify(PUBLISHED_SCHEMA_VERSIONS)
      ? parsed as PublishedSchemaVersions
      : PUBLISHED_SCHEMA_VERSIONS;
  } catch {
    return PUBLISHED_SCHEMA_VERSIONS;
  }
}

function definedContract(value: unknown): PublishedBrokerContract {
  if (typeof value !== 'string' || !value.trim()) {
    return PUBLISHED_BROKER_CONTRACT;
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || !Number.isSafeInteger(parsed.revision)
        || !Number.isSafeInteger(parsed.minimumClientRevision)
        || typeof parsed.surfaceHash !== 'string'
        || !/^fnv1a32:[a-f0-9]{8}$/.test(parsed.surfaceHash)) {
      return PUBLISHED_BROKER_CONTRACT;
    }
    return parsed as PublishedBrokerContract;
  } catch {
    return PUBLISHED_BROKER_CONTRACT;
  }
}

/**
 * Every immutable term that distinguishes one built ARTIFACT from another, in one legible string.
 *
 * The semver cannot identify a build (a whole release cycle shares one) and neither can the commit: two
 * binaries built from the same tree differ when one was built from a dirty checkout, for a different target,
 * packaged versus source, or simply at a different time. Anything that wants to prove "the process answering
 * me is the artifact I just installed" has to compare all of it.
 *
 * This is the SINGLE definition. `/api/health` reports exactly this string and setup's post-commit check
 * recomputes exactly this string for the build it installed, so the surface and the check cannot drift apart
 * into two hand-maintained field lists. It is deliberately legible rather than a hash: the failure it feeds
 * has to tell an operator WHICH term differs.
 */
export function buildFingerprint(info: Readonly<Omit<BuildInfo, 'schemaVersions' | 'contract'>>): string {
  return [
    info.version,
    info.commit,
    info.buildDate ?? 'no-build-date',
    info.dirty === null ? 'dirty-unknown' : info.dirty ? 'dirty' : 'clean',
    info.target,
    // The distribution kind, not the `packaged` boolean it replaced: a JavaScript bundle and a compiled
    // executable built from one commit at one instant are different artifacts with different failure modes,
    // and a fingerprint that could not tell them apart would let one answer the health check for the other.
    info.distribution,
  ].join('/');
}

/**
 * The stamped distribution kind, defaulting to the safest possible answer.
 *
 * An absent or unrecognized define means the artifact cannot prove what it is, and the honest reading of
 * "unknown" is a source checkout: it refuses durable service installation and cannot self-replace. Only the
 * exact string `native` opens the signed machine-code swap path, so no corruption of this value can steer a
 * JavaScript install into it.
 */
const stampedDistribution: DistributionKind = (() => {
  const value = typeof COSYNCING_BUILD_DISTRIBUTION === 'undefined' ? undefined : COSYNCING_BUILD_DISTRIBUTION;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return isDistributionKind(trimmed) ? trimmed : 'source';
})();

/** Build metadata is replaced with immutable values by scripts/broker/build-broker.ts. */
export const BUILD_INFO: Readonly<BuildInfo> = Object.freeze({
  schemaVersion: BUILD_INFO_SCHEMA_VERSION,
  version: definedString(
    typeof COSYNCING_BUILD_VERSION === 'undefined' ? undefined : COSYNCING_BUILD_VERSION,
    packageJson.version,
  ),
  commit: definedString(
    typeof COSYNCING_BUILD_COMMIT === 'undefined' ? undefined : COSYNCING_BUILD_COMMIT,
    'development',
  ),
  buildDate: (() => {
    const value = typeof COSYNCING_BUILD_DATE === 'undefined' ? undefined : COSYNCING_BUILD_DATE;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  })(),
  target: definedString(
    typeof COSYNCING_BUILD_TARGET === 'undefined' ? undefined : COSYNCING_BUILD_TARGET,
    sourceTarget,
  ),
  distribution: stampedDistribution,
  packaged: stampedDistribution !== 'source',
  dirty: typeof COSYNCING_BUILD_DIRTY === 'undefined' ? null : COSYNCING_BUILD_DIRTY,
  schemaVersions: definedSchemaVersions(
    typeof COSYNCING_BUILD_SCHEMA_VERSIONS === 'undefined' ? undefined : COSYNCING_BUILD_SCHEMA_VERSIONS,
  ),
  contract: definedContract(
    typeof COSYNCING_BUILD_CONTRACT === 'undefined' ? undefined : COSYNCING_BUILD_CONTRACT,
  ),
});
