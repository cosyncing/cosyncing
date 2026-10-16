/**
 * A zombie is not a running process. `liveProcess` reads one as absent on Linux (`/proc` state) and
 * through the `ps` path macOS uses (exercised here with the host's own `ps`), while a running
 * process keeps exactly the identity it had: pid, start token, boot id.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { HostProcessProvider } from '../src/host-process.ts';
import { startZombie, stopZombieParents } from './zombie-fixture.ts';

afterEach(stopZombieParents);

const boot = () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const startTicks = (pid: number) => {
  const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
};
const psStart = (pid: number) => Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)]).stdout.toString().trim();

describe.skipIf(process.platform !== 'linux')('HostProcessProvider.liveProcess and zombies', () => {
  test('a zombie reads as absent, through /proc and through ps', () => {
    const zombie = startZombie();
    expect(new HostProcessProvider().liveProcess(zombie.pid, { fresh: true })).toEqual({ state: 'absent' });
    expect(new HostProcessProvider({ platform: 'darwin' }).liveProcess(zombie.pid, { fresh: true })).toEqual({ state: 'absent' });
    zombie.reap();
    expect(new HostProcessProvider().liveProcess(zombie.pid, { fresh: true })).toEqual({ state: 'absent' });
  });

  test('the live parent of a zombie keeps its full identity', () => {
    const zombie = startZombie();
    const linux = new HostProcessProvider().liveProcess(zombie.parentPid, { fresh: true });
    expect(linux).toEqual({
      state: 'running',
      identity: { pid: zombie.parentPid, start: startTicks(zombie.parentPid)!, boot: boot(), comm: 'sleep' },
    });
    const posix = new HostProcessProvider({ platform: 'darwin' }).liveProcess(zombie.parentPid, { fresh: true });
    expect(posix).toEqual({
      state: 'running',
      identity: { pid: zombie.parentPid, start: psStart(zombie.parentPid), boot: '', comm: 'sleep' },
    });
  });
});
