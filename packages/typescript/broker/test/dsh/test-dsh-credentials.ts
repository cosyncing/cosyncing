/**
 * The broker's DeepSeek Harness cookie store.
 *
 * A 0.2 host cookie is a bearer credential for one agent host, valid by default
 * for thirty days, and it is the only thing that authenticates an API or
 * WebSocket request. It has to outlive the broker that earned it — otherwise an
 * external host needs its operator to go and read a URL again every time the
 * service restarts — so it lives on disk, and everything that matters about it is
 * what happens when the file is not what the code hoped: group-writable, symlinked,
 * half-written, oversized, or holding someone else's enrollment.
 *
 * Every case runs against a throwaway COSYNCING_HOME under the system temp
 * directory. No real state root is opened.
 *
 *   bun run packages/typescript/broker/test/dsh/test-dsh-credentials.ts   (exit 0 = all pass)
 */
export {};
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DSH_COOKIE_VALUE_MAX_CHARS,
  DSH_MAX_ENROLLMENTS,
  DSH_SESSIONS_FILENAME,
  DSH_SESSIONS_SCHEMA_VERSION,
  clearDshCookie,
  createDshCredentialStore,
  dshSessionsPath,
  inspectDshSessions,
  listDshEnrollments,
  loadDshCookie,
  readDshSessionFile,
  saveDshCookie,
  writeDshSessionFile,
} from '../../src/security/dsh-credentials.ts';

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** A throwaway state home, with the `secrets` directory a real installation has. */
function home(): { dir: string; target: string } {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'cosyncing-dsh-credentials-'));
  const target = dshSessionsPath(dir);
  if (existsSync(join(dir, 'secrets')) === false) mkdirSync(join(dir, 'secrets'), { recursive: true });
  return { dir, target };
}

// The host names its cookie `dsh-auth-<base64url(sha256(authority))>`, and the
// store refuses anything else: a file that will carry an arbitrary header name is
// not a cookie store.
const COOKIE = { name: 'dsh-auth-YnV0LWZpeHR1cmU', value: 'v1.fixture-cookie', expiresAt: 1_800_000_000_000 };

{
  const { dir, target } = home();
  check('the store lives with the other secrets under the resolved state home',
    target === join(dir, 'secrets', 'dsh-sessions.json') && dshSessionsPath() !== target, target);
  check('an absent store reads as no credential rather than as an error',
    loadDshCookie('scope-a', target) === null && inspectDshSessions(target).status === 'missing');
  const revision = saveDshCookie('scope-a', COOKIE, target);
  check('a saved cookie is a revision, so a refresh is distinguishable from a re-read',
    revision === 1 && loadDshCookie('scope-a', target)?.value === COOKIE.value, String(revision));
  saveDshCookie('scope-a', { ...COOKIE, value: 'v1.replaced' }, target);
  check('a replacement bumps the revision and keeps one record per scope',
    loadDshCookie('scope-a', target)?.value === 'v1.replaced'
      && readDshSessionFile(target).sessions['scope-a']?.revision === 2,
    String(readDshSessionFile(target).sessions['scope-a']?.revision));
  check('the file is owner-only and carries a schema version',
    readFileSync(target, 'utf8').includes(`"schemaVersion": ${String(DSH_SESSIONS_SCHEMA_VERSION)}`));
  check('a cookie the host could not have issued is refused on the way in',
    (() => {
      try {
        saveDshCookie('scope-a', { ...COOKIE, name: 'x-token' }, target);
        return false;
      } catch {
        return true;
      }
    })());
  check('an unsafe file is refused rather than silently rewritten',
    (() => {
      chmodSync(target, 0o644);
      return inspectDshSessions(target).status === 'unsafe';
    })(), String(inspectDshSessions(target).status));
  chmodSync(target, 0o600);
  check('clearing returns whether anything was there, and a second clear says no',
    clearDshCookie('scope-a', target) === true && clearDshCookie('scope-a', target) === false);
  check('a scope nobody enrolled reads as null, not as an empty record',
    loadDshCookie('scope-never-enrolled', target) === null);
  rmSync(dir, { recursive: true, force: true });
}

{
  // Two enrollments, because an operator with a laptop host and a review host has
  // two, and a store that held "the dsh cookie" would log one out on the other's
  // behalf.
  const { dir, target } = home();
  saveDshCookie('scope-laptop', COOKIE, target);
  saveDshCookie('scope-review', { ...COOKIE, value: 'v1.review-cookie' }, target);
  const enrollments = listDshEnrollments(target);
  check('two scopes are two enrollments',
    enrollments.length === 2
      && loadDshCookie('scope-laptop', target)?.value === 'v1.fixture-cookie'
      && loadDshCookie('scope-review', target)?.value === 'v1.review-cookie',
    JSON.stringify(enrollments.map((entry) => entry.scope)));
  check('the enrollment listing never carries the cookie value itself',
    JSON.stringify(enrollments).includes('fixture-cookie') === false, JSON.stringify(enrollments));
  check('expiry metadata survives a round trip, and a scope without it stays absent',
    enrollments.every((entry) => entry.expiresAt === COOKIE.expiresAt)
      && listDshEnrollments(target).length === 2, JSON.stringify(enrollments));
  rmSync(dir, { recursive: true, force: true });
}

