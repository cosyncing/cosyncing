/**
 * Zero-cost L0 test for Codex `forkSession` (thread/fork) — closed the discovered fork gap 2026-07-08.
 * Backed by a fake `codex app-server --stdio` binary (COSYNCING_CODEX_BIN) that answers thread/fork with a
 * synthetic forked thread (new rollout path, forkedFromId set) and materializes the fork rollout on disk
 * (real Codex writes it lazily, so the adapter forces it via thread/name/set + existsSync wait). No real
 * Codex, no model, no cost. Asserts the fork RPC response maps to a correct canonical SessionInfo,
 * and (CR4) that a user-initiated fork of an agent-owned SOURCE is refused before anything is created.
 *
 *   bun run packages/typescript/adapters/codex/test/test-codex-fork.ts
 */
export {};
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAgentOwnedSessionError, isOwnershipConflictError } from '../../../adapter-api/src/index.ts';
import { CodexAdapter } from '../src/index.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
const rand = () => Math.random().toString(36).slice(2, 8);

async function test(name: string, fn: () => Promise<[boolean, string]>): Promise<void> {
  try {
    const [ok, detail] = await fn();
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  } catch (err) {
    results.push({ name, ok: false, detail: String(err) });
    console.log(`FAIL  ${name}  — threw: ${err}`);
  }
}

// A fake `codex` whose app-server answers thread/fork by writing the fork rollout to __FORKPATH__ and
// returning the forked Thread; thread/name/set just materializes/acks (real codex lazy-writes).
const FAKE = `#!/usr/bin/env bun
const enc = new TextDecoder();
const fs = require('fs');
// Spawn witness, written before a single byte of stdin is read: the refusal check below proves the
// adapter never CONTACTED codex, not merely that no rollout was left behind.
fs.writeFileSync('__SPAWNMARK__', process.argv.slice(2).join(' ') + '\\n');
let buf = '';
const send = (o) => console.log(JSON.stringify(o));
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/fork') {
      fs.writeFileSync('__FORKPATH__', JSON.stringify({ type: 'session_meta', payload: Object.assign({ id: 'forked-thread', cwd: '__DIR__' }, __FORKMETA__) }) + '\\n');
      send({ id: msg.id, result: {
        thread: {
          id: 'forked-thread',
          sessionId: 'session-tree-1',
          forkedFromId: msg.params.threadId,
          path: '__FORKPATH__',
          cwd: '__DIR__',
          name: 'Source thread (fork)',
          createdAt: 1800000010,
          updatedAt: 1800000011,
          turns: []
        },
        cwd: '__DIR__',
        model: 'fake-model',
        modelProvider: 'fake-provider',
        reasoningEffort: 'high'
      } });
    }
    else if (msg.method === 'thread/name/set') send({ id: msg.id, result: {} });
    else if (msg.id != null) send({ id: msg.id, result: {} });
  }
}
`;

