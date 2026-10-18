/**
 * Who may ask for what.
 *
 * The dangerous property here is not that a server update can fail; it is that a
 * request to update a server can quietly reach the desktop app installed on the
 * machine being reached. A phone, a laptop, and a browser tab all say "update
 * Workstation", and `localhost` or a matching version is not proof that the caller
 * and the desktop live on the same box -- WSL port forwarding is one ordinary way
 * they do not. So the scope is carried explicitly, and the one caller that predates
 * the flag keeps only the behaviour it had before.
 */
import { expect, test } from 'bun:test';
import type { BuildInfo } from '../runtime/build-info.ts';
import { brokerUpdateHandoffCommand } from './broker-update.ts';
import { runUpgrade, type UpgradeDependencies } from './release-upgrade.ts';
import { runCli } from '../cli/cli.ts';
import type { UpdateComponent } from '@cosyncing/protocol';

const BUILD = { version: '1.0.0', commit: 'aaaaaaa', target: 'linux-x64', distribution: 'bootstrap-js', packaged: true, dirty: false } as unknown as BuildInfo;

function writer(): { text: () => string; write: (chunk: string) => void } {
  let buffer = '';
  return { write: (chunk) => { buffer += chunk; }, text: () => buffer };
}

test('the remote handoff names the server scope instead of inheriting the desktop', () => {
  const argv = brokerUpdateHandoffCommand({
    buildInfo: BUILD,
    service: { managed: true, provider: 'systemd' } as never,
    executablePath: '/opt/cosyncing/bin/cosyncing',
    runtimePath: '/usr/local/bin/bun',
    stateHome: '/opt/cosyncing/state',
    systemdRunPath: '/usr/bin/systemd-run',
  });
  expect(argv).toBeDefined();
  expect(argv!.slice(-2)).toEqual(['--components', 'broker']);
  // The runtime still precedes the application: a transient unit carries no PATH, and
  // the scope flag must not have disturbed the exec shape the handoff depends on.
  expect(argv!.indexOf('/usr/local/bin/bun')).toBeLessThan(argv!.indexOf('/opt/cosyncing/bin/cosyncing'));
});

test('an unscoped upgrade still reconciles the desktop, so a person at a terminal sees no change', async () => {
  const seen: Array<{ components?: readonly string[] }> = [];
  const stderr = writer();
  const exitCode = await runCli(['upgrade', '--yes', '--json'], {
    buildInfo: BUILD,
    stdout: writer(),
    stderr,
    runUpgrade: async (options: { components?: readonly UpdateComponent[] }) => {
      seen.push({ ...(options.components ? { components: options.components } : {}) });
      return { exitCode: 0 };
    },
  } as never);
  expect(exitCode).toBe(0);
  expect(seen).toEqual([{}]);
});

test('the scope a caller names reaches the installer, and a made-up one is refused at the flag', async () => {
  const seen: Array<readonly string[] | undefined> = [];
  const passthrough = async (options: { components?: readonly string[] }) => {
    seen.push(options.components);
    return { exitCode: 0 };
  };
  const accepted = await runCli(['upgrade', '--yes', '--json', '--components', 'broker'], {
    buildInfo: BUILD, stdout: writer(), stderr: writer(), runUpgrade: passthrough,
  } as never);
  expect(accepted).toBe(0);
  expect(seen).toEqual([['broker']]);

  const stderr = writer();
  const refused = await runCli(['upgrade', '--yes', '--json', '--components', 'desktop'], {
    buildInfo: BUILD, stdout: writer(), stderr, runUpgrade: passthrough,
  } as never);
  expect(refused).toBe(2);
  expect(stderr.text()).toContain('--components accepts broker, client, or broker,client');
  expect(seen).toHaveLength(1);

  const both = await runCli(['upgrade', '--yes', '--json', '--components', 'client,broker'], {
    buildInfo: BUILD, stdout: writer(), stderr: writer(), runUpgrade: passthrough,
  } as never);
  expect(both).toBe(0);
  expect(seen[1]).toEqual(['client', 'broker']);
});

