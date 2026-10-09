/**
 * The broker's Claude mod socket: one Unix socket, one HTTP/1.1 reader, no token.
 *
 * Shape of the thing, and why each part is where it is:
 *
 * - `Bun.listen({ unix })`, not `Bun.serve({ unix })`. The listener is the only Bun server
 *   that exposes a descriptor, and the descriptor is the only route to the kernel's peer
 *   credential. The cost is that the listener speaks no HTTP, so this lane owns one
 *   hand-written parser (`mod-http-reader.ts`) and nothing else in the product does.
 * - This is **not** an HTTP route. It never touches the token-authenticated TCP surface, so
 *   `route-authorization.ts` gains no entry and the packaged 404 gate on the old hook legs is
 *   left alone. Anyone reaching this socket is already a same-uid process on the user's own
 *   machine; the socket inherits that trust domain and adds a registry, not a secret.
 * - The pid is the broker's fact, not the mod's claim. `register` carries an optional
 *   `reportedPid` for diagnostics, and the row stores what `getsockopt` answered. A peer whose
 *   uid is not the broker's own euid is refused before anything is queued for it.
 *
 * Path resolution mirrors what the mod does, from the environment alone:
 * `COSYNCING_CLAUDE_SOCK`, else `<COSYNCING_HOME ?? ~/.cosyncing>/claude-mod.sock`. That is the
 * production/development split expressed as one variable, and it is what stops a review session
 * dialling the production broker.
 *
 * Never started on native Windows: `$.http.fetch` against a named pipe is
 * unmeasured, and a native Windows Claude session keeps Take over.
 */

import { basename, dirname, join } from 'node:path';
import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { createConnection } from 'node:net';
import { ensureOwnerOnlyDirectory, enforceOwnerOnlyFile } from '../security/secure-files.ts';
import { readUnixPeerCredentials, unixPeerCredentialsEnforceable } from '../security/unix-peer-credentials.ts';
import { processIsDescendantOf } from '../security/process-liveness.ts';
import {
  Http1RequestReader,
  MAX_LIVE_CONNECTIONS,
  type ParsedHttpRequest,
  type ReaderSocket,
} from './mod-http-reader.ts';
import { CLAUDE_MOD_MIN_VERSION, claudeVersionAtLeast } from '@cosyncing/adapter-claude';
import { ModRegistry } from './mod-registry.ts';
import { modCancelVia, type ModHoldOutcome, type ModHoldStore } from './mod-holds.ts';
import {
  MAX_POLL_WAIT_MS,
  MOD_PROTOCOL_VERSION,
  MOD_REFUSAL_STATUS,
  modInstanceIsOlder,
  modSessionId,
  parseModEvent,
  parseModHold,
  parseModPoll,
  parseModRegister,
  parseModTarget,
  refusalBody,
  type ModCommand,
  type ModEventMessage,
  type ModPollResponse,
  type ModRefusalCode,
} from './mod-protocol.ts';

// Defined beside the path setup stamps into the installed mod, so the bind and the stamp cannot disagree.
export { MOD_SOCKET_FILENAME, MOD_SOCKET_PATH_MAX_BYTES } from './mod-socket-path.ts';
import { MOD_SOCKET_FILENAME, MOD_SOCKET_PATH_MAX_BYTES } from './mod-socket-path.ts';

export interface ModSocketEvent {
  sessionId: string;
  kind: string;
  requestId?: string;
  detail?: Record<string, unknown>;
}

export interface ModSocketServerLog {
  warn: (message: string) => void;
  info?: (message: string) => void;
}

/** Bun's listen socket, as far as this file needs to know it. */
type ModConnection = ReaderSocket & { data?: Record<string, unknown>; close(): void };

export interface ModSocketServerOptions {
  /** Full socket path. Tests pass `<mkdtemp>/claude-mod.sock`; production passes the state dir's. */
  socketPath: string;
  registry: ModRegistry;
  holds: ModHoldStore;
  /** cosyncing's own kill switch, read at answer time and carried on every poll response. */
  killSwitch: () => boolean;
  /** Mirror an event to the hub: turn boundaries, tool decisions, prompt rows. */
  onEvent?: (event: ModSocketEvent) => void;
  /** A registration was accepted or replaced. `turnId` and `turnEndedAt` are what the registering
   *  mod said, when it said them. */
  onRegister?: (sessionId: string, info: { cwd: string; claudeVersion: string; model?: string; isInteractive: boolean; surface: string; peerPid: number; turnId?: string; turnEndedAt?: number }) => void;
  /** Fired on every refusal, so a refusal in the field is diagnosable from the broker log alone. */
  onRefusal?: (code: ModRefusalCode, detail: string, route: string) => void;
  log?: ModSocketServerLog;
  /** Override the uid comparison. A suite uses this to prove the refusal without setuid. */
  expectedUid?: () => number;
  /** Override the broker-descendant test. */
  isBrokerChild?: (pid: number) => boolean;
  /** Override the version floor, so a suite does not have to track a version bump. */
  versionFloor?: string;
  /** Long-poll the broker holds a `hold` request for. Capped at the engine's own ceiling. */
  holdPollWaitMs?: number;
  /** Queue a command on delivery failure paths. Exposed through `enqueue`. */
  onCommand?: (sessionId: string, command: ModCommand) => void;
  /**
   * Header-block deadline handed to the reader. Production leaves the 5 s default; a suite
   * shortens it so the `408` path is tested in milliseconds rather than in seconds.
   */
  headerDeadlineMs?: number;
  /** Body deadline for the reader. Production uses the default; a suite shortens it. */
  bodyDeadlineMs?: number;
  /**
   * Ceiling on simultaneously open connections. Defaults to {@link MAX_LIVE_CONNECTIONS}.
   *
   * Injectable so the framing suite can prove the cap refuses rather than queues.
   */
  maxConnections?: number;
  /** How long `start()` waits for an existing socket to answer before it gives up on it. */
  probeTimeoutMs?: number;
}

