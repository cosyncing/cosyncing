/**
 * Claude Code adapter — integrationKind 'sdk-callback'; v1 attach mode: OBSERVE (transcript-JSONL tail).
 *
 * Claude Code persists every session as an append-only JSONL transcript at
 *   ~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl
 * One JSON object per line. Observe replays the file as history and live-follows appended lines — no
 * daemon, no spawned LLM, no model cost: the dependable surface that makes the app "never empty" for
 * Claude. Resume (`claude -p --resume`) and the live channel bridge (a declarative `.mcp.json` MCP
 * server advertising the experimental `claude/channel` capability + `notifications/claude/channel`
 * — NOT a SessionStart hook) are later increments; see docs/protocol/adapter-support.md
 *
 * What this maps (verified against 144 real sessions, 2.1.104 → 2.1.178 — see the adapter doc):
 *  - 14 top-level line types exist; only `assistant` / `user` / `system` are conversation. The other
 *    ~10 (`ai-title`, `custom-title`, `mode`, `permission-mode`, `last-prompt`, `bridge-session`,
 *    `queue-operation`, `file-history-snapshot`, `attachment`, `agent-name`, `pr-link`) are un-threaded
 *    sidecar app-state and are SKIPPED (titles are read off `custom-title`/`ai-title` at discovery).
 *  - assistant.message.content is ALWAYS an array of {text|thinking|redacted_thinking|tool_use} blocks.
 *    Recent versions split each block onto its own line; older ones PACK several into one line — so we
 *    iterate content[] and never assume content[0]. Each line carries a globally-unique, stable `uuid`
 *    used as the dedup key (better than Codex's line index); tool-call/tool-result dedupe by `callId`.
 *  - The rich tool detail lives in the TOP-LEVEL `toolUseResult` on the SAME user line as the
 *    `tool_result` block (not in the block) — so a tool-result is self-contained (no cross-line enrich
 *    map like Codex). We correlate `tool_use_id` → the earlier tool_use only to recover the toolName.
 *  - TOKEN-COUNT TRAP: message.usage is duplicated byte-identically on EVERY line of a multi-line turn
 *    (one message.id → up to 11 lines). We emit token-count ONCE per message.id (first-seen) or it
 *    overcounts 6–11×.
 *  - Bash results carry NO numeric exit code — isError is derived from the block's `is_error` (or
 *    `toolUseResult.interrupted`); we never fabricate an exitCode.
 *  - Compaction is split across two lines: a `system/compact_boundary` → history-reset, plus a fat
 *    injected `isCompactSummary` user string that we SUPPRESS (machine context, not a user turn).
 *  - Sub-agent (Task) transcripts live in a separate sibling tree (`<uuid>/subagents/agent-*.jsonl`);
 *    discovery walks DEPTH-1 `*.jsonl` only, so those are excluded; the main file shows just the Agent
 *    tool call/result.
 */
import { homedir } from 'node:os';
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  fstatSync,
  openSync,
  readSync,
  closeSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  renameSync,
  rmSync,
  watch,
  type FSWatcher,
} from 'node:fs';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { join, basename, dirname, resolve, relative, sep, extname } from 'node:path';
import {
  PRODUCT_IDENTITY,
  summarizeDiff,
  gitDiffPath,
  type AgentBackend,
  type AgentCapabilities,
  type AgentMessage,
  type AgentMessageHandler,
  type AgentSetupDiagnosis,
  type AttachMode,
  type FileChange,
  type FileOperation,
  type CommandResult,
  type FileInput,
  type HistorySourceIdentity,
  type ModeOption,
  type ModelOption,
  type PermissionDecision,
  type PromptInput,
  type SessionConnection,
  type SessionControlState,
  type SessionDriveControl,
  type SessionDiscoveryOptions,
  type SessionInfo,
  type SessionTerminalSync,
  type SlashCommand,
  type ToolCommandState,
  type ToolDisplayClass,
  type ToolSearchGroup,
  type ToolSemantic,
  type SetupDiagnosisContext,
  type Unsubscribe,
  boundToolSemantic,
  boundedStream,
  commandSemantic,
  fileReadSemantic,
  searchGroup,
  searchSemantic,
  webSemantic,
} from '@cosyncing/adapter-api';
import { diagnoseClaudeSetup } from './diagnostics.ts';

const CAPS: AgentCapabilities = {
  integrationKind: 'sdk-callback',
  // observe is the SAFE default (read-only transcript tail; zero model cost); resume DRIVES a turn via
  // `claude -p --resume` and is entered only on an explicit `?mode=resume` attach — never automatically,
  // so opening a paid official session never spends quota. See attach() + main.ts mode plumbing.
  attachModes: ['observe', 'resume'],
  supportsObserve: true,
  supportsResume: true,
  // True-sync via the claude/channel bridge is unsupported: current runtime evidence gates
  // permission answering to allowlisted channels, so our channel can display but not control.
  // See docs/protocol/adapter-support.md (Claude control boundary). Claude control = Observe + Drive.
  supportsLiveAttach: false,
  supportsNativeArtifact: true, // SendUserFile attachments + inline images → file-artifact (observe + resume)
  supportsNativeFileInput: true, // resume sendPrompt: native image blocks + files staged to .cosyncing/inbox; live sendFile too
  supportsModelSwitch: true, // resume relaunches with `--model`; observe ignores it
  permissionGranularity: 'per-session', // resume launches with a chosen `--permission-mode`
};

// The default store honors CLAUDE_CONFIG_DIR exactly as the real `claude` binary does (so a user — or a
// test harness — who redirects it is discovered/resumed in the right place); falls back to ~/.claude.
const DEFAULT_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
const DEFAULT_PROJECTS_ROOT = join(DEFAULT_CONFIG_DIR, 'projects');
// Launch binary for the default store. COSYNCING_CLAUDE_BIN overrides `claude` (test hook for a fake
// stream-json binary, mirroring Codex's COSYNCING_CODEX_BIN); production leaves it unset → plain `claude`.
const DEFAULT_BIN = process.env.COSYNCING_CLAUDE_BIN?.trim() || 'claude';
/** Deferred rows are process-local and disappear on restart, so retain only a bounded FIFO working set. */
export const CLAUDE_MAX_PENDING_CREATES = 256;

/**
 * A Claude session STORE: a `CLAUDE_CONFIG_DIR` and the launch binary that targets it. The official
 * account lives in `~/.claude`; each wrapper (`~/bin/claude-mi`, `claude-minimax`, …) redirects
 * `CLAUDE_CONFIG_DIR` to its own dir and points Claude at a different provider/model, so its sessions
 * live OUTSIDE `~/.claude/projects` and were invisible until we scanned every store. `bin` is what
 * resume must exec so the right provider/model + config dir are used. (Issue D.)
 */
export interface ClaudeStore {
  configDir: string;
  projectsRoot: string;
  /** Launch binary for resume: the wrapper path (sets all env) or plain `claude` for the default store. */
  bin: string;
  /** Human label for the roster model column (the wrapper's ANTHROPIC_MODEL, e.g. 'MiniMax-M3'). */
  model?: string;
  /** All DISTINCT backend models a wrapper exposes via its ANTHROPIC_*_MODEL mappings (e.g. claude-mi maps
   *  opus→pro + haiku→non-pro), so the picker can switch among them. Undefined for the default store. */
  models?: string[];
  baseUrl?: string;
  isDefault: boolean;
}

let _storesCache: ClaudeStore[] | undefined;
let _storesCacheAt = 0;
let _storesCacheDirMtime = -1;
const STORES_CACHE_TTL_MS = 60_000;

/** The default `~/.claude` store plus one per discovered `~/bin/claude*` wrapper (parsed for its
 *  `CLAUDE_CONFIG_DIR`/`ANTHROPIC_MODEL`/`ANTHROPIC_BASE_URL`). Deduped by resolved config dir, default
 *  first. Cached with a 60s TTL + a bin-dir mtime check — a forever cache made a wrapper created AFTER
 *  broker start (claude-glm, 2026-07-04) invisible until restart (issues-part2). */
export function claudeStores(): ClaudeStore[] {
  const wrapperDir = process.env.COSYNCING_CLAUDE_WRAPPER_DIR?.trim() || join(homedir(), 'bin');
  const dirMtime = statSafe(wrapperDir)?.mtimeMs ?? -1;
  if (_storesCache && Date.now() - _storesCacheAt < STORES_CACHE_TTL_MS && dirMtime === _storesCacheDirMtime) return _storesCache;
  _storesCacheAt = Date.now();
  _storesCacheDirMtime = dirMtime;
  _storesCache = undefined;
  const byDir = new Map<string, ClaudeStore>();
  byDir.set(resolve(DEFAULT_CONFIG_DIR), {
    configDir: DEFAULT_CONFIG_DIR,
    projectsRoot: DEFAULT_PROJECTS_ROOT,
    bin: DEFAULT_BIN,
    isDefault: true,
  });
  const binDir = process.env.COSYNCING_CLAUDE_WRAPPER_DIR?.trim() || join(homedir(), 'bin');
  let names: string[] = [];
  try {
    names = readdirSync(binDir).filter((n) => /^claude(-|$)/.test(n) && n !== 'claude');
  } catch {
    /* no ~/bin */
  }
  for (const name of names) {
    const full = join(binDir, name);
    let txt: string;
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      txt = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    // Only treat as a Claude wrapper if it both redirects CLAUDE_CONFIG_DIR and execs `claude`.
    const dir = matchEnv(txt, 'CLAUDE_CONFIG_DIR');
    if (!dir || !/\bexec\s+claude\b|\bclaude\s+"\$@"/.test(txt)) continue;
    const configDir = expandHome(dir);
    const key = resolve(configDir);
    if (byDir.has(key)) continue; // dedupe (first wrapper for a dir wins)
    const models = resolveWrapperModels(txt);
    byDir.set(key, {
      configDir,
      projectsRoot: join(configDir, 'projects'),
      bin: full,
      model: models[0] ?? resolveWrapperModel(txt), // primary = roster label + currentModel seed
      models: models.length ? models : undefined, // all distinct backend models for the picker
      baseUrl: matchEnv(txt, 'ANTHROPIC_BASE_URL'),
      isDefault: false,
    });
  }
  _storesCache = [...byDir.values()];
  return _storesCache;
}

/** realpath (symlink-resolving) when the path exists, else a plain string-resolve — so a missing path
 *  (a not-yet-written session) still resolves and existing paths are symlink-canonicalized. Shared by
 *  every store-containment check so they agree on one namespace (Fable review 2026-07-09). */
function realOrResolve(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** The store that owns a transcript path (longest matching projectsRoot prefix), or the default. Must
 *  resolve BOTH the path and the roots through realpath: `attach` now hands us a realpath-canonicalized
 *  path, so a `resolve()`-only root match would miss a store whose root has a symlinked component and
 *  silently fall back to the default subscription store — a wrapper-vs-subscription Drive-billing
 *  mismatch (Fable review 2026-07-09). */
function storeForPath(path: string): ClaudeStore {
  const r = realOrResolve(path);
  const stores = claudeStores();
  let best: ClaudeStore | undefined;
  let bestLen = -1;
  for (const s of stores) {
    const root = realOrResolve(s.projectsRoot);
    if (r === root || r.startsWith(root + sep)) {
      if (root.length > bestLen) {
        best = s;
        bestLen = root.length;
      }
    }
  }
  return best ?? stores[0]!;
}

/** The default (official ~/.claude subscription) store — always present in claudeStores(). */
function defaultStore(): ClaudeStore | undefined {
  return claudeStores().find((s) => s.isDefault);
}

/** Claude's transcript-dir slug for a cwd: every non-alphanumeric char → '-' (verified against real
 *  project dirs, e.g. `/home/u/Proj/a_b` → `-home-u-Proj-a-b`). Lets createSession predict where Claude
 *  will write a new session's `<uuid>.jsonl` so the row's id/path are stable before the first turn. */
function slugForCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

// ── Session-control state (Observe+Drive vs True-Sync) ─────────────────────────
// Contract: docs/architecture/client-ui.md The adapter must report control state
// EXPLICITLY (never inferred from a tool name / path / attachMode). The app renders Drive / Driving /
// Drive-unavailable / Sync from `SessionInfo.control` generically.

/**
 * Transcript uuids that Anthropic's OWN relayed remote-control (the mobile/web client) currently owns,
 * for a store — those must be observed-only (single-owner rule). Pure file IO, ZERO spawn.
 *
 * CAVEAT (Claude ≥2.1.x): a `<configDir>/sessions/<pid>.json` now records a non-empty `bridgeSessionId`
 * on EVERY interactive CLI session (so it CAN be remote-controlled), NOT only ones a mobile/web client is
 * actively driving. So `bridgeSessionId` alone is no longer a remote-control marker — gating Drive on it
 * blocked EVERY live local subscription session (verified: this host's own running terminal session
 * carries a `bridgeSessionId` yet is plainly drivable), while third-party wrapper stores — which have no
 * such pid-files — stayed drivable. A locally-launched `kind:"interactive" entrypoint:"cli"` session is a
 * normal terminal session we CAN drive (and `--fork-session` resume is single-owner safe regardless), so
 * it is NOT treated as remote-controlled; only a bridged session that is NOT a local interactive CLI
 * launch is.
 *
 * Join key is the `sessionId` field, never the pid (pids recycle; one sessionId can appear in several pid
 * files — any bridged file for it marks the session). Liveness-guarded on Linux (`/proc/<pid>`) so a
 * stale pid-file can't wrongly block a free session; on other platforms a bridged entry blocks
 * conservatively.
 */
export function bridgedUuids(store: ClaudeStore): Set<string> {
  const out = new Set<string>();
  const dir = join(store.configDir, 'sessions');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out; // no sessions dir → nothing remote-controlled
  }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      const j = JSON.parse(readFileSync(join(dir, n), 'utf8')) as {
        sessionId?: unknown;
        bridgeSessionId?: unknown;
        pid?: unknown;
        kind?: unknown;
        entrypoint?: unknown;
      };
      if (typeof j.sessionId !== 'string' || typeof j.bridgeSessionId !== 'string' || !j.bridgeSessionId) continue;
      // A normal locally-launched terminal session (interactive CLI) also carries a bridgeSessionId on
      // Claude ≥2.1.x — it is drivable, not remote-controlled — so don't block Drive on it. Only a
      // bridged session that is NOT a local interactive CLI launch is owned by the official remote client.
      if (j.kind === 'interactive' && j.entrypoint === 'cli') continue;
      const alive =
        process.platform === 'linux' && typeof j.pid === 'number' ? existsSync('/proc/' + j.pid) : true;
      if (alive) out.add(j.sessionId);
    } catch {
      /* skip malformed pid-file */
    }
  }
  return out;
}

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Live local terminal owner for a Claude transcript uuid, from `<configDir>/sessions/*.json`.
 *  This is broader than {@link bridgedUuids}: any alive pid-file naming the uuid means another
 *  terminal process may have in-memory ownership, so app Drive must fork instead of mutating in place. */
export function liveTerminalOwner(store: ClaudeStore, uuid: string, opts?: { fresh?: boolean }): number | null {
  return liveOwnerMap(store, opts?.fresh === true).get(uuid) ?? null;
}

// One sessions-dir scan per store per few seconds — claudeControl now asks per ROSTER ROW (willFork,
// issues-part2), and an uncached scan would be O(rows × pid-files) reads per poll.
const _ownerMapCache = new Map<string, { at: number; map: Map<string, number> }>();
const OWNER_MAP_TTL_MS = 4000;

/** Maximum native pid-registry records admitted by one discovery pass. The registry is runtime
 * state, not conversation history; a larger directory is treated as an ambiguous source rather
 * than allowing one malformed installation to make roster work unbounded. */
export const CLAUDE_NATIVE_REGISTRY_LIMIT = 4096;
const CLAUDE_NATIVE_REGISTRY_FILE_MAX_BYTES = 64 * 1024;
const CLAUDE_NATIVE_SELECTOR_FILE_MAX_BYTES = 1024 * 1024;
const CLAUDE_BRIDGE_HEAD_BYTES = 256 * 1024;
const CLAUDE_BRIDGE_TAIL_BYTES = 256 * 1024;

type ClaudeNativeIncarnation = {
  nativeId: string;
  sessionId: string;
  /** Claude's native process/session generation. Never inferred from file or conversation time. */
  sourceGeneration?: number;
};

type ClaudeNativeIncarnations = {
  bySessionId: Map<string, ClaudeNativeIncarnation>;
  currentByNativeId: Map<string, ClaudeNativeIncarnation>;
};

const nativeSelectorPath = (store: ClaudeStore): string =>
  join(store.configDir, 'cosyncing', 'native-incarnations.json');

/** Bounded durable native selection. Claude removes pid-registry files at process exit, but the
 * replacement relation remains true: forgetting it would resurrect the retired Working transcript
 * after either process exit or broker restart. This file stores only exact bridge/session/generation
 * triples already proven by the native registry. */
function readNativeSelectors(store: ClaudeStore): Map<string, ClaudeNativeIncarnation> {
  const out = new Map<string, ClaudeNativeIncarnation>();
  const path = nativeSelectorPath(store);
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > CLAUDE_NATIVE_SELECTOR_FILE_MAX_BYTES) return out;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; entries?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length > CLAUDE_NATIVE_REGISTRY_LIMIT) return out;
    for (const raw of parsed.entries) {
      const entry = raw as Partial<ClaudeNativeIncarnation>;
      if (
        typeof entry.nativeId !== 'string' || !/^claude-bridge:[A-Za-z0-9_-]+$/.test(entry.nativeId) ||
        typeof entry.sessionId !== 'string' || !entry.sessionId ||
        typeof entry.sourceGeneration !== 'number' || !Number.isFinite(entry.sourceGeneration) ||
        out.has(entry.nativeId)
      ) return new Map();
      out.set(entry.nativeId, {
        nativeId: entry.nativeId,
        sessionId: entry.sessionId,
        sourceGeneration: entry.sourceGeneration,
      });
    }
  } catch {
    /* absent, malformed, or racing selector stays fail-closed */
  }
  return out;
}

function writeNativeSelectors(
  store: ClaudeStore,
  selectors: Map<string, ClaudeNativeIncarnation>,
): void {
  if (process.env.COSYNCING_CLAUDE_NATIVE_SELECTOR_READ_ONLY === '1') return;
  if (selectors.size > CLAUDE_NATIVE_REGISTRY_LIMIT) return;
  const path = nativeSelectorPath(store);
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const entries = [...selectors.values()].sort((a, b) => a.nativeId.localeCompare(b.nativeId));
    const content = `${JSON.stringify({ version: 1, entries }, null, 2)}\n`;
    if (Buffer.byteLength(content) > CLAUDE_NATIVE_SELECTOR_FILE_MAX_BYTES) return;
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* ignore cleanup failure */ }
  }
}

function rememberNativeSelector(store: ClaudeStore, winner: ClaudeNativeIncarnation): void {
  if (winner.sourceGeneration === undefined) return;
  const selectors = readNativeSelectors(store);
  const previous = selectors.get(winner.nativeId);
  if (
    previous?.sessionId === winner.sessionId &&
    previous.sourceGeneration === winner.sourceGeneration
  ) return;
  selectors.set(winner.nativeId, winner);
  writeNativeSelectors(store, selectors);
}

/** Claude writes the same bridge identity with `cse_` in transcript sidecars and `session_` in its
 * live pid registry. Those are transport tags, not distinct identities. Accept only those two
 * measured native forms and retain the complete suffix; titles, cwd, content, and times never enter
 * this join. */
export function claudeNativeBridgeId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(?:cse_|session_)([A-Za-z0-9_-]+)$/.exec(value.trim());
  return match?.[1] ? `claude-bridge:${match[1]}` : undefined;
}

/** Exact bridge identity recorded by a transcript incarnation. Bridge sidecars are normally near
 * the head; the bounded tail covers late bridge adoption. A bridge record outside both windows is
 * deliberately left unrelated rather than guessed from weaker metadata. */
function transcriptNativeBridgeId(path: string): string | undefined {
  return cachedFileFact(path, 'native-bridge', () => {
    const st = statSafe(path);
    if (!st) return undefined;
    const segments = readHeadLines(path, CLAUDE_BRIDGE_HEAD_BYTES);
    if (st.size > CLAUDE_BRIDGE_HEAD_BYTES) {
      segments.push(...readTailLines(path, CLAUDE_BRIDGE_TAIL_BYTES));
    }
    let nativeId: string | undefined;
    for (const segment of segments) {
      const line = parseLineOrNull(segment);
      if (line?.type !== 'bridge-session') continue;
      nativeId = claudeNativeBridgeId(line.bridgeSessionId) ?? nativeId;
    }
    return nativeId;
  });
}

/** Current transcript incarnation per exact bridge identity, derived from Claude's pid registry
 * plus the last durably proven selection. `startedAt` is the only ordering input: it is the native
 * source generation, not a wall-clock proximity heuristic. Dead pids remain identity evidence.
 * Multiple records with a missing/tied generation remain ambiguous and suppress no transcript. */
function nativeIncarnations(store: ClaudeStore): ClaudeNativeIncarnations {
  const bySessionId = new Map<string, ClaudeNativeIncarnation>();
  const candidatesByNativeId = new Map<string, ClaudeNativeIncarnation[]>();
  const selectors = readNativeSelectors(store);
  let selectorsChanged = false;
  let names: string[] = [];
  try {
    names = readdirSync(join(store.configDir, 'sessions'))
      .filter((name) => name.endsWith('.json'))
      .sort();
    if (names.length > CLAUDE_NATIVE_REGISTRY_LIMIT) {
      return { bySessionId, currentByNativeId: new Map() };
    }
  } catch {
    // Registry deletion on clean Claude exit is ordinary. The durable exact selector below remains
    // authoritative across that absence; unreadable/oversized existing registries fail closed above.
    names = [];
  }
  for (const name of names) {
    const path = join(store.configDir, 'sessions', name);
    try {
      const st = statSync(path);
      if (!st.isFile() || st.size > CLAUDE_NATIVE_REGISTRY_FILE_MAX_BYTES) continue;
      const record = JSON.parse(readFileSync(path, 'utf8')) as {
        sessionId?: unknown;
        bridgeSessionId?: unknown;
        startedAt?: unknown;
      };
      if (typeof record.sessionId !== 'string' || !record.sessionId) continue;
      const nativeId = claudeNativeBridgeId(record.bridgeSessionId);
      if (!nativeId) continue;
      const generation = typeof record.startedAt === 'number' && Number.isFinite(record.startedAt)
        ? record.startedAt
        : undefined;
      const candidate: ClaudeNativeIncarnation = {
        nativeId,
        sessionId: record.sessionId,
        ...(generation !== undefined ? { sourceGeneration: generation } : {}),
      };
      bySessionId.set(candidate.sessionId, candidate);
      const group = candidatesByNativeId.get(nativeId) ?? [];
      group.push(candidate);
      candidatesByNativeId.set(nativeId, group);
    } catch {
      /* malformed or racing native registry entry */
    }
  }

  const currentByNativeId = new Map<string, ClaudeNativeIncarnation>();
  const nativeIds = new Set([...selectors.keys(), ...candidatesByNativeId.keys()]);
  for (const nativeId of nativeIds) {
    const observed = candidatesByNativeId.get(nativeId) ?? [];
    const persisted = selectors.get(nativeId);
    // An observed record with no generation cannot be ordered against any other incarnation. Drop
    // the remembered winner too: retaining it would turn ambiguity into a destructive retirement.
    if (observed.some((candidate) => candidate.sourceGeneration === undefined)) {
      if (selectors.delete(nativeId)) selectorsChanged = true;
      continue;
    }
    const candidates = [...observed, ...(persisted ? [persisted] : [])];
    if (candidates.length === 0) continue;
    const greatest = Math.max(...candidates.map((candidate) => candidate.sourceGeneration!));
    const winners = new Map<string, ClaudeNativeIncarnation>();
    for (const candidate of candidates) {
      if (candidate.sourceGeneration === greatest) winners.set(candidate.sessionId, candidate);
    }
    if (winners.size !== 1) {
      if (selectors.delete(nativeId)) selectorsChanged = true;
      continue;
    }
    const winner = winners.values().next().value as ClaudeNativeIncarnation;
    currentByNativeId.set(nativeId, winner);
    bySessionId.set(winner.sessionId, winner);
  }
  // Only destructive ambiguity updates are written here. A newly selected ordinary live session
  // is persisted later, when transcript discovery proves another source shares its exact native
  // identity; read-only discovery of unrelated sessions stays read-only.
  if (selectorsChanged) writeNativeSelectors(store, selectors);
  return { bySessionId, currentByNativeId };
}

function liveOwnerMap(store: ClaudeStore, fresh = false): Map<string, number> {
  const key = resolve(store.configDir);
  const hit = _ownerMapCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < OWNER_MAP_TTL_MS) return hit.map;
  const map = new Map<string, number>();
  const dir = join(store.configDir, 'sessions');
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    /* no sessions dir → empty map */
  }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      const j = JSON.parse(readFileSync(join(dir, n), 'utf8')) as { sessionId?: unknown; pid?: unknown };
      if (typeof j.sessionId === 'string' && pidAlive(j.pid)) map.set(j.sessionId, j.pid as number);
    } catch {
      /* skip malformed pid-file */
    }
  }
  _ownerMapCache.set(key, { at: Date.now(), map });
  return map;
}

// The claude/channel bridge plugin lives next to this adapter (packages/typescript/adapters/claude/plugin). Resolve
// its dir portably (no bun-only import.meta.dir) so the Sync command can point at its .mcp.json.
const PLUGIN_DIR = resolve(dirname(new URL(import.meta.url).pathname), '..', 'plugin');

/** Unix-socket path the bridge plugin listens on for a session (mirrors the plugin's own path). */
export function bridgeSocketPath(store: ClaudeStore, uuid: string): string {
  return join(store.configDir, 'cosyncing', 'bridge', uuid + '.sock');
}

/** Is a live true-sync bridge present for this session? A socket file (created by the plugin, unlinked
 *  on its exit) ⇒ the terminal launched Claude with our channel server and shares this live session.
 *  Existence + isSocket is the cheap discovery signal; the live connect proves liveness at attach. */
export function bridgeActive(store: ClaudeStore, uuid: string): boolean {
  try {
    return statSync(bridgeSocketPath(store, uuid)).isSocket();
  } catch {
    return false;
  }
}

/** Set of session uuids with a live bridge socket, for a store (one readdir vs a stat per row). */
function syncedUuids(store: ClaudeStore): Set<string> {
  const out = new Set<string>();
  let names: string[];
  try {
    names = readdirSync(join(store.configDir, 'cosyncing', 'bridge'));
  } catch {
    return out;
  }
  for (const n of names) if (n.endsWith('.sock')) out.add(n.replace(/\.sock$/, ''));
  return out;
}

const envTruthy = (v: unknown): boolean =>
  typeof v === 'string' ? v !== '' && v !== '0' && v.toLowerCase() !== 'false' : !!v;

/** A base URL is first-party iff unset or on `anthropic.com`. A non-string, unparseable, or unresolved
 *  `${VAR}`/`$VAR` value (whose real target we can't see) is treated as NOT first-party — conservative:
 *  we'd rather offer Observe+Drive than a Sync that silently fails. (Crash-hardened: non-string in.) */
function isFirstPartyBaseUrl(url?: unknown): boolean {
  if (typeof url !== 'string' || !url.trim()) return true;
  if (/\$\{?[A-Za-z_]/.test(url)) return false; // unresolved shell/template reference → can't prove first-party
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
    return h === 'anthropic.com' || h.endsWith('.anthropic.com');
  } catch {
    return false;
  }
}

/** Parse a Claude settings file → `{ env, top }` (env = string-valued `env` override block; top = the whole
 *  object, for top-level auth markers like `apiKeyHelper`). undefined if absent/unreadable/non-object. */
function readSettingsFile(file: string): { env: Record<string, string>; top: Record<string, unknown> } | undefined {
  let j: unknown;
  try {
    j = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  if (!j || typeof j !== 'object') return undefined;
  const top = j as Record<string, unknown>;
  const env: Record<string, string> = {};
  if (top.env && typeof top.env === 'object') {
    for (const [k, v] of Object.entries(top.env as Record<string, unknown>)) if (typeof v === 'string') env[k] = v;
  }
  return { env, top };
}

/** Does this settings file put the session OFF the first-party subscription backend (third-party endpoint,
 *  API key/token, Bedrock/Vertex, or an api-key auth helper)? Any ⇒ Claude gates channels off. */
function settingsForcesNonFirstParty(s: { env: Record<string, string>; top: Record<string, unknown> }): boolean {
  const { env, top } = s;
  if (env.ANTHROPIC_BASE_URL && !isFirstPartyBaseUrl(env.ANTHROPIC_BASE_URL)) return true;
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return true; // API/token mode (not subscription OAuth)
  if (envTruthy(env.CLAUDE_CODE_USE_BEDROCK) || envTruthy(env.CLAUDE_CODE_USE_VERTEX)) return true;
  if (typeof top.apiKeyHelper === 'string' && top.apiKeyHelper.trim()) return true; // shells out for an API key
  if (top.awsAuthRefresh || top.awsCredentialExport || top.forceLoginMethod === 'apiKey') return true;
  return false;
}

/** Enterprise managed-settings roots per OS (each may hold `managed-settings.json` + a `managed-settings.d/`). */
function managedSettingsRoots(): string[] {
  if (process.platform === 'win32')
    return [
      join(process.env.ProgramFiles ?? 'C:\\Program Files', 'ClaudeCode'),
      join(process.env.ProgramData ?? 'C:\\ProgramData', 'ClaudeCode'), // legacy < 2.1.75
    ];
  if (process.platform === 'darwin') return ['/Library/Application Support/ClaudeCode'];
  return ['/etc/claude-code'];
}

/**
 * Can this store's sessions use True-Sync (Claude `claude/channel`)? VERIFIED constraint (trace 2026-06-17):
 * channels are gated to a FIRST-PARTY Anthropic subscription backend (server-controlled GrowthBook flag
 * `tengu_harbor`); OFF for third-party / custom-endpoint, API-key, and Bedrock/Vertex sessions, and can't be
 * forced locally — so we DETECT eligibility and only offer Sync where it actually works.
 *
 * Reads EVERY config source Claude consults for the effective endpoint/auth, because the default `~/.claude`
 * store can be redirected WITHOUT a wrapper bin (cc-switch writes an `env` block into `settings.json`):
 *  - the wrapper bin (`store.baseUrl`) and the broker env (broker + the user's terminal usually share a shell);
 *  - PROJECT settings `<cwd>/.claude/settings(.local).json` — these OUTRANK user settings (a per-repo
 *    third-party route, e.g. cc-switch / claude-code-router, is the effective endpoint even on a clean store);
 *  - user `settings(.local).json`, store `managed-settings.json`, and OS enterprise managed settings
 *    (the file + every `managed-settings.d/*.json`).
 * Any non-first-party base URL, API key/token, `apiKeyHelper`/aws-auth, or Bedrock/Vertex flag ⇒ ineligible.
 * Fully crash-guarded — any parse/IO error ⇒ ineligible (Observe+Drive), never a broken Sync. KNOWN blind
 * spot: shell-only env (e.g. `export ANTHROPIC_BASE_URL` in ~/.bashrc) not inherited by the broker.
 */
export function eligibleForChannels(store: ClaudeStore, cwd?: string): boolean {
  try {
    if (!store.isDefault) return false; // wrapper = its own bin + custom endpoint → never first-party
    if (store.baseUrl && !isFirstPartyBaseUrl(store.baseUrl)) return false;
    // broker env (the broker and the user's terminal usually share one shell env)
    if (!isFirstPartyBaseUrl(process.env.ANTHROPIC_BASE_URL)) return false;
    if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_API_KEY_HELPER) return false;
    if (envTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) || envTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) return false;
    // settings files: project (outranks) → user → store-managed → OS-managed (+ managed-settings.d drop-ins)
    const files: string[] = [];
    if (cwd) files.push(join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json'));
    files.push(
      join(store.configDir, 'settings.json'),
      join(store.configDir, 'settings.local.json'),
      join(store.configDir, 'managed-settings.json'),
    );
    for (const root of managedSettingsRoots()) {
      files.push(join(root, 'managed-settings.json'));
      try {
        for (const n of readdirSync(join(root, 'managed-settings.d'))) if (n.endsWith('.json')) files.push(join(root, 'managed-settings.d', n));
      } catch {
        /* no drop-in dir */
      }
    }
    for (const f of files) {
      const s = readSettingsFile(f);
      if (s && settingsForcesNonFirstParty(s)) return false;
    }
    return true;
  } catch {
    return false; // any unexpected error → conservative (Observe+Drive only)
  }
}

/** Dormant unsupported channel bridge — kept for restore-when-allowlisted, not called.
 * See docs/protocol/adapter-support.md (Claude control boundary).
 *  The exact terminal command that creates true sync for a session: wire our channel MCP server and
 *  whitelist it via `--channels server:cosyncing`. CLAUDE_PLUGIN_ROOT lets the .mcp.json's
 *  `${CLAUDE_PLUGIN_ROOT}/server.ts` resolve in the manual `--mcp-config` case (it is auto-set only for
 *  an installed plugin). Plain `claude …` (no API key / --bare) so it stays on subscription/endpoint. */
export function syncCommand(store: ClaudeStore, uuid: string): string {
  return (
    `CLAUDE_PLUGIN_ROOT=${PLUGIN_DIR} ${store.bin} ` +
    `--mcp-config ${join(PLUGIN_DIR, '.mcp.json')} --channels server:cosyncing --resume ${uuid}`
  );
}

/**
 * Build the explicit control state for one Claude session.
 *  - Observe+Drive is REAL: Drive = a broker-owned `claude -p --resume` (lazy on first prompt).
 *    `observing` when the terminal still owns it; `driving` when we own the resume fork; `unavailable`
 *    on a remote-control collision or a vanished workspace (resume is cwd-scoped).
 *  - True-Sync via the claude/channel bridge plugin: `active:true` when a live bridge socket exists for
 *    this session (terminal + app share one live owner); otherwise `supported:true` with the exact
 *    `--channels` setup command. A remote-controlled session can be NEITHER driven NOR synced.
 */
/** The terminal command that rejoins a Claude conversation by uuid. Single source of truth for the
 *  "resume in terminal" tip so the app never hardcodes it (no `tool === 'claude'` branch). */
