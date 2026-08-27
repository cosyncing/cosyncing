/**
 * The agy store boundary: every read of Antigravity CLI state goes through here.
 *
 * Two properties this module exists to guarantee, both asserted by
 * `test/test-agy-store.ts`:
 *
 *  1. **Nothing is ever written.** The CLI holds `conversation_summaries.db` in
 *     WAL mode, so an ordinary read-only open is NOT enough — see
 *     {@link openAgyDatabaseReadOnly} for the measurement that settled which
 *     open mode actually keeps our hands off the user's store.
 *  2. **No path escapes the app-data root.** Session ids are conversation
 *     UUIDs, never paths, but a crafted id must still not be able to address a
 *     file outside the store. {@link containedAgyPath} is the cheap lexical
 *     pre-gate; the gate that actually holds — symlinks, FIFOs, unbounded sizes —
 *     is `safe-read.ts`, which every read below goes through.
 *
 * Everything here is parameterized by {@link AgyRoots} rather than reading
 * `homedir()` inline, so the suites run against a temp fixture tree and never
 * against the developer's live install.
 */
import { Database, constants as sqliteConstants } from 'bun:sqlite';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';
import type { ModeOption, ModelOption } from '@cosyncing/adapter-api';
import {
  AGY_METADATA_MAX_BYTES,
  AGY_SETTLEMENT_MAX_FILES,
  AGY_SMALL_JSON_MAX_BYTES,
  isAgyReadRefusal,
  listContainedDirectory,
  readContainedText,
} from './safe-read.ts';

/** The `app_data_dir` value that marks a row as belonging to the CLI, not the IDE.
 *
 *  Both products share `~/.gemini` and share this one summaries table: 27 rows
 *  are `antigravity-cli` and 5 are `antigravity` (the Windows IDE), measured
 *  2026-08-25. The IDE's per-conversation store is an opaque `.pb` container we
 *  deliberately do not support, so an IDE row reaching the roster would be a row
 *  that can never open. Filtering happens in SQL, at the boundary. */
export const AGY_CLI_APP_DATA_DIR = 'antigravity-cli';

/** Where the adapter reads from. Every field is injectable so tests never touch a real install. */
export interface AgyRoots {
  /** `~/.gemini/antigravity-cli` — conversations, brain dirs, cache, settings. */
  appData: string;
  /** `~/.antigravity_cockpit/cache` — the shared model catalog. */
  cockpitCache: string;
}

export function defaultAgyRoots(home: string = homedir()): AgyRoots {
  return {
    appData: join(home, '.gemini', AGY_CLI_APP_DATA_DIR),
    cockpitCache: join(home, '.antigravity_cockpit', 'cache'),
  };
}

/**
 * A degradation that named itself.
 *
 * Reflection §8: degrading is fine, degrading silently is not. Every fallback in
 * this package emits one of these rather than swallowing, and the adapter
 * forwards them to a sink the broker can log. `detail` is diagnostic text, never
 * user-facing copy.
 */
export interface AgyTrace {
  /** Stable operation id, e.g. 'model-catalog-join'. Greppable; never localized. */
  op: string;
  detail: string;
}

export type AgyTraceSink = (trace: AgyTrace) => void;

/** The default sink: a structured line on stderr, so a degradation is one grep away. */
export const defaultAgyTraceSink: AgyTraceSink = (trace) => {
  console.warn(`[agy] ${trace.op}: ${trace.detail}`);
};

// ── Paths and containment ────────────────────────────────────────────────────

/** `brain/<conversationId>` — the per-conversation working dir. */
export function agyBrainDir(roots: AgyRoots, conversationId: string): string {
  return containedAgyPath(roots, join(roots.appData, 'brain', conversationId));
}

/** The JSONL transcript. THE history wire for P0–P2 (see the head comment of implementation.ts). */
export function agyTranscriptPath(roots: AgyRoots, conversationId: string): string {
  return join(agyBrainDir(roots, conversationId), '.system_generated', 'logs', 'transcript.jsonl');
}

/** The untruncated variant. Present on fewer conversations than the truncated one — measured
 *  25 of 29 on 2026-08-25 — which is why a `truncated_fields` fallback must handle its absence. */
export function agyTranscriptFullPath(roots: AgyRoots, conversationId: string): string {
  return join(agyBrainDir(roots, conversationId), '.system_generated', 'logs', 'transcript_full.jsonl');
}

/** The background-task settlement inbox. */
export function agySettlementDir(roots: AgyRoots, conversationId: string): string {
  return join(agyBrainDir(roots, conversationId), '.system_generated', 'messages');
}

/**
 * A background task's captured output: `…/tasks/task-<N>.log`.
 *
 * MEASURED 2026-08-25 (agy 1.1.20, 33 logs on this host): plain text, CRLF line
 * endings, median 1,189 bytes — and a 3,099,335-byte maximum. That spread is the
 * whole reason for {@link AGY_TASK_LOG_MAX_BYTES}: the typical log is nothing,
 * and one of them alone is larger than the settlement cap.
 *
 * `taskId` is validated by the caller against {@link AGY_TASK_ID_SEGMENT} before
 * it reaches a path, so a sender id from disk cannot become a traversal.
 */
export function agyTaskLogPath(roots: AgyRoots, conversationId: string, taskId: string): string {
  return join(agyBrainDir(roots, conversationId), '.system_generated', 'tasks', `${taskId}.log`);
}

/** The ONLY shape a task id may take on its way into a path. */
export const AGY_TASK_ID_SEGMENT = /^task-\d{1,10}$/;

/** Per-log ceiling. Above the 1,189-byte median by three orders of magnitude, below the
 *  3 MB outlier, so the ordinary log is whole and the pathological one is stated-truncated. */
export const AGY_TASK_LOG_MAX_BYTES = 256 * 1024;

/** Total log bytes ONE history replay may read, across all of its settled tasks. */
export const AGY_TASK_LOG_BUDGET_BYTES = 2 * 1024 * 1024;

