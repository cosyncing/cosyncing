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
import {
  boundContextBody,
  boundToolSemantic,
  commandSemantic,
  CONTEXT_INJECTION_EVENT,
  fileReadSemantic,
  searchGroup,
  searchSemantic,
  unwrapContextBlock,
} from '@cosyncing/adapter-api';
import type {
  AgentMessage,
  ContextInjectionPayload,
  ModelOption,
  SessionControlState,
  SessionInfo,
  ToolDisplayClass,
  ToolSearchGroup,
  ToolSemantic,
} from '@cosyncing/adapter-api';
import type { KimiQuestionAnswer } from './drive-http.ts';
import { basename } from 'node:path';

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
 * The ready-to-paste terminal command that rejoins a session: `kimi -S <id>`
 * is confirmed upstream (`-S, --session [id]`) and resolves the workspace from
 * the session's own index entry, so it is NOT cwd-scoped — the `cd` only
 * decides where the user's shell lands.
 */
export function kimiResumeTerminalCommand(sessionId: string, cwd?: string): string {
  const cd = cwd ? `cd ${kimiShellQuote(cwd)} && ` : '';
  return `${cd}kimi -S ${kimiShellQuote(sessionId)}`;
}

/** Codex-style: unquoted when every character is safe, single-quoted otherwise. */
function kimiShellQuote(value: string): string {
  return /^[A-Za-z0-9_/:=.,@%+\-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The roster/connection control state of a session cosyncing created and still
 * owns.
 *
 * `drive {supported:true, state:'driving'}` is the roster-level claim OpenCode
 * makes for every session its shared server lists: attaching IS driving,
 * because the server is the single writer and we are talking to it. It is also
 * what `sessionConnectionAuthority` reads to grant `canMutate`, and what routes
 * `createdSessionAttachMode` to a bare attach.
 *
 * The `terminalSync.command` is the status sheet's resume-in-terminal hint, in
 * the same generic shape Claude publishes: sync itself stays `supported:false`
 * (driving happens THROUGH the server, so there is no cosyncing bridge to make
 * active), but a terminal CAN take the session over, and `handoffAvailable`
 * already declared above is what makes showing the command while driving safe.
 * Only the DRIVING state carries it — a foreign session may have a live
 * terminal owner this adapter cannot see, and an owned session opened in
 * observe is not being handed off from here.
 */
export function kimiOwnedControlState(sessionId: string, cwd?: string): SessionControlState {
  return {
    // Declared rather than left to be inferred from `attachModes`: kimi serves
    // a genuine read-only observe connection, so handing Drive back leaves the
    // session attached and watchable instead of stranded — and the adapter
    // revokes its own Drive eligibility as part of that handoff, so the app
    // does not get the control offered straight back.
    drive: { supported: true, state: 'driving', handoffAvailable: true },
    terminalSync: {
      supported: false,
      syncAvailable: false,
      active: false,
      label: 'Resume in terminal',
      command: kimiResumeTerminalCommand(sessionId, cwd),
      reason: KIMI_OWNED_TERMINAL_SYNC_REASON,
    },
  };
}

/** The control state of a session this process did not create. Fail-closed: observe only. */
export function kimiForeignControlState(): SessionControlState {
  return {
    // `supported: false` is unchanged and still means what it says: cosyncing
    // will not drive this session on its own, because it cannot prove no
    // terminal is writing it. `takeoverAvailable` is the other half of that
    // sentence — the user CAN authorize it explicitly, and that authorization
    // is exactly what turns the unprovable into a decision they made. Without
    // it the takeover control would be unreachable on the only sessions that
    // need it, since `supported && observing` is false here by design.
    //
    // `live` because a Kimi takeover attaches to the running server session;
    // there is no cosyncing-owned process to `resume` into.
    //
    // Advertised unconditionally. It used to ride a rollout flag, which meant
    // the row's honesty depended on a caller remembering to thread it; the
    // adapter's own ownership and safety checks are what decide whether a
    // takeover actually proceeds, and they answer the same way for every
    // caller.
    drive: {
      state: 'observing',
      supported: false,
      reason: KIMI_FOREIGN_DRIVE_REASON,
      takeoverAvailable: true,
      takeoverMode: 'live' as const,
    },
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
    // `unavailable` stays, and so does `supported: false`: this generation is
    // finished and nothing reattaching to it can drive. Re-takeover is still
    // legitimate, but only as a FRESH user confirmation opening a fresh
    // generation — which is why it has to be declared explicitly here. The
    // `takeoverAvailable ?? (supported && observing)` fallback can never fire
    // on `unavailable`, so without these two fields a demoted session would be
    // permanently unrecoverable through the UI.
    drive: {
      supported: false,
      state: 'unavailable',
      reason: KIMI_FOREIGN_WRITER_REASON,
      takeoverAvailable: true,
      takeoverMode: 'live',
    },
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

/**
 * Kimi's own statement of where a row came from — `metadata.origin`, kept
 * WHOLE rather than reduced to its kind, because the kind alone does not serve
 * every reader: the injection rule needs only the kind, while splitting a
 * skill-activation row takes the `skillName`/`skillArgs` the origin also
 * carries (upstream `contextMemory/types.ts:14-22`), and the divergence
 * detector in `drive.ts` reads the kind off {@link KimiMappedRow.originKind}.
 *
 * Observed on a live 0.36.1 server: `injection` for harness-handed context,
 * `user` for a person typing, `cron_job` for a schedule firing a real prompt.
 * Only Kimi can say which — the TEXT cannot, because a person may legitimately
 * paste or quote a whole wrapper block and that is still them writing.
 *
 * Absent or malformed reads as no origin, which keeps the message whole. That
 * is the safe direction: showing a wrapper verbatim is untidy, folding
 * someone's own words into a collapsed disclosure loses them.
 */
function kimiOrigin(metadata: unknown): Record<string, unknown> | undefined {
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const origin = (metadata as { origin?: unknown }).origin;
  if (typeof origin !== 'object' || origin === null || Array.isArray(origin)) return undefined;
  return origin as Record<string, unknown>;
}

function kimiOriginKind(metadata: unknown): string | undefined {
  const kind = kimiOrigin(metadata)?.kind;
  return typeof kind === 'string' ? kind : undefined;
}

/**
 * The slash action a skill/plugin activation row stands for, built from the
 * ORIGIN rather than the text — upstream derives the session's own title the
 * same way (`promptMetadataTextFromSkill` /
 * `promptMetadataTextFromPluginCommand`), so this shows what the user DID
 * (`/name args`) without parsing prose out of the loaded body.
 *
 * Undefined when the origin carries no name, which is the caller's signal to
 * leave the row whole: an activation that cannot be named cannot be split
 * without hiding the material behind an action this adapter invented.
 */
function activationActionText(origin: Record<string, unknown>, kind: string): string | undefined {
  // Upstream trims the args before rendering them; a whitespace-only args is
  // no args.
  const withArgs = (command: string, rawArgs: unknown): string => {
    const args = typeof rawArgs === 'string' ? rawArgs.trim() : '';
    return args ? `${command} ${args}` : command;
  };
  if (kind === 'skill_activation') {
    const name = optionalString(origin.skillName);
    return name ? withArgs(`/${name}`, origin.skillArgs) : undefined;
  }
  if (kind === 'plugin_command') {
    const command = optionalString(origin.commandName);
    if (!command) return undefined;
    const plugin = optionalString(origin.pluginId);
    return withArgs(plugin ? `/${plugin}:${command}` : `/${command}`, origin.commandArgs);
  }
  return undefined;
}

/**
 * Parse the `<skill-loaded name="…" …>…</skill-loaded>` envelope KIMI-SIDE.
 *
 * The shared `unwrapContextBlock` cannot: it accepts no attributes on the tag
 * and no prose ahead of it, and upstream's activation text has both — a
 * boilerplate lead-in line, then the attributed envelope
 * (`agent/skill/prompt.ts:renderUserSlashSkillPrompt`). Strict in the same
 * spirit, though: the block must CLOSE the message, so an activation whose
 * text merely contains the envelope is not unwrapped here. Whatever prose led
 * the envelope in is kept ahead of the body rather than dropped — nothing the
 * server sent is silently erased.
 */
function unwrapSkillLoadedBlock(text: string): { source: string; body: string } | undefined {
  const match = /^([\s\S]*?)<skill-loaded(?:\s[^>]*)?>([\s\S]*?)<\/skill-loaded>\s*$/i.exec(text.trim());
  if (!match) return undefined;
  const prose = (match[1] ?? '').trim();
  const body = (match[2] ?? '').trim();
  if (!body) return undefined;
  return { source: 'skill-loaded', body: prose ? `${prose}\n\n${body}` : body };
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
 * The human-readable title for a session the host never named: the codex/pi
 * shape `basename(cwd) · id[0:8]`, never the raw `session_<uuid>` id. The
 * client's header suppresses titles equal to the session id, so mapping an
 * untitled row AS its id renders "Untitled session" there while the roster
 * shows the raw id — one session, two names. With no cwd there is nothing
 * better than the id, and the id is returned so the two surfaces at least
 * agree.
 */
export function kimiFallbackTitle(id: string, cwd?: string): string {
  return cwd ? `${basename(cwd)} · ${id.slice(0, 8)}` : id;
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
export function mapKimiSession(
  raw: KimiV2Session,
  isOwned?: KimiOwnershipPredicate,
): SessionInfo | undefined {
  const id = optionalString(raw?.id);
  if (!id) return undefined;
  const meta = raw.meta ?? {};
  const cwd = optionalString(raw.workspace?.cwd);
  const title = optionalString(meta.title) ?? optionalString(meta.last_prompt) ?? kimiFallbackTitle(id, cwd);
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
    control: owned ? kimiOwnedControlState(id, cwd) : kimiForeignControlState(),
  };
}

export function mapKimiSessionPage(
  page: KimiV2SessionPage | undefined,
  isOwned?: KimiOwnershipPredicate,
): {
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
    title: optionalString(raw.title) ?? optionalString(raw.last_prompt) ?? kimiFallbackTitle(id, cwd),
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
    control: kimiOwnedControlState(id, cwd),
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

/**
 * The catalog rows a `/status` reading is joined against, read ONCE per
 * connection and re-read once per alias the cache does not know.
 *
 * A cache rather than a per-status read because `/status` is polled every 10 s
 * and the catalog is a per-HOST constant; a cache that never re-reads because a
 * host can add a model mid-life, which would otherwise leave that session
 * label-less until the next attach. The re-read is spent PER ALIAS, so a host
 * reporting an alias its own catalog omits costs one extra request, not one per
 * poll.
 *
 * Holds no transport: the read is supplied by the caller, because the attach
 * path reads through the adapter's verified client and the connection reads
 * through its own generation (which reverification can replace under it).
 */
export class KimiModelCatalogCache {
  private options: readonly ModelOption[] = [];
  private read = false;
  private readonly reReadAliases = new Set<string>();
  /** Bound on the re-read memory; a host reporting endless novel aliases costs a set, not a leak. */
  private static readonly RE_READ_LIMIT = 64;

  /**
   * Catalog rows to join `modelID` against. Never throws and never fails an
   * attach: a refused or odd read yields the rows already held (possibly none),
   * which the join then simply does not match.
   */
  async optionsFor(
    modelID: string | undefined,
    read: () => Promise<ModelOption[]>,
  ): Promise<readonly ModelOption[]> {
    if (modelID === undefined) return this.options;
    if (!this.read) {
      this.read = true;
      this.options = await read();
    }
    if (this.options.some((option) => option.modelID === modelID)) return this.options;
    if (this.reReadAliases.has(modelID)) return this.options;
    this.reReadAliases.add(modelID);
    if (this.reReadAliases.size > KimiModelCatalogCache.RE_READ_LIMIT) {
      for (const oldest of this.reReadAliases) {
        this.reReadAliases.delete(oldest);
        if (this.reReadAliases.size <= KimiModelCatalogCache.RE_READ_LIMIT) break;
      }
    }
    const fresh = await read();
    // A failed re-read answers `[]`; keeping what we had is strictly better
    // than forgetting a catalog because one request was refused.
    if (fresh.length > 0) this.options = fresh;
    return this.options;
  }
}

/** The alias a `/status` body reports, so a caller can prime the catalog before mapping it. */
export function kimiStatusModel(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return optionalString((raw as Record<string, unknown>).model);
}

// ── Messages ────────────────────────────────────────────────────────────────

/** Stable dedupe/merge key for one native message part. */
function partKey(messageId: string, index: number): string {
  return `kimi:${messageId}:${index}`;
}

/**
 * Key of the user row an ATTACHMENT-ONLY prompt gets, which no content part
 * produced. `u` where {@link partKey} puts an index, so it can never collide
 * with a part's key, and it is derived from the message id alone so a history
 * fold and a live walk mint the same one.
 */
function attachmentOnlyUserKey(messageId: string): string {
  return `kimi:${messageId}:u`;
}

/**
 * Longest inline `data:` URI an echoed image row may carry, URL characters
 * included. Mirrors claude's `ARTIFACT_INLINE_CAP` (5_000_000, the broker's
 * emitArtifact ceiling) with the base64 inflation already inside the figure.
 */
const KIMI_INLINE_IMAGE_DATA_URL_CAP = 7_000_000;

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
  /**
   * Kimi's own provenance for this row — `metadata.origin.kind`, verbatim.
   *
   * One plumbing, two readers: the mapper splits `skill_activation` /
   * `plugin_command` rows on it, and the divergence detector (`drive.ts`)
   * suspects ONLY a row whose kind is `'user'` or whose origin is ABSENT —
   * every harness kind (`injection`, `skill_activation`, `cron_job`, …) is the
   * server writing to its own session, never a foreign prompt. Absent stays
   * suspect because an older server sends no origin at all, and a real
   * terminal prompt carries kind `'user'` (`USER_PROMPT_ORIGIN` upstream).
   */
  originKind?: string;
}

/**
 * Per-connection correlation state for the message fold.
 *
 * Two correlations cannot be done inside one native message: a TodoList RESULT
 * carries no tool name on the REST fold (only `tool_call_id`), so suppressing
 * the panel's acknowledgment echo needs the set of TodoList call ids the fold
 * has seen; and a background task's settlement notification names the TASK id,
 * which is linked to the originating tool call only by the `task_id:` line that
 * opens the spawn result's output. Both are recorded here as the fold walks
 * rows oldest-first.
 *
 * This is CONNECTION state, never module state: task and call ids are
 * session-scoped, so two connections must never resolve each other's, and a
 * fresh attach re-derives both from its own history walk. Callers that fold a
 * single message in isolation omit it; every correlation then degrades to its
 * documented fallback (the result renders; the notification becomes a notice;
 * no subagent bar is opened).
 */
export interface KimiMappingState {
  /** Every tool_use's callId → toolName, so a correlated row can name its tool. */
  readonly toolNames: Map<string, string>;
  /**
   * Call id → the bounded facts that call published (see
   * {@link KimiToolCallFacts}).
   *
   * The REST fold gives a RESULT part its output and nothing else — the path it
   * read, the command it ran and the pattern it searched for live on the CALL —
   * so this is the only way a result row can carry a canonical `path` or a
   * completed semantic. Without it (a caller folding one message in isolation,
   * or a pair straddling a page boundary) the result degrades to an unstamped
   * row, which renders exactly as it did before any of this existed.
   */
  readonly toolCallFacts: Map<string, KimiToolCallFacts>;
  /** Call ids of TodoList calls THAT EMITTED the panel, so only their results are suppressed. */
  readonly todoListCallIds: Set<string>;
  /** Background task id → the callId of the tool call that spawned it. */
  readonly backgroundTasks: Map<string, string>;
  /** Call id → an open subagent bar; set by the Agent call, consumed by its result or settlement. */
  readonly agentActivities: Map<string, KimiPendingAgentActivity>;
  /**
   * Call ids of tool_results folded BEFORE their calls. The incremental walk
   * folds pages newest-first, so a call/result pair straddling a page boundary
   * meets its result first; an Agent call whose result already passed must NOT
   * open a bar, because nothing will ever close it. Bounded; see
   * {@link rememberBounded}.
   */
  readonly orphanedResultCallIds: Set<string>;
  /**
   * Task ids whose settlement notification folded BEFORE the spawn result that
   * would have opened their bar (the same newest-first straddle, one hop
   * longer). A spawn result for an already-settled task must not open a bar
   * that can never close. Bounded; see {@link rememberBounded}.
   */
  readonly settledTaskIds: Set<string>;
}

export function createKimiMappingState(): KimiMappingState {
  return {
    toolNames: new Map(),
    toolCallFacts: new Map(),
    todoListCallIds: new Set(),
    backgroundTasks: new Map(),
    agentActivities: new Map(),
    orphanedResultCallIds: new Set(),
    settledTaskIds: new Set(),
  };
}

/**
 * Bounded insertion-ordered set memory (the same oldest-first eviction
 * `KimiWireTail.admit` uses), so a long-lived connection's correlation guards
 * cannot grow without limit. Eviction costs a guard its memory — a straddled
 * pair then degrades to the no-bar direction, which is the safe one.
 */
const KIMI_GUARD_SET_LIMIT = 1_024;

function rememberBounded(set: Set<string>, value: string): void {
  if (set.has(value)) return;
  set.add(value);
  if (set.size <= KIMI_GUARD_SET_LIMIT) return;
  for (const oldest of set) {
    set.delete(oldest);
    if (set.size <= KIMI_GUARD_SET_LIMIT) break;
  }
}

/** Kimi's todo tool, registered upstream as `{ name: 'TodoList', domain: 'todo' }`. */
const KIMI_TODO_LIST_TOOL = 'TodoList';

/**
 * A TodoList tool_use → the canonical `task-list-state` panel (ONE upserted
 * ledger, not a stack of raw tool cards), or UNDEFINED when the call is not a
 * well-formed write — including `{}`, which upstream defines as a QUERY that
 * changes nothing (`agent/tools/todo-list/todo-list.ts`). Absent `todos` must
 * leave the panel alone; only an explicit empty list clears it; a NONEMPTY
 * list whose items are all unusable is drift, not a clear, and falls through
 * too. Undefined is the caller's signal to fall through to a normal tool-call
 * row, the same null-return rule as claude's `todoListState`.
 */
function kimiTodoListState(
  input: unknown,
): Extract<AgentMessage, { type: 'task-list-state' }> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const rawTodos = (input as { todos?: unknown }).todos;
  if (!Array.isArray(rawTodos)) return undefined;
  const items: Array<{ title: string; status: 'open' | 'in-progress' | 'done' }> = [];
  for (const raw of rawTodos) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const rawTitle = (raw as { title?: unknown }).title;
    const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
    if (!title) continue;
    const status = (raw as { status?: unknown }).status;
    // Kimi's enum is closed — pending | in_progress | done — so nothing maps to
    // `cancelled`, and an unknown value degrades to `open` rather than dropping
    // the item or the panel.
    items.push({
      title,
      status: status === 'done' ? 'done' : status === 'in_progress' ? 'in-progress' : 'open',
    });
  }
  // A NONEMPTY list that produced ZERO usable items is not a clear: the input
  // was unreadable, and the malformed-falls-through rule governs — degrade to a
  // plain tool card and leave the panel alone. Only an explicit EMPTY list
  // clears; conflating the two would wipe the panel on drifted input.
  if (rawTodos.length > 0 && items.length === 0) return undefined;
  const allDone = items.length > 0 && items.every((item) => item.status === 'done');
  return {
    type: 'task-list-state',
    key: 'kimi:todos',
    title: 'Tasks',
    status: items.length === 0 ? 'cleared' : allDone ? 'done' : 'running',
    source: 'tool-call',
    sourceTool: KIMI_TODO_LIST_TOOL,
    items,
  };
}

// ── Subagent activity (the `Agent` tool) ────────────────────────────────────

/**
 * Kimi's subagent spawn tool — the ONLY tool that produces an `agent-N` child,
 * verified against a parent journal's full tool-call histogram. Args: `prompt`
 * and `description` always; `subagent_type` usually; `run_in_background` only
 * on detached spawns.
 */
const KIMI_AGENT_SPAWN_TOOL = 'Agent';

/**
 * One subagent run in flight, opened by the Agent tool_use and closed by its
 * tool_result (foreground) or its settlement notification (detached). Same
 * shape dsh's `DshPendingAgentActivity` produces; the client upserts by
 * {@link key}.
 */
export interface KimiPendingAgentActivity {
  /** `agent:<callId>` — keyed on the PARENT's toolCallId, the only pre-spawn handle. */
  key: string;
  title: string;
  subtitle?: string;
  /** The call message's `created_at`; the terminal bar's elapsed is measured from it. */
  startedAt?: number;
  /**
   * A DETACHED spawn (`run_in_background: true`): the call/result pair does not
   * bracket the run — the result returns immediately — so the running bar opens
   * only when the spawn result confirms a task id, and closes at the settlement
   * notification.
   */
  detached: boolean;
  /** Detached only: the running bar has actually been emitted (at the spawn result). */
  opened: boolean;
}

/**
 * An Agent tool_use → the bar it opens, or UNDEFINED when the input is not a
 * readable spawn. The child id is runtime-assigned and NEVER in the call, and
 * the title is parent-side only (`args.description` — child journals carry no
 * title), so the bar keys on the parent's toolCallId and takes its title from
 * the call. Foreground and detached spawns both produce a pending entry; the
 * caller decides when each emits.
 */
function kimiAgentActivityFromCall(
  input: unknown,
  callId: string,
  startedAt: number | undefined,
): KimiPendingAgentActivity | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const args = input as Record<string, unknown>;
  const prompt = optionalString(args.prompt);
  const firstPromptLine = prompt?.split('\n').find((line) => line.trim())?.trim();
  return {
    key: `agent:${callId}`,
    title: optionalString(args.description) ?? firstPromptLine ?? 'Subagent task',
    ...(optionalString(args.subagent_type) ? { subtitle: optionalString(args.subagent_type) } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    detached: args.run_in_background === true,
    opened: false,
  };
}

/** One canonical `agent-activity` emission for a pending subagent run. */
function kimiAgentActivityMessage(
  pending: KimiPendingAgentActivity,
  status: 'running' | 'done' | 'error',
  elapsedMs?: number,
): AgentMessage {
  return {
    type: 'agent-activity',
    key: pending.key,
    kind: 'subagent',
    title: pending.title,
    ...(pending.subtitle ? { subtitle: pending.subtitle } : {}),
    status,
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    ...(status === 'running' && pending.startedAt !== undefined ? { startedAtMs: pending.startedAt } : {}),
    agentsDone: status === 'running' ? 0 : 1,
    agentsTotal: 1,
  };
}

/** Elapsed between two message timestamps, or nothing: an unusable or reversed endpoint is dropped, never zeroed. */
function kimiElapsedMs(startedAt: number | undefined, endedAt: number | undefined): number | undefined {
  return startedAt !== undefined && endedAt !== undefined && endedAt >= startedAt
    ? endedAt - startedAt
    : undefined;
}

/** The parsed contents of a `<notification …>` task-settlement envelope. */
interface KimiTaskNotification {
  type?: string;
  severity?: string;
  title?: string;
  body: string;
  outputFile?: string;
}

function unescapeXmlAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Parse the `<notification …>` envelope KIMI-SIDE, in the same spirit as
 * {@link unwrapSkillLoadedBlock}: the shared `unwrapContextBlock` cannot take
 * it — five tag attributes, `Title:`/`Severity:` prose lines ahead of the body,
 * and a nested `<output-file>`/`<output-preview>` child all defeat it
 * (upstream `agent/task/notificationXml.ts`). Strict the same way too: the
 * envelope must be the WHOLE text, so a message that merely quotes one is not
 * unwrapped here.
 */
function parseKimiTaskNotification(text: string): KimiTaskNotification | undefined {
  const match = /^<notification((?:\s+[a-zA-Z_-]+="[^"]*")*)\s*>([\s\S]*?)<\/notification>\s*$/.exec(text.trim());
  if (!match) return undefined;
  const attrs = match[1] ?? '';
  let inner = (match[2] ?? '').trim();
  const fileTag = /<output-file\b[^>]*>/.exec(inner)?.[0];
  const outputFile = fileTag ? /\bpath="([^"]*)"/.exec(fileTag)?.[1] : undefined;
  inner = inner
    .replace(/<output-file\b[\s\S]*?<\/output-file>/g, '')
    .replace(/<output-preview\b[\s\S]*?<\/output-preview>/g, '')
    .trim();
  let title: string | undefined;
  let severity: string | undefined;
  const bodyLines: string[] = [];
  for (const line of inner.split('\n')) {
    if (title === undefined && line.startsWith('Title: ')) {
      title = line.slice('Title: '.length).trim();
    } else if (severity === undefined && line.startsWith('Severity: ')) {
      severity = line.slice('Severity: '.length).trim();
    } else {
      bodyLines.push(line);
    }
  }
  const body = bodyLines.join('\n').trim();
  if (!title && !body) return undefined;
  const type = /\btype="([^"]*)"/.exec(attrs)?.[1];
  return {
    ...(type ? { type } : {}),
    ...(severity ? { severity } : {}),
    ...(title ? { title } : {}),
    body,
    ...(outputFile ? { outputFile: unescapeXmlAttr(outputFile) } : {}),
  };
}