interface Refusal {
  code: ModRefusalCode;
  message: string;
}

type PeerVerdict = { pid: number; uid: number; gid: number } | Refusal;

/** Resolve the socket path the way the mod does, from the environment alone. */
export function modSocketPath(stateHome: string): string {
  const override = process.env.COSYNCING_CLAUDE_SOCK?.trim();
  if (override) return override;
  return join(stateHome, MOD_SOCKET_FILENAME);
}

function refused(verdict: PeerVerdict): verdict is Refusal {
  return (verdict as Refusal).code !== undefined;
}

/**
 * The body's own sessionId when it is one, else ''. Used to aim the peer check at the right row
 * before the route's parser runs, so it applies the parser's own rule rather than a looser one.
 */
function message_session_id(parsed: unknown): string {
  return modSessionId((parsed as { sessionId?: unknown } | null)?.sessionId) ?? '';
}

/** How long a probe of an existing socket waits for it to answer. */
const SOCKET_PROBE_TIMEOUT_MS = 1_000;

/**
 * What is behind a socket name already on disk: a listener that answers, nothing at all, or
 * something this process cannot tell apart from a listener.
 *
 * `stale` is only ever a refusal from the kernel -- nothing is bound -- or a name gone by the time
 * the probe dialled it. Everything else, a timeout included, is `unknown`, which `start()` treats
 * like `live`: a socket it cannot prove dead is not one it may take away from whoever owns it.
 */
export function probeModSocket(path: string, timeoutMs = SOCKET_PROBE_TIMEOUT_MS): Promise<'live' | 'stale' | 'unknown'> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection({ path });
    const done = (verdict: 'live' | 'stale' | 'unknown'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        // Already closed.
      }
      resolve(verdict);
    };
    const timer = setTimeout(() => done('unknown'), Math.max(1, timeoutMs));
    socket.once('connect', () => done('live'));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      done(error.code === 'ECONNREFUSED' || error.code === 'ENOENT' ? 'stale' : 'unknown');
    });
  });
}

/** Bun's listener handle, as far as this file needs it: `stop()` on Bun 1.3.14, `close()` elsewhere. */
interface ModListener {
  stop?(): void;
  close?(closeActiveConnections?: boolean): void;
}

export class ModSocketServer {
  private readonly options: ModSocketServerOptions;
  private readonly registry: ModRegistry;
  private readonly holds: ModHoldStore;
  /**
   * Polls parked on a session, one entry per session: idle ones on "nothing to say yet", and ones
   * waiting on an open hold's verdict.
   *
   * The mod's loop pace *is* this response, so an idle poll answered early turns a chained
   * poll into a hot spin: the tier-2 smoke watched one real session send 15,739 polls in
   * seven minutes, ~53 ms apart. A poll now waits its full `wait` and is woken the moment
   * something exists to deliver, which is what makes a 20 s wait cheap. A poll waiting on a hold
   * is woken the same way, so a Stop or a prompt queued while a card is open goes out at once.
   */
  private readonly parked = new Map<string, Set<() => void>>();
  /** Accepted connections, so `close()` can hang up on the ones parked on a long-poll. */
  private readonly live = new Set<ModConnection>();
  /** Ceiling on simultaneously open connections. See the cap check in `open()`. */
  private readonly maxConnections: number;
  private server: ModListener | undefined;
  private started = false;
  /** The bind in progress, so two callers of `start()` share one probe and one listener. */
  private starting: Promise<void> | undefined;
  /** Bumped by `close()`, so a start still probing when the broker shuts down binds nothing. */
  private epoch = 0;
  /**
   * The socket this process bound, as `{ dev, ino }`.
   *
   * A state directory can be shared: a source review run with `COSYNCING_HOME` pointed at the
   * real one, a packaged broker and a candidate from the same install, two `bun run`s in
   * sequence that overlap during a restart. Every one of them wants the same socket NAME, and the
   * old cleanup unlinked by name -- so the loser's `close()` deleted the winner's socket file, and
   * every open terminal's mod found nothing to dial on its next poll. The inode is the only
   * answer to "is this still the file I made", because the name provably is not.
   */
  private boundAt: { dev: number; ino: number } | undefined;

  constructor(options: ModSocketServerOptions) {
    this.options = options;
    // The registry and the hold store are injected rather than built here: the broker owns them
    // (it also feeds them to the adapter and the hub), and this is one window onto them.
    this.registry = options.registry;
    this.holds = options.holds;
    this.maxConnections = Math.max(1, options.maxConnections ?? MAX_LIVE_CONNECTIONS);
  }

  get listening(): boolean {
    return this.started;
  }

