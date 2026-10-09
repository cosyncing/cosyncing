/**
 * Who is on the other end of an accepted Unix-domain socket, answered by the kernel.
 *
 * The Claude mod socket authenticates a *process*, not a registration nonce, and that is
 * the whole reason this module exists: `Bun.serve({ unix })` exposes no descriptor and no
 * peer address (`server.requestIP` is `undefined` for a Unix connection), so the only
 * route to the peer is `Bun.listen({ unix })` plus `getsockopt` on `socket.fd`. Measured
 * on WSL2 (Linux 5.15.167, glibc 2.39, Bun 1.3.14) and macOS 26.5 arm64 (Bun 1.3.8), and
 * against one real Claude Code 2.1.288 session whose peer pid, read here, equalled the pid
 * the mod reported for itself and the pid `/proc/<pid>/comm` called `claude`.
 *
 * Nothing here guesses and nothing degrades quietly, which is the same stance as
 * `adapter-api/src/windows-ffi.ts`. Every option's `optlen` is asserted against the size
 * we filled, and a mismatch is an error rather than a fallback. That rule is not
 * pedantry: on Darwin 25.5.0 `LOCAL_PEERCRED` answers `optlen` 76 while we filled 80, and
 * its trailing word is a *group id*. Reading offset 72 of that reply as a pid returns 701,
 * a real group on that host, and a caller that trusted it would attribute a session to a
 * group. So v1 does not read `LOCAL_PEERCRED` at all. It takes the pid from
 * `LOCAL_PEERPID` and the uid and gid from `getpeereid(3)`, which is the documented BSD
 * pair, and it reports which route answered.
 *
 * Windows has no Unix-domain peer credential of this shape and the mod is not supported on
 * a native Windows session, so the answer there is an explicit
 * "unsupported" that the caller must refuse on rather than treat as a passing check.
 */

const ffi = require('bun:ffi') as typeof import('bun:ffi');
const { dlopen, FFIType, ptr, toArrayBuffer } = ffi;

/** `SOL_SOCKET` on Linux. */
const LINUX_SOL_SOCKET = 1;
/** `SO_PEERCRED` on Linux. */
const LINUX_SO_PEERCRED = 17;
/** `sizeof(struct ucred)` on Linux: three 32-bit words. */
const LINUX_UCRED_BYTES = 12;

/** `LOCAL_PEERPID` on Darwin and the BSDs. */
const DARWIN_LOCAL_PEERPID = 0x0002;

export interface UnixPeerCredentials {
  /** Kernel-reported process id of the peer. */
  pid: number;
  /** Kernel-reported real uid of the peer. */
  uid: number;
  /** Kernel-reported real gid of the peer. */
  gid: number;
  /** Which kernel interface answered, so a log line can say where the fact came from. */
  via: 'SO_PEERCRED' | 'LOCAL_PEERPID+getpeereid';
}

export interface UnixPeerCredentialFailure {
  /** Stable, human-readable reason. Never empty. */
  error: string;
  /** `errno` at the failing call, when there was one. */
  errno?: number;
  /** Set when the platform simply has no answer, so callers can distinguish a refusal. */
  unsupported?: 'win32' | 'libc';
}

type Pointer = number;

interface Libc {
  getsockopt: (fd: number, level: number, optname: number, optval: Pointer, optlen: Pointer) => number;
  getpeereid: (fd: number, euid: Pointer, egid: Pointer) => number;
  errno: () => number;
}

let cachedLibc: Libc | { loadError: string } | undefined;

/**
 * Resolve libc once. Bun resolves every named symbol at `dlopen` time, so each candidate
 * asks only for what that library actually exports: `getpeereid` is BSD-only and absent
 * from glibc, and the `errno` accessor is `__error` on Darwin and `__errno_location` on
 * glibc and musl.
 */
function libc(): Libc | { loadError: string } {
  if (cachedLibc) return cachedLibc;
  const darwin = process.platform === 'darwin';
  const getsockopt = { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 };
  const getpeereid = { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 };
  const errnoSym = { args: [], returns: FFIType.ptr };
  const candidates = darwin
    ? [
        { file: '/usr/lib/libc.dylib', syms: { getsockopt, getpeereid, __error: errnoSym } },
        { file: 'libc.dylib', syms: { getsockopt, getpeereid, __error: errnoSym } },
      ]
    : [
        { file: 'libc.so.6', syms: { getsockopt, __errno_location: errnoSym } },
        { file: `/lib/ld-musl-${process.arch === 'x64' ? 'x86_64' : 'aarch64'}.so.1`, syms: { getsockopt, __errno_location: errnoSym } },
      ];

  let lastError = '';
  for (const { file, syms } of candidates) {
    try {
      // Each candidate asks for the symbols that library actually exports, so the symbol table
      // is heterogeneous by construction (no `getpeereid` in glibc) and is indexed by name.
      const symbols_ = dlopen(file, syms).symbols as unknown as Record<string, unknown>;
      const symbol = (name: string) => symbols_[name] as unknown as (...args: unknown[]) => unknown;
      const errnoName = darwin ? '__error' : '__errno_location';
      cachedLibc = {
        getsockopt: symbol('getsockopt') as Libc['getsockopt'],
        getpeereid: (symbols_['getpeereid'] ? symbol('getpeereid') : () => -1) as Libc['getpeereid'],
        errno: () => {
          const address = symbol(errnoName)() as unknown as Pointer;
          return address ? new Int32Array(toArrayBuffer(address as never, 0, 4))[0]! : -1;
        },
      };
      return cachedLibc;
    } catch (error) {
      lastError = String((error as Error)?.message ?? error).slice(0, 160);
    }
  }
  cachedLibc = { loadError: `could not load libc for getsockopt (${lastError})` };
  return cachedLibc;
}