/**
 * A detached background task's settlement row → its canonical rows.
 *
 * The row is the completion of a background call the user watched start, so
 * when the spawn result's `task_id:` line resolved the correlation it IS that
 * call's deferred `tool-result`. When it cannot resolve — a task started before
 * this attach, a reattach, an unparseable spawn result — it is a `notice`
 * carrying the severity, title, body, and task id. Failures stay visible either
 * way (`isError` on the fold, a severity tag on the notice); neither path is
 * ever a user-message, because the origin already says the server wrote it. An
 * envelope that will not parse degrades to a notice of the raw text: visible,
 * but never attributed to the operator.
 *
 * The settlement of a detached AGENT task is also the close of its subagent bar
 * (issues 11 and 13 are the same wire event for a detached spawn): when the
 * correlation lands on a call whose bar is open, a terminal `agent-activity`
 * row rides alongside the deferred tool-result. An UNRESOLVED settlement is
 * recorded in `state.settledTaskIds`, so a spawn result folding after it — a
 * multi-page catch-up walk folds pages newest-first — cannot open a bar that
 * nothing will ever close.
 */
function kimiTaskNotificationMessage(
  text: string,
  origin: Record<string, unknown> | undefined,
  state: KimiMappingState | undefined,
  sentAt: number | undefined,
): AgentMessage[] {
  const parsed = parseKimiTaskNotification(text);
  if (!parsed) return [{ type: 'notice', message: text }];
  const taskId = optionalString(origin?.taskId);
  const status = optionalString(origin?.status);
  const failed = parsed.severity === 'warning'
    || parsed.type === 'task.failed'
    || (status !== undefined && status !== 'completed');
  const callId = taskId ? state?.backgroundTasks.get(taskId) : undefined;
  if (state && taskId && !callId) rememberBounded(state.settledTaskIds, taskId);
  const headline = [parsed.title, parsed.body].filter((line): line is string => !!line);
  const rows: AgentMessage[] = [];
  if (callId) {
    const lines = [...headline];
    if (parsed.outputFile) lines.push(`Full output: ${parsed.outputFile}`);
    rows.push({
      type: 'tool-result',
      callId,
      toolName: state?.toolNames.get(callId) ?? '',
      result: lines.join('\n'),
      ...(failed ? { isError: true } : {}),
    });
    const pending = state?.agentActivities.get(callId);
    if (pending?.detached && pending.opened) {
      state?.agentActivities.delete(callId);
      rows.push(kimiAgentActivityMessage(pending, failed ? 'error' : 'done', kimiElapsedMs(pending.startedAt, sentAt)));
    }
    return rows;
  }
  const refs = [
    taskId ? `task ${taskId}` : undefined,
    parsed.outputFile ? `output: ${parsed.outputFile}` : undefined,
  ].filter((ref): ref is string => !!ref);
  const severityTag = parsed.severity && parsed.severity !== 'info' ? `[${parsed.severity}] ` : '';
  rows.push({
    type: 'notice',
    message: `${severityTag}${headline.join(' — ') || 'Background task notification'}`
      + `${refs.length > 0 ? ` (${refs.join(', ')})` : ''}`,
  });
  return rows;
}

