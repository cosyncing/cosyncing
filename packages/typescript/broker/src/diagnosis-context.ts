import { spawn } from 'node:child_process';
import {
  accessSync,
  constants,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { connect } from 'node:net';
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

function executable(path: string): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveExecutable(command: string, env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (!command || /[\0\r\n]/.test(command)) return undefined;
  if (command.includes('/')) {
    const target = isAbsolute(command) ? command : resolve(command);
    if (!executable(target)) return undefined;
    try { return realpathSync(target); } catch { return target; }
  }
  for (const root of (env.PATH ?? '').split(':').filter(Boolean)) {
    const target = join(root, command);
    if (!executable(target)) continue;
    try { return realpathSync(target); } catch { return target; }
  }
  return undefined;
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
  timeoutMs = 5_000,
): Promise<SetupCommandProbe> {
  if (!isAbsolute(executablePath) || args.some((arg) => /[\0\r\n]/.test(arg))) {
    return { status: 'unavailable', stdout: '', stderr: '' };
  }
  return new Promise((resolveProbe) => {
    let stdout = '';
    let stderr = '';
    let finished = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child;
    try {
      child = spawn(executablePath, [...args], {
        env: { ...env },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
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

export function createSetupDiagnosisContext(options: SetupDiagnosisContextOptions = {}): SetupDiagnosisContext {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const displayPath = (value: string): string => {
    const absolute = isAbsolute(value) ? resolve(value) : value;
    if (absolute === homeDir) return '~';
    if (absolute.startsWith(`${homeDir}/`)) return `~/${absolute.slice(homeDir.length + 1)}`;
    return absolute;
  };
  return {
    effects: 'forbidden',
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch,
    env,
    homeDir,
    resolveExecutable: (command) => resolveExecutable(command, env),
    inspectPath: (path) => inspectPath(path, displayPath),
    readText,
    readPackageVersion,
    runReadOnly: (path, args, timeoutMs) => runReadOnly(path, args, env, timeoutMs),
    fetchJson,
    probeTcp,
    displayPath,
  };
}

/** Keep diagnostic evidence compact when a wrapper path is outside the user's home. */
export function executableEvidence(path: string, context: SetupDiagnosisContext): string {
  const displayed = context.displayPath(path);
  return displayed === path && path.startsWith('/') ? `${dirname(path)}/${basename(path)}` : displayed;
}
