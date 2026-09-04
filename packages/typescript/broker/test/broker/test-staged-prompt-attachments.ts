#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROMPT_ATTACHMENT_LIMITS } from '../../../protocol/src/index.ts';
import {
  scopedUploadIdentity,
  UploadError,
  UploadStaging,
} from '../../src/artifacts/upload-staging.ts';
import {
  assertBoundedPromptImages,
  ClientMessagePolicyError,
} from '../../src/sessions/client-message-policy.ts';
import { CodexAdapter } from '../../../adapters/codex/src/index.ts';
import { ClaudeAdapter } from '../../../adapters/claude/src/index.ts';
import { OpenCodeAdapter } from '../../../adapters/opencode/src/index.ts';
import { PiAdapter } from '../../../adapters/pi/src/index.ts';

let passed = 0;

function check(name: string, condition: unknown): void {
  if (!condition) throw new Error(`FAIL: ${name}`);
  console.log(`PASS: ${name}`);
  passed += 1;
}

function expectUploadError(
  name: string,
  fn: () => unknown,
  code: string,
): void {
  try {
    fn();
    throw new Error(`FAIL: ${name} did not throw`);
  } catch (error) {
    check(name, error instanceof UploadError && error.code === code);
  }
}

function expectPolicyError(name: string, fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error(`FAIL: ${name} did not throw`);
  } catch (error) {
    check(name, error instanceof ClientMessagePolicyError && error.code === code);
  }
}

async function expectAsyncUploadError(
  name: string,
  fn: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await fn();
    throw new Error(`FAIL: ${name} did not throw`);
  } catch (error) {
    check(name, error instanceof UploadError && error.code === code);
  }
}

/**
 * Move a staging home's one record past its deadline.
 *
 * The record is FOUND rather than constructed: `<home>/uploads/<tool>/<session>`
 * are hashed segments the staging owns, and a test that rebuilds that layout
 * would be asserting the hash rather than the expiry.
 */
function expireStagingRecord(home: string): void {
  const uploads = join(home, 'uploads');
  for (const tool of readdirSync(uploads)) {
    for (const session of readdirSync(join(uploads, tool))) {
      const sessionRoot = join(uploads, tool, session);
      for (const name of readdirSync(sessionRoot)) {
        if (!name.endsWith('.json')) continue;
        const path = join(sessionRoot, name);
        const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        writeFileSync(path, JSON.stringify({ ...record, expiresAt: Date.now() - 1 }));
        return;
      }
    }
  }
  throw new Error('FAIL: no staging record to expire');
}

const root = mkdtempSync(join(tmpdir(), 'cosyncing-staged-prompt-'));
const workspace = join(root, 'workspace');
const identityA = scopedUploadIdentity(
  'shared:credential-a',
  'profile-a',
  'incarnation-a',
);
const identityB = scopedUploadIdentity(
  'shared:credential-a',
  'profile-b',
  'incarnation-b',
);
const staging = new UploadStaging({
  home: join(root, 'state'),
  maxBytes: 1024,
  maxRecordsPerScope: 4,
  maxScopeBytes: 2048,
  cleanupBatchRecords: 8,
});