// ── Tool rows: display class, semantics, and the paths they carry ───────────
//
// PROVENANCE. Everything in this section is keyed on Kimi's own registered tool
// names and argument keys, MEASURED on 2026-08-23 over this host's Kimi Code
// journals (`~/.kimi-code/sessions/*/*/agents/*/wire.jsonl`, 112 journals,
// ~10.7k `tool.call` events; the same journal source that fixed `TodoList` and
// `Agent` above). Argument keys per tool, with observed counts:
//
//   Read            path (2357), line_offset, n_lines
//   ReadMediaFile   path (588), region
//   Write           path + content (351), mode
//   Edit            path + old_string + new_string (1929), replace_all
//   Bash            command (3193), cwd, timeout, description, run_in_background
//   Grep            pattern + path + output_mode (1436), -n/-i/-A/-B/-C, head_limit
//   Glob            pattern (44), path
//   TodoList        todos    Agent  description/prompt/subagent_type/run_in_background
//   WebSearch       query    FetchURL  url    Task*/Cron*/Skill/GetGoal  (no path)
//
// The REST fold this mapper reads projects a call as `{tool_call_id, tool_name,
// input}` with NO host-computed display payload (the journal's `display` object
// stays server-side), so `tool_name` + `input` is the whole evidence base. A
// name this table does not know is stamped with nothing at all — the client's
// conservative fallback is the honest answer for a tool we have not measured.
//
// THE GREP TRAP, preserved deliberately: Grep/Glob's `path` argument is a
// SEARCH SCOPE DIRECTORY, not a file. It rides `ToolSearchSemantic.scope`, and
// it must never become a group path or a `tool-result.path`, or every grep in
// the transcript becomes a bogus file link.

