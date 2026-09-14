/** Read-only, bounded Grok Build store discovery and update-log reads. */
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { compareSemanticVersions, lowestSemanticVersion, type HistorySourceIdentity } from '@cosyncing/adapter-api';
import type { GrokUpdateEntry, GrokUpdateRecord } from './mapping.ts';

/**
 * Grok builds whose ACP and store contracts have been physically captured.
 *
 * INFORMATIONAL. This list is what doctor reports and what the evidence covers;
 * it is deliberately NOT the thing that decides whether Drive is offered. Grok
 * updates itself in place and the operator does not choose when, so any gate
 * keyed to an enumerated version is a gate the user cannot satisfy — this box
 * drifted 1.0.13 to 1.0.24 unattended, and Drive was refused for a build that
 * `scripts/adapters/compare-grok-acp-contract.ts` then showed to be identical
 * across all eleven releases on every point the adapter reads.
 */
export const GROK_MEASURED_VERSIONS: readonly string[] = Object.freeze([
  '1.0.13',
  '1.0.24',
]);

const GROK_MEASURED_VERSION_SET = new Set(GROK_MEASURED_VERSIONS);

/**
 * The floor, and the only version comparison that gates anything.
 *
 * A NEWER build is admitted without being enumerated here. That is safe because
 * every contract this adapter depends on is already enforced where it is used,
 * each failing closed with a specific message rather than a version mismatch:
 *
 *  - ACP protocol major — `AcpClient.connect` fails closed on an untested major
 *    (`acp-client/src/client.ts`);
 *  - authentication — `grokAuthMethod` rejects a missing or malformed catalog
 *    and says to run `grok login` when reusable auth is gone (`auth.ts`);
 *  - store shape — `discoverGrokStore` schema-refuses anything that is not a
 *    canonical UUIDv7 session directory with the expected files;
 *  - update kinds — unknown kinds map to named neutral context, never a human
 *    bubble (`mapping.ts`);
 *  - ownership — Create grants Drive only when ACP and the durable store return
 *    the SAME new UUID, so a changed store layout withholds Drive by itself.
 *
 * An OLDER build is refused, because those layers cannot detect a capability
 * that was never there — only a floor can.
 */
export const GROK_MINIMUM_SUPPORTED_VERSION = lowestSemanticVersion(GROK_MEASURED_VERSIONS);

/** Retained under its original name: the version named in operator copy. */
export const GROK_VERIFIED_VERSION = GROK_MINIMUM_SUPPORTED_VERSION;

export type GrokVersionStanding = 'measured' | 'newer-unmeasured' | 'below-floor' | 'unreadable';

export function grokVersionStanding(version: string | undefined): GrokVersionStanding {
  if (!version) return 'unreadable';
  if (GROK_MEASURED_VERSION_SET.has(version)) return 'measured';
  const order = compareSemanticVersions(version, GROK_MINIMUM_SUPPORTED_VERSION);
  if (order === undefined) return 'unreadable';
  return order < 0 ? 'below-floor' : 'newer-unmeasured';
}

/** Whether this build may Drive. Measured and newer-unmeasured both qualify. */
export function grokVersionAllowsDrive(version: string | undefined): boolean {
  const standing = grokVersionStanding(version);
  return standing === 'measured' || standing === 'newer-unmeasured';
}
export const GROK_MAX_SESSIONS = 1_000;
export const GROK_MAX_CWD_GROUPS = 1_000;
export const GROK_DISCOVERY_SCAN_ENTRIES = 20_000;
export const GROK_MAX_SUMMARY_BYTES = 256 * 1024;
export const GROK_MAX_SIGNALS_BYTES = 256 * 1024;
export const GROK_MAX_SUBAGENT_META_BYTES = 256 * 1024;
export const GROK_MAX_UPDATES_BYTES = 32 * 1024 * 1024;
export const GROK_MAX_UPDATE_LINE_BYTES = 2 * 1024 * 1024;
export const GROK_MAX_UPDATE_LINES = 100_000;
const MAX_TITLE_CHARS = 4_096;
const MAX_MODEL_CHARS = 512;
const MAX_CWD_CHARS = 32_768;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface GrokStoreTrace {
  op: 'store-read' | 'path-refused' | 'schema-refused' | 'discovery-bound';
  path?: string;
  detail: string;
}