  /** `{ dev, ino }` of the socket file at `path`, or nothing when it cannot be read. */
  private socketIdentity(path: string): { dev: number; ino: number } | undefined {
    try {
      const st = lstatSync(path);
      return st.isSocket() ? { dev: st.dev, ino: st.ino } : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Whether the socket name still points at the socket this process bound.
   *
   * Unknown counts as ours: a listener that cannot read its own file has no evidence it was
   * superseded, and skipping `stop()` on a guess would leak a listener on every ordinary close.
   */
  private ownsSocketName(): boolean {
    const mine = this.boundAt;
    if (!mine) return true;
    const current = this.socketIdentity(this.options.socketPath);
    if (!current) return true;
    return current.dev === mine.dev && current.ino === mine.ino;
  }

  /**
   * Remove the socket name, but only while it is still OUR socket.
   *
   * `silent` is the close path: a socket another process took over is not ours to remove, and
   * its existence is not a fault of ours to report. A broker that loses the name and keeps
   * listening is the fail-open shape -- the mods find the other listener, and no session is
   * worse off than it was before the cleanup was written.
   */
  private removeOwnSocket(path: string, why: 'close' | 'retry'): void {
    const mine = this.boundAt;
    if (!mine) return;
    const current = this.socketIdentity(path);
    if (current && (current.dev !== mine.dev || current.ino !== mine.ino)) {
      if (why === 'retry') {
        this.options.log?.warn(`mod socket ${basename(path)} was replaced by another listener; leaving it alone`);
      }
      this.boundAt = undefined;
      return;
    }
    if (!current) {
      this.boundAt = undefined;
      return;
    }
    try {
      unlinkSync(path);
    } catch {
      // Already gone, or not ours to remove.
    }
    this.boundAt = undefined;
  }

  /**
   * Bind the socket. Rejects with a named reason rather than half-starting. A broker that
   * cannot create its mod socket simply has no true sync, which is the fail-open shape, so the
   * caller logs the reason and carries on.
   */
  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    this.starting ??= this.bind().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async bind(): Promise<void> {
    const epoch = this.epoch;
    if (process.platform === 'win32') throw new Error('the Claude mod socket is not supported on native Windows');
    const path = this.options.socketPath;
    if (path.includes('\0')) throw new Error('mod socket path contains a NUL');
    if (!path.startsWith('/')) throw new Error(`mod socket path must be absolute: ${path}`);
    const length = Buffer.byteLength(path, 'utf8');
    if (length > MOD_SOCKET_PATH_MAX_BYTES) {
      throw new Error(`mod socket path is ${length} bytes, ceiling ${MOD_SOCKET_PATH_MAX_BYTES}: ${path}`);
    }

    // A crashed broker leaves its socket name behind and `listen` refuses to overwrite it.
    // Remove only what is genuinely a socket, never a stranger's file at that path -- and only a
    // socket nothing answers on. A second broker on the same state directory (a source run pointed
    // at the real one, a restart that overlaps its predecessor) used to unlink the first one's live
    // socket here, and every terminal dialling that name lost the broker that was serving it.
    //
    // This is the ONE place a socket is unlinked by name, and it is allowed because this process
    // is about to own the name: a stale name from a dead predecessor must go, or true sync never
    // comes back after a crash. What `close()` must never do -- see `removeOwnSocket` -- is take
    // the name away from a listener that is still answering.
    if (existsSync(path)) {
      let isSocket = false;
      try {
        isSocket = lstatSync(path).isSocket();
      } catch {
        isSocket = false;
      }
      if (!isSocket) throw new Error(`mod socket path exists and is not a socket: ${path}`);
      const probe = await probeModSocket(path, this.options.probeTimeoutMs);
      if (probe !== 'stale') {
        throw new Error(probe === 'live'
          ? `another listener is answering on ${path}; leaving it in place`
          : `cannot tell whether a listener is answering on ${path}; leaving it in place`);
      }
      if (epoch !== this.epoch) return;
      try {
        unlinkSync(path);
      } catch {
        // Gone already: whoever removed it left the name free, which is all this needed.
      }
    }
    if (epoch !== this.epoch) return;

    ensureOwnerOnlyDirectory(dirname(path));
    // Bun 1.3.14's `listen()` answer exposes `stop()`, not the `close()` the docs imply (measured
    // here: own properties are empty, the prototype has `stop`, `ref`, `unref`, `fd`). Typed loosely
    // and called defensively so a rename in either direction is a log line rather than a crash.
    this.server = (
      Bun as unknown as {
        listen(options: Record<string, unknown>): ModListener;
      }
    ).listen({
      unix: path,
      socket: {
        // Per-connection state is created in `open()`. Bun's `listen({ data })` value is shared
        // by every connection, so state built anywhere else is state shared between mods: the
        // spike watched three clean clients look like one client with three connections. Risk R1.
        open: (socket: ModConnection) => {
          // A cap on live connections, because every one of them is a reader holding a buffer and
          // a timer, and any same-uid process can open this socket. Long polls are the reason the
          // number is not tiny: each registered terminal parks one connection for up to 20 s at a
          // time, and a mod that is also holding adds a second. Over the cap the newcomer is closed
          // without an answer, which the mod reads as a transport failure and backs off from.
          if (this.live.size >= this.maxConnections) {
            this.options.log?.warn(`mod socket at its ${this.maxConnections}-connection cap; refused a new connection`);
            socket.end?.();
            return;
          }
          socket.data = { open: true, gone: new AbortController() };
          this.live.add(socket);
          this.reader(socket).open(socket);
        },
        data: (socket: ModConnection, chunk: ArrayBuffer | Uint8Array | string) => {
          this.reader(socket).onData(socket, chunk);
        },
        close: (socket: ModConnection) => {
          this.live.delete(socket);
          this.markClosed(socket);
          this.reader(socket).onClose();
        },
        error: (socket: ModConnection) => {
          this.live.delete(socket);
          this.markClosed(socket);
          this.reader(socket).onClose();
          socket.end?.();
        },
      },
    });

    // 0600 on the socket. The directory gets 0700 from `ensureOwnerOnlyDirectory`; the socket's
    // mode comes from the creating process's umask, so it is set explicitly and then verified.
    try {
      enforceOwnerOnlyFile(path, 0o600);
    } catch {
      chmodSync(path, 0o600);
    }
    let mode = -1;
    try {
      mode = lstatSync(path).mode & 0o777;
    } catch {
      mode = -1;
    }
    if (mode !== 0o600) this.options.log?.warn(`mod socket ${basename(path)} has mode ${mode.toString(8)}, expected 600`);

    // Recorded AFTER the bind, so it describes the inode this listener created and not whatever
    // name happened to be at the path a moment before.
    this.boundAt = this.socketIdentity(path);
    this.started = true;
    const enforceable = unixPeerCredentialsEnforceable();
    if (!enforceable.enforceable) {
      this.options.log?.warn(`mod socket is live but peer credentials are unenforceable here: ${enforceable.reason}`);
    }
    this.options.log?.info?.(`mod socket listening on ${path}`);
  }

  close(): void {
    this.epoch += 1;
    // Every connection stops being a claimant before anything is torn down, so a request parked on
    // a hold wakes now and finds its connection gone, rather than at its timer.
    for (const socket of this.live) this.markClosed(socket);
    this.wakeAllPolls();
    // Before the listener is touched: Bun's own teardown unlinks the path it was created with,
    // measured on 1.3.14 -- a loser that stops while a winner holds the name deletes the
    // WINNER's socket file, which no amount of cleanup afterwards can undo. So when the name is
    // no longer ours, `stop()` is skipped and the listener is left alone: its inode is already
    // unreachable by name, nothing further can connect to it, and the process exit reaps the fd.
    // Leaking one fd in a configuration where two brokers share one state directory is the cheap
    // half of the trade; taking a live broker's socket away from every terminal dialing it is the
    // expensive half.
    const ownsTheName = this.ownsSocketName();
    if (this.server && !ownsTheName) {
      this.options.log?.warn(
        `mod socket ${basename(this.options.socketPath)} belongs to another listener; leaving it and our own bound socket in place`,
      );
      this.server = undefined;
      this.started = false;
      for (const socket of this.live) {
        try {
          socket.end?.();
          socket.close?.();
        } catch {
          // A connection that refuses to close is closing.
        }
      }
      this.live.clear();
      return;
    }
    if (this.server) {
      const listener = this.server as ModListener & { close?: (closeActiveConnections?: boolean) => void };
      try {
        // `stop()` first, because that is what Bun 1.3.14 answers with, and it does NOT take the
        // flag that closes accepted connections. A mod parked on a long-poll therefore keeps a
        // socket to a broker that has already stopped: no answer, no error, no way to notice. It
        // hangs until its own wait expires, which is the difference between a session that comes
        // back in a second and one that comes back in twenty. Every accepted connection is hung up
        // on by hand for exactly that reason.
        if (typeof listener.stop === 'function') listener.stop();
        else if (typeof listener.close === 'function') listener.close(true);
      } catch {
        // Already gone.
      }
      for (const socket of this.live) {
        try {
          socket.end?.();
          socket.close?.();
        } catch {
          // A connection that refuses to close is closing.
        }
      }
      this.live.clear();
      this.server = undefined;
    }
    this.started = false;
    this.removeOwnSocket(this.options.socketPath, 'close');
  }

  /**
   * Wait out an idle poll. `wakePolls` ends it early, and every path that creates work for a
   * session calls it, so a parked poll never stands between the app and a prompt just typed.
   */
  private parkPoll(sessionId: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const leave = this.addParked(sessionId, () => {
        clearTimeout(timer);
        resolve();
      });
      const timer = setTimeout(() => {
        leave();
        resolve();
      }, Math.max(0, ms));
    });
  }

