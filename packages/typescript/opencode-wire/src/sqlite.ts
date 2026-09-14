import type { AgentMessage, SessionInfo } from '@cosyncing/adapter-api';
import type { Database } from 'bun:sqlite';
import { mapOpenCodePart, openCodePartTime, parseOpenCodeJsonObject } from './mapping.ts';

export interface OpenCodeSqliteSession {
  id: string;
  slug?: string;
  directory?: string;
  title?: string;
  model?: { id?: string; providerID?: string; modelID?: string; variant?: string };
  agent?: string;
  time?: { created?: number; updated?: number };
  parentID?: string;
  revert?: { messageID?: string };
}

export interface OpenCodeSqliteOptions {
  productId?: string;
  updatedAfter?: number;
  strictStorageTypes?: boolean;
  validMessageRoles?: readonly string[];
  validateMessage?: (message: Record<string, any>) => boolean;
  validatePart?: (part: Record<string, any>) => boolean;
  mapPart?: (part: unknown, historical: boolean) => AgentMessage[];
  maxMessageBytes?: number;
  maxHistoryBytes?: number;
  maxRawRecordBytes?: number;
  maxRawHistoryBytes?: number;
  maxIdentityBytes?: number;
}

function jsonRecord(value: unknown): Record<string, any> | undefined {
  const parsed = parseOpenCodeJsonObject(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, any>
    : undefined;
}

function durableIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function malformedRowExists(database: Database, query: string, ...params: any[]): boolean {
  const row = database.query(query).get(...params) as { count?: number | bigint } | null;
  const count = Number(row?.count ?? 0);
  return !Number.isSafeInteger(count) || count > 0;
}

export function openCodeSqliteSessionFromRow(row: any): OpenCodeSqliteSession {
  const model = parseOpenCodeJsonObject(row.model);
  const revert = parseOpenCodeJsonObject(row.revert);
  return {
    id: String(row.id),
    ...(row.slug ? { slug: String(row.slug) } : {}),
    ...(row.directory ? { directory: String(row.directory) } : {}),
    ...(row.title ? { title: String(row.title) } : {}),
    ...(row.parent_id ? { parentID: String(row.parent_id) } : {}),
    ...(typeof row.agent === 'string' && row.agent ? { agent: row.agent } : {}),
    ...(model && typeof model === 'object' && !Array.isArray(model) ? { model } : {}),
    ...(revert && typeof revert === 'object' && !Array.isArray(revert) ? { revert } : {}),
    time: {
      ...(row.time_created == null ? {} : { created: Number(row.time_created) }),
      ...(row.time_updated == null ? {} : { updated: Number(row.time_updated) }),
    },
  };
}

export function readOpenCodeSqliteSessions(
  database: Database,
  options: OpenCodeSqliteOptions = {},
): OpenCodeSqliteSession[] {
  const activeWhere = options.updatedAfter === undefined
    ? 'time_archived is null'
    : 'time_archived is null and coalesce(time_updated, time_created) >= ?';
  const activeParams = options.updatedAfter === undefined ? [] : [options.updatedAfter];
  if (options.strictStorageTypes && malformedRowExists(database, `select count(*) as count from session where ${activeWhere} and (
    typeof(id) != 'text'
    or typeof(parent_id) not in ('null', 'text')
    or typeof(slug) not in ('null', 'text')
    or typeof(directory) not in ('null', 'text')
    or typeof(title) not in ('null', 'text')
    or typeof(model) not in ('null', 'text')
    or typeof(revert) not in ('null', 'text')
    or typeof(agent) not in ('null', 'text')
    or typeof(time_created) not in ('null', 'integer', 'real')
    or typeof(time_updated) not in ('null', 'integer', 'real')
    or typeof(time_archived) not in ('null', 'integer', 'real')
    or abs(coalesce(time_created, 0)) > 9007199254740991
    or abs(coalesce(time_updated, 0)) > 9007199254740991
    or abs(coalesce(time_archived, 0)) > 9007199254740991
  )`, ...activeParams)) return [];
  const columns = 'id, parent_id, slug, directory, title, model, revert, agent, time_created, time_updated';
  const rows = options.updatedAfter === undefined
    ? database.query(`select ${columns} from session where time_archived is null order by time_updated desc`).all()
    : database.query(`select ${columns} from session where time_archived is null and coalesce(time_updated, time_created) >= ? order by time_updated desc`).all(options.updatedAfter);
  return (rows as any[]).map(openCodeSqliteSessionFromRow);
}

export function readOpenCodeSqliteSession(
  database: Database,
  id: string,
  options: Pick<OpenCodeSqliteOptions, 'strictStorageTypes'> = {},
): OpenCodeSqliteSession | undefined {
  if (options.strictStorageTypes && malformedRowExists(database, `select count(*) as count from session where id = ? and (
    typeof(id) != 'text'
    or typeof(parent_id) not in ('null', 'text')
    or typeof(slug) not in ('null', 'text')
    or typeof(directory) not in ('null', 'text')
    or typeof(title) not in ('null', 'text')
    or typeof(model) not in ('null', 'text')
    or typeof(revert) not in ('null', 'text')
    or typeof(agent) not in ('null', 'text')
    or typeof(time_created) not in ('null', 'integer', 'real')
    or typeof(time_updated) not in ('null', 'integer', 'real')
    or typeof(time_archived) not in ('null', 'integer', 'real')
    or abs(coalesce(time_created, 0)) > 9007199254740991
    or abs(coalesce(time_updated, 0)) > 9007199254740991
    or abs(coalesce(time_archived, 0)) > 9007199254740991
  )`, id)) return undefined;
  const row = database.query(
    `select id, parent_id, slug, directory, title, model, revert, agent, time_created, time_updated
     from session where id = ? limit 1`,
  ).get(id);
  return row ? openCodeSqliteSessionFromRow(row) : undefined;
}

export function openCodeSqlitePartFromRow(row: any): any | undefined {
  const data = jsonRecord(row.data);
  if (!data || !durableIdentity(row.id) || !durableIdentity(row.message_id)
    || !durableIdentity(row.session_id)) return undefined;
  return {
    ...data,
    id: row.id,
    messageID: row.message_id,
    sessionID: row.session_id,
    timeCreated: row.time_created ?? undefined,
    timeUpdated: row.time_updated ?? undefined,
  };
}

function nativeTimeMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 10_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return nativeTimeMs(numeric);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function cleanUserText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed;
    } catch { /* keep original */ }
  }
  return text;
}

