/**
 * Kimi native REST payloads → the canonical protocol shapes.
 *
 * Every Kimi-native field name is confined to this file and its callers inside
 * this package; nothing Kimi-shaped may reach the broker or the client.
 *
 * The mapping is TOTAL by construction: an unknown role, an unknown content
 * kind, or a structurally wrong record degrades into a safe generic message.
 * Kimi marks its server API experimental, so a record type added upstream must
 * cost the user one oddly-rendered row, never a thrown attach.
 *
 * Captured against Kimi Code 0.35.0 (see `test/fixtures/kimi-0.35.0.json`).
 */
import type {
  AgentMessage,
  ModelOption,
  SessionControlState,
  SessionInfo,
} from '@cosyncing/adapter-api';
import type { KimiQuestionAnswer } from './drive-http.ts';

// ── Control state ───────────────────────────────────────────────────────────

/**
 * Why a FOREIGN session cannot be driven.
 *
 * Foreign means "not created through cosyncing in this broker process": a
 * terminal `kimi -S <id>` may be its live owner, and two writers silently fork
 * one Kimi journal (the CLI runs its own in-process event bus and journal
 * counter — verified upstream, `apps/kimi-code/src/cli/run-shell.ts:90` plus
 * `sessionEventJournal.ts:76,88,140-143`). So the reason names the risk rather
 * than this adapter's own posture. ONE constant, used by the roster mapping,
 * the attach fallback, and the refusal path alike.
 */
export const KIMI_FOREIGN_DRIVE_REASON = 'kimi-terminal-owned';

/** Why a foreign row offers no terminal sync: this adapter observes, it does not bridge. */
export const KIMI_OBSERVE_ONLY_REASON = 'kimi-observe-only';

/**
 * Why an OWNED session offers no terminal sync either — a different fact, hence
 * a different string: driving happens THROUGH the Kimi server, which is the
 * single writer. There is no separate cosyncing bridge to make active, so
 * `syncAvailable` would be a lie in either direction.
 */
export const KIMI_OWNED_TERMINAL_SYNC_REASON = 'kimi-server-owned';

/** Why an explicit observe attach to an OWNED session still cannot mutate. */
export const KIMI_OBSERVE_POSTURE_REASON = 'open this session live to drive it';

/** Why a live connection was demoted mid-flight. See the divergence detector in `drive.ts`. */
export const KIMI_FOREIGN_WRITER_REASON = 'kimi-foreign-writer';

/**
 * The roster/connection control state of a session cosyncing created and still
 * owns.
 *
 * `drive {supported:true, state:'driving'}` is the roster-level claim OpenCode
 * makes for every session its shared server lists: attaching IS driving,
 * because the server is the single writer and we are talking to it. It is also
 * what `sessionConnectionAuthority` reads to grant `canMutate`, and what routes
 * `createdSessionAttachMode` to a bare attach.
 */
export function kimiOwnedControlState(): SessionControlState {
  return {
    drive: { supported: true, state: 'driving' },
    terminalSync: {
      supported: false,
      syncAvailable: false,
      active: false,
      reason: KIMI_OWNED_TERMINAL_SYNC_REASON,
    },
  };
}

/** The control state of a session this process did not create. Fail-closed: observe only. */
export function kimiForeignControlState(): SessionControlState {
  return {
    drive: { state: 'observing', supported: false, reason: KIMI_FOREIGN_DRIVE_REASON },
    terminalSync: {
      supported: false,
      syncAvailable: false,
      active: false,
      reason: KIMI_OBSERVE_ONLY_REASON,
    },
  };
}

/**
 * An EXPLICIT observe connection to a session we own. Drive is `supported` —
 * this session genuinely could be driven — but this connection is not doing it,
 * so `state` is `observing` and the authority gate denies mutation.
 */
export function kimiOwnedObserveControlState(): SessionControlState {
  return {
    drive: { supported: true, state: 'observing', reason: KIMI_OBSERVE_POSTURE_REASON },
    terminalSync: {
      supported: false,
      syncAvailable: false,
      active: false,
      reason: KIMI_OWNED_TERMINAL_SYNC_REASON,
    },
  };
}

/**
 * A live connection demoted after a foreign write was PROVEN. `unavailable`
 * rather than `observing`: this is not a posture the user can change by
 * reattaching — the session now has another writer, and re-driving it would
 * fork the journal.
 */
export function kimiDemotedControlState(terminalSync: SessionControlState['terminalSync']): SessionControlState {
  return {
    drive: { supported: false, state: 'unavailable', reason: KIMI_FOREIGN_WRITER_REASON },
    // Unchanged: demotion is a statement about the DRIVE half only.
    terminalSync,
  };
}

/** Answers "did THIS process create this session"; see `KimiAdapter.ownedSessions`. */
export type KimiOwnershipPredicate = (id: string) => boolean;

// ── Native shapes (structural, deliberately permissive) ─────────────────────

export interface KimiV2Session {
  id?: unknown;
  workspace?: { id?: unknown; cwd?: unknown };
  meta?: {
    title?: unknown;
    last_prompt?: unknown;
    created_at?: unknown;
    updated_at?: unknown;
    archived?: unknown;
    archived_at?: unknown;
  };
  activity?: { status?: unknown };
}

