#!/usr/bin/env bun
/** Durable attach-checkpoint and clientMessageId journal tests. No broker/model required. */
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mutationFingerprint, ProtocolJournal } from '../../src/sessions/protocol-journal.ts';

let failures = 0;
async function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name} - ${error instanceof Error ? error.message : String(error)}`);
  }
}

const scope = { identity: 'shared:identity-hash', tool: 'pi', sessionId: 'session-1' };
const message = { kind: 'prompt', text: 'secret prompt text', clientMessageId: 'request-1' };
const fingerprint = mutationFingerprint(message);

await run('terminal ack survives restart without retaining mutation content', () => {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-protocol-journal-'));
  const path = join(home, 'journal.json');
  try {
    const first = new ProtocolJournal({ path });
    assert.equal(first.claim(scope, 'request-1', 'prompt', fingerprint).status, 'new');
    first.complete(scope, 'request-1', { kind: 'ack', ack: 'client-message', clientMessageId: 'request-1' });
    assert.doesNotMatch(readFileSync(path, 'utf8'), /secret prompt text/);

    const restarted = new ProtocolJournal({ path });
    const replay = restarted.claim(scope, 'request-1', 'prompt', fingerprint);
    assert.equal(replay.status, 'terminal');
    assert.equal(replay.status === 'terminal' ? replay.result.kind : '', 'ack');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

await run('a failed draft clear survives restart and duplicate replay intact', () => {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-protocol-journal-'));
  const path = join(home, 'journal.json');
  try {
    // DR1: the outbox replay after a crash re-sends the SAME prompt frame, so this record is
    // what the sender is answered with. Losing draftCleared would tell it the shared draft was
    // cleared when it was not; losing draftRevision would turn its conditional retry into an
    // unconditional empty overwrite of whatever another device typed since.
    const first = new ProtocolJournal({ path });
    assert.equal(first.claim(scope, 'request-1', 'prompt', fingerprint).status, 'new');
    first.complete(scope, 'request-1', {
      kind: 'ack',
      ack: 'client-message',
      clientMessageId: 'request-1',
      draftCleared: false,
      draftRevision: 4,
    });

    const sameProcess = first.claim(scope, 'request-1', 'prompt', fingerprint);
    assert.equal(sameProcess.status === 'terminal' && sameProcess.result.kind === 'ack' ? sameProcess.result.draftCleared : true, false);

    const restarted = new ProtocolJournal({ path });
    const replay = restarted.claim(scope, 'request-1', 'prompt', fingerprint);
    assert.equal(replay.status, 'terminal');
    assert.deepEqual(replay.status === 'terminal' ? replay.result : null, {
      kind: 'ack',
      ack: 'client-message',
      clientMessageId: 'request-1',
      draftCleared: false,
      draftRevision: 4,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

await run('a failed clear without a usable retry target is rejected', () => {
  // A record whose failure flag survived but whose retry target did not is worse than no
  // record: replaying it would hand the sender an unconditional clear, which empties
  // whatever another device typed since. The revision must also be one the wire parser
  // would accept — a negative or unsafe value is dropped there and degrades the same way.
  const unusable: unknown[] = [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '4'];
  for (const draftRevision of unusable) {
    const home = mkdtempSync(join(tmpdir(), 'cosyncing-protocol-journal-'));
    const path = join(home, 'journal.json');
    try {
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          tickets: [],
          idempotency: [{
            ...scope,
            clientMessageId: 'request-1',
            mutationKind: 'prompt',
            fingerprint,
            state: 'terminal',
            createdAt: 1,
            updatedAt: 1,
            expiresAt: 4_000_000_000_000,
            result: {
              kind: 'ack',
              ack: 'client-message',
              clientMessageId: 'request-1',
              draftCleared: false,
              ...(draftRevision === undefined ? {} : { draftRevision }),
            },
          }],
        }),
      );
      const journal = new ProtocolJournal({ path });
      assert.deepEqual(journal.snapshot(), { idempotency: 0, tickets: 0 }, `revision ${String(draftRevision)}`);
      assert.ok(readdirSync(home).some((name) => name.startsWith('journal.json.corrupt-')));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

await run('restart resolves an in-flight mutation to a durable unknown-outcome nack', () => {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-protocol-journal-'));
  const path = join(home, 'journal.json');
  try {
    const first = new ProtocolJournal({ path });
    assert.equal(first.claim(scope, 'request-1', 'prompt', fingerprint).status, 'new');
    const restarted = new ProtocolJournal({ path });
    const replay = restarted.claim(scope, 'request-1', 'prompt', fingerprint);
    assert.equal(replay.status, 'terminal');
    assert.equal(replay.status === 'terminal' && replay.result.kind === 'nack' ? replay.result.code : '', 'CLIENT_MESSAGE_OUTCOME_UNKNOWN');
    const restartedAgain = new ProtocolJournal({ path });
    const stable = restartedAgain.claim(scope, 'request-1', 'prompt', fingerprint);
    assert.equal(stable.status === 'terminal' && stable.result.kind === 'nack' ? stable.result.code : '', 'CLIENT_MESSAGE_OUTCOME_UNKNOWN');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

await run('conflicting reuse fails while identity and session namespaces remain independent', () => {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-protocol-journal-'));
  try {
    const journal = new ProtocolJournal({ path: join(home, 'journal.json') });
    assert.equal(journal.claim(scope, 'request-1', 'prompt', fingerprint).status, 'new');
    assert.equal(journal.claim(scope, 'request-1', 'prompt', mutationFingerprint({ ...message, text: 'different' })).status, 'conflict');
    assert.equal(journal.claim(scope, 'request-1', 'command', fingerprint).status, 'conflict');
    assert.equal(journal.claim({ ...scope, identity: 'peer:other' }, 'request-1', 'prompt', fingerprint).status, 'new');
    assert.equal(journal.claim({ ...scope, sessionId: 'session-2' }, 'request-1', 'prompt', fingerprint).status, 'new');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

await run('terminal nack replay, retention expiry, and bounded eviction are deterministic', () => {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-protocol-journal-'));
  const path = join(home, 'journal.json');
  let now = 1_000;
  try {
    const journal = new ProtocolJournal({ path, now: () => now, retentionMs: 60_000, maxIdempotencyEntries: 1 });
    assert.equal(journal.claim(scope, 'nack-id', 'prompt', fingerprint).status, 'new');
    journal.complete(scope, 'nack-id', { kind: 'nack', code: 'CLIENT_MESSAGE_FAILED', message: 'failed', clientMessageId: 'nack-id' });
    const nack = journal.claim(scope, 'nack-id', 'prompt', fingerprint);
    assert.equal(nack.status === 'terminal' && nack.result.kind === 'nack' ? nack.result.code : '', 'CLIENT_MESSAGE_FAILED');

    assert.equal(journal.claim(scope, 'second-id', 'prompt', fingerprint).status, 'new', 'oldest terminal entry should be evicted');
    journal.complete(scope, 'second-id', { kind: 'ack', ack: 'client-message', clientMessageId: 'second-id' });
    assert.equal(journal.claim(scope, 'nack-id', 'prompt', fingerprint).status, 'new', 'an evicted id may be reused only outside its bounded retry window');
    journal.complete(scope, 'nack-id', { kind: 'ack', ack: 'client-message', clientMessageId: 'nack-id' });
    now += 61_000;
    assert.equal(journal.claim(scope, 'nack-id', 'prompt', fingerprint).status, 'new', 'expired terminal entry should be pruned');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

await run('attach receipt survives restart, is identity-bound, and conflicting receipt fails', () => {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-protocol-journal-'));
  const path = join(home, 'journal.json');
  try {
    const issued = new ProtocolJournal({ path });
    issued.issueTicket(scope, 'opaque-ticket');
    const restarted = new ProtocolJournal({ path });
    assert.equal(restarted.receiveTicket({ ...scope, identity: 'other' }, 'opaque-ticket', 'ack').status, 'unknown');
    assert.deepEqual(restarted.receiveTicket(scope, 'opaque-ticket', 'ack'), { status: 'ok', duplicate: false, receipt: 'ack' });
    assert.deepEqual(restarted.receiveTicket(scope, 'opaque-ticket', 'ack'), { status: 'ok', duplicate: true, receipt: 'ack' });
    assert.deepEqual(restarted.receiveTicket(scope, 'opaque-ticket', 'nack'), { status: 'conflict', prior: 'ack' });
    assert.ok(restarted.latestCommittedTicket(scope), 'ack should advance durable committed-checkpoint bookkeeping');

    restarted.issueTicket(scope, 'nacked-ticket');
    assert.deepEqual(restarted.receiveTicket(scope, 'nacked-ticket', 'nack'), { status: 'ok', duplicate: false, receipt: 'nack' });
    const afterNack = restarted.latestCommittedTicket(scope);
    assert.ok(afterNack, 'nack must not erase the previous committed checkpoint');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

await run('corrupt or unsupported journal is quarantined and starts empty', () => {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-protocol-journal-'));
  const path = join(home, 'journal.json');
  const warnings: string[] = [];
  try {
    writeFileSync(path, '{broken');
    const journal = new ProtocolJournal({ path, onWarning: (warning) => warnings.push(warning) });
    assert.deepEqual(journal.snapshot(), { idempotency: 0, tickets: 0 });
    assert.equal(existsSync(path), false);
    assert.ok(readdirSync(home).some((name) => name.startsWith('journal.json.corrupt-')));
    assert.match(warnings.join('\n'), /quarantined/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

if (failures) {
  console.error(`\nFAIL: ${failures} protocol journal test(s) failed`);
  process.exit(1);
}
console.log('\nPASS: durable protocol journal tests passed');
