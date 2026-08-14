import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type HealthModule = typeof import('../../src/runtime/broker-health.ts');

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const health = await import('../../src/runtime/broker-health.ts').catch((error: unknown) => {
  throw new Error(`broker health module must exist: ${String(error)}`);
}) as HealthModule;

const GiB = 1024 ** 3;

function disk(availableBytes: number, totalBytes = 100 * GiB) {
  return { availableBytes, totalBytes };
}

function testDiskThresholdsAndFilesystemIsolation(): void {
  let now = 1_800_000_000_000;
  const capacities = new Map<string, ReturnType<typeof disk>>([
    ['/state', disk(4 * GiB, 100 * GiB)],
    ['/cache', disk(50 * GiB, 100 * GiB)],
  ]);
  const monitor = new health.BrokerHealthMonitor({
    stateRoot: '/state',
    artifactRoot: '/cache',
    now: () => now,
    capacityProbe: (root) => capacities.get(root)!,
    canaryProbe: () => {},
  });

  monitor.sampleCapacity();
  assert(monitor.snapshot().status === 'healthy', 'one low-disk sample must not trigger a warning');
  now += 60_000;
  monitor.sampleCapacity();
  let snapshot = monitor.snapshot();
  assert(snapshot.status === 'degraded', 'two low-disk samples below both warning thresholds must degrade');
  assert(snapshot.components['state-filesystem'].status === 'degraded', 'state filesystem must degrade independently');
  assert(snapshot.components['artifact-filesystem'].status === 'healthy', 'artifact filesystem must remain independently healthy');

  capacities.set('/state', disk(900 * 1024 ** 2, 100 * GiB));
  monitor.sampleCapacity();
  snapshot = monitor.snapshot();
  assert(snapshot.status === 'critical', 'capacity below both critical thresholds must become critical immediately');

  capacities.set('/state', disk(13 * GiB, 100 * GiB));
  now += 29_000;
  monitor.sampleCapacity();
  now += 29_000;
  monitor.sampleCapacity();
  assert(monitor.snapshot().status === 'critical', 'recovery samples less than 30 seconds apart must not clear pressure');
  now += 1_000;
  monitor.sampleCapacity();
  assert(monitor.snapshot().status === 'healthy', 'two recovery samples at least 30 seconds apart above either margin must clear pressure');
}

function testPercentThresholdRequiresBothConditions(): void {
  let capacity = disk(4 * GiB, 20 * GiB); // 20% free: bytes low, percentage not low.
  const monitor = new health.BrokerHealthMonitor({
    stateRoot: '/state',
    artifactRoot: '/cache',
    capacityProbe: () => capacity,
    canaryProbe: () => {},
  });
  monitor.sampleCapacity();
  monitor.sampleCapacity();
  assert(monitor.snapshot().status === 'healthy', 'warning requires both byte and percentage thresholds');

  capacity = disk(4 * GiB, 100 * GiB);
  monitor.sampleCapacity();
  monitor.sampleCapacity();
  assert(monitor.snapshot().status === 'degraded', 'warning should trigger once both conditions hold twice');
}

function testWriteFailureHysteresisAndSanitization(): void {
  let now = 1_800_000_000_000;
  const monitor = new health.BrokerHealthMonitor({
    stateRoot: '/secret/state',
    artifactRoot: '/secret/cache',
    now: () => now,
    capacityProbe: () => disk(50 * GiB),
    canaryProbe: () => {},
  });

  monitor.recordStoreWrite('attention-store', false);
  let snapshot = monitor.snapshot();
  assert(snapshot.status === 'critical', 'real store write failure must become critical immediately');
  assert(snapshot.components['attention-store'].detailCodes.includes('write-failed'), 'failure must expose a stable detail code');
  assert(!JSON.stringify(snapshot).includes('/secret/'), 'health snapshots must not expose local paths');

  now += 1_000;
  monitor.recordStoreWrite('attention-store', true);
  now += 29_000;
  monitor.recordStoreWrite('attention-store', true);
  assert(monitor.snapshot().status === 'critical', 'successful writes less than 30 seconds apart must not recover');
  now += 1_000;
  monitor.recordStoreWrite('attention-store', true);
  snapshot = monitor.snapshot();
  assert(snapshot.status === 'healthy', 'two successful writes at least 30 seconds apart must recover');
}