/**
 * Kimi's measured tool surface → the canonical display class.
 *
 * A closed table, not a name heuristic: these are the tools the harness
 * registers, and an unmeasured name (an MCP tool, a plugin, a later release)
 * gets NO class rather than a guessed one.
 */
const KIMI_TOOL_CLASSES: ReadonlyMap<string, ToolDisplayClass> = new Map([
  ['Bash', 'execute'],
  [KIMI_AGENT_SPAWN_TOOL, 'execute'],
  ['Edit', 'edit'],
  ['Write', 'edit'],
  ['Read', 'lookup'],
  ['ReadMediaFile', 'lookup'],
  ['Grep', 'lookup'],
  ['Glob', 'lookup'],
  ['WebSearch', 'lookup'],
  ['FetchURL', 'lookup'],
  ['TaskList', 'lookup'],
  ['TaskOutput', 'lookup'],
  ['CronList', 'lookup'],
  ['GetGoal', 'lookup'],
  ['Skill', 'other'],
  ['TaskStop', 'other'],
  ['CronCreate', 'other'],
  ['CronDelete', 'other'],
  [KIMI_TODO_LIST_TOOL, 'other'],
]);

/** The measured display class for a Kimi tool, or UNDEFINED for a name this version has not seen. */
export function kimiToolDisplayClass(toolName: string | undefined): ToolDisplayClass | undefined {
  return toolName === undefined ? undefined : KIMI_TOOL_CLASSES.get(toolName);
}

/**
 * What one tool CALL published that its RESULT row needs.
 *
 * Only the derived, bounded fields are kept — never the raw input. A `Write`
 * input carries an entire file body, and retaining one per in-flight call for
 * the life of a connection is a memory leak with a file in it.
 */
