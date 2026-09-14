#!/usr/bin/env bun
/**
 * Registry-derived all-capabilities contract matrix — PERMANENT and FAIL CLOSED.
 *
 * Every adapter in the production shipped list (`shippedAdapters()`) must answer
 * each row of this matrix in the companion manifest,
 * `adapter-capability-contract.json`, keyed by shipped adapter id. Registering a
 * new adapter without answering every row fails this suite — silence fails, by
 * design: a capability answer nobody wrote down is a capability the app quietly
 * does or does not offer on one agent only.
 *
 * Scope (binding third-review-round decision, four-harness plan 2026-08-27):
 * this generic matrix stays limited to `AgentBackend`'s PUBLIC surface —
 * capabilities keys/types, declared floors, and the roster derivation. Mapper
 * garbage-handling assertions are deliberately NOT in this gate; they stay in
 * the per-adapter suites (no package-exported `__test` SPI).
 *
 * Per shipped backend this suite asserts:
 *
 *   1. capabilities shape — every `AgentCapabilities` key present and correctly
 *      typed (ten keys today, verified against the protocol type: nine required
 *      plus the optional `supportsCrossClientDriveSharing`), no unknown keys,
 *      and the whole object deep-equal to the manifest's recorded baseline, so
 *      a silent capability flip goes red until the manifest is updated on
 *      purpose.
 *   2. supportsCrossClientDriveSharing — explicitly present (not `undefined`),
 *      OR its absence recorded in the manifest with a written reason. Either
 *      way the manifest carries the reason.
 *   3. canCreateSession — read through the SAME derivation the `/api/agents`
 *      route uses (`runtime.ts`): `typeof backend.createSession === 'function'`
 *      plus, when the optional dynamic `canCreateSession()` hook exists, its
 *      resolved value. This is a STATIC gate, so the resolved value of a live
 *      hook (opencode/kimi/dsh probe a server; codex/claude/pi read the local
 *      installation) is deliberately NOT resolved here — it is
 *      environment-dependent, and pinning it would make the gate red on any
 *      machine without the tool installed. What is pinned is the structural
 *      answer (create present? dynamic hook present? what does the hook read?)
 *      plus the reason, and a source-parity check below fails if the route
 *      stops using this derivation.
 *   4. terminalSyncHint / nativeId — these live on `SessionInfo` (per-row
 *      optional fields), not on capabilities, and `discoverSessions()` hits
 *      live systems, so this gate does NOT call it. The minimal honest
 *      assertion is: the manifest records the adapter's answer (supported /
 *      conditional / partial / unsupported) with a written reason, and a
 *      compile-time typed-surface anchor below keeps both fields on the
 *      protocol `SessionInfo` type so the manifest rows cannot drift off the
 *      contract they describe.
 *
 * Codex's capabilities pivot on `COSYNCING_CODEX_SYNC_SERVER` /
 * `COSYNCING_CODEX_LIVE` (live sync on by default). Both are cleared while the
 * adapters are instantiated so the baseline records the DEFAULT environment and
 * the suite is deterministic; the caller's environment is restored immediately
 * after construction.
 *
 *   bun run packages/typescript/broker/test/broker/test-adapter-capability-contract.ts
 *   (exit 0 = all pass)
 */
export {};
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentCapabilities, AgentMessage, SessionInfo } from '../../../adapter-api/src/index.ts';
import { shippedAdapters } from '../../src/installation/shipped-adapters.ts';

// Compile-time typed-surface anchor for the two SessionInfo rows this gate
// answers through the manifest instead of through live discovery (see header,
// row 4). `bun run` strips types, so this bites under `bun run check`/tsc: if
// either field moves off SessionInfo, the manifest rows naming it stop
// compiling here rather than silently describing a contract that no longer
// exists.
const _sessionInfoSurface: Pick<SessionInfo, 'nativeId' | 'terminalSyncHint'> | null = null;
void _sessionInfoSurface;
const _reflectionSessionSurface: Pick<
  SessionInfo,
  'currentModel' | 'currentMode' | 'origin' | 'parentThreadId'
> | null = null;
const _reflectionMessageSurface: Extract<
  AgentMessage,
  { type: 'metadata-update' | 'token-count' | 'run-summary' }