/**
 * Reject a path string that leaves the app-data root. A PRE-gate, not the gate.
 *
 * This is lexical: it resolves `..` and compares against the root with a
 * trailing separator, so `…/antigravity-cli-evil` cannot pass as a child of
 * `…/antigravity-cli`. Being lexical is what lets it run on a path that does not
 * exist yet — a conversation mid-creation has no brain dir — and it is also
 * exactly what it CANNOT do:
 *
 *   - it cannot see a symlink, at the final component or at any directory above
 *     it, because a symlink's own name is a perfectly ordinary string under the
 *     root while its target is anywhere at all;
 *   - it cannot tell a regular file from a FIFO or a device;
 *   - it says nothing about size.
 *
 * So real containment is decided later, on the OPENED DESCRIPTOR, in
 * `safe-read.ts` — which every actual read in this package goes through. Treat a
 * value returned from here as a candidate path, never as a proven-safe one.
 */
export function containedAgyPath(roots: AgyRoots, candidate: string): string {
  const root = resolve(roots.appData);
  const full = resolve(candidate);
  if (full !== root && !full.startsWith(root.endsWith(sep) ? root : root + sep)) {
    throw new Error(`agy: refusing a path outside the app-data root: ${candidate}`);
  }
  return full;
}

/** Is a conversation id shaped like one? Cheap pre-gate so a traversal id never reaches `join`. */
export function isAgyConversationId(value: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
}

// ── Availability ─────────────────────────────────────────────────────────────

/** First `agy` on PATH, or undefined. Pure PATH resolution — the binary is never executed:
 *  every wire fact this adapter needs came from files, and spawning costs a full workspace
 *  init (spec §1.1) that a roster sweep must never pay. */
export function findAgyBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = env.PATH ?? '';
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, 'agy');
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* not here; keep looking */
    }
  }
  return undefined;
}

// ── Time ─────────────────────────────────────────────────────────────────────

/**
 * Go's zero time, as both surfaces spell it.
 *
 * This constant exists because of a live trap: `Date.parse('0001-01-01
 * 00:00:00+00:00')` returns **978307200000** on V8 — 2001-01-01, a perfectly
 * plausible-looking date — rather than NaN or a year-1 epoch. MEASURED on bun
 * 2026-08-25. `last_user_input_time` is the zero time on every one of the 32
 * summary rows, so a roster that trusted `Date.parse` would date every session
 * to 2001 and sort the whole list wrong. The sentinel is matched textually,
 * before any parse.
 */
const GO_ZERO_TIME = /^0001-01-01[ T]00:00:00/;

/**
 * Parse an agy timestamp to epoch ms, or undefined.
 *
 * Three shapes are in play, all MEASURED 2026-08-25:
 *   `conversation_summaries.last_modified_time`   `2026-05-20 19:45:46.027884138+00:00`
 *   `conversation_metadata.json` `UpdatedAt`      `2026-05-21T19:47:53.542930701Z`
 *   transcript `created_at`                       `2026-08-15T10:10:23Z`
 *
 * The space separator and the nine fractional digits are both outside what the
 * spec's date grammar guarantees, so the string is normalized to a form the
 * parser is required to accept instead of relying on V8 leniency: `T` for the
 * separator, milliseconds for the fraction.
 */
export function parseAgyTimestamp(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  if (!text || GO_ZERO_TIME.test(text)) return undefined;
  const normalized = text
    .replace(' ', 'T')
    .replace(/(\.\d{3})\d+/, '$1');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : undefined;
}

// ── The summaries database ───────────────────────────────────────────────────

/**
 * Open a store database so that reading it CANNOT touch it.
 *
 * MEASURED on bun 2026-08-25, against a copy of the real WAL-mode
 * `conversation_summaries.db`:
 *
 * | open mode                                | sidecars created |
 * |------------------------------------------|------------------|
 * | `new Database(path, { readonly: true })`  | `-wal` AND `-shm` |
 * | `file:…?mode=ro` + `SQLITE_OPEN_READONLY` | `-wal` AND `-shm` |
 * | `file:…?immutable=1` + the same flag      | **none**          |
 *
 * So the obvious spelling is the wrong one: a plain read-only handle on a WAL
 * database still creates the shared-memory index and an empty write-ahead log
 * in the user's directory. Only `immutable=1` — which promises SQLite the file
 * will not change and thereby skips all locking and WAL machinery — leaves the
 * store byte-identical.
 *
 * The cost is stated rather than hidden: an immutable read IGNORES the `-wal`,
 * so if the CLI is mid-write its newest committed rows may not be visible and
 * the roster is briefly stale. That is the correct trade — a stale row corrects
 * itself on the next sweep, whereas a sidecar written into someone's live store
 * does not — and it is why the transcript, not this database, is the history
 * source.
 */
export function openAgyDatabaseReadOnly(path: string): Database {
  return new Database(
    `file:${encodeURI(path)}?immutable=1`,
    sqliteConstants.SQLITE_OPEN_READONLY | sqliteConstants.SQLITE_OPEN_URI,
  );
}

/** One `antigravity-cli` row of `conversation_summaries`, decoded. */
export interface AgySummaryRow {
  conversationId: string;
  /** Empty on all 32 rows measured — the CLI never populates it. See `preview`. */
  title: string;
  /** The populated human string: 30 of 32 rows carry one. This is what a title is built from. */
  preview: string;
  stepCount: number;
  updatedAt?: number;
  /** Decoded from the `workspace_uris` JSON array of `file://` URIs. Empty on 9 of 27 CLI rows. */
  workspaceDirs: string[];
  projectId: string;
  notFullyIdle: boolean;
  killed: boolean;
}

export interface AgySummaryQuery {
  /** {@link import('@cosyncing/adapter-api').SessionDiscoveryOptions.updatedAfter}. Applied in SQL. */
  updatedAfter?: number;
  /** Hard ceiling on rows decoded in one sweep. */
  limit?: number;
  /**
   * Look at ONLY these conversations. The post-limit enrichment fetch: a
   * conversation that won its roster slot through the brain scan still owns
   * whatever summary row the frozen table holds, however old, and recency-capped
   * queries cannot see it. Non-uuid entries are dropped before they reach SQL.
   */
  ids?: readonly string[];
  onWork?: (work: { kind: 'sqlite-query'; source: string; bounded: boolean; cutoff?: number }) => void;
  trace?: AgyTraceSink;
}

