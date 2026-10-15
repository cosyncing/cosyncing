/**
 * Codex conformance kit: the product default on Linux and macOS, where Drive,
 * Create and terminal sync all go through the shared Codex app-server daemon
 * (`driveFamily: 'live-host'`). Any stored, idle session may be driven.
 *
 * The fake (`fakes/codex-app-server.ts`) is compiled into the fixture's `bin`
 * as a real `codex` executable, and the kit starts its managed daemon before
 * the broker does, the way a user's machine has one running: the broker finds
 * it through the fixture's `CODEX_HOME` control socket and PID receipt. Never
 * the host's `~/.codex` or a real daemon: the fixture HOME owns CODEX_HOME, and
 * the fixture PATH holds no real `codex`.
 *
 * The Codex app-server speaks its own JSON-RPC (`thread/start`,
 * `thread/resume`, `turn/start`, `turn/steer`, `turn/interrupt`). The kit's
 * ledger answers the conformance vocabulary over those native frames:
 *
 *   session/new     ← thread/start
 *   session/load    ← thread/resume
 *   session/prompt  ← turn/start and turn/steer (a skill input reads `/<name>`)
 *   session/cancel  ← turn/interrupt
 *   spawn           ← a writer: a connection (or stdio process) that started or
 *                     resumed a thread. A daemon connection's writer id is the
 *                     negated `pid * 10000 + connection serial`, so it never
 *                     equals a process id.
 *
 * Every normalized entry keeps the raw frame as `frame.native`.
 */
import { expect } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  linkSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { fixturePath, type FixturePaths, type SessionStream } from '../../harness/index.ts';
import { installFakeExecutable as compileFakeExecutable } from '../../harness/fakes/executable.ts';
import {
  answerRecords,
  appendRecords,
  appendThreadName,
  codexRolloutPath,
  codexSessionId,
  codexUuid,
  defaultCodexSettings,
  type FakeCodexAppServerConfig,
  sessionMetaRecord,
  turnCompleteRecords,
  turnOpenRecords,
  userRecords,
} from './fakes/codex-app-server.ts';
import {
  type ConformanceContext,
  type ConformanceExtra,
  type ConformanceKit,
  type ConformanceProfile,
  type FakeController,
  Ledger,
  type LedgerEntry,
  type SeededSession,
  type SeedOptions,
  treeSnapshot,
} from './kit.ts';

const FAKE_ENTRY = join(import.meta.dir, 'fakes', 'codex-app-server.ts');
const CODEX_VERSION = '0.162.1';

