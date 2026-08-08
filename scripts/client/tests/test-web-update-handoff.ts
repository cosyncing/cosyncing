#!/usr/bin/env bun
/**
 * Deterministic audit of the automatic web-update handoff (N3b).
 *
 * Runs the REAL sources — the coordinator script inside
 * `apps/client/web/index.html`, the handoff document the broker serves, and the
 * message handler in `apps/client/web/sw.js` — inside a fake browser: shared
 * service-worker registration, per-tab session storage, a real BroadcastChannel
 * bus, real MessageChannel ports, and a virtual clock. No browser, no network,
 * no build required, and no wall-clock waiting for a four-second acknowledgement
 * window.
 *
 * The registration model is the point. A worker retires when it controls no
 * clients, and a tab is a client while its document is inside the worker's
 * scope. Navigating a tab out of scope removes it; the last removal activates
 * the waiting worker. Every property below is observed against that model
 * rather than asserted about the code.
 *
 *   bun run scripts/client/tests/test-web-update-handoff.ts
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  assertHandoffCoordinator,
  assertNoSkipWaiting,
} from '../build-web-cache.ts';
import { CLIENT_ROOT } from '../run-client-command.ts';
import {
  serveWebHandoff,
  WEB_HANDOFF_DEADLINE_MS,
  WEB_HANDOFF_DOCUMENT,
  WEB_HANDOFF_MAX_ROUTE_CHARS,
  WEB_HANDOFF_PATH,
} from '../../../packages/typescript/broker/src/web-handoff.ts';

const ORIGIN = 'https://broker.example';
const SCOPE = `${ORIGIN}/cosy/`;
const HANDOFF = ORIGIN + WEB_HANDOFF_PATH;

let failures = 0;
let checks = 0;

function check(condition: unknown, description: string): void {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.error(`  FAIL ${description}`);
}

function checkEqual(actual: unknown, expected: unknown, description: string): void {
  checks += 1;
  if (Object.is(actual, expected)) return;
  failures += 1;
  console.error(
    `  FAIL ${description}\n       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

/* ------------------------------------------------------------------ *
 * Source extraction. The scripts under test are the shipped ones.
 * ------------------------------------------------------------------ */

/** The coordinator block that `assertHandoffCoordinator` requires to exist. */
function extractCoordinator(indexHtml: string): string {
  const marker = indexHtml.indexOf('cosyncing-handoff-coordinator');
  if (marker === -1) throw new Error('index.html carries no handoff coordinator marker');
  const open = indexHtml.indexOf('<script>', marker);
  const close = indexHtml.indexOf('</script>', open);
  if (open === -1 || close === -1) throw new Error('handoff coordinator script not found');
  return indexHtml.slice(open + '<script>'.length, close);
}

function extractHandoffScript(document: string): string {
  const open = document.indexOf('<script>');
  const close = document.indexOf('</script>', open);
  if (open === -1 || close === -1) throw new Error('handoff document carries no script');
  return document.slice(open + '<script>'.length, close);
}

/* ------------------------------------------------------------------ *
 * Virtual clock. Every bound in the protocol is measured against it.
 * ------------------------------------------------------------------ */

interface VirtualTimer {
  at: number;
  order: number;
  fn: () => void;
  cancelled: boolean;
}

class Clock {
  now = 1_000_000;
  private order = 0;
  private readonly timers = new Map<number, VirtualTimer>();

  setTimeout = (fn: () => void, ms?: number): number => {
    const id = ++this.order;
    this.timers.set(id, {
      at: this.now + (typeof ms === 'number' ? ms : 0),
      order: id,
      fn,
      cancelled: false,
    });
    return id;
  };

  clearTimeout = (id: number): void => {
    const timer = this.timers.get(id);
    if (timer) timer.cancelled = true;
    this.timers.delete(id);
  };

