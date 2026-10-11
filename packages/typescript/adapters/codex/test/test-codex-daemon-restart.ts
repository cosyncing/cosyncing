import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostProcessProvider } from '@cosyncing/adapter-api';
import { restartCodexDaemonVerified, type CodexRestartDependencies } from '../src/daemon-restart.ts';
import { codexDaemonCommandArguments, parseManagedCodexDaemonArguments, readCodexDaemonProcess, managedCodexDaemonArguments, sameCodexInstallation, signalCodexDaemonProcess, type CodexDaemonProcess } from '../src/daemon-process.ts';

for (const remote of [[], ['--remote-control']]) {
  const legacy = ['app-server', ...remote, '--listen', 'unix://'];
  assert.equal(managedCodexDaemonArguments(legacy), true);
  assert.equal(managedCodexDaemonArguments([...legacy, '--managed-daemon']), true);
  for (const unsafe of [
    ['--managed-daemon', ...legacy],
    [...legacy.slice(0, -1), 'unix:///other/socket', '--managed-daemon'],
    [...legacy.slice(0, -1), 'ws://127.0.0.1:1234', '--managed-daemon'],
    [...legacy, '--config', 'profile=other'],
  ]) assert.equal(managedCodexDaemonArguments(unsafe), false, JSON.stringify(unsafe));
}
assert.equal(managedCodexDaemonArguments(['app-server', '--stdio', '--managed-daemon']), false);
const modern = ['app-server', '--remote-control', '--listen', 'unix://', '--analytics-default-enabled', '--managed-daemon'];
for (const accepted of [
  modern,
  ['app-server', '--managed-daemon', '--analytics-default-enabled', '--listen', 'unix://', '--remote-control'],
  ['app-server', '--future-flag', '--listen=unix://'],
]) assert.equal(managedCodexDaemonArguments(accepted), true, JSON.stringify(accepted));
assert.deepEqual(parseManagedCodexDaemonArguments(modern), { valid: true, unknownFlags: ['--analytics-default-enabled'] });
assert.deepEqual(parseManagedCodexDaemonArguments(['app-server', '--listen=unix://', '--future-flag']), { valid: true, unknownFlags: ['--future-flag'] });
for (const unsafe of [
  ['app-server', '--listen', 'ws://127.0.0.1:4500'],
  ['app-server', '--listen', 'unix:///tmp/other.sock'],
  ['app-server', '--listen=ws://127.0.0.1:4500'],
  ['app-server', '--listen=unix:///tmp/other.sock'],
  ['app-server', '--listen', 'unix://', '--listen=unix://'],
  ['app-server', '--listen=unix://', '--listen', 'unix://'],
  ['app-server', '--listen', 'unix://', '--config', 'x=y'],
  ['app-server', '--listen', 'unix://', '-c', 'x'],
  ['app-server', 'daemon', 'pid-update-loop'],
  ['app-server'],
  ['app-server', '--listen'],
  ['app-server', '--listen', 'unix://', '--x=1'],
  ['app-server', '--listen', 'unix://', '--UPPER'],
  ['app-server', '--listen', 'unix://', '--bad_flag'],
]) assert.equal(managedCodexDaemonArguments(unsafe), false, JSON.stringify(unsafe));
for (const [token, rest, named] of [
  ['--config', ['x=y'], '--config'], ['-c', ['x'], '-c'], ['--x=1', [], '--x=1'],
  ['--listen', ['unix:///private/path/control.sock'], '--listen'],
  ['--x=/private/path/config', [], '--x=<value>'],
  ['--UPPER', [], '--UPPER'], ['--bad_flag', [], '--bad_flag'], ['daemon', [], 'daemon'],
] as const) {
  const refused = parseManagedCodexDaemonArguments(['app-server', '--listen', 'unix://', token, ...rest]);
  assert.equal(refused.valid, false);
  if (!refused.valid) {
    assert.ok(refused.detail.includes(`\`${named}\``));
    assert.equal(refused.detail.includes('/private/path'), false);
  }
}
console.log('PASS legacy, 0.162.1, reordered and future bare flags; values, positionals and alternate listeners refused with named flags');