await test('forkSession maps thread/fork to a canonical forked SessionInfo', async () => {
  const dir = `/tmp/cosyncingcodexfork${rand()}`;
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const sourceRollout = join(dir, 'rollout-2026-06-16T00-00-00-00000000-0000-4000-8000-000000000000.jsonl');
  writeFileSync(sourceRollout, JSON.stringify({ type: 'session_meta', payload: { id: 'source-thread', cwd: dir } }) + '\n');
  const forkPath = join(dir, 'rollout-2026-06-16T00-00-01-11111111-1111-4111-8111-111111111111.jsonl');
  const fake = join(binDir, 'codex');
  writeFileSync(
    fake,
    FAKE.replace(/__DIR__/g, dir)
      .replace(/__FORKPATH__/g, forkPath)
      .replace(/__SPAWNMARK__/g, join(dir, 'codex-spawned'))
      .replace(/__FORKMETA__/g, '{}'),
  );
  chmodSync(fake, 0o755);
  const oldBin = process.env.COSYNCING_CODEX_BIN;
  process.env.COSYNCING_CODEX_BIN = fake;
  try {
    const adapter = new CodexAdapter();
    const info = await adapter.forkSession(Buffer.from(sourceRollout, 'utf8').toString('base64url'));
    const decodedId = Buffer.from(info.id, 'base64url').toString('utf8');
    return [
      info.tool === 'codex' &&
        decodedId === forkPath &&
        info.title === 'Source thread (fork)' &&
        info.cwd === dir &&
        info.attachMode === 'observe' &&
        // lineageId is the PARENT (forkedFromId = the threadId we forked from), not the fork's own
        // sessionId (Fable review #2). The source rollout's session_meta id is 'source-thread'.
        info.lineageId === 'source-thread' &&
        info.currentModel?.modelID === 'fake-model' &&
        info.control?.drive.state === 'observing',
      `id→${decodedId === forkPath} title=${info.title} lineage=${info.lineageId} model=${info.currentModel?.modelID} drive=${info.control?.drive.state}`,
    ];
  } finally {
    if (oldBin == null) delete process.env.COSYNCING_CODEX_BIN;
    else process.env.COSYNCING_CODEX_BIN = oldBin;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── CR4: user-initiated fork of an agent-owned thread ──────────────────────────────────────────────
//
// A subagent rollout is a CHILD thread whose only writer is the parent agent's run, so it is
// permanently Observe-only. `thread/fork` also COPIES the source thread's provenance into the new
// rollout, which means forking a child produced a SECOND permanently Observe-only thread and dropped
// the user into it — a dead end. Two layers cover it now:
//
//  1. `forkSession` REFUSES an agent-owned source up front, above `forkCodexThread`, so no RPC is
//     made and no rollout is created (checks below assert both).
//  2. the returned row is still re-derived from both metas, for the case where the source was normal
//     but the fork's OWN meta comes back agent-owned (defence in depth).
//
// SCOPE: this is our user-initiated fork route only. Codex spawns its subagents by calling
// `thread/fork` INSIDE the codex process — that never reaches this adapter, and these checks must
// never be widened into something that would constrain it.

/** Build the fixture (source rollout + fake `codex`) for a fork attempt, run `fn`, and clean up.
 *
 *  Sync-server mode is ON throughout. With it off, `terminalSync` is already `supported: false` for
 *  the unrelated "sync is disabled" reason and every capability assertion below would pass no matter
 *  what the fix did. */
async function withForkFixture<T>(
  sourceMeta: Record<string, unknown>,
  forkMeta: Record<string, unknown>,
  fn: (ctx: {
    adapter: CodexAdapter;
    sourceId: string;
    forkPath: string;
    /** Written by the fake `codex` before it reads stdin — presence proves the binary ran. */
    spawnMark: string;
  }) => Promise<T>,
): Promise<T> {
  const dir = `/tmp/cosyncingcodexfork${rand()}`;
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const sourceRollout = join(dir, 'rollout-2026-06-16T00-00-00-00000000-0000-4000-8000-0000000000c1.jsonl');
  writeFileSync(
    sourceRollout,
    JSON.stringify({ type: 'session_meta', payload: { id: 'source-thread', cwd: dir, ...sourceMeta } }) + '\n',
  );
  const forkPath = join(dir, 'rollout-2026-06-16T00-00-01-11111111-1111-4111-8111-1111111111c2.jsonl');
  const spawnMark = join(dir, 'codex-spawned');
  const fake = join(binDir, 'codex');
  writeFileSync(
    fake,
    FAKE.replace(/__DIR__/g, dir)
      .replace(/__FORKPATH__/g, forkPath)
      .replace(/__SPAWNMARK__/g, spawnMark)
      .replace(/__FORKMETA__/g, JSON.stringify(forkMeta)),
  );
  chmodSync(fake, 0o755);
  const oldBin = process.env.COSYNCING_CODEX_BIN;
  const oldSync = process.env.COSYNCING_CODEX_SYNC_SERVER;
  process.env.COSYNCING_CODEX_BIN = fake;
  process.env.COSYNCING_CODEX_SYNC_SERVER = '1';
  try {
    const adapter = new CodexAdapter(); // capabilities are captured HERE — env must already be set
    return await fn({
      adapter,
      sourceId: Buffer.from(sourceRollout, 'utf8').toString('base64url'),
      forkPath,
      spawnMark,
    });
  } finally {
    if (oldBin == null) delete process.env.COSYNCING_CODEX_BIN;
    else process.env.COSYNCING_CODEX_BIN = oldBin;
    if (oldSync == null) delete process.env.COSYNCING_CODEX_SYNC_SERVER;
    else process.env.COSYNCING_CODEX_SYNC_SERVER = oldSync;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Fork a source rollout carrying `sourceMeta`, with the fake writing `forkMeta` into the new
 *  rollout's own `session_meta`, and return the row handed to the client. */
const forkRow = (sourceMeta: Record<string, unknown>, forkMeta: Record<string, unknown>) =>
  withForkFixture(sourceMeta, forkMeta, ({ adapter, sourceId }) => adapter.forkSession(sourceId));

const SUBAGENT_META = { thread_source: 'subagent', parent_thread_id: 'parent-thread' };

/** No Drive, no join, and nothing runnable anywhere on the row — including the top-level hint, which
 *  is its own roster field and would otherwise survive a control-only suppression.
 *
 *  The row must also be TAGGED, not merely suppressed: an untagged row with missing capabilities reads
 *  as an ordinary session that inexplicably cannot be driven, and tag-not-drop says the provenance
 *  travels with the session from its first appearance, not from the next roster rebuild. */
const noOffer = (info: Awaited<ReturnType<typeof forkRow>>): [boolean, string] => {
  const sync = info.control?.terminalSync as any;
  const drive = info.control?.drive as any;
  const ok =
    (info as any).origin === 'subagent' &&
    (info as any).parentThreadId === 'parent-thread' &&
    drive?.supported === false &&
    drive?.state === 'unavailable' &&
    typeof drive?.reason === 'string' &&
    sync?.supported === false &&
    sync?.syncAvailable === false &&
    sync?.active === false &&
    sync?.action === undefined &&
    sync?.command === undefined &&
    sync?.label === undefined &&
    info.terminalSyncHint === undefined;
  return [
    ok,
    `origin=${(info as any).origin} parent=${(info as any).parentThreadId} drive=${JSON.stringify(drive)} sync=${JSON.stringify(sync)} hint=${JSON.stringify(info.terminalSyncHint)}`,
  ];
};

await test('CR4 forking a subagent SOURCE is refused, and creates/contacts nothing', async () =>
  withForkFixture(SUBAGENT_META, SUBAGENT_META, async ({ adapter, sourceId, forkPath, spawnMark }) => {
    let thrown: unknown;
    let row: unknown;
    try {
      row = await adapter.forkSession(sourceId);
    } catch (err) {
      thrown = err;
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown ?? '');
    const ok =
      thrown !== undefined &&
      // Single-sourced from CODEX_AGENT_OWNED_DRIVE_REASON — the same sentence attach() and the
      // roster control state use. A bespoke second copy here would drift.
      message.includes('owned by the agent that spawned it') &&
      // Refused ABOVE forkCodexThread: no app-server was launched…
      !existsSync(spawnMark) &&
      // …so no fork rollout exists on disk to be discovered, resumed, or navigated into.
      !existsSync(forkPath);
    return [
      ok,
      `threw=${thrown !== undefined} msg=${JSON.stringify(message)} spawned=${existsSync(spawnMark)} forkRollout=${existsSync(forkPath)} row=${JSON.stringify(row) ?? '(none)'}`,
    ];
  }));

await test('CR4 the fork refusal is a typed AgentOwnedSessionError, not a plain Error', async () =>
  // The refusal above is correct whether or not it is typed — but the broker's fork route only knows
  // it is a refusal (409 SESSION_AGENT_OWNED) rather than an adapter fault (the catch-all 502) if it
  // can classify the throw. The route gate answers first ONLY when discovery saw the source; when it
  // did not, this type is the sole thing standing between a permanent capability boundary and a
  // transient-sounding 502 that invites a retry.
  withForkFixture(SUBAGENT_META, SUBAGENT_META, async ({ adapter, sourceId }) => {
    let thrown: unknown;
    try {
      await adapter.forkSession(sourceId);
    } catch (err) {
      thrown = err;
    }
    const ok =
      isAgentOwnedSessionError(thrown) &&
      thrown.action === 'fork' &&
      // Semantics, not just a second name: an OwnershipConflictError advertises a COMPETING owner the
      // caller could take over from, and the broker maps it to a takeover-shaped answer. A child
      // thread has no other owner — the capability does not exist for it at all.
      !isOwnershipConflictError(thrown);
    return [
      ok,
      `name=${(thrown as any)?.name} action=${JSON.stringify((thrown as any)?.action)} typed=${isAgentOwnedSessionError(thrown)} ownershipConflict=${isOwnershipConflictError(thrown)}`,
    ];
  }));

await test('CR4 the refusal predicate survives a cross-realm error (name+shape, not instanceof)', async () => {
  // The adapter and the broker can resolve different copies of adapter-api (separate bundles, a linked
  // workspace, the compiled single-file broker), so `instanceof` alone would silently stop matching and
  // the 409 would quietly regress to 502. This is the same reason isOwnershipConflictError is written
  // this way. Synthesized here rather than by loading a second module copy: what matters is that the
  // predicate does not depend on class identity.
  const foreign = Object.assign(new Error('subagent threads cannot be forked'), {
    name: 'AgentOwnedSessionError',
    action: 'fork',
  });
  const plain = new Error('subagent threads cannot be forked');
  const namedButShapeless = Object.assign(new Error('x'), { name: 'AgentOwnedSessionError' });
  const ok =
    isAgentOwnedSessionError(foreign) &&
    !isAgentOwnedSessionError(plain) &&
    !isAgentOwnedSessionError(namedButShapeless) &&
    !isAgentOwnedSessionError(undefined);
  return [
    ok,
    `foreign=${isAgentOwnedSessionError(foreign)} plain=${isAgentOwnedSessionError(plain)} namedOnly=${isAgentOwnedSessionError(namedButShapeless)}`,
  ];
});

await test('CR4 a fork whose OWN meta comes back agent-owned is tagged and suppressed', async () =>
  // Defence in depth behind the refusal above. The SOURCE is a normal thread, so the up-front gate
  // does not fire; the app-server decides what the new rollout's session_meta says, and if it marks
  // the fork as a child then the row we hand back must already say what the next discovery will.
  noOffer(await forkRow({}, SUBAGENT_META)));

await test('CR4 a fork of a NORMAL thread still advertises Drive and a copyable join command', async () => {
  // Positive control. If this ever fails, the predicate has widened onto parents and the two
  // assertions above are passing for the wrong reason.
  const info = await forkRow({}, {});
  const sync = info.control?.terminalSync as any;
  const ok =
    (info as any).origin === undefined &&
    (info as any).parentThreadId === undefined &&
    info.control?.drive.supported === true &&
    info.control?.drive.state === 'observing' &&
    sync?.supported === true &&
    sync?.syncAvailable === true &&
    sync?.action === 'join' &&
    typeof sync?.command === 'string' &&
    sync.command.includes('codex resume --remote') &&
    info.terminalSyncHint?.command?.includes('codex resume --remote') === true;
  return [
    ok,
    `origin=${(info as any).origin} drive=${JSON.stringify(info.control?.drive)} sync=${JSON.stringify(sync)} hint=${info.terminalSyncHint?.command ?? '(none)'}`,
  ];
});

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\nFAIL: ${failed.length}/${results.length} codex fork check(s) failed.`);
  process.exit(1);
}
console.log(`\nPASS ${results.length}/${results.length} codex fork checks`);
