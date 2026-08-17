#!/usr/bin/env bun
/**
 * A broker that cannot start must DIE, and say why.
 *
 * The defect this pins was not a crash — it was the absence of one. Both entry
 * points reported a fatal startup failure by setting `process.exitCode` and
 * returning, which only decides the code used once the event loop drains. A
 * startup that throws part-way has usually already registered a timer, a
 * watcher or a socket, so the loop never drains: the process announced that it
 * had failed and then ran forever, serving nothing.
 *
 * What that cost, concretely. Every fixture that spawns a broker waits on
 * `child.exited` as its fast-fail path, and that promise never settled — so a
 * lost port race, which should be an instant, legible failure, instead burned
 * the full 90-second readiness ceiling and left the broker running after the
 * suite gave up. One observed orphan was still alive at 888 seconds, holding a
 * CPU. Three different sub-suites failed this way on three consecutive gate
 * runs, each looking like an unrelated flake, none of them reproducible alone.
 * A supervisor sees the same thing an operator does: a unit that is "running"
 * and answers nothing.
 *
 * So the assertions here are about the process, not the message: it exits, it
 * exits NON-ZERO, it does so promptly, it still explains itself, and it leaves
 * nothing behind. The port collision is merely the cheapest way to provoke a
 * real startup failure — the property under test is what the entry point does
 * with one.
 *
 *   bun run packages/typescript/broker/test/broker/test-fatal-startup-exit.ts
 */
export {};
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureProcessOutput,
  FIXTURE_BIND_ATTEMPT_CEILING,
  isolatedBrokerFixtureEnvironment,
  reserveLoopbackFixturePort,
  loopbackPortState,
  settledProcessOutput,
  startHealthyFixtureBroker,
  UNREAPED_CHILD_PREFIX,
  waitForBrokerHealth,
} from '../helpers/isolated-broker-fixture.ts';
import { forcesFatalExit } from '../../src/cli/cli.ts';

const ROOT = join(import.meta.dir, '../../../../..');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'cosyncing-fatal-startup-'));

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Hold a loopback port so the next binder must fail. */
async function occupy(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

async function release(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function freePort(): Promise<number> {
  const lease = await reserveLoopbackFixturePort();
  await lease.release();
  return lease.port;
}

/** Nothing of ours may still hold the port once the attempt is over. */
async function portIsFree(port: number): Promise<boolean> {
  const probe = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', resolve);
    });
  } catch {
    return false;
  }
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return true;
}

const SETTLE_CEILING_MS = 20_000;

/**
 * Spawn an entry point onto an occupied port and report how it ended.
 *
 * The deadline is the assertion: the old behavior was not a slow exit but no
 * exit at all, so "did it finish inside a short window" is exactly the
 * property. It is set far above a real exit (milliseconds) and far below the
 * 90-second fixture ceiling that used to absorb this.
 */
async function startupAgainstOccupiedPort(argv: string[], label: string): Promise<{
  exited: boolean;
  exitCode: number | null;
  output: string;
  survived: boolean;
}> {
  const port = await freePort();
  const squatter = await occupy(port);
  const home = join(fixtureRoot, label);
  const child = Bun.spawn(argv, {
    cwd: ROOT,
    env: isolatedBrokerFixtureEnvironment(join(fixtureRoot, `${label}-env`), {
      overrides: {
        HOST: '127.0.0.1',
        PORT: String(port),
        COSYNCING_HOME: home,
        COSYNCING_TOKEN: 'fatal-startup-token',
        COSYNCING_RESTART_DRY_RUN: '1',
        COSYNCING_CLAUDE_HOOKS: '0',
      },
    }),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const captured = captureProcessOutput(child, { maxChars: 8_000 });
  const exited = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(SETTLE_CEILING_MS).then(() => false),
  ]);
  // A process that never exited is the defect itself, so it is killed AND
  // REAPED before anything else happens. Awaiting matters more here than
  // almost anywhere: a suite that proves brokers do not leak must not leave one
  // running while it tears down the fixture around it. Draining output,
  // releasing the port and deleting the fixture root all assume nothing is
  // still writing, listening, or holding a file open.
  const survived = !exited && child.exitCode === null;
  if (survived) {
    child.kill('SIGKILL');
    await child.exited.catch(() => undefined);
  }
  const output = await settledProcessOutput(captured);
  await release(squatter);
  return { exited, exitCode: child.exitCode, output, survived };
}

