/**
 * Cline conformance kit: Drive through a Hub daemon the broker launches and owns (`cline --cwd <home>` with
 * `CLINE_RUN_AS_HUB_DAEMON=1` in its environment), in an isolated profile on a leased loopback port.
 *
 * The native side is one compiled fake `cline` (`fakes/cline-program.ts`) in the fixture PATH:
 *
 *   - `cline --version` for the version gate and doctor;
 *   - the Hub daemon the BROKER spawns: health, the authenticated `/hub` WebSocket, a 0600 discovery file, and
 *     sessions persisted in the profile as Cline writes them;
 *   - `cline history update …`, the native title write rename escalates to.
 *
 * Every Hub command the product sends lands in the ledger and is read in the conformance vocabulary
 * (`ClineLedger`: `run.start` is `session/prompt`, `run.abort` is `session/cancel`, `session.create` is
 * `session/new`, `approval.respond` is a permission reply). Stored sessions an ordinary `cline` would have
 * written (Observe-only, origin `cli`) are seeded straight into `CLINE_DATA_DIR`, as a terminal's would be.
 */
import { expect } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { eventually, fixturePath, type FixturePaths } from '../../harness/index.ts';
import { installFakeExecutable as compileFake } from '../../harness/fakes/executable.ts';
import type { ClineControlCommand, FakeClineConfig } from './fakes/cline-program.ts';
import {
  type ConformanceContext,
  type ConformanceExtra,
  stableUnnamedTitle,
  type ConformanceKit,
  type ConformanceProfile,
  type FakeController,
  installFakeExecutable,
  makeFifo,
  leaseQuietPort,
  Ledger,
  type LedgerEntry,
  type SeededSession,
  type SeedOptions,
  treeSnapshot,
} from './kit.ts';

export const CLINE_VERSION = '3.0.61';
export const CLINE_CORE_VERSION = '0.0.82';
export const CLINE_PROVIDER = 'test-provider';
export const CLINE_MODEL = 'model-a';

const PROGRAM = join(import.meta.dir, 'fakes', 'cline-program.ts');

export const clineProfile: ConformanceProfile = {
  agent: 'cline',
  displayName: 'Cline',
  capabilities: {
    integrationKind: 'http-websocket',
    attachModes: ['observe', 'resume'],
    supportsObserve: true,
    supportsResume: true,
    supportsLiveAttach: false,
    supportsCrossClientDriveSharing: true,
    supportsNativeArtifact: false,
    supportsNativeFileInput: false,
    supportsModelSwitch: false,
    permissionGranularity: 'per-tool',
  },
  minimumClientRevision: 14,
  observeRunSummaries: false,
  freshCreateObservable: false,
  stopSummary: false,
  restartKeepsDrive: false,
  driveFamily: 'broker-child',
  driveEligibility: 'app-created',
  version: {
    current: CLINE_VERSION,
    // Measured, but its Hub core is below the Hub floor: Observe works, Drive does not.
    below: '3.0.60',
    newer: '3.0.62',
    newerDrives: true,
    cachedByBroker: true,
    doctor: {
      current: { check: 'version', status: 'pass', detailCode: 'version-supported' },
      below: { check: 'version', status: 'warn', detailCode: 'version-below-hub-core-floor' },
      newer: { check: 'version', status: 'warn', detailCode: 'version-newer-snapshots-unread' },
      missing: { check: 'binary', status: 'warn', detailCode: 'binary-missing' },
    },
  },
  catalog: {
    models: [`${CLINE_PROVIDER}/${CLINE_MODEL}`],
    modes: ['ask'],
    commands: ['stop'],
    stopCommand: 'stop',
    createMode: 'ask',
    createModel: { providerID: CLINE_PROVIDER, modelID: CLINE_MODEL },
  },
  binaryOverrideEnv: 'COSYNCING_CLINE_BIN',
  driveArgv: { required: [], forbidden: [] },
  createChildAdopted: false,
  // The writer reads the user row back from the Hub when the turn settles.
  userRowDurable: 'turn-end',
  permission: { approveReply: 'approve', answerMentions: 'permission approve' },
  terminal: { resumeHint: null, syncAvailable: false, handoff: false },
  subagents: true,
  missingBinaryRoster: 'observe-only',
  scenarios: {
    C07: {
      skip: 'Cline creates through one Hub session.create and has no native child to adopt: the session/new and '
        + 'child bookkeeping this scenario asserts does not exist (the create extras assert the real flow).',
    },
    C08: {
      skip: 'Drive is a client connection to the managed Hub: there is no lazy resume, no child to start and no '
        + 'session/load (the "Drive is a Hub client" extra asserts that no process but the Hub is involved).',
    },
    C18: { refuse: 'Cline cannot switch model: the isolated profile names one provider and model, and a crafted switch is refused.' },
    C19: { skip: 'Cline offers the stop action and no template commands (the catalog extra asserts that).' },
  },
  hostileStore: [
    { name: 'a session directory whose name is not a Cline session id', plant: (fake) => plantCline(fake, { directory: 'not-a-session-id' }) },
    { name: 'metadata that names another session id', plant: (fake) => plantCline(fake, { metadataId: '1700000000000_zzzzz' }) },
    { name: 'a relative working directory', plant: (fake) => plantCline(fake, { cwd: 'relative/path' }) },
    { name: 'a snapshot written by an unmeasured Cline version', plant: (fake) => plantCline(fake, { version: '3.9.99' }) },
    { name: 'a snapshot that names another session', plant: (fake) => plantCline(fake, { snapshotId: '1700000000001_yyyyy' }) },
    { name: 'a managed-origin snapshot copied outside the managed profile', plant: (fake) => plantCline(fake, { origin: 'managed' }) },
    { name: 'a snapshot that is not JSON', plant: (fake) => plantCline(fake, { malformed: true }) },
    { name: 'a symlinked session directory', unsupportedOn: ['win32'], plant: (fake) => plantCline(fake, { linkDirectory: true }) },
    { name: 'a symlinked messages snapshot', unsupportedOn: ['win32'], plant: (fake) => plantCline(fake, { linkMessages: true }) },
    { name: 'a FIFO in place of the messages snapshot', unsupportedOn: ['win32'], plant: (fake) => plantCline(fake, { fifo: 'messages' }) },
    { name: 'a FIFO in place of the session metadata', unsupportedOn: ['win32'], plant: (fake) => plantCline(fake, { fifo: 'metadata' }) },
  ],
};

