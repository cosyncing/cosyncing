#!/usr/bin/env bun
/**
 * Claude across TWO sockets on one broker: one Drive connection, one writer — and the reason it
 * matters is a page reload.
 *
 * Physical pass 2026-08-20, P1: "steering badge lost on refresh" and "the queued message disappeared
 * after refresh". Reproduced against the real web client: a reloaded page that cannot prove its Drive
 * provenance locally (storage reset, a lapsed takeover lease, a different device) attaches BARE, and
 * the broker handed it the read-only observe connection — whose history is the transcript alone —
 * while this broker's own `claude -p --resume` child, its connection, and its still-undelivered
 * prompts sat alive under `#resume`. Nothing told the page. `Hub.sessionDetailFrame` offers the join
 * only when the backend declares `supportsCrossClientDriveSharing`, and Claude did not.
 *
 * Runs the REAL adapter (temp store, fake `claude` binary that reads stdin and never answers) through
 * a real Hub. No model, no network.
 *
 *   bun run packages/typescript/broker/test/broker/test-claude-cross-client-join.ts
 */
export {};
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

let failures = 0;
const check = (label: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  — ${extra}` : ''}`);
  if (!ok) failures += 1;
};

// The adapter binds its default store and launch binary at module load, so the fixture environment
// is in place BEFORE the import below.
const root = mkdtempSync(join(tmpdir(), 'claude-join-'));
const configDir = join(root, 'claude-config');
const workspace = join(root, 'ws');
const bin = join(root, 'bin');
for (const d of [configDir, workspace, bin]) mkdirSync(d, { recursive: true });
const fakeClaude = join(bin, 'claude');
writeFileSync(fakeClaude, `#!/usr/bin/env bun
// A drive child that accepts prompts on stdin and never echoes them to the transcript: the
// "steer sent, not yet delivered" state a reload must survive.
for await (const _ of Bun.stdin.stream()) { /* hold the prompt */ }
`);
chmodSync(fakeClaude, 0o755);
process.env.CLAUDE_CONFIG_DIR = configDir;
process.env.COSYNCING_CLAUDE_BIN = fakeClaude;
process.env.PATH = `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`;

const { Hub } = await import('../../src/sessions/hub.ts');
const { AgentRegistry } = await import('../../../adapter-api/src/index.ts');
const { ClaudeAdapter } = await import('../../../adapters/claude/src/index.ts');
type AttachMode = import('../../../adapter-api/src/index.ts').AttachMode;
type SessionConnection = import('../../../adapter-api/src/index.ts').SessionConnection;

const adapter = new ClaudeAdapter();
let attachCalls = 0;
const realAttach = adapter.attach.bind(adapter);
adapter.attach = ((id: string, mode?: AttachMode): Promise<SessionConnection> => {
  attachCalls += 1;
  return realAttach(id, mode);
}) as typeof adapter.attach;

const registry = new AgentRegistry();
registry.register(adapter);
const hub = new Hub(registry, 15_000);

