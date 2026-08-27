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
 * module-level, per-binary, single-flight cache with a TTL: discovery reads
 * whatever is cached and fires one background refresh at most once per TTL —
 * failures included, so an offline host does not spawn on every sweep — while
 * user-initiated surfaces (the pickers) may await the fetch. A completed fetch
 * REPLACES the cached rows; a failed one keeps them, because a stale live list
 * still beats the frozen file.
 */
import { spawn } from 'node:child_process';

import type { AgyModelCatalog, AgyTraceSink } from './store.ts';

/** How long one `agy models` answer — or one failure — suppresses the next spawn. */
export const AGY_CLI_MODELS_TTL_MS = 15 * 60_000;
/** How long one fetch may run before the child is killed and the fetch fails. */
export const AGY_CLI_MODELS_TIMEOUT_MS = 15_000;
/** Output past this is a malfunction, not a catalog; the child is killed. */
export const AGY_CLI_MODELS_MAX_BYTES = 256 * 1024;

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
  /** Test seam for the TTL clock. */
  now?: () => number;
}

/** One `agy models` run. Resolves undefined — with a trace — on every failure. */
export function fetchAgyCliCatalog(
  binary: string,
  options: AgyCliCatalogOptions = {},
): Promise<AgyModelCatalog | undefined> {
  const trace = options.trace;
  const timeoutMs = options.timeoutMs ?? AGY_CLI_MODELS_TIMEOUT_MS;
  const spawnImpl = options.spawnImpl ?? spawn;
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnImpl(binary, ['models'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      trace?.({ op: 'cli-models', detail: `spawn failed: ${String(error)}` });
      resolve(undefined);
      return;
    }
    let out = '';
    let bytes = 0;
    let settled = false;
    const finish = (catalog: AgyModelCatalog | undefined, detail?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (detail) trace?.({ op: 'cli-models', detail });
      resolve(catalog);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(undefined, `agy models timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > AGY_CLI_MODELS_MAX_BYTES) {
        child.kill('SIGKILL');
        finish(undefined, `agy models exceeded ${AGY_CLI_MODELS_MAX_BYTES} bytes`);
        return;
      }
      out += chunk.toString('utf8');
    });
    child.on('error', (error) => finish(undefined, `agy models process error: ${String(error)}`));
    child.on('close', (code) => {
      if (code !== 0) {
        finish(undefined, `agy models exited ${code}`);
        return;
      }
      const catalog = parseAgyCliModels(out);
      if (catalog.byId.size === 0) {
        finish(undefined, 'agy models printed no catalog rows');
        return;
      }
      trace?.({ op: 'cli-models', detail: `live catalog: ${catalog.byId.size} models` });
      finish(catalog);
    });
  });
}

interface AgyCliCatalogState {
  catalog?: AgyModelCatalog;
  /** When the last fetch SETTLED — success or failure — for the TTL gate. */
  settledAt: number;
  inFlight?: Promise<AgyModelCatalog | undefined>;
}

const stateByBinary = new Map<string, AgyCliCatalogState>();

/** The last live list this process fetched, however old. Stale live beats frozen file. */
export function cachedAgyCliCatalog(binary: string | undefined): AgyModelCatalog | undefined {
  if (!binary) return undefined;
  return stateByBinary.get(binary)?.catalog;
}

/**
 * The TTL'd single-flight fetch. Await it from a user-initiated surface;
 * `void` it from a sweep. Never rejects.
 */
export function ensureAgyCliCatalog(
  binary: string,
  options: AgyCliCatalogOptions = {},
): Promise<AgyModelCatalog | undefined> {
  const now = options.now ?? Date.now;
  let state = stateByBinary.get(binary);
  if (!state) {
    state = { settledAt: 0 };
    stateByBinary.set(binary, state);
  }
  if (state.inFlight) return state.inFlight;
  if (now() - state.settledAt < AGY_CLI_MODELS_TTL_MS) return Promise.resolve(state.catalog);
  const flight = fetchAgyCliCatalog(binary, options).then((catalog) => {
    state.settledAt = now();
    state.inFlight = undefined;
    if (catalog) state.catalog = catalog;
    return state.catalog;
  });
  state.inFlight = flight;
  return flight;
}

/** Tests only: forget every cached list and every TTL stamp. */
export function resetAgyCliCatalogForTests(): void {
  stateByBinary.clear();
}