interface PlantOptions {
  directory?: string;
  metadataId?: string;
  snapshotId?: string;
  cwd?: string;
  version?: string;
  origin?: 'managed';
  malformed?: boolean;
  linkDirectory?: boolean;
  linkMessages?: boolean;
  /** Which of the session's two files is a named pipe instead. */
  fifo?: 'metadata' | 'messages';
}

/** One hostile session in the owner's data directory; returns the id that must stay unpublished. */
function plantCline(fake: FakeController, options: PlantOptions): string {
  const cline = fake as ClineFake;
  const id = options.directory ?? clineSessionId();
  const at = tick();
  const real = join(cline.paths.root, 'outside-sessions', id);
  const dir = options.linkDirectory ? real : join(cline.dataDir, 'sessions', id);
  const cwd = options.cwd ?? cline.workspace('hostile');
  if (options.fifo === 'metadata') makeFifo(join(dir, `${id}.json`));
  else writeJson(join(dir, `${id}.json`), {
    session_id: options.metadataId ?? id, cwd, provider: CLINE_PROVIDER, model: CLINE_MODEL,
    started_at: new Date(at).toISOString(), ended_at: new Date(at + 1).toISOString(), status: 'completed', metadata: { title: 'hostile', mode: 'act' },
  });
  const messagesPath = join(dir, `${id}.messages.json`);
  const snapshotId = options.snapshotId ?? id;
  const origin = options.origin === 'managed'
    ? { source: 'cosyncing', mode: 'user', sessionId: id }
    : { source: 'cli', mode: 'user', sessionId: id, version: options.version ?? CLINE_VERSION };
  const document = {
    version: 1, agent: 'lead', sessionId: snapshotId, origin, updated_at: new Date(at + 1).toISOString(),
    messages: [
      { id: `msg-${id}-u`, role: 'user', ts: at, content: [{ type: 'text', text: '<user_input mode="act">hostile</user_input>' }] },
      { id: `msg-${id}-a`, role: 'assistant', ts: at + 1, modelInfo: { provider: CLINE_PROVIDER, id: CLINE_MODEL }, content: [{ type: 'text', text: 'hostile' }], metrics: {} },
    ],
  };
  if (options.fifo === 'messages') makeFifo(messagesPath);
  else if (options.malformed) writeFileSync(messagesPath, '{ not json');
  else if (options.linkMessages) {
    const outside = join(cline.paths.root, 'outside-messages', `${id}.json`);
    writeJson(outside, document);
    symlinkSync(outside, messagesPath);
  } else writeJson(messagesPath, document);
  if (options.linkDirectory) symlinkSync(real, join(cline.dataDir, 'sessions', id));
  return id;
}

