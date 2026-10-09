/**
 * The shared half of the Claude mod seam suites: the shipped `register.js`, loaded fresh, behind a
 * thin `$` whose `http.fetch` is a real fetch over a real Unix socket, and the real broker pieces
 * under it.
 *
 * Why a fresh module per terminal. `register.js` keeps one `state` per module evaluation, which is
 * exactly what a Claude process gives it: one evaluation per process, and a second one after a hot
 * reload. Importing it again under a distinct query string is a second evaluation in Bun, so two
 * "terminals", or a terminal and its reloaded self, are two real module instances here too.
 *
 * What is faked, and only because a test cannot have it: the Claude engine behind `next(e)`, the
 * TUI that would draw a band, and the host timer behind `$.clock.after` (a plain `setTimeout` that
 * this harness can cancel, which is what a hot reload does to the old module's waits).
 *
 * This is not a suite. It is imported by `test-claude-mod-lifecycle-seam.ts`,
 * `test-claude-mod-hold-seam.ts` and the terminal fixture they spawn.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModSocketServer, MOD_SOCKET_FILENAME } from '../../src/sessions/mod-socket-server.ts';
import { ModRegistry } from '../../src/sessions/mod-registry.ts';
import { ModHoldStore, type ModGateInputs, type ModHoldRecord } from '../../src/sessions/mod-holds.ts';
import { ModAuditStore } from '../../src/sessions/mod-audit.ts';

export const REPO_ROOT = fileURLToPath(new URL('../../../../..', import.meta.url));
export const MOD_REGISTER = join(REPO_ROOT, 'mods/cosyncing-claude/hooks/register.js');

export type Handler = ($: unknown, e: Record<string, unknown>, next: (e: Record<string, unknown>) => Promise<unknown>) => Promise<unknown>;

/** One request the mod sent, as the fake host saw it leave. */
export interface SentRequest {
  route: string;
  query: Record<string, string>;
  body: Record<string, unknown>;
  at: number;
}

/** What one terminal's mod did, which is what the assertions read. */
export interface ModRecord {
  prompts: { text?: string; asUser?: boolean }[];
  aborts: { turnId?: string }[];
  appends: unknown[];
  /** Every `$.ui.log` line, with the sink the mod asked for. `to` is absent when none was given. */
  logs: { text: string; to?: string }[];
  fetches: number;
  requests: SentRequest[];
  /** Every Button the band tree built, newest last. */
  bands: Record<string, unknown>[];
  /** Every tree `ui.render` returned that was not the engine's own. */
  renders: unknown[];
  invalidations: number;
  /** Every answer the broker gave, paired with the request it answered, in arrival order. */
  replies: { request: SentRequest; status: number; text: string; at: number }[];
}

export interface LoadModOptions {
  /** The terminal's environment, as `$.env.get` reads it. Nothing else is visible to the mod. */
  env: Record<string, string | undefined>;
  sessionId: string;
  surface?: string;
  cwd?: string;
  version?: string;
  /** What `$.session.append` answers. Default: a stored row. */
  appendResult?: () => unknown;
  /** What `$.prompt.submit` answers, or throws. Default: accepted. */
  promptSubmit?: (input: { text?: string; asUser?: boolean }) => unknown;
  /**
   * Called before each request leaves. Resolve to let it go; the suites use this to model the
   * network timing they need (a leg that arrives late), never to answer for the broker.
   */
  beforeFetch?: (request: SentRequest) => Promise<void> | void;
  /**
   * Called with the broker's answer before the mod is handed it, so a suite can hold an answer that
   * the broker has already given -- the moment between "the broker sent it" and "the mod read it".
   */
  afterFetch?: (request: SentRequest, reply: { status: number; text: string }) => Promise<void> | void;
  /** Make `$.clock.after` throw, the way a host that refuses the dispatch does. */
  clockThrows?: () => boolean;
  /** The engine's own `tool.check` verdict beneath the mod. */
  engineVerdict?: () => unknown;
  /** The tool's own `tool.call` result beneath the mod: the picker the human would get. */
  toolResult?: () => unknown;
}

