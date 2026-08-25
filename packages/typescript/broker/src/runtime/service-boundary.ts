import { applicationLaunchCommand, type ApplicationIdentity } from './application-identity.ts';

export const SERVICE_RESTART_EXIT_CODE = 75;

export type BrokerServiceProvider = 'foreground' | 'systemd' | 'launchd' | 'task-scheduler';

export interface BrokerServiceBoundary {
  provider: BrokerServiceProvider;
  managed: boolean;
  restartStrategy: 'self-spawn' | 'service-manager-exit';
}

/**
 * Packaged restart always re-enters the running APPLICATION, never an import.meta-relative source path.
 *
 * For the JavaScript distribution that means re-entering Bun plus the application bundle. Restarting a
 * `bun-js` build as `[process.execPath, 'broker']` would exec bare Bun with a `broker` argument — Bun would
 * look for a file called `broker`, fail, and the broker would simply never come back.
 */
export function brokerRelaunchCommand(options: {
  identity: Readonly<ApplicationIdentity>;
  argv: readonly string[];
}): string[] {
  if (options.identity.packaged) return applicationLaunchCommand(options.identity, ['broker']);
  // A contributor checkout re-enters exactly the argv it was started with, which preserves whatever dev
  // flags and entry module were in play; the identity is the fallback when argv is unavailable.
  if (options.argv.length > 0) return [...options.argv];
  return applicationLaunchCommand(options.identity);
}

/**
 * BPC1 process-owner boundary. Every durable provider sets the internal environment marker before broker
 * initialization, including the Windows bootstrap before it loads the active installation.
 */
export function detectBrokerServiceBoundary(
  environment: Readonly<{ COSYNCING_SERVICE_PROVIDER?: string }> = process.env as {
    COSYNCING_SERVICE_PROVIDER?: string;
  },
): BrokerServiceBoundary {
  const configured = environment.COSYNCING_SERVICE_PROVIDER?.trim().toLowerCase();
  if (configured === 'systemd' || configured === 'launchd' || configured === 'task-scheduler') {
    return { provider: configured, managed: true, restartStrategy: 'service-manager-exit' };
  }
  return { provider: 'foreground', managed: false, restartStrategy: 'self-spawn' };
}
