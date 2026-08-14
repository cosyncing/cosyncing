/**
 * D20 / issues-part2 — orphan-serve TAKE-OVER at broker startup, GATED ON OWNERSHIP PROOF.
 *
 * :4096 is OpenCode's default serve port, so a reachable serve there may be the USER'S OWN. The broker must
 * NEVER dispose or kill a serve it cannot prove it started. Ownership proof = a durable record (pid + a
 * stable start token + comm + base) written when the broker spawns the serve, re-verified against the live
 * listener's identity on the next startup. Only a PROVEN-owned serve is reclaimed; everything else is
 * preserved untouched.
 *
 * Part A — the pure `classifyServeOwnership` decision (no processes), covering every branch:
 *   owned · unowned (no record / base mismatch / pid mismatch) · pid-reuse · wrong-exe · indeterminate.
 *
 * Part B — the `ensureManagedOpencodeServe` WIRING, made deterministic via `__setLiveIdentityOverrideForTest`
 * (so it does not depend on lsof / `/proc` / `ps` in CI) plus a fake in-process serve and a fake `opencode`
 * binary first on PATH (no real OpenCode process is ever started):
 *   1. PROVEN owned            → reclaimed (module becomes OWNED; a config bump would restart it).
 *   2. unowned + autoserve ON  → PRESERVED untouched (the safety fix: a stranger's serve is never killed).
 *   3. indeterminate identity  → PRESERVED untouched.
 *   4. pid-reuse / wrong-exe   → PRESERVED untouched.
 *   5. opt-out                 → PRESERVED untouched (no take-over, no spawn).
 *   6. failed reclaim          → DEGRADED (module stays unmanaged, record cleared), never blindly adopted.
 *   7. operator REPLACE_UNOWNED=1 → the escape hatch takes over an unproven serve.
 *
 *   COSYNCING_HOME is redirected to a temp dir so ownership records never touch the real ~/.cosyncing.
 *
 *   bun run packages/typescript/broker/test/broker/test-opencode-serve-takeover.ts
 */
export {};
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __clearOpencodeServeOwnershipForTest,
  __getManagedOpencodeServeStateForTest,
  __resetOpencodeConfigWatchForTest,
  __setLiveIdentityOverrideForTest,
  __writeOpencodeServeOwnershipForTest,
  classifyServeOwnership,
  ensureManagedOpencodeServe,
  evaluateConfigRestart,
  stopManagedOpencodeServe,
  type OpencodeServeOwnership,
  type ProcessIdentity,
} from '../../../adapters/opencode/src/managed-server.ts';
import '../../src/runtime/managed-runtime-state.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