try {
  check(
    'Codex, Claude, OpenCode, and Pi advertise prompt attachment capability',
    [
      new CodexAdapter(),
      new ClaudeAdapter(),
      new OpenCodeAdapter(),
      new PiAdapter(),
    ].every((adapter) => adapter.capabilities.supportsNativeFileInput === true),
  );

  let markHashStarted!: () => void;
  let releaseHash!: () => void;
  const hashStarted = new Promise<void>((resolve) => {
    markHashStarted = resolve;
  });
  const hashHeld = new Promise<void>((resolve) => {
    releaseHash = resolve;
  });
  const completionRaceStaging = new UploadStaging({
    home: join(root, 'completion-race-state'),
    maxBytes: 1024,
    ttlMs: 25,
    hashFile: async (path) => {
      markHashStarted();
      await hashHeld;
      if (!existsSync(path)) {
        throw new Error('active completion data was deleted while hashing');
      }
      return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
    },
  });
  const completionRace = completionRaceStaging.init(
    {
      tool: 'codex',
      sessionId: 'completion-race',
      name: 'race.bin',
      mimeType: 'application/octet-stream',
      expectedSize: 4,
    },
    identityA,
  );
  completionRaceStaging.patch(
    'codex',
    'completion-race',
    completionRace.uploadId,
    '0',
    Buffer.from('race'),
    identityA,
  );
  const heldCompletion = completionRaceStaging.complete(
    'codex',
    'completion-race',
    completionRace.uploadId,
    workspace,
    identityA,
  );
  await hashStarted;
  while (Date.now() <= completionRace.expiresAt) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  check(
    'expired lookup preserves an upload while completion hashing is active',
    completionRaceStaging.status(
      'codex',
      'completion-race',
      completionRace.uploadId,
      identityA,
    ).offset === 4,
  );
  expectUploadError(
    'discard preserves an upload while completion hashing is active',
    () =>
      completionRaceStaging.discard(
        'codex',
        'completion-race',
        completionRace.uploadId,
        identityA,
      ),
    'UPLOAD_SCOPE_MISMATCH',
  );
  check(
    'expiry sweep preserves an upload while completion hashing is active',
    completionRaceStaging.sweepExpired(Number.MAX_SAFE_INTEGER) === 0,
  );
  releaseHash();
  const raceCompleted = await heldCompletion;
  check(
    'held completion finishes from the original byte-exact upload',
    readFileSync(
      join(workspace, '.cosyncing', 'inbox', raceCompleted.name),
      'utf8',
    ) === 'race',
  );

  const initialized = staging.init(
    {
      tool: 'codex',
      sessionId: 'session-a',
      name: 'large.txt',
      mimeType: 'text/plain',
      expectedSize: 6,
      contentHash:
        'sha256:bef57ec7f53a6d40beb640a780a639c8'
        + '3bc29ac8a9816f1fc6c5c6dcd93c4721',
    },
    identityA,
  );
  staging.patch(
    'codex',
    'session-a',
    initialized.uploadId,
    '0',
    Buffer.from('abc'),
    identityA,
  );
  await expectAsyncUploadError(
    'partial upload completion is rejected',
    () =>
      staging.complete(
        'codex',
        'session-a',
        initialized.uploadId,
        workspace,
        identityA,
      ),
    'UPLOAD_SIZE_MISMATCH',
  );
  staging.patch(
    'codex',
    'session-a',
    initialized.uploadId,
    '3',
    Buffer.from('def'),
    identityA,
  );
  const completed = await staging.complete(
    'codex',
    'session-a',
    initialized.uploadId,
    workspace,
    identityA,
  );
  check(
    'completion returns an opaque staged reference and no filesystem path',
    /^stg1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(completed.stagedRef)
      && !Object.hasOwn(completed, 'path'),
  );
  check(
    'completed upload remains identity-bound',
    (() => {
      try {
        staging.status(
          'codex',
          'session-a',
          initialized.uploadId,
          identityB,
        );
        return false;
      } catch (error) {
        return error instanceof UploadError
          && error.code === 'UPLOAD_SCOPE_MISMATCH';
      }
    })(),
  );

  expectUploadError(
    'same credential cannot cross client profile/incarnation scope',
    () =>
      staging.status(
        'codex',
        'session-a',
        initialized.uploadId,
        identityB,
      ),
    'UPLOAD_SCOPE_MISMATCH',
  );

  const prepared = staging.preparePromptFiles({
    tool: 'codex',
    sessionId: 'session-a',
    identity: identityA,
    clientMessageId: 'client-message-1',
    sessionCwd: workspace,
    files: [
      {
        name: 'inline.txt',
        mimeType: 'text/plain',
        size: 5,
        data: Buffer.from('hello').toString('base64'),
      },
      {
        name: completed.name,
        mimeType: completed.mimeType,
        size: completed.size,
        stagedRef: completed.stagedRef,
      },
    ],
  });
  check(
    'inline and staged files preserve prompt order and exact bytes',
    prepared.files.length === 2
      && readFileSync(prepared.files[0]!.brokerPath!, 'utf8') === 'hello'
      && readFileSync(prepared.files[1]!.brokerPath!, 'utf8') === 'abcdef',
  );
  check(
    'adapter handoff contains broker paths but no inline bytes or staged secret',
    prepared.files.every(
      (file) =>
        typeof file.brokerPath === 'string'
        && file.data === undefined
        && file.stagedRef === undefined,
    ),
  );
  expectUploadError(
    'a staged reference cannot be claimed by another prompt',
    () =>
      staging.preparePromptFiles({
        tool: 'codex',
        sessionId: 'session-a',
        identity: identityA,
        clientMessageId: 'client-message-2',
        sessionCwd: workspace,
        files: [{ stagedRef: completed.stagedRef }],
      }),
    'UPLOAD_SCOPE_MISMATCH',
  );
  const inlinePath = prepared.files[0]!.brokerPath!;
  staging.rollbackPreparedPromptFiles('codex', 'session-a', prepared);
  check('rollback removes materialized inline files', !existsSync(inlinePath));

  const retry = staging.preparePromptFiles({
    tool: 'codex',
    sessionId: 'session-a',
    identity: identityA,
    clientMessageId: 'client-message-2',
    sessionCwd: workspace,
    files: [{ stagedRef: completed.stagedRef, size: 6 }],
  });
  const deliveredPath = retry.files[0]?.brokerPath;
  check('rollback releases the staged reference for retry', retry.files.length === 1);
  staging.commitPreparedPromptFiles('codex', 'session-a', retry);
  check(
    'commit consumes the reference but preserves the delivered workspace file',
    typeof deliveredPath === 'string' && existsSync(deliveredPath),
  );
  expectUploadError(
    'a consumed staged reference cannot be replayed outside journal dedupe',
    () =>
      staging.preparePromptFiles({
        tool: 'codex',
        sessionId: 'session-a',
        identity: identityA,
        clientMessageId: 'client-message-3',
        sessionCwd: workspace,
        files: [{ stagedRef: completed.stagedRef }],
      }),
    'UPLOAD_NOT_FOUND',
  );

  expectUploadError(
    'client-supplied filesystem paths are rejected',
    () =>
      staging.preparePromptFiles({
        tool: 'codex',
        sessionId: 'session-a',
        identity: identityA,
        clientMessageId: 'client-message-4',
        sessionCwd: workspace,
        files: [{ name: 'bad', path: '/tmp/client-path' }],
      }),
    'UPLOAD_SCOPE_MISMATCH',
  );
  expectUploadError(
    'attachment count is bounded',
    () =>
      staging.preparePromptFiles({
        tool: 'codex',
        sessionId: 'session-a',
        identity: identityA,
        clientMessageId: 'client-message-5',
        sessionCwd: workspace,
        files: Array.from(
          { length: PROMPT_ATTACHMENT_LIMITS.maxFiles + 1 },
          (_, index) => ({
            name: `${index}.txt`,
            data: Buffer.from('x').toString('base64'),
          }),
        ),
      }),
    'UPLOAD_TOO_LARGE',
  );
  expectUploadError(
    'inline per-file bytes are bounded',
    () =>
      staging.preparePromptFiles({
        tool: 'codex',
        sessionId: 'session-a',
        identity: identityA,
        clientMessageId: 'client-message-6',
        sessionCwd: workspace,
        files: [
          {
            name: 'too-large-inline.bin',
            data: Buffer.alloc(
              PROMPT_ATTACHMENT_LIMITS.maxInlineFileBytes + 1,
              0x61,
            ).toString('base64'),
          },
        ],
      }),
    'UPLOAD_TOO_LARGE',
  );
  expectUploadError(
    'aggregate inline bytes are bounded',
    () => {
      const data = Buffer.alloc(
        PROMPT_ATTACHMENT_LIMITS.maxInlineFileBytes,
        0x62,
      ).toString('base64');
      return staging.preparePromptFiles({
        tool: 'codex',
        sessionId: 'session-a',
        identity: identityA,
        clientMessageId: 'client-message-7',
        sessionCwd: workspace,
        files: Array.from({ length: 5 }, (_, index) => ({
          name: `aggregate-${index}.bin`,
          data,
        })),
      });
    },
    'UPLOAD_TOO_LARGE',
  );

  const expiringHome = join(root, 'expiring-state');
  const expiring = new UploadStaging({ home: expiringHome, maxBytes: 1024 });
  const expiringInit = expiring.init(
    {
      tool: 'pi',
      sessionId: 'session-expiry',
      name: 'expires.txt',
      mimeType: 'text/plain',
      expectedSize: 1,
    },
    identityA,
  );
  expiring.patch(
    'pi',
    'session-expiry',
    expiringInit.uploadId,
    '0',
    Buffer.from('x'),
    identityA,
  );
  // Expiry is FORCED, not waited out. A `ttlMs: 1` staging used to stand in for
  // an expired one, which made the SETUP race the clock: on Windows the
  // filesystem work between `init` and `patch` outlasts a 1 ms TTL, so the patch
  // this case rests on threw `UPLOAD_EXPIRED` before the case began. Rewriting
  // the record's own deadline asserts the same refusal with no timing in it.
  expireStagingRecord(expiringHome);
  await expectAsyncUploadError(
    'expired staging is rejected and cleaned',
    () =>
      expiring.complete(
        'pi',
        'session-expiry',
        expiringInit.uploadId,
        workspace,
        identityA,
      ),
    'UPLOAD_EXPIRED',
  );

  // `images` — the older of the two intake routes, bounded to the same ceilings
  // as inline `files`. Nothing but the 32 MiB inbound frame cap used to stand
  // behind it, and the adapters that declare no file input have a dead `images`
  // branch waiting for whatever arrived.
  {
    const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');

    expectPolicyError(
      'a non-array images field is rejected',
      () => assertBoundedPromptImages({}, true),
      'ATTACHMENT_INVALID',
    );
    expectPolicyError(
      'more images than the attachment count allows are rejected',
      () => assertBoundedPromptImages(
        Array.from({ length: PROMPT_ATTACHMENT_LIMITS.maxFiles + 1 }, () => ({
          data: png,
          mimeType: 'image/png',
        })),
        true,
      ),
      'ATTACHMENT_LIMIT_EXCEEDED',
    );
    expectPolicyError(
      'an image larger than the inline decoded bound is rejected',
      () => assertBoundedPromptImages(
        [{
          data: Buffer.alloc(
            PROMPT_ATTACHMENT_LIMITS.maxInlineDecodedBytes + 3,
            0x61,
          ).toString('base64'),
          mimeType: 'image/png',
        }],
        true,
      ),
      'ATTACHMENT_LIMIT_EXCEEDED',
    );
    expectPolicyError(
      'images past the aggregate inline encoded budget are rejected',
      () => assertBoundedPromptImages(
        Array.from({ length: PROMPT_ATTACHMENT_LIMITS.maxFiles }, () => ({
          data: Buffer.alloc(
            PROMPT_ATTACHMENT_LIMITS.maxInlineDecodedBytes - 3,
            0x62,
          ).toString('base64'),
          mimeType: 'image/png',
        })),
        true,
      ),
      'ATTACHMENT_LIMIT_EXCEEDED',
    );
    expectPolicyError(
      'a brokerPath on an image entry is rejected',
      () => assertBoundedPromptImages(
        [{ data: png, mimeType: 'image/png', brokerPath: '/etc/passwd' }],
        true,
      ),
      'ATTACHMENT_INVALID',
    );
    expectPolicyError(
      'an image without a mimeType is rejected',
      () => assertBoundedPromptImages([{ data: png }], true),
      'ATTACHMENT_INVALID',
    );
    expectPolicyError(
      'a data: URL in place of raw base64 is rejected',
      () => assertBoundedPromptImages(
        [{ data: `data:image/png;base64,${png}`, mimeType: 'image/png' }],
        true,
      ),
      'ATTACHMENT_INVALID',
    );
    expectPolicyError(
      'non-canonical base64 image data is rejected',
      () => assertBoundedPromptImages([{ data: 'not!base64', mimeType: 'image/png' }], true),
      'ATTACHMENT_INVALID',
    );
    expectPolicyError(
      'images addressed to an adapter without native file input are refused',
      () => assertBoundedPromptImages([{ data: png, mimeType: 'image/png' }], false),
      'ATTACHMENT_UNSUPPORTED',
    );
    assertBoundedPromptImages(
      [{ data: png, mimeType: 'image/png', name: 'shot.png' }],
      true,
    );
    check('a well-formed image is accepted', true);
    assertBoundedPromptImages(undefined, false);
    assertBoundedPromptImages([], false);
    check('an absent or empty images field is accepted by every adapter', true);
  }

  console.log(`\n${passed} staged prompt attachment checks passed.`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
