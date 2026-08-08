/**
 * Same-host detection of codex TUIs joined to OUR shared app-server daemon — the missing presence
 * proof behind the Codex "synced" badge (issues-part2 item 15 follow-ups: a terminal that exits
 * must drop the badge, and only a terminal on OUR daemon may light it).
 *
 * Why the OS and not the daemon: the app-server protocol (verified against codex-cli 0.144.1's
 * generated schema) exposes NO per-thread client surface — `thread/loaded/list` returns bare thread
 * ids and is a one-way latch (a thread stays loaded after every terminal exits; verified live on the
 * production daemon), and there is no subscriber/attachment listing at all. The daemon socket is a
 * unix socket, so terminals are same-host by construction: a synced terminal is an actual live
 * `codex …` process paired to the daemon's accepted socket endpoint.
 *
 * Linux/WSL only. Elsewhere the scan returns empty and the badge under-claims (same host-limit
 * contract as OpenCode): sync itself still works, only the indicator is missing.
 *
 * Attribution levels:
 *  - shared: a process we can prove is paired to our daemon socket (explicit `--remote` match or
 *    unix-socket peer proof from socket diagnostics).
 *  - private: explicit `--remote` to a different socket.
 *  - unknown: no socket evidence yet still parseable as a candidate.
 *
 * For shared determination, explicit `--remote` is still authoritative. For automatic discovery
 * (`codex resume` and plain `codex` with no explicit remote), explicit socket proof is now required
 * — start time is never accepted as sole proof.
 */
import { readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

export const CODEX_TUI_BIRTH_WINDOW_MS = 15 * 60_000;
const CODEX_SOCKET_DIAG_MAX_BYTES = 1024 * 1024;

export type CodexRemoteMatch = 'missing' | 'ours' | 'other';
export type CodexSocketProof = 'shared' | 'private' | 'unknown';
export interface CodexTuiCandidate {
  pid: number;
  threadIds?: string[];
  cwd?: string;
  startedAtMs?: number;
  proof: CodexSocketProof;
}

export interface CodexRemoteArgvFacts {
  threadIds: string[];
  cwdOverride?: string;
  remoteMatch: CodexRemoteMatch;
}

export interface CodexTuiUnattributedCandidate {
  cwd?: string;
  startedAtMs?: number;
}

/** `scan` keeps existing public fields (`attributed` and `unattributed`) unchanged.
 *  Additional sets are additive-only to preserve later onboarding logic.
 */
export interface CodexTuiScan {
  attributed: Set<string>;
  unattributed: CodexTuiUnattributedCandidate[];
  privateThreadIds: Set<string>;
  privateUnattributed: CodexTuiUnattributedCandidate[];
  unknownUnattributed: CodexTuiUnattributedCandidate[];
  unknownThreadIds: Set<string>;
  candidates: CodexTuiCandidate[];
  socketDiagAvailable: boolean;
  processScanAvailable: boolean;
}

const EXCLUDED_INTERACTIVE_VERBS = new Set([
  'e',
  'exec',
  'login',
  'logout',
  'mcp',
  'plugin',
  'mcp-server',
  'app-server',
  'review',
  'remote-control',
  'completion',
  'update',
  'doctor',
  'sandbox',
  'debug',
  'apply',
  'a',
  'archive',
  'delete',
  'unarchive',
  'cloud',
  'exec-server',
  'features',
  'help',
  'helper',
  'ide',
  'bridge',
  'assist',
]);
const EXCLUDED_ONE_SHOT_FLAGS = new Set(['--version', '-V', '--help', '-h']);
const CODEX_TUI_SCAN_CANDIDATE_LIMIT = 1024;

export function codexTuiPresenceSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'linux';
}

/** Normalize a `--remote` value / socket path for comparison: strip the unix:// scheme, resolve
 *  symlink drift when the path exists. TCP remotes (`ws://…`) are not our unix daemon → undefined. */
