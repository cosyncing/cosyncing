import type { AgentId } from '../tests_traces/scenarios.ts';
import type { EvidenceLevel, TaxonomyFunction } from '../tests_traces/trace-manifest.ts';

export type NativeKind =
  | 'api'
  | 'cli-command'
  | 'slash-command'
  | 'tui-command'
  | 'event'
  | 'model-control'
  | 'lifecycle'
  | 'artifact'
  | 'telemetry'
  | 'auth'
  | 'security'
  | 'tui-ornament';

export type ProductStatus =
  | 'productize-now'
  | 'productize-after-review'
  | 'observe-only'
  | 'adapter-only'
  | 'not-productized'
  | 'unsafe'
  | 'research-follow-up';

export type MappedStatus = 'mapped' | 'partial' | 'unmapped' | 'excluded' | 'not-applicable' | 'claimed-missing-evidence';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type RiskClass = 'R0' | 'R1' | 'R2' | 'R3';
/**
 * Where a productized capability is exposed in the app. maintainer's UI-surface principle
 * (consolidation.md §4.6): the session UI must not accumulate buttons for infrequent actions. Default
 * for lifecycle/infrequent capabilities is `command` (command surface / native terminal, no chrome);
 * `button` is reserved for frequent controls (rename + core drive/stop/model); `none` = not surfaced.
 */
export type AppSurface = 'button' | 'command' | 'none';
/** Client trust tier (consolidation.md §4.2). T1 same-machine, T2 own-network authed, T3 beyond. */
export type TrustTier = 'T1' | 'T2' | 'T3';
/**
 * How a stored artifact is delivered. `interactive` is the EXISTING inline sandboxed-HTML artifact path
 * (unchanged). `export-attachment` is R2 transcript export: attachment/no-store/CSP-sandbox/nosniff,
 * random opaque ids, ingested only from a broker-owned temp root, NEVER inline-rendered.
 */
export type DeliveryClass = 'interactive' | 'export-attachment';
export type GapReason =
  | 'discovered-unmapped'
  | 'mapped-missing-evidence'
  | 'policy-review-required'
  | 'source-drift'
  | 'reviewed-exclusion'
  | 'unsafe-unreviewed';

export const CAPABILITY_SCHEMA_VERSION = 1;

export const NATIVE_KINDS: readonly NativeKind[] = [
  'api',
  'cli-command',
  'slash-command',
  'tui-command',
  'event',
  'model-control',
  'lifecycle',
  'artifact',
  'telemetry',
  'auth',
  'security',
  'tui-ornament',
];

export const PRODUCT_STATUSES: readonly ProductStatus[] = [
  'productize-now',
  'productize-after-review',
  'observe-only',
  'adapter-only',
  'not-productized',
  'unsafe',
  'research-follow-up',
];

export const MAPPED_STATUSES: readonly MappedStatus[] = ['mapped', 'partial', 'unmapped', 'excluded', 'not-applicable', 'claimed-missing-evidence'];
export const RISK_LEVELS: readonly RiskLevel[] = ['low', 'medium', 'high', 'critical'];
export const RISK_CLASSES: readonly RiskClass[] = ['R0', 'R1', 'R2', 'R3'];
export const APP_SURFACES: readonly AppSurface[] = ['button', 'command', 'none'];
export const TRUST_TIERS: readonly TrustTier[] = ['T1', 'T2', 'T3'];
export const DELIVERY_CLASSES: readonly DeliveryClass[] = ['interactive', 'export-attachment'];
/** Default app surface for a capability that does not record one explicitly (maintainer §4.6). */
export const DEFAULT_APP_SURFACE: AppSurface = 'command';

export interface CapabilityRecord {
  schemaVersion: 1;
  id: string;
  nativeId: string;
  agent: AgentId;
  version: string;
  nativeKind: NativeKind;
  sourceRefs: string[];
  functions: TaxonomyFunction[];
  productStatus: ProductStatus;
  mappedStatus: MappedStatus;
  evidenceRequired: EvidenceLevel[];
  evidencePresent: EvidenceLevel[];
  risk: RiskLevel;
  riskClass: RiskClass;
  reviewRequired: boolean;
  /** App exposure surface (maintainer §4.6). Absent ⇒ {@link DEFAULT_APP_SURFACE} (`command`). */
  appSurface?: AppSurface;
  title?: string;
  summary?: string;
  deliberateExclusionReason?: string;
}

export interface DiscoveredCapabilitiesFile {
  schemaVersion: 1;
  agent: AgentId;
  version: string;
  capabilities: CapabilityRecord[];
}

export interface AdapterSupportEntry {
  schemaVersion: 1;
  id: string;
  nativeId: string;
  agent: AgentId;
  version: string;
  mappedStatus: Extract<MappedStatus, 'mapped' | 'partial' | 'excluded' | 'not-applicable'>;
  evidencePresent: EvidenceLevel[];
  adapterRefs?: string[];
  traceRefs?: string[];
  deliberateExclusionReason?: string;
}

