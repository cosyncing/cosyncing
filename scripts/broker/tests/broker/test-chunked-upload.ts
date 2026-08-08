#!/usr/bin/env bun
/**
 * W4 chunked/resumable upload protocol acceptance tests.
 *
 * Validates: init → chunked PATCH → resume with offset → complete with byte-exact inbox write.
 */
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { moveUploadFileIntoInbox } from '../../../../packages/typescript/broker/src/upload-staging.ts';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('could not allocate test port');
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return (addr as any).port;
}

async function waitHealthy(base: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      /* keep waiting */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('broker did not become healthy');
}

interface Broker {
  broker: ReturnType<typeof Bun.spawn>;
  base: string;
}

async function startBroker(
  port: number,
  token: string,
  opencodeData: string,
  home: string,
  uploadMaxBytes?: number,
  uploadChunkMaxBytes?: number,
): Promise<Broker> {
  const env: Record<string, string> = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    COSYNCING_TOKEN: token,
    OPENCODE_DATA: opencodeData,
    COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
    COSYNCING_HOME: home,
  };
  if (uploadMaxBytes != null) env.COSYNCING_UPLOAD_MAX_BYTES = String(uploadMaxBytes);
  if (uploadChunkMaxBytes != null) env.COSYNCING_UPLOAD_CHUNK_MAX_BYTES = String(uploadChunkMaxBytes);
  const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env,
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const base = `http://127.0.0.1:${port}`;
  await waitHealthy(base);
  return { broker, base };
}

async function testJson<T>(url: string, init?: RequestInit): Promise<{ res: Response; body: T }> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(async () => {
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  })) as T;
  return { res, body };
}

