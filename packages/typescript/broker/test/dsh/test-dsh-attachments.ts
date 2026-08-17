/**
 * The attachment path an ordinary screenshot actually takes, end to end.
 *
 * The adapter's own suite builds an inbox file by hand, which proves the
 * containment check but NOT that the broker ever hands the adapter a path that
 * satisfies it. The first-party client switches from an inline attachment to a
 * chunked upload above `maxInlineFileBytes` (256 KiB), so the interesting file
 * — every real screenshot — arrives through the staged route, and this suite
 * drives that route with the REAL `UploadStaging` rather than a stand-in.
 *
 * The question it answers: does a >256 KiB image reach `session.prompt` exactly
 * once, with its bytes, when it goes through init/patch/complete and a staged
 * reference? A rejection here would mean DSH image input works only for tiny
 * files, which is the same as not working.
 *
 *   bun run packages/typescript/broker/test/dsh/test-dsh-attachments.ts
 */
export {};
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PROMPT_ATTACHMENT_LIMITS, PRODUCT_IDENTITY } from '@cosyncing/protocol';
import { UploadStaging } from '../../src/artifacts/upload-staging.ts';
import { DshDriver, DshDriveError } from '../../../adapters/dsh/src/drive.ts';
import { DshRpcClient, type DshFetch } from '../../../adapters/dsh/src/server.ts';

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const TOOL = 'dsh';
const SESSION_ID = 'session-attachment-proof';
/** The host's published intake policy, as a default install reports it. */
const IMAGE_LIMITS = {
  maxImageBytes: 5_242_880,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 104_857_600,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
};

interface Sent { path: string; body: Record<string, unknown> }

function client(): { rpc: DshRpcClient; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchImpl: DshFetch = async (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    sent.push({ path: new URL(url).pathname.replace('/api/', ''), body });
    return {
      status: 200,
      text: async () => JSON.stringify({
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: true, value: { accepted: true } },
      }),
    };
  };
  return { rpc: new DshRpcClient({ baseUrl: 'http://h', fetchImpl }), sent };
}

const home = mkdtempSync(join(tmpdir(), 'dsh-upload-home-'));
const workspace = mkdtempSync(join(tmpdir(), 'dsh-upload-cwd-'));
const staging = new UploadStaging({ home });

/** Drive the real staged route: init, patch every chunk, complete. */
function stageUpload(name: string, mimeType: string, bytes: Buffer): string {
  const init = staging.init({ tool: TOOL, sessionId: SESSION_ID, name, mimeType, expectedSize: bytes.length });
  const CHUNK = 64 * 1024;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    staging.patch(TOOL, SESSION_ID, init.uploadId, String(offset), bytes.subarray(offset, offset + CHUNK));
  }
  return init.uploadId;
}

// A PNG header followed by filler, comfortably over the inline ceiling so the
// client would have used the staged route for it.
const BIG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(400 * 1024, 0x7a),
]);

check(
  'the fixture is genuinely past the inline ceiling the client switches at',
  BIG.length > PROMPT_ATTACHMENT_LIMITS.maxInlineFileBytes,
  `${BIG.length} > ${PROMPT_ATTACHMENT_LIMITS.maxInlineFileBytes}`,
);

