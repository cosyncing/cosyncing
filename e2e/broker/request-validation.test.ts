/**
 * Request validation on the session wire: what a crafted or stale client frame gets back.
 *
 * The app's buttons only offer what the session advertises, but the broker cannot trust that: a
 * modified client or a replayed frame can name any mode, agent, plan action or artifact. Every such
 * frame must be refused with a stable code and reach nothing (the agent's command queue is the
 * witness), and the receipts a client sends for what it applied must be checked against what the
 * broker actually issued to that client.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Broker, type BrokerClient, type Frame, type SessionStream, startBroker } from '../harness/index.ts';
import { pairDevice } from '../harness/pairing.ts';
import { PiBridgeSession } from '../harness/fakes/pi-bridge-driver.ts';
import { type FakeOpenCodeServer, startFakeOpenCode } from '../harness/fakes/opencode-server.ts';

let broker: Broker;
let owner: BrokerClient;
let opencode: FakeOpenCodeServer;
let worktree: string;
const streams: SessionStream[] = [];

beforeAll(async () => {
  worktree = mkdtempSync(join(tmpdir(), 'cosyncing-e2e-validation-oc-'));
  opencode = startFakeOpenCode(worktree, 'ses_validation');
  broker = await startBroker({ name: 'request-validation', token: true, env: { OPENCODE_URL: opencode.url } });
  owner = broker.client();
});
afterAll(async () => {
  for (const stream of streams) stream.close();
  await broker?.stop();
  opencode?.stop();
  rmSync(worktree, { recursive: true, force: true });
});

async function session(name: string): Promise<PiBridgeSession> {
  const cwd = join(broker.paths.root, 'work', name);
  mkdirSync(cwd, { recursive: true });
  return PiBridgeSession.open(owner, { cwd, title: name });
}

async function attach(
  client: BrokerClient,
  tool: string,
  id: string,
  options: Parameters<BrokerClient['attach']>[2] = {},
): Promise<SessionStream> {
  const stream = await client.attach(tool, id, { artifactMode: 'reference', ...options });
  streams.push(stream);
  await stream.waitForKind('history');
  return stream;
}

/** Send a frame the broker answers without a usable `clientMessageId`, and wait for that answer. */
async function answerTo(stream: SessionStream, message: Record<string, unknown>): Promise<Frame> {
  const after = stream.frames.length;
  stream.send(message);
  return stream.waitForFrame((frame) => frame.kind === 'nack' || frame.kind === 'ack', { after, what: `the answer to ${JSON.stringify(message).slice(0, 80)}` });
}

/** Every prompt the Pi extension received, once the sentinel prompt `text` arrived. */
async function promptsThrough(pi: PiBridgeSession, text: string): Promise<string[]> {
  await pi.nextCommand((command) => command.kind === 'prompt' && String(command.text).startsWith(text), { what: `the "${text}" prompt` });
  return pi.commands.filter((command) => command.kind === 'prompt').map((command) => String(command.text).split('\n')[0]!);
}

