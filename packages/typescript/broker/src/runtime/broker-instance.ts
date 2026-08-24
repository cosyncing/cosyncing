import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { setupStateHome } from '../installation/setup-state.ts';
import {
  atomicWriteJsonOwnerOnly,
  createOwnerOnlyFileExclusive,
  inspectOwnerOnlyFile,
  readOwnerOnlyText,
} from '../security/secure-files.ts';

interface LegacyBrokerInstanceFile {
  version: 1;
  instanceId: string;
  legacyArtifactBrokerSources?: string[];
}

export interface BrokerInstanceFile {
  /**
   * Version 2 is also the one-way authorization-migration rollback fence.
   * Revision-16 brokers accept only version 1 and fail startup on this file,
   * while their already-running updater does not inspect it during candidate
   * health verification. Persist v2 before touching any executable or
   * credential-bearing revision-16 store.
   */
  version: 2;
  instanceId: string;
  /** URL-derived artifact namespaces retained for the supported rollback window. */
  legacyArtifactBrokerSources?: string[];
}

const INSTANCE_FILE = 'broker-instance.json';
const INSTANCE_ID = /^broker_[A-Za-z0-9_-]{32,128}$/;
const MAX_LEGACY_ARTIFACT_SOURCES = 8;

export type BrokerInstanceInspection =
  | { status: 'missing'; path: string; detailCode: 'broker-instance-missing' }
  | { status: 'ok'; path: string; detailCode: 'broker-instance-ok'; state: BrokerInstanceFile }
  | {
      status: 'migration-required';
      path: string;
      detailCode: 'broker-instance-v1-authorization-fence-required';
      state: LegacyBrokerInstanceFile;
    }
  | { status: 'unsafe'; path: string; detailCode: 'broker-instance-unsafe' }
  | { status: 'malformed'; path: string; detailCode: 'broker-instance-malformed' };

function normalizeLegacyArtifactSource(raw: string): string {
  if (raw.length > 2_048) throw new Error('broker-instance-invalid');
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('broker-instance-invalid');
  }
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString();
}

function parseBrokerInstanceFile(path: string): BrokerInstanceFile | LegacyBrokerInstanceFile {
  const parsed = JSON.parse(readOwnerOnlyText(path)) as Partial<BrokerInstanceFile | LegacyBrokerInstanceFile>;
  if ((parsed.version !== 1 && parsed.version !== 2)
      || typeof parsed.instanceId !== 'string' || !INSTANCE_ID.test(parsed.instanceId)) {
    throw new Error('broker-instance-invalid');
  }
  if (parsed.legacyArtifactBrokerSources != null && !Array.isArray(parsed.legacyArtifactBrokerSources)) {
    throw new Error('broker-instance-invalid');
  }
  const sources = parsed.legacyArtifactBrokerSources ?? [];
  if (sources.length > MAX_LEGACY_ARTIFACT_SOURCES || sources.some((source) => typeof source !== 'string')) {
    throw new Error('broker-instance-invalid');
  }
  const normalized = [...new Set(sources.map(normalizeLegacyArtifactSource))];
  return {
    version: parsed.version,
    instanceId: parsed.instanceId,
    ...(normalized.length > 0 ? { legacyArtifactBrokerSources: normalized } : {}),
  };
}

/** Read-only validation used by doctor, setup, and release preflight. */
export function inspectBrokerInstance(home = setupStateHome()): BrokerInstanceInspection {
  const path = join(home, INSTANCE_FILE);
  const inspected = inspectOwnerOnlyFile(path);
  if (inspected.status === 'missing') return { status: 'missing', path, detailCode: 'broker-instance-missing' };
  if (inspected.status !== 'ok') return { status: 'unsafe', path, detailCode: 'broker-instance-unsafe' };
  try {
    const state = parseBrokerInstanceFile(path);
    return state.version === 1
      ? {
          status: 'migration-required',
          path,
          detailCode: 'broker-instance-v1-authorization-fence-required',
          state,
        }
      : { status: 'ok', path, detailCode: 'broker-instance-ok', state };
  } catch {
    return { status: 'malformed', path, detailCode: 'broker-instance-malformed' };
  }
}

export function loadOrCreateBrokerInstance(
  home = setupStateHome(),
  options: {
    /** Fault-injection seam for the one-way v1-to-v2 fence write. */
    beforeMigrationPersist?: () => void;
  } = {},
): BrokerInstanceFile {
  let contended = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    const inspected = inspectBrokerInstance(home);
    if (inspected.status === 'ok') return inspected.state;
    if (inspected.status === 'migration-required') {
      const migrated: BrokerInstanceFile = { ...inspected.state, version: 2 };
      options.beforeMigrationPersist?.();
      atomicWriteJsonOwnerOnly(inspected.path, migrated);
      return migrated;
    }
    if (inspected.status === 'unsafe') throw new Error('broker-instance-unsafe');
    if (inspected.status === 'malformed' && !contended) throw new Error('broker-instance-invalid');
    if (inspected.status === 'missing') {
      const state: BrokerInstanceFile = {
        version: 2,
        instanceId: `broker_${randomBytes(32).toString('base64url')}`,
      };
      const outcome = createOwnerOnlyFileExclusive(
        inspected.path,
        `${JSON.stringify(state, null, 2)}\n`,
      );
      if (outcome === 'created') return state;
      contended = true;
    }
    // O_EXCL exposes the winning inode before its write completes. Wait briefly only after proven
    // contention; an already-malformed file still fails immediately above.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  throw new Error('broker-instance-create-timeout');
}

/** True only after the durable one-way fence that revision-16 startup rejects. */
export function authorizationMigrationRollbackFenceActive(home = setupStateHome()): boolean {
  return inspectBrokerInstance(home).status === 'ok';
}

/** Durable installation identity, independent of URL, port, DNS, or proxy. */
export function loadOrCreateBrokerInstanceId(home = setupStateHome()): string {
  return loadOrCreateBrokerInstance(home).instanceId;
}

/** Preserve legacy URL namespaces before config v1 removes their only durable evidence. */
export function recordLegacyArtifactBrokerSources(
  sources: readonly (string | undefined)[],
  home = setupStateHome(),
): BrokerInstanceFile {
  const state = loadOrCreateBrokerInstance(home);
  const additions = sources.filter((source): source is string => !!source).map(normalizeLegacyArtifactSource);
  const retained = [...new Set([...(state.legacyArtifactBrokerSources ?? []), ...additions])];
  if (retained.length > MAX_LEGACY_ARTIFACT_SOURCES) throw new Error('broker-instance-too-many-legacy-sources');
  if (retained.length === (state.legacyArtifactBrokerSources ?? []).length) return state;
  const updated: BrokerInstanceFile = { ...state, legacyArtifactBrokerSources: retained };
  atomicWriteJsonOwnerOnly(join(home, INSTANCE_FILE), updated);
  return updated;
}
