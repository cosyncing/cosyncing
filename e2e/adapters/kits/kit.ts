/**
 * The adapter conformance kit interface.
 *
 * One kit per agent adapter (`e2e/adapters/kits/<agent>.ts`). A kit is two
 * things the conformance scenarios never branch on the tool name around:
 *
 *   - a **profile**: data. What the broker must serve for this agent
 *     (capabilities, version floor, catalogs), which scenarios apply, and for
 *     every scenario that does not apply, the refusal the product shows or the
 *     reason the scenario is skipped.
 *   - a **fake controller**: the agent's native side, out of process. It
 *     installs the fake binary and store into a broker's fixture paths, seeds
 *     sessions, writes what a terminal would write (foreign rows, rewrites),
 *     flips the fake's version or presence, and reads the fake's ledger of
 *     spawns, argv and frames.
 *
 * The scenarios live in `e2e/adapters/conformance/scenarios.ts`; a kit's test
 * file is one line: `conformanceSuite(grokKit)`.
 */
import { expect } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Broker, BrokerClient, FixturePaths, Frame, SessionStream } from '../../harness/index.ts';

// ------------------------------------------------------------------ scenarios

export const SCENARIOS = {
  C01: 'agent roster row and capabilities',
  C02: 'stored session roster rows and lineage',
  C03: 'bare attach is Observe with ordered, keyed history',
  C04: 'Observe refuses every mutation before the native side',
  C05: 'Observe tails durable appends exactly once',
  C06: 'a rewritten log resets history instead of mixing it',
  C07: 'create derives identity from the durable store',
  C08: 'resume grants Drive lazily and starts one exact child',
  C09: 'a prompt is queued, reconciled once, answered and summarised',
  C10: 'back-to-back prompts serialize on one child',
  C11: 'permission cards reach every tab once and map to native options',
  C12: 'stop cancels the running turn natively',
  C13: 'a second client joins the existing Drive owner',
  C14: 'a foreign durable user row demotes every joined socket',
  C15: 'a replaced or rewritten log demotes Drive',
  C16: 'version floor gates Create and Resume',
  C17: 'a missing binary refuses Create and keeps stored sessions listed Observe-only',
  C18: 'model and mode catalog, and switching',
  C19: 'slash-command catalog rides the prompt queue',
  C20: 'broker restart restores only exact Drive provenance',
  C21: 'hostile store entries are withheld, the roster survives',
  C22: 'doctor --json verdicts across versions and paths',
} as const;

export type ScenarioId = keyof typeof SCENARIOS;

/**
 * How a profile answers one scenario. Absent means `run`.
 *  - `refuse`: the capability is n/a for this agent; the scenario asserts the
 *    product's refusal instead of the positive path (the reason is the claim).
 *  - `skip`: the scenario cannot be reached for this kit yet; the reason says
 *    why and what would make it reachable. Shown as a skipped test.
 */
export type Applicability = { refuse: string } | { skip: string };

// -------------------------------------------------------------------- profile

export interface DoctorExpectation {
  /** Which doctor check carries the verdict: `<agent>.version` or `<agent>.binary`. */
  check: 'version' | 'binary';
  status: 'pass' | 'warn' | 'fail' | 'skip';
  detailCode: string;
}

export interface HostileStoreCase {
  name: string;
  /** Write the hostile entry into the store. Returns the id that must stay unpublished. */
  plant(fake: FakeController): string;
  /** Platforms the case cannot be built on (FIFOs, symlinks on Windows). */
  unsupportedOn?: NodeJS.Platform[];
  /**
   * A product bug this case hits. A string withholds the whole case (skipped, with the reason);
   * `{ aspect, bug }` withholds only one half: the roster lists the entry (`roster`), or attaching
   * to it misbehaves (`attach`). Either is asserted only with COSYNCING_E2E_KNOWN_BUGS=1.
   */
  knownBug?: string | { aspect: 'roster' | 'attach'; bug: string };
}

