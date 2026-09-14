#!/usr/bin/env bun
export {};
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverReasonixStore,
  parseReasonixTimestamp,
  readReasonixTranscript,
  reasonixHistorySourceIdentity,
  reasonixPathContained,
  reasonixStoreRoot,
  ReasonixStoreEnumerationError,
} from '../src/store.ts';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function json(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function sessionFixture(
  dir: string,
  id: string,
  options: {
    schema?: number;
    acp?: boolean;
    acpStatus?: string;
    updatedAt?: string;
    display?: boolean;
    eventSchema?: number;
    displaySchema?: number;
  } = {},
): void {
  mkdirSync(dir, { recursive: true });
  const transcript = join(dir, `${id}.jsonl`);
  const rows = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'hello', raw_content: 'hello', createdAt: 1_700_000_000_000 },
    { role: 'assistant', content: 'world', workDurationMs: 12 },
  ];
  const lines = rows.map((row) => JSON.stringify(row));
  writeFileSync(transcript, `${lines.join('\n')}\n`);
  json(`${transcript}.meta`, {
    id,
    model: 'provider/model',
    preview: `title ${id}`,
    turns: 1,
    schema_version: options.schema ?? 2,
    revision: 1,
    created_at: '2026-08-27T10:00:00.123456789Z',
    updated_at: options.updatedAt ?? '2026-08-27T10:00:01.987654321Z',
    writer_id: 'fixture-writer',
    content_digest: 'revision-one',
  });
  json(join(dir, `${id}.event-index.json`), {
    schema_version: options.eventSchema ?? 1,
    log_size: Buffer.byteLength(readFileText(transcript)),
    message_count: 3,
    revision: 1,
    writer_id: 'fixture-writer',
    content_digest: 'revision-one',
  });
  if (options.display !== false) {
    json(join(dir, `${id}.display-index.json`), {
      schema_version: options.displaySchema ?? 1,
      revision: 1,
      revision_known: true,
      transcript_size: Buffer.byteLength(readFileText(transcript)),
      message_count: rows.length,
      entries: (() => {
        let offset = 0;
        return lines.map((line, index) => {
          const entry = {
            index,
            offset,
            length: Buffer.byteLength(`${line}\n`),
            role: rows[index]!.role,
            authored_turn: index === 0 ? 0 : 1,
            ...(index === 1 ? { starts_turn: true } : {}),
          };
          offset += Buffer.byteLength(`${line}\n`);
          return entry;
        });
      })(),
    });
  }
  if (options.acp) {
    json(join(dir, `${id}.acp.json`), {
      sessionId: id,
      cwd: '/tmp/reasonix-workspace',
      model: 'provider/model',
      title: 'ACP-created fixture',
      createdAt: '2026-08-27T10:00:00.123456789Z',
      updatedAt: '2026-08-27T10:00:01.987654321Z',
      toolApprovalMode: 'ask',
      status: {
        state: options.acpStatus ?? 'idle',
        cumulative: {
          promptTokens: 21,
          completionTokens: 8,
          reasoningTokens: 3,
          cacheHitTokens: 5,
          cacheMissTokens: 16,
          estimated: true,
          estimatedCost: 0.25,
          source: 'executor',
          costComplete: false,
        },
      },
    });
  }
  writeFileSync(join(dir, `${id}.events.jsonl`), '{"not":"a transcript"}\n');
  json(join(dir, `${id}.recovery.json`), {});
  mkdirSync(join(dir, `${id}.inbox`), { recursive: true });
  writeFileSync(join(dir, `${id}.inbox`, 'transaction.lock'), '');
}

function readFileText(path: string): string {
  return readFileSync(path, 'utf8');
}

