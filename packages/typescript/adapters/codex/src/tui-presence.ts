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
 * Linux/WSL uses /proc plus `ss`. macOS uses bounded fixed-argv `ps`/`lsof` probes and rechecks
 * pid+start+argv after collecting cwd/socket evidence. Other platforms return unknown.
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
import {
  accessSync,
  constants,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { basename, resolve } from 'node:path';

export const CODEX_TUI_BIRTH_WINDOW_MS = 15 * 60_000;
const CODEX_SOCKET_DIAG_MAX_BYTES = 1024 * 1024;
export const CODEX_MAC_SCAN_CANDIDATE_LIMIT = 64;
const CODEX_MAC_WRAPPER_PREFILTER_LIMIT = 1024;
export const CODEX_MAC_SCAN_OUTPUT_MAX_BYTES = 1024 * 1024;
export const CODEX_MAC_SCAN_DEADLINE_MS = 1_500;
export const CODEX_MAC_SCAN_CACHE_KEY_LIMIT = 32;
export const CODEX_MAC_PS_PATH = '/bin/ps';
export const CODEX_MAC_LSOF_PATH = '/usr/sbin/lsof';

export type CodexRemoteMatch = 'missing' | 'ours' | 'other';
export type CodexSocketProof = 'shared' | 'private' | 'unknown';
export interface CodexTuiCandidate {
  pid: number;
  threadIds?: string[];
  cwd?: string;
  startedAtMs?: number;
  /** Stable process start identity (macOS ps lstart); paired with pid to defeat reuse. */
  startToken?: string;
  /** Exact bounded argv evidence as represented by the trusted scanner. */
  argv?: string[];
  /** Bounded Unix-socket names observed for this process. */
  socketPaths?: string[];
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
  /** Scanner that produced the evidence. Additive so Linux classification stays byte-for-byte compatible. */
  source?: 'linux' | 'darwin';
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
  return platform === 'linux' || platform === 'darwin';
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

function isCodexArgvToken(
  value: string,
  configured?: CodexMacConfiguredExecutable,
): boolean {
  return value === 'codex' || value.endsWith('/codex')
    || isConfiguredMacCodexToken(value, configured);
}

function codexInteractiveCommandIndex(
  argv: string[],
  configured?: CodexMacConfiguredExecutable,
): number {
  if (argv.length === 0) return -1;

  const launcher = argv[0] ?? '';
  if (isCodexArgvToken(launcher, configured)) return 0;

  const base = launcher.split('/').pop() ?? '';
  if ((base === 'node' || base === 'bun') && isCodexArgvToken(argv[1] ?? '', configured)) return 1;

  return -1;
}

function isInteractiveCodexInvocation(
  argv: string[],
  configured?: CodexMacConfiguredExecutable,
): boolean {
  const start = codexInteractiveCommandIndex(argv, configured);
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
export function codexRemoteArgvFacts(
  argv: string[],
  sockPath: string,
  configured?: CodexMacConfiguredExecutable,
): CodexRemoteArgvFacts | undefined {
  if (!isInteractiveCodexInvocation(argv, configured)) return undefined;
  const ourSock = normalizeCodexRemote(sockPath);
  let remoteMatch: CodexRemoteMatch = 'missing';
  let cwdOverride: string | undefined;
  const threadIds: string[] = [];
  let sawResume = false;
  const start = codexInteractiveCommandIndex(argv, configured);
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

export interface CodexMacCommandResult {
  exitCode: number | null;
  stdout: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
}

/** Canonical process identity for an explicit COSYNCING_CODEX_BIN. The invocation path is retained
 * because script/symlink argv can preserve it while `ps comm` reports the resolved target. */
export interface CodexMacConfiguredExecutable {
  invocationPath: string;
  resolvedPath: string;
}

/** Resolve the configured launcher without executing it. `null` means an explicit value exists but
 * cannot be mapped safely to a regular executable and therefore cannot support positive absence. */
export function resolveCodexMacConfiguredExecutable(
  configured: string | undefined,
  cwd = process.cwd(),
): CodexMacConfiguredExecutable | null | undefined {
  const value = configured?.trim();
  if (!value) return undefined;
  if (/[\0\r\n]/.test(value)) return null;
  const invocationPath = resolve(cwd, value);
  try {
    if (!statSync(invocationPath).isFile()) return null;
    accessSync(invocationPath, constants.X_OK);
    const resolvedPath = realpathSync(invocationPath);
    if (!resolvedPath.startsWith('/')) return null;
    return { invocationPath, resolvedPath };
  } catch {
    return null;
  }
}

export type CodexMacCommandRunner = (
  executable: string,
  args: readonly string[],
  limits: { timeoutMs: number; maxOutputBytes: number },
) => Promise<CodexMacCommandResult>;

export async function runBoundedMacCommand(
  executable: string,
  args: readonly string[],
  limits: { timeoutMs: number; maxOutputBytes: number },
): Promise<CodexMacCommandResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;
    let terminationRequested = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let exitBackstop: ReturnType<typeof setTimeout> | undefined;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (exitBackstop) clearTimeout(exitBackstop);
      resolve({
        exitCode,
        stdout: Buffer.concat(chunks).toString('utf8'),
        timedOut,
        outputLimitExceeded,
      });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, [...args], {
        shell: false,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      finish(null);
      return;
    }
    const terminate = () => {
      if (terminationRequested) return;
      terminationRequested = true;
      try { child.kill('SIGKILL'); } catch { /* close/error or the backstop settles the probe */ }
      // `close` is the normal completion boundary: Node emits it only after the child exits and its
      // stdio handles close. The final backstop preserves the caller deadline if the host fails to
      // deliver that confirmation after SIGKILL; that exceptional result is still unavailable.
      exitBackstop = setTimeout(() => {
        child.stdout?.destroy();
        child.unref();
        finish(null);
      }, 250);
      exitBackstop.unref?.();
    };
    child.stdout?.on('data', (chunk) => {
      if (settled) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (bytes + value.length > limits.maxOutputBytes) {
        outputLimitExceeded = true;
        terminate();
        return;
      }
      bytes += value.length;
      chunks.push(value);
    });
    child.once('error', () => {
      if (child.pid) terminate();
      else finish(null);
    });
    child.once('close', (code) => finish(typeof code === 'number' ? code : null));
    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, Math.max(50, limits.timeoutMs));
    timer.unref?.();
  });
}

