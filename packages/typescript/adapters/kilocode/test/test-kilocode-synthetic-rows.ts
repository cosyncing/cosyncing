#!/usr/bin/env bun
// Kilo's own report rows (KL-2) and the 7.8 statuses (KL-3), against frames and kilo.db rows captured
// live from Kilo 7.5.16 and 7.8.32 (fixtures/kilo-synthetic-rows.json; how they were captured is in
// its `provenance`). The frames are replayed verbatim; only test-made variants say so where built.
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { CONTEXT_INJECTION_EVENT, type AgentMessage, type SessionInfo } from '@cosyncing/adapter-api';
import {
  OpenCodeLiveConnection,
  OpenCodeLiveOwnershipUnprovenError,
  type OpenCodeLiveOwnershipHooks,
} from '@cosyncing/opencode-wire';
import { kiloServerReport } from '../src/mapping.ts';
import { discoverKiloStore, readKiloHistory } from '../src/store.ts';

let passed = 0;
const check = (name: string, condition: unknown, detail = ''): void => {
  assert.ok(condition, `${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`PASS  ${name}`);
};

type StoredRow = { id: string; session_id: string; message_id?: string; time_created: number; time_updated: number; data: any };
interface Capture {
  sessionID: string;
  frames: any[];
  stored: { message: StoredRow[]; part: StoredRow[] };
}
const fixture = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'kilo-synthetic-rows.json'), 'utf8'));
const v8 = fixture['v7.8.32'] as Record<string, Capture> & { offline: any[]; scheduledStatusRead: Record<string, any> };
const v5 = fixture['v7.5.16'] as Record<string, Capture>;

const userRows = (capture: Capture) => capture.stored.message.filter((row) => row.data.role === 'user');
const partsOf = (capture: Capture, messageId: string) => capture.stored.part
  .filter((row) => row.message_id === messageId)
  .map((row) => ({ ...row.data, id: row.id, messageID: row.message_id, sessionID: row.session_id }));
/** The captured user row Kilo wrote itself: the one whose parts are all synthetic. */
const reportRowOf = (capture: Capture) => userRows(capture).find((row) =>
  partsOf(capture, row.id).every((part) => part.synthetic === true))!;
const promptRowOf = (capture: Capture) => userRows(capture).find((row) => row !== reportRowOf(capture))!;

// ---------------------------------------------------------------- the mark
{
  const background = kiloServerReport(partsOf(v8.background, reportRowOf(v8.background).id));
  check('7.8.32: a background task completion is Kilo\'s report, named as a background task',
    background?.source === 'Kilo background task' && background.body.startsWith('<task id="')
      && background.body.includes('BG_DONE_7'), JSON.stringify(background));
  const legacy = kiloServerReport(partsOf(v5.background, reportRowOf(v5.background).id));
  check('7.5.16 (installed today): the same completion carries the same mark',
    legacy?.source === 'Kilo background task' && legacy.body.includes('BG_DONE_7'), JSON.stringify(legacy));
  const wakeup = kiloServerReport(partsOf(v8.wakeup, reportRowOf(v8.wakeup).id));
  check('7.8.32: a scheduled wakeup is Kilo\'s report, named as a wakeup',
    wakeup?.source === 'Kilo scheduled wakeup' && wakeup.body.startsWith('[scheduled wakeup]'), JSON.stringify(wakeup));
  const goalParts = partsOf(v8.goal, reportRowOf(v8.goal).id);
  check('7.8.32: a goal loop turn (synthetic, no background mark) is not accepted as Kilo\'s report',
    goalParts.length === 1 && goalParts[0].synthetic === true && goalParts[0].metadata === undefined
      && kiloServerReport(goalParts) === undefined);
  const prompt = partsOf(v8.background, promptRowOf(v8.background).id);
  const report = partsOf(v8.background, reportRowOf(v8.background).id)[0];
  check('an ordinary prompt, a report beside typed text, a report beside a file, no parts, and a report whose '
    + 'background mark is false are all refused (test-made variants of the captured parts)',
    kiloServerReport(prompt) === undefined
      && kiloServerReport([report, prompt[0]]) === undefined
      && kiloServerReport([report, { type: 'file', url: 'data:image/png;base64,AA==', mime: 'image/png' }]) === undefined
      && kiloServerReport([]) === undefined
      && kiloServerReport([{ ...report, metadata: { background: false } }]) === undefined
      && kiloServerReport([{ ...report, synthetic: false }]) === undefined);
}

// ---------------------------------------------------------------- stored history (kilo.db)
async function storedHistory(capture: Capture): Promise<AgentMessage[]> {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-kilo-report-'));
  try {
    const dataRoot = join(root, 'data');
    mkdirSync(dataRoot, { recursive: true });
    const database = new Database(join(dataRoot, 'kilo.db'), { create: true });
    database.exec('pragma journal_mode = WAL;');
    database.exec(`
      create table migration (id integer primary key, name text);
      create table session (
        id text primary key, parent_id text, slug text, directory text, title text,
        model text, revert text, agent text, time_created integer, time_updated integer, time_archived integer
      );
      create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text);
      create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);
    `);
    database.query('insert into migration (id, name) values (1, ?)').run('opencode-lineage');
    const last = Math.max(...capture.stored.message.map((row) => row.time_updated));
    database.query(`insert into session values (?, null, 'capture', ?, 'Captured session', null, null, 'code', ?, ?, null)`)
      .run(capture.sessionID, join(root, 'workspace'), capture.stored.message[0]!.time_created, last);
    for (const row of capture.stored.message) {
      database.query('insert into message values (?, ?, ?, ?, ?)')
        .run(row.id, row.session_id, row.time_created, row.time_updated, JSON.stringify(row.data));
    }
    for (const row of capture.stored.part) {
      database.query('insert into part values (?, ?, ?, ?, ?, ?)')
        .run(row.id, row.message_id!, row.session_id, row.time_created, row.time_updated, JSON.stringify(row.data));
    }
    database.close();
    const [session] = await discoverKiloStore({ env: { KILO_DATA_DIR: dataRoot }, homeDir: root });
    assert.ok(session, 'the captured store is discovered');
    const snapshot = await readKiloHistory(session!);
    assert.ok(snapshot, 'the captured store reads');
    return snapshot!.messages;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const contextRows = (messages: AgentMessage[]) => messages.filter((message) =>
  message.type === 'event' && message.name === CONTEXT_INJECTION_EVENT
  && (message.payload as { source?: string }).source?.startsWith('Kilo '));
const userKeys = (messages: AgentMessage[]) => messages.flatMap((message) =>
  message.type === 'user-message' && message.key ? [message.key] : []);

const storedReports = new Map<string, AgentMessage>();
for (const [label, capture] of [['7.8.32 background', v8.background], ['7.5.16 background', v5.background],
  ['7.8.32 wakeup', v8.wakeup]] as const) {
  const messages = await storedHistory(capture);
  const reports = contextRows(messages);
  storedReports.set(label, reports[0]!);
  check(`${label}: kilo.db projects the report as one context row and only the real prompt as a user message, `
    + 'so the store\'s foreign-prompt check sees no stranger',
    reports.length === 1 && same(userKeys(messages), [promptRowOf(capture).id])
      && messages.some((message) => message.type === 'model-output' && /ACK_BG|WOKEN/u.test(message.text ?? '')),
    JSON.stringify({ reports, users: userKeys(messages) }));
}
{
  const messages = await storedHistory(v8.goal);
  check('7.8.32 goal: kilo.db keeps the goal turn\'s row a user message (it stays another writer\'s)',
    contextRows(messages).length === 0 && userKeys(messages).includes(reportRowOf(v8.goal).id));
}

// ---------------------------------------------------------------- the live connection
function same(actual: unknown, expected: unknown): boolean {
  try { assert.deepStrictEqual(actual, expected); return true; } catch { return false; }
}
const flush = async (): Promise<void> => { for (let turn = 0; turn < 6; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve)); };
const until = async (what: string, ready: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const startedAt = Date.now();
  while (!ready()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
};

interface Live {
  connection: OpenCodeLiveConnection;
  messages: AgentMessage[];
  unavailable: string[];
  reconciled: string[][];
  emit(frame: unknown): void;
}

/** A Drive attached after the capture's first turn: the rows of that turn are already proved its own. */
async function attach(capture: Capture, proved: Iterable<string>): Promise<Live> {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const httpHistory = capture.stored.message.map((row) => ({
    info: { ...row.data, id: row.id, sessionID: row.session_id },
    parts: partsOf(capture, row.id),
  }));
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname === '/global/event') {
      return new Response(new ReadableStream<Uint8Array>({
        start(next) {
          controller = next;
          next.enqueue(encoder.encode(': ready\n\n'));
          init.signal?.addEventListener('abort', () => next.error(init.signal?.reason), { once: true });
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.pathname === `/session/${capture.sessionID}/message`) return Response.json(httpHistory);
    return Response.json({ error: 'not in fixture' }, { status: 404 });
  }) as typeof fetch;
  const provedIds = new Set(proved);
  const unavailable: string[] = [];
  const reconciled: string[][] = [];
  const ownership: OpenCodeLiveOwnershipHooks = {
    beforeMutation: async () => {},
    knownUserRow: (id) => provedIds.has(id),
    promptClaimed: () => {},
    promptRejected: () => {},
    reconcileHistory: (ids) => { reconciled.push([...ids]); },
    sessionSettled: () => {},
    onUnavailable: (reason) => { unavailable.push(reason); },
    onClose: () => {},
  };
  const info: SessionInfo = {
    id: capture.sessionID, nativeId: capture.sessionID, tool: 'kilo', title: 'Captured', status: 'idle', attachMode: 'live',
  } as SessionInfo;
  const connection = new OpenCodeLiveConnection({
    baseUrl: 'http://127.0.0.1:1',
    info,
    dialect: { productId: 'kilo', displayName: 'Kilo Code', serverReport: kiloServerReport },
    fetch: fetcher,
    ownership,
  });
  const messages: AgentMessage[] = [];
  connection.subscribe((message) => { messages.push(message); });
  connection.start();
  await connection.ready;
  return {
    connection, messages, unavailable, reconciled,
    emit: (frame) => controller!.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`)),
  };
}

