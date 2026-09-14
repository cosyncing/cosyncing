#!/usr/bin/env bun
/** Two sockets reuse one broker-owned Grok ACP writer and demote together. */
export {};
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AttachMode, SessionConnection } from '@cosyncing/adapter-api';
import { AgentRegistry } from '@cosyncing/adapter-api';
import { GrokAdapter, GrokDriveConnection } from '../../../adapters/grok/src/index.ts';
import {
  buildGrokFixtureTree,
  writeFakeGrokBinary,
} from '../../../adapters/grok/test/fixtures/tree.ts';
import { Hub, type WireEvent } from '../../src/sessions/hub.ts';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(25);
  }
  return predicate();
}
const pending = (messages: Array<Record<string, unknown>>) => messages.filter((message) =>
  message.type === 'user-message' && String(message.key ?? '').startsWith('queued:grok:'));

const tree = buildGrokFixtureTree();
  const fake = writeFakeGrokBinary(
    join(tree.root, 'bin'),
    tree.root,
    '1.0.13',
    '019f9d70-e38e-7591-9a24-74a06ad89479',
  );
const adapter = new GrokAdapter({
  command: fake.path,
  env: {
    ...fake.env,
    FAKE_GROK_ECHO_DELAY_MS: '250',
    FAKE_GROK_PERMISSION_BEFORE_EXIT: '1',
  },
  requestTimeoutMs: 2_000,
  testOnlyEnableUnverifiedDrive: true,
});
let attachCalls = 0;
const registry = new AgentRegistry();
const hub = new Hub(registry, 15_000);