/** The ready-to-paste terminal command that rejoins a conversation. `claude --resume` is CWD-SCOPED —
 *  it only finds sessions belonging to the current directory's project (the drive spawn already
 *  launches in the session cwd for the same reason) — so the hint MUST lead with `cd <workspace> &&`,
 *  like codex's hint does; a bare `--resume` from anywhere else fails with "No conversation found"
 *  (issues-part2 re-flag 2026-07-12). */
export function claudeResumeTerminalCommand(uuid: string, cwd?: string): string {
  const cd = cwd ? `cd ${shellQuote(cwd)} && ` : '';
  return `${cd}claude --resume ${uuid}`;
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_/:=.,@%+\-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function claudeControl(opts: {
  store: ClaudeStore;
  uuid: string;
  cwd?: string;
  bridged: boolean;
  driving?: boolean;
  /** Whether this store can do true-sync at all (first-party Anthropic; see {@link eligibleForChannels}). */
  channelsEligible: boolean;
}): SessionControlState {
  const { store, uuid, cwd, bridged, driving, channelsEligible } = opts;
  let drive: SessionDriveControl;
  if (driving) {
    drive = { state: 'driving', supported: true };
  } else if (bridged) {
    drive = {
      state: 'unavailable',
      supported: false,
      reason: 'Under Claude Remote Control (mobile/web) — observed only, so two owners never collide.',
    };
  } else if (cwd && !existsSync(cwd)) {
    drive = { state: 'unavailable', supported: false, reason: 'Workspace no longer exists — cannot resume.' };
  } else {
    // A live TUI owner means the first driven prompt forks (single-owner safety) — surface that BEFORE
    // the user drives, not after the fork already happened (issues-part2 divergence trap).
    const owned = liveTerminalOwner(store, uuid) !== null;
    drive = {
      state: 'observing',
      supported: true,
      ...(owned ? { willFork: true } : {}),
      reason: owned
        ? 'A terminal is attached to this session right now. Driving will continue in a FORK (new uuid) so two owners never write the same transcript — quit the terminal first to drive the same session in place.'
        : store.isDefault
          ? 'Driving resumes this session via claude -p --resume on your Claude subscription (no API cost).'
          : `Driving runs ${store.model ?? 'this wrapper'} on its own endpoint.`,
    };
  }
  // Claude channel true-sync is unsupported: current runtime evidence only honors permission replies from
  // allowlisted channels, so our channel can display but not control (see
  // docs/protocol/adapter-support.md, Claude control boundary). terminalSync is therefore always
  // unsupported; Claude control = Observe + Drive. (channelsEligible still tunes the explanatory reason.)
  let terminalSync: SessionTerminalSync;
  if (bridged) {
    terminalSync = {
      supported: false,
      syncAvailable: false,
      active: false,
      reason: `Under Claude Remote Control (mobile/web) — observed only from ${PRODUCT_IDENTITY.productName}; use Drive to take over.`,
    };
  } else {
    terminalSync = {
      supported: false,
      syncAvailable: false,
      active: false,
      // Claude has no live terminal sync (channel sync archived), but a terminal CAN rejoin this
      // conversation by resuming it. Provide that command GENERICALLY (label + command) so the app's
      // "sync your terminal" tip needs no `tool === 'claude'` branch — it just renders `command`. The
      // uuid here is the base session id; the live connection refreshes it to the fork uuid on the
      // single-owner-safety fork (issues-part2), so the tip always targets the conversation the app drives.
      label: 'Resume in terminal',
      command: claudeResumeTerminalCommand(uuid, cwd),
      // Packaged v1 deliberately exposes no hook setup or live-sync promise. The source-only hooks
      // overlay remains a contributor harness; product control is Observe + Take over.
      reason: channelsEligible
        ? 'Claude v1 supports Observe + Take over; live terminal sync is unavailable.'
        : 'Claude v1 supports Observe + Take over' +
          (store.model ? ` and this is a ${store.model} wrapper session` : '') +
          '; live terminal sync is unavailable.',
    };
  }
  return { drive, terminalSync };
}

/**
 * Argv for a resume launch. Exported so tests can assert cost safety (`--bare` is forbidden) and the
 * live-owner guard: unowned sessions resume in place; terminal-owned sessions fork.
 */
export function resumeArgs(uuid: string, opts: { model?: string; mode?: string; effort?: string; isDefault: boolean; fresh?: boolean; fork?: boolean }): string[] {
  // A brand-new (broker-created) session has no transcript yet: START it with `--session-id <uuid>`
  // (Claude creates the conversation under that exact id), NOT `--resume` (which needs an existing one)
  // and without `--fork-session` (nothing to fork). An existing session resumes and forks (single-owner
  // safe). Verified on a free wrapper: `--session-id <new-uuid>` creates the transcript, `--resume` then
  // drives it.
  // --permission-prompt-tool stdio: WITHOUT it, headless -p never asks — a gated tool is silently
  // auto-denied ("This command requires approval" tool error) and the app shows NO permission popup
  // (issues-part2 13.1: "drive mode still broken -> no permission popup for tools"; probed live on
  // 2.1.207: bare spawn = silent deny, with the flag = control_request/can_use_tool that blocks
  // until our control_response). The existing control_request handler was dead code until this flag.
  const args = opts.fresh
    ? ['-p', '--session-id', uuid, '--output-format', 'stream-json', '--input-format', 'stream-json', '--include-partial-messages', '--verbose', '--permission-prompt-tool', 'stdio']
    : ['-p', '--resume', uuid, ...(opts.fork ? ['--fork-session'] : []), '--output-format', 'stream-json', '--input-format', 'stream-json', '--include-partial-messages', '--verbose', '--permission-prompt-tool', 'stdio'];
  // Model: the default store sends an alias (opus/sonnet/haiku); a wrapper sends one of its OWN discovered
  // backend models (claude-mi pro vs non-pro), so pass --model for BOTH so a wrapper can switch among them.
  if (opts.model) args.push('--model', opts.model);
  // Reasoning effort, CLAMPED to the chosen model's set. Applies to the default store AND wrappers — the
  // Anthropic-compatible wrapper endpoints (minimax/mimo) accept `--effort`/`--settings` (verified live);
  // an unknown wrapper model clamps to "supported" (modelSupportsEffort → true) so the endpoint decides.
  // ULTRACODE is special: it is NOT a valid `--effort` value (the launch flag warns + ignores it — confirmed
  // on minimax) — it's xhigh + a session orchestration flag enabled via the `--settings {ultracode:true}`
  // launch flag (belt-and-suspenders with `--effort xhigh`, which ultracode implies). Sonnet/Haiku reject
  // ultracode → clamped out (neither flag emitted). Cost-safety is unaffected (it lives in resumeEnv).
  if (opts.effort) {
    if (opts.effort === 'ultracode') {
      if (modelSupportsEffort(opts.model ?? 'opus', 'ultracode')) args.push('--settings', JSON.stringify({ ultracode: true }), '--effort', 'xhigh');
    } else if (modelSupportsEffort(opts.model ?? 'opus', opts.effort)) {
      args.push('--effort', opts.effort);
    }
  }
  if (opts.mode) args.push('--permission-mode', opts.mode);
  return args;
}

/**
 * Child env for a resume launch. COST SAFETY: the DEFAULT store must drive on the user's Claude
 * subscription (OAuth). A stray `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` in the broker env out-ranks
 * subscription OAuth and would SILENTLY bill the API for every driven turn — so scrub both for the
 * default store only. Wrappers (claude-open/claude-mi/…) re-export their OWN base-url + auth token via
 * `exec claude "$@"` to reach their free/local endpoint, so their inherited env MUST stay intact.
 */
export function resumeEnv(store: ClaudeStore, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, CLAUDE_CONFIG_DIR: store.configDir };
  if (store.isDefault) {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  return env;
}

/** Read `VAR="value"` / `VAR=value` (last assignment wins) from a wrapper script's text. The `\b`
 *  anchor stops a short name from matching inside a longer one (e.g. `MODEL` vs `ANTHROPIC_MODEL` —
 *  `_M` is not a word boundary, so `\bMODEL` won't match there). */
function matchEnv(txt: string, name: string): string | undefined {
  const re = new RegExp(`(?:export\\s+)?\\b${name}=("[^"]*"|'[^']*'|[^\\s#]+)`, 'g');
  let m: RegExpExecArray | null;
  let val: string | undefined;
  while ((m = re.exec(txt))) val = m[1]!.replace(/^["']|["']$/g, '');
  return val && val.trim() ? val.trim() : undefined;
}

/** Follow one chain of shell-var indirection to a literal: `$VAR`/`${VAR}` → its assignment in the script,
 *  `${VAR:-literal}` → the default literal. e.g. `ANTHROPIC_MODEL="$OPUS_MODEL"` →
 *  `OPUS_MODEL="${CLAUDE_LOCAL_OPUS_MODEL:-mimo-v2.5-pro[1m]}"` → `mimo-v2.5-pro[1m]`. Shared by the single-
 *  and multi-model wrapper resolvers. (Single-level only — documented limit.) */
function resolveShellLiteral(txt: string, start: string | undefined): string | undefined {
  let v = start;
  for (let i = 0; i < 5 && v; i++) {
    const dflt = /^\$\{?[A-Za-z_][A-Za-z0-9_]*:-([^}]+)\}?$/.exec(v); // ${VAR:-default}
    if (dflt) {
      v = dflt[1]!.trim(); // the default may itself be "$OTHER" (claude-nv) — keep resolving
      continue;
    }
    const ref = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(v); // $VAR / ${VAR} → follow the assignment
    if (ref) {
      v = matchEnv(txt, ref[1]!);
      continue;
    }
    break; // a plain literal
  }
  const lit = v?.trim();
  // Still a shell expression after 5 hops → unresolvable here; a "$VAR" string is useless in a picker.
  return lit && !lit.includes('$') ? lit : undefined;
}

/** A wrapper's PRIMARY model literal (roster label + currentModel seed): ANTHROPIC_MODEL, or the OPUS default. */
function resolveWrapperModel(txt: string): string | undefined {
  return resolveShellLiteral(txt, matchEnv(txt, 'ANTHROPIC_MODEL') ?? matchEnv(txt, 'ANTHROPIC_DEFAULT_OPUS_MODEL'));
}

/** All DISTINCT backend models a wrapper exposes via its ANTHROPIC_*_MODEL alias mappings (order-preserving,
 *  deduped). A wrapper that maps opus→pro and haiku→non-pro (e.g. claude-mi: ANTHROPIC_DEFAULT_OPUS_MODEL=
 *  mimo-v2.5-pro[1m], ANTHROPIC_DEFAULT_HAIKU_MODEL=mimo-v2.5[1m]) therefore offers BOTH as switchable picker
 *  entries, not just the primary. The default store ignores this (it uses the curated catalog). */
const WRAPPER_MODEL_ENVS = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL'];
export function resolveWrapperModels(txt: string): string[] {
  const out: string[] = [];
  for (const env of WRAPPER_MODEL_ENVS) {
    const lit = resolveShellLiteral(txt, matchEnv(txt, env));
    if (lit && !out.includes(lit)) out.push(lit);
  }
  return out;
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p.replace(/^\$\{?HOME\}?\/?/, (mm) => homedir() + (mm.endsWith('/') ? '/' : '/'));
}

const enc = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const dec = (s: string): string => Buffer.from(s, 'base64url').toString('utf8');

/**
 * Resolve a decoded Claude session path to its REAL (symlink-free) location and require it to sit inside a
 * known store's `projectsRoot`, returning that resolved path. A pure `resolve()` string check + `statSync`
 * (which FOLLOWS symlinks) would let a planted symlink — `projects/<slug>/x.jsonl → ~/.ssh/id_rsa` — pass
 * every guard and be read/exported (Fable review 2026-07-08, finding #1). `realpathSync` on the source AND
 * the roots closes that. When the file is MISSING (a legitimate not-yet-written session, e.g. a freshly
 * `--session-id`-created transcript before its first turn) there is no symlink to resolve, so fall back to
 * a string-resolve containment — a nonexistent path cannot exfiltrate anything. Throws if it resolves
 * outside every root. Callers that require existence (export) check that separately.
 */
function containedClaudePath(rawPath: string): string {
  const resolved = realOrResolve(rawPath);
  const inside = claudeStores().some((s) => {
    const root = realOrResolve(s.projectsRoot);
    return resolved === root || resolved.startsWith(root + sep);
  });
  if (!inside) throw new Error('Claude session id resolves outside the known projects roots.');
  return resolved;
}

/** The canonical Claude session id = base64url of the transcript path (see discoverSessions/attach). The
 *  broker-side hooks bridge needs the SAME encoding so a hook-relayed session matches its roster row. */
export function claudeSessionId(transcriptPath: string): string {
  return enc(transcriptPath);
}
export function claudeTranscriptPath(sessionId: string): string {
  return dec(sessionId);
}

/** Defense-in-depth for the broker's hook endpoints (which accept a transcriptPath from an in-session hook):
 *  accept ONLY an absolute `…/<uuid>.jsonl` that resolves INSIDE a known Claude projects root — the same
 *  allowlist `attach()` enforces (delegates to `containedClaudePath`, so symlinks are realpath-resolved; a
 *  planted `projects/<slug>/x.jsonl → outside` symlink is refused before the hooks conn tails/broadcasts
 *  it, unredacted — Fable review 2026-07-09). Blocks path traversal / arbitrary-file reads on a
 *  tailnet-exposed broker. A missing file stays allowed (SessionStart can fire before the JSONL exists;
 *  the observe conn tails lazily and a nonexistent path cannot exfiltrate anything). */
export function isClaudeTranscriptPathAllowed(path: string): boolean {
  if (typeof path !== 'string' || !path || !path.endsWith('.jsonl')) return false;
  try {
    containedClaudePath(path);
    return true;
  } catch {
    return false;
  }
}

// ── Live-sync HOOK install (Tier-1 control; replaces the archived claude/channel) ───────────────────────
/** The in-session hook script (PreToolUse/SessionStart/SessionEnd). Relays prompts/questions to the broker. */
export const CLAUDE_HOOK_SCRIPT = join(import.meta.dir, '..', 'hook', 'cosyncing-hook.ts');
/** Stable marker (a substring of every hook command) so install is idempotent and uninstall is exact. */
export const CLAUDE_HOOK_LEGACY_MARKER = 'cosyncing-hook';
/** Only spawn the hook for tools that actually prompt (+ AskUserQuestion) — avoids per-Read overhead. The
 *  hook still re-checks the sensitive set + permission_mode internally as a safety net. */
const HOOK_TOOL_MATCHER = 'Bash|Edit|Write|MultiEdit|NotebookEdit|Update|WebFetch|AskUserQuestion';

/** Where the hook settings live — the chosen store's configDir/settings.json (default `~/.claude`). */
export function claudeHooksSettingsPath(store?: ClaudeStore): string {
  const s = store ?? claudeStores().find((x) => x.isDefault) ?? claudeStores()[0];
  return join(s?.configDir ?? join(homedir(), '.claude'), 'settings.json');
}
function readSettingsJson(path: string): Record<string, any> {
  try { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>; } catch { return {}; }
}
function hookEntryFor(bun: string, brokerUrl: string, mode: string, matcher?: string, timeout?: number, token?: string): any {
  const tokenEnv = token ? `COSYNCING_TOKEN=${JSON.stringify(token)} ` : '';
  const command = `COSYNCING_BROKER=${JSON.stringify(brokerUrl)} ${tokenEnv}${JSON.stringify(bun)} ${JSON.stringify(CLAUDE_HOOK_SCRIPT)} ${mode}`;
  const entry: any = { hooks: [{ type: 'command', command, ...(timeout ? { timeout } : {}) }] };
  if (matcher) entry.matcher = matcher;
  return entry;
}
function withoutOurHooks(arr: unknown): any[] {
  return (Array.isArray(arr) ? arr : []).filter((e: any) => !(Array.isArray(e?.hooks) && e.hooks.some((h: any) => String(h?.command ?? '').includes(CLAUDE_HOOK_LEGACY_MARKER))));
}

export interface LegacyClaudeHookInspection {
  status: 'absent' | 'legacy-marker' | 'unreadable';
  path: string;
  entryCount: number;
  requiresConfirmation: boolean;
}

/**
 * Read-only BPC2 ownership classifier. Claude hooks are absent from the v1 package, so there is no package
 * hash that can prove ownership: the repo-era marker is secondary evidence and always requires confirmation.
 * Commands may contain a legacy shared token, so this report deliberately returns only a count.
 */
export function inspectLegacyClaudeHooks(settingsPath = claudeHooksSettingsPath()): LegacyClaudeHookInspection {
  if (!existsSync(settingsPath)) {
    return { status: 'absent', path: settingsPath, entryCount: 0, requiresConfirmation: false };
  }
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, any>;
    let entryCount = 0;
    for (const entries of Object.values(settings?.hooks ?? {})) {
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (Array.isArray(entry?.hooks) && entry.hooks.some((hook: any) =>
          String(hook?.command ?? '').includes(CLAUDE_HOOK_LEGACY_MARKER))) {
          entryCount += 1;
        }
      }
    }
    return entryCount > 0
      ? { status: 'legacy-marker', path: settingsPath, entryCount, requiresConfirmation: true }
      : { status: 'absent', path: settingsPath, entryCount: 0, requiresConfirmation: false };
  } catch {
    return { status: 'unreadable', path: settingsPath, entryCount: 0, requiresConfirmation: true };
  }
}

/** Install the cosyncing live-sync hooks into the user's Claude settings (idempotent — replaces any
 *  prior cosyncing entries). After this, every claude session the user starts becomes Tier-1
 *  sync-controllable from the phone (answer permission prompts + questions), no channel allowlist needed. */
export function installClaudeHooks(opts: { brokerUrl: string; bun?: string; settingsPath?: string; token?: string }): { path: string } {
  const path = opts.settingsPath ?? claudeHooksSettingsPath();
  const bun = opts.bun ?? process.execPath;
  const token = opts.token ?? process.env.COSYNCING_TOKEN?.trim() ?? undefined;
  // Never clobber a settings file we can't parse: returning {} on a parse error (readSettingsJson) and writing
  // it back would erase ALL the user's real settings. Abort instead. (Review finding 2026-06-23: data-loss.)
  const settings = readSettingsJsonStrict(path);
  settings.hooks ??= {};
  settings.hooks.PreToolUse = [...withoutOurHooks(settings.hooks.PreToolUse), hookEntryFor(bun, opts.brokerUrl, 'request', HOOK_TOOL_MATCHER, 300, token)];
  settings.hooks.SessionStart = [...withoutOurHooks(settings.hooks.SessionStart), hookEntryFor(bun, opts.brokerUrl, 'hello', undefined, 10, token)];
  settings.hooks.SessionEnd = [...withoutOurHooks(settings.hooks.SessionEnd), hookEntryFor(bun, opts.brokerUrl, 'bye', undefined, 10, token)];
  // Turn-boundary status (live spinner on the synced session): UserPromptSubmit → working, Stop → idle.
  settings.hooks.UserPromptSubmit = [...withoutOurHooks(settings.hooks.UserPromptSubmit), hookEntryFor(bun, opts.brokerUrl, 'working', undefined, 10, token)];
  settings.hooks.Stop = [...withoutOurHooks(settings.hooks.Stop), hookEntryFor(bun, opts.brokerUrl, 'idle', undefined, 10, token)];
  writeSettingsJsonAtomic(path, settings);
  return { path };
}

/** Like readSettingsJson but THROWS on a malformed existing file (so a caller about to rewrite the file does
 *  not silently discard the user's real settings). Missing file → {}. */
function readSettingsJsonStrict(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch (e) { throw new Error(`cannot read Claude settings ${path}: ${String(e)}`); }
  if (!raw.trim()) return {};
  try { return JSON.parse(raw) as Record<string, any>; }
  catch (e) { throw new Error(`refusing to overwrite unparseable Claude settings ${path} (${String(e)}); fix or remove it first`); }
}

/** Atomic settings write: back up the prior file to <path>.bak, write to a temp file, then rename into place
 *  so a crash mid-write can't truncate the user's settings. */
function writeSettingsJsonAtomic(path: string, settings: Record<string, any>): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) { try { copyFileSync(path, path + '.bak'); } catch { /* best-effort backup */ } }
  const tmp = path + '.tmp-' + process.pid;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  renameSync(tmp, path);
}

/** Remove the cosyncing live-sync hooks from the user's Claude settings (leaves other hooks intact). */
export function uninstallClaudeHooks(opts?: { settingsPath?: string }): { path: string; changed: boolean } {
  const path = opts?.settingsPath ?? claudeHooksSettingsPath();
  if (!existsSync(path)) return { path, changed: false };
  const settings = readSettingsJson(path);
  let changed = false;
  for (const event of Object.keys(settings.hooks ?? {})) {
    const filtered = withoutOurHooks(settings.hooks[event]);
    if (filtered.length !== (Array.isArray(settings.hooks[event]) ? settings.hooks[event].length : 0)) {
      changed = true;
      if (filtered.length) settings.hooks[event] = filtered;
      else delete settings.hooks[event];
    }
  }
  if (changed) writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
  return { path, changed };
}

/** True if our hooks are currently installed in the given settings file. */
export function claudeHooksInstalled(settingsPath?: string): boolean {
  const path = settingsPath ?? claudeHooksSettingsPath();
  const settings = readSettingsJson(path);
  return Object.values(settings.hooks ?? {}).some((arr) => withoutOurHooks(arr).length !== (Array.isArray(arr) ? arr.length : 0));
}

export class ClaudeAdapter implements AgentBackend {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';
  readonly capabilities = CAPS;
  readonly transcriptExportFormat = 'json' as const;
  /** uuid → create-time state for DEFERRED sessions (createSession writes no transcript; the first
   *  drive turn materializes it). attach() normally reads cwd/model from the transcript — which does
   *  not exist yet here. Keep the exact optional selection until that first launch so scheduled
   *  creation cannot silently fall back to Claude's defaults. In-memory is sufficient: the virtual
   *  row itself only lives until a broker restart. FIFO-bounded below. */
  private readonly pendingCreates = new Map<string, { cwd: string; model?: PromptInput['model'] }>();

  async isAvailable(): Promise<boolean> {
    return claudeStores().some((s) => existsSync(s.projectsRoot)) || resolveBin('claude') !== null;
  }

  async diagnoseSetup(context: SetupDiagnosisContext): Promise<AgentSetupDiagnosis> {
    return diagnoseClaudeSetup(context, {
      inspectLegacyHooks: inspectLegacyClaudeHooks,
    });
  }

  /**
   * Gated R2 transcriptExport (the Slice-6 export pipeline). Claude has no native export command — the
   * session JSONL IS the transcript — so we copy it into the broker-owned `opts.tempDir` and let the
   * broker's mandatory redaction pass + `export-attachment` delivery do the rest (generic, no
   * Claude-specific broker code). Path-contained to a known Claude store root (the SAME guard as
   * `attach`) so a crafted id cannot exfiltrate an arbitrary file; size-guarded before the copy.
   * Subagent transcripts (the sibling `<uuid>/subagents` tree) are NOT included — main transcript only.
   */
  async exportTranscript(
    sessionId: string,
    opts: { tempDir: string; maxBytes: number; timeoutMs: number },
  ): Promise<{ path: string; format: 'json' }> {
    // realpath-resolved + root-contained (rejects a symlink to a secret; Fable review 2026-07-08 #1).
    // Export REQUIRES existence, so a missing file (helper's string-fallback branch) is rejected here.
    const r = containedClaudePath(dec(sessionId));
    if (!r.endsWith('.jsonl') || !existsSync(r)) throw new Error('Claude transcript file not found.');
    const st = statSync(r);
    if (!st.isFile()) throw new Error('Claude transcript path is not a regular file.');
    if (st.size > opts.maxBytes) throw new Error('Claude transcript exceeds the export size cap.');
    // The `.json` artifact carries newline-delimited JSON (JSONL) — Claude's native transcript format;
    // it is a text download, not a single JSON document (Fable review #4, accepted as-is with this note).
    const outPath = join(opts.tempDir, 'export.json');
    copyFileSync(r, outPath); // copies the realpath-resolved source (no symlink re-follow)
    return { path: outPath, format: 'json' };
  }

  /** Creatable when the default (subscription) store's bin resolves. One 'Claude Code' agent → the
   *  user's real subscription; wrapper stores are not offered for create. */
  canCreateSession(): boolean {
    const store = defaultStore();
    return !!store && resolveBin(store.bin) !== null;
  }

  /** Curated alias catalog; Claude Code has no complete zero-turn model-list command. */
  async listModels(): Promise<ModelOption[]> {
    const store = defaultStore();
    return store ? claudeModelOptions(store) : [];
  }

  /** Create a brand-new Claude session WITHOUT a prompt or any model turn (zero cost): allocate a fresh
   *  session uuid and its predicted transcript path under the default store. The transcript is
   *  materialized lazily on the first Drive turn — ClaudeResumeConnection's first launch uses
   *  `--session-id <uuid>` (see {@link resumeArgs} `fresh`), then resumes normally. So the row is
   *  drivable immediately; it just isn't on disk (won't survive a broker restart or appear in a roster
   *  refresh) until that first turn runs. Claude has no zero-turn "create empty session" CLI path
   *  (verified: closing stdin with no turn writes no transcript), so deferred materialization is the
   *  no-prompt option. */
  async createSession(opts: { directory?: string; title?: string; model?: PromptInput['model'] } = {}): Promise<SessionInfo> {
    const store = defaultStore();
    if (!store) throw new Error('No default Claude store available to create a session.');
    if (resolveBin(store.bin) === null) throw new Error(`Claude CLI (${store.bin}) is not on PATH; cannot create a session.`);
    const cwd = opts.directory?.trim() || homedir();
    if (!existsSync(cwd)) throw new Error(`Claude createSession directory does not exist: ${cwd}`);
    const uuid = randomUUID();
    const path = join(store.projectsRoot, slugForCwd(cwd), `${uuid}.jsonl`);
    this.pendingCreates.set(uuid, {
      cwd,
      ...(opts.model
        ? {
            model: {
              providerID: opts.model.providerID,
              modelID: opts.model.modelID,
              ...(opts.model.reasoningEffort ? { reasoningEffort: opts.model.reasoningEffort } : {}),
            },
          }
        : {}),
    });
    while (this.pendingCreates.size > CLAUDE_MAX_PENDING_CREATES) {
      const oldest = this.pendingCreates.keys().next().value;
      if (oldest === undefined) break;
      this.pendingCreates.delete(oldest);
    }
    const eligible = eligibleForChannels(store, cwd);
    const now = Date.now();
    return {
      id: enc(path),
      tool: this.id,
      title: opts.title?.trim() || basename(cwd) || 'Claude session',
      cwd,
      ...(opts.model
        ? {
            model: opts.model.modelID,
            currentModel: {
              providerID: opts.model.providerID,
              modelID: opts.model.modelID,
              ...(opts.model.reasoningEffort ? { reasoningEffort: opts.model.reasoningEffort } : {}),
            },
          }
        : {}),
      status: 'idle',
      // Observe is the safe default row; the app's Drive affordance reattaches with ?mode=resume, which
      // cold-launches the session for real.
      attachMode: 'observe',
      createdAt: now,
      updatedAt: now,
      control: claudeControl({ store, uuid, cwd, bridged: false, driving: false, channelsEligible: eligible }),
    };
  }

  watchSessionInfo(onChange: (info: SessionInfo) => void): Unsubscribe {
    const watchers: FSWatcher[] = [];
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const refresh = (store: ClaudeStore, uuid?: string): void => {
      const key = `${store.configDir}\0${uuid ?? '*'}`;
      const prev = timers.get(key);
      if (prev) clearTimeout(prev);
      timers.set(key, setTimeout(() => {
        timers.delete(key);
        void this.discoverSessions()
          .then((sessions) => {
            for (const s of sessions) {
              let path = '';
              try {
                path = dec(s.id);
              } catch {
                continue;
              }
              if (storeForPath(path).configDir !== store.configDir) continue;
              const sessionUuid = basename(path).replace(/\.jsonl$/, '');
              if (uuid && sessionUuid !== uuid) continue;
              onChange(s);
            }
          })
          .catch(() => {});
      }, 80));
    };
    for (const store of claudeStores()) {
      const dir = join(store.configDir, 'cosyncing', 'bridge');
      try {
        mkdirSync(dir, { recursive: true });
        const watcher = watch(dir, (_event, filename) => {
          const name = filename == null ? '' : String(filename);
          if (name && !name.endsWith('.sock')) return;
          refresh(store, name ? name.replace(/\.sock$/, '') : undefined);
        });
        watcher.on('error', () => {
          try {
            watcher.close();
          } catch {
            /* ignore */
          }
        });
        watchers.push(watcher);
      } catch {
        /* fs.watch unavailable for this store; roster polling remains the slow fallback */
      }
    }
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          /* ignore */
        }
      }
    };
  }

  async discoverSessions(options?: SessionDiscoveryOptions): Promise<SessionInfo[]> {
    const out: SessionInfo[] = [];
    const now = Date.now();
    let scannedFiles = 0;
    // Scan EVERY store: the official ~/.claude plus each wrapper's CLAUDE_CONFIG_DIR (claude-mi,
    // claude-minimax, …). Without this, ~729 wrapper sessions are invisible. (Issue D.)
    for (const store of claudeStores()) {
      if (!existsSync(store.projectsRoot)) continue;
      const live = await liveStatusByStore(store); // per-store `<bin> agents --json` overlay (no model cost)
      const incarnations = nativeIncarnations(store);
      const bridged = bridgedUuids(store); // uuids Anthropic's own remote-control owns → Drive unavailable
      const syncedSet = syncedUuids(store); // uuids with a live claude/channel bridge socket
      // True-sync eligibility depends on the session's cwd (project .claude/settings.json outranks user
      // settings), so it's per-row — cache by cwd (most sessions share a few cwds) to bound the file reads.
      const eligByCwd = new Map<string, boolean>();
      const eligibleFor = (c?: string): boolean => {
        const key = c ?? '';
        let e = eligByCwd.get(key);
        if (e === undefined) { e = eligibleForChannels(store, c); eligByCwd.set(key, e); }
        return e;
      };
      let slugs: string[];
      try {
        slugs = readdirSync(store.projectsRoot);
      } catch {
        continue;
      }
      for (const slug of slugs) {
        const slugDir = join(store.projectsRoot, slug);
        let entries: import('node:fs').Dirent[];
        try {
          entries = readdirSync(slugDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const ent of entries) {
          // DEPTH-1 files only: a `.jsonl` directly under the slug dir is a session. Sub-agent
          // transcripts live at `<slug>/<uuid>/subagents/agent-*.jsonl` (ent.isFile() === false for
          // the `<uuid>` directory), so this naturally excludes them — never recurse here.
          if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
          // Cold authority recovery yields every 128 KiB. This outer yield still bounds metadata/
          // title work across many small transcripts that resolve without a long authority scan.
          if (++scannedFiles % 25 === 0) await new Promise((r) => setTimeout(r, 0));
          const full = join(slugDir, ent.name);
          const st = statSafe(full);
          if (!st) continue;
          const uuid = ent.name.replace(/\.jsonl$/, '');
          const registryIncarnation = incarnations.bySessionId.get(uuid);
          const nativeId = registryIncarnation?.nativeId ?? transcriptNativeBridgeId(full);
          const currentIncarnation = nativeId
            ? incarnations.currentByNativeId.get(nativeId)
            : undefined;
          // A live registry entry binds the exact bridge identity to one source generation. Retire
          // every transcript incarnation of that bridge except the selected native session before
          // it can become a roster row. No fuzzy metadata participates in this decision.
          if (currentIncarnation && currentIncarnation.sessionId !== uuid) {
            rememberNativeSelector(store, currentIncarnation);
            continue;
          }
          const raw = live.get(uuid)?.status;
          // Preserve the existing bounded incremental scan: only recent files or sessions with
          // current native live authority are decoded. A cold discovery has no cutoff and rebuilds
          // exact transcript authority for every row.
          if (
            options?.updatedAfter !== undefined &&
            st.mtimeMs < options.updatedAfter &&
            raw !== 'working' &&
            raw !== 'needs-input'
          ) {
            continue;
          }
          options?.onWork?.({ kind: 'decode-file', source: full });
          const { cwd, firstUser, firstUserUuid, model: headModel } = readHeadInfo(full);
          // CURRENT model = the latest assistant turn (tail), not the model the session was BORN on
          // (head). A long-lived session started on opus-4-6 and since continued on opus-4-8 must be
          // labelled by what it runs NOW. Falls back to the head model when the tail has none yet.
          const model = readLatestModel(full) ?? headModel;
          const title = readTitle(full) ?? firstUser ?? (cwd ? basename(cwd) : uuid.slice(0, 8));
          // Exact transcript turn evidence prevents freshness from expiring a LIVE foreground tool.
          // It cannot manufacture a live process: an abandoned transcript with no matching
          // `agents --json` row is idle even if its final durable record was a tool_use.
          const conversationTs = lastConversationTs(full) ?? st.mtimeMs;
          const status = await claudeSessionStatus(full, raw, now);
          out.push({
            id: enc(full), // base64url of the transcript path — attach re-opens the exact file (like Codex/Pi)
            lineageId: firstUserUuid,
            tool: this.id,
            ...(nativeId ? { nativeId } : {}),
            title,
            cwd,
            // Label by the producing model so wrapper sessions read e.g. 'MiniMax-M3' (Issue D).
            model: store.isDefault ? model : store.model,
            status,
            // Drivable now: resume is available, but observe is the SAFE default shown in the roster
            // (opening never spends quota); the UI's "Drive" affordance reattaches with ?mode=resume.
            attachMode: 'observe',
            // Explicit Observe+Drive / True-Sync state (the app renders from this, never from attachMode).
            control: (() => {
              const eligible = eligibleFor(cwd); // first-party (incl. project-settings) check, cwd-cached
              // channel sync archived → a live socket no longer flips terminalSync.active (syncedSet dormant).
              return claudeControl({ store, uuid, cwd, bridged: bridged.has(uuid), channelsEligible: eligible });
            })(),
            updatedAt: conversationTs,
          });
        }
      }
    }
    return out;
  }

  async attach(sessionId: string, mode?: AttachMode): Promise<SessionConnection> {
    // Defense-in-depth: ids only ever come from discoverSessions (within some store's projectsRoot), but
    // refuse to open a path outside EVERY known store root so a crafted id can't read arbitrary files.
    // realpath-resolves symlinks so a planted symlink to a secret is rejected (Fable review 2026-07-08 #1).
    const path = containedClaudePath(dec(sessionId));

    const store = storeForPath(path);
    const head = readHeadInfo(path);
    const attachUuid = basename(path).replace(/\.jsonl$/, '');
    // A deferred create has no transcript head to read cwd from — recover the create-time cwd (map),
    // else fall back to home when the project slug provably encodes it (slug round-trip), so the
    // first drive turn can NEVER launch in the broker's own working directory.
    const pending = existsSync(path) ? undefined : this.pendingCreates.get(attachUuid);
    const cwd = head.cwd
      ?? (existsSync(path)
        ? undefined
        : pending?.cwd
          ?? (basename(dirname(path)) === slugForCwd(homedir()) ? homedir() : undefined));
    // CURRENT model = latest assistant turn (tail), not head.model (the model the session was BORN on).
    // This both labels the row correctly and seeds currentModel — which a cold-start drive reasserts as
    // `--model` (doc-12), so a stale head value would actively pin the session back to its old model. A
    // wrapper stores can also record the concrete runtime model in the transcript tail; use it when present
    // instead of the wrapper's primary/default model.
    const liveModel = readLatestModel(path) ?? (store.isDefault ? head.model : store.model) ?? pending?.model?.modelID;
    const uuid = attachUuid;
    const incarnation = nativeIncarnations(store).bySessionId.get(uuid);
    const nativeId = incarnation?.nativeId ?? transcriptNativeBridgeId(path);
    const bridged = bridgedUuids(store).has(uuid);
    // Channel true-sync is unsupported (see docs/protocol/adapter-support.md): a live bridge socket no longer promotes a
    // session to 'live'/synced. Claude attaches as resume (explicit take-over) or read-only observe.
    // `eligible` still tunes the control reason text (first-party check incl. this session's project settings).
    const eligible = eligibleForChannels(store, cwd);
    const info: SessionInfo = {
      id: sessionId,
      lineageId: head.firstUserUuid,
      tool: this.id,
      ...(nativeId ? { nativeId } : {}),
      title: readTitle(path) ?? (cwd ? basename(cwd) : basename(path)),
      cwd,
      model: liveModel,
      // currentModel is resolved-session identity, not the curated selection alias. A later selection may
      // still use `opus`, while a running session honestly reports the concrete id Claude emitted.
      currentModel: liveModel
        ? {
            providerID: pending?.model?.modelID === liveModel
              ? pending.model.providerID
              : store.isDefault ? 'anthropic' : 'wrapper',
            modelID: String(liveModel),
            ...(pending?.model?.modelID === liveModel && pending.model.reasoningEffort
              ? { reasoningEffort: pending.model.reasoningEffort }
              : {}),
          }
        : undefined,
      status: 'idle',
      attachMode: mode === 'resume' ? 'resume' : 'observe',
      // Explicit control state (never inferred from attachMode by the UI). Resume = driving; a
      // remote-controlled/cwd-gone session is unavailable for Drive. Channel sync is archived.
      control: claudeControl({ store, uuid, cwd, bridged, driving: mode === 'resume', channelsEligible: eligible }),
    };
    if (mode === 'resume') return new ClaudeResumeConnection(store, path, info);
    // Observe: surface WHY a session is blocked (its `<bin> agents --json` waiting reason) so the app
    // can render the real on-disk question, or an honest read-only notice, instead of a silent transcript. (Issue G.)
    const liveRow = (await liveStatusByStore(store)).get(uuid);
    // Use the same exact transcript authority as discovery so roster and Session Detail cannot
    // disagree at attach time. File freshness is only the no-open-turn fallback.
    const st = statSafe(path);
    if (st) {
      info.status = await claudeSessionStatus(path, liveRow?.status, Date.now());
    }
    return new ClaudeObserveConnection(path, info, liveRow?.waitingFor);
  }
}