export interface ConformanceProfile {
  /** The broker's tool id. */
  agent: string;
  displayName: string;
  /** The capabilities object `/api/agents` must serve, verbatim. */
  capabilities: Record<string, unknown> & { attachModes: string[] };
  /** Contract revision floor for clients that may see this agent (undefined: none). */
  minimumClientRevision?: number;
  /** `broker-child`: the broker spawns the native writer; `live-host`: it attaches to a running host. */
  driveFamily: 'broker-child' | 'live-host';
  /**
   * Which stored sessions Resume may drive.
   *  - `stored-idle`: any stored session the native side reports idle.
   *  - `app-created`: only sessions this broker created (durable provenance).
   */
  driveEligibility: 'stored-idle' | 'app-created';
  version: {
    /** What the fake reports by default; at or above the floor. */
    current: string;
    below: string;
    newer: string;
    /** Whether a build newer than every measured one may Drive (false = exact pin). */
    newerDrives: boolean;
    /** The broker caches the version gate; a change is only seen after a restart. */
    cachedByBroker: boolean;
    doctor: {
      current: DoctorExpectation;
      below: DoctorExpectation;
      newer: DoctorExpectation;
      missing: DoctorExpectation;
    };
  };
  catalog: {
    /** `provider/model` ids the options frame must offer, in order. */
    models: string[];
    /** Permission-mode values the options frame must offer. */
    modes: string[];
    /** Command names the commands frame must offer. */
    commands: string[];
    /** Command that stops a running turn, when the agent advertises one. */
    stopCommand?: string;
    /** The model C18 switches to (required unless the profile refuses C18). */
    switchModel?: { providerID: string; modelID: string };
    /** The model id the session then reports, when the selection is an alias the agent resolves. */
    switchModelResolvesTo?: string;
    /**
     * The agent owns its command namespace: a command missing from the catalog is forwarded for
     * the agent to answer rather than refused by the broker (C19). Claude loads plugin and skill
     * commands only when its process starts, so the catalog before the first turn is partial.
     */
    unknownCommandsForwarded?: boolean;
    /** A permission mode C07 creates with. */
    createMode?: string;
    /** A model C07 creates with. */
    createModel?: { providerID: string; modelID: string; reasoningEffort?: string };
  };
  /** Environment variable that names the binary explicitly, when the adapter reads one (C22). */
  binaryOverrideEnv?: string;
  /** Native argv the Drive child must carry (C08). */
  driveArgv: {
    required: string[];
    forbidden: string[];
    /** Every start (children and version probes) carries the agent's self-updater guard. */
    updaterGuard?: boolean;
  };
  /**
   * Whether the child that answered `session/new` is adopted as the Drive
   * writer (one child from create through the first prompt), or create closes
   * its child and Drive starts its own (C07).
   */
  createChildAdopted: boolean;
  /**
   * When the native agent makes a prompt's user row durable: `turn-start`
   * (Grok appends it before answering) or `turn-end` (Reasonix rewrites its
   * transcript with the answer). Scenarios that need the writer to have read
   * a turn back from the store wait for it at the matching moment (C15).
   */
  userRowDurable: 'turn-start' | 'turn-end';
  /**
   * How the sender's prompt first shows (C09, C13): `queued` (default) when
   * the adapter mints a queued row that the durable echo later claims;
   * `native` when the agent's own live echo of the user item is the first
   * row (Codex), carrying the sender's `clientKey`.
   */
  promptEcho?: 'queued' | 'native';
  /**
   * Whether a later attach's history row still carries the sender's
   * `clientKey` (C09, C13). Default true. False when the agent's store keeps
   * no app-send token and only the live echo carries it (Codex): the history
   * row keeps the echo's key, which the client re-decorates by.
   */
  historyClientKey?: boolean;
  /**
   * A prompt sent while a turn runs (C10): `queued` (default) waits for the
   * running turn; `steered` reaches the agent at once, into the running turn,
   * on the same writer (Codex `turn/steer`); `refused` is nacked by name and never reaches the agent
   * (Kilo: one prompt at a time).
   */
  midTurnPrompt?: 'queued' | 'steered' | 'refused';
  /**
   * How a model switch lands (C18): `relaunch` (default) restarts the writer
   * on the selected model and reloads the same id; `per-turn` rides the next
   * turn's own request on the existing writer (Codex `turn/start`).
   */
  modelSwitch?: 'relaunch' | 'per-turn';
  /**
   * The native answer to a permission request approved once, and a fragment
   * the agent's answer then mentions (C11). Default: the ACP allow-once
   * outcome.
   */
  nativePermission?: { approveOnce: unknown; answerMentions: string };
  /**
   * What a roster row's `control.drive.state` reads for a stored session that nothing drives (C02).
   * Default `observing`; an agent whose every listed session is already driven through a shared
   * server (OpenCode) reads `driving`.
   */
  rosterDriveState?: string;
  /**
   * What a bare attach (no `mode`) grants (C03). Default: Observe, `{ canMutate: false, prompt: 'none' }`
   * on attach mode `observe`. A shared-serve agent's bare attach is the writer itself.
   */
  bareAttach?: { authority: Record<string, unknown>; attachMode: string };
  /**
   * How a socket renounces authority when Observe is not read-only by itself (C04): the attach
   * parameters of a read-only socket and the attach mode its session frame then reads. Absent: an
   * explicit `mode=observe` is the read-only attach.
   */
  readOnlyAttach?: { params: { readOnly: true }; attachMode: string };
  /**
   * How the app opens Drive on a stored session. `resume` (default): `mode=resume` with the reason.
   * `bare`: no mode at all; the bare attach of a shared-serve session is already the writer, and
   * `mode=resume` would instead start a private `run` child. `live`: `mode=live` (Kilo, whose
   * capabilities declare live attach and no resume).
   */
  driveAttach?: 'resume' | 'bare' | 'live';
  /**
   * The log changes C15 inflicts. Default both. An agent whose offsets stay valid across an atomic replacement with
   * identical bytes (agy tails a path and a byte offset) is not endangered by one, so it lists only `rewriteHistory`.
   */
  boundaryChanges?: Array<'replaceLog' | 'rewriteHistory'>;
  /** Whether a Drive attach publishes a `commands` frame at all. Default true; agy offers no slash commands, so it sends none. */
  commandsFrame?: boolean;
  /**
   * A refused `mode=live` attach: `error` (default) or `observe` (the socket falls back to read-only Observe, after
   * one `attach-conflict` frame that says why).
   */
  liveRefusal?: 'error' | 'observe';
  /** What a Drive session offers for the native terminal (C08). */
  terminal: {
    /**
     * A fragment of the resume hint's command (`{id}` = the native id), or the exact command for a
     * session when the terminal names it by something other than its row id; null when no hint is
     * offered.
     */
    resumeHint: string | null | ((session: { id: string; cwd: string }) => string);
    /** Whether the terminal can join the broker's live writer. */
    syncAvailable: boolean;
    /** False when there is no terminal to hand Drive to (C20 skips the handoff row). Default true. */
    handoff?: boolean;
  };
  /**
   * Whether a stored session's history carries one finished `run-summary` per turn (C03). Default true.
   * False when the agent's store records no run outcome (Cline's snapshots hold messages only; its summaries
   * come from a Drive run).
   */
  observeRunSummaries?: boolean;
  /**
   * Whether a session this broker just created (no turn yet) can be attached for Observe (C04). Default true.
   * False when the agent refuses it until its first prompt (Cline: "empty created sessions require Resume").
   */
  freshCreateObservable?: boolean;
  /** Whether Stop closes the turn with a live cancelled `run-summary` (C12). Default true; Cline answers with a notice and a history reset. */
  stopSummary?: boolean;
  /**
   * Whether an app-created session keeps Drive across a broker restart (C20). Default true. False when the
   * native host is replaced with the broker (Cline's Hub epoch is `hubId:startedAt`; a new Hub revokes Drive).
   */
  restartKeepsDrive?: boolean;
  /** Whether the stored store can publish subagent child rows (C02). */
  subagents: boolean;
  /**
   * What the roster does with stored sessions while the binary is missing
   * (C17): `observe-only` when they stay listed and readable, with Drive off and
   * a "not installed" reason, and no new Drive writer may open; `hidden` when the
   * agent's sessions are reachable only through the host the binary runs (a
   * `kimi web` or `opencode serve`), so with it gone there is no store to list.
   */
  missingBinaryRoster: 'hidden' | 'observe-only';
  scenarios: Partial<Record<ScenarioId, Applicability>>;
  /**
   * How the agent replies to an approved permission request, as the fake's ledger reads it
   * (`replies(...)[0].frame.result.outcome`), and the word the fake's answer then carries (C11).
   * Absent: ACP's `allow_once` option.
   */
  permission?: { approveReply: unknown; answerMentions: string };
  /**
   * Whether a prompt sent while the agent is idle is shown queued until the agent echoes it (C09).
   * Absent: it is. Claude shows such a send as delivered: nothing is ahead of it.
   */
  idleSendQueued?: boolean;
  /**
   * Open product defects, by the scenario whose assertion exposes them (`C09`),
   * or by one named aspect of it (`C09.clientKey`) where a scenario guards more
   * than one. The scenario runs but leaves that assertion out (its title says
   * so) unless COSYNCING_E2E_KNOWN_BUGS=1, so the gate stays green until the
   * fix lands; delete the entry with the fix.
   */
  knownBugs?: Partial<Record<ScenarioId | `${ScenarioId}.${string}`, string>>;
  hostileStore: HostileStoreCase[];
}

