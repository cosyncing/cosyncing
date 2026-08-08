const BROWSER_GATE = 'web-browser';
const BROKER_GATE = 'broker-deterministic';

/** The package scripts the `web-browser` gate runs; both drive a real chromium. */
const BROWSER_GATE_SCRIPTS = ['test:web-startup-shell', 'test:web-startup-shell:built'];

/**
 * How long a gate's group may keep exiting after its command has returned,
 * before what is left counts as a stray.
 *
 * Observed on the analyze gates: three identical gates intermittently failed
 * with `strays` while their own output said `No issues found!`, and *which* of
 * the three failed changed from run to run. A quiet `flutter analyze --no-pub`
 * never reports strays, and neither does running the three concurrently on an
 * idle or even a fully loaded host — it only shows up inside a whole check. A
 * failure that moves between identical gates and needs the surrounding load is
 * a race on teardown, not three gates that each leak.
 *
 * Inferred, not directly observed: the survivor is the `dart` analysis-server
 * process the analyze client leaves shutting down behind it. The fix does not
 * depend on that being the right culprit — it only assumes the survivor is
 * already exiting, and a bounded re-poll cannot be fooled by one that is not.
 *
 * The `web-browser` gate fails the same way on a contended host: all 80 checks
 * pass, then chromium's helper processes outlive the gate's exit instant.
 *
 * Only these gates opt in, and only into a re-poll: anything wedged outlives
 * any window and is still reported and reaped. Every other gate keeps the
 * instant verdict.
 */
export const STRAY_GRACE_MS = 5_000;

/** Grace for the gates whose teardown is known to trail their command; 0 everywhere else. */
export function strayGraceMsFor(command: readonly string[]): number {
  const runsDartToolchain = command[0] === 'dart' || command[0] === 'flutter';
  if (runsDartToolchain && command.includes('analyze')) return STRAY_GRACE_MS;
  const runsBrowserGate = command[0] === 'bun' && command[1] === 'run'
    && BROWSER_GATE_SCRIPTS.includes(command[2] ?? '');
  return runsBrowserGate ? STRAY_GRACE_MS : 0;
}

/**
 * Fill one scheduling batch, rescanning earlier candidates after every pass.
 *
 * Launching a candidate may change which earlier candidates are admissible.
 * In particular, the browser appears before the broker in check launch order:
 * it first yields to the waiting heavyweight broker, then becomes admissible
 * as soon as that broker is running. A single forward scan misses that pair.
 */
export function fillSchedulingBatch<T>(
  launchOrder: readonly T[],
  hasCapacity: () => boolean,
  canLaunch: (candidate: T) => boolean,
  launch: (candidate: T) => void,
): T[] {
  const launched: T[] = [];
  const selected = new Set<T>();
  let launchedThisPass = true;
  while (hasCapacity() && launchedThisPass) {
    launchedThisPass = false;
    for (const candidate of launchOrder) {
      if (!hasCapacity()) break;
      if (selected.has(candidate) || !canLaunch(candidate)) continue;
      launch(candidate);
      selected.add(candidate);
      launched.push(candidate);
      launchedThisPass = true;
    }
  }
  return launched;
}

/** The sole gate-level overlap admitted by the complete-check scheduler. */
export function allowsBrowserBrokerOverlap(
  candidateId: string,
  runningGateIds: Iterable<string>,
  concurrency: number,
): boolean {
  if (concurrency < 2) return false;
  const running = [...runningGateIds];
  if (running.length !== 1) return false;
  const runningId = running[0];
  return (candidateId === BROWSER_GATE && runningId === BROKER_GATE)
    || (candidateId === BROKER_GATE && runningId === BROWSER_GATE);
}