/**
 * Read-only observe connection: replays the transcript as history and live-follows appended lines.
 * model-output/thinking/user-message dedupe by `uuid` key; tool-call/tool-result by `callId`.
 *
 * History ⟷ live partition cleanly with NO overlap and NO gap: `getHistory()` does the single file
 * read, maps every COMPLETE line up to the last-newline boundary `B`, and (on the first call) baselines
 * the tail at `B` while seeding the connection's tool_use_id→name map + seen-message.id set from those
 * same lines. The tail stays INERT until that baseline (`primed`), so it only ever emits lines after
 * `B`. This fixes (a) the attach-window race that double-emitted keyless error/history-reset/token-count,
 * (b) mid-append line loss (a partial trailing line is excluded from history and re-read whole by the
 * tail once its newline lands), and (c) the old double full-read (the constructor no longer slurps).
 */
export class ClaudeObserveConnection implements SessionConnection {
  private readonly handlers = new Set<AgentMessageHandler>();
  private watcher?: FSWatcher;
  private offset = 0; // bytes consumed by the live tail (baselined by getHistory)
  private tailBuf = '';
  private primed = false; // the tail is inert until getHistory() baselines the offset + seeds
  /** tool_use_id → tool name (+input), so a tool-result can recover its toolName (+ a file path). */
  private readonly callMeta = new Map<string, ClaudeCall>();
  /** message.id values already emitted as token-count (usage repeats per line of a turn). */
  private readonly seenTokenIds = new Set<string>();
  /** Mid-run queued sends pending delivery (seeded from history, consumed by the tail) — lets the
   *  delivering user line reuse its enqueue bubble's key so the queued styling clears in place. */
  private readonly queuedSends = newClaudeQueuedSends();
  /** Auto-surfaced subagent/workflow progress cards + the parent-answered tool_use_ids that mark a
   *  subagent 'done' (seeded from history, kept current by the tail). */
  private activity?: ClaudeActivityWatcher;
  private readonly resolvedToolUseIds = new Set<string>();
  private readonly backgroundToolUseIds = new Set<string>();
  private readonly notifiedToolUseIds = new Set<string>();
  private readonly backgroundSpawnMs = new Map<string, number>();
  private readonly killedAgentIds = new Set<string>();
  private readonly agentIdToToolUseId = new Map<string, string>();
  private readonly stopRequests = new Map<string, string>();
  /** Per-turn runtime/timestamp derivation (doc-15). Recreated each getHistory (idempotent run-summary keys),
   *  then advanced by the live tail so a completing turn flips running→done as the next prompt lands. */
  private runtime?: ClaudeRuntimeTracker;
  /** TaskCreate/TaskUpdate accumulator → the upserted task-list-state panel. Recreated each getHistory
   *  (seeded from the full replay), then advanced by the live tail — same lifecycle as `runtime`. */
  private taskLedger?: ClaudeTaskLedger;
  /** Per-message.id content-block ordinals. Recreated each getHistory (recounted from the whole file),
   *  then advanced by the tail — a sibling line of a message whose earlier blocks were already in history
   *  must continue that message's count, or the tail and a fresh history read key it differently and the
   *  duplicate this identity removes comes back on the tail side. Same lifecycle as `runtime`. */
  private blockOrdinals = newClaudeBlockOrdinals();

  /** Streaming decoder so a line flushed mid-multibyte char isn't corrupted across reads. */
  private readonly decoder = new TextDecoder();

  constructor(
    private readonly path: string,
    readonly info: SessionInfo,
    /** If this session is currently blocked in its own terminal, the `agents --json` reason (e.g.
     *  'permission prompt') — surfaced on attach as a read-only notice (Issue G). */
    private readonly waitingFor?: string,
  ) {
    // No HISTORY read here — getHistory() does the single read and baselines the tail (see class doc). The
    // one exception is the session's CURRENT permission mode: doc-14 requires the permission level be VISIBLE
    // whenever the tool can report it, and the broker sends SessionInfo before getHistory runs, so it must be
    // on `info` at construct time. It's a cheap tail scan of the tiny `permission-mode` sidecar lines, not the
    // history slurp the class doc warns against. Read-only Observe shows it LOCKED; True-Sync composes this
    // class and also shows it locked (no mid-session mode change — see ClaudeLiveConnection.listModes). It is
    // NEVER fed to a resume relaunch (ClaudeResumeConnection does not compose this class), so surfacing it
    // can't silently re-arm a permissive mode. Only set when the transcript actually records one (no invented
    // default), and never clobber an explicitly-provided value.
    if (this.info.currentMode == null) {
      const m = readLatestPermissionMode(path);
      if (m) this.info.currentMode = m;
    }
  }

  subscribe(handler: AgentMessageHandler): Unsubscribe {
    this.handlers.add(handler);
    if (!this.watcher) this.startTail();
    return () => this.handlers.delete(handler);
  }

  /** A blocked observe session can't be answered from here (it's owned by its terminal), but we surface WHAT
   *  it's blocked on, read-only, so a `needs-input` row isn't a silent transcript. An AskUserQuestion is a
   *  durable transcript tool_use (written when claude asks, well before the answer — verified), so render the
   *  REAL question + options (the app dedupes it by requestId against the same card in history). A genuine
   *  PERMISSION prompt is NOT a transcript event and the channel isn't connected in Observe, so the most we
   *  can show is the `agents --json` reason as a notice (Drive/Sync to actually see + answer it). (Issue G.) */
  getPending(): AgentMessage[] {
    if (!this.waitingFor) return [];
    const q = lastUnansweredQuestion(this.path);
    if (q) return [q];
    // No on-disk question to render. A claude.ai-bridge / live-terminal session BUFFERS its in-flight turn
    // (the pending prompt AND the latest streamed output) off the local transcript until the turn completes —
    // verified on a real bridge session AND by adversarial review: the live question is in neither the JSONL,
    // `agents --json` (only "permission prompt"), nor ANY local file/socket, so read-only Observe genuinely
    // cannot show it. Be honest, and do NOT promise Drive — taking over resumes from on-disk history (which
    // lacks the question) and starts a fresh turn, discarding this pending question (and risks a 2nd owner).
    // NB: the title is the bare reason — the app prepends its own "Waiting for input: " to read-only cards,
    // so a "Waiting for input —" prefix here would stutter.
    return [
      {
        type: 'permission-request',
        requestId: 'observe-block',
        title: this.waitingFor,
        detail:
          "This session is waiting for your answer where it's running — its own terminal or claude.ai. The live question and latest output are held there, not in the local transcript, so read-only Observe can't show them: answer it where it's running. (Taking over with Drive resumes from saved history and starts a fresh turn — it won't answer this pending question.)",
        readOnly: true,
      },
    ];
  }

  // Observe lists Claude's on-disk command universe so the palette isn't bare (Issue C); they run only
  // once you Drive (resume) — observe can't start a turn.
  async listCommands(): Promise<SlashCommand[]> {
    return scanDiskCommands(storeForPath(this.path), this.info.cwd);
  }

  // The model + effort + mode selectors must ALWAYS show in the bar (read-only here — observe can't switch;
  // the UI gates actionability on control). Surfacing the catalogs lets the bar render + preselect the
  // session's current model/effort even before you Drive.
  async listModels(): Promise<ModelOption[]> {
    return claudeModelOptions(storeForPath(this.path));
  }
  async listModes(): Promise<ModeOption[]> {
    return CLAUDE_PERMISSION_MODES;
  }

  private emit(m: AgentMessage): void {
    for (const h of this.handlers) {
      try {
        h(m);
      } catch {
        /* isolate one bad subscriber */
      }
    }
  }

  async getHistory(): Promise<AgentMessage[]> {
    // ONE read. Map only COMPLETE lines (up to the last newline B); a partial trailing line being
    // written right now is excluded — the tail re-reads it whole once its newline lands.
    const buf = readFileBuffer(this.path);
    const nl = buf.lastIndexOf(0x0a); // last '\n'
    const boundary = nl >= 0 ? nl + 1 : 0;
    const lines = splitLines(buf.subarray(0, boundary).toString('utf8')).map(parseLineOrNull);
    if (!this.primed) {
      // Baseline the tail at the boundary and seed its name-map + token dedup from these lines, so the
      // tail emits ONLY lines after B (no overlap with this history → keyless messages don't double).
      for (const ln of lines) {
        if (!ln) continue;
        accumulateCallMeta(ln, this.callMeta);
        collectParentActivity(ln, this.resolvedToolUseIds, this.backgroundToolUseIds, this.notifiedToolUseIds, this.backgroundSpawnMs, this.parentActivity()); // seed subagent done-detection from history
        feedQueuedSends(this.queuedSends, ln); // seed pending enqueues so the tail can key their delivery
        const id = messageId(ln);
        if (id) this.seenTokenIds.add(id);
      }
      this.offset = boundary;
      this.tailBuf = '';
      this.primed = true;
      if (this.watcher) setTimeout(() => this.drainTail(), 0); // catch lines appended during this read
    }
    // Append the current subagent/workflow snapshot so the cards replay on attach AND on every
    // history-reset resync (the broker re-pushes getHistory) — needs NO broker change. mapTranscript
    // uses its OWN local sets → idempotent for resync.
    // Runtime contract: docs/architecture/client-ui.md
    // A FRESH runtime tracker derives per-turn run-summary + runtimeTotals from exact transcript
    // boundaries. Discovery status, replay, and resync never finalize a trailing turn. Re-created here
    // so a resync recomputes identically:
    // run-summary/runtimeTotals are idempotent BY KEY (not by event count) — consumers MUST dedupe by key
    // (app.js upserts by m.key; the broker resync clears its ring first), so re-emission is harmless.
    const uuid = basename(this.path).replace(/\.jsonl$/, '');
    this.runtime = new ClaudeRuntimeTracker(uuid, 'claude-transcript');
    this.taskLedger = new ClaudeTaskLedger(); // fresh per (re)play — the tail feeds the same instance
    this.blockOrdinals = newClaudeBlockOrdinals();
    const mapped = mapTranscript(lines, this.runtime, this.taskLedger, this.blockOrdinals);
    return [
      ...mapped,
      ...this.runtime.flush(),
      ...buildActivitySnapshot(claudeActivityDir(this.path), this.resolvedToolUseIds, Date.now(), this.parentActivity()).map((f) => f.msg),
    ];
  }

  getHistorySourceIdentity(): HistorySourceIdentity | undefined {
    return fileHistorySourceIdentity(this.path);
  }

  private startTail(): void {
    try {
      this.watcher = watch(this.path, () => setTimeout(() => this.drainTail(), 80));
    } catch {
      /* fs.watch unsupported here → history-only (no live follow) */
    }
    // Auto-surface subagent/workflow progress (separate from the transcript watch so either can fail
    // independently). Read-only; zero model cost.
    if (!this.activity) {
      this.activity = new ClaudeActivityWatcher(
        claudeActivityDir(this.path),
        (m) => this.emit(m),
        () => this.handlers.size > 0,
        this.resolvedToolUseIds,
        this.parentActivity(),
      );
      this.activity.start();
    }
  }

  /** Read bytes appended past `offset`, map each newly-completed line, emit. Inert until getHistory()
   *  has baselined the offset/seeds, so the tail never overlaps the history it partitions with. */
  private drainTail(): void {
    if (!this.primed) return;
    let bytes: Buffer;
    try {
      const st = statSafe(this.path);
      if (!st || st.size <= this.offset) return;
      bytes = readBytesFrom(this.path, this.offset, st.size - this.offset);
      this.offset = st.size;
    } catch {
      return;
    }
    this.tailBuf += this.decoder.decode(bytes, { stream: true });
    let nl: number;
    while ((nl = this.tailBuf.indexOf('\n')) !== -1) {
      const raw = this.tailBuf.slice(0, nl);
      this.tailBuf = this.tailBuf.slice(nl + 1);
      const ln = parseLineOrNull(raw);
      if (!ln) continue;
      accumulateCallMeta(ln, this.callMeta); // a tool_use precedes its result in append order
      collectParentActivity(ln, this.resolvedToolUseIds, this.backgroundToolUseIds, this.notifiedToolUseIds, this.backgroundSpawnMs, this.parentActivity()); // completing/notified subagents flip cards
      // User echoes stay UNSTAMPED here: Claude Code writes the JSONL itself and gives an app send
      // no id handle, so exact attribution is impossible (a terminal prompt with identical text is
      // indistinguishable). The client's narrow legacy reconcile converges the optimistic bubble.
      const mapped = mapLine(ln, this.callMeta, this.seenTokenIds, this.queuedSends, this.blockOrdinals);
      for (const m of mapped) this.emit(m);
      if (this.taskLedger) for (const m of this.taskLedger.feed(ln)) this.emit(m); // live TaskCreate/TaskUpdate → panel refresh
      if (this.runtime) {
        for (const m of this.runtime.feed(ln, mapped)) {
          if (m.type === 'run-summary') {
            if (m.status === 'running') this.emit({ type: 'status', status: 'running' });
            else if (m.status !== 'cancelled' || m.completedAt !== undefined) this.emit({ type: 'status', status: 'idle' });
          }
          this.emit(m);
        }
      }
    }
  }

  // Observe is read-only. Driving a turn needs resume — reattach with ?mode=resume ("Drive" in the app).
  async sendPrompt(): Promise<void> {
    throw new Error('This is a read-only view of the session. Tap “Drive” to take it over and send prompts.');
  }
  // Defense-in-depth: a read-only observe attach must not silently swallow a broker-bypassing approval —
  // throw the same read-only error as sendPrompt (the broker already rejects mutations before this).
  async respondPermission(): Promise<void> {
    throw new Error('This is a read-only view of the session. Tap “Drive” to take it over to approve actions.');
  }

  async close(): Promise<void> {
    this.watcher?.close();
    this.watcher = undefined;
    this.activity?.close();
    this.activity = undefined;
    this.handlers.clear();
    this.callMeta.clear();
    this.seenTokenIds.clear();
    this.queuedSends.pending.length = 0;
    this.queuedSends.byUuid.clear();
    this.blockOrdinals.next.clear();
    this.blockOrdinals.byUuid.clear();
    this.resolvedToolUseIds.clear();
    this.backgroundToolUseIds.clear();
    this.notifiedToolUseIds.clear();
    this.backgroundSpawnMs.clear();
    this.killedAgentIds.clear();
    this.agentIdToToolUseId.clear();
    this.stopRequests.clear();
  }

  private parentActivity(): ParentActivityState {
    return {
      backgroundToolUseIds: this.backgroundToolUseIds,
      notifiedToolUseIds: this.notifiedToolUseIds,
      backgroundSpawnMs: this.backgroundSpawnMs,
      killedAgentIds: this.killedAgentIds,
      agentIdToToolUseId: this.agentIdToToolUseId,
      stopRequests: this.stopRequests,
    };
  }
}

// ── true-sync live connection (terminal + app share one live session via the claude/channel bridge) ──

/**
 * True-Sync connection. The terminal launched Claude with our channel MCP server (`--channels
 * server:cosyncing`), so terminal and app drive ONE live session. We COMPOSE a read-only
 * {@link ClaudeObserveConnection} for the rich live stream + history (the agent's thinking/tools/text all
 * land in the shared transcript JSONL, which both surfaces tail), and add a Unix-socket client to the
 * plugin for the two things the transcript can't carry: INJECTING the user's prompts into the live
 * session (`notifications/claude/channel`) and APPROVING permissions
 * (`notifications/claude/channel/permission`). Unlike resume, there is NO fork and NO second process —
 * the broker is not the owner; it is a co-client, exactly like the terminal.
 *
 * Dormant unsupported channel bridge (see docs/protocol/adapter-support.md): no longer dispatched by connect() — channel sync
 * can't answer permissions on claude 2.1.185 (not on Anthropic's allowlist). Kept for restore-when-allowlisted.
 * The historical socket protocol was verified before retirement. The agent's `reply`/
 * `send_file` tool calls also appear in the transcript (rendered by the observe tail), so we do NOT
 * re-emit them here in v1 to avoid double-rendering (refinement noted in the bridge impl log).
 */
export class ClaudeLiveConnection implements SessionConnection {
  private readonly observe: ClaudeObserveConnection;
  private readonly handlers = new Set<AgentMessageHandler>();
  private sock?: Socket;
  private sockBuf = '';
  private closing = false; // true once WE tear down (attach swap / app detach) — a close then is expected
  private bridgeDownHandled = false; // fire the "sync ended" degrade at most once per connection
  /** requestId → the permission card, so getPending() can replay it for a late-joining client. */
  private readonly pending = new Map<string, AgentMessage>();

  // The model/effort the terminal session is currently on, so a switch is injected only on a real change.
  // Model is seeded from the session's known current model (alias form, matching the picker); effort is
  // unknown in sync (no stream-json init), so it's seeded to the model default — the best we can assume.
  private syncModel?: string;
  private syncEffort?: string;

  constructor(
    private readonly store: ClaudeStore,
    private readonly path: string,
    readonly info: SessionInfo,
    private readonly sockPath: string,
  ) {
    this.observe = new ClaudeObserveConnection(path, info);
    this.syncModel = modelAlias(info.currentModel?.modelID);
    this.syncEffort = info.currentModel?.reasoningEffort ?? 'high';
  }

  subscribe(handler: AgentMessageHandler): Unsubscribe {
    this.handlers.add(handler);
    const un = this.observe.subscribe(handler); // rich live stream from the shared transcript
    this.ensureSock();
    return () => {
      this.handlers.delete(handler);
      un();
    };
  }

  getHistory(): Promise<AgentMessage[]> {
    return this.observe.getHistory();
  }
  getHistorySourceIdentity(): HistorySourceIdentity | undefined {
    return this.observe.getHistorySourceIdentity();
  }
  async listCommands(): Promise<SlashCommand[]> {
    return this.observe.listCommands();
  }
  // Model/effort selectors stay ACTIONABLE in sync: the terminal owns the launch flags, but `/model` and
  // `/effort` are real mid-session slash commands we inject over the channel (see applyModelEffortSwitch).
  async listModels(): Promise<ModelOption[]> {
    return claudeModelOptions(this.store);
  }
  // Permission mode is NOT actionable in True-Sync, so expose NO mode options. Claude changes the permission
  // mode only via Shift+Tab in its own TUI or the `--permission-mode` launch flag — neither is reachable over
  // the channel (there is no `/permission-mode` slash command, unlike `/model`/`/effort`). Returning the full
  // list would render an ENABLED picker the adapter then silently ignores, which the contract forbids
  // (docs/architecture/client-ui.md: "Picker actionability must match actual backend support";
  // doc 15/14 Part: "permission mode must be locked or omitted unless there is a real native mid-session
  // mechanism"). With no options the app keeps the mode VISIBLE-but-LOCKED from `info.currentMode` (set by the
  // composed observe connection) and never rides a fake permissionMode on the prompt. To CHANGE the mode,
  // Drive (resume relaunches with `--permission-mode`) or Shift+Tab in the synced terminal.
  async listModes(): Promise<ModeOption[]> {
    return [];
  }
  getPending(): AgentMessage[] {
    return [...this.pending.values()];
  }

  private emit(m: AgentMessage): void {
    if (m.type === 'permission-request') this.pending.set(m.requestId, m);
    for (const h of this.handlers) {
      try {
        h(m);
      } catch {
        /* isolate */
      }
    }
  }

  private ensureSock(): void {
    if (this.sock) return;
    let sock: Socket;
    try {
      sock = connect(this.sockPath);
    } catch (e) {
      this.emit({ type: 'error', message: 'Live bridge unavailable: ' + String(e) });
      return;
    }
    this.sock = sock;
    sock.on('data', (b: Buffer) => this.onSock(b));
    // 'error' is always followed by 'close'; let close() do the single teardown/degrade so we don't
    // double-report. (connect() to a stale socket errors here; a live plugin dying closes the conn.)
    sock.on('error', () => {});
    sock.on('close', () => {
      this.sock = undefined;
      if (this.closing) return; // WE closed it (attach swap / app detach) — the bridge may still be live
      this.handleBridgeDown();
    });
  }

  /** The terminal's claude session (and its channel plugin) went away while we were synced. A clean plugin
   *  exit unlinks its socket → `watchSessionInfo` already degrades the row; but an UNCLEAN exit (kill -9,
   *  terminal window closed) leaves a STALE socket file, so the row would stay "synced" forever. The socket
   *  CONNECTION still breaks when the process dies, so we catch it here: best-effort unlink the stale file
   *  (→ `watchSessionInfo` fs.watch fires → broker re-attaches this as read-only Observe), and tell the
   *  user immediately rather than leaving them on a silently-dead "Synced with terminal" session. */
  private handleBridgeDown(): void {
    if (this.bridgeDownHandled) return;
    this.bridgeDownHandled = true;
    try {
      if (existsSync(this.sockPath)) rmSync(this.sockPath, { force: true });
    } catch {
      /* ignore — the row still degrades on the next discovery poll */
    }
    this.emit({ type: 'error', message: 'Terminal sync ended — the CLI session closed. This session is now read-only (Observe); tap Drive to take it over.' });
  }

  private onSock(b: Buffer): void {
    this.sockBuf += b.toString('utf8');
    let nl: number;
    while ((nl = this.sockBuf.indexOf('\n')) !== -1) {
      const line = this.sockBuf.slice(0, nl).trim();
      this.sockBuf = this.sockBuf.slice(nl + 1);
      if (!line) continue;
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (!m || typeof m !== 'object') continue; // `null`/scalar JSON parses cleanly — guard before m.type
      if (m.type === 'permission_request') {
        this.emit({
          type: 'permission-request',
          requestId: String(m.request_id ?? ''),
          title: `Permission: ${m.tool_name ?? 'tool'}`,
          detail: String(m.input_preview || m.description || ''),
          readOnly: false,
        });
      } else if (m.type === 'file') {
        // Agent→user file via the channel `send_file` tool. The transcript carries only the tool-CALL
        // (a path string), NOT the bytes — so the file must be DELIVERED here or the app never gets it.
        // The plugin already copied it to its outbox (m.path = that stable copy); inline as a data: URL
        // (capped at the broker's 5MB rule → header-only above) and flag proactive (a deliberate push).
        const name = String(m.name || basename(String(m.path || '')) || 'file');
        const mime = mimeFromName(name);
        const sz = numOrUndef(m.size);
        this.emit({
          type: 'file-artifact',
          name,
          path: String(m.path || name),
          mimeType: mime,
          size: sz,
          proactive: true,
          url: inlineFileDataUrl(String(m.path || ''), mime, sz),
        });
      }
      // hello: handshake only. reply: the agent's `reply` tool-call already lands in the transcript
      // (rendered by the observe tail), so it is not re-emitted here (avoids a double render). A sent
      // file is NOT in the transcript as bytes, which is why `file` (above) IS surfaced.
    }
  }

  private write(o: unknown): boolean {
    try {
      if (!this.sock) return false;
      this.sock.write(JSON.stringify(o) + '\n');
      return true;
    } catch {
      /* dropped — the close handler clears this.sock */
      return false;
    }
  }

  async sendPrompt(input: PromptInput): Promise<void> {
    this.ensureSock();
    this.applyModelEffortSwitch(input);
    let text = String(input.text ?? '');
    if (input.files?.length) {
      const cwd = this.info.cwd;
      if (!cwd) throw new Error('Claude attachment delivery requires a workspace.');
      const inbox = resolve(cwd, PRODUCT_IDENTITY.repositoryDirectoryName, 'inbox');
      const refs = input.files.map((file) => {
        if (!file.brokerPath) {
          throw new Error('Claude live attachment is missing its broker path.');
        }
        const brokerPath = resolve(file.brokerPath);
        if (dirname(brokerPath) !== inbox || !existsSync(brokerPath)) {
          throw new Error('Claude rejected an untrusted broker attachment path.');
        }
        return `- ${file.name} (${file.mimeType}) -> \`${brokerPath}\``;
      });
      const note = `Attached file(s) — read them from these paths:\n${refs.join('\n')}`;
      text = text.trim() ? `${text}\n\n${note}` : note;
    }
    // No clientMessageId use: the echo surfaces on the composed observe tail, written by Claude Code
    // itself with no id handle for this send — it stays unstamped (client legacy reconcile applies).
    if (!this.write({ type: 'prompt', text })) {
      throw new Error('Claude live attachment prompt was not accepted by the channel.');
    }
  }

  /** True-sync can't relaunch the terminal's claude (it owns the process), so a model/effort change picked
   *  in the app is applied by injecting Claude's mid-session slash commands over the channel BEFORE the
   *  prompt — verified mechanisms: `/model <alias>` and `/effort <level>` take effect immediately. Each is
   *  its own channel turn so claude parses it as a command. Only fires on an actual change vs the tracked
   *  current (so the default the app always sends doesn't spuriously switch the terminal). NOTE: there is NO
   *  mid-session permission-mode command (Shift+Tab / launch-flag only), so mode isn't switchable in sync —
   *  the app must Drive to change it. Wrapper stores are endpoint-fixed (no model/effort switching). */
  private applyModelEffortSwitch(input: PromptInput): void {
    if (!this.store.isDefault) return;
    const model = input.model?.modelID;
    if (model && model !== this.syncModel) {
      this.write({ type: 'prompt', text: `/model ${model}` });
      this.syncModel = model;
      // Switching to a model that can't run the tracked effort (e.g. opus→sonnet while on ultracode/xhigh):
      // the terminal auto-resets to that model's default, so forget our tracked effort to avoid stale state
      // (and so we never re-inject e.g. `/effort ultracode` onto a Sonnet/Haiku that rejects it).
      if (this.syncEffort && !modelSupportsEffort(model, this.syncEffort)) this.syncEffort = undefined;
    }
    // Effort: inject only on a real change AND only if the (now-current) model supports it — Sonnet has no
    // xhigh, Haiku no effort, and only Opus/Fable accept `ultracode`, so a stale pick never injects an invalid
    // `/effort`. ultracode is a valid mid-session slash command the live terminal parses natively.
    const effort = input.model?.reasoningEffort;
    if (effort && effort !== this.syncEffort && modelSupportsEffort(this.syncModel ?? model, effort)) {
      this.write({ type: 'prompt', text: `/effort ${effort}` });
      this.syncEffort = effort;
    }
  }

  /** User uploaded a file from the app → stage it in the session workspace's `.cosyncing/inbox/` and inject
   *  a prompt that references it. The plugin forwards `file_path` in the channel `meta`, and the bridge
   *  server's `instructions` tell the agent to Read an arriving file_path. This path-reference works
   *  without native image blocks; `.cosyncing/` is gitignored. basename-only dest → no path traversal. */
  async sendFile(file: FileInput): Promise<void> {
    this.ensureSock();
    const cwd = this.info.cwd;
    if (!cwd) {
      throw new Error('Cannot stage an upload: the session has no working directory.');
    }
    const inbox = resolve(cwd, PRODUCT_IDENTITY.repositoryDirectoryName, 'inbox');
    if (file.brokerPath) {
      const brokerPath = resolve(file.brokerPath);
      if (dirname(brokerPath) !== inbox || !existsSync(brokerPath)) {
        throw new Error('Claude rejected an untrusted broker attachment path.');
      }
      this.write({ type: 'prompt', text: `[uploaded file: ${file.name}]`, file_path: brokerPath });
      return;
    }
    if (typeof file.data !== 'string') throw new Error('Claude attachment bytes are missing.');
    const safe = basename(String(file.name || 'upload')) || 'upload';
    const dest = join(inbox, safe);
    try {
      mkdirSync(inbox, { recursive: true });
      writeFileSync(dest, Buffer.from(file.data, 'base64'));
    } catch (e) {
      throw new Error('Could not stage the uploaded file: ' + String(e));
    }
    this.write({ type: 'prompt', text: `[uploaded file: ${safe}]`, file_path: dest });
  }

  async respondPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    this.pending.delete(requestId);
    this.write({ type: 'permission', request_id: requestId, behavior: decision === 'reject' ? 'deny' : 'allow' });
    // Broadcast resolution so every OTHER attached tab clears its now-stale permission card (the Resume
    // path already does this; True-Sync must too or a second tab keeps showing an answered request).
    this.emit({ type: 'permission-resolved', requestId, decision });
  }

  /** Slash commands run as turns injected over the channel (no separate driver). */
  async runCommand(name: string, args?: string): Promise<void> {
    await this.sendPrompt({ text: `/${name}${args ? ' ' + args : ''}` });
  }

  async close(): Promise<void> {
    this.closing = true; // an expected teardown — the socket 'close' must NOT be read as the bridge dying
    try {
      this.sock?.destroy();
    } catch {
      /* ignore */
    }
    this.sock = undefined;
    this.pending.clear();
    this.handlers.clear();
    await this.observe.close();
  }
}

// ── drivable resume connection (Claude becomes drivable; tested on the free claude-open wrapper) ──

/** Claude's built-in slash commands (NOT on disk — shipped statically so the palette isn't bare in
 *  observe). When you Drive, the live process's system/init event provides the authoritative full set
 *  (built-ins + enabled plugins + skills), which supersedes this. (Issue C.) */
const CLAUDE_BUILTIN_COMMANDS: SlashCommand[] = [
  { name: 'stop', kind: 'action', description: 'Interrupt the current turn' },
  { name: 'compact', kind: 'action', description: 'Summarize & shrink the context' },
  { name: 'clear', kind: 'action', description: 'Clear the conversation context' },
  { name: 'context', kind: 'action', description: 'Show context-window usage' },
  { name: 'cost', kind: 'action', description: 'Show token cost so far' },
  { name: 'init', kind: 'prompt', description: 'Generate a CLAUDE.md for this project' },
  { name: 'review', kind: 'prompt', description: 'Review the current changes' },
  { name: 'security-review', kind: 'prompt', description: 'Security review of the changes' },
];

/** Claude permission modes for the mode picker → `--permission-mode` at resume launch. (Issue B.) The full
 *  set is authoritative from `claude --permission-mode` (verified claude 2.1.181: default, acceptEdits, auto,
 *  dontAsk, plan, bypassPermissions). `category` maps Claude's native modes onto the universal presets
 *  (doc-12 Permission Mode Options); `plan` (read-only planning) and `dontAsk` (auto-deny / allow-list only)
 *  fit none of the three action presets, so they are `custom`. */
export const CLAUDE_PERMISSION_MODES: ModeOption[] = [
  { value: 'default', label: 'Default', description: 'Ask before risky actions', category: 'ask-permission' },
  { value: 'acceptEdits', label: 'Accept edits', description: 'Auto-approve file edits (still asks for commands)', category: 'approve-for-me' },
  { value: 'auto', label: 'Auto', description: 'Run without asking; a classifier blocks unsafe actions', category: 'approve-for-me' },
  { value: 'plan', label: 'Plan', description: 'Read-only planning — no changes', category: 'custom' },
  { value: 'dontAsk', label: "Don't ask", description: 'Non-interactive: only allow-listed + read-only actions run', category: 'custom' },
  { value: 'bypassPermissions', label: 'Bypass', description: 'Run everything without any checks', category: 'full-access' },
];

