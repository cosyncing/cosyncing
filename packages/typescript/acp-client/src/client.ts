/**
 * The ACP client: one child, request/response correlation, notifications,
 * cancel, the permission round-trip, and `close()`.
 *
 * Child-death semantics (plan §"Child-process lifecycle"): a send against a
 * dead, never-spawned, or closed child REJECTS before any run state is
 * touched — an agent whose exit-0 trap leaves the pipe open must never turn
 * "wait for the result" into a hang. There is no auto-relaunch in v1.
 */
import { AcpDispatcher } from './dispatch.ts';
import { AcpChild, type AcpChildExit } from './spawn.ts';
import {
  ACP_PROTOCOL_MAJOR,
  JSON_RPC_ERROR,
  JSON_RPC_VERSION,
  boundedTraceDetail,
  normalizeProtocolVersion,
  stderrTraceSink,
  type AcpClientCapabilities,
  type AcpClientHooks,
  type AcpClientInfo,
  type AcpAuthenticateParams,
  type AcpAuthenticateResult,
  type AcpInitializeResult,
  type AcpSessionLoadParams,
  type AcpSessionLoadResult,
  type AcpSessionListResult,
  type AcpSessionNewParams,
  type AcpSessionNewResult,
  type AcpSessionPromptParams,
  type AcpSessionPromptResult,
  type AcpSessionCloseParams,
  type AcpSessionCloseResult,
  type AcpSetConfigOptionParams,
  type AcpSetConfigOptionResult,
  type AcpTraceSink,
  type JsonRpcErrorObject,
  type JsonRpcId,
  type JsonRpcOutbound,
} from './types.ts';

export interface AcpClientOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  clientInfo?: AcpClientInfo;
  hooks?: AcpClientHooks;
  trace?: AcpTraceSink;
  /** Per-request timeout. Default 30s; a timed-out request rejects, never hangs. */
  requestTimeoutMs?: number;
  /** Turn timeout. Default 30 minutes; timeout cancels the session and closes the child. */
  promptTimeoutMs?: number;
  /** Maximum UTF-8 bytes in one newline-delimited ACP frame. Default 8 MiB. */
  maxFrameBytes?: number;
  /** Abort child startup or an in-progress initialize handshake. */
  signal?: AbortSignal;
}

export class AcpRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(
    code: number,
    message: string,
    data?: unknown,
  ) {
    super(message);
    this.name = 'AcpRpcError';
    this.code = code;
    this.data = data;
  }
}

export class AcpRequestTimeoutError extends Error {
  constructor(public readonly method: string, public readonly timeoutMs: number) {
    super(`acp ${method} timed out after ${timeoutMs}ms`);
    this.name = 'AcpRequestTimeoutError';
  }
}

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 30 * 60_000;
const CLOSE_GRACE_MS = 2_000;
const STDERR_TRACE_WINDOW_MS = 10_000;
const STDERR_TRACE_MAX_CHUNKS = 64;
const STDERR_TRACE_MAX_BYTES = 64 * 1024;

function rpcIdKey(id: JsonRpcId): string {
  return id === null ? 'null' : `${typeof id === 'number' ? 'number' : 'string'}:${String(id)}`;
}

export class AcpClient {
  private child: AcpChild | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private closed = false;
  private readonly trace: AcpTraceSink;
  private readonly hooks: AcpClientHooks;
  private readonly requestTimeoutMs: number;
  private readonly promptTimeoutMs: number;
  private readonly dispatcher: AcpDispatcher;
  private initializeResultValue: AcpInitializeResult | null = null;
  private protocolVersionValue: number | null = null;

  private constructor(options: AcpClientOptions) {
    const explicitTrace = options.trace;
    this.trace = explicitTrace ?? stderrTraceSink;
    this.hooks = options.hooks ?? {};
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.promptTimeoutMs = options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
    this.dispatcher = new AcpDispatcher({
      trace: this.trace,
      hooks: this.hooks,
      resolveResponse: (id, result, error) => this.resolveResponse(id, result, error),
      sendResult: (id, result) => this.sendFrame({ jsonrpc: JSON_RPC_VERSION, id, result }),
      sendError: (id, code, message, data) =>
        this.sendFrame({ jsonrpc: JSON_RPC_VERSION, id, error: { code, message, ...(data === undefined ? {} : { data }) } }),
    });
    let stderrWindowStartedAt = Date.now();
    let stderrTracedChunks = 0;
    let stderrTracedBytes = 0;
    let stderrDroppedChunks = 0;
    let stderrDroppedBytes = 0;
    const flushDroppedStderr = () => {
      if (stderrDroppedChunks === 0) return;
      this.trace({
        op: 'child-stderr',
        kind: 'child-stderr',
        message: `suppressed ${stderrDroppedBytes} stderr bytes across ${stderrDroppedChunks} chunks after the diagnostic trace limit`,
      });
      stderrDroppedChunks = 0;
      stderrDroppedBytes = 0;
    };
    const child = new AcpChild({
      command: options.command,
      args: options.args ?? [],
      cwd: options.cwd,
      env: options.env,
      onLine: (line) => this.dispatcher.dispatchLine(line),
      onStderr: (text) => {
        const now = Date.now();
        if (now - stderrWindowStartedAt >= STDERR_TRACE_WINDOW_MS) {
          flushDroppedStderr();
          stderrWindowStartedAt = now;
          stderrTracedChunks = 0;
          stderrTracedBytes = 0;
        }
        const bytes = Buffer.byteLength(text, 'utf8');
        if (stderrTracedChunks >= STDERR_TRACE_MAX_CHUNKS
          || stderrTracedBytes + bytes > STDERR_TRACE_MAX_BYTES) {
          stderrDroppedChunks += 1;
          stderrDroppedBytes += bytes;
          return;
        }
        stderrTracedChunks += 1;
        stderrTracedBytes += bytes;
        this.trace({
          op: 'child-stderr',
          kind: 'child-stderr',
          message: `child emitted ${bytes} stderr bytes (content redacted)`,
        });
      },
      maxLineBytes: options.maxFrameBytes,
      onProtocolError: (message) => {
        this.trace({ op: 'child-stdout', kind: 'oversized-frame', message });
      },
    });
    this.child = child;
    void child.exited.then((exit) => {
      flushDroppedStderr();
      this.onChildExit(exit);
    });
  }

