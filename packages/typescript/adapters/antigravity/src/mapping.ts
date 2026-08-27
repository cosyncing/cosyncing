/**
 * The agy mapping boundary. ONE fold, used by replay today and by the P1 live
 * tail tomorrow.
 *
 * Three properties this module exists to guarantee, all asserted by
 * `test/test-agy-mapping.ts`:
 *
 *  1. **The fold is TOTAL and the default is a category, not a fallback.** The
 *     `(source, type)` inventory below is complete over a real corpus, and an
 *     unrecognized pair lands in a NAMED neutral category that prints its own
 *     `source` and `type`. It is never a user bubble and never a throw — a
 *     silent auto-update (spec §0 P11, and it happened again on 2026-08-25) can
 *     add a step type at any time, and the requirement is that a new type be
 *     visibly unmapped rather than invisibly mis-rendered.
 *  2. **`USER_EXPLICIT` is the only human provenance.** Reflection §10: category
 *     is decided by provenance, not by role. `SYSTEM` rows are agent machinery
 *     and are context-injection / notice / error / history-reset per the table,
 *     never a user turn.
 *  3. **The app never renders text the user did not type.** agy writes its own
 *     harness state INSIDE the user row — see {@link stripAgyUserWrappers} for
 *     the five wrapper tags measured in the corpus.
 */
import {
  CONTEXT_INJECTION_EVENT,
  boundContextBody,
  boundToolSemantic,
  boundedStream,
  commandSemantic,
  fileReadSemantic,
  searchSemantic,
  webSemantic,
  type AgentMessage,
  type ToolDisplayClass,
  type ToolSemantic,
} from '@cosyncing/adapter-api';
import type { AgyTraceSink } from './store.ts';

// ── The step record ──────────────────────────────────────────────────────────

/** One decoded `transcript.jsonl` line. Every key MEASURED over 2,664 lines / 29 files, 2026-08-25. */
export interface AgyStep {
  step_index: number;
  source: string;
  type: string;
  status: string;
  created_at: string;
  content?: string;
  thinking?: string;
  tool_calls?: Array<{ name: string; args?: unknown }>;
  /** Names the fields elided from `transcript.jsonl`; 363 of 2,664 lines carry it, always `["content"]`. */
  truncated_fields?: string[];
  exit_code?: number;
  error?: string;
}

/**
 * Byte offset of a parsed line within its transcript, stamped non-enumerably.
 *
 * This is the DRIVE path's ordering fence (Q7). A line that delivers a prompt we
 * just sent was necessarily appended AFTER the file's size at send time, and a
 * byte offset proves that without consulting a clock — which matters because
 * repeated prompts ("continue", "yes") recur verbatim in a transcript and a
 * timestamp comparison with any slack at all lets an OLDER identical line claim
 * a newer send. Non-enumerable so it never serializes into a fixture or a wire
 * payload.
 */
const AGY_LINE_OFFSET: unique symbol = Symbol('agyLineOffset');

/** The byte offset {@link parseAgyStep} stamped, when the caller supplied one. */
export function agyStepOffset(step: AgyStep | undefined): number | undefined {
  const value = (step as unknown as Record<symbol, unknown> | undefined)?.[AGY_LINE_OFFSET];
  return typeof value === 'number' ? value : undefined;
}

/** Parse one transcript line, or undefined. 0 of 2,664 corpus lines were unparseable. */
export function parseAgyStep(line: string, byteOffset?: number): AgyStep | undefined {
  const text = line.trim();
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const row = parsed as Record<string, unknown>;
  if (typeof row.step_index !== 'number') return undefined;
  const step: AgyStep = {
    step_index: row.step_index,
    source: typeof row.source === 'string' ? row.source : '',
    type: typeof row.type === 'string' ? row.type : '',
    status: typeof row.status === 'string' ? row.status : '',
    created_at: typeof row.created_at === 'string' ? row.created_at : '',
    ...(typeof row.content === 'string' ? { content: row.content } : {}),
    ...(typeof row.thinking === 'string' ? { thinking: row.thinking } : {}),
    ...(Array.isArray(row.tool_calls)
      ? { tool_calls: row.tool_calls.filter(isToolCall) }
      : {}),
    ...(Array.isArray(row.truncated_fields)
      ? { truncated_fields: row.truncated_fields.filter((f): f is string => typeof f === 'string') }
      : {}),
    ...(typeof row.exit_code === 'number' ? { exit_code: row.exit_code } : {}),
    ...(typeof row.error === 'string' ? { error: row.error } : {}),
  };
  if (byteOffset !== undefined) {
    Object.defineProperty(step, AGY_LINE_OFFSET, { value: byteOffset, enumerable: false });
  }
  return step;
}

function isToolCall(value: unknown): value is { name: string; args?: unknown } {
  return !!value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string';
}

// ── Keys ─────────────────────────────────────────────────────────────────────

/**
 * THE key function. One function, both paths, deterministic, no clock.
 *
 * `step_index` is present on 2,664/2,664 corpus lines and agrees exactly between
 * `transcript.jsonl` and the drive stream's `step_update` events for the same
 * run (spec §7.C1, re-verified 2026-08-25), which is what makes one key sound
 * across replay and live tail. Reflection §5 is the requirement: one fact, one
 * code path.
 *
 * A single step can produce several messages (a planner row is thinking +
 * model-output + N tool calls), so callers suffix this base rather than minting
 * a second key scheme.
 */
