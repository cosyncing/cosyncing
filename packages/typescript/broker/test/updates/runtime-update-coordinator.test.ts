/**
 * Interleavings of the runtime-update coordinator that no e2e can force on purpose.
 *
 * `e2e/broker/runtime-updates.test.ts` drives every restart path through a real broker
 * and real (fake) runtime processes. What it cannot do deterministically is land a second
 * request while a restart is mid-flight, or a shutdown signal between an inspection and
 * the restart it allowed. Those orderings are pinned here with deferred promises. So is a
 * run of identical automatic failures, which a broker under test only reaches after minutes of
 * polling: the pause it ends in is checked against the real attention policy and store.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttentionPolicy } from '../../src/attention/attention-policy.ts';
import { AttentionStore } from '../../src/attention/attention-store.ts';
import {
  AUTO_RESTART_IDENTICAL_FAILURE_LIMIT,
  RUNTIME_UPDATE_RESTART_INPUT_FINGERPRINT,
  RuntimeUpdateCoordinator,
  type RuntimeUpdateInspection,
  type RuntimeUpdateProvider,
} from '../../src/updates/runtime-update.ts';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

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

  test('identical automatic failures pause automatic restarts under one attention item until the restart input changes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cosyncing-runtime-pause-'));
    roots.push(home);
    const store = new AttentionStore({ home, now: () => 1_000_000 });
    const attention = new AttentionPolicy(store, { now: () => 1_000_000 });
    // The live refusal from a host whose daemon receipt could not be verified.
    const refusal = 'Codex is answering without a verified daemon PID receipt; this backend cannot be restarted safely.';
    let installed = '0.154.0';
    let receipt = 'receipt generation 1';
    let restarts = 0;
    const provider: RuntimeUpdateProvider = {
      agent: 'codex',
      inspect: async () => ({
        ...status(false, true),
        installedVersion: installed,
        [RUNTIME_UPDATE_RESTART_INPUT_FINGERPRINT]: receipt,
      }),
      restart: async () => {
        restarts += 1;
        throw new Error(refusal);
      },
    };
    const coordinator = new RuntimeUpdateCoordinator([provider], {
      onStatus: (next) => attention.reconcileRuntimeStatus(next),
    });
    const check = () => coordinator.refresh('codex', { autoRestart: true })
      .then(() => 'no attempt', (error: unknown) => String(error));
    const activeEvents = () => store.listActive().filter((event) => event.kind === 'runtime-update-ready');
    const failUntilPaused = async () => {
      const before = restarts;
      for (let attempt = 0; attempt < AUTO_RESTART_IDENTICAL_FAILURE_LIMIT; attempt += 1) {
        expect(await check()).toContain(refusal);
      }
      // Later checks still probe and report, but neither restart nor fail again.
      expect(await check()).toBe('no attempt');
      expect(await check()).toBe('no attempt');
      expect(restarts - before).toBe(AUTO_RESTART_IDENTICAL_FAILURE_LIMIT);
      expect(coordinator.get('codex')).toMatchObject({ state: 'error', managed: true, updateAvailable: true, autoRestartReady: false });
      expect(coordinator.get('codex')?.detail).toContain(refusal);
      expect(coordinator.get('codex')?.detail).toContain(`paused after ${AUTO_RESTART_IDENTICAL_FAILURE_LIMIT} identical failures`);
      expect(activeEvents()).toHaveLength(1);
    };

    await failUntilPaused();
    const event = activeEvents()[0]!;
    // A new daemon receipt is a new input.
    receipt = 'receipt generation 2';
    await failUntilPaused();
    // A manual request is attempted even while paused, and re-arms automatic restarts.
    await expect(coordinator.restartNow('codex')).rejects.toThrow(refusal);
    expect(restarts).toBe(2 * AUTO_RESTART_IDENTICAL_FAILURE_LIMIT + 1);
    await failUntilPaused();
    expect(activeEvents().map((active) => active.id)).toEqual([event.id]);
    // So is a newly installed version; it replaces the one update item with another.
    installed = '0.155.0';
    await failUntilPaused();
    expect(activeEvents()[0]!.id).not.toBe(event.id);
    expect(restarts).toBe(4 * AUTO_RESTART_IDENTICAL_FAILURE_LIMIT + 1);
  });

  test('automatic failures that differ keep being retried', async () => {
    let restarts = 0;
    const provider: RuntimeUpdateProvider = {
      agent: 'codex',
      inspect: async () => status(false, true),
      restart: async () => {
        restarts += 1;
        throw new Error(restarts % 2 ? 'graceful drain failed' : 'another daemon is running');
      },
    };
    const coordinator = new RuntimeUpdateCoordinator([provider]);
    for (let attempt = 0; attempt < 2 * AUTO_RESTART_IDENTICAL_FAILURE_LIMIT; attempt += 1) {
      await coordinator.refresh('codex', { autoRestart: true }).catch(() => undefined);
    }
    expect(restarts).toBe(2 * AUTO_RESTART_IDENTICAL_FAILURE_LIMIT);
    expect(coordinator.get('codex')?.detail).not.toContain('paused');
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
