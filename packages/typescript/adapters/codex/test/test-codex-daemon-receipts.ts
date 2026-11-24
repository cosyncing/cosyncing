import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spyOn } from 'bun:test';
import { HostProcessProvider } from '@cosyncing/adapter-api';
import { readCodexDaemonProcess, type CodexDaemonProcess, type CodexDaemonProcessRead, type CodexDaemonReceiptLayout } from '../src/daemon-process.ts';
import { restartCodexDaemonVerified } from '../src/daemon-restart.ts';

// Real scratch receipt/package files, with kernel process observations supplied by a fixture.
// Every refusal also exercises the restart boundary and proves no lifecycle action occurs.
// `captured()` receipts follow a real Linux Codex 0.165.0 receipt (pid, boot id and digests scrubbed):
// the legacy start text written at launch plus the native identity, read here after a host suspend
// had moved `ps -o lstart` by 36 minutes while the boot id and start ticks still matched.
// `CODEX_0171` follows a Codex 0.171.0 daemon.pid captured in an isolated CODEX_HOME (mode 0644, boot id
// and digests scrubbed); one minute after launch `ps -o lstart` already read 56 s later than its start text.
const CAPTURED_BOOT = '11111111-2222-4333-8444-555555555555';
const CAPTURED_TICKS = 36211;
const CODEX_0165 = { start: 'Sat Nov 21 23:33:57 2026', startTicks: CAPTURED_TICKS };
const CODEX_0171 = { start: 'Tue Nov 24 16:03:28 2026', startTicks: 22882029, release: '0.171.0-x86_64-unknown-linux-musl' };
// Its argv (from /proc/<pid>/cmdline) after `daemon start --enable shell_snapshot --disable apps`.
const CODEX_0171_OVERRIDES = ['features.apps=false', 'features.shell_snapshot=true'];
const CODEX_0171_ARGS = ['app-server', '--listen', 'unix://', '--analytics-default-enabled',
  ...CODEX_0171_OVERRIDES.flatMap((pair) => ['-c', pair]), '--managed-daemon'];