export interface KimiV2SessionPage {
  items?: unknown;
  has_more?: unknown;
  next_page_token?: unknown;
}

/**
 * The FLAT v1 session row (`protocol/session.ts:42-69`) answered by
 * `POST /api/v1/sessions` and `GET /api/v1/sessions/{id}`.
 *
 * `usage` is deliberately absent from this reader even though the row carries
 * it: the projection is hardcoded-empty upstream (`routes/sessions.ts:1195`
 * returns `emptySessionUsage()`), so reading it would report a real session's
 * spend as zero. Token counts come from the wire journal — see `usage.ts`.
 */
export interface KimiV1Session {
  id?: unknown;
  title?: unknown;
  last_prompt?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  busy?: unknown;
  pending_interaction?: unknown;
  last_turn_reason?: unknown;
  metadata?: unknown;
}

export interface KimiMessage {
  id?: unknown;
  session_id?: unknown;
  role?: unknown;
  content?: unknown;
  created_at?: unknown;
  prompt_id?: unknown;
  metadata?: unknown;
}

export interface KimiMessagePage {
  items?: unknown;
  has_more?: unknown;
}

// ── Sessions ────────────────────────────────────────────────────────────────

/**
 * Kimi's v2 activity enum → the canonical three-state status.
 *
 * `failed` is a finished turn's outcome, not a live activity, so it maps to
 * `idle` rather than inventing an error state the protocol does not carry.
 */
