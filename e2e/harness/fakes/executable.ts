/**
 * Turn a fake program into a real executable in a fixture's `bin`.
 *
 * The program is compiled into a single native file with `bun build --compile`,
 * so it runs the same way on every platform (no shebang, no shell), and a
 * process started from it is that executable: `/proc/<pid>/exe` names it, which
 * is what the broker's ownership checks compare against. Values the program
 * needs (where to keep its state) are compiled in, so they reach it however the
 * broker spawns it, whatever environment it passes.
 */
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { scaled } from '../wait.ts';

export interface CompileOptions {
  /** `declare const NAME: string` in the program, replaced by this value. */
  defines?: Record<string, string>;
}

/** Compile `entry` to `<bin>/<name>` (`.exe` on Windows) and return its path. */
export function installFakeExecutable(bin: string, name: string, entry: string, options: CompileOptions = {}): string {
  mkdirSync(bin, { recursive: true });
  const outfile = join(bin, process.platform === 'win32' ? `${name}.exe` : name);
  const defines = Object.entries(options.defines ?? {}).flatMap(([key, value]) => [
    '--define',
    `${key}=${JSON.stringify(value)}`,
  ]);
  process.stderr.write(`[e2e] compile fake ${name}\n`);
  const build = Bun.spawnSync(
    [process.execPath, 'build', '--compile', entry, '--outfile', outfile, ...defines],
    { stdout: 'pipe', stderr: 'pipe', timeout: scaled(60_000) },
  );
  if (build.exitCode !== 0) {
    throw new Error(
      `compiling fake ${name} failed (exit ${build.exitCode ?? 'timeout'}):\n${build.stdout}${build.stderr}`,
    );
  }
  return outfile;
}

/**
 * A PATH with only the fixture's `bin` and the system directories, with Bun
 * linked into `bin`.
 *
 * The harness default adds Bun's own directory, and on a developer machine that
 * is often `~/.local/bin`, next to the real `codex`, `claude`, `grok` and
 * friends: a broker would find and run them. Undefined on Windows, where the
 * harness supplies its isolated platform PATH.
 */
export function pathWithoutHostTools(bin: string): string | undefined {
  if (process.platform === 'win32') return undefined;
  mkdirSync(bin, { recursive: true });
  const bun = join(bin, 'bun');
  if (!existsSync(bun)) symlinkSync(process.execPath, bun);
  return [bin, '/usr/bin', '/bin'].join(delimiter);
}