// -------------------------------------------------------------------- extras

/** A session Resume may drive, and the attach reason the app uses for it. */
export interface DriveSession {
  id: string;
  cwd: string;
  reason: 'create' | 'takeover';
  /** The native id, when the broker's session id is not it (Codex: the id is the rollout path). */
  nativeId?: string;
}

/**
 * What a scenario (or a kit's extra) works with: the kit's one broker, its
 * fake, an app-shaped client, and the shared steps.
 */
export interface ConformanceContext {
  readonly broker: Broker;
  readonly fake: FakeController;
  /** Replaced after a restart; always read it through the context. */
  readonly client: BrokerClient;
  /** A session Resume may drive: app-created, or stored and idle. */
  drivableSession(title?: string): Promise<DriveSession>;
  /** Open Drive the way the app does and wait until its catalogs arrived. */
  openDrive(session: DriveSession): Promise<SessionStream>;
  /** Send a prompt and wait for its ack/nack. */
  prompt(stream: SessionStream, text: string, extra?: Record<string, unknown>): Promise<Frame>;
  /** Texts of the `session/prompt` frames the fake received for a session. */
  prompted(session: { id: string }, from?: number): string[];
  /** ACP child starts the fake recorded in a session's workspace. */
  childStarts(session: { cwd: string }, from?: number): LedgerEntry[];
  /** Restart the broker on the same state and port. */
  restart(): Promise<void>;
}

