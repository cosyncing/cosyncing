/**
 * A harness broker cannot outlive the test process that started it.
 *
 * A test process can die without running a single `afterAll`: a runner that times out, a person who
 * presses Ctrl-C twice, an agent that kills a hung `bun test`. Its brokers, and the hosts they
 * manage, then used to run on for days, reparented to init. The harness hands each broker a stdin
 * pipe it never writes, and the broker (source runs only) shuts down at end of file; its shutdown
 * stops the managed hosts it started.
 *
 * The test process here is a real one (`harness-leaks.probe.ts`), killed with SIGKILL, so nothing in
 * it gets to clean up. What it leaves is found the way `bun run check` finds a leak: every process
 * whose environment, argv or working directory points into the probe's harness root.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findHarnessProcesses,
  isHarnessRoot,
  reapHarnessProcesses,
} from '../../scripts/ci/lib/harness-leaks.ts';
import { eventually, REPO_ROOT, startBroker } from '../harness/index.ts';

const PROBE = join(import.meta.dir, 'harness-leaks.probe.ts');

describe.skipIf(process.platform === 'win32')('harness process lifetime', () => {
  const roots: string[] = [];

  test('a healthy unrelated listener is never adopted as the spawned broker', async () => {
    const stranger = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch: () => Response.json({ ok: true, unrelated: true }),
    });
    try {
      await expect(startBroker({ name: 'harness-port-owner', port: stranger.port! }))
        .rejects.toThrow(/broker exited with code 1 before becoming healthy/);
      const response = await fetch(`http://127.0.0.1:${stranger.port}/api/health`);
      expect(await response.json()).toEqual({ ok: true, unrelated: true });
    } finally {
      stranger.stop(true);
    }
  });
  afterAll(async () => {
    // Only what is provably under the probe's own root, whatever happened above.
    await reapHarnessProcesses(findHarnessProcesses(roots));
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  test('a test process killed with SIGKILL takes its broker and the host the broker manages with it', async () => {
    const probe = Bun.spawn([process.execPath, 'run', PROBE], {
      cwd: REPO_ROOT,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let stdout = '';
    const reader = probe.stdout.getReader();
    void (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        stdout += new TextDecoder().decode(value);
      }
    })();
    const stderr = new Response(probe.stderr).text();
    const started = await eventually(() => {
      if (probe.exitCode !== null) throw new Error(`the probe exited (${probe.exitCode}) before it was ready`);
      const line = stdout.split('\n').find((candidate) => candidate.startsWith('{'));
      return line ? JSON.parse(line) as { root: string; broker: number; serves: number[] } : undefined;
    }, { timeoutMs: 120_000, what: 'the probe to start its broker and managed host' }).catch(async (error) => {
      probe.kill('SIGKILL');
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${await stderr}`);
    });
    roots.push(started.root);

    const running = findHarnessProcesses([started.root]).map((entry) => entry.pid);
    expect(running).toContain(started.broker);
    expect(started.serves.length).toBeGreaterThan(0);
    for (const serve of started.serves) expect(running).toContain(serve);

    probe.kill('SIGKILL');
    await probe.exited;
    // The broker's own shutdown is bounded at 15 s once its stdin closes; a stuck one would still be here.
    const left = await eventually(
      () => {
        const remaining = findHarnessProcesses([started.root]);
        return remaining.length === 0 ? remaining : undefined;
      },
      { timeoutMs: 30_000, what: 'the killed test process\'s broker and managed host to exit' },
    ).catch(() => findHarnessProcesses([started.root]));
    expect(left.map((entry) => `${entry.pid} ${entry.command}`)).toEqual([]);
  });

  test('a ledger only ever names a harness root: a mkdtemp directory in the temp directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'cosyncing-e2e-ledger-'));
    roots.push(root);
    expect(isHarnessRoot(root)).toBe(true);
    for (const broad of [tmpdir(), join(tmpdir(), 'cosyncing-e2e-'), REPO_ROOT, join(root, 'home'), '/']) {
      expect({ broad, root: isHarnessRoot(broad) }).toEqual({ broad, root: false });
    }
  });
});