export function agyStepKey(conversationId: string, stepIndex: number): string {
  return `agy:${conversationId}:${stepIndex}`;
}

/**
 * Stream-event name → transcript step name.
 *
 * The drive stream and the transcript file name the same step differently, and
 * it is NOT a case fold — `agent_response` becomes `PLANNER_RESPONSE`. MEASURED
 * on agy 1.1.17, spec §7.C1. The table is built NOW, in P0, even though the
 * only consumer lands in P1, because it is the boundary that lets ONE
 * {@link mapAgyStep} serve both paths: the stream event is normalized into the
 * transcript record shape here, and everything downstream is shared.
 *
 * A stream name absent from this table passes through UPPERCASED, which routes
 * it to the same named-neutral category an unknown transcript type gets. That
 * is deliberate: an unlisted stream name is exactly as unknown as an unlisted
 * file name, and both must be visible rather than guessed at.
 */
export const AGY_STREAM_STEP_NAMES: Readonly<Record<string, string>> = Object.freeze({
  user_input: 'USER_INPUT',
  agent_response: 'PLANNER_RESPONSE',
  checkpoint: 'CHECKPOINT',
  system_message: 'SYSTEM_MESSAGE',
  conversation_history: 'CONVERSATION_HISTORY',
  directory_rules: 'DIRECTORY_RULES',
  error_message: 'ERROR_MESSAGE',
  run_command: 'RUN_COMMAND',
  view_file: 'VIEW_FILE',
  grep_search: 'GREP_SEARCH',
  code_action: 'CODE_ACTION',
  list_directory: 'LIST_DIRECTORY',
  search_web: 'SEARCH_WEB',
  read_url_content: 'READ_URL_CONTENT',
  ask_question: 'ASK_QUESTION',
  generic: 'GENERIC',
});

/** Normalize a drive-stream `step_type` into the transcript's own vocabulary. */
export function normalizeAgyStreamStepType(streamStepType: string): string {
  return AGY_STREAM_STEP_NAMES[streamStepType] ?? streamStepType.toUpperCase();
}

/**
 * Which `source` the transcript would have written for a stream step.
 *
 * The stream does not publish a `source` at all (spec §7.C1), but every
 * downstream decision keys on the `(source, type)` PAIR — deliberately, so that
 * a rule can never be keyed on `type` alone. So the pair has to be completed
 * here, from the inventory, rather than left for the fold to guess.
 */
export function agySourceForStepType(stepType: string): string {
  const row = AGY_STEP_INVENTORY.find((entry) => entry.type === stepType);
  return row?.source ?? 'MODEL';
}

// ── The (source, type) inventory ─────────────────────────────────────────────

/** Where a `(source, type)` pair lands. Named categories only — there is no catch-all. */
export type AgyStepCategory =
  | 'user-message'
  | 'assistant-turn'
  | 'tool'
  | 'question'
  | 'context-injection'
  | 'notice'
  | 'history-reset'
  | 'error'
  | 'unmapped-step';

export interface AgyInventoryRow {
  source: string;
  type: string;
  category: AgyStepCategory;
  /** Tool names this step type is the RESULT of; used to correlate to its call. */
  toolNames?: readonly string[];
  toolClass?: ToolDisplayClass;
  note: string;
}

/**
 * The complete `(source, type)` inventory — MEASURED over the whole corpus, in
 * the inventory-table form this repository's other table-driven mapper uses.
 *
 * Sweep 2026-08-25: 29 transcripts, 2,664 lines, 0 unparseable, exactly these
 * SIXTEEN pairs and no others. (The 2026-08-21 sweep over 25 files / 2,647 lines
 * found the same sixteen; the corpus grew and the vocabulary did not, which is
 * the evidence that this is a closed set rather than a snapshot.)
 *
 *   source         type                   n      → category
 *   ─────────────  ─────────────────────  ─────  ──────────────────
 *   MODEL          PLANNER_RESPONSE       1,268  assistant-turn      thinking + text + tool-calls
 *   MODEL          RUN_COMMAND              375  tool                command semantic + exit code
 *   MODEL          VIEW_FILE                355  tool                file-read semantic
 *   MODEL          GREP_SEARCH              193  tool                search semantic
 *   MODEL          CODE_ACTION              122  tool                edit class
 *   MODEL          LIST_DIRECTORY            96  tool                lookup class
 *   USER_EXPLICIT  USER_INPUT                70  user-message        the ONLY human bubble
 *   MODEL          GENERIC                   48  tool                manage_task/schedule/permissions
 *   SYSTEM         CONVERSATION_HISTORY      36  history-reset       compaction boundary
 *   SYSTEM         CHECKPOINT                34  notice              truncation checkpoint
 *   SYSTEM         SYSTEM_MESSAGE            26  context-injection   NEVER a user row
 *   MODEL          SEARCH_WEB                26  tool                web semantic
 *   SYSTEM         DIRECTORY_RULES            9  context-injection   AGENTS.md-class injection
 *   SYSTEM         ERROR_MESSAGE              4  error
 *   MODEL          ASK_QUESTION               1  question            replayed = already settled
 *   MODEL          READ_URL_CONTENT           1  tool                web semantic
 *   ─────────────  ─────────────────────  ─────  ──────────────────
 *   *any*          *unlisted*                    unmapped-step       named neutral, carries source+type
 *
 * Two rules the table encodes, both reflection §10:
 *
 *  - Key on the PAIR, never on `type` alone. agy puts nothing on a user role, so
 *    the trap here is the inverse of kimi's: a rule matching `USER_INPUT` alone
 *    would also match a `USER_INPUT` a future `SYSTEM` row could carry.
 *  - The default is a category. `unmapped-step` is a real destination with its
 *    own rendering, not an `else` that absorbs whatever is left.
 */
