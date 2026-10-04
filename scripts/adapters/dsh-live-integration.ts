#!/usr/bin/env bun
/**
 * The 0.2 physical pass that costs nothing: real host, real product paths, no model turn.
 *
 * Every DSH suite in the gate is fixture-based, and the capture runner proves
 * what the HOST says. Neither proves the thing this script is for: that
 * cosyncing, running its own code end to end, can start a 0.2 host without a
 * browser, become authenticated from the announcement that host prints to a
 * process it does not own, list that host's sessions, and read a session's
 * history. That is the difference between a transport that tests green and a
 * feature a user can turn on.
 *
 * It spends nothing. Nothing here sends a prompt, so no provider request is
 * made and no credit is consumed; the scenarios that need a model answer are
 * reported as untested rather than approximated.
 *
 * Isolation is inherited from the capture sandbox, not reinvented: a disposable
 * home with pinned state roots, a free port that is neither the production
 * broker (7734) nor the source-review broker (17734), and a containment proof
 * before anything starts. The cosyncing state home is disposable too, so the
 * credential written here is not the installed broker's.
 *
 * A host this script starts by hand, for the enrollment scenarios, is a host
 * cosyncing does NOT own: the point of those scenarios is that enrollment
 * changes the credential and nothing else.
 *
 * Opt-in, because it needs an installed `dsh`:
 *   COSYNCING_DSH_LIVE_INTEGRATION=1 bun run scripts/adapters/dsh-live-integration.ts \
 *     [--dsh <path>] [--port <n>] [--out <dir>] [--keep-home]
 */
export {};

import { spawn, type Subprocess } from 'bun';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { arch, homedir, platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  assertDisposableHome,
  assertRootsContained,
  isolatedStateRoots,
  provisionDocumentsDirectory,
} from './dsh-capture-sandbox.ts';

type ScenarioStatus = 'passed' | 'failed' | 'untested';
interface Scenario {
  name: string;
  status: ScenarioStatus;
  detail: string;
}

const scenarios: Scenario[] = [];
const startedAt = new Date().toISOString();
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

/**
 * A launch token never belongs in a report, a log line, or a terminal scrollback.
 *
 * The host's failure journal is redacted by the lifecycle engine, but this script
 * also echoes what it saw so an operator can read the run, and the child's raw
 * capture reaches a scenario detail on the failure path. A 0.2 launch token buys
 * full control of an agent host and is printed exactly once, so the report — which
 * is the artifact people attach to documents — scrubs it at the single place every
 * detail passes through, rather than at each call site that might remember to.
 */
