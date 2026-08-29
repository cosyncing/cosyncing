/**
 * omp lifecycle deltas: fake JSON-RPC `omp` binary, no real omp, no model. omp has no fork/clone
 * RPC, owns its title through the native `title` slot + `title_change` entries (set_session_name
 * rejects an empty name), and answers get_available_commands instead of pi's get_commands.
 */
export {};
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
appendFileSync(commandLog, JSON.stringify({ type: 'fixture_env', agentDir: process.env.PI_CODING_AGENT_DIR }) + '\\n');
let current = at('--session');
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
        appendFileSync(current, JSON.stringify({ type: 'title_change', id: 'tc-' + Date.now(), parentId: null, timestamp: '2026-08-25T00:00:01.000Z', title: name, source: 'user', trigger: 'manual' }) + '\\n');
        send(req.id, { success: true, data: {} });
      }
    } else if (req.type === 'prompt') {
      send(req.id, { success: true, data: {} });
      emit({ type: 'agent_start', timestamp: '2026-08-25T00:02:00.000Z' });
      emit({ type: 'turn_start', timestamp: '2026-08-25T00:02:00.000Z' });
      emit({ type: 'message_start', message: { role: 'user', timestamp: '2026-08-25T00:02:00.000Z' } });
      emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', toolCall: { id: 'read-1', name: 'read', arguments: { path: 'fixture.txt' } } } });
      emit({ type: 'tool_execution_end', toolCallId: 'read-1', toolName: 'read', result: { content: [{ type: 'text', text: 'fixture tool result' }] }, isError: false });
      emit({ type: 'message_end', timestamp: '2026-08-25T00:02:01.000Z', message: { role: 'assistant', stopReason: 'stop', usage: {} } });
      emit({ type: 'agent_end', timestamp: '2026-08-25T00:02:01.000Z' });
    } else if (req.type === 'get_available_commands') {
      send(req.id, { success: true, data: { commands: [{ name: 'review', description: 'Review the diff' }, { name: 'omp:sync', description: 'Sync things' }] } });
    } else if (req.type === 'get_state') {
      send(req.id, { success: true, data: { sessionFile: current, sessionId: current.includes('created') ? 'created-session' : 'fake-omp-session', sessionName: currentTitle(), model: { provider: 'fake', id: 'omp-fake', name: 'Omp Fake' } } });
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
  check('omp rename returns updated SessionInfo title', renamed?.title === 'New Omp Title' && renamed.id === id && renamed.tool === 'omp', JSON.stringify(renamed));

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
  const created = await adapter.createSession({ directory: cwd, title: 'Created Title' });
  const createdFile = join(sessionsRoot, '2026-08-25_created.jsonl');
  const createdContents = existsSync(createdFile) ? readFileSync(createdFile, 'utf8') : '';
  check('omp create returns the created session', created?.title === 'Created Title' && created?.tool === 'omp', JSON.stringify(created));
  check(
    'omp create names the session through set_session_name',
    readCommands().some((cmd) => cmd.type === 'set_session_name' && cmd.name === 'Created Title'),
    JSON.stringify(readCommands().map((cmd) => cmd.type)),
  );
  check(
    'omp create file carries a title_change and NO session_info entry',
    createdContents.includes('"type":"title_change"') && createdContents.includes('"title":"Created Title"') && !createdContents.includes('session_info'),
    createdContents,
  );

  // Resume attach: the command list comes from get_available_commands, never pi's get_commands.
  const conn = await adapter.attach(id, 'resume');
  const liveMessages: any[] = [];
  const unsubscribe = conn.subscribe((message) => liveMessages.push(message));
  const commands = (await conn.listCommands?.()) ?? [];
  const log = readCommands();
  check(
    'omp resume attach lists native commands via get_available_commands',
    commands.some((cmd) => cmd.name === 'review') && log.some((cmd) => cmd.type === 'get_available_commands'),
    JSON.stringify(commands.map((cmd) => cmd.name)),
  );
  check(
    'omp never calls pi-only RPCs (get_commands/fork/clone)',
    !log.some((cmd) => cmd.type === 'get_commands' || cmd.type === 'fork' || cmd.type === 'clone'),
    JSON.stringify(log.map((cmd) => cmd.type)),
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
  check(
    'omp upload writes byte-exact inbox content and references its absolute path',
    existsSync(inboxFile) && readFileSync(inboxFile, 'utf8') === uploadText && String(prompt?.message ?? '').includes(inboxFile),
    String(prompt?.message ?? ''),
  );
  check(
    'omp RPC tool result uses the shared enriched mapper',
    liveMessages.some((message) => message.type === 'tool-result' && message.toolName === 'read' && message.result === 'fixture tool result'),
    JSON.stringify(liveMessages.map((message) => message.type)),
  );
  unsubscribe();
  await conn.close();
} finally {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
