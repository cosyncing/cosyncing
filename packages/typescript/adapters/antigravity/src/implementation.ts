/**
 * Antigravity (`agy`) adapter — integrationKind 'sdk-callback'; attach modes: OBSERVE and RESUME.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT agy IS (MEASURED — spec §1, probes 2026-08-21; re-pinned 2026-08-25)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `agy` is a single self-contained Go binary that embeds the Antigravity
 * language server and runs it IN-PROCESS for the lifetime of one invocation. It
 * is not a daemon: between invocations nothing listens and nothing runs
 * (MEASURED `ss -ltnp` + `ps`, 2026-08-21). So there is no HTTP/RPC surface to
 * attach to, the kimi/dsh `http-websocket` shape is unavailable, and discovery
 * must read FILES — a poll that shells out to `agy` would pay a full workspace
 * init per tick.
 *
 * History comes from `brain/<id>/.system_generated/logs/transcript.jsonl` and
 * NEVER from the authoritative `conversations/<id>.db`. That store is protobuf
 * blobs with no shipped `.proto`, a 129-value step enum, and per-type payload
 * field numbers that are a `oneof` tag rather than an offset (spec §1.3/§3). A
 * hand-rolled reader would fail SILENTLY the next time the binary auto-updates.
 * The JSONL is self-describing, its `type` vocabulary is 16 values, it parsed
 * 2,664/2,664 lines across 29 files, and it carries `step_index` — so if the
 * protobuf is ever needed, the join key already exists.
 *
 * ── VERSION DRIFT IS THE STANDING HAZARD ───────────────────────────────────
 * The binary REPLACES ITSELF with no user action. It went 1.1.13 → 1.1.17
 * during a fifteen-minute read-only probe on 2026-08-21, and 1.1.17 → **1.1.20**
 * again on 2026-08-25 (image dated 14:38; the 1.1.17 image parked beside it as
 * `agy.*.old`; `updater/update_status.json` reads "Update successful, restart
 * CLI to use"). Between 1.1.13 and 1.1.17 the CLI grew an entire drive surface.
 * Every wire claim below therefore carries the version it was measured against,
 * and every fixture is named for its version. Nothing here is pinned to a
 * changelog: on 1.1.17 `agy models --output-format json` was REJECTED despite
 * the changelog announcing that flag (spec §0 P13). Upstream's own docs were
 * wrong about upstream's own wire.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FIFTEEN CHECKLIST ANSWERS (docs-internal/new-harness-requirements-reflection.md)
 * ═══════════════════════════════════════════════════════════════════════════
 * Answered here, in the adapter's own doc comment, with a dated probe for every
 * wire claim. Checklist item 12 makes this mandatory, and agy is where the
 * pattern starts — no existing adapter does it.
 *
 * Q1 — MODEL NAME AND ITS DISPLAY SOURCE.
 *   `~/.antigravity_cockpit/cache/available_models.json`, field `displayName`,
 *   joined by `id` (MEASURED 2026-08-25). The host publishes a REAL display
 *   name, so reflection §3 is satisfied at zero cost: the label is never derived
 *   from the id, and there is no family table.
 *   The hard half is which model a SESSION is on. `settings.json` holds a global
 *   LABEL, not a per-conversation id (`.model = "Gemini 3.7 Flash (High)"`,
 *   MEASURED), and the JSONL carries no model field (`model` is not among the 11
 *   observed keys). So P0 publishes `currentModel` only when that label joins the
 *   catalog cleanly, and otherwise publishes `currentModel: undefined` ON PURPOSE
 *   plus a structured trace. The join is refused outright when the label is
 *   AMBIGUOUS — four distinct ids all publish "Gemini 3.1 Flash Lite" (MEASURED)
 *   — because picking one of four would preselect a model the session is not on.
 *   The label rides the DISCOVERY row, not only attach: an unattached roster row
 *   was the common failing case (reflection §3, claude P2).
 *
 * Q2 — PERMISSION/APPROVAL MODE FIELD.
 *   The contract field is `currentMode`, never `permissionMode` (that is the
 *   `PromptInput` field name, and emitting it is the exact off-contract key that
 *   blanked kimi's picker — reflection §2).
 *   `permissionGranularity: 'per-tool'`, because `settings.json.permissions.allow`
 *   is a per-COMMAND-NAME allowlist of 84 entries (MEASURED) — dsh's situation,
 *   not kimi's per-session one.
 *   A DRIVE connection publishes `currentMode` from the live child's `init` event
 *   (`permission_mode`, MEASURED `"request-review"` even under `--mode=plan`), so
 *   it is a re-derived fact and not the value we asked for.
 *   STILL UNSUPPORTED: a DISCOVERY row carries no `currentMode`. No
 *   per-conversation mode record has been found — spec CAPTURE C2 is what would
 *   settle it — and inventing one would preselect a posture the session may not
 *   be in.
 *
 * Q3 — DOES CREATE ACCEPT A MODEL, AND HOW DOES ATTACH RE-DERIVE IT?
 *   Yes: `agy --model <id> --conversation <newId>` sets it at launch. P0 creates
 *   nothing, so there is nothing to re-derive yet. When P1 lands, the requested
 *   model is stored on the adapter's own per-session record AND re-read from the
 *   live child's `init` event, preferring `init` — because a return value spent
 *   on navigation is not state (reflection §5; dsh P9a discarded exactly this).
 *
 * Q4 — STABLE PER-SESSION NATIVE ID.
 *   Yes, and it is clean. The conversation UUID is the id in
 *   `conversations/<id>.db`, `brain/<id>/`, `presence/<id>.lock`,
 *   `conversation_summaries.conversation_id`, `conversation_metadata.json`, and
 *   `--conversation <ID>`: one id, six surfaces, all MEASURED.
 *   `SessionInfo.id` === `SessionInfo.nativeId` === that UUID, emitted FROM DAY
 *   ONE even though agy publishes no child rows yet (checklist item 4; its
 *   omission is the whole of dsh P4).
 *   NO PATH ENCODING, deliberately. claude base64-encodes its transcript path
 *   because its session id IS a file; agy's id is already opaque and native, so
 *   an encoder here would be a layer with nothing under it. Stated so nobody
 *   adds one later.
 *
 * Q5 — CHILD/SUBAGENT SESSIONS IN THE LISTING.
 *   UNSUPPORTED IN P0, and the schema disagrees with the corpus.
 *   `parent_conversation_id` and `nesting_depth` exist as columns and are
 *   empty/zero on all 32 rows; `conversation_metadata.json.is_internal` is false
 *   on all 32 (MEASURED 2026-08-25). Meanwhile the binary's string table names
 *   `invoke_subagent` and `MODEL_TIER_INHERIT`. So the capability plainly exists
 *   upstream and this host has never exercised it.
 *   The mapping is written down and left DORMANT rather than guessed at:
 *   `parent_conversation_id → parentThreadId`, `nesting_depth > 0 → origin:
 *   'subagent'`, behind spec CAPTURE C5. An unsupported answer with a written
 *   reason, not a blank.
 *   BACKGROUND TASKS ARE A DIFFERENT THING and ARE supported — see Q6.
 *
 * Q6 — EVERY SOURCE KIND, WITH A CATEGORY. NO CATCH-ALL.
 *   The complete `(source, type)` inventory lives in `mapping.ts` as a TABLE, in
 *   dsh's form. Sixteen pairs, MEASURED over the whole corpus twice — 2,647
 *   lines / 25 files on 2026-08-21 and 2,664 lines / 29 files on 2026-08-25 —
 *   with the SAME sixteen pairs both times. The corpus grew and the vocabulary
 *   did not, which is what makes it a closed set rather than a snapshot.
 *   `USER_EXPLICIT/USER_INPUT` is the ONLY human bubble. `SYSTEM` rows are agent
 *   machinery: context-injection, notice, error, or history-reset per the table.
 *   An unlisted pair lands in a NAMED NEUTRAL category carrying its own `source`
 *   and `type` — never a user bubble, never a throw.
 *   Key on the PAIR, never on `type` alone.
 *
 * Q7 — A PROMPT TYPED WHILE A TURN IS RUNNING.
 *   THE ADAPTER MINTS THE ROW ITSELF. agy records nothing we could read: its own
 *   `history.jsonl` stores typed prompts as `{display, timestamp, workspace}` —
 *   WORKSPACE-scoped, not conversation-scoped, written by the interactive TUI and
 *   not by a stream-json driver — so it cannot correlate to a conversation at all.
 *   Until the child writes the transcript line there is NO record anywhere that
 *   the user said this, and a page refresh would delete their words (reflection §6).
 *   So `sendPrompt` mints `queued:agy:<connNonce>.<seq>`, a namespace no
 *   transcript-derived key can collide with, emits it immediately as a
 *   `user-message` with `queued: true`, and APPENDS it from `getHistory()` — not
 *   `getHistoryOverlays()`, because an ordinary attach replays only the former, so
 *   an overlay never reaches a reloaded page.
 *   The delivering `USER_INPUT` line then CLAIMS that key rather than minting a
 *   second row, fenced by the transcript's BYTE SIZE at send time: clock-free, so
 *   a repeated "continue" or "yes" cannot claim a line written before its send.
 *   Rows and their correlation links are bounded TOGETHER — an evicted row must
 *   not leave a link whose only power is to lend its key to a later repeat.
 *   DEMOTION KEEPS THEM; only `close()` drops them. Every accepted prompt was
 *   already written to the child's stdin, so killing the child proves nothing
 *   about what it buffered.
 *
 * Q8 — LIVE STREAM AND HISTORY REPLAY: SAME MAPPER, SAME KEYS.
 *   Yes, by construction. `mapAgyStep()` is the one fold and
 *   `agyStepKey(conversationId, step_index)` is the one key function; both paths
 *   call them with the same state object.
 *   The two wire shapes DO differ, and NOT by a case fold: the stream names steps
 *   in lower snake case and the file in upper, with `agent_response` ↔
 *   `PLANNER_RESPONSE` (MEASURED, agy 1.1.17, spec §7.C1). `AGY_STREAM_STEP_NAMES`
 *   in `mapping.ts` normalizes the stream event into the transcript record shape
 *   AT THE BOUNDARY, so everything downstream is shared. That table is built now,
 *   in P0, even though its only consumer lands in P1 — it is the thing that makes
 *   the shared fold possible, so it cannot be an afterthought.
 *   `step_index` agrees exactly between the two for the same run (MEASURED, 0..4),
 *   and is unique within all 29 corpus transcripts, which is what makes it a real
 *   key rather than a synthesized one.
 *
 * Q9 — OWNERSHIP: WHICH REGISTRY, WHAT BROADCASTS.
 *   `drivenSessions` below: an ADAPTER-LEVEL, SESSION-KEYED, IDENTITY-AWARE map,
 *   read back by `discoverSessions()` so EVERY client's roster row reports the
 *   drive and not only the driving one (reflection §11).
 *   Deregistration is COMPARE-AND-SWAP on the connection's identity. The hub can
 *   attach a replacement BEFORE closing the incumbent it displaced, so an
 *   unconditional delete would let a stale close evict the live replacement —
 *   claude's identity-blind `Set` did exactly that, and the session drove on
 *   while every roster row said observing.
 *   A posture change BROADCASTS to every subscriber, on promotion and on
 *   demotion, as a `metadata-update` carrying `sessionInfo.control` — the only
 *   shape the broker folds onto `SessionInfo`. An attach snapshot describes the
 *   SESSION's posture, never the requester's mode.
 *   FOREIGN-WRITE DEMOTION: a `USER_EXPLICIT` line on the TAIL that neither
 *   claimed one of our pending keys nor matches a recent send means a terminal
 *   took the conversation. The connection stops writing (single writer) but keeps
 *   the tail running and keeps its pending rows.
 *   agy has no managed host and no daemon, so `describeManagedHost` /
 *   `managedHostIdentity` do not apply. If `presence/<id>.lock` turns out to be
 *   an advisory lock (spec CAPTURE C3), the pid read from it gets the house
 *   four-part treatment — pid + start + boot + identityKey, never `comm` — before
 *   it is allowed to refuse anything.
 *
 * Q10 — TERMINAL STATES.
 *   A finished turn leaves its `status: DONE` rows in the JSONL permanently:
 *   nothing to synthesize. A finished background task leaves BOTH a
 *   `task-<N>.log` and a settlement message in the inbox, both permanent — which
 *   is better than claude, whose finished subagents render nowhere.
 *   `status: RUNNING` appears on 28 corpus lines (rows written mid-turn). A
 *   RUNNING row replayed with NO live child renders as interrupted/unknown, never
 *   as running — reflection §9: collapse, never delete, and terminal state leaves
 *   a trace.
 *   `conversation_summaries.killed` and `.not_fully_idle` are 0/false on every
 *   row here, so no behaviour is built on them.
 *
 * Q11 — RESUME-IN-TERMINAL COMMAND.
 *   `agy --conversation <conversationId>`, run in the session's own directory.
 *   Emitted as `terminalSyncHint` on every row in P0 — this behaviour was closed
 *   on codex/pi/opencode and then reported AGAIN on kimi and claude (reflection
 *   §1), so it ships with the first phase rather than a later one.
 *   The cwd matters: `cache/last_conversations.json` is keyed by cwd, so the hint
 *   carries the workspace directory in `note` when the session has one.
 *
 * Q12 — EVERY UNSUPPORTED ANSWER WRITTEN DOWN.
 *   | capability                  | answer            | reason |
 *   |-----------------------------|-------------------|--------|
 *   | `origin`/`parentThreadId`   | unsupported       | columns exist, host populates them on none of 32 rows; CAPTURE C5 |
 *   | `currentMode` on a ROW      | unsupported       | no per-conversation mode record found; CAPTURE C2. A DRIVE connection does publish it, from `init` |
 *   | `token-count` in REPLAY     | unsupported       | counts live in the protobuf store and in the live `result` event, never in the JSONL. Drive emits it; a replay cannot |
 *   | `usage.thinking`            | unsupported       | agy reports a fourth token bucket the protocol has no field for. NOT folded into `output` — inventing a sum is the exact error `token-count` warns about |
 *   | `respondPermission`         | unsupported       | agy publishes no permission channel over stream-json, and answering by writing a prompt would put words in the conversation the user never typed |
 *   | `listModels`/`listModes`    | unsupported       | P2a/P2b; the catalog read exists here only to LABEL a row |
 *   | slash commands              | unsupported       | upstream: `/x` is "unavailable with `--input-format stream-json`" — so `listCommands` stays absent under drive |
 *   | `exportTranscript`          | unsupported       | no export subcommand exists; P2f would build it from the JSONL |
 *   | `sendFile` / attachments    | unsupported       | `.user_uploaded/` is EMPTY on every conversation, so the echo shape is entirely unmeasured; CAPTURE C6. kimi round 1 shipped a fixture asserting a shape the server cannot produce — that is the trap this refuses to repeat |
 *   | rename                      | unsupported       | no rename surface; `title` is empty on all 32 rows |
 *   | fork / clone                | unsupported       | the binary references a fork path but no flag exposes it |
 *
 * Q13 — ATTACHMENT ECHO.
 *   UNMEASURED, and blocked on CAPTURE C6 DELIBERATELY. `.user_uploaded/` exists
 *   on every conversation and is empty on every one, so no echo shape has ever
 *   been observed. `supportsNativeFileInput: false` is an honest no, not a guess.
 *   When the capture lands, the shape is already fixed by decisions made
 *   elsewhere (reflection §12): the echoed artifact carries
 *   `file-artifact.userMessageKey` pointing at its owning user row, and an
 *   attachment-only prompt still emits an empty-text `user-message` for it to
 *   point at.
 *
 * Q14 — CAN ONE DRIVE CONNECTION SERVE TWO SOCKETS?
 *   Yes — `supportsCrossClientDriveSharing: true`, declared explicitly below with
 *   the single-writer argument beside it. The field is OPTIONAL and defaults to
 *   false, so silence is a bug no type error catches, and its absence was the
 *   entirety of two shipped defects (reflection §11 for kimi, §1 for claude).
 *   Made TRUE by construction, not merely declared: the pending-row FIFO, the
 *   queued-key map and the submitted-text ring all live on the CONNECTION, so a
 *   peer socket's prompt travels through the same single writer against the same
 *   stdin and can never read as a foreign write.
 *
 * Q15 — EVERY NEW TEST FILE WIRED BEFORE THE LANE CLOSES.
 *   Five suites — `test-agy-store.ts`, `test-agy-mapping.ts`,
 *   `test-agy-observe.ts`, `test-agy-drive.ts`, `test-agy-identity.ts`. Gate
 *   wiring (package scripts, verification graph, completeness anchor) is a later
 *   integration pass and is NOT done here; an unwired suite is an orphan the gate
 *   never runs, and this repo already has one, so that pass is the one that
 *   closes this row.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FAILURE TRACES (reflection §8 — degrading is fine, degrading silently is not)
 * ═══════════════════════════════════════════════════════════════════════════
 *  - No `transcript.jsonl` → a NOTICE row saying so, never an empty session.
 *    2 of 27 CLI conversations are in this state (MEASURED).
 *  - A `truncated_fields` entry with no `transcript_full.jsonl` → the row renders
 *    with a STATED truncation, never silently short.
 *  - A model label that does not join the catalog, or joins ambiguously →
 *    `currentModel: undefined` stated on purpose, plus a trace naming the label.
 *  - An unlisted `(source, type)` → the named neutral row AND a trace, so a
 *    post-update vocabulary change is one grep from being seen.
 *  - A tool result that finds no pending call → a SELF-CONTAINED tool block and a
 *    trace, never a guessed correlation to an unrelated call.
 *  - A submitted turn whose stream CLOSES WITHOUT A `result` → a visible error and
 *    a trace. This is the measured exit-0 trap: an unrecognized input `event`
 *    makes agy exit 0 after only `init`, so an adapter that waits for `result`
 *    hangs forever with nothing to show.
 *  - A send against a dead, never-spawned or relaunching child → `sendPrompt`
 *    REJECTS before touching run state, so the client's send fails visibly rather
 *    than a prompt vanishing under a Running badge. No bare catch around the
 *    stdin write.
 *  - A child exit code → recorded as a trace and NEVER interpreted. 1.1.18 and
 *    1.1.20 both changed print-mode exit semantics in opposite directions, so the
 *    status cannot say whether a turn succeeded; only the `result` event can.
 *  - A stream envelope matching none of the three measured shapes → a trace
 *    naming its keys, rather than a silently empty transcript.
 */
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type {
  AgentBackend,
  AgentCapabilities,
  AgentSetupDiagnosis,
  AttachMode,
  AttachOptions,
  SessionConnection,
  SessionControlState,
  SessionDiscoveryOptions,
  SessionInfo,
  SetupDiagnosisContext,
} from '@cosyncing/adapter-api';
import { diagnoseAgySetup } from './diagnostics.ts';
import { AgyObserveConnection } from './observe.ts';
import { AgyDriveConnection } from './drive.ts';
import {
  defaultAgyRoots,
  findAgyBinary,
  isAgyConversationId,
  readAgyMetadata,
  readAgyModelCatalog,
  readAgySettingsModelLabel,
  readAgySummaries,
  resolveAgyModel,
  defaultAgyTraceSink,
  agyTranscriptPath,
  type AgyRoots,
  type AgyTraceSink,
} from './store.ts';

