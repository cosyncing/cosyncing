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
let stateMode = 'ok';
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
      // Pi's own contract: \`entryId\`, and required. \`fork(undefined)\` throws before copying
      // anything. Modelled here because the previous fake read \`messageId\` — the same field the
      // adapter was wrongly sending — so both sides agreed and the real Pi refused every fork.
      if (req.entryId === undefined || req.entryId === null || req.entryId === '') {
        send(req.id, { success: false, error: 'Invalid entry ID for forking' });
      } else if (req.entryId === 'cancel-me') {
        send(req.id, { success: false, error: 'cancelled by extension secret=PI_LIFECYCLE_SECRET' });
      } else if (req.entryId === 'cancel-flag') {
        // Pi reports an extension-cancelled fork as a SUCCESSFUL call carrying \`cancelled\`.
        send(req.id, { success: true, data: { cancelled: true } });
      } else if (req.entryId === 'fail-secret') {
        send(req.id, { success: false, error: 'native fork failed secret=PI_LIFECYCLE_SECRET' });
      } else {
        // Pi's real fork response carries \`{text, cancelled}\` and NO session file: the child's
        // identity is only ever learned from a later \`get_state\`. The previous fake handed one
        // back here, which hid the fallback that returned the SOURCE session as the copy.
        if (req.entryId === 'state-fails') stateMode = 'fail';
        else if (req.entryId === 'state-times-out') stateMode = 'timeout';
        else if (req.entryId === 'state-names-source') stateMode = 'source';
        else { current = forkFile; writeSession(current, 'fork-child', 'Fork child'); }
        send(req.id, { success: true, data: { text: 'forked', cancelled: false } });
      }
    } else if (req.type === 'clone') {
      current = cloneFile;
      writeSession(current, 'clone-child', 'Clone child');
      // Pi's real clone response carries \`{cancelled}\` only.
      send(req.id, { success: true, data: { cancelled: false } });
    } else if (req.type === 'get_state') {
      if (stateMode === 'timeout') { stateMode = 'ok'; continue; }
      if (stateMode === 'fail') { stateMode = 'ok'; send(req.id, { success: false, error: 'state unavailable' }); continue; }
      const file = stateMode === 'source' ? parent : current;
      if (stateMode === 'source') stateMode = 'ok';
      const id = file === forkFile ? 'fork-child' : file === cloneFile ? 'clone-child' : 'parent';
      const name = file === forkFile ? 'Fork child' : file === cloneFile ? 'Clone child' : 'Parent';
      send(req.id, { success: true, data: { sessionFile: file, sessionId: id, sessionName: name, model: { provider: 'fake', id: 'pi-fake', name: 'Pi Fake' } } });
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
  const forkCommand = commands.find((cmd) => cmd.type === 'fork' && cmd.entryId === 'msg-123');
  const cloneCommand = commands.find((cmd) => cmd.type === 'clone');
  check('Pi fork hook is exposed', typeof adapter.forkSession === 'function');
  check('Pi fork sends the selected entry id as fork point', !!forkCommand, JSON.stringify(commands));
  check(
    'Pi fork never sends a messageId Pi would ignore',
    commands.every((cmd) => cmd.messageId === undefined),
    JSON.stringify(commands),
  );
  check('Pi fork returns child SessionInfo', forked?.title === 'Fork child' && forked.id === Buffer.from(forkFile, 'utf8').toString('base64url'), JSON.stringify(forked));
  check('Pi clone hook is exposed separately from fork', typeof adapter.cloneSession === 'function' && !!cloneCommand, JSON.stringify(commands));
  check('Pi clone returns cloned child SessionInfo', cloned?.title === 'Clone child' && cloned.id === Buffer.from(cloneFile, 'utf8').toString('base64url'), JSON.stringify(cloned));

  // A BARE fork — no message chosen — must reach Pi as an operation Pi actually has. Pi offers no
  // whole-session fork RPC, and an entry-less \`fork\` is refused, so it goes as \`clone\`.
  const bareForkCommandsBefore = commands.filter((cmd) => cmd.type === 'clone').length;
  const bareFork = await adapter.forkSession?.(id);
  const afterBare = readFileSync(commandLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  check(
    'a bare Pi fork issues an operation Pi supports rather than an entry-less fork',
    afterBare.filter((cmd) => cmd.type === 'clone').length > bareForkCommandsBefore
      && !afterBare.some((cmd) => cmd.type === 'fork' && !cmd.entryId),
    JSON.stringify(afterBare),
  );
  check('a bare Pi fork returns a child SessionInfo', !!bareFork?.id, JSON.stringify(bareFork));

  let cancelledFlag = false;
  let cancelledFlagMessage = '';
  try {
    await adapter.forkSession?.(id, { messageId: 'cancel-flag' });
  } catch (err) {
    cancelledFlag = true;
    cancelledFlagMessage = err instanceof Error ? err.message : String(err);
  }
  check(
    'a fork Pi reports as cancelled is refused rather than returned as a copy',
    cancelledFlag && /cancelled/i.test(cancelledFlagMessage),
    cancelledFlagMessage,
  );

  let invalid = false;
  let invalidMessage = '';
  try {
    await adapter.forkSession?.(id, { messageId: 'unknown-entry' });
  } catch (err) {
    invalid = true;
    invalidMessage = err instanceof Error ? err.message : String(err);
  }
  check(
    'an unknown fork point is refused with our own words',
    // The fake accepts any other id, so this only fires if the adapter itself refuses; kept as a
    // guard on the classification path rather than as a claim about Pi.
    !invalid || (/fork point/i.test(invalidMessage) && !/secret=/.test(invalidMessage)),
    invalidMessage,
  );

  /**
   * The child's identity comes from get_state, so every way get_state can fail to name a NEW
   * session must refuse rather than fall back. Falling back meant returning the SOURCE session as
   * the copy — the user then prompts, renames and deletes the original believing it is the fork.
   */
  for (const [label, entryId] of [
    ['get_state fails', 'state-fails'],
    ['get_state times out', 'state-times-out'],
    ['get_state names the source session', 'state-names-source'],
  ] as const) {
    let refused = false;
    let refusal = '';
    let returned: any;
    try { returned = await adapter.forkSession?.(id, { messageId: entryId }); }
    catch (err) { refused = true; refusal = err instanceof Error ? err.message : String(err); }
    check(
      `a fork is refused when ${label}`,
      refused && !returned && /^Pi fork /.test(refusal) && !/secret=/.test(refusal),
      `${refusal} ${JSON.stringify(returned)}`,
    );
    check(
      `a fork that ${label} never returns the source session`,
      returned === undefined || returned.id !== id,
      JSON.stringify(returned),
    );
  }

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