interface MacPsIdentity {
  pid: number;
  startToken: string;
  startedAtMs: number;
  executable: string;
}

interface MacPsCandidate extends MacPsIdentity {
  rawArgs: string;
  argv: string[];
  facts: CodexRemoteArgvFacts;
}

const MAC_PS_IDENTITY_LINE = /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/;
const MAC_PS_ARGS_LINE = /^\s*(\d+)\s+(.+)$/;

function configuredMacCodexPaths(configured: CodexMacConfiguredExecutable | undefined): string[] {
  return configured
    ? [...new Set([configured.invocationPath, configured.resolvedPath])]
    : [];
}

function isConfiguredMacCodexToken(
  value: string,
  configured: CodexMacConfiguredExecutable | undefined,
): boolean {
  if (!configured) return false;
  const paths = configuredMacCodexPaths(configured);
  return paths.includes(value) || paths.some((path) => basename(path) === value);
}

function possibleMacCodexExecutable(
  executable: string,
  configured?: CodexMacConfiguredExecutable,
): boolean {
  const name = basename(executable).toLowerCase();
  return name === 'codex' || name === 'node' || name === 'bun'
    || configuredMacCodexPaths(configured).some((path) =>
      executable === path || name === basename(path).toLowerCase());
}

function isMacNodeOrBunWrapper(
  executable: string,
  configured?: CodexMacConfiguredExecutable,
): boolean {
  const name = basename(executable).toLowerCase();
  return (name === 'node' || name === 'bun')
    && !isConfiguredMacCodexToken(executable, configured);
}

/** Cheap conservative filter for flattened Node/Bun argv. It intentionally runs before strict
 * argv parsing: unrelated commands may contain quotes/backslashes, while a row that plausibly
 * names Codex must still pass the strict parser or invalidate positive absence. */
