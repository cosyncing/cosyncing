/**
 * omp lifecycle deltas: fake JSON-RPC `omp` binary, no real omp, no model. omp has no fork/clone
 * RPC, owns its title through the native `title` slot + `title_change` entries (set_session_name
 * rejects an empty name), and answers get_available_commands instead of pi's get_commands.
 */
export {};
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapPiJsonlText, ompNativePromptAckDeadlineMs } from '../../../pi-engine/src/implementation.ts';
import { OMP_DIALECT } from '../src/dialect.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`);
}

const root = mkdtempSync(join(tmpdir(), 'cosyncing-omp-lifecycle-'));
const sessionsRoot = join(root, 'sessions');
const fakeBinDir = join(root, 'bin');
const bin = join(root, 'omp');
const cwd = join(root, 'work');
const commandLog = join(root, 'commands.jsonl');
const sessionFile = join(sessionsRoot, '2026-08-25_fake.jsonl');
mkdirSync(sessionsRoot, { recursive: true });
mkdirSync(fakeBinDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
writeFileSync(sessionFile, [
  JSON.stringify({ type: 'title', v: 1, title: '', updatedAt: 1787000000000, pad: '' }),
  JSON.stringify({ type: 'session', version: 3, id: 'fake-omp-session', timestamp: '2026-08-25T00:00:00.000Z', cwd }),
  JSON.stringify({ type: 'title_change', id: 't1', parentId: null, timestamp: '2026-08-25T00:01:00.000Z', title: 'Original Omp Title', source: 'user', trigger: 'manual' }),
  JSON.stringify({ type: 'model_change', id: 'm1', parentId: 't1', timestamp: '2026-08-25T00:01:01.000Z', model: 'fake/omp-fake' }),
  JSON.stringify({ type: 'thinking_level_change', id: 'tl1', parentId: 'm1', timestamp: '2026-08-25T00:01:02.000Z', thinkingLevel: 'medium' }),
].join('\n') + '\n');

// The fake omp carries a `#!/usr/bin/env bun` shebang, which puts omp readiness on the BUN branch:
// the effective interpreter is PATH `bun`, probed with `--version`. The real bun here is older than
// omp's floor, so a passthrough shim answers the probe with a supported version and execs the real
// bun for everything else (including the fake omp itself, launched through that same shebang).
const realBun = Bun.which('bun');
if (!realBun) throw new Error('bun must be on PATH for the omp lifecycle fixture');
writeFileSync(
  join(fakeBinDir, 'bun'),
  `#!/bin/sh
if [ "$1" = "--version" ]; then echo 1.3.14; exit 0; fi
exec ${JSON.stringify(realBun)} "$@"
`,
);
chmodSync(join(fakeBinDir, 'bun'), 0o755);

writeFileSync(
  bin,
  `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('17.4.2');
  process.exit(0);
}
const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const commandLog = ${JSON.stringify(commandLog)};
appendFileSync(commandLog, JSON.stringify({ type: 'fixture_env', agentDir: process.env.PI_CODING_AGENT_DIR, args }) + '\\n');
let current = at('--session');
let selectedProvider = 'fake';
let selectedModel = 'omp-fake';
let selectedThinking = at('--thinking') ?? 'high';
if (!current) {
  // create flow: no --session, a new file lands in the --session-dir the adapter passes
  const dir = at('--session-dir');
  if (!dir) throw new Error('fake omp create requires --session-dir');
  current = dir + '/2026-08-25_created.jsonl';
  writeFileSync(current, [
    JSON.stringify({ type: 'title', v: 1, title: '', updatedAt: 1787000000000, pad: '' }),
    JSON.stringify({ type: 'session', version: 3, id: 'created-session', timestamp: '2026-08-25T00:00:00.000Z', cwd: process.cwd() }),
  ].join('\\n') + '\\n');
}
function currentTitle() {
  // omp's durable title: the leading title slot plus title_change events, last write wins
  let title = '';
  try {
    for (const line of readFileSync(current, 'utf8').split('\\n')) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line);
      if (obj?.type === 'title' && typeof obj.title === 'string') title = obj.title;
      else if (obj?.type === 'title_change' && typeof obj.title === 'string') title = obj.title;
      else if (obj?.type === 'session_info' && typeof obj.name === 'string') title = obj.name;
    }
  } catch {}
  return title;
}
function send(id, payload) {
  process.stdout.write(JSON.stringify({ type: 'response', id, ...payload }) + '\\n');
}
function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + '\\n');
}
let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffered += String(chunk);
  const lines = buffered.split('\\n');
  buffered = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    appendFileSync(commandLog, JSON.stringify(req) + '\\n');
    if (req.type === 'set_session_name') {
      const name = String(req.name ?? '');
      if (name === 'fail-secret') {
        send(req.id, { success: false, error: 'native failed secret=OMP_SHOULD_NOT_LEAK' });
      } else if (name.trim() === '') {
        // Measured omp behavior: set_session_name rejects an empty name, so rename-to-clear
        // cannot clear an omp title the way it does on pi.
        send(req.id, { success: false, error: 'set_session_name: empty name rejected' });
      } else {
        // Real omp 17.4.2 acknowledges a zero-turn create title without always persisting it.
        // Keep rename persistence for existing sessions, but make create exercise materialization.
        if (!current.includes('created')) appendFileSync(current, JSON.stringify({ type: 'title_change', id: 'tc-' + Date.now(), parentId: null, timestamp: '2026-08-25T00:00:01.000Z', title: name, source: 'user', trigger: 'manual' }) + '\\n');
        send(req.id, { success: true, data: {} });
      }
    } else if (req.type === 'set_model') {
      selectedProvider = String(req.provider ?? '');
      selectedModel = String(req.modelId ?? '');
      send(req.id, { success: true, data: { provider: selectedProvider, id: selectedModel } });
    } else if (req.type === 'set_thinking_level') {
      selectedThinking = String(req.level ?? '');
      send(req.id, { success: true, data: {} });
    } else if (req.type === 'prompt') {
      send(req.id, { success: true, data: {} });
      const rawPrompt = String(req.message ?? '');
      const rpcPrefix = '/__cosyncing_rpc_prompt ';
      const rpcPayload = rawPrompt.startsWith(rpcPrefix)
        ? JSON.parse(Buffer.from(rawPrompt.slice(rpcPrefix.length), 'base64url').toString('utf8'))
        : undefined;
      const retryPrompt = String(rpcPayload?.text ?? rawPrompt);
      const correlatedSentAt = Number(rpcPayload?.sentAt);
      const promptAt = Number.isFinite(correlatedSentAt)
        ? correlatedSentAt
        : Date.parse('2026-08-25T00:02:00.000Z');
      const at = (offsetMs) => new Date(promptAt + offsetMs).toISOString();
      const userMessage = rpcPayload ? {
        role: 'custom',
        customType: 'collab-prompt',
        content: Array.isArray(rpcPayload.images) && rpcPayload.images.length
          ? [...(rpcPayload.text ? [{ type: 'text', text: rpcPayload.text }] : []), ...rpcPayload.images]
          : rpcPayload.text,
        display: true,
        attribution: 'user',
        details: {
          from: 'cosyncing',
          messageKey: rpcPayload.messageKey,
          clientKey: rpcPayload.clientKey,
          sentAt: rpcPayload.sentAt,
        },
        timestamp: at(0),
      } : { role: 'user', timestamp: at(0) };
      if (retryPrompt.includes('async extension reject')) {
        emit({ type: 'response', command: 'extension_send', success: false, error: 'async native failure' });
        continue;
      }
      if (retryPrompt.includes('delayed queued steer')) {
        // Native OMP can publish the held run's terminal end before its post-settle stranded-queue
        // drain starts the just-arrived steer. The pending correlation must survive this event.
        emit({ type: 'agent_end', timestamp: at(0) });
        setTimeout(() => {
          emit({ type: 'agent_start', timestamp: at(0) });
          emit({ type: 'turn_start', timestamp: at(0) });
          emit({ type: 'message_start', message: userMessage });
          emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'delayed accepted' } });
          emit({ type: 'message_end', timestamp: at(1_000), message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'delayed accepted' }], usage: { input: 2, output: 2 } } });
          emit({ type: 'agent_end', timestamp: at(1_000) });
        }, 150);
        continue;
      }
      emit({ type: 'agent_start', timestamp: at(0) });
      emit({ type: 'turn_start', timestamp: at(0) });
      emit({ type: 'message_start', message: userMessage });
      if (retryPrompt.includes('hold stream open')) {
        emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'still working' } });
        continue;
      }
      if (retryPrompt.includes('retry then succeed') || retryPrompt.includes('retry then fail')) {
        emit({ type: 'message_end', timestamp: at(1_000), message: { role: 'assistant', stopReason: 'error', error: { message: 'transient fixture error' }, usage: { input: 1, output: 0 } } });
        emit({ type: 'auto_retry_start', timestamp: at(1_010), attempt: 1, maxAttempts: 3, errorMessage: 'transient fixture error' });
        emit({ type: 'agent_end', timestamp: at(1_015), isTerminal: false });
        emit({ type: 'agent_start', timestamp: at(1_016) });
        if (retryPrompt.includes('retry then fail')) {
          emit({ type: 'message_end', timestamp: at(2_000), message: { role: 'assistant', stopReason: 'error', error: { message: 'final fixture error' }, usage: { input: 2, output: 0 } } });
          emit({ type: 'auto_retry_end', success: false, finalError: 'final fixture error' });
          emit({ type: 'agent_end', timestamp: at(2_010), isTerminal: true });
          continue;
        }
        emit({ type: 'auto_retry_end', timestamp: at(1_020), success: true });
        emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'recovered' } });
        emit({ type: 'message_end', timestamp: at(2_000), message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'recovered' }], usage: { input: 2, output: 1 } } });
        emit({ type: 'agent_end', timestamp: at(2_000) });
        continue;
      }
      emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', toolCall: { id: 'read-1', name: 'read', arguments: { path: 'fixture.txt' } } } });
      emit({ type: 'tool_execution_end', toolCallId: 'read-1', toolName: 'read', result: { content: [{ type: 'text', text: 'fixture tool result' }] }, isError: false });
      emit({ type: 'message_end', timestamp: at(1_000), message: { role: 'assistant', stopReason: 'stop', usage: {} } });
      emit({ type: 'agent_end', timestamp: at(1_000) });
    } else if (req.type === 'get_available_commands') {
      send(req.id, { success: true, data: { commands: [{ name: 'review', description: 'Review the diff' }, { name: 'omp:sync', description: 'Sync things' }, { name: '__cosyncing_rpc_prompt', description: 'Internal transport' }] } });
    } else if (req.type === 'get_available_models') {
      send(req.id, { success: true, data: { models: [{ provider: 'fake', id: 'omp-fake', name: 'Omp Fake', reasoning: true, thinking: { mode: 'effort', efforts: ['low', 'medium', 'xhigh'], requiresEffort: true } }] } });
    } else if (req.type === 'get_state') {
      send(req.id, { success: true, data: { sessionFile: current, sessionId: current.includes('created') ? 'created-session' : 'fake-omp-session', sessionName: currentTitle(), model: { provider: selectedProvider, id: selectedModel, name: 'Omp Fake' }, thinkingLevel: selectedThinking } });
    } else {
      send(req.id, { success: false, error: 'unknown command ' + req.type });
    }
  }
});
process.stdin.resume();
`,
);
chmodSync(bin, 0o755);

try {
  process.env.HOME = root;
  process.env.COSYNCING_OMP_BIN = bin;
  process.env.COSYNCING_OMP_AGENT_DIR = join(root, 'omp-agent');
  process.env.COSYNCING_OMP_SESSIONS_ROOT = sessionsRoot;
  process.env.COSYNCING_OMP_BRIDGE_AUTOINSTALL = '0';
  process.env.PATH = `${fakeBinDir}:${process.env.PATH ?? ''}`;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  delete process.env.PI_CONFIG_DIR;
  delete process.env.XDG_DATA_HOME;

  const retryUser = {
    type: 'message', id: 'retry-user', parentId: null, timestamp: '2026-08-25T00:10:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'retry replay' }], timestamp: Date.parse('2026-08-25T00:10:00.000Z') },
  };
  const superseded = (id: string, parentId: string, attempt: number, timestamp: string) => ({
    type: 'message', id, parentId, timestamp,
    message: {
      role: 'assistant', content: [], stopReason: 'error', error: { message: `attempt ${attempt}` },
      usage: { input: 1, output: 0 },
      retryRecovery: { kind: 'auto-retry', status: 'superseded', attempt },
    },
  });
  const recoveredRows = mapPiJsonlText([
    retryUser,
    superseded('retry-error-1', 'retry-user', 1, '2026-08-25T00:10:01.000Z'),
    superseded('retry-error-2', 'retry-error-1', 2, '2026-08-25T00:10:02.000Z'),
    {
      type: 'message', id: 'retry-success', parentId: 'retry-error-2', timestamp: '2026-08-25T00:10:03.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'recovered' }], stopReason: 'stop', usage: { input: 2, output: 1 } },
    },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n', 0, OMP_DIALECT);
  const recoveredSummaries = recoveredRows.filter((row) => row.type === 'run-summary');
  check('OMP replay keeps superseded retry errors in one turn and emits only the final done summary',
    recoveredSummaries.length === 1
      && recoveredSummaries[0]?.type === 'run-summary'
      && recoveredSummaries[0].status === 'done'
      && recoveredSummaries[0].tokens?.input === 4
      && recoveredSummaries[0].tokens.output === 1,
    JSON.stringify(recoveredSummaries));

  const exhaustedRows = mapPiJsonlText([
    retryUser,
    superseded('retry-exhausted-1', 'retry-user', 1, '2026-08-25T00:11:01.000Z'),
    {
      type: 'message', id: 'retry-final-error', parentId: 'retry-exhausted-1', timestamp: '2026-08-25T00:11:02.000Z',
      message: { role: 'assistant', content: [], stopReason: 'error', error: { message: 'gave up' }, usage: { input: 2, output: 0 } },
    },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n', 0, OMP_DIALECT);
  const exhaustedSummaries = exhaustedRows.filter((row) => row.type === 'run-summary');
  check('OMP replay emits one terminal error only after the unsuperseded final attempt',
    exhaustedSummaries.length === 1
      && exhaustedSummaries[0]?.type === 'run-summary'
      && exhaustedSummaries[0].status === 'error',
    JSON.stringify(exhaustedSummaries));

  const correlatedImageRows = mapPiJsonlText([
    {
      type: 'custom_message', id: 'image-only-user', parentId: null,
      timestamp: '2026-08-25T00:20:02.000Z', customType: 'collab-prompt',
      content: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }],
      display: true, attribution: 'user',
      details: { from: 'cosyncing', messageKey: 'u:remote:image-only', clientKey: 'omp-image-only', sentAt: Date.parse('2026-08-25T00:20:01.000Z') },
    },
    {
      type: 'message', id: 'image-only-answer', parentId: 'image-only-user',
      timestamp: '2026-08-25T00:20:04.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'image received' }], stopReason: 'stop', usage: { input: 3, output: 2 } },
    },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n', 0, OMP_DIALECT);
  const correlatedImageUser = correlatedImageRows.find((row) => row.type === 'user-message');
  const correlatedImageRun = correlatedImageRows.find((row) => row.type === 'run-summary');
  check('OMP replay preserves image-only correlated prompts and their app-send clock',
    correlatedImageUser?.type === 'user-message'
      && correlatedImageUser.text === ''
      && correlatedImageUser.imageCount === 1
      && correlatedImageUser.sentAt === Date.parse('2026-08-25T00:20:01.000Z')
      && correlatedImageRun?.type === 'run-summary'
      && correlatedImageRun.startedAt === Date.parse('2026-08-25T00:20:01.000Z')
      && correlatedImageRun.totalRuntimeMs === 3_000,
    JSON.stringify(correlatedImageRows));

  const mixedText = '  indented code\ntrailing spaces  ';
  const correlatedMixedRows = mapPiJsonlText([
    {
      type: 'custom_message', id: 'mixed-user', parentId: null,
      timestamp: '2026-08-25T00:21:02.000Z', customType: 'collab-prompt',
      content: [
        { type: 'text', text: mixedText },
        { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
      ],
      display: true, attribution: 'user',
      details: { from: 'cosyncing', messageKey: 'u:remote:mixed', clientKey: 'omp-mixed', sentAt: Date.parse('2026-08-25T00:21:01.000Z') },
    },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n', 0, OMP_DIALECT);
  const correlatedMixedUser = correlatedMixedRows.find((row) => row.type === 'user-message');
  check('OMP replay preserves exact whitespace and image count for mixed prompts',
    correlatedMixedUser?.type === 'user-message'
      && correlatedMixedUser.text === mixedText
      && correlatedMixedUser.imageCount === 1,
    JSON.stringify(correlatedMixedRows));
  check('OMP persistence deadlines distinguish initial prompts from queued steers',
    ompNativePromptAckDeadlineMs(false) === 15_000
      && ompNativePromptAckDeadlineMs(true) === undefined);

  {
    const proc = Bun.spawn([bin, '--mode', 'rpc', '--session', sessionFile], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    const reader = proc.stdout.getReader();
    let writeError = '';
    try {
      proc.stdin.write(JSON.stringify({ id: 'direct-1', type: 'set_session_name', name: 'Direct Title' }) + '\n');
      proc.stdin.flush();
    } catch (err) {
      writeError = err instanceof Error ? err.message : String(err);
    }
    const first = await Promise.race([
      reader.read(),
      new Promise<any>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 2000)),
    ]);
    try {
      proc.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    const errText = await Promise.race([
      new Response(proc.stderr).text().catch(() => ''),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 1000)),
    ]);
    const text = first.value ? new TextDecoder().decode(first.value) : '';
    check('fake omp RPC binary responds directly', text.includes('"success":true'), text || errText || writeError || 'no stdout');
  }

  const { OmpAdapter } = await import('../src/index.ts');
  const adapter = new OmpAdapter({ brokerUrl: 'http://127.0.0.1:7734' });
  const id = Buffer.from(sessionFile, 'utf8').toString('base64url');
  const readCommands = () => readFileSync(commandLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

  // omp has no fork/clone RPC: the adapter must not even expose the hooks, so the broker derives
  // canFork/canClone=false instead of offering an action omp would reject.
  check('omp omits the fork hook', typeof (adapter as any).forkSession === 'undefined');
  check('omp omits the clone hook', typeof (adapter as any).cloneSession === 'undefined');

  const renamed = await adapter.renameSession?.(id, '  New Omp Title  ');
  check('dialect-specific agent dir reaches the native omp process variable',
    readCommands().some((cmd) => cmd.type === 'fixture_env' && cmd.agentDir === join(root, 'omp-agent')),
    JSON.stringify(readCommands().filter((cmd) => cmd.type === 'fixture_env')));
  const renamedContents = readFileSync(sessionFile, 'utf8');
  check('omp rename hook is exposed', typeof adapter.renameSession === 'function');
  check(
    'omp rename appends a title_change entry, not pi session_info',
    renamedContents.includes('"type":"title_change"') && renamedContents.includes('"title":"New Omp Title"') && !renamedContents.includes('session_info'),
    renamedContents,
  );
  check('omp rename returns updated SessionInfo title and native identity',
    renamed?.title === 'New Omp Title'
      && renamed.id === id
      && renamed.nativeId === 'fake-omp-session'
      && renamed.tool === 'omp',
    JSON.stringify(renamed));

  let failed = false;
  let failureMessage = '';
  try {
    await adapter.renameSession?.(id, 'fail-secret');
  } catch (err) {
    failed = true;
    failureMessage = err instanceof Error ? err.message : String(err);
  }
  check('omp rename failure throws non-secret error', failed && !/OMP_SHOULD_NOT_LEAK|secret=/.test(failureMessage), failureMessage);

  // Measured on omp 17.4.2: set_session_name rejects an empty name. Clearing a title by renaming
  // to '' works on pi; on omp it must surface as a refusal, never as silent success.
  let cleared = true;
  let clearMessage = '';
  try {
    await adapter.renameSession?.(id, '');
  } catch (err) {
    cleared = false;
    clearMessage = err instanceof Error ? err.message : String(err);
  }
  check('omp rename-to-clear is refused (native rejects empty names)', !cleared, clearMessage);

  // Create with a title: omp owns the title natively, so the adapter sends set_session_name and the
  // engine must NOT append a pi-style session_info entry (createTimeTitle 'native').
  const created = await adapter.createSession({
    directory: cwd,
    title: 'Created Title',
    model: { providerID: 'fake', modelID: 'omp-fake', reasoningEffort: 'medium' },
  });
  const createdFile = join(sessionsRoot, '2026-08-25_created.jsonl');
  const createdContents = existsSync(createdFile) ? readFileSync(createdFile, 'utf8') : '';
  check('omp create returns the created session with native identity',
    created?.title === 'Created Title'
      && created?.nativeId === 'created-session'
      && created?.tool === 'omp',
    JSON.stringify(created));
  check('omp terminal handoff pins the exact readiness-qualified executable and session file',
    created.control?.terminalSync?.command === `'${bin}' --session '${createdFile}'`,
    String(created.control?.terminalSync?.command));
  check(
    'omp create names the session through set_session_name',
    readCommands().some((cmd) => cmd.type === 'set_session_name' && cmd.name === 'Created Title'),
    JSON.stringify(readCommands().map((cmd) => cmd.type)),
  );
  check(
    'omp create file carries a title_change and NO session_info entry',
    createdContents.includes('"type":"title_change"')
      && createdContents.includes('"title":"Created Title"')
      && createdContents.includes('"type":"model_change"')
      && createdContents.includes('"model":"fake/omp-fake"')
      && createdContents.includes('"type":"thinking_level_change"')
      && createdContents.includes('"thinkingLevel":"medium"')
      && !createdContents.includes('session_info'),
    createdContents,
  );

  // Resume attach: the command list comes from get_available_commands, never pi's get_commands.
  const conn = await adapter.attach(id, 'resume');
  const liveMessages: any[] = [];
  const unsubscribe = conn.subscribe((message) => liveMessages.push(message));
  const commands = (await conn.listCommands?.()) ?? [];
  const models = (await conn.listModels?.()) ?? [];
  const log = readCommands();
  check(
    'omp resume launches with the durable model and thinking effort',
    log.some((cmd) =>
      cmd.type === 'fixture_env'
      && cmd.args?.includes('--model')
      && cmd.args?.includes('fake/omp-fake')
      && cmd.args?.includes('--thinking')
      && cmd.args?.includes('medium')
    ),
    JSON.stringify(log.filter((cmd) => cmd.type === 'fixture_env').map((cmd) => cmd.args)),
  );
  check(
    'omp resume attach lists native commands via get_available_commands',
    commands.some((cmd) => cmd.name === 'review')
      && !commands.some((cmd) => cmd.name === '__cosyncing_rpc_prompt')
      && log.some((cmd) => cmd.type === 'get_available_commands'),
    JSON.stringify(commands.map((cmd) => cmd.name)),
  );
  check(
    'omp never calls pi-only RPCs (get_commands/fork/clone)',
    !log.some((cmd) => cmd.type === 'get_commands' || cmd.type === 'fork' || cmd.type === 'clone'),
    JSON.stringify(log.map((cmd) => cmd.type)),
  );
  check(
    'omp model catalog preserves the native supported thinking efforts exactly',
    models.length === 1
      && models[0]?.reasoningEfforts?.map((effort) => effort.effort).join(',') === 'low,medium,xhigh',
    JSON.stringify(models),
  );
  const uploadText = 'OMP-UPLOAD-CONTENT-42';
  await conn.sendFile?.({
    name: 'note.txt',
    mimeType: 'text/plain',
    data: Buffer.from(uploadText).toString('base64'),
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const inboxFile = join(cwd, '.cosyncing', 'inbox', 'note.txt');
  const prompt = readCommands().findLast((cmd) => cmd.type === 'prompt');
  const rpcPrefix = '/__cosyncing_rpc_prompt ';
  const promptPayload = String(prompt?.message ?? '').startsWith(rpcPrefix)
    ? JSON.parse(Buffer.from(String(prompt.message).slice(rpcPrefix.length), 'base64url').toString('utf8'))
    : undefined;
  check(
    'omp upload writes byte-exact inbox content and references its absolute path',
    existsSync(inboxFile) && readFileSync(inboxFile, 'utf8') === uploadText && String(promptPayload?.text ?? '').includes(inboxFile),
    JSON.stringify(promptPayload),
  );
  check(
    'omp RPC tool result uses the shared enriched mapper',
    liveMessages.some((message) => message.type === 'tool-result' && message.toolName === 'read' && message.result === 'fixture tool result'),
    JSON.stringify(liveMessages.map((message) => message.type)),
  );
  const correlationStart = liveMessages.length;
  await conn.sendPrompt({ text: 'durable correlation', clientMessageId: 'omp-correlation-client' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const correlatedUsers = liveMessages.slice(correlationStart)
    .filter((message) => message.type === 'user-message' && message.clientKey === 'omp-correlation-client');
  check(
    'omp broker-owned RPC prompt reconciles one queued row to one durable native correlation',
    correlatedUsers.length === 2
      && correlatedUsers[0]?.queued === true
      && correlatedUsers[1]?.queued === false
      && correlatedUsers[0]?.key === correlatedUsers[1]?.key
      && correlatedUsers[0]?.sentAt === correlatedUsers[1]?.sentAt
      && String(correlatedUsers[0]?.key ?? '').startsWith('u:remote:'),
    JSON.stringify(correlatedUsers),
  );
  const imageStart = liveMessages.length;
  await conn.sendPrompt({
    text: '',
    images: [{ data: 'aW1hZ2U=', mimeType: 'image/png' }],
    clientMessageId: 'omp-live-image-client',
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const imageUsers = liveMessages.slice(imageStart)
    .filter((message) => message.type === 'user-message' && message.clientKey === 'omp-live-image-client');
  check('OMP RPC preserves imageCount for image-only queued and durable rows',
    imageUsers.length === 2
      && imageUsers.every((message) => message.text === '' && message.imageCount === 1)
      && imageUsers[0]?.key === imageUsers[1]?.key,
    JSON.stringify(imageUsers));
  const mixedLiveStart = liveMessages.length;
  const mixedLiveText = '  exact markdown\ncode tail  ';
  await conn.sendPrompt({
    text: mixedLiveText,
    images: [{ data: 'aW1hZ2U=', mimeType: 'image/png' }],
    clientMessageId: 'omp-live-mixed-client',
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const mixedLiveUsers = liveMessages.slice(mixedLiveStart)
    .filter((message) => message.type === 'user-message' && message.clientKey === 'omp-live-mixed-client');
  check('OMP RPC preserves exact whitespace and image count for mixed queued and durable rows',
    mixedLiveUsers.length === 2
      && mixedLiveUsers.every((message) => message.text === mixedLiveText && message.imageCount === 1)
      && mixedLiveUsers[0]?.key === mixedLiveUsers[1]?.key,
    JSON.stringify(mixedLiveUsers));
  const retryLiveStart = liveMessages.length;
  await conn.sendPrompt({ text: 'retry then succeed', clientMessageId: 'omp-retry-client' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const retrySummaries = liveMessages.slice(retryLiveStart)
    .filter((message) => message.type === 'run-summary');
  check('OMP RPC retry stays on one summary key and closes once with the recovered result',
    new Set(retrySummaries.map((message) => message.key)).size === 1
      && retrySummaries.filter((message) => message.status === 'done').length === 1
      && !retrySummaries.some((message) => message.status === 'error')
      && retrySummaries.at(-1)?.status === 'done',
    JSON.stringify(retrySummaries));
  const exhaustedLiveStart = liveMessages.length;
  await conn.sendPrompt({ text: 'retry then fail', clientMessageId: 'omp-retry-failed-client' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const exhaustedLiveSummaries = liveMessages.slice(exhaustedLiveStart)
    .filter((message) => message.type === 'run-summary');
  const exhaustedFinal = exhaustedLiveSummaries.find((message) => message.status === 'error');
  check('OMP RPC nonterminal agent_end preserves one key and the final assistant completion clock on exhaustion',
    new Set(exhaustedLiveSummaries.map((message) => message.key)).size === 1
      && exhaustedLiveSummaries.filter((message) => message.status === 'error').length === 1
      && exhaustedFinal?.completedAt === (exhaustedFinal?.startedAt ?? 0) + 2_000
      && exhaustedFinal?.totalRuntimeMs === 2_000
      && exhaustedFinal?.tokens?.input === 3,
    JSON.stringify(exhaustedLiveSummaries));
  await conn.sendPrompt({ text: 'hold stream open', clientMessageId: 'omp-hold-stream' });
  let delayedSettled = false;
  const delayedSteer = conn.sendPrompt({ text: 'delayed queued steer', clientMessageId: 'omp-delayed-steer' })
    .finally(() => { delayedSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const delayedWasPending = !delayedSettled;
  await delayedSteer;
  const delayedUsers = liveMessages.filter((message) =>
    message.type === 'user-message' && message.clientKey === 'omp-delayed-steer');
  check('OMP streaming steer survives terminal agent_end until the stranded queue emits its exact next turn',
    delayedWasPending
      && delayedUsers.length === 2
      && delayedUsers[0]?.queued === true
      && delayedUsers[1]?.queued === false
      && delayedUsers[0]?.key === delayedUsers[1]?.key,
    JSON.stringify(delayedUsers));
  // Let the delayed turn's terminal agent_end reach the connection before opening the separate
  // explicit extension-failure scenario below.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const asyncPrompt = conn.sendPrompt({ text: 'async extension reject', clientMessageId: 'omp-async-reject-client' });
  // Enqueue before the first promise settles: this is the admission race the outer closed check
  // cannot see. The critical-section recheck must reject it without even an optimistic row.
  const behindFailure = conn.sendPrompt({ text: 'must not follow async reject', clientMessageId: 'omp-after-async-reject' });
  const [asyncResult, behindResult] = await Promise.allSettled([asyncPrompt, behindFailure]);
  const asyncRejected = asyncResult.status === 'rejected';
  const asyncFailure = asyncResult.status === 'rejected'
    ? (asyncResult.reason instanceof Error ? asyncResult.reason.message : String(asyncResult.reason))
    : '';
  const closedRejected = behindResult.status === 'rejected';
  const failedCorrelationRows = liveMessages.filter((message) =>
    message.type === 'user-message' && message.clientKey === 'omp-async-reject-client');
  const afterFailureRows = liveMessages.filter((message) =>
    message.type === 'user-message' && message.clientKey === 'omp-after-async-reject');
  check('OMP async extension-send rejection fails closed without a false durable correlation',
    asyncRejected
      && closedRejected
      && /before native persistence/.test(asyncFailure)
      && failedCorrelationRows.length === 1
      && failedCorrelationRows[0]?.queued === true
      && afterFailureRows.length === 0,
    JSON.stringify({ asyncFailure, failedCorrelationRows, afterFailureRows }));
  unsubscribe();
  await conn.close();
} finally {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
