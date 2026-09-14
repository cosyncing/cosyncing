#!/usr/bin/env bun
/** Two sockets reuse one Reasonix ACP writer and demote together. */
export {};
import { join } from 'node:path';
import type { AttachMode, SessionConnection } from '@cosyncing/adapter-api';
import { AgentRegistry } from '@cosyncing/adapter-api';
import { ReasonixAdapter, ReasonixDriveConnection } from '../../../adapters/reasonix/src/index.ts';
import {
  buildReasonixFixtureTree,
  writeFakeReasonixBinary,
} from '../../../adapters/reasonix/test/fixtures/tree.ts';
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
  message.type === 'user-message' && String(message.key ?? '').startsWith('queued:reasonix:'));

const tree = buildReasonixFixtureTree();
const fake = writeFakeReasonixBinary(join(tree.root, 'bin'), tree.id);
const adapter = new ReasonixAdapter({
  command: fake.path,
  env: {
    ...fake.env,
    REASONIX_HOME: tree.root,
    FAKE_REASONIX_PERMISSION_BEFORE_EXIT: '1',
    FAKE_REASONIX_COMMANDS: '1',
    FAKE_REASONIX_STREAM_ON_PROMPT: '4',
  },
});
let attachCalls = 0;
const realAttach = adapter.attach.bind(adapter);
adapter.attach = ((id: string, mode?: AttachMode): Promise<SessionConnection> => {
  attachCalls += 1;
  return realAttach(id, mode);
}) as typeof adapter.attach;
const registry = new AgentRegistry();
registry.register(adapter);
const hub = new Hub(registry, 15_000);

