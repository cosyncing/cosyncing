/**
 * Scheduled sends: the app schedules a prompt for an existing session, or a new session with its
 * first prompt, and the broker sends it when its time comes, exactly as if it had been typed.
 *
 * Time is the broker's test clock (`COSYNCING_TEST_CLOCK_FILE`): a test moves it forward and the
 * broker runs the pass a timer due at the new time would have run. Existing sessions are Pi bridge
 * sessions, so "the agent got it" is a queued command the extension receives; new sessions are
 * Claude sessions started through a fake `claude` that records each launch's argv and stdin.
 *
 * Proving that something did not fire is done with a sentinel schedule that fires at the same
 * pass or later; the row that must not fire then shows no fire time.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Broker, type BrokerClient, eventually, startBroker } from '../harness/index.ts';
import { type FakeClaudeCli, installFakeClaudeCli, promptTexts } from '../harness/fakes/claude-cli.ts';
import { CATALOG_PROVIDER, type FakeOpenCodeCatalog, startFakeOpenCodeCatalog } from '../harness/fakes/opencode-catalog.ts';
import { PiBridgeSession } from '../harness/fakes/pi-bridge-driver.ts';
import { HOUR, MINUTE, TestClock } from '../harness/fakes/test-clock.ts';

const OPUS_HIGH = { providerID: 'anthropic', modelID: 'opus', reasoningEffort: 'high' };

class Schedules {
  readonly #broker: Broker;
  readonly #sessions: PiBridgeSession[] = [];

  constructor(broker: Broker) {
    this.#broker = broker;
  }

  get client(): BrokerClient {
    return this.#broker.client();
  }

  async session(name: string): Promise<PiBridgeSession> {
    const cwd = join(this.#broker.paths.root, 'work', name);
    mkdirSync(cwd, { recursive: true });
    const pi = await PiBridgeSession.open(this.client, { cwd, title: name });
    this.#sessions.push(pi);
    return pi;
  }

  async reannounce(): Promise<void> {
    for (const pi of this.#sessions) await pi.rehello();
  }

  async create(body: Record<string, unknown>): Promise<any> {
    const response = await this.client.post('/api/schedules', body);
    if (response.status !== 201) throw new Error(`schedule refused (${response.status}): ${response.text.slice(0, 300)}`);
    return response.body.schedule;
  }

  message(pi: PiBridgeSession, text: string, at: number, extra: Record<string, unknown> = {}): Promise<any> {
    return this.create({ kind: 'message', tool: 'pi', sessionId: pi.id, sessionTitle: pi.title, text, at, ...extra });
  }

  newClaudeSession(text: string, at: number | undefined, extra: Record<string, unknown> = {}): Promise<any> {
    return this.create({ kind: 'new-session', tool: 'claude', directory: this.#broker.paths.home, text, ...(at ? { at } : {}), ...extra });
  }

  async list(): Promise<any[]> {
    const response = await this.client.get('/api/schedules');
    expect(response.status).toBe(200);
    return response.body.schedules;
  }

  async get(id: string): Promise<any> {
    return (await this.list()).find((schedule) => schedule.id === id);
  }

  waitFor(id: string, predicate: (schedule: any) => boolean, what: string): Promise<any> {
    return eventually(async () => {
      const schedule = await this.get(id);
      return schedule && predicate(schedule) ? schedule : undefined;
    }, { what });
  }

  patch(id: string, body: Record<string, unknown>) {
    return this.client.request('PATCH', `/api/schedules/${encodeURIComponent(id)}`, body);
  }

  action(id: string, action: string, expectedRevision: number) {
    return this.client.post(`/api/schedules/${encodeURIComponent(id)}/actions`, { action, expectedRevision });
  }

  remove(id: string) {
    return this.client.delete(`/api/schedules/${encodeURIComponent(id)}`);
  }

  /** Cancel every live row, so the next test's clock moves fire nothing of this one's. */
  async cancelLive(): Promise<void> {
    for (const schedule of await this.list()) {
      if (schedule.state === 'scheduled' || schedule.state === 'paused') await this.remove(schedule.id);
    }
  }

  async attention(kind: string, sessionId?: string): Promise<any[]> {
    const page = await this.client.get('/api/attention-events?clientId=e2e-schedules&limit=200');
    expect(page.status).toBe(200);
    return page.body.events.filter((event: any) => event.kind === kind && (sessionId === undefined || event.sessionId === sessionId));
  }
}