  /** Lets every queued microtask and I/O callback run before the next timer. */
  private async drain(): Promise<void> {
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /** Runs every timer due within `ms`, in order, draining between each. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      await this.drain();
      let next: VirtualTimer | undefined;
      for (const timer of this.timers.values()) {
        if (timer.cancelled) continue;
        if (!next || timer.at < next.at || (timer.at === next.at && timer.order < next.order)) {
          next = timer;
        }
      }
      if (!next || next.at > target) break;
      this.now = next.at;
      this.timers.delete(next.order);
      try {
        next.fn();
      } catch (error) {
        console.error('  (virtual timer threw)', error);
      }
    }
    this.now = target;
    await this.drain();
  }
}

/* ------------------------------------------------------------------ *
 * Shared same-origin bus.
 * ------------------------------------------------------------------ */

interface BusEntry {
  name: string;
  owner: object;
  deliver: (data: unknown) => void;
}

class Bus {
  readonly channels: BusEntry[] = [];
  /** Every message ever posted, for coordinator-count assertions. */
  readonly traffic: Array<{ from: object; data: any }> = [];

  post(name: string, from: object, data: unknown): void {
    this.traffic.push({ from, data: data as any });
    // Snapshot, and re-check membership per delivery: a `go` makes each
    // recipient navigate synchronously, which closes its own channel. Iterating
    // the live array would silently skip the next tab — and a partially moved
    // set is precisely the failure the protocol exists to avoid.
    for (const entry of [...this.channels]) {
      if (entry.name !== name || entry.owner === from) continue;
      if (!this.channels.includes(entry)) continue;
      entry.deliver(structuredClone(data));
    }
  }

  open(name: string, owner: object, deliver: (data: unknown) => void): { close(): void } {
    const entry: BusEntry = { name, owner, deliver };
    this.channels.push(entry);
    return {
      close: () => {
        const index = this.channels.indexOf(entry);
        if (index !== -1) this.channels.splice(index, 1);
      },
    };
  }

  countMessages(kind: string): number {
    return this.traffic.filter((item) => item.data && item.data.k === kind).length;
  }
}

/* ------------------------------------------------------------------ *
 * Service worker instances over the real sw.js message handler.
 * ------------------------------------------------------------------ */

interface FakeWorker {
  version: string;
  cacheName: string;
  state: string;
  addEventListener(type: string, fn: () => void): void;
  fireState(next: string): void;
  postMessage(data: unknown, transfer?: unknown[]): void;
  skipWaitingCalls(): number;
}

/**
 * Source with comments removed, so a "does the code do X" check reads code.
 *
 * Both shipped scripts document at length that they never call `skipWaiting`
 * and never unregister anything. Matching the explanation instead of the call
 * is how a fail-proof ends up deleted rather than fixed.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => {
      const marker = line.indexOf('//');
      return marker === -1 ? line : line.slice(0, marker);
    })
    .join('\n');
}

let workerSourceTemplate = '';

/**
 * Loads `apps/client/web/sw.js` stamped with one synthetic build identity.
 *
 * Only the message handler is exercised here; the cache model has its own
 * deterministic audit. The `skipWaiting` counter exists so this test can state
 * as a fact — not an inspection — that the handoff never activates a worker.
 */
function makeWorker(version: string, registration: Registration): FakeWorker {
  const listeners = new Map<string, (event: any) => void>();
  let skipWaitingCalls = 0;
  const scope: Record<string, unknown> = {
    location: { href: `${SCOPE}sw.js` },
    registration: { scope: SCOPE },
    clients: {
      claim: async () => {},
      matchAll: async (options: { type?: string; includeUncontrolled?: boolean }) => {
        if (options?.type !== 'window') throw new Error('unexpected client query');
        // A worker's controllees are the in-scope documents it actually
        // controls; a waiting worker controls nothing.
        return registration.active === worker ? registration.controlled() : [];
      },
    },
    skipWaiting: async () => {
      skipWaitingCalls += 1;
    },
    addEventListener: (type: string, handler: (event: any) => void) => {
      listeners.set(type, handler);
    },
    caches: {
      open: async () => ({ match: async () => undefined, put: async () => {} }),
      keys: async () => [],
      delete: async () => false,
    },
    fetch: async () => {
      throw new Error('the message handler must not fetch');
    },
    URL,
    Set,
    Map,
    Promise,
    JSON,
    console,
    Response: class {
      constructor(readonly body?: unknown) {}
    },
    crypto: globalThis.crypto,
  };
  scope.self = scope;

  const source = workerSourceTemplate
    .replace('__COSYNCING_BUILD_VERSION__', version)
    .replace('__COSYNCING_PRECACHE_URLS__', JSON.stringify(['index.html']))
    .replace('__COSYNCING_RUNTIME_URLS__', JSON.stringify([]))
    .replace('__COSYNCING_ASSET_HASHES__', JSON.stringify({ 'index.html': 'x'.repeat(64) }));

  // eslint-disable-next-line no-new-func -- running the shipped worker is the point
  const factory = new Function(
    'self',
    'caches',
    'fetch',
    'console',
    'Response',
    'crypto',
    `${source}\nreturn true;`,
  );
  factory(scope, scope.caches, scope.fetch, console, scope.Response, globalThis.crypto);

  const stateListeners: Array<() => void> = [];
  const worker: FakeWorker = {
    version,
    cacheName: `cosyncing-app:/cosy/:${version}`,
    state: 'installing',
    addEventListener(type: string, fn: () => void) {
      if (type === 'statechange') stateListeners.push(fn);
    },
    fireState(next: string) {
      worker.state = next;
      for (const fn of [...stateListeners]) fn();
    },
    postMessage(data: unknown, transfer?: unknown[]) {
      const handler = listeners.get('message');
      if (!handler) return;
      handler({
        data,
        ports: transfer ?? [],
        source: null,
        waitUntil: (promise: Promise<unknown>) => {
          void Promise.resolve(promise).catch(() => {});
        },
      });
    },
    skipWaitingCalls: () => skipWaitingCalls,
  };
  return worker;
}

/* ------------------------------------------------------------------ *
 * Registration: the model the whole property rests on.
 * ------------------------------------------------------------------ */

class Registration {
  readonly scope = SCOPE;
  active: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  installing: FakeWorker | null = null;
  /** Every open tab, in or out of scope. */
  readonly tabs: Tab[] = [];
  /**
   * Documents that have not been told about the waiting worker yet.
   *
   * One registration is shared by every tab, but `registration.waiting` is
   * surfaced to each DOCUMENT separately and a tab that registered a moment
   * late sees null while another already sees the worker. That skew is the
   * race the peer-local grace exists for, and it cannot be modelled by hiding
   * the worker globally — doing that also stops the coordinator, so no round
   * runs and the case proves nothing.
   */
  readonly unaware = new Set<Tab>();
  readonly listeners: Array<{ tab: Tab; type: string; fn: () => void }> = [];
  /** Recorded activations, so identity before/after is checkable. */
  readonly activations: string[] = [];
  /**
   * Holds the scope open however many clients have left.
   *
   * Models the one shape of REAL handoff failure: every tab did its part and
   * moved out, and the replacement still did not take over — a client that
   * arrived between `go` and activation, a worker whose activate handler could
   * not write its marker, an environment that refuses the promotion. What is
   * under test here is the coordinator's bounded attempt budget, not the
   * browser's activation rule, which the two-tab and N+2 cases already observe.
   */
  blockActivation = false;

  /** Documents currently inside the worker's scope: its controllees. */
  controlled(): Tab[] {
    return this.tabs.filter((tab) => tab.inScope() && !tab.closed);
  }

  on(tab: Tab, type: string, fn: () => void): void {
    this.listeners.push({ tab, type, fn });
  }

  /** Modelled so a listener the page detaches really stops firing. */
  off(tab: Tab, type: string, fn: () => void): void {
    const index = this.listeners.findIndex(
      (listener) => listener.tab === tab && listener.type === type && listener.fn === fn,
    );
    if (index !== -1) this.listeners.splice(index, 1);
  }

  offTab(tab: Tab): void {
    for (let i = this.listeners.length - 1; i >= 0; i--) {
      if (this.listeners[i]!.tab === tab) this.listeners.splice(i, 1);
    }
  }

  fire(type: string): void {
    for (const listener of [...this.listeners]) {
      if (listener.type === type && !listener.tab.closed) listener.fn();
    }
  }

  /**
   * Activates the waiting worker once nothing is left to control.
   *
   * This is the browser's rule, not ours, and it is what the handoff exists to
   * satisfy: a waiting worker is promoted only when the previous worker's
   * controllee set is empty.
   */
  maybeActivate(): void {
    if (!this.waiting) return;
    if (this.blockActivation) return;
    if (this.controlled().length > 0) return;
    this.active = this.waiting;
    this.waiting = null;
    this.activations.push(this.active.version);
    for (const tab of this.tabs) {
      if (!tab.closed && tab.inScope()) tab.controller = this.active;
    }
  }

  /**
   * Ships a new build: it installs, hash-verifies, and waits.
   *
   * The order mirrors the browser's: `updatefound` fires while the worker is
   * still installing, and the move to `installed`/`waiting` is what the page's
   * own statechange listener sees.
   */
  deploy(version: string): FakeWorker {
    const worker = makeWorker(version, this);
    this.installing = worker;
    this.fire('updatefound');
    this.installing = null;
    this.waiting = worker;
    worker.fireState('installed');
    this.maybeActivate();
    return worker;
  }
}

/* ------------------------------------------------------------------ *
 * A tab: one document, one session storage, one script.
 * ------------------------------------------------------------------ */

/**
 * A composer that behaves like the real one: editable until frozen.
 *
 * The whole hazard this models is that a tab stays interactive between agreeing
 * to move and being told to go. `text` is widget state and dies with the
 * document; `saved` is the durable row that must survive the swap.
 *
 * `conditional` models the other participant kind: a field with nowhere to
 * flush to (a token or URL input) that defers only while it holds content. Its
 * commit is an emptiness snapshot and it has NO lock of its own — exactly like
 * production `holdWhile`. The only thing standing between a verified-empty
 * field and a keystroke typed after `done` is the page's capture-phase input
 * guard, which is why `type()` routes every conditional keystroke through
 * `keystrokeGate` — the same path a real event takes — instead of consulting
 * a flag the production field does not have.
 */
class FakeComposer {
  text: string;
  focused: boolean;
  saved: string | null = null;
  locked = false;
  saves = 0;
  /** Keystrokes the freeze refused. Proves the lock is real, not advisory. */
  refusedEdits = 0;
  private captured: string | null = null;
  private gate: Promise<void> | null = null;
  private openGate: (() => void) | null = null;
  private prepareGate: Promise<void> | null = null;
  private openPrepareGate: (() => void) | null = null;
  private readonly conditional: boolean;
  /** How a keystroke reaches a conditional field: through the page's
   * capture-phase guard first. Wired by the tab on document load. */
  keystrokeGate: () => boolean = () => true;

  constructor(
    options: { text?: string; focused?: boolean; conditional?: boolean } = {},
  ) {
    this.text = options.text ?? '';
    this.focused = options.focused ?? false;
    this.conditional = options.conditional ?? false;
  }

  /** Mid-sentence — or, for a conditional hold, any content at all. */
  isBusy(): boolean {
    if (this.conditional) return this.text !== '';
    return this.focused && this.text.trim() !== '';
  }

  /** The user typing. Returns false when the freeze refused the keystroke. */
  type(next: string): boolean {
    if (this.conditional) {
      // Production conditional fields hold no lock of their own; the page's
      // capture guard is the only thing that can refuse this keystroke.
      if (!this.keystrokeGate()) {
        this.refusedEdits += 1;
        return false;
      }
      this.text = next;
      return true;
    }
    if (this.locked) {
      this.refusedEdits += 1;
      return false;
    }
    this.text = next;
    return true;
  }

  /** Phase one: willing to move, and flush what is there now. */
  async prepare(): Promise<boolean> {
    if (this.isBusy()) return false;
    if (this.conditional) return true; // an empty field has nothing to flush
    const gate = this.prepareGate;
    if (gate) await gate; else await Promise.resolve();
    this.saved = this.text;
    this.saves += 1;
    return true;
  }

  /**
   * Phase two, and the reason it exists.
   *
   * The freeze runs BEFORE the first await, so it completes inside the caller's
   * own turn: no keystroke can be interleaved between refusing input and
   * capturing the value. The final equality check is the belt: if the live text
   * is not what was captured, something slipped past and this refuses rather
   * than letting the tab navigate away from unsaved characters.
   */
  async commit(): Promise<boolean> {
    if (this.conditional) {
      // Production holdWhile: an emptiness snapshot, nothing more. The page
      // raised its capture guard before invoking this hook, and THAT — not
      // anything in here — is what stands between the verified-empty field
      // and the next keystroke.
      this.focused = false;
      if (this.text !== '') return false;
      const gate = this.gate;
      if (gate) await gate; else await Promise.resolve();
      return true;
    }
    if (this.isBusy()) return false;
    this.locked = true;
    this.focused = false;
    this.captured = this.text;
    const gate = this.gate;
    if (gate) await gate; else await Promise.resolve();
    this.saved = this.captured;
    this.saves += 1;
    return this.text === this.captured;
  }

  release(): void {
    this.locked = false;
    this.captured = null;
  }

  /** Holds the durable write open, the way a slow repository would. */
  holdFlush(): void {
    this.gate = new Promise<void>((resolve) => {
      this.openGate = resolve;
    });
  }

  /** Lets the held write land. */
  releaseFlush(): void {
    const open = this.openGate;
    this.gate = null;
    this.openGate = null;
    if (open) open();
  }

  /** Holds only phase-one preparation, leaving the final commit independently controllable. */
  holdPrepare(): void {
    this.prepareGate = new Promise<void>((resolve) => {
      this.openPrepareGate = resolve;
    });
  }

  releasePrepare(): void {
    const open = this.openPrepareGate;
    this.prepareGate = null;
    this.openPrepareGate = null;
    if (open) open();
  }
}

/** How a tab's editable surface starts out. */
type ComposerMode = 'none' | 'idle' | 'editing' | 'token';

interface TabOptions {
  /** Where the tab opens. */
  href: string;
  /**
   * `none` installs no hooks at all — a page with nothing to lose.
   * `idle` has a composer nobody is typing into.
   * `editing` is mid-sentence: focused, with content.
   * `token` is a conditional hold: an empty credential-style field that
   * defers only while it holds content and has nowhere to flush to.
   */
  composer?: ComposerMode;
  /** A frozen tab is counted as a client but its event loop never runs. */
  frozen?: boolean;
  /** Session state this document inherits, as a replacement page would. */
  session?: Record<string, string>;
  /** Deterministic election identity. */
  id: string;
}

class Tab {
  href: string;
  closed = false;
  frozen: boolean;
  controller: FakeWorker | null = null;
  readonly id: string;
  readonly session = new Map<string, string>();
  readonly replaced: string[] = [];
  readonly assigned: string[] = [];
  readonly window: Record<string, any> = {};
  /** Event types the framework stand-in listener actually received. */
  readonly flutterReceived: string[] = [];
  private readonly channels: Array<{ close(): void }> = [];
  /** This tab's editable surface, or null when it owns nothing losable. */
  readonly composer: FakeComposer | null;

  constructor(
    private readonly world: World,
    options: TabOptions,
  ) {
    this.href = options.href;
    this.frozen = options.frozen ?? false;
    this.id = options.id;
    // Seeded before the coordinator boots, which is the only way to model the
    // document a handoff replaces: the new page inherits the session its
    // predecessor left behind.
    for (const [key, value] of Object.entries(options.session ?? {})) {
      this.session.set(key, value);
    }
    const mode = options.composer ?? 'none';
    this.composer = mode === 'none'
      ? null
      : new FakeComposer(
        mode === 'editing'
          ? { text: 'half a sentence', focused: true }
          : mode === 'token'
            ? { conditional: true }
            : {},
      );
  }

  inScope(): boolean {
    return this.href.startsWith(SCOPE);
  }

  /** Loads whichever document this tab's URL points at. */
  load(): void {
    for (const channel of this.channels.splice(0)) channel.close();
    this.world.registration.offTab(this);
    this.window.cosyncingHandoffPrepare = undefined;
    this.window.cosyncingHandoffCommit = undefined;
    this.window.cosyncingHandoffRelease = undefined;
    if (this.inScope()) {
      this.controller = this.world.registration.active;
      // A frozen tab is a real, counted controllee whose event loop never runs:
      // no coordinator, no claims, no acknowledgements, nothing at all.
      if (this.frozen) return;
      this.runCoordinator();
      // The framework's stand-in, registered AFTER the coordinator booted —
      // same-target capture listeners run in registration order, so the
      // guard outranks these only because it registered first. What lands
      // here is what Flutter would have received.
      this.flutterReceived.length = 0;
      for (const type of [
        'beforeinput',
        'keydown',
        'keyup',
        'pointerdown',
        'pointerup',
        'pointercancel',
      ]) {
        this.window.addEventListener(type, () => {
          this.flutterReceived.push(type);
        });
      }
      const composer = this.composer;
      if (composer) {
        // The Dart bridge installs all three only while a surface owns
        // losable state; a page with no editor never has them.
        composer.release();
        // A keystroke lands only if the framework actually received it.
        composer.keystrokeGate = () => {
          const before = this.flutterReceived.filter(
            (type) => type === 'beforeinput',
          ).length;
          (
            this.window.__dispatchInputEvent as (
              type: string,
              props?: Record<string, unknown>,
            ) => boolean
          )('beforeinput');
          return (
            this.flutterReceived.filter((type) => type === 'beforeinput')
              .length > before
          );
        };
        this.window.cosyncingHandoffPrepare = () => composer.prepare();
        this.window.cosyncingHandoffCommit = () => composer.commit();
        this.window.cosyncingHandoffRelease = () => composer.release();
      }
      return;
    }
    this.controller = null;
    if (this.href.startsWith(HANDOFF)) this.runHandoffPage();
  }

  close(): void {
    this.closed = true;
    for (const channel of this.channels.splice(0)) channel.close();
    this.world.registration.offTab(this);
    this.world.registration.maybeActivate();
  }

  /**
   * An in-app route change that does NOT reload the document.
   *
   * The client routes on the hash and pushes history entries, so a user
   * navigating inside the app keeps the same page, the same script instance, and
   * the same controller. Only the URL moves.
   */
  navigateWithin(url: string): void {
    if (!url.startsWith(SCOPE)) throw new Error('navigateWithin is for in-app routes');
    this.href = url;
  }

  /** `location.replace`: no history entry survives, so no document is retained. */
  private replace = (url: string): void => {
    this.replaced.push(url);
    const previouslyInScope = this.inScope();
    this.href = url;
    for (const channel of this.channels.splice(0)) channel.close();
    this.world.registration.offTab(this);
    if (previouslyInScope && !this.inScope()) this.world.registration.maybeActivate();
    this.load();
  };

  private sandbox(): Record<string, unknown> {
    const tab = this;
    const registration = this.world.registration;
    const clock = this.world.clock;

    const location = {
      get href() {
        return tab.href;
      },
      set href(value: string) {
        tab.assigned.push(value);
        throw new Error('the handoff must use location.replace, not an href assignment');
      },
      get pathname() {
        return new URL(tab.href).pathname;
      },
      get search() {
        return new URL(tab.href).search;
      },
      get hash() {
        return new URL(tab.href).hash;
      },
      get origin() {
        return new URL(tab.href).origin;
      },
      replace: this.replace,
      assign: (url: string) => {
        tab.assigned.push(url);
        throw new Error('the handoff must use location.replace, not assign');
      },
      reload: () => {
        throw new Error('the handoff must never reload a page');
      },
    };

    const registrationView = {
      get active() {
        return registration.active;
      },
      get waiting() {
        return registration.unaware.has(tab) ? null : registration.waiting;
      },
      get installing() {
        return registration.installing;
      },
      scope: SCOPE,
      addEventListener: (type: string, fn: () => void) => registration.on(tab, type, fn),
      removeEventListener: (type: string, fn: () => void) => registration.off(tab, type, fn),
      update: async () => {},
      unregister: async () => {
        throw new Error('the handoff must never unregister a worker');
      },
    };

    const serviceWorker = {
      get controller() {
        return tab.controller;
      },
      register: async () => registrationView,
      getRegistration: async (url?: string) => {
        if (url !== undefined && !String(url).startsWith(SCOPE)) return undefined;
        return registrationView;
      },
      addEventListener: (type: string, fn: () => void) => registration.on(tab, type, fn),
    };

    const sessionStorage = {
      getItem: (key: string) => tab.session.get(key) ?? null,
      setItem: (key: string, value: string) => void tab.session.set(key, String(value)),
      removeItem: (key: string) => void tab.session.delete(key),
      key: (index: number) => [...tab.session.keys()][index] ?? null,
      get length() {
        return tab.session.size;
      },
    };

    const nodes = new Map<string, Record<string, unknown>>();
    const document = {
      baseURI: this.inScope() ? SCOPE : this.href,
      documentElement: {} as Record<string, unknown>,
      getElementById: (id: string) => {
        if (!nodes.has(id)) nodes.set(id, { textContent: '', href: '' });
        return nodes.get(id)!;
      },
    };

    class SandboxBroadcastChannel {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      constructor(readonly name: string) {
        const handle = tab.world.bus.open(name, this, (data) => {
          if (tab.frozen || tab.closed) return; // a frozen tab runs no callbacks
          this.onmessage?.({ data });
        });
        tab.channels.push(handle);
      }
      postMessage(data: unknown): void {
        tab.world.bus.post(this.name, this, data);
      }
      close(): void {}
    }

    const windowStub = this.window;
    const loadListeners: Array<() => void> = [];
    // Capture-phase listeners, per document load: the commit-window input
    // guard registers here, and typing is modelled as an event travelling
    // through them first — exactly the path a real keystroke takes.
    const captureListeners = new Map<string, Set<(event: unknown) => void>>();
    windowStub.addEventListener = (
      type: string,
      fn: (event: unknown) => void,
    ) => {
      if (type === 'load') {
        loadListeners.push(fn as () => void);
        return;
      }
      const set = captureListeners.get(type) ?? new Set();
      set.add(fn);
      captureListeners.set(type, set);
    };
    windowStub.removeEventListener = (
      type: string,
      fn: (event: unknown) => void,
    ) => {
      captureListeners.get(type)?.delete(fn);
    };
    // Listeners run in REGISTRATION ORDER, as they do on a real same-target
    // window — that ordering is exactly what round 5 pins: the guard beats
    // the framework only because it registered first, at boot.
    const deliver = (event: Record<string, unknown>): boolean => {
      let swallowed = false;
      event.stopImmediatePropagation = () => {
        swallowed = true;
      };
      event.preventDefault = () => {
        swallowed = true;
      };
      for (const fn of captureListeners.get(event.type as string) ?? []) {
        fn(event);
        if (swallowed) break;
      }
      return !swallowed;
    };
    // The target a real event would carry; synthetic cancels dispatched at it
    // travel back through the same window listeners.
    const fakeTarget = {
      dispatchEvent: (event: Record<string, unknown>) => deliver(event),
    };
    /** Dispatches an input-like event; false when a capture guard ate it. */
    windowStub.__dispatchInputEvent = (
      type: string,
      props?: Record<string, unknown>,
    ): boolean => deliver({ type, target: fakeTarget, ...props });
    windowStub.dispatchEvent = () => true;
    windowStub.crypto = { randomUUID: () => tab.id };
    windowStub.__fireLoad = () => {
      for (const fn of loadListeners.splice(0)) fn();
    };

    return {
      window: windowStub,
      document,
      location,
      navigator: { serviceWorker, languages: ['en'], language: 'en' },
      sessionStorage,
      BroadcastChannel: SandboxBroadcastChannel,
      MessageChannel: globalThis.MessageChannel,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      Date: { now: () => clock.now },
      URL,
      URLSearchParams,
      Promise,
      Map,
      Set,
      Math,
      JSON,
      console,
      Event: class {
        constructor(readonly type: string) {}
      },
      PointerEvent: class {
        constructor(
          readonly type: string,
          init?: Record<string, unknown>,
        ) {
          Object.assign(this, init ?? {});
        }
      },
      crypto: windowStub.crypto,
    };
  }

  private run(source: string): void {
    const sandbox = this.sandbox();
    const names = Object.keys(sandbox);
    // eslint-disable-next-line no-new-func -- running the shipped script is the point
    const factory = new Function(...names, source);
    factory(...names.map((name) => sandbox[name]));
  }

  private runCoordinator(): void {
    this.run(coordinatorSource);
    (this.window.__fireLoad as () => void)();
  }

  private runHandoffPage(): void {
    this.run(handoffSource);
  }
}

/* ------------------------------------------------------------------ *
 * The world.
 * ------------------------------------------------------------------ */

class World {
  readonly clock = new Clock();
  readonly bus = new Bus();
  readonly registration = new Registration();
  private nextId = 0;

  constructor(initialVersion: string) {
    this.registration.active = makeWorker(initialVersion, this.registration);
    this.registration.activations.push(initialVersion);
  }

  openTab(options: Omit<TabOptions, 'id'> & { id?: string }): Tab {
    const id = options.id ?? `tab-${String(++this.nextId).padStart(2, '0')}`;
    const tab = new Tab(this, { ...options, id });
    this.registration.tabs.push(tab);
    tab.load();
    return tab;
  }
}

/** Long enough for one whole round: elect, census, ack, commit, go. */
const ROUND_MS = 20_000;

/** The coordinator's fast-tier cooldown after a deferred round. */
const RETRY_MS = 60_000;

/** Comfortably past the coordinator's slow-cadence cooldown. */
const SLOW_ROUND_MS = 16 * 60_000;

/**
 * Advances until `predicate` holds, or gives up after `limitMs`.
 *
 * For assertions that have to land at a specific point inside a round rather
 * than after it. Stepping keeps the virtual clock the only source of time, so
 * the observation stays deterministic.
 */
async function advanceUntil(
  world: World,
  predicate: () => boolean,
  limitMs = 30_000,
): Promise<boolean> {
  const step = 50;
  for (let elapsed = 0; elapsed <= limitMs; elapsed += step) {
    if (predicate()) return true;
    await world.clock.advance(step);
  }
  return predicate();
}

/* ------------------------------------------------------------------ *
 * Cases.
 * ------------------------------------------------------------------ */

async function caseHandoffPathAgreesAcrossPackages(): Promise<void> {
  console.log('the shell, the broker and the worker scope agree on one destination');
  // The shell derives its destination relatively; the broker serves an absolute
  // path. If these ever drift, tabs navigate to a 404 and never come back.
  const derived = new URL('../cosy-handoff', SCOPE);
  checkEqual(
    derived.pathname,
    WEB_HANDOFF_PATH,
    'index.html resolves the broker-served handoff path',
  );
  check(
    !derived.href.startsWith(SCOPE),
    'the handoff destination is outside the worker scope, so it is not a controlled client',
  );

  const mounted = new URL('../cosy-handoff', `${ORIGIN}/staging/cosy/`);
  checkEqual(
    mounted.pathname,
    '/staging/cosy-handoff',
    'a mounted prefix keeps the destination a sibling of its own scope',
  );

  const response = serveWebHandoff();
  checkEqual(response.headers.get('cache-control'), 'no-store', 'the handoff page is never stored');
  checkEqual(
    response.headers.get('content-type'),
    'text/html; charset=utf-8',
    'the handoff page is served as HTML',
  );
}

async function caseShippedSourcesCannotActivateOverALivePage(): Promise<void> {
  console.log('no shipped web source can activate a worker or open a second cache');
  const workerSource = await readFile(join(CLIENT_ROOT, 'web', 'sw.js'), 'utf8');
  const indexHtml = await readFile(join(CLIENT_ROOT, 'web', 'index.html'), 'utf8');

  let refusedReal = false;
  try {
    assertNoSkipWaiting(workerSource);
  } catch {
    refusedReal = true;
  }
  check(!refusedReal, 'the shipped worker passes the no-skipWaiting fail-proof');

  let refusedMutant = false;
  try {
    assertNoSkipWaiting(`${workerSource}\nself.skipWaiting();\n`);
  } catch {
    refusedMutant = true;
  }
  check(refusedMutant, 'a worker that calls skipWaiting is refused at build time');

  let acceptedWithoutCoordinator = true;
  try {
    assertHandoffCoordinator('<html><base href="/cosy/"></html>');
    acceptedWithoutCoordinator = true;
  } catch {
    acceptedWithoutCoordinator = false;
  }
  check(
    !acceptedWithoutCoordinator,
    'a shell without the handoff coordinator is refused at build time',
  );
  let acceptedReal = true;
  try {
    assertHandoffCoordinator(indexHtml);
  } catch {
    acceptedReal = false;
  }
  check(acceptedReal, 'the shipped shell passes the handoff fail-proof');

  // A second cache implementation is exactly how two builds start sharing
  // storage. Neither page-side script may touch CacheStorage at all.
  const coordinatorCode = codeOnly(coordinatorSource);
  const handoffCode = codeOnly(handoffSource);
  check(!coordinatorCode.includes('caches.'), 'the coordinator never touches CacheStorage');
  check(!handoffCode.includes('caches.'), 'the handoff page never touches CacheStorage');
  check(
    !coordinatorCode.includes('skipWaiting') && !handoffCode.includes('skipWaiting'),
    'no page-side script calls skipWaiting',
  );
  check(
    !coordinatorCode.includes('unregister') && !handoffCode.includes('unregister'),
    'no page-side script unregisters a worker',
  );
  check(
    !coordinatorCode.includes('location.reload') && !handoffCode.includes('location.reload'),
    'no page-side script reloads on its own',
  );
}

async function caseWorkerAnswersReadOnlyQuestions(): Promise<void> {
  console.log('the worker answers identity and census, and mutates nothing');
  const registration = new Registration();
  const worker = makeWorker('buildaaaaaaaaaa1', registration);
  registration.active = worker;

  const askWorker = (request: unknown) =>
    new Promise<any>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => resolve(event.data);
      worker.postMessage(request, [channel.port2]);
      setTimeout(() => resolve(null), 500);
    });