/**
 * Read the CLI roster.
 *
 * The `app_data_dir` filter is in the WHERE clause, not in a later `.filter()`:
 * an IDE row must never exist as a decoded object that a refactor could leak
 * onto the roster (spec R5).
 *
 * The cutoff is applied in SQL too, against the indexed `last_modified_time`.
 * It compares TEXT, because that column is a Go-formatted datetime string and
 * not an epoch — its lexical order and its chronological order agree for the
 * fixed-width UTC shape the CLI writes, which is what makes the index usable.
 */
export function readAgySummaries(roots: AgyRoots, query: AgySummaryQuery = {}): AgySummaryRow[] {
  const dbPath = join(roots.appData, 'conversation_summaries.db');
  if (!existsSync(dbPath)) {
    query.trace?.({ op: 'summaries-missing', detail: `no conversation_summaries.db at ${dbPath}` });
    return [];
  }
  const bounded = query.updatedAfter !== undefined || query.limit !== undefined;
  query.onWork?.({
    kind: 'sqlite-query',
    source: dbPath,
    bounded,
    ...(query.updatedAfter !== undefined ? { cutoff: query.updatedAfter } : {}),
  });

  let db: Database;
  try {
    db = openAgyDatabaseReadOnly(dbPath);
  } catch (error) {
    query.trace?.({ op: 'summaries-open-failed', detail: `${dbPath}: ${String(error)}` });
    return [];
  }
  try {
    const where = ['app_data_dir = ?'];
    const params: Array<string | number> = [AGY_CLI_APP_DATA_DIR];
    if (query.updatedAfter !== undefined) {
      where.push('last_modified_time >= ?');
      params.push(goTimeLiteral(query.updatedAfter));
    }
    if (query.ids !== undefined) {
      const ids = query.ids.filter((id) => isAgyConversationId(id));
      if (ids.length === 0) return [];
      where.push(`conversation_id in (${ids.map(() => '?').join(', ')})`);
      params.push(...ids);
    }
    const limit = query.limit !== undefined ? ` limit ${Math.max(0, Math.trunc(query.limit))}` : '';
    const sql =
      'select conversation_id, title, preview, step_count, last_modified_time, workspace_uris,'
      + ' project_id, not_fully_idle, killed from conversation_summaries where '
      + where.join(' and ')
      + ' order by last_modified_time desc'
      + limit;
    const rows = db.query(sql).all(...params) as Array<Record<string, unknown>>;
    const out: AgySummaryRow[] = [];
    for (const row of rows) {
      const conversationId = typeof row.conversation_id === 'string' ? row.conversation_id : '';
      // A summaries row whose id is not a UUID cannot address a brain dir, and every path
      // built from it would be a guess. Drop it loudly rather than build a broken row.
      if (!isAgyConversationId(conversationId)) {
        query.trace?.({ op: 'summary-id-unusable', detail: `not a conversation uuid: ${conversationId}` });
        continue;
      }
      out.push({
        conversationId,
        title: typeof row.title === 'string' ? row.title : '',
        preview: typeof row.preview === 'string' ? row.preview : '',
        stepCount: typeof row.step_count === 'number' ? row.step_count : 0,
        ...(parseAgyTimestamp(row.last_modified_time) !== undefined
          ? { updatedAt: parseAgyTimestamp(row.last_modified_time) }
          : {}),
        workspaceDirs: decodeWorkspaceUris(row.workspace_uris),
        projectId: typeof row.project_id === 'string' ? row.project_id : '',
        notFullyIdle: truthy(row.not_fully_idle),
        killed: truthy(row.killed),
      });
    }
    return out;
  } catch (error) {
    query.trace?.({ op: 'summaries-query-failed', detail: `${dbPath}: ${String(error)}` });
    return [];
  } finally {
    db.close();
  }
}

/** Render an epoch cutoff in the column's own textual format so the SQL comparison is apples to apples. */
function goTimeLiteral(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('T', ' ').replace('Z', '+00:00');
}

function truthy(value: unknown): boolean {
  return value === 1 || value === true || value === '1' || value === 'true';
}

/** `["file:///fixture/proj"]` → `['/fixture/proj']`. Percent-decoded; non-file URIs dropped. */
export function decodeWorkspaceUris(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const entry of parsed) {
    const dir = fileUriToPath(entry);
    if (dir) out.push(dir);
  }
  return out;
}

