import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { setupStateHome } from '../installation/setup-state.ts';
import {
  atomicWriteJsonOwnerOnly,
  inspectOwnerOnlyFile,
  readOwnerOnlyText,
} from '../security/secure-files.ts';

export interface BrokerInstanceFile {
  version: 1;
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

function parseBrokerInstanceFile(path: string): BrokerInstanceFile {
  const parsed = JSON.parse(readOwnerOnlyText(path)) as Partial<BrokerInstanceFile>;
  if (parsed.version !== 1 || typeof parsed.instanceId !== 'string' || !INSTANCE_ID.test(parsed.instanceId)) {
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
    version: 1,
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
    return { status: 'ok', path, detailCode: 'broker-instance-ok', state: parseBrokerInstanceFile(path) };
  } catch {
    return { status: 'malformed', path, detailCode: 'broker-instance-malformed' };
  }
}

export function loadOrCreateBrokerInstance(home = setupStateHome()): BrokerInstanceFile {
  const inspected = inspectBrokerInstance(home);
  if (inspected.status === 'ok') return inspected.state;
  if (inspected.status !== 'missing') {
    throw new Error(inspected.status === 'malformed' ? 'broker-instance-invalid' : 'broker-instance-unsafe');
  }
  const state: BrokerInstanceFile = {
    version: 1,
    instanceId: `broker_${randomBytes(32).toString('base64url')}`,
  };
  atomicWriteJsonOwnerOnly(inspected.path, state);
  return state;
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
