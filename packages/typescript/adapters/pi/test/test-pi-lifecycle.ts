/**
 * Pi native fork/clone regression: fake JSON-RPC `pi` binary, no real Pi, no model.
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

const root = mkdtempSync(join(tmpdir(), 'cosyncing-pi-lifecycle-'));
const sessionsRoot = join(root, 'sessions');
const bin = join(root, 'pi');
const cwd = join(root, 'work');
const commandLog = join(root, 'commands.jsonl');
const parentFile = join(sessionsRoot, '2026-07-03_parent.jsonl');
const forkFile = join(sessionsRoot, '2026-07-03_fork.jsonl');
const cloneFile = join(sessionsRoot, '2026-07-03_clone.jsonl');
mkdirSync(sessionsRoot, { recursive: true });
mkdirSync(cwd, { recursive: true });
writeFileSync(parentFile, JSON.stringify({ type: 'session', id: 'parent', timestamp: '2026-07-03T00:00:00.000Z', cwd }) + '\n');
writeFileSync(
  bin,
  `#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const parent = args[args.indexOf('--session') + 1];
let current = parent;
const commandLog = ${JSON.stringify(commandLog)};
const cwd = ${JSON.stringify(cwd)};
const forkFile = ${JSON.stringify(forkFile)};
const cloneFile = ${JSON.stringify(cloneFile)};
function writeSession(file, id, name) {
  writeFileSync(file, JSON.stringify({ type: 'session', id, timestamp: '2026-07-03T00:00:01.000Z', cwd }) + '\\n' + JSON.stringify({ type: 'session_info', id: id + '-info', timestamp: '2026-07-03T00:00:02.000Z', name }) + '\\n');
}
function send(id, payload) {
  process.stdout.write(JSON.stringify({ type: 'response', id, ...payload }) + '\\n');
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
    if (req.type === 'fork') {
      if (req.messageId === 'cancel-me') {
        send(req.id, { success: false, error: 'cancelled by extension secret=PI_LIFECYCLE_SECRET' });
      } else if (req.messageId === 'fail-secret') {
        send(req.id, { success: false, error: 'native fork failed secret=PI_LIFECYCLE_SECRET' });
      } else {
        current = forkFile;
        writeSession(current, 'fork-child', 'Fork child');
        send(req.id, { success: true, data: { sessionFile: current, sessionId: 'fork-child', sessionName: 'Fork child' } });
      }
    } else if (req.type === 'clone') {
      current = cloneFile;
      writeSession(current, 'clone-child', 'Clone child');
      send(req.id, { success: true, data: { sessionFile: current, sessionId: 'clone-child', sessionName: 'Clone child' } });
    } else if (req.type === 'get_state') {
      const id = current === forkFile ? 'fork-child' : current === cloneFile ? 'clone-child' : 'parent';
      const name = current === forkFile ? 'Fork child' : current === cloneFile ? 'Clone child' : 'Parent';
      send(req.id, { success: true, data: { sessionFile: current, sessionId: id, sessionName: name, model: { provider: 'fake', id: 'pi-fake', name: 'Pi Fake' } } });
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
  process.env.COSYNCING_PI_BIN = bin;
  process.env.COSYNCING_PI_SESSIONS_ROOT = sessionsRoot;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionsRoot;
  const { PiAdapter } = await import('../src/index.ts');
  const adapter = new PiAdapter({ brokerUrl: 'http://127.0.0.1:7734' });
  const id = Buffer.from(parentFile, 'utf8').toString('base64url');

  const forked = await adapter.forkSession?.(id, { messageId: 'msg-123' });
  const cloned = await adapter.cloneSession?.(id);
  const commands = readFileSync(commandLog, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const forkCommand = commands.find((cmd) => cmd.type === 'fork' && cmd.messageId === 'msg-123');
  const cloneCommand = commands.find((cmd) => cmd.type === 'clone');
  check('Pi fork hook is exposed', typeof adapter.forkSession === 'function');
  check('Pi fork sends selected message id as fork point', !!forkCommand, JSON.stringify(commands));
  check('Pi fork returns child SessionInfo', forked?.title === 'Fork child' && forked.id === Buffer.from(forkFile, 'utf8').toString('base64url'), JSON.stringify(forked));
  check('Pi clone hook is exposed separately from fork', typeof adapter.cloneSession === 'function' && !!cloneCommand, JSON.stringify(commands));
  check('Pi clone returns cloned child SessionInfo', cloned?.title === 'Clone child' && cloned.id === Buffer.from(cloneFile, 'utf8').toString('base64url'), JSON.stringify(cloned));

  let cancelled = false;
  let cancelledMessage = '';
  try {
    await adapter.forkSession?.(id, { messageId: 'cancel-me' });
  } catch (err) {
    cancelled = true;
    cancelledMessage = err instanceof Error ? err.message : String(err);
  }
  check('Pi fork extension cancellation is surfaced without secrets', cancelled && /cancelled/i.test(cancelledMessage) && !/PI_LIFECYCLE_SECRET|secret=/.test(cancelledMessage), cancelledMessage);

  let failed = false;
  let failureMessage = '';
  try {
    await adapter.forkSession?.(id, { messageId: 'fail-secret' });
  } catch (err) {
    failed = true;
    failureMessage = err instanceof Error ? err.message : String(err);
  }
  check('Pi fork failure throws non-secret error', failed && !/PI_LIFECYCLE_SECRET|secret=/.test(failureMessage), failureMessage);
} finally {
  if (!process.env.COSYNCING_KEEP_TEST_TMP && existsSync(root)) rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