/** `file:///a/b` → `/a/b`. Returns undefined for anything that is not an absolute file URI. */
export function fileUriToPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('file://')) return undefined;
  try {
    const path = decodeURIComponent(new URL(value).pathname);
    return isAbsolute(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

// ── The metadata cache ───────────────────────────────────────────────────────

/** One `cache/conversation_metadata.json` entry, decoded. */
export interface AgyMetadataEntry {
  title: string;
  preview: string;
  numSteps: number;
  updatedAt?: number;
  workspaceDirs: string[];
  appDataDir: string;
  projectId: string;
  isInternal: boolean;
}

/**
 * The richer roster mirror. Enriches, never authorizes: the `app_data_dir`
 * decision is the database's (it is the surface the CLI writes transactionally),
 * and a conversation absent from this cache still discovers.
 *
 * MEASURED 2026-08-25: `Title` is empty on all 32 entries, `Preview` is present
 * on 30, and `WorkspaceURIs` is `null` on entries whose summary row does carry
 * one — so this file is a source for the human string and not for the cwd.
 */
export function readAgyMetadata(roots: AgyRoots, trace?: AgyTraceSink): Map<string, AgyMetadataEntry> {
  const path = join(roots.appData, 'cache', 'conversation_metadata.json');
  const out = new Map<string, AgyMetadataEntry>();
  const parsed = readJsonFile(roots.appData, path, AGY_METADATA_MAX_BYTES, trace, 'metadata-cache');
  const conversations = (parsed as { conversations?: unknown } | undefined)?.conversations;
  if (!conversations || typeof conversations !== 'object') return out;
  for (const [id, value] of Object.entries(conversations as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    const summary = (entry.summary ?? {}) as Record<string, unknown>;
    out.set(id, {
      title: typeof summary.Title === 'string' ? summary.Title : '',
      preview: typeof summary.Preview === 'string' ? summary.Preview : '',
      numSteps: typeof summary.NumSteps === 'number' ? summary.NumSteps : 0,
      ...(parseAgyTimestamp(summary.UpdatedAt) !== undefined
        ? { updatedAt: parseAgyTimestamp(summary.UpdatedAt) }
        : {}),
      workspaceDirs: Array.isArray(summary.WorkspaceURIs)
        ? summary.WorkspaceURIs.map(fileUriToPath).filter((p): p is string => !!p)
        : [],
      appDataDir: typeof summary.AppDataDir === 'string' ? summary.AppDataDir : '',
      projectId: typeof summary.ProjectID === 'string' ? summary.ProjectID : '',
      isInternal: entry.is_internal === true,
    });
  }
  return out;
}

// ── The model catalog ────────────────────────────────────────────────────────

export interface AgyModelEntry {
  id: string;
  /** The host's OWN display name. Never derived from the id — reflection §3. */
  displayName: string;
}

export interface AgyModelCatalog {
  byId: Map<string, AgyModelEntry>;
  /**
   * label → ids. A LIST, not a single id, because the catalog is genuinely
   * ambiguous: four distinct ids (`gemini-2.5-flash`,
   * `gemini-2.5-flash-thinking`, `gemini-2.5-flash-lite`,
   * `gemini-3.1-flash-lite`) all publish `displayName: "Gemini 3.1 Flash Lite"`
   * (MEASURED 2026-08-25). A reverse join that returned "the" id would be
   * picking one of four arbitrarily, so the ambiguity is preserved here and
   * resolved — by refusing — at the call site.
   */
  byLabel: Map<string, string[]>;
}

export function readAgyModelCatalog(roots: AgyRoots, trace?: AgyTraceSink): AgyModelCatalog {
  const path = join(roots.cockpitCache, 'available_models.json');
  const catalog: AgyModelCatalog = { byId: new Map(), byLabel: new Map() };
  const parsed = readJsonFile(roots.cockpitCache, path, AGY_SMALL_JSON_MAX_BYTES, trace, 'model-catalog');
  const models = (parsed as { models?: unknown } | undefined)?.models;
  if (!Array.isArray(models)) return catalog;
  for (const raw of models) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id : '';
    const displayName = typeof row.displayName === 'string' ? row.displayName : '';
    if (!id || !displayName) continue;
    catalog.byId.set(id, { id, displayName });
    const ids = catalog.byLabel.get(displayName);
    if (ids) ids.push(id);
    else catalog.byLabel.set(displayName, [id]);
  }
  return catalog;
}

/**
 * The label `settings.json` records for the globally-selected model.
 *
 * MEASURED 2026-08-25: `.model` is `"Gemini 3.7 Flash (High)"` — the LABEL, not
 * the id. That is the whole reason {@link resolveAgyModel} has to join backwards
 * through the catalog, and the reason a failed join publishes an explicit
 * `undefined` instead of putting a label the picker cannot match on the row.
 */
export function readAgySettingsModelLabel(roots: AgyRoots, trace?: AgyTraceSink): string | undefined {
  const parsed = readJsonFile(
    roots.appData,
    join(roots.appData, 'settings.json'),
    AGY_SMALL_JSON_MAX_BYTES,
    trace,
    'settings',
  );
  const model = (parsed as { model?: unknown } | undefined)?.model;
  return typeof model === 'string' && model.trim() ? model.trim() : undefined;
}

/**
 * Join the settings label back to a catalog id.
 *
 * Returns undefined — deliberately, with a trace — in all three failure cases:
 * no label recorded, no catalog entry for it, or an AMBIGUOUS label that names
 * more than one id. The last one matters: guessing among four ids would put a
 * wrong `modelID` on the row, and the picker would then preselect a model the
 * session is not on. Reflection §2's corollary is that clearing must be
 * explicit, so the caller publishes `currentModel: undefined` rather than
 * omitting the key.
 */
export function resolveAgyModel(
  catalog: AgyModelCatalog,
  label: string | undefined,
  trace?: AgyTraceSink,
): { providerID: string; modelID: string; label: string } | undefined {
  if (!label) {
    trace?.({ op: 'model-join', detail: 'settings.json records no model label' });
    return undefined;
  }
  const ids = catalog.byLabel.get(label);
  if (!ids || ids.length === 0) {
    trace?.({ op: 'model-join', detail: `label not in catalog: ${label}` });
    return undefined;
  }
  if (ids.length > 1) {
    trace?.({ op: 'model-join', detail: `label is ambiguous across ${ids.length} ids: ${label}` });
    return undefined;
  }
  const id = ids[0]!;
  // The label comes back out of the catalog entry, not out of `settings.json`:
  // the catalog is the publisher of record, and reading it back keeps this the
  // only place a display name can originate.
  return { providerID: AGY_PROVIDER_ID, modelID: id, label: catalog.byId.get(id)!.displayName };
}

/** Provider id for every agy model row. One product, one provider namespace. */
export const AGY_PROVIDER_ID = 'google-antigravity';

// ── Subagent lineage (P2d) ───────────────────────────────────────────────────

/** Settlement files ONE discovery sweep may open looking for lineage. The whole live store
 *  holds 36 of them (MEASURED 2026-08-25), so this is a wide margin, not a working limit. */
export const AGY_LINEAGE_MAX_FILES = 256;

/**
 * childConversationId → parentConversationId, for every link the files prove.
 *
 * ── WHAT NAMES A CHILD (MEASURED 2026-08-25, agy 1.1.20, C5 capture) ─────────
 * ONLY the settlement sender. A child conversation reports home by writing a
 * settlement into its PARENT's inbox whose `sender` is the child's own bare
 * conversation UUID — as opposed to a background task, whose sender is
 * `<parentId>/task-<N>`. Both parents on this host carry exactly one such
 * settlement, and both named ids are real `brain/` directories with real
 * transcripts. Two independent facts, agreeing.
 *
 * The parent's own `invoke_subagent` step does NOT name the child, which is worth
 * stating because the obvious design assumes it does. Its args are `Subagents` (a
 * JSON array of `{Model, Prompt, Role, TypeName}`), `toolAction` and
 * `toolSummary` — a role and a prompt, never an id. So the step can prove THAT a
 * subagent was spawned; it can never say WHICH conversation is that subagent. Any
 * join from step to child would be positional, and a positional join is a guess.
 * The settlement is used because it is the only proof.
 *
 * Nor does the SCHEMA help: `conversation_summaries.parent_conversation_id` and
 * `.nesting_depth` exist, are empty/zero on every row, and neither parent nor
 * child appears in that table AT ALL — the summaries store has not been written
 * since Aug 15 (see `supplementaryRows`). A lineage built on those columns would
 * have found nothing here and looked correct doing it.
 *
 * Bounded twice over: the caller passes the conversations to look at, and
 * {@link AGY_LINEAGE_MAX_FILES} caps how many settlement files the whole sweep
 * may open regardless of how many that is.
 */
export function scanAgySubagentLinks(
  roots: AgyRoots,
  parentIds: readonly string[],
  query: {
    onWork?: (work: { kind: 'decode-file'; source: string }) => void;
    trace?: AgyTraceSink;
    budget?: number;
  } = {},
): Map<string, string> {
  const links = new Map<string, string>();
  let budget = query.budget ?? AGY_LINEAGE_MAX_FILES;
  for (const parentId of parentIds) {
    if (budget <= 0) {
      query.trace?.({ op: 'lineage-budget-exhausted', detail: `stopped before ${parentId}` });
      break;
    }
    for (const file of listAgySettlementFiles(roots, parentId, query.trace)) {
      if (budget <= 0) break;
      budget -= 1;
      query.onWork?.({ kind: 'decode-file', source: file });
      const read = readAgyTextFile(roots.appData, file, AGY_SMALL_JSON_MAX_BYTES, query.trace);
      if (read === undefined || read.truncated) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(read.text);
      } catch {
        continue;
      }
      const sender = (parsed as { sender?: unknown } | undefined)?.sender;
      // A BARE conversation id, and nothing else. `<id>/task-N` is a background
      // task, `system` is a host notice, and an absent sender is neither — three
      // of the six non-task senders on this host. Treating any of them as a child
      // would hang a roster row off a session that does not exist.
      if (typeof sender !== 'string' || !isAgyConversationId(sender.trim())) continue;
      const childId = sender.trim();
      if (childId === parentId) continue;
      const held = links.get(childId);
      if (held && held !== parentId) {
        query.trace?.({ op: 'lineage-conflict', detail: `${childId}: keeping parent ${held}, ignoring ${parentId}` });
        continue;
      }
      links.set(childId, parentId);
    }
  }
  return links;
}

// ── The model picker (P2a) ───────────────────────────────────────────────────

/**
 * The host's effort vocabulary, in the host's own order.
 *
 * MEASURED 2026-08-25 from the 1.1.20 binary's own flag help: "Reasoning effort
 * for the current CLI session (low|medium|high)". Not three values chosen here.
 */
export const AGY_REASONING_EFFORTS = ['low', 'medium', 'high'] as const;
export type AgyReasoningEffort = (typeof AGY_REASONING_EFFORTS)[number];

/**
 * `Gemini 3.6 Flash (High)` → base `Gemini 3.6 Flash`, effort `high`.
 *
 * Parsed from the host's own displayName parenthetical and NEVER from the id,
 * because the catalog disagrees with itself on exactly that point: id
 * `gemini-3.5-flash-low` publishes displayName "Gemini 3.5 Flash (Medium)", and
 * `gemini-3.5-flash-extra-low` publishes "Gemini 3.5 Flash (Low)" (MEASURED
 * 2026-08-25). An id-derived effort would be wrong on two of 25 rows. The
 * displayName is the host's published fact; the id is an opaque handle.
 *
 * `(Thinking)` deliberately does not match — it is not an effort level, and
 * "Claude Sonnet 4.6 (Thinking)" is one whole model name.
 */
const AGY_EFFORT_SUFFIX = /^(.*?)\s*\((Low|Medium|High)\)$/;

export interface AgyModelVariant {
  baseLabel: string;
  effort: AgyReasoningEffort;
}

export function parseAgyModelVariant(displayName: string): AgyModelVariant | undefined {
  const match = AGY_EFFORT_SUFFIX.exec(displayName.trim());
  if (!match) return undefined;
  const baseLabel = match[1]!.trim();
  if (!baseLabel) return undefined;
  return { baseLabel, effort: match[2]!.toLowerCase() as AgyReasoningEffort };
}

/** A base model and the concrete catalog ids that implement each of its efforts. */
export interface AgyModelFamily {
  baseLabel: string;
  /** effort → the catalog id that IS that effort variant. */
  byEffort: Map<AgyReasoningEffort, string>;
}

/**
 * Group the catalog the way the host's own picker groups it.
 *
 * The 1.1.20 changelog (read out of the binary, not off a website) says the
 * `/model` picker was "redesigned … to group models by their base model and
 * choose reasoning effort from a timeline gauge". This is that grouping, rebuilt
 * from the same data the picker reads.
 *
 * A base label may be claimed twice for one effort — `gemini-3.1-pro-high` and
 * `gemini-pro-agent` both publish "Gemini 3.1 Pro (High)" (MEASURED). FIRST WINS
 * and the collision is traced: the alternative is picking arbitrarily between two
 * ids at launch time, which is the same mistake {@link resolveAgyModel} refuses
 * to make for the settings label.
 */
export function groupAgyModelFamilies(
  catalog: AgyModelCatalog,
  trace?: AgyTraceSink,
): Map<string, AgyModelFamily> {
  const families = new Map<string, AgyModelFamily>();
  for (const entry of catalog.byId.values()) {
    const variant = parseAgyModelVariant(entry.displayName);
    if (!variant) continue;
    let family = families.get(variant.baseLabel);
    if (!family) {
      family = { baseLabel: variant.baseLabel, byEffort: new Map() };
      families.set(variant.baseLabel, family);
    }
    const held = family.byEffort.get(variant.effort);
    if (held) {
      trace?.({
        op: 'model-variant-collision',
        detail: `${variant.baseLabel} ${variant.effort}: keeping ${held}, ignoring ${entry.id}`,
      });
      continue;
    }
    family.byEffort.set(variant.effort, entry.id);
  }
  return families;
}

/**
 * The model picker's rows.
 *
 * ONE ROW PER LAUNCHABLE THING, and every `modelID` is an id the catalog
 * actually publishes — never a base id synthesized by stripping a suffix. That
 * restraint is not stylistic: no base id exists in the catalog at all
 * (`gemini-3.6-flash-high`/`-medium`/`-low` are there; `gemini-3.6-flash` is
 * not, MEASURED 2026-08-25), so a stripped id would name a model the host
 * rejects with its own "invalid model selection" error.
 *
 * A base model with TWO OR MORE measured effort variants collapses into a single
 * row carrying `reasoningEfforts`; the adapter re-expands (row, effort) back to
 * the sibling id at launch — see {@link resolveAgyLaunchModel}. A base with ONE
 * variant stays a plain row, because a picker offering a choice of one is a
 * control that does nothing.
 *
 * `--effort` IS A REAL FLAG (MEASURED: "Added an `--effort` flag to select a
 * model's reasoning-effort variant when launching the CLI") and is deliberately
 * NEVER PASSED. The same binary carries "--model %s conflicts with --effort=%s"
 * and "--effort is not supported for model %q", and every id in this catalog is
 * already a concrete effort variant — so naming the sibling id is the launch that
 * cannot be refused, while `--model <variant> --effort <same>` is the launch that
 * can. The effort still reaches the user as a picker; only the wire differs.
 *
 * A collision LOSER is not lost either: it never joins a family, so it falls
 * through to the flat branch and appears under its own full label with its own id
 * in `description`. 25 ids in, 20 rows out, every id still launchable.
 *
 * Ambiguous labels STAY LISTED. Four ids publish "Gemini 3.1 Flash Lite"
 * (MEASURED) and each is separately launchable, so all four appear, each carrying
 * its own id in `description` — the only thing that tells them apart, and the
 * host's own string rather than a name invented here. What never happens is the
 * reverse join: a label is never resolved back to "the" id.
 */
export function agyModelOptions(
  catalog: AgyModelCatalog,
  options: { settingsLabel?: string; trace?: AgyTraceSink } = {},
): ModelOption[] {
  const families = groupAgyModelFamilies(catalog, options.trace);
  const grouped = new Set<string>();
  for (const family of families.values()) {
    if (family.byEffort.size < 2) continue;
    for (const id of family.byEffort.values()) grouped.add(id);
  }
  // The host's globally-selected label, split the same way, so a family whose
  // effort the user has actually chosen can preselect it. A settings label that
  // names no family simply yields no default — never a guessed one.
  const selected = options.settingsLabel ? parseAgyModelVariant(options.settingsLabel) : undefined;

  const out: ModelOption[] = [];
  const emittedFamilies = new Set<string>();
  for (const entry of catalog.byId.values()) {
    if (!grouped.has(entry.id)) {
      const ambiguous = (catalog.byLabel.get(entry.displayName)?.length ?? 0) > 1;
      out.push({
        providerID: AGY_PROVIDER_ID,
        modelID: entry.id,
        label: entry.displayName,
        ...(ambiguous ? { description: entry.id } : {}),
      });
      continue;
    }
    const variant = parseAgyModelVariant(entry.displayName)!;
    if (emittedFamilies.has(variant.baseLabel)) continue;
    emittedFamilies.add(variant.baseLabel);
    const family = families.get(variant.baseLabel)!;
    // Ordered by the host's own low→medium→high rather than by catalog order, so
    // the client's gauge runs the direction its labels imply.
    const efforts = AGY_REASONING_EFFORTS.filter((effort) => family.byEffort.has(effort));
    const preselected = selected?.baseLabel === variant.baseLabel ? selected.effort : undefined;
    const defaultEffort = preselected && family.byEffort.has(preselected) ? preselected : undefined;
    out.push({
      providerID: AGY_PROVIDER_ID,
      // The row's own id is a REAL variant id, so a client that ignores
      // `reasoningEfforts` entirely still sends something launchable.
      modelID: family.byEffort.get(defaultEffort ?? efforts[0]!)!,
      label: variant.baseLabel,
      reasoningEfforts: efforts.map((effort) => ({ effort, label: effort })),
      ...(defaultEffort ? { defaultReasoningEffort: defaultEffort } : {}),
    });
  }
  return out;
}

/**
 * Turn a client's `{modelID, reasoningEffort}` back into ONE launchable id.
 *
 * The picker collapsed a family's effort variants into one row; this re-expands
 * it. An effort that names no sibling — a stale client, a catalog that changed
 * underneath — falls back to the id the client sent, which is itself a real
 * catalog id, rather than failing the send or passing an `--effort` the host may
 * reject. Degrading, and saying so.
 */
export function resolveAgyLaunchModel(
  catalog: AgyModelCatalog,
  selection: { modelID?: string; reasoningEffort?: string } | undefined,
  trace?: AgyTraceSink,
): string | undefined {
  const modelID = selection?.modelID;
  if (!modelID) return undefined;
  const effort = selection?.reasoningEffort;
  if (!effort) return modelID;
  const entry = catalog.byId.get(modelID);
  const variant = entry ? parseAgyModelVariant(entry.displayName) : undefined;
  if (!variant) {
    trace?.({ op: 'model-effort-unmapped', detail: `${modelID} is not an effort variant; ignoring effort=${effort}` });
    return modelID;
  }
  const sibling = groupAgyModelFamilies(catalog).get(variant.baseLabel)?.byEffort.get(effort as AgyReasoningEffort);
  if (!sibling) {
    trace?.({ op: 'model-effort-unmapped', detail: `${variant.baseLabel} has no ${effort} variant; keeping ${modelID}` });
    return modelID;
  }
  return sibling;
}

// ── The mode picker (P2b) ────────────────────────────────────────────────────

/**
 * The `--mode` vocabulary, verbatim from the 1.1.20 binary (MEASURED 2026-08-25).
 *
 * The flag's own help string enumerates exactly three: `default` ("standard
 * behavior"), `accept-edits` ("auto-approve file edits, prompt for commands")
 * and `plan` ("research and plan without making changes"). The TUI's hint agrees
 * — "Press shift+tab to cycle modes (default, accept-edits, plan)."
 *
 * `full-access` IS NOT ONE OF THEM: that string does not occur anywhere in the
 * binary. Neither are `always-proceed`, `request-review` or `strict`, which DO
 * occur but on a DIFFERENT AXIS — they are the auto-execution/approval policy
 * ("In request-review mode, file edits are shown for approval before being
 * applied"), which is precisely why a child launched with `--mode=plan` reports
 * `permission_mode: "request-review"` in its `init` event. That measurement
 * already forced `handleInit` to ignore the reported value; this is the reason it
 * had to. Two axes, and agy exposes a flag for only one of them.
 *
 * The descriptions are the host's own words, one clause each — no copy invented
 * here (reflection §3).
 */
export const AGY_MODES: ModeOption[] = [
  {
    value: 'default',
    label: 'Default',
    description: 'Standard behavior.',
    category: 'ask-permission',
  },
  {
    value: 'accept-edits',
    label: 'Accept edits',
    description: 'Auto-approve file edits, prompt for commands.',
    category: 'approve-for-me',
  },
  {
    value: 'plan',
    label: 'Plan',
    // Not a permission posture at all, so it is not filed as one: it changes what
    // the agent DOES, not what it may do without asking.
    description: 'Research and plan without making changes.',
    category: 'custom',
  },
];

/** Is this a `--mode` value the host actually accepts? Guards the launch argv. */
export function isAgyMode(value: string | undefined): boolean {
  return value !== undefined && AGY_MODES.some((mode) => mode.value === value);
}

// ── Small shared readers ─────────────────────────────────────────────────────

/** What a bounded read returned. `truncated` is load-bearing: the caller must say so. */
export interface AgyTextRead {
  text: string;
  truncated: boolean;
}

/**
 * Read a file that must live inside `root`, bounded by `maxBytes`.
 *
 * Returns undefined for missing OR refused, since to every caller both mean the
 * same thing — there is nothing to read — and the distinction is already in the
 * trace, which `safe-read` emits with the specific reason.
 */
export function readAgyTextFile(
  root: string,
  path: string,
  maxBytes: number,
  trace?: AgyTraceSink,
): AgyTextRead | undefined {
  const read = readContainedText(root, path, maxBytes, trace);
  if (isAgyReadRefusal(read)) return undefined;
  return { text: read.text, truncated: read.truncated };
}

function readJsonFile(
  root: string,
  path: string,
  maxBytes: number,
  trace: AgyTraceSink | undefined,
  op: string,
): unknown {
  const read = readAgyTextFile(root, path, maxBytes, trace);
  if (read === undefined) {
    trace?.({ op: `${op}-missing`, detail: `unreadable: ${path}` });
    return undefined;
  }
  // A truncated JSON file is not partially usable — it is a parse error waiting
  // to happen, and a parse error would report the wrong cause. Name the real one.
  if (read.truncated) {
    trace?.({ op: `${op}-oversized`, detail: `${path} exceeds the ${maxBytes}-byte cap; not parsed` });
    return undefined;
  }
  try {
    return JSON.parse(read.text);
  } catch (error) {
    trace?.({ op: `${op}-unparseable`, detail: `${path}: ${String(error)}` });
    return undefined;
  }
}

/**
 * Settlement inbox files, newest last. `read.json` and `undelivered/` are siblings, not messages.
 *
 * Bounded by an ENTRY count as well as by containment: the inbox is a directory
 * the CLI appends to, and a byte cap on each message says nothing about a
 * directory holding a million of them.
 */
export function listAgySettlementFiles(
  roots: AgyRoots,
  conversationId: string,
  trace?: AgyTraceSink,
): string[] {
  const dir = agySettlementDir(roots, conversationId);
  const listed = listContainedDirectory(roots.appData, dir, AGY_SETTLEMENT_MAX_FILES, trace);
  if (isAgyReadRefusal(listed)) return [];
  // `read.json` and `cursor.json` are the inbox's own bookkeeping — a delivered-set
  // and a `{last_read_unix_nano}` watermark. Both parse as JSON and neither has a
  // `sender`, so leaving them in made every sweep report a `settlement-unparseable`
  // for a file that is not a settlement and never was (MEASURED on the live store).
  // A trace that cries wolf on healthy state is worse than no trace.
  return listed.names
    .filter((name) => name.endsWith('.json') && name !== 'read.json' && name !== 'cursor.json')
    .sort()
    .map((name) => join(dir, name));
}

// ── The brain scan: conversations the summaries store forgot ─────────────────

/**
 * Bytes of a transcript read to find its first user prompt. ~10× the largest
 * observed first line; a title is not worth a whole-file read on every row.
 */
export const AGY_BRAIN_HEAD_BYTES = 64 * 1024;

/** Ceiling on brain dirs examined in one sweep. ~9× the 56 dirs on the measured host. */
export const AGY_BRAIN_SCAN_MAX_DIRS = 512;

/** `cache/last_conversations.json` is a flat `cwd -> conversationId` map (MEASURED: 15 entries). */
export function readAgyLastConversations(
  roots: AgyRoots,
  trace?: AgyTraceSink,
): Map<string, string> {
  const parsed = readJsonFile(
    roots.appData,
    join(roots.appData, 'cache', 'last_conversations.json'),
    AGY_SMALL_JSON_MAX_BYTES,
    trace,
    'last-conversations',
  );
  const out = new Map<string, string>();
  if (!parsed || typeof parsed !== 'object') return out;
  // Inverted on the way out: callers hold a conversation id and want its cwd.
  for (const [cwd, id] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof id === 'string' && isAgyConversationId(id) && isAbsolute(cwd)) out.set(id, cwd);
  }
  return out;
}