function possibleMacCodexArgvText(
  value: string,
  configured?: CodexMacConfiguredExecutable,
): boolean {
  if (/(?:^|[^a-z0-9_])codex(?:$|[^a-z0-9_])/i.test(value)) return true;
  return configuredMacCodexPaths(configured).some((path) =>
    value.includes(path) || value.includes(basename(path)));
}

function possibleMacCodexIdentityText(
  value: string,
  configured?: CodexMacConfiguredExecutable,
): boolean {
  const trimmed = value.trim();
  return /(?:^|[\/\s])(?:codex|node|bun)(?:$|\s)/i.test(trimmed)
    || configuredMacCodexPaths(configured).some((path) => {
      const name = basename(path);
      return trimmed === path || trimmed.endsWith(` ${path}`)
        || trimmed === name || trimmed.endsWith(` ${name}`);
    });
}

function parseMacPsArgv(
  raw: string,
  executable: string,
  configured?: CodexMacConfiguredExecutable,
): string[] | undefined {
  if (!raw || /[\0\r\n]/.test(raw) || /["'\\]/.test(raw)) return undefined;
  const trimmed = raw.trim();
  let argv: string[];
  const directPrefixes = [executable, ...configuredMacCodexPaths(configured)]
    .filter((path, index, paths) => paths.indexOf(path) === index)
    .filter((path) => basename(executable).toLowerCase() === 'codex'
      || isConfiguredMacCodexToken(path, configured))
    .sort((left, right) => right.length - left.length);
  const directPrefix = directPrefixes.find((path) => trimmed === path || trimmed.startsWith(`${path} `));
  if (directPrefix) {
    const remainder = trimmed.slice(directPrefix.length).trim();
    argv = [directPrefix, ...(remainder ? remainder.split(/\s+/) : [])];
  } else {
    argv = trimmed.split(/\s+/).filter(Boolean);
  }
  return argv.length > 0 && argv.length <= 256 ? argv : undefined;
}

function parseMacPsIdentities(
  output: string,
  configured?: CodexMacConfiguredExecutable,
): {
  identities: MacPsIdentity[];
  trustworthy: boolean;
} {
  const identities: MacPsIdentity[] = [];
  let trustworthy = true;
  let sawProcessRow = false;
  let directCandidateCount = 0;
  let wrapperPrefilterCount = 0;
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const match = line.match(MAC_PS_IDENTITY_LINE);
    if (!match) {
      if (possibleMacCodexIdentityText(line, configured)) trustworthy = false;
      continue;
    }
    const pid = Number(match[1]);
    const startToken = match[2]!;
    const executable = match[3]!.trim();
    const startedAtMs = Date.parse(startToken);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(startedAtMs)) {
      if (possibleMacCodexExecutable(executable, configured)) trustworthy = false;
      continue;
    }
    sawProcessRow = true;
    if (!possibleMacCodexExecutable(executable, configured)) continue;
    identities.push({ pid, startToken, startedAtMs, executable });
    if (isMacNodeOrBunWrapper(executable, configured)) {
      wrapperPrefilterCount++;
      if (wrapperPrefilterCount > CODEX_MAC_WRAPPER_PREFILTER_LIMIT) trustworthy = false;
    } else {
      directCandidateCount++;
      if (directCandidateCount > CODEX_MAC_SCAN_CANDIDATE_LIMIT) trustworthy = false;
    }
  }
  return {
    identities: identities.slice(
      0,
      CODEX_MAC_SCAN_CANDIDATE_LIMIT + CODEX_MAC_WRAPPER_PREFILTER_LIMIT,
    ),
    trustworthy: trustworthy && sawProcessRow,
  };
}

function parseMacPsArgs(output: string): { argsByPid: Map<number, string>; trustworthy: boolean } {
  const argsByPid = new Map<number, string>();
  let trustworthy = true;
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const match = line.match(MAC_PS_ARGS_LINE);
    const pid = Number(match?.[1]);
    const rawArgs = match?.[2]?.trim();
    if (!match || !Number.isSafeInteger(pid) || pid <= 0 || !rawArgs || argsByPid.has(pid)) {
      trustworthy = false;
      continue;
    }
    argsByPid.set(pid, rawArgs);
  }
  return { argsByPid, trustworthy };
}

