/**
 * cosyncing broker — Bun single-binary daemon.
 * - Aggregates per-tool adapters into one session roster.
 * - Owns one connection per session and fans it out over WebSocket (Hub).
 * - Serves the web client.
 *
 * Run: `bun run packages/typescript/broker/src/runtime/runtime.ts`  (or `bun run broker`)
 * Source-development env: PORT (7734), COSYNCING_MACHINE, OPENCODE_URL.
 */
import os from 'node:os';
import { closeSync, createReadStream, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Server, ServerWebSocket } from 'bun';
import {
  AgentRegistry,
  BROKER_CONTRACT,
  DRIVE_ATTACH_REASONS,
  evaluateBrokerClientCompatibility,
  isAgentOwnedSessionError,
  isHistorySnapshotRefusal,
  isOwnershipConflictError,
  OwnershipConflictError,
  isSessionCreateTemporarilyUnavailableError,
  SessionCreateTemporarilyUnavailableError,
  type AggregatedMachines,
  type AgentMessage,
  type AttachMode,
  type BrokerClientCompatibility,
  type BrokerErrorCode,
  type ClientContractIdentity,
  type DriveAttachReason,
  type HistorySourceIdentity,
  type CommandResult,
  type MachineRoster,
  type ModelOption,
  type ModelSelection,
  type PlanActionInput,
  type ScheduleAction,
  type ScheduleCron,
  type ScheduleOutcome,
  type ScheduleRecord,
  type ScheduleRepeat,
  type ScheduleRetryPolicy,
  type ScheduleUpdate,
  type SessionConnection,
  type SessionInfo,
  type SessionOwnerRevision,
} from '@cosyncing/adapter-api';
import { OpenCodeAdapter } from '@cosyncing/adapter-opencode';
import { PiAdapter } from '@cosyncing/adapter-pi';
import {
  CodexAdapter,
  createCodexConfigFreshnessProbe,
  queryCodexLoadedThreadActivitiesStrict,
  readCodexDaemonVersion,
  restartCodexDaemon,
  stopCodexDaemonEnsureProcess,
} from '@cosyncing/adapter-codex';
import { ClaudeAdapter, claudeSessionId, installClaudeHooks, uninstallClaudeHooks, claudeHooksInstalled, claudeHooksSettingsPath, isClaudeTranscriptPathAllowed, readLatestModel, readLatestPermissionMode, modelAlias } from '@cosyncing/adapter-claude';
import { KimiAdapter } from '@cosyncing/adapter-kimi';
import { DshAdapter } from '@cosyncing/adapter-dsh';
import { Hub, type Client, type ManagedConn, type WireEvent } from '../sessions/hub.ts';
import { authoritativeLiveOwners, overlayAuthoritativeOwner } from '../roster/roster-overlay.ts';
import {
  createRosterPublicationBoundary,
  NativeIncarnationPublicationAuthority,
} from '../roster/roster-publication.ts';
import { SharedDraftStore } from '../sessions/draft-store.ts';
import {
  FsBrowseError,
  DEFAULT_FS_READ_CAP_BYTES,
  readSessionDirectory,
  readSessionFile,
  prepareSessionDownload,
  readSessionStat,
} from '../artifacts/fs-browse.ts';
import { DownloadRangeError, ifRangeMatches, parseDownloadRange } from '../artifacts/fs-browse.ts';
import { PiBridgeRegistry } from '@cosyncing/adapter-pi';
import { ClaudeHooksRegistry } from '@cosyncing/adapter-claude';
import { HISTORY_WEBSOCKET_OPTIONS } from '../transport/http-contracts.ts';
import {
  acceptsGzip,
  filterSessionsByWindow,
  ifNoneMatchMatches,
  jsonMaybe,
  parseSessionWindowMs,
  sessionWindowRepresentationExpiry,
} from '../roster/roster-http.ts';
import { RosterRevisionStore } from '../roster/roster-revision.ts';
import {
  ArtifactStore,
  artifactCacheRoot,
  type AuthorizedArtifactInteraction,
} from '../artifacts/artifact-store.ts';
import { buildDiffRefMessage, INLINE_DIFF_CAP } from '../sessions/diff-reference.ts';
import { assertR2ActionsSafe, consumeConfirmNonce, deriveSessionRevision, getR2Action, issueConfirmNonce, r2ActionAvailable, r2MaxBytes, reserveR2RateSlot, trustTierForAddress } from '../security/r2-policy.ts';
import { runTranscriptExport } from '../security/r2-export.ts';
import {
  backwardHistoryCursor,
  capHistoryDelta,
  historyDelta,
  isCursorDurableMessage,
} from '../sessions/history-delta.ts';
import {
  BoundedTailHistorySnapshotSink,
  type BoundedTailHistoryReplay,
  type CompactHistoryAttach,
  EncodedHistoryPageCache,
  HISTORY_PAGE_CACHE_IDLE_TTL_MS,
  historySourceStillContainsSnapshot,
  IndexedHistoryPageCacheBuilder,
  type HistoryPageCache,
  HistoryPageCachePool,
  sameHistorySourceIdentity,
} from '../sessions/history-page-cache.ts';
import { refreshSessionOptions } from '../sessions/session-options.ts';
import { SessionMetadataStore } from '../sessions/session-metadata-store.ts';
import {
  getCodexUpdatePolicy,
  getQuotaWarningsEnabled,
  readSetupState,
  setAgentSyncEnabled,
  setCodexDaemonOwnership,
  setCodexUpdatePolicy,
  setQuotaWarningsEnabled,
  setupStateHome,
} from '../installation/setup-state.ts';
import {
  ensureManagedOpencodeServe,
  readManagedOpencodeVersions,
  restartManagedOpencodeRuntime,
  startOpencodeConfigWatch,
  stopOpencodeConfigWatch,
  stopManagedOpencodeServe,
  waitForManagedOpencodeCreateReadiness,
} from '@cosyncing/adapter-opencode';
import './managed-runtime-state.ts';
import { RuntimeUpdateCoordinator } from '../updates/runtime-update.ts';
import { createCodexRuntimeUpdateProvider, createOpencodeRuntimeUpdateProvider } from '../updates/runtime-update-providers.ts';
import { PairingHttpError, tokenHash, TransportPairingRegistry } from '../transport/transport-pairing.ts';
import { MemoryReplayCache, openTransportEnvelope } from '@cosyncing/transport-wire';
import type { TransportEnvelope } from '@cosyncing/transport';
import {
  scopedUploadIdentity,
  UploadError,
  UploadStaging,
} from '../artifacts/upload-staging.ts';
import { dispatchWakePush, WakePushError, WakePushRegistry } from '../transport/push-wake.ts';
import {
  aggregatedMachines,
  fetchPeerMachineRoster,
  localMachineRoster,
  parseMachinePeers,
  resolveMachineSession,
  type MachinePeerConfig,
} from '../roster/machine-aggregation.ts';
import { AttentionService } from '../attention/attention-service.ts';
import { AuthFailureAttentionTracker } from '../attention/attention-policy.ts';
import { BrokerHealthMonitor, type BrokerHealthSnapshot } from './broker-health.ts';
import { BrokerHealthAttentionReconciler } from '../attention/broker-health-attention.ts';
import { DeviceWakeCoalescer } from '../transport/push-wake.ts';
import {
  fetchTokdashQuota,
  normalizeTokdashQuotaBaseUrl,
  resolveTokdashEndpoint,
  tokdashRejectionReason,
  TokdashQuotaEvaluator,
} from '../installation/tokdash-quota.ts';
import { AttentionReminderScheduler } from '../attention/attention-reminder-scheduler.ts';
import {
  isValidTimeZone,
  MAX_SCHEDULED,
  ScheduleMutationError,
  ScheduleStore,
  validateRetryPolicy,
  validateScheduleCron,
} from '../scheduling/schedule-store.ts';
import { ScheduledSendRunner, type ScheduleDeliveryResult } from '../scheduling/schedule-runner.ts';
import { PRODUCT_IDENTITY } from '@cosyncing/protocol';
import { BUILD_INFO, buildFingerprint } from './build-info.ts';
import { currentApplicationIdentity } from './application-identity.ts';
import { serveWebHandoff, WEB_HANDOFF_PATH } from '../artifacts/web-handoff.ts';
import { driveAttachRefusalCode } from '../sessions/client-message-policy.ts';
import { canMutateSession, canPromptSession } from '../sessions/session-owner.ts';
import { ClientHandoffSequencer } from '../sessions/client-handoff-sequencer.ts';
import { APP_MOUNT_PATH, APP_PATH } from '../transport/http-contracts.ts';
import {
  ClientMessagePolicyError,
  validatePlanActionRequest,
  validateRequestedAgent,
  validateRequestedPermissionMode,
} from '../sessions/client-message-policy.ts';
import {
  brokerRelaunchCommand,
  detectBrokerServiceBoundary,
  SERVICE_RESTART_EXIT_CODE,
  type BrokerServiceBoundary,
} from './service-boundary.ts';
import { resolveFlutterWebRoot } from './runtime-assets.ts';
import {
  BROKER_LISTEN_HOST,
  migrateBrokerConfigV1,
  resolveBrokerConfiguration,
} from './configuration.ts';
import { resolveRuntimeCredentials, safeCredentialEqual } from '../security/credentials.ts';
import { inspectDurableCorruptionEvidence, inspectDurableSchemas } from '../security/durable-state.ts';
import { remoteFilesystemAllowed } from '../sessions/client-message-policy.ts';
import {
  clearManagedRuntimeFailure,
  recordManagedRuntimeFailure,
} from './managed-runtime-state.ts';
import {
  rosterRepresentationKey,
  rosterVisibility,
  visibleSessions,
  type RosterVisibility,
} from './roster-visibility.ts';
import {
  defaultManagedHostEffects,
  ensureManagedHost,
  managedHostRestartLedger,
  managedHostStartupReport,
  managedHostStore,
  ManagedHostSupervisor,
  MANAGED_HOST_SUPERVISION_INTERVAL_MS,
  releaseManagedHost,
} from './managed-host.ts';
import {
  mutationFingerprint,
  ProtocolJournal,
  type ProtocolJournalScope,
  type ProtocolTerminalResult,
} from '../sessions/protocol-journal.ts';
import {
  BROKER_UPDATE_CHECK_INTERVAL_MS,
  BrokerUpdateChecker,
  isBrokerUpdateManifestUrl,
  triggerBrokerUpdate,
} from '../updates/broker-update.ts';

export interface BrokerRuntime {
  server: Server<any>;
  closed: Promise<void>;
  shutdown(reason?: string): Promise<void>;
}

export function installBrokerSignalHandlers(runtime: Pick<BrokerRuntime, 'shutdown'>): () => void {
  let active = true;
  const remove = () => {
    if (!active) return;
    active = false;
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  };
  const handle = (signal: 'SIGINT' | 'SIGTERM') => {
    remove();
    void runtime.shutdown(signal).then(
      () => process.exit(Number(process.exitCode ?? 0)),
      (error) => {
        console.error(`[${PRODUCT_IDENTITY.productName}] shutdown failed: ${String(error)}`);
        process.exit(1);
      },
    );
  };
  const onSigint = () => handle('SIGINT');
  const onSigterm = () => handle('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  return remove;
}

/**
 * A command that resolves is normally an accepted app mutation. A few adapter actions also use a
 * successful CommandResult to report that there was nothing to change, though; those must not turn
 * an arrival-only command frame into durable private-divergence evidence. Rejected commands throw
 * before this helper is called. Keep this broker-side so the public CommandResult contract stays
 * additive and unchanged.
 */
export function isAcceptedMutationCommand(
  name: string,
  args: unknown,
  result: CommandResult | void,
): boolean {
  const runtimeResult = result as (CommandResult & { accepted?: unknown }) | undefined;
  if (runtimeResult?.accepted === false) return false;

  const normalizedName = name.trim().toLowerCase();
  if (normalizedName === 'goal' && !String(args ?? '').trim()) return false;

  const notice = typeof result?.notice === 'string' ? result.notice.trim() : '';
  if (!notice) return true;
  return !/^(?:no\s+(?:running\s+turn\s+to\s+stop|private\s+drive\s+turn\s+is\s+running)|nothing(?:\s+more)?\s+to\s+(?:undo|redo)|no\s+goal\s+is\s+set|add\s+an\s+objective\s+after\s+\/goal\s+set)\.?$/i.test(notice);
}

/** A session another AGENT spawned, stated over the protocol contract rather than per tool.
 *
 *  `SessionInfo.origin === 'subagent'` means the row's only writer is the parent session's run, so a
 *  user-initiated fork of it can only ever produce a second thread with the same defect. `'exec'` and
 *  `'vscode'` are automated/IDE LAUNCHES with no owning parent and stay forkable — this is deliberately
 *  narrower than "not human-initiated".
 *
 *  Advertisement, not enforcement: the roster row can be stale, absent, or served from a peer, so the
 *  owning adapter refuses the same fork independently. Both layers are required. */
export function isAgentOwnedSession(info: Pick<SessionInfo, 'origin'> | undefined | null): boolean {
  return info?.origin === 'subagent';
}

/** Typed anchors for the {@link isAgentOwnedSession} fork refusal, shared with the route tests. */
export const AGENT_OWNED_FORK_REFUSAL_CODE: BrokerErrorCode = 'SESSION_AGENT_OWNED';
export const AGENT_OWNED_FORK_REFUSAL =
  'This session was spawned by another agent session; fork its parent instead.';

function sameSessionIdentity(a: SessionInfo, b: SessionInfo): boolean {
  return a.tool === b.tool && (
    a.id === b.id ||
    (!!a.nativeId && !!b.nativeId && a.nativeId === b.nativeId)
  );
}

/** Overlay only explicit adapter/broker terminal-presence evidence onto the live connection view. */
export function overlayFreshTerminalPresence(info: SessionInfo, fresh: readonly SessionInfo[]): SessionInfo {
  const candidates = fresh
    .filter((candidate) => sameSessionIdentity(info, candidate))
    .map((candidate) => candidate.control?.terminalSync)
    .filter((sync): sync is NonNullable<SessionInfo['control']>['terminalSync'] => Boolean(sync && sync.presence !== undefined));
  if (!candidates.length) return info;

  const priority = (presence: NonNullable<SessionInfo['control']>['terminalSync']['presence']): number => {
    switch (presence) {
      case 'private': return 3;
      case 'shared': return 2;
      case 'unknown': return 1;
      case 'absent': return 0;
      default: return -1;
    }
  };
  const freshSync = candidates.reduce((best, candidate) =>
    priority(candidate.presence) > priority(best.presence) ? candidate : best,
  );
  const baseControl = info.control ?? fresh.find((candidate) => sameSessionIdentity(info, candidate))?.control;
  if (!baseControl) return info;
  return {
    ...info,
    control: {
      ...baseControl,
      terminalSync: {
        ...baseControl.terminalSync,
        ...freshSync,
      },
    },
  };
}

/** Start the broker daemon. Importing this module alone performs no runtime or filesystem mutation. */
export function startBrokerRuntime(): BrokerRuntime {
let server: Server<any> | undefined;
let shuttingDown = false;
const LOG_PREFIX = `[${PRODUCT_IDENTITY.productName}]`;
const SERVICE_BOUNDARY = detectBrokerServiceBoundary();

const configMigration = migrateBrokerConfigV1();
if (configMigration.migrated && configMigration.previousHost !== BROKER_LISTEN_HOST) {
  console.warn(
    `${LOG_PREFIX} migrated broker configuration to loopback; any existing external route remains operator-owned`,
  );
}
const EFFECTIVE_CONFIGURATION = resolveBrokerConfiguration({ packaged: BUILD_INFO.packaged });
const PORT = EFFECTIVE_CONFIGURATION.config.broker.port;
const LISTEN_HOST = BROKER_LISTEN_HOST;
if (EFFECTIVE_CONFIGURATION.config.broker.host !== LISTEN_HOST) throw new Error('broker-listener-host-invariant');
const MACHINE = EFFECTIVE_CONFIGURATION.config.broker.machineLabel;
const BROKER_URL = EFFECTIVE_CONFIGURATION.config.broker.internalUrl;
const RUNTIME_CREDENTIALS = resolveRuntimeCredentials({
  packaged: BUILD_INFO.packaged,
  internalUrl: BROKER_URL,
});
const TOKEN = RUNTIME_CREDENTIALS.brokerToken;
const PI_INTEGRATION_TOKEN = RUNTIME_CREDENTIALS.piIntegrationToken;
const MACHINE_PEER_CONFIG = readMachinePeerConfig();
// Flutter web build, served same-origin under /cosy/. From the monorepo root, build it with
// `bun run scripts/client/run-client-command.ts flutter build web --release --base-href /cosy/`.
// Override with COSYNCING_WEB_DIR to point elsewhere; the apps/client build may simply be absent.
// Packaged builds instead resolve a
// versioned directory beside the running executable; they never probe a repository-relative path.
/**
 * This broker process's own artifact and runtime.
 *
 * Resolved once at module load, because the web sidecar sits beside the APPLICATION and a restart must
 * re-enter the application — neither of which is `process.execPath` outside the compiled native build.
 */
const APPLICATION_IDENTITY = currentApplicationIdentity(
  BUILD_INFO.distribution,
  `${import.meta.dir}/main.ts`,
);
const COSYNCING_WEB_DIR = resolveFlutterWebRoot({
  override: EFFECTIVE_CONFIGURATION.config.paths?.flutterWebRoot,
  packaged: BUILD_INFO.packaged,
  executablePath: APPLICATION_IDENTITY.applicationPath,
  version: BUILD_INFO.version,
  sourceRoot: `${import.meta.dir}/../../../../apps/client/build/web`,
});
const CLAUDE_HOOKS_DEV_ENABLED = !BUILD_INFO.packaged && process.env.COSYNCING_DEV_MODE === '1';
// Cross-origin isolation for the /cosy/ mount. When on, every /cosy/ response carries COOP+COEP (+CORP), which
// makes the browser grant `SharedArrayBuffer` — the prerequisite for Flutter's faster multithreaded (skwasm)
// web renderer. OFF by default because COEP `require-corp` blocks any cross-origin subresource that doesn't
// opt in via CORP/CORS — notably a CDN-hosted CanvasKit (the default `flutter build web`). Only enable it with
// a self-contained build: `flutter build web --base-href /cosy/ --no-web-resources-cdn`. Toggle: COSYNCING_WEB_COI=1.
const WEB_COI = /^(1|true|yes|on)$/i.test(process.env.COSYNCING_WEB_COI?.trim() || '');
// The installed shared secret is REQUIRED on EVERY mutating request (POST/PATCH/DELETE) plus the
// session WS stream, the Pi-bridge legs (incl. the GET command long-poll), the Claude hook legs, and the
// hooks install-status — i.e. default-deny on anything that can run/approve/spawn/mutate; read-only GETs
// (roster, health, usage, agents, artifact serving) stay open. Every legitimate client carries it: the app
// appends it to the WS URL and adds `x-cosyncing-token` to its control fetches; the Pi extension, the Claude
// source-only hook, and the OpenCode send_file tool read the legacy environment override. The token can approve
// destructive tool calls, so an unauthenticated broker MUST NOT be exposed beyond loopback — see the
// non-loopback bind guard below. (Review findings 2026-06-23 + 2026-06-24: HIGH/no-auth, then default-deny.)
/** True when the request may touch a control path: no token configured → L0 loopback baseline; else the
 *  request must carry the secret as `x-cosyncing-token` or `?token=`. The Pi integration credential is accepted
 *  only on `/pi/bridge/*` and never becomes a general broker credential. */
function authed(req: Request, url: URL, path: string): boolean {
  if (!TOKEN) return true;
  const sharedToken = req.headers.get(PRODUCT_IDENTITY.tokenHeader)?.trim() || url.searchParams.get('token')?.trim() || '';
  const peerTokens = [
    req.headers.get('x-cosyncing-peer-token')?.trim() || '',
    url.searchParams.get('peerToken')?.trim() || '',
  ].filter(Boolean);
  if (safeCredentialEqual(TOKEN, sharedToken)
      || peerTokens.some((peerToken) => transportPairings.verifyAnyPeerToken(peerToken) === 'ok')) {
    return true;
  }
  if (!path.startsWith('/pi/bridge/') || !PI_INTEGRATION_TOKEN) return false;
  const integrationToken = req.headers.get('x-cosyncing-integration-token')?.trim() || '';
  return safeCredentialEqual(PI_INTEGRATION_TOKEN, integrationToken);
}

/** Unlike the loopback-compatible `authed`, this proves that an actual shared/peer credential was
 * supplied. The D12 Drive boundary requires this for direct `mode=resume`. */
function credentialAuthenticated(req: Request, url: URL): boolean {
  const sharedToken = req.headers.get(PRODUCT_IDENTITY.tokenHeader)?.trim() || url.searchParams.get('token')?.trim() || '';
  if (TOKEN && sharedToken === TOKEN) return true;
  const peerTokens = [
    req.headers.get('x-cosyncing-peer-token')?.trim() || '',
    url.searchParams.get('peerToken')?.trim() || '',
  ].filter(Boolean);
  return peerTokens.some((peerToken) => transportPairings.verifyAnyPeerToken(peerToken) === 'ok');
}

/** Stable durable-journal namespace.
 *
 * Keep this exactly credential-scoped for compatibility with revision-6
 * journal records. Upload authority adds a separate client-source scope below;
 * changing this value would make an ACK-lost outbox replay dispatch twice
 * across an upgrade.
 */
function requestCredentialIdentity(req: Request, url: URL): string {
  const sharedToken = req.headers.get(PRODUCT_IDENTITY.tokenHeader)?.trim() || url.searchParams.get('token')?.trim() || '';
  return TOKEN && sharedToken === TOKEN
    ? `shared:${tokenHash(sharedToken)}`
    : (() => {
      const peerToken = [
        req.headers.get('x-cosyncing-peer-token')?.trim() || '',
        url.searchParams.get('peerToken')?.trim() || '',
      ].find((candidate) => candidate && transportPairings.verifyAnyPeerToken(candidate) === 'ok');
      return peerToken ? `peer-token:${tokenHash(peerToken)}` : 'loopback-local';
    })();
}

/** Credential plus exact client-profile incarnation for staged uploads. */
function requestUploadIdentity(req: Request, url: URL): string {
  const profileId = req.headers.get('x-cosyncing-client-profile')?.trim()
    || url.searchParams.get('clientProfileId')?.trim()
    || '';
  const incarnation = req.headers.get('x-cosyncing-client-incarnation')?.trim()
    || url.searchParams.get('clientProfileIncarnation')?.trim()
    || '';
  return scopedUploadIdentity(
    requestCredentialIdentity(req, url),
    profileId || undefined,
    incarnation || undefined,
  );
}
function readMachinePeerConfig(): { peers: MachinePeerConfig[]; error?: string } {
  try {
    return { peers: parseMachinePeers() };
  } catch (err) {
    console.warn(`${LOG_PREFIX} ignoring invalid COSYNCING_MACHINE_PEERS: ${err instanceof Error ? err.message : String(err)}`);
    return { peers: [], error: err instanceof Error ? err.message : String(err) };
  }
}
// The same resolution setup uses, from the same variable — an override that setup refuses must not be one
// the runtime silently polls, and one setup accepts must not be one the runtime normalizes differently. The
// refusal is logged rather than thrown: a typo in an optional variable must not stop the broker booting.
const TOKDASH_ENDPOINT = resolveTokdashEndpoint(process.env.COSYNCING_TOKDASH_URL);
if (TOKDASH_ENDPOINT.rejected) {
  // The reason, never the value: `http://user:secret@127.0.0.1:55423` is refused for embedding credentials,
  // and printing what was refused is how the secret reaches the broker log. Same rule, same words, as the
  // wizard's — one refusal cannot read differently on two surfaces.
  console.warn(`${LOG_PREFIX} ignoring COSYNCING_TOKDASH_URL (value withheld): `
    + `${tokdashRejectionReason(TOKDASH_ENDPOINT.rejected)}; using ${TOKDASH_ENDPOINT.baseUrl}`);
}
const TOKDASH_URL = TOKDASH_ENDPOINT.baseUrl;
const TOKDASH_USAGE_PATHS = [
  '/api/usage/summary',
  '/api/usage/today',
  '/api/usage',
  '/usage/summary',
  '/usage/today',
  '/usage',
];
/** Env number with a default that survives blank/garbage values (never NaN-poisons a limit). */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
// Newest-messages cap on a single history frame (0 disables). A 16k-message replay is unrenderable
// on the client (the Chrome-tab-crash bug); the cursor still covers the full prefix so reattaches
// stay incremental. See capHistoryDelta.
const HISTORY_MAX_MESSAGES = envNumber('COSYNCING_HISTORY_MAX_MESSAGES', 500);
const FS_READ_CAP_BYTES = envNumber('COSYNCING_FS_READ_MAX_BYTES', DEFAULT_FS_READ_CAP_BYTES);
const UPLOAD_MAX_BYTES = envNumber('COSYNCING_UPLOAD_MAX_BYTES', 64 * 1024 * 1024);
const FS_DOWNLOAD_MAX_BYTES = envNumber('COSYNCING_FS_DOWNLOAD_MAX_BYTES', UPLOAD_MAX_BYTES);
const UPLOAD_CHUNK_MAX_BYTES = envNumber('COSYNCING_UPLOAD_CHUNK_MAX_BYTES', UPLOAD_MAX_BYTES);
// How long one roster discovery result may be reused. Full discovery reads every session file of
// every agent (measured ~30-40s of mostly-synchronous I/O on a real machine) while the app polls
// /api/sessions every 6s per tab — without this cache, polls pile up and starve the event loop.
const ROSTER_TTL_MS = envNumber('COSYNCING_ROSTER_TTL_MS', 4000);
const ROSTER_SAFETY_RECONCILE_MS = envNumber('COSYNCING_ROSTER_SAFETY_RECONCILE_MS', 5 * 60_000);
const TRANSPORT_MAX_BYTES = Number(process.env.COSYNCING_TRANSPORT_MAX_BYTES ?? 1024 * 1024);
const TRANSPORT_MAILBOX_MAX = Math.max(1, Number(process.env.COSYNCING_TRANSPORT_MAILBOX_MAX ?? 200) || 200);
const TRANSPORT_MAILBOX_TTL_MS = Math.max(1, Number(process.env.COSYNCING_TRANSPORT_TTL_MS ?? 10 * 60 * 1000) || 10 * 60 * 1000);
const TRANSPORT_PAIRING_TTL_MS = Math.max(1, Number(process.env.COSYNCING_TRANSPORT_PAIRING_TTL_MS ?? 5 * 60 * 1000) || 5 * 60 * 1000);

interface StoredTransportEnvelope {
  id: string;
  channel: string;
  bytes: Uint8Array;
  expiresAt: number;
  mailboxTokenHash: string;
  from?: string;
  to?: string;
  headers?: Record<string, string>;
}

const transportMailboxes = new Map<string, StoredTransportEnvelope[]>();
const transportControlReplayCaches = new Map<string, MemoryReplayCache>();

// Adapter protocol handshakes read the public identity from core and receive this stamped broker version
// without reversing the dependency direction (adapters never import broker modules).
process.env.COSYNCING_BROKER_BUILD_VERSION = BUILD_INFO.version;

// FU-3 (D14): apply persisted per-agent sync enablement to the environment BEFORE adapters construct.
// CodexAdapter reads COSYNCING_CODEX_SYNC_SERVER at construction (codexCapabilities()), so a broker
// launched after onboarding picks up Codex sync with NO restart. An explicit env value (e.g. set by a
// relaunch, or by the operator) always wins over the persisted default.
{
  const persisted = readSetupState().agents;
  // Resolve the EFFECTIVE Codex sync enablement exactly as the Codex adapter does — explicit env
  // COSYNCING_CODEX_SYNC_SERVER, else the legacy COSYNCING_CODEX_LIVE, accepting 1/true/yes/on — and fall
  // back to the persisted per-agent flag when neither env is set. Then write it back as the canonical
  // '1'/'0'. This guarantees the broker's `=== '1'` reads (brokerControlModeState, the
  // /api/agents/codex/sync GET, /api/agents syncEnabled) and the adapter's truthyEnv() can NEVER disagree
  // about whether Codex sync is on — the truthiness skew (env spelled "true", or only COSYNCING_CODEX_LIVE
  // set) that the review caught, where a "disable" request silently no-ops because the two paths differ.
  const envRaw = process.env.COSYNCING_CODEX_SYNC_SERVER ?? process.env.COSYNCING_CODEX_LIVE;
  // issues-part2: Codex true-sync is ON BY DEFAULT. Explicit env wins; an explicit Settings-toggle
  // "off" (persisted false) is honored; only an ABSENT preference defaults to enabled — the managed
  // `codex app-server daemon start` (adapter-side) makes it work with no manual setup step.
  const enabled = envRaw != null ? /^(1|true|yes|on)$/i.test(envRaw.trim()) : persisted?.codex !== false;
  process.env.COSYNCING_CODEX_SYNC_SERVER = enabled ? '1' : '0';
}

const registry = new AgentRegistry();
registry.register(new OpenCodeAdapter({
  waitForManagedCreateReadiness: waitForManagedOpencodeCreateReadiness,
}));
registry.register(new PiAdapter({
  brokerUrl: BROKER_URL,
  bridgeUsesIntegrationFile: RUNTIME_CREDENTIALS.piIntegrationSource === 'file',
}));
registry.register(new CodexAdapter({
  reportManagedStart: (failure) => {
    try {
      if (failure) {
        recordManagedRuntimeFailure({ agent: 'codex', ...failure });
      } else {
        clearManagedRuntimeFailure('codex');
      }
    } catch {
      /* a diagnostic journal failure cannot disable Codex discovery */
    }
  },
  reportDaemonOwnership: (evidence) => {
    // BPC8: persist whether cosyncing started the app-server daemon so uninstall can stop only what it owns.
    // A null decision (pre-existing/unknown daemon) records nothing, preserving any earlier sticky ownership.
    try {
      if (evidence) {
        setCodexDaemonOwnership({
          startedByBroker: evidence.startedByBroker,
          recordedAt: new Date().toISOString(),
          ...(evidence.socket ? { socket: evidence.socket } : {}),
        });
      }
    } catch {
      /* a durable ownership-evidence write failure cannot disable Codex discovery */
    }
  },
})); // Codex — observe (rollout-JSONL tail); resume is a later increment
registry.register(new ClaudeAdapter()); // Claude Code — observe (transcript-JSONL tail); resume/live are later increments
// Kimi Code — observe for every session (kimi web HTTP + WS), plus Drive for
// the ones cosyncing itself created. Foreground clients explicitly request
// `mode=live`; background resident tabs stay on the authority-free bare owner.
// A session this broker process did not create stays observe-only and
// fail-closed: a terminal `kimi -S` may own it, and two writers silently fork
// one Kimi journal. That rule, not configuration, is what makes Drive safe —
// the `COSYNCING_KIMI_DRIVE` rollout gate it used to sit behind is gone, having
// only ever meant that the surface most users would meet was the one that never
// shipped. Registered
// UNCONDITIONALLY: the old `COSYNCING_ENABLE_KIMI` gate was never a capability
// decision — the adapter was finished — but `/api/agents` was not
// revision-filtered, so one kimi row made a pre-tolerance client throw on the
// unknown integration kind and lose its WHOLE roster. A flag answered that by
// denying Kimi to everyone, including the clients that could read it and a
// managed service that could never set it. The route now filters per client
// against each adapter's declared minimum revision, which settles the same
// question without asking an operator to know a variable name.
registry.register(new KimiAdapter());
// DeepSeek Harness — live-only Drive against an EXTERNAL `dsh web` host: a
// process that exists with or without this broker and is never configured by
// it. Whether this broker may START one depends on how it was launched: the
// INSTALLED SERVICE carries `COSYNCING_DSH_MANAGED_HOST=1` in its durable
// environment, so a packaged cosyncing starts, supervises, and stops the host
// its agent needs; a FOREGROUND broker has no such environment unless the
// operator sets it, so a source checkout observes and touches nothing by
// default. Neither posture can reach a host it did not start: authorization
// only permits acting on a process this broker can prove is its own. dsh is
// server-first: one host
// process owns the append-only session log and every client (its own browser UI
// included) is a peer of it, so there is no ownership arbitration, no resume to
// offer, and no observe mode — the host serves one undifferentiated client
// contract, and calling a full-authority connection "observe" would be a lie.
// Registered UNCONDITIONALLY, for the reason given above Kimi. The old
// `COSYNCING_ENABLE_DSH` gate carried a second reason as well — with no host
// running, every action on the row fails — but that is a diagnosis to SHOW,
// not a registration question. An operator who has not started `dsh web` is
// better served by an agent that says so than by one that stays invisible
// unless they already knew to set a variable.
registry.register(new DshAdapter());

let latestBrokerHealth: BrokerHealthSnapshot;
let attentionService: AttentionService;
let wakePush: WakePushRegistry;
let wakeCoalescer: DeviceWakeCoalescer;
let attentionScheduler: AttentionReminderScheduler;
let brokerHealthAttention: BrokerHealthAttentionReconciler;
let healthReconcileQueued = false;

const brokerHealth = new BrokerHealthMonitor({
  stateRoot: setupStateHome(),
  artifactRoot: artifactCacheRoot(),
  onChange: (snapshot) => {
    latestBrokerHealth = snapshot;
    scheduleBrokerHealthAttentionReconcile();
  },
});
latestBrokerHealth = brokerHealth.snapshot();

let artifactFallbackRoot: string | undefined;
let artifactStore: ArtifactStore;
try {
  artifactStore = new ArtifactStore(BROKER_URL, artifactCacheRoot(), {
    onPersistenceResult: (result) => { brokerHealth.recordStoreWrite('artifact-store', result.ok); },
  });
} catch (error) {
  brokerHealth.recordStoreWrite('artifact-store', false);
  console.error(`${LOG_PREFIX} artifact cache unavailable; using a process-local fallback: ${error instanceof Error ? error.message : String(error)}`);
  artifactFallbackRoot = mkdtempSync(join(os.tmpdir(), 'cosyncing-artifacts-fallback-'));
  artifactStore = new ArtifactStore(BROKER_URL, artifactFallbackRoot, {
    onPersistenceResult: (result) => { brokerHealth.recordStoreWrite('artifact-store', result.ok); },
  });
}

// R2 rule 18: orderly shutdown calls this function explicitly, while the process exit listener is the
// synchronous last resort for an uncaught exception. Export attachments contain redacted transcripts and
// must not survive the broker process. SIGKILL and hard runtime aborts remain outside process cleanup.
function cleanupTransientArtifactsSync(): void {
  try {
    artifactStore.clearExportAttachments();
  } catch {
    /* best effort during process teardown */
  }
  if (!artifactFallbackRoot) return;
  try {
    rmSync(artifactFallbackRoot, { recursive: true, force: true });
  } catch {
    /* best effort during process teardown */
  }
}
process.on('exit', cleanupTransientArtifactsSync);

attentionService = new AttentionService({
  store: {
    onPersistenceResult: (ok) => { brokerHealth.recordStoreWrite('attention-store', ok); },
    onStartupResult: (ok, detailCode) => { brokerHealth.recordStoreStartup('attention-store', ok, detailCode); },
    onWarning: (message) => console.warn(`${LOG_PREFIX} ${message}`),
    onChange: () => { void attentionScheduler?.tick().catch(() => {}); },
  },
});
const codexConfigFreshness = createCodexConfigFreshnessProbe();
const runtimeUpdates = new RuntimeUpdateCoordinator([
  createCodexRuntimeUpdateProvider({
    readVersion: readCodexDaemonVersion,
    readConfigFreshness: (version) => codexConfigFreshness.inspect(version),
    loadedThreads: queryCodexLoadedThreadActivitiesStrict,
    policy: getCodexUpdatePolicy,
    restart: restartCodexDaemon,
  }),
  createOpencodeRuntimeUpdateProvider({
    readVersions: readManagedOpencodeVersions,
    isBusy: () => {
      const backend = registry.get('opencode');
      return typeof backend?.anySessionBusy === 'function' ? backend.anySessionBusy() : true;
    },
    restart: () => restartManagedOpencodeRuntime(() => !shuttingDown),
  }),
], {
  onStatus: (status) => attentionService.reconcileRuntimeStatus(status),
  restartAllowed: () => !shuttingDown,
});
const runtimeUpdateStatusTtlMs = Math.max(0, envNumber('COSYNCING_RUNTIME_UPDATE_STATUS_TTL_MS', 60_000));
const sessionMetadata = new SessionMetadataStore();
const authFailureAttention = new AuthFailureAttentionTracker();
const BROKER_DESCRIPTOR = Object.freeze({
  version: BUILD_INFO.version,
  contract: Object.freeze({ ...BROKER_CONTRACT }),
});
const brokerUpdateChecker = new BrokerUpdateChecker({ buildInfo: BUILD_INFO });
const transportPairings = new TransportPairingRegistry({
  broker: BROKER_DESCRIPTOR,
  ttlMs: TRANSPORT_PAIRING_TTL_MS,
});
const protocolJournal = new ProtocolJournal({
  onWarning: (message) => console.warn(`${LOG_PREFIX} ${message}`),
});
const rosterRevision = new RosterRevisionStore(
  Math.max(32, Math.floor(envNumber('COSYNCING_ROSTER_DELTA_JOURNAL', 512))),
);
const rosterWindowRevisions = new Map<number, RosterRevisionStore>();
const rosterWindowExpiresAt = new Map<number, number>();

function rosterRevisionForWindow(windowMs: number | undefined): RosterRevisionStore {
  if (windowMs === undefined) return rosterRevision;
  let store = rosterWindowRevisions.get(windowMs);
  if (!store) {
    store = new RosterRevisionStore(
      Math.max(32, Math.floor(envNumber('COSYNCING_ROSTER_DELTA_JOURNAL', 512))),
    );
    rosterWindowRevisions.set(windowMs, store);
  }
  return store;
}

/** Fan a native/live mutation into only the bounded views already in use. */
function observeRosterViews(info: SessionInfo): void {
  const decorated = decorateSession({ ...info, machine: MACHINE });
  rosterRevision.observe(decorated, MACHINE);
  const now = Date.now();
  for (const [windowMs, store] of rosterWindowRevisions) {
    if (filterSessionsByWindow([decorated], windowMs, now).length > 0) {
      store.observe(decorated, MACHINE);
      if (decorated.status === 'idle') {
        const timestamp = decorated.updatedAt ?? decorated.createdAt;
        if (timestamp !== undefined) {
          const expiry = timestamp + windowMs;
          rosterWindowExpiresAt.set(
            windowMs,
            Math.min(rosterWindowExpiresAt.get(windowMs) ?? expiry, expiry),
          );
        }
      }
    } else {
      store.remove(MACHINE, decorated.tool, decorated.id);
    }
  }
}
// Durable shared composer drafts (DR1): survives zero-client owner eviction and
// broker restart; ManagedConn keeps only the low-latency fan-out cache.
const draftStore = new SharedDraftStore({
  onPersistenceError: (error) =>
    console.error(`${LOG_PREFIX} shared draft store persistence failed: ${error instanceof Error ? error.message : String(error)}`),
});
const hub = new Hub(registry, 15000, artifactStore, {
  onMessage: (info, message) => {
    void attentionService.handleMessage(info, message).catch((error) =>
      console.error(`${LOG_PREFIX} attention message reconciliation failed for ${info.tool}:${info.id}: ${String(error)}`));
  },
  onSessionEnded: (info) => {
    void attentionService.handleSessionEnded(info).catch((error) =>
      console.error(`${LOG_PREFIX} attention session-end reconciliation failed for ${info.tool}:${info.id}: ${String(error)}`));
  },
  onControlTransition: (transition) => {
    console.info(`${LOG_PREFIX} session-control-attention ${JSON.stringify({
      source: `${MACHINE}:${transition.tool}:${transition.sessionId}`,
      path: transition.path,
      from: transition.from,
      to: transition.to,
      cause: transition.cause,
      intentional: transition.intentional === true,
      observedAt: transition.observedAt,
      attentionTransition:
        (transition.from === 'active' || transition.from === 'available') && transition.to === 'unavailable'
          ? 'upsert-sync-degraded'
          : transition.to === 'active' || transition.to === 'available' || transition.to === 'ended'
            ? 'resolve-sync-degraded'
            : 'none',
    })}`);
    void attentionService.handleControlTransition(transition).catch((error) =>
      console.error(`${LOG_PREFIX} sync-degraded reconciliation failed for ${transition.tool}:${transition.sessionId}: ${String(error)}`));
  },
  onObservationLost: (info) => {
    void attentionService.handleObservationLost(info).catch((error) =>
      console.error(`${LOG_PREFIX} attention observation-loss cleanup failed for ${info.tool}:${info.id}: ${String(error)}`));
  },
  onLeaseDenied: () => {
    // The cap is intentionally not an outage. The warning is already visible in Hub logs; health
    // remains reserved for persistence and disk failures.
  },
  onSessionInfo: (info) => {
    rosterPublication.publishOwnerFrame(info);
  },
}, draftStore);
// R0c.1: the ONE qualified roster-publication boundary. Exact managed-connection frames and adapter
// watcher snapshots both journal through it, so an inferred snapshot from a scan that is still
// catching up can never retire (or resurrect) an exact live turn in the roster delta journal.
// Watcher→Hub reconciliation is serialized/coalesced per exact native identity when available;
// complete discovery owns cross-incarnation selection, and generation-less watcher frames cannot
// reverse it. Owner replacement during an in-flight reattach is fenced in Hub.refreshExternalSession.
const nativePublicationAuthority = new NativeIncarnationPublicationAuthority();
const rosterPublication = createRosterPublicationBoundary({
  liveOwners: () => hub.liveSnapshot(),
  publish: (info) => observeRosterViews(hub.projectSessionInfo(info)),
  acceptWatcher: (info) => nativePublicationAuthority.acceptsWatcher(info),
  onWatcherAccepted: rememberLatestSessionInfo,
  reconcile: (info) => hub.refreshExternalSession(decorateSession({ ...info, machine: MACHINE })),
  onReconcileError: (err, info) =>
    console.error(`${LOG_PREFIX} session-info refresh failed for ${info.tool}:${info.id}`, err),
});
wakePush = new WakePushRegistry();
wakeCoalescer = new DeviceWakeCoalescer({
  dispatch: (registration) => dispatchWakePush(registration),
  onError: (error, registration) =>
    console.warn(`${LOG_PREFIX} opaque wake failed for ${registration.deviceId}: ${error instanceof Error ? error.message : String(error)}`),
});
brokerHealthAttention = new BrokerHealthAttentionReconciler({
  attentionService,
  machine: MACHINE,
  requestDirectWake: () => {
    for (const registration of wakePush.listForDispatch()) {
      void wakeCoalescer.request(registration).catch(() => {});
    }
  },
});
attentionScheduler = new AttentionReminderScheduler(attentionService.store, {
  listDeviceIds: () => wakePush.listForDispatch().map((registration) => registration.deviceId),
  dispatchReservation: async (delivery) => {
    const registration = wakePush.get(delivery.deviceId);
    await wakeCoalescer.request(registration);
  },
  onError: (error) =>
    console.warn(`${LOG_PREFIX} attention wake reservation failed: ${error instanceof Error ? error.message : String(error)}`),
});
attentionScheduler.start();

// ── Scheduled sends (part-3 #50) ─────────────────────────────────────────────
// Store + timer loop; delivery/notification wiring lives in deliverScheduledSend /
// recordScheduleOutcomeAttention below (hoisted function declarations).
const scheduleStore = new ScheduleStore({
  onPersistenceError: (error) =>
    console.error(`${LOG_PREFIX} schedule store persistence failed: ${error instanceof Error ? error.message : String(error)}`),
});
const scheduleRunner = new ScheduledSendRunner(scheduleStore, {
  deliver: (schedule) => deliverScheduledSend(schedule),
  onOutcome: (schedule, outcome, error) => recordScheduleOutcomeAttention(schedule, outcome, error),
  onError: (error) =>
    console.warn(`${LOG_PREFIX} scheduled-send runner error: ${error instanceof Error ? error.message : String(error)}`),
});
scheduleRunner.start();
const scheduledConnectionReleaseTimers = new Set<ReturnType<typeof setInterval>>();

/** Runs one scheduled send end-to-end. D6: identical to a composer prompt — attach the way the app
 *  would, pass the SAME control gates, and carry NO model/agent/permissionMode overrides so the
 *  session's current settings apply. Resolution means the prompt reached the agent. */
async function deliverScheduledSend(schedule: ScheduleRecord): Promise<ScheduleDeliveryResult> {
  if (schedule.kind === 'new-session') {
    const backend = registry.get(schedule.tool);
    if (!backend?.createSession) throw new Error(`tool '${schedule.tool}' cannot create sessions`);
    if (schedule.pendingSessionId) {
      // Retry-safe: a target session was already durably created for this occurrence; reuse it rather
      // than multiplying empty sessions after a restart or a failed prompt handoff.
      const info = await discoverSession(schedule.tool, schedule.pendingSessionId);
      const mutated = await sendScheduledPrompt(schedule.tool, schedule.pendingSessionId, info, schedule.text);
      recordAndBroadcastAppMutation(mutated);
      return { createdSessionId: schedule.pendingSessionId };
    }
    await prepareBackendSessionCreation(backend);
    await requireSupportedModelSelection(backend, schedule.model);
    const info = await backend.createSession(
      normalizeCreateSessionOptions({
        directory: schedule.directory,
        title: schedule.title,
        model: schedule.model,
      }),
    );
    safeRecordMetadata('create', () => {
      sessionMetadata.recordAppCreatedSession(info);
      return true;
    });
    // Persist before prompt handoff. If the broker restarts or the prompt handoff fails, retry the
    // same newly created session rather than multiplying empty sessions.
    if (!scheduleStore.recordPendingSession(schedule.id, info.id)) {
      throw new Error('schedule is no longer live after creating its target session');
    }
    const mutated = await sendScheduledPrompt(schedule.tool, info.id, info, schedule.text);
    recordAndBroadcastAppMutation(mutated);
    return { createdSessionId: info.id };
  }
  const id = schedule.sessionId ?? '';
  // Discovery is advisory only (it picks the attach mode the app would pick). A DEFERRED app-created
  // session (e.g. Claude no-prompt create: no transcript until its first prompt) is attachable but
  // not yet on disk — so a discovery miss must not fail the schedule; the attach ladder decides.
  const info = await discoverSession(schedule.tool, id);
  const mutated = await sendScheduledPrompt(schedule.tool, id, info, schedule.text);
  recordAndBroadcastAppMutation(mutated);
  return {};
}

async function sendScheduledPrompt(
  tool: string,
  id: string,
  info: SessionInfo | undefined,
  text: string,
): Promise<SessionInfo> {
  const ensured: (AttachMode | undefined)[] = [];
  const ensure = async (mode: AttachMode | undefined) => {
    const mc = await hub.ensure(tool, id, mode);
    ensured.push(mode);
    return mc;
  };
  // Mode ladder: first the mode the app would use for this session's control state, then the explicit
  // Drive path. hub.ensure() folds a '#resume' request onto a pinned/driving/live base owner, so this
  // can never spawn a rival writer against a synced terminal — it lands on the base conn and the
  // canPrompt gate below answers honestly (e.g. answer-only Claude hooks sync → fail + notify).
  const first = info ? createdSessionAttachMode(info) : undefined;
  const ladder: (AttachMode | undefined)[] = first === 'resume' ? ['resume'] : [first, 'resume'];
  let lastError: unknown;
  for (const mode of ladder) {
    let mc: ManagedConn;
    try {
      mc = await ensure(mode);
    } catch (err) {
      lastError = err;
      continue;
    }
    if (!canPromptSession(mc.conn.info)) {
      lastError = new Error(mc.conn.info.control?.drive.reason || 'this session cannot accept remote prompts right now');
      continue;
    }
    try {
      await mc.conn.sendPrompt({ text });
    } catch (err) {
      for (const m of ensured) hub.release(tool, id, m);
      throw err;
    }
    const fresh = freshestMutationInfo(mc);
    releaseScheduledConnsWhenIdle(tool, id, ensured, mc);
    return fresh;
  }
  for (const mode of ensured) hub.release(tool, id, mode);
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'could not attach the target session'));
}

