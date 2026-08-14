import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';

const OUTPUT_LIMIT = 4_096;
const ACTIVE_PORT_LIMIT = 1_024;
const MAX_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_TERMINATION_TIMEOUT_MS = 1_000;
const MAX_TERMINATION_TIMEOUT_MS = 5_000;
const DEFAULT_OUTPUT_DRAIN_TIMEOUT_MS = 1_000;
const MAX_OUTPUT_DRAIN_TIMEOUT_MS = 5_000;

export interface CandidateBrowserProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals | number): void;
}

export interface CandidateBrowserStartupFailure {
  executable: string;
  attempt: number;
  maxAttempts: number;
  elapsedMs: number;
  browserExitState: {
    beforeCleanup: 'running' | number | 'not-spawned';
    afterCleanup: number | 'running' | 'not-spawned';
  };
  cleanup: BrowserCleanupEvidence;
  devToolsActivePort: {
    existed: boolean;
    contents: string | null;
    readError?: string;
  };
  stdout: string;
  stderr: string;
  failure: string;
}

export interface CandidateBrowserSession {
  readonly socket: WebSocket;
  readonly endpoint: string;
  readonly profile: string;
  readonly browser: CandidateBrowserProcess;
  cleanup(): Promise<void>;
}

export interface CandidateBrowserStartupOptions {
  executable: string;
  profileRoot: string;
  maxAttempts?: number;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  terminationTimeoutMs?: number;
  outputDrainTimeoutMs?: number;
  spawn?: (executable: string, profile: string) => CandidateBrowserProcess;
  connect?: (endpoint: string, timeoutMs: number) => Promise<WebSocket>;
  drainOutput?: (stream: ReadableStream<Uint8Array>) => Promise<string>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  reportFailure?: (failure: CandidateBrowserStartupFailure) => void;
}

export interface BrowserCleanupEvidence {
  gracefulTimedOut: boolean;
  forceKillSent: boolean;
  forceKillTimedOut: boolean;
  stdoutDrainTimedOut: boolean;
  stderrDrainTimedOut: boolean;
  errors: string[];
}

interface BrowserCleanupResult {
  afterCleanup: number | 'running' | 'not-spawned';
  stdout: string;
  stderr: string;
  evidence: BrowserCleanupEvidence;
}

type Settlement<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; error: unknown }
  | { status: 'timed-out' };

function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(-limit);
}

