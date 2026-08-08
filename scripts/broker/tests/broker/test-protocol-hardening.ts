#!/usr/bin/env bun
/**
 * W5 protocol-hardening acceptance tests.
 *
 * Uses the fake Pi bridge as a mutable local broker session: no real Pi binary and no model.
 */
import { strict as assert } from 'node:assert';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { ProtocolJournal, mutationFingerprint } from '../../../../packages/typescript/broker/src/protocol-journal.ts';

const ASYNC_WAIT_TIMEOUT_MS = 12_000;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('could not allocate test port');
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return (addr as any).port;
}

async function waitHealthy(base: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      /* keep waiting */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('broker did not become healthy');
}

async function waitFor<T>(fn: () => T | undefined, ms = ASYNC_WAIT_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const out = fn();
    if (out) return out;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for condition');
}

async function run(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name} - ${err instanceof Error ? err.message : String(err)}`);
    failures++;
  }
}

let failures = 0;

await run('in-flight duplicate clientMessageId is marked pending, not final success', async () => {
  const home = mkdtempSync('/tmp/cosyncing-journal-unit-');
  const path = `${home}/journal.json`;
  const scope = { identity: 'unit-user', tool: 'unit', sessionId: 'unit-session' };
  const message = { kind: 'prompt', text: 'once', clientMessageId: 'same-id' };
  const fingerprint = mutationFingerprint(message);
  try {
    const journal = new ProtocolJournal({ path });
    assert.equal(journal.claim(scope, 'same-id', 'prompt', fingerprint).status, 'new');
    assert.equal(journal.claim(scope, 'same-id', 'prompt', fingerprint).status, 'pending');
    journal.complete(scope, 'same-id', { kind: 'nack', code: 'CLIENT_MESSAGE_FAILED', message: 'later failure', clientMessageId: 'same-id' });
    const final = journal.claim(scope, 'same-id', 'prompt', fingerprint);
    assert.equal(final.status, 'terminal');
    assert.equal(final.status === 'terminal' ? final.result.kind : '', 'nack');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

async function startBroker(options: { port?: number; home?: string } = {}): Promise<{
  broker: ReturnType<typeof Bun.spawn>;
  base: string;
  wsBase: string;
  home: string;
  port: number;
}> {
  const port = options.port ?? await freePort();
  const home = options.home ?? mkdtempSync('/tmp/cosyncing-w5-home-');
  const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      COSYNCING_BRIDGE_GRACE_MS: '500',
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
      COSYNCING_HOME: home,
      COSYNCING_HISTORY_MAX_MESSAGES: '3',
      // This suite exercises the unauthenticated loopback baseline. Never let
      // a developer/reviewer shell token silently turn every request into 401.
      COSYNCING_TOKEN: '',
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const base = `http://127.0.0.1:${port}`;
  await waitHealthy(base);
  return { broker, base, wsBase: base.replace(/^http/, 'ws'), home, port };
}

async function createPiBridgeSession(base: string, history?: any[], requestedSessionFile?: string): Promise<string> {
  const sessionFile = requestedSessionFile ?? `/tmp/cosyncing-w5-${Math.random().toString(36).slice(2)}.jsonl`;
  const res = await fetch(`${base}/pi/bridge/hello`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionFile,
      cwd: '/tmp',
      title: 'W5 protocol hardening',
      history: history ?? [{ t: 'user', text: 'seed', key: 'seed-u1' }],
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  return String(body.id);
}

async function openSession(
  wsBase: string,
  id: string,
  ticket?: string,
  initialHistory?: number | string,
  clientSource?: { profileId: string; incarnation: string },
): Promise<{ ws: WebSocket; frames: any[] }> {
  const frames: any[] = [];
  const params = new URLSearchParams({ artifactMode: 'reference' });
  if (ticket) params.set('ticket', ticket);
  if (initialHistory !== undefined) {
    params.set('initialHistory', `${initialHistory}`);
  }
  if (clientSource) {
    params.set('clientProfileId', clientSource.profileId);
    params.set('clientProfileIncarnation', clientSource.incarnation);
  }
  const url = `${wsBase}/api/sessions/pi/${encodeURIComponent(id)}/stream?${params}`;
  const ws = new WebSocket(url);
  ws.onmessage = (event) => {
    try {
      frames.push(JSON.parse(String(event.data)));
    } catch {
      /* ignore */
    }
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('websocket failed to open'));
  });
  await waitFor(() => frames.find((f) => f.kind === 'history'));
  return { ws, frames };
}

