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
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, delimiter, join, relative, sep } from 'node:path';
import { eventually, fixturePath, type FixturePaths, type SessionStream } from '../../harness/index.ts';
import { installFakeExecutable as compileFakeExecutable } from '../../harness/fakes/executable.ts';
import { TestClock } from '../../harness/fakes/test-clock.ts';
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
  makeFifo,
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
  // Codex discovery tags rather than drops (every `rollout-*.jsonl` inside the store it can stat is
  // listed, with or without session_meta, and a session_meta naming another thread is believed): the
  // shapes it withholds are the ones it cannot stat or that resolve outside the store. The lenient
  // shapes are open questions in the coverage map.
  hostileStore: [
    {
      name: 'an id naming a rollout outside the store',
      plant: (fake) => codexSessionId(plantOutsideRollout(fake, 'outside')),
    },
    {
      name: 'an id that climbs out of the store through ..',
      plant: (fake) => {
        const outside = plantOutsideRollout(fake, 'climb');
        // Spelled from inside the store, so only resolving `..` shows where it lands.
        return codexSessionId(`${join(fake.storeRoot, 'sessions')}${sep}..${sep}${relative(fake.storeRoot, outside)}`);
      },
    },
    {
      name: 'a symlink named like a rollout that resolves to a rollout outside the store',
      unsupportedOn: ['win32'],
      plant: (fake) => {
        const outside = plantOutsideRollout(fake, 'linked');
        const path = codexRolloutPath(fake.storeRoot, codexUuid());
        mkdirSync(join(path, '..'), { recursive: true });
        symlinkSync(outside, path);
        return codexSessionId(path);
      },
    },
    {
      name: 'an id naming a file in the store that is not a rollout',
      plant: (fake) => {
        const id = codexUuid();
        const cwd = fake.workspace('not-a-rollout');
        const path = join(fake.storeRoot, 'sessions', `notes-${id}.jsonl`);
        appendRecords(path, [sessionMetaRecord({ id, cwd }), ...userRecords('a row from a file discovery never lists')]);
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
      plant: (fake) => {
        const id = codexUuid();
        const path = codexRolloutPath(fake.storeRoot, id);
        makeFifo(path);
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

function writeConfigFile(path: string, contents: string): void {
  const pending = `${path}.kit`;
  writeFileSync(pending, contents);
  renameSync(pending, path);
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
    ...new TestClock(paths.root).env,
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
      writeConfigFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
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

const codexExtras: ConformanceExtra[] = [{
  title: 'session naming uses the first prompt and observes index-only renames and clears after malformed rows',
  async run({ fake: controller, client }) {
    const fake = controller as CodexFake;
    const session = fake.seedSession({ title: '' });
    await client.waitForSession((row) => row.id === session.id && row.title === 'seeded prompt 1');
    const stream = await client.attach('codex', session.id, { mode: 'observe' });
    await stream.waitForFrame((frame) => frame.kind === 'session' && frame.info?.title === 'seeded prompt 1');
    await stream.waitForFrame((frame) => frame.kind === 'history');
    const index = join(fake.codexHome, 'session_index.jsonl');
    appendFileSync(index, '{broken row\n');
    appendThreadName(fake.codexHome, session.nativeId!, 'Native / 项目.md');
    await client.waitForSession((row) => row.id === session.id && row.title === 'Native / 项目.md');
    await stream.waitForFrame((frame) => frame.kind === 'session' && frame.info?.title === 'Native / 项目.md');
    appendThreadName(fake.codexHome, session.nativeId!, '');
    await client.waitForSession((row) => row.id === session.id && row.title === 'seeded prompt 1');
    fake.appendTurn(session, 'A follow-up', 'An answer');
    await stream.waitForFrame((frame) => frame.kind === 'message'
      && String(frame.message?.text ?? frame.message?.delta ?? '').includes('An answer'));
    await client.waitForSession((row) => row.id === session.id && row.title === 'seeded prompt 1');
    const renamed = await client.request('PATCH', `/api/sessions/codex/${encodeURIComponent(session.id)}/rename`, { title: 'Accepted app rename' });
    expect(renamed.status, renamed.text).toBe(200);
    const afterRename = stream.frames.length;
    for (let pass = 0; pass < 3; pass++) {
      const rows = await client.sessions();
      expect(rows.find((row) => row.id === session.id)?.title).toBe('Accepted app rename');
    }
    await stream.waitForFrame((frame) => frame.kind === 'session' && frame.info?.title === 'Accepted app rename');
    expect(stream.frames.slice(afterRename).filter((frame) => frame.kind === 'session')
      .every((frame) => frame.info.title === 'Accepted app rename')).toBe(true);
    const drive = await client.attach('codex', session.id, { mode: 'resume' });
    await drive.waitForKind('history');
    appendThreadName(fake.codexHome, session.nativeId!, 'New terminal rename');
    expect((await drive.sendAndAwait({ kind: 'prompt', text: '[[hold:naming-terminal]] naming watcher sentinel' })).kind).toBe('ack');
    // A watcher must deliver this without any roster request after the rename.
    await stream.waitForFrame((frame) => frame.kind === 'session' && frame.info?.title === 'New terminal rename');
    fake.release('naming-terminal');
    await drive.waitForFrame((frame) => frame.kind === 'message'
      && String(frame.message?.text ?? frame.message?.delta ?? '').includes('naming watcher sentinel'));
    drive.close();
    stream.close();
  },
}];

codexExtras.push({
  title: 'session naming preserves the accepted name while a clear awaits an unread first prompt',
  async run({ fake: controller, client }) {
    const fake = controller as CodexFake;
    const session = fake.seedSession({ title: 'Before unread clear' });
    const file = decodeSessionId(session.id);
    const original = readFileSync(file, 'utf8');
    const split = original.indexOf('\n') + 1;
    const padding = `${JSON.stringify({ type: 'naming-output', data: 'x'.repeat(256 * 1024) })}\n`;
    writeFileSync(file, original.slice(0, split) + padding.repeat(80) + original.slice(split));
    await client.waitForSession((row) => row.id === session.id && row.title === 'Before unread clear');
    const clear = await client.request('PATCH', `/api/sessions/codex/${encodeURIComponent(session.id)}/rename`, { title: null });
    expect(clear.status, clear.text).toBe(200);
    expect(clear.body.session.titlePending).toBe(true);
    expect(clear.body.session.title).toBe('Before unread clear');
    try {
      await client.waitForSession((row) => row.id === session.id && !row.titlePending && row.title === 'seeded prompt 1');
    } catch (error) {
      console.error('pending clear diagnostics', JSON.stringify({
        row: (await client.sessions({ refresh: true, window: 'all' })).find((row) => row.id === session.id),
        index: readFileSync(join(fake.codexHome, 'session_index.jsonl'), 'utf8').slice(-2000),
        ledger: fake.ledger.since(0).slice(-15),
      }));
      throw error;
    }
    await eventually(() => readFileSync(join(fake.codexHome, 'session_index.jsonl'), 'utf8').split('\n').filter(Boolean)
      .flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })
      .findLast((row) => row.id === session.nativeId)?.thread_name === 'seeded prompt 1',
    { what: 'the cleared name to finish its native first-prompt replacement' });
  },
}, {
  title: 'session naming keeps a child label pending while its native name is outside the scanned index prefix',
  async run({ fake: controller, client }) {
    const fake = controller as CodexFake;
    const parent = fake.seedSession();
    const child = fake.seedSession({ childOf: parent, title: 'Child native name', turns: 0 });
    const file = decodeSessionId(child.id);
    const records = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    records[0].payload.agent_nickname = 'Fallback child label';
    writeFileSync(file, `${records.map((row) => JSON.stringify(row)).join('\n')}\n`);
    const index = join(fake.codexHome, 'session_index.jsonl');
    const original = readFileSync(index, 'utf8');
    const padding = `${JSON.stringify({ type: 'naming-output', data: 'x'.repeat(256 * 1024) })}\n`;
    writeFileSync(index, padding.repeat(192) + original);
    try {
      const first = (await client.sessions({ refresh: true, window: 'all' })).find((row) => row.id === child.id)!;
      expect(first.titlePending).toBe(true);
      await client.waitForSession((row) => row.id === child.id && !row.titlePending && row.title === 'Child native name');
    } finally { writeFileSync(index, original); }
  },
});

codexExtras.push({
  title: 'session naming waits for acknowledged metadata persistence without assigning a temporary name',
  async run({ fake: controller, client }) {
    const fake = controller as CodexFake;
    const configPath = `${fake.executable}.json`;
    const original = JSON.parse(readFileSync(configPath, 'utf8'));
    try {
      writeConfigFile(configPath, JSON.stringify({ ...original, metadataPersistence: true, metadataPersistenceGate: 'naming-flush' }));
      const id = fake.prepareCreate();
      const mark = fake.ledger.mark();
      const creating = client.post('/api/sessions/codex', { directory: fake.workspace('delayed-unnamed') });
      await eventually(() => fake.ledger.nativeRequests('thread/read', mark)
        .some((entry) => entry.frame?.params.threadId === uuidOfRollout(fake.rolloutOf(id)) && entry.frame?.params.includeTurns === undefined),
      { what: 'the native metadata persistence barrier' });
      expect(fake.ledger.nativeRequests('thread/name/set', mark)).toEqual([]);
      fake.release('naming-flush');
      const created = await creating;
      expect(created.status, created.text).toBe(200);
      expect(created.body.session.title).toBe('');
      expect(existsSync(fake.rolloutOf(id))).toBe(true);
      expect(fake.ledger.nativeRequests('thread/name/set', mark)).toEqual([]);
    } finally { writeConfigFile(configPath, JSON.stringify(original)); }
  },
});

codexExtras.push({
  title: 'session naming write failures preserve an already-created durable thread and settle rejected provenance',
  async run({ fake: controller, client, broker }) {
    const fake = controller as CodexFake;
    const configPath = `${fake.executable}.json`;
    const original = JSON.parse(readFileSync(configPath, 'utf8'));
    try {
      writeConfigFile(configPath, JSON.stringify({ ...original, metadataPersistence: true,
        faults: { ...original.faults, rejectNameWrites: true } }));
      const id = fake.prepareCreate();
      const mark = fake.ledger.mark();
      const created = await client.post('/api/sessions/codex', { directory: fake.workspace('refused-name'), title: 'Requested title' });
      expect(created.status, created.text).toBe(200);
      expect(created.body.session.id).toBe(id);
      expect(created.body.session.title).toBe('');
      expect(existsSync(fake.rolloutOf(id))).toBe(true);
      expect(fake.ledger.nativeRequests('thread/start', mark)).toHaveLength(1);
      const metadataPath = join(broker.paths.home, '.cache', 'cosyncing', 'session-metadata.json');
      const key = `codex\0${created.body.session.nativeId}`;
      expect(JSON.parse(readFileSync(metadataPath, 'utf8')).provenance[key]?.provisionalName).toBeUndefined();
      const observe = await client.attach('codex', id, { mode: 'observe' });
      await observe.waitForKind('history');
      observe.close();

      writeConfigFile(configPath, JSON.stringify({ ...original, metadataPersistence: false,
        faults: { ...original.faults, rejectNameWrites: true, persistBeforeRejectedName: true } }));
      const rejectedId = fake.prepareCreate();
      const rejected = await client.post('/api/sessions/codex', { directory: fake.workspace('refused-provisional') });
      expect(rejected.status, rejected.text).toBe(200);
      expect(rejected.body.session.id).toBe(rejectedId);
      expect(rejected.body.session.title).toBe('');
      expect(existsSync(fake.rolloutOf(rejectedId))).toBe(true);
      const rejectedKey = `codex\0${rejected.body.session.nativeId}`;
      expect(JSON.parse(readFileSync(metadataPath, 'utf8')).provenance[rejectedKey]?.provisionalName).toBeUndefined();

      writeConfigFile(configPath, JSON.stringify({ ...original, metadataPersistence: false,
        faults: { ...original.faults, nameWriteAppliedThenError: true, resumeNameNull: true } }));
      const ambiguousId = fake.prepareCreate();
      const ambiguous = await client.post('/api/sessions/codex', { directory: fake.workspace('accepted-name-error') });
      expect(ambiguous.status, ambiguous.text).toBe(200);
      expect(ambiguous.body.session.id).toBe(ambiguousId);
      expect(ambiguous.body.session.title).toBe('');
      expect(existsSync(fake.rolloutOf(ambiguousId))).toBe(true);
      const ambiguousKey = `codex\0${ambiguous.body.session.nativeId}`;
      expect(JSON.parse(readFileSync(metadataPath, 'utf8')).provenance[ambiguousKey]?.provisionalName?.value).toBe('Untitled session');
      const drive = await client.attach('codex', ambiguousId, { mode: 'resume' });
      await drive.waitForKind('history');
      expect(drive.ofKind('session').every((frame) => frame.info.title !== 'Untitled session')).toBe(true);
      expect(JSON.parse(readFileSync(metadataPath, 'utf8')).provenance[ambiguousKey]?.provisionalName?.value).toBe('Untitled session');
      drive.close();
    } finally { writeConfigFile(configPath, JSON.stringify(original)); }
  },
});

codexExtras.push({
  title: 'session naming completes an unnamed durable create after an offline first prompt and preserves a user rename',
  async run({ fake: controller, client, broker }) {
    const fake = controller as CodexFake;
    const id = fake.prepareCreate();
    const created = await client.post('/api/sessions/codex', { directory: fake.workspace('unnamed-create') });
    expect(created.status, created.text).toBe(200);
    expect(created.body.session.title).toBe('');
    expect(created.body.session.id).toBe(id);
    expect(existsSync(fake.rolloutOf(id))).toBe(true);
    const stream = await client.attach('codex', id, { mode: 'observe' });
    await stream.waitForFrame((frame) => frame.kind === 'session' && frame.info?.title === '');
    stream.close();
    const metadataPath = join(broker.paths.home, '.cache', 'cosyncing', 'session-metadata.json');
    const key = `codex\0${created.body.session.nativeId}`;
    await broker.stop({ keepState: true });
    // One bounded fixture write models provenance pressure accumulated while this session is idle.
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    expect(metadata.provenance[key].provisionalName).toEqual({ value: 'Untitled session', origin: 'automatic' });
    for (let n = 0; n < 1005; n++) metadata.provenance[`fixture\0newer-${n}`] = { launchSurface: 'app', appCreatedAt: Date.now() + n };
    writeFileSync(metadataPath, JSON.stringify(metadata));
    await broker.start();
    // A subsequent app create exercises the actual eviction policy, rather than a private helper.
    fake.prepareCreate();
    expect((await client.post('/api/sessions/codex', { directory: fake.workspace('eviction'), title: 'Explicit title' })).status).toBe(200);
    expect(JSON.parse(readFileSync(metadataPath, 'utf8')).provenance[key].provisionalName.value).toBe('Untitled session');
    await broker.stop({ keepState: true });
    fake.appendTurn({ id, cwd: created.body.session.cwd }, '  First external 🧪 prompt\nwith whitespace  ', 'Done');
    const configPath = `${fake.executable}.json`;
    const unavailable = JSON.parse(readFileSync(configPath, 'utf8'));
    writeConfigFile(configPath, JSON.stringify({ ...unavailable, faults: { ...unavailable.faults, unidentifiedTitleRead: true } }));
    await broker.start();
    await client.waitForSession((row) => row.id === id && row.title === 'First external 🧪 prompt with whitespace');
    await eventually(() => fake.ledger.entries().some((entry) => entry.kind === 'title-read-unidentified'
      && entry.threadId === created.body.session.nativeId), { what: 'the native unidentified-name failure' });
    const reads = () => fake.ledger.nativeRequests('thread/read').filter((entry) =>
      entry.frame?.params.threadId === created.body.session.nativeId && entry.frame?.params.includeTurns === undefined);
    const failedReadCount = reads().length;
    for (let pass = 0; pass < 3; pass++) await client.sessions({ refresh: true });
    expect(reads()).toHaveLength(failedReadCount);
    expect(reads().every((entry) => entry.transport === 'daemon')).toBe(true);
    expect(JSON.parse(readFileSync(metadataPath, 'utf8')).provenance[key].provisionalName.value).toBe('Untitled session');
    const available = JSON.parse(readFileSync(configPath, 'utf8'));
    writeConfigFile(configPath, JSON.stringify({ ...available, faults: { ...available.faults, unidentifiedTitleRead: false } }));
    new TestClock(broker.paths.root).advance(120_001);
    await client.waitForSession((row) => row.id === id && row.title === 'First external 🧪 prompt with whitespace');
    await eventually(() => !JSON.parse(readFileSync(metadataPath, 'utf8')).provenance[key]?.provisionalName, { what: 'automatic name completion persisted' });
    const names = readFileSync(join(fake.codexHome, 'session_index.jsonl'), 'utf8');
    expect(names).toContain('First external 🧪 prompt with whitespace');
    fake.appendTurn({ id, cwd: created.body.session.cwd }, 'Later prompt never renames', 'Done again');
    const followed = await client.attach('codex', id, { mode: 'observe' });
    await followed.waitForFrame((frame) => frame.kind === 'history' && frame.messages.some((message: any) =>
      String(message.text ?? message.delta ?? '').includes('Done again')));
    followed.close();
    await client.waitForSession((row) => row.id === id && row.title === 'First external 🧪 prompt with whitespace');

    const namedId = fake.prepareCreate();
    const unnamed = await client.post('/api/sessions/codex', { directory: fake.workspace('cancel-automatic') });
    expect(unnamed.status, unnamed.text).toBe(200);
    const renamed = await client.request('PATCH', `/api/sessions/codex/${encodeURIComponent(namedId)}/rename`, { title: 'Explicit / 用户.md' });
    expect(renamed.status, renamed.text).toBe(200);
    fake.appendTurn({ id: namedId, cwd: unnamed.body.session.cwd }, 'Do not replace my name', 'Done');
    await broker.restart();
    await client.waitForSession((row) => row.id === namedId && row.title === 'Explicit / 用户.md');
  },
});

codexExtras.push({
  title: 'session naming prefers native persistence without a provisional title when metadata updates materialize the rollout',
  async run({ fake: controller, client }) {
    const fake = controller as CodexFake;
    const configPath = `${fake.executable}.json`;
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    writeConfigFile(configPath, JSON.stringify({ ...config, metadataPersistence: true }));
    try {
      const id = fake.prepareCreate();
      const mark = fake.ledger.mark();
      const created = await client.post('/api/sessions/codex', { directory: fake.workspace('native-unnamed') });
      expect(created.status, created.text).toBe(200);
      expect(created.body.session.title).toBe('');
      expect(existsSync(fake.rolloutOf(id))).toBe(true);
      const received = fake.ledger.since(mark).filter((entry) => entry.kind === 'recv').map((entry) => entry.frame);
      expect(received.some((frame) => frame?.method === 'thread/metadata/update')).toBe(true);
      expect(received.some((frame) => frame?.method === 'thread/name/set')).toBe(false);
      await client.waitForSession((row) => row.id === id && row.title === '');
    } finally {
      const current = JSON.parse(readFileSync(configPath, 'utf8'));
      writeConfigFile(configPath, JSON.stringify({ ...current, metadataPersistence: config.metadataPersistence }));
    }
  },
});

/** Native requests that write into a thread: its settings, its name (an index row), or a turn. */
const THREAD_WRITES = new Set(['thread/settings/update', 'thread/name/set', 'turn/start', 'turn/steer']);

codexExtras.push({
  title: 'a custom profile launch without an explicit effort keeps its selected model on attach and subsequent prompts',
  async run(context) {
    const fake = context.fake as CodexFake;
    const basePath = join(fake.codexHome, 'config.toml');
    const base = readFileSync(basePath, 'utf8');
    const profilePath = join(fake.codexHome, 'third-party.config.toml');
    const catalogPath = join(fake.codexHome, 'third-party-models.json');
    const selection = { providerID: 'third-party', modelID: 'qwen-fixture', variant: 'third-party' };
    const before = fake.configure({ faults: { resumeConfigReloadsDefaults: true } }) as unknown as FakeCodexAppServerConfig;
    let stream: SessionStream | undefined;
    try {
      writeFileSync(basePath, `${base}\n[model_providers.third-party]\nname = "Third party"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\n`);
      writeFileSync(profilePath, `model_provider = "third-party"\nmodel = "qwen-fixture"\nmodel_catalog_json = ${JSON.stringify(catalogPath)}\n`);
      writeFileSync(catalogPath, JSON.stringify({ models: [{ slug: selection.modelID, display_name: 'Qwen fixture' }] }));
      const created = await context.client.post('/api/sessions/codex', {
        directory: fake.workspace('custom-profile-create'), model: selection,
      });
      expect(created.status, created.text).toBe(200);
      expect(created.body.session.currentModel).toMatchObject(selection);
      stream = await context.client.attach('codex', created.body.session.id, { mode: 'resume' });
      await stream.waitForKind('history');
      expect(lastSession(stream)?.info.currentModel).toMatchObject(selection);
      for (const text of ['First custom profile prompt', 'Keep the selected profile']) {
        const from = stream.frames.length;
        expect((await stream.sendAndAwait({ kind: 'prompt', text })).kind).toBe('ack');
        await stream.waitForFrame((frame) => frame.kind === 'message'
          && frame.message?.type === 'model-output' && frame.message.final === true, { after: from });
      }
      const contexts = readFileSync(fake.rolloutOf(created.body.session.id), 'utf8').trim().split('\n')
        .map((line) => JSON.parse(line)).filter((record) => record.type === 'turn_context');
      expect(contexts.map((record) => record.payload.model)).toEqual([selection.modelID, selection.modelID]);
      expect(lastSession(stream)?.info.currentModel).toMatchObject(selection);
    } finally {
      stream?.close();
      fake.configure({ faults: before.faults });
      writeFileSync(basePath, base);
      rmSync(profilePath, { force: true });
      rmSync(catalogPath, { force: true });
    }
  },
});

codexExtras.push({
  title: 'a new app session applies automatic review before its first prompt despite inherited untrusted workspace defaults',
  async run(context) {
    const fake = context.fake as CodexFake;
    const before = fake.configure({
      threadDefaults: { approvalPolicy: 'untrusted', approvalsReviewer: 'auto_review' },
    }) as unknown as FakeCodexAppServerConfig;
    let stream: SessionStream | undefined;
    try {
      const created = await context.client.post('/api/sessions/codex', {
        directory: fake.workspace('untrusted-create'), title: 'App default in an untrusted workspace',
      });
      expect(created.status, created.text).toBe(200);
      expect(created.body.session.currentMode).toBe('approve-for-me');
      stream = await context.client.attach('codex', created.body.session.id, { mode: 'resume' });
      await stream.waitForKind('history');
      expect(lastSession(stream)?.info.currentMode).toBe('approve-for-me');
      expect((await stream.sendAndAwait({ kind: 'prompt', text: 'First app prompt' })).kind).toBe('ack');
      await stream.waitForMessage((message) => message.type === 'model-output' && message.final === true);
      const contexts = readFileSync(fake.rolloutOf(created.body.session.id), 'utf8').trim().split('\n')
        .map((line) => JSON.parse(line)).filter((record) => record.type === 'turn_context');
      expect(contexts.at(-1)?.payload.approval_policy).toBe('on-request');
      expect(contexts.at(-1)?.payload.approvals_reviewer).toBe('auto_review');
      expect(contexts.at(-1)?.payload.sandbox_policy.type).toBe('workspace-write');
    } finally {
      stream?.close();
      fake.configure({ threadDefaults: before.threadDefaults });
    }
  },
});

codexExtras.push({
  title: 'an untrusted approval policy still shows Ask permission with an automatic reviewer, and an explicit app pick enables auto-review',
  async run(context) {
    const fake = context.fake as CodexFake;
    const session = fake.seedSession({ title: 'Untrusted workspace with automatic reviewer' });
    appendRecords(fake.rolloutOf(session.id), [{
      type: 'turn_context',
      payload: {
        approval_policy: 'untrusted',
        approvals_reviewer: 'auto_review',
        sandbox_policy: { type: 'workspace-write', writable_roots: [session.cwd] },
      },
    }]);
    const row = await rowWhen(context, session.id, () => true);
    expect(row.currentMode).toBe('ask-permission');
    const stream = await context.client.attach('codex', session.id, { mode: 'resume' });
    try {
      await stream.waitForKind('history');
      expect(lastSession(stream)?.info.currentMode).toBe('ask-permission');
      const mark = fake.ledger.mark();
      expect((await stream.sendAndAwait({
        kind: 'prompt', text: 'Enable automatic review', permissionMode: 'approve-for-me',
      })).kind).toBe('ack');
      await stream.waitForMessage((message) => message.type === 'model-output' && message.final === true);
      const start = fake.ledger.nativeRequests('turn/start', mark).at(-1)?.frame?.params;
      expect(start.approvalPolicy).toBe('on-request');
      expect(start.approvalsReviewer).toBe('auto_review');
      expect(start.sandboxPolicy.type).toBe('workspaceWrite');
      expect(lastSession(stream)?.info.currentMode).toBe('approve-for-me');
    } finally {
      stream.close();
    }
  },
});

codexExtras.push({
  title: 'a create thread/start answers with a rollout already in the store is refused, and nothing is written into that session',
  async run(context) {
    const fake = context.fake as CodexFake;
    const existing = fake.seedSession({ title: 'Already stored' });
    await context.client.waitForSession((candidate) => candidate.id === existing.id);
    const rollout = fake.rolloutOf(existing.id);
    const index = join(fake.codexHome, 'session_index.jsonl');
    const rolloutBefore = readFileSync(rollout);
    const indexBefore = readFileSync(index, 'utf8');
    fake.prepareCreate(existing.id);
    const mark = fake.ledger.mark();
    const refused = await context.client.post('/api/sessions/codex', {
      directory: existing.cwd,
      title: 'Claimed by create',
      model: codexProfile.catalog.createModel,
    });
    expect(refused.ok, refused.text).toBe(false);
    // Refused at the thread/start answer: no effort, name or turn reached the runtime for that thread.
    expect(fake.ledger.nativeRequests('thread/start', mark).length).toBe(1);
    const writes = fake.ledger.since(mark)
      .filter((entry) => entry.kind === 'recv' && THREAD_WRITES.has(entry.frame?.method)
        && entry.frame?.params?.threadId === existing.nativeId)
      .map((entry) => entry.frame?.method);
    expect(writes).toEqual([]);
    // No byte reached the rollout, and its title row is the one it had.
    expect(readFileSync(rollout).equals(rolloutBefore)).toBe(true);
    expect(readFileSync(index, 'utf8')).toBe(indexBefore);
    const row = await context.client.waitForSession((candidate) => candidate.id === existing.id);
    expect(row.title).toBe('Already stored');
    expect(row.control?.drive?.state).toBe('observing');
  },
});

/** The row offers a runnable `codex resume --remote` join. */
const offersJoin = (row: any): boolean =>
  String(row?.terminalSyncHint?.command ?? '').includes('codex resume --remote unix://')
  && row?.control?.terminalSync?.syncAvailable === true;
/** The row's join offer is withdrawn: nothing to run, and terminal sync unavailable. */
const joinWithdrawn = (row: any): boolean =>
  row?.terminalSyncHint?.command === '' && row?.control?.terminalSync?.syncAvailable === false;

codexExtras.push({
  title: 'a daemon that crashed and left its socket holds no thread and offers no join, while a silent one changes nothing',
  async run(context) {
    const fake = context.fake as CodexFake;
    const loaded = fake.seedSession({ title: 'Loaded on the daemon' });
    const never = fake.seedSession({ title: 'Never loaded' });
    await rowWhen(context, never.id, offersJoin);
    // A terminal joins the thread on the daemon and leaves; the daemon keeps the thread loaded.
    const joinedAt = fake.ledger.mark();
    const terminal = fake.startTerminal(['resume', '--remote', `unix://${fake.socketPath}`, loaded.nativeId!], loaded.cwd);
    await eventually(() => fake.ledger.since(joinedAt)
      .some((entry) => entry.kind === 'writer' && entry.transport === 'daemon' && entry.threadId === loaded.nativeId),
    { what: 'the terminal to join the thread on the daemon' });
    terminal.kill('SIGKILL');
    await terminal.exited;
    await rowWhen(context, loaded.id, (row) => row.control?.drive?.state === 'driving' && offersJoin(row));

    const before = fake.configure({ faults: { daemonSilent: true } }) as unknown as FakeCodexAppServerConfig;
    try {
      // A daemon that still listens but answers nothing proves nothing: every row keeps what it had.
      const silentFrom = fake.ledger.mark();
      // Each probe's connection opens with `initialize`, which the silent daemon never answers.
      await eventually(() => fake.ledger.nativeRequests('initialize', silentFrom)
        .filter((entry) => entry.transport === 'daemon').length >= 4,
      { what: 'several daemon probes the silent daemon left unanswered' });
      const rows = await context.client.sessions({ refresh: true });
      const stillLoaded = rows.find((row) => row.id === loaded.id);
      expect(stillLoaded?.control?.drive?.state).toBe('driving');
      expect(offersJoin(stillLoaded)).toBe(true);
      expect(offersJoin(rows.find((row) => row.id === never.id))).toBe(true);

      // A crash leaves the socket file behind, and nothing listens on it.
      fake.crashDaemon();
      expect(lstatSync(fake.socketPath).isSocket()).toBe(true);
      // The thread the daemon held is no longer driven there, and no row offers to join it. (An open
      // daemon connection can drop the cached loaded set before the socket is proven dead, so the
      // row may read observing a poll before its join is withdrawn.)
      const unloaded = await rowWhen(context, loaded.id, (row) => row.control?.drive?.state === 'observing' && joinWithdrawn(row));
      expect(unloaded.terminalSyncHint.note).toMatch(/daemon is not running or reachable/);
      expect(joinWithdrawn(await rowWhen(context, never.id, () => true))).toBe(true);
      // Read-only: the socket a crash left behind is neither removed nor replaced.
      expect(lstatSync(fake.socketPath).isSocket()).toBe(true);
    } finally {
      fake.configure({ faults: before.faults ?? {} });
      if (fake.daemonPid() === undefined) fake.startDaemon();
    }
    // A daemon that starts again binds a new socket: the join returns, and it holds nothing yet.
    await rowWhen(context, never.id, offersJoin);
    await rowWhen(context, loaded.id, (row) => row.control?.drive?.state === 'observing' && offersJoin(row));
  },
});

/** A real, readable rollout outside `$CODEX_HOME/sessions`, the target of the hostile-store cases. */
function plantOutsideRollout(fake: FakeController, label: string): string {
  const id = codexUuid();
  const cwd = fake.workspace(label);
  const path = codexRolloutPath(join(cwd, 'not-codex-home'), id);
  appendRecords(path, [
    sessionMetaRecord({ id, cwd }),
    ...turnOpenRecords(`turn-${label}-${id.slice(-6)}`, cwd, defaultCodexSettings(cwd)),
    ...userRecords('a row from outside the store'),
  ]);
  return path;
}
