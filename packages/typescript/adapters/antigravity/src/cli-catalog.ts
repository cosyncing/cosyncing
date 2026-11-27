/**
 * The LIVE model catalog: `agy models`.
 *
 * The cockpit cache (`available_models.json`) froze on 2026-08-15 — the same
 * freeze that took the summaries table — while the binary kept auto-updating
 * and the model vocabulary kept rotating under it. MEASURED 2026-08-27 on
 * 1.1.22: the frozen cache carries `-tiered` placeholder ids whose displayName
 * is the raw id, none of the current per-effort ids, and no entry for the
 * label `settings.json` records — so every settings join failed, the roster
 * and the composer showed no model, and the picker offered `-tiered` rows
 * with no effort to choose. 1.1.22 added a `models` subcommand that prints the
 * live list (`id\tdisplayName` per line, one banner line first), and running
 * it does NOT refresh the cockpit cache — so this module is the only current
 * source, and the file read stays the fallback for a host with no binary.
 *
 * SPAWN DISCIPLINE. The store never executes the binary (its rule), and a
 * roster sweep must not pay a process launch per poll. So the fetch here is a
 * module-level, per-binary, single-flight cache: discovery reads whatever is
 * cached and fires one background refresh when one is due, while
 * user-initiated surfaces (the pickers) may await the fetch. A completed fetch
 * REPLACES the cached rows; a failed one keeps them, because a stale live list
 * still beats the frozen file.
 *
 * FAILURES BACK OFF (AG-3). MEASURED 2026-11-23 on 1.5.14: once agy's saved
 * sign-in can no longer be refreshed, EVERY `agy models` run waits 10 s on it
 * and is killed at {@link AGY_CLI_MODELS_TIMEOUT_MS}, and every run starts a
 * language server, writes a ~20 KB log and spawns agy's background updater (the
 * host's log directory held 3,751 run logs, 109 MB, with one more every 15
 * minutes at the old flat retry). So consecutive failures double the wait, from {@link AGY_CLI_MODELS_TTL_MS}
 * up to {@link AGY_CLI_MODELS_MAX_BACKOFF_MS}: at most one child per window. The
 * window ends early only when something that could have fixed the failure
 * changed (`recoveryStamp`: a new binary, a new sign-in), and a picker opened
 * after a failure never waits on the retry — it answers at once from what is
 * held ({@link agyCliCatalogForPicker}).
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';

import { parseAgyVersion, type AgyModelCatalog, type AgySignInEvidence, type AgyTraceSink } from './store.ts';

/** How long one `agy models` answer suppresses the next spawn — and the first back-off after a failure. */
export const AGY_CLI_MODELS_TTL_MS = 15 * 60_000;
/** The longest a run of failures may push the next attempt out. Doubling from the TTL reaches it on the fourth. */
export const AGY_CLI_MODELS_MAX_BACKOFF_MS = 2 * 60 * 60_000;
/** How long one fetch may run before the child is killed and the fetch fails. */
export const AGY_CLI_MODELS_TIMEOUT_MS = 15_000;
/** Output past this is a malfunction, not a catalog; the child is killed. */
export const AGY_CLI_MODELS_MAX_BYTES = 256 * 1024;

/**
 * The variable that stops agy updating itself from a broker probe.
 *
 * MEASURED 2026-11-23: every `agy models` run on 1.5.14 logs `auto_updater.go]
 * Spawned background update process` and rewrites `updater/update_status.json`
 * (agy replaced itself on 2026-11-22). MEASURED 2026-11-24 on 1.5.16, in an
 * isolated home: only the exact value `true` stops it — the run logs
 * `auto_updater.go:285] Auto-update disabled via environment variable
 * AGY_CLI_DISABLE_AUTO_UPDATE` — while `1`, `TRUE` and `yes` still log
 * `Spawned background update process`. (An earlier `1`, chosen from the binary's
 * strings alone, still let agy update itself.) It is set on every PROBE the
 * broker runs — the model list and version read here and doctor's `--version` —
 * and not on a Drive child, which is the user's own session under agy's own policy.
 */
export const AGY_NO_AUTO_UPDATE_ENV: Readonly<Record<string, string>> = Object.freeze({
  AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
});

/** A probe's environment: the broker's own, plus {@link AGY_NO_AUTO_UPDATE_ENV}. */
export function agyProbeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, ...AGY_NO_AUTO_UPDATE_ENV };
}

