#!/usr/bin/env bun
export {};
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage, HistorySourceIdentity, SessionInfo } from '@cosyncing/adapter-api';
import {
  isReasonixDurablePromptEcho,
  mapReasonixSessionUpdate,
  ReasonixDriveConnection,
  type ReasonixAcpTransport,
  type ReasonixDriveOpenOptions,
} from '../src/drive.ts';
import { ReasonixCorrelationRegistry } from '../src/correlation.ts';
import { ReasonixObserveConnection } from '../src/observe.ts';
import type { AcpRequestPermissionParams, AcpSessionUpdateParams } from '@cosyncing/acp-client';
import type { ReasonixDisplayEntry, ReasonixTranscriptRecord } from '../src/mapping.ts';
import type {
  ReasonixApprovalMode,
  ReasonixSessionUsage,
  ReasonixStoredSession,
  ReasonixTranscriptRead,
} from '../src/store.ts';
import { readReasonixTranscript, reasonixHistorySourceIdentity } from '../src/store.ts';

class TestDriveConnection extends ReasonixDriveConnection {
  constructor(
    session: ReasonixStoredSession,
    info: SessionInfo,
    transport: ReasonixAcpTransport,
    options: ReasonixDriveOpenOptions = {},
  ) {
    super(session, info, transport, options);
  }

  pushDurableUser(
    record: ReasonixTranscriptRecord,
    display: ReasonixDisplayEntry,
    messages: AgentMessage[],
  ): void {
    this.onTailRecord(record, display.index, display, messages);
  }

  pushHistorySnapshot(
    records: ReasonixTranscriptRecord[],
    displayEntries: ReasonixDisplayEntry[],
    messages: AgentMessage[],
    byteLength: number,
  ): void {
    this.onHistorySnapshot(records, displayEntries, messages, byteLength);
  }

  rewriteHistory(): void {
    this.onHistoryRewrite();
  }

  pushStatus(params: unknown): void {
    this.acceptStatusExtension({ method: '_reasonix.io/session/status_update', params });
  }

  pushNativeMetadata(mode: ReasonixApprovalMode, usage: ReasonixSessionUsage): void {
    this.recordCurrentMode(mode);
    this.recordSessionUsage(usage);
  }

  pushAuthoritativeMode(mode: ReasonixApprovalMode): void {
    this.recordAuthoritativeMode(mode);
  }

  pushUpdate(params: AcpSessionUpdateParams): void {
    this.acceptUpdate(params);
  }

  clearPendingCreateForTest(): void {
    (this as unknown as { pendingCreate?: ReasonixDriveOpenOptions['pendingCreate'] }).pendingCreate = undefined;
  }

  /** A delivered turn whose ACP return and durable user-row claim have both happened. */
  seedResolvedDrivenTurnForTest(key: string, userIndex: number): void {
    (this as unknown as { drivenTurns?: Map<string, { userIndex?: number; resolved: boolean }> })
      .drivenTurns?.set(key, { userIndex, resolved: true });
  }

  askPermission(params: AcpRequestPermissionParams) {
    return this.requestPermission(params);
  }
}

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}

type RunSummaryFrame = Extract<AgentMessage, { type: 'run-summary' }>;
function runSummaries(frames: readonly AgentMessage[], status?: RunSummaryFrame['status']): RunSummaryFrame[] {
  return frames.filter((frame): frame is RunSummaryFrame => frame.type === 'run-summary'
    && (status === undefined || frame.status === status));
}
/**
 * The broker attention policy's run rule (`handleRunSummary`), reduced to its
 * pairing: a live `running` opens an observation by key, the next terminal with
 * that key closes it, and only `done` or `error` notifies.
 */
function runNotifications(frames: readonly AgentMessage[]): string[] {
  const observed = new Set<string>();
  const notified: string[] = [];
  for (const frame of runSummaries(frames)) {
    if (frame.status === 'running') {
      observed.add(frame.key);
      continue;
    }
    if (!observed.delete(frame.key)) continue;
    if (frame.status === 'done' || frame.status === 'error') notified.push(`${frame.status}:${frame.key}`);
  }
  return notified;
}

class FakeTransport implements ReasonixAcpTransport {
  alive = true;
  prompts: string[] = [];
  cancels: string[] = [];
  closed = false;
  private release?: () => void;
  private finished = false;

  async sessionPrompt(params: { sessionId: string; prompt: Array<{ type: string; text?: string }> }) {
    this.prompts.push(params.prompt[0]?.text ?? '');
    if (!this.finished) await new Promise<void>((resolve) => { this.release = resolve; });
    if (this.closed) throw new Error('fake transport closed');
    return { stopReason: 'end_turn' };
  }
  sessionCancel(sessionId: string): void { this.cancels.push(sessionId); }
  finish(): void { this.finished = true; this.release?.(); }
  async close(): Promise<void> { this.closed = true; this.alive = false; this.finish(); }
}

class ThrowingCancelTransport extends FakeTransport {
  override sessionCancel(): void { throw new Error('fixture EPIPE'); }
}

const root = mkdtempSync(join(tmpdir(), 'cosyncing-reasonix-drive-'));
const dir = join(root, 'sessions');
mkdirSync(dir);
const id = 'drive-session';
const transcriptPath = join(dir, `${id}.jsonl`);
const displayIndexPath = join(dir, `${id}.display-index.json`);
const eventIndexPath = join(dir, `${id}.event-index.json`);
const initial = [
  { role: 'user', content: 'same text', raw_content: 'same text', createdAt: 1 },
  { role: 'assistant', content: 'old answer', reasoning_content: '', workDurationMs: 1 },
];
const lines = initial.map((row) => JSON.stringify(row));
const offsets = [0, Buffer.byteLength(`${lines[0]}\n`)];
writeFileSync(transcriptPath, `${lines.join('\n')}\n`);
writeFileSync(displayIndexPath, `${JSON.stringify({ schema_version: 1, entries: [
  { index: 0, offset: offsets[0], length: Buffer.byteLength(`${lines[0]}\n`), role: 'user', authored_turn: 0 },
  { index: 1, offset: offsets[1], length: Buffer.byteLength(`${lines[1]}\n`), role: 'assistant', authored_turn: 0 },
] })}\n`);
writeFileSync(eventIndexPath, `${JSON.stringify({ schema_version: 1, log_size: Buffer.byteLength(`${lines.join('\n')}\n`), revision: 1 })}\n`);
writeFileSync(join(dir, `${id}.jsonl.meta`), `${JSON.stringify({ id, schema_version: 2 })}\n`);
writeFileSync(join(dir, `${id}.acp.json`), `${JSON.stringify({ sessionId: id, status: { state: 'idle' } })}\n`);

const session: ReasonixStoredSession = {
  id,
  title: 'Drive fixture',
  cwd: root,
  status: 'idle',
  driveEligible: true,
  layout: 'global',
  storeRoot: root,
  transcriptPath,
  metaPath: join(dir, `${id}.jsonl.meta`),
  acpMetadataPath: join(dir, `${id}.acp.json`),
  eventIndexPath,
  eventLogPath: join(dir, `${id}.events.jsonl`),
  displayIndexPath,
};
const info: SessionInfo = {
  id,
  nativeId: id,
  tool: 'reasonix',
  title: session.title,
  cwd: root,
  status: 'idle',
  attachMode: 'resume',
};

function writeDurableRows(rows: ReasonixTranscriptRecord[], revision: number, authoredTurns?: readonly number[]): {
  entries: ReasonixDisplayEntry[];
  byteLength: number;
} {
  const serialized = rows.map((row) => JSON.stringify(row));
  let byteLength = 0;
  const entries = serialized.map((line, index): ReasonixDisplayEntry => {
    const role = typeof rows[index]?.role === 'string' ? rows[index]!.role : 'unknown';
    const entry: ReasonixDisplayEntry = {
      index,
      offset: byteLength,
      length: Buffer.byteLength(`${line}\n`),
      role,
      authoredTurn: authoredTurns?.[index] ?? Math.floor(index / 2),
      ...(role === 'user' ? { startsTurn: true } : {}),
    };
    byteLength += Buffer.byteLength(`${line}\n`);
    return entry;
  });
  writeFileSync(transcriptPath, `${serialized.join('\n')}\n`);
  writeFileSync(displayIndexPath, `${JSON.stringify({
    schema_version: 1,
    revision,
    revision_known: true,
    transcript_size: byteLength,
    entries: entries.map((entry) => ({
      index: entry.index,
      offset: entry.offset,
      length: entry.length,
      role: entry.role,
      authored_turn: entry.authoredTurn,
      ...(entry.startsTurn === undefined ? {} : { starts_turn: entry.startsTurn }),
    })),
  })}\n`);
  writeFileSync(eventIndexPath, `${JSON.stringify({ schema_version: 1, log_size: 0, revision })}\n`);
  return { entries, byteLength };
}

function restoreOriginalInitialRows(): void {
  writeFileSync(transcriptPath, `${lines.join('\n')}\n`);
  writeFileSync(displayIndexPath, `${JSON.stringify({ schema_version: 1, entries: [
    { index: 0, offset: offsets[0], length: Buffer.byteLength(`${lines[0]}\n`), role: 'user', authored_turn: 0 },
    { index: 1, offset: offsets[1], length: Buffer.byteLength(`${lines[1]}\n`), role: 'assistant', authored_turn: 0 },
  ] })}\n`);
  writeFileSync(eventIndexPath, `${JSON.stringify({
    schema_version: 1,
    log_size: Buffer.byteLength(`${lines.join('\n')}\n`),
    revision: 1,
  })}\n`);
}