// -------------------------------------------------------------------- ledger

/** The fake Hub's command log, read in the conformance vocabulary (see the file header). */
export class ClineLedger extends Ledger {
  override requests(method: string, from = 0): LedgerEntry[] {
    const native = ({ 'session/prompt': 'run.start', 'session/cancel': 'run.abort', 'session/new': 'session.create' } as Record<string, string>)[method];
    if (!native) return [];
    return this.since(from)
      .filter((entry) => entry.kind === 'command' && entry.command === native)
      .map((entry) => ({
        ...entry,
        kind: 'recv',
        frame: {
          method,
          params: {
            sessionId: entry.sessionId,
            cwd: (entry.payload as Record<string, any> | undefined)?.cwd,
            prompt: method === 'session/prompt' ? [{ text: String((entry.payload as Record<string, any>)?.prompt ?? '') }] : undefined,
          },
          native: entry.payload,
        },
      }));
  }

  override replies(idPrefix: string, from = 0): LedgerEntry[] {
    return this.since(from)
      .filter((entry) => entry.kind === 'command' && entry.command === 'approval.respond'
        && String((entry.payload as Record<string, any>)?.approvalId ?? '').startsWith(idPrefix))
      .map((entry) => {
        const payload = entry.payload as Record<string, any>;
        return { ...entry, kind: 'recv', frame: { id: payload.approvalId, result: { outcome: payload.approved === true ? 'approve' : 'reject' } } };
      });
  }

  /** Hub commands of one name, oldest first. */
  commands(name: string, from = 0): LedgerEntry[] {
    return this.since(from).filter((entry) => entry.kind === 'command' && entry.command === name);
  }
}

// ---------------------------------------------------------------------- fake

export interface ClineFake extends FakeController {
  readonly ledger: ClineLedger;
  readonly paths: FixturePaths;
  readonly state: string;
  readonly profileDir: string;
  readonly dataDir: string;
  readonly port: number;
  readonly executable: string;
  command(command: ClineControlCommand): void;
  /** The Hubs this fake has run as, from its ledger. */
  hubs(): Array<{ pid: number; at: number; hubId: string }>;
  isAlive(pid: number): boolean;
  launchable(): boolean;
  /** The session's two durable files, wherever it lives (the managed profile first). */
  filesOf(sessionId: string): { dir: string; metadata: string; messages: string } | undefined;
}

const leases = new Map<string, number>();
const leasedPort = (paths: FixturePaths): number => {
  const port = leases.get(paths.root);
  if (port === undefined) throw new Error('the fake Cline is not installed yet');
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
const alnum = (length: number): string => crypto.randomUUID().replaceAll('-', '').replaceAll(/[^a-z0-9]/g, '').slice(0, length).padEnd(length, '0');
export const clineSessionId = (): string => `${String(tick()).padStart(13, '0').slice(-13)}_${alnum(5)}`;

const writeJson = (path: string, value: unknown): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  const pending = `${path}.${process.pid}.tmp`;
  writeFileSync(pending, `${JSON.stringify(value)}\n`);
  renameSync(pending, path);
};