/** Reasoning-effort levels (`claude --effort`; verified claude 2.1.181: low|medium|high|xhigh|max). These
 *  are PER-MODEL, not global (confirmed via platform.claude.com effort docs, 2026-06-18): Opus 4.8/4.7 and
 *  Fable 5 accept the full ladder; Sonnet 4.6 tops out at `max` (no `xhigh`); Haiku 4.5 has no effort control
 *  at all. The chosen level rides per-turn on `currentModel.reasoningEffort` → resumeArgs passes `--effort`,
 *  clamped to the model's set so a switch to a lower-ceiling model can't launch-fail. */
type Effort = { effort: string; label: string; description?: string };
const E_LOW: Effort = { effort: 'low', label: 'Low', description: 'Fastest, least thinking' };
const E_MEDIUM: Effort = { effort: 'medium', label: 'Medium' };
const E_HIGH: Effort = { effort: 'high', label: 'High', description: "Claude's default" };
const E_XHIGH: Effort = { effort: 'xhigh', label: 'Extra high' };
const E_MAX: Effort = { effort: 'max', label: 'Max', description: 'Most thinking, slowest' };
const EFFORTS_FULL: Effort[] = [E_LOW, E_MEDIUM, E_HIGH, E_XHIGH, E_MAX]; // Opus 4.8/4.7, Fable 5
const EFFORTS_NO_XHIGH: Effort[] = [E_LOW, E_MEDIUM, E_HIGH, E_MAX]; //        Sonnet 4.6 (no xhigh)
const EFFORTS_NONE: Effort[] = []; //                                         Haiku 4.5 (no effort control)

/** Ultracode (binary 2.1.181: "Enable ultracode for the session: xhigh effort plus standing dynamic-workflow
 *  orchestration") = xhigh + an orchestration flag, NOT a real effort rung. It's SESSION-ONLY (never persisted)
 *  and gated to xhigh-capable models, so it rides ONLY on EFFORTS_FULL_ULTRA (Opus/Fable) — never on
 *  Sonnet/Haiku. The launch flag `--effort` does NOT accept it (it'd be ignored); Drive enables it via the
 *  `--settings {ultracode:true}` launch flag (+ `--effort xhigh`), Sync via the `/effort ultracode` slash
 *  command. Surfaced as one extra pseudo-effort token appended after `max` so the existing effort picker shows
 *  it with zero app-side change. */
const E_ULTRACODE: Effort = { effort: 'ultracode', label: 'Ultracode', description: 'xhigh + auto workflow orchestration · session only' };
const EFFORTS_FULL_ULTRA: Effort[] = [...EFFORTS_FULL, E_ULTRACODE]; // xhigh-capable models that also allow ultracode

/** Curated, user-selectable Claude alias catalog. There is no complete zero-turn list command. Concrete ids
 *  below are matching keys for account gating only; they are not presented as verified alias resolutions.
 *  A model this list lacks still renders as the exact live current value from transcript/init. */
type CatalogEntry = { alias: string; fullId: string; label: string; efforts: Effort[]; defaultEffort?: string };
const CURATED_CLAUDE_CATALOG: CatalogEntry[] = [
  { alias: 'opus', fullId: 'claude-opus-4-8', label: 'Opus', efforts: EFFORTS_FULL_ULTRA, defaultEffort: 'high' },
  { alias: 'sonnet', fullId: 'claude-sonnet-4-6', label: 'Sonnet', efforts: EFFORTS_NO_XHIGH, defaultEffort: 'high' },
  { alias: 'haiku', fullId: 'claude-haiku-4-5', label: 'Haiku', efforts: EFFORTS_NONE },
  { alias: 'fable', fullId: 'claude-fable-5', label: 'Fable', efforts: EFFORTS_FULL_ULTRA, defaultEffort: 'high' },
];
export const CLAUDE_MAX_MODEL_OPTIONS = 64;
export const CLAUDE_MAX_GATING_ENTRIES = 256;

/** Whether `model` (alias or full id) accepts `effort`. Unknown models (not in the curated catalog, e.g. a
 *  wrapper or a future tier) return true — we don't second-guess a model we don't know; the CLI validates.
 *  Known models clamp to their set (Sonnet drops `xhigh`; Haiku drops everything). The pseudo-effort
 *  `ultracode` lives only on the xhigh-capable entries (Opus/Fable), so it validates true for them and false
 *  for Sonnet/Haiku here. Used so neither a Drive relaunch nor a sync `/effort` injection carries a level the
 *  chosen model can't run. */
function modelSupportsEffort(model: string | undefined, effort: string): boolean {
  const a = modelAlias(model);
  const e = CURATED_CLAUDE_CATALOG.find((c) => c.alias === a || c.fullId === model);
  return e ? e.efforts.some((x) => x.effort === effort) : true;
}

/** Map a full model id (e.g. 'claude-opus-4-8') to the `claude --model` alias ('opus') the picker uses, so a
 *  synced session's current model compares equal to a picker selection (no spurious `/model` on the first
 *  prompt). Unknown ids pass through unchanged. */
export function modelAlias(id?: string): string | undefined {
  if (!id) return undefined;
  // Anchor to the Anthropic id scheme ('opus', 'opusplan', 'claude-opus-4-8', any case) so a WRAPPER model
  // whose name merely CONTAINS a tier word (e.g. 'my-sonnet-fork', 'minimax-opus-pro') does NOT collide and
  // get effort-clamped against the wrong catalog entry — it falls through to pass-through (modelSupportsEffort
  // → true, the endpoint decides). Default-store ids still alias correctly ('claude-Opus-4-8' → 'opus').
  const m = /^(?:claude-)?(opus|sonnet|haiku|fable)/.exec(id.toLowerCase());
  return m ? m[1] : id; // unknown ids (wrapper/future tiers) pass through unchanged
}

/** Per-account model gating. Claude caches server-pushed feature flags in `.claude.json` under
 *  `cachedGrowthBookFeatures.tengu-model-error-overrides`, e.g.
 *  `{"claude-fable-5":{"block":"Claude Fable 5 is currently unavailable…"}}`. A model with a non-empty
 *  `block` isn't usable on this account, so we drop it from the picker — this is how Fable auto-disappears
 *  for an account without Fable access (no hardcoding; it reappears the moment Anthropic ungates it and the
 *  cache refreshes). Reads `<configDir>/.claude.json`, and — for the genuine default store only — also the
 *  home `~/.claude.json` (Claude Code caches the flags in either); a TEST store (temp configDir) therefore
 *  stays isolated from the real machine. Fail-open: a missing/garbled file → no gating (the CLI still
 *  rejects a gated model at launch). mtime-cached so a large `.claude.json` is parsed only when it changes. */
const gatingCache = new Map<string, { mtimeMs: number; ids: Set<string> }>();
function readModelGating(store: ClaudeStore): Set<string> {
  const out = new Set<string>();
  const files = [join(store.configDir, '.claude.json')];
  // The genuine default store (configDir literally ~/.claude) also consults the home ~/.claude.json, where
  // Claude Code may cache the GrowthBook flags. Keyed on the real path — NOT on DEFAULT_CONFIG_DIR (which an
  // isolated test/trace can repoint via CLAUDE_CONFIG_DIR) — so a temp-configDir store never reads real home.
  if (resolve(store.configDir) === resolve(join(homedir(), '.claude'))) files.push(join(homedir(), '.claude.json'));
  for (const file of files) {
    const st = statSafe(file);
    if (!st) continue;
    const hit = gatingCache.get(file);
    let ids: Set<string>;
    if (hit && hit.mtimeMs === st.mtimeMs) {
      ids = hit.ids;
    } else {
      ids = new Set<string>();
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as any;
        const ov = raw?.cachedGrowthBookFeatures?.['tengu-model-error-overrides'] ?? raw?.['tengu-model-error-overrides'];
        if (ov && typeof ov === 'object') {
          for (const [id, v] of Object.entries(ov as Record<string, any>).slice(0, CLAUDE_MAX_GATING_ENTRIES)) {
            if (typeof v?.block === 'string' && v.block.trim()) {
              ids.add(id.toLowerCase());
              const a = modelAlias(id);
              if (a) ids.add(a.toLowerCase());
            }
          }
        }
      } catch {
        /* fail-open: leave ids empty */
      }
      gatingCache.set(file, { mtimeMs: st.mtimeMs, ids });
    }
    for (const id of ids) out.add(id);
  }
  return out;
}

/** Model options for the picker. Claude Code has no complete zero-turn inventory command, so the official
 *  store exposes a bounded curated alias list ({@link CURATED_CLAUDE_CATALOG}). GrowthBook data can remove a
 *  blocked alias, but never adds entries or turns an alias into a purported concrete model id. Each alias
 *  carries only the reasoning-effort levels supported by runtime information already used by the adapter
 *  (Opus full ladder; Sonnet no `xhigh`; Haiku none), so the app can infer the effort picker per model.
 *  A wrapper store is pinned to the concrete backend models declared by that wrapper.
 *  `defaultReasoningEffort` preselects the model's default. (Issues B + D; dynamic-discovery refinement.) */
export function claudeModelOptions(store: ClaudeStore): ModelOption[] {
  if (!store.isDefault) {
    // A wrapper offers EACH distinct backend model it maps (claude-mi: pro + non-pro), so the picker can
    // switch among them. These Anthropic-compatible endpoints DO honor reasoning effort + ultracode — verified
    // live on claude-minimax (MiniMax-M3) and claude-mi (mimo): `--effort xhigh` and `--settings
    // {ultracode:true}` are accepted with no warning. So expose the full ladder incl. ultracode; an endpoint
    // that ignores a level just runs its default (graceful, no error). Falls back to the single primary model.
    const list = (store.models?.length ? store.models : [store.model || 'model']).slice(0, CLAUDE_MAX_MODEL_OPTIONS);
    return list.map((id) => ({ providerID: 'wrapper', modelID: id, label: id, reasoningEfforts: EFFORTS_FULL_ULTRA, defaultReasoningEffort: 'high' }));
  }
  const blocked = readModelGating(store);
  const out: ModelOption[] = [];
  for (const e of CURATED_CLAUDE_CATALOG) {
    if (blocked.has(e.alias) || blocked.has(e.fullId.toLowerCase())) continue; // gated → not selectable for this account
    out.push({
      providerID: 'anthropic',
      modelID: e.alias,
      label: e.label,
      ...(e.efforts.length ? { reasoningEfforts: e.efforts } : {}),
      ...(e.defaultEffort ? { defaultReasoningEffort: e.defaultEffort } : {}),
    });
  }
  // Generalizable-gating guardrail: if the account gates out EVERY model, the picker is empty. We return []
  // honestly (the live currentModel still renders read-only); the app/Codex track must not crash on zero
  // options (show the locked current model). Warn so it's visible in logs.
  if (out.length === 0) console.warn('[claude] all models are gated out for this account — the model picker is empty');
  return out;
}

/** Disk command scan for the OBSERVE palette: built-ins + user `<configDir>/commands` + project
 *  `<cwd>/.claude/commands` (recursive, `dir/sub.md` → `dir:sub`). Plugin/skill commands come from the
 *  live init event when you Drive — this keeps observe useful without a fragile plugin-enablement parser. */
export function scanDiskCommands(store: ClaudeStore, cwd?: string): SlashCommand[] {
  const out = new Map<string, SlashCommand>();
  for (const c of CLAUDE_BUILTIN_COMMANDS) out.set(c.name, c);
  const roots = [join(store.configDir, 'commands')];
  if (cwd) roots.push(join(cwd, '.claude', 'commands'));
  for (const root of roots) collectMdCommands(root, root, out, 0);
  return [...out.values()];
}
function collectMdCommands(base: string, dir: string, out: Map<string, SlashCommand>, depth: number): void {
  if (depth > 4) return;
  let ents: import('node:fs').Dirent[];
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const full = join(dir, e.name);
    if (e.isDirectory()) collectMdCommands(base, full, out, depth + 1);
    else if (e.isFile() && e.name.endsWith('.md')) {
      const name = relative(base, full).replace(/\.md$/, '').split(sep).join(':');
      if (name) out.set(name, { name, kind: 'prompt', description: 'custom command' });
    }
  }
}

/**
 * Drives a session via a long-lived
 *   <bin> -p --resume <uuid> --fork-session --output-format stream-json --input-format stream-json
 *         --include-partial-messages --verbose [--model X] [--permission-mode M]
 * process. History = the existing transcript replay (reuse {@link mapTranscript}); live turns are the
 * process's stream-json stdout, mapped with the SAME verified mappers ({@link mapLine}). `--fork-session`
 * keeps the original session/terminal untouched (single-owner safety). The process launches LAZILY on
 * the FIRST sendPrompt — never on attach — so opening even a paid official session spends nothing until
 * you actually drive it. Model/permission-mode are launch args, so changing them relaunches. `bin` is
 * the wrapper path for wrapper sessions, so the right provider/model + CLAUDE_CONFIG_DIR are used.
 */
let resumeConnSeq = 0; // process-monotonic; seeds each ClaudeResumeConnection.connNonce so live-turn run-summary keys are globally unique across grace-eviction reconnect rebuilds
export class ClaudeResumeConnection implements SessionConnection {
  private readonly handlers = new Set<AgentMessageHandler>();
  private proc?: ChildProcessWithoutNullStreams;
  private stdoutBuf = '';
  private readonly decoder = new TextDecoder();
  private readonly uuid: string;
  private liveUuid: string;
  private launchModel?: string;
  private launchMode?: string;
  private launchEffort?: string;
  private running = false;
  private readonly callMeta = new Map<string, ClaudeCall>();
  private readonly seenTokenIds = new Set<string>();
  /** Auto-surfaced subagent/workflow progress cards + parent-answered tool_use_ids (subagent done). The
   *  watcher re-points to the forked uuid's activity dir once the live process reports its session id. */
  private activity?: ClaudeActivityWatcher;
  private readonly resolvedToolUseIds = new Set<string>();
  private readonly backgroundToolUseIds = new Set<string>();
  private readonly notifiedToolUseIds = new Set<string>();
  private readonly backgroundSpawnMs = new Map<string, number>();
  private readonly killedAgentIds = new Set<string>();
  private readonly agentIdToToolUseId = new Map<string, string>();
  private readonly stopRequests = new Map<string, string>();
  private initCommands?: SlashCommand[];
  /** Per-turn runtime/timestamp derivation (doc-15): history turns from the transcript (getHistory), then
   *  LIVE driven turns from stream events (message_start→running, result→done) since those carry no native ts. */
  private runtime?: ClaudeRuntimeTracker;
  /** Same incremental TaskCreate/TaskUpdate ledger as Observe: seeded from replay, advanced by stream-json. */
  private taskLedger = new ClaudeTaskLedger();
  private pendingPermId?: string; // last control_request id awaiting respondPermission
  private pendingPermCard?: AgentMessage & { type: 'permission-request' }; // full card for getPending replay
  private pendingPermInput?: unknown; // the gated tool's input — echoed as updatedInput on allow
  private pendingQuestionId?: string; // open AskUserQuestion tool_use id awaiting answerQuestion
  private pendingQuestionCard?: QuestionCard; // the full card, replayed by getPending() for a late tab
  /** With --permission-prompt-tool stdio the CLI routes AskUserQuestion through can_use_tool too
   *  (requires_user_interaction: true — fires even under auto-allow settings) and BLOCKS the tool until
   *  our control_response. The ONLY way the model receives the choices is allow + updatedInput.answers
   *  ({question text → chosen label}); a plain allow makes the tool self-resolve "The user did not answer
   *  the questions." and a tool_result injected afterwards is ignored (probed 2.1.207). */
  private pendingQuestionControlId?: string; // the can_use_tool request_id gating the open question
  private pendingQuestionControlInput?: any; // that request's tool input — answers are grafted onto it
  /** Streaming: the API `message.id` from message_start, so every block of this message keys by the same
   *  identity the transcript records for it (see claudeBlockKey). Empty when the frame carried none. */
  private curMsgId = '';
  /** Streaming fallback for a message_start with NO id: a per-connection synthetic key. It cannot match
   *  the transcript, so it costs the duplicate this identity removes — never a lost or merged block. */
  private curKey = '';
  /** Did the current assistant message stream deltas? Local-command replies don't — their text must
   *  be emitted from the final assistant event instead (see emitFinalAssistant). */
  private streamedThisMessage = false;
  /** Texts already finalized from stream deltas this message — dedupe for proxies that re-deliver the
   *  same message as multiple per-block assistant events (see emitFinalAssistant). */
  private streamedFinalTexts = new Set<string>();
  private turnSeq = 0;
  private liveTurnSeq = 0; // distinct from turnSeq (per-message) — counts user-driven TURNS for run-summary keys
  private readonly connNonce = ++resumeConnSeq; // process-unique per connection → live-turn keys never collide across a reconnect rebuild (liveTurnSeq resets to 0 on a fresh connection)
  private readonly blockAccum = new Map<number, string>(); // index → accumulated streamed text (this message)
  private readonly blockKind = new Map<number, 'text' | 'thinking'>(); // index → block kind
  /** USER-ECHO TAIL (item-12 follow-up). Drive stdout emits NO user events at all (probed 2.1.207) —
   *  neither for a direct prompt nor for a mid-turn message the CLI queued and later delivered. The
   *  app therefore draws its own optimistic bubble on send, but a QUEUED send's dimmed bubble could
   *  never clear: the delivery proof exists only as a user line in the transcript. This narrow tail
   *  polls the live transcript and emits ONLY user-message frames from appended lines (everything
   *  else — tool results, assistant turns — already arrives via stdout and must not double). */
  private echoTailPath?: string;
  private echoTailOffset = 0;
  private echoTailBuf = '';
  private echoTailTimer?: ReturnType<typeof setInterval>;
  private readonly echoDecoder = new TextDecoder(); // NOT this.decoder — that one holds stdout stream state

  constructor(
    private readonly store: ClaudeStore,
    private readonly path: string,
    readonly info: SessionInfo,
  ) {
    this.uuid = basename(path).replace(/\.jsonl$/, '');
    this.liveUuid = this.uuid;
  }

  subscribe(handler: AgentMessageHandler): Unsubscribe {
    this.handlers.add(handler);
    // Surface existing subagents/workflows even before the first prompt (a zero-prompt Drive attach
    // still shows what's on disk). The watcher re-points to the fork dir once the process reports it.
    if (!this.activity) {
      this.activity = new ClaudeActivityWatcher(
        claudeActivityDir(this.path),
        (m) => this.emit(m),
        () => this.handlers.size > 0,
        this.resolvedToolUseIds,
        this.parentActivity(),
      );
      this.activity.start();
    }
    if (!this.echoTailTimer) {
      this.drainUserEcho(); // baseline NOW (before getHistory reads) — overlap dedupes by key, a gap would not
      this.echoTailTimer = setInterval(() => this.drainUserEcho(), 1000);
    }
    return () => this.handlers.delete(handler);
  }

  /** Poll the live transcript for appended lines and emit ONLY their user-message frames (the drive
   *  child's delivery echo — see the field doc above). Self-repoints when a fork moves the live file;
   *  a path change re-baselines to the file's current size so copied history never re-emits. */
  private drainUserEcho(): void {
    const p = this.liveTranscriptPath();
    if (p !== this.echoTailPath) {
      this.echoTailPath = p;
      this.echoTailOffset = statSafe(p)?.size ?? 0;
      this.echoTailBuf = '';
      return;
    }
    const st = statSafe(p);
    if (!st || st.size <= this.echoTailOffset) return;
    let bytes: Buffer;
    try {
      bytes = readBytesFrom(p, this.echoTailOffset, st.size - this.echoTailOffset);
      this.echoTailOffset = st.size;
    } catch {
      return;
    }
    this.echoTailBuf += this.echoDecoder.decode(bytes, { stream: true });
    let nl: number;
    while ((nl = this.echoTailBuf.indexOf('\n')) !== -1) {
      const raw = this.echoTailBuf.slice(0, nl);
      this.echoTailBuf = this.echoTailBuf.slice(nl + 1);
      const ln = parseLineOrNull(raw);
      if (!ln || ln.type !== 'user') continue;
      for (const m of mapUser(ln, this.callMeta)) {
        if (m.type === 'user-message') this.emit(m);
      }
    }
  }
  private emit(m: AgentMessage): void {
    for (const h of this.handlers) {
      try {
        h(m);
      } catch {
        /* isolate */
      }
    }
  }

  async getHistory(): Promise<AgentMessage[]> {
    // The conversation so far is the active transcript. Unowned Drive resumes in place; if live-owner
    // safety forced a fork, follow the learned fork uuid because it contains the copied history plus
    // driven turns.
    const historyPath = this.liveTranscriptPath();
    try {
      const buf = readFileBuffer(historyPath);
      const nl = buf.lastIndexOf(0x0a);
      const lines = splitLines(buf.subarray(0, nl >= 0 ? nl + 1 : 0).toString('utf8')).map(parseLineOrNull);
      for (const ln of lines) {
        if (!ln) continue;
        accumulateCallMeta(ln, this.callMeta);
        collectParentActivity(ln, this.resolvedToolUseIds, this.backgroundToolUseIds, this.notifiedToolUseIds, this.backgroundSpawnMs, this.parentActivity());
      }
      // Replay is evidence, not a completion source. Exact transcript terminal markers close past
      // turns; an open trailing turn stays running. Live driven turns use stream start/result markers.
      this.runtime = new ClaudeRuntimeTracker(this.liveUuid, 'claude-transcript');
      this.taskLedger = new ClaudeTaskLedger();
      const mapped = mapTranscript(lines, this.runtime, this.taskLedger);
      return [
        ...mapped,
        ...this.runtime.flush(),
        ...buildActivitySnapshot(claudeActivityDir(historyPath), this.resolvedToolUseIds, Date.now(), this.parentActivity()).map((f) => f.msg),
      ];
    } catch {
      return [];
    }
  }

  getHistorySourceIdentity(): HistorySourceIdentity | undefined {
    return fileHistorySourceIdentity(this.liveTranscriptPath());
  }

  private liveTranscriptPath(): string {
    if (this.liveUuid !== this.uuid) {
      const p = join(dirname(this.path), this.liveUuid + '.jsonl');
      if (existsSync(p)) return p;
    }
    return this.path;
  }