export const codexProfile: ConformanceProfile = {
  agent: 'codex',
  displayName: 'Codex',
  capabilities: {
    integrationKind: 'jsonrpc-stdio',
    attachModes: ['live', 'resume', 'observe'],
    supportsObserve: true,
    supportsResume: true,
    supportsLiveAttach: true,
    supportsCrossClientDriveSharing: true,
    supportsNativeArtifact: false,
    supportsNativeFileInput: true,
    supportsModelSwitch: true,
    permissionGranularity: 'per-tool',
  },
  driveFamily: 'live-host',
  driveEligibility: 'stored-idle',
  version: {
    current: CODEX_VERSION,
    below: '0.144.4',
    newer: '0.170.0',
    newerDrives: true,
    cachedByBroker: false,
    doctor: {
      current: { check: 'version', status: 'pass', detailCode: 'version-supported' },
      below: { check: 'version', status: 'fail', detailCode: 'version-below-minimum' },
      newer: { check: 'version', status: 'pass', detailCode: 'version-supported' },
      missing: { check: 'binary', status: 'warn', detailCode: 'binary-missing' },
    },
  },
  catalog: {
    models: ['openai/gpt-5.6-sol', 'openai/gpt-5.6-spark'],
    modes: ['ask-permission', 'approve-for-me', 'full-access'],
    // `review` is a workspace skill (a prompt command); the rest are Codex's built-in actions.
    commands: ['review', 'stop', 'compact', 'goal'],
    stopCommand: 'stop',
    switchModel: { providerID: 'openai', modelID: 'gpt-5.6-spark' },
    createModel: { providerID: 'openai', modelID: 'gpt-5.6-sol', reasoningEffort: 'high' },
  },
  driveArgv: {
    // The writer is a connection to the user's daemon; its argv is the daemon's own.
    required: ['app-server', '--listen'],
    forbidden: ['--dangerously-bypass-approvals-and-sandbox', '--yolo'],
  },
  createChildAdopted: false,
  userRowDurable: 'turn-start',
  promptEcho: 'native',
  // Codex rollouts keep no app-send token: only the live `item/started` echo carries clientKey.
  historyClientKey: false,
  midTurnPrompt: 'steered',
  modelSwitch: 'per-turn',
  nativePermission: { approveOnce: { decision: 'accept' }, answerMentions: 'permission accept' },
  // The full hint (`cd <cwd> && codex resume --remote unix://<socket> -m <model> <id>`) is an extra.
  terminal: { resumeHint: 'codex resume --remote unix://', syncAvailable: true },
  subagents: true,
  missingBinaryRoster: 'observe-only',
  knownBugs: {
    C11: 'Codex acks a permission decision for an unknown or already-settled request id and drops it '
      + '(respondPermission ignores ids it does not hold), where it should refuse it',
    C19: 'Codex acks an unknown command and drops it (runCommand has no refusal), where it should refuse it',
    C07: 'Create trusts the path thread/start answers: one naming a rollout already in the store is accepted '
      + 'and claimed as app-created, with no freshness check',
    C21: 'Codex attach decodes any base64url path and reads it as a rollout, with no check that it is a listed '
      + 'rollout under $CODEX_HOME/sessions: a withheld or outside-the-store path still yields history',
  },
  scenarios: {
    C06: {
      skip: 'Codex rollouts are append-only and the Observe tail reads them by offset: a rewritten prefix is '
        + 'not detected, so there is no reset to assert (recorded in the coverage map).',
    },
    C14: {
      skip: 'Codex Drive is the app-server thread itself, and a terminal joins it through the same daemon '
        + '(true sync, see the presence extras), so a durable user row written by another client is not a '
        + 'competing writer: the Drive connection never tails the rollout.',
    },
    C15: {
      skip: 'Codex Drive reads its turns from the app-server, not the rollout, so a replaced or rewritten '
        + 'rollout changes nothing the writer relies on.',
    },
    C16: {
      skip: 'Codex has no runtime version gate: the 0.144.5 floor is advisory and reported only by doctor '
        + '(C22 asserts the verdicts); Create and Resume are not gated by the broker.',
    },
  },
  // Codex discovery tags rather than drops (every `rollout-*.jsonl` it can stat is listed, with or
  // without session_meta, and a session_meta naming another thread is believed): the shapes it withholds
  // are the ones it cannot stat. The lenient shapes are open questions in the coverage map.
  hostileStore: [
    {
      name: 'an id naming a rollout outside the store',
      plant: (fake) => {
        const id = codexUuid();
        const cwd = fake.workspace('outside');
        const path = codexRolloutPath(join(cwd, 'not-codex-home'), id);
        appendRecords(path, [
          sessionMetaRecord({ id, cwd }),
          ...turnOpenRecords(`turn-outside-${id.slice(-6)}`, cwd, defaultCodexSettings(cwd)),
          ...userRecords('a row from outside the store'),
        ]);
        return codexSessionId(path);
      },
    },
    {
      name: 'a dangling symlink named like a rollout',
      unsupportedOn: ['win32'],
      plant: (fake) => {
        const path = codexRolloutPath(fake.storeRoot, codexUuid());
        mkdirSync(join(path, '..'), { recursive: true });
        symlinkSync(join(fake.workspace('gone'), 'missing.jsonl'), path);
        return codexSessionId(path);
      },
    },
    {
      name: 'a FIFO named like a rollout',
      unsupportedOn: ['win32'],
      knownBug: 'discovery opens the FIFO synchronously (readFirstLine → openSync) and blocks the broker '
        + 'event loop until a writer appears: the roster, and every socket, wedge',
      plant: (fake) => {
        const id = codexUuid();
        const path = codexRolloutPath(fake.storeRoot, id);
        mkdirSync(join(path, '..'), { recursive: true });
        const made = Bun.spawnSync(['mkfifo', path], { timeout: 5_000 });
        if (made.exitCode !== 0) throw new Error(`mkfifo failed: ${made.stderr.toString()}`);
        return codexSessionId(path);
      },
    },
  ],
};