function mapActivityStatus(raw: unknown): SessionInfo['status'] {
  switch (raw) {
    case 'running':
      return 'working';
    case 'approval':
    case 'question':
      return 'needs-input';
    default:
      return 'idle';
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalEpochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Map one v2 session row. Returns undefined only when the row has no usable id;
 * everything else degrades to an absent optional field.
 *
 * OWNERSHIP decides the posture, and it is decided HERE rather than downstream
 * so one row can never be listed as driveable and attached as foreign. A
 * session this process created through `createSession` is `live` and driving; a
 * session from a terminal, from another tool, or from a previous broker process
 * is FOREIGN — listing plus reviewed read-only observe, never Drive. That is
 * the coexistence rule, fail-closed: no predicate means nothing is owned.
 */
export function mapKimiSession(raw: KimiV2Session, isOwned?: KimiOwnershipPredicate): SessionInfo | undefined {
  const id = optionalString(raw?.id);
  if (!id) return undefined;
  const meta = raw.meta ?? {};
  const title = optionalString(meta.title) ?? optionalString(meta.last_prompt) ?? id;
  const cwd = optionalString(raw.workspace?.cwd);
  const createdAt = optionalEpochMs(meta.created_at);
  const updatedAt = optionalEpochMs(meta.updated_at);
  const owned = isOwned?.(id) === true;
  return {
    id,
    tool: 'kimi',
    title,
    ...(cwd ? { cwd } : {}),
    status: mapActivityStatus(raw.activity?.status),
    launchSurface: 'unknown',
    attachMode: owned ? 'live' : 'observe',
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    control: owned ? kimiOwnedControlState() : kimiForeignControlState(),
  };
}

export function mapKimiSessionPage(page: KimiV2SessionPage | undefined, isOwned?: KimiOwnershipPredicate): {
  sessions: SessionInfo[];
  nextPageToken?: string;
  hasMore: boolean;
} {
  const items = Array.isArray(page?.items) ? page.items : [];
  const sessions: SessionInfo[] = [];
  for (const item of items) {
    const mapped = mapKimiSession((item ?? {}) as KimiV2Session, isOwned);
    if (mapped) sessions.push(mapped);
  }
  const nextPageToken = optionalString(page?.next_page_token);
  return {
    sessions,
    ...(nextPageToken ? { nextPageToken } : {}),
    hasMore: page?.has_more === true,
  };
}

/**
 * The FLAT v1 session row (`protocol/session.ts:42-69`), which is what
 * `POST /api/v1/sessions` answers with — deliberately its own mapper.
 *
 * It is not the v2 listing shape {@link mapKimiSession} handles: there is no
 * `meta`/`activity`/`workspace` nesting, `cwd` lives under `metadata`, and
 * liveness arrives as `busy` plus `pending_interaction` rather than an activity
 * enum. Folding the two into one permissive reader would mean a row missing a
 * field could silently be read through the wrong branch; two mappers make each
 * shape's absence visible.
 *
 * A created session is OWNED by definition — this process just made it — so the
 * posture is fixed rather than predicate-driven.
 */
export function mapKimiCreatedSession(raw: KimiV1Session | undefined): SessionInfo | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const id = optionalString(raw.id);
  if (!id) return undefined;
  const cwd = optionalString((raw.metadata as { cwd?: unknown } | undefined)?.cwd);
  const createdAt = optionalEpochMs(raw.created_at);
  const updatedAt = optionalEpochMs(raw.updated_at);
  return {
    id,
    tool: 'kimi',
    title: optionalString(raw.title) ?? optionalString(raw.last_prompt) ?? id,
    ...(cwd ? { cwd } : {}),
    // A create answer with unreadable liveness fields still describes a session
    // that has never run a turn — nothing has been submitted to it yet — so the
    // roster field falls back to `idle` here rather than refusing the whole
    // create. This is the ONE place that fallback is honest: there is no
    // connection yet, so there is no fence for it to clear and no turn for it to
    // end. Every live caller ignores `undefined` instead.
    status: mapKimiRunState(raw.busy, raw.pending_interaction) ?? 'idle',
    // The app asked for this session, so its provenance is not "unknown" the
    // way a discovered row's is.
    launchSurface: 'app',
    attachMode: 'live',
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    control: kimiOwnedControlState(),
  };
}

/**
 * The closed `pending_interaction` enum, verbatim
 * (`protocol/session.ts:39`, `sessionPendingInteractionSchema`). A value outside
 * it is drift, not a state this reader may narrow into one it knows.
 */
const KIMI_PENDING_INTERACTIONS: ReadonlySet<unknown> = new Set(['none', 'approval', 'question']);

/**
 * The v1 liveness pair → the canonical three-state status, or UNDEFINED when the
 * payload is not evidence of a run state at all.
 *
 * `busy` is a REQUIRED boolean upstream — `protocol/session.ts:49` for the
 * session row, `events-zod.ts:591-597` for the `work_changed` frame — and
 * `pending_interaction` is the closed enum above. So `{busy:"false"}`, `{}`,
 * `{busy:null}`, or a drifted interaction name is not a session that happens to
 * be idle; it is a payload this reader cannot read, and saying so is the whole
 * point. Idle is not a neutral answer here: it CLEARS the drive connection's
 * completion fences and ends the turn for the client, so a fabricated idle ends
 * a turn that may still be running. The callers ignore `undefined` and keep the
 * state they already hold.
 *
 * Order matters, and it is the ORDER OF EVIDENCE, not merely of preference.
 * `busy === true` is a complete answer on its own: a session running a turn
 * WHILE holding a resolved-but-unreaped interaction is working, not blocked, and
 * nothing the interaction field could say — including a name this version does
 * not know — makes it less true. Reading `busy` LAST would discard that
 * evidence over a field it does not depend on, and the caller would then keep
 * whatever stale state it holds (often `idle`) for a session the server just
 * said is running.
 *
 * The interaction field is therefore consulted only where the answer actually
 * turns on it: `busy === false`, where `approval`/`question` is the difference
 * between `idle` and `needs-input`. A present-but-unknown value there is drift
 * this reader will not narrow — it returns undefined rather than fabricating
 * either state, exactly as before.
 */
export function mapKimiRunState(
  busy: unknown,
  pendingInteraction: unknown,
): SessionInfo['status'] | undefined {
  if (typeof busy !== 'boolean') return undefined;
  if (busy) return 'working';
  // Absent is legal (the field is optional upstream); present-but-unknown is not.
  if (pendingInteraction !== undefined && !KIMI_PENDING_INTERACTIONS.has(pendingInteraction)) {
    return undefined;
  }
  if (pendingInteraction === 'approval' || pendingInteraction === 'question') return 'needs-input';
  return 'idle';
}

// ── Models ──────────────────────────────────────────────────────────────────

/**
 * `GET /api/v1/models` → the model picker's options.
 *
 * TOTAL like every other mapping here: an item missing `provider` or `model`
 * has no selection token behind it and is SKIPPED, never turned into an option
 * the broker would then validate a create against. A catalog that drifts costs
 * the user a missing row, never a thrown create.
 */
export function mapKimiModelCatalog(raw: unknown): ModelOption[] {
  const items = Array.isArray((raw as { items?: unknown } | undefined)?.items)
    ? ((raw as { items: unknown[] }).items)
    : [];
  const options: ModelOption[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const providerID = optionalString(row.provider);
    // `model` is the alias id fed back into the prompt body's `model` field.
    const modelID = optionalString(row.model);
    if (!providerID || !modelID) continue;
    const efforts = Array.isArray(row.support_efforts)
      ? row.support_efforts.filter((effort): effort is string => typeof effort === 'string' && effort.length > 0)
      : [];
    const defaultEffort = optionalString(row.default_effort);
    options.push({
      providerID,
      modelID,
      label: optionalString(row.display_name) ?? modelID,
      ...(efforts.length > 0
        ? { reasoningEfforts: efforts.map((effort) => ({ effort, label: effort })) }
        : {}),
      ...(defaultEffort ? { defaultReasoningEffort: defaultEffort } : {}),
    });
  }
  return options;
}

// ── Messages ────────────────────────────────────────────────────────────────

/** Stable dedupe/merge key for one native message part. */
function partKey(messageId: string, index: number): string {
  return `kimi:${messageId}:${index}`;
}

function contentParts(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  return raw.filter((part): part is Record<string, unknown> =>
    !!part && typeof part === 'object' && !Array.isArray(part));
}

function textOf(part: Record<string, unknown>, field: string): string {
  const value = part[field];
  return typeof value === 'string' ? value : '';
}

/**
 * One canonical message plus the identity of the native part it came from.
 *
 * The native identity travels ALONGSIDE the message because several canonical
 * types carry nowhere to put it. `notice` has no key field at all, so two system
 * rows with identical text are indistinguishable once rendered — and a dedupe
 * that hashes the rendered message would treat them as one and drop the second.
 * Pairing keeps identity a fact about the SOURCE rather than about the bytes we
 * happened to render.
 */
export interface KimiMappedRow {
  message: AgentMessage;
  /** Stable, globally unique per native (message id, part index) and type. */
  identity: string;
  /**
   * The RAW native message id, without the part index or type folded in.
   *
   * Distinct from {@link identity} on purpose. Identity answers "have I emitted
   * this row"; this answers "which native message is this row part of", which
   * is the only thing that can be matched against a `user_message_id` the
   * prompt-submission response handed back, or against the id stream the
   * divergence detector compares. Folding them would make a message that
   * produced three rows look like three different messages.
   */
  nativeMessageId: string;
  /**
   * The native role, verbatim and unnarrowed. The divergence detector reads
   * only `'user'` rows (see `drive.ts`), and an unrecognized role must stay
   * visible as itself rather than degrade into one this version knows.
   */
  nativeRole?: string;
}

/**
 * Map one native message into zero or more canonical rows.
 *
 * A native message carries an ARRAY of content parts (text plus thinking plus
 * tool calls in one record), so the fan-out is one canonical message per part,
 * each keyed by its position so history replay and the live tail dedupe against
 * the same identity.
 */
export function mapKimiMessage(raw: KimiMessage): KimiMappedRow[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const id = optionalString(raw.id);
  if (!id) return [];
  const role = raw.role;
  const parts = contentParts(raw.content);
  const sentAt = optionalEpochMs(raw.created_at);
  const nativeRole = typeof role === 'string' ? role : undefined;
  const rows: KimiMappedRow[] = [];
  const out = {
    push(message: AgentMessage, nativeKey: string): void {
      rows.push({
        message,
        identity: `${message.type}:${nativeKey}`,
        nativeMessageId: id,
        ...(nativeRole !== undefined ? { nativeRole } : {}),
      });
    },
  };

  if (parts.length === 0) return rows;

  for (const [index, part] of parts.entries()) {
    const key = partKey(id, index);
    const kind = part.type;
    if (kind === 'text') {
      const text = textOf(part, 'text');
      if (!text) continue;
      if (role === 'user') {
        out.push({
          type: 'user-message',
          text,
          key,
          ...(sentAt !== undefined ? { sentAt } : {}),
        }, key);
      } else if (role === 'system') {
        out.push({ type: 'notice', message: text }, key);
      } else if (role === 'assistant') {
        out.push({ type: 'model-output', text, final: true, key }, key);
      } else {
        // Only 'assistant' is model output. A role this version does not know is
        // NOT quietly attributed to the model: mapping stays total by degrading
        // to the generic floor, carrying the native role so drift is visible.
        out.push(
          {
            type: 'event',
            name: 'kimi.unmapped-role',
            payload: { key, nativeRole: typeof role === 'string' ? role : 'unknown' },
          },
          key,
        );
      }
      continue;
    }
    if (kind === 'thinking') {
      const text = textOf(part, 'thinking');
      if (text) out.push({ type: 'thinking', text, key }, key);
      continue;
    }
    if (kind === 'tool_use') {
      const callId = optionalString(part.tool_call_id);
      const toolName = optionalString(part.tool_name);
      if (!callId || !toolName) {
        out.push(degradedPart(key, 'tool_use'), key);
        continue;
      }
      out.push({
        type: 'tool-call',
        callId,
        toolName,
        ...(part.input !== undefined ? { args: part.input } : {}),
      }, key);
      continue;
    }
    if (kind === 'tool_result') {
      const callId = optionalString(part.tool_call_id);
      if (!callId) {
        out.push(degradedPart(key, 'tool_result'), key);
        continue;
      }
      out.push({
        type: 'tool-result',
        callId,
        toolName: optionalString(part.tool_name) ?? '',
        ...(part.output !== undefined ? { result: part.output } : {}),
        ...(part.is_error === true ? { isError: true } : {}),
      }, key);
      continue;
    }
    if (kind === 'image' || kind === 'video') {
      // Observe has no artifact bytes to serve and must not fabricate a URL, so
      // the row records that media was present rather than dropping it silently.
      out.push({ type: 'event', name: `kimi.${kind}`, payload: { key } }, key);
      continue;
    }
    if (kind === 'file') {
      const name = optionalString(part.name);
      const mimeType = optionalString(part.media_type) ?? 'application/octet-stream';
      const size = typeof part.size === 'number' && Number.isFinite(part.size) ? part.size : undefined;
      out.push({
        type: 'file-artifact',
        path: name ?? key,
        name: name ?? key,
        mimeType,
        // The canonical upsert key for this exact artifact version. Two native
        // rows describing the same filename are different artifacts, and this is
        // where that distinction survives.
        artifactKey: key,
        ...(size !== undefined ? { size } : {}),
      }, key);
      continue;
    }
    out.push(degradedPart(key, typeof kind === 'string' ? kind : 'unknown'), key);
  }
  return rows;
}

/**
 * The degradation floor. An unrecognized (or structurally broken) content part
 * becomes a generic `event` carrying only its native kind — enough for a
 * reviewer to notice upstream drift, never enough to leak a Kimi payload shape
 * into the shared protocol.
 */
function degradedPart(key: string, nativeKind: string): AgentMessage {
  return { type: 'event', name: 'kimi.unmapped-content', payload: { key, nativeKind } };
}

/**
 * Map one page of native messages, oldest-first.
 *
 * `GET /api/v1/sessions/{id}/messages` answers NEWEST-FIRST (verified against
 * 0.35.0), while the canonical transcript is oldest-first, so the caller must
 * pass the page exactly as received and let this reverse it. Sorting by
 * `created_at` instead would reorder same-millisecond pairs — a user prompt and
 * its assistant reply routinely share a millisecond in real captures.
 */
export function mapKimiMessagePage(page: KimiMessagePage | undefined): {
  rows: KimiMappedRow[];
  hasMore: boolean;
  oldestId?: string;
} {
  const items = Array.isArray(page?.items) ? page.items : [];
  const ascending = [...items].reverse();
  const rows: KimiMappedRow[] = [];
  for (const item of ascending) rows.push(...mapKimiMessage((item ?? {}) as KimiMessage));
  const oldest = ascending[0] as KimiMessage | undefined;
  const oldestId = optionalString(oldest?.id);
  return {
    rows,
    hasMore: page?.has_more === true,
    ...(oldestId ? { oldestId } : {}),
  };
}

/**
 * Session status/usage overlay → canonical metadata the client already renders.
 *
 * The enum-shaped fields (`thinking_level`, `permission`) pass through as
 * STRINGS rather than being narrowed to the values this version happens to know:
 * a mode added upstream must reach the user as its own name, not degrade to a
 * wrong known one or drop the whole overlay. That keeps the mapping total the
 * same way the transcript mapping is.
 *
 * `busy` is deliberately NOT mapped. `SessionInfo.status` already carries
 * working/idle from the v2 activity enum, and a second liveness bit read at a
 * different moment could only contradict it.
 */
export function mapKimiSessionStatus(raw: unknown): AgentMessage[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const status = raw as Record<string, unknown>;
  const out: AgentMessage[] = [];
  const used = status.context_tokens;
  const max = status.max_context_tokens;
  if (typeof used === 'number' && Number.isFinite(used)
      && typeof max === 'number' && Number.isFinite(max) && max > 0) {
    out.push({ type: 'metadata-update', key: 'contextUsage', value: { used, max } });
  }
  const model = optionalString(status.model);
  const thinkingLevel = optionalString(status.thinking_level);
  const permissionMode = optionalString(status.permission);
  const planMode = optionalBoolean(status.plan_mode);
  const swarmMode = optionalBoolean(status.swarm_mode);
  const sessionInfo = {
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(planMode !== undefined ? { planMode } : {}),
    ...(swarmMode !== undefined ? { swarmMode } : {}),
  };
  if (Object.keys(sessionInfo).length > 0) {
    out.push({ type: 'metadata-update', key: 'sessionInfo', value: sessionInfo });
  }
  return out;
}

/** A REAL boolean only: `"true"`, 1, and null are not flags this adapter forwards. */
function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

// ── WebSocket event payloads ────────────────────────────────────────────────
//
// CASING IS NOT UNIFORM UPSTREAM and every reader below states which it needs.
// Verified against Kimi Code 0.35.0:
//   `event.session.work_changed`  snake_case  (events-zod.ts:592-598)
//   `prompt.completed`/`.aborted` camelCase   (events-zod.ts:908-919)
//   `turn.ended`                  camelCase   (events-zod.ts:681-690)
//   `event.approval.*`/`.question.*` snake_case, cast in by the broadcaster
//                                             (sessionEventBroadcaster.ts:1528-1599)
// Reading one family with the other's convention yields `undefined` silently,
// which is exactly the class of bug these comments exist to prevent.

/**
 * Bytes of `tool_input_display` a permission card may carry.
 *
 * It is an `unknown` upstream — a whole tool input, which for a write tool is
 * the entire file body. The card needs enough to decide with; 2 KiB is a long
 * shell command or a substantial diff header, and past it the row says it was
 * truncated rather than quietly presenting a prefix as the whole input.
 */
export const KIMI_APPROVAL_DETAIL_CAP_BYTES = 2 * 1024;

/**
 * Characters of a native error message that reach the transcript.
 *
 * The first line only, capped: `turn.ended` carries another product's error
 * payload, and a stack trace pasted into a chat transcript is noise, not
 * information.
 */
export const KIMI_ERROR_MESSAGE_CAP = 200;

/** The main agent's id upstream (`MAIN_AGENT_ID`); subagent frames carry their own. */
export const KIMI_MAIN_AGENT_ID = 'main';

/**
 * Derived run-state of one `event.session.work_changed` payload, or UNDEFINED
 * when the frame carries no readable run state.
 *
 * Total — it never throws — but no longer TOTAL ONTO `idle`: a non-object
 * payload is not an idle session, it is a frame this reader cannot read. See
 * {@link mapKimiRunState} for why fabricating idle is the expensive mistake.
 */
export function mapKimiWorkChanged(payload: unknown): SessionInfo['status'] | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const row = payload as { busy?: unknown; pending_interaction?: unknown };
  return mapKimiRunState(row.busy, row.pending_interaction);
}