  /**
   * Spawn the child and run the handshake. The agent's `protocolVersion` is
   * decoded tolerantly (number or string) and pinned to major
   * {@link ACP_PROTOCOL_MAJOR}: an untested major fails closed, with the
   * version recorded on the trace, and the child is torn down.
   */
  static async connect(options: AcpClientOptions): Promise<AcpClient> {
    const client = new AcpClient(options);
    const abort = () => { void client.close({ force: true }); };
    if (options.signal?.aborted) {
      await client.close({ force: true });
      throw new Error('ACP connect aborted');
    }
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      await client.child?.started;
      if (options.signal?.aborted) throw new Error('ACP connect aborted');
      const result = (await client.request('initialize', {
        protocolVersion: ACP_PROTOCOL_MAJOR,
        // v1 offers neither fs nor terminal: both keys stay absent.
        clientCapabilities: {} satisfies AcpClientCapabilities,
        clientInfo: options.clientInfo ?? { name: '@cosyncing/acp-client', version: '0.0.0' },
      })) as AcpInitializeResult;
      if (options.signal?.aborted) throw new Error('ACP connect aborted');
      const version = normalizeProtocolVersion(result?.protocolVersion);
      if (!version || version.major !== ACP_PROTOCOL_MAJOR) {
        client.trace({
          op: 'initialize',
          kind: 'unsupported-protocol-version',
          message: `agent's protocolVersion ${JSON.stringify(result?.protocolVersion)} is not supported major ${ACP_PROTOCOL_MAJOR}; failing closed`,
          detail: boundedTraceDetail({ protocolVersion: result?.protocolVersion ?? null }),
        });
        throw new Error(
          `unsupported ACP protocol version ${JSON.stringify(result?.protocolVersion)}; only major ${ACP_PROTOCOL_MAJOR} is pinned`,
        );
      }
      client.protocolVersionValue = version.major;
      client.initializeResultValue = result;
      return client;
    } catch (error) {
      await client.close();
      throw options.signal?.aborted ? new Error('ACP connect aborted') : error;
    } finally {
      options.signal?.removeEventListener('abort', abort);
    }
  }

  /** The raw initialize result — unknown fields and `_meta` preserved. */
  get initializeResult(): AcpInitializeResult | null {
    return this.initializeResultValue;
  }

  /** The negotiated protocol major (always {@link ACP_PROTOCOL_MAJOR} today). */
  get protocolVersion(): number | null {
    return this.protocolVersionValue;
  }

  get alive(): boolean {
    return !this.closed && this.child !== null && this.child.alive;
  }

  /** Resolves when the child exits, with its exit record. */
  get exited(): Promise<AcpChildExit> | null {
    return this.child?.exited ?? null;
  }

  // ── Typed method surface ───────────────────────────────────────────────────

  authenticate(params: AcpAuthenticateParams): Promise<AcpAuthenticateResult> {
    return this.request('authenticate', params) as Promise<AcpAuthenticateResult>;
  }

  sessionNew(params: AcpSessionNewParams): Promise<AcpSessionNewResult> {
    return this.request('session/new', params) as Promise<AcpSessionNewResult>;
  }

  sessionLoad(params: AcpSessionLoadParams): Promise<AcpSessionLoadResult> {
    return this.request('session/load', params) as Promise<AcpSessionLoadResult>;
  }

  sessionList(): Promise<AcpSessionListResult> {
    return this.request('session/list', {}) as Promise<AcpSessionListResult>;
  }

  /**
   * One turn. Resolves when the AGENT accepts and completes the prompt with a
   * `stopReason` — minting the durable pending row at that moment is the
   * adapter's job, not this package's.
   */
  sessionPrompt(params: AcpSessionPromptParams): Promise<AcpSessionPromptResult> {
    return this.request('session/prompt', params, this.promptTimeoutMs, () => {
      try { this.sessionCancel(params.sessionId); } catch { /* close below is authoritative */ }
      void this.close({ force: true });
    }) as Promise<AcpSessionPromptResult>;
  }

  /** Reconfigure one server-advertised session option. */
  sessionSetConfigOption(params: AcpSetConfigOptionParams): Promise<AcpSetConfigOptionResult> {
    return this.request('session/set_config_option', params) as Promise<AcpSetConfigOptionResult>;
  }

  /** Release one live session without deleting its durable history. */
  sessionClose(params: AcpSessionCloseParams, timeoutMs = this.requestTimeoutMs): Promise<AcpSessionCloseResult> {
    return this.request('session/close', params, timeoutMs) as Promise<AcpSessionCloseResult>;
  }

  /** `session/cancel` is a notification: fire-and-forget, but still refuses a dead child. */
  sessionCancel(sessionId: string): void {
    this.notify('session/cancel', { sessionId });
  }

  // ── Wire primitives ────────────────────────────────────────────────────────

  request(
    method: string,
    params?: unknown,
    timeoutMs = this.requestTimeoutMs,
    onTimeout?: () => void,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error(`acp client is closed; refusing ${method} before any state change`));
    }
    const child = this.child;
    if (!child || !child.alive) {
      return Promise.reject(
        new Error(`acp child is not running; refusing ${method} before any state change`),
      );
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(rpcIdKey(id))) {
          this.trace({
            op: method,
            kind: 'request-timeout',
            message: `${method} did not answer within ${timeoutMs}ms`,
          });
          reject(new AcpRequestTimeoutError(method, timeoutMs));
          onTimeout?.();
        }
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      this.pending.set(rpcIdKey(id), { method, resolve, reject, timer });
      try {
        child.writeLine(JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id, method, ...(params === undefined ? {} : { params }) }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(rpcIdKey(id));
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed || !this.child || !this.child.alive) {
      throw new Error(`acp child is not running; refusing to notify ${method}`);
    }
    this.sendFrame({ jsonrpc: JSON_RPC_VERSION, method, ...(params === undefined ? {} : { params }) });
  }

  /**
   * Reject every pending request, end stdin, and reap the child. Idempotent;
   * the only entry point that drops connection state.
   */
  async close(options: { force?: boolean } = {}): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAllPending(new Error('acp client closed'));
    const child = this.child;
    if (!child) return;
    if (child.alive && options.force) {
      child.kill('SIGKILL');
      await Promise.race([child.exited.then(() => true), sleep(CLOSE_GRACE_MS).then(() => false)]);
    } else if (child.alive) {
      child.endStdin();
      const exited = await Promise.race([
        child.exited.then(() => true),
        sleep(CLOSE_GRACE_MS).then(() => false),
      ]);
      if (!exited) {
        child.kill('SIGKILL');
        await Promise.race([child.exited.then(() => true), sleep(CLOSE_GRACE_MS).then(() => false)]);
      }
    } else {
      await child.exited.catch(() => {});
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private sendFrame(frame: JsonRpcOutbound): void {
    const child = this.child;
    if (!child || !child.alive) {
      this.trace({
        op: 'outbound-frame',
        kind: 'malformed-envelope',
        message: 'dropping an outbound answer because the child is gone',
        detail: boundedTraceDetail(frame),
      });
      return;
    }
    try {
      child.writeLine(JSON.stringify(frame));
    } catch (error) {
      this.trace({
        op: 'outbound-frame',
        kind: 'malformed-envelope',
        message: `failed to write an outbound frame: ${error instanceof Error ? error.message : String(error)}`,
        detail: boundedTraceDetail(frame),
      });
    }
  }

  private resolveResponse(id: JsonRpcId, result: unknown, error: JsonRpcErrorObject | undefined): boolean {
    const key = rpcIdKey(id);
    const pending = this.pending.get(key);
    if (!pending) return false;
    this.pending.delete(key);
    clearTimeout(pending.timer);
    if (error) {
      pending.reject(new AcpRpcError(error.code, error.message, error.data));
    } else {
      pending.resolve(result);
    }
    return true;
  }

  private onChildExit(exit: AcpChildExit): void {
    const stderrBytes = this.child?.stderrBytes ?? 0;
    this.trace({
      op: 'child',
      kind: 'child-exit',
      message: exit.spawnError
        ? `acp child failed to spawn: ${exit.spawnError}`
        : exit.ioError
          ? `acp child stdio failed: ${exit.ioError}`
        : `acp child exited (code ${String(exit.code)}, signal ${String(exit.signal)})`,
      detail: boundedTraceDetail({ ...exit, ...(stderrBytes > 0 ? { stderrBytes } : {}) }),
    });
    this.failAllPending(
      new Error(
        exit.spawnError
          ? `acp child failed to spawn: ${exit.spawnError}`
          : exit.ioError
            ? `acp child stdio failed: ${exit.ioError}`
          : `acp child exited (code ${String(exit.code)}) before answering`,
      ),
    );
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