export interface ModInstance {
  readonly label: string;
  readonly record: ModRecord;
  /** The module's own exports: `tuneForTest`, `validateAnswers`, and the rest. */
  readonly exports: Record<string, unknown>;
  /** Drive one hook the way the engine would, matcher and all. */
  /**
   * Run the mod's hook for `event`. `signal` is the engine's `next.signal`, the abort it raises on
   * a hook it has given up on.
   */
  fire(event: string, e: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  /**
   * The engine's side of an event the mod may not hook: with no hook the event passes and nothing
   * of the mod runs, which is what it does in Claude. `turn.step` streams, as it does there: the
   * hook is an async generator, drained here, and `next(e)` is a stream of one text chunk.
   */
  fireIfHooked(event: string, e: Record<string, unknown>): Promise<unknown>;
  /** When the most recent `next(e)` of an event ran, so "next was not delayed" is a number. */
  nextAt(event: string): number | undefined;
  /** Change what `$.session.id()` answers, which is what `/clear` does. */
  setSessionId(id: string): void;
  /** Press the band button a human would press. */
  tapBand(label: string): void;
  /** The band currently drawn, as `ui.render` would draw it now. */
  renderNow(): Promise<unknown>;
  /**
   * This module's `$` goes away: every pending timer is cancelled and every later fetch rejects.
   * It is the in-process model of a hot reload retiring the old module's environment, and of a
   * killed process whose connections have closed.
   */
  kill(): void;
  readonly killed: boolean;
  /**
   * A hot reload, as the build documents it for the OLD module: its pending `$.clock` waits are
   * cancelled with the old environment, and a new wait is refused. Its fetches are NOT cut: a
   * request chain that was already running keeps running, which is what let two loops fight.
   */
  reloadAway(): void;
  /** Requests sent since the given index, by route. */
  requestsSince(index: number, route?: string): SentRequest[];
}

let instanceCounter = 0;

/** Split a request target into its route name and query. */
function parseTarget(url: string): { route: string; query: Record<string, string> } {
  const parsed = new URL(url);
  const route = parsed.pathname.replace(/^\/claude\/mod\//, '');
  const query: Record<string, string> = {};
  for (const [key, value] of parsed.searchParams.entries()) query[key] = value;
  return { route, query };
}

/** Load a fresh `register.js` behind a fake `$`. Each call is a new module evaluation. */
export async function loadMod(label: string, options: LoadModOptions): Promise<ModInstance> {
  instanceCounter += 1;
  const module = await import(`${MOD_REGISTER}?seam=${encodeURIComponent(label)}-${instanceCounter}-${Date.now()}`) as Record<string, unknown>;
  const handlers = new Map<string, Handler>();
  const matchers = new Map<string, Record<string, unknown>>();
  const on = (event: string, matcherOrHandler: unknown, maybeHandler?: Handler): void => {
    if (typeof matcherOrHandler === 'function') handlers.set(event, matcherOrHandler as Handler);
    else {
      matchers.set(event, matcherOrHandler as Record<string, unknown>);
      handlers.set(event, maybeHandler!);
    }
  };
  (module.register as (on: unknown) => void)(on);

  const record: ModRecord = {
    prompts: [], aborts: [], appends: [], logs: [], fetches: 0, requests: [], bands: [], renders: [], invalidations: 0, replies: [],
  };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const nextTimes = new Map<string, number>();
  let killed = false;
  let reloaded = false;
  let sessionId = options.sessionId;
  /** Every open fetch, so `kill` can abort them the way a closed process would. */
  const inflight = new Set<AbortController>();

  const fire = async (event: string, e: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    const handler = handlers.get(event);
    if (!handler) throw new Error(`the mod registered no ${event} hook`);
    const matcher = matchers.get(event);
    if (matcher && !Object.entries(matcher).every(([key, value]) => e[key] === value)) return undefined;
    const next = async (ev: Record<string, unknown>) => {
      nextTimes.set(event, Date.now());
      if (event === 'tool.check') return options.engineVerdict ? options.engineVerdict() : { decision: 'ask' };
      if (event === 'tool.call') return options.toolResult ? options.toolResult() : { ranItself: true };
      if (event === 'ui.render') return { engineDrew: true };
      return ev;
    };
    if (signal) (next as unknown as { signal: AbortSignal }).signal = signal;
    return handler(dollar, e, next);
  };
  const fireIfHooked = async (event: string, e: Record<string, unknown>): Promise<unknown> => {
    const handler = handlers.get(event);
    if (!handler) return undefined;
    if (event !== 'turn.step') return fire(event, e);
    async function* beneath(): AsyncGenerator<Record<string, unknown>, Record<string, unknown>> {
      nextTimes.set(event, Date.now());
      yield { type: 'text', index: 0, text: 'working' };
      return { stopReason: 'tool_use' };
    }
    const stream = (handler as unknown as (d: unknown, ev: unknown, n: unknown) => AsyncGenerator<unknown, unknown>)(dollar, e, () => beneath());
    const chunks: unknown[] = [];
    for (;;) {
      const step = await stream.next();
      if (step.done) return { chunks, result: step.value };
      chunks.push(step.value);
    }
  };

  const dollar = {
    env: {
      get: async (key: string) => (Object.prototype.hasOwnProperty.call(options.env, key) ? options.env[key] : undefined),
    },
    http: {
      fetch: async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; socketPath?: string }) => {
        if (killed) throw new Error('environment disposed');
        record.fetches += 1;
        const { route, query } = parseTarget(url);
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
        } catch {
          body = {};
        }
        const sent: SentRequest = { route, query, body, at: Date.now() };
        record.requests.push(sent);
        if (options.beforeFetch) await options.beforeFetch(sent);
        if (killed) throw new Error('environment disposed');
        // The engine gives one fetch 30 s; the abort models that, and `kill` uses it to hang up.
        const controller = new AbortController();
        inflight.add(controller);
        const engineAbort = setTimeout(() => controller.abort(), 30_000);
        try {
          const response = await fetch(url, {
            method: init.method ?? 'POST',
            headers: init.headers,
            body: init.body,
            unix: init.socketPath,
            signal: controller.signal,
          } as unknown as RequestInit);
          const text = await response.text();
          record.replies.push({ request: sent, status: response.status, text, at: Date.now() });
          if (options.afterFetch) await options.afterFetch(sent, { status: response.status, text });
          if (killed) throw new Error('environment disposed');
          return { status: response.status, ok: response.ok, headers: {}, text };
        } finally {
          clearTimeout(engineAbort);
          inflight.delete(controller);
        }
      },
    },
    session: {
      id: async () => sessionId,
      version: async () => ({ base: options.version ?? '2.1.289', version: options.version ?? '2.1.289' }),
      cwd: async () => options.cwd ?? '/',
      surfaces: async () => [options.surface ?? 'terminal'],
      append: async (message: unknown) => {
        record.appends.push(message);
        return options.appendResult ? options.appendResult() : { uuid: `row-${record.appends.length}` };
      },
    },
    prompt: {
      submit: async (input: { text?: string; asUser?: boolean }) => {
        record.prompts.push(input);
        return options.promptSubmit ? options.promptSubmit(input) : { ok: true };
      },
    },
    turn: {
      abort: async (input: { turnId?: string }) => {
        record.aborts.push(input);
        return { ok: true };
      },
    },
    ui: {
      log: (text: string, logOptions?: { to?: string }) => {
        record.logs.push({ text: String(text), ...(logOptions && typeof logOptions.to === 'string' ? { to: logOptions.to } : {}) });
      },
      // The host's half of a band: `invalidate('ui.render')` makes the engine ask for the tree
      // again. Without it a band is a state change nobody ever drew.
      invalidate: () => {
        record.invalidations += 1;
        if (killed) return;
        void fire('ui.render', { component: 'AbovePrompt', hasSurvey: false })
          .then((tree) => {
            if (tree && !(tree as { engineDrew?: boolean }).engineDrew) record.renders.push(tree);
          })
          .catch(() => undefined);
      },
      resolve: () => ({
        Box: (props: Record<string, unknown>) => ({ type: 'Box', ...props }),
        Text: (props: Record<string, unknown>) => ({ type: 'Text', ...props }),
        Button: (props: Record<string, unknown>) => {
          record.bands.push(props);
          return { type: 'Button', ...props };
        },
      }),
    },
    clock: {
      after: (ms: number, fn: () => void) => {
        if (options.clockThrows?.()) throw new Error('clock.after refused');
        if (killed || reloaded) throw new Error('environment disposed');
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (!killed && !reloaded) fn();
        }, Math.max(0, ms));
        timers.add(timer);
        return { cancel: () => { clearTimeout(timer); timers.delete(timer); } };
      },
    },
  };

  return {
    label,
    record,
    exports: module,
    fire,
    fireIfHooked,
    nextAt: (event) => nextTimes.get(event),
    setSessionId: (id) => { sessionId = id; },
    tapBand: (buttonLabel) => {
      const button = [...record.bands].reverse().find((b) => b.label === buttonLabel) as { onPress?: () => void } | undefined;
      if (!button?.onPress) throw new Error(`the band offered no ${buttonLabel} button`);
      button.onPress();
    },
    renderNow: async () => fire('ui.render', { component: 'AbovePrompt', hasSurvey: false }),
    kill: () => {
      killed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const controller of inflight) controller.abort();
      inflight.clear();
    },
    get killed() {
      return killed;
    },
    reloadAway: () => {
      reloaded = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
    requestsSince: (index, route) => record.requests.slice(index).filter((r) => route === undefined || r.route === route),
  };
}