/** First line, capped. Used for both `turn.ended.error` and the run-state repair's failure notice. */
export function boundedKimiErrorMessage(raw: unknown): string | undefined {
  const text = typeof raw === 'string'
    ? raw
    : raw && typeof raw === 'object' && typeof (raw as { message?: unknown }).message === 'string'
      ? (raw as { message: string }).message
      : undefined;
  if (text === undefined) return undefined;
  const firstLine = text.split('\n', 1)[0]!.trim();
  if (!firstLine) return undefined;
  return firstLine.length > KIMI_ERROR_MESSAGE_CAP
    ? `${firstLine.slice(0, KIMI_ERROR_MESSAGE_CAP)}…`
    : firstLine;
}

/**
 * `turn.ended` with `reason:'failed'` → the message to surface.
 *
 * `error` first, `interruptReason` as the fallback: the former is the thing
 * that went wrong, the latter only names the category. Neither present still
 * yields a message, because a failed turn that says nothing is worse than a
 * generic sentence.
 */
export function mapKimiTurnFailure(payload: unknown): string {
  const row = (payload ?? {}) as { error?: unknown; interruptReason?: unknown };
  return boundedKimiErrorMessage(row.error)
    ?? boundedKimiErrorMessage(row.interruptReason)
    ?? 'The Kimi turn failed.';
}