function qualifyMacPsCandidates(
  identities: readonly MacPsIdentity[],
  argsOutput: string,
  sockPath: string,
  configured?: CodexMacConfiguredExecutable,
): { candidates: MacPsCandidate[]; trustworthy: boolean } {
  const parsedArgs = parseMacPsArgs(argsOutput);
  if (!parsedArgs.trustworthy || parsedArgs.argsByPid.size !== identities.length) {
    return { candidates: [], trustworthy: false };
  }
  const candidates: MacPsCandidate[] = [];
  let relevantCandidateCount = 0;
  for (const identity of identities) {
    const rawArgs = parsedArgs.argsByPid.get(identity.pid);
    if (!rawArgs) return { candidates: [], trustworthy: false };
    if (isMacNodeOrBunWrapper(identity.executable, configured)
        && !possibleMacCodexArgvText(rawArgs, configured)) {
      continue;
    }
    relevantCandidateCount++;
    if (relevantCandidateCount > CODEX_MAC_SCAN_CANDIDATE_LIMIT) {
      return { candidates: [], trustworthy: false };
    }
    const argv = parseMacPsArgv(rawArgs, identity.executable, configured);
    if (!argv) return { candidates: [], trustworthy: false };
    const facts = codexRemoteArgvFacts(argv, sockPath, configured);
    if (!facts) {
      // Exact direct Codex identity plus a recognized non-interactive verb is irrelevant. Node/Bun
      // processes whose flattened argv still mentions Codex are not safely distinguishable from a
      // launcher path containing spaces, so they invalidate absence instead of disappearing.
      const executableName = basename(identity.executable).toLowerCase();
      const mentionsConfigured = configuredMacCodexPaths(configured).some((path) =>
        rawArgs === path || rawArgs.startsWith(`${path} `) || rawArgs.includes(` ${path} `));
      const identifiedInvocation = codexInteractiveCommandIndex(argv, configured) >= 0;
      if (!identifiedInvocation &&
          ((executableName === 'codex' || isConfiguredMacCodexToken(identity.executable, configured))
            || /\bcodex\b/i.test(rawArgs) || mentionsConfigured)) {
        return { candidates: [], trustworthy: false };
      }
      continue;
    }
    candidates.push({ ...identity, rawArgs, argv, facts });
  }
  return { candidates, trustworthy: true };
}

function parseLsofFields(output: string): Map<number, Array<{ fd?: string; name: string }>> {
  const rows = new Map<number, Array<{ fd?: string; name: string }>>();
  let pid: number | undefined;
  let fd: string | undefined;
  for (const line of output.split('\n')) {
    if (!line) continue;
    const field = line[0];
    const value = line.slice(1);
    if (field === 'p') {
      const parsed = Number(value);
      pid = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
      fd = undefined;
    } else if (field === 'f') {
      fd = value;
    } else if (field === 'n' && pid !== undefined) {
      const list = rows.get(pid) ?? [];
      list.push({ ...(fd ? { fd } : {}), name: value });
      rows.set(pid, list);
    }
  }
  return rows;
}

function lsofSocketPath(raw: string): string | undefined {
  const value = raw.trim().replace(/^->/, '');
  if (!value.startsWith('/')) return undefined;
  const suffix = value.indexOf(' type=');
  return normalizeSocketAddress(suffix >= 0 ? value.slice(0, suffix) : value);
}

function addMacCandidate(scan: CodexTuiScan, candidate: CodexTuiCandidate): void {
  scan.candidates.push(candidate);
  const threadIds = candidate.threadIds ?? [];
  if (threadIds.length) {
    for (const id of threadIds) {
      if (candidate.proof === 'shared') scan.attributed.add(id);
      else if (candidate.proof === 'private') scan.privateThreadIds.add(id);
      else scan.unknownThreadIds.add(id);
    }
    return;
  }
  const unattributed = { cwd: candidate.cwd, startedAtMs: candidate.startedAtMs };
  if (candidate.proof === 'shared') scan.unattributed.push(unattributed);
  else if (candidate.proof === 'private') scan.privateUnattributed.push(unattributed);
  else scan.unknownUnattributed.push(unattributed);
}