/** No client ever attaches to a scheduler-owned connection, so the Hub would keep it forever — but
 *  releasing right after sendPrompt would dispose it ~15s later and KILL the turn it just started
 *  (Claude Drive owns the agent process). Hold for at least a minute, then release once the run
 *  leaves 'working' (bounded). release() itself re-acquires an attention lease when a permission or
 *  question is still pending, so a turn that ends in "needs input" stays reachable. */
function releaseScheduledConnsWhenIdle(
  tool: string,
  id: string,
  modes: (AttachMode | undefined)[],
  mc: ManagedConn,
  capMs = 30 * 60_000,
): void {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    if (elapsed < 60_000 || (mc.status === 'working' && elapsed < capMs)) return;
    clearInterval(timer);
    scheduledConnectionReleaseTimers.delete(timer);
    for (const mode of modes) hub.release(tool, id, mode);
  }, 5_000);
  (timer as unknown as { unref?: () => void }).unref?.();
  scheduledConnectionReleaseTimers.add(timer);
}

function scheduleTargetLabel(schedule: ScheduleRecord): string {
  if (schedule.kind === 'new-session') {
    return schedule.title || `new ${schedule.tool} session${schedule.directory ? ` in ${schedule.directory}` : ''}`;
  }
  return schedule.sessionTitle || `${schedule.tool} session ${String(schedule.sessionId ?? '').slice(0, 8)}`;
}

/** D8: failures and misses notify (kind 'scheduled-send-failed' → one-shot push); successes write a
 *  QUIET informational inbox row — silence on success would hide a broken schedule. */
