/**
 * OpenCode conformance kit, shared-serve mode: the product default, where the broker (or the user)
 * runs one `opencode serve` and every session it lists is already driven through it
 * (`driveFamily: 'live-host'`: there is no takeover and no child the broker starts).
 *
 * The native side is two fakes, neither of which ever touches a real OpenCode:
 *
 *   - `fakes/opencode-serve.ts`: a scriptable serve in the test process on a leased loopback port.
 *     The broker finds it only through `OPENCODE_URL`, set explicitly here (a portless or unset URL
 *     would name 4096, where a real serve may listen on a developer machine), with autoserve off.
 *   - `fakes/opencode-cli.ts`: the `opencode` binary in the fixture PATH (version probes for
 *     doctor and the private `run` child). It never listens.
 *
 * Every request the serve receives lands in the ledger, so a test can prove which endpoint the
 * product used, and `assertNoRealOpenCode` proves nothing in the run reached 4096.
 *
 * The ledger answers the conformance vocabulary over OpenCode's own HTTP calls:
 *
 *   session/new     ← POST /session
 *   session/prompt  ← POST /session/:id/prompt_async and POST /session/:id/command
 *   session/cancel  ← POST /session/:id/abort
 *   spawn           ← an `opencode run` child (private Drive; never started in serve mode)
 *   session/load    ← (no equivalent: a serve session is never loaded into a child)
 */
import { expect } from 'bun:test';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { eventually, fixturePath, type FixturePaths, type SessionStream } from '../../harness/index.ts';
import { openCodeRows } from '../../harness/fakes/opencode-server.ts';
import { FakeOpenCodeServe } from './fakes/opencode-serve.ts';
import type { FakeOpencodeCliConfig } from './fakes/opencode-cli.ts';
import {
  type ConformanceContext,
  type ConformanceExtra,
  type ConformanceKit,
  type ConformanceProfile,
  type FakeController,
  type InstalledFake,
  installFakeExecutable,
  Ledger,
  type LedgerEntry,
  type SeededSession,
  type SeedOptions,
} from './kit.ts';

export const OPENCODE_VERSION = '1.17.19';
export const OPENCODE_PROVIDER = 'test-provider';

export const opencodeProfile: ConformanceProfile = {
  agent: 'opencode',
  displayName: 'OpenCode',
  capabilities: {
    integrationKind: 'http-sse',
    attachModes: ['observe', 'resume', 'live'],
    supportsObserve: true,
    supportsResume: true,
    supportsLiveAttach: true,
    supportsNativeArtifact: true,
    supportsNativeFileInput: true,
    supportsModelSwitch: true,
    permissionGranularity: 'per-tool',
  },
  driveFamily: 'live-host',
  driveEligibility: 'stored-idle',
  version: {
    current: OPENCODE_VERSION,
    below: '1.17.18',
    newer: '1.18.0',
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
    models: [`${OPENCODE_PROVIDER}/model-a`, `${OPENCODE_PROVIDER}/model-b`],
    modes: [],
    commands: ['review', 'compact', 'undo', 'redo', 'stop', 'share', 'unshare'],
    stopCommand: 'stop',
    switchModel: { providerID: OPENCODE_PROVIDER, modelID: 'model-b' },
    unknownCommandsForwarded: true,
  },
  driveArgv: { required: [], forbidden: [] },
  createChildAdopted: false,
  userRowDurable: 'turn-start',
  promptEcho: 'native',
  midTurnPrompt: 'steered',
  modelSwitch: 'per-turn',
  permission: { approveReply: 'once', answerMentions: 'permission once' },
  // Every session the serve lists is already driven through it: the roster says `driving`, and a bare
  // attach is the writer itself. `mode=resume` would start a private `opencode run` child instead.
  rosterDriveState: 'driving',
  bareAttach: { authority: { canMutate: true, prompt: 'full' }, attachMode: 'live' },
  readOnlyAttach: { params: { readOnly: true }, attachMode: 'live' },
  driveAttach: 'bare',
  terminal: {
    // The join command is `opencode attach '<serve url>' -s '<id>' --dir '<cwd>'` (an extra asserts it whole).
    resumeHint: 'opencode attach',
    syncAvailable: true,
  },
  subagents: false,
  missingBinaryRoster: 'hidden',
  knownBugs: {
    C21: 'attaching to an id the serve never listed (or the roster withholds) yields an empty history frame '
      + 'instead of an error: the adapter falls back to a placeholder session for any id',
    'C11.lateDuplicate': 'a tab that joins while a permission card is open receives that card twice as live '
      + 'messages (same requestId, around the status frame), outside its history frame',
    'C04.explicit': 'an explicit mode=observe attach of a shared-serve session is granted full authority '
      + '(canMutate true, prompt full) and its prompts reach the serve; only readOnly=1 renounces it',
  },
  scenarios: {
    C07: {
      skip: 'a serve session is created by one POST /session, with no child: the create child-adoption and '
        + 'session/new bookkeeping this scenario asserts does not exist (the create extra asserts the real flow).',
    },
    C08: {
      skip: 'a serve session is already driven through the shared serve: there is no lazy resume, no child to '
        + 'start and no session/load (the "attach is Drive" extra asserts that no `opencode run` child starts).',
    },
    C14: {
      skip: 'a terminal on the same serve is a co-owner, not a foreign writer: its prompts arrive on the shared '
        + 'event bus and show live (C05) while Drive stays with the app.',
    },
    C15: {
      skip: 'a serve session has no log the broker reads or replaces: history is the serve\'s own `/message` answer '
        + '(C06 covers a rewrite through message.part.removed).',
    },
    C16: {
      skip: 'OpenCode has no runtime version gate on Create or Drive (the managed serve restarts a stale serve, '
        + 'see the managed-serve file); C22 asserts the doctor verdicts for each version.',
    },
  },
  // OpenCode's "store" is the serve's own session list: these are records it lists that the broker must
  // not publish as a session of its own.
  hostileStore: [
    {
      name: 'a session record without an id',
      plant: (fake) => {
        (fake as OpencodeFake).serve.plantRaw(fake.workspace('hostile'), { title: 'no id', directory: '/tmp', time: { created: 1, updated: 2 } });
        return 'ses_record_without_id';
      },
    },
    {
      name: 'a session record whose id is not a string',
      plant: (fake) => {
        (fake as OpencodeFake).serve.plantRaw(fake.workspace('hostile'), { id: 42, title: 'numeric id', directory: '/tmp', time: { created: 1, updated: 2 } });
        return '42';
      },
    },
    {
      name: 'a session id that climbs out of the session route',
      knownBug: 'the roster publishes an id like ../../etc/passwd as a session, and the adapter splices ids into serve '
        + 'URLs unencoded, so attaching to it requests GET /etc/passwd (and /etc/passwd/message) on the serve',
      plant: (fake) => {
        const directory = fake.workspace('hostile');
        (fake as OpencodeFake).serve.plantRaw(directory, { id: '../../etc/passwd', title: 'traversal', directory, time: { created: 1, updated: 2 } });
        return '../../etc/passwd';
      },
    },
  ],
};