/**
 * An adapter-only row that still fits the shared harness: it needs only the
 * fake's ledger, config or store. Runs after the shared scenarios, on the same
 * broker, and must leave the fake as it found it.
 */
export interface ConformanceExtra {
  title: string;
  run(context: ConformanceContext): Promise<void>;
}

/**
 * An extra for a kit whose `replaceLog` writes the session log aside and renames it over the
 * original: an open Observe reader is reset to the same conversation, without waiting for another
 * write. Bun reports such a rename only under the temporary name it was renamed from.
 */
export function replacedLogResetsObserve(agent: string): ConformanceExtra {
  return {
    title: 'an open Observe reader is reset when the log is replaced by rename',
    async run(context) {
      const seeded = context.fake.seedSession({ turns: 2 });
      await context.client.waitForSession((row) => row.id === seeded.id);
      const stream = await context.client.attach(agent, seeded.id);
      await stream.waitForKind('history');
      const from = stream.frames.length;
      context.fake.replaceLog(seeded);
      const reset = await stream.waitForFrame((frame) => frame.kind === 'history' && frame.reset === true,
        { after: from, what: 'a reset after the log was replaced' });
      expect((reset.messages as any[]).filter((message) => message.type === 'user-message').map((message) => message.text))
        .toEqual([seeded.texts[0], seeded.texts[2]]);
      await expectOneResetSince(stream, context.fake, seeded, from);
      stream.close();
    },
  };
}