// --------------------------------------------------------------------- ledger

const CONFORMANCE_METHODS: Record<string, string[]> = {
  'session/new': ['thread/start'],
  'session/load': ['thread/resume'],
  'session/prompt': ['turn/start', 'turn/steer'],
  'session/cancel': ['turn/interrupt'],
};

/** The text a turn input carries; a skill invocation reads as its slash command. */
export function codexInputText(input: unknown): string {
  if (!Array.isArray(input)) return '';
  return input
    .map((part: any) => (part?.type === 'skill' ? `/${String(part.name)}` : String(part?.text ?? '')))
    .filter(Boolean)
    .join(' ');
}

/** The fake's raw ledger, read in the conformance vocabulary (see the file header). */
export class CodexLedger extends Ledger {
  static writerId(entry: LedgerEntry): number {
    return entry.transport === 'daemon' ? -(entry.pid * 10_000 + Number(entry.conn)) : entry.pid;
  }

  override spawns(from = 0): LedgerEntry[] {
    return this.since(from)
      .filter((entry) => entry.kind === 'writer')
      .map((entry) => ({ ...entry, kind: 'spawn' as const, pid: CodexLedger.writerId(entry) }));
  }

  override requests(method: string, from = 0): LedgerEntry[] {
    const native = CONFORMANCE_METHODS[method];
    if (!native) return this.nativeRequests(method, from);
    return this.since(from)
      .filter((entry) => entry.kind === 'recv' && native.includes(entry.frame?.method))
      .map((entry) => {
        const params = entry.frame?.params ?? {};
        return {
          ...entry,
          pid: CodexLedger.writerId(entry),
          frame: {
            id: entry.frame?.id,
            method,
            params: {
              sessionId: params.threadId,
              cwd: params.cwd,
              prompt: params.input === undefined ? undefined : [{ text: codexInputText(params.input) }],
            },
            native: entry.frame,
          },
        };
      });
  }

  /** Inbound frames of one native method, as the fake recorded them. */
  nativeRequests(method: string, from = 0): LedgerEntry[] {
    return this.since(from)
      .filter((entry) => entry.kind === 'recv' && entry.frame?.method === method)
      .map((entry) => ({ ...entry, pid: CodexLedger.writerId(entry) }));
  }

  override replies(idPrefix: string, from = 0): LedgerEntry[] {
    return super.replies(idPrefix, from).map((entry) => ({ ...entry, pid: CodexLedger.writerId(entry) }));
  }

  /** Terminal clients (`codex resume …`) the fake started. */
  terminals(from = 0): LedgerEntry[] {
    return this.since(from).filter((entry) => entry.kind === 'terminal-start');
  }
}

// -------------------------------------------------------------- fake control

export interface CodexFake extends FakeController {
  readonly ledger: CodexLedger;
  readonly executable: string;
  readonly codexHome: string;
  readonly socketPath: string;
  /** The rollout behind a broker session id. */
  rolloutOf(sessionId: string): string;
  /** Start a terminal client (`codex <argv>`) as a user would; killed by `cleanup()`. */
  startTerminal(argv: string[], cwd: string): Bun.Subprocess;
  /** The running daemon's pid, from its PID receipt. */
  daemonPid(): number | undefined;
  /** Start the managed daemon the way a user does (`codex app-server daemon start`). */
  startDaemon(): void;
  /** Kill the daemon outright, as a crash would (its socket and receipt stay behind). */
  crashDaemon(): void;
}

