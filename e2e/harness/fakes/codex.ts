/**
 * A fake Codex installation in a fixture: the `codex` CLI in `paths.bin` and
 * the managed app-server daemon it starts (see codex-program.ts).
 *
 *   const codex = installFakeCodex(paths, { mode: 'managed', installed: '0.142.5' });
 *   await codex.startDaemon(env);            // a daemon already running, as a user would have it
 *   codex.configure({ installed: '0.144.1' }); // then the CLI is upgraded underneath it
 *   afterAll(() => codex.cleanup());
 *
 * Every CLI invocation and daemon lifecycle event lands in a ledger, so a test
 * can say which processes the broker started, signalled, or left alone.
 * `cleanup()` stops only daemons this fake started, proven by executable path.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FixturePaths } from '../broker.ts';
import { runToExit } from '../cli.ts';
import { eventually } from '../wait.ts';
import type { FakeCodexConfig } from './codex-program.ts';
import { installFakeExecutable } from './executable.ts';

export type { FakeCodexConfig, FakeThreadStatus } from './codex-program.ts';

export interface CodexLedgerEntry {
  pid: number;
  at: number;
  kind: 'cli' | 'daemon-started' | 'daemon-sigterm' | 'daemon-exit' | 'daemon-killed';
  argv?: string[];
  version?: string;
  target?: number;
}

function processAlive(pid: number): boolean {
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

export class FakeCodex {
  readonly executable: string;
  readonly codexHome: string;
  readonly state: string;
  readonly receiptPath: string;
  #config: FakeCodexConfig;

  constructor(executable: string, codexHome: string, state: string, config: FakeCodexConfig) {
    this.executable = executable;
    this.codexHome = codexHome;
    this.state = state;
    this.receiptPath = join(codexHome, 'app-server-daemon', 'app-server.pid');
    this.#config = config;
    this.#write();
  }

  get config(): FakeCodexConfig {
    return this.#config;
  }

  /** Change what the CLI and the daemon report from now on. */
  configure(change: Partial<FakeCodexConfig>): void {
    this.#config = { ...this.#config, ...change };
    this.#write();
  }

  ledger(): CodexLedgerEntry[] {
    const path = join(this.state, 'ledger.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  /** CLI invocations of `app-server daemon <command>`, from ledger entry `since` on. */
  daemonCommands(since = 0): string[] {
    return this.ledger().slice(since)
      .filter((entry) => entry.kind === 'cli' && entry.argv?.[0] === 'app-server' && entry.argv[1] === 'daemon')
      .map((entry) => entry.argv![2]!);
  }

  /** Daemon processes started, in order. */
  daemons(): Array<{ pid: number; version: string }> {
    return this.ledger()
      .filter((entry) => entry.kind === 'daemon-started')
      .map((entry) => ({ pid: entry.pid, version: entry.version! }));
  }

  /** The daemon the receipt names, when it is running. */
  runningDaemon(): { pid: number; version: string } | undefined {
    const last = this.daemons().at(-1);
    return last && processAlive(last.pid) ? last : undefined;
  }

  isAlive(pid: number): boolean {
    return processAlive(pid);
  }

  /** Start the daemon the way a user would, with the broker's environment. */
  async startDaemon(env: NodeJS.ProcessEnv): Promise<{ pid: number; version: string }> {
    const before = this.daemons().length;
    const result = await runToExit([this.executable, 'app-server', 'daemon', 'start'], {
      env,
      label: 'codex app-server daemon start',
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0) throw new Error(`fake daemon start failed: ${result.output}`);
    return eventually(() => this.daemons().length > before && this.runningDaemon(), {
      what: 'the fake Codex daemon to start',
    });
  }

  /** Stop every daemon this fake started that is still running. */
  async cleanup(): Promise<void> {
    const binary = realpathSync(this.executable);
    for (const { pid } of this.daemons()) {
      if (!processAlive(pid)) continue;
      // Only a process running this fake's executable is ours to signal.
      let executable = '';
      try {
        executable = realpathSync(`/proc/${pid}/exe`);
      } catch {
        executable = process.platform === 'linux' ? '' : binary;
      }
      if (executable !== binary) continue;
      process.kill(pid, 'SIGKILL');
      await eventually(() => !processAlive(pid), { what: `fake Codex daemon ${pid} to exit` }).catch(() => undefined);
    }
  }

  #write(): void {
    // Replaced whole, never rewritten in place: the fake reads it from other processes at any time.
    const pending = join(this.state, `config.json.${process.pid}`);
    writeFileSync(pending, JSON.stringify(this.#config));
    renameSync(pending, join(this.state, 'config.json'));
  }
}

const PROGRAM = join(import.meta.dir, 'codex-program.ts');

/**
 * Install a fake `codex` in `paths.bin`. The broker needs `CODEX_HOME` set to
 * `codexHome` (returned) so the daemon it inherits and the one it inspects agree.
 */
export function installFakeCodex(paths: FixturePaths, config: FakeCodexConfig): FakeCodex {
  const state = join(paths.root, 'fake-codex');
  const codexHome = join(paths.home, '.codex');
  mkdirSync(state, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  const executable = installFakeExecutable(paths.bin, 'codex', PROGRAM, { defines: { FAKE_CODEX_STATE: state } });
  return new FakeCodex(executable, codexHome, state, config);
}
