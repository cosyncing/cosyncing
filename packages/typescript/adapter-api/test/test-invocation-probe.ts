import assert from 'node:assert/strict';
import { spyOn } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import * as invocations from '../src/invocation.ts';
import { probeResolvedInvocation, resolveInvocation } from '../src/index.ts';

const invocation = resolveInvocation(process.execPath)!;
assert(invocation);
const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
const run = (script: string, timeout = 5_000, maxBuffer = 1024) => probeResolvedInvocation(
  invocation, ['-e', script], { env, timeout, maxBuffer },
);
let ticked = false;
const timer = setTimeout(() => { ticked = true; }, 10);
const slow = await run('setTimeout(() => console.log("ready"), 100)');
clearTimeout(timer);
assert(ticked, 'native startup must not block the event loop');
assert.equal(slow.status, 0);
assert.equal(slow.stdout.trim(), 'ready');
assert.equal(slow.error, undefined);
const failed = await run('console.error("refused"); process.exit(7)');
assert.equal(failed.status, 7);
assert.equal(failed.stderr.trim(), 'refused');
const overflow = await run('console.log("x".repeat(4096))');
assert(overflow.error, 'oversized output fails closed');
assert(overflow.stdout.length <= 1024);
const timeout = await run('setInterval(() => {}, 1000)', 100);
assert(timeout.timedOut && timeout.error, 'timeout fails closed');
if (process.platform !== 'win32') {
  // Narrow host-primitive exception: an exited PID with descendant-held pipes
  // cannot be arranged reliably by assuming OS startup finishes within 350 ms.
  // All other scenarios above use real children; inject this exact lifecycle
  // state to verify the PID-reuse guard without ever signalling a numeric PID.
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const exitedParent = Object.assign(new EventEmitter(), {
    pid: 1234567, exitCode: 0, signalCode: null, stdout, stderr,
  }) satisfies Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'stdout' | 'stderr'>;
  const spawn = spyOn(invocations, 'spawnResolvedInvocation').mockReturnValue(exitedParent as unknown as ChildProcess);
  const kill = spyOn(process, 'kill').mockImplementation(() => true);
  try {
    const heldPipe = await run('', 350);
    assert(heldPipe.timedOut && heldPipe.error, 'a descendant-held pipe remains bounded');
    assert.equal(kill.mock.calls.length, 0, 'do not signal an already-exited parent PID');
    assert(stdout.destroyed && stderr.destroyed, 'bounded completion releases the held pipes');
  } finally {
    spawn.mockRestore();
    kill.mockRestore();
    stdout.destroy();
    stderr.destroy();
  }
}
const missing = await probeResolvedInvocation({ kind: 'native', executable: '/nonexistent/cosyncing-probe', originalPath: '/nonexistent/cosyncing-probe', prefixArgs: [] }, [], { env, timeout: 100, maxBuffer: 1024 });
assert(missing.error);
console.log('PASS asynchronous invocation probe: responsiveness, exit status, stderr, bounded output, timeout, missing executable');