const decodeSessionId = (sessionId: string): string => Buffer.from(sessionId, 'base64url').toString('utf8');
const uuidOfRollout = (path: string): string => basename(path).replace(/^rollout-.*?-([0-9a-f-]{36})\.jsonl$/i, '$1');

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== 'linux') return true;
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(')').at(-1)!.trim()[0] !== 'Z';
  } catch {
    return false;
  }
}

function waitUntil(probe: () => boolean, what: string, timeoutMs = 20_000): void {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    Bun.sleepSync(20);
  }
}

export const codexKit: ConformanceKit = {
  profile: codexProfile,
  get extras() {
    return codexExtras;
  },
  env: (paths) => ({
    // The fixture HOME already implies this; naming it keeps the isolation explicit.
    CODEX_HOME: join(paths.home, '.codex'),
    // The presence/loaded-set watcher at its floor, so a terminal joining or leaving shows within a poll.
    COSYNCING_CODEX_SYNC_WATCH_MS: '250',
  }),
  install(paths: FixturePaths): CodexFake {
    const codexHome = join(paths.home, '.codex');
    const installRoot = join(paths.root, 'fakes', 'codex');
    const controlDir = join(installRoot, 'control');
    mkdirSync(join(codexHome, 'sessions'), { recursive: true });
    mkdirSync(controlDir, { recursive: true });
    writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-5.6-sol"\n');
    const ledger = new CodexLedger(join(installRoot, 'ledger.jsonl'));
    const executable = compileFakeExecutable(paths.bin, 'codex', FAKE_ENTRY);
    const configPath = `${executable}.json`;
    const baseConfig: FakeCodexAppServerConfig = {
      ledger: ledger.path,
      controlDir,
      version: CODEX_VERSION,
      // The argv a ≥0.161 managed daemon runs with (measured on 0.162.1); the analytics flag is new in 0.161.
      daemonArgv: ['app-server', '--remote-control', '--listen', 'unix://', '--analytics-default-enabled', '--managed-daemon'],
      models: [
        { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
        { id: 'gpt-5.6-spark', displayName: 'GPT-5.6 Spark', efforts: ['low', 'medium'], defaultEffort: 'low' },
      ],
      skills: [{ name: 'review', description: 'Review the current diff' }],
    };
    const readConfig = (): FakeCodexAppServerConfig => JSON.parse(readFileSync(configPath, 'utf8'));
    const writeConfig = (config: FakeCodexAppServerConfig): void => {
      const pending = `${configPath}.kit`;
      writeFileSync(pending, `${JSON.stringify(config, null, 2)}\n`);
      renameSync(pending, configPath);
    };
    writeConfig(baseConfig);
    const daemonEnv = {
      HOME: paths.home,
      CODEX_HOME: codexHome,
      PATH: fixturePath(paths.bin),
      ...(process.platform === 'win32' ? { USERPROFILE: paths.home } : {}),
    };
    const terminals: Bun.Subprocess[] = [];
    let workspaces = 0;
    let doctorVariants = 0;
    const partials = new Map<string, string>();

    const receiptPid = (): number | undefined => {
      try {
        const pid = JSON.parse(readFileSync(join(codexHome, 'app-server-daemon', 'app-server.pid'), 'utf8'))?.pid;
        return typeof pid === 'number' ? pid : undefined;
      } catch {
        return undefined;
      }
    };
    const daemonPids = (): number[] => ledger.entries().filter((entry) => entry.kind === 'daemon-started').map((entry) => entry.pid);

    const controller: CodexFake = {
      ledger,
      executable,
      codexHome,
      storeRoot: codexHome,
      socketPath: join(codexHome, 'app-server-control', 'app-server-control.sock'),
      workspace(name = 'workspace') {
        const directory = join(paths.root, 'workspaces', `${name}-${++workspaces}`);
        mkdirSync(directory, { recursive: true });
        return directory;
      },
      nativeId: (sessionId) => uuidOfRollout(decodeSessionId(sessionId)),
      rolloutOf: decodeSessionId,
      seedSession(options: SeedOptions = {}): SeededSession {
        const nativeId = codexUuid();
        const cwd = options.childOf?.cwd ?? controller.workspace('seed');
        const path = codexRolloutPath(codexHome, nativeId);
        const title = options.title ?? `Codex seeded ${nativeId.slice(-6)}`;
        const settings = defaultCodexSettings(cwd);
        const texts: string[] = [];
        const records = [sessionMetaRecord({
          id: nativeId,
          cwd,
          ...(options.childOf ? { threadSource: 'subagent', parentThreadId: options.childOf.nativeId } : {}),
        })];
        for (let turn = 1; turn <= (options.turns ?? 1); turn += 1) {
          const user = `seeded prompt ${turn}`;
          const answer = `seeded answer ${turn}`;
          texts.push(user, answer);
          const turnId = `turn-seed-${nativeId.slice(-6)}-${turn}`;
          records.push(
            ...turnOpenRecords(turnId, cwd, settings),
            ...userRecords(user),
            ...answerRecords(answer, `msg_seed_${nativeId.slice(-6)}_${turn}`),
            ...turnCompleteRecords(turnId, answer),
          );
        }
        appendRecords(path, records);
        appendThreadName(codexHome, nativeId, title);
        return { id: codexSessionId(path), nativeId, cwd, title, texts };
      },
      prepareCreate(id) {
        const next = readConfig();
        if (id) {
          const path = decodeSessionId(id);
          writeConfig({ ...next, nextThreadId: uuidOfRollout(path), nextThreadPath: path });
          return id;
        }
        const nativeId = codexUuid();
        const path = codexRolloutPath(codexHome, nativeId);
        writeConfig({ ...next, nextThreadId: nativeId, nextThreadPath: path });
        return codexSessionId(path);
      },
      appendTurn(session, user, answer) {
        const path = decodeSessionId(session.id);
        const turnId = `turn-ext-${codexUuid().slice(-12)}`;
        appendRecords(path, [
          ...turnOpenRecords(turnId, session.cwd, defaultCodexSettings(session.cwd)),
          ...userRecords(user),
          ...answerRecords(answer, `msg_ext_${codexUuid().slice(-12)}`),
          ...turnCompleteRecords(turnId, answer),
        ]);
      },
      appendForeignUser(session, text) {
        const turnId = `turn-foreign-${codexUuid().slice(-12)}`;
        appendRecords(decodeSessionId(session.id), [
          ...turnOpenRecords(turnId, session.cwd, defaultCodexSettings(session.cwd)),
          ...userRecords(text),
        ]);
      },
      appendPartial(session, text) {
        const path = decodeSessionId(session.id);
        const turnId = `turn-partial-${codexUuid().slice(-12)}`;
        partials.set(session.id, turnId);
        const [pairHead, event] = userRecords(text);
        appendRecords(path, [...turnOpenRecords(turnId, session.cwd, defaultCodexSettings(session.cwd)), pairHead!]);
        appendFileSync(path, JSON.stringify(event));
      },
      completePartial(session) {
        const path = decodeSessionId(session.id);
        const turnId = partials.get(session.id)!;
        partials.delete(session.id);
        appendFileSync(path, '\n');
        appendRecords(path, [...answerRecords('partial answer', `msg_partial_${turnId.slice(-12)}`), ...turnCompleteRecords(turnId, 'partial answer')]);
      },
      rewriteHistory(session) {
        const path = decodeSessionId(session.id);
        const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
        let rewritten = 0;
        for (const line of lines) {
          if (rewritten >= 2) break;
          if (line.type === 'event_msg' && line.payload?.type === 'user_message') {
            line.payload.message = 'rewritten first prompt';
            rewritten += 1;
          } else if (line.type === 'response_item' && line.payload?.role === 'user') {
            line.payload.content = [{ type: 'input_text', text: 'rewritten first prompt' }];
            rewritten += 1;
          }
        }
        writeFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
      },
      replaceLog(session) {
        const path = decodeSessionId(session.id);
        writeFileSync(`${path}.tmp`, readFileSync(path));
        renameSync(`${path}.tmp`, path);
      },
      watcherNoise(session) {
        // A metadata-only touch of the rollout, and a write to the index Codex keeps beside it.
        const path = decodeSessionId(session.id);
        const now = new Date();
        utimesSync(path, now, now);
        appendThreadName(codexHome, uuidOfRollout(path), `renamed ${now.getTime()}`);
      },
      setVersion(version, output) {
        const next = { ...readConfig(), version };
        if (output === undefined) delete next.versionOutput;
        else next.versionOutput = output;
        writeConfig(next);
      },
      setInstalled(installed) {
        const hidden = `${executable}.uninstalled`;
        if (installed && existsSync(hidden)) renameSync(hidden, executable);
        if (!installed && existsSync(executable)) renameSync(executable, hidden);
      },
      release(tag) {
        writeFileSync(join(controlDir, `release-${tag}`), '');
      },
      configure(patch) {
        const previous = readConfig() as unknown as Record<string, unknown>;
        writeConfig({ ...previous, ...patch } as unknown as FakeCodexAppServerConfig);
        return previous;
      },
      doctorEnvironment(variant) {
        const base = fixturePath(join(paths.root, 'no-agents'));
        if (variant.missing) return { PATH: base, COSYNCING_CODEX_BIN: '' };
        const directory = join(installRoot, `doctor-${++doctorVariants}`);
        mkdirSync(directory, { recursive: true });
        const copy = join(directory, basename(executable));
        // The same compiled program under another name; it reads `<itself>.json`.
        try {
          linkSync(executable, copy);
        } catch {
          copyFileSync(executable, copy);
        }
        writeFileSync(`${copy}.json`, JSON.stringify({ ...readConfig(), version: variant.version ?? CODEX_VERSION }));
        return variant.override
          ? { PATH: base, COSYNCING_CODEX_BIN: copy }
          : { PATH: [directory, base].join(delimiter), COSYNCING_CODEX_BIN: '' };
      },
      // The session store only: the daemon's socket and receipt are runtime state, not sessions.
      storeSnapshot: () => {
        const snapshot = treeSnapshot(join(codexHome, 'sessions'));
        const index = join(codexHome, 'session_index.jsonl');
        if (existsSync(index)) snapshot.set('session_index.jsonl', readFileSync(index, 'utf8'));
        return snapshot;
      },
      startTerminal(argv, cwd) {
        const child = Bun.spawn([executable, ...argv], {
          cwd,
          env: daemonEnv,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        });
        terminals.push(child);
        return child;
      },
      daemonPid: () => {
        const pid = receiptPid();
        return pid !== undefined && processAlive(pid) ? pid : undefined;
      },
      startDaemon() {
        const started = Bun.spawnSync([executable, 'app-server', 'daemon', 'start'], {
          env: daemonEnv,
          cwd: paths.home,
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 30_000,
        });
        if (started.exitCode !== 0) {
          throw new Error(`fake Codex daemon did not start (exit ${started.exitCode}): ${started.stderr.toString()}`);
        }
        waitUntil(() => controller.daemonPid() !== undefined, 'the fake Codex daemon receipt');
      },
      crashDaemon() {
        const pid = controller.daemonPid();
        if (pid === undefined) return;
        process.kill(pid, 'SIGKILL');
        waitUntil(() => !processAlive(pid), `fake Codex daemon ${pid} to die`);
      },
      async cleanup() {
        for (const child of terminals) {
          if (child.exitCode === null) child.kill('SIGKILL');
        }
        await Promise.all(terminals.map((child) => child.exited.catch(() => undefined)));
        // Only daemons this fake started (named in its own ledger) are ever signalled.
        for (const pid of daemonPids()) {
          if (!processAlive(pid)) continue;
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
      },
    };
    controller.startDaemon();
    return controller;
  },
};

// --------------------------------------------------------------------- extras

/** The roster row for a session, once `predicate` holds. */
async function rowWhen(context: ConformanceContext, id: string, predicate: (row: any) => boolean): Promise<any> {
  return context.client.waitForSession((row) => row.id === id && predicate(row));
}

function lastSession(stream: SessionStream): any {
  return stream.frames.findLast((frame) => frame.kind === 'session');
}

const codexExtras: ConformanceExtra[] = [];
