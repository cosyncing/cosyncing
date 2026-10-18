/**
 * Files an agent hands to the user: who receives them, and how they download.
 *
 * A Pi session sends a file (or writes a deliverable with its Write tool) and
 * the broker turns it into an artifact frame for that session's clients only,
 * with a signed, relative download reference. These tests drive the Pi bridge
 * as the extension does and a client as the app does (`artifactMode:
 * 'reference'`, which is what makes the broker mint signed references), and
 * assert what the app receives and what the download route serves, across a
 * reattach, a restart, a second broker and a re-paired device.
 *
 * "Nothing else arrived" is proven with a barrier: an artifact interaction the
 * broker must refuse, sent after the frames in question, whose refusal can
 * only come back after them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import {
  type Broker,
  BrokerClient,
  type SessionStream,
  startBroker,
} from '../harness/index.ts';
import { PiBridgeSession } from '../harness/fakes/pi-bridge-driver.ts';
import { pairDevice } from '../harness/pairing.ts';

const POSIX = process.platform !== 'win32';

const artifacts = (stream: SessionStream): any[] =>
  stream.messages().filter((message) => message?.type === 'file-artifact');
const names = (stream: SessionStream): string[] => artifacts(stream).map((message) => String(message.name));
const artifactNamed = (stream: SessionStream, name: string, predicate: (message: any) => boolean = () => true) =>
  stream.waitForMessage((message) => message?.type === 'file-artifact' && message.name === name && predicate(message));

/** Wait until every frame the broker sent before this point has arrived. */
async function settled(stream: SessionStream): Promise<void> {
  const reply = await stream.sendAndAwait({
    kind: 'artifact-interaction',
    artifactKey: 'e2e-barrier',
    interaction: { type: 'action', action: 'noop' },
  });
  expect(reply.code).toBe('ARTIFACT_INTERACTION_NOT_FOUND');
}

async function attachSettled(client: BrokerClient, id: string): Promise<SessionStream> {
  const stream = await client.attach('pi', id, { artifactMode: 'reference' });
  await stream.waitForKind('history');
  await settled(stream);
  return stream;
}

/** The same signed reference, addressed to another session. */
function forSession(fetchUrl: string, sessionId: string): string {
  const url = new URL(fetchUrl, 'http://broker.invalid');
  url.pathname = url.pathname.replace(/^(\/api\/sessions\/pi\/)[^/]+/, `$1${encodeURIComponent(sessionId)}`);
  return `${url.pathname}${url.search}`;
}

async function download(base: string, fetchUrl: string, headers: Record<string, string> = {}, method = 'GET') {
  const response = await fetch(new URL(fetchUrl, base), { method, headers });
  return { response, bytes: Buffer.from(await response.arrayBuffer()) };
}

test('an actively previewed artifact survives cache pressure and resumes after a broker restart', async () => {
  const broker = await startBroker({
    name: 'artifact-preview-retention',
    env: { COSYNCING_ARTIFACT_CACHE_MAX_RECORDS: '2' },
  });
  const client = broker.client();
  try {
    const cwd = join(broker.paths.root, 'workspace');
    mkdirSync(cwd);
    const pi = await PiBridgeSession.open(client, { cwd });
    const stream = await attachSettled(client, pi.id);
    const deliver = async (name: string) => {
      writeFileSync(join(cwd, name), `%PDF-1.7\n${name}\n%%EOF`);
      expect((await pi.sendFile(join(cwd, name))).status).toBe(200);
      return artifactNamed(stream, name);
    };
    const preview = async (artifact: any) => {
      const ticket = await client.post('/api/media-preview-tickets', {
        tool: 'pi', sessionId: pi.id, artifactId: artifact.artifactKey,
      });
      expect(ticket.status).toBe(201);
      return ticket.body.url as string;
    };
    const first = await deliver('first.pdf');
    const second = await deliver('second.pdf');
    const firstUrl = await preview(first);
    const secondUrl = await preview(second);
    // The first read persists access; later ranges must also move recency even
    // while persistence is coalesced. Only the most recently read file survives.
    expect((await download(broker.url, secondUrl, { range: 'bytes=0-3' })).response.status).toBe(206);
    expect((await download(broker.url, firstUrl, { range: 'bytes=0-3' })).response.status).toBe(206);
    await deliver('third.pdf');
    const resumed = await download(broker.url, firstUrl, { range: 'bytes=4-7' });
    expect([resumed.response.status, resumed.bytes.toString()]).toEqual([206, '-1.7']);
    expect((await download(broker.url, secondUrl)).response.status).toBe(404);
    stream.close();
    await broker.restart();
    await pi.rehello();
    const refreshed = await preview(first);
    expect((await download(broker.url, refreshed, { range: 'bytes=4-7' })).response.status).toBe(206);
  } finally {
    client.closeAll();
    await broker.stop();
  }
});

