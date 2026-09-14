import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GrokUpdateRecord } from '../../src/mapping.ts';

export const GROK_FIXTURE_ID = '019f9d70-e38e-7591-9a24-74a06ad89476';

function update(
  line: number,
  sessionUpdate: string,
  value: Record<string, unknown>,
  method = 'session/update',
): GrokUpdateRecord {
  return {
    timestamp: `2026-08-23T10:00:${String(line).padStart(2, '0')}.000Z`,
    method,
    params: {
      sessionId: GROK_FIXTURE_ID,
      _meta: { eventId: `event-${line}`, promptId: 'prompt-1', agentTimestampMs: 1_787_479_200_000 + line },
      update: { sessionUpdate, ...value },
    },
  };
}

export function fixtureUpdates(): GrokUpdateRecord[] {
  return [
    update(1, 'user_message_chunk', { content: { type: 'text', text: 'fixture prompt' }, _meta: { modelId: 'grok-4.6', promptIndex: 0 } }),
    update(2, 'agent_thought_chunk', { content: { type: 'text', text: 'fixture thought' } }),
    update(3, 'agent_message_chunk', { content: { type: 'text', text: 'fixture answer' } }),
    update(4, 'tool_call', {
      toolCallId: 'call-1',
      title: 'Read fixture',
      rawInput: { path: 'README.md' },
      _meta: { 'x.ai/tool': { name: 'read_file', kind: 'read', label: 'Read file', read_only: true } },
    }),
    update(5, 'tool_call_update', {
      toolCallId: 'call-1',
      title: 'Read fixture',
      status: 'completed',
      rawOutput: 'fixture output',
      _meta: { 'x.ai/tool': { name: 'read_file', kind: 'read', label: 'Read file', read_only: true } },
    }),
    update(6, 'retry_state', { type: 'retrying', attempt: 1, max_retries: 3, reason: 'temporary fixture error' }, '_x.ai/session/update'),
    update(7, 'task_backgrounded', { task_id: 'task-1', description: 'Fixture task', command: 'fixture' }, '_x.ai/session/update'),
    update(8, 'task_completed', {
      task_snapshot: [{ id: 'task-1', title: 'Fixture task', status: 'completed' }],
      will_wake: false,
    }, '_x.ai/session/update'),
    update(9, 'turn_completed', {
      prompt_id: 'prompt-1',
      stop_reason: 'end_turn',
      usage: { input_tokens: 11, output_tokens: 4 },
    }, '_x.ai/session/update'),
  ];
}

export interface GrokFixtureTree {
  root: string;
  cwd: string;
  id: string;
  sessionDir: string;
  summaryPath: string;
  updatesPath: string;
  signalsPath: string;
  rows: GrokUpdateRecord[];
  writeRows(rows: GrokUpdateRecord[]): void;
  append(row: GrokUpdateRecord): void;
  cleanup(): void;
}