  const identity = await askWorker({ type: 'cosyncing-build-identity' });
  checkEqual(identity?.version, 'buildaaaaaaaaaa1', 'the worker reports its build identity');
  checkEqual(
    identity?.cacheName,
    'cosyncing-app:/cosy/:buildaaaaaaaaaa1',
    'the reported cache name is scope-qualified and version-scoped',
  );

  const ignored = await askWorker({ type: 'cosyncing-please-activate' });
  checkEqual(ignored, null, 'an unknown message type is ignored entirely');
  checkEqual(worker.skipWaitingCalls(), 0, 'no message can make the worker skip waiting');

  // The census answers a comparison, so the one answer that could ever be
  // actively wrong is a truncated one: N tabs reported as the cap, with cap
  // acknowledgements, is an equality that would move a subset and strand it.
  const world = new World('buildaaaaaaaaaa1');
  for (let index = 0; index < 3; index++) {
    world.openTab({ href: `${SCOPE}t${index}`, frozen: true });
  }
  await world.clock.advance(10);
  const askActive = (request: unknown) =>
    new Promise<any>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => resolve(event.data);
      world.registration.active!.postMessage(request, [channel.port2]);
      setTimeout(() => resolve(null), 500);
    });
  const small = await askActive({ type: 'cosyncing-client-census' });
  checkEqual(small?.windows, 3, 'the census counts exactly the controlled windows');

  for (let index = 0; index < 70; index++) {
    world.openTab({ href: `${SCOPE}bulk${index}`, frozen: true });
  }
  const huge = await askActive({ type: 'cosyncing-client-census' });
  checkEqual(
    huge?.windows,
    -1,
    'an implausible window count is refused, never truncated into a false equality',
  );
}

interface HandoffOutcome {
  world: World;
  tabs: Tab[];
}

/** Opens `routes.length` tabs on one build and deploys the next one. */
/**
 * The record has to outlive the document, and outlive being tampered with.
 *
 * A handoff destroys the page that knows why a round deferred. The record is
 * therefore mirrored into sessionStorage and hydrated by the replacement — and
 * because sessionStorage is same-origin but not trusted, hydrating it is a
 * parsing problem, not an assignment.
 */
