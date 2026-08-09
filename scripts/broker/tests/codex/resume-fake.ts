/**
 * Zero-cost Codex resume adapter tests backed by a fake `codex app-server --stdio` binary.
 *
 *   bun run scripts/broker/tests/codex/resume-fake.ts
 */
export {};
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isOwnershipConflictError } from '../../../../packages/typescript/adapter-api/src/index.ts';
import { CodexAdapter } from '../../../../packages/typescript/adapters/codex/src/index.ts';
import { AttentionService } from '../../../../packages/typescript/broker/src/attention-service.ts';
import { ManagedConn } from '../../../../packages/typescript/broker/src/hub.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = () => Math.random().toString(36).slice(2, 8);

const testFilterExpr = process.env.COSYNCING_TEST_FILTER?.trim();
let testNameFilter: (name: string) => boolean = () => true;
if (testFilterExpr) {
  const parsedRegex = testFilterExpr.match(/^\/(.+)\/([gimsuy]*)$/);
  if (parsedRegex) {
    try {
      const pattern = parsedRegex[1] ?? '';
      const flags = parsedRegex[2] ?? '';
      const re = new RegExp(pattern, flags);
      testNameFilter = (name) => {
        re.lastIndex = 0;
        return re.test(name);
      };
    } catch {
      testNameFilter = (name) => name.includes(testFilterExpr);
    }
  } else {
    testNameFilter = (name) => name.includes(testFilterExpr);
  }
}

type ResultKind = 'pass' | 'fail' | 'skip';
const results: { name: string; kind: ResultKind; detail: string }[] = [];

async function test(name: string, fn: () => Promise<[boolean, string]>): Promise<void> {
  if (!testNameFilter(name)) {
    results.push({ name, kind: 'skip', detail: `SKIP (COSYNCING_TEST_FILTER=${testFilterExpr})` });
    console.log(`SKIP  ${name}`);
    return;
  }
  try {
    const [ok, detail] = await fn();
    results.push({ name, kind: ok ? 'pass' : 'fail', detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  } catch (err) {
    const detail = err instanceof Error ? err.stack ?? String(err) : String(err);
    results.push({ name, kind: 'fail', detail });
    console.log(`FAIL  ${name}  — threw: ${detail}`);
  }
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(50);
  }
  return false;
}

function fakeCodexDir(scriptBody: string): { dir: string; rollout: string; fake: string; marker: string } {
  const dir = join('/tmp', `cosyncing-codex-fake-${rand()}`);
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const rollout = join(dir, 'rollout-2026-06-16T00-00-00-00000000-0000-4000-8000-000000000000.jsonl');
  writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id: 'fake-thread', cwd: dir } }) + String.fromCharCode(10));
  const marker = join(dir, 'markers.jsonl');
  const fake = join(binDir, 'codex');
  writeFileSync(fake, scriptBody.replace(/__DIR__/g, dir).replace(/__ROLLOUT__/g, rollout).replace(/__MARKER__/g, marker));
  chmodSync(fake, 0o755);
  return { dir, rollout, fake, marker };
}

function readMarkers(marker: string): any[] {
  try {
    return readFileSync(marker, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((entry): entry is Record<string, any> => entry !== null && typeof entry === 'object');
  } catch {
    return [];
  }
}

async function withFakeCodex<T>(scriptBody: string, fn: (rollout: string, dir: string, marker: string) => Promise<T>): Promise<T> {
  const { dir, rollout, fake, marker } = fakeCodexDir(scriptBody);
  const oldBin = process.env.COSYNCING_CODEX_BIN;
  process.env.COSYNCING_CODEX_BIN = fake;
  try {
    return await fn(rollout, dir, marker);
  } finally {
    if (oldBin == null) delete process.env.COSYNCING_CODEX_BIN;
    else process.env.COSYNCING_CODEX_BIN = oldBin;
    rmSync(dir, { recursive: true, force: true });
  }
}

await test('pre-session Codex catalog is native, exact, and bounded', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
const send = (o) => console.log(JSON.stringify(o));
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'config/read') {
      send({ id: msg.id, result: { config: { model_provider: 'azure-openai' } } });
    } else if (msg.method === 'model/list') {
      send({ id: msg.id, result: {
        data: Array.from({ length: 300 }, (_, index) => ({
          id: 'model-' + index,
          displayName: 'Model ' + index,
          supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }],
          defaultReasoningEffort: 'high'
        })),
        nextCursor: null
      } });
    }
  }
}
`, async () => {
    const models = await new CodexAdapter().listModels();
    return [
      models.length === 256 &&
        models[0]?.providerID === 'azure-openai' &&
        models[0]?.modelID === 'model-0' &&
        models[0]?.reasoningEfforts?.[0]?.effort === 'high' &&
        models[255]?.modelID === 'model-255',
      `count=${models.length} first=${JSON.stringify(models[0])} last=${models.at(-1)?.modelID}`,
    ];
  });
});

await test('createSession starts a durable no-prompt Codex thread', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
let startCount = 0;
const append = (value) =>
  require('node:fs').appendFileSync('__MARKER__', JSON.stringify(value) + '\\n');
const send = (o) => console.log(JSON.stringify(o));
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } }); // cold-load pre-check (issues-part3 mode restore)
    else if (msg.method === 'thread/settings/update') {
      const unknown = Object.keys(msg.params || {}).filter(
        (key) => !['threadId', 'model', 'effort'].includes(key),
      );
      if (unknown.length) {
        send({ id: msg.id, error: { message: 'unknown settings field: ' + unknown.join(',') } });
      } else {
        append({ kind: 'thread/settings/update', params: msg.params });
        send({ id: msg.id, result: {} });
      }
    } else if (msg.method === 'thread/name/set') {
      send({ id: msg.id, result: {} });
    }
    else if (msg.method === 'thread/start') {
      const unknown = Object.keys(msg.params || {}).filter(
        (key) => !['cwd', 'serviceName', 'model', 'modelProvider'].includes(key),
      );
      if (unknown.length) {
        send({ id: msg.id, error: { message: 'unknown thread/start field: ' + unknown.join(',') } });
        continue;
      }
      startCount++;
      append({ kind: 'thread/start', params: msg.params });
      send({ id: msg.id, result: {
        thread: {
          id: 'created-thread',
          sessionId: 'created-thread',
          path: '__ROLLOUT__',
          cwd: msg.params.cwd,
          name: 'Native created thread',
          createdAt: 1800000000,
          updatedAt: 1800000001,
          turns: []
        },
        cwd: msg.params.cwd,
        model: msg.params.model,
        modelProvider: msg.params.modelProvider,
        reasoningEffort: 'medium'
      } });
    } else if (msg.method === 'turn/start') {
      send({ id: msg.id, error: { message: 'createSession should not start a turn' } });
    }
  }
}
`, async (rollout, dir, marker) => {
    const adapter = new CodexAdapter();
    const info = await adapter.createSession({
      directory: dir,
      title: 'Created from app',
      model: {
        providerID: 'azure-openai',
        modelID: 'gpt-selected',
        reasoningEffort: 'high',
      },
    });
    const records = readMarkers(marker);
    const threadStart = records.find((record) => record.kind === 'thread/start');
    const settings = records.find(
      (record) => record.kind === 'thread/settings/update',
    );
    return [
      info.tool === 'codex' &&
        info.title === 'Created from app' &&
        info.cwd === dir &&
        info.attachMode === 'observe' &&
        info.control?.drive.state === 'observing' &&
        info.control?.drive.supported === true &&
        info.currentModel?.providerID === 'azure-openai' &&
        info.currentModel?.modelID === 'gpt-selected' &&
        info.currentModel?.reasoningEffort === 'high' &&
        threadStart?.params?.model === 'gpt-selected' &&
        threadStart?.params?.modelProvider === 'azure-openai' &&
        !Object.prototype.hasOwnProperty.call(
          threadStart?.params ?? {},
          'reasoningEffort',
        ) &&
        settings?.params?.threadId === 'created-thread' &&
        settings?.params?.model === 'gpt-selected' &&
        settings?.params?.effort === 'high' &&
        Buffer.from(info.id, 'base64url').toString('utf8') === rollout,
      `tool=${info.tool} title=${info.title} cwd=${info.cwd} attach=${info.attachMode} control=${info.control?.drive.state} model=${JSON.stringify(info.currentModel)} native=${JSON.stringify(records)}`,
    ];
  });
});