// Exercise the macOS inspection branch, not just its parser, on any POSIX test host.
if (process.platform !== 'win32') {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-codex-mac-argv-'));
  const executable = realpathSync(process.execPath);
  const aliasDirectory = join(home, 'Symlinked Codex');
  mkdirSync(aliasDirectory);
  const symlinked = join(aliasDirectory, 'codex');
  symlinkSync(executable, symlinked);
  const receipt = join(home, 'app-server-daemon', 'app-server.pid');
  mkdirSync(join(home, 'app-server-daemon'));
  writeFileSync(receipt, JSON.stringify({ pid: 12345, processStartTime: 'fixture start' }), { mode: 0o600 });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const originalLiveProcess = HostProcessProvider.prototype.liveProcess;
  const originalSpawnSync = Bun.spawnSync;
  let comm = executable;
  let command = `${executable} ${modern.join(' ')}`;
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    HostProcessProvider.prototype.liveProcess = () => ({ state: 'running', identity: { pid: 12345, start: 'fixture start', boot: '', comm } });
    Bun.spawnSync = ((args: string[]) => {
      assert.equal(args[0], '/bin/ps');
      const field = args[2];
      const value = field === 'uid=' ? String(process.getuid!()) : field === 'lstart=' ? 'fixture start' : command;
      return { exitCode: 0, stdout: Buffer.from(value), stderr: Buffer.alloc(0) };
    }) as unknown as typeof Bun.spawnSync;
    const inspected = readCodexDaemonProcess(home, executable);
    assert.equal(inspected.state, 'running', JSON.stringify(inspected));
    if (inspected.state === 'running') assert.deepEqual(inspected.process.unknownFlags, ['--analytics-default-enabled']);
    comm = symlinked;
    command = `${symlinked} ${modern.join(' ')}`;
    const aliased = readCodexDaemonProcess(home, symlinked);
    assert.equal(aliased.state, 'running', JSON.stringify(aliased));
    if (aliased.state === 'running') {
      assert.equal(aliased.process.executable, executable, 'installation proof uses the resolved executable');
      assert.deepEqual(aliased.process.argv, [symlinked, ...modern], 'ps may preserve the unresolved comm path');
    }
    command = `${executable} ${modern.join(' ')}`;
    assert.equal(readCodexDaemonProcess(home, symlinked).state, 'running', 'resolved command path remains accepted with a symlinked comm');
    command = `${symlinked}-other ${modern.join(' ')}`;
    assert.equal(readCodexDaemonProcess(home, symlinked).state, 'unknown', 'comm prefix must end at a whitespace boundary');
    comm = executable;
    command = `${executable} app-server --listen unix:// --config x=y`;
    const refused = readCodexDaemonProcess(home, executable);
    assert.equal(refused.state, 'unknown');
    if (refused.state === 'unknown') assert.match(refused.detail, /--config/);
    command = `/private/other/codex ${modern.join(' ')}`;
    assert.equal(readCodexDaemonProcess(home, executable).state, 'unknown');
  } finally {
    Bun.spawnSync = originalSpawnSync;
    HostProcessProvider.prototype.liveProcess = originalLiveProcess;
    Object.defineProperty(process, 'platform', platform);
    rmSync(home, { recursive: true, force: true });
  }
  const spaced = '/fixture/Codex Install/bin/codex';
  assert.deepEqual(codexDaemonCommandArguments(`${spaced} ${modern.join(' ')}`, spaced)?.slice(1), modern);
  assert.equal(codexDaemonCommandArguments(`${spaced}-other ${modern.join(' ')}`, spaced), undefined);
  console.log('PASS macOS inspection verifies resolved and symlinked comm paths, including spaces and executable boundaries');
}

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
  await assert.rejects(restartCodexDaemonVerified(deps, { confirmed: true }), (error: Error) => {
    assert.match(error.message, /could not confirm it manages the Codex daemon: PID receipt/);
    assert.match(error.message, /While nothing is running/);
    assert.match(error.message, /codex app-server daemon restart/);
    return true;
  });
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
await import('./test-codex-daemon-receipts.ts');
