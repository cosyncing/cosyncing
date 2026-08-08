/**
 * Claude live-sync hook INSTALL — idempotent settings.json edit (NO claude, NO broker, NO model cost).
 * Proves install/uninstall add and remove ONLY our hooks, preserve unrelated user hooks, and don't duplicate.
 *
 *   bun run scripts/broker/tests/claude/test-claude-hooks-install.ts   (exit 0 = all pass)
 */
export {};
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installClaudeHooks, uninstallClaudeHooks, claudeHooksInstalled } from '../../../../packages/typescript/adapters/claude/src/index.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const work = mkdtempSync(join(tmpdir(), 'claude-hooks-install-'));
const settingsPath = join(work, 'settings.json');
const BROKER = 'http://127.0.0.1:7734';
const read = () => JSON.parse(readFileSync(settingsPath, 'utf8'));
const ourEntries = (arr: any[]) => (arr ?? []).filter((e) => e.hooks?.some((h: any) => String(h.command).includes('cosyncing-hook')));

try {
  // Seed an UNRELATED pre-existing user hook so we can prove we preserve it.
  writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-hook' }] }] } }, null, 2));

  installClaudeHooks({ brokerUrl: BROKER, settingsPath });
  let s = read();
  check('PreToolUse has our entry + preserves the user hook', ourEntries(s.hooks.PreToolUse).length === 1 && s.hooks.PreToolUse.some((e: any) => e.hooks[0].command === 'echo user-hook'), `entries=${s.hooks.PreToolUse.length}`);
  check('SessionStart hello + SessionEnd bye installed', ourEntries(s.hooks.SessionStart).length === 1 && ourEntries(s.hooks.SessionEnd).length === 1, '');
  check('turn-boundary status hooks installed (UserPromptSubmit working + Stop idle)',
    ourEntries(s.hooks.UserPromptSubmit).length === 1 && / working$/.test(ourEntries(s.hooks.UserPromptSubmit)[0].hooks[0].command) && ourEntries(s.hooks.Stop).length === 1 && / idle$/.test(ourEntries(s.hooks.Stop)[0].hooks[0].command), '');
  const preCmd = ourEntries(s.hooks.PreToolUse)[0].hooks[0].command;
  check('command carries broker URL + request mode + matcher', preCmd.includes(BROKER) && / request$/.test(preCmd) && ourEntries(s.hooks.PreToolUse)[0].matcher.includes('Bash'), preCmd.slice(0, 80));
  check('claudeHooksInstalled() true', claudeHooksInstalled(settingsPath), '');

  // Idempotent: re-install must not duplicate.
  installClaudeHooks({ brokerUrl: BROKER, settingsPath });
  s = read();
  check('re-install is idempotent (no duplicate)', ourEntries(s.hooks.PreToolUse).length === 1 && s.hooks.PreToolUse.length === 2, `pre=${s.hooks.PreToolUse.length}`);

  // Uninstall removes ours, keeps the user hook.
  const u = uninstallClaudeHooks({ settingsPath });
  s = read();
  check('uninstall removes ours, keeps user hook', u.changed && ourEntries(s.hooks.PreToolUse ?? []).length === 0 && (s.hooks.PreToolUse ?? []).some((e: any) => e.hooks[0].command === 'echo user-hook'), JSON.stringify(s.hooks.PreToolUse ?? null));
  check('all our events fully removed (SessionStart/End, UserPromptSubmit, Stop)', !s.hooks.SessionStart && !s.hooks.SessionEnd && !s.hooks.UserPromptSubmit && !s.hooks.Stop, JSON.stringify(Object.keys(s.hooks)));
  check('claudeHooksInstalled() false after uninstall', !claudeHooksInstalled(settingsPath), '');
} catch (e) {
  check('no exception', false, String(e));
} finally {
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? `❌ ${failed.length}/${results.length} FAILED` : `✅ ${results.length}/${results.length} passed`}`);
process.exit(failed.length ? 1 : 0);
