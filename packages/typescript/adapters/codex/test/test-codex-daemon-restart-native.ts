/** Opt-in native lifecycle acceptance. No broker, credentials, model turns, or normal Codex home.
 * bun run packages/typescript/adapters/codex/test/test-codex-daemon-restart-native.ts --old-bin <codex> --new-bin <codex>
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readCodexDaemonProcess, forceStopCodexDaemonProcess, codexDaemonProcessState } from '../src/daemon-process.ts';

const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1];
if (!process.argv.includes('--old-bin') || !process.argv.includes('--new-bin')) {
  throw new Error('Explicit --old-bin and --new-bin standalone executables are required.');
}
const oldBin = realpathSync(arg('--old-bin')!);
const newBin = realpathSync(arg('--new-bin')!);
const fixtureHome = mkdtempSync(join(tmpdir(), 'cosyncing-codex-native-restart-'));
const current = join(fixtureHome, 'packages', 'standalone', 'current');
mkdirSync(dirname(current), { recursive: true });
symlinkSync(dirname(dirname(oldBin)), current);
mkdirSync(join(fixtureHome, 'app-server-daemon'), { recursive: true });
writeFileSync(join(fixtureHome, 'app-server-daemon', 'settings.json'), '{"remoteControlEnabled":false}');
writeFileSync(join(fixtureHome, 'config.toml'), '[analytics]\nenabled = false\n');
const fixtureCli = join(current, 'bin', 'codex');
process.env.CODEX_HOME = fixtureHome;
process.env.COSYNCING_CODEX_BIN = fixtureCli;
delete process.env.COSYNCING_CODEX_APP_SERVER_SOCK;
process.env.COSYNCING_CODEX_DAEMON_RESTART_VERIFY_MS = '0';
const adapter = await import('../src/index.ts');
const command = async (name: 'start' | 'stop') => {
  const child = Bun.spawn([fixtureCli, 'app-server', 'daemon', name], {
    env: { ...process.env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    assert.equal(code, 0, `${name}: ${stdout} ${stderr}`);
  } finally { clearTimeout(timer); }
};
const results: Record<string, unknown>[] = [];
try {
  await command('start');
  const initial = readCodexDaemonProcess(fixtureHome, fixtureCli);
  assert.equal(initial.state, 'running', JSON.stringify(initial));
  if (initial.state !== 'running') throw new Error('Fixture daemon not identified');
  assert.equal((await adapter.queryCodexLoadedThreadIdsStrict()).size, 0);
  const receipt = join(fixtureHome, 'app-server-daemon', 'app-server.pid');
  const originalReceipt = readFileSync(receipt, 'utf8');
  try {
    writeFileSync(receipt, JSON.stringify({ ...JSON.parse(originalReceipt), processStartTime: 'different process generation' }));
    assert.equal(readCodexDaemonProcess(fixtureHome, fixtureCli).state, 'unknown');
    await assert.rejects(adapter.restartCodexDaemon({ confirmed: true }), /receipt|not managed/);
    assert.equal(codexDaemonProcessState(initial.process), 'running');
  } finally { writeFileSync(receipt, originalReceipt); }
  results.push({ case: 'stale PID receipt refuses mutation', status: 'pass' });
  console.log('PASS native stale PID receipt refuses restart without signalling the live fixture');
  // Freeze the *fixture* process so graceful shutdown cannot complete, then remove only its socket.
  assert.equal(initial.process.home, fixtureHome);
  process.kill(initial.process.pid, 'SIGSTOP');
  rmSync(join(fixtureHome, 'app-server-control', 'app-server-control.sock'));
  rmSync(current);
  symlinkSync(dirname(dirname(newBin)), current);
  const stranded = adapter.inspectCodexDaemonHealth();
  assert.equal(stranded.state, 'running', JSON.stringify(stranded));
  const startedAt = Date.now();
  await adapter.restartCodexDaemon({ confirmed: true });
  assert.equal(codexDaemonProcessState(initial.process), 'exited');
  const recovered = await adapter.readCodexDaemonVersion();
  assert.equal(recovered?.appServerVersion, recovered?.cliVersion);
  assert.equal(recovered?.status, 'running');
  assert.equal((await adapter.queryCodexLoadedThreadIdsStrict()).size, 0);
  results.push({ case: 'stalled previous-version process with missing socket', status: 'pass', before: stranded, after: recovered, elapsedMs: Date.now() - startedAt });
  console.log('PASS native suspended daemon with missing socket is recovered by the confirmed app restart implementation');

  const healthy = readCodexDaemonProcess(fixtureHome, fixtureCli);
  assert.equal(healthy.state, 'running');
  await adapter.restartCodexDaemon({ confirmed: true });
  if (healthy.state === 'running') assert.equal(codexDaemonProcessState(healthy.process), 'exited');
  assert.equal((await adapter.queryCodexLoadedThreadIdsStrict()).size, 0);
  results.push({ case: 'healthy same-version daemon restart', status: 'pass', after: await adapter.readCodexDaemonVersion() });
  console.log('PASS native healthy daemon restart replaces the actual process and restores the shared RPC endpoint');
} finally {
  // Cleanup is confined to the PID receipt and executable identity in the newly-created fixture home.
  const remaining = readCodexDaemonProcess(fixtureHome, fixtureCli);
  if (remaining.state === 'running') {
    assert.equal(remaining.process.home, fixtureHome);
    forceStopCodexDaemonProcess(remaining.process);
    const deadline = Date.now() + 5_000;
    while (codexDaemonProcessState(remaining.process) !== 'exited' && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.equal(codexDaemonProcessState(remaining.process), 'exited');
  }
  const output = resolve('output/review/codex-daemon-restart');
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'native-acceptance.json'), JSON.stringify({ results, fixtureHome, generatedAt: new Date().toISOString() }, null, 2) + '\n');
  rmSync(fixtureHome, { recursive: true, force: true });
}
