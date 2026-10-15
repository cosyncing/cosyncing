/**
 * Kilo Code conformance kit: a live host the broker launches and owns (`kilo serve` on a loopback port,
 * Basic auth, SQLite store), where Drive is `mode=live` on sessions this broker created.
 *
 * The native side is one compiled fake `kilo` (`fakes/kilo-program.ts`) in the fixture PATH:
 *
 *   - `kilo --version` for the version gate and doctor;
 *   - `kilo serve --port N`, which the BROKER spawns (the fake never starts itself): OpenCode's wire behind
 *     the credential the broker minted, every change written to `<data root>/kilo.db` before it is announced.
 *
 * The test side writes the same SQLite store directly, as a terminal's Kilo would (`fakes/kilo-store.ts`),
 * and sends what it cannot do from outside (release a held turn, announce a row, fail a write, crash) as
 * command files the serve applies before any later request.
 *
 * Every request the serve receives lands in the ledger, in OpenCode's vocabulary (`OpencodeLedger` maps
 * `prompt_async` to `session/prompt`, `abort` to `session/cancel`), so the shared scenarios read it unchanged.
 * The managed port is leased per broker and handed over through the source-only
 * `COSYNCING_TEST_KILO_SERVE_PORT` hook: nothing here can reach a real Kilo on 4097.
 */
import { expect } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { delimiter, join } from 'node:path';
import { eventually, fixturePath, type FixturePaths, type SessionStream } from '../../harness/index.ts';
import { installFakeExecutable as compileFake } from '../../harness/fakes/executable.ts';
import { openCodeRows } from '../../harness/fakes/opencode-server.ts';
import type { FakeKiloConfig, KiloControlCommand } from './fakes/kilo-program.ts';
import { KiloDb, type KiloRow } from './fakes/kilo-store.ts';
import { OpencodeLedger } from './opencode.ts';
import {
  type ConformanceExtra,
  type ConformanceKit,
  type ConformanceProfile,
  type FakeController,
  installFakeExecutable,
  leaseQuietPort,
  type LedgerEntry,
  type SeededSession,
  type SeedOptions,
  treeSnapshot,
} from './kit.ts';

export const KILO_VERSION = '7.4.23';
export const KILO_PROVIDER = 'test-provider';

const PROGRAM = join(import.meta.dir, 'fakes', 'kilo-program.ts');

