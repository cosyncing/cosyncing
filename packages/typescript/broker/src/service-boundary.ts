export const SERVICE_RESTART_EXIT_CODE = 75;

export type BrokerServiceProvider = 'foreground' | 'systemd' | 'launchd';

export interface BrokerServiceBoundary {
  provider: BrokerServiceProvider;
  managed: boolean;
  restartStrategy: 'self-spawn' | 'service-manager-exit';
}

/** Packaged restart always re-enters the running executable, never an import.meta-relative source path. */
export function brokerRelaunchCommand(options: {
  packaged: boolean;
  executablePath: string;
  argv: readonly string[];
  sourceEntry: string;
}): string[] {
  if (options.packaged) return [options.executablePath, 'broker'];
  if (options.argv.length > 0) return [...options.argv];
  return [options.executablePath, options.sourceEntry];
}

/**
 * BPC1 process-owner boundary. BPC6 supplies the systemd unit and later launchd
 * implementation; those providers set the internal environment marker.
 */
export function detectBrokerServiceBoundary(
  environment: Readonly<{ COSYNCING_SERVICE_PROVIDER?: string }> = process.env as {
    COSYNCING_SERVICE_PROVIDER?: string;
  },
): BrokerServiceBoundary {
  const configured = environment.COSYNCING_SERVICE_PROVIDER?.trim().toLowerCase();
  if (configured === 'systemd' || configured === 'launchd') {
    return { provider: configured, managed: true, restartStrategy: 'service-manager-exit' };
  }
  return { provider: 'foreground', managed: false, restartStrategy: 'self-spawn' };
}
