/**
 * Claude takeover + shared-drive tests (issues 15a/15b), OFFLINE — no real claude, NO model cost:
 *
 *   15a (demote, never fork):
 *   - attach(resume) against a session whose live terminal owner is MID-TURN is refused with an
 *     OwnershipConflictError ('claude-terminal-busy'), not granted and never forked.
 *   - A live but IDLE terminal owner does not block takeover (in-place resume).
 *   - Re-attaching a session THIS adapter already drives bypasses the terminal-owner check (the
 *     owner map can see our own warm child; the hub joins the existing connection).
 *
 *   15b (shared driving ownership):
 *   - A resume attach registers drive ownership on the ADAPTER, so discoverSessions() — the roster
 *     every other client reads — reports driving while the connection lives, and observing again
 *     after close().
 *
 * Env is set BEFORE the dynamic import: the default store (CLAUDE_CONFIG_DIR) and the launch bin
 * (COSYNCING_CLAUDE_BIN) are resolved at module load. The fake bin answers `agents --json` from a
 * fixture file so the test controls the live-status overlay.
 *
 *   bun run packages/typescript/adapters/claude/test/test-claude-takeover.ts   (exit 0 = all pass)
 */
export {};
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ── fixtures + env (before import) ───────────────────────────────────────────
const ROOT = join(tmpdir(), 'ca-claude-takeover');
rmSync(ROOT, { recursive: true, force: true });

const configDir = join(ROOT, 'claude-config');
const fakeBin = join(ROOT, 'fake-claude');
process.env.CLAUDE_CONFIG_DIR = configDir;
process.env.COSYNCING_CLAUDE_BIN = fakeBin;
process.env.COSYNCING_CLAUDE_WRAPPER_DIR = join(ROOT, 'no-wrappers');

const workspace = join(ROOT, 'workspace');
const slugDir = join(configDir, 'projects', '-test-takeover');
const sessionsDir = join(configDir, 'sessions');
mkdirSync(workspace, { recursive: true });
mkdirSync(slugDir, { recursive: true });
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(ROOT, 'no-wrappers'), { recursive: true });

const U_BUSY = '66666666-6666-4666-8666-666666666666';
const U_IDLE = '77777777-7777-4777-8777-777777777777';

// Busy: an open trailing turn (user row, no terminal marker) — exact authority or a fresh fallback
// both keep a raw 'working' live. Idle: omitted from the agents overlay → no raw status at all.
const busyPath = join(slugDir, `${U_BUSY}.jsonl`);
writeFileSync(
  busyPath,
  JSON.stringify({ type: 'user', uuid: 'b1', cwd: workspace, timestamp: '2026-08-19T10:00:00.000Z', message: { role: 'user', content: 'a turn in flight' } }) + '\n',
);
const idlePath = join(slugDir, `${U_IDLE}.jsonl`);
writeFileSync(
  idlePath,
  [
    JSON.stringify({ type: 'user', uuid: 'i1', cwd: workspace, timestamp: '2026-08-19T09:00:00.000Z', message: { role: 'user', content: 'done turn' } }),
    JSON.stringify({ type: 'assistant', uuid: 'i2', timestamp: '2026-08-19T09:00:05.000Z', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'finished' }] } }),
  ].join('\n') + '\n',
);
// Live terminal owners for both (alive pid = this process).
writeFileSync(join(sessionsDir, '9001.json'), JSON.stringify({ sessionId: U_BUSY, pid: process.pid, cwd: workspace }));
writeFileSync(join(sessionsDir, '9002.json'), JSON.stringify({ sessionId: U_IDLE, pid: process.pid, cwd: workspace }));

// The fake bin answers `<bin> agents --json` from this file so the live-status overlay is test-controlled.
const agentsFile = join(ROOT, 'agents.json');
writeFileSync(agentsFile, JSON.stringify([{ sessionId: U_BUSY, status: 'busy' }]));
writeFileSync(fakeBin, `#!/usr/bin/env bash\nif [ "$1" = "agents" ]; then cat "${agentsFile}"; exit 0; fi\nexit 0\n`);
chmodSync(fakeBin, 0o755);

const enc = (p: string): string => Buffer.from(p, 'utf8').toString('base64url');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const { ClaudeAdapter, CLAUDE_TERMINAL_BUSY_CONFLICT } = await import('../src/index.ts');

// ── 15a: mid-turn terminal owner refuses takeover ────────────────────────────
const adapter = new ClaudeAdapter();
let refusal: any;
try {
  await adapter.attach(enc(busyPath), 'resume');
} catch (e) {
  refusal = e;
}
check(
  '15a: takeover against a MID-TURN terminal owner is refused (attach-conflict), never forked',
  refusal?.name === 'OwnershipConflictError' && refusal?.conflict === CLAUDE_TERMINAL_BUSY_CONFLICT,
  String(refusal),
);
check(
  '15a: the refusal names the hazard and the remedy',
  /running a turn/i.test(String(refusal?.message)) && /wait for the turn to finish|quit the terminal/i.test(String(refusal?.message)),
  String(refusal?.message),
);

// ── 15a/15b: idle terminal owner takes over in place and the ROSTER shows it ─
const conn = await adapter.attach(enc(idlePath), 'resume');
check('15a: a live but IDLE terminal owner does not block takeover', conn.info.control?.drive.state === 'driving');

const rosterDriven = await adapter.discoverSessions();
const drivenRow = rosterDriven.find((s) => s.id === enc(idlePath));
check(
  '15b: the roster row reports driving while another client holds the drive',
  drivenRow?.control?.drive.state === 'driving' && drivenRow.control?.drive.supported === true,
  JSON.stringify(drivenRow?.control?.drive),
);
const busyRow = rosterDriven.find((s) => s.id === enc(busyPath));
check(
  '15b: the refused session’s roster row stays observing (nobody drives it)',
  busyRow?.control?.drive.state === 'observing',
  JSON.stringify(busyRow?.control?.drive),
);

// Re-attach of the session we ALREADY drive bypasses the terminal-owner check: flip the live overlay
// to busy for it (our own warm child can look like an owner) and the attach must still be granted.
writeFileSync(agentsFile, JSON.stringify([{ sessionId: U_BUSY, status: 'busy' }, { sessionId: U_IDLE, status: 'busy' }]));
await sleep(2_600); // outlive the 2.5 s live-status cache so the flip is visible
const conn2 = await adapter.attach(enc(idlePath), 'resume');
check('15b: re-attaching an already-driven session is granted (registry bypass, hub joins)', conn2.info.control?.drive.state === 'driving');

// The hub's replaceForTakeover closes the STALE connection after the replacement registered — the
// registry must stay driving because the registered owner (conn2) is still open. Closing the
// replacement first would pass even with an identity-blind registry, so this order is the repro.
await conn.close();
const rosterMidSwap = await adapter.discoverSessions();
const midSwapRow = rosterMidSwap.find((s) => s.id === enc(idlePath));
check(
  '15b: a stale connection’s close() must not deregister the replacement drive',
  midSwapRow?.control?.drive.state === 'driving',
  JSON.stringify(midSwapRow?.control?.drive),
);

await conn2.close();
const rosterAfter = await adapter.discoverSessions();
const afterRow = rosterAfter.find((s) => s.id === enc(idlePath));
check(
  '15b: close() deregisters the drive — the roster row reverts to observing',
  afterRow?.control?.drive.state === 'observing' && afterRow.control?.drive.supported === true,
  JSON.stringify(afterRow?.control?.drive),
);

rmSync(ROOT, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
