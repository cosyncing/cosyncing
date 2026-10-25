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
import { PROMPT_ATTACHMENT_LIMITS } from '../../../packages/typescript/protocol/src/index.ts';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { eventually, fixturePath, type FixturePaths, type SessionStream } from '../../harness/index.ts';
import { openCodeRows } from '../../harness/fakes/opencode-server.ts';
import { FakeOpenCodeServe } from './fakes/opencode-serve.ts';
import { FakeOpenCodeV2Serve } from './fakes/opencode-v2-serve.ts';
import { chmodSync, readFileSync, rmSync } from 'node:fs';
import { OpencodeStore, type FakeOpencodeCliConfig } from './fakes/opencode-cli.ts';
import { Database } from 'bun:sqlite';
import { runCli } from '../../harness/cli.ts';
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
    { name: 'a session id that climbs out of the session route', plant: (fake) => plantOpencodeId(fake, '../../etc/passwd') },
    { name: 'a session id that is a dot-dot segment', plant: (fake) => plantOpencodeId(fake, '..') },
    { name: 'a session id that climbs out once percent-decoded', plant: (fake) => plantOpencodeId(fake, '%2e%2e%2f%2e%2e%2fetc%2fpasswd') },
    { name: 'a session id that is an absolute path', plant: (fake) => plantOpencodeId(fake, '/etc/passwd') },
    { name: 'a session id that reads as a command-line option', plant: (fake) => plantOpencodeId(fake, '--help') },
  ],
};

/** A session the serve lists under a hostile id: it must stay unpublished, and nothing may reach the serve for it. */
function plantOpencodeId(fake: FakeController, id: string): string {
  const directory = fake.workspace('hostile');
  (fake as OpencodeFake).serve.plantRaw(directory, { id, title: 'hostile id', directory, time: { created: 1, updated: 2 } });
  return id;
}

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

export interface OpencodeV2Fake extends FakeController {
  readonly ledger: OpencodeLedger;
  readonly serve: FakeOpenCodeV2Serve;
  readonly cli: InstalledFake;
  readonly paths: FixturePaths;
  readonly registrationPath: string;
  readonly legacyStore: OpencodeStore;
}

class OpencodeV2Ledger extends OpencodeLedger {
  override requests(method: string, from = 0): LedgerEntry[] {
    const entries = this.since(from);
    return entries.flatMap((entry): LedgerEntry[] => {
      if (entry.kind !== 'request' || entry.method !== 'POST') return [];
      const match = /^\/api\/session\/([^/]+)(.*)$/.exec(String(entry.path));
      const native = entry.path === '/api/session' ? 'session/new' : ['/prompt', '/command'].includes(match?.[2] ?? '') ? 'session/prompt' : match?.[2] === '/interrupt' ? 'session/cancel' : undefined;
      if (native !== method) return [];
      const body = entry.body as Record<string, any> | undefined;
      const model = entries.findLast((item) => item.kind === 'prompt-model' && item.sessionId === match?.[1])?.model;
      const text = match?.[2] === '/command' ? `/${body?.name}${body?.text ? ` ${body.text}` : ''}` : body?.text;
      return [{ ...entry, kind: 'recv', frame: { method, params: { sessionId: match?.[1], cwd: body?.location?.directory, prompt: native === 'session/prompt' ? [{ text }] : undefined, model }, native: body } }];
    });
  }

  override replies(prefix: string, from = 0): LedgerEntry[] {
    return this.since(from).filter((entry) => entry.kind === 'permission-reply' && (prefix === 'permission-' ? String(entry.id).startsWith('per_') : String(entry.id).startsWith(prefix)))
      .map((entry) => ({ ...entry, kind: 'recv', frame: { id: entry.id, result: { outcome: entry.reply } } }));
  }
}

