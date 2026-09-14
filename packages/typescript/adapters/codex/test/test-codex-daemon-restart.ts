import assert from 'node:assert/strict';
import { restartCodexDaemonVerified, type CodexRestartDependencies } from '../src/daemon-restart.ts';
import { sameCodexInstallation, signalCodexDaemonProcess, type CodexDaemonProcess } from '../src/daemon-process.ts';

const target: CodexDaemonProcess = {
  pid: 123, start: '100', boot: 'boot', comm: 'codex', executable: '/fixture/codex',
  argv: ['/fixture/codex', 'app-server', '--listen', 'unix://'], home: '/fixture/home', cli: '/fixture/codex',
};

function fixture() {
  const state = { old: true, endpoint: true, newDaemon: false, unknown: false, force: 0, elapsed: 0, commands: [] as string[] };
  const deps: CodexRestartDependencies = {
    readVersion: async () => !state.endpoint ? undefined : {
      status: 'running', backend: 'pid', cliVersion: '0.154.0', appServerVersion: state.newDaemon ? '0.154.0' : '0.153.4',
    },
    captureProcess: () => state.old ? { state: 'running', process: target }
      : state.newDaemon ? { state: 'running', process: { ...target, pid: 456, start: '200' } } : { state: 'absent' },
    processState: () => state.unknown ? 'unknown' : state.old ? 'running' : 'exited',
    gracefulStop: (expected) => {
      assert.equal(expected, target);
      state.commands.push('graceful');
      state.endpoint = false;
    },
    forceStop: (expected) => {
      assert.equal(expected, target);
      assert.equal(state.unknown, false);
      state.force++;
      state.old = false;
    },
    run: async (command) => {
      assert.equal(command, 'start', 'receipt-following stop/restart must never be used');
      state.commands.push(command);
      assert.equal(state.old, false, 'must not start while the old daemon retains writer locks');
      state.newDaemon = true;
      state.endpoint = true;
      return { code: 0, stdout: '', stderr: '' };
    },
    now: () => state.elapsed,
    sleep: async (ms) => { state.elapsed += ms; },
    gracefulMs: 0,
    verifyMs: 0,
  };
  return { state, deps };
}