/** The prompts a Pi session's agent has been sent, once `text` is among them. */
async function promptsThrough(pi: PiBridgeSession, text: string): Promise<string[]> {
  await pi.nextCommand((command) => command.kind === 'prompt' && command.text === text, { what: `"${text}" at the agent` });
  return pi.commands.filter((command) => command.kind === 'prompt').map((command) => String(command.text));
}

/** Every prompt the fake Claude has been given, across launches, once `text` is among them. */
async function claudePromptsThrough(claude: FakeClaudeCli, text: string): Promise<string[]> {
  return eventually(() => {
    const prompts = claude.launches().flatMap(promptTexts);
    return prompts.includes(text) ? prompts : undefined;
  }, { what: `"${text}" at Claude` });
}

describe('scheduled sends', () => {
  let broker: Broker;
  let clock: TestClock;
  let claude: FakeClaudeCli;
  let opencode: FakeOpenCodeCatalog;
  let world: Schedules;

  beforeAll(async () => {
    broker = await startBroker({
      name: 'schedules',
      setup: (paths) => {
        claude = installFakeClaudeCli(paths.bin);
        opencode = startFakeOpenCodeCatalog(paths.home);
      },
      env: (paths) => ({
        ...(clock = new TestClock(paths.root)).env,
        COSYNCING_CLAUDE_BIN: claude.path,
        OPENCODE_URL: opencode.url,
      }),
    });
    world = new Schedules(broker);
  });
  afterEach(async () => {
    await world?.cancelLive();
  });
  afterAll(async () => {
    await broker?.stop();
    opencode?.stop();
  });

  test('a scheduled message reaches the agent when its time comes, not before, and the user is told once', async () => {
    const pi = await world.session('on-time');
    const later = await world.message(pi, 'at ten minutes', clock.now() + 10 * MINUTE);
    const sooner = await world.message(pi, 'at five minutes', clock.now() + 5 * MINUTE);
    expect(later).toMatchObject({ kind: 'message', state: 'scheduled', revision: 1, text: 'at ten minutes' });

    clock.advance(5 * MINUTE);
    expect(await promptsThrough(pi, 'at five minutes')).toEqual(['at five minutes']);
    await world.waitFor(sooner.id, (row) => row.state === 'delivered', 'the five-minute row to be delivered');
    expect(await world.get(later.id)).toMatchObject({ state: 'scheduled', revision: 1 });
    expect((await world.get(later.id)).lastFiredAt).toBeUndefined();

    clock.advance(5 * MINUTE);
    expect(await promptsThrough(pi, 'at ten minutes')).toEqual(['at five minutes', 'at ten minutes']);
    const delivered = await world.waitFor(later.id, (row) => row.state === 'delivered', 'the ten-minute row to be delivered');
    expect(delivered.lastOutcome).toBe('delivered');
    expect(delivered.lastFiredAt).toBeGreaterThanOrEqual(later.at);
    expect(delivered.revision).toBeGreaterThan(later.revision);
    const told = await eventually(async () => {
      const events = await world.attention('scheduled-send', pi.id);
      return events.length === 2 ? events : undefined;
    }, { what: 'one notice per delivered schedule' });
    expect(told.map((event) => event.title)).toEqual(['Scheduled message delivered', 'Scheduled message delivered']);
  });

  test('a large schedule list negotiates gzip while creation retains its 201 response', async () => {
    const pi = await world.session('compressed-list');
    const created = await world.client.post('/api/schedules', {
      kind: 'message', tool: 'pi', sessionId: pi.id,
      text: 'A scheduled prompt with repeated context. '.repeat(40), at: clock.now() + HOUR,
    }, { 'accept-encoding': 'gzip' });
    expect(created.status).toBe(201);
    expect(created.headers.get('content-encoding')).toBeNull();
    const identity = await world.client.get('/api/schedules', { 'accept-encoding': 'identity' });
    expect(Buffer.byteLength(identity.text)).toBeGreaterThanOrEqual(1024);
    expect(identity.headers.get('content-encoding')).toBeNull();
    const compressed = await world.client.get('/api/schedules', { 'accept-encoding': 'gzip' });
    expect(compressed.headers.get('content-encoding')).toBe('gzip');
    expect(compressed.headers.get('vary')?.toLowerCase()).toContain('accept-encoding');
    expect(compressed.body).toEqual(identity.body);
    expect(compressed.body.schedules.some((row: any) => row.id === created.body.schedule.id)).toBe(true);
  });

  test('a schedule due in a second fires on time by itself, with no clock moved', async () => {
    const pi = await world.session('real-time');
    // Creating it re-arms the runner's timer to the new nearest fire time, not the next minute's check.
    await world.message(pi, 'due in a second', clock.now() + 1_000);
    expect(await promptsThrough(pi, 'due in a second')).toEqual(['due in a second']);
  });

  test('a delivery in flight is not fired twice, and the schedule cannot be changed under it', async () => {
    const pi = await world.session('in-flight');
    const model = { providerID: CATALOG_PROVIDER, modelID: 'test-model' };
    const slow = await world.create({ kind: 'new-session', tool: 'opencode', directory: broker.paths.home, text: 'slow to start', at: clock.now() + MINUTE, model });
    const createsBefore = opencode.creates.length;
    opencode.holdCatalogReads(); // the delivery waits on the model catalog
    let read: Awaited<ReturnType<FakeOpenCodeCatalog['nextCatalogRead']>> | undefined;
    try {
      clock.advance(MINUTE);
      read = await opencode.nextCatalogRead();
      for (const attempt of [
        world.patch(slow.id, { text: 'changed mid-flight', expectedRevision: slow.revision }),
        world.remove(slow.id),
        world.action(slow.id, 'run-now', slow.revision),
      ]) {
        const refused = await attempt;
        expect([refused.status, refused.body.code, refused.body.error]).toEqual([409, 'SCHEDULE_INVALID_STATE', 'schedule delivery is in flight']);
      }
      // Another pass falls due while the first delivery is still waiting.
      await world.message(pi, 'sentinel pass', clock.now() + MINUTE);
      clock.advance(MINUTE);
      await promptsThrough(pi, 'sentinel pass');
    } finally {
      read?.answer([{ id: 'test-model', name: 'Test model' }]);
      opencode.holdCatalogReads(false);
    }
    const delivered = await world.waitFor(slow.id, (row) => row.state === 'delivered', 'the slow delivery to finish');
    // A later pass: a second delivery of the same row would have created a second session by now.
    await world.message(pi, 'sentinel after', clock.now() + MINUTE);
    clock.advance(MINUTE);
    await promptsThrough(pi, 'sentinel after');
    expect(opencode.creates.slice(createsBefore)).toEqual([{}]);
    expect(opencode.prompts.filter((prompt) => prompt.sessionId === delivered.createdSessionId)).toHaveLength(1);
  });

  test('a live schedule is edited in place; a stale edit gets the current row; edits survive a restart and fire as edited', async () => {
    const pi = await world.session('edit');
    const original = await world.message(pi, 'before', clock.now() + 2 * HOUR);
    const editedAt = clock.now() + 4 * HOUR;
    const edited = await world.patch(original.id, { text: 'after', at: editedAt, expectedRevision: 1 });
    expect(edited.status).toBe(200);
    expect(edited.body.schedule).toMatchObject({ id: original.id, text: 'after', at: editedAt, revision: 2 });

    const stale = await world.patch(original.id, { text: 'stale overwrite', expectedRevision: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'SCHEDULE_STALE', schedule: { text: 'after', revision: 2 } });
    expect((await world.patch(original.id, { at: 0, expectedRevision: 2 })).status).toBe(400);
    expect((await world.patch('no-such-schedule', { text: 'x', expectedRevision: 1 })).status).toBe(404);
    expect((await world.patch(original.id, { tool: 'claude', expectedRevision: 2 })).status).toBe(400);

    // A new-session row is editable too; its kind, tool and target are not.
    const created = await world.newClaudeSession('new session later', clock.now() + 3 * HOUR);
    const revised = await world.patch(created.id, { text: 'new session revised', title: 'Revised', expectedRevision: 1 });
    expect(revised.body.schedule).toMatchObject({ text: 'new session revised', title: 'Revised', revision: 2 });
    expect((await world.remove(created.id)).body.schedule).toMatchObject({ state: 'canceled' });

    await broker.restart();
    await world.reannounce();
    expect(await world.get(original.id)).toMatchObject({ text: 'after', at: editedAt, revision: 2, state: 'scheduled' });
    clock.advance(4 * HOUR);
    expect(await promptsThrough(pi, 'after')).toEqual(['after']);
  });

  test('a cancelled schedule never fires; a finished row cannot be edited and can be removed', async () => {
    const pi = await world.session('cancel');
    const at = clock.now() + 10 * MINUTE;
    const cancelled = await world.message(pi, 'cancelled before its time', at);
    await world.message(pi, 'sentinel at the same time', at);
    const cancel = await world.remove(cancelled.id);
    expect(cancel.body.schedule).toMatchObject({ state: 'canceled', revision: 2 });

    clock.advance(10 * MINUTE);
    expect(await promptsThrough(pi, 'sentinel at the same time')).toEqual(['sentinel at the same time']);
    const row = await world.get(cancelled.id);
    expect(row.state).toBe('canceled');
    expect(row.lastFiredAt).toBeUndefined();

    const edit = await world.patch(cancelled.id, { text: 'too late', expectedRevision: 2 });
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe('SCHEDULE_INVALID_STATE');
    expect((await world.remove(cancelled.id)).body).toEqual({ ok: true, removed: true });
    const gone = await world.remove(cancelled.id);
    expect(gone.status).toBe(404);
    expect(gone.body.code).toBe('SCHEDULE_NOT_FOUND');
  });

  test('a paused schedule holds past its time; resumed within 30 minutes it fires late, beyond that it is missed', async () => {
    const pi = await world.session('pause');
    const late = await world.message(pi, 'resumed in time', clock.now() + 10 * MINUTE);
    const stale = await world.message(pi, 'resumed too late', clock.now() + 10 * MINUTE);
    const pausedLate = await world.action(late.id, 'pause', 1);
    expect(pausedLate.body.schedule).toMatchObject({ state: 'paused', revision: 2 });
    await world.action(stale.id, 'pause', 1);
    expect((await world.action(late.id, 'run-now', 2)).body.code).toBe('SCHEDULE_INVALID_STATE');
    await world.message(pi, 'sentinel at fifteen minutes', clock.now() + 15 * MINUTE);

    clock.advance(15 * MINUTE);
    expect(await promptsThrough(pi, 'sentinel at fifteen minutes')).toEqual(['sentinel at fifteen minutes']);
    expect((await world.get(late.id)).lastFiredAt).toBeUndefined();

    expect((await world.action(late.id, 'resume', 2)).body.schedule).toMatchObject({ state: 'scheduled', at: late.at });
    expect(await promptsThrough(pi, 'resumed in time')).toEqual(['sentinel at fifteen minutes', 'resumed in time']);

    clock.advance(30 * MINUTE);
    await world.action(stale.id, 'resume', 2);
    const missed = await world.waitFor(stale.id, (row) => row.state === 'missed', 'the stale row to be missed');
    expect(missed.lastError).toContain('missed: broker was unavailable');
    const notice = await eventually(async () => (await world.attention('scheduled-send-failed', pi.id))[0], { what: 'the missed notice' });
    expect(notice.title).toBe('Scheduled send missed');
    expect(pi.commands.map((command) => command.text)).not.toContain('resumed too late');
  });

  test('a schedule that came due while the broker was down fires if under 30 minutes late, and is missed otherwise', async () => {
    const withinGrace = await world.newClaudeSession('five minutes late', clock.now() + 40 * MINUTE);
    const beyondGrace = await world.newClaudeSession('thirty-five minutes late', clock.now() + 10 * MINUTE);
    await broker.stop({ keepState: true });
    clock.advance(45 * MINUTE);
    await broker.start();
    await world.reannounce();

    const missed = await world.waitFor(beyondGrace.id, (row) => row.state === 'missed', 'the long-overdue row to be missed');
    expect(missed.lastError).toMatch(/35 min late, grace is 30 min/);
    await claudePromptsThrough(claude, 'five minutes late');
    const delivered = await world.waitFor(withinGrace.id, (row) => row.state === 'delivered', 'the late row to be delivered');
    expect(delivered.createdSessionId).toBeString();
    expect(claude.launches().flatMap(promptTexts)).not.toContain('thirty-five minutes late');
  });

  test('a failed delivery retries on its backoff, and the user hears only the final result', async () => {
    const pi = await world.session('retry');
    await pi.bye('quit'); // the session is gone when its time comes
    const retrying = await world.message(pi, 'retried until it lands', clock.now() + MINUTE, {
      retryPolicy: { maxRetries: 2, delayMs: MINUTE, backoff: 'exponential', retryOn: ['delivery'] },
    });

    clock.advance(MINUTE);
    const first = await world.waitFor(retrying.id, (row) => row.retryAttempt === 1, 'the first retry to be planned');
    expect(first).toMatchObject({ state: 'scheduled', lastOutcome: 'failed', lastFailureKind: 'delivery' });
    expect(first.nextRetryAt).toBe(first.lastFiredAt + MINUTE);
    expect((await world.action(retrying.id, 'recover-quota', first.revision)).body.code).toBe('SCHEDULE_QUOTA_RECOVERY_UNAVAILABLE');

    clock.advance(MINUTE);
    const second = await world.waitFor(retrying.id, (row) => row.retryAttempt === 2, 'the second retry to be planned');
    expect(second.nextRetryAt).toBe(second.lastFiredAt + 2 * MINUTE);

    await pi.rehello(); // back before the last try
    clock.advance(2 * MINUTE);
    expect(await promptsThrough(pi, 'retried until it lands')).toEqual(['retried until it lands']);
    await world.waitFor(retrying.id, (row) => row.state === 'delivered', 'the retried row to be delivered');
    expect(await world.attention('scheduled-send-failed', pi.id)).toEqual([]);
    expect(await world.attention('scheduled-send', pi.id)).toHaveLength(1);

    // A failure with no native quota evidence is a delivery failure: a quota-only policy never retries it.
    await pi.bye('quit');
    const quotaOnly = await world.message(pi, 'quota only', clock.now() + MINUTE, {
      retryPolicy: { maxRetries: 1, delayMs: MINUTE, backoff: 'fixed', retryOn: ['quota'] },
    });
    clock.advance(MINUTE);
    const failed = await world.waitFor(quotaOnly.id, (row) => row.state === 'failed', 'the quota-only row to fail');
    expect(failed.lastFailureKind).toBe('delivery');
    await eventually(async () => (await world.attention('scheduled-send-failed', pi.id)).length === 1, { what: 'the failure notice' });
  });

  test('a daily schedule starts a session each day and moves on to the next occurrence', async () => {
    const daily = await world.newClaudeSession('good morning', clock.now() + 10 * MINUTE, { repeat: 'daily', timeZone: 'UTC', title: 'Daily' });
    expect(daily).toMatchObject({ repeat: 'daily', timeZone: 'UTC' });

    clock.advance(10 * MINUTE);
    await claudePromptsThrough(claude, 'good morning');
    const first = await world.waitFor(daily.id, (row) => row.lastOutcome === 'delivered', 'the first occurrence');
    expect(first).toMatchObject({ state: 'scheduled', at: daily.at + 24 * HOUR });
    expect(first.createdSessionId).toBeString();

    clock.advance(24 * HOUR);
    const second = await world.waitFor(daily.id, (row) => row.at === daily.at + 48 * HOUR, 'the second occurrence');
    expect(second).toMatchObject({ state: 'scheduled', lastOutcome: 'delivered' });
    expect(second.createdSessionId).not.toBe(first.createdSessionId);
    await eventually(
      () => claude.launches().flatMap(promptTexts).filter((text) => text === 'good morning').length === 2,
      { what: 'the second morning prompt at Claude' },
    );
  });

  test('a scheduled session starts with the exact model and effort chosen, and its prompt reaches the agent', async () => {
    const scheduled = await world.newClaudeSession('future prompt', clock.now() + HOUR, { model: OPUS_HIGH });
    expect(scheduled.model).toEqual(OPUS_HIGH);
    expect((await world.action(scheduled.id, 'run-now', scheduled.revision)).status).toBe(200);
    await world.waitFor(scheduled.id, (row) => row.state === 'delivered', 'the run-now row to be delivered');
    const launch = await eventually(
      () => claude.launches().find((candidate) => promptTexts(candidate).includes('future prompt')),
      { what: 'the Claude launch for the scheduled prompt' },
    );
    expect(claude.option(launch, '--model')).toBe('opus');
    expect(claude.option(launch, '--effort')).toBe('high');
  });

  // OpenCode's create cannot take a model (the fake, like the real server, refuses one), so the
  // chosen model only reaches OpenCode on the first prompt, the way the composer sends it.
  test('a scheduled OpenCode session’s first prompt runs on the model it was scheduled with', async () => {
    const model = { providerID: CATALOG_PROVIDER, modelID: 'test-model' };
    const scheduled = await world.create({ kind: 'new-session', tool: 'opencode', directory: broker.paths.home, text: 'scheduled with a model', at: clock.now() + HOUR, model });
    expect(scheduled.model).toEqual(model);
    await world.action(scheduled.id, 'run-now', scheduled.revision);
    const delivered = await world.waitFor(scheduled.id, (row) => row.state === 'delivered', 'the OpenCode schedule to be delivered');
    const prompt = opencode.prompts.find((candidate) => candidate.sessionId === delivered.createdSessionId);
    expect(prompt?.body.parts).toEqual([{ type: 'text', text: 'scheduled with a model' }]);
    expect(prompt?.body.model).toEqual(model);
  });

  test('a model retired before delivery fails the schedule without substituting; a catalog outage fails it distinctly', async () => {
    const unsupported = await world.client.post('/api/schedules', {
      kind: 'new-session', tool: 'claude', text: 'never substituted', at: clock.now() + HOUR,
      model: { providerID: 'anthropic', modelID: 'retired-alias' },
    });
    expect(unsupported.status).toBe(409);
    expect(unsupported.body.code).toBe('MODEL_SELECTION_UNSUPPORTED');

    const retiring = await world.newClaudeSession('must not run on a retired model', clock.now() + HOUR, { model: OPUS_HIGH });
    const configFile = join(broker.paths.root, 'claude', '.claude.json');
    writeFileSync(configFile, JSON.stringify({
      cachedGrowthBookFeatures: { 'tengu-model-error-overrides': { 'claude-opus-5': { block: 'retired in test' } } },
    }));
    try {
      const launchesBefore = claude.launches().length;
      await world.action(retiring.id, 'run-now', retiring.revision);
      const retired = await world.waitFor(retiring.id, (row) => row.state === 'failed', 'the retired-model row to fail');
      expect(retired.lastError).toMatch(/no longer available/);
      expect(claude.launches()).toHaveLength(launchesBefore);
    } finally {
      rmSync(configFile, { force: true });
    }

    const model = { providerID: CATALOG_PROVIDER, modelID: 'test-model' };
    const outage = await world.create({ kind: 'new-session', tool: 'opencode', directory: broker.paths.home, text: 'waits for the catalog', at: clock.now() + HOUR, model });
    opencode.setModels(503);
    try {
      const createsBefore = opencode.creates.length;
      await world.action(outage.id, 'run-now', outage.revision);
      const failed = await world.waitFor(outage.id, (row) => row.state === 'failed', 'the outage row to fail');
      expect(failed.lastError).toMatch(/503|catalog|unavailable/i);
      expect(failed.lastError).not.toMatch(/no longer available/);
      expect(opencode.creates).toHaveLength(createsBefore);
    } finally {
      opencode.setModels([{ id: 'test-model', name: 'Test model' }]);
    }
  });

  test('a schedule request is checked before anything is stored', async () => {
    const pi = await world.session('validation');
    const refusals = [
      { kind: 'later', tool: 'pi', sessionId: pi.id, text: 'x', at: clock.now() + HOUR },
      { kind: 'message', tool: 'no-such-agent', sessionId: pi.id, text: 'x', at: clock.now() + HOUR },
      { kind: 'message', tool: 'pi', sessionId: pi.id, text: '   ', at: clock.now() + HOUR },
      { kind: 'message', tool: 'pi', sessionId: pi.id, text: 'x', at: clock.now() - HOUR },
      { kind: 'message', tool: 'pi', sessionId: pi.id, text: 'x', cron: { expression: '0 9 * * *', timeZone: 'UTC' } },
      { kind: 'new-session', tool: 'claude', text: 'x', cron: { expression: '0 9 * * *', timeZone: 'UTC' }, repeat: 'daily' },
      { kind: 'new-session', tool: 'claude', text: 'x', cron: { expression: '@daily', timeZone: 'UTC' } },
      { kind: 'message', tool: 'pi', text: 'x', at: clock.now() + HOUR },
    ];
    const before = (await world.list()).length;
    for (const body of refusals) {
      const response = await world.client.post('/api/schedules', body);
      expect([response.status, body]).toEqual([400, body]);
      expect(String(response.body.code)).toMatch(/^SCHEDULE_(INVALID|CRON_INVALID)$/);
    }
    expect(await world.list()).toHaveLength(before);
  });

  test('a schedule that cannot be saved is not reported as created, and a delivery whose outcome cannot be saved is never repeated', async () => {
    const pi = await world.session('unsaved');
    const first = await world.message(pi, 'delivered once', clock.now() + 10 * MINUTE);
    await world.message(pi, 'sentinel after it', clock.now() + 20 * MINUTE);
    const file = join(broker.paths.cosyncingHome, 'schedules.json');
    rmSync(file, { force: true });
    mkdirSync(file); // every save now fails
    try {
      const refused = await world.client.post('/api/schedules', { kind: 'message', tool: 'pi', sessionId: pi.id, text: 'not durable', at: clock.now() + HOUR });
      expect(refused.status).toBe(500);
      expect(refused.body.code).toBe('PERSISTENCE_FAILED');
      expect((await world.list()).map((row) => row.text)).not.toContain('not durable');

      clock.advance(10 * MINUTE);
      expect(await promptsThrough(pi, 'delivered once')).toEqual(['delivered once']);
      expect(await world.waitFor(first.id, (row) => row.state === 'delivered', 'the unsaved delivery to show')).toBeDefined();
      clock.advance(10 * MINUTE);
      expect(await promptsThrough(pi, 'sentinel after it')).toEqual(['delivered once', 'sentinel after it']);
    } finally {
      rmSync(file, { recursive: true, force: true });
    }
  });
});

