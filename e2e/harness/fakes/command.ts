/**
 * Install a fake command-line tool into a broker's fake-agent directory.
 *
 * The fake is one self-contained script (no imports beyond Node built-ins, so
 * nothing for a module loader to walk) run by the same Bun that runs the
 * suite. On POSIX it is an executable file whose shebang names that Bun; on
 * Windows it is the script plus a `.cmd` launcher, which is how npm installs
 * the real tools and how the product's invocation resolver expects to find
 * them. Every run appends `{argv, cwd}` to a JSON-lines ledger beside it, so
 * a test can assert what the product asked the tool to do.
 *
 *   const opencode = installFakeCommand(broker.paths.bin, 'opencode', source);
 *   opencode.calls()  // [{ argv: ['export', 'id', '--sanitize'], cwd }]
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FakeCommand {
  /** The path the product resolves on PATH. */
  path: string;
  ledger: string;
  /** Every invocation so far, oldest first. */
  calls(): Array<{ argv: string[]; cwd: string }>;
}

/**
 * `body` is the script's code. It runs with `argv` (the arguments, without
 * the interpreter and script) and `ledgerPath` in scope; the ledger line is
 * written before `body` runs.
 */
export function installFakeCommand(binDir: string, name: string, body: string): FakeCommand {
  const ledger = join(binDir, `${name}.ledger.jsonl`);
  const script = [
    `const ledgerPath = ${JSON.stringify(ledger)};`,
    'const argv = process.argv.slice(2);',
    "require('node:fs').appendFileSync(ledgerPath, JSON.stringify({ argv, cwd: process.cwd() }) + '\\n');",
    body,
  ].join('\n');
  let path: string;
  if (process.platform === 'win32') {
    const source = join(binDir, `${name}.fake.js`);
    writeFileSync(source, script);
    path = join(binDir, `${name}.cmd`);
    writeFileSync(path, `@"${process.execPath}" "${source}" %*\r\n`);
  } else {
    path = join(binDir, name);
    writeFileSync(path, `#!${process.execPath}\n${script}\n`);
    chmodSync(path, 0o755);
  }
  return {
    path,
    ledger,
    calls() {
      if (!existsSync(ledger)) return [];
      return readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
  };
}