export const AGY_STEP_INVENTORY: readonly AgyInventoryRow[] = Object.freeze([
  { source: 'USER_EXPLICIT', type: 'USER_INPUT', category: 'user-message', note: 'the only human bubble' },
  { source: 'MODEL', type: 'PLANNER_RESPONSE', category: 'assistant-turn', note: 'thinking + content + tool_calls' },
  { source: 'MODEL', type: 'RUN_COMMAND', category: 'tool', toolNames: ['run_command'], toolClass: 'execute', note: 'exit_code is authoritative' },
  { source: 'MODEL', type: 'VIEW_FILE', category: 'tool', toolNames: ['view_file'], toolClass: 'lookup', note: 'path from args.AbsolutePath' },
  { source: 'MODEL', type: 'GREP_SEARCH', category: 'tool', toolNames: ['grep_search'], toolClass: 'lookup', note: 'query from args.Query' },
  { source: 'MODEL', type: 'CODE_ACTION', category: 'tool', toolNames: ['write_to_file', 'replace_file_content', 'multi_replace_file_content'], toolClass: 'edit', note: 'target from args.TargetFile' },
  { source: 'MODEL', type: 'LIST_DIRECTORY', category: 'tool', toolNames: ['list_dir'], toolClass: 'lookup', note: 'dir from args.DirectoryPath' },
  { source: 'MODEL', type: 'GENERIC', category: 'tool', toolNames: ['manage_task', 'schedule', 'list_permissions', 'ask_permission'], toolClass: 'other', note: 'title from the call name' },
  { source: 'MODEL', type: 'SEARCH_WEB', category: 'tool', toolNames: ['search_web'], toolClass: 'lookup', note: 'web semantic' },
  { source: 'MODEL', type: 'READ_URL_CONTENT', category: 'tool', toolNames: ['read_url_content'], toolClass: 'lookup', note: 'web semantic' },
  { source: 'MODEL', type: 'ASK_QUESTION', category: 'question', toolNames: ['ask_question'], toolClass: 'other', note: 'a replayed question is settled' },
  { source: 'SYSTEM', type: 'CONVERSATION_HISTORY', category: 'history-reset', note: 'compaction boundary; carries no content' },
  { source: 'SYSTEM', type: 'CHECKPOINT', category: 'notice', note: 'context truncation checkpoint' },
  { source: 'SYSTEM', type: 'SYSTEM_MESSAGE', category: 'context-injection', note: 'agent-visible material, never typed' },
  { source: 'SYSTEM', type: 'DIRECTORY_RULES', category: 'context-injection', note: 'rules-file injection' },
  { source: 'SYSTEM', type: 'ERROR_MESSAGE', category: 'error', note: 'the `error` field is the message' },
]);

const INVENTORY_BY_PAIR = new Map<string, AgyInventoryRow>(
  AGY_STEP_INVENTORY.map((row) => [`${row.source}\0${row.type}`, row]),
);

/** Which tool names each step type can be the result of, derived from the one table above. */
const TOOL_NAMES_BY_TYPE = new Map<string, readonly string[]>(
  AGY_STEP_INVENTORY.filter((row) => row.toolNames).map((row) => [row.type, row.toolNames!]),
);

/** Look up a pair. Returns undefined for an unlisted pair — the caller routes it to `unmapped-step`. */
export function agyInventoryRow(source: string, type: string): AgyInventoryRow | undefined {
  return INVENTORY_BY_PAIR.get(`${source}\0${type}`);
}

/** The category a pair lands in. Total: an unlisted pair is `unmapped-step`, never a throw. */
export function agyStepCategory(source: string, type: string): AgyStepCategory {
  return agyInventoryRow(source, type)?.category ?? 'unmapped-step';
}

// ── User-row wrapper stripping ───────────────────────────────────────────────

/**
 * Wrapper tags agy writes INSIDE the user's own row.
 *
 * MEASURED over all 70 `USER_EXPLICIT/USER_INPUT` rows, 2026-08-25:
 *
 *   USER_REQUEST          70   the actual typed text — UNWRAPPED and kept
 *   ADDITIONAL_METADATA   70   a local-time stamp the harness appends — removed
 *   USER_SETTINGS_CHANGE  27   "the user changed setting X from A to B" — removed
 *   PLAN                   5   a plan blob the harness carries forward — removed
 *   SKILL                  1   a loaded skill body — removed
 *
 * The spec anticipated the first two plus a leading `/<mode>` token; the other
 * three were found in this sweep. All of them are harness state, and rendering
 * any of them would put words in the user's mouth — the same class of defect as
 * kimi's `<system-reminder>` rows arriving on the user role (reflection §10).
 *
 * The `/<mode>` token is separate and just as real: launching with `--mode=plan`
 * records the prompt as `<USER_REQUEST>\n/plan reply with…\n</USER_REQUEST>`
 * (spec §7.C1), so the mode rides inside the text the user typed.
 *
 * Everything removed is REPORTED back, not silently dropped, so a caller can
 * surface it as context rather than pretend it never existed.
 */