await test('app-server native timestamps map to user sentAt and run-summary', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
const send = (o) => console.log(JSON.stringify(o));
const inputText = (input) => (input || []).map((p) => p.text || '').join(' ').trim();
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } }); // cold-load pre-check (issues-part3 mode restore)
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') send({ id: msg.id, result: { thread: { name: 'fake' }, model: 'fake-model', modelProvider: 'fake-provider' } });
    else if (msg.method === 'turn/start') {
      const text = inputText(msg.params.input);
      send({ id: msg.id, result: { turn: { id: 'turn1' } } });
      send({ method: 'turn/started', params: { threadId: 'fake-thread', turn: { id: 'turn1', createdAt: '2026-06-18T10:10:00.000Z' } } });
      send({ method: 'item/started', params: { turnId: 'turn1', item: { type: 'userMessage', id: 'u1', clientId: msg.params.clientUserMessageId, content: [{ type: 'text', text }], createdAt: '2026-06-18T10:09:59.000Z' } } });
      send({ method: 'item/completed', params: { turnId: 'turn1', item: { type: 'agentMessage', id: 'answer1', text: 'timestamp ok' } } });
      send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: 'turn1', status: 'completed', createdAt: '2026-06-18T10:10:00.000Z', completedAt: '2026-06-18T10:10:04.000Z' } } });
    }
  }
}
`, async (rollout, _dir, marker) => {
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      await conn.sendPrompt({ text: 'timed prompt' });
      await waitFor(() => messages.some((m) => m.type === 'status' && m.status === 'idle'), 5000);
      const user = messages.find((m) => m.type === 'user-message');
      const done = messages.find((m) => m.type === 'run-summary' && m.status === 'done');
      const totals = messages.find((m) => m.type === 'metadata-update' && m.key === 'runtimeTotals');
      return [
        user?.sentAt === Date.parse('2026-06-18T10:09:59.000Z') &&
          user?.turnId === 'turn1' &&
          done?.key === 'codex:run:turn1' &&
          done?.startedAt === Date.parse('2026-06-18T10:10:00.000Z') &&
          done?.completedAt === Date.parse('2026-06-18T10:10:04.000Z') &&
          done?.totalRuntimeMs === 4000 &&
          !('tokens' in done) &&
          totals?.value?.totalRuntimeMs === 4000 &&
          totals?.value?.turnCount === 1 &&
          totals?.value?.updatedAt === Date.parse('2026-06-18T10:10:04.000Z') &&
          totals?.value?.source === 'codex-app-server-live-only',
        `user=${JSON.stringify(user)} done=${JSON.stringify(done)} totals=${JSON.stringify(totals)}`,
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('CR4b: the live prompt uses the canonical (turn, ordinal) identity and the terminal summary names it', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
const send = (o) => console.log(JSON.stringify(o));
const inputText = (input) => (input || []).map((p) => p.text || '').join(' ').trim();
let turnSeq = 0;
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } });
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') send({ id: msg.id, result: { thread: { name: 'fake' }, model: 'fake-model', modelProvider: 'fake-provider' } });
    else if (msg.method === 'turn/start') {
      const text = inputText(msg.params.input);
      const turnId = 'turn' + (++turnSeq);
      send({ id: msg.id, result: { turn: { id: turnId } } });
      send({ method: 'turn/started', params: { threadId: 'fake-thread', turn: { id: turnId, createdAt: '2026-06-18T10:10:00.000Z' } } });
      send({ method: 'item/started', params: { turnId, item: { type: 'userMessage', id: 'native-' + turnId, clientId: msg.params.clientUserMessageId, content: [{ type: 'text', text }], createdAt: '2026-06-18T10:09:59.000Z' } } });
      // A repeated item/started for the SAME item must not mint a second identity.
      send({ method: 'item/started', params: { turnId, item: { type: 'userMessage', id: 'native-' + turnId, clientId: msg.params.clientUserMessageId, content: [{ type: 'text', text }], createdAt: '2026-06-18T10:09:59.000Z' } } });
      send({ method: 'item/completed', params: { turnId, item: { type: 'agentMessage', id: 'answer-' + turnId, text: 'answer for ' + turnId } } });
      send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: turnId, status: 'completed', createdAt: '2026-06-18T10:10:00.000Z', completedAt: '2026-06-18T10:10:04.000Z' } } });
    }
  }
}
`, async (rollout) => {
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      await conn.sendPrompt({ text: 'identical prompt' });
      await waitFor(() => messages.some((m) => m.type === 'run-summary' && m.status === 'done'), 5000);
      const firstPrompts = messages.filter((m) => m.type === 'user-message');
      const firstDone = messages.find((m) => m.type === 'run-summary' && m.status === 'done');

      // The SAME text again, in a new turn, must stay a separate message.
      messages.length = 0;
      await conn.sendPrompt({ text: 'identical prompt' });
      await waitFor(() => messages.some((m) => m.type === 'run-summary' && m.status === 'done'), 5000);
      const secondPrompts = messages.filter((m) => m.type === 'user-message');
      const secondDone = messages.find((m) => m.type === 'run-summary' && m.status === 'done');

      // A repeated `item/started` re-emits the row, but under ONE identity — which is what the
      // client's key-based reduction needs. Two identities would be two rows.
      const firstKeys = [...new Set(firstPrompts.map((p) => p.key))];
      const secondKeys = [...new Set(secondPrompts.map((p) => p.key))];
      return [
        firstKeys.length === 1 &&
          firstKeys[0] === 'codex:turn1:u0' &&
          firstPrompts[0].turnId === 'turn1' &&
          // The terminal boundary carries the footer metadata AND names the rendered rows, so the
          // open turn grows its footer without a refresh or a durable-history replay.
          firstDone?.userMessageKey === 'codex:turn1:u0' &&
          firstDone?.assistantMessageKey === 'codex:turn1:answer-turn1:t' &&
          firstDone?.totalRuntimeMs === 4000 &&
          firstDone?.completedAt === Date.parse('2026-06-18T10:10:04.000Z') &&
          secondKeys.length === 1 &&
          secondKeys[0] === 'codex:turn2:u0' &&
          secondDone?.userMessageKey === 'codex:turn2:u0',
        `first=${JSON.stringify(firstPrompts.map((p) => p.key))} firstDone=${JSON.stringify(firstDone)} second=${JSON.stringify(secondPrompts.map((p) => p.key))} secondDone=${JSON.stringify(secondDone)}`,
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('CR4b: one turn with more steers than the recent-item bound stays bounded and merges nothing', async () => {
  // The per-turn record used to retain EVERY item id and key, so one long steered turn grew for the
  // connection's lifetime. Ownership needs only the opening key and the ordinal needs only a
  // counter, so the re-delivery lookup is now a bounded window. What must NOT change is identity:
  // an item outside the window is issued a new ordinal, never merged into another message.
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
const send = (o) => console.log(JSON.stringify(o));
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } });
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') send({ id: msg.id, result: { thread: { name: 'fake' }, model: 'fake-model', modelProvider: 'fake-provider' } });
    else if (msg.method === 'turn/start') {
      const turnId = 'long-turn';
      send({ id: msg.id, result: { turn: { id: turnId } } });
      send({ method: 'turn/started', params: { threadId: 'fake-thread', turn: { id: turnId, createdAt: '2026-06-18T10:10:00.000Z' } } });
      const item = (n) => ({ type: 'userMessage', id: 'steer-' + n, content: [{ type: 'text', text: 'steer ' + n }], createdAt: '2026-06-18T10:09:59.000Z' });
      for (let n = 0; n < 100; n++) send({ method: 'item/started', params: { turnId, item: item(n) } });
      // Inside the recent window: re-delivery must keep its first identity.
      send({ method: 'item/started', params: { turnId, item: item(99) } });
      // Far outside it: a new ordinal is correct; merging it into another row is not.
      send({ method: 'item/started', params: { turnId, item: item(0) } });
      send({ method: 'item/completed', params: { turnId, item: { type: 'agentMessage', id: 'answer', text: 'done' } } });
      send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: turnId, status: 'completed', createdAt: '2026-06-18T10:10:00.000Z', completedAt: '2026-06-18T10:10:04.000Z' } } });
    }
  }
}
`, async (rollout) => {
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      await conn.sendPrompt({ text: 'open the long turn' });
      await waitFor(() => messages.some((m) => m.type === 'run-summary' && m.status === 'done'), 10000);
      const prompts = messages.filter((m) => m.type === 'user-message');
      const keys = prompts.map((p) => p.key);
      const distinct = new Set(keys);
      const done = messages.find((m) => m.type === 'run-summary' && m.status === 'done');
      // 100 steers + one in-window re-delivery (no new key) + one out-of-window one (new key).
      const inWindowKept = keys.filter((k) => k === 'codex:long-turn:u99').length === 2;
      const outOfWindowIssuedNew = distinct.has('codex:long-turn:u100');
      return [
        distinct.size === 101 &&
          keys.length === 102 &&
          inWindowKept &&
          outOfWindowIssuedNew &&
          // Ownership still points at the prompt that OPENED the turn, not the newest steer.
          done?.userMessageKey === 'codex:long-turn:u0',
        `distinct=${distinct.size} emitted=${keys.length} inWindowKept=${inWindowKept} u100=${outOfWindowIssuedNew} owner=${done?.userMessageKey}`,
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('status-less resume is treated as idle and can start a turn', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
const send = (o) => console.log(JSON.stringify(o));
const { appendFileSync } = require('node:fs');
const mark = (entry) => appendFileSync('__MARKER__', JSON.stringify(entry) + String.fromCharCode(10));
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } }); // cold-load pre-check
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') {
      send({ id: msg.id, result: { thread: { name: 'fake' }, model: 'fake-model', modelProvider: 'fake-provider' } });
    } else if (msg.method === 'turn/start') {
      mark({ kind: 'turn/start-request' });
      send({ id: msg.id, result: { turn: { id: 'turn-idle-resumed' } } });
      send({ method: 'turn/started', params: { threadId: 'fake-thread', turn: { id: 'turn-idle-resumed' } } });
      send({ method: 'item/agentMessage/delta', params: { threadId: 'fake-thread', turnId: 'turn-idle-resumed', itemId: 'answer', delta: 'status-less idle output' } });
      send({ method: 'item/completed', params: { turnId: 'turn-idle-resumed', item: { type: 'agentMessage', id: 'answer', text: 'status-less idle output' } } });
      send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: 'turn-idle-resumed', status: 'completed' } } });
    }
  }
}
`, async (rollout, _dir, marker) => {
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      await conn.sendPrompt({ text: 'start after status-less resume' });
      await waitFor(() => messages.some((m) => m.type === 'status' && m.status === 'idle'), 5000);
      const markerEvents = readMarkers(marker);
      const startCalls = markerEvents.filter((m) => m.kind === 'turn/start-request');
      const out = messages.find((m) => m.type === 'model-output');
      return [
        startCalls.length === 1 && !!out && String(out.text ?? out.delta ?? '').includes('status-less idle output'),
        `start=${startCalls.length} output=${String(out?.text ?? out?.delta ?? '')}`,
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('prompt submitted while turn is starting is steered into that turn', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
let startCount = 0;
let steerCount = 0;
const send = (o) => console.log(JSON.stringify(o));
const inputText = (input) => (input || []).map((p) => p.text || '').join(' ').trim();
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } }); // cold-load pre-check (issues-part3 mode restore)
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') send({ id: msg.id, result: { thread: { name: 'fake' }, model: 'fake-model', modelProvider: 'fake-provider' } });
    else if (msg.method === 'turn/start') {
      startCount++;
      if (startCount > 1) {
        send({ id: msg.id, error: { message: 'BAD_SECOND_START' } });
      } else {
        send({ id: msg.id, result: {} });
        setTimeout(() => send({ method: 'turn/started', params: { threadId: 'fake-thread', turn: { id: 'turn1' } } }), 100);
      }
    } else if (msg.method === 'turn/steer') {
      steerCount++;
      const text = 'STEER_OK starts=' + startCount + ' steers=' + steerCount + ' input=' + inputText(msg.params.input);
      send({ id: msg.id, result: {} });
      send({ method: 'item/agentMessage/delta', params: { turnId: 'turn1', itemId: 'answer1', delta: text } });
      send({ method: 'item/completed', params: { turnId: 'turn1', item: { type: 'agentMessage', id: 'answer1', text } } });
      send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: 'turn1', status: 'completed' } } });
    }
  }
}
`, async (rollout, _dir, marker) => {
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      const first = conn.sendPrompt({ text: 'first prompt starts the turn' });
      const second = conn.sendPrompt({ text: 'second prompt should steer' });
      await Promise.all([first, second]);
      await waitFor(() => messages.some((m) => m.type === 'status' && m.status === 'idle'), 5000);
      const out = messages
        .filter((m) => m.type === 'model-output')
        .map((m) => m.text ?? m.delta ?? '')
        .join('');
      return [
        /STEER_OK starts=1 steers=1/.test(out) && /second prompt should steer/.test(out),
        out || 'no output',
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('thread goal API maps native statuses and clears the active goal', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
const send = (o) => console.log(JSON.stringify(o));
const goal = (status, seconds = 12, budget = 1000) => ({
  threadId: 'fake-thread',
  objective: 'Implement Codex goal display',
  status,
  tokenBudget: budget,
  tokensUsed: 123,
  timeUsedSeconds: seconds,
  createdAt: 1800000000,
  updatedAt: 1800000000 + seconds,
});
let currentGoal = goal('active', 12);
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } }); // cold-load pre-check (issues-part3 mode restore)
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') send({ id: msg.id, result: { thread: { name: 'fake' }, model: 'fake-model', modelProvider: 'fake-provider' } });
    else if (msg.method === 'thread/goal/get') send({ id: msg.id, result: { goal: currentGoal } });
    else if (msg.method === 'skills/list') send({ id: msg.id, result: { data: [] } });
    else if (msg.method === 'thread/goal/set') {
      currentGoal = { ...currentGoal, ...msg.params, objective: msg.params.objective ?? currentGoal.objective, updatedAt: currentGoal.updatedAt + 1 };
      send({ id: msg.id, result: { goal: currentGoal } });
      send({ method: 'thread/goal/updated', params: { threadId: 'fake-thread', goal: currentGoal } });
    }
    else if (msg.method === 'thread/goal/clear') {
      send({ id: msg.id, result: { cleared: true } });
      send({ method: 'thread/goal/cleared', params: { threadId: 'fake-thread' } });
    }
    else if (msg.method === 'turn/start' && String((msg.params?.input ?? []).map((i) => i.text ?? '').join(' ')).includes('hold open')) {
      // Stays RUNNING until turn/interrupt — exercises "/goal pause also brakes the in-flight turn".
      send({ id: msg.id, result: { turn: { id: 'turn2' } } });
      send({ method: 'turn/started', params: { threadId: 'fake-thread', turn: { id: 'turn2' } } });
    }
    else if (msg.method === 'turn/interrupt') {
      send({ id: msg.id, result: {} });
      send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: msg.params.turnId, status: 'interrupted' } } });
    }
    else if (msg.method === 'turn/start') {
      send({ id: msg.id, result: { turn: { id: 'turn1' } } });
      send({ method: 'thread/goal/updated', params: { threadId: 'fake-thread', turnId: 'turn1', goal: goal('active', 13) } });
      send({ method: 'thread/goal/updated', params: { threadId: 'fake-thread', turnId: 'turn1', goal: goal('paused', 14) } });
      send({ method: 'thread/goal/updated', params: { threadId: 'fake-thread', turnId: 'turn1', goal: goal('usageLimited', 15, null) } });
      send({ method: 'thread/goal/updated', params: { threadId: 'fake-thread', turnId: 'turn1', goal: goal('budgetLimited', 16) } });
      send({ method: 'thread/goal/updated', params: { threadId: 'fake-thread', turnId: 'turn1', goal: goal('blocked', 17) } });
      send({ method: 'thread/goal/updated', params: { threadId: 'fake-thread', turnId: 'turn1', goal: goal('complete', 1762) } });
      send({ method: 'thread/goal/cleared', params: { threadId: 'fake-thread' } });
      send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: 'turn1', status: 'completed' } } });
    }
  }
}
`, async (rollout, _dir, marker) => {
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      const history = await conn.getHistory();
      const initial = history.find((m) => m.type === 'goal-state') as any;
      const commands = await conn.listCommands?.();
      const current = await conn.runCommand?.('goal');
      const set = await conn.runCommand?.('goal', 'Ship native goal commands');
      const pause = await conn.runCommand?.('goal', 'pause');
      const resume = await conn.runCommand?.('goal', 'resume');
      const clear = await conn.runCommand?.('goal', 'clear');
      await conn.sendPrompt({ text: 'finish the goal' });
      await waitFor(() => messages.some((m) => m.type === 'goal-state' && m.status === 'done'), 5000);
      await waitFor(() => messages.some((m) => m.type === 'status' && m.status === 'idle'), 5000);
      // /goal pause during a RUNNING turn must also interrupt it (pause alone only gates future
      // auto-turns — verified 2026-07-12, adapters/03-codex.md goal semantics).
      const preHold = messages.length;
      await conn.sendPrompt({ text: 'hold open this goal turn' });
      await waitFor(() => messages.slice(preHold).some((m) => m.type === 'status' && m.status === 'running'), 4000);
      const mark = messages.length;
      const pauseRunning = await conn.runCommand?.('goal', 'pause');
      const interruptSettled = await waitFor(() => messages.slice(mark).some((m) => m.type === 'status' && m.status === 'idle'), 4000);
      const done = messages.find((m) => m.type === 'goal-state' && m.status === 'done');
      const cleared = messages.find((m) => m.type === 'goal-state' && m.status === 'cleared');
      const paused = messages.find((m) => m.type === 'goal-state' && m.status === 'paused' && m.elapsedMs === 14000);
      const blocked = messages.filter((m) => m.type === 'goal-state' && m.status === 'blocked');
      return [
        initial?.status === 'active' &&
          Boolean(commands?.some((c) => c.name === 'goal' && c.kind === 'action')) &&
          /Goal active: Implement Codex goal display/.test(current?.notice ?? '') &&
          /Goal set: Ship native goal commands/.test(set?.notice ?? '') &&
          pause?.notice === 'Goal paused.' && // idle at that point → no interrupt suffix
          /^Goal resumed/.test(resume?.notice ?? '') &&
          clear?.notice === 'Goal cleared.' &&
          pauseRunning?.notice === 'Goal paused; interrupted the running turn.' &&
          interruptSettled &&
          messages.some((m) => m.type === 'goal-state' && m.title === 'Ship native goal commands' && m.status === 'active') &&
          initial?.title === 'Implement Codex goal display' &&
          initial?.elapsedMs === 12000 &&
          paused?.elapsedMs === 14000 &&
          blocked.some((m) => /Usage limited/.test(m.detail || '') && /123 tokens/.test(m.detail || '')) &&
          blocked.some((m) => /Budget limited/.test(m.detail || '') && /123\/1000 tokens/.test(m.detail || '')) &&
          blocked.some((m) => m.detail === '123/1000 tokens') &&
          done?.elapsedMs === 1762000 &&
          done?.detail === '123/1000 tokens' &&
          cleared?.key === 'fake-thread' &&
          !cleared?.title,
        `initial=${initial?.status}/${initial?.elapsedMs} paused=${paused?.elapsedMs} blocked=${blocked.length} done=${done?.elapsedMs} cleared=${cleared?.status}`,
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('permission modes are advertised and ride on turn/start with pending replay', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
let approvalPolicy = '';
let approvalsReviewer = '';
let sandboxType = '';
const send = (o) => console.log(JSON.stringify(o));
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } }); // cold-load pre-check (issues-part3 mode restore)
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') send({ id: msg.id, result: {
      thread: { name: 'fake' },
      model: 'fake-model',
      modelProvider: 'fake-provider',
      reasoningEffort: 'medium',
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
      sandbox: { type: 'workspaceWrite' },
    } });
    else if (msg.method === 'model/list') send({ id: msg.id, result: { data: [{ model: 'fake-model', providerID: 'fake-provider', displayName: 'Fake Model', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }], defaultReasoningEffort: 'medium' }] } });
    else if (msg.method === 'config/read') send({ id: msg.id, result: { config: { model_provider: 'fake-provider' } } });
    else if (msg.method === 'turn/start') {
      approvalPolicy = String(msg.params.approvalPolicy || '');
      approvalsReviewer = String(msg.params.approvalsReviewer || '');
      sandboxType = String(msg.params.sandboxPolicy?.type || 'none');
      send({ id: msg.id, result: { turn: { id: 'turn1' } } });
      send({ method: 'turn/started', params: { threadId: 'fake-thread', turn: { id: 'turn1' } } });
      send({ id: 77, method: 'item/commandExecution/requestApproval', params: {
        threadId: 'fake-thread',
        turnId: 'turn1',
        itemId: 'cmd1',
        command: 'printf MODE_OK',
        cwd: '/tmp',
        availableDecisions: ['acceptForSession'],
      } });
    } else if (msg.id === 77 && msg.result) {
      const text = 'MODE_OK approval=' + approvalPolicy + ' reviewer=' + approvalsReviewer + ' sandbox=' + sandboxType + ' decision=' + JSON.stringify(msg.result);
      send({ method: 'item/agentMessage/delta', params: { turnId: 'turn1', itemId: 'answer1', delta: text } });
      send({ method: 'item/completed', params: { turnId: 'turn1', item: { type: 'agentMessage', id: 'answer1', text } } });
      send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: 'turn1', status: 'completed' } } });
    }
  }
}
`, async (rollout, _dir, marker) => {
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      const modes = await conn.listModes?.();
      const models = await conn.listModels?.();
      await conn.sendPrompt({ text: 'trigger approval', permissionMode: 'full-access' });
      await waitFor(() => messages.some((m) => m.type === 'permission-request'), 5000);
      const perm = messages.find((m) => m.type === 'permission-request');
      const pending = await Promise.resolve(conn.getPending?.() ?? []);
      const pendingPerm = pending.find((m) => m.type === 'permission-request');
      await conn.respondPermission(perm.requestId, 'approve-session');
      await waitFor(() => messages.some((m) => m.type === 'status' && m.status === 'idle'), 5000);
      const out = messages
        .filter((m) => m.type === 'model-output')
        .map((m) => m.text ?? m.delta ?? '')
        .join('');
      const categories = new Set((modes ?? []).map((m: any) => m.category));
      return [
        conn.info.currentModel?.modelID === 'fake-model' &&
          conn.info.currentModel?.providerID === 'fake-provider' &&
          conn.info.currentModel?.reasoningEffort === 'medium' &&
          (models ?? []).some((m: any) => m.providerID === 'fake-provider' && m.modelID === 'fake-model' && m.defaultReasoningEffort === 'medium' && m.reasoningEfforts?.some((e: any) => e.effort === 'low')) &&
          categories.has('ask-permission') &&
          categories.has('approve-for-me') &&
          categories.has('full-access') &&
          pending.length === 1 &&
          pendingPerm?.requestId === perm?.requestId &&
          conn.info.currentMode === 'full-access' &&
          /approval=never/.test(out) &&
          /reviewer=user/.test(out) &&
          /sandbox=dangerFullAccess/.test(out) &&
          /acceptForSession/.test(out),
        `models=${(models ?? []).map((m: any) => m.providerID + '/' + m.modelID).join(',')} modes=${(modes ?? []).map((m: any) => m.value + ':' + m.category).join(',')} pending=${pending.length} currentMode=${conn.info.currentMode} out=${out}`,
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('CR3 preserves model-scoped native Ultra through exact send, settings updates, and reconnect', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
const { appendFileSync, existsSync, readFileSync } = require('node:fs');
const send = (o) => console.log(JSON.stringify(o));
const mark = (entry) => appendFileSync('__MARKER__', JSON.stringify(entry) + String.fromCharCode(10));
const restoredSelection = () => {
  if (!existsSync('__MARKER__')) return { model: 'gpt-5.6-sol', effort: 'medium' };
  const entries = readFileSync('__MARKER__', 'utf8').trim().split(String.fromCharCode(10)).filter(Boolean).map(JSON.parse);
  const last = entries.filter((entry) => entry.kind === 'turn/start').at(-1);
  return { model: last?.model || 'gpt-5.6-sol', effort: last?.effort || 'medium' };
};
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } });
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') {
      const selected = restoredSelection();
      send({ id: msg.id, result: {
        thread: { name: 'CR3 Ultra' },
        model: selected.model,
        modelProvider: 'openai',
        reasoningEffort: selected.effort,
        approvalPolicy: 'untrusted',
        approvalsReviewer: 'user',
        sandbox: { type: 'workspaceWrite' },
      } });
    } else if (msg.method === 'config/read') {
      send({ id: msg.id, result: { config: { model_provider: 'openai' } } });
    } else if (msg.method === 'model/list') {
      const ordinary = [
        { reasoningEffort: 'low', description: 'Fast responses' },
        { reasoningEffort: 'medium', description: 'Balanced reasoning' },
        { reasoningEffort: 'high', description: 'Deep reasoning' },
        { reasoningEffort: 'xhigh', description: 'Extra deep reasoning' },
        { reasoningEffort: 'max', description: 'Maximum single-agent reasoning' },
      ];
      const ultra = {
        reasoningEffort: 'ultra',
        label: 'Native Ultra',
        description: 'Maximum reasoning with automatic task delegation',
      };
      send({ id: msg.id, result: { data: [
        { model: 'gpt-5.6-sol', providerID: 'openai', displayName: 'GPT-5.6 Sol', supportedReasoningEfforts: [...ordinary, ultra], defaultReasoningEffort: 'medium' },
        { model: 'gpt-5.6-terra', providerID: 'openai', displayName: 'GPT-5.6 Terra', supportedReasoningEfforts: [...ordinary, ultra], defaultReasoningEffort: 'medium' },
        { model: 'gpt-5.6-luna', providerID: 'openai', displayName: 'GPT-5.6 Luna', supportedReasoningEfforts: ordinary, defaultReasoningEffort: 'medium' },
        { model: 'gpt-5.5-codex', providerID: 'openai', displayName: 'GPT-5.5 Codex', supportedReasoningEfforts: ordinary.slice(0, 3), defaultReasoningEffort: 'medium' },
      ], nextCursor: null } });
    } else if (msg.method === 'turn/start') {
      mark({ kind: 'turn/start', model: msg.params.model, provider: msg.params.modelProvider, effort: msg.params.effort });
      send({ id: msg.id, result: { turn: { id: 'ultra-turn' } } });
      // Both notifications are deliberately partial: they repeat the model but omit effort. They
      // must not erase the exact Ultra setting selected immediately before turn/start.
      send({ method: 'turn/started', params: { threadId: 'fake-thread', turn: { id: 'ultra-turn', model: msg.params.model, modelProvider: msg.params.modelProvider } } });
      send({ method: 'thread/settings/updated', params: { threadId: 'fake-thread', threadSettings: { model: msg.params.model, modelProvider: msg.params.modelProvider, approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandboxPolicy: { type: 'workspaceWrite' } } } });
      send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: 'ultra-turn', status: 'completed' } } });
    }
  }
}
`, async (rollout, _dir, marker) => {
    const id = Buffer.from(rollout, 'utf8').toString('base64url');
    const adapter = new CodexAdapter();
    const first = await adapter.attach(id, 'resume');
    try {
      const models = await first.listModels?.() ?? [];
      const sol = models.find((model: any) => model.modelID === 'gpt-5.6-sol');
      const terra = models.find((model: any) => model.modelID === 'gpt-5.6-terra');
      const luna = models.find((model: any) => model.modelID === 'gpt-5.6-luna');
      const older = models.find((model: any) => model.modelID === 'gpt-5.5-codex');
      const solUltra = sol?.reasoningEfforts?.find((entry: any) => entry.effort === 'ultra');
      const catalogIsScoped =
        solUltra?.label === 'Native Ultra' &&
        solUltra?.description === 'Maximum reasoning with automatic task delegation' &&
        terra?.reasoningEfforts?.some((entry: any) => entry.effort === 'ultra') &&
        !luna?.reasoningEfforts?.some((entry: any) => entry.effort === 'ultra') &&
        !older?.reasoningEfforts?.some((entry: any) => entry.effort === 'ultra');

      const messages: any[] = [];
      first.subscribe((message: any) => messages.push(message));
      await first.sendPrompt({
        text: 'Run with native Ultra',
        model: { providerID: 'openai', modelID: 'gpt-5.6-sol', reasoningEffort: 'ultra' },
      });
      await waitFor(() => messages.some((message) => message.type === 'status' && message.status === 'idle'), 5000);
      const sent = readMarkers(marker).find((entry) => entry.kind === 'turn/start');
      const survivedPartialSettings = first.info.currentModel?.modelID === 'gpt-5.6-sol' && first.info.currentModel?.reasoningEffort === 'ultra';
      await first.close();

      const reconnected = await adapter.attach(id, 'resume');
      try {
        const refreshed = await reconnected.listModels?.() ?? [];
        const refreshedSol = refreshed.find((model: any) => model.modelID === 'gpt-5.6-sol');
        return [
          Boolean(catalogIsScoped &&
            sent?.model === 'gpt-5.6-sol' &&
            sent?.provider === 'openai' &&
            sent?.effort === 'ultra' &&
            survivedPartialSettings &&
            reconnected.info.currentModel?.modelID === 'gpt-5.6-sol' &&
            reconnected.info.currentModel?.reasoningEffort === 'ultra' &&
            refreshedSol?.reasoningEfforts?.some((entry: any) => entry.effort === 'ultra')),
          `catalog=${models.map((model: any) => `${model.modelID}:${(model.reasoningEfforts ?? []).map((entry: any) => entry.effort).join('|')}`).join(',')} sent=${JSON.stringify(sent)} first=${JSON.stringify(first.info.currentModel)} reconnected=${JSON.stringify(reconnected.info.currentModel)}`,
        ];
      } finally {
        await reconnected.close().catch(() => {});
      }
    } finally {
      await first.close().catch(() => {});
    }
  });
});