  /**
   * Put `wake` among the polls parked on this session, for `wakePolls` to call. The returned
   * function takes it back out without calling it, for a wait that ended some other way.
   */
  private addParked(sessionId: string, wake: () => void): () => void {
    const leave = (): void => {
      const current = this.parked.get(sessionId);
      if (!current) return;
      current.delete(woken);
      if (current.size === 0) this.parked.delete(sessionId);
    };
    const woken = (): void => {
      leave();
      wake();
    };
    const waiters = this.parked.get(sessionId) ?? new Set<() => void>();
    waiters.add(woken);
    this.parked.set(sessionId, waiters);
    return leave;
  }

  /** Tell every parked poll for this session that there may now be something to deliver. */
  private wakePolls(sessionId: string): void {
    const waiters = this.parked.get(sessionId);
    if (!waiters) return;
    this.parked.delete(sessionId);
    for (const wake of waiters) wake();
  }

  /** Release parked polls so a close never waits on a long-poll timer. */
  private wakeAllPolls(): void {
    for (const sessionId of [...this.parked.keys()]) this.wakePolls(sessionId);
  }

  /** The app's intake path: validate, queue, deliver on the mod's next poll. */
  enqueue(sessionId: string, command: ModCommand): { ok: true; command: ModCommand } | { ok: false; code: string } {
    const result = this.registry.enqueue(sessionId, command);
    if (!result.ok) {
      this.refuse(result.code, `queued for ${sessionId}`, 'enqueue');
      return { ok: false, code: result.code };
    }
    this.options.onCommand?.(sessionId, command);
    this.wakePolls(sessionId);
    return { ok: true, command: result.command };
  }

  /**
   * Settle a held decision from the app. False means the terminal got there first or the answer
   * is late, and in both cases the answer is dropped rather than queued.
   */
  answer(sessionId: string, requestId: string, behavior: 'allow' | 'deny', source: 'app' | 'band'): boolean {
    const answered = this.holds.answer(sessionId, requestId, behavior, source);
    if (answered) this.registry.cancelQueuedAnswer(sessionId, requestId);
    this.wakePolls(sessionId);
    return answered;
  }

  /** Route a turn event in, from the socket or from anywhere else the broker learns of one. */
  noteTurnEvent(sessionId: string, kind: string, requestId?: string, detail?: Record<string, unknown>): void {
    const applied = this.registry.noteTurnEvent({ kind, sessionId, ...(requestId ? { requestId } : {}), ...(detail ? { detail } : {}) });
    const via = kind === 'user-cancel' ? modCancelVia(detail?.via) : undefined;
    for (const id of applied.resolved) {
      this.holds.cancel(sessionId, id, kind === 'turn.complete' ? 'turn-complete' : 'user-cancel', via);
    }
    this.options.onEvent?.({ sessionId, kind, ...(requestId ? { requestId } : {}), ...(detail ? { detail } : {}) });
    // A queued answer, a cancel or a `session.end` each change what a parked poll
    // should answer, and a parked poll is the only thing holding the mod's loop still.
    this.wakePolls(sessionId);
    // A `session.end` takes the row a hold leg is parked as the claimant of.
    this.holds.wake(sessionId);
  }

