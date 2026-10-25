/**
 * Antigravity (`agy`) conformance kit: a stream-json child the broker starts on the first prompt of a stored
 * conversation, against a file-backed store (summaries sqlite, brain transcripts, settlement inboxes) with no
 * daemon, no socket and no version gate on Drive.
 *
 * The native side is one fake: `fakes/agy-cli.ts` is the `agy` binary in the fixture PATH. Its Drive child speaks
 * the measured NDJSON wire and appends each turn to the conversation's transcript, which is what Observe tails.
 * The store lives under the fixture HOME (`.gemini/antigravity-cli`, `.antigravity_cockpit/cache`); the real
 * `~/.gemini` and `~/.antigravity*` are never read or written.
 *
 * The ledger is the fake's own: a child start is `spawn` (argv, cwd), a prompt is `session/prompt` and the
 * conversation a child loads is `session/load`, so the shared scenarios read it unchanged.
 */
import { expect } from 'bun:test';
import { appendFileSync, mkdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { eventually, fixturePath, type FixturePaths, type SessionStream } from '../../harness/index.ts';
import {
  appendSteps,
  ensureSummariesDb,
  nextStepIndex,
  plannerStep,
  putLastConversation,
  putSummaryRow,
  readTranscript,
  transcriptPath,
  userStep,
  wrapUserRequest,
  type FakeAgyConfig,
} from './fakes/agy-cli.ts';
import {
  type ConformanceExtra,
  type ConformanceKit,
  type ConformanceProfile,
  type FakeController,
  installFakeExecutable,
  Ledger,
  makeFifo,
  replacedLogResetsObserve,
  type SeededSession,
  type SeedOptions,
  treeSnapshot,
} from './kit.ts';

export const AGY_VERSION = '1.1.17';
export const AGY_PROVIDER = 'google-antigravity';

/** `agy models` for this kit: one effort family (two variants) and one plain model. */
const AGY_MODELS = [
  'fixture-pro-low\tFixture Pro (Low)',
  'fixture-pro-high\tFixture Pro (High)',
  'fixture-lite\tFixture Lite',
];

export const agyProfile: ConformanceProfile = {
  agent: 'agy',
  displayName: 'Antigravity',
  capabilities: {
    integrationKind: 'sdk-callback',
    attachModes: ['observe', 'resume'],
    supportsObserve: true,
    supportsResume: true,
    supportsLiveAttach: false,
    supportsCrossClientDriveSharing: true,
    supportsNativeArtifact: false,
    supportsNativeFileInput: false,
    supportsModelSwitch: true,
    permissionGranularity: 'per-tool',
  },
  driveFamily: 'broker-child',
  driveEligibility: 'stored-idle',
  version: {
    current: AGY_VERSION,
    below: '1.1.16',
    newer: '1.9.0',
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
    models: [`${AGY_PROVIDER}/fixture-pro-high`, `${AGY_PROVIDER}/fixture-lite`],
    modes: ['default', 'accept-edits', 'plan'],
    commands: [],
    switchModel: { providerID: AGY_PROVIDER, modelID: 'fixture-lite' },
  },
  driveArgv: {
    required: ['--conversation', '--output-format=stream-json', '--input-format=stream-json'],
    forbidden: ['--print', '--prompt', '--effort'],
  },
  createChildAdopted: false,
  // The child appends the user step to the transcript the moment it starts the turn.
  userRowDurable: 'turn-start',
  // An idle send is delivered at once; only a send behind a running turn waits queued.
  idleSendQueued: false,
  commandsFrame: false,
  terminal: { resumeHint: 'agy --conversation {id}', syncAvailable: false },
  subagents: true,
  missingBinaryRoster: 'observe-only',
  scenarios: {
    C07: {
      skip: 'agy has no native create: the broker mints the conversation id and the CLI materialises it on the '
        + 'first prompt, so there is no session/new, no id to refuse as already stored and no child to adopt '
        + '(the create extra asserts the real flow).',
    },
    C11: {
      skip: 'agy cannot relay an approval: permissions are answered where the session runs, and a Drive child '
        + 'asks nothing (the Antigravity approvals notice is asserted by the card-less drive extras).',
    },
    C12: {
      refuse: 'agy advertises no stop action and its child has no cancel input: the product offers no Stop and '
        + 'refuses a crafted one before the child.',
    },
    C16: {
      skip: 'agy has no runtime version gate: Drive needs only the binary on PATH (C17), and the version floor is '
        + 'only a doctor verdict (C22 asserts it per version).',
    },
    C19: {
      skip: 'agy offers no slash commands under stream-json (upstream: `/x` is unavailable with '
        + '`--input-format stream-json`), so there is no catalog and nothing rides the prompt queue.',
    },
  },
  hostileStore: [
    {
      name: 'a brain directory whose name is not a conversation id',
      plant: (fake) => plantBrain(fake, '../not-a-uuid'),
    },
    {
      name: 'a brain directory named like an id but with the wrong shape',
      plant: (fake) => plantBrain(fake, '77777777-7777-7777-7777-77777777777'),
    },
    {
      name: 'an IDE conversation in the shared summaries table',
      plant: (fake) => {
        const id = crypto.randomUUID();
        (fake as AgyFake).putSummary({ id, preview: 'An IDE conversation', cwd: fake.workspace('ide'), stepCount: 3, ide: true });
        return id;
      },
    },
    {
      // The brain scan lists a directory the summaries table does not know only when it holds a transcript.
      name: 'a brain directory whose transcript is a FIFO',
      unsupportedOn: ['win32'],
      plant: (fake) => {
        const id = crypto.randomUUID();
        makeFifo(transcriptPath((fake as AgyFake).appData, id));
        return id;
      },
    },
    {
      name: 'a subagent whose transcript is a FIFO',
      unsupportedOn: ['win32'],
      plant: (fake) => {
        const appData = (fake as AgyFake).appData;
        const parent = fake.seedSession({ title: 'hostile parent' });
        const child = crypto.randomUUID();
        makeFifo(transcriptPath(appData, child));
        writeSettlement(appData, parent.id, child);
        return child;
      },
    },
    {
      name: 'a FIFO in place of a settlement message',
      unsupportedOn: ['win32'],
      plant: (fake) => {
        const parent = fake.seedSession({ title: 'hostile parent' });
        makeFifo(join(settlementInbox((fake as AgyFake).appData, parent.id), `${crypto.randomUUID()}.json`));
        return crypto.randomUUID();
      },
    },
  ],
};

interface AgyFake extends FakeController {
  readonly appData: string;
  readonly installRoot: string;
  putSummary(row: { id: string; preview: string; cwd?: string; stepCount: number; ide?: boolean }): void;
}

/** The inbox where a parent conversation receives its subagents' settlements. */
function settlementInbox(appData: string, parentId: string): string {
  return join(appData, 'brain', parentId, '.system_generated', 'messages');
}

/** The settlement that names `childId` as `parentId`'s subagent: the only record of the lineage. */
function writeSettlement(appData: string, parentId: string, childId: string): void {
  const inbox = settlementInbox(appData, parentId);
  mkdirSync(inbox, { recursive: true });
  writeFileSync(join(inbox, `${crypto.randomUUID()}.json`), JSON.stringify({
    id: crypto.randomUUID(),
    recipient: parentId,
    sender: childId,
    priority: 'MESSAGE_PRIORITY_HIGH',
    timestamp: new Date().toISOString(),
    renderDetails: { messageTitle: 'Subagent finished' },
    content: 'ok\n',
    sourceMetadata: { tool: { conversationId: parentId, stepIndex: 1, toolCall: { id: 'toolu_fixture_sub', name: 'invoke_subagent' } } },
  }));
}

/** A brain directory nobody should list: its name, not its content, is the hostility. */
function plantBrain(fake: FakeController, name: string): string {
  const appData = (fake as AgyFake).appData;
  const logs = join(appData, 'brain', name, '.system_generated', 'logs');
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, 'transcript.jsonl'), `${JSON.stringify(userStep(0, 'hostile prompt'))}\n`);
  return name;
}

