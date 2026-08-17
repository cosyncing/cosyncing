import { writeSync } from 'node:fs';

/**
 * End the process on a fatal startup failure, with the diagnostic intact.
 *
 * Setting `process.exitCode` is NOT enough at a process entry point, and the
 * difference is not cosmetic. That field only decides what code is used *once
 * the event loop drains*; a startup that throws part-way has usually already
 * registered something that keeps it from draining — a timer, a watcher, a
 * socket — so the process stays alive forever, having announced that it failed.
 * What the operator gets is a broker that is running and serving nothing, and
 * what a supervisor sees is a healthy unit. A caller waiting on the process to
 * die (a test fixture, a service manager, a shell `&&`) waits out its whole
 * ceiling instead of being told immediately.
 *
 * Written with `writeSync` rather than `console.error`, because the exit that
 * follows is the whole point: stderr to a pipe is asynchronous, and the pending
 * write would be discarded by `process.exit`, turning a diagnosable failure into
 * a silent one. The message is what makes the difference between "the port was
 * taken" and "the broker died".
 *
 * NOT a general-purpose teardown. There is nothing to dispose here — the
 * failure happened during construction, so no runtime handle exists to shut
 * down — and transactional startup cleanup is a larger change than this
 * boundary.
 */
export function exitFatalStartup(message: string, code = 1): never {
  try {
    writeSync(2, message.endsWith('\n') ? message : `${message}\n`);
  } catch {
    /* A closed or full stderr must not become a different failure than the one
       being reported; exiting with the right code still tells the caller. */
  }
  process.exit(code);
}

/**
 * How long a pending diagnostic may hold up the exit. See {@link exitAfterDiagnostics}.
 *
 * Bounded because the failure being reported can be the very reason the pipe is
 * not draining. An unbounded flush would reintroduce, at the exit, exactly the
 * hang this module exists to remove.
 */
export const DIAGNOSTIC_FLUSH_CEILING_MS = 1_000;

/**
 * Exit non-zero once diagnostics ALREADY WRITTEN to stdio have actually left.
 *
 * For entry points whose message went out through an ordinary stream write
 * rather than {@link exitFatalStartup}: `process.stdout`/`process.stderr` are
 * asynchronous when they point at a pipe — which is what a supervisor, a shell
 * pipeline and a test fixture all give them — so the buffered text is discarded
 * if the process exits first. Waiting for the flush is what keeps "broker
 * failed: port in use" from arriving as silence with an exit code.
 */
export async function exitAfterDiagnostics(code: number): Promise<never> {
  await Promise.race([
    Promise.all([flushStream(process.stdout), flushStream(process.stderr)]),
    new Promise((resolve) => setTimeout(resolve, DIAGNOSTIC_FLUSH_CEILING_MS)),
  ]);
  process.exit(code);
}

/** Resolve once everything queued on `stream` has been handed to the OS. */
function flushStream(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    try {
      // The callback form fires when THIS chunk is flushed, which — because a
      // stream preserves write order — means every chunk before it is out too.
      stream.write('', () => resolve());
    } catch {
      resolve();
    }
  });
}
