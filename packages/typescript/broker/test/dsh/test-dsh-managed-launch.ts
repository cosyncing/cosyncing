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
 * listener speaking the captured 0.2 exchange contract over real HTTP; the only
 * fake is the process table, which has to be — the child is not a real `dsh`,
 * and a test must never start a binary it cannot clean up.
 *
 *   bun run packages/typescript/broker/test/dsh/test-dsh-managed-launch.ts   (exit 0 = all pass)
 */
export {};

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dshCredentialScope } from '@cosyncing/adapter-dsh';
import {
  ensureManagedHost,
  HOST_ABSENT,
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
import { shippedDshAdapter } from '../../src/installation/shipped-adapters.ts';
import { dshSessionsPath, loadDshCookie } from '../../src/security/dsh-credentials.ts';

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const TOKEN = 'launch-token-not-a-real-one-but-shaped-like-one';
const SPAWN_PID = 41500;

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

    const adapter = shippedDshAdapter();
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
    const restarted = shippedDshAdapter();
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
    const adapter = shippedDshAdapter();
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
} finally {
  restoreEnv();
  for (const dir of homes) rmSync(dir, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(failed.length === 0
  ? `\n✅ ${String(results.length)}/${String(results.length)} managed-launch checks passed.`
  : `\n❌ ${String(results.length - failed.length)}/${String(results.length)} managed-launch checks passed.`);
process.exit(failed.length === 0 ? 0 : 1);