// ── The source entry point: `bun packages/typescript/broker/src/main.ts` ─────
{
  const result = await startupAgainstOccupiedPort(
    ['bun', 'packages/typescript/broker/src/main.ts'],
    'main',
  );
  check('main.ts exits when the port it needs is taken, instead of running forever',
    result.exited, result.survived ? 'still running at the deadline' : 'exited');
  check('...non-zero, so a spawner can tell it failed',
    result.exitCode !== null && result.exitCode !== 0, `exit=${result.exitCode}`);
  check('...and the diagnostic survives the exit',
    /broker failed/.test(result.output) && /port/i.test(result.output),
    JSON.stringify(result.output.trim().slice(-160)));
}

// ── The packaged entry point: the real `cli.ts broker` command ───────────────
//
// Covered separately because it fails through a DIFFERENT path — `runCli`
// returns an exit code rather than throwing, and its diagnostic goes out
// through a buffered stream writer, so exiting on top of it can truncate
// exactly the message that makes the failure diagnosable.
{
  const result = await startupAgainstOccupiedPort(
    ['bun', 'packages/typescript/broker/src/cli/cli.ts', 'broker', '--dev-bypass-first-run'],
    'cli',
  );
  check('the cli broker command exits when the port it needs is taken',
    result.exited, result.survived ? 'still running at the deadline' : 'exited');
  check('...non-zero, so a service manager sees a failed start',
    result.exitCode !== null && result.exitCode !== 0, `exit=${result.exitCode}`);
  check('...and its buffered diagnostic is flushed rather than truncated by the exit',
    /broker failed/.test(result.output),
    JSON.stringify(result.output.trim().slice(-160)));
}

// ── The forced exit is SCOPED to the broker command ─────────────────────────
//
// Starting a server is the one command that can leave the event loop non-empty
// after it fails. Every other command returns from work that holds nothing
// open, so forcing an exit would buy nothing and could cut short whatever it is
// still flushing. A rejected argument is the cheapest non-broker failure to
// provoke: it must still exit non-zero, and still say why, by draining.
{
  const child = Bun.spawn(
    ['bun', 'packages/typescript/broker/src/cli/cli.ts', 'broker', '--not-a-real-flag'],
    { cwd: ROOT, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  );
  const captured = captureProcessOutput(child, { maxChars: 4_000 });
  const exited = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(SETTLE_CEILING_MS).then(() => false),
  ]);
  if (!exited) {
    child.kill('SIGKILL');
    await child.exited.catch(() => undefined);
  }
  const output = await settledProcessOutput(captured);
  check('a rejected argument still exits non-zero on its own',
    exited && child.exitCode === 2, `exit=${child.exitCode}`);
  check('...with its diagnostic intact',
    /unknown option/.test(output), JSON.stringify(output.trim().slice(-120)));

  // The check above cannot tell the two policies apart — a forced exit and a
  // natural drain both end a `broker --bad-flag` at code 2 with its message
  // delivered, because that command holds nothing open. So the policy itself is
  // asserted, which is the only place the distinction is visible.
  check('only a FAILED broker invocation forces the process to exit',
    forcesFatalExit(['broker'], 1)
      && !forcesFatalExit(['broker'], 0)
      && !forcesFatalExit(['doctor'], 1)
      && !forcesFatalExit(['setup'], 2)
      && !forcesFatalExit(['uninstall'], 1)
      && !forcesFatalExit([], 1),
    'broker+nonzero only');
}

// ── No survivors ────────────────────────────────────────────────────────────
//
// The leak and the hang are the same defect seen from two sides, so the
// absence of a listener is asserted directly rather than inferred from the
// exit code.
{
  const port = await freePort();
  const squatter = await occupy(port);
  const child = Bun.spawn(['bun', 'packages/typescript/broker/src/main.ts'], {
    cwd: ROOT,
    env: isolatedBrokerFixtureEnvironment(join(fixtureRoot, 'survivor-env'), {
      overrides: {
        HOST: '127.0.0.1',
        PORT: String(port),
        COSYNCING_HOME: join(fixtureRoot, 'survivor'),
        COSYNCING_TOKEN: 'fatal-startup-token',
        COSYNCING_CLAUDE_HOOKS: '0',
      },
    }),
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const exited = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(SETTLE_CEILING_MS).then(() => false),
  ]);
  // Reaped before the port is released or probed. Without the await, the
  // survivor could still be holding the port when `portIsFree` runs — the check
  // would report the leak it was meant to detect as an unrelated failure, or
  // pass by racing it.
  if (!exited) {
    child.kill('SIGKILL');
    await child.exited.catch(() => undefined);
  }
  await release(squatter);
  check('the failed broker leaves no child behind', exited);
  check('...and no listener of its own', await portIsFree(port));
}