  async sendPrompt(input: PromptInput): Promise<void> {
    let text = String(input.text ?? '');
    // Resume is cwd-scoped: if the recorded workspace is gone, `claude --resume` can't find the session
    // (it would fail cryptically with "No conversation found"). Surface a clear reason instead of a
    // stuck "running". (Found while testing — a deleted /tmp workspace can't be driven.)
    if (this.info.cwd && !existsSync(this.info.cwd)) {
      this.emit({ type: 'error', message: `Can't drive this session — its workspace (${this.info.cwd}) no longer exists.` });
      return;
    }
    // File uploads: stage each into <cwd>/.cosyncing/inbox and reference it by absolute path IN THIS TURN
    // (path-ref input — works for any file type; .cosyncing/ is gitignored).
    if (input.files?.length) {
      const refs = input.files.map((f) => {
        const abs = this.writeInboxFile(f);
        return `- ${f.name} (${f.mimeType}) -> \`${abs}\``;
      });
      const note = `Attached file(s) — read them from these paths:\n${refs.join('\n')}`;
      text = text.trim() ? `${text}\n\n${note}` : note;
    }
    // Build the turn content FIRST and bail on an empty turn BEFORE touching the process — a no-op prompt
    // must never kill/re-fork the warm child (Native image blocks use the Anthropic base64 block shape).
    const content: any[] = [];
    if (text.trim()) content.push({ type: 'text', text });
    for (const img of input.images ?? []) {
      if (img && typeof img.data === 'string' && img.data) content.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType || 'image/png', data: img.data } });
    }
    if (!content.length) return;
    // Relaunch ONLY for a cold start or an EXPLICIT per-turn model/mode switch — never merely because the
    // session's configured currentModel/currentMode (seeded from the runtime `init`) differs from the
    // value the warm child was launched with (that divergence would SIGTERM a live turn mid-conversation).
    // On the (re)launch we reassert the configured default so a cold start uses currentModel/currentMode.
    const explicitModel = input.model?.modelID;
    const explicitMode = input.permissionMode;
    const explicitEffort = input.model?.reasoningEffort;
    if (
      !this.proc ||
      (explicitModel && explicitModel !== this.launchModel) ||
      (explicitMode && explicitMode !== this.launchMode) ||
      (explicitEffort && explicitEffort !== this.launchEffort)
    ) {
      this.relaunch(
        explicitModel ?? this.info.currentModel?.modelID,
        explicitMode ?? this.info.currentMode,
        explicitEffort ?? this.info.currentModel?.reasoningEffort,
      );
    }
    this.running = true;
    this.emit({ type: 'status', status: 'running' });
    // Live driven turn starts now (stream events carry no native ts → broker wall clock). A turn = this user
    // send through the next `result`; message_start fires per assistant message so it is NOT the turn boundary.
    if (this.runtime) this.emit(this.runtime.startLive(`live${this.connNonce}.${++this.liveTurnSeq}`, Date.now()));
    // The child rewrites this send as a transcript user line with no id we control, so the echo
    // stays unstamped (clientMessageId unused); the client's narrow legacy reconcile converges it.
    this.writeLine({ type: 'user', message: { role: 'user', content } });
  }

  /** Deliver a standalone uploaded file to the driven session (no accompanying text). */
  async sendFile(file: FileInput): Promise<void> {
    await this.sendPrompt({ text: '', files: [file] });
  }

  /** Stage an uploaded file into <cwd>/.cosyncing/inbox/<dedup-name>; returns the absolute path (or null).
   *  basename-only → no path traversal; numeric suffix avoids clobbering an existing inbox file. */
  private writeInboxFile(file: FileInput): string {
    if (!this.info.cwd) throw new Error('Claude attachment delivery requires a workspace.');
    const inbox = resolve(this.info.cwd, PRODUCT_IDENTITY.repositoryDirectoryName, 'inbox');
    if (file.brokerPath) {
      const brokerPath = resolve(file.brokerPath);
      if (dirname(brokerPath) !== inbox || !existsSync(brokerPath)) {
        throw new Error('Claude rejected an untrusted broker attachment path.');
      }
      return brokerPath;
    }
    if (typeof file.data !== 'string') {
      throw new Error('Claude attachment bytes are missing.');
    }
    try {
      mkdirSync(inbox, { recursive: true });
      const base = basename(String(file.name || 'upload')) || 'upload';
      let safe = base;
      for (let n = 2; existsSync(join(inbox, safe)); n++) {
        const ext = extname(base);
        safe = `${ext ? base.slice(0, -ext.length) : base}-${n}${ext}`;
      }
      const abs = join(inbox, safe);
      writeFileSync(abs, Buffer.from(String(file.data ?? ''), 'base64'));
      return abs;
    } catch (error) {
      throw new Error(`Claude could not materialize attachment ${file.name}: ${String(error)}`);
    }
  }

  private relaunch(model?: string, mode?: string, effort?: string): void {
    this.killProc();
    this.stdoutBuf = ''; // drop any partial fragment from the prior child so it can't bleed into the new stream
    this.blockAccum.clear();
    this.blockKind.clear();
    // A broker-created session has no transcript on its very first launch → START it (--session-id)
    // rather than --resume; once that first turn materializes the file, later (re)launches resume normally.
    const targetUuid = this.liveUuid;
    const targetPath = this.liveTranscriptPath();
    // `fresh: true` bypasses the owner-map TTL — "quit the TUI, then press send" must resume in place
    // immediately, not fork off a stale 4s-old owner snapshot.
    const fork = targetUuid === this.uuid && liveTerminalOwner(this.store, this.uuid, { fresh: true }) !== null;
    const args = resumeArgs(targetUuid, { model, mode, effort, isDefault: this.store.isDefault, fresh: !existsSync(targetPath), fork });
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(this.store.bin, args, {
        // `claude --resume <uuid>` is CWD-SCOPED — it only finds a session belonging to the current
        // directory's project, so we MUST launch in the session's own cwd or resume fails with "No
        // conversation found" (and the turn should run in its workspace anyway).
        cwd: this.info.cwd && existsSync(this.info.cwd) ? this.info.cwd : undefined,
        // Cost safety: default store drives on subscription OAuth — scrub any inherited API key/token
        // so a drive never silently bills the API; wrappers keep their env (own endpoint auth).
        env: resumeEnv(this.store),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      this.emit({ type: 'error', message: 'Claude launch failed: ' + String(e) });
      return;
    }
    this.proc = proc;
    this.launchModel = model;
    this.launchMode = mode;
    this.launchEffort = effort;
    proc.stdout.on('data', (b: Buffer) => this.onStdout(b));
    proc.stderr.on('data', () => {/* surfaced via result/exit */});
    proc.on('error', (e) => this.emit({ type: 'error', message: 'Claude process error: ' + String(e) }));
    proc.on('exit', () => {
      // A child we've already replaced (mid-turn model/mode relaunch) exits LATER — its exit must be a
      // no-op, or it would emit a spurious 'idle' for the NEW turn (flipping the UI idle + hiding Stop
      // until the new child's result). Only the CURRENT child's exit ends the turn.
      if (this.proc !== proc) return;
      this.proc = undefined;
      // The child is gone — any pending permission/question can no longer be answered into it; clear them
      // so getPending() never replays a dead card and an answer can't be written to a closed stdin.
      if (this.pendingQuestionId) {
        this.emit({ type: 'question-resolved', requestId: this.pendingQuestionId });
        this.pendingQuestionId = undefined;
        this.pendingQuestionCard = undefined;
      }
      this.pendingQuestionControlId = undefined;
      this.pendingQuestionControlInput = undefined;
      this.pendingPermId = undefined;
      this.pendingPermCard = undefined;
      this.pendingPermInput = undefined;
      if (this.running) {
        this.running = false;
        this.emit({ type: 'status', status: 'idle' });
      }
    });
  }

  private writeLine(obj: unknown): void {
    try {
      this.proc?.stdin.write(JSON.stringify(obj) + '\n');
    } catch {
      /* process gone */
    }
  }

  private onStdout(b: Buffer): void {
    this.stdoutBuf += this.decoder.decode(b, { stream: true });
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) !== -1) {
      const raw = this.stdoutBuf.slice(0, nl);
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      const o = parseLineOrNull(raw);
      if (!o) continue;
      try {
        this.handleEvent(o); // isolate a mapper exception so one bad event can't kill the stdout pump
      } catch {
        /* skip a malformed/unexpected event shape */
      }
    }
  }

  /** Map ONE stream-json event to canonical messages. assistant/user/system reuse the verified
   *  transcript mappers ({@link mapLine}); result carries the authoritative final usage+cost; an
   *  init event provides the real slash-command set; a control_request is a mid-turn permission ask. */
  private handleEvent(o: any): void {
    switch (o.type) {
      case 'system':
        if (o.subtype === 'init') {
          this.ingestInit(o);
          return;
        }
        for (const m of mapLine(o, this.callMeta, this.seenTokenIds)) this.emit(m); // compact_boundary etc.
        return;
      case 'assistant':
        accumulateCallMeta(o, this.callMeta);
        collectParentActivity(o, this.resolvedToolUseIds, this.backgroundToolUseIds, this.notifiedToolUseIds, this.backgroundSpawnMs, this.parentActivity());
        if (this.taskLedger) for (const m of this.taskLedger.feed(o)) this.emit(m);
        // Final, authoritative blocks — re-emitted under the streamed deltas' key so they REPLACE the
        // accumulation (idempotent), plus tool-calls. token-count comes from `result` (with cost).
        this.emitFinalAssistant(o);
        return;
      case 'user':
        accumulateCallMeta(o, this.callMeta);
        collectParentActivity(o, this.resolvedToolUseIds, this.backgroundToolUseIds, this.notifiedToolUseIds, this.backgroundSpawnMs, this.parentActivity());
        if (this.taskLedger) for (const m of this.taskLedger.feed(o)) this.emit(m);
        for (const m of mapLine(o, this.callMeta, this.seenTokenIds)) this.emit(m);
        return;
      case 'stream_event':
        this.handleStreamEvent(o.event); // token-by-token deltas from --include-partial-messages
        return;
      case 'result': {
        const u = o.usage;
        if (u && typeof u === 'object') {
          this.emit({
            type: 'token-count',
            input: typeof u.input_tokens === 'number' ? u.input_tokens : undefined,
            output: typeof u.output_tokens === 'number' ? u.output_tokens : undefined,
            cacheRead: typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : undefined,
            cacheWrite: typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : undefined,
            cost: typeof o.total_cost_usd === 'number' ? o.total_cost_usd : undefined,
          });
        }
        if (o.is_error && typeof o.result === 'string' && o.result) this.emit({ type: 'error', message: oneLine(o.result) });
        // Turn over → the NEXT assistant event without a message_start is a local-command reply, not a
        // late per-block re-delivery of this turn's streamed message (see emitFinalAssistant).
        this.streamedThisMessage = false;
        this.streamedFinalTexts.clear();
        // Close the live driven turn with authoritative result usage/cost (doc-15 run-summary + runtimeTotals).
        if (this.runtime) {
          const tk = u && typeof u === 'object'
            ? { input: numOrUndef(u.input_tokens), output: numOrUndef(u.output_tokens), cacheRead: numOrUndef(u.cache_read_input_tokens), cacheWrite: numOrUndef(u.cache_creation_input_tokens), cost: typeof o.total_cost_usd === 'number' ? o.total_cost_usd : undefined }
            : undefined;
          for (const m of this.runtime.finishLive(o.is_error ? 'error' : 'done', Date.now(), tk)) this.emit(m);
        }
        // Turn over → any still-open question died with it (interrupt while blocked on the gate): resolve
        // the card so getPending never replays it, and drop the stale control id (its gate no longer exists).
        if (this.pendingQuestionId) {
          this.emit({ type: 'question-resolved', requestId: this.pendingQuestionId });
          this.pendingQuestionId = undefined;
          this.pendingQuestionCard = undefined;
        }
        this.pendingQuestionControlId = undefined;
        this.pendingQuestionControlInput = undefined;
        this.running = false;
        this.emit({ type: 'status', status: 'idle' });
        return;
      }
      case 'control_request': {
        // A mid-turn permission ask (spawned with --permission-prompt-tool stdio, so the CLI BLOCKS
        // the tool until our control_response). Surface it; respondPermission replies.
        const id = String(o.request_id ?? o.requestId ?? '');
        const req = o.request ?? {};
        if (id && (req.subtype === 'can_use_tool' || req.subtype === 'permission') && req.tool_name === 'AskUserQuestion') {
          // A question is NOT a permission ask — never show Allow/Deny for it. The CLI blocks the tool
          // until our control_response; answerQuestion replies allow + updatedInput.answers. The card
          // itself normally already streamed from the assistant tool_use event (keyed by tool_use_id,
          // which this request echoes back) — emit one here only if that ordering ever inverts.
          this.pendingQuestionControlId = id;
          this.pendingQuestionControlInput = req.input;
          const toolUseId = String(req.tool_use_id ?? '') || id;
          if (this.pendingQuestionId !== toolUseId) {
            const q = askUserQuestionCard({ id: toolUseId, input: req.input }, false);
            if (q) {
              this.pendingQuestionId = q.requestId;
              this.pendingQuestionCard = q;
              this.emit(q);
            } else {
              this.pendingQuestionId = toolUseId; // malformed questions: still answerable/rejectable by id
            }
          }
          return;
        }
        if (id && (req.subtype === 'can_use_tool' || req.subtype === 'permission')) {
          this.pendingPermId = id;
          this.pendingPermInput = req.input; // echoed back as updatedInput on allow (verified shape, 2.1.207)
          // Real payload (probed): tool_name, description ("Run sudo -n whoami"), input.command,
          // decision_reason — show the user WHAT they are approving, not a bare tool name.
          const detailParts = [
            typeof req.description === 'string' ? req.description : undefined,
            typeof req.input?.command === 'string' && req.input.command !== req.description?.replace(/^Run /, '') ? `$ ${req.input.command}` : undefined,
            typeof req.decision_reason === 'string' ? req.decision_reason : typeof req.explanation === 'string' ? req.explanation : undefined,
          ].filter(Boolean);
          this.pendingPermCard = {
            type: 'permission-request',
            requestId: id,
            title: String(req.tool_name ?? req.toolName ?? 'Permission request'),
            detail: detailParts.length ? detailParts.join('\n') : undefined,
          };
          this.emit(this.pendingPermCard);
        }
        return;
      }
      default:
        return;
    }
  }

  /** The key one streamed block carries on BOTH its deltas and its final. The stream event's own `index`
   *  is the message's content-block ordinal, which is exactly what the transcript's sibling lines
   *  reconstruct — so this is the same string a history read of the same message produces. */
  private liveBlockKey(idx: number, kind?: 'text' | 'thinking'): string {
    if (this.curMsgId && kind) return claudeBlockKey(this.curMsgId, idx, kind === 'thinking' ? 'r' : 't');
    return `${this.curKey || 'r0'}:${idx}`;
  }

  /** Token-by-token streaming from `--include-partial-messages`. Each block keys by its STREAM index:
   *  deltas stream live and are also ACCUMULATED, then on content_block_stop the full text is emitted as
   *  final (markdown render) under the same key — so there's exactly one bubble per block and the index
   *  always matches (unlike the proxy's per-block assistant events, which collapse every block to
   *  content[0]). Tool calls are NOT finalized here — they come whole from the assistant event. */
  private handleStreamEvent(ev: any): void {
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'message_start') {
      this.streamedThisMessage = true;
      this.streamedFinalTexts.clear(); // new message → the previous message's finalized texts are stale
      this.curMsgId = typeof ev.message?.id === 'string' ? ev.message.id : '';
      this.curKey = 'r' + ++this.turnSeq;
      this.blockAccum.clear();
      this.blockKind.clear();
      return;
    }
    const idx = typeof ev.index === 'number' ? ev.index : 0;
    if (ev.type === 'content_block_delta') {
      const d = ev.delta;
      if (d?.type === 'text_delta' && typeof d.text === 'string') {
        this.blockKind.set(idx, 'text');
        this.blockAccum.set(idx, (this.blockAccum.get(idx) ?? '') + d.text);
        this.emit({ type: 'model-output', delta: d.text, key: this.liveBlockKey(idx, 'text') });
      } else if (d?.type === 'thinking_delta' && typeof d.thinking === 'string') {
        this.blockKind.set(idx, 'thinking');
        this.blockAccum.set(idx, (this.blockAccum.get(idx) ?? '') + d.thinking);
        this.emit({ type: 'thinking', delta: d.thinking, key: this.liveBlockKey(idx, 'thinking') });
      }
      // input_json_delta (tool args) not streamed — the tool-call is emitted whole from the assistant event
    } else if (ev.type === 'content_block_stop') {
      const kind = this.blockKind.get(idx);
      const text = this.blockAccum.get(idx) ?? '';
      const key = this.liveBlockKey(idx, kind);
      if (kind === 'text' && text.trim()) {
        this.emit({ type: 'model-output', text, final: true, key });
        this.streamedFinalTexts.add(text); // so emitFinalAssistant's unstreamed fallback can't re-emit it
      }
      else if (kind === 'thinking' && text.trim()) this.emit({ type: 'thinking', text, key });
      this.blockAccum.delete(idx);
      this.blockKind.delete(idx);
    }
    // content_block_start, message_delta/stop → no-op
  }

  /** The assistant event contributes ONLY tool-calls (text/thinking are finalized from the stream — see
   *  handleStreamEvent): the proxy's per-block assistant events collapse each block to content[0], so
   *  their array index is unreliable, but tool-calls key by callId (index-independent). Records callMeta
   *  so the following user tool_result can resolve its tool name. token-count comes from `result`. */
  private emitFinalAssistant(o: any): void {
    const msg = o?.message;
    if (!msg) return;
    const content = Array.isArray(msg.content) ? msg.content : [];
    // Streamed text arrives via stream_events (deltas → finalized on content_block_stop), so the
    // final assistant event normally re-emits only tool_use blocks. But a LOCAL command's reply
    // (e.g. /compact's "Not enough messages to compact.") is emitted as one assistant event with NO
    // preceding message_start/deltas — without this branch the user gets zero feedback (issues-part1).
    // `streamedThisMessage` stays true from message_start until the turn's `result` (NOT consumed per
    // assistant event): third-party proxies (claude-mi/MiMo) split one streamed message into PER-BLOCK
    // assistant events, and consuming the flag on the first (thinking) event made the text event look
    // unstreamed — the reply rendered twice (issues-part2). A local command's reply arrives after the
    // previous result with no message_start, so the fallback below still fires for it.
    if (!this.streamedThisMessage) {
      // No stream events for this message, so the event's own content array IS the block layout — its
      // index is the same ordinal the transcript reconstructs, so an id-carrying event keys canonically
      // and an unstreamed reply that also reaches the transcript stays one row.
      const mid = String(msg.id ?? `t${this.turnSeq}`);
      content.forEach((b: any, i: number) => {
        // streamedFinalTexts: belt-and-braces vs any proxy that re-delivers already-finalized text.
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim() && !this.streamedFinalTexts.has(b.text))
          this.emit({ type: 'model-output', key: msg.id ? claudeBlockKey(mid, i, 't') : `local:${mid}:${i}`, text: b.text });
      });
    }
    for (const b of content) {
      if (b?.type === 'tool_use') {
        this.callMeta.set(String(b.id ?? ''), { name: String(b.name ?? 'tool'), input: b.input });
        // A live AskUserQuestion is ACTIONABLE under Drive: surface a question-request the app can answer
        // (answerQuestion → a tool_result on stdin, the native channel) and track it for getPending replay.
        const q = b.name === 'AskUserQuestion' ? askUserQuestionCard(b, false) : null;
        if (q) {
          this.pendingQuestionId = q.requestId;
          this.pendingQuestionCard = q;
          this.emit(q);
        } else {
          if (b.name === 'TodoWrite') {
            const t = todoListState(b);
            if (t) this.emit(t);
            continue;
          }
          if (taskToolKind(b.name, b.input)) continue;
          const toolName = String(b.name ?? 'tool');
          const semantic = claudeToolSemantic(toolName, b.input, undefined, { hasResult: false });
          this.emit({ type: 'tool-call', callId: String(b.id ?? ''), toolName, toolClass: claudeToolDisplayClass(toolName), args: b.input, ...(semantic ? { semantic } : {}) });
        }
      }
    }
  }

  private ingestInit(o: any): void {
    const sc = Array.isArray(o.slash_commands) ? o.slash_commands : [];
    const builtin = new Set(CLAUDE_BUILTIN_COMMANDS.filter((c) => c.kind === 'action').map((c) => c.name));
    this.initCommands = [
      { name: 'stop', kind: 'action', description: 'Interrupt the current turn' },
      ...sc
        .filter((n: any) => typeof n === 'string' && n)
        .map((n: string): SlashCommand => ({ name: n, kind: builtin.has(n) ? 'action' : 'prompt' })),
    ];
    this.emit({ type: 'event', name: 'init', payload: { model: o.model, permissionMode: o.permissionMode, effort: o.effort } });
    // Seed the authoritative runtime model/mode/effort so omitted-field turns reassert them (doc-12
    // currentModel/Mode). `init` is the source of truth for the effort claude launched with when it reports
    // one; otherwise preserve the effort already chosen so a model re-seed doesn't drop it.
    const initEffort = typeof o.effort === 'string' && o.effort ? o.effort : this.info.currentModel?.reasoningEffort;
    // Preserve the exact model id reported by init as resolved-session identity. Curated aliases remain
    // selection inputs only; they must not replace the concrete model a running session actually reports.
    if (typeof o.model === 'string' && o.model) {
      this.info.model = o.model;
      this.info.currentModel = {
        providerID: this.store.isDefault ? 'anthropic' : 'wrapper',
        modelID: o.model,
        ...(initEffort ? { reasoningEffort: initEffort } : {}),
      };
      this.emit({
        type: 'metadata-update',
        key: 'sessionInfo',
        value: {
          model: o.model,
          currentModel: this.info.currentModel,
        },
      });
    }
    if (typeof o.permissionMode === 'string' && o.permissionMode) this.info.currentMode = o.permissionMode;
    // `--fork-session` runs under a NEW uuid; its live subagents/workflows hang off that uuid's dir.
    // Re-point the activity watcher there once the process reports its (forked) session id.
    const sid = typeof o.session_id === 'string' ? o.session_id : typeof o.sessionId === 'string' ? o.sessionId : undefined;
    if (sid && sid !== this.liveUuid) {
      this.liveUuid = sid;
      if (sid !== this.uuid) {
        // A silent fork was the issues-part2 divergence trap: the TUI kept the ORIGINAL uuid, our
        // Sync-TUI notice cited the original too, and Claude's /resume picker hides sdk-created
        // sessions — so the driven turns looked simply lost. Say it loudly and hand the app the
        // CURRENT uuid (`liveUuid`) so every "resume in terminal" hint targets the fork.
        this.emit({
          type: 'notice',
          message: `Your terminal still owns the original session, so driving continues in a fork. This conversation now lives at uuid ${sid} — to follow it in a terminal, quit the old TUI and run: ${claudeResumeTerminalCommand(sid, this.info.cwd)}`,
        });
        (this.info as { liveUuid?: string }).liveUuid = sid; // direct too — the hub merge only covers hub-managed paths
        // Keep the generic terminalSync command pointing at the fork uuid so the app's resume tip is
        // correct without a tool-name branch (the hub Object.assign-merges the control we send here).
        if (this.info.control?.terminalSync) this.info.control.terminalSync.command = claudeResumeTerminalCommand(sid, this.info.cwd);
        this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { liveUuid: sid, ...(this.info.control ? { control: this.info.control } : {}) } });
      }
    }
    if (sid && sid !== this.uuid && this.activity) this.activity.repoint(join(dirname(this.path), sid));
  }

  async respondPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    if (!requestId) return;
    // Verified reply shapes (2.1.207 probe): allow echoes the tool input back as updatedInput and the
    // gated tool RUNS; deny carries a message the model reads as the refusal reason.
    const isDeny = decision === 'reject';
    const updatedInput = this.pendingPermId === requestId ? this.pendingPermInput : undefined;
    this.writeLine({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: isDeny
          ? { behavior: 'deny', message: `Denied from the ${PRODUCT_IDENTITY.productName} app` }
          : { behavior: 'allow', ...(updatedInput !== undefined ? { updatedInput } : {}) },
      },
    });
    this.emit({ type: 'permission-resolved', requestId, decision });
    if (this.pendingPermId === requestId) {
      this.pendingPermId = undefined;
      this.pendingPermCard = undefined;
      this.pendingPermInput = undefined;
    }
  }

  /** Answer an AskUserQuestion through its NATIVE channel — a user-turn tool_result keyed to the
   *  tool_use_id, NOT a new prompt (doc-12 Drive 'Question input'). `answers` is one array of selected
   *  labels per question; we join them into the tool_result text the model reads back. */
  async answerQuestion(requestId: string, answers: string[][]): Promise<void> {
    if (!requestId) return;
    const clearPending = () => {
      if (this.pendingQuestionId === requestId) {
        this.pendingQuestionId = undefined;
        this.pendingQuestionCard = undefined;
      }
    };
    // No live child → the question's turn already ended; clear the card but DON'T fake a running turn
    // against a dead stdin (the tool_result would be silently dropped).
    if (!this.proc) {
      this.emit({ type: 'question-resolved', requestId });
      clearPending();
      this.pendingQuestionControlId = undefined;
      this.pendingQuestionControlInput = undefined;
      return;
    }
    // Control-gated question (--permission-prompt-tool stdio, the normal drive case): the ONLY channel
    // the model receives choices through is the control_response's updatedInput.answers ({question text
    // → joined labels}) — the CLI then runs the tool natively ("Your questions have been answered: …").
    // An injected tool_result is ignored once the tool self-resolves (probed 2.1.207; maintainer's repro).
    if (this.pendingQuestionControlId && this.pendingQuestionId === requestId) {
      const input = this.pendingQuestionControlInput ?? {};
      const qs = Array.isArray(input.questions) ? input.questions : [];
      const map: Record<string, string> = {};
      qs.forEach((q: any, i: number) => {
        const a = answers?.[i];
        const text = Array.isArray(a) ? a.filter(Boolean).join(', ') : String(a ?? '');
        if (q?.question && text) map[String(q.question)] = text;
      });
      this.writeLine({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: this.pendingQuestionControlId,
          response: { behavior: 'allow', updatedInput: { ...input, answers: map } },
        },
      });
      this.pendingQuestionControlId = undefined;
      this.pendingQuestionControlInput = undefined;
      this.emit({ type: 'question-resolved', requestId });
      clearPending();
      this.running = true;
      this.emit({ type: 'status', status: 'running' });
      return;
    }
    const text = (Array.isArray(answers) ? answers : [])
      .map((a) => (Array.isArray(a) ? a.filter(Boolean).join(', ') : String(a ?? '')))
      .filter(Boolean)
      .join('\n');
    this.writeLine({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: requestId, content: text || '(no selection)' }] },
    });
    this.emit({ type: 'question-resolved', requestId });
    clearPending();
    this.running = true;
    this.emit({ type: 'status', status: 'running' });
  }

  /** Dismiss an open question without choosing — an is_error tool_result so the model moves on. A
   *  control-gated question is instead released with a plain allow (no answers): the tool self-resolves
   *  natively as "The user did not answer the questions." — the honest dismissal the model understands. */
  async rejectQuestion(requestId: string): Promise<void> {
    if (!requestId) return;
    if (this.pendingQuestionControlId && this.pendingQuestionId === requestId) {
      this.writeLine({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: this.pendingQuestionControlId,
          response: { behavior: 'allow', updatedInput: this.pendingQuestionControlInput ?? {} },
        },
      });
      this.pendingQuestionControlId = undefined;
      this.pendingQuestionControlInput = undefined;
    } else {
      this.writeLine({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: requestId, content: '(question dismissed by the user)', is_error: true }] },
      });
    }
    this.emit({ type: 'question-resolved', requestId });
    if (this.pendingQuestionId === requestId) {
      this.pendingQuestionId = undefined;
      this.pendingQuestionCard = undefined;
    }
  }

  getPending(): AgentMessage[] {
    const out: AgentMessage[] = [];
    if (this.pendingPermId) out.push(this.pendingPermCard ?? { type: 'permission-request', requestId: this.pendingPermId, title: 'Permission request' });
    if (this.pendingQuestionCard) out.push(this.pendingQuestionCard);
    return out;
  }

  async listModels(): Promise<ModelOption[]> {
    return claudeModelOptions(this.store);
  }
  async listModes(): Promise<ModeOption[]> {
    return CLAUDE_PERMISSION_MODES;
  }
  async listCommands(): Promise<SlashCommand[]> {
    return this.initCommands ?? scanDiskCommands(this.store, this.info.cwd);
  }

  async runCommand(name: string, args?: string): Promise<CommandResult | void> {
    if (name === 'stop' || name === 'abort') {
      this.killProc();
      if (this.running) {
        this.running = false;
        this.emit({ type: 'status', status: 'idle' });
      }
      return { notice: 'Interrupted the current turn.' };
    }
    // Any other slash command → send it as a turn-starting user message (Claude handles it in-stream).
    await this.sendPrompt({ text: `/${name}${args ? ' ' + args : ''}` });
  }

  private killProc(): void {
    const p = this.proc;
    this.proc = undefined;
    if (!p) return;
    try {
      p.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      p.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }

  async close(): Promise<void> {
    this.killProc();
    if (this.echoTailTimer) {
      this.drainUserEcho(); // flush the final delivery echo (the child's last write can precede close by <1s)
      clearInterval(this.echoTailTimer);
      this.echoTailTimer = undefined;
    }
    this.echoTailBuf = '';
    this.activity?.close();
    this.activity = undefined;
    this.handlers.clear();
    this.callMeta.clear();
    this.seenTokenIds.clear();
    this.resolvedToolUseIds.clear();
    this.backgroundToolUseIds.clear();
    this.notifiedToolUseIds.clear();
    this.backgroundSpawnMs.clear();
    this.killedAgentIds.clear();
    this.agentIdToToolUseId.clear();
    this.stopRequests.clear();
  }

  private parentActivity(): ParentActivityState {
    return {
      backgroundToolUseIds: this.backgroundToolUseIds,
      notifiedToolUseIds: this.notifiedToolUseIds,
      backgroundSpawnMs: this.backgroundSpawnMs,
      killedAgentIds: this.killedAgentIds,
      agentIdToToolUseId: this.agentIdToToolUseId,
      stopRequests: this.stopRequests,
    };
  }
}

// ── transcript mapping (exported for the headless test) ─────────────────────────

export interface ClaudeCall {
  name: string;
  input?: unknown;
}

/** Canonical rich-detail recovered from a `toolUseResult`. */
export interface ClaudeEnrich {
  path?: string;
  diff?: string;
  fileChanges?: FileChange[];
  additions?: number;
  deletions?: number;
  truncated?: boolean;
  title?: string;
}

/** Record any tool_use blocks on an assistant line into the call map (id → name/input). */
export function accumulateCallMeta(ln: any, map: Map<string, ClaudeCall>): void {
  if (ln?.type !== 'assistant') return;
  const content = ln.message?.content;
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (b?.type === 'tool_use' && b.id != null) {
      map.set(String(b.id), { name: String(b.name ?? 'tool'), input: b.input });
    }
  }
}

/** message.id for a turn (token-count dedup key); '' if absent. */
function messageId(ln: any): string {
  return ln?.type === 'assistant' && ln.message?.id != null ? String(ln.message.id) : '';
}

/** A block's dedup key: the line uuid when it's the only block, else `<uuid>:<index>`. Only reachable
 *  when the line carries no `message.id` — see {@link claudeBlockKey}. */
function blockKey(uuid: string, i: number, len: number): string {
  return len > 1 ? `${uuid}:${i}` : uuid;
}

/** The identity ONE model text/thinking block has on every surface: the API message id it belongs to,
 *  its content-block ordinal within that message, and the block kind. Live streaming reads both parts
 *  off `message_start.message.id` + the stream event's own `index`; the transcript reads the same id off
 *  `message.id` and reconstructs the ordinal (see {@link ClaudeBlockOrdinals}). The line uuid CANNOT
 *  serve here — Claude Code splits one API message across sibling lines with distinct uuids, so the live
 *  stream has no counterpart for it and the same message crosses the attach boundary as two rows. */
function claudeBlockKey(messageId: string, ordinal: number, kind: 't' | 'r'): string {
  return `claude:${messageId}:${ordinal}:${kind}`;
}

/** Per-`message.id` content-block ordinals, reconstructed from transcript lines in file order.
 *  Claude Code writes one API message as one-or-more SIBLING lines, each holding a slice of the same
 *  content array, and the line records neither the message's block count nor its own offset into it —
 *  so the ordinal only exists as a running count that must CONTINUE across sibling lines and inside a
 *  line holding several blocks. EVERY block type is counted (tool_use lines included) because the live
 *  `index` this reconstructs is the raw content-array index. `byUuid` makes re-feeding a line
 *  idempotent, so a whole-file history read and the live tail that continues after it agree even when
 *  they overlap (a resync re-reads lines the tail already consumed). */
export type ClaudeBlockOrdinals = { next: Map<string, number>; byUuid: Map<string, number> };
export function newClaudeBlockOrdinals(): ClaudeBlockOrdinals {
  return { next: new Map(), byUuid: new Map() };
}

/** Reserve this line's slice of its message's block ordinals and return the ordinal of its FIRST block;
 *  undefined when the canonical identity is unavailable (no state threaded, or a line with no
 *  `message.id`) and the caller must stay on {@link blockKey}. A fallback costs the duplicate this
 *  identity removes; a wrong ordinal would MERGE two genuine blocks, so never invent one. */
function claimBlockOrdinals(state: ClaudeBlockOrdinals | undefined, messageId: string, uuid: string, blocks: number): number | undefined {
  if (!state || !messageId) return undefined;
  const already = uuid ? state.byUuid.get(uuid) : undefined;
  if (already !== undefined) return already;
  const base = state.next.get(messageId) ?? 0;
  state.next.set(messageId, base + blocks);
  if (uuid) state.byUuid.set(uuid, base);
  return base;
}

/** Mid-run queued sends awaiting delivery. An `enqueue` registers text→key; the later REAL user line
 *  with the same text TAKES OVER that key, so the app upserts the dimmed "queued" bubble into a normal
 *  one in place (issues-part2 item-12 follow-up: the queued identifier must clear once the message is
 *  actually delivered). A `remove` op (the CLI dropped it at turn end — verified live 2.1.202) retires
 *  the oldest pending entry so its bubble honestly stays marked queued and a LATER identical prompt
 *  can't steal its key. `byUuid` makes re-mapping the same user line idempotent (stdout + tail can both
 *  deliver it). Keys derive from the enqueue line itself (`queued:<ts>:<len>`) so the history pass and
 *  the live tail — separate state objects — agree on them. */
export type ClaudeQueuedSends = { pending: { text: string; key: string }[]; byUuid: Map<string, string> };
export function newClaudeQueuedSends(): ClaudeQueuedSends {
  return { pending: [], byUuid: new Map() };
}

/** True for an enqueue record worth showing (typed words, not harness noise; DRIVEN-session enqueues
 *  carry NO content field at all — probed live 2.1.207 — and are skipped here). */
function isRenderableEnqueue(ln: any): boolean {
  return ln.operation === 'enqueue' && typeof ln.content === 'string' && !!ln.content.trim() && !isWrapper(ln.content) && !/^<task-notification>|^<system-reminder>/.test(ln.content.trim());
}
function queuedSendKey(ln: any): string {
  return `queued:${String(ln.timestamp ?? '')}:${String(ln.content).trim().length}`;
}

/** Feed a transcript line into the queued-sends state WITHOUT emitting (used to seed a live tail from
 *  history it does not re-map, and internally by {@link mapLine}/{@link mapUser}). */
export function feedQueuedSends(state: ClaudeQueuedSends, ln: any): void {
  if (!ln || typeof ln !== 'object') return;
  if (ln.type === 'queue-operation') {
    if (isRenderableEnqueue(ln)) state.pending.push({ text: String(ln.content).trim(), key: queuedSendKey(ln) });
    else if (ln.operation === 'remove') state.pending.shift(); // dropped without delivery — retire FIFO
    return;
  }
  if (ln.type === 'user' && state.pending.length) {
    const c = ln.message?.content;
    const text = (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')).join('\n') : '').trim();
    if (text) takeQueuedSendKey(state, String(ln.uuid ?? ''), text);
  }
}

/** The delivered user line claims its pending enqueue's key (exact-text FIFO match); idempotent per
 *  line uuid. Returns undefined when this user line was never queued. */
function takeQueuedSendKey(state: ClaudeQueuedSends | undefined, uuid: string, text: string): string | undefined {
  if (!state) return undefined;
  if (uuid && state.byUuid.has(uuid)) return state.byUuid.get(uuid);
  const i = state.pending.findIndex((p) => p.text === text.trim());
  if (i < 0) return undefined;
  const key = state.pending.splice(i, 1)[0]!.key;
  if (uuid) state.byUuid.set(uuid, key);
  return key;
}

/**
 * Map ONE parsed transcript line to canonical messages (0..n). `callMeta` resolves a tool-result's
 * toolName; `seenTokenIds` dedupes token-count to once per message.id (it is MUTATED here).
 * `queuedSends` (optional, MUTATED) links a mid-run enqueue to the user line that later delivers it.
 * `blocks` (optional, MUTATED) carries the per-message.id block ordinals a text/thinking key needs; a
 * caller that maps lines OUT of file order must omit it rather than pass a fresh one — an ordinal
 * counted from the wrong start would merge two genuine blocks.
 */
export function mapLine(ln: any, callMeta: Map<string, ClaudeCall>, seenTokenIds: Set<string>, queuedSends?: ClaudeQueuedSends, blocks?: ClaudeBlockOrdinals): AgentMessage[] {
  if (!ln || typeof ln !== 'object') return [];
  switch (ln.type) {
    case 'assistant':
      return mapAssistant(ln, seenTokenIds, blocks);
    case 'user':
      return mapUser(ln, callMeta, queuedSends);
    case 'system':
      return mapSystem(ln);
    case 'queue-operation': {
      // A message typed while a turn runs exists ONLY as this sidecar record until (if ever) the CLI
      // submits it — the CLI can even silently drop it at turn end (verified live 2.1.202: enqueue →
      // remove, no user line, gone from the TUI too). Surface the enqueue as a keyed QUEUED user
      // bubble so the app never loses the user's words; when the real user line lands it takes over
      // the key (see mapUser) and the queued styling clears in place. A dropped message keeps its
      // dimmed bubble — honest "typed but never delivered".
      if (isRenderableEnqueue(ln)) {
        const key = queuedSendKey(ln);
        if (queuedSends) queuedSends.pending.push({ text: String(ln.content).trim(), key });
        const sentAt = timestampToMs(ln.timestamp);
        return [{ type: 'user-message', text: String(ln.content), key, queued: true, ...(sentAt !== undefined ? { sentAt } : {}) }];
      }
      if (ln.operation === 'remove' && queuedSends) queuedSends.pending.shift();
      return [];
    }
    default:
      return []; // sidecar/attachment/title types are not conversation
  }
}

type QuestionCard = Extract<AgentMessage, { type: 'question-request' }>;

/** Claude's first-party AskUserQuestion tool → the canonical question-request card. `readOnly` is true in
 *  Observe/history replay (the terminal owns the answer) and false on the live Drive turn (the app can
 *  answer via answerQuestion → a tool_result on the native channel). Returns null if there are no usable
 *  questions, so the caller falls back to a generic tool-call. `multiSelect` → `multiple`. */
function askUserQuestionCard(block: any, readOnly: boolean): QuestionCard | null {
  const requestId = String(block?.id ?? '');
  const raw = block?.input?.questions;
  if (!requestId || !Array.isArray(raw) || raw.length === 0) return null;
  const questions = raw
    .filter((q: any) => q && typeof q.question === 'string')
    .map((q: any) => ({
      question: String(q.question),
      header: typeof q.header === 'string' ? q.header : undefined,
      multiple: q.multiSelect === true,
      options: Array.isArray(q.options)
        ? q.options
            .filter((o: any) => o && typeof o.label === 'string')
            .map((o: any) => ({ label: String(o.label), description: typeof o.description === 'string' ? o.description : undefined }))
        : [],
    }));
  if (questions.length === 0) return null;
  return readOnly ? { type: 'question-request', requestId, readOnly: true, questions } : { type: 'question-request', requestId, questions };
}

/** The last AskUserQuestion in the transcript tail that has NOT yet been answered (no matching tool_result),
 *  as a READ-ONLY question-request — so a blocked OBSERVE session can surface the REAL question + options.
 *  The card's requestId is the tool_use id, so the app dedupes it against the same card already in history.
 *  Returns undefined if nothing is pending. CAVEAT (verified): this works only when the ASK line is on disk —
 *  a plain CLI session, or any session AFTER the turn flushes. A LIVE claude.ai-BRIDGE session BUFFERS its
 *  in-flight turn off-disk while it's blocked, so the pending question is NOT here yet → getPending() falls
 *  back to the honest notice (it cannot be rendered from local data). Permissions are never transcript events. */
function lastUnansweredQuestion(path: string): QuestionCard | undefined {
  const st = statSafe(path);
  if (!st) return undefined;
  const asked = new Map<string, any>();
  const order: string[] = [];
  const answered = new Set<string>();
  for (const seg of readTailLines(path, Math.min(st.size, 4 * 1024 * 1024))) {
    const o = parseLineOrNull(seg);
    if (!o) continue;
    if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
      for (const b of o.message.content) {
        if (b?.type === 'tool_use' && b.name === 'AskUserQuestion' && b.id) {
          asked.set(String(b.id), b);
          order.push(String(b.id));
        }
      }
    } else if (o.type === 'user' && Array.isArray(o.message?.content)) {
      for (const b of o.message.content) if (b?.type === 'tool_result' && b.tool_use_id) answered.add(String(b.tool_use_id));
    }
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]!;
    if (!answered.has(id)) {
      const card = askUserQuestionCard(asked.get(id), true);
      if (card) return card;
    }
  }
  return undefined;
}

/** Claude's TodoWrite tool → the canonical `task-list-state` panel (one upserted ledger, not a stack of raw
 *  tool cards). Item status maps pending→open, in_progress→in-progress, completed→done. A stable per-session
 *  key means each TodoWrite REPLACES the panel; an empty list clears it. */
export function todoListState(b: any): AgentMessage | null {
  const todos = Array.isArray(b?.input?.todos) ? b.input.todos : null;
  if (!todos) return null; // not a well-formed TodoWrite → let it fall through to a normal tool-call
  const items = todos
    .map((t: any) => {
      const title = String(t?.content ?? t?.activeForm ?? t?.title ?? '').trim();
      const status = t?.status === 'completed' ? 'done' : t?.status === 'in_progress' ? 'in-progress' : t?.status === 'cancelled' ? 'cancelled' : 'open';
      const item: { title: string; status: 'open' | 'in-progress' | 'done' | 'cancelled'; priority?: 'low' | 'normal' | 'high' } = { title, status };
      if (t?.priority === 'low' || t?.priority === 'high' || t?.priority === 'normal') item.priority = t.priority;
      return item;
    })
    .filter((it: { title: string }) => it.title);
  const allDone = items.length > 0 && items.every((it: { status: string }) => it.status === 'done');
  return {
    type: 'task-list-state',
    key: 'claude:todos',
    title: 'Tasks',
    status: items.length === 0 ? 'cleared' : allDone ? 'done' : 'running',
    source: 'tool-call',
    sourceTool: 'TodoWrite',
    items,
  };
}

/** Which task tool (TodoWrite's successor in Claude ≥2.1.19x) a tool_use is — null when malformed
 *  (a malformed call falls through to a normal tool-call row instead of being silently dropped). */
export function taskToolKind(name: unknown, input: any): 'create' | 'update' | 'query' | null {
  if (name === 'TaskCreate') return typeof input?.subject === 'string' && input.subject.trim() ? 'create' : null;
  if (name === 'TaskUpdate') return input?.taskId != null ? 'update' : null;
  if (name === 'TaskList' || name === 'TaskGet') return 'query';
  return null;
}

function taskResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('\n');
  return '';
}

/**
 * Claude ≥2.1.19x replaced the TodoWrite ledger with INCREMENTAL task tools: TaskCreate assigns the
 * task id in its RESULT text ("Task #1 created successfully: <subject>"), TaskUpdate mutates one task
 * by id (status pending|in_progress|completed|deleted, subject rename). Nothing in the transcript
 * carries the whole list, so this ledger accumulates the calls into ONE canonical task-list-state
 * panel (key 'claude:tasks') — the same surface TodoWrite maps to — and the raw tool rows are
 * suppressed in mapAssistant/mapUser (failed calls stay visible as error rows). Feed() is called per
 * transcript line (history pass and live tail alike) and returns the refreshed panel on each change.
 */
export class ClaudeTaskLedger {
  private readonly tasks = new Map<string, { id: string; title: string; status: 'open' | 'in-progress' | 'done' }>();
  private readonly pendingCreates = new Map<string, { subject: string }>();
  private readonly pendingUpdates = new Map<string, { taskId: string; status?: string; subject?: string }>();
  private fallbackId = 0;

  feed(ln: any): AgentMessage[] {
    const content = ln?.message?.content;
    if (!Array.isArray(content)) return [];
    if (ln.type === 'assistant') {
      for (const b of content) {
        if (b?.type !== 'tool_use' || b.id == null) continue;
        const kind = taskToolKind(b.name, b.input);
        if (kind === 'create') this.pendingCreates.set(String(b.id), { subject: String(b.input.subject).trim() });
        else if (kind === 'update') this.pendingUpdates.set(String(b.id), b.input);
      }
      return [];
    }
    if (ln.type !== 'user') return [];
    let changed = false;
    for (const b of content) {
      if (b?.type !== 'tool_result') continue;
      const cid = String(b.tool_use_id ?? '');
      const create = this.pendingCreates.get(cid);
      if (create) {
        this.pendingCreates.delete(cid);
        if (b.is_error === true) continue;
        // "Task #1 created successfully: <subject>" — the result text is the ONLY id source.
        const m = /#\s*([A-Za-z0-9_-]+)/.exec(taskResultText(b.content));
        const id = m ? m[1]! : `t${++this.fallbackId}`;
        this.tasks.set(id, { id, title: create.subject, status: 'open' });
        changed = true;
        continue;
      }
      const update = this.pendingUpdates.get(cid);
      if (update) {
        this.pendingUpdates.delete(cid);
        if (b.is_error === true) continue;
        const t = this.tasks.get(String(update.taskId));
        if (!t) continue;
        if (update.status === 'deleted') {
          this.tasks.delete(t.id);
        } else {
          if (update.status === 'pending') t.status = 'open';
          else if (update.status === 'in_progress') t.status = 'in-progress';
          else if (update.status === 'completed') t.status = 'done';
          if (typeof update.subject === 'string' && update.subject.trim()) t.title = update.subject.trim();
        }
        changed = true;
      }
    }
    return changed ? [this.state()] : [];
  }