describe('mutating frames', () => {
  test('a client message id must be a short ASCII token, and some mutations require one', async () => {
    const pi = await session('ids');
    const stream = await attach(owner, 'pi', pi.id);
    for (const clientMessageId of ['has space', 'ünïcode', 'x'.repeat(161), 42, '   ']) {
      const answer = await answerTo(stream, { kind: 'prompt', text: 'MUST NOT DISPATCH', clientMessageId });
      expect([JSON.stringify(clientMessageId).slice(0, 20), answer.kind, answer.code])
        .toEqual([JSON.stringify(clientMessageId).slice(0, 20), 'nack', 'BAD_CLIENT_MESSAGE_ID']);
    }
    for (const kind of ['plan-action', 'artifact-interaction', 'handoff']) {
      const answer = await answerTo(stream, { kind, action: 'approve', planKey: 'p', planRevision: 'r' });
      expect([kind, answer.code, answer.message]).toEqual([kind, 'BAD_CLIENT_MESSAGE_ID', `${kind} requires clientMessageId`]);
    }
    expect((await stream.sendAndAwait({ kind: 'prompt', text: 'sentinel', clientMessageId: 'ok.id:1-2_3' })).kind).toBe('ack');
    expect(await promptsThrough(pi, 'sentinel')).toEqual(['sentinel']);
  });

  test('a permission mode the session does not advertise fails closed, on prompts and commands, whatever its shape', async () => {
    const pi = await session('modes');
    const stream = await attach(owner, 'pi', pi.id);
    for (const permissionMode of ['full-access', ' default', 'default ', { value: 'default' }, 7, true]) {
      for (const frame of [
        { kind: 'prompt', text: 'MUST NOT DISPATCH', permissionMode },
        { kind: 'command', name: 'compact', permissionMode },
      ]) {
        const answer = await stream.sendAndAwait(frame);
        expect([frame.kind, JSON.stringify(permissionMode), answer.kind, answer.code])
          .toEqual([frame.kind, JSON.stringify(permissionMode), 'nack', 'PERMISSION_MODE_UNSUPPORTED']);
        expect(answer.message).not.toContain(broker.paths.root);
      }
    }
    expect((await stream.sendAndAwait({ kind: 'prompt', text: 'sentinel' })).kind).toBe('ack');
    expect(await promptsThrough(pi, 'sentinel')).toEqual(['sentinel']);
    expect(pi.commands.some((command) => command.kind === 'command')).toBe(false);
  });

  test('an agent switch must name an agent the live session advertises, exactly', async () => {
    opencode.setAgents([
      { name: 'build', mode: 'primary', description: 'Implementation agent' },
      { name: 'plan', mode: 'primary', description: 'Read-only planning agent' },
      { name: 'title', mode: 'subagent' },
    ]);
    const stream = await attach(owner, 'opencode', opencode.sessionId);
    const switched = await stream.sendAndAwait({ kind: 'set-agent', agent: 'plan' });
    expect(switched.kind).toBe('ack');
    expect(opencode.agentSwitches).toEqual(['plan']);
    for (const agent of [' plan', 'Plan', 'title', 'missing', { name: 'plan' }, undefined]) {
      const answer = await stream.sendAndAwait({ kind: 'set-agent', agent });
      expect([JSON.stringify(agent), answer.code]).toEqual([JSON.stringify(agent), 'AGENT_UNSUPPORTED']);
    }
    // A roster the session cannot read right now is not an advertisement either.
    opencode.setAgents([]);
    expect((await stream.sendAndAwait({ kind: 'set-agent', agent: 'build' })).code).toBe('AGENT_UNSUPPORTED');
    expect(opencode.agentSwitches).toEqual(['plan']);

    // A session with no switch surface at all refuses the same way and queues nothing.
    const pi = await session('no-agents');
    const piStream = await attach(owner, 'pi', pi.id);
    expect((await piStream.sendAndAwait({ kind: 'set-agent', agent: 'plan' })).code).toBe('AGENT_UNSUPPORTED');
    expect((await piStream.sendAndAwait({ kind: 'prompt', text: 'sentinel' })).kind).toBe('ack');
    await promptsThrough(pi, 'sentinel');
    expect(pi.commands.map((command) => command.kind)).toEqual(['prompt']);
  });

  test('a plan action needs a valid action and a plan the session has, and never becomes a prompt', async () => {
    const pi = await session('plans');
    const stream = await attach(owner, 'pi', pi.id);
    const refusals: Array<[Record<string, unknown>, string]> = [
      [{ action: 'forged', planKey: 'missing', planRevision: 'r1' }, 'PLAN_ACTION_INVALID'],
      [{ action: 'approve', planKey: 'missing', planRevision: 'r1' }, 'PLAN_NOT_FOUND'],
    ];
    for (const [fields, code] of refusals) {
      const answer = await stream.sendAndAwait({ kind: 'plan-action', ...fields });
      expect([JSON.stringify(fields), answer.code]).toEqual([JSON.stringify(fields), code]);
    }
    expect((await stream.sendAndAwait({ kind: 'prompt', text: 'sentinel' })).kind).toBe('ack');
    expect(await promptsThrough(pi, 'sentinel')).toEqual(['sentinel']);
  });
});

describe('artifact interactions', () => {
  test('are strictly shaped, bound to the session that surfaced the artifact, and answered once per id', async () => {
    const pi = await session('artifacts');
    const stream = await attach(owner, 'pi', pi.id);
    const surface = async (target: PiBridgeSession, on: SessionStream, name: string, body: string) => {
      writeFileSync(join(target.cwd, name), body);
      expect((await target.sendFile(join(target.cwd, name))).status).toBe(200);
      return on.waitForMessage((message) => message?.type === 'file-artifact' && message.name === name);
    };
    const page = await surface(pi, stream, 'form.html', '<form id="f"><input name="answer" value="42"></form>');
    // Active formats are delivered as opaque files: no artifact offers an interaction bridge.
    expect(page.interactionPolicy?.mode).toBe('display-only');
    const interaction = {
      kind: 'artifact-interaction',
      artifactKey: page.artifactKey,
      interaction: { type: 'form-submit', formId: 'f', data: { answer: '42' } },
      clientMessageId: 'artifact-once',
    };
    const refused = await stream.sendAndAwait(interaction);
    expect([refused.code, refused.duplicate]).toEqual(['ARTIFACT_INTERACTION_UNSUPPORTED', undefined]);
    // The refusal is the recorded outcome of that id; a different interaction under it conflicts.
    const replay = await stream.sendAndAwait(interaction);
    expect([replay.code, replay.duplicate]).toEqual(['ARTIFACT_INTERACTION_UNSUPPORTED', true]);
    const conflict = await stream.sendAndAwait({ ...interaction, interaction: { type: 'action', action: 'other' } });
    expect(conflict.code).toBe('CLIENT_MESSAGE_ID_CONFLICT');

    // A frame that names its own target, prompt or credentials is malformed, not redirected.
    for (const [field, value] of [
      ['session', { tool: 'pi', id: pi.id }],
      ['prompt', 'steal the session'],
      ['permissionMode', 'bypass'],
      ['credentials', { token: 'x' }],
    ] as const) {
      const answer = await stream.sendAndAwait({ ...interaction, clientMessageId: undefined, [field]: value });
      expect([field, answer.code]).toEqual([field, 'ARTIFACT_INTERACTION_INVALID']);
    }

    // Another session's artifact is not reachable from this session's socket.
    const other = await session('artifacts-other');
    const otherStream = await attach(owner, 'pi', other.id);
    const foreign = await surface(other, otherStream, 'save.html', '<button data-cosyncing-action="save">Save</button>');
    const crossed = await stream.sendAndAwait({
      kind: 'artifact-interaction',
      artifactKey: foreign.artifactKey,
      interaction: { type: 'action', action: 'save' },
    });
    expect(crossed.code).toBe('ARTIFACT_INTERACTION_NOT_FOUND');

    // Nothing reached either agent.
    expect((await stream.sendAndAwait({ kind: 'prompt', text: 'sentinel' })).kind).toBe('ack');
    expect(await promptsThrough(pi, 'sentinel')).toEqual(['sentinel']);
    expect((await otherStream.sendAndAwait({ kind: 'prompt', text: 'other sentinel' })).kind).toBe('ack');
    expect(await promptsThrough(other, 'other sentinel')).toEqual(['other sentinel']);
  });
});

