import type { AgentRuntimeUpdateStatus } from '@cosyncing/protocol';
import { PRODUCT_IDENTITY } from '@cosyncing/protocol';

const LOG_PREFIX = `[${PRODUCT_IDENTITY.productName}]`;

/**
 * Generic coordinator for freshness-class updates to long-lived agent runtimes.
 *
 * Governing decision: docs/protocol/adapter-support.md (Managed runtime freshness)
 * Freshness drift never earns a force-after-timeout path. Providers own the native safe gate;
 * callers may bypass it only through an explicitly-confirmed manual action.
 */

/**
 * Internal-only semantic input for occurrence identity. Symbol properties are
 * intentionally omitted from JSON, so this never expands the public status
 * protocol returned by the broker.
 */
export const RUNTIME_UPDATE_OCCURRENCE_FINGERPRINT = Symbol('runtime-update-occurrence-fingerprint');

export type RuntimeUpdateInspection = AgentRuntimeUpdateStatus & {
  [RUNTIME_UPDATE_OCCURRENCE_FINGERPRINT]?: string;
};

export interface RuntimeUpdateProvider {
  readonly agent: string;
  inspect(): Promise<RuntimeUpdateInspection>;
  restart(): Promise<void>;
}

export interface RuntimeUpdateCoordinatorOptions {
  /** Observes every status after it becomes the coordinator's stored snapshot. Listener failures are
   *  isolated so attention persistence can never break native freshness probing/restart. */
  onStatus?: (status: RuntimeUpdateInspection) => void | Promise<void>;
  /** Re-check the owning process lifecycle immediately before any restart. A signal may arrive while
   *  an asynchronous inspection is in flight, after its caller originally requested auto-restart. */
  restartAllowed?: () => boolean;
}

export class RuntimeUpdateCoordinator {
  private readonly providers = new Map<string, RuntimeUpdateProvider>();
  private readonly statuses = new Map<string, RuntimeUpdateInspection>();
  private readonly inFlight = new Map<string, Promise<RuntimeUpdateInspection>>();

  constructor(
    providers: RuntimeUpdateProvider[],
    private readonly options: RuntimeUpdateCoordinatorOptions = {},
  ) {
    for (const provider of providers) this.providers.set(provider.agent, provider);
  }

  list(): RuntimeUpdateInspection[] {
    return [...this.statuses.values()].sort((a, b) => a.agent.localeCompare(b.agent));
  }

  /** Return a complete checkedAt-fresh snapshot, or undefined when any provider needs a real probe. */
  listFresh(maxAgeMs: number, now = Date.now()): RuntimeUpdateInspection[] | undefined {
    if (this.statuses.size !== this.providers.size) return undefined;
    const statuses = this.list();
    return statuses.every((status) => Number.isFinite(status.checkedAt) && now - status.checkedAt <= maxAgeMs)
      ? statuses
      : undefined;
  }

  get(agent: string): RuntimeUpdateInspection | undefined {
    return this.statuses.get(agent);
  }

  async refresh(agent: string, opts: { autoRestart?: boolean } = {}): Promise<RuntimeUpdateInspection | undefined> {
    const provider = this.providers.get(agent);
    if (!provider) return undefined;
    const existing = this.inFlight.get(agent);
    if (existing) return existing;
    const operation = (async () => {
      let status = await provider.inspect();
      await this.storeStatus(status);
      if (
        opts.autoRestart &&
        status.updateAvailable &&
        status.autoRestartReady &&
        (this.options.restartAllowed?.() ?? true)
      ) {
        const changes = status.pendingChanges?.length
          ? status.pendingChanges.join(' + ')
          : `${status.runningVersion ?? 'unknown'} → ${status.installedVersion ?? 'newer'}`;
        console.log(`${LOG_PREFIX} ${status.displayName} ${status.runtimeKind || 'runtime'} change (${changes}); restarting at idle`);
        await provider.restart();
        status = await provider.inspect();
        await this.storeStatus(status);
      }
      return status;
    })();
    this.inFlight.set(agent, operation);
    try {
      return await operation;
    } finally {
      this.inFlight.delete(agent);
    }
  }

  async refreshAll(opts: { autoRestart?: boolean } = {}): Promise<RuntimeUpdateInspection[]> {
    await Promise.all([...this.providers.keys()].map((agent) => this.refresh(agent, opts)));
    return this.list();
  }

  async restartNow(agent: string): Promise<RuntimeUpdateInspection | undefined> {
    const provider = this.providers.get(agent);
    if (!provider) return undefined;
    const existing = this.inFlight.get(agent);
    if (existing) await existing;
    const current = this.statuses.get(agent);
    if (current && !current.updateAvailable) return current;
    if (!(this.options.restartAllowed?.() ?? true)) return current;
    await provider.restart();
    const refreshed = await this.refresh(agent, { autoRestart: false });
    if (refreshed?.updateAvailable) {
      throw new Error(`${refreshed.displayName} restart completed but the pending runtime change was not applied.`);
    }
    return refreshed;
  }

  private async storeStatus(status: RuntimeUpdateInspection): Promise<void> {
    this.statuses.set(status.agent, status);
    try {
      await this.options.onStatus?.(status);
    } catch (error) {
      console.warn(
        `${LOG_PREFIX} runtime update status listener failed for ${status.agent}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