/** A mkdtemp root that the suite removes, with a short path: a socket path has a 100-byte ceiling. */
export function tempRoot(prefix: string): { root: string; remove: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return {
    root,
    remove: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* already gone */
      }
    },
  };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait for a condition, checked every 20 ms, for at most `ms`. Returns the final reading. */
export async function until(what: () => boolean, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (what()) return true;
    if (Date.now() >= deadline) return what();
    await sleep(20);
  }
}

/** The PASS/FAIL ledger every suite in this lane prints. */
export function ledger(): {
  check: (name: string, ok: boolean, detail?: string) => void;
  finish: () => never;
  results: { name: string; ok: boolean; detail: string }[];
} {
  const results: { name: string; ok: boolean; detail: string }[] = [];
  return {
    results,
    check(name, ok, detail = '') {
      results.push({ name, ok, detail });
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
    },
    finish() {
      const failed = results.filter((r) => !r.ok);
      console.log(`\n${failed.length ? `FAILED ${failed.length}/${results.length}` : `OK ${results.length}/${results.length} passed`}`);
      for (const item of failed) console.log(`  failed: ${item.name}${item.detail ? ' — ' + item.detail : ''}`);
      process.exit(failed.length ? 1 : 0);
    },
  };
}

// ── the broker side, as real as a suite can have it ─────────────────────────────


