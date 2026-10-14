/**
 * A `kilo` that only answers `--version`, one self-contained file installed by `installFakeExecutable` (kit.ts):
 * the binary a `cosyncing doctor --json` run is pointed at. Its config is `<argv[1]>.json`
 * (`{ version, versionOutput? }`). The serve the broker launches is `kilo-program.ts`.
 */
import { readFileSync } from 'node:fs';

const config: { version: string; versionOutput?: string } = JSON.parse(readFileSync(`${process.argv[1]}.json`, 'utf8'));
if (process.argv[2] === '--version') process.stdout.write(config.versionOutput ?? `kilo ${config.version}\n`);
else {
  process.stderr.write(`fake kilo: unsupported ${process.argv.slice(2).join(' ')}\n`);
  process.exit(2);
}
