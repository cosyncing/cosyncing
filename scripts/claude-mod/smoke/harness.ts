/**
 * The tier-2 harness: the broker's mod half, hosted in this process, with no broker.
 *
 * A full source broker next to the running 0.6.3 is forbidden, and would be wrong anyway:
 * the smoke tests the socket, the registry, the hold store and the gate, and none of those
 * need the Hub, the adapters or a managed runtime. So this builds the same
 * `ClaudeModService` the runtime builds and feeds it the three facts it would otherwise
 * read from the world: the viewer count, the session's transcript and the kill switch.
 *
 * Everything it observed is kept, because the assertions are all "what did the broker
 * actually see", not "what did the script print".
 */
export {};
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeModService, type ModHubConnection, type ModHubRow } from '../../../packages/typescript/broker/src/sessions/claude-mod-service.ts';
import { ClaudeModConnection, claudeSessionId } from '../../../packages/typescript/adapters/claude/src/index.ts';
import type { AgentMessage, SessionInfo } from '../../../packages/typescript/protocol/src/index.ts';
import type { ModAuditRow } from '../../../packages/typescript/broker/src/sessions/mod-audit.ts';
import type { ModSocketEvent } from '../../../packages/typescript/broker/src/sessions/mod-socket-server.ts';
import { parseTranscript, transcriptMode } from './evidence.ts';

/**
 * What the hub was handed, kept as it arrived.
 *
 * This mirrors `ModHubConnection.ingestRequest`, and it has to keep pace with it: a stub that
 * types less than the real thing is how a smoke run can be green about a field the client never
 * received. Every field the service puts on a card is here, including the three the review asked
 * the card to carry -- `inputPreview`, `permissionMode`, `releaseReason` -- and the two that say
 * whether a card waits or only explains (`readOnly`, `blocking`).
 */
export interface Card {
  sessionId: string;
  requestId: string;
  kind: string;
  toolName?: string;
  title?: string;
  detail?: string;
  toolInput?: unknown;
  questions?: unknown;
  permissionMode?: string;
  readOnly?: boolean;
  releaseReason?: string;
  inputPreview?: string;
  blocking?: boolean;
  /** A question open in the terminal's own picker: drawn read-only, answerable only there. */
  answerInTerminal?: boolean;
  /** The card replaces the one already drawn under its id. */
  restate?: boolean;
}

/** One frame a synced seat sent, with the moment the harness saw it and the session it belongs to. */
export interface Frame {
  at: number;
  /** The mod's id for the session: the native uuid. */
  sessionId: string;
  message: AgentMessage;
}

/**
 * The synced seat a watching app holds for one session: the real `ClaudeModConnection` on the
 * session's own transcript, which is what the Hub attaches for a synced Claude row.
 */
export interface Seat {
  sessionId: string;
  hubId: string;
  conn: ClaudeModConnection;
}

/** Optional sink for the observed stream, so a driver can print evidence as it goes. */
export type Emit = (type: string, data: Record<string, unknown>) => void;

export interface Harness {
  onEmit(emit: Emit): void;
  service: ClaudeModService;
  root: string;
  /** The socket it bound, which the driver may have chosen so the mod has to discover it. */
  socketPath: string;
  cards: Card[];
  /** Each with the moment the harness saw it, which is what a "within N s" step reads. */
  events: (ModSocketEvent & { at: number })[];
  refusals: { code: string; detail: string; route: string }[];
  registers: { sessionId: string; peerPid: number; cwd: string; claudeVersion: string; surface: string }[];
  log: string[];
  /** Every frame every seat sent, in arrival order. */
  frames: Frame[];
  /**
   * Open the synced seat for a session, once its transcript exists.
   *
   * Without one, the hub row only records what it was handed, and a step can prove what the broker
   * decided but never what the app was shown: whether the row went idle, which card ids it drew,
   * what a resync replays. With one, every call the service makes on the row reaches the same
   * connection a synced app attaches, and its frames are kept. Opening it reads the history first,
   * as an attach does, because that read is what starts the tail.
   */
  openSeat(sessionId: string, transcriptPath: string): Promise<Seat>;
  /**
   * Pin the mode read to a harness-owned file and write it there.
   *
   * This never writes to a path handed to `useTranscript`. The first run of this harness pinned
   * the mode while pointed at a real session transcript and `writeFileSync` truncated the
   * operator's session. A test harness does not get to do that, so the two paths are separate
   * by construction: writes always land in the harness root, reads may come from elsewhere.
   */
  setMode(mode: string | undefined): void;
  /** Whether an app is watching. Zero viewers is a rule, not a failure: nothing is held. */
  setViewers(count: number): void;
  setKillSwitch(on: boolean): void;
  /**
   * Read the mode from real session transcripts.
   *
   * A path is read as it is. A function is asked on every read, with the session the hold belongs
   * to, the way the broker looks a session's transcript up -- so a transcript that does not exist
   * yet when a step points here is read as soon as Claude writes it, as production reads it.
   * Read-only by design: the harness writes only inside its own root. Passing undefined hands
   * the read back to the harness's own file.
   */
  useTranscript(source: string | ((sessionId: string) => string | undefined) | undefined): void;
  /**
   * The mode a real transcript actually holds, without steering what the gate reads: the given
   * session's, or the last registered one's. Read by `transcriptMode`, from the rows Claude writes
   * it on: a prompt row's `permissionMode` and the title block's `permission-mode` row.
   */
  observedMode(sessionId?: string): string | undefined;
  /** Every card and event seen, drained. The driver reads this rather than polling fields. */
  drain(): { cards: Card[]; events: Harness['events']; registers: Harness['registers'] };
  audit(): ModAuditRow[];
  /** Held requests seen, with the poll count the broker charged them for. */
  holdPolls(requestId: string): number | undefined;
  close(): void;
}

