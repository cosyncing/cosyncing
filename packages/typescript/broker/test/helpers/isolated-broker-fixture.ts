import { copyFileSync, mkdirSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

const SAFE_HOST_ENVIRONMENT_KEYS = new Set([
  'CI',
  'COLORTERM',
  'FORCE_COLOR',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'NO_COLOR',
  'PATH',
  'SHELL',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'TZ',
]);

/**
 * Where a fixture's adapter endpoints point when nothing sets them.
 *
 * Port 1 on loopback: nothing binds it, and a connection is refused
 * immediately rather than hanging, so an accidental reach fails fast and
 * loudly instead of quietly succeeding against a real service.
 */
const UNROUTABLE_FIXTURE_ORIGIN = 'http://127.0.0.1:1';

export interface IsolatedFixtureEnvironmentOptions {
  source?: NodeJS.ProcessEnv;
  overrides?: NodeJS.ProcessEnv;
}

/**
 * Construct a broker-child environment that cannot see host credentials or
 * persistent agent/broker state. Explicit test fixtures are applied last.
 */
export function isolatedBrokerFixtureEnvironment(
  fixtureRoot: string,
  options: IsolatedFixtureEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const root = resolve(fixtureRoot);
  const source = options.source ?? process.env;
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_HOST_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }

  const owned = {
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_STATE_HOME: join(root, 'xdg-state'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    PI_CODING_AGENT_DIR: join(root, 'pi-agent'),
    PI_CODING_AGENT_SESSION_DIR: join(root, 'pi-sessions'),
    // Pi's native variables are also understood by omp. Keep the two adapters disjoint by
    // default; a collision test must opt back into the shared variables explicitly.
    COSYNCING_OMP_AGENT_DIR: join(root, 'omp-agent'),
    COSYNCING_OMP_SESSIONS_ROOT: join(root, 'omp-sessions'),
    COSYNCING_HOME: join(root, 'cosyncing-home'),
  };
  for (const directory of Object.values(owned)) {
    mkdirSync(directory, { recursive: true });
  }
  // Scrubbing the environment is not enough for the endpoints whose DEFAULT is
  // a live host location. Removing `OPENCODE_URL` does not isolate a fixture —
  // it hands it the default, `127.0.0.1:4096`, which is where the developer's
  // own `opencode serve` listens. A fixture broker then discovers, publishes
  // and serves that person's real sessions: observed once as 246 private
  // sessions in a fixture's `/api/sessions`. The same shape applies to the
  // Tokdash sidecar's default port. Both are pinned at an address nothing can
  // be listening on, so an unset variable fails closed instead of open.
  const owned_endpoints = {
    OPENCODE_URL: UNROUTABLE_FIXTURE_ORIGIN,
    COSYNCING_TOKDASH_URL: UNROUTABLE_FIXTURE_ORIGIN,
    // Same shape, same reason: the DeepSeek Harness base URL defaults to
    // `127.0.0.1:3080`, which is exactly where a maintainer's own `dsh web`
    // host listens. A fixture that merely omits the variable would reach that
    // real host — discovering, attaching to, and (through Drive) able to write
    // to the person's live sessions. Pinned unroutable so unset fails closed.
    COSYNCING_DSH_BASE_URL: UNROUTABLE_FIXTURE_ORIGIN,
    // A fixture must never adopt or spawn a serve either: adoption is the same
    // leak by another route, and spawning leaves a process behind.
    COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
    // Managed EXTERNAL hosts, pinned off BY NAME rather than left to default.
    //
    // The scrub is an allowlist, so these cannot arrive by inheritance today,
    // and the lifecycle engine is default-off regardless. Both of those are
    // properties of code that can change; this line states what a fixture must
    // never do, where a reader looks for it. The failure it forecloses is worse
    // than the OPENCODE_URL leak above: reading a developer's live host is bad,
    // and STARTING one — a real `kimi web` or `dsh web` left running on their
    // machine by a test — is worse.
    COSYNCING_KIMI_MANAGED_HOST: '0',
    COSYNCING_DSH_MANAGED_HOST: '0',
  };
  return {
    ...environment,
    ...owned,
    ...owned_endpoints,
    USER: 'cosyncing-fixture',
    LOGNAME: 'cosyncing-fixture',
    // Last, so a suite that genuinely needs one of these — a real serve, a
    // stubbed sidecar — still says so explicitly and visibly at its call site.
    ...options.overrides,
  };
}

let freshImportSequence = 0;

/**
 * Materialize a unique copy before importing executable fixture source.
 * A query string alone is insufficient after Bun loaded the same `.ts` path
 * with `{ type: 'text' }`: the loader can retain the text module kind by path.
 */
export function freshModuleSpecifier(
  path: string,
  fixtureRoot: string,
): string {
  freshImportSequence += 1;
  const modules = join(resolve(fixtureRoot), 'fresh-modules');
  mkdirSync(modules, { recursive: true });
  const copy = join(
    modules,
    `fixture-${process.pid}-${freshImportSequence}.ts`,
  );
  copyFileSync(resolve(path), copy);
  return pathToFileURL(copy).href;
}

/**
 * Drain a spawned child's piped output, keeping a bounded tail.
 *
 * A pipe holds about 64 KB, and a child whose output nobody reads blocks on
 * the write that fills it. For a broker that happens during startup, so the
 * symptom is a readiness wait that expires against a process which is neither
 * serving nor dead — indistinguishable from a slow host, and unaffected by
 * raising the budget. Nine fixtures piped the broker's output and never read a
 * byte of it.
 *
 * The tail is retained because a readiness failure that quotes nothing from
 * the process that failed to start is not a diagnosis. Pass
 * `maxChars: Infinity` when the assertion is about the whole output rather
 * than the last thing that happened — a suite checking that a credential never
 * appears in a log has to see all of it.
 *
 * `read()` is a snapshot, so an assertion about the COMPLETE output must
 * `await done` first. A child's exit does not mean its pipes have been drained:
 * the readers are separate async tasks, and the last chunk can still be in
 * flight when `child.exited` resolves. Reading through that race would let
 * "this credential appears nowhere" pass without having seen the end of the
 * log, which is the one place a shutdown path would print it.
 */
export interface ProcessOutputCapture {
  /** What has been read so far. Fine for diagnostics; racy for completeness. */
  read(): string;
  /** Resolves when both streams have reached EOF and been flushed. */
  done: Promise<void>;
}

export function captureProcessOutput(
  child: { stdout?: unknown; stderr?: unknown },
  options: { maxChars?: number } = {},
): ProcessOutputCapture {
  const maxChars = options.maxChars ?? 4_000;
  let captured = '';
  const append = (text: string): void => {
    if (text) captured = (captured + text).slice(-maxChars);
  };
  const drain = async (stream: unknown): Promise<void> => {
    if (!stream || typeof (stream as ReadableStream).getReader !== 'function') return;
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        // Flush: a multibyte character split across the final two chunks is
        // held inside the decoder until it is told the stream ended.
        append(decoder.decode());
        return;
      }
      if (value) append(decoder.decode(value, { stream: true }));
    }
  };
  const done = Promise.all([
    drain(child.stdout).catch(() => undefined),
    drain(child.stderr).catch(() => undefined),
  ]).then(() => undefined);
  return { read: () => captured, done };
}

