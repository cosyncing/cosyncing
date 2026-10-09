/**
 * "Is the process I registered still the process I registered?", answered without lying.
 *
 * The Claude mod registry watches the pid it read off the peer credential, and a bare
 * `kill(pid, 0)` is not enough there. Between the moment a `claude` process exits and the
 * moment its pid is handed to something else, that probe answers "alive" about an unrelated
 * process, and a dead session keeps its synced badge and its Drive affordance. So liveness
 * here is two facts, the process exists and it is the one we met, each taken from the
 * strongest source the platform offers:
 *
 * - Linux: `pidfd_open(2)` (syscall 434) returns a descriptor bound to this process rather
 *   than to the number, so the kernel does the identity work and a recycled pid fails to
 *   open a pidfd for the process we meant. This mirrors the syscall route already used for
 *   process-bound shutdown in `adapters/codex/src/daemon-process.ts`, which exists because
 *   the same pid-reuse hazard bites signalling.
 * - macOS: no pidfd. `kill -0` plus a start-time comparison against the start time captured
 *   at registration. A recycled process answers with a different start time and reads dead.
 *
 * A start time is never invented. When the source cannot answer, the caller is told
 * `identityKnown: false` and decides; the registry fails that case toward "observe" rather
 * than toward "keep driving".
 *
 * The macOS routes shell out, so they are cached. The registry asks twice per registration and again
 * on every roster frame it renders, and the socket asks on every request, which on a busy app is a
 * `ps` subprocess several times a second for one terminal -- synchronously, on the broker's event loop.
 * The two caches are different questions with different lifetimes:
 *  - A start time is cached for PROCESS_CACHE_TTL_MS. The cache holds the ANSWER, not a decision: a
 *    process that died is still reported dead, because a cached start time is compared against the
 *    one taken at registration and cannot start agreeing again on its own. Two seconds is shorter
 *    than every timeout in the mod protocol, so no hold, hold deadline or freshness window can turn
 *    over inside one cache entry.
 *  - The [pid, ppid] table behind the broker-child check is kept for PROCESS_TABLE_TTL_MS, which is
 *    longer than the mod's 20 s poll; at two seconds every poll from every terminal paid for a fresh
 *    `ps` of the whole table. A pid's parent only ever changes to launchd when the parent exits, and
 *    XNU hands pids out in sequence, so a pid in a minute-old table is the process it was. A pid that
 *    is NOT in the table is newer than the snapshot -- a terminal that just started -- and is answered
 *    from a fresh one, never as "unknown" from the stale one. Caching that miss is what let a Claude
 *    the broker had just launched read as "not a broker child" for the life of the entry.
 */

/** How long a macOS start-time answer stays worth reusing. See the note above. */
const PROCESS_CACHE_TTL_MS = 2_000;
/** How long the macOS [pid, ppid] table stays worth reusing. See the note above. */
const PROCESS_TABLE_TTL_MS = 60_000;
/** A miss refreshes the table, but no more often than this: a flood of connections cannot become a
 *  flood of `ps`. */
const PROCESS_TABLE_MISS_REFRESH_MS = 250;

interface CacheEntry<T> {
  value: T;
  at: number;
}

const startTimeCache = new Map<number, CacheEntry<string | undefined>>();

function cached<T>(map: Map<number, CacheEntry<T>>, pid: number, read: () => T): T {
  const hit = map.get(pid);
  const now = Date.now();
  if (hit && now - hit.at < PROCESS_CACHE_TTL_MS) return hit.value;
  const value = read();
  map.set(pid, { value, at: now });
  // Two live terminals is the common case; this map exists to stop a subprocess storm, not to
  // remember the whole process table.
  if (map.size > 256) map.delete(map.keys().next().value as number);
  return value;
}

/** The parent relation of a process table, answered from a snapshot that is refreshed on a miss. */
export interface ProcessTable {
  parentOf(pid: number): number | undefined;
}

/**
 * A process table read from `ps -eo pid=,ppid=` output, with the caching rules in the note above.
 *
 * `run` returns the command's stdout, or undefined when it failed; a failed read is an empty table,
 * which answers every question as "not a descendant" -- the same as an unreadable `/proc` on Linux.
 * Exported so the rules can be tested on any host; production uses one instance on macOS.
 */
