#!/usr/bin/env bun
/**
 * Drive-mode insertion test — does Claude "Drive" (`claude -p --resume <uuid> --fork-session`) let us
 * INSERT a turn into an existing session and get a response that reflects the resumed history?
 *
 * This is the fallback question after the sync/channel finding: the live channel can DISPLAY a permission
 * prompt but cannot ANSWER it (not on Anthropic's curated allowlist). So is Drive the one Claude control
 * mode that actually works? Drive is `-p` (non-interactive) — no TTY — so we drive it via stdin/stdout,
 * mirroring ClaudeResumeConnection's exact argv (packages/typescript/adapters/claude/src/index.ts ~502-503):
 *   NEW session:      claude -p --session-id <uuid> --output-format stream-json --input-format stream-json …
 *   EXISTING (drive): claude -p --resume <uuid> --fork-session --output-format stream-json --input-format … --verbose
 *
 * Plan:
 *   1. Create a session in a throwaway dir and plant a codeword (materializes the transcript).
 *   2. DRIVE it: --resume <uuid> --fork-session, INSERT a question, read the assistant reply.
 *   3. PASS iff the forked reply recalls the codeword → insertion works AND history survives the fork.
 *
 * Usage:  bun run scripts/broker/coexistence-test/drive-test.ts [--model haiku] [--keep] [--stream]
 *   --stream : also run the drive turn via stream-json stdin/stdout (the EXACT adapter wire form)
 * Logs to ~/.claude/cosyncing/bridge/drive-test.log.
 */
import { mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const WORK = '/tmp/drive-test';
const BRIDGE = join(homedir(), '.claude', 'cosyncing', 'bridge');
const LOG = join(BRIDGE, 'drive-test.log');
const args = process.argv.slice(2);
const KEEP = args.includes('--keep');
const STREAM = args.includes('--stream');
const MODEL = (args.includes('--model') ? args[args.indexOf('--model') + 1] : undefined) ?? 'haiku';
const CODEWORD = 'BANANA-' + Math.floor(Math.random() * 1e6); // unique so a stray cached reply can't fake a pass

const ts = () => new Date().toISOString();
function log(s: string): void { const l = `${ts()} ${s}`; console.log(l); try { mkdirSync(BRIDGE, { recursive: true }); appendFileSync(LOG, l + '\n'); } catch {} }

function run(argv: string[], stdin?: unknown): { code: number; out: string; err: string } {
  // NB: claude's stream-json stdin reader needs a real fd — pass `Bun.file(path)`. Neither a Uint8Array nor a
  //     Blob delivered under Bun.spawnSync (the prod adapter uses async spawn + stdin.write, index.ts ~1740).
  const p = Bun.spawnSync(['claude', ...argv], { cwd: WORK, stdin: stdin as any });
  return { code: p.exitCode ?? -1, out: new TextDecoder().decode(p.stdout), err: new TextDecoder().decode(p.stderr) };
}
// pull readable assistant text out of stream-json stdout
function assistantText(streamOut: string): string {
  const parts: string[] = [];
  for (const ln of streamOut.split('\n')) {
    const t = ln.trim(); if (!t) continue;
    try { const o = JSON.parse(t);
      if (o.type === 'assistant' && o.message?.content) for (const c of o.message.content) if (c.type === 'text') parts.push(c.text);
      if (o.type === 'result' && typeof o.result === 'string') parts.push(o.result);
    } catch {}
  }
  return parts.join(' ');
}

let verdict = 'INCONCLUSIVE';
try {
  log(`=== drive-test start (model=${MODEL} codeword=${CODEWORD} stream=${STREAM}) ===`);
  rmSync(WORK, { recursive: true, force: true }); mkdirSync(WORK, { recursive: true });
  const uuid = crypto.randomUUID();

  // 1) CREATE the session + plant the codeword (NEW-session form: --session-id, no --resume/--fork)
  log(`1) create session ${uuid} and plant codeword…`);
  const c = run(['-p', `Remember this codeword for later: ${CODEWORD}. Reply with just: OK`, '--session-id', uuid, '--model', MODEL, '--permission-mode', 'bypassPermissions']);
  log(`   create exit=${c.code} out=${JSON.stringify(c.out.slice(0, 160))}${c.err ? ' err=' + JSON.stringify(c.err.slice(0, 160)) : ''}`);
  if (c.code !== 0) throw new Error('session create failed');

  // 2) DRIVE: resume+fork and INSERT a question (EXISTING form, the real Drive argv)
  log(`2) DRIVE (resume+fork) and INSERT a question…`);
  const d = run(['-p', 'What codeword did I tell you to remember? Reply with ONLY the codeword.', '--resume', uuid, '--fork-session', '--model', MODEL, '--permission-mode', 'bypassPermissions']);
  log(`   drive exit=${d.code} reply=${JSON.stringify(d.out.slice(0, 200))}${d.err ? ' err=' + JSON.stringify(d.err.slice(0, 160)) : ''}`);
  const recalled = d.out.includes(CODEWORD);
  log(`   → codeword recalled after fork: ${recalled}`);

  // 3) OPTIONAL diagnostic: the EXACT adapter wire form — stream-json stdin/stdout. Non-gating: the plain
  //    drive above is the authoritative insertion proof; this just confirms the adapter's wire encoding too.
  if (STREAM) {
    log(`3) DRIVE via stream-json stdin/stdout (exact adapter wire form)…`);
    const userMsg = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Repeat the codeword I gave you, nothing else.' }] } }) + '\n';
    // Use async spawn + stdin.write — the EXACT mechanism ClaudeResumeConnection uses (index.ts ~1740).
    // (Bun.spawnSync does not deliver stdin to claude's stream-json reader; async piped stdin does.)
    const proc = Bun.spawn(['claude', '-p', '--resume', uuid, '--fork-session', '--output-format', 'stream-json', '--input-format', 'stream-json', '--include-partial-messages', '--verbose', '--model', MODEL, '--permission-mode', 'bypassPermissions'], { cwd: WORK, stdin: 'pipe', stdout: 'pipe' });
    proc.stdin.write(userMsg); await proc.stdin.end();
    const sOut = await new Response(proc.stdout).text(); await proc.exited;
    const txt = assistantText(sOut);
    log(`   stream exit=${proc.exitCode} bytes=${sOut.length} assistantText=${JSON.stringify(txt.slice(0, 160))} recalled=${txt.includes(CODEWORD)}`);
  }

  // Verdict is gated ONLY on the plain drive — the authoritative "can Drive insert a turn?" proof.
  verdict = recalled ? 'PASS' : 'FAIL';
  log(`\n=== VERDICT: ${verdict} ===  Drive ${recalled ? 'CAN' : 'CANNOT'} insert a turn into a resumed (forked) session.`);
} catch (e) {
  log('ERROR ' + String(e)); verdict = 'ERROR';
} finally {
  if (!KEEP) rmSync(WORK, { recursive: true, force: true });
  log(`drive-test done: ${verdict}${KEEP ? ' (dir kept)' : ''}`);
  process.exit(verdict === 'PASS' ? 0 : 1);
}
