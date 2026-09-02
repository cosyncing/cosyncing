#!/usr/bin/env bun
/**
 * W3 workspace file API acceptance coverage.
 * Covers list/stat/read/download + auth + traversal/symlink/size-caps.
 */
import { strict as assert } from 'node:assert';
import { createServer } from 'node:net';
import { closeSync, mkdtempSync, mkdirSync, readSync, realpathSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { homedir, tmpdir } from 'node:os';

import {
  FsBrowseError,
  looksUtf8ish,
  prepareSessionDownload,
  readSessionDirectory,
  readSessionFile,
  readSessionStat,
  toWorkspaceRelative,
  validateBrowsePath,
} from '../../src/artifacts/fs-browse.ts';
import { DownloadRangeError, ifRangeMatches, parseDownloadRange } from '../../src/artifacts/fs-browse.ts';
import { defaultBrokerConfig, writeBrokerConfig } from '../../src/runtime/configuration.ts';

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name} - ${err instanceof Error ? err.message : String(err)}`);
    failures++;
  }
}

let failures = 0;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('could not allocate port');
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return addr.port;
}

async function waitHealthy(base: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      /* wait */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('broker did not become healthy');
}

async function startBroker(port: number, token: string, opencodeData: string, home: string, fsReadCap = '64', userHome?: string): Promise<{ broker: ReturnType<typeof Bun.spawn>; base: string }> {
  return startBrokerWithEnv({
    PORT: String(port),
    COSYNCING_TOKEN: token,
    COSYNCING_FS_READ_MAX_BYTES: fsReadCap,
    COSYNCING_FS_DOWNLOAD_MAX_BYTES: '16',
    COSYNCING_HOME: home,
    OPENCODE_DATA: opencodeData,
    // `~` expands against the broker host's own home, so the suite owns HOME rather than inheriting
    // the developer's — which also keeps real ~/.codex and ~/.claude state out of discovery.
    ...(userHome ? { HOME: userHome, USERPROFILE: userHome } : {}),
    // Every HTTP client is T2 since the loopback-only listener landed: a loopback TCP peer may be a
    // reverse proxy, so workspace browsing is opt-in for all of them (docs/connectivity/security.md).
    COSYNCING_FS_REMOTE_ENABLED: '1',
  });
}

async function startBrokerWithEnv(env: Record<string, string>): Promise<{ broker: ReturnType<typeof Bun.spawn>; base: string }> {
  const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: {
      ...process.env,
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
      COSYNCING_WEB_COI: '0',
      COSYNCING_FS_REMOTE_ENABLED: '',
      ...env,
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  // The listener is pinned to BROKER_LISTEN_HOST (127.0.0.1); HOST is not read at all.
  const base = `http://127.0.0.1:${env.PORT}`;
  await waitHealthy(base);
  return { broker, base };
}

const TOK = 'w3-workspace-route-token';

await test('helper primitives validate browse path safety', () => {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-w3-helper-'));
  assert.equal(looksUtf8ish(new TextEncoder().encode('hello, world')), true);
  assert.equal(looksUtf8ish(new Uint8Array([0xff, 0xfe, 0x00, 0x01])), false);
  assert.equal(validateBrowsePath(root, 'foo/bar').rel, 'foo/bar');
  writeFileSync(join(root, 'download.txt'), 'fd-backed');
  const download: any = prepareSessionDownload(root, 'download.txt', 1024);
  try {
    assert.equal(typeof download.fd, 'number');
    const bytes = new Uint8Array(9);
    assert.equal(readSync(download.fd, bytes, 0, bytes.byteLength, 0), 9);
    assert.equal(new TextDecoder().decode(bytes), 'fd-backed');
    assert.match(download.etag, /^"[A-Za-z0-9_-]+"$/);
  } finally {
    if (typeof download.fd === 'number') closeSync(download.fd);
  }
  assert.throws(() => validateBrowsePath(root, '../etc'), FsBrowseError);
  assert.throws(() => validateBrowsePath(root, '/tmp/abc'), FsBrowseError);
  assert.throws(() => validateBrowsePath(root, 'a\0b'), FsBrowseError);
  rmSync(root, { recursive: true, force: true });
});

function browseCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof FsBrowseError) return err.code;
    return `not-an-FsBrowseError: ${err instanceof Error ? err.message : String(err)}`;
  }
  return 'no-throw';
}

