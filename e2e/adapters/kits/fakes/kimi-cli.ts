/**
 * A fake `kimi` CLI, one self-contained file (node builtins only), installed into `paths.bin` by
 * `installFakeExecutable` (kit.ts). Its config is `<argv[1]>.json`.
 *
 *   kimi --version     the configured version (or `versionOutput`)
 *   anything else      refused (exit 2): the broker never starts `kimi web` in these suites
 *
 * The host itself is `kimi-host.ts`, in the test process: this program never listens.
 */
import { appendFileSync, readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(`${process.argv[1]}.json`, 'utf8')) as { version: string; versionOutput?: string; ledger?: string };
const args = process.argv.slice(2);
if (config.ledger) {
  try {
    appendFileSync(config.ledger, `${JSON.stringify({ at: Date.now(), pid: process.pid, kind: 'cli', argv: args })}\n`);
  } catch {
    // The ledger is evidence for the test, never a reason for the fake to fail.
  }
}
if (args[0] === '--version' || args[0] === '-V') {
  process.stdout.write(config.versionOutput ?? `${config.version}\n`);
} else {
  process.stderr.write(`fake kimi: unsupported invocation: ${args.join(' ')}\n`);
  process.exit(2);
}
