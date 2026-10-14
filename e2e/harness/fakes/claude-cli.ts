/**
 * A fake `claude` CLI for sessions the app creates and drives: every launch's argv, and every
 * stream-json line the broker writes to its stdin, land in a ledger beside the executable, so a test
 * sees exactly which model and effort a turn was started with and what prompt reached the agent.
 * It answers nothing on stdout (a turn never finishes); `--version` answers and exits.
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
}

const PROGRAM = `
const { appendFileSync } = require('node:fs');
const ledger = process.argv[1] + '.ledger.jsonl';
const record = (entry) => appendFileSync(ledger, JSON.stringify({ pid: process.pid, ...entry }) + '\\n');
const argv = process.argv.slice(2);
record({ kind: 'argv', argv, cwd: process.cwd() });
if (argv.includes('--version')) {
  process.stdout.write('2.1.0 (Claude Code)\\n');
  process.exit(0);
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try { record({ kind: 'stdin', value: JSON.parse(line) }); } catch { record({ kind: 'stdin', raw: line }); }
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
