/**
 * Peer credentials: can the broker tell which process dialled its Unix socket?
 *
 * This is the question the whole design hangs off, because `Bun.serve({ unix })` cannot answer
 * it and `Bun.listen({ unix })` can. The suite drives a real connected socket pair so the
 * answer comes from the kernel rather than from a mock, and it asserts the identity facts that
 * matter: the peer pid equals the connecting process's own pid, and the peer uid equals its own
 * euid. Those two are what the uid refusal and the pid watch are built on.
 *
 * Honest limits, stated rather than hidden:
 * - The Darwin route (`LOCAL_PEERPID` plus `getpeereid`) and the `LOCAL_PEERCRED` trap that
 *   `unix-peer-credentials.ts` refuses to walk into cannot be *executed* on a Linux host. What
 *   is asserted here is the option numbers those calls use, so a typo in `LOCAL_PEERPID` fails
 *   a suite instead of surfacing as a wrong pid on a Mac.
 * - A truncated `optlen` cannot be provoked from a correct caller on a healthy kernel, so the
 *   guard is asserted by its observable proxy: an unusable descriptor answers an error, never a
 *   number. A guess is the failure mode, and it is the one that must not be reachable.
 * - A same-uid refusal cannot be provoked without setuid. `test-mod-socket.ts` covers that path
 *   through the injectable comparison instead, and reports it as such.
 *
 *   bun run packages/typescript/broker/test/claude/test-unix-peer-credentials.ts   (exit 0 = all pass)
 */