export const opencodeV2Kit: ConformanceKit = {
  profile: {
    ...opencodeProfile,
    displayName: 'OpenCode',
    version: {
      ...opencodeProfile.version, current: '2.1.4', below: '2.1.3', newer: '2.2.0',
      doctor: {
        current: { check: 'version', status: 'pass', detailCode: 'version-supported' },
        below: { check: 'version', status: 'warn', detailCode: 'version-below-minimum' },
        newer: { check: 'version', status: 'pass', detailCode: 'version-supported' },
        missing: { check: 'binary', status: 'warn', detailCode: 'binary-missing' },
      },
    },
    catalog: { ...opencodeProfile.catalog, commands: ['review', 'stop', 'compact', 'undo', 'redo'], unknownCommandsForwarded: false },
    terminal: { resumeHint: null, syncAvailable: false, handoff: false },
    readOnlyAttach: { params: { readOnly: true }, attachMode: 'observe' },
    subagents: true,
    scenarios: {
      ...opencodeProfile.scenarios,
      C16: { skip: 'The service version controls availability independently of CLI banners; the service-floor profile scenario covers this boundary.' },
      C17: { skip: 'A running V2 service works without a local CLI; the service lifecycle profile scenario covers this boundary.' },
      C22: { skip: 'Concurrent CLI variants cannot change one shared service version; the V2 doctor profile scenarios change the service itself.' },
    },
    hostileStore: opencodeProfile.hostileStore,
  },
  env(paths) {
    return { OPENCODE_URL: `http://127.0.0.1:${leasedPort(paths)}`, XDG_STATE_HOME: join(paths.root, 'xdg-state'), OPENCODE_DATA: join(paths.root, 'opencode-data'), COSYNCING_OPENCODE_NO_AUTOSERVE: '1', COSYNCING_OPENCODE_SSE_RECONNECT_MS: '50', COSYNCING_TEST_HUB_EVICT_GRACE_MS: '50' };
  },
  install(paths): OpencodeV2Fake {
    const root = join(paths.root, 'fakes', 'opencode-v2');
    const controlDir = join(root, 'control');
    mkdirSync(controlDir, { recursive: true });
    const ledger = new OpencodeV2Ledger(join(root, 'ledger.jsonl'));
    const registrationPath = join(paths.root, 'xdg-state', 'opencode', 'service.json');
    const legacyStore = new OpencodeStore(join(paths.root, 'opencode-data'), 'sqlite');
    const database = new Database(join(paths.root, 'opencode-data', 'opencode.db'));
    database.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY)');
    database.close();
    mkdirSync(join(paths.root, 'xdg-state', 'opencode'), { recursive: true });
    const serve = new FakeOpenCodeV2Serve({
      record: (entry) => appendFileSync(ledger.path, JSON.stringify({ at: Date.now(), pid: process.pid, ...entry }) + '\n'),
      onRegistration: (value) => {
        if (!value) { rmSync(registrationPath, { force: true }); return; }
        writeFileSync(registrationPath, JSON.stringify(value), { mode: 0o600 });
        chmodSync(registrationPath, 0o600);
      },
    });
    serve.start(0); leases.set(paths.root, serve.port);
    const cli = installFakeExecutable(paths.bin, 'opencode', 'opencode-cli.ts', { ledger: ledger.path, controlDir, version: '2.1.4' } satisfies FakeOpencodeCliConfig);
    let workspaces = 0, seeded = 0;
    const controller: OpencodeV2Fake = {
      ledger, serve, cli, paths, registrationPath, legacyStore, storeRoot: join(paths.root, 'opencode-data'),
      workspace(name = 'workspace') { const path = join(paths.root, 'workspaces', `${name}-${++workspaces}`); mkdirSync(path, { recursive: true }); return path; },
      seedSession(options = {}) {
        const id = `ses_seedv2${++seeded}${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
        const cwd = options.childOf?.cwd ?? controller.workspace('seed');
        const title = options.title ?? `OpenCode V2 seeded ${seeded}`;
        serve.seed({ id, directory: cwd, title, turns: options.turns ?? 1, ...(options.childOf ? { parentID: options.childOf.id } : {}) });
        const texts: string[] = [];
        for (let i = 1; i <= (options.turns ?? 1); i++) texts.push(`seeded prompt ${i}`, `seeded answer ${i}`);
        return { id, cwd, title, texts };
      },
      prepareCreate: (id) => serve.prepareCreate(id),
      appendTurn: (session, user, answer) => serve.appendTurn(session.id, user, answer),
      appendForeignUser: (session, text) => serve.appendTurn(session.id, text, 'terminal answer'),
      appendPartial: (session) => { serve.appendPartial(session.id); },
      completePartial: (session) => serve.completePartial(session.id),
      rewriteHistory: (session) => serve.rewriteFirstUserText(session.id, 'rewritten first prompt'),
      replaceLog: (session) => serve.rewriteFirstUserText(session.id, 'rewritten first prompt'),
      watcherNoise: (session) => serve.noise(session.id),
      setVersion(version, output) { cli.writeConfig({ ...cli.readConfig<FakeOpencodeCliConfig>(), version, versionOutput: output }); serve.setVersion(version); },
      setInstalled(installed) { cli.setInstalled(installed); },
      release: (tag) => serve.release(tag),
      configure: () => ({}),
      doctorEnvironment: () => ({ OPENCODE_URL: serve.url }),
      storeSnapshot() { return new Map([...serve.sessions].map(([id, session]) => [`sessions/${id}.json`, JSON.stringify({ info: session.info, rows: session.messages })])); },
      promptSettled(_stream, text) { const mark = ledger.mark(); return () => eventually(() => ledger.since(mark).some((entry) => (entry.kind === 'turn-end' || entry.kind === 'turn-aborted') && entry.text === text), { what: 'the V2 input to settle' }).then(() => {}); },
      async cleanup() { serve.releaseAll(); serve.stop(); legacyStore.close(); },
    };
    return controller;
  },
  extras: [
    {
      title: 'caller-generated create identity and V2 source history keep cwd and lineage',
      async run(context) {
        const fake = context.fake as OpencodeV2Fake;
        const cwd = fake.workspace('create');
        fake.serve.ambiguousNext('/api/session');
        const mark = fake.ledger.mark();
        const response = await context.client.post('/api/sessions/opencode', { directory: cwd, title: 'V2 created', model: { providerID: OPENCODE_PROVIDER, modelID: 'model-b' } });
        expect(response.status, response.text).toBe(200);
        const id = response.body.session.id;
        expect(fake.ledger.routed('POST', /^\/api\/session$/, mark)).toHaveLength(1);
        expect(fake.ledger.routed('GET', new RegExp(`^/api/session/${id}$`), mark).length).toBeGreaterThan(0);
        expect(id).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
        expect(fake.serve.session(id).info.location.directory).toBe(cwd);
        const request = fake.ledger.routed('POST', /^\/api\/session$/).at(-1)!;
        expect(request.body).toMatchObject({ id, location: { directory: cwd }, model: { providerID: OPENCODE_PROVIDER, id: 'model-b' } });
        const stream = await context.client.attach('opencode', id);
        await stream.waitForKind('history');
        expect((await stream.waitForKind('session')).info.cwd).toBe(cwd);
        stream.close();
      },
    },
    {
      title: 'pending input in another location survives stream overflow and resolves externally',
      async run(context) {
        const fake = context.fake as OpencodeV2Fake;
        const session = await context.drivableSession('pending question');
        const stream = await context.openDrive(session);
        const turn = context.prompt(stream, '[[question]] choose one');
        const card = await stream.waitForMessage((message) => message.type === 'question-request');
        const mark = fake.ledger.mark();
        const from = stream.frames.length;
        fake.serve.emit('fixture.oversized', { sessionID: session.id, padding: 'x'.repeat(PROMPT_ATTACHMENT_LIMITS.maxFiles * PROMPT_ATTACHMENT_LIMITS.maxInlineEncodedBytes * 2) });
        await stream.waitForFrame((frame) => frame.kind === 'history' && frame.reset === true, { after: from });
        await eventually(() => fake.ledger.routed('GET', new RegExp(`^/api/session/${session.id}/form$`), mark).length > 0, { what: 'session-scoped pending state after the gap' });
        await context.client.waitForSession((row) => row.id === session.id && row.status === 'needs-input');
        fake.serve.pending.get(card.requestId)!.settle({ q0: 'Proceed' });
        await stream.waitForMessage((message) => message.type === 'question-resolved' && message.requestId === card.requestId);
        expect((await turn).kind).toBe('ack');
        expect((await stream.sendAndAwait({ kind: 'answer', requestId: card.requestId, answers: [['Proceed']] })).kind).toBe('nack');
        stream.close();
      },
    },
    {
      title: 'service identity change reloads history and refuses a resolved permission',
      async run(context) {
        const fake = context.fake as OpencodeV2Fake;
        const session = await context.drivableSession('restart');
        const stream = await context.openDrive(session);
        const turn = context.prompt(stream, '[[permission]] externally resolved permission');
        const permission = await stream.waitForMessage((message) => message.type === 'permission-request');
        fake.serve.pending.get(permission.requestId)!.settle('once');
        expect((await turn).kind).toBe('ack');
        const from = stream.frames.length;
        fake.serve.restartIdentity();
        await stream.waitForFrame((frame) => frame.kind === 'history' && frame.reset === true, { after: from });
        const mark = fake.ledger.mark();
        expect((await stream.sendAndAwait({ kind: 'approve', requestId: permission.requestId, decision: 'approve' })).kind).toBe('nack');
        expect(fake.ledger.routed('POST', /\/permission\/[^/]+\/reply$/, mark)).toHaveLength(0);
        expect((await context.prompt(stream, 'after replacement')).kind).toBe('ack');
        await stream.waitForMessage((message) => message.type === 'model-output' && message.text === 'answer: after replacement');
        stream.close();
      },
    },
    {
      title: 'accepted prompt with an ambiguous response is reread without another POST',
      async run(context) {
        const fake = context.fake as OpencodeV2Fake;
        const session = await context.drivableSession('ambiguous');
        const stream = await context.openDrive(session);
        const path = `/api/session/${session.id}/prompt`;
        fake.serve.ambiguousNext(path);
        const mark = fake.ledger.mark();
        expect((await context.prompt(stream, 'ambiguous input')).kind).toBe('ack');
        expect(fake.ledger.routed('POST', new RegExp(`^${path}$`), mark)).toHaveLength(1);
        expect(fake.ledger.routed('GET', new RegExp(`^/api/session/${session.id}/inbox$`), mark)).toHaveLength(1);
        expect(fake.ledger.routed('GET', new RegExp(`^/api/session/${session.id}/message/msg_`), mark)).toHaveLength(1);
        stream.close();
      },
    },
    {
      title: 'stop is offered and crafted unsupported commands are refused',
      async run(context) {
        const session = await context.drivableSession('controls');
        const stream = await context.openDrive(session);
        expect((await stream.sendAndAwait({ kind: 'command', name: 'stop' })).kind).toBe('ack');
        expect((await stream.sendAndAwait({ kind: 'command', name: 'not-a-command' })).kind).toBe('nack');
        stream.close();
      },
    },
    {
      title: 'the shared service stays usable without a CLI and only the server version gates create',
      async run(context) {
        const fake = context.fake as OpencodeV2Fake;
        fake.cli.setInstalled(false);
        try {
          expect((await context.client.post('/api/sessions/opencode', { directory: fake.workspace('no-cli') })).status).toBe(200);
        } finally { fake.cli.setInstalled(true); }
        for (const [version, expected] of [['2.1.3', 503], ['2.2.0', 200]] as const) {
          fake.serve.setVersion(version);
          const response = await context.client.post('/api/sessions/opencode', { directory: fake.workspace('version') });
          expect(response.status, response.text).toBe(expected);
        }
        fake.serve.setVersion('2.1.4');
      },
    },
  ],
};

async function v2Doctor(context: ConformanceContext, overrides: Record<string, string> = {}): Promise<{ checks: any[]; raw: string }> {
  const result = await runCli(['doctor', '--json'], { env: { ...context.broker.env, ...overrides }, timeoutMs: 60_000 });
  expect(result.timedOut).toBe(false);
  const report = JSON.parse(result.stdout);
  return { checks: (report.sections ?? []).flatMap((section: any) => section.checks ?? []).filter((check: any) => check.id.startsWith('opencode.')), raw: result.output };
}

opencodeV2Kit.extras!.push(
  {
    title: 'registration binds the broker without an explicit URL or a local CLI',
    async run(context) {
      const fake = context.fake as OpencodeV2Fake;
      const explicit = context.broker.env.OPENCODE_URL;
      try {
        fake.cli.setInstalled(false);
        await context.restart({ env: { OPENCODE_URL: undefined } });
        const response = await context.client.post('/api/sessions/opencode', { directory: fake.workspace('registration') });
        expect(response.status, response.text).toBe(200);
        expect((await context.client.sessions({ refresh: true })).some((row: any) => row.id === response.body.session.id)).toBe(true);
        const original = readFileSync(fake.registrationPath, 'utf8');
        for (const invalid of [{ ...JSON.parse(original), url: `http://0.0.0.0:${fake.serve.port}` }, { ...JSON.parse(original), pid: process.pid + 1 }]) {
          writeFileSync(fake.registrationPath, JSON.stringify(invalid));
          const mark = fake.ledger.mark();
          const refused = await context.client.post('/api/sessions/opencode', { directory: fake.workspace('invalid-registration') });
          expect(refused.status).toBe(503);
          expect(fake.ledger.since(mark).filter((entry) => entry.kind === 'request' && entry.method === 'POST')).toHaveLength(0);
        }
        fake.serve.publishRegistration();
      } finally { fake.serve.publishRegistration(); fake.cli.setInstalled(true); await context.restart({ env: { OPENCODE_URL: explicit } }); }
    },
  },
  {
    title: 'registration discovery validates identity and rejects non-loopback, unsafe and stale records',
    async run(context) {
      const fake = context.fake as OpencodeV2Fake;
      const original = readFileSync(fake.registrationPath, 'utf8');
      try {
        const good = await v2Doctor(context, { OPENCODE_URL: '' });
        expect(good.checks.find((check) => check.id === 'opencode.server')?.detailCode).toBe('server-reachable');
        for (const patch of [{ url: `http://0.0.0.0:${fake.serve.port}` }, { pid: process.pid + 100000 }]) {
          writeFileSync(fake.registrationPath, JSON.stringify({ ...JSON.parse(original), ...patch }));
          const report = await v2Doctor(context, { OPENCODE_URL: '' });
          expect(report.checks.find((check) => check.id === 'opencode.server')?.detailCode).toBe('registration-invalid');
        }
        writeFileSync(fake.registrationPath, original);
        if (process.platform !== 'win32') {
          chmodSync(fake.registrationPath, 0o666);
          const report = await v2Doctor(context, { OPENCODE_URL: '' });
          expect(report.checks.find((check) => check.id === 'opencode.server')?.detailCode).toBe('registration-invalid');
        }
      } finally { writeFileSync(fake.registrationPath, original); chmodSync(fake.registrationPath, 0o600); }
    },
  },
  {
    title: 'an explicit URL never uses another origin credential or follows a redirect',
    async run(context) {
      const fake = context.fake as OpencodeV2Fake;
      const requests: { path: string; authorization: boolean }[] = [];
      const decoy = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
        requests.push({ path: new URL(request.url).pathname, authorization: request.headers.has('authorization') });
        return Response.json({ _tag: 'UnauthorizedError' }, { status: 401 });
      } });
      try {
        const url = `http://127.0.0.1:${decoy.port}`;
        const mark = fake.ledger.mark();
        const report = await v2Doctor(context, { OPENCODE_URL: url });
        expect(report.checks.find((check) => check.id === 'opencode.server')?.detailCode).toBe('credential-required');
        expect(requests.length).toBeGreaterThan(0);
        expect(requests.every((request) => request.path === '/api/info' && !request.authorization)).toBe(true);
        expect(fake.ledger.since(mark).filter((entry) => entry.kind === 'request' && entry.method === 'POST')).toHaveLength(0);
        requests.length = 0;
        fake.serve.redirectNext('/api/info', url + '/redirected');
        await context.restart();
        const refused = await context.client.post('/api/sessions/opencode', { directory: fake.workspace('redirect') });
        expect(refused.status).toBe(503);
        expect(requests).toHaveLength(0);
      } finally { decoy.stop(true); fake.serve.publishRegistration(); await context.restart(); }
    },
  },
  {
    title: 'doctor checks the service floor and rejected credentials without managed-server remediation',
    async run(context) {
      const fake = context.fake as OpencodeV2Fake;
      const credential = fake.serve.registration().password;
      try {
        for (const [version, expected, status] of [['2.1.4', 'version-supported', 'pass'], ['2.1.3', 'version-below-minimum', 'warn'], ['2.2.0', 'version-supported', 'pass']] as const) {
          fake.serve.setVersion(version);
          const report = await v2Doctor(context);
          expect(report.checks.find((check) => check.id === 'opencode.version')).toMatchObject({ detailCode: expected, status });
          expect(report.checks.find((check) => check.id === 'opencode.managed-serve-eligibility')).toMatchObject({ status: 'skip', detailCode: 'external-v2-service' });
          expect(report.raw).not.toContain(credential);
        }
        fake.serve.setVersion('2.1.4');
        fake.serve.failNext('GET', '/api/info', 401, 100);
        const mark = fake.ledger.mark();
        const rejected = await v2Doctor(context);
        expect(rejected.checks.find((check) => check.id === 'opencode.server')?.detailCode).toBe('credential-rejected');
        expect(fake.ledger.paths(mark).some((path) => path.includes('/global/health') || path === 'GET /session')).toBe(false);
        expect(rejected.checks.find((check) => check.id === 'opencode.server')?.remediation).toBeUndefined();
      } finally { fake.serve.failNext('GET', '/api/info', 401, 0); fake.serve.setVersion('2.1.4'); await context.restart(); }
    },
  },
  {
    title: 'startup and failed roster reads preserve existing rows until a successful sweep',
    async run(context) {
      const fake = context.fake as OpencodeV2Fake;
      const session = fake.seedSession({ title: 'retained during startup' });
      await context.client.waitForSession((row) => row.id === session.id);
      fake.serve.failNext('GET', '/api/session', 503, 100, { code: 'service_starting' });
      try {
        expect((await context.client.sessions({ refresh: true })).some((row: any) => row.id === session.id)).toBe(true);
      } finally { fake.serve.failNext('GET', '/api/session', 503, 0); }
      fake.serve.failNext('GET', '/api/info', 503, 100, { code: 'service_starting' });
      try {
        const report = await v2Doctor(context);
        expect(report.checks.find((check) => check.id === 'opencode.server')?.detailCode).toBe('v2-service-starting');
      } finally { fake.serve.failNext('GET', '/api/info', 503, 0); await context.restart(); }
    },
  },
  {
    title: 'migration augments missing V1 rows read-only and completion makes the service authoritative',
    async run(context) {
      const fake = context.fake as OpencodeV2Fake;
      const id = 'ses_fixture_imported';
      const omittedId = 'ses_fixture_unimported';
      const cwd = fake.workspace('import');
      const now = Date.now();
      fake.legacyStore.putSession({ id, directory: cwd, title: 'not imported yet', created: now, updated: now, model: { providerID: OPENCODE_PROVIDER, modelID: 'model-b' } });
      fake.legacyStore.putMessage(id, { id: 'msg_fixture_legacy_import', role: 'user', time: { created: now } });
      fake.legacyStore.putPart(id, 'msg_fixture_legacy_import', { id: 'prt_fixture_legacy_import', type: 'text', text: 'legacy history before import' });
      fake.serve.migration = 'running';
      let releaseRoster!: () => void;
      const rosterGate = new Promise<void>((resolve) => { releaseRoster = resolve; });
      try {
        const before = await context.client.waitForSession((row) => row.id === id);
        expect(before.attachMode).toBe('observe');
        expect(before.control.drive.supported).toBe(false);
        expect(before.currentModel).toMatchObject({ providerID: OPENCODE_PROVIDER, modelID: 'model-b' });
        const legacy = await context.client.attach('opencode', id);
        const legacyHistory = await legacy.waitForKind('history');
        expect(legacyHistory.messages.some((message: any) => message.type === 'user-message' && message.text === 'legacy history before import')).toBe(true);
        const from = legacy.frames.length;
        fake.serve.beforeRosterReply = () => rosterGate;
        fake.serve.seed({ id, directory: cwd, title: 'imported', turns: 1, model: { providerID: OPENCODE_PROVIDER, modelID: 'model-b' } });
        fake.serve.emit('session.created', { sessionID: id, location: { directory: cwd }, projectID: 'project-fixture', slug: 'imported', version: '2.1.4', title: 'imported' }, true);
        const importedFrame = await legacy.waitForFrame((frame) => frame.kind === 'session' && frame.authority?.canMutate === true, { after: from });
        expect(importedFrame.info.currentModel).toMatchObject({ providerID: OPENCODE_PROVIDER, modelID: 'model-b' });
        const history = await legacy.waitForFrame((frame) => frame.kind === 'history' && frame.reset === true, { after: from });
        expect(history.messages.some((message: any) => message.type === 'model-output' && message.text === 'seeded answer 1')).toBe(true);
        expect(history.messages.some((message: any) => message.text === 'legacy history before import')).toBe(false);
        expect((await context.prompt(legacy, 'after import')).kind).toBe('ack');
        legacy.close();
        fake.serve.beforeRosterReply = undefined; releaseRoster();
        fake.legacyStore.putSession({ id: omittedId, directory: cwd, title: 'omitted by importer', created: now, updated: now });
        await context.client.waitForSession((row) => row.id === omittedId && row.attachMode === 'observe');
        fake.serve.migration = 'completed';
        const report = await v2Doctor(context);
        expect(report.checks.find((check) => check.id === 'opencode.storage')).toMatchObject({ detailCode: 'v1-sessions-not-imported', evidence: { count: 1 } });
        const rows = await context.client.sessions({ refresh: true });
        expect(rows.some((row: any) => row.id === omittedId)).toBe(false);
        expect(rows.some((row: any) => row.id === id)).toBe(true);
      } finally { fake.serve.beforeRosterReply = undefined; releaseRoster(); fake.serve.migration = 'completed'; }
    },
  },
  {
    title: 'multiple roster pages exclude archived rows and history pages keep stable text keys',
    async run(context) {
      const fake = context.fake as OpencodeV2Fake;
      const cwd = fake.workspace('pages');
      const ids = Array.from({ length: 110 }, (_, i) => `ses_fixture_page_${i}`);
      for (const id of ids) fake.serve.seed({ id, directory: cwd, turns: 0 });
      const archived = 'ses_fixture_archived';
      fake.serve.seed({ id: archived, directory: cwd, turns: 0 }).info.time.archived = Date.now();
      const rows = await context.client.sessions({ refresh: true });
      expect(ids.every((id) => rows.some((row: any) => row.id === id))).toBe(true);
      expect(rows.some((row: any) => row.id === archived)).toBe(false);
      const historyId = 'ses_fixture_history_pages';
      fake.serve.seed({ id: historyId, directory: cwd, turns: 90 });
      await context.client.waitForSession((row) => row.id === historyId);
      const stream = await context.client.attach('opencode', historyId);
      const history = await stream.waitForKind('history');
      expect(history.messages.filter((message: any) => message.type === 'user-message')).toHaveLength(90);
      expect(history.messages.filter((message: any) => message.type === 'model-output')).toHaveLength(90);
      const keys = history.messages.filter((message: any) => message.type === 'model-output').map((message: any) => message.key);
      expect(new Set(keys).size).toBe(90);
      stream.close();
    },
  },
  {
    title: 'unsupported forms stay needs-input and answer in terminal without a guessed reply',
    async run(context) {
      const fake = context.fake as OpencodeV2Fake;
      fake.serve.formFields = [{ key: 'q0', type: 'string', title: 'Code', pattern: '^[A-Z]+$' }];
      const session = await context.drivableSession('terminal-only form');
      const stream = await context.openDrive(session);
      try {
        const turn = context.prompt(stream, '[[question]] enter a code');
        const card = await stream.waitForMessage((message) => message.type === 'question-request');
        expect(card).toMatchObject({ readOnly: true, answerInTerminal: true });
        await context.client.waitForSession((row) => row.id === session.id && row.status === 'needs-input');
        const mark = fake.ledger.mark();
        expect((await stream.sendAndAwait({ kind: 'answer', requestId: card.requestId, answers: [['ABC']] })).kind).toBe('nack');
        expect((await stream.sendAndAwait({ kind: 'reject-question', requestId: card.requestId })).kind).toBe('nack');
        expect(fake.ledger.routed('POST', /\/form\/[^/]+\/reply$/, mark)).toHaveLength(0);
        expect(fake.ledger.routed('DELETE', /\/form\/[^/]+$/, mark)).toHaveLength(0);
        fake.serve.pending.get(card.requestId)!.settle({ q0: 'ABC' });
        expect((await turn).kind).toBe('ack');
      } finally { fake.serve.formFields = undefined; stream.close(); }
    },
  },
  {
    title: 'form fields retain native values and validate typed answers before posting',
    async run(context) {
      const fake = context.fake as OpencodeV2Fake;
      fake.serve.formFields = [
        { key: 'choice', type: 'string', title: 'Choice', required: true, options: [{ value: 'native-value', label: 'Visible choice' }] },
        { key: 'many', type: 'multiselect', title: 'Several', options: [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }] },
        { key: 'number', type: 'integer', title: 'Count', required: true, min: 1, max: 3 },
        { key: 'enabled', type: 'boolean', title: 'Enabled' },
        { key: 'text', type: 'string', title: 'Text', minLength: 2, maxLength: 5 },
        { key: 'hidden', type: 'string', hidden: true, required: true, default: 'default-value' },
      ];
      const session = await context.drivableSession('typed form');
      const stream = await context.openDrive(session);
      try {
        const turn = context.prompt(stream, '[[question]] typed answers');
        const card = await stream.waitForMessage((message) => message.type === 'question-request');
        expect(card.readOnly).not.toBe(true);
        const mark = fake.ledger.mark();
        const answers = [['Visible choice'], ['One', 'Two'], ['9'], ['true'], ['hello']];
        expect((await stream.sendAndAwait({ kind: 'answer', requestId: card.requestId, answers })).kind).toBe('nack');
        expect(fake.ledger.routed('POST', /\/form\/[^/]+\/reply$/, mark)).toHaveLength(0);
        answers[2] = ['2'];
        expect((await stream.sendAndAwait({ kind: 'answer', requestId: card.requestId, answers })).kind).toBe('ack');
        expect(fake.ledger.routed('POST', /\/form\/[^/]+\/reply$/, mark).at(-1)?.body).toEqual({ answer: { choice: 'native-value', many: ['one', 'two'], number: 2, enabled: true, text: 'hello', hidden: 'default-value' } });
        expect((await turn).kind).toBe('ack');
      } finally { fake.serve.formFields = undefined; stream.close(); }
    },
  },
  {
    title: 'agent selection uses native IDs and rejects an unavailable agent',
    async run(context) {
      const fake = context.fake as OpencodeV2Fake;
      const session = await context.drivableSession('agent choice');
      const stream = await context.openDrive(session);
      let releaseRoster!: () => void;
      const rosterGate = new Promise<void>((resolve) => { releaseRoster = resolve; });
      fake.serve.beforeRosterReply = () => rosterGate;
      try {
        expect((await context.prompt(stream, 'plan a change', { agent: 'plan' })).kind).toBe('ack');
        expect(fake.serve.session(session.id).info.agent).toBe('plan');
        await stream.waitForFrame((frame) => frame.kind === 'session' && frame.info.currentAgent === 'plan');
        expect((await context.prompt(stream, 'switch model here', { model: { providerID: OPENCODE_PROVIDER, modelID: 'model-b' } })).kind).toBe('ack');
        await stream.waitForFrame((frame) => frame.kind === 'session' && frame.info.currentModel?.modelID === 'model-b');
        const mark = fake.ledger.mark();
        expect((await stream.sendAndAwait({ kind: 'prompt', text: 'invalid agent', agent: 'unknown-agent' })).kind).toBe('nack');
        expect(fake.ledger.routed('POST', /\/agent$/, mark)).toHaveLength(0);
      } finally { fake.serve.beforeRosterReply = undefined; releaseRoster(); stream.close(); }
    },
  },
  {
    title: 'durable text and tool results replace live slots and unknown events are dropped',
    async run(context) {
      const fake = context.fake as OpencodeV2Fake;
      const session = await context.drivableSession('native blocks');
      const stream = await context.openDrive(session);
      try {
        const from = stream.frames.length;
        const messageId = 'msg_fixture_native_blocks';
        const common = { sessionID: session.id, assistantMessageID: messageId };
        fake.serve.emit('session.reasoning.delta', { ...common, ordinal: 0, delta: 'thinking' });
        fake.serve.emit('session.reasoning.ended', { ...common, ordinal: 0, text: 'finished reasoning' }, true);
        for (let i = 0; i < 100; i++) fake.serve.emit('session.text.delta', { ...common, ordinal: 1, delta: 'partial' });
        fake.serve.emit('session.text.ended', { ...common, ordinal: 1, text: 'complete answer' }, true);
        fake.serve.emit('session.text.delta', { ...common, ordinal: 1, delta: 'stale delta' });
        fake.serve.emit('session.future-event', { sessionID: session.id, text: 'unknown payload' });
        fake.serve.emit('session.tool.input.started', { ...common, id: 'call_fixture_shell', name: 'shell' }, true);
        fake.serve.emit('session.tool.called', { ...common, id: 'call_fixture_shell', input: { command: 'printf fixture' } }, true);
        fake.serve.emit('session.tool.success', { ...common, id: 'call_fixture_shell', content: [{ type: 'text', text: 'fixture' }], metadata: { exit: 0 } }, true);
        await stream.waitForFrame((frame) => frame.kind === 'message' && frame.message.type === 'tool-result' && frame.message.callId === 'call_fixture_shell' && !frame.message.pending, { after: from });
        const messages = stream.frames.slice(from).filter((frame) => frame.kind === 'message').map((frame) => frame.message);
        expect(stream.frames.slice(from).filter((frame) => frame.kind === 'session')).toHaveLength(0);
        expect(messages.some((message) => message.delta === 'stale delta' || message.text === 'unknown payload')).toBe(false);
        expect(messages.find((message) => message.type === 'model-output' && message.text === 'complete answer')?.key).toBe(`${messageId}:1`);
        expect(messages.find((message) => message.type === 'thinking' && message.text === 'finished reasoning')?.key).toBe(`${messageId}:0`);
        expect(messages.find((message) => message.type === 'tool-call')).toMatchObject({ callId: 'call_fixture_shell', args: { command: 'printf fixture' } });
        expect(messages.findLast((message) => message.type === 'tool-result')).toMatchObject({ callId: 'call_fixture_shell', result: 'fixture', exitCode: 0 });
      } finally { stream.close(); }
    },
  },
  {
    title: 'failed executions, form dismissal and saved or rejected permissions use native outcomes',
    async run(context) {
      const fake = context.fake as OpencodeV2Fake;
      const session = await context.drivableSession('outcomes');
      const stream = await context.openDrive(session);
      try {
        const from = stream.frames.length;
        expect((await context.prompt(stream, '[[error]] failed execution')).kind).toBe('ack');
        await stream.waitForFrame((frame) => frame.kind === 'message' && frame.message.type === 'run-summary' && frame.message.status === 'error', { after: from });
        for (const [decision, native] of [['approve-session', 'always'], ['reject', 'reject']] as const) {
          const mark = fake.ledger.mark();
          const turn = context.prompt(stream, `[[permission]] ${decision}`);
          const card = await stream.waitForFrame((frame) => frame.kind === 'message' && frame.message.type === 'permission-request' && fake.serve.pending.has(frame.message.requestId), { after: from });
          expect((await stream.sendAndAwait({ kind: 'approve', requestId: card.message.requestId, decision })).kind).toBe('ack');
          expect((await turn).kind).toBe('ack');
          expect(fake.ledger.routed('POST', /\/permission\/[^/]+\/reply$/, mark).at(-1)?.body).toEqual({ decision: native });
        }
        const turn = context.prompt(stream, '[[question]] dismiss form');
        const card = await stream.waitForMessage((message) => message.type === 'question-request');
        const mark = fake.ledger.mark();
        expect((await stream.sendAndAwait({ kind: 'reject-question', requestId: card.requestId })).kind).toBe('ack');
        expect((await turn).kind).toBe('ack');
        expect(fake.ledger.routed('DELETE', /\/form\/[^/]+$/, mark)).toHaveLength(1);
      } finally { stream.close(); }
    },
  },
);

