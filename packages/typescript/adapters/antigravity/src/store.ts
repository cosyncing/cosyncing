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
  return listed.names
    .filter((name) => name.endsWith('.json') && name !== 'read.json')
    .sort()
    .map((name) => join(dir, name));
}