// ── The fixture survives a lost port race, exactly once ─────────────────────
//
// Fast exit alone converts the 90-second hang into an immediate failure, which
// is better but still red: the collision is nobody's bug. The shared starter
// therefore retries onto a fresh port. The first attempt here is guaranteed to
// collide, so a healthy result proves the retry happened.
{
  const contested = await freePort();
  const squatter = await occupy(contested);
  let attempts = 0;
  const ports: number[] = [];
  const { child, port } = await startHealthyFixtureBroker({
    // Hands out the occupied port first, then real ones — the deterministic
    // stand-in for a sibling fixture winning the race.
    reservePort: async () => {
      attempts += 1;
      const chosen = attempts === 1 ? contested : await freePort();
      ports.push(chosen);
      return chosen;
    },
    spawn: (attemptPort) => Bun.spawn(['bun', 'packages/typescript/broker/src/main.ts'], {
      cwd: ROOT,
      env: isolatedBrokerFixtureEnvironment(join(fixtureRoot, `retry-env-${attemptPort}`), {
        overrides: {
          HOST: '127.0.0.1',
          PORT: String(attemptPort),
          COSYNCING_HOME: join(fixtureRoot, `retry-${attemptPort}`),
          COSYNCING_TOKEN: 'fatal-startup-token',
          COSYNCING_CLAUDE_HOOKS: '0',
        },
      }),
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    }),
    healthUrl: (attemptPort) => `http://127.0.0.1:${attemptPort}/api/health`,
    stop: async (spawned) => { spawned.kill('SIGTERM'); await spawned.exited.catch(() => undefined); },
  });
  check('a broker that lost the port race is respawned onto a fresh one',
    attempts === 2, `attempts=${attempts}`);
  check('...and the one that is returned is actually serving',
    port !== contested && (await fetch(`http://127.0.0.1:${port}/api/health`)).ok,
    `contested=${contested} serving=${port}`);
  child.kill('SIGTERM');
  await child.exited.catch(() => undefined);
  await release(squatter);
}

// ── A startup failure that is NOT a collision is never retried ───────────────
//
// The retry is only defensible while it stays narrow. Re-running an ordinary
// startup defect does not fix it; it converts a reproducible failure into an
// intermittent one that takes three times as long to report, which is the more
// expensive bug to own.
{
  let attempts = 0;
  let thrown = '';
  try {
    await startHealthyFixtureBroker({
      reservePort: async () => { attempts += 1; return await freePort(); },
      // Exits non-zero immediately, with the port left free — a broker with a
      // bad configuration, not a broker that lost a race.
      spawn: () => Bun.spawn(['bun', '-e', 'process.exit(3)'], {
        cwd: ROOT,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      }),
      healthUrl: (attemptPort) => `http://127.0.0.1:${attemptPort}/api/health`,
      healthOptions: { timeoutMs: 5_000 },
    });
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  }
  check('a non-collision startup failure is reported, not retried',
    attempts === 1, `attempts=${attempts}`);
  check('...with the original failure surfaced',
    /exited with code 3/.test(thrown), thrown);
}