/** A conversation found on disk rather than in the summaries table. */
export interface AgyBrainRow {
  conversationId: string;
  /** Transcript mtime. The only timestamp a brain dir offers. */
  updatedAt: number;
  /** Raw first `USER_INPUT` content, wrappers still on. The caller strips them. */
  firstUserContent?: string;
  /** From `cache/last_conversations.json`, when that map still names this conversation. */
  cwd?: string;
}

export interface AgyBrainScanQuery {
  updatedAfter?: number;
  limit?: number;
  /** Ids already covered by the summaries table; skipped without any io. */
  exclude?: ReadonlySet<string>;
  /**
   * Look at ONLY these ids. What `attach()` uses to resolve one conversation the
   * summaries table does not know: the same scan, the same title derivation and
   * the same timestamp as the roster row the user clicked, rather than a second
   * path that could describe the session differently.
   */
  only?: readonly string[];
  /**
   * Skip the per-row HEAD read that derives a title. For callers that need ids
   * and mtimes only — the lineage-parent universe — where paying a capped read
   * per row would buy nothing.
   */
  skipHeadRead?: boolean;
  /**
   * Reported per transcript actually opened, using the protocol's own
   * `decode-file` kind — which is precisely what a head read is. The directory
   * listing itself is not reported: it is one bounded `opendir`, not a decode.
   */
  onWork?: (work: { kind: 'decode-file'; source: string }) => void;
  trace?: AgyTraceSink;
}

