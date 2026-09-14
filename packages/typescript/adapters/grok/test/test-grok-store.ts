#!/usr/bin/env bun
export {};
import { appendFileSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  discoverGrokStore,
  GROK_MAX_UPDATE_LINES,
  grokHistorySourceIdentity,
  grokPathContained,
  grokStoreRoot,
  readGrokSignals,
  readGrokUpdates,
} from '../src/store.ts';
import { buildGrokFixtureTree } from './fixtures/tree.ts';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const tree = buildGrokFixtureTree();
try {
  check('GROK_HOME overrides the default store root', grokStoreRoot({ GROK_HOME: tree.root }, '/unused') === tree.root);
  check('path containment accepts descendants and rejects siblings',
    grokPathContained(tree.root, tree.updatesPath) && !grokPathContained(tree.root, `${tree.root}-sibling/file`));

  const traces: string[] = [];
  const sessions = await discoverGrokStore({ root: tree.root, trace: (event) => traces.push(`${event.op}:${event.detail}`) });
  const session = sessions[0];
  check('discovery joins URL-decoded cwd, native id, summary, and model',
    sessions.length === 1
      && session?.id === tree.id
      && session.cwd === tree.cwd
      && session.title === 'Grok fixture'
      && session.currentModel?.providerID === 'xai'
      && session.currentModel.modelID === 'grok-4.6'
      && session.currentModel.reasoningEffort === 'high',
    JSON.stringify(session));
  check('the measured headless root session kind remains a root roster row',
    session?.origin === undefined && session?.parentThreadId === undefined);
  check('updatedAfter is applied from last_active_at before publishing idle rows',
    (await discoverGrokStore({ root: tree.root, updatedAfter: Date.parse('2026-08-24T00:00:00Z') })).length === 0);
  check('signals are bounded session aggregates',
    (await readGrokSignals(session!))?.contextTokensUsed === 15);

  const history = await readGrokUpdates(session!);
  check('updates.jsonl is the authoritative bounded replay source',
    history.entries.length === 9 && history.issues.length === 0 && history.byteLength === history.durablePrefixBytes.length,
    JSON.stringify({ entries: history.entries.length, issues: history.issues, bytes: history.byteLength }));
  const before = await grokHistorySourceIdentity(session!);
  appendFileSync(tree.updatesPath, '{"partial":true}');
  const partial = await readGrokUpdates(session!);
  const after = await grokHistorySourceIdentity(session!);
  check('an unterminated append is withheld while identity advances monotonically',
    partial.entries.length === 9
      && partial.durablePrefixBytes.length === history.durablePrefixBytes.length
      && (after?.appendPosition ?? 0) > (before?.appendPosition ?? 0)
      && before?.rewriteToken === undefined
      && after?.rewriteToken === undefined,
    JSON.stringify({ before, after }));
  tree.writeRows([...tree.rows]);

  const malformed = `${JSON.stringify(tree.rows[0])}\nnot-json\n`;
  writeFileSync(tree.updatesPath, malformed);
  const malformedRead = await readGrokUpdates(session!);
  check('malformed durable rows are retained as neutral mapper input with an issue',
    malformedRead.entries.length === 2
      && malformedRead.entries[1]?.record.__grokMalformed === true
      && malformedRead.issues.some((issue) => issue.includes('malformed JSON')),
    JSON.stringify(malformedRead.issues));
  tree.writeRows([...tree.rows]);

  writeFileSync(tree.updatesPath, '\n'.repeat(GROK_MAX_UPDATE_LINES + 1));
  const excessiveLines = await readGrokUpdates(session!);
  check('many tiny or blank lines refuse the whole snapshot before row allocation',
    excessiveLines.entries.length === 0
      && excessiveLines.durablePrefixBytes.length === 0
      && excessiveLines.issues.some((issue) => issue.includes(`${GROK_MAX_UPDATE_LINES} complete lines`)),
    JSON.stringify(excessiveLines.issues));
  tree.writeRows([...tree.rows]);

  const wrongGroup = join(tree.root, 'sessions', encodeURIComponent('/wrong/cwd'), '019f9d70-e38e-7591-9a24-74a06ad89477');
  mkdirSync(wrongGroup, { recursive: true });
  writeFileSync(join(wrongGroup, 'summary.json'), `${JSON.stringify({ info: { id: '019f9d70-e38e-7591-9a24-74a06ad89477', cwd: tree.cwd } })}\n`);
  const refused = await discoverGrokStore({ root: tree.root, trace: (event) => traces.push(`${event.op}:${event.detail}`) });
  check('a summary whose cwd disagrees with its URL directory fails closed',
    refused.length === 1 && traces.some((trace) => trace.startsWith('schema-refused:')), traces.join(' | '));

  const malformedId = '019f9d70-e38e-7591-1a24-74a06ad89479';
  const malformedIdDir = join(tree.root, 'sessions', encodeURIComponent(tree.cwd), malformedId);
  mkdirSync(malformedIdDir, { recursive: true });
  writeFileSync(join(malformedIdDir, 'summary.json'), `${JSON.stringify({ info: { id: malformedId, cwd: tree.cwd } })}\n`);
  check('a UUID-shaped directory with an invalid variant fails closed',
    (await discoverGrokStore({ root: tree.root })).length === 1);

  const version4Id = '019f9d70-e38e-4591-9a24-74a06ad89480';
  const version4Dir = join(tree.root, 'sessions', encodeURIComponent(tree.cwd), version4Id);
  mkdirSync(version4Dir, { recursive: true });
  writeFileSync(join(version4Dir, 'summary.json'), `${JSON.stringify({ info: { id: version4Id, cwd: tree.cwd } })}\n`);
  const uppercaseId = '019F9D70-E38E-7591-9A24-74A06AD89481';
  const uppercaseDir = join(tree.root, 'sessions', encodeURIComponent(tree.cwd), uppercaseId);
  mkdirSync(uppercaseDir, { recursive: true });
  writeFileSync(join(uppercaseDir, 'summary.json'), `${JSON.stringify({ info: { id: uppercaseId, cwd: tree.cwd } })}\n`);
  check('only canonical lowercase UUIDv7 session directories are discoverable',
    (await discoverGrokStore({ root: tree.root })).length === 1);

  const duplicateGroup = join(tree.root, 'sessions', encodeURIComponent('/duplicate/cwd'), tree.id);
  mkdirSync(duplicateGroup, { recursive: true });
  writeFileSync(join(duplicateGroup, 'summary.json'), `${JSON.stringify({ info: { id: tree.id, cwd: '/duplicate/cwd' } })}\n`);
  const duplicateTraces: string[] = [];
  check('a UUID duplicated across cwd groups is globally ambiguous and entirely refused',
    (await discoverGrokStore({
      root: tree.root,
      trace: (event) => duplicateTraces.push(event.detail),
    })).every((session) => session.id !== tree.id)
      && duplicateTraces.some((detail) => detail.includes('more than one cwd group')),
    duplicateTraces.join(' | '));
  rmSync(duplicateGroup, { recursive: true, force: true });

  const symlinkDir = join(tree.root, 'sessions', encodeURIComponent(tree.cwd), '019f9d70-e38e-7591-9a24-74a06ad89478');
  symlinkSync(tree.sessionDir, symlinkDir, 'dir');
  check('symlinked session directories are never traversed', (await discoverGrokStore({ root: tree.root })).length === 1);

  const moved = `${tree.updatesPath}.moved`;
  renameSync(tree.updatesPath, moved);
  symlinkSync(moved, tree.updatesPath);
  const symlinkRead = await readGrokUpdates(session!);
  check('a symlinked updates log is refused', symlinkRead.entries.length === 0 && symlinkRead.issues.some((issue) => issue.includes('containment')));
  renameSync(tree.updatesPath, `${tree.updatesPath}.link`);
  renameSync(moved, tree.updatesPath);

  const movedSession = `${tree.sessionDir}.moved`;
  const external = `${tree.root}-external`;
  mkdirSync(external, { recursive: true });
  renameSync(tree.sessionDir, movedSession);
  symlinkSync(external, tree.sessionDir, 'dir');
  const unsafeAbsentRead = await readGrokUpdates(session!);
  const unsafeAbsentIdentity = await grokHistorySourceIdentity(session!);
  check('an absent log through a replaced symlinked session directory is refused, not accepted as empty',
    unsafeAbsentRead.entries.length === 0
      && unsafeAbsentRead.issues.some((issue) => issue.includes('containment'))
      && unsafeAbsentIdentity === undefined);
  rmSync(tree.sessionDir, { force: true });
  renameSync(movedSession, tree.sessionDir);
  rmSync(external, { recursive: true, force: true });

  const boundedTraces: string[] = [];
  const bounded = await discoverGrokStore({ root: tree.root, maxScanEntries: 1, trace: (event) => boundedTraces.push(event.detail) });
  check('discovery work exhaustion refuses a partial roster', bounded.length === 0 && boundedTraces.some((detail) => detail.includes('refusing partial discovery')), boundedTraces.join(' | '));
} finally {
  tree.cleanup();
}