export function createProcessTable(options: {
  run: () => string | undefined;
  now?: () => number;
  ttlMs?: number;
  missRefreshMs?: number;
}): ProcessTable {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? PROCESS_TABLE_TTL_MS;
  const missRefreshMs = options.missRefreshMs ?? PROCESS_TABLE_MISS_REFRESH_MS;
  let snapshot: { at: number; parents: Map<number, number> } | undefined;
  const take = (): { at: number; parents: Map<number, number> } => {
    const parents = new Map<number, number>();
    let text: string | undefined;
    try {
      text = options.run();
    } catch {
      text = undefined;
    }
    for (const line of String(text ?? '').split('\n')) {
      const parts = line.trim().split(/\s+/);
      const child = Number(parts[0]);
      const parent = Number(parts[1]);
      if (parts.length === 2 && Number.isInteger(child) && Number.isInteger(parent) && child > 0 && parent >= 0) {
        parents.set(child, parent);
      }
    }
    snapshot = { at: now(), parents };
    return snapshot;
  };
  const current = () => (snapshot && now() - snapshot.at < ttlMs ? snapshot : take());
  return {
    parentOf(pid) {
      let table = current();
      let parent = table.parents.get(pid);
      if (parent === undefined && now() - table.at >= missRefreshMs) {
        table = take();
        parent = table.parents.get(pid);
      }
      return parent;
    },
  };
}

/** One `ps` call per refresh, for the macOS parent chain behind the broker-child check. */
const darwinProcessTable = createProcessTable({
  run: () => {
    const cp = require('node:child_process');
    const ps = cp.spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' });
    return ps.status === 0 ? String(ps.stdout ?? '') : undefined;
  },
});

const ffi = require('bun:ffi') as typeof import('bun:ffi');

/** `pidfd_open`; `pidfd_send_signal` shares the numbering convention on supported hosts. */
const LINUX_SYS_PIDFD_OPEN = 434;

interface LinuxPidfdApi {
  open(pid: number): number;
  close(fd: number): void;
}

let linuxPidfd: LinuxPidfdApi | { loadError: string } | undefined;

/** Resolve `syscall` and `close` once, the same way the Codex signal binding does. */
function linuxPidfdApi(): LinuxPidfdApi | { loadError: string } {
  if (linuxPidfd) return linuxPidfd;
  if (process.arch !== 'x64' && process.arch !== 'arm64') {
    linuxPidfd = { loadError: `pidfd is not wired for architecture ${process.arch}` };
    return linuxPidfd;
  }
  const { dlopen, FFIType } = ffi;
  const symbols = {
    syscall: { args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64], returns: FFIType.i64 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
  } as const;
  try {
    const lib = dlopen('libc.so.6', symbols);
    linuxPidfd = {
      open: (pid) => Number(lib.symbols.syscall(LINUX_SYS_PIDFD_OPEN, pid, 0, 0, 0)),
      close: (fd) => { lib.symbols.close(fd); },
    };
  } catch (error) {
    linuxPidfd = { loadError: `could not load libc for pidfd_open (${String((error as Error)?.message ?? error).slice(0, 120)})` };
  }
  return linuxPidfd;
}

/**
 * Open and immediately close a pidfd: true only when the kernel binds it to a live process.
 *
 * A failed `pidfd_open` is not one answer but three. ESRCH means the process is gone; ENOSYS (a
 * kernel older than 5.3), EMFILE (the broker is out of descriptors) and EINVAL mean the PROBE
 * failed, and reading those as "that terminal's Claude has died" would take a live session's synced
 * badge and release its holds because this process ran short on file handles. So a negative answer
 * falls back to the one thing that needs no descriptor: is `/proc/<pid>/stat` still there? The
 * caller's start-time comparison still runs on top of that, so the fallback is no looser than the
 * route it replaces.
 */
function linuxPidAlive(pid: number): boolean {
  const api = linuxPidfdApi();
  if ('loadError' in api) return procStatFields(pid) !== undefined || process.kill(pid, 0);
  const fd = api.open(pid);
  if (fd === 0) {
    // Pidfd 0 would be stdin. Not a bug that has been seen, but a descriptor number is not a
    // liveness answer and closing it on the way out would close stdin.
    return procStatFields(pid) !== undefined;
  }
  if (fd < 0) return procStatFields(pid) !== undefined;
  api.close(fd);
  return true;
}

/** Fields after `comm` in `/proc/<pid>/stat`, which is the only safe way to split that line. */
function procStatFields(pid: number): string[] | undefined {
  try {
    const fs = require('node:fs');
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8') as string;
    // Field 2 is comm and may contain spaces and parentheses, so count from the last ')'.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  } catch {
    return undefined;
  }
}