/**
 * Discover conversations from `brain/` when the summaries table cannot.
 *
 * WHY THIS EXISTS — measured on the developer host, 2026-08-25:
 * `conversation_summaries.db` has not been written since Aug 15. Six
 * conversations created that day (print-mode, stream-json, a clean interactive
 * session, and a fresh TUI boot) added ZERO rows to it, and
 * `cache/conversation_metadata.json` is equally frozen. Meanwhile `brain/` holds
 * 56 conversation directories against the table's 27 CLI rows. Discovery that
 * trusts the table alone therefore cannot see anything the user has done in the
 * last ten days — a roster that is silently, permanently out of date.
 *
 * WHAT IT WILL NOT DO: invent rows. Of the 29 brain dirs absent from the table,
 * only 12 hold a transcript; the other 19 contain nothing but an empty
 * `.user_uploaded/` and `scratch/`. Those are conversations that never ran, and a
 * row for one would open to a permanent "no transcript" notice. A directory
 * earns a row by having something to replay, and nothing else does.
 *
 * IDE ROWS STAY OUT, and this is verified rather than assumed: the IDE keeps its
 * own tree at `~/.gemini/antigravity/` with its own `brain/` (5 dirs), and NO
 * summaries row marked `app_data_dir = 'antigravity'` has a directory under the
 * CLI's `brain/`. The two trees do not cross-contaminate, so everything scanned
 * here is CLI-owned by construction.
 *
 * Bounded three ways: the directory listing is entry-capped, each transcript is
 * touched with one `stat` plus a capped HEAD read for its title, and the cutoff
 * is applied against the mtime BEFORE that read so a cold conversation costs a
 * stat and nothing more.
 */