  private state(): AgentMessage {
    const items = [...this.tasks.values()].map((t) => ({ id: t.id, title: t.title, status: t.status }));
    const allDone = items.length > 0 && items.every((it) => it.status === 'done');
    return {
      type: 'task-list-state',
      key: 'claude:tasks',
      title: 'Tasks',
      status: items.length === 0 ? 'cleared' : allDone ? 'done' : 'running',
      source: 'tool-call',
      sourceTool: 'TaskCreate',
      items,
    };
  }
}

function mapAssistant(ln: any, seenTokenIds: Set<string>, blocks?: ClaudeBlockOrdinals): AgentMessage[] {
  const msg = ln.message;
  if (!msg) return [];
  const uuid = String(ln.uuid ?? '');
  const content = Array.isArray(msg.content) ? msg.content : [];

  // An injected API-error bubble ("You've hit your session limit…") — surface as a single error.
  if (ln.isApiErrorMessage) {
    const text = firstText(content) || String(ln.error ?? msg.stop_reason ?? 'API error');
    return [{ type: 'error', message: oneLine(text) }];
  }

  // Text/thinking must land on the identity the live stream uses, or the same message crossing an attach
  // boundary renders twice. Ordinals are claimed for the WHOLE line (tool_use blocks included) so the
  // count stays aligned with the stream's content-block index.
  const base = claimBlockOrdinals(blocks, String(msg.id ?? ''), uuid, content.length);
  const out: AgentMessage[] = [];
  content.forEach((b: any, i: number) => {
    const key = blockKey(uuid, i, content.length);
    const textKey = base === undefined ? key : claudeBlockKey(String(msg.id), base + i, b?.type === 'text' ? 't' : 'r');
    if (b?.type === 'text') {
      if (typeof b.text === 'string' && b.text.trim()) out.push({ type: 'model-output', text: b.text, final: true, key: textKey });
    } else if (b?.type === 'thinking') {
      if (typeof b.thinking === 'string' && b.thinking.trim()) out.push({ type: 'thinking', text: b.thinking, key: textKey });
    } else if (b?.type === 'redacted_thinking') {
      out.push({ type: 'thinking', text: '[redacted reasoning]', key: textKey });
    } else if (b?.type === 'tool_use') {
      // The Workflow tool carries a multi-KB `script` arg (its full source) and is fully represented by the
      // canonical agent-activity bar (buildActivitySnapshot reads the sibling wf_*.json / journal tree), so
      // suppress the raw tool-call instead of dumping its source into the conversation — maintainer's "mostly
      // noise" bug. Mirrors the AskUserQuestion special-case below; the result row is suppressed in mapUser.
      if (b.name === 'Workflow') return; // skip this block; the activity bar is the surface
      // TodoWrite is a task ledger, not a generic tool call — surface it as ONE upserted task-list-state
      // panel (the result row is suppressed in mapUser). A malformed TodoWrite falls through to a tool-call.
      if (b.name === 'TodoWrite') { const t = todoListState(b); if (t) { out.push(t); return; } }
      // Its ≥2.1.19x successors (TaskCreate/TaskUpdate/TaskList/TaskGet) are ALSO panel-covered — the
      // ClaudeTaskLedger accumulates them into the same task-list-state surface — so suppress the raw
      // calls too; malformed ones fall through to a normal tool-call (mirrors TodoWrite).
      if (taskToolKind(b.name, b.input)) return;
      // AskUserQuestion is an interactive question, not a generic tool call — surface it as a read-only
      // question-request in Observe/history (the answer is owned by the terminal or the live Drive turn).
      const q = b.name === 'AskUserQuestion' ? askUserQuestionCard(b, true) : null;
      if (q) out.push(q);
      else {
        const toolName = String(b.name ?? 'tool');
        const semantic = claudeToolSemantic(toolName, b.input, undefined, { hasResult: false });
        out.push({ type: 'tool-call', callId: String(b.id ?? ''), toolName, toolClass: claudeToolDisplayClass(toolName), args: b.input, ...(semantic ? { semantic } : {}) });
      }
    } else if (b?.type === 'image') {
      const art = inlineImageArtifact(b, uuid, i); // an assistant-emitted inline image → render it
      if (art) out.push(art);
    }
  });

  // token-count ONCE per message.id (usage is byte-identical on every line of a multi-line turn).
  const id = messageId(ln);
  const u = msg.usage;
  if (id && u && typeof u === 'object' && !seenTokenIds.has(id)) {
    seenTokenIds.add(id);
    out.push({
      type: 'token-count',
      input: numOrUndef(u.input_tokens),
      output: numOrUndef(u.output_tokens),
      cacheRead: numOrUndef(u.cache_read_input_tokens),
      cacheWrite: numOrUndef(u.cache_creation_input_tokens),
    });
  }
  return out;
}

function mapUser(ln: any, callMeta: Map<string, ClaudeCall>, queuedSends?: ClaudeQueuedSends): AgentMessage[] {
  const msg = ln.message;
  if (!msg) return [];
  // The fat post-compaction summary injected as a user turn is machine context, not a real prompt.
  if (ln.isCompactSummary) return [];
  const uuid = String(ln.uuid ?? '');
  const content = msg.content;
  const sentAt = timestampToMs(ln.timestamp); // authoritative native send time (contract doc-15)

  if (typeof content === 'string') {
    if (ln.isMeta || !content.trim()) return [];
    // Slash-command sidecar lines (previously all wrapper-filtered to NOTHING — the user saw a /compact
    // succeed in the terminal and the app showed zero trace of it):
    //  - <command-name>/compact… → a clean "/compact args" user echo at its true position;
    //  - <local-command-stdout>Compacted … → the command's RESULT as a notice (the SUCCESS path writes
    //    stdout as a USER line — only failures come as system/local_command);
    //  - caveat/stderr/other wrappers stay suppressed.
    const cmdName = /<command-name>([^<]+)<\/command-name>/.exec(content)?.[1]?.trim();
    if (cmdName) {
      const args = /<command-args>([^<]*)<\/command-args>/.exec(content)?.[1]?.trim();
      return [{ type: 'user-message', text: args ? `${cmdName} ${args}` : cmdName, key: uuid, turnId: uuid, ...(sentAt !== undefined ? { sentAt } : {}) }];
    }
    const stdout = /<local-command-stdout[^>]*>([\s\S]*?)<\/local-command-stdout>/.exec(content)?.[1];
    if (stdout !== undefined) {
      const text = oneLine(stdout.replace(/\x1b?\[[0-9;]*m/g, '')).trim(); // strip the TUI's SGR color codes
      return text ? [{ type: 'notice', message: text }] : [];
    }
    if (isWrapper(content)) return [];
    if (isInterruptMarker(content)) {
      return [{
        type: 'notice',
        message: 'Interrupted by user.',
        semantic: {
          kind: 'interruption',
          reason: 'user',
        },
      }];
    }
    // A delivered mid-run queued message claims its enqueue bubble's key → the app clears the
    // queued styling in place instead of drawing a duplicate (item-12 follow-up).
    return [{ type: 'user-message', text: content, key: takeQueuedSendKey(queuedSends, uuid, content) ?? uuid, turnId: uuid, ...(sentAt !== undefined ? { sentAt } : {}) }];
  }
  if (!Array.isArray(content)) return [];

  const out: AgentMessage[] = [];
  let imageCount = 0;
  let sawToolResult = false;
  const texts: string[] = [];
  content.forEach((b: any, i: number) => {
    if (b?.type === 'tool_result') {
      const cid = String(b.tool_use_id ?? '');
      const call = cid ? callMeta.get(cid) : undefined;
      // Workflow: suppress the SUCCESS result row (its tool-call is suppressed in mapAssistant) — the canonical
      // agent-activity bar conveys done/error + rollups, so the raw return value is the same noise as the
      // script arg. BUT a FAILED LAUNCH (is_error: bad params / "Script parse error") writes NO sibling wf
      // tree, so buildActivitySnapshot renders NOTHING — suppressing it would leave the user with assistant
      // text then silence, no signal the workflow never started. Keep those as a normal error row (the run
      // never produced a bar to replace it). Verified on real data: 4/45 Workflow results were is_error.
      if (call?.name === 'Workflow' && b.is_error !== true) { sawToolResult = true; return; }
      // TodoWrite result is just an "updated" echo — the task-list-state panel (from the tool_use) is the
      // surface, so suppress the raw result row (mirrors Workflow). A FAILED TodoWrite stays as an error row.
      if (call?.name === 'TodoWrite' && b.is_error !== true) { sawToolResult = true; return; }
      // Same for its ≥2.1.19x successors (TaskCreate/TaskUpdate/TaskList/TaskGet): the ClaudeTaskLedger
      // panel is the surface; failures stay visible as error rows.
      if (call && taskToolKind(call.name, call.input) && b.is_error !== true) { sawToolResult = true; return; }
      // The answer to an AskUserQuestion clears the question card rather than rendering a tool-result row —
      // but ONLY when the original call actually produced a card. A malformed/empty AskUserQuestion fell
      // back to a generic tool-call (see mapAssistant), so its result must stay a normal tool-result, not
      // an orphan question-resolved for a card that was never shown.
      if (call?.name === 'AskUserQuestion' && askUserQuestionCard({ id: cid, input: call.input }, true)) out.push({ type: 'question-resolved', requestId: cid });
      else out.push(makeToolResult(ln, b, callMeta));
      sawToolResult = true;
    } else if (b?.type === 'image') {
      imageCount++; // keep the user-message chip count
      const art = inlineImageArtifact(b, uuid, i); // ALSO render the pasted/returned image
      if (art) out.push(art);
    } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      texts.push(b.text);
    }
    void i;
  });
  // A SendUserFile delivery puts its files on the line's toolUseResult — surface each as a file-artifact
  // (once per line; the app dedups by path). This is the agent→user file path the user expects to see.
  if (sawToolResult) out.push(...sendUserFileArtifacts(ln));
  const text = texts.join('\n').trim();
  if ((text || imageCount) && !ln.isMeta && !isWrapper(text)) {
    // An Esc-interrupt is recorded as a literal user message — render it like the TUI's own
    // "Interrupted by user" marker instead of a fake prompt bubble (issues-part2 interruption display).
    if (isInterruptMarker(text)) {
      out.push({
        type: 'notice',
        message: 'Interrupted by user.',
        semantic: {
          kind: 'interruption',
          reason: 'user',
        },
      });
    }
    else out.push({ type: 'user-message', text, imageCount: imageCount || undefined, key: takeQueuedSendKey(queuedSends, uuid, text) ?? `${uuid}:u`, turnId: uuid, ...(sentAt !== undefined ? { sentAt } : {}) });
  }
  return out;
}

/** Claude records an Esc-interrupt as a literal user text ("[Request interrupted by user]" /
 *  "…for tool use]"). */
function isInterruptMarker(s: string): boolean {
  return /^\[Request interrupted by user( for tool use)?\]$/.test(s.trim());
}

function makeToolResult(ln: any, block: any, callMeta: Map<string, ClaudeCall>): AgentMessage {
  const callId = String(block.tool_use_id ?? '');
  const call = callMeta.get(callId);
  const toolName = call?.name ?? 'tool';
  const tur = ln.toolUseResult;
  const isError = block.is_error === true || (tur && typeof tur === 'object' && tur.interrupted === true);
  const enr = enrichClaudeToolResult(toolName, tur, call?.input);
  const semantic = claudeToolSemantic(toolName, call?.input, tur, { hasResult: true, isError });
  return {
    type: 'tool-result',
    callId,
    toolName,
    toolClass: claudeToolDisplayClass(toolName),
    ...(semantic ? { semantic } : {}),
    isError,
    result: blockContentText(block.content),
    title: enr.title,
    path: enr.path,
    diff: enr.diff,
    fileChanges: enr.fileChanges,
    additions: enr.additions,
    deletions: enr.deletions,
    truncated: enr.truncated,
  };
}

/**
 * The one place Claude maps a native tool name to a normalized presentation
 * family. Downstream code — and every client — sees only the canonical family.
 *
 * `null` means "no dedicated family": the tool renders through the bounded
 * structured fallback, which is the honest outcome for an MCP or plugin tool
 * whose result shape this adapter cannot vouch for.
 */
function claudeToolFamily(toolName: string): 'command' | 'file-read' | 'search' | 'web' | null {
  switch (String(toolName || '')) {
    case 'Bash':
    case 'BashOutput':
      return 'command';
    case 'Read':
      return 'file-read';
    case 'Grep':
    case 'Glob':
      return 'search';
    case 'WebSearch':
    case 'WebFetch':
      return 'web';
    default:
      return null;
  }
}

/**
 * Claude tool call/result → the canonical normalized family.
 *
 * `tur` is the transcript's `toolUseResult`; it is absent on a still-running
 * call, in which case the semantic carries the call-time fields only (command
 * line, path, query) and a `running`/absent-result state.
 */
function claudeToolSemantic(
  toolName: string,
  callInput: any,
  tur: any,
  options: { hasResult: boolean; isError?: boolean },
): ToolSemantic | undefined {
  const family = claudeToolFamily(toolName);
  if (!family) return undefined;
  const input = callInput && typeof callInput === 'object' ? callInput : {};
  const result = tur && typeof tur === 'object' ? tur : undefined;
  switch (family) {
    case 'command': {
      // Claude records NO numeric exit code for Bash, so the lifecycle comes
      // from `interrupted` and the block's is_error — never a fabricated code.
      const state: ToolCommandState = result?.interrupted === true
        ? 'interrupted'
        : !options.hasResult
          ? 'running'
          : options.isError === true
            ? 'failed'
            : result === undefined
              ? 'unknown'
              : 'completed';
      return boundToolSemantic(commandSemantic({
        command: input.command,
        cwd: input.cwd ?? result?.cwd,
        state,
        stdout: boundedStream(result?.stdout),
        stderr: boundedStream(result?.stderr),
      }));
    }
    case 'file-read': {
      const file = result?.file && typeof result.file === 'object' ? result.file : undefined;
      const path = file?.filePath ?? input.file_path ?? input.filePath;
      // A non-text Read (image/notebook) has no line body to preview; say so
      // rather than rendering an empty box that looks like an empty file.
      const unavailable = options.hasResult && result?.type === 'image' ? 'binary' as const : undefined;
      const startLine = file?.startLine ?? input.offset;
      return boundToolSemantic(fileReadSemantic({
        path,
        startLine: typeof startLine === 'number' ? startLine : undefined,
        preview: file?.content,
        totalLines: file?.totalLines,
        previewTruncated: file?.truncatedByTokenCap === true || result?.truncated === true,
        ...(unavailable ? { unavailable } : {}),
      }));
    }
    case 'search': {
      const groups: (ToolSearchGroup | undefined)[] = [];
      // Grep `content` mode returns `path:line:text` rows; `files_with_matches`
      // (and Glob) return bare paths. Both normalize to the same group shape.
      const filenames = Array.isArray(result?.filenames) ? result.filenames : [];
      for (const filename of filenames) {
        groups.push(searchGroup({ path: filename }));
      }
      if (!groups.length && typeof result?.content === 'string' && result.content) {
        const byPath = new Map<string, { line?: number; text: string }[]>();
        for (const row of result.content.split('\n')) {
          if (!row) continue;
          const match = /^(.*?):(\d+):([\s\S]*)$/.exec(row);
          const path = match?.[1] ?? row;
          const rows = byPath.get(path) ?? [];
          if (match) rows.push({ line: Number(match[2]), text: match[3] ?? '' });
          byPath.set(path, rows);
        }
        for (const [path, matches] of byPath) {
          groups.push(searchGroup({ path, matches, matchCount: matches.length }));
        }
      }
      return boundToolSemantic(searchSemantic({
        query: input.pattern ?? input.query,
        scope: input.path ?? input.glob,
        matchCount: result?.numLines ?? result?.numMatches,
        fileCount: result?.numFiles,
        groups,
      }));
    }
    case 'web':
      return boundToolSemantic(webSemantic({
        query: input.query ?? result?.query,
        url: input.url ?? result?.url,
        results: Array.isArray(result?.results) ? result.results : undefined,
      }));
  }
}

/** Claude owns this native-name mapping; clients consume only the canonical semantic class. */
function claudeToolDisplayClass(toolName: string): ToolDisplayClass {
  const name = String(toolName || '').toLowerCase();
  if (/^(bash|shell|exec|monitor|agent|workflow)$/.test(name)) return 'execute';
  if (/(^|__|[_-])(edit|write|patch|create|delete|move|rename)([_-]|$)/.test(name)) return 'edit';
  if (
    /^(read|grep|glob|ls|webfetch|websearch|toolsearch|skill|tasklist|taskget|cronlist)$/.test(name)
    || /(^|__|[_-])(read|grep|glob|search|fetch|list|query|snapshot|screenshot|console|network)([_-]|$)/.test(name)
    || /directory_tree/.test(name)
  ) return 'lookup';
  return 'other';
}

// ── file artifacts (agent→user file delivery; renders the image the user expects) ──
// SendUserFile records toolUseResult.attachments:[{path(abs),size,isImage,media_type,...}], and pasted /
// Read images are inline {type:'image',source:{type:'base64',media_type,data}} blocks. The app renders a
// file-artifact ONLY when it carries a `url`, so we inline the bytes as a data: URL (capped). file-artifact
// is already canonical + rendered — no core/gate/broker change. Both observe and resume reach these mappers.

const ARTIFACT_INLINE_CAP = 5_000_000; // match the broker's emitArtifact cap (hub.ts); above this → header-only
// NOTE: history keeps EVERY artifact inlined in full (sent HTML/images are a durable record — never
// collapsed). A long session's history frame can therefore be large; the transport must allow it (broker
// WS payload/backpressure limits) and the sustainable fix is incremental history + a client artifact cache
// so the app doesn't re-pull the whole frame each attach. See the 2026-06-17 completeness impl log.

/** Read an agent-referenced file and inline it as a data: URL. Returns undefined if missing/too big/
 *  unreadable (→ header-only card). The path is agent-authored from the transcript (same trust as reading
 *  the transcript); stat-guard to a regular file + cap the size. No HTTP serve surface is added. */
function inlineFileDataUrl(absPath: string, mime: string, size?: number): string | undefined {
  try {
    const st = statSafe(absPath);
    if (!st || !st.isFile()) return undefined;
    if ((size ?? st.size) > ARTIFACT_INLINE_CAP) return undefined;
    return `data:${mime || 'application/octet-stream'};base64,${readFileBuffer(absPath).toString('base64')}`;
  } catch {
    return undefined;
  }
}

function extFromMime(mime: string): string {
  const m = String(mime || '');
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('gif')) return 'gif';
  if (m.includes('svg')) return 'svg';
  return 'img';
}

/** Best-effort MIME from a filename. The channel `send_file` message carries no media type, so the live
 *  bridge derives it here; mirrors the broker's `mimeFromName` (hub.ts) so an artifact renders the same
 *  whether it arrives via the universal outbox watcher or the true-sync socket. */
function mimeFromName(name: string): string {
  const ext = String(name).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  switch (ext) {
    case 'html':
    case 'htm':
      return 'text/html';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'svg':
      return 'image/svg+xml';
    case 'pdf':
      return 'application/pdf';
    case 'json':
      return 'application/json';
    case 'csv':
      return 'text/csv';
    case 'md':
      return 'text/markdown';
    case 'txt':
    case 'log':
      return 'text/plain';
    default:
      return 'application/octet-stream';
  }
}

/** A SendUserFile tool_result line → one file-artifact per attachment (the files the agent sent you). */
export function sendUserFileArtifacts(ln: any): AgentMessage[] {
  const tur = ln?.toolUseResult;
  if (!tur || typeof tur !== 'object' || !Array.isArray(tur.attachments)) return [];
  const proactive = tur.status === 'proactive';
  const out: AgentMessage[] = [];
  for (const att of tur.attachments) {
    if (!att || typeof att.path !== 'string' || !att.path) continue;
    const mime = String(att.media_type || 'application/octet-stream');
    out.push({
      type: 'file-artifact',
      name: basename(att.path),
      path: att.path,
      mimeType: mime,
      size: numOrUndef(att.size),
      proactive,
      url: inlineFileDataUrl(att.path, mime, numOrUndef(att.size)),
    });
  }
  return out;
}

/** An inline {type:'image', source:{type:'base64',...}} content block → a file-artifact (already base64). */
export function inlineImageArtifact(b: any, uuid: string, i: number): AgentMessage | null {
  const src = b?.source;
  if (!src || src.type !== 'base64' || typeof src.data !== 'string' || !src.data) return null;
  const mime = String(src.media_type || 'image/png');
  const tooBig = src.data.length > ARTIFACT_INLINE_CAP * 1.4; // base64 ≈ 4/3 of the binary size
  return {
    type: 'file-artifact',
    name: `image.${extFromMime(mime)}`,
    path: `image:${uuid}:${i}`, // stable per-block id → app dedups history replays by path
    mimeType: mime,
    url: tooBig ? undefined : `data:${mime};base64,${src.data}`,
  };
}

/**
 * Recover canonical rich-detail from a Claude `toolUseResult` (the top-level field on the user line).
 * Path/title are gated by the presence of an actual `filePath`/`file.filePath` (or the call's input
 * `file_path` fallback) so non-file tools (Bash, Task, …) are never mislabeled with a path. Bash has NO
 * numeric exit code — isError is derived by the caller from the block's is_error/interrupted, never
 * fabricated here. `callInput` is the matching tool_use's input (recovers a path when the result omits
 * it — e.g. an image Read whose toolUseResult is `{type:'image'}` with no `file`).
 */
export function enrichClaudeToolResult(toolName: string, tur: any, callInput?: any): ClaudeEnrich {
  const e: ClaudeEnrich = {};
  if (!tur || typeof tur !== 'object') return e;

  // Edit / Write: filePath + a structuredPatch of git-prefixed hunk lines.
  if (typeof tur.filePath === 'string' && tur.filePath) e.path = tur.filePath;
  if (Array.isArray(tur.structuredPatch) && tur.structuredPatch.length) {
    const diff = structuredPatchToDiff(tur.structuredPatch);
    if (diff) {
      e.diff = diff;
      const s = summarizeDiff(diff);
      e.additions = s.additions;
      e.deletions = s.deletions;
    }
  }
  // Write create with an empty patch → the whole content is additions. Emit a real create diff
  // (`--- /dev/null` / `+++ b/path` / `+`body) so expansion shows the added lines, not just a count.
  // Event-time content from the tool result — never read back from the current file.
  if (tur.type === 'create' && typeof tur.content === 'string' && e.diff == null) {
    const body = tur.content ? tur.content.split('\n').map((l: string) => `+${l}`).join('\n') : '';
    if (e.path) {
      e.diff = `--- /dev/null\n+++ ${gitDiffPath('b', e.path)}\n${body}`;
      const s = summarizeDiff(e.diff);
      e.additions = s.additions;
      e.deletions = s.deletions;
    } else {
      e.additions = tur.content ? tur.content.split('\n').length : 0;
      e.deletions = 0;
    }
  }
  // Read: file.{filePath, truncatedByTokenCap}.
  if (tur.file && typeof tur.file === 'object') {
    if (typeof tur.file.filePath === 'string' && tur.file.filePath) e.path = tur.file.filePath;
    if (tur.file.truncatedByTokenCap === true) e.truncated = true;
  }
  // Fallback for results that omit the path (e.g. an IMAGE Read → toolUseResult {type:'image'} with no
  // `file`): recover it from the call's input `file_path`. Use ONLY `file_path`/`filePath` — NOT a bare
  // `path` (Grep/Glob use `.path` for a search DIRECTORY, which must not become an edited-file chip).
  if (!e.path && callInput && typeof callInput === 'object') {
    const p = callInput.file_path ?? callInput.filePath;
    if (typeof p === 'string' && p) e.path = p;
  }
  // SendUserFile: a delivered-file result — use the caption as the title.
  if (typeof tur.caption === 'string' && Array.isArray(tur.attachments)) {
    const cap = oneLine(tur.caption);
    if (cap) e.title = cap.slice(0, 120);
  }
  // Single-file change set (Claude Edit/Write act on one file). Built natively rather than by
  // splitting the diff, because a structuredPatch diff carries only `@@`/body lines (no file headers).
  if (e.diff && e.path && (tur.type === 'create' || Array.isArray(tur.structuredPatch))) {
    const operation: FileOperation = tur.type === 'create' ? 'create' : 'edit';
    e.fileChanges = [
      { path: e.path, operation, diff: e.diff, additions: e.additions, deletions: e.deletions },
    ];
  }
  if (!e.title && e.path) {
    const base = basename(e.path);
    if (tur.type === 'create') e.title = `Created ${base}`;
    else if (tur.type === 'text' || toolName === 'Read') e.title = `Read ${base}`;
    else e.title = `Edited ${base}`;
  }
  return e;
}

/** Join a Claude structuredPatch (hunks of git-prefixed " "/"+"/"-" lines) into a unified-diff body
 *  that summarizeDiff() can count and the client can line-number. Each hunk carries oldStart/oldLines/
 *  newStart/newLines, so we emit the `@@ -a,b +c,d @@` header the event-time patch already implies —
 *  without it the client can only number from 1. Header-less hunks (metadata absent) join as-is. */
export function structuredPatchToDiff(patch: any[]): string {
  const out: string[] = [];
  for (const h of patch) {
    if (!h || !Array.isArray(h.lines)) continue;
    const oldStart = Number(h.oldStart);
    const newStart = Number(h.newStart);
    if (Number.isFinite(oldStart) && Number.isFinite(newStart)) {
      const oldLines = Number(h.oldLines);
      const newLines = Number(h.newLines);
      const oldRange = Number.isFinite(oldLines) ? `${oldStart},${oldLines}` : `${oldStart}`;
      const newRange = Number.isFinite(newLines) ? `${newStart},${newLines}` : `${newStart}`;
      out.push(`@@ -${oldRange} +${newRange} @@`);
    }
    for (const l of h.lines) out.push(String(l));
  }
  return out.join('\n');
}

function mapSystem(ln: any): AgentMessage[] {
  const sub = ln.subtype;
  if (sub === 'compact_boundary') {
    return [{
      type: 'history-reset',
      notice: 'Compacted the conversation.',
      semantic: { kind: 'compaction' },
    }];
  }
  if (sub === 'local_command' && typeof ln.content === 'string') {
    const m = /<local-command-stdout[^>]*>([\s\S]*?)<\/local-command-stdout>/.exec(ln.content);
    const message = m?.[1]?.trim();
    return message ? [{ type: 'notice', message }] : [];
  }
  if (sub === 'api_error' || ln.level === 'error') {
    const msg = typeof ln.content === 'string' && ln.content ? ln.content : 'API error';
    return [{ type: 'error', message: oneLine(msg) }];
  }
  // turn_duration / stop_hook_summary / away_summary / local_command / scheduled_task_fire → skip
  return [];
}

/**
 * Two-pass map of a whole transcript: build the tool_use_id→name map, then emit. `lines` is
 * position-tolerant — a blank/malformed line is a `null` that maps to nothing. token-count is deduped
 * by message.id across the file.
 */
