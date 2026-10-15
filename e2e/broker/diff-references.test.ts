/**
 * Oversized edit diffs travel as signed references, not inline bodies.
 *
 * A tool-result whose diff exceeds the inline cap (32 KiB) reaches a
 * reference-mode client (the app) as a `diffRef`: metadata plus a signed URL
 * the app fetches when the user expands the edit. These tests push edits
 * through the Pi bridge, attach as the app does, and assert the frames, the
 * served bodies, what is stored, and how a capped attach and a backward page
 * reference only the rows they actually send.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Broker, type BrokerClient, type SessionStream, startBroker } from '../harness/index.ts';
import { PiBridgeSession } from '../harness/fakes/pi-bridge-driver.ts';

/** The referenced-body ceiling this broker runs with, tuned down from 1 MiB so clipping is cheap to reach. */
const MAX_REFERENCED = 128 * 1024;

/** ~56 KiB, 1,200 changed lines: well past the inline cap and the client's 400-line render cap. */
function bigDiff(tag: string, path = `lib/${tag}.dart`, lines = 600): string {
  const out = [`--- a/${path}`, `+++ b/${path}`, `@@ -1,${lines} +1,${lines} @@`];
  for (let line = 0; line < lines; line += 1) {
    out.push(`-old line ${line} of ${tag} with enough text to be realistic`, `+new line ${line} of ${tag} with enough text to be realistic`);
  }
  return out.join('\n');
}

const edit = (callId: string, diff: string, path?: string) => ({
  t: 'tool-result', callId, name: 'edit', result: 'ok', isError: false, details: { diff }, args: path ? { path } : {},
});

const toolResults = (messages: any[] | undefined): any[] => (messages ?? []).filter((message) => message?.type === 'tool-result');
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

function blobCount(cache: string): number {
  const root = join(cache, 'artifacts', 'blobs');
  if (!existsSync(root)) return 0;
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).length;
}

async function fetchBody(base: string, fetchUrl: string): Promise<{ status: number; headers: Headers; text: string }> {
  const response = await fetch(new URL(fetchUrl, base));
  return { status: response.status, headers: response.headers, text: await response.text() };
}