const lineageTree = buildGrokFixtureTree();
try {
  const childId = '019f9d70-e38e-7591-9a24-74a06ad89482';
  const secondParentId = '019f9d70-e38e-7591-9a24-74a06ad89483';
  const groupDir = join(lineageTree.root, 'sessions', encodeURIComponent(lineageTree.cwd));
  const childDir = join(groupDir, childId);
  const childSummaryPath = join(childDir, 'summary.json');
  const parentMetaDir = join(lineageTree.sessionDir, 'subagents', childId);
  const parentMetaPath = join(parentMetaDir, 'meta.json');
  const writeChildSummary = (sessionKind: unknown = 'subagent'): void => {
    mkdirSync(childDir, { recursive: true });
    writeFileSync(childSummaryPath, `${JSON.stringify({
      info: { id: childId, cwd: lineageTree.cwd },
      ...(sessionKind === undefined ? {} : { session_kind: sessionKind }),
      session_summary: 'Measured Grok child',
      created_at: '2026-08-31T04:35:44.077Z',
      updated_at: '2026-08-31T04:35:54.024Z',
      last_active_at: '2026-08-31T04:35:46.236Z',
      num_messages: 4,
      current_model_id: 'grok-4.6',
      reasoning_effort: 'xhigh',
      agent_name: 'general-purpose',
    })}\n`);
  };
  const writeParentMeta = (
    parentDir = lineageTree.sessionDir,
    parentId = lineageTree.id,
    overrides: Record<string, unknown> = {},
  ): string => {
    const dir = join(parentDir, 'subagents', childId);
    const path = join(dir, 'meta.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify({
      child_session_id: childId,
      subagent_id: childId,
      parent_session_id: parentId,
      child_cwd: lineageTree.cwd,
      ...overrides,
    })}\n`);
    return path;
  };
  writeChildSummary();
  writeParentMeta();

  const linked = await discoverGrokStore({ root: lineageTree.root });
  const linkedParent = linked.find((session) => session.id === lineageTree.id);
  const linkedChild = linked.find((session) => session.id === childId);
  check('measured parent meta and child summary publish one native child lineage',
    linked.length === 2
      && linkedChild?.origin === 'subagent'
      && linkedChild.parentThreadId === linkedParent?.id
      && linkedChild.cwd === lineageTree.cwd
      && linkedChild.currentAgent === 'general-purpose'
      && linkedChild.currentModel?.modelID === 'grok-4.6'
      && linkedChild.currentModel.reasoningEffort === 'xhigh',
    JSON.stringify(linked.map((session) => ({ id: session.id, origin: session.origin, parent: session.parentThreadId }))));

  rmSync(parentMetaPath, { force: true });
  check('a subagent summary with missing parent metadata is withheld, never promoted to a root row',
    (await discoverGrokStore({ root: lineageTree.root })).every((session) => session.id !== childId));

  writeParentMeta(lineageTree.sessionDir, lineageTree.id, { child_cwd: '/mismatched/child/cwd' });
  check('a child cwd mismatch fails lineage closed',
    (await discoverGrokStore({ root: lineageTree.root })).every((session) => session.id !== childId));
  writeParentMeta();

  const secondParentDir = join(groupDir, secondParentId);
  mkdirSync(secondParentDir, { recursive: true });
  writeFileSync(join(secondParentDir, 'summary.json'), `${JSON.stringify({
    info: { id: secondParentId, cwd: lineageTree.cwd },
    session_summary: 'Second parent',
  })}\n`);
  writeParentMeta(secondParentDir, secondParentId);
  const ambiguousTraces: string[] = [];
  const ambiguous = await discoverGrokStore({
    root: lineageTree.root,
    trace: (event) => ambiguousTraces.push(event.detail),
  });
  check('two exact parent claims make the child ambiguous and withhold it',
    ambiguous.every((session) => session.id !== childId)
      && ambiguousTraces.some((detail) => detail.includes('ambiguous')),
    ambiguousTraces.join(' | '));
  rmSync(secondParentDir, { recursive: true, force: true });

  const safeMeta = `${parentMetaPath}.safe`;
  renameSync(parentMetaPath, safeMeta);
  symlinkSync(safeMeta, parentMetaPath);
  check('a symlinked parent meta is never followed and cannot establish lineage',
    (await discoverGrokStore({ root: lineageTree.root })).every((session) => session.id !== childId));
  rmSync(parentMetaPath, { force: true });
  renameSync(safeMeta, parentMetaPath);

  writeChildSummary(null);
  check('parent metadata claiming a non-subagent summary is withheld as a mismatch',
    (await discoverGrokStore({ root: lineageTree.root })).every((session) => session.id !== childId));
  writeChildSummary();

  const lineageBounds: string[] = [];
  check('subagent enumeration shares the cumulative discovery budget and refuses partial lineage',
    (await discoverGrokStore({
      root: lineageTree.root,
      maxScanEntries: 3,
      trace: (event) => lineageBounds.push(event.detail),
    })).length === 0
      && lineageBounds.some((detail) => detail.includes('lineage enumeration')),
    lineageBounds.join(' | '));
} finally {
  lineageTree.cleanup();
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
