/**
 * A real broker process for one test file.
 *
 * Each broker gets a throwaway root (HOME, XDG, COSYNCING_HOME and every agent
 * home point inside it), a loopback port leased from the OS (a lost bind race
 * respawns on a fresh port), and an environment built from an allowlist, so no
 * host credential, agent directory or running broker can leak in. Readiness is
 * awaited under a generous deadline and is never a test assertion.
 *
 *   const broker = await startBroker();
 *   afterAll(() => broker.stop());
 *   const client = broker.client();
 */
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import {
  captureProcessOutput,
  isolatedBrokerFixtureEnvironment,
  startHealthyFixtureBroker,
  type ProcessOutputCapture,
} from '../../packages/typescript/broker/test/helpers/isolated-broker-fixture.ts';
import { recordHarnessRoot } from '../../scripts/ci/lib/harness-leaks.ts';
import { BrokerClient, type ClientAuth } from './client.ts';
import { scaled } from './wait.ts';

export const REPO_ROOT = resolve(import.meta.dir, '..', '..');

export interface FixturePaths {
  /** Everything this broker owns lives under here. */
  root: string;
  /** The fixture user's HOME (agent session stores live under it). */
  home: string;
  /** Broker state: config, credentials, journals. */
  cosyncingHome: string;
  /** A directory on the broker's PATH, first, for fake agent executables. */
  bin: string;
}

export interface BrokerOptions {
  /** Optional frozen source checkout for matched baseline/candidate benchmarks. */
  sourceDirectory?: string;
  /**
   * Require the owner token on every request (`true` generates one). Without
   * it a source-mode broker treats loopback callers as the owner, which is
   * what most feature tests want.
   */
  token?: string | true;
  /** Extra environment, applied last. */
  env?: Record<string, string> | ((paths: FixturePaths) => Record<string, string>);
  /** Arrange files (fake agent stores, configs) before the broker starts. */
  setup?: (paths: FixturePaths) => void | Promise<void>;
  /** Reuse an existing root, e.g. to start a second broker on the same state. */
  root?: string;
  /** Prefix for the temporary root, for readable paths in logs. */
  name?: string;
  /**
   * Keep the host PATH. Off by default: a developer machine has real `claude`,
   * `codex` and friends on PATH, and a test must only ever find the fakes in
   * `paths.bin`.
   */
  hostPath?: boolean;
  /**
   * Start on this port instead of leasing one, for state that names its own
   * port (an installed config, integration credentials bound to the internal
   * URL). There is no respawn onto another port.
   */
  port?: number;
}

interface Child {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

export class Broker {
  readonly paths: FixturePaths;
  readonly token: string | undefined;
  #env: NodeJS.ProcessEnv;
  #child: Child | undefined;
  #capture: ProcessOutputCapture | undefined;
  #port = 0;
  #previousOutput = '';
  #ownsRoot: boolean;

  constructor(
    paths: FixturePaths,
    env: NodeJS.ProcessEnv,
    token: string | undefined,
    ownsRoot: boolean,
    port = 0,
    private readonly sourceDirectory = REPO_ROOT,
  ) {
    this.paths = paths;
    this.#port = port;
    this.#env = env;
    this.token = token;
    this.#ownsRoot = ownsRoot;
  }

  get port(): number {
    return this.#port;
  }

