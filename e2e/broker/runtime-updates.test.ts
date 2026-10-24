/**
 * Agent runtime freshness: the broker notices when a long-lived agent runtime (the
 * Codex app-server daemon, the broker's own `opencode serve`) runs older code or older
 * configuration than what is installed, tells the user, restarts it by itself only
 * when that interrupts nothing, and restarts it on a confirmed request otherwise.
 *
 * The runtimes are fakes compiled to real executables in the fixture's `bin`, so the
 * broker inspects real processes: a restart is a process that exits and another that
 * starts, both recorded in the fake's ledger. The broker can only ever reach processes
 * the fixture started; teardown stops those by executable path.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reserveLoopbackFixturePort } from '../../packages/typescript/broker/test/helpers/isolated-broker-fixture.ts';
import { type Broker, type BrokerClient, eventually, startBroker } from '../harness/index.ts';
import { type FakeCodex, installFakeCodex } from '../harness/fakes/codex.ts';
import { pathWithoutHostTools } from '../harness/fakes/executable.ts';
import { type FakeOpencode, installFakeOpencode, opencodeServeEnvironment } from '../harness/fakes/opencode.ts';

const RESTART_CONFIRMED = { confirmRestart: true };

/** Only the fakes: never the developer's own `codex` or `opencode` beside Bun. */
function hostToolFreePath(bin: string): Record<string, string> {
  const path = pathWithoutHostTools(bin);
  return path ? { PATH: path } : {};
}

async function updates(client: BrokerClient, options: { fresh?: boolean } = {}): Promise<Record<string, any>> {
  const response = await client.get(`/api/agent-runtime-updates${options.fresh ? '?fresh=1' : ''}`);
  expect(response.status).toBe(200);
  return Object.fromEntries(response.body.updates.map((status: any) => [status.agent, status]));
}

async function runtimeEvents(client: BrokerClient, agent: string): Promise<any[]> {
  const page = await client.get('/api/attention-events?clientId=e2e-runtime&limit=200');
  expect(page.status).toBe(200);
  return page.body.events.filter((event: any) => event.kind === 'runtime-update-ready' && event.agent === agent);
}