/**
 * The visible marker a truncated detail ends with, and part of the BUDGET
 * rather than an addition to it: a cap the suffix is then appended past is not a
 * cap. Counted in bytes below like everything else here.
 */
export const KIMI_TRUNCATION_MARKER = '\n… (truncated)';

/**
 * Cut `text` so the result — marker included — is at most `capBytes` UTF-8
 * bytes, on a CODE-POINT boundary.
 *
 * Measuring in bytes and cutting in characters is the trap this exists to
 * avoid: `slice(cap)` counts UTF-16 code units, so a CJK input under a 2 KiB
 * byte cap came back at roughly 6 KiB, and a cut landing between the two units
 * of a surrogate pair emits a lone surrogate that is not valid UTF-8 at all.
 * Iterating the string yields whole code points (a pair arrives as one
 * two-unit string), so the cut can never fall inside one, and the running byte
 * total is what the budget is spent against.
 */
function truncateToUtf8Budget(text: string, capBytes: number): string {
  const budget = capBytes - Buffer.byteLength(KIMI_TRUNCATION_MARKER, 'utf8');
  // A cap smaller than its own marker has no room to say anything; the marker
  // alone is still the honest answer, and no caller sets one that small.
  if (budget <= 0) return KIMI_TRUNCATION_MARKER;
  let bytes = 0;
  let units = 0;
  for (const codePoint of text) {
    const size = Buffer.byteLength(codePoint, 'utf8');
    if (bytes + size > budget) break;
    bytes += size;
    units += codePoint.length;
  }
  return `${text.slice(0, units)}${KIMI_TRUNCATION_MARKER}`;
}