async function recordScheduleOutcomeAttention(
  schedule: ScheduleRecord,
  outcome: ScheduleOutcome,
  error?: string,
): Promise<void> {
  const label = scheduleTargetLabel(schedule);
  const occurrence = schedule.lastFiredAt ?? Date.now();
  const targetSessionId = schedule.kind === 'message'
    ? schedule.sessionId
    : outcome === 'delivered'
      ? schedule.createdSessionId
      : schedule.lastFailedSessionId ?? schedule.pendingSessionId ?? schedule.createdSessionId;
  const action = targetSessionId
    ? { kind: 'open-session' as const, tool: schedule.tool, sessionId: targetSessionId }
    : { kind: 'open-attention-inbox' as const };
  try {
    if (outcome === 'delivered') {
      await attentionService.upsertEvent({
        dedupeKey: `scheduled-send:${schedule.id}:${occurrence}`,
        kind: 'scheduled-send',
        state: 'resolved',
        severity: 'informational',
        title: schedule.kind === 'message' ? 'Scheduled message delivered' : 'Scheduled session started',
        summary: schedule.kind === 'message'
          ? `Scheduled message delivered to ${label}.`
          : `Scheduled session created and its first message sent (${label}).`,
        action,
        agent: schedule.tool,
        sessionId: targetSessionId,
        sessionTitle: schedule.kind === 'message'
          ? schedule.sessionTitle
          : schedule.title,
        presentationRevision: 1,
        presentationStage: 'immediate',
      });
      return;
    }
    await attentionService.upsertEvent({
      dedupeKey: `scheduled-send-failed:${schedule.id}:${occurrence}`,
      kind: 'scheduled-send-failed',
      state: 'resolved',
      severity: 'action-required',
      title: outcome === 'missed' ? 'Scheduled send missed' : 'Scheduled send failed',
      summary: `${outcome === 'missed' ? 'Missed' : 'Failed'}: ${label}${error ? ` — ${error.slice(0, 300)}` : ''}`,
      action,
      agent: schedule.tool,
      sessionId: targetSessionId,
      sessionTitle: schedule.kind === 'message'
        ? schedule.sessionTitle
        : schedule.title,
      presentationRevision: 1,
      presentationStage: 'immediate',
    });
  } catch (err) {
    console.warn(`${LOG_PREFIX} scheduled-send attention write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function scheduleBrokerHealthAttentionReconcile(): void {
  if (!attentionService || !brokerHealthAttention || healthReconcileQueued) return;
  healthReconcileQueued = true;
  queueMicrotask(() => {
    healthReconcileQueued = false;
    void brokerHealthAttention.reconcile(latestBrokerHealth).catch((error) =>
      console.error(`${LOG_PREFIX} broker-health attention reconciliation failed: ${String(error)}`));
  });
}

const tokdashQuotaEvaluator = new TokdashQuotaEvaluator();
async function reconcileTokdashQuota(): Promise<void> {
  const optedIn = getQuotaWarningsEnabled();
  let lifecycle;
  try {
    const state = optedIn ? await fetchTokdashQuota(TOKDASH_URL) : undefined;
    lifecycle = tokdashQuotaEvaluator.evaluate(state, { optedIn });
  } catch (error) {
    lifecycle = tokdashQuotaEvaluator.evaluate(undefined, { optedIn });
    console.warn(`${LOG_PREFIX} Tokdash quota snapshot unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const activeKeys = new Set(lifecycle.active.map((warning) => `usage-threshold:${warning.id}`));
  for (const warning of lifecycle.active) {
    await attentionService.upsertEvent({
      dedupeKey: `usage-threshold:${warning.id}`,
      kind: 'usage-threshold',
      state: 'active',
      severity: 'maintenance',
      title: 'Quota running low',
      summary: warning.estimated
        ? 'A five-hour or weekly quota is low (estimated from local data).'
        : 'A five-hour or weekly quota is low.',
      action: { kind: 'open-quota-settings' },
      presentationRevision: 1,
      presentationStage: 'immediate',
    });
  }
  for (const warning of lifecycle.resolved) {
    await attentionService.resolveByDedupeKey(`usage-threshold:${warning.id}`);
  }
  // A broker restart or opt-out starts with an empty in-memory evaluator; reconcile durable rows too.
  for (const event of attentionService.store.listActive()) {
    if (event.kind === 'usage-threshold' && !activeKeys.has(event.dedupeKey)) {
      await attentionService.resolveByDedupeKey(event.dedupeKey);
    }
  }
}

brokerHealth.sampleCapacity();
brokerHealth.sampleCanaries();
brokerHealth.sampleDiagnostics();
const brokerHealthCapacityTimer = setInterval(() => brokerHealth.sampleCapacity(), 60_000);
const brokerHealthCanaryTimer = setInterval(() => brokerHealth.sampleCanaries(), 5 * 60_000);
const brokerHealthDiagnosticsTimer = setInterval(() => brokerHealth.sampleDiagnostics(), 60_000);
brokerHealthCapacityTimer.unref?.();
brokerHealthCanaryTimer.unref?.();
brokerHealthDiagnosticsTimer.unref?.();

const tokdashQuotaPollMs = Math.max(60_000, envNumber('COSYNCING_TOKDASH_QUOTA_POLL_MS', 10 * 60_000));
void reconcileTokdashQuota().catch((error) =>
  console.warn(`${LOG_PREFIX} initial Tokdash quota reconciliation failed: ${String(error)}`));
const tokdashQuotaTimer = setInterval(() => {
  void reconcileTokdashQuota().catch((error) =>
    console.warn(`${LOG_PREFIX} Tokdash quota reconciliation failed: ${String(error)}`));
}, tokdashQuotaPollMs);
tokdashQuotaTimer.unref?.();
// On a bridge teardown the registry calls back here to evict it from the Hub — which fans a clean
// `ended` frame to the attached phone before disposing (the reload/fork orphan fix). The grace window
// (how long a reload's bye is held open for the same-id re-hello) is overridable for fast tests.
const piBridge = new PiBridgeRegistry(
  (id, reason) => hub.evict('pi', id, reason),
  Number(process.env.COSYNCING_BRIDGE_GRACE_MS ?? 4000),
);
const piBridgeSweepTimer = setInterval(() => {
  const stale = piBridge.sweepStale(Date.now(), 60_000);
  if (stale.length) console.warn(`${LOG_PREFIX} removed ${stale.length} stale Pi bridge connection(s)`);
}, 30_000);
piBridgeSweepTimer.unref?.();
const uploadStaging = new UploadStaging({ maxBytes: UPLOAD_MAX_BYTES });
const uploadGcTimer = setInterval(() => uploadStaging.sweepExpired(), 60 * 60 * 1000);
uploadGcTimer.unref?.();
// Claude live-sync via HOOKS (Tier-1; replaces the archived claude/channel). An in-session PreToolUse hook
// relays permission/question prompts here and blocks for the phone's answer. Same adopt/evict lifecycle.
const claudeHooks = new ClaudeHooksRegistry(
  (id, reason) => hub.evict('claude', id, reason),
  Number(process.env.COSYNCING_BRIDGE_GRACE_MS ?? 4000),
);
function claudeHooksInfo(b: any, id: string, transcriptPath?: string): SessionInfo {
  const cwd = b?.cwd ? String(b.cwd) : undefined;
  const title = b?.title ? String(b.title) : cwd ? (cwd.split('/').filter(Boolean).pop() ?? 'Claude session') : 'Claude session';
  // maintainer hard-requirement (issues-todo §"Model selector / effort / permission level" + doc-14): model and
  // permission mode must ALWAYS be shown for a synced session — locked, not hidden. Read the authoritative
  // current values from the transcript tail (the same source the Observe path uses); answer-only sync can't
  // inject /model or /mode, so the app keeps the pickers read-only. Emit NO value when the tool can't report
  // one (never invent a default) — effort isn't in the transcript tail, so it's intentionally omitted.
  const liveModel = (typeof b?.model === 'string' && b.model) ? b.model : (transcriptPath ? readLatestModel(transcriptPath) : undefined);
  const liveEffort = typeof b?.effort === 'string' && b.effort ? b.effort : undefined;
  const liveMode = transcriptPath ? readLatestPermissionMode(transcriptPath) : undefined;
  return {
    id, tool: 'claude', machine: MACHINE, title, cwd, status: 'idle', attachMode: 'live',
    ...(liveModel ? { currentModel: { providerID: 'anthropic', modelID: String(liveModel), ...(liveEffort ? { reasoningEffort: liveEffort } : {}) } } : {}),
    ...(liveMode ? { currentMode: liveMode } : {}),
    control: {
      drive: { supported: false, state: 'unavailable', reason: `This Claude session is synced through ${PRODUCT_IDENTITY.productName} hooks — answer prompts and questions here.` },
      // answer-only: the hook can answer permission/question prompts but there is no live-prompt-inject path
      // (the channel was the only one, and it's archived) → the app keeps the composer read-only, cards active.
      terminalSync: { supported: true, syncAvailable: true, active: true, input: 'answer-only', label: 'Synced via hooks', note: `Connected through the ${PRODUCT_IDENTITY.productName} PreToolUse hook; answer its permission prompts and questions here.` },
    },
  };
}
// Contributor-only source harness. Packaged v1 ignores COSYNCING_CLAUDE_HOOKS even when inherited from an
// older development environment; source runs additionally require the explicit D14 development bypass.
if (CLAUDE_HOOKS_DEV_ENABLED && process.env.COSYNCING_CLAUDE_HOOKS && process.env.COSYNCING_CLAUDE_HOOKS !== '0') {
  try {
    const { path } = installClaudeHooks({ brokerUrl: BROKER_URL });
    console.log(`${LOG_PREFIX} Claude live-sync hooks installed → ${path} (broker ${BROKER_URL})`);
  } catch (e) {
    console.error(`${LOG_PREFIX} failed to install Claude live-sync hooks`, e);
  }
}

/** Get-or-create the pinned hooks connection for a session, adopting it into the Hub on first sight (so the
 *  roster shows it synced and a phone attach reuses it — same model as the Pi bridge). */
function ensureClaudeHooksConn(id: string, transcriptPath: string, b: any) {
  const existing = claudeHooks.get(id);
  if (existing) return existing;
  const conn = claudeHooks.hello(id, claudeHooksInfo(b, id, transcriptPath), transcriptPath);
  hub.adopt('claude', id, conn);
  return conn;
}

const latestSessionInfoByKey = new Map<string, SessionInfo>();
const MAX_LATEST_SESSION_INFO = 1024;
const latestSessionKey = (tool: string, id: string): string => `${tool}\0${id}`;

function rememberLatestSessionInfo(info: SessionInfo): void {
  const keys = [
    latestSessionKey(info.tool, info.id),
    ...(info.nativeId ? [latestSessionKey(info.tool, info.nativeId)] : []),
  ];
  for (const key of keys) latestSessionInfoByKey.set(key, structuredClone(info));
  while (latestSessionInfoByKey.size > MAX_LATEST_SESSION_INFO) {
    const oldest = latestSessionInfoByKey.keys().next().value;
    if (!oldest) break;
    latestSessionInfoByKey.delete(oldest);
  }
}

function cachedSessionInfoForMutation(info: SessionInfo): SessionInfo[] {
  const candidates = [
    latestSessionInfoByKey.get(latestSessionKey(info.tool, info.nativeId || info.id)),
    latestSessionInfoByKey.get(latestSessionKey(info.tool, info.id)),
  ];
  return candidates.filter((candidate): candidate is SessionInfo => Boolean(candidate));
}

const sessionInfoWatchers = registry.list().map((backend) =>
  backend.watchSessionInfo?.((info) => {
    // Never journal or reconcile the raw inferred snapshot directly: the qualified publication
    // boundary native-qualifies it first, updates bounded caches only after admission, and
    // serializes/coalesces the Hub refresh per native incarnation identity.
    rosterPublication.submitWatcherSnapshot(info);
  }),
).filter(Boolean);
void sessionInfoWatchers;

/** A session id matching the Pi adapter's encoding: base64url of the canonical session-file path.
 *  `realpathSync(resolve(...))` collapses both ordinary spelling drift and symlinked session roots so
 *  the extension-reported path and disk discovery produce ONE row. Missing files fall back to
 *  `resolve()` because a bridge may hello before the JSONL is materialized. */
function canonicalPiSessionFile(sessionFile: string): string {
  const resolved = resolve(sessionFile);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}
const bridgeId = (sessionFile: string): string => Buffer.from(canonicalPiSessionFile(sessionFile), 'utf8').toString('base64url');
const piBridgeFiles = new Map<string, string>();
const piBridgeAliases = new Map<string, string>();

function resolvePiBridgeAlias(id: string): string {
  let cur = id;
  const seen = new Set<string>();
  while (piBridgeAliases.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    cur = piBridgeAliases.get(cur)!;
  }
  return cur;
}

function rememberPiBridgeFile(id: string, sessionFile: string): void {
  piBridgeFiles.set(id, sessionFile);
}

function canonicalizePiBridgeId(id: string): string {
  const current = resolvePiBridgeAlias(id);
  const sessionFile = piBridgeFiles.get(current);
  if (!sessionFile) return current;
  const canonical = bridgeId(sessionFile);
  if (canonical === current) return current;
  const conn = piBridge.rekey(current, canonical);
  if (!conn) return current;
  piBridgeFiles.delete(current);
  piBridgeFiles.set(canonical, sessionFile);
  piBridgeAliases.set(current, canonical);
  hub.rekey('pi', current, canonical);
  return canonical;
}

function canonicalizePiBridgeIds(): void {
  for (const id of [...piBridgeFiles.keys()]) canonicalizePiBridgeId(id);
}

function normalizeCreateDirectory(input: unknown): string {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return os.homedir();
  if (raw.includes('\0')) throw new Error('directory contains a NUL byte');
  const expanded = raw === '~'
    ? os.homedir()
    : /^~[\\/]/.test(raw)
      ? resolve(os.homedir(), raw.slice(2))
      : raw;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(os.homedir(), expanded);
}

function normalizeModelSelection(value: unknown): ModelSelection | undefined {
  if (value == null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('model must be an object');
  }
  const raw = value as Record<string, unknown>;
  const providerID =
    typeof raw.providerID === 'string' ? raw.providerID.trim() : '';
  const modelID = typeof raw.modelID === 'string' ? raw.modelID.trim() : '';
  if (!providerID || !modelID) {
    throw new Error('model.providerID and model.modelID are required');
  }
  if (
    providerID.length > 256 ||
    modelID.length > 256 ||
    (typeof raw.variant === 'string' && raw.variant.length > 256) ||
    (typeof raw.reasoningEffort === 'string' &&
      raw.reasoningEffort.length > 64)
  ) {
    throw new Error('model identity is too long');
  }
  const variant =
    typeof raw.variant === 'string' && raw.variant.trim()
      ? raw.variant.trim()
      : undefined;
  const reasoningEffort =
    typeof raw.reasoningEffort === 'string' && raw.reasoningEffort.trim()
      ? raw.reasoningEffort.trim()
      : undefined;
  return {
    providerID,
    modelID,
    ...(variant ? { variant } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

const MAX_CREATION_MODEL_OPTIONS = 2048;

class ModelCatalogUnavailableError extends Error {
  override readonly name = 'ModelCatalogUnavailableError';
}

function boundedModelCatalog(models: readonly ModelOption[]): ModelOption[] {
  const unique = new Map<string, ModelOption>();
  for (const model of models.slice(0, MAX_CREATION_MODEL_OPTIONS)) {
    if (!model?.providerID || !model?.modelID || !model?.label) continue;
    const key = `${model.providerID}\0${model.modelID}\0${model.variant ?? ''}`;
    if (!unique.has(key)) unique.set(key, model);
  }
  return [...unique.values()];
}

function modelSelectionSupported(
  selection: ModelSelection,
  models: readonly ModelOption[],
): boolean {
  const option = models.find(
    (candidate) =>
      candidate.providerID === selection.providerID &&
      candidate.modelID === selection.modelID &&
      candidate.variant === selection.variant,
  );
  if (!option) return false;
  if (!selection.reasoningEffort) return true;
  return (
    option.reasoningEfforts?.some(
      (effort) => effort.effort === selection.reasoningEffort,
    ) ?? false
  );
}

async function modelCatalogForCreation(
  backend: {
    listModels?: () => Promise<ModelOption[]>;
  },
): Promise<ModelOption[]> {
  if (!backend.listModels) {
    throw new ModelCatalogUnavailableError(
      'this tool does not expose a model catalog',
    );
  }
  try {
    return boundedModelCatalog(await backend.listModels());
  } catch (error) {
    throw new ModelCatalogUnavailableError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function requireSupportedModelSelection(
  backend: {
    listModels?: () => Promise<ModelOption[]>;
  },
  selection: ModelSelection | undefined,
): Promise<void> {
  if (!selection) return;
  const models = await modelCatalogForCreation(backend);
  if (!modelSelectionSupported(selection, models)) {
    const error = new Error(
      `selected model '${selection.providerID}/${selection.modelID}' is no longer available`,
    );
    error.name = 'ModelSelectionUnsupportedError';
    throw error;
  }
}

async function prepareBackendSessionCreation(backend: {
  id: string;
  displayName: string;
  prepareCreateSession?: () => Promise<void>;
  canCreateSession?: () => Promise<boolean> | boolean;
}): Promise<void> {
  await backend.prepareCreateSession?.();
  if (typeof backend.canCreateSession === 'function'
      && !(await Promise.resolve(backend.canCreateSession()).catch(() => false))) {
    throw new SessionCreateTemporarilyUnavailableError(
      `${backend.displayName} is temporarily unavailable for session creation. Run \`cosyncing doctor\` for setup guidance.`,
      `${backend.id}-create-readiness-unavailable`,
    );
  }
}

function normalizeCreateSessionOptions(body: any): {
  directory: string;
  title?: string;
  model?: ModelSelection;
} {
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const model = normalizeModelSelection(body?.model);
  return {
    directory: normalizeCreateDirectory(body?.directory),
    ...(title ? { title } : {}),
    ...(model ? { model } : {}),
  };
}

const metadataErrorLogAt = new Map<string, number>([['create', 0], ['mutate', 0]]);

const METADATA_ERROR_THROTTLE_MS = 5000;
let metadataBroadcastErrorAt = 0;

function safeRecordMetadata(label: 'create' | 'mutate', work: () => boolean): boolean {
  try {
    return work();
  } catch (err) {
    const now = Date.now();
    const last = metadataErrorLogAt.get(label) ?? 0;
    if (now - last < METADATA_ERROR_THROTTLE_MS) return false;
    metadataErrorLogAt.set(label, now);
    console.error(`${LOG_PREFIX} metadata persistence failed (${label}): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function clearDivergenceOnSharedRejoin(info: SessionInfo): boolean {
  return safeRecordMetadata('mutate', () => {
    return sessionMetadata.clearPrivateMutationEvidenceOnSharedRejoin(info);
  });
}

function decorateSession(info: SessionInfo): SessionInfo {
  clearDivergenceOnSharedRejoin(info);
  return sessionMetadata.apply({ ...info, machine: MACHINE });
}

/**
 * Refresh presence at the mutation boundary from the broker's latest watcher/roster snapshot only.
 * This path is deliberately synchronous: normal prompt completion must not start a rollout scan or
 * wait on presence I/O. Only explicit cached presence is overlaid, so stale/unknown data can
 * under-claim divergence but never invent private ownership.
 */
function freshestMutationInfo(mc: ManagedConn): SessionInfo {
  const base = mc.conn.info;
  return overlayFreshTerminalPresence(base, cachedSessionInfoForMutation(base));
}

function recordAndBroadcastAppMutation(info: SessionInfo): void {
  const changed = safeRecordMetadata('mutate', () => {
    return sessionMetadata.recordAppMutation(info);
  });
  if (!changed) return;
  const predicate = (observed: SessionInfo): boolean =>
    observed.tool === info.tool && (observed.id === info.id || (!!info.nativeId && observed.nativeId === info.nativeId));
  try {
    hub.broadcastSessionWhere(predicate, decorateSession);
  } catch (err) {
    const now = Date.now();
    if (now - metadataBroadcastErrorAt < METADATA_ERROR_THROTTLE_MS) return;
    metadataBroadcastErrorAt = now;
    console.warn(`${LOG_PREFIX} session broadcast failed after app mutation: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function recordAndBroadcastManagedAppMutation(mc: ManagedConn): void {
  recordAndBroadcastAppMutation(freshestMutationInfo(mc));
}

// Roster discovery cache + single-flight: N concurrent /api/sessions polls (one per open tab, every
// 6s) share ONE full-disk discovery instead of each starting their own. The cached array is never
// mutated — /api/sessions copies each row before overlaying live state.
type RosterDiscoveryCache = { at: number; sessions: SessionInfo[] };
const rosterCaches = new Map<string, RosterDiscoveryCache>();
const rosterInflight = new Map<string, Promise<SessionInfo[]>>();
type RosterRepresentation = {
  revision: number;
  etag: string;
  expiresAt?: number;
  data: { machine: string; machineId: string; generatedAt: number; revision: number; sessions: SessionInfo[] };
};
const rosterRepresentations = new Map<string, RosterRepresentation>();
const rosterSafetyReconciledAt = new Map<string, number>();

function rosterWindowKey(raw: string | null): string {
  return raw === '1d' || raw === '7d' || raw === '1m' || raw === '2m' || raw === '6m' ? raw : 'all';
}

async function safetyReconcileRoster(windowMs: number | undefined, now: number): Promise<boolean> {
  const key = windowMs === undefined ? 'all' : String(windowMs);
  const reconciledAt = rosterSafetyReconciledAt.get(key) ?? 0;
  const cutoffExpired =
    windowMs !== undefined &&
    (rosterWindowExpiresAt.get(windowMs) ?? Number.POSITIVE_INFINITY) <= now;
  if (!cutoffExpired && now - reconciledAt < ROSTER_SAFETY_RECONCILE_MS) return false;
  rosterSafetyReconciledAt.set(key, now);
  await discoverLocalSessions(true, windowMs, now);
  return true;
}

function discoverAllCached(force = false, windowMs?: number, now = Date.now()): Promise<SessionInfo[]> {
  const key = windowMs === undefined ? 'all' : String(windowMs);
  const cached = rosterCaches.get(key);
  if (!force && cached && now - cached.at < ROSTER_TTL_MS) return Promise.resolve(cached.sessions);
  const pending = rosterInflight.get(key);
  if (pending) return pending;
  const request = registry
    .discoverAll(windowMs === undefined ? undefined : { updatedAfter: now - windowMs })
    .then((sessions) => {
      rosterSafetyReconciledAt.set(key, Date.now());
      for (const session of sessions) rememberLatestSessionInfo(session);
      rosterCaches.set(key, { at: Date.now(), sessions });
      return sessions;
    })
    .finally(() => {
      rosterInflight.delete(key);
    });
  rosterInflight.set(key, request);
  return request;
}

async function discoverSession(tool: string, id: string): Promise<SessionInfo | undefined> {
  const live = hub.getConn(tool, id)?.conn.info;
  if (live) return live;
  const backend = registry.get(tool);
  if (!backend || !(await backend.isAvailable().catch(() => false))) return undefined;
  return (await backend.discoverSessions().catch(() => [])).find((s) => s.id === id);
}

async function discoverLocalSessions(
  force = false,
  windowMs?: number,
  now = Date.now(),
): Promise<SessionInfo[]> {
  canonicalizePiBridgeIds();
  const sessions = (await discoverAllCached(force, windowMs, now)).map((s) => ({ ...s, machine: MACHINE }));
  // A native runtime may replace the adapter id while retaining one exact native identity (Claude
  // bridge continuation is the measured case). Retire every superseded Hub owner and remove its
  // journal row before the replacement can be owner-overlaid or published. This is capability-
  // generic and never consults title/cwd/content/time.
  const canonicalReplacements = nativePublicationAuthority.reconcile(sessions);
  const retiredOwners = await hub.retireSupersededOwners(canonicalReplacements);
  for (const retired of retiredOwners) {
    rosterRevision.remove(MACHINE, retired.tool, retired.id);
    for (const store of rosterWindowRevisions.values()) {
      store.remove(MACHINE, retired.tool, retired.id);
    }
    latestSessionInfoByKey.delete(latestSessionKey(retired.tool, retired.id));
  }
  // Overlay the broker's LIVE view onto disk discovery: a session we currently own (a pinned Pi
  // bridge, or any attached session) reflects its true live attach mode and floats up as
  // 'working' while a turn runs — otherwise a live-bridged Pi shows idle/resume from disk alone.
  // Capability-driven (reads each owned connection's SessionInfo), never a per-tool branch.
  const byKey = new Map(sessions.map((s) => [`${s.tool}:${s.id}`, s]));
  // Reduce every live owner of a session to ONE authoritative owner BEFORE applying anything.
  // Otherwise a read-only Observe wrapper and a Drive wrapper both write, and Map iteration order
  // decides whether the roster ends up 'working' or 'idle' (R0b).
  for (const owner of authoritativeLiveOwners(hub.liveSnapshot()).values()) {
    const { info, status } = owner;
    const existing = byKey.get(`${info.tool}:${info.id}`);
    if (existing) {
      // Control-claim gating and single run-state authority live in overlayAuthoritativeOwner —
      // the SAME rule the watcher publication boundary applies (R0c.1), so discovery reconcile and
      // watcher publication cannot journal different rows for the same state (R0b rationale in the
      // helper's doc comment).
      overlayAuthoritativeOwner(existing, owner);
    } else {
      // Live but not (yet) on disk — surface it so a brand-new bridged session isn't missing.
      sessions.push({ ...info, machine: MACHINE, status });
    }
  }
  const decorated = sessionMetadata
    .applyAll(sessions.map((s) => ({ ...s, machine: MACHINE })))
    .map((session) => hub.projectSessionInfo(session));
  for (const session of decorated) rememberLatestSessionInfo(session);
  decorated.sort((a, b) => statusRank(a) - statusRank(b) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  if (windowMs === undefined) {
    rosterRevision.reconcile(decorated, MACHINE);
  } else {
    // Each bounded representation owns an independent journal. Absence here
    // means deletion or age-out from THIS view only; it must never remove the
    // row from the authoritative all-time journal.
    rosterRevisionForWindow(windowMs).reconcile(decorated, MACHINE);
    const expiresAt = sessionWindowRepresentationExpiry(decorated, windowMs);
    if (expiresAt === undefined) rosterWindowExpiresAt.delete(windowMs);
    else rosterWindowExpiresAt.set(windowMs, expiresAt);
  }
  return decorated;
}

async function discoverMachineRosters(
  visibility: RosterVisibility,
): Promise<AggregatedMachines> {
  const generatedAt = Date.now();
  // Filtered here rather than at the route, because the aggregate contains this
  // machine's sessions AND every peer's: a client that cannot decode an agent
  // must not receive its sessions from any of them. Peers are asked as a
  // current client (see `fetchPeerMachineRoster`), so what arrives is everything
  // this broker can decode, and this narrows it to what the CALLER can.
  const local = localMachineRoster(
    MACHINE, visibleSessions(await discoverLocalSessions(), visibility), undefined, generatedAt,
  );
  const peers = (await Promise.all(MACHINE_PEER_CONFIG.peers.map((peer) => fetchPeerMachineRoster(peer))))
    .map((peer) => ({
      ...peer,
      sessions: visibleSessions(peer.sessions, visibility),
      sessionCount: visibleSessions(peer.sessions, visibility).length,
    }));
  const machines = [local, ...peers];
  if (MACHINE_PEER_CONFIG.error) {
    machines.push({
      machineId: 'configured-peer',
      machine: 'configured-peer',
      role: 'peer',
      status: 'degraded',
      sessions: [],
      sessionCount: 0,
      checkedAt: generatedAt,
      freshness: 'unknown',
      code: 'MACHINE_PEER_BAD_CONFIG',
      error: MACHINE_PEER_CONFIG.error,
    });
  }
  return aggregatedMachines(MACHINE, machines, generatedAt);
}

function createdSessionAttachMode(info: SessionInfo): AttachMode | undefined {
  // A live-only adapter needs an explicit #live owner: a bare connection is
  // shared with background Observe clients and therefore cannot carry socket-
  // local mutation authority. Returning the session's live instruction here
  // lets the create response bridge that intent to exactly one foreground
  // client attach. Existing live adapters are unchanged semantically; Hub
  // folds #live onto an already-established canonical live owner.
  if (info.attachMode === 'live') return 'live';
  const control = info.control;
  if (control?.terminalSync.active || control?.drive.state === 'driving') return undefined;
  if (control?.drive.supported && control.drive.state === 'observing') return 'resume';
  return info.attachMode === 'resume' ? 'resume' : undefined;
}

function parseWsClientContract(searchParams: URLSearchParams): {
  client?: ClientContractIdentity;
  clientVersion?: string;
  error?: string;
} {
  const revisionRaw = searchParams.get('contractRevision');
  const minimumRaw = searchParams.get('minimumBrokerRevision');
  const surfaceHash = searchParams.get('contractSurfaceHash')?.trim() || undefined;
  const clientVersion = searchParams.get('clientVersion')?.trim() || undefined;
  if (revisionRaw == null) {
    if (minimumRaw != null || surfaceHash) return { error: 'contractRevision is required with contract metadata' };
    if (clientVersion && (clientVersion.length > 64 || /[\0\r\n]/.test(clientVersion))) {
      return { error: 'clientVersion must be a short printable value' };
    }
    return { ...(clientVersion ? { clientVersion } : {}) };
  }
  const revision = Number(revisionRaw);
  const minimumBrokerRevision = minimumRaw == null ? 0 : Number(minimumRaw);
  if (!Number.isSafeInteger(revision) || revision < 0
      || !Number.isSafeInteger(minimumBrokerRevision) || minimumBrokerRevision < 0
      || (surfaceHash && !/^fnv1a32:[a-f0-9]{8}$/.test(surfaceHash))
      || (clientVersion && (clientVersion.length > 64 || /[\0\r\n]/.test(clientVersion)))) {
    return { error: 'client contract metadata is invalid' };
  }
  return {
    client: { revision, minimumBrokerRevision, ...(surfaceHash ? { surfaceHash } : {}) },
    ...(clientVersion ? { clientVersion } : {}),
  };
}

/**
 * The contract revision a `/api/agents` caller claims, for roster filtering.
 *
 * Deliberately NOT the strict `parseWsClientContract`. That one rejects partial
 * metadata because a socket carrying half a contract identity is a client bug
 * worth failing loudly. Here the question is only "how much can you decode",
 * and every unclear answer has the same safe reading: assume the least. A
 * missing parameter is a client built before it existed, and a malformed one
 * tells us nothing — both get the legacy-safe view, which shows FEWER agents
 * and never more.
 *
 * Refusing the request instead would be worse than useless: a roster that 400s
 * over a query parameter costs the caller every agent, which is the exact
 * failure this filtering exists to prevent.
 */
function parseAgentRosterClientRevision(searchParams: URLSearchParams): number {
  const raw = searchParams.get('contractRevision');
  // A canonical non-negative decimal integer and nothing else. `Number` alone
  // would be a far wider grammar than "malformed means oldest" implies — it
  // reads `0xF`, `1e2`, `+14`, and whitespace-padded digits as numbers — and
  // every one of those is a client whose encoding we do not recognize claiming
  // a decode ability we would then act on. The only revisions this broker
  // honors are the ones a client can state plainly.
  if (raw == null || !/^(?:0|[1-9][0-9]*)$/.test(raw)) return 0;
  const revision = Number(raw);
  return Number.isSafeInteger(revision) ? revision : 0;
}

function parseInitialHistoryLimit(searchParams: URLSearchParams): number {
  const raw = searchParams.get('initialHistory');
  if (raw == null) {
    return HISTORY_MAX_MESSAGES;
  }
  const requested = Number(raw);
  if (!Number.isFinite(requested) || !Number.isInteger(requested) || requested <= 0) {
    return HISTORY_MAX_MESSAGES;
  }
  return requested > HISTORY_MAX_MESSAGES ? HISTORY_MAX_MESSAGES : requested;
}

interface WsData {
  tool: string;
  id: string;
  /** Attach mode from `?mode=` (default observe). `resume` opens a DRIVABLE connection (own Hub owner)
   *  — entered only on explicit user action ("Drive"), so opening a session never auto-drives it. */
  mode?: string;
  /** Authenticated drive-attach intent from `?reason=`. Drive modes only, and
   *  per the reason/mode matrix: every reason with `resume`, and `takeover`
   *  alone with `live` (see `DRIVE_ATTACH_REASONS`). */
  reason?: DriveAttachReason;
  /** Exact owner projection an authenticated `join-existing` request is conditional on. */
  expectedOwnerRevision?: SessionOwnerRevision;
  /** Browser cache cursor; broker returns only newer durable history when valid. */
  since?: string;
  /** Requested initial durable-history tail (defaults to broker max when omitted). */
  historyLimit?: number;
  /** New clients request artifact refs; old clients omit it and receive inline adapter artifacts. */
  artifactMode?: 'inline' | 'reference';
  /** Credential-scoped, non-secret durable journal namespace. */
  identity: string;
  /** Credential/profile/incarnation-scoped staged-upload namespace. */
  uploadIdentity: string;
  /** Negotiated before the Hub attach; hard incompatibility forces this socket to Observe. */
  compatibility: BrokerClientCompatibility;
  /** The client asked for a read-only socket (`?readOnly=1`) because it cannot
   *  reason about this session's attach mode. The ENFORCEMENT lives in
   *  {@link compatibility}, which this folds into during the upgrade; the flag
   *  records only WHY, so a refusal can say so accurately instead of blaming a
   *  contract mismatch that did not happen. */
  readOnlyRequested: boolean;
  /** An actual shared/peer credential was supplied; loopback's credential-less baseline is false. */
  credentialAuthenticated: boolean;
  clientVersion?: string;
  client?: Client;
  mc?: ManagedConn;
  /** True once attach finished (session+history sent); gates inbound prompts. */
  ready?: boolean;
  /** Client→broker messages that arrived before attach finished (replayed when ready). */
  pendingInbound?: string[];
  /** Serializes PROMPTS so they reach the agent in order (and spaced — see routeInbound). */
  sendChain?: Promise<void>;
  /** Ordinary controls stay concurrent; handoff alone is an exclusive socket boundary. */
  handoffSequencer?: ClientHandoffSequencer;
  /** Timestamp of the last prompt sent, to space rapid sends (opencode reorders <~250ms apart). */
  lastPromptAt?: number;
  /** Cancels the bounded attach-time picker refresh as soon as this socket closes. */
  sessionOptionsAbort?: AbortController;
  /** Stable source revision that exceeded the bounded history cache. Repeated
   * pages fail closed until that source changes instead of reparsing it. */
  historyPagingUnavailableSource?: HistorySourceIdentity;
  /** True when a truncated source has no trustworthy revision probe. */
  historyPagingUnavailableWithoutIdentity?: boolean;
}

const MIN_PROMPT_GAP_MS = 350;
const historyPageCaches = new HistoryPageCachePool();

function historyPageCacheScope(
  tool: string,
  id: string,
  artifactMode: 'inline' | 'reference' | undefined,
): string {
  return createHash('sha256')
    .update(tool)
    .update('\0')
    .update(id)
    .update('\0')
    .update(artifactMode ?? 'inline')
    .digest('base64url');
}

async function readHistorySourceIdentity(
  connection: SessionConnection,
): Promise<HistorySourceIdentity | undefined> {
  try {
    const identity = await connection.getHistorySourceIdentity?.();
    if (
      !identity
      || typeof identity.sourceId !== 'string'
      || identity.sourceId.length === 0
      || typeof identity.revision !== 'string'
      || identity.revision.length === 0
      || (identity.appendPosition !== undefined
        && (!Number.isSafeInteger(identity.appendPosition)
          || identity.appendPosition < 0))
    ) return undefined;
    return Object.freeze({ ...identity });
  } catch {
    return undefined;
  }
}

function sameHistorySourceRevision(
  left: HistorySourceIdentity | undefined,
  right: HistorySourceIdentity | undefined,
): left is HistorySourceIdentity {
  return Boolean(
    left
    && right
    && left.revision === right.revision
    && historySourceStillContainsSnapshot(left, right),
  );
}

async function readNativeHistory(
  connection: SessionConnection,
  artifactMode: 'inline' | 'reference' | undefined,
  reason: 'attach' | 'page-cache-miss',
): Promise<AgentMessage[]> {
  if (process.env.COSYNCING_TEST_HISTORY_READ_METRICS === '1') {
    console.error(`[h1-history-read] ${reason} ${connection.info.tool}:${connection.info.id}`);
  }
  return connection.getHistory({ artifactMode }).catch(() => []);
}

function seedHistoryPageCache(options: {
  scope: string;
  sourceBefore?: HistorySourceIdentity;
  sourceAfter?: HistorySourceIdentity;
  history: AgentMessage[];
}): boolean {
  const { scope, sourceBefore, sourceAfter, history } = options;
  if (!sameHistorySourceRevision(sourceBefore, sourceAfter)) {
    return false;
  }
  const cached = historyPageCaches.get(scope, sourceAfter!);
  if (
    cached
    && sameHistorySourceIdentity(cached.sourceIdentity, sourceAfter!)
  ) {
    return true;
  }
  const cache = EncodedHistoryPageCache.create(sourceBefore, history);
  if (!cache || !historyPageCaches.put(scope, cache)) {
    return false;
  }
  return true;
}

/**
 * Why one page-cache build did not produce a cache (H1b).
 *
 * These used to be one `undefined`, which the socket then reported as
 * `HISTORY_PAGE_RESOURCE_LIMIT` and remembered as permanently unavailable. An
 * active Codex rollout appends while it is being indexed, so an ordinary append
 * read as "this history is too large" and poisoned paging for the connection.
 */
type HistoryPageCacheOutcome =
  /** A usable index for the requested source. */
  | { kind: 'cache'; cache: HistoryPageCache }
  /** The source moved while it was being read. Transient: retry is meaningful. */
  | { kind: 'source-changed' }
  /** Measured entry/count/byte overflow. Terminal for this source revision. */
  | { kind: 'resource-limit' };

/**
 * Read one immutable native prefix and index it, or say precisely why not.
 *
 * When the adapter can capture a prefix ({@link SessionConnection.captureHistorySnapshot}) the
 * identity and the messages come from the same observation by construction, so an append during the
 * read is not even visible here. The messages are encoded into the paging budget as they arrive, so
 * that budget is what stops an oversized source — during the read, not after it. Otherwise the
 * two-probe fallback still detects a moving source, and now reports it as transient rather than as
 * a resource limit.
 */
async function readHistoryPagePrefix(options: {
  source: HistorySourceIdentity;
  connection: SessionConnection;
  artifactMode: 'inline' | 'reference' | undefined;
}): Promise<HistoryPageCacheOutcome> {
  const { source, connection, artifactMode } = options;
  if (typeof connection.captureHistorySnapshot === 'function') {
    if (process.env.COSYNCING_TEST_HISTORY_READ_METRICS === '1') {
      console.error(`[h1-history-read] page-cache-miss ${connection.info.tool}:${connection.info.id}`);
    }
    const indexedBuilder = new IndexedHistoryPageCacheBuilder();
    const captured = await Promise.resolve(connection.captureHistorySnapshot(indexedBuilder, { artifactMode }))
      .catch(() => undefined);
    if (!captured) return { kind: 'source-changed' };
    // Either side may have measured the overflow: the adapter's own source bound, or this builder
    // refusing further messages. Both are terminal for this source — the next request reads the
    // same bytes, so reporting it as transient is an infinite retry.
    if (isHistorySnapshotRefusal(captured) || indexedBuilder.exceededBudget) {
      return { kind: 'resource-limit' };
    }
    // The captured prefix must still be one the requested cursor space belongs to. An append beyond
    // it is fine; a rewrite or shrink is not.
    if (
      !historySourceStillContainsSnapshot(captured.identity, source)
      && !historySourceStillContainsSnapshot(source, captured.identity)
    ) {
      return { kind: 'source-changed' };
    }
    const cache = indexedBuilder.finish(captured.identity, captured.reader);
    return cache ? { kind: 'cache', cache } : { kind: 'resource-limit' };
  }
  const history = await readNativeHistory(connection, artifactMode, 'page-cache-miss');
  const sourceAfter = await readHistorySourceIdentity(connection);
  if (!sameHistorySourceRevision(source, sourceAfter)) return { kind: 'source-changed' };
  const cache = EncodedHistoryPageCache.create(source, history);
  return cache ? { kind: 'cache', cache } : { kind: 'resource-limit' };
}

/**
 * Completed bounded-tail fallbacks, pooled per attach scope (H1d).
 *
 * Before this pool every attach of an over-index source re-streamed the WHOLE
 * source through the bounded sink — O(source) work per attach, serialized in
 * front of the history frame. An active large session's clients reattach
 * often, and when the scan outlasts a client's own attach deadline the client
 * abandons the socket and retries, which re-runs the scan — the loop that
 * starved live delivery for exactly the largest, busiest rollouts. The pool
 * keeps the last finished sink and replay per scope: an unchanged source is
 * answered from memory, an append-grown one pays only the delta through the
 * adapter's capture resume, and anything else pays the full scan it always
 * paid. Entries are few, small (one client window plus bounded enrichment),
 * and idle-expired on the same TTL as the page-cache pool.
 */
const BOUNDED_TAIL_FALLBACK_MAX_ENTRIES = 4;
type BoundedTailFallbackEntry = {
  identity: HistorySourceIdentity;
  sink: BoundedTailHistorySnapshotSink;
  fallback: BoundedTailHistoryFallback;
  lastUsedMs: number;
};
const boundedTailFallbacks = new Map<string, BoundedTailFallbackEntry>();
const boundedTailFallbackFlights = new Map<
  string,
  Promise<BoundedTailHistoryFallback | undefined>
>();

function pruneBoundedTailFallbacks(now: number): void {
  for (const [key, entry] of boundedTailFallbacks) {
    if (now - entry.lastUsedMs > HISTORY_PAGE_CACHE_IDLE_TTL_MS) {
      boundedTailFallbacks.delete(key);
    }
  }
  while (boundedTailFallbacks.size > BOUNDED_TAIL_FALLBACK_MAX_ENTRIES) {
    let oldestKey: string | undefined;
    let oldestMs = Number.POSITIVE_INFINITY;
    for (const [key, entry] of boundedTailFallbacks) {
      if (entry.lastUsedMs < oldestMs) {
        oldestMs = entry.lastUsedMs;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) break;
    boundedTailFallbacks.delete(oldestKey);
  }
}

function boundedTailReadMetric(kind: string, connection: SessionConnection): void {
  if (process.env.COSYNCING_TEST_HISTORY_READ_METRICS === '1') {
    console.error(`[h1-history-read] ${kind} ${connection.info.tool}:${connection.info.id}`);
  }
}

/** Whether a pooled capture may be extended by appended bytes instead of rebuilt. */
function boundedTailAppendLineage(
  pooled: HistorySourceIdentity,
  source: HistorySourceIdentity,
): boolean {
  return pooled.sourceId === source.sourceId
    && pooled.rewriteToken !== undefined
    && pooled.rewriteToken === source.rewriteToken
    && (source.appendPosition ?? 0) >= (pooled.appendPosition ?? 0);
}

/**
 * Read the newest bounded window of a history whose INDEX does not fit (H1c).
 *
 * This is the only thing standing between a genuine resource refusal and an
 * empty session. The sink evicts instead of refusing, so peak retention is one
 * client-sized window regardless of source size, and nothing about the whole
 * native history is materialized. It exists exactly for sources beyond the
 * public paging contract; inside that contract the index build succeeds and
 * this is never reached.
 *
 * `undefined` means even this could not run — an over-contract native source,
 * an oversized record, or a source that moved mid-read. The caller must then
 * keep whatever the client already holds rather than replace it.
 */
async function readBoundedTailHistoryReplay(options: {
  scope: string;
  source: HistorySourceIdentity;
  connection: SessionConnection;
  artifactMode: 'inline' | 'reference' | undefined;
}): Promise<BoundedTailHistoryFallback | undefined> {
  const { scope, source, connection, artifactMode } = options;
  if (typeof connection.captureHistorySnapshot !== 'function') return undefined;
  // Serialize per scope, so concurrent attaches of one session collapse into a
  // single scan plus cheap continuations instead of N interleaved whole-source
  // scans stretching each other's wall clock. Bounded: each awaited flight
  // resolves, and a fresh flight behind it is this caller's own work.
  for (let round = 0; round < 8; round += 1) {
    const flight = boundedTailFallbackFlights.get(scope);
    if (!flight) break;
    await flight.catch(() => undefined);
  }
  const now = Date.now();
  pruneBoundedTailFallbacks(now);
  const pooled = boundedTailFallbacks.get(scope);
  if (pooled && sameHistorySourceIdentity(pooled.identity, source)) {
    pooled.lastUsedMs = now;
    boundedTailReadMetric('bounded-tail-cached', connection);
    return pooled.fallback;
  }
  const resumable = pooled !== undefined
    && boundedTailAppendLineage(pooled.identity, source);
  const flight = (async (): Promise<BoundedTailHistoryFallback | undefined> => {
    const captureInto = async (
      sink: BoundedTailHistorySnapshotSink,
      resumedSink: boolean,
    ): Promise<BoundedTailHistoryFallback | undefined | 'retry-fresh'> => {
      const captured = await Promise.resolve(
        connection.captureHistorySnapshot!(sink, { artifactMode }),
      ).catch(() => undefined);
      if (!captured || isHistorySnapshotRefusal(captured)) {
        // A failed or refused pass may have partially fed this sink; nothing
        // pooled from it can be trusted again.
        boundedTailFallbacks.delete(scope);
        // A pooled sink whose resume the adapter rejected (the source moved out
        // from under the lineage check) still deserves the full read a
        // first-time attach would get; a refusal is terminal either way.
        return !captured && resumedSink ? 'retry-fresh' : undefined;
      }
      if (
        !historySourceStillContainsSnapshot(captured.identity, source)
        && !historySourceStillContainsSnapshot(source, captured.identity)
      ) {
        boundedTailFallbacks.delete(scope);
        return undefined;
      }
      const skippedRecords = Math.max(0, Math.trunc(captured.skippedRecords ?? 0));
      // A skipped record never reached the sink, so a newer `update_plan` inside it
      // could not supersede anything and the older projection would replay as
      // CURRENT (round 6, P1-2). This is the one place that knows both facts — the
      // adapter's skip count and the sink still holding its state — so the capture
      // gives up its latest-wins state claims here, before the replay is frozen.
      if (skippedRecords > 0) sink.suppressStateAuthority();
      const replay = sink.finish(captured.identity);
      const fallback: BoundedTailHistoryFallback = {
        replay,
        skippedRecords,
        clippedMessages: replay.clippedMessages,
        omittedMessages: replay.omittedMessages,
        supersededMessages: replay.supersededMessages,
        unverifiedStateMessages: replay.unverifiedStateMessages,
      };
      boundedTailFallbacks.set(scope, {
        identity: captured.identity,
        sink,
        fallback,
        lastUsedMs: Date.now(),
      });
      pruneBoundedTailFallbacks(Date.now());
      return fallback;
    };
    if (resumable) {
      boundedTailReadMetric('bounded-tail-resume', connection);
      const resumed = await captureInto(pooled!.sink, true);
      if (resumed !== 'retry-fresh') return resumed;
    }
    boundedTailReadMetric('bounded-tail-fallback', connection);
    // No `acceptsLocations`: this deliberately takes the adapter's plain
    // streaming path, so none of the random-access index budgets apply.
    const fresh = await captureInto(new BoundedTailHistorySnapshotSink(), false);
    return fresh === 'retry-fresh' ? undefined : fresh;
  })();
  boundedTailFallbackFlights.set(scope, flight);
  try {
    return await flight;
  } finally {
    boundedTailFallbackFlights.delete(scope);
  }
}

/**
 * What the bounded-tail fallback produced, and what it had to give up doing so.
 *
 * The losses travel with the replay because the FRAME is where they have to be
 * admitted. "The newest messages are shown" is false when a record was skipped
 * for being unreadably large, false again when a message was shortened to fit,
 * and false again when one was left out entirely — and a client cannot tell any
 * of the three from the messages it receives (H1c rounds 3-4, finding 5).
 */
type BoundedTailHistoryFallback = {
  replay: BoundedTailHistoryReplay;
  /** Records the adapter passed over because no bounded window could hold them. */
  skippedRecords: number;
  /** Retained rows carrying a bounded, shortened stand-in instead of their real body. */
  clippedMessages: number;
  /** Rows left out entirely because no stand-in could be built for their variant. */
  omittedMessages: number;
  /** Rows withheld because a newer same-key state update could not be sent. */
  supersededMessages: number;
  /** State rows withheld because a skipped record left them unverifiable. */
  unverifiedStateMessages: number;
};

/**
 * The gap prose for a bounded-tail replacement window.
 *
 * Deliberately built from the existing {@link HISTORY_PAGE_RESOURCE_LIMIT} /
 * `HISTORY_PAGE_SOURCE_CHANGED` codes and nothing else: the client keys its
 * localized copy off the CODE and shows this text only behind the technical
 * details expander, so a new code would mean new ARB strings, a new client
 * release, and an older client rendering an unrecognized gap. The facts belong
 * in the sentence instead, where every broker revision can carry them.
 */
function boundedTailGapMessage(
  kind: 'resource-limit' | 'source-changed',
  losses: {
    skippedRecords: number;
    clippedMessages: number;
    omittedMessages: number;
    supersededMessages: number;
    unverifiedStateMessages: number;
  },
): string {
  const incomplete = losses.skippedRecords > 0
    || losses.omittedMessages > 0
    || losses.supersededMessages > 0
    || losses.unverifiedStateMessages > 0;
  const shown = incomplete
    ? 'the newest readable messages are shown'
    : 'the newest messages are shown';
  const notes: string[] = [];
  if (losses.skippedRecords > 0) {
    // "in this history", not "in this window": `skippedRecords` counts the
    // whole captured source and the skip positions are not tracked, so any
    // claim about WHERE they were would be invented (round 4).
    notes.push(
      `${losses.skippedRecords} oversized record${losses.skippedRecords === 1 ? '' : 's'} in this history could not be read`,
    );
  }
  if (losses.omittedMessages > 0) {
    notes.push(
      `${losses.omittedMessages} message${losses.omittedMessages === 1 ? ' was' : 's were'} too large to include`,
    );
  }
  if (losses.clippedMessages > 0) {
    notes.push(
      `${losses.clippedMessages} message${losses.clippedMessages === 1 ? ' was' : 's were'} too large to send in full and only the beginning is shown`,
    );
  }
  if (losses.supersededMessages > 0) {
    // Deliberately a DIFFERENT reason from the oversized cases above: these
    // rows fit, and are missing because a newer update to the same state could
    // not be sent, so replaying them would present superseded state as current.
    notes.push(
      `${losses.supersededMessages} earlier state update${losses.supersededMessages === 1 ? ' was' : 's were'} withheld because a newer version of that state could not be sent`,
    );
  }
  if (losses.unverifiedStateMessages > 0) {
    // A third, distinct reason: nothing newer was SEEN for these keys. Part of
    // the source could not be read at all, so the capture cannot prove they are
    // still current, and asserting them would be a guess.
    notes.push(
      `${losses.unverifiedStateMessages} state update${losses.unverifiedStateMessages === 1 ? ' was' : 's were'} withheld because unreadable records mean current state could not be verified`,
    );
  }
  const detail = notes.length > 0 ? ` ${notes.join('; ')}.` : '';
  return kind === 'resource-limit'
    ? `This native history exceeds the bounded paging index; ${shown} and earlier ones cannot be loaded.${detail}`
    : `This session changed while its history was being read; ${shown}. Reconnect to retry.${detail}`;
}

async function buildCurrentHistoryPageCache(options: {
  scope: string;
  source: HistorySourceIdentity;
  connection: SessionConnection;
  artifactMode: 'inline' | 'reference' | undefined;
}): Promise<HistoryPageCacheOutcome> {
  const { scope, source, connection, artifactMode } = options;
  // The pool stores only successful builds, so the typed failure is carried
  // beside the single-flight promise rather than inside it. It starts as the
  // transient outcome so a build this caller coalesced onto — or one another
  // caller superseded — reports "retry", never "too large".
  let failure: Exclude<HistoryPageCacheOutcome, { kind: 'cache' }> = { kind: 'source-changed' };
  const cache = await historyPageCaches.getOrCreate(
    scope,
    source,
    async () => {
      const outcome = await readHistoryPagePrefix({ source, connection, artifactMode });
      if (outcome.kind === 'cache') return outcome.cache;
      failure = outcome;
      return undefined;
    },
    { exact: true },
  );
  return cache ? { kind: 'cache', cache } : failure;
}

function isPromptClientMessage(kind: unknown): boolean {
  return kind === 'prompt' || kind === 'file' || kind === 'command' || kind === 'plan-action' || kind === 'artifact-interaction';
}

function isMutatingClientMessage(kind: unknown): boolean {
  return kind === 'prompt' || kind === 'file' || kind === 'approve' || kind === 'answer' || kind === 'reject-question' || kind === 'command' || kind === 'plan-action' || kind === 'artifact-interaction' || kind === 'set-agent' || kind === 'handoff';
}

function pendingReplayKey(message: AgentMessage): string | undefined {
  if (message.type === 'permission-request' || message.type === 'question-request') return `${message.type}:${message.requestId}`;
  return undefined;
}

function pendingReplayEventKey(event: WireEvent): string | undefined {
  return event.kind === 'message' ? pendingReplayKey(event.message) : undefined;
}

/** Identity used to reconcile the captured live snapshot against the history just delivered.
 *  Only model-output/thinking accumulate in the live text buffer, so only they can overlap. */
function liveOverlapKey(message: AgentMessage): string | undefined {
  if (message.type !== 'model-output' && message.type !== 'thinking') return undefined;
  return message.key ? `${message.type}:${message.key}` : undefined;
}

/** How much text a keyed message carries, so the more complete copy of one identity wins. */
function liveOverlapTextLength(message: AgentMessage): number {
  const text = (message as { text?: unknown }).text;
  return typeof text === 'string' ? text.length : 0;
}

function parseClientMessageId(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') return '';
  const id = raw.trim();
  if (!id || id.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(id)) return '';
  return id;
}

/** Contract revision that introduced durable, versioned shared composer drafts. Clients at or above
 *  it understand draft revisions, so they can be sent clear tombstones; older ones cannot. */
const DURABLE_DRAFT_CONTRACT_REVISION = 3;

/** Draft writes base their optimistic-concurrency check on the last broker revision the writer
 *  observed. Absent/malformed values degrade to a legacy last-writer-wins write. */
function parseDraftBaseRevision(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined;
}

function ticketFromClientMessage(msg: any): string {
  return typeof msg?.attachTicket === 'string'
    ? msg.attachTicket.trim()
    : typeof msg?.cursor === 'string'
      ? msg.cursor.trim()
      : '';
}

function handleProtocolReceipt(ws: ServerWebSocket<WsData>, msg: any): void {
  const receipt = msg?.kind === 'nack' ? 'nack' : 'ack';
  const attachTicket = ticketFromClientMessage(msg);
  const parsedClientMessageId = parseClientMessageId(msg?.clientMessageId);
  const clientMessageId = parsedClientMessageId || undefined;
  const send = (event: WireEvent) => ws.send(JSON.stringify(event));
  if (!attachTicket || parsedClientMessageId === '') {
    send({
      kind: 'nack',
      code: 'ACK_INVALID',
      message: !attachTicket ? 'ack/nack requires an attach ticket' : 'clientMessageId must be a short ASCII token',
      ...(attachTicket ? { attachTicket } : {}),
      ...(clientMessageId ? { clientMessageId } : {}),
    });
    return;
  }
  const outcome = protocolJournal.receiveTicket({
    identity: ws.data.identity,
    tool: ws.data.tool,
    sessionId: ws.data.id,
  }, attachTicket, receipt);
  if (outcome.status === 'unknown') {
    send({
      kind: 'nack',
      code: 'ACK_UNKNOWN_TARGET',
      message: 'ack/nack references an unknown or expired attach ticket',
      attachTicket,
      ...(clientMessageId ? { clientMessageId } : {}),
    });
    return;
  }
  if (outcome.status === 'conflict') {
    send({
      kind: 'nack',
      code: 'ACK_CONFLICT',
      message: `attach ticket was already ${outcome.prior === 'ack' ? 'committed' : 'nacked'}`,
      attachTicket,
      ...(clientMessageId ? { clientMessageId } : {}),
    });
    return;
  }
  send({
    kind: 'ack',
    ack: receipt,
    attachTicket,
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(outcome.duplicate ? { duplicate: true } : {}),
  });
}

function healthWithSecurityState(): Record<string, unknown> {
  const inspections = inspectDurableSchemas();
  const recoveredCorruption = inspectDurableCorruptionEvidence();
  const critical = inspections.filter((item) =>
    item.status === 'unsafe' || item.status === 'malformed' || item.status === 'unsupported-version');
  const migrations = inspections.filter((item) => item.status === 'migration-required');
  const securityStatus = critical.length > 0
    ? 'critical'
    : migrations.length > 0 || recoveredCorruption.length > 0 ? 'degraded' : 'healthy';
  const status = latestBrokerHealth.status === 'critical' || securityStatus === 'critical'
    ? 'critical'
    : latestBrokerHealth.status === 'degraded' || securityStatus === 'degraded' ? 'degraded' : 'healthy';
  const checkedAt = Date.now();
  return {
    ...latestBrokerHealth,
    status,
    checkedAt: Math.max(latestBrokerHealth.checkedAt, checkedAt),
    components: {
      ...latestBrokerHealth.components,
      'security-state': {
        status: securityStatus,
        detailCodes: [...critical, ...migrations, ...recoveredCorruption].map((item) => item.detailCode),
        checkedAt,
      },
    },
  };
}

function refMessage(
  tool: string,
  id: string,
  mode: 'inline' | 'reference' | undefined,
  message: AgentMessage,
  brokerUrl?: string,
): AgentMessage {
  if (mode === 'reference' && message.type === 'tool-result') {
    const callId = message.callId || 'diff';
    return buildDiffRefMessage(message, INLINE_DIFF_CAP, (body) =>
      artifactStore.stashDiff(tool, id, `${id}:${callId}`, body, brokerUrl),
    );
  }
  if (message.type !== 'file-artifact') return message;
  return mode === 'reference'
    ? artifactStore.toReference({ tool, id }, message, brokerUrl)
    : artifactStore.displayOnly(message);
}

function refMessages(
  tool: string,
  id: string,
  mode: 'inline' | 'reference' | undefined,
  messages: AgentMessage[],
  brokerUrl?: string,
): AgentMessage[] {
  return mode === 'reference' ? messages.map((m) => refMessage(tool, id, mode, m, brokerUrl)) : messages;
}

/**
 * Route a client→broker message. PROMPTS go on a per-socket chain AND are spaced ≥350ms apart,
 * because opencode reorders prompts that arrive back-to-back (a rapid-fire queue would render out
 * of order). Everything else (commands, approvals, answers, files) runs IMMEDIATELY and
 * concurrently — so a slow command (e.g. a ~47s /compact) can never head-of-line-block the socket.
 */
function routeInbound(ws: ServerWebSocket<WsData>, raw: string): void {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg?.kind === 'ack' || msg?.kind === 'nack') {
    handleProtocolReceipt(ws, msg);
    return;
  }
  if (msg?.kind === 'history-page') {
    void handleHistoryPage(ws, msg);
    return;
  }
  if (ws.data.compatibility.readOnly && isMutatingClientMessage(msg?.kind)) {
    const clientMessageId = parseClientMessageId(msg?.clientMessageId) || undefined;
    ws.send(JSON.stringify({
      kind: 'nack',
      code: 'CLIENT_MESSAGE_FAILED',
      // A genuine incompatibility OUTRANKS the declaration. Both can be true at
      // once — an old client can also meet a mode it cannot read — and the
      // incompatibility is the fact worth telling, since it is the one the user
      // can act on by updating.
      message: ws.data.readOnlyRequested
        && ws.data.compatibility.status !== 'hard-incompatible'
        ? `read-only session: ${ws.data.compatibility.reason}`
        : `read-only compatibility mode: ${ws.data.compatibility.reason}`,
      ...(clientMessageId ? { clientMessageId } : {}),
    } satisfies WireEvent));
    return;
  }
  const sequencer = ws.data.handoffSequencer ??= new ClientHandoffSequencer();
  if (msg?.kind === 'handoff') {
    if (sequencer.hasActiveWork) {
      // A slow command can legitimately run longer than the client's handoff
      // confirmation timeout. Refuse now instead of queuing a transfer that
      // would execute after the UI already reported failure.
      void handleClientMessage(
        ws,
        msg,
        new OwnershipConflictError(
          'Another operation on this client is still being delivered. Retry terminal handoff after it settles.',
          'peer-driver-active',
        ),
      );
    } else {
      void sequencer.run(() => handleClientMessage(ws, msg), { handoff: true });
    }
    return;
  }
  // set-agent rides the same serialized chain as prompts so "switch to plan, then send" cannot
  // race the switch behind the prompt it was meant to govern. The handoff sequencer registers the
  // queued operation immediately, so a later handoff waits for it; normal concurrency is unchanged.
  if (msg?.kind === 'prompt' || msg?.kind === 'plan-action' || msg?.kind === 'artifact-interaction' || msg?.kind === 'set-agent') {
    const task = sequencer.run(
      () => handleClientMessage(ws, msg),
      { after: ws.data.sendChain ?? Promise.resolve() },
    );
    ws.data.sendChain = task.then(
      () => undefined,
      () => undefined,
    );
  } else {
    void sequencer.run(() => handleClientMessage(ws, msg));
  }
}

async function handleHistoryPage(ws: ServerWebSocket<WsData>, msg: any): Promise<void> {
  const mc = ws.data.mc;
  if (!mc) return;
  const clientMessageId = parseClientMessageId(msg?.clientMessageId);
  const send = (event: WireEvent) => ws.send(JSON.stringify(event));
  if (clientMessageId === '') {
    send({ kind: 'nack', code: 'BAD_CLIENT_MESSAGE_ID', message: 'clientMessageId must be a short ASCII token' });
    return;
  }
  const limit = typeof msg?.limit === 'number' ? msg.limit : 100;
  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1 || limit > 500) {
    send({
      kind: 'nack',
      code: 'BAD_PARAM',
      message: 'history page limit must be an integer from 1 to 500',
      ...(clientMessageId ? { clientMessageId } : {}),
    });
    return;
  }
  const rawCursor = typeof msg?.cursor === 'string' ? msg.cursor : undefined;
  const scope = historyPageCacheScope(
    ws.data.tool,
    ws.data.id,
    ws.data.artifactMode,
  );
  const currentSource = await readHistorySourceIdentity(mc.conn);
  if (!currentSource && ws.data.historyPagingUnavailableWithoutIdentity) {
    send({
      kind: 'nack',
      code: 'HISTORY_PAGE_SOURCE_UNVERSIONED',
      message: 'This native history cannot be paged safely without a source revision.',
      ...(clientMessageId ? { clientMessageId } : {}),
    });
    return;
  }
  if (currentSource) {
    ws.data.historyPagingUnavailableWithoutIdentity = false;
  }
  if (
    currentSource
    && ws.data.historyPagingUnavailableSource
    && historySourceStillContainsSnapshot(
      ws.data.historyPagingUnavailableSource,
      currentSource,
    )
  ) {
    send({
      kind: 'nack',
      code: 'HISTORY_PAGE_RESOURCE_LIMIT',
      message: 'This native history exceeds the bounded paging cache.',
      ...(clientMessageId ? { clientMessageId } : {}),
    });
    return;
  }
  if (
    ws.data.historyPagingUnavailableSource
    && currentSource
    && !historySourceStillContainsSnapshot(
      ws.data.historyPagingUnavailableSource,
      currentSource,
    )
  ) {
    ws.data.historyPagingUnavailableSource = undefined;
  }
  if (!currentSource) {
    ws.data.historyPagingUnavailableWithoutIdentity = true;
    send({
      kind: 'nack',
      code: 'HISTORY_PAGE_SOURCE_UNVERSIONED',
      message: 'This native history cannot be paged safely without a source revision.',
      ...(clientMessageId ? { clientMessageId } : {}),
    });
    return;
  }

  /** One place decides how a failed build is reported and whether it sticks. */
  const failBuild = (outcome: Exclude<HistoryPageCacheOutcome, { kind: 'cache' }>): void => {
    if (outcome.kind === 'resource-limit') {
      // Measured overflow of the bounded index. Terminal for this source
      // revision: reparsing it would cost the same and fail the same way.
      ws.data.historyPagingUnavailableSource = currentSource;
      send({
        kind: 'nack',
        code: 'HISTORY_PAGE_RESOURCE_LIMIT',
        message: 'This native history exceeds the bounded paging cache.',
        ...(clientMessageId ? { clientMessageId } : {}),
      });
      return;
    }
    // The source moved while it was being indexed — the ordinary condition for
    // a session that is still writing. Deliberately NO sticky marker: the same
    // socket must be able to retry, and the next attempt reads a newer prefix.
    send({
      kind: 'nack',
      code: 'HISTORY_PAGE_SOURCE_CHANGED',
      message: 'This session was still writing while its history was indexed. Try again.',
      ...(clientMessageId ? { clientMessageId } : {}),
    });
  };

  let cache = historyPageCaches.get(scope, currentSource);
  if (!cache) {
    const built = await buildCurrentHistoryPageCache({
      scope,
      source: currentSource,
      connection: mc.conn,
      artifactMode: ws.data.artifactMode,
    });
    if (built.kind !== 'cache') {
      failBuild(built);
      return;
    }
    cache = built.cache;
  }
  let page = await cache.loadPage(rawCursor, limit, {
    artifactMode: ws.data.artifactMode,
  });
  if ('kind' in page) {
    failBuild(page);
    return;
  }
  if (
    page.gap?.code === 'HISTORY_CURSOR_GONE'
    && !sameHistorySourceIdentity(cache.sourceIdentity, currentSource)
  ) {
    // A newer truncated client may hold a boundary beyond an append ancestor
    // that is still valid for older clients. Build the observed current source
    // once, replace the ancestor, then retry the same opaque cursor. The
    // current index continues to validate all unchanged older prefix cursors.
    const currentCache = await buildCurrentHistoryPageCache({
      scope,
      source: currentSource,
      connection: mc.conn,
      artifactMode: ws.data.artifactMode,
    });
    if (currentCache.kind !== 'cache') {
      failBuild(currentCache);
      return;
    }
    cache = currentCache.cache;
    page = await cache.loadPage(rawCursor, limit, {
      artifactMode: ws.data.artifactMode,
    });
    if ('kind' in page) {
      failBuild(page);
      return;
    }
  }
  if (page.gap) {
    send({
      kind: 'nack',
      code: page.gap.code,
      message: page.gap.message,
      ...(clientMessageId ? { clientMessageId } : {}),
    });
    return;
  }
  const referencedPage = refMessages(
    ws.data.tool,
    ws.data.id,
    ws.data.artifactMode,
    page.messages,
  );
  send({
    kind: 'history-page',
    messages: referencedPage,
    ...(page.cursor ? { cursor: page.cursor } : {}),
    hasMore: page.hasMore,
    endOfHistory: page.endOfHistory,
    ...(clientMessageId ? { clientMessageId } : {}),
  });
}

/** Run one client→broker message (prompt/approve/…). Errors are reported, never silently dropped. */
async function handleClientMessage(
  ws: ServerWebSocket<WsData>,
  msg: any,
  preflightError?: unknown,
): Promise<void> {
  const mc = ws.data.mc;
  if (!mc || !msg) return;
  await handleManagedClientMessage(mc, msg, (event) => ws.send(JSON.stringify(event)), {
    lastPromptAt: () => ws.data.lastPromptAt ?? 0,
    setLastPromptAt: (value) => { ws.data.lastPromptAt = value; },
    journalScope: { identity: ws.data.identity, tool: ws.data.tool, sessionId: ws.data.id },
    uploadIdentity: ws.data.uploadIdentity,
    preflightError,
  });
}

/** Shared client-control executor. WebSocket frames and encrypted transport controls both enter here. */
async function handleManagedClientMessage(
  mc: ManagedConn,
  msg: any,
  send: (event: WireEvent) => void,
  promptTiming: {
    lastPromptAt?: () => number;
    setLastPromptAt?: (value: number) => void;
    journalScope?: ProtocolJournalScope;
    uploadIdentity?: string;
    preflightError?: unknown;
  } = {},
): Promise<void> {
  const clientMessageId = parseClientMessageId(msg?.clientMessageId);
  if (clientMessageId === '') {
    send({ kind: 'nack', code: 'BAD_CLIENT_MESSAGE_ID', message: 'clientMessageId must be a short ASCII token' });
    return;
  }
  if ((msg?.kind === 'plan-action' || msg?.kind === 'artifact-interaction' || msg?.kind === 'handoff') && !clientMessageId) {
    send({ kind: 'nack', code: 'BAD_CLIENT_MESSAGE_ID', message: `${msg.kind} requires clientMessageId` });
    return;
  }
  const journalScope = promptTiming.journalScope;
  if (clientMessageId && journalScope) {
    let claim;
    try {
      claim = protocolJournal.claim(journalScope, clientMessageId, String(msg?.kind ?? ''), mutationFingerprint(msg));
    } catch (error) {
      console.error(`${LOG_PREFIX} idempotency journal claim failed: ${String(error)}`);
      send({ kind: 'nack', code: 'CLIENT_MESSAGE_JOURNAL_FULL', message: 'durable idempotency journal is unavailable', clientMessageId });
      return;
    }
    if (claim.status === 'pending') {
      send({ kind: 'ack', ack: 'client-message', clientMessageId, duplicate: true, pending: true });
      return;
    }
    if (claim.status === 'terminal') {
      send({ ...claim.result, duplicate: true });
      return;
    }
    if (claim.status === 'conflict') {
      send({ kind: 'nack', code: 'CLIENT_MESSAGE_ID_CONFLICT', message: 'clientMessageId was already used for a different mutation', clientMessageId });
      return;
    }
    if (claim.status === 'capacity') {
      send({ kind: 'nack', code: 'CLIENT_MESSAGE_JOURNAL_FULL', message: 'idempotency journal has no safe eviction candidate', clientMessageId });
      return;
    }
  }
  let resultForId: WireEvent | undefined;
  /** Set when an accepted prompt's shared-draft clear could not be durably stored (DR1). */
  let draftClearFailed = false;
  /** The shared revision that failed clear left standing, so the sender's retry stays conditional
   *  on the exact record its prompt sent instead of unconditionally emptying whatever is there. */
  let draftClearRevision = 0;
  try {
    if (promptTiming.preflightError !== undefined) {
      throw promptTiming.preflightError;
    }
    // Read-only Observe is enforced at the broker boundary as well as in the UI. Disabled buttons are
    // advisory; crafted WS frames must not mutate a terminal-owned session. Governing contract:
    // docs/architecture/client-ui.md
    // Check the broad mutation gate FIRST: a read-only Observe session (no Drive, no active sync) can do
    // NOTHING, so it must get the "read-only observe session" message — not the answer-only/synced wording,
    // which would mislead the user (and break the contract) by claiming a sync that doesn't exist.
    if (isMutatingClientMessage(msg.kind) && !canMutateSession(mc.conn.info)) {
      throw new Error('read-only observe session: use Drive or active terminal sync before sending input');
    }
    // Then refine for a session that CAN mutate but only answers: a NEW prompt/file/command needs prompt
    // capability — an answer-only synced session (Claude hooks) accepts permission/question answers but
    // cannot inject a live turn, so reject those frames here too (UI also gates).
    if (isPromptClientMessage(msg.kind) && !canPromptSession(mc.conn.info)) {
      throw new Error('this synced session answers prompts and questions only — send new messages in its terminal');
    }
    if (msg.kind === 'handoff') {
      await hub.handoffToTerminal(mc.conn.info.tool, mc.conn.info.id, mc);
    } else {
      if (msg.kind === 'artifact-interaction') {
        const forbiddenEnvelopeFields = [
          'session', 'sessionId', 'tool', 'name', 'path', 'text', 'prompt', 'credentials',
          'permission', 'decision', 'model', 'agent', 'permissionMode',
        ];
        if (forbiddenEnvelopeFields.some((field) => Object.prototype.hasOwnProperty.call(msg, field))) {
          throw new ClientMessagePolicyError(
            'ARTIFACT_INTERACTION_INVALID',
            'artifact interaction contains a forbidden control field',
          );
        }
      }
      const permissionMode = await validateRequestedPermissionMode(
        mc.conn,
        Object.prototype.hasOwnProperty.call(msg, 'permissionMode'),
        msg.permissionMode,
      );
      if (msg.kind === 'prompt') {
      // space rapid prompts so opencode keeps their order (this runs inside the serialized chain)
      const gap = MIN_PROMPT_GAP_MS - (Date.now() - (promptTiming.lastPromptAt?.() ?? 0));
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
      promptTiming.setLastPromptAt?.(Date.now());
      const rawFiles = msg.files;
      const hasFiles = Array.isArray(rawFiles) && rawFiles.length > 0;
      if (rawFiles !== undefined && !Array.isArray(rawFiles)) {
        throw new ClientMessagePolicyError('ATTACHMENT_INVALID', 'prompt files must be an array');
      }
      if (hasFiles && !clientMessageId) {
        throw new ClientMessagePolicyError(
          'ATTACHMENT_INVALID',
          'attachment prompts require clientMessageId',
        );
      }
      const backend = registry.get(mc.conn.info.tool);
      if (hasFiles && backend?.capabilities.supportsNativeFileInput !== true) {
        throw new ClientMessagePolicyError(
          'ATTACHMENT_UNSUPPORTED',
          'this adapter does not support prompt attachments',
        );
      }
      if (hasFiles && !mc.conn.info.cwd) {
        throw new ClientMessagePolicyError(
          'ATTACHMENT_UNSUPPORTED',
          'this session mode has no attachment workspace',
        );
      }
      let prepared;
      try {
        prepared = hasFiles
          ? uploadStaging.preparePromptFiles({
              tool: mc.conn.info.tool,
              sessionId: mc.conn.info.id,
              identity:
                promptTiming.uploadIdentity
                ?? journalScope?.identity
                ?? 'loopback-local',
              clientMessageId: clientMessageId!,
              sessionCwd: mc.conn.info.cwd!,
              files: rawFiles,
            })
          : undefined;
      } catch (error) {
        throw attachmentPolicyError(error);
      }
      try {
        await mc.conn.sendPrompt({
          text: String(msg.text ?? ''),
          images: msg.images,
          files: prepared?.files,
          model: msg.model, // per-prompt model override {providerID, modelID}
          agent: msg.agent, // per-prompt agent/mode (build/plan)
          permissionMode, // exact adapter-advertised per-prompt approval mode
          clientMessageId: clientMessageId || undefined, // echo correlation: adapters stamp it as clientKey on this send's user echo
        });
      } catch (error) {
        if (prepared) {
          uploadStaging.rollbackPreparedPromptFiles(
            mc.conn.info.tool,
            mc.conn.info.id,
            prepared,
          );
          throw new ClientMessagePolicyError(
            'ATTACHMENT_DELIVERY_FAILED',
            `attachment prompt was rejected: ${String(error)}`,
          );
        }
        throw error;
      }
      if (prepared) {
        uploadStaging.commitPreparedPromptFiles(
          mc.conn.info.tool,
          mc.conn.info.id,
          prepared,
        );
      }
      recordAndBroadcastManagedAppMutation(mc);
      // The shared draft was sent — clear it on every client's composer, but ONLY the draft this
      // sender observed. `draftRevision` is the shared revision the client had adopted (versioned
      // clients always send one, 0 when they hold no shared draft). If another device has typed a
      // newer shared draft since, this prompt never contained it and clearing would erase that
      // device's unsent text, so the clear is skipped. Legacy clients omit the field and keep the
      // historical unconditional clear.
      // `draftUpdateId` covers the send-while-unacknowledged race: the sender's own draft write may
      // have been applied by the frame immediately before this one, so the revision it reported is
      // already stale even though the current shared draft IS this prompt's text.
      // The clear is part of the handoff, not a side effect. If the tombstone could not be durably
      // stored, the prompt still reached the agent — nacking it would be a lie — but the sender must
      // NOT delete its local draft, or a broker restart replays the sent text as an unsent draft on
      // every client. The outcome rides the prompt's own acknowledgement instead.
      const clearResult = mc.clearDraftAfterPrompt(
        parseDraftBaseRevision(msg.draftRevision),
        parseClientMessageId(msg.draftUpdateId) || undefined,
      );
      // `undefined` means there was nothing of this sender's to clear, which is already the desired
      // end state. Only a store that refused the write leaves the shared draft holding sent text.
      draftClearFailed = clearResult?.unavailable === true;
      if (draftClearFailed) draftClearRevision = clearResult?.record.revision ?? 0;
    } else if (msg.kind === 'draft') {
      // Multi-client composer sync: relay-only, never touches the agent (hence outside the mutation gate).
      // DR1: versioned writes carry an idempotency `updateId` and the last broker revision the writer
      // observed (`baseRevision`). A stale-base write is REJECTED (never silently overwrites a newer
      // shared draft); the current shared record is returned to that writer only, so it can preserve
      // both versions and offer a resolution. A duplicate updateId gets the current record back
      // without another fan-out. Legacy frames (neither field) keep last-writer-wins.
      const result = mc.setDraft(String(msg.text ?? ''), {
        updateId: parseClientMessageId(msg.updateId) || undefined,
        baseRevision: parseDraftBaseRevision(msg.baseRevision),
      });
      // On `unavailable` (durability failed) send NOTHING: any frame here either echoes the writer's
      // updateId — marking its row clean against a shared copy a restart would lose — or reports a
      // revision it would adopt. Silence keeps the local row dirty and retrying, which is the honest
      // state. The failure is already reported to the operator by the store's persistence hook; a
      // per-keystroke red banner is not the right surface for relay state.
      if (!result.unavailable && (!result.applied || result.duplicate)) {
        send({ kind: 'draft', ...result.record });
      }
    } else if (msg.kind === 'plan-action') {
      const current = mc.currentPlan(msg.planKey);
      const { action, semantic } = validatePlanActionRequest(msg, current);
      const input: PlanActionInput = {
        action,
        planKey: semantic.planKey,
        revision: semantic.revision,
        title: current?.title,
        text: action === 'edit' ? msg.text.trim() : undefined,
        items: current?.items.map((item) => ({
          id: item.id,
          title: item.title,
          status: item.status,
          detail: item.detail,
        })),
        model: msg.model,
        agent: typeof msg.agent === 'string' ? msg.agent : undefined,
        permissionMode,
      };
      if (mc.conn.respondPlan) await mc.conn.respondPlan(input);
      else await mc.conn.sendPrompt({
        text: planActionPrompt(input),
        model: input.model,
        agent: input.agent,
        permissionMode: input.permissionMode,
      });
      recordAndBroadcastManagedAppMutation(mc);
    } else if (msg.kind === 'artifact-interaction') {
      const authorized = artifactStore.authorizeInteraction(
        { tool: mc.conn.info.tool, id: mc.conn.info.id },
        msg.artifactKey,
        msg.interactionRef,
        msg.interaction,
      );
      await mc.conn.sendPrompt({
        text: artifactInteractionPrompt(authorized),
      });
      recordAndBroadcastManagedAppMutation(mc);
    } else if (msg.kind === 'file') {
      // Legacy standalone file clients remain supported, but the receipt is
      // honest: a missing handler, malformed payload, or failed delivery
      // NACKs instead of falling through to the generic ACK below.
      if (!mc.conn.sendFile) {
        throw new ClientMessagePolicyError(
          'ATTACHMENT_UNSUPPORTED',
          'this session has no standalone attachment handler',
        );
      }
      if (!clientMessageId || !mc.conn.info.cwd) {
        throw new ClientMessagePolicyError(
          'ATTACHMENT_INVALID',
          'standalone attachments require clientMessageId and a workspace',
        );
      }
      let prepared;
      try {
        prepared = uploadStaging.preparePromptFiles({
          tool: mc.conn.info.tool,
          sessionId: mc.conn.info.id,
          identity:
            promptTiming.uploadIdentity
            ?? journalScope?.identity
            ?? 'loopback-local',
          clientMessageId,
          sessionCwd: mc.conn.info.cwd,
          files: [{
            name: String(msg.name ?? 'file'),
            mimeType: String(msg.mimeType ?? 'application/octet-stream'),
            data: String(msg.data ?? ''),
            size: typeof msg.size === 'number' ? msg.size : undefined,
          }],
        });
        await mc.conn.sendFile(prepared.files[0]!);
        uploadStaging.commitPreparedPromptFiles(
          mc.conn.info.tool,
          mc.conn.info.id,
          prepared,
        );
        recordAndBroadcastManagedAppMutation(mc);
      } catch (error) {
        if (prepared) {
          uploadStaging.rollbackPreparedPromptFiles(
            mc.conn.info.tool,
            mc.conn.info.id,
            prepared,
          );
        }
        if (error instanceof ClientMessagePolicyError) throw error;
        if (error instanceof UploadError) throw attachmentPolicyError(error);
        throw new ClientMessagePolicyError(
          'ATTACHMENT_DELIVERY_FAILED',
          `standalone attachment was rejected: ${String(error)}`,
        );
      }
    } else if (msg.kind === 'approve') {
      await mc.conn.respondPermission(String(msg.requestId), msg.decision);
    } else if (msg.kind === 'answer') {
      // Answer a question via its dedicated channel — NOT as a new prompt.
      await mc.conn.answerQuestion?.(String(msg.requestId), msg.answers ?? []);
    } else if (msg.kind === 'reject-question') {
      await mc.conn.rejectQuestion?.(String(msg.requestId));
    } else if (msg.kind === 'command') {
      const commandName = String(msg.name);
      const res = mc.conn.runCommand
        ? await mc.conn.runCommand(commandName, msg.args, { model: msg.model, agent: msg.agent, permissionMode })
        : undefined;
      if (mc.conn.runCommand && isAcceptedMutationCommand(commandName, msg.args, res)) {
        recordAndBroadcastManagedAppMutation(mc);
      }
      // Surface requester-facing feedback (e.g. "Reverted last message") so a successful
      // action reads as success, never as a dropped/failed input. Goes only to the actor.
      if (res && res.notice) send({ kind: 'notice', message: res.notice });
      } else if (msg.kind === 'set-agent') {
      // Switch the session's active agent/mode (e.g. opencode build↔plan) WITHOUT starting a turn.
      // Validated against the adapter's advertised agents; fails closed when unsupported. The
      // confirmation the client renders is the adapter's own `sessionInfo{currentAgent}` update —
      // the broker fabricates nothing.
      const agent = await validateRequestedAgent(mc.conn, msg.agent);
      await mc.conn.setAgent!(agent);
        recordAndBroadcastManagedAppMutation(mc);
      }
    }
    if (clientMessageId) {
      resultForId = {
        kind: 'ack',
        ack: 'client-message',
        clientMessageId,
        // Additive and only ever present when it is FALSE: the prompt was accepted, but its shared
        // draft still holds the sent text, so the sender must keep its local row and retry the
        // clear rather than treating the handoff as complete. Older clients ignore the field —
        // they are no worse off than before it existed.
        // `draftRevision` names the exact record the retry may clear. The sender cannot derive it:
        // its own pre-send draft write may have moved the shared revision past what it reported.
        // Without it the retry would be an unconditional empty write, which would erase whatever
        // ANOTHER device typed in the meantime.
        ...(draftClearFailed ? { draftCleared: false, draftRevision: draftClearRevision } : {}),
      };
      send(resultForId);
    }
  } catch (err) {
    const message = String(err);
    if (isOwnershipConflictError(err) && msg?.kind === 'handoff') {
      resultForId = {
        kind: 'nack',
        code: driveAttachRefusalCode(err),
        message,
        ...(clientMessageId ? { clientMessageId } : {}),
      };
      try {
        send(resultForId);
      } catch {
        /* ignore */
      }
    } else if (err instanceof ClientMessagePolicyError) {
      resultForId = {
        kind: 'nack',
        code: err.code,
        message,
        ...(clientMessageId ? { clientMessageId } : {}),
      };
      try {
        send(resultForId);
      } catch {
        /* ignore */
      }
    } else if (clientMessageId) {
      resultForId = { kind: 'nack', code: 'CLIENT_MESSAGE_FAILED', message, clientMessageId };
      try {
        send(resultForId);
      } catch {
        /* ignore */
      }
    }
    try {
      send({ kind: 'error', message });
    } catch {
      /* ignore */
    }
  } finally {
    if (clientMessageId && resultForId && journalScope && (resultForId.kind === 'ack' || resultForId.kind === 'nack')) {
      try {
        protocolJournal.complete(journalScope, clientMessageId, resultForId as ProtocolTerminalResult);
      } catch (error) {
        console.error(`${LOG_PREFIX} failed to persist terminal client-message outcome: ${String(error)}`);
      }
    }
  }
}

function shortField(value: unknown, max = 1000): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function artifactInteractionPrompt(input: AuthorizedArtifactInteraction): string {
  const artifact = shortField(input.artifact.name || input.artifact.path || input.artifact.artifactKey, 200);
  const interaction = input.interaction;
  const type = shortField(interaction.type || 'interaction', 80);
  const lines = [`User interacted with ${artifact} in ${PRODUCT_IDENTITY.productName}.`, `Interaction type: ${type}`];
  if (interaction.type === 'form-submit') {
    if (interaction.formId) lines.push(`Form: ${shortField(interaction.formId, 160)}`);
    lines.push('Submitted fields:');
    for (const [key, value] of Object.entries(interaction.data)) lines.push(`- ${shortField(key, 120)}: ${shortField(value, 1000)}`);
  } else {
    lines.push(`Action: ${shortField(interaction.action, 160)}`);
    if (interaction.label) lines.push(`Label: ${shortField(interaction.label, 160)}`);
    if ('value' in interaction) lines.push(`Value: ${shortField(interaction.value, 1000)}`);
  }
  return lines.join('\n');
}

function planItemsText(items: PlanActionInput['items']): string {
  if (!items?.length) return '';
  return items
    .map((item, index) => {
      const status = item.status ? ` [${item.status}]` : '';
      const detail = item.detail ? ` — ${item.detail}` : '';
      return `${index + 1}. ${item.title}${status}${detail}`;
    })
    .join('\n');
}

function planActionPrompt(input: PlanActionInput): string {
  const title = input.title?.trim() || 'Plan';
  const items = planItemsText(input.items);
  if (input.action === 'edit') {
    const revised = input.text?.trim() || items;
    return [
      `Plan revised in ${PRODUCT_IDENTITY.productName} for "${title}".`,
      'Use this revised plan as the current plan before continuing.',
      revised ? `\nRevised plan:\n${revised}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (input.action === 'exit') {
    return [
      `Exit planning mode in ${PRODUCT_IDENTITY.productName} for "${title}".`,
      'Continue in normal execution mode. If your native tool has a plan mode, leave it now.',
    ].join('\n');
  }
  return [
    `Plan approved in ${PRODUCT_IDENTITY.productName} for "${title}".`,
    'Proceed with the plan as written.',
    items ? `\nApproved plan:\n${items}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/** Static-file response, gzipped when the client accepts it and the file is a compressible text type
 *  above ~1 KB (app.js ~220 KB → ~60 KB). Otherwise streamed as-is. Compressible responses always carry
 *  `Vary: accept-encoding` (even on the identity branch) so a shared cache never serves the wrong variant. */
async function maybeGzipFile(req: Request | undefined, file: ReturnType<typeof Bun.file>, headers: Headers): Promise<Response> {
  const type = headers.get('content-type') ?? '';
  const compressible = /^(?:text\/|application\/(?:javascript|json)|image\/svg)/.test(type);
  if (compressible) headers.set('vary', 'accept-encoding');
  if (compressible && acceptsGzip(req) && file.size >= 1024) {
    const gz = Bun.gzipSync(new Uint8Array(await file.arrayBuffer()));
    headers.set('content-encoding', 'gzip');
    return new Response(gz, { headers });
  }
  return new Response(file, { headers });
}

function parseFsReadLimit(raw: string | null): number {
  if (!raw) return FS_READ_CAP_BYTES;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed <= 0 || !Number.isFinite(parsed)) throw new FsBrowseError('BAD_PARAM', 'maxBytes must be a positive integer');
  return parsed;
}

function remoteFsEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.COSYNCING_FS_REMOTE_ENABLED?.trim() || '');
}

function fsTrustGate(req: Request, srv: Server<WsData>): Response | undefined {
  if (remoteFilesystemAllowed(srv.requestIP(req)?.address, remoteFsEnabled())) return undefined;
  return json({
    ok: false,
    error: 'workspace file browsing is disabled for non-loopback clients; enable locally via COSYNCING_FS_REMOTE_ENABLED=1',
    code: 'FS_REMOTE_DISABLED',
  }, 403);
}

function parseUploadOffset(headers: Headers): string | null {
  const explicit = headers.get('x-cosyncing-upload-offset');
  if (explicit) return explicit;
  const cr = headers.get('content-range');
  if (!cr) throw new UploadError('BAD_PARAM', 'x-cosyncing-upload-offset is required');
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(cr.trim());
  if (!m) throw new UploadError('BAD_PARAM', 'invalid content-range header');
  return m[1] ?? null;
}

function sessionBrowseErrorResponse(err: unknown): Response {
  if (err instanceof FsBrowseError) {
    const code = err.code;
    if (code === 'NOT_FOUND') return json({ ok: false, error: err.message, code }, 404);
    if (
      code === 'BAD_PARAM' ||
      code === 'PATH_EXT' ||
      code === 'PATH_ESCAPE' ||
      code === 'PATH_SYMLINK' ||
      code === 'NOT_REGULAR_FILE' ||
      code === 'NOT_DIRECTORY' ||
      code === 'NO_CWD'
    ) {
      return json({ ok: false, error: err.message, code }, 400);
    }
    if (code === 'FS_DOWNLOAD_TOO_LARGE') return json({ ok: false, error: err.message, code }, 413);
  }
  return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
}

function uploadErrorResponse(err: unknown): Response {
  if (err instanceof UploadError) {
    return json({ ok: false, error: err.message, code: err.code, ...(err.details ?? {}) }, err.status);
  }
  return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
}

function attachmentPolicyError(err: unknown): ClientMessagePolicyError {
  if (!(err instanceof UploadError)) {
    return new ClientMessagePolicyError('ATTACHMENT_INVALID', String(err));
  }
  switch (err.code) {
    case 'UPLOAD_EXPIRED':
      return new ClientMessagePolicyError('STAGED_ATTACHMENT_EXPIRED', err.message);
    case 'UPLOAD_NOT_FOUND':
      return new ClientMessagePolicyError('STAGED_ATTACHMENT_NOT_FOUND', err.message);
    case 'UPLOAD_SCOPE_MISMATCH':
      return new ClientMessagePolicyError('STAGED_ATTACHMENT_SCOPE_MISMATCH', err.message);
    case 'UPLOAD_TOO_LARGE':
    case 'UPLOAD_CAPACITY':
      return new ClientMessagePolicyError('ATTACHMENT_LIMIT_EXCEEDED', err.message);
    default:
      return new ClientMessagePolicyError('ATTACHMENT_INVALID', err.message);
  }
}

function wakePushErrorResponse(err: unknown): Response {
  if (err instanceof WakePushError) return json({ ok: false, error: err.message, code: err.code }, err.status);
  return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
}

function scheduleErrorResponse(err: unknown, schedule?: ScheduleRecord): Response {
  if (err instanceof ScheduleMutationError) {
    const status = err.code === 'SCHEDULE_NOT_FOUND'
      ? 404
      : err.code === 'SCHEDULE_STALE'
        || err.code === 'SCHEDULE_INVALID_STATE'
        || err.code === 'SCHEDULE_QUOTA_RECOVERY_UNAVAILABLE'
        ? 409
        : 400;
    // Conflicts carry the canonical current row (when it still exists) so a client can reconcile
    // optimistic state without another request.
    return json({ ok: false, error: err.message, code: err.code, ...(schedule ? { schedule } : {}) }, status);
  }
  return json({ ok: false, error: 'could not persist schedule', code: 'PERSISTENCE_FAILED' }, 500);
}

function scheduleInvalid(error: string, code: 'SCHEDULE_INVALID' | 'SCHEDULE_CRON_INVALID' = 'SCHEDULE_INVALID'): Response {
  return json({ ok: false, error, code }, 400);
}

function attachmentFilename(name: string): string {
  const cleaned = name.replace(/[\0\r\n"]/g, '_').trim();
  return cleaned || 'download';
}

function mimeTypeForPath(path: string): string {
  const ext = path.split('/').pop()?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  switch (ext) {
    case 'html':
      return 'text/html; charset=utf-8';
    case 'txt':
    case 'md':
    case 'log':
      return 'text/plain; charset=utf-8';
    case 'json':
      return 'application/json';
    case 'csv':
      return 'text/csv; charset=utf-8';
    case 'pdf':
      return 'application/pdf';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'svg':
      return 'image/svg+xml';
    case 'webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

class HttpStatusError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function readTransportRequestBytes(req: Request): Promise<Uint8Array> {
  const contentLength = req.headers.get('content-length');
  if (contentLength && Number(contentLength) > TRANSPORT_MAX_BYTES) {
    throw new HttpStatusError(413, 'transport envelope too large');
  }
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > TRANSPORT_MAX_BYTES) {
      try {
        await reader.cancel();
      } catch {
        /* ignore cancel failures */
      }
      throw new HttpStatusError(413, 'transport envelope too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function readUploadChunkBytes(req: Request): Promise<Uint8Array> {
  const contentLength = req.headers.get('content-length');
  if (contentLength && Number(contentLength) > UPLOAD_CHUNK_MAX_BYTES) {
    throw new UploadError('UPLOAD_TOO_LARGE', `upload chunk exceeds COSYNCING_UPLOAD_CHUNK_MAX_BYTES (${UPLOAD_CHUNK_MAX_BYTES})`, 413);
  }
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > UPLOAD_CHUNK_MAX_BYTES) {
      try {
        await reader.cancel();
      } catch {
        /* ignore cancel failures */
      }
      throw new UploadError('UPLOAD_TOO_LARGE', `upload chunk exceeds COSYNCING_UPLOAD_CHUNK_MAX_BYTES (${UPLOAD_CHUNK_MAX_BYTES})`, 413);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function transportEnvelopeFromRequest(req: Request, bytes: Uint8Array): StoredTransportEnvelope {
  const headers = transportForwardHeaders(req.headers);
  const from = req.headers.get('x-cosyncing-from')?.trim() || undefined;
  const to = req.headers.get('x-cosyncing-to')?.trim() || undefined;
  const mailboxToken = req.headers.get('x-cosyncing-to-token')?.trim() || '';
  if (!mailboxToken) throw new HttpStatusError(403, 'recipient mailbox token is required');
  const pairedToken = to ? transportPairings.verifyPeerToken(to, mailboxToken) : 'unknown';
  if (pairedToken === 'forbidden') throw new HttpStatusError(403, 'recipient mailbox token is not paired');
  return {
    id: req.headers.get('x-cosyncing-envelope-id')?.trim() || '',
    channel: req.headers.get('x-cosyncing-channel')?.trim() || '',
    bytes,
    expiresAt: Date.now() + TRANSPORT_MAILBOX_TTL_MS,
    mailboxTokenHash: transportMailboxTokenHash(mailboxToken),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
  };
}

function transportForwardHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    if (key.startsWith('x-cosyncing-wire-')) out[key] = value;
  }
  return out;
}

function transportEnvelopeJson(envelope: StoredTransportEnvelope): Record<string, unknown> {
  return {
    id: envelope.id,
    channel: envelope.channel,
    ...(envelope.from ? { from: envelope.from } : {}),
    ...(envelope.to ? { to: envelope.to } : {}),
    ...(envelope.headers ? { headers: envelope.headers } : {}),
    bytes: Buffer.from(envelope.bytes).toString('base64url'),
  };
}

function storedTransportEnvelopeToWire(envelope: StoredTransportEnvelope): TransportEnvelope {
  return {
    id: envelope.id,
    channel: envelope.channel,
    ...(envelope.from ? { from: envelope.from } : {}),
    ...(envelope.to ? { to: envelope.to } : {}),
    ...(envelope.headers ? { headers: envelope.headers } : {}),
    bytes: envelope.bytes,
  };
}

function replayCacheForTransportPeer(peerId: string): MemoryReplayCache {
  let cache = transportControlReplayCaches.get(peerId);
  if (!cache) {
    cache = new MemoryReplayCache({ maxEntries: 2000, ttlMs: TRANSPORT_MAILBOX_TTL_MS });
    transportControlReplayCaches.set(peerId, cache);
  }
  return cache;
}

function normalizeTransportControlPayload(payload: any): { tool: string; sessionId: string; mode?: string; message: any } {
  const tool = typeof payload?.tool === 'string' ? payload.tool.trim() : '';
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
  const mode = typeof payload?.mode === 'string' ? payload.mode.trim() : undefined;
  const kind = typeof payload?.kind === 'string' ? payload.kind.trim() : '';
  if (!tool || !sessionId) throw new HttpStatusError(400, 'transport session-control requires tool and sessionId');
  if (!['approve', 'answer', 'reject-question', 'plan-action'].includes(kind)) {
    throw new HttpStatusError(400, 'transport session-control kind must be approve, answer, reject-question, or plan-action');
  }
  const { tool: _tool, sessionId: _sessionId, mode: _mode, ...message } = payload;
  return { tool, sessionId, ...(mode ? { mode } : {}), message: { ...message, kind } };
}

function statusForTransportOpenError(err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err);
  if (/replay/i.test(msg)) return 409;
  if (/sender identity|not trusted|trusted sender/i.test(msg)) return 403;
  return 400;
}

function transportMailboxTokenHash(token: string): string {
  return tokenHash(token);
}

function pruneTransportMailbox(peer: string): StoredTransportEnvelope[] {
  const now = Date.now();
  const pruned = (transportMailboxes.get(peer) ?? []).filter((envelope) => envelope.expiresAt > now);
  if (pruned.length) transportMailboxes.set(peer, pruned);
  else transportMailboxes.delete(peer);
  return pruned;
}

function normalizeTokdashUrl(input: unknown): string {
  const raw = typeof input === 'string' && input.trim() ? input.trim() : TOKDASH_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Invalid Tokdash URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Tokdash URL must be http(s)');
  const host = parsed.hostname.toLowerCase();
  const local = host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host);
  if (!local) throw new Error('Tokdash URL must point at localhost for now');
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

async function fetchTokdashUsage(baseInput: unknown): Promise<Response> {
  let baseUrl: string;
  try {
    baseUrl = normalizeTokdashUrl(baseInput);
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
  }
  const checked: string[] = [];
  for (const path of TOKDASH_USAGE_PATHS) {
    const target = `${baseUrl}${path}`;
    checked.push(path);
    try {
      const res = await fetch(target, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) continue;
      const data = await res.json().catch(() => undefined);
      if (data !== undefined) return json({ ok: true, baseUrl, endpoint: path, data });
    } catch {
      /* Try the next likely Tokdash endpoint. */
    }
  }
  return json({ ok: false, baseUrl, checked, error: 'Tokdash usage API unavailable' }, 502);
}

// Legacy derived label, kept only for /api/health back-compat. The persisted, user-facing concept is now
// per-agent AgentSyncEnablement (setup-state.ts, D28) — there is no global control-mode "preference" type,
// and the `/api/broker/control-mode` picker endpoint is deleted (D17).
type ControlModeLabel = 'observe-drive' | 'true-sync-terminal';

function brokerControlModeState(): { controlMode: ControlModeLabel; codexSyncServer: boolean } {
  const codexSyncServer = process.env.COSYNCING_CODEX_SYNC_SERVER === '1';
  return {
    controlMode: codexSyncServer ? 'true-sync-terminal' : 'observe-drive',
    codexSyncServer,
  };
}

// The codexSync target of an in-flight restart (undefined = none scheduled). Boolean, because the
// restart machinery is now driven by the per-agent Codex enabler, not a global mode string (FU-3/D17).
// When a restart is armed, `restartScheduledFor` holds the LATEST desired COSYNCING_CODEX_SYNC_SERVER target;
// a counter-toggle inside the 100ms window UPDATES it (latest-wins) and the armed timer reads it at fire
// time, so the relaunched broker can never diverge from the just-persisted setup-state.json (the race the
// adversarial review caught). `undefined` = no restart armed.
let restartScheduledFor: boolean | undefined;

function scheduleBrokerRestart(): {
  controlMode: ControlModeLabel;
  codexSyncServer: boolean;
  restartRequired: boolean;
  restartScheduled: boolean;
  dryRun: boolean;
  service: BrokerServiceBoundary;
} {
  const current = brokerControlModeState();
  const dryRun = process.env.COSYNCING_RESTART_DRY_RUN === '1';
  if (!dryRun) {
    // Generic restart keeps the current codex-sync target (no change); arm the relaunch timer once.
    // Only SEED the target when none is armed (??=): a concurrent Codex-sync toggle may have already armed
    // a DIFFERENT latest-wins target, and a generic restart must not clobber it back to the stale live env
    // — that would relaunch with sync diverging from the just-persisted setup-state.json (FU-3 invariant).
    restartScheduledFor ??= current.codexSyncServer;
    scheduleRelaunchOnce();
  }
  return {
    ...current,
    restartRequired: true,
    restartScheduled: !dryRun,
    dryRun,
    service: SERVICE_BOUNDARY,
  };
}

// Arm the relaunch timer at most once; the timer reads the LATEST `restartScheduledFor` when it fires.
let relaunchTimerArmed = false;
let relaunchTimer: ReturnType<typeof setTimeout> | undefined;
let replacementCancelled = false;
function scheduleRelaunchOnce(): void {
  if (relaunchTimerArmed) return;
  relaunchTimerArmed = true;
  relaunchTimer = setTimeout(() => {
    relaunchTimer = undefined;
    if (shuttingDown || replacementCancelled) return;
    void (SERVICE_BOUNDARY.managed ? exitForServiceManagerRestart() : relaunchBrokerForControlMode());
  }, 100);
}

// Retained restart machinery (D17), repointed to the per-agent Codex enabler (FU-3): toggling Codex
// sync ON/OFF against an ALREADY-RUNNING broker needs a one-time restart, because codexCapabilities()
// captures COSYNCING_CODEX_SYNC_SERVER at construction. Fresh onboarding sets the env pre-start (see the
// FU-3 block near the top), so the common path never reaches here.
function scheduleBrokerControlModeRestart(codexSyncEnabled: boolean): {
  controlMode: ControlModeLabel;
  codexSyncServer: boolean;
  restartRequired: boolean;
  restartScheduled: boolean;
  dryRun: boolean;
  service: BrokerServiceBoundary;
} {
  const controlMode: ControlModeLabel = codexSyncEnabled ? 'true-sync-terminal' : 'observe-drive';
  const current = brokerControlModeState();
  const dryRun = process.env.COSYNCING_RESTART_DRY_RUN === '1';
  // A restart is needed if the FINAL desired target differs from the live env. If a restart is already
  // armed, the in-flight target is what will actually take effect, so re-arm it to THIS (latest) value.
  const restartRequired = current.codexSyncServer !== codexSyncEnabled;
  if (dryRun) {
    return {
      controlMode,
      codexSyncServer: codexSyncEnabled,
      restartRequired,
      restartScheduled: false,
      dryRun: true,
      service: SERVICE_BOUNDARY,
    };
  }
  if (restartRequired || restartScheduledFor !== undefined) {
    // Latest-wins: always record the most recent desired target (matches the just-persisted setup-state),
    // then arm the relaunch timer once. If a counter-toggle made desired === live, the relaunch becomes a
    // harmless same-target restart rather than a divergence.
    restartScheduledFor = codexSyncEnabled;
    scheduleRelaunchOnce();
  }
  // Report whether a relaunch was ACTUALLY armed: when the desired target already matches the live env and
  // nothing was previously armed, the if-block above is skipped (no timer) — restartScheduled must then be
  // false, not a hard-coded true (the panel reads this field).
  const scheduled = restartScheduledFor !== undefined;
  return {
    controlMode,
    codexSyncServer: codexSyncEnabled,
    restartRequired: restartRequired || scheduled,
    restartScheduled: scheduled,
    dryRun: false,
    service: SERVICE_BOUNDARY,
  };
}

async function exitForServiceManagerRestart(): Promise<void> {
  console.log(`${LOG_PREFIX} handing restart to ${SERVICE_BOUNDARY.provider}`);
  await shutdownBroker(`${SERVICE_BOUNDARY.provider}-restart`);
  process.exit(SERVICE_RESTART_EXIT_CODE);
}

async function relaunchBrokerForControlMode(): Promise<void> {
  const cmd = brokerRelaunchCommand({
    identity: APPLICATION_IDENTITY,
    argv: process.argv,
  });
  // Tear down the broker-owned opencode serve (D20) and WAIT for it to exit BEFORE we stop the listener +
  // spawn the replacement, so the replacement re-launches a fresh one instead of colliding with — or
  // silently adopting then leaking — a still-dying old child (the restart race the review caught).
  await stopManagedOpencodeServe();
  if (shuttingDown || replacementCancelled) return;
  try {
    server?.stop(true);
  } catch (err) {
    console.error(`${LOG_PREFIX} failed to stop listener before restart: ${String(err)}`);
  }
  await shutdownBroker('restart');
  if (replacementCancelled) return;
  // Read the LATEST desired target AFTER stopping the listener — never a value captured at the top. The
  // listener stays up through the (up-to-2s) opencode teardown await above, so a counter-toggle can still
  // update restartScheduledFor until server.stop(true). Reading it HERE preserves latest-wins: once the
  // listener is down no further toggle can land, so the relaunched broker's env can never diverge from the
  // just-persisted setup-state.json. Fall back to the live env for a generic restart that armed without a
  // codex-sync change.
  const codexSyncEnabled = restartScheduledFor ?? brokerControlModeState().codexSyncServer;
  const env: Record<string, string | undefined> = {
    ...process.env,
    COSYNCING_CODEX_SYNC_SERVER: codexSyncEnabled ? '1' : '0',
  };
  console.log(
    `${LOG_PREFIX} restarting broker for codexSync=${codexSyncEnabled} (COSYNCING_CODEX_SYNC_SERVER=${env.COSYNCING_CODEX_SYNC_SERVER})`,
  );
  setTimeout(() => {
    try {
      const child = Bun.spawn(cmd, {
        cwd: process.cwd(),
        env,
        detached: true,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      });
      child.unref();
    } catch (err) {
      console.error(`${LOG_PREFIX} failed to spawn replacement broker: ${String(err)}`);
    } finally {
      setTimeout(() => process.exit(0), 50);
    }
  }, 150);
}

function statusRank(s: SessionInfo): number {
  // most actionable first: needs-input (blocked on you) → working → idle
  return s.status === 'needs-input' ? 0 : s.status === 'working' ? 1 : 2;
}

/** Resolve `rel` under `baseDir` and refuse anything that escapes it. Resolves the joined path and
 *  requires the result to stay under the resolved base, which blocks `..`, absolute paths, and (once
 *  decoded) encoded traversal alike. Returns the absolute on-disk path, or null when the request tries
 *  to escape the dir. */
function resolveUnder(baseDir: string, rel: string): string | null {
  const base = resolve(baseDir);
  const abs = resolve(base, rel);
  return abs === base || abs.startsWith(base + '/') ? abs : null;
}

/** A request looks like a static ASSET (vs. a client-side NAVIGATION) when its last path segment has a
 *  file extension — e.g. `foo.js` / `x.wasm` are assets, `sessions/123` is a navigation. Drives the SPA
 *  fallback: a missing asset is a real 404, a missing navigation loads index.html. */
function hasFileExtension(rel: string): boolean {
  return rel.slice(rel.lastIndexOf('/') + 1).includes('.');
}

/** Stamp cross-origin-isolation headers on a /cosy/ response when COSYNCING_WEB_COI is on (see WEB_COI).
 *  COOP+COEP unlock SharedArrayBuffer; CORP `same-origin` lets our own same-origin assets pass require-corp. */
function applyCoi(headers: Headers): Headers {
  if (WEB_COI) {
    headers.set('cross-origin-opener-policy', 'same-origin');
    headers.set('cross-origin-embedder-policy', 'require-corp');
    headers.set('cross-origin-resource-policy', 'same-origin');
  }
  return headers;
}

/** Flutter shell files that must never be cached, because each carries build identity rather than
 *  content-addressed payload. See the rationale where these are applied in {@link serveFlutter}. */
const FLUTTER_UNCACHED_SHELL_FILES: ReadonlySet<string> = new Set([
  'index.html',
  'flutter_bootstrap.js',
  'flutter_service_worker.js',
  'version.json',
]);

/** Serve the Flutter web build (mounted at /cosy/) with SPA fallback and path-traversal hardening.
 *  `rawRel` is the request path with the `/cosy/` prefix already stripped ('' means the index). */
async function serveFlutter(rawRel: string): Promise<Response> {
  const indexPath = resolve(COSYNCING_WEB_DIR, 'index.html');
  // "Not built" grace: the Flutter build is produced under apps/client and may simply be absent. Never
  // crash — return a clear 404 so the broker still serves everything else normally.
  //
  // Two different people read this page. On a source run it is a developer who skipped the build step and
  // needs the command. On a packaged install it is whoever opened the URL the outro printed, and telling
  // them to "run the monorepo client web build with --base-href /cosy/" is a maintainer's note leaking into
  // an end user's browser — observed on a physical npm install (2026-08-05). The npm tarball routinely ships
  // without the web sidecar, so this is the ORDINARY packaged answer, not an error state, and it says the
  // one thing that actually gets that person to a working client.
  if (!(await Bun.file(indexPath).exists())) {
    return new Response(
      BUILD_INFO.packaged
        ? `${PRODUCT_IDENTITY.productName} is running, but this build includes no web app.\n`
          + `Run \`${PRODUCT_IDENTITY.primaryBinary} pair\` and scan the QR to pair a client.\n`
        : 'Flutter web build not found — run the monorepo client web build with --base-href /cosy/',
      { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }
  let rel = rawRel === '' ? 'index.html' : rawRel;
  // Decode percent-escapes first so an encoded traversal (`..%2f..`) is caught by the resolved-prefix
  // check below rather than sneaking through as an opaque single filename.
  try { rel = decodeURIComponent(rel); } catch { return new Response('bad path', { status: 400 }); }
  const abs = resolveUnder(COSYNCING_WEB_DIR, rel);
  if (!abs) return new Response('bad path', { status: 400 });
  const file = Bun.file(abs);
  if (await file.exists()) {
    const headers = new Headers();
    if (file.type) headers.set('content-type', file.type);
    // Flutter web content-hashes NOTHING, so a cached shell serves stale code forever after a rebuild.
    // The load-bearing file is flutter_bootstrap.js: it carries `serviceWorkerVersion`, and it is the ONLY
    // signal by which the service worker learns a new build exists. Cached, the worker keeps serving the
    // previous main.dart.js from its own cache and a plain refresh never recovers — the user sees code
    // that no longer exists on disk (observed 2026-07-19: a rebuilt mount kept rendering the old bundle
    // until the site data was cleared; an incognito window showed the new one).
    //
    // Keeping these four uncached restores Flutter's intended update path: the worker re-reads the version
    // each load and re-fetches the app itself, so main.dart.js does NOT need `no-store` here and is not
    // re-downloaded on every page load.
    if (FLUTTER_UNCACHED_SHELL_FILES.has(rel)) headers.set('cache-control', 'no-store');
    return new Response(file, { headers: applyCoi(headers) });
  }
  // SPA fallback: a missing NAVIGATION (no file extension, e.g. a deep-linked `sessions/123` refresh)
  // returns index.html so the client router can take over; a missing ASSET (has an extension) is a 404.
  if (hasFileExtension(rel)) return new Response('Not found', { status: 404 });
  const index = Bun.file(indexPath);
  const headers = new Headers();
  if (index.type) headers.set('content-type', index.type);
  headers.set('cache-control', 'no-store');
  return new Response(index, { headers: applyCoi(headers) });
}

// Fail-closed at boot on an unsafe R2 registry: a session-mutating action bound to the weak
// `session-timestamp` revision is refused before we listen (maintainer Decision #2, 2026-07-08).
assertR2ActionsSafe();

server = Bun.serve<WsData>({
  port: PORT,
  hostname: LISTEN_HOST,
  idleTimeout: 240,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Packaged v1 has no Claude hook surface. Return absence before authentication so an inherited shared
    // token cannot turn the intentionally missing routes into a misleading 401-discoverable feature.
    if (BUILD_INFO.packaged && (path === '/api/claude/hooks' || path.startsWith('/claude/hook/'))) {
      return new Response('Not found', { status: 404 });
    }

    // Auth model (no-op when no token is configured = the loopback baseline; a non-loopback bind REQUIRES a
    // token, see the bind guard below). DEFAULT-DENY: every MUTATING request (POST/PATCH/DELETE) needs the
    // token, so a newly-added control route is gated by construction rather than by remembering to allowlist
    // it — this is what closes the send_file / restart / codex-sync / createSession / rename gaps the review
    // caught. Plus the explicitly-listed paths that are GETs but still sensitive: the WS stream (a GET upgrade
    // that carries prompts/answers), the Pi-bridge legs (incl. the GET command long-poll that drives the
    // agent), the Claude hook legs, and the Claude hooks install-status. Most read-only GETs (roster,
    // public liveness, usage, agents, artifact serving) stay open; sensitive detail such as broker health
    // and attention history is explicitly gated below. Every legitimate client — the app (x-cosyncing-token on its
    // control fetches), the Pi extension, the Claude hook, the OpenCode send_file tool — carries the token.
    const mutating = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
    const isPairingAccept = /^\/api\/transport\/pairings\/[^/]+\/accept$/.test(path) && req.method === 'POST';
    const isPiIntegrationRoute = path.startsWith('/pi/bridge/');
    const isResumeStream = url.searchParams.get('mode') === 'resume'
      && /^\/api\/sessions\/[^/]+\/[^/]+\/stream$/.test(path);
    if (
      !authed(req, url, path) &&
      (
        (mutating && !isPairingAccept) ||
        path.startsWith('/api/machines') ||
        path === '/api/attention-events' ||
        path.startsWith('/api/schedules') || // scheduled sends carry full prompt texts
        path === '/api/broker/health' ||
        path === '/api/broker/update' ||
        path === '/api/tokdash/quota' ||
        path === '/api/tokdash/quota-preference' ||
        /^\/api\/sessions\/[^/]+\/[^/]+\/uploads$/.test(path) ||
        /^\/api\/sessions\/[^/]+\/[^/]+\/uploads\/[^/]+$/.test(path) ||
        /^\/api\/sessions\/[^/]+\/[^/]+\/uploads\/[^/]+\/complete$/.test(path) ||
        /^\/api\/sessions\/[^/]+\/[^/]+\/stream$/.test(path) ||
        /^\/api\/sessions\/[^/]+\/[^/]+\/fs$/.test(path) ||
        /^\/api\/sessions\/[^/]+\/[^/]+\/fs\/read$/.test(path) ||
        /^\/api\/sessions\/[^/]+\/[^/]+\/fs\/download$/.test(path) ||
        path === '/api/push/wake-tokens' ||
        /^\/api\/push\/wake-tokens\/[^/]+$/.test(path) ||
        (path.startsWith('/api/transport/') && !isPairingAccept) ||
        path.startsWith('/claude/hook/') ||
        path === '/api/claude/hooks' ||
        path.startsWith('/pi/bridge/')
      )
    ) {
      const incidentKey = authFailureAttention.recordFailure();
      if (incidentKey) {
        await attentionService.upsertEvent({
          dedupeKey: incidentKey,
          kind: 'security-alert',
          state: 'resolved',
          severity: 'action-required',
          title: 'Repeated broker authentication failures',
          summary: 'Several requests failed broker authentication in a short period.',
          action: { kind: 'open-attention-inbox' },
          presentationRevision: 1,
          presentationStage: 'immediate',
        });
      }
      return isResumeStream
        ? json({ ok: false, code: 'RESUME_AUTH_REQUIRED', error: 'authenticated credential required for Drive resume' }, 401)
        : isPiIntegrationRoute
        ? json({ ok: false, code: 'PI_INTEGRATION_AUTH_REQUIRED', error: 'Pi integration authentication required' }, 401)
        : new Response('unauthorized', { status: 401 });
    }

    const ws = path.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/stream$/);
    if (ws) {
      const requestedMode = url.searchParams.get('mode') ?? undefined; // e.g. ?mode=resume → drivable attach
      if (requestedMode === 'resume' && !credentialAuthenticated(req, url)) {
        return json({ ok: false, code: 'RESUME_AUTH_REQUIRED', error: 'authenticated credential required for Drive resume' }, 401);
      }
      const clientContract = parseWsClientContract(url.searchParams);
      if (clientContract.error) {
        return json({ ok: false, code: 'BAD_PARAM', error: clientContract.error }, 400);
      }
      const requestedReason = url.searchParams.get('reason') ?? undefined;
      if (requestedReason !== undefined
        && !(DRIVE_ATTACH_REASONS as readonly string[]).includes(requestedReason)) {
        return json({ ok: false, code: 'BAD_PARAM', error: `unknown attach reason: ${requestedReason}` }, 400);
      }
      if (requestedReason !== undefined && requestedMode !== 'resume' && requestedMode !== 'live') {
        return json({ ok: false, code: 'BAD_PARAM', error: 'attach reason requires mode=resume or mode=live' }, 400);
      }
      // The reason/mode matrix, not merely "a reason is allowed on live".
      // `create`, `app-restore` and `lease-restore` all describe reopening a
      // Drive connection this app previously owned, which is the resume path;
      // on `live` they would name a provenance the live path cannot have.
      // `takeover` is the only intent that means "seize the running session",
      // which is what a live attach does.
      if (requestedMode === 'live' && requestedReason !== undefined && requestedReason !== 'takeover') {
        return json({ ok: false, code: 'BAD_PARAM', error: `attach reason ${requestedReason} requires mode=resume` }, 400);
      }
      // A reason-tagged LIVE takeover crosses the same explicit Drive
      // credential boundary as resume. The outer `authed` gate already covers
      // every session stream, so this is not a general remote-auth bypass —
      // but in the tokenless loopback baseline `authed` proves nothing about
      // credentials, and `credentialAuthenticated` is what proves an actual
      // shared or peer credential was supplied. Without this, takeover — the
      // one attach that seizes Drive from a live owner — would be the only
      // drive attach that never crossed the boundary.
      //
      // Reusing RESUME_AUTH_REQUIRED is deliberate. The code names the
      // boundary, not the mode, and BROKER_ERROR_CODES feeds
      // BROKER_CONTRACT_SURFACE_HASH: a new code moves the hash, and every
      // client on this same revision would then evaluate as hard-incompatible
      // and be forced read-only. Renaming a 401 is not worth that.
      if (requestedReason !== undefined && requestedMode === 'live'
        && !credentialAuthenticated(req, url)) {
        return json({ ok: false, code: 'RESUME_AUTH_REQUIRED', error: 'authenticated credential required for Drive takeover' }, 401);
      }
      const ownerEpoch = url.searchParams.get('ownerEpoch')?.trim() || undefined;
      const ownerSeqRaw = url.searchParams.get('ownerSeq');
      let expectedOwnerRevision: SessionOwnerRevision | undefined;
      if (requestedReason === 'join-existing') {
        const ownerSeq = ownerSeqRaw == null ? Number.NaN : Number(ownerSeqRaw);
        if (!ownerEpoch
          || ownerEpoch.length > 128
          || /[\0\r\n]/.test(ownerEpoch)
          || !Number.isSafeInteger(ownerSeq)
          || ownerSeq < 0) {
          return json({ ok: false, code: 'BAD_PARAM', error: 'join-existing requires a valid ownerEpoch and ownerSeq' }, 400);
        }
        expectedOwnerRevision = { epoch: ownerEpoch, seq: ownerSeq };
      } else if (ownerEpoch !== undefined || ownerSeqRaw !== null) {
        return json({ ok: false, code: 'BAD_PARAM', error: 'owner revision requires reason=join-existing' }, 400);
      }
      const negotiated = evaluateBrokerClientCompatibility(clientContract.client);
      // A client may DECLARE that it cannot accept mutation authority on this
      // socket. The case that forces this to exist: a client reads a session
      // whose `attachMode` its contract revision does not know, so it cannot
      // reason about what attaching means. Omitting `mode` is not the same
      // answer — a bare attach is read-only for one adapter, refused by
      // another, and full-authority for a third (opencode's shared serve, the
      // codex daemon proxy), so "attach without asking" can still land on a
      // mutable connection. Only the broker can make it uniform, so the client
      // says what it needs and the broker enforces it socket-locally.
      //
      // Folded into the socket's compatibility rather than tracked beside it,
      // because "this socket is read-only" is one fact with one set of
      // consequences — forced observe, refused mutations, no published
      // authority, no join offer — and a second flag would be a second place
      // for one of them to be forgotten. The negotiated STATUS is untouched:
      // the contract is fine, it is this attach that renounces authority. That
      // also carries the posture to the client in the hello it already reads,
      // so it stops offering Take over and a live composer.
      const readOnlyRequested = url.searchParams.get('readOnly') === '1';
      const compatibility: BrokerClientCompatibility = readOnlyRequested && !negotiated.readOnly
        ? {
          ...negotiated,
          readOnly: true,
          reason: 'this client attached read-only: it cannot interpret this session\'s attach mode',
        }
        : negotiated;
      const mode = compatibility.readOnly ? 'observe' : requestedMode;
      // Carried for both drive modes. A read-only fold has already rewritten
      // `mode` to observe, which drops the reason with it — an attach that
      // renounced authority cannot be tagged with an intent to take it.
      const reason = mode === 'resume' || mode === 'live'
        ? (requestedReason as DriveAttachReason | undefined)
        : undefined;
      const artifactMode = url.searchParams.get('artifactMode') === 'reference' ? 'reference' : 'inline';
      const since = url.searchParams.get('ticket') || url.searchParams.get('since') || undefined;
      const historyLimit = parseInitialHistoryLimit(url.searchParams);
      const ok = srv.upgrade(req, {
        data: {
          tool: decodeURIComponent(ws[1]!),
          id: decodeURIComponent(ws[2]!),
          mode,
          readOnlyRequested,
          ...(reason ? { reason } : {}),
          ...(expectedOwnerRevision ? { expectedOwnerRevision } : {}),
          since,
          historyLimit,
          artifactMode,
          identity: requestCredentialIdentity(req, url),
          uploadIdentity: requestUploadIdentity(req, url),
          compatibility,
          credentialAuthenticated: credentialAuthenticated(req, url),
          ...(clientContract.clientVersion ? { clientVersion: clientContract.clientVersion } : {}),
        },
      });
      return ok ? undefined : new Response('upgrade failed', { status: 426 });
    }

    const artifact = path.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/artifact\/([^/]+)$/);
    if (artifact && req.method === 'GET') {
      return artifactStore.serve(
        decodeURIComponent(artifact[1]!),
        decodeURIComponent(artifact[2]!),
        decodeURIComponent(artifact[3]!),
        url.searchParams.get('expires'),
        url.searchParams.get('sig'),
      );
    }

    if (path === '/api/transport/pairings' && req.method === 'POST') {
      try {
        const body = await req.json().catch(() => ({})) as any;
        const offer = transportPairings.createOffer({
          clientLabel: typeof body?.clientLabel === 'string' ? body.clientLabel.trim() : undefined,
          brokerUrl: body?.brokerUrl,
        });
        return json({ ok: true, ...offer }, 201);
      } catch (err) {
        if (err instanceof PairingHttpError) return json({ error: err.message, code: err.code }, err.status);
        throw err;
      }
    }

    const pairingStatus = path.match(/^\/api\/transport\/pairings\/([^/]+)$/);
    if (pairingStatus && req.method === 'GET') {
      const status = transportPairings.getOfferStatus(decodeURIComponent(pairingStatus[1]!));
      return status
        ? json({ ok: true, ...status })
        : json({ ok: false, code: 'PAIRING_NOT_FOUND', error: 'pairing offer not found' }, 404);
    }

    const acceptPairing = path.match(/^\/api\/transport\/pairings\/([^/]+)\/accept$/);
    if (acceptPairing && req.method === 'POST') {
      try {
        const body = await req.json().catch(() => ({})) as any;
        const accepted = transportPairings.accept(decodeURIComponent(acceptPairing[1]!), {
          peerId: String(body?.peerId ?? ''),
          peerToken: String(body?.peerToken ?? ''),
          identityPublicKey: String(body?.identityPublicKey ?? ''),
          exchangePublicKey: String(body?.exchangePublicKey ?? ''),
        });
        await attentionService.upsertEvent({
          dedupeKey: `device-paired:${accepted.peer.peerId}:${Date.now()}`,
          kind: 'device-paired',
          state: 'resolved',
          severity: 'informational',
          title: 'New device paired',
          summary: 'A new device was connected to this broker.',
          action: { kind: 'open-attention-inbox' },
          presentationRevision: 1,
          presentationStage: 'immediate',
        });
        return json({ ok: true, ...accepted, brokerDescriptor: BROKER_DESCRIPTOR });
      } catch (err) {
        if (err instanceof PairingHttpError) return json({ error: err.message, code: err.code }, err.status);
        throw err;
      }
    }

    if (path === '/api/transport/peers' && req.method === 'GET') {
      return json({ ok: true, peers: transportPairings.listPeers() });
    }

    const revokeTransportPeer = path.match(/^\/api\/transport\/peers\/([^/]+)$/);
    if (revokeTransportPeer && req.method === 'DELETE') {
      const peerId = decodeURIComponent(revokeTransportPeer[1]!);
      const revoked = transportPairings.revoke(peerId);
      transportMailboxes.delete(peerId);
      transportControlReplayCaches.delete(peerId);
      if (revoked) {
        await attentionService.upsertEvent({
          dedupeKey: `security-alert:revoked:${peerId}:${Date.now()}`,
          kind: 'security-alert',
          state: 'resolved',
          severity: 'action-required',
          title: 'Device access revoked',
          summary: 'A paired device was removed from this broker.',
          action: { kind: 'open-attention-inbox' },
          presentationRevision: 1,
          presentationStage: 'immediate',
        });
      }
      return json({ ok: true, revoked });
    }

    if (path === '/api/transport/session-control' && req.method === 'POST') {
      let envelope: StoredTransportEnvelope;
      try {
        envelope = transportEnvelopeFromRequest(req, await readTransportRequestBytes(req));
        if (!envelope.id || !envelope.channel || !envelope.from || !envelope.to) {
          throw new HttpStatusError(400, 'envelope id, channel, sender, and recipient are required');
        }
        if (envelope.channel !== 'session-control') throw new HttpStatusError(400, 'session-control envelopes must use channel session-control');
      } catch (err) {
        if (err instanceof HttpStatusError) return json({ error: err.message }, err.status);
        throw err;
      }
      const peer = transportPairings.brokerMaterialForRecipient(envelope.to);
      if (!peer) return json({ error: 'recipient is not an active broker transport peer' }, 403);
      if (envelope.from !== peer.peerId) return json({ error: 'sender does not match paired peer' }, 403);
      let control: ReturnType<typeof normalizeTransportControlPayload>;
      try {
        const opened = openTransportEnvelope(peer.dataKey, storedTransportEnvelopeToWire(envelope), {
          trustedSenderPublicKey: peer.identityPublicKey,
          replayCache: replayCacheForTransportPeer(peer.peerId),
        });
        control = normalizeTransportControlPayload(JSON.parse(new TextDecoder().decode(opened.bytes)));
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, statusForTransportOpenError(err));
      }
      const mc = hub.getConn(control.tool, control.sessionId);
      const events: WireEvent[] = [];
      if (mc) {
        await handleManagedClientMessage(mc, control.message, (event) => events.push(event), {
          journalScope: { identity: `transport-peer:${peer.peerId}`, tool: control.tool, sessionId: control.sessionId },
        });
        return json({ ok: true, control: { kind: control.message.kind, tool: control.tool, sessionId: control.sessionId, mode: control.mode, routed: true, events } }, 202);
      }
      return json({
        ok: true,
        control: {
          kind: control.message.kind,
          tool: control.tool,
          sessionId: control.sessionId,
          mode: control.mode,
          routed: false,
          reason: 'no attached session owner for encrypted control payload',
        },
      }, 202);
    }

    if (path === '/api/transport/envelopes' && req.method === 'POST') {
      let bytes: Uint8Array;
      let envelope: StoredTransportEnvelope;
      try {
        bytes = await readTransportRequestBytes(req);
        envelope = transportEnvelopeFromRequest(req, bytes);
      } catch (err) {
        if (err instanceof HttpStatusError) return json({ error: err.message }, err.status);
        throw err;
      }
      if (!envelope.id || !envelope.channel || !envelope.to) return json({ error: 'envelope id, channel, and recipient are required' }, 400);
      const mailbox = pruneTransportMailbox(envelope.to);
      mailbox.push(envelope);
      while (mailbox.length > TRANSPORT_MAILBOX_MAX) mailbox.shift();
      transportMailboxes.set(envelope.to, mailbox);
      return json({ ok: true, id: envelope.id, queued: mailbox.length }, 202);
    }

    if (path === '/api/transport/envelopes' && req.method === 'GET') {
      const peer = url.searchParams.get('peer')?.trim() || '';
      if (!peer) return json({ error: 'peer is required' }, 400);
      const peerToken = req.headers.get('x-cosyncing-peer-token')?.trim() || '';
      if (!peerToken) return json({ error: 'peer mailbox token is required' }, 403);
      const registered = transportPairings.verifyPeerToken(peer, peerToken);
      if (registered === 'forbidden') return json({ error: 'peer mailbox token is not paired' }, 403);
      const peerTokenHash = transportMailboxTokenHash(peerToken);
      const channel = url.searchParams.get('channel')?.trim() || '';
      const mailbox = pruneTransportMailbox(peer);
      const keep: StoredTransportEnvelope[] = [];
      const out: StoredTransportEnvelope[] = [];
      for (const envelope of mailbox) {
        if (envelope.mailboxTokenHash === peerTokenHash && (!channel || envelope.channel === channel)) out.push(envelope);
        else keep.push(envelope);
      }
      if (keep.length) transportMailboxes.set(peer, keep);
      else transportMailboxes.delete(peer);
      return json({ ok: true, envelopes: out.map(transportEnvelopeJson) });
    }

    if (path === '/api/push/wake-tokens' && req.method === 'POST') {
      const body: any = await req.json().catch(() => ({}));
      try {
        const registration = wakePush.register({
          deviceId: body?.deviceId,
          platform: body?.platform,
          token: String(body?.token ?? ''),
          label: typeof body?.label === 'string' ? body.label : undefined,
        });
        void attentionScheduler.tick().catch(() => {});
        return json({ ok: true, registration }, 201);
      } catch (err) {
        return wakePushErrorResponse(err);
      }
    }

    if (path === '/api/push/wake-tokens' && req.method === 'GET') {
      return json({ ok: true, registrations: wakePush.list() });
    }

    const revokeWakeToken = path.match(/^\/api\/push\/wake-tokens\/([^/]+)$/);
    if (revokeWakeToken && req.method === 'DELETE') {
      try {
        const revoked = wakePush.revoke(decodeURIComponent(revokeWakeToken[1]!));
        return json({ ok: true, revoked });
      } catch (err) {
        return wakePushErrorResponse(err);
      }
    }

    if (path === '/api/push/wake' && req.method === 'POST') {
      const body: any = await req.json().catch(() => ({}));
      try {
        const registration = wakePush.get(String(body?.deviceId ?? ''));
        const result = await dispatchWakePush(registration);
        return json(result, 202);
      } catch (err) {
        return wakePushErrorResponse(err);
      }
    }

    if (path === '/api/attention-events' && req.method === 'GET') {
      const parseInteger = (name: string, fallback: number | undefined): number | undefined => {
        const raw = url.searchParams.get(name);
        if (raw == null || raw === '') return fallback;
        const value = Number(raw);
        if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
        return value;
      };
      try {
        const clientId = url.searchParams.get('clientId') ?? '';
        const after = parseInteger('after', undefined);
        const limit = parseInteger('limit', 100);
        const waitMs = parseInteger('waitMs', 0);
        return json(await attentionService.getEvents({ clientId, after, limit, waitMs }));
      } catch (error) {
        return json({ ok: false, code: 'BAD_PARAM', error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }

    if (path === '/api/attention-events/dismiss-batch' && req.method === 'POST') {
      try {
        const body = await req.json().catch(() => ({})) as Record<string, unknown>;
        return json(await attentionService.dismissBatch(body.events, body.clientId));
      } catch (error) {
        return json({
          ok: false,
          code: 'BAD_PARAM',
          error: error instanceof Error ? error.message : String(error),
        }, 400);
      }
    }

    const attentionAck = path.match(/^\/api\/attention-events\/([^/]+)\/ack$/);
    const attentionDismiss = path.match(/^\/api\/attention-events\/([^/]+)\/dismiss$/);
    const attentionMutation = attentionAck ?? attentionDismiss;
    if (attentionMutation && req.method === 'POST') {
      try {
        const eventId = decodeURIComponent(attentionMutation[1]!);
        const body = await req.json().catch(() => ({})) as any;
        const result = attentionAck
          ? await attentionService.acknowledge(eventId, body?.clientId)
          : await attentionService.dismiss(eventId, body?.clientId);
        if (!result) return json({ ok: false, code: 'NOT_FOUND', error: 'attention event not found' }, 404);
        return json({ ok: true, clientState: result });
      } catch (error) {
        return json({ ok: false, code: 'BAD_PARAM', error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }

    const clearCache = path.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/cache$/);
    if (clearCache && req.method === 'DELETE') {
      const cleared = artifactStore.clearSession(decodeURIComponent(clearCache[1]!), decodeURIComponent(clearCache[2]!));
      return json({ ok: true, clearedArtifacts: cleared });
    }

    const fsList = path.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/fs$/);
    if (fsList && req.method === 'GET') {
      const trustDenied = fsTrustGate(req, srv);
      if (trustDenied) return trustDenied;
      const tool = decodeURIComponent(fsList[1]!);
      const id = decodeURIComponent(fsList[2]!);
      const base = await discoverSession(tool, id);
      if (!base) return json({ ok: false, error: 'session not found', code: 'NOT_FOUND' }, 404);
      if (!base.cwd) return json({ ok: false, error: 'session has no workspace directory', code: 'NO_CWD' }, 404);
      const queryPath = url.searchParams.get('path');
      try {
        const stat = readSessionStat(base.cwd, queryPath);
        if (stat.isDirectory) {
          const directory = readSessionDirectory(base.cwd, queryPath);
          return json({ ok: true, path: directory.path, stat: directory.stat, entries: directory.entries });
        }
        return json({ ok: true, path: stat.path, stat });
      } catch (err) {
        return sessionBrowseErrorResponse(err);
      }
    }

    const fsRead = path.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/fs\/read$/);
    if (fsRead && req.method === 'GET') {
      const trustDenied = fsTrustGate(req, srv);
      if (trustDenied) return trustDenied;
      const tool = decodeURIComponent(fsRead[1]!);
      const id = decodeURIComponent(fsRead[2]!);
      const base = await discoverSession(tool, id);
      if (!base) return json({ ok: false, error: 'session not found', code: 'NOT_FOUND' }, 404);
      if (!base.cwd) return json({ ok: false, error: 'session has no workspace directory', code: 'NO_CWD' }, 404);
      const queryPath = url.searchParams.get('path');
      let maxBytes = FS_READ_CAP_BYTES;
      try {
        maxBytes = parseFsReadLimit(url.searchParams.get('maxBytes'));
      } catch (err) {
        return sessionBrowseErrorResponse(err);
      }
      try {
        const read = readSessionFile(base.cwd, queryPath, maxBytes, FS_READ_CAP_BYTES);
        return json({ ok: true, ...read, mimeType: mimeTypeForPath(read.path) });
      } catch (err) {
        return sessionBrowseErrorResponse(err);
      }
    }

    const fsDownload = path.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/fs\/download$/);
    if (fsDownload && req.method === 'GET') {
      const trustDenied = fsTrustGate(req, srv);
      if (trustDenied) return trustDenied;
      const tool = decodeURIComponent(fsDownload[1]!);
      const id = decodeURIComponent(fsDownload[2]!);
      const base = await discoverSession(tool, id);
      if (!base) return json({ ok: false, error: 'session not found', code: 'NOT_FOUND' }, 404);
      if (!base.cwd) return json({ ok: false, error: 'session has no workspace directory', code: 'NO_CWD' }, 404);
      const queryPath = url.searchParams.get('path');
      let download: ReturnType<typeof prepareSessionDownload>;
      try {
        download = prepareSessionDownload(base.cwd, queryPath, FS_DOWNLOAD_MAX_BYTES);
      } catch (err) {
        return sessionBrowseErrorResponse(err);
      }
      const filename = attachmentFilename(download.path.split('/').pop() || 'download');
      const mimeType = mimeTypeForPath(download.path);
      const commonHeaders: Record<string, string> = {
        'accept-ranges': 'bytes',
        'etag': download.etag,
        'last-modified': new Date(download.mtimeMs).toUTCString(),
        'content-type': mimeType,
        'x-cosyncing-mime-type': mimeType,
        'content-disposition': `attachment; filename=\"${filename}\"`,
        'x-content-type-options': 'nosniff',
      };
      let range;
      try {
        range = ifRangeMatches(req.headers.get('if-range'), download.etag, download.mtimeMs)
          ? parseDownloadRange(req.headers.get('range'), download.size)
          : undefined;
      } catch (error) {
        closeSync(download.fd);
        if (!(error instanceof DownloadRangeError)) throw error;
        return new Response(null, {
          status: 416,
          headers: {
            ...commonHeaders,
            'content-range': `bytes */${download.size}`,
            'content-length': '0',
          },
        });
      }
      const stream = createReadStream(download.abs, {
        fd: download.fd,
        autoClose: true,
        ...(range ? { start: range.start, end: range.end } : {}),
      });
      const contentLength = range ? range.end - range.start + 1 : download.size;
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
        status: range ? 206 : 200,
        headers: {
          ...commonHeaders,
          'content-length': String(contentLength),
          ...(range ? { 'content-range': `bytes ${range.start}-${range.end}/${download.size}` } : {}),
        },
      });
    }

    const uploadInit = path.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/uploads$/);
    if (uploadInit && req.method === 'POST') {
      const tool = decodeURIComponent(uploadInit[1]!);
      const id = decodeURIComponent(uploadInit[2]!);
      const base = await discoverSession(tool, id);
      if (!base) return json({ ok: false, error: 'session not found', code: 'NOT_FOUND' }, 404);
      if (!base.cwd) return json({ ok: false, error: 'session has no workspace directory', code: 'NO_CWD' }, 404);
      let body: any = {};
      try {
        body = await req.json();
      } catch {
        /* empty body accepted only if name/mimeType provided from elsewhere */
      }
      try {
        const result = uploadStaging.init({
          tool,
          sessionId: id,
          name: String(body?.name ?? ''),
          mimeType: typeof body?.mimeType === 'string' ? body.mimeType : 'application/octet-stream',
          expectedSize: typeof body?.size === 'number' ? body.size : undefined,
          contentHash: typeof body?.contentHash === 'string' ? body.contentHash : undefined,
        }, requestUploadIdentity(req, url));
        return json({ ok: true, ...result });
      } catch (err) {
        return uploadErrorResponse(err);
      }
    }

    const uploadComplete = path.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/uploads\/([^/]+)\/complete$/);
    if (uploadComplete && req.method === 'POST') {
      const tool = decodeURIComponent(uploadComplete[1]!);
      const id = decodeURIComponent(uploadComplete[2]!);
      const uploadId = decodeURIComponent(uploadComplete[3]!);
      const base = await discoverSession(tool, id);
      if (!base) return json({ ok: false, error: 'session not found', code: 'NOT_FOUND' }, 404);
      if (!base.cwd) return json({ ok: false, error: 'session has no workspace directory', code: 'NO_CWD' }, 404);
      try {
        const result = await uploadStaging.complete(
          tool,
          id,
          uploadId,
          base.cwd,
          requestUploadIdentity(req, url),
        );
        return json({ ok: true, ...result });
      } catch (err) {
        return uploadErrorResponse(err);
      }
    }

    const uploadStatus = path.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/uploads\/([^/]+)$/);
    if (uploadStatus) {
      const tool = decodeURIComponent(uploadStatus[1]!);
      const id = decodeURIComponent(uploadStatus[2]!);
      const uploadId = decodeURIComponent(uploadStatus[3]!);
      if (req.method === 'GET') {
        try {
          const status = uploadStaging.status(
            tool,
            id,
            uploadId,
            requestUploadIdentity(req, url),
          );
          return json({ ok: true, ...status });
        } catch (err) {
          return uploadErrorResponse(err);
        }
      }
      if (req.method === 'DELETE') {
        try {
          uploadStaging.discard(
            tool,
            id,
            uploadId,
            requestUploadIdentity(req, url),
          );
          return json({ ok: true, removed: true });
        } catch (err) {
          return uploadErrorResponse(err);
        }
      }
      if (req.method === 'PATCH') {
        let offset: string | null;
        try {
          offset = parseUploadOffset(req.headers);
        } catch (err) {
          return uploadErrorResponse(err);
        }
        let chunk: Uint8Array;
        try {
          chunk = await readUploadChunkBytes(req);
        } catch (err) {
          return uploadErrorResponse(err);
        }
        try {
          const result = uploadStaging.patch(
            tool,
            id,
            uploadId,
            offset,
            chunk,
            requestUploadIdentity(req, url),
          );
          return json({ ok: true, ...result });
        } catch (err) {
          return uploadErrorResponse(err);
        }
      }
    }

    // Generic session rename: native AgentBackend.renameSession when available, otherwise broker display alias.
    const renameSession = path.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/rename$/);
    if (renameSession && (req.method === 'PATCH' || req.method === 'POST')) {
      const tool = decodeURIComponent(renameSession[1]!);
      const id = decodeURIComponent(renameSession[2]!);
      const backend = registry.get(tool);
      if (!backend) return json({ error: `unknown tool: ${tool}` }, 404);
      const body: any = await req.json().catch(() => ({}));
      const title = body?.title == null ? null : String(body.title).trim().slice(0, 160);
      let record: ReturnType<typeof sessionMetadata.renameSession> | null = null;
      let nativeSession: Awaited<ReturnType<NonNullable<typeof backend.renameSession>>> | undefined;
      if (backend.renameSession) {
        try {
          nativeSession = await backend.renameSession(id, title);
          sessionMetadata.renameSession(tool, id, null);
        } catch {
          return json({ error: 'native session rename failed' }, 502);
        }
      } else {
        record = sessionMetadata.renameSession(tool, id, title);
      }
      // A rename changes the title, not run/control state. When this session
      // is open, keep the Hub owner's fresher facts and apply only the native
      // accepted title; adapter rename responses are allowed to reconstruct
      // otherwise-idle metadata from disk.
      const liveSession = nativeSession ? hub.getConn(tool, id)?.conn.info : undefined;
      const base = nativeSession
        ? liveSession
          ? { ...liveSession, title: nativeSession.title }
          : nativeSession
        : await discoverSession(tool, id);
      const session = base ? decorateSession(base) : undefined;
      // A NATIVE rename must also update any open connection's in-memory title: the alias was just
      // cleared, so a stale `mc.conn.info.title` would flicker back on every later status broadcast
      // until the roster poll re-corrected it (issues-part2 item 15). The alias path needs no patch —
      // decorateSession applies the alias on every broadcast.
      if (nativeSession?.title) {
        hub.patchSessionInfoWhere((info) => info.tool === tool && info.id === id, { title: nativeSession.title });
      }
      hub.broadcastSessionWhere((info) => info.tool === tool && info.id === id, decorateSession);
      return json({ ok: true, title: session?.title ?? record?.title ?? null, session });
    }

    // Generic session fork: native AgentBackend.forkSession when available; no broker-local fallback.
    const forkSession = path.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/fork$/);
    if (forkSession && req.method === 'POST') {
      const tool = decodeURIComponent(forkSession[1]!);
      const id = decodeURIComponent(forkSession[2]!);
      const backend = registry.get(tool);
      if (!backend) return json({ error: `unknown tool: ${tool}` }, 404);
      if (!backend.forkSession) return json({ error: 'native session fork is not available for this agent' }, 501);
      // A session an AGENT spawned (`SessionInfo.origin === 'subagent'`) is not a user-initiated fork
      // point: its only writer is the parent run, so the fork could only be another Observe-only thread
      // the user is then dropped into. Refuse with a typed code rather than letting it become the
      // catch-all 502 below, which reads as a transient adapter failure and invites a retry.
      //
      // Deliberately TOOL-AGNOSTIC. `origin` is a protocol-level field every adapter already advertises
      // (and the roster/client already filter on), so the rule is stated once over the contract instead
      // of branching on 'codex'; any adapter that tags a session this way inherits the same refusal.
      // `exec` and `vscode` origins are NOT gated — they are automated/IDE launches with no owning
      // parent, and forking them is ordinary.
      //
      // Advertisement is not enforcement: the adapter refuses this independently (the roster row can be
      // stale, absent, or served from a peer), and this gate cannot see a source the backend cannot
      // discover. Both layers stay.
      const forkSource = await discoverSession(tool, id);
      if (isAgentOwnedSession(forkSource)) {
        // Bare string literal on purpose: check:broker-surface discovers `code:` properties by AST and
        // only reads a plain StringLiteral initializer, so a `satisfies BrokerErrorCode` here would make
        // the registered code look stale. `AGENT_OWNED_FORK_REFUSAL_CODE` is the typed anchor.
        return json({ error: AGENT_OWNED_FORK_REFUSAL, code: 'SESSION_AGENT_OWNED' }, 409);
      }
      const body: any = await req.json().catch(() => ({}));
      const messageId = typeof body?.messageId === 'string' && body.messageId.trim() ? body.messageId.trim() : null;
      let nativeSession: Awaited<ReturnType<NonNullable<typeof backend.forkSession>>> | undefined;
      try {
        nativeSession = await backend.forkSession(id, { messageId });
      } catch (err) {
        // The adapter's own agent-owned refusal is the SAME permanent answer as the gate above, and it
        // is the only one left whenever `discoverSession()` could not see the source. Classifying it as
        // the catch-all below would answer a capability boundary with a transient-sounding 502 and
        // invite a retry that can never succeed. Typed here, not sniffed from the message text.
        if (isAgentOwnedSessionError(err)) {
          // Bare string literal on purpose, as in the gate above: check:broker-surface reads `code:`
          // initializers by AST and only understands a plain StringLiteral.
          return json({ error: AGENT_OWNED_FORK_REFUSAL, code: 'SESSION_AGENT_OWNED' }, 409);
        }
        return json({ error: 'native session fork failed' }, 502);
      }
      const base = nativeSession || await discoverSession(tool, id);
      const session = base ? decorateSession(base) : undefined;
      return json({ ok: true, session });
    }

    // Generic session clone: native AgentBackend.cloneSession when available; kept separate from
    // fork so clone/head-copy semantics are never silently overloaded onto fork-point behavior.
    const cloneSession = path.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/clone$/);
    if (cloneSession && req.method === 'POST') {
      const tool = decodeURIComponent(cloneSession[1]!);
      const id = decodeURIComponent(cloneSession[2]!);
      const backend = registry.get(tool);
      if (!backend) return json({ error: `unknown tool: ${tool}` }, 404);
      if (!backend.cloneSession) return json({ error: 'native session clone is not available for this agent' }, 501);
      let nativeSession: Awaited<ReturnType<NonNullable<typeof backend.cloneSession>>> | undefined;
      try {
        nativeSession = await backend.cloneSession(id);
      } catch {
        return json({ error: 'native session clone failed' }, 502);
      }
      const base = nativeSession || await discoverSession(tool, id);
      const session = base ? decorateSession(base) : undefined;
      return json({ ok: true, session });
    }

    // ── Gated R2 transcript export (Slice 6) ─────────────────────────────────────
    // Two-step, generic over the adapter (never a tool-name branch): preflight issues a confirmation
    // nonce bound to action/session/revision/format/redaction-mode/tier (rules 3-5); execute consumes
    // it, rate-limits, and runs the redact+attachment pipeline. Availability = adapter hook presence
    // AND the reviewed R2 registry; T2 (non-loopback) is default-deny unless locally enabled.
    const exportPreflight = path.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/export\/preflight$/);
    if (exportPreflight && req.method === 'POST') {
      const tool = decodeURIComponent(exportPreflight[1]!);
      const id = decodeURIComponent(exportPreflight[2]!);
      const backend = registry.get(tool);
      if (!backend) return json({ error: `unknown tool: ${tool}` }, 404);
      const action = getR2Action('transcriptExport');
      if (!action || typeof backend.exportTranscript !== 'function' || !backend.transcriptExportFormat) {
        return json({ error: 'transcript export is not available for this agent' }, 501);
      }
      const tier = trustTierForAddress(srv.requestIP(req)?.address);
      const avail = r2ActionAvailable(action, tier);
      if (!avail.allowed) return json({ error: avail.reason, code: 'R2_DISABLED' }, 403);
      const base = await discoverSession(tool, id);
      if (!base) return json({ error: 'session not found' }, 404);
      const revision = deriveSessionRevision(base, action.revisionBinding);
      const format = backend.transcriptExportFormat;
      const redactionMode = 'redacted-full';
      const { nonce, expiresAt } = issueConfirmNonce({ actionId: action.id, tool, sessionId: id, revision, format, redactionMode, tier }, action.nonceTtlMs);
      const retentionMinutes = Math.round(action.retentionMs / 60000);
      return json({
        ok: true,
        nonce,
        expiresAt,
        confirm: {
          action: action.id,
          tool,
          sessionId: id,
          sessionTitle: base.title,
          format,
          redactionMode,
          tier,
          retentionMinutes,
          sizeCapBytes: r2MaxBytes(action),
          irreversible: false,
          message:
            `Download the FULL transcript of “${base.title}” as a redacted ${format.toUpperCase()} file. It contains prompts, model responses, code, tool output, and file paths; ` +
            `high-confidence secrets are redacted but not guaranteed removed. It is stored on the broker for ${retentionMinutes} minutes and anyone with the downloaded file can read it.`,
        },
      });
    }

    const exportExecute = path.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/export$/);
    if (exportExecute && req.method === 'POST') {
      const tool = decodeURIComponent(exportExecute[1]!);
      const id = decodeURIComponent(exportExecute[2]!);
      const backend = registry.get(tool);
      if (!backend) return json({ error: `unknown tool: ${tool}` }, 404);
      const action = getR2Action('transcriptExport');
      if (!action || typeof backend.exportTranscript !== 'function' || !backend.transcriptExportFormat) {
        return json({ error: 'transcript export is not available for this agent' }, 501);
      }
      const tier = trustTierForAddress(srv.requestIP(req)?.address);
      const avail = r2ActionAvailable(action, tier);
      if (!avail.allowed) return json({ error: avail.reason, code: 'R2_DISABLED' }, 403);
      const body: any = await req.json().catch(() => ({}));
      // Reject any client-supplied path key or unexpected parameter (rule 6): the adapter owns the
      // native destination; the client may pass only the confirmation nonce.
      for (const key of Object.keys(body ?? {})) {
        if (action.paramSchema.rejectKeys.includes(key)) return json({ error: `parameter '${key}' is not allowed for transcript export`, code: 'BAD_PARAM' }, 400);
        if (!action.paramSchema.allowedKeys.includes(key)) return json({ error: `unexpected parameter '${key}'`, code: 'BAD_PARAM' }, 400);
      }
      const base = await discoverSession(tool, id);
      if (!base) return json({ error: 'session not found' }, 404);
      const revision = deriveSessionRevision(base, action.revisionBinding);
      const verdict = consumeConfirmNonce(String(body?.nonce ?? ''), {
        actionId: action.id,
        tool,
        sessionId: id,
        revision,
        format: backend.transcriptExportFormat,
        redactionMode: 'redacted-full',
        tier,
      });
      if (!verdict.ok) return json({ error: verdict.reason, code: 'CONFIRMATION_STALE' }, 409);
      const slot = reserveR2RateSlot(action, tool, id);
      if (!slot.ok) return json({ error: slot.reason, code: 'RATE_LIMITED' }, 429);
      const result = await runTranscriptExport({
        backend,
        action,
        session: { tool, id, cwd: base.cwd, title: base.title },
        artifactStore,
      });
      if (!result.ok) return json({ error: result.error, code: result.code }, result.status);
      return json({ ok: true, artifact: result.artifact });
    }

    // Display-only project rename: PATCH /api/projects/rename  (body: {cwd, name})
    // This aliases the roster project group only; it never renames or moves the real directory.
    if (path === '/api/projects/rename' && (req.method === 'PATCH' || req.method === 'POST')) {
      const body: any = await req.json().catch(() => ({}));
      const cwd = typeof body?.cwd === 'string' ? body.cwd.trim() : '';
      if (!cwd || cwd.includes('\0')) return json({ error: 'cwd is required' }, 400);
      const name = body?.name == null ? null : String(body.name);
      const record = sessionMetadata.renameProject(cwd, name);
      hub.broadcastSessionWhere((info) => info.cwd === cwd, decorateSession);
      return json({ ok: true, cwd, projectName: record?.name ?? null });
    }

    // Create a brand-new session: POST /api/sessions/:tool  (body: {directory?, title?})
    const create = path.match(/^\/api\/sessions\/([^/]+)$/);
    if (create && req.method === 'POST') {
      const tool = decodeURIComponent(create[1]!);
      const backend = registry.get(tool);
      if (!backend?.createSession) return json({ error: `tool '${tool}' cannot create sessions` }, 400);
      let body: any = {};
      try {
        body = await req.json();
      } catch {
        /* empty body ok */
      }
      try {
        const options = normalizeCreateSessionOptions(body ?? {});
        await prepareBackendSessionCreation(backend);
        await requireSupportedModelSelection(backend, options.model);
        const info = await backend.createSession(options);
        safeRecordMetadata('create', () => {
          sessionMetadata.recordAppCreatedSession(info);
          return true;
        });
        return json({ session: decorateSession(info), attachMode: createdSessionAttachMode(info) });
      } catch (err) {
        if (err instanceof Error && err.name === 'ModelSelectionUnsupportedError') {
          return json(
            { error: err.message, code: 'MODEL_SELECTION_UNSUPPORTED' },
            409,
          );
        }
        if (err instanceof ModelCatalogUnavailableError) {
          return json(
            { error: 'model catalog refresh failed', code: 'MODEL_CATALOG_UNAVAILABLE' },
            503,
          );
        }
        if (isSessionCreateTemporarilyUnavailableError(err)) {
          return json({
            error: err.message,
            code: 'SESSION_CREATE_TEMPORARILY_UNAVAILABLE',
            detailCode: err.detailCode,
            retryable: true,
          }, 503);
        }
        return json({ error: String(err) }, 500);
      }
    }

    // ── Scheduled sends: list / create / edit / lifecycle actions / cancel ──
    if (path === '/api/schedules' && req.method === 'GET') {
      return json({ ok: true, schedules: scheduleStore.list() });
    }
    if (path === '/api/schedules' && req.method === 'POST') {
      const body: any = await req.json().catch(() => ({}));
      const kind = body?.kind === 'new-session' ? 'new-session' as const : body?.kind === 'message' ? 'message' as const : undefined;
      if (!kind) return scheduleInvalid("kind must be 'message' or 'new-session'");
      const tool = typeof body?.tool === 'string' ? body.tool.trim() : '';
      if (!tool || !registry.get(tool)) return scheduleInvalid(`unknown tool '${tool}'`);
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      if (!text) return scheduleInvalid('text is required');
      if (text.length > 32_000) return scheduleInvalid('text is too long (max 32000 chars)');
      let cron: ScheduleCron | undefined;
      let retryPolicy: ScheduleRetryPolicy | undefined;
      try {
        if (body?.cron != null) {
          if (!body.cron || typeof body.cron !== 'object' || Array.isArray(body.cron)) {
            return scheduleInvalid('cron must be an object', 'SCHEDULE_CRON_INVALID');
          }
          cron = validateScheduleCron(body.cron as ScheduleCron);
        }
        if (body?.retryPolicy != null) {
          if (!body.retryPolicy || typeof body.retryPolicy !== 'object' || Array.isArray(body.retryPolicy)) {
            return scheduleInvalid('retryPolicy must be an object');
          }
          retryPolicy = validateRetryPolicy(body.retryPolicy as ScheduleRetryPolicy);
        }
      } catch (error) {
        return scheduleErrorResponse(error);
      }
      if (cron && body?.at != null) return scheduleInvalid('at is broker-computed and must be omitted when cron is supplied');
      const at = cron ? undefined : Number(body?.at);
      if (!cron && (!Number.isFinite(at) || (at ?? 0) <= 0)) return scheduleInvalid('at must be an epoch-ms timestamp');
      if (at !== undefined && at < Date.now() - 60_000) return scheduleInvalid('at is in the past');
      if (body?.repeat != null && body.repeat !== '' && body.repeat !== 'daily' && body.repeat !== 'weekdays') {
        return scheduleInvalid("repeat must be 'daily' or 'weekdays'");
      }
      const repeat = body?.repeat === 'daily' || body?.repeat === 'weekdays' ? body.repeat as ScheduleRepeat : undefined;
      if (cron && repeat) return scheduleInvalid('repeat and cron are mutually exclusive');
      if (kind === 'message' && repeat) return scheduleInvalid('legacy repeat is only valid for new-session schedules');
      if (kind === 'message' && cron) return scheduleInvalid('message schedules are one-shot; cron is only valid for new-session schedules');
      const timeZone = typeof body?.timeZone === 'string' && body.timeZone.trim() ? body.timeZone.trim() : undefined;
      if (timeZone && !isValidTimeZone(timeZone)) return scheduleInvalid('timeZone must be a valid IANA time-zone name');
      if (timeZone && (kind !== 'new-session' || !repeat)) return scheduleInvalid('timeZone is only valid for legacy repeating new-session schedules');
      if (scheduleStore.scheduledCount() >= MAX_SCHEDULED) return json({ ok: false, error: `too many live schedules (max ${MAX_SCHEDULED})`, code: 'SCHEDULE_INVALID' }, 429);
      let created: ScheduleRecord;
      try {
        if (kind === 'message') {
          const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
          if (!sessionId) return scheduleInvalid('sessionId is required for a message schedule');
          const sessionTitle = typeof body?.sessionTitle === 'string' && body.sessionTitle.trim()
            ? body.sessionTitle.trim().slice(0, 160)
            : undefined;
          created = scheduleStore.create({ kind, tool, sessionId, sessionTitle, text, at: at!, retryPolicy });
        } else {
          if (!registry.get(tool)?.createSession) return scheduleInvalid(`tool '${tool}' cannot create sessions`);
          const directory = typeof body?.directory === 'string' && body.directory.trim() ? body.directory.trim() : undefined;
          const title = typeof body?.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 160) : undefined;
          let model: ModelSelection | undefined;
          try {
            model = normalizeModelSelection(body?.model);
            await requireSupportedModelSelection(registry.get(tool)!, model);
          } catch (error) {
            const catalogUnavailable =
              error instanceof ModelCatalogUnavailableError;
            return json(
              {
                ok: false,
                code: catalogUnavailable
                  ? 'MODEL_CATALOG_UNAVAILABLE'
                  : 'MODEL_SELECTION_UNSUPPORTED',
                error:
                  catalogUnavailable
                    ? 'model catalog refresh failed'
                    : error instanceof Error
                    ? error.message
                    : 'selected model is unavailable',
              },
              catalogUnavailable ? 503 : 409,
            );
          }
          created = cron
            ? scheduleStore.create({ kind, tool, directory, title, text, cron, retryPolicy, ...(model ? { model } : {}) })
            : scheduleStore.create({ kind, tool, directory, title, text, at: at!, repeat, retryPolicy, timeZone, ...(model ? { model } : {}) });
        }
      } catch (error) {
        return scheduleErrorResponse(error);
      }
      void scheduleRunner.tick().catch(() => {});
      return json({ ok: true, schedule: created }, 201);
    }

    const scheduleActionRoute = path.match(/^\/api\/schedules\/([^/]+)\/actions$/);
    if (scheduleActionRoute && req.method === 'POST') {
      const id = decodeURIComponent(scheduleActionRoute[1]!);
      if (scheduleRunner.isInFlight(id)) {
        return scheduleErrorResponse(new ScheduleMutationError('SCHEDULE_INVALID_STATE', 'schedule delivery is in flight'));
      }
      const body: any = await req.json().catch(() => ({}));
      const action = body?.action as ScheduleAction;
      if (action !== 'pause' && action !== 'resume' && action !== 'run-now' && action !== 'recover-quota') {
        return scheduleInvalid("action must be 'pause', 'resume', 'run-now', or 'recover-quota'");
      }
      const expectedRevision = Number(body?.expectedRevision);
      if (!Number.isInteger(expectedRevision) || expectedRevision < 1) return scheduleInvalid('expectedRevision must be a positive integer');
      try {
        const schedule = action === 'pause'
          ? scheduleStore.pause(id, expectedRevision)
          : action === 'resume'
            ? scheduleStore.resume(id, expectedRevision)
            : action === 'run-now'
              ? scheduleStore.runNow(id, expectedRevision)
              : scheduleStore.recoverQuota(id, expectedRevision);
        void scheduleRunner.tick().catch(() => {});
        return json({ ok: true, schedule });
      } catch (error) {
        return scheduleErrorResponse(error, scheduleStore.get(id));
      }
    }

    const scheduleRoute = path.match(/^\/api\/schedules\/([^/]+)$/);
    if (scheduleRoute && req.method === 'PATCH') {
      const id = decodeURIComponent(scheduleRoute[1]!);
      if (scheduleRunner.isInFlight(id)) {
        return scheduleErrorResponse(new ScheduleMutationError('SCHEDULE_INVALID_STATE', 'schedule delivery is in flight'));
      }
      const body: any = await req.json().catch(() => ({}));
      if (body?.kind !== undefined || body?.tool !== undefined || body?.sessionId !== undefined) {
        return scheduleInvalid('kind, tool, and sessionId are immutable');
      }
      const expectedRevision = Number(body?.expectedRevision);
      if (!Number.isInteger(expectedRevision) || expectedRevision < 1) return scheduleInvalid('expectedRevision must be a positive integer');
      if (body?.at !== undefined) {
        const at = Number(body.at);
        if (!Number.isFinite(at) || at <= 0) return scheduleInvalid('at must be an epoch-ms timestamp');
        if (at < Date.now() - 60_000) return scheduleInvalid('at is in the past');
      }
      const update: ScheduleUpdate = { expectedRevision };
      for (const field of ['text', 'at', 'repeat', 'cron', 'retryPolicy', 'timeZone', 'sessionTitle', 'directory', 'title'] as const) {
        if (Object.prototype.hasOwnProperty.call(body, field)) (update as any)[field] = body[field];
      }
      try {
        const schedule = scheduleStore.update(id, update);
        void scheduleRunner.tick().catch(() => {});
        return json({ ok: true, schedule });
      } catch (error) {
        return scheduleErrorResponse(error, scheduleStore.get(id));
      }
    }
    if (scheduleRoute && req.method === 'DELETE') {
      const id = decodeURIComponent(scheduleRoute[1]!);
      if (scheduleRunner.isInFlight(id)) {
        return scheduleErrorResponse(new ScheduleMutationError('SCHEDULE_INVALID_STATE', 'schedule delivery is in flight'));
      }
      const existing = scheduleStore.get(id);
      if (!existing) return json({ ok: false, error: 'unknown schedule', code: 'SCHEDULE_NOT_FOUND' }, 404);
      try {
        if (existing.state === 'scheduled' || existing.state === 'paused') return json({ ok: true, schedule: scheduleStore.cancel(id) });
        return json({ ok: true, removed: scheduleStore.remove(id) });
      } catch (error) {
        return scheduleErrorResponse(error, scheduleStore.get(id));
      }
    }

    // The agent's send_file tool POSTs here to deliver a file from its workspace to the app.
    // {sessionID, path|rawPath, tool?} → surface it to that session's clients as a file-artifact.
    if (path === '/api/tool/send_file' && req.method === 'POST') {
      let body: any = {};
      try {
        body = await req.json();
      } catch {
        /* empty body */
      }
      const sid = String(body?.sessionID ?? '');
      const toolName = String(body?.tool ?? 'opencode');
      const fp = String(body?.path ?? body?.rawPath ?? '');
      if (!sid || !fp) return new Response('missing sessionID or path', { status: 400 });
      const mc = hub.getConn(toolName, sid);
      if (!mc)
        return new Response('this session is not open in the app right now — open it on your phone, then retry', { status: 404 });
      const r = mc.surfaceExplicit(fp);
      return new Response(r.detail, { status: r.ok ? 200 : 400, headers: { 'content-type': 'text/plain' } });
    }

    // ── Pi live bridge (Mode A): the in-session extension relays here ──
    // hello: a live Pi session announced itself → adopt a bridged connection into the Hub (pinned),
    // so a phone attach reuses it instead of spawning a second `pi --mode rpc` on the same JSONL.
    if (path === '/pi/bridge/hello' && req.method === 'POST') {
      const b: any = await req.json().catch(() => ({}));
      const sessionFile = String(b?.sessionFile ?? '');
      if (!sessionFile) return new Response('missing sessionFile', { status: 400 });
      const id = bridgeId(sessionFile);
      rememberPiBridgeFile(id, sessionFile);
      const bridgeThinkingLevel =
        typeof b?.thinkingLevel === 'string' && ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(b.thinkingLevel)
          ? b.thinkingLevel
          : undefined;
      const bridgeCurrentModel = b?.model?.modelID
        ? {
            providerID: String(b.model.providerID ?? ''),
            modelID: String(b.model.modelID),
            ...(bridgeThinkingLevel ? { reasoningEffort: bridgeThinkingLevel } : {}),
          }
        : undefined;
      const info: SessionInfo = {
        id, tool: 'pi', machine: MACHINE,
        title: String(b?.title || sessionFile.split('/').pop() || 'Pi session'),
        cwd: b?.cwd ? String(b.cwd) : undefined,
        // A bridge hello is exact live-source activity. Publish that observation
        // time so the default recent-session roster does not hide an otherwise
        // undated terminal session; it is never used as artifact ownership.
        updatedAt: Date.now(),
        status: 'idle', attachMode: 'live',
        model: b?.model?.label || b?.model?.name || b?.model?.modelID ? String(b.model.label ?? b.model.name ?? b.model.modelID) : undefined,
        currentModel: bridgeCurrentModel,
        control: {
          drive: {
            supported: false,
            state: 'unavailable',
            reason: 'This Pi session is already synced with the terminal through the bridge; no Drive takeover is needed.',
          },
          terminalSync: {
            supported: true,
            syncAvailable: true,
            active: true,
            label: 'Synced with Pi terminal',
            note: `This Pi session is connected through the ${PRODUCT_IDENTITY.productName} bridge extension.`,
          },
        },
      };
      const conn = piBridge.hello(id, info);
      conn.ingestHistory(b?.history); // backfill the conversation-so-far (idempotent on re-hello)
      conn.setCommands(b?.commands); // the user's skills/templates → richer palette than /stop
      conn.setModelOptions(b?.models, bridgeCurrentModel?.reasoningEffort);
      hub.adopt('pi', id, conn); // pinned: lives as long as the terminal session, not the clients
      return json({ ok: true, id });
    }
    // events: the extension pushes a batch of session events → fan out to attached clients.
    if (path === '/pi/bridge/events' && req.method === 'POST') {
      const b: any = await req.json().catch(() => ({}));
      const conn = piBridge.get(canonicalizePiBridgeId(String(b?.id ?? '')));
      if (!conn) return new Response('unknown bridge', { status: 404 });
      for (const ev of Array.isArray(b?.events) ? b.events : []) conn.ingest(ev);
      return json({ ok: true });
    }
    // Scoped replacement for the legacy general-control `/api/tool/send_file` call. The bridge id
    // selects a live Pi session and `surfaceExplicit` independently jails the path to its workspace.
    if (path === '/pi/bridge/send-file' && req.method === 'POST') {
      const b: any = await req.json().catch(() => ({}));
      const id = canonicalizePiBridgeId(String(b?.id ?? ''));
      const conn = piBridge.get(id);
      if (!conn) return json({ ok: false, code: 'NOT_FOUND', error: 'unknown bridge' }, 404);
      const mc = hub.getConn('pi', id);
      if (!mc) return json({ ok: false, code: 'NOT_FOUND', error: 'bridge session is not open' }, 404);
      const result = mc.surfaceExplicit(String(b?.path ?? ''));
      return json({ ok: result.ok, detail: result.detail }, result.ok ? 200 : 400);
    }
    // commands: the extension long-polls for actions to perform (inject prompt, abort, …).
    if (path === '/pi/bridge/commands' && req.method === 'GET') {
      const conn = piBridge.get(canonicalizePiBridgeId(url.searchParams.get('id') ?? ''));
      if (!conn) return new Response('unknown bridge', { status: 404 });
      const commands = await conn.takeCommands();
      return json({ commands });
    }
    // status: is a session currently live-bridged? (used to gate attach + mark the roster live)
    if (path === '/pi/bridge/status' && req.method === 'GET') {
      return json({ bridged: piBridge.has(canonicalizePiBridgeId(url.searchParams.get('id') ?? '')) });
    }
    // bye: the session shut down → let the registry decide. A `reload` (or unknown reason) is held
    // open briefly so the same-id re-hello reclaims the live connection (the phone stays attached);
    // quit/new/resume/fork tear down now and notify the phone. See PiBridgeRegistry.bye.
    if (path === '/pi/bridge/bye' && req.method === 'POST') {
      const b: any = await req.json().catch(() => ({}));
      const id = canonicalizePiBridgeId(String(b?.id ?? ''));
      const reason = b?.reason ? String(b.reason) : undefined;
      if (id) piBridge.bye(id, reason);
      return json({ ok: true });
    }

    // ── Source-development Claude hooks overlay ──
    // Packaged v1 returns 404 for every hook protocol leg. Source runs expose it only through the
    // explicit D14 development bypass, which sets COSYNCING_DEV_MODE before importing this module.
    if (path.startsWith('/claude/hook/') && !CLAUDE_HOOKS_DEV_ENABLED) {
      return new Response('Not found', { status: 404 });
    }
    // The in-session PreToolUse hook relays a permission/question here and BLOCKS for the phone's answer.
    // hello: a session announced itself (SessionStart) → adopt a pinned live conn so the roster shows synced.
    if (path === '/claude/hook/hello' && req.method === 'POST') {
      const b: any = await req.json().catch(() => ({}));
      const transcriptPath = String(b?.transcriptPath ?? '');
      if (!isClaudeTranscriptPathAllowed(transcriptPath)) return new Response('invalid transcriptPath', { status: 400 });
      const id = claudeSessionId(transcriptPath);
      ensureClaudeHooksConn(id, transcriptPath, b);
      return json({ ok: true, id });
    }
    // request: ingest the relayed prompt + long-poll the decision. Returns {viewers:0} when no app is
    // attached (the hook then passes through to the terminal), {resolved:true,…} once the user answers,
    // or {resolved:false} so the hook re-posts (it owns the overall deadline / fail-open).
    if (path === '/claude/hook/request' && req.method === 'POST') {
      const b: any = await req.json().catch(() => ({}));
      const transcriptPath = String(b?.transcriptPath ?? '');
      const requestId = String(b?.requestId ?? '');
      if (!requestId || !isClaudeTranscriptPathAllowed(transcriptPath)) return json({ error: 'missing requestId or invalid transcriptPath' }, 400);
      const id = String(b?.id || claudeSessionId(transcriptPath));
      const conn = ensureClaudeHooksConn(id, transcriptPath, b);
      const mc = hub.getConn('claude', id);
      if (!mc || mc.clientCount === 0) return json({ viewers: 0 }); // nobody watching → let the terminal handle it
      conn.ingestRequest({
        requestId,
        kind: b?.kind === 'question' ? 'question' : 'permission',
        toolName: b?.toolName ? String(b.toolName) : undefined,
        title: b?.title ? String(b.title) : undefined,
        detail: b?.detail ? String(b.detail) : undefined,
        toolInput: b?.toolInput,
        questions: b?.questions,
      });
      const decision = await conn.awaitDecision(requestId, 20000);
      if (!decision) return json({ resolved: false });
      if (decision.kind === 'permission') return json({ resolved: true, kind: 'permission', decision: decision.decision });
      if (decision.kind === 'answer') return json({ resolved: true, kind: 'answer', answers: decision.answers });
      return json({ resolved: true, kind: 'reject' });
    }
    // status: UserPromptSubmit (working) / Stop (idle) turn-boundary signal → live spinner on the synced session.
    if (path === '/claude/hook/status' && req.method === 'POST') {
      const b: any = await req.json().catch(() => ({}));
      const transcriptPath = String(b?.transcriptPath ?? '');
      const id = String(b?.id || (transcriptPath ? claudeSessionId(transcriptPath) : ''));
      if (!id || !transcriptPath) return json({ error: 'missing id/transcriptPath' }, 400);
      // Only update a session a phone is actually watching; don't spin up a pinned conn just for a status ping.
      const conn = claudeHooks.get(id);
      if (conn) conn.setStatus(b?.state === 'working' ? 'working' : 'idle');
      return json({ ok: true, tracked: !!conn });
    }
    if (path === '/claude/hook/bye' && req.method === 'POST') {
      const b: any = await req.json().catch(() => ({}));
      const id = String(b?.id ?? '');
      if (id) claudeHooks.bye(id, b?.reason ? String(b.reason) : undefined);
      return json({ ok: true });
    }

    if (path === '/api/agent-runtime-updates' && req.method === 'GET') {
      // ?fresh=1 bypasses the TTL cache and forces a real native probe (test/diagnostic control).
      const fresh = url.searchParams.get('fresh') === '1';
      const updates = (fresh ? undefined : runtimeUpdates.listFresh(runtimeUpdateStatusTtlMs))
        ?? await runtimeUpdates.refreshAll({ autoRestart: false });
      return json({ ok: true, updates });
    }

    if (path === '/api/agent-runtime-update-policy' && req.method === 'GET') {
      return json({ ok: true, codexUpdatePolicy: getCodexUpdatePolicy() });
    }

    if (path === '/api/agent-runtime-update-policy' && req.method === 'POST') {
      const body: any = await req.json().catch(() => ({}));
      if (body?.codexUpdatePolicy !== 'when-detached' && body?.codexUpdatePolicy !== 'when-idle') {
        return json({ error: 'codexUpdatePolicy must be when-detached or when-idle' }, 400);
      }
      setCodexUpdatePolicy(body.codexUpdatePolicy);
      const update = await runtimeUpdates.refresh('codex', { autoRestart: true });
      return json({ ok: true, codexUpdatePolicy: body.codexUpdatePolicy, update });
    }

    const runtimeRestartMatch = path.match(/^\/api\/agent-runtime-updates\/([^/]+)\/restart$/);
    if (runtimeRestartMatch && req.method === 'POST') {
      const body: any = await req.json().catch(() => ({}));
      if (body?.confirmRestart !== true) return json({ error: 'confirmRestart:true is required' }, 400);
      const agent = decodeURIComponent(runtimeRestartMatch[1] ?? '');
      try {
        const update = await runtimeUpdates.restartNow(agent);
        if (!update) return json({ error: `No managed runtime updater for ${agent}` }, 404);
        return json({ ok: true, update });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 502);
      }
    }

    // Per-agent Codex sync enabler (D15) — decoupled from the deleted global control-mode picker (D13/D17).
    // Persists intent durably (D18) and schedules a one-time restart ONLY if the running broker's env
    // differs (FU-3). This is the replacement path the picker-delete step depends on.
    if (path === '/api/agents/codex/sync' && req.method === 'POST') {
      const body: any = await req.json().catch(() => ({}));
      if (typeof body?.enabled !== 'boolean') return json({ error: 'enabled:boolean is required' }, 400);
      setAgentSyncEnabled('codex', body.enabled);
      const result = scheduleBrokerControlModeRestart(body.enabled);
      return json(
        {
          ok: true,
          agent: 'codex',
          enabled: body.enabled,
          ...result,
          message: result.restartRequired
            ? 'Codex sync setting saved; broker restart scheduled (the app may be unavailable for a few seconds).'
            : 'Codex sync setting saved.',
        },
        result.restartRequired ? 202 : 200,
      );
    }

    if (path === '/api/agents/codex/sync' && req.method === 'GET') {
      return json({ ok: true, agent: 'codex', enabled: process.env.COSYNCING_CODEX_SYNC_SERVER === '1' });
    }

    // Contributor-only Claude hooks status + mutation. Packaged v1 exposes no installation route.
    if (path === '/api/claude/hooks' && req.method === 'GET') {
      if (!CLAUDE_HOOKS_DEV_ENABLED) return new Response('Not found', { status: 404 });
      return json({ installed: claudeHooksInstalled(), settingsPath: claudeHooksSettingsPath(), brokerUrl: BROKER_URL });
    }
    if (path === '/api/claude/hooks' && req.method === 'POST') {
      if (!CLAUDE_HOOKS_DEV_ENABLED) return new Response('Not found', { status: 404 });
      const b: any = await req.json().catch(() => ({}));
      // Require an EXPLICIT action so a stray/empty POST can't silently edit ~/.claude/settings.json.
      if (b?.action === 'uninstall') { const r = uninstallClaudeHooks(); return json({ ok: true, installed: false, settingsPath: r.path }); }
      if (b?.action === 'install') { const r = installClaudeHooks({ brokerUrl: BROKER_URL }); return json({ ok: true, installed: true, settingsPath: r.path }); }
      return json({ error: "action must be 'install' or 'uninstall'" }, 400);
    }

    if (path === '/api/broker/restart' && req.method === 'POST') {
      const body: any = await req.json().catch(() => ({}));
      if (body?.confirmRestart !== true) return json({ error: 'confirmRestart:true is required' }, 400);
      const result = scheduleBrokerRestart();
      return json(
        {
          ok: true,
          ...result,
          message: 'Broker restart scheduled; the app may be unavailable for a few seconds.',
        },
        result.dryRun ? 200 : 202,
      );
    }


    if (path === '/api/broker/restart-all' && req.method === 'POST') {
      const body: any = await req.json().catch(() => ({}));
      if (body?.confirmRestart !== true) return json({ error: 'confirmRestart:true is required' }, 400);

      // Reviewed sequence: restart the independent Codex daemon synchronously so the response carries
      // its real result, then schedule the broker relaunch. Broker teardown replaces its OpenCode child;
      // restarting OpenCode explicitly here would disconnect attach clients twice.
      let codex: { ok: boolean; skipped?: boolean; reason?: string; error?: string };
      try {
        const version = await readCodexDaemonVersion();
        if (!version || version.status !== 'running') {
          codex = { ok: true, skipped: true, reason: 'Managed Codex daemon is not running; it was left stopped.' };
        } else {
          await restartCodexDaemon();
          codex = { ok: true };
        }
      } catch (error) {
        codex = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      const opencodeManaged = (await readManagedOpencodeVersions().catch(() => ({ managed: false }))).managed;
      const brokerRestart = scheduleBrokerRestart();
      return json(
        {
          ok: codex.ok,
          partialFailure: !codex.ok,
          components: {
            codex,
            opencode: { strategy: 'broker-relaunch', restartsWithBroker: opencodeManaged },
            broker: { scheduled: brokerRestart.restartScheduled, dryRun: brokerRestart.dryRun },
          },
          message: `${codex.skipped ? 'Managed Codex was not running and was left stopped' : codex.ok ? 'Managed Codex restarted' : 'Codex restart failed'}; broker restart ${brokerRestart.dryRun ? 'recorded in dry-run' : 'scheduled'}.${opencodeManaged ? ' Managed OpenCode will be replaced with the broker.' : ''}`,
        },
        brokerRestart.dryRun ? 200 : 202,
      );
    }

    if (path === '/api/tokdash/usage' && req.method === 'GET') {
      return fetchTokdashUsage(url.searchParams.get('base'));
    }

    if (path === '/api/tokdash/quota' && req.method === 'GET') {
      try {
        const baseUrl = normalizeTokdashQuotaBaseUrl(url.searchParams.get('base'), TOKDASH_URL);
        const data = await fetchTokdashQuota(baseUrl);
        return json({ ok: true, baseUrl, endpoint: '/api/quota', data });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 502);
      }
    }

    if (path === '/api/tokdash/quota-preference' && req.method === 'GET') {
      return json({ ok: true, enabled: getQuotaWarningsEnabled() });
    }

    if (path === '/api/tokdash/quota-preference' && req.method === 'POST') {
      const body = await req.json().catch(() => ({})) as any;
      if (typeof body?.enabled !== 'boolean') {
        return json({ ok: false, code: 'BAD_PARAM', error: 'enabled must be a boolean' }, 400);
      }
      setQuotaWarningsEnabled(body.enabled);
      await reconcileTokdashQuota();
      return json({ ok: true, enabled: getQuotaWarningsEnabled() });
    }

    if (path === '/api/broker/health' && req.method === 'GET') {
      return json({ ok: true, machine: MACHINE, ...healthWithSecurityState() });
    }

    if (path === '/api/broker/update' && req.method === 'GET') {
      const refresh = url.searchParams.get('refresh') === '1';
      return json({ ok: true, update: await brokerUpdateChecker.inspect({ refresh }) });
    }

    if (path === '/api/broker/update' && req.method === 'POST') {
      const body = await req.json().catch(() => ({})) as { manifestUrl?: unknown };
      const manifestUrl = body.manifestUrl === undefined ? undefined : String(body.manifestUrl).trim();
      if (manifestUrl !== undefined && !isBrokerUpdateManifestUrl(manifestUrl)) {
        return json({ ok: false, code: 'BAD_PARAM', error: 'manifestUrl must be a bounded HTTPS URL' }, 400);
      }
      const update = manifestUrl
        ? await brokerUpdateChecker.inspectManifest(manifestUrl)
        : await brokerUpdateChecker.inspect({ refresh: true });
      if (update.status !== 'update-available' || !update.latestVersion) {
        return json({
          ok: true,
          accepted: false,
          update,
          message: update.status === 'current'
            ? 'The broker is already current.'
            : 'The signed release channel is unavailable; the broker was not changed.',
        });
      }
      const handoff = await triggerBrokerUpdate({
        buildInfo: BUILD_INFO,
        service: SERVICE_BOUNDARY,
        executablePath: APPLICATION_IDENTITY.applicationPath,
        ...(APPLICATION_IDENTITY.runtimePath ? { runtimePath: APPLICATION_IDENTITY.runtimePath } : {}),
        stateHome: setupStateHome(),
        cacheRoot: artifactCacheRoot(),
        userHome: os.homedir(),
        ...(manifestUrl ? { manifestUrl } : {}),
      }, update.latestVersion);
      return json(
        { ok: handoff.status === 'accepted', accepted: handoff.status === 'accepted', update, handoff },
        handoff.status === 'accepted' ? 202 : handoff.status === 'blocked' ? 409 : 500,
      );
    }

    if (path === '/api/health') {
      return json({
        ok: true,
        product: PRODUCT_IDENTITY.productName,
        version: BUILD_INFO.version,
        commit: BUILD_INFO.commit,
        // Version and commit are for humans; neither identifies an ARTIFACT. A release cycle shares one
        // semver, and two binaries built from one commit still differ across dirty/clean, target, packaged,
        // and build date. `buildFingerprint` is the one definition of "which build is this" — setup's
        // post-commit check recomputes this exact string for the build it installed, so a previous build
        // that survived a binary replacement and kept the port cannot answer as the new one.
        buildFingerprint: buildFingerprint(BUILD_INFO),
        contract: BROKER_CONTRACT,
        machine: MACHINE,
        healthStatus: latestBrokerHealth.status,
        healthCheckedAt: latestBrokerHealth.checkedAt,
        ...brokerControlModeState(),
      });
    }

    const agentModels = path.match(/^\/api\/agents\/([^/]+)\/models$/);
    if (agentModels && req.method === 'GET') {
      const tool = decodeURIComponent(agentModels[1]!);
      const backend = registry.get(tool);
      if (!backend) return json({ error: `unknown tool: ${tool}` }, 404);
      if (!backend.listModels) {
        return json(
          { error: 'model selection is unavailable for this agent', code: 'NOT_SUPPORTED' },
          501,
        );
      }
      try {
        return json({
          tool,
          models: await modelCatalogForCreation(backend),
          refreshedAt: Date.now(),
        });
      } catch (error) {
        return json(
          {
            error: 'model catalog refresh failed',
            code: 'MODEL_CATALOG_UNAVAILABLE',
          },
          503,
        );
      }
    }

    if (path === '/api/agents') {
      // D16: /api/agents advertises ABILITY (capabilities); live per-session state rides `control`.
      // `syncEnabled` is the persisted per-agent enablement (AgentSyncEnablement) the Settings toggle
      // reflects — only Codex has an explicit enable today (OpenCode auto-serves, Pi probes its extension).
      const codexSyncEnabled = process.env.COSYNCING_CODEX_SYNC_SERVER === '1';
      // The roster decodes as ONE list on the client, so an agent carrying a
      // kind an older client cannot parse costs it EVERY agent rather than
      // just that row. Each client is therefore sent only the agents it can
      // decode, judged against the revision it declared. A client that
      // declares nothing is treated as the oldest possible one — see
      // `parseAgentRosterClientRevision`.
      const agentVisibility = rosterVisibility(registry.list(), parseAgentRosterClientRevision(url.searchParams));
      const visible = registry.list().filter((b) => agentVisibility.tools.has(b.id));
      const agents = await Promise.all(
        visible.map(async (b) => ({
          id: b.id,
          displayName: b.displayName,
          capabilities: b.capabilities,
          canCreateSession:
            typeof b.createSession === 'function' &&
            (typeof b.canCreateSession === 'function' ? await Promise.resolve(b.canCreateSession()).catch(() => false) : true),
          canSelectModelAtCreation: typeof b.listModels === 'function',
          canRenameNative: typeof b.renameSession === 'function',
          canFork: typeof b.forkSession === 'function',
          canClone: typeof b.cloneSession === 'function',
          // Command-surface export availability = adapter hook presence AND the reviewed R2 registry
          // (per-tier default-deny is still enforced at the export route). Never an agent-name branch.
          canTranscriptExport: typeof b.exportTranscript === 'function' && !!getR2Action('transcriptExport'),
          ...(b.id === 'codex' ? { syncEnabled: codexSyncEnabled } : {}),
        })),
      );
      return json(agents);
    }

    if (path === '/api/machines/resolve' && req.method === 'GET') {
      const machineId = url.searchParams.get('machineId')?.trim() ?? '';
      const tool = url.searchParams.get('tool')?.trim() ?? '';
      const sessionId = url.searchParams.get('sessionId')?.trim() ?? '';
      if (!machineId || !tool || !sessionId || [machineId, tool, sessionId].some((value) => value.length > 1000)) {
        return json({ ok: false, code: 'BAD_PARAM', error: 'machineId, tool, and sessionId are required' }, 400);
      }
      const resolution = resolveMachineSession(
        await discoverMachineRosters(
          rosterVisibility(registry.list(), parseAgentRosterClientRevision(url.searchParams)),
        ),
        { machineId, tool, sessionId },
      );
      const status = resolution.ok
        ? 200
        : resolution.status === 'not-found'
          ? 404
          : resolution.status === 'ambiguous'
            ? 409
            : 503;
      return json(resolution, status);
    }

    if (path === '/api/machines' && req.method === 'GET') {
      return json({
        ok: true,
        ...(await discoverMachineRosters(
          rosterVisibility(registry.list(), parseAgentRosterClientRevision(url.searchParams)),
        )),
      });
    }

    if (path === '/api/session-roster-deltas' && req.method === 'GET') {
      try {
        const afterRaw = url.searchParams.get('after') ?? '0';
        const waitRaw = url.searchParams.get('waitMs') ?? '0';
        const rawWindow = url.searchParams.get('window');
        const after = Number(afterRaw);
        const requestedWaitMs = Number(waitRaw);
        if (!Number.isSafeInteger(after) || after < 0) throw new Error('after must be a non-negative integer');
        if (!Number.isSafeInteger(requestedWaitMs) || requestedWaitMs < 0) throw new Error('waitMs must be a non-negative integer');
        const windowMs = parseSessionWindowMs(rawWindow);
        // Deltas carry the same visibility as the snapshot they update, or they
        // undo it: a client correctly served no Kimi sessions in its snapshot
        // would be handed one by the next delta that mentioned a Kimi session,
        // and from then on hold a row for an agent it was told does not exist.
        const deltaVisibility = rosterVisibility(registry.list(), parseAgentRosterClientRevision(url.searchParams));
        const now = Date.now();
        const revisionStore = rosterRevisionForWindow(windowMs);
        // A slow safety scan is itself this request's wait. Return immediately
        // afterwards rather than adding another 25-second hold.
        const reconciled = await safetyReconcileRoster(windowMs, now);
        let waitMs = reconciled ? 0 : Math.min(requestedWaitMs, 25_000);
        const expiresAt = windowMs === undefined ? undefined : rosterWindowExpiresAt.get(windowMs);
        if (expiresAt !== undefined) {
          waitMs = Math.min(waitMs, Math.max(0, expiresAt - now));
        }
        let batch = await revisionStore.waitAfter(after, waitMs);
        // Wall-clock aging has no native mutation to wake the journal. Bound
        // the wait to the next cutoff, then reconcile the same source-bounded
        // adapter query and return its removal in this response.
        if (
          windowMs !== undefined &&
          !batch.resetRequired &&
          batch.deltas.length === 0 &&
          await safetyReconcileRoster(windowMs, Date.now())
        ) {
          batch = revisionStore.eventsAfter(after);
        }
        // The batch REVISION is deliberately not rewritten when deltas are
        // dropped. It is the roster's own counter, shared by every client, and
        // advancing the cursor past an event this client must never see is
        // exactly right — there is nothing for it to come back for.
        //
        // What keeps a client consistent across a change in what it can see is
        // the SNAPSHOT, which is where its cursor comes from: `/api/sessions`
        // answers with the roster revision it was built at, filtered by the same
        // visibility, and the client polls from there. A build that declares a
        // different revision takes its own snapshot before its first poll, so
        // its cursor is established under the projection it will be served. The
        // journal itself makes no promise here — a complete one answers `after=0`
        // with deltas from revision 1 rather than demanding a reset — which is
        // exactly why the snapshot, not the cursor value, is what establishes
        // the baseline.
        return json({ ...batch, deltas: visibleSessions(batch.deltas, deltaVisibility) });
      } catch (error) {
        return json({ ok: false, code: 'BAD_PARAM', error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }

    if (path === '/api/sessions') {
      // Optional per-device time window (?window=7d|1m|2m|6m|all): a phone loading 1.5k+ sessions over
      // the tailnet was starving, so a device can ask for only recently-active sessions (non-idle always
      // kept — see filterSessionsByWindow). ETag → 304 skips the whole body when the roster is unchanged
      // between polls; gzip otherwise takes the ~2 MB payload to ~200 KB. Both matter at the ~6s poll.
      const rawWindow = url.searchParams.get('window');
      // Sessions are filtered by the SAME decision as `/api/agents`, and the
      // representation cache is keyed by it — see `roster-visibility.ts` for why
      // all three have to agree.
      const visibility = rosterVisibility(registry.list(), parseAgentRosterClientRevision(url.searchParams));
      const windowKey = rosterRepresentationKey(rosterWindowKey(rawWindow), visibility);
      const windowMs = parseSessionWindowMs(rawWindow);
      const requestNow = Date.now();
      const force = url.searchParams.get('refresh') === '1';
      const cached = rosterRepresentations.get(windowKey);
      const revisionStore = rosterRevisionForWindow(windowMs);
      const cutoffExpired =
        cached?.expiresAt !== undefined && requestNow >= cached.expiresAt;
      if (
        !force &&
        !cutoffExpired &&
        cached?.revision === revisionStore.revision &&
        ifNoneMatchMatches(req.headers.get('if-none-match'), cached.etag)
      ) {
        return new Response(null, {
          status: 304,
          headers: {
            etag: cached.etag,
            'cache-control': 'no-cache',
            vary: 'accept-encoding',
          },
        });
      }
      const sessions = filterSessionsByWindow(
        visibleSessions(await discoverLocalSessions(force || cutoffExpired, windowMs, requestNow), visibility),
        windowMs,
        requestNow,
      );
      const data = {
        machine: MACHINE,
        machineId: MACHINE,
        generatedAt:
          cutoffExpired
            ? requestNow
            : revisionStore.changedAt || cached?.data.generatedAt || requestNow,
        revision: revisionStore.revision,
        sessions,
      };
      const response = jsonMaybe(req, data, { etag: true, cacheControl: 'no-cache' });
      const etag = response.headers.get('etag');
      if (etag) {
        rosterRepresentations.set(windowKey, {
          revision: revisionStore.revision,
          etag,
          expiresAt: sessionWindowRepresentationExpiry(sessions, windowMs),
          data,
        });
      }
      return response;
    }

    // Static mounts. These sit BELOW every dynamic route above (first match wins), so they can never
    // shadow /api/*, the WS upgrade `^/api/sessions/:tool/:id/stream$`, /api/transport/*, /pi/bridge/*,
    // or /claude/hook/*. Same-origin serving of the web clients — no CORS is or should be involved.

    // Web-update handoff page (N3b). Deliberately a SIBLING of /cosy/, not a child: the app's service
    // worker is registered at /cosy/, so a document under that prefix would be one of its controlled
    // clients and the waiting replacement could never activate. See web-handoff.ts. Matched before the
    // mount only for readability — `/cosy-handoff` is neither `/cosy` nor prefixed by `/cosy/`.
    if (path === WEB_HANDOFF_PATH) return serveWebHandoff(applyCoi);

    // The one mount of the Flutter web build (R16). `/cosy` is what setup prints, what the tailnet Serve
    // route advertises, and what stays in the address bar — so it IS the mount rather than an alias
    // redirecting onto one. The bare form canonicalizes to the trailing-slash form so the shell's relative
    // asset URLs resolve under /cosy/; the query rides along because a printed `?token=` that silently
    // vanished on that redirect would look like a broken sign-in.
    if (path === APP_PATH) {
      return new Response(null, { status: 301, headers: { location: `${APP_MOUNT_PATH}${url.search}` } });
    }
    if (path.startsWith(APP_MOUNT_PATH)) return serveFlutter(path.slice(APP_MOUNT_PATH.length));

    // There is no /app. It was the mount until R16 and is now an unknown path like any other: a plain 404,
    // never a redirect. Same reasoning as the retired /poc-ui mount below — a redirect claims the surface
    // still exists somewhere, and nothing has shipped that could still be asking for it.

    // The PoC UI mount is GONE (R9). Its unlock prompt was a DOM overlay painted over an already-rendered
    // shell, not an auth boundary, so an unauthenticated tailnet or local caller could read whatever it drew
    // by deleting one node. There is no redirect: /poc-ui falls through to the same 404 as any unknown path,
    // because a redirect would claim the surface still exists somewhere.

    // Bare root redirects to the Flutter app (D5). Root asset paths (e.g. /app.js) are not served.
    // See docs/architecture/monorepo.md.
    if (path === '/') return new Response(null, { status: 302, headers: { location: APP_MOUNT_PATH } });
    return new Response('Not found', { status: 404 });
  },
  websocket: {
    ...HISTORY_WEBSOCKET_OPTIONS,
    // Long sessions legitimately carry full inline artifacts in the initial broker -> app history
    // frame. `maxPayloadLength` is inbound-only, so the load-bearing outbound guardrail here is
    // `backpressureLimit` plus `closeOnBackpressureLimit:true`: if a full history frame still exceeds
    // the stopgap limit, the socket fails visibly instead of pretending the attach succeeded with a
    // partial record. Compression is opportunistic; image/base64-heavy histories may not shrink much.
    // Target design: docs/architecture/client-ui.md
    async open(ws) {
      const { tool, id, reason, expectedOwnerRevision, since, artifactMode } = ws.data;
      const sessionOptionsAbort = new AbortController();
      ws.data.sessionOptionsAbort = sessionOptionsAbort;
      let mode = ws.data.mode;
      const compatibility = ws.data.compatibility ?? evaluateBrokerClientCompatibility();
      const sendRaw: Client = (ev) => {
        try {
          const prepared =
            ev.kind === 'message'
              ? { ...ev, message: refMessage(tool, id, artifactMode, ev.message) }
              : ev.kind === 'history'
                ? { ...ev, messages: refMessages(tool, id, artifactMode, ev.messages) }
                : ev.kind === 'session' && ws.data.mc
                  ? hub.sessionDetailFrame(
                    ws.data.mc,
                    ws.data.credentialAuthenticated && !compatibility.readOnly,
                    decorateSession(ev.info),
                    compatibility.readOnly,
                  )
                : ev;
          const status = ws.send(JSON.stringify(prepared));
          if (status === 0) {
            try {
              ws.close(1011, 'websocket send dropped');
            } catch {
              /* already closed */
            }
          }
        } catch {
          /* socket closed */
        }
      };
      try {
        sendRaw({
          kind: 'hello',
          broker: { version: BUILD_INFO.version, contract: { ...BROKER_CONTRACT } },
          ...(ws.data.clientVersion ? { clientVersion: ws.data.clientVersion } : {}),
          compatibility,
        });
        if (compatibility.readOnly) {
          sendRaw({
            kind: 'notice',
            // A DECLARED read-only attach is not an incompatibility, and saying
            // so would send the user chasing a version mismatch that does not
            // exist. The negotiated status is what distinguishes them — and a
            // socket can be BOTH, in which case the incompatibility wins,
            // because that is the one the user can act on.
            message: ws.data.readOnlyRequested
              && compatibility.status !== 'hard-incompatible'
              ? `This session is read-only. ${compatibility.reason}`
              : `This client and broker are incompatible; the session is read-only. ${compatibility.reason}`,
          });
        }
        let mc: ManagedConn;
        try {
          // The Hub call is the single atomic ownership decision: it joins a pinned/driving/live
          // owner, dedupes concurrent restores onto one in-flight attach, and otherwise asks the
          // adapter — which arbitrates the reason (restore fails closed, takeover keeps its policy).
          mc = mode === 'resume' && reason === 'join-existing'
            ? hub.joinExisting(tool, id, expectedOwnerRevision!)
            : await hub.ensure(tool, id, mode, reason);
        } catch (err) {
          // A DENIED reason-tagged drive attach answers with a structured conflict frame and
          // continues as an Observe-class attach on the SAME socket, so the client keeps its
          // provenance and shows honest ownership instead of a reconnect loop.
          //
          // This must stay AHEAD of the generic live fallback below. That fallback exists for
          // eligibility that changed under an unattended live attach, and it absorbs the refusal
          // silently — correct when nobody asked for anything, wrong when a user pressed Take
          // over. Ordered the other way, a refused takeover is downgraded to Observe and the user
          // is told nothing about why the thing they explicitly asked for did not happen.
          if ((mode === 'resume' || mode === 'live') && reason) {
            const message = err instanceof Error ? err.message : String(err);
            // The ACTUAL requested mode: a takeover is refused as the live attach it was, and a
            // client that reads this frame to decide what to retry must not be told 'resume'.
            sendRaw({ kind: 'attach-conflict', requestedMode: mode, reason, code: driveAttachRefusalCode(err), message });
            mode = undefined;
            ws.data.mode = undefined; // close() must release the fallback owner's bare key
            mc = await hub.ensure(tool, id);
          } else if (mode === 'live' && isOwnershipConflictError(err)) {
            // Live eligibility can change between the roster/create response
            // and socket open. Fall back to the bare Observe owner on the SAME
            // socket; the authoritative session frame disarms the client's
            // retained live mode, preventing a reconnect loop. No new wire
            // frame is needed: the read-only control reason is in that frame.
            mode = undefined;
            ws.data.mode = undefined;
            mc = await hub.ensure(tool, id);
          } else {
            // A mode-only resume preserves the legacy error+close contract for older clients.
            throw err;
          }
        }
        // If the socket closed during the (up to ~4s) attach, close() already ran with no
        // client registered, so it could not arm eviction. Release now and bail — otherwise
        // we'd add a phantom client to a dead socket that never disconnects (permanent leak).
        if (ws.readyState !== 1) {
          hub.releaseAttached(tool, id, mode, mc);
          return;
        }
        ws.data.mc = mc;
        // Buffer live messages until history is delivered: guarantees history-then-live
        // order with no gap and no lost messages during the getHistory() round-trip (B2).
        let historyDone = false;
        const queue: WireEvent[] = [];
        const client: Client = (ev) => (historyDone ? sendRaw(ev) : queue.push(ev));
        client.onManagedConnChanged = (next) => {
          // Hub wrapper folds preserve this WebSocket. Retarget both inbound
          // mutation authority and close/release bookkeeping before the old
          // wrapper is disposed.
          mc = next;
          ws.data.mc = next;
          ws.data.sessionOptionsAbort?.abort();
          ws.data.sessionOptionsAbort = undefined;
        };
        ws.data.client = client;
        mc.addClient(client); // subscribe BEFORE the snapshot so nothing in the gap is dropped
        // Capture the in-flight streamed text NOW (atomic with addClient — no await between), so a
        // client joining mid-turn isn't missing what was streamed before it attached (history's
        // in-flight part is empty). queue captures everything after addClient → no gap, no double.
        const liveSnapshot = mc.liveSnapshot();
        const replayedPending = new Set(liveSnapshot.map(pendingReplayKey).filter((key): key is string => Boolean(key)));
        // Received files (broker-injected artifacts) and derived activity overlays are catch-up
        // frames, not cursor history. Keeping them out of the durable prefix prevents long-session
        // reattach from reset:true just because an elapsed/progress card changed or a broker artifact
        // snapshot was replayed. Governing doc: docs/architecture/client-ui.md
        sendRaw({ kind: 'session', info: mc.conn.info });
        const historyCacheScope = historyPageCacheScope(
          tool,
          id,
          artifactMode,
        );
        const historySourceBefore = await readHistorySourceIdentity(mc.conn);
        const initialLimit = ws.data.historyLimit ?? HISTORY_MAX_MESSAGES;
        let durableHistory: AgentMessage[] = [];
        let derivedHistory: AgentMessage[] = [];
        let delta: {
          messages: AgentMessage[];
          reset: boolean;
          /** Omitted only when the broker has nothing authoritative to say
           *  about this client's position (H1c). */
          cursor?: string;
          gap?: {
            code: string;
            reason?: string;
            message: string;
          };
          truncated?: { shown: number; total: number };
        } = {
          messages: [],
          reset: true,
          cursor: historyDelta([]).cursor,
        };
        let olderCursor: string | undefined;
        let hasEarlier = false;
        let compactDeliveredText: ReadonlyMap<string, number> | undefined;
        let usedCompactAttach = false;

        // A native random-access capture builds only compact cursor/location
        // metadata, then resolves the requested tail. In particular, the
        // initial Codex attach never calls getHistory() or materializes the
        // complete normalized rollout.
        if (
          historySourceBefore
          && typeof mc.conn.captureHistorySnapshot === 'function'
        ) {
          const source = historySourceBefore;
          const acceptCompactAttach = (
            attached: CompactHistoryAttach,
            options: {
              olderCursor?: string;
              gap?: { code: string; reason?: string; message: string };
            } = {},
          ): void => {
            durableHistory = attached.messages;
            delta = {
              messages: attached.messages,
              reset: attached.reset,
              cursor: attached.cursor,
              ...(options.gap
                ? { gap: options.gap }
                : attached.gap
                  ? {
                      gap: {
                        code: attached.gap.code,
                        reason: attached.gap.reason,
                        message: attached.gap.message,
                      },
                    }
                  : {}),
              ...(attached.truncated
                ? { truncated: attached.truncated }
                : {}),
            };
            olderCursor = options.olderCursor;
            hasEarlier = attached.hasEarlier;
            compactDeliveredText = attached.deliveredText;
          };

          /**
           * The index could not be built or could not answer (H1c).
           *
           * This used to send `reset: true` with NO messages and the cursor of
           * an empty history — an authoritative claim that the session has no
           * history and starts here. The client believed it: it cleared its
           * transcript and then rendered *full replay*, *Start of session*, and
           * *No messages* simultaneously, all three of them false.
           *
           * The honest answers, in order of preference: the newest bounded
           * window the source can still yield, or — when even that is
           * impossible — nothing at all, leaving the client's own window
           * exactly as it was. Neither one ever asserts an empty history or a
           * true session start.
           */
          const applyIndexUnavailable = async (
            kind: 'resource-limit' | 'source-changed',
          ): Promise<void> => {
            usedCompactAttach = true;
            // Terminal only for a measured overflow. A source that moved while
            // it was being indexed is the ordinary condition for an active
            // agent and must stay retriable on this same socket.
            ws.data.historyPagingUnavailableSource =
              kind === 'resource-limit' ? source : undefined;
            const fallback = await readBoundedTailHistoryReplay({
              scope: historyCacheScope,
              source,
              connection: mc.conn,
              artifactMode,
            });
            if (fallback) {
              const attached = fallback.replay.attach(since, initialLimit);
              const overlays = typeof mc.conn.getHistoryOverlays === 'function'
                ? await mc.conn.getHistoryOverlays({ artifactMode }).catch(() => [])
                : [];
              derivedHistory = [...attached.derivedMessages, ...overlays];
              // No `olderCursor`: the window is real, but nothing behind it can
              // be paged, and offering a reload that can only fail is exactly
              // the kind of false affordance this lane removes.
              acceptCompactAttach(attached, {
                gap: {
                  code: kind === 'resource-limit'
                    ? 'HISTORY_PAGE_RESOURCE_LIMIT'
                    : 'HISTORY_PAGE_SOURCE_CHANGED',
                  reason: kind,
                  // Says what this window actually is, including what it could
                  // not read or could not send whole (H1c round 3, finding 5).
                  message: boundedTailGapMessage(kind, fallback),
                },
              });
              return;
            }
            // Nothing usable could be read. Deliberately NOT a replacement, NOT
            // a cursor move, and NOT an empty history: whatever the client
            // already holds stays exactly as it is, and `hasEarlier` keeps the
            // start-of-history marker unreachable.
            durableHistory = [];
            derivedHistory = [];
            delta = {
              messages: [],
              reset: false,
              ...(since ? { cursor: since } : {}),
              gap: {
                code: kind === 'resource-limit'
                  ? 'HISTORY_PAGE_RESOURCE_LIMIT'
                  : 'HISTORY_PAGE_SOURCE_CHANGED',
                reason: kind,
                message: kind === 'resource-limit'
                  ? 'This native history exceeds every bounded reader; no messages could be replayed. Reconnect to retry.'
                  : 'This session changed while its history was being read; no messages could be replayed. Reconnect to retry.',
              },
            };
            olderCursor = undefined;
            hasEarlier = true;
          };

          const built = await buildCurrentHistoryPageCache({
            scope: historyCacheScope,
            source,
            connection: mc.conn,
            artifactMode,
          });
          if (built.kind === 'cache' && built.cache.kind === 'indexed') {
            const attached = await built.cache.loadAttach(
              since,
              initialLimit,
              { artifactMode },
            );
            if (!('kind' in attached)) {
              usedCompactAttach = true;
              const overlays = typeof mc.conn.getHistoryOverlays === 'function'
                ? await mc.conn.getHistoryOverlays({ artifactMode }).catch(() => [])
                : [];
              derivedHistory = [...attached.derivedMessages, ...overlays];
              acceptCompactAttach(attached, {
                olderCursor: attached.olderCursor,
              });
              ws.data.historyPagingUnavailableSource = undefined;
              ws.data.historyPagingUnavailableWithoutIdentity = false;
            } else {
              await applyIndexUnavailable(attached.kind);
            }
          } else if (built.kind !== 'cache') {
            await applyIndexUnavailable(built.kind);
          }
        }

        if (!usedCompactAttach) {
          const history = await readNativeHistory(
            mc.conn,
            artifactMode,
            'attach',
          );
          const historySourceAfter = await readHistorySourceIdentity(mc.conn);
          mc.observeHistory(history);
          // Cursor + capping run over the RAW history: oversized diffs are
          // stashed on EGRESS only, so unsent diffs are never hashed-to-blob.
          durableHistory = history.filter(isCursorDurableMessage);
          derivedHistory = history.filter((m) => !isCursorDurableMessage(m));
          delta = capHistoryDelta(
            historyDelta(durableHistory, since),
            initialLimit,
            durableHistory.length,
          );
          if (delta.truncated) {
            const seeded = seedHistoryPageCache({
              scope: historyCacheScope,
              sourceBefore: historySourceBefore,
              sourceAfter: historySourceAfter,
              history: durableHistory,
            });
            ws.data.historyPagingUnavailableSource = seeded
              ? undefined
              : sameHistorySourceRevision(
                    historySourceBefore,
                    historySourceAfter,
                  )
                ? historySourceAfter
                : undefined;
            ws.data.historyPagingUnavailableWithoutIdentity =
              !seeded && (!historySourceBefore || !historySourceAfter);
            olderCursor = backwardHistoryCursor(
              durableHistory,
              durableHistory.length - delta.truncated.shown,
            );
            hasEarlier = true;
          } else {
            ws.data.historyPagingUnavailableSource = undefined;
            ws.data.historyPagingUnavailableWithoutIdentity = false;
          }
        } else {
          mc.observeHistory(durableHistory);
        }
        const artifactSnapshot = mc.artifactSnapshot();
        // A frame with no cursor delivered nothing and moved nothing, so there
        // is no delivery position to receipt (H1c).
        if (delta.cursor !== undefined) {
          protocolJournal.issueTicket({
            identity: ws.data.identity,
            tool,
            sessionId: id,
          }, delta.cursor);
        }
        sendRaw({
          kind: 'history',
          messages: delta.messages,
          reset: delta.reset,
          ...(delta.cursor !== undefined
            ? { cursor: delta.cursor, attachTicket: delta.cursor }
            : {}),
          ...(delta.gap ? { gap: { code: delta.gap.code, reason: delta.gap.reason, message: delta.gap.message } } : {}),
          ...(delta.truncated ? { truncated: delta.truncated } : {}),
          ...(olderCursor ? { olderCursor } : {}),
          ...(hasEarlier ? { hasEarlier: true } : {}),
        });
        for (const m of derivedHistory) sendRaw({ kind: 'message', seq: 0, message: m });
        for (const m of artifactSnapshot) sendRaw({ kind: 'message', seq: 0, message: m });
        // One logical message can be BOTH persisted in history and still held in the live text
        // accumulator: a final that reached the adapter's saved history before the turn's idle
        // cleared the buffer. Those copies now share one adapter identity, so replaying the live one
        // would restate an already-delivered message as a less complete copy of itself — dropping
        // the `final` marker the turn projection reads. Send it only when it genuinely carries more
        // text than history delivered (a real mid-stream joiner). The live frames queued behind this
        // are NOT reconciled: they arrived after the snapshot, so they are newer state, not a replay
        // of it. (CR4)
        //
        // The map has to represent what the CLIENT holds after this attach, which is not the same
        // thing on both delta shapes. On `reset` it holds exactly what was sent, so reconciling
        // against the raw history would suppress an in-flight block that a small `initialHistory`
        // capped out of the frame — nothing else delivers it, so it would be lost. On a cursor
        // reconnect (`reset: false`) the frame carries only the tail, but the client already holds the
        // prefix its cursor acknowledges; leaving that prefix out replays the whole live snapshot
        // unreconciled, restating a delivered final without its `final` marker.
        const deliveredText = new Map<string, number>(
          compactDeliveredText ?? [],
        );
        for (const m of [...(delta.reset ? [] : durableHistory), ...delta.messages, ...derivedHistory]) {
          const key = liveOverlapKey(m);
          if (key) deliveredText.set(key, Math.max(deliveredText.get(key) ?? 0, liveOverlapTextLength(m)));
        }
        for (const m of liveSnapshot) {
          const key = liveOverlapKey(m);
          const delivered = key === undefined ? undefined : deliveredText.get(key);
          if (delivered !== undefined && liveOverlapTextLength(m) <= delivered) continue;
          sendRaw({ kind: 'message', seq: 0, message: m });
        }
        // Replay any PENDING permission/question request so a client joining an already-blocked session
        // sees the answer/approve box (not just the needs-input badge). The UI dedupes by requestId, so
        // this is idempotent across reattach/resync. Capability-driven (getPending is optional). (Issue G.)
        try {
          const pending = await Promise.resolve(mc.conn.getPending?.() ?? []);
          for (const m of pending) {
            const key = pendingReplayKey(m);
            if (key && replayedPending.has(key)) continue;
            if (key) replayedPending.add(key);
            sendRaw({ kind: 'message', seq: 0, message: m });
          }
        } catch {
          /* best-effort */
        }
        // Multi-client composer sync: a late joiner starts with the session's shared unsent draft.
        // A versioned client (contract ≥ 3) also receives a CLEAR TOMBSTONE — the empty text with
        // the revision that cleared it. Without that, a device that was offline when another client
        // cleared or sent the draft keeps its older clean local row and redisplays a draft the
        // session no longer has. A legacy client has no revision to compare and would simply have
        // its composer wiped, so it keeps the historical "replay non-empty only" contract.
        const draft = mc.draftSnapshot({
          includeTombstone: (ws.data.compatibility?.client?.revision ?? 0) >= DURABLE_DRAFT_CONTRACT_REVISION,
        });
        if (draft) sendRaw({ kind: 'draft', ...draft });
        historyDone = true;
        for (const ev of queue) {
          const key = pendingReplayEventKey(ev);
          if (key && replayedPending.has(key)) continue;
          if (key) replayedPending.add(key);
          sendRaw(ev);
        }
        queue.length = 0;
        // Attach is complete: accept prompts, replaying any sent before we were ready (S2),
        // in arrival order via the per-socket send chain.
        ws.data.ready = true;
        const pending = ws.data.pendingInbound ?? [];
        ws.data.pendingInbound = undefined;
        for (const raw of pending) routeInbound(ws, raw);
        // Send the slash-command list (non-blocking — doesn't delay prompt readiness).
        mc.conn
          .listCommands?.()
          .then((cmds) => cmds?.length && sendRaw({ kind: 'commands', commands: cmds }))
          .catch(() => {});
        // Send the model + agent + mode pickers (non-blocking). `modes` = permission modes (Claude).
        // Per-surface fault isolation + a BOUNDED refresh ladder:
        // an adapter whose backing service is still starting (managed `opencode serve` after a
        // restart, a codex daemon spawning the just-created thread) can serve agents while its model
        // catalog rejects/empties — sending once and stopping reproduced the recurring "agent chip
        // shown, no model selection on a new session" report. A non-empty response may also be
        // incomplete (Sol/Max before Sol/Max+Ultra), so the bounded ladder continues after models
        // arrive and sends only semantic changes.
        void refreshSessionOptions(
          mc.conn,
          (options) => sendRaw({ kind: 'options', ...options }),
          { signal: sessionOptionsAbort.signal },
        ).finally(() => {
          if (ws.data.sessionOptionsAbort === sessionOptionsAbort) {
            ws.data.sessionOptionsAbort = undefined;
          }
        });
      } catch (err) {
        sendRaw({ kind: 'error', message: `attach failed: ${String(err)}` });
        if (ws.data.mc && ws.data.client) ws.data.mc.removeClient(ws.data.client);
        if (ws.data.mc) hub.releaseAttached(tool, id, mode, ws.data.mc);
        else hub.release(tool, id, mode);
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      }
    },
    message(ws, raw) {
      // A prompt may arrive on the same tick as open() before attach finished; buffer it
      // rather than silently dropping it (the first-prompt-lost cold-attach bug, S2).
      if (!ws.data.ready) {
        (ws.data.pendingInbound ??= []).push(String(raw));
        return;
      }
      routeInbound(ws, String(raw));
    },
    close(ws) {
      ws.data.sessionOptionsAbort?.abort();
      ws.data.sessionOptionsAbort = undefined;
      const { mc, client, tool, id, mode } = ws.data;
      if (mc && client) mc.removeClient(client);
      if (mc) hub.releaseAttached(tool, id, mode, mc);
      else hub.release(tool, id, mode);
    },
  },
});

console.log(`${LOG_PREFIX} broker on http://${server.hostname}:${server.port}  (machine: ${MACHINE})`);
console.log(`${LOG_PREFIX} adapters: ${registry.list().map((b) => b.id).join(', ')}`);

// D20: bring up a broker-owned `opencode serve` so OpenCode is sync-by-default. Best-effort and
// non-fatal — skips cleanly when a serve is already running, the binary is absent, the URL is remote,
// or COSYNCING_OPENCODE_NO_AUTOSERVE=1. The child is torn down on broker exit.
void brokerUpdateChecker.inspect({ refresh: true }).catch(() => undefined);
const brokerUpdateTimer = setInterval(() => {
  void brokerUpdateChecker.inspect({ refresh: true }).catch(() => undefined);
}, BROKER_UPDATE_CHECK_INTERVAL_MS);
brokerUpdateTimer.unref?.();

const runtimeUpdatePollMs = Math.max(10_000, Number(process.env.COSYNCING_RUNTIME_UPDATE_POLL_MS ?? 60_000) || 60_000);
let runtimeUpdateTimer: ReturnType<typeof setInterval> | undefined;
const managedOpencodeStartup = ensureManagedOpencodeServe(() => !shuttingDown);
// External agent hosts (`kimi web`, `dsh web`): processes that exist with or
// without this broker. Every adapter is asked the same way — no tool-name branch
// — and an adapter that declares no external host answers 'not-applicable'.
//
// Default OFF per agent, so this is inert until an operator authorizes it. Even
// authorized, it only ever CREATES a host: anything already serving is
// classified and left exactly as it was found, because the one thing this must
// never do is disturb a host the user is running themselves.
const managedHostEffects = defaultManagedHostEffects();
const managedHostOwners = managedHostStore();
const managedHostStartup = Promise.allSettled(registry.list().map(async (backend) => {
  if (shuttingDown) return;
  const outcome = await ensureManagedHost(backend, managedHostEffects, managedHostOwners);
  if (outcome.action === 'not-applicable' || outcome.action === 'not-authorized') {
    // Nothing was attempted, so there is no failure to record and none to clear.
  } else if (outcome.action === 'start-failed') {
    // Persisted through the sanitizing journal rather than logged raw: this is
    // native output from another program, and it reaches an operator's disk.
    recordManagedRuntimeFailure({
      agent: backend.id, detailCode: outcome.detailCode, capturedOutput: outcome.capturedOutput,
    });
  } else {
    clearManagedRuntimeFailure(backend.id);
  }
  // What to SAY is decided next to the outcome type rather than here, so a
  // variant added to that union cannot reach an operator as silence — which is
  // exactly how `preserved-predecessor` went unreported.
  for (const line of managedHostStartupReport(backend.id, outcome)) {
    if (line.level === 'warn') console.warn(`${LOG_PREFIX} ${line.message}`);
    else console.log(`${LOG_PREFIX} ${line.message}`);
  }
})).catch(() => undefined);
/**
 * Supervision, which is the difference between "the broker can start a host" and
 * "the host is running".
 *
 * A managed host that dies at 3am is otherwise gone until someone restarts the
 * broker. Each tick asks the adapter's own readiness probe first, so a healthy
 * host costs one probe and nothing else, and only two PROVEN states lead to a
 * restart — see `recoverManagedHost`. Ticks never overlap: a slow probe delays
 * the next tick instead of stacking a second one on top of it.
 */
const managedHostSupervisor = new ManagedHostSupervisor({
  backends: () => registry.list(),
  effects: managedHostEffects,
  store: managedHostOwners,
  ledger: managedHostRestartLedger(),
  stopping: () => shuttingDown,
  onOutcome: (agent, outcome) => {
    if (outcome.action === 'recovered') {
      // Said only when a host is SERVING again — see `restart`. The journal is
      // cleared for the same reason the startup path clears it: a runtime that
      // came back must not leave doctor reporting a failure that is over.
      console.log(`${LOG_PREFIX} restarted the managed ${agent} host after it stopped serving`);
      clearManagedRuntimeFailure(agent);
    } else if (outcome.action === 'recovery-failed') {
      // The case that used to print the success line above. It is a warning AND
      // a durable record: nobody is reading the journal at 3am, so the only
      // thing still true in the morning is what doctor can read off disk.
      // `already-serving` reaching HERE means the address answered but what is
      // on it is not provably ours, so the verdict — not the action — is the
      // fact worth journalling: "another process holds this address" and "the
      // restart spawned nothing" need different answers from an operator.
      // The discriminant is read inline rather than through the boolean below,
      // because narrowing does not survive the indirection.
      const detailCode = outcome.outcome.action === 'start-failed'
        ? outcome.outcome.detailCode
        : outcome.outcome.action === 'already-serving'
          ? `host-recovery-address-${outcome.outcome.verdict}`
          : `host-recovery-${outcome.outcome.action}`;
      const addressHeldByStranger = outcome.outcome.action === 'already-serving';
      // The wording splits because the two failures are not the same fact. A
      // stranger holding the address IS serving — saying it is not would send
      // the operator looking for a process that is running fine — it simply is
      // not one this broker may manage. Everything else genuinely ended with no
      // host on the address.
      console.warn(addressHeldByStranger
        ? `${LOG_PREFIX} the configured ${agent} address is serving, but its process is not proven to be managed by ${PRODUCT_IDENTITY.productName} (${detailCode}) — run \`${PRODUCT_IDENTITY.primaryBinary} doctor\``
        : `${LOG_PREFIX} the managed ${agent} host is not serving and the restart did not bring it back (${detailCode}) — run \`${PRODUCT_IDENTITY.primaryBinary} doctor\``);
      recordManagedRuntimeFailure({
        agent,
        detailCode,
        ...(outcome.outcome.action === 'start-failed'
          ? { capturedOutput: outcome.outcome.capturedOutput }
          : {}),
      });
    } else if (outcome.action === 'declined' && outcome.reason === 'budget-exhausted') {
      console.warn(`${LOG_PREFIX} the managed ${agent} host keeps failing to stay up; not restarting it again — run \`cosyncing doctor\``);
    }
  },
  onError: (agent, error) => {
    console.error(`${LOG_PREFIX} managed ${agent} host supervision failed: ${String(error)}`);
  },
});
const managedHostSupervision = setInterval(() => {
  // Startup has to finish first, or the supervisor races the very start it is
  // supposed to be supervising. `tick()` is synchronous and self-guarding, so
  // this cannot queue ticks behind a slow one.
  void managedHostStartup.then(() => managedHostSupervisor.tick());
}, MANAGED_HOST_SUPERVISION_INTERVAL_MS);
managedHostSupervision.unref?.();

const runtimeStartup = (async () => {
  await managedOpencodeStartup;
  if (shuttingDown) return;
  // A broker start/restart is also a freshness checkpoint. Codex updates automatically only when the
  // selected Codex update policy accepts native loaded-thread activity; OpenCode's newly broker-owned
  // serve already uses the current binary. Unsafe drift remains pending indefinitely for manual recovery.
  await runtimeUpdates.refreshAll({ autoRestart: true });
  if (shuttingDown) return;
  runtimeUpdateTimer = setInterval(() => {
    void runtimeUpdates.refreshAll({ autoRestart: true }).catch((error) => {
      console.error(`${LOG_PREFIX} runtime-update probe failed: ${String(error)}`);
    });
  }, runtimeUpdatePollMs);
  runtimeUpdateTimer.unref?.();
})().catch((error) => console.error(`${LOG_PREFIX} runtime-update startup check failed: ${String(error)}`));
// issues-part2: a config edit (new provider/model) must not need a manual serve restart — the managed
// serve reloads by restarting itself when ~/.config/opencode/opencode.json(c) is newer than the process.
// C5 guardrail: defer that restart while a turn is in flight (isBusy) so a config edit never interrupts
// an active turn. The liveness signal is read generically off the backend capability (no tool-name
// branch); registry.get('opencode') is the owner of THIS serve, so wiring it here is serve-specific plumbing.
startOpencodeConfigWatch({
  shouldContinue: () => !shuttingDown,
  isBusy: () => {
    const b = registry.get('opencode');
    return typeof b?.anySessionBusy === 'function' ? b.anySessionBusy() : false;
  },
});

let resolveClosed!: () => void;
const closed = new Promise<void>((resolveClosedPromise) => {
  resolveClosed = resolveClosedPromise;
});
let shutdownPromise: Promise<void> | undefined;

async function shutdownBroker(reason = 'requested'): Promise<void> {
  if (reason !== 'restart' && !reason.endsWith('-restart')) replacementCancelled = true;
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    console.log(`[${PRODUCT_IDENTITY.productName}] broker shutdown (${reason})`);
    try {
      server?.stop(true);
    } catch (error) {
      console.warn(`[${PRODUCT_IDENTITY.productName}] listener shutdown failed: ${String(error)}`);
    }

    stopOpencodeConfigWatch();
    if (relaunchTimer) clearTimeout(relaunchTimer);
    relaunchTimer = undefined;
    if (runtimeUpdateTimer) clearInterval(runtimeUpdateTimer);
    clearInterval(brokerUpdateTimer);
    clearInterval(managedHostSupervision);
    clearInterval(brokerHealthCapacityTimer);
    clearInterval(brokerHealthCanaryTimer);
    clearInterval(brokerHealthDiagnosticsTimer);
    clearInterval(tokdashQuotaTimer);
    clearInterval(piBridgeSweepTimer);
    clearInterval(uploadGcTimer);
    for (const timer of scheduledConnectionReleaseTimers) clearInterval(timer);
    scheduledConnectionReleaseTimers.clear();
    for (const unsubscribe of sessionInfoWatchers) {
      if (typeof unsubscribe !== 'function') continue;
      try {
        unsubscribe();
      } catch (error) {
        console.warn(`${LOG_PREFIX} session watcher shutdown failed: ${String(error)}`);
      }
    }

    for (const [name, stop] of [
      ['attention scheduler', () => attentionScheduler.stop()],
      ['schedule runner', () => scheduleRunner.stop()],
      ['wake coalescer', () => wakeCoalescer.stop()],
    ] as const) {
      try {
        stop();
      } catch (error) {
        console.warn(`${LOG_PREFIX} ${name} shutdown failed: ${String(error)}`);
      }
    }

    await Promise.allSettled([
      hub.dispose(),
      stopManagedOpencodeServe(),
      stopCodexDaemonEnsureProcess(),
      // Reap only what this broker started. `releaseManagedHost` refuses to
      // signal anything it cannot prove ownership of, so calling it for every
      // agent is safe even on a machine full of hosts the operator runs.
      // Awaited via the startup promise AND the in-flight supervision tick, so
      // neither a host mid-launch nor one mid-RECOVERY is left behind by a
      // shutdown that raced it. Both are settle-only (`allSettled` inside,
      // `.catch` on the startup promise), so a failure in either cannot skip the
      // release pass that follows.
      managedHostStartup
        .then(() => managedHostSupervisor.settled())
        .then(() => Promise.allSettled(registry.list().map(async (backend) => {
        const outcome = await releaseManagedHost(backend, managedHostEffects, managedHostOwners);
        if (outcome.action === 'stopped') {
          console.log(`${LOG_PREFIX} stopped the managed ${backend.id} host (pid ${outcome.pid})`);
        }
      }))),
    ]);

    try {
      attentionService.dispose();
    } catch (error) {
      console.warn(`${LOG_PREFIX} attention store shutdown failed: ${String(error)}`);
    }
    try {
      brokerHealth.dispose();
    } catch (error) {
      console.warn(`${LOG_PREFIX} health monitor shutdown failed: ${String(error)}`);
    }
    cleanupTransientArtifactsSync();
  })().finally(resolveClosed);
  return shutdownPromise;
}

if (!server) throw new Error('broker listener did not start');
return { server, closed, shutdown: shutdownBroker };
}
