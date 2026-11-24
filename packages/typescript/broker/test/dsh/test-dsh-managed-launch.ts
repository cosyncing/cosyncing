/**
 * The managed launch, end to end: cosyncing starts a 0.2 host and authenticates
 * to it with nobody typing anything.
 *
 * This is the seam that the transport suites cannot see and the ownership suite
 * does not reach. The ownership suite proves the lifecycle engine forwards a
 * child's output while the host boots; the adapter suites prove the adapter
 * turns an announcement into a cookie. Between them sits the thing a user
 * actually depends on: the broker's generic start hands THIS adapter the bytes
 * THIS host printed, and readiness then means an authenticated roster read
 * rather than a port that answers. A version of this file that passed while the
 * engine forwarded its capture only once is exactly how a 0.2 managed host came
 * to fail as `host-not-ready-in-time` behind a browser that never opened.
 *
 * So nothing here is mocked at the seam. The adapter is the shipped one, with
 * the broker's real file-backed credential store; the host is a Bun.serve
 * listener speaking the captured 0.2 exchange contract over real HTTP. What is
 * supplied by hand is the machine around it: the process table, because a test
 * must never start a binary it cannot clean up, and the two facts a real install
 * would otherwise be probed for — where the executable is, and the version it
 * reports — because a suite that reads its own machine passes or fails on
 * whoever happened to install the host there.
 *
 *   bun run packages/typescript/broker/test/dsh/test-dsh-managed-launch.ts   (exit 0 = all pass)
 */
export {};

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DshAdapter, dshCredentialScope, type DshCookie } from '@cosyncing/adapter-dsh';
import {
  ensureManagedHost,
  HOST_ABSENT,
  MANAGED_LAUNCH_OUTPUT_EXTRA_POLLS,
  startManagedHost,
  managedHostStore,
  PROCESS_ABSENT,
  releaseManagedHost,
  type HostProcessIdentity,
  type LiveProcess,
  type ManagedHostChild,
  type ManagedHostEffects,
  type ManagedHostLaunch,
} from '../../src/runtime/managed-host.ts';
import { dshAdapterOptions } from '../../src/installation/shipped-adapters.ts';
import { dshSessionsPath, loadDshCookie } from '../../src/security/dsh-credentials.ts';

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// The version the launch plan is qualified for, stated rather than probed: the
// runner that executes this suite has no dsh installed, and the host here is a
// fixture listener, so neither the PATH nor an installed binary may be asked.
const MANAGED_VERSION = '0.2.0-rc.2';
const FAKE_EXECUTABLE = '/fixture/bin/dsh';
const TOKEN = 'launch-token-not-a-real-one-but-shaped-like-one';
const SPAWN_PID = 41500;

/**
 * The adapter the running broker builds, with this machine's two dsh facts
 * supplied by hand.
 *
 * The shipped options carry the broker's real file-backed credential store,
 * which is the thing this suite exists to exercise. The executable path and the
 * version it reports are the two facts a real install would be probed for, and
 * probing them here made the suite answer differently depending on whether
 * whoever ran it had installed the host: on a runner with no `dsh` the launch
 * descriptor came back with no command and every scenario below reported
 * `not-launchable` while the code under test was fine. Stating them leaves the
 * seam under test untouched and makes the suite describe one machine rather than
 * whichever it happened to land on.
 */
function adapterWithAHostInstalled(): DshAdapter {
  return new DshAdapter({
    ...dshAdapterOptions(),
    resolveExecutable: () => FAKE_EXECUTABLE,
    readExecutableVersion: () => MANAGED_VERSION,
  });
}

// ── a host that answers the way 0.2 was captured answering ─────────────────

interface Host {
  readonly baseUrl: string;
  readonly requests: Array<{ method: string; path: string; cookie: string | null }>;
  readonly issued: { name: string; value: string } | null;
  stop(): void;
}

