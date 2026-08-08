/**
 * Zero-cost L0/L1 test for Claude `exportTranscript` (gated R2 transcriptExport) — closed the discovered
 * Claude export gap 2026-07-08. Claude has no native export; its session JSONL is the transcript, so the
 * adapter copies it into the broker temp dir (the broker then redacts + delivers via the generic R2
 * pipeline). Verifies: happy-path copy + format; the attach-style path-containment guard refuses an id
 * resolving outside the known store roots (incl. a planted symlink); the size cap is enforced before the
 * copy; and the broker hook-endpoint guard (`isClaudeTranscriptPathAllowed`) shares the same realpath
 * containment. No model, no cost.
 *
 *   bun run scripts/broker/tests/claude/test-claude-export.ts
 */
export {};
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const enc = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

// Point the Claude default store at a temp config dir BEFORE importing the adapter (DEFAULT_CONFIG_DIR is
// frozen at module load from CLAUDE_CONFIG_DIR), then dynamic-import so the store roots see our temp tree.
const configDir = mkdtempSync(join(tmpdir(), 'cosyncing-claude-export-'));
process.env.CLAUDE_CONFIG_DIR = configDir;
process.env.COSYNCING_CLAUDE_WRAPPER_DIR = join(configDir, 'no-bin'); // isolate: no wrappers

const projectsRoot = join(configDir, 'projects', 'proj-a');
mkdirSync(projectsRoot, { recursive: true });
const jsonlPath = join(projectsRoot, '11111111-1111-4111-8111-111111111111.jsonl');
const transcriptBody =
  JSON.stringify({ type: 'session_meta', cwd: projectsRoot }) + '\n' +
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello export' } }) + '\n' +
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'hi' } }) + '\n';
writeFileSync(jsonlPath, transcriptBody);

const { ClaudeAdapter, isClaudeTranscriptPathAllowed } = await import('../../../../packages/typescript/adapters/claude/src/index.ts');
const adapter = new ClaudeAdapter();
const tempDir = mkdtempSync(join(tmpdir(), 'cosyncing-claude-export-out-'));

try {
  check('transcriptExportFormat is json', adapter.transcriptExportFormat === 'json');

  // Happy path: copies the JSONL into the broker temp dir, returns { path, format }.
  const out = await adapter.exportTranscript(enc(jsonlPath), { tempDir, maxBytes: 25 * 1024 * 1024, timeoutMs: 10_000 });
  const copied = out.path.startsWith(tempDir) && existsSync(out.path) && readFileSync(out.path, 'utf8') === transcriptBody;
  check('export copies the session JSONL into the broker tempDir with format json', out.format === 'json' && copied, `path=${out.path}`);

  // Path containment: an id resolving OUTSIDE the known store roots is refused (crafted-id exfiltration).
  let escaped = false;
  try {
    await adapter.exportTranscript(enc('/etc/passwd'), { tempDir, maxBytes: 25 * 1024 * 1024, timeoutMs: 10_000 });
  } catch {
    escaped = true;
  }
  check('export REFUSES an id outside the known projects roots', escaped);

  // A .jsonl path inside the root but non-existent is refused (not-found), not a silent empty export.
  let missing = false;
  try {
    await adapter.exportTranscript(enc(join(projectsRoot, 'does-not-exist.jsonl')), { tempDir, maxBytes: 25 * 1024 * 1024, timeoutMs: 10_000 });
  } catch {
    missing = true;
  }
  check('export refuses a missing transcript file', missing);

  // Finding #1 (Fable review 2026-07-08): a symlink INSIDE the projects root pointing OUTSIDE it must be
  // refused. The target is itself a small regular `.jsonl`, so it passes every OTHER check (extension,
  // exists, isFile, size) — only the realpath containment can reject it. Pre-fix (resolve()+statSync) it
  // would have exported the out-of-root file.
  const outsideSecret = join(configDir, 'outside-secret.jsonl');
  writeFileSync(outsideSecret, JSON.stringify({ type: 'secret', value: 'id_rsa contents' }) + '\n');
  const planted = join(projectsRoot, 'evil.jsonl');
  let symlinkRefused = false;
  try {
    symlinkSync(outsideSecret, planted);
    await adapter.exportTranscript(enc(planted), { tempDir, maxBytes: 25 * 1024 * 1024, timeoutMs: 10_000 });
  } catch {
    symlinkRefused = true;
  }
  check('export REFUSES a symlink escaping the projects root (realpath containment, finding #1)', symlinkRefused);

  // Fable re-review 2026-07-09: the broker hook-endpoint guard shares the SAME realpath containment
  // (it feeds ClaudeObserveConnection, which tails and broadcasts the file UNREDACTED — a resolve()-only
  // check would accept the planted symlink above). Missing files stay allowed: SessionStart can fire
  // before the JSONL exists, and a nonexistent path cannot exfiltrate anything.
  check('hook guard allows a real transcript inside the projects root', isClaudeTranscriptPathAllowed(jsonlPath));
  check('hook guard allows a not-yet-written transcript inside the root', isClaudeTranscriptPathAllowed(join(projectsRoot, 'not-yet-written.jsonl')));
  check('hook guard REFUSES a path outside the projects roots', !isClaudeTranscriptPathAllowed('/etc/passwd.jsonl'));
  check('hook guard REFUSES a symlink escaping the projects root (realpath containment)', !isClaudeTranscriptPathAllowed(planted));

  // Size cap enforced BEFORE the copy.
  let tooLarge = false;
  try {
    await adapter.exportTranscript(enc(jsonlPath), { tempDir, maxBytes: 8, timeoutMs: 10_000 });
  } catch {
    tooLarge = true;
  }
  check('export enforces the size cap before copying', tooLarge);
} finally {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(tempDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\nFAIL: ${failed.length}/${results.length} claude export check(s) failed.`);
  process.exit(1);
}
console.log(`\nPASS ${results.length}/${results.length} claude export checks`);
