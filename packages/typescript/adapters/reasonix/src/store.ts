/** Read-only Reasonix v1.25.2 store discovery and bounded transcript reads. */
import { constants } from 'node:fs';
import {
  lstat,
  open,
  opendir,
  realpath,
  type FileHandle,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import type { HistorySourceIdentity } from '@cosyncing/adapter-api';
import type {
  ReasonixDisplayEntry,
  ReasonixTranscriptRecord,
} from './mapping.ts';

export const REASONIX_META_SCHEMA = 2;
export const REASONIX_EVENT_INDEX_SCHEMA = 1;
export const REASONIX_DISPLAY_INDEX_SCHEMA = 1;
export const REASONIX_MAX_SESSIONS = 1_000;
export const REASONIX_MAX_PROJECTS = 256;
export const REASONIX_MAX_META_BYTES = 256 * 1024;
export const REASONIX_MAX_DISPLAY_INDEX_BYTES = 32 * 1024 * 1024;
export const REASONIX_MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
export const REASONIX_MAX_EVENT_LOG_BYTES = 32 * 1024 * 1024;
export const REASONIX_DISCOVERY_SCAN_ENTRIES = 20_000;
export const REASONIX_MAX_TITLE_CHARS = 4_096;
export const REASONIX_MAX_MODEL_CHARS = 512;
export const REASONIX_MAX_CWD_CHARS = 32_768;

export interface ReasonixStoreTrace {
  op: 'store-read' | 'schema-refused' | 'path-refused' | 'discovery-bound';
  path?: string;
  detail: string;
}

interface ReasonixMeta {
  id?: unknown;
  model?: unknown;
  preview?: unknown;
  turns?: unknown;
  schema_version?: unknown;
  revision?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  writer_id?: unknown;
  content_digest?: unknown;
  [key: string]: unknown;
}

interface ReasonixAcpMetadata {
  sessionId?: unknown;
  cwd?: unknown;
  model?: unknown;
  title?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  status?: unknown;
  toolApprovalMode?: unknown;
  [key: string]: unknown;
}

export const REASONIX_APPROVAL_MODES = ['ask', 'auto', 'yolo'] as const;
export type ReasonixApprovalMode = typeof REASONIX_APPROVAL_MODES[number];

export interface ReasonixSessionUsage {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  estimated?: boolean;
  events?: number;
  pricedEvents?: number;
  estimatedCost?: number;
  source?: string;
  costComplete?: boolean;
}

interface ReasonixEventIndex {
  schema_version?: unknown;
  log_size?: unknown;
  message_count?: unknown;
  revision?: unknown;
  writer_id?: unknown;
  content_digest?: unknown;
  [key: string]: unknown;
}

interface ReasonixTranscriptEvent {
  schema_version?: unknown;
  type?: unknown;
  revision?: unknown;
  base_revision?: unknown;
  message_index?: unknown;
  messages?: unknown;
  content_digest?: unknown;
  writer_id?: unknown;
  [key: string]: unknown;
}

interface ReasonixDisplayIndex {
  schema_version?: unknown;
  revision?: unknown;
  revision_known?: unknown;
  transcript_size?: unknown;
  message_count?: unknown;
  content_digest?: unknown;
  entries?: unknown;
  [key: string]: unknown;
}

export interface ReasonixStoredSession {
  id: string;
  title: string;
  cwd?: string;
  model?: string;
  currentModel?: { providerID: string; modelID: string };
  currentMode?: ReasonixApprovalMode;
  usage?: ReasonixSessionUsage;
  createdAt?: number;
  updatedAt?: number;
  status: 'working' | 'needs-input' | 'idle';
  /** True only when native ACP metadata explicitly reports a quiescent state. */
  driveEligible: boolean;
  layout: 'global' | 'project';
  storeRoot: string;
  transcriptPath: string;
  metaPath: string;
  acpMetadataPath: string;
  eventIndexPath: string;
  eventLogPath: string;
  displayIndexPath: string;
}

export interface ReasonixDiscoveryOptions {
  root?: string;
  updatedAfter?: number;
  maxSessions?: number;
  /** Lower test/host work ceiling; production never exceeds the hard cap. */
  maxScanEntries?: number;
  trace?: (event: ReasonixStoreTrace) => void;
  /**
   * Throw rather than answer `[]` when the store could not be ENUMERATED.
   *
   * For the roster, a swallowed enumeration failure costs a sweep and the next
   * one repairs it. For an ownership gate it is the opposite: "no session has
   * this id" is the answer that GRANTS exclusive ownership, so an EACCES or a
   * scan-budget overrun would read as proof that no competing session exists
   * and let a second owner be admitted over the first. Callers deciding
   * ownership must pass this; callers building a roster must not.
   */
  requireCompleteEnumeration?: boolean;
}

/** The store could not be enumerated, so its contents are unknown — never to be
 *  confused with an enumeration that found nothing. */
export class ReasonixStoreEnumerationError extends Error {
  constructor(detail: string) {
    super(`Reasonix store enumeration is incomplete: ${detail}`);
    this.name = 'ReasonixStoreEnumerationError';
  }
}

export interface ReasonixTranscriptRead {
  records: ReasonixTranscriptRecord[];
  displayEntries: ReasonixDisplayEntry[];
  issues: string[];
  byteLength: number;
  /** Exact complete-JSONL prefix used for append-vs-rewrite detection. */
  durablePrefixBytes: Buffer;
  eventRevision?: string | number;
  displayRevision?: string | number;
  /** A validated event append chain temporarily outranks stale flat/display sidecars. */
  eventJournalReconciled?: boolean;
  identity?: HistorySourceIdentity;
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

export function reasonixStoreRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
  userHome = homedir(),
): string {
  const configured = env.REASONIX_HOME?.trim();
  return resolve(configured || join(userHome, '.reasonix'));
}

export function reasonixPathContained(root: string, candidate: string): boolean {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  const rel = relative(absoluteRoot, absoluteCandidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function openRegularInside(root: string, path: string): Promise<FileHandle | undefined> {
  if (!reasonixPathContained(root, path)) return undefined;
  let handle: FileHandle | undefined;
  try {
    const absoluteRoot = resolve(root);
    const absolutePath = resolve(path);
    const rel = relative(absoluteRoot, absolutePath);
    const segments = rel.split(sep).filter(Boolean);
    const rootTargetBefore = await realpath(absoluteRoot);
    let parent = absoluteRoot;
    for (const segment of segments.slice(0, -1)) {
      parent = join(parent, segment);
      const parentInfo = await lstat(parent);
      if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) return undefined;
    }
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('not a regular file');

    // Node does not expose openat(2), so validate the complete path again
    // after opening and require the pathname to resolve to the exact inode
    // held by the descriptor. This rejects intermediate symlinks and path
    // replacement races instead of trusting lexical containment alone.
    const rootTargetAfter = await realpath(absoluteRoot);
    if (rootTargetAfter !== rootTargetBefore) throw new Error('store root changed during open');
    parent = absoluteRoot;
    for (const segment of segments.slice(0, -1)) {
      parent = join(parent, segment);
      const parentInfo = await lstat(parent);
      if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) throw new Error('symlinked store component');
    }
    const [pathInfo, pathTarget] = await Promise.all([lstat(absolutePath), realpath(absolutePath)]);
    if (pathInfo.isSymbolicLink()
      || !pathInfo.isFile()
      || pathInfo.dev !== info.dev
      || pathInfo.ino !== info.ino
      || !reasonixPathContained(rootTargetAfter, pathTarget)) {
      throw new Error('opened file identity escaped the store root');
    }
    return handle;
  } catch {
    // The close below also covers a handle whose post-open stat failed.
  }
  await handle?.close().catch(() => undefined);
  return undefined;
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
    const hinted = byteLength === 0 ? Math.max(1, Math.min(initial.size + 1, remaining)) : remaining;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, hinted));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, byteLength);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    byteLength += bytesRead;
  }
  if (byteLength > maxBytes) return undefined;
  const bytes = Buffer.concat(chunks, byteLength);
  return { text: bytes.toString('utf8'), bytes, byteLength };
}

