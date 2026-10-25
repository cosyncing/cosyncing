/**
 * A fake `claude` CLI for sessions the app creates and drives: every launch's argv, and every
 * stream-json line the broker writes to its stdin, land in a ledger beside the executable, so a test
 * sees exactly which model and effort a turn was started with and what prompt reached the agent.
 * An unmarked prompt gets no answer (its turn never finishes); `--version` answers and exits.
 *
 * A marker in a prompt scripts the turn the way Claude Code 2.1.310 answers it on stream-json:
 *   [fake:turn]        the turn completes
 *   [fake:bg]          a background task starts (`background_tasks_changed`) and the turn completes;
 *                      the task ends when {@link FakeClaudeCli.endBackgroundWork} is called
 *   [fake:hold]        the turn runs until an interrupt ends it as aborted
 *   [fake:permission]  the turn blocks on a permission ask, withdrawn by an interrupt
 *   [fake:deaf]        the turn runs and this process ignores interrupts
 *   [fake:refuse]      this process refuses later model, mode and effort changes
 * A prompt that arrives while a turn runs is queued, and an interrupt with `cancel_queued` drops it.
 * Model, permission-mode and effort control requests are otherwise accepted; a model resolves to
 * `claude-<model>`.
 *
 * Cross-platform: a Bun script with the running Bun as its interpreter on POSIX, and a `.cmd` shim
 * around the same script on Windows.
 *
 *   const claude = installFakeClaudeCli(paths.bin);
 *   env: { COSYNCING_CLAUDE_BIN: claude.path }
 *   claude.launches()  // [{ pid, argv: ['-p', ..., '--model', 'opus'], stdin: [{ type: 'user', ... }] }]
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ClaudeLaunch {
  pid: number;
  argv: string[];
  /** The directory the agent was started in. */
  cwd: string;
  /** Parsed stdin lines, in order. */
  stdin: any[];
}

export interface FakeClaudeCli {
  /** The executable to hand the product (`COSYNCING_CLAUDE_BIN`). */
  path: string;
  launches(): ClaudeLaunch[];
  /** The value of `--name` in a launch's argv, if present. */
  option(launch: ClaudeLaunch, name: string): string | undefined;
  /** Whether a launch's process is still running. */
  alive(launch: ClaudeLaunch): boolean;
  /** End the background tasks a launch started with `[fake:bg]`. */
  endBackgroundWork(launch: ClaudeLaunch): void;
}

