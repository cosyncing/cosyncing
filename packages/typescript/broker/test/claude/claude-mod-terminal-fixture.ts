/**
 * One terminal's mod, in a process of its own, for the suites that need a claimant they can
 * `kill -9` or stop. It loads the shipped `register.js` behind the seam harness's `$`, fires
 * `session.start`, and then lives until its parent closes stdin, or two minutes pass, whichever
 * comes first, so a suite that dies cannot leave it behind.
 *
 * Environment:
 *   FIXTURE_SOCKET   the broker socket path (absolute)
 *   FIXTURE_SESSION  the Claude session id this terminal claims
 *   FIXTURE_HOME     a HOME for the mod's environment
 *   FIXTURE_TIMING   JSON handed to the mod's `tuneForTest`
 *   FIXTURE_ASK      optional: a Bash command this terminal asks permission for once it is up,
 *                    so the broker has a card standing for a process that can then be killed
 *
 * Not a suite; spawned by `test-claude-mod-lifecycle-seam.ts`.
 */
import { loadMod, until } from './claude-mod-seam-harness.ts';

const socket = process.env.FIXTURE_SOCKET ?? '';
const sessionId = process.env.FIXTURE_SESSION ?? '';
if (!socket.startsWith('/') || !sessionId) {
  process.stderr.write('fixture needs FIXTURE_SOCKET and FIXTURE_SESSION\n');
  process.exit(2);
}

// The last line of defence against an orphan: a parent that vanished without closing stdin.
setTimeout(() => process.exit(0), 120_000);
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
process.stdin.resume();

const mod = await loadMod('fixture-terminal', {
  env: { COSYNCING_CLAUDE_SOCK: socket, HOME: process.env.FIXTURE_HOME ?? '/' },
  sessionId,
});
(mod.exports.tuneForTest as (overrides: unknown) => void)(JSON.parse(process.env.FIXTURE_TIMING ?? '{}'));
await mod.fire('session.start', { cwd: '/work', surface: 'terminal', isInteractive: true });
process.stdout.write(`started ${process.pid}\n`);
if (process.env.FIXTURE_ASK) {
  // Asked once the terminal is registered and polling: before that the mod holds nothing.
  await until(() => mod.record.requests.some((request) => request.route === 'poll'), 10_000);
  // Not awaited: a held call waits for an answer this terminal may be killed before it gets.
  void mod.fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-fixture-1', input: { command: process.env.FIXTURE_ASK } }).catch(() => undefined);
}
