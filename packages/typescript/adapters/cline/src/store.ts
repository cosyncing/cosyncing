/** Read-only, bounded Cline session-snapshot discovery, across the schema
 *  versions listed in `CLINE_OBSERVE_VERSIONS`. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  compareSemanticVersions,
  lowestSemanticVersion,
  type HistorySourceIdentity,
  type SessionDiscoveryWork,
  type Unsubscribe,
} from '@cosyncing/adapter-api';

/**
 * Cline builds whose CLI, ACP and Hub contracts were physically captured.
 *
 * INFORMATIONAL: what the evidence covers, not what may Drive. Cline is
 * distributed through npm and updates itself, so gating Drive on membership
 * here would cost the operator Create and Resume on any ordinary update — this
 * repository has already lost a full lane to exactly that, when a self-update
 * from 3.0.60 to 3.0.61 removed a CLI flag mid-run.
 */
export const CLINE_MEASURED_VERSIONS: readonly string[] = Object.freeze([
  '3.0.60', '3.0.61',
]);

/**
 * The floor, and the only CLI-version comparison that gates Drive.
 *
 * What actually protects Drive is checked structurally, at use, each failing
 * closed with its own message:
 *
 *  - ACP protocol major — `AcpClient.connect` refuses an untested major;
 *  - agent identity — the initialize response must name `cline`;
 *  - Hub protocol — discovery must carry `protocolVersion` v1 exactly, plus a
 *    matching hubId, auth token, pid, port, host and URL;
 *  - Hub epoch — a replacement Hub revokes Drive rather than inheriting it;
 *  - snapshot schema — see `CLINE_OBSERVE_VERSIONS`, which stays an enumeration
 *    because an on-disk FORMAT cannot be inferred from version ordering;
 *  - ownership — Drive is limited to app-created sessions, and a foreign write
 *    demotes the writer.
 *
 * An older build is refused: a flag or capability that was never there is the
 * one thing none of those can detect.
 *
 * DERIVED, not chosen. Drive runs through the managed Hub, and a CLI ships the
 * `@cline/core` that Hub comes from, so a CLI floor below the Hub floor is a
 * contradiction rather than a preference: 3.0.60 cleared the CLI gate and was
 * advertised as the minimum, then had its Hub refused by `probeClineHub` --
 * which is the sole entry to the managed lane -- so every Create, Drive and
 * Resume failed on a version doctor called supported. Deriving it from the two
 * facts below makes that state unrepresentable.
 */
export const CLINE_MEASURED_HUB_CORE: Readonly<Record<string, string>> = Object.freeze({
  '3.0.60': '0.0.81',
  '3.0.61': '0.0.82',
});

/** The Hub core floor. Lives here, beside the CLI versions it is derived
 *  against; `hub.ts` re-exports it and owns the comparison. */
export const CLINE_HUB_CORE_MINIMUM_VERSION = '0.0.82';

/** Measured CLIs whose own Hub core clears the Hub floor, oldest kept first. */
const CLINE_DRIVABLE_MEASURED_VERSIONS = CLINE_MEASURED_VERSIONS.filter((cli) => {
  // `Object.hasOwn`, because a frozen object literal still inherits
  // `Object.prototype`: a CLI string of `constructor` or `toString` would return
  // a function here, survive an `undefined` check, and reach
  // `compareSemanticVersions` as a non-string. Unreachable with real version
  // strings, but the `Record<string, string>` type says it cannot happen and
  // that is exactly the sort of claim worth making true.
  if (!Object.hasOwn(CLINE_MEASURED_HUB_CORE, cli)) return false;
  const core = CLINE_MEASURED_HUB_CORE[cli];
  if (typeof core !== 'string') return false;
  const order = compareSemanticVersions(core, CLINE_HUB_CORE_MINIMUM_VERSION);
  return order !== undefined && order >= 0;
});

if (CLINE_DRIVABLE_MEASURED_VERSIONS.length === 0) {
  // Names the actual problem. This runs at module load and `runtime.ts` imports
  // this adapter statically, so an unexplained throw here is a broker that will
  // not boot with a message mentioning neither Cline nor the Hub. The state is
  // reachable by ordinary maintenance: raise `CLINE_HUB_CORE_MINIMUM_VERSION`
  // for a new Hub before any CLI shipping that Hub has been measured.
  throw new Error(
    `No measured Cline CLI ships a Hub core at or above ${CLINE_HUB_CORE_MINIMUM_VERSION}. `
      + `Measured pairs: ${Object.entries(CLINE_MEASURED_HUB_CORE)
        .map(([cli, core]) => `${cli}->${core}`).join(', ')}. `
      + 'Measure a CLI that ships the new Hub core before raising the Hub floor.',
  );
}

export const CLINE_MINIMUM_SUPPORTED_VERSION = lowestSemanticVersion(
  CLINE_DRIVABLE_MEASURED_VERSIONS,
);

/** Retained under its original name for operator-facing copy. */
export const CLINE_VERIFIED_VERSION = '3.0.61';

/** Snapshot schemas physically captured and accepted for read-only Observe.
 *
 *  Deliberately an ENUMERATION, unlike the version floor above. These name
 *  on-disk snapshot formats, and a newer CLI writing an unfamiliar format is
 *  not something a `>=` comparison can vouch for. 3.0.60 stays listed: sessions
 *  written by it are still on disk, and Observe is read-only. */