const PROGRAM = `
const { appendFileSync, existsSync } = require('node:fs');
const ledger = process.argv[1] + '.ledger.jsonl';
const record = (entry) => appendFileSync(ledger, JSON.stringify({ pid: process.pid, ...entry }) + '\\n');
const argv = process.argv.slice(2);
record({ kind: 'argv', argv, cwd: process.cwd() });
if (argv.includes('--version')) {
  process.stdout.write('2.1.0 (Claude Code)\\n');
  process.exit(0);
}
const write = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const respond = (request, response) => write({ type: 'control_response', response: { ...response, request_id: request.request_id } });
const result = (extra) => write({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', ...extra });
const textOf = (line) => {
  const content = line.message && line.message.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((part) => (part && part.text) || '').join(' ') : '';
};
const doneFile = process.argv[1] + '.' + process.pid + '.bg-done';
let backgroundTasks = 0;
let backgroundWatch;
let held = false;
let queued = [];
let deaf = false;
let refuse = false;
let permission;
const reportTasks = () => write({
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks: Array.from({ length: backgroundTasks }, (_, index) => ({ task_id: 'fake-bg-' + index, task_type: 'local_bash' })),
});
const watchBackgroundEnd = () => {
  if (backgroundWatch) return;
  backgroundWatch = setInterval(() => {
    if (!existsSync(doneFile)) return;
    clearInterval(backgroundWatch);
    backgroundWatch = undefined;
    backgroundTasks = 0;
    reportTasks();
  }, 20);
};
// The interrupted turn ends. Its result text is one the broker must not show as an error.
const endHeldTurn = () => {
  held = false;
  result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools', result: 'Request interrupted by user' });
  const next = queued;
  queued = [];
  for (const entry of next) onUser(entry.line);
};
const onUser = (line) => {
  if (held) { queued.push({ line }); return; }
  const text = textOf(line);
  if (text.includes('[fake:refuse]')) refuse = true;
  if (text.includes('[fake:deaf]')) { deaf = true; held = true; return; }
  if (text.includes('[fake:hold]')) { held = true; return; }
  if (text.includes('[fake:permission]')) {
    held = true;
    permission = 'fake-permission-' + process.pid;
    write({ type: 'control_request', request_id: permission, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'touch fake' }, description: 'Run touch fake' } });
    return;
  }
  if (text.includes('[fake:bg]')) { backgroundTasks += 1; reportTasks(); watchBackgroundEnd(); result(); return; }
  if (text.includes('[fake:turn]')) result();
};
const onControl = (line) => {
  const subtype = line.request && line.request.subtype;
  if (subtype === 'interrupt') {
    if (deaf) return;
    // Like Claude Code 2.1.310, the answer names only dropped prompts that were sent with a uuid.
    const dropped = line.request.cancel_queued ? queued.splice(0) : [];
    const named = (entries) => entries.map((entry) => entry.line.uuid).filter(Boolean);
    respond(line, { subtype: 'success', response: { still_queued: named(queued), cancelled: named(dropped) } });
    if (permission) { write({ type: 'control_cancel_request', request_id: permission }); permission = undefined; }
    if (held) endHeldTurn();
    return;
  }
  if (refuse && (subtype === 'set_model' || subtype === 'set_permission_mode' || subtype === 'apply_flag_settings')) {
    respond(line, { subtype: 'error', error: 'refused by the fake' });
  } else if (subtype === 'set_model') {
    respond(line, { subtype: 'success', response: { model: 'claude-' + line.request.model } });
  } else if (subtype === 'set_permission_mode') {
    respond(line, { subtype: 'success', response: { mode: line.request.mode } });
  } else if (subtype === 'apply_flag_settings') {
    respond(line, { subtype: 'success' });
  }
};
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let value;
    try { value = JSON.parse(line); } catch { record({ kind: 'stdin', raw: line }); continue; }
    record({ kind: 'stdin', value });
    if (value && value.type === 'user') onUser(value);
    else if (value && value.type === 'control_request') onControl(value);
  }
});
process.stdin.on('end', () => process.exit(0));
`;

export function installFakeClaudeCli(directory: string): FakeClaudeCli {
  mkdirSync(directory, { recursive: true });
  let path: string;
  let script: string;
  if (process.platform === 'win32') {
    script = join(directory, 'claude.fake.js');
    writeFileSync(script, PROGRAM);
    path = join(directory, 'claude.cmd');
    writeFileSync(path, `@"${process.execPath}" "%~dp0claude.fake.js" %*\r\n`);
  } else {
    script = join(directory, 'claude');
    path = script;
    writeFileSync(script, `#!${process.execPath}\n${PROGRAM}`);
    chmodSync(script, 0o755);
  }
  const ledger = `${script}.ledger.jsonl`;
  return {
    path,
    launches() {
      if (!existsSync(ledger)) return [];
      const byPid = new Map<number, ClaudeLaunch>();
      for (const line of readFileSync(ledger, 'utf8').split('\n')) {
        if (!line) continue;
        const entry = JSON.parse(line);
        let launch = byPid.get(entry.pid);
        if (!launch) byPid.set(entry.pid, launch = { pid: entry.pid, argv: [], cwd: '', stdin: [] });
        if (entry.kind === 'argv') {
          launch.argv = entry.argv;
          launch.cwd = entry.cwd;
        } else if (entry.kind === 'stdin') {
          launch.stdin.push(entry.value ?? entry.raw);
        }
      }
      return [...byPid.values()].filter((launch) => !launch.argv.includes('--version'));
    },
    option(launch, name) {
      const index = launch.argv.indexOf(name);
      return index >= 0 ? launch.argv[index + 1] : undefined;
    },
    alive(launch) {
      try {
        process.kill(launch.pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    endBackgroundWork(launch) {
      writeFileSync(`${script}.${launch.pid}.bg-done`, '');
    },
  };
}

/** The text of the user turns a launch was given on stdin. */
export function promptTexts(launch: ClaudeLaunch): string[] {
  return launch.stdin
    .filter((line) => line?.type === 'user')
    .flatMap((line) => {
      const content = line.message?.content;
      if (typeof content === 'string') return [content];
      return Array.isArray(content) ? content.filter((part: any) => part?.type === 'text').map((part: any) => String(part.text)) : [];
    });
}