if (process.platform !== 'win32') {
  const cases: Record<string, (f: Fixture) => void> = {
    'legacy-layout': (f) => { f.layout = 'app-server.pid'; f.executable = f.cli; },
    'fresh-layout': () => {},
    'both-layouts': (f) => { f.extra = { pid: f.pid, processStartTime: '  fixture   start  ' }; },
    'previous-daemon-release': (f) => { f.executable = f.binary('app-server-daemon', '0.161.0-x86_64'); },
    'symlinked-home': (f) => { const alias = `${f.home}-alias`; fs.symlinkSync(f.home, alias); f.alias = alias; f.processHome = alias; },
    'wrong-package': (f) => { f.executable = f.binary('other-package'); f.refused = 'unknown'; },
    'wrong-package-home': (f) => { f.executable = f.binary('app-server-daemon', '0.162.1-x86_64', f.otherHome); f.refused = 'unknown'; },
    'wrong-cli-home': (f) => { f.cli = f.binary('standalone', '0.162.1-x86_64', f.otherHome); f.refused = 'unknown'; },
    'wrong-process-home': (f) => { f.processHome = f.otherHome; f.refused = 'unknown'; },
    'unrelated-executable': (f) => { f.executable = f.binary('app-server-daemon', '0.162.1-x86_64', f.home, 'other'); f.refused = 'unknown'; },
    'outside-bin': (f) => { f.executable = f.binary('app-server-daemon', '0.162.1-x86_64', f.home, 'codex', 'tools'); f.refused = 'unknown'; },
    'invalid-release': (f) => { f.executable = f.binary('app-server-daemon', 'untrusted'); f.refused = 'unknown'; },
    'package-symlink-escape': (f) => {
      const external = f.binary('app-server-daemon', '0.162.1-x86_64', f.otherHome);
      fs.rmSync(dirname(dirname(f.executable)), { recursive: true });
      fs.symlinkSync(dirname(dirname(external)), dirname(dirname(f.executable)));
      f.refused = 'unknown';
    },
    'stale-pid': (f) => { f.receiptPid++; f.refused = 'absent'; },
    // Without a native identity a changed start time may be a clock change or a reused PID.
    'stale-start': (f) => { f.receiptStart = 'old generation'; f.refused = 'unknown'; f.detail = /start time no longer matches process 12345/; },
    'identity-after-clock-change': (f) => { f.captured(); f.restarts = true; },
    'identity-earlier-field-name': (f) => { f.captured(); f.identityField = 'linuxProcessIdentity'; },
    'identity-other-start': (f) => { f.captured({ startTicks: CAPTURED_TICKS + 1 }); f.refused = 'absent'; },
    'identity-other-boot': (f) => { f.captured({ bootId: '66666666-7777-4888-8999-000000000000' }); f.refused = 'absent'; },
    'malformed-identity': (f) => { f.captured({ startTicks: String(CAPTURED_TICKS) }); f.refused = 'unknown'; },
    // A 0.171 daemon relaunched with its saved feature overrides; restart relaunches it with the same pairs.
    'codex-0171-feature-overrides': (f) => {
      f.captured({}, CODEX_0171);
      f.mode = 0o644;
      f.cli = f.binary('standalone', CODEX_0171.release);
      f.executable = f.binary('app-server-daemon', CODEX_0171.release);
      f.args = [...CODEX_0171_ARGS];
      f.featureOverrides = CODEX_0171_OVERRIDES;
      f.restarts = true;
    },
    'codex-0171-config-override': (f) => {
      f.captured({}, CODEX_0171);
      f.args = ['app-server', '--listen', 'unix://', '--analytics-default-enabled', '-c', 'model="o3"', '--managed-daemon'];
      f.refused = 'unknown';
      f.detail = /`-c` must be followed by a boolean feature override/;
    },
    'invalid-pid': (f) => { f.receiptPid = -1; f.refused = 'unknown'; },
    'unsafe-mode': (f) => { f.mode = 0o622; f.refused = 'unknown'; },
    'unsafe-owner': (f) => { f.receiptOwner++; f.refused = 'unknown'; },
    'unsafe-size': (f) => { f.padding = 'x'.repeat(4096); f.refused = 'unknown'; },
    'receipt-symlink': (f) => { f.linkReceipt = true; f.refused = 'unknown'; },
    'receipt-directory': (f) => { f.directoryReceipt = true; f.refused = 'unknown'; },
    'malformed-receipt': (f) => { f.receiptStart = ''; f.refused = 'unknown'; },
    'unreadable-receipt': (f) => { f.invalidJson = true; f.refused = 'unknown'; },
    'stale-legacy-pid-plus-live': (f) => { f.extra = { pid: f.pid + 1, processStartTime: f.receiptStart }; f.verifiedLayouts = [f.layout]; },
    'stale-fresh-pid-plus-live': (f) => { f.layout = 'app-server.pid'; f.extra = { pid: f.pid + 1, processStartTime: f.receiptStart }; f.verifiedLayouts = [f.layout]; },
    'stale-legacy-start-plus-live': (f) => { f.extra = { pid: f.pid, processStartTime: 'other start' }; f.verifiedLayouts = [f.layout]; },
    'stale-fresh-start-plus-live': (f) => { f.layout = 'app-server.pid'; f.extra = { pid: f.pid, processStartTime: 'other start' }; f.verifiedLayouts = [f.layout]; },
    'stale-reused-pid-plus-live': (f) => {
      f.addSecondProcess('replacement start', f.binary('unrelated-package'));
      f.extra!.processStartTime = 'old generation';
      f.verifiedLayouts = [f.layout];
    },
    'two-live-distinct-pids': (f) => { f.addSecondProcess(); f.refused = 'unknown'; },
    'two-live-distinct-starts': (f) => { f.addSecondProcess('second start'); f.refused = 'unknown'; },
    'two-stale-receipts': (f) => {
      f.captured();
      f.receiptPid++;
      f.extra = { pid: f.pid, processStartTime: f.receiptStart, processIdentity: { bootId: CAPTURED_BOOT, startTicks: CAPTURED_TICKS - 1 } };
      f.refused = 'absent';
      f.staleReceipts = ['app-server.pid', 'daemon.pid'];
    },
    'unverifiable-plus-stale-pid': (f) => { f.receiptPid++; f.extra = { pid: f.pid, processStartTime: 'old generation' }; f.refused = 'unknown'; },
    'unreadable-process-start': (f) => { f.unreadableStart = true; f.refused = 'unknown'; },
    'unsafe-second-receipt': (f) => { f.layout = 'app-server.pid'; f.extra = { pid: f.pid, processStartTime: f.receiptStart }; f.extraMode = 0o666; f.refused = 'unknown'; },
    'malformed-first-receipt': (f) => { f.extra = { pid: f.pid }; f.refused = 'unknown'; },
    'wrong-process-user': (f) => { f.processOwner++; f.refused = 'unknown'; },
    'changed-process-start': (f) => { f.changeStart = true; f.refused = 'unknown'; },
    'changed-boot': (f) => { f.changeBoot = true; f.refused = 'unknown'; },
    'unsafe-argv': (f) => { f.args.push('--config', 'x=y'); f.refused = 'unknown'; },
    'missing-receipts': (f) => { f.missing = true; f.refused = 'absent'; },
  };
  class Fixture {
    home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'cosyncing-codex-receipts-')));
    otherHome = join(this.home, 'other-home');
    pid = 12345;
    receiptPid = this.pid;
    receiptStart = 'fixture start';
    liveStart = 'fixture start';
    liveBoot = 'fixture boot';
    identity?: unknown;
    identityField = 'processIdentity';
    receiptOwner = process.getuid!();
    processOwner = process.getuid!();
    processHome = this.home;
    layout: CodexDaemonReceiptLayout = 'daemon.pid';
    cli = this.binary('standalone');
    executable = this.binary('app-server-daemon');
    args = ['app-server', '--listen', 'unix://', '--analytics-default-enabled', '--managed-daemon'];
    alias?: string;
    extra?: Record<string, unknown>;
    secondProcess?: { pid: number; start: string; executable: string };
    verifiedLayouts?: CodexDaemonReceiptLayout[];
    mode = 0o600;
    extraMode = 0o600;
    padding = '';
    linkReceipt = false;
    directoryReceipt = false;
    invalidJson = false;
    unreadableStart = false;
    changeStart = false;
    changeBoot = false;
    missing = false;
    refused?: 'absent' | 'unknown';
    detail?: RegExp;
    staleReceipts?: CodexDaemonReceiptLayout[];
    featureOverrides?: string[];
    restarts = false;
    /** The live process carries kernel start ticks; `ps -o lstart` (here the same value) no longer matches. */
    captured(identity: Record<string, unknown> = {}, generation: { start: string; startTicks: number } = CODEX_0165) {
      this.liveStart = String(generation.startTicks);
      this.liveBoot = CAPTURED_BOOT;
      this.receiptStart = generation.start;
      this.identity = { bootId: CAPTURED_BOOT, startTicks: generation.startTicks, ...identity };
    }
    addSecondProcess(start = 'fixture start', executable = this.executable) {
      this.secondProcess = { pid: this.pid + 1, start, executable };
      this.extra = { pid: this.secondProcess.pid, processStartTime: start };
    }
    binary(pkg: string, version = '0.162.1-x86_64', home = this.home, name = 'codex', bin = 'bin') {
      const path = join(home, 'packages', pkg, 'releases', version, bin, name);
      fs.mkdirSync(dirname(path), { recursive: true });
      fs.writeFileSync(path, '', { mode: 0o700 });
      return path;
    }
  }
  const selected = process.argv.includes('--case') ? process.argv[process.argv.indexOf('--case') + 1] : undefined;
  assert.ok(!selected || selected in cases, `Unknown receipt case: ${selected}`);
  for (const [name, prepare] of Object.entries(cases)) {
    if (selected && name !== selected) continue;
    const f = new Fixture();
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const originalRead = fs.readFileSync;
    const originalStat = fs.lstatSync;
    const originalRealpath = fs.realpathSync;
    const originalSpawn = Bun.spawnSync;
    const originalLive = HostProcessProvider.prototype.liveProcess;
    const spies: { mockRestore(): void }[] = [];
    try {
      prepare(f);
      const receipts = join(f.home, 'app-server-daemon');
      fs.mkdirSync(receipts);
      const receipt = join(receipts, f.layout);
      if (!f.missing) {
        const text = f.invalidJson ? '{' : JSON.stringify({
          pid: f.receiptPid, processStartTime: f.receiptStart,
          ...(f.identity === undefined ? {} : {
            [f.identityField]: f.identity,
            executableIdentity: { digest: Array(32).fill(0), path_digest: Array(32).fill(0) },
          }),
          padding: f.padding,
        });
        if (f.directoryReceipt) fs.mkdirSync(receipt);
        else if (f.linkReceipt) {
          const target = join(f.home, 'linked-receipt');
          fs.writeFileSync(target, text);
          fs.symlinkSync(target, receipt);
        } else { fs.writeFileSync(receipt, text, { mode: f.mode }); fs.chmodSync(receipt, f.mode); }
      }
      if (f.extra) {
        const extra = join(receipts, f.layout === 'daemon.pid' ? 'app-server.pid' : 'daemon.pid');
        fs.writeFileSync(extra, JSON.stringify(f.extra), { mode: f.extraMode });
        fs.chmodSync(extra, f.extraMode);
      }
      Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
      const liveProcesses = new Map([[f.pid, { start: f.liveStart, executable: f.executable }]]);
      if (f.secondProcess) liveProcesses.set(f.secondProcess.pid, f.secondProcess);
      const inspections = new Map<number, number>();
      HostProcessProvider.prototype.liveProcess = (pid) => {
        const native = liveProcesses.get(pid);
        if (!native) return { state: 'absent' };
        const count = (inspections.get(pid) ?? 0) + 1;
        inspections.set(pid, count);
        return { state: 'running', identity: {
          pid, start: count > 1 && f.changeStart ? 'new start' : native.start,
          boot: count > 1 && f.changeBoot ? 'new boot' : f.liveBoot, comm: native.executable,
        } };
      };
      spies.push(spyOn(fs, 'readFileSync').mockImplementation(((path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        const match = String(path).match(/^\/proc\/(\d+)\/(stat|cmdline|environ)$/);
        const native = match && liveProcesses.get(Number(match[1]));
        if (native && match![2] === 'stat') return `${match![1]} (codex) S 0`;
        if (native && match![2] === 'cmdline') return [native.executable, ...f.args].join('\0') + '\0';
        if (native && match![2] === 'environ') return `CODEX_HOME=${f.processHome}\0`;
        return (originalRead as Function)(path, ...rest);
      }) as typeof fs.readFileSync));
      spies.push(spyOn(fs, 'lstatSync').mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
        const match = String(path).match(/^\/proc\/(\d+)$/);
        if (match && liveProcesses.has(Number(match[1]))) return { uid: f.processOwner };
        const stat = (originalStat as Function)(path, ...rest);
        if (String(path) === receipt && f.receiptOwner !== process.getuid!()) stat.uid = f.receiptOwner;
        return stat;
      }) as typeof fs.lstatSync));
      spies.push(spyOn(fs, 'realpathSync').mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
        const match = String(path).match(/^\/proc\/(\d+)\/exe$/);
        const native = match && liveProcesses.get(Number(match[1]));
        return (originalRealpath as Function)(native ? native.executable : path, ...rest);
      }) as typeof fs.realpathSync));
      Bun.spawnSync = ((command: string[]) => ({
        exitCode: f.unreadableStart ? 1 : 0,
        stdout: Buffer.from(liveProcesses.get(Number(command.at(-1)))?.start ?? ''), stderr: Buffer.alloc(0),
      })) as unknown as typeof Bun.spawnSync;
      const read = readCodexDaemonProcess(f.alias ?? f.home, f.cli);
      assert.equal(read.state, f.refused ?? 'running', `${name}: ${JSON.stringify(read)}`);
      if (read.state === 'running') {
        const layouts = f.verifiedLayouts ?? (f.extra ? ['app-server.pid', 'daemon.pid'] : [f.layout]);
        assert.deepEqual(read.process.receiptLayouts, layouts, name);
        assert.equal(read.process.pid, f.pid, 'the live receipt selects the daemon');
        assert.equal(read.process.executable, originalRealpath(f.executable));
        assert.deepEqual(read.process.unknownFlags, ['--analytics-default-enabled']);
        assert.deepEqual(read.process.featureOverrides, f.featureOverrides, 'saved feature overrides are read from argv');
        if (f.restarts) await restartProceeds(read.process, f.featureOverrides);
      } else {
        if (name.startsWith('two-live-')) {
          assert.equal(read.state, 'unknown');
          if (read.state === 'unknown') assert.match(read.detail, /receipts app-server.pid and daemon.pid conflict/);
          for (const pid of liveProcesses.keys()) assert.equal(inspections.get(pid), 2, 'each conflicting process passes stable identity inspection');
        }
        if (read.state === 'unknown' && name.startsWith('malformed-')) assert.match(read.detail, /receipt .* is malformed/);
        if (read.state === 'unknown' && f.detail) assert.match(read.detail, f.detail);
        if (read.state === 'absent') {
          assert.deepEqual(read.staleReceipts, f.staleReceipts ?? (f.missing ? undefined : [f.layout]), 'stale receipts are named, never invented');
        }
        await refusesRestartWithoutMutation(read);
      }
      console.log(`PASS receipt ${name}`);
    } finally {
      for (const spy of spies.reverse()) spy.mockRestore();
      Bun.spawnSync = originalSpawn;
      HostProcessProvider.prototype.liveProcess = originalLive;
      Object.defineProperty(process, 'platform', platform);
      if (f.alias) fs.rmSync(f.alias);
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  }
}