await test('absolute and ~ requests normalize to the workspace-relative form', () => {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-w3-abs-'));
  const linkParent = mkdtempSync(join(tmpdir(), 'cosyncing-w3-abs-link-'));
  const outsideDir = mkdtempSync(join(tmpdir(), 'cosyncing-w3-abs-outside-'));
  const linkRoot = join(linkParent, 'root');
  try {
    writeFileSync(join(root, 'hello.txt'), 'hello-from-workspace');
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'note.txt'), 'nested-note');
    mkdirSync(join(root, 'realdir'));
    writeFileSync(join(root, 'realdir', 'inner.txt'), 'inner');
    symlinkSync(join(root, 'realdir'), join(root, 'linkdir'));
    writeFileSync(join(outsideDir, 'secret.txt'), 'do not serve this');
    symlinkSync(join(outsideDir, 'secret.txt'), join(root, 'link-to-secret'));
    symlinkSync(root, linkRoot);

    // Today's inputs are returned untouched — no relative request changes shape.
    assert.equal(toWorkspaceRelative(root, 'nested/note.txt'), 'nested/note.txt');
    assert.equal(toWorkspaceRelative(root, '../etc'), '../etc');
    assert.equal(toWorkspaceRelative(root, ''), '');
    assert.equal(toWorkspaceRelative(root, null), null);
    assert.equal(toWorkspaceRelative(root, undefined), undefined);
    // A NUL byte stays assertSafePath's BAD_PARAM, not a normalization failure.
    assert.equal(browseCode(() => validateBrowsePath(root, `${root}/a\0b`)), 'BAD_PARAM');

    assert.equal(toWorkspaceRelative(root, join(root, 'nested', 'note.txt')), join('nested', 'note.txt'));
    assert.equal(toWorkspaceRelative(root, root), '.');
    assert.equal(browseCode(() => toWorkspaceRelative(root, join(outsideDir, 'secret.txt'))), 'PATH_ESCAPE');
    assert.equal(browseCode(() => toWorkspaceRelative('', join(root, 'hello.txt'))), 'NO_CWD');

    // `~` is the broker host's home, expanded here and never by the client.
    assert.equal(toWorkspaceRelative(homedir(), '~'), '.');
    assert.equal(toWorkspaceRelative(homedir(), '~/a/b.txt'), join('a', 'b.txt'));
    assert.equal(toWorkspaceRelative(join(homedir(), 'proj'), '~/proj/lib/x.dart'), join('lib', 'x.dart'));
    // `~user` is somebody else's home and stays a literal relative name.
    assert.equal(toWorkspaceRelative(root, '~someone/x'), '~someone/x');
    if (relative(homedir(), root).startsWith('..')) {
      assert.equal(browseCode(() => toWorkspaceRelative(root, '~')), 'PATH_ESCAPE');
      assert.equal(browseCode(() => toWorkspaceRelative(root, '~/x.txt')), 'PATH_ESCAPE');
    }

    // A workspace reached through a symlinked root resolves either spelling, in both directions.
    assert.equal(toWorkspaceRelative(linkRoot, join(realpathSync(root), 'hello.txt')), 'hello.txt');
    assert.equal(toWorkspaceRelative(root, join(linkRoot, 'hello.txt')), 'hello.txt');

    // All four helpers accept an absolute path and answer exactly as the relative form does.
    assert.deepEqual(readSessionStat(root, join(root, 'hello.txt')), readSessionStat(root, 'hello.txt'));
    assert.deepEqual(readSessionDirectory(root, join(root, 'nested')), readSessionDirectory(root, 'nested'));
    assert.deepEqual(readSessionFile(root, join(root, 'hello.txt'), 1024), readSessionFile(root, 'hello.txt', 1024));
    assert.equal(readSessionDirectory(root, root).path, '.');
    assert.equal(readSessionFile(root, join(root, 'hello.txt'), 1024).data, 'hello-from-workspace');
    const absDownload = prepareSessionDownload(root, join(root, 'nested', 'note.txt'), 1024);
    try {
      assert.equal(absDownload.path, 'nested/note.txt');
    } finally {
      closeSync(absDownload.fd);
    }

    // Containment, the per-segment symlink walk, and every error code survive the new pre-step.
    assert.equal(browseCode(() => readSessionStat(root, join(outsideDir, 'secret.txt'))), 'PATH_ESCAPE');
    assert.equal(browseCode(() => readSessionFile(root, join(outsideDir, 'secret.txt'), 1024)), 'PATH_ESCAPE');
    assert.equal(browseCode(() => prepareSessionDownload(root, join(outsideDir, 'secret.txt'), 1024)), 'PATH_ESCAPE');
    assert.equal(browseCode(() => readSessionStat(root, join(root, 'link-to-secret'))), 'PATH_SYMLINK');
    assert.equal(browseCode(() => readSessionStat(root, join(root, 'linkdir', 'inner.txt'))), 'PATH_SYMLINK');
    assert.equal(browseCode(() => readSessionStat(root, join(linkRoot, 'linkdir', 'inner.txt'))), 'PATH_SYMLINK');
    // A missing path inside the workspace is still NOT_FOUND, never PATH_ESCAPE.
    assert.equal(browseCode(() => readSessionStat(root, join(root, 'gone.txt'))), 'NOT_FOUND');
    assert.equal(browseCode(() => readSessionFile(root, join(root, 'nested'), 1024)), 'NOT_REGULAR_FILE');
  } finally {
    rmSync(linkRoot, { force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(linkParent, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

await test('download range parser covers closed, open, suffix, If-Range, and 416 cases', () => {
  assert.deepEqual(parseDownloadRange('bytes=0-4', 10), { start: 0, end: 4 });
  assert.deepEqual(parseDownloadRange('bytes=7-', 10), { start: 7, end: 9 });
  assert.deepEqual(parseDownloadRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseDownloadRange('bytes=7-999', 10), { start: 7, end: 9 });
  assert.throws(() => parseDownloadRange('bytes=10-', 10), DownloadRangeError);
  assert.throws(() => parseDownloadRange('bytes=0-1,4-5', 10), DownloadRangeError);
  assert.throws(() => parseDownloadRange('items=0-1', 10), DownloadRangeError);
  assert.equal(ifRangeMatches('"current"', '"current"', 1_000), true);
  assert.equal(ifRangeMatches('"stale"', '"current"', 1_000), false);
  assert.equal(ifRangeMatches('W/"current"', '"current"', 1_000), false);
  assert.equal(ifRangeMatches(new Date(1_000).toUTCString(), '"current"', 1_000), true);
  assert.equal(ifRangeMatches(new Date(0).toUTCString(), '"current"', 2_000), false);
});

await test('w3 session workspace API is read-only, bounded, and safe', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-w3-home-'));
  const opencodeData = mkdtempSync(join(tmpdir(), 'cosyncing-w3-opencode-data-'));
  // The workspace sits one level under the broker's HOME, so `~/<ws>/…` resolves in and `~` itself
  // resolves out — both halves of the §3.1 `~` rule are then observable over the real routes.
  const userHome = mkdtempSync(join(tmpdir(), 'cosyncing-w3-userhome-'));
  const sessionCwd = mkdtempSync(join(userHome, 'workspace-'));
  const workspaceName = basename(sessionCwd);
  const sessionId = 'w3-session';
  const secretDir = mkdtempSync(join(tmpdir(), 'cosyncing-w3-secret-'));
  const secretFile = join(secretDir, 'secret.txt');

  mkdirSync(join(opencodeData, 'storage', 'session', 'demo'), { recursive: true });
  writeFileSync(join(opencodeData, 'storage', 'session', 'demo', `${sessionId}.json`), JSON.stringify({
    id: sessionId,
    directory: sessionCwd,
    title: 'W3 Session',
    time: { created: Date.now(), updated: Date.now() },
  }));

  writeFileSync(join(sessionCwd, 'hello.txt'), 'hello-from-workspace');
  writeFileSync(join(sessionCwd, ' spaced name.txt '), 'space-preserved');
  writeFileSync(join(sessionCwd, 'bad"name.txt'), 'quoted-name');
  mkdirSync(join(sessionCwd, 'nested'));
  writeFileSync(join(sessionCwd, 'nested', 'note.txt'), 'nested-note');
  writeFileSync(join(sessionCwd, 'binary.bin'), new Uint8Array([0xff, 0x00, 0x10, 0x80, 0x41]));
  // Source files the suffix table used to label `application/octet-stream`, which the
  // client then refused — the defect that kept the viewer from opening Python at all.
  writeFileSync(join(sessionCwd, 'main.py'), 'print("hi")\n');
  writeFileSync(join(sessionCwd, 'lib.rs'), 'fn main() {}\n');
  writeFileSync(join(sessionCwd, 'app.tsx'), 'export const A = 1;\n');
  writeFileSync(join(sessionCwd, 'conf.toml'), '[a]\nb = 1\n');
  writeFileSync(join(sessionCwd, '.gitignore'), 'node_modules\n');
  writeFileSync(join(sessionCwd, 'Makefile'), 'all:\n\t@true\n');
  writeFileSync(join(sessionCwd, 'Dockerfile'), 'FROM scratch\n');
  writeFileSync(join(sessionCwd, 'notes.unknownext'), 'still octet-stream\n');
  writeFileSync(secretFile, 'do not serve this');
  symlinkSync(secretFile, join(sessionCwd, 'link-to-secret'));

  const port = await freePort();
  const { broker, base } = await startBroker(port, TOK, opencodeData, home, '8', userHome);

  const requestJson = async (path: string, tokened = true): Promise<{ res: Response; body: any }> => {
    const headers: Record<string, string> = {};
    if (tokened) headers['x-cosyncing-token'] = TOK;
    const res = await fetch(`${base}${path}`, { headers });
    const text = await res.text();
    let body: any = undefined;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    return { res, body };
  };

  try {
    const listNoAuth = await requestJson(`/api/sessions/opencode/${encodeURIComponent(sessionId)}/fs`, false);
    assert.equal(listNoAuth.res.status, 401);

    const listResp = await requestJson(`/api/sessions/opencode/${encodeURIComponent(sessionId)}/fs`);
    assert.equal(listResp.res.status, 200);
    assert.equal(listResp.body.ok, true);
    assert.equal(listResp.body.stat.type, 'directory');
    const names = listResp.body.entries.map((e: any) => e.name).sort();
    assert.deepEqual(names.includes('hello.txt') && names.includes('nested') && names.includes('binary.bin'), true);

    const fileStat = await requestJson(`/api/sessions/opencode/${encodeURIComponent(sessionId)}/fs?path=hello.txt`);
    assert.equal(fileStat.res.status, 200);
    assert.equal(fileStat.body.stat.type, 'file');

    const readText = await requestJson(`/api/sessions/opencode/${encodeURIComponent(sessionId)}/fs/read?path=hello.txt&maxBytes=5`);
    assert.equal(readText.res.status, 200);
    assert.equal(readText.body.encoding, 'utf8');
    assert.equal(readText.body.data, 'hello');
    assert.equal(readText.body.truncated, true);
    assert.equal(readText.body.limit, 5);
    assert.equal(readText.body.mimeType, 'text/plain; charset=utf-8');

    const spaced = await requestJson(`/api/sessions/opencode/${encodeURIComponent(sessionId)}/fs/read?path=${encodeURIComponent(' spaced name.txt ')}`);
    assert.equal(spaced.res.status, 200);
    assert.equal(spaced.body.path, ' spaced name.txt ');
    assert.equal(spaced.body.data, 'space-pr');

    const readBinary = await requestJson(`/api/sessions/opencode/${encodeURIComponent(sessionId)}/fs/read?path=binary.bin`);
    assert.equal(readBinary.res.status, 200);
    assert.equal(readBinary.body.encoding, 'base64');

    // Source suffixes resolve to `text/*` so a client older than this table — which
    // admits `text/*` wholesale — sees them as previewable without an upgrade.
    const sourceMimes: Array<[string, string]> = [
      ['main.py', 'text/x-python; charset=utf-8'],
      ['lib.rs', 'text/x-rust; charset=utf-8'],
      ['app.tsx', 'text/x-typescript; charset=utf-8'],
      ['conf.toml', 'text/x-toml; charset=utf-8'],
      ['.gitignore', 'text/plain; charset=utf-8'],
      ['Makefile', 'text/x-makefile; charset=utf-8'],
      ['Dockerfile', 'text/x-dockerfile; charset=utf-8'],
    ];
    for (const [name, mime] of sourceMimes) {
      const read = await requestJson(`/api/sessions/opencode/${encodeURIComponent(sessionId)}/fs/read?path=${encodeURIComponent(name)}`);
      assert.equal(read.res.status, 200, `${name} read status`);
      assert.equal(read.body.encoding, 'utf8', `${name} encoding`);
      assert.equal(read.body.mimeType, mime, `${name} mimeType`);
      assert.equal(read.body.mimeType.startsWith('text/'), true, `${name} is text/*`);
    }
    // An unrecognised suffix still gets no guess — the label is a hint, not a sniff.
    const unknown = await requestJson(`/api/sessions/opencode/${encodeURIComponent(sessionId)}/fs/read?path=notes.unknownext`);
    assert.equal(unknown.body.mimeType, 'application/octet-stream');
    assert.equal(unknown.body.encoding, 'utf8');

    const download = await fetch(`${base}/api/sessions/opencode/${encodeURIComponent(sessionId)}/fs/download?path=nested/note.txt`, {
      headers: { 'x-cosyncing-token': TOK },
    });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-disposition'), 'attachment; filename=\"note.txt\"');
    assert.equal(download.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(download.headers.get('x-cosyncing-mime-type'), 'text/plain; charset=utf-8');
    assert.equal(download.headers.get('accept-ranges'), 'bytes');
    assert.match(download.headers.get('etag') ?? '', /^"[A-Za-z0-9_-]+"$/);
    assert.match(download.headers.get('last-modified') ?? '', /GMT$/);
    assert.equal(await download.text(), 'nested-note');

    const downloadUrl = `${base}/api/sessions/opencode/${encodeURIComponent(sessionId)}/fs/download?path=nested/note.txt`;
    const range = await fetch(downloadUrl, { headers: { 'x-cosyncing-token': TOK, range: 'bytes=0-5' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), 'bytes 0-5/11');
    assert.equal(range.headers.get('accept-ranges'), 'bytes');
    assert.equal(range.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await range.text(), 'nested');

    const suffix = await fetch(downloadUrl, { headers: { 'x-cosyncing-token': TOK, range: 'bytes=-4' } });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers.get('content-range'), 'bytes 7-10/11');
    assert.equal(await suffix.text(), 'note');

    const openEnded = await fetch(downloadUrl, { headers: { 'x-cosyncing-token': TOK, range: 'bytes=7-' } });
    assert.equal(openEnded.status, 206);
    assert.equal(await openEnded.text(), 'note');

    const matchingIfRange = await fetch(downloadUrl, {
      headers: { 'x-cosyncing-token': TOK, range: 'bytes=7-', 'if-range': download.headers.get('etag')! },
    });
    assert.equal(matchingIfRange.status, 206);
    assert.equal(await matchingIfRange.text(), 'note');

    const matchingDateIfRange = await fetch(downloadUrl, {
      headers: { 'x-cosyncing-token': TOK, range: 'bytes=7-', 'if-range': download.headers.get('last-modified')! },
    });
    assert.equal(matchingDateIfRange.status, 206);
    assert.equal(await matchingDateIfRange.text(), 'note');

    const staleIfRange = await fetch(downloadUrl, {
      headers: { 'x-cosyncing-token': TOK, range: 'bytes=7-', 'if-range': '"stale"' },
    });
    assert.equal(staleIfRange.status, 200);
    assert.equal(staleIfRange.headers.get('content-range'), null);
    assert.equal(await staleIfRange.text(), 'nested-note');

    for (const invalidRange of ['bytes=99-', 'bytes=5-4', 'bytes=0-1,4-5', 'items=0-1']) {
      const unsatisfied = await fetch(downloadUrl, { headers: { 'x-cosyncing-token': TOK, range: invalidRange } });
      assert.equal(unsatisfied.status, 416, invalidRange);
      assert.equal(unsatisfied.headers.get('content-range'), 'bytes */11', invalidRange);
      assert.equal(unsatisfied.headers.get('accept-ranges'), 'bytes', invalidRange);
      assert.equal(await unsatisfied.text(), '', invalidRange);
    }

    writeFileSync(join(sessionCwd, 'too-large.txt'), 'x'.repeat(17));
    const tooLargeDownload = await requestJson(`/api/sessions/opencode/${encodeURIComponent(sessionId)}/fs/download?path=too-large.txt`);
    assert.equal(tooLargeDownload.res.status, 413);
    assert.equal(tooLargeDownload.body.code, 'FS_DOWNLOAD_TOO_LARGE');

    const quotedDownload = await fetch(`${base}/api/sessions/opencode/${encodeURIComponent(sessionId)}/fs/download?path=${encodeURIComponent('bad"name.txt')}`, {
      headers: { 'x-cosyncing-token': TOK },
    });
    assert.equal(quotedDownload.status, 200);
    assert.equal(quotedDownload.headers.get('content-disposition'), 'attachment; filename=\"bad_name.txt\"');

    const listTraversal = await requestJson(`/api/sessions/opencode/${encodeURIComponent(sessionId)}/fs?path=../outside`);
    assert.equal(listTraversal.res.status, 400);
    assert.equal(listTraversal.body.code, 'PATH_ESCAPE');

    const readSymlink = await requestJson(`/api/sessions/opencode/${encodeURIComponent(sessionId)}/fs/read?path=link-to-secret`);
    assert.equal(readSymlink.res.status, 400);
    assert.equal(readSymlink.body.code, 'PATH_SYMLINK');

    const downloadSymlink = await fetch(`${base}/api/sessions/opencode/${encodeURIComponent(sessionId)}/fs/download?path=link-to-secret`, {
      headers: { 'x-cosyncing-token': TOK },
    });
    assert.equal(downloadSymlink.status, 400);

    const readDirAsFile = await requestJson(`/api/sessions/opencode/${encodeURIComponent(sessionId)}/fs/read?path=nested`);
    assert.equal(readDirAsFile.res.status, 400);
    assert.equal(readDirAsFile.body.code, 'NOT_REGULAR_FILE');

    const missingSession = await requestJson(`/api/sessions/opencode/missing-${sessionId}/fs`);
    assert.equal(missingSession.res.status, 404);

    // ── Absolute and `~` requests over the real routes ────────────────────────
    const sessionFs = (route: string, path: string) =>
      requestJson(`/api/sessions/opencode/${encodeURIComponent(sessionId)}${route}${route.includes('?') ? '&' : '?'}path=${encodeURIComponent(path)}`);

    const absStat = await sessionFs('/fs', join(sessionCwd, 'hello.txt'));
    assert.equal(absStat.res.status, 200);
    assert.deepEqual(absStat.body.stat, fileStat.body.stat);

    const absDirList = await sessionFs('/fs', sessionCwd);
    const relDirList = await requestJson(`/api/sessions/opencode/${encodeURIComponent(sessionId)}/fs`);
    assert.equal(absDirList.res.status, 200);
    assert.equal(absDirList.body.stat.type, 'directory');
    assert.deepEqual(absDirList.body, relDirList.body);

    const absNestedList = await sessionFs('/fs', join(sessionCwd, 'nested'));
    assert.equal(absNestedList.res.status, 200);
    assert.equal(absNestedList.body.path, 'nested');
    assert.deepEqual(absNestedList.body.entries.map((e: any) => e.name), ['note.txt']);

    const absRead = await sessionFs('/fs/read?maxBytes=5', join(sessionCwd, 'hello.txt'));
    assert.equal(absRead.res.status, 200);
    assert.equal(absRead.body.path, 'hello.txt');
    assert.equal(absRead.body.data, 'hello');

    const absDownload = await fetch(
      `${base}/api/sessions/opencode/${encodeURIComponent(sessionId)}/fs/download?path=${encodeURIComponent(join(sessionCwd, 'nested', 'note.txt'))}`,
      { headers: { 'x-cosyncing-token': TOK } },
    );
    assert.equal(absDownload.status, 200);
    assert.equal(absDownload.headers.get('content-disposition'), 'attachment; filename=\"note.txt\"');
    assert.equal(await absDownload.text(), 'nested-note');

    const absOutside = await sessionFs('/fs/read', secretFile);
    assert.equal(absOutside.res.status, 400);
    assert.equal(absOutside.body.code, 'PATH_ESCAPE');

    const absOutsideStat = await sessionFs('/fs', secretFile);
    assert.equal(absOutsideStat.res.status, 400);
    assert.equal(absOutsideStat.body.code, 'PATH_ESCAPE');

    const absSymlink = await sessionFs('/fs/read', join(sessionCwd, 'link-to-secret'));
    assert.equal(absSymlink.res.status, 400);
    assert.equal(absSymlink.body.code, 'PATH_SYMLINK');

    const absMissing = await sessionFs('/fs', join(sessionCwd, 'not-here.txt'));
    assert.equal(absMissing.res.status, 404);
    assert.equal(absMissing.body.code, 'NOT_FOUND');

    const tildeRead = await sessionFs('/fs/read?maxBytes=5', `~/${workspaceName}/hello.txt`);
    assert.equal(tildeRead.res.status, 200);
    assert.equal(tildeRead.body.path, 'hello.txt');
    assert.equal(tildeRead.body.data, 'hello');

    const tildeDir = await sessionFs('/fs', `~/${workspaceName}/nested`);
    assert.equal(tildeDir.res.status, 200);
    assert.equal(tildeDir.body.path, 'nested');

    const tildeOutside = await sessionFs('/fs', '~');
    assert.equal(tildeOutside.res.status, 400);
    assert.equal(tildeOutside.body.code, 'PATH_ESCAPE');
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
    rmSync(opencodeData, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
    rmSync(secretDir, { recursive: true, force: true });
  }
});

// The listener is loopback-only (`BROKER_LISTEN_HOST`, configuration.ts), so a non-loopback caller
// can no longer be produced in-process. The gate that replaced the address check treats every HTTP
// client as T2, so the default-deny probe is now the loopback tokened client itself.
await test('workspace file API is default-denied to authenticated HTTP clients unless locally enabled', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-w3-gate-home-'));
  const opencodeData = mkdtempSync(join(tmpdir(), 'cosyncing-w3-gate-opencode-'));
  const sessionCwd = mkdtempSync(join(tmpdir(), 'cosyncing-w3-gate-session-'));
  const sessionId = 'w3-gate-session';
  mkdirSync(join(opencodeData, 'storage', 'session', 'demo'), { recursive: true });
  writeFileSync(join(opencodeData, 'storage', 'session', 'demo', `${sessionId}.json`), JSON.stringify({
    id: sessionId,
    directory: sessionCwd,
    title: 'W3 Gated Session',
    time: { created: Date.now(), updated: Date.now() },
  }));
  writeFileSync(join(sessionCwd, 'secret.env'), 'TOKEN=do-not-read-remotely');

  const port = await freePort();
  const { broker, base } = await startBrokerWithEnv({
    PORT: String(port),
    COSYNCING_TOKEN: TOK,
    COSYNCING_HOME: home,
    OPENCODE_DATA: opencodeData,
    COSYNCING_FS_DOWNLOAD_MAX_BYTES: '64',
  });

  try {
    for (const route of ['/fs', '/fs/read?path=secret.env', '/fs/download?path=secret.env']) {
      const denied = await fetch(`${base}/api/sessions/opencode/${encodeURIComponent(sessionId)}${route}`, {
        headers: { 'x-cosyncing-token': TOK },
      });
      assert.equal(denied.status, 403, route);
      assert.equal((await denied.json()).code, 'FS_REMOTE_DISABLED', route);
    }
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
  }

  // The documented production knob (features.httpWorkspaceBrowsing) opens the same routes.
  writeBrokerConfig({
    ...defaultBrokerConfig(),
    features: { httpWorkspaceBrowsing: true },
  }, home);
  const enabledPort = await freePort();
  const enabled = await startBrokerWithEnv({
    PORT: String(enabledPort),
    COSYNCING_TOKEN: TOK,
    COSYNCING_HOME: home,
    OPENCODE_DATA: opencodeData,
    COSYNCING_FS_DOWNLOAD_MAX_BYTES: '64',
  });

  try {
    const allowed = await fetch(`${enabled.base}/api/sessions/opencode/${encodeURIComponent(sessionId)}/fs/read?path=secret.env`, {
      headers: { 'x-cosyncing-token': TOK },
    });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).data, 'TOKEN=do-not-read-remotely');
  } finally {
    enabled.broker.kill();
    await enabled.broker.exited.catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
    rmSync(opencodeData, { recursive: true, force: true });
    rmSync(sessionCwd, { recursive: true, force: true });
  }
});

if (failures) {
  console.error(`\nFAIL: ${failures} test(s) failed`);
  process.exit(1);
}

console.log(`\nPASS: workspace file API tests passed`);