async function serveReachable(baseUrl: string): Promise<boolean> {
  try {
    return (await fetch(`${baseUrl}/session`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

/**
 * A fake pre-existing serve. `disposes: true` → it stops itself on POST /*dispose* (so the take-over's
 * graceful path frees the port without signaling a PID — the in-process listener is THIS test process, which
 * must never be SIGTERM'd). `disposes: false` → a stubborn serve that ignores dispose (used to prove the
 * failed-reclaim path degrades safely rather than blindly adopting).
 */
function startFakeServe(opts: { disposes: boolean } = { disposes: true }): { server: ReturnType<typeof Bun.serve>; port: number } {
  let server: ReturnType<typeof Bun.serve> | undefined;
  for (let attempt = 0; attempt < 20 && !server; attempt++) {
    try {
      server = Bun.serve({
        hostname: '127.0.0.1',
        port: 50000 + Math.floor(Math.random() * 15000),
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === '/session' && req.method === 'GET') return Response.json([]);
          if (req.method === 'POST' && url.pathname.includes('dispose')) {
            if (opts.disposes) setTimeout(() => { try { server?.stop(true); } catch { /* already stopped */ } }, 0);
            return new Response('ok');
          }
          return new Response('not found', { status: 404 });
        },
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
  if (!server) throw new Error('Could not allocate a fake OpenCode serve port after 20 attempts.');
  return { server, port: Number(server.port) };
}

// A fake `opencode` binary: `opencode serve --hostname H --port P` starts a tiny HTTP server answering
// GET /session, so the broker's post-spawn reachability probe succeeds and `managed` stays set. It retries
// the bind while the freed port is released, then stays alive until killed on teardown.
const fakeBinDir = mkdtempSync(join(tmpdir(), 'cosyncing-fake-opencode-'));
const fakeBin = join(fakeBinDir, 'opencode');
writeFileSync(
  fakeBin,
  `#!${process.execPath}
const args = Bun.argv.slice(2);
const hIdx = args.indexOf('--hostname');
const pIdx = args.indexOf('--port');
const hostname = hIdx >= 0 ? args[hIdx + 1] : '127.0.0.1';
const port = Number(pIdx >= 0 ? args[pIdx + 1] : 4096);
let server;
for (let i = 0; i < 60 && !server; i++) {
  try { server = Bun.serve({ hostname, port, fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === '/session') return Response.json([]);
    return new Response('ok');
  } }); } catch (e) { if (e.code !== 'EADDRINUSE') throw e; await Bun.sleep(50); }
}
if (!server) process.exit(1);
await new Promise(() => {});
`,
  { mode: 0o755 },
);
chmodSync(fakeBin, 0o755);

const homeDir = mkdtempSync(join(tmpdir(), 'cosyncing-home-'));
const savedEnv = {
  OPENCODE_URL: process.env.OPENCODE_URL,
  NO_AUTOSERVE: process.env.COSYNCING_OPENCODE_NO_AUTOSERVE,
  REPLACE_UNOWNED: process.env.COSYNCING_OPENCODE_REPLACE_UNOWNED_SERVE,
  HOME_OVERRIDE: process.env.COSYNCING_HOME,
  PATH: process.env.PATH,
};
process.env.PATH = `${fakeBinDir}:${process.env.PATH ?? ''}`;
process.env.COSYNCING_HOME = homeDir;

/** Reset per-case module + env state (never leak a record, override, or opt-out between cases). */
function resetCase(): void {
  __resetOpencodeConfigWatchForTest();
  __setLiveIdentityOverrideForTest(null);
  __clearOpencodeServeOwnershipForTest();
  delete process.env.COSYNCING_OPENCODE_NO_AUTOSERVE;
  delete process.env.COSYNCING_OPENCODE_REPLACE_UNOWNED_SERVE;
}

try {
  // ── Part A: the pure ownership decision ────────────────────────────────────────────────────────────
  const base = 'http://127.0.0.1:4096';
  const rec = (over: Partial<OpencodeServeOwnership> = {}): OpencodeServeOwnership => ({
    schemaVersion: 1, pid: 4242, start: '111', comm: 'opencode', baseUrl: base, recordedAtMs: 0, ...over,
  });
  const live = (over: Partial<ProcessIdentity> = {}): ProcessIdentity => ({ pid: 4242, start: '111', comm: 'opencode', ...over });

  check('classify: pid+start+comm all match → owned', classifyServeOwnership(rec(), live(), base) === 'owned');
  check('classify: no record → unowned (external serve)', classifyServeOwnership(null, live(), base) === 'unowned');
  check('classify: base mismatch → unowned', classifyServeOwnership(rec({ baseUrl: 'http://127.0.0.1:9999' }), live(), base) === 'unowned');
  check('classify: pid mismatch (stale) → unowned', classifyServeOwnership(rec(), live({ pid: 9999 }), base) === 'unowned');
  check('classify: pid reuse (start differs) → unowned', classifyServeOwnership(rec(), live({ start: '222' }), base) === 'unowned');
  check('classify: wrong executable (comm differs) → unowned', classifyServeOwnership(rec(), live({ comm: 'python' }), base) === 'unowned');
  check('classify: live identity unresolved → indeterminate', classifyServeOwnership(rec(), null, base) === 'indeterminate');

  // ── Part B: ensureManagedOpencodeServe wiring ──────────────────────────────────────────────────────

  // 1. PROVEN owned → reclaimed. Override the live identity and write a matching record; the fake serve
  //    frees the port via graceful dispose, then the broker relaunches an owned serve.
  {
    resetCase();
    const orphan = startFakeServe({ disposes: true });
    const b = `http://127.0.0.1:${orphan.port}`;
    process.env.OPENCODE_URL = b;
    const identity: ProcessIdentity = { pid: 123456, start: 'S', comm: 'opencode' };
    __setLiveIdentityOverrideForTest(() => identity);
    __writeOpencodeServeOwnershipForTest(identity, b);

    check('owned: precondition — orphan reachable', await serveReachable(b));
    await ensureManagedOpencodeServe();
    const owned = __getManagedOpencodeServeStateForTest();
    check('owned: reclaimed — module is broker-OWNED', owned.managed === true, JSON.stringify(owned));
    check('owned: managedStartedAt non-zero', owned.managedStartedAt > 0, `managedStartedAt=${owned.managedStartedAt}`);
    check('owned: managedBaseUrl pinned', owned.managedBaseUrl === b, `managedBaseUrl=${owned.managedBaseUrl}`);
    const decision = evaluateConfigRestart({
      cfgMtime: owned.managedStartedAt + 60_000, managedStartedAt: owned.managedStartedAt,
      pendingSince: 0, now: owned.managedStartedAt + 61_000, busy: false, maxDeferMs: 10 * 60_000,
    });
    check('owned: a later config bump would restart the owned serve', decision.restart === true, JSON.stringify(decision));
    await stopManagedOpencodeServe();
    try { orphan.server.stop(true); } catch { /* already disposed */ }
  }

  // 2. unowned + autoserve ON → PRESERVED (the safety fix: never kill a serve we didn't start).
  {
    resetCase();
    const foreign = startFakeServe({ disposes: true });
    const b = `http://127.0.0.1:${foreign.port}`;
    process.env.OPENCODE_URL = b;
    __setLiveIdentityOverrideForTest(() => ({ pid: 777, start: 'X', comm: 'opencode' })); // resolvable, but NO record
    await ensureManagedOpencodeServe();
    const state = __getManagedOpencodeServeStateForTest();
    check('unowned: module stays UNMANAGED (no take-over)', state.managed === false, JSON.stringify(state));
    check('unowned: the foreign serve is untouched (still reachable)', await serveReachable(b));
    try { foreign.server.stop(true); } catch { /* stopped */ }
  }

  // 3. indeterminate identity → PRESERVED.
  {
    resetCase();
    const foreign = startFakeServe({ disposes: true });
    const b = `http://127.0.0.1:${foreign.port}`;
    process.env.OPENCODE_URL = b;
    __setLiveIdentityOverrideForTest(() => null); // cannot identify the listener
    await ensureManagedOpencodeServe();
    const state = __getManagedOpencodeServeStateForTest();
    check('indeterminate: module stays UNMANAGED', state.managed === false, JSON.stringify(state));
    check('indeterminate: the serve is untouched (still reachable)', await serveReachable(b));
    try { foreign.server.stop(true); } catch { /* stopped */ }
  }

  // 4. pid reuse / wrong-exe → PRESERVED (record present but the live process is not the one we started).
  {
    resetCase();
    const foreign = startFakeServe({ disposes: true });
    const b = `http://127.0.0.1:${foreign.port}`;
    process.env.OPENCODE_URL = b;
    __writeOpencodeServeOwnershipForTest({ pid: 555, start: 'A', comm: 'opencode' }, b);
    __setLiveIdentityOverrideForTest(() => ({ pid: 555, start: 'B', comm: 'opencode' })); // same pid, different start → reuse
    await ensureManagedOpencodeServe();
    const state = __getManagedOpencodeServeStateForTest();
    check('pid-reuse: module stays UNMANAGED', state.managed === false, JSON.stringify(state));
    check('pid-reuse: the serve is untouched (still reachable)', await serveReachable(b));
    try { foreign.server.stop(true); } catch { /* stopped */ }
  }

  // 5. opt-out → PRESERVED (never even classified).
  {
    resetCase();
    const userServe = startFakeServe({ disposes: true });
    const b = `http://127.0.0.1:${userServe.port}`;
    process.env.OPENCODE_URL = b;
    process.env.COSYNCING_OPENCODE_NO_AUTOSERVE = '1';
    // Even a matching record + owned identity must not matter when opted out.
    const identity: ProcessIdentity = { pid: 999, start: 'Z', comm: 'opencode' };
    __setLiveIdentityOverrideForTest(() => identity);
    __writeOpencodeServeOwnershipForTest(identity, b);
    await ensureManagedOpencodeServe();
    const state = __getManagedOpencodeServeStateForTest();
    check('opt-out: module stays UNMANAGED', state.managed === false, JSON.stringify(state));
    check('opt-out: the user-owned serve is untouched (still reachable)', await serveReachable(b));
    try { userServe.server.stop(true); } catch { /* stopped */ }
  }

  // 6. failed reclaim → DEGRADED, never blindly adopted. Owned by classification, but a stubborn serve that
  //    ignores dispose (and whose real listener is this process, so it is never signaled) can't be freed.
  {
    resetCase();
    const stubborn = startFakeServe({ disposes: false });
    const b = `http://127.0.0.1:${stubborn.port}`;
    process.env.OPENCODE_URL = b;
    const identity: ProcessIdentity = { pid: 424242, start: 'S', comm: 'opencode' };
    __setLiveIdentityOverrideForTest(() => identity);
    __writeOpencodeServeOwnershipForTest(identity, b);
    await ensureManagedOpencodeServe();
    const state = __getManagedOpencodeServeStateForTest();
    check('failed-reclaim: module stays UNMANAGED (no blind adoption)', state.managed === false, JSON.stringify(state));
    check('failed-reclaim: the serve is left in place (still reachable)', await serveReachable(b));
    try { stubborn.server.stop(true); } catch { /* stopped */ }
  }

  // 7. operator escape hatch: REPLACE_UNOWNED=1 takes over an unproven serve.
  {
    resetCase();
    const foreign = startFakeServe({ disposes: true });
    const b = `http://127.0.0.1:${foreign.port}`;
    process.env.OPENCODE_URL = b;
    process.env.COSYNCING_OPENCODE_REPLACE_UNOWNED_SERVE = '1';
    __setLiveIdentityOverrideForTest(() => ({ pid: 321, start: 'Q', comm: 'foreign' })); // unproven (no record)
    await ensureManagedOpencodeServe();
    const state = __getManagedOpencodeServeStateForTest();
    check('replace-unowned: escape hatch takes over → module is OWNED', state.managed === true, JSON.stringify(state));
    check('replace-unowned: managedBaseUrl pinned', state.managedBaseUrl === b, `managedBaseUrl=${state.managedBaseUrl}`);
    await stopManagedOpencodeServe();
    try { foreign.server.stop(true); } catch { /* already disposed */ }
  }

  // 8. TOCTOU (Codex finding 1): PROVEN owned at classification, but the listener CHANGES before take-over
  //    acts (the proven process exited and another serve grabbed the port). Take-over must re-validate and
  //    ABORT — never dispose/kill the replacement. The identity override returns the proven id A on the
  //    classify call, then a different id B on the take-over's re-validation.
  {
    resetCase();
    const stranger = startFakeServe({ disposes: true }); // would dispose itself IF asked — we assert it is NOT asked
    const b = `http://127.0.0.1:${stranger.port}`;
    process.env.OPENCODE_URL = b;
    const A: ProcessIdentity = { pid: 111111, start: 'A', comm: 'opencode' };
    const B: ProcessIdentity = { pid: 222222, start: 'B', comm: 'opencode' };
    __writeOpencodeServeOwnershipForTest(A, b); // record matches A → classification is 'owned'
    let calls = 0;
    __setLiveIdentityOverrideForTest(() => { calls += 1; return calls === 1 ? A : B; }); // classify sees A; take-over sees B
    await ensureManagedOpencodeServe();
    const state = __getManagedOpencodeServeStateForTest();
    check('race: listener changed after classify → module stays UNMANAGED (take-over aborted)', state.managed === false, JSON.stringify(state));
    check('race: the changed listener was NOT disposed (still reachable)', await serveReachable(b));
    check('race: take-over re-validated (more than the single classify probe ran)', calls >= 2, `identity probes=${calls}`);
    try { stranger.server.stop(true); } catch { /* stopped */ }
  }

  // 9. TOCTOU BETWEEN the two PORT-addressed dispose calls (Codex finding 1 follow-up). /instance/dispose can
  //    make the proven process exit and free the port, letting a stranger bind it before /global/dispose
  //    ("dispose ALL instances") is sent. Take-over must re-prove ownership between the two calls and abort —
  //    the stubborn serve here counts the dispose paths it receives to prove /global/dispose never lands.
  {
    resetCase();
    const disposePaths: string[] = [];
    let server: ReturnType<typeof Bun.serve> | undefined;
    for (let attempt = 0; attempt < 20 && !server; attempt++) {
      try {
        server = Bun.serve({
          hostname: '127.0.0.1',
          port: 50000 + Math.floor(Math.random() * 15000),
          fetch(req) {
            const url = new URL(req.url);
            if (url.pathname === '/session' && req.method === 'GET') return Response.json([]);
            if (req.method === 'POST' && url.pathname.includes('dispose')) { disposePaths.push(url.pathname); return new Response('ok'); } // stubborn: never frees the port
            return new Response('not found', { status: 404 });
          },
        });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error; }
    }
    if (!server) throw new Error('could not allocate a fake serve for the between-disposes case');
    const b = `http://127.0.0.1:${server.port}`;
    process.env.OPENCODE_URL = b;
    const A: ProcessIdentity = { pid: 131313, start: 'A', comm: 'opencode' };
    const B: ProcessIdentity = { pid: 242424, start: 'B', comm: 'opencode' };
    __writeOpencodeServeOwnershipForTest(A, b); // record matches A → classification is 'owned'
    let calls = 0;
    // A for classify (1) and the recheck before /instance/dispose (2); B (a stranger) from the recheck before
    // /global/dispose (3+) — the proven process exited and a stranger bound the port mid-take-over.
    __setLiveIdentityOverrideForTest(() => { calls += 1; return calls <= 2 ? A : B; });
    await ensureManagedOpencodeServe();
    const state = __getManagedOpencodeServeStateForTest();
    check('between-disposes: /instance/dispose was issued', disposePaths.some((p) => p.includes('/instance/dispose')), JSON.stringify(disposePaths));
    check('between-disposes: /global/dispose was NOT issued to the stranger', !disposePaths.some((p) => p.includes('/global/dispose')), JSON.stringify(disposePaths));
    check('between-disposes: module stays UNMANAGED (take-over aborted)', state.managed === false, JSON.stringify(state));
    check('between-disposes: the stranger serve is left reachable', await serveReachable(b));
    try { server.stop(true); } catch { /* stopped */ }
  }
} finally {
  await stopManagedOpencodeServe();
  __resetOpencodeConfigWatchForTest();
  __setLiveIdentityOverrideForTest(null);
  process.env.OPENCODE_URL = savedEnv.OPENCODE_URL;
  if (savedEnv.NO_AUTOSERVE === undefined) delete process.env.COSYNCING_OPENCODE_NO_AUTOSERVE;
  else process.env.COSYNCING_OPENCODE_NO_AUTOSERVE = savedEnv.NO_AUTOSERVE;
  if (savedEnv.REPLACE_UNOWNED === undefined) delete process.env.COSYNCING_OPENCODE_REPLACE_UNOWNED_SERVE;
  else process.env.COSYNCING_OPENCODE_REPLACE_UNOWNED_SERVE = savedEnv.REPLACE_UNOWNED;
  if (savedEnv.HOME_OVERRIDE === undefined) delete process.env.COSYNCING_HOME;
  else process.env.COSYNCING_HOME = savedEnv.HOME_OVERRIDE;
  process.env.PATH = savedEnv.PATH;
  rmSync(fakeBinDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\nFAIL: ${failed.length}/${results.length} ownership/take-over check(s) failed.`);
  process.exit(1);
}
console.log(`\nPASS ${results.length}/${results.length} opencode serve ownership + take-over checks`);