{
  const { dir, target } = home();
  let oversizedRefused = false;
  try {
    saveDshCookie('scope-a', { name: COOKIE.name, value: 'x'.repeat(DSH_COOKIE_VALUE_MAX_CHARS + 1) }, target);
  } catch {
    oversizedRefused = true;
  }
  check('an oversized cookie value is refused on the way in, not truncated or stored',
    oversizedRefused && (existsSync(target) === false || loadDshCookie('scope-a', target) === null),
    String(oversizedRefused));
  rmSync(dir, { recursive: true, force: true });
}

{
  const { dir, target } = home();
  writeFileSync(target, '{ this is not json', { mode: 0o600 });
  const inspection = inspectDshSessions(target);
  check('a corrupt store is reported, never silently replaced',
    inspection.status === 'malformed' && readFileSync(target, 'utf8') === '{ this is not json',
    JSON.stringify(inspection));
  check('a corrupt store fails the read rather than answering "not enrolled"',
    (() => {
      try {
        loadDshCookie('scope-a', target);
        return false;
      } catch {
        return true;
      }
    })(), 'a wrong answer here tells an operator to re-enroll a host whose file merely needs a repair');
  check('a corrupt store keeps its bytes until a human says otherwise',
    readFileSync(target, 'utf8') === '{ this is not json');
  rmSync(dir, { recursive: true, force: true });
}

{
  const { dir, target } = home();
  writeDshSessionFile({
    schemaVersion: 99 as typeof DSH_SESSIONS_SCHEMA_VERSION,
    sessions: { 'scope-a': { name: COOKIE.name, value: 'v', revision: 1, savedAt: 1 } },
  }, target);
  check('a store written by a future build is refused rather than partially read',
    inspectDshSessions(target).status === 'malformed' && (() => {
      try {
        loadDshCookie('scope-a', target);
        return false;
      } catch {
        return true;
      }
    })(), JSON.stringify(inspectDshSessions(target)));
  rmSync(dir, { recursive: true, force: true });
}

{
  const { dir, target } = home();
  const outside = join(dir, 'cookie-victim.txt');
  writeFileSync(outside, 'do not overwrite me', { mode: 0o600 });
  // A symlinked store is the classic substitute: the broker would be writing a
  // credential through a link it did not choose.
  rmSync(target, { force: true });
  symlinkSync(outside, target);
  const inspection = inspectDshSessions(target);
  check('a symlinked session store is refused, not followed',
    inspection.status === 'unsafe', JSON.stringify(inspection));
  check('refusing leaves the linked file alone',
    readFileSync(outside, 'utf8') === 'do not overwrite me');
  check('and a write through that path fails rather than publishing a credential',
    (() => {
      try {
        saveDshCookie('scope-a', COOKIE, target);
        return false;
      } catch {
        return true;
      }
    })());
  rmSync(dir, { recursive: true, force: true });
}

{
  // The store the adapter is handed, exercised as the adapter uses it.
  const { dir } = home();
  const store = createDshCredentialStore(dir);
  const saved = await store.load('scope-x');
  await store.save('scope-x', COOKIE);
  const loaded = await store.load('scope-x');
  await store.clear('scope-x');
  const cleared = await store.load('scope-x');
  check('the injected store round-trips through the same file as the direct API',
    saved === null && loaded?.value === COOKIE.value && cleared === null,
    JSON.stringify({ saved: saved === null, loaded: loaded?.value, cleared: cleared === null }));
  check('the store lives exactly where the CLI looks for it',
    dshSessionsPath(dir) === join(dir, 'secrets', DSH_SESSIONS_FILENAME), dshSessionsPath(dir));
  rmSync(dir, { recursive: true, force: true });
}

{
  const { dir, target } = home();
  for (let index = 0; index < DSH_MAX_ENROLLMENTS; index += 1) {
    saveDshCookie(`scope-${String(index)}`, COOKIE, target);
  }
  let overflowRefused = false;
  try {
    saveDshCookie('scope-overflow', COOKIE, target);
  } catch {
    overflowRefused = true;
  }
  check('the enrollment count is bounded, and the ceiling says so instead of evicting',
    overflowRefused && listDshEnrollments(target).length === DSH_MAX_ENROLLMENTS,
    String(listDshEnrollments(target).length));
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${String(results.filter((entry) => entry.ok).length)}/${String(results.length)} checks passed`);
if (results.some((entry) => !entry.ok)) process.exitCode = 1;
