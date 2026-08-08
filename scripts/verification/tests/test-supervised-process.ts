#!/usr/bin/env bun
/**
 * The process supervisor every gate and sub-suite runs through.
 *
 * Each case here is a failure that was actually observed on this repository,
 * not a hypothetical: a finished check that left a browser holding a debug
 * port, ancient test hosts still running weeks later, and — introduced while
 * fixing those — a suite that hung for its full timeout because a leaked
 * grandchild held the stdout pipe open.
 */
import { runSupervised, supportsGroupIsolation } from '../supervised-process.ts';

let checks = 0;
let failures = 0;
function check(label: string, condition: unknown): void {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.error(`  FAIL ${label}`);
}

const base = { cwd: process.cwd(), env: process.env };

if (process.argv.includes('--nested-stage-fixture')) {
  // This process is itself supervised by the regression below. The nested
  // deadline must stay in this process group so killing the outer suite also
  // reaches the grandchild it is waiting on.
  await runSupervised(
    ['bash', '-c', "bash -c 'exec -a cosyncingnestedsupervisorprobe sleep 300' & wait"],
    { ...base, timeoutMs: 60_000, graceMs: 500, isolateProcessGroup: false },
  );
  process.exit(0);
}

const exited = await runSupervised(
  ['bash', '-c', 'echo out; echo err >&2; exit 3'],
  { ...base, timeoutMs: 30_000 },
);
check('exit code is reported', exited.exitCode === 3);
check('stdout is captured', exited.stdout.trim() === 'out');
check('stderr is captured', exited.stderr.trim() === 'err');
check('a clean exit is not a timeout', !exited.timedOut);
check('a failing exit is not a success', !exited.success);

if (supportsGroupIsolation()) {
  // A wedged tree must die with its leader, or a timeout just orphans it.
  const alive = () => Number(
    Bun.spawnSync(['bash', '-c', 'ps -eo args= | grep -c "^$T" || true'], {
      env: { ...process.env, T: 'cosyncingsupervisorprobe' },
    }).stdout.toString().trim() || '0',
  );
  const hung = await runSupervised(
    ['bash', '-c',
      "bash -c 'exec -a cosyncingsupervisorprobe sleep 300' & "
      + "bash -c 'exec -a cosyncingsupervisorprobe sleep 300' & wait"],
    { ...base, timeoutMs: 2_000, graceMs: 500 },
  );
  // Checked with no sleep first: returning before the kill has finished is the
  // race this guards. The timeout used to fire termination without awaiting
  // it, so the call could return with the group still up — and then send a
  // late SIGKILL to a process-group id the kernel may have recycled.
  check('a timeout kills grandchildren before returning', alive() === 0);
  await Bun.sleep(700);
  check('an overrun is reported as a timeout', hung.timedOut);
  check('nothing survives the timeout', alive() === 0);

  // Leaking past a *successful* exit is the case that went unnoticed for weeks.
  const leaked = await runSupervised(
    ['bash', '-c',
      "nohup bash -c 'exec -a cosyncingsupervisorprobe sleep 300' >/dev/null 2>&1 & exit 0"],
    { ...base, timeoutMs: 30_000, graceMs: 500 },
  );
  await Bun.sleep(700);
  check('a leak past a clean exit is reported', leaked.strays);
  check('a leak past a clean exit is reaped', alive() === 0);

  // A `dart analyze` child that is already exiting must not be called a leak,
  // and a real leak must survive the same window. Both use `strayGraceMs`.
  const settling = await runSupervised(
    ['bash', '-c',
      "nohup bash -c 'exec -a cosyncingsupervisorprobe sleep 0.7' >/dev/null 2>&1 & exit 0"],
    { ...base, timeoutMs: 30_000, graceMs: 500, strayGraceMs: 5_000 },
  );
  check('a child still exiting is not reported as a stray', !settling.strays);
  check('waiting out a teardown does not wait out the whole window',
    settling.durationMs < 4_000);
  check('nothing is left behind after a settled teardown', alive() === 0);

  // The same leak as above, now with a grace window: bounded re-polling must
  // not turn a process that never exits into a pass.
  const persistent = await runSupervised(
    ['bash', '-c',
      "nohup bash -c 'exec -a cosyncingsupervisorprobe sleep 300' >/dev/null 2>&1 & exit 0"],
    { ...base, timeoutMs: 30_000, graceMs: 500, strayGraceMs: 500 },
  );
  await Bun.sleep(700);
  check('a grace window still reports a process that never exits', persistent.strays);
  check('a grace window still reaps a real leak', alive() === 0);

  // Every process in a group holds the pipes. Waiting for end-of-stream as a
  // condition of finishing turned one leaked child into a full-timeout hang.
  const started = Date.now();
  const holding = await runSupervised(
    ['bash', '-c', 'echo leader; sleep 300 & exit 0'],
    { ...base, timeoutMs: 60_000, graceMs: 1_000 },
  );
  check('a held pipe does not stall the supervisor', Date.now() - started < 15_000);
  check('output survives a held pipe', holding.stdout.trim() === 'leader');
  check('a held pipe is not a timeout', !holding.timedOut);

  const nestedAlive = () => Number(
    Bun.spawnSync(['bash', '-c', 'ps -eo args= | grep -c "^cosyncingnestedsupervisorprobe" || true'], {
      env: process.env,
    }).stdout.toString().trim() || '0',
  );
  const nested = await runSupervised(
    ['bun', 'run', import.meta.path, '--nested-stage-fixture'],
    { ...base, timeoutMs: 2_000, graceMs: 500 },
  );
  check('the outer suite timeout is reported around a nested stage', nested.timedOut);
  check('a nested supervised grandchild stays reachable by the outer group sweep', nestedAlive() === 0);
}

const capped = await runSupervised(
  ['bash', '-c', 'yes hello | head -c 200000'],
  { ...base, timeoutMs: 30_000, maxBufferBytes: 1000 },
);
check('oversized output is flagged', capped.truncated);
check('oversized output is capped', capped.stdout.length === 1000);
check('a capped writer still exits cleanly', capped.exitCode === 0);

if (failures > 0) {
  console.error(`FAIL supervised-process: ${failures} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`PASS ${checks}/${checks} supervised-process checks`);