export const kiloProfile: ConformanceProfile = {
  agent: 'kilo',
  displayName: 'Kilo Code',
  capabilities: {
    integrationKind: 'http-sse',
    attachModes: ['live', 'observe'],
    supportsObserve: true,
    supportsResume: false,
    supportsLiveAttach: true,
    supportsCrossClientDriveSharing: true,
    supportsNativeArtifact: false,
    supportsNativeFileInput: false,
    supportsModelSwitch: true,
    permissionGranularity: 'per-tool',
  },
  driveFamily: 'live-host',
  driveEligibility: 'app-created',
  version: {
    current: KILO_VERSION,
    below: '7.4.22',
    newer: '7.5.0',
    newerDrives: true,
    // The version gate is cached per binary (path, size, mtime): a changed fake is seen after a restart.
    cachedByBroker: true,
    doctor: {
      current: { check: 'version', status: 'pass', detailCode: 'version-supported' },
      below: { check: 'version', status: 'warn', detailCode: 'version-below-measured-floor' },
      newer: { check: 'version', status: 'pass', detailCode: 'version-newer-than-measured' },
      missing: { check: 'binary', status: 'warn', detailCode: 'binary-missing' },
    },
  },
  catalog: {
    models: [`${KILO_PROVIDER}/model-a`, `${KILO_PROVIDER}/model-b`],
    modes: [],
    commands: ['stop'],
    stopCommand: 'stop',
    switchModel: { providerID: KILO_PROVIDER, modelID: 'model-b' },
    unknownCommandsForwarded: true,
  },
  binaryOverrideEnv: 'COSYNCING_KILO_BIN',
  driveArgv: { required: [], forbidden: [] },
  createChildAdopted: false,
  userRowDurable: 'turn-start',
  promptEcho: 'native',
  midTurnPrompt: 'refused',
  modelSwitch: 'per-turn',
  permission: { approveReply: 'once', answerMentions: 'permission once' },
  // The store keeps no app-send token: a reloaded history row carries the serve's own message key.
  historyClientKey: false,
  driveAttach: 'live',
  terminal: { resumeHint: null, syncAvailable: false, handoff: false },
  subagents: true,
  missingBinaryRoster: 'observe-only',
  knownBugs: {
    'C20.roster': 'after a restart the roster still offers Drive for a session a terminal wrote to while the broker was '
      + 'down (control.drive.supported stays true); only attaching refuses it',
    'C16.create': 'Create on a build below the floor (or with no readable version) answers a plain 500 '
      + '`Kilo Code Drive requires an authenticated 7.4.23-or-newer server` instead of the typed 503 '
      + 'SESSION_CREATE_TEMPORARILY_UNAVAILABLE the other adapters give',
    'C17.create': 'Create with the kilo binary missing answers a plain 500 `Kilo Code Drive requires an authenticated '
      + '7.4.23-or-newer server` instead of the typed, retryable 503 SESSION_CREATE_TEMPORARILY_UNAVAILABLE',
    'C11.lateDuplicate': 'a tab that joins while a permission card is open receives that card twice as live '
      + 'messages (same requestId), outside its history frame (the OpenCode live connection Kilo shares)',
    'C15.detect': 'Drive never notices a rewritten durable history, live or at any later prompt (the next prompt is '
      + 'accepted and the session stays driving); managed-hosts-kilo has the failing test for the refusal. replaceLog '
      + 'cannot be built in process against the serve\'s open WAL connection.',
  },
  scenarios: {
    C07: {
      skip: 'Kilo creates a session with one POST /session on the managed serve and no child: the session/new and '
        + 'child-adoption bookkeeping this scenario asserts does not exist (the create extra asserts the real flow).',
    },
    C19: {
      skip: 'Kilo offers the stop action and no template commands, so there is no command that rides the prompt queue '
        + '(C12 asserts stop; the catalog extra asserts the action list is exactly that).',
    },
    C08: {
      skip: 'Drive is a live attach to the managed serve: there is no lazy resume, no child to start and no '
        + 'session/load (the "Drive is a live attach" extra asserts that no process but the serve is involved).',
    },
  },
  hostileStore: [
    {
      name: 'a session whose directory is relative',
      knownBug: { aspect: 'attach', bug: 'the live serve answers a bare attach to an id the roster withholds, with no directory validation' },
      plant: (fake) => plantKilo(fake, { directory: 'relative/dir' }),
    },
    {
      name: 'a session whose directory is the filesystem root',
      knownBug: { aspect: 'attach', bug: 'the live serve answers a bare attach to an id the roster withholds, with no directory validation' },
      plant: (fake) => plantKilo(fake, { directory: '/' }),
    },
    {
      name: 'a session id with a control character',
      knownBug: 'live serve rows are published without the store\'s id bounds: a control-character id reaches the roster and a bare attach',
      plant: (fake) => plantKilo(fake, { id: 'ses_bad\u0001id' }),
    },
    {
      name: 'a session id beyond the identity bound',
      knownBug: 'live serve rows are published without the store\'s id bounds: a 300-scalar id reaches the roster and a bare attach',
      plant: (fake) => plantKilo(fake, { id: `ses_${'x'.repeat(300)}` }),
    },
    {
      name: 'a second database in rollback-journal mode with a journal sidecar',
      plant: (fake) => plantKilo(fake, { database: 'kilo-journal.db', journal: true }),
    },
    { name: 'a second database with another schema', plant: (fake) => plantKilo(fake, { database: 'kilo-wrong.db', wrongSchema: true }) },
    {
      name: 'a symlinked database',
      unsupportedOn: ['win32'],
      plant: (fake) => plantKilo(fake, { database: 'kilo-link.db', symlink: true }),
    },
  ],
};

