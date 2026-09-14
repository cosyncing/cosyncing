import type { CodexDaemonVersion } from './implementation.ts';
import type { CodexDaemonProcess, CodexDaemonProcessRead } from './daemon-process.ts';

export interface CodexRestartOptions { confirmed?: boolean }
export interface CodexDaemonCommandResult { code: number; stdout: string; stderr: string; timedOut?: boolean }
export interface CodexRestartDependencies {
  readVersion(): Promise<CodexDaemonVersion | undefined>;
  captureProcess(): CodexDaemonProcessRead;
  processState(process: CodexDaemonProcess): 'running' | 'exited' | 'unknown';
  forceStop(process: CodexDaemonProcess): void;
  generation(version?: CodexDaemonVersion): string | undefined;
  run(command: 'restart' | 'stop' | 'start', timeoutMs: number): Promise<CodexDaemonCommandResult>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  verifyMs?: number;
  log?: (message: string) => void;
}

/** Process lifetime and endpoint health are separate facts, especially during graceful drain. */
export async function restartCodexDaemonVerified(deps: CodexRestartDependencies, options: CodexRestartOptions = {}): Promise<void> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const before = await deps.readVersion();
  const captured = deps.captureProcess();
  if (captured.state === 'unknown') throw new Error(captured.detail);
  const old = captured.state === 'running' ? captured.process : undefined;
  const generation = deps.generation(before);
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
  const replacement = async (): Promise<boolean> => {
    if (!exited()) return false;
    const version = await deps.readVersion();
    if (!installed(version)) return false;
    const nextGeneration = deps.generation(version);
    return old !== undefined || (generation !== undefined && nextGeneration !== undefined && nextGeneration !== generation)
      || (before !== undefined && before.cliVersion !== before.appServerVersion);
  };
  const command = async (name: 'restart' | 'stop' | 'start', timeoutMs: number) => {
    log(`${name} requested${old ? `; previous pid=${old.pid}` : ''}; confirmed=${options.confirmed === true}`);
    const result = await deps.run(name, timeoutMs);
    log(`${name} finished; exit=${result.code}; timedOut=${result.timedOut === true}`);
    return result;
  };

  if (before?.status === 'running') {
    await command('restart', 10_000);
    if (await wait(replacement, deps.verifyMs ?? 2_000)) {
      log('native restart verified; previous process exited and installed daemon is answering');
      return;
    }
  } else if (!options.confirmed) {
    throw new Error('Codex control endpoint is unavailable; automatic restart cannot establish a safe daemon state.');
  }

  const owner = deps.captureProcess();
  if (owner.state === 'unknown') throw new Error(owner.detail);
  const replaced = old && owner.state === 'running'
    && (owner.process.pid !== old.pid || owner.process.start !== old.start || owner.process.boot !== old.boot);
  if (!exited() || before?.status === 'running') {
    // Native stop follows the current PID receipt; it must never stop an external replacement.
    if (!replaced) await command('stop', 5_000);
    if (!await wait(exited, deps.verifyMs ?? 2_000)) {
      if (!options.confirmed) throw new Error('Codex daemon is still running after graceful shutdown. Use the confirmed Restart action to recover it.');
      if (!old || deps.processState(old) !== 'running') throw new Error('Codex daemon exit or identity could not be verified; recovery was refused.');
      log(`graceful shutdown stalled; terminating verified pid=${old.pid}`);
      deps.forceStop(old);
      if (!await wait(exited, 5_000)) throw new Error('Codex daemon did not exit after termination; no replacement was started.');
    }
  }
  // A concurrent external replacement must be preserved. The old process exiting alone is not
  // authorization to stop whichever daemon the native PID receipt now names.
  const current = deps.captureProcess();
  if (current.state === 'unknown') throw new Error(current.detail);
  if (current.state === 'running') {
    if (await replacement()) return;
    throw new Error('Another Codex daemon is running; its ownership was preserved.');
  }
  const stoppedVersion = await deps.readVersion();
  if (stoppedVersion?.status === 'running') {
    if (await replacement()) return;
    throw new Error('Codex control endpoint still reports a running daemon; no replacement was started.');
  }
  const started = await command('start', 15_000);
  if (started.code !== 0) throw new Error(started.stderr.trim() || started.stdout.trim() || 'Codex daemon start failed.');
  if (!await wait(async () => exited() && installed(await deps.readVersion()), 5_000)) {
    throw new Error('Codex restart failed verification: the previous process must exit and the installed daemon must answer.');
  }
  log('restart verified; previous process exited and installed daemon is answering');
}