export const CLINE_OBSERVE_VERSIONS: readonly string[] = Object.freeze([
  '3.0.56', '3.0.60', CLINE_VERIFIED_VERSION,
]);
const CLINE_MEASURED_VERSION_SET = new Set(CLINE_MEASURED_VERSIONS);

export type ClineVersionStanding = 'measured' | 'newer-unmeasured' | 'below-floor' | 'unreadable';

export function clineVersionStanding(version: string | undefined): ClineVersionStanding {
  if (!version) return 'unreadable';
  // The floor is checked BEFORE measured-set membership, unlike Grok and Kilo.
  // For them the floor IS the minimum of the measured set, so the two can never
  // disagree. Cline's floor is derived against the Hub core instead, so 3.0.60
  // is measured AND below the floor -- and a membership test first returned
  // 'measured', which allows Drive, silently reinstating the contradiction that
  // deriving the floor was meant to remove.
  const order = compareSemanticVersions(version, CLINE_MINIMUM_SUPPORTED_VERSION);
  if (order === undefined) return 'unreadable';
  if (order < 0) return 'below-floor';
  return CLINE_MEASURED_VERSION_SET.has(version) ? 'measured' : 'newer-unmeasured';
}

/** Whether this build may Drive. Measured and newer-unmeasured both qualify. */
export function clineVersionAllowsDrive(version: string | undefined): boolean {
  const standing = clineVersionStanding(version);
  return standing === 'measured' || standing === 'newer-unmeasured';
}

export const CLINE_MAX_SESSIONS = 1_000;
export const CLINE_MAX_SUBAGENTS_PER_SESSION = 256;
export const CLINE_DISCOVERY_SCAN_ENTRIES = 20_000;
export const CLINE_MAX_METADATA_BYTES = 512 * 1024;
export const CLINE_MAX_MESSAGES_BYTES = 32 * 1024 * 1024;
export const CLINE_MAX_DISCOVERY_DECODE_BYTES = 64 * 1024 * 1024;
export const CLINE_MAX_MESSAGES = 100_000;
export const CLINE_MAX_BLOCKS_PER_MESSAGE = 1_024;
export const CLINE_MAX_TOTAL_BLOCKS = 200_000;

const MAX_ID_CHARS = 512;
const MAX_TITLE_CHARS = 4_096;
const MAX_PATH_CHARS = 32_768;
const MAX_MODEL_CHARS = 512;
// 3.0.60 ACP appends `_cli` and may use mixed-case base62; the earlier CLI
// form remains readable for existing durable sessions.
const SESSION_ID = /^\d{13}_[A-Za-z0-9]{5}(?:_cli)?$/u;
const SUBAGENT_FILE = /^(agent_\d{13}_[a-z0-9]{5,8})\.messages\.json$/u;
const CLINE_OBSERVE_VERSION_SET = new Set(CLINE_OBSERVE_VERSIONS);

export interface ClineStoreTrace {
  op: 'store-read' | 'path-refused' | 'schema-refused' | 'discovery-bound';
  path?: string;
  detail: string;
}

export interface ClineNativeMessage extends Record<string, unknown> {
  id: string;
  role: string;
  content: Array<Record<string, unknown>>;
}

export interface ClinePromptCorrelation {
  nativeMessageId: string;
  nativeMessageDigest: string;
  key: string;
  clientKey?: string;
}

export const CLINE_MAX_PROMPT_CORRELATIONS = 64;

type ClinePromptCorrelationHandler = (
  nativeMessageId: string | undefined,
  correlation: ClinePromptCorrelation | undefined,
) => void;

export type ClinePromptCorrelations = Map<string, ClinePromptCorrelation> & {
  subscribe?: (handler: ClinePromptCorrelationHandler) => Unsubscribe;
};

/** Per-session registry shared by the managed Hub writer and every Observe
 * connection. The adapter hydrates it only after proving the exact persisted
 * transcript boundary. */
export class ClinePromptCorrelationRegistry extends Map<string, ClinePromptCorrelation> {
  private readonly handlers = new Set<ClinePromptCorrelationHandler>();

  override set(nativeMessageId: string, value: ClinePromptCorrelation): this {
    const correlation = { ...value };
    const previous = this.get(nativeMessageId);
    let evicted = false;
    if (previous) super.delete(nativeMessageId);
    if (!previous && this.size >= CLINE_MAX_PROMPT_CORRELATIONS) {
      const oldest = this.keys().next().value;
      if (oldest !== undefined) {
        super.delete(oldest);
        evicted = true;
      }
    }
    super.set(nativeMessageId, correlation);
    const changed = previous?.nativeMessageDigest !== correlation.nativeMessageDigest
      || previous.key !== correlation.key
      || previous.clientKey !== correlation.clientKey;
    if (evicted || changed) {
      for (const handler of this.handlers) {
        if (evicted) handler(undefined, undefined);
        else handler(nativeMessageId, correlation);
      }
    }
    return this;
  }

  override clear(): void {
    if (this.size === 0) return;
    super.clear();
    for (const handler of this.handlers) handler(undefined, undefined);
  }