export async function startHarness(options: { transcriptPath?: string; root?: string; socketPath?: string } = {}): Promise<Harness> {
  // macOS reports os.tmpdir() behind the /var -> /private/var symlink, which the state-dir
  // guard refuses; canonicalize the root first, the way security/r2-export.ts does.
  const root = realpathSync(options.root ?? mkdtempSync(join(tmpdir(), 'cmts-smoke-')));
  // The driver may hand us the path the mod is expected to derive on its own -- the socket
  // discovery is what is under test, so the harness must bind where discovery points rather than
  // wherever is convenient for it.
  const socketPath = options.socketPath !== undefined ? realpathSync(dirname(options.socketPath)) + options.socketPath.slice(dirname(options.socketPath).length) : join(root, 'mod.sock');
  if (Buffer.byteLength(socketPath) > 100) {
    throw new Error(`socket path is over the socketPath ceiling (${Buffer.byteLength(socketPath)} bytes): ${socketPath}`);
  }
  mkdirSync(dirname(socketPath), { recursive: true });
  /**
   * The harness's own mode file, and the only file this harness writes, always inside its root.
   *
   * It used to be `options.transcriptPath ?? join(root, ...)`, which meant a driver that handed
   * in a real session's transcript got `setMode()` writing to that path -- and `writeFileSync`
   * truncates. A harness must not be able to destroy the thing it is observing, so the write
   * target is its own file and the real transcript is only ever read. `refuseToWriteOutsideRoot`
   * is the same rule stated twice, in case a later edit reintroduces the parameter.
   */
  const modeFile = join(root, 'harness-transcript.jsonl');
  const fixed = options.transcriptPath;
  let realTranscript: ((sessionId: string) => string | undefined) | undefined = fixed !== undefined ? () => fixed : undefined;
  let pinnedMode = options.transcriptPath === undefined;
  const refuseToWriteOutsideRoot = (path: string): void => {
    if (!path.startsWith(root + '/')) {
      throw new Error(`the harness writes only inside ${root}; refused ${path}`);
    }
  };
  refuseToWriteOutsideRoot(modeFile);
  const harnessRoot = root;
  const readTarget = (sessionId: string) => (pinnedMode || !realTranscript ? modeFile : realTranscript(sessionId));

  const cards: Card[] = [];
  const events: Harness['events'] = [];
  const refusals: Harness['refusals'] = [];
  const registers: Harness['registers'] = [];
  const log: string[] = [];
  const frames: Frame[] = [];
  const seats = new Map<string, Seat>();
  let newestSeat: Seat | undefined;
  let emit: Emit | undefined;
  let drainedCards = 0;
  let drainedEvents = 0;
  let drainedRegisters = 0;
  const state = { mode: undefined as string | undefined, viewers: 1, killSwitch: false };

  // A fake Hub row: the service only ever asks how many clients watch and calls the two
  // request methods, so the fake records rather than renders.
  // Called per session, and the sessionId it is handed is stamped on the card. The hub row IS
  // the session, so a card that does not say which session drew it cannot be matched against the
  // audit row for the same call -- and request ids restart at one in every process.
  // While the mode is pinned, the service derives every session's row id from the harness's own
  // mode file, so that id names whichever session is alive: the newest seat.
  const seatFor = (hubId: string): ModHubConnection | undefined =>
    (seats.get(hubId) ?? (hubId === claudeSessionId(modeFile) ? newestSeat : undefined))?.conn as unknown as ModHubConnection | undefined;
  const row = (sessionId: string): ModHubRow => ({
    clientCount: state.viewers,
    conn: {
      // `conn` is `unknown` on purpose -- the service only needs these methods on it -- so the
      // fake names the payload itself. It is the same object the real Hub receives, which is the
      // point: a stub typed loosely than that stops being evidence. With a seat open, each call
      // also reaches it, as it reaches the connection a synced app is attached to.
      ingestRequest: (request: Omit<Card, 'sessionId'>) => {
        cards.push({ ...request, sessionId });
        seatFor(sessionId)?.ingestRequest?.(request as never);
      },
      respondPermission: async (...args: Parameters<NonNullable<ModHubConnection['respondPermission']>>) => {
        await seatFor(sessionId)?.respondPermission?.(...args);
      },
      // Every argument passes through: the last one says who closed the card, and a stub that
      // dropped it would make a run green about an attribution the seat never received.
      answerQuestion: async (...args: Parameters<NonNullable<ModHubConnection['answerQuestion']>>) => {
        await seatFor(sessionId)?.answerQuestion?.(...args);
      },
      rejectQuestion: async (...args: Parameters<NonNullable<ModHubConnection['rejectQuestion']>>) => {
        await seatFor(sessionId)?.rejectQuestion?.(...args);
      },
      noteModGeneration: (generation: number) => seatFor(sessionId)?.noteModGeneration?.(generation),
      noteModNotice: (message: string) => seatFor(sessionId)?.noteModNotice?.(message),
      noteModTurnEnded: (...args: Parameters<NonNullable<ModHubConnection['noteModTurnEnded']>>) => seatFor(sessionId)?.noteModTurnEnded?.(...args),
    },
  });

  const service = new ClaudeModService({
    socketPath,
    hub: row,
    transcriptPath: (sessionId) => readTarget(sessionId),
    killSwitch: () => state.killSwitch,
    sessionTitle: () => 'smoke',
    onEvent: (event) => events.push({ ...event, at: Date.now() }),
    onRegister: (sessionId, info) => registers.push({ sessionId, peerPid: info.peerPid, cwd: info.cwd, claudeVersion: info.claudeVersion, surface: info.surface }),
    log: { warn: (message) => log.push(message), info: (message) => log.push(message) },
  });
  await service.start();

  return {
    onEmit(next) {
      emit = next;
    },
    service,
    root: harnessRoot,
    socketPath,
    cards,
    events,
    refusals: refusals,
    registers,
    log,
    frames,
    async openSeat(sessionId, transcriptPath) {
      const hubId = claudeSessionId(transcriptPath);
      const open = seats.get(hubId);
      if (open) {
        newestSeat = open;
        return open;
      }
      const info = { id: hubId, nativeId: sessionId, tool: 'claude', status: 'idle', attachMode: 'live', cwd: dirname(transcriptPath), title: 'smoke' } as unknown as SessionInfo;
      const conn = new ClaudeModConnection({
        info,
        transcriptPath,
        nativeSessionId: sessionId,
        send: (command) => service.send(sessionId, command as never),
        steeringEnabled: () => true,
        turnRunning: () => service.currentTurn(sessionId) !== '',
        // The runtime's two lookups: what the service noted about a card the transcript cannot
        // say (open in the terminal, who closed it), and when the mod last said a turn ended.
        cardNote: (requestId) => service.cardNote(sessionId, requestId),
        turnEndedAt: () => service.turnEndedAt(sessionId),
      });
      conn.subscribe((message) => {
        frames.push({ at: Date.now(), sessionId, message });
      });
      await conn.getHistory();
      const seat = { sessionId, hubId, conn };
      seats.set(hubId, seat);
      newestSeat = seat;
      return seat;
    },
    setMode(mode) {
      state.mode = mode;
      // The gate reads the mode from the transcript, exactly as production does, so the
      // harness changes a file rather than a variable the gate never consults — its own file.
      pinnedMode = true;
      const line = mode === undefined ? '' : JSON.stringify({ type: 'permission-mode', permissionMode: mode }) + '\n';
      refuseToWriteOutsideRoot(modeFile);
      writeFileSync(modeFile, line);
    },
    setViewers(count) {
      state.viewers = count;
    },
    setKillSwitch(on) {
      state.killSwitch = on;
    },
    useTranscript(source) {
      // A real transcript releases the pin, and undefined hands the read back to the harness's
      // own file. `setMode` pins again. Without the release the auto-mode step could not test
      // what it exists to test: its gate would read the pinned fixture, say `default`, and hold
      // a session that was in auto mode the whole time.
      realTranscript = typeof source === 'function' ? source : source ? () => source : undefined;
      pinnedMode = !realTranscript;
    },
    observedMode(sessionId) {
      if (!realTranscript) return state.mode;
      const target = realTranscript(sessionId ?? registers.at(-1)?.sessionId ?? '');
      if (!target) return undefined;
      try {
        return transcriptMode(parseTranscript(readFileSync(target, 'utf8')));
      } catch {
        return undefined;
      }
    },
    // Draining reports what is new without emptying the lists, because the driver's
    // assertions query the whole history ("which card carried these questions?") while the
    // evidence stream only wants what has not been written yet.
    drain() {
      const fresh = {
        cards: cards.slice(drainedCards),
        events: events.slice(drainedEvents),
        registers: registers.slice(drainedRegisters),
      };
      drainedCards = cards.length;
      drainedEvents = events.length;
      drainedRegisters = registers.length;
      return fresh;
    },
    audit: () => service.auditTrail(),
    holdPolls: (requestId) => service.holdPolls(requestId),
    close() {
      for (const seat of seats.values()) void seat.conn.close();
      service.close();
      rmSync(harnessRoot, { recursive: true, force: true });
    },
  };
}
