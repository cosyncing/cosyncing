#!/usr/bin/env bun
export {};
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage, HistorySnapshotSink, SessionInfo } from '@cosyncing/adapter-api';
import { ReasonixObserveConnection } from '../src/observe.ts';
import { discoverReasonixStore, reasonixHistorySourceIdentity } from '../src/store.ts';

class TrackingReasonixObserveConnection extends ReasonixObserveConnection {
  rewrites = 0;

  protected override onHistoryRewrite(): void {
    this.rewrites += 1;
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
function json(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

const root = mkdtempSync(join(tmpdir(), 'cosyncing-reasonix-observe-'));
const sessionDir = join(root, 'sessions');
const id = 'observe-session';
const transcript = join(sessionDir, `${id}.jsonl`);
const displayPath = join(sessionDir, `${id}.display-index.json`);
const eventPath = join(sessionDir, `${id}.event-index.json`);
const acpPath = join(sessionDir, `${id}.acp.json`);
const metaPath = `${transcript}.meta`;
mkdirSync(sessionDir, { recursive: true });

const initialRows = [
  { role: 'system', content: 'system context' },
  { role: 'user', content: 'one', raw_content: 'one', createdAt: 1_700_000_000_000 },
  { role: 'assistant', content: 'answer one', workDurationMs: 5 },
];
let displayEntries: Array<{
  index: number;
  offset: number;
  length: number;
  role?: string;
  authored_turn?: number;
  starts_turn?: boolean;
}> = initialRows.map((row, index) => ({
  index,
  offset: index * 100,
  length: 100,
  role: row.role,
  authored_turn: index === 0 ? 0 : 1,
  ...(index === 1 ? { starts_turn: true } : {}),
}));

function updateSidecars(revision: number, revisionKnown = false): void {
  const transcriptLines = readFileSync(transcript, 'utf8')
    .split('\n')
    .filter((line) => line.trim());
  let exactOffset = 0;
  displayEntries = transcriptLines.map((line, index) => {
    const prior = displayEntries.find((entry) => entry.index === index);
    const record = JSON.parse(line) as { role?: string };
    const entry = {
      index,
      offset: exactOffset,
      length: Buffer.byteLength(`${line}\n`),
      ...(record.role ? { role: record.role } : {}),
      ...(prior?.authored_turn === undefined ? {} : { authored_turn: prior.authored_turn }),
      ...(prior?.starts_turn === undefined ? {} : { starts_turn: prior.starts_turn }),
    };
    exactOffset += Buffer.byteLength(`${line}\n`);
    return entry;
  });
  json(eventPath, {
    schema_version: 1,
    log_size: statSync(transcript).size,
    message_count: displayEntries.length,
    revision,
    content_digest: `revision-${revision}`,
    writer_id: 'observe-fixture',
  });
  json(displayPath, {
    schema_version: 1,
    revision,
    ...(revisionKnown ? { revision_known: true } : {}),
    message_count: displayEntries.length,
    entries: displayEntries,
  });
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
  json(metaPath, { ...meta, revision, content_digest: `revision-${revision}` });
}

try {
  writeFileSync(transcript, `${initialRows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  json(metaPath, {
    id,
    model: 'provider/model',
    preview: 'observe fixture',
    turns: 1,
    schema_version: 2,
    revision: 1,
    created_at: '2026-08-27T10:00:00.000000000Z',
    updated_at: '2026-08-27T10:00:01.000000000Z',
    writer_id: 'observe-fixture',
    content_digest: 'revision-1',
  });
  json(acpPath, { sessionId: id, status: { state: 'idle' } });
  updateSidecars(1);
  const stored = (await discoverReasonixStore({ root }))[0];
  if (!stored) throw new Error('observe fixture was not discovered');
  const info: SessionInfo = {
    id,
    nativeId: id,
    tool: 'reasonix',
    title: stored.title,
    status: 'idle',
    attachMode: 'observe',
  };
  let watchConstructions = 0;
  const watchTraces: string[] = [];
  const failingWatcher = new ReasonixObserveConnection({
    session: stored,
    info,
    watchStableMs: 5_000,
    trace: (event) => watchTraces.push(event.detail),
    watchFactory: (() => {
      watchConstructions += 1;
      const watcher = new EventEmitter() as EventEmitter & { close(): void };
      watcher.close = () => {};
      setTimeout(() => watcher.emit('error', new Error('injected watcher failure')), 0);
      return watcher;
    }) as unknown as typeof import('node:fs').watch,
  });
  failingWatcher.subscribe(() => {});
  const watcherCapped = await waitFor(() => watchTraces.some((trace) => trace.includes('watch re-arm limit reached')), 2_000);
  check('repeated asynchronous watcher errors reach the bounded re-arm ceiling',
    watcherCapped && watchConstructions === 9,
    JSON.stringify({ watchConstructions, watchTraces }));
  await failingWatcher.close();
  // A filesystem write in the close/open gap has no watcher to report it.
  const rearmMessages: AgentMessage[] = [];
  let firstWatcher: EventEmitter | undefined;
  let constructions = 0;
  const rearming = new ReasonixObserveConnection({
    session: stored, info,
    watchFactory: (() => {
      constructions += 1;
      const first = constructions === 1;
      const watcher = new EventEmitter() as EventEmitter & { close(): void };
      watcher.close = () => {
        if (!first) return;
        appendFileSync(transcript, `${JSON.stringify({ role: 'user', content: 'during rearm', raw_content: 'during rearm' })}\n`);
        updateSidecars(2);
      };
      if (first) firstWatcher = watcher;
      return watcher;
    }) as unknown as typeof import('node:fs').watch,
  });
  await rearming.getHistory();
  rearming.subscribe(message => rearmMessages.push(message));
  firstWatcher!.emit('error', new Error('rearm fixture'));
  const caughtGap = await waitFor(() => rearmMessages.some(message => message.type === 'user-message' && message.text === 'during rearm'));
  check('re-arming reconciles a write made while no watcher was installed', caughtGap, JSON.stringify(rearmMessages));
  await rearming.close();
  writeFileSync(transcript, `${initialRows.map(row => JSON.stringify(row)).join('\n')}\n`);
  updateSidecars(1);

  const traces: string[] = [];
  const connection = new ReasonixObserveConnection({
    session: stored,
    info,
    trace: (event) => traces.push(`${event.op}:${event.detail}`),
  });
  const history = await connection.getHistory();
  // Replay mapping once: conformance C03 (e2e/adapters/conformance/reasonix.test.ts).
  void history;

  const live: AgentMessage[] = [];
  connection.subscribe((message) => live.push(message));
  const appended = { role: 'user', content: 'two', raw_content: 'two', createdAt: 1_700_000_001_000 };
  appendFileSync(transcript, `${JSON.stringify(appended)}\n`);
  displayEntries.push({
    index: 3,
    offset: 300,
    length: 100,
    role: 'user',
    authored_turn: 2,
    starts_turn: true,
  });
  updateSidecars(2);
  // The append is admitted exactly once: conformance C05. The rewrite below is the later sentinel that proves no
  // duplicate followed the first row (checked after the reset arrives).
  const appendSeen = await waitFor(() => live.some((message) => message.type === 'user-message'));
  if (!appendSeen) throw new Error('the appended user row never arrived');

  const replacementPath = `${transcript}.replacement`;
  writeFileSync(replacementPath, `${JSON.stringify({ role: 'system', content: 'rewritten' })}\n`);
  renameSync(replacementPath, transcript);
  displayEntries = [{ index: 0, offset: 0, length: 50, role: 'system', authored_turn: 0 }];
  updateSidecars(3);
  const resetSeen = await waitFor(() => live.some((message) => message.type === 'history-reset'));
  const usersBeforeReset = live.slice(0, live.findIndex((message) => message.type === 'history-reset'))
    .filter((message) => message.type === 'user-message');
  check('the append tail admitted the new row exactly once, before the rewrite reset',
    usersBeforeReset.length === 1 && usersBeforeReset[0]?.text === 'two', JSON.stringify(live));
  check('a shrink/rewrite emits one canonical rollback reset instead of splicing history',
    resetSeen
      && live.filter((message) => message.type === 'history-reset').length === 1
      && live.find((message) => message.type === 'history-reset')?.semantic?.kind === 'rollback',
    JSON.stringify(live));

  const afterReplacement = { role: 'user', content: 'after replacement', raw_content: 'after replacement' };
  appendFileSync(transcript, `${JSON.stringify(afterReplacement)}\n`);
  displayEntries.push({
    index: 1,
    offset: 50,
    length: 100,
    role: 'user',
    authored_turn: 1,
    starts_turn: true,
  });
  updateSidecars(4);
  const replacementAppendSeen = await waitFor(() => live.some(
    (message) => message.type === 'user-message' && message.text === 'after replacement',
  ));
  check('the watcher re-arms after atomic replacement and tails the replacement inode',
    replacementAppendSeen,
    JSON.stringify(live));
  const interruptedReplay = await connection.getHistory();
  check('an idle replay ending in a user row reports an interrupted turn as cancelled',
    interruptedReplay.some((message) => message.type === 'run-summary'
      && message.status === 'cancelled'
      && message.userMessageKey === `reasonix:${id}:message:1`),
    JSON.stringify(interruptedReplay));

  // Observe refuses mutation: conformance C04.
  await connection.close();
  check('close is clean and idempotent', (await connection.close()) === undefined && traces.length === 0, traces.join(' | '));

  const captureMessages: AgentMessage[] = [];
  const captureSink: HistorySnapshotSink = {
    accept(message) {
      captureMessages.push(message);
      return true;
    },
  };
  const captureRows = [
    { role: 'user', content: 'capture-before', raw_content: 'capture-before' },
    { role: 'assistant', content: 'capture-answer' },
  ];
  writeFileSync(transcript, `${captureRows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  displayEntries = captureRows.map((row, index) => ({
    index,
    offset: index * 100,
    length: 100,
    role: row.role,
    authored_turn: 1,
    ...(index === 0 ? { starts_turn: true } : {}),
  }));
  updateSidecars(10);
  let appendedDuringCapture = false;
  const captureConnection = new ReasonixObserveConnection({
    session: stored,
    info,
    captureTestHook: () => {
      if (appendedDuringCapture) return;
      appendedDuringCapture = true;
      const row = { role: 'user', content: 'capture-after', raw_content: 'capture-after' };
      appendFileSync(transcript, `${JSON.stringify(row)}\n`);
      displayEntries.push({
        index: 2,
        offset: 200,
        length: 100,
        role: 'user',
        authored_turn: 2,
        starts_turn: true,
      });
      updateSidecars(11);
    },
  });
  const appendCapture = await captureConnection.captureHistorySnapshot(captureSink);
  check('snapshot capture retries an append and returns messages plus identity from one prefix',
    appendCapture !== undefined
      && !('refusal' in appendCapture)
      && appendCapture.identity.appendPosition === statSync(transcript).size
      && captureMessages.some((message) => message.type === 'user-message' && message.text === 'capture-after'),
    JSON.stringify({ appendCapture, messages: captureMessages }));
  await captureConnection.close();

  captureMessages.length = 0;
  const beforeRewrite = { role: 'user', content: 'same-size-a', raw_content: 'same-size-a' };
  writeFileSync(transcript, `${JSON.stringify(beforeRewrite)}\n`);
  displayEntries = [{ index: 0, offset: 0, length: 100, role: 'user', authored_turn: 1, starts_turn: true }];
  updateSidecars(20);
  let rewrittenDuringCapture = false;
  const rewriteCaptureConnection = new ReasonixObserveConnection({
    session: stored,
    info,
    captureTestHook: () => {
      if (rewrittenDuringCapture) return;
      rewrittenDuringCapture = true;
      const replacement = { role: 'user', content: 'same-size-b', raw_content: 'same-size-b' };
      writeFileSync(transcript, `${JSON.stringify(replacement)}\n`);
      updateSidecars(21);
    },
  });
  const rewriteCapture = await rewriteCaptureConnection.captureHistorySnapshot(captureSink);
  check('snapshot capture retries a same-length rewrite and never publishes the replaced prefix',
    rewriteCapture !== undefined
      && !('refusal' in rewriteCapture)
      && captureMessages.some((message) => message.type === 'user-message' && message.text === 'same-size-b')
      && !captureMessages.some((message) => message.type === 'user-message' && message.text === 'same-size-a'),
    JSON.stringify({ rewriteCapture, messages: captureMessages }));
  await rewriteCaptureConnection.close();

  const unchangedSidecarOld = { role: 'user', content: 'boundary-old', raw_content: 'boundary-old' };
  const unchangedSidecarNew = { role: 'user', content: 'boundary-new', raw_content: 'boundary-new' };
  writeFileSync(transcript, `${JSON.stringify(unchangedSidecarOld)}\n`);
  displayEntries = [{
    index: 0,
    offset: 0,
    length: Buffer.byteLength(JSON.stringify(unchangedSidecarOld)),
    role: 'user',
    authored_turn: 1,
    starts_turn: true,
  }];
  updateSidecars(29);
  let changedTranscriptOnly = false;
  const transcriptBoundaryConnection = new ReasonixObserveConnection({
    session: stored,
    info,
    snapshotTestHook: () => {
      if (changedTranscriptOnly) return;
      changedTranscriptOnly = true;
      writeFileSync(transcript, `${JSON.stringify(unchangedSidecarNew)}\n`);
    },
  });
  const transcriptBoundaryHistory = await transcriptBoundaryConnection.getHistory();
  check('ordinary replay retries a same-size transcript rewrite even when sidecars do not change',
    transcriptBoundaryHistory.some((message) => message.type === 'user-message' && message.text === 'boundary-new')
      && !transcriptBoundaryHistory.some((message) => message.type === 'user-message' && message.text === 'boundary-old'),
    JSON.stringify(transcriptBoundaryHistory));
  await transcriptBoundaryConnection.close();

  const consistencyBase = { role: 'user', content: 'consistent base', raw_content: 'consistent base' };
  writeFileSync(transcript, `${JSON.stringify(consistencyBase)}\n`);
  displayEntries = [{ index: 0, offset: 0, length: Buffer.byteLength(JSON.stringify(consistencyBase)), role: 'user', authored_turn: 1, starts_turn: true }];
  updateSidecars(30);
  let repair: (() => void) | undefined;
  const consistent = new TrackingReasonixObserveConnection({
    session: stored,
    info,
    snapshotTestHook: (attempt) => {
      if (attempt !== 0 || !repair) return;
      const apply = repair;
      repair = undefined;
      apply();
    },
  });
  await consistent.getHistory();

  const eventFirst = { role: 'assistant', content: 'event-first answer' };
  const eventFirstLine = JSON.stringify(eventFirst);
  const eventFirstOffset = statSync(transcript).size;
  const eventFirstSize = eventFirstOffset + Buffer.byteLength(`${eventFirstLine}\n`);
  json(eventPath, {
    schema_version: 1,
    log_size: eventFirstSize,
    message_count: 2,
    revision: 31,
    content_digest: 'revision-31',
    writer_id: 'observe-fixture',
  });
  repair = () => {
    appendFileSync(transcript, `${eventFirstLine}\n`);
    displayEntries.push({
      index: 1,
      offset: eventFirstOffset,
      length: Buffer.byteLength(eventFirstLine),
      role: 'assistant',
      authored_turn: 1,
    });
    updateSidecars(31);
  };
  const eventFirstHistory = await consistent.getHistory();
  check('ordinary replay retries an event-index-first append instead of declaring a rewrite',
    consistent.rewrites === 0
      && eventFirstHistory.some((message) => message.type === 'model-output' && message.text === 'event-first answer'),
    JSON.stringify({ rewrites: consistent.rewrites, eventFirstHistory }));

  const transcriptFirst = { role: 'user', content: 'transcript-first prompt', raw_content: 'transcript-first prompt' };
  const transcriptFirstLine = JSON.stringify(transcriptFirst);
  const transcriptFirstOffset = statSync(transcript).size;
  appendFileSync(transcript, `${transcriptFirstLine}\n`);
  repair = () => {
    displayEntries.push({
      index: 2,
      offset: transcriptFirstOffset,
      length: Buffer.byteLength(transcriptFirstLine),
      role: 'user',
      authored_turn: 2,
      starts_turn: true,
    });
    updateSidecars(32);
  };
  const transcriptFirstHistory = await consistent.getHistory();
  check('ordinary replay waits for sidecars after a transcript-first append',
    consistent.rewrites === 0
      && transcriptFirstHistory.some((message) => message.type === 'user-message' && message.text === 'transcript-first prompt'),
    JSON.stringify({ rewrites: consistent.rewrites, transcriptFirstHistory }));

  const rewritePlusAppendRows = readFileSync(transcript, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  rewritePlusAppendRows[0] = {
    role: 'user',
    content: 'consistent swap',
    raw_content: 'consistent swap',
  };
  const rewritePlusAppend = { role: 'system', content: 'appended with rewrite' };
  rewritePlusAppendRows.push(rewritePlusAppend);
  writeFileSync(transcript, `${rewritePlusAppendRows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  displayEntries.push({
    index: 3,
    offset: transcriptFirstOffset + Buffer.byteLength(`${transcriptFirstLine}\n`),
    length: Buffer.byteLength(JSON.stringify(rewritePlusAppend)),
    role: 'system',
    authored_turn: 2,
  });
  updateSidecars(33);
  const rewritePlusAppendHistory = await consistent.getHistory();
  check('a same-length accepted-prefix rewrite plus append triggers rollback detection',
    consistent.rewrites === 1
      && rewritePlusAppendHistory.some((message) => message.type === 'user-message' && message.text === 'consistent swap'),
    JSON.stringify({ rewrites: consistent.rewrites, rewritePlusAppendHistory }));
  await consistent.close();

  const raceBase = { role: 'user', content: 'race base', raw_content: 'race base' };
  writeFileSync(transcript, `${JSON.stringify(raceBase)}\n`);
  displayEntries = [{
    index: 0,
    offset: 0,
    length: Buffer.byteLength(JSON.stringify(raceBase)),
    role: 'user',
    authored_turn: 1,
    starts_turn: true,
  }];
  updateSidecars(40);
  const replayRace = new ReasonixObserveConnection({ session: stored, info });
  await replayRace.getHistory();
  const replayRaceLive: AgentMessage[] = [];
  replayRace.subscribe((message) => replayRaceLive.push(message));
  const racedRow = { role: 'assistant', content: 'raced append' };
  const racedLine = JSON.stringify(racedRow);
  const racedOffset = statSync(transcript).size;
  appendFileSync(transcript, `${racedLine}\n`);
  displayEntries.push({
    index: 1,
    offset: racedOffset,
    length: Buffer.byteLength(racedLine),
    role: 'assistant',
    authored_turn: 1,
  });
  updateSidecars(41);
  const joiningReplay = await replayRace.getHistory();
  const replayTailDelivered = await waitFor(() => replayRaceLive.some((message) =>
    message.type === 'model-output' && message.text === 'raced append'));
  check('a second-client replay during debounce does not consume the existing subscriber tail',
    joiningReplay.some((message) => message.type === 'model-output' && message.text === 'raced append')
      && replayTailDelivered
      && replayRaceLive.filter((message) => message.type === 'model-output' && message.text === 'raced append').length === 1,
    JSON.stringify(replayRaceLive));

  const capturedRace = { role: 'user', content: 'capture raced', raw_content: 'capture raced' };
  const capturedRaceLine = JSON.stringify(capturedRace);
  const capturedRaceOffset = statSync(transcript).size;
  appendFileSync(transcript, `${capturedRaceLine}\n`);
  displayEntries.push({
    index: 2,
    offset: capturedRaceOffset,
    length: Buffer.byteLength(capturedRaceLine),
    role: 'user',
    authored_turn: 2,
    starts_turn: true,
  });
  updateSidecars(42);
  const raceCaptureMessages: AgentMessage[] = [];
  await replayRace.captureHistorySnapshot({
    accept(message) {
      raceCaptureMessages.push(message);
      return true;
    },
  });
  const captureTailDelivered = await waitFor(() => replayRaceLive.some((message) =>
    message.type === 'user-message' && message.text === 'capture raced'));
  check('optimized history capture during debounce also leaves the subscriber tail deliverable',
    raceCaptureMessages.some((message) => message.type === 'user-message' && message.text === 'capture raced')
      && captureTailDelivered
      && replayRaceLive.filter((message) => message.type === 'user-message' && message.text === 'capture raced').length === 1,
    JSON.stringify(replayRaceLive));
  check('accepted-prefix rewrite state is one bounded raw byte buffer, not per-record serialization',
    Buffer.isBuffer((replayRace as unknown as { durablePrefixValue?: unknown }).durablePrefixValue)
      && !('recordPrefixValue' in (replayRace as unknown as Record<string, unknown>)));
  await replayRace.close();

  // Bun reports a rename-over only under the name renamed FROM, and every session's files share
  // this directory: a replacement of ours is found by its identity, another session's costs no read.
  let replacementReads = 0;
  const replaced = new ReasonixObserveConnection({
    session: stored,
    info,
    snapshotTestHook: (attempt) => { if (attempt === 0) replacementReads += 1; },
  });
  await replaced.getHistory();
  const replacedLive: AgentMessage[] = [];
  replaced.subscribe((message) => replacedLive.push(message));
  // One ordinary append drains first, so the reader knows this session's files.
  const settledRow = { role: 'assistant', content: 'before the replacement' };
  const settledLine = JSON.stringify(settledRow);
  const settledOffset = statSync(transcript).size;
  appendFileSync(transcript, `${settledLine}\n`);
  displayEntries.push({
    index: displayEntries.length,
    offset: settledOffset,
    length: Buffer.byteLength(settledLine),
    role: 'assistant',
    authored_turn: 2,
  });
  // From here the display index states its revision, as both measured Reasonix versions write it, so
  // the reader judges a replacement by its source identity and bytes, not by the file's mtime.
  updateSidecars(43, true);
  const settledSeen = await waitFor(() => replacedLive.some((message) =>
    message.type === 'model-output' && message.text === 'before the replacement'));
  await sleep(200);
  const readsBeforeForeign = replacementReads;
  const foreignTranscript = join(sessionDir, 'another-session.jsonl');
  writeFileSync(`${foreignTranscript}.tmp`, `${JSON.stringify({ role: 'user', content: 'elsewhere' })}\n`);
  renameSync(`${foreignTranscript}.tmp`, foreignTranscript);
  await sleep(300);
  check('another session\'s file renamed in the shared directory reads nothing of this session',
    settledSeen && replacementReads === readsBeforeForeign
      && !replacedLive.some((message) => message.type === 'history-reset'),
    JSON.stringify({ settledSeen, readsBeforeForeign, replacementReads }));
  // The same bytes, written aside and renamed over the transcript; no sidecar changes. Reasonix 2.61.0
  // saves this way, appends included, so it is the same history: the next append tails, no reset.
  writeFileSync(`${transcript}.tmp`, readFileSync(transcript));
  renameSync(`${transcript}.tmp`, transcript);
  const afterRenameLine = JSON.stringify({ role: 'assistant', content: 'after the same-bytes rename' });
  const afterRenameOffset = statSync(transcript).size;
  appendFileSync(transcript, `${afterRenameLine}\n`);
  displayEntries.push({
    index: displayEntries.length,
    offset: afterRenameOffset,
    length: Buffer.byteLength(afterRenameLine),
    role: 'assistant',
    authored_turn: 2,
  });
  updateSidecars(44, true);
  const afterRenameSeen = await waitFor(() => replacedLive.some((message) =>
    message.type === 'model-output' && message.text === 'after the same-bytes rename'));
  check('a transcript renamed over with the same bytes keeps the open reader\'s history',
    afterRenameSeen && !replacedLive.some((message) => message.type === 'history-reset'),
    JSON.stringify(replacedLive.map((message) => message.type)));
  // A changed row renamed over the transcript is a rewrite: exactly one reset.
  const changedText = readFileSync(transcript, 'utf8')
    .replace(JSON.stringify(settledRow), JSON.stringify({ ...settledRow, content: 'edited before the replacement' }));
  writeFileSync(`${transcript}.tmp`, changedText);
  renameSync(`${transcript}.tmp`, transcript);
  updateSidecars(45, true);
  const changedReset = await waitFor(() => replacedLive.some((message) => message.type === 'history-reset'));
  await sleep(300);
  check('a transcript renamed over with a changed row resets the open reader once',
    changedReset && replacedLive.filter((message) => message.type === 'history-reset').length === 1,
    JSON.stringify(replacedLive.map((message) => message.type)));
  await replaced.close();

  // Reasonix 2.61.0, captured: a 20 ms poller recorded every version of one session's flat
  // transcript through a prompt, a cancel, a provider failure and a recovery. Half of the saves
  // renamed a new file over the old, and settling the cancelled and the failed turn rewrote that
  // turn's user row to its raw prompt (the failed one shrank the file). None of it changes a row a
  // reader shows, so none of it is a history reset; editing any other accepted row still is.
  {
    const versions = (JSON.parse(readFileSync(
      join(import.meta.dir, 'fixtures', 'reasonix-v2.61.0-capture.json'),
      'utf8',
    )) as { transcriptVersions: Array<{ seq: number; renamed: boolean; text: string }> }).transcriptVersions;
    const probeRoot = mkdtempSync(join(tmpdir(), 'cosyncing-reasonix-v261-observe-'));
    const probeDir = join(probeRoot, 'sessions');
    const probeId = 'captured-v261-session';
    const probeTranscript = join(probeDir, `${probeId}.jsonl`);
    mkdirSync(probeDir, { recursive: true });
    const writeVersion = (text: string, revision: number, renamed: boolean): void => {
      if (renamed) {
        writeFileSync(`${probeTranscript}.tmp`, text);
        renameSync(`${probeTranscript}.tmp`, probeTranscript);
      } else {
        writeFileSync(probeTranscript, text);
      }
      let offset = 0;
      const entries = text.split('\n').filter(Boolean).map((line, index) => {
        const entry = { index, offset, length: Buffer.byteLength(line) + 1, role: (JSON.parse(line) as { role: string }).role };
        offset += entry.length;
        return entry;
      });
      json(join(probeDir, `${probeId}.event-index.json`), {
        schema_version: 1, log_size: 1, message_count: entries.length, revision,
        content_digest: `${String(revision).padStart(64, '0')}`, writer_id: 'captured-writer',
      });
      json(join(probeDir, `${probeId}.display-index.json`), {
        schema_version: 1, revision, revision_known: true, transcript_size: Buffer.byteLength(text),
        message_count: entries.length, entries,
      });
      json(`${probeTranscript}.meta`, {
        id: probeId, schema_version: 2, revision, model: 'fixtprov/fixture-model-0001',
        created_at: '2026-11-24T13:34:15.000000000Z', updated_at: '2026-11-24T13:36:08.000000000Z',
        writer_id: 'captured-writer', content_digest: `${String(revision).padStart(64, '0')}`,
      });
    };
    try {
      json(join(probeDir, `${probeId}.acp.json`), { sessionId: probeId, status: { state: 'idle' } });
      writeVersion(versions[0]!.text, versions[0]!.seq, false);
      const probeStored = (await discoverReasonixStore({ root: probeRoot }))[0];
      if (!probeStored) throw new Error('captured 2.61.0 transcript was not discovered');
      const sourceBefore = await reasonixHistorySourceIdentity(probeStored);
      const probe = new TrackingReasonixObserveConnection({
        session: probeStored,
        info: { ...info, id: probeId, nativeId: probeId },
      });
      await probe.getHistory();
      const probeLive: AgentMessage[] = [];
      probe.subscribe((message) => probeLive.push(message));
      const tailed = () => (probe as unknown as { recordCount: number }).recordCount;
      let settledAll = true;
      for (const version of versions.slice(1)) {
        writeVersion(version.text, version.seq, version.renamed);
        const rows = version.text.split('\n').filter(Boolean).length;
        settledAll = await waitFor(() => tailed() === rows) && settledAll;
      }
      const lastRows = versions.at(-1)!.text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as {
        role: string; raw_content?: string;
      });
      const prompts = lastRows.slice(3).filter((row) => row.role === 'user').map((row) => row.raw_content);
      const tailedUsers = probeLive.filter((message) => message.type === 'user-message').map((message) => message.text);
      check('2.61.0: renamed saves and settled interrupted turns tail as appends, with no history reset',
        settledAll
          && probe.rewrites === 0
          && !probeLive.some((message) => message.type === 'history-reset')
          && JSON.stringify(tailedUsers) === JSON.stringify(prompts)
          && versions.some((version) => version.renamed),
        JSON.stringify({ settledAll, rewrites: probe.rewrites, tailedUsers, prompts }));
      const sourceAfter = await reasonixHistorySourceIdentity(probeStored);
      check('2.61.0: the history source keeps one identity across the renames while its revision advances',
        sourceBefore?.sourceId === sourceAfter?.sourceId && sourceBefore?.revision !== sourceAfter?.revision,
        JSON.stringify({ sourceBefore, sourceAfter }));
      // The same capture with one earlier assistant answer edited: a real rewrite.
      const edited = versions.at(-1)!.text.split('\n').map((line, index) => {
        if (index !== 2 || !line) return line;
        const row = JSON.parse(line) as Record<string, unknown>;
        return JSON.stringify({ ...row, content: `${String(row.content)} (edited)` });
      }).join('\n');
      writeVersion(edited, versions.at(-1)!.seq + 1, true);
      const editReset = await waitFor(() => probeLive.some((message) => message.type === 'history-reset'));
      check('2.61.0: editing any other accepted row is still one history reset',
        editReset && probe.rewrites === 1,
        JSON.stringify({ rewrites: probe.rewrites }));
      await probe.close();
    } finally {
      rmSync(probeRoot, { recursive: true, force: true });
    }
  }

} catch (error) {
  check('test harness completed', false, error instanceof Error ? error.message : String(error));
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