export async function installCline(paths: FixturePaths, version = CLINE_VERSION): Promise<ClineFake> {
  const port = await leaseQuietPort();
  leases.set(paths.root, port);
  const state = join(paths.root, 'fakes', 'cline');
  const profileDir = join(paths.root, 'cline-profile');
  const dataDir = join(paths.root, 'cline-data');
  mkdirSync(join(state, 'commands'), { recursive: true });
  mkdirSync(join(state, 'control'), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const config: FakeClineConfig = { version, coreVersion: CLINE_CORE_VERSION };
  const configPath = join(state, 'config.json');
  const writeConfig = (next: FakeClineConfig): void => {
    const pending = `${configPath}.${process.pid}`;
    writeFileSync(pending, JSON.stringify(next));
    renameSync(pending, configPath);
  };
  const readConfig = (): FakeClineConfig => JSON.parse(readFileSync(configPath, 'utf8'));
  writeConfig(config);
  const executable = compileFake(paths.bin, 'cline', PROGRAM, { defines: { FAKE_CLINE_STATE: state } });
  const hidden = `${executable}.uninstalled`;
  const ledger = new ClineLedger(join(state, 'ledger.jsonl'));
  let commandSequence = 0;
  let workspaces = 0;
  let seeded = 0;
  let doctorVariants = 0;
  const partials = new Map<string, string>();

  const command = (next: ClineControlCommand): void => {
    const pending = join(state, 'commands', `.${process.pid}-${commandSequence}.tmp`);
    const target = join(state, 'commands', `${String(Date.now()).padStart(14, '0')}-${String(++commandSequence).padStart(6, '0')}.json`);
    writeFileSync(pending, JSON.stringify(next));
    renameSync(pending, target);
  };

  const filesIn = (root: string, id: string) => {
    const dir = join(root, 'sessions', id);
    return existsSync(join(dir, `${id}.json`)) ? { dir, metadata: join(dir, `${id}.json`), messages: join(dir, `${id}.messages.json`) } : undefined;
  };
  const filesOf = (id: string) => filesIn(profileDir, id) ?? filesIn(dataDir, id);
  const managed = (id: string): boolean => filesIn(profileDir, id) !== undefined;

  const userRow = (id: string, at: number, text: string) => ({
    id, role: 'user', ts: at, content: [{ type: 'text', text: `<user_input mode="act">${text}</user_input>` }],
  });
  const answerRow = (id: string, at: number, text: string) => ({
    id, role: 'assistant', ts: at, modelInfo: { provider: CLINE_PROVIDER, id: CLINE_MODEL },
    content: [{ type: 'text', text }], metrics: { inputTokens: 11, outputTokens: 7 },
  });
  const readMessages = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));
  const stamp = (id: string, messages: unknown[]) => {
    const file = filesOf(id)!;
    const previous = readMessages(file.messages);
    writeJson(file.messages, { ...previous, updated_at: new Date().toISOString(), messages });
  };

  const controller: ClineFake = {
    ledger,
    paths,
    state,
    profileDir,
    dataDir,
    port,
    executable,
    storeRoot: dataDir,
    command,
    filesOf,
    hubs: () => ledger.since(0).filter((entry) => entry.kind === 'hub-started').map((entry) => ({ pid: entry.pid, at: entry.at, hubId: String(entry.hubId) })),
    isAlive: aliveProcess,
    launchable() {
      if (!existsSync(executable)) return false;
      const config = readConfig();
      const reported = /(?:cline\s+v?)?(\d+)\.(\d+)\.(\d+)\s*$/m.exec(config.versionOutput ?? config.version);
      if (!reported) return false;
      const [major, minor, patch] = reported.slice(1).map(Number) as [number, number, number];
      return major > 3 || (major === 3 && (minor > 0 || patch >= 61));
    },
    workspace(name = 'workspace') {
      const directory = join(paths.root, 'workspaces', `${name}-${++workspaces}`);
      mkdirSync(directory, { recursive: true });
      return directory;
    },
    seedSession(options: SeedOptions = {}): SeededSession {
      const id = clineSessionId();
      const cwd = options.childOf?.cwd ?? controller.workspace('seed');
      const title = options.title ?? `Cline seeded ${++seeded}`;
      const turns = options.turns ?? 1;
      const at = tick();
      if (options.childOf) {
        // A subagent's snapshot lives beside its parent's: `<parent>__agent_<n>_<suffix>`.
        const parent = filesIn(dataDir, options.childOf.id)!;
        const suffix = `agent_${String(at).padStart(13, '0').slice(-13)}_${alnum(6).toLowerCase()}`;
        const childId = `${options.childOf.id}__${suffix}`;
        writeJson(join(parent.dir, `${suffix}.messages.json`), {
          version: 1, agent: 'subagent', taskType: 'subagent_task', sessionId: childId,
          origin: { source: 'cli', mode: 'subagent', sessionId: childId, parentThreadId: options.childOf.id, subagent: suffix, version: CLINE_VERSION },
          updated_at: new Date(at).toISOString(),
          messages: [userRow(`msg-${childId}-u`, at, 'subagent task'), answerRow(`msg-${childId}-a`, at + 1, 'subagent answer')],
        });
        return { id: childId, cwd, title: `Cline subagent ${suffix.replace(/^agent_/u, '')}`, texts: ['subagent task', 'subagent answer'], storeKey: suffix };
      }
      const rows: unknown[] = [];
      const texts: string[] = [];
      for (let turn = 1; turn <= turns; turn += 1) {
        rows.push(userRow(`msg-${id}-${turn}-u`, at + turn * 2, `seeded prompt ${turn}`), answerRow(`msg-${id}-${turn}-a`, at + turn * 2 + 1, `seeded answer ${turn}`));
        texts.push(`seeded prompt ${turn}`, `seeded answer ${turn}`);
      }
      const dir = join(dataDir, 'sessions', id);
      writeJson(join(dir, `${id}.json`), {
        session_id: id, cwd, provider: CLINE_PROVIDER, model: CLINE_MODEL, started_at: new Date(at).toISOString(),
        ended_at: new Date(at + turns * 2 + 2).toISOString(), status: 'completed',
        metadata: { title, mode: 'act' },
      });
      writeJson(join(dir, `${id}.messages.json`), {
        version: 1, agent: 'lead', sessionId: id,
        origin: { source: 'cli', mode: 'user', sessionId: id, version: CLINE_VERSION },
        updated_at: new Date(at + turns * 2 + 2).toISOString(), messages: rows,
      });
      return { id, cwd, title, texts, storeKey: id };
    },
    prepareCreate(id) {
      const next = id ?? clineSessionId();
      command({ op: 'prepareCreate', id: next });
      return next;
    },
    appendTurn(session, user, answer) {
      const at = tick();
      const rows = [userRow(`msg-term-${at}-u`, at, user), answerRow(`msg-term-${at}-a`, at + 1, answer)];
      if (managed(session.id)) command({ op: 'append', id: session.id, rows });
      else stamp(session.id, [...readMessages(filesOf(session.id)!.messages).messages, ...rows]);
    },
    appendForeignUser(session, text) {
      const row = userRow(`msg-foreign-${tick()}`, tick(), text);
      // On a managed session the foreign writer is a second Hub client: it runs, and the Hub says so.
      if (managed(session.id)) command({ op: 'append', id: session.id, rows: [row], announce: true });
      else stamp(session.id, [...readMessages(filesOf(session.id)!.messages).messages, row]);
    },
    appendPartial(session) {
      // The snapshot is one JSON document: a torn write is half of the next one.
      const file = filesOf(session.id)!;
      const whole = readFileSync(file.messages, 'utf8');
      partials.set(session.id, whole);
      const at = tick();
      const next = JSON.stringify({ ...readMessages(file.messages), messages: [...readMessages(file.messages).messages, userRow(`msg-partial-${at}`, at, 'partial prompt'), answerRow(`msg-partial-${at}-a`, at + 1, 'partial answer')] });
      partials.set(session.id, next);
      writeFileSync(file.messages, next.slice(0, Math.floor(next.length / 2)));
    },
    completePartial(session) {
      const file = filesOf(session.id)!;
      writeJson(file.messages, JSON.parse(partials.get(session.id)!));
      partials.delete(session.id);
    },
    rewriteHistory(session) {
      if (managed(session.id)) {
        command({ op: 'rewrite', id: session.id, text: 'rewritten first prompt' });
        return;
      }
      const file = filesOf(session.id)!;
      const document = readMessages(file.messages);
      const first = document.messages.find((row: any) => row.role === 'user');
      first.content = [{ type: 'text', text: '<user_input mode="act">rewritten first prompt</user_input>' }];
      writeJson(file.messages, { ...document, updated_at: new Date().toISOString() });
    },
    replaceLog(session) {
      const file = filesOf(session.id)!;
      const bytes = readFileSync(file.messages);
      const pending = `${file.messages}.replacement`;
      writeFileSync(pending, bytes);
      renameSync(pending, file.messages);
    },
    watcherNoise(session) {
      const file = filesOf(session.id);
      if (file) writeFileSync(join(file.dir, 'noise.tmp'), String(Date.now()));
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
      writeFileSync(join(state, 'control', `release-${tag}`), '');
    },
    configure(patch) {
      const previous = readConfig();
      writeConfig({ ...previous, ...patch } as FakeClineConfig);
      return previous as unknown as Record<string, unknown>;
    },
    doctorEnvironment(variant) {
      const base = fixturePath(join(paths.root, 'no-agents'));
      if (variant.missing) return { PATH: base, COSYNCING_CLINE_BIN: join(paths.root, 'missing-bin', 'cline') };
      const directory = join(state, `doctor-${++doctorVariants}`);
      mkdirSync(directory, { recursive: true });
      const installed = installFakeExecutable(directory, 'cline', 'cline-cli.ts', { version: variant.version ?? CLINE_VERSION });
      if (variant.override) return { PATH: base, COSYNCING_CLINE_BIN: installed.path };
      return { PATH: [directory, base].join(delimiter), COSYNCING_CLINE_BIN: installed.path };
    },
    storeSnapshot() {
      return new Map([...treeSnapshot(dataDir)].filter(([path]) => !path.endsWith('noise.tmp')));
    },
    async cleanup() {
      let binary: string;
      try {
        binary = realpathSync(existsSync(executable) ? executable : hidden);
      } catch {
        return;
      }
      for (const { pid } of controller.hubs()) {
        if (!aliveProcess(pid)) continue;
        try {
          if (realpathSync(`/proc/${pid}/exe`) === binary) process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone, or not ours.
        }
      }
    },
  };
  return controller;
}