opencodeV2Kit.extras!.push(
  {
    title: 'externally answered permission reconciles during continuous stream activity after a gap',
    async run(context) {
      const fake = context.fake as OpencodeV2Fake;
      const session = await context.drivableSession('pending repair');
      const stream = await context.openDrive(session);
      let sequence = 0;
      try {
        const turn = context.prompt(stream, '[[permission]] [[hold:pending-repair]] keep streaming');
        const card = await stream.waitForMessage((message) => message.type === 'permission-request');
        fake.serve.beforePendingReply = async (id) => {
          if (id !== session.id) return;
          const agent = `external-${++sequence}`;
          fake.serve.emit('session.text.delta', { sessionID: id, assistantMessageID: 'msg_fixture_repair', ordinal: 0, delta: 'still streaming' });
          fake.serve.emit('session.step.started', { sessionID: id, assistantMessageID: 'msg_fixture_repair', agent, model: { providerID: OPENCODE_PROVIDER, id: 'model-a' } });
          await stream.waitForFrame((frame) => frame.kind === 'session' && frame.info.currentAgent === agent);
        };
        fake.serve.disconnectStreams();
        fake.serve.pending.get(card.requestId)!.settle('once');
        await stream.waitForMessage((message) => message.type === 'permission-resolved' && message.requestId === card.requestId);
        expect(sequence).toBeGreaterThan(0);
        expect(fake.serve.holds.has('pending-repair')).toBe(true);
        expect((await stream.sendAndAwait({ kind: 'approve', requestId: card.requestId, decision: 'approve' })).kind).toBe('nack');
        fake.serve.beforePendingReply = undefined;
        fake.serve.release('pending-repair');
        expect((await turn).kind).toBe('ack');
      } finally { fake.serve.beforePendingReply = undefined; fake.serve.release('pending-repair'); stream.close(); }
    },
  },
  {
    title: 'malformed pending state preserves its card without hiding another session',
    async run(context) {
      const fake = context.fake as OpencodeV2Fake;
      const session = await context.drivableSession('malformed pending');
      const stream = await context.openDrive(session);
      try {
        const turn = context.prompt(stream, '[[permission]] pending validation');
        const card = await stream.waitForMessage((message) => message.type === 'permission-request');
        fake.serve.malformedPendingFor = session.id;
        const other = fake.seedSession({ title: 'unaffected by malformed pending' });
        fake.serve.setBusy(other.id, true);
        const rows = await context.client.sessions({ refresh: true });
        expect(rows.find((row: any) => row.id === session.id)?.status).toBe('needs-input');
        expect(rows.find((row: any) => row.id === other.id)?.status).toBe('working');
        fake.serve.malformedPendingFor = undefined;
        fake.serve.pending.get(card.requestId)!.settle('once');
        fake.serve.setBusy(other.id, false);
        expect((await turn).kind).toBe('ack');
      } finally { fake.serve.malformedPendingFor = undefined; stream.close(); }
    },
  },
  {
    title: 'unprompted execution gets its own summary and outcome reads only the newest history pages',
    async run(context) {
      const fake = context.fake as OpencodeV2Fake;
      const session = fake.seedSession({ title: 'large history outcomes', turns: 700 });
      await context.client.waitForSession((row) => row.id === session.id);
      const stream = await context.openDrive({ ...session, reason: 'takeover' });
      try {
        const mark = fake.ledger.mark();
        const from = stream.frames.length;
        expect((await context.prompt(stream, 'a prompted execution')).kind).toBe('ack');
        const first = await stream.waitForFrame((frame) => frame.kind === 'message' && frame.message.type === 'run-summary' && frame.message.status === 'done', { after: from });
        expect(fake.ledger.routed('GET', new RegExp(`^/api/session/${session.id}/message$`), mark)).toHaveLength(1);
        const next = stream.frames.length;
        fake.serve.unprompted(session.id);
        const second = await stream.waitForFrame((frame) => frame.kind === 'message' && frame.message.type === 'run-summary' && frame.message.status === 'done', { after: next });
        expect(second.message.key).not.toBe(first.message.key);
        expect(second.message.turnId).toStartWith('execution:');
        expect(stream.frames.slice(next).some((frame) => frame.kind === 'message' && frame.message.type === 'run-summary' && frame.message.key === first.message.key)).toBe(false);
        await stream.waitForFrame((frame) => frame.kind === 'session' && frame.info.status === 'idle', { after: next });
      } finally { stream.close(); }
    },
  },
  {
    title: 'stream retries respect the configured window, back off and stop after demand expires',
    async run(context) {
      const fake = context.fake as OpencodeV2Fake;
      const saved = { reconnect: context.broker.env.COSYNCING_OPENCODE_SSE_RECONNECT_MS, idle: context.broker.env.COSYNCING_OPENCODE_SSE_IDLE_MS };
      await context.restart({ env: { COSYNCING_OPENCODE_SSE_RECONNECT_MS: '60000', COSYNCING_OPENCODE_SSE_IDLE_MS: '2000' } });
      try {
        const session = await context.drivableSession('reconnect policy');
        const stream = await context.openDrive(session);
        const from = stream.frames.length;
        fake.serve.stop();
        fake.serve.start();
        fake.serve.restartIdentity();
        await stream.waitForFrame((frame) => frame.kind === 'history' && frame.reset === true, { after: from, timeoutMs: 10000 });
        const eventFrom = stream.frames.length;
        fake.serve.appendTurn(session.id, 'after native restart', 'reattached within the retry window');
        await stream.waitForFrame((frame) => frame.kind === 'message' && frame.message?.text === 'reattached within the retry window', { after: eventFrom, timeoutMs: 10000 });
        stream.close();

        await context.restart({ env: { COSYNCING_OPENCODE_SSE_RECONNECT_MS: '1' } });
        const retrying = await context.openDrive(session);
        const mark = fake.ledger.mark(), retryFrom = retrying.frames.length;
        fake.serve.failNext('GET', '/api/event', 503, 1);
        fake.serve.disconnectStreams();
        await retrying.waitForFrame((frame) => frame.kind === 'history' && frame.reset === true, { after: retryFrom });
        const attempts = fake.ledger.routed('GET', /^\/api\/event$/, mark);
        expect(attempts).toHaveLength(2);
        // After the retry window expires, failures use the two-second backoff base.
        expect(attempts[1]!.at - attempts[0]!.at).toBeGreaterThanOrEqual(2000);
        retrying.close();
        await eventually(() => fake.serve.openStreams === 0, { what: 'the unused shared stream lease to expire' });
        fake.serve.setBusy(session.id, true);
        const reopened = await context.openDrive(session);
        expect((await reopened.waitForKind('session')).info.status).toBe('working');
        fake.serve.setBusy(session.id, false);
        reopened.close();
      } finally {
        fake.serve.failNext('GET', '/api/event', 503, 0);
        await context.restart({ env: { COSYNCING_OPENCODE_SSE_RECONNECT_MS: saved.reconnect, COSYNCING_OPENCODE_SSE_IDLE_MS: saved.idle } });
      }
    },
  },
);

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
    title: 'a prompt that names no model runs on the model the app chose, across a restart, until the session names its own',
    async run(context) {
      const fake = fakeOf(context);
      const id = fake.prepareCreate();
      const cwd = fake.workspace('chosen-model');
      const target = { providerID: OPENCODE_PROVIDER, modelID: 'model-b' };
      const created = await context.client.post('/api/sessions/opencode', { directory: cwd, title: 'Chosen model', model: target });
      expect(created.status, created.text).toBe(200);
      // OpenCode records no model at create, so after a restart the broker's durable choice is all there is.
      await context.restart();
      await context.client.waitForSession((row) => row.id === id);
      const stream = await context.openDrive({ id, cwd, reason: 'create' });
      expect(lastSession(stream).info.currentModel).toMatchObject(target);
      const mark = fake.ledger.mark();
      // Named by neither the prompt nor the session: it runs on the chosen model, not OpenCode's default.
      expect((await context.prompt(stream, 'no model named')).kind).toBe('ack');
      // Once a turn has run on it the session names it itself, and OpenCode picks it for a model-less prompt.
      expect((await context.prompt(stream, 'still no model named')).kind).toBe('ack');
      expect(fake.ledger.routed('POST', /\/prompt_async$/, mark).map((entry) => (entry.body as any).model ?? null))
        .toEqual([target, null]);
      expect(fake.serve.session(id).info.model).toMatchObject({ providerID: OPENCODE_PROVIDER, modelID: 'model-b' });
      stream.close();
      // A session whose own messages name a model (a turn run in a terminal) is not sent the app's choice
      // over it either, though the session record names none.
      const termId = fake.prepareCreate();
      const termCwd = fake.workspace('terminal-model');
      const termCreated = await context.client.post('/api/sessions/opencode', { directory: termCwd, title: 'Terminal model', model: target });
      expect(termCreated.status, termCreated.text).toBe(200);
      fake.serve.addRow(termId, { info: { id: 'msg_term_model_u', role: 'user', time: { created: Date.now() }, model: { providerID: OPENCODE_PROVIDER, modelID: 'model-a' } },
        parts: [{ id: 'prt_term_model_u', type: 'text', text: 'typed in the terminal' }] });
      const term = await context.openDrive({ id: termId, cwd: termCwd, reason: 'create' });
      const termMark = fake.ledger.mark();
      expect((await context.prompt(term, 'after the terminal turn')).kind).toBe('ack');
      expect(fake.ledger.routed('POST', /\/prompt_async$/, termMark).map((entry) => (entry.body as any).model ?? null)).toEqual([null]);
      term.close();
      // A session that names its own model is never sent the app's earlier choice over it.
      const seeded = fake.seedSession({ title: 'own model' });
      await context.client.waitForSession((row) => row.id === seeded.id);
      const own = await context.openDrive({ id: seeded.id, cwd: seeded.cwd, reason: 'takeover' });
      const ownMark = fake.ledger.mark();
      expect((await context.prompt(own, 'on its own model')).kind).toBe('ack');
      expect(fake.ledger.routed('POST', /\/prompt_async$/, ownMark).map((entry) => (entry.body as any).model ?? null)).toEqual([null]);
      own.close();
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
      await eventually(() => fake.ledger.routed('POST', new RegExp(`^/session/${seeded.id}/summarize$`), mark).length > 0, { what: 'the asynchronous summarize request to arrive' });
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
    title: 'share runs through the serve, and a serve from OpenCode 1.19.1 (sharing discontinued) is neither offered nor sent share or unshare',
    async run(context) {
      const fake = fakeOf(context);
      const names = (stream: SessionStream): string[] =>
        ((stream.ofKind('commands').at(-1)?.commands ?? []) as any[]).map((command) => command.name);
      const seeded = fake.seedSession({ title: 'share' });
      await context.client.waitForSession((row) => row.id === seeded.id);
      const stream = await context.openDrive({ id: seeded.id, cwd: seeded.cwd, reason: 'takeover' });
      expect(names(stream)).toEqual(expect.arrayContaining(['share', 'unshare']));
      const mark = fake.ledger.mark();
      const from = stream.frames.length;
      expect((await stream.sendAndAwait({ kind: 'command', name: 'share' })).kind).toBe('ack');
      await stream.waitForFrame((frame) => frame.kind === 'notice' && String(frame.message).startsWith('Shared: '), { after: from });
      expect(fake.ledger.routed('POST', new RegExp(`^/session/${seeded.id}/share$`), mark).length).toBe(1);
      try {
        // The serve is upgraded under an open session: the actions that session listed are refused
        // before any native call, and a session opened afterwards does not offer them.
        fake.serve.setVersion('1.19.1');
        const upgraded = fake.ledger.mark();
        for (const name of ['share', 'unshare']) {
          const refused = await stream.sendAndAwait({ kind: 'command', name });
          expect(refused.kind).toBe('nack');
          expect(refused.code).toBe('NOT_SUPPORTED');
          expect(String(refused.message)).toContain('1.19.1');
        }
        const later = fake.seedSession({ title: 'share after 1.19.1' });
        await context.client.waitForSession((row) => row.id === later.id);
        const fresh = await context.openDrive({ id: later.id, cwd: later.cwd, reason: 'takeover' });
        expect(names(fresh)).not.toContain('share');
        expect(names(fresh)).not.toContain('unshare');
        expect(names(fresh)).toEqual(expect.arrayContaining(['compact', 'undo', 'redo', 'stop', 'review']));
        fresh.close();
        expect(fake.ledger.routed('POST', /\/share$/, upgraded)).toEqual([]);
        expect(fake.ledger.routed('DELETE', /\/share$/, upgraded)).toEqual([]);
      } finally {
        fake.serve.setVersion(OPENCODE_VERSION);
      }
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
    title: 'a native failure shows once, whichever of its two reports comes first and however often its message is announced',
    async run(context) {
      const fake = fakeOf(context);
      const seeded = fake.seedSession({ title: 'failure once' });
      await context.client.waitForSession((row) => row.id === seeded.id);
      const stream = await context.openDrive({ id: seeded.id, cwd: seeded.cwd, reason: 'takeover' });
      const from = stream.frames.length;
      const errorRows = (text: string) => stream.frames.slice(from)
        .filter((frame) => frame.kind === 'message' && frame.message.type === 'error' && frame.message.message === text).length;
      // Everything the serve published before a sentinel has been handled once the sentinel shows.
      let sentinels = 0;
      const settled = async () => {
        const text = `sentinel ${++sentinels}`;
        fake.serve.publish({ type: 'message.part.updated', properties: {
          sessionID: seeded.id, part: { id: `prt_sentinel_${sentinels}`, type: 'text', text, sessionID: seeded.id, messageID: `msg_sentinel_${sentinels}` },
        } });
        await stream.waitForMessage((message) => message.type === 'model-output' && textOf(message) === text);
      };
      // The serve's own order: `session.error`, then the assistant message carrying the same error. (The
      // prompt's ack waits for the serve to finish the turn it started.)
      expect((await context.prompt(stream, '[[error]] explode')).kind).toBe('ack');
      await settled();
      expect(errorRows('model exploded')).toBe(1);
      // The other order, with the failed message announced twice as it updates: still one row.
      const failed = (id: string, text: string) => ({ type: 'message.updated', properties: { sessionID: seeded.id, info: {
        id, sessionID: seeded.id, role: 'assistant', time: { created: Date.now(), completed: Date.now() }, error: { name: 'ProviderError', data: { message: text } },
      } } });
      fake.serve.publish(failed('msg_failed_twice', 'quota exhausted'));
      fake.serve.publish(failed('msg_failed_twice', 'quota exhausted'));
      fake.serve.publish({ type: 'session.error', properties: { sessionID: seeded.id, error: { name: 'ProviderError', data: { message: 'quota exhausted' } } } });
      await settled();
      expect(errorRows('quota exhausted')).toBe(1);
      // A failure reported once, then the same failure in the next turn: a new failure, and it shows. The
      // next turn's user row announced again (the serve updates it after the turn) does not start another.
      const user = (id: string) => ({ type: 'message.updated', properties: { sessionID: seeded.id, info: { id, sessionID: seeded.id, role: 'user', time: { created: Date.now() } } } });
      const sessionError = (text: string) => ({ type: 'session.error', properties: { sessionID: seeded.id, error: { name: 'ProviderError', data: { message: text } } } });
      fake.serve.publish(user('msg_turn_a'));
      fake.serve.publish(sessionError('rate limited'));
      await settled();
      expect(errorRows('rate limited')).toBe(1);
      fake.serve.publish(user('msg_turn_b'));
      fake.serve.publish(failed('msg_failed_b', 'rate limited'));
      await settled();
      expect(errorRows('rate limited')).toBe(2);
      fake.serve.publish(user('msg_turn_b'));
      fake.serve.publish(sessionError('rate limited'));
      await settled();
      expect(errorRows('rate limited')).toBe(2);
      stream.close();
      // A reader of the history sees the failed turn's error once too.
      const fresh = await context.client.attach('opencode', seeded.id);
      const history = (await fresh.waitForKind('history')).messages as any[];
      expect(history.filter((message) => message.type === 'error' && message.message === 'model exploded').length).toBe(1);
      fresh.close();
    },
  },
  {
    title: 'an identical message typed in a terminal is not stamped as the app\'s own send',
    async run(context) {
      const fake = fakeOf(context);
      const session = await context.drivableSession('stamp');
      const stream = await context.openDrive(session);
      expect((await context.prompt(stream, 'same words', { clientMessageId: 'stamp-1' })).kind).toBe('ack');
      // The app's own echo and its own turn's end are in before the cursor is taken. The ack answers the
      // POST, which can beat the echo on the event stream, and the seeded turn's finished summary is
      // already in the history, so neither alone says the echo arrived.
      const ownEcho = await stream.waitForMessage((message) => message.type === 'user-message' && message.clientKey === 'stamp-1');
      await stream.waitForMessage((message) => message.type === 'run-summary' && message.status === 'done'
        && message.userMessageKey === ownEcho.key);
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


opencodeKit.extras!.push({
  title: 'V1 live and private seats lose write authority when the facade binds V2',
  async run(context) {
    const fake = fakeOf(context);
    const session = await context.drivableSession('generation transition');
    const stream = await context.openDrive(session);
    const privateSession = fake.seedSession({ title: 'private generation transition' });
    await context.client.waitForSession((row) => row.id === privateSession.id);
    const privateStream = await context.client.attach('opencode', privateSession.id, { mode: 'resume', reason: 'takeover' });
    expect((await privateStream.waitForKind('session')).info.attachMode).toBe('resume');
    await privateStream.waitForKind('history');
    const root = context.broker.env.XDG_STATE_HOME || join(fake.paths.home, '.local', 'state');
    const path = join(root, 'opencode', 'service.json');
    mkdirSync(join(root, 'opencode'), { recursive: true });
    const native = new FakeOpenCodeV2Serve({ record: () => {}, onRegistration: (value) => {
      if (value) { writeFileSync(path, JSON.stringify({ ...value, url: fake.serve.url }), { mode: 0o600 }); chmodSync(path, 0o600); }
    } });
    try {
      native.start(0);
      // Keep V1 routes live while the configured address identifies and routes to V2.
      fake.serve.apiProxy = native.url;
      const from = stream.frames.length;
      await context.client.sessions({ refresh: true });
      await stream.waitForFrame((frame) => frame.kind === 'session' && frame.authority?.canMutate === false, { after: from });
      const mark = fake.ledger.mark();
      expect((await stream.sendAndAwait({ kind: 'prompt', text: 'must not reach V1' })).kind).toBe('nack');
      expect(fake.ledger.routed('POST', /\/prompt_async$/, mark)).toHaveLength(0);
      await privateStream.waitForFrame((frame) => frame.kind === 'session' && frame.authority?.canMutate === false);
      expect((await privateStream.sendAndAwait({ kind: 'prompt', text: 'must not start a private V1 run' })).kind).toBe('nack');
      expect(fake.ledger.spawns(mark)).toHaveLength(0);
    } finally {
      fake.serve.apiProxy = undefined; rmSync(path, { force: true }); stream.close(); privateStream.close();
      try { await context.restart(); } finally { native.stop(); }
    }
  },
});

opencodeV2Kit.extras!.push(
  {
    title: 'rename and fork preserve live metadata and copy history before the selected message',
    async run(context) {
      const fake = context.fake as OpencodeV2Fake;
      const seeded = fake.seedSession({ title: 'Before rename', turns: 2 });
      const stream = await context.openDrive({ ...seeded, reason: 'takeover' });
      try {
        const mark = fake.ledger.mark(), from = stream.frames.length;
        const renamed = await context.client.request('PATCH', `/api/sessions/opencode/${seeded.id}/rename`, { title: '  After rename  ' });
        expect(renamed.status, renamed.text).toBe(200);
        await stream.waitForFrame((frame) => frame.kind === 'session' && frame.info.title === 'After rename', { after: from });
        expect(fake.ledger.routed('PATCH', new RegExp(`^/api/session/${seeded.id}$`), mark).map((entry) => entry.body)).toEqual([{ title: 'After rename' }]);
        let releaseRoster!: () => void;
        const rosterGate = new Promise<void>((resolve) => { releaseRoster = resolve; });
        fake.serve.beforeRosterReply = () => rosterGate;
        try {
          const externalFrom = stream.frames.length;
          fake.serve.session(seeded.id).info.title = 'Renamed in the terminal';
          fake.serve.emit('session.renamed', { sessionID: seeded.id, title: 'Renamed in the terminal' }, true);
          await stream.waitForFrame((frame) => frame.kind === 'session' && frame.info.title === 'Renamed in the terminal', { after: externalFrom });
        } finally { fake.serve.beforeRosterReply = undefined; releaseRoster(); }
        const second = fake.serve.session(seeded.id).messages.filter((message) => message.type === 'user')[1]!.id;
        const forked = await context.client.post(`/api/sessions/opencode/${seeded.id}/fork`, { messageId: second });
        expect(forked.status, forked.text).toBe(200);
        const fork = await context.client.attach('opencode', forked.body.session.id);
        expect(userTexts((await fork.waitForKind('history')).messages)).toEqual(['seeded prompt 1']);
        expect((await fork.waitForKind('session')).authority.canMutate).toBe(true);
        fork.close();
        expect(fake.ledger.routed('POST', /\/fork$/, mark).map((entry) => entry.body)).toEqual([{ before: second }]);
        fake.serve.failNext('PATCH', `/api/session/${seeded.id}`, 500, 1, { message: 'native diagnostic detail' });
        const refused = await context.client.request('PATCH', `/api/sessions/opencode/${seeded.id}/rename`, { title: 'Rejected' });
        expect(refused.status).toBeGreaterThanOrEqual(400);
        expect(refused.text).not.toContain('native diagnostic detail');
      } finally { stream.close(); }
    },
  },
  {
    title: 'undo stages a shared boundary and a new prompt discards redo history without a commit call',
    async run(context) {
      const fake = context.fake as OpencodeV2Fake;
      const seeded = fake.seedSession({ title: 'reversible branch', turns: 2 });
      const stream = await context.openDrive({ ...seeded, reason: 'takeover' });
      const observer = await context.client.attach('opencode', seeded.id, { readOnly: true });
      await observer.waitForKind('history');
      try {
        const users = fake.serve.session(seeded.id).messages.filter((message) => message.type === 'user');
        const mark = fake.ledger.mark();
        let from = stream.frames.length, otherFrom = observer.frames.length;
        expect((await stream.sendAndAwait({ kind: 'command', name: 'undo' })).kind).toBe('ack');
        for (const [seat, after] of [[stream, from], [observer, otherFrom]] as const) {
          const reset = await seat.waitForFrame((frame) => frame.kind === 'history' && frame.reset === true && userTexts(frame.messages).length === 1, { after });
          expect(userTexts(reset.messages)).toEqual(['seeded prompt 1']);
        }
        for (const seat of [stream, observer]) {
          const notice = await seat.waitForFrame((frame) => frame.kind === 'notice' && frame.message === 'Reverted to an earlier message — /redo to restore', { after: seat === stream ? from : otherFrom });
          expect(notice.message).toBe('Reverted to an earlier message — /redo to restore');
        }
        expect(fake.serve.session(seeded.id).messages.filter((message) => message.type === 'user')).toHaveLength(2);
        expect(fake.ledger.routed('POST', /\/revert\/stage$/, mark).map((entry) => entry.body)).toEqual([{ messageID: users[1]!.id }]);
        from = stream.frames.length;
        expect((await stream.sendAndAwait({ kind: 'command', name: 'redo' })).kind).toBe('ack');
        await stream.waitForFrame((frame) => frame.kind === 'history' && frame.reset === true && userTexts(frame.messages).length === 2, { after: from });
        const restored = await stream.waitForFrame((frame) => frame.kind === 'notice' && frame.message === 'Restored the reverted messages', { after: from });
        expect(restored.message).toBe('Restored the reverted messages');
        from = stream.frames.length;
        expect((await stream.sendAndAwait({ kind: 'command', name: 'undo' })).kind).toBe('ack');
        await stream.waitForFrame((frame) => frame.kind === 'history' && frame.reset === true && userTexts(frame.messages).length === 1, { after: from });
        const replaceFrom = stream.frames.length;
        expect((await context.prompt(stream, 'replace the staged turn')).kind).toBe('ack');
        await stream.waitForMessage((message) => message.type === 'model-output' && message.text === 'answer: replace the staged turn');
        expect(fake.serve.session(seeded.id).messages.some((message) => message.id === users[1]!.id)).toBe(false);
        expect(stream.frames.slice(replaceFrom).some((frame) => frame.kind === 'notice' && ['Reverted to an earlier message — /redo to restore', 'Restored the reverted messages'].includes(frame.message))).toBe(false);
        const noRedo = stream.frames.length;
        expect((await stream.sendAndAwait({ kind: 'command', name: 'redo' })).kind).toBe('ack');
        await stream.waitForFrame((frame) => frame.kind === 'notice' && /Nothing to redo/.test(String(frame.message)), { after: noRedo });
        expect(fake.ledger.routed('POST', /\/revert\/commit$/, mark)).toHaveLength(0);
      } finally { stream.close(); observer.close(); }
    },
  },
  {
    title: 'compaction uses its own success or failure even when execution succeeds',
    async run(context) {
      const fake = context.fake as OpencodeV2Fake;
      const session = await context.drivableSession('compact outcomes');
      const stream = await context.openDrive(session);
      try {
        const names = stream.ofKind('commands').at(-1)!.commands.map((command: any) => command.name);
        expect(names).not.toContain('share'); expect(names).not.toContain('unshare');
        const commands = stream.ofKind('commands').at(-1)!.commands;
        for (const [name, description] of [['compact', 'Compact / summarize the session'], ['undo', 'Revert the last message'], ['redo', 'Restore the reverted message'], ['stop', 'Stop the running turn']]) {
          expect(commands.find((command: any) => command.name === name)?.description).toBe(description);
        }
        let from = stream.frames.length;
        expect((await stream.sendAndAwait({ kind: 'command', name: 'compact' })).kind).toBe('ack');
        fake.serve.finishCompaction(session.id);
        await stream.waitForFrame((frame) => frame.kind === 'notice' && frame.message === 'Compacted the conversation.', { after: from });
        await stream.waitForFrame((frame) => frame.kind === 'history' && frame.reset === true && frame.messages.some((message: any) => message.type === 'model-output' && message.text === 'Synthetic compacted context.'), { after: from });
        await stream.waitForFrame((frame) => frame.kind === 'session' && frame.info.status === 'idle', { after: from });
        from = stream.frames.length;
        expect((await stream.sendAndAwait({ kind: 'command', name: 'compact' })).kind).toBe('ack');
        fake.serve.finishCompaction(session.id, true);
        await stream.waitForFrame((frame) => frame.kind === 'message' && frame.message.type === 'error' && /could not compact/.test(frame.message.message), { after: from });
        await stream.waitForFrame((frame) => frame.kind === 'message' && frame.message.type === 'run-summary' && frame.message.status === 'done', { after: from });
        expect(stream.frames.slice(from).some((frame) => frame.kind === 'notice' && frame.message === 'Compacted the conversation.')).toBe(false);
      } finally { stream.close(); }
    },
  },
  {
    title: 'staged file references and maximum inline images keep shared stream and history usable',
    async run(context) {
      const fake = context.fake as OpencodeV2Fake;
      const cwd = fake.workspace('files with spaces'), id = `ses_files${crypto.randomUUID().replaceAll('-', '')}`;
      fake.serve.seed({ id, directory: cwd, title: 'native files', turns: 0 });
      const stream = await context.openDrive({ id, cwd, reason: 'takeover' });
      const otherSession = await context.drivableSession('independent image-stream observer');
      const other = await context.openDrive(otherSession);
      try {
        const mark = fake.ledger.mark();
        const uploads = `/api/sessions/opencode/${id}/uploads`;
        const payload = Buffer.alloc(3 * 1024 * 1024, 120);
        const begin = await context.client.post(uploads, { name: 'multi megabyte.txt', mimeType: 'text/plain', size: payload.length });
        expect(begin.status, begin.text).toBe(200);
        const upload = `${uploads}/${begin.body.uploadId}`;
        expect((await context.client.request('PATCH', upload, payload, { 'x-cosyncing-upload-offset': '0' })).status).toBe(200);
        const completed = await context.client.post(`${upload}/complete`);
        expect(completed.status, completed.text).toBe(200);
        const stagedFrom = stream.frames.length;
        expect((await stream.sendAndAwait({ kind: 'prompt', text: 'read the staged file', files: [{ stagedRef: completed.body.stagedRef, size: payload.length }] })).kind).toBe('ack');
        const staged = await stream.waitForMessage((message) => message.type === 'user-message' && message.text.startsWith('read the staged file') && !message.queued);
        await stream.waitForMessage((message) => message.type === 'run-summary' && message.status === 'done');
        const request = fake.ledger.routed('POST', /\/prompt$/, mark)[0]!.body as any;
        const path = join(cwd, '.cosyncing', 'inbox', completed.body.name);
        expect(request.text).toBe(`read the staged file\n\nAttached file(s) — read them from these paths:\n- ${completed.body.name} (text/plain) → \`${path}\``);
        expect(request.files).toBeUndefined();
        expect(stream.frames.slice(stagedFrom).filter((frame) => frame.kind === 'message' && frame.message.type === 'user-message' && frame.message.key === staged.key && !frame.message.queued)).toHaveLength(1);

        const imageData = Buffer.alloc(PROMPT_ATTACHMENT_LIMITS.maxInlineDecodedBytes, 73).toString('base64');
        const images = Array.from({ length: PROMPT_ATTACHMENT_LIMITS.maxFiles }, (_, index) => ({ name: `image-${index}.png`, mimeType: 'image/png', data: imageData }));
        const otherFrom = other.frames.length, imageMark = fake.ledger.mark();
        expect((await context.prompt(stream, 'one full-limit image', { images: images.slice(0, 1) })).kind).toBe('ack');
        const registration = fake.serve.registration();
        for (const text of ['eight inline images', 'a second image batch']) {
          const from = stream.frames.length;
          // A terminal can enqueue a larger native batch than the broker's aggregate inline budget.
          const nativeId = `msg_images_${crypto.randomUUID().replaceAll('-', '')}`;
          const response = await fetch(`${fake.serve.url}/api/session/${id}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`opencode:${registration.password}`).toString('base64')}` }, body: JSON.stringify({ id: nativeId, text, delivery: 'steer', files: images.map((image) => ({ uri: `data:${image.mimeType};base64,${image.data}`, name: image.name })) }) });
          expect(response.status).toBe(200);
          expect((await response.json() as any).data.id).toBe(nativeId);
          const echo = await stream.waitForFrame((frame) => frame.kind === 'message' && frame.message.type === 'user-message' && frame.message.text === text && !frame.message.queued, { after: from });
          expect(echo.message.imageCount).toBe(PROMPT_ATTACHMENT_LIMITS.maxFiles);
          expect(stream.frames.slice(from).filter((frame) => frame.kind === 'message' && frame.message.type === 'user-message' && frame.message.key === echo.message.key && !frame.message.queued)).toHaveLength(1);
          await stream.waitForFrame((frame) => frame.kind === 'message' && frame.message.type === 'run-summary' && frame.message.status === 'done', { after: from });
        }
        const replay = await context.client.attach('opencode', id, { readOnly: true });
        const history = (await replay.waitForKind('history')).messages;
        for (const text of ['eight inline images', 'a second image batch']) {
          expect(history.find((message: any) => message.type === 'user-message' && message.text === text)?.imageCount).toBe(PROMPT_ATTACHMENT_LIMITS.maxFiles);
        }
        expect(JSON.stringify(history)).not.toContain(imageData);
        replay.close();
        expect(fake.ledger.routed('GET', new RegExp(`^/api/session/${id}/message$`), imageMark).some((entry) => Number((entry.query as any).limit) < 100)).toBe(true);
        fake.serve.appendTurn(otherSession.id, 'image sentinel', 'the other stream stays connected');
        await other.waitForMessage((message) => message.type === 'model-output' && message.text === 'the other stream stays connected');
        expect(other.frames.slice(otherFrom).filter((frame) => frame.kind === 'history' && frame.reset === true)).toHaveLength(0);
        expect(fake.ledger.routed('GET', /^\/api\/event$/, imageMark)).toHaveLength(0);

        fake.serve.failNext('POST', `/api/session/${id}/prompt`, 400);
        const from = stream.frames.length, rejectedMark = fake.ledger.mark();
        expect((await context.prompt(stream, 'rejected attachment', { images: [{ name: 'refused.png', mimeType: 'image/png', data: 'eA==' }] })).kind).toBe('nack');
        expect((await context.prompt(stream, 'after file rejection')).kind).toBe('ack');
        await stream.waitForMessage((message) => message.type === 'model-output' && message.text === 'answer: after file rejection');
        expect(stream.frames.slice(from).some((frame) => frame.kind === 'message' && frame.message.type === 'user-message' && frame.message.text === 'rejected attachment')).toBe(false);
        expect(fake.ledger.routed('GET', /\/inbox$/, rejectedMark)).toHaveLength(0);
      } finally { stream.close(); other.close(); }

      if (process.platform === 'linux') {
        const saved = context.broker.env.OPENCODE_URL;
        fake.serve.authenticationRequired = false;
        try {
          // Linux reaches this fixture locally while the configured origin is outside the supported local names.
          await context.restart({ env: { OPENCODE_URL: `http://0.0.0.0:${fake.serve.port}` } });
          const session = await context.drivableSession('non-local attachment refusal');
          const seat = await context.openDrive(session);
          try {
            const mark = fake.ledger.mark();
            expect((await seat.sendAndAwait({ kind: 'prompt', text: 'must stay local', files: [{ name: 'remote.txt', mimeType: 'text/plain', data: 'eA==' }] })).kind).toBe('nack');
            expect(fake.ledger.routed('POST', /\/prompt$/, mark)).toHaveLength(0);
          } finally { seat.close(); }
        } finally {
          fake.serve.authenticationRequired = true;
          await context.restart({ env: { OPENCODE_URL: saved } });
        }
      }
    },
  },
  {
    title: 'native HTTP export retains confirmation, broker redaction and the byte cap without a CLI',
    async run(context) {
      const fake = context.fake as OpencodeV2Fake;
      const saved = { COSYNCING_R2_MAX_BYTES: context.broker.env.COSYNCING_R2_MAX_BYTES, COSYNCING_R2_ENABLED_ACTIONS: context.broker.env.COSYNCING_R2_ENABLED_ACTIONS };
      await context.restart({ env: { COSYNCING_R2_MAX_BYTES: '65536', COSYNCING_R2_ENABLED_ACTIONS: 'transcriptExport' } });
      fake.cli.setInstalled(false);
      try {
        const session = await context.drivableSession('HTTP export');
        const base = `/api/sessions/opencode/${session.id}/export`, mark = fake.ledger.mark();
        const preflight = await context.client.post(`${base}/preflight`);
        expect(preflight.status, preflight.text).toBe(200);
        expect((await context.client.post(base, {})).status).toBeGreaterThanOrEqual(400);
        const exported = await context.client.post(base, { nonce: preflight.body.nonce });
        expect(exported.status, exported.text).toBe(200);
        expect(exported.body.artifact.deliveryClass).toBe('export-attachment');
        const artifact = await context.client.get(exported.body.artifact.fetchUrl);
        expect(artifact.status).toBe(200);
        expect(artifact.headers.get('content-disposition')).toStartWith('attachment;');
        expect(artifact.text).not.toContain(session.cwd);
        expect(fake.ledger.routed('GET', /\/export$/, mark).map((entry) => entry.query)).toEqual([{ sanitize: 'true' }]);
        const next = await context.client.post(`${base}/preflight`);
        fake.serve.exportMessageCount = 1000;
        const tooBig = await context.client.post(base, { nonce: next.body.nonce });
        expect([tooBig.status, tooBig.body.code]).toEqual([413, 'EXPORT_TOO_LARGE']);
        expect(fake.ledger.spawns(mark)).toHaveLength(0);
      } finally {
        fake.serve.exportMessageCount = 0; fake.cli.setInstalled(true);
        await context.restart({ env: saved });
      }
    },
  },
  {
    title: 'registered terminal hints quote the workspace and presence excludes standalone and other servers',
    async run(context) {
      if (process.platform !== 'linux') return;
      const fake = context.fake as OpencodeV2Fake, saved = context.broker.env.OPENCODE_URL;
      const terminals: Bun.Subprocess[] = [];
      await context.restart({ env: { OPENCODE_URL: undefined } });
      try {
        const cwd = fake.workspace("terminal's workspace"), id = `ses_tui${crypto.randomUUID().replaceAll('-', '')}`;
        fake.serve.seed({ id, directory: cwd, title: 'terminal presence', turns: 1 });
        const stream = await context.openDrive({ id, cwd, reason: 'takeover' });
        const info = (await stream.waitForKind('session')).info;
        expect(info.terminalSyncHint.command).not.toContain('attach');
        expect(info.terminalSyncHint.command).not.toContain('--server');
        const decoy = fake.seedSession({ title: 'standalone decoy' });
        const other = fake.seedSession({ title: 'server decoy' });
        const launch = (argv: string[]) => terminals.push(Bun.spawn(argv, { cwd, env: { PATH: fixturePath(fake.paths.bin) }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }));
        launch([fake.cli.path, '--standalone', '-s', decoy.id]);
        launch([fake.cli.path, '--server', `http://127.0.0.1:${fake.serve.port + 1}`, '--session', other.id]);
        const from = stream.frames.length;
        launch(['/bin/sh', '-c', `exec ${info.terminalSyncHint.command}`]);
        await stream.waitForFrame((frame) => frame.kind === 'session' && frame.info.control.terminalSync.active === true, { after: from });
        const rows = await context.client.sessions({ refresh: true });
        for (const session of [decoy, other]) expect(rows.find((row: any) => row.id === session.id)?.control.terminalSync.active).toBe(false);
        terminals[2]!.kill('SIGTERM'); await terminals[2]!.exited;
        await stream.waitForFrame((frame) => frame.kind === 'session' && frame.info.control.terminalSync.active === false, { after: from });
        stream.close();
        fake.serve.authenticationRequired = false;
        const registration = fake.serve.registration(); delete registration.password;
        writeFileSync(fake.registrationPath, JSON.stringify(registration), { mode: 0o600 });
        await context.restart({ env: { OPENCODE_URL: fake.serve.url } });
        const explicit = await context.client.attach('opencode', id);
        expect((await explicit.waitForKind('session')).info.terminalSyncHint.command).toContain(`--server '${fake.serve.url}'`);
        explicit.close();
      } finally {
        for (const terminal of terminals) { if (terminal.exitCode === null) terminal.kill('SIGTERM'); await terminal.exited; }
        fake.serve.authenticationRequired = true; fake.serve.publishRegistration();
        await context.restart({ env: { OPENCODE_URL: saved } });
      }
    },
  },
);