/**
 * Await a capture's EOF, bounded, then return everything it read.
 *
 * The bound exists because a stream that never closes must not become the
 * test: a child can exit while a grandchild still holds the write end of the
 * inherited pipe, and then EOF never arrives. Timing out yields what was read
 * rather than throwing — a partial log still diagnoses more than an exception
 * about the logging.
 */
export async function settledProcessOutput(
  capture: ProcessOutputCapture,
  timeoutMs = 2_000,
): Promise<string> {
  await Promise.race([capture.done, Bun.sleep(timeoutMs)]);
  return capture.read();
}

/**
 * Wait for a spawned broker to report healthy, without betting on wall clock.
 *
 * Fixtures used to give the broker a fixed budget — 15 seconds was typical —
 * which is really an assertion about how fast the host is. Under any load the
 * bet loses and the suite fails with "timed out waiting for broker health",
 * which reads like a product defect and is not one. That single number is what
 * kept suites out of the parallel group.
 *
 * The bound here is deliberately generous, because it is not measuring
 * anything: a healthy broker returns as soon as it answers, and a broker that
 * dies fails immediately instead of waiting out the clock. The only thing left
 * for the timeout to catch is a broker that neither starts nor exits.
 *
 * Returning is also the end of the work. Whichever branch wins, the polling
 * loop is cancelled and awaited before this resolves, so no probe outlives the
 * call — a rejection used to leave a request in flight for up to
 * `probeTimeoutMs`, still holding a connection to a broker the caller was
 * already tearing down.
 */