/** The frames after the capture's first turn closed: from there on Kilo started every turn itself. */
const afterFirstTurn = (capture: Capture) => {
  const close = capture.frames.findIndex((frame) => frame.payload.type === 'session.turn.close');
  return capture.frames.slice(close + 1);
};
const firstTurnRows = (capture: Capture) => {
  const prompt = promptRowOf(capture).id;
  return [prompt, ...capture.stored.message
    .filter((row) => row.data.role === 'assistant' && row.data.parentID === prompt).map((row) => row.id)];
};
const liveReports = (live: Live) => contextRows(live.messages);

for (const [label, capture, source] of [
  ['7.8.32 background', v8.background, 'Kilo background task'],
  ['7.5.16 background', v5.background, 'Kilo background task'],
  ['7.8.32 wakeup', v8.wakeup, 'Kilo scheduled wakeup'],
] as const) {
  const live = await attach(capture, firstTurnRows(capture));
  for (const frame of afterFirstTurn(capture)) live.emit(frame);
  await until(`${label} replay`, () => live.messages.some((message) =>
    message.type === 'model-output' && /ACK_BG|WOKEN/u.test(message.text ?? message.delta ?? '')));
  await flush();
  const report = reportRowOf(capture).id;
  check(`${label}: Kilo's own turn keeps Drive — the re-announced proved prompt, the report row and its own `
    + 'later re-announcement revoke nothing',
    live.unavailable.length === 0 && live.connection.info.attachMode === 'live', live.unavailable.join(' | '));
  check(`${label}: the report shows once as a "${source}" context row, never as a user message`,
    liveReports(live).length === 1 && (liveReports(live)[0]!.payload as any).source === source
      && !live.messages.some((message) => message.type === 'user-message' && message.key === report));
  check(`${label}: the live context row is exactly the row kilo.db history projects`,
    same(liveReports(live)[0], storedReports.get(label)));
  const history = await live.connection.getHistory();
  check(`${label}: HTTP history projects the same context row and hands only real prompts to ownership`,
    same(contextRows(history), [storedReports.get(label)])
      && same(live.reconciled.at(-1), [promptRowOf(capture).id]), JSON.stringify(live.reconciled));
  await live.connection.close();
}