/** Conservative macOS scanner. It uses only protected fixed-argv ps/lsof subprocesses (never a shell),
 * shares one deadline/output budget, re-reads pid+start+executable+argv after lsof to defeat PID reuse, and marks the entire
 * scan unknown if any candidate evidence is incomplete or contradictory. */
export async function scanCodexRemoteTuisMac(
  sockPath: string,
  opts: {
    runner?: CodexMacCommandRunner;
    deadlineMs?: number;
    outputMaxBytes?: number;
    /** null means an explicit override exists but could not be mapped safely. */
    configuredExecutable?: CodexMacConfiguredExecutable | null;
  } = {},
): Promise<CodexTuiScan> {
  const runner = opts.runner ?? runBoundedMacCommand;
  const deadline = Date.now() + Math.max(100, Math.min(opts.deadlineMs ?? CODEX_MAC_SCAN_DEADLINE_MS, 5_000));
  let outputRemaining = Math.max(4_096, Math.min(opts.outputMaxBytes ?? CODEX_MAC_SCAN_OUTPUT_MAX_BYTES, 4 * 1024 * 1024));
  const unavailable = (): CodexTuiScan => ({ ...emptyCodexTuiScan(), source: 'darwin' });
  if (opts.configuredExecutable === null) return unavailable();
  const configured = opts.configuredExecutable;
  const run = async (executable: string, args: readonly string[], cap: number): Promise<CodexMacCommandResult | undefined> => {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs < 50 || outputRemaining <= 0) return undefined;
    const maxOutputBytes = Math.min(cap, outputRemaining);
    const result = await runner(executable, args, { timeoutMs, maxOutputBytes });
    outputRemaining -= Buffer.byteLength(result.stdout);
    if (result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded) return undefined;
    return result;
  };

  const initialIdentity = await run(CODEX_MAC_PS_PATH, ['-ww', '-axo', 'pid=,lstart=,comm='], 256 * 1024);
  if (!initialIdentity) return unavailable();
  const identities = parseMacPsIdentities(initialIdentity.stdout, configured);
  if (!identities.trustworthy) return unavailable();
  if (identities.identities.length === 0) {
    return {
      ...emptyCodexTuiScan(),
      source: 'darwin',
      processScanAvailable: true,
      socketDiagAvailable: true,
    };
  }

  const possiblePids = identities.identities.map((candidate) => candidate.pid).join(',');
  const initialArgs = await run(CODEX_MAC_PS_PATH, ['-ww', '-p', possiblePids, '-o', 'pid=,args='], 256 * 1024);
  if (!initialArgs) return unavailable();
  const parsed = qualifyMacPsCandidates(identities.identities, initialArgs.stdout, sockPath, configured);
  if (!parsed.trustworthy) return unavailable();
  if (parsed.candidates.length === 0) {
    return {
      ...emptyCodexTuiScan(),
      source: 'darwin',
      processScanAvailable: true,
      socketDiagAvailable: true,
    };
  }

  const pids = parsed.candidates.map((candidate) => candidate.pid).join(',');
  const [cwdResult, socketResult] = await Promise.all([
    run(CODEX_MAC_LSOF_PATH, ['-nP', '-a', '-p', pids, '-d', 'cwd', '-F', 'pfn'], 64 * 1024),
    run(CODEX_MAC_LSOF_PATH, ['-nP', '-a', '-p', pids, '-U', '-F', 'pfn'], 192 * 1024),
  ]);
  if (!cwdResult || !socketResult) return unavailable();
  const finalIdentity = await run(CODEX_MAC_PS_PATH, ['-ww', '-p', pids, '-o', 'pid=,lstart=,comm='], 64 * 1024);
  const finalArgs = await run(CODEX_MAC_PS_PATH, ['-ww', '-p', pids, '-o', 'pid=,args='], 128 * 1024);
  if (!finalIdentity || !finalArgs) return unavailable();
  const finalIdentities = parseMacPsIdentities(finalIdentity.stdout, configured);
  if (!finalIdentities.trustworthy || finalIdentities.identities.length !== parsed.candidates.length) return unavailable();
  const finalParsed = qualifyMacPsCandidates(finalIdentities.identities, finalArgs.stdout, sockPath, configured);
  if (!finalParsed.trustworthy || finalParsed.candidates.length !== parsed.candidates.length) return unavailable();
  const finalByPid = new Map(finalParsed.candidates.map((candidate) => [candidate.pid, candidate] as const));
  const cwdByPid = parseLsofFields(cwdResult.stdout);
  const socketsByPid = parseLsofFields(socketResult.stdout);
  const ours = normalizeCodexRemote(sockPath);

  const scan: CodexTuiScan = {
    ...emptyCodexTuiScan(),
    source: 'darwin',
    processScanAvailable: true,
    socketDiagAvailable: true,
  };
  for (const candidate of parsed.candidates) {
    const final = finalByPid.get(candidate.pid);
    if (!final || final.startToken !== candidate.startToken || final.executable !== candidate.executable
        || final.rawArgs !== candidate.rawArgs) return unavailable();
    const cwdRows = cwdByPid.get(candidate.pid)?.filter((row) => row.fd === 'cwd') ?? [];
    if (cwdRows.length !== 1 || !cwdRows[0]?.name.startsWith('/')) return unavailable();
    const cwd = normalizeCodexRemote(cwdRows[0]!.name);
    if (!cwd) return unavailable();
    const observedSocketPaths = [...new Set(
      (socketsByPid.get(candidate.pid) ?? [])
        .map((row) => lsofSocketPath(row.name))
        .filter((path): path is string => !!path),
    )];
    if (observedSocketPaths.length > 32) return unavailable();
    const socketPaths = observedSocketPaths;
    const hasOurs = !!ours && socketPaths.includes(ours);
    const otherCodexSockets = socketPaths.filter((path) => path !== ours && /app-server-control\.sock$/.test(path));
    let proof: CodexSocketProof = 'unknown';
    if (hasOurs && otherCodexSockets.length === 0 && candidate.facts.remoteMatch !== 'other') {
      proof = 'shared';
    } else if (!hasOurs && otherCodexSockets.length > 0 && candidate.facts.remoteMatch !== 'ours') {
      proof = 'private';
    }
    addMacCandidate(scan, {
      pid: candidate.pid,
      ...(candidate.facts.threadIds.length ? { threadIds: candidate.facts.threadIds } : {}),
      cwd,
      startedAtMs: candidate.startedAtMs,
      startToken: candidate.startToken,
      argv: candidate.argv,
      socketPaths,
      proof,
    });
  }
  return scan;
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
  // The macOS proof is deliberately async and deadline-bound. This legacy synchronous surface is
  // Linux-only so no caller can accidentally run Linux `ss` or a blocking macOS process scan.
  if (process.platform !== 'linux') {
    return { ...emptyCodexTuiScan(), ...(process.platform === 'darwin' ? { source: 'darwin' as const } : {}) };
  }
  const socketDiagRaw = socketProbe();
  return scanCodexRemoteTuisWithSocketDiag(sockPath, procRoot, nowMs, socketDiagRaw);
}

