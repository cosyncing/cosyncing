import {
  accessSync,
  constants,
  lstatSync,
  opendirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, parse, posix, win32 } from 'node:path';
import { connect } from 'node:net';
import { resolveInvocation, spawnResolvedInvocation, windowsNativeMachineArchitecture } from '@cosyncing/adapter-api';
import type {
  SetupCommandProbe,
  SetupDiagnosisContext,
  SetupHttpProbe,
  SetupPathInspection,
} from '@cosyncing/adapter-api';

const COMMAND_OUTPUT_LIMIT = 64 * 1024;
const HTTP_BODY_LIMIT = 256 * 1024;
/**
 * The most this context will ever hold in memory for one response, whatever a caller asks for.
 *
 * `maxBytes` is a caller's *request* for a wider ceiling, not a grant of one. Without this, a
 * caller passing `Infinity` — or a plain arithmetic slip producing `NaN` — would remove the
 * capability boundary altogether and let a hostile or broken endpoint grow the process until it
 * died. The largest legitimate reader is the session roster, and this is set to exactly what that
 * reader asks for, so raising it is a deliberate act rather than a side effect of a caller's typo.
 */
const HTTP_BODY_HARD_LIMIT = 16 * 1024 * 1024;

/**
 * Resolve the byte ceiling actually enforced for one response.
 *
 * Anything that is not a finite, positive byte count — `Infinity`, `NaN`, zero, a negative — is not
 * a *smaller* request but a nonsense one, so it collapses to the probe default rather than to the
 * maximum. A caller that has lost track of its own arithmetic gets the conservative ceiling.
 */
function bodyCeiling(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested < 1) return HTTP_BODY_LIMIT;
  return Math.min(Math.floor(requested), HTTP_BODY_HARD_LIMIT);
}

function boundedAppend(current: string, chunk: Buffer | string, limit: number): string {
  if (current.length >= limit) return current;
  return `${current}${String(chunk).slice(0, limit - current.length)}`;
}

function inspectPath(path: string, displayPath: (value: string) => string): SetupPathInspection {
  const shown = displayPath(path);
  try {
    const stat = lstatSync(path);
    let readable = true;
    try { accessSync(path, constants.R_OK); } catch { readable = false; }
    if (stat.isFile()) return { status: readable ? 'file' : 'unreadable', readable, displayPath: shown };
    if (stat.isDirectory()) return { status: readable ? 'directory' : 'unreadable', readable, displayPath: shown };
    if (stat.isSocket()) return { status: readable ? 'socket' : 'unreadable', readable, displayPath: shown };
    return { status: 'other', readable, displayPath: shown };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      status: code === 'ENOENT' ? 'missing' : 'unreadable',
      readable: false,
      displayPath: shown,
    };
  }
}

function readText(path: string, maxBytes = 256 * 1024): ReturnType<SetupDiagnosisContext['readText']> {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return { ok: false, reason: 'unreadable' };
    if (stat.size > maxBytes) return { ok: false, reason: 'too-large' };
    return { ok: true, text: readFileSync(path, 'utf8') };
  } catch (error) {
    return {
      ok: false,
      reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable',
    };
  }
}

function readPackageVersion(executablePath: string, packageNames: readonly string[]): string | undefined {
  let current: string;
  try { current = dirname(realpathSync(executablePath)); } catch { current = dirname(executablePath); }
  const root = parse(current).root;
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = join(current, 'package.json');
    const read = readText(candidate, 128 * 1024);
    if (read.ok) {
      try {
        const value = JSON.parse(read.text) as { name?: unknown; version?: unknown };
        if (typeof value.name === 'string' && packageNames.includes(value.name)
            && typeof value.version === 'string') {
          return value.version;
        }
      } catch {
        // Keep walking: wrappers can live below an unrelated package.json.
      }
    }
    if (current === root) break;
    current = dirname(current);
  }
  return undefined;
}

async function runReadOnly(
  executablePath: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
  timeoutMs = 5_000,
): Promise<SetupCommandProbe> {
  const pathApi = platform === 'win32' ? win32 : posix;
  if (!pathApi.isAbsolute(executablePath) || args.some((arg) => /[\0\r\n]/.test(arg))) {
    return { status: 'unavailable', stdout: '', stderr: '' };
  }
  const invocation = resolveInvocation(executablePath, { env, platform });
  if (!invocation) return { status: 'unavailable', stdout: '', stderr: '' };
  return new Promise((resolveProbe) => {
    let stdout = '';
    let stderr = '';
    let finished = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child;
    try {
      child = spawnResolvedInvocation(invocation, args, {
        env: { ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: platform === 'win32',
      });
    } catch {
      resolveProbe({ status: 'unavailable', stdout: '', stderr: '' });
      return;
    }
    const settle = (result: SetupCommandProbe): void => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      resolveProbe(result);
    };
    child.stdout?.on('data', (chunk) => { stdout = boundedAppend(stdout, chunk, COMMAND_OUTPUT_LIMIT); });
    child.stderr?.on('data', (chunk) => { stderr = boundedAppend(stderr, chunk, COMMAND_OUTPUT_LIMIT); });
    child.once('error', () => settle({ status: 'unavailable', stdout, stderr }));
    child.once('close', (code) => settle({
      status: timedOut ? 'timeout' : code === 0 ? 'ok' : 'nonzero',
      ...(typeof code === 'number' ? { exitCode: code } : {}),
      stdout,
      stderr,
    }));
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* close/error resolves the bounded probe */ }
    }, Math.max(100, timeoutMs));
    timer.unref?.();
  });
}