/** Backend id. `agy` is the command; `Antigravity` is the product (spec D6). */
export const AGY_BACKEND_ID = 'agy';
export const AGY_DISPLAY_NAME = 'Antigravity';

export const AGY_CAPABILITIES: AgentCapabilities = {
  integrationKind: 'sdk-callback',
  // `observe` FIRST, so an ordinary roster open never spawns a child and never
  // spends quota. Every `agy` invocation pays a full workspace init (spec §1.1),
  // so this ordering is a cost decision as much as a safety one. A drive is
  // entered only on an explicit `?mode=resume`.
  attachModes: ['observe', 'resume'],
  supportsObserve: true,
  // `agy --conversation <id>` resumes IN PLACE and never forks: a second NDJSON
  // invocation continues `step_index` and increments `num_turns` on the same
  // conversation (MEASURED 2026-08-25, agy 1.1.17). P0 refuses a resume attach —
  // the capability describes the AGENT, and P1 is what honours it.
  supportsResume: true,
  // No daemon, no socket, nothing running to join between invocations (MEASURED).
  supportsLiveAttach: false,
  /**
   * Q14. Two sockets may share ONE Drive connection through the broker's join.
   *
   * The Drive owner is this broker's own `agy --input-format stream-json` child.
   * A joining socket is handed the EXISTING `AgyDriveConnection` —
   * `Hub.joinExisting` never attaches — so the conversation still has exactly
   * one writer against one stdin, and both sockets' prompts reach it in order.
   * The pending-row FIFO and the queued-key map are per CONNECTION, so a peer
   * socket's prompt is never a foreign writer. A demotion publishes the new
   * control state to every subscriber at once.
   *
   * Declared here rather than when P1 lands because this field is OPTIONAL and
   * defaults to false: an adapter that stays silent is never offered the join
   * and every observer reads "observing" forever, which is precisely how this
   * shipped twice. dsh sets the flag bare with no adjacent argument — an
   * existing gap, not a precedent.
   */
  supportsCrossClientDriveSharing: true,
  // No measured artifact signal. `.user_uploaded/` is empty on every conversation.
  supportsNativeArtifact: false,
  // Q13: an honest no until CAPTURE C6 measures the echo shape.
  supportsNativeFileInput: false,
  // P1 relaunches with `--model`; observe ignores it.
  supportsModelSwitch: true,
  // `settings.json.permissions.allow` is per command name (84 entries, MEASURED).
  permissionGranularity: 'per-tool',
};