export function normalizeCodexRemote(value: string): string | undefined {
  let path = value.trim();
  if (/^wss?:\/\//i.test(path)) return undefined;
  if (/^unix:\/\//i.test(path)) path = path.slice('unix://'.length);
  if (!path.startsWith('/')) return undefined;
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function normalizeSocketAddress(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/["',]/g, '').replace(/^@/, '');
  if (!cleaned.startsWith('/')) return undefined;
  try {
    return realpathSync(cleaned);
  } catch {
    return cleaned;
  }
}

function isCodexArgvToken(value: string): boolean {
  return value === 'codex' || value.endsWith('/codex');
}

function codexInteractiveCommandIndex(argv: string[]): number {
  if (argv.length === 0) return -1;

  const launcher = argv[0] ?? '';
  if (isCodexArgvToken(launcher)) return 0;

  const base = launcher.split('/').pop() ?? '';
  if ((base === 'node' || base === 'bun') && isCodexArgvToken(argv[1] ?? '')) return 1;

  return -1;
}

function isInteractiveCodexInvocation(argv: string[]): boolean {
  const start = codexInteractiveCommandIndex(argv);
  if (start < 0) return false;
  for (let i = start + 1; i < argv.length; ) {
    const current = argv[i];
    if (!current) {
      i += 1;
      continue;
    }
    if (current === '--') {
      i += 1;
      continue;
    }
    if (EXCLUDED_ONE_SHOT_FLAGS.has(current)) return false;
    if (EXCLUDED_INTERACTIVE_VERBS.has(current)) return false;
    if (current.startsWith('-')) {
      const next = argv[i + 1];
      if (
        !current.includes('=') &&
        next !== undefined &&
        !next.startsWith('-') &&
        !EXCLUDED_INTERACTIVE_VERBS.has(next)
      ) {
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    return true;
  }
  // `codex` with no non-flag verb is the TUI/default terminal client path.
  return true;
}

/** Parse one /proc cmdline argv against our daemon socket.
 *  Returns thread ids for exact `resume` usage even without `--remote`, plus normalized `--remote` match.
 *  Returns undefined if argv is non-interactive or not a codex invocation we can attribute.
 */
export function codexRemoteArgvFacts(argv: string[], sockPath: string): CodexRemoteArgvFacts | undefined {
  if (!isInteractiveCodexInvocation(argv)) return undefined;
  const ourSock = normalizeCodexRemote(sockPath);
  let remoteMatch: CodexRemoteMatch = 'missing';
  let cwdOverride: string | undefined;
  const threadIds: string[] = [];
  let sawResume = false;
  const start = codexInteractiveCommandIndex(argv);
  for (let i = start + 1; i < argv.length; ) {
    const a = argv[i];
    if (!a) {
      i += 1;
      continue;
    }
    if (a === '--') {
      sawResume = false;
      i += 1;
      continue;
    }
    if (a.startsWith('--remote=')) {
      remoteMatch = deriveRemoteMatch(ourSock, a.slice('--remote='.length));
      i += 1;
      continue;
    }
    if (a === '--remote') {
      const v = argv[i + 1];
      if (v) {
        remoteMatch = deriveRemoteMatch(ourSock, v);
        i += 2;
      } else {
        remoteMatch = 'other';
        i += 1;
      }
      continue;
    }
    if ((a === '-C' || a === '--cd') && typeof argv[i + 1] === 'string') {
      const v = argv[i + 1];
      if (v && !v.startsWith('-')) cwdOverride = v;
      i += 2;
      continue;
    }
    if (a.startsWith('-')) {
      // conservative skip option value to avoid treating values as subcommands.
      if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('-')) {
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (a === 'resume') {
      sawResume = true;
      i += 1;
      continue;
    }
    if (sawResume) {
      if (UUID_RE.test(a)) threadIds.push(a.toLowerCase());
      sawResume = false;
    }

    i += 1;
  }
  return { threadIds, cwdOverride, remoteMatch };
}

function deriveRemoteMatch(ourSock: string | undefined, value: string): CodexRemoteMatch {
  if (!ourSock) return 'other';
  const normalized = normalizeCodexRemote(value);
  if (!normalized) return 'other';
  return normalized === ourSock ? 'ours' : 'other';
}

function processStartedAtMs(procRoot: string, pid: string, nowMs: number): number | undefined {
  try {
    const stat = readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2); // comm may contain spaces/parens
    const fields = afterComm.split(' ');
    const startTicks = Number(fields[19]); // field 22 overall; 20th after state
    if (!Number.isFinite(startTicks)) return undefined;
    const uptimeSec = Number(readFileSync(`${procRoot}/uptime`, 'utf8').split(' ')[0]);
    if (!Number.isFinite(uptimeSec)) return undefined;
    return nowMs - (uptimeSec - startTicks / 100) * 1000;
  } catch {
    return undefined;
  }
}

function processCwd(procRoot: string, pid: string): string | undefined {
  try {
    return readlinkSync(`${procRoot}/${pid}/cwd`);
  } catch {
    return undefined;
  }
}

export type SocketProbe = () => string | undefined;
export type AsyncSocketProbe = () => Promise<string | undefined>;

function runCodexSocketDiag(): string | undefined {
  try {
    const proc = spawnSync('ss', ['-x', '-p', '-n', '-a', '-H'], {
      encoding: 'utf8',
      maxBuffer: CODEX_SOCKET_DIAG_MAX_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (proc.error) return undefined;
    if (proc.status !== 0) return undefined;
    return proc.stdout?.toString();
  } catch {
    return undefined;
  }
}

/** Non-blocking socket diagnostic used by the recurring watch path. `spawn` defaults to
 * `shell:false`; keep it explicit because this is an executable plus fixed argv, never a shell
 * command assembled from user input. The synchronous probe above remains available for cold,
 * one-shot discovery callers. */
async function runCodexSocketDiagAsync(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: string | undefined, child?: ReturnType<typeof spawn>) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (value === undefined && child) {
        try { child.kill(); } catch { /* already exited */ }
      }
      resolve(value);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('ss', ['-x', '-p', '-n', '-a', '-H'], {
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      finish(undefined);
      return;
    }
    child.stdout?.on('data', (chunk) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (outputBytes + bytes.length > CODEX_SOCKET_DIAG_MAX_BYTES) {
        finish(undefined, child);
        return;
      }
      outputBytes += bytes.length;
      chunks.push(bytes);
    });
    child.once('error', () => finish(undefined, child));
    child.once('close', (code) => finish(code === 0 ? Buffer.concat(chunks).toString('utf8') : undefined));
    timer = setTimeout(() => finish(undefined, child), 1500);
  });
}

interface ParsedSocketEntry {
  pids: number[];
  state: string;
  localAddress?: string;
  peerAddress?: string;
  localInode?: number;
  peerInode?: number;
}

function extractSocketEntries(output: string): ParsedSocketEntry[] {
  const out: ParsedSocketEntry[] = [];
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('Netid ') || line.startsWith('Netid')) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 2) continue;
    const state = fields[1];
    if (!state || /[A-Za-z]/.test(state[0] || '') === false) continue;

    const pids = [...line.matchAll(/pid=(\d+),fd=(\d+)/g)].map((m) => Number(m[1]));
    if (!pids.length) continue;

    const localAddress = normalizeSocketAddress(fields[4]);
    const peerAddress = normalizeSocketAddress(fields[6]);
    const localInode = parseInode(fields[5]);
    const peerInode = parseInode(fields[7]);
    out.push({
      pids,
      state,
      localAddress,
      peerAddress,
      localInode,
      peerInode,
    });
  }
  return out;
}

function parseInode(raw: string | undefined): number | undefined {
  if (!raw || raw === '*' || raw === '0') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function sameSocketPair(aInode?: number, bInode?: number): string | undefined {
  if (!aInode || !bInode) return undefined;
  if (aInode === bInode) return undefined;
  return `${Math.min(aInode, bInode)}:${Math.max(aInode, bInode)}`;
}

const PROOF_PRECEDENCE: Record<CodexSocketProof, number> = {
  unknown: 0,
  private: 1,
  shared: 2,
};

function mergeProof(prev: CodexSocketProof | undefined, next: CodexSocketProof): CodexSocketProof {
  if (!prev) return next;
  return PROOF_PRECEDENCE[prev] >= PROOF_PRECEDENCE[next] ? prev : next;
}

/** Parse socket diagnostic output into process-level ownership:
 *  shared = candidate pid has inode/peer pairing to the managed daemon socket.
 *  private = authoritative remote override only (socket diagnostics are unknown-by-default).
 *  unknown = candidate not represented in usable diagnostics.
 */
export function parseCodexSocketOwnership(output: string, sockPath: string): Map<number, CodexSocketProof> {
  const out = new Map<number, CodexSocketProof>();
  const normalized = normalizeSocketAddress(sockPath);
  if (!normalized) return out;
  const entries = extractSocketEntries(output);
  const acceptedPairs = new Set<string>();
  for (const entry of entries) {
    if (entry.state !== 'ESTAB') continue;
    if (entry.localAddress === normalized) {
      const pair = sameSocketPair(entry.localInode, entry.peerInode);
      if (pair) acceptedPairs.add(pair);
      continue;
    }
    if (entry.peerAddress === normalized) {
      const pair = sameSocketPair(entry.peerInode, entry.localInode);
      if (pair) acceptedPairs.add(pair);
    }
  }
  for (const entry of entries) {
    if (entry.pids.length === 0) continue;

    let proof: CodexSocketProof = 'unknown';
    if (entry.state === 'ESTAB') {
      const connectionPair = sameSocketPair(entry.localInode, entry.peerInode);
      const isDaemonPair = connectionPair ? acceptedPairs.has(connectionPair) : false;
      proof = isDaemonPair ? 'shared' : 'unknown';
    }

    for (const pid of entry.pids) {
      if (!Number.isFinite(pid) || pid < 1) continue;
      out.set(pid, mergeProof(out.get(pid), proof));
    }
  }
  return out;
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Scan a /proc root for live codex TUIs attached to the daemon at `sockPath`. Synchronous and
 *  cheap (argv reads only for pids whose cmdline mentions codex); every read is fault-isolated so a
 *  process exiting mid-scan is just skipped. `procRoot` is injectable for tests and for a broker
 *  running under a fake proc (COSYNCING_CODEX_PROC_ROOT).
 *
 *  For non-explicit `--remote`, a socket proof is required for `shared` attribution.
 */
export function scanCodexRemoteTuis(
  sockPath: string,
  procRoot = '/proc',
  nowMs = Date.now(),
  opts: { socketProbe?: SocketProbe } = {},
): CodexTuiScan {
  const socketProbe: SocketProbe = opts.socketProbe ?? runCodexSocketDiag;
  const socketDiagRaw = codexTuiPresenceSupported() ? socketProbe() : undefined;
  return scanCodexRemoteTuisWithSocketDiag(sockPath, procRoot, nowMs, socketDiagRaw);
}

/** Async equivalent for recurring watch polls. The socket probe is awaited before the same
 * deterministic /proc scan is performed, so no synchronous `ss` process can block the broker. */
export async function scanCodexRemoteTuisAsync(
  sockPath: string,
  procRoot = '/proc',
  nowMs = Date.now(),
  opts: { socketProbe?: AsyncSocketProbe } = {},
): Promise<CodexTuiScan> {
  let socketDiagRaw: string | undefined;
  if (codexTuiPresenceSupported()) {
    try {
      socketDiagRaw = await (opts.socketProbe ?? runCodexSocketDiagAsync)();
    } catch {
      socketDiagRaw = undefined;
    }
  }
  return scanCodexRemoteTuisWithSocketDiag(sockPath, procRoot, nowMs, socketDiagRaw);
}

function scanCodexRemoteTuisWithSocketDiag(
  sockPath: string,
  procRoot: string,
  nowMs: number,
  socketDiagRaw: string | undefined,
): CodexTuiScan {
  const socketDiagAvailable = socketDiagRaw !== undefined;
  const socketProofByPid = socketDiagAvailable ? parseCodexSocketOwnership(socketDiagRaw, sockPath) : undefined;
  let processScanAvailable = false;

  const scan: CodexTuiScan = {
    attributed: new Set(),
    unattributed: [],
    unknownUnattributed: [],
    privateUnattributed: [],
    privateThreadIds: new Set(),
    unknownThreadIds: new Set(),
    candidates: [],
    socketDiagAvailable,
    processScanAvailable,
  };
  if (!codexTuiPresenceSupported()) {
    return scan;
  }
  let pids: string[];
  try {
    pids = readdirSync(procRoot).filter((d) => /^\d+$/.test(d));
  } catch {
    scan.processScanAvailable = false;
    return scan;
  }
  scan.processScanAvailable = true;
  for (const pid of pids) {
    let raw: string;
    try {
      raw = readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8');
    } catch {
      continue; // exited mid-scan / not ours
    }
    if (!raw.includes('codex')) continue; // cheap pre-filter before argv parsing
    const argv = raw.split('\0').filter(Boolean);
    if (argv.length === 0) continue;
    const facts = codexRemoteArgvFacts(argv, sockPath);
    if (!facts) continue;

    let proof = 'unknown' as CodexSocketProof;
    if (facts.remoteMatch === 'ours') {
      proof = 'shared';
    } else if (facts.remoteMatch === 'other') {
      proof = 'private';
    } else if (socketDiagRaw) {
      proof = socketProofByPid?.get(Number(pid)) ?? 'unknown';
    }
    const candidateBase = {
      pid: Number(pid),
      threadIds: facts.threadIds.length ? facts.threadIds : undefined,
      cwd: facts.cwdOverride ?? processCwd(procRoot, pid),
      startedAtMs: processStartedAtMs(procRoot, pid, nowMs),
      proof,
    };
    if (scan.candidates.length < CODEX_TUI_SCAN_CANDIDATE_LIMIT) {
      scan.candidates.push(candidateBase);
    }

    if (facts.threadIds.length) {
      for (const id of facts.threadIds) {
        if (proof === 'shared') {
          scan.attributed.add(id);
        } else if (proof === 'private') {
          scan.privateThreadIds.add(id);
        } else {
          scan.unknownThreadIds.add(id);
        }
      }
    } else if (proof === 'shared') {
      scan.unattributed.push({
        cwd: candidateBase.cwd,
        startedAtMs: candidateBase.startedAtMs,
      });
    } else if (proof === 'private') {
      scan.privateUnattributed.push({
        cwd: candidateBase.cwd,
        startedAtMs: candidateBase.startedAtMs,
      });
    } else {
      scan.unknownUnattributed.push({
        cwd: candidateBase.cwd,
        startedAtMs: candidateBase.startedAtMs,
      });
    }
  }
  return scan;
}

/** Does this scan prove a terminal is attached to `threadId`? Tier 1 is exact argv/thread evidence; tier 2
 *  requires BOTH cwd match and birth window, and only when that candidate is shared.
 */
export function codexTuiThreadAttached(
  scan: CodexTuiScan,
  threadId: string,
  cwd?: string,
  createdAtMs?: number,
): boolean {
  if (scan.attributed.has(threadId.toLowerCase())) return true;
  if (!cwd || createdAtMs === undefined || !scan.unattributed.length) return false;
  const want = safeRealpath(cwd);
  return scan.unattributed.some(
    (t) =>
      t.cwd !== undefined &&
      t.startedAtMs !== undefined &&
      safeRealpath(t.cwd) === want &&
      Math.abs(createdAtMs - t.startedAtMs) <= CODEX_TUI_BIRTH_WINDOW_MS,
  );
}

/** TTL-cached presence per daemon socket: discovery calls this once per roster row, so the scan must be
 *  amortized. 2s keeps badge flips near-live while bounding /proc traffic to one scan per window. */
const cache = new Map<string, { at: number; scan: CodexTuiScan }>();
const asyncRefreshes = new Map<string, Promise<CodexTuiScan>>();
let cacheGeneration = 0;
export const CODEX_TUI_PRESENCE_TTL_MS = 2_000;

function emptyCodexTuiScan(): CodexTuiScan {
  return {
    attributed: new Set(),
    unattributed: [],
    privateUnattributed: [],
    unknownUnattributed: [],
    candidates: [],
    privateThreadIds: new Set(),
    unknownThreadIds: new Set(),
    socketDiagAvailable: false,
    processScanAvailable: false,
  };
}

function codexTuiCacheKey(sockPath: string, root: string): string {
  return `${sockPath}\0${root}`;
}

export function codexAttachedTuis(sockPath: string, procRoot?: string): CodexTuiScan {
  const root = procRoot ?? process.env.COSYNCING_CODEX_PROC_ROOT?.trim() ?? '/proc';
  if (!codexTuiPresenceSupported()) return emptyCodexTuiScan();
  const key = codexTuiCacheKey(sockPath, root);
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < CODEX_TUI_PRESENCE_TTL_MS) return hit.scan;
  const scan = scanCodexRemoteTuis(sockPath, root, now);
  cache.set(key, { at: now, scan });
  return scan;
}

/** TTL-cached async presence refresh. Calls for the same daemon/proc root share one in-flight
 * scan, and a completed result is reused for the normal presence TTL. */
export function codexAttachedTuisAsync(
  sockPath: string,
  procRoot?: string,
  opts: { socketProbe?: AsyncSocketProbe } = {},
): Promise<CodexTuiScan> {
  const root = procRoot ?? process.env.COSYNCING_CODEX_PROC_ROOT?.trim() ?? '/proc';
  if (!codexTuiPresenceSupported()) return Promise.resolve(emptyCodexTuiScan());
  const key = codexTuiCacheKey(sockPath, root);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CODEX_TUI_PRESENCE_TTL_MS) return Promise.resolve(hit.scan);
  const inFlight = asyncRefreshes.get(key);
  if (inFlight) return inFlight;

  const generation = cacheGeneration;
  const refresh = (async () => {
    const scan = await scanCodexRemoteTuisAsync(sockPath, root, Date.now(), opts);
    if (generation === cacheGeneration) cache.set(key, { at: Date.now(), scan });
    return scan;
  })();
  asyncRefreshes.set(key, refresh);
  void refresh.then(() => {
    if (asyncRefreshes.get(key) === refresh) asyncRefreshes.delete(key);
  }, () => {
    if (asyncRefreshes.get(key) === refresh) asyncRefreshes.delete(key);
  });
  return refresh;
}

/** Test hook: drop the TTL cache so a subsequent call re-scans immediately. */
export function resetCodexTuiPresenceCache(): void {
  cacheGeneration += 1;
  cache.clear();
  asyncRefreshes.clear();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
