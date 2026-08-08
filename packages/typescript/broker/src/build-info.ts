import packageJson from '../../../../package.json';
import contractRevisions from '../../../../contracts/contract-revisions.json';

declare const COSYNCING_BUILD_VERSION: string | undefined;
declare const COSYNCING_BUILD_COMMIT: string | undefined;
declare const COSYNCING_BUILD_DATE: string | undefined;
declare const COSYNCING_BUILD_TARGET: string | undefined;
declare const COSYNCING_BUILD_PACKAGED: boolean | undefined;
declare const COSYNCING_BUILD_DIRTY: boolean | undefined;
declare const COSYNCING_BUILD_SCHEMA_VERSIONS: string | undefined;
declare const COSYNCING_BUILD_CONTRACT: string | undefined;

export const BUILD_INFO_SCHEMA_VERSION = 1 as const;

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
  target: string;
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
    info.packaged ? 'packaged' : 'source',
  ].join('/');
}

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
  packaged: typeof COSYNCING_BUILD_PACKAGED === 'undefined' ? false : COSYNCING_BUILD_PACKAGED,
  dirty: typeof COSYNCING_BUILD_DIRTY === 'undefined' ? null : COSYNCING_BUILD_DIRTY,
  schemaVersions: definedSchemaVersions(
    typeof COSYNCING_BUILD_SCHEMA_VERSIONS === 'undefined' ? undefined : COSYNCING_BUILD_SCHEMA_VERSIONS,
  ),
  contract: definedContract(
    typeof COSYNCING_BUILD_CONTRACT === 'undefined' ? undefined : COSYNCING_BUILD_CONTRACT,
  ),
});
