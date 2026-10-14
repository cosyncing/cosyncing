/**
 * Which on-disk journal records the broker trusts at startup.
 *
 * A failed shared-draft clear is replayed to the sender with the revision its retry may clear. A
 * record whose failure flag survived but whose revision is unusable (missing, negative, fractional,
 * unsafe, a string) would turn that retry into an unconditional clear of whatever another device
 * typed since, so the whole file is distrusted and set aside. The end-to-end path (a real failed
 * clear replayed across a restart, a missing revision quarantined) is in
 * `e2e/broker/mutation-idempotency.test.ts`; this table covers the remaining record shapes.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mutationFingerprint, ProtocolJournal } from '../../src/sessions/protocol-journal.ts';

const scope = { identity: 'shared:identity-hash', tool: 'pi', sessionId: 'session-1' };
const message = { kind: 'prompt', text: 'sent text', clientMessageId: 'request-1' };

function loadWith(draftRevision: unknown): { claim: string; quarantined: boolean } {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-journal-records-'));
  try {
    const path = join(home, 'journal.json');
    writeFileSync(path, JSON.stringify({
      version: 1,
      tickets: [],
      idempotency: [{
        ...scope,
        clientMessageId: message.clientMessageId,
        mutationKind: message.kind,
        fingerprint: mutationFingerprint(message),
        state: 'terminal',
        createdAt: 1,
        updatedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        result: {
          kind: 'ack',
          ack: 'client-message',
          clientMessageId: message.clientMessageId,
          draftCleared: false,
          ...(draftRevision === undefined ? {} : { draftRevision }),
        },
      }],
    }));
    const journal = new ProtocolJournal({ path, onWarning: () => undefined });
    return {
      claim: journal.claim(scope, message.clientMessageId, message.kind, mutationFingerprint(message)).status,
      quarantined: readdirSync(home).some((name) => name.startsWith('journal.json.corrupt-')),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test.each([undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '4'])(
  'a failed clear whose retry revision is %p is distrusted with its whole file',
  (draftRevision) => {
    expect(loadWith(draftRevision)).toEqual({ claim: 'new', quarantined: true });
  },
);

test.each([0, 4])('a failed clear with retry revision %p is replayed as recorded', (draftRevision) => {
  expect(loadWith(draftRevision)).toEqual({ claim: 'terminal', quarantined: false });
});
