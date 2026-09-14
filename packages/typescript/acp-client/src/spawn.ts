/**
 * ACP child-process lifecycle: spawn, the stdin/stdout pump, exit/reap.
 *
 * Node `child_process` only — no Bun APIs, no repo imports — so the package
 * stays a neutral wire library usable from any runtime. One child speaks
 * newline-delimited JSON-RPC on stdout.
 *
 * Stderr content is never RETAINED here — this module keeps only a byte count.
 * It is still DELIVERED: `onStderr` receives each raw chunk as it arrives,
 * unredacted, so a caller that forwards those chunks to a log is publishing
 * whatever the child wrote to stderr. Retention and delivery are separate
 * properties and only the first one is bounded by this file.
 */
import { spawn, type ChildProcess } from 'node:child_process';

export interface AcpChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the process never became a process (ENOENT, EACCES, …). */
  spawnError?: string;
  /** Set when an established stdio transport fails (for example EPIPE). */
  ioError?: string;
}

export interface AcpChildOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Each complete stdout line, in order. */
  onLine: (line: string) => void;
  /** Raw stderr chunks, as they arrive. */
  onStderr?: (text: string) => void;
  /** A framing violation that makes the child unsafe to keep reading. */
  onProtocolError?: (message: string) => void;
  /** Maximum UTF-8 bytes before one stdout newline. Default 8 MiB. */
  maxLineBytes?: number;
}

const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;
const POST_EXIT_DRAIN_MS = 250;

export class AcpChild {
  private readonly child: ChildProcess;
  private buffered = '';
  private bufferedBytes = 0;
  private readonly maxLineBytes: number;
  private protocolFailed = false;
  private stderrByteCount = 0;
  private exitRecord: AcpChildExit | null = null;
  private settled = false;
  private exitDrainTimer?: ReturnType<typeof setTimeout>;
  private forceKillSignal?: NodeJS.Signals;
  /** Resolves only after the OS confirms spawn; rejects on pre-spawn failure. */
  readonly started: Promise<void>;
  readonly exited: Promise<AcpChildExit>;
  private resolveStarted!: () => void;
  private rejectStarted!: (error: Error) => void;
  private resolveExited!: (exit: AcpChildExit) => void;

