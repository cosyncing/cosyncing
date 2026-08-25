import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, posix, win32 } from 'node:path';

const WINDOWS_BATCH_EXTENSIONS = new Set(['.bat', '.cmd', '.com']);
const WINDOWS_EXECUTABLE_EXTENSIONS = new Set(['.bat', '.cmd', '.com', '.exe']);
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const INVALID_COMMAND_INPUT = /[\0\r\n]/;

export type ResolvedInvocation =
  | {
    kind: 'native';
    executable: string;
    prefixArgs: readonly string[];
    originalPath: string;
  }
  | {
    kind: 'batch';
    cmdExe: string;
    script: string;
    prefixArgs: readonly ['/d', '/s', '/v:off', '/c'];
    originalPath: string;
  };

export interface InvocationResolutionOptions {
  platform?: string;
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  /** Test seam for Windows-shaped fixtures exercised on a non-Windows host. */
  isExecutableFile?: (path: string) => boolean;
  /** Test seam matching `isExecutableFile`; production uses `realpathSync`. */
  canonicalize?: (path: string) => string;
}

function envValue(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  windows: boolean,
): string | undefined {
  if (!windows) return env[key];
  const wanted = key.toLowerCase();
  for (const candidate of Object.keys(env).sort()) {
    if (candidate.toLowerCase() === wanted) return env[candidate];
  }
  return undefined;
}

function executableFile(path: string, windows: boolean): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (!windows) accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

function normalizedPathExtensions(value: string | undefined): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of (value === undefined ? DEFAULT_PATHEXT : value).split(';')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const extension = `${trimmed.startsWith('.') ? '' : '.'}${trimmed}`.toLowerCase();
    if (!WINDOWS_EXECUTABLE_EXTENSIONS.has(extension)) continue;
    if (seen.has(extension)) continue;
    seen.add(extension);
    result.push(extension);
  }
  return result;
}

function cmdExePath(env: Readonly<Record<string, string | undefined>>): string {
  const configured = envValue(env, 'ComSpec', true);
  if (configured && !INVALID_COMMAND_INPUT.test(configured)) return configured;
  const systemRoot = envValue(env, 'SystemRoot', true);
  return systemRoot && !INVALID_COMMAND_INPUT.test(systemRoot)
    ? win32.join(systemRoot, 'System32', 'cmd.exe')
    : 'cmd.exe';
}

/**
 * Classify an ALREADY-RESOLVED executable path exactly as {@link resolveInvocation} classifies it.
 *
 * For callers that carry only a resolved path — a {@link SetupDiagnosisContext} hands out
 * `originalPath`, not the invocation — so they can recover how the file must be launched without
 * re-resolving it and, above all, without inferring the launcher's nature from its contents. A
 * Windows `.cmd` shim has no shebang and is still emphatically a Node launcher; absence of `#!` is
 * a POSIX signal only.
 */
export function resolvedInvocationKind(
  path: string,
  platform: string = process.platform,
): ResolvedInvocation['kind'] {
  return platform === 'win32' && WINDOWS_BATCH_EXTENSIONS.has(win32.extname(path).toLowerCase())
    ? 'batch'
    : 'native';
}

function resolvedKind(
  path: string,
  windows: boolean,
  env: Readonly<Record<string, string | undefined>>,
): ResolvedInvocation {
  if (resolvedInvocationKind(path, windows ? 'win32' : 'posix') === 'batch') {
    return {
      kind: 'batch',
      cmdExe: cmdExePath(env),
      script: path,
      prefixArgs: ['/d', '/s', '/v:off', '/c'],
      originalPath: path,
    };
  }
  return { kind: 'native', executable: path, prefixArgs: [], originalPath: path };
}

/** Resolve an executable once, preserving how that exact file must be invoked. */
export function resolveInvocation(
  command: string,
  options: InvocationResolutionOptions = {},
): ResolvedInvocation | undefined {
  if (!command || INVALID_COMMAND_INPUT.test(command)) return undefined;
  const platform = options.platform ?? process.platform;
  const windows = platform === 'win32';
  const pathApi = windows ? win32 : posix;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const isFile = options.isExecutableFile ?? ((path: string) => executableFile(path, windows));
  const canonicalize = options.canonicalize ?? canonical;
  const pathBearing = command.includes('/') || (windows && command.includes('\\'));
  const pathExtensions = windows
    ? normalizedPathExtensions(envValue(env, 'PATHEXT', true))
    : [''];

  const candidates = (base: string): readonly string[] => {
    if (!windows) return [base];
    const extension = pathApi.extname(base).toLowerCase();
    if (extension) return WINDOWS_EXECUTABLE_EXTENSIONS.has(extension) ? [base] : [];
    return pathExtensions.map((extension) => `${base}${extension}`);
  };
  const accept = (base: string): ResolvedInvocation | undefined => {
    for (const candidate of candidates(base)) {
      if (!isFile(candidate)) continue;
      const path = canonicalize(candidate);
      return resolvedKind(path, windows, env);
    }
    return undefined;
  };

  if (pathBearing || pathApi.isAbsolute(command)) {
    return accept(pathApi.isAbsolute(command) ? command : pathApi.resolve(cwd, command));
  }
  const pathValue = envValue(env, 'PATH', windows) ?? '';
  const pathDelimiter = windows ? ';' : delimiter;
  for (const root of pathValue.split(pathDelimiter)) {
    // Empty entries are ignored rather than implicitly searching cwd.
    if (!root) continue;
    const found = accept(pathApi.join(root, command));
    if (found) return found;
  }
  return undefined;
}