// Issues-part3 follow-up (maintainer 2026-07-13): "it still default to ask permission, can it simply
// default to approve for me?" — a session whose rollout records NO mode must cold-load as
// approve-for-me, asserted ON THE THREAD (not just displayed), while any recorded mode still wins.
const DEFAULT_MODE_FAKE = `#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
const updates = [];
let resumeHadReviewer = false;
const send = (o) => console.log(JSON.stringify(o));
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } });
    else if (msg.method === 'thread/settings/update') { updates.push(msg.params || {}); send({ id: msg.id, result: {} }); }
    else if (msg.method === 'thread/resume') {
      resumeHadReviewer = Object.prototype.hasOwnProperty.call(msg.params || {}, 'approvalsReviewer');
      send({ id: msg.id, result: {
        thread: { name: 'fake' },
        model: 'fake-model',
        modelProvider: 'fake-provider',
        // Exact legacy tuple: it derives to Approve for me for compatibility, but it is not the
        // canonical auto-review configuration and therefore must still be normalized.
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: { type: 'workspaceWrite' },
      } });
    }
    else if (msg.method === 'model/list') send({ id: msg.id, result: { data: [] } });
    else if (msg.method === 'config/read') send({ id: msg.id, result: { config: {} } });
    else if (msg.method === 'turn/start') {
      const text = 'SETTINGS ' + JSON.stringify({
        updates,
        resumeHadReviewer,
        turnApproval: msg.params.approvalPolicy ?? null,
        turnReviewer: msg.params.approvalsReviewer ?? null,
        turnSandbox: msg.params.sandboxPolicy ?? null,
      });
      send({ id: msg.id, result: { turn: { id: 'turn1' } } });
      send({ method: 'turn/started', params: { threadId: 'fake-thread', turn: { id: 'turn1' } } });
      send({ method: 'item/completed', params: { turnId: 'turn1', item: { type: 'agentMessage', id: 'a1', text } } });
      send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: 'turn1', status: 'completed' } } });
    }
  }
}
`;