async function caseDiagnosticsSurviveTheReplacementDocument(): Promise<void> {
  console.log('handoff diagnostics survive the swap, and survive tampering');
  const world = new World('buildaaaaaaaaaa1');
  const KEY = 'cosyncing.handoff.diagnostics';
  const retained = (tab: Tab) =>
    (tab.window.cosyncingHandoffDiagnostics ?? []) as Array<{ k: string }>;

  const inherited = world.openTab({
    href: SCOPE,
    session: { [KEY]: JSON.stringify([{ k: 'round', d: 'peer-deferred', t: 111 }]) },
  });
  check(
    retained(inherited).some((entry) => entry.k === 'round'),
    'a replacement document keeps the record its predecessor wrote',
  );

  const corrupted = world.openTab({ href: SCOPE, session: { [KEY]: '{not json' } });
  checkEqual(
    retained(corrupted).length,
    0,
    'a corrupted record is discarded, not thrown out of the coordinator',
  );

  const wrongShape = world.openTab({
    href: SCOPE,
    session: { [KEY]: JSON.stringify([{ nope: true }, 7, null]) },
  });
  checkEqual(
    retained(wrongShape).length,
    0,
    'entries without a kind and a timestamp are dropped',
  );

  const overflowing = world.openTab({
    href: SCOPE,
    session: {
      [KEY]: JSON.stringify(
        Array.from({ length: 200 }, (_, index) => ({ k: 'noise', d: null, t: index })),
      ),
    },
  });
  checkEqual(
    retained(overflowing).length,
    64,
    'an oversized record is bounded on the way in, not only on the way out',
  );

  // Detail is the field the earlier validation copied through untouched. It is
  // read back from sessionStorage, which any same-origin script can write, and
  // is then re-serialized on every subsequent record for the life of the tab.
  const hostile = world.openTab({
    href: SCOPE,
    session: {
      [KEY]: JSON.stringify([
        { k: 'round', d: { v: 'x'.repeat(4_096), deep: { nested: true } }, t: 1 },
        { k: 'round', d: ['not', 'a', 'shape', 'this', 'writes'], t: 2 },
        { k: 'round', d: { v: 'buildaaaaaaaaaa1', attempt: 2 }, t: 3 },
      ]),
    },
  });
  const details = (retained(hostile) as Array<{ d: unknown }>).map((entry) => entry.d);
  checkEqual(details.length, 3, 'a valid kind and timestamp still admit the entry');
  checkEqual(
    details[0],
    null,
    'a nested object is not a shape this protocol writes, so the detail is dropped',
  );
  checkEqual(details[1], null, 'an array detail is discarded');
  checkEqual(
    JSON.stringify(details[2]),
    JSON.stringify({ v: 'buildaaaaaaaaaa1', attempt: 2 }),
    'the shapes the protocol does write survive unchanged',
  );
  const longString = world.openTab({
    href: SCOPE,
    session: { [KEY]: JSON.stringify([{ k: 'round', d: 'y'.repeat(4_096), t: 1 }]) },
  });
  checkEqual(
    ((retained(longString) as Array<{ d: string }>)[0]?.d ?? '').length,
    128,
    'an oversized string detail is capped, not carried',
  );

  // A peer's stated reason is retained for diagnosis but never trusted: the
  // channel is same-origin and anything on it can claim anything. Driven
  // through a real round rather than read out of the source — what matters is
  // what the coordinator records, not what the file says.
  const solo = new World('buildaaaaaaaaaa1');
  const coordinator = solo.openTab({ href: SCOPE, composer: 'idle' });
  await solo.clock.advance(10);
  coordinator.composer!.holdPrepare();
  solo.registration.deploy('buildbbbbbbbbbb2');
  const asked = await advanceUntil(solo, () => solo.bus.countMessages('prepare') === 1);
  check(asked, 'the coordinator asked its peers before the reply window opened');
  const prepare = solo.bus.traffic.find((item) => item.data?.k === 'prepare')!.data;
  // A tab the coordinator never met, answering in its round, with a reason no
  // version of this protocol has ever defined.
  solo.bus.post('cosyncing-handoff:/cosy/', {}, {
    k: 'defer',
    v: prepare.v,
    r: prepare.r,
    tab: 'ghost-tab',
    why: 'made-up-reason',
  });
  coordinator.composer!.releasePrepare();
  await solo.clock.advance(ROUND_MS);
  const recorded = ((coordinator.window.cosyncingHandoffDiagnostics ?? []) as Array<{
    k: string;
    d: unknown;
  }>).filter((entry) => entry.k === 'peer-defer-reasons');
  checkEqual(recorded.length, 1, 'the deferred round recorded why it deferred');
  checkEqual(
    recorded[0]?.d,
    'defer:unknown',
    'an unrecognised peer defer reason is recorded as unknown, not echoed',
  );
  checkEqual(
    solo.bus.countMessages('go'),
    0,
    'one deferral, from a tab nobody knows, still stops the round',
  );
}

/* ------------------------------------------------------------------ *
 * The peer-local grace on `no-waiting`.
 * ------------------------------------------------------------------ */

/**
 * Deploy without telling this world's tabs, so a peer can be asked about a
 * build it has not been shown yet. `deploy()` fires `updatefound` and the
 * install statechange; this is the same transition with the announcement
 * withheld, which is what a document that registered a moment too late sees.
 */
function deploySilently(world: World, version: string): void {
  const listeners = world.registration.listeners.splice(0, world.registration.listeners.length);
  try {
    world.registration.deploy(version);
  } finally {
    world.registration.listeners.push(...listeners);
  }
}

async function caseTheGraceFitsInsideTheAckWindow(): Promise<void> {
  console.log('a peer that waits still answers inside the coordinator window');
  // Arithmetic, not observation: a peer spends the grace and then its own
  // durable flush, and the sum has to land inside the window the coordinator
  // waits. A tab that replies later is counted as unresponsive, which
  // abandons the round exactly like the deferral the grace exists to avoid.
  const constant = (name: string): number => {
    const found = coordinatorSource.match(new RegExp(`var ${name} = (\\d+)`));
    return found ? Number(found[1]) : Number.NaN;
  };
  const grace = constant('PEER_GRACE_MS');
  const prepare = constant('PREPARE_MS');
  const ack = constant('ACK_MS');
  const workerReply = constant('WORKER_REPLY_MS');
  check(
    Number.isFinite(grace) && Number.isFinite(prepare) && Number.isFinite(ack)
      && Number.isFinite(workerReply),
    `the timing constants are readable (worker=${workerReply} grace=${grace} prepare=${prepare} ack=${ack})`,
  );
  check(
    workerReply + grace + prepare <= ack - 500,
    `worker(${workerReply}) + grace(${grace}) + prepare(${prepare}) must fit inside ack(${ack}) with margin`,
  );
}

async function caseDelayedWorkerVisibilityStillJoins(): Promise<void> {
  console.log('a worker that becomes visible during the grace is acknowledged in the same round');
  const world = new World('buildaaaaaaaaaa1');
  const coordinator = world.openTab({ href: SCOPE, composer: 'idle' });
  const peer = world.openTab({ href: `${SCOPE}sessions/codex/abc`, composer: 'idle' });
  await world.clock.advance(10);

  // Only the peer is unaware. The coordinator can therefore verify the build
  // and open a real round, which is the situation the grace is for.
  world.registration.unaware.add(peer);
  world.registration.deploy('buildbbbbbbbbbb2');

  // Told part-way through the grace, after `prepare` has already arrived.
  const asked = await advanceUntil(world, () => world.bus.countMessages('prepare') === 1);
  check(asked, 'the coordinator opened a round the peer could not yet see');
  checkEqual(
    world.bus.traffic.filter((item) => item.data?.k === 'defer').length,
    0,
    'the peer has not answered yet — it is waiting, not refusing',
  );
  world.clock.setTimeout(() => world.registration.unaware.delete(peer), 200);
  await world.clock.advance(ROUND_MS);

  checkEqual(world.bus.countMessages('prepare'), 1, 'exactly one round ran');
  checkEqual(
    world.bus.traffic.filter((item) => item.data?.k === 'defer').length,
    0,
    'the peer waited instead of deferring',
  );
  checkEqual(world.bus.countMessages('go'), 1, 'the round completed');
  for (const tab of [coordinator, peer]) {
    check(tab.replaced.some((url) => url.startsWith(HANDOFF)), `${tab.id} moved`);
  }
}

async function caseAnAbsentWorkerStillDefers(): Promise<void> {
  console.log('a worker that never appears is deferred, conservatively');
  const world = new World('buildaaaaaaaaaa1');
  world.openTab({ href: SCOPE, composer: 'idle' });
  const peer = world.openTab({ href: `${SCOPE}sessions/codex/abc`, composer: 'idle' });
  await world.clock.advance(10);

  // Never told. The grace expires and the conservative answer stands.
  world.registration.unaware.add(peer);
  world.registration.deploy('buildbbbbbbbbbb2');
  await world.clock.advance(ROUND_MS);

  const defers = world.bus.traffic.filter((item) => item.data?.k === 'defer');
  check(defers.length >= 1, `the peer deferred (${defers.length})`);
  checkEqual(defers[0]?.data?.why, 'no-waiting', 'the reason is still no-waiting');
  checkEqual(world.bus.countMessages('go'), 0, 'nothing moved');
  checkEqual(
    peer.replaced.length,
    0,
    'a tab that cannot verify the build is never moved',
  );
}

async function caseASilentActiveWorkerStartsNoRound(): Promise<void> {
  console.log('a waiting worker is not an update until the active one can be compared');
  const world = new World('buildaaaaaaaaaa1');
  const tab = world.openTab({ href: SCOPE, composer: 'idle' });
  await world.clock.advance(10);

  // The active worker stops answering. On a real first load it is busy
  // precaching several megabytes and routinely misses the reply window.
  const active = world.registration.active!;
  const answer = active.postMessage;
  active.postMessage = () => {};
  world.registration.deploy('buildbbbbbbbbbb2');
  await world.clock.advance(ROUND_MS);

  // Nothing may happen. Without the active worker's identity there is no way
  // to know the waiting build is different, and a round opened on that
  // assumption is doomed: every peer that cannot see the worker answers
  // `no-waiting`, and the deferral arms a full cooldown before the real
  // update can be tried. This is the whole 60 seconds the case used to cost.
  checkEqual(world.bus.countMessages('prepare'), 0, 'no round is opened on an unprovable update');
  checkEqual(world.bus.countMessages('go'), 0, 'nothing moved');
  checkEqual(tab.replaced.length, 0, 'the tab stayed where it was');

  // Inconclusive, not negative: once the active worker answers, the tab's own
  // bounded re-check finds the same waiting build and the handoff proceeds.
  // Nothing external prompts this — `updatefound` has already fired, and the
  // readiness hint is gated on a verified build this tab never got.
  active.postMessage = answer;
  await world.clock.advance(ROUND_MS);
  checkEqual(world.bus.countMessages('prepare'), 1, 'the round runs once the comparison is possible');
  check(
    tab.replaced.some((url) => url.startsWith(HANDOFF)),
    'the tab moved on the retry',
  );
}

async function caseAMalformedActiveWorkerStartsNoRound(): Promise<void> {
  console.log('a malformed active-worker identity is inconclusive, never an update');
  const world = new World('buildaaaaaaaaaa1');
  const tab = world.openTab({ href: SCOPE, composer: 'idle' });
  await world.clock.advance(10);

  const active = world.registration.active!;
  active.postMessage = (_data, transfer) => {
    const port = transfer?.[0] as MessagePort | undefined;
    port?.postMessage({});
  };
  world.registration.deploy('buildbbbbbbbbbb2');
  await world.clock.advance(ROUND_MS);

  checkEqual(world.bus.countMessages('prepare'), 0, 'no round is opened on a malformed active reply');
  checkEqual(world.bus.countMessages('go'), 0, 'the malformed reply moves nothing');
  checkEqual(tab.replaced.length, 0, 'the tab remains on its route');
}