{
  const { state, deps } = fixture();
  await restartCodexDaemonVerified(deps, { confirmed: true });
  assert.deepEqual(state.commands, ['graceful', 'start']);
  assert.equal(state.force, 1);
  assert.equal(state.newDaemon, true);
  console.log('PASS confirmed restart recovers socket loss while the old process retains ownership');
}
{
  const { state, deps } = fixture();
  await assert.rejects(restartCodexDaemonVerified(deps), /still running/);
  assert.equal(state.force, 0);
  assert.equal(state.old, true);
  assert.equal(state.newDaemon, false);
  console.log('PASS automatic restart never force-terminates a stalled graceful drain');
}
{
  const { state, deps } = fixture();
  state.endpoint = false;
  await restartCodexDaemonVerified(deps, { confirmed: true });
  assert.deepEqual(state.commands, ['graceful', 'start']);
  assert.equal(state.force, 1);
  console.log('PASS a later confirmed restart can recover an already stranded daemon');
}
{
  const { state, deps } = fixture();
  state.endpoint = false;
  await assert.rejects(restartCodexDaemonVerified(deps), /automatic restart/);
  assert.deepEqual(state.commands, []);
  console.log('PASS an unavailable endpoint cannot authorize automatic shutdown');
}
{
  const { state, deps } = fixture();
  const graceful = deps.gracefulStop;
  deps.gracefulStop = (expected) => { graceful(expected); state.unknown = true; };
  await assert.rejects(restartCodexDaemonVerified(deps, { confirmed: true }), /identity/);
  assert.equal(state.force, 0);
  assert.equal(state.newDaemon, false);
  console.log('PASS uncertain process identity prevents termination and replacement');
}
{
  const { state, deps } = fixture();
  deps.captureProcess = () => ({ state: 'unknown', detail: 'PID receipt belongs to another process' });
  await assert.rejects(restartCodexDaemonVerified(deps, { confirmed: true }), /PID receipt/);
  assert.deepEqual(state.commands, []);
  console.log('PASS stale or foreign PID receipts prevent all lifecycle mutations');
}
{
  const { state, deps } = fixture();
  deps.captureProcess = () => ({ state: 'absent' });
  await assert.rejects(restartCodexDaemonVerified(deps, { confirmed: true }), /without a verified daemon PID receipt/);
  assert.deepEqual(state.commands, []);
  console.log('PASS answering backends without a PID receipt refuse all restart mutations');
}
{
  const { state, deps } = fixture();
  deps.gracefulStop = (expected) => {
    assert.equal(expected, target);
    state.commands.push('graceful');
    state.old = false;
    state.endpoint = false;
  };
  await restartCodexDaemonVerified(deps);
  assert.deepEqual(state.commands, ['graceful', 'start']);
  assert.equal(state.force, 0);
  console.log('PASS ordinary graceful exit restarts without force');
}
{
  const { state, deps } = fixture();
  deps.gracefulStop = () => { state.old = false; state.newDaemon = true; state.endpoint = true; };
  await restartCodexDaemonVerified(deps, { confirmed: true });
  assert.deepEqual(state.commands, []);
  assert.equal(state.force, 0);
  console.log('PASS a concurrent healthy replacement is preserved without stop or start');
}
{
  const { state, deps } = fixture();
  let captured = false;
  const capture = deps.captureProcess;
  deps.captureProcess = () => { const result = capture(); captured = true; return result; };
  deps.processState = () => {
    // Reproduce the stale receipt race: ownership changes after capture, before the shutdown boundary.
    if (captured) { state.old = false; state.newDaemon = true; state.endpoint = true; }
    return state.old ? 'running' : 'exited';
  };
  await restartCodexDaemonVerified(deps, { confirmed: true });
  assert.deepEqual(state.commands, []);
  assert.equal(state.force, 0);
  console.log('PASS replacement between receipt capture and mutation receives no shutdown command');
}
{
  const { state, deps } = fixture();
  const capture = deps.captureProcess;
  deps.captureProcess = () => state.newDaemon
    ? { state: 'running', process: { ...target, pid: 456, start: '200' } } : capture();
  deps.gracefulStop = (expected) => {
    assert.equal(expected, target);
    state.newDaemon = true;
    state.endpoint = true;
  };
  await restartCodexDaemonVerified(deps, { confirmed: true });
  assert.equal(state.force, 1, 'a new version cannot hide a surviving old writer');
  assert.deepEqual(state.commands, [], 'only the captured old daemon may be signalled');
  console.log('PASS version replacement alone cannot prove the old writer exited');
}
{
  const { state, deps } = fixture();
  deps.forceStop = () => { state.force++; }; // signal accepted, process still alive
  await assert.rejects(restartCodexDaemonVerified(deps, { confirmed: true }), /did not exit/);
  assert.equal(state.newDaemon, false);
  assert.equal(state.commands.includes('start'), false);
  console.log('PASS a successful signal is not mistaken for process exit');
}
{
  const { deps } = fixture();
  const run = deps.run;
  deps.run = async (...args) => { const result = await run(...args); deps.readVersion = async () => undefined; return result; };
  await assert.rejects(restartCodexDaemonVerified(deps, { confirmed: true }), /failed verification/);
  console.log('PASS start exit zero without a healthy endpoint is rejected');
}
for (const state of ['exited', 'unknown'] as const) {
  const events: string[] = [];
  const invoke = () => signalCodexDaemonProcess(target, 'SIGKILL', {
    bind: (pid) => {
      assert.equal(pid, target.pid);
      events.push('bind');
      return { send: () => { events.push('send'); }, close: () => { events.push('close'); } };
    },
    state: () => { events.push('verify'); return state; },
  });
  if (state === 'unknown') assert.throws(invoke, /identity changed/);
  else invoke();
  assert.deepEqual(events, ['bind', 'verify', 'close']);
}
console.log('PASS process handles close without signalling when identity changes after binding');
{
  const events: string[] = [];
  let owner = 'old';
  signalCodexDaemonProcess(target, 'SIGTERM', {
    bind: () => {
      const bound = owner;
      events.push('bind');
      return { send: () => { owner = 'replacement'; events.push(`signal:${bound}`); }, close: () => { events.push('close'); } };
    },
    state: () => { events.push('verify'); return 'running'; },
  });
  assert.equal(owner, 'replacement');
  assert.deepEqual(events, ['bind', 'verify', 'signal:old', 'close']);
  console.log('PASS signal dispatch uses the bound process even when the PID owner changes at dispatch');
}
if (process.platform === 'linux') {
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    // Exercise the real pidfd primitive on a disposable sleep child, never a managed runtime.
    const child = Bun.spawn(['/bin/sleep', '10'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    try {
      signalCodexDaemonProcess({ ...target, pid: child.pid }, signal, { state: () => 'running' });
      await child.exited;
      assert.equal(child.signalCode, signal);
    } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
  }
  console.log('PASS Linux pidfd dispatch signals only disposable fixture children');
}
assert.equal(sameCodexInstallation('/x/standalone/releases/0.153.4-x86_64/bin/codex', '/x/standalone/releases/0.154.0-x86_64/bin/codex'), true);
assert.equal(sameCodexInstallation('/other/standalone/releases/0.153.4-x86_64/bin/codex', '/x/standalone/releases/0.154.0-x86_64/bin/codex'), false);
assert.equal(sameCodexInstallation('/x/standalone/releases/untrusted/bin/codex', '/x/standalone/releases/0.154.0-x86_64/bin/codex'), false);
console.log('PASS daemon recovery confines executable identity to the same standalone installation');
