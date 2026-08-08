/**
 * Zero-cost Pi observe/control regression.
 *
 * Uses a synthetic Pi JSONL transcript under /tmp and points Pi's normal config dir at it with
 * PI_CODING_AGENT_DIR. It uses a fake `pi` binary for no-prompt createSession coverage and never
 * calls a model.
 */
export {};
import { appendFileSync, chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
for (let i = 0; i < args.length; i++) if (args[i] === '--session-dir') sessionDirArg = args[i + 1];
function encodeCwdDir(p) { return '--' + p.replace(/^[/\\\\]/, '').replace(/[/\\\\:]/g, '-') + '--'; }
const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
const explicitDir = sessionDirArg || process.env.PI_CODING_AGENT_SESSION_DIR || process.env.COSYNCING_PI_SESSIONS_ROOT;
const dir = explicitDir || path.join(agentDir, 'sessions', encodeCwdDir(cwd));
const id = '019eda2b-fake-7000-9000-createpi';
const file = path.join(dir, '2026-06-18T00-00-00-000Z_' + id + '.jsonl');
let name;
let model = { provider: 'fake', id: 'pi-create-test', name: 'Pi Create Test', reasoning: true, thinkingLevelMap: { minimal: null } };
let thinkingLevel = 'off';
fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(file)) {
  fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-06-18T00:00:00.000Z', cwd }) + '\\n');
}
let buf = '';
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
process.stdin.resume();
const keepalive = setInterval(() => {}, 1 << 30);
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  const lines = buf.split('\\n');
  buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const cmd = JSON.parse(line);
    if (cmd.type === 'get_state') {
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
      model = { provider: String(cmd.provider || ''), id: String(cmd.modelId || ''), name: 'Pi Switch Test', reasoning: true, thinkingLevelMap: { minimal: null } };
      send({ id: cmd.id, type: 'response', command: 'set_model', success: true, data: model });
    } else if (cmd.type === 'set_thinking_level') {
      thinkingLevel = String(cmd.level || 'off');
      send({ id: cmd.id, type: 'response', command: 'set_thinking_level', success: true });
    } else if (cmd.type === 'prompt') {
      send({ id: cmd.id, type: 'response', command: 'prompt', success: true });
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
      timestamp: '2026-06-16T00:00:05.500Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'thinking seed' },
          { type: 'text', text: 'OBSERVEASSIST' },
          { type: 'toolCall', id: 'tc1', name: 'edit', arguments: { path: 'src/a.ts' } },
        ],
        usage: { input: 1, output: 2 },
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
    'history maps Pi run-summary and runtime totals',
    history.some((m) => m.type === 'run-summary' && m.turnId === 'a1' && m.userMessageKey === 'u1' && m.totalRuntimeMs === 4500 && m.tokens?.input === 1 && m.tokens.output === 2) &&
      history.some((m) => m.type === 'metadata-update' && m.key === 'runtimeTotals' && (m.value as any).totalRuntimeMs === 4500 && (m.value as any).turnCount === 1),
    JSON.stringify(history.filter((m) => m.type === 'run-summary' || (m.type === 'metadata-update' && m.key === 'runtimeTotals'))),
  );

  appendFileSync(sessionFile, jsonl({ type: 'message', id: 'u2', timestamp: '2026-06-16T00:00:06.000Z', message: { role: 'user', content: [{ type: 'text', text: 'OBSERVELIVE' }] } }));
  for (let i = 0; i < 20 && !live.some((m) => m.type === 'user-message' && /OBSERVELIVE/.test(m.text)); i++) await sleep(100);
  check('observe attach tails appended JSONL messages', live.some((m) => m.type === 'user-message' && /OBSERVELIVE/.test(m.text)));

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
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed) {
  console.error(`\nFAIL: ${failed} Pi observe check(s) failed.`);
  process.exit(1);
}

console.log('\nPASS');