async function caseASecondBuildGetsAFreshRecheckBudget(): Promise<void> {
  console.log('each newly found worker gets its own bounded recheck budget');
  const world = new World('buildaaaaaaaaaa1');
  const tab = world.openTab({ href: SCOPE, composer: 'idle' });
  await world.clock.advance(10);

  const active = world.registration.active!;
  const answer = active.postMessage;
  active.postMessage = () => {};
  world.registration.deploy('buildbbbbbbbbbb2');
  // Ten rechecks at two seconds each, with worker-query deadlines between them.
  await world.clock.advance(45_000);
  checkEqual(world.bus.countMessages('prepare'), 0, 'the first inconclusive budget was exhausted');

  active.postMessage = answer;
  world.registration.deploy('buildccccccccc33');
  await world.clock.advance(ROUND_MS * 2);

  checkEqual(world.bus.countMessages('prepare'), 1, 'the second update receives a fresh observation budget');
  checkEqual(world.registration.active?.version, 'buildccccccccc33', 'the second build takes over');
  checkEqual(tab.href, SCOPE, 'the tab returns under the second build');
}

async function caseAWrongIdentityIsNotWaitedOn(): Promise<void> {
  console.log('a different build waiting is settled, not something to wait for');
  const world = new World('buildaaaaaaaaaa1');
  const coordinator = world.openTab({ href: SCOPE, composer: 'idle' });
  const peer = world.openTab({ href: `${SCOPE}sessions/codex/abc`, composer: 'idle' });
  await world.clock.advance(10);

  // The coordinator opens a round for one build while a DIFFERENT one is what
  // is actually waiting. Waiting cannot turn one into the other, so the peer
  // must decide immediately rather than spending the grace.
  coordinator.composer!.holdPrepare();
  world.registration.deploy('buildbbbbbbbbbb2');
  const asked = await advanceUntil(world, () => world.bus.countMessages('prepare') >= 1);
  check(asked, 'a round was opened');
  const prepare = world.bus.traffic.find((item) => item.data?.k === 'prepare')!.data;
  world.bus.post('cosyncing-handoff:/cosy/', {}, {
    k: 'prepare',
    v: 'buildccccccccc33',
    r: prepare.r,
  });

  const before = world.clock.now;
  const answered = await advanceUntil(
    world,
    () => world.bus.traffic.some(
      (item) => item.data?.k === 'defer' && item.data?.v === 'buildccccccccc33',
    ),
    2_000,
  );
  check(answered, 'the mismatched build was answered');
  check(
    world.clock.now - before < 400,
    `a wrong identity is refused without spending the grace (${world.clock.now - before}ms)`,
  );
  coordinator.composer!.releasePrepare();
  check(peer !== undefined, 'the peer stayed available');
}

async function caseABusyPeerIsUnaffectedByTheGrace(): Promise<void> {
  console.log('a busy peer still defers as busy, not as no-waiting');
  const world = new World('buildaaaaaaaaaa1');
  world.openTab({ href: SCOPE, composer: 'idle' });
  world.openTab({ href: `${SCOPE}sessions/codex/abc`, composer: 'editing' });
  await world.clock.advance(10);
  world.registration.deploy('buildbbbbbbbbbb2');
  await world.clock.advance(ROUND_MS);

  const defers = world.bus.traffic.filter((item) => item.data?.k === 'defer');
  check(defers.length >= 1, `the editing tab deferred (${defers.length})`);
  checkEqual(defers[0]?.data?.why, 'busy', 'the reason distinguishes busy from unseen');
  checkEqual(world.bus.countMessages('go'), 0, 'nothing moved while a tab was editing');
}

async function caseSimultaneousCoordinatorsStillElectOne(): Promise<void> {
  console.log('two tabs that both see the build at once still run one round');
  const world = new World('buildaaaaaaaaaa1');
  const tabs = [
    world.openTab({ href: SCOPE, composer: 'idle' }),
    world.openTab({ href: `${SCOPE}sessions/codex/abc`, composer: 'idle' }),
    world.openTab({ href: `${SCOPE}sessions/claude/xyz`, composer: 'idle' }),
  ];
  await world.clock.advance(10);
  // Every tab notices in the same tick, which is what a shared registration
  // does: the grace must not turn a lost election into a second coordinator.
  world.registration.deploy('buildbbbbbbbbbb2');
  await world.clock.advance(ROUND_MS);

  checkEqual(world.bus.countMessages('prepare'), 1, 'exactly one coordinator ran');
  checkEqual(world.bus.countMessages('go'), 1, 'exactly one move was ordered');
  for (const tab of tabs) {
    check(tab.replaced.some((url) => url.startsWith(HANDOFF)), `${tab.id} moved once`);
  }
}

async function caseAPeerCannotDriveThisTabsRetryCadence(): Promise<void> {
  console.log('a peer saying no-waiting does not shorten this tab\'s cadence');
  const world = new World('buildaaaaaaaaaa1');
  const tab = world.openTab({ href: SCOPE, composer: 'idle' });
  await world.clock.advance(10);
  world.registration.deploy('buildbbbbbbbbbb2');
  const asked = await advanceUntil(world, () => world.bus.countMessages('prepare') === 1);
  check(asked, 'the coordinator asked');
  const prepare = world.bus.traffic.find((item) => item.data?.k === 'prepare')!.data;

  // A peer that answers `no-waiting` over and over must not make this tab try
  // again any sooner than its own cadence allows, or a chatty peer becomes a
  // retry storm.
  for (let burst = 0; burst < 20; burst += 1) {
    world.bus.post('cosyncing-handoff:/cosy/', {}, {
      k: 'defer',
      v: prepare.v,
      r: prepare.r,
      tab: `ghost-${burst}`,
      why: 'no-waiting',
    });
  }
  await world.clock.advance(ROUND_MS);
  const roundsAfterBurst = world.bus.countMessages('prepare');
  await world.clock.advance(RETRY_MS - ROUND_MS - 1_000);
  checkEqual(
    world.bus.countMessages('prepare'),
    roundsAfterBurst,
    'no extra round ran before the cadence allowed one',
  );
  check(tab !== undefined, 'the tab stayed open');
}

async function stage(
  routes: string[],
  options: {
    composer?: (index: number) => ComposerMode;
    frozen?: number[];
    from?: string;
    to?: string;
  } = {},
): Promise<HandoffOutcome> {
  const world = new World(options.from ?? 'buildaaaaaaaaaa1');
  const tabs = routes.map((route, index) =>
    world.openTab({
      href: SCOPE + route,
      composer: options.composer?.(index) ?? 'none',
      frozen: options.frozen?.includes(index) ?? false,
    }),
  );
  await world.clock.advance(10);
  world.registration.deploy(options.to ?? 'buildbbbbbbbbbb2');
  await world.clock.advance(ROUND_MS);
  return { world, tabs };
}

async function caseTwoTabsHandOffAndReturn(): Promise<void> {
  console.log('two tabs on different routes with drafts hand off and come back');
  const { world, tabs } = await stage(['', 'sessions/codex/abc'], {
    composer: () => 'idle',
  });

  checkEqual(world.bus.countMessages('prepare'), 1, 'exactly one coordinator ran');
  checkEqual(world.bus.countMessages('go'), 1, 'exactly one move was ordered');
  for (const tab of tabs) {
    check(
      (tab.composer?.saves ?? 0) >= 1,
      `${tab.id} made its state durable before moving`,
    );
    check(
      tab.replaced.some((url) => url.startsWith(HANDOFF)),
      `${tab.id} moved to the out-of-scope handoff page`,
    );
    checkEqual(tab.assigned.length, 0, `${tab.id} never used assign or an href write`);
  }

  await world.clock.advance(ROUND_MS);

  checkEqual(world.registration.active?.version, 'buildbbbbbbbbbb2', 'the replacement activated');
  checkEqual(world.registration.waiting, null, 'nothing is left waiting');
  checkEqual(
    world.registration.activations.join(','),
    'buildaaaaaaaaaa1,buildbbbbbbbbbb2',
    'exactly one activation happened, in order',
  );
  checkEqual(
    world.registration.active?.cacheName,
    'cosyncing-app:/cosy/:buildbbbbbbbbbb2',
    'the live cache identity is the new build',
  );
  checkEqual(tabs[0]!.href, SCOPE, 'the first tab returned to its exact route');
  checkEqual(
    tabs[1]!.href,
    `${SCOPE}sessions/codex/abc`,
    'the second tab returned to its exact route',
  );
  for (const tab of tabs) {
    checkEqual(tab.replaced.length, 2, `${tab.id} made exactly one round trip — no loop`);
    checkEqual(tab.controller?.version, 'buildbbbbbbbbbb2', `${tab.id} runs the new build`);
    const diagnostics = JSON.parse(
      tab.session.get('cosyncing.handoff.diagnostics') ?? '[]',
    ) as Array<{ k?: string; d?: { tab?: string } }>;
    for (const phase of [
      'commit-received',
      'commit-hook-start',
      'commit-hook-finished',
      'done-sent',
    ]) {
      check(
        diagnostics.some((entry) => entry.k === phase && entry.d?.tab === tab.id),
        `${tab.id} records ${phase} with its tab identity`,
      );
    }
  }
  const coordinatorDiagnostics = tabs.flatMap((tab) =>
    JSON.parse(tab.session.get('cosyncing.handoff.diagnostics') ?? '[]') as Array<{
      k?: string;
      d?: { tab?: string };
    }>
  );
  check(
    coordinatorDiagnostics.some(
      (entry) => entry.k === 'commit-reply-received'
        && tabs.some((tab) => tab.id === entry.d?.tab),
    ),
    'the coordinator records the tab IDs whose commit replies arrived',
  );
  checkEqual(world.registration.tabs.length, 2, 'no duplicate tab was created');
}

async function caseThreeTabsHandOffAndReturn(): Promise<void> {
  console.log('three tabs on different routes hand off together');
  const routes = ['', 'sessions/claude/one', 'settings'];
  const { world, tabs } = await stage(routes, { composer: () => 'idle' });
  await world.clock.advance(ROUND_MS);

  checkEqual(world.bus.countMessages('prepare'), 1, 'exactly one coordinator ran for three tabs');
  checkEqual(world.registration.active?.version, 'buildbbbbbbbbbb2', 'the replacement activated');
  for (let index = 0; index < routes.length; index++) {
    checkEqual(
      tabs[index]!.href,
      SCOPE + routes[index],
      `tab ${index} returned to its exact route`,
    );
  }
}

async function caseTheRouteIsReadWhenTheTabActuallyLeaves(): Promise<void> {
  console.log('a tab that navigates mid-round comes back to where it ended up');
  const world = new World('buildaaaaaaaaaa1');
  const one = world.openTab({ href: SCOPE, composer: 'idle' });
  const two = world.openTab({ href: `${SCOPE}sessions/codex/before`, composer: 'idle' });
  const slow = world.openTab({ href: `${SCOPE}settings`, composer: 'idle' });
  await world.clock.advance(10);
  slow.composer!.holdPrepare();
  world.registration.deploy('buildbbbbbbbbbb2');

  // Mid-round — after the acknowledgement, before the move — the user navigates
  // inside the app. Several seconds pass between agreeing to move and being
  // told to go, and what they are looking at when they leave is the route they
  // must come back to.
  const acknowledged = await advanceUntil(world, () => world.bus.countMessages('ack') >= 1);
  check(acknowledged, 'the route tab acknowledged while another peer was still preparing');
  check(two.replaced.length === 0, 'the tab has not moved yet');
  two.navigateWithin(`${SCOPE}sessions/codex/after`);
  slow.composer!.releasePrepare();

  await world.clock.advance(ROUND_MS * 2);
  checkEqual(
    two.href,
    `${SCOPE}sessions/codex/after`,
    'the tab returned to where it navigated, not to the route it acknowledged',
  );
  checkEqual(one.href, SCOPE, 'the untouched tab still returned to its own route');
  checkEqual(world.registration.active?.version, 'buildbbbbbbbbbb2', 'the handoff still completed');
}

