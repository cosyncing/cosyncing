/**
 * The one rule every adapter applies to a session id before it touches a store
 * or a native server (`src/session-identity.ts`).
 *
 * The conformance suite (C21, `e2e/adapters/conformance`) proves each adapter
 * withholds and refuses hostile entries end to end. These are the helpers'
 * own edges, which no kit fixture reaches one by one: every spelling an opaque
 * id must refuse, and each way a path can sit in, climb out of, or point out of
 * a store root. Filesystem cases run in a temporary directory.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  containedStorePath,
  isOpaqueSessionId,
  isSessionNotFoundError,
  OPAQUE_SESSION_ID_MAX_SCALARS,
  SessionNotFoundError,
} from '../src/index.ts';

describe('an opaque session id', () => {
  test('real native ids are admitted unchanged', () => {
    for (const id of ['ses_6a8f3b2c1ffeAbCdEf0123456789', 'session_0b6f6f7e-3c1d-4f7a-9d55-2f1f0c9b8a11', 'ses_x', '42']) {
      expect({ id, admitted: isOpaqueSessionId(id) }).toEqual({ id, admitted: true });
    }
    expect(isOpaqueSessionId(`s${'x'.repeat(OPAQUE_SESSION_ID_MAX_SCALARS - 1)}`)).toBe(true);
  });

  test('anything that could leave its segment, or is not an id, is refused', () => {
    const refused: unknown[] = [
      '', '.', '..', '../../etc/passwd', '/etc/passwd', 'a/b', 'a\\b', '..\\x',
      '%2e%2e', '%2e%2e%2fetc%2fpasswd', '100%', '--help', '-s',
      'ses_bad\u0001id', 'ses\u007f', 'ses\nnext', 'ses\0',
      `s${'x'.repeat(OPAQUE_SESSION_ID_MAX_SCALARS)}`,
      42, undefined, null, {}, ['ses_x'],
    ];
    for (const value of refused) {
      expect({ value, admitted: isOpaqueSessionId(value) }).toEqual({ value, admitted: false });
    }
  });
});

describe('a path inside a store root', () => {
  // Canonical from the start: the helper answers in the real namespace (macOS's tmpdir is a symlink).
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'session-identity-')));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const store = join(base, 'store');
  const outside = join(base, 'outside');
  mkdirSync(join(store, 'day'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  const inside = join(store, 'day', 'a.jsonl');
  writeFileSync(inside, '{}\n');
  const secret = join(outside, 'secret.jsonl');
  writeFileSync(secret, '{}\n');

  test('a file in the store is admitted as itself', () => {
    expect(containedStorePath([store], inside)).toBe(inside);
    expect(containedStorePath([join(base, 'elsewhere'), store], inside)).toBe(inside);
  });

  test('a file outside the store, or the store root itself, is refused', () => {
    expect(containedStorePath([store], secret)).toBeUndefined();
    expect(containedStorePath([store], store)).toBeUndefined();
    expect(containedStorePath([store], '')).toBeUndefined();
    expect(containedStorePath([store], `${inside}\0`)).toBeUndefined();
  });

  test('.. is resolved: a climb out is refused, a detour that lands inside is the same file', () => {
    expect(containedStorePath([store], `${store}${sep}..${sep}outside${sep}secret.jsonl`)).toBeUndefined();
    expect(containedStorePath([store], `${store}${sep}day${sep}..${sep}day${sep}a.jsonl`)).toBe(inside);
  });

  test.skipIf(process.platform === 'win32')('symlinks are resolved: one pointing out, or nowhere, is refused', () => {
    const linkedFile = join(store, 'day', 'linked.jsonl');
    symlinkSync(secret, linkedFile);
    expect(containedStorePath([store], linkedFile)).toBeUndefined();
    const linkedDir = join(store, 'linked-dir');
    symlinkSync(outside, linkedDir);
    expect(containedStorePath([store], join(linkedDir, 'secret.jsonl'))).toBeUndefined();
    // Missing below a symlinked directory: canonicalized through it, so still outside.
    expect(containedStorePath([store], join(linkedDir, 'new.jsonl'), { allowMissing: true })).toBeUndefined();
    const dangling = join(store, 'day', 'dangling.jsonl');
    symlinkSync(join(base, 'gone.jsonl'), dangling);
    expect(containedStorePath([store], dangling)).toBeUndefined();
    expect(containedStorePath([store], dangling, { allowMissing: true })).toBeUndefined();
    const inward = join(store, 'day', 'inward.jsonl');
    symlinkSync(inside, inward);
    expect(containedStorePath([store], inward)).toBe(inside);
  });

  test('a path that does not exist yet is admitted only when allowed, and only inside', () => {
    const fresh = join(store, 'later', 'b.jsonl');
    expect(containedStorePath([store], fresh)).toBeUndefined();
    expect(containedStorePath([store], fresh, { allowMissing: true })).toBe(fresh);
    expect(containedStorePath([store], join(outside, 'b.jsonl'), { allowMissing: true })).toBeUndefined();
    // A path under a FILE is not missing, it is impossible. POSIX reports it as ENOTDIR and native
    // Windows as ENOENT (the code a missing path gets), so the refusal must not lean on the code.
    expect(containedStorePath([store], join(inside, 'b.jsonl'), { allowMissing: true })).toBeUndefined();
    expect(containedStorePath([store], join(inside, 'deeper', 'b.jsonl'), { allowMissing: true })).toBeUndefined();
  });
});

test('the not-found refusal is recognised across module copies', () => {
  expect(isSessionNotFoundError(new SessionNotFoundError('gone'))).toBe(true);
  const foreign = Object.assign(new Error('gone'), { name: 'SessionNotFoundError' });
  expect(isSessionNotFoundError(foreign)).toBe(true);
  expect(isSessionNotFoundError(new Error('gone'))).toBe(false);
});
