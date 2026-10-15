/**
 * Kimi Code conformance kit: a live host the USER runs (`kimi web`), found through the registry the host writes
 * under `KIMI_CODE_HOME`, where Drive is `mode=live` on sessions this broker created in this run.
 *
 * The native side is two fakes, neither of which ever touches a real Kimi:
 *
 *   - `fakes/kimi-host.ts`: the `kimi web` server in the test process on a loopback port, with its token file,
 *     instance record and wire journal under a fixture `KIMI_CODE_HOME`. The broker is told not to start one
 *     (`COSYNCING_KIMI_MANAGED_HOST=0`, in the fixture environment), as with a host the user already runs;
 *   - `fakes/kimi-cli.ts`: the `kimi` binary in the fixture PATH. It only answers `--version` (the doctor probe).
 *
 * Every request the host receives lands in the ledger, in Kimi's own vocabulary; `KimiLedger` reads it in the
 * conformance vocabulary (`POST /sessions` is `session/new`, `…/prompts` is `session/prompt`, `:abort` is
 * `session/cancel`), so the shared scenarios read it unchanged.
 */
import { expect } from 'bun:test';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { eventually, fixturePath, type FixturePaths, type SessionStream } from '../../harness/index.ts';
import { FakeKimiHost, type KimiSession } from './fakes/kimi-host.ts';
import {
  type ConformanceExtra,
  type ConformanceKit,
  type ConformanceProfile,
  type FakeController,
  installFakeExecutable,
  type InstalledFake,
  Ledger,
  type LedgerEntry,
  type SeededSession,
  type SeedOptions,
  treeSnapshot,
} from './kit.ts';

export const KIMI_VERSION = '0.35.0';
export const KIMI_PROVIDER = 'test-provider';

const HOSTILE_ATTACH_BUG = 'a bare attach to an id the roster withholds yields an empty observe history instead of an error: the adapter synthesizes a placeholder session for any id';

export const kimiProfile: ConformanceProfile = {
  agent: 'kimi',
  displayName: 'Kimi Code',
  // The integration kind is the one value a pre-tolerance client could not decode: such a client is not shown the agent.
  minimumClientRevision: 14,
  capabilities: {
    integrationKind: 'http-websocket',
    attachModes: ['observe', 'live'],
    supportsObserve: true,
    supportsResume: false,
    supportsLiveAttach: true,
    supportsCrossClientDriveSharing: true,
    supportsNativeArtifact: false,
    supportsNativeFileInput: true,
    supportsModelSwitch: true,
    permissionGranularity: 'per-session',
  },
  driveFamily: 'live-host',
  driveEligibility: 'app-created',
  version: {
    current: KIMI_VERSION,
    below: '0.34.9',
    newer: '0.36.0',
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
    models: [`${KIMI_PROVIDER}/model-a`, `${KIMI_PROVIDER}/model-b`],
    modes: ['manual', 'auto', 'yolo'],
    commands: ['stop', 'goal', 'fixture-skill'],
    stopCommand: 'stop',
    switchModel: { providerID: KIMI_PROVIDER, modelID: 'model-b' },
    unknownCommandsForwarded: false,
  },
  driveArgv: { required: [], forbidden: [] },
  createChildAdopted: false,
  // The host stores a prompt's user row the moment it accepts it.
  userRowDurable: 'turn-start',
  // The host's own row is the sender's first sight of its prompt, carrying the sender's key; a reloaded history
  // keeps only the host's message id.
  promptEcho: 'native',
  historyClientKey: false,
  // A second prompt is accepted by the host at once and queued behind the running turn.
  midTurnPrompt: 'steered',
  modelSwitch: 'per-turn',
  permission: { approveReply: 'approved', answerMentions: 'permission approved' },
  driveAttach: 'live',
  liveRefusal: 'observe',
  // The Kimi host owns the session: there is no terminal to hand Drive to, and no resume command for a live host.
  terminal: { resumeHint: null, syncAvailable: false, handoff: false },
  observeRunSummaries: false,
  restartKeepsDrive: false,
  subagents: true,
  missingBinaryRoster: 'hidden',
  scenarios: {
    C06: {
      skip: 'a Kimi history is the host\'s own REST projection of its journal: there is no log the broker reads or '
        + 'replaces, so there is no rewrite to detect (rows the host stops listing are the host\'s truth).',
    },
    C07: {
      skip: 'a session is created by one POST /api/v1/sessions on the host: the session/new and child-adoption '
        + 'bookkeeping this scenario asserts does not exist (the create extra asserts the real flow and that a '
        + 'session the host already lists cannot be claimed).',
    },
    C08: {
      skip: 'Drive is a live attach to the user\'s `kimi web`: there is no lazy resume, no child to start and no '
        + 'session/load (the "no process" extra asserts that nothing but the host is ever contacted).',
    },
    C15: {
      skip: 'a Kimi session has no log the broker replaces: foreign writes show as rows in the host\'s answer (C14), '
        + 'and the host\'s own restart is the generation-replacement scenario in kimi-host.',
    },
    C16: {
      skip: 'Kimi has no runtime version gate on Create or Drive: the host identity gate compares the registry '
        + 'record\'s version with the host\'s own (kimi-host, K3 gate table); C22 asserts the doctor verdict per version.',
    },
    C19: {
      skip: 'Kimi\'s commands are the stop and goal actions and the host\'s skills, which are activated through '
        + '`:activate` and never ride the prompt queue (kimi-host asserts /goal and skill activation).',
    },
  },
  hostileStore: [
    {
      name: 'a roster row without an id',
      knownBug: { aspect: 'attach', bug: HOSTILE_ATTACH_BUG },
      plant: (fake) => plantRoster(fake, { workspace: { id: 'wd_x', cwd: '/x' }, meta: { title: 'no id' } }, 'session_record_without_id'),
    },
    {
      name: 'a roster row whose id is not a string',
      knownBug: { aspect: 'attach', bug: HOSTILE_ATTACH_BUG },
      plant: (fake) => plantRoster(fake, { id: 42, workspace: { id: 'wd_x', cwd: '/x' }, meta: { title: 'numeric id' } }, '42'),
    },
  ],
};