const root = mkdtempSync(join(tmpdir(), 'cosyncing-reasonix-store-'));
try {
  const globalDir = join(root, 'sessions');
  const projectDir = join(root, 'projects', '-tmp-legacy', 'sessions');
  sessionFixture(globalDir, 'global-session', { acp: true });
  sessionFixture(projectDir, 'legacy-session');
  sessionFixture(projectDir, 'future-schema', { schema: 3 });
  sessionFixture(projectDir, 'future-event-schema', { eventSchema: 2 });
  sessionFixture(projectDir, 'future-display-schema', { displaySchema: 2 });
  sessionFixture(projectDir, 'missing-display', { display: false });
  sessionFixture(projectDir, 'active-old', {
    acp: true,
    acpStatus: 'working',
    updatedAt: '2020-01-01T00:00:00.000000000Z',
  });

  const traces: string[] = [];
  const sessions = await discoverReasonixStore({
    root,
    trace: (event) => traces.push(`${event.op}:${event.detail}`),
  });
  check('discovery reads current global and legacy project layouts',
    sessions.some((session) => session.id === 'global-session' && session.layout === 'global')
      && sessions.some((session) => session.id === 'legacy-session' && session.layout === 'project'),
    sessions.map((session) => `${session.id}:${session.layout}`).join(','));
  check('events JSONL and lock/recovery sidecars never become sessions',
    !sessions.some((session) => session.id.endsWith('.events'))
      && sessions.length === 4,
    sessions.map((session) => session.id).join(','));
  check('unknown metadata schema fails closed with a named trace',
    !sessions.some((session) => session.id === 'future-schema')
      && traces.some((trace) => trace.startsWith('schema-refused:')),
    traces.join(' | '));
  check('unknown event and display index schemas fail closed during discovery',
    !sessions.some((session) => session.id === 'future-event-schema')
      && !sessions.some((session) => session.id === 'future-display-schema')
      && traces.filter((trace) => trace.startsWith('schema-refused:')).length >= 3,
    traces.join(' | '));

  const global = sessions.find((session) => session.id === 'global-session');
  check('ACP metadata supplies model, approval mode, and bounded cumulative usage',
    global?.cwd === '/tmp/reasonix-workspace'
      && global.title === 'ACP-created fixture'
      && global.currentModel?.providerID === 'provider'
      && global.currentModel.modelID === 'model'
      && global.currentMode === 'ask'
      && global.usage?.promptTokens === 21
      && global.usage.estimatedCost === 0.25
      && global.usage.costComplete === false,
    JSON.stringify(global));

  const scalarRoot = join(root, 'bounded-scalars-case');
  const scalarDir = join(scalarRoot, 'sessions');
  sessionFixture(scalarDir, 'bounded-scalars', { acp: true });
  json(join(scalarDir, 'bounded-scalars.jsonl.meta'), {
    id: 'bounded-scalars',
    schema_version: 2,
    preview: 'p'.repeat(4_097),
    model: 'm'.repeat(513),
  });
  json(join(scalarDir, 'bounded-scalars.acp.json'), {
    sessionId: 'bounded-scalars',
    title: 't'.repeat(4_097),
    model: 'm'.repeat(513),
    cwd: `/${'w'.repeat(32_768)}`,
  });
  const boundedScalars = (await discoverReasonixStore({ root: scalarRoot }))[0];
  check('discovery drops raw metadata and refuses oversized published scalars',
    boundedScalars?.title === 'bounded-scalars'
      && boundedScalars.model === undefined
      && boundedScalars.cwd === undefined
      && !('meta' in boundedScalars),
    JSON.stringify(boundedScalars));

  const nanosecond = parseReasonixTimestamp('2026-08-27T10:00:00.123456789Z');
  check('nine-digit fractional timestamps parse to the correct millisecond',
    nanosecond === Date.parse('2026-08-27T10:00:00.123Z'), String(nanosecond));

  const cutoff = await discoverReasonixStore({
    root,
    updatedAfter: Date.parse('2026-08-27T10:00:02Z'),
  });
  check('updatedAfter excludes stale idle rows but retains an active old session',
    cutoff.length === 1 && cutoff[0]?.id === 'active-old' && cutoff[0].status === 'working',
    cutoff.map((session) => `${session.id}:${session.status}`).join(','));

  const budgetRoot = join(root, 'budget-case');
  sessionFixture(join(budgetRoot, 'sessions'), 'z-global-older', {
    updatedAt: '2026-08-27T00:00:00.000000000Z',
  });
  sessionFixture(join(budgetRoot, 'projects', 'later-project', 'sessions'), 'a-project-newer', {
    updatedAt: '2026-08-30T00:00:00.000000000Z',
  });
  const budgeted = await discoverReasonixStore({ root: budgetRoot, maxSessions: 1 });
  check('the discovery limit chooses the newest candidate across all layouts',
    budgeted.length === 1 && budgeted[0]?.id === 'a-project-newer',
    budgeted.map((session) => session.id).join(','));

  const duplicateRoot = join(root, 'duplicate-id-case');
  sessionFixture(join(duplicateRoot, 'sessions'), 'duplicate-native-id');
  sessionFixture(join(duplicateRoot, 'projects', 'legacy-copy', 'sessions'), 'duplicate-native-id');
  const duplicateTraces: string[] = [];
  const duplicateSessions = await discoverReasonixStore({
    root: duplicateRoot,
    trace: (event) => duplicateTraces.push(event.detail),
  });
  check('duplicate native ids across store layouts fail closed instead of attaching an arbitrary copy',
    duplicateSessions.every((session) => session.id !== 'duplicate-native-id')
      && duplicateTraces.some((detail) => detail.includes('duplicate native session id')),
    duplicateTraces.join(' | '));

  const boundedWorkRoot = join(root, 'bounded-work-case');
  const boundedWorkSessions = join(boundedWorkRoot, 'sessions');
  for (let index = 0; index < 4; index += 1) {
    sessionFixture(boundedWorkSessions, `bounded-work-${index}`);
  }
  const boundedWorkTraces: string[] = [];
  const boundedWork = await discoverReasonixStore({
    root: boundedWorkRoot,
    maxScanEntries: 2,
    trace: (event) => boundedWorkTraces.push(`${event.op}:${event.detail}`),
  });
  check('discovery work exhaustion refuses a partial roster with an explicit bound trace',
    boundedWork.length === 0
      && boundedWorkTraces.some((trace) => trace.includes('refusing partial discovery')),
    boundedWorkTraces.join(' | '));

  const crowdedRoot = join(root, 'crowded-case');
  const crowdedSessions = join(crowdedRoot, 'sessions');
  for (let index = 1; index <= 4; index += 1) {
    const id = `zzzz-random-uuid-${index}`;
    sessionFixture(crowdedSessions, id, {
      updatedAt: `2026-08-30T00:00:0${index}.000000000Z`,
    });
    utimesSync(join(crowdedSessions, `${id}.jsonl`), index, index);
  }
  const newestUuid = '0000-random-uuid-newest';
  sessionFixture(crowdedSessions, newestUuid, {
    updatedAt: '2026-08-30T00:00:09.000000000Z',
  });
  utimesSync(join(crowdedSessions, `${newestUuid}.jsonl`), 9, 9);
  const crowded = await discoverReasonixStore({ root: crowdedRoot, maxSessions: 1 });
  check('the per-directory discovery bound uses transcript freshness instead of random UUID order',
    crowded.length === 1 && crowded[0]?.id === newestUuid,
    crowded.map((session) => session.id).join(','));

  const manyProjectsRoot = join(root, 'many-projects-case');
  const projectsRoot = join(manyProjectsRoot, 'projects');
  for (let index = 0; index < 256; index += 1) {
    mkdirSync(join(projectsRoot, `zz-project-${String(index).padStart(3, '0')}`, 'sessions'), { recursive: true });
  }
  const newestProjectSessions = join(projectsRoot, '000-newest-project', 'sessions');
  sessionFixture(newestProjectSessions, 'project-newest-session', {
    updatedAt: '2026-08-30T00:00:10.000000000Z',
  });
  utimesSync(join(newestProjectSessions, 'project-newest-session.jsonl'), 10, 10);
  const manyProjects = await discoverReasonixStore({ root: manyProjectsRoot, maxSessions: 1 });
  check('the project bound chooses by contained transcript freshness rather than cwd-derived project name',
    manyProjects.length === 1 && manyProjects[0]?.id === 'project-newest-session',
    manyProjects.map((session) => session.id).join(','));

  const missingDisplay = sessions.find((session) => session.id === 'missing-display');
  if (!global || !missingDisplay) throw new Error('fixture discovery failed');
  const history = await readReasonixTranscript(global);
  check('bounded transcript read returns all rows and the pinned display index',
    history.records.length === 3 && history.displayEntries.length === 3 && history.issues.length === 0,
    JSON.stringify({ rows: history.records.length, display: history.displayEntries.length, issues: history.issues }));
  const originalTranscript = readFileText(global.transcriptPath);
  const originalDisplay = readFileText(global.displayIndexPath);
  const malformedLine = 'not-json';
  writeFileSync(global.transcriptPath, `${malformedLine}\n`);
  json(global.displayIndexPath, {
    schema_version: 1,
    revision: 1,
    transcript_size: Buffer.byteLength(`${malformedLine}\n`),
    entries: [{ index: 0, offset: 0, length: Buffer.byteLength(`${malformedLine}\n`) }],
  });
  const malformedRecordRead = await readReasonixTranscript(global);
  check('malformed JSONL fails Drive completeness even with a structurally exact role-less display entry',
    malformedRecordRead.records[0]?.__reasonixMalformed === true
      && malformedRecordRead.issues.some((issue) => issue.includes('transcript records were malformed')),
    JSON.stringify(malformedRecordRead.issues));
  writeFileSync(global.transcriptPath, originalTranscript);
  writeFileSync(global.displayIndexPath, originalDisplay);
  const validDisplayIndex = JSON.parse(readFileText(global.displayIndexPath)) as {
    schema_version: number;
    entries: Array<Record<string, unknown>>;
  };
  const malformedBoundaryIssues: string[][] = [];
  for (const mutate of [
    (entries: Array<Record<string, unknown>>) => { entries[1]!.offset = entries[0]!.offset; },
    (entries: Array<Record<string, unknown>>) => { entries[1]!.offset = Number(entries[1]!.offset) - 1; },
    (entries: Array<Record<string, unknown>>) => { entries[1]!.offset = Number(entries[1]!.offset) + 1; },
  ]) {
    const malformed = structuredClone(validDisplayIndex);
    mutate(malformed.entries);
    json(global.displayIndexPath, malformed);
    malformedBoundaryIssues.push((await readReasonixTranscript(global)).issues);
  }
  json(global.displayIndexPath, validDisplayIndex);
  check('duplicate, overlapping, and shifted display offsets fail exact JSONL-boundary validation',
    malformedBoundaryIssues.every((issues) => issues.some((issue) => issue.includes('exact transcript JSONL boundaries'))),
    JSON.stringify(malformedBoundaryIssues));
  const degraded = await readReasonixTranscript(missingDisplay);
  check('a missing display index yields records plus a stated issue, never an empty session',
    degraded.records.length === 3 && degraded.issues.some((issue) => issue.includes('display index')),
    JSON.stringify(degraded.issues));

  const before = await reasonixHistorySourceIdentity(global);
  const appendLine = JSON.stringify({ role: 'assistant', content: 'append' });
  const appendOffset = Buffer.byteLength(readFileText(global.transcriptPath));
  appendFileSync(global.transcriptPath, `${appendLine}\n`);
  json(global.displayIndexPath, {
    ...validDisplayIndex,
    revision: 2,
    revision_known: true,
    transcript_size: Buffer.byteLength(readFileText(global.transcriptPath)),
    message_count: 4,
    entries: [
      ...validDisplayIndex.entries,
      { index: 3, offset: appendOffset, length: Buffer.byteLength(`${appendLine}\n`), role: 'assistant', authored_turn: 1 },
    ],
  });
  json(global.eventIndexPath, {
    schema_version: 1,
    log_size: 321,
    message_count: 4,
    revision: 2,
    writer_id: 'fixture-writer',
    content_digest: 'revision-two',
  });
  const after = await reasonixHistorySourceIdentity(global);
  check('ordinary append keeps source identity while revision and position advance',
    before?.sourceId === after?.sourceId
      && before?.rewriteToken === undefined
      && after?.rewriteToken === undefined
      && before?.revision !== after?.revision
      && (after?.appendPosition ?? 0) > (before?.appendPosition ?? 0),
    JSON.stringify({ before, after }));

  appendFileSync(global.transcriptPath, '{"role":"assistant","content":"partial');
  const partial = await readReasonixTranscript(global);
  check('an unterminated final JSONL segment is buffered until its newline arrives',
    partial.records.length === 4
      && !partial.records.some((record) => record.__reasonixMalformed === true),
    JSON.stringify(partial.records.at(-1)));

  json(global.displayIndexPath, { schema_version: 2, entries: [] });
  const refusedDisplay = await readReasonixTranscript(global);
  check('an unknown display schema refuses replay instead of minting line-order identities',
    refusedDisplay.records.length === 0
      && refusedDisplay.issues.some((issue) => issue.includes('replay refused')),
    JSON.stringify(refusedDisplay.issues));

  check('path containment refuses sibling-prefix and parent escapes',
    reasonixPathContained(root, join(root, 'sessions', 'x'))
      && !reasonixPathContained(root, `${root}-sibling/file`)
      && !reasonixPathContained(root, join(root, '..', 'escape')));
  check('REASONIX_HOME resolution is explicit and absolute',
    reasonixStoreRoot({ REASONIX_HOME: join(root, 'custom') }, '/unused') === join(root, 'custom'));

  const symlinkRoot = mkdtempSync(join(tmpdir(), 'cosyncing-reasonix-symlink-root-'));
  const symlinkOutside = mkdtempSync(join(tmpdir(), 'cosyncing-reasonix-symlink-outside-'));
  try {
    const insideSessions = join(symlinkRoot, 'sessions');
    sessionFixture(insideSessions, 'escaped-session', { acp: true });
    const escaped = (await discoverReasonixStore({ root: symlinkRoot }))[0];
    if (!escaped) throw new Error('intermediate-symlink fixture was not discovered');
    const outsideSessions = join(symlinkOutside, 'sessions');
    renameSync(insideSessions, outsideSessions);
    symlinkSync(outsideSessions, insideSessions, 'dir');
    const refused = await readReasonixTranscript(escaped);
    check('store reads reject an intermediate directory symlink that escapes the configured root',
      refused.records.length === 0
        && refused.issues.some((issue) => issue.includes('containment')),
      JSON.stringify(refused.issues));
  } finally {
    rmSync(symlinkRoot, { recursive: true, force: true });
    rmSync(symlinkOutside, { recursive: true, force: true });
  }
  // A STRICT enumeration may not be truncated, only refused. Ownership reads it
  // as "no durable session carries this id" and grants exclusivity on the
  // strength of it, and every cut here drops the OLDEST entries — which is
  // exactly where a reused id lives. Each of the three cuts on this path gets a
  // case, because the first fix closed one of them and left the others.
  {
    const truncRoot = mkdtempSync(join(tmpdir(), 'reasonix-truncation-'));
    try {
      // More project directories than one scan enumerates, with the target in
      // the stalest of them.
      const projects = join(truncRoot, 'projects');
      for (let index = 0; index < 260; index += 1) {
        const dir = join(projects, `p${String(index).padStart(4, '0')}`, 'sessions');
        sessionFixture(dir, `session-${String(index)}`);
      }
      const lenient = await discoverReasonixStore({ root: truncRoot, maxScanEntries: 100_000 });
      let strictError: unknown;
      try {
        await discoverReasonixStore({
          root: truncRoot,
          maxScanEntries: 100_000,
          requireCompleteEnumeration: true,
        });
      } catch (error) {
        strictError = error;
      }
      check('a strict enumeration refuses more project directories than it can enumerate',
        lenient.length > 0 && strictError instanceof ReasonixStoreEnumerationError,
        JSON.stringify({ lenient: lenient.length, strict: String(strictError) }));
    } finally {
      rmSync(truncRoot, { recursive: true, force: true });
    }
  }
  {
    const capRoot = mkdtempSync(join(tmpdir(), 'reasonix-cap-'));
    try {
      const sessions = join(capRoot, 'sessions');
      for (let index = 0; index < 6; index += 1) sessionFixture(sessions, `capped-${String(index)}`);
      const lenient = await discoverReasonixStore({ root: capRoot, maxSessions: 3 });
      let strictError: unknown;
      try {
        await discoverReasonixStore({ root: capRoot, maxSessions: 3, requireCompleteEnumeration: true });
      } catch (error) {
        strictError = error;
      }
      check('a strict enumeration refuses to return only the freshest maxSessions',
        lenient.length === 3 && strictError instanceof ReasonixStoreEnumerationError,
        JSON.stringify({ lenient: lenient.length, strict: String(strictError) }));
    } finally {
      rmSync(capRoot, { recursive: true, force: true });
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
