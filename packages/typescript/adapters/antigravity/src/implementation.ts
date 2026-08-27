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
 *   THE PICKER (P2a, MEASURED 2026-08-25 / 1.1.20). `listModels()` publishes the
 *   catalog's 25 ids as 20 rows: a base model with two or more effort variants
 *   collapses into one row carrying `reasoningEfforts`, the rest stay flat. Every
 *   id stays reachable, including the loser of a variant collision, which appears
 *   as its own flat row rather than disappearing. Effort
 *   is read from the host's own `(Low|Medium|High)` parenthetical and NEVER from
 *   the id, because the catalog contradicts itself there — `gemini-3.5-flash-low`
 *   publishes "Gemini 3.5 Flash (Medium)". `--effort` is a real flag and is
 *   deliberately never passed: every catalog id is already a concrete effort
 *   variant, and the binary carries "--model %s conflicts with --effort=%s", so a
 *   switch names the SIBLING ID instead. See `agyModelOptions` in `store.ts`.
 *
 * Q2 — PERMISSION/APPROVAL MODE FIELD.  [REVISED — MEASURED 2026-08-25 / 1.1.20]
 *   The contract field is `currentMode`, never `permissionMode` (that is the
 *   `PromptInput` field name, and emitting it is the exact off-contract key that
 *   blanked kimi's picker — reflection §2).
 *   `permissionGranularity: 'per-tool'`, because `settings.json.permissions.allow`
 *   is a per-COMMAND-NAME allowlist of 84 entries (MEASURED) — dsh's situation,
 *   not kimi's per-session one.
 *   THERE ARE TWO AXES, and conflating them was the error in the earlier answer.
 *   `--mode` selects an EXECUTION mode and takes exactly three values —
 *   `default`, `accept-edits`, `plan` — verbatim from the 1.1.20 binary's own
 *   flag help and its `shift+tab` cycle hint. `always-proceed` / `request-review`
 *   / `strict` are the separate AUTO-APPROVAL policy and have no flag at all.
 *   `full-access` is not a value of either: the string does not occur in the
 *   binary.
 *   That is why `init.permission_mode` reports `"request-review"` under
 *   `--mode=plan`, `--mode=accept-edits` AND no `--mode` — it answers the OTHER
 *   axis. So `init` can NEVER be the source of `currentMode` (the earlier answer
 *   said it was); a DRIVE connection publishes the mode it LAUNCHED with, which
 *   is the only thing that knows. `listModes()` returns the three; a `--mode`
 *   outside them is dropped before launch with a trace, because the host silently
 *   ignores an unrecognized value and the row would then advertise a posture the
 *   child is not in.
 *   STILL UNSUPPORTED: a DISCOVERY row carries no `currentMode`. C2 is SETTLED
 *   and the answer is that no record exists — `--mode=accept-edits` leaves no
 *   trace anywhere in the store, `--mode=plan` shows only as a `/plan` prefix on
 *   user rows, and the default writes nothing. An unattached row therefore cannot
 *   know its mode, and inventing one would preselect a posture the session may not
 *   be in.
 *
 * Q3 — DOES CREATE ACCEPT A MODEL, AND HOW DOES ATTACH RE-DERIVE IT?
 *   Yes: `agy --model <id> --conversation <newId>` sets it at launch. P3 is that
 *   launch: `createSession` mints the id, stores the requested model on the
 *   adapter's own pending-create record (it rides `info.currentModel`, which is
 *   what the drive's first spawn launches from), and the live child's `init`
 *   re-reads it, preferring `init` — because a return value spent on navigation
 *   is not state (reflection §5; dsh P9a discarded exactly this).
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
 * Q5 — CHILD/SUBAGENT SESSIONS IN THE LISTING.  [SUPPORTED — MEASURED 2026-08-25 / 1.1.20]
 *   C5 LANDED. Two parent conversations on this host each spawned exactly one
 *   subagent, and both children are real `brain/` directories with real
 *   transcripts. Child rows carry `origin: 'subagent'`, `parentThreadId` = the
 *   parent's conversation UUID, and `nativeId` = the child's own — so a child
 *   opens its OWN transcript through the ordinary observe path, with no second
 *   history mechanism.
 *   WHAT NAMES A CHILD IS THE SETTLEMENT SENDER, and only that. A child reports
 *   home by writing a settlement into its PARENT's inbox whose `sender` is its own
 *   bare conversation UUID. The parent's `invoke_subagent` step does NOT name the
 *   child — its args are `Subagents` (`{Model, Prompt, Role, TypeName}`),
 *   `toolAction`, `toolSummary` — so it can prove that a subagent was spawned and
 *   never which one. Both sources agree 1:1 here; only the settlement is used,
 *   because a step→child join would be positional and positional is a guess.
 *   THE SCHEMA REMAINS USELESS, and the dormant mapping written here in P0 would
 *   have found nothing: `parent_conversation_id`/`nesting_depth` are still
 *   empty/zero on every row, and NEITHER PARENT NOR CHILD IS IN THAT TABLE AT ALL
 *   (see the discovery note below). Lineage comes from the files.
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
 *   BACKGROUND TASKS GET A LEDGER (P2c, MEASURED 2026-08-25 / 1.1.20). The 36
 *   settlements on this host break down as 29 `<uuid>/task-<N>` (a task), 2 bare
 *   `<uuid>` (a subagent, Q5), 3 `system` and 1 with no sender at all — so "not a
 *   task" is emphatically NOT "a subagent", and the classifier says which of the
 *   four it is rather than assuming. Task settlements fold with the
 *   conversation's own `manage_task` calls into ONE `task-list-state` panel, and
 *   a settled task's `task-<N>.log` rides its `tool-result` under a per-replay
 *   byte budget (median 1,189 B, one outlier at 3 MB).
 *   DELIBERATE DEVIATION: the settlements themselves stay durable TOOL BLOCKS and
 *   are NOT promoted to `agent-activity`. A settlement exists only because the
 *   work ENDED, so every one would carry a terminal status — and the protocol
 *   REMOVES the live surface on a terminal `agent-activity` "so completed
 *   subagents do not stack in history". Promoting them would therefore delete the
 *   only durable record the user has of what their background tasks did.
 *   Reflection §9: collapse, never delete.
 *
 * Q11 — RESUME-IN-TERMINAL COMMAND.
 *   `agy --conversation <conversationId>`, run in the session's own directory.
 *   Emitted as `terminalSyncHint` on every row in P0 — this behaviour was closed
 *   on codex/pi/opencode and then reported AGAIN on kimi and claude (reflection
 *   §1), so it ships with the first phase rather than a later one.
 *   The cwd matters: `cache/last_conversations.json` is keyed by cwd, so the hint
 *   carries the workspace directory in `note` when the session has one.
 *
 * Q12 — EVERY UNSUPPORTED ANSWER WRITTEN DOWN.  [REVISED 2026-08-25 / 1.1.20]
 *   | capability                  | answer            | reason |
 *   |-----------------------------|-------------------|--------|
 *   | `origin`/`parentThreadId`   | SUPPORTED (P2d)   | from the settlement sender, not the schema — see Q5. The columns are still empty on every row |
 *   | `currentMode` on a ROW      | unsupported       | C2 SETTLED: no per-conversation mode record exists to read. A DRIVE connection publishes the mode it LAUNCHED with — never from `init`, which answers a different axis (Q2) |
 *   | `token-count` in REPLAY     | unsupported       | counts live in the protobuf store and in the live `result` event, never in the JSONL. Drive emits it; a replay cannot |
 *   | `usage.thinking`            | unsupported       | agy reports a fourth token bucket the protocol has no field for. NOT folded into `output` — inventing a sum is the exact error `token-count` warns about |
 *   | `respondPermission`         | unsupported       | agy publishes no permission channel over stream-json, and answering by writing a prompt would put words in the conversation the user never typed |
 *   | `listModels`                | SUPPORTED (P2a)   | 19 rows from the cockpit catalog; effort variants collapsed, `--effort` never passed (Q1) |
 *   | `listModes`                 | SUPPORTED (P2b)   | the three `--mode` values compiled into the binary's own flag help (Q2) |
 *   | `--effort` on the wire      | unsupported       | a real flag, deliberately unused: every catalog id is already an effort variant and the binary rejects `--model <variant> --effort <same>` |
 *   | slash commands              | unsupported       | upstream: `/x` is "unavailable with `--input-format stream-json`" — so `listCommands` stays absent under drive |
 *   | `exportTranscript`          | SUPPORTED (P2f)   | no export subcommand exists, so the export IS the JSONL re-emitted as one JSON document, through the same bounded reader history uses |
 *   | `sendFile` / attachments    | unsupported       | `.user_uploaded/` is EMPTY on every conversation, so the echo shape is entirely unmeasured; CAPTURE C6. kimi round 1 shipped a fixture asserting a shape the server cannot produce — that is the trap this refuses to repeat |
 *   | rename                      | unsupported       | no rename surface; `title` is empty on all 32 rows |
 *   | fork / clone                | unsupported       | the binary references a fork path but no flag exposes it |
 *   | a task that is RUNNING NOW  | unsupported       | a settlement proves a task ENDED; its absence proves only that this transcript recorded no ending, which after a crash looks identical. The ledger says `in-progress`, which is the honest word |
 *
 * DISCOVERY SOURCE — THE SUMMARIES TABLE IS NOT ENOUGH.  [MEASURED 2026-08-25 / 1.1.20]
 *   `conversation_summaries.db` and `cache/conversation_metadata.json` have not
 *   been written since Aug 15. Six conversations created after that — print-mode,
 *   stream-json, a clean interactive session, a fresh TUI boot, and BOTH SIDES of
 *   the subagent capture — added no row to either. On this host the table knows 27
 *   CLI conversations while `brain/` holds 56, of which 37 have a transcript to
 *   replay. Discovery from the table alone is not merely incomplete, it is FROZEN:
 *   it can never show anything the user has done since.
 *   So the roster is the table PLUS a bounded `brain/` scan supplemented by
 *   `cache/last_conversations.json` (which does still update) — see
 *   `supplementaryRows`. Supplementary rows are honest about what they lack: no
 *   preview, no `workspace_uris`, no step count, a title derived from the
 *   conversation's own first user prompt, and `updatedAt` from the transcript's
 *   mtime, the only timestamp a brain directory offers.
 *   `attach()` reads the SAME scan when the table does not know an id, so a row
 *   that discovers can always open. Requiring a summaries row there — which is
 *   what P0 did — would have listed 12 supplementary rows and refused all of them.
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
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type {
  AgentBackend,
  AgentCapabilities,
  AgentSetupDiagnosis,
  AttachMode,
  AttachOptions,
  SessionConnection,
  SessionControlState,
  SessionDiscoveryOptions,
  ModelOption,
  PromptInput,
  SessionInfo,
  SetupDiagnosisContext,
} from '@cosyncing/adapter-api';
import { cachedAgyCliCatalog, ensureAgyCliCatalog } from './cli-catalog.ts';
import { diagnoseAgySetup } from './diagnostics.ts';
import { AgyObserveConnection } from './observe.ts';
import { AgyDriveConnection } from './drive.ts';
import { stripAgyUserWrappers } from './mapping.ts';
import {
  AGY_MAX_LINE_BYTES,
  AGY_TRANSCRIPT_MAX_BYTES,
  AgyLineFramer,
  isAgyReadRefusal,
  readContainedThroughLastNewline,
} from './safe-read.ts';
import {
  defaultAgyRoots,
  findAgyBinary,
  isAgyConversationId,
  readAgyLastConversations,
  agyModelOptions,
  readAgyMetadata,
  readAgyModelCatalog,
  readAgySettingsModelLabel,
  readAgySummaries,
  resolveAgyModel,
  scanAgyBrainDirs,
  scanAgySubagentLinks,
  defaultAgyTraceSink,
  agyTranscriptPath,
  type AgyBrainRow,
  type AgyMetadataEntry,
  type AgyRoots,
  type AgySummaryRow,
  type AgyTraceSink,
} from './store.ts';

/**
 * One conversation, MERGED across both discovery sources, before the union is
 * sorted and the global limit applied (see `discoverSessions`). A conversation
 * both sources know keeps the summary enrichment and the newest timestamp
 * either offers; at least one of `summary`/`brain` is always present.
 */
interface AgyDiscoveryCandidate {
  conversationId: string;
  /** The newest evidence from EITHER source — what the union sorts by and the row reports. */
  updatedAt?: number;
  summary?: AgySummaryRow;
  brain?: AgyBrainRow;
}

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
  /** P2f. agy has no export subcommand, so the export is the JSONL transcript re-emitted as one
   *  document — see {@link exportTranscript}. Static because the confirm card reads it before any
   *  session exists. */
  readonly transcriptExportFormat = 'json' as const;

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
  /**
   * Sessions created from the app that no store has seen yet (P3).
   *
   * agy has no daemon to ask for a conversation: one EXISTS once the CLI first
   * runs with its id (Q3 — `agy --model <id> --conversation <newId>` sets it at
   * launch). So create mints the id and records the request here; the roster
   * overlays these rows until the brain directory appears, attach builds its
   * info from the record, and the first resume prompt is what actually launches
   * the CLI. In-memory on purpose: a pending create that never received a
   * prompt names a conversation NOTHING ever wrote, and persisting it would
   * advertise sessions no store can open after a broker restart.
   */
  private readonly pendingCreates = new Map<string, {
    cwd: string;
    title?: string;
    currentModel?: SessionInfo['currentModel'];
    createdAt: number;
  }>();

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
    // BOTH sources are read with the full limit, and the global limit is
    // applied to the sorted UNION — never budgeted per source. Handing the
    // brain scan whatever the summaries left over looks natural and is wrong:
    // the summaries store is FROZEN (see `scanAgyBrainDirs`), so on a host
    // whose stale table alone fills the limit the supplement's budget would be
    // zero, and every conversation the user has actually touched since the
    // freeze would be invisible — the dead source starving the live one.
    const summaries = readAgySummaries(this.roots, {
      ...(options?.updatedAfter !== undefined ? { updatedAfter: options.updatedAfter } : {}),
      limit: this.discoveryLimit,
      ...(options?.onWork ? { onWork: options.onWork } : {}),
      trace: this.trace,
    });
    // The brain scan does NOT exclude summary-known ids. The summaries store is
    // frozen, so a conversation RESUMED after the freeze keeps its stale table
    // timestamp forever — while its transcript mtime is current. Both sources
    // are read whole and merged by conversation id: the summary row keeps its
    // enrichment (preview, workspace), and the NEWEST timestamp either source
    // offers is what the union sorts by and what the row reports. Excluding
    // covered ids made the stale timestamp win every recency race.
    const scanned = scanAgyBrainDirs(this.roots, {
      ...(options?.updatedAfter !== undefined ? { updatedAfter: options.updatedAfter } : {}),
      limit: this.discoveryLimit,
      ...(options?.onWork ? { onWork: options.onWork } : {}),
      trace: this.trace,
    });

    const byId = new Map<string, AgyDiscoveryCandidate>();
    for (const row of summaries) {
      byId.set(row.conversationId, {
        conversationId: row.conversationId,
        ...(row.updatedAt !== undefined ? { updatedAt: row.updatedAt } : {}),
        summary: row,
      });
    }
    for (const row of scanned) {
      const held = byId.get(row.conversationId);
      if (held) {
        if (held.updatedAt === undefined || row.updatedAt > held.updatedAt) held.updatedAt = row.updatedAt;
        held.brain = row;
      } else {
        byId.set(row.conversationId, { conversationId: row.conversationId, updatedAt: row.updatedAt, brain: row });
      }
    }

    // Newest first across both sources, THEN the limit. `-1` sorts a candidate
    // with no timestamp last — it cannot compete on recency it does not claim —
    // and the sort is stable, so tied rows keep summaries-first order.
    const candidates = [...byId.values()];
    candidates.sort((a, b) => (b.updatedAt ?? -1) - (a.updatedAt ?? -1));
    const kept = candidates.slice(0, this.discoveryLimit);

    // A kept conversation that won its slot through the brain scan still owns
    // whatever summary row the frozen table holds — however old. The capped
    // recency query above cannot see a stale row that fell below its limit, so
    // the kept winners are enriched with ONE bounded id-batch query afterwards:
    // enrichment follows from identity, never from summary recency. The row's
    // reported recency still takes the newest evidence from either side.
    const missingSummary = kept
      .filter((candidate) => candidate.summary === undefined)
      .map((candidate) => candidate.conversationId);
    if (missingSummary.length > 0) {
      for (const row of readAgySummaries(this.roots, {
        ids: missingSummary,
        ...(options?.onWork ? { onWork: options.onWork } : {}),
        trace: this.trace,
      })) {
        const held = byId.get(row.conversationId);
        if (!held) continue;
        held.summary = row;
        if (row.updatedAt !== undefined && (held.updatedAt === undefined || row.updatedAt > held.updatedAt)) {
          held.updatedAt = row.updatedAt;
        }
      }
      // Membership was decided above; a late-found summary can only RAISE a
      // kept row's timestamp, so re-sorting keeps the reported order honest
      // without changing who made the cut.
      kept.sort((a, b) => (b.updatedAt ?? -1) - (a.updatedAt ?? -1));
    }

    const metadata = readAgyMetadata(this.roots, this.trace);
    // Read ONCE per sweep, not per row: the catalog and the settings label are
    // global, and a per-row read would be N file reads for one answer. The
    // `last_conversations` map is read only when a kept row can use it.
    //
    // The catalog PREFERS the live `agy models` list: the cockpit file froze on
    // 2026-08-15 and no longer knows the current vocabulary, so joining against
    // it alone blanked every roster model (the 2026-08-27 physical pass). The
    // sweep itself never waits on a spawn — it uses whatever is cached and
    // fires one TTL'd background refresh, so the roster converges a sweep
    // after the service starts.
    const binary = findAgyBinary(this.env);
    if (binary) void ensureAgyCliCatalog(binary, { trace: this.trace });
    const catalog = cachedAgyCliCatalog(binary) ?? readAgyModelCatalog(this.roots, this.trace);
    const settingsLabel = readAgySettingsModelLabel(this.roots, this.trace);
    const currentModel = resolveAgyModel(catalog, settingsLabel, this.trace);
    const lastConversations = kept.some((candidate) => candidate.summary === undefined)
      ? readAgyLastConversations(this.roots, this.trace)
      : undefined;

    const out: SessionInfo[] = [];
    for (const candidate of kept) {
      if (options?.signal?.aborted) break;
      out.push(candidate.summary
        ? this.summaryRow(
          candidate.summary,
          metadata.get(candidate.conversationId),
          currentModel,
          candidate.updatedAt,
        )
        : this.supplementaryRow(
          candidate.brain!,
          lastConversations?.get(candidate.conversationId),
          currentModel,
        ));
    }

    // Pending creates ride the roster until the store learns their id: without
    // this a refresh between create and the first prompt would lose the session
    // the app just showed. Once EITHER source knows the id, the disk row is the
    // truth and the pending record has done its job.
    for (const [sessionId, pending] of this.pendingCreates) {
      if (byId.has(sessionId)) {
        this.pendingCreates.delete(sessionId);
        continue;
      }
      out.push(this.pendingRow(sessionId, pending));
    }
    if (this.pendingCreates.size > 0) out.sort((a, b) => (b.updatedAt ?? -1) - (a.updatedAt ?? -1));

    this.applyLineage(out, this.lineageUniverse(), options);
    return out;
  }

  /**
   * The set of conversations whose inboxes one sweep may search for lineage
   * (P2d).
   *
   * INDEPENDENT of `updatedAfter` AND of `discoveryLimit`: those options filter
   * which sessions a sweep RETURNS, and lineage is metadata belonging to a
   * returned CHILD — proven by a settlement in its PARENT's inbox. A parent
   * that is old, quiet, or crowded out of a capped candidate list is precisely
   * the parent that gets cut, and letting either bound erase the child's stamp
   * would make the same child row report differently sweep to sweep.
   *
   * The universe is the brain-directory enumeration itself, ids only: an inbox
   * lives at `brain/<parent>/.system_generated/messages`, so a conversation
   * with no brain directory cannot hold settlements, and a summaries-only pass
   * could add nothing. Still bounded, by the ceilings that already govern the
   * store: `AGY_BRAIN_SCAN_MAX_DIRS` caps the listing (and traces truncation),
   * no head reads are paid, and `AGY_LINEAGE_MAX_FILES` caps the settlement
   * files the scan may open regardless of how many directories this names.
   */
  private lineageUniverse(): string[] {
    return scanAgyBrainDirs(this.roots, { skipHeadRead: true, trace: this.trace })
      .map((row) => row.conversationId);
  }

  /**
   * One roster row from a `conversation_summaries` row. `updatedAt` arrives
   * from the merged candidate rather than the summary row itself, because the
   * frozen table's timestamp loses to a current transcript mtime.
   */
  private summaryRow(
    row: AgySummaryRow,
    meta: AgyMetadataEntry | undefined,
    currentModel: ReturnType<typeof resolveAgyModel>,
    updatedAt: number | undefined,
  ): SessionInfo {
    const cwd = row.workspaceDirs[0] ?? meta?.workspaceDirs[0];
    return {
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
      ...(updatedAt !== undefined ? { updatedAt } : {}),
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
    };
  }

  /**
   * Stamp `origin`/`parentThreadId` on the rows the settlement inboxes prove are children (P2d).
   *
   * Runs LAST, over both row sets at once, because a child is discovered exactly
   * like any other conversation — it has a `brain/` dir and a transcript of its
   * own — and only afterwards learns that it is somebody's child. Doing it in one
   * pass also means the cross-reference reads each inbox once for the whole
   * sweep rather than once per row.
   *
   * `nativeId` is already the child's own conversation UUID for every row, so
   * nothing is re-keyed here: a subagent row addresses the child's transcript and
   * `parentThreadId` addresses the parent's. Q4's one-id rule survives lineage.
   *
   * The inbox scan covers the whole {@link lineageUniverse}, not the returned
   * rows: the lineage proof lives in the PARENT's inbox, and the parent may be
   * exactly the conversation that a limit or a cutoff kept out of the sweep.
   * Scanning only what survived would make a child's stamp depend on where its
   * parent landed in somebody else's budget.
   */
  private applyLineage(
    rows: SessionInfo[],
    universeIds: readonly string[],
    options?: SessionDiscoveryOptions,
  ): void {
    if (rows.length === 0) return;
    const links = scanAgySubagentLinks(this.roots, universeIds, {
      ...(options?.onWork ? { onWork: options.onWork } : {}),
      trace: this.trace,
    });
    if (links.size === 0) return;
    for (const row of rows) {
      const parentId = links.get(row.id);
      if (!parentId) continue;
      row.origin = 'subagent';
      row.parentThreadId = parentId;
    }
  }

  /**
   * A row for a conversation the summaries table cannot see.
   *
   * MEASURED 2026-08-25: `conversation_summaries.db` and
   * `cache/conversation_metadata.json` have not been written since Aug 15, and
   * six conversations created afterwards — print-mode, stream-json, a clean
   * interactive session and a fresh TUI boot — added no rows to either. On that
   * host the table knows 27 CLI conversations while `brain/` holds 56. Discovery
   * from the table alone is therefore not merely incomplete, it is frozen: it can
   * never show anything the user has done since.
   *
   * These rows are HONEST ABOUT WHAT THEY LACK. The frozen caches are exactly the
   * enrichment sources, so a supplementary row has no preview to title itself
   * with, no `workspace_uris`, and no step count. It gets a title derived from its
   * own first user prompt (through the same wrapper stripping the transcript view
   * uses), a `cwd` only when `cache/last_conversations.json` — which DOES still
   * update — still names it, and `updatedAt` from the transcript's mtime, which is
   * the only timestamp a brain directory offers.
   */
  private supplementaryRow(
    row: AgyBrainRow,
    cwd: string | undefined,
    currentModel: ReturnType<typeof resolveAgyModel>,
  ): SessionInfo {
    return {
      id: row.conversationId,
      nativeId: row.conversationId,
      tool: this.id,
      title: agySupplementaryTitle(row.firstUserContent, cwd, row.conversationId),
      ...(cwd ? { cwd, projectName: basename(cwd) } : {}),
      status: 'idle',
      attachMode: 'observe',
      updatedAt: row.updatedAt,
      currentModel,
      control: agyControlState(this.isDriving(row.conversationId), row.conversationId),
      terminalSyncHint: {
        label: 'Resume in terminal',
        command: `agy --conversation ${row.conversationId}`,
        ...(cwd ? { note: `Run it in ${cwd}` } : {}),
      },
    };
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
  /**
   * Create a new conversation from the app (P3).
   *
   * Nothing touches the store here. agy materializes a conversation the first
   * time the CLI runs with the id, so create mints a UUID — the same shape as
   * every native id (Q4) — records the request, and returns a row whose control
   * state routes the client into a resume attach. The drive connection then
   * launches `agy --conversation <id> [--model <id>]` on the first prompt, in
   * the chosen directory, which is the measured creation path.
   */
  async createSession(opts: {
    directory?: string;
    title?: string;
    model?: PromptInput['model'];
  } = {}): Promise<SessionInfo> {
    if (!findAgyBinary(this.env)) {
      throw new Error('The `agy` command is not on PATH, so a new Antigravity session cannot be created from the app.');
    }
    const cwd = opts.directory?.trim() || homedir();
    if (!existsSync(cwd)) throw new Error(`agy createSession directory does not exist: ${cwd}`);
    const sessionId = randomUUID();
    let currentModel: SessionInfo['currentModel'];
    if (opts.model) {
      // Label from the same catalog the create dialog offered. A failed read
      // still keeps the id: the drive launches from `currentModel.modelID`, and
      // the client tooltips the raw id when no label joined.
      const options = await this.listModels().catch(() => [] as ModelOption[]);
      const match = options.find((option) => option.modelID === opts.model!.modelID);
      currentModel = {
        providerID: opts.model.providerID,
        modelID: opts.model.modelID,
        ...(match?.label ? { label: match.label } : {}),
      };
    }
    const title = opts.title?.trim() || basename(cwd);
    this.pendingCreates.set(sessionId, {
      cwd,
      ...(opts.title?.trim() ? { title: opts.title.trim() } : {}),
      ...(currentModel ? { currentModel } : {}),
      createdAt: Date.now(),
    });
    this.trace?.({ op: 'create-pending', detail: `${sessionId} in ${cwd}${currentModel ? ` model ${currentModel.modelID}` : ''}` });
    return this.pendingRow(sessionId, { cwd, title, currentModel, createdAt: this.pendingCreates.get(sessionId)!.createdAt });
  }

  /** The roster/attach row for a pending create. One builder, so both surfaces agree. */
  private pendingRow(
    sessionId: string,
    pending: { cwd: string; title?: string; currentModel?: SessionInfo['currentModel']; createdAt: number },
  ): SessionInfo {
    return {
      id: sessionId,
      nativeId: sessionId,
      tool: this.id,
      title: pending.title ?? basename(pending.cwd),
      cwd: pending.cwd,
      projectName: basename(pending.cwd),
      status: 'idle',
      attachMode: 'resume',
      createdAt: pending.createdAt,
      updatedAt: pending.createdAt,
      ...(pending.currentModel ? { currentModel: pending.currentModel } : {}),
      control: agyControlState(this.isDriving(sessionId), sessionId),
      terminalSyncHint: {
        label: 'Resume in terminal',
        command: `agy --conversation ${sessionId}`,
        note: `Run it in ${pending.cwd}`,
      },
    };
  }

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
    const metadata = readAgyMetadata(this.roots, this.trace);
    const meta = metadata.get(sessionId);
    // Attach spawns NOTHING — that contract predates the live catalog and the
    // suites pin it. The composer seed reads whatever live list the sweep's
    // background refresh has already cached (discovery keeps it warm from the
    // first sweep after start), falling back to the frozen cockpit file.
    const catalog = cachedAgyCliCatalog(findAgyBinary(this.env)) ?? readAgyModelCatalog(this.roots, this.trace);
    const currentModel = resolveAgyModel(catalog, readAgySettingsModelLabel(this.roots, this.trace), this.trace);

    // A row that DISCOVERED must OPEN. Discovery no longer comes from the
    // summaries table alone — the table has been frozen since Aug 15 and knows
    // neither the six conversations created after it nor either side of the
    // subagent capture (MEASURED 2026-08-25) — so requiring a summaries row here
    // would have made every supplementary and every subagent row un-openable
    // while still listing them. The brain directory is the fallback and the same
    // one `supplementaryRow` lists from, which is what keeps the two consistent.
    let info: SessionInfo;
    if (row) {
      const cwd = row.workspaceDirs[0] ?? meta?.workspaceDirs[0];
      info = {
        id: sessionId,
        nativeId: sessionId,
        tool: this.id,
        title: agyTitle(row.preview, meta?.preview, cwd, sessionId),
        ...(cwd ? { cwd, projectName: basename(cwd) } : {}),
        status: 'idle',
        attachMode: mode === 'resume' ? 'resume' : 'observe',
        ...(row.updatedAt !== undefined ? { updatedAt: row.updatedAt } : {}),
        currentModel,
        // Omitting control here left every observe attach with
        // `control: undefined` — the client fails closed on that and pinned
        // the whole session to "Session control status is unavailable" (the
        // 2026-08-27 physical pass). This is the CONNECTION's own state, not
        // the roster's: an observe connection never drives, whatever the
        // adapter's registry says — claiming `driving` here handed a bare
        // observer mutation authority and cost it the join offer
        // (agy-cross-client-join A7/A8). The drive constructor overwrites it
        // with its own live state on resume.
        control: agyControlState(false, sessionId),
        terminalSyncHint: {
          label: 'Resume in terminal',
          command: `agy --conversation ${sessionId}`,
          ...(cwd ? { note: `Run it in ${cwd}` } : {}),
        },
      };
    } else {
      const scanned = scanAgyBrainDirs(this.roots, { only: [sessionId], trace: this.trace })[0];
      if (!scanned) {
        // A session created from the app has no store presence until the CLI
        // first runs with its id; its attach info comes from the create record.
        const pending = this.pendingCreates.get(sessionId);
        if (!pending) throw new Error(`agy: no Antigravity CLI conversation with id ${sessionId}`);
        info = this.pendingRow(sessionId, pending);
        info.attachMode = mode === 'resume' ? 'resume' : 'observe';
        // The connection's own state — see the row branch above.
        info.control = agyControlState(false, sessionId);
        return this.openConnection(sessionId, mode, info);
      }
      const cwd = readAgyLastConversations(this.roots, this.trace).get(sessionId) ?? meta?.workspaceDirs[0];
      info = {
        id: sessionId,
        nativeId: sessionId,
        tool: this.id,
        title: agySupplementaryTitle(scanned.firstUserContent, cwd, sessionId),
        ...(cwd ? { cwd, projectName: basename(cwd) } : {}),
        status: 'idle',
        attachMode: mode === 'resume' ? 'resume' : 'observe',
        updatedAt: scanned.updatedAt,
        currentModel,
        // The connection's own state — see the row branch above.
        control: agyControlState(false, sessionId),
        terminalSyncHint: {
          label: 'Resume in terminal',
          command: `agy --conversation ${sessionId}`,
          ...(cwd ? { note: `Run it in ${cwd}` } : {}),
        },
      };
    }

    return this.openConnection(sessionId, mode, info);
  }

  /** The one connection builder attach's three info branches share. */
  private openConnection(sessionId: string, mode: AttachMode | undefined, info: SessionInfo): SessionConnection {
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

    const observeBinary = findAgyBinary(this.env);
    return new AgyObserveConnection({
      roots: this.roots,
      conversationId: sessionId,
      info,
      trace: this.trace,
      // For the picker's live `agy models` read; absent on a binary-less host.
      ...(observeBinary ? { binary: observeBinary } : {}),
    });
  }

  /**
   * The model picker's pre-session catalog (P2a).
   *
   * Same builder the per-session picker uses, so a model offered before a session
   * exists and a model offered inside one can never be two different lists.
   */
  async listModels(): Promise<ModelOption[]> {
    const settingsLabel = readAgySettingsModelLabel(this.roots, this.trace);
    // The picker is user-initiated, so it waits for the live `agy models` list
    // (once per TTL). The frozen cockpit file is only the no-binary fallback —
    // it is where the `-tiered` placeholder rows and the effortless picker of
    // the 2026-08-27 physical pass came from.
    const binary = findAgyBinary(this.env);
    const catalog = (binary ? await ensureAgyCliCatalog(binary, { trace: this.trace }) : undefined)
      ?? readAgyModelCatalog(this.roots, this.trace);
    return agyModelOptions(catalog, {
      ...(settingsLabel ? { settingsLabel } : {}),
      trace: this.trace,
    });
  }

  /**
   * Export one conversation as JSON (P2f).
   *
   * BUILT HERE, from the JSONL, because agy has no export subcommand — the
   * binary offers none, and inventing a `--export` flag would be a launch that
   * fails. So the export is the transcript's own lines, parsed and re-emitted as
   * one document, through the same bounded reader history uses. Nothing is
   * re-derived and nothing is mapped: an export that silently disagreed with the
   * rendered conversation would be worse than no export.
   *
   * TRANSCRIPT ONLY, stated in the document itself. Background-task settlements
   * and task logs live in a separate inbox and are deliberately not folded in —
   * they are the adapter's join, not the host's record, and an export is supposed
   * to be the host's record.
   *
   * `opts.timeoutMs` is accepted and unused, ON PURPOSE: there is no child
   * process to time out. The whole operation is one size-capped read of a local
   * file, so the byte cap IS the guard, and a timer around a bounded synchronous
   * read would be decoration. Said here rather than left to be rediscovered.
   */
  async exportTranscript(
    sessionId: string,
    opts: { tempDir: string; maxBytes: number; timeoutMs: number },
  ): Promise<{ path: string; format: 'json' }> {
    if (!isAgyConversationId(sessionId)) {
      throw new Error(`agy: not a conversation id: ${sessionId}`);
    }
    const path = agyTranscriptPath(this.roots, sessionId);
    const read = readContainedThroughLastNewline(
      this.roots.appData,
      path,
      Math.min(Math.max(0, opts.maxBytes), AGY_TRANSCRIPT_MAX_BYTES),
      this.trace,
    );
    if (isAgyReadRefusal(read)) {
      throw new Error(`agy: this conversation's transcript could not be read for export (${read}).`);
    }

    const steps: unknown[] = [];
    let unparsed = 0;
    const framer = new AgyLineFramer(AGY_MAX_LINE_BYTES);
    for (const frame of framer.push(read.bytes)) {
      if (frame.dropped) {
        unparsed += 1;
        continue;
      }
      if (!frame.text.trim()) continue;
      try {
        steps.push(JSON.parse(frame.text));
      } catch {
        // A line the reader could not parse is COUNTED, not dropped in silence:
        // an export that quietly lost lines would be indistinguishable from a
        // conversation that never had them.
        unparsed += 1;
      }
    }

    // The read was capped on INPUT bytes; the document adds an envelope on top,
    // so the output is measured too and trimmed from the END — the newest steps
    // are the ones an over-long export can afford to lose, and losing the oldest
    // would decapitate the conversation.
    let kept = steps.length;
    let body = this.exportDocument(sessionId, steps, kept, unparsed, read);
    while (Buffer.byteLength(body, 'utf8') > opts.maxBytes && kept > 0) {
      kept = Math.min(kept - 1, Math.floor(kept * 0.8));
      body = this.exportDocument(sessionId, steps, kept, unparsed, read);
    }

    const out = join(opts.tempDir, `agy-${sessionId}.json`);
    writeFileSync(out, body, { encoding: 'utf8', mode: 0o600 });
    return { path: out, format: 'json' };
  }

  private exportDocument(
    sessionId: string,
    steps: readonly unknown[],
    kept: number,
    unparsed: number,
    read: { boundary: number; size: number; truncated: boolean },
  ): string {
    return JSON.stringify(
      {
        tool: this.id,
        conversationId: sessionId,
        source: 'transcript.jsonl',
        note: 'Antigravity CLI transcript steps, verbatim. Background-task settlements are not included.',
        exportedAt: new Date().toISOString(),
        transcriptBytes: read.size,
        readBytes: read.boundary,
        truncated: read.truncated || kept < steps.length,
        stepCount: kept,
        ...(unparsed > 0 ? { unparsedLines: unparsed } : {}),
        steps: steps.slice(0, kept),
      },
      null,
      2,
    );
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

/** How long a derived title may run before it stops being a title. */
const AGY_DERIVED_TITLE_MAX = 80;

/**
 * Title a row the frozen caches cannot title.
 *
 * A supplementary row has no `preview` — that field lives in the very stores that
 * stopped updating — so the title is DERIVED from the conversation's own first
 * user prompt, run through the same wrapper stripping the transcript view uses so
 * the `<USER_REQUEST>` tags and the appended local-time metadata never reach a
 * roster label. Falls back the same way {@link agyTitle} does.
 *
 * Derived, not invented: every character comes from something the user actually
 * typed in that conversation (reflection §3).
 */
export function agySupplementaryTitle(
  firstUserContent: string | undefined,
  cwd: string | undefined,
  conversationId: string,
): string {
  const stripped = stripAgyUserWrappers(firstUserContent ?? '').text.trim();
  // One line only: a prompt is often a paragraph, and a roster row is not.
  const firstLine = stripped.split('\n').map((line) => line.trim()).find((line) => line.length > 0);
  if (firstLine) {
    return firstLine.length > AGY_DERIVED_TITLE_MAX
      ? `${firstLine.slice(0, AGY_DERIVED_TITLE_MAX - 1).trimEnd()}…`
      : firstLine;
  }
  if (cwd) return basename(cwd);
  return conversationId.slice(0, 8);
}