await test('never-configured session cold-loads as approve-for-me (the app default), asserted on the thread', async () => {
  return await withFakeCodex(DEFAULT_MODE_FAKE, async (rollout) => {
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      await conn.sendPrompt({ text: 'report settings' }); // undirty prompt — must not carry a mode itself
      await waitFor(() => messages.some((m) => m.type === 'status' && m.status === 'idle'), 5000);
      const out = messages.filter((m) => m.type === 'model-output').map((m) => m.text ?? m.delta ?? '').join('');
      const parsed = JSON.parse(out.replace(/^.*?SETTINGS /, '').trim() || '{}');
      const updates = Array.isArray(parsed.updates) ? parsed.updates : [];
      return [
        conn.info.currentMode === 'approve-for-me' &&
          updates.length === 1 &&
          updates[0]?.approvalPolicy === 'on-request' &&
          updates[0]?.approvalsReviewer === 'auto_review' &&
          updates[0]?.sandboxPolicy?.type === 'workspaceWrite' &&
          parsed.resumeHadReviewer === false &&
          parsed.turnApproval === null &&
          parsed.turnReviewer === null &&
          parsed.turnSandbox === null,
        `currentMode=${conn.info.currentMode} updates=${JSON.stringify(updates)} resumeHadReviewer=${parsed.resumeHadReviewer} turn=${JSON.stringify({ approval: parsed.turnApproval, reviewer: parsed.turnReviewer, sandbox: parsed.turnSandbox })}`,
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('recorded Codex auto-review survives cold restore and an undirty prompt', async () => {
  return await withFakeCodex(DEFAULT_MODE_FAKE, async (rollout) => {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(rollout, JSON.stringify({
      type: 'turn_context',
      payload: {
        turn_id: 't0',
        approval_policy: 'on-request',
        approvals_reviewer: 'auto_review',
        sandbox_policy: { type: 'workspace-write', network_access: false },
        model: 'fake-model',
      },
    }) + String.fromCharCode(10));
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      await conn.sendPrompt({ text: 'report settings' });
      await waitFor(() => messages.some((m) => m.type === 'status' && m.status === 'idle'), 5000);
      const out = messages.filter((m) => m.type === 'model-output').map((m) => m.text ?? m.delta ?? '').join('');
      const parsed = JSON.parse(out.replace(/^.*?SETTINGS /, '').trim() || '{}');
      const updates = Array.isArray(parsed.updates) ? parsed.updates : [];
      return [
        conn.info.currentMode === 'approve-for-me' &&
          updates.length === 1 &&
          updates[0]?.approvalPolicy === 'on-request' &&
          updates[0]?.approvalsReviewer === 'auto_review' &&
          updates[0]?.sandboxPolicy?.type === 'workspaceWrite' &&
          parsed.resumeHadReviewer === false &&
          parsed.turnApproval === null &&
          parsed.turnReviewer === null &&
          parsed.turnSandbox === null,
        `currentMode=${conn.info.currentMode} updates=${JSON.stringify(updates)} resumeHadReviewer=${parsed.resumeHadReviewer} turn=${JSON.stringify({ approval: parsed.turnApproval, reviewer: parsed.turnReviewer, sandbox: parsed.turnSandbox })}`,
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('danger sandbox takes precedence over a mixed auto-review approval tuple', async () => {
  return await withFakeCodex(DEFAULT_MODE_FAKE, async (rollout) => {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(rollout, JSON.stringify({
      type: 'turn_context',
      payload: {
        turn_id: 't0',
        approval_policy: 'on-request',
        approvals_reviewer: 'auto_review',
        sandbox_policy: { type: 'danger-full-access' },
        model: 'fake-model',
      },
    }) + String.fromCharCode(10));
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      await conn.sendPrompt({ text: 'report mixed settings' });
      await waitFor(() => messages.some((m) => m.type === 'status' && m.status === 'idle'), 5000);
      const out = messages.filter((m) => m.type === 'model-output').map((m) => m.text ?? m.delta ?? '').join('');
      const parsed = JSON.parse(out.replace(/^.*?SETTINGS /, '').trim() || '{}');
      const updates = Array.isArray(parsed.updates) ? parsed.updates : [];
      return [
        conn.info.currentMode === 'full-access' &&
          updates.length === 1 &&
          updates[0]?.approvalPolicy === 'on-request' &&
          updates[0]?.approvalsReviewer === 'auto_review' &&
          updates[0]?.sandboxPolicy?.type === 'dangerFullAccess' &&
          parsed.turnApproval === null &&
          parsed.turnReviewer === null &&
          parsed.turnSandbox === null,
        `currentMode=${conn.info.currentMode} updates=${JSON.stringify(updates)} turn=${JSON.stringify({ approval: parsed.turnApproval, reviewer: parsed.turnReviewer, sandbox: parsed.turnSandbox })}`,
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('a rollout with a RECORDED ask mode is restored, never overridden by the approve-for-me default', async () => {
  return await withFakeCodex(DEFAULT_MODE_FAKE, async (rollout) => {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(rollout, JSON.stringify({
      type: 'turn_context',
      payload: { turn_id: 't0', approval_policy: 'untrusted', sandbox_policy: { type: 'workspace-write', network_access: false }, model: 'fake-model' },
    }) + String.fromCharCode(10));
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      await conn.sendPrompt({ text: 'report settings' });
      await waitFor(() => messages.some((m) => m.type === 'status' && m.status === 'idle'), 5000);
      const out = messages.filter((m) => m.type === 'model-output').map((m) => m.text ?? m.delta ?? '').join('');
      const parsed = JSON.parse(out.replace(/^.*?SETTINGS /, '').trim() || '{}');
      const updates = Array.isArray(parsed.updates) ? parsed.updates : [];
      return [
        conn.info.currentMode === 'ask-permission' &&
          updates.length === 1 &&
          updates[0]?.approvalPolicy === 'untrusted' &&
          !updates.some((u: any) => u?.approvalPolicy === 'never'),
        `currentMode=${conn.info.currentMode} updates=${JSON.stringify(updates)}`,
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('Drive resume preserves policy until prompt and permission modes reset full-access sandbox', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
let resumeHadApprovalPolicy = false;
let resumeHadReviewer = false;
let turnCount = 0;
const pending = new Map();
const records = [];
const send = (o) => console.log(JSON.stringify(o));
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } }); // cold-load pre-check (issues-part3 mode restore)
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') {
      resumeHadApprovalPolicy = Object.prototype.hasOwnProperty.call(msg.params || {}, 'approvalPolicy');
      resumeHadReviewer = Object.prototype.hasOwnProperty.call(msg.params || {}, 'approvalsReviewer');
      send({ id: msg.id, result: {
        thread: { name: 'fake' },
        model: 'fake-model',
        modelProvider: 'fake-provider',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
        sandbox: { type: 'workspaceWrite', writableRoots: ['/tmp'], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      } });
    } else if (msg.method === 'turn/start') {
      turnCount++;
      const turnId = 'turn' + turnCount;
      const approvalId = 90 + turnCount;
      records.push({
        approval: String(msg.params.approvalPolicy || ''),
        reviewer: String(msg.params.approvalsReviewer || ''),
        sandbox: String(msg.params.sandboxPolicy?.type || 'none'),
      });
      pending.set(approvalId, { turnId, record: records[records.length - 1] });
      send({ id: msg.id, result: { turn: { id: turnId } } });
      send({ method: 'turn/started', params: { threadId: 'fake-thread', turn: { id: turnId } } });
      send({ id: approvalId, method: 'item/commandExecution/requestApproval', params: {
        threadId: 'fake-thread',
        turnId,
        itemId: 'cmd' + turnCount,
        command: 'printf MODE_RESET',
        cwd: '/tmp',
        availableDecisions: ['accept'],
      } });
    } else if (pending.has(msg.id) && msg.result) {
      const item = pending.get(msg.id);
      pending.delete(msg.id);
      const text = 'RESET_OK resumeHadApproval=' + resumeHadApprovalPolicy + ' resumeHadReviewer=' + resumeHadReviewer + ' records=' + JSON.stringify(records);
      send({ method: 'item/agentMessage/delta', params: { turnId: item.turnId, itemId: 'answer' + msg.id, delta: text } });
      send({ method: 'item/completed', params: { turnId: item.turnId, item: { type: 'agentMessage', id: 'answer' + msg.id, text } } });
      send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: item.turnId, status: 'completed' } } });
    }
  }
}
`, async (rollout, _dir, marker) => {
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      await conn.sendPrompt({ text: 'full', permissionMode: 'full-access' });
      await waitFor(() => messages.some((m) => m.type === 'permission-request'), 5000);
      let perm = messages.find((m) => m.type === 'permission-request');
      await conn.respondPermission(perm.requestId, 'approve');
      await waitFor(() => messages.filter((m) => m.type === 'model-output' && /RESET_OK/.test(String(m.text ?? m.delta ?? ''))).length >= 1, 5000);
      await waitFor(() => messages.filter((m) => m.type === 'status' && m.status === 'idle').length >= 1, 5000);

      await conn.sendPrompt({ text: 'ask', permissionMode: 'ask-permission' });
      await waitFor(() => messages.filter((m) => m.type === 'permission-request').length >= 2, 5000);
      perm = messages.filter((m) => m.type === 'permission-request').at(-1);
      await conn.respondPermission(perm.requestId, 'approve');
      await waitFor(() => messages.filter((m) => m.type === 'model-output' && /RESET_OK/.test(String(m.text ?? m.delta ?? ''))).length >= 2, 5000);
      await waitFor(() => messages.filter((m) => m.type === 'status' && m.status === 'idle').length >= 2, 5000);

      await conn.sendPrompt({ text: 'approve automatically', permissionMode: 'approve-for-me' });
      await waitFor(() => messages.filter((m) => m.type === 'permission-request').length >= 3, 5000);
      perm = messages.filter((m) => m.type === 'permission-request').at(-1);
      await conn.respondPermission(perm.requestId, 'approve');
      await waitFor(() => messages.filter((m) => m.type === 'model-output' && /RESET_OK/.test(String(m.text ?? m.delta ?? ''))).length >= 3, 5000);
      await waitFor(() => messages.filter((m) => m.type === 'status' && m.status === 'idle').length >= 3, 5000);

      const out = messages
        .filter((m) => m.type === 'model-output')
        .map((m) => m.text ?? m.delta ?? '')
        .join('');
      const matches = [...out.matchAll(/records=(\[[^\]]+\])/g)];
      const records = matches.length ? JSON.parse(matches.at(-1)![1]!) : [];
      return [
        /resumeHadApproval=false/.test(out) &&
          /resumeHadReviewer=false/.test(out) &&
          records[0]?.approval === 'never' &&
          records[0]?.reviewer === 'user' &&
          records[0]?.sandbox === 'dangerFullAccess' &&
          records[1]?.approval === 'on-request' &&
          records[1]?.reviewer === 'user' &&
          records[1]?.sandbox === 'workspaceWrite' &&
          records[2]?.approval === 'on-request' &&
          records[2]?.reviewer === 'auto_review' &&
          records[2]?.sandbox === 'workspaceWrite' &&
          conn.info.currentMode === 'approve-for-me',
        `currentMode=${conn.info.currentMode} out=${out}`,
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('Codex skill commands use selected turn options instead of stale session mode', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
let turnCount = 0;
const records = [];
const send = (o) => console.log(JSON.stringify(o));
const inputSummary = (input) => (input || []).map((p) => p.type === 'skill' ? 'skill:' + p.name : (p.text || '')).join('|');
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } }); // cold-load pre-check (issues-part3 mode restore)
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') send({ id: msg.id, result: {
      thread: { name: 'fake' },
      model: 'fake-model',
      modelProvider: 'fake-provider',
      approvalPolicy: 'untrusted',
      sandbox: { type: 'workspaceWrite' },
    } });
    else if (msg.method === 'skills/list') send({ id: msg.id, result: { data: [{ cwd: '/tmp', skills: [{ name: 'trace-skill', path: '/tmp/SKILL.md', enabled: true, shortDescription: 'Trace skill' }], errors: [] }] } });
    else if (msg.method === 'turn/start') {
      turnCount++;
      const turnId = 'turn' + turnCount;
      records.push({
        approval: String(msg.params.approvalPolicy || ''),
        reviewer: String(msg.params.approvalsReviewer || ''),
        sandbox: String(msg.params.sandboxPolicy?.type || 'none'),
        model: String(msg.params.model || ''),
        provider: String(msg.params.modelProvider || ''),
        effort: String(msg.params.effort || ''),
        input: inputSummary(msg.params.input),
      });
      const text = 'SKILL_MODE_OK records=' + JSON.stringify(records);
      send({ id: msg.id, result: { turn: { id: turnId } } });
      send({ method: 'turn/started', params: { threadId: 'fake-thread', turn: { id: turnId } } });
      send({ method: 'item/agentMessage/delta', params: { turnId, itemId: 'answer' + turnCount, delta: text } });
      send({ method: 'item/completed', params: { turnId, item: { type: 'agentMessage', id: 'answer' + turnCount, text } } });
      send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: turnId, status: 'completed' } } });
    }
  }
}
`, async (rollout, _dir, marker) => {
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      await conn.sendPrompt({ text: 'full first', permissionMode: 'full-access' });
      await waitFor(() => messages.filter((m) => m.type === 'status' && m.status === 'idle').length >= 1, 5000);
      await conn.runCommand?.('trace-skill', 'use safe mode', {
        permissionMode: 'ask-permission',
        model: { providerID: 'safe-provider', modelID: 'safe-model', reasoningEffort: 'low' },
      });
      await waitFor(() => messages.filter((m) => m.type === 'status' && m.status === 'idle').length >= 2, 5000);
      const out = messages
        .filter((m) => m.type === 'model-output')
        .map((m) => m.text ?? m.delta ?? '')
        .join('');
      const matches = [...out.matchAll(/records=(\[[^\n]+?\])/g)];
      const records = matches.length ? JSON.parse(matches.at(-1)![1]!) : [];
      return [
        records[0]?.approval === 'never' &&
          records[0]?.reviewer === 'user' &&
          records[0]?.sandbox === 'dangerFullAccess' &&
          records[1]?.approval === 'on-request' &&
          records[1]?.reviewer === 'user' &&
          records[1]?.sandbox === 'workspaceWrite' &&
          records[1]?.model === 'safe-model' &&
          records[1]?.provider === 'safe-provider' &&
          records[1]?.effort === 'low' &&
          /skill:trace-skill/.test(records[1]?.input || '') &&
          /use safe mode/.test(records[1]?.input || ''),
        `currentMode=${conn.info.currentMode} records=${JSON.stringify(records)}`,
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('Codex stop waits for turn id during startup before interrupting', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
let interrupted = false;
const send = (o) => console.log(JSON.stringify(o));
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } }); // cold-load pre-check (issues-part3 mode restore)
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') send({ id: msg.id, result: { thread: { name: 'fake' }, model: 'fake-model', modelProvider: 'fake-provider' } });
    else if (msg.method === 'turn/start') {
      setTimeout(() => send({ method: 'turn/started', params: { threadId: 'fake-thread', turn: { id: 'turn1' } } }), 50);
      setTimeout(() => send({ id: msg.id, result: { turn: { id: 'turn1' } } }), 150);
    } else if (msg.method === 'turn/interrupt') {
      interrupted = msg.params?.turnId === 'turn1';
      send({ id: msg.id, result: {} });
      const text = 'STOP_OK interrupted=' + interrupted;
      send({ method: 'item/agentMessage/delta', params: { turnId: 'turn1', itemId: 'answer1', delta: text } });
      send({ method: 'item/completed', params: { turnId: 'turn1', item: { type: 'agentMessage', id: 'answer1', text } } });
      send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: 'turn1', status: 'interrupted' } } });
    }
  }
}
`, async (rollout, _dir, marker) => {
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      const prompt = conn.sendPrompt({ text: 'start then stop' });
      const stop = conn.runCommand?.('stop');
      const stopResult = await stop;
      await prompt;
      await waitFor(() => messages.some((m) => m.type === 'status' && m.status === 'idle'), 5000);
      const out = messages
        .filter((m) => m.type === 'model-output')
        .map((m) => m.text ?? m.delta ?? '')
        .join('');
      return [
        stopResult?.notice === 'Stopped the turn.' && /STOP_OK interrupted=true/.test(out),
        `notice=${stopResult?.notice} out=${out}`,
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('three live zero-output stops emit exact owned interruption boundaries', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
let turnSeq = 0;
const send = (o) => console.log(JSON.stringify(o));
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } });
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') send({ id: msg.id, result: { thread: { name: 'fake' }, model: 'fake-model', modelProvider: 'fake-provider' } });
    else if (msg.method === 'turn/start') {
      turnSeq += 1;
      const turnId = 'turn-' + turnSeq;
      const text = String((msg.params?.input ?? []).map((item) => item.text ?? '').join(' '));
      send({ id: msg.id, result: { turn: { id: turnId } } });
      send({ method: 'turn/started', params: { threadId: 'fake-thread', turn: { id: turnId } } });
      send({ method: 'item/started', params: {
        threadId: 'fake-thread',
        turnId,
        item: {
          type: 'userMessage',
          id: 'user-' + turnSeq,
          clientId: msg.params.clientUserMessageId,
          content: [{ type: 'text', text }],
        },
      } });
    } else if (msg.method === 'turn/interrupt') {
      send({ id: msg.id, result: {} });
      send({ method: 'turn/completed', params: {
        threadId: 'fake-thread',
        turn: { id: msg.params.turnId, status: 'interrupted' },
      } });
    }
  }
}
`, async (rollout) => {
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      const cycles: any[][] = [];
      for (let cycle = 1; cycle <= 3; cycle++) {
        const mark = messages.length;
        await conn.sendPrompt({ text: `prompt ${cycle}` });
        await waitFor(
          () => messages.slice(mark).some((m) =>
            m.type === 'run-summary'
            && m.status === 'running'
            && m.turnId === `turn-${cycle}`),
          4000,
        );
        const stopped = await conn.runCommand?.('stop');
        await waitFor(
          () => messages.slice(mark).some((m) =>
            m.type === 'run-summary'
            && m.status === 'cancelled'
            && m.turnId === `turn-${cycle}`),
          4000,
        );
        if (stopped?.notice !== 'Stopped the turn.') {
          return [false, `cycle=${cycle} stop=${JSON.stringify(stopped)}`];
        }
        cycles.push(messages.slice(mark));
      }

      const valid = cycles.every((cycle, index) => {
        const turnId = `turn-${index + 1}`;
        const userKey = `codex:${turnId}:u0`;
        const userIndex = cycle.findIndex((m) =>
          m.type === 'user-message' && m.key === userKey);
        const interruptions = cycle.filter((m) =>
          m.type === 'notice'
          && m.semantic?.kind === 'interruption'
          && m.semantic?.turnId === turnId);
        const noticeIndex = cycle.indexOf(interruptions[0]);
        const summaryIndex = cycle.findIndex((m) =>
          m.type === 'run-summary'
          && m.status === 'cancelled'
          && m.turnId === turnId
          && m.userMessageKey === userKey
          && m.assistantMessageKey === undefined);
        return userIndex >= 0
          && interruptions.length === 1
          && noticeIndex > userIndex
          && summaryIndex > noticeIndex;
      });
      return [
        valid,
        cycles.map((cycle) => cycle.map((m) =>
          `${m.type}:${m.turnId ?? m.semantic?.turnId ?? m.key ?? ''}`).join(',')).join(' | '),
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('native no-timestamp completion reaches the durable attention feed', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
const send = (o) => console.log(JSON.stringify(o));
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } });
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') send({ id: msg.id, result: { thread: { name: 'fake' }, model: 'fake-model', modelProvider: 'fake-provider' } });
    else if (msg.method === 'turn/start') {
      send({ id: msg.id, result: { turn: { id: 'native-completion' } } });
      send({ method: 'turn/started', params: {
        threadId: 'fake-thread',
        turn: { id: 'native-completion' },
      } });
      while (!require('node:fs').existsSync('__MARKER__.release')) {
        await Bun.sleep(10);
      }
      send({ method: 'turn/completed', params: {
        threadId: 'fake-thread',
        turn: { id: 'native-completion', status: 'completed' },
      } });
    }
  }
}
`, async (rollout, dir, marker) => {
    const attention = new AttentionService({
      store: { home: join(dir, 'attention') },
    });
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    const attentionWork: Promise<void>[] = [];
    conn.subscribe((message: any) => {
      messages.push(message);
      attentionWork.push(attention.handleMessage({
        id: 'native-session',
        tool: 'codex',
        title: 'Native session',
        status: 'idle',
        attachMode: 'live',
      }, message));
    });
    try {
      await conn.sendPrompt({ text: 'finish natively' });
      const running = await waitFor(() => messages.some((m) =>
        m.type === 'run-summary'
        && m.status === 'running'
        && m.turnId === 'native-completion'), 4000);
      writeFileSync(`${marker}.release`, 'release\n');
      await waitFor(() => messages.some((m) =>
        m.type === 'run-summary'
        && m.status === 'done'
        && m.turnId === 'native-completion'), 4000);
      await Promise.all(attentionWork);
      await waitFor(() => attention.store.findByDedupeKey(
        'run-finished:codex:native-session:native-completion',
      ) !== undefined, 4000);
      const event = attention.store.findByDedupeKey(
        'run-finished:codex:native-session:native-completion',
      );
      const feed = await attention.getEvents({
        after: 0,
        clientId: 'physical-review-client',
      });
      return [
        running
          && event?.state === 'resolved'
          && event?.presentationRevision === 1
          && event?.turnId === 'native-completion'
          && feed.events.some((item) =>
            item.id === event.id
            && item.readAt === undefined),
        `summaries=${JSON.stringify(messages.filter((m) => m.type === 'run-summary'))} event=${JSON.stringify(event)}`,
      ];
    } finally {
      attention.dispose();
      await conn.close().catch(() => {});
    }
  });
});

await test('thread waiting flags surface read-only pending cards when request is not replayed', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
const send = (o) => console.log(JSON.stringify(o));
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } }); // cold-load pre-check (issues-part3 mode restore)
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') {
      send({ id: msg.id, result: { thread: { name: 'fake' }, model: 'fake-model', modelProvider: 'fake-provider' } });
      setTimeout(() => send({ method: 'thread/status/changed', params: { threadId: 'fake-thread', status: { type: 'active', activeFlags: ['waitingOnApproval', 'waitingOnUserInput'] } } }), 50);
      setTimeout(() => send({ method: 'thread/status/changed', params: { threadId: 'fake-thread', status: { type: 'idle' } } }), 150);
    }
  }
}
`, async (rollout) => {
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      await waitFor(() => messages.some((m) => m.type === 'permission-request' && m.readOnly), 5000);
      await waitFor(() => messages.some((m) => m.type === 'question-request' && m.readOnly), 5000);
      await waitFor(() => messages.some((m) => m.type === 'permission-resolved'), 5000);
      await waitFor(() => messages.some((m) => m.type === 'question-resolved'), 5000);
      const card = messages.find((m) => m.type === 'permission-request');
      const question = messages.find((m) => m.type === 'question-request');
      const resolved = messages.find((m) => m.type === 'permission-resolved');
      const questionResolved = messages.find((m) => m.type === 'question-resolved');
      return [
        card?.requestId?.startsWith('codex:waiting:approval:fake-thread:') === true &&
          card?.readOnly === true &&
          resolved?.requestId === card.requestId &&
          question?.requestId?.startsWith('codex:waiting:question:fake-thread:') === true &&
          question?.readOnly === true &&
          questionResolved?.requestId === question.requestId,
        `card=${JSON.stringify(card)} question=${JSON.stringify(question)} resolved=${JSON.stringify(resolved)} questionResolved=${JSON.stringify(questionResolved)}`,
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('native model notification refreshes currentModel and emits sessionInfo metadata', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
const send = (o) => console.log(JSON.stringify(o));
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } }); // cold-load pre-check (issues-part3 mode restore)
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') {
      send({ id: msg.id, result: { thread: { name: 'fake' }, model: 'initial-model', modelProvider: 'initial-provider', reasoningEffort: 'low' } });
      setTimeout(() => send({ method: 'turn/started', params: { threadId: 'fake-thread', turn: { id: 'turn-native', model: 'native-codex-model', modelProvider: 'native-provider', reasoningEffort: 'high' } } }), 50);
    }
  }
}
`, async (rollout, _dir, marker) => {
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      await waitFor(() => messages.some((m) => m.type === 'metadata-update' && m.key === 'sessionInfo'), 5000);
      const update = messages.find((m) => m.type === 'metadata-update' && m.key === 'sessionInfo');
      return [
        conn.info.currentModel?.providerID === 'native-provider' &&
          conn.info.currentModel?.modelID === 'native-codex-model' &&
          conn.info.currentModel?.reasoningEffort === 'high' &&
          update?.value?.currentModel?.providerID === 'native-provider' &&
          update?.value?.currentModel?.modelID === 'native-codex-model' &&
          update?.value?.currentModel?.reasoningEffort === 'high',
        `info=${JSON.stringify(conn.info.currentModel)} update=${JSON.stringify(update)}`,
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('native thread settings notification refreshes currentModel and emits sessionInfo metadata', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
const send = (o) => console.log(JSON.stringify(o));
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } }); // cold-load pre-check (issues-part3 mode restore)
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') {
      send({ id: msg.id, result: { thread: { name: 'fake' }, model: 'initial-model', modelProvider: 'initial-provider', reasoningEffort: 'low' } });
      setTimeout(() => send({ method: 'thread/settings/updated', params: { threadId: 'fake-thread', threadSettings: { model: 'settings-codex-model', modelProvider: 'settings-provider', effort: 'medium' } } }), 50);
    }
  }
}
`, async (rollout, _dir, marker) => {
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      await waitFor(() => messages.some((m) => m.type === 'metadata-update' && m.key === 'sessionInfo'), 5000);
      const update = messages.find((m) => m.type === 'metadata-update' && m.key === 'sessionInfo');
      return [
        conn.info.currentModel?.providerID === 'settings-provider' &&
          conn.info.currentModel?.modelID === 'settings-codex-model' &&
          conn.info.currentModel?.reasoningEffort === 'medium' &&
          update?.value?.currentModel?.providerID === 'settings-provider' &&
          update?.value?.currentModel?.modelID === 'settings-codex-model' &&
          update?.value?.currentModel?.reasoningEffort === 'medium',
        `info=${JSON.stringify(conn.info.currentModel)} update=${JSON.stringify(update)}`,
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('native turn plan notification maps to canonical task-list-state', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
const send = (o) => console.log(JSON.stringify(o));
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } }); // cold-load pre-check (issues-part3 mode restore)
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') send({ id: msg.id, result: { thread: { name: 'fake' }, model: 'fake-model', modelProvider: 'fake-provider' } });
    else if (msg.method === 'turn/start') {
      send({ id: msg.id, result: { turn: { id: 'turn-plan' } } });
      send({ method: 'turn/started', params: { threadId: 'fake-thread', turn: { id: 'turn-plan' } } });
      send({ method: 'turn/plan/updated', params: {
        threadId: 'fake-thread',
        turnId: 'turn-plan',
        explanation: 'Native plan',
        plan: [
          { step: 'Inspect native plan notification', status: 'inProgress' },
          { step: 'Map to canonical task list', status: 'pending' },
          { step: 'Report done', status: 'completed' }
        ]
      } });
      send({ method: 'item/completed', params: { turnId: 'turn-plan', item: { type: 'agentMessage', id: 'answer-plan', text: 'plan ok' } } });
      send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: 'turn-plan', status: 'completed' } } });
    }
  }
}
`, async (rollout, _dir, marker) => {
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      await conn.sendPrompt({ text: 'plan please' });
      await waitFor(() => messages.some((m) => m.type === 'task-list-state'), 5000);
      const taskList = messages.find((m) => m.type === 'task-list-state');
      return [
        taskList?.key === 'codex:plan:turn-plan' &&
          taskList?.source === 'native' &&
          taskList?.sourceTool === 'turn/plan/updated' &&
          taskList?.semantic?.kind === 'plan' &&
          taskList?.semantic?.planKey === 'codex:plan:turn-plan' &&
          Object.values(taskList?.semantic?.actions ?? {}).every((supported) => supported === false) &&
          taskList?.status === 'running' &&
          taskList?.items?.[0]?.status === 'in-progress' &&
          taskList?.items?.[1]?.status === 'open' &&
          taskList?.items?.[2]?.status === 'done',
        `taskList=${JSON.stringify(taskList)}`,
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('active reattach steers prompts into in-progress thread turn', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
const send = (o) => console.log(JSON.stringify(o));
const { appendFileSync } = require('node:fs');
const inputText = (input) => (input || []).map((p) => p.text || '').join(' ').trim();
let steerCount = 0;
const mark = (entry) => appendFileSync('__MARKER__', JSON.stringify(entry) + String.fromCharCode(10));
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } }); // cold-load pre-check
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') {
      mark({ kind: 'resume', status: 'active', activeTurn: 'turn-active' });
      send({
        id: msg.id,
        result: {
          thread: {
            name: 'fake',
            status: { type: 'active' },
            turns: [{ id: 'turn-late', status: 'completed', startedAt: '2026-06-01T00:00:01.000Z' }],
          },
          model: 'fake-model',
          modelProvider: 'fake-provider',
          initialTurnsPage: { data: [{ id: 'turn-active', status: 'in-progress', startedAt: '2026-06-01T00:00:10.000Z' }] },
        },
      });
    } else if (msg.method === 'turn/start') {
      mark({ kind: 'turn/start-request' });
      send({ id: msg.id, error: { message: 'unexpected start after active resume' } });
    } else if (msg.method === 'turn/steer') {
      const expected = String(msg.params?.expectedTurnId ?? '');
      steerCount += 1;
      if (steerCount === 1) {
        send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: 'turn-mismatch', status: 'completed' } } });
        mark({ kind: 'remote-turn-completed-delivered', turnId: 'turn-mismatch', when: 'mismatch' });
        send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: 'turn-old', status: 'completed' } } });
        mark({ kind: 'remote-turn-completed-delivered', turnId: 'turn-old', when: 'late-stale' });
        send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { status: 'completed' } } });
        mark({ kind: 'remote-turn-completed-delivered', turnId: null, when: 'missing' });
      }
      mark({ kind: 'turn/steer-request', expectedTurnId: expected, input: inputText(msg.params?.input), index: steerCount });
      send({ id: msg.id, result: {} });
      const text = 'STEER_' + steerCount + '=' + inputText(msg.params?.input);
      send({ method: 'item/agentMessage/delta', params: { threadId: 'fake-thread', turnId: expected, itemId: 'answer' + steerCount, delta: text } });
      send({ method: 'item/completed', params: { turnId: expected, item: { type: 'agentMessage', id: 'answer' + steerCount, text } } });
      if (steerCount === 2) send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: expected, status: 'completed' } } });
    }
  }
}
`, async (rollout, _dir, marker) => {
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      const first = conn.sendPrompt({ text: 'first follow-up in resumed active thread' });
      const second = conn.sendPrompt({ text: 'second follow-up in same active thread' });
      await Promise.all([first, second]);
      await waitFor(() => messages.some((m) => m.type === 'status' && m.status === 'idle'), 5000);
      const markerEvents = readMarkers(marker);
      const startCalls = markerEvents.filter((m) => m.kind === 'turn/start-request');
      const steerCalls = markerEvents.filter((m) => m.kind === 'turn/steer-request');
      const steerToActive = steerCalls.every((m: any) => m.expectedTurnId === 'turn-active');
      return [
        startCalls.length === 0 &&
          steerCalls.length === 2 &&
          steerToActive &&
          messages.some((m) => m.type === 'model-output' && String(m.text ?? m.delta ?? '').startsWith('STEER_')),
        `start=${startCalls.length} steers=${steerCalls.length} values=${JSON.stringify(steerCalls.map((m) => m.expectedTurnId))} idle=${messages.filter((m) => m.type === 'status' && m.status === 'idle').length}`,
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('idle reattach sends one turn/start then steers the returned turn', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
const send = (o) => console.log(JSON.stringify(o));
const { appendFileSync } = require('node:fs');
const inputText = (input) => (input || []).map((p) => p.text || '').join(' ').trim();
let steerCount = 0;
const mark = (entry) => appendFileSync('__MARKER__', JSON.stringify(entry) + String.fromCharCode(10));
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } }); // cold-load pre-check
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') send({ id: msg.id, result: { thread: { name: 'fake', status: { type: 'idle' } }, model: 'fake-model', modelProvider: 'fake-provider' } });
    else if (msg.method === 'turn/start') {
      const turnId = 'turn-idle';
      mark({ kind: 'turn/start-request', turnId });
      send({ id: msg.id, result: { turn: { id: turnId } } });
      send({ method: 'turn/started', params: { threadId: 'fake-thread', turn: { id: turnId } } });
    } else if (msg.method === 'turn/steer') {
      const expected = String(msg.params?.expectedTurnId ?? '');
      steerCount++;
      mark({ kind: 'turn/steer-request', expectedTurnId: expected, input: inputText(msg.params?.input), index: steerCount });
      send({ id: msg.id, result: {} });
      const text = 'IDLE_STEER=' + inputText(msg.params?.input);
      send({ method: 'item/agentMessage/delta', params: { threadId: 'fake-thread', turnId: expected, itemId: 'answer-idle', delta: text } });
      send({ method: 'item/completed', params: { turnId: expected, item: { type: 'agentMessage', id: 'answer-idle', text } } });
      send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: expected, status: 'completed' } } });
    }
  }
}
`, async (rollout, _dir, marker) => {
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      const first = conn.sendPrompt({ text: 'start from idle' });
      const second = conn.sendPrompt({ text: 'follow-up should steer same turn' });
      await Promise.all([first, second]);
      await waitFor(() => messages.some((m) => m.type === 'status' && m.status === 'idle'), 5000);
      const markerEvents = readMarkers(marker);
      const startCalls = markerEvents.filter((m) => m.kind === 'turn/start-request');
      const steerCalls = markerEvents.filter((m) => m.kind === 'turn/steer-request');
      const expectedTurn = startCalls[0]?.turnId;
      const allSteeredToIdleTurn = expectedTurn && steerCalls.every((m: any) => m.expectedTurnId === expectedTurn);
      return [
        startCalls.length === 1 && steerCalls.length === 1 && allSteeredToIdleTurn,
        `start=${startCalls.length} steer=${steerCalls.length} turns=${JSON.stringify(steerCalls.map((m) => m.expectedTurnId))} idle=${messages.filter((m) => m.type === 'status' && m.status === 'idle').length}`,
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('ambiguous turn/start failure reconciles state and avoids duplicate start on retry', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
const send = (o) => console.log(JSON.stringify(o));
const { appendFileSync } = require('node:fs');
const inputText = (input) => (input || []).map((p) => p.text || '').join(' ').trim();
let startCount = 0;
let readCount = 0;
const mark = (entry) => appendFileSync('__MARKER__', JSON.stringify(entry) + String.fromCharCode(10));
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } }); // cold-load pre-check
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') send({ id: msg.id, result: { thread: { name: 'fake' }, model: 'fake-model', modelProvider: 'fake-provider', status: { type: 'idle' } } });
    else if (msg.method === 'turn/start') {
      startCount++;
      mark({ kind: 'turn/start-request', attempt: startCount, hasInput: inputText(msg.params?.input).trim().length > 0 });
      if (startCount === 1) {
        send({ id: msg.id, error: { message: 'temporary start failure' } });
      } else {
        send({ id: msg.id, result: { turn: { id: 'turn-duplicate' } } });
        send({ method: 'turn/started', params: { threadId: 'fake-thread', turn: { id: 'turn-duplicate' } } });
      }
    } else if (msg.method === 'thread/read') {
      readCount++;
      mark({ kind: 'thread/read-request', count: readCount });
      if (readCount === 1) {
        send({ id: msg.id, result: { thread: { status: { type: 'active' } }, turns: [{ id: 'turn-native', status: 'in-progress', startedAt: '2026-06-01T00:00:10.000Z' }] } });
      } else {
        send({ id: msg.id, result: { thread: { status: { type: 'idle' } }, turns: [] } });
      }
    } else if (msg.method === 'thread/turns/list') {
      mark({ kind: 'thread/turns-list-request', count: readCount });
      send({ id: msg.id, result: { data: [] } });
    } else if (msg.method === 'turn/steer') {
      const expected = String(msg.params?.expectedTurnId ?? '');
      mark({ kind: 'turn/steer-request', expectedTurnId: expected, input: inputText(msg.params?.input) });
      send({ id: msg.id, result: {} });
      const text = 'RETRIED_STEER=' + expected + ':' + inputText(msg.params?.input);
      send({ method: 'item/agentMessage/delta', params: { threadId: 'fake-thread', turnId: expected, itemId: 'answer2', delta: text } });
      send({ method: 'item/completed', params: { turnId: expected, item: { type: 'agentMessage', id: 'answer2', text } } });
      send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: expected, status: 'completed' } } });
    }
  }
}
`, async (rollout, _dir, marker) => {
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    let firstError: string | undefined;
    conn.subscribe((m: any) => messages.push(m));
    try {
      const first = conn.sendPrompt({ text: 'ambiguous start that may have landed' });
      await first.catch((err) => {
        firstError = err instanceof Error ? err.message : String(err);
      });
      const second = conn.sendPrompt({ text: 'retry prompt should steer recovered turn' });
      await second;
      await waitFor(() => messages.some((m) => m.type === 'status' && m.status === 'idle'), 5000);
      const markerEvents = readMarkers(marker);
      const startCalls = markerEvents.filter((m) => m.kind === 'turn/start-request');
      const readCalls = markerEvents.filter((m) => m.kind === 'thread/read-request');
      const steerCalls = markerEvents.filter((m) => m.kind === 'turn/steer-request');
      const recoveredTurnSteered = steerCalls.every((m: any) => m.expectedTurnId === 'turn-native');
      const out = messages
        .filter((m) => m.type === 'model-output')
        .map((m) => m.text ?? m.delta ?? '')
        .join('');
      return [
        startCalls.length === 1 &&
          firstError !== undefined &&
          readCalls.length >= 1 &&
          steerCalls.length === 1 &&
          recoveredTurnSteered &&
          /RETRIED_STEER=turn-native/.test(out) &&
          /temporary start failure/.test(firstError),
        `starts=${startCalls.length} reads=${readCalls.length} steers=${steerCalls.length} out=${out} firstErr=${firstError}`,
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('bootstrap completion race does not clear a newer in-flight turn', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
const send = (o) => console.log(JSON.stringify(o));
const { appendFileSync } = require('node:fs');
const inputText = (input) => (input || []).map((p) => p.text || '').join(' ').trim();
const mark = (entry) => appendFileSync('__MARKER__', JSON.stringify(entry) + String.fromCharCode(10));
const sendSteerOutput = (turnId, idx, text) => {
  send({ method: 'item/agentMessage/delta', params: { threadId: 'fake-thread', turnId, itemId: 'answer-' + idx, delta: text } });
  send({ method: 'item/completed', params: { turnId, item: { type: 'agentMessage', id: 'answer-' + idx, text } } });
};
let steerCount = 0;
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } }); // cold-load pre-check
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') {
      send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: 'turn-old', status: 'completed' } } });
      mark({ kind: 'remote-turn-completed-delivered', turnId: 'turn-old', when: 'bootstrap-initial' });
      mark({ kind: 'resume', status: 'active', activeTurn: 'turn-old' });
      send({
        id: msg.id,
        result: {
          thread: {
            name: 'fake',
            status: { type: 'active' },
            turns: [{ id: 'turn-old', status: 'in-progress', startedAt: '2026-06-01T00:00:02.000Z' }],
          },
          model: 'fake-model',
          modelProvider: 'fake-provider',
          initialTurnsPage: { data: [{ id: 'turn-old', status: 'in-progress', startedAt: '2026-06-01T00:00:02.000Z' }] },
        },
      });
      mark({ kind: 'remote-turn-completed', turnId: 'turn-old', when: 'bootstrap-initial' });
    } else if (msg.method === 'turn/start') {
      const turnId = 'turn-new';
      mark({ kind: 'turn/start-request' });
      send({ method: 'turn/started', params: { threadId: 'fake-thread', turn: { id: turnId } } });
      mark({ kind: 'turn/started', turnId });
      send({ method: 'thread/status/changed', params: { threadId: 'fake-thread', status: { type: 'active', activeFlags: ['waitingOnApproval'] } } });
      mark({ kind: 'thread-status-changed', status: 'active' });
      send({ id: msg.id, result: { turn: { id: turnId } } });
    } else if (msg.method === 'turn/steer') {
      const expected = String(msg.params?.expectedTurnId ?? '');
      send({ id: msg.id, result: {} });
      const output = 'RACE_STEER=' + expected + ':' + inputText(msg.params?.input);
      steerCount += 1;
      if (steerCount === 1) {
        send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: 'turn-mismatch', status: 'completed' } } });
        mark({ kind: 'remote-turn-completed-delivered', turnId: 'turn-mismatch', when: 'mismatch' });
        send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: 'turn-old', status: 'completed' } } });
        mark({ kind: 'remote-turn-completed-delivered', turnId: 'turn-old', when: 'late-stale' });
        send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { status: 'completed' } } });
        mark({ kind: 'remote-turn-completed-delivered', turnId: null, when: 'missing' });
      }
      mark({ kind: 'turn/steer-request', expectedTurnId: expected, index: steerCount, input: inputText(msg.params?.input) });
      sendSteerOutput(expected, steerCount, output);
      send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: expected, status: 'completed' } } });
      mark({ kind: 'turn/completed', turnId: expected, when: 'new' });
    }
  }
}
`, async (rollout, _dir, marker) => {
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      const first = conn.sendPrompt({ text: 'resume race prompt 1' });
      const second = conn.sendPrompt({ text: 'resume race prompt 2' });
      await Promise.all([first, second]);
      const ready = await waitFor(() => {
        const markerEvents = readMarkers(marker);
        return (
          markerEvents.some((m) => m.kind === 'turn/completed' && m.turnId === 'turn-new') &&
          markerEvents.some((m) => m.kind === 'remote-turn-completed-delivered' && m.turnId === 'turn-mismatch') &&
          markerEvents.some((m) => m.kind === 'remote-turn-completed-delivered' && m.turnId === 'turn-old') &&
          markerEvents.some((m) => m.kind === 'remote-turn-completed-delivered' && m.turnId === null) &&
          markerEvents.some((m) => m.kind === 'thread-status-changed' && m.status === 'active')
        );
      }, 5000);
      if (!ready) return [false, 'bootstrap race markers not observed'];
      await waitFor(() => messages.some((m) => m.type === 'status' && m.status === 'idle'), 5000);
      const markerEvents = readMarkers(marker);
      const startCalls = markerEvents.filter((m) => m.kind === 'turn/start-request');
      const steerCalls = markerEvents.filter((m) => m.kind === 'turn/steer-request');
      const staleDelivered = markerEvents.filter((m) => m.kind === 'remote-turn-completed-delivered' && m.turnId === 'turn-old');
      const mismatchDelivered = markerEvents.some((m) => m.kind === 'remote-turn-completed-delivered' && m.turnId === 'turn-mismatch');
      const missingDelivered = markerEvents.some((m) => m.kind === 'remote-turn-completed-delivered' && m.turnId === null);
      const statusActiveObserved = markerEvents.some((m) => m.kind === 'thread-status-changed' && m.status === 'active');
      const completed = markerEvents.filter((m) => m.kind === 'turn/completed');
      const allSteeredToNewTurn = steerCalls.every((m: any) => m.expectedTurnId === 'turn-new');
      const statusIdleCount = messages.filter((m) => m.type === 'status' && m.status === 'idle').length;
      return [
        startCalls.length === 1 &&
          steerCalls.length === 1 &&
          allSteeredToNewTurn &&
          staleDelivered.length >= 1 &&
          mismatchDelivered &&
          missingDelivered &&
          statusActiveObserved &&
          completed.some((m: any) => m.turnId === 'turn-new') &&
          !completed.some((m: any) => m.turnId === 'turn-old') &&
          statusIdleCount >= 1,
        `start=${startCalls.length} steer=${steerCalls.length} stale=${staleDelivered.length} mismatch=${mismatchDelivered} missing=${missingDelivered} statusActive=${statusActiveObserved} completed=${JSON.stringify(completed.map((m) => m.turnId))} idle=${statusIdleCount}`,
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('R0c exact resumed turn ignores weak idle/replay sources until one authoritative completion', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
const send = (o) => console.log(JSON.stringify(o));
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } });
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/goal/get') send({ id: msg.id, result: { goal: null } });
    else if (msg.method === 'thread/resume') {
      // Bootstrap replay can deliver weak session-level frames on either side of the exact resume.
      send({ method: 'thread/status/changed', params: { threadId: 'fake-thread', status: { type: 'idle' } } });
      send({ method: 'thread/status/changed', params: { threadId: 'fake-thread', status: { type: 'notLoaded' } } });
      send({ id: msg.id, result: {
        thread: {
          name: 'fake',
          status: { type: 'active' },
          turns: [{ id: 'turn-coherent', status: 'in-progress', startedAt: '2026-07-31T12:00:00.000Z' }],
        },
        initialTurnsPage: { data: [{ id: 'turn-coherent', status: 'in-progress', startedAt: '2026-07-31T12:00:00.000Z' }] },
        model: 'fake-model',
        modelProvider: 'fake-provider',
      } });
      setTimeout(() => send({ method: 'turn/started', params: { threadId: 'fake-thread', turn: { id: 'turn-coherent' } } }), 30);
      setTimeout(() => send({ method: 'thread/status/changed', params: { threadId: 'fake-thread', status: { type: 'idle' } } }), 50);
      setTimeout(() => send({ method: 'thread/status/changed', params: { threadId: 'fake-thread', status: { type: 'notLoaded' } } }), 70);
      setTimeout(() => send({ method: 'thread/status/changed', params: { threadId: 'fake-thread', status: { type: 'active', activeFlags: ['waitingOnApproval'] } } }), 90);
      setTimeout(() => send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: 'retired-turn', status: 'completed', completedAt: '2026-07-31T12:00:03.000Z' } } }), 105);
      setTimeout(() => send({ method: 'thread/status/changed', params: { threadId: 'fake-thread', turnId: 'retired-turn', status: { type: 'systemError' } } }), 115);
      setTimeout(() => send({ method: 'thread/status/changed', params: { threadId: 'fake-thread', status: { type: 'idle' } } }), 130);
      setTimeout(() => send({ method: 'item/completed', params: { turnId: 'turn-coherent', item: { type: 'agentMessage', id: 'still-running', text: 'STILL_RUNNING_AFTER_WEAK_IDLE' } } }), 160);
      setTimeout(() => send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: 'turn-coherent', status: 'completed', createdAt: '2026-07-31T12:00:00.000Z', completedAt: '2026-07-31T12:00:08.000Z' } } }), 260);
      setTimeout(() => send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: 'turn-coherent', status: 'completed', createdAt: '2026-07-31T12:00:00.000Z', completedAt: '2026-07-31T12:00:08.000Z' } } }), 280);
      setTimeout(() => send({ method: 'thread/status/changed', params: { threadId: 'fake-thread', status: { type: 'idle' } } }), 300);
    }
  }
}
`, async (rollout) => {
    appendFileSync(rollout, JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-coherent' } }) + '\n');
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const managed = new ManagedConn(conn);
    const frames: any[] = [];
    managed.addClient((frame: any) => frames.push(
      frame.kind === 'session' ? { ...frame, info: { ...frame.info } } : frame,
    ));
    try {
      const resumedWorking = conn.info.status === 'working' && managed.status === 'working';
      const replayOne = await conn.getHistory();
      const replayTwo = await conn.getHistory();
      const replayStayedOpen = [replayOne, replayTwo].every((history) =>
        history.some((message: any) => message.type === 'run-summary' && message.turnId === 'turn-coherent' && message.status === 'running')
        && !history.some((message: any) => message.type === 'run-summary' && message.turnId === 'turn-coherent' && message.status !== 'running'));
      await waitFor(() => frames.some((frame) => frame.kind === 'message' && frame.message?.text === 'STILL_RUNNING_AFTER_WEAK_IDLE'), 3000);
      const beforeCompletion = frames.filter((frame) => frame.kind === 'message');
      const weakSourcesDidNotIdle = managed.status === 'needs-input'
        && beforeCompletion.some((frame) => frame.message?.type === 'permission-request')
        && beforeCompletion.filter((frame) => frame.message?.type === 'status' && frame.message?.status === 'idle').length === 0;
      await waitFor(() => managed.status === 'idle', 3000);
      await sleep(100);
      const messages = frames.filter((frame) => frame.kind === 'message').map((frame) => frame.message);
      const idle = messages.filter((message) => message?.type === 'status' && message.status === 'idle');
      const done = messages.filter((message) => message?.type === 'run-summary' && message.turnId === 'turn-coherent' && message.status === 'done');
      const retired = messages.filter((message) => message?.type === 'run-summary' && message.turnId === 'retired-turn');
      const staleErrors = messages.filter((message) => message?.type === 'error');
      const projectedIdle = frames.filter((frame) => frame.kind === 'session' && frame.info?.status === 'idle');
      return [
        resumedWorking
          && replayStayedOpen
          && weakSourcesDidNotIdle
          && idle.length === 1
          && done.length === 1
          && done[0]?.completedAt === Date.parse('2026-07-31T12:00:08.000Z')
          && retired.length === 1
          && staleErrors.length === 0
          && projectedIdle.length === 1
          && managed.status === 'idle',
        `resumed=${resumedWorking} replay=${replayStayedOpen} weak=${weakSourcesDidNotIdle} idle=${idle.length} done=${JSON.stringify(done)} retired=${retired.length} staleErrors=${staleErrors.length} projectedIdle=${projectedIdle.length}`,
      ];
    } finally {
      await managed.dispose().catch(() => {});
    }
  });
});

