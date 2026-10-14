/**
 * Just enough OpenCode for a transcript export: sessions in OpenCode's on-disk
 * storage (which the broker discovers without a running serve) and a fake
 * `opencode` CLI whose `export <id> --sanitize` prints what the test scripted
 * for that session.
 *
 *   const opencode = installOpenCodeExport(paths);          // in startBroker's setup
 *   env: (paths) => ({ OPENCODE_DATA: opencodeData(paths) })
 *   opencode.session('ses_a', { cwd, title: 'A' }, { stdout: '{"messages":[]}' });
 *   opencode.cli.calls()                                     // what the broker ran
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FixturePaths } from '../broker.ts';
import { type FakeCommand, installFakeCommand } from './command.ts';

/** What `opencode export <id>` does for one session. */
export interface ExportScript {
  /** Printed after OpenCode's informational first line. */
  stdout?: string;
  /** Repeat `stdout` this many times (a large export without a large test file). */
  repeat?: number;
  /** Exit with this code after printing `stderr`, instead of exporting. */
  exit?: number;
  stderr?: string;
}

export interface OpenCodeSessionFields {
  cwd: string;
  title: string;
  /** OpenCode's `time.updated`; the export confirmation is bound to it. */
  updated?: number;
}

export interface OpenCodeExportFixture {
  dataDir: string;
  cli: FakeCommand;
  /** Create or rewrite a session in storage and script its export. */
  session(id: string, fields: OpenCodeSessionFields, script?: ExportScript): void;
}

export const opencodeData = (paths: FixturePaths): string => join(paths.root, 'opencode-data');

export function installOpenCodeExport(paths: FixturePaths): OpenCodeExportFixture {
  const dataDir = opencodeData(paths);
  const sessions = join(dataDir, 'storage', 'session', 'e2e-project');
  mkdirSync(sessions, { recursive: true });
  const scriptsPath = join(paths.bin, 'opencode-exports.json');
  writeFileSync(scriptsPath, '{}');
  const cli = installFakeCommand(paths.bin, 'opencode', `
const fs = require('node:fs');
if (argv[0] === '--version') { process.stdout.write('1.0.0\\n'); process.exit(0); }
if (argv[0] !== 'export') { process.stderr.write('fake opencode: unsupported ' + argv.join(' ') + '\\n'); process.exit(2); }
const script = JSON.parse(fs.readFileSync(${JSON.stringify(scriptsPath)}, 'utf8'))[argv[1]];
if (!script) { process.stderr.write('Session not found: ' + argv[1] + '\\n'); process.exit(1); }
if (script.exit) { process.stderr.write((script.stderr || 'export failed') + '\\n'); process.exit(script.exit); }
process.stdout.write('Exporting session: ' + argv[1] + '\\n');
process.stdout.write(String(script.stdout ?? '').repeat(script.repeat ?? 1));
`);
  return {
    dataDir,
    cli,
    session(id, fields, script) {
      const now = Date.now();
      writeFileSync(join(sessions, `${id}.json`), JSON.stringify({
        id,
        directory: fields.cwd,
        title: fields.title,
        time: { created: now - 60_000, updated: fields.updated ?? now - 30_000 },
      }));
      if (script) {
        const scripts = JSON.parse(readFileSync(scriptsPath, 'utf8'));
        scripts[id] = script;
        writeFileSync(scriptsPath, JSON.stringify(scripts));
      }
    },
  };
}