/** ISO string or numeric (s/ms) epoch → epoch ms (copy of the Codex helper). */
function timestampToMs(v: unknown): number | undefined {
  if (typeof v === 'string' && v.trim()) {
    const numeric = Number(v);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(v);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  return v < 1_000_000_000_000 ? v * 1000 : v;
}

type RunSummaryMsg = Extract<AgentMessage, { type: 'run-summary' }>;
interface ClaudeRun {
  turnId: string;
  key: string;
  startedAt?: number;
  userMessageKey?: string;
  lastAssistantKey?: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  hasTokens: boolean;
  cost?: number;
}

/** Derives per-turn `run-summary` frames + cumulative `runtimeTotals` from the Claude transcript line
 *  stream (contract: docs/architecture/client-ui.md). A TURN is a real user prompt (signalled by mapUser
 *  emitting a `user-message`) through an exact terminal marker: assistant `end_turn`, API failure, or a
 *  user interruption. A later real prompt fences an unterminated predecessor as cancelled without
 *  inventing completion time. Replay/flush never closes an open turn. Tokens are summed per turn, deduped by `message.id`
 *  via a tracker-PRIVATE set (independent of mapAssistant's token-count dedup, which runs in the same loop).
 *  Agent/execution split is OMITTED — Claude's transcript has no paired tool start/end events (see doc gaps). */
export class ClaudeRuntimeTracker {
  private current?: ClaudeRun;
  private readonly tokenSeen = new Set<string>();
  private totalRuntimeMs = 0;
  private turnCount = 0;
  private updatedAt?: number;
  constructor(private readonly sessionId: string, private readonly source: string) {}

  feed(ln: any, mapped: AgentMessage[]): AgentMessage[] {
    // CONTRACT: a turn boundary is "mapUser emitted a user-message", so boundary detection stays in lockstep
    // with mapUser's real-prompt gating (isMeta/isWrapper/isCompactSummary/tool_result-only suppression) — do
    // not reimplement that predicate here. If mapUser's filters change, this follows automatically.
    const userMsg = mapped.find((m): m is Extract<AgentMessage, { type: 'user-message' }> => m.type === 'user-message');
    if (userMsg) {
      const out = this.current ? this.close('cancelled', undefined) : [];
      const turnId = String(ln?.uuid ?? userMsg.key ?? '');
      this.current = {
        turnId,
        key: `${this.sessionId}:run:${turnId}`,
        startedAt: timestampToMs(ln?.timestamp) ?? userMsg.sentAt,
        userMessageKey: userMsg.key,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        hasTokens: false,
      };
      return [...out, this.summary(this.current, 'running', undefined)];
    }
    if (ln?.type === 'assistant' && this.current) {
      // CONTRACT: take the key the mapper actually emitted rather than recomputing it — the turn's
      // assistantMessageKey has to resolve to a rendered row, and a text/thinking block's key depends on
      // per-message state this tracker deliberately does not hold. A tool-only line leaves it unchanged.
      for (const m of mapped) if ((m.type === 'model-output' || m.type === 'thinking') && typeof m.key === 'string') this.current.lastAssistantKey = m.key;
      this.accumulateTokens(ln);
    }
    if (!this.current) return [];
    const completedAt = timestampToMs(ln?.timestamp);
    if (mapped.some((m) => m.type === 'notice' && m.semantic?.kind === 'interruption')) {
      return this.close('cancelled', completedAt);
    }
    if (mapped.some((m) => m.type === 'error')) return this.close('error', completedAt);
    const stopStatus = ln?.type === 'assistant' ? claudeStopRunStatus(ln?.message?.stop_reason) : undefined;
    if (stopStatus) return this.close(stopStatus, completedAt);
    return [];
  }

  private accumulateTokens(ln: any): void {
    if (!this.current) return;
    const id = ln?.message?.id;
    const u = ln?.message?.usage;
    if (typeof id !== 'string' || !id || !u || typeof u !== 'object' || this.tokenSeen.has(id)) return;
    this.tokenSeen.add(id);
    const t = this.current.tokens;
    t.input += typeof u.input_tokens === 'number' ? u.input_tokens : 0;
    t.output += typeof u.output_tokens === 'number' ? u.output_tokens : 0;
    t.cacheRead += typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0;
    t.cacheWrite += typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0;
    this.current.hasTokens = true;
  }

  flush(): AgentMessage[] {
    return [];
  }

  /** Live (resume/Drive) turn boundaries from stream events, which carry no native timestamps → broker
   *  wall clock. message_start → startLive (running); result → finishLive (done/error + authoritative usage). */
  startLive(turnId: string, startedAt: number): AgentMessage {
    this.current = { turnId, key: `${this.sessionId}:run:${turnId}`, startedAt, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, hasTokens: false };
    return this.summary(this.current, 'running', undefined);
  }
  finishLive(status: 'done' | 'error' | 'cancelled', completedAt: number, tokens?: RunSummaryMsg['tokens']): AgentMessage[] {
    if (!this.current) return [];
    if (tokens) {
      this.current.tokens = { input: tokens.input ?? 0, output: tokens.output ?? 0, cacheRead: tokens.cacheRead ?? 0, cacheWrite: tokens.cacheWrite ?? 0 };
      this.current.hasTokens = true;
      this.current.cost = tokens.cost;
    }
    return this.close(status, completedAt);
  }

  private close(status: 'done' | 'error' | 'cancelled', completedAt?: number): AgentMessage[] {
    const run = this.current!;
    this.current = undefined;
    const msg = this.summary(run, status, completedAt);
    const out: AgentMessage[] = [msg];
    if (typeof msg.totalRuntimeMs === 'number') {
      this.totalRuntimeMs += msg.totalRuntimeMs;
      this.turnCount += 1;
      this.updatedAt = completedAt;
      out.push(this.totals());
    }
    return out;
  }

  private summary(run: ClaudeRun, status: RunSummaryMsg['status'], completedAt?: number): RunSummaryMsg {
    const totalRuntimeMs = typeof run.startedAt === 'number' && typeof completedAt === 'number' ? Math.max(0, completedAt - run.startedAt) : undefined;
    const tokens = run.hasTokens
      ? { input: run.tokens.input, output: run.tokens.output, cacheRead: run.tokens.cacheRead, cacheWrite: run.tokens.cacheWrite, ...(run.cost !== undefined ? { cost: run.cost } : {}) }
      : undefined;
    return {
      type: 'run-summary',
      key: run.key,
      turnId: run.turnId,
      ...(run.userMessageKey ? { userMessageKey: run.userMessageKey } : {}),
      ...(run.lastAssistantKey ? { assistantMessageKey: run.lastAssistantKey } : {}),
      status,
      ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
      ...(completedAt !== undefined ? { completedAt } : {}),
      ...(totalRuntimeMs !== undefined ? { totalRuntimeMs } : {}),
      ...(tokens ? { tokens } : {}),
      source: this.source,
    };
  }

  private totals(): AgentMessage {
    return { type: 'metadata-update', key: 'runtimeTotals', value: { totalRuntimeMs: this.totalRuntimeMs, turnCount: this.turnCount, updatedAt: this.updatedAt, source: this.source } };
  }
}

export function mapTranscript(lines: any[], tracker?: ClaudeRuntimeTracker, tasks: ClaudeTaskLedger = new ClaudeTaskLedger(), blocks: ClaudeBlockOrdinals = newClaudeBlockOrdinals()): AgentMessage[] {
  const callMeta = new Map<string, ClaudeCall>();
  for (const ln of lines) if (ln) accumulateCallMeta(ln, callMeta);
  const seenTokenIds = new Set<string>();
  const queuedSends = newClaudeQueuedSends(); // link enqueue bubbles to their delivering user lines
  const out: AgentMessage[] = [];
  for (const ln of lines) {
    if (!ln) continue;
    const mapped = mapLine(ln, callMeta, seenTokenIds, queuedSends, blocks);
    out.push(...mapped);
    out.push(...tasks.feed(ln)); // TaskCreate/TaskUpdate → the upserted task-list-state panel
    if (tracker) out.push(...tracker.feed(ln, mapped)); // interleave run-summary at turn boundaries
  }
  return out;
}

// ── subagent + workflow activity (auto-surfaced progress cards; observe + resume) ──
//
// Claude writes a sibling tree next to every <uuid>.jsonl transcript, with NO config required:
//   <uuid>/subagents/agent-<id>.{jsonl,meta.json}      parent-spawned Task subagents
//   <uuid>/workflows/wf_<id>.json                      a COMPLETED workflow run (flushed at the end)
//   <uuid>/subagents/workflows/wf_<id>/journal.jsonl   a LIVE workflow (no top-level json yet)
// The activity dir is just the transcript path minus '.jsonl' (the <uuid>/ dir sits beside it). We
// translate these into canonical `agent-activity` frames; the UI never sees a Claude tool name. Schema
// verified against real sessions — see packages/typescript/adapters/claude/test/test-claude-activity.ts + the impl log.

type ActivityMsg = Extract<AgentMessage, { type: 'agent-activity' }>;
/** An activity frame plus a `src` stat key, so a watcher can skip unchanged files (getHistory maps `.msg`). */
export interface ActivityFrame {
  msg: ActivityMsg;
  src: string;
}

/** The <uuid>/ activity dir beside a <uuid>.jsonl transcript. */
export function claudeActivityDir(transcriptPath: string): string {
  return join(dirname(transcriptPath), basename(transcriptPath).replace(/\.jsonl$/, ''));
}

/**
 * Freshest mtime under the session's sibling activity tree (subagent transcripts + live workflow
 * journals). A parent blocked on a Task/Agent tool_use goes QUIET while its subagent works — the
 * appends land in the subagent's own `agent-*.jsonl`, not the parent transcript — so gating status
 * freshness on the parent mtime alone flips a busy session to 'idle' mid-subagent (issues-part1:
 * "when a subagent is working, our app shows it is idling"). Bounded: one readdir of `subagents/`
 * plus a stat per entry (and one level into `subagents/workflows/<run>/`); callers invoke it only
 * for rows whose raw status is 'working'.
 */
export function activityHeartbeatMs(transcriptPath: string): number {
  const subDir = join(claudeActivityDir(transcriptPath), 'subagents');
  let hb = 0;
  for (const name of safeReaddir(subDir)) {
    const p = join(subDir, name);
    const st = statSafe(p);
    if (!st) continue;
    if (st.isDirectory()) {
      // the nested live-workflow tree: subagents/workflows/wf_<id>/{journal.jsonl,agent-*.jsonl}
      for (const run of safeReaddir(p)) {
        const runDir = join(p, run);
        const rst = statSafe(runDir);
        if (!rst) continue;
        if (!rst.isDirectory()) {
          if (rst.mtimeMs > hb) hb = rst.mtimeMs;
          continue;
        }
        for (const f of safeReaddir(runDir)) {
          const m = statSafe(join(runDir, f))?.mtimeMs;
          if (m != null && m > hb) hb = m;
        }
      }
    } else if (st.mtimeMs > hb) {
      hb = st.mtimeMs;
    }
  }
  return hb;
}

/** Collect tool_use_ids the PARENT has already answered (a user-turn `tool_result`), so a subagent whose
 *  meta.toolUseId is resolved renders 'done' without re-reading the (multi-MB) parent on every sweep. */
export interface ParentActivityState {
  backgroundToolUseIds: Set<string>;
  notifiedToolUseIds: Set<string>;
  backgroundSpawnMs?: Map<string, number>;
  /** Agent ids the parent explicitly TaskStop'd (their transcripts just stop mid-flight). */
  killedAgentIds?: Set<string>;
  /** agent id (from the spawn ack's "agentId: X") → spawning tool_use_id, so a kill can resolve the
   *  pending-background entry keyed by tool_use_id. */
  agentIdToToolUseId?: Map<string, string>;
  /** In-flight TaskStop tool_use ids → their task_id, resolved by the matching tool_result. */
  stopRequests?: Map<string, string>;
}

export function collectToolResultIds(ln: any, set: Set<string>): void {
  if (ln?.type !== 'user') return;
  const c = ln.message?.content;
  if (!Array.isArray(c)) return;
  for (const b of c) if (b?.type === 'tool_result' && b.tool_use_id != null) set.add(String(b.tool_use_id));
}

export function collectParentActivity(
  ln: any,
  resolved: Set<string>,
  background: Set<string>,
  notified: Set<string>,
  backgroundSpawnMs?: Map<string, number>,
  extra?: Pick<ParentActivityState, 'killedAgentIds' | 'agentIdToToolUseId' | 'stopRequests'>,
): void {
  collectToolResultIds(ln, resolved);
  const c = ln?.message?.content;
  if (ln?.type === 'assistant' && Array.isArray(c)) {
    for (const b of c) {
      if (b?.type !== 'tool_use' || b.id == null) continue;
      if ((b.name === 'Task' || b.name === 'Agent') && b.input?.run_in_background === true) {
        const id = String(b.id);
        background.add(id);
        const ts = timestampToMs(ln.timestamp);
        if (ts !== undefined) backgroundSpawnMs?.set(id, ts);
      }
      // TaskStop {task_id} — remember the request; its tool_result marks the agent killed.
      if (b.name === 'TaskStop' && b.input?.task_id != null) extra?.stopRequests?.set(String(b.id), String(b.input.task_id));
    }
  }
  if (ln?.type !== 'user') return;
  const texts: string[] = [];
  if (typeof c === 'string') texts.push(c);
  else if (Array.isArray(c)) {
    for (const b of c) {
      if (typeof b === 'string') texts.push(b);
      else if (typeof b?.text === 'string') texts.push(b.text);
      else if (typeof b?.content === 'string') texts.push(b.content);
      if (b?.type !== 'tool_result' || b.tool_use_id == null) continue;
      const tuid = String(b.tool_use_id);
      const blockText =
        typeof b.content === 'string'
          ? b.content
          : Array.isArray(b.content)
            ? b.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('\n')
            : '';
      // The spawn ack ("Async agent launched… agentId: X") maps agent id → spawning tool_use_id, so a
      // later TaskStop of X can resolve the pending-background entry keyed by that tool_use_id.
      const ack = /agentId:\s*([A-Za-z0-9_-]+)/.exec(blockText);
      if (ack?.[1]) extra?.agentIdToToolUseId?.set(ack[1], tuid);
      const stopped = extra?.stopRequests?.get(tuid);
      if (stopped && b.is_error !== true) {
        extra?.killedAgentIds?.add(stopped);
        notified.add(extra?.agentIdToToolUseId?.get(stopped) ?? stopped);
      }
    }
  }
  for (const text of texts) {
    if (!text.includes('<task-notification')) continue;
    const re = /<tool-use-id>([^<]+)<\/tool-use-id>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) if (m[1]) notified.add(m[1]);
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
function readTextSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** elapsed (first→last timestamp) + an output-token estimate for ONE subagent transcript, from bounded
 *  head/tail reads (a long subagent file is never slurped). Tokens dedupe by message.id (usage repeats
 *  per line of a turn) over the tail window — exact for short agents, an estimate for very long ones. */
function subagentStats(jsonlPath: string): { elapsedMs?: number; startedAtMs?: number; tokens?: number; ctxTokens?: number; mtimeMs?: number; tailState?: 'in-tool-call' | 'final-text' | 'idle' } {
  const st = statSafe(jsonlPath);
  let firstTs: number | undefined;
  let lastTs: number | undefined;
  const tokenMax = new Map<string, number>();
  let anonToken = 0;
  let ctxTokens: number | undefined; // latest call's input+cacheRead+cacheWrite — the number the TUI shows
  let tailState: 'in-tool-call' | 'final-text' | 'idle' | undefined;
  const note = (segs: string[], wantTokens: boolean): void => {
    const pendingToolUses = new Set<string>();
    let lastEvent: { type: 'tool_use'; id: string } | { type: 'tool_result' } | { type: 'final_text' } | undefined;
    for (const seg of segs) {
      const o = parseLineOrNull(seg);
      if (!o) continue;
      const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN; // Date.parse handles the ".990Z" fraction
      if (!Number.isNaN(ts)) {
        if (firstTs == null || ts < firstTs) firstTs = ts;
        if (lastTs == null || ts > lastTs) lastTs = ts;
      }
      if (wantTokens && o.type === 'assistant') {
        const u = o.message?.usage;
        const ot = u?.output_tokens;
        const id = o.message?.id;
        if (typeof ot === 'number') {
          if (id != null) {
            const k = String(id);
            tokenMax.set(k, Math.max(tokenMax.get(k) ?? 0, ot));
          } else {
            anonToken += ot;
          }
        }
        // Context size of the newest call (input + cache read + cache write). This is the figure the
        // Claude TUI's task row shows (verified: TUI "17.5k tokens" = 7+2492+14986 = 17485 while total
        // output was 1187 — issues-part2 "token count is not correct" was a METRIC mismatch, not a sum bug).
        if (u && typeof u === 'object') {
          const ctx = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          if (ctx > 0) ctxTokens = ctx;
        }
      }
      if (wantTokens && o.type === 'assistant') {
        const content = Array.isArray(o.message?.content) ? o.message.content : [];
        for (const b of content) {
          if (b?.type === 'tool_use' && b.id != null) {
            const id = String(b.id);
            pendingToolUses.add(id);
            lastEvent = { type: 'tool_use', id };
          } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
            lastEvent = { type: 'final_text' };
          }
        }
      } else if (wantTokens && o.type === 'user') {
        const content = Array.isArray(o.message?.content) ? o.message.content : [];
        for (const b of content) {
          if (b?.type === 'tool_result' && b.tool_use_id != null) {
            pendingToolUses.delete(String(b.tool_use_id));
            lastEvent = { type: 'tool_result' };
          }
        }
      }
    }
    if (wantTokens) {
      if (lastEvent?.type === 'tool_use' && pendingToolUses.has(lastEvent.id)) tailState = 'in-tool-call';
      else if (lastEvent?.type === 'final_text') tailState = 'final-text';
      else if (lastEvent) tailState = 'idle';
    }
  };
  note(readHeadLines(jsonlPath, 64 * 1024), false); // earliest timestamp
  note(readTailLines(jsonlPath, 512 * 1024), true); // latest timestamp + token sum
  const tokens = [...tokenMax.values()].reduce((a, b) => a + b, 0) + anonToken;
  return {
    elapsedMs: firstTs != null && lastTs != null && lastTs >= firstTs ? lastTs - firstTs : undefined,
    startedAtMs: firstTs,
    tokens: tokens > 0 ? tokens : undefined,
    ctxTokens,
    mtimeMs: st?.mtimeMs,
    tailState,
  };
}

/**
 * Enumerate the current subagent + workflow state under an activity dir as `agent-activity` frames.
 * `resolved` = parent-answered tool_use_ids (subagent done-detection). `now` is injectable for tests.
 */
export function buildActivitySnapshot(activityDir: string, resolved: Set<string>, now: number = Date.now(), parent: ParentActivityState = { backgroundToolUseIds: new Set(), notifiedToolUseIds: new Set() }): ActivityFrame[] {
  const out: ActivityFrame[] = [];
  const subDir = join(activityDir, 'subagents');
  const wfDir = join(activityDir, 'workflows');

  // 1. Parent-spawned subagents. Skip the minimal {agentType:'workflow-subagent'} metas (no toolUseId) —
  //    those belong to a workflow and are summarized inside its card.
  for (const name of safeReaddir(subDir)) {
    if (!name.endsWith('.meta.json')) continue;
    const meta = parseLineOrNull(readTextSafe(join(subDir, name)));
    if (!meta || meta.toolUseId == null) continue;
    const base = name.replace(/\.meta\.json$/, '');
    const jsonlPath = join(subDir, base + '.jsonl');
    const stat = statSafe(jsonlPath);
    const s = subagentStats(jsonlPath);
    const tuid = String(meta.toolUseId);
    const staleWindow = s.tailState === 'in-tool-call' ? 15 * 60_000 : WORKING_FRESH_MS;
    const stale = s.mtimeMs != null && now - s.mtimeMs > staleWindow;
    const background = parent.backgroundToolUseIds.has(tuid);
    // A TaskStop'd agent is done the moment the parent's stop tool_result lands — its own file just
    // stops mid-flight (no final text, no task-notification), which otherwise reads as "running" for
    // the whole stale window (issues-part1: "I stopped the agent and it still tick-tocks").
    const killed = parent.killedAgentIds?.has(base.replace(/^agent-/, '')) === true;
    const done = killed || s.tailState === 'final-text' || (background ? parent.notifiedToolUseIds.has(tuid) || stale : resolved.has(tuid) || stale);
    const status: ActivityMsg['status'] = done ? 'done' : 'running';
    out.push({
      msg: {
        type: 'agent-activity',
        key: 'agent:' + tuid,
        kind: 'subagent',
        title: typeof meta.description === 'string' && meta.description ? meta.description : String(meta.agentType ?? base),
        subtitle: typeof meta.agentType === 'string' ? meta.agentType : undefined,
        status,
        // A RUNNING agent's true elapsed is wall-clock since start — the file-derived first→last span
        // freezes during a quiet tool call (the "stuck at 4s" bug). Done keeps the exact file span.
        elapsedMs: status === 'running' && s.startedAtMs != null ? Math.max(0, now - s.startedAtMs) : s.elapsedMs,
        startedAtMs: s.startedAtMs,
        // `input` carries the latest call's context size (input+cacheRead+cacheWrite) — the figure the
        // Claude TUI's own task row shows ("↓ 17.5k tokens"), so the app can match it (issues-part2).
        tokens: s.tokens != null || s.ctxTokens != null ? { ...(s.tokens != null ? { output: s.tokens } : {}), ...(s.ctxTokens != null ? { input: s.ctxTokens } : {}) } : undefined,
        agentsDone: status === 'done' ? 1 : 0,
        agentsTotal: 1,
      },
      src: `${jsonlPath}:${stat?.size ?? 0}:${stat?.mtimeMs ?? 0}:${status}`,
    });
  }

  // 2. Completed workflows (top-level wf_<id>.json — present only once the run has ended).
  const completed = new Set<string>();
  for (const name of safeReaddir(wfDir)) {
    if (!name.startsWith('wf_') || !name.endsWith('.json')) continue;
    const p = join(wfDir, name);
    const stat = statSafe(p);
    const wf = parseLineOrNull(readTextSafe(p)); // rewritten wholesale → a mid-write read yields null → skip this sweep
    if (!wf) continue;
    const stem = name.replace(/\.json$/, '');
    const runId = String(wf.runId || stem);
    completed.add(runId);
    completed.add(stem); // also the filename-stem so the live-branch suppression matches the journal dir name
    const progress = Array.isArray(wf.workflowProgress) ? wf.workflowProgress : [];
    const agents = progress.filter((e: any) => e?.type === 'workflow_agent');
    const status: ActivityMsg['status'] =
      wf.status === 'completed' ? 'done' : wf.status === 'failed' || wf.status === 'killed' ? 'error' : 'running';
    const phases = Array.isArray(wf.phases) ? wf.phases : [];
    const lastPhase = phases.length ? String(phases[phases.length - 1]?.title ?? '') : '';
    out.push({
      msg: {
        type: 'agent-activity',
        key: 'wf:' + runId,
        kind: 'workflow',
        // Prefer the human summary (a clean top-level string in the completed wf_*.json — the run's
        // one-line description, e.g. "Confirm the Claude adapter emits…") so the bar reads like Claude
        // Code's native "Dynamic workflow «…»" line; fall back to the slug name, then the runId.
        title:
          typeof wf.summary === 'string' && wf.summary.trim()
            ? wf.summary.trim()
            : typeof wf.workflowName === 'string' && wf.workflowName
              ? wf.workflowName
              : runId,
        subtitle: lastPhase || undefined,
        status,
        elapsedMs: numOrUndef(wf.durationMs),
        tokens: numOrUndef(wf.totalTokens) != null ? { output: wf.totalTokens } : undefined,
        toolCalls: numOrUndef(wf.totalToolCalls),
        agentsTotal: numOrUndef(wf.agentCount) ?? agents.length,
        agentsDone: agents.filter((a: any) => a.state === 'done').length,
        children: agents.map((a: any) => ({
          key: 'wfagent:' + String(a.agentId ?? a.index),
          title: typeof a.label === 'string' && a.label ? a.label : String(a.agentId ?? a.index),
          status: (a.state === 'progress' ? 'running' : a.state === 'done' ? 'done' : a.state === 'error' ? 'error' : 'pending') as
            | 'pending'
            | 'running'
            | 'done'
            | 'error',
          phase: typeof a.phaseTitle === 'string' ? a.phaseTitle : undefined,
          elapsedMs:
            numOrUndef(a.durationMs) ??
            (numOrUndef(a.lastProgressAt) != null && numOrUndef(a.startedAt) != null ? a.lastProgressAt - a.startedAt : undefined),
          tokens: numOrUndef(a.tokens) != null ? { output: a.tokens } : undefined,
        })),
      },
      src: `${p}:${stat?.size ?? 0}:${stat?.mtimeMs ?? 0}`,
    });
  }

  // 3. LIVE workflows — a nested subagents/workflows/wf_<id>/journal.jsonl with no top-level json yet.
  const nestedWf = join(subDir, 'workflows');
  for (const name of safeReaddir(nestedWf)) {
    if (!name.startsWith('wf_')) continue;
    if (completed.has(name)) continue; // the richer completed card already covers it
    const wfRunDir = join(nestedWf, name);
    const journalPath = join(wfRunDir, 'journal.jsonl');
    const stat = statSafe(journalPath);
    if (!stat) continue;
    const started = new Set<string>();
    const done = new Set<string>();
    for (const seg of splitLines(readTextSafe(journalPath))) {
      const j = parseLineOrNull(seg);
      if (!j || j.agentId == null) continue;
      const aid = String(j.agentId);
      if (j.type === 'result') done.add(aid);
      else if (j.type === 'started') started.add(aid);
    }
    // Done when every started agent resolved, OR the run has gone quiet past a generous window. The
    // HEARTBEAT is the freshest file mtime in the run dir — the per-agent `agent-*.jsonl` transcripts ARE
    // appended throughout execution, while the journal alone is touched only on agent start/finish, so
    // keying staleness off the journal mtime wrongly flips a live fan-out to done mid-run (the ACT-1 bug).
    // This keeps an ACTIVE fan-out 'running' yet lets a crashed/OLD run (e.g. replayed from history)
    // settle to 'done' so it never lingers as a stale running bar (doc 02 §2.5a; doc-12 remove-on-done).
    let heartbeat = stat.mtimeMs ?? 0;
    for (const f of safeReaddir(wfRunDir)) {
      const m = statSafe(join(wfRunDir, f))?.mtimeMs;
      if (m != null && m > heartbeat) heartbeat = m;
    }
    const allResolved = started.size > 0 && done.size >= started.size;
    const stale = heartbeat > 0 && now - heartbeat > WORKFLOW_STALE_MS;
    const status: ActivityMsg['status'] = allResolved || stale ? 'done' : 'running';
    out.push({
      msg: {
        type: 'agent-activity',
        key: 'wf:' + name,
        kind: 'workflow',
        title: name,
        status,
        agentsTotal: started.size,
        agentsDone: done.size,
        children: [...started].map((aid) => ({
          key: 'wfagent:' + aid,
          title: aid.slice(0, 12),
          status: (done.has(aid) ? 'done' : 'running') as 'done' | 'running',
        })),
      },
      // status is in the dedupe key so a running→done transition re-emits (mirrors the subagent branch).
      src: `${journalPath}:${stat.size}:${stat.mtimeMs}:${status}`,
    });
  }

  return out;
}

/**
 * Watches an activity dir and re-emits changed subagent/workflow cards. PER-CONNECTION (not a singleton):
 * the Hub creates one ManagedConn per attached (tool,id,mode), so exactly one watcher per attached session;
 * it is torn down in the connection's close(). Mirrors the broker outbox watch — fs.watch for the fast
 * path + a 2s interval backstop (fs.watch coalesces bursts and can't see deep journal appends) + a
 * size:mtime dedupe so steady-state sweeps emit nothing.
 */
export class ClaudeActivityWatcher {
  private subW?: FSWatcher;
  private wfW?: FSWatcher;
  private nestedW?: FSWatcher;
  private timer?: ReturnType<typeof setInterval>;
  private readonly seen = new Map<string, string>(); // m.key → last emitted src (skip unchanged source files)

  constructor(
    private dir: string,
    private readonly emit: (m: AgentMessage) => void,
    private readonly hasClients: () => boolean,
    private readonly resolved: Set<string>,
    private readonly parent: ParentActivityState = { backgroundToolUseIds: new Set(), notifiedToolUseIds: new Set() },
  ) {}

  start(): void {
    this.startWatchers();
    this.timer = setInterval(() => {
      if (this.hasClients()) this.sweep();
    }, 2000);
    this.sweep();
  }

  /** Re-point at a new activity dir — a resume `--fork-session` writes live activity under the FORKED uuid. */
  repoint(dir: string): void {
    if (dir === this.dir) return;
    this.stopWatchers();
    this.dir = dir;
    this.seen.clear();
    this.startWatchers();
    this.sweep();
  }

  private startWatchers(): void {
    const mk = (sub: string): FSWatcher | undefined => {
      try {
        return watch(join(this.dir, sub), () => setTimeout(() => this.sweep(), 200));
      } catch {
        return undefined; // dir absent / fs.watch unsupported here → the interval backstop covers it
      }
    };
    this.subW = mk('subagents');
    this.wfW = mk('workflows');
    this.nestedW = mk(join('subagents', 'workflows'));
  }

  private stopWatchers(): void {
    this.subW?.close();
    this.wfW?.close();
    this.nestedW?.close();
    this.subW = this.wfW = this.nestedW = undefined;
  }

  private sweep(): void {
    let frames: ActivityFrame[];
    try {
      frames = buildActivitySnapshot(this.dir, this.resolved, Date.now(), this.parent);
    } catch {
      return; // transient FS / mid-write error → next sweep recovers
    }
    for (const f of frames) {
      if (this.seen.get(f.msg.key) === f.src) continue; // unchanged source file → no re-emit
      this.seen.set(f.msg.key, f.src);
      this.emit(f.msg);
    }
  }

  close(): void {
    this.stopWatchers();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.seen.clear();
  }
}

// ── small helpers ───────────────────────────────────────────────────────────

/** User string content that is a harness/command wrapper, not a real prompt — must NOT render as a
 *  user-message (otherwise the chat shows raw XML and slash-command boilerplate). */
function isWrapper(s: string): boolean {
  return /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|user-prompt-submit-hook|task-notification)\b/.test(
    s,
  );
}

function firstText(content: any[]): string {
  if (!Array.isArray(content)) return '';
  const b = content.find((x) => x?.type === 'text' && typeof x.text === 'string' && x.text.trim());
  return b ? String(b.text) : '';
}

function blockContentText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c))
    return c
      .map((x: any) => (typeof x === 'string' ? x : x?.text ?? (x?.tool_name ? `[${x.tool_name}]` : '')))
      .join('');
  return c == null ? '' : safeStringify(c);
}

const oneLine = (s: string): string => String(s).split('\n')[0]!.slice(0, 200);
const numOrUndef = (n: unknown): number | undefined => (typeof n === 'number' ? n : undefined);

function safeStringify(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v ?? '');
  } catch {
    return String(v ?? '');
  }
}

export type RawStatus = 'working' | 'needs-input' | 'idle';

export type ClaudeTranscriptTurnAuthority = 'active' | 'terminal' | 'unknown';
const CLAUDE_TURN_AUTHORITY_CHUNK_BYTES = 128 * 1024;
const CLAUDE_TURN_AUTHORITY_MAX_RECORD_BYTES = 1024 * 1024;
const CLAUDE_TURN_AUTHORITY_MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const CLAUDE_TURN_AUTHORITY_MAX_ELAPSED_MS = 250;
const CLAUDE_TURN_AUTHORITY_SAMPLE_BYTES = 1024;
const CLAUDE_TURN_AUTHORITY_CACHE_MAX = 8192;

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => { setImmediate(resolve); });
}

type ClaudeAuthorityStat = {
  size: number;
  mtimeMs: number;
  dev?: number | bigint;
  ino?: number | bigint;
};

interface ClaudeTurnAuthorityEntry {
  sourceKey: string;
  /** Validated source EOF used for append/replacement fencing. */
  size: number;
  /** Forward cursor through that source; may lag `size` after a bounded scan. */
  processedSize: number;
  prefixLength: number;
  prefixHash: string;
  boundaryLength: number;
  boundaryHash: string;
  authority: ClaudeTranscriptTurnAuthority;
  resolution: 'authority' | 'fallback';
  fallbackReason?: ClaudeTurnAuthorityFallbackReason;
  tail: ClaudeAuthorityTail;
  /** Latest exact marker in the processed prefix, published only after catch-up reaches EOF. */
  candidateAuthority: ClaudeTranscriptTurnAuthority;
  candidateAuthoritative: boolean;
}

type ClaudeAuthorityTail =
  | { kind: 'complete' }
  | { kind: 'partial'; start: number }
  | { kind: 'opaque' };

const claudeTurnAuthorityCache = new Map<string, ClaudeTurnAuthorityEntry>();

function claudeStopRunStatus(stopReason: unknown): 'done' | 'error' | undefined {
  if (typeof stopReason !== 'string' || !stopReason) return undefined;
  if (stopReason === 'tool_use' || stopReason === 'pause_turn') return undefined;
  if (stopReason === 'end_turn' || stopReason === 'stop_sequence') return 'done';
  // max_tokens, refusal, model-context exhaustion, and future non-continuation reasons are
  // authoritative terminal failures rather than open turns.
  return 'error';
}

function claudeLineTurnAuthority(line: any): Exclude<ClaudeTranscriptTurnAuthority, 'unknown'> | undefined {
  if (line.type === 'assistant') {
    if (line.isApiErrorMessage || claudeStopRunStatus(line.message?.stop_reason)) return 'terminal';
    const content = line.message?.content;
    if (line.message && (Array.isArray(content) ? content.length > 0 : content != null)) return 'active';
    return undefined;
  }
  if (line.type === 'system') {
    return line.subtype === 'api_error' || line.level === 'error' ? 'terminal' : undefined;
  }
  if (line.type !== 'user' || line.isCompactSummary || line.isMeta) return undefined;
  const content = line.message?.content;
  if (typeof content === 'string') {
    if (!content.trim() || isWrapper(content)) return undefined;
    return isInterruptMarker(content) ? 'terminal' : 'active';
  }
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('\n')
    .trim();
  if (text && isInterruptMarker(text)) return 'terminal';
  if (content.some((block: any) => block?.type === 'tool_result' || block?.type === 'image')) return 'active';
  if (text && !isWrapper(text)) return 'active';
  return undefined;
}

export type ClaudeTurnAuthorityFallbackReason =
  | 'source-limit'
  | 'time-limit'
  | 'record-limit'
  | 'source-changed';

export type ClaudeTurnAuthorityInference =
  | { kind: 'authority'; authority: ClaudeTranscriptTurnAuthority; scannedBytes: number }
  | {
      kind: 'fallback';
      authority: ClaudeTranscriptTurnAuthority;
      reason: ClaudeTurnAuthorityFallbackReason;
      scannedBytes: number;
    };

/** Test-only seams for deterministic admission and source-race coverage. */
export interface ClaudeTurnAuthorityScanOptions {
  maxSourceBytes?: number;
  maxElapsedMs?: number;
  beforeValidation?: () => void;
}

/** Exact latest-turn evidence retained across incremental transcript growth.
 *
 * A cooperative reverse scan recovers the latest marker on cold discovery. Once observed,
 * subsequent appends advance to the observed EOF with bounded framing state, so valid progress
 * cannot evict the active turn. Cold and incremental work yield after every 128 KiB and admit at
 * most 64 MiB/250 ms per call; exceeding a source, time, or record bound returns a typed fallback.
 * A source change racing an admitted incremental scan rejects the candidate but keeps the
 * published authority until a settled pass. Truncation, atomic replacement, or
 * sampled-prefix/boundary mismatch resets authority before re-seeding. */
export async function claudeTranscriptTurnAuthority(path: string): Promise<ClaudeTranscriptTurnAuthority> {
  return (await claudeTranscriptTurnAuthorityResult(path)).authority;
}

export async function claudeTranscriptTurnAuthorityResult(
  path: string,
  options?: ClaudeTurnAuthorityScanOptions,
): Promise<ClaudeTurnAuthorityInference> {
  const st = statSafe(path);
  if (!st || st.size <= 0) {
    claudeTurnAuthorityCache.delete(path);
    return { kind: 'authority', authority: 'unknown', scannedBytes: 0 };
  }
  const cached = claudeTurnAuthorityCache.get(path);
  if (cached && claudeAuthorityAppendCompatible(path, st, cached)) {
    if (st.size > cached.size || cached.processedSize < st.size) {
      const advanced = await scanClaudeAuthorityRange(path, st, cached, options);
      if (advanced.reason === 'source-changed') {
        // The admitted prefix was still valid when this scan started, so only the racing
        // candidate is rejected; the published authority stands until the settled follow-up
        // re-validates the source or append incompatibility forces a reseed.
        return {
          kind: 'fallback',
          authority: cached.authority,
          reason: advanced.reason,
          scannedBytes: advanced.scannedBytes,
        };
      }
      cached.authority = advanced.authority;
      cached.size = st.size;
      cached.processedSize = advanced.processedThrough;
      cached.tail = advanced.tail;
      cached.candidateAuthority = advanced.candidateAuthority;
      cached.candidateAuthoritative = advanced.candidateAuthoritative;
      cached.resolution = advanced.kind;
      cached.fallbackReason = advanced.kind === 'fallback' ? advanced.reason : undefined;
      refreshClaudeAuthoritySamples(path, st, cached);
      rememberClaudeTurnAuthority(path, cached);
      return advanced.kind === 'authority'
        ? { kind: 'authority', authority: advanced.authority, scannedBytes: advanced.scannedBytes }
        : {
            kind: 'fallback',
            authority: advanced.authority,
            reason: advanced.reason,
            scannedBytes: advanced.scannedBytes,
          };
    }
    rememberClaudeTurnAuthority(path, cached);
    return cached.resolution === 'authority'
      ? { kind: 'authority', authority: cached.authority, scannedBytes: 0 }
      : {
          kind: 'fallback',
          authority: cached.authority,
          reason: cached.fallbackReason ?? 'source-limit',
          scannedBytes: 0,
        };
  }

  const recovered = await scanClaudeAuthorityCold(path, st, options);
  if (recovered.reason === 'source-changed') return recovered;
  const entry: ClaudeTurnAuthorityEntry = {
    sourceKey: claudeAuthoritySourceKey(st),
    size: st.size,
    processedSize: st.size,
    prefixLength: 0,
    prefixHash: '',
    boundaryLength: 0,
    boundaryHash: '',
    authority: recovered.authority,
    resolution: recovered.kind,
    ...(recovered.kind === 'fallback' ? { fallbackReason: recovered.reason } : {}),
    tail: recovered.tail ?? (recovered.kind === 'authority'
      ? recovered.scannedThrough === st.size
        ? { kind: 'complete' }
        : { kind: 'partial', start: recovered.scannedThrough }
      : { kind: 'opaque' }),
    candidateAuthority: recovered.authority,
    candidateAuthoritative: recovered.kind === 'authority',
  };
  refreshClaudeAuthoritySamples(path, st, entry);
  rememberClaudeTurnAuthority(path, entry);
  return recovered;
}

type ClaudeColdAuthorityScan =
  | {
      kind: 'authority';
      authority: ClaudeTranscriptTurnAuthority;
      scannedThrough: number;
      scannedBytes: number;
      tail?: ClaudeAuthorityTail;
      reason?: undefined;
    }
  | {
      kind: 'fallback';
      authority: 'unknown';
      reason: ClaudeTurnAuthorityFallbackReason;
      scannedThrough: number;
      scannedBytes: number;
      tail?: ClaudeAuthorityTail;
    };