export interface AgyAdapterOptions {
  /** Injectable so the suites run against a temp fixture tree, never a live install. */
  roots?: AgyRoots;
  env?: NodeJS.ProcessEnv;
  trace?: AgyTraceSink;
  /** Ceiling on rows decoded per sweep. */
  discoveryLimit?: number;
}

export class AgyAdapter implements AgentBackend {
  readonly id = AGY_BACKEND_ID;
  readonly displayName = AGY_DISPLAY_NAME;
  readonly capabilities = AGY_CAPABILITIES;

  private readonly roots: AgyRoots;
  private readonly env: NodeJS.ProcessEnv;
  private readonly trace: AgyTraceSink;
  private readonly discoveryLimit: number;

  /**
   * Q9's registry: session id → the connection currently driving it.
   *
   * ADAPTER-LEVEL and SESSION-KEYED, never connection-scoped, so
   * `discoverSessions()` reports the drive to EVERY client rather than only to
   * the one holding the connection — reflection §11, and precisely what claude's
   * issue 15b had to fix.
   *
   * Deregistration is COMPARE-AND-SWAP on the connection's identity. The hub can
   * attach a replacement BEFORE closing the incumbent it displaced, so an
   * unconditional `delete` on close would let a stale connection evict the live
   * one that just took over: the session would drive on while every roster row
   * read "observing". Only the registered owner may remove its own entry.
   */
  private readonly drivenSessions = new Map<string, AgyDriveConnection>();

