import type { CodexDaemonVersion } from './implementation.ts';
import type { CodexDaemonProcess, CodexDaemonProcessRead } from './daemon-process.ts';

export function codexDaemonOwnershipFailure(detail: string): Error {
  return new Error(`cosyncing could not confirm it manages the Codex daemon: ${detail} While nothing is running, you can restart it yourself with \`codex app-server daemon restart\`.`);
}

export interface CodexRestartOptions { confirmed?: boolean }
export interface CodexDaemonCommandResult { code: number; stdout: string; stderr: string; timedOut?: boolean }
export interface CodexRestartDependencies {
  readVersion(): Promise<CodexDaemonVersion | undefined>;
  captureProcess(): CodexDaemonProcessRead;
  processState(process: CodexDaemonProcess): 'running' | 'exited' | 'unknown';
  gracefulStop(process: CodexDaemonProcess): void;
  forceStop(process: CodexDaemonProcess): void;
  /** `args` follow the subcommand: the `-c features.<name>=<bool>` pairs to relaunch with. */
  run(command: 'start', timeoutMs: number, args?: readonly string[]): Promise<CodexDaemonCommandResult>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  gracefulMs?: number;
  verifyMs?: number;
  log?: (message: string) => void;
}

/** Process lifetime and endpoint health are separate facts, especially during graceful drain. */
export async function restartCodexDaemonVerified(deps: CodexRestartDependencies, options: CodexRestartOptions = {}): Promise<void> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const before = await deps.readVersion();
  const captured = deps.captureProcess();
  if (captured.state === 'unknown') throw codexDaemonOwnershipFailure(captured.detail);
  const old = captured.state === 'running' ? captured.process : undefined;
  if (before?.status === 'running' && !old) {
    throw new Error('Codex is answering without a verified daemon PID receipt; this backend cannot be restarted safely.');
  }
  if (before?.status !== 'running' && !options.confirmed) {
    throw new Error('Codex control endpoint is unavailable; automatic restart cannot establish a safe daemon state.');
  }
  const exited = () => !old || deps.processState(old) === 'exited';
  const installed = (version?: CodexDaemonVersion) => version?.status === 'running'
    && !!version.backend && version.cliVersion === version.appServerVersion;
  const log = deps.log ?? (() => {});
  const wait = async (predicate: () => Promise<boolean> | boolean, ms: number): Promise<boolean> => {
    const deadline = now() + ms;
    do {
      if (await predicate()) return true;
      if (now() >= deadline) return false;
      await sleep(Math.min(100, deadline - now()));
    } while (true);
  };
  const replacement = async () => exited() && installed(await deps.readVersion());

  if (old && !exited()) {
    // Native restart/stop follow the receipt again inside another process. A replacement can claim
    // that receipt after our inspection, so neither command can safely target the captured daemon.
    log(`graceful shutdown requested; captured pid=${old.pid}; confirmed=${options.confirmed === true}`);
    deps.gracefulStop(old);
    if (!await wait(exited, deps.gracefulMs ?? 7_000)) {
      if (!options.confirmed) throw new Error('Codex daemon is still running after graceful shutdown. Use the confirmed Restart action to recover it.');
      if (deps.processState(old) !== 'running') throw new Error('Codex daemon exit or identity could not be verified; recovery was refused.');
      log(`graceful shutdown stalled; terminating verified pid=${old.pid}`);
      deps.forceStop(old);
      if (!await wait(exited, 5_000)) throw new Error('Codex daemon did not exit after termination; no replacement was started.');
    }
  }
  if (old) log(`previous process exit verified; captured pid=${old.pid}`);
  // Preserve any concurrent replacement, including one that appears while the captured daemon
  // drains. Start is the only receipt-following command: it never stops a pre-existing daemon.
  const current = deps.captureProcess();
  if (current.state === 'unknown') throw codexDaemonOwnershipFailure(current.detail);
  if (current.state === 'running') {
    if (await wait(replacement, deps.verifyMs ?? 2_000)) {
      log('restart verified; previous process exited and replacement daemon is answering');
      return;
    }
    throw new Error('Another Codex daemon is running; its ownership was preserved.');
  }
  const stoppedVersion = await deps.readVersion();
  if (stoppedVersion?.status === 'running') {
    if (await replacement()) return;
    throw new Error('Codex control endpoint still reports a running daemon; no replacement was started.');
  }
  // A fresh `daemon start` replaces the saved feature overrides with the ones it is given (Codex
  // 0.169+), so a plain start would drop them. Relaunch with exactly the pairs the verified daemon ran
  // with; Codex validates and saves them again.
  const overrides = old?.featureOverrides ?? [];
  log(`start requested; confirmed=${options.confirmed === true}; featureOverrides=${overrides.length}`);
  let started = await deps.run('start', 15_000, overrides.flatMap((pair) => ['-c', pair]));
  log(`start finished; exit=${started.code}; timedOut=${started.timedOut === true}`);
  if (started.code !== 0 && !started.timedOut && overrides.length) {
    // The installed CLI may no longer accept a saved feature. The old daemon is already gone, so
    // keep Codex available without the overrides rather than leave it stopped.
    log(`start with saved feature overrides failed; starting without them: ${started.stderr.trim() || started.stdout.trim()}`);
    started = await deps.run('start', 15_000);
    log(`start finished; exit=${started.code}; timedOut=${started.timedOut === true}`);
  }
  if (started.code !== 0) throw new Error(started.stderr.trim() || started.stdout.trim() || 'Codex daemon start failed.');
  if (!await wait(replacement, 5_000)) {
    throw new Error('Codex restart failed verification: the previous process must exit and the installed daemon must answer.');
  }
  log('restart verified; previous process exited and installed daemon is answering');
}