const AGY_USER_WRAPPER_TAGS = ['USER_REQUEST', 'ADDITIONAL_METADATA', 'USER_SETTINGS_CHANGE', 'PLAN', 'SKILL'] as const;

/** Modes `--mode` accepts, and therefore the only leading `/token` that is a mode prefix. */
const AGY_MODE_TOKENS = ['plan', 'accept-edits', 'full-access'] as const;

export interface AgyUserText {
  /** What the human actually typed. */
  text: string;
  /** Wrapper tags that were removed, in the order they appeared. Diagnostic + context surfacing. */
  removed: string[];
  /** The `--mode` token stripped from the head of the request, when there was one. */
  mode?: string;
}

/**
 * Recover the user's own words from a wrapped `USER_INPUT` row.
 *
 * `<USER_REQUEST>` is unwrapped and everything else is removed. A row with NO
 * `<USER_REQUEST>` block keeps its content as-is minus the other wrappers —
 * older rows in the corpus are bare — rather than rendering empty.
 */
export function stripAgyUserWrappers(content: string): AgyUserText {
  const removed: string[] = [];
  let request: string | undefined;
  let rest = content;

  for (const tag of AGY_USER_WRAPPER_TAGS) {
    const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
    rest = rest.replace(pattern, (_match, inner: string) => {
      if (tag === 'USER_REQUEST') request = (request ?? '') + inner;
      else removed.push(tag);
      return '';
    });
  }

  let text = (request !== undefined ? request : rest).trim();
  if (request !== undefined && rest.trim()) removed.push('trailing-text');

  // A leading `/<mode>` is the launch mode, not something the user typed. Only the
  // three modes `--mode` actually accepts are stripped: a real slash COMMAND the
  // user typed (`/help`) must survive, so this is a closed list rather than a
  // "strip any leading /word" rule.
  let mode: string | undefined;
  for (const candidate of AGY_MODE_TOKENS) {
    if (text === `/${candidate}`) {
      mode = candidate;
      text = '';
      break;
    }
    if (text.startsWith(`/${candidate} `) || text.startsWith(`/${candidate}\n`)) {
      mode = candidate;
      text = text.slice(candidate.length + 2).trim();
      break;
    }
  }

  return { text, removed, ...(mode ? { mode } : {}) };
}

// ── Tool argument decoding ───────────────────────────────────────────────────

/**
 * Decode `tool_calls[].args`.
 *
 * MEASURED 2026-08-25 over all 1,230 tool calls in the corpus: `args` is an
 * OBJECT whose every VALUE is a JSON-encoded string —
 * `{"AbsolutePath": "\"/fixture/x.md\"", "EndLine": "160"}`. So a naive
 * `args.AbsolutePath` yields `"/fixture/x.md"` WITH the quotes, and a path
 * rendered that way is wrong in a way nobody notices until it is clicked. Each
 * value is therefore JSON-parsed individually, falling back to the raw string
 * when it is not valid JSON.
 */
