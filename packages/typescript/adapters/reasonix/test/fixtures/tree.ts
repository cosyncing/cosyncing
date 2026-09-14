import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const REASONIX_FIXTURE_ID = 'reasonix-fixture-session';

export interface ReasonixFixtureTree {
  root: string;
  cwd: string;
  id: string;
  transcriptPath: string;
  displayIndexPath: string;
  eventIndexPath: string;
  metaPath: string;
  acpMetadataPath: string;
  rows: Array<Record<string, unknown>>;
  writeRows(rows: Array<Record<string, unknown>>, revision?: number): void;
  appendUser(text: string): void;
  cleanup(): void;
}

/** A complete bounded Reasonix v1.25.2 global-store fixture. */
export function buildReasonixFixtureTree(): ReasonixFixtureTree {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-reasonix-tree-'));
  const cwd = join(root, 'workspace');
  const sessions = join(root, 'sessions');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  const id = REASONIX_FIXTURE_ID;
  const transcriptPath = join(sessions, `${id}.jsonl`);
  const displayIndexPath = join(sessions, `${id}.display-index.json`);
  const eventIndexPath = join(sessions, `${id}.event-index.json`);
  const metaPath = `${transcriptPath}.meta`;
  const acpMetadataPath = join(sessions, `${id}.acp.json`);
  let revision = 0;
  const rows: Array<Record<string, unknown>> = [
    { role: 'user', content: 'fixture prompt', raw_content: 'fixture prompt', createdAt: 1_787_824_800_000 },
    { role: 'assistant', content: 'fixture answer', reasoning_content: 'fixture thought', workDurationMs: 12 },
  ];

  const tree: ReasonixFixtureTree = {
    root,
    cwd,
    id,
    transcriptPath,
    displayIndexPath,
    eventIndexPath,
    metaPath,
    acpMetadataPath,
    rows,
    writeRows(nextRows, nextRevision = revision + 1) {
      rows.splice(0, rows.length, ...nextRows);
      revision = nextRevision;
      const lines = rows.map((row) => JSON.stringify(row));
      let offset = 0;
      const entries = lines.map((line, index) => {
        const role = typeof rows[index]?.role === 'string' ? rows[index]!.role as string : undefined;
        const entry = {
          index,
          offset,
          length: Buffer.byteLength(`${line}\n`),
          ...(role ? { role } : {}),
          authored_turn: Math.floor(index / 2),
          ...(role === 'user' ? { starts_turn: true } : {}),
        };
        offset += Buffer.byteLength(`${line}\n`);
        return entry;
      });
      const transcript = `${lines.join('\n')}\n`;
      writeFileSync(transcriptPath, transcript);
      writeFileSync(displayIndexPath, `${JSON.stringify({
        schema_version: 1,
        revision,
        revision_known: true,
        transcript_size: Buffer.byteLength(transcript),
        message_count: rows.length,
        entries,
      })}\n`);
      writeFileSync(eventIndexPath, `${JSON.stringify({
        schema_version: 1,
        revision,
        // Event-log bytes are an independent file boundary; they are not the
        // transcript append position used by replay/tail identity.
        log_size: 97 + revision,
        message_count: rows.length,
        writer_id: 'reasonix-fixture',
        content_digest: `fixture-revision-${revision}`,
      })}\n`);
      writeFileSync(metaPath, `${JSON.stringify({
        id,
        schema_version: 2,
        model: 'provider/model',
        preview: 'Reasonix fixture',
        turns: Math.ceil(rows.length / 2),
        revision,
        writer_id: 'reasonix-fixture',
        content_digest: `fixture-revision-${revision}`,
        created_at: '2026-08-27T10:00:00.000000000Z',
        updated_at: '2026-08-27T10:00:01.000000000Z',
      })}\n`);
      writeFileSync(acpMetadataPath, `${JSON.stringify({
        sessionId: id,
        cwd,
        title: 'Reasonix fixture',
        model: 'provider/model',
        status: { state: 'idle' },
      })}\n`);
    },
    appendUser(text) {
      tree.writeRows([...rows, {
        role: 'user',
        content: text,
        raw_content: text,
        createdAt: Date.now(),
      }]);
    },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
  tree.writeRows([...rows], 1);
  return tree;
}

export interface FakeReasonixBinary {
  path: string;
  env: NodeJS.ProcessEnv;
  events(): Array<Record<string, unknown>>;
  spawnCount(): number;
}

/** Executable ACP stub that records every process and inbound frame. */
export function writeFakeReasonixBinary(
  directory: string,
  sessionId = REASONIX_FIXTURE_ID,
  version = '1.25.2',
): FakeReasonixBinary {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'reasonix');
  const ledger = join(directory, 'reasonix-ledger.jsonl');
  const config = join(directory, 'reasonix-config.json');
  writeFileSync(ledger, '');
  writeFileSync(config, JSON.stringify({ ledger, sessionId, version }));
  writeFileSync(path, `#!/usr/bin/env bun
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const config = JSON.parse(readFileSync(process.env.FAKE_REASONIX_CONFIG, 'utf8'));
const record = (value) => appendFileSync(config.ledger, JSON.stringify(value) + '\\n');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
if (process.argv.includes('--version')) {
  process.stdout.write('reasonix ' + config.version + '\\n');
  process.exit(0);
}
// The shape \`listModels\` reads, modelled on the catalogue measured on the
// installed candidate: providers list bare model ID STRINGS with no display
// name anywhere, one model name appears under two providers, and each provider
// record carries key material the served catalogue must never republish.
if (process.argv[2] === 'doctor' && process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify({
    providers: [
      { name: 'vllm-hpc', api_key_env: 'FAKE_REASONIX_KEY_ENV', key_present: true,
        models: ['qwen3.8-flash-next', 'glm-5.2'] },
      { name: 'openrouter', api_key_env: 'FAKE_REASONIX_KEY_ENV', key_present: false,
        models: ['glm-5.2', 'deepseek-v4-pro', 'MiniMax-M3'] },
    ],
  }) + '\\n');
  process.exit(0);
}
record({ kind: 'spawn', argv: process.argv.slice(2), pid: process.pid });
let buffer = '';
let permissionSent = false;
let promptCount = 0;
let sessionCwd = '';
const modelArg = process.argv.indexOf('--model');
let currentModel = modelArg >= 0 ? process.argv[modelArg + 1] : 'provider/model';
let currentEffort = 'auto';
let currentMode = 'ask';
const persistMaterializedRows = (rows, revision) => {
  const sessions = join(process.env.REASONIX_HOME, 'sessions');
  mkdirSync(sessions, { recursive: true });
  const durableCwd = process.env.FAKE_REASONIX_MATERIALIZED_CWD || sessionCwd;
  const durableModel = process.env.FAKE_REASONIX_MATERIALIZED_MODEL || currentModel;
  const lines = rows.map((row) => JSON.stringify(row));
  let offset = 0;
  const entries = lines.map((line, index) => {
    const entry = {
      index,
      offset,
      length: Buffer.byteLength(line + '\\n'),
      role: rows[index].role,
      authored_turn: 0,
      ...(rows[index].role === 'user' ? { starts_turn: true } : {}),
    };
    offset += entry.length;
    return entry;
  });
  const transcript = lines.join('\\n') + '\\n';
  const base = join(sessions, config.sessionId);
  writeFileSync(base + '.jsonl', transcript);
  writeFileSync(base + '.jsonl.meta', JSON.stringify({
    id: config.sessionId,
    schema_version: 2,
    model: durableModel,
    preview: 'Created Reasonix fixture',
    turns: rows.some((row) => row.role === 'user') ? 1 : 0,
    revision,
  }) + '\\n');
  writeFileSync(base + '.acp.json', JSON.stringify({
    sessionId: config.sessionId,
    cwd: durableCwd,
    title: 'Created Reasonix fixture',
    model: durableModel,
    toolApprovalMode: currentMode,
    status: { state: 'idle' },
  }) + '\\n');
  writeFileSync(base + '.display-index.json', JSON.stringify({
    schema_version: 1,
    revision,
    revision_known: true,
    transcript_size: Buffer.byteLength(transcript),
    message_count: rows.length,
    entries,
  }) + '\\n');
  writeFileSync(base + '.event-index.json', JSON.stringify({
    schema_version: 1,
    revision,
    log_size: 0,
    message_count: rows.length,
  }) + '\\n');
};
const materialize = (text) => {
  if (process.env.FAKE_REASONIX_MATERIALIZE_ON_PROMPT !== '1') return;
  const durableText = process.env.FAKE_REASONIX_CANONICALIZE_TERMINAL_NEWLINE === '1'
    ? text.endsWith('\\r\\n') ? text.slice(0, -2)
      : text.endsWith('\\n') ? text.slice(0, -1)
        : text
    : text;
  const system = { role: 'system', content: 'created system context' };
  const complete = [
    ...(process.env.FAKE_REASONIX_SYSTEM_ON_MATERIALIZE === '1' ? [system] : []),
    { role: 'user', content: durableText, raw_content: durableText, createdAt: Date.now() },
    { role: 'assistant', content: 'created answer', reasoning_content: '', workDurationMs: 1 },
  ];
  if (process.env.FAKE_REASONIX_STAGED_MATERIALIZE === '1') {
    persistMaterializedRows([system], 1);
    const stageDelayMs = Number(process.env.FAKE_REASONIX_STAGE_DELAY_MS || 150);
    setTimeout(() => persistMaterializedRows(complete, 2), stageDelayMs);
    return;
  }
  persistMaterializedRows(complete, 1);
};
const persistConfiguredMode = () => {
  if (process.env.FAKE_REASONIX_PERSIST_CONFIG_OPTION !== '1') return;
  const path = join(process.env.REASONIX_HOME, 'sessions', config.sessionId + '.acp.json');
  try {
    const metadata = JSON.parse(readFileSync(path, 'utf8'));
    metadata.toolApprovalMode = currentMode;
    writeFileSync(path, JSON.stringify(metadata) + '\\n');
  } catch {}
};
const configOptions = () => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: currentModel, options: [
    { value: 'provider/model', name: 'Provider Model' },
    { value: 'provider/other', name: 'Provider Other' },
  ] },
  { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: currentEffort, options: [
    { value: 'auto', name: 'Auto' },
    { value: 'high', name: 'High' },
  ] },
  { id: 'tool_approval', name: 'Tool Approval', category: 'tool_approval', type: 'select', currentValue: currentMode, options: [
    { value: 'ask', name: 'Ask', description: 'Ask before permission-gated tool calls' },
    { value: 'auto', name: 'Auto', description: 'Follow configured permission rules without fallback prompts' },
    { value: 'yolo', name: 'Yolo', description: 'Approve tool calls except protected decisions' },
  ] },
];
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    record({ kind: 'frame', frame });
    if (frame.id === undefined) continue;
    if (frame.method === undefined) continue;
    if (frame.method === 'initialize') {
      if (process.env.FAKE_REASONIX_BLOCK_INITIALIZE === '1') continue;
      send({ jsonrpc: '2.0', id: frame.id, result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
        agentInfo: { name: 'reasonix-fixture', version: '1.25.2' },
      } });
    } else if (frame.method === 'session/load') {
      if (process.env.FAKE_REASONIX_BLOCK_LOAD === '1') continue;
      const finishLoad = () => {
        if (process.env.FAKE_REASONIX_COMMANDS === '1') {
          send({ jsonrpc: '2.0', method: 'session/update', params: {
            sessionId: config.sessionId,
            update: { sessionUpdate: 'available_commands_update', availableCommands: [
              { name: 'review', description: 'Review the current diff', input: { hint: '<scope>' } },
              { name: 'compact', description: 'Compact the current context', input: null },
            ] },
          } });
        }
        send({ jsonrpc: '2.0', id: frame.id, result: {
          ...(process.env.FAKE_REASONIX_MODELS === '1' ? {
            models: {
              currentModelId: currentModel,
              availableModels: [
                { modelId: 'provider/model', name: 'Provider Model' },
                { modelId: 'provider/other', name: 'Provider Other' },
              ],
            },
            configOptions: process.env.FAKE_REASONIX_LOAD_CONFIG_OPTIONS_FULL === '1'
              ? configOptions()
              : configOptions().map(({ options: _options, ...option }) => option),
          } : {}),
        } });
      };
      const loadDelayMs = Number(process.env.FAKE_REASONIX_LOAD_DELAY_MS || 0);
      if (loadDelayMs > 0) setTimeout(finishLoad, loadDelayMs);
      else finishLoad();
    } else if (frame.method === 'session/new') {
      sessionCwd = frame.params && frame.params.cwd || '';
      if (process.env.FAKE_REASONIX_MATERIALIZE_ON_PROMPT === '1') {
        const inbox = join(process.env.REASONIX_HOME, 'sessions', config.sessionId + '.inbox');
        mkdirSync(inbox, { recursive: true });
        writeFileSync(join(inbox, 'transaction.lock'), '');
      }
      send({ jsonrpc: '2.0', id: frame.id, result: {
        sessionId: config.sessionId,
        configOptions: configOptions(),
      } });
    } else if (frame.method === 'session/close') {
      send({ jsonrpc: '2.0', id: frame.id, result: {} });
    } else if (frame.method === 'session/set_config_option') {
      if (frame.params && frame.params.configId === 'model') currentModel = frame.params.value;
      if (frame.params && frame.params.configId === 'effort') currentEffort = frame.params.value;
      if (frame.params && frame.params.configId === 'tool_approval') {
        currentMode = frame.params.value;
        persistConfiguredMode();
      }
      send({ jsonrpc: '2.0', id: frame.id, result: { configOptions: configOptions() } });
    } else if (frame.method === 'session/prompt') {
      promptCount += 1;
      materialize(frame.params && frame.params.prompt && frame.params.prompt[0] && frame.params.prompt[0].text || '');
      if (process.env.FAKE_REASONIX_BLOCK_PROMPT_RESULT === '1') continue;
      if (Number(process.env.FAKE_REASONIX_STREAM_ON_PROMPT) === promptCount) {
        send({ jsonrpc: '2.0', method: '_reasonix.io/session/status_update', params: {
          sessionId: config.sessionId,
          sequence: 7,
          status: { state: 'running' },
        } });
        send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: config.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'before join' } },
        } });
        setTimeout(() => {
          send({ jsonrpc: '2.0', method: 'session/update', params: {
            sessionId: config.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' after join' } },
          } });
          send({ jsonrpc: '2.0', method: '_reasonix.io/session/status_update', params: {
            sessionId: config.sessionId,
            sequence: 8,
            status: { state: 'idle', turnUsage: {
              promptTokens: 11,
              completionTokens: 4,
              reasoningTokens: 0,
              cacheHitTokens: 3,
              cacheMissTokens: 8,
              estimated: true,
              estimatedCost: 0,
              source: 'executor',
              costComplete: false,
            }, cumulative: {
              promptTokens: 44,
              completionTokens: 16,
              reasoningTokens: 0,
              cacheHitTokens: 12,
              cacheMissTokens: 32,
              estimated: true,
              events: 4,
              pricedEvents: 4,
              estimatedCost: 0,
              source: 'executor',
              costComplete: false,
            } },
          } });
          send({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } });
        }, 150);
        continue;
      }
      const promptResultDelayMs = Number(process.env.FAKE_REASONIX_PROMPT_RESULT_DELAY_MS || 0);
      if (promptResultDelayMs > 0) {
        setTimeout(() => send({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } }), promptResultDelayMs);
      } else {
        send({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } });
      }
      if (process.env.FAKE_REASONIX_PERMISSION_BEFORE_EXIT === '1' && !permissionSent) {
        permissionSent = true;
        send({ jsonrpc: '2.0', id: 'permission-before-exit', method: 'session/request_permission', params: {
          sessionId: config.sessionId,
          toolCall: { toolCallId: 'permission-before-exit', title: 'Exit fixture tool', rawInput: { command: 'fixture' } },
          options: [
            { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
          ],
        } });
      }
      if (process.env.FAKE_REASONIX_EXIT_AFTER_PROMPT === '1') {
        setTimeout(() => process.exit(0), 50);
      }
    } else {
      send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'unsupported fixture method' } });
    }
  }
});
`);
  chmodSync(path, 0o755);
  const env = {
    PATH: `${directory}:${process.env.PATH ?? ''}`,
    HOME: directory,
    FAKE_REASONIX_CONFIG: config,
  };
  const events = (): Array<Record<string, unknown>> => readFileSync(ledger, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    path,
    env,
    events,
    spawnCount: () => events().filter((event) => event.kind === 'spawn').length,
  };
}