export interface KimiToolCallFacts {
  toolName: string;
  /** The file the tool acted on — Read/ReadMediaFile/Edit/Write only. NEVER a search scope. */
  path?: string;
  command?: string;
  cwd?: string;
  /** Grep/Glob `pattern`. */
  query?: string;
  /** Grep/Glob `path` — a scope DIRECTORY (see the trap above). */
  scope?: string;
  /** Grep `output_mode`; it decides which shape the result output is parsed as. */
  searchMode?: string;
}
// `Read`'s `line_offset` is deliberately NOT recorded here: the read's start
// line comes from the first number in its own output, which is what the server
// actually served (it may clamp the request). A second copy of that fact would
// be the one that drifts.

/** The bounded facts one tool call publishes, read from its declared argument keys. */
function kimiToolCallFacts(toolName: string, input: unknown): KimiToolCallFacts {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { toolName };
  const args = input as Record<string, unknown>;
  switch (toolName) {
    case 'Read':
    case 'ReadMediaFile':
    case 'Edit':
    case 'Write':
      return {
        toolName,
        ...(optionalString(args.path) ? { path: optionalString(args.path)! } : {}),
      };
    case 'Bash':
      return {
        toolName,
        ...(optionalString(args.command) ? { command: optionalString(args.command)! } : {}),
        ...(optionalString(args.cwd) ? { cwd: optionalString(args.cwd)! } : {}),
      };
    case 'Grep':
    case 'Glob':
      return {
        toolName,
        ...(optionalString(args.pattern) ? { query: optionalString(args.pattern)! } : {}),
        // `path` is the SCOPE, and the only place it may land.
        ...(optionalString(args.path) ? { scope: optionalString(args.path)! } : {}),
        ...(optionalString(args.output_mode) ? { searchMode: optionalString(args.output_mode)! } : {}),
      };
    default:
      return { toolName };
  }
}

/**
 * Bounded insertion-ordered map memory, the {@link rememberBounded} rule for a
 * call→facts record. Eviction costs a long-lived connection the oldest call's
 * facts, and its result then degrades to an unstamped row — the same safe
 * direction every other guard here takes.
 */
function rememberBoundedFacts(
  map: Map<string, KimiToolCallFacts>,
  key: string,
  value: KimiToolCallFacts,
): void {
  map.set(key, value);
  if (map.size <= KIMI_GUARD_SET_LIMIT) return;
  for (const oldest of map.keys()) {
    map.delete(oldest);
    if (map.size <= KIMI_GUARD_SET_LIMIT) break;
  }
}

/**
 * `Read` output → the preview the canonical file-read semantic wants.
 *
 * Kimi numbers every line as `<1-based number>\t<text>` (2329 of 2357 recorded
 * reads; the rest are whole-output notices such as the 50 000-character
 * ceiling). The FIRST NUMBER is the authoritative start — `line_offset` is what
 * was asked for and the server may clamp it — and the prefixes are stripped
 * here because the client draws its own gutter from `startLine`.
 *
 * STRICT ON PURPOSE: one unnumbered line and this returns undefined, which
 * leaves the row on the generic fallback with its output intact. Claiming a
 * file-read presentation the preview cannot fill would HIDE the very output the
 * user is reading, so a partial parse is worse than none.
 */
function kimiReadPreview(output: unknown): { startLine: number; preview: string } | undefined {
  if (typeof output !== 'string' || !output) return undefined;
  const lines = output.split('\n');
  // A trailing newline yields one empty tail element; it is the terminator, not
  // a line that failed to parse.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const texts: string[] = [];
  let startLine: number | undefined;
  for (const line of lines) {
    const match = /^(\d+)\t/.exec(line);
    if (!match) return undefined;
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number) || number <= 0) return undefined;
    if (startLine === undefined) startLine = number;
    texts.push(line.slice(match[0].length));
  }
  if (startLine === undefined) return undefined;
  return { startLine, preview: texts.join('\n') };
}

/**
 * The tail line Kimi appends when it clipped a search: it reports the TOTAL, so
 * the count survives even though the rows did not.
 */
const KIMI_SEARCH_TRUNCATION = /^Results truncated to \d+ lines \(total: (\d+)\)\./;

/** `Grep -n` / default content row: `path:line:text`. Paths carrying a colon simply fail the parse. */
const KIMI_GREP_MATCH_LINE = /^([^\s:]+):(\d+):(.*)$/;
/** A `-A`/`-B`/`-C` context row: `path-line-text`. Recognized so it cannot fail the strict parse, never counted as a match. */
const KIMI_GREP_CONTEXT_LINE = /^([^\s:]+)-(\d+)-/;

interface KimiParsedSearch {
  groups: ToolSearchGroup[];
  matchCount?: number;
  fileCount?: number;
  truncated: boolean;
}

/**
 * `Grep`/`Glob` output → bounded search groups, or UNDEFINED when the output is
 * not the shape the call's `output_mode` declares.
 *
 * Two shapes, chosen by the CALL rather than by sniffing: `content` emits
 * `path:line:text` rows, everything path-listing (`files_with_matches`, `Glob`)
 * emits one path per line. `count_matches` and any later mode parse as neither
 * and keep the raw output.
 *
 * Strict for the same reason {@link kimiReadPreview} is: Kimi's zero-result
 * answer is the sentence "No non-sensitive matches found" — a real distinction
 * (it filters sensitive files) that an empty search card would erase — and it
 * fails both shapes, so it stays visible as itself.
 */
function kimiSearchResult(output: unknown, searchMode: string | undefined): KimiParsedSearch | undefined {
  if (typeof output !== 'string' || !output.trim()) return undefined;
  const contentMode = searchMode === 'content';
  if (!contentMode && searchMode !== undefined && searchMode !== 'files_with_matches') return undefined;
  const order: string[] = [];
  const byPath = new Map<string, { matches: Array<{ line: number; text: string }>; count: number }>();
  let truncatedTotal: number | undefined;
  let matches = 0;
  const lines = output.split('\n');
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      // Only a trailing blank line is a terminator; a blank line between rows is
      // a shape this parser does not know.
      if (index === lines.length - 1) continue;
      return undefined;
    }
    const clipped = KIMI_SEARCH_TRUNCATION.exec(line);
    if (clipped) {
      truncatedTotal = Number(clipped[1]);
      continue;
    }
    if (contentMode) {
      const match = KIMI_GREP_MATCH_LINE.exec(line);
      if (!match) {
        // A context row is understood — it is simply not a match.
        if (KIMI_GREP_CONTEXT_LINE.test(line)) continue;
        return undefined;
      }
      const path = match[1]!;
      const entry = byPath.get(path) ?? { matches: [], count: 0 };
      if (!byPath.has(path)) { byPath.set(path, entry); order.push(path); }
      entry.matches.push({ line: Number(match[2]), text: match[3]! });
      entry.count += 1;
      matches += 1;
      continue;
    }
    // Path-listing shape. Whitespace disqualifies the line: it is how a prose
    // notice ("No matches found") is told apart from a path, at the cost of the
    // rare path that contains a space falling back to the raw output.
    if (/\s/.test(line)) return undefined;
    if (byPath.has(line)) continue;
    byPath.set(line, { matches: [], count: 0 });
    order.push(line);
  }
  if (order.length === 0) return undefined;
  if (contentMode && matches === 0) return undefined;
  const groups: ToolSearchGroup[] = [];
  for (const path of order) {
    const entry = byPath.get(path)!;
    const group = searchGroup({
      path,
      ...(entry.count > 0 ? { matchCount: entry.count } : {}),
      ...(entry.matches.length > 0 ? { matches: entry.matches } : {}),
    });
    if (group) groups.push(group);
  }
  if (groups.length === 0) return undefined;
  return {
    groups,
    // A clipped answer reports the source's own total; an unclipped one counts
    // what it saw. Neither is invented, and the file count is claimed only when
    // nothing was dropped.
    ...(truncatedTotal !== undefined
      ? { matchCount: truncatedTotal }
      : contentMode
        ? { matchCount: matches, fileCount: groups.length }
        : { fileCount: groups.length }),
    truncated: truncatedTotal !== undefined,
  };
}