  /**
   * Read a band answer off an event, or null when the event is not one. A malformed
   * `hold.answer` is dropped as an ordinary event rather than answered on a guess: the
   * only thing a wrong behavior string could mean is an approval nobody asked for.
   */
  private bandAnswer(event: ModEventMessage): { requestId: string; behavior: 'allow' | 'deny' } | null {
    const requestId = event.requestId;
    const behavior = event.detail?.behavior;
    if (!requestId || (behavior !== 'allow' && behavior !== 'deny')) return null;
    return { requestId, behavior };
  }

  // ── Internals ──

  /** One reader per connection, parked on that connection's own state. See risk R1. */
  private reader(socket: ModConnection): Http1RequestReader {
    const holder = socket as ModConnection & { __modReader?: Http1RequestReader };
    if (!holder.__modReader) {
      holder.__modReader = new Http1RequestReader({
        headerDeadlineMs: this.options.headerDeadlineMs,
        ...(this.options.bodyDeadlineMs !== undefined ? { bodyDeadlineMs: this.options.bodyDeadlineMs } : {}),
        onUndelivered: (_socket, detail) => this.options.log?.warn(`mod socket response undelivered: ${detail}`),
        onRequest: (raw, fd, request) => {
          void this.handleRequest(raw as ModConnection, fd, request).catch((error: unknown) => {
            this.options.log?.warn(`mod socket handler failed: ${String((error as Error)?.message ?? error).slice(0, 160)}`);
            void this.respond(raw as ModConnection, 500, JSON.stringify({ ok: false, code: 'invalid_message', message: 'handler failed' }));
          });
        },
        onRefuse: (_socket, code, detail) => this.refuse(code, detail, 'framing'),
      });
    }
    return holder.__modReader;
  }

  /**
   * Note that a connection is gone, so a wait parked on it stops being a claimant.
   *
   * A delivery is consumed exactly once, and a waiter whose socket has closed cannot carry one.
   * Left unmarked, it still wakes, still claims, and the answer is written into a dead socket.
   */
  private markClosed(socket: ModConnection): void {
    const data = socket.data as { open?: boolean; gone?: AbortController } | undefined;
    if (!data) return;
    data.open = false;
    // A request parked on a hold over this connection is waiting on something it can no longer
    // deliver: wake it.
    data.gone?.abort();
  }

  /** Aborted when this connection closes or the server does. Absent state has no signal. */
  private goneSignal(socket: ModConnection): AbortSignal | undefined {
    return (socket.data as { gone?: AbortController } | undefined)?.gone?.signal;
  }

  /** Whether this connection can still take a delivery. Missing state counts as live. */
  private connectionLive(socket: ModConnection): boolean {
    return (socket.data as { open?: boolean } | undefined)?.open !== false;
  }

  private refuse(code: ModRefusalCode, detail: string, route: string): void {
    this.options.onRefusal?.(code, detail, route);
    this.options.log?.warn(`mod socket refused ${route}: ${code} (${detail})`);
  }

  /**
   * Answer a connection. Resolves false when the response could not be written in full.
   *
   * Callers that queued something to be DELIVERED have to check the result and put it back; the
   * ones answering a refusal or an acknowledgement do not, because there is nothing to lose.
   */
  private respond(socket: ModConnection, status: number, body: string): Promise<boolean> {
    return this.reader(socket).respond(socket, status, body);
  }

  /** Close every hold a session has open, and close the app's cards with them. */
  private cancelSessionHolds(sessionId: string, reason: 'replaced' | 'transport' | 'turn-complete' | 'user-cancel' | 'deadline'): void {
    for (const requestId of this.holds.openHoldIdsForSession(sessionId)) {
      this.holds.cancel(sessionId, requestId, reason);
    }
  }

  private refuseOn(socket: ModConnection, refusal: Refusal | { ok: false; code: ModRefusalCode; message?: string }, route: string): void {
    this.refuse(refusal.code, refusal.message ?? '', route);
    void this.respond(socket, MOD_REFUSAL_STATUS[refusal.code], refusalBody(refusal.code, refusal.message));
  }

  /** The peer check. Everything downstream assumes a peer that has passed this. */
  private checkPeer(fd: number): PeerVerdict {
    const creds = readUnixPeerCredentials(fd);
    if ('error' in creds) return { code: 'peer_unavailable', message: creds.error };
    const expected = this.options.expectedUid?.() ?? (typeof process.geteuid === 'function' ? process.geteuid() : -1);
    if (expected >= 0 && creds.uid !== expected) {
      return { code: 'uid_mismatch', message: `peer uid ${creds.uid} is not the broker's ${expected}` };
    }
    // The parent chain alone. A scan of every process for the broker's direct children used to run
    // beside it on every request, about 7 ms of synchronous /proc reads, and it could only ever find
    // what the chain's first step already finds.
    const isChild = this.options.isBrokerChild?.(creds.pid) ?? processIsDescendantOf(creds.pid, process.pid);
    if (isChild) return { code: 'broker_child', message: `peer pid ${creds.pid} is a process this broker launched` };
    return { pid: creds.pid, uid: creds.uid, gid: creds.gid };
  }