try {
  check('Reasonix explicitly advertises cross-client Drive sharing',
    adapter.capabilities.supportsCrossClientDriveSharing === true);

  const createdId = 'reasonix-broker-created-newline';
  const createdFake = writeFakeReasonixBinary(join(tree.root, 'bin-created-newline'), createdId);
  const createdAdapter = new ReasonixAdapter({
    command: createdFake.path,
    env: {
      ...createdFake.env,
      REASONIX_HOME: tree.root,
      FAKE_REASONIX_MATERIALIZE_ON_PROMPT: '1',
      FAKE_REASONIX_SYSTEM_ON_MATERIALIZE: '1',
      FAKE_REASONIX_CANONICALIZE_TERMINAL_NEWLINE: '1',
      FAKE_REASONIX_BLOCK_PROMPT_RESULT: '1',
    },
    pendingCreateTimeoutMs: 2_000,
  });
  const createdRegistry = new AgentRegistry();
  createdRegistry.register(createdAdapter);
  const createdHub = new Hub(createdRegistry, 15_000);
  let createdTurn: Promise<void> | undefined;
  try {
    const createdInfo = await createdAdapter.createSession({
      directory: tree.cwd,
      model: { providerID: 'provider', modelID: 'model' },
    });
    const createdOwner = await createdHub.ensure('reasonix', createdInfo.id, 'resume');
    const createdWire: Array<Extract<WireEvent, { kind: 'message' }>> = [];
    createdOwner.addClient((event) => { if (event.kind === 'message') createdWire.push(event); });
    createdTurn = createdOwner.conn.sendPrompt({
      text: 'browser composer terminal newline\n',
      clientMessageId: 'browser-client-message',
    });
    void createdTurn.catch(() => undefined);
    const delivered = await waitFor(() => createdWire.some((event) =>
      event.message.type === 'user-message'
        && event.message.clientKey === 'browser-client-message'
        && event.message.queued === false));
    const queuedRow = createdWire.find((event) =>
      event.message.type === 'user-message'
        && event.message.clientKey === 'browser-client-message'
        && event.message.queued === true)?.message;
    const deliveredRows = createdWire.filter((event) =>
      event.message.type === 'user-message'
        && event.message.clientKey === 'browser-client-message'
        && event.message.queued === false)
      .map((event) => event.message);
    const remainingPending = await createdOwner.conn.getPending?.() ?? [];
    check('pending-create native echo clears the broker client row after Reasonix strips one terminal newline',
      delivered
        && queuedRow?.type === 'user-message'
        && deliveredRows.length === 1
        && deliveredRows[0]?.type === 'user-message'
        && deliveredRows[0].text === 'browser composer terminal newline'
        && deliveredRows[0].key === queuedRow.key
        && deliveredRows[0].clientKey === queuedRow.clientKey
        && deliveredRows[0].queued === false
        && !remainingPending.some((message) => message.type === 'user-message')
        && createdAdapter.isDriving(createdInfo.id),
      JSON.stringify({ createdWire, remainingPending }));
    await createdOwner.conn.close();
    await createdTurn.catch(() => undefined);
  } finally {
    await createdHub.dispose();
    await createdTurn?.catch(() => undefined);
  }

  const owner = await hub.ensure('reasonix', tree.id, 'resume');
  const ownerFrames: Array<Extract<WireEvent, { kind: 'session' }>> = [];
  owner.addClient((event) => { if (event.kind === 'session') ownerFrames.push(event); });
  check('the owner starts in Drive without spawning before its first prompt',
    hub.sessionDetailFrame(owner, true).authority?.canMutate === true && fake.spawnCount() === 0);
  await owner.conn.getHistory();
  const coldCommands = owner.conn.listCommands ? await owner.conn.listCommands() : [];
  const coldPromptFrames = fake.events().filter((event) => {
    const frame = event.frame as Record<string, unknown> | undefined;
    return event.kind === 'frame' && frame?.method === 'session/prompt';
  });
  check('cold command discovery loads ACP without admitting a native turn',
    fake.spawnCount() === 1
      && coldPromptFrames.length === 0
      && coldCommands.some((command) => command.name === 'review'),
    JSON.stringify({ spawns: fake.spawnCount(), coldPromptFrames, coldCommands }));
  await owner.conn.sendPrompt({ text: 'owner pending prompt' });
  check('the first prompt reuses the command-discovery native writer', fake.spawnCount() === 1, String(fake.spawnCount()));
  check('the owner replays its accepted undelivered prompt',
    pending(await owner.conn.getHistory() as Array<Record<string, unknown>>).length === 1);

  const observer = await hub.ensure('reasonix', tree.id);
  observer.addClient(() => {});
  check('a bare reload gets a separate Observe connection',
    observer !== owner && observer.conn !== owner.conn && attachCalls === 2,
    `attachCalls=${attachCalls}`);
  check('the separate Observe history cannot see the owner-only pending prompt',
    pending(await observer.conn.getHistory() as Array<Record<string, unknown>>).length === 0);
  const offer = hub.sessionDetailFrame(observer, true);
  check('the read-only socket is offered the existing owner',
    offer.authority?.canMutate === false && offer.joinExisting?.ownerRevision !== undefined,
    JSON.stringify(offer));

  const joined = hub.joinExisting('reasonix', tree.id, offer.joinExisting!.ownerRevision);
  check('join reuses the exact Drive connection without a third native attach',
    joined === owner
      && joined.conn === owner.conn
      && joined.conn instanceof ReasonixDriveConnection
      && attachCalls === 2
      && fake.spawnCount() === 1);
  check('the joined socket now replays the owner pending row',
    pending(await joined.conn.getHistory() as Array<Record<string, unknown>>).length === 1);
  const commands = joined.conn.listCommands ? await joined.conn.listCommands() : [];
  check('the joined socket receives the measured ACP command catalog from the existing writer',
    commands.some((command) => command.name === 'review' && command.kind === 'prompt'),
    JSON.stringify(commands));
  const permissionVisible = await waitFor(async () => {
    const current = joined.conn.getPending ? await joined.conn.getPending() : [];
    return current.some((message) =>
      message.type === 'permission-request' && message.requestId === 'permission-before-exit');
  });
  check('a late-joining socket sees the unresolved ACP permission card', permissionVisible);
  await joined.conn.respondPermission('permission-before-exit', 'approve');
  const permissionSettled = await waitFor(() => fake.events().some((event) => {
    const frame = event.frame as Record<string, unknown> | undefined;
    const result = frame?.result as Record<string, unknown> | undefined;
    const outcome = result?.outcome as Record<string, unknown> | undefined;
    return frame?.id === 'permission-before-exit'
      && outcome?.outcome === 'selected'
      && outcome?.optionId === 'allow_once';
  }));
  check('the joined socket maps canonical approve back to the native allow-once option', permissionSettled);
  const joinedFrames: Array<Extract<WireEvent, { kind: 'session' }>> = [];
  joined.addClient((event) => { if (event.kind === 'session') joinedFrames.push(event); });

  await joined.conn.sendPrompt({ text: 'joined peer prompt' });
  const promptFrames = fake.events().filter((event) => {
    const frame = event.frame as Record<string, unknown> | undefined;
    return event.kind === 'frame' && frame?.method === 'session/prompt';
  });
  check('both sockets send in order through one ACP child',
    fake.spawnCount() === 1 && promptFrames.length === 2,
    `spawns=${fake.spawnCount()} prompts=${promptFrames.length}`);
  check('both accepted prompts survive replay on the shared connection',
    pending(await joined.conn.getHistory() as Array<Record<string, unknown>>).length === 2);

  await joined.conn.runCommand?.('review', 'the diff');
  const commandPromptFrames = fake.events().filter((event) => {
    const frame = event.frame as Record<string, unknown> | undefined;
    return event.kind === 'frame' && frame?.method === 'session/prompt';
  });
  const commandPrompt = commandPromptFrames.at(-1)?.frame as {
    params?: { prompt?: Array<{ text?: string }> };
  } | undefined;
  check('an advertised Reasonix slash command runs through the measured ACP prompt channel',
    commandPromptFrames.length === 3 && commandPrompt?.params?.prompt?.[0]?.text === '/review the diff',
    JSON.stringify(commandPrompt?.params?.prompt));

  const streamTurn = joined.conn.sendPrompt({ text: 'mid-stream join prompt' });
  const prejoinVisible = await waitFor(() => owner.liveSnapshot().some((message) =>
    message.type === 'model-output' && message.text === 'before join'));
  const attachSnapshot = owner.liveSnapshot();
  const lateSocketMessages: Array<Extract<WireEvent, { kind: 'message' }>> = [];
  owner.addClient((event) => { if (event.kind === 'message') lateSocketMessages.push(event); });
  check('Reasonix pre-join output enters the shared broker live snapshot',
    prejoinVisible && attachSnapshot.some((message) =>
      message.type === 'model-output' && message.text === 'before join'));
  await streamTurn;
  check('the same late socket receives later Reasonix output from the existing writer',
    lateSocketMessages.some((event) =>
      event.message.type === 'model-output' && event.message.delta === ' after join'));
  const finalUsage = lateSocketMessages.find((event) =>
    event.message.type === 'metadata-update' && event.message.key === 'sessionUsage')?.message;
  check('Reasonix final status publishes cumulative usage without repeatable token-count rows',
    !lateSocketMessages.some((event) => event.message.type === 'token-count')
      && finalUsage?.type === 'metadata-update'
      && (finalUsage.value as { input?: number; cacheReadSubset?: number; cost?: number }).input === 44
      && (finalUsage.value as { cacheReadSubset?: number }).cacheReadSubset === 12
      && !Object.prototype.hasOwnProperty.call(finalUsage.value as object, 'cost'),
    JSON.stringify(finalUsage));

  const ownerBefore = ownerFrames.length;
  const joinedBefore = joinedFrames.length;
  tree.appendUser('foreign terminal writer');
  const demoted = await waitFor(() =>
    ownerFrames.slice(ownerBefore).some((event) => event.info.control?.drive.state === 'observing')
      && joinedFrames.slice(joinedBefore).some((event) => event.info.control?.drive.state === 'observing'));
  check('a foreign durable user row demotes both sockets in one broadcast', demoted);
  check('demotion retains all accepted prompts',
    pending(await joined.conn.getHistory() as Array<Record<string, unknown>>).length === 4);
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
