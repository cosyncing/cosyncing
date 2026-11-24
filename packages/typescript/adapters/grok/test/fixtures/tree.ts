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
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
// Grok's stdio agent treats stdin EOF as its cleanup path, but that shutdown
// usually outlasts a 2-second grace on a real host. FAKE_GROK_LINGER_AFTER_STDIN_END_MS
// stands in for that slow shutdown, and the SIGTERM handler for Grok's documented
// "143 Terminated by SIGTERM". The linger is bounded, so a fake can never outlive it.
const lingerAfterStdinEndMs = Number(process.env.FAKE_GROK_LINGER_AFTER_STDIN_END_MS || 0);
if (lingerAfterStdinEndMs > 0) {
  process.on('SIGTERM', () => {
    record({ kind: 'sigterm', pid: process.pid });
    process.exit(143);
  });
}
process.stdin.on('end', () => {
  record({ kind: 'stdin-end', pid: process.pid });
  if (lingerAfterStdinEndMs > 0) setTimeout(() => process.exit(0), lingerAfterStdinEndMs);
});
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
      authMethods: process.env.FAKE_GROK_AUTH_METHODS ? JSON.parse(process.env.FAKE_GROK_AUTH_METHODS) : [
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
    if (process.env.FAKE_GROK_VENDOR_NOTICES === '1') {
      // _x.ai/mcp/servers_updated and its params are as Grok 1.0.92 sends them after every
      // initialize (a 2026-11-24 capture). The other two are deliberately unknown, so a client
      // must still trace them.
      send({ jsonrpc: '2.0', method: '_x.ai/mcp/servers_updated', params: { mcpServers: [] } });
      for (const method of ['_vendor.test/notice', 'fake/unknown_notice']) {
        send({ jsonrpc: '2.0', method, params: {} });
      }
      record({ kind: 'vendor-notices', at: 'initialize', pid: process.pid });
    }
    return;
  }
  if (frame.method === 'authenticate') {
    send({ jsonrpc: '2.0', id: frame.id, result: {} });
    return;
  }
  if (frame.method === 'session/new') {
    if (process.env.FAKE_GROK_VENDOR_NOTICES === '1') {
      // Grok 1.0.92 reports session/new progress phases this way, a dozen per create (a
      // 2026-11-24 capture).
      for (const phase of ['auth', 'persistence_init', 'response_ready']) {
        send({ jsonrpc: '2.0', method: '_x.ai/session/setup', params: { method: 'session/new', phase, sessionId: phase === 'auth' ? null : config.sessionId } });
      }
      record({ kind: 'vendor-notices', at: 'session/new', pid: process.pid });
    }
    ensureSession(frame.params.cwd);
    send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: config.sessionId } });
    return;
  }
  if (frame.method === 'session/load') {
    // Grok 1.0.92 saves summary.json by writing a temp file and renaming it over the old one,
    // five times within ~45 ms of session/load, some after its answer (a 2026-11-24
    // capture). Same mechanism here, repeated for a bounded window so that the client's
    // first read after the answer lands inside it; the event loop is yielded every 5 ms so the
    // answer is flushed first and later frames are still read. With
    // FAKE_GROK_LOAD_SUMMARY_STALE_MS, the summary as it was before this session/load (the
    // previous model and effort) is what the store holds at the answer and what the rewrites
    // put back for that long; the summary for this load follows, and is the last one saved.
    const summaryPath = sessionPaths(frame.params.cwd).summary;
    const rewriteMs = Math.min(1000, Number(process.env.FAKE_GROK_LOAD_SUMMARY_REWRITE_MS || 0) || 0);
    const staleMs = Math.min(rewriteMs, Number(process.env.FAKE_GROK_LOAD_SUMMARY_STALE_MS || 0) || 0);
    let previous;
    if (staleMs > 0) {
      try { previous = readFileSync(summaryPath); } catch {}
    }
    ensureSession(frame.params.cwd);
    const fresh = rewriteMs > 0 ? readFileSync(summaryPath) : undefined;
    let count = 0;
    let stale = 0;
    const save = (text) => {
      const temporary = summaryPath + '.' + process.pid + '-' + count + '.tmp';
      writeFileSync(temporary, text);
      renameSync(temporary, summaryPath);
      count += 1;
    };
    if (previous) save(previous);
    send({ jsonrpc: '2.0', id: frame.id, result: { models, modes } });
    if (rewriteMs > 0) {
      const started = Date.now();
      const deadline = started + rewriteMs;
      const staleUntil = started + staleMs;
      const rewrite = () => {
        const sliceEnd = Math.min(deadline, Date.now() + 5);
        while (Date.now() < sliceEnd) {
          const useStale = previous !== undefined && Date.now() < staleUntil;
          save(useStale ? previous : fresh);
          if (useStale) stale += 1;
        }
        if (Date.now() < deadline) {
          setTimeout(rewrite, 0);
          return;
        }
        save(fresh);
        record({ kind: 'summary-rewrites-done', count, stale, pid: process.pid });
      };
      setTimeout(rewrite, 0);
    }
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
    if (process.env.FAKE_GROK_VENDOR_NOTICES === '1') {
      // Shapes as Grok 1.0.92 sends them during a turn (a 2026-11-24 capture): one
      // tool_call_delta_chunk per streamed tool-argument chunk, and the prompt queue.
      send({ jsonrpc: '2.0', method: '_x.ai/queue/changed', params: { sessionId: config.sessionId, entries: [] } });
      send({ jsonrpc: '2.0', method: '_x.ai/session_notification', params: { sessionId: config.sessionId,
        update: { sessionUpdate: 'tool_call_delta_chunk', tool_call_id: 'call-' + promptId, tool_index: 0, name: 'run_terminal_command' } } });
      record({ kind: 'vendor-notices', at: 'session/prompt', pid: process.pid });
    }
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