{
  const uploadId = stageUpload('screenshot.png', 'image/png', BIG);
  const completed = await staging.complete(TOOL, SESSION_ID, uploadId, workspace);
  const stagedRef = (completed as { stagedRef?: string }).stagedRef;

  // The claim under test: `complete` MOVES a staged upload into the session
  // inbox and rewrites the record, so a prompt-time staged path is an inbox
  // path whatever size the file is.
  const prepared = staging.preparePromptFiles({
    tool: TOOL,
    sessionId: SESSION_ID,
    identity: 'loopback-local',
    clientMessageId: 'client-msg-1',
    sessionCwd: workspace,
    files: [{ name: 'screenshot.png', mimeType: 'image/png', stagedRef, size: BIG.length }],
  });
  const inbox = join(workspace, PRODUCT_IDENTITY.repositoryDirectoryName, 'inbox');
  check(
    'a completed staged upload is handed to the adapter as a path inside the session inbox',
    prepared.files.length === 1 && dirname(prepared.files[0]!.brokerPath!) === inbox,
    prepared.files[0]?.brokerPath ?? '(none)',
  );
  check(
    'and the bytes at that path are the ones that were uploaded',
    readFileSync(prepared.files[0]!.brokerPath!).equals(BIG),
  );

  const { rpc, sent } = client();
  await new DshDriver(rpc).prompt(
    SESSION_ID,
    { text: 'what is wrong here?', files: prepared.files },
    { imageLimits: IMAGE_LIMITS, sessionCwd: workspace },
  );
  const prompts = sent.filter((entry) => entry.path === 'session.prompt');
  const content = (prompts[0]?.body.payload as { content: Array<Record<string, unknown>> }).content;
  check(
    'a 400 KiB staged image reaches session.prompt exactly once, inlined as an image part',
    prompts.length === 1
      && content.length === 2
      && content[0]!.type === 'text'
      && content[1]!.type === 'image'
      && content[1]!.mediaType === 'image/png'
      && content[1]!.name === 'screenshot.png'
      && Buffer.from(content[1]!.data as string, 'base64').equals(BIG),
    `${prompts.length} prompt(s), parts=${content.map((p) => p.type).join(',')}`,
  );
}

{
  // The same route with a type the host has no slot for. It must fail on the
  // TYPE — before any staged path is opened — so the message names the real
  // problem rather than a path the user cannot see.
  const uploadId = stageUpload('notes.pdf', 'application/pdf', Buffer.alloc(300 * 1024, 1));
  const completed = await staging.complete(TOOL, SESSION_ID, uploadId, workspace);
  const prepared = staging.preparePromptFiles({
    tool: TOOL,
    sessionId: SESSION_ID,
    identity: 'loopback-local',
    clientMessageId: 'client-msg-2',
    sessionCwd: workspace,
    files: [{
      name: 'notes.pdf',
      mimeType: 'application/pdf',
      stagedRef: (completed as { stagedRef?: string }).stagedRef,
      size: 300 * 1024,
    }],
  });
  const { rpc, sent } = client();
  let refused: unknown;
  await new DshDriver(rpc)
    .prompt(SESSION_ID, { text: 'x', files: prepared.files }, { imageLimits: IMAGE_LIMITS, sessionCwd: workspace })
    .catch((error: unknown) => { refused = error; });
  check(
    'a staged non-image is refused on its type, with nothing sent',
    refused instanceof DshDriveError
      && refused.message.includes('accepts images but not other file attachments')
      && sent.length === 0,
    refused instanceof Error ? refused.message : String(refused),
  );
}

{
  // An image the host would refuse anyway must cost a stat, not a multi-megabyte
  // read followed by a rejected upload.
  const big = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    Buffer.alloc(700 * 1024, 0x11),
  ]);
  const uploadId = stageUpload('huge.png', 'image/png', big);
  const completed = await staging.complete(TOOL, SESSION_ID, uploadId, workspace);
  const prepared = staging.preparePromptFiles({
    tool: TOOL,
    sessionId: SESSION_ID,
    identity: 'loopback-local',
    clientMessageId: 'client-msg-3',
    sessionCwd: workspace,
    files: [{
      name: 'huge.png',
      mimeType: 'image/png',
      stagedRef: (completed as { stagedRef?: string }).stagedRef,
      size: big.length,
    }],
  });
  const { rpc, sent } = client();
  let refused: unknown;
  await new DshDriver(rpc)
    .prompt(
      SESSION_ID,
      { text: 'x', files: prepared.files },
      { imageLimits: { ...IMAGE_LIMITS, maxImageBytes: 128 * 1024 }, sessionCwd: workspace },
    )
    .catch((error: unknown) => { refused = error; });
  check(
    'an oversized staged image is refused from its size on disk, before any upload',
    refused instanceof DshDriveError
      && refused.message.includes(`${128 * 1024} bytes`)
      && sent.length === 0,
    refused instanceof Error ? refused.message : String(refused),
  );
}

rmSync(home, { recursive: true, force: true });
rmSync(workspace, { recursive: true, force: true });

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
