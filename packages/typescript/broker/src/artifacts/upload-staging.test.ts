/**
 * Upload staging behaviour the broker's HTTP surface cannot reach.
 *
 * The e2e suite (`e2e/broker/uploads.test.ts`) drives uploads, staged
 * attachments and inbox collection through a real broker. What stays here
 * needs a seam no client has: a completion held mid-hash, a reference claimed
 * by a prompt that has not yet committed, and the per-sweep bounds of the
 * inbox collector, which a client sees only as "eventually".
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROMPT_ATTACHMENT_LIMITS } from '@cosyncing/protocol';
import { INBOX_PROTECTED_RECORD_CAP, scopedUploadIdentity, UploadError, UploadStaging } from './upload-staging.ts';

const root = mkdtempSync(join(tmpdir(), 'cosyncing-upload-staging-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const identity = scopedUploadIdentity('shared:credential', 'profile', 'incarnation');
let sequence = 0;

function workspace(): string {
  const cwd = join(root, `workspace-${++sequence}`);
  mkdirSync(cwd, { recursive: true });
  return cwd;
}

function uploadCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof UploadError) return error.code;
    throw error;
  }
  return undefined;
}

/** Find the one staging record under `home` and move it past its deadline. */
function expireOnlyRecord(home: string): void {
  const record = readdirSync(join(home, 'uploads'), { recursive: true, withFileTypes: true })
    .find((entry) => entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'inbox-roots.json');
  if (!record) throw new Error('no staging record');
  const path = join(record.parentPath, record.name);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), expiresAt: Date.now() - 1 }));
}

/** Deliver one inline file the way a committed prompt does; returns its inbox path. */
function deliverInline(staging: UploadStaging, sessionId: string, cwd: string, name: string): string {
  const prepared = staging.preparePromptFiles({
    tool: 'codex',
    sessionId,
    identity,
    clientMessageId: `client-${sessionId}-${name}`,
    sessionCwd: cwd,
    files: [{ name, mimeType: 'text/plain', data: Buffer.from(name).toString('base64') }],
  });
  staging.commitPreparedPromptFiles('codex', sessionId, prepared);
  return prepared.files[0]!.brokerPath!;
}

function age(path: string, ms: number): void {
  const when = (Date.now() - ms) / 1000;
  utimesSync(path, when, when);
}
const AGED = PROMPT_ATTACHMENT_LIMITS.inboxRetentionMs + 24 * 60 * 60 * 1000;

describe('a completion held while it hashes', () => {
  test('keeps its upload through expiry, discard and the expiry sweep, then finishes byte-exact', async () => {
    const home = join(root, 'completion-race');
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const staging = new UploadStaging({
      home,
      hashFile: async (path) => {
        markStarted();
        await held;
        if (!existsSync(path)) throw new Error('the bytes being hashed were deleted');
        return `sha256:${'0'.repeat(64)}`;
      },
    });
    const cwd = workspace();
    const upload = staging.init({ tool: 'codex', sessionId: 'race', name: 'race.bin', mimeType: 'application/octet-stream', expectedSize: 4 }, identity);
    staging.patch('codex', 'race', upload.uploadId, '0', Buffer.from('race'), identity);
    const completion = staging.complete('codex', 'race', upload.uploadId, cwd, identity);
    await started;
    expireOnlyRecord(home);

    expect(staging.status('codex', 'race', upload.uploadId, identity).offset).toBe(4);
    expect(uploadCode(() => staging.discard('codex', 'race', upload.uploadId, identity))).toBe('UPLOAD_SCOPE_MISMATCH');
    expect(staging.sweepExpired(Number.MAX_SAFE_INTEGER)).toBe(0);
    release();
    const completed = await completion;
    expect(readFileSync(join(cwd, '.cosyncing', 'inbox', completed.name), 'utf8')).toBe('race');
  });
});

describe('a staged reference claimed by a prompt that has not committed', () => {
  test('cannot be claimed by another prompt, and is released for retry by a rollback', async () => {
    const staging = new UploadStaging({ home: join(root, 'claims') });
    const cwd = workspace();
    const upload = staging.init({ tool: 'codex', sessionId: 'claims', name: 'claimed.txt', mimeType: 'text/plain', expectedSize: 3 }, identity);
    staging.patch('codex', 'claims', upload.uploadId, '0', Buffer.from('abc'), identity);
    const { stagedRef } = await staging.complete('codex', 'claims', upload.uploadId, cwd, identity);
    const claim = (clientMessageId: string) => staging.preparePromptFiles({
      tool: 'codex', sessionId: 'claims', identity, clientMessageId, sessionCwd: cwd, files: [{ stagedRef }],
    });

    const first = claim('first');
    expect(uploadCode(() => claim('second'))).toBe('UPLOAD_SCOPE_MISMATCH');
    expect(uploadCode(() => staging.discard('codex', 'claims', upload.uploadId, identity))).toBe('UPLOAD_SCOPE_MISMATCH');
    staging.rollbackPreparedPromptFiles('codex', 'claims', first);
    const retry = claim('second');
    expect(retry.files.map((file) => readFileSync(file.brokerPath!, 'utf8'))).toEqual(['abc']);
  });
});

describe('the inbox sweep is bounded', () => {
  test('one sweep visits at most 32 workspaces, and the next one carries on where it stopped', () => {
    const home = join(root, 'bounded');
    const staging = new UploadStaging({ home });
    const delivered = Array.from({ length: 40 }, (_, index) => {
      const path = deliverInline(staging, `bounded-${index}`, workspace(), 'aged.txt');
      age(path, AGED);
      return path;
    });
    const first = staging.sweepInboxes();
    expect([first.roots, first.removed]).toEqual([32, 32]);
    expect(delivered.filter((path) => existsSync(path))).toEqual(delivered.slice(32));
    expect(JSON.parse(readFileSync(join(home, 'uploads', 'inbox-roots.json'), 'utf8')).cursor).toBe(32);
    staging.sweepInboxes();
    expect(delivered.filter((path) => existsSync(path))).toEqual([]);
  });

  test('past the protected-record cap the sweep collects nothing and says so, until the record tree shrinks', () => {
    const home = join(root, 'protected-cap');
    const staging = new UploadStaging({ home });
    const delivered = deliverInline(staging, 'cap', workspace(), 'aged.txt');
    age(delivered, AGED);
    const bulk = join(home, 'uploads', 'bulk-tool', 'bulk-session');
    mkdirSync(bulk, { recursive: true });
    // The cap counts `.json` names before reading them; an unreadable record protects nothing.
    for (let index = 0; index <= INBOX_PROTECTED_RECORD_CAP; index += 1) writeFileSync(join(bulk, `bulk-${index}.json`), '{}');

    const aborted = staging.sweepInboxes();
    expect([aborted.aborted, aborted.removed, existsSync(delivered)]).toEqual([true, 0, true]);
    rmSync(bulk, { recursive: true, force: true });
    const resumed = staging.sweepInboxes();
    expect([resumed.aborted, resumed.removed, existsSync(delivered)]).toEqual([false, 1, false]);
  });
});
