import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

export type BrokerHealthStatus = 'healthy' | 'degraded' | 'critical';
export type BrokerHealthStore = 'attention-store' | 'artifact-store';
export type BrokerHealthComponent = BrokerHealthStore | 'state-filesystem' | 'artifact-filesystem';

export interface DiskCapacity {
  availableBytes: number;
  totalBytes: number;
}

export interface BrokerHealthComponentSnapshot {
  status: BrokerHealthStatus;
  detailCodes: string[];
  checkedAt: number;
}

export interface BrokerHealthDiagnostics {
  eventLoopDelayMs?: number;
  rssBytes?: number;
  heapUsedBytes?: number;
  heapTotalBytes?: number;
  uptimeSeconds?: number;
}

export interface BrokerHealthSnapshot {
  status: BrokerHealthStatus;
  checkedAt: number;
  components: Record<BrokerHealthComponent, BrokerHealthComponentSnapshot>;
  diagnostics: BrokerHealthDiagnostics;
}

export interface BrokerHealthThresholds {
  warningAvailableBytes: number;
  warningAvailablePercent: number;
  criticalAvailableBytes: number;
  criticalAvailablePercent: number;
  recoveryAvailableBytes: number;
  recoveryAvailablePercent: number;
  warningSamples: number;
  recoverySamples: number;
  recoverySeparationMs: number;
}

export interface BrokerHealthMonitorOptions {
  stateRoot: string;
  artifactRoot: string;
  now?: () => number;
  capacityProbe?: (root: string) => DiskCapacity;
  canaryProbe?: (root: string) => void;
  diagnosticsProbe?: () => BrokerHealthDiagnostics;
  thresholds?: Partial<BrokerHealthThresholds>;
  onChange?: (snapshot: BrokerHealthSnapshot) => void;
}

const GiB = 1024 ** 3;
const DEFAULT_THRESHOLDS: BrokerHealthThresholds = {
  warningAvailableBytes: 5 * GiB,
  warningAvailablePercent: 10,
  criticalAvailableBytes: 1 * GiB,
  criticalAvailablePercent: 5,
  recoveryAvailableBytes: 6.25 * GiB,
  recoveryAvailablePercent: 12.5,
  warningSamples: 2,
  recoverySamples: 2,
  recoverySeparationMs: 30_000,
};

interface RecoverableFailure {
  failed: boolean;
  recoverySuccesses: number;
  firstRecoveryAt?: number;
}

interface CapacityState {
  status: BrokerHealthStatus;
  detailCode?: 'capacity-warning' | 'capacity-critical' | 'capacity-probe-failed';
  warningSamples: number;
  recoverySamples: number;
  firstRecoveryAt?: number;
}

interface FilesystemState {
  capacity: CapacityState;
  canary: RecoverableFailure;
  checkedAt: number;
}

interface StoreState {
  write: RecoverableFailure;
  startupDetailCode?: 'startup-corrupt';
  checkedAt: number;
}

function newFailure(): RecoverableFailure {
  return { failed: false, recoverySuccesses: 0 };
}

function newCapacity(): CapacityState {
  return { status: 'healthy', warningSamples: 0, recoverySamples: 0 };
}

function defaultCapacityProbe(root: string): DiskCapacity {
  const stats = statfsSync(root);
  return {
    availableBytes: Number(stats.bavail) * Number(stats.bsize),
    totalBytes: Number(stats.blocks) * Number(stats.bsize),
  };
}

/**
 * Proves a filesystem can create, fsync, atomically rename, read, verify, and delete a file.
 * Probe filenames contain no application data and both names are removed on every exit path.
 */