  private async handleRequest(socket: ModConnection, fd: number, request: ParsedHttpRequest): Promise<void> {
    const { route, sid, inst, path, invalid } = parseModTarget(request.target);
    if (!route) {
      this.refuseOn(socket, { code: 'unknown_route', message: `no mod route ${JSON.stringify(path.slice(0, 64))}` }, 'unknown');
      return;
    }
    if (invalid) {
      this.refuseOn(socket, { code: 'invalid_message', message: invalid }, route);
      return;
    }

    // Every route, not just `register`. Checking the kernel peer only on the way in meant a
    // process that was never registered could still read another session's queued prompts, open
    // a hold in its name, answer a hold it never saw, or send the `session.end` that tears the
    // row down. The uid and the broker-child rule are the same check the register path has always
    // made; the row comparison below is what ties a connection to one claimant.
    const peer = this.checkPeer(fd);
    if (refused(peer)) {
      this.refuseOn(socket, peer, route);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(request.body);
    } catch {
      this.refuseOn(socket, { code: 'json_invalid', message: 'body is not JSON' }, route);
      return;
    }

    if (route === 'register') {
      const claim = this.registry.claimState(message_session_id(parsed), peer.pid);
      const register = parseModRegister(parsed);
      if (!register.ok) {
        this.refuseOn(socket, register.failure, route);
        return;
      }
      const message = register.message;
      if (message.protocolVersion !== MOD_PROTOCOL_VERSION) {
        this.refuseOn(socket, { code: 'protocol_version_mismatch', message: `mod protocol ${message.protocolVersion}, broker protocol ${MOD_PROTOCOL_VERSION}` }, route);
        return;
      }
      const floor = this.options.versionFloor ?? CLAUDE_MOD_MIN_VERSION;
      if (!claudeVersionAtLeast(message.claudeVersion, floor)) {
        this.refuseOn(socket, { code: 'claude_version_too_old', message: `${message.claudeVersion} predates the ${floor} floor` }, route);
        return;
      }
      if (sid && sid !== message.sessionId) {
        this.refuseOn(socket, { code: 'invalid_message', message: `sid ${sid} does not match body sessionId ${message.sessionId}` }, route);
        return;
      }
      // A hot reload's two module evaluations share one pid, so the claim cannot tell them apart.
      // The evaluation time does: the older one is told it was superseded and stops for good,
      // rather than taking the row back and starting the two-loop fight a reload used to cause.
      const holder = this.registry.get(message.sessionId);
      const registering = message.instance ?? inst;
      if (holder && holder.peerPid === peer.pid && modInstanceIsOlder(registering, holder.instance)) {
        this.refuseOn(socket, { code: 'superseded', message: `${message.sessionId} is held by a newer evaluation of the mod in this process` }, route);
        return;
      }
      // The start time is what tells this process from a later one handed the same pid. A row
      // without one could never be told apart from its successor, so it could never be retired as
      // dead: it is refused, and the terminal stays Observe and asks again on its own cadence.
      const peerStart = this.registry.readStartTime(peer.pid);
      if (!peerStart) {
        this.refuseOn(socket, { code: 'peer_unavailable', message: `the start time of peer pid ${peer.pid} cannot be read` }, route);
        return;
      }
      if (claim === 'claimed') {
        // First claimant keeps it. The newcomer reads this, stays Observe, and tries again on its
        // own poll cadence; nothing here is drawn and nothing here is held for it.
        this.refuseOn(socket, { code: 'session_claimed', message: `${message.sessionId} is driven by another live process` }, route);
        return;
      }
      // A takeover, or a registration after the row went away: whatever the previous holder had
      // open is closed first, so its cards leave the app before the new row can open one with the
      // same id. The row owns the ids, so this has to happen while the old row is still there.
      if (claim === 'takeover' && this.registry.get(message.sessionId)) {
        this.cancelSessionHolds(message.sessionId, 'replaced');
      }
      const row = this.registry.register(message, { pid: peer.pid, uid: peer.uid, start: peerStart });
      if (!row.peerPidAgrees) {
        this.options.log?.warn(
          `mod pid disagreement session=${row.sessionId} kernel=${row.peerPid} reported=${String(message.reportedPid)}: keeping the row, the pid watch is the kernel's`,
        );
      }
      this.options.onRegister?.(row.sessionId, {
        cwd: row.cwd,
        claudeVersion: row.claudeVersion,
        ...(row.model ? { model: row.model } : {}),
        isInteractive: row.isInteractive,
        surface: row.surface,
        peerPid: row.peerPid,
        ...(message.turnId ? { turnId: message.turnId } : {}),
        ...(message.turnEndedAt === undefined ? {} : { turnEndedAt: message.turnEndedAt }),
      });
      // Whatever was parked on the row this one replaced has to hear about it now, not when its
      // wait runs out: a poll from a module a reload replaced is answered `superseded` at once, and
      // a hold leg parked as the old row's claimant stops being one.
      this.wakePolls(row.sessionId);
      this.holds.wake(row.sessionId);
      void this.respond(
        socket,
        200,
        JSON.stringify({
          ok: true,
          peerPid: row.peerPid,
          peerUid: row.peerUid,
          peerPidAgrees: row.peerPidAgrees,
          state: this.registry.status(row.sessionId).state,
          killSwitch: this.options.killSwitch(),
        }),
      );
      return;
    }

    // Everything below needs a registration. A poll from an unknown session is refused rather
    // than quietly answered, because "the mod stopped polling" is a diagnosis already paid for
    // in probe time once.
    const bodySessionId = message_session_id(parsed);
    const sessionId = sid ?? bodySessionId;
    if (!sessionId || !this.registry.get(sessionId)) {
      this.refuseOn(socket, { code: 'no_registration', message: `no registration for ${String(sessionId ?? 'unknown session')}` }, route);
      return;
    }
    // The query and the body have to name the same session. Without this, `?sid=A` with a body
    // naming B was answered from A's row, which is a cross-session read waiting to happen.
    if (sid && bodySessionId && sid !== bodySessionId) {
      this.refuseOn(socket, { code: 'session_mismatch', message: `sid ${sid} is not the body's sessionId ${bodySessionId}` }, route);
      return;
    }
    // The connection must BE the claimant. Whether that process is still the same process is a
    // question about the row, not the connection: a row whose pid cannot be proved goes Observe
    // and raises its one attention event, and it still has to be able to poll its way back.
    const claimant = this.registry.get(sessionId)!;
    if (claimant.peerPid === peer.pid && modInstanceIsOlder(inst, claimant.instance)) {
      this.refuseOn(socket, { code: 'superseded', message: `${sessionId} is held by a newer evaluation of the mod in this process` }, route);
      return;
    }
    // The pid AND its start time. A pid alone is a number the kernel hands out again: between a
    // terminal's death and the sweep that retires its row, another process given the same pid
    // would otherwise be answered as the terminal.
    if (!this.registry.isRegisteredProcess(claimant, peer.pid)) {
      this.refuseOn(socket, {
        code: 'peer_mismatch',
        message: `peer pid ${peer.pid} is not the process registered for ${sessionId}`,
      }, route);
      return;
    }

    // A connection stops being a claimant the moment its socket closes or its registration is
    // replaced: a resume, a `/clear`, or an orphaned mod worker outliving the session it served.
    // Verdicts are consumed once and a waiter that cannot carry one must not take one -- the
    // tier-2 smoke watched a superseded poll swallow the app's answer and leave the live
    // terminal parked for the mod's whole 45 s budget with the call still unrun.
    const rowWhenAccepted = this.registry.get(sessionId);
    const claimIsLive = (): boolean =>
      this.connectionLive(socket) && rowWhenAccepted !== undefined && this.registry.get(sessionId) === rowWhenAccepted;

    if (route === 'poll') {
      const poll = parseModPoll(parsed, sessionId);
      if (!poll.ok) {
        this.refuseOn(socket, poll.failure, route);
        return;
      }
      // A closed terminal is reported by the service's sweep. It used to be raised here, inside a
      // poll from the very process whose death it reports, which is a poll that never comes.
      this.registry.notePoll(sessionId);
      const answer = await this.pollResponse(sessionId, poll.message.wait, claimIsLive, this.goneSignal(socket));
      if (!answer) {
        if (!this.connectionLive(socket)) {
          // Nobody is left to answer: the terminal hung up while the poll was parked. The row may be
          // fine, so this is not reported as a registration that ended.
          this.options.log?.info?.(`mod socket poll for ${sessionId} ended with its connection`);
          return;
        }
        if (this.supersededWhileWaiting(sessionId, inst)) {
          this.refuseOn(socket, { code: 'superseded', message: `${sessionId} was taken by a newer evaluation of the mod in this process` }, 'poll');
          return;
        }
        // The row went away while this poll was parked — a `session.end`, a replacement, or a
        // stale eviction. Answering `no_registration` is what tells the mod to register again,
        // which is how a session recovers after `/clear` without a restart.
        this.refuseOn(socket, { code: 'no_registration', message: `registration for ${sessionId} ended` }, 'poll');
        return;
      }
      const response = answer.body;
      if (!await this.respond(socket, 200, JSON.stringify(response))) {
        // The bytes never left. The body is one JSON document, so a partial write delivered
        // nothing, and a prompt that arrives one poll late is better than a prompt that vanished.
        // `requeue` puts it back at the HEAD, behind nothing, with its original `queuedAt`, so the
        // queue's own age limit still decides when it stops being worth delivering.
        if ('command' in response && response.command) {
          const back = this.registry.requeue(sessionId, response.command);
          this.options.log?.warn(
            `mod socket poll response undelivered; ${response.command.op} ${back ? 'requeued at the head' : 'dropped, queue full'}`,
          );
          // Another poll may already be parked for this session -- the terminal's next one, on a
          // fresh connection -- and it is the only thing that can carry the command now.
          if (back) this.wakePolls(sessionId);
        }
        if (answer.carried) this.putBackOutcome(sessionId, answer.carried.requestId, answer.carried.outcome);
      }
      return;
    }

    if (route === 'hold') {
      const hold = parseModHold(parsed, sessionId);
      if (!hold.ok) {
        this.refuseOn(socket, hold.failure, route);
        return;
      }
      const outcome = this.holds.accept(hold.message);
      if (outcome.kind !== 'held') {
        // Decided already: released by the gate just now, or answered, expired or cancelled while
        // the mod was between two of its requests -- or handed to the poll leg. `accept` has
        // consumed whatever it found, so this answer is the only place it can still go. Waiting for
        // a verdict here instead used to find nothing and answer `{}`, and the person's answer was
        // gone.
        await this.deliverOutcome(socket, sessionId, hold.message.requestId, outcome);
        return;
      }
      if (outcome.first) {
        // Answered before the wait, and nothing else about the request changes: the next `hold`
        // for the same id waits for the verdict exactly as this one would have. The mod has been
        // drawing its band off the arrival of the ask, which painted a band over every prompt the
        // broker released in the same round trip -- in auto mode, with nobody watching, and
        // whenever the row could not answer at all. An early yes to a hold it did not take is the
        // only thing that lets the band wait for the truth.
        void this.respond(socket, 200, JSON.stringify(this.withState({ held: true })));
        return;
      }
      const wait = Math.min(this.options.holdPollWaitMs ?? MAX_POLL_WAIT_MS, MAX_POLL_WAIT_MS);
      const verdict = await this.holds.pollVerdict(sessionId, hold.message.requestId, wait, true, claimIsLive, this.goneSignal(socket));
      if (!claimIsLive()) {
        if (!this.connectionLive(socket)) {
          this.options.log?.info?.(`mod socket hold ${hold.message.requestId} for ${sessionId} ended with its connection`);
          return;
        }
        if (this.supersededWhileWaiting(sessionId, inst)) {
          this.refuseOn(socket, { code: 'superseded', message: `${sessionId} was taken by a newer evaluation of the mod in this process` }, 'hold');
          return;
        }
        // The row moved on without this connection. Saying so beats handing back an empty answer,
        // which the mod would read as "still held" and poll over again for nothing.
        this.refuseOn(socket, { code: 'no_registration', message: `registration for ${sessionId} was replaced` }, 'hold');
        return;
      }
      await this.deliverOutcome(socket, sessionId, hold.message.requestId, verdict);
      return;
    }

    const event = parseModEvent(parsed, sessionId);
    if (!event.ok) {
      this.refuseOn(socket, event.failure, route);
      return;
    }
    // The terminal band answers through the same event leg it reports turns over, and
    // lands on the same settle the app's tap does: one hold, one answer, first writer
    // wins, whoever got there. Anything else the mod reports is a turn event.
    const bandAnswer = event.message.kind === 'hold.answer' ? this.bandAnswer(event.message) : null;
    if (bandAnswer) {
      const answered = this.answer(event.message.sessionId, bandAnswer.requestId, bandAnswer.behavior, 'band');
      void this.respond(socket, 200, JSON.stringify({ ok: true, answered }));
      return;
    }
    this.noteTurnEvent(event.message.sessionId, event.message.kind, event.message.requestId, event.message.detail);
    void this.respond(socket, 200, JSON.stringify({ ok: true }));
  }