describe('scheduled sends saved by an earlier broker', () => {
  let broker: Broker;
  let clock: TestClock;
  let claude: FakeClaudeCli;
  let legacyAt: number;

  beforeAll(async () => {
    broker = await startBroker({
      name: 'schedules-legacy',
      setup: (paths) => {
        claude = installFakeClaudeCli(paths.bin);
        clock = new TestClock(paths.root);
        legacyAt = clock.now() + 10 * MINUTE;
        const row = {
          kind: 'new-session', tool: 'claude', directory: paths.home, text: 'written before owner provenance',
          at: legacyAt, id: 'legacy-scheduled', state: 'scheduled', createdAt: clock.now(), updatedAt: clock.now(),
          fieldFromALaterBroker: { kept: true },
        };
        writeFileSync(join(paths.cosyncingHome, 'schedules.json'), JSON.stringify({
          version: 1,
          schedules: [row, { ...row, id: 'legacy-delivered', state: 'delivered', revision: 3 }],
        }));
      },
      env: (paths) => ({ ...clock.env, COSYNCING_CLAUDE_BIN: claude.path }),
    });
  });
  afterAll(() => broker?.stop());

  test('a schedule without an owner is quarantined at startup: kept for review, never run', async () => {
    const client = broker.client();
    const rows = (await client.get('/api/schedules')).body.schedules;
    expect(rows.find((row: any) => row.id === 'legacy-scheduled')).toMatchObject({
      state: 'canceled',
      text: 'written before owner provenance',
      fieldFromALaterBroker: { kept: true },
    });
    expect(rows.find((row: any) => row.id === 'legacy-delivered')).toMatchObject({ state: 'delivered' });
    const legacy = rows.find((row: any) => row.id === 'legacy-scheduled');
    const runNow = await client.post('/api/schedules/legacy-scheduled/actions', { action: 'run-now', expectedRevision: legacy.revision });
    expect(runNow.status).toBe(409);
    expect(runNow.body.code).toBe('SCHEDULE_INVALID_STATE');

    const owner = await client.post('/api/schedules', { kind: 'new-session', tool: 'claude', directory: broker.paths.home, text: 'owner schedule', at: legacyAt });
    expect(owner.status).toBe(201);
    clock.advance(10 * MINUTE);
    await claudePromptsThrough(claude, 'owner schedule');
    expect(claude.launches().flatMap(promptTexts)).not.toContain('written before owner provenance');
  });

  test('an unreadable schedule file is set aside and the broker starts with none', async () => {
    const file = join(broker.paths.cosyncingHome, 'schedules.json');
    await broker.stop({ keepState: true });
    writeFileSync(file, '{ definitely not JSON');
    await broker.start();
    expect((await broker.client().get('/api/schedules')).body.schedules).toEqual([]);
    expect(readdirSync(broker.paths.cosyncingHome).some((name) => name.startsWith('schedules.json.corrupt-'))).toBe(true);
    expect(existsSync(file)).toBe(false);
  });
});
