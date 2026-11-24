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
  isReasonixTranscriptName,
  parseReasonixTimestamp,
  readReasonixTranscript,
  REASONIX_JSONL_SIDECAR_SUFFIXES,
  reasonixHistorySourceIdentity,
  reasonixPathContained,
  reasonixSessionUsage,
  reasonixSettlementExtendsPrefix,
  reasonixSessionUsageValue,
  reasonixStoreRoot,
  ReasonixStoreEnumerationError,
} from '../src/store.ts';
import type { ReasonixDisplayEntry, ReasonixTranscriptRecord } from '../src/mapping.ts';

/** Scrubbed 2026-11-24 capture of Reasonix 2.61.0; byte offsets are as Reasonix wrote them. */
interface CapturedSessionFiles {
  transcript: string;
  meta: string;
  acp: string;
  eventIndex: string;
  events: string;
  displayIndex: string;
}
const v261 = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'reasonix-v2.61.0-capture.json'), 'utf8')) as {
  created: { sessionId: string; final: CapturedSessionFiles; beforeCancel: Pick<CapturedSessionFiles, 'transcript' | 'displayIndex'> };
  migrated: { sessionId: string; continued: CapturedSessionFiles };
  transcriptVersions: Array<{ seq: number; renamed: boolean; text: string }>;
  wire: Record<string, { params?: { status?: { usage?: { cumulative?: unknown } } } }>;
};
function writeCapturedSession(dir: string, id: string, files: CapturedSessionFiles): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), files.transcript);
  writeFileSync(join(dir, `${id}.jsonl.meta`), files.meta);
  writeFileSync(join(dir, `${id}.acp.json`), files.acp);
  writeFileSync(join(dir, `${id}.event-index.json`), files.eventIndex);
  writeFileSync(join(dir, `${id}.events.jsonl`), files.events);
  writeFileSync(join(dir, `${id}.display-index.json`), files.displayIndex);
}

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
  // Unknown metadata schema: conformance C21 'an unknown metadata schema'.
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
    boundedScalars?.title === ''
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

  // Duplicate native ids across layouts: conformance C21 'one id in both the global and a project layout'.

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
  // Reasonix 2.61.0, captured. Its ACP sessions stay in the global `sessions/` store at the same
  // schemas, beside new `.jsonl` sidecars (upstream `jsonlSidecarSuffixes`) that are not
  // conversations, and `v4-<id>.jsonl` imports this adapter cannot Resume.
  {
    const v2Root = mkdtempSync(join(tmpdir(), 'reasonix-v261-store-'));
    try {
      const sessions = join(v2Root, 'sessions');
      const id = v261.created.sessionId;
      writeCapturedSession(sessions, id, v261.created.final);
      // The non-conversation files 2.61.0 left beside the captured session, by name.
      for (const suffix of ['.jsonl.lease.json', '.jsonl.lease.lock', '.jsonl.lock', '.jsonl.telemetry.json', '.goal-state.json']) {
        writeFileSync(join(sessions, `${id}${suffix}`), '');
      }
      // Upstream's `.jsonl` sidecars, each holding the session's own records so a scan that
      // mistook one for a conversation would list it.
      for (const suffix of REASONIX_JSONL_SIDECAR_SUFFIXES.filter((name) => name !== '.events.jsonl')) {
        writeFileSync(join(sessions, `${id}${suffix}`), v261.created.final.transcript);
      }
      // A `v4-<id>.jsonl` import with a matching meta: listable by every other measure.
      const imported = `v4-${id}`;
      writeFileSync(join(sessions, `${imported}.jsonl`), v261.created.final.transcript);
      writeFileSync(join(sessions, `${imported}.jsonl.meta`), v261.created.final.meta.replace(`"${id}"`, `"${imported}"`));
      const found = await discoverReasonixStore({ root: v2Root });
      check('2.61.0: discovery lists the captured session and none of its .jsonl sidecars or a v4- import',
        found.length === 1 && found[0]?.id === id && found[0]?.layout === 'global',
        JSON.stringify(found.map((session) => session.id)));
      let strictError: unknown;
      try {
        await discoverReasonixStore({ root: v2Root, maxSessions: 1, requireCompleteEnumeration: true });
      } catch (error) {
        strictError = error;
      }
      check('2.61.0: the sidecars do not spend the strict candidate budget of a one-session store',
        strictError === undefined,
        String(strictError));
      check('2.61.0: transcript names exclude every upstream sidecar suffix, v4- imports and dot files',
        isReasonixTranscriptName(`${id}.jsonl`)
          && REASONIX_JSONL_SIDECAR_SUFFIXES.every((suffix) => !isReasonixTranscriptName(`${id}${suffix}`))
          && !isReasonixTranscriptName(`v4-${id}.jsonl`)
          && !isReasonixTranscriptName(`.${id}.jsonl`)
          && !isReasonixTranscriptName(`${id}.jsonl.meta`));
      const session = found[0]!;
      const settled = await readReasonixTranscript(session);
      check('2.61.0: the captured transcript reads at its exact display boundaries, a cancelled and a failed turn included',
        settled.issues.length === 0
          && settled.records.length === 17
          && settled.displayEntries.length === 17
          && settled.records.filter((record) => record.local_only === true).length === 2,
        JSON.stringify({ issues: settled.issues, records: settled.records.length }));

      // The event journal ahead of the flat transcript, across the two mid-chain `replace` events
      // (reason `rewrite`) 2.61.0 wrote when it settled the cancelled and the failed turn: the
      // captured flat transcript and display index from before the cancel, with the captured final
      // journal, index and meta.
      writeFileSync(join(sessions, `${id}.jsonl`), v261.created.beforeCancel.transcript);
      writeFileSync(join(sessions, `${id}.display-index.json`), v261.created.beforeCancel.displayIndex);
      const lagging = await readReasonixTranscript(session);
      const finalRecords = v261.created.final.transcript.split('\n').filter(Boolean).map((line) => JSON.parse(line));
      check('2.61.0: a journal with mid-chain rewrite replaces reconstructs the settled tail over the older flat prefix',
        lagging.issues.length === 0
          && lagging.eventJournalReconciled === true
          && lagging.records.length === 17
          && JSON.stringify(lagging.records) === JSON.stringify(finalRecords)
          && lagging.displayEntries.length === 17
          && lagging.displayEntries.filter((entry) => entry.startsTurn === true).length === 6,
        JSON.stringify({ issues: lagging.issues, records: lagging.records.length, reconciled: lagging.eventJournalReconciled }));
      const events = v261.created.final.events.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
      const broken = events.map((event) => event.reason === 'rewrite' && event.revision === 8
        ? { ...event, base_revision: 6 }
        : event);
      writeFileSync(join(sessions, `${id}.events.jsonl`), `${broken.map((event) => JSON.stringify(event)).join('\n')}\n`);
      const brokenIndex = JSON.parse(v261.created.final.eventIndex) as Record<string, unknown>;
      writeFileSync(join(sessions, `${id}.event-index.json`), JSON.stringify({
        ...brokenIndex,
        log_size: Buffer.byteLength(`${broken.map((event) => JSON.stringify(event)).join('\n')}\n`),
      }));
      const discontinuous = await readReasonixTranscript(session);
      check('2.61.0: a mid-chain replace that does not name the revision it replaces is refused',
        discontinuous.eventJournalReconciled !== true
          && discontinuous.issues.includes('event journal replace chain is not contiguous'),
        JSON.stringify(discontinuous.issues));
    } finally {
      rmSync(v2Root, { recursive: true, force: true });
    }
  }
  // The continued 1.25.2 session keeps its id and files on 2.61.0 over ACP.
  {
    const migratedRoot = mkdtempSync(join(tmpdir(), 'reasonix-v261-migrated-'));
    try {
      const id = v261.migrated.sessionId;
      writeCapturedSession(join(migratedRoot, 'sessions'), id, v261.migrated.continued);
      const found = await discoverReasonixStore({ root: migratedRoot });
      const read = found[0] ? await readReasonixTranscript(found[0]) : undefined;
      check('2.61.0: a 1.25.2 session continued over ACP is listed under its original id with every row',
        found.length === 1 && found[0]?.id === id
          && read?.issues.length === 0
          && read.records.length === 7
          && read.records[5]?.host_authored === true,
        JSON.stringify({ ids: found.map((session) => session.id), issues: read?.issues }));
    } finally {
      rmSync(migratedRoot, { recursive: true, force: true });
    }
  }
  // Settlement: measured, each save that settled an interrupted turn rewrote only the then-last
  // human user row's `content` to its `raw_content` and moved the offsets after it. Only that shape
  // continues an accepted prefix; an earlier row or any other display field is still a rewrite.
  {
    const lines = (text: string): string[] => text.split('\n').filter((line) => line.trim());
    const display = (rows: readonly string[], authoredTurns?: readonly number[]): ReasonixDisplayEntry[] => {
      let offset = 0;
      return rows.map((line, index) => {
        const length = Buffer.byteLength(line) + 1;
        const role = (JSON.parse(line) as { role?: string }).role;
        const entry: ReasonixDisplayEntry = {
          index,
          offset,
          length,
          ...(role ? { role } : {}),
          authoredTurn: authoredTurns?.[index] ?? Math.floor(index / 2),
          ...(role === 'user' ? { startsTurn: true } : {}),
        };
        offset += length;
        return entry;
      });
    };
    const settledAt = v261.transcriptVersions.findIndex((version, index) => index > 0
      && lines(version.text).length > lines(v261.transcriptVersions[index - 1]!.text).length
      && Buffer.byteLength(version.text) < Buffer.byteLength(v261.transcriptVersions[index - 1]!.text));
    const beforeLines = lines(v261.transcriptVersions[settledAt - 1]!.text);
    const afterLines = lines(v261.transcriptVersions[settledAt]!.text);
    const after = {
      records: afterLines.map((line) => JSON.parse(line) as ReasonixTranscriptRecord),
      displayEntries: display(afterLines),
    };
    const accepted = (prefix: readonly string[], entries = display(prefix), next = after): boolean =>
      reasonixSettlementExtendsPrefix(Buffer.from(`${prefix.join('\n')}\n`), prefix.length, entries, next);
    check('2.61.0: the captured failure settlement continues the accepted prefix',
      settledAt > 0 && accepted(beforeLines),
      JSON.stringify({ settledAt, before: beforeLines.length, after: afterLines.length }));
    // The same settlement, but an EARLIER user row also loses its workspace wrapper.
    const userIndexes = beforeLines.flatMap((line, index) =>
      (JSON.parse(line) as { role?: string }).role === 'user' ? [index] : []);
    const earlier = userIndexes.at(-2)!;
    const earlierWrapped = beforeLines.map((line, index) => {
      if (index !== earlier) return line;
      const row = JSON.parse(line) as { raw_content: string };
      return JSON.stringify({ ...row, content: `<workspace>/srv/ws</workspace>\n\n${row.raw_content}` });
    });
    check('2.61.0: a settlement-shaped change to an earlier user row is still a rewrite',
      userIndexes.length >= 2 && !accepted(earlierWrapped),
      JSON.stringify({ userIndexes }));
    // The same settlement with one accepted display entry's turn changed.
    const turnChanged = {
      ...after,
      displayEntries: display(afterLines, afterLines.map((_line, index) => (index === 1 ? 9 : Math.floor(index / 2)))),
    };
    check('2.61.0: a settlement that changes another display field than offset and length is still a rewrite',
      !accepted(beforeLines, display(beforeLines), turnChanged));
  }
  // Session cost: 2.61.0 states the currency. Only a complete USD estimate is a reportable cost.
  {
    const priced = reasonixSessionUsage(v261.wire.pricedStatusCompletion?.params?.status?.usage?.cumulative);
    const unpriced = reasonixSessionUsage(v261.wire.v125StatusCompletion?.params?.status?.usage?.cumulative);
    const pricedValue = reasonixSessionUsageValue(priced);
    const otherCurrency = reasonixSessionUsageValue(priced ? { ...priced, currency: 'EUR' } : undefined);
    check('2.61.0: a complete USD cumulative reports its cost and source, and the same amount in another currency does not',
      priced?.currency === 'USD'
        && pricedValue?.cost === priced.estimatedCost
        && pricedValue?.source === 'executor'
        && otherCurrency !== undefined && !('cost' in otherCurrency),
      JSON.stringify({ priced, pricedValue, otherCurrency }));
    check('1.25.2: a cumulative with null cost and currency carries tokens and no cost',
      unpriced?.promptTokens !== undefined
        && unpriced.currency === undefined
        && !('cost' in (reasonixSessionUsageValue(unpriced) ?? {})),
      JSON.stringify(unpriced));
  }
} catch (error) {
  check('test harness completed', false, error instanceof Error ? error.message : String(error));
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