function validateArguments(args: readonly string[]): void {
  if (args.some((arg) => INVALID_COMMAND_INPUT.test(arg))) {
    throw new TypeError('Invocation arguments must not contain NUL, CR, or LF');
  }
}

/** Quote one argv element through both cmd.exe and a .cmd/.bat script parser. */
function escapeCmdArgument(input: string, doubleEscape: boolean): string {
  if (!input.length) return '""';
  let result = input;
  if (/[ \t\v"]/.test(input)) {
    result = '"';
    for (let index = 0; index <= input.length; index += 1) {
      let slashCount = 0;
      while (input[index] === '\\') {
        index += 1;
        slashCount += 1;
      }
      if (index === input.length) {
        result += '\\'.repeat(slashCount * 2);
        break;
      }
      if (input[index] === '"') {
        result += '\\'.repeat(slashCount * 2 + 1);
      } else {
        result += '\\'.repeat(slashCount);
      }
      result += input[index];
    }
    result += '"';
  }
  result = result.replace(/[ !%^&()<>|"]/g, '^$&');
  return doubleEscape ? result.replace(/[ !%^&()<>|"]/g, '^$&') : result;
}

function batchCommandLine(invocation: Extract<ResolvedInvocation, { kind: 'batch' }>, args: readonly string[]): string {
  const doubleEscape = /\.(?:bat|cmd)$/i.test(invocation.script);
  return [
    escapeCmdArgument(invocation.script, false),
    ...args.map((arg) => escapeCmdArgument(arg, doubleEscape)),
  ].join(' ');
}

function preparedCommand(invocation: ResolvedInvocation, args: readonly string[]): {
  executable: string;
  args: string[];
  windowsVerbatimArguments: boolean;
} {
  validateArguments(args);
  if (invocation.kind === 'native') {
    return {
      executable: invocation.executable,
      args: [...invocation.prefixArgs, ...args],
      windowsVerbatimArguments: false,
    };
  }
  return {
    executable: invocation.cmdExe,
    args: [...invocation.prefixArgs, batchCommandLine(invocation, args)],
    windowsVerbatimArguments: true,
  };
}

function normalizedSpawnEnvironment<T extends Readonly<Record<string, string | undefined>> | undefined>(env: T): T {
  if (process.platform !== 'win32' || !env) return env;
  const result: Record<string, string | undefined> = {};
  const seen = new Set<string>();
  for (const key of Object.keys(env).sort()) {
    const normalized = key.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result[key] = env[key];
  }
  return result as T;
}

/**
 * Spawn a typed invocation without accepting a caller-composed command string.
 * Batch command construction stays private to this reviewed Windows boundary.
 */
export function spawnResolvedInvocation(
  invocation: ResolvedInvocation,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  const prepared = preparedCommand(invocation, args);
  return spawn(prepared.executable, prepared.args, {
    ...options,
    ...(options.env ? { env: normalizedSpawnEnvironment(options.env) } : {}),
    shell: false,
    windowsVerbatimArguments: prepared.windowsVerbatimArguments,
  });
}

/**
 * Synchronous form of {@link spawnResolvedInvocation}, for short explicitly bounded probes.
 *
 * A `--version` probe of a Windows `.cmd` launcher has to travel this path rather than
 * `spawnSync(script, args)`: the batch encoding is what makes the argv safe, and it is deliberately
 * private to this boundary.
 */
export function spawnSyncResolvedInvocation(
  invocation: ResolvedInvocation,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
  const prepared = preparedCommand(invocation, args);
  return spawnSync(prepared.executable, prepared.args, {
    ...options,
    ...(options.env ? { env: normalizedSpawnEnvironment(options.env) } : {}),
    shell: false,
    windowsVerbatimArguments: prepared.windowsVerbatimArguments,
  });
}

/** Bun equivalent of {@link spawnResolvedInvocation}, sharing the same private cmd.exe encoding. */
export function bunSpawnResolvedInvocation<
  const In extends Bun.SpawnOptions.Writable = 'ignore',
  const Out extends Bun.SpawnOptions.Readable = 'pipe',
  const Err extends Bun.SpawnOptions.Readable = 'inherit',
>(
  invocation: ResolvedInvocation,
  args: readonly string[],
  options: Bun.SpawnOptions.SpawnOptions<In, Out, Err>,
): Bun.Subprocess<In, Out, Err> {
  const prepared = preparedCommand(invocation, args);
  return Bun.spawn([prepared.executable, ...prepared.args], {
    ...options,
    ...(options.env ? { env: normalizedSpawnEnvironment(options.env) } : {}),
    windowsVerbatimArguments: prepared.windowsVerbatimArguments,
  });
}

/** Synchronous Bun form for short, explicitly bounded probes such as `--version`. */
export function bunSpawnSyncResolvedInvocation<
  const In extends Bun.SpawnOptions.Writable = 'ignore',
  const Out extends Bun.SpawnOptions.Readable = 'pipe',
  const Err extends Bun.SpawnOptions.Readable = 'pipe',
>(
  invocation: ResolvedInvocation,
  args: readonly string[],
  options: Bun.SpawnOptions.SpawnSyncOptions<In, Out, Err>,
): Bun.SyncSubprocess<Out, Err> {
  const prepared = preparedCommand(invocation, args);
  return Bun.spawnSync([prepared.executable, ...prepared.args], {
    ...options,
    ...(options.env ? { env: normalizedSpawnEnvironment(options.env) } : {}),
    windowsVerbatimArguments: prepared.windowsVerbatimArguments,
  });
}