function scrub(text: string): string {
  return text
    .replace(/([?&]token=)[^\s&"'`]+/g, '$1<redacted>')
    .replace(/(token[=:]\s*)[A-Za-z0-9_-]{20,}/g, '$1<redacted>');
}

function record(name: string, status: ScenarioStatus, detail: string): void {
  const safe = scrub(detail);
  scenarios.push({ name, status, detail: safe });
  console.log(`${status.toUpperCase().padEnd(8)} ${name}${safe ? ` — ${safe}` : ''}`);
}

/** Record whatever happened, including a throw, as a failed scenario. */
async function attempt(name: string, run: () => Promise<{ detail: string }>): Promise<void> {
  try {
    const { detail } = await run();
    record(name, 'passed', detail);
  } catch (error) {
    record(name, 'failed', error instanceof Error ? error.message : String(error));
  }
}

function skip(name: string, why: string): void {
  record(name, 'untested', why);
}

if (process.env.COSYNCING_DSH_LIVE_INTEGRATION !== '1') {
  console.log(JSON.stringify({
    schemaVersion: 1,
    lane: 'dsh-0.2-live-integration',
    status: 'skip',
    reason: 'Set COSYNCING_DSH_LIVE_INTEGRATION=1 to run the no-cost physical pass against an installed dsh.',
  }, null, 2));
  process.exit(0);
}

// ── the machine, and the host we are allowed to touch ───────────────────────

const versionProbe = Bun.spawnSync([arg('dsh') ?? 'dsh', '-V'], { stdout: 'pipe', stderr: 'pipe' });
const dshVersion = versionProbe.stdout.toString().trim() || versionProbe.stderr.toString().trim();
if (!versionProbe.success || dshVersion.length === 0) {
  console.log(JSON.stringify({
    schemaVersion: 1,
    lane: 'dsh-0.2-live-integration',
    status: 'skip',
    reason: 'No `dsh` executable answered `-V`; install @deepseek-ai/dsh or pass --dsh <path>.',
  }, null, 2));
  process.exit(0);
}
const dshPath = Bun.which(arg('dsh') ?? 'dsh') ?? resolve(arg('dsh') ?? 'dsh');

const basePort = Number(arg('port') ?? 17834);
if (!Number.isSafeInteger(basePort) || basePort < 1024 || basePort > 65000) {
  throw new Error('--port must be a free port above 1023');
}
for (const forbidden of [7734, 17734]) {
  if (basePort === forbidden || basePort + 1 === forbidden) {
    throw new Error(`--port ${String(basePort)} would collide with ${forbidden === 7734 ? 'the production broker' : 'the source-review broker'}`);
  }
}
const MANAGED_PORT = basePort;
const EXTERNAL_PORT = basePort + 1;

const home = mkdtempSync(join(tmpdir(), 'cosyncing-dsh-live-'));
// A SIBLING, not a child. The sandbox guard refuses a capture home that contains
// a real data root, and it is right to: a state home inside the home the child
// owns is a directory the host could walk. Two disposable roots, neither of them
// the installed broker's.
const cosyncingHome = mkdtempSync(join(tmpdir(), 'cosyncing-dsh-live-state-'));
assertDisposableHome(home, { cosyncingHome });
const documents = provisionDocumentsDirectory(home);
const roots = isolatedStateRoots(home);
/** The profile half of every credential scope on this run, read once and pinned. */
const PROFILE_DSH_HOME = roots.DSH_HOME ?? join(home, '.dsh');

// The child inherits this process's environment, so the disposable roots are
// installed here rather than per-spawn: the managed launch builds its own
// launch record and cannot be handed an env by this script.
Object.assign(process.env, roots, {
  COSYNCING_HOME: cosyncingHome,
  COSYNCING_DSH_BASE_URL: `http://127.0.0.1:${String(MANAGED_PORT)}`,
  COSYNCING_DSH_MANAGED_HOST: '1',
  PATH: `${dirname(dshPath)}:${process.env.PATH ?? ''}`,
});
for (const name of ['DISPLAY', 'BROWSER', 'XDG_OPEN_DESKTOP', 'WSL_BROWSER']) delete process.env[name];
// Proved against the environment the child will actually inherit, not the pin.
assertRootsContained(home, roots as unknown as Record<string, string>, home);

// Imported after the environment is decided: the credential store, the state
// home and the adapter's base URL all resolve at construction.
const {
  defaultManagedHostEffects, ensureManagedHost, managedHostStore, releaseManagedHost,
} = await import('../../packages/typescript/broker/src/runtime/managed-host.ts');
const { shippedDshAdapter } = await import('../../packages/typescript/broker/src/installation/shipped-adapters.ts');
const { loadDshCookie, dshSessionsPath } = await import('../../packages/typescript/broker/src/security/dsh-credentials.ts');
const { runDshConnectCommand, runDshDisconnectCommand, runDshStatusCommand } = await import('../../packages/typescript/broker/src/cli/dsh-commands.ts');
const { createSetupDiagnosisContext } = await import('../../packages/typescript/broker/src/installation/diagnosis-context.ts');
const { dshCredentialScope } = await import('../../packages/typescript/adapters/dsh/src/index.ts');

const effects = defaultManagedHostEffects();
// The disposable state home, twice over: the ownership record and the credential
// file must not be able to reach the installed broker's.
const owners = managedHostStore(cosyncingHome);
const outDir = arg('out') ?? join('output', 'review', 'dsh-live-integration', startedAt.replace(/[:.]/g, '-'));
mkdirSync(outDir, { recursive: true });

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => { setTimeout(resolveSleep, ms); });

async function waitFor<T>(what: string, probe: () => Promise<T | false>, timeoutMs = 30_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const answer = await probe();
    if (answer !== false) return answer;
    if (Date.now() > until) throw new Error(`timed out after ${String(timeoutMs)} ms waiting for ${what}`);
    await sleep(250);
  }
}

/** Collect what a command printed, so "it never repeats the token" is a checked claim. */
function writers(): {
  stdout: string[];
  stderr: string[];
  out: { write(text: string): void };
  err: { write(text: string): void };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: { write: (text) => { stdout.push(text); } },
    err: { write: (text) => { stderr.push(text); } },
  };
}

let externalHost: Subprocess | undefined;
let managedStarted = false;