/** A TCP pass-through on another port, as a reverse proxy would sit in front of the broker. */
interface Forwarder {
  origin: string;
  close(): Promise<void>;
}

async function startForwarder(targetPort: number): Promise<Forwarder> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    const upstream = connect({ host: '127.0.0.1', port: targetPort });
    for (const end of [socket, upstream]) {
      sockets.add(end);
      end.once('close', () => sockets.delete(end));
    }
    socket.pipe(upstream);
    upstream.pipe(socket);
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('forwarder has no port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    // Keep-alive connections would hold `close` open; a proxy going away drops them.
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const socket of sockets) socket.destroy();
    }),
  };
}

describe('artifact delivery is scoped to the session that sent it', () => {
  let broker: Broker;
  let forwarder: Forwarder;
  let viaProxy: BrokerClient;
  let cwd: string;
  let owner: PiBridgeSession;
  let peer: PiBridgeSession;
  let first: any;

  beforeAll(async () => {
    broker = await startBroker({
      name: 'artifacts',
      setup: (paths) => {
        // The cache root sits below a symlinked parent, the way owners relocate `~/.cache`.
        mkdirSync(join(paths.root, 'relocated-cache'));
        if (POSIX) symlinkSync(join(paths.root, 'relocated-cache'), join(paths.root, 'cache-link'));
        else mkdirSync(join(paths.root, 'cache-link'));
        cwd = join(paths.root, 'workspace');
        mkdirSync(join(cwd, '.cosyncing', 'outbox'), { recursive: true });
        // What a pre-fix broker would have surfaced to every session in this cwd.
        writeFileSync(join(cwd, '.cosyncing', 'outbox', 'old-report.txt'), 'old bytes');
      },
      env: (paths) => ({ COSYNCING_CACHE_DIR: join(paths.root, 'cache-link', 'cache') }),
    });
    forwarder = await startForwarder(broker.port);
    viaProxy = new BrokerClient(forwarder.origin, forwarder.origin.replace(/^http/, 'ws'), { kind: 'none' });
    owner = await PiBridgeSession.open(viaProxy, { cwd, title: 'owner' });
    peer = await PiBridgeSession.open(viaProxy, { cwd, title: 'peer' });
  });
  afterAll(async () => {
    viaProxy?.closeAll();
    await forwarder?.close();
    await broker?.stop();
  });

  test('a sent file reaches only its own session; old outbox files and bare writes never surface', async () => {
    expect(broker.output()).not.toContain('artifact cache unavailable');
    const ownerStream = await attachSettled(viaProxy, owner.id);
    const peerStream = await attachSettled(viaProxy, peer.id);
    expect(names(ownerStream)).toEqual([]);
    expect(names(peerStream)).toEqual([]);

    writeFileSync(join(cwd, 'bare.html'), '<h1>written, never sent</h1>');
    writeFileSync(join(cwd, 'report.txt'), 'version one');
    await owner.events(
      { t: 'delta', delta: 'Here is the report.', key: 'report-answer' },
      { t: 'final', text: 'Here is the report.', key: 'report-answer' },
    );
    const sent = await owner.sendFile(join(cwd, 'report.txt'), {
      forwarded: 'host=forged.example;proto=https',
      'x-forwarded-host': 'forged.example',
      'x-forwarded-proto': 'https',
    });
    expect(sent.status).toBe(200);
    first = await artifactNamed(ownerStream, 'report.txt');
    writeFileSync(join(cwd, 'peer-note.txt'), 'the peer sends its own');
    expect((await peer.sendFile(join(cwd, 'peer-note.txt'))).status).toBe(200);
    await artifactNamed(peerStream, 'peer-note.txt');
    await settled(ownerStream);

    expect(names(ownerStream)).toEqual(['report.txt']);
    expect(names(peerStream)).toEqual(['peer-note.txt']);
    expect(first.proactive).toBe(true);
    expect(first.transcriptAnchor).toEqual({ type: 'model-output', key: 'report-answer' });
    expect(first.interactionPolicy).toMatchObject({ mode: 'display-only', allowedActions: [] });
    ownerStream.close();
    peerStream.close();
  });

  test('the reference stays relative behind a proxy that forges forwarded headers, and only its session may use it', async () => {
    expect(first.fetchUrl.startsWith('/api/sessions/pi/')).toBe(true);
    expect(first.fetchUrl).not.toContain('forged.example');
    const exact = await download(forwarder.origin, first.fetchUrl);
    expect(exact.response.status).toBe(200);
    expect(exact.bytes.toString()).toBe('version one');
    const crossSession = await download(forwarder.origin, forSession(first.fetchUrl, peer.id));
    expect(crossSession.response.status).toBe(403);
  });

  test('a file sent before any viewer attaches keeps its position in the saved native turn', async () => {
    const unopened = await PiBridgeSession.open(viaProxy, {
      cwd,
      title: 'not yet opened',
      hello: { history: [{ t: 'user', key: 'unopened-prompt', text: 'Please send the report' }] },
    });
    writeFileSync(join(cwd, 'before-attach.md'), '# delivered before the app opened');
    expect((await unopened.sendFile(join(cwd, 'before-attach.md'))).status).toBe(200);
    const stream = await attachSettled(viaProxy, unopened.id);
    const file = artifacts(stream).find((message) => message.name === 'before-attach.md');
    expect(file.transcriptAnchor).toEqual({ type: 'user-message', key: 'unopened-prompt' });
    stream.close();
    await unopened.bye();
  });

  test('a reattach replays each session its own artifacts and nothing else', async () => {
    const ownerStream = await attachSettled(viaProxy, owner.id);
    const peerStream = await attachSettled(viaProxy, peer.id);
    expect(names(ownerStream)).toEqual(['report.txt']);
    expect(names(peerStream)).toEqual(['peer-note.txt']);
    expect(artifacts(ownerStream)[0].transcriptAnchor).toEqual(first.transcriptAnchor);
    ownerStream.close();
    peerStream.close();
  });

  test('after a restart the artifact replays to its session, its reference still downloads, and a rewrite is a new version', async () => {
    await broker.restart();
    await owner.rehello();
    await peer.rehello();
    const ownerStream = await attachSettled(viaProxy, owner.id);
    const peerStream = await attachSettled(viaProxy, peer.id);
    expect(names(ownerStream)).toEqual(['report.txt']);
    expect(names(peerStream)).toEqual(['peer-note.txt']);
    const old = await download(forwarder.origin, first.fetchUrl);
    expect(old.response.status).toBe(200);
    expect(old.bytes.toString()).toBe('version one');

    writeFileSync(join(cwd, 'report.txt'), 'version two');
    expect((await owner.sendFile(join(cwd, 'report.txt'))).status).toBe(200);
    const second = await artifactNamed(ownerStream, 'report.txt', (message) => message.artifactKey !== first.artifactKey);
    const versions = artifacts(ownerStream).filter((message) => message.name === 'report.txt');
    expect(versions).toHaveLength(2);
    expect((await download(forwarder.origin, first.fetchUrl)).bytes.toString()).toBe('version one');
    expect((await download(forwarder.origin, second.fetchUrl)).bytes.toString()).toBe('version two');
    ownerStream.close();
    peerStream.close();
  });

  test('another broker with the same native session shows none of it and cannot authorize its reference', async () => {
    const other = await startBroker({ name: 'artifacts-other' });
    try {
      const same = await PiBridgeSession.open(other.client(), {
        cwd,
        title: 'owner on another broker',
        sessionFile: owner.sessionFile,
      });
      expect(same.id).toBe(owner.id);
      const stream = await attachSettled(other.client(), same.id);
      expect(names(stream)).toEqual([]);
      const borrowed = await download(other.url, first.fetchUrl);
      expect(borrowed.response.status).toBe(403);
      stream.close();
    } finally {
      await other.stop();
    }
  });

  test('send-file refuses paths outside the workspace and symlinks; a large file becomes a lazy reference', async () => {
    const stream = await attachSettled(viaProxy, owner.id);
    writeFileSync(join(broker.paths.root, 'outside.txt'), 'outside the workspace');
    expect((await owner.sendFile(join(broker.paths.root, 'outside.txt'))).status).toBe(400);
    if (POSIX) {
      symlinkSync(join(broker.paths.root, 'outside.txt'), join(cwd, 'linked.txt'));
      expect((await owner.sendFile(join(cwd, 'linked.txt'))).status).toBe(400);
    }
    const large = Buffer.alloc(5_000_001, 0x61);
    writeFileSync(join(cwd, 'large.bin'), large);
    expect((await owner.sendFile(join(cwd, 'large.bin'))).status).toBe(200);
    const lazy = await artifactNamed(stream, 'large.bin');
    expect(lazy.url).toBeUndefined();
    expect(typeof lazy.fetchUrl).toBe('string');
    const fetched = await download(broker.url, lazy.fetchUrl);
    expect(fetched.response.status).toBe(200);
    expect(fetched.bytes.equals(large)).toBe(true);
    await settled(stream);
    expect(names(stream)).not.toContain('outside.txt');
    expect(names(stream)).not.toContain('linked.txt');
    stream.close();
  });

  test('a successful Write of a deliverable surfaces once without "proactive"; sources, escapes and failed writes do not', async () => {
    const stream = await attachSettled(viaProxy, owner.id);
    const before = names(stream).length;
    const write = (callId: string, path: string, isError = false) =>
      owner.events({ t: 'tool-result', callId, name: 'Write', result: isError ? 'failed' : 'ok', isError, args: { path } });

    writeFileSync(join(cwd, 'delivered.txt'), 'the agent sent this');
    expect((await owner.sendFile(join(cwd, 'delivered.txt'))).status).toBe(200);
    writeFileSync(join(cwd, 'notes.md'), '# notes the agent wrote');
    await owner.events({ t: 'tool-result', callId: 'w-lower', name: 'write', result: 'ok', isError: false, args: { path: join(cwd, 'notes.md') } });
    writeFileSync(join(cwd, 'summary.html'), '<h1>summary</h1>');
    await write('w-title', join(cwd, 'summary.html'));
    writeFileSync(join(cwd, 'module.ts'), 'export const x = 1;');
    await write('w-source', join(cwd, 'module.ts'));
    writeFileSync(join(broker.paths.root, 'escaped.html'), '<h1>outside</h1>');
    await write('w-escape', join(broker.paths.root, 'escaped.html'));
    writeFileSync(join(cwd, 'failed.html'), '<h1>failed</h1>');
    await write('w-failed', join(cwd, 'failed.html'), true);
    writeFileSync(join(cwd, 'final.md'), '# the last one');
    await write('w-final', join(cwd, 'final.md'));
    await artifactNamed(stream, 'final.md');
    await settled(stream);

    const surfaced = artifacts(stream).slice(before);
    expect(surfaced.map((message) => message.name)).toEqual(['delivered.txt', 'notes.md', 'summary.html', 'final.md']);
    expect(surfaced.map((message) => message.proactive)).toEqual([true, undefined, undefined, undefined]);
    expect(surfaced.slice(1).map((message) => message.transcriptAnchor)).toEqual([
      { type: 'tool-result', key: 'w-lower' },
      { type: 'tool-result', key: 'w-title' },
      { type: 'tool-result', key: 'w-final' },
    ]);
    stream.close();

    // Replay carries the value each artifact was stored with, not a blanket assertion.
    await broker.restart();
    await owner.rehello();
    await peer.rehello();
    const replayed = await attachSettled(viaProxy, owner.id);
    const byName = new Map(artifacts(replayed).map((message) => [message.name, message]));
    expect(byName.get('delivered.txt')?.proactive).toBe(true);
    expect(byName.get('notes.md')).toBeDefined();
    expect(byName.get('notes.md')?.proactive).toBeUndefined();
    expect(byName.get('notes.md')?.transcriptAnchor).toEqual({ type: 'tool-result', key: 'w-lower' });
    replayed.close();
  });

  test('a pre-upgrade cached write replays with a path recovery hint, without changing its download', async () => {
    const cache = join(broker.paths.root, 'cache-link', 'cache', 'artifacts', 'index.json');
    // Emulate the index an older release left, which had bytes and ownership
    // but no original call id. Only isolated fixture state is rewritten.
    await broker.stop({ keepState: true });
    const index = JSON.parse(readFileSync(cache, 'utf8'));
    const record = index.records.find((entry: any) => entry.sessionId === owner.id && entry.name === 'notes.md');
    expect(record).toBeDefined();
    delete record.transcriptAnchor;
    writeFileSync(cache, JSON.stringify(index));
    await broker.restart();
    await owner.rehello();
    await peer.rehello();
    const stream = await attachSettled(viaProxy, owner.id);
    const note = artifacts(stream).find((message) => message.name === 'notes.md');
    expect(note.transcriptAnchor).toEqual({ type: 'workspace-write', path: 'notes.md', createdAt: record.createdAt });
    expect((await download(broker.url, note.fetchUrl)).bytes.toString()).toBe('# notes the agent wrote');
    stream.close();
  });

  test('active HTML downloads as sandboxed opaque bytes, and the artifact refuses interaction', async () => {
    const stream = await attachSettled(viaProxy, owner.id);
    const html = '<html><body><p>before-marker</p></body><p>after-marker</p></html>';
    writeFileSync(join(cwd, 'page.html'), html);
    expect((await owner.sendFile(join(cwd, 'page.html'))).status).toBe(200);
    const page = await artifactNamed(stream, 'page.html');
    const served = await download(broker.url, page.fetchUrl);
    expect(served.response.status).toBe(200);
    expect(served.response.headers.get('content-type')).toBe('application/octet-stream');
    expect(served.response.headers.get('content-disposition')?.startsWith('attachment;')).toBe(true);
    expect(served.response.headers.get('content-security-policy')).toBe('sandbox');
    expect(served.response.headers.get('cache-control')).toBe('no-store');
    expect(served.response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(served.response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(served.bytes.toString()).toBe(html);
    const refused = await stream.sendAndAwait({
      kind: 'artifact-interaction',
      artifactKey: page.artifactKey,
      interaction: { type: 'action', action: 'save' },
    });
    expect(refused.kind).toBe('nack');
    expect(refused.code).toBe('ARTIFACT_INTERACTION_UNSUPPORTED');
    stream.close();
  });

  test('delivered media gets a ranged preview without enabling HTML or another session', async () => {
    const stream = await attachSettled(viaProxy, owner.id);
    writeFileSync(join(cwd, 'media.pdf'), '%PDF-1.7\npreview-test\n%%EOF');
    expect((await owner.sendFile(join(cwd, 'media.pdf'))).status).toBe(200);
    const pdf = await artifactNamed(stream, 'media.pdf');
    const input = { tool: 'pi', sessionId: owner.id, artifactId: pdf.artifactKey };
    const created = await viaProxy.post('/api/media-preview-tickets', input);
    expect(created.status).toBe(201);
    const served = await download(broker.url, created.body.url, { range: 'bytes=0-3' });
    expect([served.response.status, served.response.headers.get('content-type'), served.bytes.toString()])
      .toEqual([206, 'application/pdf', '%PDF']);
    expect((await viaProxy.post('/api/media-preview-tickets', { ...input, sessionId: peer.id })).status).toBe(404);
    writeFileSync(join(cwd, 'untrusted.html'), '<script>test</script>');
    expect((await owner.sendFile(join(cwd, 'untrusted.html'))).status).toBe(200);
    const html = await artifactNamed(stream, 'untrusted.html');
    expect((await viaProxy.post('/api/media-preview-tickets', { ...input, artifactId: html.artifactKey })).status).toBe(415);
    expect((await fetch(new URL(created.body.url, broker.url), { method: 'DELETE' })).status).toBe(204);
    expect((await download(broker.url, created.body.url)).response.status).toBe(403);
    stream.close();
  });

  test('a download resumes with byte ranges, keeping the full security header set on 206 and 416', async () => {
    const stream = await attachSettled(viaProxy, owner.id);
    const bytes = Buffer.alloc(4096);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    writeFileSync(join(cwd, 'ranged.bin'), bytes);
    expect((await owner.sendFile(join(cwd, 'ranged.bin'))).status).toBe(200);
    const ranged = await artifactNamed(stream, 'ranged.bin');
    stream.close();
    const get = (headers: Record<string, string> = {}, method = 'GET') => download(broker.url, ranged.fetchUrl, headers, method);

    const whole = await get();
    const hash = whole.response.headers.get('x-cosyncing-content-hash') ?? '';
    expect(whole.response.status).toBe(200);
    expect(whole.response.headers.get('accept-ranges')).toBe('bytes');
    expect(whole.response.headers.get('etag')).toBe(`"${hash}"`);
    expect(whole.response.headers.get('last-modified')).toBeTruthy();
    expect(whole.bytes.equals(bytes)).toBe(true);

    const closed = await get({ range: 'bytes=0-2047' });
    expect(closed.response.status).toBe(206);
    expect(closed.response.headers.get('content-length')).toBe('2048');
    expect(closed.response.headers.get('content-range')).toBe('bytes 0-2047/4096');
    const open = await get({ range: 'bytes=2048-' });
    expect(open.response.status).toBe(206);
    expect(open.response.headers.get('content-range')).toBe('bytes 2048-4095/4096');
    expect(Buffer.concat([closed.bytes, open.bytes]).equals(bytes)).toBe(true);
    const suffix = await get({ range: 'bytes=-50' });
    expect(suffix.response.status).toBe(206);
    expect(suffix.response.headers.get('content-range')).toBe('bytes 4046-4095/4096');
    expect(suffix.bytes.equals(bytes.subarray(4046))).toBe(true);

    const fresh = await get({ range: 'bytes=0-9', 'if-range': `"${hash}"` });
    expect(fresh.response.status).toBe(206);
    expect(fresh.bytes.length).toBe(10);
    const stale = await get({ range: 'bytes=0-9', 'if-range': '"sha256:0000"' });
    expect(stale.response.status).toBe(200);
    expect(stale.bytes.equals(bytes)).toBe(true);
    const outside = await get({ range: 'bytes=4096-' });
    expect(outside.response.status).toBe(416);
    expect(outside.response.headers.get('content-range')).toBe('bytes */4096');
    const head = await get({ range: 'bytes=0-99' }, 'HEAD');
    expect(head.response.status).toBe(206);
    expect(head.response.headers.get('content-range')).toBe('bytes 0-99/4096');
    expect(head.bytes.length).toBe(0);

    const securityHeaders = (response: Response) => Object.fromEntries([
      'x-content-type-options', 'content-disposition', 'content-security-policy', 'cache-control',
      'referrer-policy', 'cross-origin-resource-policy', 'content-type',
    ].map((name) => [name, response.headers.get(name)]));
    expect(securityHeaders(closed.response)).toEqual(securityHeaders(whole.response));
    expect(securityHeaders(whole.response)).toMatchObject({
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
    });
    expect(securityHeaders(outside.response)).toMatchObject({
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
    });
  });

  test('a fresh download ticket can be minted for a stored artifact, and clearing the session cache revokes its references', async () => {
    const stream = await attachSettled(viaProxy, peer.id);
    const note = await artifactNamed(stream, 'peer-note.txt');
    stream.close();
    const ticket = await broker.client().post(`/api/sessions/pi/${encodeURIComponent(peer.id)}/artifact/${encodeURIComponent(note.artifactKey)}/ticket`);
    expect(ticket.status).toBe(201);
    expect((await download(broker.url, ticket.body.fetchUrl)).bytes.toString()).toBe('the peer sends its own');
    const unknown = await broker.client().post(`/api/sessions/pi/${encodeURIComponent(peer.id)}/artifact/unknown-key/ticket`);
    expect(unknown.status).toBe(404);

    const cleared = await broker.client().delete(`/api/sessions/pi/${encodeURIComponent(peer.id)}/cache`);
    expect(cleared.status).toBe(200);
    expect(cleared.body.clearedArtifacts).toBeGreaterThanOrEqual(1);
    expect((await download(broker.url, ticket.body.fetchUrl)).response.status).toBe(404);
    // The owner's artifacts in the same cwd are untouched.
    expect((await download(broker.url, first.fetchUrl)).response.status).toBe(200);
  });
});

describe('a signed reference is bound to the device it was issued to', () => {
  let broker: Broker;
  let owner: BrokerClient;

  beforeAll(async () => {
    broker = await startBroker({ name: 'artifacts-principal', token: true });
    owner = broker.client();
  });
  afterAll(async () => {
    owner?.closeAll();
    await broker?.stop();
  });

  test('another device, the owner, an anonymous caller and a re-paired device are all refused', async () => {
    const cwd = join(broker.paths.root, 'workspace');
    mkdirSync(cwd);
    const pi = await PiBridgeSession.open(owner, { cwd });
    const phone = await pairDevice(owner, { peerId: 'artifact-phone' });
    const tablet = await pairDevice(owner, { peerId: 'artifact-tablet' });
    const asPhone = owner.as({ kind: 'peer', peerToken: phone.peerToken });
    const asTablet = owner.as({ kind: 'peer', peerToken: tablet.peerToken });
    const phoneHeaders = asPhone.credentialHeaders();

    const stream = await asPhone.attach('pi', pi.id, { artifactMode: 'reference' });
    await stream.waitForKind('history');
    writeFileSync(join(cwd, 'for-the-phone.txt'), 'phone bytes');
    expect((await pi.sendFile(join(cwd, 'for-the-phone.txt'))).status).toBe(200);
    const artifact = await artifactNamed(stream, 'for-the-phone.txt');
    stream.close();

    const ok = await download(broker.url, artifact.fetchUrl, phoneHeaders);
    expect(ok.response.status).toBe(200);
    expect(ok.bytes.toString()).toBe('phone bytes');
    expect((await download(broker.url, artifact.fetchUrl, asTablet.credentialHeaders())).response.status).toBe(403);
    expect((await download(broker.url, artifact.fetchUrl, owner.credentialHeaders())).response.status).toBe(403);
    expect((await download(broker.url, artifact.fetchUrl)).response.status).toBe(401);

    const url = new URL(artifact.fetchUrl, broker.url);
    const signature = url.searchParams.get('sig')!;
    const forged = new URL(url);
    forged.searchParams.set('sig', `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`);
    expect((await download(broker.url, `${forged.pathname}${forged.search}`, phoneHeaders)).response.status).toBe(403);
    const expired = new URL(url);
    expired.searchParams.set('expires', '1');
    expect((await download(broker.url, `${expired.pathname}${expired.search}`, phoneHeaders)).response.status).toBe(403);

    // Revoke and pair the same device id again: the old reference does not revive.
    expect((await owner.delete('/api/transport/peers/artifact-phone')).status).toBe(200);
    const repaired = await pairDevice(owner, { peerId: 'artifact-phone' });
    const asRepaired = owner.as({ kind: 'peer', peerToken: repaired.peerToken });
    expect((await download(broker.url, artifact.fetchUrl, asRepaired.credentialHeaders())).response.status).toBe(403);
    const ticket = await asRepaired.post(
      `/api/sessions/pi/${encodeURIComponent(pi.id)}/artifact/${encodeURIComponent(artifact.artifactKey)}/ticket`,
    );
    expect(ticket.status).toBe(201);
    const renewed = await download(broker.url, ticket.body.fetchUrl, asRepaired.credentialHeaders());
    expect(renewed.response.status).toBe(200);
    expect(renewed.bytes.toString()).toBe('phone bytes');
  });
});
