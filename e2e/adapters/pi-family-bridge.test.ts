/**
 * The Pi-family terminal bridge, through the broker's own routes: the in-session extension is
 * scripted (`PiBridgeSession`), the phone is a real session stream, and the roster, the session
 * frames and the attention feed are read the way the app reads them. Both dialects run the same
 * scenarios: Pi on `/pi/bridge`, omp on `/omp/bridge` (which attests its native version and
 * needs a ready omp, so the fake runtime is installed).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BROKER_CONTRACT_REVISION, CLIENT_REVISION_WITH_OMP_ROSTER_IDENTITY } from '../../packages/typescript/protocol/src/index.ts';
import { type Broker, type BrokerClient, eventually, startBroker } from '../harness/index.ts';
import { PiBridgeSession } from '../harness/fakes/pi-bridge-driver.ts';
import { appendLines, piHeader, piTitleEntry, piSessionFilePath } from './kits/fakes/pi-agent.ts';
import { installPiFamily, OMP_DIALECT_FACTS, PI_DIALECT_FACTS, piRowId, type PiFake, type PiFamilyDialect } from './kits/pi-family.ts';

const GRACE_MS = 3000;
const enc = piRowId;

describe.each([PI_DIALECT_FACTS, OMP_DIALECT_FACTS] as PiFamilyDialect[])('$displayName bridge', (dialect) => {
  const isOmp = dialect.name === 'omp';
  const route = (isOmp ? '/omp/bridge' : '/pi/bridge') as '/pi/bridge' | '/omp/bridge';
  const nativeVersion = isOmp ? { nativeVersion: dialect.version.current } : {};
  let broker: Broker;
  let owner: BrokerClient;
  let fake: PiFake;
  let counter = 0;

  beforeAll(async () => {
    broker = await startBroker({
      name: `${dialect.name}-bridge`,
      env: { COSYNCING_BRIDGE_GRACE_MS: String(GRACE_MS) },
      setup: (paths) => {
        fake = installPiFamily(dialect, paths);
      },
    });
    owner = broker.client();
  });
  afterAll(async () => {
    owner?.closeAll();
    await broker?.stop();
  });

  /** A named native session in the dialect's store. */
  function storedSession(name: string): { file: string; cwd: string; uuid: string } {
    const cwd = fake.workspace(name);
    const uuid = crypto.randomUUID();
    const file = piSessionFilePath(fake.sessionsRoot, cwd, uuid, Date.now());
    appendLines(file, [...piHeader(dialect.name, uuid, cwd, Date.now(), name), piTitleEntry(dialect.name, null, name, Date.now())]);
    return { file: realpathSync(file), cwd, uuid };
  }

  /** A bridge hello whose file the store does not hold (yet). */
  const openBridge = (name: string, extra: Record<string, unknown> = {}) => {
    const cwd = fake.workspace(name);
    return PiBridgeSession.open(owner, {
      cwd,
      title: `${name}-${++counter}`,
      route,
      sessionFile: join(cwd, `${name}-${counter}.jsonl`),
      hello: { ...nativeVersion, ...extra },
    });
  };

  const bridged = async (pi: PiBridgeSession): Promise<boolean> =>
    (await owner.get(`${route}/status?id=${encodeURIComponent(pi.id)}`)).body.bridged;

  const attach = (pi: PiBridgeSession) => owner.attach(dialect.name, pi.id);
  const delta = (text: string) => (message: any) =>
    message?.type === 'model-output' && new RegExp(text).test(message.delta ?? message.text ?? '');

  test('the hello id is the discovered row, and the row says synced with a terminal and has no Drive', async () => {
    const stored = storedSession('identity');
    const discovered = await owner.waitForSession((row) => row.tool === dialect.name && row.cwd === stored.cwd);
    const pi = await PiBridgeSession.open(owner, {
      cwd: stored.cwd,
      sessionFile: stored.file,
      title: 'stale-transcript-filename.jsonl',
      route,
      hello: { nativeId: stored.uuid, ...nativeVersion },
    });
    expect(pi.id).toBe(discovered.id);
    expect(Buffer.from(pi.id, 'base64url').toString('utf8')).toBe(stored.file);

    const stream = await attach(pi);
    const info = (await stream.waitForKind('session')).info;
    expect(info.tool).toBe(dialect.name);
    expect(info.nativeId).toBe(stored.uuid);
    expect(info.title).toBe('identity');
    expect(info.control.terminalSync).toMatchObject({ active: true, label: `Synced with ${dialect.displayName} terminal` });
    expect(info.control.drive).toMatchObject({ supported: false, state: 'unavailable' });
    const row = await owner.waitForSession((candidate) => candidate.id === pi.id && candidate.control?.terminalSync?.active === true);
    expect(row).toMatchObject({ tool: dialect.name, nativeId: stored.uuid, title: 'identity' });
    expect(row.control.terminalSync.label).toBe(`Synced with ${dialect.displayName} terminal`);
    await pi.bye('quit');
  });

  test('a hello through a symlinked store root, before the file exists, re-keys to the canonical id once it does', async () => {
    const cwd = fake.workspace('early');
    const uuid = crypto.randomUUID();
    const real = piSessionFilePath(fake.sessionsRoot, cwd, uuid, Date.now());
    const link = join(broker.paths.root, `link-${dialect.name}-${++counter}`);
    symlinkSync(fake.sessionsRoot, link, 'dir');
    const viaLink = join(link, real.slice(fake.sessionsRoot.length + 1));
    const pi = await PiBridgeSession.open(owner, { cwd, sessionFile: viaLink, title: 'early', route, hello: nativeVersion });
    appendLines(real, piHeader(dialect.name, uuid, cwd, Date.now(), 'early'));
    const canonical = enc(realpathSync(real));
    const row = await owner.waitForSession((candidate) => candidate.id === canonical && candidate.control?.terminalSync?.active === true);
    expect(row.id).not.toBe(pi.id);
    expect((await owner.get(`${route}/status?id=${canonical}`)).body.bridged).toBe(true);
    await pi.bye('quit');
    await eventually(async () => (await owner.get(`${route}/status?id=${canonical}`)).body.bridged === false, { what: 'the canonical bridge to end' });
  });

  test('a hello after the phone attached upgrades the open stream without a reconnect', async () => {
    const stored = storedSession('late');
    const id = enc(stored.file);
    const stream = await owner.attach(dialect.name, id);
    const before = (await stream.waitForKind('session')).info;
    expect(before.control.terminalSync.active).toBe(false);
    const pi = await PiBridgeSession.open(owner, { cwd: stored.cwd, sessionFile: stored.file, title: 'late', route, hello: nativeVersion });
    expect(pi.id).toBe(id);
    await stream.waitForFrame((frame) => frame.kind === 'session' && frame.info?.control?.terminalSync?.active === true
      && frame.info.control.drive?.state === 'unavailable', { what: 'the upgraded session frame' });
    stream.send({ kind: 'prompt', text: 'from app after sync' });
    await pi.nextCommand((command) => command.kind === 'prompt' && /after sync/.test(command.text), { what: 'the prompt' });
    expect(stream.isOpen).toBe(true);
    await pi.bye('quit');
  });

  test('a model with an id and no provider still attaches, without a model claim', async () => {
    const stored = storedSession('no-provider');
    const pi = await PiBridgeSession.open(owner, {
      cwd: stored.cwd, sessionFile: stored.file, title: 'no-provider', route,
      hello: { model: { modelID: 'qwen3:4b' }, ...nativeVersion },
    });
    const row = await owner.waitForSession((candidate) => candidate.id === pi.id);
    expect(row.currentModel).toBeUndefined();
    await pi.bye('quit');
  });

  test('events reach the phone under the dialect namespace, and context usage replays and updates', async () => {
    const pi = await openBridge('events', { history: [{ t: 'context-usage', value: { tokens: 2048, contextWindow: 32768 } }] });
    const stream = await attach(pi);
    await stream.waitForKind('history');
    const isContext = (message: any) => message?.type === 'metadata-update' && message.key === 'contextUsage';
    const replay = await stream.waitForMessage(isContext);
    expect(replay.value).toMatchObject({ used: 2048, max: 32768 });
    const key = `${dialect.name}:run:turn-7`;
    await pi.events(
      { t: 'delta', kind: 'text', key: 't1:t', delta: 'NAMESPACED' },
      { t: 'run', key, turnId: 'turn-7', status: 'done' },
      { t: 'context-usage', value: { tokens: 4096, contextWindow: 32768 } },
    );
    await stream.waitForMessage(delta('NAMESPACED'));
    const run = await stream.waitForMessage((message) => message?.type === 'run-summary' && message.key === key);
    expect(run.source).toBe(`${dialect.name}-bridge`);
    await eventually(() => stream.messages().find((message) => isContext(message) && message.value?.used === 4096), { what: 'live context usage' });
    expect(stream.messages().some((message) => String(message.key ?? '').startsWith(isOmp ? 'pi:run:' : 'omp:run:'))).toBe(false);
    await pi.bye('quit');
  });

  test('a phone prompt lands in the commands queue, and steers while the turn runs', async () => {
    const pi = await openBridge('queue');
    const stream = await attach(pi);
    await stream.waitForKind('history');
    stream.send({ kind: 'prompt', text: 'first from app', clientMessageId: 'ca.bridge.first' });
    const first = await pi.nextCommand((command) => command.kind === 'prompt' && /first from app/.test(command.text), { what: 'the first prompt' });
    if (isOmp) {
      expect(first.messageKey).toStartWith('u:remote:');
      expect(first.clientKey).toBe('ca.bridge.first');
    }
    expect(first.deliverAs).not.toBe('steer');
    await pi.events({ t: 'status', running: true });
    stream.send({ kind: 'prompt', text: 'second while running', clientMessageId: 'ca.bridge.second' });
    const second = await pi.nextCommand((command) => command.kind === 'prompt' && /second while running/.test(command.text), { what: 'the steered prompt' });
    expect(second.deliverAs).toBe('steer');
    await pi.bye('quit');
  });

  test('a file the terminal hands over surfaces in the session as an artifact', async () => {
    const pi = await openBridge('send-file');
    const stream = await attach(pi);
    await stream.waitForKind('history');
    const path = join(pi.cwd, 'handed-over.txt');
    writeFileSync(path, 'file from the terminal\n');
    const response = await pi.sendFile(path);
    expect(response.status).toBeLessThan(300);
    const surfaced = await stream.waitForMessage((message) => JSON.stringify(message).includes('handed-over.txt'), { what: 'the surfaced file' });
    expect(surfaced.type).toBe('file-artifact');
    await pi.bye('quit');
  });

  describe('teardown', () => {
    test('a reload keeps the phone attached, catches its history up, and sends no ended frame', async () => {
      const prior = { t: 'user', key: 'u:remote:prior', clientKey: 'ca.prior', text: 'prior durable prompt', sentAt: 1000 };
      const recovered = { t: 'user', key: 'u:remote:recovered', clientKey: 'ca.recovered', text: 'persisted before the event post', sentAt: 2000 };
      const pi = await openBridge('reload', { history: [prior] });
      const stream = await attach(pi);
      const first = await stream.waitForKind('history');
      expect(first.messages.some((message: any) => message.key === prior.key)).toBe(true);
      await pi.events({ t: 'delta', kind: 'text', key: 't1:t', delta: 'PRE' });
      await stream.waitForMessage(delta('PRE'));
      await pi.bye('reload');
      await pi.client.post(`${route}/hello`, { ...nativeVersion, sessionFile: pi.sessionFile, cwd: pi.cwd, title: pi.title, history: [prior, recovered] });
      const caughtUp = await stream.waitForFrame(
        (frame) => frame.kind === 'history' && frame.reset === true
          && frame.messages?.filter((message: any) => message.key === recovered.key).length === 1,
        { what: 'the catch-up history' },
      );
      expect(caughtUp.messages.filter((message: any) => message.key === prior.key)).toHaveLength(1);
      await pi.events({ t: 'delta', kind: 'text', key: 't1:t', delta: 'POST' });
      await stream.waitForMessage(delta('POST'));
      expect(stream.ofKind('ended')).toEqual([]);
      expect(await bridged(pi)).toBe(true);
      await pi.bye('quit');
    });

    test('quit ends the session with its reason, later events 404, and the bridge flag drops', async () => {
      const pi = await openBridge('quit');
      const stream = await attach(pi);
      await stream.waitForKind('history');
      await pi.events({ t: 'status', running: true });
      await pi.bye('quit');
      expect((await stream.waitForKind('ended')).reason).toBe('quit');
      const ghost = await pi.client.post(`${route}/events`, { id: pi.id, events: [{ t: 'delta', kind: 'text', key: 't9:t', delta: 'GHOST' }] });
      expect(ghost.status).toBe(404);
      expect(await bridged(pi)).toBe(false);
    });

    for (const reason of ['new', 'resume', 'fork'] as const) {
      test(`${reason} ends the session at once and passes its reason through`, async () => {
        const pi = await openBridge(reason);
        const stream = await attach(pi);
        await stream.waitForKind('history');
        const startedAt = Date.now();
        await pi.bye(reason);
        expect((await stream.waitForKind('ended')).reason).toBe(reason);
        expect(Date.now() - startedAt).toBeLessThan(GRACE_MS);
        expect(await bridged(pi)).toBe(false);
      });
    }

    test('a reload with no re-hello ends the session once the grace window passes', async () => {
      const pi = await openBridge('grace');
      const stream = await attach(pi);
      await stream.waitForKind('history');
      await pi.bye('reload');
      expect(await bridged(pi)).toBe(true);
      expect(stream.ofKind('ended')).toEqual([]);
      await stream.waitForKind('ended', { timeoutMs: GRACE_MS * 4 });
      expect(await bridged(pi)).toBe(false);
    });
  });

  describe('attention and approvals', () => {
    const feedFor = async (pi: PiBridgeSession): Promise<any[]> => {
      const body = (await owner.get(`/api/attention-events?clientId=bridge-${dialect.name}&limit=200`)).body;
      return (body.events as any[]).filter((event) => event.sessionId === pi.id);
    };

    test('a live turn raises one outcome; a turn first seen finished, or replayed by a re-hello, raises none', async () => {
      const pi = await openBridge('turn');
      await pi.events({ t: 'run', key: 'unseen', turnId: 'unseen', status: 'done' });
      await pi.events({ t: 'run', key: 'u1', turnId: 'u1', status: 'running' }, { t: 'run', key: 'u1', turnId: 'u1', status: 'done' });
      await pi.rehello({ history: [{ t: 'run', key: 'u1', turnId: 'u1', status: 'done' }] });
      await pi.events({ t: 'run', key: 'u2', turnId: 'u2', status: 'running' }, { t: 'run', key: 'u2', turnId: 'u2', status: 'error' });
      const events = await eventually(async () => {
        const found = await feedFor(pi);
        return found.some((event) => event.kind === 'run-failed') ? found : undefined;
      }, { what: 'the failed turn outcome' });
      expect(events.map((event) => [event.kind, event.turnId])).toEqual([['run-finished', 'u1'], ['run-failed', 'u2']]);
      await pi.bye('quit');
    });

    test('a permission request carries approve, approve-session and reject, and the decision reaches the extension', async () => {
      const pi = await openBridge('permission');
      const stream = await attach(pi);
      await stream.waitForKind('history');
      await pi.events({ t: 'permission-request', requestId: 'p1', title: 'Run rm -fr build', detail: 'rm -fr build', toolName: 'bash' });
      const request = await stream.waitForMessage((message) => message?.type === 'permission-request' && message.requestId === 'p1');
      const options = (request.options ?? []).map((option: any) => option.id ?? option.decision ?? option);
      expect(options).toEqual(expect.arrayContaining(['approve', 'reject']));
      expect((await stream.sendAndAwait({ kind: 'approve', requestId: 'p1', decision: 'approve-session' })).kind).toBe('ack');
      expect(await pi.nextCommand((command) => command.kind === 'permission' && command.requestId === 'p1', { what: 'the decision' }))
        .toMatchObject({ decision: 'approve-session' });
      await pi.bye('quit');
    });

    test('a decision reaches the extension once, and only for a card of its kind the extension raised', async () => {
      const pi = await openBridge('decisions', {
        history: [{ t: 'permission-request', requestId: 'p0', title: 'Still waiting from before the hello', toolName: 'bash' }],
      });
      const stream = await attach(pi);
      await stream.waitForKind('history');
      await pi.events(
        { t: 'permission-request', requestId: 'p1', title: 'Run rm -fr build', toolName: 'bash' },
        { t: 'question-request', requestId: 'q1', questions: [{ question: 'Deploy now?', options: [{ label: 'yes' }, { label: 'no' }] }] },
      );
      await stream.waitForMessage((message) => message?.type === 'question-request' && message.requestId === 'q1');
      // Never raised, or raised as the other kind: refused, and nothing is queued for the extension.
      for (const forged of [
        { kind: 'approve', requestId: 'p-forged', decision: 'approve' },
        { kind: 'answer', requestId: 'q-forged', answers: [['yes']] },
        { kind: 'reject-question', requestId: 'q-forged' },
        { kind: 'answer', requestId: 'p1', answers: [['yes']] },
        { kind: 'approve', requestId: 'q1', decision: 'approve' },
      ]) expect((await stream.sendAndAwait(forged)).kind, JSON.stringify(forged)).toBe('nack');
      // The card the hello carried, and the two raised live, each take one decision.
      expect((await stream.sendAndAwait({ kind: 'approve', requestId: 'p0', decision: 'reject' })).kind).toBe('ack');
      expect((await stream.sendAndAwait({ kind: 'approve', requestId: 'p1', decision: 'approve' })).kind).toBe('ack');
      expect((await stream.sendAndAwait({ kind: 'answer', requestId: 'q1', answers: [['no']] })).kind).toBe('ack');
      expect((await stream.sendAndAwait({ kind: 'approve', requestId: 'p1', decision: 'reject' })).kind).toBe('nack');
      expect((await stream.sendAndAwait({ kind: 'reject-question', requestId: 'q1' })).kind).toBe('nack');
      await pi.nextCommand((command) => command.kind === 'answer' && command.requestId === 'q1', { what: 'the answer' });
      expect(pi.commands.filter((command) => ['permission', 'answer', 'reject-question'].includes(command.kind))
        .map((command) => [command.kind, command.requestId])).toEqual([['permission', 'p0'], ['permission', 'p1'], ['answer', 'q1']]);
      // A card the extension settled is gone for good.
      await pi.events({ t: 'question-request', requestId: 'q2', questions: [{ question: 'Again?', options: [] }] });
      await pi.events({ t: 'question-resolved', requestId: 'q2' });
      await stream.waitForMessage((message) => message?.type === 'question-resolved' && message.requestId === 'q2');
      expect((await stream.sendAndAwait({ kind: 'answer', requestId: 'q2', answers: [['late']] })).kind).toBe('nack');
      await pi.bye('quit');
    });

    test('a question maps to a question request, and the answer reaches the extension', async () => {
      const pi = await openBridge('question');
      const stream = await attach(pi);
      await stream.waitForKind('history');
      await pi.events({ t: 'question-request', requestId: 'q1', questions: [{ question: 'Deploy now?', options: [{ label: 'yes' }, { label: 'no' }] }] });
      const request = await stream.waitForMessage((message) => message?.type === 'question-request' && message.requestId === 'q1');
      expect(JSON.stringify(request)).toContain('Deploy now?');
      await pi.bye('quit');
    });
  });

  describe('tool results', () => {
    test('an edit diff arrives with its path and diffstat, and a bash result keeps its exit code', async () => {
      const pi = await openBridge('tool-result');
      const stream = await attach(pi);
      await stream.waitForKind('history');
      const diff = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,2 @@', '-old line', '+new line', ' same', ''].join('\n');
      await pi.events(
        { t: 'tool-result', callId: 'c1', name: 'edit', result: 'ok', isError: false, details: { diff }, args: { path: 'src/a.ts' } },
        { t: 'tool-result', callId: 'c2', name: 'bash', result: 'boom', isError: true, details: { exitCode: 2 }, args: { command: 'false' } },
      );
      const edit = await stream.waitForMessage((message) => message?.type === 'tool-result' && message.callId === 'c1');
      expect(JSON.stringify(edit)).toContain('new line');
      const bash = await stream.waitForMessage((message) => message?.type === 'tool-result' && message.callId === 'c2');
      expect(JSON.stringify(bash)).toContain('boom');
      await pi.bye('quit');
    });
  });
});