try {
  const adapter = shippedDshAdapter();

  // ── 1. cosyncing starts the host: no browser, and no human in the loop ────
  const described = await adapter.describeManagedHost?.();
  const launchArgs: readonly string[] = described?.launch?.args ?? [];
  const launchCommand = described?.launch?.command ?? 'nothing';
  const outcome = await ensureManagedHost(adapter, effects, owners, process.env);
  managedStarted = outcome.action === 'started';
  await attempt('cosyncing starts a real 0.2 host through its own managed-start engine',
    () => (outcome.action === 'started'
      ? Promise.resolve({ detail: `started; the descriptor located it by ${String(described?.locator?.kind ?? 'unknown')}` })
      : Promise.reject(new Error(JSON.stringify(outcome)))));

  await attempt('the managed launch carries the verified no-browser guard',
    () => (launchArgs.includes('--no-open') && launchArgs.includes('--port')
      ? Promise.resolve({ detail: `${String(launchCommand)} ${launchArgs.join(' ')}` })
      : Promise.reject(new Error(JSON.stringify(launchArgs)))));

  await attempt('the child could not have opened a browser even if it wanted to',
    () => (roots.HOME === home
        && process.env.DISPLAY === undefined && process.env.BROWSER === undefined
      ? Promise.resolve({ detail: 'disposable HOME, no DISPLAY, no BROWSER' })
      : Promise.reject(new Error('the child environment still carries a display handoff'))));

  // ── 2. automatic authentication: the announcement, not the operator ───────
  await attempt('the host became reachable to cosyncing with nobody typing anything',
    async () => {
      const available = await waitFor('an authenticated host', async () => ((await adapter.isAvailable()) ? true : false), 45_000);
      return { detail: `isAvailable after the launch announcement; ${String(available) === 'true' ? 'authenticated' : 'not authenticated'}` };
    });

  await attempt('the credential it earned is the one on disk, under this endpoint and profile',
    async () => {
      const scope = dshCredentialScope(`http://127.0.0.1:${String(MANAGED_PORT)}`, PROFILE_DSH_HOME);
      const cookie = loadDshCookie(scope, dshSessionsPath(cosyncingHome));
      return cookie === null
        ? Promise.reject(new Error('no stored session for the host cosyncing started'))
        : Promise.resolve({ detail: `stored cookie named ${cookie.name}; its value is never recorded here` });
    });

  // ── 3. roster and history, the read-only milestone from the plan ─────────
  //
  // Gated on readiness on purpose. A host that refuses the roster answers an
  // empty list, and an ungated record turned that refusal into a green line: the
  // first run of this script reported "0 session(s) listed" as a pass against a
  // host it had never authenticated to. The claim being made is that cosyncing
  // read a roster, so authentication has to be asserted, not assumed.
  await attempt('cosyncing lists the sessions of a real 0.2 host',
    async () => {
      if (!(await adapter.isAvailable())) {
        throw new Error('refused: the host is not authenticated, so an empty roster is a refusal and not a read');
      }
      const roster = await adapter.discoverSessions();
      const first = roster[0];
      return {
        detail: `${String(roster.length)} session(s) listed${first === undefined
          ? ' (a fresh host has none; the authenticated read is what is proven)'
          : `; first is ${first.id} titled ${JSON.stringify(first.title ?? '')}`}`,
      };
    });

  await attempt('a new session appears in the roster and is offered for Drive',
    async () => {
      if (!(await adapter.canCreateSession?.())) throw new Error('the host refused to be asked for a new session');
      const created = await adapter.createSession?.();
      if (!created) throw new Error('createSession returned nothing');
      const again = await adapter.discoverSessions();
      const row = again.find((session) => session.id === created.id);
      if (!row) throw new Error(`created ${created.id} but the roster does not list it`);
      // Where the host decided to put it. This is the fact the create rule rests
      // on: a fresh 0.2 host registers no workspace, and an empty `session/create`
      // request still yields a session with a real cwd, so refusing to ask on the
      // grounds of an empty registry was refusing a host that was ready.
      return {
        detail: `${created.id} listed with drive=${String(row.control?.drive.state)}`
          + `, cwd=${String(row.cwd ?? 'unset')}, blank=${String(row.status)}`,
      };
    });

  // The only mode dsh offers. The adapter refuses `observe` and `resume` for this
  // tool on purpose — one host, one undifferentiated client contract — so asking
  // for a read-only attach here would be testing the policy, not the history read.
  await attempt('opening a real session reads its history through the 0.2 snapshot cut',
    async () => {
      const listed = await adapter.discoverSessions();
      const target = listed[0];
      if (!target) throw new Error('the host lists no session to open');
      const connection = await adapter.attach(target.id, 'live');
      const history = await connection.getHistory({});
      return { detail: `${String(history.length)} message(s) for ${target.id} (a new session has none; the read is what is proven)` };
    });

  // ── 4. broker restart: the cookie outlives the process that earned it ─────
  await attempt('a fresh adapter, with no launch announcement, is still authenticated',
    async () => {
      const restarted = shippedDshAdapter();
      const available = await restarted.isAvailable();
      if (!available) throw new Error('a new adapter could not read the roster with the stored credential');
      const listed = await restarted.discoverSessions();
      return { detail: `${String(listed.length)} session(s) read with the stored cookie alone` };
    });

  // ── 5. doctor reads the same enrollment the adapter wrote ─────────────────
  await attempt('doctor reports the enrollment it shares with the running adapter',
    async () => {
      const context = createSetupDiagnosisContext({ env: process.env, homeDir: home });
      const diagnosis = await shippedDshAdapter().diagnoseSetup?.(context);
      const contract = diagnosis?.checks.find((check) => check.id === 'dsh.contract');
      const enrollment = diagnosis?.checks.find((check) => check.id === 'dsh.enrollment');
      if (contract?.status !== 'pass') throw new Error(`contract=${String(contract?.detailCode ?? 'absent')}`);
      if (enrollment?.status !== 'pass') throw new Error(`enrollment=${String(enrollment?.detailCode ?? 'absent')}`);
      return { detail: `${String(contract.detailCode)} + ${String(enrollment.detailCode)}` };
    });

  // ── 6. an external host: enrolled, and left exactly as it was found ───────
  const externalChild = spawn([dshPath, 'web', '--port', String(EXTERNAL_PORT), '--no-open'], {
    stdout: 'pipe', stderr: 'pipe', env: { ...process.env } as Record<string, string>, cwd: home,
  });
  externalHost = externalChild;
  const scraped: { url?: string } = {};
  const scrape = (async (): Promise<void> => {
    const decoder = new TextDecoder();
    const reader = externalChild.stdout.getReader();
    let buffered = '';
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      buffered += decoder.decode(next.value, { stream: true });
      const match = /http:\/\/127\.0\.0\.1:\d+\/\S*token=\S+/.exec(buffered);
      if (match?.[0]) {
        scraped.url = match[0];
        void reader.cancel();
        return;
      }
    }
  })();
  const externalUrl = await Promise.race([
    scrape.then(() => scraped.url),
    sleep(45_000).then(() => scraped.url),
  ]);

  const externalBaseUrl = `http://127.0.0.1:${String(EXTERNAL_PORT)}`;
  const externalScope = dshCredentialScope(externalBaseUrl, PROFILE_DSH_HOME);
  const cliOptions = {
    invocation: 'cosy', json: true, home: cosyncingHome, baseUrl: externalBaseUrl, env: process.env,
  };
  const connectWriters = writers();

  if (externalUrl === undefined) {
    skip('enrolling a host cosyncing does not own', 'the externally started host printed no launch URL within 45 s');
  } else {
    await attempt('enrolling a host cosyncing does not own, URL delivered on stdin',
      async () => {
        const result = await runDshConnectCommand(
          { ...cliOptions, stdout: connectWriters.out, stderr: connectWriters.err },
          { readLaunchUrl: async () => externalUrl },
        );
        if (result.exitCode !== 0) throw new Error(`${result.detailCode}: ${connectWriters.stderr.join('')}`);
        const cookie = loadDshCookie(externalScope, dshSessionsPath(cosyncingHome));
        if (cookie === null) throw new Error('connect reported success but stored nothing');
        return { detail: `enrolled ${externalBaseUrl}; store written for this cosyncing home only` };
      });

    await attempt('the enrollment output names the host and never repeats the token',
      () => {
        const all = `${connectWriters.stdout.join('')}${connectWriters.stderr.join('')}`;
        const token = new URL(externalUrl).searchParams.get('token') ?? '';
        return token.length > 0 && !all.includes(token)
          ? Promise.resolve({ detail: `${String(all.length)} chars of output, no token in it` })
          : Promise.reject(new Error('the launch token came back out'));
      });

    await attempt('an enrolled external host is left alone by the managed-start engine',
      async () => {
        const forExternal = shippedDshAdapter();
        // Same engine, pointed at a host it did not start. Ownership proof is the
        // only authority to touch a process, so this must decline rather than
        // replace, and the operator's host must still be answering afterwards.
        process.env.COSYNCING_DSH_BASE_URL = externalBaseUrl;
        const result = await ensureManagedHost(forExternal, effects, owners, process.env);
        const still = await forExternal.isAvailable();
        if (!still) throw new Error(`the external host stopped answering after ensure(${result.action})`);
        return { detail: `ensure=${result.action}; the host cosyncing does not own is still serving` };
      });

    await attempt('disconnecting removes cosyncing credential and leaves the host running',
      async () => {
        const disconnectWriters = writers();
        const result = await runDshDisconnectCommand({
          ...cliOptions, stdout: disconnectWriters.out, stderr: disconnectWriters.err,
        });
        if (result.exitCode !== 0) throw new Error(result.detailCode);
        const gone = loadDshCookie(externalScope, dshSessionsPath(cosyncingHome)) === null;
        const probe = await fetch(`${externalBaseUrl}/api/remote.mux`).catch(() => undefined);
        if (!gone) throw new Error('the credential survived disconnect');
        if (probe === undefined) throw new Error('the host stopped answering: disconnect is not supposed to touch it');
        return { detail: `credential removed; host still answers HTTP ${String(probe.status)}` };
      });

    await attempt('status says what to do next once nothing is enrolled',
      async () => {
        const statusWriters = writers();
        const result = await runDshStatusCommand({
          ...cliOptions, stdout: statusWriters.out, stderr: statusWriters.err,
        });
        const printed = statusWriters.stdout.join('') + statusWriters.stderr.join('');
        return result.exitCode === 0 && printed.length > 0
          ? Promise.resolve({ detail: printed.split('\n')[0] ?? 'printed nothing' })
          : Promise.reject(new Error(`status exited ${String(result.exitCode)}`));
      });
  }

  // ── 7. what this pass cannot prove without a paid turn ────────────────────
  const untestedReason = 'needs an owner-authorized provider credential and a spending limit; this pass spends nothing';
  for (const name of [
    'a real prompt and a streamed reply',
    'tool output cards from a live turn',
    'an approval answered through the native browser and through cosyncing',
    'a blocking question, timed or continued',
    'an image attachment carried into the turn',
    'two cosyncing clients sharing one live session with the native browser',
    'reconnect across the history/live boundary during a turn',
  ]) skip(name, untestedReason);
  skip('supervision suspension against a real crash-looping host', 'simulated in the ownership suite; forcing a real crash loop would need a broken host build');
  skip('Windows and macOS lifecycle and auth acceptance', 'this host is Linux/WSL; neither platform was executed here');
} catch (error) {
  record('the pass itself', 'failed', error instanceof Error ? error.message : String(error));
} finally {
  if (managedStarted) {
    await releaseManagedHost(shippedDshAdapter(), effects, owners).catch(() => undefined);
  }
  externalHost?.kill(15);
  await sleep(750);
  if (arg('keep-home') === undefined) {
    rmSync(home, { recursive: true, force: true });
    rmSync(cosyncingHome, { recursive: true, force: true });
  }

  const report = {
    schemaVersion: 1,
    lane: 'dsh-0.2-live-integration',
    startedAt,
    finishedAt: new Date().toISOString(),
    cost: { modelRequests: 0, creditsSpent: 0, note: 'no prompt was sent by this script' },
    candidate: {
      commit: Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim(),
      dirty: Bun.spawnSync(['git', 'status', '--porcelain']).stdout.toString().trim().length > 0,
      bun: Bun.version,
      platform: platform(),
      arch: arch(),
    },
    upstream: { executable: dshPath, version: dshVersion, qualified: '0.2.0-rc.2' },
    isolation: {
      home,
      cosyncingHome,
      stateHomeRemoved: arg('keep-home') === undefined,
      ports: { managed: MANAGED_PORT, external: EXTERNAL_PORT },
      documentsPinned: documents.pinned,
      documentsReason: documents.reason,
      rootsPinned: Object.keys(roots),
      homeRemoved: arg('keep-home') === undefined,
    },
    summary: {
      passed: scenarios.filter((scenario) => scenario.status === 'passed').length,
      failed: scenarios.filter((scenario) => scenario.status === 'failed').length,
      untested: scenarios.filter((scenario) => scenario.status === 'untested').length,
    },
    scenarios,
  };
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nreport: ${join(outDir, 'report.json')}`);
  process.exit(report.summary.failed > 0 ? 1 : 0);
}