try {
  const boundedRegistry = new ReasonixCorrelationRegistry({ maxSessions: 1, maxEntriesPerSession: 1 });
  const boundedRows: ReasonixTranscriptRecord[] = [
    { role: 'user', raw_content: 'bounded first' },
    { role: 'user', raw_content: 'bounded second' },
  ];
  const boundedLines = boundedRows.map((row) => `${JSON.stringify(row)}\n`);
  const boundedEntries: ReasonixDisplayEntry[] = [
    { index: 0, offset: 0, length: Buffer.byteLength(boundedLines[0]!), role: 'user' },
    {
      index: 1,
      offset: Buffer.byteLength(boundedLines[0]!),
      length: Buffer.byteLength(boundedLines[1]!),
      role: 'user',
    },
  ];
  const boundedRead: ReasonixTranscriptRead = {
    records: boundedRows,
    displayEntries: boundedEntries,
    issues: [],
    byteLength: Buffer.byteLength(boundedLines.join('')),
    durablePrefixBytes: Buffer.from(boundedLines.join('')),
  };
  const boundedIdentity: HistorySourceIdentity = {
    sourceId: 'bounded-source',
    revision: '1',
    appendPosition: boundedRead.byteLength,
  };
  boundedRegistry.remember('bounded-session', boundedRead, boundedIdentity, boundedEntries[0]!, 'bounded first', {
    key: 'queued:first',
    clientKey: 'client:first',
  });
  boundedRegistry.remember('bounded-session', boundedRead, boundedIdentity, boundedEntries[1]!, 'bounded second', {
    key: 'queued:second',
    clientKey: 'client:second',
  });
  const evictedEntryMessages: AgentMessage[] = [{
    type: 'user-message',
    key: 'reasonix:bounded-session:message:0',
    text: 'bounded first',
  }];
  const retainedEntryMessages: AgentMessage[] = [{
    type: 'user-message',
    key: 'reasonix:bounded-session:message:1',
    text: 'bounded second',
  }];
  boundedRegistry.applyRecord(
    'bounded-session', boundedRead, boundedIdentity, boundedRows[0]!, 0, boundedEntries[0], evictedEntryMessages,
  );
  boundedRegistry.applyRecord(
    'bounded-session', boundedRead, boundedIdentity, boundedRows[1]!, 1, boundedEntries[1], retainedEntryMessages,
  );
  boundedRegistry.remember('replacement-session', boundedRead, boundedIdentity, boundedEntries[1]!, 'bounded second', {
    key: 'queued:replacement',
  });
  const evictedSessionMessages: AgentMessage[] = [{
    type: 'user-message',
    key: 'reasonix:bounded-session:message:1',
    text: 'bounded second',
  }];
  boundedRegistry.applyRecord(
    'bounded-session', boundedRead, boundedIdentity, boundedRows[1]!, 1, boundedEntries[1], evictedSessionMessages,
  );
  // Reasonix prepends its own turn-routing block to the user record it
  // persists, so the durable text is not the text we sent. Measured on a
  // reattached session: the drive matched its own prompt echo against a string
  // starting `<capability-route` and demoted itself on a foreign user write
  // that was the agent talking to itself.
  const routeBlock = '<capability-route version="1">\n'
    + 'Relevant capabilities for this turn:\n'
    + '- source:skills require: the user explicitly referenced this skill\n'
    + '</capability-route>\n\n';
  const sentPrompt = 'Use your shell tool to run exactly: rm -f /tmp/marker && touch /tmp/marker.';
  check('a durable echo carrying Reasonix\u2019s own capability-route preamble is still this prompt',
    isReasonixDurablePromptEcho(`${routeBlock}${sentPrompt}`, sentPrompt));
  check('the preamble is tolerated alongside the one trailing newline ACP already strips',
    isReasonixDurablePromptEcho(`${routeBlock}${sentPrompt}`, `${sentPrompt}\n`));
  check('an unprefixed exact echo still matches, and an unrelated row still does not',
    isReasonixDurablePromptEcho(sentPrompt, sentPrompt)
      && !isReasonixDurablePromptEcho(`${routeBlock}totally different text`, sentPrompt)
      && !isReasonixDurablePromptEcho('totally different text', sentPrompt)
      && !isReasonixDurablePromptEcho(undefined, sentPrompt));
  check('stripping is anchored to a closed leading block, not any mention of the tag',
    !isReasonixDurablePromptEcho(`prefix <capability-route version="1"></capability-route>\n${sentPrompt}`, sentPrompt)
      && !isReasonixDurablePromptEcho(`<capability-route version="1">\n${sentPrompt}`, sentPrompt));
  check('the shared correlation registry enforces per-session and session-count bounds',
    evictedEntryMessages[0]?.type === 'user-message'
      && evictedEntryMessages[0].key === 'reasonix:bounded-session:message:0'
      && retainedEntryMessages[0]?.type === 'user-message'
      && retainedEntryMessages[0].key === 'queued:second'
      && retainedEntryMessages[0].clientKey === 'client:second'
      && evictedSessionMessages[0]?.type === 'user-message'
      && evictedSessionMessages[0].key === 'reasonix:bounded-session:message:1',
    JSON.stringify({ evictedEntryMessages, retainedEntryMessages, evictedSessionMessages }));

  const currentCorrelationSnapshot = async () => {
    const [read, identity] = await Promise.all([
      readReasonixTranscript(session),
      reasonixHistorySourceIdentity(session),
    ]);
    if (!identity) throw new Error('correlation fixture has no stable history identity');
    return { read, identity };
  };
  const rememberFirstFixtureRow = async (
    registry: ReasonixCorrelationRegistry,
    value: { key: string; clientKey?: string },
  ) => {
    const snapshot = await currentCorrelationSnapshot();
    const display = snapshot.read.displayEntries[0];
    const record = snapshot.read.records[0];
    const text = typeof record?.raw_content === 'string' ? record.raw_content
      : typeof record?.content === 'string' ? record.content
        : undefined;
    if (!display || text === undefined) throw new Error('correlation fixture first row is incomplete');
    registry.remember(session.id, snapshot.read, snapshot.identity, display, text, value);
  };

  const historyFirstRegistry = new ReasonixCorrelationRegistry();
  const historyFirstObserve = new ReasonixObserveConnection({
    session, info, correlationRegistry: historyFirstRegistry,
  });
  const historyFirstReplay = await historyFirstObserve.getHistory();
  const historyFirstLive: AgentMessage[] = [];
  historyFirstObserve.subscribe((message) => historyFirstLive.push(message));
  await rememberFirstFixtureRow(historyFirstRegistry, {
    key: 'queued:observe-first-history',
    clientKey: 'client:observe-first-history',
  });
  const historyFirstRepaired = await historyFirstObserve.getHistory();
  check('an Observe-first history replay is reset and repaired when Drive later records correlation',
    historyFirstReplay.some((message) => message.type === 'user-message'
      && message.key === `reasonix:${id}:message:0`)
      && historyFirstLive.filter((message) => message.type === 'history-reset').length === 1
      && historyFirstRepaired.some((message) => message.type === 'user-message'
        && message.key === 'queued:observe-first-history'
        && message.clientKey === 'client:observe-first-history'
        && message.queued === false),
    JSON.stringify({ historyFirstLive, historyFirstRepaired }));
  await historyFirstObserve.close();

  const captureFirstRegistry = new ReasonixCorrelationRegistry();
  const captureFirstObserve = new ReasonixObserveConnection({
    session, info, correlationRegistry: captureFirstRegistry,
  });
  const captureBefore: AgentMessage[] = [];
  await captureFirstObserve.captureHistorySnapshot({
    accept(message) { captureBefore.push(message); return true; },
  });
  const captureFirstLive: AgentMessage[] = [];
  captureFirstObserve.subscribe((message) => captureFirstLive.push(message));
  await rememberFirstFixtureRow(captureFirstRegistry, {
    key: 'queued:observe-first-capture',
    clientKey: 'client:observe-first-capture',
  });
  const captureAfter: AgentMessage[] = [];
  await captureFirstObserve.captureHistorySnapshot({
    accept(message) { captureAfter.push(message); return true; },
  });
  check('an Observe-first indexed capture is reset and repaired after later Drive correlation',
    captureBefore.some((message) => message.type === 'user-message'
      && message.key === `reasonix:${id}:message:0`)
      && captureFirstLive.filter((message) => message.type === 'history-reset').length === 1
      && captureAfter.some((message) => message.type === 'user-message'
        && message.key === 'queued:observe-first-capture'
        && message.clientKey === 'client:observe-first-capture'
        && message.queued === false),
    JSON.stringify({ captureFirstLive, captureAfter }));
  await captureFirstObserve.close();

  writeDurableRows(initial, 89);
  const tailFirstRegistry = new ReasonixCorrelationRegistry();
  const tailFirstObserve = new ReasonixObserveConnection({ session, info, correlationRegistry: tailFirstRegistry });
  await tailFirstObserve.getHistory();
  const tailFirstLive: AgentMessage[] = [];
  tailFirstObserve.subscribe((message) => tailFirstLive.push(message));
  const tailFirstRecord: ReasonixTranscriptRecord = {
    role: 'user', content: 'observe-first tail', raw_content: 'observe-first tail', createdAt: 9,
  };
  writeDurableRows([...initial, tailFirstRecord], 90);
  await waitFor(() => tailFirstLive.some((message) => message.type === 'user-message'
    && message.text === 'observe-first tail'));
  const tailFirstSnapshot = await currentCorrelationSnapshot();
  const tailFirstDisplay = tailFirstSnapshot.read.displayEntries[2];
  if (!tailFirstDisplay) throw new Error('correlation tail fixture has no display row');
  const resetsBeforeTailCorrelation = tailFirstLive.filter((message) => message.type === 'history-reset').length;
  tailFirstRegistry.remember(
    session.id,
    tailFirstSnapshot.read,
    tailFirstSnapshot.identity,
    tailFirstDisplay,
    'observe-first tail',
    { key: 'queued:observe-first-tail', clientKey: 'client:observe-first-tail' },
  );
  const tailFirstRepaired = await tailFirstObserve.getHistory();
  check('an Observe-first watcher tail is reset and repaired after later Drive correlation',
    tailFirstLive.some((message) => message.type === 'user-message'
      && message.text === 'observe-first tail'
      && message.key === `reasonix:${id}:message:2`)
      && tailFirstLive.filter((message) => message.type === 'history-reset').length
        === resetsBeforeTailCorrelation + 1
      && tailFirstRepaired.some((message) => message.type === 'user-message'
        && message.key === 'queued:observe-first-tail'
        && message.clientKey === 'client:observe-first-tail'
        && message.queued === false),
    JSON.stringify({ tailFirstLive, tailFirstRepaired }));
  await tailFirstObserve.close();
  writeDurableRows(initial, 91);

  const staggeredRecord: ReasonixTranscriptRecord = {
    role: 'user', content: 'staggered second row', raw_content: 'staggered second row', createdAt: 12,
  };
  writeDurableRows([...initial, staggeredRecord], 96);
  const staggeredSnapshot = await currentCorrelationSnapshot();
  const staggeredFirstDisplay = staggeredSnapshot.read.displayEntries[0];
  const staggeredSecondDisplay = staggeredSnapshot.read.displayEntries[2];
  if (!staggeredFirstDisplay || !staggeredSecondDisplay) {
    throw new Error('staggered correlation fixture is incomplete');
  }
  const staggeredRegistry = new ReasonixCorrelationRegistry();
  const staggeredObserve = new ReasonixObserveConnection({ session, info, correlationRegistry: staggeredRegistry });
  await staggeredObserve.getHistory();
  staggeredRegistry.remember(
    session.id,
    staggeredSnapshot.read,
    staggeredSnapshot.identity,
    staggeredFirstDisplay,
    'same text',
    { key: 'queued:staggered-first', clientKey: 'client:staggered-first' },
  );
  const staggeredFirstRepair = await staggeredObserve.getHistory();
  const staggeredLive: AgentMessage[] = [];
  staggeredObserve.subscribe((message) => staggeredLive.push(message));
  staggeredRegistry.remember(
    session.id,
    staggeredSnapshot.read,
    staggeredSnapshot.identity,
    staggeredSecondDisplay,
    'staggered second row',
    { key: 'queued:staggered-second', clientKey: 'client:staggered-second' },
  );
  const staggeredSecondRepair = await staggeredObserve.getHistory();
  check('repairing one deferred correlation retains a later uncorrelated row notification',
    staggeredFirstRepair.some((message) => message.type === 'user-message'
      && message.key === 'queued:staggered-first')
      && staggeredLive.filter((message) => message.type === 'history-reset').length === 1
      && staggeredSecondRepair.some((message) => message.type === 'user-message'
        && message.key === 'queued:staggered-second'
        && message.clientKey === 'client:staggered-second'),
    JSON.stringify({ staggeredLive, staggeredSecondRepair }));
  await staggeredObserve.close();

  const refusingRegistry = new ReasonixCorrelationRegistry();
  const refusingObserve = new ReasonixObserveConnection({ session, info, correlationRegistry: refusingRegistry });
  await refusingObserve.getHistory();
  refusingRegistry.remember(
    session.id,
    staggeredSnapshot.read,
    staggeredSnapshot.identity,
    staggeredFirstDisplay,
    'same text',
    { key: 'queued:refused-capture', clientKey: 'client:refused-capture' },
  );
  const refusedCapture = await refusingObserve.captureHistorySnapshot({ accept() { return false; } });
  const refusingLive: AgentMessage[] = [];
  refusingObserve.subscribe((message) => refusingLive.push(message));
  check('a resource-limited capture cannot consume a deferred correlation reset',
    refusedCapture !== undefined
      && 'refusal' in refusedCapture
      && refusedCapture.refusal === 'resource-limit'
      && refusingLive.filter((message) => message.type === 'history-reset').length === 1,
    JSON.stringify({ refusedCapture, refusingLive }));
  await refusingObserve.close();
  writeDurableRows(initial, 97);

  const demotedClaimRegistry = new ReasonixCorrelationRegistry();
  const demotedClaimTransport = new FakeTransport();
  const demotedClaimDrive = new TestDriveConnection(session, info, demotedClaimTransport, {
    correlationRegistry: demotedClaimRegistry,
  });
  await demotedClaimDrive.getHistory();
  const demotedClaimTurn = demotedClaimDrive.sendPrompt({
    text: 'claimed before demotion', clientMessageId: 'client:claimed-before-demotion',
  });
  await waitFor(() => demotedClaimTransport.prompts.length === 1);
  writeDurableRows([...initial, {
    role: 'user', content: 'claimed before demotion', raw_content: 'claimed before demotion', createdAt: 10,
  }], 92);
  const claimedBeforeDemotion = await demotedClaimDrive.getHistory();
  check('Drive establishes shared correlation before the non-rewrite demotion fixture',
    claimedBeforeDemotion.some((message) => message.type === 'user-message'
      && message.text === 'claimed before demotion'
      && message.clientKey === 'client:claimed-before-demotion'),
    JSON.stringify(claimedBeforeDemotion));
  demotedClaimTransport.finish();
  await demotedClaimTurn;
  demotedClaimDrive.demote('fixture non-rewrite demotion.');
  await demotedClaimDrive.getHistory();
  const afterClaimDemotionObserve = new ReasonixObserveConnection({
    session, info, correlationRegistry: demotedClaimRegistry,
  });
  const afterClaimDemotionHistory = await afterClaimDemotionObserve.getHistory();
  check('a non-rewrite demotion cannot republish an already claimed correlation on replay',
    afterClaimDemotionHistory.some((message) => message.type === 'user-message'
      && message.text === 'claimed before demotion'
      && message.key === `reasonix:${id}:message:2`
      && message.clientKey === undefined),
    JSON.stringify(afterClaimDemotionHistory));
  await afterClaimDemotionObserve.close();
  await demotedClaimDrive.close();

  writeDurableRows(initial, 93);
  const demotedPendingRegistry = new ReasonixCorrelationRegistry();
  const demotedPendingTransport = new FakeTransport();
  const demotedPendingDrive = new TestDriveConnection(session, info, demotedPendingTransport, {
    correlationRegistry: demotedPendingRegistry,
  });
  await demotedPendingDrive.getHistory();
  const demotedPendingTurn = demotedPendingDrive.sendPrompt({
    text: 'matching foreign row after demotion', clientMessageId: 'client:foreign-after-demotion',
  });
  void demotedPendingTurn.catch(() => {});
  await waitFor(() => demotedPendingTransport.prompts.length === 1);
  demotedPendingDrive.demote('fixture demotion with an accepted pending prompt.');
  writeDurableRows([...initial, {
    role: 'user',
    content: 'matching foreign row after demotion',
    raw_content: 'matching foreign row after demotion',
    createdAt: 11,
  }], 94);
  await demotedPendingDrive.getHistory();
  const afterPendingDemotionObserve = new ReasonixObserveConnection({
    session, info, correlationRegistry: demotedPendingRegistry,
  });
  const afterPendingDemotionHistory = await afterPendingDemotionObserve.getHistory();
  check('a matching durable row arriving after demotion never inherits the accepted pending correlation',
    afterPendingDemotionHistory.some((message) => message.type === 'user-message'
      && message.text === 'matching foreign row after demotion'
      && message.key === `reasonix:${id}:message:2`
      && message.clientKey === undefined)
      && demotedPendingDrive.getPending().some((message) => message.type === 'user-message'
        && message.clientKey === 'client:foreign-after-demotion'
        && message.queued === true),
    JSON.stringify({ afterPendingDemotionHistory, pending: demotedPendingDrive.getPending() }));
  await afterPendingDemotionObserve.close();
  await demotedPendingDrive.close();
  await demotedPendingTurn.catch(() => {});
  restoreOriginalInitialRows();

  const progressUpdate = mapReasonixSessionUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'progress-call',
    status: 'in_progress',
    rawOutput: { message: 'halfway' },
  });
  const failedUpdate = mapReasonixSessionUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'failed-call',
    title: 'Bash',
    status: 'failed',
    rawOutput: { message: 'blocked: context canceled' },
  });
  check('nonterminal tool updates do not masquerade as completed tool results',
    progressUpdate.length === 0
      && failedUpdate[0]?.type === 'tool-result'
      && failedUpdate[0].isError === true
      && failedUpdate[0].toolName === 'Bash',
    JSON.stringify({ progressUpdate, failedUpdate }));

  const oversizedToolCall = mapReasonixSessionUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'oversized-call',
    title: 'Bash',
    rawInput: { command: 'x'.repeat(70 * 1024) },
  })[0];
  const oversizedToolResult = mapReasonixSessionUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'oversized-call',
    title: 'Bash',
    status: 'completed',
    rawOutput: { output: 'y'.repeat(70 * 1024) },
  })[0];
  check('oversized ACP tool input and output are replaced by bounded omission markers',
    oversizedToolCall?.type === 'tool-call'
      && typeof oversizedToolCall.args === 'string'
      && oversizedToolCall.args.includes('exceeded 65536 bytes')
      && oversizedToolResult?.type === 'tool-result'
      && typeof oversizedToolResult.result === 'string'
      && oversizedToolResult.result.includes('exceeded 65536 bytes'),
    JSON.stringify({ oversizedToolCall, oversizedToolResult }));
  const oversizedToolIdentity = mapReasonixSessionUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'native-tool-id'.repeat(10_000),
    title: 'native tool title'.repeat(10_000),
  }, 'reasonix-tool:bounded-fallback')[0];
  check('oversized native tool ids and titles cannot become retained live identities',
    oversizedToolIdentity?.type === 'tool-call'
      && oversizedToolIdentity.callId === 'reasonix-tool:bounded-fallback'
      && oversizedToolIdentity.title === 'Reasonix tool',
    JSON.stringify(oversizedToolIdentity));

  const pendingIdentityTransport = new FakeTransport();
  const pendingIdentity = new TestDriveConnection(session, info, pendingIdentityTransport, {
    pendingCreate: { cwd: root, discover: async () => undefined },
  });
  const pendingIdentitySeen: AgentMessage[] = [];
  pendingIdentity.subscribe((message) => pendingIdentitySeen.push(message));
  const pendingIdentityTurn = pendingIdentity.sendPrompt({ text: 'first created prompt' });
  await waitFor(() => pendingIdentityTransport.prompts.length === 1);

  pendingIdentity.pushUpdate({
    sessionId: id,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'unkeyed first answer' } },
  });
  pendingIdentity.clearPendingCreateForTest();
  await sleep(150);
  pendingIdentity.pushUpdate({
    sessionId: id,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late unkeyed first answer' } },
  });
  pendingIdentity.pushUpdate({
    sessionId: id,
    update: { sessionUpdate: 'tool_call', toolCallId: 'pending-create-tool', title: 'Bash' },
  });
  await waitFor(() => pendingIdentitySeen.some((message) => message.type === 'tool-call'
    && message.callId === 'pending-create-tool'));
  check('the entire pending-create turn withholds keyless assistant chunks after materialization',
    !pendingIdentitySeen.some((message) => message.type === 'model-output')
      && pendingIdentitySeen.some((message) => message.type === 'tool-call'
        && message.callId === 'pending-create-tool'),
    JSON.stringify(pendingIdentitySeen));
  await pendingIdentity.close();
  await pendingIdentityTurn.catch(() => {});

  // R4: a first post-create turn reserves no assistant index (`reservePromptIndex` returns
  // undefined while `pendingCreate`), so `awaitingAssistantIndexes` is empty. The session is
  // legitimately WORKING at that moment, and EVERY working posture is `driveEligible: false`
  // (`store.ts:408`), so the drain's posture check read our own in-flight turn as another writer
  // and demoted — force-killing the ACP child mid-turn. Own connection and own posture writes, so
  // the materialization test above is untouched.
  const postureTransport = new FakeTransport();
  const postureIdentity = new TestDriveConnection(session, info, postureTransport, {
    pendingCreate: { cwd: root, discover: async () => undefined },
  });
  const postureSeen: AgentMessage[] = [];
  postureIdentity.subscribe((message) => postureSeen.push(message));
  const postureTurn = postureIdentity.sendPrompt({ text: 'first created prompt under a working posture' });
  await waitFor(() => postureTransport.prompts.length === 1);
  writeFileSync(join(dir, `${id}.acp.json`),
    `${JSON.stringify({ sessionId: id, status: { state: 'working' } })}\n`);
  await sleep(250);
  check('a first post-create turn is not demoted by its own working posture',
    !postureSeen.some((message) => message.type === 'notice'
      && /another active writer/u.test(String((message as { message?: string }).message ?? ''))),
    JSON.stringify(postureSeen.filter((m) => m.type === 'notice')));
  writeFileSync(join(dir, `${id}.acp.json`),
    `${JSON.stringify({ sessionId: id, status: { state: 'idle' } })}\n`);
  await postureIdentity.close();
  await postureTurn.catch(() => {});

  const transport = new FakeTransport();
  const correlationRegistry = new ReasonixCorrelationRegistry();
  const connection = new TestDriveConnection(session, info, transport, { correlationRegistry });
  const seen: AgentMessage[] = [];
  connection.subscribe((message) => seen.push(message));
  await connection.getHistory();

  const sending = connection.sendPrompt({ text: 'same text', clientMessageId: 'client-1' });
  const promptStarted = await waitFor(() => transport.prompts.length === 1);
  const pending = connection.getPending();
  check('prompt admission mints a queued row before the child completes',
    promptStarted
      && pending.length === 1
      && pending[0]?.type === 'user-message'
      && pending[0].queued === true
      && transport.prompts.length === 1,
    JSON.stringify(pending));
  connection.pushUpdate({
    sessionId: id,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'before tool' } },
  });
  connection.pushUpdate({
    sessionId: id,
    update: { sessionUpdate: 'tool_call', toolCallId: 'tool-boundary', title: 'Bash' },
  });
  connection.pushUpdate({
    sessionId: id,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after tool' } },
  });
  const beforeTool = seen.find((message) => message.type === 'model-output' && message.delta === 'before tool');
  const afterTool = seen.find((message) => message.type === 'model-output' && message.delta === 'after tool');
  check('post-tool live deltas omit an unproved durable assistant key',
    beforeTool?.type === 'model-output' && typeof beforeTool.key === 'string'
      && afterTool?.type === 'model-output' && afterTool.key === undefined,
    JSON.stringify({ beforeTool, afterTool }));
  const replay = await connection.getHistory();
  const replayedPending = replay.at(-1);
  const pendingRow = pending[0];
  check('the pending row survives a history replay with its client correlation',
    replayedPending?.type === 'user-message'
      && pendingRow?.type === 'user-message'
      && replayedPending.key === pendingRow.key
      && replayedPending.clientKey === 'client-1');

  const delivered = JSON.stringify({ role: 'user', content: 'same text', raw_content: 'same text', createdAt: 2 });
  const deliveredOffset = Buffer.byteLength(`${lines.join('\n')}\n`);
  appendFileSync(transcriptPath, `${delivered}\n`);
  writeFileSync(displayIndexPath, `${JSON.stringify({ schema_version: 1, entries: [
    { index: 0, offset: offsets[0], length: Buffer.byteLength(`${lines[0]}\n`), role: 'user', authored_turn: 0 },
    { index: 1, offset: offsets[1], length: Buffer.byteLength(`${lines[1]}\n`), role: 'assistant', authored_turn: 0 },
    { index: 2, offset: deliveredOffset, length: Buffer.byteLength(`${delivered}\n`), role: 'user', authored_turn: 1 },
  ] })}\n`);
  writeFileSync(eventIndexPath, `${JSON.stringify({ schema_version: 1, log_size: deliveredOffset + Buffer.byteLength(`${delivered}\n`), revision: 2 })}\n`);
  const raceReplay = await connection.getHistory();
  const replayedEchoes = raceReplay.filter(
    (message): message is Extract<AgentMessage, { type: 'user-message' }> => message.type === 'user-message',
  ).filter((message) => pendingRow?.type === 'user-message' && message.key === pendingRow.key);
  check('an immediate replay claims the durable echo without appending the queued row',
    connection.getPending().length === 0
      && replayedEchoes.length === 1
      && replayedEchoes[0]?.type === 'user-message'
      && replayedEchoes[0].queued === false
      && replayedEchoes[0].clientKey === 'client-1',
    JSON.stringify(replayedEchoes));
  await sleep(180);
  check('the watcher cannot resurrect a prompt already reconciled by replay',
    connection.getPending().length === 0);
  const secondReplay = await connection.getHistory();
  const secondEcho = secondReplay.find(
    (message): message is Extract<AgentMessage, { type: 'user-message' }> => message.type === 'user-message'
      && pendingRow?.type === 'user-message'
      && message.key === pendingRow.key,
  );
  check('every later replay reapplies the queued key and client correlation',
    secondEcho?.queued === false && secondEcho.clientKey === 'client-1',
    JSON.stringify(secondEcho));
  const lateObserve = new ReasonixObserveConnection({ session, info, correlationRegistry });
  const lateObserveReplay = await lateObserve.getHistory();
  const lateObserveEcho = lateObserveReplay.find(
    (message): message is Extract<AgentMessage, { type: 'user-message' }> => message.type === 'user-message'
      && message.text === 'same text'
      && message.sentAt === 2,
  );
  check('a fresh Observe replay keeps the Drive-assigned key and client correlation',
    pendingRow?.type === 'user-message'
      && lateObserveEcho?.key === pendingRow.key
      && lateObserveEcho?.clientKey === 'client-1'
      && lateObserveEcho?.queued === false,
    JSON.stringify(lateObserveEcho));
  await lateObserve.close();
  const echo = replayedEchoes[0];
  check('only a matching line beyond the byte fence claims the queued key',
    echo?.type === 'user-message'
      && pendingRow?.type === 'user-message'
      && echo.key === pendingRow.key
      && echo.clientKey === 'client-1',
    JSON.stringify(echo));
  transport.finish();
  await sending;

  const replacement = JSON.stringify({
    role: 'user',
    content: 'foreign replacement',
    raw_content: 'foreign replacement',
    createdAt: 3,
  });
  writeFileSync(transcriptPath, `${lines.join('\n')}\n${replacement}\n`);
  writeFileSync(displayIndexPath, `${JSON.stringify({ schema_version: 1, entries: [
    { index: 0, offset: offsets[0], length: Buffer.byteLength(`${lines[0]}\n`), role: 'user', authored_turn: 0 },
    { index: 1, offset: offsets[1], length: Buffer.byteLength(`${lines[1]}\n`), role: 'assistant', authored_turn: 0 },
    { index: 2, offset: deliveredOffset, length: Buffer.byteLength(`${replacement}\n`), role: 'user', authored_turn: 1 },
  ] })}\n`);
  writeFileSync(eventIndexPath, `${JSON.stringify({
    schema_version: 1,
    log_size: deliveredOffset + Buffer.byteLength(`${replacement}\n`),
    revision: 3,
  })}\n`);
  await sleep(180);
  const rewrittenReplay = await connection.getHistory();
  const replacementRow = rewrittenReplay.find(
    (message): message is Extract<AgentMessage, { type: 'user-message' }> => message.type === 'user-message'
      && message.text === 'foreign replacement',
  );
  check('a history rewrite clears old offset correlation before replay',
    replacementRow?.key === `reasonix:${id}:message:2`
      && replacementRow.clientKey === undefined
      && pendingRow?.type === 'user-message'
      && replacementRow.key !== pendingRow.key,
    JSON.stringify(replacementRow));
  const rewrittenObserve = new ReasonixObserveConnection({ session, info, correlationRegistry });
  const rewrittenObserveReplay = await rewrittenObserve.getHistory();
  const rewrittenObserveRow = rewrittenObserveReplay.find(
    (message): message is Extract<AgentMessage, { type: 'user-message' }> => message.type === 'user-message'
      && message.text === 'foreign replacement',
  );
  check('a fresh Observe cannot inherit correlation after the writer detects a rewrite',
    rewrittenObserveRow?.key === `reasonix:${id}:message:2`
      && rewrittenObserveRow.clientKey === undefined,
    JSON.stringify(rewrittenObserveRow));
  await rewrittenObserve.close();
  let rewrittenRejected = false;
  try { await connection.sendPrompt({ text: 'after rewrite' }); } catch { rewrittenRejected = true; }
  check('a history rewrite demotes and closes the writer before another prompt',
    seen.some((message) => message.type === 'history-reset')
      && transport.cancels.includes(id)
      && transport.closed
      && rewrittenRejected,
    JSON.stringify({ seen, cancels: transport.cancels, closed: transport.closed }));
  await connection.close();

  writeDurableRows(initial, 4);
  const unsettledToolTransport = new FakeTransport();
  const unsettledTool = new TestDriveConnection(session, info, unsettledToolTransport);
  await unsettledTool.getHistory();
  const unsettledFirst = unsettledTool.sendPrompt({ text: 'tool turn without durable finale' });
  await waitFor(() => unsettledToolTransport.prompts.length === 1);
  unsettledTool.pushUpdate({
    sessionId: id,
    update: { sessionUpdate: 'tool_call', toolCallId: 'unsettled-tool', title: 'Bash' },
  });
  writeDurableRows([
    ...initial,
    { role: 'user', content: 'tool turn without durable finale', raw_content: 'tool turn without durable finale' },
  ], 5);
  unsettledToolTransport.finish();
  await unsettledFirst;
  let unsettledSecondRefused = false;
  try { await unsettledTool.sendPrompt({ text: 'must wait for tool-turn rebase' }); } catch { unsettledSecondRefused = true; }
  check('a tool turn without a later durable assistant blocks the next guessed native index',
    unsettledSecondRefused
      && unsettledToolTransport.prompts.length === 1
      && !unsettledTool.driving,
    JSON.stringify(unsettledToolTransport.prompts));
  await unsettledTool.close();

  writeDurableRows(initial, 6);
  const rebasedToolTransport = new FakeTransport();
  const rebasedTool = new TestDriveConnection(session, info, rebasedToolTransport);
  await rebasedTool.getHistory();
  const rebasedFirst = rebasedTool.sendPrompt({ text: 'tool turn with durable finale' });
  await waitFor(() => rebasedToolTransport.prompts.length === 1);
  rebasedTool.pushUpdate({
    sessionId: id,
    update: { sessionUpdate: 'tool_call', toolCallId: 'rebased-tool', title: 'Bash' },
  });
  writeDurableRows([
    ...initial,
    { role: 'user', content: 'tool turn with durable finale', raw_content: 'tool turn with durable finale' },
    { role: 'tool', content: 'tool result' },
    { role: 'assistant', content: 'final answer after tool' },
  ], 7);
  rebasedToolTransport.finish();
  await rebasedFirst;
  await rebasedTool.sendPrompt({ text: 'safe after durable tool rebase' });
  check('a later durable assistant rebases the next tool-turn prompt onto the measured row count',
    rebasedToolTransport.prompts.length === 2 && rebasedTool.driving,
    JSON.stringify(rebasedToolTransport.prompts));
  await rebasedTool.close();

  writeDurableRows(initial, 8);

  const validDisplayAfterRewrite = readFileSync(displayIndexPath, 'utf8');
  writeFileSync(displayIndexPath, `${JSON.stringify({ schema_version: 1, entries: [] })}\n`);
  const incompleteIndexTransport = new FakeTransport();
  const incompleteIndex = ReasonixDriveConnection.fromTransport(session, info, incompleteIndexTransport);
  let incompleteHistoryRejected = false;
  try { await incompleteIndex.getHistory(); } catch { incompleteHistoryRejected = true; }
  let incompleteIndexRejected = false;
  try { await incompleteIndex.sendPrompt({ text: 'must not guess an index' }); } catch { incompleteIndexRejected = true; }
  check('an incomplete display index is refused by history and cannot pre-authorize Drive',
    incompleteHistoryRejected
      && incompleteIndexRejected
      && incompleteIndexTransport.prompts.length === 0
      && incompleteIndex.getPending().length === 0);
  await incompleteIndex.close();
  writeFileSync(displayIndexPath, validDisplayAfterRewrite);

  const deadTransport = new FakeTransport();
  deadTransport.alive = false;
  const dead = ReasonixDriveConnection.fromTransport(session, info, deadTransport);
  const countBeforeDeadSend = dead.getPending().length;
  let deadRejected = false;
  try { await dead.sendPrompt({ text: 'must not enqueue' }); } catch { deadRejected = true; }
  check('a send against a dead child rejects before touching pending state',
    deadRejected && dead.getPending().length === countBeforeDeadSend);
  await dead.close();

  let terminalErrorAlive = true;
  const terminalErrorTransport: ReasonixAcpTransport = {
    get alive() { return terminalErrorAlive; },
    async sessionPrompt() {
      writeDurableRows([
        ...initial,
        {
          role: 'user',
          content: 'durable native error',
          raw_content: 'durable native error',
          createdAt: 13,
        },
        { role: 'assistant', content: 'native tool failed', workDurationMs: 1 },
      ], 9);
      return { stopReason: 'error' };
    },
    sessionCancel() {},
    async close() { terminalErrorAlive = false; },
  };
  const terminalError = ReasonixDriveConnection.fromTransport(session, info, terminalErrorTransport);
  const terminalErrorSeen: AgentMessage[] = [];
  terminalError.subscribe((message) => terminalErrorSeen.push(message));
  await terminalError.getHistory();
  let terminalErrorRejected = false;
  try {
    await terminalError.sendPrompt({ text: 'durable native error', clientMessageId: 'native-error-client' });
  } catch { terminalErrorRejected = true; }
  const terminalErrorHistory = await terminalError.getHistory();
  check('a measured error stopReason with a durable user row is terminal without destroying Drive',
    !terminalErrorRejected
      && terminalError.driving
      && terminalErrorSeen.some((message) => message.type === 'error'
        && message.message === 'Reasonix ended the turn with an error.')
      && terminalErrorHistory.some((message) => message.type === 'user-message'
        && message.text === 'durable native error'
        && message.clientKey === 'native-error-client'),
    JSON.stringify({ terminalErrorSeen, terminalErrorHistory }));
  // The mapper stamps every durable footer `done`, and history must keep
  // agreeing with live by key, so a failed turn cannot carry an `error` footer.
  // It still notifies once rather than staying silent.
  const terminalErrorKey = `reasonix:${id}:message:3:summary`;
  await waitFor(() => runNotifications(terminalErrorSeen).length > 0);
  check('an ACP error stop still pairs its durable footer once, as done, because history maps that row done',
    runSummaries(terminalErrorSeen, 'running').length === 1
      && JSON.stringify(runNotifications(terminalErrorSeen)) === JSON.stringify([`done:${terminalErrorKey}`])
      && !runSummaries(terminalErrorSeen).some((frame) => frame.status === 'error'),
    JSON.stringify(runSummaries(terminalErrorSeen)));
  await terminalError.close();
  writeDurableRows(initial, 8);

  // A Reasonix tool turn persists one assistant row per model step, and v1.25.2
  // stamps `workDurationMs` on every one (upstream internal/agent/run_loop.go),
  // so the mapper writes a `done` footer per step. Only the last closes the
  // turn, and only a live `running` with that footer's key lets the broker
  // notify.
  const toolTurnRows = (
    prompt: string,
    final: string,
  ): ReasonixTranscriptRecord[] => [
    ...initial,
    { role: 'user', content: prompt, raw_content: prompt, createdAt: 60 },
    {
      role: 'assistant',
      content: 'checking the workspace',
      workDurationMs: 4,
      tool_calls: [{ id: 'call-step', name: 'bash', arguments: '{"command":"ls"}' }],
    },
    { role: 'tool', name: 'bash', tool_call_id: 'call-step', content: 'README.md' },
    { role: 'assistant', content: final, workDurationMs: 9 },
  ];
  const toolTurnAuthored = [0, 0, 1, 1, 1, 1];
  const stepKey = `reasonix:${id}:message:3:summary`;
  const finalKey = `reasonix:${id}:message:5:summary`;
  const hasFrame = (frames: readonly AgentMessage[], key: string, status: RunSummaryFrame['status']) =>
    runSummaries(frames, status).some((frame) => frame.key === key);

  // Preferred order: the ACP turn has returned before the tail appends its rows.
  writeDurableRows(initial, 60);
  let appendedAlive = true;
  const appendedTransport: ReasonixAcpTransport = {
    get alive() { return appendedAlive; },
    async sessionPrompt() { return { stopReason: 'end_turn' }; },
    sessionCancel() {},
    async close() { appendedAlive = false; },
  };
  const appended = new TestDriveConnection(session, info, appendedTransport);
  const appendedLive: AgentMessage[] = [];
  appended.subscribe((message) => appendedLive.push(message));
  await appended.getHistory();
  await appended.sendPrompt({ text: 'tool turn appended after return' });
  const runningBeforeRows = runSummaries(appendedLive, 'running').length;
  writeDurableRows(toolTurnRows('tool turn appended after return', 'appended final answer'), 61, toolTurnAuthored);
  await waitFor(() => hasFrame(appendedLive, finalKey, 'done'));
  const appendedRunning = runSummaries(appendedLive, 'running');
  const appendedFinal = runSummaries(appendedLive, 'done').filter((frame) => frame.key === finalKey);
  check('a driven tool turn opens one running on the footer that closes it, just before that footer',
    runningBeforeRows === 0
      && appendedRunning.length === 1
      && appendedRunning[0]?.key === finalKey
      && appendedRunning[0].turnId === appendedFinal[0]?.turnId
      && appendedFinal.length === 1
      && appendedLive.indexOf(appendedRunning[0]!) < appendedLive.indexOf(appendedFinal[0]!)
      && hasFrame(appendedLive, stepKey, 'done')
      && JSON.stringify(runNotifications(appendedLive)) === JSON.stringify([`done:${finalKey}`]),
    JSON.stringify(runSummaries(appendedLive)));
  // A same-content sidecar write wakes the watcher; neither it nor a replay is a live turn.
  writeFileSync(eventIndexPath, readFileSync(eventIndexPath));
  await sleep(250);
  await appended.getHistory();
  check('no second running follows the paired terminal on a later drain or replay',
    runSummaries(appendedLive, 'running').length === 1
      && runNotifications(appendedLive).length === 1,
    JSON.stringify(runSummaries(appendedLive)));
  await appended.close();

  // Fallback order: the tail published the closing footer before the ACP return.
  writeDurableRows(initial, 62);
  let publishedAlive = true;
  const publishedLive: AgentMessage[] = [];
  const publishedTransport: ReasonixAcpTransport = {
    get alive() { return publishedAlive; },
    async sessionPrompt(params) {
      writeDurableRows(toolTurnRows(params.prompt[0]?.text ?? '', 'published final answer'), 63, toolTurnAuthored);
      await waitFor(() => hasFrame(publishedLive, finalKey, 'done'));
      return { stopReason: 'end_turn' };
    },
    sessionCancel() {},
    async close() { publishedAlive = false; },
  };
  const published = new TestDriveConnection(session, info, publishedTransport);
  published.subscribe((message) => publishedLive.push(message));
  await published.getHistory();
  await published.sendPrompt({ text: 'tool turn published before return' });
  const publishedRunning = runSummaries(publishedLive, 'running');
  const runningAt = publishedRunning[0] ? publishedLive.indexOf(publishedRunning[0]) : -1;
  const tailFinalAt = publishedLive.findIndex((frame) => frame.type === 'run-summary'
    && frame.key === finalKey && frame.status === 'done');
  const resent = publishedLive[runningAt + 1];
  check('a closing footer published before the ACP return is re-sent once, unchanged, right after running',
    publishedRunning.length === 1
      && publishedRunning[0]?.key === finalKey
      && tailFinalAt >= 0
      && tailFinalAt < runningAt
      && resent?.type === 'run-summary'
      && resent.key === finalKey
      && resent.status === 'done'
      && JSON.stringify(resent) === JSON.stringify(publishedLive[tailFinalAt])
      && JSON.stringify(runNotifications(publishedLive)) === JSON.stringify([`done:${finalKey}`]),
    JSON.stringify(runSummaries(publishedLive)));
  writeFileSync(eventIndexPath, readFileSync(eventIndexPath));
  await sleep(250);
  await published.getHistory();
  check('the re-sent pairing is not repeated by a later drain or replay',
    runSummaries(publishedLive, 'running').length === 1
      && runNotifications(publishedLive).length === 1,
    JSON.stringify(runSummaries(publishedLive)));
  await published.close();

  // A user Stop mid tool turn leaves a durable step footer, which is not a finished turn.
  writeDurableRows(initial, 64);
  let stoppedAlive = true;
  const stoppedLive: AgentMessage[] = [];
  const stoppedTransport: ReasonixAcpTransport = {
    get alive() { return stoppedAlive; },
    async sessionPrompt(params) {
      const prompt = params.prompt[0]?.text ?? '';
      writeDurableRows([
        ...toolTurnRows(prompt, 'unused').slice(0, 4),
        {
          role: 'tool',
          name: 'bash',
          tool_call_id: 'call-step',
          content: 'interrupted',
          tool_execution: { state: 'cancelled' },
        },
      ], 65, [0, 0, 1, 1, 1]);
      await waitFor(() => hasFrame(stoppedLive, stepKey, 'done'));
      return { stopReason: 'cancelled' };
    },
    sessionCancel() {},
    async close() { stoppedAlive = false; },
  };
  const stopped = new TestDriveConnection(session, info, stoppedTransport);
  stopped.subscribe((message) => stoppedLive.push(message));
  await stopped.getHistory();
  await stopped.sendPrompt({ text: 'tool turn stopped by the user' });
  await sleep(200);
  check('a cancelled tool turn raises no running, so its durable step footer cannot notify',
    stopped.driving
      && hasFrame(stoppedLive, stepKey, 'done')
      && runSummaries(stoppedLive, 'running').length === 0
      && runNotifications(stoppedLive).length === 0,
    JSON.stringify(runSummaries(stoppedLive)));
  await stopped.close();

  // Race order for a created session: its initial snapshot publishes only after
  // the first turn has returned and been claimed. The snapshot is catch-up and
  // must carry no running; the pairing follows it.
  const lateSnapshotRows: ReasonixTranscriptRecord[] = toolTurnRows('created turn returned first', 'late final')
    .slice(initial.length);
  const lateFinalKey = `reasonix:${id}:message:3:summary`;
  const lateSnapshot = new TestDriveConnection(session, info, new FakeTransport(), {
    pendingCreate: { cwd: root, discover: async () => ({ ...session }) },
  });
  lateSnapshot.seedResolvedDrivenTurnForTest('queued:reasonix:late-snapshot.1', 0);
  const lateSnapshotLive: AgentMessage[] = [];
  lateSnapshot.subscribe((message) => lateSnapshotLive.push(message));
  writeDurableRows(lateSnapshotRows, 66, [0, 0, 0, 0]);
  await waitFor(() => runNotifications(lateSnapshotLive).length > 0);
  const lateRunning = runSummaries(lateSnapshotLive, 'running');
  const lateRunningAt = lateRunning[0] ? lateSnapshotLive.indexOf(lateRunning[0]) : -1;
  const lateSnapshotFooterAt = lateSnapshotLive.findIndex((frame) => frame.type === 'run-summary'
    && frame.key === lateFinalKey && frame.status === 'done');
  const latePaired = lateSnapshotLive[lateRunningAt + 1];
  check('a created initial snapshot published after its turn returned still carries no running; the pair follows it',
    lateRunning.length === 1
      && lateRunning[0]?.key === lateFinalKey
      && lateSnapshotFooterAt >= 0
      && lateSnapshotFooterAt < lateRunningAt
      && latePaired?.type === 'run-summary'
      && latePaired.key === lateFinalKey
      && latePaired.status === 'done'
      && JSON.stringify(runNotifications(lateSnapshotLive)) === JSON.stringify([`done:${lateFinalKey}`]),
    JSON.stringify(runSummaries(lateSnapshotLive)));
  await lateSnapshot.close();
  writeDurableRows(initial, 8);

  for (const stopReason of [undefined, 'future_stop']) {
    let malformedAlive = true;
    const malformedTransport: ReasonixAcpTransport = {
      get alive() { return malformedAlive; },
      async sessionPrompt() { return stopReason === undefined ? {} : { stopReason }; },
      sessionCancel() {},
      async close() { malformedAlive = false; },
    };
    const malformed = ReasonixDriveConnection.fromTransport(session, info, malformedTransport);
    await malformed.getHistory();
    let malformedRejected = false;
    try { await malformed.sendPrompt({ text: `malformed ${String(stopReason)}` }); } catch { malformedRejected = true; }
    check(`a ${stopReason === undefined ? 'missing' : 'unknown'} stopReason fails closed and demotes Drive`,
      malformedRejected && !malformed.driving && malformed.getPending().length === 1);
    await malformed.close();
  }

  const permissionTransport = new FakeTransport();
  const permissionConnection = new TestDriveConnection(session, info, permissionTransport);
  const interactionSeen: AgentMessage[] = [];
  permissionConnection.subscribe((message) => interactionSeen.push(message));
  permissionConnection.pushStatus({
    sessionId: id,
    sequence: 1,
    status: { state: 'idle', cumulative: {
      promptTokens: 9,
      completionTokens: 3,
      reasoningTokens: 2,
      cacheHitTokens: 4,
      cacheMissTokens: 5,
      estimated: true,
      estimatedCost: 0.01,
      source: 'executor',
      costComplete: false,
    } },
  });
  permissionConnection.pushStatus({
    sessionId: id,
    sequence: 1,
    status: { state: 'idle', cumulative: { promptTokens: 99, completionTokens: 1 } },
  });
  permissionConnection.pushStatus({
    sessionId: id,
    sequence: 2,
    status: { state: 'idle', cumulative: {
      promptTokens: 12,
      completionTokens: 4,
      cacheHitTokens: 6,
      cacheMissTokens: 6,
      estimated: false,
      estimatedCost: 0.02,
      source: 'executor',
      costComplete: true,
    } },
  });
  permissionConnection.pushStatus({ sessionId: id, sequence: Number.MAX_SAFE_INTEGER, status: null });
  permissionConnection.pushStatus({ sessionId: id, sequence: 3, status: { state: 'running' } });
  const usageRows = interactionSeen.filter((message): message is Extract<AgentMessage, { type: 'metadata-update' }> =>
    message.type === 'metadata-update' && message.key === 'sessionUsage');
  check('status parsing emits monotone cumulative usage without token-count double counting',
    interactionSeen.every((message) => message.type !== 'token-count')
      && interactionSeen.some((message) => message.type === 'status' && message.status === 'running')
      && usageRows.length === 2
      && (usageRows[0]?.value as { input?: number; cacheReadSubset?: number; cost?: number }).input === 9
      && (usageRows[0]?.value as { cacheReadSubset?: number }).cacheReadSubset === 4
      && !Object.prototype.hasOwnProperty.call(usageRows[0]?.value ?? {}, 'cost')
      && (usageRows[1]?.value as { input?: number; cost?: number }).input === 12
      && (usageRows[1]?.value as { cost?: number }).cost === 0.02,
    JSON.stringify(usageRows));
  permissionConnection.pushAuthoritativeMode('yolo');
  const rowsBeforeStaleDisk = interactionSeen.length;
  permissionConnection.pushNativeMetadata('ask', {
    promptTokens: 8,
    completionTokens: 3,
    cacheHitTokens: 4,
    cacheMissTokens: 4,
  });
  check('a delayed metadata snapshot cannot roll back ACP-confirmed mode or cumulative usage',
    permissionConnection.info.currentMode === 'yolo'
      && interactionSeen.length === rowsBeforeStaleDisk,
    JSON.stringify(interactionSeen.slice(rowsBeforeStaleDisk)));
  permissionConnection.pushNativeMetadata('yolo', {
    estimated: false,
    estimatedCost: 0.01,
    source: 'executor',
    costComplete: true,
  });
  const correctedUsage = interactionSeen.filter((message): message is Extract<AgentMessage, { type: 'metadata-update' }> =>
    message.type === 'metadata-update' && message.key === 'sessionUsage').at(-1);
  check('a partial cost correction preserves previously known cumulative buckets',
    (correctedUsage?.value as { input?: number; output?: number; cost?: number }).input === 12
      && (correctedUsage?.value as { output?: number }).output === 4
      && (correctedUsage?.value as { cost?: number }).cost === 0.01,
    JSON.stringify(correctedUsage));
  const permissionRoundTrip = permissionConnection.askPermission({
    sessionId: id,
    toolCall: {
      toolCallId: 'permission-round-trip',
      title: 'Edit workspace',
      rawInput: { path: '/tmp/example.ts', patch: 'bounded detail' },
    },
    options: [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow_always', name: 'Allow Bash(<rule>) for this session', kind: 'allow_always' },
      { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
    ],
  });
  const permissionCard = permissionConnection.getPending().find(
    (message) => message.type === 'permission-request' && message.requestId === 'permission-round-trip',
  );
  check('permission cards expose canonical decisions and preserve bounded native tool detail',
    permissionCard?.type === 'permission-request'
      && JSON.stringify(permissionCard.options) === JSON.stringify(['approve', 'approve-rule', 'reject'])
      && permissionCard.toolName === 'Edit workspace'
      && permissionCard.detail?.includes('/tmp/example.ts') === true,
    JSON.stringify(permissionCard));
  const duplicatePermission = await permissionConnection.askPermission({
    sessionId: id,
    toolCall: { toolCallId: 'permission-round-trip', title: 'Duplicate' },
    options: [],
  });
  const foreignSessionPermission = await permissionConnection.askPermission({
    sessionId: 'another-session',
    toolCall: { toolCallId: 'foreign-session-permission', title: 'Foreign' },
    options: [],
  });
  check('duplicate and foreign-session permission requests cancel without replacing the resolver',
    duplicatePermission.outcome.outcome === 'cancelled'
      && foreignSessionPermission.outcome.outcome === 'cancelled'
      && permissionConnection.getPending().filter((message) => message.type === 'permission-request').length === 1);
  await permissionConnection.respondPermission('permission-round-trip', 'approve-rule');
  const permissionSelection = await permissionRoundTrip;
  check('canonical approve-rule maps back to the measured native allow-always option',
    permissionSelection.outcome.outcome === 'selected'
      && permissionSelection.outcome.optionId === 'allow_always',
    JSON.stringify(permissionSelection));

  const oversizedPermissionResult = permissionConnection.askPermission({
    sessionId: id,
    toolCall: {
      toolCallId: 'native-id-'.repeat(8_000),
      title: 'Oversized title '.repeat(5_000),
    },
    options: [{ optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }],
  });
  const oversizedPermissionCard = permissionConnection.getPending().find(
    (message) => message.type === 'permission-request' && message.requestId.startsWith('reasonix-permission:'),
  );
  check('oversized native permission ids are replaced and retained card fields stay bounded',
    oversizedPermissionCard?.type === 'permission-request'
      && oversizedPermissionCard.requestId.length < 128
      && oversizedPermissionCard.title.length <= 512,
    oversizedPermissionCard?.type === 'permission-request'
      ? `id=${oversizedPermissionCard.requestId.length} title=${oversizedPermissionCard.title.length}`
      : 'missing');
  if (oversizedPermissionCard?.type === 'permission-request') {
    await permissionConnection.respondPermission(oversizedPermissionCard.requestId, 'reject');
  }
  check('the replacement permission id still resolves the native request',
    (await oversizedPermissionResult).outcome.outcome === 'selected');

  const unsupportedOptions = await permissionConnection.askPermission({
    sessionId: id,
    toolCall: { toolCallId: 'unsupported-options', title: 'Unknown choice vocabulary' },
    options: [{ optionId: 'x'.repeat(513), name: 'Allow once', kind: 'allow_once' }],
  });
  check('permissions with no safely representable native option cancel immediately',
    unsupportedOptions.outcome.outcome === 'cancelled'
      && !permissionConnection.getPending().some((message) => message.type === 'permission-request'
        && message.requestId === 'unsupported-options'));
  const misleadingPermission = await permissionConnection.askPermission({
    sessionId: id,
    toolCall: { toolCallId: 'misleading-option', title: 'Misleading option' },
    options: [{ optionId: 'never_allow', name: 'Never allow', kind: 'never_allow' }],
  });
  const excessivePermission = await permissionConnection.askPermission({
    sessionId: id,
    toolCall: { toolCallId: 'excessive-options', title: 'Too many options' },
    options: Array.from({ length: 65 }, (_unused, index) => ({
      optionId: `allow_${index}`,
      name: `Allow ${index}`,
      kind: index === 0 ? 'allow_once' : 'unknown',
    })),
  });
  check('unknown permission vocabulary and over-cap option sets fail closed as a whole',
    misleadingPermission.outcome.outcome === 'cancelled'
      && excessivePermission.outcome.outcome === 'cancelled');

  const unprovedQuestion = await permissionConnection.askPermission({
    sessionId: id,
    toolCall: {
      toolCallId: 'ask-q42-choice',
      title: 'Ask user',
      rawInput: {
        id: 'q42',
        question: 'Which path should Reasonix take?',
        options: [
          { label: 'Alpha', description: 'Use the first path.' },
          { label: 'Beta', description: 'Use the second path.' },
        ],
        multi: false,
      },
    },
    options: [
      { optionId: 'q42:1', name: 'Alpha' },
      { optionId: 'q42:2', name: 'Beta' },
      { optionId: 'q42:cancel', name: 'Cancel' },
    ],
  });
  check('unproved ask-shaped requests are not exposed as question dialogs',
    unprovedQuestion.outcome.outcome === 'cancelled'
      && !permissionConnection.getPending().some((message) => message.type === 'question-request'));

  const stoppedPermission = permissionConnection.askPermission({
    sessionId: id,
    toolCall: { toolCallId: 'stop-pending', title: 'Pending during Stop' },
    options: [{ optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }],
  });
  const stopCommands = await permissionConnection.listCommands();
  const stopResult = await permissionConnection.runCommand('stop');
  check('Stop is advertised once and settles pending interactive requests through the app command path',
    stopCommands.filter((command) => command.name === 'stop' && command.kind === 'action').length === 1
      && stopResult?.notice === 'Stop requested.'
      && permissionTransport.cancels.includes(id)
      &&
    (await stoppedPermission).outcome.outcome === 'cancelled'
      && permissionConnection.getPending().every((message) => message.type !== 'permission-request'
        && message.type !== 'question-request')
      && interactionSeen.some((message) => message.type === 'permission-resolved'
        && message.requestId === 'stop-pending'));
  await permissionConnection.close();

  const throwingCancelTransport = new ThrowingCancelTransport();
  const throwingCancel = new TestDriveConnection(session, info, throwingCancelTransport);
  const throwingPermission = throwingCancel.askPermission({
    sessionId: id,
    toolCall: { toolCallId: 'throwing-stop', title: 'Pipe races exit' },
    options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
  });
  throwingCancel.cancel();
  check('Stop settles interactive requests even when session/cancel races a broken pipe',
    (await throwingPermission).outcome.outcome === 'cancelled'
      && throwingCancel.getPending().length === 0);
  await throwingCancel.close();

  const modelDisabledTransport = new FakeTransport();
  const modelDisabled = new TestDriveConnection(session, info, modelDisabledTransport);
  let modelSelectionRefused = false;
  try {
    await modelDisabled.sendPrompt({
      text: 'unproved model selection',
      model: { providerID: 'provider', modelID: 'model' },
    });
  } catch { modelSelectionRefused = true; }
  check('unproved model selection is refused before queueing or native delivery',
    modelSelectionRefused
      && modelDisabledTransport.prompts.length === 0
      && modelDisabled.getPending().length === 0);
  await modelDisabled.close();

  const closeTransport = new FakeTransport();
  const closeQueued = new TestDriveConnection(session, info, closeTransport);
  await closeQueued.getHistory();
  const closeFirst = closeQueued.sendPrompt({ text: 'already native before close' });
  await waitFor(() => closeTransport.prompts.length === 1);
  const closeSecond = closeQueued.sendPrompt({ text: 'queued behind close' });
  await closeQueued.close();
  await Promise.allSettled([closeFirst, closeSecond]);
  check('close prevents a queued-but-not-started prompt from reaching ACP',
    JSON.stringify(closeTransport.prompts) === JSON.stringify(['already native before close']));

  const foreignTransport = new FakeTransport();
  const foreign = new TestDriveConnection(session, info, foreignTransport);
  const foreignSeen: AgentMessage[] = [];
  foreign.subscribe((message) => foreignSeen.push(message));
  await foreign.getHistory();
  const permission = foreign.askPermission({
    sessionId: id,
    toolCall: { toolCallId: 'foreign-permission', title: 'Pending write', rawInput: { command: 'touch file' } },
    options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
  });
  const foreignSending = foreign.sendPrompt({ text: 'ours' });
  await sleep(10);
  const foreignRecord = { role: 'user', content: 'terminal write', raw_content: 'terminal write', createdAt: 3 };
  const foreignLine = JSON.stringify(foreignRecord);
  const foreignOffset = deliveredOffset + Buffer.byteLength(`${delivered}\n`);
  foreign.pushDurableUser(
    foreignRecord,
    { index: 3, offset: foreignOffset, length: Buffer.byteLength(`${foreignLine}\n`), role: 'user', authoredTurn: 2 },
    [{ type: 'user-message', text: 'terminal write', key: 'native-foreign' }],
  );
  check('a foreign user line self-demotes and keeps accepted pending prompts',
    foreign.getPending().length === 1
      && foreignSeen.some((message) => message.type === 'metadata-update'),
    JSON.stringify({ pending: foreign.getPending(), seen: foreignSeen }));
  const permissionResult = await permission;
  let stalePermissionRejected = false;
  try { await foreign.respondPermission('foreign-permission', 'approve'); } catch { stalePermissionRejected = true; }
  check('demotion cancels the native turn, closes the writer, and settles permissions',
    foreignTransport.cancels.includes(id)
      && foreignTransport.closed
      && permissionResult.outcome.outcome === 'cancelled'
      && stalePermissionRejected);
  const postDemoteCount = foreignSeen.length;
  foreign.pushStatus({ sessionId: id, sequence: 99, status: { state: 'running' } });
  foreign.pushUpdate({
    sessionId: id,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late buffered output' } },
  });
  check('buffered child status and output are ignored after demotion',
    foreignSeen.length === postDemoteCount);
  let demotedRejected = false;
  try { await foreign.sendPrompt({ text: 'after demotion' }); } catch { demotedRejected = true; }
  check('demotion refuses subsequent writes', demotedRejected);
  await foreignSending.catch(() => {});
  await foreign.close();

  const idleTailRows: ReasonixTranscriptRecord[] = [
    ...initial,
    { role: 'user', content: 'abandoned native prompt', raw_content: 'abandoned native prompt', createdAt: 4 },
  ];
  writeDurableRows(idleTailRows, 19);
  const idleDriveTransport = new FakeTransport();
  const idleDrive = new TestDriveConnection(session, info, idleDriveTransport);
  const idleDriveReplay = await idleDrive.getHistory();
  check('an idle Drive connection does not hide an interrupted pre-existing native user tail',
    idleDriveReplay.some((message) => message.type === 'run-summary'
      && message.status === 'cancelled'
      && message.userMessageKey === `reasonix:${id}:message:2`),
    JSON.stringify(idleDriveReplay));
  await idleDrive.close();

  // Reset the durable fixture for delayed-flush/cancellation queue tests.
  const baseSnapshot = writeDurableRows(initial, 20);

  const rewritePendingTransport = new FakeTransport();
  const rewritePending = new TestDriveConnection(session, info, rewritePendingTransport);
  await rewritePending.getHistory();
  const rewritePendingSend = rewritePending.sendPrompt({ text: 'same text after rewrite', clientMessageId: 'rewrite-client' });
  await waitFor(() => rewritePending.getPending().some((message) => message.type === 'user-message'));
  const rewriteQueued = rewritePending.getPending().find(
    (message): message is Extract<AgentMessage, { type: 'user-message' }> => message.type === 'user-message',
  );
  rewritePending.rewriteHistory();
  const rewriteText = 'same text after rewrite';
  const rewriteRecord: ReasonixTranscriptRecord = { role: 'user', content: rewriteText, raw_content: rewriteText };
  const rewriteDisplay: ReasonixDisplayEntry = {
    index: 2,
    offset: baseSnapshot.byteLength,
    length: Buffer.byteLength(`${JSON.stringify(rewriteRecord)}\n`),
    role: 'user',
    authoredTurn: 1,
    startsTurn: true,
  };
  const rewrittenNative: AgentMessage = {
    type: 'user-message',
    text: rewriteText,
    key: `reasonix:${id}:message:2`,
  };
  rewritePending.pushHistorySnapshot(
    [...initial, rewriteRecord],
    [...baseSnapshot.entries, rewriteDisplay],
    [rewrittenNative],
    rewriteDisplay.offset + rewriteDisplay.length + 1,
  );
  check('a history rewrite cannot transfer a queued key to an identical foreign replacement',
    rewrittenNative.type === 'user-message'
      && rewrittenNative.key === `reasonix:${id}:message:2`
      && rewrittenNative.clientKey === undefined
      && rewritePending.getPending().some((message) => message.type === 'user-message'
        && message.key === rewriteQueued?.key && message.queued === true),
    JSON.stringify({ native: rewrittenNative, pending: rewritePending.getPending() }));
  await rewritePendingSend.catch(() => {});
  await rewritePending.close();

  let cancelledThenNextCall = 0;
  let cancelledThenNextAlive = true;
  const cancelledThenNextTransport: ReasonixAcpTransport = {
    get alive() { return cancelledThenNextAlive; },
    async sessionPrompt(params) {
      cancelledThenNextCall += 1;
      const text = params.prompt[0]?.text ?? '';
      // `createdAt` here has to be BYTE-IDENTICAL to what the first call wrote
      // for the same row, which is `5 + 1`. Writing 5 rewrites row 2 of the
      // durable prefix between revision 21 and 22, and the drive is right to
      // call that a history rewrite: it demotes to read-only and resets. It
      // only stayed hidden because the debounced watcher usually never
      // publishes the intermediate 4-row snapshot, so nothing had recorded the
      // prefix it was about to contradict. When the watcher did land there,
      // this scenario failed for the fixture's reason and not its own.
      const current = cancelledThenNextCall === 1 ? [...initial] : [
        ...initial,
        { role: 'user', content: 'cancelled persisted user', raw_content: 'cancelled persisted user', createdAt: 6 },
        { role: 'tool', name: '__reasonix_local_only__', tool_call_id: '__reasonix_local_only__' },
      ];
      const rows: ReasonixTranscriptRecord[] = [
        ...current,
        { role: 'user', content: text, raw_content: text, createdAt: 5 + cancelledThenNextCall },
        ...(cancelledThenNextCall === 1
          ? [{ role: 'tool', name: '__reasonix_local_only__', tool_call_id: '__reasonix_local_only__' } satisfies ReasonixTranscriptRecord]
          : [{ role: 'assistant', content: 'next answer', workDurationMs: 1 } satisfies ReasonixTranscriptRecord]),
      ];
      writeDurableRows(rows, 20 + cancelledThenNextCall);
      return { stopReason: cancelledThenNextCall === 1 ? 'cancelled' : 'end_turn' };
    },
    sessionCancel() {},
    async close() { cancelledThenNextAlive = false; },
  };
  const cancelledThenNext = new TestDriveConnection(session, info, cancelledThenNextTransport);
  const cancelledThenNextLive: AgentMessage[] = [];
  cancelledThenNext.subscribe((message) => cancelledThenNextLive.push(message));
  await cancelledThenNext.getHistory();
  await cancelledThenNext.sendPrompt({ text: 'cancelled persisted user', clientMessageId: 'cancelled-persisted' });
  const cancelledFirstReplay = await cancelledThenNext.getHistory();
  await cancelledThenNext.sendPrompt({ text: 'prompt after cancelled user', clientMessageId: 'after-cancelled' });
  const cancelledThenNextReplay = await cancelledThenNext.getHistory();
  check('a cancelled persisted user without an assistant rebases the next native index',
    cancelledThenNext.driving
      && cancelledThenNext.getPending().length === 0
      && cancelledThenNextLive.some((message) => message.type === 'run-summary'
        && message.status === 'cancelled'
        && message.userMessageKey?.startsWith('queued:reasonix:'))
      && cancelledFirstReplay.some((message) => message.type === 'run-summary'
        && message.status === 'cancelled'
        && message.userMessageKey?.startsWith('queued:reasonix:'))
      && cancelledThenNextReplay.some((message) => message.type === 'user-message'
        && message.text === 'prompt after cancelled user'
        && message.clientKey === 'after-cancelled'),
    JSON.stringify({ pending: cancelledThenNext.getPending(), live: cancelledThenNextLive,
      cancelledFirstReplay, replay: cancelledThenNextReplay }));
  const nextTurnKey = `reasonix:${id}:message:5:summary`;
  await waitFor(() => runNotifications(cancelledThenNextLive).length > 0);
  check('a cancelled turn raises no running while the next driven turn pairs its footer once',
    runSummaries(cancelledThenNextLive, 'running').length === 1
      && runSummaries(cancelledThenNextLive, 'running')[0]?.key === nextTurnKey
      && runSummaries(cancelledThenNextLive, 'cancelled').length > 0
      && JSON.stringify(runNotifications(cancelledThenNextLive)) === JSON.stringify([`done:${nextTurnKey}`]),
    JSON.stringify(runSummaries(cancelledThenNextLive)));
  await cancelledThenNext.close();

  for (const terminalReason of ['end_turn', 'refusal'] as const) {
    writeDurableRows(initial, 30);
    let call = 0;
    let terminalAlive = true;
    const firstText = `${terminalReason} persisted user`;
    const secondText = `${terminalReason} next prompt`;
    const terminalTransport: ReasonixAcpTransport = {
      get alive() { return terminalAlive; },
      async sessionPrompt(params) {
        call += 1;
        const text = params.prompt[0]?.text ?? '';
        const rows: ReasonixTranscriptRecord[] = call === 1
          ? [...initial, { role: 'user', content: text, raw_content: text }]
          : [
            ...initial,
            { role: 'user', content: firstText, raw_content: firstText },
            { role: 'user', content: secondText, raw_content: secondText },
            { role: 'assistant', content: 'terminal next answer', workDurationMs: 1 },
          ];
        writeDurableRows(rows, 30 + call);
        return { stopReason: call === 1 ? terminalReason : 'end_turn' };
      },
      sessionCancel() {},
      async close() { terminalAlive = false; },
    };
    const terminal = new TestDriveConnection(session, info, terminalTransport);
    await terminal.getHistory();
    await terminal.sendPrompt({ text: firstText, clientMessageId: `${terminalReason}-first` });
    await terminal.sendPrompt({ text: secondText, clientMessageId: `${terminalReason}-second` });
    const replay = await terminal.getHistory();
    check(`${terminalReason} without an assistant row rebases the next prompt index`,
      terminal.driving
        && terminal.getPending().length === 0
        && replay.some((message) => message.type === 'user-message'
          && message.text === secondText && message.clientKey === `${terminalReason}-second`),
      JSON.stringify(replay));
    await terminal.close();
  }

  writeDurableRows(initial, 22);

  const preflightTransport = new FakeTransport();
  preflightTransport.finish();
  const preflight = new TestDriveConnection(session, info, preflightTransport);
  const preflightSeen: AgentMessage[] = [];
  preflight.subscribe((message) => preflightSeen.push(message));
  await preflight.getHistory();
  const preflightForeign = { role: 'user', content: 'foreign before send', raw_content: 'foreign before send' };
  const preflightRows = [...initial, preflightForeign];
  const preflightLines = preflightRows.map((row) => JSON.stringify(row));
  let preflightOffset = 0;
  const preflightDisplay = preflightLines.map((line, index) => {
    const role = preflightRows[index]!.role;
    const entry = {
      index,
      offset: preflightOffset,
      length: Buffer.byteLength(`${line}\n`),
      role,
      authored_turn: Math.floor(index / 2),
      ...(role === 'user' ? { starts_turn: true } : {}),
    };
    preflightOffset += Buffer.byteLength(`${line}\n`);
    return entry;
  });
  writeFileSync(transcriptPath, `${preflightLines.join('\n')}\n`);
  writeFileSync(displayIndexPath, `${JSON.stringify({ schema_version: 1, revision: 21, entries: preflightDisplay })}\n`);
  writeFileSync(eventIndexPath, `${JSON.stringify({ schema_version: 1, log_size: preflightOffset, revision: 21 })}\n`);
  let preflightRejected = false;
  try { await preflight.sendPrompt({ text: 'must not reach ACP' }); } catch { preflightRejected = true; }
  check('prompt admission detects an already-durable foreign user row before touching ACP',
    preflightRejected
      && preflightTransport.prompts.length === 0
      && !preflight.driving
      && preflight.getPending().length === 0
      && preflightSeen.some((message) => message.type === 'user-message'
        && message.text === 'must not reach ACP' && message.queued === true)
      && preflightSeen.some((message) => message.type === 'history-reset'),
    JSON.stringify({ prompts: preflightTransport.prompts, pending: preflight.getPending(), seen: preflightSeen }));
  await preflight.close();

  writeFileSync(transcriptPath, `${lines.join('\n')}\n`);
  writeFileSync(displayIndexPath, `${JSON.stringify({ schema_version: 1, revision: 22, entries: [
    { index: 0, offset: offsets[0], length: Buffer.byteLength(`${lines[0]}\n`), role: 'user', authored_turn: 0, starts_turn: true },
    { index: 1, offset: offsets[1], length: Buffer.byteLength(`${lines[1]}\n`), role: 'assistant', authored_turn: 0 },
  ] })}\n`);
  writeFileSync(eventIndexPath, `${JSON.stringify({
    schema_version: 1,
    log_size: Buffer.byteLength(`${lines.join('\n')}\n`),
    revision: 22,
  })}\n`);

  const delayedTransport = new FakeTransport();
  delayedTransport.finish();
  const delayed = new TestDriveConnection(session, info, delayedTransport);
  const delayedLive: AgentMessage[] = [];
  delayed.subscribe((message) => delayedLive.push(message));
  await delayed.getHistory();
  const delayedFirst = delayed.sendPrompt({ text: 'delayed first', clientMessageId: 'delayed-client-1' });
  const delayedSecond = delayed.sendPrompt({ text: 'delayed second', clientMessageId: 'delayed-client-2' });
  const delayedPending = delayed.getPending().filter(
    (message): message is Extract<AgentMessage, { type: 'user-message' }> => message.type === 'user-message',
  );
  await Promise.all([delayedFirst, delayedSecond]);
  check('concurrent joined-client admissions retain FIFO order before any durable flush',
    JSON.stringify(delayedTransport.prompts) === JSON.stringify(['delayed first', 'delayed second'])
      && delayedPending.length === 2
      && delayedPending[0]?.text === 'delayed first'
      && delayedPending[1]?.text === 'delayed second',
    JSON.stringify({ prompts: delayedTransport.prompts, pending: delayedPending }));

  const delayedRows = [
    ...initial,
    { role: 'user', content: 'delayed first', raw_content: 'delayed first', createdAt: 4 },
    { role: 'assistant', content: 'delayed answer one', workDurationMs: 2 },
    { role: 'user', content: 'delayed second', raw_content: 'delayed second', createdAt: 5 },
    { role: 'assistant', content: 'delayed answer two', workDurationMs: 3 },
  ];
  const delayedLines = delayedRows.map((row) => JSON.stringify(row));
  let delayedOffset = 0;
  const delayedDisplay = delayedLines.map((line, index) => {
    const role = delayedRows[index]!.role;
    const entry = {
      index,
      offset: delayedOffset,
      length: Buffer.byteLength(`${line}\n`),
      role,
      authored_turn: Math.floor(index / 2),
      ...(role === 'user' ? { starts_turn: true } : {}),
    };
    delayedOffset += Buffer.byteLength(`${line}\n`);
    return entry;
  });
  writeFileSync(transcriptPath, `${delayedLines.join('\n')}\n`);
  writeFileSync(displayIndexPath, `${JSON.stringify({ schema_version: 1, revision: 23, entries: delayedDisplay })}\n`);
  writeFileSync(eventIndexPath, `${JSON.stringify({ schema_version: 1, log_size: delayedOffset, revision: 23 })}\n`);
  const delayedReplay = await delayed.getHistory();
  // A same-content sidecar write gives the debounced watcher a deterministic
  // post-replay event; replay itself must not consume the live tail.
  writeFileSync(eventIndexPath, `${JSON.stringify({ schema_version: 1, log_size: delayedOffset, revision: 23 })}\n`);
  const delayedDelivered = await waitFor(() => delayed.getPending().length === 0
    && delayedLive.filter((message) => message.type === 'user-message' && message.queued === false).length >= 2, 3_000);
  const deliveredUsers = delayedLive.filter(
    (message): message is Extract<AgentMessage, { type: 'user-message' }> => message.type === 'user-message' && message.queued === false,
  );
  check('normal end_turn keeps speculative indexes until a delayed two-turn flush reconciles in order',
    delayedDelivered
      && delayed.driving
      && delayedReplay.some((message) => message.type === 'user-message' && message.key === delayedPending[0]?.key)
      && deliveredUsers.some((message) => message.key === delayedPending[0]?.key && message.clientKey === 'delayed-client-1')
      && deliveredUsers.some((message) => message.key === delayedPending[1]?.key && message.clientKey === 'delayed-client-2'),
    JSON.stringify({
      driving: delayed.driving,
      pending: delayed.getPending(),
      deliveredUsers,
      replayUsers: delayedReplay.filter((message) => message.type === 'user-message'),
      live: delayedLive,
    }));

  const streamedBase = writeDurableRows(initial, 24);
  const streamedTransport = new FakeTransport();
  const streamed = new TestDriveConnection(session, info, streamedTransport);
  const streamedLive: AgentMessage[] = [];
  streamed.subscribe((message) => streamedLive.push(message));
  await streamed.getHistory();
  const streamedTurn = streamed.sendPrompt({ text: 'streamed delayed row' });
  await waitFor(() => streamedTransport.prompts.length === 1);
  streamed.pushUpdate({
    sessionId: id,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'retained live answer' } },
  });
  const streamedUserRows: ReasonixTranscriptRecord[] = [
    ...initial,
    { role: 'user', content: 'streamed delayed row', raw_content: 'streamed delayed row' },
  ];
  writeDurableRows(streamedUserRows, 25);
  streamedTransport.finish();
  await streamedTurn;
  streamed.pushStatus({ sessionId: id, sequence: 1, status: { state: 'idle' } });
  check('native idle cannot clear streamed output while its assistant row is still delayed',
    streamedLive.some((message) => message.type === 'model-output' && message.delta === 'retained live answer')
      && !streamedLive.some((message) => message.type === 'status' && message.status === 'idle'),
    JSON.stringify(streamedLive));
  const streamedCompleteRows: ReasonixTranscriptRecord[] = [
    ...streamedUserRows,
    { role: 'assistant', content: 'retained live answer' },
  ];
  const streamedComplete = writeDurableRows(streamedCompleteRows, 26);
  streamed.pushHistorySnapshot(
    streamedCompleteRows,
    streamedComplete.entries,
    [],
    streamedComplete.byteLength,
  );
  check('the deferred native idle publishes after the assistant row becomes durable',
    streamedLive.some((message) => message.type === 'status' && message.status === 'idle'),
    JSON.stringify(streamedLive));
  await streamed.close();
  writeDurableRows(delayedRows, 23);

  const claimedOffset = delayedDisplay[2]!.offset;
  delayed.pushDurableUser(
    { role: 'user', content: 'foreign duplicate offset', raw_content: 'foreign duplicate offset' },
    { index: 2, offset: claimedOffset, length: 24, role: 'user', authoredTurn: 1 },
    [{ type: 'user-message', text: 'foreign duplicate offset', key: 'native-duplicate-offset' }],
  );
  check('reusing a claimed offset and index for different text demotes instead of re-keying the foreign row',
    !delayed.driving
      && delayedLive.some((message) => message.type === 'metadata-update'));
  await delayed.close();

  let cancellationAlive = true;
  const cancellationTransport: ReasonixAcpTransport & { closed: boolean } = {
    get alive() { return cancellationAlive; },
    closed: false,
    async sessionPrompt() { return { stopReason: 'cancelled' }; },
    sessionCancel() {},
    async close() { this.closed = true; cancellationAlive = false; },
  };
  const cancellation = new TestDriveConnection(session, info, cancellationTransport);
  const cancellationLive: AgentMessage[] = [];
  cancellation.subscribe((message) => cancellationLive.push(message));
  await cancellation.getHistory();
  await cancellation.sendPrompt({ text: 'cancelled without durable row', clientMessageId: 'cancel-client' });
  const cancellationReplay = await cancellation.getHistory();
  let postCancelRejected = false;
  try { await cancellation.sendPrompt({ text: 'must not inherit uncertain index' }); } catch { postCancelRejected = true; }
  check('cancelled/no-row ambiguity demotes and preserves one replayable queued row before later writes',
    !cancellation.driving
      && cancellationTransport.closed
      && postCancelRejected
      && cancellationReplay.some((message) => message.type === 'user-message'
        && message.text === 'cancelled without durable row'
        && message.queued === true
        && message.clientKey === 'cancel-client')
      && cancellationLive.some((message) => message.type === 'metadata-update'),
    JSON.stringify({ replay: cancellationReplay, live: cancellationLive }));
  await cancellation.close();

  const eventAheadBase = writeDurableRows(initial, 30);
  const eventAheadBaseDisplay = eventAheadBase.entries.map((entry) => ({
    index: entry.index,
    offset: entry.offset,
    length: entry.length,
    role: entry.role,
  }));
  writeFileSync(session.displayIndexPath, `${JSON.stringify({
    schema_version: 1,
    revision: 30,
    revision_known: true,
    transcript_size: eventAheadBase.byteLength,
    message_count: initial.length,
    entries: eventAheadBaseDisplay,
  })}\n`);
  const eventAheadDigest = 'a'.repeat(64);
  const eventAheadTipDigest = 'b'.repeat(64);
  const eventAheadWriter = 'event-ahead-fixture';
  const eventAheadRows: ReasonixTranscriptRecord[] = [
    ...initial,
    {
      role: 'user',
      content: 'accepted event-ahead refusal',
      raw_content: 'accepted event-ahead refusal',
      createdAt: 31,
    },
    {
      role: 'assistant',
      content: 'refused after durable event append',
      workDurationMs: 1,
      tool_execution: { name: 'shell', status: 'completed' },
    },
    { role: 'tool', name: 'shell', content: 'tool request persisted', tool_call_id: 'event-tool' },
    { role: 'tool', name: 'shell', content: 'tool result persisted', tool_call_id: 'event-tool' },
  ];
  const eventAheadLog = [
    {
      schema_version: 1,
      type: 'replace',
      revision: 30,
      messages: initial,
      content_digest: eventAheadDigest,
      writer_id: eventAheadWriter,
    },
    {
      schema_version: 1,
      type: 'append',
      revision: 31,
      base_revision: 30,
      message_index: initial.length,
      messages: eventAheadRows.slice(initial.length),
      content_digest: eventAheadTipDigest,
      writer_id: eventAheadWriter,
    },
  ].map((event) => JSON.stringify(event)).join('\n') + '\n';
  let eventAheadAlive = true;
  const eventAheadTransport: ReasonixAcpTransport & { closed: boolean } = {
    get alive() { return eventAheadAlive; },
    closed: false,
    async sessionPrompt() {
      writeFileSync(session.eventLogPath, eventAheadLog);
      writeFileSync(session.eventIndexPath, `${JSON.stringify({
        schema_version: 1,
        log_size: Buffer.byteLength(eventAheadLog),
        message_count: eventAheadRows.length,
        revision: 31,
        writer_id: eventAheadWriter,
        content_digest: eventAheadTipDigest,
      })}\n`);
      writeFileSync(session.metaPath, `${JSON.stringify({
        id,
        schema_version: 2,
        revision: 31,
        writer_id: eventAheadWriter,
        content_digest: eventAheadTipDigest,
      })}\n`);
      return { stopReason: 'refusal' };
    },
    sessionCancel() {},
    async close() { this.closed = true; eventAheadAlive = false; },
  };
  const eventAhead = new TestDriveConnection(session, info, eventAheadTransport);
  const eventAheadLive: AgentMessage[] = [];
  eventAhead.subscribe((message) => eventAheadLive.push(message));
  await eventAhead.getHistory();
  let eventAheadRejected = false;
  try {
    await eventAhead.sendPrompt({
      text: 'accepted event-ahead refusal',
      clientMessageId: 'event-ahead-client',
    });
  } catch {
    eventAheadRejected = true;
  }
  const eventAheadReplay = await eventAhead.getHistory();
  const freshEventAheadObserve = new ReasonixObserveConnection({ session, info: { ...info, attachMode: 'observe' } });
  const freshEventAheadReplay = await freshEventAheadObserve.getHistory();
  check('a validated event-journal append outranks stale flat/display sidecars without NACK or data loss',
    !eventAheadRejected
      && eventAhead.driving
      && eventAheadReplay.some((message) => message.type === 'user-message'
        && message.text === 'accepted event-ahead refusal'
        && message.clientKey === 'event-ahead-client')
      && eventAheadReplay.some((message) => message.type === 'model-output'
        && message.text === 'refused after durable event append')
      && freshEventAheadReplay.some((message) => message.type === 'user-message'
        && message.text === 'accepted event-ahead refusal')
      && freshEventAheadReplay.some((message) => message.type === 'model-output'
        && message.text === 'refused after durable event append'),
    JSON.stringify({ eventAheadRejected, driving: eventAhead.driving, eventAheadLive,
      eventAheadReplay, freshEventAheadReplay }));

  const eventAheadSerialized = eventAheadRows.map((row) => JSON.stringify(row));
  let eventAheadOffset = 0;
  let eventAheadTurn = 0;
  const eventAheadDisplay = eventAheadSerialized.map((line, index) => {
    const role = eventAheadRows[index]?.role;
    if (role === 'user' && index >= initial.length) eventAheadTurn += 1;
    const entry = {
      index,
      offset: eventAheadOffset,
      length: Buffer.byteLength(`${line}\n`),
      role,
      authored_turn: index < initial.length ? eventAheadBase.entries[index]?.authoredTurn : eventAheadTurn,
      ...(role === 'user' ? { starts_turn: true } : {}),
    };
    eventAheadOffset += entry.length;
    return entry;
  });
  writeFileSync(session.transcriptPath, `${eventAheadSerialized.join('\n')}\n`);
  writeFileSync(session.displayIndexPath, `${JSON.stringify({
    schema_version: 1,
    revision: 31,
    revision_known: true,
    transcript_size: eventAheadOffset,
    message_count: eventAheadRows.length,
    entries: eventAheadDisplay,
  })}\n`);
  const convergedEventAheadReplay = await eventAhead.getHistory();
  check('flat/display catch-up to the reconciled event revision preserves Drive ownership and identities',
    eventAhead.driving
      && convergedEventAheadReplay.some((message) => message.type === 'user-message'
        && message.text === 'accepted event-ahead refusal'
        && message.clientKey === 'event-ahead-client'),
    JSON.stringify({ driving: eventAhead.driving, convergedEventAheadReplay }));
  await freshEventAheadObserve.close();
  await eventAhead.close();

  const capTransport = new FakeTransport();
  const capped = new TestDriveConnection(session, info, capTransport);
  await capped.getHistory();
  const capSends = Array.from({ length: 129 }, (_unused, index) =>
    capped.sendPrompt({ text: `bounded-${index}` }).then(() => undefined, (error: unknown) => error));
  await sleep(10);
  const capLast = await capSends[128];
  check('concurrent admissions cannot race past the 128-prompt retained bound',
    capped.getPending().filter((message) => message.type === 'user-message').length === 128
      && capLast instanceof Error,
    `pending=${capped.getPending().length} last=${String(capLast)}`);
  await capped.close();
  await Promise.all(capSends);

  let initFailureAlive = true;
  const initFailureTransport: ReasonixAcpTransport & { closed: boolean } = {
    get alive() { return initFailureAlive; },
    closed: false,
    async initialize() { throw new Error('fixture session/load refused'); },
    async sessionPrompt() { return { stopReason: 'end_turn' }; },
    sessionCancel() {},
    async close() { this.closed = true; initFailureAlive = false; },
  };
  const initFailure = new TestDriveConnection(session, info, initFailureTransport);
  const initFailureLive: AgentMessage[] = [];
  initFailure.subscribe((message) => initFailureLive.push(message));
  let initFailed = false;
  try { await initFailure.listCommands(); } catch { initFailed = true; }
  check('command-discovery initialization failure demotes the attached writer and broadcasts posture',
    initFailed
      && !initFailure.driving
      && initFailureTransport.closed
      && initFailureLive.some((message) => message.type === 'metadata-update'),
    JSON.stringify(initFailureLive));
  await initFailure.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