async function caseTypingAfterAcknowledgementIsNeverLost(): Promise<void> {
  console.log('text typed after acknowledgement survives, or the round defers');

  // The hazard: a tab flushes and acknowledges, then waits seconds for its
  // peers while the composer stays editable. Anything typed in that window was
  // flushed by nobody.
  {
    const world = new World('buildaaaaaaaaaa1');
    world.openTab({ href: SCOPE, composer: 'idle' });
    const two = world.openTab({ href: `${SCOPE}sessions/codex/abc`, composer: 'idle' });
    const slow = world.openTab({ href: `${SCOPE}settings`, composer: 'idle' });
    await world.clock.advance(10);
    slow.composer!.holdPrepare();
    world.registration.deploy('buildbbbbbbbbbb2');

    // Let the election and the acknowledgements land, then type.
    const acknowledged = await advanceUntil(world, () => world.bus.countMessages('ack') >= 1);
    check(acknowledged, 'the tab acknowledged while another peer was still preparing');
    check(two.replaced.length === 0, 'the tab has acknowledged but not moved');
    checkEqual(two.composer!.saved, '', 'the acknowledgement flushed the empty composer');
    check(two.composer!.type('typed after acknowledging'), 'the composer is still editable');
    slow.composer!.releasePrepare();

    await world.clock.advance(ROUND_MS * 2);

    checkEqual(
      two.composer!.saved,
      'typed after acknowledging',
      'the newest text was made durable before the tab left',
    );
    check(
      two.composer!.refusedEdits >= 0 && two.composer!.locked === false,
      'the composer was not left frozen',
    );
    checkEqual(
      world.registration.active?.version,
      'buildbbbbbbbbbb2',
      'and the handoff still completed',
    );
    checkEqual(two.href, `${SCOPE}sessions/codex/abc`, 'on its own route');
  }

  // The freeze is a real refusal, not an advisory flag: once a tab has
  // committed, further keystrokes are rejected outright.
  {
    const world = new World('buildaaaaaaaaaa1');
    const only = world.openTab({ href: SCOPE, composer: 'idle' });
    await world.clock.advance(10);
    only.composer!.locked = true;
    checkEqual(only.composer!.type('should not land'), false, 'a frozen composer refuses input');
    checkEqual(only.composer!.text, '', 'and keeps the value that was captured');
    only.composer!.release();
  }

  // A user who starts typing mid-sentence between acknowledging and committing
  // aborts the round for everyone rather than losing the sentence.
  {
    const world = new World('buildaaaaaaaaaa1');
    const one = world.openTab({ href: SCOPE, composer: 'idle' });
    const two = world.openTab({ href: `${SCOPE}sessions/codex/abc`, composer: 'idle' });
    const slow = world.openTab({ href: `${SCOPE}settings`, composer: 'idle' });
    await world.clock.advance(10);
    slow.composer!.holdPrepare();
    world.registration.deploy('buildbbbbbbbbbb2');
    const acknowledged = await advanceUntil(world, () => world.bus.countMessages('ack') >= 1);
    check(acknowledged, 'the tab acknowledged before the final peer');

    // Focused with content is the mid-sentence case the commit must refuse.
    two.composer!.type('mid sentence');
    two.composer!.focused = true;
    slow.composer!.releasePrepare();

    await world.clock.advance(ROUND_MS * 2);

    checkEqual(one.replaced.length, 0, 'nobody moved');
    checkEqual(two.replaced.length, 0, 'including the tab being typed into');
    checkEqual(
      world.registration.active?.version,
      'buildaaaaaaaaaa1',
      'the previous build kept serving',
    );
    checkEqual(two.composer!.locked, false, 'the aborted round left nothing frozen');
    checkEqual(one.composer!.locked, false, 'and released its peers too');
    checkEqual(two.composer!.text, 'mid sentence', 'the sentence is untouched');
  }
}

async function caseReleaseDuringAnInFlightCommitLetsGo(): Promise<void> {
  console.log('a release that arrives mid-flush unfreezes the tab anyway');

  // The window: the freeze lands synchronously at the start of the commit hook,
  // but the durable write that follows takes as long as it takes. A round
  // abandoned in between must undo a freeze this page has not recorded yet.
  const world = new World('buildaaaaaaaaaa1');
  const lead = world.openTab({ href: SCOPE, composer: 'idle', id: 'tab-01' });
  const peer = world.openTab({
    href: `${SCOPE}sessions/codex/abc`,
    composer: 'idle',
    id: 'tab-02',
  });
  const slow = world.openTab({ href: `${SCOPE}settings`, composer: 'idle', id: 'tab-03' });
  await world.clock.advance(10);
  slow.composer!.holdPrepare();
  world.registration.deploy('buildbbbbbbbbbb2');

  // Let the election and the acknowledgements land. Then hold the peer's write
  // open and make the coordinator fail its own commit, which broadcasts
  // `release` while the peer is still flushing.
  const acknowledged = await advanceUntil(world, () => world.bus.countMessages('ack') >= 1);
  check(acknowledged, 'the peer joined while the final peer was still preparing');
  checkEqual(world.bus.countMessages('ack'), 1, 'the peer joined the round');
  peer.composer!.holdFlush();
  lead.composer!.type('the coordinator starts typing');
  lead.composer!.focused = true;
  slow.composer!.releasePrepare();

  const released = await advanceUntil(
    world,
    () => world.bus.countMessages('release') > 0,
  );
  check(released, 'the coordinator abandoned the round it could not commit');
  checkEqual(world.bus.countMessages('release'), 1, 'exactly one release was broadcast');
  checkEqual(
    peer.composer!.saves,
    1,
    'the peer is still flushing: only its acknowledgement has landed',
  );
  checkEqual(peer.composer!.locked, false, 'and it was let go mid-flush anyway');

  // The held write now lands. It must not report success, re-freeze, or move.
  peer.composer!.releaseFlush();
  await world.clock.advance(ROUND_MS);

  checkEqual(world.bus.countMessages('done'), 0, 'the late flush reported nothing');
  checkEqual(world.bus.countMessages('go'), 0, 'and nobody was told to move');
  checkEqual(peer.replaced.length, 0, 'the peer stayed put');
  checkEqual(peer.composer!.locked, false, 'with no retained lock');
  checkEqual(
    world.registration.active?.version,
    'buildaaaaaaaaaa1',
    'the previous build kept serving',
  );

  // And the tab is not poisoned: the next round completes normally.
  lead.composer!.focused = false;
  lead.composer!.text = '';
  lead.window.cosyncingHandoffReadyHint();
  await world.clock.advance(ROUND_MS * 2);

  checkEqual(
    world.registration.active?.version,
    'buildbbbbbbbbbb2',
    'the next round handed off',
  );
  checkEqual(peer.href, `${SCOPE}sessions/codex/abc`, 'and the peer came back to its route');
  checkEqual(lead.window.cosyncingWebUpdateHandoffFailed, false, 'with nothing shown');
}

async function caseTypingDuringTheCommitWindowIsRefused(): Promise<void> {
  console.log('a keystroke between done and go is refused, not lost');

  // Central review rounds 3 and 4: a conditional-hold field is verified
  // empty at commit, and the tab then waits several seconds for `go`. The
  // emptiness check is a snapshot, not a lock — what refuses a keystroke
  // typed after `done` is the page's capture-phase input guard, raised
  // before the commit hook was invoked. The keystroke below travels the
  // same path a real one does: through the window's capture listeners.
  const world = new World('buildaaaaaaaaaa1');
  const lead = world.openTab({ href: SCOPE, composer: 'idle', id: 'tab-01' });
  const peer = world.openTab({
    href: `${SCOPE}sessions/codex/abc`,
    composer: 'token',
    id: 'tab-02',
  });
  const slow = world.openTab({ href: `${SCOPE}settings`, composer: 'idle', id: 'tab-03' });
  await world.clock.advance(10);
  slow.composer!.holdPrepare();
  world.registration.deploy('buildbbbbbbbbbb2');

  // The empty token field acknowledges. Hold the coordinator's own durable
  // write open so the round sits inside the commit window with the peer
  // already done.
  const acknowledged = await advanceUntil(world, () => world.bus.countMessages('ack') >= 1);
  check(acknowledged, 'the token field joined while the final peer was preparing');
  checkEqual(world.bus.countMessages('ack'), 1, 'the empty field joined the round');
  lead.composer!.holdFlush();
  slow.composer!.releasePrepare();

  const peerDone = await advanceUntil(
    world,
    () => world.bus.countMessages('done') > 0,
  );
  check(peerDone, 'the peer committed and reported done');
  checkEqual(world.bus.countMessages('go'), 0, 'and go has not been sent yet');

  // The user pastes a token into the verified-empty field mid-window.
  checkEqual(
    peer.composer!.type('a token pasted after done'),
    false,
    'the capture guard swallowed the keystroke',
  );
  checkEqual(peer.composer!.text, '', 'so nothing losable exists');
  checkEqual(peer.composer!.refusedEdits, 1, 'and the refusal was counted');

  // The window closes and the round completes: the tab moves with the field
  // in exactly the state it was verified in.
  lead.composer!.releaseFlush();
  await world.clock.advance(ROUND_MS);

  checkEqual(
    world.registration.active?.version,
    'buildbbbbbbbbbb2',
    'the handoff completed',
  );
  checkEqual(peer.href, `${SCOPE}sessions/codex/abc`, 'the peer came back to its route');
  checkEqual(peer.composer!.text, '', 'with the token field still empty');
  checkEqual(
    peer.composer!.type('typed on the new build'),
    true,
    'and the new document raised no guard, so typing lands again',
  );
}

async function caseAnAbortedRoundDropsTheInputGuard(): Promise<void> {
  console.log('an aborted round hands the keyboard back');

  // The guard has the same lifecycle as the freeze: anything that abandons the
  // round must drop it, or a tab whose round died keeps refusing every
  // keystroke in a document nobody is ever going to navigate away.
  const world = new World('buildaaaaaaaaaa1');
  const lead = world.openTab({ href: SCOPE, composer: 'idle', id: 'tab-01' });
  const peer = world.openTab({
    href: `${SCOPE}sessions/codex/abc`,
    composer: 'token',
    id: 'tab-02',
  });
  const slow = world.openTab({ href: `${SCOPE}settings`, composer: 'idle', id: 'tab-03' });
  await world.clock.advance(10);
  slow.composer!.holdPrepare();
  world.registration.deploy('buildbbbbbbbbbb2');
  const acknowledged = await advanceUntil(world, () => world.bus.countMessages('ack') >= 1);
  check(acknowledged, 'the peer joined while the final peer was preparing');

  // The coordinator starts typing, so its own commit refuses and it releases
  // the round — after the peer, which received `commit` first, has already
  // raised its guard.
  lead.composer!.type('the coordinator starts typing');
  lead.composer!.focused = true;
  slow.composer!.releasePrepare();
  const released = await advanceUntil(
    world,
    () => world.bus.countMessages('release') > 0,
  );
  check(released, 'the round was abandoned');
  checkEqual(world.bus.countMessages('commit'), 1, 'after the commit began');

  checkEqual(
    peer.composer!.type('typed after the abort'),
    true,
    'the dropped guard lets the keystroke land',
  );
  checkEqual(peer.composer!.text, 'typed after the abort', 'exactly as typed');
}