async function scanClaudeAuthorityCold(
  path: string,
  st: ClaudeAuthorityStat,
  options: ClaudeTurnAuthorityScanOptions = {},
): Promise<ClaudeColdAuthorityScan> {
  const maxSourceBytes = Math.max(
    CLAUDE_TURN_AUTHORITY_CHUNK_BYTES,
    options.maxSourceBytes ?? CLAUDE_TURN_AUTHORITY_MAX_SOURCE_BYTES,
  );
  const deadline = Date.now()
    + Math.max(1, options.maxElapsedMs ?? CLAUDE_TURN_AUTHORITY_MAX_ELAPSED_MS);
  let fd: number | undefined;
  let scannedBytes = 0;
  let scannedThrough: number | undefined;
  let result: ClaudeColdAuthorityScan | undefined;
  try {
    fd = openSync(path, 'r');
    const opened = fstatSync(fd);
    if (!claudeAuthorityStatMatches(st, opened)) {
      return { kind: 'fallback', authority: 'unknown', reason: 'source-changed', scannedThrough: st.size, scannedBytes };
    }
    const guard = claudeAuthorityGuardFromFd(fd, opened);
    const last = Buffer.alloc(1);
    if (readSync(fd, last, 0, 1, st.size - 1) !== 1) {
      return { kind: 'fallback', authority: 'unknown', reason: 'source-changed', scannedThrough: st.size, scannedBytes };
    }
    if (last[0] === 0x0a) scannedThrough = st.size;

    let pos = st.size;
    let suffix: Buffer = Buffer.alloc(0);
    scan: while (pos > 0) {
      if (scannedBytes >= maxSourceBytes) {
        result = { kind: 'fallback', authority: 'unknown', reason: 'source-limit', scannedThrough: st.size, scannedBytes };
        break;
      }
      if (Date.now() > deadline) {
        result = { kind: 'fallback', authority: 'unknown', reason: 'time-limit', scannedThrough: st.size, scannedBytes };
        break;
      }
      const len = Math.min(CLAUDE_TURN_AUTHORITY_CHUNK_BYTES, pos, maxSourceBytes - scannedBytes);
      pos -= len;
      const chunk = Buffer.alloc(len);
      if (readSync(fd, chunk, 0, len, pos) !== len) {
        result = { kind: 'fallback', authority: 'unknown', reason: 'source-changed', scannedThrough: st.size, scannedBytes };
        break;
      }
      scannedBytes += len;
      const newlineOffsets: number[] = [];
      for (let offset = chunk.indexOf(0x0a); offset >= 0; offset = chunk.indexOf(0x0a, offset + 1)) {
        newlineOffsets.push(offset);
      }
      if (scannedThrough === undefined && newlineOffsets.length > 0) {
        scannedThrough = pos + newlineOffsets.at(-1)! + 1;
      }
      if (newlineOffsets.length === 0) {
        if (chunk.length + suffix.length > CLAUDE_TURN_AUTHORITY_MAX_RECORD_BYTES) {
          result = { kind: 'fallback', authority: 'unknown', reason: 'record-limit', scannedThrough: st.size, scannedBytes };
          break;
        }
        suffix = Buffer.concat([chunk, suffix], chunk.length + suffix.length);
        await yieldToEventLoop();
        continue;
      }

      let right = chunk.length;
      for (let i = newlineOffsets.length - 1; i >= 0; i--) {
        const left = newlineOffsets[i]! + 1;
        const fragment = chunk.subarray(left, right);
        const recordLength = fragment.length + suffix.length;
        if (recordLength > CLAUDE_TURN_AUTHORITY_MAX_RECORD_BYTES) {
          result = { kind: 'fallback', authority: 'unknown', reason: 'record-limit', scannedThrough: st.size, scannedBytes };
          break scan;
        }
        const record = suffix.length > 0
          ? Buffer.concat([fragment, suffix], recordLength)
          : fragment;
        const authority = claudeRecordTurnAuthority(record);
        if (authority) {
          result = {
            kind: 'authority',
            authority,
            scannedThrough: scannedThrough ?? 0,
            scannedBytes,
          };
          break scan;
        }
        suffix = Buffer.alloc(0);
        right = newlineOffsets[i]!;
      }
      suffix = chunk.subarray(0, right);
      if (suffix.length > CLAUDE_TURN_AUTHORITY_MAX_RECORD_BYTES) {
        result = { kind: 'fallback', authority: 'unknown', reason: 'record-limit', scannedThrough: st.size, scannedBytes };
        break;
      }
      await yieldToEventLoop();
    }
    if (!result) {
      const authority = claudeRecordTurnAuthority(suffix);
      result = {
        kind: 'authority',
        authority: authority ?? 'unknown',
        scannedThrough: scannedThrough ?? 0,
        scannedBytes,
      };
    }
    options.beforeValidation?.();
    if (!claudeAuthorityGuardStillMatches(path, fd, guard)) {
      return { kind: 'fallback', authority: 'unknown', reason: 'source-changed', scannedThrough: st.size, scannedBytes };
    }
    return {
      ...result,
      tail: last[0] === 0x0a
        ? { kind: 'complete' }
        : result.kind === 'authority'
          ? { kind: 'partial', start: result.scannedThrough }
          : { kind: 'opaque' },
    };
  } catch {
    return { kind: 'fallback', authority: 'unknown', reason: 'source-changed', scannedThrough: st.size, scannedBytes };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

type ClaudeRangeAuthorityScan =
  | {
      kind: 'authority';
      authority: ClaudeTranscriptTurnAuthority;
      tail: ClaudeAuthorityTail;
      scannedBytes: number;
      processedThrough: number;
      candidateAuthority: ClaudeTranscriptTurnAuthority;
      candidateAuthoritative: boolean;
      reason?: undefined;
    }
  | {
      kind: 'fallback';
      authority: ClaudeTranscriptTurnAuthority;
      reason: ClaudeTurnAuthorityFallbackReason;
      tail: ClaudeAuthorityTail;
      scannedBytes: number;
      processedThrough: number;
      candidateAuthority: ClaudeTranscriptTurnAuthority;
      candidateAuthoritative: boolean;
    };

/** Cooperatively advance an admitted transcript without revisiting an unbounded suffix.
 *
 * Observed EOF and processed position advance independently. A partial record may be reread once;
 * an oversized tail remains opaque across calls until a newline. Exact candidates are retained
 * while catching up but published only at validated EOF. */
async function scanClaudeAuthorityRange(
  path: string,
  st: ClaudeAuthorityStat,
  cached: ClaudeTurnAuthorityEntry,
  options: ClaudeTurnAuthorityScanOptions = {},
): Promise<ClaudeRangeAuthorityScan> {
  const maxSourceBytes = Math.max(
    CLAUDE_TURN_AUTHORITY_CHUNK_BYTES,
    options.maxSourceBytes ?? CLAUDE_TURN_AUTHORITY_MAX_SOURCE_BYTES,
  );
  const deadline = Date.now()
    + Math.max(1, options.maxElapsedMs ?? CLAUDE_TURN_AUTHORITY_MAX_ELAPSED_MS);
  const initialAuthority = cached.authority;
  let candidateAuthority = cached.candidateAuthority;
  let candidateAuthoritative = cached.candidateAuthoritative;
  let fallbackReason = cached.fallbackReason;
  let scannedBytes = 0;
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const opened = fstatSync(fd);
    if (!claudeAuthorityStatMatches(st, opened)) {
      return { kind: 'fallback', authority: cached.authority, reason: 'source-changed', tail: cached.tail, scannedBytes, processedThrough: cached.processedSize, candidateAuthority, candidateAuthoritative };
    }
    const guard = claudeAuthorityGuardFromFd(fd, opened);
    const start = cached.tail.kind === 'partial' ? cached.tail.start : cached.processedSize;
    let pos = start;
    let fragments: Buffer[] = [];
    let fragmentBytes = 0;
    let skippingOversized = cached.tail.kind === 'opaque';
    let boundedReason: ClaudeTurnAuthorityFallbackReason | undefined;

    while (pos < st.size) {
      if (scannedBytes >= maxSourceBytes) {
        boundedReason = 'source-limit';
        break;
      }
      if (Date.now() > deadline) {
        boundedReason = 'time-limit';
        break;
      }
      const len = Math.min(
        CLAUDE_TURN_AUTHORITY_CHUNK_BYTES,
        st.size - pos,
        maxSourceBytes - scannedBytes,
      );
      const chunk = Buffer.alloc(len);
      if (readSync(fd, chunk, 0, len, pos) !== len) {
        boundedReason = 'source-changed';
        break;
      }
      scannedBytes += len;
      let segmentStart = 0;
      for (let newline = chunk.indexOf(0x0a); newline >= 0; newline = chunk.indexOf(0x0a, newline + 1)) {
        const fragment = chunk.subarray(segmentStart, newline);
        if (skippingOversized) {
          skippingOversized = false;
        } else if (fragmentBytes + fragment.length <= CLAUDE_TURN_AUTHORITY_MAX_RECORD_BYTES) {
          const recordLength = fragmentBytes + fragment.length;
          const record = fragments.length > 0
            ? Buffer.concat([...fragments, fragment], recordLength)
            : fragment;
          const next = claudeRecordTurnAuthority(record);
          if (next) {
            candidateAuthority = next;
            candidateAuthoritative = true;
          }
        }
        fragments = [];
        fragmentBytes = 0;
        segmentStart = newline + 1;
      }
      const trailing = chunk.subarray(segmentStart);
      if (!skippingOversized && trailing.length > 0) {
        if (fragmentBytes + trailing.length > CLAUDE_TURN_AUTHORITY_MAX_RECORD_BYTES) {
          fragments = [];
          fragmentBytes = 0;
          skippingOversized = true;
          fallbackReason = 'record-limit';
          candidateAuthority = initialAuthority;
          candidateAuthoritative = false;
        } else {
          fragments.push(trailing);
          fragmentBytes += trailing.length;
        }
      }
      pos += len;
      await yieldToEventLoop();
    }

    if (!boundedReason && !skippingOversized && fragmentBytes > 0) {
      const trailingAuthority = claudeRecordTurnAuthority(Buffer.concat(fragments, fragmentBytes));
      if (trailingAuthority) {
        candidateAuthority = trailingAuthority;
        candidateAuthoritative = true;
      }
    }

    let tail: ClaudeAuthorityTail;
    if (skippingOversized) tail = { kind: 'opaque' };
    else if (fragmentBytes > 0) tail = { kind: 'partial', start: pos - fragmentBytes };
    else tail = { kind: 'complete' };
    if (boundedReason) fallbackReason = boundedReason;
    else if (skippingOversized) fallbackReason = 'record-limit';

    options.beforeValidation?.();
    if (!claudeAuthorityGuardStillMatches(path, fd, guard)) {
      return { kind: 'fallback', authority: cached.authority, reason: 'source-changed', tail: cached.tail, scannedBytes, processedThrough: cached.processedSize, candidateAuthority: cached.candidateAuthority, candidateAuthoritative: cached.candidateAuthoritative };
    }
    const caughtUp = !boundedReason && pos === st.size;
    if (caughtUp && candidateAuthoritative && !skippingOversized) {
      return { kind: 'authority', authority: candidateAuthority, tail, scannedBytes, processedThrough: pos, candidateAuthority, candidateAuthoritative };
    }
    return {
      kind: 'fallback',
      authority: initialAuthority,
      reason: fallbackReason ?? 'record-limit',
      tail,
      scannedBytes,
      processedThrough: pos,
      candidateAuthority,
      candidateAuthoritative,
    };
  } catch {
    return { kind: 'fallback', authority: cached.authority, reason: 'source-changed', tail: cached.tail, scannedBytes, processedThrough: cached.processedSize, candidateAuthority: cached.candidateAuthority, candidateAuthoritative: cached.candidateAuthoritative };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

function claudeRecordTurnAuthority(
  record: Buffer,
): Exclude<ClaudeTranscriptTurnAuthority, 'unknown'> | undefined {
  const raw = record.toString('utf8');
  if (!/"type"\s*:\s*"(?:assistant|user|system)"/.test(raw)) return undefined;
  const line = parseLineOrNull(raw);
  return line ? claudeLineTurnAuthority(line) : undefined;
}

function claudeAuthoritySourceKey(st: ClaudeAuthorityStat): string {
  return `${String(st.dev ?? 'unknown')}:${String(st.ino ?? 'unknown')}`;
}

interface ClaudeAuthorityGuard {
  sourceKey: string;
  size: number;
  mtimeMs: number;
  prefixLength: number;
  prefixHash: string;
  boundaryLength: number;
  boundaryHash: string;
}

function claudeAuthorityFdRangeHash(fd: number, offset: number, length: number): string {
  if (length <= 0) return '';
  const bytes = Buffer.alloc(length);
  const read = readSync(fd, bytes, 0, length, offset);
  return createHash('sha256').update(bytes.subarray(0, read)).digest('hex');
}

function claudeAuthorityStatMatches(expected: ClaudeAuthorityStat, actual: ClaudeAuthorityStat): boolean {
  return expected.size === actual.size
    && expected.mtimeMs === actual.mtimeMs
    && claudeAuthoritySourceKey(expected) === claudeAuthoritySourceKey(actual);
}

function claudeAuthorityGuardFromFd(fd: number, st: ClaudeAuthorityStat): ClaudeAuthorityGuard {
  const prefixLength = Math.min(CLAUDE_TURN_AUTHORITY_SAMPLE_BYTES, st.size);
  const boundaryLength = Math.min(CLAUDE_TURN_AUTHORITY_SAMPLE_BYTES, st.size);
  return {
    sourceKey: claudeAuthoritySourceKey(st),
    size: st.size,
    mtimeMs: st.mtimeMs,
    prefixLength,
    prefixHash: claudeAuthorityFdRangeHash(fd, 0, prefixLength),
    boundaryLength,
    boundaryHash: claudeAuthorityFdRangeHash(fd, st.size - boundaryLength, boundaryLength),
  };
}

function claudeAuthorityGuardStillMatches(
  path: string,
  fd: number,
  guard: ClaudeAuthorityGuard,
): boolean {
  const opened = fstatSync(fd);
  const current = statSafe(path);
  const matchesGuard = (candidate: ClaudeAuthorityStat): boolean =>
    candidate.size === guard.size
    && candidate.mtimeMs === guard.mtimeMs
    && claudeAuthoritySourceKey(candidate) === guard.sourceKey;
  if (!current || !matchesGuard(opened) || !matchesGuard(current)) return false;
  return claudeAuthorityFdRangeHash(fd, 0, guard.prefixLength) === guard.prefixHash
    && claudeAuthorityFdRangeHash(
      fd,
      guard.size - guard.boundaryLength,
      guard.boundaryLength,
    ) === guard.boundaryHash
    && claudeAuthorityRangeHash(path, 0, guard.prefixLength) === guard.prefixHash
    && claudeAuthorityRangeHash(
      path,
      guard.size - guard.boundaryLength,
      guard.boundaryLength,
    ) === guard.boundaryHash;
}

function claudeAuthorityRangeHash(path: string, offset: number, length: number): string {
  if (length <= 0) return '';
  try {
    return createHash('sha256').update(readBytesFrom(path, offset, length)).digest('hex');
  } catch {
    return '';
  }
}

function claudeAuthorityAppendCompatible(
  path: string,
  st: ClaudeAuthorityStat,
  entry: ClaudeTurnAuthorityEntry,
): boolean {
  if (st.size < entry.size || claudeAuthoritySourceKey(st) !== entry.sourceKey) return false;
  if (
    entry.prefixLength > 0 &&
    claudeAuthorityRangeHash(path, 0, entry.prefixLength) !== entry.prefixHash
  ) return false;
  if (
    entry.boundaryLength > 0 &&
    claudeAuthorityRangeHash(path, entry.size - entry.boundaryLength, entry.boundaryLength) !== entry.boundaryHash
  ) return false;
  return true;
}

function refreshClaudeAuthoritySamples(
  path: string,
  st: ClaudeAuthorityStat,
  entry: ClaudeTurnAuthorityEntry,
): void {
  entry.sourceKey = claudeAuthoritySourceKey(st);
  entry.prefixLength = Math.min(CLAUDE_TURN_AUTHORITY_SAMPLE_BYTES, st.size);
  entry.prefixHash = claudeAuthorityRangeHash(path, 0, entry.prefixLength);
  entry.boundaryLength = Math.min(CLAUDE_TURN_AUTHORITY_SAMPLE_BYTES, entry.size);
  entry.boundaryHash = claudeAuthorityRangeHash(path, entry.size - entry.boundaryLength, entry.boundaryLength);
}

function rememberClaudeTurnAuthority(path: string, entry: ClaudeTurnAuthorityEntry): void {
  claudeTurnAuthorityCache.delete(path);
  if (claudeTurnAuthorityCache.size >= CLAUDE_TURN_AUTHORITY_CACHE_MAX) {
    const terminal = [...claudeTurnAuthorityCache].find(([, candidate]) => candidate.authority !== 'active');
    const evict = terminal?.[0] ?? claudeTurnAuthorityCache.keys().next().value;
    if (typeof evict === 'string') claudeTurnAuthorityCache.delete(evict);
  }
  claudeTurnAuthorityCache.set(path, entry);
}

/** One status projection shared by discovery and Observe attach.
 *
 * Exact terminal transcript authority always wins. Exact active transcript authority preserves a
 * live process through arbitrarily quiet tools, but cannot manufacture Working after that process
 * has exited: it must be qualified by the current `agents --json` row. Background-task and freshness
 * fallbacks apply only when the transcript has no exact latest-turn evidence. */
export async function claudeSessionStatus(
  path: string,
  raw: RawStatus | undefined,
  now: number,
): Promise<RawStatus> {
  const authority = await claudeTranscriptTurnAuthority(path);
  if (authority === 'terminal') return 'idle';
  if (authority === 'active') {
    if (raw === 'needs-input') return 'needs-input';
    return raw === 'working' ? 'working' : 'idle';
  }
  const st = statSafe(path);
  const conversationTs = lastConversationTs(path) ?? st?.mtimeMs ?? 0;
  const pendingBg = pendingBackgroundSpawnMs(path, now);
  if (pendingBg != null && raw !== 'needs-input') return 'working';
  const gateMtime = raw === 'working'
    ? Math.max(conversationTs, activityHeartbeatMs(path))
    : conversationTs;
  return freshnessGate(raw, gateMtime, now);
}

/** Fallback recency for raw busy rows whose transcript has no exact latest-turn evidence. */
const WORKING_FRESH_MS = 120_000;
/** A parent-launched background Task/Agent is still real work even after the parent has emitted the
 *  immediate async-launch acknowledgement and `agents --json` reads idle. Keep the roster working until
 *  the parent receives the task notification, or the launch is old enough to be treated as abandoned. */
const BACKGROUND_PENDING_MS = 1_800_000; // 30 min
/** Abandonment window for a LIVE workflow with no top-level json. Measured against the run dir's freshest
 *  file (the per-agent agent-*.jsonl heartbeats, NOT the start/finish-only journal), so it is intentionally
 *  generous: a real fan-out streams agent output far more often than this, so only a crashed/old run (e.g.
 *  one replayed from history) ever trips it → settles to 'done' instead of lingering as a running bar. */
const WORKFLOW_STALE_MS = 1_800_000; // 30 min

/** Gate a raw `agents --json` status by transcript recency only after exact turn projection. A
 *  fallback 'working' must be fresh or it is a wedged/orphaned process. 'needs-input' is left UNGATED: a real permission prompt
 *  legitimately idles for many minutes while it waits on the human, and a stale needs-input is far
 *  less harmful than a stale working (the broker overlay also refuses to clobber needs-input). */
export function freshnessGate(raw: RawStatus | undefined, mtimeMs: number, now: number): RawStatus {
  if (raw === 'working') return now - mtimeMs <= WORKING_FRESH_MS ? 'working' : 'idle';
  if (raw === 'needs-input') return 'needs-input';
  return 'idle';
}

/** Best-effort live status from `<bin> agents --json` for ONE store (headless, no TTY, no model cost).
 *  `agents --json` is config-dir-scoped, so we run it with the store's CLAUDE_CONFIG_DIR to cover
 *  wrapper sessions too (Issue D). Maps sessionId → {raw status, waitingFor reason}; when the roster
 *  has DUPLICATE rows for a sessionId, the most-actionable wins (needs-input > working > idle) instead
 *  of last-row-wins clobber (Issue F). `state` (background-agent rows) is intentionally ignored.
 *
 *  ASYNC + cached + single-flighted (2026-07-03 perf must-fix): the subprocess costs ~0.5-2s per store
 *  and used to run as a blocking spawnSync inside every roster poll — 3 stores × a 6s poll cadence
 *  starved the whole broker event loop. One result is reused for ~2.5s; overlapping discoveries share
 *  one in-flight subprocess instead of stacking them. */
const LIVE_STATUS_TTL_MS = 2500;
const LIVE_STATUS_FAILURE_GRACE_MS = 10_000;
export type LiveStatusMap = Map<string, { status: RawStatus; waitingFor?: string }>;
export type LiveStatusProbe = { ok: true; map: LiveStatusMap } | { ok: false; map: LiveStatusMap };
const liveStatusCache = new Map<string, { at: number; map: LiveStatusMap }>();
const liveStatusInflight = new Map<string, Promise<LiveStatusMap>>();

/** A failed native probe is unknown, not an authoritative empty process list. Preserve the last
 * successful snapshot briefly so a one-off CLI timeout cannot flip every active row Idle. A
 * successful empty array remains authoritative and clears stale Working immediately. */
export function selectClaudeLiveStatusAfterProbe(
  probe: LiveStatusProbe,
  previous: { at: number; map: LiveStatusMap } | undefined,
  now: number,
  failureGraceMs = LIVE_STATUS_FAILURE_GRACE_MS,
): LiveStatusMap {
  if (probe.ok) return probe.map;
  if (previous && now - previous.at <= failureGraceMs) return previous.map;
  return new Map();
}

async function liveStatusByStore(store: ClaudeStore): Promise<LiveStatusMap> {
  const key = store.configDir;
  const hit = liveStatusCache.get(key);
  if (hit && Date.now() - hit.at < LIVE_STATUS_TTL_MS) return hit.map;
  const inflight = liveStatusInflight.get(key);
  if (inflight) return inflight;
  const p = runAgentsJson(store)
    .then((probe) => {
      const now = Date.now();
      if (probe.ok) liveStatusCache.set(key, { at: now, map: probe.map });
      return selectClaudeLiveStatusAfterProbe(probe, liveStatusCache.get(key), now);
    })
    .finally(() => {
      liveStatusInflight.delete(key);
    });
  liveStatusInflight.set(key, p);
  return p;
}

function runAgentsJson(store: ClaudeStore): Promise<LiveStatusProbe> {
  const m: LiveStatusMap = new Map();
  // Honor DEFAULT_BIN (COSYNCING_CLAUDE_BIN test hook) for the default store, consistent with resume/discovery —
  // production is unchanged (DEFAULT_BIN='claude' → resolved on PATH); a test fake is now used uniformly.
  const bin = store.isDefault ? resolveBin(DEFAULT_BIN) ?? DEFAULT_BIN : store.bin;
  if (!bin) return Promise.resolve({ ok: true, map: m });
  const rank: Record<RawStatus, number> = { 'needs-input': 0, working: 1, idle: 2 };
  return new Promise((resolveStatus) => {
    execFile(
      bin,
      ['agents', '--json'],
      {
        timeout: 2000,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_CONFIG_DIR: store.configDir },
      },
      (err, stdout) => {
        try {
          if (err || !stdout) {
            resolveStatus({ ok: false, map: m });
            return;
          }
          const arr = JSON.parse(stdout);
          if (!Array.isArray(arr)) {
            resolveStatus({ ok: false, map: m });
            return;
          }
          for (const a of arr) {
            const id = a?.sessionId;
            if (!id) continue;
            const s = a?.status;
            const status: RawStatus = s === 'busy' ? 'working' : s === 'waiting' ? 'needs-input' : 'idle';
            const prev = m.get(String(id));
            if (prev && rank[prev.status] <= rank[status]) continue; // keep the more-actionable existing row
            m.set(String(id), { status, waitingFor: typeof a?.waitingFor === 'string' ? a.waitingFor : undefined });
          }
          resolveStatus({ ok: true, map: m });
        } catch {
          resolveStatus({ ok: false, map: m });
        }
      },
    );
  });
}

// ── discovery reads (bounded; never slurp a 27MB transcript at discovery) ──────

/** Stat-validated per-file fact memo (2026-07-03 perf must-fix). Discovery re-derives title/model/
 *  head-info for EVERY session transcript on EVERY roster poll (~600 files × up to ~450KB of reads
 *  each = hundreds of MB of synchronous I/O per poll). These facts only change when the file does,
 *  so cache them keyed by (size, mtimeMs); an unchanged file costs one stat. The whole cache is
 *  dropped past a soft cap so deleted sessions can't accumulate forever. */
const FILE_FACT_CACHE_MAX = 8192;
const fileFactCache = new Map<string, { size: number; mtimeMs: number; facts: Map<string, unknown> }>();
function cachedFileFact<T>(path: string, kind: string, compute: () => T): T {
  const st = statSafe(path);
  if (!st) return compute(); // missing/unreadable file: never cache
  let entry = fileFactCache.get(path);
  if (!entry || entry.size !== st.size || entry.mtimeMs !== st.mtimeMs) {
    if (fileFactCache.size >= FILE_FACT_CACHE_MAX) fileFactCache.clear();
    entry = { size: st.size, mtimeMs: st.mtimeMs, facts: new Map() };
    fileFactCache.set(path, entry);
  }
  if (entry.facts.has(kind)) return entry.facts.get(kind) as T;
  const value = compute();
  entry.facts.set(kind, value);
  return value;
}

/** First lines of a file, bounded to maxBytes (drops a final partial line when capped). */
function readHeadLines(path: string, maxBytes: number): string[] {
  const st = statSafe(path);
  if (!st) return [];
  const n = Math.min(st.size, maxBytes);
  let text: string;
  try {
    text = readBytesFrom(path, 0, n).toString('utf8');
  } catch {
    return [];
  }
  const segs = text.split('\n');
  if (segs.length && segs[segs.length - 1] === '') segs.pop();
  else if (n < st.size && segs.length) segs.pop(); // capped → last segment is partial
  return segs;
}

/** Last complete lines of a file, bounded to the trailing maxBytes (drops a leading partial line). */
function readTailLines(path: string, maxBytes: number): string[] {
  const st = statSafe(path);
  if (!st) return [];
  const start = st.size > maxBytes ? st.size - maxBytes : 0;
  let text: string;
  try {
    text = readBytesFrom(path, start, st.size - start).toString('utf8');
  } catch {
    return [];
  }
  const segs = text.split('\n');
  if (segs.length && segs[segs.length - 1] === '') segs.pop();
  if (start > 0 && segs.length) segs.shift(); // possibly-partial leading line
  return segs;
}

/** cwd (authoritative, from the first conversation line) + a first-real-user-message title fallback,
 *  from ONE bounded head read. The slug dir name is lossy, so cwd is always read from the file. */
function readHeadInfo(path: string): { cwd?: string; firstUser?: string; firstUserUuid?: string; model?: string } {
  return cachedFileFact(path, 'head', () => computeHeadInfo(path));
}
function computeHeadInfo(path: string): { cwd?: string; firstUser?: string; firstUserUuid?: string; model?: string } {
  let cwd: string | undefined;
  let firstUser: string | undefined;
  let firstUserUuid: string | undefined;
  let model: string | undefined;
  for (const seg of readHeadLines(path, 128 * 1024)) {
    const o = parseLineOrNull(seg);
    if (!o) continue;
    if (!cwd && typeof o.cwd === 'string' && o.cwd) cwd = o.cwd;
    if (!firstUserUuid && o.type === 'user' && typeof o.uuid === 'string' && o.uuid) firstUserUuid = o.uuid;
    // Producing model for the roster label (Issue D): first NON-synthetic assistant model — synthetic
    // marks injected API-error/compaction lines, never the real model.
    if (!model && o.type === 'assistant') {
      const md = o.message?.model;
      if (typeof md === 'string' && md && md !== '<synthetic>') model = md;
    }
    if (!firstUser && o.type === 'user' && !o.isMeta && !o.isCompactSummary) {
      const c = o.message?.content;
      let text: string | undefined;
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) text = c.find((b: any) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim())?.text;
      if (text && text.trim() && !isWrapper(text) && !isBadTitle(text)) firstUser = text.trim().slice(0, 120);
    }
    if (cwd && firstUser && firstUserUuid && model) break;
  }
  return { cwd, firstUser, firstUserUuid, model };
}

/** A title candidate that is really machine boilerplate, not a human label: the post-compaction summary
 *  (sometimes auto-derived into a custom-title/ai-title of a branched session) or a headless system
 *  preamble. Rejected so the roster shows a real title (falls through to the next candidate). */
function isBadTitle(t: string | undefined): boolean {
  return (
    !t ||
    /^\s*This session is being continued from a previous conversation/.test(t) ||
    /^\s*You are running headless/.test(t) // real headless prompts carry leading indentation
  );
}

/** Best title from the tail: latest custom-title (user-set) > ai-title (model) > last-prompt. */
function readTitle(path: string): string | undefined {
  return cachedFileFact(path, 'title', () => computeTitle(path));
}
function computeTitle(path: string): string | undefined {
  let custom: string | undefined;
  let ai: string | undefined;
  let last: string | undefined;
  for (const seg of readTailLines(path, 64 * 1024)) {
    const o = parseLineOrNull(seg);
    if (!o) continue;
    if (o.type === 'custom-title' && typeof o.customTitle === 'string') custom = o.customTitle;
    else if (o.type === 'ai-title' && typeof o.aiTitle === 'string') ai = o.aiTitle;
    else if (o.type === 'last-prompt' && typeof o.lastPrompt === 'string') last = o.lastPrompt;
  }
  const t = [custom, ai, last].find((c) => c && !isBadTitle(c));
  return t ? t.slice(0, 120) : undefined;
}

/** The session's CURRENT model: the most-recent NON-synthetic assistant `message.model` in the
 *  transcript. Unlike readHeadInfo's cwd/first-user (inherently head facts), the running model can change
 *  over a session's life — one started on opus-4-6 and later continued on opus-4-8 must report opus-4-8 —
 *  so this reads the TAIL. A single final assistant line can be multi-MB, so the window escalates; returns
 *  undefined if no real model is found (the caller falls back to the head model). */
export function readLatestModel(path: string): string | undefined {
  return cachedFileFact(path, 'latest-model', () => computeLatestModel(path));
}
function computeLatestModel(path: string): string | undefined {
  const st = statSafe(path);
  if (!st) return undefined;
  for (const win of [256 * 1024, 4 * 1024 * 1024]) {
    let model: string | undefined;
    for (const seg of readTailLines(path, win)) {
      const o = parseLineOrNull(seg);
      if (!o || o.type !== 'assistant') continue;
      const md = o.message?.model;
      if (typeof md === 'string' && md && md !== '<synthetic>') model = md; // keep last → most recent
    }
    if (model) return model;
    if (win >= st.size) break; // already read the whole file; a bigger window cannot help
  }
  return undefined;
}

/** Last timestamped conversation event in the transcript tail. Claude sidecar churn can rewrite
 *  timestamp-less lines (`permission-mode`, `bridge-session`) and bump mtime without a real turn; roster
 *  recency and the busy freshness gate must ignore that. */
export function lastConversationTs(path: string): number | undefined {
  return cachedFileFact(path, 'last-conversation-ts', () => computeLastConversationTs(path));
}
function computeLastConversationTs(path: string): number | undefined {
  let latest: number | undefined;
  for (const seg of readTailLines(path, 256 * 1024)) {
    const o = parseLineOrNull(seg);
    if (!o || (o.type !== 'user' && o.type !== 'assistant' && o.type !== 'system')) continue;
    const ts = timestampToMs(o.timestamp);
    if (ts !== undefined && (latest === undefined || ts > latest)) latest = ts;
  }
  return latest;
}

function pendingBackgroundSpawnMs(path: string, now: number): number | undefined {
  const ts = cachedFileFact(path, 'pending-background-spawn-ms', () => computePendingBackgroundSpawnMs(path));
  return ts !== undefined && now - ts < BACKGROUND_PENDING_MS ? ts : undefined;
}

function computePendingBackgroundSpawnMs(path: string): number | undefined {
  const resolved = new Set<string>();
  const background = new Set<string>();
  const notified = new Set<string>();
  const spawnMs = new Map<string, number>();
  const extra = { killedAgentIds: new Set<string>(), agentIdToToolUseId: new Map<string, string>(), stopRequests: new Map<string, string>() };
  for (const seg of readTailLines(path, 512 * 1024)) {
    const o = parseLineOrNull(seg);
    if (o) collectParentActivity(o, resolved, background, notified, spawnMs, extra);
  }
  let newest: number | undefined;
  for (const id of background) {
    if (notified.has(id)) continue;
    const ts = spawnMs.get(id);
    if (ts !== undefined && (newest === undefined || ts > newest)) newest = ts;
  }
  return newest;
}

/** The session's CURRENT permission mode: the most-recent `permission-mode` sidecar line's `permissionMode`
 *  (Claude writes one at launch and on every Shift+Tab mode change — verified shape `{type:'permission-mode',
 *  permissionMode:'auto'}`). Read from the TAIL like {@link readLatestModel} because the mode can change over
 *  a session's life and only the latest is current. The line is SKIPPED from the conversation mapping (sidecar
 *  app-state), but it is the authoritative source for the picker's current value. Returns undefined when no
 *  permission-mode line exists — then the UI shows NO mode value, never an invented default (doc-14:
 *  docs/architecture/client-ui.md "Do not invent values"). */
export function readLatestPermissionMode(path: string): string | undefined {
  return cachedFileFact(path, 'permission-mode', () => computeLatestPermissionMode(path));
}
function computeLatestPermissionMode(path: string): string | undefined {
  const st = statSafe(path);
  if (!st) return undefined;
  for (const win of [256 * 1024, 4 * 1024 * 1024]) {
    let mode: string | undefined;
    for (const seg of readTailLines(path, win)) {
      const o = parseLineOrNull(seg);
      if (o?.type === 'permission-mode' && typeof o.permissionMode === 'string' && o.permissionMode) mode = o.permissionMode; // keep last → most recent
    }
    if (mode) return mode;
    if (win >= st.size) break; // whole file already read; a bigger window cannot help
  }
  return undefined;
}

// ── filesystem primitives ─────────────────────────────────────────────────────

function readBytesFrom(path: string, offset: number, length: number): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(Math.max(0, length));
    const n = readSync(fd, buf, 0, Math.max(0, length), offset);
    return buf.subarray(0, n);
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
  }
}

/** Read the whole file as a Buffer (so getHistory can find the last-newline byte boundary). */
function readFileBuffer(path: string): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = statSync(path).size;
    const buf = Buffer.alloc(size);
    const n = readSync(fd, buf, 0, size, 0);
    return buf.subarray(0, n);
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
  }
}

/** Split a JSONL blob into raw line segments, dropping only a trailing empty segment. */
function splitLines(text: string): string[] {
  const segs = text.split('\n');
  if (segs.length && segs[segs.length - 1] === '') segs.pop();
  return segs;
}

/** Parse one line; blank or malformed → null (a position-tolerant slot). */
function parseLineOrNull(s: string): any | null {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function statSafe(p: string) {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
}

const HISTORY_SOURCE_REWRITE_PREFIX_BYTES = 1024;

function fileHistorySourceIdentity(path: string): HistorySourceIdentity | undefined {
  const stat = statSafe(path);
  if (!stat) return undefined;
  const prefix = Buffer.alloc(
    Math.min(HISTORY_SOURCE_REWRITE_PREFIX_BYTES, stat.size),
  );
  let prefixBytes = 0;
  try {
    const fd = openSync(path, 'r');
    try {
      prefixBytes = readSync(fd, prefix, 0, prefix.length, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
  return {
    sourceId: `${path}:${stat.dev}:${stat.ino}`,
    revision: `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
    appendPosition: stat.size,
    rewriteToken: createHash('sha256')
      .update(prefix.subarray(0, prefixBytes))
      .digest('base64url'),
  };
}

function resolveBin(bin: string): string | null {
  try {
    return Bun.which(bin);
  } catch {
    return null;
  }
}