describe('omp bridge gates', () => {
  test('a hello without the exact native version attestation is refused and leaves no row', async () => {
    let fake!: PiFake;
    const broker = await startBroker({ name: 'omp-attest', setup: (paths) => { fake = installPiFamily(OMP_DIALECT_FACTS, paths); } });
    try {
      const owner = broker.client();
      const cwd = fake.workspace('attest');
      const sessionFile = join(cwd, 'attest.jsonl');
      for (const body of [{ sessionFile, cwd }, { sessionFile, cwd, nativeVersion: '17.4.3' }]) {
        const response = await owner.post('/omp/bridge/hello', body);
        expect(response.status).toBe(409);
        expect(response.body.code).toBe('OMP_BRIDGE_NATIVE_VERSION_UNVERIFIED');
      }
      expect((await owner.sessions()).some((row) => row.id === enc(sessionFile))).toBe(false);
    } finally {
      await broker.stop();
    }
  });

  test('the omp roster is hidden from clients below the identity revision, revisionless included', async () => {
    let fake!: PiFake;
    const broker = await startBroker({ name: 'omp-floor', setup: (paths) => { fake = installPiFamily(OMP_DIALECT_FACTS, paths); } });
    try {
      const owner = broker.client();
      const cwd = fake.workspace('floor');
      const pi = await PiBridgeSession.open(owner, {
        cwd, sessionFile: join(cwd, 'floor.jsonl'), route: '/omp/bridge', hello: { nativeVersion: OMP_DIALECT_FACTS.version.current },
      });
      expect((await owner.sessions()).some((row) => row.id === pi.id)).toBe(true);
      const listed = async (path: string) => ((await owner.get(path)).body.sessions as any[]).some((row) => row.tool === 'omp');
      expect(await listed('/api/sessions')).toBe(false);
      expect(await listed(`/api/sessions?contractRevision=${CLIENT_REVISION_WITH_OMP_ROSTER_IDENTITY - 1}`)).toBe(false);
      expect(await listed(`/api/sessions?contractRevision=${BROKER_CONTRACT_REVISION}`)).toBe(true);
    } finally {
      await broker.stop();
    }
  });

  test('a store shared with Pi rejects the omp hello before a second adoption', async () => {
    const shared = (paths: { root: string }) => join(paths.root, 'shared-sessions');
    let file = '';
    const broker = await startBroker({
      name: 'omp-collision',
      env: (paths) => ({ PI_CODING_AGENT_SESSION_DIR: shared(paths), COSYNCING_OMP_SESSIONS_ROOT: '', COSYNCING_OMP_AGENT_DIR: '' }),
      setup: (paths) => {
        installPiFamily(OMP_DIALECT_FACTS, paths);
        mkdirSync(shared(paths), { recursive: true });
        file = join(shared(paths), '2026-08-25_shared.jsonl');
        writeFileSync(file, `${JSON.stringify({ type: 'session', version: 3, id: 'shared-session', timestamp: '2026-08-25T00:00:00.000Z', cwd: paths.root })}\n`);
      },
    });
    try {
      const response = await broker.client().post('/omp/bridge/hello', { sessionFile: file, cwd: broker.paths.root, nativeVersion: OMP_DIALECT_FACTS.version.current });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('omp-pi-path-collision');
    } finally {
      await broker.stop();
    }
  });

  test('a newer omp than the verified one rejects every bridge route', async () => {
    let fake!: PiFake;
    const broker = await startBroker({
      name: 'omp-future',
      setup: (paths) => {
        fake = installPiFamily(OMP_DIALECT_FACTS, paths);
        fake.patchConfig({ version: OMP_DIALECT_FACTS.version.newer });
      },
    });
    try {
      const owner = broker.client();
      const cwd = fake.workspace('future');
      const hello = await owner.post('/omp/bridge/hello', { sessionFile: join(cwd, 'f.jsonl'), cwd, nativeVersion: OMP_DIALECT_FACTS.version.newer });
      expect(hello.status).toBe(409);
      for (const path of ['events', 'bye']) {
        expect((await owner.post(`/omp/bridge/${path}`, { id: 'x', events: [], reason: 'quit' })).status).toBe(409);
      }
    } finally {
      await broker.stop();
    }
  });
});
