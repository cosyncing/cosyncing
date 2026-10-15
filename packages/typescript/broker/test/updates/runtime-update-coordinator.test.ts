/**
 * Interleavings of the runtime-update coordinator that no e2e can force on purpose.
 *
 * `e2e/broker/runtime-updates.test.ts` drives every restart path through a real broker
 * and real (fake) runtime processes. What it cannot do deterministically is land a second
 * request while a restart is mid-flight, or a shutdown signal between an inspection and
 * the restart it allowed. Those orderings are pinned here with deferred promises.
 */
import { describe, expect, test } from 'bun:test';
import {
  RuntimeUpdateCoordinator,
  type RuntimeUpdateInspection,
  type RuntimeUpdateProvider,
} from '../../src/updates/runtime-update.ts';

function status(current: boolean, autoRestartReady = false): RuntimeUpdateInspection {
  return {
    agent: 'codex',
    displayName: 'Codex',
    managed: true,
    state: current ? 'current' : 'pending',
    updateAvailable: !current,
    autoRestartReady: !current && autoRestartReady,
    installedVersion: '0.154.0',
    runningVersion: current ? '0.154.0' : '0.153.4',
    checkedAt: Date.now(),
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('runtime update coordinator', () => {
  test('concurrent confirmed restarts and an automatic check join one restart, and nothing probes mid-restart', async () => {
    const started = deferred();
    const release = deferred();
    let restarts = 0;
    let current = false;
    let probesDuringRestart = 0;
    const provider: RuntimeUpdateProvider = {
      agent: 'codex',
      inspect: async () => {
        if (restarts && !current) probesDuringRestart += 1;
        return status(current, true);
      },
      restart: async (options) => {
        expect(options?.confirmed).toBe(true);
        restarts += 1;
        started.resolve();
        await release.promise;
        current = true;
      },
    };
    const coordinator = new RuntimeUpdateCoordinator([provider]);
    const first = coordinator.restartNow('codex');
    await started.promise;
    const second = coordinator.restartNow('codex');
    const automatic = coordinator.refresh('codex', { autoRestart: true });
    release.resolve();
    const results = await Promise.all([first, second, automatic]);
    expect(restarts).toBe(1);
    expect(probesDuringRestart).toBe(0);
    expect(results.map((result) => result?.state)).toEqual(['current', 'current', 'current']);
  });

  test('a confirmed restart waits out a failing automatic one, then recovers', async () => {
    const started = deferred();
    const release = deferred();
    let restarts = 0;
    let current = false;
    const provider: RuntimeUpdateProvider = {
      agent: 'codex',
      inspect: async () => status(current, true),
      restart: async (options) => {
        restarts += 1;
        if (!options?.confirmed) {
          started.resolve();
          await release.promise;
          throw new Error('graceful drain failed');
        }
        current = true;
      },
    };
    const coordinator = new RuntimeUpdateCoordinator([provider]);
    // Settled by hand: Bun's `expect(promise).rejects` blocks until the promise settles.
    const automatic = coordinator.refresh('codex', { autoRestart: true }).then(
      () => new Error('the automatic restart was expected to fail'),
      (error: unknown) => error,
    );
    await started.promise;
    const manual = coordinator.restartNow('codex');
    release.resolve();
    expect(String(await automatic)).toContain('graceful drain failed');
    expect((await manual)?.state).toBe('current');
    expect(restarts).toBe(2);
  });

  test('a shutdown that begins between the inspection and the restart cancels the automatic restart', async () => {
    let restarts = 0;
    let allowed = true;
    const provider: RuntimeUpdateProvider = {
      agent: 'codex',
      inspect: async () => status(false, true),
      restart: async () => { restarts += 1; },
    };
    const coordinator = new RuntimeUpdateCoordinator([provider], {
      // The status is stored after the inspection and before the restart decision.
      onStatus: () => { allowed = false; },
      restartAllowed: () => allowed,
    });
    const result = await coordinator.refresh('codex', { autoRestart: true });
    expect(restarts).toBe(0);
    expect(result?.state).toBe('pending');
  });

  test('a failing status listener never stops a restart, and sees every status', async () => {
    let current = false;
    const observed: string[] = [];
    const provider: RuntimeUpdateProvider = {
      agent: 'codex',
      inspect: async () => status(current, true),
      restart: async () => { current = true; },
    };
    const coordinator = new RuntimeUpdateCoordinator([provider], {
      onStatus: (next) => {
        observed.push(next.state);
        if (next.state === 'pending') throw new Error('attention store unavailable');
      },
    });
    expect((await coordinator.refresh('codex', { autoRestart: true }))?.state).toBe('current');
    expect(observed).toEqual(['pending', 'current']);
  });

  test('a restart after which the change is still pending is a failure', async () => {
    const provider: RuntimeUpdateProvider = {
      agent: 'codex',
      inspect: async () => status(false),
      restart: async () => undefined,
    };
    const coordinator = new RuntimeUpdateCoordinator([provider]);
    await expect(coordinator.restartNow('codex')).rejects.toThrow('pending runtime change was not applied');
    expect(coordinator.get('codex')).toMatchObject({ state: 'error', autoRestartReady: false, runningVersion: '0.153.4' });
  });
});