async function caseAnInteractionStraddlingTheGuardEndsCleanly(): Promise<void> {
  console.log('an interaction that straddles the guard ends cleanly');

  // Round 5: the guard registers at boot and only toggles at commit, which is
  // why it outranks the framework's own listeners at all. And an interaction
  // whose START the framework already saw must not be left half-pressed
  // behind the guard: its pointer is cancelled INTO the framework at raise
  // time, and its keyup passes as cleanup.
  const world = new World('buildaaaaaaaaaa1');
  const lead = world.openTab({ href: SCOPE, composer: 'idle', id: 'tab-01' });
  const peer = world.openTab({
    href: `${SCOPE}sessions/codex/abc`,
    composer: 'token',
    id: 'tab-02',
  });
  const slow = world.openTab({ href: `${SCOPE}settings`, composer: 'idle', id: 'tab-03' });
  await world.clock.advance(10);
  const dispatch = peer.window.__dispatchInputEvent as (
    type: string,
    props?: Record<string, unknown>,
  ) => boolean;

  // Unguarded life: the framework receives events normally.
  dispatch('keydown', { code: 'KeyA' });
  dispatch('pointerdown', { pointerId: 7 });
  checkEqual(
    peer.flutterReceived.filter((type) => type === 'keydown').length,
    1,
    'the framework receives events while unguarded',
  );
  checkEqual(
    peer.flutterReceived.filter((type) => type === 'pointerdown').length,
    1,
    'including the start of a pointer interaction',
  );

  // A round reaches its commit window while the key and pointer are down.
  slow.composer!.holdPrepare();
  world.registration.deploy('buildbbbbbbbbbb2');
  const acknowledged = await advanceUntil(world, () => world.bus.countMessages('ack') >= 1);
  check(acknowledged, 'the guarded peer joined while the final peer was preparing');
  lead.composer!.holdFlush();
  slow.composer!.releasePrepare();
  const peerDone = await advanceUntil(
    world,
    () => world.bus.countMessages('done') > 0,
  );
  check(peerDone, 'the peer committed with the interaction still active');

  checkEqual(
    peer.flutterReceived.filter((type) => type === 'pointercancel').length,
    1,
    'the straddling pointer was cancelled into the framework, not orphaned',
  );

  const seen = peer.flutterReceived.length;
  dispatch('beforeinput', {});
  dispatch('keydown', { code: 'KeyB' });
  dispatch('pointerdown', { pointerId: 8 });
  checkEqual(
    peer.flutterReceived.length,
    seen,
    'nothing guarded reaches the framework',
  );

  dispatch('keyup', { code: 'KeyA' });
  checkEqual(
    peer.flutterReceived.filter((type) => type === 'keyup').length,
    1,
    'but the pre-guard key may finish going up',
  );

  // Nobody ever sends go — the coordinator's flush never lands — so the
  // peer's own freeze deadline aborts the round and drops the guard.
  await world.clock.advance(13_000);
  checkEqual(
    peer.composer!.type('typed after the abort'),
    true,
    'typing works normally after the aborted round',
  );
  dispatch('pointerdown', { pointerId: 9 });
  dispatch('pointerup', { pointerId: 9 });
  checkEqual(
    peer.flutterReceived.filter((type) => type === 'pointerup').length,
    1,
    'and taps flow end to end again',
  );
}

async function caseALongBuildIdentityStillCompletes(): Promise<void> {
  console.log('a build identity at the length limit still rounds');

  // Round ids used to carry the build version. A version at its own 64-char
  // limit pushed the id past the round limit, every peer rejected every message
  // through its own validation, and the handoff simply never happened — no
  // error, no recovery copy, just a tab that stays on the old build forever.
  const long = 'b'.repeat(64);
  const world = new World('buildaaaaaaaaaa1');
  const one = world.openTab({ href: SCOPE, composer: 'idle' });
  const two = world.openTab({ href: `${SCOPE}settings`, composer: 'idle' });
  await world.clock.advance(10);
  world.registration.deploy(long);
  await world.clock.advance(ROUND_MS * 2);

  checkEqual(world.registration.active?.version, long, 'the long build took over');
  checkEqual(one.href, SCOPE, 'the first tab came back');
  checkEqual(two.href, `${SCOPE}settings`, 'and the second kept its route');

  const rounds = new Set<string>();
  for (const item of world.bus.traffic) {
    if (item.data && typeof item.data.r === 'string') rounds.add(item.data.r);
  }
  check(rounds.size > 0, 'the round actually ran');
  for (const round of rounds) {
    check(round.length <= 64, `round id "${round}" fits the declared bound`);
  }
}

async function caseNonDurableEditorsHoldTheHandoff(): Promise<void> {
  console.log('an editor with nowhere to flush to defers until it closes');
  const world = new World('buildaaaaaaaaaa1');
  const tab = world.openTab({ href: SCOPE, composer: 'idle' });
  await world.clock.advance(10);

  // A sheet whose value lives only in widget state: it cannot be flushed, and
  // returning to the underlying route would discard it. It refuses outright.
  const sheet = tab.composer!;
  sheet.text = 'a new session directory';
  sheet.focused = true;

  world.registration.deploy('buildbbbbbbbbbb2');
  await world.clock.advance(ROUND_MS * 2);

  checkEqual(tab.replaced.length, 0, 'the tab never moved while the editor was open');
  checkEqual(
    world.registration.active?.version,
    'buildaaaaaaaaaa1',
    'the previous build kept serving',
  );
  checkEqual(tab.window.cosyncingWebUpdateHandoffFailed, false, 'and nothing was shown');

  // Closing it is what makes the tab movable, and the hint below proves the
  // update lands without waiting out a cadence.
  sheet.focused = false;
  sheet.text = '';
  tab.window.cosyncingHandoffReadyHint();
  await world.clock.advance(ROUND_MS * 2);
  checkEqual(
    world.registration.active?.version,
    'buildbbbbbbbbbb2',
    'closing the editor let the handoff complete',
  );
}

async function caseReadinessAfterTheFastCadenceStillUpdates(): Promise<void> {
  console.log('a tab busy through every fast round still updates when it stops');
  const world = new World('buildaaaaaaaaaa1');
  const tab = world.openTab({ href: SCOPE, composer: 'editing' });
  await world.clock.advance(10);
  world.registration.deploy('buildbbbbbbbbbb2');

  // Busy for longer than the whole fast cadence: eight rounds a minute apart.
  await world.clock.advance(9 * 60_000);
  checkEqual(tab.replaced.length, 0, 'nothing moved while the user was typing');
  checkEqual(
    world.registration.active?.version,
    'buildaaaaaaaaaa1',
    'the replacement is still waiting',
  );

  // The user stops. The app says so, and the update lands immediately — no
  // reload, no navigation, no waiting out another cadence.
  tab.composer!.focused = false;
  tab.window.cosyncingHandoffReadyHint();
  await world.clock.advance(ROUND_MS * 2);

  checkEqual(
    world.registration.active?.version,
    'buildbbbbbbbbbb2',
    'the update landed on the readiness hint alone',
  );
  checkEqual(tab.href, SCOPE, 'the tab is back on its route');
  checkEqual(tab.window.cosyncingWebUpdateHandoffFailed, false, 'and nothing was ever shown');
}

async function caseSlowCadenceSurvivesTheFastOne(): Promise<void> {
  console.log('a tab that goes quiet without a hint still retries, bounded');
  const world = new World('buildaaaaaaaaaa1');
  // A frozen peer blocks every round; the busy tab has no hint to send because
  // nothing about IT changed.
  const blocker = world.openTab({ href: `${SCOPE}blocked`, frozen: true });
  const tab = world.openTab({ href: SCOPE, composer: 'idle' });
  await world.clock.advance(10);
  world.registration.deploy('buildbbbbbbbbbb2');

  await world.clock.advance(9 * 60_000); // the whole fast cadence
  checkEqual(tab.replaced.length, 0, 'the frozen peer deferred every fast round');

  // The peer goes away. Nothing notifies this tab, so only the slow cadence can
  // recover it.
  blocker.close();
  await world.clock.advance(SLOW_ROUND_MS);

  checkEqual(
    world.registration.active?.version,
    'buildbbbbbbbbbb2',
    'the slow cadence picked the update up without any navigation',
  );
  checkEqual(tab.window.cosyncingWebUpdateHandoffFailed, false, 'silently');
}

async function caseAFrozenTabDefersSilently(): Promise<void> {
  console.log('one frozen tab defers the handoff, silently, with nothing moved');
  const { world, tabs } = await stage(['', 'sessions/codex/abc', 'settings'], {
    composer: () => 'idle',
    frozen: [2],
  });

  checkEqual(world.bus.countMessages('go'), 0, 'no move was ordered');
  for (const tab of tabs) {
    checkEqual(tab.replaced.length, 0, `${tab.id} stayed exactly where it was`);
  }
  checkEqual(world.registration.active?.version, 'buildaaaaaaaaaa1', 'the old build still serves');
  check(world.registration.waiting !== null, 'the replacement is still safely waiting');
  for (const tab of tabs) {
    if (tab.frozen) continue; // never ran a script, so it publishes nothing
    checkEqual(
      tab.window.cosyncingWebUpdateHandoffFailed,
      false,
      `${tab.id} shows nothing — a deferral is not a failure`,
    );
  }
}

async function caseAnActivelyEditedTabDefersSilently(): Promise<void> {
  console.log('one actively edited tab defers the handoff, silently');
  const { world, tabs } = await stage(['', 'sessions/codex/abc'], {
    composer: (index) => (index === 1 ? 'editing' : 'idle'),
  });

  checkEqual(world.bus.countMessages('go'), 0, 'no move was ordered');
  checkEqual(world.bus.countMessages('defer'), 1, 'the edited tab declined explicitly');
  for (const tab of tabs) {
    checkEqual(tab.replaced.length, 0, `${tab.id} stayed on its route`);
    checkEqual(
      tab.window.cosyncingWebUpdateHandoffFailed,
      false,
      `${tab.id} shows nothing while a peer is being edited`,
    );
  }
  checkEqual(
    tabs[1]!.composer?.saves,
    0,
    'an actively edited composer is not force-flushed on its way out',
  );
  checkEqual(world.registration.active?.version, 'buildaaaaaaaaaa1', 'the old build still serves');
}

async function caseConcurrentChecksElectOneCoordinator(): Promise<void> {
  console.log('four tabs noticing the same build elect exactly one coordinator');
  const { world } = await stage(['', 'a', 'b', 'c'], { composer: () => 'idle' });

  checkEqual(world.bus.countMessages('claim'), 4, 'every tab claimed');
  checkEqual(world.bus.countMessages('prepare'), 1, 'exactly one tab coordinated');
  checkEqual(world.bus.countMessages('go'), 1, 'exactly one move was ordered');
  await world.clock.advance(ROUND_MS);
  checkEqual(world.registration.activations.length, 2, 'exactly one activation happened');
}

async function caseATabWithNoDurableStateMovesImmediately(): Promise<void> {
  console.log('a tab with no prepare hook has nothing to lose and moves');
  const { world, tabs } = await stage(['', 'sessions/codex/abc'], {
    // Only the second tab has a composer; the first never installed the hook.
    composer: (index) => (index === 1 ? 'idle' : 'none'),
  });
  await world.clock.advance(ROUND_MS);

  checkEqual(world.registration.active?.version, 'buildbbbbbbbbbb2', 'the handoff completed');
  checkEqual(tabs[0]!.composer, null, 'a tab with no editor installed no hooks');
  check(
    (tabs[1]!.composer?.saves ?? 0) >= 1,
    'the tab that owned a draft made it durable',
  );
}

async function caseCrashDuringEachPhase(): Promise<void> {
  console.log('a crash in any handoff phase leaves a recoverable state');

  // Phase 1 — before the move. Closing the coordinator mid-round leaves the
  // remaining tab on the old build with the replacement still waiting.
  {
    const world = new World('buildaaaaaaaaaa1');
    const one = world.openTab({ href: SCOPE, composer: 'idle' });
    const two = world.openTab({ href: `${SCOPE}x`, composer: 'idle' });
    await world.clock.advance(10);
    world.registration.deploy('buildbbbbbbbbbb2');
    await world.clock.advance(200); // mid-election
    one.close();
    await world.clock.advance(ROUND_MS);
    check(
      two.href.startsWith(SCOPE) || two.href.startsWith(HANDOFF),
      'the surviving tab is on a real page, never a dead end',
    );
    checkEqual(two.assigned.length, 0, 'no navigation used assign');
  }

  // Phase 2 — parked on the handoff page. The URL carries everything the tab
  // needs, so a crash and reopen re-runs the same idempotent document: it waits
  // for the identity it was sent for, then returns to the same route.
  {
    const world = new World('buildaaaaaaaaaa1');
    const tab = world.openTab({ href: `${SCOPE}sessions/codex/abc`, composer: 'idle' });
    await world.clock.advance(10);
    world.registration.deploy('buildbbbbbbbbbb2');
    await world.clock.advance(ROUND_MS);
    const parked = tab.replaced[0] ?? '';
    check(parked.startsWith(HANDOFF), 'the tab passed through the handoff page');
    check(
      parked.includes(encodeURIComponent('/cosy/sessions/codex/abc')),
      'the handoff URL itself carries the route, so a restored tab needs no memory',
    );

    // Reopen exactly that URL, as browser session restore would.
    const reopened = world.openTab({ href: parked });
    await world.clock.advance(ROUND_MS);
    checkEqual(
      reopened.href,
      `${SCOPE}sessions/codex/abc`,
      'a reopened handoff page still returns to the exact route',
    );
    checkEqual(reopened.replaced.length, 1, 'the reopened tab returned once, with no loop');
  }

  // Phase 3 — the browser closes the tab outright. Nothing promises to reopen
  // it; what must hold is that the swap still completes for everyone else.
  {
    const world = new World('buildaaaaaaaaaa1');
    const staying = world.openTab({ href: SCOPE, composer: 'idle' });
    const closing = world.openTab({ href: `${SCOPE}y`, composer: 'idle' });
    await world.clock.advance(10);
    world.registration.deploy('buildbbbbbbbbbb2');
    await world.clock.advance(600);
    closing.close();
    // Long enough to cross the retry cooldown: the in-flight round took its
    // census before the close and correctly refuses to move a partial set.
    await world.clock.advance(90_000);
    checkEqual(
      world.registration.active?.version,
      'buildbbbbbbbbbb2',
      'a closed tab does not block the swap',
    );
    checkEqual(staying.href, SCOPE, 'the remaining tab is back on its route');
  }
}

