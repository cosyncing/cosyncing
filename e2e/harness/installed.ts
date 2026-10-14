/**
 * A broker started the way an installation runs it: its credentials come from
 * owner-only files under its state home, never from the environment.
 *
 * Setup writes three things a running broker and the operator CLI read back:
 * `config.json` (port and machine label), `secrets/` (the owner token and the
 * Pi and omp integration credentials, each bound to the internal URL), and a
 * committed `install-state.json`. They are written here with the same product
 * functions setup uses, so the files are owner-only on every platform. The
 * port is part of that state, so it is leased first and the broker starts on
 * it.
 *
 *   const installed = await startInstalledBroker();
 *   afterAll(() => installed.stop());
 *   installed.owner.get('/api/sessions');
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reserveLoopbackFixturePort } from '../../packages/typescript/broker/test/helpers/isolated-broker-fixture.ts';
import {
  defaultBrokerConfig,
  writeBrokerConfig,
  type BrokerConfig,
} from '../../packages/typescript/broker/src/runtime/configuration.ts';
import { ensureInstallationCredentials } from '../../packages/typescript/broker/src/security/credentials.ts';
import {
  committedInstallState,
  writeInstallState,
} from '../../packages/typescript/broker/src/installation/install-state.ts';
import { type Broker, type FixturePaths, fixturePaths, startBroker } from './broker.ts';
import type { BrokerClient } from './client.ts';

export interface InstalledCredentials {
  brokerToken: string;
  piCredential: string;
  ompCredential: string;
}

export interface InstalledBrokerOptions {
  name?: string;
  machineLabel?: string;
  /** `config.json` feature switches (workspace browsing, transcript export, …). */
  features?: BrokerConfig['features'];
  /** Extra fields merged into `config.json`, e.g. additive fields a newer client wrote. */
  extraConfig?: Record<string, unknown>;
  /** Arrange more state after setup's files exist, before the broker starts. */
  setup?: (paths: FixturePaths, port: number) => void | Promise<void>;
  env?: Record<string, string>;
}

export interface InstalledBroker {
  broker: Broker;
  paths: FixturePaths;
  port: number;
  internalUrl: string;
  machineLabel: string;
  credentials: InstalledCredentials;
  /** A client holding the owner token. */
  owner: BrokerClient;
  stop(): Promise<void>;
}

/** Write what setup writes for a broker on `port`. Returns the minted credentials. */
export function writeInstalledState(
  home: string,
  port: number,
  options: Pick<InstalledBrokerOptions, 'machineLabel' | 'features' | 'extraConfig'> = {},
): InstalledCredentials {
  const internalUrl = `http://127.0.0.1:${port}`;
  const base = defaultBrokerConfig();
  writeBrokerConfig({
    ...base,
    ...(options.extraConfig ?? {}),
    broker: { ...base.broker, port, machineLabel: options.machineLabel ?? 'e2e-installed' },
    ...(options.features ? { features: options.features } : {}),
  } as BrokerConfig, home);
  const minted = ensureInstallationCredentials({ home, internalUrl });
  writeInstallState(committedInstallState(), home);
  return {
    brokerToken: minted.brokerToken,
    piCredential: minted.piIntegration.credential,
    ompCredential: minted.ompIntegration.credential,
  };
}

export async function startInstalledBroker(options: InstalledBrokerOptions = {}): Promise<InstalledBroker> {
  const root = mkdtempSync(join(tmpdir(), `cosyncing-e2e-${options.name ?? 'installed'}-`));
  const paths = fixturePaths(root);
  const lease = await reserveLoopbackFixturePort();
  const port = lease.port;
  const machineLabel = options.machineLabel ?? 'e2e-installed';
  let broker: Broker | undefined;
  try {
    const credentials = writeInstalledState(paths.cosyncingHome, port, { ...options, machineLabel });
    await options.setup?.(paths, port);
    await lease.release();
    broker = await startBroker({
      root,
      port,
      name: options.name,
      env: {
        // Nothing in these suites may relaunch the process under test.
        COSYNCING_RESTART_DRY_RUN: '1',
        ...(options.env ?? {}),
      },
    });
    const started = broker;
    return {
      broker: started,
      paths,
      port,
      internalUrl: `http://127.0.0.1:${port}`,
      machineLabel,
      credentials,
      owner: started.client({ kind: 'owner', token: credentials.brokerToken }),
      async stop() {
        await started.stop();
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await lease.release().catch(() => undefined);
    await broker?.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