  constructor(options: AgyAdapterOptions = {}) {
    this.roots = options.roots ?? defaultAgyRoots();
    this.env = options.env ?? process.env;
    this.trace = options.trace ?? defaultAgyTraceSink;
    this.discoveryLimit = options.discoveryLimit ?? 500;
  }

  /**
   * Installed and usable: the binary is on PATH AND the CLI app-data root exists.
   *
   * Both halves are needed. The binary alone proves nothing — the IDE can be
   * installed with the CLI never having run, and there would be no store to
   * read. The directory alone proves nothing either — a removed binary leaves
   * its state behind, and every row would carry a resume command that cannot
   * run. The binary is never EXECUTED here: a `--version` spawn per availability
   * probe would pay a process launch on every roster sweep.
   */
  async isAvailable(): Promise<boolean> {
    return findAgyBinary(this.env) !== undefined && existsSync(this.roots.appData);
  }

  /**
   * `cosyncing doctor`. Required by REGISTRATION, not optional decoration: an
   * adapter on `shippedAdapters()` without this gets a synthesized hard failure
   * telling the operator to install a build that does not exist. See
   * `diagnostics.ts` for what it checks and what it deliberately does not.
   */
  async diagnoseSetup(context: SetupDiagnosisContext): Promise<AgentSetupDiagnosis> {
    return diagnoseAgySetup(context);
  }