/** Bounded, human-readable rendering of an approval's `tool_input_display`. */
export function boundedKimiToolInput(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  } catch {
    // A cyclic or unserializable input is still a fact worth stating.
    return '(this tool input could not be rendered)';
  }
  if (!text) return undefined;
  // Counted in BYTES: a length check counts UTF-16 code units and undercounts
  // every multi-byte character, which is the same trap the body reader avoids.
  if (Buffer.byteLength(text, 'utf8') <= KIMI_APPROVAL_DETAIL_CAP_BYTES) return text;
  return truncateToUtf8Budget(text, KIMI_APPROVAL_DETAIL_CAP_BYTES);
}

/** `event.approval.requested` → a canonical permission card. Undefined when the id is unusable. */
export function mapKimiApprovalRequest(
  payload: unknown,
  readOnly: boolean,
): Extract<AgentMessage, { type: 'permission-request' }> | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const row = payload as Record<string, unknown>;
  const requestId = optionalString(row.approval_id);
  if (!requestId) return undefined;
  const toolName = optionalString(row.tool_name);
  const action = optionalString(row.action);
  const detail = boundedKimiToolInput(row.tool_input_display);
  return {
    type: 'permission-request',
    requestId,
    title: toolName && action ? `${toolName} — ${action}` : toolName ?? action ?? 'Kimi needs approval',
    ...(toolName ? { toolName } : {}),
    ...(detail ? { detail } : {}),
    ...(readOnly ? { readOnly: true } : {}),
  };
}