  constructor(options: AcpChildOptions) {
    this.onLineCallback = options.onLine;
    this.onProtocolErrorCallback = options.onProtocolError ?? (() => {});
    this.maxLineBytes = Number.isSafeInteger(options.maxLineBytes) && (options.maxLineBytes ?? 0) > 0
      ? options.maxLineBytes!
      : DEFAULT_MAX_LINE_BYTES;
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
    this.started = new Promise((resolve, reject) => {
      this.resolveStarted = resolve;
      this.rejectStarted = reject;
    });
    // `AcpChild` is exported for low-level use; a caller may observe only
    // `exited`. Mark startup rejection handled without changing what an
    // explicit `await child.started` receives.
    void this.started.catch(() => {});
    let child: ChildProcess;
    try {
      child = spawn(options.command, options.args ?? [], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      // A synchronous throw (bad cwd on some platforms) is still an exit: the
      // owner learns through the same single path as an async spawn error.
      this.child = undefined as unknown as ChildProcess;
      const message = errorMessage(error);
      this.noteExit({ code: null, signal: null, spawnError: message });
      this.finalizeExit();
      this.rejectStarted(new Error(`acp child failed to spawn: ${message}`));
      return;
    }
    this.child = child;
    child.once('spawn', () => {
      this.resolveStarted();
      if (this.forceKillSignal) child.kill(this.forceKillSignal);
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.pump(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.stderrByteCount = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.stderrByteCount + Buffer.byteLength(chunk, 'utf8'),
      );
      options.onStderr?.(chunk);
    });
    child.stdin?.on('error', (error) => {
      if (this.settled) return;
      this.noteExit({ code: null, signal: null, ioError: errorMessage(error) });
      this.kill('SIGKILL');
    });
    child.on('error', (error) => {
      const message = errorMessage(error);
      // Resolve the exit path first so its structured trace is observable by
      // the time the startup barrier rejects.
      this.noteExit({ code: null, signal: null, spawnError: message });
      this.finalizeExit();
      this.rejectStarted(new Error(`acp child failed to spawn: ${message}`));
    });
    child.on('exit', (code, signal) => {
      // `exit` means writes must stop, but Node does not guarantee stdout has
      // drained until `close`. Keep the code/signal now and settle only after
      // the stdio streams close so a final response cannot lose a race with
      // child-death rejection.
      this.noteExit({ code, signal });
      this.exitDrainTimer ??= setTimeout(() => this.finalizeExit(), POST_EXIT_DRAIN_MS);
      this.exitDrainTimer.unref?.();
    });
    child.on('close', (code, signal) => {
      this.noteExit({ code, signal });
      this.finalizeExit();
    });
  }

  private onLineCallback: (line: string) => void = () => {};
  private onProtocolErrorCallback: (message: string) => void = () => {};

  private pump(chunk: string): void {
    if (this.protocolFailed) return;
    this.buffered += chunk;
    this.bufferedBytes += Buffer.byteLength(chunk);
    let nl: number;
    while ((nl = this.buffered.indexOf('\n')) !== -1) {
      const line = this.buffered.slice(0, nl);
      this.buffered = this.buffered.slice(nl + 1);
      const lineBytes = Buffer.byteLength(line);
      this.bufferedBytes -= lineBytes + 1; // UTF-8 newline is one byte.
      if (lineBytes > this.maxLineBytes) {
        this.failOversizedFrame(lineBytes);
        return;
      }
      if (line.trim().length > 0) this.onLineCallback(line);
    }
    if (this.bufferedBytes > this.maxLineBytes) this.failOversizedFrame(this.bufferedBytes);
  }

  private failOversizedFrame(bytes: number): void {
    if (this.protocolFailed) return;
    this.protocolFailed = true;
    this.buffered = '';
    this.bufferedBytes = 0;
    this.onProtocolErrorCallback(`ACP stdout frame exceeded ${this.maxLineBytes} bytes before newline (${bytes} bytes observed); closing child`);
    this.kill('SIGKILL');
  }

  private noteExit(exit: AcpChildExit): void {
    if (this.exitRecord === null) this.exitRecord = exit;
  }

  private finalizeExit(): void {
    if (this.settled) return;
    this.settled = true;
    if (this.exitDrainTimer) clearTimeout(this.exitDrainTimer);
    this.exitDrainTimer = undefined;
    const exit = this.exitRecord ?? { code: null, signal: null };
    this.exitRecord = exit;
    // A truncated final frame (no trailing newline before EOF) is still
    // delivered; the dispatcher will parse-fail it and trace it as malformed
    // rather than dropping the bytes silently.
    const leftover = this.buffered;
    this.buffered = '';
    this.bufferedBytes = 0;
    if (leftover.trim().length > 0) {
      try {
        this.onLineCallback(leftover);
      } catch {
        // The dispatcher absorbs its own failures; nothing to do here.
      }
    }
    this.resolveExited(exit);
  }

  /** False from the moment the child exits or fails to spawn. */
  get alive(): boolean {
    return this.exitRecord === null;
  }

  get exit(): AcpChildExit | null {
    return this.exitRecord;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Total observed stderr bytes; content is deliberately not retained. */
  get stderrBytes(): number {
    return this.stderrByteCount;
  }

  /**
   * Throws when the child is gone, so a caller that failed to check `alive`
   * still cannot write into a dead pipe.
   */
  writeLine(line: string): void {
    if (!this.alive || !this.child?.stdin?.writable) {
      throw new Error('acp child is not running; refusing to write');
    }
    this.child.stdin.write(line + '\n');
  }

  endStdin(): void {
    try {
      this.child?.stdin?.end();
    } catch {
      // Already gone; the exit path reports it.
    }
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.alive && this.child?.pid === undefined) this.forceKillSignal = signal;
    try {
      this.child?.kill(signal);
    } catch {
      // Already gone; the exit path reports it.
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