describe('attach tickets and receipts', () => {
  test('a ticket resumes incrementally; an unknown one gets a full replay that says why', async () => {
    const pi = await session('tickets');
    const first = await attach(owner, 'pi', pi.id);
    const frame = first.ofKind('history')[0]!;
    expect(typeof frame.attachTicket).toBe('string');
    expect(frame.attachTicket).toBe(frame.cursor);
    first.close();

    const resumed = await attach(owner, 'pi', pi.id, { params: { ticket: frame.attachTicket } });
    const delta = resumed.ofKind('history')[0]!;
    expect([delta.reset, delta.messages.length, delta.gap]).toEqual([false, 0, undefined]);

    const forged = await attach(owner, 'pi', pi.id, { params: { ticket: 'not-a-valid-ticket' } });
    const replay = forged.ofKind('history')[0]!;
    expect(replay.reset).toBe(true);
    expect(replay.gap?.code).toBe('HISTORY_CURSOR_INVALID');
    expect(String(replay.gap?.message)).toMatch(/full replay/i);
  });

  test('a receipt names a ticket this client was issued, once, and survives a broker restart', async () => {
    const pi = await session('receipts');
    const stream = await attach(owner, 'pi', pi.id);
    const ticket = stream.ofKind('history')[0]!.attachTicket as string;

    const acked = await stream.sendAndAwait({ kind: 'ack', attachTicket: ticket });
    expect([acked.kind, acked.ack, acked.attachTicket, acked.duplicate]).toEqual(['ack', 'ack', ticket, undefined]);
    expect((await stream.sendAndAwait({ kind: 'ack', attachTicket: ticket })).duplicate).toBe(true);
    const flipped = await stream.sendAndAwait({ kind: 'nack', attachTicket: ticket });
    expect([flipped.kind, flipped.code, flipped.attachTicket]).toEqual(['nack', 'ACK_CONFLICT', ticket]);
    expect((await stream.sendAndAwait({ kind: 'ack', attachTicket: 'never-issued' })).code).toBe('ACK_UNKNOWN_TARGET');
    expect((await stream.sendAndAwait({ kind: 'ack' })).code).toBe('ACK_INVALID');
    expect((await answerTo(stream, { kind: 'ack', attachTicket: ticket, clientMessageId: 'not valid' })).code).toBe('ACK_INVALID');

    // Another device cannot receipt a delivery it was never issued. (A ticket names a history
    // position, so the phone attaches after the transcript moved on.)
    await pi.events({ t: 'user', key: 'moved-on', text: 'the transcript moved on' });
    await stream.waitForMessage((message) => message.key === 'moved-on');
    const phone = await pairDevice(owner, { peerId: 'receipt-phone' });
    const phoneStream = await attach(owner.as({ kind: 'peer', peerToken: phone.peerToken }), 'pi', pi.id);
    expect(phoneStream.ofKind('history')[0]!.attachTicket).not.toBe(ticket);
    expect((await phoneStream.sendAndAwait({ kind: 'ack', attachTicket: ticket })).code).toBe('ACK_UNKNOWN_TARGET');

    // The receipt is durable: after a restart the same ack is a duplicate, not a new commit.
    await broker.restart();
    await pi.rehello();
    const again = await attach(owner, 'pi', pi.id);
    const replayed = await again.sendAndAwait({ kind: 'ack', attachTicket: ticket });
    expect([replayed.kind, replayed.duplicate]).toEqual(['ack', true]);
  });
});