/** The wait before the next attempt after `failures` failures in a row. */
export function agyCliModelsBackoffMs(failures: number): number {
  const doublings = Math.max(0, Math.min(failures, 16) - 1);
  return Math.min(AGY_CLI_MODELS_TTL_MS * 2 ** doublings, AGY_CLI_MODELS_MAX_BACKOFF_MS);
}

/**
 * Parse `agy models` stdout into the same catalog shape the file reader builds.
 *
 * Only `id<TAB>displayName` lines count; the "Fetching available models..."
 * banner, blank lines, and anything else fall through silently — an unrecognized
 * line is not evidence of anything.
 */
export function parseAgyCliModels(stdout: string): AgyModelCatalog {
  const catalog: AgyModelCatalog = { byId: new Map(), byLabel: new Map() };
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const id = line.slice(0, tab).trim();
    const displayName = line.slice(tab + 1).trim();
    if (!id || !displayName) continue;
    catalog.byId.set(id, { id, displayName });
    const ids = catalog.byLabel.get(displayName);
    if (ids) ids.push(id);
    else catalog.byLabel.set(displayName, [id]);
  }
  return catalog;
}

export interface AgyCliCatalogOptions {
  trace?: AgyTraceSink;
  timeoutMs?: number;
  /** Test seam; the real one is `node:child_process.spawn`. */
  spawnImpl?: typeof spawn;
  /** Test seam for the TTL and back-off clock. */
  now?: () => number;
  /** The environment the probe extends. Defaults to the broker's own. */
  env?: NodeJS.ProcessEnv;
  /**
   * A cheap fingerprint of whatever could END a failure — the binary and agy's
   * sign-in record (see `agyRecoveryStamp`). A change since the failure ends its
   * back-off window early, so signing in again is picked up on the next sweep.
   */
  recoveryStamp?: () => string;
  /** Read once when a fetch fails: what agy's own newest log says about its sign-in. */
  diagnoseFailure?: () => AgySignInEvidence | undefined;
}

/** How a fetch failed. `timeout` is the measured expired-sign-in shape. */
export type AgyCliCatalogFailureKind = 'timeout' | 'exit' | 'empty' | 'oversize' | 'spawn' | 'process-error';

/** The latest settled fetch failed: what, how many times in a row, and when the next attempt may run. */
export interface AgyCliCatalogFailure {
  kind: AgyCliCatalogFailureKind;
  /** Diagnostic text, never user-facing copy. */
  detail: string;
  /** Failed fetches in a row, this one included. */
  failures: number;
  /** When the back-off window ends (the `now` clock). */
  retryAt: number;
  /** agy's own log on the sign-in, when it said anything. */
  signIn?: AgySignInEvidence;
}

type AgyCliModelsOutcome =
  | { catalog: AgyModelCatalog }
  | { failure: { kind: AgyCliCatalogFailureKind; detail: string } };

