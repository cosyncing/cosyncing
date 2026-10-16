/**
 * When an unanswered Codex control socket counts as "no daemon".
 *
 * Only positive evidence does: nothing exists at the path or at its alias's target, or (Linux) the
 * kernel binds nothing there and a connection fails. A bound row, an opened connection, a timeout,
 * an unreadable table, and every host without `/proc/net/unix` leave the daemon possibly alive.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeCodexRuntimeSocketListener } from '../src/runtime-socket.ts';

const root = mkdtempSync(join(tmpdir(), 'cosyncing-codex-runtime-socket-'));
const servers: Server[] = [];
afterAll(() => {
  for (const server of servers) server.close();
  rmSync(root, { recursive: true, force: true });
});

async function listening(name: string): Promise<string> {
  const path = join(root, name);
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, () => resolve()));
  return path;
}

const noTable = async () => undefined;
const emptyTable = async () => 'Num       RefCount Protocol Flags    Type St Inode Path\n';
const neverConnects = async () => false;
const mustNotConnect = async (): Promise<boolean> => { throw new Error('a bound listener must not be dialled'); };

describe.skipIf(process.platform === 'win32')('probeCodexRuntimeSocketListener', () => {
  test('nothing at the path, or an alias whose target is gone, is dead on any host', async () => {
    const alias = join(root, 'dangling.sock');
    symlinkSync(join(root, 'removed.sock'), alias);
    for (const platform of ['linux', 'darwin'] as const) {
      expect(await probeCodexRuntimeSocketListener(join(root, 'missing.sock'), { platform, readUnixTable: noTable })).toBe('dead');
      expect(await probeCodexRuntimeSocketListener(alias, { platform, readUnixTable: noTable })).toBe('dead');
    }
  });

  test('something that is not a socket is unknown, never dead', async () => {
    const file = join(root, 'not-a-socket');
    writeFileSync(file, '');
    const alias = join(root, 'alias-to-file.sock');
    symlinkSync(file, alias);
    for (const path of [file, alias]) {
      expect(await probeCodexRuntimeSocketListener(path, { platform: 'linux', readUnixTable: emptyTable, connects: neverConnects })).toBe('unknown');
    }
  });

  test('a socket with a bound row is listening, without a connection being opened', async () => {
    const path = await listening('bound.sock');
    const alias = join(root, 'alias-to-bound.sock');
    symlinkSync(path, alias);
    const table = async () => `0000000000000000: 00000002 00000000 00010000 0001 01 4242 ${path}\n`;
    expect(await probeCodexRuntimeSocketListener(path, { platform: 'linux', readUnixTable: table, connects: mustNotConnect })).toBe('listening');
    // The alias is matched through its target, which is the path a daemon binds.
    expect(await probeCodexRuntimeSocketListener(alias, { platform: 'linux', readUnixTable: table, connects: mustNotConnect })).toBe('listening');
  });

  test('with no bound row, the connection decides: refused is dead, opened is listening, a timeout is unknown', async () => {
    const path = await listening('unlisted.sock');
    expect(await probeCodexRuntimeSocketListener(path, { platform: 'linux', readUnixTable: emptyTable, connects: neverConnects })).toBe('dead');
    expect(await probeCodexRuntimeSocketListener(path, { platform: 'linux', readUnixTable: emptyTable, connects: async () => true })).toBe('listening');
    expect(await probeCodexRuntimeSocketListener(path, { platform: 'linux', readUnixTable: emptyTable, connects: async () => undefined })).toBe('unknown');
    // The real dial reaches a live listener in another network namespace just the same.
    expect(await probeCodexRuntimeSocketListener(path, { platform: 'linux', readUnixTable: emptyTable })).toBe('listening');
  });

  test('without a readable socket table, a socket file proves nothing', async () => {
    const path = await listening('untabled.sock');
    expect(await probeCodexRuntimeSocketListener(path, { platform: 'linux', readUnixTable: noTable, connects: neverConnects })).toBe('unknown');
    expect(await probeCodexRuntimeSocketListener(path, { platform: 'darwin', readUnixTable: emptyTable, connects: neverConnects })).toBe('unknown');
  });

  test.skipIf(process.platform !== 'linux')('on this host, a listener is seen in /proc/net/unix', async () => {
    const path = await listening('real.sock');
    expect(await probeCodexRuntimeSocketListener(path, { connects: mustNotConnect })).toBe('listening');
  });
});
