/**
 * Claude file-I/O (agent->user) artifact surfacing tests.
 *
 * The Claude adapter now emits a canonical `file-artifact` for (a) SendUserFile tool deliveries
 * (toolUseResult.attachments, inlined as a data: URL so the app renders the image) and (b) inline
 * {type:'image', source:{type:'base64',...}} content blocks in user AND assistant messages. Both observe
 * and resume flow through the same mappers (mapTranscript/mapLine), so this one path covers both.
 *
 * Pure mapper assertions over synthetic transcript lines — NO claude binary, NO model cost.
 *   bun run scripts/broker/tests/claude/test-claude-artifacts.ts      (exit 0 = all pass)
 */
export {};
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapTranscript } from '../../../../packages/typescript/adapters/claude/src/index.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// A real on-disk file so SendUserFile inlining can read+encode it (mime comes from the attachment, not sniffed).
const DIR = join(tmpdir(), 'ca-claude-artifacts');
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
const shot = join(DIR, 'shot.png');
writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])); // 8 bytes, enough to base64

const lines: any[] = [
  // (1) SendUserFile: a tool_use + a user tool_result whose toolUseResult carries attachments (proactive).
  { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'SendUserFile', input: { files: [shot], caption: 'here', status: 'proactive' } }] } },
  {
    type: 'user', uuid: 'u1',
    toolUseResult: { caption: 'here', status: 'proactive', attachments: [
      { path: shot, size: 8, isImage: true, media_type: 'image/png', file_uuid: 'fu1' },
      { path: join(DIR, 'missing.png'), size: 12, isImage: true, media_type: 'image/png', file_uuid: 'fu2' }, // unreadable → header-only
    ] },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'sent' }] },
  },
  // (2) a user-pasted inline image (base64) + text
  { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'AAAABBBB' } }, { type: 'text', text: 'look at this' }] } },
  // (3) an assistant-emitted inline image (the arm that was previously absent)
  { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'CCCCDDDD' } }] } },
];

const msgs = mapTranscript(lines);
const arts = msgs.filter((m: any) => m.type === 'file-artifact');
const byPath = new Map(arts.map((a: any) => [a.path, a]));

// SendUserFile attachment that exists → inlined data URL, proactive, correct mime/name
const sent = byPath.get(shot) as any;
check('SendUserFile attachment → file-artifact', !!sent && sent.type === 'file-artifact');
check('  name = basename, mime = media_type', sent?.name === 'shot.png' && sent?.mimeType === 'image/png');
check('  proactive flag carried from status', sent?.proactive === true);
check('  bytes inlined as data: URL', typeof sent?.url === 'string' && sent.url.startsWith('data:image/png;base64,'), (sent?.url || '').slice(0, 30));

// SendUserFile attachment whose file is missing → emitted but header-only (no url)
const missing = byPath.get(join(DIR, 'missing.png')) as any;
check('missing attachment still emitted (header-only)', !!missing && missing.url === undefined);

// the tool-result itself is STILL emitted alongside the artifacts
check('tool-result still emitted for the SendUserFile call', msgs.some((m: any) => m.type === 'tool-result' && m.callId === 'tu1'));

// user inline image → file-artifact with the base64 reused as the data URL + stable path id
const uimg = byPath.get('image:u2:0') as any;
check('user inline image → file-artifact', !!uimg && uimg.mimeType === 'image/webp');
check('  data URL reuses the block base64', uimg?.url === 'data:image/webp;base64,AAAABBBB');
// the user-message chip still counts the image
check('user-message still carries imageCount', msgs.some((m: any) => m.type === 'user-message' && m.imageCount === 1));

// assistant inline image → file-artifact (the previously-missing arm)
const aimg = byPath.get('image:a2:0') as any;
check('assistant inline image → file-artifact', !!aimg && aimg.mimeType === 'image/png' && aimg.url === 'data:image/png;base64,CCCCDDDD');

// dedupe determinism: re-mapping yields the SAME artifact paths (the app dedups by path on replay)
const arts2 = mapTranscript(lines).filter((m: any) => m.type === 'file-artifact').map((a: any) => a.path).sort();
check('artifact paths are stable across re-map (history replay dedupe)', JSON.stringify(arts2) === JSON.stringify(arts.map((a: any) => a.path).sort()));

rmSync(DIR, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
