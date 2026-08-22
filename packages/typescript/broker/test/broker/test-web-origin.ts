#!/usr/bin/env bun
/**
 * Same-origin web serving: the /cosy/ Flutter mount (SPA fallback + path-traversal hardening + "not
 * built" grace), the retired /app and /poc-ui mounts, and proof that the static mount never shadows
 * dynamic routes.
 *
 * Self-contained: no real Flutter build is required. The suite fabricates a temp build dir (a fake
 * index.html + a fake main.dart.js + a fake x.wasm), points COSYNCING_WEB_DIR at it, and spawns a real
 * broker on the shared isolated fixture environment.
 *
 * That environment is load-bearing, not hygiene. This suite used to inherit the developer's whole env and
 * spawn on fixed ports 7798/7799 with stderr discarded. A stale CODEX_APP_SERVER_SOCKET in a real shell
 * then crashed the broker during /api/sessions discovery, and the run died after ten assertions with no
 * output to say why — twice, on a reviewer's machine (2026-08-05). The isolated environment scrubs those
 * host handles and pins every adapter endpoint at an address nothing can answer on, the ports are leased
 * from the OS so two runs cannot collide, and both streams are captured so a broker that fails to start
 * says so in the failure.
 *
 *   bun run test:broker-web-origin
 */
export {};
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  captureProcessOutput,
  isolatedBrokerFixtureEnvironment,
  reserveLoopbackFixturePort,
  settledProcessOutput,
  waitForBrokerHealth,
} from '../helpers/isolated-broker-fixture.ts';

const ROOT = resolve(import.meta.dir, '../../../../..');

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

const FAKE_INDEX = '<!doctype html><title>FAKE FLUTTER BUILD</title><body>flutter-web-fake-index</body>';

interface BrokerFixture {
  base: string;
  /** Kills the broker, drains both streams, and removes the fixture root. Safe to call once. */
  stop: () => Promise<void>;
}