async function run(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name} - ${err instanceof Error ? err.message : String(err)}`);
    failures++;
  }
}

let failures = 0;
const TOK = 'w4-chunked-upload-token';
const encoder = new TextEncoder();

await run('upload completion falls back to copy+unlink when rename crosses filesystems', () => {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-w4-exdev-'));
  const staged = join(root, 'staged.bin');
  const final = join(root, 'final.bin');
  writeFileSync(staged, 'cross-device-data');
  let copied = false;
  let unlinked = false;

  moveUploadFileIntoInbox(staged, final, {
    renameSync() {
      const err = new Error('cross-device link not permitted') as NodeJS.ErrnoException;
      err.code = 'EXDEV';
      throw err;
    },
    copyFileSync(from, to) {
      copied = true;
      assert.equal(from, staged);
      assert.equal(to, final);
      writeFileSync(to, readFileSync(from));
    },
    unlinkSync(path) {
      unlinked = true;
      assert.equal(path, staged);
      rmSync(path);
    },
  });

  assert.equal(copied, true);
  assert.equal(unlinked, true);
  assert.equal(readFileSync(final, 'utf8'), 'cross-device-data');
  assert.equal(existsSync(staged), false);
  rmSync(root, { recursive: true, force: true });
});

await run('chunked upload lands byte-exact in session inbox and supports resume', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-w4-home-'));
  const opencodeData = mkdtempSync(join(tmpdir(), 'cosyncing-w4-opencode-data-'));
  const sessionCwd = mkdtempSync(join(tmpdir(), 'cosyncing-w4-session-'));
  const sessionId = 'w4-upload-session';
  mkdirSync(join(opencodeData, 'storage', 'session', 'demo'), { recursive: true });
  writeFileSync(
    join(opencodeData, 'storage', 'session', 'demo', `${sessionId}.json`),
    JSON.stringify({
      id: sessionId,
      directory: sessionCwd,
      title: 'W4 Upload Session',
      time: { created: Date.now(), updated: Date.now() },
    }),
  );

  const port = await freePort();
  const { broker, base } = await startBroker(port, TOK, opencodeData, home, 64); // explicit small cap above payload

  const payload = encoder.encode('A'.repeat(40));
  const half = payload.slice(0, 20);
  const rest = payload.slice(20);
  const encodedName = encodeURIComponent(sessionId);
  const headers = { 'content-type': 'application/json', 'x-cosyncing-token': TOK };

  try {
    const initResp = await testJson<{ ok: boolean; uploadId: string; offset: number; size: number; expiresAt: number }>(
      `${base}/api/sessions/opencode/${encodedName}/uploads`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'payload.bin',
          mimeType: 'application/octet-stream',
          size: payload.length,
        }),
      },
    );
    assert.equal(initResp.res.status, 200);
    assert.equal(initResp.body.ok, true);
    const uploadId = initResp.body.uploadId;
    assert.equal(initResp.body.offset, 0);
    assert.equal(initResp.body.size, payload.length);

    const first = await testJson<{
      ok: boolean;
      uploadId: string;
      offset: number;
      size: number;
      progress: number;
    }>(`${base}/api/sessions/opencode/${encodedName}/uploads/${encodeURIComponent(uploadId)}`, {
      method: 'PATCH',
      headers: { ...headers, 'x-cosyncing-upload-offset': '0' },
      body: half,
    });
    assert.equal(first.res.status, 200);
    assert.equal(first.body.offset, half.length);
    assert.equal(first.body.uploadId, uploadId);
    assert.equal(typeof first.body.progress, 'number');

    const statusResp = await testJson<{
      ok: boolean;
      uploadId: string;
      offset: number;
      size: number;
      name: string;
      mimeType: string;
    }>(`${base}/api/sessions/opencode/${encodedName}/uploads/${encodeURIComponent(uploadId)}`, {
      method: 'GET',
      headers,
    });
    assert.equal(statusResp.res.status, 200);
    assert.equal(statusResp.body.offset, half.length);

    const badOffset = await testJson<{ ok?: boolean; code?: string }>(
      `${base}/api/sessions/opencode/${encodedName}/uploads/${encodeURIComponent(uploadId)}`,
      {
        method: 'PATCH',
        headers: { ...headers, 'x-cosyncing-upload-offset': '0' },
        body: rest,
      },
    );
    assert.equal(badOffset.res.status, 409);
    assert.equal(badOffset.body.code, 'UPLOAD_OFFSET_MISMATCH');
    assert.equal((badOffset.body as { offset: number }).offset, half.length);

    const second = await testJson<{ ok: boolean; uploadId: string; offset: number; size: number; progress: number }>(
      `${base}/api/sessions/opencode/${encodedName}/uploads/${encodeURIComponent(uploadId)}`,
      {
        method: 'PATCH',
        headers: { ...headers, 'x-cosyncing-upload-offset': String(half.length) },
        body: rest,
      },
    );
    assert.equal(second.res.status, 200);
    assert.equal(second.body.offset, payload.length);
    assert.equal(second.body.uploadId, uploadId);

    const complete = await testJson<{
      ok: boolean;
      uploadId: string;
      stagedRef: string;
      name: string;
      size: number;
      mimeType: string;
      expiresAt: number;
    }>(
      `${base}/api/sessions/opencode/${encodedName}/uploads/${encodeURIComponent(uploadId)}/complete`,
      { method: 'POST', headers },
    );
    assert.equal(complete.res.status, 200);
    assert.equal(complete.body.ok, true);
    assert.equal(complete.body.size, payload.length);
    assert.equal(complete.body.name, 'payload.bin');
    assert.equal(complete.body.uploadId, uploadId);
    assert.match(complete.body.stagedRef, /^stg1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    assert.equal('path' in complete.body, false);

    const inbox = `${sessionCwd}/.cosyncing/inbox/payload.bin`;
    const landed = readFileSync(inbox);
    assert.deepEqual([...landed], [...payload]);
    assert.equal(landed.length, payload.length);
    assert.equal(await Bun.file(inbox).exists(), true);
    const finalContents = new TextDecoder().decode(landed);
    assert.equal(finalContents.length, 40);
    assert.equal(finalContents.startsWith('AAAAA'), true);
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
    rmSync(opencodeData, { recursive: true, force: true });
    rmSync(sessionCwd, { recursive: true, force: true });
  }
});

await run('chunked upload accepts a file larger than the legacy 32 MB WebSocket frame cap', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-w4-home-large-'));
  const opencodeData = mkdtempSync(join(tmpdir(), 'cosyncing-w4-opencode-large-'));
  const sessionCwd = mkdtempSync(join(tmpdir(), 'cosyncing-w4-session-large-'));
  const sessionId = 'w4-large-session';
  const encodedName = encodeURIComponent(sessionId);
  mkdirSync(join(opencodeData, 'storage', 'session', 'demo'), { recursive: true });
  writeFileSync(
    join(opencodeData, 'storage', 'session', 'demo', `${sessionId}.json`),
    JSON.stringify({
      id: sessionId,
      directory: sessionCwd,
      title: 'W4 Large Upload Session',
      time: { created: Date.now(), updated: Date.now() },
    }),
  );
  const port = await freePort();
  const totalBytes = 32 * 1024 * 1024 + 12345;
  const chunkBytes = 8 * 1024 * 1024;
  const { broker, base } = await startBroker(port, TOK, opencodeData, home, 40 * 1024 * 1024, chunkBytes);
  const headers = { 'content-type': 'application/json', 'x-cosyncing-token': TOK };

  try {
    const init = await testJson<{ ok: boolean; uploadId: string }>(`${base}/api/sessions/opencode/${encodedName}/uploads`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'large.bin', mimeType: 'application/octet-stream', size: totalBytes }),
    });
    assert.equal(init.res.status, 200);
    assert.equal(init.body.ok, true);

    const expectedHash = createHash('sha256');
    let offset = 0;
    let chunkIndex = 0;
    while (offset < totalBytes) {
      const size = Math.min(chunkBytes, totalBytes - offset);
      const chunk = new Uint8Array(size);
      chunk.fill((chunkIndex * 17) % 251);
      expectedHash.update(chunk);
      const patch = await testJson<{ ok: boolean; offset: number; progress: number }>(
        `${base}/api/sessions/opencode/${encodedName}/uploads/${encodeURIComponent(init.body.uploadId)}`,
        {
          method: 'PATCH',
          headers: { ...headers, 'x-cosyncing-upload-offset': String(offset), 'content-type': 'application/octet-stream' },
          body: chunk,
        },
      );
      offset += size;
      assert.equal(patch.res.status, 200);
      assert.equal(patch.body.offset, offset);
      assert.equal(patch.body.progress > 0, true);
      chunkIndex += 1;
    }

    const complete = await testJson<{ ok: boolean; stagedRef: string; name: string; size: number }>(
      `${base}/api/sessions/opencode/${encodedName}/uploads/${encodeURIComponent(init.body.uploadId)}/complete`,
      { method: 'POST', headers },
    );
    assert.equal(complete.res.status, 200);
    assert.equal(complete.body.size, totalBytes);
    assert.match(complete.body.stagedRef, /^stg1\./);
    const landed = readFileSync(join(sessionCwd, '.cosyncing', 'inbox', complete.body.name));
    assert.equal(landed.byteLength, totalBytes);
    assert.equal(createHash('sha256').update(landed).digest('hex'), expectedHash.digest('hex'));
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
    rmSync(opencodeData, { recursive: true, force: true });
    rmSync(sessionCwd, { recursive: true, force: true });
  }
});

await run('chunk API rejects oversized init and oversized chunks with stable error codes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-w4-home-overflow-'));
  const opencodeData = mkdtempSync(join(tmpdir(), 'cosyncing-w4-opencode-overflow-'));
  const sessionCwd = mkdtempSync(join(tmpdir(), 'cosyncing-w4-session-overflow-'));
  const sessionId = 'w4-overflow-session';
  const encodedName = encodeURIComponent(sessionId);

  mkdirSync(join(opencodeData, 'storage', 'session', 'demo'), { recursive: true });
  writeFileSync(
    join(opencodeData, 'storage', 'session', 'demo', `${sessionId}.json`),
    JSON.stringify({
      id: sessionId,
      directory: sessionCwd,
      title: 'W4 Overflow Session',
      time: { created: Date.now(), updated: Date.now() },
    }),
  );
  const port = await freePort();
  const { broker, base } = await startBroker(port, TOK, opencodeData, home, 16); // 16-byte max
  const headers = { 'content-type': 'application/json', 'x-cosyncing-token': TOK };

  try {
    const tooLargeInit = await testJson<{ ok?: boolean; code?: string }>(
      `${base}/api/sessions/opencode/${encodedName}/uploads`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'too-large.bin', mimeType: 'application/octet-stream', size: 32 }),
      },
    );
    assert.equal(tooLargeInit.res.status, 413);
    assert.equal(tooLargeInit.body.code, 'UPLOAD_TOO_LARGE');

    const init = await testJson<{ ok: boolean; uploadId: string; offset: number; size?: number }>(
      `${base}/api/sessions/opencode/${encodedName}/uploads`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'tiny.bin', mimeType: 'application/octet-stream' }),
      },
    );
    assert.equal(init.res.status, 200);
    assert.equal(init.body.ok, true);
    const uploadId = init.body.uploadId;

    const overChunk = await testJson<{ ok?: boolean; code?: string }>(
      `${base}/api/sessions/opencode/${encodedName}/uploads/${encodeURIComponent(uploadId)}`,
      {
        method: 'PATCH',
        headers: { ...headers, 'x-cosyncing-upload-offset': '0', 'content-type': 'application/octet-stream' },
        body: encoder.encode('X'.repeat(32)),
      },
    );
    assert.equal(overChunk.res.status, 413);
    assert.equal(overChunk.body.code, 'UPLOAD_TOO_LARGE');
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
    rmSync(opencodeData, { recursive: true, force: true });
    rmSync(sessionCwd, { recursive: true, force: true });
  }
});

await run('upload routes require auth when token is configured', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-w4-home-auth-'));
  const opencodeData = mkdtempSync(join(tmpdir(), 'cosyncing-w4-opencode-auth-'));
  const sessionCwd = mkdtempSync(join(tmpdir(), 'cosyncing-w4-session-auth-'));
  const sessionId = 'w4-auth-session';
  const encodedName = encodeURIComponent(sessionId);
  mkdirSync(join(opencodeData, 'storage', 'session', 'demo'), { recursive: true });
  writeFileSync(
    join(opencodeData, 'storage', 'session', 'demo', `${sessionId}.json`),
    JSON.stringify({
      id: sessionId,
      directory: sessionCwd,
      title: 'W4 Auth Session',
      time: { created: Date.now(), updated: Date.now() },
    }),
  );
  const port = await freePort();
  const { broker, base } = await startBroker(port, TOK, opencodeData, home, 64);

  try {
    const initReq = await fetch(`${base}/api/sessions/opencode/${encodedName}/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'no-auth.bin', mimeType: 'application/octet-stream', size: 4 }),
    });
    assert.equal(initReq.status, 401);
    const statusReq = await fetch(`${base}/api/sessions/opencode/${encodedName}/uploads/does-not-exist`, {
      method: 'GET',
    });
    assert.equal(statusReq.status, 401);
    const patchReq = await fetch(`${base}/api/sessions/opencode/${encodedName}/uploads/does-not-exist`, {
      method: 'PATCH',
      headers: { 'x-cosyncing-upload-offset': '0' },
      body: encoder.encode('abc'),
    });
    assert.equal(patchReq.status, 401);
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
    rmSync(opencodeData, { recursive: true, force: true });
    rmSync(sessionCwd, { recursive: true, force: true });
  }
});

