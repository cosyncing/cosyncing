/**
 * A fake OpenCode installation in a fixture: `opencode` in `paths.bin`, whose
 * `serve` the broker launches and owns (see opencode-program.ts).
 *
 * The broker only manages a serve when autoserve is on and `OPENCODE_URL`
 * names a local port, so a test leases a port, passes it here and to the broker:
 *
 *   const opencode = installFakeOpencode(paths, { installed: '1.1.0' });
 *   startBroker({ env: { ...opencodeServeEnvironment(port) } });
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FixturePaths } from '../broker.ts';
import type { FakeOpencodeConfig } from './opencode-program.ts';
import { installFakeExecutable } from './executable.ts';

export type { FakeOpencodeConfig } from './opencode-program.ts';

export interface OpencodeLedgerEntry {
  pid: number;
  at: number;
  kind: 'cli' | 'serve-started' | 'serve-exit' | 'serve-waiting' | 'create';
  id?: string;
  argv?: string[];
  version?: string;
  port?: number;
  reason?: string;
}

/** The broker environment that makes it launch and own a serve on `port`. */
export function opencodeServeEnvironment(port: number): Record<string, string> {
  return {
    OPENCODE_URL: `http://127.0.0.1:${port}`,
    COSYNCING_OPENCODE_NO_AUTOSERVE: '0',
  };
}

export class FakeOpencode {
  readonly executable: string;
  readonly state: string;
  #config: FakeOpencodeConfig;

  constructor(executable: string, state: string, config: FakeOpencodeConfig) {
    this.executable = executable;
    this.state = state;
    this.#config = config;
    this.#write();
  }

  configure(change: Partial<FakeOpencodeConfig>): void {
    const upgraded = change.installed !== undefined && change.installed !== this.#config.installed;
    this.#config = { ...this.#config, ...change };
    this.#write();
    if (upgraded) {
      // A real install replaces the binary. Reflect that identity change for cached version probes.
      const stamp = new Date(Math.max(Date.now(), statSync(this.executable).mtimeMs + 1));
      utimesSync(this.executable, stamp, stamp);
    }
  }

  ledger(): OpencodeLedgerEntry[] {
    const path = join(this.state, 'ledger.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  /** Serves started, in order. */
  serves(): Array<{ pid: number; version: string }> {
    return this.ledger()
      .filter((entry) => entry.kind === 'serve-started')
      .map((entry) => ({ pid: entry.pid, version: entry.version! }));
  }

  /** The process is gone (a stopped serve may have been signalled without a word). */
  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    if (process.platform !== 'linux') return true;
    try {
      return readFileSync(`/proc/${pid}/stat`, 'utf8').split(')').at(-1)!.trim()[0] !== 'Z';
    } catch {
      return false;
    }
  }

  /** Stop any serve this fake started that outlived its broker, proven by executable path. */
  cleanup(): void {
    const binary = realpathSync(this.executable);
    for (const { pid } of this.serves()) {
      if (!this.isAlive(pid)) continue;
      let executable = '';
      try {
        executable = realpathSync(`/proc/${pid}/exe`);
      } catch {
        continue;
      }
      if (executable === binary) process.kill(pid, 'SIGKILL');
    }
  }

  #write(): void {
    // Replaced whole, never rewritten in place: the fake reads it from other processes at any time.
    const pending = join(this.state, `config.json.${process.pid}`);
    writeFileSync(pending, JSON.stringify(this.#config));
    renameSync(pending, join(this.state, 'config.json'));
  }
}

const PROGRAM = join(import.meta.dir, 'opencode-program.ts');

export function installFakeOpencode(paths: FixturePaths, config: FakeOpencodeConfig): FakeOpencode {
  const state = join(paths.root, 'fake-opencode');
  mkdirSync(state, { recursive: true });
  const executable = installFakeExecutable(paths.bin, 'opencode', PROGRAM, { defines: { FAKE_OPENCODE_STATE: state } });
  return new FakeOpencode(executable, state, config);
}