interface PlantOptions {
  id?: string;
  directory?: string;
  /** Another file in the data root instead of `kilo.db`. */
  database?: string;
  journal?: boolean;
  wrongSchema?: boolean;
  symlink?: boolean;
}

/** One hostile session, written the way a terminal's Kilo would; returns the id that must stay unpublished. */
function plantKilo(fake: FakeController, options: PlantOptions): string {
  const kilo = fake as KiloFake;
  const id = options.id ?? `ses_hostile${crypto.randomUUID().replaceAll('-', '').slice(0, 14)}`;
  const at = tick();
  const record = {
    info: { id, directory: options.directory ?? kilo.workspace('hostile'), title: 'hostile', time: { created: at, updated: at }, agent: 'code' },
    rows: [{ info: { id: `msg_${id.length}_${at}`, role: 'user', time: { created: at }, model: { providerID: KILO_PROVIDER, modelID: 'model-a' } }, parts: [{ id: `prt_${at}`, type: 'text', text: 'hostile', time: { start: at, end: at } }] }],
  };
  if (!options.database) {
    kilo.db.putSessionRecord(record);
    return id;
  }
  let target = join(kilo.dataDir, options.database);
  if (options.symlink) {
    // The real file lives outside the data root, where nothing may follow a link to.
    const outside = join(kilo.paths.root, 'outside-kilo.db');
    const real = new KiloDb(outside);
    real.putSessionRecord(record);
    real.close();
    symlinkSync(outside, target);
    return id;
  }
  if (options.wrongSchema) {
    const wrong = new Database(target, { create: true });
    wrong.exec('create table session (id text); create table message (id text);');
    wrong.query('insert into session (id) values (?)').run(id);
    wrong.close();
    return id;
  }
  const other = new KiloDb(target, { journal: options.journal ? 'delete' : 'wal' });
  other.putSessionRecord(record);
  other.close();
  if (options.journal) writeFileSync(`${target}-journal`, 'leftover');
  return id;
}

// --------------------------------------------------------------------- fake

export interface KiloFake extends FakeController {
  readonly ledger: OpencodeLedger;
  readonly paths: FixturePaths;
  readonly state: string;
  readonly dataDir: string;
  readonly port: number;
  readonly executable: string;
  /** The test side's connection to the store the serve and the broker also use. */
  readonly db: KiloDb;
  /** Send the serve a control command (applied before any later request it receives). */
  command(command: KiloControlCommand): void;
  /** Ids of the processes this fake's serve ran as, from its ledger. */
  serves(): Array<{ pid: number; at: number }>;
  isAlive(pid: number): boolean;
  /** Whether the broker would launch this fake as a managed serve (a verified version, and the binary present). */
  launchable(): boolean;
}

const leases = new Map<string, number>();
const leasedPort = (paths: FixturePaths): number => {
  const port = leases.get(paths.root);
  if (port === undefined) throw new Error('the fake Kilo is not installed yet');
  return port;
};

const aliveProcess = (pid: number): boolean => {
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
};

let clock = 0;
const tick = (): number => {
  clock = Math.max(clock + 1, Date.now());
  return clock;
};

export async function leaseKiloPort(paths: FixturePaths): Promise<number> {
  const port = await leaseQuietPort();
  leases.set(paths.root, port);
  return port;
}