export function scanAgyBrainDirs(roots: AgyRoots, query: AgyBrainScanQuery = {}): AgyBrainRow[] {
  const brainRoot = join(roots.appData, 'brain');
  const listed = listContainedDirectory(roots.appData, brainRoot, AGY_BRAIN_SCAN_MAX_DIRS, query.trace);
  if (isAgyReadRefusal(listed)) {
    query.trace?.({ op: 'brain-scan-unreadable', detail: `${brainRoot}: ${listed}` });
    return [];
  }
  if (listed.truncated) {
    query.trace?.({
      op: 'brain-scan-truncated',
      detail: `${brainRoot} holds more than ${AGY_BRAIN_SCAN_MAX_DIRS} directories`,
    });
  }

  const rows: AgyBrainRow[] = [];
  for (const name of listed.names) {
    // A non-uuid directory cannot be a conversation, and costs no io to reject.
    if (!isAgyConversationId(name)) continue;
    if (query.exclude?.has(name)) continue;
    if (query.only && !query.only.includes(name)) continue;

    const transcript = join(brainRoot, name, '.system_generated', 'logs', 'transcript.jsonl');
    let updatedAt: number;
    try {
      const stat = statSync(transcript);
      if (!stat.isFile()) continue;
      updatedAt = stat.mtimeMs;
    } catch {
      // No transcript: a directory that never became a conversation. 19 of 56 on
      // the measured host. Not a row.
      continue;
    }
    if (query.updatedAfter !== undefined && updatedAt < query.updatedAfter) continue;
    rows.push({ conversationId: name, updatedAt });
  }

  // Newest first, then bound, so a budget keeps the MOST RELEVANT rows rather
  // than whichever ones the filesystem happened to name first.
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  const capped = query.limit !== undefined ? rows.slice(0, Math.max(0, Math.trunc(query.limit))) : rows;

  // The head read happens only for rows that survived the cutoff and the budget.
  if (!query.skipHeadRead) {
    for (const row of capped) {
      const path = join(brainRoot, row.conversationId, '.system_generated', 'logs', 'transcript.jsonl');
      query.onWork?.({ kind: 'decode-file', source: path });
      const head = readContainedText(roots.appData, path, AGY_BRAIN_HEAD_BYTES, query.trace);
      if (isAgyReadRefusal(head)) continue;
      const first = firstUserContent(head.text);
      if (first !== undefined) row.firstUserContent = first;
    }
  }
  return capped;
}

/** The `content` of the first `USER_EXPLICIT`/`USER_INPUT` line in a transcript head. */
function firstUserContent(headText: string): string | undefined {
  for (const line of headText.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A truncated final line is expected: this is a capped HEAD read.
      continue;
    }
    const step = parsed as Record<string, unknown>;
    if (step.source === 'USER_EXPLICIT' && step.type === 'USER_INPUT' && typeof step.content === 'string') {
      return step.content;
    }
  }
  return undefined;
}