// --------------------------------------------------------------------- ledger

const normalizedPaths = (entry: LedgerEntry): { sessionId: string; sub: string } | undefined => {
  const match = /^\/session\/([^/]+)\/(.+)$/.exec(String(entry.path ?? ''));
  return match ? { sessionId: decodeURIComponent(match[1]!), sub: match[2]! } : undefined;
};

/** The text a prompt request carries (`prompt_async` parts, or a template command and its arguments). */
function requestText(entry: LedgerEntry): string {
  const body = (entry.body ?? {}) as Record<string, any>;
  if (typeof body.command === 'string') return `/${body.command}${body.arguments ? ` ${String(body.arguments)}` : ''}`;
  return (body.parts ?? []).filter((part: any) => part?.type === 'text').map((part: any) => String(part.text ?? '')).join('');
}

/** The fake serve's raw request log, read in the conformance vocabulary (see the file header). */
export class OpencodeLedger extends Ledger {
  /** `opencode run` children: the private Drive writer (never started in serve mode). */
  override spawns(from = 0): LedgerEntry[] {
    return this.since(from).filter((entry) => entry.kind === 'spawn');
  }

  override requests(method: string, from = 0): LedgerEntry[] {
    const entries = this.since(from).filter((entry) => entry.kind === 'request' && entry.method === 'POST');
    const shaped: LedgerEntry[] = [];
    for (const entry of entries) {
      const parts = normalizedPaths(entry);
      let native: string | undefined;
      if (entry.path === '/session') native = 'session/new';
      else if (parts?.sub === 'prompt_async' || parts?.sub === 'command') native = 'session/prompt';
      else if (parts?.sub === 'abort') native = 'session/cancel';
      if (native !== method) continue;
      shaped.push({
        ...entry,
        kind: 'recv',
        frame: {
          method,
          params: {
            sessionId: parts?.sessionId,
            cwd: (entry.query as Record<string, string> | undefined)?.directory,
            prompt: native === 'session/prompt' ? [{ text: requestText(entry) }] : undefined,
          },
          native: entry.body,
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

  /** Every request the serve received, as `METHOD /path`, optionally from a mark. */
  paths(from = 0): string[] {
    return this.since(from).filter((entry) => entry.kind === 'request').map((entry) => `${entry.method} ${entry.path}`);
  }

  /** Requests of one route (path pattern), oldest first. */
  routed(method: string, pattern: RegExp, from = 0): LedgerEntry[] {
    return this.since(from).filter((entry) => entry.kind === 'request' && entry.method === method && pattern.test(String(entry.path)));
  }
}

// -------------------------------------------------------------- fake control

export interface OpencodeFake extends FakeController {
  readonly ledger: OpencodeLedger;
  readonly serve: FakeOpenCodeServe;
  readonly cli: InstalledFake;
  readonly cliPath: string;
  readonly paths: FixturePaths;
}

export const opencodeKit: ConformanceKit = {
  profile: opencodeProfile,
  get extras(): ConformanceExtra[] {
    return opencodeExtras;
  },
  env: (paths) => ({
    // The fake serve is leased before the broker starts (see `install`); the URL names its exact port.
    OPENCODE_URL: `http://127.0.0.1:${leasedPort(paths)}`,
    COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
    // Keep the adapter's silence timeouts out of a loaded machine's way; reconnect tests set their own.
    OPENCODE_DATA: join(paths.root, 'opencode-data'),
  }),
  install(paths: FixturePaths): OpencodeFake {
    const installRoot = join(paths.root, 'fakes', 'opencode');
    const controlDir = join(installRoot, 'control');
    mkdirSync(controlDir, { recursive: true });
    const ledger = new OpencodeLedger(join(installRoot, 'ledger.jsonl'));
    const serve = new FakeOpenCodeServe({
      record: (entry) => appendFileSync(ledger.path, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...entry })}\n`),
      version: OPENCODE_VERSION,
      models: [
        { providerID: OPENCODE_PROVIDER, modelID: 'model-a', name: 'Model A' },
        { providerID: OPENCODE_PROVIDER, modelID: 'model-b', name: 'Model B' },
      ],
      agents: [{ name: 'build', description: 'Build things' }, { name: 'plan', description: 'Plan things' }],
      commands: [{ name: 'review', description: 'Review the current diff' }],
    });
    serve.start();
    leases.set(paths.root, serve.port);
    const cliConfig: FakeOpencodeCliConfig = { ledger: ledger.path, controlDir, version: OPENCODE_VERSION };
    const cli = installFakeExecutable(paths.bin, 'opencode', 'opencode-cli.ts', cliConfig);
    let workspaces = 0;
    let seeded = 0;
    let doctorVariants = 0;
    const partials = new Map<string, string>();
    const port = serve.port;

    const controller: OpencodeFake = {
      ledger,
      serve,
      cli,
      cliPath: cli.path,
      paths,
      storeRoot: join(paths.root, 'opencode-data'),
      workspace(name = 'workspace') {
        const directory = join(paths.root, 'workspaces', `${name}-${++workspaces}`);
        mkdirSync(directory, { recursive: true });
        return directory;
      },
      seedSession(options: SeedOptions = {}): SeededSession {
        const id = `ses_seed${String(++seeded).padStart(3, '0')}${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
        const cwd = options.childOf?.cwd ?? controller.workspace('seed');
        const title = options.title ?? `OpenCode seeded ${seeded}`;
        const turns = options.turns ?? 1;
        serve.seed({
          id,
          directory: cwd,
          title,
          turns,
          ...(options.childOf ? { parentID: options.childOf.id } : {}),
          model: { providerID: OPENCODE_PROVIDER, modelID: 'model-a' },
        });
        const texts: string[] = [];
        for (let turn = 1; turn <= turns; turn += 1) texts.push(`seeded prompt ${turn}`, `seeded answer ${turn}`);
        return { id, cwd, title, texts };
      },
      prepareCreate: (id) => serve.prepareCreate(id),
      appendTurn: (session, user, answer) => serve.appendTurn(session.id, user, answer),
      appendForeignUser: (session, text) => serve.appendTurn(session.id, text, 'terminal answer'),
      appendPartial(session) {
        partials.set(session.id, serve.appendPartial(session.id));
      },
      completePartial(session) {
        const messageId = partials.get(session.id)!;
        partials.delete(session.id);
        serve.completePartial(session.id, messageId, 'partial prompt', 'partial answer');
      },
      rewriteHistory: (session) => serve.rewriteFirstUserText(session.id, 'rewritten first prompt'),
      replaceLog() {
        throw new Error('a serve session has no log to replace');
      },
      watcherNoise: (session) => serve.noise(session.id),
      setVersion(version, output) {
        const next: FakeOpencodeCliConfig = { ...cli.readConfig<FakeOpencodeCliConfig>(), version };
        if (output === undefined) delete next.versionOutput;
        else next.versionOutput = output;
        cli.writeConfig(next);
        serve.setVersion(version);
      },
      setInstalled(installed) {
        // No OpenCode at all: the binary is gone and the serve is not listening.
        cli.setInstalled(installed);
        if (installed) serve.start(port);
        else serve.stop();
      },
      release(tag) {
        serve.release(tag);
        writeFileSync(join(controlDir, `release-${tag}`), '');
      },
      configure: () => ({}),
      doctorEnvironment(variant) {
        const base = fixturePath(join(paths.root, 'no-agents'));
        if (variant.missing) return { PATH: base };
        const directory = join(installRoot, `doctor-${++doctorVariants}`);
        mkdirSync(directory, { recursive: true });
        const installed = installFakeExecutable(directory, 'opencode', 'opencode-cli.ts', {
          ...cli.readConfig<FakeOpencodeCliConfig>(),
          version: variant.version ?? OPENCODE_VERSION,
        });
        void installed;
        return { PATH: [directory, base].join(delimiter) };
      },
      storeSnapshot() {
        const snapshot = new Map<string, string>();
        for (const [id, session] of serve.sessions) snapshot.set(`sessions/${id}.json`, JSON.stringify({ info: session.info, rows: session.rows }));
        return snapshot;
      },
      promptSettled(stream: SessionStream, text: string) {
        const mark = ledger.mark();
        return async () => {
          // The serve finished the turn this prompt started (or ended it by an abort).
          const visible = text;
          await eventually(() => ledger.since(mark).some((entry) => entry.kind === 'turn-end' && entry.text === visible)
            || ledger.since(mark).some((entry) => entry.kind === 'turn-aborted' && entry.text === visible), {
            what: `the fake serve to settle the turn "${text}"`,
          });
        };
      },
      async cleanup() {
        serve.releaseAll();
        serve.stop();
      },
    };
    return controller;
  },
};

// ------------------------------------------------------------- port leasing

// The broker's environment is built before `install` runs in `startBroker` (env is a function of paths,
// and setup runs first), so the serve's port is leased in `install` and read back here by root.
const leases = new Map<string, number>();
function leasedPort(paths: FixturePaths): number {
  const port = leases.get(paths.root);
  if (port === undefined) throw new Error('the fake OpenCode serve is not installed yet');
  return port;
}

// --------------------------------------------------------------------- extras
const serveOf = (context: ConformanceContext): FakeOpenCodeServe => (context.fake as OpencodeFake).serve;
const fakeOf = (context: ConformanceContext): OpencodeFake => context.fake as OpencodeFake;

const lastSession = (stream: SessionStream): any => stream.ofKind('session').at(-1);
const textOf = (message: any): string | undefined =>
  typeof message?.text === 'string' ? message.text : typeof message?.delta === 'string' ? message.delta : undefined;
const userTexts = (messages: any[]): string[] => messages.filter((message) => message.type === 'user-message').map(textOf) as string[];

/** The next history frame that restates the whole transcript (a reset) after frame index `from`. */
const nextReset = (stream: SessionStream, from: number, what: string) =>
  stream.waitForFrame((frame) => frame.kind === 'history' && frame.reset === true, { after: from, what });

/** The text each row shows once a client has applied every delta and whole row, by `type:key`. */
function liveRows(stream: SessionStream, from: number): Map<string, string> {
  const rows = new Map<string, string>();
  for (const frame of stream.frames.slice(from)) {
    if (frame.kind !== 'message') continue;
    const message = frame.message;
    if (!['model-output', 'thinking'].includes(message.type) || typeof message.key !== 'string') continue;
    const identity = `${message.type}:${message.key}`;
    if (typeof message.delta === 'string' && typeof message.text !== 'string') rows.set(identity, (rows.get(identity) ?? '') + message.delta);
    else rows.set(identity, message.text ?? rows.get(identity) ?? '');
  }
  return rows;
}

const shellQuoted = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const opencodeExtras: ConformanceExtra[] = [
  {
    title: 'attach is already Drive: no takeover, no child, and the terminal joins with `opencode attach`',
    async run(context) {
      const fake = fakeOf(context);
      // The broker talks to this fake on its leased port, never to the default 4096 or a host serve.
      expect(context.broker.env.OPENCODE_URL).toBe(fake.serve.url);
      expect(fake.serve.port).not.toBe(4096);
      const session = await context.drivableSession('serve drive');
      const mark = fake.ledger.mark();
      const stream = await context.openDrive(session);
      const info = lastSession(stream);
      expect(info.authority).toEqual({ canMutate: true, prompt: 'full' });
      expect(info.info.control.drive).toEqual({ supported: true, state: 'driving' });
      // Terminal sync is available, not active, and names this serve, session and folder.
      const sync = info.info.control.terminalSync;
      expect(sync).toMatchObject({ supported: true, syncAvailable: true, active: false, action: 'join' });
      expect(sync.command).toBe(`opencode attach ${shellQuoted(fake.serve.url)} -s ${shellQuoted(session.id)} --dir ${shellQuoted(session.cwd)}`);
      expect(info.info.terminalSyncHint.command).toBe(sync.command);
      expect((await context.prompt(stream, 'hello serve', { clientMessageId: 'serve-1' })).kind).toBe('ack');
      // One prompt, carrying the app's own native message id (the correlation handle), on the model the session runs.
      const posts = fake.ledger.routed('POST', /\/prompt_async$/, mark);
      expect(posts.length).toBe(1);
      expect(posts[0]!.body).toMatchObject({ parts: [{ type: 'text', text: 'hello serve' }] });
      expect(String((posts[0]!.body as any).messageID)).toMatch(/^msg_/);
      expect((posts[0]!.body as any).model).toBeUndefined();
      // The serve answered: nothing ran in a child, and nothing but the serve was ever used.
      expect(fake.ledger.spawns(mark)).toEqual([]);
      stream.close();
    },
  },
  {
    title: 'create makes one session in the chosen folder, and the chosen model rides the first prompt',
    async run(context) {
      const fake = fakeOf(context);
      const id = fake.prepareCreate();
      const cwd = fake.workspace('create');
      const target = { providerID: OPENCODE_PROVIDER, modelID: 'model-b' };
      const mark = fake.ledger.mark();
      const created = await context.client.post('/api/sessions/opencode', { directory: cwd, title: 'Created by the app', model: target });
      expect(created.status, created.text).toBe(200);
      const info = created.body.session;
      expect(info.id).toBe(id);
      expect(info.cwd).toBe(cwd);
      expect(info.title).toBe('Created by the app');
      expect(info.currentModel).toMatchObject(target);
      expect(info.control.drive).toEqual({ supported: true, state: 'driving' });
      // One POST /session in that folder; the prompt-only model field is not sent on create.
      const natives = fake.ledger.requests('session/new', mark);
      expect(natives.length).toBe(1);
      expect(natives[0]!.frame?.params?.cwd).toBe(cwd);
      expect(natives[0]!.frame?.native).toEqual({ title: 'Created by the app' });
      await context.client.waitForSession((row) => row.id === id && row.cwd === cwd && row.title === 'Created by the app');
      const stream = await context.openDrive({ id, cwd, reason: 'create' });
      expect((await context.prompt(stream, 'first prompt', { model: target })).kind).toBe('ack');
      expect(fake.ledger.routed('POST', /\/prompt_async$/, mark).map((entry) => (entry.body as any).model))
        .toEqual([{ providerID: OPENCODE_PROVIDER, modelID: 'model-b' }]);
      stream.close();
    },
  },
  {
    title: 'rename PATCHes the trimmed title, fork POSTs the message id, and a failure names no serve detail',
    async run(context) {
      const fake = fakeOf(context);
      const seeded = fake.seedSession({ title: 'Before rename', turns: 2 });
      await context.client.waitForSession((row) => row.id === seeded.id);
      const mark = fake.ledger.mark();
      const renamed = await context.client.request('PATCH', `/api/sessions/opencode/${seeded.id}/rename`, { title: '  After rename  ' });
      expect(renamed.status, renamed.text).toBe(200);
      expect(renamed.body.title).toBe('After rename');
      expect(fake.ledger.routed('PATCH', new RegExp(`^/session/${seeded.id}$`), mark).map((entry) => entry.body)).toEqual([{ title: 'After rename' }]);
      await context.client.waitForSession((row) => row.id === seeded.id && row.title === 'After rename');
      fake.serve.failNext('PATCH', 500);
      const refused = await context.client.request('PATCH', `/api/sessions/opencode/${seeded.id}/rename`, { title: 'Refused' });
      expect(refused.status).toBe(502);
      expect(refused.text).not.toContain('refused by the fake');
      // Fork from the second user row: the serve is asked for exactly that message, and the child is a new session.
      const second = fake.serve.session(seeded.id).rows[2]!.info.id as string;
      const forked = await context.client.post(`/api/sessions/opencode/${seeded.id}/fork`, { messageId: second });
      expect(forked.status, forked.text).toBe(200);
      expect(forked.body.session.id).not.toBe(seeded.id);
      expect(forked.body.session.cwd).toBe(seeded.cwd);
      expect(fake.ledger.routed('POST', new RegExp(`^/session/${seeded.id}/fork$`), mark).map((entry) => entry.body)).toEqual([{ messageID: second }]);
      fake.serve.failNext('POST', 500);
      const failed = await context.client.post(`/api/sessions/opencode/${seeded.id}/fork`, {});
      expect(failed.status).toBe(502);
      expect(failed.text).not.toContain('refused by the fake');
    },
  },
  {
    title: 'a subagent child carries lineage to its parent, and is not a fork point',
    async run(context) {
      const fake = fakeOf(context);
      const parent = fake.seedSession({ title: 'Parent' });
      const child = fake.seedSession({ title: 'Child', childOf: parent });
      const parentRow = await context.client.waitForSession((row) => row.id === parent.id);
      const childRow = await context.client.waitForSession((row) => row.id === child.id);
      expect(parentRow.origin ?? null).toBeNull();
      expect(childRow.origin).toBe('subagent');
      expect(childRow.parentThreadId).toBe(parent.id);
      const forked = await context.client.post(`/api/sessions/opencode/${child.id}/fork`, {});
      expect(forked.status).toBe(409);
      expect(forked.body.code).toBe('SESSION_AGENT_OWNED');
    },
  },
  {
    title: 'a question is one card, answered or dismissed through the serve',
    async run(context) {
      const fake = fakeOf(context);
      const session = await context.drivableSession('question');
      const owner = await context.openDrive(session);
      const mark = fake.ledger.mark();
      const turn = context.prompt(owner, '[[question]] ask me');
      const card = await owner.waitForMessage((message) => message.type === 'question-request');
      expect(card.questions[0].question).toBe('Which flavour?');
      expect(card.questions[0].options.map((option: any) => option.label)).toEqual(['vanilla', 'mint']);
      // A question is never also a permission card.
      expect(owner.messages().some((message) => message.type === 'permission-request')).toBe(false);
      // A forged id is refused by the serve and never settles the real card.
      expect((await owner.sendAndAwait({ kind: 'answer', requestId: `${card.requestId}-forged`, answers: [['mint']] })).kind).toBe('nack');
      expect((await owner.sendAndAwait({ kind: 'answer', requestId: card.requestId, answers: [['mint']] })).kind).toBe('ack');
      await owner.waitForMessage((message) => message.type === 'question-resolved' && message.requestId === card.requestId);
      // The forged id reached the serve, which refused it; the real one was settled once, in the card's folder.
      expect(fake.ledger.since(mark).filter((entry) => entry.kind === 'question-reply').map((entry) => [entry.id, entry.reply]))
        .toEqual([[card.requestId, [['mint']]]]);
      expect(fake.ledger.routed('POST', new RegExp(`^/question/${card.requestId}/reply$`), mark).map((entry) => entry.query))
        .toEqual([{ directory: session.cwd }]);
      expect((await turn).kind).toBe('ack');
      await owner.waitForMessage((message) => message.type === 'model-output' && textOf(message)?.includes('question [["mint"]]') === true);
      // A second question can be dismissed instead.
      const second = context.prompt(owner, '[[question]] ask me again');
      const again = await owner.waitForMessage((message) => message.type === 'question-request' && message.requestId !== card.requestId);
      expect((await owner.sendAndAwait({ kind: 'reject-question', requestId: again.requestId })).kind).toBe('ack');
      await owner.waitForMessage((message) => message.type === 'question-resolved' && message.requestId === again.requestId);
      expect(fake.ledger.routed('POST', new RegExp(`^/question/${again.requestId}/reject$`), mark).length).toBe(1);
      expect((await second).kind).toBe('ack');
      await owner.waitForMessage((message) => message.type === 'model-output' && textOf(message)?.includes('question dismissed') === true);
      owner.close();
    },
  },
  {
    title: 'undo reverts the last turn through the serve and redo restores it, in every open tab',
    async run(context) {
      const fake = fakeOf(context);
      const seeded = fake.seedSession({ title: 'undo', turns: 2 });
      await context.client.waitForSession((row) => row.id === seeded.id);
      const session = { id: seeded.id, cwd: seeded.cwd, reason: 'takeover' as const };
      const stream = await context.openDrive(session);
      const tab = await context.client.attach('opencode', session.id);
      await tab.waitForKind('history');
      const lastUser = fake.serve.session(seeded.id).rows[2]!.info.id as string;
      const mark = fake.ledger.mark();
      const from = stream.frames.length;
      const tabFrom = tab.frames.length;
      expect((await stream.sendAndAwait({ kind: 'command', name: 'undo' })).kind).toBe('ack');
      expect(fake.ledger.routed('POST', new RegExp(`^/session/${seeded.id}/revert$`), mark).map((entry) => entry.body)).toEqual([{ messageID: lastUser }]);
      // Both tabs get the revert-filtered history: the second prompt is gone, the first stays.
      for (const [reader, after] of [[stream, from], [tab, tabFrom]] as const) {
        const reset = await nextReset(reader, after, 'the reverted history');
        expect(userTexts(reset.messages)).toEqual([seeded.texts[0]!]);
      }
      expect((await stream.sendAndAwait({ kind: 'command', name: 'redo' })).kind).toBe('ack');
      expect(fake.ledger.routed('POST', new RegExp(`^/session/${seeded.id}/unrevert$`), mark).length).toBe(1);
      const restored = await stream.waitForFrame((frame) => frame.kind === 'history' && frame.reset === true
        && userTexts(frame.messages).length === 2, { after: from, what: 'the restored history' });
      expect(userTexts(restored.messages)).toEqual([seeded.texts[0]!, seeded.texts[2]!]);
      // Nothing left to redo, and a one-turn session has nothing to undo: notices, no native call.
      const before = fake.ledger.routed('POST', /\/(revert|unrevert)$/, mark).length;
      const nothing = await stream.sendAndAwait({ kind: 'command', name: 'redo' });
      expect(nothing.kind).toBe('ack');
      await stream.waitForFrame((frame) => frame.kind === 'notice' && /Nothing to redo/.test(String(frame.message)), { after: from });
      const single = fake.seedSession({ title: 'single turn', turns: 1 });
      await context.client.waitForSession((row) => row.id === single.id);
      const singleStream = await context.openDrive({ id: single.id, cwd: single.cwd, reason: 'takeover' });
      const singleMark = fake.ledger.mark();
      expect((await singleStream.sendAndAwait({ kind: 'command', name: 'undo' })).kind).toBe('ack');
      await singleStream.waitForFrame((frame) => frame.kind === 'notice' && /Nothing to undo/.test(String(frame.message)));
      expect(fake.ledger.routed('POST', /\/revert$/, singleMark)).toEqual([]);
      expect(before).toBe(2);
      singleStream.close();
      // A busy session refuses the revert, and the app is told why.
      const busy = context.prompt(stream, '[[hold:undo-busy]] still running');
      await eventually(() => fake.serve.session(seeded.id).busy, { what: 'the held turn to run' });
      expect((await stream.sendAndAwait({ kind: 'command', name: 'undo' })).kind).toBe('ack');
      await stream.waitForFrame((frame) => frame.kind === 'notice' && /busy/i.test(String(frame.message)), { after: from });
      fake.release('undo-busy');
      expect((await busy).kind).toBe('ack');
      stream.close();
      tab.close();
    },
  },
  {
    title: 'compact summarizes with the session model, and the compacted history replaces the transcript',
    async run(context) {
      const fake = fakeOf(context);
      const seeded = fake.seedSession({ title: 'compact', turns: 2 });
      await context.client.waitForSession((row) => row.id === seeded.id);
      const stream = await context.openDrive({ id: seeded.id, cwd: seeded.cwd, reason: 'takeover' });
      const mark = fake.ledger.mark();
      const from = stream.frames.length;
      expect((await stream.sendAndAwait({ kind: 'command', name: 'compact' })).kind).toBe('ack');
      await stream.waitForFrame((frame) => frame.kind === 'notice' && /Compacting/.test(String(frame.message)), { after: from });
      expect(fake.ledger.routed('POST', new RegExp(`^/session/${seeded.id}/summarize$`), mark).map((entry) => entry.body))
        .toEqual([{ providerID: OPENCODE_PROVIDER, modelID: 'model-a' }]);
      // The serve announces the compaction; the transcript is re-read once and shows the summary.
      const reset = await nextReset(stream, from, 'the compacted history');
      await stream.waitForFrame((frame) => frame.kind === 'notice' && frame.message === 'Compacted the conversation.', { after: from });
      expect(userTexts(reset.messages)).toEqual([seeded.texts[0]!]);
      expect((reset.messages as any[]).some((message) => textOf(message) === 'summary of the earlier conversation')).toBe(true);
      // A session whose model the serve does not name cannot be compacted: refused, nothing summarized.
      const modelless = `ses_nomodel${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
      const cwd = fake.workspace('nomodel');
      fake.serve.seed({ id: modelless, directory: cwd, title: 'no model', turns: 1 });
      await context.client.waitForSession((row) => row.id === modelless);
      const bare = await context.openDrive({ id: modelless, cwd, reason: 'takeover' });
      const bareMark = fake.ledger.mark();
      const refused = await bare.sendAndAwait({ kind: 'command', name: 'compact' });
      expect(refused.kind).toBe('nack');
      expect(String(refused.message)).toContain('session model unknown');
      expect(fake.ledger.routed('POST', /\/summarize$/, bareMark)).toEqual([]);
      bare.close();
      stream.close();
    },
  },
  {
    title: 'completion telemetry is not a terminal fence: a run ends at idle, or as an error when the serve fails it',
    async run(context) {
      const fake = fakeOf(context);
      const seeded = fake.seedSession({ title: 'fence' });
      await context.client.waitForSession((row) => row.id === seeded.id);
      const stream = await context.openDrive({ id: seeded.id, cwd: seeded.cwd, reason: 'takeover' });
      const from = stream.frames.length;
      // A turn typed in a terminal: the serve is busy and the assistant row already says completed.
      fake.serve.setBusy(seeded.id, true);
      fake.serve.addRow(seeded.id, openCodeRows.user('msg_term_u', Date.now(), 'typed in the terminal'));
      fake.serve.addRow(seeded.id, openCodeRows.assistant('msg_term_a', 'msg_term_u', Date.now(), [
        openCodeRows.text('prt_term_a', 'terminal answer', Date.now(), Date.now() + 1),
      ], Date.now() + 1));
      await stream.waitForMessage((message) => message.type === 'model-output' && textOf(message) === 'terminal answer');
      const summaries = (key: string) => stream.messages().slice(from)
        .filter((message) => message.type === 'run-summary' && message.userMessageKey === key);
      expect(summaries('msg_term_u').some((message) => message.status !== 'running')).toBe(false);
      fake.serve.setBusy(seeded.id, false);
      await stream.waitForMessage((message) => message.type === 'run-summary' && message.userMessageKey === 'msg_term_u' && message.status === 'done');
      // A turn the serve fails natively ends as an error, with the serve's one-line reason.
      const failed = await context.prompt(stream, '[[error]] explode');
      expect(failed.kind).toBe('ack');
      await stream.waitForMessage((message) => message.type === 'error' && message.message === 'model exploded');
      await stream.waitForMessage((message) => message.type === 'run-summary' && message.status === 'error');
      expect(stream.messages().slice(from).some((message) => message.type === 'run-summary' && message.status === 'done' && message.userMessageKey !== 'msg_term_u')).toBe(false);
      stream.close();
    },
  },
  {
    title: 'an identical message typed in a terminal is not stamped as the app\'s own send',
    async run(context) {
      const fake = fakeOf(context);
      const session = await context.drivableSession('stamp');
      const stream = await context.openDrive(session);
      expect((await context.prompt(stream, 'same words', { clientMessageId: 'stamp-1' })).kind).toBe('ack');
      await stream.waitForMessage((message) => message.type === 'run-summary' && message.status === 'done');
      const from = stream.frames.length;
      // The TUI types the very same text: the echo is a different native message, so it has no app key.
      fake.serve.appendTurn(session.id, 'same words', 'terminal answer');
      const echo = await stream.waitForFrame((frame) => frame.kind === 'message' && frame.message.type === 'user-message'
        && frame.message.text === 'same words', { after: from, what: 'the terminal-typed echo' });
      expect(echo.message.clientKey).toBeUndefined();
      const own = stream.messages().filter((message) => message.type === 'user-message' && message.clientKey === 'stamp-1');
      expect(own.length).toBe(1);
      expect(own[0]!.key).not.toBe(echo.message.key);
      // A reattach keeps the app's stamp on the app's row only.
      const fresh = await context.client.attach('opencode', session.id);
      const history = (await fresh.waitForKind('history')).messages as any[];
      expect(history.filter((message) => message.type === 'user-message' && message.text === 'same words')
        .map((message) => message.clientKey ?? null)).toEqual(['stamp-1', null]);
      fresh.close();
      stream.close();
    },
  },
  {
    title: 'a streamed answer lands under its part id once, live and in history, and identical answers stay two rows',
    async run(context) {
      const fake = fakeOf(context);
      const session = await context.drivableSession('identity');
      const stream = await context.openDrive(session);
      const from = stream.frames.length;
      const turn = (suffix: string) => [
        { id: `prt_think_${suffix}`, type: 'reasoning' as const, deltas: ['think ', 'hard'] },
        { id: `prt_text_${suffix}`, type: 'text' as const, deltas: ['hello ', 'world'] },
      ];
      fake.serve.streamTurn(session.id, 'first question', turn('one'));
      const finished = () => new Set(stream.frames.slice(from).filter((frame) => frame.kind === 'message' && frame.message.type === 'run-summary'
        && frame.message.status === 'done').map((frame) => frame.message.key)).size;
      await eventually(() => finished() === 1, { what: 'the first streamed turn to finish' });
      fake.serve.streamTurn(session.id, 'second question', turn('two'));
      await eventually(() => finished() === 2, { what: 'the second streamed turn to finish' });
      // Live: the deltas carry their own part id, reasoning apart from the answer, and the closing snapshot adds nothing.
      const live = liveRows(stream, from);
      expect(live.get('model-output:prt_text_one')).toBe('hello world');
      expect(live.get('model-output:prt_text_two')).toBe('hello world');
      expect(live.get('thinking:prt_think_one')).toBe('think hard');
      expect([...live.keys()].filter((key) => key.startsWith('model-output:'))).toEqual(['model-output:prt_text_one', 'model-output:prt_text_two']);
      // History agrees: one identity per message, never the text, so the identical answers are two rows.
      const fresh = await context.client.attach('opencode', session.id);
      const history = (await fresh.waitForKind('history')).messages as any[];
      expect(history.filter((message) => message.type === 'model-output' && String(message.key).startsWith('prt_text_')).map((message) => [message.key, message.text]))
        .toEqual([['prt_text_one', 'hello world'], ['prt_text_two', 'hello world']]);
      for (const key of ['model-output:prt_text_one', 'model-output:prt_text_two']) expect(live.has(key)).toBe(true);
      // Neither surface anchors an answer or reasoning row to a turn: the row's identity must not change on reload.
      const answers = [...stream.frames.slice(from).filter((frame) => frame.kind === 'message').map((frame) => frame.message), ...history]
        .filter((message) => message.type === 'model-output' || message.type === 'thinking');
      expect(answers.length).toBeGreaterThan(0);
      expect(answers.every((message) => message.turnId === undefined)).toBe(true);
      fresh.close();
      stream.close();
    },
  },
  {
    title: 'a tool\'s diff reaches the client as per-file changes, the same live as from history',
    async run(context) {
      const fake = fakeOf(context);
      const cwd = fake.workspace('diffs');
      const id = `ses_diff${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
      const single = ['--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1,2 +1,3 @@', ' context', '+added one', '+added two', '-removed'].join('\n');
      const multi = [
        'diff --git a/lib/a.ts b/lib/a.ts', '--- a/lib/a.ts', '+++ b/lib/a.ts', '@@ -1,2 +1,2 @@', '-old a', '+new a', ' keep',
        'diff --git a/lib/b.ts b/lib/b.ts', 'new file mode 100644', '--- /dev/null', '+++ b/lib/b.ts', '@@ -0,0 +1,2 @@', '+b one', '+b two',
      ].join('\n');
      const bare = ['@@ -1,1 +1,1 @@', '-x', '+y'].join('\n');
      const tool = (partId: string, tool: string, callID: string, state: Record<string, unknown>) =>
        ({ id: partId, type: 'tool', tool, callID, state: { status: 'completed', ...state } });
      const session = fake.serve.seed({ id, directory: cwd, title: 'diffs', turns: 0 });
      session.rows.push(
        openCodeRows.user('msg_d_u', 1000, 'edit the files'),
        openCodeRows.assistant('msg_d_a', 'msg_d_u', 2000, [
          tool('prt_edit', 'edit', 'call-edit', { input: { filePath: 'src/app.ts' }, output: 'ok', metadata: { diff: single, filediff: { file: 'src/app.ts', additions: 2, deletions: 1 } } }),
          tool('prt_patch', 'patch', 'call-patch', { input: {}, output: 'applied', metadata: { diff: multi } }),
          tool('prt_write', 'write', 'call-write', { input: {}, output: 'ok', metadata: { filediff: { file: 'src/only.ts', patch: bare, additions: 1, deletions: 1 } } }),
          tool('prt_bash', 'bash', 'call-bash', { input: { command: 'ls' }, output: 'listing', metadata: { exit: 0, output: 'listing' } }),
        ], 2001),
      );
      await context.client.waitForSession((row) => row.id === id);
      const stream = await context.openDrive({ id, cwd, reason: 'takeover' });
      const history = stream.ofKind('history').at(-1)!.messages as any[];
      const result = (callId: string) => history.find((message) => message.type === 'tool-result' && message.callId === callId);
      const changes = (message: any) => message.fileChanges.map((change: any) => [change.path, change.operation, change.additions, change.deletions]);
      expect(changes(result('call-edit'))).toEqual([['src/app.ts', 'edit', 2, 1]]);
      expect(result('call-edit')).toMatchObject({ path: 'src/app.ts', diff: single, additions: 2, deletions: 1 });
      // A multi-file diff is split per file, each with its own body.
      expect(changes(result('call-patch'))).toEqual([['lib/a.ts', 'edit', 1, 1], ['lib/b.ts', 'create', 2, 0]]);
      const [first, second] = result('call-patch').fileChanges;
      expect(first.diff).toContain('+new a');
      expect(first.diff).not.toContain('+b one');
      expect(second.diff).toContain('+b one');
      // A headerless hunk takes the part's own path.
      expect(changes(result('call-write'))).toEqual([['src/only.ts', 'edit', 1, 1]]);
      expect(result('call-write')).toMatchObject({ path: 'src/only.ts', diff: bare });
      // No diff, no invented changes.
      expect(result('call-bash').fileChanges).toBeUndefined();
      expect(result('call-bash').diff).toBeUndefined();
      // The same tool part arriving on the event bus maps the same way.
      const from = stream.frames.length;
      fake.serve.addRow(id, openCodeRows.assistant('msg_d_live', 'msg_d_u', 3000, [
        tool('prt_live', 'edit', 'call-live', { input: { filePath: 'src/app.ts' }, output: 'ok', metadata: { diff: single, filediff: { file: 'src/app.ts', additions: 2, deletions: 1 } } }),
      ], 3001));
      const live = await stream.waitForFrame((frame) => frame.kind === 'message' && frame.message.type === 'tool-result' && frame.message.callId === 'call-live', { after: from, what: 'the live tool result' });
      expect(changes(live.message)).toEqual([['src/app.ts', 'edit', 2, 1]]);
      stream.close();
    },
  },
  {
    title: 'two sessions running at once stay separate',
    async run(context) {
      const fake = fakeOf(context);
      const [one, two] = [await context.drivableSession('first'), await context.drivableSession('second')];
      const first = await context.openDrive(one);
      const second = await context.openDrive(two);
      const firstFrom = first.frames.length;
      const turnOne = context.prompt(first, '[[hold:sep-one]] only in one');
      const turnTwo = context.prompt(second, '[[hold:sep-two]] only in two');
      await eventually(() => fake.serve.session(one.id).busy && fake.serve.session(two.id).busy, { what: 'both turns to run' });
      fake.release('sep-two');
      await second.waitForMessage((message) => message.type === 'model-output' && textOf(message) === 'answer: only in two');
      await second.waitForMessage((message) => message.type === 'run-summary' && message.status === 'done');
      // The other session is still running: it has seen nothing of the first's answer, and no run of its own ended.
      const live = (stream: SessionStream, from: number) => stream.frames.slice(from).filter((frame) => frame.kind === 'message').map((frame) => frame.message);
      expect(live(first, firstFrom).some((message) => textOf(message)?.includes('only in two'))).toBe(false);
      expect(live(first, firstFrom).some((message) => message.type === 'run-summary' && message.status !== 'running')).toBe(false);
      fake.release('sep-one');
      await first.waitForMessage((message) => message.type === 'model-output' && textOf(message) === 'answer: only in one');
      expect(second.messages().some((message) => textOf(message)?.includes('only in one'))).toBe(false);
      expect((await turnOne).kind).toBe('ack');
      expect((await turnTwo).kind).toBe('ack');
      first.close();
      second.close();
    },
  },
  {
    title: 'a session already working when the broker starts reads working, then idle when the serve says so',
    async run(context) {
      const fake = fakeOf(context);
      const seeded = fake.seedSession({ title: 'working at start' });
      await context.client.waitForSession((row) => row.id === seeded.id);
      fake.serve.setBusy(seeded.id, true);
      // A fresh broker has seen no status event for it: the point-in-time status map seeds Working.
      await context.restart();
      await context.client.waitForSession((row) => row.id === seeded.id && row.status === 'working');
      fake.serve.setBusy(seeded.id, false);
      await context.client.waitForSession((row) => row.id === seeded.id && row.status === 'idle');
    },
  },
  {
    title: 'switching the agent mode POSTs it without starting a turn, and an unknown agent is refused',
    async run(context) {
      const fake = fakeOf(context);
      const session = await context.drivableSession('agent');
      const stream = await context.openDrive(session);
      const options = stream.ofKind('options').at(-1)!;
      expect((options.agents as any[]).map((agent) => agent.name)).toEqual(['build', 'plan']);
      const mark = fake.ledger.mark();
      expect((await stream.sendAndAwait({ kind: 'set-agent', agent: 'plan' })).kind).toBe('ack');
      expect(fake.ledger.routed('POST', new RegExp(`^/api/session/${session.id}/agent$`), mark).map((entry) => entry.body)).toEqual([{ agent: 'plan' }]);
      await stream.waitForFrame((frame) => frame.kind === 'session' && frame.info?.currentAgent === 'plan', { after: 0, what: 'the session to report the plan agent' });
      expect((await stream.sendAndAwait({ kind: 'set-agent', agent: 'not-an-agent' })).kind).toBe('nack');
      expect(fake.ledger.routed('POST', /\/agent$/, mark).length).toBe(1);
      // No turn started.
      expect(fake.ledger.requests('session/prompt', mark)).toEqual([]);
      stream.close();
    },
  },
  {
    title: 'the model picker keeps the session\'s own model even when the catalog omits it',
    async run(context) {
      const fake = fakeOf(context);
      const cwd = fake.workspace('custom-model');
      const id = `ses_custom${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
      fake.serve.seed({ id, directory: cwd, title: 'custom model', turns: 1, model: { providerID: OPENCODE_PROVIDER, modelID: 'model-custom' } });
      await context.client.waitForSession((row) => row.id === id);
      const stream = await context.openDrive({ id, cwd, reason: 'takeover' });
      const models = (stream.ofKind('options').at(-1)!.models as any[]).map((model) => `${model.providerID}/${model.modelID}`);
      expect(models).toContain(`${OPENCODE_PROVIDER}/model-custom`);
      for (const catalogued of opencodeProfile.catalog.models) expect(models).toContain(catalogued);
      expect(new Set(models).size).toBe(models.length);
      stream.close();
    },
  },
  {
    title: 'a same-host `opencode attach` process lights the synced badge, and nothing else does',
    async run(context) {
      if (process.platform !== 'linux') return;
      const fake = fakeOf(context);
      const [watched, other, decoyPort, decoyHost, bare] = [
        fake.seedSession({ title: 'tui watched' }), fake.seedSession({ title: 'tui second' }),
        fake.seedSession({ title: 'tui decoy port' }), fake.seedSession({ title: 'tui decoy host' }), fake.seedSession({ title: 'tui decoy bare' }),
      ];
      for (const session of [watched, other, decoyPort, decoyHost, bare]) await context.client.waitForSession((row) => row.id === session.id);
      const terminals: Bun.Subprocess[] = [];
      const start = (...argv: string[]): void => {
        terminals.push(Bun.spawn([fake.cliPath, 'attach', ...argv], { cwd: watched.cwd, env: { PATH: fixturePath(fake.paths.bin) }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }));
      };
      const synced = (row: any) => row.control?.terminalSync?.active === true;
      try {
        // Decoys first: another port, a non-loopback host, and an attach with no session id.
        start(`http://127.0.0.1:${fake.serve.port + 1}`, '-s', decoyPort.id);
        start(`http://192.0.2.1:${fake.serve.port}`, '-s', decoyHost.id);
        start(fake.serve.url);
        start(fake.serve.url, '-s', watched.id);
        start(fake.serve.url, '--session', other.id);
        const rows = await eventually(async () => {
          const all = await context.client.sessions({ refresh: true });
          const byId = new Map(all.map((row: any) => [row.id, row]));
          return synced(byId.get(watched.id)) && synced(byId.get(other.id)) ? byId : undefined;
        }, { what: 'both attached terminals to show as synced' });
        // The scan that lit these also saw the decoys.
        for (const session of [decoyPort, decoyHost, bare]) expect(synced(rows.get(session.id)), session.title).toBe(false);
        expect(rows.get(watched.id).control.terminalSync).toMatchObject({ active: true, presence: 'shared' });
        // The terminal quits: the badge goes out.
        terminals[3]!.kill('SIGKILL');
        await eventually(async () => {
          const all = await context.client.sessions({ refresh: true });
          return !synced(all.find((row: any) => row.id === watched.id)) ? true : undefined;
        }, { what: 'the badge to clear after the terminal quit' });
      } finally {
        for (const terminal of terminals) terminal.kill('SIGKILL');
        await Promise.all(terminals.map((terminal) => terminal.exited.catch(() => undefined)));
      }
    },
  },
];
