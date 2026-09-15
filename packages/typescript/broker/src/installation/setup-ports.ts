import type { SetupDiagnosisContext } from '@cosyncing/adapter-api';
import { PRODUCT_IDENTITY } from '@cosyncing/protocol';
import type { BrokerConfig } from '../runtime/configuration.ts';
import type { SetupInspection } from './setup.ts';

export function validSetupPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

/** Only suggest a port whose probe completed as closed; never treat a timeout as free. */
export async function nextAvailableSetupPort(context: SetupDiagnosisContext, current: number): Promise<number | undefined> {
  const start = Math.max(current + 1, 1024);
  for (let port = start; port < Math.min(start + 100, 65536); port += 1) {
    if (await context.probeTcp('127.0.0.1', port) === 'closed') return port;
  }
  return undefined;
}

export async function setupPortStatus(options: {
  context: SetupDiagnosisContext;
  config: BrokerConfig;
  installed: boolean;
  healthHeaders?: Readonly<Record<string, string>>;
}): Promise<SetupInspection['portStatus']> {
  const probe = await options.context.probeTcp('127.0.0.1', options.config.broker.port);
  if (probe === 'closed') return 'free';
  if (probe !== 'open') return 'unknown';
  const url = new URL('/api/health', options.config.broker.internalUrl).toString();
  // A probe that did not COMPLETE is not evidence about who owns the port, and
  // this verdict is the one that tells the operator to stop the process. The
  // default probe ceiling is 3s; measured on a busy host, this broker's own
  // /api/health answered correctly in 2.98s, so one timeout was enough to
  // report a healthy managed broker as "an unrecognized process" and recommend
  // killing it. Retry the incomplete case with a ceiling that is not a
  // stopwatch on a loaded machine.
  //
  // Only `unreachable` is retried. Anything that answers -- including a wrong
  // product, an HTTP error, or an unparseable body -- has settled the question
  // and a genuine foreign listener is still refused on the first attempt.
  for (const timeoutMs of [3_000, 10_000, 10_000]) {
    const health = await options.context.fetchJson(url, options.healthHeaders, timeoutMs);
    if (health.status === 'ok'
        && (health.json as any)?.ok === true
        && (health.json as any)?.product === PRODUCT_IDENTITY.productName) {
      // A cosyncing broker on the port with no committed receipt of our own is
      // a contributor build, which is still a conflict: setup owns no receipt
      // that would let it stop or replace that process.
      return options.installed ? 'owned-running' : 'unowned-broker';
    }
    if (health.status !== 'unreachable') return 'conflict';
  }
  return 'unknown';
}