/** A verified daemon is stopped by its captured identity and replaced with its saved feature overrides;
 * nothing else is signalled. */
async function restartProceeds(daemon: CodexDaemonProcess, featureOverrides: string[] = []) {
  const actions: string[] = [];
  let stopped = false;
  let started = false;
  await restartCodexDaemonVerified({
    captureProcess: () => stopped ? { state: 'absent' } : { state: 'running', process: daemon },
    readVersion: async () => !stopped
      ? { status: 'running', backend: 'pid', cliVersion: '0.171.0', appServerVersion: '0.165.0' }
      : started ? { status: 'running', backend: 'pid', cliVersion: '0.171.0', appServerVersion: '0.171.0' } : undefined,
    processState: (expected) => { assert.equal(expected, daemon); return stopped ? 'exited' : 'running'; },
    gracefulStop: (expected) => { assert.equal(expected, daemon); actions.push('graceful'); stopped = true; },
    forceStop: () => { actions.push('force'); },
    run: async (command, _timeoutMs, args = []) => {
      actions.push([command, ...args].join(' '));
      started = true;
      return { code: 0, stdout: '', stderr: '' };
    },
    now: () => 0, sleep: async () => {}, gracefulMs: 0, verifyMs: 0,
  });
  assert.deepEqual(actions, ['graceful', ['start', ...featureOverrides.flatMap((pair) => ['-c', pair])].join(' ')],
    'an automatic restart proceeds without force and relaunches the saved feature overrides');
}

async function refusesRestartWithoutMutation(read: CodexDaemonProcessRead) {
  const actions: string[] = [];
  await assert.rejects(restartCodexDaemonVerified({
    captureProcess: () => read,
    readVersion: async () => ({ status: 'running', backend: 'pid', cliVersion: '0.162.1', appServerVersion: '0.162.1' }),
    processState: () => 'running',
    gracefulStop: () => { actions.push('graceful'); },
    forceStop: () => { actions.push('force'); },
    run: async () => { actions.push('start'); return { code: 0, stdout: '', stderr: '' }; },
    now: () => 0, sleep: async () => {}, gracefulMs: 0, verifyMs: 0,
  }, { confirmed: true }), /could not confirm|without a verified/);
  assert.deepEqual(actions, [], 'unverified receipts never authorize a lifecycle action');
}
