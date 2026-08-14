#!/usr/bin/env bun
/**
 * W3 workspace file API acceptance coverage.
 * Covers list/stat/read/download + auth + traversal/symlink/size-caps.
 */
import { strict as assert } from 'node:assert';
import { createServer } from 'node:net';
import { closeSync, mkdtempSync, mkdirSync, readSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces, tmpdir } from 'node:os';

import {
  FsBrowseError,
  looksUtf8ish,
  prepareSessionDownload,
  validateBrowsePath,
} from '../../src/artifacts/fs-browse.ts';
import { DownloadRangeError, ifRangeMatches, parseDownloadRange } from '../../src/artifacts/fs-browse.ts';

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

async function startBroker(port: number, token: string, opencodeData: string, home: string, fsReadCap = '64'): Promise<{ broker: ReturnType<typeof Bun.spawn>; base: string }> {
  const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      COSYNCING_TOKEN: token,
      COSYNCING_FS_READ_MAX_BYTES: fsReadCap,
      COSYNCING_FS_DOWNLOAD_MAX_BYTES: '16',
      COSYNCING_WEB_COI: '0',
      COSYNCING_HOME: home,
      OPENCODE_DATA: opencodeData,
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const base = `http://127.0.0.1:${port}`;
  await waitHealthy(base);
  return { broker, base };
}

async function startBrokerWithEnv(env: Record<string, string>, baseHost = '127.0.0.1'): Promise<{ broker: ReturnType<typeof Bun.spawn>; base: string }> {
  const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: {
      ...process.env,
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
      COSYNCING_WEB_COI: '0',
      ...env,
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const base = `http://${baseHost}:${env.PORT}`;
  await waitHealthy(base);
  return { broker, base };
}

function firstNonLoopbackIpv4(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return undefined;
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
  const sessionCwd = mkdtempSync(join(tmpdir(), 'cosyncing-w3-workspace-'));
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
  writeFileSync(secretFile, 'do not serve this');
  symlinkSync(secretFile, join(sessionCwd, 'link-to-secret'));

  const port = await freePort();
  const { broker, base } = await startBroker(port, TOK, opencodeData, home, '8');

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
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
    rmSync(opencodeData, { recursive: true, force: true });
    rmSync(sessionCwd, { recursive: true, force: true });
    rmSync(secretDir, { recursive: true, force: true });
  }
});

await test('workspace file API is default-denied to non-loopback tokened clients unless locally enabled', async () => {
  const remoteHost = firstNonLoopbackIpv4();
  if (!remoteHost) {
    console.log('SKIP  no non-loopback IPv4 address available for T2 fs gate probe');
    return;
  }

  const home = mkdtempSync(join(tmpdir(), 'cosyncing-w3-remote-home-'));
  const opencodeData = mkdtempSync(join(tmpdir(), 'cosyncing-w3-remote-opencode-'));
  const sessionCwd = mkdtempSync(join(tmpdir(), 'cosyncing-w3-remote-session-'));
  const sessionId = 'w3-remote-session';
  mkdirSync(join(opencodeData, 'storage', 'session', 'demo'), { recursive: true });
  writeFileSync(join(opencodeData, 'storage', 'session', 'demo', `${sessionId}.json`), JSON.stringify({
    id: sessionId,
    directory: sessionCwd,
    title: 'W3 Remote Session',
    time: { created: Date.now(), updated: Date.now() },
  }));
  writeFileSync(join(sessionCwd, 'secret.env'), 'TOKEN=do-not-read-remotely');

  const port = await freePort();
  const { broker, base } = await startBrokerWithEnv({
    PORT: String(port),
    HOST: '0.0.0.0',
    COSYNCING_TOKEN: TOK,
    COSYNCING_HOME: home,
    OPENCODE_DATA: opencodeData,
    COSYNCING_FS_DOWNLOAD_MAX_BYTES: '64',
  }, remoteHost);

  try {
    const deniedRead = await fetch(`${base}/api/sessions/opencode/${encodeURIComponent(sessionId)}/fs/read?path=secret.env`, {
      headers: { 'x-cosyncing-token': TOK },
    });
    assert.equal(deniedRead.status, 403);
    assert.equal((await deniedRead.json()).code, 'FS_REMOTE_DISABLED');

    const deniedDownload = await fetch(`${base}/api/sessions/opencode/${encodeURIComponent(sessionId)}/fs/download?path=secret.env`, {
      headers: { 'x-cosyncing-token': TOK },
    });
    assert.equal(deniedDownload.status, 403);
    assert.equal((await deniedDownload.json()).code, 'FS_REMOTE_DISABLED');
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
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