function testStartupCorruptionIsDegradedUntilCleanRestart(): void {
  const monitor = new health.BrokerHealthMonitor({
    stateRoot: '/private/state',
    artifactRoot: '/private/cache',
    capacityProbe: () => disk(50 * GiB),
    canaryProbe: () => {},
  });
  monitor.recordStoreStartup('attention-store', false, 'startup-corrupt');
  let snapshot = monitor.snapshot();
  assert(snapshot.status === 'degraded', 'quarantined startup corruption must degrade broker health');
  assert(snapshot.components['attention-store'].status === 'degraded', 'only the affected store must degrade');
  assert(snapshot.components['attention-store'].detailCodes.length === 1
    && snapshot.components['attention-store'].detailCodes[0] === 'startup-corrupt',
  'authenticated diagnostics must expose only the stable startup code');
  assert(!JSON.stringify(snapshot).includes('/private/'), 'startup diagnostics must not expose paths');
  monitor.sampleCanaries();
  assert(monitor.snapshot().status === 'degraded', 'filesystem canaries must not erase a startup corruption episode');
  monitor.recordStoreStartup('attention-store', true);
  snapshot = monitor.snapshot();
  assert(snapshot.status === 'healthy', 'a later clean startup must recover the component');
}

function testCanaryFailuresAndDiagnostics(): void {
  let stateFails = true;
  let now = 1_800_000_000_000;
  const monitor = new health.BrokerHealthMonitor({
    stateRoot: '/state',
    artifactRoot: '/cache',
    now: () => now,
    capacityProbe: () => disk(50 * GiB),
    canaryProbe: (root) => {
      if (root === '/state' && stateFails) throw new Error('/private/path must stay hidden');
    },
    diagnosticsProbe: () => ({ eventLoopDelayMs: 42, rssBytes: 123, heapUsedBytes: 45 }),
  });

  monitor.sampleCanaries();
  let snapshot = monitor.snapshot();
  assert(snapshot.status === 'critical', 'canary write failure must be critical immediately');
  assert(snapshot.components['state-filesystem'].detailCodes.includes('canary-failed'), 'canary failure must use a stable code');
  assert(!JSON.stringify(snapshot).includes('private/path'), 'raw canary exceptions must not leak into the snapshot');

  monitor.sampleDiagnostics();
  snapshot = monitor.snapshot();
  assert(snapshot.status === 'critical', 'event-loop and memory diagnostics must not alter health severity');
  assert(snapshot.diagnostics.eventLoopDelayMs === 42, 'event-loop delay should be exposed diagnostically');

  stateFails = false;
  now += 1_000;
  monitor.sampleCanaries();
  now += 30_000;
  monitor.sampleCanaries();
  assert(monitor.snapshot().status === 'healthy', 'two separated successful canaries must clear canary failure');
}

function testSuccessfulCanariesRecoverStoreFailures(): void {
  let now = 1_800_000_000_000;
  const monitor = new health.BrokerHealthMonitor({
    stateRoot: '/state',
    artifactRoot: '/cache',
    now: () => now,
    capacityProbe: () => disk(50 * GiB),
    canaryProbe: () => {},
  });
  monitor.recordStoreWrite('artifact-store', false);
  now += 1_000;
  monitor.sampleCanaries();
  now += 30_000;
  monitor.sampleCanaries();
  assert(monitor.snapshot().components['artifact-store'].status === 'healthy', 'two separated successful canaries must recover a store write failure on the same filesystem');
}

function testAtomicCanaryCleansUp(): void {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-health-canary-'));
  try {
    health.runAtomicWriteCanary(root);
    assert(readdirSync(root).length === 0, 'successful canary must remove all probe files');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testObserverFailuresAreIsolated(): void {
  const monitor = new health.BrokerHealthMonitor({
    stateRoot: '/state',
    artifactRoot: '/cache',
    capacityProbe: () => disk(50 * GiB),
    canaryProbe: () => {},
    onChange: () => { throw new Error('attention integration failed'); },
  });
  monitor.sampleCapacity();
  assert(monitor.snapshot().status === 'healthy', 'observer exceptions must not change health sampling or escape to callers');
}

testDiskThresholdsAndFilesystemIsolation();
testPercentThresholdRequiresBothConditions();
testWriteFailureHysteresisAndSanitization();
testStartupCorruptionIsDegradedUntilCleanRestart();
testCanaryFailuresAndDiagnostics();
testSuccessfulCanariesRecoverStoreFailures();
testAtomicCanaryCleansUp();
testObserverFailuresAreIsolated();
console.log('PASS broker health thresholds, hysteresis, sanitization, and atomic canary');