  /**
   * The roster.
   *
   * IDE rows are excluded in SQL, at the boundary (spec R5): the CLI and the
   * Windows IDE share this one summaries table, and an IDE row would be a row
   * that can never open, since its per-conversation store is an opaque `.pb`
   * container we deliberately do not support.
   *
   * A conversation with a store but NO transcript still produces an HONEST row.
   * It discovers, it opens, and its history is a stated notice — never a crash,
   * never a silent blank.
   */
  async discoverSessions(options?: SessionDiscoveryOptions): Promise<SessionInfo[]> {
    const summaries = readAgySummaries(this.roots, {
      ...(options?.updatedAfter !== undefined ? { updatedAfter: options.updatedAfter } : {}),
      limit: this.discoveryLimit,
      ...(options?.onWork ? { onWork: options.onWork } : {}),
      trace: this.trace,
    });
    if (summaries.length === 0) return [];

    const metadata = readAgyMetadata(this.roots, this.trace);
    // Read ONCE per sweep, not per row: the catalog and the settings label are
    // global, and a per-row read would be N file reads for one answer.
    const catalog = readAgyModelCatalog(this.roots, this.trace);
    const settingsLabel = readAgySettingsModelLabel(this.roots, this.trace);
    const currentModel = resolveAgyModel(catalog, settingsLabel, this.trace);

    const out: SessionInfo[] = [];
    for (const row of summaries) {
      if (options?.signal?.aborted) break;
      const meta = metadata.get(row.conversationId);
      const cwd = row.workspaceDirs[0] ?? meta?.workspaceDirs[0];
      out.push({
        // Q4: id === nativeId === the conversation UUID. No path encoding.
        id: row.conversationId,
        nativeId: row.conversationId,
        tool: this.id,
        title: agyTitle(row.preview, meta?.preview, cwd, row.conversationId),
        ...(cwd ? { cwd, projectName: basename(cwd) } : {}),
        // Every row is idle. A row can only be `working` if something is running,
        // and P0 owns no child and has no proven terminal-ownership signal
        // (spec CAPTURE C3) — so claiming otherwise would be a guess, and a
        // permanently-spinning row is worse than an honest idle one.
        status: 'idle',
        attachMode: 'observe',
        ...(row.updatedAt !== undefined ? { updatedAt: row.updatedAt } : {}),
        // Q1: the label rides the DISCOVERY row, and an unresolvable model is an
        // explicit `undefined` rather than an omitted key (reflection §2).
        currentModel,
        // Q9: the posture comes from the ADAPTER's registry, so a client that is
        // merely observing still sees that this session is being driven — and can
        // therefore be offered the join. Read here for EVERY row, not just the
        // driver's, which is the whole point of a session-keyed registry.
        control: agyControlState(this.isDriving(row.conversationId), row.conversationId),
        // Q11.
        terminalSyncHint: {
          label: 'Resume in terminal',
          command: `agy --conversation ${row.conversationId}`,
          ...(cwd ? { note: `Run it in ${cwd}` } : {}),
        },
      });
    }
    return out;
  }