describe('diff references', () => {
  let broker: Broker;
  let client: BrokerClient;
  let cache: string;
  let cwd: string;

  beforeAll(async () => {
    broker = await startBroker({
      name: 'diff-references',
      env: (paths) => ({
        COSYNCING_CACHE_DIR: join(paths.root, 'cache'),
        COSYNCING_MAX_REFERENCED_DIFF_BYTES: String(MAX_REFERENCED),
      }),
    });
    client = broker.client();
    cache = join(broker.paths.root, 'cache');
    cwd = join(broker.paths.root, 'workspace');
    mkdirSync(cwd);
  });
  afterAll(async () => {
    client?.closeAll();
    await broker?.stop();
  });

  async function sessionWith(...events: Record<string, unknown>[]): Promise<PiBridgeSession> {
    const pi = await PiBridgeSession.open(client, { cwd });
    if (events.length) await pi.events(...events);
    return pi;
  }

  async function historyOf(stream: SessionStream): Promise<any> {
    return stream.waitForKind('history');
  }

  test('an oversized edit reaches the app as a reference whose URL serves the exact body, and an inline client still gets the diff', async () => {
    const diff = bigDiff('huge');
    expect(Buffer.byteLength(diff)).toBeGreaterThan(32 * 1024);
    const pi = await sessionWith(edit('big1', diff, 'lib/huge.dart'));

    const app = await client.attach('pi', pi.id, { artifactMode: 'reference' });
    const row = await app.waitForMessage((message) => message?.callId === 'big1');
    expect(row.diff).toBeUndefined();
    expect(row.diffRef).toMatchObject({ contentHash: sha256(diff), byteSize: Buffer.byteLength(diff) });
    expect(row.diffRef.lineCount).toBeGreaterThan(400);
    expect(row.diffRef.truncated).toBeUndefined();
    expect(row.fileChanges?.length).toBeGreaterThan(0);
    for (const change of row.fileChanges) {
      expect(change.diff).toBeUndefined();
      expect(change.path).toBe('lib/huge.dart');
    }
    const served = await fetchBody(broker.url, row.diffRef.fetchUrl);
    expect(served.status).toBe(200);
    expect(served.text).toBe(diff);
    expect(served.headers.get('content-type')).toBe('application/octet-stream');
    expect(served.headers.get('content-disposition')?.startsWith('attachment;')).toBe(true);
    expect(served.headers.get('cache-control')).toBe('no-store');
    expect(served.headers.get('x-cosyncing-content-hash')).toBe(row.diffRef.contentHash);

    const forged = new URL(row.diffRef.fetchUrl, broker.url);
    const sig = forged.searchParams.get('sig')!;
    forged.searchParams.set('sig', `${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`);
    expect((await fetch(forged)).status).toBe(403);

    // Without `artifactMode: 'reference'` the broker mints no references at all.
    const inline = await client.attach('pi', pi.id);
    const inlineRow = await inline.waitForMessage((message) => message?.callId === 'big1');
    expect(inlineRow.diffRef).toBeUndefined();
    expect(inlineRow.diff).toBe(diff);
    app.close();
    inline.close();
  });

  test('an edit that arrives live is referenced too, a small diff stays inline, and a second client gets the same stored body', async () => {
    const pi = await sessionWith();
    const app = await client.attach('pi', pi.id, { artifactMode: 'reference' });
    await historyOf(app);
    const diff = bigDiff('live');
    const small = '--- a/x.txt\n+++ b/x.txt\n@@ -1,1 +1,1 @@\n-a\n+b';
    await pi.events(edit('live-big', diff, 'lib/live.dart'), edit('live-small', small, 'x.txt'));
    const big = await app.waitForMessage((message) => message?.callId === 'live-big');
    const tiny = await app.waitForMessage((message) => message?.callId === 'live-small');
    expect(big.diffRef?.contentHash).toBe(sha256(diff));
    expect(big.diff).toBeUndefined();
    expect(tiny.diffRef).toBeUndefined();
    expect(tiny.diff).toBe(small);

    const blobs = blobCount(cache);
    const second = await client.attach('pi', pi.id, { artifactMode: 'reference' });
    const again = await second.waitForMessage((message) => message?.callId === 'live-big');
    expect(again.diffRef.contentHash).toBe(big.diffRef.contentHash);
    expect(blobCount(cache)).toBe(blobs);
    app.close();
    second.close();
  });

  test('an oversized multi-file edit keeps every file\'s path, operation and rename, with the bodies behind one reference', async () => {
    const one = bigDiff('one', 'lib/one.dart').replace(/^--- /, 'diff --git a/lib/one.dart b/lib/one.dart\n--- ');
    const two = [
      'diff --git a/lib/two.dart b/src/gone.dart',
      'similarity index 50%',
      'rename from lib/two.dart',
      'rename to src/gone.dart',
      bigDiff('two', 'src/gone.dart').replace('--- a/src/gone.dart', '--- a/lib/two.dart'),
    ].join('\n');
    const diff = `${one}\n${two}`;
    const pi = await sessionWith(edit('multi', diff));
    const app = await client.attach('pi', pi.id, { artifactMode: 'reference' });
    const row = await app.waitForMessage((message) => message?.callId === 'multi');
    expect(row.diffRef.contentHash).toHaveLength(64);
    expect(row.fileChanges.map((change: any) => ({
      path: change.path,
      operation: change.operation,
      previousPath: change.previousPath,
      hasBody: change.diff !== undefined,
    }))).toEqual([
      { path: 'lib/one.dart', operation: 'edit', previousPath: undefined, hasBody: false },
      { path: 'src/gone.dart', operation: 'rename', previousPath: 'lib/two.dart', hasBody: false },
    ]);
    expect((await fetchBody(broker.url, row.diffRef.fetchUrl)).text).toBe(diff);
    app.close();
  });

  test('a body past the referenced ceiling is clipped at a line boundary and flagged truncated', async () => {
    const diff = bigDiff('runaway', 'lib/runaway.dart', 4000);
    expect(Buffer.byteLength(diff)).toBeGreaterThan(MAX_REFERENCED);
    const pi = await sessionWith(edit('runaway', diff));
    const app = await client.attach('pi', pi.id, { artifactMode: 'reference' });
    const row = await app.waitForMessage((message) => message?.callId === 'runaway');
    expect(row.diffRef.truncated).toBe(true);
    expect(row.diffRef.byteSize).toBeLessThanOrEqual(MAX_REFERENCED);
    expect(row.diffRef.byteSize).toBeGreaterThan(32 * 1024);
    const served = await fetchBody(broker.url, row.diffRef.fetchUrl);
    expect(Buffer.byteLength(served.text)).toBe(row.diffRef.byteSize);
    expect(diff.startsWith(served.text)).toBe(true);
    expect(served.text.endsWith('\n')).toBe(true); // whole lines only
    app.close();
  });

  test('a capped attach references only the rows it sends, and a backward page references only its own', async () => {
    const diffs = Array.from({ length: 6 }, (_, index) => bigDiff(`page${index}`));
    const pi = await sessionWith(...diffs.map((diff, index) => edit(`big${index}`, diff)));
    const before = blobCount(cache);
    const app = await client.attach('pi', pi.id, { artifactMode: 'reference', initialHistory: 3 });
    const history = await historyOf(app);
    const sent = toolResults(history.messages);
    expect(sent.map((message) => message.callId)).toEqual(['big3', 'big4', 'big5']);
    expect(history.reset).toBe(true);
    expect(history.truncated).toMatchObject({ shown: 3, total: 6 });
    expect(history.hasEarlier).toBe(true);
    expect(typeof history.olderCursor).toBe('string');
    for (const message of sent) {
      expect(message.diff).toBeUndefined();
      expect(message.diffRef.contentHash).toBe(sha256(diffs[Number(message.callId.slice(3))]!));
    }
    expect(blobCount(cache)).toBe(before + 3);

    app.send({ kind: 'history-page', cursor: history.olderCursor, limit: 3, clientMessageId: 'page-1' });
    const page = await app.waitForFrame((frame) => frame.kind === 'history-page' && frame.clientMessageId === 'page-1');
    const paged = toolResults(page.messages);
    expect(paged.map((message) => message.callId)).toEqual(['big0', 'big1', 'big2']);
    for (const message of paged) {
      expect(message.diff).toBeUndefined();
      expect(message.diffRef.contentHash).toBe(sha256(diffs[Number(message.callId.slice(3))]!));
    }
    expect(page.hasMore).toBe(false);
    expect(page.endOfHistory).toBe(true);
    expect(blobCount(cache)).toBe(before + 6);
    app.close();
  });

  test('the history cursor names the diff by content, so a reconnect with fresh signatures is still an empty delta', async () => {
    const pi = await sessionWith(edit('cursor', bigDiff('cursor')));
    const first = await client.attach('pi', pi.id, { artifactMode: 'reference' });
    const history = await historyOf(first);
    const firstRow = toolResults(history.messages)[0];
    first.close();
    // A later attach signs a new expiry into the reference.
    const resumed = await client.attach('pi', pi.id, { artifactMode: 'reference', since: history.cursor });
    const delta = await historyOf(resumed);
    expect(delta.reset).toBe(false);
    expect(toolResults(delta.messages)).toEqual([]);
    const fresh = await client.attach('pi', pi.id, { artifactMode: 'reference' });
    const freshRow = toolResults((await historyOf(fresh)).messages)[0];
    expect(freshRow.diffRef.contentHash).toBe(firstRow.diffRef.contentHash);
    resumed.close();
    fresh.close();
  });

  test('a reference issued before a restart still serves its body after it', async () => {
    const diff = bigDiff('durable');
    const pi = await sessionWith(edit('durable', diff));
    const app = await client.attach('pi', pi.id, { artifactMode: 'reference' });
    const row = await app.waitForMessage((message) => message?.callId === 'durable');
    app.close();
    await broker.restart();
    const served = await fetchBody(broker.url, row.diffRef.fetchUrl);
    expect(served.status).toBe(200);
    expect(served.text).toBe(diff);
  });
});