await test('foreign thread notifications/requests are ignored with no cross-thread mutation', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
const send = (o) => console.log(JSON.stringify(o));
const { appendFileSync } = require('node:fs');
const inputText = (input) => (input || []).map((p) => p.text || '').join(' ').trim();
const mark = (entry) => appendFileSync('__MARKER__', JSON.stringify(entry) + String.fromCharCode(10));
const foreignRequestId = 9001;
const unknownForeignRequestId = 9002;
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.id === foreignRequestId || msg.id === unknownForeignRequestId) mark({ kind: 'foreign-thread-client-response', id: msg.id, hasResult: Object.prototype.hasOwnProperty.call(msg, 'result') || !Object.prototype.hasOwnProperty.call(msg, 'error') });
    if (Object.prototype.hasOwnProperty.call(msg, 'result')) mark({ kind: 'client-result', id: msg.id });
    if (Object.prototype.hasOwnProperty.call(msg, 'error')) mark({ kind: 'client-error', id: msg.id });
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } }); // cold-load pre-check
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') {
      send({ id: msg.id, result: { thread: { name: 'fake', status: { type: 'idle' } }, model: 'fake-model', modelProvider: 'fake-provider' } });
      setTimeout(() => send({ method: 'turn/started', params: { threadId: 'other-thread', turn: { id: 'foreign-turn' } } }), 5);
      setTimeout(() => send({ method: 'item/agentMessage/delta', params: { threadId: 'other-thread', turnId: 'foreign-turn', itemId: 'foreign', delta: 'foreign output' } }), 10);
      setTimeout(() => send({ method: 'turn/completed', params: { threadId: 'other-thread', turn: { id: 'foreign-turn', status: 'completed' } } }), 15);
      setTimeout(() => send({ method: 'thread/tokenUsage/updated', params: { threadId: 'other-thread', tokenUsage: { total: { inputTokens: 3, outputTokens: 4, cachedInputTokens: 1 } } } }), 20);
      setTimeout(() => send({ method: 'thread/goal/updated', params: { threadId: 'other-thread', goal: { objective: 'other', status: 'active' } } }), 25);
      setTimeout(() => send({ method: 'turn/plan/updated', params: { threadId: 'other-thread', turnId: 'foreign-turn', explanation: 'ignore', plan: [{ step: 'other', status: 'done' }] } }), 30);
      setTimeout(() => send({ method: 'error', params: { threadId: 'other-thread', error: { message: 'foreign error' } } }), 35);
      setTimeout(() => send({ id: foreignRequestId, method: 'item/tool/requestUserInput', params: {
        threadId: 'other-thread',
        turnId: 'foreign-turn',
        itemId: 'foreign-tool',
        questions: [{ id: 'q1', type: 'text', prompt: 'Foreign input' }],
      } }), 40);
      setTimeout(() => send({ id: unknownForeignRequestId, method: 'unknown/foreign/method', params: {
        threadId: 'other-thread',
        turnId: 'foreign-turn',
      } }), 45);
    } else if (msg.method === 'turn/start') {
      mark({ kind: 'turn/start-request', local: true });
      send({ id: msg.id, result: { turn: { id: 'turn-local' } } });
      send({ method: 'turn/started', params: { threadId: 'fake-thread', turn: { id: 'turn-local' } } });
      send({ method: 'item/agentMessage/delta', params: { threadId: 'fake-thread', turnId: 'turn-local', itemId: 'local-answer', delta: 'local output: ' + inputText(msg.params?.input) } });
      send({ method: 'item/completed', params: { turnId: 'turn-local', item: { type: 'agentMessage', id: 'local-answer', text: 'local output done' } } });
      send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: 'turn-local', status: 'completed' } } });
    }
  }
}
`, async (rollout, _dir, marker) => {
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      await conn.sendPrompt({ text: 'local followup' });
      await waitFor(() => messages.some((m) => m.type === 'status' && m.status === 'idle'), 5000);
      const markerEvents = readMarkers(marker);
      const foreignClientResponses = markerEvents.filter((m) => m.kind === 'foreign-thread-client-response' || m.kind === 'foreign-thread-client-error').length;
      const startCalls = markerEvents.filter((m) => m.kind === 'turn/start-request');
      const foreignMutation = messages.some((m) => m.text === 'foreign output' || m.type === 'permission-request' || m.type === 'question-request');
      const foreignTokens = messages.some((m) => m.type === 'token-count' && typeof m.input === 'number');
      const foreignPlan = messages.some((m) => m.type === 'task-list-state' && m.key === 'codex:plan:foreign-turn');
      const foreignErr = messages.some((m) => m.type === 'error' && String(m.message ?? '').includes('foreign'));
      return [
        startCalls.length === 1 &&
          foreignClientResponses === 0 &&
          !foreignMutation &&
          !foreignTokens &&
          !foreignPlan &&
          !foreignErr,
        `start=${startCalls.length} foreignResponses=${foreignClientResponses} messages=${messages.length} keys=${messages.map((m) => m.type).join(',')}`,
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('same-chunk completion cannot resurrect a turn and idle mismatch recovery reuses the client message id', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
const send = (o) => console.log(JSON.stringify(o));
const sendChunk = (items) => process.stdout.write(items.map((item) => JSON.stringify(item)).join(String.fromCharCode(10)) + String.fromCharCode(10));
const { appendFileSync } = require('node:fs');
const inputText = (input) => (input || []).map((p) => p.text || '').join(' ').trim();
const mark = (entry) => appendFileSync('__MARKER__', JSON.stringify(entry) + String.fromCharCode(10));
let startCount = 0;
let steerCount = 0;
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } });
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') send({ id: msg.id, result: {
      thread: { name: 'fake', status: { type: 'active' } },
      initialTurnsPage: { data: [{ id: 'turn-stale', status: 'in-progress', startedAt: '2026-07-17T10:00:00.000Z' }] },
      model: 'fake-model',
      modelProvider: 'fake-provider',
    } });
    else if (msg.method === 'turn/steer') {
      steerCount++;
      mark({ kind: 'turn/steer-request', clientUserMessageId: msg.params?.clientUserMessageId, expectedTurnId: msg.params?.expectedTurnId, input: inputText(msg.params?.input) });
      if (steerCount === 1) send({ id: msg.id, error: { code: 'expected_active_turn', message: 'expected active turn mismatch' } });
      else {
        send({ id: msg.id, result: {} });
        send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: {
          id: 'turn-next',
          status: 'completed',
          createdAt: '2026-07-17T10:00:01.000Z',
          completedAt: '2026-07-17T10:00:05.000Z',
        } } });
      }
    } else if (msg.method === 'thread/read') {
      send({ id: msg.id, result: { thread: { status: { type: 'idle' } }, turns: [] } });
    } else if (msg.method === 'turn/start') {
      startCount++;
      const turnId = startCount === 1 ? 'turn-recovered' : 'turn-next';
      const status = startCount === 1 ? 'failed' : 'completed';
      mark({ kind: 'turn/start-request', clientUserMessageId: msg.params?.clientUserMessageId, turnId, input: inputText(msg.params?.input) });
      const completed = {
        method: 'turn/completed',
        params: { threadId: 'fake-thread', turn: {
          id: turnId,
          status,
          ...(startCount === 1 ? { error: { message: 'recovered turn failed' } } : {}),
          createdAt: '2026-07-17T10:00:01.000Z',
          completedAt: startCount === 1 ? '2026-07-17T10:00:03.000Z' : '2026-07-17T10:00:04.000Z',
        } },
      };
      // The RPC result deliberately precedes completion in one stdout write. There is no
      // turn/started notification for the completed turn, so the adapter must not resurrect it.
      const result = { id: msg.id, result: { turn: { id: turnId } } };
      if (startCount === 1) {
        sendChunk([result, completed]);
      } else {
        // A stale started(X) must not clear a newer active(Y). This all arrives in one read chunk
        // after the start result; the real next prompt must still steer Y.
        sendChunk([
          result,
          { method: 'turn/started', params: { threadId: 'fake-thread', turn: { id: 'turn-next' } } },
          { method: 'turn/started', params: { threadId: 'fake-thread', turn: { id: 'turn-recovered' } } },
        ]);
      }
    }
  }
}
`, async (rollout, _dir, marker) => {
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      await conn.sendPrompt({ text: 'first prompt must recover by starting idle' });
      await conn.sendPrompt({ text: 'second prompt must start, not steer a dead turn' });
      await conn.sendPrompt({ text: 'third prompt must steer newer active turn' });
      await waitFor((() =>
        messages.some((m) => m.type === 'run-summary' && m.turnId === 'turn-next' && m.status === 'done') &&
        messages.some((m) => m.type === 'status' && m.status === 'idle')
      ), 5000);
      const markerEvents = readMarkers(marker);
      const startCalls = markerEvents.filter((m) => m.kind === 'turn/start-request');
      const steerCalls = markerEvents.filter((m) => m.kind === 'turn/steer-request');
      const summaries = messages.filter((m) => m.type === 'run-summary');
      const errors = messages.filter((m) => m.type === 'error').map((m) => String(m.message ?? ''));
      const statuses = messages.filter((m) => m.type === 'status').map((m) => m.status);
      return [
        steerCalls.length === 2 &&
          startCalls.length === 2 &&
          startCalls[0]?.clientUserMessageId === steerCalls[0]?.clientUserMessageId &&
          startCalls[0]?.turnId === 'turn-recovered' &&
          startCalls[1]?.turnId === 'turn-next' &&
          steerCalls[0]?.expectedTurnId === 'turn-stale' &&
          steerCalls[1]?.expectedTurnId === 'turn-next' &&
          summaries.filter((m) => m.status === 'error' && m.turnId === 'turn-recovered').length === 1 &&
          summaries.filter((m) => m.status === 'done' && m.turnId === 'turn-next').length === 1 &&
          errors.filter((message) => message.includes('recovered turn failed')).length === 1 &&
          statuses.filter((status) => status === 'idle').length === 1,
        `starts=${JSON.stringify(startCalls)} steers=${JSON.stringify(steerCalls)} summaries=${JSON.stringify(summaries)} errors=${JSON.stringify(errors)} statuses=${JSON.stringify(statuses)}`,
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('app-send clientMessageId round-trips as clientKey on the exact user echo', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
let turnSeq = 0;
const send = (o) => console.log(JSON.stringify(o));
const inputText = (input) => (input || []).map((p) => p.text || '').join(' ').trim();
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } });
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') send({ id: msg.id, result: { thread: { name: 'fake' }, model: 'fake-model', modelProvider: 'fake-provider' } });
    else if (msg.method === 'turn/start') {
      const turnId = 'turn' + (++turnSeq);
      const text = inputText(msg.params.input);
      send({ id: msg.id, result: { turn: { id: turnId } } });
      send({ method: 'turn/started', params: { threadId: 'fake-thread', turn: { id: turnId } } });
      send({ method: 'item/started', params: { turnId, item: { type: 'userMessage', id: 'u' + turnSeq, clientId: msg.params.clientUserMessageId, content: [{ type: 'text', text }] } } });
      send({ method: 'item/completed', params: { turnId, item: { type: 'agentMessage', id: 'a' + turnSeq, text: 'ok' } } });
      send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: turnId, status: 'completed' } } });
    }
  }
}
`, async (rollout) => {
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      await conn.sendPrompt({ text: 'stamped send', clientMessageId: 'ca.codex.1' });
      await waitFor(() => messages.some((m) => m.type === 'user-message' && m.text === 'stamped send'), 5000);
      await waitFor(() => messages.some((m) => m.type === 'status' && m.status === 'idle'), 5000);
      await conn.sendPrompt({ text: 'stamped send' }); // same text, no broker correlation
      await waitFor(() => messages.filter((m) => m.type === 'user-message' && m.text === 'stamped send').length >= 2, 5000);
      const echoes = messages.filter((m) => m.type === 'user-message' && m.text === 'stamped send');
      return [
        echoes.length === 2 &&
          echoes[0]?.clientKey === 'ca.codex.1' &&
          // CR4b: identity is the canonical (turn, ordinal) key both the live app-server and a
          // rollout replay rebuild — never the broker-invented `cosyncing-…` clientId, which no
          // replay can reproduce. Correlation still rides `clientKey`, by exact token.
          echoes[0]?.key === 'codex:turn1:u0' &&
          echoes[1]?.key === 'codex:turn2:u0' &&
          echoes[1]?.clientKey === undefined,
        `echoes=${JSON.stringify(echoes.map((m) => ({ key: m.key, clientKey: m.clientKey })))}`,
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

// ── CR2: request/resolution lifecycle — no orphan resolutions ───────────────────────────────────

const requestCounts = (messages: any[]) => ({
  permReq: messages.filter((m) => m.type === 'permission-request').length,
  qReq: messages.filter((m) => m.type === 'question-request').length,
  permRes: messages.filter((m) => m.type === 'permission-resolved').length,
  qRes: messages.filter((m) => m.type === 'question-resolved').length,
});

await test('CR2 ordinary no-request turn emits zero requests and zero resolutions through completion, idle, repeats, missing-id, and system error', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
const send = (o) => console.log(JSON.stringify(o));
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } });
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') send({ id: msg.id, result: { thread: { name: 'fake' }, model: 'fake-model', modelProvider: 'fake-provider' } });
    else if (msg.method === 'turn/start') {
      send({ id: msg.id, result: { turn: { id: 'turn1' } } });
      send({ method: 'turn/started', params: { threadId: 'fake-thread', turn: { id: 'turn1' } } });
      send({ method: 'item/completed', params: { turnId: 'turn1', item: { type: 'agentMessage', id: 'a1', text: 'plain answer' } } });
      send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: 'turn1', status: 'completed' } } });
      // Every settling path an ordinary turn can hit, in sequence:
      send({ method: 'thread/status/changed', params: { threadId: 'fake-thread', status: { type: 'idle' } } });
      send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: 'turn1', status: 'completed' } } }); // repeated completion
      send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { status: 'completed' } } }); // missing-id completion
      send({ method: 'thread/status/changed', params: { threadId: 'fake-thread', status: { type: 'systemError' } } });
      send({ method: 'thread/status/changed', params: { threadId: 'fake-thread', status: { type: 'idle' } } });
      send({ method: 'item/completed', params: { turnId: 'turn1', item: { type: 'agentMessage', id: 'done-marker', text: 'SETTLED' } } });
    }
  }
}
`, async (rollout) => {
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      await conn.sendPrompt({ text: 'ordinary turn' });
      await waitFor(() => messages.some((m) => m.type === 'model-output' && m.text === 'SETTLED'), 5000);
      const counts = requestCounts(messages);
      return [
        counts.permReq === 0 && counts.qReq === 0 && counts.permRes === 0 && counts.qRes === 0,
        JSON.stringify(counts),
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('CR2 repeated waiting flags emit one placeholder and exactly one resolution per kind', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
const send = (o) => console.log(JSON.stringify(o));
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } });
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') {
      send({ id: msg.id, result: { thread: { name: 'fake' }, model: 'fake-model', modelProvider: 'fake-provider' } });
      const active = { threadId: 'fake-thread', status: { type: 'active', activeFlags: ['waitingOnApproval', 'waitingOnUserInput'] } };
      setTimeout(() => send({ method: 'thread/status/changed', params: active }), 30);
      setTimeout(() => send({ method: 'thread/status/changed', params: active }), 60); // repeated flags
      setTimeout(() => send({ method: 'thread/status/changed', params: { threadId: 'fake-thread', status: { type: 'idle' } } }), 120);
      setTimeout(() => send({ method: 'thread/status/changed', params: { threadId: 'fake-thread', status: { type: 'idle' } } }), 150); // repeated idle
    }
  }
}
`, async (rollout) => {
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      await waitFor(() => messages.some((m) => m.type === 'permission-resolved'), 5000);
      await waitFor(() => messages.some((m) => m.type === 'status' && m.status === 'idle'), 5000);
      const counts = requestCounts(messages);
      return [
        counts.permReq === 1 && counts.qReq === 1 && counts.permRes === 1 && counts.qRes === 1
          && messages.filter((m) => m.type === 'status' && m.status === 'idle').length === 1,
        JSON.stringify({ ...counts, idle: messages.filter((m) => m.type === 'status' && m.status === 'idle').length }),
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('CR2 a waiting placeholder emitted during bootstrap is replayable and settles when its flag clears', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
const send = (o) => console.log(JSON.stringify(o));
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } });
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') {
      // This notification is queued and flushed before attach() returns, when
      // the eventual broker/client subscriber does not exist yet.
      send({ method: 'thread/status/changed', params: { threadId: 'fake-thread', status: { type: 'active', activeFlags: ['waitingOnApproval'] } } });
      send({ id: msg.id, result: { thread: { name: 'fake', status: { type: 'active' }, turns: [{ id: 'turn-bootstrap', status: 'in-progress' }] }, model: 'fake-model', modelProvider: 'fake-provider' } });
      // Still active, but no longer waiting: this is enough to settle the
      // synthetic placeholder without settling an unrelated native request.
      setTimeout(() => send({ method: 'thread/status/changed', params: { threadId: 'fake-thread', status: { type: 'active', activeFlags: [] } } }), 80);
      setTimeout(() => send({ method: 'thread/status/changed', params: { threadId: 'fake-thread', status: { type: 'active', activeFlags: [] } } }), 120);
    }
  }
}
`, async (rollout) => {
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      const pending = await Promise.resolve(conn.getPending?.() ?? []);
      const placeholder = pending.find((m: any) => m.type === 'permission-request') as any;
      await waitFor(() => messages.some((m) => m.type === 'permission-resolved'), 5000);
      await sleep(100);
      const counts = requestCounts(messages);
      return [
        placeholder?.requestId?.startsWith('codex:waiting:approval:fake-thread:') &&
          placeholder?.readOnly === true &&
          counts.permReq === 0 &&
          counts.permRes === 1 &&
          messages.find((m) => m.type === 'permission-resolved')?.requestId === placeholder.requestId &&
          messages.find((m) => m.type === 'permission-resolved')?.decision === 'external' &&
          (await Promise.resolve(conn.getPending?.() ?? [])).length === 0,
        `pending=${JSON.stringify(pending)} live=${JSON.stringify(counts)}`,
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('CR2 separate synthetic waiting episodes use separate request ids', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
const send = (o) => console.log(JSON.stringify(o));
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } });
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') {
      send({ id: msg.id, result: { thread: { name: 'fake' }, model: 'fake-model', modelProvider: 'fake-provider' } });
      const status = (activeFlags) => ({ method: 'thread/status/changed', params: { threadId: 'fake-thread', status: { type: 'active', activeFlags } } });
      setTimeout(() => send(status(['waitingOnApproval'])), 30);
      setTimeout(() => send(status([])), 70);
      setTimeout(() => send(status(['waitingOnApproval'])), 110);
      setTimeout(() => send(status([])), 150);
    }
  }
}
`, async (rollout) => {
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      await waitFor(() => messages.filter((m) => m.type === 'permission-resolved').length === 2, 5000);
      const requests = messages.filter((m) => m.type === 'permission-request');
      const resolutions = messages.filter((m) => m.type === 'permission-resolved');
      return [
        requests.length === 2 &&
          resolutions.length === 2 &&
          requests[0].requestId !== requests[1].requestId &&
          resolutions[0].requestId === requests[0].requestId &&
          resolutions[1].requestId === requests[1].requestId &&
          resolutions.every((m) => m.decision === 'external'),
        JSON.stringify({ requests, resolutions }),
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('CR2 waiting-placeholder ids stay unique across a reconnect', async () => {
  // Canonical history keeps the first connection's resolved placeholder id
  // forever. If the second connection restarted its counter at 1, its fresh
  // waiting request would collide with that already-resolved id and clients
  // pairing by canonical id would render it as instantly settled.
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
const send = (o) => console.log(JSON.stringify(o));
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } });
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') {
      send({ id: msg.id, result: { thread: { name: 'fake' }, model: 'fake-model', modelProvider: 'fake-provider' } });
      setTimeout(() => send({ method: 'thread/status/changed', params: { threadId: 'fake-thread', status: { type: 'active', activeFlags: ['waitingOnApproval'] } } }), 30);
      setTimeout(() => send({ method: 'thread/status/changed', params: { threadId: 'fake-thread', status: { type: 'idle' } } }), 90);
    }
  }
}
`, async (rollout) => {
    const attachEpisode = async () => {
      const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
      const messages: any[] = [];
      conn.subscribe((m: any) => messages.push(m));
      try {
        await waitFor(() => messages.some((m) => m.type === 'permission-resolved'), 5000);
      } finally {
        await conn.close().catch(() => {});
      }
      return messages;
    };
    const first = await attachEpisode();
    const second = await attachEpisode();
    const request = (ms: any[]) => ms.find((m) => m.type === 'permission-request') as any;
    const resolution = (ms: any[]) => ms.find((m) => m.type === 'permission-resolved') as any;
    const firstRequest = request(first);
    const secondRequest = request(second);
    return [
      Boolean(firstRequest && secondRequest) &&
        firstRequest.requestId !== secondRequest.requestId &&
        resolution(first)?.requestId === firstRequest.requestId &&
        resolution(second)?.requestId === secondRequest.requestId,
      JSON.stringify({ first: firstRequest?.requestId, second: secondRequest?.requestId }),
    ];
  });
});

