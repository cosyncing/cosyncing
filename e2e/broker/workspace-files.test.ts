/**
 * Browsing a session's workspace from the app: list, stat, search, read and
 * download, read-only and bounded, never past the workspace.
 *
 * HTTP workspace browsing is off by default (a loopback peer may be a reverse
 * proxy) and turned on by the owner in the broker's own configuration. The
 * session is a live Pi session whose cwd is the workspace; requests are made
 * with the owner's credential exactly as the app makes them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { type Broker, type BrokerClient, startBroker } from '../harness/index.ts';
import { type InstalledBroker, startInstalledBroker } from '../harness/installed.ts';
import { PiBridgeSession } from '../harness/fakes/pi-bridge-driver.ts';

const POSIX = process.platform !== 'win32';
// Windows strips a trailing space from a file name and refuses a double quote in one.
const SPACED = POSIX ? ' spaced name.txt ' : ' spaced name.txt';

describe('with workspace browsing enabled in the broker configuration', () => {
  let installed: InstalledBroker;
  let owner: BrokerClient;
  let cwd: string;
  let secret: string;
  let pi: PiBridgeSession;
  let fsBase: string;

  const route = (path: string, query: Record<string, string> = {}) =>
    `${fsBase}${path}${Object.keys(query).length ? `?${new URLSearchParams(query)}` : ''}`;

  beforeAll(async () => {
    installed = await startInstalledBroker({
      name: 'workspace-files',
      features: { httpWorkspaceBrowsing: true },
      env: { COSYNCING_FS_READ_MAX_BYTES: '8', COSYNCING_FS_DOWNLOAD_MAX_BYTES: '16' },
    });
    owner = installed.owner;
    // One level under the broker's HOME, so `~/<workspace>/…` resolves inside and `~` alone does not.
    cwd = mkdtempSync(join(installed.paths.home, 'workspace-'));
    writeFileSync(join(cwd, 'hello.txt'), 'hello-from-workspace');
    writeFileSync(join(cwd, SPACED), 'space-preserved');
    if (POSIX) writeFileSync(join(cwd, 'bad"name.txt'), 'quoted-name');
    mkdirSync(join(cwd, 'nested'));
    writeFileSync(join(cwd, 'nested', 'note.txt'), 'nested-note');
    writeFileSync(join(cwd, 'binary.bin'), new Uint8Array([0xff, 0x00, 0x10, 0x80, 0x41]));
    writeFileSync(join(cwd, 'too-large.txt'), 'x'.repeat(17));
    secret = join(installed.paths.root, 'outside', 'secret.txt');
    mkdirSync(join(installed.paths.root, 'outside'));
    writeFileSync(secret, 'do not serve this');
    if (POSIX) symlinkSync(secret, join(cwd, 'link-to-secret'));
    pi = await PiBridgeSession.open(owner, { cwd });
    fsBase = `/api/sessions/pi/${encodeURIComponent(pi.id)}`;
  });
  afterAll(() => installed?.stop());

  test('the broker reports browsing as enabled, and every route still requires a credential', async () => {
    expect((await owner.get('/api/broker/health')).body.features.httpWorkspaceBrowsing).toBe(true);
    const anonymous = owner.as({ kind: 'none' });
    expect((await anonymous.get(route('/fs'))).status).toBe(401);
    expect((await anonymous.get(route('/fs/search', { query: 'note.txt' }))).status).toBe(401);
    expect((await anonymous.get(route('/fs/download', { path: 'hello.txt' }))).status).toBe(401);
    expect((await owner.get('/api/sessions/pi/no-such-session/fs')).status).toBe(404);
  });

  test('list, stat, read and search answer from the workspace, bounded by the read cap', async () => {
    const list = await owner.get(route('/fs'));
    expect(list.status).toBe(200);
    expect(list.body.stat.type).toBe('directory');
    const listed = list.body.entries.map((entry: any) => entry.name);
    expect(listed).toEqual(expect.arrayContaining(['hello.txt', 'nested', 'binary.bin', SPACED]));

    expect((await owner.get(route('/fs', { path: 'hello.txt' }))).body.stat.type).toBe('file');

    const read = await owner.get(route('/fs/read', { path: 'hello.txt', maxBytes: '5' }));
    expect(read.body).toMatchObject({ encoding: 'utf8', data: 'hello', truncated: true, limit: 5, mimeType: 'text/plain; charset=utf-8' });
    // No maxBytes: the broker's read cap (8 bytes here) applies; odd names round-trip exactly.
    const spaced = await owner.get(route('/fs/read', { path: SPACED }));
    expect(spaced.body).toMatchObject({ path: SPACED, data: 'space-pr' });
    expect((await owner.get(route('/fs/read', { path: 'binary.bin' }))).body.encoding).toBe('base64');

    const search = await owner.get(route('/fs/search', { query: 'note.txt' }));
    expect(search.status).toBe(200);
    expect(search.body.matches.map((file: any) => file.path)).toEqual(['nested/note.txt']);
    for (const query of ['../secret.txt', '/etc/passwd', 'a/../hello.txt']) {
      const refused = await owner.get(route('/fs/search', { query }));
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('BAD_PARAM');
    }
  });

  test('source files are labelled text/* so the viewer opens them; an unknown suffix gets no guess', async () => {
    const labels: Array<[string, string, string]> = [
      ['main.py', 'print("hi")\n', 'text/x-python; charset=utf-8'],
      ['lib.rs', 'fn main() {}\n', 'text/x-rust; charset=utf-8'],
      ['app.tsx', 'export const A = 1;\n', 'text/x-typescript; charset=utf-8'],
      ['conf.toml', '[a]\nb = 1\n', 'text/x-toml; charset=utf-8'],
      ['.gitignore', 'node_modules\n', 'text/plain; charset=utf-8'],
      ['Makefile', 'all:\n\t@true\n', 'text/x-makefile; charset=utf-8'],
      ['Dockerfile', 'FROM scratch\n', 'text/x-dockerfile; charset=utf-8'],
      ['notes.unknownext', 'still octet-stream\n', 'application/octet-stream'],
    ];
    for (const [name, content, mimeType] of labels) {
      writeFileSync(join(cwd, name), content);
      const read = await owner.get(route('/fs/read', { path: name }));
      expect({ name, status: read.status, encoding: read.body.encoding, mimeType: read.body.mimeType })
        .toEqual({ name, status: 200, encoding: 'utf8', mimeType });
    }
  });

  test('a download is an attachment with validators, resumes with ranges and If-Range, and refuses what it cannot satisfy', async () => {
    const url = `${installed.broker.url}${route('/fs/download', { path: 'nested/note.txt' })}`;
    const get = (headers: Record<string, string> = {}) => fetch(url, { headers: { ...owner.credentialHeaders(), ...headers } });

    const whole = await get();
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-disposition')).toBe('attachment; filename="note.txt"');
    expect(whole.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(whole.headers.get('x-cosyncing-mime-type')).toBe('text/plain; charset=utf-8');
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(whole.headers.get('x-content-type-options')).toBe('nosniff');
    expect(whole.headers.get('etag')).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(whole.headers.get('last-modified')).toMatch(/GMT$/);
    expect(await whole.text()).toBe('nested-note');
    const etag = whole.headers.get('etag')!;
    const lastModified = whole.headers.get('last-modified')!;

    const closed = await get({ range: 'bytes=0-5' });
    expect([closed.status, closed.headers.get('content-range'), closed.headers.get('x-content-type-options'), await closed.text()])
      .toEqual([206, 'bytes 0-5/11', 'nosniff', 'nested']);
    const suffix = await get({ range: 'bytes=-4' });
    expect([suffix.status, suffix.headers.get('content-range'), await suffix.text()]).toEqual([206, 'bytes 7-10/11', 'note']);
    const open = await get({ range: 'bytes=7-' });
    expect([open.status, await open.text()]).toEqual([206, 'note']);
    for (const ifRange of [etag, lastModified]) {
      const matching = await get({ range: 'bytes=7-', 'if-range': ifRange });
      expect([matching.status, await matching.text()]).toEqual([206, 'note']);
    }
    const stale = await get({ range: 'bytes=7-', 'if-range': '"stale"' });
    expect([stale.status, stale.headers.get('content-range'), await stale.text()]).toEqual([200, null, 'nested-note']);
    for (const range of ['bytes=99-', 'bytes=5-4', 'bytes=0-1,4-5', 'items=0-1']) {
      const unsatisfiable = await get({ range });
      expect([range, unsatisfiable.status, unsatisfiable.headers.get('content-range'), unsatisfiable.headers.get('accept-ranges'), await unsatisfiable.text()])
        .toEqual([range, 416, 'bytes */11', 'bytes', '']);
    }

    const tooLarge = await owner.get(route('/fs/download', { path: 'too-large.txt' }));
    expect([tooLarge.status, tooLarge.body.code]).toEqual([413, 'FS_DOWNLOAD_TOO_LARGE']);
    if (POSIX) {
      const quoted = await fetch(`${installed.broker.url}${route('/fs/download', { path: 'bad"name.txt' })}`, { headers: owner.credentialHeaders() });
      expect(quoted.status).toBe(200);
      expect(quoted.headers.get('content-disposition')).toBe('attachment; filename="bad_name.txt"');
    }
  });

  test('Chinese filenames round-trip through lookup and whole or ranged downloads', async () => {
    const name = 'report_长图_2160px.jpg';
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    writeFileSync(join(cwd, name), bytes);
    const found = await owner.get(route('/fs/search', { query: name }));
    expect(found.status).toBe(200);
    expect(found.body.matches.map((file: any) => file.path)).toEqual([name]);
    expect((await owner.get(route('/fs', { path: name }))).body.stat.size).toBe(bytes.length);
    const url = `${installed.broker.url}${route('/fs/download', { path: name })}`;
    for (const ranged of [false, true]) {
      const image = await fetch(url, {
        headers: { ...owner.credentialHeaders(), ...(ranged ? { range: 'bytes=1-2' } : {}) },
      });
      expect(image.status).toBe(ranged ? 206 : 200);
      expect(image.headers.get('content-type')).toBe('image/jpeg');
      const disposition = image.headers.get('content-disposition')!;
      expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]!)).toBe(name);
      expect(new Uint8Array(await image.arrayBuffer())).toEqual(ranged ? bytes.slice(1, 3) : bytes);
    }
  });

  test('escapes, symlinks and non-files are refused with stable codes', async () => {
    const escaped = await owner.get(route('/fs', { path: '../outside' }));
    expect([escaped.status, escaped.body.code]).toEqual([400, 'PATH_ESCAPE']);
    const directory = await owner.get(route('/fs/read', { path: 'nested' }));
    expect([directory.status, directory.body.code]).toEqual([400, 'NOT_REGULAR_FILE']);
    const missing = await owner.get(route('/fs', { path: 'not-here.txt' }));
    expect([missing.status, missing.body.code]).toEqual([404, 'NOT_FOUND']);
    if (!POSIX) return;
    const linked = await owner.get(route('/fs/read', { path: 'link-to-secret' }));
    expect([linked.status, linked.body.code]).toEqual([400, 'PATH_SYMLINK']);
    expect((await owner.get(route('/fs/download', { path: 'link-to-secret' }))).status).toBe(400);
  });

  test('absolute and ~ paths are answered in workspace-relative form, with containment unchanged', async () => {
    const relativeStat = (await owner.get(route('/fs', { path: 'hello.txt' }))).body.stat;
    const absoluteStat = await owner.get(route('/fs', { path: join(cwd, 'hello.txt') }));
    expect(absoluteStat.status).toBe(200);
    expect(absoluteStat.body.stat).toEqual(relativeStat);
    expect((await owner.get(route('/fs', { path: cwd }))).body).toEqual((await owner.get(route('/fs'))).body);
    const nested = await owner.get(route('/fs', { path: join(cwd, 'nested') }));
    expect([nested.body.path, nested.body.entries.map((entry: any) => entry.name)]).toEqual(['nested', ['note.txt']]);
    expect((await owner.get(route('/fs/read', { path: join(cwd, 'hello.txt'), maxBytes: '5' }))).body)
      .toMatchObject({ path: 'hello.txt', data: 'hello' });
    const download = await fetch(`${installed.broker.url}${route('/fs/download', { path: join(cwd, 'nested', 'note.txt') })}`, {
      headers: owner.credentialHeaders(),
    });
    expect([download.status, download.headers.get('content-disposition'), await download.text()])
      .toEqual([200, 'attachment; filename="note.txt"', 'nested-note']);

    for (const [path, status, code] of [
      [secret, 400, 'PATH_ESCAPE'],
      [join(cwd, 'not-here.txt'), 404, 'NOT_FOUND'],
      ['~', 400, 'PATH_ESCAPE'],
      ...(POSIX ? [[join(cwd, 'link-to-secret'), 400, 'PATH_SYMLINK']] : []),
    ] as Array<[string, number, string]>) {
      const refused = await owner.get(route('/fs/read', { path }));
      expect([path, refused.status, refused.body.code]).toEqual([path, status, code]);
    }

    // `~` is the broker host's home, expanded by the broker, never by the client.
    const tilde = await owner.get(route('/fs/read', { path: `~/${basename(cwd)}/hello.txt`, maxBytes: '5' }));
    expect(tilde.body).toMatchObject({ path: 'hello.txt', data: 'hello' });
    expect((await owner.get(route('/fs', { path: `~/${basename(cwd)}/nested` }))).body.path).toBe('nested');
  });

  test.skipIf(!POSIX)('a workspace reached through a symlinked root answers either spelling', async () => {
    const link = join(installed.paths.root, 'workspace-link');
    symlinkSync(cwd, link);
    const viaLink = await PiBridgeSession.open(owner, { cwd: link });
    const linkBase = `/api/sessions/pi/${encodeURIComponent(viaLink.id)}`;
    const real = await owner.get(`${linkBase}/fs/read?${new URLSearchParams({ path: join(realpathSync(cwd), 'hello.txt') })}`);
    expect([real.status, real.body.path]).toEqual([200, 'hello.txt']);
    const spelled = await owner.get(route('/fs/read', { path: join(link, 'hello.txt') }));
    expect([spelled.status, spelled.body.path]).toEqual([200, 'hello.txt']);
    // The walk still refuses a symlink segment inside the workspace, whichever spelling reached it.
    mkdirSync(join(cwd, 'realdir'));
    writeFileSync(join(cwd, 'realdir', 'inner.txt'), 'inner');
    symlinkSync(join(cwd, 'realdir'), join(cwd, 'linkdir'));
    const segment = await owner.get(`${linkBase}/fs?${new URLSearchParams({ path: join(link, 'linkdir', 'inner.txt') })}`);
    expect([segment.status, segment.body.code]).toEqual([400, 'PATH_SYMLINK']);
  });

  test('search matches path suffixes, keeps ambiguity, skips vendored trees, never follows symlinks, and says when it stopped early', async () => {
    const root = join(installed.paths.root, 'search-workspace');
    for (const folder of ['transfer', 'other', 'node_modules', '.git']) {
      mkdirSync(join(root, folder), { recursive: true });
      writeFileSync(join(root, folder, 'report.md'), 'report');
    }
    if (POSIX) {
      symlinkSync(join(root, 'transfer'), join(root, 'alias'));
      symlinkSync(join(root, 'transfer', 'report.md'), join(root, 'report.md'));
    }
    mkdirSync(join(root, 'many'));
    for (let index = 0; index < 51; index += 1) {
      mkdirSync(join(root, 'many', `d${index}`));
      writeFileSync(join(root, 'many', `d${index}`, 'many.txt'), '');
    }
    const deep = join(root, ...Array.from({ length: 18 }, (_, index) => `level${index}`));
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'deep.txt'), '');
    const session = await PiBridgeSession.open(owner, { cwd: root });
    const search = (query: string) => owner.get(`/api/sessions/pi/${encodeURIComponent(session.id)}/fs/search?${new URLSearchParams({ query })}`);

    const ambiguous = await search('report.md');
    expect(ambiguous.body.matches.map((file: any) => file.path)).toEqual(['other/report.md', 'transfer/report.md']);
    expect((await search('transfer/report.md')).body.matches.map((file: any) => file.path)).toEqual(['transfer/report.md']);
    expect((await search('missing.md')).body.matches).toEqual([]);
    const many = await search('many.txt');
    expect([many.body.matches.length, many.body.truncated]).toEqual([50, true]);
    const tooDeep = await search('deep.txt');
    expect([tooDeep.body.matches.length, tooDeep.body.truncated]).toEqual([0, true]);
  });
});

describe('with workspace browsing left at its default', () => {
  let broker: Broker;
  beforeAll(async () => {
    broker = await startBroker({ name: 'workspace-files-default', token: true });
  });
  afterAll(() => broker?.stop());

  test('every workspace route refuses even the owner, with FS_REMOTE_DISABLED', async () => {
    const owner = broker.client();
    const cwd = join(broker.paths.root, 'workspace');
    mkdirSync(cwd);
    writeFileSync(join(cwd, 'secret.env'), 'TOKEN=do-not-read-remotely');
    const pi = await PiBridgeSession.open(owner, { cwd });
    expect((await owner.get('/api/broker/health')).body.features.httpWorkspaceBrowsing).toBe(false);
    for (const path of ['/fs', '/fs/read?path=secret.env', '/fs/search?query=secret.env', '/fs/download?path=secret.env']) {
      const denied = await owner.get(`/api/sessions/pi/${encodeURIComponent(pi.id)}${path}`);
      expect([path, denied.status, denied.body.code]).toEqual([path, 403, 'FS_REMOTE_DISABLED']);
    }
  });
});