/** One `agy models` run, failures classified. Never rejects. */
function runAgyCliModels(binary: string, options: AgyCliCatalogOptions): Promise<AgyCliModelsOutcome> {
  const trace = options.trace;
  const timeoutMs = options.timeoutMs ?? AGY_CLI_MODELS_TIMEOUT_MS;
  const spawnImpl = options.spawnImpl ?? spawn;
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnImpl(binary, ['models'], { stdio: ['ignore', 'pipe', 'pipe'], env: agyProbeEnv(options.env) });
    } catch (error) {
      const detail = `spawn failed: ${String(error)}`;
      trace?.({ op: 'cli-models', detail });
      resolve({ failure: { kind: 'spawn', detail } });
      return;
    }
    let out = '';
    let bytes = 0;
    let settled = false;
    const finish = (outcome: AgyCliModelsOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if ('failure' in outcome) trace?.({ op: 'cli-models', detail: outcome.failure.detail });
      resolve(outcome);
    };
    const fail = (kind: AgyCliCatalogFailureKind, detail: string) => finish({ failure: { kind, detail } });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail('timeout', `agy models timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > AGY_CLI_MODELS_MAX_BYTES) {
        child.kill('SIGKILL');
        fail('oversize', `agy models exceeded ${AGY_CLI_MODELS_MAX_BYTES} bytes`);
        return;
      }
      out += chunk.toString('utf8');
    });
    // Drained and dropped. Its glog error lines are not a wire this module reads,
    // and an unread pipe that fills would stall the child until the timeout.
    child.stderr?.on('data', () => {});
    child.on('error', (error) => fail('process-error', `agy models process error: ${String(error)}`));
    child.on('close', (code) => {
      if (code !== 0) {
        fail('exit', `agy models exited ${code}`);
        return;
      }
      const catalog = parseAgyCliModels(out);
      if (catalog.byId.size === 0) {
        fail('empty', 'agy models printed no catalog rows');
        return;
      }
      trace?.({ op: 'cli-models', detail: `live catalog: ${catalog.byId.size} models` });
      finish({ catalog });
    });
  });
}

/** One `agy models` run. Resolves undefined — with a trace — on every failure. */
export async function fetchAgyCliCatalog(
  binary: string,
  options: AgyCliCatalogOptions = {},
): Promise<AgyModelCatalog | undefined> {
  const outcome = await runAgyCliModels(binary, options);
  return 'catalog' in outcome ? outcome.catalog : undefined;
}

interface AgyCliCatalogState {
  catalog?: AgyModelCatalog;
  /** When the last fetch SETTLED — success or failure — on the `now` clock. Undefined until one has. */
  settledAt?: number;
  /** Set while the latest settled fetch is a failure; cleared by the next success. */
  failure?: AgyCliCatalogFailure;
  /** The recovery stamp read when that failure settled. */
  failureStamp?: string;
  inFlight?: Promise<AgyModelCatalog | undefined>;
}

const stateByBinary = new Map<string, AgyCliCatalogState>();

/** The last live list this process fetched, however old. Stale live beats frozen file. */
export function cachedAgyCliCatalog(binary: string | undefined): AgyModelCatalog | undefined {
  if (!binary) return undefined;
  return stateByBinary.get(binary)?.catalog;
}

/**
 * The failure the latest SETTLED fetch ended in, or undefined when it succeeded
 * or none has settled yet. An in-flight retry does not clear it: until a fetch
 * succeeds, the last thing agy said is that it could not list its models.
 */
export function agyCliCatalogFailure(binary: string | undefined): AgyCliCatalogFailure | undefined {
  if (!binary) return undefined;
  return stateByBinary.get(binary)?.failure;
}

function readStamp(options: AgyCliCatalogOptions): string | undefined {
  try {
    return options.recoveryStamp?.();
  } catch {
    return undefined;
  }
}

/** Is a fetch due now? Never before one settles' window ends, unless something that could fix a failure changed. */
function fetchDue(state: AgyCliCatalogState, at: number, options: AgyCliCatalogOptions): boolean {
  if (state.settledAt === undefined) return true;
  if (state.failure) {
    if (at >= state.failure.retryAt) return true;
    const stamp = readStamp(options);
    return stamp !== undefined && state.failureStamp !== undefined && stamp !== state.failureStamp;
  }
  return at - state.settledAt >= AGY_CLI_MODELS_TTL_MS;
}

/**
 * The single-flight fetch, run only when due (see the module note). Await it
 * from a user-initiated surface that has no failure to report; `void` it from a
 * sweep. Never rejects.
 */
export function ensureAgyCliCatalog(
  binary: string,
  options: AgyCliCatalogOptions = {},
): Promise<AgyModelCatalog | undefined> {
  const now = options.now ?? Date.now;
  let state = stateByBinary.get(binary);
  if (!state) {
    state = {};
    stateByBinary.set(binary, state);
  }
  if (state.inFlight) return state.inFlight;
  if (!fetchDue(state, now(), options)) return Promise.resolve(state.catalog);
  const held = state;
  const flight = runAgyCliModels(binary, options).then((outcome) => {
    const settledAt = now();
    held.settledAt = settledAt;
    held.inFlight = undefined;
    if ('catalog' in outcome) {
      held.catalog = outcome.catalog;
      held.failure = undefined;
      held.failureStamp = undefined;
      return held.catalog;
    }
    const failures = (held.failure?.failures ?? 0) + 1;
    const wait = agyCliModelsBackoffMs(failures);
    let signIn: AgySignInEvidence | undefined;
    try {
      signIn = options.diagnoseFailure?.();
    } catch {
      signIn = undefined;
    }
    held.failure = {
      kind: outcome.failure.kind,
      detail: outcome.failure.detail,
      failures,
      retryAt: settledAt + wait,
      ...(signIn ? { signIn } : {}),
    };
    const stamp = readStamp(options);
    if (stamp !== undefined) held.failureStamp = stamp;
    else delete held.failureStamp;
    options.trace?.({
      op: 'cli-models-backoff',
      detail: `${failures} failed in a row (${outcome.failure.kind}`
        + `${signIn ? `; agy's log: sign-in ${signIn.state}${signIn.networkError ? ', network error' : ''}` : ''}); `
        + `next attempt in ${Math.round(wait / 60_000)} min`,
    });
    return held.catalog;
  });
  held.inFlight = flight;
  return flight;
}

/**
 * The catalog a PICKER shows. A picker is user-initiated, so it waits for the
 * live list — unless the latest fetch FAILED: then it answers at once from what
 * is held and leaves any due retry to run in the background, so an expired
 * sign-in no longer costs every picker open the full timeout.
 */
export function agyCliCatalogForPicker(
  binary: string,
  options: AgyCliCatalogOptions = {},
): Promise<AgyModelCatalog | undefined> {
  if (agyCliCatalogFailure(binary)) {
    void ensureAgyCliCatalog(binary, options);
    return Promise.resolve(cachedAgyCliCatalog(binary));
  }
  return ensureAgyCliCatalog(binary, options);
}

// ── The binary's version (AG-4) ──────────────────────────────────────────────

/**
 * How long `agy --version` may run. MEASURED 2026-11-24 on 1.5.16: 0.13 s, it
 * prints `1.5.16`, writes no run log and does not repoint `cli.log`.
 */
export const AGY_CLI_VERSION_TIMEOUT_MS = 5_000;
/** Output past this is not a version. */
const AGY_CLI_VERSION_MAX_BYTES = 4096;

interface AgyCliVersionState {
  /** The binary's `mtime:size` when this was read: agy replaces itself, so a new stamp is a new version. */
  stamp: string;
  version?: string;
  settledAt?: number;
  inFlight?: Promise<string | undefined>;
}

const versionByBinary = new Map<string, AgyCliVersionState>();

function agyBinaryStamp(binary: string): string {
  try {
    const stats = statSync(binary);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return 'unreadable';
  }
}

/** One `agy --version` run, with the probe environment. Resolves undefined, with a trace, on any failure. */
function runAgyCliVersion(binary: string, options: AgyCliCatalogOptions): Promise<string | undefined> {
  const trace = options.trace;
  const spawnImpl = options.spawnImpl ?? spawn;
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnImpl(binary, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], env: agyProbeEnv(options.env) });
    } catch (error) {
      trace?.({ op: 'cli-version', detail: `spawn failed: ${String(error)}` });
      resolve(undefined);
      return;
    }
    let out = '';
    let settled = false;
    const finish = (version: string | undefined, detail: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      trace?.({ op: 'cli-version', detail });
      resolve(version);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(undefined, `agy --version timed out after ${AGY_CLI_VERSION_TIMEOUT_MS}ms`);
    }, AGY_CLI_VERSION_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (out.length < AGY_CLI_VERSION_MAX_BYTES) out += chunk.toString('utf8').slice(0, AGY_CLI_VERSION_MAX_BYTES);
    });
    child.stderr?.on('data', () => {});
    child.on('error', (error) => finish(undefined, `agy --version process error: ${String(error)}`));
    child.on('close', (code) => {
      const version = code === 0 ? parseAgyVersion(out) : undefined;
      finish(version, version ? `agy ${version}` : `agy --version exited ${code} with no version`);
    });
  });
}

/**
 * The installed agy's version, read once per binary image (AG-4).
 *
 * The mode a Drive child launches in is encoded per version (`agyModeLaunchArgs`),
 * and the Auto row is offered only by an agy that has it. One `agy --version`
 * per binary image, single-flight; a new image (agy replaced itself) is read
 * again. A failed read is undefined — callers treat that as current upstream —
 * and is retried after {@link AGY_CLI_MODELS_TTL_MS}. Never rejects.
 */
export function agyCliVersion(binary: string, options: AgyCliCatalogOptions = {}): Promise<string | undefined> {
  const now = options.now ?? Date.now;
  const stamp = agyBinaryStamp(binary);
  let state = versionByBinary.get(binary);
  if (!state || state.stamp !== stamp) {
    state = { stamp };
    versionByBinary.set(binary, state);
  }
  if (state.inFlight) return state.inFlight;
  if (state.settledAt !== undefined
    && (state.version !== undefined || now() - state.settledAt < AGY_CLI_MODELS_TTL_MS)) {
    return Promise.resolve(state.version);
  }
  const held = state;
  const flight = runAgyCliVersion(binary, options).then((version) => {
    held.version = version;
    held.settledAt = now();
    held.inFlight = undefined;
    return version;
  });
  held.inFlight = flight;
  return flight;
}

/** Tests only: forget every cached list, failure, TTL stamp and version. */
export function resetAgyCliCatalogForTests(): void {
  stateByBinary.clear();
  versionByBinary.clear();
}
