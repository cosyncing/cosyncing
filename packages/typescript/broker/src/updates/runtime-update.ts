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

/**
 * Internal-only: what a restart acts on beyond the versions and the configuration occurrence, such
 * as the Codex daemon's PID receipts. A change re-arms paused automatic restarts. Never serialized.
 */
export const RUNTIME_UPDATE_RESTART_INPUT_FINGERPRINT = Symbol('runtime-update-restart-input-fingerprint');

export type RuntimeUpdateInspection = AgentRuntimeUpdateStatus & {
  [RUNTIME_UPDATE_OCCURRENCE_FINGERPRINT]?: string;
  [RUNTIME_UPDATE_RESTART_INPUT_FINGERPRINT]?: string;
};

/**
 * Identical consecutive automatic restart failures after which automatic restarts pause until the
 * restart input changes or a manual restart is requested. The first retries cover a one-off race
 * (a turn that starts during the graceful drain, a concurrent replacement); a third identical
 * refusal on unchanged versions, configuration and runtime receipts is deterministic, and each
 * further attempt only repeats the native probes and the failure log every poll.
 */
export const AUTO_RESTART_IDENTICAL_FAILURE_LIMIT = 3;

/** What an automatic restart would act on. Equal keys mean nothing an attempt depends on changed. */
function restartInputKey(status: RuntimeUpdateInspection): string {
  return JSON.stringify([
    [...(status.pendingChanges ?? [])].sort(),
    status.runningVersion ?? null,
    status.installedVersion ?? null,
    status[RUNTIME_UPDATE_OCCURRENCE_FINGERPRINT] ?? null,
    status[RUNTIME_UPDATE_RESTART_INPUT_FINGERPRINT] ?? null,
  ]);
}

function pausedAutoRestartDetail(detail: string): string {
  return `${detail} Automatic restart is paused after ${AUTO_RESTART_IDENTICAL_FAILURE_LIMIT} identical failures; it resumes when the runtime or its configuration changes. Use Restart to try again now.`;
}

export interface RuntimeUpdateProvider {
  readonly agent: string;
  inspect(): Promise<RuntimeUpdateInspection>;
  restart(options?: { confirmed?: boolean }): Promise<void>;
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
  private readonly manualRestarts = new Map<string, Promise<RuntimeUpdateInspection | undefined>>();
  /** Consecutive identical automatic restart failures per agent, keyed by the restart input. */
  private readonly autoRestartFailures = new Map<string, { input: string; detail: string; count: number }>();

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
    const manual = this.manualRestarts.get(agent);
    if (manual) return manual;
    const existing = this.inFlight.get(agent);
    if (existing) return existing;
    const operation = (async () => {
      let status = this.withAutoRestartPause(agent, await provider.inspect());
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
        const input = restartInputKey(status);
        try {
          await provider.restart();
          status = await provider.inspect();
          this.assertRestartApplied(status);
          this.autoRestartFailures.delete(agent);
          await this.storeStatus(status);
        } catch (error) {
          await this.storeRestartFailure(status, error, this.recordAutoRestartFailure(agent, input, error));
          throw error;
        }
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
    const manual = this.manualRestarts.get(agent);
    if (manual) return manual;
    const existing = this.inFlight.get(agent);
    const operation = (async () => {
      // A failed automatic attempt must not block the explicitly confirmed recovery that follows it.
      if (existing) await existing.catch(() => undefined);
      // A manual request also re-arms automatic restarts paused by repeated identical failures.
      this.autoRestartFailures.delete(agent);
      let status = await provider.inspect();
      await this.storeStatus(status);
      if (!(this.options.restartAllowed?.() ?? true)) return status;
      try {
        await provider.restart({ confirmed: true });
        status = await provider.inspect();
        this.assertRestartApplied(status);
        await this.storeStatus(status);
        return status;
      } catch (error) {
        await this.storeRestartFailure(status, error);
        throw error;
      }
    })();
    this.manualRestarts.set(agent, operation);
    try { return await operation; } finally {
      if (this.manualRestarts.get(agent) === operation) this.manualRestarts.delete(agent);
    }
  }

  private assertRestartApplied(status: RuntimeUpdateInspection): void {
    if (status.updateAvailable) throw new Error(`${status.displayName} restart completed but the pending runtime change was not applied.`);
    if (status.state !== 'current' || !status.managed) {
      throw new Error(`${status.displayName} restart failed verification: ${status.detail || status.state}.`);
    }
  }

  /**
   * Present a pending runtime whose automatic restart is paused as the error it keeps producing.
   * `current` proves nothing is left to apply, and a pending runtime with a different restart input
   * is a new attempt; both re-arm. An unreadable or unavailable runtime is no evidence either way.
   */
  private withAutoRestartPause(agent: string, status: RuntimeUpdateInspection): RuntimeUpdateInspection {
    const failures = this.autoRestartFailures.get(agent);
    if (!failures) return status;
    if (status.state === 'current' || (status.state === 'pending' && failures.input !== restartInputKey(status))) {
      this.autoRestartFailures.delete(agent);
      return status;
    }
    if (status.state !== 'pending' || failures.count < AUTO_RESTART_IDENTICAL_FAILURE_LIMIT) return status;
    return { ...status, state: 'error', autoRestartReady: false, detail: pausedAutoRestartDetail(failures.detail) };
  }

  /** Count an automatic failure; true once it is the limit-th identical one in a row. */
  private recordAutoRestartFailure(agent: string, input: string, error: unknown): boolean {
    const detail = error instanceof Error ? error.message : String(error);
    const prior = this.autoRestartFailures.get(agent);
    const count = prior && prior.input === input && prior.detail === detail ? prior.count + 1 : 1;
    this.autoRestartFailures.set(agent, { input, detail, count });
    return count >= AUTO_RESTART_IDENTICAL_FAILURE_LIMIT;
  }

  private async storeRestartFailure(status: RuntimeUpdateInspection, error: unknown, paused = false): Promise<void> {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`${LOG_PREFIX} ${status.displayName} runtime restart failed: ${detail}`);
    if (paused) {
      console.warn(`${LOG_PREFIX} ${status.displayName} automatic restart paused after ${AUTO_RESTART_IDENTICAL_FAILURE_LIMIT} identical failures`);
    }
    await this.storeStatus({
      ...status,
      state: 'error',
      autoRestartReady: false,
      detail: paused ? pausedAutoRestartDetail(detail) : detail,
      checkedAt: Date.now(),
    });
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