function runSummary(
  message: any,
  productId: string,
  userMessageKey?: string,
  userStartedAt?: number,
  assistantMessageKey?: string,
): Extract<AgentMessage, { type: 'run-summary' }> | undefined {
  if (message?.role !== 'assistant') return undefined;
  const assistantId = message.id ? String(message.id) : undefined;
  const turnId = assistantId ?? userMessageKey;
  if (!turnId) return undefined;
  const startedAt = nativeTimeMs(message.time?.created) ?? userStartedAt;
  const cancelled = /abort|cancel/iu.test([
    message.error?.name, message.error?.code, message.error?.message,
    message.error?.data?.message, message.finish,
  ].map((value) => String(value ?? '')).join(' '));
  const status = cancelled ? 'cancelled' as const
    : message.error ? 'error' as const
      : nativeTimeMs(message.time?.completed) !== undefined || message.finish ? 'done' as const : 'running' as const;
  // A running footer is a mutable trailing projection: later persisted parts
  // would be inserted before it and make an append-only observer reset on
  // every normal turn. Durable status comes from the session/activity query;
  // append the footer only when the stored turn reaches a terminal state.
  if (status === 'running') return undefined;
  const completedAt = nativeTimeMs(message.time?.completed);
  return {
    type: 'run-summary',
    key: `${productId}:run:${assistantId ?? turnId}`,
    turnId,
    userMessageKey,
    assistantMessageKey,
    status,
    startedAt,
    completedAt,
    totalRuntimeMs: startedAt !== undefined && completedAt !== undefined ? Math.max(0, completedAt - startedAt) : undefined,
    tokens: message.tokens ? {
      input: message.tokens.input,
      output: message.tokens.output,
      cacheRead: message.tokens.cache?.read,
      cacheWrite: message.tokens.cache?.write,
      cost: message.cost,
    } : undefined,
    source: productId,
  };
}

