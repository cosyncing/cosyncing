#!/usr/bin/env bun
export {};
import { readFileSync, renameSync, symlinkSync } from 'node:fs';
import {
  clineDataRoot,
  clinePathContained,
  clineStoreRoot,
  discoverClineStore,
  readClineMessages,
} from '../src/store.ts';
import { buildClineFixtureTree, fixtureParentMessages } from './fixtures/tree.ts';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const tree = buildClineFixtureTree();
try {
  const recorded = JSON.parse(readFileSync(new URL('./fixtures/cline-3.0.56-redacted.json', import.meta.url), 'utf8'));
  check('the redacted fixture pins the measured 3.0.56 parent and child discriminators',
    recorded.nativeVersion === '3.0.56'
      && recorded.parent.agent === 'lead'
      && recorded.parent.origin.mode === 'user'
      && recorded.subagent.agent === 'subagent'
      && recorded.subagent.origin.mode === 'subagent');
  check('CLINE_DIR and CLINE_DATA_DIR select the measured roots',
    clineStoreRoot({ CLINE_DIR: tree.root }, '/unused') === tree.root
      && clineDataRoot({ CLINE_DIR: '/wrong', CLINE_DATA_DIR: tree.dataRoot }, '/unused') === tree.dataRoot);
  check('path containment accepts descendants and rejects siblings',
    clinePathContained(tree.dataRoot, tree.messagesPath)
      && !clinePathContained(tree.dataRoot, `${tree.dataRoot}-sibling/file`));

  const sessions = await discoverClineStore({ env: { CLINE_DIR: tree.root }, processAlive: () => true });
  const parent = sessions.find((session) => session.id === tree.id);
  const child = sessions.find((session) => session.id === tree.childId);
  check('discovery joins metadata with the rewritten parent snapshot',
    parent?.title === 'Cline fixture'
      && parent.cwd === tree.cwd
      && parent.status === 'running'
      && parent.currentModel?.providerID === 'anthropic'
      && parent.currentModel.modelID === 'claude-sonnet-4-20250514'
      && parent.model === 'anthropic/claude-sonnet-4-20250514',
    JSON.stringify(parent));
  check('subagent siblings publish a child native id and parent linkage',
    child?.nativeId === tree.childId
      && child.origin === 'subagent'
      && child.parentThreadId === tree.id
      && child.model === 'openai-compatible/qwen3.8-27B-FP8'
      && child.currentModel?.providerID === 'openai-compatible'
      && child.messagesPath === tree.childPath,
    JSON.stringify(child));

  const childSuffix = tree.childId.split('__')[1]!;
  tree.writeParent(fixtureParentMessages(), undefined, { origin: {
    source: 'cli', mode: 'user', sessionId: tree.id, version: '3.0.56',
  } });
  tree.writeChild([], { origin: {
    source: 'cli', mode: 'subagent', sessionId: tree.childId,
    parentThreadId: tree.id, subagent: childSuffix, version: '3.0.56',
  } });
  const legacyObserved = await discoverClineStore({ env: { CLINE_DIR: tree.root }, processAlive: () => false });
  check('the earlier measured 3.0.56 parent and child remain available for Observe',
    legacyObserved.some((session) => session.id === tree.id)
      && legacyObserved.some((session) => session.id === tree.childId));
  tree.writeParent(fixtureParentMessages());
  tree.writeChild([]);

  const dead = await discoverClineStore({ env: { CLINE_DIR: tree.root }, processAlive: () => false });
  check('dead-pid running metadata is interrupted and never live',
    dead.find((session) => session.id === tree.id)?.status === 'idle'
      && dead.find((session) => session.id === tree.id)?.interrupted === true);

  tree.writeParent(fixtureParentMessages(), undefined, { origin: {
    source: 'cosyncing', mode: 'user', sessionId: tree.id,
  } });
  const ordinaryManagedOrigin = await discoverClineStore({ env: { CLINE_DIR: tree.root }, processAlive: () => false });
  check('an ordinary-profile snapshot cannot claim the broker-managed Hub discriminator',
    !ordinaryManagedOrigin.some((session) => session.id === tree.id));
  const managedOrigin = await discoverClineStore({
    env: { CLINE_DIR: tree.root },
    managedCosyncingRoot: tree.dataRoot,
    processAlive: () => false,
  });
  check('the measured broker-managed Hub parent discriminator survives exact-root durable rediscovery',
    managedOrigin.some((session) => session.id === tree.id));
  tree.writeParent(fixtureParentMessages(), undefined, { origin: {
    source: 'cosyncing', mode: 'user', sessionId: tree.id, version: '3.0.60',
  } });
  const unmeasuredManagedOrigin = await discoverClineStore({
    env: { CLINE_DIR: tree.root }, managedCosyncingRoot: tree.dataRoot,
  });
  check('an unmeasured broker-managed Hub parent discriminator still fails closed',
    !unmeasuredManagedOrigin.some((session) => session.id === tree.id));
  tree.writeParent(fixtureParentMessages());

  const snapshot = await readClineMessages(parent!);
  check('the complete JSON document is replayed with bounded stable identity',
    snapshot.messages.length === 4
      && snapshot.messageIds[0] === 'msg-user-1'
      && snapshot.identity?.sourceId === tree.messagesPath
      && snapshot.issues.length === 0,
    JSON.stringify(snapshot.issues));

  const childCutoff = await discoverClineStore({
    env: { CLINE_DIR: tree.root },
    updatedAfter: Date.parse('2026-08-23T10:00:04.000Z'),
    processAlive: () => false,
  });
  check('a matching child retains its parent roster row across updatedAfter filtering',
    childCutoff.map((session) => session.id).join(',') === `${tree.id},${tree.childId}`,
    childCutoff.map((session) => session.id).join(','));

  const futureCutoff = Date.parse('2026-08-24T00:00:00.000Z');
  const active = await discoverClineStore({
    env: { CLINE_DIR: tree.root },
    updatedAfter: futureCutoff,
    processAlive: () => true,
  });
  check('updatedAfter never filters a currently active session', active.some((session) => session.id === tree.id));

  tree.writeMetadata({ status: 'completed', ended_at: '2026-08-23T10:00:10.000Z' });
  const completed = await discoverClineStore({
    env: { CLINE_DIR: tree.root },
    updatedAfter: Date.parse('2026-08-23T10:00:09.000Z'),
    processAlive: () => false,
  });
  check('metadata-only completion uses ended_at when it is newer than message updated_at',
    completed.find((session) => session.id === tree.id)?.updatedAt === Date.parse('2026-08-23T10:00:10.000Z'));
  tree.writeMetadata();

  tree.writeMetadata({
    metadata: {
      title: 'Cline fixture',
      aggregateUsage: {},
      usage: { inputTokens: 7, outputTokens: 2 },
      totalCost: 0.25,
    },
  });
  const usageFallback = (await discoverClineStore({ env: { CLINE_DIR: tree.root } }))[0]?.usage;
  check('empty aggregate usage falls back to valid usage and merges separate totalCost',
    usageFallback?.inputTokens === 7
      && usageFallback.outputTokens === 2
      && usageFallback.totalCost === 0.25,
    JSON.stringify(usageFallback));
  tree.writeMetadata();

  const decodeTraces: string[] = [];
  const decodeBounded = await discoverClineStore({
    env: { CLINE_DIR: tree.root },
    maxDecodeBytes: 128,
    trace: (event) => decodeTraces.push(`${event.op}:${event.detail}`),
  });
  check('cumulative discovery decode bytes refuse partial rosters',
    decodeBounded.length === 0 && decodeTraces.some((trace) => trace.includes('cumulative decode-byte budget')),
    decodeTraces.join(' | '));

  const abort = new AbortController();
  abort.abort(new Error('fixture abort'));
  let aborted = false;
  try { await discoverClineStore({ env: { CLINE_DIR: tree.root }, signal: abort.signal }); } catch { aborted = true; }
  check('discovery honors the caller abort signal before filesystem work', aborted);

  tree.writeParent([...fixtureParentMessages(), fixtureParentMessages()[0]!]);
  const duplicate = await readClineMessages(parent!);
  check('duplicate message ids refuse the whole snapshot',
    duplicate.messages.length === 0 && duplicate.issues.some((issue) => issue.includes('duplicate')),
    JSON.stringify(duplicate.issues));
  tree.writeParent(fixtureParentMessages());

  const traces: string[] = [];
  tree.writeChild([], { origin: { sessionId: 'wrong', parentThreadId: tree.id, subagent: 'wrong' } });
  const mismatched = await discoverClineStore({
    env: { CLINE_DIR: tree.root },
    trace: (event) => traces.push(`${event.op}:${event.detail}`),
  });
  check('a child identity or parent-link mismatch fails closed with a useful trace',
    mismatched.length === 1 && traces.some((trace) => trace.includes('native discriminator/origin mismatch')),
    traces.join(' | '));

  tree.writeParent(fixtureParentMessages());

  const parentTraces: string[] = [];
  tree.writeParent(fixtureParentMessages(), undefined, { agent: 'cline' });
  const invalidParent = await discoverClineStore({
    env: { CLINE_DIR: tree.root },
    trace: (event) => parentTraces.push(`${event.op}:${event.detail}`),
  });
  check('a non-native parent discriminator fails closed',
    invalidParent.length === 0 && parentTraces.some((trace) => trace.includes('native discriminator/origin mismatch')),
    parentTraces.join(' | '));
  tree.writeParent(fixtureParentMessages());

  const moved = `${tree.messagesPath}.moved`;
  renameSync(tree.messagesPath, moved);
  symlinkSync(moved, tree.messagesPath);
  const unsafe = await readClineMessages(parent!);
  check('symlinked message snapshots are refused',
    unsafe.messages.length === 0 && unsafe.issues.some((issue) => issue.includes('unsafe')),
    JSON.stringify(unsafe.issues));
} finally {
  tree.cleanup();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
