#!/usr/bin/env bun
/**
 * Source-development utility for installing (or removing) the deferred Claude live-sync hooks.
 *
 * After install, every `claude` session the user starts becomes Tier-1 sync-controllable from the phone —
 * permission prompts AND AskUserQuestion questions can be answered remotely, with NO `claude/channel`
 * allowlist (a hook is the user's own trusted local callback). See
 * docs/protocol/adapter-support.md.
 *
 *   bun run scripts/broker/install-claude-hooks.ts [--broker http://127.0.0.1:7734] [--uninstall] [--status]
 *
 * Hooks are not part of cosyncing v1 and packaged builds expose no install surface. A source broker accepts
 * this harness only when started through the explicit D14 development bypass (COSYNCING_DEV_MODE=1).
 */
import { installClaudeHooks, uninstallClaudeHooks, claudeHooksInstalled, claudeHooksSettingsPath, CLAUDE_HOOK_SCRIPT } from '../../packages/typescript/adapters/claude/src/index.ts';

const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const broker = (arg('--broker') ?? process.env.COSYNCING_BROKER ?? 'http://127.0.0.1:7734').replace(/\/$/, '');
const settingsPath = claudeHooksSettingsPath();

if (args.includes('--status')) {
  console.log(`settings: ${settingsPath}`);
  console.log(`hook script: ${CLAUDE_HOOK_SCRIPT}`);
  console.log(`installed: ${claudeHooksInstalled(settingsPath) ? 'yes' : 'no'}`);
} else if (args.includes('--uninstall')) {
  const r = uninstallClaudeHooks();
  console.log(r.changed ? `Removed cosyncing live-sync hooks from ${r.path}` : `No cosyncing hooks found in ${r.path}`);
} else {
  console.warn('Development-only: Claude hooks are deferred from cosyncing v1 and are unsupported in packaged builds.');
  const r = installClaudeHooks({ brokerUrl: broker });
  console.log(`Installed deferred Claude live-sync hooks → ${r.path}`);
  console.log(`  broker: ${broker}`);
  console.log('  Start (or restart) claude, and run the source broker with COSYNCING_DEV_MODE=1.');
}