export function runAtomicWriteCanary(root: string): void {
  mkdirSync(root, { recursive: true });
  const suffix = `${process.pid}-${randomBytes(12).toString('hex')}`;
  const tempPath = join(root, `.cosyncing-health-${suffix}.tmp`);
  const committedPath = join(root, `.cosyncing-health-${suffix}.probe`);
  const nonce = randomBytes(32);
  let fd: number | undefined;
  let failure: unknown;
  try {
    fd = openSync(tempPath, 'wx', 0o600);
    writeSync(fd, nonce);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, committedPath);
    const observed = readFileSync(committedPath);
    if (!observed.equals(nonce)) throw new Error('broker health canary verification failed');
  } catch (error) {
    failure = error;
  } finally {
    if (fd != null) {
      try { closeSync(fd); } catch (error) { failure ??= error; }
    }
    try { rmSync(tempPath, { force: true }); } catch (error) { failure ??= error; }
    try { rmSync(committedPath, { force: true }); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
}

export class BrokerHealthMonitor {
  private readonly now: () => number;
  private readonly capacityProbe: (root: string) => DiskCapacity;
  private readonly canaryProbe: (root: string) => void;
  private readonly diagnosticsProbe: () => BrokerHealthDiagnostics;
  private readonly thresholds: BrokerHealthThresholds;
  private readonly filesystems: Record<'state-filesystem' | 'artifact-filesystem', FilesystemState>;
  private readonly stores: Record<BrokerHealthStore, StoreState>;
  private diagnostics: BrokerHealthDiagnostics = {};
  private checkedAt: number;
  private eventLoopHistogram?: ReturnType<typeof monitorEventLoopDelay>;

  constructor(private readonly options: BrokerHealthMonitorOptions) {
    this.now = options.now ?? Date.now;
    this.capacityProbe = options.capacityProbe ?? defaultCapacityProbe;
    this.canaryProbe = options.canaryProbe ?? runAtomicWriteCanary;
    this.diagnosticsProbe = options.diagnosticsProbe ?? (() => this.readDefaultDiagnostics());
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
    this.checkedAt = this.now();
    this.filesystems = {
      'state-filesystem': { capacity: newCapacity(), canary: newFailure(), checkedAt: this.checkedAt },
      'artifact-filesystem': { capacity: newCapacity(), canary: newFailure(), checkedAt: this.checkedAt },
    };
    this.stores = {
      'attention-store': { write: newFailure(), checkedAt: this.checkedAt },
      'artifact-store': { write: newFailure(), checkedAt: this.checkedAt },
    };
  }

  sampleCapacity(): BrokerHealthSnapshot {
    const at = this.now();
    this.sampleFilesystemCapacity('state-filesystem', this.options.stateRoot, at);
    this.sampleFilesystemCapacity('artifact-filesystem', this.options.artifactRoot, at);
    return this.finishSample(at);
  }

  sampleCanaries(): BrokerHealthSnapshot {
    const at = this.now();
    this.sampleFilesystemCanary('state-filesystem', this.options.stateRoot, at);
    this.sampleFilesystemCanary('artifact-filesystem', this.options.artifactRoot, at);
    return this.finishSample(at);
  }

  recordStoreWrite(store: BrokerHealthStore, ok: boolean): BrokerHealthSnapshot {
    const at = this.now();
    this.recordRecoverable(this.stores[store].write, ok, at);
    this.stores[store].checkedAt = at;
    return this.finishSample(at);
  }

  /** A quarantined corrupt snapshot is operational but degraded until the store commits a clean
   * replacement (or a later restart loads one). Filesystem canaries do not erase this signal. */
  recordStoreStartup(store: BrokerHealthStore, ok: boolean, detailCode: 'startup-corrupt' = 'startup-corrupt'): BrokerHealthSnapshot {
    const at = this.now();
    this.stores[store].startupDetailCode = ok ? undefined : detailCode;
    this.stores[store].checkedAt = at;
    return this.finishSample(at);
  }

  sampleDiagnostics(): BrokerHealthSnapshot {
    const at = this.now();
    try {
      this.diagnostics = { ...this.diagnosticsProbe() };
    } catch {
      this.diagnostics = {};
    }
    return this.finishSample(at);
  }

  /** Stops the lazily-created event-loop sampler. The monitor itself owns no scheduling timers. */
  dispose(): void {
    this.eventLoopHistogram?.disable();
    this.eventLoopHistogram = undefined;
  }

  snapshot(): BrokerHealthSnapshot {
    const components = {
      'state-filesystem': this.filesystemSnapshot(this.filesystems['state-filesystem']),
      'artifact-filesystem': this.filesystemSnapshot(this.filesystems['artifact-filesystem']),
      'attention-store': this.storeSnapshot(this.stores['attention-store']),
      'artifact-store': this.storeSnapshot(this.stores['artifact-store']),
    } satisfies Record<BrokerHealthComponent, BrokerHealthComponentSnapshot>;
    const statuses = Object.values(components).map((component) => component.status);
    const status: BrokerHealthStatus = statuses.includes('critical')
      ? 'critical'
      : statuses.includes('degraded') ? 'degraded' : 'healthy';
    return {
      status,
      checkedAt: this.checkedAt,
      components,
      diagnostics: { ...this.diagnostics },
    };
  }

  private sampleFilesystemCapacity(component: 'state-filesystem' | 'artifact-filesystem', root: string, at: number): void {
    const state = this.filesystems[component];
    try {
      const capacity = this.capacityProbe(root);
      this.recordCapacity(state.capacity, capacity, at);
    } catch {
      state.capacity.status = 'critical';
      state.capacity.detailCode = 'capacity-probe-failed';
      state.capacity.warningSamples = 0;
      state.capacity.recoverySamples = 0;
      state.capacity.firstRecoveryAt = undefined;
    }
    state.checkedAt = at;
  }

  private readDefaultDiagnostics(): BrokerHealthDiagnostics {
    if (!this.eventLoopHistogram) {
      this.eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
      this.eventLoopHistogram.enable();
    }
    const usage = process.memoryUsage();
    const eventLoopDelayMs = Number(this.eventLoopHistogram.max) / 1_000_000;
    this.eventLoopHistogram.reset();
    return {
      eventLoopDelayMs: Number.isFinite(eventLoopDelayMs) ? eventLoopDelayMs : 0,
      rssBytes: usage.rss,
      heapUsedBytes: usage.heapUsed,
      heapTotalBytes: usage.heapTotal,
      uptimeSeconds: process.uptime(),
    };
  }

  private sampleFilesystemCanary(component: 'state-filesystem' | 'artifact-filesystem', root: string, at: number): void {
    const state = this.filesystems[component];
    let ok = true;
    try {
      this.canaryProbe(root);
    } catch {
      ok = false;
    }
    this.recordRecoverable(state.canary, ok, at);
    // A successful filesystem canary is also a proven write on the corresponding store's mount.
    // It may recover a prior real-store write failure; a failed canary is represented independently.
    if (ok) {
      const store = component === 'state-filesystem' ? 'attention-store' : 'artifact-store';
      this.recordRecoverable(this.stores[store].write, true, at);
      this.stores[store].checkedAt = at;
    }
    state.checkedAt = at;
  }

  private recordCapacity(state: CapacityState, capacity: DiskCapacity, at: number): void {
    const availablePercent = capacity.totalBytes > 0 ? capacity.availableBytes / capacity.totalBytes * 100 : 0;
    const critical = capacity.availableBytes < this.thresholds.criticalAvailableBytes
      && availablePercent < this.thresholds.criticalAvailablePercent;
    const warning = capacity.availableBytes < this.thresholds.warningAvailableBytes
      && availablePercent < this.thresholds.warningAvailablePercent;
    const recovered = capacity.availableBytes >= this.thresholds.recoveryAvailableBytes
      || availablePercent >= this.thresholds.recoveryAvailablePercent;

    if (critical) {
      state.status = 'critical';
      state.detailCode = 'capacity-critical';
      state.warningSamples = 0;
      state.recoverySamples = 0;
      state.firstRecoveryAt = undefined;
      return;
    }
    if (state.status !== 'healthy') {
      if (recovered) {
        this.recordCapacityRecovery(state, at);
      } else {
        state.recoverySamples = 0;
        state.firstRecoveryAt = undefined;
      }
      return;
    }
    if (warning) {
      state.warningSamples++;
      if (state.warningSamples >= this.thresholds.warningSamples) {
        state.status = 'degraded';
        state.detailCode = 'capacity-warning';
        state.recoverySamples = 0;
        state.firstRecoveryAt = undefined;
      }
    } else {
      state.warningSamples = 0;
      state.detailCode = undefined;
    }
  }

  private recordCapacityRecovery(state: CapacityState, at: number): void {
    if (state.recoverySamples === 0) {
      state.recoverySamples = 1;
      state.firstRecoveryAt = at;
      return;
    }
    const separated = state.firstRecoveryAt != null
      && at - state.firstRecoveryAt >= this.thresholds.recoverySeparationMs;
    if (separated) state.recoverySamples++;
    if (state.recoverySamples >= this.thresholds.recoverySamples) {
      state.status = 'healthy';
      state.detailCode = undefined;
      state.warningSamples = 0;
      state.recoverySamples = 0;
      state.firstRecoveryAt = undefined;
    }
  }

  private recordRecoverable(state: RecoverableFailure, ok: boolean, at: number): void {
    if (!ok) {
      state.failed = true;
      state.recoverySuccesses = 0;
      state.firstRecoveryAt = undefined;
      return;
    }
    if (!state.failed) return;
    if (state.recoverySuccesses === 0) {
      state.recoverySuccesses = 1;
      state.firstRecoveryAt = at;
      return;
    }
    const separated = state.firstRecoveryAt != null
      && at - state.firstRecoveryAt >= this.thresholds.recoverySeparationMs;
    if (separated) state.recoverySuccesses++;
    if (state.recoverySuccesses >= this.thresholds.recoverySamples) {
      state.failed = false;
      state.recoverySuccesses = 0;
      state.firstRecoveryAt = undefined;
    }
  }

  private filesystemSnapshot(state: FilesystemState): BrokerHealthComponentSnapshot {
    const critical = state.capacity.status === 'critical' || state.canary.failed;
    const status: BrokerHealthStatus = critical ? 'critical' : state.capacity.status;
    const detailCodes: string[] = [];
    if (state.capacity.detailCode) detailCodes.push(state.capacity.detailCode);
    if (state.canary.failed) detailCodes.push('canary-failed');
    return { status, detailCodes, checkedAt: state.checkedAt };
  }

  private storeSnapshot(state: StoreState): BrokerHealthComponentSnapshot {
    const detailCodes: string[] = [];
    if (state.write.failed) detailCodes.push('write-failed');
    if (state.startupDetailCode) detailCodes.push(state.startupDetailCode);
    return {
      status: state.write.failed ? 'critical' : state.startupDetailCode ? 'degraded' : 'healthy',
      detailCodes,
      checkedAt: state.checkedAt,
    };
  }

  private finishSample(at: number): BrokerHealthSnapshot {
    this.checkedAt = at;
    const snapshot = this.snapshot();
    try {
      this.options.onChange?.(snapshot);
    } catch {
      // Health observation is advisory and must not throw into stores or session fan-out.
    }
    return snapshot;
  }
}
