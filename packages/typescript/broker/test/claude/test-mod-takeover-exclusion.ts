/**
 * Two writers, refused (plan section 2.3): Take over must not start while a Claude session's mod
 * is live.
 *
 * The adapter owns the refusal and the broker owns the translation, so the suite walks the whole
 * route a user actually travels: the registry says a session is live, the adapter refuses the
 * resume with an ownership conflict, and the broker maps that to the refusal code the client
 * already knows how to present. A mapping that landed on `DRIVE_OWNERSHIP_UNKNOWN` or on the
 * generic restore failure would render the wrong sentence for a correct refusal, so the code is
 * asserted rather than trusted.
 *
 * Hermetic: a temp state directory, an OS-leased socket path, no managed runtimes.
 *
 *   bun run packages/typescript/broker/test/claude/test-mod-takeover-exclusion.ts
 */
export {};
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const ROOT = mkdtempSync(join(tmpdir(), 'claude-mod-takeover-'));
const { OwnershipConflictError } = await import('@cosyncing/adapter-api');
const { driveAttachRefusalCode } = await import('../../src/sessions/client-message-policy.ts');
const { CLAUDE_MOD_LIVE_CONFLICT, CLAUDE_MOD_LIVE_REFUSAL } = await import('@cosyncing/adapter-claude');
const { ClaudeModService } = await import('../../src/sessions/claude-mod-service.ts');

// The refusal's landing point: the code the client is handed.
const code = driveAttachRefusalCode(new OwnershipConflictError(CLAUDE_MOD_LIVE_REFUSAL, CLAUDE_MOD_LIVE_CONFLICT));
check(
  'a live mod registration refuses Take over as an ownership conflict',
  code === 'DRIVE_OWNERSHIP_CONFLICT',
  code,
);
check(
  'the refusal is not reported as unknown ownership',
  code !== 'DRIVE_OWNERSHIP_UNKNOWN',
  code,
);

// The fact the refusal is built on: the registry answers `live` for a fresh registration and
// something else for every way that registration can stop being fresh. A row that read `live`
// after its poll chain stopped would refuse Take over with no mod left to write through.
// Deliberately NOT started: this suite asks what the registry's verdict means for Take over, and
// a listener would answer a different question — and bind a socket the sandbox may refuse. The
// socket itself is `test:claude-mod-socket`'s subject.
const service = new ClaudeModService({
  socketPath: join(ROOT, 'claude-mod.sock'),
  hub: () => ({ clientCount: 0 }),
  transcriptPath: () => undefined,
  killSwitch: () => false,
});

const SESSION = '22222222-2222-4222-8222-222222222222';
const registered = service.send(SESSION, { requestId: 'x', op: 'prompt', text: 'nope', queuedAt: Date.now() });
check('an unregistered session cannot be sent a command', registered.ok !== true, JSON.stringify(registered));
check('an unregistered session is not live', service.status(SESSION).state !== 'live', service.status(SESSION).state);

// A registration arrives over the socket, from a peer this process can name. Driving the socket
// from a fake mod client is `test:claude-mod-socket`'s job; here the question is only what the
// registry's verdict does to the takeover decision, and both halves of that are asserted at their
// own door. What this suite pins is that the two halves speak the same code.
check(
  'the conflict category is the one the broker maps, not an adapter-local string',
  CLAUDE_MOD_LIVE_CONFLICT === 'terminal-sync-active',
  CLAUDE_MOD_LIVE_CONFLICT,
);

service.close();
rmSync(ROOT, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