/**
 * `strict` separates "not a directory" from "could not tell".
 *
 * ENOENT is a real answer — the layout is not there — and stays `false` either
 * way. An EACCES or an EMFILE is not: it removes a whole layout from the
 * enumeration, and for an ownership caller that silently narrows the set it is
 * about to declare complete.
 */
async function directoryInside(root: string, path: string, strict = false): Promise<boolean> {
  if (!reasonixPathContained(root, path)) return false;
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (strict && code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw new ReasonixStoreEnumerationError(`${path}: ${code ?? 'unreadable'}`);
    }
    return false;
  }
}

interface DiscoveryWorkBudget {
  remaining: number;
  exceeded: boolean;
}

function spendDiscoveryEntry(budget: DiscoveryWorkBudget): boolean {
  if (budget.remaining <= 0) {
    budget.exceeded = true;
    return false;
  }
  budget.remaining -= 1;
  return true;
}

async function newestTranscriptMtime(
  root: string,
  directory: string,
  budget: DiscoveryWorkBudget,
): Promise<number> {
  if (!(await directoryInside(root, directory))) return Number.NEGATIVE_INFINITY;
  let newest = Number.NEGATIVE_INFINITY;
  try {
    for await (const entry of await opendir(directory)) {
      if (!spendDiscoveryEntry(budget)) break;
      if (!entry.isFile()
        || entry.isSymbolicLink()
        || !entry.name.endsWith('.jsonl')
        || entry.name.endsWith('.events.jsonl')) continue;
      const info = await lstat(join(directory, entry.name)).catch(() => undefined);
      if (info?.isFile() && !info.isSymbolicLink()) newest = Math.max(newest, info.mtimeMs);
    }
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
  return newest;
}

async function readBoundedJson(
  root: string,
  path: string,
  maxBytes = REASONIX_MAX_META_BYTES,
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

/** Parse Reasonix's nanosecond ISO timestamps without requiring nanosecond Date support. */
export function parseReasonixTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\.(\d{3})\d+(?=Z$)/, '.$1');
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The one place a Reasonix `currentModel` is built -- create, drive and
 * discovery all come through here.
 *
 * Identity ONLY, with no `label`. Reasonix publishes no human model name to
 * carry: its catalog is built from `doctor --json`, whose providers list bare
 * model id strings, so `listModels` can only set `label: modelID`. The installed
 * catalog measured on 2026-09-11 is exactly that -- `qwen3.8-flash-next`,
 * `deepseek-v4-pro`, `glm-5.2` -- ids in the label field, not names.
 *
 * Passing one on as a label is worse than sending none. The client refuses to
 * render an id as a human name, so the id-shaped ones would be dropped anyway
 * and the composer would still read `Model`; the ones that happen NOT to trip
 * that rule (`glm-5.2` is two segments, not three) would sail through and put a
 * raw id in the composer, which is the exact thing the client's policy exists to
 * prevent. A generic `Model` chip with the precise id in the tooltip is the
 * honest rendering of a harness that has no display name to give.
 *
 * `modelLabels` is declared unsupported for this adapter for the same reason.
 */
export function reasonixModelSelection(
  value: unknown,
): { providerID: string; modelID: string } | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const model = value.trim();
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) return { providerID: 'reasonix', modelID: model };
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