async function startHost(): Promise<Host> {
  const requests: Host['requests'] = [];
  let issued: Host['issued'] = null;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const cookie = req.headers.get('cookie');
      requests.push({ method: req.method, path: url.pathname, cookie });
      // Captured: the carrier refuses an anonymous client. This is what the
      // contract probe reads as "0.2, not enrolled", and what must never be
      // answered by trying a legacy RPC.
      if (url.pathname === '/api/remote.mux') return new Response('unauthorized', { status: 401 });
      if (url.pathname === '/' && url.searchParams.get('token') === TOKEN) {
        issued = { name: 'dsh-auth-YnV0LWZpeHR1cmU', value: 'v1.issued-by-this-fixture' };
        return new Response(null, {
          status: 303,
          headers: {
            location: './',
            'cache-control': 'no-store',
            'set-cookie': `${issued.name}=${issued.value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
          },
        });
      }
      if (url.pathname === '/') {
        return new Response('dsh web authentication required; reopen the URL printed by dsh web.', { status: 401 });
      }
      if (url.pathname === '/api/session/list') {
        if (cookie === null) return new Response('unauthorized', { status: 401 });
        const body = await req.json() as { rpcId: string };
        return new Response(JSON.stringify({
          type: 'server-response',
          rpcId: body.rpcId,
          result: { ok: true, value: { items: [] } },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return {
    get baseUrl() { return `http://127.0.0.1:${String(server.port)}`; },
    requests,
    get issued() { return issued; },
    stop() { server.stop(true); },
  };
}

// ── the machine the lifecycle engine sees ──────────────────────────────────

const SPAWNED: HostProcessIdentity = { pid: SPAWN_PID, start: '441100', boot: 'boot-fixture', comm: 'dsh' };

/**
 * A process table, not a host.
 *
 * `listener` answers `absent` for the port on purpose: the fixture listener
 * stands in for the host's HTTP answers, and the port it happens to hold belongs
 * to THIS test process. Letting the real provider see it would report that the
 * broker owns its own test runner, which is a fact about the fixture and not
 * about the code under test. The child is synthetic for the same reason: no real
 * `dsh` is ever spawned here, and a suite that could not clean up its own hosts
 * is worse than a suite with a fake process table.
 */
function fakeEffects(child: { output: string[]; gone: boolean }): {
  effects: ManagedHostEffects;
  signals: Array<{ pid: number; signal: string }>;
  launches: ManagedHostLaunch[];
} {
  const signals: Array<{ pid: number; signal: string }>[] = [[]];
  const launches: ManagedHostLaunch[] = [];
  let spawned: ManagedHostChild | null = null;
  const effects: ManagedHostEffects = {
    listener: () => HOST_ABSENT,
    liveProcess: (pid): LiveProcess => (pid === SPAWN_PID && !child.gone
      ? { state: 'running', identity: SPAWNED }
      : PROCESS_ABSENT),
    spawn: (launch) => {
      launches.push(launch);
      spawned = {
        pid: SPAWN_PID,
        exited: new Promise(() => {}),
        get exitCode() { return child.gone ? 0 : null; },
        // Cumulative, like a real bounded capture: the last snapshot sticks.
        readOutput: () => (child.output.length > 1 ? child.output.shift()! : child.output[0]!),
      };
      return spawned;
    },
    signal: (pid, signal) => {
      signals[0]!.push({ pid, signal });
      if (signal === 'SIGTERM') child.gone = true;
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    deadline: (ms) => {
      let fire: () => void = () => {};
      const expired = new Promise<void>((resolve) => { fire = resolve; });
      const timer = setTimeout(() => fire(), ms);
      timer.unref?.();
      return { expired, cancel: () => clearTimeout(timer) };
    },
    selfPid: () => process.pid,
  };
  return { effects, signals: signals[0]!, launches };
}

// ── a host that is relaunched, and the machine that relaunches it ──────────

/**
 * One address, served by a succession of launches. Between launches nothing
 * answers (503 stands in for a refused connection); during one, the index route
 * accepts only the token that launch printed. Every token presented there is
 * logged, accepted, refused or unanswered, which is what lets a check say
 * "never sent".
 */
interface LaunchingHost {
  readonly baseUrl: string;
  readonly exchanges: string[];
  readonly issued: Array<{ name: string; value: string }>;
  rosterReads: number;
  up: boolean;
  accepts: string | undefined;
  /** Runs while an authenticated roster read is being answered, before the reply. */
  onServingRoster: (() => void) | undefined;
  stop(): void;
}

async function startLaunchingHost(): Promise<LaunchingHost> {
  let port = 0;
  const host: LaunchingHost = {
    get baseUrl() { return `http://127.0.0.1:${String(port)}`; },
    exchanges: [],
    issued: [],
    rosterReads: 0,
    up: false,
    accepts: undefined,
    onServingRoster: undefined,
    stop() { server.stop(true); },
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      // Logged before the liveness check: a token sent to this address counts as
      // sent whether or not anything was there to refuse it.
      const token = url.pathname === '/' ? url.searchParams.get('token') : null;
      if (token !== null) host.exchanges.push(token);
      if (!host.up) return new Response('no host is serving', { status: 503 });
      if (url.pathname === '/api/remote.mux') return new Response('unauthorized', { status: 401 });
      if (url.pathname === '/') {
        if (token === null || token !== host.accepts) {
          return new Response('dsh web authentication required; reopen the URL printed by dsh web.', { status: 401 });
        }
        const issued = { name: 'dsh-auth-cmVsYXVuY2hlZA', value: `v1.issued-for-${token}` };
        host.issued.push(issued);
        return new Response(null, {
          status: 303,
          headers: {
            location: './',
            'cache-control': 'no-store',
            'set-cookie': `${issued.name}=${issued.value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
          },
        });
      }
      if (url.pathname === '/api/session/list') {
        if (req.headers.get('cookie') === null) return new Response('unauthorized', { status: 401 });
        host.rosterReads += 1;
        host.onServingRoster?.();
        const body = await req.json() as { rpcId: string };
        return new Response(JSON.stringify({
          type: 'server-response',
          rpcId: body.rpcId,
          result: { ok: true, value: { items: [] } },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    },
  });
  port = server.port ?? 0;
  return host;
}

type Announce = 'at-spawn' | 'during-first-serving-probe' | 'never';

/**
 * The lifecycle engine's view of a machine that relaunches {@link LaunchingHost},
 * on a virtual clock: `sleep` advances it and yields one macrotask so real HTTP
 * can complete, and no probe deadline ever fires on its own. Each spawn is a new
 * pid that brings the host up with that launch's token; SIGTERM takes it down.
 */
function launchMachine(host: LaunchingHost): {
  effects: ManagedHostEffects;
  next(launch: { token: string; announce: Announce }): void;
} {
  let clock = 1_000_000;
  let nextPid = 41_600;
  let pending: { token: string; announce: Announce } | undefined;
  let current: { pid: number; output: string; gone: boolean } | undefined;
  const identity = (pid: number): HostProcessIdentity => ({ pid, start: `start-${String(pid)}`, boot: 'boot-fixture', comm: 'dsh' });
  const effects: ManagedHostEffects = {
    listener: () => HOST_ABSENT,
    liveProcess: (pid): LiveProcess => (current && pid === current.pid && !current.gone
      ? { state: 'running', identity: identity(pid) }
      : PROCESS_ABSENT),
    spawn: () => {
      const launch = pending;
      if (!launch) throw new Error('the scenario did not say what the next launch prints');
      pending = undefined;
      nextPid += 1;
      const child = { pid: nextPid, output: 'stdout:\ndsh web: starting\n\nstderr:\n', gone: false };
      current = child;
      const announced = `stdout:\ndsh web: starting\ndsh web: ${host.baseUrl}/?token=${launch.token}\n\nstderr:\n`;
      host.up = true;
      host.accepts = launch.token;
      if (launch.announce === 'at-spawn') child.output = announced;
      host.onServingRoster = launch.announce === 'during-first-serving-probe'
        ? () => { child.output = announced; host.onServingRoster = undefined; }
        : undefined;
      return {
        pid: child.pid,
        exited: new Promise<number>(() => {}),
        get exitCode() { return child.gone ? 0 : null; },
        readOutput: () => child.output,
      };
    },
    signal: (pid, signal) => {
      if (signal === 'SIGTERM' && current && pid === current.pid) {
        current.gone = true;
        host.up = false;
        host.accepts = undefined;
        host.onServingRoster = undefined;
      }
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    },
    deadline: () => ({ expired: new Promise<void>(() => {}), cancel: () => {} }),
    selfPid: () => process.pid,
  };
  return { effects, next: (launch) => { pending = launch; } };
}

/** A disposable state home, so no test writes a credential the broker would read. */
function tempHome(): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'cosyncing-dsh-managed-launch-'));
  mkdirSync(join(dir, 'secrets'), { recursive: true });
  return dir;
}

const savedEnv: Record<string, string | undefined> = {};
function useEnv(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
}
function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const homes: string[] = [];

try {
  // ── the whole path: launch announcement → cookie → authenticated readiness ─
  {
    const host = await startHost();
    const home = tempHome();
    homes.push(home);
    const dshHome = join(home, 'dsh-profile');
    useEnv({
      COSYNCING_HOME: home,
      COSYNCING_DSH_BASE_URL: host.baseUrl,
      DSH_HOME: dshHome,
      COSYNCING_DSH_MANAGED_HOST: '1',
    });

    const adapter = adapterWithAHostInstalled();
    // The child prints the line the real host prints, prefixed with its own
    // label and only AFTER a couple of polls: the announcement is not in the
    // buffer at spawn, and a start that reads once reads nothing.
    const blank = 'stdout:\n\nstderr:\n';
    const child = {
      output: [
        blank,
        blank,
        `stdout:\ndsh web: ${host.baseUrl}/?token=${TOKEN}\n\nstderr:\n`,
      ],
      gone: false,
    };
    const { effects, signals, launches } = fakeEffects(child);
    const store = managedHostStore(home);

    const outcome = await ensureManagedHost(adapter, effects, store, { COSYNCING_DSH_MANAGED_HOST: '1' });
    check('the managed start completes instead of timing out on an announcement it never saw',
      outcome.action === 'started' && launches.length === 1,
      JSON.stringify({ outcome, launches: launches.length }));

    // Readiness was the adapter's own answer, so an authenticated host is the
    // only thing that could have produced it. Assert the roster leg too: a host
    // that answers the exchange but not the API is not integrated.
    const available = await adapter.isAvailable();
    const roster = await adapter.discoverSessions();
    check('the host cosyncing started answered an authenticated roster read',
      available === true && Array.isArray(roster) && roster.length === 0,
      `available=${String(available)} roster=${String(roster.length)}`);
    check('the roster went out with the cookie the exchange earned',
      host.issued !== null && host.requests.some((request) => request.path === '/api/session/list'
        && request.cookie === `${host.issued?.name}=${host.issued?.value}`),
      JSON.stringify(host.requests.filter((r) => r.path.startsWith('/api/')).map((r) => `${r.method} ${r.path}`)));
    check('the exchange ran once, on the index route, and no legacy RPC was tried',
      host.requests.filter((request) => request.path === '/' && request.method === 'GET').length === 1
        && host.requests.some((request) => request.path === '/api/remote.mux' && request.method === 'GET')
        && host.requests.every((request) => !JSON.stringify(request.path).includes('host.describe')),
      JSON.stringify(host.requests.map((request) => `${request.method} ${request.path}`)));

    const scope = dshCredentialScope(host.baseUrl, dshHome);
    const onDisk = loadDshCookie(scope, dshSessionsPath(home));
    check('the credential is on disk, scoped to this endpoint and profile',
      existsSync(dshSessionsPath(home)) && onDisk !== null
        && onDisk.value === host.issued?.value,
      `stored=${String(onDisk !== null)}`);

    // The broker restarts; the host does not. A new adapter has heard no
    // announcement and has no reason to, because the cookie outlived the process
    // that earned it. This is the difference between "logged in" and "must be
    // handed a new URL every time the service restarts".
    const restarted = adapterWithAHostInstalled();
    const restartedAvailable = await restarted.isAvailable();
    check('a restarted broker is still logged in, with nothing re-typed',
      restartedAvailable === true
        && host.requests.filter((request) => request.method === 'GET' && request.path === '/').length === 1,
      `available=${String(restartedAvailable)}`);

    // Stopping the host this broker started does not log cosyncing out of it, and
    // that is deliberate: the cookie is signed for thirty days under the host's
    // secret and is what lets the NEXT start be authenticated without an
    // operator hunting for a URL the host prints once.
    const stopped = await releaseManagedHost(adapter, effects, store);
    const afterStop = loadDshCookie(scope, dshSessionsPath(home));
    check('stopping a host this broker started keeps the credential for the next one',
      (stopped.action === 'stopped' || stopped.action === 'already-gone')
        && signals.length > 0 && afterStop !== null,
      JSON.stringify({ stopped, signals: signals.length }));

    host.stop();
    restoreEnv();
  }

  // ── an announcement for somebody else is not a credential to spend ────────
  {
    const host = await startHost();
    const home = tempHome();
    homes.push(home);
    const dshHome = join(home, 'dsh-profile');
    useEnv({
      COSYNCING_HOME: home,
      COSYNCING_DSH_BASE_URL: host.baseUrl,
      DSH_HOME: dshHome,
      COSYNCING_DSH_MANAGED_HOST: '1',
    });
    const adapter = adapterWithAHostInstalled();
    const descriptor = await adapter.describeManagedHost?.();
    if (!descriptor?.launch) throw new Error('the fixture adapter stopped describing its own host');

    // Same shape, different authority: the child points at a port cosyncing did
    // not configure. Spending that token would hand a credential to whatever
    // answers there, so the adapter must not even ask.
    //
    // Driven through `startManagedHost` with the descriptor's own launch and a
    // short window, rather than `ensureManagedHost` as above: the outcome under
    // test is one that never becomes ready, so the adapter's real 20s boot budget
    // would be spent twice in every gate run to prove a negative. The plan's
    // output hook is wired exactly as the generic entry point wires it.
    const child = {
      output: [`stdout:\ndsh web: http://127.0.0.1:60555/?token=${TOKEN}\n\nstderr:\n`],
      gone: false,
    };
    const { effects, launches } = fakeEffects(child);
    const outcome = await startManagedHost({
      agent: 'dsh',
      identityKey: descriptor.identityKey,
      ready: (signal) => adapter.isAvailable({ ...(signal ? { signal } : {}) }),
      locate: async () => HOST_ABSENT,
      observeOutput: (text) => adapter.observeManagedOutput?.(text),
      launch: descriptor.launch,
      readyTimeoutMs: 1_500,
      readyPollMs: 100,
      stopGraceMs: 200,
    }, effects, managedHostStore(home));
    check('an announcement naming another authority is never exchanged',
      outcome.action === 'start-failed'
        && (outcome as { detailCode?: string }).detailCode === 'host-not-ready-in-time'
        && launches.length === 1
        && host.requests.every((request) => !(request.method === 'GET' && request.path === '/')),
      JSON.stringify({ outcome, requests: host.requests.map((r) => `${r.method} ${r.path}`) }));
    check('and nothing was stored for a host that was not the configured one',
      !existsSync(dshSessionsPath(home))
        || loadDshCookie(dshCredentialScope(host.baseUrl, dshHome), dshSessionsPath(home)) === null,
      '');
    host.stop();
    restoreEnv();
  }

  // ── A relaunch whose host serves before its launch URL is read ─────────────
  //
  // The managed-launch capture on 0.2.2-rc.5 relaunched a host 14 times with a
  // stored cookie and missed the new launch URL 3 times. The probe that found
  // the host serving began 11-19 ms before the URL reached the broker's pipe
  // and passed about 120 ms later, and output used to stop being read once
  // readiness passed. The adapter still held the stopped launch's token, so a
  // renewal would have sent a token no running host had issued. Here the
  // relaunched child prints its URL exactly then: while the first probe that
  // finds the host serving is being answered.
  {
    const TOKEN_A = 'launch-token-a-fixture';
    const TOKEN_B = 'launch-token-b-fixture';
    const TOKEN_C = 'launch-token-c-fixture';
    const host = await startLaunchingHost();
    const home = tempHome();
    homes.push(home);
    useEnv({
      COSYNCING_HOME: home,
      COSYNCING_DSH_BASE_URL: host.baseUrl,
      DSH_HOME: join(home, 'dsh-profile'),
      COSYNCING_DSH_MANAGED_HOST: '1',
    });
    // A memory store, so "a day before expiry" is a value to set rather than a
    // day to wait: the adapter re-reads its enrollment on every readiness call.
    let enrolled: DshCookie | null = {
      name: 'dsh-auth-c2VlZGVk', value: 'v1.enrolled-earlier', expiresAt: Date.now() + 10 * 86_400_000,
    };
    const adapter = new DshAdapter({
      credentialStore: {
        async load() { return enrolled; },
        async save(_scope, cookie) { enrolled = cookie; },
        async clear() { enrolled = null; },
      },
      resolveExecutable: () => FAKE_EXECUTABLE,
      readExecutableVersion: () => MANAGED_VERSION,
    });
    const machine = launchMachine(host);
    const store = managedHostStore(home);
    const gate = { COSYNCING_DSH_MANAGED_HOST: '1' };

    // Launch A prints its URL first, the ordinary order, and is then stopped.
    machine.next({ token: TOKEN_A, announce: 'at-spawn' });
    const launchA = await ensureManagedHost(adapter, machine.effects, store, gate);
    const stopA = await releaseManagedHost(adapter, machine.effects, store);
    const sentBeforeStop = host.exchanges.length;

    // A day before expiry, renewal is due. Launch B serves first and prints
    // its URL during that first serving probe.
    enrolled = { ...enrolled!, expiresAt: Date.now() + 3_600_000 };
    machine.next({ token: TOKEN_B, announce: 'during-first-serving-probe' });
    const launchB = await ensureManagedHost(adapter, machine.effects, store, gate);
    await adapter.isAvailable();
    check('a relaunch that serves before its URL is read still adopts the new launch token',
      launchA.action === 'started' && launchB.action === 'started'
        && host.exchanges.includes(TOKEN_B) && enrolled?.value === `v1.issued-for-${TOKEN_B}`,
      JSON.stringify({ launchA, launchB, exchanges: host.exchanges, enrolled: enrolled?.value }));
    check('a stopped launch\'s token is never sent for renewal',
      (stopA.action === 'stopped' || stopA.action === 'already-gone')
        && !host.exchanges.slice(sentBeforeStop).includes(TOKEN_A),
      JSON.stringify({ stopA, exchanges: host.exchanges, sentBeforeStop }));

    // Launch C never prints a URL at all. It is ready on its first serving
    // probe, as before; the wait for its URL after that is bounded, and the
    // start succeeds on the stored cookie.
    await releaseManagedHost(adapter, machine.effects, store);
    const readsBefore = host.rosterReads;
    const clockBefore = machine.effects.now();
    machine.next({ token: TOKEN_C, announce: 'never' });
    const launchC = await ensureManagedHost(adapter, machine.effects, store, gate);
    const waited = machine.effects.now() - clockBefore;
    check('a relaunch that never prints its URL is started after a bounded wait, on one readiness probe',
      launchC.action === 'started'
        && host.rosterReads - readsBefore === 1
        // 150 ms is the engine's default poll interval.
        && waited <= MANAGED_LAUNCH_OUTPUT_EXTRA_POLLS * 150
        && !host.exchanges.includes(TOKEN_C),
      JSON.stringify({ launchC, reads: host.rosterReads - readsBefore, waited }));
    await releaseManagedHost(adapter, machine.effects, store);
    host.stop();
    restoreEnv();
  }
} finally {
  restoreEnv();
  for (const dir of homes) rmSync(dir, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(failed.length === 0
  ? `\n✅ ${String(results.length)}/${String(results.length)} managed-launch checks passed.`
  : `\n❌ ${String(results.length - failed.length)}/${String(results.length)} managed-launch checks passed.`);
process.exit(failed.length === 0 ? 0 : 1);