  get url(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  get wsUrl(): string {
    return `ws://127.0.0.1:${this.#port}`;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  /** The broker's environment, for spawning tools (CLI, fake agents) against it. */
  get env(): NodeJS.ProcessEnv {
    return { ...this.#env, PORT: String(this.#port) };
  }

  /** Everything the broker process has written, across restarts. */
  output(): string {
    return this.#previousOutput + (this.#capture?.read() ?? '');
  }

  /** A protocol client. Owner by default (with the token when there is one). */
  client(auth: ClientAuth = this.token ? { kind: 'owner', token: this.token } : { kind: 'none' }): BrokerClient {
    return new BrokerClient(this.url, this.wsUrl, auth);
  }

  async start(): Promise<void> {
    let spawnedPort = 0;
    const { child, port } = await startHealthyFixtureBroker<Bun.Subprocess>({
      reservePort: this.#port ? async () => this.#port : undefined,
      spawn: (port) => {
        spawnedPort = port;
        const spawned = Bun.spawn(['bun', 'run', join(this.sourceDirectory, 'packages/typescript/broker/src/main.ts')], {
          cwd: this.sourceDirectory,
          // A pipe this process never writes: when it dies, however it dies, the broker reads end of
          // file and shuts down, taking its managed hosts with it (the source-only stdin hook).
          env: { ...this.#env, PORT: String(port), HOST: '127.0.0.1', COSYNCING_TEST_EXIT_ON_STDIN_EOF: '1' },
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        });
        this.#capture = captureProcessOutput(spawned, { maxChars: 400_000 });
        return spawned;
      },
      healthUrl: (port) => `http://127.0.0.1:${port}/api/health`,
      capture: () => this.#capture!,
      stop: async (stale) => {
        stale.kill('SIGKILL');
        await stale.exited.catch(() => undefined);
      },
      healthOptions: {
        timeoutMs: scaled(90_000),
        // A port lease is released before the child can bind. A different
        // fixture can win that race and answer public health with HTTP 200.
        // Only this child's post-bind banner proves which listener is ready.
        childReady: () => this.#capture?.read().includes(
          `broker on http://127.0.0.1:${spawnedPort} `,
        ) ?? false,
      },
    });
    this.#child = child;
    this.#port = port;
  }

  /** Stop gracefully (SIGTERM, then SIGKILL after a grace period). */
  async stop(options: { keepState?: boolean } = {}): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      const exited = await Promise.race([
        child.exited.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), scaled(10_000))),
      ]);
      if (!exited) {
        child.kill('SIGKILL');
        await child.exited.catch(() => undefined);
      }
    }
    this.#previousOutput += this.#capture?.read() ?? '';
    this.#capture = undefined;
    if (!options.keepState && this.#ownsRoot) {
      rmSync(this.paths.root, { recursive: true, force: true });
    }
  }

  /** Kill without a graceful shutdown, as a crash would. State is kept. */
  async crash(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    if (child && child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited.catch(() => undefined);
    }
    this.#previousOutput += this.#capture?.read() ?? '';
    this.#capture = undefined;
  }

  /** Stop and start again on the same state and the same port. */
  async restart(options: { crash?: boolean } = {}): Promise<void> {
    if (options.crash) await this.crash();
    else await this.stop({ keepState: true });
    await this.start();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }
}

export function fixturePaths(root: string): FixturePaths {
  const paths = {
    root,
    home: join(root, 'home'),
    cosyncingHome: join(root, 'cosyncing-home'),
    bin: join(root, 'bin'),
  };
  for (const directory of [paths.home, paths.cosyncingHome, paths.bin]) {
    mkdirSync(directory, { recursive: true });
  }
  return paths;
}

/**
 * The fake-agent directory, Bun, and the system directories: nothing a
 * developer installed. Host tools require an explicit hostPath opt-in on
 * every platform.
 *
 * Bun is reached through a private directory holding only a `bun` link, not
 * through Bun's own install directory: on a developer box that directory is
 * often `~/.local/bin`, next to the real `grok`, `claude`, `codex` and `agy`,
 * and a test that removed its fake would silently run the real agent.
 */
export function fixturePath(bin: string, hostPath?: string): string {
  if (hostPath !== undefined) return [bin, hostPath].join(delimiter);
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (!systemRoot) throw new Error('Windows fixture requires SystemRoot');
    return [bin, bunOnlyDirectory(bin), join(systemRoot, 'System32'),
      join(systemRoot, 'System32/WindowsPowerShell/v1.0')].join(delimiter);
  }
  return [bin, bunOnlyDirectory(bin), '/usr/bin', '/bin'].join(delimiter);
}

/** A private runtime entry; Windows hard links do not require symlink privileges. */
function bunOnlyDirectory(bin: string): string {
  const directory = join(dirname(bin), 'runtime-bin');
  const link = join(directory, process.platform === 'win32' ? 'bun.exe' : 'bun');
  if (!existsSync(link)) {
    mkdirSync(directory, { recursive: true });
    if (process.platform === 'win32') {
      try { linkSync(process.execPath, link); }
      catch { copyFileSync(process.execPath, link); } // Cross-volume fixtures cannot hard link.
    } else symlinkSync(process.execPath, link);
  }
  return directory;
}

export async function startBroker(options: BrokerOptions = {}): Promise<Broker> {
  const ownsRoot = !options.root;
  const root = options.root ?? mkdtempSync(join(tmpdir(), `cosyncing-e2e-${options.name ?? 'broker'}-`));
  // Under `bun run check`, anything still running under this root once the test is over is a leak.
  recordHarnessRoot(root);
  const paths = fixturePaths(root);
  await options.setup?.(paths);
  const token = options.token === true
    ? `e2e-${crypto.randomUUID().replaceAll('-', '')}`
    : options.token;
  const base = isolatedBrokerFixtureEnvironment(root, {
    overrides: {
      COSYNCING_HOME: paths.cosyncingHome,
      ...(token ? { COSYNCING_TOKEN: token } : {}),
    },
  });
  const extra = typeof options.env === 'function' ? options.env(paths) : options.env ?? {};
  const env: NodeJS.ProcessEnv = {
    ...base,
    PATH: fixturePath(paths.bin, options.hostPath ? base.PATH : undefined),
    ...extra,
  };
  const broker = new Broker(paths, env, token, ownsRoot, options.port, options.sourceDirectory);
  try {
    await broker.start();
  } catch (error) {
    await broker.stop();
    throw error;
  }
  return broker;
}