> | null = null;
void _reflectionSessionSurface;
void _reflectionMessageSurface;

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── The contract vocabulary ─────────────────────────────────────────────────
//
// Verified against `AgentCapabilities` in packages/typescript/protocol/src/index.ts:
// ten keys, exactly one of them optional. If the protocol type gains or loses a
// key, this list — and every manifest baseline — must be updated in the same
// change; the unknown-key check below fails closed until then.

const CAPABILITY_KEYS = [
  'integrationKind',
  'attachModes',
  'supportsObserve',
  'supportsResume',
  'supportsLiveAttach',
  'supportsCrossClientDriveSharing',
  'supportsNativeArtifact',
  'supportsNativeFileInput',
  'supportsModelSwitch',
  'permissionGranularity',
] as const;
type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/** Every key except the one the protocol type marks optional. */
const REQUIRED_KEYS = CAPABILITY_KEYS.filter((key) => key !== 'supportsCrossClientDriveSharing');

const BOOLEAN_KEYS: readonly CapabilityKey[] = [
  'supportsObserve',
  'supportsResume',
  'supportsLiveAttach',
  'supportsNativeArtifact',
  'supportsNativeFileInput',
  'supportsModelSwitch',
];

const INTEGRATION_KINDS = ['http-sse', 'jsonrpc-stdio', 'acp-stdio', 'sdk-callback', 'http-websocket', 'pty-floor'];
const ATTACH_MODES = ['live', 'resume', 'observe'];
const PERMISSION_GRANULARITIES = ['none', 'per-tool', 'per-session', 'yolo'];

const HINT_STATUSES = ['supported', 'conditional', 'unsupported'];
const NATIVE_ID_STATUSES = ['supported', 'partial', 'unsupported'];
const HOOK_READS = ['live-server', 'local-installation'];
const REFLECTION_SURFACE_KEYS = [
  'createModelPropagation',
  'createPermissionModePropagation',
  'currentMode',
  'subagentNesting',
  'nativeRename',
  'modelLabels',
  'contextUsage',
  'tokenUsage',
  'costUsage',
  'runSummary',
  'slashCommands',
] as const;

/** An `unsupported`-class answer with no prose is silence wearing a label. */
const MIN_REASON_LENGTH = 40;

interface ReasonedRow { reason?: string }
interface CrossClientRow extends ReasonedRow { declared?: boolean }
interface CanCreateRow extends ReasonedRow {
  createSessionPresent?: boolean;
  dynamicHook?: boolean;
  hookReads?: string | null;
}
interface StatusRow extends ReasonedRow { status?: string }
interface ReflectionSurfaces extends ReasonedRow {
  supported?: string[];
  conditional?: string[];
  partial?: string[];
  unsupported?: Record<string, string>;
}
interface ManifestEntry {
  capabilities?: Record<string, unknown>;
  crossClientDriveSharing?: CrossClientRow;
  canCreateSession?: CanCreateRow;
  terminalSyncHint?: StatusRow;
  nativeId?: StatusRow;
  reflectionSurfaces?: ReflectionSurfaces;
}
interface Manifest {
  schemaVersion?: number;
  adapters?: Record<string, ManifestEntry>;
}

