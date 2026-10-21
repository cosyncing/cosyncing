/**
 * Run the product's command line, or a broker that is expected to exit, as a
 * separate process with a deadline.
 *
 * Every run is announced on stderr before it starts, both streams are captured
 * (never ignored), and a run that outlives its deadline is killed and reaped
 * and reported as `timedOut` rather than hanging the suite. The environment is
 * the isolated fixture environment: nothing from the developer's shell, no
 * host `PORT`/`HOST`/`COSYNCING_*`, and a PATH without the developer's tools.
 */
import { join } from 'node:path';
import { isolatedBrokerFixtureEnvironment } from '../../packages/typescript/broker/test/helpers/isolated-broker-fixture.ts';
import { fixturePath, REPO_ROOT } from './broker.ts';
import { scaled, SOON_MS } from './wait.ts';

export const CLI_ENTRY = join(REPO_ROOT, 'packages/typescript/broker/src/cli/cli.ts');
export const BROKER_ENTRY = join(REPO_ROOT, 'packages/typescript/broker/src/main.ts');

export interface ProcessResult {
  exitCode: number | null;
  signalCode: string | number | null;
  stdout: string;
  stderr: string;
  /** stdout then stderr, for assertions that do not care which. */
  output: string;
  timedOut: boolean;
}

export interface RunOptions {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** Hang detector, not a performance claim. Default 60 s (scaled). */
  timeoutMs?: number;
  /** Shown in the announcement and in a timeout report. */
  label?: string;
}

/**
 * The isolated environment for a process rooted at `root`, with PATH limited
 * to `bin`, Bun and the system directories.
 */
export function fixtureEnvironment(
  root: string,
  bin: string,
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const base = isolatedBrokerFixtureEnvironment(root);
  const env: NodeJS.ProcessEnv = { ...base, PATH: fixturePath(bin), NO_COLOR: '1', FORCE_COLOR: '0' };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** Spawn `argv`, wait for it to exit under a deadline, and return what it said. */
export async function runToExit(argv: string[], options: RunOptions): Promise<ProcessResult> {
  const timeoutMs = scaled(options.timeoutMs ?? 3 * SOON_MS);
  const label = options.label ?? argv.slice(1).join(' ');
  process.stderr.write(`[e2e] run: ${label}\n`);
  const child = Bun.spawn(argv, {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = await Promise.race([
    child.exited.then(() => true),
    new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
  ]);
  clearTimeout(timer);
  if (!exited) {
    child.kill('SIGKILL');
    await Promise.race([child.exited, new Promise((resolve) => setTimeout(resolve, scaled(5_000)))]);
  }
  // The pipes close when the process (and anything holding them) exits; a
  // bounded wait keeps a leaked grandchild from hanging the read.
  const settle = <T>(promise: Promise<T>, fallback: T): Promise<T> =>
    Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), scaled(5_000)))]);
  const [out, err] = await Promise.all([settle(stdout, ''), settle(stderr, '')]);
  if (!exited) process.stderr.write(`[e2e] run timed out after ${timeoutMs}ms: ${label}\n${out}${err}\n`);
  return {
    exitCode: child.exitCode,
    signalCode: child.signalCode ?? null,
    stdout: out,
    stderr: err,
    output: `${out}${err}`,
    timedOut: !exited,
  };
}

/**
 * The command line of a running process, or '' when it cannot be read. Bounded:
 * a stuck `ps` or PowerShell probe fails the read instead of hanging the suite.
 */
export function commandLineOf(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) return '';
  const timeout = scaled(10_000);
  if (process.platform !== 'win32') {
    const probe = Bun.spawnSync(['ps', '-o', 'args=', '-p', String(pid)], { stdout: 'pipe', stderr: 'pipe', timeout });
    if (probe.exitCode === null) throw new Error(`ps did not answer within ${timeout}ms for pid ${pid}`);
    return probe.stdout.toString();
  }
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot) return '';
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // The pid is validated as a positive integer above, so it cannot carry PowerShell syntax into the filter.
  const script = `$ErrorActionPreference='Stop'\n(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine\n`;
  const probe = Bun.spawnSync(
    [powershell, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { stdout: 'pipe', stderr: 'pipe', timeout },
  );
  if (probe.exitCode === null) throw new Error(`PowerShell did not answer within ${timeout}ms for pid ${pid}`);
  return probe.stdout.toString();
}

/** `cosyncing <args>` from source, as the operator would run it. */
export function runCli(args: string[], options: RunOptions): Promise<ProcessResult> {
  return runToExit(['bun', CLI_ENTRY, ...args], { label: `cosyncing ${args.join(' ')}`, ...options });
}