export function reasonixApprovalMode(value: unknown): ReasonixApprovalMode | undefined {
  return typeof value === 'string'
    && (REASONIX_APPROVAL_MODES as readonly string[]).includes(value)
    ? value as ReasonixApprovalMode
    : undefined;
}

function boundedUsageInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function boundedUsageNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function reasonixSessionUsage(value: unknown): ReasonixSessionUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: ReasonixSessionUsage = {
    ...(boundedUsageInteger(value.promptTokens) === undefined ? {} : { promptTokens: boundedUsageInteger(value.promptTokens) }),
    ...(boundedUsageInteger(value.completionTokens) === undefined ? {} : { completionTokens: boundedUsageInteger(value.completionTokens) }),
    ...(boundedUsageInteger(value.reasoningTokens) === undefined ? {} : { reasoningTokens: boundedUsageInteger(value.reasoningTokens) }),
    ...(boundedUsageInteger(value.cacheHitTokens) === undefined ? {} : { cacheHitTokens: boundedUsageInteger(value.cacheHitTokens) }),
    ...(boundedUsageInteger(value.cacheMissTokens) === undefined ? {} : { cacheMissTokens: boundedUsageInteger(value.cacheMissTokens) }),
    ...(typeof value.estimated === 'boolean' ? { estimated: value.estimated } : {}),
    ...(boundedUsageInteger(value.events) === undefined ? {} : { events: boundedUsageInteger(value.events) }),
    ...(boundedUsageInteger(value.pricedEvents) === undefined ? {} : { pricedEvents: boundedUsageInteger(value.pricedEvents) }),
    ...(boundedUsageNumber(value.estimatedCost) === undefined ? {} : { estimatedCost: boundedUsageNumber(value.estimatedCost) }),
    ...(typeof value.source === 'string' && value.source.length > 0 && value.source.length <= 128
      ? { source: value.source }
      : {}),
    ...(typeof value.costComplete === 'boolean' ? { costComplete: value.costComplete } : {}),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export function reasonixSessionUsageValue(usage: ReasonixSessionUsage | undefined): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  return {
    ...(usage.promptTokens === undefined ? {} : { input: usage.promptTokens }),
    ...(usage.completionTokens === undefined ? {} : { output: usage.completionTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoning: usage.reasoningTokens }),
    ...(usage.cacheHitTokens === undefined ? {} : { cacheReadSubset: usage.cacheHitTokens }),
    ...(usage.cacheMissTokens === undefined ? {} : { cacheMissSubset: usage.cacheMissTokens }),
    inputIncludesCacheSubsets: true,
    ...(usage.estimated === undefined ? {} : { estimated: usage.estimated }),
    ...(usage.events === undefined ? {} : { events: usage.events }),
    ...(usage.pricedEvents === undefined ? {} : { pricedEvents: usage.pricedEvents }),
    ...(usage.source === undefined ? {} : { source: usage.source }),
    ...(usage.costComplete === undefined ? {} : { costComplete: usage.costComplete }),
    ...(usage.costComplete === true && usage.estimatedCost !== undefined ? { cost: usage.estimatedCost } : {}),
  };
}

function statusFromAcp(value: unknown): {
  status: ReasonixStoredSession['status'];
  driveEligible: boolean;
} {
  if (!isRecord(value) || typeof value.state !== 'string') {
    return { status: 'idle', driveEligible: false };
  }
  const state = value.state.replaceAll('_', '-').toLowerCase();
  if (state === 'working' || state === 'running') return { status: 'working', driveEligible: false };
  if (state === 'needs-input' || state === 'blocked') return { status: 'needs-input', driveEligible: false };
  if (state === 'idle' || state === 'completed') return { status: 'idle', driveEligible: true };
  return { status: 'idle', driveEligible: false };
}

/** Fresh native posture for write eligibility and interrupted-tail inference. */
export async function readReasonixAcpPosture(
  session: Pick<ReasonixStoredSession, 'id' | 'storeRoot' | 'acpMetadataPath'>,
): Promise<{
  status: ReasonixStoredSession['status'];
  driveEligible: boolean;
  currentMode?: ReasonixApprovalMode;
  usage?: ReasonixSessionUsage;
} | undefined> {
  const acp = await readBoundedJson(session.storeRoot, session.acpMetadataPath);
  if (!acp || acp.sessionId !== session.id) return undefined;
  const posture = statusFromAcp(acp.status);
  const currentMode = reasonixApprovalMode(acp.toolApprovalMode);
  const usage = isRecord(acp.status) ? reasonixSessionUsage(acp.status.cumulative) : undefined;
  return {
    ...posture,
    ...(currentMode ? { currentMode } : {}),
    ...(usage ? { usage } : {}),
  };
}