  /**
   * Answer with a call's outcome, and keep the outcome when the answer never leaves.
   *
   * An outcome is handed over once, so one written into a connection that had already gone was lost
   * to both legs. It is put back where the next request for the call -- on either leg -- finds it.
   */
  private async deliverOutcome(socket: ModConnection, sessionId: string, requestId: string, outcome: ModHoldOutcome): Promise<void> {
    if (await this.respond(socket, 200, JSON.stringify(this.verdictResponse(outcome, requestId)))) return;
    this.putBackOutcome(sessionId, requestId, outcome);
  }

  private putBackOutcome(sessionId: string, requestId: string, outcome: ModHoldOutcome): void {
    // Only an outcome is worth keeping. "Still held", "settled elsewhere" and "unknown" describe the
    // moment they were said, and saying them again later would be saying something else.
    if (outcome.kind === 'held' || outcome.kind === 'settled-elsewhere' || outcome.kind === 'unknown') return;
    if (!this.holds.putBack(sessionId, requestId, outcome)) return;
    this.options.log?.warn(`mod socket outcome for ${requestId} undelivered; kept for the next request on either leg`);
    this.wakePolls(sessionId);
  }

  /** Whether the row a waiting request lost now belongs to a newer module in the same process. */
  private supersededWhileWaiting(sessionId: string, inst: string | undefined): boolean {
    const current = this.registry.get(sessionId);
    return current !== undefined && modInstanceIsOlder(inst, current.instance);
  }