/**
 * `event.approval.resolved` → a canonical resolution.
 *
 * `ours` is the caller's record of having resolved this exact requestId. A
 * resolution we did NOT initiate is reported as `'external'` rather than as the
 * decision the payload names: the protocol reserves that value for "settled by
 * another client of the shared owner", which is precisely what a Kimi TUI or a
 * second REST client answering the approval is.
 */
export function mapKimiApprovalResolved(
  payload: unknown,
  ours: boolean,
): Extract<AgentMessage, { type: 'permission-resolved' }> | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const row = payload as Record<string, unknown>;
  const requestId = optionalString(row.approval_id);
  if (!requestId) return undefined;
  if (!ours) return { type: 'permission-resolved', requestId, decision: 'external' };
  const sessionScoped = row.scope === 'session';
  const decision = row.decision === 'approved'
    ? (sessionScoped ? 'approve-session' as const : 'approve' as const)
    // 'rejected' and 'cancelled' both mean the tool did not run.
    : 'reject' as const;
  return { type: 'permission-resolved', requestId, decision };
}

// ── Questions ───────────────────────────────────────────────────────────────

/**
 * One question item as the SERVER named it, retained so an answer can be
 * translated back into native ids.
 *
 * The canonical `question-request` carries labels only — the protocol's answer
 * channel is `string[][]` of selected labels — so without this record there is
 * nothing to turn a label back into the `opt_<item>_<option>` id the server
 * requires. Ids are synthesized upstream (`routes/questions.ts:296-324`) and
 * are meaningless outside their own request, which is why the record is
 * per-request and bounded rather than a global table.
 */
export interface KimiQuestionItemRecord {
  /**
   * The server's own item id, or EMPTY when the payload carried none.
   *
   * Empty is never sent: it is the marker that this item cannot be keyed, and
   * {@link mapKimiQuestionAnswers} refuses the whole answer when it meets one.
   * The item still occupies its slot so the record stays index-aligned with the
   * card's `questions` array.
   */
  id: string;
  options: Array<{ id: string; label: string }>;
  multiSelect: boolean;
  allowOther: boolean;
}

export interface KimiQuestionRecord {
  questionId: string;
  items: KimiQuestionItemRecord[];
  /**
   * False when ANY item, or any option of any item, arrived without a usable
   * native id.
   *
   * Ids are read here, never minted. An answer POST is keyed entirely by them
   * (`routes/questions.ts:370-414`) and the server resolves an id it does not
   * recognize by falling back to the id STRING as the answer text — so an
   * invented `opt_0_1` is delivered to the model as the literal answer
   * "opt_0_1", and an invented item id becomes the key of a question that was
   * never asked. That is a wrong answer sent confidently, with no error and no
   * recovery, which is why an unkeyable question is refused rather than guessed.
   */
  answerable: boolean;
}

/** `event.question.requested` (and the pending-questions read) → card plus registry record. */
export function mapKimiQuestionRequest(payload: unknown, readOnly: boolean): {
  message: Extract<AgentMessage, { type: 'question-request' }>;
  record: KimiQuestionRecord;
} | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const row = payload as Record<string, unknown>;
  const requestId = optionalString(row.question_id);
  if (!requestId) return undefined;
  const rawItems = Array.isArray(row.questions) ? row.questions : [];
  const items: KimiQuestionItemRecord[] = [];
  const questions: Extract<AgentMessage, { type: 'question-request' }>['questions'] = [];
  let answerable = true;
  for (const rawItem of rawItems) {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue;
    const item = rawItem as Record<string, unknown>;
    // The id is what an answer is keyed by, and it is READ, never synthesized.
    // This server always sends one (`routes/questions.ts:299-322` builds
    // `q_<index>`/`opt_<item>_<option>` for every item and option), so a payload
    // without one is drift — and minting a replacement would key the answer to
    // an item the server cannot match. An unkeyable item still RENDERS, because
    // the user should see what is being asked; it simply cannot be answered.
    const itemId = optionalString(item.id) ?? '';
    if (!itemId) answerable = false;
    const rawOptions = Array.isArray(item.options) ? item.options : [];
    const options: Array<{ id: string; label: string }> = [];
    const cardOptions: Array<{ label: string; description?: string }> = [];
    for (const rawOption of rawOptions) {
      if (!rawOption || typeof rawOption !== 'object' || Array.isArray(rawOption)) continue;
      const option = rawOption as Record<string, unknown>;
      const label = optionalString(option.label);
      if (!label) continue;
      const optionId = optionalString(option.id) ?? '';
      if (!optionId) answerable = false;
      options.push({ id: optionId, label });
      const description = optionalString(option.description);
      cardOptions.push({ label, ...(description ? { description } : {}) });
    }
    const question = optionalString(item.question);
    if (!question) continue;
    const header = optionalString(item.header);
    items.push({
      id: itemId,
      options,
      multiSelect: item.multi_select === true,
      allowOther: item.allow_other === true,
    });
    questions.push({
      question,
      ...(header ? { header } : {}),
      options: cardOptions,
      ...(item.multi_select === true ? { multiple: true } : {}),
    });
  }
  return {
    message: {
      type: 'question-request',
      requestId,
      // Delivered either way, but an unanswerable card is marked read-only so no
      // answer can be composed from it: showing the question is useful, offering
      // controls that could only submit invented ids is not.
      ...(readOnly || !answerable ? { readOnly: true } : {}),
      questions,
    },
    record: { questionId: requestId, items, answerable },
  };
}

