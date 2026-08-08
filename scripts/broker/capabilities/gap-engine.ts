import type {
  AdapterSupportManifest,
  CapabilityRecord,
  CapabilitySourceLock,
  DiscoveredCapabilitiesFile,
  GapRecord,
  GapReport,
  ProductPolicyFile,
} from './types.ts';
import { APP_SURFACES, CAPABILITY_SCHEMA_VERSION, MAPPED_STATUSES, NATIVE_KINDS, PRODUCT_STATUSES, RISK_CLASSES, RISK_LEVELS } from './types.ts';
import { EVIDENCE_LEVELS, TAXONOMY_FUNCTIONS } from '../tests_traces/trace-manifest.ts';
import { AGENTS } from '../tests_traces/scenarios.ts';
import { sourceIds } from './source-lock.ts';

function ensure(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function has<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function validateStringArray(value: unknown, label: string): string[] {
  ensure(Array.isArray(value), `${label} must be an array`);
  const strings = value as unknown[];
  for (const item of strings) ensure(typeof item === 'string' && item.length > 0, `${label} contains invalid string`);
  return strings as string[];
}

function validateCapability(cap: CapabilityRecord, sourceSet: Set<string>, expectedAgent: string, expectedVersion: string): void {
  ensure(cap.schemaVersion === CAPABILITY_SCHEMA_VERSION, `invalid schemaVersion for ${cap.id}`);
  ensure(typeof cap.id === 'string' && cap.id.length > 0, 'capability id is required');
  ensure(typeof cap.nativeId === 'string' && cap.nativeId.length > 0, `${cap.id} nativeId is required`);
  ensure(cap.agent === expectedAgent, `${cap.id} has wrong agent ${cap.agent}`);
  ensure(cap.version === expectedVersion, `${cap.id} has wrong version ${cap.version}`);
  ensure(has(NATIVE_KINDS, cap.nativeKind), `${cap.id} has invalid nativeKind ${String(cap.nativeKind)}`);
  ensure(has(PRODUCT_STATUSES, cap.productStatus), `${cap.id} has invalid productStatus ${String(cap.productStatus)}`);
  ensure(has(MAPPED_STATUSES, cap.mappedStatus), `${cap.id} has invalid mappedStatus ${String(cap.mappedStatus)}`);
  ensure(has(RISK_LEVELS, cap.risk), `${cap.id} has invalid risk ${String(cap.risk)}`);
  ensure(has(RISK_CLASSES, cap.riskClass), `${cap.id} has invalid riskClass ${String(cap.riskClass)}`);
  ensure(typeof cap.reviewRequired === 'boolean', `${cap.id} reviewRequired must be boolean`);
  if (cap.appSurface !== undefined) ensure(has(APP_SURFACES, cap.appSurface), `${cap.id} has invalid appSurface ${String(cap.appSurface)}`);
  for (const fn of validateStringArray(cap.functions, `${cap.id} functions`)) {
    ensure((TAXONOMY_FUNCTIONS as readonly string[]).includes(fn), `${cap.id} has invalid function ${fn}`);
  }
  for (const level of validateStringArray(cap.evidenceRequired, `${cap.id} evidenceRequired`)) {
    ensure((EVIDENCE_LEVELS as readonly string[]).includes(level), `${cap.id} has invalid evidenceRequired ${level}`);
  }
  for (const level of validateStringArray(cap.evidencePresent, `${cap.id} evidencePresent`)) {
    ensure((EVIDENCE_LEVELS as readonly string[]).includes(level), `${cap.id} has invalid evidencePresent ${level}`);
  }
  for (const ref of validateStringArray(cap.sourceRefs, `${cap.id} sourceRefs`)) {
    ensure(sourceSet.has(ref), `${cap.id} references unknown source ${ref}`);
  }
}

function missingEvidence(required: readonly string[], present: readonly string[]): string[] {
  const got = new Set(present);
  return required.filter((level) => !got.has(level));
}

export function validateInputs(
  discovered: DiscoveredCapabilitiesFile,
  sourceLock: CapabilitySourceLock,
  manifest: AdapterSupportManifest,
  policy: ProductPolicyFile,
): void {
  ensure(discovered.schemaVersion === CAPABILITY_SCHEMA_VERSION, 'discovered file schemaVersion must be 1');
  ensure(sourceLock.schemaVersion === CAPABILITY_SCHEMA_VERSION, 'source lock schemaVersion must be 1');
  ensure(manifest.schemaVersion === CAPABILITY_SCHEMA_VERSION, 'adapter manifest schemaVersion must be 1');
  ensure(policy.schemaVersion === CAPABILITY_SCHEMA_VERSION, 'product policy schemaVersion must be 1');
  ensure((AGENTS as readonly string[]).includes(discovered.agent), `unknown agent ${discovered.agent}`);
  ensure(sourceLock.agent === discovered.agent, 'source lock agent mismatch');
  ensure(sourceLock.version === discovered.version, 'source lock version mismatch');
  ensure(manifest.agent === discovered.agent, 'adapter manifest agent mismatch');
  ensure(manifest.version === discovered.version, 'adapter manifest version mismatch');
  ensure(Array.isArray(sourceLock.sources) && sourceLock.sources.length > 0, 'source lock must contain sources');

  const seenSources = new Set<string>();
  for (const source of sourceLock.sources) {
    ensure(typeof source.id === 'string' && source.id.length > 0, 'source id is required');
    ensure(!seenSources.has(source.id), `duplicate source id: ${source.id}`);
    seenSources.add(source.id);
    ensure(typeof source.checksum === 'string' && /^[a-f0-9]{64}$/i.test(source.checksum), `source ${source.id} has malformed checksum`);
    ensure(typeof source.trust_level === 'string' && source.trust_level.length > 0, `source ${source.id} trust_level is required`);
  }

  const sourceSet = sourceIds(sourceLock);
  const seenCapabilities = new Set<string>();
  const seenNative = new Set<string>();
  const manifestBackedStatuses = new Set<string>();
  for (const cap of discovered.capabilities) {
    if (seenCapabilities.has(cap.id)) throw new Error(`duplicate capability id: ${cap.id}`);
    seenCapabilities.add(cap.id);
    if (seenNative.has(cap.nativeId)) throw new Error(`duplicate native id: ${cap.nativeId}`);
    seenNative.add(cap.nativeId);
    validateCapability(cap, sourceSet, discovered.agent, discovered.version);
    if (cap.mappedStatus === 'mapped' || cap.mappedStatus === 'partial' || cap.mappedStatus === 'not-applicable') manifestBackedStatuses.add(cap.id);
  }

  const seenSupport = new Set<string>();
  for (const support of manifest.capabilities) {
    ensure(support.schemaVersion === CAPABILITY_SCHEMA_VERSION, `support ${support.id} schemaVersion must be 1`);
    ensure(!seenSupport.has(support.id), `duplicate adapter support id: ${support.id}`);
    seenSupport.add(support.id);
    ensure(seenCapabilities.has(support.id), `adapter support references unknown capability ${support.id}`);
    ensure(['mapped', 'partial', 'excluded', 'not-applicable'].includes(support.mappedStatus), `support ${support.id} has invalid mappedStatus`);
    ensure(support.agent === discovered.agent, `support ${support.id} has wrong agent ${support.agent}`);
    ensure(support.version === discovered.version, `support ${support.id} has wrong version ${support.version}`);
    if (support.mappedStatus === 'not-applicable') {
      ensure(typeof support.deliberateExclusionReason === 'string' && support.deliberateExclusionReason.length > 0, `${support.id} not-applicable support must include a reason`);
    }
    for (const level of support.evidencePresent ?? []) {
      ensure((EVIDENCE_LEVELS as readonly string[]).includes(level), `support ${support.id} has invalid evidence ${level}`);
    }
  }
  for (const id of manifestBackedStatuses) {
    const cap = discovered.capabilities.find((c) => c.id === id);
    const status = cap?.mappedStatus ?? 'mapped';
    ensure(seenSupport.has(id), `${id} claims ${status} but has no adapter manifest entry`);
  }

  const seenPolicy = new Set<string>();
  for (const entry of policy.policies) {
    ensure(entry.schemaVersion === CAPABILITY_SCHEMA_VERSION, `policy ${entry.id} schemaVersion must be 1`);
    ensure(!seenPolicy.has(entry.id), `duplicate policy id: ${entry.id}`);
    seenPolicy.add(entry.id);
    ensure(seenCapabilities.has(entry.id), `policy references unknown capability ${entry.id}`);
    ensure(has(PRODUCT_STATUSES, entry.decision), `policy ${entry.id} has invalid decision ${String(entry.decision)}`);
    ensure(has(RISK_LEVELS, entry.risk), `policy ${entry.id} has invalid risk ${String(entry.risk)}`);
    ensure(has(RISK_CLASSES, entry.riskClass), `policy ${entry.id} has invalid riskClass ${String(entry.riskClass)}`);
    ensure(typeof entry.reason === 'string' && entry.reason.length > 0, `policy ${entry.id} reason is required`);
  }
  for (const support of manifest.capabilities) {
    if (support.mappedStatus === 'excluded') ensure(seenPolicy.has(support.id), `${support.id} exclusion must be policy-backed`);
  }
}

function toGap(cap: CapabilityRecord, reason: GapRecord['reason'], override?: Partial<GapRecord>): GapRecord {
  return {
    id: cap.id,
    capabilityId: cap.id,
    nativeId: cap.nativeId,
    agent: cap.agent,
    version: cap.version,
    functions: [...cap.functions],
    productStatus: cap.productStatus,
    mappedStatus: cap.mappedStatus,
    evidenceRequired: [...cap.evidenceRequired],
    evidencePresent: [...cap.evidencePresent],
    risk: cap.risk,
    riskClass: cap.riskClass,
    reviewRequired: cap.reviewRequired,
    reason,
    ...(cap.title ? { title: cap.title } : {}),
    ...(cap.summary ? { summary: cap.summary } : {}),
    ...(cap.deliberateExclusionReason ? { deliberateExclusionReason: cap.deliberateExclusionReason } : {}),
    ...override,
  };
}

export function buildGapReport(
  discovered: DiscoveredCapabilitiesFile,
  sourceLock: CapabilitySourceLock,
  manifest: AdapterSupportManifest,
  policy: ProductPolicyFile,
  mode: 'fixture' | 'live',
  sourceLockPath: string,
): GapReport {
  validateInputs(discovered, sourceLock, manifest, policy);
  const supportById = new Map(manifest.capabilities.map((entry) => [entry.id, entry]));
  const policyById = new Map(policy.policies.map((entry) => [entry.id, entry]));
  const openGaps: GapRecord[] = [];
  const blocked: GapRecord[] = [];

  for (const cap of discovered.capabilities) {
    const reviewed = policyById.get(cap.id);
    const supported = supportById.get(cap.id);
    if (reviewed && (reviewed.decision === 'unsafe' || reviewed.decision === 'not-productized')) {
      blocked.push(toGap(cap, 'reviewed-exclusion', {
        productStatus: reviewed.decision,
        risk: reviewed.risk,
        riskClass: reviewed.riskClass,
        reviewRequired: reviewed.reviewRequired,
        mappedStatus: 'excluded',
        deliberateExclusionReason: reviewed.reason,
      }));
      continue;
    }
    if (supported && (supported.mappedStatus === 'mapped' || supported.mappedStatus === 'partial')) {
      const missing = missingEvidence(cap.evidenceRequired, supported.evidencePresent);
      if (missing.length) {
        openGaps.push(toGap(cap, 'mapped-missing-evidence', {
          mappedStatus: supported.mappedStatus,
          evidencePresent: [...supported.evidencePresent],
          summary: `${cap.summary ?? cap.id} Missing evidence: ${missing.join(',')}.`,
        }));
      }
      continue;
    }
    if (supported && supported.mappedStatus === 'not-applicable') continue;
    if (supported && supported.mappedStatus === 'excluded') {
      blocked.push(toGap(cap, 'reviewed-exclusion', { mappedStatus: 'excluded' }));
      continue;
    }
    if (cap.productStatus === 'unsafe' || cap.productStatus === 'not-productized') {
      blocked.push(toGap(cap, 'unsafe-unreviewed', { mappedStatus: 'excluded' }));
      continue;
    }
    if (cap.mappedStatus === 'unmapped') openGaps.push(toGap(cap, cap.reviewRequired ? 'policy-review-required' : 'discovered-unmapped'));
  }

  openGaps.sort((a, b) => a.id.localeCompare(b.id));
  blocked.sort((a, b) => a.id.localeCompare(b.id));
  return {
    schemaVersion: 1,
    agent: discovered.agent,
    version: discovered.version,
    mode,
    sourceLock: sourceLockPath,
    generatedAt: mode === 'fixture' ? '2026-07-01T00:00:00.000Z' : new Date().toISOString(),
    openGaps,
    blocked,
  };
}
