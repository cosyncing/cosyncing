/**
 * A fake `claude` executable that answers `claude agents --json` from a JSON
 * file the test rewrites, so a suite controls what the Claude adapter reads as
 * each session's live process status (busy, waiting, idle) without a real CLI.
 *
 * Every other invocation exits 2. Each call is appended to a ledger next to the
 * executable, so a test can see that the product actually asked.
 *
 * Cross-platform: a Bun script with the running Bun as its interpreter on
 * POSIX, and a `.cmd` shim around the same script on Windows.
 *
 *   const claude = installFakeClaudeAgents(broker.paths.bin);
 *   claude.setAgents([{ sessionId: uuid, status: 'busy' }]);
 *   env: { COSYNCING_CLAUDE_BIN: claude.path }
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FakeClaudeAgent {
  sessionId: string;
  /** What `agents --json` reports: busy → working, waiting → needs input, anything else → idle. */
  status: 'busy' | 'waiting' | 'idle';
}

export interface FakeClaudeAgents {
  /** The executable to hand the product (`COSYNCING_CLAUDE_BIN`). */
  path: string;
  setAgents(agents: FakeClaudeAgent[]): void;
  /** Every argv the product invoked it with, oldest first. */
  calls(): string[][];
}

const PROGRAM = `
const { appendFileSync, readFileSync } = require('node:fs');
const script = process.argv[1];
const args = process.argv.slice(2);
try { appendFileSync(script + '.calls', JSON.stringify(args) + '\\n'); } catch {}
if (args[0] === 'agents' && args[1] === '--json') {
  let agents = [];
  try { agents = JSON.parse(readFileSync(script + '.json', 'utf8')).agents ?? []; } catch {}
  process.stdout.write(JSON.stringify(agents) + '\\n');
  process.exit(0);
}
process.exit(2);
`;

export function installFakeClaudeAgents(directory: string, agents: FakeClaudeAgent[] = []): FakeClaudeAgents {
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
  const setAgents = (next: FakeClaudeAgent[]): void => {
    writeFileSync(`${script}.json`, `${JSON.stringify({ agents: next })}\n`);
  };
  setAgents(agents);
  appendFileSync(`${script}.calls`, '');
  return {
    path,
    setAgents,
    calls: () => {
      const ledger = `${script}.calls`;
      if (!existsSync(ledger)) return [];
      return readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
    },
  };
}
