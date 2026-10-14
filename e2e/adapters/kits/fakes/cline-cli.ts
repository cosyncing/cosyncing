/**
 * A `cline` that only answers `--version`, one self-contained file installed by `installFakeExecutable` (kit.ts):
 * the binary a `cosyncing doctor --json` run is pointed at. Its config is `<argv[1]>.json`
 * (`{ version, versionOutput? }`). The Hub the broker launches is `cline-program.ts`.
 */
import { readFileSync } from 'node:fs';

const config: { version: string; versionOutput?: string } = JSON.parse(readFileSync(`${process.argv[1]}.json`, 'utf8'));
if (process.argv[2] === '--version') process.stdout.write(config.versionOutput ?? `${config.version}\n`);
else {
  process.stderr.write(`fake cline: unsupported ${process.argv.slice(2).join(' ')}\n`);
  process.exit(2);
}