function plantRoster(fake: FakeController, row: Record<string, unknown>, hostile: string): string {
  (fake as KimiFake).host.plantRosterRow(row);
  return hostile;
}

// --------------------------------------------------------------------- ledger

/** The host's raw request log, read in the conformance vocabulary (see the file header). */
export class KimiLedger extends Ledger {
  /** Kimi starts no process of the broker's. */
  override spawns(): LedgerEntry[] {
    return [];
  }

  override requests(method: string, from = 0): LedgerEntry[] {
    const shaped: LedgerEntry[] = [];
    for (const entry of this.since(from)) {
      if (entry.kind !== 'request' || entry.method !== 'POST') continue;
      const path = String(entry.path);
      const body = (entry.body ?? {}) as Record<string, any>;
      const session = /^\/api\/v1\/sessions\/([^/:]+)(?::(\w+))?(?:\/(.*))?$/.exec(path);
      let native: string | undefined;
      if (path === '/api/v1/sessions') native = 'session/new';
      else if (session?.[3] === 'prompts') native = 'session/prompt';
      else if (session?.[2] === 'abort') native = 'session/cancel';
      if (native !== method) continue;
      shaped.push({
        ...entry,
        kind: 'recv',
        frame: {
          method,
          params: {
            sessionId: session?.[1],
            cwd: body.metadata?.cwd,
            prompt: native === 'session/prompt'
              ? [{ text: (body.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => String(part.text ?? '')).join('') }]
              : undefined,
            ...(body.model !== undefined ? { model: body.model } : {}),
          },
          native: body,
        },
      });
    }
    return shaped;
  }

  override replies(idPrefix: string, from = 0): LedgerEntry[] {
    return this.since(from)
      .filter((entry) => entry.kind === 'permission-reply' && String(entry.id).startsWith(idPrefix))
      .map((entry) => ({ ...entry, kind: 'recv', frame: { id: entry.id, result: { outcome: entry.reply } } }));
  }

