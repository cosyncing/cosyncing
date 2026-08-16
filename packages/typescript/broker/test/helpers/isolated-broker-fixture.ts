import { copyFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
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