const fakeOf = (context: { fake: FakeController }): AgyFake => context.fake as AgyFake;

/** Errors the product showed on a stream after frame `from`, as text. */
function errorsAfter(stream: SessionStream, from: number): string[] {
  return stream.frames.slice(from)
    .map((frame) => (frame.kind === 'message' && frame.message?.type === 'error' ? frame.message.message : frame.kind === 'error' ? frame.message : undefined))
    .filter((message): message is string => typeof message === 'string');
}

const idleAfter = (stream: SessionStream, from: number) =>
  stream.waitForFrame((frame) => frame.kind === 'message' && frame.message?.type === 'status' && frame.message.status === 'idle', {
    after: from,
    what: 'the session to settle idle',
  });

const modelsRuns = (ledger: Ledger): number => ledger.entries().filter((entry) => entry.kind === 'models').length;

/** The statuses of the turn summaries a stream received after frame `from`, in order. */
const summariesAfter = (stream: SessionStream, from: number): string[] =>
  stream.frames.slice(from)
    .filter((frame) => frame.kind === 'message' && frame.message?.type === 'run-summary')
    .map((frame) => String(frame.message.status));

const agyExtras: ConformanceExtra[] = [
  replacedLogResetsObserve('agy'),
  {
    title: 'session naming keeps a bounded Unicode first prompt instead of a project or id',
    async run(context) {
      const session = context.fake.seedSession({ title: '', turns: 0 });
      await context.client.waitForSession((row) => row.id === session.id && row.title === '');
      const prompt = `路径 / 😀.md\n第二行 ${'😀'.repeat(170)}`;
      const expected = Array.from(prompt.replace(/\s+/g, ' ')).slice(0, 160).join('');
      context.fake.appendForeignUser(session, prompt);
      await context.client.waitForSession((row) => row.id === session.id && row.title === expected);
      const stream = await context.client.attach('agy', session.id, { mode: 'observe' });
      await stream.waitForFrame((frame) => frame.kind === 'session' && frame.info?.title === expected);
      context.fake.appendTurn(session, 'A later prompt', 'A later answer');
      const listed = await context.client.waitForSession((row) => row.id === session.id && row.title === expected);
      expect(listed.title).toBe(expected);
      stream.close();
    },
  },
  {
    title: 'the child argv: never --print or --effort, the effort variant is the sibling id, and a mode rides --mode',
    async run(context) {
      const session = await context.drivableSession('argv contract');
      const stream = await context.openDrive(session);
      const mark = context.fake.ledger.mark();
      // The picker collapsed the Fixture Pro family into one row; a chosen effort relaunches on the sibling id.
      expect((await context.prompt(stream, 'low effort', {
        model: { providerID: AGY_PROVIDER, modelID: 'fixture-pro-high', reasoningEffort: 'low' },
      })).kind).toBe('ack');
      let starts = context.childStarts(session, mark);
      expect(starts.length).toBe(1);
      const argv = starts[0]!.argv ?? [];
      expect(argv.slice(0, 2)).toEqual(['--conversation', session.id]);
      expect(argv).toContain('--output-format=stream-json');
      expect(argv).toContain('--input-format=stream-json');
      expect(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2)).toEqual(['--model', 'fixture-pro-low']);
      for (const forbidden of ['--print', '--prompt', '--effort', '--mode']) expect(argv).not.toContain(forbidden);
      // The same selection on the same child starts nothing new.
      expect((await context.prompt(stream, 'low effort again', {
        model: { providerID: AGY_PROVIDER, modelID: 'fixture-pro-high', reasoningEffort: 'low' },
      })).kind).toBe('ack');
      expect(context.childStarts(session, mark).length).toBe(1);
      // A different effort of the same family relaunches the same conversation on its sibling.
      expect((await context.prompt(stream, 'high effort', {
        model: { providerID: AGY_PROVIDER, modelID: 'fixture-pro-high', reasoningEffort: 'high' },
      })).kind).toBe('ack');
      starts = context.childStarts(session, mark);
      expect(starts.length).toBe(2);
      expect(starts[1]!.argv).toContain('fixture-pro-high');
      expect(starts[1]!.argv).not.toContain('--effort');
      // A mode rides --mode on the next launch, and is the posture the session then publishes.
      const from = stream.frames.length;
      expect((await context.prompt(stream, 'plan it', { permissionMode: 'plan' })).kind).toBe('ack');
      starts = context.childStarts(session, mark);
      expect(starts.length).toBe(3);
      const planArgv = starts[2]!.argv ?? [];
      expect(planArgv.slice(planArgv.indexOf('--mode'), planArgv.indexOf('--mode') + 2)).toEqual(['--mode', 'plan']);
      expect(planArgv).not.toContain('--print');
      await stream.waitForFrame((frame) => (frame.kind === 'session' && frame.info?.currentMode === 'plan')
        || (frame.kind === 'message' && frame.message.type === 'metadata-update' && frame.message.value?.currentMode === 'plan'), { after: from });
      // Every launch loaded exactly this conversation.
      const loads = context.fake.ledger.requests('session/load', mark).map((entry) => entry.frame?.params?.sessionId);
      expect(loads).toEqual([session.id, session.id, session.id]);
      stream.close();
    },
  },
  {
    title: 'a child that exits 0 without a result fails the turn with an error, settles idle and is replaced',
    async run(context) {
      const session = await context.drivableSession('silent exit');
      const stream = await context.openDrive(session);
      const from = stream.frames.length;
      const mark = context.fake.ledger.mark();
      expect((await context.prompt(stream, '[[silent]] vanish')).kind).toBe('ack');
      await idleAfter(stream, from);
      const errors = errorsAfter(stream, from);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain('stopped without reporting the result');
      // The turn the child owed is closed as failed, not left running.
      expect(summariesAfter(stream, from)).toEqual(['error']);
      // The session is still driven: the next prompt starts a replacement child and is answered.
      const next = stream.frames.length;
      expect((await context.prompt(stream, 'after the silence')).kind).toBe('ack');
      await stream.waitForMessage((message) => message.type === 'model-output' && message.text === 'answer: after the silence');
      expect(context.childStarts(session, mark).length).toBe(2);
      expect(errorsAfter(stream, next)).toEqual([]);
      stream.close();
    },
  },
  {
    title: 'a result that reports ERROR is shown as the turn\'s error',
    async run(context) {
      const session = await context.drivableSession('failed result');
      const stream = await context.openDrive(session);
      const from = stream.frames.length;
      expect((await context.prompt(stream, '[[fail]] break it')).kind).toBe('ack');
      await idleAfter(stream, from);
      expect(errorsAfter(stream, from)).toEqual(['Antigravity reported ERROR: fixture failure']);
      // The turn closes with its outcome.
      await eventually(() => summariesAfter(stream, from).length === 1, { what: 'the failed turn\'s summary' });
      expect(summariesAfter(stream, from)).toEqual(['error']);
      stream.close();
    },
  },
  {
    title: 'every cancel-shaped step state ends the step: no error, the turn settles idle, nothing stays running',
    async run(context) {
      const session = await context.drivableSession('cancel states');
      const stream = await context.openDrive(session);
      for (const [index, state] of ['STEP_CANCELED', 'STEP_CANCELLED', 'CANCEL', 'STEP_ABORTED', 'STEP_INTERRUPTED'].entries()) {
        const from = stream.frames.length;
        expect((await context.prompt(stream, `[[state:${state}]] cancel ${index}`)).kind, state).toBe('ack');
        await idleAfter(stream, from);
        expect(errorsAfter(stream, from), state).toEqual([]);
        const partial = stream.messages().slice(0).filter((message) => message.type === 'model-output' && String(message.text).includes('half an answ'));
        expect(partial.length, state).toBe(index + 1);
      }
      // The child survived every one of them: one start for the whole run.
      expect(context.childStarts(session).length).toBe(1);
      stream.close();
    },
  },
  {
    title: 'the live model catalog is fetched once per TTL and a failure is not retried per sweep',
    async run(context) {
      const ledger = context.fake.ledger;
      const startedWith = modelsRuns(ledger);
      // The broker's start already fetched it: sweeps, pickers and drives inside the TTL spawn nothing.
      const session = await context.drivableSession('catalog ttl');
      const stream = await context.openDrive(session);
      for (let sweep = 0; sweep < 3; sweep += 1) {
        await context.client.sessions({ refresh: true });
        expect((await context.client.get('/api/agents/agy/models')).status).toBe(200);
      }
      stream.close();
      expect(modelsRuns(ledger)).toBe(startedWith);
      const models = (await context.client.get('/api/agents/agy/models')).body.models as Array<{ modelID: string }>;
      expect(models.map((model) => model.modelID)).toEqual(['fixture-pro-high', 'fixture-lite']);
      try {
        // An unavailable binary list falls back to the frozen cockpit file, and the failure holds the TTL too.
        context.fake.configure({ modelsExit: 1 });
        const before = modelsRuns(ledger);
        await context.restart();
        expect(modelsRuns(ledger)).toBe(before + 1);
        for (let sweep = 0; sweep < 3; sweep += 1) {
          await context.client.sessions({ refresh: true });
          await context.client.get('/api/agents/agy/models');
        }
        expect(modelsRuns(ledger)).toBe(before + 1);
        const fallback = (await context.client.get('/api/agents/agy/models')).body.models as Array<{ modelID: string }>;
        expect(fallback.map((model) => model.modelID)).toEqual(['frozen-model']);
      } finally {
        context.fake.configure({ modelsExit: undefined });
        await context.restart();
      }
    },
  },
  {
    title: 'Create mints the id, spawns nothing, and the first prompt starts one child on that id and model',
    async run(context) {
      const fake = fakeOf(context);
      const cwd = fake.workspace('create');
      const mark = fake.ledger.mark();
      const created = await context.client.post('/api/sessions/agy', {
        directory: cwd,
        title: 'Created by conformance',
        model: { providerID: AGY_PROVIDER, modelID: 'fixture-lite' },
      });
      expect(created.status, created.text).toBe(200);
      const info = created.body.session;
      expect(info.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(info.nativeId).toBe(info.id);
      expect(info.cwd).toBe(cwd);
      expect(info.title).toBe('Created by conformance');
      expect(info.currentModel?.modelID).toBe('fixture-lite');
      expect(created.body.attachMode).toBe('resume');
      expect(info.control?.drive?.supported).toBe(true);
      // Nothing is on disk and no child runs until the first prompt; the roster already lists the row.
      expect(fake.ledger.spawns(mark)).toEqual([]);
      const listed = await context.client.waitForSession((row) => row.id === info.id);
      expect(listed.title).toBe('Created by conformance');
      const session = { id: info.id as string, cwd, reason: 'create' as const };
      const stream = await context.openDrive(session);
      expect((await context.prompt(stream, 'first created prompt')).kind).toBe('ack');
      const starts = context.childStarts(session, mark);
      expect(starts.length).toBe(1);
      expect(starts[0]!.argv).toEqual([
        '--conversation', info.id, '--output-format=stream-json', '--input-format=stream-json', '--model', 'fixture-lite',
      ]);
      expect(context.prompted(session, mark)).toEqual(['first created prompt']);
      // Once the CLI has written the conversation the store's row replaces the pending one: one row, same id and cwd.
      const rows = await eventually(async () => {
        const all = await context.client.sessions({ refresh: true });
        const mine = all.filter((row) => row.id === info.id && row.cwd === cwd);
        return mine.length === 1 && (mine[0].updatedAt ?? 0) > info.createdAt ? mine : undefined;
      }, { what: 'the created conversation to list once from the store' });
      expect(rows[0].tool).toBe('agy');
      stream.close();
      // A directory that does not exist is refused before anything is recorded.
      const missing = await context.client.post('/api/sessions/agy', { directory: join(cwd, 'not-there') });
      expect(missing.ok, missing.text).toBe(false);
    },
  },
  {
    title: 'a text-less stream user_input step is not shown as an empty prompt and does not leave the sender\'s row queued',
    async run(context) {
      const session = await context.drivableSession('stream user step');
      const stream = await context.openDrive(session);
      const from = stream.frames.length;
      expect((await context.prompt(stream, '[[userstep]] swallow me')).kind).toBe('ack');
      await stream.waitForMessage((message) => message.type === 'model-output' && message.text === 'answer: swallow me');
      await idleAfter(stream, from);
      const live = stream.frames.slice(from).filter((frame) => frame.kind === 'message').map((frame) => frame.message)
        .filter((message) => message.type === 'user-message');
      expect(live.filter((message) => message.text === '')).toEqual([]);
      expect(live.at(-1)?.text).toBe('[[userstep]] swallow me');
      expect(live.at(-1)?.queued === true).toBe(false);
      // A fresh reader always has the prompt exactly once: the transcript is the durable truth.
      const fresh = await context.client.attach('agy', session.id);
      const history = (await fresh.waitForKind('history')).messages as any[];
      expect(history.filter((message) => message.type === 'user-message' && message.text === '[[userstep]] swallow me').length).toBe(1);
      fresh.close();
      stream.close();
    },
  },
  {
    title: 'a watching tab, a tab opened later and a reload key a Drive prompt as its sender did, with the sender\'s clientKey',
    async run(context) {
      const session = await context.drivableSession('echo keys');
      // A tab already watching before the Drive connection existed.
      const watching = await context.client.attach('agy', session.id);
      await watching.waitForKind('history');
      const stream = await context.openDrive(session);
      const sent: Array<{ text: string; clientMessageId: string; key?: string }> = [];
      // The same words twice: each delivery keeps its own sender's key.
      for (const [index, text] of ['repeat me', 'repeat me', 'once more'].entries()) {
        const clientMessageId = `echo-${index}`;
        const from = stream.frames.length;
        expect((await context.prompt(stream, text, { clientMessageId })).kind).toBe('ack');
        await stream.waitForMessage((message) => message.type === 'model-output' && message.text === `answer: ${text}`);
        const own = stream.frames.slice(from).filter((frame) => frame.kind === 'message').map((frame) => frame.message)
          .filter((message) => message.type === 'user-message' && message.clientKey === clientMessageId);
        expect(own.length).toBeGreaterThan(0);
        expect(new Set(own.map((message) => message.key)).size).toBe(1);
        expect(own.at(-1)?.queued === true).toBe(false);
        sent.push({ text, clientMessageId, key: own[0]!.key });
      }
      expect(new Set(sent.map((entry) => entry.key)).size).toBe(sent.length);
      const keyed = (messages: any[]) => sent.map((entry) =>
        messages.filter((message) => message.type === 'user-message' && message.text === entry.text && message.key === entry.key
          && message.clientKey === entry.clientMessageId).length);
      // The tab that was watching all along saw each delivered prompt under its sender's key.
      await eventually(() => keyed(watching.messages()).every((count) => count >= 1), { what: 'the watching tab to key every prompt' });
      // A tab opened now, and a reload, read the same keys from the transcript.
      for (const label of ['a tab opened later', 'a reload']) {
        const fresh = await context.client.attach('agy', session.id);
        const history = (await fresh.waitForKind('history')).messages as any[];
        expect(keyed(history), label).toEqual([1, 1, 1]);
        fresh.close();
      }
      watching.close();
      stream.close();
    },
  },
  {
    title: 'a terminal taking over mid-turn demotes the drive: the turn is settled with a named error, the child is stopped, a takeover is offered',
    async run(context) {
      const session = await context.drivableSession('takeover mid-turn');
      const stream = await context.openDrive(session);
      const mark = context.fake.ledger.mark();
      const turn = context.prompt(stream, '[[hold:dem]] running when taken over');
      await eventually(() => context.prompted(session, mark).length === 1, { what: 'the held turn to reach the child' });
      const from = stream.frames.length;
      context.fake.appendForeignUser(session, 'typed in a terminal');
      const demoted = await stream.waitForFrame((frame) => frame.kind === 'session' && frame.info?.control?.drive?.state !== 'driving', { after: from });
      expect(demoted.info.control.drive.takeoverAvailable).toBe(true);
      expect(demoted.authority?.canMutate).toBe(false);
      await idleAfter(stream, from);
      const errors = errorsAfter(stream, from);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain('taken over');
      // The abandoned child is stopped, and nothing more is written to it.
      await eventually(() => context.fake.ledger.since(mark).some((entry) => entry.kind === 'exit' && entry.signal === 'SIGTERM'), {
        what: 'the abandoned child to be stopped',
      });
      expect((await stream.sendAndAwait({ kind: 'prompt', text: 'after the takeover' })).kind).toBe('nack');
      expect(context.prompted(session, mark)).toEqual(['[[hold:dem]] running when taken over']);
      // The abandoned turn never reports a result, so its own settle never comes (and is not awaited).
      void turn;
      stream.close();
    },
  },
  {
    title: 'the served row offers create, export and model selection and nothing it cannot do; a prompt with images is refused before the child',
    async run(context) {
      const rows = (await context.client.get('/api/agents')).body;
      const row = ((Array.isArray(rows) ? rows : rows.agents) as any[]).find((agent) => agent.id === 'agy');
      expect({
        create: row.canCreateSession,
        modelAtCreation: row.canSelectModelAtCreation,
        rename: row.canRenameNative,
        fork: row.canFork,
        clone: row.canClone,
        export: row.canTranscriptExport,
      }).toEqual({ create: true, modelAtCreation: true, rename: false, fork: false, clone: false, export: true });
      const session = await context.drivableSession('images refused');
      const stream = await context.openDrive(session);
      const mark = context.fake.ledger.mark();
      const refused = await stream.sendAndAwait({
        kind: 'prompt',
        text: 'look at this',
        images: [{ data: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'), mimeType: 'image/png' }],
      });
      expect(refused.kind).toBe('nack');
      expect(context.childStarts(session, mark)).toEqual([]);
      stream.close();
    },
  },
  {
    title: 'without the agy binary Observe still reads the transcript, and Drive is refused with nothing registered',
    async run(context) {
      const seeded = context.fake.seedSession({ title: 'readable without a binary', turns: 1 });
      await context.client.waitForSession((row) => row.id === seeded.id);
      context.fake.setInstalled(false);
      try {
        const observer = await context.client.attach('agy', seeded.id);
        const history = await observer.waitForKind('history');
        expect((history.messages as any[]).some((message) => message.type === 'user-message' && message.text === seeded.texts[0])).toBe(true);
        observer.close();
        const mark = context.fake.ledger.mark();
        const refused = await context.client.attach('agy', seeded.id, { mode: 'resume', reason: 'takeover' });
        const conflict = await refused.waitForKind('attach-conflict');
        expect(conflict.code).toBe('DRIVE_RESTORE_FAILED');
        expect(String(conflict.message)).toContain('Antigravity is not installed');
        await refused.waitForKind('history');
        expect(refused.frames.some((frame) => frame.kind === 'session' && frame.authority?.canMutate === true)).toBe(false);
        refused.close();
        expect(context.fake.ledger.spawns(mark)).toEqual([]);
      } finally {
        context.fake.setInstalled(true);
      }
      const row = await context.client.waitForSession((candidate) => candidate.id === seeded.id);
      expect(row.control?.drive?.state).toBe('observing');
    },
  },
];

export const agyKit: ConformanceKit = {
  profile: agyProfile,
  extras: agyExtras,
  env: () => ({}),
  // The roster joins its model label against the live `agy models` list, fetched in the background by the first
  // sweep; the picker awaits the same single flight, so a model-less first sweep cannot flake a row assertion.
  async ready({ client }) {
    const catalog = await client.get('/api/agents/agy/models');
    expect(catalog.status, catalog.text).toBe(200);
  },
  install(paths: FixturePaths): AgyFake {
    const storeRoot = join(paths.home, '.gemini');
    const appData = join(storeRoot, 'antigravity-cli');
    const cockpitCache = join(paths.home, '.antigravity_cockpit', 'cache');
    const installRoot = join(paths.root, 'fakes', 'agy');
    const controlDir = join(installRoot, 'control');
    for (const directory of [join(appData, 'cache'), join(appData, 'brain'), join(appData, 'conversations'), cockpitCache, controlDir]) {
      mkdirSync(directory, { recursive: true });
    }
    const summaries = join(appData, 'conversation_summaries.db');
    ensureSummariesDb(summaries);
    writeFileSync(join(appData, 'settings.json'), JSON.stringify({ model: 'Fixture Pro (High)', trustedWorkspaces: [] }));
    // The frozen cockpit catalog: the live `agy models` list wins, this is only the no-binary fallback.
    writeFileSync(join(cockpitCache, 'available_models.json'), JSON.stringify({
      version: 1,
      updatedAt: 1,
      models: [{ id: 'frozen-model', displayName: 'Frozen Model', modelConstant: 'MODEL_FROZEN' }],
    }));
    const ledger = new Ledger(join(installRoot, 'ledger.jsonl'));
    const config: FakeAgyConfig = {
      ledger: ledger.path,
      controlDir,
      appData,
      version: AGY_VERSION,
      models: AGY_MODELS,
      defaultModel: 'fixture-pro-high',
    };
    const fake = installFakeExecutable(paths.bin, 'agy', 'agy-cli.ts', config);
    let workspaces = 0;
    let doctorVariants = 0;

    const touch = (id: string): void => {
      const now = new Date();
      utimesSync(transcriptPath(appData, id), now, now);
    };
    const appendStep = (id: string, step: Record<string, unknown>): void => {
      appendSteps(appData, id, [step]);
    };

    const controller: AgyFake = {
      ledger,
      storeRoot,
      appData,
      installRoot,
      workspace(name = 'workspace') {
        const directory = join(paths.root, 'workspaces', `${name}-${++workspaces}`);
        mkdirSync(directory, { recursive: true });
        return directory;
      },
      putSummary(row) {
        putSummaryRow(summaries, row);
      },
      seedSession(options: SeedOptions = {}): SeededSession {
        const id = crypto.randomUUID();
        const cwd = options.childOf?.cwd ?? controller.workspace('seed');
        const title = options.title ?? `Antigravity seeded ${id.slice(0, 8)}`;
        const texts: string[] = [];
        const steps: Record<string, unknown>[] = [];
        for (let turn = 1; turn <= (options.turns ?? 1); turn += 1) {
          const user = `seeded prompt ${turn}`;
          const answer = `seeded answer ${turn}`;
          texts.push(user, answer);
          steps.push(userStep(steps.length, user), plannerStep(steps.length + 1, answer));
        }
        appendSteps(appData, id, steps);
        if (options.childOf) {
          // A child is a brain directory with its own transcript and NO summaries row; only the settlement in the
          // parent's inbox names it (the parent's invoke_subagent step never does).
          writeSettlement(appData, options.childOf.id, id);
        } else {
          putSummaryRow(summaries, { id, preview: title, cwd, stepCount: steps.length });
        }
        touch(id);
        return { id, cwd, title, texts };
      },
      prepareCreate: (id) => id ?? crypto.randomUUID(),
      appendTurn(session, user, answer) {
        const index = nextStepIndex(appData, session.id);
        appendSteps(appData, session.id, [userStep(index, user), plannerStep(index + 1, answer)]);
        touch(session.id);
      },
      appendForeignUser(session, text) {
        appendStep(session.id, userStep(nextStepIndex(appData, session.id), text));
        touch(session.id);
      },
      appendPartial(session, text) {
        appendFileSync(transcriptPath(appData, session.id), JSON.stringify(userStep(nextStepIndex(appData, session.id), text)));
      },
      completePartial(session) {
        appendFileSync(transcriptPath(appData, session.id), '\n');
        touch(session.id);
      },
      rewriteHistory(session) {
        const steps = readTranscript(appData, session.id);
        steps[0] = { ...steps[0], content: wrapUserRequest('rewritten first prompt') };
        writeFileSync(transcriptPath(appData, session.id), steps.map((step) => `${JSON.stringify(step)}\n`).join(''));
      },
      replaceLog(session) {
        const path = transcriptPath(appData, session.id);
        writeFileSync(`${path}.tmp`, readFileSync(path));
        renameSync(`${path}.tmp`, path);
      },
      watcherNoise(session) {
        // A sibling of the transcript the host rewrites constantly: not a row, whatever it holds.
        writeFileSync(join(appData, 'brain', session.id, '.system_generated', 'logs', 'agy.log'), `${Date.now()}\n`);
        putLastConversation(appData, session.cwd, session.id);
      },
      setVersion(version, output) {
        const next = { ...fake.readConfig<FakeAgyConfig>(), version };
        if (output === undefined) delete next.versionOutput;
        else next.versionOutput = output;
        fake.writeConfig(next);
      },
      setInstalled: (installed) => fake.setInstalled(installed),
      release(tag) {
        writeFileSync(join(controlDir, `release-${tag}`), '');
      },
      configure(patch) {
        const previous = fake.readConfig<Record<string, unknown>>();
        fake.writeConfig({ ...previous, ...patch });
        return previous;
      },
      doctorEnvironment(variant) {
        const directory = join(installRoot, `doctor-${++doctorVariants}`);
        mkdirSync(directory, { recursive: true });
        const base = fixturePath(join(paths.root, 'no-agents'));
        if (variant.missing) return { PATH: base };
        installFakeExecutable(directory, 'agy', 'agy-cli.ts', {
          ...fake.readConfig<FakeAgyConfig>(),
          version: variant.version ?? AGY_VERSION,
        });
        return { PATH: [directory, base].join(delimiter) };
      },
      storeSnapshot: () => treeSnapshot(storeRoot),
      // Drive acks a prompt once the child has it; the turn settles when the child reports its result.
      promptSettled(_stream, text) {
        const mark = ledger.mark();
        return async () => {
          await eventually(() => ledger.since(mark).some((entry) => entry.kind === 'turn-end' && entry.text === text), {
            what: `the fake agy to settle the turn "${text}"`,
          });
        };
      },
    };
    return controller;
  },
};