await run('upload ids are broker-issued UUIDs and cannot escape staging paths', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-w4-home-id-'));
  const opencodeData = mkdtempSync(join(tmpdir(), 'cosyncing-w4-opencode-id-'));
  const sessionCwd = mkdtempSync(join(tmpdir(), 'cosyncing-w4-session-id-'));
  const sessionId = 'w4-id-session';
  const encodedName = encodeURIComponent(sessionId);
  mkdirSync(join(opencodeData, 'storage', 'session', 'demo'), { recursive: true });
  writeFileSync(
    join(opencodeData, 'storage', 'session', 'demo', `${sessionId}.json`),
    JSON.stringify({
      id: sessionId,
      directory: sessionCwd,
      title: 'W4 Upload Id Session',
      time: { created: Date.now(), updated: Date.now() },
    }),
  );
  const port = await freePort();
  const { broker, base } = await startBroker(port, TOK, opencodeData, home, 64);
  const headers = { 'x-cosyncing-token': TOK };

  try {
    const traversalId = encodeURIComponent('../escape');
    const statusReq = await testJson<{ ok?: boolean; code?: string }>(
      `${base}/api/sessions/opencode/${encodedName}/uploads/${traversalId}`,
      { method: 'GET', headers },
    );
    assert.equal(statusReq.res.status, 400);
    assert.equal(statusReq.body.code, 'BAD_PARAM');

    const patchReq = await testJson<{ ok?: boolean; code?: string }>(
      `${base}/api/sessions/opencode/${encodedName}/uploads/${traversalId}`,
      {
        method: 'PATCH',
        headers: { ...headers, 'x-cosyncing-upload-offset': '0' },
        body: encoder.encode('abc'),
      },
    );
    assert.equal(patchReq.res.status, 400);
    assert.equal(patchReq.body.code, 'BAD_PARAM');
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
    rmSync(opencodeData, { recursive: true, force: true });
    rmSync(sessionCwd, { recursive: true, force: true });
  }
});

