#!/usr/bin/env bun
export {};
import { readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { clineMessageKey, mapClineTranscript } from '../src/mapping.ts';
import {
  clineDataRoot,
  clinePathContained,
  clineStoreRoot,
  discoverClineStore,
  readClineMessages,
} from '../src/store.ts';
import { buildClineFixtureTree, fixtureChildMessages, fixtureParentMessages } from './fixtures/tree.ts';

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

  // Cline 3.0.75 (core 0.2.1), captured from its own CLI writes: the same document, stamped
  // `origin.version: 3.0.75`, and subagent files named `agent_<uuid>` instead of
  // `agent_<epoch ms>_<base36>`. Before it was listed, the parent was refused outright and the
  // child never matched the sibling pattern, so the session vanished from the roster.
  // The parent carries two messages exactly as 3.0.75 wrote them (fixture `messages`), so the
  // replay below also covers 3.0.75's message and block format, not only its labels.
  const captured = JSON.parse(readFileSync(new URL('./fixtures/cline-3.0.75-redacted.json', import.meta.url), 'utf8'));
  const capturedChild = captured.subagent.origin.subagent as string;
  const capturedAssistant = captured.messages.assistant;
  const capturedToolResult = captured.messages.toolResult;
  check('the redacted 3.0.75 fixture pins the captured CLI parent and agent_<uuid> child discriminators',
    captured.nativeVersion === '3.0.75'
      && captured.parent.agent === 'lead' && captured.parent.origin.version === '3.0.75'
      && captured.subagent.agent === 'subagent' && captured.subagent.taskType === 'subagent_task'
      && captured.subagent.file === `${capturedChild}.messages.json`
      && /^agent_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(capturedChild));
  const uuidChildId = `${tree.id}__${capturedChild}`;
  const uuidChildPath = join(tree.sessionDir, captured.subagent.file);
  const writeCapturedTree = (version: string): void => {
    tree.writeParent([capturedAssistant, capturedToolResult], undefined, {
      origin: { ...captured.parent.origin, sessionId: tree.id, version },
    });
    writeFileSync(uuidChildPath, `${JSON.stringify({
      version: captured.messagesDocumentVersion,
      agent: captured.subagent.agent,
      taskType: captured.subagent.taskType,
      sessionId: uuidChildId,
      updated_at: '2026-08-23T10:00:05.000Z',
      origin: { ...captured.subagent.origin, sessionId: uuidChildId, parentThreadId: tree.id, version },
      messages: fixtureChildMessages(),
    })}\n`);
  };
  writeCapturedTree('3.0.75');
  const observed075 = await discoverClineStore({ env: { CLINE_DIR: tree.root }, processAlive: () => false });
  const parent075 = observed075.find((session) => session.id === tree.id);
  const child075 = observed075.find((session) => session.id === uuidChildId);
  check('a 3.0.75 parent and its agent_<uuid> subagent are observed with their linkage',
    parent075 !== undefined
      && child075?.origin === 'subagent'
      && child075.parentThreadId === tree.id
      && child075.nativeId === uuidChildId
      && child075.messagesPath === uuidChildPath,
    observed075.map((session) => session.id).join(','));
  const replay075 = parent075 ? await readClineMessages(parent075) : undefined;
  check('the captured 3.0.75 parent messages replay in full, with their model',
    replay075?.issues.length === 0
      && isDeepStrictEqual(replay075.messageIds, ['msg_qugSRVT2', 'msg_2esI7L81'])
      && replay075.model === 'openai-compatible/qwen3:4b',
    JSON.stringify(replay075 && { issues: replay075.issues, ids: replay075.messageIds, model: replay075.model }));
  // The rows a client sees for the captured spawn_agent call and its result.
  const mapped075 = replay075 ? mapClineTranscript(tree.id, replay075.messages) : [];
  const capturedResultBody = '{"text":"SUB","iterations":1,"finishReason":"completed","usage":{"inputTokens":1802,"outputTokens":241}}';
  const expected075 = [
    {
      type: 'thinking',
      text: capturedAssistant.content[0].thinking,
      key: `${clineMessageKey(tree.id, 'msg_qugSRVT2')}:block:0:thinking`,
    },
    {
      type: 'tool-call',
      callId: 'call_yxzge3uw',
      toolName: 'spawn_agent',
      title: 'spawn_agent',
      toolClass: 'other',
      args: { systemPrompt: 'You are a helper.', task: 'Reply with the single word SUB.' },
    },
    {
      type: 'agent-activity',
      key: 'agent:call_yxzge3uw',
      kind: 'subagent',
      title: 'Reply with the single word SUB.',
      status: 'running',
      startedAtMs: 1795508115392,
      agentsDone: 0,
      agentsTotal: 1,
    },
    { type: 'token-count', input: 3669, output: 441, cacheRead: 0, cacheWrite: 0 },
    {
      type: 'tool-result',
      callId: 'call_yxzge3uw',
      toolName: 'spawn_agent',
      title: 'spawn_agent',
      toolClass: 'other',
      result: capturedResultBody,
      isError: false,
    },
    {
      type: 'agent-activity',
      key: 'agent:call_yxzge3uw',
      kind: 'subagent',
      title: 'Cline subagent',
      status: 'done',
      // The subagent's own usage, read from the result Cline persisted; not the lead's counts above.
      tokens: { input: 1802, output: 241 },
      agentsDone: 1,
      agentsTotal: 1,
    },
  ];
  check('the captured 3.0.75 assistant and tool messages map to thinking, call, subagent activity, tokens and result rows',
    isDeepStrictEqual(mapped075, expected075)
      && capturedToolResult.content[0].content === capturedResultBody,
    JSON.stringify(mapped075).slice(0, 800));
  // Still an enumeration: the next, uncaptured build is not read on the strength of ordering.
  writeCapturedTree('3.0.76');
  const unmeasured = await discoverClineStore({ env: { CLINE_DIR: tree.root }, processAlive: () => false });
  check('a snapshot stamped by an uncaptured newer build is still refused, parent and child',
    !unmeasured.some((session) => session.id === tree.id || session.id === uuidChildId),
    unmeasured.map((session) => session.id).join(','));
  rmSync(uuidChildPath);
  tree.writeParent(fixtureParentMessages());

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

  // The subagent document a managed Hub writes for an app-created session's spawn_agent,
  // captured on 3.0.75 (fixture `managedSubagent`): origin `source: 'cosyncing'` and, like the
  // managed parent, no `version`. It was refused, so the child was missing from the roster.
  {
    const managedChild = captured.managedSubagent;
    const managedChildSuffix = managedChild.origin.subagent as string;
    const managedChildId = `${tree.id}__${managedChildSuffix}`;
    const managedChildPath = join(tree.sessionDir, managedChild.file);
    check('the captured managed subagent origin has exactly the five measured keys and no version',
      managedChild.origin.source === 'cosyncing'
        && managedChild.origin.mode === 'subagent'
        && managedChild.file === `${managedChildSuffix}.messages.json`
        && isDeepStrictEqual(Object.keys(managedChild.origin).sort(),
          ['mode', 'parentThreadId', 'sessionId', 'source', 'subagent']),
      JSON.stringify(managedChild.origin));
    const writeManagedChild = (origin: Record<string, unknown>): void => {
      writeFileSync(managedChildPath, `${JSON.stringify({
        version: captured.messagesDocumentVersion,
        agent: managedChild.agent,
        taskType: managedChild.taskType,
        sessionId: managedChildId,
        updated_at: '2026-08-23T10:00:05.000Z',
        origin,
        messages: fixtureChildMessages(),
      })}\n`);
    };
    const capturedOrigin = { ...managedChild.origin, sessionId: managedChildId, parentThreadId: tree.id };
    tree.writeParent(fixtureParentMessages(), undefined, { origin: {
      source: 'cosyncing', mode: 'user', sessionId: tree.id,
    } });
    writeManagedChild(capturedOrigin);
    const managedRoster = await discoverClineStore({
      env: { CLINE_DIR: tree.root }, managedCosyncingRoot: tree.dataRoot, processAlive: () => false,
    });
    const managedChildRow = managedRoster.find((session) => session.id === managedChildId);
    check('a managed Hub subagent beneath the exact managed root is listed under its parent',
      managedRoster.some((session) => session.id === tree.id)
        && managedChildRow?.origin === 'subagent'
        && managedChildRow.parentThreadId === tree.id
        && managedChildRow.messagesPath === managedChildPath,
      managedRoster.map((session) => session.id).join(','));
    check('and its messages replay',
      managedChildRow !== undefined && (await readClineMessages(managedChildRow)).issues.length === 0);
    // The same document outside the managed root is an ordinary profile claiming the Hub's
    // discriminator, exactly as for the parent above.
    tree.writeParent(fixtureParentMessages());
    const ordinaryRoster = await discoverClineStore({ env: { CLINE_DIR: tree.root }, processAlive: () => false });
    check('an ordinary-profile subagent cannot claim the managed Hub discriminator',
      !ordinaryRoster.some((session) => session.id === managedChildId));
    tree.writeParent(fixtureParentMessages(), undefined, { origin: {
      source: 'cosyncing', mode: 'user', sessionId: tree.id,
    } });
    for (const [label, origin] of [
      ['a version', { ...capturedOrigin, version: '3.0.75' }],
      ['an extra key', { ...capturedOrigin, extra: true }],
      ['another parent', { ...capturedOrigin, parentThreadId: 'another_parent' }],
      ['another subagent', { ...capturedOrigin, subagent: 'agent_other' }],
    ] as const) {
      writeManagedChild(origin);
      const refused = await discoverClineStore({
        env: { CLINE_DIR: tree.root }, managedCosyncingRoot: tree.dataRoot, processAlive: () => false,
      });
      check(`a managed subagent origin with ${label} is refused`,
        !refused.some((session) => session.id === managedChildId),
        refused.map((session) => session.id).join(','));
    }
    rmSync(managedChildPath);
  }
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