export interface AdapterSupportManifest {
  schemaVersion: 1;
  agent: AgentId;
  version: string;
  capabilities: AdapterSupportEntry[];
}

export interface ProductPolicyEntry {
  schemaVersion: 1;
  id: string;
  agent: AgentId;
  nativeId: string;
  decision: ProductStatus;
  risk: RiskLevel;
  riskClass: RiskClass;
  reviewRequired: boolean;
  reason: string;
  reviewedAt: string;
  reviewer: string;
  expiresOn?: string | null;
}

export interface ProductPolicyFile {
  schemaVersion: 1;
  policies: ProductPolicyEntry[];
}

/**
 * A reviewed R2 (destructive-or-content-boundary) action descriptor. This is REVIEWED DATA, not code:
 * the broker consults it generically (never a tool-name branch) to gate confirm-UX, trust tier,
 * local enablement, size caps, retention, rate limits, and delivery class for an R2 action such as
 * `transcriptExport`. Encodes GPT-Pro §2 rules 1-3/10/15/18/20 + maintainer's §4.5 defaults.
 */
export interface R2ActionDescriptor {
  schemaVersion: 1;
  /** Canonical action id, e.g. `transcriptExport`. */
  id: string;
  riskClass: RiskClass;
  /** Trust tiers that may ever perform this action (T1 same-machine, T2 own-network authed). */
  allowedTrustTiers: TrustTier[];
  /** A fresh server-issued confirmation nonce is required (rules 3-5). */
  requiresConfirm: boolean;
  /** T2 (non-loopback) is default-deny unless the action is in `r2.enabledActions` (rule 2). */
  requiresLocalEnablement: boolean;
  /** Delivery class for produced artifacts (rules 14-16 apply only to `export-attachment`). */
  deliveryClass: DeliveryClass;
  /**
   * Does executing this action mutate session state? A read-only action (e.g. `transcriptExport`)
   * is `false`. A `true` (destructive) action MUST NOT bind its confirmation nonce to the weak
   * `session-timestamp` revision — enforced by `assertR2ActionsSafe` (maintainer Decision #2, 2026-07-08).
   */
  mutatesSession: boolean;
  /**
   * How the confirm-nonce "revision" is derived (rule 4: a session change forces re-confirm).
   * `session-timestamp` (updatedAt ?? createdAt) is a cheap proxy that is acceptable ONLY for
   * read-only actions — if an adapter fails to bump `updatedAt`, re-confirm weakens. Destructive
   * actions must use a content-derived binding (`content-hash` / `last-message-id`); those require
   * the discovery layer to surface the field and are not yet implemented in the broker (fail-closed).
   */
  revisionBinding: 'session-timestamp' | 'content-hash' | 'last-message-id';
  /** Accepted execute-body parameter names; anything else (e.g. client output paths) is rejected. */
  paramSchema: { allowedKeys: string[]; rejectKeys: string[] };
  /** Default per-artifact byte cap (rule 10). */
  sizeCapBytes: number;
  /** Hard local override ceiling for the byte cap (rule 10). */
  localMaxBytes: number;
  /** Artifact retention before automatic deletion (rule 18; maintainer §4.5 default 30 min). */
  retentionMs: number;
  /** Confirmation nonce lifetime (rule 3; ≤60s). */
  nonceTtlMs: number;
  /** Native invocation timeout / hard local max (rule 9). */
  timeoutMs: number;
  localMaxTimeoutMs: number;
  /** Conservative R2 rate limits (rule 20). */
  rateLimit: { perSessionWindowMs: number; perSessionMax: number; perBrokerWindowMs: number; perBrokerMax: number };
}

export interface R2ActionRegistryFile {
  schemaVersion: 1;
  actions: R2ActionDescriptor[];
}

export type SourceTrust = 'official-doc' | 'official-schema' | 'local-help' | 'local-live-api' | 'source-repo' | 'redacted-trace' | 'reviewed-seed';

export interface CapabilitySourceLock {
  schemaVersion: 1;
  agent: AgentId;
  version: string;
  captured_at: string;
  sources: Array<{
    id: string;
    command?: string;
    source_url?: string;
    local_command?: string;
    checksum: string;
    trust_level: SourceTrust;
  }>;
}

export interface GapRecord {
  id: string;
  capabilityId: string;
  nativeId: string;
  agent: AgentId;
  version: string;
  functions: TaxonomyFunction[];
  productStatus: ProductStatus;
  mappedStatus: MappedStatus;
  evidenceRequired: EvidenceLevel[];
  evidencePresent: EvidenceLevel[];
  risk: RiskLevel;
  riskClass: RiskClass;
  reviewRequired: boolean;
  reason: GapReason;
  title?: string;
  summary?: string;
  cardPath?: string;
  deliberateExclusionReason?: string;
}

export interface GapReport {
  schemaVersion: 1;
  agent: AgentId;
  version: string;
  mode: 'fixture' | 'live';
  sourceLock: string;
  generatedAt: string;
  openGaps: GapRecord[];
  blocked: GapRecord[];
}
