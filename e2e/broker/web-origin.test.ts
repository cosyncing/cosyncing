/**
 * The broker serves the web app from its own origin under `/cosy/`.
 *
 * A browser that loads the app gets the shell at `/cosy/`, deep links fall
 * back to the shell, assets keep their MIME types, nothing can frame the shell
 * or the handoff page, no request turns into an off-origin redirect or a file
 * outside the build, and the retired `/app` and `/poc-ui` mounts are plain
 * unknown paths. Without a build, `/cosy/` still answers cleanly and names the
 * build command a developer skipped.
 *
 * The build is fabricated (an index, one JS asset, one wasm asset) and pointed
 * at with `COSYNCING_WEB_DIR`; no Flutter build is needed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Broker, startBroker } from '../harness/index.ts';

const FAKE_INDEX = '<!doctype html><title>FAKE FLUTTER BUILD</title><body>flutter-web-fake-index</body>';
const NO_FRAMING = { csp: "frame-ancestors 'none'", xfo: 'DENY' };

function get(broker: Broker, path: string, init: RequestInit = {}): Promise<globalThis.Response> {
  return fetch(`${broker.url}${path}`, { redirect: 'manual', ...init });
}

function framing(response: globalThis.Response): { csp: string | null; xfo: string | null } {
  return {
    csp: response.headers.get('content-security-policy'),
    xfo: response.headers.get('x-frame-options'),
  };
}

describe('with a web build', () => {
  let broker: Broker;
  let webDir: string;

  beforeAll(async () => {
    webDir = mkdtempSync(join(tmpdir(), 'cosyncing-e2e-web-build-'));
    writeFileSync(join(webDir, 'index.html'), FAKE_INDEX);
    writeFileSync(join(webDir, 'main.dart.js'), '// fake dart js\n');
    writeFileSync(join(webDir, 'x.wasm'), '\0asm fake');
    broker = await startBroker({ name: 'web-origin', env: { COSYNCING_WEB_DIR: webDir } });
  });
  afterAll(async () => {
    await broker?.stop();
    rmSync(webDir, { recursive: true, force: true });
  });

  test('/cosy canonicalizes to /cosy/, dropping retired credential queries and keeping app state', async () => {
    const bare = await get(broker, '/cosy');
    expect([301, 302]).toContain(bare.status);
    expect(bare.headers.get('location')).toBe('/cosy/');

    const withQuery = await get(broker, '/cosy?view=recent&token=abc&peerToken=def');
    expect(withQuery.headers.get('location')).toBe('/cosy/?view=recent');

    const followed = await fetch(`${broker.url}/cosy`);
    expect(followed.status).toBe(200);
    expect(await followed.text()).toContain('flutter-web-fake-index');
  });

  test('no request produces an off-origin redirect', async () => {
    for (const hostile of ['/cosy//evil.example/', '/cosy?next=//evil.example', '/cosy/..//evil.example']) {
      const location = (await get(broker, hostile)).headers.get('location');
      expect(location === null || location.startsWith('/cosy/'), `${hostile} → ${location}`).toBe(true);
    }
    expect((await get(broker, '/cosything')).status).toBe(404);
  });

  test('the shell, the SPA fallback and the handoff page refuse to be framed', async () => {
    const shell = await get(broker, '/cosy/');
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('flutter-web-fake-index');
    expect(framing(shell)).toEqual(NO_FRAMING);

    const deep = await get(broker, '/cosy/deep/nested/route');
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain('flutter-web-fake-index');
    expect(framing(deep)).toEqual(NO_FRAMING);

    const handoff = await get(broker, '/cosy-handoff');
    expect(handoff.status).toBe(200);
    expect(framing(handoff)).toEqual(NO_FRAMING);
  });

  test('deep links load the shell, assets keep their types, and a missing asset is 404', async () => {
    const link = await get(broker, '/cosy/sessions/123');
    expect(link.status).toBe(200);
    expect(await link.text()).toContain('flutter-web-fake-index');

    const wasm = await get(broker, '/cosy/x.wasm');
    expect(wasm.status).toBe(200);
    expect(wasm.headers.get('content-type') ?? '').toContain('application/wasm');

    const js = await get(broker, '/cosy/main.dart.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type') ?? '').toMatch(/javascript|\/js/);

    expect((await get(broker, '/cosy/missing.js')).status).toBe(404);
  });

  test('raw and encoded traversal never leave the build directory', async () => {
    const raw = await get(broker, '/cosy/../../../../etc/passwd');
    expect(raw.status).toBeGreaterThanOrEqual(400);
    expect(await raw.text()).not.toContain('root:');

    const encoded = await get(broker, '/cosy/..%2f..%2f..%2f..%2fetc%2fpasswd');
    expect([400, 404]).toContain(encoded.status);
    expect(await encoded.text()).not.toContain('root:');
  });

  test('the static mount never shadows the API', async () => {
    const health = await get(broker, '/api/health');
    expect(health.status).toBe(200);
    expect((await health.json() as any).ok).toBe(true);
    expect((await get(broker, '/api/sessions')).status).toBe(200);
  });

  test('retired /app and /poc-ui mounts are indistinguishable from unknown paths, and / goes to /cosy/', async () => {
    const unknown = await get(broker, '/nothing-here');
    const unknownBody = await unknown.text();
    for (const path of ['/app', '/app/', '/app/main.dart.js', '/app/sessions/123']) {
      const gone = await get(broker, path);
      expect(gone.status, path).toBe(unknown.status);
      expect(gone.headers.get('location'), path).toBeNull();
      expect(await gone.text(), path).toBe(unknownBody);
    }
    for (const path of ['/poc-ui/', '/poc-ui', '/poc-ui/app.js', '/app.js']) {
      const gone = await get(broker, path);
      expect(gone.status, path).toBe(404);
      expect(gone.headers.get('location'), path).toBeNull();
      expect(await gone.text(), path).not.toContain('<html');
    }
    const root = await get(broker, '/');
    expect(root.status).toBe(302);
    expect(root.headers.get('location')).toBe('/cosy/');
  });
});

describe('without a web build', () => {
  let broker: Broker;

  beforeAll(async () => {
    broker = await startBroker({
      name: 'web-origin-nobuild',
      env: (paths) => ({ COSYNCING_WEB_DIR: join(paths.root, 'never-built') }),
    });
  });
  afterAll(() => broker?.stop());

  test('/cosy/ answers cleanly and names the build command, and the printed /cosy URL lands there', async () => {
    const mount = await get(broker, '/cosy/');
    const body = await mount.text();
    expect(mount.status).toBe(404);
    expect(body).toContain('--base-href /cosy/');
    expect(body).not.toMatch(/pair/i);

    const printed = await fetch(`${broker.url}/cosy`);
    expect(printed.status).toBe(mount.status);
    expect(await printed.text()).toBe(body);
  });

  test('/app/ stays the plain unknown-path 404 rather than the "not built" page', async () => {
    const unknown = await get(broker, '/nothing-here');
    const unknownBody = await unknown.text();
    const app = await get(broker, '/app/');
    expect(app.status).toBe(unknown.status);
    expect(app.headers.get('location')).toBeNull();
    expect(await app.text()).toBe(unknownBody);
    expect((await get(broker, '/api/health')).status).toBe(200);
  });
});