export interface SocketBroker {
  socketPath: string;
  server: ModSocketServer;
  registry: ModRegistry;
  holds: ModHoldStore;
  audit: ModAuditStore;
  /** The gate's inputs, read at the moment a hold arrives. Mutable on purpose. */
  gate: ModGateInputs;
  events: { sessionId: string; kind: string; requestId?: string; detail?: Record<string, unknown> }[];
  refusals: { code: string; route: string; detail: string }[];
  registered: { sessionId: string; peerPid: number }[];
  accepted: ModHoldRecord[];
  released: { sessionId: string; requestId: string; why: string }[];
  resolved: { sessionId: string; requestId: string; kind: string }[];
  close(): void;
}

export interface SocketBrokerOptions {
  gate?: Partial<ModGateInputs>;
  /**
   * The broker-descendant rule refuses a peer the broker launched. A suite whose "terminal" is a
   * child of the suite process -- which is also the broker here -- turns that one rule off; the
   * uid check, the claim and every route's peer check stay on.
   */
  isBrokerChild?: (pid: number) => boolean;
  holdPollWaitMs?: number;
  leaseMs?: number;
  staleAfterMs?: number;
  /** Called after a registration is accepted, before it is answered. */
  onRegister?: (sessionId: string, peerPid: number) => void;
}

/** The real registry, hold store, audit and socket server, bound in `root`. */
export async function socketBroker(root: string, options: SocketBrokerOptions = {}): Promise<SocketBroker> {
  const socketPath = join(root, MOD_SOCKET_FILENAME);
  const gate: ModGateInputs = { mode: 'default', viewers: 1, killSwitch: false, ...options.gate };
  const events: SocketBroker['events'] = [];
  const refusals: SocketBroker['refusals'] = [];
  const registered: SocketBroker['registered'] = [];
  const accepted: ModHoldRecord[] = [];
  const released: SocketBroker['released'] = [];
  const resolved: SocketBroker['resolved'] = [];
  const registry = new ModRegistry(options.staleAfterMs ? { staleAfterMs: options.staleAfterMs } : {});
  const audit = new ModAuditStore();
  const holds = new ModHoldStore({
    registry,
    audit,
    gate: () => gate,
    ...(options.leaseMs ? { leaseMs: options.leaseMs } : {}),
    onHoldAccepted: (hold) => accepted.push(hold),
    onRelease: (sessionId, hold, why) => released.push({ sessionId, requestId: hold.requestId, why }),
    onResolve: (sessionId, requestId, outcome) => resolved.push({ sessionId, requestId, kind: outcome.kind }),
  });
  const server = new ModSocketServer({
    socketPath,
    registry,
    holds,
    killSwitch: () => gate.killSwitch,
    holdPollWaitMs: options.holdPollWaitMs ?? 1_000,
    onEvent: (event) => events.push({ ...event }),
    onRefusal: (code, detail, route) => refusals.push({ code, route, detail }),
    onRegister: (sessionId, info) => {
      registered.push({ sessionId, peerPid: info.peerPid });
      options.onRegister?.(sessionId, info.peerPid);
    },
    log: { warn: () => {} },
    ...(options.isBrokerChild ? { isBrokerChild: options.isBrokerChild } : {}),
  });
  await server.start();
  return {
    socketPath, server, registry, holds, audit, gate, events, refusals, registered, accepted, released, resolved,
    close: () => {
      try {
        server.close();
      } catch {
        /* already closed */
      }
    },
  };
}