async function takeCommands(base: string, id: string): Promise<any[]> {
  const res = await fetch(`${base}/pi/bridge/commands?id=${encodeURIComponent(id)}`);
  const body = await res.json().catch(() => ({}));
  return Array.isArray(body?.commands) ? body.commands : [];
}

async function waitCommands(base: string, id: string): Promise<any[]> {
  const deadline = Date.now() + ASYNC_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const commands = await takeCommands(base, id);
    if (commands.length) return commands;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for bridge commands');
}

await run('attach tickets resume cleanly and invalid tickets produce explicit gap codes', async () => {
  const { broker, base, wsBase, home } = await startBroker();
  try {
    const id = await createPiBridgeSession(base);
    const first = await openSession(wsBase, id);
    const firstHistory = first.frames.find((f) => f.kind === 'history');
    assert.equal(typeof firstHistory.attachTicket, 'string');
    assert.equal(firstHistory.attachTicket, firstHistory.cursor);
    first.ws.close();

    const resumed = await openSession(wsBase, id, firstHistory.attachTicket);
    const resumedHistory = resumed.frames.find((f) => f.kind === 'history');
    assert.equal(resumedHistory.reset, false);
    assert.equal(Array.isArray(resumedHistory.messages), true);
    assert.equal(resumedHistory.messages.length, 0);
    resumed.ws.close();

    const invalid = await openSession(wsBase, id, 'not-a-valid-ticket');
    const invalidHistory = invalid.frames.find((f) => f.kind === 'history');
    assert.equal(invalidHistory.reset, true);
    assert.equal(invalidHistory.gap?.code, 'HISTORY_CURSOR_INVALID');
    assert.match(String(invalidHistory.gap?.message ?? ''), /full replay/i);
    invalid.ws.close();
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
});

await run('capped attach supports ordered backward history pages and typed cursor failures', async () => {
  const { broker, base, wsBase, home } = await startBroker();
  try {
    const history = Array.from({ length: 8 }, (_, index) => ({ t: 'user', text: `history-${index}`, key: `h-${index}` }));
    const id = await createPiBridgeSession(base, history);
    const { ws, frames } = await openSession(wsBase, id);
    const attach = frames.find((frame) => frame.kind === 'history');
    assert.deepEqual(attach.truncated, { shown: 3, total: 8 });
    assert.equal(attach.hasEarlier, true);
    assert.equal(typeof attach.olderCursor, 'string');
    assert.deepEqual(attach.messages.map((message: any) => message.text), ['history-5', 'history-6', 'history-7']);

    ws.send(JSON.stringify({ kind: 'history-page', cursor: attach.olderCursor, limit: 2, clientMessageId: 'older-1' }));
    const page = await waitFor(() => frames.find((frame) => frame.kind === 'history-page' && frame.clientMessageId === 'older-1'));
    assert.deepEqual(page.messages.map((message: any) => message.text), ['history-3', 'history-4']);
    assert.equal(page.hasMore, true);
    assert.equal(page.endOfHistory, false);

    ws.send(JSON.stringify({ kind: 'history-page', cursor: 'forged', clientMessageId: 'older-bad' }));
    const invalid = await waitFor(() => frames.find((frame) => frame.kind === 'nack' && frame.clientMessageId === 'older-bad'));
    assert.equal(invalid.code, 'HISTORY_CURSOR_INVALID');
    ws.close();
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
});

await run('initialHistory supports smaller valid request, clamp-to-broker-max, and malformed values', async () => {
  const { broker, base, wsBase, home } = await startBroker();
  try {
    const history = Array.from({ length: 8 }, (_, index) => ({ t: 'user', text: `history-${index}`, key: `h-${index}` }));
    const id = await createPiBridgeSession(base, history);

    {
      const { ws, frames } = await openSession(wsBase, id, undefined, 2);
      const attach = frames.find((frame) => frame.kind === 'history');
      assert.equal(attach?.truncated?.shown, 2);
      assert.deepEqual(attach?.messages?.map((message: any) => message.text), ['history-6', 'history-7']);
      ws.close();
    }

    {
      const { ws, frames } = await openSession(wsBase, id, undefined, 999);
      const attach = frames.find((frame) => frame.kind === 'history');
      assert.equal(attach?.truncated?.shown, 3);
      assert.deepEqual(attach?.messages?.map((message: any) => message.text), ['history-5', 'history-6', 'history-7']);
      ws.close();
    }

    {
      const { ws, frames } = await openSession(wsBase, id, undefined, 0);
      const attach = frames.find((frame) => frame.kind === 'history');
      assert.equal(attach?.truncated?.shown, 3);
      assert.deepEqual(attach?.messages?.map((message: any) => message.text), ['history-5', 'history-6', 'history-7']);
      ws.close();
    }

    {
      const { ws, frames } = await openSession(wsBase, id, undefined, 'not-a-number');
      const attach = frames.find((frame) => frame.kind === 'history');
      assert.equal(attach?.truncated?.shown, 3);
      assert.deepEqual(attach?.messages?.map((message: any) => message.text), ['history-5', 'history-6', 'history-7']);
      ws.close();
    }
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
});

await run('ack/nack receipt frames validate attach tickets', async () => {
  const { broker, base, wsBase, home } = await startBroker();
  try {
    const id = await createPiBridgeSession(base);
    const { ws, frames } = await openSession(wsBase, id);
    const ticket = frames.find((f) => f.kind === 'history')?.attachTicket;
    assert.equal(typeof ticket, 'string');

    ws.send(JSON.stringify({ kind: 'ack', attachTicket: ticket, clientMessageId: 'ack-1' }));
    const ack = await waitFor(() => frames.find((f) => f.kind === 'ack' && f.clientMessageId === 'ack-1'));
    assert.equal(ack.ack, 'ack');
    assert.equal(ack.attachTicket, ticket);

    ws.send(JSON.stringify({ kind: 'nack', attachTicket: ticket, clientMessageId: 'nack-1' }));
    const nackReceipt = await waitFor(() => frames.find((f) => f.kind === 'nack' && f.clientMessageId === 'nack-1'));
    assert.equal(nackReceipt.code, 'ACK_CONFLICT');
    assert.equal(nackReceipt.attachTicket, ticket);

    ws.send(JSON.stringify({ kind: 'ack', attachTicket: 'missing-ticket', clientMessageId: 'ack-bad' }));
    const bad = await waitFor(() => frames.find((f) => f.kind === 'nack' && f.clientMessageId === 'ack-bad'));
    assert.equal(bad.code, 'ACK_UNKNOWN_TARGET');
    ws.close();
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
});

await run('duplicate clientMessageId does not dispatch a second prompt', async () => {
  const { broker, base, wsBase, home } = await startBroker();
  try {
    const id = await createPiBridgeSession(base);
    const { ws, frames } = await openSession(wsBase, id);

    ws.send(JSON.stringify({ kind: 'prompt', text: 'W5_ONCE', clientMessageId: 'prompt-once' }));
    const firstAck = await waitFor(() => frames.find((f) => f.kind === 'ack' && f.clientMessageId === 'prompt-once' && !f.duplicate));
    assert.equal(firstAck.ack, 'client-message');

    ws.send(JSON.stringify({ kind: 'prompt', text: 'W5_ONCE_DUPLICATE', clientMessageId: 'prompt-once' }));
    const conflict = await waitFor(() => frames.find((f) => f.kind === 'nack' && f.clientMessageId === 'prompt-once'));
    assert.equal(conflict.code, 'CLIENT_MESSAGE_ID_CONFLICT');

    ws.send(JSON.stringify({ kind: 'prompt', text: 'W5_ONCE', clientMessageId: 'prompt-once' }));
    const duplicateAck = await waitFor(() => frames.find((f) => f.kind === 'ack' && f.clientMessageId === 'prompt-once' && f.duplicate));
    assert.equal(duplicateAck.ack, 'client-message');

    const commands = await waitCommands(base, id);
    const prompts = commands.filter((cmd: any) => cmd.kind === 'prompt');
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].text, 'W5_ONCE');
    ws.close();
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
});

await run('multi-attachment prompt ACKs only after one exact adapter handoff', async () => {
  const { broker, base, wsBase, home } = await startBroker();
  try {
    const id = await createPiBridgeSession(base);
    const { ws, frames } = await openSession(wsBase, id);
    const message = {
      kind: 'prompt',
      text: 'ATTACHMENT_TRANSACTION',
      clientMessageId: 'attachment-once',
      files: [
        {
          name: 'first.txt',
          mimeType: 'text/plain',
          size: 5,
          data: Buffer.from('alpha').toString('base64'),
        },
        {
          name: 'second.txt',
          mimeType: 'text/plain',
          size: 4,
          data: Buffer.from('beta').toString('base64'),
        },
      ],
    };
    ws.send(JSON.stringify(message));
    const ack = await waitFor(() =>
      frames.find(
        (frame) =>
          frame.kind === 'ack'
          && frame.clientMessageId === 'attachment-once'
          && !frame.duplicate,
      ),
    );
    assert.equal(ack.ack, 'client-message');
    const commands = await waitCommands(base, id);
    const prompts = commands.filter((command: any) => command.kind === 'prompt');
    assert.equal(prompts.length, 1);
    assert.match(prompts[0].text, /ATTACHMENT_TRANSACTION/);
    assert.match(prompts[0].text, /first(?:-[0-9a-f]+)?\.txt/);
    assert.match(prompts[0].text, /second(?:-[0-9a-f]+)?\.txt/);

    ws.send(JSON.stringify(message));
    const duplicate = await waitFor(() =>
      frames.find(
        (frame) =>
          frame.kind === 'ack'
          && frame.clientMessageId === 'attachment-once'
          && frame.duplicate,
      ),
    );
    assert.equal(duplicate.ack, 'client-message');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await takeCommands(base, id)).length, 0);

    ws.send(
      JSON.stringify({
        kind: 'prompt',
        text: 'MUST_NOT_DISPATCH',
        clientMessageId: 'attachment-path',
        files: [{ name: 'bad.txt', path: '/tmp/client-controlled' }],
      }),
    );
    const rejected = await waitFor(() =>
      frames.find(
        (frame) =>
          frame.kind === 'nack'
          && frame.clientMessageId === 'attachment-path',
      ),
    );
    assert.equal(rejected.code, 'STAGED_ATTACHMENT_SCOPE_MISMATCH');
    ws.close();
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
});

await run('terminal ack and nack outcomes survive broker restart and session re-adoption', async () => {
  const first = await startBroker();
  const sessionFile = `/tmp/cosyncing-w5-restart-${Math.random().toString(36).slice(2)}.jsonl`;
  let second: Awaited<ReturnType<typeof startBroker>> | undefined;
  try {
    const id = await createPiBridgeSession(first.base, undefined, sessionFile);
    const attached = await openSession(first.wsBase, id);
    const prompt = { kind: 'prompt', text: 'RESTART_ONCE', clientMessageId: 'restart-prompt' };
    const rejected = { kind: 'prompt', text: 'NEVER_DISPATCH', permissionMode: 'forged', clientMessageId: 'restart-nack' };
    attached.ws.send(JSON.stringify(prompt));
    await waitFor(() => attached.frames.find((frame) => frame.kind === 'ack' && frame.clientMessageId === 'restart-prompt'));
    assert.equal((await waitCommands(first.base, id)).filter((command) => command.kind === 'prompt').length, 1);
    attached.ws.send(JSON.stringify(rejected));
    const firstNack = await waitFor(() => attached.frames.find((frame) => frame.kind === 'nack' && frame.clientMessageId === 'restart-nack'));
    assert.equal(firstNack.code, 'PERMISSION_MODE_UNSUPPORTED');
    attached.ws.close();

    first.broker.kill();
    await first.broker.exited.catch(() => undefined);
    second = await startBroker({ port: first.port, home: first.home });
    const readoptedId = await createPiBridgeSession(second.base, undefined, sessionFile);
    assert.equal(readoptedId, id);
    const readopted = await openSession(second.wsBase, readoptedId);
    readopted.ws.send(JSON.stringify(prompt));
    const replayedAck = await waitFor(() => readopted.frames.find((frame) => frame.kind === 'ack' && frame.clientMessageId === 'restart-prompt'));
    assert.equal(replayedAck.duplicate, true);
    assert.equal((await takeCommands(second.base, id)).length, 0, 'restart replay must not dispatch the prompt again');

    readopted.ws.send(JSON.stringify(rejected));
    const replayedNack = await waitFor(() => readopted.frames.find((frame) => frame.kind === 'nack' && frame.clientMessageId === 'restart-nack'));
    assert.equal(replayedNack.code, 'PERMISSION_MODE_UNSUPPORTED');
    assert.equal(replayedNack.duplicate, true);
    readopted.ws.close();
  } finally {
    first.broker.kill();
    await first.broker.exited.catch(() => undefined);
    second?.broker.kill();
    await second?.broker.exited.catch(() => undefined);
    rmSync(first.home, { recursive: true, force: true });
  }
});

await run('revision-6 journal ACK remains visible to a profile-scoped client after upgrade', async () => {
  const first = await startBroker();
  const sessionFile = `/tmp/cosyncing-w5-upgrade-${Math.random().toString(36).slice(2)}.jsonl`;
  let second: Awaited<ReturnType<typeof startBroker>> | undefined;
  try {
    const id = await createPiBridgeSession(first.base, undefined, sessionFile);
    first.broker.kill();
    await first.broker.exited.catch(() => undefined);

    const prompt = {
      kind: 'prompt',
      text: 'PRE_A1_ALREADY_DELIVERED',
      clientMessageId: 'revision-6-outbox-replay',
    };
    const now = Date.now();
    // Seed the exact unsuffixed credential identity written by revision 6.
    writeFileSync(
      `${first.home}/protocol-journal.json`,
      JSON.stringify({
        version: 1,
        idempotency: [{
          identity: 'loopback-local',
          tool: 'pi',
          sessionId: id,
          clientMessageId: prompt.clientMessageId,
          mutationKind: prompt.kind,
          fingerprint: mutationFingerprint(prompt),
          state: 'terminal',
          createdAt: now,
          updatedAt: now,
          expiresAt: now + 60_000,
          result: {
            kind: 'ack',
            ack: 'client-message',
            clientMessageId: prompt.clientMessageId,
          },
        }],
        tickets: [],
      }),
    );

    second = await startBroker({ port: first.port, home: first.home });
    const readoptedId = await createPiBridgeSession(
      second.base,
      undefined,
      sessionFile,
    );
    assert.equal(readoptedId, id);
    const attached = await openSession(
      second.wsBase,
      readoptedId,
      undefined,
      undefined,
      { profileId: 'profile-after-upgrade', incarnation: 'incarnation-a1' },
    );
    attached.ws.send(JSON.stringify(prompt));
    const replayedAck = await waitFor(() =>
      attached.frames.find(
        (frame) =>
          frame.kind === 'ack'
          && frame.clientMessageId === prompt.clientMessageId,
      ),
    );
    assert.equal(replayedAck.duplicate, true);
    assert.equal(
      (await takeCommands(second.base, id)).length,
      0,
      'a pre-A1 terminal journal entry must prevent redispatch',
    );
    attached.ws.close();
  } finally {
    first.broker.kill();
    await first.broker.exited.catch(() => undefined);
    second?.broker.kill();
    await second?.broker.exited.catch(() => undefined);
    rmSync(first.home, { recursive: true, force: true });
  }
});

await run('crafted prompt and command permission modes fail closed for an inapplicable adapter', async () => {
  const { broker, base, wsBase, home } = await startBroker();
  try {
    const id = await createPiBridgeSession(base);
    const { ws, frames } = await openSession(wsBase, id);

    ws.send(JSON.stringify({
      kind: 'prompt',
      text: 'MUST_NOT_DISPATCH',
      permissionMode: 'full-access',
      clientMessageId: 'bad-mode-prompt',
    }));
    const promptNack = await waitFor(() => frames.find((f) => f.kind === 'nack' && f.clientMessageId === 'bad-mode-prompt'));
    assert.equal(promptNack.code, 'PERMISSION_MODE_UNSUPPORTED');

    ws.send(JSON.stringify({
      kind: 'command',
      name: 'compact',
      permissionMode: { forged: true },
      clientMessageId: 'bad-mode-command',
    }));
    const commandNack = await waitFor(() => frames.find((f) => f.kind === 'nack' && f.clientMessageId === 'bad-mode-command'));
    assert.equal(commandNack.code, 'PERMISSION_MODE_UNSUPPORTED');

    // A crafted set-agent frame fails closed too: this adapter has no agent
    // switch surface, so the broker must nack with the stable code and never
    // fabricate a switch (or dispatch anything to the agent).
    ws.send(JSON.stringify({ kind: 'set-agent', agent: 'plan', clientMessageId: 'bad-set-agent' }));
    const setAgentNack = await waitFor(() => frames.find((f) => f.kind === 'nack' && f.clientMessageId === 'bad-set-agent'));
    assert.equal(setAgentNack.code, 'AGENT_UNSUPPORTED');

    ws.send(JSON.stringify({ kind: 'prompt', text: 'ONLY_VALID_PROMPT', clientMessageId: 'valid-prompt' }));
    await waitFor(() => frames.find((f) => f.kind === 'ack' && f.clientMessageId === 'valid-prompt'));
    const commands = await waitCommands(base, id);
    assert.deepEqual(commands.filter((command: any) => command.kind === 'prompt').map((command: any) => command.text), ['ONLY_VALID_PROMPT']);
    ws.close();
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
});

await run('crafted plan actions require idempotency and exact current plan state', async () => {
  const { broker, base, wsBase, home } = await startBroker();
  try {
    const id = await createPiBridgeSession(base);
    const { ws, frames } = await openSession(wsBase, id);

    ws.send(JSON.stringify({ kind: 'plan-action', action: 'approve', planKey: 'missing', planRevision: 'r1' }));
    const missingId = await waitFor(() => frames.find((f) => f.kind === 'nack' && f.code === 'BAD_CLIENT_MESSAGE_ID'));
    assert.match(missingId.message, /requires clientMessageId/);

    ws.send(JSON.stringify({
      kind: 'plan-action', action: 'forged', planKey: 'missing', planRevision: 'r1', clientMessageId: 'plan-invalid',
    }));
    const invalid = await waitFor(() => frames.find((f) => f.kind === 'nack' && f.clientMessageId === 'plan-invalid'));
    assert.equal(invalid.code, 'PLAN_ACTION_INVALID');

    ws.send(JSON.stringify({
      kind: 'plan-action', action: 'approve', planKey: 'missing', planRevision: 'r1', clientMessageId: 'plan-missing',
    }));
    const missing = await waitFor(() => frames.find((f) => f.kind === 'nack' && f.clientMessageId === 'plan-missing'));
    assert.equal(missing.code, 'PLAN_NOT_FOUND');
    assert.equal((await takeCommands(base, id)).length, 0, 'invalid plan actions must never become Pi prompts');
    ws.close();
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
});

await run('artifact interactions are signed, session-bound, strict, and idempotent', async () => {
  const { broker, base, wsBase, home } = await startBroker();
  const htmlPath = `/tmp/cosyncing-artifact-${Math.random().toString(36).slice(2)}.html`;
  const textPath = `/tmp/cosyncing-artifact-${Math.random().toString(36).slice(2)}.txt`;
  try {
    writeFileSync(htmlPath, '<form id="f"><input name="answer" value="42"></form>');
    writeFileSync(textPath, 'display only');
    const id = await createPiBridgeSession(base);
    const { ws, frames } = await openSession(wsBase, id);
    const surface = async (path: string) => {
      const response = await fetch(`${base}/pi/bridge/send-file`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, path }),
      });
      assert.equal(response.status, 200);
      return waitFor(() => frames.find((frame) => frame.kind === 'message' && frame.message?.path === path.replace(/^\/tmp\//, '')));
    };
    const htmlFrame = await surface(htmlPath);
    const artifact = htmlFrame.message;
    assert.equal(artifact.interactionPolicy?.mode, 'structured');
    assert.equal(typeof artifact.interactionPolicy?.interactionRef, 'string');

    ws.send(JSON.stringify({
      kind: 'artifact-interaction',
      artifactKey: artifact.artifactKey,
      interactionRef: artifact.interactionPolicy.interactionRef,
      interaction: { type: 'form-submit', formId: 'f', data: { answer: '42' } },
      clientMessageId: 'artifact-once',
    }));
    await waitFor(() => frames.find((f) => f.kind === 'ack' && f.clientMessageId === 'artifact-once' && !f.duplicate));
    const firstCommands = await waitCommands(base, id);
    assert.equal(firstCommands.filter((command) => command.kind === 'prompt').length, 1);
    assert.match(firstCommands[0].text, /Submitted fields:\n- answer: 42/);

    ws.send(JSON.stringify({
      kind: 'artifact-interaction',
      artifactKey: artifact.artifactKey,
      interactionRef: artifact.interactionPolicy.interactionRef,
      interaction: { type: 'action', action: 'different' },
      clientMessageId: 'artifact-once',
    }));
    const conflict = await waitFor(() => frames.find((f) => f.kind === 'nack' && f.clientMessageId === 'artifact-once'));
    assert.equal(conflict.code, 'CLIENT_MESSAGE_ID_CONFLICT');

    ws.send(JSON.stringify({
      kind: 'artifact-interaction',
      artifactKey: artifact.artifactKey,
      interactionRef: artifact.interactionPolicy.interactionRef,
      interaction: { type: 'form-submit', formId: 'f', data: { answer: '42' } },
      clientMessageId: 'artifact-once',
    }));
    await waitFor(() => frames.find((f) => f.kind === 'ack' && f.clientMessageId === 'artifact-once' && f.duplicate));
    assert.equal((await takeCommands(base, id)).length, 0, 'replayed interaction id must not dispatch twice');

    ws.send(JSON.stringify({
      kind: 'artifact-interaction',
      artifactKey: artifact.artifactKey,
      interactionRef: artifact.interactionPolicy.interactionRef,
      interaction: { type: 'form-submit', data: { prompt: 'steal session' } },
      session: { tool: 'pi', id },
      clientMessageId: 'artifact-malicious',
    }));
    const malicious = await waitFor(() => frames.find((f) => f.kind === 'nack' && f.clientMessageId === 'artifact-malicious'));
    assert.equal(malicious.code, 'ARTIFACT_INTERACTION_INVALID');

    const textFrame = await surface(textPath);
    assert.equal(textFrame.message.interactionPolicy?.mode, 'display-only');
    ws.send(JSON.stringify({
      kind: 'artifact-interaction',
      artifactKey: textFrame.message.artifactKey,
      interactionRef: artifact.interactionPolicy.interactionRef,
      interaction: { type: 'action', action: 'save' },
      clientMessageId: 'artifact-display-only',
    }));
    const displayOnly = await waitFor(() => frames.find((f) => f.kind === 'nack' && f.clientMessageId === 'artifact-display-only'));
    assert.equal(displayOnly.code, 'ARTIFACT_INTERACTION_UNSUPPORTED');

    const otherId = await createPiBridgeSession(base);
    const other = await openSession(wsBase, otherId);
    const otherPath = `/tmp/cosyncing-artifact-${Math.random().toString(36).slice(2)}.html`;
    writeFileSync(otherPath, '<button data-cosyncing-action="save">Save</button>');
    try {
      const response = await fetch(`${base}/pi/bridge/send-file`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: otherId, path: otherPath }),
      });
      assert.equal(response.status, 200);
      const otherFrame = await waitFor(() => other.frames.find((frame) => frame.kind === 'message' && frame.message?.path === otherPath.replace(/^\/tmp\//, '')));
      ws.send(JSON.stringify({
        kind: 'artifact-interaction',
        artifactKey: otherFrame.message.artifactKey,
        interactionRef: otherFrame.message.interactionPolicy.interactionRef,
        interaction: { type: 'action', action: 'save' },
        clientMessageId: 'artifact-cross-session',
      }));
      const cross = await waitFor(() => frames.find((f) => f.kind === 'nack' && f.clientMessageId === 'artifact-cross-session'));
      assert.equal(cross.code, 'ARTIFACT_INTERACTION_NOT_FOUND');
    } finally {
      other.ws.close();
      rmSync(otherPath, { force: true });
    }
    ws.close();
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
    rmSync(htmlPath, { force: true });
    rmSync(textPath, { force: true });
  }
});

if (failures) {
  console.error(`\nFAIL: ${failures} protocol-hardening test(s) failed`);
  process.exit(1);
}
console.log('\nPASS: protocol-hardening tests passed');
