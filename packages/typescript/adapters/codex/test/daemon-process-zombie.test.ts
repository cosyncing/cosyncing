/**
 * A Codex daemon that has exited is not running, even while it is a zombie its parent has not reaped.
 *
 * Every process here is one this test starts: a `sleep` that never waits for the child that exits
 * under it, so the child stays a zombie until the test ends that parent and the system reaps it. The
 * daemon receipt that names the zombie lives in a scratch CODEX_HOME; the host's real Codex home,
 * daemon and processes are never read or signalled.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lstart, startZombie as zombie, stopZombieParents } from '../../../adapter-api/test/zombie-fixture.ts';
import { codexDaemonProcessState, readCodexDaemonProcess } from '../src/daemon-process.ts';

const homes: string[] = [];
afterEach(stopZombieParents);
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

/** A scratch CODEX_HOME whose daemon receipt names `pid` with its real start time. */
function receiptHome(pid: number): { home: string; cli: string } {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-codex-zombie-'));
  homes.push(home);
  mkdirSync(join(home, 'app-server-daemon'));
  const start = lstart(pid);
  if (!start) throw new Error(`no start time for ${pid}`);
  writeFileSync(join(home, 'app-server-daemon', 'daemon.pid'), JSON.stringify({ pid, processStartTime: start }), { mode: 0o600 });
  const cli = join(home, 'codex');
  writeFileSync(cli, '', { mode: 0o700 });
  return { home, cli };
}

describe.skipIf(process.platform !== 'linux')('a Codex daemon that is a zombie is not running', () => {
  test('a daemon receipt naming a zombie reads as no daemon', () => {
    const daemon = zombie();
    const { home, cli } = receiptHome(daemon.pid);
    expect(readCodexDaemonProcess(home, cli)).toEqual({ state: 'absent' });
  });

  test('a daemon reaped while its identity is being read has exited, not become unverifiable', () => {
    // The restart race: the receipt still names the daemon that just exited, and the reap lands
    // between reading it as live and reading its start time.
    const daemon = zombie();
    const { home, cli } = receiptHome(daemon.pid);
    const read = readCodexDaemonProcess(home, cli, {
      readStartTime: (pid) => {
        daemon.reap();
        return lstart(pid);
      },
    });
    expect(read).toEqual({ state: 'absent' });
  });

  test('a captured daemon that has become a zombie has exited', () => {
    const daemon = zombie();
    const { home, cli } = receiptHome(daemon.pid);
    // The identity captured while it ran: pid, kernel start ticks and boot id.
    const stat = readFileSync(`/proc/${daemon.pid}/stat`, 'utf8');
    const captured = {
      pid: daemon.pid,
      start: stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19]!,
      boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
      comm: 'sleep',
      executable: '/usr/bin/sleep',
      argv: ['sleep', 'app-server', '--listen', 'unix://'],
      home,
      cli,
    };
    expect(codexDaemonProcessState(captured)).toBe('exited');
  });
});
