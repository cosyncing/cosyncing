/**
 * Oversized tool-result diffs are bounded END TO END: the broker stashes the
 * body behind a content-hashed, signed reference (ArtifactStore.stashDiff) served
 * over the same authenticated path as artifacts, and the egress swap
 * (buildDiffRefMessage) strips the inline body once it exceeds the cap. This is
 * the broker half of T1b finding 1 — the client fetches on expansion (widget test).
 *
 * Run: bun run packages/typescript/broker/test/broker/test-diff-body-reference.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '../../../adapter-api/src/index.ts';
import { ArtifactStore } from '../../src/artifacts/artifact-store.ts';
import { buildDiffRefMessage, HARD_MAX_REFERENCED_DIFF_BYTES, MAX_REFERENCED_DIFF_BYTES } from '../../src/sessions/diff-reference.ts';
import {
  backwardHistoryCursor,
  backwardHistoryPage,
  capHistoryDelta,
  historyDelta,
  isCursorDurableMessage,
} from '../../src/sessions/history-delta.ts';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

// A representative "oversized" edit: ~600 changed lines, well past the client's
// 400-line render cap. Measure its real byte size to justify the 32 KiB cap.
function bigDiff(): string {
  const out: string[] = ['diff --git a/lib/huge.dart b/lib/huge.dart', '--- a/lib/huge.dart', '+++ b/lib/huge.dart', '@@ -1,600 +1,600 @@'];
  for (let i = 0; i < 600; i++) out.push(`-old line ${i} with enough text to be realistic`, `+new line ${i} with enough text to be realistic`);
  return out.join('\n');
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'ca-diffref-'));
  try {
    const store = new ArtifactStore('http://broker.default:7734', root);
    const body = bigDiff();
    const bytes = Buffer.byteLength(body, 'utf8');
    check('representative oversized diff exceeds the 32 KiB inline cap', bytes > 32 * 1024, `${bytes} bytes`);

    // 1. stashDiff → signed reference; serve returns the exact body + content hash.
    const ref = store.stashDiff('codex', 'sess-1', 'sess-1:call-1', body, 'http://broker.default:7734');
    check('stashDiff returns a signed fetch URL + hash + size', ref.fetchUrl.includes('/artifact/') && ref.contentHash.length === 64 && ref.byteSize === bytes, ref.fetchUrl);
    const url = new URL(ref.fetchUrl);
    const key = url.pathname.split('/').pop()!;
    const served = store.serve('codex', 'sess-1', decodeURIComponent(key), url.searchParams.get('expires'), url.searchParams.get('sig'));
    check('served body is byte-identical', served.status === 200 && (await served.text()) === body);
    check('served content-type is text/x-diff + content-hash header matches', served.headers.get('content-type')?.startsWith('text/x-diff') === true && served.headers.get('x-cosyncing-content-hash') === ref.contentHash);

    // 2. Idempotent + durable across restart (content-addressed blob persists).
    const ref2 = store.stashDiff('codex', 'sess-1', 'sess-1:call-1', body, 'http://broker.default:7734');
    check('re-stash of the same body is idempotent (same content hash)', ref2.contentHash === ref.contentHash);
    const reloaded = new ArtifactStore('http://broker.default:7734', root);
    const after = reloaded.serve('codex', 'sess-1', decodeURIComponent(key), url.searchParams.get('expires'), url.searchParams.get('sig'));
    check('body survives a broker restart (durable blob)', after.status === 200);

    // 3. A forged signature is rejected (auth is per-URL HMAC, like artifacts).
    const sig = url.searchParams.get('sig')!;
    const forged = sig.slice(0, -1) + (sig.at(-1) === 'A' ? 'B' : 'A');
    const denied = reloaded.serve('codex', 'sess-1', decodeURIComponent(key), url.searchParams.get('expires'), forged);
    check('forged signature is denied (403)', denied.status === 403);

    // 4. Egress swap: an oversized tool-result → diffRef, inline diff + per-file
    //    bodies stripped, per-file metadata kept.
    let stashed = 0;
    const stash = (b: string) => {
      stashed++;
      return store.stashDiff('codex', 'sess-1', 'sess-1:c9', b);
    };
    const oversized: Extract<AgentMessage, { type: 'tool-result' }> = {
      type: 'tool-result',
      callId: 'c9',
      toolName: 'apply_patch',
      title: 'Changed 2 files',
      diff: body,
      additions: 600,
      deletions: 600,
      fileChanges: [
        { path: 'lib/huge.dart', operation: 'edit', diff: body, additions: 600, deletions: 600 },
      ],
    };
    const swapped = buildDiffRefMessage(oversized, 32 * 1024, stash) as any;
    check('oversized tool-result gains a diffRef', swapped.diffRef?.contentHash === ref.contentHash && swapped.diffRef.byteSize === bytes && swapped.diffRef.lineCount > 400);
    check('inline diff is stripped, per-file metadata kept without body', swapped.diff === undefined && swapped.fileChanges?.[0]?.diff === undefined && swapped.fileChanges?.[0]?.path === 'lib/huge.dart' && swapped.fileChanges[0].additions === 600, JSON.stringify(swapped.fileChanges));
    check('the swap does not mutate the input message', typeof oversized.diff === 'string' && oversized.fileChanges?.[0]?.diff === body);

    // 5. A small diff is left inline (no stash, no diffRef).
    const small: Extract<AgentMessage, { type: 'tool-result' }> = {
      type: 'tool-result', callId: 'c1', toolName: 'Edit', diff: '@@ -1,1 +1,1 @@\n-a\n+b',
    };
    const untouched = buildDiffRefMessage(small, 32 * 1024, stash) as any;
    check('small diff stays inline (no diffRef, not stashed)', untouched === small && untouched.diffRef === undefined);

    // 6. The history cursor binds to the diff body's CONTENT HASH, not the signed (expiring) fetchUrl,
    //    and two DIFFERENT oversized diffs must not collide into an empty delta (T1b finding 1).
    const refMsg = (hash: string, fetchUrl: string): AgentMessage => ({
      type: 'tool-result', callId: 'c1', toolName: 'apply_patch',
      diffRef: { fetchUrl, contentHash: hash, byteSize: 100_000, lineCount: 1200 },
    });
    const curA = historyDelta([refMsg('aaaa', 'http://b/x?expires=1&sig=A')]).cursor;
    const curAUrl2 = historyDelta([refMsg('aaaa', 'http://b/x?expires=999&sig=Z')]).cursor;
    const curB = historyDelta([refMsg('bbbb', 'http://b/x?expires=1&sig=A')]).cursor;
    check('history cursor ignores the expiring fetchUrl (same content hash → identical cursor)', curA === curAUrl2, `${curA} vs ${curAUrl2}`);
    check('history cursor distinguishes oversized diffs by content hash (no empty-delta collision)', curA !== curB);
    const reattach = historyDelta([refMsg('bbbb', 'http://b/x?expires=1&sig=A')], curA);
    check('reattaching an old cursor after the oversized diff changed forces a full replay', reattach.reset === true && reattach.messages.length === 1);

    // 7. Pathologically large aggregate is clipped at a line boundary before stashing, so the client's
    //    fetch is bounded end to end; the reference is flagged truncated (T1b finding 2).
    const huge = Array.from({ length: 200_000 }, (_v, i) => `+line ${i} of a runaway diff that must be clipped`).join('\n');
    const hugeMsg: Extract<AgentMessage, { type: 'tool-result' }> = {
      type: 'tool-result', callId: 'huge', toolName: 'apply_patch', diff: `@@ -1,1 +1,${200_000} @@\n${huge}`,
    };
    let stashedBytes = 0;
    const clipped = buildDiffRefMessage(hugeMsg, 32 * 1024, (b) => {
      stashedBytes = Buffer.byteLength(b, 'utf8');
      return store.stashDiff('codex', 'sess-1', 'sess-1:huge', b);
    }) as any;
    check('oversized aggregate is clipped to the fetch bound before stashing', clipped.diffRef?.truncated === true && stashedBytes <= 1024 * 1024 && clipped.diffRef.byteSize === stashedBytes && stashedBytes > 32 * 1024, `stashed ${stashedBytes} bytes`);

    // 8. Oversized MULTI-FILE result: the strip keeps EVERY file's metadata (path/operation/rename),
    //    only the per-file diff bodies move to the ref — so the client re-splits into per-file boxes.
    const two = (n: string) => `diff --git a/${n} b/${n}\n--- a/${n}\n+++ b/${n}\n@@ -1,600 +1,600 @@\n${Array.from({ length: 600 }, (_v, i) => `-old line ${i} in ${n} with realistic width\n+new line ${i} in ${n} with realistic width`).join('\n')}`;
    const mfBody = `${two('lib/one.dart')}\n${two('lib/two.dart')}`;
    const multi: Extract<AgentMessage, { type: 'tool-result' }> = {
      type: 'tool-result', callId: 'mf', toolName: 'apply_patch', title: 'Changed 2 files', diff: mfBody,
      fileChanges: [
        { path: 'lib/one.dart', operation: 'edit', diff: two('lib/one.dart'), additions: 600, deletions: 600 },
        { path: 'src/gone.dart', previousPath: 'lib/two.dart', operation: 'rename', diff: two('lib/two.dart'), additions: 600, deletions: 600 },
      ],
    };
    const mfSwap = buildDiffRefMessage(multi, 32 * 1024, (b) => store.stashDiff('codex', 'sess-1', 'sess-1:mf', b)) as any;
    check(
      'oversized multi-file: per-file metadata (path/operation/rename) kept, bodies stripped, one diffRef',
      mfSwap.diffRef?.contentHash?.length === 64 &&
        mfSwap.fileChanges?.length === 2 &&
        mfSwap.fileChanges[0].diff === undefined && mfSwap.fileChanges[1].diff === undefined &&
        mfSwap.fileChanges[0].operation === 'edit' && mfSwap.fileChanges[0].path === 'lib/one.dart' &&
        mfSwap.fileChanges[1].operation === 'rename' && mfSwap.fileChanges[1].previousPath === 'lib/two.dart',
      JSON.stringify(mfSwap.fileChanges),
    );

    // 9. Page/cap-then-reference (the runtime's exact sequence): stash ONLY the outgoing messages, not
    //    the whole history. A 20-message history capped/paged to 5 must stash at most 5 diffs, not 20.
    const bigOne = bigDiff();
    const history: AgentMessage[] = Array.from({ length: 20 }, (_v, i) => ({
      type: 'tool-result', callId: `h${i}`, toolName: 'apply_patch', diff: bigOne,
    }));
    const durable = history.filter(isCursorDurableMessage);
    // Initial attach: cap to the newest 5, reference only those.
    const delta = capHistoryDelta(historyDelta(durable, undefined), 5, durable.length);
    let attachStashed = 0;
    delta.messages.forEach((m) => buildDiffRefMessage(m as any, 32 * 1024, (b) => { attachStashed++; return store.stashDiff('codex', 'sess-1', `attach:${attachStashed}`, b); }));
    check('attach caps THEN references — stashes only the 5 sent diffs, not all 20', delta.messages.length === 5 && attachStashed === 5, `sent=${delta.messages.length} stashed=${attachStashed}`);
    // Backward page: request 5 older; reference only the returned page.
    const page = backwardHistoryPage(durable, backwardHistoryCursor(durable, durable.length), 5);
    let pageStashed = 0;
    page.messages.forEach((m) => buildDiffRefMessage(m as any, 32 * 1024, (b) => { pageStashed++; return store.stashDiff('codex', 'sess-1', `page:${pageStashed}`, b); }));
    check('backward page references only the returned page, not the whole history', page.messages.length === 5 && pageStashed === 5, `page=${page.messages.length} stashed=${pageStashed}`);

    // 10. The env-tunable stash ceiling is CLAMPED to a non-negotiable hard cap — even an absurd
    //     override cannot let the broker serve an unbounded body (T1b R3 finding 2).
    check('default MAX_REFERENCED_DIFF_BYTES is within the hard ceiling', MAX_REFERENCED_DIFF_BYTES <= HARD_MAX_REFERENCED_DIFF_BYTES && HARD_MAX_REFERENCED_DIFF_BYTES === 4 * 1024 * 1024);
    const probe = Bun.spawnSync(
      ['bun', '-e', "import {MAX_REFERENCED_DIFF_BYTES as m, HARD_MAX_REFERENCED_DIFF_BYTES as h} from './packages/typescript/broker/src/sessions/diff-reference.ts'; console.log(JSON.stringify({m, h}))"],
      { cwd: process.cwd(), env: { ...process.env, COSYNCING_MAX_REFERENCED_DIFF_BYTES: String(999 * 1024 * 1024) } },
    );
    const clamp = JSON.parse(probe.stdout.toString().trim() || '{}');
    check('a huge COSYNCING_MAX_REFERENCED_DIFF_BYTES override is clamped to the hard ceiling', clamp.m === clamp.h && clamp.m === 4 * 1024 * 1024, JSON.stringify(clamp));

    // 11. The INLINE threshold is ALSO clamped to the hard ceiling — a too-high inline cap can't let a
    //     huge diff ship inline and bypass the referenced-body bound (T1b R4 finding 2).
    const inlineProbe = Bun.spawnSync(
      ['bun', '-e', "import {INLINE_DIFF_CAP as c, HARD_MAX_REFERENCED_DIFF_BYTES as h} from './packages/typescript/broker/src/sessions/diff-reference.ts'; console.log(JSON.stringify({c, h}))"],
      { cwd: process.cwd(), env: { ...process.env, COSYNCING_INLINE_DIFF_CAP_BYTES: String(999 * 1024 * 1024) } },
    );
    const inlineClamp = JSON.parse(inlineProbe.stdout.toString().trim() || '{}');
    check('a huge COSYNCING_INLINE_DIFF_CAP_BYTES override is clamped to the hard ceiling', inlineClamp.c === inlineClamp.h && inlineClamp.c === 4 * 1024 * 1024, JSON.stringify(inlineClamp));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

await main();
