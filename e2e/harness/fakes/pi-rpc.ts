/**
 * A fake `pi` CLI: the process the broker starts to Drive a stored Pi session
 * (`pi --mode rpc --session <file>`), answering Pi's JSONL RPC on stdio.
 *
 * It reports a supported version, so the broker's Pi readiness gate passes,
 * accepts prompts without running a model, and records every process it
 * starts and every command it receives, so a test can say how many
 * broker-owned Pi processes exist, what reached them, and when one exited.
 *
 *   const pi = installPiRpcFake(paths);
 *   const file = pi.sessionFile('work');
 *   pi.spawns()   // [{ pid, session }]
 *   pi.exited(pid)
 *   pi.holdExports()  // export_html writes its file, then never answers
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FixturePaths } from '../broker.ts';
import { installFakeCommand } from './command.ts';

export interface PiRpcEvent {
  pid: number;
  event: 'spawn' | 'command' | 'exit';
  session?: string;
  type?: string;
  command?: any;
}

/** The fake's program. `argv`, `ledgerPath` are in scope (see command.ts). */
const PROGRAM = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const events = path.join(path.dirname(ledgerPath), 'pi.events.jsonl');
const record = (entry) => fs.appendFileSync(events, JSON.stringify({ pid: process.pid, ...entry }) + '\n');

if (argv[0] === '--version') {
  process.stdout.write('pi 0.84.0\n');
  process.exit(0);
}
const sessionAt = argv.indexOf('--session');
const session = sessionAt >= 0 ? argv[sessionAt + 1] : undefined;
if (!argv.includes('rpc')) process.exit(0);

record({ event: 'spawn', session });
let exiting = false;
const exit = () => {
  if (exiting) return;
  exiting = true;
  record({ event: 'exit' });
  process.exit(0);
};
process.on('SIGTERM', exit);

const reply = (id, payload) => process.stdout.write(JSON.stringify({ type: 'response', id, ...payload }) + '\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const raw = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!raw) continue;
    let command;
    try { command = JSON.parse(raw); } catch { continue; }
    record({ event: 'command', type: command.type, command });
    if (command.type === 'get_state') {
      reply(command.id, { command: command.type, success: true, data: {
        sessionFile: session,
        sessionId: 'fake-pi-session',
        model: { provider: 'fake', id: 'pi-fake', name: 'Pi Fake' },
      } });
    } else if (command.type === 'get_messages') {
      reply(command.id, { command: command.type, success: true, data: { messages: [] } });
    } else if (command.type === 'export_html') {
      // Pi writes the transcript where it is told, then answers. The marker is made here, at run time,
      // so no fixture file carries it: a test that finds it on disk found the export.
      const marker = 'pi-unredacted-' + require('node:crypto').randomUUID();
      fs.writeFileSync(command.outputPath, '<!doctype html><title>transcript</title><p>' + marker + '</p>\n');
      // Held: the file is written and the answer never comes, so the export stays mid-flight.
      if (!fs.existsSync(path.join(path.dirname(ledgerPath), 'pi.export-hold'))) {
        reply(command.id, { command: command.type, success: true, data: { path: command.outputPath } });
      }
    } else {
      reply(command.id, { command: command.type, success: true, data: {} });
    }
  }
});
process.stdin.on('end', exit);
process.stdin.resume();
`;

export class PiRpcFake {
  readonly path: string;
  readonly #paths: FixturePaths;
  readonly #events: string;
  #serial = 0;

  constructor(paths: FixturePaths, path: string) {
    this.#paths = paths;
    this.path = path;
    this.#events = join(paths.bin, 'pi.events.jsonl');
  }

  events(): PiRpcEvent[] {
    if (!existsSync(this.#events)) return [];
    return readFileSync(this.#events, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  /** Every broker-owned Pi process started, oldest first. */
  spawns(): Array<{ pid: number; session: string }> {
    return this.events()
      .filter((entry) => entry.event === 'spawn')
      .map((entry) => ({ pid: entry.pid, session: entry.session ?? '' }));
  }

  commands(type?: string): PiRpcEvent[] {
    return this.events().filter((entry) => entry.event === 'command' && (!type || entry.type === type));
  }

  exited(pid: number): boolean {
    return this.events().some((entry) => entry.pid === pid && entry.event === 'exit');
  }

  /** From now on `export_html` writes its file and never answers: an export held mid-flight. */
  holdExports(): void {
    writeFileSync(join(this.#paths.bin, 'pi.export-hold'), '');
  }

  /** `export_html` answers again. */
  releaseExports(): void {
    rmSync(join(this.#paths.bin, 'pi.export-hold'), { force: true });
  }

  /** A stored Pi session file (its header only) with its working directory. */
  sessionFile(name: string): { file: string; cwd: string; id: string } {
    const cwd = join(this.#paths.root, 'work', name);
    mkdirSync(cwd, { recursive: true });
    const directory = join(this.#paths.root, 'pi-sessions', `--work-${name}--`);
    mkdirSync(directory, { recursive: true });
    const file = join(directory, `2026-07-28T00-00-0${++this.#serial % 10}-000Z_${name}.jsonl`);
    writeFileSync(file, `${JSON.stringify({ type: 'session', version: 3, id: `pi-${name}`, timestamp: '2026-07-28T00:00:00.000Z', cwd })}\n`);
    return { file, cwd, id: Buffer.from(file, 'utf8').toString('base64url') };
  }
}

/** Install the fake as `pi` in the fixture's `bin` (first on the broker's PATH). */
export function installPiRpcFake(paths: FixturePaths): PiRpcFake {
  const command = installFakeCommand(paths.bin, 'pi', PROGRAM);
  return new PiRpcFake(paths, command.path);
}