export {};
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as net from 'node:net';
import { readUnixPeerCredentials, unixPeerCredentialsEnforceable } from '../../src/security/unix-peer-credentials.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const root = mkdtempSync(join(tmpdir(), 'cmts-peercreds-'));
const socketPath = join(root, 'peer.sock');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  const enforceable = unixPeerCredentialsEnforceable();
  check(
    'the platform reports whether the check is enforceable',
    typeof enforceable.enforceable === 'boolean' && enforceable.reason.length > 0,
    `${enforceable.enforceable} (${enforceable.reason})`,
  );
  if (process.platform === 'linux') {
    check('Linux reports kernel peer credentials as available', enforceable.enforceable === true, enforceable.reason);
  }

  // A nonsense descriptor must answer an error. The alternative is a zero-filled struct, which
  // would read as "pid 0, uid 0" and refuse a legitimate session or accept a kernel thread.
  for (const bad of [-1, 0, 1_000_000, Number.NaN, 3.5]) {
    const answer = readUnixPeerCredentials(bad);
    check(
      `descriptor ${String(bad)} answers an error, not a guess`,
      'error' in answer && (!('pid' in answer) || (answer as { pid?: number }).pid === undefined),
      JSON.stringify(answer).slice(0, 90),
    );
  }

  if (process.platform === 'darwin') {
    // Executed only on the Mac. `LOCAL_PEERCRED` is deliberately absent: on Darwin 25.5.0 it
    // answers optlen 76 with a *group id* in its trailing word, which is how a first pass of the
    // spike read a gid of 701 as a pid. v1 takes the pid from `LOCAL_PEERPID` and the ids from
    // `getpeereid(3)`, and asserts the option number it dials.
    const source = await Bun.file(join(import.meta.dir, '..', '..', 'src', 'security', 'unix-peer-credentials.ts')).text();
    check('macOS reads LOCAL_PEERPID (0x0002)', source.includes('DARWIN_LOCAL_PEERPID = 0x0002'));
    check('macOS never reads LOCAL_PEERCRED', !source.includes('LOCAL_PEERCRED ='));
    check('macOS takes uid and gid from getpeereid', source.includes('getpeereid'));
    check('optlen is asserted rather than trusted', source.includes('answered optlen'));
  } else {
    check('darwin assertions are not executable on this platform (skipped with reason)', process.platform === 'linux', `host is ${process.platform}`);
    const source = await Bun.file(join(import.meta.dir, '..', '..', 'src', 'security', 'unix-peer-credentials.ts')).text();
    check('the Darwin route still names option 0x0002 and getpeereid', source.includes('DARWIN_LOCAL_PEERPID = 0x0002') && source.includes('getpeereid'));
    check('the Linux route names SOL_SOCKET/SO_PEERCRED and a 12-byte ucred', source.includes('LINUX_SOL_SOCKET = 1') && source.includes('LINUX_SO_PEERCRED = 17') && source.includes('LINUX_UCRED_BYTES = 12'));
  }

  // A real connected pair, so the answer is the kernel's.
  let serverCreds: unknown = null;
  let serverFd = -2;
  const server = Bun.listen<null>({
    unix: socketPath,
    data: null,
    socket: {
      open(socket) {
        // Bun's runtime exposes `fd` on a listener socket; its published socket type does not
        // declare it, so the read is narrowed here rather than cast across the file.
        serverFd = (socket as unknown as { fd?: number }).fd ?? -1;
        serverCreds = readUnixPeerCredentials(serverFd);
      },
      data(socket) {
        socket.end('done');
      },
    },
  });

  const client = net.createConnection({ path: socketPath }, () => client.write('hi'));
  const clientDone = new Promise<void>((resolve) => {
    client.on('data', () => resolve());
    client.on('close', () => resolve());
  });
  await Promise.race([clientDone, sleep(3_000)]);

  check('the listener could read a descriptor off the connection', serverFd > 0, `fd=${serverFd}`);
  const creds = serverCreds as { pid?: number; uid?: number; gid?: number; via?: string; error?: string } | null;
  check('the kernel answered for the connected peer', !!creds && !creds.error, JSON.stringify(creds).slice(0, 120));
  check('the peer pid is this process', creds?.pid === process.pid, `peer=${String(creds?.pid)} self=${process.pid}`);
  const ownUid = typeof process.geteuid === 'function' ? process.geteuid() : -1;
  check('the peer uid is this process euid', creds?.uid === ownUid, `peer=${String(creds?.uid)} euid=${ownUid}`);
  if (process.platform === 'linux') check('Linux answered via SO_PEERCRED', creds?.via === 'SO_PEERCRED', String(creds?.via));
  if (process.platform === 'darwin') check('macOS answered via LOCAL_PEERPID+getpeereid', creds?.via === 'LOCAL_PEERPID+getpeereid', String(creds?.via));

  // The second read on a closed connection must not resurrect a credential.
  client.destroy();
  await sleep(50);
  const after = readUnixPeerCredentials(serverFd);
  check('a closed connection stops answering a credential', 'error' in after, JSON.stringify(after).slice(0, 90));

  (server as unknown as { stop?(): void }).stop?.();

  // ── BH8: the macOS process table behind the broker-child check, its lifetime and its misses ──
  {
    const { createProcessTable } = await import('../../src/security/process-liveness.ts');
    let clock = 0;
    let reads = 0;
    let rows = '  100     1\n  200   100\n';
    const table = createProcessTable({ run: () => { reads += 1; return rows; }, now: () => clock });
    const first = table.parentOf(200);
    clock = 20_000;
    const atFirstPoll = table.parentOf(200);
    clock = 40_000;
    const atSecondPoll = table.parentOf(200);
    check('BH8 a pid in the table is answered from it across the 20 s poll cadence, with one ps for all three',
      first === 100 && atFirstPoll === 100 && atSecondPoll === 100 && reads === 1, `reads=${reads}`);
    rows += '  300   200\n';
    clock = 40_100;
    const newcomer = table.parentOf(300);
    check('BH8 a pid newer than the snapshot is answered from a fresh read, not as unknown',
      newcomer === 200 && reads === 2, `parent=${newcomer} reads=${reads}`);
    clock = 40_150;
    const flood = [401, 402, 403, 404].map((pid) => table.parentOf(pid));
    check('BH8 misses inside the refresh floor cost no further ps', flood.every((p) => p === undefined) && reads === 2, `reads=${reads}`);
    rows += '  401   300\n';
    clock = 40_500;
    check('BH8 an unknown pid is never cached as unknown: once it exists, the next miss finds it',
      table.parentOf(401) === 300 && reads === 3, `reads=${reads}`);
    clock = 40_500 + 60_000;
    table.parentOf(200);
    check('BH8 the table is read again once it is older than its lifetime', reads === 4, `reads=${reads}`);
    const broken = createProcessTable({ run: () => { throw new Error('no ps'); }, now: () => 0 });
    check('BH8 a ps that cannot run is an empty table, which answers "no parent"', broken.parentOf(200) === undefined);

    // The same table over this host's real `ps`: the snapshot is taken BEFORE the child exists, so the
    // child's parent can only be known through the miss refresh.
    const { spawnSync, spawn } = await import('node:child_process');
    const realTable = createProcessTable({
      run: () => {
        const ps = spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' });
        return ps.status === 0 ? ps.stdout : undefined;
      },
    });
    const self = realTable.parentOf(process.pid);
    await sleep(300);
    const child = spawn('sleep', ['5'], { stdio: 'ignore' });
    try {
      check('BH8 on this host, a child spawned after the snapshot is found as this process\'s child',
        typeof self === 'number' && child.pid !== undefined && realTable.parentOf(child.pid) === process.pid,
        `self-parent=${self} child=${child.pid}`);
    } finally {
      child.kill('SIGKILL');
    }
  }
} catch (error) {
  check('no exception', false, String((error as Error)?.stack ?? error).slice(0, 300));
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? `FAILED ${failed.length}/${results.length}` : `OK ${results.length}/${results.length} passed`}`);
process.exit(failed.length ? 1 : 0);