  /**
   * Open a session.
   *
   * `observe` (or no mode) yields the read-only transcript view. `resume` yields
   * a Drive connection — which does NOT spawn anything here: the child starts on
   * the FIRST `sendPrompt` and never on attach, because every `agy` invocation
   * pays a full workspace init and an opened roster row must cost nothing (spec
   * R4). Any other mode REFUSES loudly rather than silently downgrading, which is
   * the shape reflection §11 warns about: the client believes it is driving, the
   * session is not driven, and nothing anywhere says so.
   */
  async attach(sessionId: string, mode?: AttachMode, _opts?: AttachOptions): Promise<SessionConnection> {
    if (mode !== undefined && mode !== 'observe' && mode !== 'resume') {
      throw new Error(
        `Antigravity supports observe and resume attaches; '${mode}' is not available. `
        + `Use the resume command on the session row to drive it in a terminal.`,
      );
    }
    // Defense in depth. Ids only ever come from `discoverSessions`, which already
    // rejects a non-UUID, but a crafted id must not be able to address a path.
    if (!isAgyConversationId(sessionId)) {
      throw new Error(`agy: not a conversation id: ${sessionId}`);
    }

    const summaries = readAgySummaries(this.roots, { trace: this.trace });
    const row = summaries.find((candidate) => candidate.conversationId === sessionId);
    if (!row) {
      throw new Error(`agy: no Antigravity CLI conversation with id ${sessionId}`);
    }
    const metadata = readAgyMetadata(this.roots, this.trace);
    const meta = metadata.get(sessionId);
    const cwd = row.workspaceDirs[0] ?? meta?.workspaceDirs[0];
    const catalog = readAgyModelCatalog(this.roots, this.trace);
    const currentModel = resolveAgyModel(catalog, readAgySettingsModelLabel(this.roots, this.trace), this.trace);

    const info: SessionInfo = {
      id: sessionId,
      nativeId: sessionId,
      tool: this.id,
      title: agyTitle(row.preview, meta?.preview, cwd, sessionId),
      ...(cwd ? { cwd, projectName: basename(cwd) } : {}),
      status: 'idle',
      attachMode: mode === 'resume' ? 'resume' : 'observe',
      ...(row.updatedAt !== undefined ? { updatedAt: row.updatedAt } : {}),
      currentModel,
      terminalSyncHint: {
        label: 'Resume in terminal',
        command: `agy --conversation ${sessionId}`,
        ...(cwd ? { note: `Run it in ${cwd}` } : {}),
      },
    };

    if (mode === 'resume') {
      const binary = findAgyBinary(this.env);
      if (!binary) {
        // Refuse rather than hand back a Drive that can never spawn: the first
        // prompt would fail, and the client would have been told it was driving.
        throw new Error('The `agy` command is not on PATH, so this session cannot be driven from the app.');
      }
      const connection = new AgyDriveConnection({
        roots: this.roots,
        conversationId: sessionId,
        info,
        binary,
        trace: this.trace,
        // Compare-and-swap: only the REGISTERED owner may deregister itself, so a
        // stale close cannot evict the replacement that already took over.
        onClose: (closing) => {
          if (this.drivenSessions.get(sessionId) === closing) {
            this.drivenSessions.delete(sessionId);
          }
        },
      });
      this.drivenSessions.set(sessionId, connection);
      return connection;
    }

    return new AgyObserveConnection({
      roots: this.roots,
      conversationId: sessionId,
      info,
      trace: this.trace,
    });
  }