/**
 * One change to a session's log reaches an open reader as exactly one reset frame, with at most one
 * notice (some adapters reset without one). A turn appended afterwards and read live marks the point
 * by which a second reset for the same change would have arrived.
 */
export async function expectOneResetSince(
  stream: SessionStream,
  fake: FakeController,
  session: { id: string; cwd: string },
  from: number,
): Promise<void> {
  fake.appendTurn(session, 'after the change', 'answer after the change');
  await stream.waitForMessage((message) => message.type === 'model-output'
    && (message.text ?? message.delta) === 'answer after the change');
  const after = stream.frames.slice(from);
  expect(after.filter((frame) => frame.kind === 'history' && frame.reset === true).length).toBe(1);
  expect(after.filter((frame) => frame.kind === 'notice').length).toBeLessThanOrEqual(1);
}

// ------------------------------------------------------------- fake controller

export interface SeededSession {
  id: string;
  /** The native id, when the broker's session id is not it (Codex: the id is the rollout path). */
  nativeId?: string;
  cwd: string;
  title: string;
  /** Visible texts of the seeded conversation, oldest first: [user, answer, ...]. */
  texts: string[];
  /**
   * What the roster publishes as this session's `nativeId` (and its children's `parentThreadId`)
   * when that is neither its row id nor the id the agent itself is told (`nativeId`).
   */
  rosterNativeId?: string;
  /** A fragment of every store path this session owns, when that is not its row id. */
  storeKey?: string;
}

export interface SeedOptions {
  title?: string;
  /** Turns of conversation to write (default 1). */
  turns?: number;
  /** Write a subagent child under this parent (only when `profile.subagents`). */
  childOf?: SeededSession;
}

export interface FakeController {
  readonly ledger: Ledger;
  /** The native store root this fake writes into (the broker's agent home). */
  readonly storeRoot: string;
  /** A fresh workspace directory (absolute, existing). */
  workspace(name?: string): string;
  /** Write a stored native session the broker can discover. */
  seedSession(options?: SeedOptions): SeededSession;
  /** Set the id the next native create answers with (fresh unless given); returns it. */
  prepareCreate(id?: string): string;
  /** A durable turn (user + answer) appended as a terminal would, not through the broker. */
  appendTurn(session: { id: string; cwd: string }, user: string, answer: string): void;
  /** A durable foreign user row appended as a terminal would. */
  appendForeignUser(session: { id: string; cwd: string }, text: string): void;
  /** Append the first half of a durable row with no newline; `completePartial` finishes it. */
  appendPartial(session: { id: string; cwd: string }, text: string): void;
  completePartial(session: { id: string; cwd: string }): void;
  /** Rewrite the log's existing prefix in place (same path). */
  rewriteHistory(session: { id: string; cwd: string }): void;
  /** Replace the log atomically with identical bytes (new inode). */
  replaceLog(session: { id: string; cwd: string }): void;
  /** Touch sidecar files the adapter watches but must not treat as rows. */
  watcherNoise(session: { id: string; cwd: string }): void;
  /** Change what the installed fake reports for `--version`. */
  setVersion(version: string, output?: string): void;
  /** Remove (false) or restore (true) the fake executable. */
  setInstalled(installed: boolean): void;
  /** Let a `[[hold:TAG]]` turn finish. */
  release(tag: string): void;
  /** Merge kit-specific knobs into the fake's re-read config; returns the previous config. */
  configure(patch: Record<string, unknown>): Record<string, unknown>;
  /**
   * Environment for a separate `cosyncing doctor --json` run that sees a fake
   * at `version`, or no fake at all (`missing`), installed in its own
   * directory. `override` selects it through the adapter's explicit path
   * variable instead of PATH, when the adapter has one.
   */
  doctorEnvironment(variant: { version?: string; missing?: true; override?: true }): Record<string, string>;
  /** Every file under the store with its size and mtime: proves a read changed nothing. */
  storeSnapshot(): Map<string, string>;
  /**
   * For an agent whose broker acks a prompt once it is accepted rather than once its turn ends
   * (Claude writes it to the child's stdin and returns): called just before a prompt is sent, and
   * the function it returns is awaited after an ack, resolving once the turn that prompt started
   * has settled. Absent: the ack already means the turn settled.
   */
  promptSettled?(stream: SessionStream, text: string): () => Promise<void>;
  /** The native id behind a broker session id, when the two differ. */
  nativeId?(sessionId: string): string;
  /** Stop anything the fake started that outlives the broker (a daemon, terminals). */
  cleanup?(): Promise<void>;
}