await run('upload patch bodies are bounded before staging writes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-w4-home-chunkcap-'));
  const opencodeData = mkdtempSync(join(tmpdir(), 'cosyncing-w4-opencode-chunkcap-'));
  const sessionCwd = mkdtempSync(join(tmpdir(), 'cosyncing-w4-session-chunkcap-'));
  const sessionId = 'w4-chunkcap-session';
  const encodedName = encodeURIComponent(sessionId);
  mkdirSync(join(opencodeData, 'storage', 'session', 'demo'), { recursive: true });
  writeFileSync(
    join(opencodeData, 'storage', 'session', 'demo', `${sessionId}.json`),
    JSON.stringify({
      id: sessionId,
      directory: sessionCwd,
      title: 'W4 Chunk Cap Session',
      time: { created: Date.now(), updated: Date.now() },
    }),
  );
  const port = await freePort();
  const { broker, base } = await startBroker(port, TOK, opencodeData, home, 64, 8);
  const headers = { 'content-type': 'application/json', 'x-cosyncing-token': TOK };

  try {
    const init = await testJson<{ ok: boolean; uploadId: string }>(`${base}/api/sessions/opencode/${encodedName}/uploads`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'chunk-cap.bin', mimeType: 'application/octet-stream', size: 16 }),
    });
    assert.equal(init.res.status, 200);

    const overChunk = await testJson<{ ok?: boolean; code?: string }>(
      `${base}/api/sessions/opencode/${encodedName}/uploads/${encodeURIComponent(init.body.uploadId)}`,
      {
        method: 'PATCH',
        headers: { ...headers, 'x-cosyncing-upload-offset': '0', 'content-type': 'application/octet-stream' },
        body: encoder.encode('123456789'),
      },
    );
    assert.equal(overChunk.res.status, 413);
    assert.equal(overChunk.body.code, 'UPLOAD_TOO_LARGE');

    const status = await testJson<{ ok: boolean; offset: number }>(
      `${base}/api/sessions/opencode/${encodedName}/uploads/${encodeURIComponent(init.body.uploadId)}`,
      { method: 'GET', headers },
    );
    assert.equal(status.res.status, 200);
    assert.equal(status.body.offset, 0);
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
    rmSync(opencodeData, { recursive: true, force: true });
    rmSync(sessionCwd, { recursive: true, force: true });
  }
});

if (failures) {
  console.error(`\nFAIL: ${failures} upload test(s) failed`);
  process.exit(1);
}
console.log(`\nPASS: chunked upload protocol tests passed`);