await test('CR2 native requests settle exactly once and one id cannot clear another', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
const send = (o) => console.log(JSON.stringify(o));
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } });
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') send({ id: msg.id, result: { thread: { name: 'fake' }, model: 'fake-model', modelProvider: 'fake-provider' } });
    else if (msg.method === 'turn/start') {
      send({ id: msg.id, result: { turn: { id: 'turn1' } } });
      send({ method: 'turn/started', params: { threadId: 'fake-thread', turn: { id: 'turn1' } } });
      send({ id: 41, method: 'item/commandExecution/requestApproval', params: { threadId: 'fake-thread', turnId: 'turn1', itemId: 'cmd1', command: 'x', cwd: '/tmp', availableDecisions: ['accept'] } });
      send({ id: 42, method: 'item/tool/requestUserInput', params: { threadId: 'fake-thread', turnId: 'turn1', itemId: 'tool1', questions: [{ id: 'q1', type: 'text', prompt: 'Which?' }] } });
      // External answer for the QUESTION only — must not clear the approval.
      setTimeout(() => send({ method: 'serverRequest/resolved', params: { threadId: 'fake-thread', requestId: 42 } }), 60);
    } else if (msg.id === 41 && msg.result) {
      // The app answered the approval: duplicate external settle + turn-end cleanup follow.
      send({ method: 'serverRequest/resolved', params: { threadId: 'fake-thread', requestId: 41 } });
      send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: 'turn1', status: 'completed' } } });
      send({ method: 'thread/status/changed', params: { threadId: 'fake-thread', status: { type: 'idle' } } });
    }
  }
}
`, async (rollout) => {
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      await conn.sendPrompt({ text: 'two requests' });
      await waitFor(() => messages.some((m) => m.type === 'permission-request') && messages.some((m) => m.type === 'question-request'), 5000);
      // The external question answer settles ONLY the question.
      await waitFor(() => messages.some((m) => m.type === 'question-resolved'), 5000);
      const pendingAfterQuestion = await Promise.resolve(conn.getPending?.() ?? []);
      const approvalStillPending = pendingAfterQuestion.some((m: any) => m.type === 'permission-request');
      const perm = messages.find((m) => m.type === 'permission-request');
      await conn.respondPermission(perm.requestId, 'approve');
      await waitFor(() => messages.some((m) => m.type === 'status' && m.status === 'idle'), 5000);
      // Duplicate answers after settling must be no-ops.
      await conn.respondPermission(perm.requestId, 'reject');
      const counts = requestCounts(messages);
      const pendingAtEnd = await Promise.resolve(conn.getPending?.() ?? []);
      return [
        approvalStillPending &&
          counts.permReq === 1 && counts.qReq === 1 &&
          counts.permRes === 1 && counts.qRes === 1 &&
          messages.find((m) => m.type === 'permission-resolved')?.decision === 'approve' &&
          pendingAtEnd.length === 0,
        `approvalStillPending=${approvalStillPending} ${JSON.stringify(counts)} pendingAtEnd=${pendingAtEnd.length}`,
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('CR2 turn-end cleanup settles unanswered native requests once despite duplicate terminal evidence', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
const send = (o) => console.log(JSON.stringify(o));
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } });
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') send({ id: msg.id, result: { thread: { name: 'fake' }, model: 'fake-model', modelProvider: 'fake-provider' } });
    else if (msg.method === 'turn/start') {
      send({ id: msg.id, result: { turn: { id: 'turn-cleanup' } } });
      send({ method: 'turn/started', params: { threadId: 'fake-thread', turn: { id: 'turn-cleanup' } } });
      send({ id: 51, method: 'item/commandExecution/requestApproval', params: { threadId: 'fake-thread', turnId: 'turn-cleanup', itemId: 'cmd-cleanup', command: 'x', cwd: '/tmp', availableDecisions: ['accept'] } });
      send({ id: 52, method: 'item/tool/requestUserInput', params: { threadId: 'fake-thread', turnId: 'turn-cleanup', itemId: 'tool-cleanup', questions: [{ id: 'q-cleanup', type: 'text', prompt: 'Which?' }] } });
      setTimeout(() => {
        send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: 'turn-cleanup', status: 'completed' } } });
        send({ method: 'thread/status/changed', params: { threadId: 'fake-thread', status: { type: 'idle' } } });
        send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: 'turn-cleanup', status: 'completed' } } });
        send({ method: 'serverRequest/resolved', params: { threadId: 'fake-thread', requestId: 51 } });
        send({ method: 'serverRequest/resolved', params: { threadId: 'fake-thread', requestId: 52 } });
        send({ method: 'item/completed', params: { turnId: 'turn-cleanup', item: { type: 'agentMessage', id: 'cleanup-marker', text: 'CLEANED' } } });
      }, 80);
    }
  }
}
`, async (rollout) => {
    const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
    const messages: any[] = [];
    conn.subscribe((m: any) => messages.push(m));
    try {
      await conn.sendPrompt({ text: 'cleanup requests' });
      await waitFor(() => messages.some((m) => m.type === 'permission-request') && messages.some((m) => m.type === 'question-request'), 5000);
      await waitFor(() => messages.some((m) => m.type === 'model-output' && m.text === 'CLEANED'), 5000);
      const counts = requestCounts(messages);
      const pending = await Promise.resolve(conn.getPending?.() ?? []);
      return [
        counts.permReq === 1 && counts.qReq === 1 &&
          counts.permRes === 1 && counts.qRes === 1 &&
          messages.find((m) => m.type === 'permission-resolved')?.decision === 'external' &&
          pending.length === 0,
        `${JSON.stringify(counts)} pending=${pending.length}`,
      ];
    } finally {
      await conn.close().catch(() => {});
    }
  });
});