const announcedBefore = new WeakMap<ClineFake, number>();

export const clineKit: ConformanceKit = {
  profile: clineProfile,
  env: (paths) => ({
    COSYNCING_CLINE_MANAGED_HOST: '1',
    COSYNCING_CLINE_BIN: join(paths.bin, process.platform === 'win32' ? 'cline.exe' : 'cline'),
    COSYNCING_CLINE_PROFILE_DIR: join(paths.root, 'cline-profile'),
    COSYNCING_CLINE_HUB_PORT: String(leasedPort(paths)),
    COSYNCING_CLINE_PROVIDER: CLINE_PROVIDER,
    COSYNCING_CLINE_MODEL: CLINE_MODEL,
  }),
  install: (paths) => installCline(paths),
  async ready({ broker, fake }) {
    const cline = fake as ClineFake;
    if (!cline.launchable()) return;
    const announced = () => (broker.output().match(/started a managed cline host|restarted the managed cline host/g) ?? []).length;
    const before = announcedBefore.get(cline) ?? 0;
    await eventually(() => announced() > before, { what: 'the broker to own its cline Hub', timeoutMs: 60_000 });
    announcedBefore.set(cline, announced());
  },
  get extras(): ConformanceExtra[] {
    return clineExtras;
  },
};




// --------------------------------------------------------------------- extras

