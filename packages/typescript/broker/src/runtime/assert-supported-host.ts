import { windowsNativeMachineArchitecture } from '@cosyncing/adapter-api';
import { PRODUCT_IDENTITY } from '@cosyncing/protocol';
import { brokerHostVerdict } from '../installation/supported-hosts.ts';
import { exitFatalStartup } from './fatal-start.ts';

/**
 * Refuse an unqualified host BEFORE the runtime mutates anything.
 *
 * Called as the first statement of `startBrokerRuntime()`, which is where the runtime's first durable write
 * lives (`loadOrCreateBrokerInstance()`). Deliberately NOT an import-time side effect: importing this
 * module family performs no mutation by contract, and a check that ran on import would launch PowerShell —
 * and could terminate the process — in anything that merely imports the runtime, tests included.
 *
 * Setup and doctor already refuse through the same verdict, but neither is on the path of a broker started
 * directly — a service unit, a scheduled task, or an operator running the command — so a host we have not
 * qualified must not reach the first write by skipping the front door.
 *
 * On Windows this costs one bounded PowerShell call per broker start, which buys the only reliable answer
 * to "what machine is this": an x64 process emulated on ARM64 reports x64 for itself, so the process alone
 * cannot tell us. It runs once per process and only on Windows.
 */
export function assertSupportedBrokerHost(): void {
  const verdict = brokerHostVerdict({
    platform: process.platform,
    arch: process.arch,
    windowsMachineArchitecture: windowsNativeMachineArchitecture,
  });
  if (verdict.status === 'supported') return;
  exitFatalStartup(
    `[${PRODUCT_IDENTITY.productName}] broker refused this host (${verdict.code}): `
      + `${verdict.summary} ${verdict.remediation}`,
  );
}