export function readOpenCodeSqliteHistory(
  database: Database,
  sessionId: string,
  options: Pick<OpenCodeSqliteOptions,
    'productId' | 'mapPart' | 'maxMessageBytes' | 'maxHistoryBytes' | 'maxRawRecordBytes' | 'maxRawHistoryBytes'
    | 'maxIdentityBytes' | 'strictStorageTypes' | 'validMessageRoles' | 'validateMessage' | 'validatePart'> = {},
): AgentMessage[] | undefined {
  const productId = options.productId ?? 'opencode';
  const mapPart = options.mapPart ?? ((part: unknown) => mapOpenCodePart(part, { historical: true, productId }));
  if (options.strictStorageTypes) {
    const malformedMessage = malformedRowExists(database, `select count(*) as count from message where session_id = ? and (
      typeof(id) != 'text' or typeof(session_id) != 'text' or typeof(data) != 'text'
      or typeof(time_created) not in ('null', 'integer', 'real')
      or typeof(time_updated) not in ('null', 'integer', 'real')
      or abs(coalesce(time_created, 0)) > 9007199254740991
      or abs(coalesce(time_updated, 0)) > 9007199254740991
    )`, sessionId);
    const malformedPart = malformedRowExists(database, `select count(*) as count from part where session_id = ? and (
      typeof(id) != 'text' or typeof(message_id) != 'text' or typeof(session_id) != 'text' or typeof(data) != 'text'
      or typeof(time_created) not in ('null', 'integer', 'real')
      or typeof(time_updated) not in ('null', 'integer', 'real')
      or abs(coalesce(time_created, 0)) > 9007199254740991
      or abs(coalesce(time_updated, 0)) > 9007199254740991
    )`, sessionId);
    const malformedSession = malformedRowExists(database, `select count(*) as count from session where id = ? and (
      typeof(id) != 'text' or typeof(revert) not in ('null', 'text')
    )`, sessionId);
    if (malformedMessage || malformedPart || malformedSession) return undefined;
  }
  if (options.maxRawRecordBytes !== undefined || options.maxRawHistoryBytes !== undefined || options.maxIdentityBytes !== undefined) {
    const messageSize = database.query(
      'select coalesce(max(length(cast(data as blob))), 0) as largest, coalesce(sum(length(cast(data as blob))), 0) as total from message where session_id = ?',
    ).get(sessionId) as { largest?: number | bigint; total?: number | bigint } | null;
    const partSize = database.query(
      'select coalesce(max(length(cast(data as blob))), 0) as largest, coalesce(sum(length(cast(data as blob))), 0) as total from part where session_id = ?',
    ).get(sessionId) as { largest?: number | bigint; total?: number | bigint } | null;
    const sessionSize = database.query(
      'select coalesce(length(cast(revert as blob)), 0) as revertBytes from session where id = ? limit 1',
    ).get(sessionId) as { revertBytes?: number | bigint } | null;
    const identitySize = database.query(`select max(value) as largest from (
      select coalesce(max(length(cast(id as blob))), 0) as value from message where session_id = ?
      union all select coalesce(max(length(cast(id as blob))), 0) from part where session_id = ?
      union all select coalesce(max(length(cast(message_id as blob))), 0) from part where session_id = ?
    )`).get(sessionId, sessionId, sessionId) as { largest?: number | bigint } | null;
    const largest = Math.max(Number(messageSize?.largest ?? 0), Number(partSize?.largest ?? 0), Number(sessionSize?.revertBytes ?? 0));
    const total = Number(messageSize?.total ?? 0) + Number(partSize?.total ?? 0) + Number(sessionSize?.revertBytes ?? 0);
    if (!Number.isSafeInteger(largest) || !Number.isSafeInteger(total)
      || (options.maxRawRecordBytes !== undefined && largest > options.maxRawRecordBytes)
      || (options.maxRawHistoryBytes !== undefined && total > options.maxRawHistoryBytes)
      || (options.maxIdentityBytes !== undefined && Number(identitySize?.largest ?? 0) > options.maxIdentityBytes)) return undefined;
  }
  const session = database.query('select revert from session where id = ? limit 1').get(sessionId) as any;
  if (!session) return undefined;
  let messages = database.query(
    'select id, session_id, time_created, data from message where session_id = ? order by time_created, id',
  ).all(sessionId) as any[];
  const allMessageIds = new Set<string>();
  for (const row of messages) {
    if (!durableIdentity(row.id) || !durableIdentity(row.session_id)) return undefined;
    const id = row.id;
    if (!id || allMessageIds.has(id)) return undefined;
    allMessageIds.add(id);
  }
  const revertId = parseOpenCodeJsonObject(session.revert)?.messageID;
  if (revertId) {
    const cut = messages.findIndex((message) => message.id === revertId);
    if (cut >= 0) messages = messages.slice(0, cut);
  }
  const partsByMessage = new Map<string, any[]>();
  const partIds = new Set<string>();
  for (const row of database.query(
    'select id, message_id, session_id, time_created, time_updated, data from part where session_id = ? order by time_created, id',
  ).all(sessionId) as any[]) {
    if (!durableIdentity(row.id) || !durableIdentity(row.message_id)
      || !durableIdentity(row.session_id)) return undefined;
    const partId = row.id;
    const messageId = row.message_id;
    if (partIds.has(partId) || !allMessageIds.has(messageId)) return undefined;
    partIds.add(partId);
    const list = partsByMessage.get(messageId);
    const part = openCodeSqlitePartFromRow(row);
    if (!part || (options.validatePart && !options.validatePart(part))) return undefined;
    if (list) list.push(part);
    else partsByMessage.set(messageId, [part]);
  }
  const out: AgentMessage[] = [];
  let historyBytes = 0;
  const append = (...rows: AgentMessage[]): boolean => {
    for (const row of rows) {
      const bytes = Buffer.byteLength(JSON.stringify(row), 'utf8');
      if ((options.maxMessageBytes !== undefined && bytes > options.maxMessageBytes)
        || (options.maxHistoryBytes !== undefined && historyBytes + bytes > options.maxHistoryBytes)) return false;
      historyBytes += bytes;
      out.push(row);
    }
    return true;
  };
  let lastUserKey: string | undefined;
  let lastUserAt: number | undefined;
  const durableUserKeys = new Set<string>();
  const canonicalUserKeys = new Set<string>();
  const canonicalUserTimes = new Map<string, number>();
  for (const row of messages) {
    const data = jsonRecord(row.data);
    if (!data || (options.validMessageRoles && !options.validMessageRoles.includes(data.role))
      || (options.validateMessage && !options.validateMessage(data))) return undefined;
    const message: any = {
      ...data,
      id: row.id,
      sessionID: row.session_id,
    };
    const parts = partsByMessage.get(String(row.id)) ?? [];
    if (message.role === 'user') {
      durableUserKeys.add(message.id);
      const text = parts.filter((part) => part?.type === 'text')
        .map((part) => cleanUserText(String(part.text ?? ''))).filter((part) => part.length > 0).join('\n');
      const sentAt = nativeTimeMs(message.time?.created ?? row.time_created);
      if (text.trim()) {
        if (!append({ type: 'user-message', text, key: message.id, turnId: message.id, sentAt })) return undefined;
        canonicalUserKeys.add(message.id);
        if (sentAt !== undefined) canonicalUserTimes.set(message.id, sentAt);
        lastUserKey = message.id;
        lastUserAt = sentAt ?? lastUserAt;
      }
      for (const part of parts) {
        if (part?.type !== 'text' && !append(...mapPart(part, true))) return undefined;
      }
      continue;
    }
    if (message.role !== 'assistant') return undefined;
    if (message.parentID !== undefined
      && (!durableIdentity(message.parentID) || !durableUserKeys.has(message.parentID))) return undefined;
    let assistantMessageKey: string | undefined;
    for (const part of parts) {
      const mapped = mapPart(part, true);
      const identityRow = mapped.find((entry) => entry.type === 'model-output' || entry.type === 'thinking');
      if (assistantMessageKey === undefined && identityRow
        && (identityRow.type === 'model-output' || identityRow.type === 'thinking')
        && typeof identityRow.key === 'string') assistantMessageKey = identityRow.key;
      if (!append(...mapped)) return undefined;
    }
    if (message.error) {
      const detail = message.error.data?.message ?? message.error.message ?? message.error.name ?? 'Turn failed';
      if (!append({ type: 'error', message: String(detail).split('\n')[0]!.slice(0, 200) })) return undefined;
    }
    const linkedUserKey = message.parentID === undefined
      ? lastUserKey
      : canonicalUserKeys.has(message.parentID) ? message.parentID : undefined;
    const linkedUserAt = linkedUserKey === undefined ? undefined : canonicalUserTimes.get(linkedUserKey);
    const summary = runSummary(message, productId, linkedUserKey, linkedUserAt, assistantMessageKey);
    if (summary && !append(summary)) return undefined;
    if (message.tokens && !append({
      type: 'token-count', input: message.tokens.input, output: message.tokens.output,
      cacheRead: message.tokens.cache?.read, cacheWrite: message.tokens.cache?.write, cost: message.cost,
    })) return undefined;
  }
  return out;
}