/**
 * The canonical `tool-call` row for one `tool_use` part.
 *
 * Only `Bash` carries a CALL-time semantic. Every other family's semantic is
 * completed by its result, and a call-time one would claim that presentation for
 * the pair (the client resolves the family from `result ?? call`) — so a result
 * whose output did not parse would render an empty card instead of its output.
 * A command row does not have that failure mode: the client keeps presenting
 * the result's text as the command's combined output.
 */
function kimiToolCallRow(
  callId: string,
  toolName: string,
  input: unknown,
  facts: KimiToolCallFacts,
): AgentMessage {
  const toolClass = kimiToolDisplayClass(toolName);
  const semantic = facts.command !== undefined
    ? commandSemantic({ command: facts.command, cwd: facts.cwd, state: 'running' })
    : undefined;
  const bounded = boundToolSemantic(semantic);
  return {
    type: 'tool-call',
    callId,
    toolName,
    ...(toolClass ? { toolClass } : {}),
    ...(input !== undefined ? { args: input } : {}),
    ...(bounded ? { semantic: bounded } : {}),
  };
}

/**
 * The semantic a RESULT row carries, from its own output plus the facts its call
 * recorded. Undefined whenever the output is not the shape the tool declares —
 * the row then keeps the generic fallback, output and all.
 */
function kimiToolResultSemantic(
  facts: KimiToolCallFacts | undefined,
  output: unknown,
  isError: boolean,
): ToolSemantic | undefined {
  if (!facts) return undefined;
  switch (facts.toolName) {
    case 'Bash':
      // The output is ONE merged blob upstream, so `stdout`/`stderr` stay absent
      // and the client labels the body honestly as combined output.
      return commandSemantic({
        command: facts.command,
        cwd: facts.cwd,
        state: isError ? 'failed' : 'completed',
      });
    case 'Read': {
      // A failed read's output is the error sentence, not a preview; the row
      // keeps `path` and shows the sentence.
      if (isError) return undefined;
      const preview = kimiReadPreview(output);
      if (!preview) return undefined;
      return fileReadSemantic({
        path: facts.path,
        startLine: preview.startLine,
        preview: preview.preview,
      });
    }
    case 'Grep':
    case 'Glob': {
      if (isError) return undefined;
      const parsed = kimiSearchResult(output, facts.toolName === 'Glob' ? undefined : facts.searchMode);
      if (!parsed) return undefined;
      const semantic = searchSemantic({
        query: facts.query,
        scope: facts.scope,
        ...(parsed.matchCount !== undefined ? { matchCount: parsed.matchCount } : {}),
        ...(parsed.fileCount !== undefined ? { fileCount: parsed.fileCount } : {}),
        groups: parsed.groups,
      });
      return parsed.truncated ? { ...semantic, truncated: true } : semantic;
    }
    default:
      // ReadMediaFile returns content PARTS, not text, so it has no preview to
      // carry; WebSearch/FetchURL answer in prose that only a scraper could turn
      // into results, and scraping it would hide the prose the user is reading.
      // Both keep their class (and ReadMediaFile its path) and nothing more.
      return undefined;
  }
}

/**
 * Map one native message into zero or more canonical rows.
 *
 * A native message carries an ARRAY of content parts (text plus thinking plus
 * tool calls in one record), so the fan-out is one canonical message per part,
 * each keyed by its position so history replay and the live tail dedupe against
 * the same identity.
 *
 * `state` is the per-connection correlation record (see {@link KimiMappingState});
 * folds that span messages — the TodoList result suppression and the background
 * task notification fold — are no-ops without it.
 */