await test('CR2 a reconnect replays no fresh resolutions for requests settled on the old owner', async () => {
  return await withFakeCodex(`#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
let resumes = 0;
const send = (o) => console.log(JSON.stringify(o));
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } });
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') {
      resumes++;
      send({ id: msg.id, result: { thread: { name: 'fake', status: { type: 'idle' } }, model: 'fake-model', modelProvider: 'fake-provider' } });
      // The fresh owner immediately re-settles: idle + a stale completion replay.
      setTimeout(() => send({ method: 'thread/status/changed', params: { threadId: 'fake-thread', status: { type: 'idle' } } }), 20);
      setTimeout(() => send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: 'old-turn', status: 'completed' } } }), 40);
      setTimeout(() => send({ method: 'item/completed', params: { turnId: 'replay', item: { type: 'agentMessage', id: 'replay-marker', text: 'REPLAYED:' + resumes } } }), 60);
    }
  }
}
`, async (rollout) => {
    const id = Buffer.from(rollout, 'utf8').toString('base64url');
    const first = await new CodexAdapter().attach(id, 'resume');
    await first.close().catch(() => {});
    const second = await new CodexAdapter().attach(id, 'resume');
    const messages: any[] = [];
    second.subscribe((m: any) => messages.push(m));
    try {
      await waitFor(() => messages.some((m) => m.type === 'model-output' && String(m.text ?? '').startsWith('REPLAYED:')), 5000);
      const counts = requestCounts(messages);
      return [
        counts.permRes === 0 && counts.qRes === 0 && counts.permReq === 0 && counts.qReq === 0,
        JSON.stringify(counts),
      ];
    } finally {
      await second.close().catch(() => {});
    }
  });
});