  /** Every request the host received, as `METHOD /path`, from a mark. */
  paths(from = 0): string[] {
    return this.since(from).filter((entry) => entry.kind === 'request').map((entry) => `${entry.method} ${entry.path}`);
  }

  /** The write requests (everything that is not a GET), from a mark. */
  writes(from = 0): LedgerEntry[] {
    return this.since(from).filter((entry) => entry.kind === 'request' && entry.method !== 'GET');
  }

  /** The WebSocket frames a client sent, from a mark. */
  wsFrames(from = 0): Array<Record<string, any>> {
    return this.since(from).filter((entry) => entry.kind === 'ws-recv').map((entry) => entry.frame as Record<string, any>);
  }
}

// -------------------------------------------------------------- fake control

export interface KimiFake extends FakeController {
  readonly ledger: KimiLedger;
  readonly host: FakeKimiHost;
  readonly cli: InstalledFake;
  readonly paths: FixturePaths;
  readonly home: string;
  /** Subagent children written under a parent session's tree. */
  seedChild(parent: SeededSession, options?: { title?: string }): SeededSession;
}

export const kimiKit: ConformanceKit = {
  profile: kimiProfile,
  env: (paths) => ({
    KIMI_CODE_HOME: kimiHomeOf(paths),
    // The adapter's poll tick (10 s in production) is what confirms a foreign write: a source-only hook shortens it.
    COSYNCING_TEST_KIMI_POLL_MS: '150',
  }),
  install: (paths) => installKimi(paths),
  get extras(): ConformanceExtra[] {
    return kimiExtras;
  },
};

export const kimiHomeOf = (paths: FixturePaths): string => join(paths.root, 'kimi-home');

const line = (record: unknown): string => `${JSON.stringify(record)}\n`;