// ── A SUGGESTION is not a proof ─────────────────────────────────────────────
//
// "Is port N in use?" is the generic question Bun asks whenever a server fails
// to start — a bad host, a privileged port, a listener it could not create. It
// reads like a verdict and is not one. Accepting it would retry ordinary
// startup defects, which is the failure mode the classifier exists to avoid,
// so only the kernel's own answer counts when the port itself is free.
{
  const spawnSaying = (text: string) => () => {
    const child = Bun.spawn(['bun', '-e', `console.error(${JSON.stringify(text)}); process.exit(1)`], {
      cwd: ROOT,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return child;
  };

  const runClassification = async (text: string): Promise<number> => {
    let attempts = 0;
    let captured!: ReturnType<typeof captureProcessOutput>;
    try {
      await startHealthyFixtureBroker({
        reservePort: async () => { attempts += 1; return await freePort(); },
        spawn: () => {
          const child = spawnSaying(text)();
          captured = captureProcessOutput(child, { maxChars: 4_000 });
          return child;
        },
        healthUrl: (attemptPort) => `http://127.0.0.1:${attemptPort}/api/health`,
        capture: () => captured,
        healthOptions: { timeoutMs: 5_000 },
      });
    } catch { /* every case here fails; the attempt count is the assertion */ }
    return attempts;
  };

  // The port is free in both runs, so the ONLY difference is what the child said.
  check('Bun\'s generic "is port in use?" question alone does not trigger a retry',
    await runClassification('error: Failed to start server. Is port 45999 in use?') === 1,
    'a suggestion must not be read as a collision');
  check('...while a definitive EADDRINUSE is retried',
    await runClassification('listen EADDRINUSE: address already in use 127.0.0.1:45999')
      === FIXTURE_BIND_ATTEMPT_CEILING,
    `ceiling=${FIXTURE_BIND_ATTEMPT_CEILING}`);

  // Classification must read the SETTLED output, not a snapshot. `child.exited`
  // resolving does not empty the pipes, so a snapshot can miss the last chunk —
  // and the last chunk is exactly where a bind failure prints.
  //
  // Driven through the two hooks directly rather than a real slow-draining
  // child: the two readers are handed contradictory answers, so the retry count
  // says which one the classifier actually consulted. A timing-based version of
  // this test passed no matter which reader was wired up, which is worse than
  // no test — it reads like proof and is not.
  let splitAttempts = 0;
  try {
    await startHealthyFixtureBroker({
      reservePort: async () => { splitAttempts += 1; return await freePort(); },
      spawn: () => Bun.spawn(['bun', '-e', 'process.exit(1)'], {
        cwd: ROOT, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
      }),
      healthUrl: (attemptPort) => `http://127.0.0.1:${attemptPort}/api/health`,
      peekOutput: () => '',
      readSettledOutput: async () => 'listen EADDRINUSE: address already in use 127.0.0.1:45999',
      healthOptions: { timeoutMs: 5_000 },
    });
  } catch { /* expected: it never becomes healthy */ }
  check('a collision visible only in SETTLED output is still classified',
    splitAttempts === FIXTURE_BIND_ATTEMPT_CEILING,
    `attempts=${splitAttempts} (reading the snapshot instead would stop at 1)`);
}

// ── Silent startup stall: contained, once, and only when PROVEN ─────────────
//
// A spawned broker occasionally comes up alive, silent, and serving nothing.
// This is CI containment for that, not a claim about its cause, so the
// predicate is deliberately hard to satisfy: alive, not listening, zero bytes
// written, and a separate short deadline expired. Each negative control below
// removes exactly one of those and proves nothing is retried without it.
{
  const wedged = (script: string, port: number) => Bun.spawn(['bun', '-e', script], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const runStarter = async (
    script: string,
    opts: { silentStartMs?: number; omitStop?: boolean; inertStop?: boolean } = {},
  ) => {
    let attempts = 0;
    const spawned: ReturnType<typeof Bun.spawn>[] = [];
    let captured!: ReturnType<typeof captureProcessOutput>;
    let thrown = '';
    try {
      await startHealthyFixtureBroker({
        reservePort: async () => { attempts += 1; return await freePort(); },
        spawn: (attemptPort) => {
          const child = wedged(script, attemptPort);
          spawned.push(child);
          captured = captureProcessOutput(child, { maxChars: 4_000 });
          return child;
        },
        healthUrl: (p) => `http://127.0.0.1:${p}/api/health`,
        // Explicit hooks, not `capture`: the wedged child never reaches EOF,
        // so this path takes the short settle bound rather than the default.
        peekOutput: () => captured.read(),
        readSettledOutput: () => settledProcessOutput(captured, 500),
        // `omitStop` models a caller that never supplied one; `inertStop`
        // models a stop that returns cleanly while the process lives on —
        // indistinguishable to anyone who only awaited it.
        ...(opts.omitStop ? {} : {
          stop: async (child: unknown) => {
            if (opts.inertStop) return;
            (child as ReturnType<typeof Bun.spawn>).kill('SIGKILL');
            await (child as ReturnType<typeof Bun.spawn>).exited.catch(() => undefined);
          },
        }),
        healthOptions: { timeoutMs: 8_000 },
        silentStartMs: opts.silentStartMs ?? 1_000,
      });
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    for (const child of spawned) {
      child.kill('SIGKILL');
      await child.exited.catch(() => undefined);
    }
    return { attempts, thrown };
  };

  // Alive, silent, never listening — the shape actually observed. Retried once,
  // then reported with both attempts' evidence rather than retried again.
  const stalled = await runStarter('setInterval(() => {}, 1000)');
  check('a silent, listener-less, output-less start is retried exactly once',
    stalled.attempts === 2, `attempts=${stalled.attempts}`);
  check('...and a stalled replacement fails with BOTH attempts as evidence',
    /attempt 1:/.test(stalled.thrown) && /attempt 2:/.test(stalled.thrown),
    JSON.stringify(stalled.thrown.slice(0, 160)));

  // SPOKE. Startup prints before it listens, so a byte of output means the
  // loader is running — slow, not wedged.
  const talking = await runStarter('console.error("starting up"); setInterval(() => {}, 1000)');
  check('a slow-but-progressing start that has written something is NOT retried',
    talking.attempts === 1, `attempts=${talking.attempts}`);

  // EXITED with a diagnostic: a real startup defect, which must never be
  // laundered into a flake by re-running it.
  const failed = await runStarter('console.error("bad configuration"); process.exit(2)');
  check('a start that failed with a diagnostic is NOT retried',
    failed.attempts === 1, `attempts=${failed.attempts}`);

  // LISTENING but not answering health: it did the thing a respawn would be
  // for, so respawning buys nothing.
  const listening = await runStarter(
    'const p = Number(process.env.PORT); Bun.serve({ port: p, fetch: () => new Response("no", { status: 500 }) });'
      + ' setInterval(() => {}, 1000)',
  );
  check('a start that opened its listener is NOT retried',
    listening.attempts === 1, `attempts=${listening.attempts}`);

  // ── Retirement is a PRECONDITION of a respawn, not cleanup after one ───────
  //
  // A stalled child is still running. If it cannot be reaped it may yet finish
  // loading and take the port its replacement is about to bind, and the suite
  // would then be watching whichever of the two it happens to hold. So a
  // retirement that cannot be proven stops the retry instead of preceding it.
  const noStop = await runStarter('setInterval(() => {}, 1000)', { omitStop: true });
  check('a silent stall is NOT retried when the fixture cannot stop the child',
    noStop.attempts === 1, `attempts=${noStop.attempts}`);
  check('...and says why, rather than reporting an ordinary stall',
    /without a stop function/.test(noStop.thrown), noStop.thrown.slice(0, 200));

  // A stop that returns cleanly while the process lives on is the dangerous
  // one: it looks like success to anyone who only awaited it.
  const inert = await runStarter('setInterval(() => {}, 1000)', { inertStop: true });
  check('a stop that leaves the process alive refuses to respawn beside it',
    inert.attempts === 1, `attempts=${inert.attempts}`);
  check('...naming the survivor rather than blaming the broker',
    inert.thrown.includes(UNREAPED_CHILD_PREFIX), inert.thrown.slice(0, 200));
}

// ── The probe OBSERVES the port; it must never take it ───────────────────────
//
// The obvious probe binds the port to see whether that works, and one caller
// runs it while a live child may be mid-bind — so the probe would cause the
// very EADDRINUSE it exists to report, intermittently, under exactly the load
// that makes the race likely. Connecting cannot do that. Proof: probe the same
// port continuously while binding it, and the bind must never lose.
{
  const port = await freePort();
  let bindFailure = '';
  const probing = (async () => {
    for (let i = 0; i < 40; i += 1) await loopbackPortState(port);
  })();
  await Bun.sleep(5);
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) {
    bindFailure = error instanceof Error ? error.message : String(error);
  }
  await probing;
  check('probing a port never prevents binding it', bindFailure === '', bindFailure);
  check('...and the probe still sees a listener once one exists',
    (await loopbackPortState(port)) === 'listening');
  await release(server);
  check('...and reports a vacated port as free, not merely unknown',
    (await loopbackPortState(port)) === 'free');
}

// ── The health wait still fails closed on a broker that never speaks ─────────
{
  const port = await freePort();
  const silent = createServer();
  await new Promise<void>((resolve) => silent.listen(port, '127.0.0.1', resolve));
  let message = '';
  try {
    await waitForBrokerHealth(
      { exitCode: null, exited: new Promise<number>(() => {}) },
      `http://127.0.0.1:${port}/api/health`,
      { timeoutMs: 1_500 },
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  await release(silent);
  check('a listener that never answers health still times out rather than hanging',
    /did not become healthy/.test(message), message);
}

rmSync(fixtureRoot, { recursive: true, force: true });
console.log(failures ? `\nFAIL: ${failures} check(s) failed.` : '\nAll fatal-startup checks passed.');
process.exit(failures ? 1 : 0);