describe('the Codex daemon', () => {
  let broker: Broker;
  let client: BrokerClient;
  let codex: FakeCodex;
  let claimedSocket: string;

  beforeAll(async () => {
    broker = await startBroker({
      name: 'runtime-codex',
      setup: (paths) => {
        claimedSocket = join(paths.root, 'claimed-control.sock');
        writeFileSync(claimedSocket, 'generation 1');
        // A daemon answering for 0.142.5 while 0.144.1 is installed, with no process or
        // receipt behind it: the shape every daemon had before the CLI recorded one.
        codex = installFakeCodex(paths, {
          mode: 'pretend',
          installed: '0.144.1',
          claimedRunning: '0.142.5',
          claimedSocket,
        });
      },
      env: (paths) => ({
        ...hostToolFreePath(paths.bin),
        CODEX_HOME: join(paths.home, '.codex'),
        // Restart everything must never relaunch the broker under test.
        COSYNCING_RESTART_DRY_RUN: '1',
        // A plain status read answers from the last probe, so a test can count probes.
        COSYNCING_RUNTIME_UPDATE_STATUS_TTL_MS: '600000',
        // Only the startup check and the policy route run the automatic restart here.
        COSYNCING_RUNTIME_UPDATE_POLL_MS: '3600000',
      }),
    });
    client = broker.client();
  });

  afterAll(async () => {
    await broker?.stop({ keepState: true });
    await codex?.cleanup();
    await broker?.stop();
  });

  test('a daemon older than the installed CLI is pending, and stays put while its threads cannot be read', async () => {
    const codexStatus = (await updates(client)).codex;
    expect(codexStatus).toMatchObject({
      agent: 'codex',
      displayName: 'Codex',
      runtimeKind: 'daemon',
      managed: true,
      state: 'pending',
      updateAvailable: true,
      autoRestartReady: false,
      pendingChanges: ['binary-version'],
      installedVersion: '0.144.1',
      runningVersion: '0.142.5',
    });
    expect(codexStatus.detail).toMatch(/Loaded-thread safety probe failed/);
    expect(codexStatus.restartWarning).toMatch(/Remote terminals will disconnect/);

    // The user is told, once, with a way to the runtime settings.
    const events = await eventually(async () => {
      const found = await runtimeEvents(client, 'codex');
      return found.length > 0 ? found : undefined;
    }, { what: 'the Codex update attention event' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      state: 'active',
      title: 'Managed runtime update ready',
      action: { kind: 'open-runtime-settings', agent: 'codex' },
    });

    // A status read answers from the last probe; asking for a fresh one probes again.
    const since = codex.ledger().length;
    await updates(client);
    await updates(client);
    expect(codex.daemonCommands(since)).toEqual([]);
    await updates(client, { fresh: true });
    expect(codex.daemonCommands(since)).toEqual(['version']);
  });

  test('the update policy defaults to when-detached, refuses anything else, and a damaged value reads as the default', async () => {
    expect((await client.get('/api/agent-runtime-update-policy')).body.codexUpdatePolicy).toBe('when-detached');
    const invalid = await client.post('/api/agent-runtime-update-policy', { codexUpdatePolicy: 'when-convenient' });
    expect(invalid.status).toBe(400);
    const saved = await client.post('/api/agent-runtime-update-policy', { codexUpdatePolicy: 'when-idle' });
    expect(saved.status).toBe(200);
    expect(saved.body.codexUpdatePolicy).toBe('when-idle');
    expect(saved.body.update).toMatchObject({ agent: 'codex', state: 'pending', autoRestartReady: false });
    expect((await client.get('/api/agent-runtime-update-policy')).body.codexUpdatePolicy).toBe('when-idle');

    writeFileSync(join(broker.paths.cosyncingHome, 'setup-state.json'), JSON.stringify({ codexUpdatePolicy: 'surprise-me' }));
    expect((await client.get('/api/agent-runtime-update-policy')).body.codexUpdatePolicy).toBe('when-detached');
  });

  test('a restart needs confirmation, and without a verified PID receipt nothing is signalled or started', async () => {
    const since = codex.ledger().length;
    expect((await client.post('/api/agent-runtime-updates/codex/restart', { confirmRestart: false })).status).toBe(400);
    const refused = await client.post('/api/agent-runtime-updates/codex/restart', RESTART_CONFIRMED);
    expect(refused.status).toBe(502);
    expect(refused.body.error).toMatch(/without a verified daemon PID receipt/);
    expect((await client.post('/api/agent-runtime-updates/nobody/restart', RESTART_CONFIRMED)).status).toBe(404);

    // Restart everything reports each runtime on its own.
    expect((await client.post('/api/broker/restart-all', { confirmRestart: false })).status).toBe(400);
    const everything = await client.post('/api/broker/restart-all', RESTART_CONFIRMED);
    expect(everything.status).toBe(200);
    expect(everything.body).toMatchObject({
      ok: false,
      partialFailure: true,
      components: {
        codex: { ok: false },
        opencode: { strategy: 'broker-relaunch', restartsWithBroker: false },
        broker: { scheduled: false, dryRun: true },
      },
    });
    expect(everything.body.components.codex.error).toMatch(/without a verified daemon PID receipt/);
    expect(everything.body.message).not.toContain('Managed OpenCode');

    // A daemon that is not running is left stopped.
    codex.configure({ claimedStopped: true });
    const stopped = await client.post('/api/broker/restart-all', RESTART_CONFIRMED);
    expect(stopped.body.components.codex).toMatchObject({ ok: true, skipped: true });
    expect(stopped.body.components.codex.reason).toMatch(/not running/);
    codex.configure({ claimedStopped: false });

    expect(codex.daemonCommands(since).filter((command) => command !== 'version')).toEqual([]);
  });

  test('a legacy app server the daemon command does not manage is named, and gets no lifecycle command', async () => {
    codex.configure({ mode: 'unmanaged' });
    const since = codex.ledger().length;
    const refused = await client.post('/api/agent-runtime-updates/codex/restart', RESTART_CONFIRMED);
    expect(refused.status).toBe(502);
    expect(refused.body.error).toMatch(/not managed by the Codex daemon command/);
    expect(codex.daemonCommands(since).filter((command) => command !== 'version')).toEqual([]);
    codex.configure({ mode: 'pretend' });
  });

  test('an edit to the Codex configuration or an agent definition makes the daemon restart-ready until a new daemon starts', async () => {
    codex.configure({ claimedRunning: '0.144.1' });
    expect((await updates(client, { fresh: true })).codex.state).toBe('current');

    const config = join(codex.codexHome, 'config.toml');
    writeFileSync(config, 'model = "config-only-drift"\n');
    const drifted = (await updates(client, { fresh: true })).codex;
    expect(drifted).toMatchObject({ state: 'pending', pendingChanges: ['configuration'], runningVersion: '0.144.1', installedVersion: '0.144.1' });
    const event = await eventually(async () =>
      (await runtimeEvents(client, 'codex')).find((candidate) => candidate.state === 'active'
        && candidate.title === 'Managed runtime restart ready'), { what: 'a restart-ready event' });
    expect(event.summary).toMatch(/configuration changed/);

    rmSync(config);
    expect((await updates(client, { fresh: true })).codex.state).toBe('current');

    mkdirSync(join(codex.codexHome, 'agents'), { recursive: true });
    writeFileSync(join(codex.codexHome, 'agents', 'reviewer.toml'), 'name = "reviewer"\n');
    expect((await updates(client, { fresh: true })).codex).toMatchObject({ state: 'pending', pendingChanges: ['configuration'] });

    // A new daemon generation read the definitions when it started.
    rmSync(claimedSocket);
    writeFileSync(claimedSocket, 'generation 2');
    expect((await updates(client, { fresh: true })).codex.state).toBe('current');
  });

  describe('a managed daemon', () => {
    let first: { pid: number; version: string };

    test('waits while a thread works, and when-idle restarts it by itself once every thread is idle', async () => {
      codex.configure({ mode: 'managed', installed: '0.142.5', threads: [{ id: 'thread-busy', status: 'working' }] });
      first = await codex.startDaemon(broker.env);
      codex.configure({ installed: '0.144.1' });
      const since = codex.ledger().length;

      const blocked = (await updates(client, { fresh: true })).codex;
      expect(blocked).toMatchObject({
        state: 'pending',
        managed: true,
        autoRestartReady: false,
        installedVersion: '0.144.1',
        runningVersion: '0.142.5',
        blockers: 1,
        blockerComposition: { idle: 0, working: 1, needsInput: 0, unknown: 0 },
        blockerDetails: [{ id: 'thread-busy', status: 'working' }],
      });

      // Choosing a policy re-runs the automatic check at once; a working thread holds it.
      const working = await client.post('/api/agent-runtime-update-policy', { codexUpdatePolicy: 'when-idle' });
      expect(working.body.update).toMatchObject({ state: 'pending', autoRestartReady: false });
      codex.configure({ threads: [{ id: 'thread-busy', status: 'needs-input' }] });
      const waiting = await client.post('/api/agent-runtime-update-policy', { codexUpdatePolicy: 'when-idle' });
      expect(waiting.body.update).toMatchObject({ autoRestartReady: false, blockerComposition: { needsInput: 1 } });

      // A thread whose state cannot be read blocks like a working one.
      codex.configure({ threads: [{ id: 'thread-busy', status: 'idle' }, { id: 'thread-gone', status: 'unreadable' }] });
      const unreadable = await client.post('/api/agent-runtime-update-policy', { codexUpdatePolicy: 'when-idle' });
      expect(unreadable.body.update).toMatchObject({ autoRestartReady: false, blockerComposition: { idle: 1, unknown: 1 } });
      expect(unreadable.body.update.blockerDetails).toContainEqual(expect.objectContaining({ id: 'thread-gone', status: 'unknown' }));

      // Idle, but when-detached waits for the daemon to hold no thread at all.
      codex.configure({ threads: [{ id: 'thread-busy', status: 'idle' }] });
      const detached = await client.post('/api/agent-runtime-update-policy', { codexUpdatePolicy: 'when-detached' });
      expect(detached.body.update).toMatchObject({ state: 'pending', autoRestartReady: false });
      expect(codex.isAlive(first.pid)).toBe(true);
      expect(codex.daemonCommands(since).filter((command) => command !== 'version')).toEqual([]);

      const restarted = await client.post('/api/agent-runtime-update-policy', { codexUpdatePolicy: 'when-idle' });
      expect(restarted.body.update).toMatchObject({ state: 'current', installedVersion: '0.144.1', runningVersion: '0.144.1' });
      expect(codex.isAlive(first.pid)).toBe(false);
      expect(codex.runningDaemon()).toMatchObject({ version: '0.144.1' });
      // The broker stopped the daemon it had verified itself and started its replacement;
      // the native stop/restart commands, which follow the receipt on their own, were never used.
      expect(codex.ledger().some((entry) => entry.kind === 'daemon-sigterm' && entry.pid === first.pid)).toBe(true);
      expect(codex.daemonCommands(since).filter((command) => command !== 'version')).toEqual(['start']);
      await eventually(async () => (await runtimeEvents(client, 'codex')).every((event) => event.state === 'resolved'),
        { what: 'the Codex update event to resolve' });
    });

    test('a confirmed restart does not wait for a working thread', async () => {
      const before = codex.runningDaemon()!;
      codex.configure({ installed: '0.145.0', threads: [{ id: 'thread-busy', status: 'working' }] });
      expect((await updates(client, { fresh: true })).codex).toMatchObject({ state: 'pending', autoRestartReady: false });
      const restarted = await client.post('/api/agent-runtime-updates/codex/restart', RESTART_CONFIRMED);
      expect(restarted.status).toBe(200);
      expect(restarted.body.update).toMatchObject({ state: 'current', runningVersion: '0.145.0' });
      expect(codex.isAlive(before.pid)).toBe(false);
      expect(codex.runningDaemon()).toMatchObject({ version: '0.145.0' });
    });

    test('a receipt naming another process generation proves nothing: the restart is refused and the daemon left running', async () => {
      const running = codex.runningDaemon()!;
      const receipt = readFileSync(codex.receiptPath, 'utf8');
      const since = codex.ledger().length;
      try {
        const forged = `${codex.receiptPath}.forged`;
        writeFileSync(forged, JSON.stringify({ ...JSON.parse(receipt), processStartTime: 'Thu Jan  1 00:00:00 1970' }), { mode: 0o600 });
        renameSync(forged, codex.receiptPath);
        const refused = await client.post('/api/agent-runtime-updates/codex/restart', RESTART_CONFIRMED);
        expect(refused.status).toBe(502);
        expect(refused.body.error).toMatch(/without a verified daemon PID receipt/);
      } finally {
        const pending = `${codex.receiptPath}.restore`;
        writeFileSync(pending, receipt, { mode: 0o600 });
        renameSync(pending, codex.receiptPath);
      }
      expect(codex.isAlive(running.pid)).toBe(true);
      expect(codex.ledger().slice(since).some((entry) => entry.kind === 'daemon-sigterm')).toBe(false);
    });

    test('a daemon that stopped answering is never restarted by itself, and a confirmed restart recovers it', async () => {
      const stuck = codex.runningDaemon()!;
      codex.configure({ silentPid: stuck.pid, threads: [] });
      const status = (await updates(client, { fresh: true })).codex;
      expect(status).toMatchObject({ state: 'error', managed: true, updateAvailable: true, autoRestartReady: false });
      expect(status.detail).toMatch(/still running but its control endpoint is unavailable/);
      const automatic = await client.post('/api/agent-runtime-update-policy', { codexUpdatePolicy: 'when-idle' });
      expect(automatic.body.update).toMatchObject({ state: 'error', autoRestartReady: false });
      expect(codex.isAlive(stuck.pid)).toBe(true);

      const recovered = await client.post('/api/agent-runtime-updates/codex/restart', RESTART_CONFIRMED);
      expect(recovered.status).toBe(200);
      expect(recovered.body.update).toMatchObject({ state: 'current', runningVersion: '0.145.0' });
      expect(codex.isAlive(stuck.pid)).toBe(false);
      codex.configure({ silentPid: undefined });
    });

    test('Restart everything restarts a running daemon even when nothing is pending', async () => {
      const running = codex.runningDaemon()!;
      codex.configure({ threads: [] });
      const everything = await client.post('/api/broker/restart-all', RESTART_CONFIRMED);
      expect(everything.status).toBe(200);
      expect(everything.body).toMatchObject({
        ok: true,
        partialFailure: false,
        components: { codex: { ok: true }, broker: { scheduled: false, dryRun: true } },
      });
      expect(everything.body.message).toMatch(/^Managed Codex restarted/);
      expect(codex.isAlive(running.pid)).toBe(false);
      expect(codex.runningDaemon()?.pid).not.toBe(running.pid);
    });

    test('a failed restart says why and keeps the diagnostics, and the next confirmed restart recovers', async () => {
      codex.configure({ installed: '0.146.0', startFails: true });
      const failed = await client.post('/api/agent-runtime-updates/codex/restart', RESTART_CONFIRMED);
      expect(failed.status).toBe(502);
      expect(failed.body.error).toBe('fake codex: the daemon could not start');
      const status = (await updates(client)).codex;
      expect(status).toMatchObject({
        state: 'error',
        autoRestartReady: false,
        installedVersion: '0.146.0',
        runningVersion: '0.145.0',
        detail: 'fake codex: the daemon could not start',
      });

      // The old daemon was stopped before the start failed; a confirmed restart starts one.
      expect(codex.runningDaemon()).toBeUndefined();
      codex.configure({ startFails: false });
      const recovered = await client.post('/api/agent-runtime-updates/codex/restart', RESTART_CONFIRMED);
      expect(recovered.status).toBe(200);
      expect(recovered.body.update).toMatchObject({ state: 'current', runningVersion: '0.146.0' });
    });

    test('a replacement that dies right after starting is a failed restart, not a success', async () => {
      codex.configure({ installed: '0.147.0', dieAfterFirstAnswer: true });
      const failed = await client.post('/api/agent-runtime-updates/codex/restart', RESTART_CONFIRMED);
      expect(failed.status).toBe(502);
      expect(failed.body.error).toMatch(/failed verification/);
      expect((await updates(client)).codex.state).toBe('error');
      expect(codex.runningDaemon()).toBeUndefined();

      // The dead daemon's receipt is still there; it names no live process, so a confirmed
      // restart starts a new daemon instead of refusing.
      expect(existsSync(codex.receiptPath)).toBe(true);
      codex.configure({ dieAfterFirstAnswer: false });
      const recovered = await client.post('/api/agent-runtime-updates/codex/restart', RESTART_CONFIRMED);
      expect(recovered.status).toBe(200);
      expect(recovered.body.update).toMatchObject({ state: 'current', runningVersion: '0.147.0' });
    });
  });
});