export function installKimi(paths: FixturePaths, options: { version?: string } = {}): KimiFake {
  const home = kimiHomeOf(paths);
  const state = join(paths.root, 'fakes', 'kimi');
  mkdirSync(state, { recursive: true });
  mkdirSync(home, { recursive: true });
  const ledger = new KimiLedger(join(state, 'ledger.jsonl'));
  const host = new FakeKimiHost({ home, ledgerPath: ledger.path, version: options.version ?? KIMI_VERSION });
  host.start();
  const cli = installFakeExecutable(paths.bin, 'kimi', 'kimi-cli.ts', { version: KIMI_VERSION, ledger: ledger.path });
  let workspaces = 0;
  let seeded = 0;
  let doctorVariants = 0;
  const partials = new Map<string, string>();
  const children = new Map<string, string[]>();

  const writeState = (parent: KimiSession): void => {
    const directory = host.sessionDirectory(parent.id);
    mkdirSync(directory, { recursive: true });
    const agents: Record<string, unknown> = { main: { homedir: join(directory, 'agents', 'main'), type: 'main', parentAgentId: null } };
    for (const child of children.get(parent.id) ?? []) {
      agents[child] = { homedir: join(directory, 'agents', child), type: 'sub', parentAgentId: 'main', labels: { parentAgentId: 'main' } };
    }
    writeFileSync(join(directory, 'state.json'), JSON.stringify({
      id: parent.id, version: 2, cwd: parent.cwd, createdAt: parent.createdAt, updatedAt: parent.updatedAt,
      archived: false, agents, custom: {}, title: parent.title, isCustomTitle: false,
    }));
  };

  const controller: KimiFake = {
    ledger,
    host,
    cli,
    paths,
    home,
    storeRoot: home,
    workspace(name = 'workspace') {
      const directory = join(paths.root, 'workspaces', `${name}-${++workspaces}`);
      mkdirSync(directory, { recursive: true });
      return directory;
    },
    seedSession(options: SeedOptions = {}): SeededSession {
      if (options.childOf) return controller.seedChild(options.childOf, { title: options.title });
      const cwd = controller.workspace('seed');
      const title = options.title ?? `Kimi seeded ${++seeded}`;
      const turns = options.turns ?? 1;
      const session = host.seed({ cwd, title, turns });
      const texts: string[] = [];
      for (let turn = 1; turn <= turns; turn += 1) texts.push(`seeded prompt ${turn}`, `seeded answer ${turn}`);
      // A parent that has children publishes this lineage id (and only then).
      return { id: session.id, cwd, title, texts, rosterNativeId: `kimi-session:${session.id}` };
    },
    seedChild(parentSeed, options = {}) {
      const parent = host.sessions.get(parentSeed.id)!;
      const slots = children.get(parent.id) ?? [];
      const agentDir = `agent-${slots.length}`;
      slots.push(agentDir);
      children.set(parent.id, slots);
      writeState(parent);
      const directory = join(host.sessionDirectory(parent.id), 'agents', agentDir);
      mkdirSync(directory, { recursive: true });
      const title = options.title ?? `Child ${agentDir}`;
      const created = Date.now() - 3_000_000;
      const path = join(directory, 'wire.jsonl');
      writeFileSync(path, [
        { type: 'metadata', protocol_version: '1.5', created_at: created },
        { type: 'config.update', cwd: parent.cwd, modelAlias: 'model-a', thinkingEffort: 'high', time: created },
        { type: 'profile.bind', modelAlias: 'model-a', profileName: 'coder', thinkingEffort: 'high', systemPrompt: 'You are now running as a subagent.', time: created },
        { type: 'turn.prompt', input: [{ type: 'text', text: title }], origin: { kind: 'system_trigger' }, time: created + 10 },
        { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: title }], toolCalls: [], origin: { kind: 'system_trigger' } }, time: created + 11 },
        { type: 'turn.ended', time: created + 60_000 },
        { type: 'token_counting.turn_recorded', time: created + 60_001 },
      ].map(line).join(''));
      const fresh = (Date.now() - 5_000) / 1000;
      utimesSync(path, fresh, fresh);
      return { id: `kimi-subagent:${parent.id}/${agentDir}`, cwd: parent.cwd, title, texts: [] };
    },
    prepareCreate: (id) => host.prepareCreate(id),
    appendTurn(session, user, answer) {
      const parent = host.sessions.get(session.id)!;
      host.appendRow(parent, 'user', user);
      host.appendRow(parent, 'assistant', answer);
      // The host has the session loaded: it tells its subscribers the transcript moved.
      host.emit(session.id, 'transcript.ops', {});
    },
    appendForeignUser(session, text) {
      // A terminal's `kimi -S` writes the journal itself: the host announces nothing.
      host.appendRow(host.sessions.get(session.id)!, 'user', text);
    },
    appendPartial(session, text) {
      partials.set(session.id, text);
    },
    completePartial(session) {
      const text = partials.get(session.id)!;
      partials.delete(session.id);
      const parent = host.sessions.get(session.id)!;
      host.appendRow(parent, 'user', text);
      host.appendRow(parent, 'assistant', 'partial answer');
      host.emit(session.id, 'transcript.ops', {});
    },
    rewriteHistory(session) {
      const parent = host.sessions.get(session.id)!;
      const first = parent.messages.find((row) => row.role === 'user')!;
      first.content = [{ type: 'text', text: 'rewritten first prompt' }];
      host.emit(session.id, 'transcript.ops', {});
    },
    replaceLog() {
      throw new Error('a Kimi session has no log to replace');
    },
    watcherNoise(session) {
      // A frame type the adapter does not map: the host chattering about something else.
      host.emit(session.id, 'event.session.noise', {});
    },
    setVersion(version, output) {
      cli.writeConfig({ ...cli.readConfig<Record<string, unknown>>(), version, ...(output === undefined ? { versionOutput: undefined } : { versionOutput: output }) });
    },
    setInstalled(installed) {
      // No Kimi at all: the binary is gone and no host is registered.
      cli.setInstalled(installed);
      if (installed) host.register();
      else host.unregister();
    },
    release: (tag) => host.release(tag),
    configure: () => ({}),
    doctorEnvironment(variant) {
      const base = fixturePath(join(paths.root, 'no-agents'));
      if (variant.missing) return { PATH: base };
      const directory = join(state, `doctor-${++doctorVariants}`);
      mkdirSync(directory, { recursive: true });
      installFakeExecutable(directory, 'kimi', 'kimi-cli.ts', { version: variant.version ?? KIMI_VERSION });
      return { PATH: [directory, base].join(delimiter) };
    },
    storeSnapshot() {
      return treeSnapshot(join(home, 'sessions'));
    },
    promptSettled(_stream: SessionStream, text: string) {
      const mark = ledger.mark();
      return async () => {
        await eventually(() => ledger.since(mark).some((entry) => (entry.kind === 'turn-end' || entry.kind === 'turn-aborted') && entry.text === text), {
          what: `the fake host to settle the turn "${text}"`,
        });
      };
    },
    async cleanup() {
      host.releaseAll();
      host.stop();
    },
  };
  return controller;
}