export interface ConformanceKit {
  profile: ConformanceProfile;
  /** Broker environment pointing the adapter at the fake (applied in `startBroker`). */
  env(paths: FixturePaths): Record<string, string>;
  /** Install the fake into `paths` before the broker starts. */
  install(paths: FixturePaths): FakeController | Promise<FakeController>;
  /** Adapter-only rows (inventory "profile extras"). */
  extras?: ConformanceExtra[];
  /**
   * Wait until the native side the broker launches for itself is up (a managed host starts after the
   * broker is healthy). Called after every broker start; absent when the fake is ready at once.
   */
  ready?(context: { broker: Broker; client: BrokerClient; fake: FakeController }): Promise<void>;
}

// --------------------------------------------------------------------- ledger

export interface LedgerEntry {
  at: number;
  pid: number;
  // Kits may record their own kinds (a Codex daemon `connect`, a `writer`); these are the shared ones.
  kind: 'spawn' | 'version-probe' | 'doctor' | 'recv' | 'fault' | 'unimplemented' | 'exit' | (string & {});
  argv?: string[];
  cwd?: string;
  autoUpdateDisabled?: string | null;
  frame?: Record<string, any>;
  [field: string]: unknown;
}

/** The fake's append-only record of what the product did to it. */
export class Ledger {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    if (!existsSync(path)) writeFileSync(path, '');
  }

  entries(): LedgerEntry[] {
    const text = readFileSync(this.path, 'utf8');
    const out: LedgerEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as LedgerEntry);
      } catch {
        // A line still being appended by a running fake; the next read has it.
      }
    }
    return out;
  }

  /** A position to read "what happened after this" from. */
  mark(): number {
    return this.entries().length;
  }

  since(mark: number): LedgerEntry[] {
    return this.entries().slice(mark);
  }

  /** ACP child starts (not version probes or one-shot commands). */
  spawns(from = 0): LedgerEntry[] {
    return this.since(from).filter((entry) => entry.kind === 'spawn');
  }

  /** Inbound frames of one method (`session/prompt`, `session/load`, …). */
  requests(method: string, from = 0): LedgerEntry[] {
    return this.since(from).filter((entry) => entry.kind === 'recv' && entry.frame?.method === method);
  }

  /** The text of every `session/prompt` the fake received, in arrival order. */
  promptTexts(from = 0): string[] {
    return this.requests('session/prompt', from).map((entry) =>
      (entry.frame?.params?.prompt ?? []).map((part: { text?: string }) => part.text ?? '').join(''));
  }

  /** Replies the client sent to requests the fake made (permission answers). */
  replies(idPrefix: string, from = 0): LedgerEntry[] {
    return this.since(from).filter((entry) =>
      entry.kind === 'recv' && entry.frame?.method === undefined && String(entry.frame?.id ?? '').startsWith(idPrefix));
  }

  /** Anything the fake could not handle or does not implement: the suite fails if this is not empty. */
  faults(from = 0): LedgerEntry[] {
    return this.since(from).filter((entry) => entry.kind === 'fault' || entry.kind === 'unimplemented');
  }
}

// ------------------------------------------------------- fake executable files

const FAKE_SOURCE_DIR = join(import.meta.dir, 'fakes');

export interface InstalledFake {
  /** The command path the product resolves. */
  path: string;
  /** The JSON config the fake re-reads per launch and per prompt. */
  configPath: string;
  readConfig<T>(): T;
  writeConfig(config: unknown): void;
  /** Hide (false) or restore (true) the executable, keeping its config. */
  setInstalled(installed: boolean): void;
}