{
  const live = await attach(v8.goal, firstTurnRows(v8.goal));
  for (const frame of afterFirstTurn(v8.goal)) live.emit(frame);
  await until('the goal row verdict', () => live.unavailable.length > 0);
  check('7.8.32 goal: a goal loop turn\'s row still ends Drive as another writer\'s prompt, with no context row',
    /another writer/u.test(live.unavailable[0]!) && liveReports(live).length === 0, live.unavailable.join(' | '));
  await live.connection.close();
}

{
  // A real second writer: the captured envelope, then the same part with Kilo's mark removed (test-made).
  const capture = v8.background;
  const live = await attach(capture, firstTurnRows(capture));
  const frames = afterFirstTurn(capture);
  const reportId = reportRowOf(capture).id;
  const envelope = frames.find((frame) => frame.payload.type === 'message.updated'
    && frame.payload.properties.info.id === reportId)!;
  const part = frames.find((frame) => frame.payload.type === 'message.part.updated'
    && frame.payload.properties.part.messageID === reportId)!;
  live.emit(envelope);
  await flush();
  check('an unclaimed user envelope alone revokes nothing yet: its parts decide',
    live.unavailable.length === 0);
  let refused: unknown;
  try {
    await live.connection.sendPrompt({ text: 'while the row is unverified' });
  } catch (error) { refused = error; }
  check('a mutation while the row is unverified is refused without ending Drive',
    refused instanceof OpenCodeLiveOwnershipUnprovenError && live.unavailable.length === 0, String(refused));
  const typed = structuredClone(part);
  delete typed.payload.properties.part.synthetic;
  delete typed.payload.properties.part.metadata;
  typed.payload.properties.part.text = 'a prompt typed in another Kilo client';
  live.emit(typed);
  await until('the typed part verdict', () => live.unavailable.length > 0);
  check('the same row with a typed part ends Drive as another writer\'s prompt, and shows no context row',
    /another writer/u.test(live.unavailable[0]!) && liveReports(live).length === 0);
  await live.connection.close();
}