  /** Whether this conversation has a transcript to replay. Diagnostic; used by the suites. */
  hasTranscript(conversationId: string): boolean {
    return existsSync(agyTranscriptPath(this.roots, conversationId));
  }

  /** Q9: is this session driven RIGHT NOW, by any client? Read by `discoverSessions`. */
  isDriving(sessionId: string): boolean {
    return this.drivenSessions.get(sessionId)?.driving === true;
  }

  /** The connection driving this session, if any. Lets the hub join an existing Drive (Q14). */
  driveConnection(sessionId: string): AgyDriveConnection | undefined {
    return this.drivenSessions.get(sessionId);
  }
}

/**
 * The roster's view of a session's posture.
 *
 * Built from the ADAPTER's registry, never from the requesting connection, so a
 * client that is merely observing still sees that the session is driven and can
 * be offered the join (reflection §11).
 */
export function agyControlState(driving: boolean, conversationId: string): SessionControlState {
  return {
    drive: {
      state: driving ? 'driving' : 'observing',
      supported: true,
      handoffAvailable: driving,
    },
    terminalSync: {
      // Structurally impossible rather than merely inactive: agy has no daemon,
      // no bridge and no socket, so nothing could ever mirror a live session.
      supported: false,
      syncAvailable: false,
      active: false,
      label: 'Resume in terminal',
      command: `agy --conversation ${conversationId}`,
    },
  };
}

/**
 * A title that is HONEST about where it came from.
 *
 * `conversation_summaries.title` is empty on all 32 rows and
 * `conversation_metadata.json.Title` is empty on all 32 (MEASURED 2026-08-25),
 * so the human string that actually exists is `preview` — present on 30 of 32.
 * The fallbacks descend to the cwd's basename and then to a short id prefix;
 * none of them invents prose. Reflection §3's rule is about model names, but the
 * principle is the same: show what the host published, or show something plainly
 * mechanical, never something fabricated to look authored.
 */
function agyTitle(
  summaryPreview: string,
  metadataPreview: string | undefined,
  cwd: string | undefined,
  conversationId: string,
): string {
  const preview = summaryPreview.trim() || (metadataPreview ?? '').trim();
  if (preview) return preview;
  if (cwd) return basename(cwd);
  return conversationId.slice(0, 8);
}