try {
  const created = await adapter.createSession({ directory: tree.cwd });
  const createdUpdatesPath = join(
    tree.root,
    'sessions',
    encodeURIComponent(tree.cwd),
    created.id,
    'updates.jsonl',
  );
  const createSpawns = fake.spawnCount();
  const realAttach = adapter.attach.bind(adapter);
  adapter.attach = ((id: string, mode?: AttachMode): Promise<SessionConnection> => {
    attachCalls += 1;
    return realAttach(id, mode);
  }) as typeof adapter.attach;
  registry.register(adapter);

  check('Grok explicitly advertises cross-client Drive sharing',
    adapter.capabilities.supportsCrossClientDriveSharing === true);
  const owner = await hub.ensure('grok', created.id, 'resume');
  const ownerFrames: Array<Extract<WireEvent, { kind: 'session' }>> = [];
  owner.addClient((event) => { if (event.kind === 'session') ownerFrames.push(event); });
  check('the owner starts in Drive without spawning before its first prompt',
    hub.sessionDetailFrame(owner, true).authority?.canMutate === true
      && fake.spawnCount() === createSpawns);

  const firstTurn = owner.conn.sendPrompt({ text: 'owner pending prompt', clientMessageId: 'owner-client' });
  const promptStarted = await waitFor(() => fake.events().some((event) => event.kind === 'frame'
    && (event.frame as { method?: unknown } | undefined)?.method === 'session/prompt'));
  check('the owner replays its accepted prompt before Grok echoes it',
    promptStarted
      && pending(await owner.conn.getHistory() as Array<Record<string, unknown>>).some((message) =>
        message.text === 'owner pending prompt' && message.clientKey === 'owner-client'));

  const observer = await hub.ensure('grok', created.id);
  observer.addClient(() => undefined);
  check('a bare reload gets a separate Observe connection',
    observer !== owner && observer.conn !== owner.conn && attachCalls === 2,
    `attachCalls=${attachCalls}`);
  check('the separate Observe history cannot see an owner-only queued transition',
    (await observer.conn.getHistory() as Array<Record<string, unknown>>).every((message) =>
      message.type !== 'user-message' || message.queued !== true));
  const offer = hub.sessionDetailFrame(observer, true);
  check('the read-only socket is offered the existing owner',
    offer.authority?.canMutate === false && offer.joinExisting?.ownerRevision !== undefined,
    JSON.stringify(offer));

  const joined = hub.joinExisting('grok', created.id, offer.joinExisting!.ownerRevision);
  check('join reuses the exact Drive connection without another native attach',
    joined === owner
      && joined.conn === owner.conn
      && joined.conn instanceof GrokDriveConnection
      && attachCalls === 2
      && fake.spawnCount() === createSpawns + 1);
  check('the joined socket immediately replays the owner queued row',
    pending(await joined.conn.getHistory() as Array<Record<string, unknown>>).length === 1);
  const joinedFrames: WireEvent[] = [];
  joined.addClient((event) => joinedFrames.push(event));

  const permissionVisible = await waitFor(async () => {
    const current = joined.conn.getPending ? await joined.conn.getPending() : [];
    return current.some((message) =>
      message.type === 'permission-request' && message.requestId === 'permission-before-exit');
  });
  check('a late-joining socket sees the unresolved Grok permission card', permissionVisible);
  await joined.conn.respondPermission('permission-before-exit', 'approve');
  await firstTurn;
  const permissionSettled = fake.events().some((event) => {
    const frame = event.frame as { id?: unknown; result?: { outcome?: { outcome?: unknown; optionId?: unknown } } } | undefined;
    return frame?.id === 'permission-before-exit'
      && frame.result?.outcome?.outcome === 'selected'
      && frame.result.outcome.optionId === 'allow_once';
  });
  check('the joined socket maps canonical approve to Grok allow-once', permissionSettled);
  const sharedHistory = await joined.conn.getHistory();
  check('the joined socket receives the owner echo and output from the existing child',
    sharedHistory.some((message) => message.type === 'user-message'
      && message.clientKey === 'owner-client'
      && message.queued === false)
      && joinedFrames.some((event) => event.kind === 'message'
        && event.message.type === 'model-output'
        && (event.message.text === 'fake answer' || event.message.delta === 'fake answer')),
    JSON.stringify({ sharedHistory, joinedFrames }));

  await joined.conn.sendPrompt({ text: 'joined peer prompt' });
  const promptFrames = fake.events().filter((event) => event.kind === 'frame'
    && (event.frame as { method?: unknown } | undefined)?.method === 'session/prompt');
  check('both sockets send in order through one Grok ACP child',
    fake.spawnCount() === createSpawns + 1 && promptFrames.length === 2,
    `spawns=${fake.spawnCount()} prompts=${promptFrames.length}`);
  const commands = joined.conn.listCommands ? await joined.conn.listCommands() : [];
  check('the joined socket receives the command catalog from the existing writer',
    commands.some((command) => command.name === 'compact' && command.kind === 'prompt'),
    JSON.stringify(commands));

  const ownerBefore = ownerFrames.length;
  const joinedBefore = joinedFrames.length;
  const foreign = {
    timestamp: new Date().toISOString(),
    method: 'session/update',
    params: {
      sessionId: created.id,
      _meta: { eventId: 'foreign-event', promptId: 'foreign-prompt', agentTimestampMs: Date.now() },
      update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'foreign terminal writer' } },
    },
  };
  appendFileSync(createdUpdatesPath, `${JSON.stringify(foreign)}\n`);
  await joined.conn.getHistory();
  const ownerDemoted = ownerFrames.slice(ownerBefore).some((event) =>
    event.info.control?.drive.state === 'observing');
  const joinedDemoted = joinedFrames.slice(joinedBefore).some((event) =>
    event.kind === 'session' && event.info.control?.drive.state === 'observing');
  check('a detectable foreign durable user row demotes both sockets in one broadcast',
    ownerDemoted && joinedDemoted);
  let refused = false;
  try { await joined.conn.sendPrompt({ text: 'must not race terminal' }); } catch { refused = true; }
  check('the demoted shared connection refuses later writes', refused);
} catch (error) {
  check('cross-client harness completed', false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await hub.dispose();
  tree.cleanup();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