function activeTool(part: any): boolean {
  if (part?.type !== 'tool' || part.tool === 'todowrite') return false;
  return !['completed', 'error'].includes(String(part?.state?.status ?? ''));
}

export function readOpenCodeSqliteActivity(
  database: Database,
  sessionId: string,
  freshMs: number,
  now = Date.now(),
): SessionInfo['status'] | undefined {
  const session = database.query('select id, time_updated from session where id = ? limit 1').get(sessionId) as any;
  if (!session) return undefined;
  const latest = database.query(
    'select id, session_id, time_created, time_updated, data from message where session_id = ? order by time_created desc, id desc limit 1',
  ).get(sessionId) as any;
  if (!latest) return 'idle';
  const message = { id: latest.id, sessionID: latest.session_id, ...parseOpenCodeJsonObject(latest.data) };
  const parts = (database.query(
    'select id, message_id, session_id, time_created, time_updated, data from part where message_id = ?',
  ).all(latest.id) as any[]).map(openCodeSqlitePartFromRow);
  const latestTime = Math.max(0, ...[
    session.time_updated, latest.time_updated, latest.time_created,
    message.time?.updated, message.time?.created, ...parts.map(openCodePartTime),
  ].map((value) => Number(value ?? 0)).filter(Number.isFinite));
  const fresh = latestTime > 0 && now - latestTime <= freshMs;
  if (fresh && message.role === 'assistant' && !message.time?.completed && !message.finish) return 'working';
  return fresh && parts.some(activeTool) ? 'working' : 'idle';
}

export function readOpenCodeSqliteMessageIds(database: Database, sessionId: string): string[] {
  return (database.query('select id from message where session_id = ? order by time_created, id').all(sessionId) as any[])
    .map((row) => String(row.id));
}
