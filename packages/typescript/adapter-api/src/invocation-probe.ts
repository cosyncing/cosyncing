import { spawnResolvedInvocation, type ResolvedInvocation } from './invocation.ts';
import { terminateHostProcessTree } from './host-process.ts';

export interface InvocationProbe {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
  timedOut: boolean;
}

/** Bounded, asynchronous read-only probe through the shared Windows invocation boundary.
 * Never blocks the broker while a native CLI starts. Timeout/overflow fail closed and
 * terminate only the child this call created (the launcher tree on Windows). */
export function probeResolvedInvocation(
  invocation: ResolvedInvocation,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
): Promise<InvocationProbe> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnResolvedInvocation>;
    try {
      child = spawnResolvedInvocation(invocation, args, {
        env: options.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch (error) {
      resolve({ status: null, stdout: '', stderr: '', timedOut: false,
        error: error instanceof Error ? error : new Error('Probe could not start') });
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let failure: Error | undefined;
    let timedOut = false;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(reapTimer);
      resolve({ status, stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'), timedOut,
        ...(failure ? { error: failure } : {}) });
    };
    const stop = (error: Error) => {
      if (failure || settled) return;
      failure = error;
      // close can lag exit while descendants hold a pipe. Never signal the
      // numeric PID after our child has exited: it may already be reused.
      if (child.exitCode === null && child.signalCode === null) {
        if (child.pid) terminateHostProcessTree(child.pid, true);
        else child.kill('SIGKILL');
      }
      // A descendant holding a pipe must not keep a failed probe pending forever.
      reapTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null);
      }, 1_000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop(new Error('Native probe timed out'));
    }, options.timeout);
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      if (failure || settled) return;
      bytes += chunk.length;
      if (bytes > options.maxBuffer) { stop(new Error('Native probe output exceeded its limit')); return; }
      chunks.push(chunk);
    };
    child.stdout?.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.on('error', (error) => { failure = error; finish(null); });
    child.on('close', (status) => finish(status));
  });
}