async function boundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<string | undefined> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch {
    return undefined;
  }
}

async function fetchJson(
  url: string,
  headers: Readonly<Record<string, string>> = {},
  timeoutMs = 3_000,
  maxBytes?: number,
): Promise<SetupHttpProbe> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { status: 'unreachable' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { status: 'unreachable' };
  const ceiling = bodyCeiling(maxBytes);
  try {
    const response = await fetch(parsed, {
      method: 'GET',
      headers: { ...headers },
      redirect: 'error',
      signal: AbortSignal.timeout(Math.max(100, timeoutMs)),
    });
    // A declared length only ever ends the read early. A missing, malformed, or lying header
    // decides nothing — the streaming ceiling below is what actually bounds the read.
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > ceiling) return { status: 'invalid-response', statusCode: response.status };
    const body = await boundedResponseText(response, ceiling);
    if (body === undefined) return { status: 'invalid-response', statusCode: response.status };
    let json: unknown;
    try { json = body ? JSON.parse(body) : undefined; } catch {
      return { status: 'invalid-response', statusCode: response.status };
    }
    return {
      status: response.ok ? 'ok' : 'http-error',
      statusCode: response.status,
      ...(json !== undefined ? { json } : {}),
    };
  } catch {
    return { status: 'unreachable' };
  }
}

async function probeTcp(host: string, port: number, timeoutMs = 1_000): Promise<'open' | 'closed' | 'unknown'> {
  if (!host || !Number.isSafeInteger(port) || port < 1 || port > 65_535) return 'unknown';
  return new Promise((resolveProbe) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const socket = connect({ host, port });
    const finish = (value: 'open' | 'closed' | 'unknown'): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      resolveProbe(value);
    };
    socket.once('connect', () => finish('open'));
    socket.once('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      finish(code === 'ECONNREFUSED' || code === 'ENOENT' ? 'closed' : 'unknown');
    });
    timer = setTimeout(() => finish('unknown'), Math.max(100, timeoutMs));
    timer.unref?.();
  });
}

export interface SetupDiagnosisContextOptions {
  env?: Readonly<Record<string, string | undefined>>;
  platform?: string;
  arch?: string;
  homeDir?: string;
}

/** The most directory entries one listing will ever return, whatever a caller asks for. */
const DIRECTORY_LISTING_HARD_LIMIT = 256;

function listDirectory(
  path: string,
  maxEntries?: number,
): ReturnType<SetupDiagnosisContext['listDirectory']> {
  const requested = typeof maxEntries === 'number' && Number.isFinite(maxEntries) && maxEntries > 0
    ? Math.floor(maxEntries)
    : DIRECTORY_LISTING_HARD_LIMIT;
  const ceiling = Math.min(requested, DIRECTORY_LISTING_HARD_LIMIT);
  // Iterate through the directory handle instead of materializing the whole
  // listing: a directory with a million entries costs the ceiling, not the
  // directory. The entry that would exceed the ceiling proves truncation.
  let dir;
  try {
    dir = opendirSync(path);
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code;
    if (code === 'ENOENT') return { ok: false, reason: 'missing' };
    if (code === 'ENOTDIR') return { ok: false, reason: 'not-directory' };
    return { ok: false, reason: 'unreadable' };
  }
  const names: string[] = [];
  let truncated = false;
  try {
    for (;;) {
      const entry = dir.readSync();
      if (entry === null) break;
      if (names.length >= ceiling) {
        truncated = true;
        break;
      }
      names.push(entry.name);
    }
  } finally {
    dir.closeSync();
  }
  names.sort();
  return { ok: true, names, truncated };
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user — still alive.
    return (error as { code?: string } | undefined)?.code === 'EPERM';
  }
}

export function createSetupDiagnosisContext(options: SetupDiagnosisContextOptions = {}): SetupDiagnosisContext {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathApi = platform === 'win32' ? win32 : posix;
  const homeDir = options.homeDir ?? homedir();
  const displayPath = (value: string): string => {
    const absolute = pathApi.isAbsolute(value) ? pathApi.resolve(value) : value;
    const fromHome = pathApi.isAbsolute(absolute) ? pathApi.relative(homeDir, absolute) : undefined;
    if (fromHome === '') return '~';
    if (fromHome !== undefined && fromHome !== '..' && !fromHome.startsWith(`..${pathApi.sep}`)
        && !pathApi.isAbsolute(fromHome)) {
      return `~/${fromHome.split(pathApi.sep).join('/')}`;
    }
    return absolute;
  };
  return {
    effects: 'forbidden',
    platform,
    arch: options.arch ?? process.arch,
    env,
    homeDir,
    resolveExecutable: (command) => resolveInvocation(command, { env, platform })?.originalPath,
    inspectPath: (path) => inspectPath(path, displayPath),
    readText,
    readPackageVersion,
    runReadOnly: (path, args, timeoutMs) => runReadOnly(path, args, env, platform, timeoutMs),
    fetchJson,
    probeTcp,
    listDirectory,
    processAlive,
    currentUid: () => (typeof process.getuid === 'function' ? String(process.getuid()) : undefined),
    windowsMachineArchitecture: () => windowsNativeMachineArchitecture(),
    displayPath,
  };
}

/** Keep diagnostic evidence compact when a wrapper path is outside the user's home. */
export function executableEvidence(path: string, context: SetupDiagnosisContext): string {
  const displayed = context.displayPath(path);
  return displayed === path && path.startsWith('/') ? `${dirname(path)}/${basename(path)}` : displayed;
}