/** Deep equality with object keys sorted; array order stays significant
 *  (`attachModes` is best-first, so its order is part of the answer). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function reasoned(row: ReasonedRow | undefined): boolean {
  return typeof row?.reason === 'string' && row.reason.trim().length >= MIN_REASON_LENGTH;
}

// ── The roster, from the production shipped list ────────────────────────────
//
// The ids come from the adapter classes the build actually ships, never from a
// hand-kept list beside this suite: a newly registered adapter has no manifest
// entry and section 1 goes red instead of skipping it.

const previousSyncServer = process.env.COSYNCING_CODEX_SYNC_SERVER;
const previousLive = process.env.COSYNCING_CODEX_LIVE;
delete process.env.COSYNCING_CODEX_SYNC_SERVER;
delete process.env.COSYNCING_CODEX_LIVE;
let adapters: readonly import('../../../adapter-api/src/index.ts').AgentBackend[];
try {
  adapters = shippedAdapters();
} finally {
  // Capabilities are computed in each constructor, so the caller's environment
  // can be restored as soon as the instances exist.
  if (previousSyncServer == null) delete process.env.COSYNCING_CODEX_SYNC_SERVER;
  else process.env.COSYNCING_CODEX_SYNC_SERVER = previousSyncServer;
  if (previousLive == null) delete process.env.COSYNCING_CODEX_LIVE;
  else process.env.COSYNCING_CODEX_LIVE = previousLive;
}

const ADAPTER_IDS = adapters.map((adapter) => adapter.id);

check(
  'the production shipped-adapter list yields at least one adapter',
  ADAPTER_IDS.length > 0,
  `ids=${ADAPTER_IDS.join(',')}`,
);
check(
  'shipped adapter ids are unique',
  new Set(ADAPTER_IDS).size === ADAPTER_IDS.length,
  `duplicates=${ADAPTER_IDS.filter((id, index) => ADAPTER_IDS.indexOf(id) !== index).join(',') || '(none)'}`,
);

const manifest = JSON.parse(
  readFileSync(resolve(import.meta.dir, 'adapter-capability-contract.json'), 'utf8'),
) as Manifest;
const manifestIds = Object.keys(manifest.adapters ?? {});

check(
  'the manifest declares the supported schema version',
  manifest.schemaVersion === 2,
  `schemaVersion=${String(manifest.schemaVersion)}`,
);

// ── 1. Completeness: silence fails ──────────────────────────────────────────

for (const id of ADAPTER_IDS) {
  const entry = manifest.adapters?.[id];
  check(
    `${id}: answers every matrix row in the manifest`,
    !!entry
      && !!entry.capabilities
      && !!entry.crossClientDriveSharing
      && !!entry.canCreateSession
      && !!entry.terminalSyncHint
      && !!entry.nativeId
      && !!entry.reflectionSurfaces,
    entry ? `rows=${Object.keys(entry).sort().join(',')}` : '(no manifest entry)',
  );
}

check(
  'no answer is recorded for an adapter that is not shipped',
  manifestIds.every((id) => ADAPTER_IDS.includes(id)),
  `stray=${manifestIds.filter((id) => !ADAPTER_IDS.includes(id)).join(',') || '(none)'}`,
);

// ── 2. capabilities: ten keys, typed, pinned to the recorded baseline ───────

for (const adapter of adapters) {
  const id = adapter.id;
  const entry = manifest.adapters?.[id];
  const caps = adapter.capabilities as unknown as Record<string, unknown> | undefined;
  if (!entry) continue;

  check(
    `${id}: capabilities is a plain object`,
    !!caps && typeof caps === 'object' && !Array.isArray(caps),
    typeof caps,
  );
  if (!caps || typeof caps !== 'object') continue;

  check(
    `${id}: every required AgentCapabilities key is present`,
    REQUIRED_KEYS.every((key) => caps[key] !== undefined),
    `missing=${REQUIRED_KEYS.filter((key) => caps[key] === undefined).join(',') || '(none)'}`,
  );
  check(
    `${id}: capabilities carries no key outside the AgentCapabilities contract`,
    Object.keys(caps).every((key) => (CAPABILITY_KEYS as readonly string[]).includes(key)),
    `unknown=${Object.keys(caps).filter((key) => !(CAPABILITY_KEYS as readonly string[]).includes(key)).join(',') || '(none)'}`,
  );
  check(
    `${id}: integrationKind is a known IntegrationKind`,
    INTEGRATION_KINDS.includes(String(caps.integrationKind)),
    String(caps.integrationKind),
  );
  check(
    `${id}: attachModes is a non-empty list of known AttachMode values, best-first`,
    Array.isArray(caps.attachModes)
      && caps.attachModes.length > 0
      && caps.attachModes.every((mode) => ATTACH_MODES.includes(String(mode))),
    JSON.stringify(caps.attachModes),
  );
  check(
    `${id}: the six boolean capability flags are booleans`,
    BOOLEAN_KEYS.every((key) => typeof caps[key] === 'boolean'),
    BOOLEAN_KEYS.map((key) => `${key}=${typeof caps[key] === 'boolean' ? String(caps[key]) : `(${typeof caps[key]})`}`).join(','),
  );
  check(
    `${id}: permissionGranularity is a known PermissionGranularity`,
    PERMISSION_GRANULARITIES.includes(String(caps.permissionGranularity)),
    String(caps.permissionGranularity),
  );

  check(
    `${id}: declared capabilities equal the recorded baseline`,
    canonical(caps) === canonical(entry.capabilities ?? {}),
    `declared=${canonical(caps)} recorded=${canonical(entry.capabilities ?? {})}`,
  );
}

// ── 3. supportsCrossClientDriveSharing: explicit, or a recorded absence ─────
//
// The protocol type makes this key OPTIONAL with a false default, so an adapter
// that never says the word silently opts out of the cross-client join. The
// matrix requires the answer to be stated: the key present with a boolean, or
// the absence recorded with a reason. Either way the reason is written down.

for (const adapter of adapters) {
  const id = adapter.id;
  const row = manifest.adapters?.[id]?.crossClientDriveSharing;
  if (!row) continue;
  const caps = adapter.capabilities as unknown as Record<string, unknown>;
  const present = Object.prototype.hasOwnProperty.call(caps, 'supportsCrossClientDriveSharing')
    && caps.supportsCrossClientDriveSharing !== undefined;
  check(
    `${id}: supportsCrossClientDriveSharing presence matches the manifest`,
    row.declared === true ? present && typeof caps.supportsCrossClientDriveSharing === 'boolean' : !present,
    `declared=${String(row.declared)} present=${String(present)} value=${String(caps.supportsCrossClientDriveSharing)}`,
  );
  check(
    `${id}: the cross-client sharing answer carries a written reason`,
    reasoned(row),
    String(row.reason ?? '(none)'),
  );
}

// ── 4. canCreateSession: the /api/agents derivation, answered structurally ──
//
// The route (runtime.ts) answers
//   typeof b.createSession === 'function'
//   && (typeof b.canCreateSession === 'function' ? await …canCreateSession()… : true)
// The dynamic half resolves against live systems or the local installation, so
// this gate pins the structure and the reason, not the resolved boolean (header,
// row 3). The parity check right after fails closed if the route's derivation
// drifts from the one this gate mirrors.

for (const adapter of adapters) {
  const id = adapter.id;
  const row = manifest.adapters?.[id]?.canCreateSession;
  if (!row) continue;
  check(
    `${id}: createSession presence matches the manifest`,
    (typeof adapter.createSession === 'function') === row.createSessionPresent,
    `typeof createSession=${typeof adapter.createSession} pinned=${String(row.createSessionPresent)}`,
  );
  check(
    `${id}: canCreateSession hook presence matches the manifest`,
    (typeof adapter.canCreateSession === 'function') === row.dynamicHook,
    `typeof canCreateSession=${typeof adapter.canCreateSession} pinned=${String(row.dynamicHook)}`,
  );
  check(
    `${id}: the hook's evidence source is recorded and consistent`,
    row.dynamicHook === true
      ? HOOK_READS.includes(String(row.hookReads))
      : row.hookReads === null,
    `dynamicHook=${String(row.dynamicHook)} hookReads=${String(row.hookReads)}`,
  );
  check(
    `${id}: the canCreateSession answer carries a written reason`,
    reasoned(row),
    String(row.reason ?? '(none)'),
  );
}

const runtimeSource = readFileSync(resolve(import.meta.dir, '../../src/runtime/runtime.ts'), 'utf8');
check(
  'the /api/agents route still derives canCreateSession the way this gate mirrors',
  runtimeSource.includes('typeof b.createSession === \'function\'')
    && runtimeSource.includes('typeof b.canCreateSession === \'function\''),
  'both derivation fragments must appear in runtime.ts; if the route changed, update this gate and the manifest together',
);

// ── 5. terminalSyncHint and nativeId: recorded answers, typed surface ───────
//
// Both are per-row SessionInfo fields and discoverSessions() is live, so the
// assertion is the manifest record itself (status token + written reason),
// anchored to the contract by the compile-time Pick<> at the top of this file.
// What would make a row's answer false is a per-adapter runtime fact, which the
// per-adapter suites own — this gate owns that the answer EXISTS.

for (const adapter of adapters) {
  const id = adapter.id;
  const hint = manifest.adapters?.[id]?.terminalSyncHint;
  if (hint) {
    check(
      `${id}: terminalSyncHint has a recorded status`,
      HINT_STATUSES.includes(String(hint.status)),
      `status=${String(hint.status)}`,
    );
    check(
      `${id}: the terminalSyncHint answer carries a written reason`,
      reasoned(hint),
      String(hint.reason ?? '(none)'),
    );
  }
  const nativeId = manifest.adapters?.[id]?.nativeId;
  if (nativeId) {
    check(
      `${id}: nativeId has a recorded status`,
      NATIVE_ID_STATUSES.includes(String(nativeId.status)),
      `status=${String(nativeId.status)}`,
    );
    check(
      `${id}: the nativeId answer carries a written reason`,
      reasoned(nativeId),
      String(nativeId.reason ?? '(none)'),
    );
  }
}

// ── 6. Reflection cross-agent surfaces: every adapter answers every row ─────
//
// These are intentionally registry-wide. Per-adapter suites prove the native
// wire details; this gate prevents a new adapter from silently omitting the
// composer, roster, telemetry, lifecycle, or command surface altogether.

for (const adapter of adapters) {
  const rows = manifest.adapters?.[adapter.id]?.reflectionSurfaces;
  const answers = [
    ...(rows?.supported ?? []).map((key) => [key, 'supported'] as const),
    ...(rows?.conditional ?? []).map((key) => [key, 'conditional'] as const),
    ...(rows?.partial ?? []).map((key) => [key, 'partial'] as const),
    ...Object.keys(rows?.unsupported ?? {}).map((key) => [key, 'unsupported'] as const),
  ];
  const answeredKeys = answers.map(([key]) => key);
  check(
    `${adapter.id}: every reflection surface has an explicit answer`,
    REFLECTION_SURFACE_KEYS.every((key) => answeredKeys.filter((candidate) => candidate === key).length === 1)
      && answeredKeys.every((key) => (REFLECTION_SURFACE_KEYS as readonly string[]).includes(key)),
    `rows=${answeredKeys.sort().join(',')}`,
  );
  check(
    `${adapter.id}: reflection surface evidence is recorded`,
    reasoned(rows),
    String(rows?.reason ?? '(none)'),
  );
  for (const [key, reason] of Object.entries(rows?.unsupported ?? {})) {
    check(
      `${adapter.id}: unsupported ${key} carries its own reason`,
      typeof reason === 'string' && reason.trim().length >= MIN_REASON_LENGTH,
      reason,
    );
  }
  const statusOf = (key: string): string | undefined => answers.find(([candidate]) => candidate === key)?.[1];
  // Both directions, as `nativeRename` below already does. Checking only the
  // POSITIVE direction let an `unsupported` declaration sit beside a shipped
  // `listModels`, so an adapter could ship create-model propagation while the
  // manifest denied it -- and because the ordinary browser and raw oracles skip
  // a surface the manifest calls unsupported, the whole gate stayed green over
  // a shipped surface nobody was testing. A stale denial is the failure mode
  // that hides work; a stale claim is the one that overstates it. Catch both.
  const hasHooks = (hook: 'listModels' | 'listModes'): boolean =>
    typeof adapter.createSession === 'function' && typeof adapter[hook] === 'function';
  const model = statusOf('createModelPropagation');
  if (model === 'supported' || model === 'conditional') {
    check(
      `${adapter.id}: create-model support has both structural hooks`,
      hasHooks('listModels'),
      `create=${typeof adapter.createSession} models=${typeof adapter.listModels}`,
    );
  } else if (model === 'unsupported') {
    check(
      `${adapter.id}: create-model denial matches the shipped hooks`,
      !hasHooks('listModels'),
      `create=${typeof adapter.createSession} models=${typeof adapter.listModels}`,
    );
  }
  const mode = statusOf('createPermissionModePropagation');
  if (mode === 'supported' || mode === 'conditional') {
    check(
      `${adapter.id}: create-mode support has both structural hooks`,
      hasHooks('listModes'),
      `create=${typeof adapter.createSession} modes=${typeof adapter.listModes}`,
    );
  } else if (mode === 'unsupported') {
    check(
      `${adapter.id}: create-mode denial matches the shipped hooks`,
      !hasHooks('listModes'),
      `create=${typeof adapter.createSession} modes=${typeof adapter.listModes}`,
    );
  }
  const rename = statusOf('nativeRename');
  check(
    `${adapter.id}: native rename status matches the shipped hook`,
    rename === 'supported'
      ? typeof adapter.renameSession === 'function'
      : rename === 'unsupported'
        ? typeof adapter.renameSession !== 'function'
        : true,
    `status=${String(rename)} rename=${typeof adapter.renameSession}`,
  );
}

// ── Tail ────────────────────────────────────────────────────────────────────

const passed = results.filter((item) => item.ok).length;
const failed = results.length - passed;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