{
  // An envelope whose parts never come (test-made id) is unproven, and counts as another writer's.
  const capture = v8.background;
  const live = await attach(capture, firstTurnRows(capture));
  const envelope = structuredClone(afterFirstTurn(capture).find((frame) => frame.payload.type === 'message.updated'
    && frame.payload.properties.info.role === 'user' && frame.payload.properties.info.id === reportRowOf(capture).id)!);
  envelope.payload.properties.info.id = 'msg_partless_fixture';
  const startedAt = Date.now();
  live.emit(envelope);
  await until('the part-less row verdict', () => live.unavailable.length > 0, 5_000);
  check('an unclaimed user row that shows no part within its window ends Drive',
    /another writer/u.test(live.unavailable[0]!) && Date.now() - startedAt >= 1_900, `${Date.now() - startedAt} ms`);
  await live.connection.close();
}

{
  // T1 finding: the prompt row is announced again right after its turn closes. A Drive that attached in
  // between holds no claim for it; having proved it, it keeps Drive. Unproved, the same frame still revokes.
  const capture = v8.turns;
  const close = capture.frames.findIndex((frame) => frame.payload.type === 'session.turn.close');
  const reannounce = capture.frames.slice(close + 1).find((frame) => frame.payload.type === 'message.updated'
    && frame.payload.properties.info.role === 'user')!;
  const provedLive = await attach(capture, firstTurnRows(capture));
  provedLive.emit(reannounce);
  await flush();
  check('7.8.32: a proved prompt announced again after its turn keeps Drive',
    reannounce.payload.properties.info.id === promptRowOf(capture).id && provedLive.unavailable.length === 0);
  await provedLive.connection.close();
  const v5close = v5.turns.frames.findIndex((frame) => frame.payload.type === 'session.turn.close');
  const v5reannounce = v5.turns.frames.slice(v5close + 1).find((frame) => frame.payload.type === 'message.updated'
    && frame.payload.properties.info.role === 'user')!;
  const v5Live = await attach(v5.turns, firstTurnRows(v5.turns));
  v5Live.emit(v5reannounce);
  await flush();
  check('7.5.16: the same re-announcement keeps Drive', v5Live.unavailable.length === 0);
  await v5Live.connection.close();
}

{
  const capture = v8.background;
  const live = await attach(capture, []);
  for (const frame of v8.offline) live.emit({ ...frame, payload: { ...frame.payload, properties: { ...frame.payload.properties, sessionID: capture.sessionID } } });
  await until('the offline status', () => live.messages.some((message) => message.type === 'metadata-update'
    && (message.value as any)?.status === 'working'));
  const statuses = live.messages.flatMap((message) => message.type === 'metadata-update' && (message.value as any)?.status
    ? [(message.value as any).status] : []);
  check('7.8.32: `offline` (model provider unreachable, Kilo retrying) reads as working, never idle',
    v8.offline.some((frame) => frame.payload.properties.status?.type === 'offline')
      && statuses.length > 0 && statuses.every((status) => status === 'working'), JSON.stringify(statuses));
  await live.connection.close();
}

check('7.8.32: a pending wakeup is listed as `scheduled` only on the status read (it maps to idle)',
  Object.values(v8.scheduledStatusRead).some((status: any) => status.type === 'scheduled'));

console.log(`\n${passed} passed`);
process.exit(0);