async function boundedDirectoryNames(
  root: string,
  path: string,
  limit: number,
  budget: DiscoveryWorkBudget,
  strict = false,
): Promise<string[]> {
  if (!(await directoryInside(root, path, strict))) return [];
  try {
    const candidates: Array<{ name: string; freshness: number }> = [];
    for await (const entry of await opendir(path)) {
      if (!spendDiscoveryEntry(budget)) break;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const sessions = join(path, entry.name, 'sessions');
      const freshness = await newestTranscriptMtime(root, sessions, budget);
      candidates.push({ name: entry.name, freshness });
    }
    // A TRUNCATION is the same lie as an unreadable directory, told more
    // quietly. The list is sorted freshest-first and then cut, so what falls off
    // the tail is the oldest projects — and a reused session id belongs, by
    // construction, to an old session. A strict caller that took this array as
    // complete would grant exclusive ownership over a session it simply never
    // looked at.
    if (strict && candidates.length > limit) {
      throw new ReasonixStoreEnumerationError(
        `${path}: ${String(candidates.length)} project directories exceed the ${String(limit)} this scan enumerates`,
      );
    }
    return candidates
      .sort((left, right) => right.freshness - left.freshness || right.name.localeCompare(left.name))
      .slice(0, limit)
      .map((entry) => entry.name);
  } catch (error) {
    // A refusal raised INSIDE the try is already the answer; re-wrapping it here
    // would nest the same sentence twice and, on the non-strict path, swallow it.
    if (error instanceof ReasonixStoreEnumerationError) throw error;
    // `[]` here means "nothing to see" to every caller. For an ownership gate
    // that is the answer that GRANTS exclusivity, so a strict caller is told the
    // truth instead: this directory could not be read.
    if (strict) throw new ReasonixStoreEnumerationError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

async function sessionDirectories(
  root: string,
  budget: DiscoveryWorkBudget,
  strict = false,
): Promise<Array<{ path: string; layout: ReasonixStoredSession['layout'] }>> {
  const out: Array<{ path: string; layout: ReasonixStoredSession['layout'] }> = [];
  const global = join(root, 'sessions');
  if (await directoryInside(root, global, strict)) out.push({ path: global, layout: 'global' });
  const projectsRoot = join(root, 'projects');
  for (const name of await boundedDirectoryNames(root, projectsRoot, REASONIX_MAX_PROJECTS, budget, strict)) {
    const sessions = join(projectsRoot, name, 'sessions');
    if (await directoryInside(root, sessions, strict)) out.push({ path: sessions, layout: 'project' });
  }
  return out;
}

async function transcriptNames(
  root: string,
  directory: string,
  limit: number,
  budget: DiscoveryWorkBudget,
  strict = false,
): Promise<Array<{ name: string; mtimeMs: number }>> {
  if (!(await directoryInside(root, directory, strict))) return [];
  try {
    const candidates: Array<{ name: string; mtimeMs: number }> = [];
    for await (const entry of await opendir(directory)) {
      if (!spendDiscoveryEntry(budget)) break;
      if (!entry.isFile()
        || entry.isSymbolicLink()
        || !entry.name.endsWith('.jsonl')
        || entry.name.endsWith('.events.jsonl')) continue;
      const info = await lstat(join(directory, entry.name)).catch(() => undefined);
      if (!info?.isFile() || info.isSymbolicLink()) continue;
      candidates.push({ name: entry.name, mtimeMs: info.mtimeMs });
    }
    if (strict && candidates.length > limit) {
      throw new ReasonixStoreEnumerationError(
        `${directory}: ${String(candidates.length)} transcripts exceed the ${String(limit)} this scan enumerates`,
      );
    }
    return candidates
      .sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name))
      .slice(0, limit);
  } catch (error) {
    if (error instanceof ReasonixStoreEnumerationError) throw error;
    if (strict) throw new ReasonixStoreEnumerationError(`${directory}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

export async function discoverReasonixStore(
  options: ReasonixDiscoveryOptions = {},
): Promise<ReasonixStoredSession[]> {
  const root = resolve(options.root ?? reasonixStoreRoot());
  const maxSessions = Math.max(1, Math.min(options.maxSessions ?? REASONIX_MAX_SESSIONS, REASONIX_MAX_SESSIONS));
  const sessions: ReasonixStoredSession[] = [];
  const scanLimit = Math.max(
    1,
    Math.min(options.maxScanEntries ?? REASONIX_DISCOVERY_SCAN_ENTRIES, REASONIX_DISCOVERY_SCAN_ENTRIES),
  );
  const discoveryBudget: DiscoveryWorkBudget = {
    remaining: scanLimit,
    exceeded: false,
  };
  const strict = options.requireCompleteEnumeration === true;
  const candidateBudget = Math.min(REASONIX_MAX_SESSIONS * 4, maxSessions * 4);
  const candidates: Array<{
    name: string;
    path: string;
    layout: ReasonixStoredSession['layout'];
    freshness: number;
  }> = [];
  for (const directory of await sessionDirectories(root, discoveryBudget, strict)) {
    for (const transcript of await transcriptNames(root, directory.path, candidateBudget, discoveryBudget, strict)) {
      candidates.push({
        name: transcript.name,
        path: directory.path,
        layout: directory.layout,
        freshness: transcript.mtimeMs,
      });
    }
    candidates.sort((left, right) => right.freshness - left.freshness || right.name.localeCompare(left.name));
    if (candidates.length > candidateBudget) {
      // Dropping the tail is fine for a roster and wrong for an ownership
      // caller: the id it is about to claim as unused could be in the part that
      // was cut. The scan-budget overrun below already refuses for this reason.
      if (strict) {
        throw new ReasonixStoreEnumerationError(
          `more than ${candidateBudget} transcript candidates; the tail was not examined`,
        );
      }
      candidates.length = candidateBudget;
    }
  }
  if (discoveryBudget.exceeded) {
    options.trace?.({
      op: 'discovery-bound',
      detail: `store enumeration exceeded ${scanLimit} entries; refusing partial discovery`,
    });
    if (options.requireCompleteEnumeration) {
      throw new ReasonixStoreEnumerationError(`scan exceeded ${scanLimit} entries`);
    }
    return [];
  }
  if (candidates.length === candidateBudget) {
    options.trace?.({ op: 'discovery-bound', detail: `examining the newest ${candidateBudget} transcript candidates` });
  }
  for (const candidate of candidates) {
      const id = basename(candidate.name, '.jsonl');
      const transcriptPath = join(candidate.path, candidate.name);
      const metaPath = `${transcriptPath}.meta`;
      const acpMetadataPath = join(candidate.path, `${id}.acp.json`);
      // Read as a PAIR. These are two independent files and the cutoff below
      // needs both, so reading them one after the other only buys a second trip
      // through an event loop that five other discovery legs are also queued on
      // -- which is where this leg's time goes (waiting, not CPU). The checks
      // that follow stay in their original order, so which candidate is refused,
      // and which trace is emitted, is unchanged. The only difference is that a
      // candidate with unreadable `.meta` now also had its `.acp.json` read; that
      // is a corrupt-store path, not a hot one.
      const [meta, acp] = await Promise.all([
        readBoundedJson(root, metaPath) as Promise<ReasonixMeta | undefined>,
        readBoundedJson(root, acpMetadataPath) as Promise<ReasonixAcpMetadata | undefined>,
      ]);
      if (!meta) {
        options.trace?.({ op: 'store-read', path: metaPath, detail: 'missing or unreadable transcript metadata' });
        continue;
      }
      if (meta.schema_version !== REASONIX_META_SCHEMA) {
        options.trace?.({
          op: 'schema-refused',
          path: metaPath,
          detail: `meta schema ${String(meta.schema_version)} != pinned ${REASONIX_META_SCHEMA}`,
        });
        continue;
      }
      if (meta.id !== id) {
        options.trace?.({ op: 'store-read', path: metaPath, detail: `metadata id ${String(meta.id)} != file id ${id}` });
        continue;
      }
      if (acp?.sessionId !== undefined && acp.sessionId !== id) {
        options.trace?.({ op: 'store-read', path: acpMetadataPath, detail: `ACP metadata id ${String(acp.sessionId)} != file id ${id}` });
        continue;
      }
      const posture = statusFromAcp(acp?.status);
      const status = posture.status;
      const createdAt = parseReasonixTimestamp(acp?.createdAt ?? meta.created_at);
      const updatedAt = parseReasonixTimestamp(acp?.updatedAt ?? meta.updated_at);
      // The window cutoff, applied HERE rather than after the event and display
      // indexes are read. It needs only `updatedAt` and `status`, and both come
      // from the two files already read, so a candidate outside the window is
      // now rejected two reads earlier. The test itself is unchanged, so the set
      // of sessions returned is identical.
      //
      // Why it matters: discovery read FOUR JSON files per candidate before
      // deciding whether the candidate was even in the window. Measured on the
      // broker's own per-leg log, `window=1d`: `reasonix=2730ms/32r` against
      // `claude=123ms/94r` in the same sweep -- three times the rows in a
      // twentieth of the time. Claude tests the cutoff against an `mtimeMs` it
      // already has and skips before reading anything; reasonix could not,
      // because it learned the timestamp by reading. Sweep CPU over that window
      // was 1.27s of 2.76s wall, so the leg is WAITING, and what it waits on is
      // its own read count queued behind five other legs sharing the loop.
      if (options.updatedAfter !== undefined
        && updatedAt !== undefined
        && updatedAt < options.updatedAfter
        && status === 'idle') continue;
      const eventIndexPath = join(candidate.path, `${id}.event-index.json`);
      const eventLogPath = join(candidate.path, `${id}.events.jsonl`);
      const displayIndexPath = join(candidate.path, `${id}.display-index.json`);
      // Also a pair, for the same reason. A candidate that survives the cutoff
      // needs both indexes, and reading them in sequence costs a second queued
      // trip per surviving candidate -- which is the whole cost at `window=7d`,
      // where nearly every candidate IS in the window and so nothing is skipped.
      // The refusals below keep their order, so an event-index schema mismatch
      // still refuses the candidate and still traces first; it merely no longer
      // saves the display read, which only happens on a refused candidate.
      const [event, display] = await Promise.all([
        readBoundedJson(root, eventIndexPath) as Promise<ReasonixEventIndex | undefined>,
        readBoundedJson(
          root,
          displayIndexPath,
          REASONIX_MAX_DISPLAY_INDEX_BYTES,
        ) as Promise<ReasonixDisplayIndex | undefined>,
      ]);
      if (event && event.schema_version !== REASONIX_EVENT_INDEX_SCHEMA) {
        options.trace?.({
          op: 'schema-refused',
          path: eventIndexPath,
          detail: `event index schema ${String(event.schema_version)} != pinned ${REASONIX_EVENT_INDEX_SCHEMA}`,
        });
        continue;
      }
      if (display && display.schema_version !== REASONIX_DISPLAY_INDEX_SCHEMA) {
        options.trace?.({
          op: 'schema-refused',
          path: displayIndexPath,
          detail: `display index schema ${String(display.schema_version)} != pinned ${REASONIX_DISPLAY_INDEX_SCHEMA}`,
        });
        continue;
      }
      const model = boundedString(acp?.model, REASONIX_MAX_MODEL_CHARS)
        ?? boundedString(meta.model, REASONIX_MAX_MODEL_CHARS);
      const title = boundedString(acp?.title, REASONIX_MAX_TITLE_CHARS, true)
        ?? boundedString(meta.preview, REASONIX_MAX_TITLE_CHARS, true)
        ?? id;
      const cwd = boundedString(acp?.cwd, REASONIX_MAX_CWD_CHARS);
      const driveEligible = acp?.sessionId === id && posture.driveEligible;
      const currentModel = reasonixModelSelection(model);
      const currentMode = reasonixApprovalMode(acp?.toolApprovalMode);
      const usage = isRecord(acp?.status) ? reasonixSessionUsage(acp.status.cumulative) : undefined;
      sessions.push({
        id,
        title,
        ...(cwd ? { cwd } : {}),
        ...(model ? { model } : {}),
        ...(currentModel ? { currentModel } : {}),
        ...(currentMode ? { currentMode } : {}),
        ...(usage ? { usage } : {}),
        ...(createdAt === undefined ? {} : { createdAt }),
        ...(updatedAt === undefined ? {} : { updatedAt }),
        status,
        driveEligible,
        layout: candidate.layout,
        storeRoot: root,
        transcriptPath,
        metaPath,
        acpMetadataPath,
        eventIndexPath,
        eventLogPath,
        displayIndexPath,
      });
  }
  const idCounts = new Map<string, number>();
  for (const session of sessions) idCounts.set(session.id, (idCounts.get(session.id) ?? 0) + 1);
  const uniqueSessions = sessions.filter((session) => {
    const unique = idCounts.get(session.id) === 1;
    if (!unique) options.trace?.({
      op: 'store-read',
      path: session.transcriptPath,
      detail: `duplicate native session id ${session.id} across Reasonix store layouts; refusing every ambiguous row`,
    });
    return unique;
  });
  // The last truncation on the path, and the same rule: a roster may show the
  // freshest `maxSessions`, an ownership caller may not be handed a cut list and
  // told it is everything.
  if (strict && uniqueSessions.length > maxSessions) {
    throw new ReasonixStoreEnumerationError(
      `${String(uniqueSessions.length)} sessions exceed the ${String(maxSessions)} this scan returns`,
    );
  }
  return uniqueSessions
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, maxSessions);
}

function displayEntry(value: unknown): ReasonixDisplayEntry | undefined {
  if (!isRecord(value)) return undefined;
  const index = value.index;
  const offset = value.offset;
  const length = value.length;
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length)) return undefined;
  if ((index as number) < 0 || (offset as number) < 0 || (length as number) < 0) return undefined;
  return {
    index: index as number,
    offset: offset as number,
    length: length as number,
    ...(typeof value.role === 'string' ? { role: value.role } : {}),
    ...(Number.isSafeInteger(value.authored_turn) ? { authoredTurn: value.authored_turn as number } : {}),
    ...(typeof value.starts_turn === 'boolean' ? { startsTurn: value.starts_turn } : {}),
  };
}

function exactRevision(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function exactDigest(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}

interface ReasonixEventReconciliation {
  records: ReasonixTranscriptRecord[];
  displayEntries: ReasonixDisplayEntry[];
  bytes: Buffer;
  revision: number;
}

function completeReconciledDisplayEntries(
  records: readonly ReasonixTranscriptRecord[],
  entries: readonly ReasonixDisplayEntry[],
): ReasonixDisplayEntry[] {
  let authoredTurn = 0;
  let sawUser = false;
  return entries.map((entry, index) => {
    const role = typeof records[index]?.role === 'string' ? records[index]!.role : entry.role;
    if (entry.authoredTurn !== undefined) {
      authoredTurn = entry.authoredTurn;
      if (role === 'user') sawUser = true;
    } else if (role === 'user') {
      if (sawUser) authoredTurn += 1;
      sawUser = true;
    }
    return {
      ...entry,
      authoredTurn: entry.authoredTurn ?? authoredTurn,
      ...(role === 'user' && entry.startsTurn === undefined ? { startsTurn: true } : {}),
    };
  });
}

async function reconcileReasonixEventJournal(
  session: ReasonixStoredSession,
  rawEvent: ReasonixEventIndex,
  flatRecords: readonly ReasonixTranscriptRecord[],
  flatDisplayEntries: readonly ReasonixDisplayEntry[],
  flatPrefixBytes: Buffer,
  displayRevision: number,
): Promise<ReasonixEventReconciliation | { issue: string } | undefined> {
  const targetRevision = exactRevision(rawEvent.revision);
  if (targetRevision === undefined || targetRevision <= displayRevision) return undefined;
  const targetLogSize = exactRevision(rawEvent.log_size);
  const targetMessageCount = exactRevision(rawEvent.message_count);
  const targetDigest = exactDigest(rawEvent.content_digest);
  const targetWriter = boundedString(rawEvent.writer_id, 4_096);
  if (targetLogSize === undefined || targetMessageCount === undefined
      || !targetDigest || !targetWriter || targetLogSize > REASONIX_MAX_EVENT_LOG_BYTES) {
    return { issue: 'event journal index cannot authenticate the newer revision' };
  }
  const [meta, handle] = await Promise.all([
    readBoundedJson(session.storeRoot, session.metaPath),
    openRegularInside(session.storeRoot, session.eventLogPath),
  ]);
  if (!handle) return { issue: 'event journal is missing or refused by containment' };
  let bounded: Awaited<ReturnType<typeof readHandleBounded>>;
  try {
    bounded = await readHandleBounded(handle, REASONIX_MAX_EVENT_LOG_BYTES);
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (!bounded || bounded.byteLength !== targetLogSize || !bounded.text.endsWith('\n')) {
    return { issue: 'event journal does not match its exact indexed byte boundary' };
  }
  if (meta?.schema_version !== REASONIX_META_SCHEMA
      || exactRevision(meta.revision) !== targetRevision
      || exactDigest(meta.content_digest) !== targetDigest
      || boundedString(meta.writer_id, 4_096) !== targetWriter) {
    return { issue: 'event journal, event index, and session metadata do not agree' };
  }

  const events: ReasonixTranscriptEvent[] = [];
  for (const line of bounded.text.split('\n')) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { issue: 'event journal contains malformed JSONL' };
    }
    if (!isRecord(parsed)) return { issue: 'event journal contains a non-object event' };
    events.push(parsed as ReasonixTranscriptEvent);
  }
  if (events.length === 0) return { issue: 'event journal contains no reconstructable events' };

  let records: ReasonixTranscriptRecord[] = [];
  let revision: number | undefined;
  let finalDigest: string | undefined;
  let finalWriter: string | undefined;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const eventRevision = exactRevision(event.revision);
    const eventDigest = exactDigest(event.content_digest);
    const eventWriter = boundedString(event.writer_id, 4_096);
    if (event.schema_version !== REASONIX_EVENT_INDEX_SCHEMA
        || eventRevision === undefined || !eventDigest || !eventWriter
        || !Array.isArray(event.messages)
        || !event.messages.every(isRecord)) {
      return { issue: 'event journal contains an unsupported event envelope' };
    }
    const messages = event.messages as ReasonixTranscriptRecord[];
    if (event.type === 'replace') {
      if (index !== 0 || event.base_revision !== undefined || event.message_index !== undefined) {
        return { issue: 'event journal replace event is not the unique chain root' };
      }
      records = [...messages];
    } else if (event.type === 'append') {
      if (revision === undefined
          || exactRevision(event.base_revision) !== revision
          || eventRevision !== revision + 1
          || exactRevision(event.message_index) !== records.length) {
        return { issue: 'event journal append chain is not contiguous' };
      }
      records.push(...messages);
    } else {
      return { issue: 'event journal operation is not supported' };
    }
    revision = eventRevision;
    finalDigest = eventDigest;
    finalWriter = eventWriter;
  }
  if (revision !== targetRevision || records.length !== targetMessageCount
      || finalDigest !== targetDigest || finalWriter !== targetWriter) {
    return { issue: 'event journal tip does not match its authenticated index' };
  }
  if (flatRecords.length > records.length
      || flatDisplayEntries.length !== flatRecords.length
      || flatRecords.some((record, index) => JSON.stringify(record) !== JSON.stringify(records[index]))) {
    return { issue: 'event journal does not extend the exact flat transcript prefix' };
  }

  const chunks: Buffer[] = [flatPrefixBytes];
  const displayEntries = flatDisplayEntries.map((entry) => ({ ...entry }));
  let offset = flatPrefixBytes.length;
  let authoredTurn = displayEntries.reduce(
    (highest, entry) => Math.max(highest, entry.authoredTurn ?? 0),
    0,
  );
  for (let index = flatRecords.length; index < records.length; index += 1) {
    const record = records[index]!;
    const role = typeof record.role === 'string' ? record.role : undefined;
    if (role === 'user') authoredTurn += 1;
    const encoded = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    chunks.push(encoded);
    displayEntries.push({
      index,
      offset,
      length: encoded.length,
      ...(role ? { role } : {}),
      authoredTurn,
      ...(role === 'user' ? { startsTurn: true } : {}),
    });
    offset += encoded.length;
    if (offset > REASONIX_MAX_TRANSCRIPT_BYTES) {
      return { issue: 'event journal reconstruction exceeds the transcript byte limit' };
    }
  }
  return {
    records,
    // The event journal contains transcript rows but no display rows. Fill the
    // native turn fields across both the stale flat prefix and the synthesized
    // suffix so the later flat/display catch-up is enrichment, not a rewrite.
    displayEntries: completeReconciledDisplayEntries(records, displayEntries),
    bytes: Buffer.concat(chunks, offset),
    revision: targetRevision,
  };
}

export async function readReasonixTranscript(
  session: ReasonixStoredSession,
  maxBytes = REASONIX_MAX_TRANSCRIPT_BYTES,
): Promise<ReasonixTranscriptRead> {
  const issues: string[] = [];
  const handle = await openRegularInside(session.storeRoot, session.transcriptPath);
  if (!handle) {
    return {
      records: [],
      displayEntries: [],
      issues: ['transcript is missing or refused by containment'],
      byteLength: 0,
      durablePrefixBytes: Buffer.alloc(0),
    };
  }
  const file = await handle.stat({ bigint: true });
  const bounded = await readHandleBounded(handle, maxBytes).finally(() => handle.close());
  if (!bounded) {
    return {
      records: [],
      displayEntries: [],
      issues: [`transcript exceeds ${maxBytes} bytes`],
      byteLength: maxBytes + 1,
      durablePrefixBytes: Buffer.alloc(0),
    };
  }
  const rawEvent = await readBoundedJson(session.storeRoot, session.eventIndexPath) as ReasonixEventIndex | undefined;
  if (rawEvent && rawEvent.schema_version !== REASONIX_EVENT_INDEX_SCHEMA) {
    return {
      records: [],
      displayEntries: [],
      issues: [`event index schema ${String(rawEvent.schema_version)} is not supported; replay refused`],
      byteLength: bounded.byteLength,
      durablePrefixBytes: Buffer.alloc(0),
    };
  }
  const text = bounded.text;
  const segments = text.split('\n');
  // Reasonix appends JSONL records. A watcher can observe the write between
  // chunks, so an unterminated final segment is buffered by omission and read
  // again after its newline arrives; it is not a malformed durable row yet.
  if (!text.endsWith('\n')) segments.pop();
  const lastCompleteNewline = text.endsWith('\n') ? text.length : text.lastIndexOf('\n') + 1;
  const durablePrefixLength = Buffer.byteLength(text.slice(0, Math.max(0, lastCompleteNewline)), 'utf8');
  const durablePrefixBytes = bounded.bytes.subarray(0, durablePrefixLength);
  const recordLines: Array<{ line: string; offset: number; length: number }> = [];
  let lineOffset = 0;
  for (const line of segments) {
    const length = Buffer.byteLength(line, 'utf8');
    if (line.trim()) recordLines.push({ line, offset: lineOffset, length });
    lineOffset += length + 1;
  }
  let malformedRecord = false;
  const records = recordLines.map(({ line }, index) => {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) return parsed as ReasonixTranscriptRecord;
      malformedRecord = true;
      return { __reasonixMalformed: true, lineIndex: index, nativeType: typeof parsed };
    } catch {
      malformedRecord = true;
      return { __reasonixMalformed: true, lineIndex: index, preview: line.slice(0, 160) };
    }
  });
  if (malformedRecord) issues.push('one or more transcript records were malformed');

  const rawDisplay = await readBoundedJson(
    session.storeRoot,
    session.displayIndexPath,
    REASONIX_MAX_DISPLAY_INDEX_BYTES,
  ) as ReasonixDisplayIndex | undefined;
  let displayEntries: ReasonixDisplayEntry[] = [];
  if (!rawDisplay) {
    issues.push('display index is missing or unreadable; replay uses line-order keys');
  } else if (rawDisplay.schema_version !== REASONIX_DISPLAY_INDEX_SCHEMA) {
    return {
      records: [],
      displayEntries: [],
      issues: [`display index schema ${String(rawDisplay.schema_version)} is not supported; replay refused`],
      byteLength: bounded.byteLength,
      durablePrefixBytes,
    };
  } else if (!Array.isArray(rawDisplay.entries)) {
    issues.push('display index entries are not an array');
  } else {
    if (typeof rawDisplay.transcript_size === 'number'
      && (!Number.isSafeInteger(rawDisplay.transcript_size)
        || rawDisplay.transcript_size < 0
        || rawDisplay.transcript_size !== bounded.byteLength)) {
      issues.push('display index transcript_size does not match the transcript');
    }
    displayEntries = rawDisplay.entries.map(displayEntry).filter((entry): entry is ReasonixDisplayEntry => entry !== undefined);
    if (displayEntries.length !== rawDisplay.entries.length) issues.push('one or more display index entries were malformed');
    const exactBoundaries = displayEntries.length === records.length
      && displayEntries.every((entry, index) => {
        const boundary = recordLines[index];
        const record = records[index];
        return entry.index === index
          && boundary !== undefined
          && entry.offset === boundary.offset
          // Native v1.25.2 display entries cover the JSON bytes plus LF.
          && entry.length === boundary.length + 1
          && (entry.role === undefined || entry.role === record?.role);
      });
    if (!exactBoundaries) {
      issues.push('display index does not match exact transcript JSONL boundaries');
    }
  }
  const eventRevision = typeof rawEvent?.revision === 'number' || typeof rawEvent?.revision === 'string'
    ? rawEvent.revision
    : undefined;
  const displayRevision = typeof rawDisplay?.revision === 'number' || typeof rawDisplay?.revision === 'string'
    ? rawDisplay.revision
    : undefined;
  const flatRevision = rawDisplay?.revision_known === true
    && typeof rawDisplay.revision === 'number' && Number.isSafeInteger(rawDisplay.revision)
      ? String(rawDisplay.revision)
      : `${String(file.size)}:${String(file.mtimeNs)}`;
  const flatIdentity: HistorySourceIdentity = {
    sourceId: `${session.transcriptPath}:${String(file.dev)}:${String(file.ino)}`,
    revision: flatRevision,
    appendPosition: bounded.byteLength,
  };
  const numericDisplayRevision = exactRevision(rawDisplay?.revision);
  if (rawEvent && numericDisplayRevision !== undefined) {
    const reconciled = await reconcileReasonixEventJournal(
      session,
      rawEvent,
      records,
      displayEntries,
      durablePrefixBytes,
      numericDisplayRevision,
    );
    if (reconciled && 'issue' in reconciled) {
      issues.push(reconciled.issue);
    } else if (reconciled) {
      return {
        records: reconciled.records,
        displayEntries: reconciled.displayEntries,
        issues,
        byteLength: reconciled.bytes.length,
        durablePrefixBytes: reconciled.bytes,
        eventRevision: reconciled.revision,
        ...(displayRevision === undefined ? {} : { displayRevision }),
        eventJournalReconciled: true,
        identity: {
          ...flatIdentity,
          revision: String(reconciled.revision),
          appendPosition: reconciled.bytes.length,
        },
      };
    }
  }
  return {
    records,
    displayEntries,
    issues,
    byteLength: bounded.byteLength,
    durablePrefixBytes,
    ...(eventRevision === undefined ? {} : { eventRevision }),
    ...(displayRevision === undefined ? {} : { displayRevision }),
    identity: flatIdentity,
  };
}

export async function reasonixHistorySourceIdentity(
  session: ReasonixStoredSession,
): Promise<HistorySourceIdentity | undefined> {
  return (await readReasonixTranscript(session)).identity;
}