/** Async equivalent for recurring watch polls. The socket probe is awaited before the same
 * deterministic /proc scan is performed, so no synchronous `ss` process can block the broker. */
export async function scanCodexRemoteTuisAsync(
  sockPath: string,
  procRoot = '/proc',
  nowMs = Date.now(),
  opts: {
    socketProbe?: AsyncSocketProbe;
    platform?: NodeJS.Platform;
    macRunner?: CodexMacCommandRunner;
    macConfiguredExecutable?: CodexMacConfiguredExecutable | null;
    deadlineMs?: number;
    outputMaxBytes?: number;
  } = {},
): Promise<CodexTuiScan> {
  const platform = opts.platform ?? process.platform;
  if (platform === 'darwin') {
    return scanCodexRemoteTuisMac(sockPath, {
      ...(opts.macRunner ? { runner: opts.macRunner } : {}),
      ...(opts.macConfiguredExecutable !== undefined
        ? { configuredExecutable: opts.macConfiguredExecutable }
        : {}),
      ...(opts.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {}),
      ...(opts.outputMaxBytes !== undefined ? { outputMaxBytes: opts.outputMaxBytes } : {}),
    });
  }
  if (platform !== 'linux') return emptyCodexTuiScan();
  let socketDiagRaw: string | undefined;
  try {
    socketDiagRaw = await (opts.socketProbe ?? runCodexSocketDiagAsync)();
  } catch {
    socketDiagRaw = undefined;
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
    source: 'linux',
  };
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

function cachePresenceScan(
  key: string,
  value: { at: number; scan: CodexTuiScan },
  platform: NodeJS.Platform,
): void {
  if (platform === 'darwin' && !cache.has(key)) {
    let oldestMacKey: string | undefined;
    let macKeyCount = 0;
    for (const candidate of cache.keys()) {
      if (!candidate.startsWith('darwin\0')) continue;
      oldestMacKey ??= candidate;
      macKeyCount += 1;
    }
    if (macKeyCount >= CODEX_MAC_SCAN_CACHE_KEY_LIMIT && oldestMacKey) cache.delete(oldestMacKey);
  }
  cache.set(key, value);
}

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

function codexTuiCacheKey(
  sockPath: string,
  root: string,
  platform: NodeJS.Platform,
  macConfiguredExecutable?: CodexMacConfiguredExecutable | null,
): string {
  const identity = macConfiguredExecutable === null
    ? '<unmappable>'
    : macConfiguredExecutable
      ? `${macConfiguredExecutable.invocationPath}\0${macConfiguredExecutable.resolvedPath}`
      : '<default>';
  return `${platform}\0${sockPath}\0${root}\0${identity}`;
}

export function codexAttachedTuis(sockPath: string, procRoot?: string): CodexTuiScan {
  const root = procRoot ?? process.env.COSYNCING_CODEX_PROC_ROOT?.trim() ?? '/proc';
  if (process.platform !== 'linux') {
    return { ...emptyCodexTuiScan(), ...(process.platform === 'darwin' ? { source: 'darwin' as const } : {}) };
  }
  const key = codexTuiCacheKey(sockPath, root, process.platform);
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < CODEX_TUI_PRESENCE_TTL_MS) return hit.scan;
  const scan = scanCodexRemoteTuis(sockPath, root, now);
  cachePresenceScan(key, { at: now, scan }, process.platform);
  return scan;
}

