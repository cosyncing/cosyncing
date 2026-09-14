import assert from 'node:assert/strict';
import { RuntimeUpdateCoordinator, type RuntimeUpdateProvider, type RuntimeUpdateInspection } from '../../src/updates/runtime-update.ts';
import { createCodexRuntimeUpdateProvider } from '../../src/updates/runtime-update-providers.ts';

const status = (current = false): RuntimeUpdateInspection => ({
  agent: 'codex', displayName: 'Codex', managed: true,
  state: current ? 'current' : 'pending', updateAvailable: !current, autoRestartReady: false,
  installedVersion: '0.154.0', runningVersion: current ? '0.154.0' : '0.153.4', checkedAt: Date.now(),
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { resolve, promise };
};

{
  const started = deferred();
  const release = deferred();
  let restarts = 0;
  let current = false;
  let probesDuringRestart = 0;
  const provider: RuntimeUpdateProvider = {
    agent: 'codex',
    inspect: async () => { if (restarts && !current) probesDuringRestart++; return status(current); },
    restart: async (options) => {
      assert.equal(options?.confirmed, true);
      restarts++;
      started.resolve();
      await release.promise;
      current = true;
    },
  };
  const coordinator = new RuntimeUpdateCoordinator([provider]);
  const one = coordinator.restartNow('codex');
  await started.promise;
  const two = coordinator.restartNow('codex');
  const refresh = coordinator.refresh('codex', { autoRestart: true });
  release.resolve();
  const results = await Promise.all([one, two, refresh]);
  assert.equal(restarts, 1);
  assert.equal(probesDuringRestart, 0);
  assert(results.every((result) => result?.state === 'current'));
  console.log('PASS concurrent confirmed restarts and automatic refresh join one lifecycle operation');
}
{
  const provider: RuntimeUpdateProvider = {
    agent: 'codex', inspect: async () => status(), restart: async () => { throw new Error('shutdown stalled'); },
  };
  const coordinator = new RuntimeUpdateCoordinator([provider]);
  await assert.rejects(coordinator.restartNow('codex'), /shutdown stalled/);
  assert.equal(coordinator.get('codex')?.state, 'error');
  assert.equal(coordinator.get('codex')?.runningVersion, '0.153.4');
  assert.equal(coordinator.get('codex')?.autoRestartReady, false);
  provider.restart = async () => { provider.inspect = async () => status(true); };
  await coordinator.restartNow('codex');
  assert.equal(coordinator.get('codex')?.state, 'current');
  console.log('PASS failed restart preserves diagnostics and permits a subsequent recovery');
}
{
  let restarted = false;
  const provider: RuntimeUpdateProvider = {
    agent: 'codex', restart: async () => { restarted = true; },
    inspect: async () => restarted
      ? { ...status(), managed: false, state: 'unavailable', updateAvailable: false } : status(),
  };
  const coordinator = new RuntimeUpdateCoordinator([provider]);
  await assert.rejects(coordinator.restartNow('codex'), /failed verification/);
  assert.equal(coordinator.get('codex')?.state, 'error');
  console.log('PASS unavailable after restart is a failure even when updateAvailable becomes false');
}
{
  const started = deferred();
  const release = deferred();
  let restarts = 0;
  const provider: RuntimeUpdateProvider = {
    agent: 'codex', inspect: async () => ({ ...status(), autoRestartReady: true }),
    restart: async (options) => {
      restarts++;
      if (!options?.confirmed) { started.resolve(); await release.promise; throw new Error('graceful drain failed'); }
      provider.inspect = async () => status(true);
    },
  };
  const coordinator = new RuntimeUpdateCoordinator([provider]);
  const automatic = coordinator.refresh('codex', { autoRestart: true });
  const failed = assert.rejects(automatic, /graceful drain failed/);
  await started.promise;
  const manual = coordinator.restartNow('codex');
  release.resolve();
  await failed;
  assert.equal((await manual)?.state, 'current');
  assert.equal(restarts, 2);
  console.log('PASS confirmed recovery waits for and recovers a failed automatic restart');
}
{
  const provider = createCodexRuntimeUpdateProvider({
    readVersion: async () => undefined,
    readDaemonHealth: () => ({ state: 'running', installedVersion: '0.154.0', runningVersion: '0.153.4', detail: 'Daemon control endpoint is unavailable; use Restart.' }),
    loadedThreads: async () => { throw new Error('must not infer idle from missing control socket'); },
    policy: () => 'when-detached', restart: async () => {},
  });
  const result = await provider.inspect();
  assert.equal(result.state, 'error');
  assert.equal(result.managed, true);
  assert.equal(result.updateAvailable, true);
  assert.equal(result.autoRestartReady, false);
  assert.equal(result.installedVersion, '0.154.0');
  assert.equal(result.runningVersion, '0.153.4');
  console.log('PASS orphan runtime status preserves versions and offers confirmed recovery without auto-restart');
}