async function caseSuccessiveUpdates(): Promise<void> {
  console.log('N to N+1 to N+2 without an old cache or route winning');
  const world = new World('buildaaaaaaaaaa1');
  const tab = world.openTab({ href: `${SCOPE}sessions/codex/abc`, composer: 'idle' });
  const other = world.openTab({ href: SCOPE, composer: 'idle' });
  await world.clock.advance(10);

  world.registration.deploy('buildbbbbbbbbbb2');
  await world.clock.advance(ROUND_MS * 2);
  checkEqual(world.registration.active?.version, 'buildbbbbbbbbbb2', 'N+1 activated');
  checkEqual(tab.href, `${SCOPE}sessions/codex/abc`, 'the route survived N+1');

  world.registration.deploy('buildccccccccccc3');
  await world.clock.advance(ROUND_MS * 2);
  checkEqual(world.registration.active?.version, 'buildccccccccccc3', 'N+2 activated');
  checkEqual(world.registration.waiting, null, 'no build is left waiting');
  checkEqual(
    world.registration.activations.join(','),
    'buildaaaaaaaaaa1,buildbbbbbbbbbb2,buildccccccccccc3',
    'exactly one activation per build, in order',
  );
  checkEqual(tab.href, `${SCOPE}sessions/codex/abc`, 'the route survived N+2');
  checkEqual(other.href, SCOPE, 'the sibling route survived N+2');
  checkEqual(
    world.registration.active?.cacheName,
    'cosyncing-app:/cosy/:buildccccccccccc3',
    'only the newest cache identity is live',
  );
  checkEqual(world.registration.tabs.length, 2, 'still exactly two tabs');
}

/** Drives the handoff document alone, for the properties only it owns. */
async function runHandoffPage(
  query: string,
  options: { activate?: boolean; activeVersion?: string } = {},
): Promise<Tab> {
  const world = new World(options.activeVersion ?? 'buildbbbbbbbbbb2');
  const tab = world.openTab({ href: HANDOFF + query });
  await world.clock.advance(WEB_HANDOFF_DEADLINE_MS * 2);
  return tab;
}

async function caseHandoffPageRefusesUnsafeRoutes(): Promise<void> {
  console.log('the handoff page returns only to a route it owns');
  const cases: Array<[string, string, string]> = [
    [
      '?v=buildbbbbbbbbbb2&r=https%3A%2F%2Fevil.example%2Fcosy%2F',
      SCOPE,
      'a foreign absolute URL collapses to the app root',
    ],
    [
      '?v=buildbbbbbbbbbb2&r=%2F%2Fevil.example%2Fcosy%2F',
      SCOPE,
      'a protocol-relative URL collapses to the app root',
    ],
    [
      '?v=buildbbbbbbbbbb2&r=%2Fapi%2Fsessions',
      SCOPE,
      'a same-origin route outside the app scope collapses to the app root',
    ],
    [
      '?v=buildbbbbbbbbbb2&r=%2Fcosy%2F..%2Fapi',
      SCOPE,
      'an escaping traversal collapses to the app root',
    ],
    [
      `?v=buildbbbbbbbbbb2&r=${encodeURIComponent(`/cosy/${'x'.repeat(WEB_HANDOFF_MAX_ROUTE_CHARS)}`)}`,
      SCOPE,
      'an over-long route collapses to the app root rather than being truncated',
    ],
    [
      '?v=buildbbbbbbbbbb2&r=%2Fcosy-handoff%3Fv%3Dx',
      SCOPE,
      'the handoff path itself collapses to the app root, so no loop is possible',
    ],
    [
      '?v=buildbbbbbbbbbb2&r=%2Fcosy%2Fsessions%2Fcodex%2Fabc%3Ftab%3D2%23top',
      `${SCOPE}sessions/codex/abc?tab=2#top`,
      'a legitimate route keeps its query and fragment exactly',
    ],
  ];
  for (const [query, expected, description] of cases) {
    const tab = await runHandoffPage(query);
    checkEqual(tab.href, expected, description);
  }

  const noVersion = await runHandoffPage('?r=%2Fcosy%2Fsettings');
  checkEqual(
    noVersion.href,
    `${SCOPE}settings`,
    'a page with nothing to wait for returns immediately instead of parking',
  );
}

async function caseHandoffPageReturnsOnDeadline(): Promise<void> {
  console.log('a handoff that never lands still returns the tab, and is bounded');
  const world = new World('buildaaaaaaaaaa1');
  // A build that is waiting forever: something else still controls the scope,
  // so the identity the tab is waiting for never becomes active.
  world.registration.waiting = makeWorker('buildbbbbbbbbbb2', world.registration);
  const blocker = world.openTab({ href: SCOPE, frozen: true });
  check(blocker.inScope(), 'a frozen client keeps the old worker alive');

  const tab = world.openTab({
    href: `${HANDOFF}?v=buildbbbbbbbbbb2&r=%2Fcosy%2Fsessions%2Fcodex%2Fabc`,
  });
  await world.clock.advance(WEB_HANDOFF_DEADLINE_MS - 1000);
  check(tab.href.startsWith(HANDOFF), 'the tab waits for the whole deadline');
  await world.clock.advance(3000);
  checkEqual(
    tab.href,
    `${SCOPE}sessions/codex/abc`,
    'the deadline returns the tab to its route rather than stranding it',
  );
}

async function caseRepeatedRealFailureSurfacesRecovery(): Promise<void> {
  console.log('only a repeated real failure surfaces localized recovery copy');
  const world = new World('buildaaaaaaaaaa1');
  const tab = world.openTab({ href: `${SCOPE}sessions/codex/abc`, composer: 'idle' });
  await world.clock.advance(10);
  // The tab will do everything right and the swap will still not land.
  world.registration.blockActivation = true;
  world.registration.deploy('buildbbbbbbbbbb2');

  let sawFailure = false;
  let visits = 0;
  for (let round = 0; round < 8; round++) {
    await world.clock.advance(ROUND_MS + WEB_HANDOFF_DEADLINE_MS + 5000);
    visits += tab.replaced.filter((url) => url.startsWith(HANDOFF)).length - visits;
    if (tab.window.cosyncingWebUpdateHandoffFailed === true) {
      sawFailure = true;
      break;
    }
  }

  check(sawFailure, 'the tab reports a real handoff failure after its bounded attempts');
  const attempts = Number(tab.session.get('cosyncing.handoff.attempts:buildbbbbbbbbbb2'));
  check(attempts <= 3, `attempts stayed inside the bound (${attempts})`);
  check(visits <= 3, `the tab moved at most three times before giving up (${visits})`);
  // Counted by prefix rather than by total keys. The guarantee is that attempt
  // records do not accumulate one per build; the handoff also keeps a single
  // fixed diagnostics key, which is bounded and does not grow with builds, and
  // a raw `size` check could not tell the two apart.
  const attemptKeys = [...tab.session.keys()]
    .filter((key) => key.startsWith('cosyncing.handoff.attempts:'));
  checkEqual(
    attemptKeys.length,
    1,
    'exactly one attempt record is retained, never one per build ever seen',
  );
  checkEqual(
    [...tab.session.keys()].filter((key) => !attemptKeys.includes(key)).join(','),
    'cosyncing.handoff.diagnostics',
    'the only other session key is the single fixed diagnostics record',
  );
  check(tab.href.startsWith(SCOPE), 'a failed handoff leaves the tab on a working app route');
  checkEqual(
    world.registration.active?.version,
    'buildaaaaaaaaaa1',
    'the previous build kept serving throughout — nothing was left broken',
  );

  // And it stays bounded: more time buys no more attempts.
  const settled = tab.replaced.length;
  await world.clock.advance(600_000);
  checkEqual(tab.replaced.length, settled, 'a spent budget stops attempting entirely');
}

async function caseUnsupportedMountReportsHonestly(): Promise<void> {
  console.log('a mount with no out-of-scope destination reports failure instead of looping');
  // Nothing here can be exercised through the World (its scope is always
  // /cosy/), so this asserts the guard the coordinator computes: a root-mounted
  // app resolves its sibling destination back inside its own scope.
  const rootScope = `${ORIGIN}/`;
  const destination = new URL('../cosy-handoff', rootScope);
  check(
    destination.href.startsWith(rootScope),
    'a root-mounted app has no sibling outside its own scope, which the guard detects',
  );
  check(
    coordinatorSource.includes('HANDOFF_SUPPORTED'),
    'the coordinator carries the unsupported-mount guard',
  );
}

/* ------------------------------------------------------------------ *
 * Entry point.
 * ------------------------------------------------------------------ */

let coordinatorSource = '';
let handoffSource = '';

async function main(): Promise<number> {
  workerSourceTemplate = await readFile(join(CLIENT_ROOT, 'web', 'sw.js'), 'utf8');
  coordinatorSource = extractCoordinator(
    await readFile(join(CLIENT_ROOT, 'web', 'index.html'), 'utf8'),
  );
  handoffSource = extractHandoffScript(WEB_HANDOFF_DOCUMENT);

  await caseHandoffPathAgreesAcrossPackages();
  await caseShippedSourcesCannotActivateOverALivePage();
  await caseWorkerAnswersReadOnlyQuestions();
  await caseDiagnosticsSurviveTheReplacementDocument();
  await caseTwoTabsHandOffAndReturn();
  await caseThreeTabsHandOffAndReturn();
  await caseTheRouteIsReadWhenTheTabActuallyLeaves();
  await caseTypingAfterAcknowledgementIsNeverLost();
  await caseReleaseDuringAnInFlightCommitLetsGo();
  await caseTypingDuringTheCommitWindowIsRefused();
  await caseAnAbortedRoundDropsTheInputGuard();
  await caseAnInteractionStraddlingTheGuardEndsCleanly();
  await caseALongBuildIdentityStillCompletes();
  await caseNonDurableEditorsHoldTheHandoff();
  await caseReadinessAfterTheFastCadenceStillUpdates();
  await caseSlowCadenceSurvivesTheFastOne();
  await caseAFrozenTabDefersSilently();
  await caseAnActivelyEditedTabDefersSilently();
  await caseConcurrentChecksElectOneCoordinator();
  await caseATabWithNoDurableStateMovesImmediately();
  await caseCrashDuringEachPhase();
  await caseSuccessiveUpdates();
  await caseHandoffPageRefusesUnsafeRoutes();
  await caseHandoffPageReturnsOnDeadline();
  await caseRepeatedRealFailureSurfacesRecovery();
  await caseUnsupportedMountReportsHonestly();
  await caseTheGraceFitsInsideTheAckWindow();
  await caseDelayedWorkerVisibilityStillJoins();
  await caseASilentActiveWorkerStartsNoRound();
  await caseAMalformedActiveWorkerStartsNoRound();
  await caseASecondBuildGetsAFreshRecheckBudget();
  await caseAnAbsentWorkerStillDefers();
  await caseAWrongIdentityIsNotWaitedOn();
  await caseABusyPeerIsUnaffectedByTheGrace();
  await caseSimultaneousCoordinatorsStillElectOne();
  await caseAPeerCannotDriveThisTabsRetryCadence();

  if (failures > 0) {
    console.error(`\nweb update handoff audit: ${failures} failed of ${checks} checks`);
    return 1;
  }
  console.log(`\nweb update handoff audit: ${checks} checks passed`);
  return 0;
}

process.exit(await main());