// ── CR1: reason-tagged Drive attach arbitration (presence fail-closed) ──────────────────────────

/** Minimal resume-capable fake: initialize/loaded-list/settings/resume only. */
const RESUME_ONLY_FAKE = `#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
const send = (o) => console.log(JSON.stringify(o));
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/loaded/list') send({ id: msg.id, result: { data: [], nextCursor: null } });
    else if (msg.method === 'thread/settings/update') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') send({ id: msg.id, result: { thread: { name: 'fake' }, model: 'fake-model', modelProvider: 'fake-provider' } });
  }
}
`;

function fakeTuiScan(over: Record<string, unknown> = {}): any {
  return {
    attributed: new Set<string>(),
    unattributed: [],
    privateUnattributed: [],
    unknownUnattributed: [],
    privateThreadIds: new Set<string>(),
    unknownThreadIds: new Set<string>(),
    candidates: [],
    socketDiagAvailable: true,
    processScanAvailable: true,
    ...over,
  };
}

/**
 * A socket path this run owns.
 *
 * The name used to be a fixed `/tmp/cosyncing-fake-codex.sock`, which two
 * concurrent runs would have shared — the one thing keeping this suite out of
 * the parallel group. Nothing binds it; the tests only need a path that
 * belongs to nobody else.
 */
const FAKE_SOCK_DIR = mkdtempSync(join(tmpdir(), 'cosyncing-fake-codex-'));
const FAKE_SOCK = join(FAKE_SOCK_DIR, 'app-server.sock');
// Module-level, so it outlives every case that uses it and is removed once, on
// the way out. Leaving it behind would trade a fixed name for a slow leak.
process.on('exit', () => {
  rmSync(FAKE_SOCK_DIR, { recursive: true, force: true });
});

async function withFakeSock<T>(fn: () => Promise<T>): Promise<T> {
  const oldSock = process.env.COSYNCING_CODEX_APP_SERVER_SOCK;
  process.env.COSYNCING_CODEX_APP_SERVER_SOCK = FAKE_SOCK;
  try {
    return await fn();
  } finally {
    if (oldSock == null) delete process.env.COSYNCING_CODEX_APP_SERVER_SOCK;
    else process.env.COSYNCING_CODEX_APP_SERVER_SOCK = oldSock;
  }
}

await test('CR1 restore reason with proven-absent terminal presence starts the Resume owner', async () => {
  return await withFakeCodex(RESUME_ONLY_FAKE, async (rollout) => {
    return await withFakeSock(async () => {
      const freshFlags: boolean[] = [];
      const adapter = new CodexAdapter({
        scanCodexTuiPresence: async (_sock, fresh) => {
          freshFlags.push(fresh === true);
          return fakeTuiScan();
        },
      });
      const conn = await adapter.attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume', { reason: 'app-restore' });
      try {
        return [
          conn.info.attachMode === 'resume' &&
            conn.info.control?.drive.state === 'driving' &&
          conn.info.control?.drive.supported === true &&
            freshFlags.includes(true),
          `attach=${conn.info.attachMode} drive=${conn.info.control?.drive.state} fresh=${freshFlags.join(',')}`,
        ];
      } finally {
        await conn.close().catch(() => {});
      }
    });
  });
});

await test('CR1 restore reason fails closed on shared, private, and unknown terminal presence', async () => {
  return await withFakeCodex(RESUME_ONLY_FAKE, async (rollout) => {
    return await withFakeSock(async () => {
      const id = Buffer.from(rollout, 'utf8').toString('base64url');
      const outcomes: string[] = [];
      const attempt = async (adapter: CodexAdapter, reason: 'app-restore' | 'lease-restore') => {
        try {
          const conn = await adapter.attach(id, 'resume', { reason });
          await conn.close().catch(() => {});
          outcomes.push('attached');
        } catch (err) {
          outcomes.push(isOwnershipConflictError(err) ? `conflict:${err.conflict}` : `error:${String(err)}`);
        }
      };
      await attempt(new CodexAdapter({
        scanCodexTuiPresence: async () => fakeTuiScan({ attributed: new Set(['fake-thread']) }),
      }), 'app-restore');
      await attempt(new CodexAdapter({
        scanCodexTuiPresence: async () => fakeTuiScan({ privateThreadIds: new Set(['fake-thread']) }),
      }), 'app-restore');
      await attempt(new CodexAdapter({
        scanCodexTuiPresence: async () => fakeTuiScan({ unknownThreadIds: new Set(['fake-thread']) }),
      }), 'lease-restore');
      // No /proc evidence at all is "cannot prove absence" → also fails closed.
      await attempt(new CodexAdapter({
        scanCodexTuiPresence: async () => fakeTuiScan({ processScanAvailable: false }),
      }), 'app-restore');
      return [
        outcomes[0] === 'conflict:terminal-shared' &&
          outcomes[1] === 'conflict:terminal-private' &&
          outcomes[2] === 'conflict:terminal-unknown' &&
          outcomes[3] === 'conflict:terminal-unknown',
        outcomes.join(' | '),
      ];
    });
  });
});

await test('CR1 explicit takeover keeps the established policy despite private presence', async () => {
  return await withFakeCodex(RESUME_ONLY_FAKE, async (rollout) => {
    return await withFakeSock(async () => {
      const adapter = new CodexAdapter({
        scanCodexTuiPresence: async () => fakeTuiScan({ privateThreadIds: new Set(['fake-thread']) }),
      });
      const conn = await adapter.attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume', { reason: 'takeover' });
      try {
        return [
          conn.info.control?.drive.state === 'driving',
          `drive=${conn.info.control?.drive.state}`,
        ];
      } finally {
        await conn.close().catch(() => {});
      }
    });
  });
});

await test('CR1 daemon-loaded thread rejects resume as a typed ownership conflict (mode-only message unchanged)', async () => {
  return await withFakeCodex(RESUME_ONLY_FAKE, async (rollout) => {
    return await withFakeSock(async () => {
      const oldSync = process.env.COSYNCING_CODEX_SYNC_SERVER;
      process.env.COSYNCING_CODEX_SYNC_SERVER = '1';
      try {
        const adapter = new CodexAdapter({
          queryLoadedThreadIds: async () => new Set(['fake-thread']),
          scanCodexTuiPresence: async () => fakeTuiScan({ attributed: new Set(['fake-thread']) }),
        });
        const id = Buffer.from(rollout, 'utf8').toString('base64url');
        const outcomes: string[] = [];
        for (const opts of [undefined, { reason: 'app-restore' as const }]) {
          try {
            const conn = await adapter.attach(id, 'resume', opts);
            await conn.close().catch(() => {});
            outcomes.push('attached');
          } catch (err) {
            outcomes.push(
              isOwnershipConflictError(err) && String((err as Error).message).includes('already using true terminal sync')
                ? `conflict:${err.conflict}`
                : `error:${String(err)}`,
            );
          }
        }
        return [
          outcomes[0] === 'conflict:terminal-sync-active' && outcomes[1] === 'conflict:terminal-sync-active',
          outcomes.join(' | '),
        ];
      } finally {
        if (oldSync == null) delete process.env.COSYNCING_CODEX_SYNC_SERVER;
        else process.env.COSYNCING_CODEX_SYNC_SERVER = oldSync;
      }
    });
  });
});

// ── CR4: agent-owned threads offer no Terminal Sync; NORMAL parents are untouched ────────────────
// Both halves run against ONE fake app-server daemon that reports BOTH threads loaded. Being loaded
// is precisely the state that makes a mode-less attach the mutable daemon-proxy owner, so the parent
// case is the live control for the child case: if a future widening of `codexAgentOwned` caught
// parents, the parent test below would fail rather than silently disabling Drive for everyone.

/** Minimal `codex app-server` daemon: WebSocket over a Unix socket, initialize/loaded-list/resume. */
class FakeDaemonClient {
  private buffer = Buffer.alloc(0);
  private handshake = Buffer.alloc(0);
  private ready = false;

  constructor(
    private readonly socket: Socket,
    private readonly onMessage: (msg: any) => void,
    onClose: () => void,
  ) {
    socket.on('data', (chunk) => this.consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.on('close', onClose);
    socket.on('error', onClose);
  }

  send(obj: unknown): void {
    if (this.socket.destroyed) return;
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    const len = payload.length;
    const header = len < 126
      ? Buffer.from([0x81, len])
      : Buffer.concat([Buffer.from([0x81, 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(len); return b; })()]);
    this.socket.write(Buffer.concat([header, payload]));
  }

  close(): void {
    this.socket.destroy();
  }

  private consume(chunk: Buffer): void {
    if (!this.ready) {
      this.handshake = Buffer.concat([this.handshake, chunk]);
      const idx = this.handshake.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const header = this.handshake.subarray(0, idx).toString('utf8');
      const key = /^Sec-WebSocket-Key:\s*(.+)$/im.exec(header)?.[1]?.trim();
      if (!key) {
        this.socket.destroy();
        return;
      }
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      this.socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
      this.ready = true;
      const rest = this.handshake.subarray(idx + 4);
      if (rest.length) this.consume(rest);
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const opcode = this.buffer[0]! & 0x0f;
      const masked = Boolean(this.buffer[1]! & 0x80);
      let len = this.buffer[1]! & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buffer.length < off + 2) return;
        len = this.buffer.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (this.buffer.length < off + 8) return;
        len = Number(this.buffer.readBigUInt64BE(off));
        off += 8;
      }
      const mask = masked ? this.buffer.subarray(off, off + 4) : undefined;
      if (masked) off += 4;
      if (this.buffer.length < off + len) return;
      const raw = Buffer.from(this.buffer.subarray(off, off + len));
      if (mask) for (let i = 0; i < raw.length; i++) raw[i] = raw[i]! ^ mask[i % 4]!;
      this.buffer = this.buffer.subarray(off + len);
      if (opcode === 0x8) {
        this.socket.destroy();
        return;
      }
      if (opcode !== 0x1) continue;
      try {
        this.onMessage(JSON.parse(raw.toString('utf8')));
      } catch {
        /* skip malformed */
      }
    }
  }
}

class FakeCodexDaemon {
  private server: Server | undefined;
  private clients = new Set<FakeDaemonClient>();

  constructor(private readonly socketPath: string, private readonly loadedThreadIds: string[]) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        const client: FakeDaemonClient = new FakeDaemonClient(socket, (msg) => this.handle(client, msg), () => this.clients.delete(client));
        this.clients.add(client);
      });
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => resolve());
    });
  }

  stop(): Promise<void> {
    for (const client of this.clients) client.close();
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  private handle(client: FakeDaemonClient, msg: any): void {
    if (!msg?.method) return;
    switch (msg.method) {
      case 'initialize':
        client.send({ id: msg.id, result: { userAgent: 'codex-fake/0.0.0' } });
        return;
      case 'thread/loaded/list':
        client.send({ id: msg.id, result: { data: this.loadedThreadIds, nextCursor: null } });
        return;
      case 'thread/resume':
        client.send({ id: msg.id, result: { thread: { id: String(msg.params?.threadId ?? ''), name: 'fake daemon thread' }, model: 'fake-model', modelProvider: 'fake-provider' } });
        return;
      default:
        if (msg.id != null) client.send({ id: msg.id, result: {} });
        return;
    }
  }
}

/** Runs `fn` with a live fake daemon socket + sync-server mode on, then restores the environment. */
async function withLoadedDaemon<T>(dir: string, loaded: string[], fn: () => Promise<T>): Promise<T> {
  const sock = join(dir, 'app-server-control.sock');
  const daemon = new FakeCodexDaemon(sock, loaded);
  await daemon.start();
  const oldSock = process.env.COSYNCING_CODEX_APP_SERVER_SOCK;
  const oldSync = process.env.COSYNCING_CODEX_SYNC_SERVER;
  process.env.COSYNCING_CODEX_APP_SERVER_SOCK = sock;
  process.env.COSYNCING_CODEX_SYNC_SERVER = '1';
  try {
    return await fn();
  } finally {
    if (oldSock == null) delete process.env.COSYNCING_CODEX_APP_SERVER_SOCK;
    else process.env.COSYNCING_CODEX_APP_SERVER_SOCK = oldSock;
    if (oldSync == null) delete process.env.COSYNCING_CODEX_SYNC_SERVER;
    else process.env.COSYNCING_CODEX_SYNC_SERVER = oldSync;
    await daemon.stop();
  }
}

const CR4_CHILD_THREAD = '00000000-0000-4000-8000-0000000000c4';

/** Writes a subagent (agent-owned) child rollout next to the harness's normal one. */
function writeChildRollout(dir: string): string {
  const path = join(dir, `rollout-2026-07-25T00-00-00-${CR4_CHILD_THREAD}.jsonl`);
  writeFileSync(
    path,
    JSON.stringify({
      type: 'session_meta',
      payload: { id: CR4_CHILD_THREAD, cwd: dir, thread_source: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: 'fake-thread', depth: 1 } } } },
    }) + String.fromCharCode(10),
  );
  return path;
}

await test('CR4 a mode-less attach on a daemon-loaded NORMAL thread still comes back live and driving', async () => {
  return await withFakeCodex(RESUME_ONLY_FAKE, async (rollout, dir) => {
    return await withLoadedDaemon(dir, ['fake-thread'], async () => {
      const adapter = new CodexAdapter({
        queryLoadedThreadIds: async () => new Set(['fake-thread']),
        scanCodexTuiPresence: async () => fakeTuiScan(),
      });
      const conn = await adapter.attach(Buffer.from(rollout, 'utf8').toString('base64url'));
      try {
        const sync = conn.info.control?.terminalSync;
        return [
          conn.info.attachMode === 'live' &&
            conn.info.control?.drive.supported === true &&
            conn.info.control?.drive.state === 'driving' &&
            sync?.supported === true &&
            sync.syncAvailable === true,
          `attachMode=${conn.info.attachMode} drive=${JSON.stringify(conn.info.control?.drive)} sync=${JSON.stringify(sync)}`,
        ];
      } finally {
        await conn.close().catch(() => {});
      }
    });
  });
});

await test('CR4 an agent-owned thread loaded in the SAME daemon offers neither Drive nor Terminal Sync', async () => {
  return await withFakeCodex(RESUME_ONLY_FAKE, async (_rollout, dir) => {
    const childPath = writeChildRollout(dir);
    return await withLoadedDaemon(dir, ['fake-thread', CR4_CHILD_THREAD], async () => {
      const adapter = new CodexAdapter({
        queryLoadedThreadIds: async () => new Set(['fake-thread', CR4_CHILD_THREAD]),
        scanCodexTuiPresence: async () => fakeTuiScan(),
      });
      const conn = await adapter.attach(Buffer.from(childPath, 'utf8').toString('base64url'));
      try {
        const sync = conn.info.control?.terminalSync;
        return [
          conn.info.attachMode === 'observe' &&
            conn.info.control?.drive.supported === false &&
            sync?.supported === false &&
            sync.syncAvailable === false &&
            sync.active === false &&
            sync.action === undefined &&
            sync.command === undefined &&
            sync.label === undefined &&
            /owned by the agent that spawned it/.test(sync.reason ?? '') &&
            conn.info.terminalSyncHint === undefined,
          `attachMode=${conn.info.attachMode} drive=${JSON.stringify(conn.info.control?.drive)} sync=${JSON.stringify(sync)} hint=${JSON.stringify(conn.info.terminalSyncHint)}`,
        ];
      } finally {
        await conn.close().catch(() => {});
      }
    });
  });
});

const passed = results.filter((r) => r.kind === 'pass').length;
const failed = results.filter((r) => r.kind === 'fail').length;
const skipped = results.filter((r) => r.kind === 'skip').length;
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
