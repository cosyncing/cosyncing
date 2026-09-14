import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLINE_VERIFIED_VERSION } from '../../src/store.ts';

export interface FakeClineAcp {
  root: string;
  dataRoot: string;
  cwd: string;
  sessionId: string;
  path: string;
  env: NodeJS.ProcessEnv;
  ledger(): any[];
  killLatestAcp(): void;
  appendForeignPrompt(text: string): void;
  cleanup(): void;
}

export function buildFakeClineAcp(options: {
  agentName?: string;
  dropConfigValue?: string;
  emptyPrompt?: boolean;
  unrelatedDurableResponse?: boolean;
  rewriteOnPrompt?: boolean;
  replayPermission?: boolean;
  hangRenameTitle?: string;
} = {}): FakeClineAcp {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-cline-acp-'));
  const dataRoot = join(root, 'data');
  const cwd = join(root, 'workspace');
  const sessionId = '1788091200000_acp01';
  const path = join(root, 'cline-fixture.mjs');
  const ledgerPath = join(root, 'ledger.jsonl');
  const configPath = join(root, 'config.json');
  const messagesPath = join(dataRoot, 'sessions', sessionId, `${sessionId}.messages.json`);
  Bun.spawnSync(['mkdir', '-p', cwd, dataRoot]);
  writeFileSync(configPath, JSON.stringify({
    root, dataRoot, cwd, sessionId, ledgerPath,
    agentName: options.agentName ?? 'cline',
    dropConfigValue: options.dropConfigValue,
    emptyPrompt: options.emptyPrompt === true,
    unrelatedDurableResponse: options.unrelatedDurableResponse === true,
    rewriteOnPrompt: options.rewriteOnPrompt === true,
    replayPermission: options.replayPermission === true,
    hangRenameTitle: options.hangRenameTitle,
  }));
  writeFileSync(path, `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const config = JSON.parse(readFileSync(process.env.FAKE_CLINE_CONFIG, 'utf8'));
const record = (value) => appendFileSync(config.ledgerPath, JSON.stringify(value) + '\\n');
if (process.argv.includes('--version')) {
  record({ kind: 'version-probe', noAutoUpdate: process.env.CLINE_NO_AUTO_UPDATE });
  process.stdout.write('${CLINE_VERIFIED_VERSION}\\n');
  process.exit(0);
}
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
record({
  kind: 'spawn',
  pid: process.pid,
  argv: process.argv.slice(2),
  noAutoUpdate: process.env.CLINE_NO_AUTO_UPDATE,
  dataRoot: process.env.CLINE_DATA_DIR,
  sessionDataRoot: process.env.CLINE_SESSION_DATA_DIR,
});
if (process.argv[2] === 'history' && process.argv[3] === 'update') {
  const sessionIndex = process.argv.indexOf('--session-id');
  const titleIndex = process.argv.indexOf('--title');
  const historyDataRoot = process.env.FAKE_CLINE_MANAGED_DATA_ROOT || config.dataRoot;
  const historySessionId = process.env.FAKE_CLINE_MANAGED_SESSION_ID || config.sessionId;
  if (process.env.CLINE_DATA_DIR !== historyDataRoot
    || process.env.CLINE_SESSION_DATA_DIR !== join(historyDataRoot, 'sessions')
    || process.argv.includes('--data-dir')
    || process.argv[sessionIndex + 1] !== historySessionId
    || titleIndex < 0) process.exit(2);
  if (process.env.FAKE_CLINE_RENAME_BEHAVIOR === 'fail') process.exit(3);
  if (process.env.FAKE_CLINE_RENAME_BEHAVIOR === 'lie') process.exit(0);
  if (process.env.FAKE_CLINE_RENAME_GATE && process.env.FAKE_CLINE_RENAME_RELEASE) {
    writeFileSync(process.env.FAKE_CLINE_RENAME_GATE, 'received');
    while (!existsSync(process.env.FAKE_CLINE_RENAME_RELEASE)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  if (process.argv[titleIndex + 1] === config.hangRenameTitle) {
    process.on('SIGTERM', () => record({ kind: 'rename-sigterm' }));
    setInterval(() => {}, 60_000);
  } else {
    const renameMetadataPath = join(historyDataRoot, 'sessions', historySessionId, historySessionId + '.json');
    const metadata = JSON.parse(readFileSync(renameMetadataPath, 'utf8'));
    metadata.metadata = { ...(metadata.metadata || {}), title: process.argv[titleIndex + 1] };
    writeFileSync(renameMetadataPath, JSON.stringify(metadata) + '\\n');
    process.exit(0);
  }
}
let buffer = '';
let messages = [];
let pendingPermission;
let permissionCounter = 0;
let currentModel = 'gpt-4o';
let currentMode = 'act';
let autoApprove = false;
const configOptions = () => [
  { type: 'select', id: 'model', name: 'Model', currentValue: currentModel, options: [{ value: 'gpt-4o', name: 'gpt-4o' }] },
  { type: 'select', id: 'mode', name: 'Mode', currentValue: currentMode, options: [{ value: 'act', name: 'Act' }, { value: 'plan', name: 'Plan' }] },
  { type: 'boolean', id: 'auto_approve', name: 'Auto approve', currentValue: autoApprove },
];
const sessionDir = join(config.dataRoot, 'sessions', config.sessionId);
const metadataPath = join(sessionDir, config.sessionId + '.json');
const messagesPath = join(sessionDir, config.sessionId + '.messages.json');
const persist = () => {
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(metadataPath, JSON.stringify({
    session_id: config.sessionId,
    cwd: config.cwd,
    provider: 'openai-compatible',
    model: 'fixture/model',
    started_at: '2026-08-30T12:00:00.000Z',
    status: 'idle',
    metadata: { title: 'Cline ACP fixture', mode: currentMode, autoApproveTools: autoApprove },
  }) + '\\n');
  writeFileSync(messagesPath, JSON.stringify({
    version: 1,
    agent: 'lead',
    sessionId: config.sessionId,
    origin: { source: 'cli', mode: 'user', sessionId: config.sessionId, version: '3.0.60' },
    updated_at: new Date().toISOString(),
    messages,
  }) + '\\n');
};
const handle = (frame) => {
  record({ kind: 'frame', frame });
  if (frame.method === undefined) {
    if (frame.id === pendingPermission?.id) {
      const finish = pendingPermission.finish;
      pendingPermission = undefined;
      finish(frame.result);
    }
    return;
  }
  if (frame.method === 'initialize') return send({ jsonrpc: '2.0', id: frame.id, result: {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
    agentInfo: { name: config.agentName, version: '${CLINE_VERIFIED_VERSION}' },
    authMethods: [{ id: 'fixture-auth', name: 'Fixture auth' }],
  } });
  if (frame.method === 'authenticate') return send({ jsonrpc: '2.0', id: frame.id, result: {} });
  if (frame.method === 'session/new') {
    return send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: config.sessionId, configOptions: configOptions() } });
  }
  if (frame.method === 'session/set_config_option') {
    if (frame.params.configId === 'model') currentModel = frame.params.value;
    if (frame.params.configId === 'mode') currentMode = frame.params.value;
    if (frame.params.configId === 'auto_approve') autoApprove = frame.params.value;
    if (frame.params.value === config.dropConfigValue) return;
    return send({ jsonrpc: '2.0', id: frame.id, result: { configOptions: configOptions() } });
  }
  if (frame.method === 'session/load') return send({ jsonrpc: '2.0', id: frame.id, result: {} });
  if (frame.method === 'session/close') return send({ jsonrpc: '2.0', id: frame.id, result: {} });
  if (frame.method === 'session/prompt') {
    const text = frame.params.prompt[0].text;
    if (text === 'fail prompt') {
      return send({ jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: 'fixture delivery failed' } });
    }
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: config.sessionId, update: {
      sessionUpdate: 'user_message_chunk', content: { type: 'text', text },
    } } });
    if (config.emptyPrompt || config.unrelatedDurableResponse) {
      messages.push({ id: 'user-' + messages.length, role: 'user', content: [{ type: 'text', text: '<user_input mode="act">' + text + '</user_input>' }] });
      if (config.unrelatedDurableResponse) {
        messages.push({ id: 'unrelated-' + messages.length, role: 'assistant', content: [{ type: 'text', text: 'late unrelated response' }] });
      }
      persist();
      return send({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } });
    }
    let permissionId = '';
    const replayPermission = () => {
      if (!config.replayPermission) return;
      setTimeout(() => send({
        jsonrpc: '2.0', id: permissionId, method: 'session/request_permission', params: {
          sessionId: config.sessionId,
          toolCall: { toolCallId: permissionId, title: 'Replayed fixture tool' },
          options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }],
        },
      }), 5);
    };
    const finish = (permissionResult) => {
      if (permissionResult?.outcome?.outcome !== 'selected') {
        send({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'cancelled' } });
        replayPermission();
        return;
      }
      const rewriteExisting = messages.length > 0;
      messages.push({ id: 'user-' + messages.length, role: 'user', content: [{ type: 'text', text: '<user_input mode="act">' + text + '</user_input>' }] });
      messages.push({ id: 'assistant-' + messages.length, role: 'assistant', content: [{
        type: 'tool_use', id: 'tool-1', name: 'Fixture tool', input: { path: 'fixture.txt' },
      }] });
      messages.push({ id: 'tool-result-' + messages.length, role: 'user', content: [{
        type: 'tool_result', tool_use_id: 'tool-1', name: 'Fixture tool', content: { ok: true },
      }] });
      messages.push({ id: 'assistant-' + messages.length, role: 'assistant', content: [
        { type: 'text', text: 'fixture ' },
        { type: 'text', text: 'answer' },
      ] });
      if (config.rewriteOnPrompt && rewriteExisting) {
        messages = messages.map((message, index) => ({ ...message, id: 'rewritten-' + index + '-' + message.id }));
      }
      persist();
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: config.sessionId, update: {
        sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Fixture tool', rawInput: { path: 'fixture.txt' },
      } } });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: config.sessionId, update: {
        sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', title: 'Fixture tool', status: 'completed', rawOutput: { ok: true },
      } } });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: config.sessionId, update: {
        sessionUpdate: 'usage_update', cost: { amount: 0.125, currency: 'USD' }, used: 100, size: 4096,
      } } });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: config.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fixture answer' } } } });
      send({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } });
      replayPermission();
    };
    permissionId = 'permission-' + (++permissionCounter);
    pendingPermission = { id: permissionId, finish };
    return send({ jsonrpc: '2.0', id: permissionId, method: 'session/request_permission', params: {
      sessionId: config.sessionId,
      toolCall: { toolCallId: permissionId, title: 'Run fixture tool' },
      options: [
        { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
        { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
      ],
    } });
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
const keepAlive = setInterval(() => {}, 60_000);
process.stdin.resume();
`);
  chmodSync(path, 0o755);
  return {
    root,
    dataRoot,
    cwd,
    sessionId,
    path,
    env: {
      ...process.env,
      CLINE_DIR: root,
      CLINE_DATA_DIR: dataRoot,
      CLINE_SESSION_DATA_DIR: join(root, 'conflicting-session-store'),
      FAKE_CLINE_CONFIG: configPath,
    },
    ledger: () => {
      try { return readFileSync(ledgerPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
      catch { return []; }
    },
    killLatestAcp: () => {
      const spawns = readFileSync(ledgerPath, 'utf8').trim().split('\n').filter(Boolean)
        .map((line) => JSON.parse(line)).filter((entry) => entry.kind === 'spawn');
      const pid = spawns.at(-1)?.pid;
      if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, 'SIGTERM');
    },
    appendForeignPrompt: (text: string) => {
      const document = JSON.parse(readFileSync(messagesPath, 'utf8'));
      document.messages.push({
        id: `foreign-${document.messages.length}`,
        role: 'user',
        content: [{ type: 'text', text: `<user_input mode="act">${text}</user_input>` }],
      });
      document.updated_at = new Date().toISOString();
      writeFileSync(messagesPath, `${JSON.stringify(document)}\n`);
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
