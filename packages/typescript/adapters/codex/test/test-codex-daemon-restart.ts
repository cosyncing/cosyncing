import assert from 'node:assert/strict';
import { restartCodexDaemonVerified, type CodexRestartDependencies } from '../src/daemon-restart.ts';
import { sameCodexInstallation, type CodexDaemonProcess } from '../src/daemon-process.ts';

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
    forceStop: (expected) => {
      assert.equal(expected, target);
      assert.equal(state.unknown, false);
      state.force++;
      state.old = false;
    },
    generation: () => state.endpoint ? state.newDaemon ? 'new-socket' : 'old-socket' : undefined,
    run: async (command) => {
      state.commands.push(command);
      if (command === 'restart' || command === 'stop') state.endpoint = false;
      else {
        assert.equal(state.old, false, 'must not start while the old daemon retains writer locks');
        state.newDaemon = true;
        state.endpoint = true;
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    now: () => state.elapsed,
    sleep: async (ms) => { state.elapsed += ms; },
    verifyMs: 0,
  };
  return { state, deps };
}

{
  const { state, deps } = fixture();
  await restartCodexDaemonVerified(deps, { confirmed: true });
  assert.deepEqual(state.commands, ['restart', 'stop', 'start']);
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
  assert.deepEqual(state.commands, ['stop', 'start']);
  assert.equal(state.force, 1);
  console.log('PASS a later confirmed restart can recover an already stranded daemon');
}
{
  const { state, deps } = fixture();
  const run = deps.run;
  deps.run = async (...args) => {
    const result = await run(...args);
    if (args[0] === 'stop') state.unknown = true;
    return result;
  };
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
  const capture = deps.captureProcess;
  deps.captureProcess = () => state.newDaemon
    ? { state: 'running', process: { ...target, pid: 456, start: '200' } } : capture();
  deps.run = async (command) => {
    state.commands.push(command);
    state.old = false;
    state.newDaemon = true;
    return { code: 0, stdout: '', stderr: '' };
  };
  await restartCodexDaemonVerified(deps, { confirmed: true });
  assert.deepEqual(state.commands, ['restart']);
  assert.equal(state.force, 0);
  console.log('PASS a healthy native replacement is accepted without stop or force');
}
{
  const { state, deps } = fixture();
  const capture = deps.captureProcess;
  deps.captureProcess = () => state.newDaemon
    ? { state: 'running', process: { ...target, pid: 456, start: '200' } } : capture();
  deps.run = async (command) => {
    state.commands.push(command);
    if (command === 'restart') { state.newDaemon = true; state.endpoint = true; }
    else if (command === 'stop') state.endpoint = false;
    else state.endpoint = true;
    return { code: 0, stdout: '', stderr: '' };
  };
  await restartCodexDaemonVerified(deps, { confirmed: true });
  assert.equal(state.force, 1, 'a new version cannot hide a surviving old writer');
  assert.deepEqual(state.commands, ['restart'], 'native stop must not target the replacement receipt');
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
  const { state, deps } = fixture();
  const run = deps.run;
  deps.run = async (...args) => {
    const result = await run(...args);
    if (args[0] === 'start') state.endpoint = false;
    return result;
  };
  await assert.rejects(restartCodexDaemonVerified(deps, { confirmed: true }), /failed verification/);
  console.log('PASS start exit zero without a healthy endpoint is rejected');
}
assert.equal(sameCodexInstallation('/x/standalone/releases/0.153.4-x86_64/bin/codex', '/x/standalone/releases/0.154.0-x86_64/bin/codex'), true);
assert.equal(sameCodexInstallation('/other/standalone/releases/0.153.4-x86_64/bin/codex', '/x/standalone/releases/0.154.0-x86_64/bin/codex'), false);
assert.equal(sameCodexInstallation('/x/standalone/releases/untrusted/bin/codex', '/x/standalone/releases/0.154.0-x86_64/bin/codex'), false);
console.log('PASS daemon recovery confines executable identity to the same standalone installation');