const payloadOf = (entry: LedgerEntry): Record<string, any> => entry.payload as Record<string, any>;

/** A Drive attach the product refuses: Observe with an attach conflict, and no authority. */
async function refusedDrive(context: ConformanceContext, id: string, params: Record<string, unknown>): Promise<void> {
  const stream = await context.client.attach('cline', id, params);
  await stream.waitForKind('history');
  expect(stream.ofKind('attach-conflict').length).toBe(1);
  expect(stream.ofKind('session').at(-1)?.authority?.canMutate).toBe(false);
  stream.close();
}

const clineExtras: ConformanceExtra[] = [
  stableUnnamedTitle('cline'),
  {
    title: 'a create is one Hub session.create in the isolated profile, with the configured model and the managed origin',
    async run(context) {
      const fake = context.fake as ClineFake;
      const mark = fake.ledger.mark();
      const session = await context.drivableSession('create flow');
      const creates = fake.ledger.commands('session.create', mark);
      expect(creates.length).toBe(1);
      const payload = payloadOf(creates[0]!);
      expect(payload.cwd).toBe(session.cwd);
      expect(payload.workspaceRoot).toBe(session.cwd);
      expect(payload.modelSelection).toEqual({ provider: CLINE_PROVIDER, model: CLINE_MODEL });
      expect(payload.metadata).toMatchObject({ source: 'cosyncing', title: 'create flow', provider: CLINE_PROVIDER, model: CLINE_MODEL });
      expect(payload.runtimeOptions).toMatchObject({ mode: 'act', autoApproveTools: false });
      expect(payload.toolPolicies['*']).toEqual({ autoApprove: false, enabled: true });
      // The session lives in the broker's own profile, never in the owner's Cline data directory.
      const files = fake.filesOf(session.id)!;
      expect(files.dir.startsWith(`${fake.profileDir}/`)).toBe(true);
      expect(readdirNames(join(fake.dataDir, 'sessions'))).not.toContain(session.id);
      const document = JSON.parse(readFileSync(files.messages, 'utf8'));
      expect(document.origin).toEqual({ source: 'cosyncing', mode: 'user', sessionId: session.id });
      const row = await context.client.waitForSession((candidate) => candidate.id === session.id);
      expect(row.currentModel).toMatchObject({ providerID: CLINE_PROVIDER, modelID: CLINE_MODEL });
      expect(row.currentMode).toBe('ask');
    },
  },
  {
    title: 'create modes map to the Hub run options, an unknown mode or another model is refused before the Hub',
    async run(context) {
      const fake = context.fake as ClineFake;
      const create = (extra: Record<string, unknown>) =>
        context.client.post('/api/sessions/cline', { directory: fake.workspace('modes'), ...extra });
      const auto = await create({ permissionMode: 'auto' });
      expect(auto.status, auto.text).toBe(200);
      const plan = await create({ permissionMode: 'plan' });
      expect(plan.status, plan.text).toBe(200);
      const created = fake.ledger.commands('session.create').slice(-2).map(payloadOf);
      expect(created[0]!.runtimeOptions).toMatchObject({ mode: 'act', autoApproveTools: true });
      expect(created[0]!.toolPolicies['*']).toEqual({ autoApprove: true, enabled: true });
      expect(created[1]!.runtimeOptions).toMatchObject({ mode: 'plan', autoApproveTools: false });
      const mark = fake.ledger.mark();
      expect((await create({ permissionMode: 'yolo' })).ok).toBe(false);
      expect((await create({ model: { providerID: 'other', modelID: 'other' } })).ok).toBe(false);
      expect(fake.ledger.commands('session.create', mark)).toEqual([]);
    },
  },
  {
    title: 'Drive is a Hub client: no process but the Hub is involved, and the catalog is the stop action',
    async run(context) {
      const fake = context.fake as ClineFake;
      const session = await context.drivableSession('hub client');
      const mark = fake.ledger.mark();
      const stream = await context.openDrive(session);
      expect((await context.prompt(stream, 'one turn')).kind).toBe('ack');
      expect(fake.ledger.since(mark).filter((entry) => entry.kind === 'hub-started' || entry.kind === 'history-update' || entry.kind === 'version-probe')).toEqual([]);
      const commands = (stream.ofKind('commands').at(-1)?.commands ?? []) as Array<{ name: string; kind: string }>;
      expect(commands.map((command) => [command.name, command.kind])).toEqual([['stop', 'action']]);
      stream.close();
    },
  },
  {
    title: 'an ordinary Cline session is Observe-only: its history reads, and Drive is refused before the Hub',
    async run(context) {
      const fake = context.fake as ClineFake;
      const seeded = fake.seedSession({ title: 'Ordinary session' });
      const row = await context.client.waitForSession((candidate) => candidate.id === seeded.id);
      expect(row.control?.drive?.supported).toBe(false);
      const mark = fake.ledger.mark();
      await refusedDrive(context, seeded.id, { mode: 'resume', reason: 'takeover' });
      await refusedDrive(context, seeded.id, { mode: 'resume', reason: 'create' });
      expect(fake.ledger.commands('run.start', mark)).toEqual([]);
      const observer = await context.client.attach('cline', seeded.id);
      expect(((await observer.waitForKind('history')).messages as any[]).some((message) => message.text === seeded.texts[0])).toBe(true);
      observer.close();
    },
  },
  {
    title: 'a native run failure ends the turn as an error, names it, and keeps Drive for the next prompt',
    async run(context) {
      const fake = context.fake as ClineFake;
      const session = await context.drivableSession('failure');
      const stream = await context.openDrive(session);
      const from = stream.frames.length;
      const failed = await context.prompt(stream, '[[error]] explode');
      expect(failed.kind).toBe('ack');
      await stream.waitForFrame((frame) => frame.kind === 'message' && frame.message.type === 'run-summary' && frame.message.status === 'error', { after: from });
      await stream.waitForMessage((message) => message.type === 'error' && String(message.message).includes('model exploded'));
      expect((await context.prompt(stream, 'after the failure')).kind).toBe('ack');
      await stream.waitForMessage((message) => message.type === 'model-output' && (message.text ?? message.delta) === 'answer: after the failure');
      expect(fake.ledger.commands('run.start').filter((entry) => payloadOf(entry).prompt === 'after the failure').length).toBe(1);
      stream.close();
    },
  },
  {
    title: 'a permission rejected in the app reaches the Hub as a rejection, and only approve and reject are offered',
    async run(context) {
      const fake = context.fake as ClineFake;
      const session = await context.drivableSession('reject');
      const stream = await context.openDrive(session);
      const mark = fake.ledger.mark();
      const turn = context.prompt(stream, '[[permission]] run the tool');
      const card = await stream.waitForMessage((message) => message.type === 'permission-request');
      expect(card.options).toEqual(['approve', 'reject']);
      expect((await stream.sendAndAwait({ kind: 'approve', requestId: card.requestId, decision: 'approve-session' })).kind).toBe('nack');
      expect(fake.ledger.commands('approval.respond', mark)).toEqual([]);
      expect((await stream.sendAndAwait({ kind: 'approve', requestId: card.requestId, decision: 'reject' })).kind).toBe('ack');
      expect((await turn).kind).toBe('ack');
      const replies = fake.ledger.commands('approval.respond', mark).map(payloadOf);
      expect(replies.map((reply) => [reply.approvalId, reply.approved])).toEqual([[card.requestId, false]]);
      await stream.waitForMessage((message) => message.type === 'model-output' && String(message.text ?? message.delta).includes('permission reject'));
      stream.close();
    },
  },
  {
    title: 'a rewrite of the Hub transcript is refused at the next prompt and ends Drive (C15 for a Hub-read transcript)',
    async run(context) {
      const fake = context.fake as ClineFake;
      const session = await context.drivableSession('hub rewrite');
      const stream = await context.openDrive(session);
      expect((await context.prompt(stream, 'before the rewrite')).kind).toBe('ack');
      const mark = fake.ledger.mark();
      fake.rewriteHistory(session);
      const refused = await stream.sendAndAwait({ kind: 'prompt', text: 'after the rewrite' });
      expect(refused.kind).toBe('nack');
      expect(fake.ledger.commands('run.start', mark)).toEqual([]);
      await stream.waitForFrame((frame) => frame.kind === 'session' && frame.info?.control?.drive?.state !== 'driving');
      stream.close();
    },
  },
  {
    title: 'with a Hub that answers the aborted run, Stop keeps Drive and the next prompt is sent',
    async run(context) {
      const fake = context.fake as ClineFake;
      const previous = fake.configure({ abortReply: 'aborted' });
      try {
        const session = await context.drivableSession('courteous hub');
        const stream = await context.openDrive(session);
        const turn = context.prompt(stream, '[[hold:courteous]] a long turn');
        await eventually(() => fake.ledger.commands('run.start').some((entry) => payloadOf(entry).prompt.includes('[[hold:courteous]]')), { what: 'the held run' });
        expect((await stream.sendAndAwait({ kind: 'command', name: 'stop' })).kind).toBe('ack');
        expect((await turn).kind).toBe('ack');
        expect(fake.ledger.commands('run.abort').length).toBeGreaterThan(0);
        expect((await context.prompt(stream, 'after stop')).kind).toBe('ack');
        stream.close();
      } finally {
        fake.configure({ abortReply: previous.abortReply ?? 'none' });
      }
    },
  },
  {
    title: 'rename escalates to the native history command in the isolated profile, with no Hub launch controls',
    async run(context) {
      const fake = context.fake as ClineFake;
      const session = await context.drivableSession('before rename');
      const stream = await context.openDrive(session);
      expect((await context.prompt(stream, 'name me')).kind).toBe('ack');
      const mark = fake.ledger.mark();
      const renamed = await context.client.request('PATCH', `/api/sessions/cline/${session.id}/rename`, { title: '  After rename  ' });
      expect(renamed.status, renamed.text).toBe(200);
      expect(renamed.body.title).toBe('After rename');
      const updates = fake.ledger.since(mark).filter((entry) => entry.kind === 'history-update');
      expect(updates.length).toBe(1);
      expect(updates[0]!.argv).toEqual(['history', 'update', '--session-id', session.id, '--title', 'After rename']);
      expect(updates[0]!.dataDir).toBe(fake.profileDir);
      expect(updates[0]!.hubLaunchControls).toEqual([]);
      const row = await context.client.waitForSession((candidate) => candidate.id === session.id && candidate.title === 'After rename');
      expect(row.title).toBe('After rename');
      stream.close();
    },
  },
];

function readdirNames(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
