/**
 * Pi native rename regression: fake JSON-RPC `pi` binary, no real Pi, no model.
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

const root = mkdtempSync(join(tmpdir(), 'cosyncing-pi-rename-'));
const sessionsRoot = join(root, 'sessions');
const bin = join(root, 'pi');
const cwd = join(root, 'work');
const sessionFile = join(sessionsRoot, '2026-07-02_fake.jsonl');
mkdirSync(sessionsRoot, { recursive: true });
mkdirSync(cwd, { recursive: true });
writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: 'fake-session', timestamp: '2026-07-02T00:00:00.000Z', cwd }) + '\n');
writeFileSync(
  bin,
  `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const session = args[args.indexOf('--session') + 1];
let title = 'Old title';
try {
  for (const line of readFileSync(session, 'utf8').trim().split('\\n')) {
    const obj = JSON.parse(line);
    if (obj?.type === 'session_info' && typeof obj.name === 'string') title = obj.name;
  }
} catch {}
function send(id, payload) {
  process.stdout.write(JSON.stringify({ type: 'response', id, ...payload }) + '\\n');
}
let buffered = '';
function handleChunk(chunk) {
  buffered += String(chunk);
  const lines = buffered.split('\\n');
  buffered = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    if (req.type === 'set_session_name') {
      if (req.name === 'fail-secret') {
        send(req.id, { success: false, error: 'native failed secret=PI_SHOULD_NOT_LEAK' });
      } else {
        title = String(req.name ?? '');
        writeFileSync(session, JSON.stringify({ type: 'session_info', id: 'rename', parentId: null, timestamp: '2026-07-02T00:00:01.000Z', name: title }) + '\\n', { flag: 'a' });
        send(req.id, { success: true, data: {} });
      }
    } else if (req.type === 'get_state') {
      send(req.id, { success: true, data: { sessionFile: session, sessionId: 'fake-session', sessionName: title, model: { provider: 'fake', id: 'pi-fake', name: 'Pi Fake' } } });
    } else {
      send(req.id, { success: false, error: 'unknown command ' + req.type });
    }
  }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', handleChunk);
process.stdin.resume();
`,
);
chmodSync(bin, 0o755);

try {
  process.env.COSYNCING_PI_BIN = bin;
  process.env.COSYNCING_PI_SESSIONS_ROOT = sessionsRoot;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionsRoot;
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
    check('fake Pi RPC binary responds directly', text.includes('"success":true'), text || errText || writeError || 'no stdout');
  }
  const { PiAdapter } = await import('../src/index.ts');
  const adapter = new PiAdapter({ brokerUrl: 'http://127.0.0.1:7734' });
  const id = Buffer.from(sessionFile, 'utf8').toString('base64url');

  const renamed = await adapter.renameSession?.(id, '  New Pi Title  ');
  const contents = readFileSync(sessionFile, 'utf8');
  check('Pi rename hook is exposed', typeof adapter.renameSession === 'function');
  check('Pi rename sends trimmed native set_session_name', contents.includes('"name":"New Pi Title"'), contents);
  check('Pi rename returns updated SessionInfo title', renamed?.title === 'New Pi Title' && renamed.id === id && renamed.tool === 'pi', JSON.stringify(renamed));

  let failed = false;
  let failureMessage = '';
  try {
    await adapter.renameSession?.(id, 'fail-secret');
  } catch (err) {
    failed = true;
    failureMessage = err instanceof Error ? err.message : String(err);
  }
  check('Pi rename failure throws non-secret error', failed && !/PI_SHOULD_NOT_LEAK|secret=/.test(failureMessage), failureMessage);
} finally {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
