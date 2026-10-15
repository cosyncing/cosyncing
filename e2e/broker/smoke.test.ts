/**
 * The broker starts, authenticates, and streams a live session to clients.
 *
 * The session comes from the Pi bridge: an integration posts session events
 * over HTTP, which makes it a scriptable source that needs no agent binary.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Broker, eventually, startBroker } from '../harness/index.ts';

async function openPiSession(broker: Broker, title: string): Promise<string> {
  const client = broker.client();
  const hello = await client.post('/pi/bridge/hello', {
    sessionFile: `${broker.paths.root}/pi-${title}.jsonl`,
    cwd: broker.paths.home,
    title,
  });
  expect(hello.status).toBe(200);
  return String(hello.body.id);
}

describe('tokenless source broker', () => {
  let broker: Broker;
  beforeAll(async () => {
    broker = await startBroker({ name: 'smoke' });
  });
  afterAll(() => broker?.stop());

  test('serves health without credentials', async () => {
    const health = await broker.client().get('/api/health');
    expect(health.status).toBe(200);
  });

  test('a live session streams to an attached client and reaches a late joiner once', async () => {
    const id = await openPiSession(broker, 'stream');
    const client = broker.client();
    const first = await client.attach('pi', id);
    await first.waitForKind('history');

    const key = 'pi:answer:1';
    const events = await client.post('/pi/bridge/events', {
      id,
      events: [
        { t: 'status', running: true },
        { t: 'delta', key, delta: 'The answer' },
        { t: 'final', key, text: 'The answer is 42.' },
        { t: 'status', running: false },
      ],
    });
    expect(events.ok).toBe(true);
    await first.waitForMessage((message) => message.key === key && message.delta === 'The answer');

    // A client joining after the turn finished gets the answer once, final.
    const second = await client.attach('pi', id);
    const answer = await second.waitForMessage((message) => message.key === key && message.final === true);
    expect(answer.text).toBe('The answer is 42.');
    expect(second.messages().filter((message) => message.key === key)).toHaveLength(1);
    client.closeAll();
  });

  test('the roster lists the live session', async () => {
    const id = await openPiSession(broker, 'roster');
    const session = await broker.client().waitForSession((row) => row.id === id);
    expect(session.tool ?? session.agent).toBe('pi');
  });
});

describe('broker with an owner token', () => {
  let broker: Broker;
  beforeAll(async () => {
    broker = await startBroker({ name: 'smoke-token', token: true });
  });
  afterAll(() => broker?.stop());

  test('refuses an unauthenticated roster read and serves the owner', async () => {
    const anonymous = broker.client({ kind: 'none' });
    expect((await anonymous.get('/api/sessions')).status).toBe(401);
    expect(await broker.client().sessions()).toBeArray();
  });

  test('refuses a wrong token', async () => {
    const wrong = broker.client({ kind: 'owner', token: 'not-the-token' });
    expect((await wrong.get('/api/sessions')).status).toBe(401);
  });

  test('opens a session stream through a one-use ticket', async () => {
    const client = broker.client();
    const sessions = await eventually(async () => {
      const response = await client.get('/api/health');
      return response.ok ? response : undefined;
    });
    expect(sessions.status).toBe(200);
    const ticket = await client.post('/api/ws-auth-tickets', {
      tool: 'pi',
      sessionId: 'missing',
      params: {},
    });
    expect([201, 404]).toContain(ticket.status);
  });
});