function boundedTimeout(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isFinite(selected) || selected < 1 || selected > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum}ms`);
  }
  return selected;
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<Settlement<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Settlement<T>>((resolveTimeout) => {
    timer = setTimeout(
      () => resolveTimeout({ status: 'timed-out' }),
      timeoutMs,
    );
  });
  const settlement: Promise<Settlement<T>> = promise.then(
    (value): Settlement<T> => ({ status: 'fulfilled', value }),
    (error): Settlement<T> => ({ status: 'rejected', error }),
  );
  const result = await Promise.race([settlement, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

async function drainOutput(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let tail = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    tail += decoder.decode(value, { stream: true });
    if (tail.length > 16_384) tail = tail.slice(-16_384);
  }
  tail += decoder.decode();
  return tail.slice(-16_384);
}

function spawnBrowser(
  executable: string,
  profile: string,
): CandidateBrowserProcess {
  return Bun.spawn([
    executable,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-features=Vulkan,VizDisplayCompositor',
    '--disable-dev-shm-usage',
    '--headless',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    '--window-size=1280,900',
    'about:blank',
  ], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function connectCdp(
  endpoint: string,
  timeoutMs: number,
): Promise<WebSocket> {
  const timeout = Math.max(1, Math.min(timeoutMs, 2_000));
  const version = await fetch(`${endpoint}/json/version`, {
    signal: AbortSignal.timeout(timeout),
  });
  if (!version.ok) throw new Error(`CDP version endpoint returned ${version.status}`);
  const targetResponse = await fetch(`${endpoint}/json/new?about:blank`, {
    method: 'PUT',
    signal: AbortSignal.timeout(timeout),
  });
  if (!targetResponse.ok) {
    throw new Error(`CDP target endpoint returned ${targetResponse.status}`);
  }
  const target = await targetResponse.json() as any;
  if (typeof target.webSocketDebuggerUrl !== 'string') {
    throw new Error('CDP target did not provide a WebSocket URL');
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolveOpen, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('candidate CDP socket timed out'));
    }, timeout);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolveOpen();
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      socket.close();
      reject(new Error('candidate CDP socket failed'));
    }, { once: true });
  });
  return socket;
}

function activePortEvidence(path: string): CandidateBrowserStartupFailure['devToolsActivePort'] {
  if (!existsSync(path)) return { existed: false, contents: null };
  try {
    return {
      existed: true,
      contents: bounded(readFileSync(path, 'utf8'), ACTIVE_PORT_LIMIT),
    };
  } catch (error) {
    return {
      existed: true,
      contents: null,
      readError: error instanceof Error ? error.message : String(error),
    };
  }
}

function cdpPort(evidence: CandidateBrowserStartupFailure['devToolsActivePort']): number | undefined {
  if (!evidence.contents) return undefined;
  const value = Number(evidence.contents.split(/\r?\n/, 1)[0]);
  return Number.isSafeInteger(value) && value >= 1 && value <= 65_535
    ? value
    : undefined;
}

function defaultReporter(failure: CandidateBrowserStartupFailure): void {
  console.error(
    `candidate parity browser startup failure: ${JSON.stringify(failure)}`,
  );
}

function settlementError(label: string, settlement: Settlement<unknown>): string | undefined {
  if (settlement.status === 'rejected') {
    const detail = settlement.error instanceof Error
      ? settlement.error.message
      : String(settlement.error);
    return `${label} failed: ${detail}`;
  }
  return settlement.status === 'timed-out' ? `${label} timed out` : undefined;
}

async function terminateAndDrain(
  browser: CandidateBrowserProcess,
  stdoutPromise: Promise<string>,
  stderrPromise: Promise<string>,
  terminationTimeoutMs: number,
  outputDrainTimeoutMs: number,
): Promise<{
  afterCleanup: number | 'running';
  stdout: string;
  stderr: string;
  evidence: BrowserCleanupEvidence;
}> {
  const errors: string[] = [];
  let observedExit = browser.exitCode;
  let gracefulTimedOut = false;
  let forceKillSent = false;
  let forceKillTimedOut = false;

  if (observedExit === null) {
    try {
      browser.kill('SIGTERM');
    } catch (error) {
      errors.push(`SIGTERM failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const graceful = await settleWithin(browser.exited, terminationTimeoutMs);
    if (graceful.status === 'fulfilled') observedExit = graceful.value;
    gracefulTimedOut = graceful.status === 'timed-out';
    const error = settlementError('browser SIGTERM exit wait', graceful);
    if (error && graceful.status !== 'timed-out') errors.push(error);
  }

  observedExit = browser.exitCode ?? observedExit;
  if (observedExit === null) {
    forceKillSent = true;
    try {
      browser.kill('SIGKILL');
    } catch (error) {
      errors.push(`SIGKILL failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const forced = await settleWithin(browser.exited, terminationTimeoutMs);
    if (forced.status === 'fulfilled') observedExit = forced.value;
    forceKillTimedOut = forced.status === 'timed-out';
    const error = settlementError('browser SIGKILL exit wait', forced);
    if (error) errors.push(error);
  }

  const [stdoutResult, stderrResult] = await Promise.all([
    settleWithin(stdoutPromise, outputDrainTimeoutMs),
    settleWithin(stderrPromise, outputDrainTimeoutMs),
  ]);
  const outputValue = (label: string, result: Settlement<string>): string => {
    if (result.status === 'fulfilled') return result.value;
    const error = settlementError(`${label} drain`, result)!;
    errors.push(error);
    return error;
  };
  const stdout = outputValue('stdout', stdoutResult);
  const stderr = outputValue('stderr', stderrResult);

  return {
    afterCleanup: browser.exitCode ?? observedExit ?? 'running',
    stdout,
    stderr,
    evidence: {
      gracefulTimedOut,
      forceKillSent,
      forceKillTimedOut,
      stdoutDrainTimedOut: stdoutResult.status === 'timed-out',
      stderrDrainTimedOut: stderrResult.status === 'timed-out',
      errors,
    },
  };
}

export async function launchCandidateParityBrowser(
  options: CandidateBrowserStartupOptions,
): Promise<CandidateBrowserSession> {
  const maxAttempts = options.maxAttempts ?? 2;
  if (maxAttempts < 1 || maxAttempts > 2) {
    throw new Error('candidate parity browser startup allows one retry at most');
  }
  const startupTimeoutMs = boundedTimeout(
    options.startupTimeoutMs,
    20_000,
    MAX_STARTUP_TIMEOUT_MS,
    'startupTimeoutMs',
  );
  const pollIntervalMs = boundedTimeout(
    options.pollIntervalMs,
    100,
    1_000,
    'pollIntervalMs',
  );
  const terminationTimeoutMs = boundedTimeout(
    options.terminationTimeoutMs,
    DEFAULT_TERMINATION_TIMEOUT_MS,
    MAX_TERMINATION_TIMEOUT_MS,
    'terminationTimeoutMs',
  );
  const outputDrainTimeoutMs = boundedTimeout(
    options.outputDrainTimeoutMs,
    DEFAULT_OUTPUT_DRAIN_TIMEOUT_MS,
    MAX_OUTPUT_DRAIN_TIMEOUT_MS,
    'outputDrainTimeoutMs',
  );
  const spawn = options.spawn ?? spawnBrowser;
  const connect = options.connect ?? connectCdp;
  const drain = options.drainOutput ?? drainOutput;
  const sleep = options.sleep ?? Bun.sleep;
  const now = options.now ?? Date.now;
  const reportFailure = options.reportFailure ?? defaultReporter;
  mkdirSync(options.profileRoot, { recursive: true });

  let lastFailure = 'candidate parity browser did not start';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const profile = mkdtempSync(join(options.profileRoot, `attempt-${attempt}-`));
    const activePortPath = join(profile, 'DevToolsActivePort');
    const started = now();
    let browser: CandidateBrowserProcess | undefined;
    let stdoutPromise: Promise<string> | undefined;
    let stderrPromise: Promise<string> | undefined;
    let socket: WebSocket | undefined;
    let retryable = true;
    try {
      browser = spawn(options.executable, profile);
      stdoutPromise = drain(browser.stdout);
      stderrPromise = drain(browser.stderr);
      while (now() - started < startupTimeoutMs) {
        if (browser.exitCode !== null) {
          throw new Error(`browser exited before CDP startup (${browser.exitCode})`);
        }
        const evidence = activePortEvidence(activePortPath);
        const port = cdpPort(evidence);
        if (port !== undefined) {
          const endpoint = `http://127.0.0.1:${port}`;
          // DevToolsActivePort can appear before the HTTP and WebSocket CDP
          // endpoints accept connections. Keep that transport establishment
          // inside the startup retry; withCandidateParityBrowser still runs
          // every later product assertion exactly once after startup succeeds.
          const remaining = Math.max(1, startupTimeoutMs - (now() - started));
          socket = await connect(endpoint, remaining);
          let cleanupPromise: Promise<void> | undefined;
          return {
            socket,
            endpoint,
            profile,
            browser,
            cleanup: async () => {
              cleanupPromise ??= (async () => {
                const cleanupErrors: string[] = [];
                try {
                  socket?.close();
                } catch (error) {
                  cleanupErrors.push(
                    `CDP socket close failed: ${error instanceof Error ? error.message : String(error)}`,
                  );
                }
                try {
                  const cleanup = await terminateAndDrain(
                    browser!,
                    stdoutPromise!,
                    stderrPromise!,
                    terminationTimeoutMs,
                    outputDrainTimeoutMs,
                  );
                  cleanupErrors.push(...cleanup.evidence.errors);
                } finally {
                  rmSync(profile, { recursive: true, force: true });
                }
                if (cleanupErrors.length > 0) {
                  throw new Error(`candidate browser cleanup failed: ${cleanupErrors.join('; ')}`);
                }
              })();
              await cleanupPromise;
            },
          };
        }
        await sleep(pollIntervalMs);
      }
      throw new Error('browser did not publish a usable CDP endpoint');
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
      const portEvidence = activePortEvidence(activePortPath);
      const beforeCleanup = browser
        ? (browser.exitCode === null ? 'running' : browser.exitCode)
        : 'not-spawned';
      const cleanup: BrowserCleanupResult = browser
        ? await terminateAndDrain(
          browser,
          stdoutPromise ?? Promise.resolve(''),
          stderrPromise ?? Promise.resolve(''),
          terminationTimeoutMs,
          outputDrainTimeoutMs,
        )
        : {
          afterCleanup: 'not-spawned' as const,
          stdout: '',
          stderr: '',
          evidence: {
            gracefulTimedOut: false,
            forceKillSent: false,
            forceKillTimedOut: false,
            stdoutDrainTimedOut: false,
            stderrDrainTimedOut: false,
            errors: [],
          },
        };
      try {
        socket?.close();
      } catch (socketError) {
        cleanup.evidence.errors.push(
          `CDP socket close failed: ${socketError instanceof Error ? socketError.message : String(socketError)}`,
        );
      }
      rmSync(profile, { recursive: true, force: true });
      reportFailure({
        executable: options.executable,
        attempt,
        maxAttempts,
        elapsedMs: Math.max(0, now() - started),
        browserExitState: {
          beforeCleanup,
          afterCleanup: cleanup.afterCleanup,
        },
        cleanup: cleanup.evidence,
        devToolsActivePort: portEvidence,
        stdout: bounded(cleanup.stdout, OUTPUT_LIMIT),
        stderr: bounded(cleanup.stderr, OUTPUT_LIMIT),
        failure: lastFailure,
      });
      if (cleanup.evidence.forceKillTimedOut) retryable = false;
      if (!retryable) {
        throw new Error(
          `candidate parity browser CDP connection failed on attempt ${attempt}: ${lastFailure}`,
        );
      }
    }
  }
  throw new Error(
    `candidate parity browser startup failed after ${maxAttempts} attempts: ${lastFailure}`,
  );
}

export async function withCandidateParityBrowser<T>(
  options: CandidateBrowserStartupOptions,
  operation: (session: CandidateBrowserSession) => Promise<T>,
): Promise<T> {
  const session = await launchCandidateParityBrowser(options);
  try {
    return await operation(session);
  } finally {
    await session.cleanup();
  }
}