async function spawnBroker(webDir: string): Promise<BrokerFixture> {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'cosyncing-web-origin-'));
  // Leased from the OS and released immediately before spawn: a fixed port is an assertion that nothing
  // else on the host wants it, which is false the moment two suites run at once.
  const lease = await reserveLoopbackFixturePort();
  const { port } = lease;
  await lease.release();
  const broker = Bun.spawn(['bun', 'packages/typescript/broker/src/main.ts'], {
    cwd: ROOT,
    env: isolatedBrokerFixtureEnvironment(fixtureRoot, {
      overrides: {
        HOST: '127.0.0.1',
        PORT: String(port),
        COSYNCING_MACHINE: 'web-origin-test',
        COSYNCING_RESTART_DRY_RUN: '1',
        COSYNCING_WEB_DIR: webDir,
      },
    }),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = captureProcessOutput(broker);
  const base = `http://127.0.0.1:${port}`;
  const teardown = async (): Promise<string> => {
    broker.kill();
    await broker.exited.catch(() => null);
    const log = await settledProcessOutput(output);
    rmSync(fixtureRoot, { recursive: true, force: true });
    return log;
  };
  try {
    await waitForBrokerHealth(broker, `${base}/api/health`);
  } catch (error) {
    // Quote what the broker said. A readiness failure with the process output thrown away is the exact
    // shape that made the original crash unreadable.
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${await teardown()}`);
  }
  return { base, stop: async () => { await teardown(); } };
}

/** Build a fake Flutter web dir: an index.html + one JS asset + one wasm asset (never a real build). */
function makeFakeBuild(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cosyncing-flutter-'));
  writeFileSync(join(dir, 'index.html'), FAKE_INDEX);
  writeFileSync(join(dir, 'main.dart.js'), '// fake dart js\n');
  writeFileSync(join(dir, 'x.wasm'), '\0asm fake');
  return dir;
}

// ---- 1) Broker WITH a fake Flutter build present ----------------------------------------------
const webDir = makeFakeBuild();
const built = await spawnBroker(webDir);
try {
  check('broker (with build) is up', true, built.base);

  // /cosy -> /cosy/ canonicalization (do not follow, so we can inspect the Location header). The
  // trailing slash is what the shell's relative asset URLs and the worker scope resolve against.
  const red = await fetch(`${built.base}/cosy`, { redirect: 'manual' });
  check('GET /cosy canonicalizes to /cosy/', (red.status === 301 || red.status === 302) && red.headers.get('location') === '/cosy/', `status=${red.status} location=${red.headers.get('location')}`);
  const redQuery = await fetch(`${built.base}/cosy?view=recent&token=abc&peerToken=def`, { redirect: 'manual' });
  check('GET /cosy strips retired credential queries but keeps ordinary state',
    redQuery.headers.get('location') === '/cosy/?view=recent',
    `location=${redQuery.headers.get('location')}`);
  // Only the bare path redirects, and its Location is built from the literal mount plus the query — so no
  // request can make it protocol-relative (`//host`) or point it off-origin. A path that merely looks
  // hostile is served by the mount instead, which is the same guarantee by a different route.
  for (const hostile of ['/cosy//evil.example/', '/cosy?next=//evil.example', '/cosy/..//evil.example']) {
    const attempt = await fetch(`${built.base}${hostile}`, { redirect: 'manual' });
    const location = attempt.headers.get('location');
    check(`GET ${hostile} yields no off-origin redirect`, location === null || location.startsWith('/cosy/'), `location=${location}`);
  }
  // Following it must actually reach the app, not just produce a well-formed Location header.
  const followed = await fetch(`${built.base}/cosy`);
  check('following /cosy serves the app index', followed.status === 200 && (await followed.text()).includes('flutter-web-fake-index'), `status=${followed.status}`);
  // A prefix that merely starts with the mount is not the mount.
  const near = await fetch(`${built.base}/cosything`, { redirect: 'manual' });
  check('GET /cosything is not treated as the mount', near.status === 404, `status=${near.status}`);

  // /cosy/ serves the fake index.html.
  const idx = await fetch(`${built.base}/cosy/`);
  const idxBody = await idx.text();
  check('GET /cosy/ serves index.html', idx.status === 200 && idxBody.includes('flutter-web-fake-index'), `status=${idx.status}`);

  // /cosy/x.wasm -> application/wasm (Bun infers the MIME; no manual table).
  const wasm = await fetch(`${built.base}/cosy/x.wasm`);
  check('GET /cosy/x.wasm is application/wasm', wasm.status === 200 && (wasm.headers.get('content-type') || '').includes('application/wasm'), `status=${wasm.status} ct=${wasm.headers.get('content-type')}`);

  // Existing asset with a JS content-type.
  const js = await fetch(`${built.base}/cosy/main.dart.js`);
  const jsCt = js.headers.get('content-type') || '';
  check('GET /cosy/main.dart.js is JS', js.status === 200 && (jsCt.includes('javascript') || jsCt.includes('/js')), `status=${js.status} ct=${jsCt}`);

  // SPA fallback: a missing NAVIGATION (no extension) returns index.html (200), so a shared deep link
  // like /cosy/sessions/123 still opens that session on a cold load.
  const nav = await fetch(`${built.base}/cosy/deep/nested/route`);
  const navBody = await nav.text();
  check('SPA fallback: /cosy/deep/nested/route -> index.html', nav.status === 200 && navBody.includes('flutter-web-fake-index'), `status=${nav.status}`);
  const deepLink = await fetch(`${built.base}/cosy/sessions/123`);
  check('deep link /cosy/sessions/123 loads the shell rather than 404ing', deepLink.status === 200 && (await deepLink.text()).includes('flutter-web-fake-index'), `status=${deepLink.status}`);

  // SPA fallback: a missing ASSET (has extension) returns 404.
  const missAsset = await fetch(`${built.base}/cosy/missing.js`);
  check('missing asset /cosy/missing.js -> 404', missAsset.status === 404, `status=${missAsset.status}`);

  // Path traversal: the raw `..` form is normalized by the URL layer to /etc/passwd (never matches
  // /cosy/), and an ENCODED variant must be rejected without leaking a file outside the build dir.
  const travRaw = await fetch(`${built.base}/cosy/../../../../etc/passwd`);
  const travRawBody = await travRaw.text();
  check('traversal /cosy/../../etc/passwd never leaks passwd', travRaw.status >= 400 && !travRawBody.includes('root:'), `status=${travRaw.status}`);
  const travEnc = await fetch(`${built.base}/cosy/..%2f..%2f..%2f..%2fetc%2fpasswd`);
  const travEncBody = await travEnc.text();
  check('encoded traversal /cosy/..%2f..%2fetc%2fpasswd rejected', (travEnc.status === 400 || travEnc.status === 404) && !travEncBody.includes('root:'), `status=${travEnc.status}`);

  // Non-shadowing: dynamic routes still win with the static mounts present.
  const health = await fetch(`${built.base}/api/health`);
  const healthBody = await health.json().catch(() => null) as any;
  check('GET /api/health still works (not shadowed)', health.status === 200 && !!healthBody, `status=${health.status}`);
  const sessions = await fetch(`${built.base}/api/sessions`);
  check('GET /api/sessions still works (not shadowed)', sessions.status === 200, `status=${sessions.status}`);

  // /app was the mount until R16 and is now nothing (owner decision, 2026-08-05). Not a redirect: a
  // redirect would claim the surface still exists somewhere. It must be indistinguishable from any other
  // unknown path — same status, same body, no Location — at the bare path, the slash form and below.
  const unknown = await fetch(`${built.base}/nothing-here`, { redirect: 'manual' });
  const unknownBody = await unknown.text();
  for (const [label, path] of [['/app', '/app'], ['/app/', '/app/'], ['/app/main.dart.js', '/app/main.dart.js'], ['/app/sessions/123', '/app/sessions/123']] as const) {
    const gone = await fetch(`${built.base}${path}`, { redirect: 'manual' });
    check(`GET ${label} is the same 404 as an unknown path, with no redirect`,
      gone.status === unknown.status && !gone.headers.get('location') && (await gone.text()) === unknownBody,
      `status=${gone.status} loc=${gone.headers.get('location')}`);
  }

  // The PoC mount is retired (R9). Every /poc-ui path is an unknown path: a plain 404, never a redirect
  // that would imply the surface moved somewhere else.
  const poc = await fetch(`${built.base}/poc-ui/`, { redirect: 'manual' });
  check('GET /poc-ui/ is 404 with no body', poc.status === 404 && !(await poc.text()).includes('<html'), `status=${poc.status}`);
  const pocNoSlash = await fetch(`${built.base}/poc-ui`, { redirect: 'manual' });
  check('GET /poc-ui does not redirect anywhere', pocNoSlash.status === 404 && !pocNoSlash.headers.get('location'), `status=${pocNoSlash.status} loc=${pocNoSlash.headers.get('location')}`);
  const pocApp = await fetch(`${built.base}/poc-ui/app.js`, { redirect: 'manual' });
  check('GET /poc-ui/app.js serves no client JS', pocApp.status === 404, `status=${pocApp.status}`);
  // Root now redirects to the Flutter app and must NOT serve the PoC (manual redirect so we see the 302).
  const root = await fetch(`${built.base}/`, { redirect: 'manual' });
  check('GET / 302-redirects to /cosy/ (PoC hidden off root)', root.status === 302 && root.headers.get('location') === '/cosy/', `status=${root.status} loc=${root.headers.get('location')}`);
  // The PoC no longer leaks at root asset paths.
  const rootApp = await fetch(`${built.base}/app.js`, { redirect: 'manual' });
  check('GET /app.js at root is no longer served (PoC hidden)', rootApp.status === 404, `status=${rootApp.status}`);
} finally {
  await built.stop();
}

// ---- 2) "Not built" grace: COSYNCING_WEB_DIR points at a nonexistent dir ------------------------
const missingDir = join(tmpdir(), `cosyncing-flutter-missing-${Date.now()}`); // never created
const nobuild = await spawnBroker(missingDir);
try {
  check('broker (no build) is up', true, nobuild.base);
  const app = await fetch(`${nobuild.base}/cosy/`);
  const appBody = await app.text();
  check('no-build: /cosy/ returns a clean non-500 response', app.status !== 500 && app.status < 500, `status=${app.status}`);
  // This is a SOURCE run, so the reader is a developer who skipped the build step and the message names
  // the command. A packaged build must never say this — that assertion lives in the runtime-assets suite,
  // where a real compiled binary is available to prove the other branch.
  check('no-build: a source run names the build command it is missing',
    app.status === 404 && appBody.includes('--base-href /cosy/') && !/pair/i.test(appBody),
    `status=${app.status} body=${JSON.stringify(appBody.slice(0, 120))}`);
  // Setup prints the bare `/cosy`, so the URL an operator actually types must reach that same answer
  // rather than stopping at the canonicalizing redirect.
  const bareNoBuild = await fetch(`${nobuild.base}/cosy`);
  check('no-build: the printed /cosy URL lands on that same answer', bareNoBuild.status === app.status && (await bareNoBuild.text()) === appBody, `cosy=${bareNoBuild.status} mount=${app.status}`);
  // /app stays gone with no build present too: the absent web app must not resurrect the retired path
  // through the "not built" branch.
  const unknownNoBuild = await fetch(`${nobuild.base}/nothing-here`, { redirect: 'manual' });
  const unknownNoBuildBody = await unknownNoBuild.text();
  const appNoBuild = await fetch(`${nobuild.base}/app/`, { redirect: 'manual' });
  check('no-build: /app/ is still the plain unknown-path 404, not the "not built" page',
    appNoBuild.status === unknownNoBuild.status && !appNoBuild.headers.get('location')
      && (await appNoBuild.text()) === unknownNoBuildBody,
    `status=${appNoBuild.status} loc=${appNoBuild.headers.get('location')}`);
  const health = await fetch(`${nobuild.base}/api/health`);
  check('no-build: /api/health still works', health.status === 200, `status=${health.status}`);
} finally {
  await nobuild.stop();
}

rmSync(webDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
if (failed.length) { console.error(`\nFAIL: ${failed.length}/${results.length} web-origin check(s) failed.`); process.exit(1); }
console.log(`\n✅ ${results.length}/${results.length} web-origin checks passed.`);