/** The transcript path a Claude session id names (the id is the base64url of the path). */
function transcriptPathOf(id: string): string {
  return Buffer.from(id.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

const users = (history: any[]) => history.filter((m) => m?.type === 'user-message').map((m) => ({ key: m.key, text: m.text, queued: m.queued }));

try {
  check('0 the adapter advertises cross-client Drive sharing', adapter.capabilities.supportsCrossClientDriveSharing === true);

  const created = await adapter.createSession({ directory: workspace, title: 'join' });
  // One delivered exchange on disk, so the observe connection has a real transcript to replay.
  const path = transcriptPathOf(created.id);
  mkdirSync(dirname(path), { recursive: true });
  const uuid = path.split('/').pop()!.replace(/\.jsonl$/, '');
  const t = new Date().toISOString();
  writeFileSync(path,
    JSON.stringify({ type: 'user', uuid: 'seed-u1', parentUuid: null, isSidechain: false, sessionId: uuid, cwd: workspace, timestamp: t, message: { role: 'user', content: 'hello from the seed' } }) + '\n'
    + JSON.stringify({ type: 'assistant', uuid: 'seed-a1', parentUuid: 'seed-u1', isSidechain: false, sessionId: uuid, cwd: workspace, timestamp: t, message: { id: 'msg_seed', type: 'message', role: 'assistant', model: 'claude-opus-4-8-20260701', content: [{ type: 'text', text: 'Seeded reply.' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n');

  // ── A. The reload shape: owner alive with an undelivered prompt, then a bare attach ─────────────
  const owner = await hub.ensure('claude', created.id, 'resume');
  owner.addClient(() => {});
  const ownerFrame = hub.sessionDetailFrame(owner, true);
  check('A1 the resume attach is the session-level Drive owner',
    ownerFrame.authority?.canMutate === true && ownerFrame.info.control?.drive?.state === 'driving', JSON.stringify(ownerFrame.info.control?.drive));

  await owner.conn.sendPrompt({ text: 'steer me please' });
  const ownerHistory = users(await owner.conn.getHistory());
  check('A2 the owner replays the accepted prompt as its pending row',
    ownerHistory.some((u) => /^queued:app:/.test(String(u.key)) && u.text === 'steer me please' && u.queued === true), JSON.stringify(ownerHistory));

  const observer = await hub.ensure('claude', created.id);
  observer.addClient(() => {});
  check('A3 a bare attach gets a DIFFERENT connection, not the driver', observer !== owner && observer.conn !== owner.conn);
  const observerHistory = users(await observer.conn.getHistory());
  check('A4 ...whose history is the transcript alone: the undelivered prompt is NOT in it (the reported symptom)',
    !observerHistory.some((u) => u.text === 'steer me please') && observerHistory.some((u) => u.text === 'hello from the seed'), JSON.stringify(observerHistory));

  const observerFrame = hub.sessionDetailFrame(observer, true);
  check('A5 the bare socket stays read-only...', observerFrame.authority?.canMutate === false);
  check('A6 ...and is offered the join Claude used not to advertise',
    observerFrame.joinExisting !== undefined && typeof observerFrame.joinExisting.ownerRevision?.epoch === 'string', JSON.stringify(observerFrame.joinExisting));

  const attachBefore = attachCalls;
  const joined = hub.joinExisting('claude', created.id, observerFrame.joinExisting!.ownerRevision);
  check('A7 the join reuses the EXACT drive connection — still one writer, one child', joined === owner && joined.conn === owner.conn);
  check('A8 ...and performs no native attach', attachCalls === attachBefore, `attachCalls=${attachCalls}`);
  const joinedHistory = users(await joined.conn.getHistory());
  check('A9 the joined socket replays the undelivered prompt — the row a reload used to lose',
    joinedHistory.some((u) => /^queued:app:/.test(String(u.key)) && u.text === 'steer me please' && u.queued === true), JSON.stringify(joinedHistory));
  const joinedFrame = hub.sessionDetailFrame(joined, true);
  check('A10 the joined socket has mutation authority and is offered no second join',
    joinedFrame.authority?.canMutate === true && joinedFrame.joinExisting === undefined, JSON.stringify(joinedFrame.authority));

  // ── B. Boundaries the share must keep ─────────────────────────────────────────────────────────
  check('B1 a socket that suppressed the action is offered no join',
    hub.sessionDetailFrame(observer, false).joinExisting === undefined);
  // A declared read-only socket keeps its authority denial even when the action is allowed — the two
  // are separate facts, and the runtime ties them together on the socket's behalf (it suppresses the
  // action for a read-only or unauthenticated socket).
  const readOnlyFrame = hub.sessionDetailFrame(observer, true, observer.conn.info, true);
  check('B2 a declared read-only socket is never given mutation authority', readOnlyFrame.authority?.canMutate === false, JSON.stringify(readOnlyFrame.authority));
  let stale: unknown;
  try {
    hub.joinExisting('claude', created.id, { epoch: 'not-this-owner', seq: 0 });
  } catch (error) {
    stale = error;
  }
  check('B3 a stale owner revision fails closed', stale instanceof Error && /owner/i.test(String((stale as Error).message)), String(stale));
} catch (error) {
  check('suite threw', false, String(error));
} finally {
  await hub.dispose().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`);
process.exit(failures ? 1 : 0);