/**
 * Kernel start time of a process, as an opaque comparable token.
 *
 * Linux reads field 22 of `/proc/<pid>/stat` (clock ticks since boot), cheap enough to call
 * on every check. Darwin shells out to `ps -o lstart=` because the FFI route
 * (`proc_pidinfo` or `KERN_PROC_PID`) needs a hand-written `struct extern_proc` offset table,
 * which is precisely the silent-rot risk this lane declines to carry. Registrations are rare
 * on macOS and one short subprocess per registration is the honest trade.
 */
export function processStartTime(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === 'linux') {
    const fields = procStatFields(pid);
    const starttime = fields?.[19]; // field 22 overall, field 3 after comm
    return starttime ? `linux:${starttime}` : undefined;
  }
  if (process.platform === 'darwin') {
    return cached(startTimeCache, pid, () => {
      try {
        const cp = require('node:child_process');
        const ps = cp.spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
        const out = String(ps.stdout ?? '').trim();
        return ps.status === 0 && out ? `darwin:${out}` : undefined;
      } catch {
        return undefined;
      }
    });
  }
  return undefined;
}

export interface ProcessLiveness {
  alive: boolean;
  /** False when the platform could not prove the process is the one we met. */
  identityKnown: boolean;
  /** Why the caller should treat the process as gone, when it should. */
  reason?: string;
}

/**
 * Is `pid` still the process it was when `expectedStart` was captured?
 *
 * `expectedStart` omitted means the identity was never captured, which is answered honestly
 * rather than optimistically: on Linux the pidfd settles identity by construction, elsewhere
 * the caller is told it is not known.
 */
export function processIsSameLiveProcess(pid: number, expectedStart?: string): ProcessLiveness {
  if (!Number.isInteger(pid) || pid <= 0) return { alive: false, identityKnown: true, reason: 'no pid recorded' };
  try {
    if (process.platform === 'linux') {
      if (!linuxPidAlive(pid)) return { alive: false, identityKnown: true, reason: 'pidfd_open says the process is gone' };
      if (expectedStart) {
        const now = processStartTime(pid);
        if (now && now !== expectedStart) return { alive: false, identityKnown: true, reason: 'start time changed: pid was recycled' };
      }
      return { alive: true, identityKnown: true };
    }
    try {
      process.kill(pid, 0);
    } catch {
      return { alive: false, identityKnown: true, reason: 'kill(0) says the process is gone' };
    }
    if (!expectedStart) return { alive: true, identityKnown: false, reason: 'no start time recorded for this pid' };
    const now = processStartTime(pid);
    if (!now) return { alive: true, identityKnown: false, reason: 'start time unavailable' };
    if (now !== expectedStart) return { alive: false, identityKnown: true, reason: 'start time changed: pid was recycled' };
    return { alive: true, identityKnown: true };
  } catch (error) {
    return { alive: false, identityKnown: true, reason: `liveness probe failed (${String((error as Error)?.message ?? error).slice(0, 80)})` };
  }
}

/**
 * Is `pid` a descendant of `ancestor`?
 *
 * Used to drop a registration whose peer is a process the broker itself launched, which is
 * the two-writers-on-one-session case. Depth-bounded and read-only, and a chain it cannot
 * walk answers "not a descendant" so an unreadable `/proc` never silently disables the check
 * for every ordinary session.
 */
export function processIsDescendantOf(pid: number, ancestor: number, maxDepth = 16): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ancestor) || ancestor <= 0) return false;
  if (process.platform !== 'linux' && process.platform !== 'darwin') return false;
  let current = pid;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const ppid = parentPidOf(current);
    if (!Number.isInteger(ppid) || (ppid ?? 0) <= 0) return false;
    if (ppid === ancestor) return true;
    if (ppid === 1) return false;
    current = ppid!;
  }
  return false;
}

/**
 * Immediate parent, from the process table rather than from anything a process can say about
 * itself. Linux reads `/proc`; macOS reads one cached `ps`, which is also what makes the
 * broker-child refusal work there at all (see the note on {@link parentPidOf}).
 */
function parentPidOf(pid: number): number | undefined {
  if (process.platform === 'darwin') {
    return darwinProcessTable.parentOf(pid);
  }
  const fields = procStatFields(pid);
  const ppid = Number(fields?.[1]); // field 4 overall, field 2 after comm
  return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined;
}