function i32Pair(value: Uint32Array): number {
  return ptr(value) as unknown as number;
}

/** Linux: `struct ucred` from `SOL_SOCKET`/`SO_PEERCRED`. */
function linuxPeerCredentials(fd: number): UnixPeerCredentials | UnixPeerCredentialFailure {
  const lib = libc();
  if ('loadError' in lib) return { error: lib.loadError, unsupported: 'libc' };
  const buffer = new ArrayBuffer(LINUX_UCRED_BYTES);
  const length = new Uint32Array([LINUX_UCRED_BYTES]);
  const rc = lib.getsockopt(fd, LINUX_SOL_SOCKET, LINUX_SO_PEERCRED, ptr(buffer) as unknown as number, i32Pair(length));
  if (rc !== 0) return { error: 'getsockopt(SO_PEERCRED) failed', errno: lib.errno() };
  // The kernel writes the size it used. Anything other than the 12 we asked for means the
  // struct is not what this module was written against, and a partial read is worse than none.
  if (length[0] !== LINUX_UCRED_BYTES) {
    return { error: `getsockopt(SO_PEERCRED) answered optlen ${length[0]}, expected ${LINUX_UCRED_BYTES}` };
  }
  const view = new DataView(buffer);
  return { pid: view.getInt32(0, true), uid: view.getUint32(4, true), gid: view.getUint32(8, true), via: 'SO_PEERCRED' };
}

/** macOS: pid from `LOCAL_PEERPID`, uid and gid from `getpeereid(3)`. */
function darwinPeerCredentials(fd: number): UnixPeerCredentials | UnixPeerCredentialFailure {
  const lib = libc();
  if ('loadError' in lib) return { error: lib.loadError, unsupported: 'libc' };

  const pidBuffer = new ArrayBuffer(8);
  const pidLength = new Uint32Array([8]);
  const pidRc = lib.getsockopt(fd, 0, DARWIN_LOCAL_PEERPID, ptr(pidBuffer) as unknown as number, i32Pair(pidLength));
  if (pidRc !== 0) return { error: 'getsockopt(LOCAL_PEERPID) failed', errno: lib.errno() };
  if (pidLength[0] !== 4 && pidLength[0] !== 8) {
    return { error: `getsockopt(LOCAL_PEERPID) answered optlen ${pidLength[0]}, expected 4 or 8` };
  }
  const pid = new DataView(pidBuffer).getUint32(0, true);

  const euid = new Uint32Array([4_294_967_295]);
  const egid = new Uint32Array([4_294_967_295]);
  const idRc = lib.getpeereid(fd, i32Pair(euid), i32Pair(egid));
  if (idRc !== 0) return { error: 'getpeereid failed', errno: lib.errno() };

  return { pid, uid: euid[0]!, gid: egid[0]!, via: 'LOCAL_PEERPID+getpeereid' };
}

/**
 * Read the peer credential of an accepted Unix-domain socket.
 *
 * Returns a failure rather than throwing: a broker that cannot answer "who is this" must
 * refuse that one connection, not lose its listener.
 */
export function readUnixPeerCredentials(fd: number): UnixPeerCredentials | UnixPeerCredentialFailure {
  if (process.platform === 'win32') {
    return { error: 'Unix-domain peer credentials do not exist on Windows', unsupported: 'win32' };
  }
  if (!Number.isInteger(fd) || fd < 0) {
    return { error: `not a usable socket descriptor (${String(fd)})` };
  }
  return process.platform === 'darwin' ? darwinPeerCredentials(fd) : linuxPeerCredentials(fd);
}

/**
 * Is a same-uid check enforceable here at all. A root-run broker accepts peers of any uid,
 * and a broker that cannot ask the kernel cannot check either; both cases must be reported
 * as unenforceable instead of passing a test that never really tested anything.
 */
export function unixPeerCredentialsEnforceable(): { enforceable: boolean; reason: string } {
  if (process.platform === 'win32') return { enforceable: false, reason: 'unsupported platform (win32)' };
  const lib = libc();
  if ('loadError' in lib) return { enforceable: false, reason: `libc unavailable: ${lib.loadError}` };
  return { enforceable: true, reason: 'kernel peer credentials available' };
}