/** TTL-cached async presence refresh. Calls for the same daemon/proc root share one in-flight
 * scan, and a completed result is reused for the normal presence TTL. */
export function codexAttachedTuisAsync(
  sockPath: string,
  procRoot?: string,
  opts: {
    socketProbe?: AsyncSocketProbe;
    platform?: NodeJS.Platform;
    macRunner?: CodexMacCommandRunner;
    macConfiguredExecutable?: CodexMacConfiguredExecutable | null;
    deadlineMs?: number;
    outputMaxBytes?: number;
    /** Restore arbitration bypasses cached absence, while still coalescing in-flight work. */
    fresh?: boolean;
  } = {},
): Promise<CodexTuiScan> {
  const root = procRoot ?? process.env.COSYNCING_CODEX_PROC_ROOT?.trim() ?? '/proc';
  const platform = opts.platform ?? process.platform;
  if (!codexTuiPresenceSupported(platform)) return Promise.resolve(emptyCodexTuiScan());
  const key = codexTuiCacheKey(sockPath, root, platform, opts.macConfiguredExecutable);
  const now = Date.now();
  const hit = cache.get(key);
  if (!opts.fresh && hit && now - hit.at < CODEX_TUI_PRESENCE_TTL_MS) return Promise.resolve(hit.scan);
  const inFlight = asyncRefreshes.get(key);
  if (inFlight) return inFlight;
  if (platform === 'darwin') {
    const macRefreshCount = [...asyncRefreshes.keys()].filter((candidate) => candidate.startsWith('darwin\0')).length;
    if (macRefreshCount >= CODEX_MAC_SCAN_CACHE_KEY_LIMIT) {
      return Promise.resolve({ ...emptyCodexTuiScan(), source: 'darwin' });
    }
  }

  const generation = cacheGeneration;
  const refresh = (async () => {
    const scan = await scanCodexRemoteTuisAsync(sockPath, root, Date.now(), opts);
    if (generation === cacheGeneration) cachePresenceScan(key, { at: Date.now(), scan }, platform);
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