test('a client-only request is refused before the installer inspects anything', async () => {
  // runUpgrade is the broker installer. Honouring "just the client" by also swapping
  // the broker would restart a healthy server on a retry that meant to touch only the app.
  let acquired = false;
  const dependencies = {
    home: '/tmp/cosyncing-scope-refusal',
    buildInfo: BUILD,
    executablePath: '/opt/cosyncing/bin/cosyncing',
    components: ['client'],
    acquireLock: () => {
      acquired = true;
      throw new Error('must not be reached');
    },
  } as unknown as UpgradeDependencies;
  const result = await runUpgrade(dependencies);
  expect(result.status).toBe('blocked');
  expect(result.detailCode).toBe('upgrade-component-scope-unsupported');
  expect(result.exitCode).toBe(1);
  expect(acquired).toBe(false);
});

test('the handoff carries the pinned release, so a promoted channel cannot be silently adopted', () => {
  const base = {
    buildInfo: BUILD,
    service: { managed: true, provider: 'systemd' } as never,
    executablePath: '/opt/cosyncing/bin/cosyncing',
    runtimePath: '/usr/local/bin/bun',
    stateHome: '/opt/cosyncing/state',
    systemdRunPath: '/usr/bin/systemd-run',
  };
  const argv = brokerUpdateHandoffCommand({ ...base, pinnedReleaseId: 'rel-1.1.0+bbbbbbb' });
  expect(argv).toBeDefined();
  const pin = argv!.indexOf('--release');
  expect(argv!.slice(pin, pin + 2)).toEqual(['--release', 'rel-1.1.0+bbbbbbb']);
  // Still one command, in the order the transient unit execs it, with the scope intact.
  expect(argv!.indexOf('--components')).toBeLessThan(pin);
  expect(argv!.filter((entry) => entry === '--release')).toHaveLength(1);
  // No pin means the historical "install what the channel serves", unchanged.
  expect(brokerUpdateHandoffCommand(base)!.includes('--release')).toBe(false);
});

test('an identity that cannot be spelled as a pin is no handoff at all', () => {
  for (const pinnedReleaseId of ['latest', '--manifest=https://attacker.invalid/m', 'rel-1.1', 'x'.repeat(200)]) {
    const argv = brokerUpdateHandoffCommand({
      buildInfo: BUILD,
      service: { managed: true, provider: 'systemd' } as never,
      executablePath: '/opt/cosyncing/bin/cosyncing',
      stateHome: '/opt/cosyncing/state',
      systemdRunPath: '/usr/bin/systemd-run',
      pinnedReleaseId,
    });
    expect(argv).toBeUndefined();
  }
});

test('the pinned release reaches the installer, and an unspellable one is refused at the flag', async () => {
  const seen: Array<string | undefined> = [];
  const passthrough = async (options: { pinnedReleaseId?: string }) => {
    seen.push(options.pinnedReleaseId);
    return { exitCode: 0 };
  };
  const accepted = await runCli(['upgrade', '--yes', '--json', '--components', 'broker', '--release', 'rel-1.1.0+bbbbbbb'], {
    buildInfo: BUILD, stdout: writer(), stderr: writer(), runUpgrade: passthrough,
  } as never);
  expect(accepted).toBe(0);
  expect(seen).toEqual(['rel-1.1.0+bbbbbbb']);

  for (const value of ['', '--manifest=https://attacker.invalid/m', '../../etc/passwd']) {
    const stderr = writer();
    const refused = await runCli(['upgrade', '--yes', '--json', '--release', value], {
      buildInfo: BUILD, stdout: writer(), stderr, runUpgrade: passthrough,
    } as never);
    expect(refused).toBe(2);
    expect(stderr.text()).toContain('--release requires a release identity');
  }
  expect(seen).toHaveLength(1);
});
