/**
 * Zero-cost Pi observe/control regression.
 *
 * Uses a synthetic Pi JSONL transcript under /tmp and points Pi's normal config dir at it with
 * PI_CODING_AGENT_DIR. It uses a fake `pi` binary for no-prompt createSession coverage and never
 * calls a model.
 */
export {};
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AgentMessage } from '../../../../packages/typescript/adapter-api/src/index.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const root = join('/tmp', `cosyncing-pi-observe-${Math.random().toString(36).slice(2, 8)}`);
const cwd = join(root, 'work');
const agentDir = join(root, 'agent');
const agentDirLink = join(root, 'agent-link');
const sessionsRoot = join(agentDir, 'sessions');
const binDir = join(root, 'bin');
const sessionDir = join(sessionsRoot, encodeCwdDir(cwd));
const sessionFile = join(sessionDir, '2026-06-16T00-00-00-000Z_observe.jsonl');
let sessionId = '';

function encodeCwdDir(path: string): string {
  return `--${path.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

function jsonl(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) {
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  } else {
    console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

let failed = 0;

mkdirSync(cwd, { recursive: true });
mkdirSync(binDir, { recursive: true });
mkdirSync(sessionDir, { recursive: true });
symlinkSync(agentDir, agentDirLink, 'dir');
writeFileSync(
  join(binDir, 'pi'),
  `#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cwd = process.cwd();
const args = process.argv.slice(2);
let sessionDirArg;
let sessionFileArg;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--session-dir') sessionDirArg = args[i + 1];
  if (args[i] === '--session') sessionFileArg = args[i + 1];
}
function encodeCwdDir(p) { return '--' + p.replace(/^[/\\\\]/, '').replace(/[/\\\\:]/g, '-') + '--'; }
const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
const explicitDir = sessionDirArg || process.env.PI_CODING_AGENT_SESSION_DIR || process.env.COSYNCING_PI_SESSIONS_ROOT;
const dir = explicitDir || path.join(agentDir, 'sessions', encodeCwdDir(cwd));
const id = '019eda2b-fake-7000-9000-createpi';
const file = sessionFileArg || path.join(dir, '2026-06-18T00-00-00-000Z_' + id + '.jsonl');
const promptLog = file + '.prompt-commands';
const nativeStateFile = file + '.native-state.json';
const concurrencyHoldFile = file + '.concurrency-hold';
const concurrencyReleaseFile = file + '.concurrency-release';
let name;
let model = { provider: 'fake', id: 'pi-create-test', name: 'Pi Create Test', reasoning: true, thinkingLevelMap: { minimal: null } };
let thinkingLevel = 'off';
let convergenceRunOpen = false;
let rejectNextModelRollback = false;
let reconciliationFailuresRemaining = 0;
let heldThinkingResponse;
function persistNativeState() { fs.writeFileSync(nativeStateFile, JSON.stringify({ model, thinkingLevel })); }
fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(file)) {
  fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-06-18T00:00:00.000Z', cwd }) + '\\n');
}
persistNativeState();
let buf = '';
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
process.stdin.resume();
const keepalive = setInterval(() => {}, 1 << 30);
const concurrencyReleasePoll = setInterval(() => {
  if (!heldThinkingResponse || !fs.existsSync(concurrencyReleaseFile)) return;
  const held = heldThinkingResponse;
  heldThinkingResponse = undefined;
  fs.unlinkSync(concurrencyReleaseFile);
  send({ id: held.id, type: 'response', command: 'set_thinking_level', success: false, error: 'fixture released concurrent thinking rejection' });
}, 5);
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  const lines = buf.split('\\n');
  buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const cmd = JSON.parse(line);
    if (cmd.type === 'get_state') {
      if (reconciliationFailuresRemaining > 0) {
        reconciliationFailuresRemaining--;
        send({ id: cmd.id, type: 'response', command: 'get_state', success: false, error: 'fixture reconciliation get_state failed' });
      } else {
        send({ id: cmd.id, type: 'response', command: 'get_state', success: true, data: {
          model,
          thinkingLevel,
          isStreaming: false,
          isCompacting: false,
          steeringMode: 'one-at-a-time',
          followUpMode: 'one-at-a-time',
          sessionFile: file,
          sessionId: id,
          sessionName: name,
          autoCompactionEnabled: true,
          messageCount: 0,
          pendingMessageCount: 0
        }});
      }
    } else if (cmd.type === 'set_session_name') {
      name = String(cmd.name || '');
      fs.appendFileSync(file, JSON.stringify({ type: 'session_info', id: 'name1', parentId: null, timestamp: '2026-06-18T00:00:01.000Z', name }) + '\\n');
      send({ id: cmd.id, type: 'response', command: 'set_session_name', success: true });
    } else if (cmd.type === 'get_available_models') {
      send({ id: cmd.id, type: 'response', command: 'get_available_models', success: true, data: { models: [
        { provider: 'fake', id: 'pi-create-test', name: 'Pi Create Test', reasoning: true, thinkingLevelMap: { minimal: null } },
        { provider: 'fake', id: 'pi-switch-test', name: 'Pi Switch Test', reasoning: true, thinkingLevelMap: { minimal: null } },
        { provider: 'fake', id: 'plain-test', name: 'Plain Test', reasoning: false }
      ] }});
    } else if (cmd.type === 'set_model') {
      if (rejectNextModelRollback) {
        rejectNextModelRollback = false;
        send({ id: cmd.id, type: 'response', command: 'set_model', success: false, error: 'fixture rejected model rollback' });
      } else if (cmd.modelId === 'reject-model') {
        send({ id: cmd.id, type: 'response', command: 'set_model', success: false, error: 'fixture rejected set_model' });
      } else {
        model = { provider: String(cmd.provider || ''), id: String(cmd.modelId || ''), name: 'Pi Switch Test', reasoning: true, thinkingLevelMap: { minimal: null } };
        persistNativeState();
        send({ id: cmd.id, type: 'response', command: 'set_model', success: true, data: model });
      }
    } else if (cmd.type === 'set_thinking_level') {
      if (cmd.level === 'xhigh') {
        if (model.id === 'concurrent-partial-test') {
          heldThinkingResponse = cmd;
          fs.writeFileSync(concurrencyHoldFile, 'held');
        } else {
          if (model.id === 'rollback-fail-test') rejectNextModelRollback = true;
          if (model.id === 'reconcile-fail-test') {
            rejectNextModelRollback = true;
            // First failure defeats rollback reconciliation; second defeats the next prompt's gate.
            reconciliationFailuresRemaining = 2;
          }
          send({ id: cmd.id, type: 'response', command: 'set_thinking_level', success: false, error: 'fixture rejected set_thinking_level' });
        }
      } else {
        thinkingLevel = String(cmd.level || 'off');
        persistNativeState();
        send({ id: cmd.id, type: 'response', command: 'set_thinking_level', success: true });
      }
    } else if (cmd.type === 'prompt') {
      fs.appendFileSync(promptLog, String(cmd.message) + '\\n');
      if (cmd.message === 'RPC REJECT A') {
        send({ id: cmd.id, type: 'response', command: 'prompt', success: false, error: 'fixture rejected prompt A' });
      } else {
        send({ id: cmd.id, type: 'response', command: 'prompt', success: true });
        if (cmd.message === 'RPC CONVERGENCE FIRST') {
          convergenceRunOpen = true;
          fs.appendFileSync(file, JSON.stringify({ type: 'message', id: 'rpc-u-first', timestamp: '2026-06-16T10:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: cmd.message }], timestamp: 1781604000000 } }) + '\\n');
          send({ type: 'agent_start', timestamp: 1781604000000 });
          send({ type: 'turn_start', timestamp: 1781604000020 });
          send({ type: 'message_start', timestamp: 1781604000000, message: { role: 'user', content: [{ type: 'text', text: cmd.message }], timestamp: 1781604000000 } });
          send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'RPC FIRST WORKING' } });
          fs.appendFileSync(file, JSON.stringify({ type: 'message', id: 'rpc-a-first-tool', timestamp: '2026-06-16T10:00:30.000Z', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: 'RPC FIRST WORKING' }], usage: { input: 10, output: 1 }, timestamp: 1781604000040 } }) + '\\n');
          send({ type: 'message_end', timestamp: 1781604030000, message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: 'RPC FIRST WORKING' }], usage: { input: 10, output: 1 } } });
        } else if (cmd.message === 'RPC CONVERGENCE FOLLOW' && convergenceRunOpen) {
          convergenceRunOpen = false;
          fs.appendFileSync(file, JSON.stringify({ type: 'message', id: 'rpc-a-first-done', timestamp: '2026-06-16T10:01:30.000Z', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'RPC FIRST DONE' }], usage: { input: 20, output: 2 }, timestamp: 1781604030040 } }) + '\\n');
          send({ type: 'message_end', timestamp: 1781604090000, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'RPC FIRST DONE' }], usage: { input: 20, output: 2 } } });
          fs.appendFileSync(file, JSON.stringify({ type: 'message', id: 'rpc-u-follow', timestamp: '2026-06-16T10:01:30.010Z', message: { role: 'user', content: [{ type: 'text', text: cmd.message }], timestamp: 1781604010000 } }) + '\\n');
          send({ type: 'turn_start', timestamp: 1781604090020 });
          send({ type: 'message_start', timestamp: 1781604090010, message: { role: 'user', content: [{ type: 'text', text: cmd.message }], timestamp: 1781604010000 } });
          send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'RPC FOLLOW DONE' } });
          fs.appendFileSync(file, JSON.stringify({ type: 'message', id: 'rpc-a-follow-done', timestamp: '2026-06-16T10:02:30.000Z', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'RPC FOLLOW DONE' }], usage: { input: 5, output: 7 }, timestamp: 1781604090050 } }) + '\\n');
          send({ type: 'message_end', timestamp: 1781604150000, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'RPC FOLLOW DONE' }], usage: { input: 5, output: 7 } } });
          send({ type: 'agent_end', timestamp: 1781604150050 });
        } else {
          // A deterministic degraded mini-run (no message_start/message_end) keeps
          // fallback coverage for runtimes that omit those optional frames.
          send({ type: 'agent_start', timestamp: 1781600000000 });
          send({ type: 'turn_start', timestamp: 1781600000100 });
          send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'DRIVELIVE' } });
          send({ type: 'agent_end', timestamp: 1781600005000 });
        }
      }
    } else if (cmd.type === 'abort') {
      send({ id: cmd.id, type: 'response', command: 'abort', success: true });
    } else {
      send({ id: cmd.id, type: 'response', command: cmd.type, success: false, error: 'unexpected ' + cmd.type });
    }
  }
});
process.on('SIGTERM', () => { clearInterval(keepalive); process.exit(143); });
`,
);
chmodSync(join(binDir, 'pi'), 0o755);
writeFileSync(
  sessionFile,
  [
    jsonl({ type: 'session', version: 3, id: 'observe', timestamp: '2026-06-16T00:00:00.000Z', cwd }),
    jsonl({ type: 'model_change', id: 'mc1', parentId: null, timestamp: '2026-06-16T00:00:00.200Z', provider: 'fake', modelId: 'observe-model' }),
    jsonl({ type: 'thinking_level_change', id: 'tl1', parentId: 'mc1', timestamp: '2026-06-16T00:00:00.300Z', thinkingLevel: 'high' }),
    jsonl({ type: 'message', id: 'u1', timestamp: '2026-06-16T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'OBSERVESEED' }] } }),
    jsonl({
      type: 'message',
      id: 'a1',
      timestamp: '2026-06-16T00:00:03.000Z',
      message: {
        role: 'assistant',
        stopReason: 'toolUse',
        // The embedded timestamp is the REQUEST-CREATION clock and equals the
        // preceding entry's — the exact value the retired per-entry summary
        // misread as this message's own span.
        timestamp: Date.parse('2026-06-16T00:00:01.000Z'),
        content: [
          { type: 'thinking', thinking: 'thinking seed' },
          { type: 'text', text: 'OBSERVEASSIST' },
          { type: 'toolCall', id: 'tc1', name: 'edit', arguments: { path: 'src/a.ts' } },
        ],
      },
    }),
    jsonl({
      type: 'message',
      id: 'r1',
      message: {
        role: 'toolResult',
        toolCallId: 'tc1',
        toolName: 'edit',
        content: [{ type: 'text', text: 'Done' }],
        details: { diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-old\n+new\n' },
        isError: false,
      },
    }),
    jsonl({
      type: 'message',
      id: 'a2',
      timestamp: '2026-06-16T00:00:05.500Z',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        timestamp: Date.parse('2026-06-16T00:00:03.010Z'),
        content: [{ type: 'text', text: 'OBSERVEDONE' }],
        usage: { input: 1, output: 2 },
      },
    }),
    jsonl({ type: 'session_info', id: 'rename-mid-tail', parentId: null, timestamp: '2026-06-16T00:00:06.000Z', name: 'Renamed Outside Old Tail' }),
    jsonl({ type: 'noop', payload: 'x'.repeat(300 * 1024) }),
  ].join(''),
);
sessionId = Buffer.from(realpathSync(sessionFile), 'utf8').toString('base64url');

try {
  delete process.env.COSYNCING_PI_SESSIONS_ROOT;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDirLink;
  process.env.COSYNCING_PI_BIN = join(binDir, 'pi');
  process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
  const { PiAdapter } = await import('../../../../packages/typescript/adapters/pi/src/index.ts');
  const adapter = new PiAdapter({ brokerUrl: 'http://127.0.0.1:19999' });
  check('Pi reports createSession available when CLI exists', adapter.canCreateSession() === true);
  const creationCatalog = await adapter.listModels();
  check(
    'pre-session Pi catalog uses the same zero-turn native model inventory',
    creationCatalog.length === 3 &&
      creationCatalog.some(
        (model) =>
          model.providerID === 'fake' &&
          model.modelID === 'pi-switch-test' &&
          model.reasoningEfforts?.some((effort) => effort.effort === 'high'),
      ),
    JSON.stringify(creationCatalog),
  );
  const created = await adapter.createSession({
    directory: cwd,
    title: 'Created From Test',
    model: {
      providerID: 'fake',
      modelID: 'pi-switch-test',
      reasoningEffort: 'high',
    },
  });
  check('createSession returns observe-first Pi session', created.tool === 'pi' && created.attachMode === 'observe', `${created.tool}/${created.attachMode}`);
  check('createSession returns drivable control metadata', created.control?.drive.supported === true && created.control.drive.state === 'observing', JSON.stringify(created.control?.drive));
  check('createSession preserves requested cwd and title', created.cwd === cwd && created.title === 'Created From Test', `cwd=${created.cwd} title=${created.title}`);
  check('createSession applies the exact selected Pi model before reading state', created.currentModel?.providerID === 'fake' && created.currentModel.modelID === 'pi-switch-test', JSON.stringify(created.currentModel));
  check('createSession applies the exact selected Pi thinking level before reading state', created.currentModel?.reasoningEffort === 'high', JSON.stringify(created.currentModel));
  const createdPath = Buffer.from(created.id, 'base64url').toString('utf8');
  check('default create uses Pi CLI cwd session directory', createdPath.startsWith(`${sessionDir}/`), createdPath);

  const sessions = await adapter.discoverSessions();
  const session = sessions.find((s) => s.id === sessionId);
  const createdDiscovered = sessions.find((s) => s.id === created.id);
  check('discovers synthetic Pi session', !!session, `count=${sessions.length}`);
  check('symlinked Pi session root canonicalizes to realpath id', session?.id === sessionId && Buffer.from(session.id, 'base64url').toString('utf8') === realpathSync(sessionFile), session?.id ?? '');
  check('discovers Pi rename beyond the old 256KB title tail', session?.title === 'Renamed Outside Old Tail', `title=${session?.title}`);
  check('discovers created Pi session with persisted title', createdDiscovered?.title === 'Created From Test', `title=${createdDiscovered?.title}`);
  check('Pi discovery is observe-first', session?.attachMode === 'observe', `attachMode=${session?.attachMode}`);
  check(
    'Pi discovery maps locked current model and effort from JSONL',
    session?.currentModel?.providerID === 'fake' && session?.currentModel?.modelID === 'observe-model' && session?.currentModel?.reasoningEffort === 'high',
    JSON.stringify(session?.currentModel),
  );
  check('Pi discovery reports explicit control', !!session?.control, JSON.stringify(session?.control));
  check('terminal sync is supported but inactive before bridge', session?.control?.terminalSync.supported === true && session?.control?.terminalSync.active === false);
  check(
    'terminal sync setup is a short Pi session resume command',
    session?.control?.terminalSync.command === `COSYNCING_BROKER='http://127.0.0.1:19999' pi --session '${resolve(sessionFile)}'` &&
      !/config\.json|mkdir|cp /.test(session?.control?.terminalSync.command ?? ''),
    session?.control?.terminalSync.command ?? '',
  );
  // maintainer's "instructions too long / duplicate the package setup" → keep the SYNC-MODAL note a single short
  // sentence about resuming, never the install/setup steps (those belong to first-time package setup, not here).
  check(
    'terminal sync note is a single short resume sentence (no setup/install duplication)',
    (() => {
      const note = session?.control?.terminalSync.note ?? '';
      return note.length > 0 && note.length <= 140 && note.split(/[.!?]\s/).filter(Boolean).length <= 1 &&
        /resume/i.test(note) && !/pip install|npm install|uvx|\bsetup\b|config\.json|mkdir|cp /i.test(note);
    })(),
    session?.control?.terminalSync.note ?? '',
  );
  check('cwd comes from JSONL session record', session?.cwd === cwd, `cwd=${session?.cwd}`);

  const conn = await adapter.attach(sessionId);
  const live: AgentMessage[] = [];
  conn.subscribe((m) => live.push(m));
  const history = await conn.getHistory();
  check('observe attach stays read-only transport', conn.info.attachMode === 'observe', `attachMode=${conn.info.attachMode}`);
  check(
    'observe attach exposes locked current model and effort',
    conn.info.currentModel?.providerID === 'fake' && conn.info.currentModel?.modelID === 'observe-model' && conn.info.currentModel?.reasoningEffort === 'high',
    JSON.stringify(conn.info.currentModel),
  );
  check('history maps user and assistant text', JSON.stringify(history).includes('OBSERVESEED') && JSON.stringify(history).includes('OBSERVEASSIST'));
  check('history maps enriched tool result path', history.some((m) => m.type === 'tool-result' && m.path === 'src/a.ts'));
  check('history maps Pi user sentAt', history.some((m) => m.type === 'user-message' && m.key === 'u1' && m.sentAt === Date.parse('2026-06-16T00:00:01.000Z')));
  check(
    'history maps ONE run-summary per user turn from entry write-times',
    history.some((m) => m.type === 'run-summary' && m.key === 'pi:run:u0' && m.turnId === 'u0' && m.userMessageKey === 'u1' && m.status === 'done' && m.startedAt === Date.parse('2026-06-16T00:00:01.000Z') && m.completedAt === Date.parse('2026-06-16T00:00:05.500Z') && m.totalRuntimeMs === 4500 && m.tokens?.input === 1 && m.tokens.output === 2) &&
      history.filter((m) => m.type === 'run-summary').length === 1 &&
      history.some((m) => m.type === 'metadata-update' && m.key === 'runtimeTotals' && (m.value as any).totalRuntimeMs === 4500 && (m.value as any).turnCount === 1),
    JSON.stringify(history.filter((m) => m.type === 'run-summary' || (m.type === 'metadata-update' && m.key === 'runtimeTotals'))),
  );
  check(
    'tool result follows its owning call, before the next assistant text',
    (() => {
      const call = history.findIndex((m) => m.type === 'tool-call' && (m as any).callId === 'tc1');
      const result = history.findIndex((m) => m.type === 'tool-result' && (m as any).callId === 'tc1');
      const finalText = history.findIndex((m) => m.type === 'model-output' && /OBSERVEDONE/.test(String((m as any).text)));
      return call >= 0 && result > call && finalText > result;
    })(),
    JSON.stringify(history.map((m) => m.type)),
  );

  // Incremental recovery: a prompt tailed live opens a RUNNING turn (no
  // fabricated completion), and the final entry arriving in a LATER read
  // closes the same turn with the same span a whole-file reload computes.
  appendFileSync(sessionFile, jsonl({ type: 'message', id: 'u2', timestamp: '2026-06-16T00:00:06.000Z', message: { role: 'user', content: [{ type: 'text', text: 'OBSERVELIVE' }] } }));
  for (let i = 0; i < 20 && !live.some((m) => m.type === 'user-message' && /OBSERVELIVE/.test(m.text)); i++) await sleep(100);
  check('observe attach tails appended JSONL messages', live.some((m) => m.type === 'user-message' && /OBSERVELIVE/.test(m.text)));
  check(
    'a tailed prompt opens a running turn without a completed footer',
    live.some((m) => m.type === 'run-summary' && m.turnId === 'u1' && m.userMessageKey === 'u2' && m.status === 'running' && m.totalRuntimeMs === undefined && m.completedAt === undefined),
    JSON.stringify(live.filter((m) => m.type === 'run-summary')),
  );
  appendFileSync(sessionFile, jsonl({
    type: 'message',
    id: 'a3',
    timestamp: '2026-06-16T00:00:09.000Z',
    message: { role: 'assistant', stopReason: 'stop', timestamp: Date.parse('2026-06-16T00:00:06.010Z'), content: [{ type: 'text', text: 'OBSERVELIVEDONE' }] },
  }));
  for (let i = 0; i < 20 && !live.some((m) => m.type === 'run-summary' && m.turnId === 'u1' && m.status === 'done'); i++) await sleep(100);
  const liveClosed: any = live.find((m) => m.type === 'run-summary' && m.turnId === 'u1' && m.status === 'done');
  check(
    'a later tail read closes the SAME turn with the whole-turn span',
    liveClosed?.totalRuntimeMs === 3000
      && (liveClosed as any)?.key === 'pi:run:u1'
      && liveClosed?.userMessageKey === 'u2'
      && liveClosed?.startedAt === Date.parse('2026-06-16T00:00:06.000Z')
      && liveClosed?.completedAt === Date.parse('2026-06-16T00:00:09.000Z'),
    JSON.stringify(liveClosed),
  );
  // Reload convergence: a fresh whole-file read yields the identical summary.
  const reloadConn = await adapter.attach(sessionId);
  const reloaded = await reloadConn.getHistory();
  await reloadConn.close();
  const reloadedClosed: any = reloaded.find((m) => m.type === 'run-summary' && m.turnId === 'u1');
  check(
    'reload converges on the live summary (same key, status, and span)',
    reloadedClosed?.status === 'done'
      && (reloadedClosed as any)?.key === 'pi:run:u1'
      && reloadedClosed?.userMessageKey === 'u2'
      && reloadedClosed?.totalRuntimeMs === 3000
      && reloadedClosed?.startedAt === liveClosed?.startedAt
      && reloadedClosed?.completedAt === liveClosed?.completedAt,
    JSON.stringify(reloadedClosed),
  );

  let rejected = false;
  try {
    await conn.sendPrompt({ text: 'should reject' });
  } catch (err) {
    rejected = /read-only/i.test(String(err));
  }
  check('observe attach rejects prompts', rejected);
  await conn.close();

  const drive = await adapter.attach(created.id, 'resume');
  const models = await drive.listModels?.();
  check(
    'resume listModels exposes Pi model catalog and model-specific thinking levels',
    !!models?.some((m) =>
      m.providerID === 'fake' &&
      m.modelID === 'pi-switch-test' &&
      m.reasoningEfforts?.some((e) => e.effort === 'high') &&
      !m.reasoningEfforts?.some((e) => e.effort === 'minimal')
    ),
    JSON.stringify(models),
  );
  await drive.sendPrompt({ text: 'switch model', model: { providerID: 'fake', modelID: 'pi-switch-test', reasoningEffort: 'high' } });
  check(
    'resume sendPrompt applies set_model plus set_thinking_level to current session info',
    drive.info.currentModel?.providerID === 'fake' && drive.info.currentModel?.modelID === 'pi-switch-test' && drive.info.currentModel?.reasoningEffort === 'high',
    JSON.stringify(drive.info.currentModel),
  );
  await drive.close();

  // History/live overlap across reconnect: a fresh drive connection's key
  // counters are seeded ABOVE every entry already in the session file, so its
  // new turn/user keys can never re-issue a key an earlier connection's turns
  // (still retained by a client) already own — the mid-transcript scramble.
  const seededRaw = readFileSync(realpathSync(sessionFile), 'utf8');
  const seededLines = seededRaw.endsWith('\n')
    ? seededRaw.split('\n').length - 1
    : seededRaw.split('\n').length;
  const driveLive: AgentMessage[] = [];
  const drive2 = await adapter.attach(sessionId, 'resume');
  drive2.subscribe((m) => driveLive.push(m));
  await drive2.sendPrompt({ text: 'drive prompt' });
  for (let i = 0; i < 30 && !driveLive.some((m) => m.type === 'model-output'); i++) await sleep(100);
  const liveDelta = driveLive.find((m) => m.type === 'model-output');
  check(
    'reconnected drive keys its first turn above the session file entries',
    (liveDelta as any)?.key === `t${seededLines + 1}:t`,
    `key=${(liveDelta as any)?.key} seededLines=${seededLines}`,
  );
  check(
    'reconnected drive keys its optimistic prompt echo above the file entries',
    driveLive.some((m) => m.type === 'user-message' && (m as any).key === `u:sent:${seededLines + 1}`),
    JSON.stringify(driveLive.filter((m) => m.type === 'user-message').map((m) => (m as any).key)),
  );
  for (let i = 0; i < 30 && !driveLive.some((m) => m.type === 'run-summary' && m.status === 'done'); i++) await sleep(100);
  const driveDone: any = driveLive.find((m) => m.type === 'run-summary' && m.status === 'done');
  check(
    'the live run summary spans agent_start to agent_end',
    driveDone?.startedAt === 1781600000000
      && driveDone?.completedAt === 1781600005000
      && driveDone?.totalRuntimeMs === 5000,
    JSON.stringify(driveDone),
  );
  check(
    'exactly one running summary was minted for the run',
    driveLive.filter((m) => m.type === 'run-summary' && m.status === 'running').length === 1,
    JSON.stringify(driveLive.filter((m) => m.type === 'run-summary')),
  );
  await drive2.close();

  // RPC/reload convergence: one agent_start batches two user turns, then one
  // agent_end. Pi's live user messages have no native JSONL entry id, so the
  // summary identity must come from the shared user-turn ordinal; the
  // userMessageKey remains transport-local bubble linkage and is deliberately
  // excluded from this projection.
  const convergenceLive: AgentMessage[] = [];
  const convergenceDrive = await adapter.attach(sessionId, 'resume');
  convergenceDrive.subscribe((m) => convergenceLive.push(m));
  await convergenceDrive.sendPrompt({ text: 'RPC CONVERGENCE FIRST' });
  await convergenceDrive.sendPrompt({ text: 'RPC CONVERGENCE FOLLOW' });
  for (
    let i = 0;
    i < 30 && convergenceLive.filter((m) => m.type === 'run-summary' && m.status === 'done').length < 2;
    i++
  ) await sleep(100);
  const summaryProjection = (messages: AgentMessage[]) => messages
    .filter((m): m is Extract<AgentMessage, { type: 'run-summary' }> =>
      m.type === 'run-summary'
      && (m.key === 'pi:run:u2' || m.key === 'pi:run:u3')
      && m.status === 'done')
    .map((m) => ({
      key: m.key,
      turnId: m.turnId,
      status: m.status,
      startedAt: m.startedAt,
      completedAt: m.completedAt,
      totalRuntimeMs: m.totalRuntimeMs,
      tokens: m.tokens,
    }));
  const liveProjection = summaryProjection(convergenceLive);
  check(
    'one RPC run emits one completed summary per user turn',
    liveProjection.length === 2,
    JSON.stringify(convergenceLive.filter((m) => m.type === 'run-summary')),
  );
  await convergenceDrive.close();
  const convergenceReload = await adapter.attach(sessionId);
  const reloadProjection = summaryProjection(await convergenceReload.getHistory());
  await convergenceReload.close();
  check(
    'RPC live summaries converge with JSONL reload (keys, spans, token groups)',
    JSON.stringify(reloadProjection) === JSON.stringify(liveProjection),
    `live=${JSON.stringify(liveProjection)} reload=${JSON.stringify(reloadProjection)}`,
  );

  // A rejected prompt never produces message_start/agent_end. Its optimistic bubble remains
  // visible, but its FIFO link must be removed so the next accepted prompt owns its own summary.
  // The rejected prompt also must not consume the durable user-turn ordinal: four user entries are
  // persisted above, so B is still u4 rather than u5.
  const rejectionLive: AgentMessage[] = [];
  const rejectionDrive = await adapter.attach(sessionId, 'resume');
  rejectionDrive.subscribe((m) => rejectionLive.push(m));
  let promptARejected = false;
  try {
    await rejectionDrive.sendPrompt({ text: 'RPC REJECT A' });
  } catch (error) {
    promptARejected = /fixture rejected prompt A/.test(String(error));
  }
  await rejectionDrive.sendPrompt({ text: 'RPC AFTER REJECT B' });
  for (
    let i = 0;
    i < 30 && !rejectionLive.some((m) => m.type === 'run-summary' && m.status === 'done');
    i++
  ) await sleep(100);
  const promptA = rejectionLive.find((m) =>
    m.type === 'user-message' && m.text === 'RPC REJECT A');
  const promptB = rejectionLive.find((m) =>
    m.type === 'user-message' && m.text === 'RPC AFTER REJECT B');
  const promptBSummary = rejectionLive.find((m) =>
    m.type === 'run-summary' && m.status === 'done');
  check('Pi exposes the fixture rejection to the caller', promptARejected);
  check(
    'a successful prompt after rejection consumes its own optimistic key with no ordinal gap',
    promptA?.type === 'user-message'
      && promptB?.type === 'user-message'
      && promptBSummary?.type === 'run-summary'
      && promptBSummary.key === 'pi:run:u4'
      && promptBSummary.turnId === 'u4'
      && promptBSummary.userMessageKey === promptB.key
      && promptBSummary.userMessageKey !== promptA.key,
    JSON.stringify({ promptA, promptB, promptBSummary }),
  );
  await rejectionDrive.close();

  // Model selection is pre-delivery. Either rejected RPC must abort before `prompt` and remove only
  // that attempt's optimistic FIFO key. A partial switch is rolled back; if rollback itself fails,
  // get_state republishes the actual native selection. The next accepted prompt still opens u4.
  const modelFailureLive: AgentMessage[] = [];
  const modelFailureDrive = await adapter.attach(sessionId, 'resume');
  modelFailureDrive.subscribe((m) => modelFailureLive.push(m));
  const currentModelBeforeFailures = JSON.stringify(modelFailureDrive.info.currentModel);
  const nativeStatePath = `${realpathSync(sessionFile)}.native-state.json`;
  const nativeSelection = (raw: string) => {
    const state = JSON.parse(raw);
    return {
      providerID: state.model?.provider,
      modelID: state.model?.id,
      reasoningEffort: state.thinkingLevel,
    };
  };
  const nativeStateBeforeFailures = nativeSelection(readFileSync(nativeStatePath, 'utf8'));
  let setModelRejected = false;
  try {
    await modelFailureDrive.sendPrompt({
      text: 'RPC REJECT SET MODEL',
      model: { providerID: 'fake', modelID: 'reject-model' },
    });
  } catch (error) {
    setModelRejected = /fixture rejected set_model/.test(String(error));
  }
  let thinkingRejected = false;
  try {
    await modelFailureDrive.sendPrompt({
      text: 'RPC REJECT THINKING LEVEL',
      model: { providerID: 'fake', modelID: 'pi-switch-test', reasoningEffort: 'xhigh' },
    });
  } catch (error) {
    thinkingRejected = /fixture rejected set_thinking_level/.test(String(error));
  }
  const promptLogPath = `${realpathSync(sessionFile)}.prompt-commands`;
  const commandsBeforeSuccess = readFileSync(promptLogPath, 'utf8');
  const nativeStateAfterFailures = nativeSelection(readFileSync(nativeStatePath, 'utf8'));
  check('Pi exposes rejected set_model and set_thinking_level responses', setModelRejected && thinkingRejected);
  check(
    'partial model selection rolls native Pi back and keeps broker state truthful',
    !commandsBeforeSuccess.includes('RPC REJECT SET MODEL')
      && !commandsBeforeSuccess.includes('RPC REJECT THINKING LEVEL')
      && JSON.stringify(nativeStateAfterFailures) === JSON.stringify(nativeStateBeforeFailures)
      && JSON.stringify(modelFailureDrive.info.currentModel) === currentModelBeforeFailures,
    JSON.stringify({
      commandsBeforeSuccess,
      nativeStateBeforeFailures,
      nativeStateAfterFailures,
      currentModel: modelFailureDrive.info.currentModel,
    }),
  );
  let rollbackFailureRejected = false;
  try {
    await modelFailureDrive.sendPrompt({
      text: 'RPC REJECT THINKING AND ROLLBACK',
      model: { providerID: 'fake', modelID: 'rollback-fail-test', reasoningEffort: 'xhigh' },
    });
  } catch (error) {
    rollbackFailureRejected = /fixture rejected set_thinking_level/.test(String(error));
  }
  const nativeStateAfterRollbackFailure = nativeSelection(readFileSync(nativeStatePath, 'utf8'));
  const reconciledModelFrame = modelFailureLive.find((m) =>
    m.type === 'metadata-update'
      && m.key === 'sessionInfo'
      && (m.value as any)?.currentModel?.modelID === 'rollback-fail-test');
  check(
    'failed rollback republishes the actual native selection from get_state',
    rollbackFailureRejected
      && !readFileSync(promptLogPath, 'utf8').includes('RPC REJECT THINKING AND ROLLBACK')
      && nativeStateAfterRollbackFailure.modelID === 'rollback-fail-test'
      && JSON.stringify(modelFailureDrive.info.currentModel) === JSON.stringify(nativeStateAfterRollbackFailure)
      && reconciledModelFrame?.type === 'metadata-update',
    JSON.stringify({
      nativeStateAfterRollbackFailure,
      currentModel: modelFailureDrive.info.currentModel,
      reconciledModelFrame,
    }),
  );
  let doubleFailureRejected = false;
  try {
    await modelFailureDrive.sendPrompt({
      text: 'RPC REJECT ROLLBACK AND RECONCILIATION',
      model: { providerID: 'fake', modelID: 'reconcile-fail-test', reasoningEffort: 'xhigh' },
    });
  } catch (error) {
    doubleFailureRejected = /fixture reconciliation get_state failed/.test(String(error));
  }
  const nativeStateAfterDoubleFailure = nativeSelection(readFileSync(nativeStatePath, 'utf8'));
  let uncertainPromptRejected = false;
  try {
    await modelFailureDrive.sendPrompt({ text: 'RPC BLOCKED WHILE MODEL UNKNOWN' });
  } catch (error) {
    uncertainPromptRejected = /model state is uncertain/.test(String(error));
  }
  const commandsWhileUncertain = readFileSync(promptLogPath, 'utf8');
  check(
    'rollback plus reconciliation failure blocks later prompts before optimistic enqueue',
    doubleFailureRejected
      && uncertainPromptRejected
      && nativeStateAfterDoubleFailure.modelID === 'reconcile-fail-test'
      && modelFailureDrive.info.currentModel?.modelID !== nativeStateAfterDoubleFailure.modelID
      && !commandsWhileUncertain.includes('RPC REJECT ROLLBACK AND RECONCILIATION')
      && !commandsWhileUncertain.includes('RPC BLOCKED WHILE MODEL UNKNOWN')
      && !modelFailureLive.some((m) =>
        m.type === 'user-message' && m.text === 'RPC BLOCKED WHILE MODEL UNKNOWN'),
    JSON.stringify({
      doubleFailureRejected,
      uncertainPromptRejected,
      nativeStateAfterDoubleFailure,
      currentModel: modelFailureDrive.info.currentModel,
      commandsWhileUncertain,
    }),
  );
  await modelFailureDrive.sendPrompt({
    text: 'RPC AFTER MODEL FAILURES',
    model: { providerID: 'fake', modelID: 'pi-switch-test', reasoningEffort: 'high' },
  });
  for (
    let i = 0;
    i < 30 && !modelFailureLive.some((m) => m.type === 'run-summary' && m.status === 'done');
    i++
  ) await sleep(100);
  const failedSetModelBubble = modelFailureLive.find((m) =>
    m.type === 'user-message' && m.text === 'RPC REJECT SET MODEL');
  const failedThinkingBubble = modelFailureLive.find((m) =>
    m.type === 'user-message' && m.text === 'RPC REJECT THINKING LEVEL');
  const failedRollbackBubble = modelFailureLive.find((m) =>
    m.type === 'user-message' && m.text === 'RPC REJECT THINKING AND ROLLBACK');
  const failedDoubleBubble = modelFailureLive.find((m) =>
    m.type === 'user-message' && m.text === 'RPC REJECT ROLLBACK AND RECONCILIATION');
  const successfulModelBubble = modelFailureLive.find((m) =>
    m.type === 'user-message' && m.text === 'RPC AFTER MODEL FAILURES');
  const successfulModelSummary = modelFailureLive.find((m) =>
    m.type === 'run-summary' && m.status === 'done');
  const commandsAfterSuccess = readFileSync(promptLogPath, 'utf8');
  check(
    'the first prompt after model failures owns its key and ordinal',
    failedSetModelBubble?.type === 'user-message'
      && failedThinkingBubble?.type === 'user-message'
      && failedRollbackBubble?.type === 'user-message'
      && failedDoubleBubble?.type === 'user-message'
      && successfulModelBubble?.type === 'user-message'
      && successfulModelSummary?.type === 'run-summary'
      && successfulModelSummary.key === 'pi:run:u4'
      && successfulModelSummary.turnId === 'u4'
      && successfulModelSummary.userMessageKey === successfulModelBubble.key
      && successfulModelSummary.userMessageKey !== failedSetModelBubble.key
      && successfulModelSummary.userMessageKey !== failedThinkingBubble.key
      && successfulModelSummary.userMessageKey !== failedRollbackBubble.key
      && successfulModelSummary.userMessageKey !== failedDoubleBubble.key
      && commandsAfterSuccess.split('\n').filter((line) => line === 'RPC AFTER MODEL FAILURES').length === 1,
    JSON.stringify({ failedSetModelBubble, failedThinkingBubble, failedRollbackBubble, failedDoubleBubble, successfulModelBubble, successfulModelSummary, commandsAfterSuccess }),
  );
  await modelFailureDrive.close();

  // Two broker clients can call the SAME managed connection concurrently. Hold A after native
  // set_model succeeds but before its thinking-level rejection. B must remain outside the entire
  // critical section: no optimistic echo/FIFO entry and no native prompt until A rolls back and
  // removes its exact key. Once released, B proceeds and still owns durable ordinal u4.
  const concurrentLive: AgentMessage[] = [];
  const concurrentDrive = await adapter.attach(sessionId, 'resume');
  concurrentDrive.subscribe((m) => concurrentLive.push(m));
  const concurrencyHoldPath = `${realpathSync(sessionFile)}.concurrency-hold`;
  const concurrencyReleasePath = `${realpathSync(sessionFile)}.concurrency-release`;
  let concurrentARejected = false;
  const concurrentA = concurrentDrive.sendPrompt({
    text: 'RPC CONCURRENT PARTIAL A',
    model: { providerID: 'fake', modelID: 'concurrent-partial-test', reasoningEffort: 'xhigh' },
  }).catch((error) => {
    concurrentARejected = /concurrent thinking rejection/.test(String(error));
  });
  for (let i = 0; i < 50 && !existsSync(concurrencyHoldPath); i++) await sleep(20);
  const concurrentB = concurrentDrive.sendPrompt({ text: 'RPC CONCURRENT B' });
  await sleep(100);
  const concurrentCommandsWhileHeld = readFileSync(promptLogPath, 'utf8');
  check(
    'concurrent B cannot echo, enqueue, or reach Pi during A partial switch',
    existsSync(concurrencyHoldPath)
      && concurrentLive.some((m) =>
        m.type === 'user-message' && m.text === 'RPC CONCURRENT PARTIAL A')
      && !concurrentLive.some((m) =>
        m.type === 'user-message' && m.text === 'RPC CONCURRENT B')
      && !concurrentCommandsWhileHeld.includes('RPC CONCURRENT PARTIAL A')
      && !concurrentCommandsWhileHeld.includes('RPC CONCURRENT B'),
    JSON.stringify({ concurrentLive, concurrentCommandsWhileHeld }),
  );
  writeFileSync(concurrencyReleasePath, 'release');
  await concurrentA;
  await concurrentB;
  for (
    let i = 0;
    i < 30 && !concurrentLive.some((m) => m.type === 'run-summary' && m.status === 'done');
    i++
  ) await sleep(100);
  const concurrentPromptA = concurrentLive.find((m) =>
    m.type === 'user-message' && m.text === 'RPC CONCURRENT PARTIAL A');
  const concurrentPromptB = concurrentLive.find((m) =>
    m.type === 'user-message' && m.text === 'RPC CONCURRENT B');
  const concurrentSummaryB = concurrentLive.find((m) =>
    m.type === 'run-summary' && m.status === 'done');
  const concurrentCommandsAfterRelease = readFileSync(promptLogPath, 'utf8');
  check(
    'rejected A releases the prompt lock without poisoning B FIFO or ordinal',
    concurrentARejected
      && concurrentPromptA?.type === 'user-message'
      && concurrentPromptB?.type === 'user-message'
      && concurrentSummaryB?.type === 'run-summary'
      && concurrentSummaryB.key === 'pi:run:u4'
      && concurrentSummaryB.turnId === 'u4'
      && concurrentSummaryB.userMessageKey === concurrentPromptB.key
      && concurrentSummaryB.userMessageKey !== concurrentPromptA.key
      && !concurrentCommandsAfterRelease.includes('RPC CONCURRENT PARTIAL A')
      && concurrentCommandsAfterRelease.split('\n').filter((line) =>
        line === 'RPC CONCURRENT B').length === 1,
    JSON.stringify({
      concurrentARejected,
      concurrentPromptA,
      concurrentPromptB,
      concurrentSummaryB,
      concurrentCommandsAfterRelease,
    }),
  );
  await concurrentDrive.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed) {
  console.error(`\nFAIL: ${failed} Pi observe check(s) failed.`);
  process.exit(1);
}

console.log('\nPASS');