  subscribe(handler: ClinePromptCorrelationHandler): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

/** Compose the bounded replay projection into the cache identity without
 * changing the native identity used for writer ownership. */
export function clinePromptCorrelationHistoryIdentity(
  identity: HistorySourceIdentity,
  correlations: ReadonlyMap<string, ClinePromptCorrelation> | undefined,
): HistorySourceIdentity {
  const digest = createHash('sha256');
  const entries = [...(correlations?.values() ?? [])]
    .sort((left, right) => left.nativeMessageId.localeCompare(right.nativeMessageId));
  for (const correlation of entries) {
    digest.update(correlation.nativeMessageId).update('\0')
      .update(correlation.nativeMessageDigest).update('\0')
      .update(correlation.key).update('\0')
      .update(correlation.clientKey ?? '').update('\0');
  }
  return {
    ...identity,
    revision: `${identity.revision}:cline-correlation:${digest.digest('base64url')}`,
  };
}

export function clineNativeMessageDigest(message: ClineNativeMessage): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(message)).digest('hex')}`;
}

/** Transport-independent identity for projecting broker-owned terminal rows.
 * Hub ownership retains its stronger epoch/profile boundary separately. */
export function clineTerminalSummaryHistoryIdentity(
  sessionId: string,
  messages: readonly ClineNativeMessage[],
): HistorySourceIdentity {
  const digest = createHash('sha256');
  for (const message of messages) {
    digest.update(JSON.stringify(message));
    digest.update('\0');
  }
  return {
    sourceId: `cline-terminal-summary:${sessionId}`,
    revision: `${messages.length}:${digest.digest('hex')}`,
    appendPosition: messages.length,
    rewriteToken: messages[0]?.id ?? 'empty',
  };
}

export function clineTerminalSummaryBoundaryFromNative(
  sessionId: string,
  boundary: HistorySourceIdentity,
): HistorySourceIdentity {
  return { ...boundary, sourceId: `cline-terminal-summary:${sessionId}` };
}

export interface ClineUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalCost?: number;
}

export interface ClineStoredSession {
  id: string;
  nativeId: string;
  title: string;
  cwd: string;
  model?: string;
  currentModel?: { providerID: string; modelID: string };
  currentMode?: 'ask' | 'auto' | 'plan';
  createdAt?: number;
  updatedAt?: number;
  status: 'idle' | 'running';
  interrupted: boolean;
  pid?: number;
  origin?: 'subagent';
  parentThreadId?: string;
  storeRoot: string;
  dataRoot: string;
  sessionDir: string;
  metadataPath?: string;
  messagesPath: string;
  /** Exact broker-managed root capability. Only managed discovery/create may
   *  set this; ordinary/default-profile snapshots never receive it. */
  managedCosyncingRoot?: string;
  usage?: ClineUsage;
}

export interface ClineMessagesSnapshot {
  messages: ClineNativeMessage[];
  messageIds: string[];
  messageEncodings: string[];
  issues: string[];
  byteLength: number;
  identity?: HistorySourceIdentity;
  updatedAt?: number;
  agent?: string;
  taskType?: string;
  origin?: Record<string, unknown>;
  version?: number;
  model?: string;
  currentModel?: { providerID: string; modelID: string };
}

export interface ClineDiscoveryOptions {
  env?: Readonly<Record<string, string | undefined>>;
  homeDir?: string;
  updatedAfter?: number;
  maxSessions?: number;
  maxScanEntries?: number;
  maxDecodeBytes?: number;
  processAlive?: (pid: number) => boolean;
  signal?: AbortSignal;
  onWork?: (work: SessionDiscoveryWork) => void;
  trace?: (event: ClineStoreTrace) => void;
  /** Permit the measured Hub-created `source: cosyncing` parent shape only
   *  when every session path is canonical beneath this exact managed root. */
  managedCosyncingRoot?: string;
}

interface DiscoveryBudget { remaining: number; exceeded: boolean }
interface DecodeBudget { remaining: number; exceeded: boolean }

interface BoundedFile {
  text: string;
  byteLength: number;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxChars: number, trim = false): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars) return undefined;
  const result = trim ? value.trim() : value;
  return result.length > 0 && result.length <= maxChars ? result : undefined;
}

function boundedNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function usageOf(value: unknown): ClineUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: ClineUsage = {
    ...(boundedNumber(value.inputTokens) === undefined ? {} : { inputTokens: boundedNumber(value.inputTokens) }),
    ...(boundedNumber(value.outputTokens) === undefined ? {} : { outputTokens: boundedNumber(value.outputTokens) }),
    ...(boundedNumber(value.cacheReadTokens) === undefined ? {} : { cacheReadTokens: boundedNumber(value.cacheReadTokens) }),
    ...(boundedNumber(value.cacheWriteTokens) === undefined ? {} : { cacheWriteTokens: boundedNumber(value.cacheWriteTokens) }),
    ...(boundedNumber(value.totalCost) === undefined ? {} : { totalCost: boundedNumber(value.totalCost) }),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function sessionUsage(metadata: Record<string, unknown> | undefined): ClineUsage | undefined {
  if (!metadata) return undefined;
  const selected = usageOf(metadata.aggregateUsage) ?? usageOf(metadata.usage);
  const separateCost = boundedNumber(metadata.totalCost);
  if (!selected && separateCost === undefined) return undefined;
  return {
    ...(selected ?? {}),
    ...(selected?.totalCost !== undefined
      ? { totalCost: selected.totalCost }
      : separateCost === undefined ? {} : { totalCost: separateCost }),
  };
}

function sessionPermissionMode(metadata: Record<string, unknown> | undefined): ClineStoredSession['currentMode'] {
  const mode = boundedString(metadata?.mode, 64, true)?.toLowerCase();
  if (mode === 'plan') return 'plan';
  if (mode === 'act') return metadata?.autoApproveTools === true ? 'auto' : 'ask';
  return undefined;
}

export function clineStoreRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
  userHome = homedir(),
): string {
  return resolve(env.CLINE_DIR?.trim() || join(userHome, '.cline'));
}

export function clineDataRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
  userHome = homedir(),
): string {
  return resolve(env.CLINE_DATA_DIR?.trim() || join(clineStoreRoot(env, userHome), 'data'));
}

export function clinePathContained(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function openRegularInside(root: string, path: string): Promise<FileHandle | undefined> {
  if (!clinePathContained(root, path)) return undefined;
  let handle: FileHandle | undefined;
  try {
    const absoluteRoot = resolve(root);
    const absolutePath = resolve(path);
    const segments = relative(absoluteRoot, absolutePath).split(sep).filter(Boolean);
    const rootBefore = await realpath(absoluteRoot);
    let parent = absoluteRoot;
    for (const segment of segments.slice(0, -1)) {
      parent = join(parent, segment);
      const info = await lstat(parent);
      if (info.isSymbolicLink() || !info.isDirectory()) return undefined;
    }
    handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) throw new Error('not a regular file');
    const rootAfter = await realpath(absoluteRoot);
    const [pathInfo, pathTarget] = await Promise.all([lstat(absolutePath), realpath(absolutePath)]);
    if (rootAfter !== rootBefore
      || pathInfo.isSymbolicLink()
      || !pathInfo.isFile()
      || BigInt(pathInfo.dev) !== info.dev
      || BigInt(pathInfo.ino) !== info.ino
      || !clinePathContained(rootAfter, pathTarget)) throw new Error('opened path escaped store');
    return handle;
  } catch {
    await handle?.close().catch(() => undefined);
    return undefined;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Cline discovery aborted.');
}

async function yieldDiscoveryTurn(signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  throwIfAborted(signal);
}

interface BoundedReadOptions {
  signal?: AbortSignal;
  decodeBudget?: DecodeBudget;
}

async function readBoundedFile(
  root: string,
  path: string,
  maxBytes: number,
  options: BoundedReadOptions = {},
): Promise<BoundedFile | undefined> {
  throwIfAborted(options.signal);
  const handle = await openRegularInside(root, path);
  if (!handle) return undefined;
  try {
    const before = await handle.stat({ bigint: true });
    if (before.size > BigInt(maxBytes)) return undefined;
    if (options.decodeBudget && before.size > BigInt(options.decodeBudget.remaining)) {
      options.decodeBudget.exceeded = true;
      return undefined;
    }
    const chunks: Buffer[] = [];
    let byteLength = 0;
    while (byteLength <= maxBytes) {
      throwIfAborted(options.signal);
      const remaining = maxBytes + 1 - byteLength;
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, remaining)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, byteLength);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      byteLength += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (byteLength > maxBytes
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || BigInt(byteLength) !== after.size) return undefined;
    if (options.decodeBudget) options.decodeBudget.remaining -= byteLength;
    return {
      text: Buffer.concat(chunks, byteLength).toString('utf8'),
      byteLength,
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mtimeNs: after.mtimeNs,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readBoundedRecord(
  root: string,
  path: string,
  maxBytes: number,
  options: BoundedReadOptions = {},
): Promise<Record<string, unknown> | undefined> {
  const file = await readBoundedFile(root, path, maxBytes, options);
  if (!file) return undefined;
  try {
    const parsed: unknown = JSON.parse(file.text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function spend(budget: DiscoveryBudget): boolean {
  if (budget.remaining <= 0) {
    budget.exceeded = true;
    return false;
  }
  budget.remaining -= 1;
  return true;
}

async function safeDirectory(root: string, path: string): Promise<boolean> {
  if (!clinePathContained(root, path)) return false;
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function directoryNames(
  root: string,
  path: string,
  budget: DiscoveryBudget,
  signal?: AbortSignal,
): Promise<Array<{ name: string; directory: boolean; file: boolean }>> {
  throwIfAborted(signal);
  if (!await safeDirectory(root, path)) return [];
  const out: Array<{ name: string; directory: boolean; file: boolean }> = [];
  try {
    const directory = await opendir(path);
    for await (const entry of directory) {
      throwIfAborted(signal);
      if (!spend(budget)) break;
      out.push({ name: entry.name, directory: entry.isDirectory(), file: entry.isFile() });
    }
  } catch {
    return [];
  }
  return out;
}

function defaultProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process EXISTS and belongs to another user. Reading it as
    // dead made a live Cline session under another uid publish idle and get a
    // fabricated `run-summary status:'cancelled'`. Signal-0 semantics are what
    // the shared probe's own interface documents, and the broker's two other
    // implementations already honour them.
    return (error as NodeJS.ErrnoException | undefined)?.code === 'EPERM';
  }
}

function modelSelection(provider: unknown, model: unknown): { providerID: string; modelID: string } | undefined {
  const providerID = boundedString(provider, MAX_MODEL_CHARS, true);
  const modelID = boundedString(model, MAX_MODEL_CHARS, true);
  return providerID && modelID ? { providerID, modelID } : undefined;
}

function messageModel(messages: readonly ClineNativeMessage[]): { providerID: string; modelID: string } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'assistant' || !isRecord(message.modelInfo)) continue;
    const selection = modelSelection(message.modelInfo.provider, message.modelInfo.id);
    if (selection) return selection;
  }
  return undefined;
}

function measuredParentOriginMatches(
  origin: Record<string, unknown> | undefined,
  session: ClineStoredSession,
): boolean {
  if (origin?.mode !== 'user' || origin.sessionId !== session.id) return false;
  if (origin.source === 'cli') {
    return typeof origin.version === 'string' && CLINE_OBSERVE_VERSION_SET.has(origin.version);
  }
  // Hub 0.0.81 writes this exact discriminator for a session created through
  // session.create with metadata.source = "cosyncing". It deliberately has no
  // CLI version field: the managed writer's exact Hub/profile/version gates
  // live above this store decoder. Accept only the measured three-field shape
  // so a copied or future unmeasured document remains Observe-only/refused.
  const managedRoot = session.managedCosyncingRoot;
  const exactSessionDir = managedRoot ? join(resolve(managedRoot), 'sessions', session.id) : undefined;
  return managedRoot !== undefined
    && session.nativeId === session.id
    && resolve(session.dataRoot) === resolve(managedRoot)
    && resolve(session.sessionDir) === exactSessionDir
    && session.metadataPath !== undefined
    && resolve(session.metadataPath) === join(exactSessionDir!, `${session.id}.json`)
    && resolve(session.messagesPath) === join(exactSessionDir!, `${session.id}.messages.json`)
    && origin.source === 'cosyncing'
    && Object.keys(origin).length === 3;
}

interface ReadClineMessagesOptions extends BoundedReadOptions {}

export async function readClineMessages(
  session: ClineStoredSession,
  options: ReadClineMessagesOptions = {},
): Promise<ClineMessagesSnapshot> {
  const file = await readBoundedFile(
    session.dataRoot,
    session.messagesPath,
    CLINE_MAX_MESSAGES_BYTES,
    options,
  );
  if (!file) {
    return {
      messages: [], messageIds: [], messageEncodings: [],
      issues: [`messages snapshot is missing, unstable, unsafe, or exceeds ${CLINE_MAX_MESSAGES_BYTES} bytes`],
      byteLength: 0,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.text);
  } catch {
    return { messages: [], messageIds: [], messageEncodings: [], issues: ['messages snapshot is malformed JSON'], byteLength: file.byteLength };
  }
  if (!isRecord(parsed) || parsed.sessionId !== session.id || !Array.isArray(parsed.messages)) {
    return { messages: [], messageIds: [], messageEncodings: [], issues: ['messages snapshot identity/schema mismatch'], byteLength: file.byteLength };
  }
  const origin = isRecord(parsed.origin) ? parsed.origin : undefined;
  const nativeShapeMatches = parsed.version === 1
    && (session.origin === 'subagent'
      ? parsed.agent === 'subagent'
        && parsed.taskType === 'subagent_task'
        && origin?.source === 'cli'
        && origin.mode === 'subagent'
        && origin.sessionId === session.id
        && origin.parentThreadId === session.parentThreadId
        && origin.subagent === session.id.split('__')[1]
        && typeof origin.version === 'string'
        && CLINE_OBSERVE_VERSION_SET.has(origin.version)
      : parsed.agent === 'lead'
        && parsed.taskType === undefined
        && measuredParentOriginMatches(origin, session));
  if (!nativeShapeMatches) {
    return { messages: [], messageIds: [], messageEncodings: [], issues: ['messages snapshot native discriminator/origin mismatch'], byteLength: file.byteLength };
  }
  if (parsed.messages.length > CLINE_MAX_MESSAGES) {
    return { messages: [], messageIds: [], messageEncodings: [], issues: [`messages snapshot exceeds ${CLINE_MAX_MESSAGES} records`], byteLength: file.byteLength };
  }
  const messages: ClineNativeMessage[] = [];
  const messageIds: string[] = [];
  const messageEncodings: string[] = [];
  const seen = new Set<string>();
  let totalBlocks = 0;
  let sliceStartedAt = Date.now();
  for (let index = 0; index < parsed.messages.length; index += 1) {
    // A discovery snapshot may contain 100k messages. Validation and the
    // canonical JSON encoding below are synchronous per record; without a
    // macrotask turn the entire snapshot sits ahead of broker health/status and
    // every live socket. Check elapsed work as well as record count so both
    // many small records and fewer dense ones remain cooperative.
    if (index > 0 && index % 64 === 0 && Date.now() - sliceStartedAt >= 8) {
      await yieldDiscoveryTurn(options.signal);
      sliceStartedAt = Date.now();
    }
    const raw = parsed.messages[index];
    if (!isRecord(raw)) {
      return { messages: [], messageIds: [], messageEncodings: [], issues: [`message ${index} is not an object`], byteLength: file.byteLength };
    }
    const id = boundedString(raw.id, MAX_ID_CHARS);
    const role = boundedString(raw.role, 64, true);
    if (!id || !role || !Array.isArray(raw.content) || seen.has(id)) {
      return { messages: [], messageIds: [], messageEncodings: [], issues: [`message ${index} has invalid or duplicate identity/content`], byteLength: file.byteLength };
    }
    if (raw.content.length > CLINE_MAX_BLOCKS_PER_MESSAGE) {
      return { messages: [], messageIds: [], messageEncodings: [], issues: [`message ${index} exceeds ${CLINE_MAX_BLOCKS_PER_MESSAGE} content blocks`], byteLength: file.byteLength };
    }
    totalBlocks += raw.content.length;
    if (totalBlocks > CLINE_MAX_TOTAL_BLOCKS || raw.content.some((block) => !isRecord(block))) {
      return { messages: [], messageIds: [], messageEncodings: [], issues: [`messages snapshot exceeds the supported block shape/count`], byteLength: file.byteLength };
    }
    seen.add(id);
    const message = { ...raw, id, role, content: raw.content as Array<Record<string, unknown>> } as ClineNativeMessage;
    messages.push(message);
    messageIds.push(id);
    messageEncodings.push(JSON.stringify(raw));
  }
  const firstId = messageIds[0] ?? 'empty';
  const lastId = messageIds.at(-1) ?? 'empty';
  const currentModel = messageModel(messages);
  return {
    messages,
    messageIds,
    messageEncodings,
    issues: [],
    byteLength: file.byteLength,
    identity: {
      sourceId: session.messagesPath,
      revision: `${String(file.mtimeNs)}:${String(file.size)}:${lastId}`,
      rewriteToken: firstId,
    },
    updatedAt: parseTimestamp(parsed.updated_at),
    version: 1,
    ...(boundedString(parsed.agent, 64, true) ? { agent: boundedString(parsed.agent, 64, true) } : {}),
    ...(boundedString(parsed.taskType, 128, true) ? { taskType: boundedString(parsed.taskType, 128, true) } : {}),
    ...(isRecord(parsed.origin) ? { origin: parsed.origin } : {}),
    ...(currentModel ? {
      currentModel,
      model: `${currentModel.providerID}/${currentModel.modelID}`,
    } : {}),
  };
}

export async function clineHistorySourceIdentity(session: ClineStoredSession): Promise<HistorySourceIdentity | undefined> {
  const snapshot = await readClineMessages(session);
  return snapshot.issues.length === 0 ? snapshot.identity : undefined;
}

function statusFromMetadata(
  metadata: Record<string, unknown>,
  processAlive: (pid: number) => boolean,
): { status: 'idle' | 'running'; interrupted: boolean; pid?: number } {
  const pid = typeof metadata.pid === 'number' && Number.isSafeInteger(metadata.pid) && metadata.pid > 0
    ? metadata.pid
    : undefined;
  const ended = parseTimestamp(metadata.ended_at) !== undefined;
  const nativeStatus = boundedString(metadata.status, 64, true)?.toLowerCase();
  const claimsRunning = !ended && ['running', 'active', 'working', 'starting'].includes(nativeStatus ?? '');
  const alive = pid !== undefined && processAlive(pid);
  return {
    status: claimsRunning && alive ? 'running' : 'idle',
    interrupted: claimsRunning && !alive,
    ...(pid === undefined ? {} : { pid }),
  };
}

function maxTimestamp(...values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length > 0 ? Math.max(...present) : undefined;
}

export async function refreshClineSessionMetadata(
  session: ClineStoredSession,
  processAlive: (pid: number) => boolean = defaultProcessAlive,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!session.metadataPath) return true;
  const metadata = await readBoundedRecord(
    session.dataRoot,
    session.metadataPath,
    CLINE_MAX_METADATA_BYTES,
    signal ? { signal } : {},
  );
  if (!metadata || metadata.session_id !== session.parentThreadId && metadata.session_id !== session.id) return false;
  const native = statusFromMetadata(metadata, processAlive);
  const metadataRecord = isRecord(metadata.metadata) ? metadata.metadata : undefined;
  const currentModel = modelSelection(metadata.provider, metadata.model);
  session.status = native.status;
  session.interrupted = native.interrupted;
  if (native.pid === undefined) delete session.pid;
  else session.pid = native.pid;
  if (currentModel) {
    session.currentModel = currentModel;
    session.model = `${currentModel.providerID}/${currentModel.modelID}`;
  } else {
    delete session.currentModel;
    delete session.model;
  }
  const usage = sessionUsage(metadataRecord);
  if (usage) session.usage = usage;
  else delete session.usage;
  const currentMode = sessionPermissionMode(metadataRecord);
  if (currentMode) session.currentMode = currentMode;
  else delete session.currentMode;
  session.updatedAt = maxTimestamp(
    session.updatedAt,
    parseTimestamp(metadata.ended_at),
    parseTimestamp(metadata.started_at),
  );
  return true;
}

export async function discoverClineStore(options: ClineDiscoveryOptions = {}): Promise<ClineStoredSession[]> {
  const env = options.env ?? process.env;
  const userHome = options.homeDir ?? homedir();
  const storeRoot = clineStoreRoot(env, userHome);
  const dataRoot = clineDataRoot(env, userHome);
  const managedCosyncingRoot = options.managedCosyncingRoot
    && resolve(options.managedCosyncingRoot) === dataRoot
    ? dataRoot
    : undefined;
  const sessionsRoot = join(dataRoot, 'sessions');
  const budget: DiscoveryBudget = {
    remaining: Math.max(1, Math.min(options.maxScanEntries ?? CLINE_DISCOVERY_SCAN_ENTRIES, CLINE_DISCOVERY_SCAN_ENTRIES)),
    exceeded: false,
  };
  const decodeBudget: DecodeBudget = {
    remaining: Math.max(1, Math.min(
      options.maxDecodeBytes ?? CLINE_MAX_DISCOVERY_DECODE_BYTES,
      CLINE_MAX_DISCOVERY_DECODE_BYTES,
    )),
    exceeded: false,
  };
  const maxSessions = Math.max(1, Math.min(options.maxSessions ?? CLINE_MAX_SESSIONS, CLINE_MAX_SESSIONS));
  const roots = await directoryNames(dataRoot, sessionsRoot, budget, options.signal);
  if (budget.exceeded) {
    options.trace?.({ op: 'discovery-bound', detail: 'Cline session enumeration exhausted its work budget; refusing partial discovery' });
    return [];
  }
  const out: ClineStoredSession[] = [];
  const seenIds = new Set<string>();
  const processAlive = options.processAlive ?? defaultProcessAlive;
  for (const entry of roots) {
    throwIfAborted(options.signal);
    if (!entry.directory || !SESSION_ID.test(entry.name)) continue;
    if (out.length >= maxSessions) {
      options.trace?.({ op: 'discovery-bound', detail: `Cline roster exceeds ${maxSessions} sessions; refusing partial discovery` });
      return [];
    }
    const id = entry.name;
    const sessionDir = join(sessionsRoot, id);
    if (!await safeDirectory(dataRoot, sessionDir)) continue;
    const metadataPath = join(sessionDir, `${id}.json`);
    const messagesPath = join(sessionDir, `${id}.messages.json`);
    options.onWork?.({ kind: 'decode-file', source: 'cline-session-metadata' });
    const metadata = await readBoundedRecord(dataRoot, metadataPath, CLINE_MAX_METADATA_BYTES, {
      ...(options.signal ? { signal: options.signal } : {}),
      decodeBudget,
    });
    if (decodeBudget.exceeded) {
      options.trace?.({ op: 'discovery-bound', detail: 'Cline discovery exhausted its cumulative decode-byte budget; refusing partial discovery' });
      return [];
    }
    if (!metadata || metadata.session_id !== id) {
      options.trace?.({ op: 'schema-refused', path: metadataPath, detail: 'session metadata identity/schema mismatch' });
      continue;
    }
    const cwd = boundedString(metadata.cwd, MAX_PATH_CHARS)
      ?? boundedString(metadata.workspace_root, MAX_PATH_CHARS);
    if (!cwd || !isAbsolute(cwd)) {
      options.trace?.({ op: 'schema-refused', path: metadataPath, detail: 'session cwd is missing, relative, or oversized' });
      continue;
    }
    const currentModel = modelSelection(metadata.provider, metadata.model);
    const model = currentModel ? `${currentModel.providerID}/${currentModel.modelID}` : undefined;
    const native = statusFromMetadata(metadata, processAlive);
    const metadataRecord = isRecord(metadata.metadata) ? metadata.metadata : undefined;
    const createdAt = parseTimestamp(metadata.started_at);
    const endedAt = parseTimestamp(metadata.ended_at);
    const provisional: ClineStoredSession = {
      id,
      nativeId: id,
      title: boundedString(metadataRecord?.title, MAX_TITLE_CHARS, true) ?? id,
      cwd: resolve(cwd),
      ...(model ? { model } : {}),
      ...(currentModel ? { currentModel } : {}),
      ...(sessionPermissionMode(metadataRecord) ? { currentMode: sessionPermissionMode(metadataRecord) } : {}),
      ...(createdAt === undefined ? {} : { createdAt }),
      status: native.status,
      interrupted: native.interrupted,
      ...(native.pid === undefined ? {} : { pid: native.pid }),
      storeRoot,
      dataRoot,
      sessionDir,
      metadataPath,
      messagesPath,
      ...(managedCosyncingRoot ? { managedCosyncingRoot } : {}),
      ...(sessionUsage(metadataRecord) ? { usage: sessionUsage(metadataRecord) } : {}),
    };
    provisional.updatedAt = maxTimestamp(endedAt, createdAt);

    let mainSnapshot: ClineMessagesSnapshot | undefined;
    let mainRead = false;
    const ensureMainSnapshot = async (): Promise<ClineMessagesSnapshot | undefined> => {
      if (mainRead) return mainSnapshot;
      mainRead = true;
      options.onWork?.({ kind: 'decode-file', source: 'cline-message-snapshot' });
      const snapshot = await readClineMessages(provisional, {
        ...(options.signal ? { signal: options.signal } : {}),
        decodeBudget,
      });
      if (decodeBudget.exceeded) return undefined;
      if (snapshot.issues.length > 0 || !snapshot.identity) {
        options.trace?.({ op: 'schema-refused', path: messagesPath, detail: snapshot.issues.join('; ') });
        return undefined;
      }
      provisional.updatedAt = maxTimestamp(snapshot.updatedAt, endedAt, createdAt);
      mainSnapshot = snapshot;
      return snapshot;
    };

    const metadataProvesStale = options.updatedAfter !== undefined
      && native.status !== 'running'
      && endedAt !== undefined
      && endedAt < options.updatedAfter;
    let parentIncluded = false;
    if (!metadataProvesStale) {
      const snapshot = await ensureMainSnapshot();
      if (decodeBudget.exceeded) {
        options.trace?.({ op: 'discovery-bound', detail: 'Cline discovery exhausted its cumulative decode-byte budget; refusing partial discovery' });
        return [];
      }
      if (!snapshot) continue;
      parentIncluded = native.status === 'running'
        || options.updatedAfter === undefined
        || (provisional.updatedAt ?? 0) >= options.updatedAfter;
      if (parentIncluded) {
        out.push(provisional);
        seenIds.add(provisional.id);
      }
    }

    const siblings = await directoryNames(dataRoot, sessionDir, budget, options.signal);
    if (budget.exceeded) {
      options.trace?.({ op: 'discovery-bound', detail: 'Cline subagent enumeration exhausted its work budget; refusing partial discovery' });
      return [];
    }
    const subagentFiles = siblings.filter((candidate) => candidate.file && SUBAGENT_FILE.test(candidate.name));
    if (subagentFiles.length > CLINE_MAX_SUBAGENTS_PER_SESSION) {
      options.trace?.({ op: 'discovery-bound', path: sessionDir, detail: `session exceeds ${CLINE_MAX_SUBAGENTS_PER_SESSION} subagent snapshots; refusing partial discovery` });
      return [];
    }
    for (const childFile of subagentFiles) {
      throwIfAborted(options.signal);
      if (out.length >= maxSessions) {
        options.trace?.({ op: 'discovery-bound', detail: `Cline roster exceeds ${maxSessions} sessions; refusing partial discovery` });
        return [];
      }
      const match = childFile.name.match(SUBAGENT_FILE);
      const suffix = match?.[1];
      if (!suffix) continue;
      const childId = `${id}__${suffix}`;
      const childPath = join(sessionDir, childFile.name);
      const {
        metadataPath: _metadataPath,
        usage: _usage,
        model: _model,
        currentModel: _currentModel,
        currentMode: _currentMode,
        updatedAt: _updatedAt,
        createdAt: _createdAt,
        pid: _pid,
        ...childBase
      } = provisional;
      const child: ClineStoredSession = {
        ...childBase,
        id: childId,
        nativeId: childId,
        title: `Cline subagent ${suffix.replace(/^agent_/u, '')}`,
        origin: 'subagent',
        parentThreadId: id,
        messagesPath: childPath,
        status: 'idle',
        interrupted: false,
      };
      options.onWork?.({ kind: 'decode-file', source: 'cline-subagent-message-snapshot' });
      const childSnapshot = await readClineMessages(child, {
        ...(options.signal ? { signal: options.signal } : {}),
        decodeBudget,
      });
      if (decodeBudget.exceeded) {
        options.trace?.({ op: 'discovery-bound', detail: 'Cline discovery exhausted its cumulative decode-byte budget; refusing partial discovery' });
        return [];
      }
      if (childSnapshot.issues.length > 0
        || !childSnapshot.identity
        || seenIds.has(childId)) {
        options.trace?.({
          op: 'schema-refused',
          path: childPath,
          detail: childSnapshot.issues.join('; ') || 'subagent identity or parent linkage mismatch',
        });
        continue;
      }
      child.updatedAt = childSnapshot.updatedAt;
      if (childSnapshot.currentModel && childSnapshot.model) {
        child.currentModel = childSnapshot.currentModel;
        child.model = childSnapshot.model;
      }
      if (options.updatedAfter === undefined || (child.updatedAt ?? 0) >= options.updatedAfter) {
        if (!parentIncluded) {
          const snapshot = await ensureMainSnapshot();
          if (decodeBudget.exceeded) {
            options.trace?.({ op: 'discovery-bound', detail: 'Cline discovery exhausted its cumulative decode-byte budget; refusing partial discovery' });
            return [];
          }
          if (!snapshot) continue;
          if (out.length >= maxSessions) {
            options.trace?.({ op: 'discovery-bound', detail: `Cline roster exceeds ${maxSessions} sessions; refusing partial discovery` });
            return [];
          }
          out.push(provisional);
          seenIds.add(provisional.id);
          parentIncluded = true;
        }
        if (out.length >= maxSessions) {
          options.trace?.({ op: 'discovery-bound', detail: `Cline roster exceeds ${maxSessions} sessions; refusing partial discovery` });
          return [];
        }
        out.push(child);
      }
      seenIds.add(childId);
    }
  }
  return out;
}