export interface GrokStoredSession {
  id: string;
  title: string;
  cwd: string;
  model?: string;
  currentModel?: { providerID: string; modelID: string; reasoningEffort?: string };
  currentAgent?: string;
  createdAt?: number;
  updatedAt?: number;
  /** Native summary message count. Zero identifies the measured promptless
   * state whose persisted effort may lag an explicitly confirmed load. */
  messageCount?: number;
  status: 'idle';
  origin?: 'subagent';
  parentThreadId?: string;
  storeRoot: string;
  sessionDir: string;
  summaryPath: string;
  updatesPath: string;
  signalsPath: string;
}

export interface GrokDiscoveryOptions {
  root?: string;
  updatedAfter?: number;
  maxSessions?: number;
  maxScanEntries?: number;
  trace?: (event: GrokStoreTrace) => void;
}

export interface GrokUpdatesRead {
  entries: GrokUpdateEntry[];
  issues: string[];
  byteLength: number;
  durablePrefixBytes: Buffer;
  identity?: HistorySourceIdentity;
}

interface DiscoveryBudget { remaining: number; exceeded: boolean }

interface GrokSessionCandidate {
  sessionDir: string;
  groupCwd: string;
  mtimeMs: number;
}

interface GrokParsedCandidate {
  session: GrokStoredSession;
  sessionKind?: 'subagent';
}

interface GrokLineageClaim {
  childId: string;
  parentId: string;
  childCwd: string;
  metaPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxChars: number, trim = false): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars) return undefined;
  if (!trim) return value;
  const normalized = value.trim();
  return normalized && normalized.length <= maxChars ? normalized : undefined;
}

export function grokStoreRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
  userHome = homedir(),
): string {
  return resolve(env.GROK_HOME?.trim() || join(userHome, '.grok'));
}

export function grokPathContained(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function openRegularInside(root: string, path: string): Promise<FileHandle | undefined> {
  if (!grokPathContained(root, path)) return undefined;
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
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('not a regular file');
    const rootAfter = await realpath(absoluteRoot);
    const [pathInfo, pathTarget] = await Promise.all([lstat(absolutePath), realpath(absolutePath)]);
    if (rootAfter !== rootBefore
      || pathInfo.isSymbolicLink()
      || !pathInfo.isFile()
      || pathInfo.dev !== info.dev
      || pathInfo.ino !== info.ino
      || !grokPathContained(rootAfter, pathTarget)) throw new Error('opened path escaped store');
    return handle;
  } catch {
    await handle?.close().catch(() => undefined);
    return undefined;
  }
}

async function readHandleBounded(
  handle: FileHandle,
  maxBytes: number,
): Promise<{ text: string; bytes: Buffer; byteLength: number } | undefined> {
  const initial = await handle.stat();
  if (initial.size > maxBytes) return undefined;
  const chunks: Buffer[] = [];
  let byteLength = 0;
  while (byteLength <= maxBytes) {
    const remaining = maxBytes + 1 - byteLength;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, remaining)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, byteLength);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    byteLength += bytesRead;
  }
  if (byteLength > maxBytes) return undefined;
  const bytes = Buffer.concat(chunks, byteLength);
  return { text: bytes.toString('utf8'), bytes, byteLength };
}