export function decodeAgyToolArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      out[key] = value;
      continue;
    }
    try {
      out[key] = JSON.parse(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Split the `Created At: … / Completed At: …` preamble off a tool row's content.
 *
 * MEASURED: every tool-result row's `content` opens with those two lines before
 * the actual result body. They are duration data, not output, and leaving them
 * in makes every tool card open with two lines of timestamp noise.
 */
export function splitAgyToolContent(content: string | undefined): {
  body: string;
  createdAt?: number;
  completedAt?: number;
} {
  if (!content) return { body: '' };
  const created = /^Created At: (\S+)\n/.exec(content);
  if (!created) return { body: content };
  let rest = content.slice(created[0].length);
  const completed = /^Completed At: (\S+)\n/.exec(rest);
  if (completed) rest = rest.slice(completed[0].length);
  const createdMs = Date.parse(created[1]!);
  const completedMs = completed ? Date.parse(completed[1]!) : Number.NaN;
  return {
    body: rest,
    ...(Number.isFinite(createdMs) ? { createdAt: createdMs } : {}),
    ...(Number.isFinite(completedMs) ? { completedAt: completedMs } : {}),
  };
}

// ── Queued driven sends (Q7) ─────────────────────────────────────────────────

/**
 * Cap on pending driven rows AND on their correlation links.
 *
 * Bounded TOGETHER, deliberately: claude shipped a version where the row list
 * was capped and its links were not, and an evicted row left behind a link whose
 * only remaining power was to lend its key to a later repeat of the same words
 * (reflection §6, "bound paired structures together"). {@link retireAgyQueuedSend}
 * is the one place a row and its link are dropped as a pair.
 */
export const AGY_PENDING_SEND_LIMIT = 32;

/**
 * One link from a minted pending row's key to the transcript line that will
 * eventually deliver it.
 *
 * `notBeforeOffset` is the fence. agy writes the delivering `USER_INPUT` line
 * itself, with no id we control, so the only way to tell OUR delivery from a
 * verbatim repeat typed in a terminal is position: our line is appended after
 * the byte size the transcript had when we wrote to stdin.
 */
export interface AgyQueuedSend {
  text: string;
  key: string;
  /** Transcript byte size at the moment the prompt was written to the child's stdin. */
  notBeforeOffset: number;
}

/** Per-CONNECTION queued-send state. Per-connection is what makes the drive shareable
 *  across two sockets: a peer socket's prompt travels through this same object, so it
 *  is our own writer and never reads as a foreign one (Q14). */
export interface AgyQueuedSends {
  pending: AgyQueuedSend[];
  /** step_index → key already assigned, so re-keying a line is idempotent across a re-read. */
  byStep: Map<number, string>;
}

export function createAgyQueuedSends(): AgyQueuedSends {
  return { pending: [], byStep: new Map() };
}

/** Register a minted row's link, bounded. Returns the keys of any rows evicted with it. */
export function pushAgyQueuedSend(state: AgyQueuedSends, entry: AgyQueuedSend): string[] {
  state.pending.push(entry);
  const evicted: string[] = [];
  while (state.pending.length > AGY_PENDING_SEND_LIMIT) {
    evicted.push(state.pending.shift()!.key);
  }
  return evicted;
}

/** Drop one link by key (its row went with it). */
export function retireAgyQueuedSend(state: AgyQueuedSends, key: string): void {
  const index = state.pending.findIndex((entry) => entry.key === key);
  if (index >= 0) state.pending.splice(index, 1);
}

/**
 * The delivering transcript line claims its pending row's key.
 *
 * Matching is on the EXACT stripped user text plus the byte fence, so:
 *  - a line appended BEFORE our send can never claim it, however identical;
 *  - a second identical prompt gets the OLDEST unclaimed matching link, which is
 *    the one whose delivery came first.
 *
 * Idempotent per `step_index`: a re-read of the transcript re-keys the same line
 * to the same key instead of minting a second row or consuming another link.
 * Returns undefined when this line was never one of ours — which is exactly the
 * foreign-write signal the drive connection acts on.
 */
export function takeAgyQueuedSendKey(
  state: AgyQueuedSends | undefined,
  stepIndex: number,
  text: string,
  lineOffset: number | undefined,
): string | undefined {
  if (!state) return undefined;
  const already = state.byStep.get(stepIndex);
  if (already !== undefined) {
    // A link still standing under that key is stale: this line already claimed it.
    retireAgyQueuedSend(state, already);
    return already;
  }
  const trimmed = text.trim();
  const index = state.pending.findIndex(
    (entry) => entry.text === trimmed
      && lineOffset !== undefined
      && lineOffset >= entry.notBeforeOffset,
  );
  if (index < 0) return undefined;
  const key = state.pending.splice(index, 1)[0]!.key;
  state.byStep.set(stepIndex, key);
  return key;
}

// ── Fold state ───────────────────────────────────────────────────────────────

/** One tool call awaiting its result row. */
interface AgyPendingCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * State the fold carries across steps. Recreated per replay and advanced by the
 * live tail — the SAME object type on both paths, so a call opened by the replay
 * can be closed by the tail.
 */
export interface AgyMapState {
  conversationId: string;
  /** Tool calls opened by a planner row and not yet answered by a result row. */
  pendingCalls: AgyPendingCall[];
  /** Steps already emitted, so a step admitted on one path is never re-emitted on the other. */
  seenSteps: Set<number>;
  /** True while a live drive child owns this session — decides how a RUNNING row renders. */
  liveChild: boolean;
  /**
   * Q7's correlation table, when a drive connection owns this fold.
   *
   * REPLAY STATE IS LIVE STATE (reflection §6): the history replay reads AND
   * writes the same object the live tail does. A replay that started from a
   * blank table would key a line one way while the tail keyed it another a
   * second later, which is precisely claude's P1b.
   */
  queuedSends?: AgyQueuedSends;
  trace?: AgyTraceSink;
}

export function createAgyMapState(
  conversationId: string,
  options: { liveChild?: boolean; trace?: AgyTraceSink; queuedSends?: AgyQueuedSends } = {},
): AgyMapState {
  return {
    conversationId,
    pendingCalls: [],
    seenSteps: new Set(),
    liveChild: options.liveChild ?? false,
    ...(options.queuedSends ? { queuedSends: options.queuedSends } : {}),
    ...(options.trace ? { trace: options.trace } : {}),
  };
}

/** Cap on unanswered calls carried forward, so a transcript full of orphaned calls cannot grow without bound. */
const PENDING_CALL_LIMIT = 64;

// ── The fold ─────────────────────────────────────────────────────────────────

/**
 * Map ONE step to canonical messages. The only fold in this adapter.
 *
 * Total by construction: every path through it returns an array, and the
 * `unmapped-step` category is a real destination rather than a `default:` that
 * absorbs the remainder.
 */
export function mapAgyStep(step: AgyStep, state: AgyMapState): AgentMessage[] {
  const key = agyStepKey(state.conversationId, step.step_index);
  const category = agyStepCategory(step.source, step.type);
  const truncated = (step.truncated_fields ?? []).length > 0;

  switch (category) {
    case 'user-message':
      return mapUserStep(step, state, key, truncated);
    case 'assistant-turn':
      return mapAssistantStep(step, state, key, truncated);
    case 'tool':
      return mapToolStep(step, state, key, truncated);
    case 'question':
      return mapQuestionStep(step, state, key);
    case 'context-injection':
      return mapContextInjection(step, truncated);
    case 'notice':
      return [{ type: 'notice', message: agyNoticeText(step, truncated) }];
    case 'history-reset':
      return [{ type: 'history-reset', semantic: { kind: 'compaction' } }];
    case 'error':
      return [{ type: 'error', message: step.error ?? agyBodyOf(step) ?? 'agy reported an error with no message.' }];
    case 'unmapped-step':
      return mapUnmappedStep(step, state);
  }
}

/**
 * The named neutral category.
 *
 * An unlisted pair renders as a context-injection event carrying its OWN
 * `source` and `type` in the label, so a vocabulary change introduced by a
 * silent auto-update is legible in the transcript rather than invisible. It is
 * never a `user-message` — that is the whole point — and never a throw, because
 * one unknown step must not take out the replay of a whole conversation.
 */
function mapUnmappedStep(step: AgyStep, state: AgyMapState): AgentMessage[] {
  state.trace?.({
    op: 'unmapped-step',
    detail: `unlisted (source, type) pair: ${step.source}/${step.type} at step ${step.step_index}`,
  });
  const bounded = boundContextBody(agyBodyOf(step) ?? '');
  return [
    {
      type: 'event',
      name: CONTEXT_INJECTION_EVENT,
      // `source` carries the unmapped pair verbatim, so the row names what it is
      // in the surface a reader actually sees rather than only in a log line.
      payload: {
        source: `agy ${step.source}/${step.type} (unmapped)`,
        body: bounded.body,
        ...(bounded.truncated ? { truncated: true } : {}),
      },
    },
  ];
}

/**
 * A `USER_INPUT` row, keyed by the pending row it delivers when it is one of ours.
 *
 * The key decision is the whole of Q7. A prompt this connection sent already has
 * a row on screen under an app-minted key; when agy finally writes the line, it
 * must take THAT key over so the queued bubble clears in place instead of a
 * second bubble appearing beside it. When no pending link matches — a terminal
 * typed it, or this is an ordinary replay with no drive — the row falls back to
 * its own step key, which is what observe has always done.
 */
function mapUserStep(step: AgyStep, state: AgyMapState, key: string, truncated: boolean): AgentMessage[] {
  const stripped = stripAgyUserWrappers(step.content ?? '');
  const sentAt = Date.parse(step.created_at);
  const claimed = takeAgyQueuedSendKey(
    state.queuedSends,
    step.step_index,
    stripped.text,
    agyStepOffset(step),
  );
  const out: AgentMessage[] = [
    {
      type: 'user-message',
      text: truncated ? `${stripped.text}\n\n${AGY_TRUNCATION_NOTE}` : stripped.text,
      key: claimed ?? key,
      ...(Number.isFinite(sentAt) ? { sentAt } : {}),
    },
  ];
  // What was stripped is agent-visible material the user did not type. It is
  // surfaced as context rather than deleted, so nothing the agent was handed
  // vanishes from the record (reflection §9: collapse, never delete).
  if (stripped.removed.length > 0) {
    out.push({
      type: 'event',
      name: CONTEXT_INJECTION_EVENT,
      payload: { source: `agy user-row metadata (${stripped.removed.join(', ')})`, body: '' },
    });
  }
  return out;
}

function mapAssistantStep(step: AgyStep, state: AgyMapState, key: string, truncated: boolean): AgentMessage[] {
  const out: AgentMessage[] = [];
  if (step.thinking) out.push({ type: 'thinking', text: step.thinking, key: `${key}:thinking` });
  const text = step.content?.trim();
  if (text) {
    out.push({
      type: 'model-output',
      text: truncated ? `${text}\n\n${AGY_TRUNCATION_NOTE}` : text,
      key: `${key}:text`,
      final: true,
    });
  }
  // Tool calls open here and are closed by a later result row. The call is emitted
  // even when no result ever arrives — an unanswered call is a true statement about
  // the conversation, and dropping it would hide a turn that was cut off.
  for (const [index, call] of (step.tool_calls ?? []).entries()) {
    const args = decodeAgyToolArgs(call.args);
    const callId = `${key}:call:${index}`;
    out.push({
      type: 'tool-call',
      callId,
      toolName: call.name,
      ...(agyToolTitle(call.name, args) ? { title: agyToolTitle(call.name, args) } : {}),
      args,
      ...(toolClassForName(call.name) ? { toolClass: toolClassForName(call.name)! } : {}),
    });
    state.pendingCalls.push({ callId, name: call.name, args });
  }
  if (state.pendingCalls.length > PENDING_CALL_LIMIT) {
    state.pendingCalls.splice(0, state.pendingCalls.length - PENDING_CALL_LIMIT);
  }
  return out;
}

/**
 * Correlate a result row to the call that opened it, and render both.
 *
 * agy's result rows carry NO call id and no tool name — only the step `type` —
 * so the join is by tool NAME against the pending queue, using the name list the
 * inventory table declares for that type. MEASURED over the corpus: 1,205 of
 * 1,217 result rows (99.01%) find their call this way.
 *
 * The other 12 do NOT get guessed at. They emit a SELF-CONTAINED call+result
 * pair keyed to their own step, so the row still renders with its real content
 * and is never silently attached to an unrelated call. Positional adjacency was
 * measured and rejected as the join: `step_index` is non-monotone in 9 of 29
 * transcripts, and a positional zip mis-attributes ~2.4% of rows.
 */
function mapToolStep(step: AgyStep, state: AgyMapState, key: string, truncated: boolean): AgentMessage[] {
  const names = TOOL_NAMES_BY_TYPE.get(step.type) ?? [];
  const index = state.pendingCalls.findIndex((pending) => names.includes(pending.name));
  const matched = index >= 0 ? state.pendingCalls.splice(index, 1)[0]! : undefined;
  const out: AgentMessage[] = [];

  let callId: string;
  let toolName: string;
  let args: Record<string, unknown>;
  if (matched) {
    callId = matched.callId;
    toolName = matched.name;
    args = matched.args;
  } else {
    state.trace?.({
      op: 'tool-result-uncorrelated',
      detail: `no pending ${step.type} call for step ${step.step_index}; rendering self-contained`,
    });
    callId = `${key}:result`;
    toolName = names[0] ?? step.type.toLowerCase();
    args = {};
    out.push({ type: 'tool-call', callId, toolName, args, ...(toolClassForName(toolName) ? { toolClass: toolClassForName(toolName)! } : {}) });
  }

  const { body, createdAt, completedAt } = splitAgyToolContent(step.content);
  const resultBody = truncated ? `${body}\n\n${AGY_TRUNCATION_NOTE}` : body;
  const semantic = agyToolSemantic(step, toolName, args, body);
  const durationMs = createdAt !== undefined && completedAt !== undefined ? completedAt - createdAt : undefined;

  out.push({
    type: 'tool-result',
    callId,
    toolName,
    ...(toolClassForName(toolName) ? { toolClass: toolClassForName(toolName)! } : {}),
    ...(semantic ? { semantic } : {}),
    result: resultBody,
    ...(agyToolTitle(toolName, args) ? { title: agyToolTitle(toolName, args) } : {}),
    ...(stringArg(args, 'AbsolutePath') || stringArg(args, 'TargetFile')
      ? { path: stringArg(args, 'AbsolutePath') ?? stringArg(args, 'TargetFile')! }
      : {}),
    ...(step.exit_code !== undefined ? { exitCode: step.exit_code } : {}),
    // A RUNNING row replayed with no live child is NOT running — see the class doc.
    ...(agyIsErrorRow(step, state) ? { isError: true } : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(durationMs !== undefined && durationMs >= 0 ? { durationMs } : {}),
  });
  return out;
}

/**
 * A replayed `ASK_QUESTION` is SETTLED, not open.
 *
 * The row is in the transcript because the question was asked; a replay happens
 * after the fact, and the corpus shows the answer folded into the same row's
 * content. Emitting a live `question-request` here would put an unanswerable
 * prompt in front of the user on every page load. So the replay renders the
 * asked question as the tool row it is, and P1's live path is where an open
 * question becomes a `question-request`.
 */
function mapQuestionStep(step: AgyStep, state: AgyMapState, key: string): AgentMessage[] {
  return mapToolStep(step, state, key, (step.truncated_fields ?? []).length > 0);
}

function mapContextInjection(step: AgyStep, truncated: boolean): AgentMessage[] {
  const bounded = boundContextBody(agyBodyOf(step) ?? '');
  return [
    {
      type: 'event',
      name: CONTEXT_INJECTION_EVENT,
      payload: {
        source: agyInjectionSource(step.type),
        body: bounded.body,
        ...(bounded.truncated || truncated ? { truncated: true } : {}),
      },
    },
  ];
}

function agyInjectionSource(type: string): string {
  return type === 'DIRECTORY_RULES' ? 'agy directory rules' : 'agy system message';
}

/** The stated-truncation marker. Never silently short — spec §4 "Failure traces". */
export const AGY_TRUNCATION_NOTE = '[agy truncated this field in transcript.jsonl and no transcript_full.jsonl was available]';

function agyNoticeText(step: AgyStep, truncated: boolean): string {
  const body = agyBodyOf(step) ?? 'Antigravity recorded a checkpoint.';
  const head = body.split('\n').slice(0, 3).join('\n');
  return truncated ? `${head}\n${AGY_TRUNCATION_NOTE}` : head;
}

function agyBodyOf(step: AgyStep): string | undefined {
  const { body } = splitAgyToolContent(step.content);
  return body || step.content;
}

/**
 * The status vocabulary, and the one value that is not in the files.
 *
 * The 29-transcript corpus carries exactly three: `DONE`, `RUNNING`, `ERROR`
 * (MEASURED 2026-08-25). `CANCELED` is a FOURTH, and it exists because the
 * stream has a state the file corpus does not: a step the user or the host
 * stopped part-way. {@link AGY_CANCELED_STATUS} is minted by the drive stream
 * reader when a `step_update` reports a cancel-shaped state, so a canceled step
 * has one spelling by the time it reaches this fold.
 *
 * It is a TERMINAL status. Treating it as running was the bug: a canceled step
 * kept its spinner forever, because nothing else was ever going to arrive for it.
 */
export const AGY_CANCELED_STATUS = 'CANCELED';

/**
 * A `status: RUNNING` row replayed with no live child is interrupted, not running.
 *
 * 28 corpus lines carry `RUNNING` — rows written mid-turn whose process is long
 * gone. Reflection §9: terminal state leaves a trace, and the trace here is an
 * honest "this did not finish" rather than a spinner that never stops.
 *
 * A CANCELED row is deliberately NOT an error row: the user stopping something
 * is not a failure, and painting it red would say the host broke when it obeyed.
 */
function agyIsErrorRow(step: AgyStep, state: AgyMapState): boolean {
  if (step.status === 'ERROR') return true;
  if (step.status === AGY_CANCELED_STATUS) return false;
  return step.status === 'RUNNING' && !state.liveChild;
}

/** How a row's command state reads, given whether a live child owns the session. */
export function agyCommandState(status: string, liveChild: boolean): 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown' {
  if (status === 'DONE') return 'completed';
  if (status === 'ERROR') return 'failed';
  // Terminal regardless of whether a child is alive — that is the whole point.
  // `interrupted` is the protocol's word for "stopped before it finished", which
  // is exactly what a cancel is.
  if (status === AGY_CANCELED_STATUS) return 'interrupted';
  if (status === 'RUNNING') return liveChild ? 'running' : 'interrupted';
  return 'unknown';
}

function toolClassForName(name: string): ToolDisplayClass | undefined {
  for (const row of AGY_STEP_INVENTORY) {
    if (row.toolNames?.includes(name)) return row.toolClass;
  }
  return undefined;
}

/** A one-line card title. `toolSummary` is the HOST's own summary — never invented here. */
function agyToolTitle(name: string, args: Record<string, unknown>): string | undefined {
  return stringArg(args, 'toolSummary') ?? stringArg(args, 'toolAction');
}

function agyToolSemantic(
  step: AgyStep,
  toolName: string,
  args: Record<string, unknown>,
  body: string,
): ToolSemantic | undefined {
  const state = agyCommandState(step.status, false);
  switch (toolName) {
    case 'run_command':
      return boundToolSemantic(commandSemantic({
        command: stringArg(args, 'CommandLine'),
        cwd: stringArg(args, 'Cwd'),
        state,
        stdout: boundedStream(body),
      }));
    case 'view_file':
      return boundToolSemantic(fileReadSemantic({
        path: stringArg(args, 'AbsolutePath'),
        startLine: args.StartLine,
        preview: body,
        ...(step.truncated_fields?.includes('content') ? { previewTruncated: true } : {}),
      }));
    case 'grep_search':
      return boundToolSemantic(searchSemantic({
        query: stringArg(args, 'Query'),
        scope: stringArg(args, 'SearchPath'),
      }));
    case 'search_web':
      return boundToolSemantic(webSemantic({ query: stringArg(args, 'query') }));
    case 'read_url_content':
      return boundToolSemantic(webSemantic({ url: stringArg(args, 'Url') }));
    default:
      return undefined;
  }
}

// ── Background-task settlement ───────────────────────────────────────────────

/** One `.system_generated/messages/<uuid>.json`. Shape MEASURED over 37 files / 6 conversations. */
export interface AgySettlement {
  id: string;
  recipient: string;
  /** `<conversationId>/task-<N>` — the key this block is rendered under. */
  sender: string;
  timestamp: string;
  messageTitle: string;
  content: string;
  /** `sourceMetadata.tool.stepIndex`, which joins to a transcript `step_index`. MEASURED join. */
  stepIndex?: number;
  toolName?: string;
}

export function parseAgySettlement(text: string): AgySettlement | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const row = parsed as Record<string, unknown>;
  const sender = typeof row.sender === 'string' ? row.sender : '';
  if (!sender) return undefined;
  const render = (row.renderDetails ?? {}) as Record<string, unknown>;
  const tool = (((row.sourceMetadata ?? {}) as Record<string, unknown>).tool ?? {}) as Record<string, unknown>;
  const call = (tool.toolCall ?? {}) as Record<string, unknown>;
  return {
    id: typeof row.id === 'string' ? row.id : '',
    recipient: typeof row.recipient === 'string' ? row.recipient : '',
    sender,
    timestamp: typeof row.timestamp === 'string' ? row.timestamp : '',
    messageTitle: typeof render.messageTitle === 'string' ? render.messageTitle : '',
    content: typeof row.content === 'string' ? row.content : '',
    ...(typeof tool.stepIndex === 'number' ? { stepIndex: tool.stepIndex } : {}),
    ...(typeof call.name === 'string' ? { toolName: call.name } : {}),
  };
}

/**
 * A finished background task, as a self-contained tool block keyed by its sender.
 *
 * dsh's `subagent-settled` decision (reflection §12): the settlement is a
 * completion report, not a turn, so it is a tool block and never a user message.
 * It is keyed by `sender` (`<conversationId>/task-<N>`) — the child's own id —
 * and correlated to the step that spawned it through
 * `sourceMetadata.tool.stepIndex`, which is a MEASURED join and not a guess.
 */
export function mapAgySettlement(settlement: AgySettlement, conversationId: string): AgentMessage[] {
  const callId = `agy:${conversationId}:task:${settlement.sender}`;
  const toolName = settlement.toolName ?? 'background-task';
  const spawnedBy = settlement.stepIndex !== undefined
    ? agyStepKey(conversationId, settlement.stepIndex)
    : undefined;
  return [
    {
      type: 'tool-call',
      callId,
      toolName,
      title: settlement.messageTitle || settlement.sender,
      toolClass: 'execute',
      args: { task: settlement.sender, ...(spawnedBy ? { spawnedBy } : {}) },
    },
    {
      type: 'tool-result',
      callId,
      toolName,
      toolClass: 'execute',
      title: settlement.messageTitle || settlement.sender,
      result: settlement.content,
    },
  ];
}