// --------------------------------------------------------------------- extras

const fakeOf = (context: { fake: FakeController }): KimiFake => context.fake as KimiFake;

const kimiExtras: ConformanceExtra[] = [
  {
    title: 'Drive is a live attach to the user\'s host: the broker contacts nothing but the host and starts no process',
    async run(context) {
      const fake = fakeOf(context);
      const session = await context.drivableSession('live attach');
      const mark = fake.ledger.mark();
      const stream = await context.openDrive(session);
      expect((await context.prompt(stream, 'one turn')).kind).toBe('ack');
      expect(fake.ledger.since(mark).filter((entry) => ['cli', 'spawn'].includes(entry.kind))).toEqual([]);
      const row = await context.client.waitForSession((candidate) => candidate.id === session.id);
      expect(row.attachMode).toBe('live');
      expect(row.control?.terminalSync?.supported).toBe(false);
      stream.close();
    },
  },
  {
    title: 'create makes one session in the chosen folder, the model rides the first prompt, and an existing id cannot be claimed',
    async run(context) {
      const fake = fakeOf(context);
      const id = fake.prepareCreate();
      const cwd = fake.workspace('create');
      const target = { providerID: KIMI_PROVIDER, modelID: 'model-b' };
      const mark = fake.ledger.mark();
      const created = await context.client.post('/api/sessions/kimi', { directory: cwd, title: 'Created by the app', model: target });
      expect(created.status, created.text).toBe(200);
      const info = created.body.session;
      expect(info.id).toBe(id);
      expect(info.cwd).toBe(cwd);
      expect(info.title).toBe('Created by the app');
      expect(info.currentModel).toMatchObject(target);
      expect(info.control.drive.supported).toBe(true);
      // One POST in that folder; the model is not sent on create (the host ignores it there).
      const natives = fake.ledger.requests('session/new', mark);
      expect(natives.length).toBe(1);
      expect(natives[0]!.frame?.params?.cwd).toBe(cwd);
      expect((natives[0]!.frame?.native as any).model).toBeUndefined();
      const stream = await context.openDrive({ id, cwd, reason: 'create' });
      expect((await context.prompt(stream, 'first prompt')).kind).toBe('ack');
      // The create-time model is spent by the first prompt.
      expect(fake.ledger.requests('session/prompt', mark).map((entry) => entry.frame?.params?.model)).toEqual(['model-b']);
      stream.close();
      // A session the host already lists is observed, never claimed by a create that reuses its id.
      const existing = fake.seedSession({ title: 'Listed by the host' });
      await context.client.waitForSession((row) => row.id === existing.id);
      const direct = await context.client.attach('kimi', existing.id, { mode: 'live' });
      await direct.waitForKind('history');
      expect(direct.frames.some((frame) => frame.kind === 'session' && frame.authority?.canMutate === true)).toBe(false);
      direct.close();
    },
  },
  {
    title: 'a refused credential is retired and the host is re-read: a rotated token is picked up without a restart',
    async run(context) {
      const fake = fakeOf(context);
      const seeded = fake.seedSession({ title: 'Before rotation' });
      await context.client.waitForSession((row) => row.id === seeded.id);
      const token = fake.host.token;
      try {
        fake.host.rotateToken();
        // The next roster read carries the new token: the adapter reads the token file per operation.
        const survivor = fake.seedSession({ title: 'After rotation' });
        await context.client.waitForSession((row) => row.id === survivor.id);
      } finally {
        fake.host.rotateToken(token);
      }
    },
  },
];