describe('the broker-owned OpenCode serve', () => {
  let broker: Broker;
  let client: BrokerClient;
  let opencode: FakeOpencode;
  const SESSION = 'ses_e2e_runtime';

  beforeAll(async () => {
    const lease = await reserveLoopbackFixturePort();
    await lease.release();
    broker = await startBroker({
      name: 'runtime-opencode',
      setup: (paths) => {
        opencode = installFakeOpencode(paths, {
          installed: '1.1.0',
          sessions: [{ id: SESSION, title: 'Busy refactor', directory: paths.home, busy: true }],
        });
      },
      env: (paths) => ({
        ...hostToolFreePath(paths.bin),
        ...opencodeServeEnvironment(lease.port),
        COSYNCING_RESTART_DRY_RUN: '1',
        COSYNCING_RUNTIME_UPDATE_STATUS_TTL_MS: '600000',
        COSYNCING_TEST_RUNTIME_UPDATE_POLL_MS: '400',
        COSYNCING_TEST_OPENCODE_CONFIG_WATCH_MS: '100',
        COSYNCING_OPENCODE_SERVE_RESTART_MAX_DEFER_MS: '1',
      }),
    });
    client = broker.client();
  });

  afterAll(async () => {
    await broker?.stop({ keepState: true });
    opencode?.cleanup();
    await broker?.stop();
  });

  /** The session as the roster shows it, once its activity is `status`. */
  async function sessionActivity(status: string): Promise<void> {
    await eventually(async () => (await client.sessions({ refresh: true }))
      .some((row) => row.id === SESSION && row.status === status), { what: `the OpenCode session to be ${status}` });
  }

  /** The stored status after the next automatic check that starts later than `after`. */
  async function nextCheck(after: number): Promise<any> {
    return eventually(async () => {
      const status = (await updates(client)).opencode;
      return status.checkedAt > after ? status : undefined;
    }, { what: 'the next automatic runtime check' });
  }

  test('the broker launches and owns a serve of the installed version', async () => {
    const serve = await eventually(() => opencode.serves()[0], { what: 'the managed serve to start' });
    expect(serve.version).toBe('1.1.0');
    expect((await updates(client, { fresh: true })).opencode).toMatchObject({
      agent: 'opencode',
      displayName: 'OpenCode',
      runtimeKind: 'serve',
      managed: true,
      state: 'current',
      installedVersion: '1.1.0',
      runningVersion: '1.1.0',
    });

    // Restart everything leaves the serve to the broker's own relaunch (a dry run here).
    const everything = await client.post('/api/broker/restart-all', RESTART_CONFIRMED);
    expect(everything.body.components).toMatchObject({
      codex: { ok: true, skipped: true },
      opencode: { strategy: 'broker-relaunch', restartsWithBroker: true },
      broker: { dryRun: true },
    });
    expect(everything.body.message).toContain('Managed OpenCode will be replaced with the broker.');
    expect(opencode.serves()).toHaveLength(1);
  });

  test('an upgrade waits while a session works, and the first check after it goes idle restarts the serve', async () => {
    const [serve] = opencode.serves();
    await sessionActivity('working');
    opencode.configure({ installed: '1.2.0' });

    const waiting = await nextCheck(Date.now());
    expect(waiting).toMatchObject({
      state: 'pending',
      updateAvailable: true,
      autoRestartReady: false,
      installedVersion: '1.2.0',
      runningVersion: '1.1.0',
      detail: 'A managed OpenCode session is working or needs input.',
    });
    // Another automatic check came and went; the busy serve is still the original.
    expect(await nextCheck(waiting.checkedAt)).toMatchObject({ state: 'pending', autoRestartReady: false });
    expect(opencode.serves()).toHaveLength(1);
    expect(opencode.isAlive(serve!.pid)).toBe(true);

    opencode.configure({ sessions: [{ id: SESSION, title: 'Busy refactor', directory: broker.paths.home, busy: false }] });
    await sessionActivity('idle');
    const restarted = await eventually(async () => {
      const status = (await updates(client)).opencode;
      return status.state === 'current' && status.runningVersion === '1.2.0' ? status : undefined;
    }, { what: 'the serve to be restarted on 1.2.0' });
    expect(restarted).toMatchObject({ managed: true, installedVersion: '1.2.0' });
    expect(opencode.serves().map((entry) => entry.version)).toEqual(['1.1.0', '1.2.0']);
    await eventually(() => !opencode.isAlive(serve!.pid), { what: 'the old serve to exit' });
  });

  test('a brief V1 reinstall gap leaves the idle managed serve running', async () => {
    await sessionActivity('idle');
    const serve = opencode.serves().at(-1)!;
    const count = opencode.serves().length;
    const outputMark = broker.output().length;
    const hidden = `${opencode.executable}.reinstalling`;
    renameSync(opencode.executable, hidden);
    try {
      // Three automatic 400ms checks span roughly one second without a fixed sleep,
      // and exercise multiple 100ms config-watch ticks while the executable is absent.
      let absent = await nextCheck(Date.now());
      expect(absent).toMatchObject({ state: 'unavailable', updateAvailable: false });
      for (let tick = 0; tick < 2; tick += 1) {
        absent = await nextCheck(absent.checkedAt);
        expect(absent).toMatchObject({ state: 'unavailable', updateAvailable: false });
      }
      expect(opencode.isAlive(serve.pid)).toBe(true);
    } finally {
      renameSync(hidden, opencode.executable);
    }
    const restored = await nextCheck(Date.now());
    expect(restored).toMatchObject({ managed: true, state: 'current', installedVersion: serve.version, runningVersion: serve.version });
    expect(opencode.isAlive(serve.pid)).toBe(true);
    expect(opencode.serves()).toHaveLength(count);
    expect(broker.output().slice(outputMark)).not.toContain('retiring the idle managed serve');
  });

  test('a confirmed restart replaces the serve at once, even while a session works', async () => {
    const previous = opencode.serves().at(-1)!;
    opencode.configure({ sessions: [{ id: SESSION, title: 'Busy refactor', directory: broker.paths.home, busy: true }] });
    await sessionActivity('working');
    opencode.configure({ installed: '1.3.0' });
    const restarted = await client.post('/api/agent-runtime-updates/opencode/restart', RESTART_CONFIRMED);
    expect(restarted.status).toBe(200);
    expect(restarted.body.update).toMatchObject({ state: 'current', runningVersion: '1.3.0', installedVersion: '1.3.0' });
    expect(opencode.serves().map((entry) => entry.version)).toEqual(['1.1.0', '1.2.0', '1.3.0']);
    expect(opencode.isAlive(previous.pid)).toBe(false);
  });

  test('a cross-major upgrade stays unavailable while busy, refuses a confirmed restart, then retires at idle', async () => {
    const serve = opencode.serves().at(-1)!;
    const count = opencode.serves().length;
    const ownership = join(broker.paths.cosyncingHome, 'opencode-serve-owner.json');
    expect(existsSync(ownership)).toBe(true);
    await sessionActivity('working');
    opencode.configure({ installed: '2.1.4' });
    const waiting = await nextCheck(Date.now());
    expect(waiting).toMatchObject({ managed: false, state: 'unavailable', updateAvailable: false, autoRestartReady: false });
    expect(waiting.detail).toMatch(/generation/);
    // A config edit must not enter the old restart path during this transition either.
    const config = join(broker.paths.root, 'xdg-config', 'opencode', 'opencode.json');
    mkdirSync(join(config, '..'), { recursive: true });
    try {
      writeFileSync(config, '{}');
      const newer = new Date(Date.now() + 2_000);
      utimesSync(config, newer, newer);
      expect((await nextCheck(waiting.checkedAt)).state).toBe('unavailable');
      const refused = await client.post('/api/agent-runtime-updates/opencode/restart', RESTART_CONFIRMED);
      expect(refused.status).toBe(502);
      expect(refused.body.error).toMatch(/generation/);
      expect(opencode.isAlive(serve.pid)).toBe(true);
      expect(opencode.serves()).toHaveLength(count);
      expect(opencode.ledger().some((entry) => entry.kind === 'serve-exit' && entry.pid === serve.pid)).toBe(false);

      opencode.configure({ sessions: [{ id: SESSION, title: 'Finished refactor', directory: broker.paths.home, busy: false }] });
      await sessionActivity('idle');
      await eventually(() => !opencode.isAlive(serve.pid), { what: 'the V1 serve to retire after the turn finishes' });
      await eventually(async () => (await updates(client, { fresh: true })).opencode.state === 'unavailable', { what: 'unavailable after retirement' });
      expect(opencode.serves()).toHaveLength(count);
      expect(opencode.serves().every((entry) => entry.version.startsWith('1.'))).toBe(true);
      expect(existsSync(ownership)).toBe(false);
    } finally {
      rmSync(config, { force: true });
    }
  });

  test('an idle cross-major upgrade retires without offering or launching a restart', async () => {
    opencode.configure({ installed: '1.17.19', sessions: [] });
    await broker.restart();
    const serve = await eventually(() => opencode.serves().find((entry) => entry.version === '1.17.19'), { what: 'a fresh V1 serve' });
    await eventually(() => broker.output().includes('managed opencode serve ready'), { what: 'ownership to be recorded' });
    const count = opencode.serves().length;
    opencode.configure({ installed: '2.1.4' });
    await eventually(() => !opencode.isAlive(serve.pid), { what: 'idle V1 retirement' });
    expect((await updates(client, { fresh: true })).opencode).toMatchObject({ managed: false, state: 'unavailable', updateAvailable: false, autoRestartReady: false });
    expect(opencode.serves()).toHaveLength(count);
  });
});