export async function waitForBrokerHealth(
  // `exited` is required, not optional. It is the only immediate notice that
  // the broker died; without it a dead broker is noticed between probes at
  // best, and a caller passing a bare `{ exitCode }` silently loses the guard
  // it looks like it has.
  child: { exitCode: number | null; exited: Promise<number> },
  healthUrl: string,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    probeTimeoutMs?: number;
  } = {},
): Promise<void> {
  const configured = Number(process.env.COSYNCING_FIXTURE_READY_TIMEOUT_MS);
  const timeoutMs = options.timeoutMs
    ?? (Number.isSafeInteger(configured) && configured > 0 ? configured : 90_000);
  const intervalMs = options.intervalMs ?? 50;
  // A probe that is never answered must not become the wait. Checking the
  // deadline only between requests meant a broker that accepted the connection
  // and then said nothing could hold this open until the suite timeout, which
  // is the failure mode this helper exists to prevent.
  const probeTimeoutMs = options.probeTimeoutMs ?? 2_000;

  // One controller for the whole wait: aborting it cancels the request in
  // flight and wakes the sleep between requests.
  const cancel = new AbortController();
  const cancelled = new Promise<void>((wake) => {
    cancel.signal.addEventListener('abort', () => wake(), { once: true });
  });

  const poll = (async () => {
    while (!cancel.signal.aborted) {
      if (child.exitCode !== null) {
        throw new Error(`broker exited with code ${child.exitCode} before becoming healthy`);
      }
      try {
        const response = await fetch(healthUrl, {
          // Either bound ends the request: the per-probe one for a server that
          // accepts and says nothing, the shared one for a wait that is over.
          signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(probeTimeoutMs)]),
        });
        if (response.ok) return;
      } catch {
        /* not listening, refused, accepted and silent, or cancelled */
      }
      if (cancel.signal.aborted) return;
      await Promise.race([Bun.sleep(intervalMs), cancelled]);
    }
  })();

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(
      () => reject(new Error(`broker did not become healthy within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  const exited = child.exited.then<never>((code) => {
    throw new Error(`broker exited with code ${code} before becoming healthy`);
  });

  try {
    await Promise.race([poll, deadline, exited]);
  } finally {
    cancel.abort();
    clearTimeout(deadlineTimer);
    // The losers of the race still settle; nothing here is an unhandled error.
    deadline.catch(() => {});
    exited.catch(() => {});
    // Awaited, not abandoned: the point of the abort is that nothing is still
    // running when this returns, and only the loop itself can attest to that.
    await poll.catch(() => {});
  }
}

/**
 * How many times a fixture broker may be respawned onto a fresh port.
 *
 * Small on purpose. This exists to absorb a lost port race, which is rare and
 * independent per attempt; a suite that cannot start a broker in three tries is
 * reporting something real, and grinding through more attempts would only
 * convert that signal into a slower, less legible failure.
 */
export const FIXTURE_BIND_ATTEMPT_CEILING = 3;

/**
 * What a loopback port looks like from OUTSIDE, without taking it.
 *
 * The obvious probe — bind it and see whether that succeeds — is disqualified
 * here. One caller runs it against a port a live child may be about to bind, so
 * holding the port even for the instant it takes to close it again would make
 * the probe the CAUSE of the `EADDRINUSE` it exists to detect: the fixture
 * would break the start it was only supposed to be watching, intermittently and
 * under exactly the load that makes the race likely. Connecting takes nothing,
 * so it cannot do that.
 *
 * Three-valued on purpose. A connect that neither answers nor is refused proves
 * nothing, and the two callers need opposite things from that: collapsing
 * `unknown` into `free` or into `listening` would make one of them fail open.
 */
export type LoopbackPortState = 'listening' | 'free' | 'unknown';

/** Loopback answers or refuses at once; anything slower is not an observation. */
const PORT_PROBE_CEILING_MS = 500;

export async function loopbackPortState(port: number): Promise<LoopbackPortState> {
  return await new Promise<LoopbackPortState>((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    let settled = false;
    const settle = (state: LoopbackPortState): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(PORT_PROBE_CEILING_MS, () => settle('unknown'));
    socket.once('connect', () => settle('listening'));
    // ECONNREFUSED is the answer worth having: the port is reachable and
    // nothing is on it. Every other error is a failure to observe.
    socket.once('error', (error: NodeJS.ErrnoException) => {
      settle(error?.code === 'ECONNREFUSED' ? 'free' : 'unknown');
    });
  });
}

/**
 * The only text that PROVES a bind collision.
 *
 * Deliberately excludes Bun's "Is port N in use?", which reads like a verdict
 * and is not one: it is the generic question Bun asks whenever a server fails
 * to start, whatever the cause — a bad host, a privileged port, a listener the
 * runtime could not create. Treating a suggestion as evidence would retry
 * ordinary startup defects, which is exactly what the retry must not do.
 * `EADDRINUSE` and its message form are the kernel's own answer.
 */
const DEFINITIVE_BIND_COLLISION = /EADDRINUSE|address already in use/i;

/**
 * Did this broker fail because SOMETHING ELSE HAD THE PORT, specifically?
 *
 * Two independent proofs, because neither is available everywhere. The error
 * code is conclusive when the caller captured output, but many suites spawn
 * with `stderr: 'ignore'` and have none to offer. For those — and for a
 * diagnostic that only asked whether the port might be in use — the port itself
 * is asked: if something still holds it after the broker exited, that is the
 * collision, observed rather than inferred.
 *
 * Deliberately fails CLOSED. A squatter that has already let go is
 * indistinguishable from a broker that died of its own bug, so an unproven
 * collision is reported as an ordinary failure and the real diagnostic
 * survives. Retrying on a guess is how a genuine startup defect gets laundered
 * into a flake that takes three times as long to fail.
 */
async function failedOnPortCollision(port: number, output: string): Promise<boolean> {
  if (DEFINITIVE_BIND_COLLISION.test(output)) return true;
  // Only an OBSERVED listener counts. `unknown` is not evidence of a squatter,
  // and treating it as one would retry an ordinary startup defect.
  return (await loopbackPortState(port)) === 'listening';
}

/** Shared prefix so a survivor reads as a fixture refusal, not a broker defect. */
export const UNREAPED_CHILD_PREFIX = 'fixture broker could not be reaped';

/**
 * How long a retired child gets to actually die.
 *
 * Generous relative to a kill: this is not measuring shutdown, it is the point
 * past which the process is treated as unkillable and the fixture refuses to
 * start another one beside it.
 */
export const FIXTURE_RETIREMENT_CEILING_MS = 5_000;

/**
 * Stop a child and PROVE it ended.
 *
 * Returns whether the process is actually gone. Both halves matter: a `stop`
 * that throws and a `stop` that returns before the process dies look identical
 * to a caller that only awaited it, and either one leaves a broker running
 * while its replacement is spawned. So the exit is awaited independently of
 * whether `stop` reported success — the signal is advice, the exit is evidence.
 */
async function retireFixtureChild<C extends FixtureBrokerChild>(
  child: C,
  stop: ((child: C) => Promise<void>) | undefined,
): Promise<boolean> {
  if (child.exitCode !== null) return true;
  if (!stop) return false;
  try {
    await stop(child);
  } catch {
    // Reported failure is not the verdict; the exit below is.
  }
  return await Promise.race([
    child.exited.then(() => true, () => true),
    Bun.sleep(FIXTURE_RETIREMENT_CEILING_MS).then(() => false),
  ]);
}

export interface FixtureBrokerChild {
  exitCode: number | null;
  exited: Promise<number>;
}

/**
 * How long a fixture broker may be alive, silent, and not listening before the
 * start is treated as STALLED rather than slow.
 *
 * Well above a real start — a source broker serves in about a second, a
 * packaged one in a few — and far below the health ceiling, so a stall is
 * caught while there is still time to respawn instead of burning the whole
 * 90-second budget first. A broker that is merely slow is still making
 * progress, and progress is visible: it has printed something, or it is
 * listening. Neither is true here.
 */
export const FIXTURE_SILENT_START_CEILING_MS = 15_000;

/** Respawns allowed for a silent stall. One: see {@link startHealthyFixtureBroker}. */
export const FIXTURE_SILENT_START_RETRIES = 1;

/** Printed when a silent stall is retried, so CI never hides that it happened. */
export const FIXTURE_SILENT_START_NOTICE =
  '[fixture] silent startup stall: the broker was alive, not listening, and had '
  + 'written nothing. Retiring it and respawning ONCE on a fresh port.';

export interface StartHealthyFixtureBrokerOptions<C extends FixtureBrokerChild> {
  /**
   * Launch a broker bound to `port`. Called once per attempt.
   *
   * `attempt` is 1-based, so a caller that keeps durable fixture state can
   * freshen it for a respawn rather than reusing the state a stalled process
   * may have half-written.
   */
  spawn: (port: number, attempt: number) => C | Promise<C>;
  /** The health endpoint for a broker on `port`. */
  healthUrl: (port: number) => string;
  /** Acquire a port. Defaults to {@link reserveLoopbackFixturePort}. */
  reservePort?: () => Promise<number>;
  /**
   * Everything the child has said SO FAR, read without waiting.
   *
   * Used to prove silence while the child is still running, so it must return
   * immediately: waiting for EOF on a process that never exits is the very
   * condition being detected, and a reader that blocked would hang the probe
   * instead of answering it.
   */
  peekOutput?: (child: C) => string;
  /**
   * The child's capture, when there is one — the preferred way to supply both.
   *
   * A capture already knows how to answer immediately AND how to wait for EOF,
   * so handing it over derives {@link peekOutput} and {@link readSettledOutput}
   * together and correctly. The two hooks below exist for a caller that has
   * only accumulated a string, and every caller that has a capture should use
   * this instead: choosing a reader per call site is exactly how one of the two
   * questions ends up answered with the other one's reader.
   */
  capture?: (child: C) => ProcessOutputCapture;
  /**
   * Everything the child said, read after its pipes have drained.
   *
   * Used to classify a failure once the child is gone, where the answer depends
   * on the LAST thing it said: `child.exited` resolving does not mean the pipes
   * are empty, so a snapshot can miss the very chunk carrying `EADDRINUSE` and
   * file a real collision as an ordinary failure.
   *
   * Deliberately separate from {@link peekOutput}. One must not wait and the
   * other must; a single reader cannot honour both, and the version that lost
   * the argument was silently wrong for whichever caller it was not written
   * for. Pass a {@link ProcessOutputCapture} through
   * {@link settledProcessOutput} here.
   */
  readSettledOutput?: (child: C) => Promise<string>;
  /**
   * Retire a child whose attempt is over.
   *
   * REQUIRED to survive a silent stall: that child is by definition still
   * running, and a replacement cannot be spawned while it might still wake up
   * and take the port.
   */
  stop?: (child: C) => Promise<void>;
  attempts?: number;
  healthOptions?: Parameters<typeof waitForBrokerHealth>[2];
  /** Override the silent-start deadline. See {@link FIXTURE_SILENT_START_CEILING_MS}. */
  silentStartMs?: number;
  /** Override the silent-stall respawn budget. See {@link FIXTURE_SILENT_START_RETRIES}. */
  silentStartRetries?: number;
}

/**
 * Is this start STALLED — alive, silent, and serving nothing?
 *
 * Resolves only when every condition holds at the deadline, and otherwise never
 * settles, so it can lose a race without ever rejecting. All four are required
 * together, and each one excludes a different thing that must NOT be retried:
 *
 *  - STILL ALIVE excludes a broker that failed and exited; that one has an exit
 *    code and a diagnostic, and re-running it would just hide a real defect.
 *  - NOT LISTENING excludes a broker that started and is merely slow to answer
 *    health — it has already done the thing a respawn would be for.
 *  - WROTE NOTHING excludes a broker that is making progress. Startup prints
 *    before it listens, so a single byte means the loader is running.
 *  - THE DEADLINE excludes an ordinary slow boot on a loaded host.
 *
 * Fails CLOSED on missing evidence: a caller that captured no output cannot
 * prove silence, so nothing is retried for it. That is deliberate — the
 * predicate must never be satisfied by not looking.
 */
async function silentStartStall<C extends FixtureBrokerChild>(
  child: C,
  port: number,
  options: StartHealthyFixtureBrokerOptions<C>,
  deadlineMs: number,
  cancelled: { done: boolean },
): Promise<string> {
  const never = new Promise<string>(() => { /* loses every race it does not win */ });
  await Bun.sleep(deadlineMs);
  if (cancelled.done) return never;
  // Without a reader there is no way to prove the process wrote nothing.
  const peek = options.capture
    ? () => options.capture!(child).read()
    : options.peekOutput && (() => options.peekOutput!(child));
  if (!peek) return never;
  if (child.exitCode !== null) return never;
  if (peek().length > 0) return never;
  // An OBSERVED absence of listener. `unknown` is not one, and the probe only
  // connects, so asking cannot cost the child the port it may be binding.
  if ((await loopbackPortState(port)) !== 'free') return never;
  if (cancelled.done || child.exitCode !== null) return never;
  return `alive with no listener on port ${port} and no output after ${deadlineMs}ms`;
}

/**
 * Start a fixture broker, surviving a lost port race.
 *
 * The reservation this builds on is a compromise: the OS is asked for a free
 * port and then RELEASES it so the child can bind it, which leaves a window
 * where anything on the host — most often another fixture doing the same thing
 * — can take it first. Nothing closes that window from inside a single attempt;
 * holding the port would prevent the child from binding it at all.
 *
 * So the race is survived instead of avoided: a broker that failed BECAUSE the
 * port was taken is retried on a fresh one, up to
 * {@link FIXTURE_BIND_ATTEMPT_CEILING}. Every other failure propagates
 * untouched and immediately, because retrying an ordinary startup defect is
 * just running it again — it hides a reproducible failure behind an
 * intermittent one, which is the more expensive bug to own.
 *
 * A second, narrower containment covers a start that never happens at all: a
 * spawned broker occasionally comes up alive, silent, and serving nothing, one
 * thread spinning while the module graph loads, and stays that way. Observed on
 * this host across several different suites — whichever spawn loses the dice
 * roll — with the loader holding a different source file each time. The
 * evidence points at module loading, which is NOT the same as proving a runtime
 * defect, so this is containment for CI and nothing more: it is confined to
 * fixtures, never production startup, allows exactly ONE respawn, announces
 * itself, and requires the full {@link silentStartStall} predicate. If the
 * replacement stalls too, the failure is reported with both attempts' evidence
 * rather than retried again.
 */
export async function startHealthyFixtureBroker<C extends FixtureBrokerChild>(
  options: StartHealthyFixtureBrokerOptions<C>,
): Promise<{ child: C; port: number }> {
  const bindCeiling = options.attempts ?? FIXTURE_BIND_ATTEMPT_CEILING;
  const silentCeiling = options.silentStartRetries ?? FIXTURE_SILENT_START_RETRIES;
  const silentStartMs = options.silentStartMs ?? FIXTURE_SILENT_START_CEILING_MS;
  const reservePort = options.reservePort ?? (async () => {
    const lease = await reserveLoopbackFixturePort();
    await lease.release();
    return lease.port;
  });

  // Budgeted separately: they are different failures, and spending one on the
  // other would let a run of port races exhaust the stall allowance (or the
  // reverse) and turn a containable flake back into a red gate.
  let bindRetries = 0;
  let silentRetries = 0;
  const stallEvidence: string[] = [];
  let attempt = 0;

  for (;;) {
    attempt += 1;
    const port = await reservePort();
    const child = await options.spawn(port, attempt);
    // Cleared in `finally` so the stall probe stops looking the moment this
    // attempt is decided, whichever way it went.
    const cancelled = { done: false };
    let stallNote: string | undefined;
    try {
      const verdict = await Promise.race([
        waitForBrokerHealth(child, options.healthUrl(port), options.healthOptions)
          .then(() => 'healthy' as const),
        silentStartStall(child, port, options, silentStartMs, cancelled)
          .then((note) => { stallNote = note; return 'stalled' as const; }),
      ]);
      if (verdict === 'healthy') return { child, port };
    } catch (error) {
      // A REJECTED health wait: the broker exited, or the ceiling expired with
      // the child having said something. Neither is a silent stall.
      const reaped = await retireFixtureChild(child, options.stop);
      // Read AFTER retirement, so a reader that waits for EOF is waiting on a
      // process that has actually ended.
      const settled = options.capture
        ? () => settledProcessOutput(options.capture!(child))
        : options.readSettledOutput && (() => options.readSettledOutput!(child));
      const output = (await settled?.()) ?? `${(error as Error)?.message ?? ''}`;
      const collided = await failedOnPortCollision(port, output);
      if (!collided || bindRetries >= bindCeiling - 1) throw error;
      // A survivor must never be left behind a respawn. It still holds whatever
      // it holds, and the next attempt would be racing the corpse of this one.
      if (!reaped) throw new Error(`${UNREAPED_CHILD_PREFIX} on port ${port}; refusing to respawn`);
      bindRetries += 1;
      continue;
    } finally {
      cancelled.done = true;
    }

    // Stalled. The wedged process is still running by definition, so retiring
    // it is not cleanup after the decision — it is a PRECONDITION of the
    // decision. A stalled child that is merely slow can still finish loading
    // and bind the port its replacement was about to take, and the two would
    // then fight over it with the suite watching the wrong one.
    stallEvidence.push(`attempt ${attempt}: ${stallNote}`);
    if (!options.stop) {
      throw new Error(
        `${UNREAPED_CHILD_PREFIX}: a silent stall cannot be retried without a stop function, `
        + `because the wedged process would outlive the attempt that gave up on it.\n`
        + stallEvidence.join('\n'),
      );
    }
    if (!(await retireFixtureChild(child, options.stop))) {
      throw new Error(
        `${UNREAPED_CHILD_PREFIX} on port ${port} after a silent stall; refusing to respawn.\n`
        + stallEvidence.join('\n'),
      );
    }
    if (silentRetries >= silentCeiling) {
      throw new Error(
        `broker start stalled silently and did not recover:\n${stallEvidence.join('\n')}`,
      );
    }
    silentRetries += 1;
    console.warn(`${FIXTURE_SILENT_START_NOTICE} (${stallNote})`);
  }
}

/**
 * Silent-stall containment for a fixture that owns ONE fixed port.
 *
 * Most suites resolve a port once, at module scope, and build every URL in the
 * file from it. Handing those a fresh port per attempt would mean rewriting the
 * suite around a mutable base URL, which is a great deal of churn for a
 * containment measure. They do not need one: a silent stall is only ever
 * declared when the port is still FREE — that is one of the four conditions —
 * so the replacement can bind exactly the same port the suite already published.
 *
 * Bind retries are therefore off here (`attempts: 1`). A suite that owns its
 * port has nowhere else to go, and a genuine collision on it is a real failure
 * that must surface rather than be retried against the same address.
 */
export async function startHealthyFixtureBrokerOnPort<C extends FixtureBrokerChild>(
  options: Omit<
    StartHealthyFixtureBrokerOptions<C>,
    'healthUrl' | 'reservePort' | 'attempts' | 'spawn'
  > & {
    port: number;
    healthUrl: string;
    spawn: (attempt: number) => C | Promise<C>;
  },
): Promise<C> {
  const { child } = await startHealthyFixtureBroker<C>({
    ...options,
    spawn: (_port, attempt) => options.spawn(attempt),
    reservePort: async () => options.port,
    healthUrl: () => options.healthUrl,
    attempts: 1,
  });
  return child;
}

/** Ask the OS for a free loopback port and release it immediately before spawn. */
export async function reserveLoopbackFixturePort(): Promise<{
  port: number;
  release: () => Promise<void>;
}> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('fixture port reservation did not publish a TCP port');
  }
  let released = false;
  return {
    port: address.port,
    release: async () => {
      if (released) throw new Error('fixture port lease released twice');
      released = true;
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => error ? reject(error) : resolveClose());
      });
    },
  };
}

/** Issue the one-use credential that a tokened fixture must put on a WebSocket URL. */
export async function issueFixtureWsAuthTicket(
  baseUrl: string,
  credentialHeaders: Record<string, string>,
  tool: string,
  sessionId: string,
  params: Record<string, string>,
): Promise<string> {
  const response = await fetch(`${baseUrl}/api/ws-auth-tickets`, {
    method: 'POST',
    headers: { ...credentialHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ tool, sessionId, params }),
  });
  const body = await response.json().catch(() => ({})) as { wsAuthTicket?: unknown; error?: unknown };
  if (response.status !== 201 || typeof body.wsAuthTicket !== 'string' || !body.wsAuthTicket) {
    throw new Error(`WebSocket ticket issuance failed (${response.status}): ${String(body.error ?? '')}`);
  }
  return body.wsAuthTicket;
}

/** Build a stream URL containing only the opaque, short-lived ticket. */
export async function fixtureWsUrl(
  baseUrl: string,
  wsBaseUrl: string,
  credentialHeaders: Record<string, string>,
  tool: string,
  sessionId: string,
  params: Record<string, string>,
): Promise<string> {
  const ticket = await issueFixtureWsAuthTicket(
    baseUrl,
    credentialHeaders,
    tool,
    sessionId,
    params,
  );
  return `${wsBaseUrl}/api/sessions/${encodeURIComponent(tool)}/${encodeURIComponent(sessionId)}`
    + `/stream?wsAuthTicket=${encodeURIComponent(ticket)}`;
}