export function mapKimiMessage(raw: KimiMessage, state?: KimiMappingState): KimiMappedRow[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const id = optionalString(raw.id);
  if (!id) return [];
  const role = raw.role;
  const parts = contentParts(raw.content);
  const sentAt = optionalEpochMs(raw.created_at);
  const origin = kimiOrigin(raw.metadata);
  const originKind = kimiOriginKind(raw.metadata);
  const nativeRole = typeof role === 'string' ? role : undefined;
  const rows: KimiMappedRow[] = [];
  const out = {
    push(message: AgentMessage, nativeKey: string): void {
      rows.push({
        message,
        identity: `${message.type}:${nativeKey}`,
        nativeMessageId: id,
        ...(nativeRole !== undefined ? { nativeRole } : {}),
        ...(originKind !== undefined ? { originKind } : {}),
      });
    },
  };
  /** Positions in {@link rows} of the artifacts made from this message's IMAGE parts. */
  const imageRowIndexes: number[] = [];

  if (parts.length === 0) return rows;

  for (const [index, part] of parts.entries()) {
    const key = partKey(id, index);
    const kind = part.type;
    if (kind === 'text') {
      const text = textOf(part, 'text');
      if (!text) continue;
      // A detached background task settling arrives as a `role: 'user'` row
      // whose origin kind is `task` (upstream `TaskOrigin`) and whose text is a
      // `<notification …>` envelope — the row exists to WAKE THE AGENT, so it
      // is never something the operator typed, and `unwrapContextBlock` could
      // not parse it anyway. The third consumer of the `originKind` plumbing:
      // folded onto the spawning call as its deferred tool-result when the
      // correlation resolves, a visible notice when it cannot.
      if (role === 'user' && originKind === 'task') {
        for (const message of kimiTaskNotificationMessage(text, origin, state, sentAt)) {
          out.push(message, key);
        }
        continue;
      }
      // A skill or plugin activation arrives as a `role: 'user'` row whose
      // TEXT is the whole loaded body — upstream enqueues the expanded skill
      // as a user message tagged `skill_activation` / `plugin_command`
      // (`agent/skill/prompt.ts`, `agent/pluginCommand/pluginCommandService.ts`).
      // Rendered as one user message that body is a giant card the operator
      // never typed, so the row is SPLIT, never folded away:
      //
      //  (a) a short user row for the ACTION the user took — `/name args`
      //      from the origin, closer to what the person actually did than the
      //      kilobytes the harness attached to it; and
      //  (b) the body itself as a context-injection event, the same mechanism
      //      and ceiling as the `injection` path below.
      //
      // Both rows keep the origin kind, so the divergence detector in
      // `drive.ts` still reads this as the server writing to its own session,
      // never as a foreign prompt. An activation whose origin carries no name
      // falls THROUGH to the ordinary handling: a row that cannot be
      // attributed stays whole, because the safe direction for one we cannot
      // explain is to show it, not to collapse it.
      if (role === 'user' && origin !== undefined
        && (originKind === 'skill_activation' || originKind === 'plugin_command')) {
        const action = activationActionText(origin, originKind);
        if (action !== undefined) {
          out.push({
            type: 'user-message',
            text: action,
            key,
            ...(sentAt !== undefined ? { sentAt } : {}),
          }, key);
          const block = (originKind === 'skill_activation' ? unwrapSkillLoadedBlock(text) : undefined)
            // A body that is not the expected envelope is still what the origin
            // says it is; the kind labels it when no wrapper did.
            ?? { source: originKind, body: text };
          out.push({
            type: 'event',
            name: CONTEXT_INJECTION_EVENT,
            payload: {
              source: block.source,
              ...boundContextBody(block.body),
            } satisfies ContextInjectionPayload,
          }, key);
          continue;
        }
      }
      // Injected context is recognized on the USER row as well as the system
      // one, because the user row is where Kimi actually delivers it: every
      // `<system-reminder>` block a live server returns arrives as
      // `role: 'user'` and none as `role: 'system'`. Recognizing it only under
      // `system` — as this did — meant the rule never fired on real data, and
      // the raw wrapper reached the transcript rendered as something the
      // operator had typed.
      //
      // On the user row it takes BOTH Kimi's provenance and a whole wrapper.
      // The text alone is not evidence of anything: a person may paste or quote
      // an entire reminder, and that is still them writing. `metadata.origin`
      // is the only party that knows, so a row it does not call `injection` —
      // including `user`, `cron_job`, and anything missing or malformed — stays
      // a user message even when the whole message is a wrapper.
      //
      // The system row keeps its own rule, unchanged: there the wrapper alone
      // decides, because a system row is never someone typing.
      const injected = role === 'system'
        || (role === 'user' && originKind === 'injection')
        ? unwrapContextBlock(text)
        : undefined;
      if (injected) {
        out.push({
          type: 'event',
          name: CONTEXT_INJECTION_EVENT,
          payload: {
            source: injected.source,
            // Same ceiling every adapter uses, and a clip is declared rather
            // than left looking like the end of the material.
            ...boundContextBody(injected.body),
          } satisfies ContextInjectionPayload,
        }, key);
      } else if (role === 'user') {
        out.push({
          type: 'user-message',
          text,
          key,
          ...(sentAt !== undefined ? { sentAt } : {}),
        }, key);
      } else if (role === 'system') {
        // A system row that is NOT an identifiable wrapper is something the USER
        // should read, so it stays a notice: folding every system row into
        // collapsed context would hide real messages behind a disclosure nobody
        // opens.
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
      state?.toolNames.set(callId, toolName);
      // Recorded BEFORE the TodoList and Agent branches: those return early, and
      // a result whose call took an early path still needs the facts.
      const callFacts = kimiToolCallFacts(toolName, part.input);
      if (state) rememberBoundedFacts(state.toolCallFacts, callId, callFacts);
      // The todo ledger is SESSION STATE, not a tool invocation: ONE upserted
      // task-list-state panel keyed `kimi:todos`, never a stack of raw TodoList
      // cards — the same surface claude/codex/opencode/dsh already emit. A call
      // that is not a well-formed write (malformed input, or `{}`, the upstream
      // QUERY) falls through to the ordinary tool-call row and leaves the
      // panel alone.
      if (toolName === KIMI_TODO_LIST_TOOL) {
        const panel = kimiTodoListState(part.input);
        if (panel) {
          // Suppress the paired result ONLY when the panel actually emitted: a
          // `{}` query renders a plain call card, and its non-error result —
          // the only surface a query has — must still reach the transcript.
          state?.todoListCallIds.add(callId);
          out.push(panel, key);
          continue;
        }
      }
      // The Agent spawn tool ALSO opens the canonical `agent-activity` bar — the
      // same foreground tier dsh built for issue 11. The plain tool-call card
      // stays (what claude does with its Task card); the bar is the live
      // surface. FOREGROUND calls (no `run_in_background`) open `running` here
      // and close at the paired result; DETACHED spawns open nothing yet — their
      // pair brackets only the parent's wait for a task id, so the bar opens at
      // the spawn result and closes at the settlement notification. An Agent
      // call whose result already folded (the page-straddle guard) opens no bar
      // at all, because nothing would ever close it.
      if (toolName === KIMI_AGENT_SPAWN_TOOL && state) {
        const pending = kimiAgentActivityFromCall(part.input, callId, sentAt);
        if (pending && !state.orphanedResultCallIds.has(callId)) {
          state.agentActivities.set(callId, pending);
          if (!pending.detached) {
            out.push(kimiToolCallRow(callId, toolName, part.input, callFacts), key);
            out.push(kimiAgentActivityMessage(pending, 'running'), key);
            continue;
          }
        }
      }
      out.push(kimiToolCallRow(callId, toolName, part.input, callFacts), key);
      continue;
    }
    if (kind === 'tool_result') {
      const callId = optionalString(part.tool_call_id);
      if (!callId) {
        out.push(degradedPart(key, 'tool_result'), key);
        continue;
      }
      // A background-spawn result OPENS with a `task_id: <id>` line (upstream
      // `bashTool.backgroundStartedResult`); that line is the ONLY link between
      // a detached task and the call the user watched start, so it is recorded
      // for the notification fold. Anchored to the FIRST line on purpose: a
      // foreground call's truncation footer mentions a task id too, and that
      // task is never detached, so it never settles into a notification.
      let spawnedTaskId: string | undefined;
      if (state && typeof part.output === 'string') {
        const spawned = /^task_id: (\S+)/.exec(part.output);
        if (spawned) {
          spawnedTaskId = spawned[1]!;
          state.backgroundTasks.set(spawnedTaskId, callId);
        }
      }
      // A result whose CALL has not folded (a page-straddling pair meets its
      // result first in a newest-first walk) is remembered, so the call — when
      // it folds moments later — does not open a subagent bar nothing will
      // close. Results whose call already folded (the normal order) never land
      // here: `toolNames` knows them.
      if (state && !state.toolNames.has(callId)) rememberBounded(state.orphanedResultCallIds, callId);
      // The panel emitted for the TodoList CALL is the surface; the paired
      // result is an acknowledgment echo and would only stack a second card —
      // the same suppression as claude's TodoWrite result, and like there a
      // FAILED call keeps its error row. Without state the result renders,
      // which is the safe direction.
      if (part.is_error !== true && state?.todoListCallIds.has(callId)) continue;
      // The REST fold usually gives a result NO tool name (only `tool_call_id`),
      // so the stamping reads the name its CALL recorded. The emitted `toolName`
      // is left exactly as it was: it is matched downstream, and widening it is
      // a separate change from stamping.
      const resultFacts = state?.toolCallFacts.get(callId);
      const resultClass = kimiToolDisplayClass(optionalString(part.tool_name) ?? resultFacts?.toolName);
      const resultSemantic = boundToolSemantic(
        kimiToolResultSemantic(resultFacts, part.output, part.is_error === true),
      );
      const resultRow: AgentMessage = {
        type: 'tool-result',
        callId,
        toolName: optionalString(part.tool_name) ?? '',
        ...(resultClass ? { toolClass: resultClass } : {}),
        ...(resultSemantic ? { semantic: resultSemantic } : {}),
        // The file the tool acted on, from the call's declared argument key —
        // read/edit/write only, never a Grep/Glob scope directory.
        ...(resultFacts?.path ? { path: resultFacts.path } : {}),
        ...(part.output !== undefined ? { result: part.output } : {}),
        ...(part.is_error === true ? { isError: true } : {}),
      };
      const pendingAgent = state?.agentActivities.get(callId);
      if (state && pendingAgent) {
        if (!pendingAgent.detached) {
          // FOREGROUND: the call/result pair brackets the run exactly, so the
          // result closes the bar the call opened. Elapsed is the parent's tool
          // wait (call → result message timestamps).
          state.agentActivities.delete(callId);
          out.push(resultRow, key);
          out.push(
            kimiAgentActivityMessage(
              pendingAgent,
              part.is_error === true ? 'error' : 'done',
              kimiElapsedMs(pendingAgent.startedAt, sentAt),
            ),
            key,
          );
          continue;
        }
        // DETACHED: the result returns immediately, so it is not the run's end —
        // it is the run's CONFIRMATION. The running bar opens here, once the
        // spawn result proves a task id exists, and closes at the settlement
        // notification. A task whose settlement already folded, or a failed
        // spawn, opens no bar at all.
        if (part.is_error !== true && spawnedTaskId && !state.settledTaskIds.has(spawnedTaskId)) {
          pendingAgent.opened = true;
          out.push(resultRow, key);
          out.push(kimiAgentActivityMessage(pendingAgent, 'running'), key);
          continue;
        }
        state.agentActivities.delete(callId);
      }
      out.push(resultRow, key);
      continue;
    }
    if (kind === 'image' || kind === 'video') {
      // History rows arrive with `blobref:` media REHYDRATED into a real `data:`
      // URI upstream (`services/messages/messageHistory.ts:165-187`), so an
      // echoed image carries its bytes on the row:
      // `{type:'image', source:{kind:'url', url:'data:image/…'}}`. That shape
      // surfaces as the canonical artifact row — the same `file-artifact` with
      // an inline data URL that claude emits for inline image blocks. Every
      // other shape (an unresolvable ref, which upstream rewrites to the literal
      // `[media missing]`; a non-url source; video) keeps the event fallback:
      // observe has no artifact bytes to serve and must not fabricate a URL.
      const source = part.source && typeof part.source === 'object' && !Array.isArray(part.source)
        ? part.source as Record<string, unknown>
        : undefined;
      const url = source?.kind === 'url' ? optionalString(source.url) : undefined;
      if (kind === 'image' && url !== undefined && url.startsWith('data:')) {
        const mimeType = /^data:([^;,]+)/.exec(url)?.[1]
          ?? optionalString(part.media_type)
          ?? 'image/png';
        out.push({
          type: 'file-artifact',
          path: key,
          name: `image.${mimeType.split('/')[1] ?? 'png'}`,
          mimeType,
          artifactKey: key,
          // Past the inline cap the row goes header-only, matching the broker's
          // own emitArtifact ceiling rather than shipping an unbounded data URL
          // in every history replay.
          ...(url.length <= KIMI_INLINE_IMAGE_DATA_URL_CAP ? { url } : {}),
        }, key);
        imageRowIndexes.push(rows.length - 1);
        continue;
      }
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

  // ── The sent image belongs to a user row ──────────────────────────────────
  //
  // An echoed image is a top-level `file-artifact`, so the client rendered it as
  // an agent deliverable — a download card detached from the bubble the person
  // actually sent it on. `userMessageKey` is the ownership link the protocol
  // defines for exactly this; identity stays `artifactKey`.
  //
  // THE OWNER IS THE FIRST user-message row of this native message, in part
  // order. A message with several text parts folds to several rows and one of
  // them has to hold the attachments; first is the only choice that is stable
  // across a history fold and a live walk (both read the same part array in the
  // same order) and it is the row the reader meets first. Existing keys are NOT
  // touched — the drive echo adoption and the divergence detector match on them.
  //
  // An image-only prompt has no text part and therefore had no user row at all,
  // which is the second half of the same defect: nothing to attach to, and no
  // bubble for the person's own send. It gets one with empty text, keyed off the
  // message id rather than any part index (no part produced it, and no
  // part-indexed key can collide with it).
  if (role === 'user' && imageRowIndexes.length > 0) {
    let ownerIndex = rows.findIndex((row) => row.message.type === 'user-message');
    if (ownerIndex < 0) {
      const attachmentKey = attachmentOnlyUserKey(id);
      rows.unshift({
        message: {
          type: 'user-message',
          text: '',
          key: attachmentKey,
          ...(sentAt !== undefined ? { sentAt } : {}),
        },
        identity: `user-message:${attachmentKey}`,
        nativeMessageId: id,
        ...(nativeRole !== undefined ? { nativeRole } : {}),
        ...(originKind !== undefined ? { originKind } : {}),
      });
      for (let i = 0; i < imageRowIndexes.length; i += 1) imageRowIndexes[i]! += 1;
      ownerIndex = 0;
    }
    const owner = rows[ownerIndex]!;
    const ownerMessage = owner.message as Extract<AgentMessage, { type: 'user-message' }>;
    const ownerKey = ownerMessage.key;
    owner.message = { ...ownerMessage, imageCount: imageRowIndexes.length };
    if (ownerKey) {
      for (const index of imageRowIndexes) {
        const artifact = rows[index]!;
        artifact.message = {
          ...(artifact.message as Extract<AgentMessage, { type: 'file-artifact' }>),
          userMessageKey: ownerKey,
        };
      }
    }
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
export function mapKimiMessagePage(page: KimiMessagePage | undefined, state?: KimiMappingState): {
  rows: KimiMappedRow[];
  hasMore: boolean;
  oldestId?: string;
} {
  const items = Array.isArray(page?.items) ? page.items : [];
  const ascending = [...items].reverse();
  const rows: KimiMappedRow[] = [];
  for (const item of ascending) rows.push(...mapKimiMessage((item ?? {}) as KimiMessage, state));
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
 *
 * `catalog` is `GET /api/v1/models` as this connection last read it
 * ({@link KimiModelCatalogCache}). `/status` reports the catalog's `model`
 * VERBATIM — probed on 0.37.2, `"model":"kimi-code/k3-256k"` against a catalog
 * row `{provider:'managed:kimi-code', model:'kimi-code/k3-256k',
 * display_name:'K3-256k'}` — so the two join on that string exactly, and the
 * join is the only authored label this adapter has.
 */
export function mapKimiSessionStatus(raw: unknown, catalog?: readonly ModelOption[]): AgentMessage[] {
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
  // `currentMode` is the CONTRACT field the mode picker preselects from (see
  // `SessionInfo.currentMode`), and the broker folds this value straight onto
  // the session's info object. Emitted as `permissionMode` it landed on that
  // object under a name nothing declares and nothing reads, so the picker sat
  // blank while the session was demonstrably in a mode the host had reported —
  // and the obvious repair, defaulting the picker to a mode, would have been
  // the client inventing an approval posture the host never claimed.
  const currentMode = optionalString(status.permission);
  const planMode = optionalBoolean(status.plan_mode);
  const swarmMode = optionalBoolean(status.swarm_mode);
  // THE ROSTER LABEL, and the decision behind it: the HOST CATALOG's
  // `display_name` is authoritative — `K2.7 Coding`, `K3-256k` — and this
  // adapter builds no product mapping to `kimi-k3`-style names. A label the
  // host does not use is a second naming system to keep in sync with a server
  // that ships new models without asking, and the picker already shows these
  // exact strings.
  //
  // Emitted as `currentModel` because that is the CONTRACT field (the same trap
  // `currentMode` above documents): the bare `model` string reaches the client
  // with no label, and the client's own heuristics then print the raw alias
  // (`kimi-code/kimi-for-coding`), the bare family word (`Kimi`), or a
  // digit-scavenged invention (`Kimi 3.256`). The raw string STAYS in `model`
  // for the tooltip. No join, no label: an unknown alias keeps today's
  // behaviour rather than being given a name nothing reported.
  const entry = model ? catalog?.find((option) => option.modelID === model) : undefined;
  // A model the LOADED catalog does not know publishes an EXPLICIT
  // `currentModel: undefined`: the broker folds this value with Object.assign,
  // so an omitted key would leave the previous model's label on the roster
  // after a switch. No catalog at all (none read yet) says nothing either way.
  const clearLabel = model !== undefined && entry === undefined && catalog !== undefined && catalog.length > 0;
  const sessionInfo = {
    ...(model ? { model } : {}),
    ...(entry && model
      ? { currentModel: { providerID: entry.providerID, modelID: model, label: entry.label } }
      : clearLabel ? { currentModel: undefined } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(currentMode ? { currentMode } : {}),
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
 *
 * Exported because it is the package's ONE truncation rule: the subagent
 * history reader shortens journal bodies too, and a second implementation there
 * reintroduced exactly the bug this comment describes.
 */
export function truncateToUtf8Budget(text: string, capBytes: number): string {
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

/**
 * The decisions this adapter will actually honor for a Kimi approval, and the
 * whole reason the card advertises anything at all.
 *
 * ADVERTISEMENT ONLY — nothing here changes what is sent. `respondPermission`
 * already answers all three (`drive.ts`: `reject` → `{decision:'rejected'}`,
 * `approve-session` → `{decision:'approved', scope:'session'}` — `'session'` is
 * the only scope the schema accepts — and `approve` → `{decision:'approved'}`),
 * and `mapKimiApprovalResolved` already reads the session scope back off the
 * resolution. The client renders its third button only when `options` names
 * `approve-session`, so without this list a supported answer was simply
 * unreachable. The two must stay derived from the same table: an option with no
 * working answer behind it is worse than no button.
 */
export const KIMI_APPROVAL_OPTIONS: readonly string[] = ['approve', 'approve-session', 'reject'];

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
    // An observe-mode card is a NOTICE: it is non-actionable by design, this
    // connection has no write door to answer it through, and advertising
    // options on it would grow buttons that resolve nothing.
    ...(readOnly ? { readOnly: true } : { options: [...KIMI_APPROVAL_OPTIONS] }),
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