export function buildGrokFixtureTree(): GrokFixtureTree {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-grok-tree-'));
  const cwd = join(root, 'workspace');
  const id = GROK_FIXTURE_ID;
  const sessionDir = join(root, 'sessions', encodeURIComponent(cwd), id);
  const summaryPath = join(sessionDir, 'summary.json');
  const updatesPath = join(sessionDir, 'updates.jsonl');
  const signalsPath = join(sessionDir, 'signals.json');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const rows = fixtureUpdates();
  const tree: GrokFixtureTree = {
    root,
    cwd,
    id,
    sessionDir,
    summaryPath,
    updatesPath,
    signalsPath,
    rows,
    writeRows(nextRows) {
      rows.splice(0, rows.length, ...nextRows);
      writeFileSync(updatesPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
      writeFileSync(summaryPath, `${JSON.stringify({
        info: { id, cwd },
        session_kind: 'headless',
        session_summary: 'Grok fixture',
        generated_title: 'Generated fixture',
        created_at: '2026-08-23T10:00:00.000Z',
        updated_at: '2026-08-23T10:00:09.000Z',
        last_active_at: '2026-08-23T10:00:09.000Z',
        num_messages: rows.length,
        current_model_id: 'grok-4.6',
        agent_name: 'build',
        reasoning_effort: 'high',
        sandbox_profile: 'workspace-write',
      })}\n`);
      writeFileSync(signalsPath, `${JSON.stringify({
        turnCount: 1,
        contextTokensUsed: 15,
        contextWindowTokens: 500_000,
        modelsUsed: ['grok-4.6'],
        toolCallCount: 1,
      })}\n`);
    },
    append(row) { tree.writeRows([...rows, row]); },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
  tree.writeRows([...rows]);
  return tree;
}

export interface FakeGrokBinary {
  path: string;
  env: NodeJS.ProcessEnv;
  events(): Array<Record<string, unknown>>;
  spawnCount(): number;
  setVersion(version: string): void;
}

/** Executable ACP stub with a real scratch Grok store and process ledger. */
export function writeFakeGrokBinary(
  directory: string,
  root: string,
  version = '1.0.13',
  sessionId = GROK_FIXTURE_ID,
): FakeGrokBinary {
  mkdirSync(directory, { recursive: true });
  mkdirSync(join(root, 'sessions'), { recursive: true });
  const path = join(directory, 'grok');
  const ledger = join(directory, 'grok-ledger.jsonl');
  const configPath = join(directory, 'grok-config.json');
  writeFileSync(ledger, '');
  writeFileSync(configPath, JSON.stringify({ ledger, root, version, sessionId }));
  writeFileSync(path, `#!/usr/bin/env bun
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const config = JSON.parse(readFileSync(process.env.FAKE_GROK_CONFIG, 'utf8'));
const record = (value) => appendFileSync(config.ledger, JSON.stringify(value) + '\\n');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
// Version probes get their OWN kind, recorded before the early exit. They used
// to go unrecorded entirely, so the "every start carries the updater guard"
// assertion silently covered ACP children only -- and the version probe was the
// one grok start still handing over a bare environment. Recording them as
// 'spawn' instead would have been wrong in the other direction: several tests
// count spawns to prove exactly one ACP CHILD started, and a probe is not that.
if (process.argv.includes('--version')) {
  record({ kind: 'version-probe', argv: process.argv.slice(2), pid: process.pid, autoUpdateDisabled: process.env.GROK_DISABLE_AUTOUPDATER });
  process.stdout.write('grok ' + config.version + ' (fixture) [stable]\\n');
  process.exit(0);
}
record({ kind: 'spawn', argv: process.argv.slice(2), pid: process.pid, autoUpdateDisabled: process.env.GROK_DISABLE_AUTOUPDATER });
let buffer = '';
let promptCount = 0;
let pendingPermissionFinish;
const argValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const models = {
  currentModelId: process.env.FAKE_GROK_LOAD_MODEL_OVERRIDE || argValue('--model') || 'grok-4.6',
  currentReasoningEffort: process.env.FAKE_GROK_LOAD_EFFORT_OVERRIDE || argValue('--reasoning-effort') || 'high',
  availableModels: [
    { modelId: 'grok-4.6', name: 'Grok 4.6', _meta: { reasoningEfforts: [
      { value: 'high', label: 'High', default: true },
      { value: 'low', label: 'Low', default: false },
    ] } },
    { modelId: 'grok-4.5', name: 'Grok 4.5' },
  ],
};
const modes = {
  currentModeId: process.env.FAKE_GROK_LOAD_MODE_OVERRIDE || argValue('--permission-mode') || 'default',
};
const sessionPaths = (cwd) => {
  const dir = join(config.root, 'sessions', encodeURIComponent(cwd), config.sessionId);
  return { dir, summary: join(dir, 'summary.json'), updates: join(dir, 'updates.jsonl'), signals: join(dir, 'signals.json') };
};
const ensureSession = (cwd) => {
  const paths = sessionPaths(cwd);
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.summary, JSON.stringify({
    info: { id: config.sessionId, cwd },
    session_summary: 'Fake Grok session',
    created_at: '2026-08-30T10:00:00.000Z',
    updated_at: '2026-08-30T10:00:00.000Z',
    last_active_at: '2026-08-30T10:00:00.000Z',
    num_messages: 0,
    current_model_id: argValue('--model') || 'grok-4.6',
    reasoning_effort: process.env.FAKE_GROK_SUMMARY_EFFORT_OVERRIDE || argValue('--reasoning-effort') || 'high',
    agent_name: 'build',
  }) + '\\n');
  try { readFileSync(paths.updates); } catch { writeFileSync(paths.updates, ''); }
  writeFileSync(paths.signals, JSON.stringify({ contextTokensUsed: 0, contextWindowTokens: 500000 }) + '\\n');
  return paths;
};
const handle = (frame) => {
  record({ kind: 'frame', frame });
  if (frame.method === undefined && frame.id === 'permission-before-exit' && pendingPermissionFinish) {
    const finish = pendingPermissionFinish;
    pendingPermissionFinish = undefined;
    setTimeout(finish, 0);
    return;
  }
  if (frame.id === undefined || frame.method === undefined) return;
  if (frame.method === 'initialize') {
    send({ jsonrpc: '2.0', id: frame.id, result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
      authMethods: [
        { id: 'cached_token', name: 'cached_token' },
        { id: 'grok.com', name: 'Grok' },
      ],
      _meta: {
        agentVersion: '1.0.13',
        defaultAuthMethodId: 'cached_token',
        modelState: models,
        availableCommands: [{ name: 'compact', description: 'Compact context', input: null }],
      },
    } });
    return;
  }
  if (frame.method === 'authenticate') {
    send({ jsonrpc: '2.0', id: frame.id, result: {} });
    return;
  }
  if (frame.method === 'session/new') {
    ensureSession(frame.params.cwd);
    send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: config.sessionId } });
    return;
  }
  if (frame.method === 'session/load') {
    ensureSession(frame.params.cwd);
    send({ jsonrpc: '2.0', id: frame.id, result: { models, modes } });
    return;
  }
  if (frame.method === 'session/close') {
    send({ jsonrpc: '2.0', id: frame.id, result: {} });
    return;
  }
  if (frame.method === 'session/prompt') {
    promptCount += 1;
    const text = frame.params.prompt[0]?.text || '';
    const eventId = 'event-' + process.pid + '-' + promptCount;
    const promptId = 'prompt-' + process.pid + '-' + promptCount;
    const params = {
      sessionId: config.sessionId,
      _meta: { eventId, promptId, agentTimestampMs: Date.now() },
      update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } },
    };
    const echoDelay = Math.max(0, Math.min(2000, Number(process.env.FAKE_GROK_ECHO_DELAY_MS || 0) || 0));
    setTimeout(() => {
      send({ jsonrpc: '2.0', method: 'session/update', params });
      const paths = ensureSession(process.cwd());
      appendFileSync(paths.updates, JSON.stringify({ timestamp: new Date().toISOString(), method: 'session/update', params }) + '\\n');
      const finish = () => {
        const answerParams = {
          sessionId: config.sessionId,
          _meta: { eventId: eventId + '-answer', promptId },
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fake answer' } },
        };
        send({ jsonrpc: '2.0', method: 'session/update', params: answerParams });
        appendFileSync(paths.updates, JSON.stringify({ timestamp: new Date().toISOString(), method: 'session/update', params: answerParams }) + '\\n');
        const doneParams = {
          sessionId: config.sessionId,
          _meta: { eventId: eventId + '-done', promptId },
          update: { sessionUpdate: 'turn_completed', prompt_id: promptId, stop_reason: 'end_turn' },
        };
        const doneMethod = process.env.FAKE_GROK_DONE_METHOD || '_x.ai/session/update';
        send({ jsonrpc: '2.0', method: doneMethod, params: doneParams });
        appendFileSync(paths.updates, JSON.stringify({ timestamp: new Date().toISOString(), method: doneMethod, params: doneParams }) + '\\n');
        send({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } });
      };
      if (process.env.FAKE_GROK_PERMISSION_BEFORE_EXIT === '1' && promptCount === 1) {
        pendingPermissionFinish = finish;
        send({ jsonrpc: '2.0', id: 'permission-before-exit', method: 'session/request_permission', params: {
          sessionId: config.sessionId,
          toolCall: { toolCallId: 'permission-before-exit', title: 'Run fixture command', rawInput: { command: 'true' } },
          options: [
            { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
            { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' },
            { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
          ],
        } });
      } else {
        setTimeout(finish, 20);
      }
    }, echoDelay);
  }
};
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
`);
  chmodSync(path, 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GROK_HOME: root,
    FAKE_GROK_CONFIG: configPath,
  };
  return {
    path,
    env,
    events() {
      const text = readFileSync(ledger, 'utf8');
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    spawnCount() { return this.events().filter((event) => event.kind === 'spawn').length; },
    setVersion(nextVersion: string) {
      writeFileSync(configPath, JSON.stringify({ ledger, root, version: nextVersion, sessionId }));
    },
  };
}