/** The fake `kilo` installed into `paths.bin`, with its store and control directory, and its port leased. */
export async function installKilo(paths: FixturePaths, version = KILO_VERSION): Promise<KiloFake> {
  const port = await leaseKiloPort(paths);
  const state = join(paths.root, 'fakes', 'kilo');
  const dataDir = join(paths.root, 'kilo-data');
  mkdirSync(join(state, 'commands'), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const config: FakeKiloConfig = {
    version,
    dataDir,
    models: [
      { providerID: KILO_PROVIDER, modelID: 'model-a', name: 'Model A' },
      { providerID: KILO_PROVIDER, modelID: 'model-b', name: 'Model B' },
    ],
    agents: [{ name: 'code', description: 'Write code' }, { name: 'plan', description: 'Plan' }],
    commands: [{ name: 'review', description: 'Review the current diff' }],
  };
  const configPath = join(state, 'config.json');
  const writeConfig = (next: FakeKiloConfig): void => {
    // Replaced whole, never rewritten in place: the serve reads it from another process at any time.
    const pending = `${configPath}.${process.pid}`;
    writeFileSync(pending, JSON.stringify(next));
    renameSync(pending, configPath);
  };
  const readConfig = (): FakeKiloConfig => JSON.parse(readFileSync(configPath, 'utf8'));
  writeConfig(config);
  const executable = compileFake(paths.bin, 'kilo', PROGRAM, { defines: { FAKE_KILO_STATE: state } });
  const hidden = `${executable}.uninstalled`;
  const ledger = new OpencodeLedger(join(state, 'ledger.jsonl'));
  const db = new KiloDb(join(dataDir, 'kilo.db'));
  let commandSequence = 0;
  let workspaces = 0;
  let seeded = 0;
  let created = 0;
  let doctorVariants = 0;
  const partials = new Map<string, { messageId: string; partId: string }>();

  const command = (next: KiloControlCommand): void => {
    const pending = join(state, 'commands', `.${process.pid}-${commandSequence}.tmp`);
    const target = join(state, 'commands', `${String(Date.now()).padStart(14, '0')}-${String(++commandSequence).padStart(6, '0')}.json`);
    writeFileSync(pending, JSON.stringify(next));
    renameSync(pending, target);
  };

  const model = { providerID: KILO_PROVIDER, modelID: 'model-a' };
  const userRow = (id: string, at: number, text: string | undefined): KiloRow => ({
    info: { id, role: 'user', time: { created: at }, model },
    parts: text === undefined ? [] : [{ id: `prt_${id}`, type: 'text', text, time: { start: at, end: at } }],
  });
  const answerRow = (id: string, parent: string, at: number, text: string): KiloRow => {
    const row = openCodeRows.assistant(id, parent, at, [openCodeRows.text(`prt_${id}`, text, at, at + 1)], at + 1) as KiloRow;
    row.info.providerID = model.providerID;
    row.info.modelID = model.modelID;
    return row;
  };
  const writeTurn = (sessionId: string, user: KiloRow, answer: KiloRow | undefined): number => {
    db.putRow(sessionId, user);
    if (answer) db.putRow(sessionId, answer);
    const updated = tick();
    db.touch(sessionId, updated);
    return updated;
  };

  const controller: KiloFake = {
    ledger,
    paths,
    state,
    dataDir,
    port,
    executable,
    db,
    storeRoot: dataDir,
    command,
    serves: () => ledger.since(0).filter((entry) => entry.kind === 'serve-started').map((entry) => ({ pid: entry.pid, at: entry.at })),
    isAlive: aliveProcess,
    launchable() {
      if (!existsSync(executable)) return false;
      const current = readConfig();
      const reported = /\bkilo\s+v?(\d+)\.(\d+)\.(\d+)\b/.exec(current.versionOutput ?? `kilo ${current.version}`);
      if (!reported) return false;
      const [major, minor, patch] = reported.slice(1).map(Number) as [number, number, number];
      return major > 7 || (major === 7 && (minor > 4 || (minor === 4 && patch >= 23)));
    },
    workspace(name = 'workspace') {
      const directory = join(paths.root, 'workspaces', `${name}-${++workspaces}`);
      mkdirSync(directory, { recursive: true });
      return directory;
    },
    seedSession(options: SeedOptions = {}): SeededSession {
      const id = `ses_seed${String(++seeded).padStart(3, '0')}${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
      const cwd = options.childOf?.cwd ?? controller.workspace('seed');
      const title = options.title ?? `Kilo seeded ${seeded}`;
      const turns = options.turns ?? 1;
      const created = tick();
      db.putSession({
        id, directory: cwd, title, time: { created, updated: created }, model, agent: 'code',
        ...(options.childOf ? { parentID: options.childOf.id } : {}),
      });
      const texts: string[] = [];
      for (let turn = 1; turn <= turns; turn += 1) {
        const at = tick();
        writeTurn(id,
          userRow(`msg_seed_${id}_${turn}_u`, at, `seeded prompt ${turn}`),
          answerRow(`msg_seed_${id}_${turn}_a`, `msg_seed_${id}_${turn}_u`, at + 1, `seeded answer ${turn}`));
        texts.push(`seeded prompt ${turn}`, `seeded answer ${turn}`);
      }
      return { id, cwd, title, texts, storeKey: 'kilo.db' };
    },
    prepareCreate(id) {
      const next = id ?? `ses_created${String(++created).padStart(3, '0')}${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
      command({ op: 'prepareCreate', id: next });
      return next;
    },
    appendTurn(session, user, answer) {
      const at = tick();
      const id = `msg_term_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const rows = [userRow(`${id}_u`, at, user), answerRow(`${id}_a`, `${id}_u`, at + 1, answer)];
      const updated = writeTurn(session.id, rows[0]!, rows[1]);
      command({ op: 'announce', id: session.id, rows, updated });
    },
    appendForeignUser(session, text) {
      const id = `msg_foreign_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const row = userRow(id, tick(), text);
      const updated = writeTurn(session.id, row, undefined);
      command({ op: 'announce', id: session.id, rows: [row], updated });
    },
    appendPartial(session) {
      const id = `msg_partial_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
      db.putRow(session.id, userRow(id, tick(), undefined));
      db.touch(session.id, tick());
      partials.set(session.id, { messageId: id, partId: `prt_${id}` });
    },
    completePartial(session) {
      const partial = partials.get(session.id)!;
      partials.delete(session.id);
      const at = tick();
      db.putRow(session.id, { info: { id: partial.messageId, role: 'user', time: { created: at - 1 }, model }, parts: [{ id: partial.partId, type: 'text', text: 'partial prompt', time: { start: at, end: at } }] });
      db.putRow(session.id, answerRow(`${partial.messageId}_a`, partial.messageId, at + 1, 'partial answer'));
      db.touch(session.id, tick());
    },
    rewriteHistory(session) {
      const loaded = db.load(session.id)!;
      const first = loaded.rows.find((row) => row.info.role === 'user')!;
      db.rewritePartText(String(first.parts[0]!.id), 'rewritten first prompt');
      db.touch(session.id, tick());
    },
    replaceLog() {
      throw new Error('Kilo keeps one SQLite database; there is no log to replace (C15 is an extra here)');
    },
    watcherNoise() {
      // A sibling file in the data root: the watcher sees an event it must ignore.
      writeFileSync(join(dataDir, 'noise.tmp'), String(Date.now()));
    },
    setVersion(next, output) {
      const current = readConfig();
      current.version = next;
      if (output === undefined) delete current.versionOutput;
      else current.versionOutput = output;
      writeConfig(current);
    },
    setInstalled(installed) {
      if (installed && existsSync(hidden)) renameSync(hidden, executable);
      if (!installed && existsSync(executable)) renameSync(executable, hidden);
    },
    release(tag) {
      command({ op: 'release', tag });
    },
    configure(patch) {
      const previous = readConfig();
      writeConfig({ ...previous, ...patch } as FakeKiloConfig);
      return previous as unknown as Record<string, unknown>;
    },
    doctorEnvironment(variant) {
      const base = fixturePath(join(paths.root, 'no-agents'));
      if (variant.missing) return { PATH: base, COSYNCING_KILO_BIN: join(paths.root, 'missing-bin', 'kilo') };
      const directory = join(state, `doctor-${++doctorVariants}`);
      mkdirSync(directory, { recursive: true });
      const installed = installFakeExecutable(directory, 'kilo', 'kilo-cli.ts', { version: variant.version ?? KILO_VERSION });
      // Both the PATH and the explicit variable name the variant: the broker's own environment carries the latter.
      if (variant.override) return { PATH: base, COSYNCING_KILO_BIN: installed.path };
      return { PATH: [directory, base].join(delimiter), COSYNCING_KILO_BIN: installed.path };
    },
    storeSnapshot() {
      // The database and its WAL; the shared-memory index changes whenever anyone merely reads.
      return new Map([...treeSnapshot(dataDir)].filter(([path]) => !path.endsWith('-shm') && path !== 'noise.tmp'));
    },
    promptSettled(_stream: SessionStream, text: string) {
      const mark = ledger.mark();
      return async () => {
        await eventually(() => ledger.since(mark).some((entry) => (entry.kind === 'turn-end' || entry.kind === 'turn-aborted') && entry.text === text), {
          what: `the fake serve to settle the turn "${text}"`,
        });
      };
    },
    async cleanup() {
      // The broker stops the serve it launched; anything that outlived it is ours, proven by executable path.
      let binary: string;
      try {
        binary = realpathSync(existsSync(executable) ? executable : hidden);
      } catch {
        return;
      }
      for (const { pid } of controller.serves()) {
        if (!aliveProcess(pid)) continue;
        try {
          if (realpathSync(`/proc/${pid}/exe`) === binary) process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone, or not ours.
        }
      }
      db.close();
    },
  };
  return controller;
}

/** Announcements of a serve already waited for, per fake, so a restarted broker is waited for again. */
const announcedBefore = new WeakMap<KiloFake, number>();

export const kilocodeKit: ConformanceKit = {
  profile: kiloProfile,
  env: (paths) => {
    const port = leasedPort(paths);
    return {
      KILO_URL: `http://127.0.0.1:${port}`,
      COSYNCING_TEST_KILO_SERVE_PORT: String(port),
      KILO_DATA_DIR: join(paths.root, 'kilo-data'),
      // The installed service authorizes every managed host; a foreground broker opts in with this.
      COSYNCING_KILO_MANAGED_HOST: '1',
      // The fixture environment points this at a missing file; the fake in the fixture PATH is the one to run.
      COSYNCING_KILO_BIN: join(paths.bin, process.platform === 'win32' ? 'kilo.exe' : 'kilo'),
    };
  },
  install(paths) {
    return installKilo(paths);
  },
  async ready({ broker, fake }) {
    // A fake the broker will not launch (below the floor, no readable version, no binary) never comes up.
    const kilo = fake as KiloFake;
    if (!kilo.launchable()) return;
    // The broker starts the serve after it is healthy and says so once it holds the ownership proof Create and
    // Drive need (or, after supervision restarted it, says that). Each start of the broker announces one more.
    const announced = () => (broker.output().match(/started a managed kilo host|restarted the managed kilo host/g) ?? []).length;
    const before = announcedBefore.get(kilo) ?? 0;
    await eventually(() => announced() > before, { what: 'the broker to own its kilo serve', timeoutMs: 60_000 });
    announcedBefore.set(kilo, announced());
  },
  get extras(): ConformanceExtra[] {
    return kiloExtras;
  },
};

export type { LedgerEntry, ConformanceExtra };


// --------------------------------------------------------------------- extras

const kiloExtras: ConformanceExtra[] = [
  {
    title: 'Drive is a live attach to the managed serve: no process starts, nothing is refused, and the session offers no terminal sync',
    async run(context) {
      const fake = context.fake as KiloFake;
      const session = await context.drivableSession('live attach');
      const mark = fake.ledger.mark();
      const serves = fake.serves().length;
      const stream = await context.openDrive(session);
      expect((await context.prompt(stream, 'one turn')).kind).toBe('ack');
      expect(fake.ledger.since(mark).filter((entry) => ['rejected', 'serve-started', 'cli', 'version-probe', 'spawn'].includes(entry.kind))).toEqual([]);
      expect(fake.serves().length).toBe(serves);
      const row = await context.client.waitForSession((candidate) => candidate.id === session.id);
      expect(row.attachMode).toBe('live');
      expect(row.control?.terminalSync?.supported).toBe(false);
      expect(row.terminalSyncHint).toBeUndefined();
      stream.close();
    },
  },
  {
    title: 'a stored session this broker did not create is Observe-only: it reads, and a live attach is refused before the serve',
    async run(context) {
      const fake = context.fake as KiloFake;
      const seeded = fake.seedSession({ title: 'Stored elsewhere' });
      const row = await context.client.waitForSession((candidate) => candidate.id === seeded.id);
      expect(row.control?.drive?.supported).toBe(false);
      const mark = fake.ledger.mark();
      const refused = await context.client.attach('kilo', seeded.id, { mode: 'live' });
      await refused.waitForKind('error');
      expect(refused.frames.some((frame) => frame.kind === 'session' && frame.authority?.canMutate === true)).toBe(false);
      refused.close();
      expect(fake.ledger.routed('POST', /prompt_async|\/command$/, mark)).toEqual([]);
      const observer = await context.client.attach('kilo', seeded.id);
      expect(((await observer.waitForKind('history')).messages as any[]).some((message) => message.text === seeded.texts[0])).toBe(true);
      observer.close();
    },
  },
  {
    title: 'permission replies reach the serve on Kilo\'s own route as once, always and reject; a persistent rule is refused',
    async run(context) {
      const fake = context.fake as KiloFake;
      const routes: string[] = [];
      for (const decision of ['approve', 'approve-session', 'reject'] as const) {
        const session = await context.drivableSession(`permission ${decision}`);
        const stream = await context.openDrive(session);
        const turn = context.prompt(stream, '[[permission]] run it');
        const card = await stream.waitForMessage((message) => message.type === 'permission-request');
        expect(card.options).toEqual(['approve', 'approve-session', 'reject']);
        const before = fake.ledger.since(0).filter((entry) => entry.kind === 'permission-route').length;
        expect((await stream.sendAndAwait({ kind: 'approve', requestId: card.requestId, decision })).kind).toBe('ack');
        expect((await turn).kind).toBe('ack');
        const route = fake.ledger.since(0).filter((entry) => entry.kind === 'permission-route').slice(before);
        expect(route.length).toBe(1);
        expect(String(route[0]!.path)).toMatch(new RegExp(`^/session/${session.id}/permissions/${card.requestId}$`));
        routes.push(String(route[0]!.response));
        stream.close();
      }
      expect(routes).toEqual(['once', 'always', 'reject']);
      const session = await context.drivableSession('permission rule');
      const stream = await context.openDrive(session);
      const turn = context.prompt(stream, '[[permission]] run it');
      const card = await stream.waitForMessage((message) => message.type === 'permission-request');
      const before = fake.ledger.since(0).filter((entry) => entry.kind === 'permission-route').length;
      const refused = await stream.sendAndAwait({ kind: 'approve', requestId: card.requestId, decision: 'approve-rule' });
      expect(refused.kind).toBe('nack');
      expect(fake.ledger.since(0).filter((entry) => entry.kind === 'permission-route').length).toBe(before);
      expect((await stream.sendAndAwait({ kind: 'approve', requestId: card.requestId, decision: 'reject' })).kind).toBe('ack');
      await turn;
      stream.close();
    },
  },
  {
    title: 'a native run failure ends the turn as an error, names it, and keeps Drive for the next prompt',
    async run(context) {
      const session = await context.drivableSession('failure');
      const stream = await context.openDrive(session);
      const from = stream.frames.length;
      expect((await context.prompt(stream, '[[error]] explode')).kind).toBe('ack');
      await stream.waitForFrame((frame) => frame.kind === 'message' && frame.message.type === 'run-summary' && frame.message.status === 'error', { after: from });
      await stream.waitForMessage((message) => message.type === 'error' && String(message.message).includes('model exploded'));
      expect((await context.prompt(stream, 'after the failure')).kind).toBe('ack');
      await stream.waitForMessage((message) => message.type === 'model-output' && (message.text ?? message.delta) === 'answer: after the failure');
      stream.close();
    },
  },
  {
    title: 'the command catalog is exactly the stop action',
    async run(context) {
      const session = await context.drivableSession('catalog');
      const stream = await context.openDrive(session);
      const commands = (stream.ofKind('commands').at(-1)?.commands ?? []) as Array<{ name: string; kind: string }>;
      expect(commands.map((command) => [command.name, command.kind])).toEqual([['stop', 'action']]);
      stream.close();
    },
  },
];