/** Why an answer could not be expressed in the server's own terms. Thrown BEFORE any HTTP. */
export const KIMI_UNREPRESENTABLE_ANSWER =
  'kimi cannot send this answer: the selection includes a choice that does not match any option the '
  + 'server offered, and this question does not accept free text — sending what remains would report '
  + 'a selection you did not make';

export const KIMI_UNKEYABLE_QUESTION =
  'kimi cannot answer this question: the server did not name its items or options, and cosyncing will '
  + 'not invent identifiers for a mutating call';

/**
 * A single-answer item was handed more than one answer. Thrown BEFORE any HTTP.
 *
 * The native union has no shape for it: `single` carries ONE `option_id` and
 * `other` carries ONE `text`, so every way of sending this drops part of what
 * the user chose — the first option and not the second, or the option and not
 * the free text. That is the same misattribution as the partial-multi case
 * above, and it fails the same way: silently, reporting a smaller choice as
 * though the user had made it.
 */
export const KIMI_AMBIGUOUS_SINGLE_ANSWER =
  'kimi cannot send this answer: this question takes a single answer and the selection carries '
  + 'several — sending one of them would report a choice you did not make';

/**
 * Canonical answers (selected LABELS, one array per question) → the native
 * `questionAnswerSchema` union, keyed by the server's own item ids.
 *
 * Every item gets an entry, including ones the user left alone: the server's
 * answer map is the whole response, and omitting an item would leave it
 * unanswered rather than skipped.
 *
 * THROWS rather than degrades, uniquely in this file. Everything else here maps
 * total because a drifted READ costs one odd-looking row; this is the write
 * side, where the degraded result is a wrong answer delivered to the model as
 * though the user had made it. Two cases refuse:
 *
 *  - an item (or an option it must name) with no native id — see
 *    {@link KimiQuestionRecord.answerable};
 *  - a selection containing ANY label that matches no option, on an item that
 *    forbids free text. Reporting an all-stale selection as `skipped` announces
 *    an intentional skip the user never made, and silently dropping one stale
 *    label from a partly-matched selection reports a smaller choice than the
 *    user's. A genuinely EMPTY selection is still a real skip and still maps to
 *    `skipped`;
 *  - a SINGLE-answer item handed more than one expressed value — see
 *    {@link KIMI_AMBIGUOUS_SINGLE_ANSWER}.
 */
export function mapKimiQuestionAnswers(
  record: KimiQuestionRecord,
  answers: string[][],
): Record<string, KimiQuestionAnswer> {
  if (!record.answerable) throw new Error(KIMI_UNKEYABLE_QUESTION);
  const out: Record<string, KimiQuestionAnswer> = {};
  for (const [index, item] of record.items.entries()) {
    // Re-checked per item rather than trusted from the flag alone: the flag and
    // the ids are two statements of one fact, and the one that keys the POST is
    // the one that must be proven at the point of use.
    if (!item.id) throw new Error(KIMI_UNKEYABLE_QUESTION);
    const labels = Array.isArray(answers[index]) ? answers[index]! : [];
    const matched: string[] = [];
    const free: string[] = [];
    for (const label of labels) {
      const option = item.options.find((candidate) => candidate.label === label);
      if (option) {
        if (!option.id) throw new Error(KIMI_UNKEYABLE_QUESTION);
        matched.push(option.id);
      } else free.push(label);
    }
    // Refused for ANY unmatched label on a no-free-text item, not only when
    // nothing matched: submitting the matched subset would deliver a selection
    // the user did not make, minus the choice that drifted — the same
    // misattribution as the fabricated skip, wearing a partial answer.
    if (free.length > 0 && !item.allowOther) throw new Error(KIMI_UNREPRESENTABLE_ANSWER);
    const usableFree = free;
    if (matched.length === 0 && usableFree.length === 0) {
      out[item.id] = { kind: 'skipped' };
      continue;
    }
    if (item.multiSelect) {
      out[item.id] = usableFree.length > 0
        ? { kind: 'multi_with_other', option_ids: matched, other_text: usableFree.join('\n') }
        : { kind: 'multi', option_ids: matched };
      continue;
    }
    // SINGLE-answer item. The union can carry exactly one expressed value here
    // (`single` one option id, `other` one text), so anything more has no
    // faithful encoding and is refused rather than truncated — two options, or
    // an option plus a free text on an `allow_other` item, would otherwise be
    // sent as whichever one this code happened to prefer.
    if (matched.length + usableFree.length > 1) throw new Error(KIMI_AMBIGUOUS_SINGLE_ANSWER);
    out[item.id] = matched.length > 0
      ? { kind: 'single', option_id: matched[0]! }
      : { kind: 'other', text: usableFree[0]! };
  }
  return out;
}