async function readBoundedJson(
  root: string,
  path: string,
  maxBytes: number,
): Promise<Record<string, unknown> | undefined> {
  const handle = await openRegularInside(root, path);
  if (!handle) return undefined;
  try {
    const bounded = await readHandleBounded(handle, maxBytes);
    if (!bounded) return undefined;
    const parsed: unknown = JSON.parse(bounded.text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function safeDirectory(root: string, path: string): Promise<boolean> {
  if (!grokPathContained(root, path)) return false;
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function pathAbsent(root: string, path: string): Promise<boolean> {
  if (!grokPathContained(root, path)) return false;
  try {
    const absoluteRoot = resolve(root);
    const absolutePath = resolve(path);
    const segments = relative(absoluteRoot, absolutePath).split(sep).filter(Boolean);
    const rootBefore = await realpath(absoluteRoot);
    const ancestors: Array<{ path: string; dev: bigint; ino: bigint }> = [];
    let parent = absoluteRoot;
    for (const segment of segments.slice(0, -1)) {
      parent = join(parent, segment);
      const info = await lstat(parent, { bigint: true });
      if (info.isSymbolicLink() || !info.isDirectory()) return false;
      ancestors.push({ path: parent, dev: info.dev, ino: info.ino });
    }
    const leafAbsent = async (): Promise<boolean> => {
      try {
        await lstat(absolutePath);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT';
      }
    };
    if (!await leafAbsent()) return false;
    for (const ancestor of ancestors) {
      const info = await lstat(ancestor.path, { bigint: true });
      if (info.isSymbolicLink()
        || !info.isDirectory()
        || info.dev !== ancestor.dev
        || info.ino !== ancestor.ino) return false;
    }
    return await leafAbsent() && await realpath(absoluteRoot) === rootBefore;
  } catch (error) {
    return false;
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

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

export function grokModelSelection(
  value: unknown,
  reasoningEffort?: unknown,
): { providerID: string; modelID: string; reasoningEffort?: string } | undefined {
  const model = boundedString(value, MAX_MODEL_CHARS, true);
  if (!model) return undefined;
  const slash = model.indexOf('/');
  const selection = slash > 0 && slash < model.length - 1
    ? { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
    : { providerID: 'xai', modelID: model };
  const effort = boundedString(reasoningEffort, 128, true);
  return { ...selection, ...(effort ? { reasoningEffort: effort } : {}) };
}

function decodedCwdGroup(name: string): string | undefined {
  try {
    const decoded = decodeURIComponent(name);
    return isAbsolute(decoded) && decoded.length <= MAX_CWD_CHARS ? resolve(decoded) : undefined;
  } catch {
    return undefined;
  }
}

async function directoryRows(
  root: string,
  path: string,
  budget: DiscoveryBudget,
): Promise<Array<{ name: string; mtimeMs: number }>> {
  if (!await safeDirectory(root, path)) return [];
  const rows: Array<{ name: string; mtimeMs: number }> = [];
  try {
    for await (const entry of await opendir(path)) {
      if (!spend(budget)) break;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const info = await lstat(join(path, entry.name)).catch(() => undefined);
      if (info?.isDirectory() && !info.isSymbolicLink()) rows.push({ name: entry.name, mtimeMs: info.mtimeMs });
    }
  } catch {
    return [];
  }
  return rows.sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
}

async function collectSubagentLineage(
  root: string,
  parents: readonly GrokSessionCandidate[],
  budget: DiscoveryBudget,
  trace?: (event: GrokStoreTrace) => void,
): Promise<{
  claimsByChild: Map<string, GrokLineageClaim[]>;
  refusedChildIds: Set<string>;
}> {
  const claimsByChild = new Map<string, GrokLineageClaim[]>();
  const refusedChildIds = new Set<string>();
  for (const parent of parents) {
    const parentId = basename(parent.sessionDir);
    if (!UUID_V7.test(parentId)) continue;
    const subagentsPath = join(parent.sessionDir, 'subagents');
    if (!await safeDirectory(root, subagentsPath)) continue;
    try {
      for await (const entry of await opendir(subagentsPath)) {
        if (!spend(budget)) break;
        const childId = entry.name;
        if (!UUID_V7.test(childId)) continue;
        const childDir = join(subagentsPath, childId);
        const childInfo = await lstat(childDir).catch(() => undefined);
        if (!entry.isDirectory()
          || entry.isSymbolicLink()
          || !childInfo?.isDirectory()
          || childInfo.isSymbolicLink()) {
          refusedChildIds.add(childId);
          trace?.({ op: 'path-refused', path: childDir, detail: 'subagent lineage directory is not one no-follow directory' });
          continue;
        }
        const metaPath = join(childDir, 'meta.json');
        const meta = await readBoundedJson(root, metaPath, GROK_MAX_SUBAGENT_META_BYTES);
        const childSessionId = boundedString(meta?.child_session_id, 512, true);
        const subagentId = boundedString(meta?.subagent_id, 512, true);
        const claimedParentId = boundedString(meta?.parent_session_id, 512, true);
        const childCwdRaw = boundedString(meta?.child_cwd, MAX_CWD_CHARS);
        const childCwd = childCwdRaw && isAbsolute(childCwdRaw) ? resolve(childCwdRaw) : undefined;
        if (!meta
          || childSessionId !== childId
          || subagentId !== childId
          || claimedParentId !== parentId
          || childId === parentId
          || childCwd !== parent.groupCwd) {
          refusedChildIds.add(childId);
          trace?.({ op: 'schema-refused', path: metaPath, detail: 'subagent meta child/parent/cwd identity mismatch' });
          continue;
        }
        const claim: GrokLineageClaim = { childId, parentId, childCwd, metaPath };
        const claims = claimsByChild.get(childId) ?? [];
        claims.push(claim);
        claimsByChild.set(childId, claims);
      }
    } catch {
      trace?.({ op: 'path-refused', path: subagentsPath, detail: 'subagent lineage directory could not be enumerated safely' });
    }
    if (budget.exceeded) break;
  }
  return { claimsByChild, refusedChildIds };
}

export async function discoverGrokStore(options: GrokDiscoveryOptions = {}): Promise<GrokStoredSession[]> {
  const root = resolve(options.root ?? grokStoreRoot());
  const sessionsRoot = join(root, 'sessions');
  const maxSessions = Math.max(1, Math.min(options.maxSessions ?? GROK_MAX_SESSIONS, GROK_MAX_SESSIONS));
  const maxScan = Math.max(1, Math.min(options.maxScanEntries ?? GROK_DISCOVERY_SCAN_ENTRIES, GROK_DISCOVERY_SCAN_ENTRIES));
  const budget: DiscoveryBudget = { remaining: maxScan, exceeded: false };
  const candidates: GrokSessionCandidate[] = [];
  const groups = (await directoryRows(root, sessionsRoot, budget)).slice(0, GROK_MAX_CWD_GROUPS);
  for (const group of groups) {
    const groupCwd = decodedCwdGroup(group.name);
    if (!groupCwd) {
      options.trace?.({ op: 'schema-refused', path: join(sessionsRoot, group.name), detail: 'cwd group is not one absolute URL-decoded path' });
      continue;
    }
    for (const session of await directoryRows(root, join(sessionsRoot, group.name), budget)) {
      candidates.push({ sessionDir: join(sessionsRoot, group.name, session.name), groupCwd, mtimeMs: session.mtimeMs });
    }
  }
  if (budget.exceeded) {
    options.trace?.({ op: 'discovery-bound', detail: `store enumeration exceeded ${maxScan} entries; refusing partial discovery` });
    return [];
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || right.sessionDir.localeCompare(left.sessionDir));
  const lineage = await collectSubagentLineage(root, candidates, budget, options.trace);
  if (budget.exceeded) {
    options.trace?.({ op: 'discovery-bound', detail: `subagent lineage enumeration exceeded ${maxScan} entries; refusing partial discovery` });
    return [];
  }
  const idCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const id = basename(candidate.sessionDir);
    if (UUID_V7.test(id)) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }
  const tracedAmbiguousIds = new Set<string>();
  // Every candidate's `summary.json`, fetched in bounded batches BEFORE the loop
  // below reads them. The loop itself is untouched and still sequential, so the
  // order of `parsed` and of every trace event is exactly what it was.
  //
  // Why: the scan costs ~172ms and almost none of it is work. Measured on a
  // 120-row store -- enumerate + stat all 133 session dirs is 0ms, the whole
  // subagent-lineage walk is 1ms (only 2 of 133 parents even have a `subagents`
  // directory), and all 120 `summary.json` together are 0.11MB with a median of
  // 892 bytes. What remains is ~400 SEQUENTIAL awaits, each a promise plus a
  // syscall, one per candidate. Batching the reads collapses that to a handful
  // of round trips.
  //
  // The one difference: a candidate the loop refuses on its id (non-UUIDv7, or
  // ambiguous across cwd groups) now has its summary read and discarded. Those
  // are refusal paths, and a read whose result is dropped changes no output.
  const summaries = new Map<string, unknown>();
  const summaryReadBatch = 16;
  for (let index = 0; index < candidates.length; index += summaryReadBatch) {
    const batch = candidates.slice(index, index + summaryReadBatch);
    const values = await Promise.all(batch.map(
      (candidate) => readBoundedJson(root, join(candidate.sessionDir, 'summary.json'), GROK_MAX_SUMMARY_BYTES),
    ));
    batch.forEach((candidate, offset) => summaries.set(candidate.sessionDir, values[offset]));
  }
  const parsed: GrokParsedCandidate[] = [];
  for (const candidate of candidates) {
    const id = basename(candidate.sessionDir);
    if (!UUID_V7.test(id)) {
      options.trace?.({ op: 'schema-refused', path: candidate.sessionDir, detail: 'session directory is not a canonical lowercase UUIDv7 native id' });
      continue;
    }
    if ((idCounts.get(id) ?? 0) > 1) {
      if (!tracedAmbiguousIds.has(id)) {
        tracedAmbiguousIds.add(id);
        options.trace?.({
          op: 'schema-refused',
          path: candidate.sessionDir,
          detail: `native session id ${id} appears under more than one cwd group`,
        });
      }
      continue;
    }
    const summaryPath = join(candidate.sessionDir, 'summary.json');
    const summary = summaries.get(candidate.sessionDir) as
      Awaited<ReturnType<typeof readBoundedJson>>;
    const info = summary && isRecord(summary.info) ? summary.info : undefined;
    const cwd = boundedString(info?.cwd, MAX_CWD_CHARS);
    if (!summary || info?.id !== id || !cwd || !isAbsolute(cwd) || resolve(cwd) !== candidate.groupCwd) {
      options.trace?.({ op: 'schema-refused', path: summaryPath, detail: 'summary id/cwd does not match its native directory identity' });
      continue;
    }
    const updatedAt = parseTimestamp(summary.last_active_at ?? summary.updated_at);
    const rawSessionKind = summary.session_kind;
    if (rawSessionKind !== undefined
      && rawSessionKind !== null
      && rawSessionKind !== 'headless'
      && rawSessionKind !== 'subagent') {
      options.trace?.({ op: 'schema-refused', path: summaryPath, detail: 'summary has an unsupported session_kind' });
      continue;
    }
    const sessionKind = rawSessionKind === 'subagent' ? 'subagent' as const : undefined;
    const model = boundedString(summary.current_model_id, MAX_MODEL_CHARS, true);
    const currentModel = grokModelSelection(model, summary.reasoning_effort);
    const title = boundedString(summary.session_summary, MAX_TITLE_CHARS, true)
      ?? boundedString(summary.generated_title, MAX_TITLE_CHARS, true)
      ?? id;
    const createdAt = parseTimestamp(summary.created_at);
    const messageCount = parseCount(summary.num_messages);
    parsed.push({ session: {
      id,
      title,
      cwd: resolve(cwd),
      ...(model ? { model } : {}),
      ...(currentModel ? { currentModel } : {}),
      ...(boundedString(summary.agent_name, 512, true) ? { currentAgent: boundedString(summary.agent_name, 512, true) } : {}),
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(updatedAt === undefined ? {} : { updatedAt }),
      ...(messageCount === undefined ? {} : { messageCount }),
      status: 'idle',
      storeRoot: root,
      sessionDir: candidate.sessionDir,
      summaryPath,
      updatesPath: join(candidate.sessionDir, 'updates.jsonl'),
      signalsPath: join(candidate.sessionDir, 'signals.json'),
    }, ...(sessionKind ? { sessionKind } : {}) });
  }
  const parsedById = new Map(parsed.map((candidate) => [candidate.session.id, candidate]));
  const projected: GrokStoredSession[] = [];
  for (const candidate of parsed) {
    if (projected.length >= maxSessions) break;
    const { session, sessionKind } = candidate;
    if (options.updatedAfter !== undefined
      && session.updatedAt !== undefined
      && session.updatedAt < options.updatedAfter) continue;
    const claims = lineage.claimsByChild.get(session.id) ?? [];
    const hasRefusedClaim = lineage.refusedChildIds.has(session.id);
    if (sessionKind !== 'subagent') {
      if (claims.length > 0 || hasRefusedClaim) {
        options.trace?.({
          op: 'schema-refused', path: session.summaryPath,
          detail: 'parent metadata claims a session whose summary is not session_kind=subagent',
        });
        continue;
      }
      projected.push(session);
      continue;
    }
    const claim = claims.length === 1 && !hasRefusedClaim ? claims[0] : undefined;
    const parent = claim ? parsedById.get(claim.parentId) : undefined;
    if (!claim
      || !parent
      || parent.sessionKind === 'subagent'
      || parent.session.cwd !== session.cwd
      || claim.childCwd !== session.cwd) {
      options.trace?.({
        op: 'schema-refused', path: session.summaryPath,
        detail: claims.length > 1
          ? 'subagent lineage is ambiguous across parent metadata'
          : 'subagent summary has no exact one-level parent lineage proof',
      });
      continue;
    }
    projected.push({ ...session, origin: 'subagent', parentThreadId: parent.session.id });
  }
  if (options.updatedAfter === undefined) {
    const publishedNativeIds = new Set(projected.map((session) => session.id));
    return projected.filter((session) => session.origin !== 'subagent'
      || publishedNativeIds.has(session.parentThreadId!));
  }
  return projected;
}

export async function readGrokSignals(session: GrokStoredSession): Promise<Record<string, unknown> | undefined> {
  return readBoundedJson(session.storeRoot, session.signalsPath, GROK_MAX_SIGNALS_BYTES);
}

export async function readGrokUpdates(
  session: GrokStoredSession,
  maxBytes = GROK_MAX_UPDATES_BYTES,
): Promise<GrokUpdatesRead> {
  const handle = await openRegularInside(session.storeRoot, session.updatesPath);
  if (!handle) {
    // Grok creates updates.jsonl lazily on the first prompt. A discovered,
    // never-prompted session therefore has a valid empty transcript, but an
    // existing path that cannot be opened is still unsafe and refused.
    if (await pathAbsent(session.storeRoot, session.updatesPath)) {
      return {
        entries: [], issues: [], byteLength: 0, durablePrefixBytes: Buffer.alloc(0),
        identity: { sourceId: `${session.updatesPath}:absent`, revision: 'absent', appendPosition: 0 },
      };
    }
    return { entries: [], issues: ['updates log is missing or refused by containment'], byteLength: 0, durablePrefixBytes: Buffer.alloc(0) };
  }
  const before = await handle.stat({ bigint: true });
  const bounded = await readHandleBounded(handle, maxBytes);
  const after = await handle.stat({ bigint: true }).finally(() => handle.close());
  if (!bounded) return { entries: [], issues: [`updates log exceeds ${maxBytes} bytes`], byteLength: maxBytes + 1, durablePrefixBytes: Buffer.alloc(0) };
  if (before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs
    || BigInt(bounded.byteLength) !== after.size) {
    return {
      entries: [],
      issues: ['updates log changed during the bounded snapshot read'],
      byteLength: bounded.byteLength,
      durablePrefixBytes: Buffer.alloc(0),
    };
  }
  const identity: HistorySourceIdentity = {
    sourceId: `${session.updatesPath}:${String(after.dev)}:${String(after.ino)}`,
    revision: `${String(after.size)}:${String(after.mtimeNs)}`,
    appendPosition: Number(after.size),
  };
  let durablePrefixLength = 0;
  let completeLineCount = 0;
  for (let index = 0; index < bounded.bytes.length; index += 1) {
    if (bounded.bytes[index] !== 0x0a) continue;
    completeLineCount += 1;
    durablePrefixLength = index + 1;
    if (completeLineCount > GROK_MAX_UPDATE_LINES) {
      return {
        entries: [],
        issues: [`updates log exceeds ${GROK_MAX_UPDATE_LINES} complete lines`],
        byteLength: bounded.byteLength,
        durablePrefixBytes: Buffer.alloc(0),
      };
    }
  }
  const entries: GrokUpdateEntry[] = [];
  const issues: string[] = [];
  let offset = 0;
  for (let lineIndex = 0; lineIndex < completeLineCount; lineIndex += 1) {
    const newline = bounded.bytes.indexOf(0x0a, offset);
    if (newline < 0 || newline >= durablePrefixLength) break;
    const length = newline + 1 - offset;
    const line = bounded.bytes.toString('utf8', offset, newline);
    if (!line.trim()) {
      offset += length;
      continue;
    }
    if (length > GROK_MAX_UPDATE_LINE_BYTES) {
      issues.push(`update line ${lineIndex} exceeds ${GROK_MAX_UPDATE_LINE_BYTES} bytes`);
      entries.push({ record: { __grokMalformed: true, reason: 'oversized-line' }, lineIndex, offset, length });
      offset += length;
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      entries.push({
        record: isRecord(parsed) ? parsed as GrokUpdateRecord : { __grokMalformed: true, nativeType: typeof parsed },
        lineIndex,
        offset,
        length,
      });
      if (!isRecord(parsed)) issues.push(`update line ${lineIndex} is not an object`);
    } catch {
      issues.push(`update line ${lineIndex} is malformed JSON`);
      entries.push({ record: { __grokMalformed: true }, lineIndex, offset, length });
    }
    offset += length;
  }
  return {
    entries,
    issues,
    byteLength: bounded.byteLength,
    durablePrefixBytes: bounded.bytes.subarray(0, durablePrefixLength),
    identity,
  };
}

/**
 * Three-valued on purpose. A boundary means the transcript is there and this is
 * its identity; the synthetic `:absent` boundary means it is provably gone; and
 * `undefined` means THIS READ COULD NOT TELL -- an EMFILE under the broker's own
 * fd pressure, an EACCES, a racing rename. Callers must not collapse the third
 * into the second: revoking Drive eligibility nulls `appCreatedAt` on disk, and
 * `wasAppCreatedSession` gates re-eligibility on that field, so one unlucky
 * `open()` would cost an app-created session its Drive permanently, across
 * restarts, with delete-and-recreate the only recovery.
 */
export async function grokHistorySourceIdentity(
  session: GrokStoredSession,
): Promise<HistorySourceIdentity | undefined> {
  const handle = await openRegularInside(session.storeRoot, session.updatesPath);
  if (!handle) {
    if (!await pathAbsent(session.storeRoot, session.updatesPath)) return undefined;
    return {
      sourceId: `${session.updatesPath}:absent`,
      revision: 'absent',
      appendPosition: 0,
    };
  }
  const info = await handle.stat({ bigint: true }).finally(() => handle.close());
  return {
    sourceId: `${session.updatesPath}:${String(info.dev)}:${String(info.ino)}`,
    revision: `${String(info.size)}:${String(info.mtimeNs)}`,
    appendPosition: Number(info.size),
    // No measured append-stable lineage token exists. Timestamps are revisions,
    // not rewrite tokens; append-prefix validation in Observe detects rewrites.
  };
}