  /**
   * Answer a poll: a queued command, else a held verdict, else nothing until `wait` elapses.
   *
   * Null means the registration ended mid-wait, which the caller answers as `no_registration`.
   * The loop re-checks after every wake rather than trusting the wake, because the reason for a
   * wake and the work worth delivering are not always the same thing.
   */
  private async pollResponse(
    sessionId: string,
    wait: number,
    claimIsLive: () => boolean = () => true,
    gone?: AbortSignal,
  ): Promise<{ body: ModPollResponse; carried?: { requestId: string; outcome: ModHoldOutcome } } | null> {
    const deadline = Date.now() + Math.min(Math.max(0, wait), MAX_POLL_WAIT_MS);
    for (;;) {
      if (!this.registry.get(sessionId) || !claimIsLive()) return null;
      const command = this.registry.dequeue(sessionId);
      if (command) return { body: this.withState({ command }) };
      const request = this.holds.pollableRequest(sessionId);
      if (request) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { body: this.withState({}) };
        // Parked like an idle poll as well, so an `enqueue` for this session ends the wait: a Stop
        // or a prompt queued while a card is open goes out now, not when this park runs out. Only
        // this leg: the hold stays open, and the mod polls again.
        const queued = new AbortController();
        const leave = this.addParked(sessionId, () => queued.abort());
        let outcome: ModHoldOutcome;
        try {
          outcome = await this.holds.pollVerdict(
            sessionId,
            request,
            remaining,
            false,
            claimIsLive,
            gone ? AbortSignal.any([queued.signal, gone]) : queued.signal,
          );
        } finally {
          leave();
        }
        // Woken for something else to say: read the queue again.
        if (outcome.kind === 'held' && queued.signal.aborted && !gone?.aborted) continue;
        // The poll leg carries an outcome when it has one; that the hold leg carried it is no news
        // to a loop that is only polling.
        return outcome.kind === 'held' || outcome.kind === 'settled-elsewhere' || outcome.kind === 'unknown'
          ? { body: this.withState({}) }
          : { body: this.verdictResponse(outcome, request), carried: { requestId: request, outcome } };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { body: this.withState({}) };
      await this.parkPoll(sessionId, remaining);
    }
  }

  private verdictResponse(outcome: ModHoldOutcome, requestId: string): ModPollResponse {
    if (outcome.kind === 'verdict') {
      return this.withState({ verdict: { requestId, behavior: outcome.behavior, source: outcome.source } });
    }
    if (outcome.kind === 'answered') {
      return this.withState({ answer: { requestId, answers: outcome.answers } });
    }
    if (outcome.kind === 'released') return this.withState({ release: { requestId, why: outcome.why } });
    // The deadline and each cancel reason name themselves on the wire. The mod's behaviour is the
    // same for all of them, which is exactly why the log line and the audit row have to keep them
    // apart: "why did my terminal get the dialog back" is the first thing anyone asks.
    if (outcome.kind === 'expired') return this.withState({ release: { requestId, why: 'deadline' } });
    if (outcome.kind === 'cancelled') return this.withState({ release: { requestId, why: outcome.why } });
    // Never an empty answer for a call that is over: the mod would read one as "still held".
    if (outcome.kind === 'settled-elsewhere') return this.withState({ settledElsewhere: { requestId } });
    return this.withState({});
  }

  private withState(extra: Record<string, unknown>): ModPollResponse {
    return { ok: true, state: { killSwitch: this.options.killSwitch() }, ...extra } as ModPollResponse;
  }
}
