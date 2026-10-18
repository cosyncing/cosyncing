/**
 * The moment an in-app update becomes a process.
 *
 * `handoffBrokerUpdate` is the whole distance between "the surface said commit" and "there is a
 * transient unit that will replace this broker", and most of that distance is a network call the
 * handoff makes for itself: it re-reads the release channel to be sure the reviewed release is
 * still the one on offer. Authority is revocable, so a wait of that shape is where a grant the
 * owner has already withdrawn used to be forgotten -- every check the surface made was made
 * before the wait, and every check the handoff made was about the release rather than the caller.
 *
 * These run the real sequence with the channel held open on a promise and a spy where the spawn
 * would be, because the property worth pinning is not what the launcher returns but what it
 * declines to start.
 */
import { expect, test } from 'bun:test';
import type { BuildInfo } from '../runtime/build-info.ts';
import {
  handoffBrokerUpdate,
  type BrokerUpdateHandoffDependencies,
  type BrokerUpdateSnapshot,
} from './broker-update.ts';

const BUILD = {
  version: '1.0.0', commit: 'aaaaaaa', target: 'linux-x64', distribution: 'native', packaged: true, dirty: false,
} as unknown as BuildInfo;
const PINNED = 'rel-1.1.0+bbbbbbb';

function launcher(
  options: {
    launches: string[][];
    checker: (input: { refresh?: boolean }) => Promise<BrokerUpdateSnapshot>;
    authorizeLaunch?: BrokerUpdateHandoffDependencies['authorizeLaunch'];
  },
): BrokerUpdateHandoffDependencies {
  return {
    buildInfo: BUILD,
    service: { managed: true, provider: 'systemd' } as never,
    executablePath: '/opt/cosyncing/bin/cosyncing',
    runtimePath: '/usr/local/bin/bun',
    stateHome: '/opt/cosyncing/state',
    systemdRunPath: '/usr/bin/systemd-run',
    pinnedReleaseId: PINNED,
    ...(options.authorizeLaunch === undefined ? {} : { authorizeLaunch: options.authorizeLaunch }),
    run: async (argv) => {
      options.launches.push([...argv]);
      return { ok: true };
    },
    checker: { inspect: options.checker } as never,
  };
}

function channel(status: string, latestVersion?: string): BrokerUpdateSnapshot {
  return { status, ...(latestVersion === undefined ? {} : { latestVersion }) } as BrokerUpdateSnapshot;
}

test('the reviewed pin, not whatever the channel serves, is what reaches the transient unit', async () => {
  const launches: string[][] = [];
  const result = await handoffBrokerUpdate(launcher({
    launches,
    checker: async () => channel('update-available', '1.1.0'),
  }));
  expect(result).toEqual({ accepted: true, detailCode: 'broker-update-accepted' });
  expect(launches).toHaveLength(1);
  const argv = launches[0]!;
  expect(argv.slice(argv.indexOf('--release'), argv.indexOf('--release') + 2)).toEqual(['--release', PINNED]);
  // The scope flag still narrows the run to the server, and the pin is what the unit execs last.
  expect(argv.slice(argv.indexOf('--components'), argv.indexOf('--components') + 2)).toEqual(['--components', 'broker']);
  expect(argv.indexOf('--components')).toBeLessThan(argv.indexOf('--release'));
  expect(argv.at(-1)).toBe(PINNED);
});

test('a channel that moved on is refused, and nothing is scheduled', async () => {
  const launches: string[][] = [];
  const result = await handoffBrokerUpdate(launcher({
    launches,
    checker: async () => channel('update-available', '1.2.0'),
  }));
  expect(result).toEqual({ accepted: false, detailCode: 'release-target-moved' });
  expect(launches).toHaveLength(0);
});

/**
 * The race, held open long enough to see.
 *
 * The grant is withdrawn while the channel read is still in flight, which is after every question
 * the surface could have asked and before the unit exists. Asking at the spawn is the only place
 * left where the answer is still about to matter.
 */
test('a grant withdrawn during the handoff own channel read stops the launch', async () => {
  const launches: string[][] = [];
  let granted = true;
  let releaseCheck!: () => void;
  const held = new Promise<BrokerUpdateSnapshot>((resolve) => {
    releaseCheck = () => resolve(channel('update-available', '1.1.0'));
  });
  const handoff = handoffBrokerUpdate(launcher({
    launches,
    checker: () => held,
    authorizeLaunch: () => granted ? { allowed: true } : { allowed: false, detailCode: 'grant-revoked' },
  }));
  await Promise.resolve();
  granted = false;
  releaseCheck();
  expect(await handoff).toEqual({ accepted: false, detailCode: 'grant-revoked' });
  expect(launches).toHaveLength(0);
});

/** Authority held is authority used: asked once, at the spawn, and honoured. */
test('the question is asked at the spawn and only once', async () => {
  const launches: string[][] = [];
  const asks: number[] = [];
  const result = await handoffBrokerUpdate(launcher({
    launches,
    checker: async () => {
      // Nobody has been asked yet, which is the point: an answer collected before the launch is
      // an answer about an earlier moment.
      expect(asks).toHaveLength(0);
      return channel('update-available', '1.1.0');
    },
    authorizeLaunch: () => {
      asks.push(1);
      return { allowed: true };
    },
  }));
  expect(result.accepted).toBe(true);
  expect(asks).toHaveLength(1);
  expect(launches).toHaveLength(1);
});

/** A release identity the launcher cannot name is a refusal before any channel read at all. */
test('a pin that is not a release identity never reaches the channel', async () => {
  let readChannel = false;
  const dependencies = launcher({ launches: [], checker: async () => { readChannel = true; return channel('update-available', '1.1.0'); } });
  const result = await handoffBrokerUpdate({ ...dependencies, pinnedReleaseId: 'latest' });
  expect(result).toEqual({ accepted: false, detailCode: 'release-candidate-unreadable' });
  expect(readChannel).toBe(false);
});