/**
 * Install a single-file fake (`kits/fakes/<source>`) as command `name` in
 * `directory`, the one cross-platform way every kit installs a fake:
 *
 *  - POSIX: the file itself with a shebang naming this Bun, so the product
 *    spawns one process that loads one module;
 *  - Windows: a `.cmd` shim next to a copy of the source, which is what the
 *    product's PATHEXT resolution finds for an npm-style agent.
 *
 * The fake reads its config from `<argv[1]>.json`, so it needs no environment
 * variable the product might scrub.
 */
export function installFakeExecutable(
  directory: string,
  name: string,
  source: string,
  config: unknown,
): InstalledFake {
  mkdirSync(directory, { recursive: true });
  const program = readFileSync(join(FAKE_SOURCE_DIR, source), 'utf8').replace(/^#!.*\n/, '');
  let path: string;
  let scriptPath: string;
  if (process.platform === 'win32') {
    scriptPath = join(directory, `${name}.fake.ts`);
    writeFileSync(scriptPath, program);
    path = join(directory, `${name}.cmd`);
    writeFileSync(path, `@"${process.execPath}" "%~dp0${name}.fake.ts" %*\r\n`);
  } else {
    scriptPath = join(directory, name);
    path = scriptPath;
    writeFileSync(path, `#!${process.execPath}\n${program}`);
    chmodSync(path, 0o755);
  }
  const configPath = `${scriptPath}.json`;
  const hidden = `${path}.uninstalled`;
  const installed: InstalledFake = {
    path,
    configPath,
    readConfig: <T>() => JSON.parse(readFileSync(configPath, 'utf8')) as T,
    writeConfig: (next) => writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`),
    setInstalled(present) {
      if (present && existsSync(hidden)) renameSync(hidden, path);
      if (!present && existsSync(path)) renameSync(path, hidden);
    },
  };
  installed.writeConfig(config);
  return installed;
}

// -------------------------------------------------------------------- helpers

/** Size and mtime of every file under `root`, keyed by relative path. */
export function treeSnapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (directory: string): void => {
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(directory, name);
      const info = statSync(path, { throwIfNoEntry: false });
      if (!info) continue;
      if (info.isDirectory()) walk(path);
      else out.set(relative(root, path).split(sep).join('/'), `${info.size}:${info.mtimeMs}`);
    }
  };
  walk(root);
  return out;
}

/**
 * A named pipe at `path` (parents created), for hostile-store cases: a reader that opens it
 * without `O_NONBLOCK` waits for a writer that never comes. POSIX only (`unsupportedOn: ['win32']`).
 */
export function makeFifo(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const made = Bun.spawnSync(['mkfifo', path], { timeout: 10_000, stdout: 'pipe', stderr: 'pipe' });
  if (made.exitCode !== 0) throw new Error(`mkfifo ${path} failed: ${made.stderr.toString()}`);
}

/** A canonical lowercase UUIDv7 (the id shape Grok's store requires). */
export function uuidV7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const now = BigInt(Date.now());
  for (let index = 0; index < 6; index += 1) bytes[index] = Number((now >> BigInt(8 * (5 - index))) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const quietPorts = new Set<number>();

/**
 * A loopback port for a native host the BROKER launches later (a Hub, a serve), taken from below the OS's
 * ephemeral range. An OS-assigned port is released the moment it is leased, and the next lease (the broker's own,
 * a parallel suite's) is often that same number: the broker and the fake then fight for it, and a client talking
 * to "the broker" is answered by the fake's 401. Outside the ephemeral pool the number is not recycled that way.
 */
export async function leaseQuietPort(): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const port = 20_000 + Math.floor(Math.random() * 10_000);
    // Never near the owner's real Cline Hub ports (25463, 25464).
    if (quietPorts.has(port) || (port >= 25_400 && port <= 25_500)) continue;
    try {
      const probe = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } });
      probe.stop(true);
    } catch {
      continue;
    }
    quietPorts.add(port);
    return port;
  }
  throw new Error('no free loopback port in the quiet range');
}
