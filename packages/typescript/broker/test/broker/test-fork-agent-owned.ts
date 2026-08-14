#!/usr/bin/env bun
/**
 * CR4 — `POST /api/sessions/:tool/:id/fork` refuses a USER-INITIATED fork of an agent-spawned session
 * with a typed code, and still forks an ordinary one.
 *
 * A session whose `SessionInfo.origin` is `'subagent'` has exactly one writer — the parent session's
 * run — so it is permanently Observe-only. Forking it could only ever produce a second thread with the
 * same defect and navigate the user into it. The route refuses with `SESSION_AGENT_OWNED` / 409 rather
 * than letting the adapter's own refusal fall into the catch-all `502 native session fork failed`,
 * which reads as a transient failure and invites a retry.
 *
 * The gate is stated over the PROTOCOL field, not over a tool name: any adapter that tags a session
 * `origin: 'subagent'` inherits the refusal. Codex is merely the adapter that has such rows today.
 *
 * TWO refusers, and the second one is separately covered here. The route gate can only fire when
 * `discoverSession()` saw the source; when it did not, the ADAPTER is the only refuser, and the status
 * code depends on the broker classifying its typed `AgentOwnedSessionError`. A source written outside
 * the discovered rollout tree exercises exactly that path.
 *
 * SCOPE — this covers OUR fork route (client Fork → broker → adapter). Codex spawns its own subagents
 * by calling `thread/fork` inside the codex process; that never reaches this route and is untouched.
 *
 * Zero cost: an isolated CODEX_HOME holding hand-written rollouts, and a fake `codex` app-server
 * (COSYNCING_CODEX_BIN) that answers `thread/fork`. No real Codex, no model.
 *
 *   bun run packages/typescript/broker/test/broker/test-fork-agent-owned.ts
 */
export {};
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureProcessOutput,
  isolatedBrokerFixtureEnvironment,
  waitForBrokerHealth,
} from '../helpers/isolated-broker-fixture.ts';
import { AGENT_OWNED_FORK_REFUSAL_CODE, isAgentOwnedSession } from '../../src/main.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('could not allocate a port');
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return addr.port;
}

// Readiness is not one of this suite's assertions, so it gets no wall-clock
// budget: a broker booting beside other suites is slow, not broken.
const waitHealthy = (base: string): Promise<void> =>
  broker
    ? waitForBrokerHealth(broker, `${base}/api/health`)
    : Promise.reject(new Error('no broker to wait for'));

const enc = (path: string): string => Buffer.from(path, 'utf8').toString('base64url');
const dec = (id: string): string => {
  try {
    return Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return id;
  }
};

// ── fixture ───────────────────────────────────────────────────────────────────────────────────────
//
// `root` is created BEFORE the try so the finally can always remove it, and everything that can throw
// — the rest of the fixture, port allocation, the broker spawn — lives inside it. An earlier shape
// spawned outside the guarded block, so a failure while allocating a port or starting the broker leaked
// the temp tree into /tmp.
const root = mkdtempSync(join(tmpdir(), 'cosyncing-fork-agent-owned-'));
let broker: ReturnType<typeof Bun.spawn> | undefined;
try {
const codexHome = join(root, 'codex-home');
const sessionsDir = join(codexHome, 'sessions', '2026', '06', '16');
const binDir = join(root, 'bin');
// A throwaway $HOME for the spawned broker. Redirecting CODEX_HOME alone isolates codex and NOTHING
// else: the roster also walks the Claude, OpenCode and Pi stores, which on a developer machine hold
// real sessions (this test used to see 1,343 of them). Every store root below is the env var that
// adapter actually honors, so the run reads only what this fixture wrote.
const fakeHome = join(root, 'home');
const claudeConfigDir = join(fakeHome, '.claude');
const claudeWrapperDir = join(fakeHome, 'bin');
const piAgentDir = join(fakeHome, '.pi', 'agent');
const xdgDataHome = join(fakeHome, '.local', 'share');
const xdgConfigHome = join(fakeHome, '.config');
const xdgStateHome = join(fakeHome, '.local', 'state');
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(binDir, { recursive: true });
mkdirSync(claudeConfigDir, { recursive: true });
mkdirSync(claudeWrapperDir, { recursive: true });
mkdirSync(piAgentDir, { recursive: true });
mkdirSync(xdgDataHome, { recursive: true });
mkdirSync(xdgConfigHome, { recursive: true });
mkdirSync(xdgStateHome, { recursive: true });

const rollout = (name: string, payload: Record<string, unknown>): string => {
  const path = join(sessionsDir, name);
  writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { cwd: root, ...payload } }) + '\n');
  return path;
};

const normalRollout = rollout('rollout-2026-06-16T00-00-00-00000000-0000-4000-8000-00000000f001.jsonl', {
  id: 'normal-thread',
});
const subagentRollout = rollout('rollout-2026-06-16T00-00-02-00000000-0000-4000-8000-00000000f002.jsonl', {
  id: 'child-thread',
  thread_source: 'subagent',
  parent_thread_id: 'normal-thread',
});
// The same child thread, written OUTSIDE `$CODEX_HOME/sessions` — the only tree codex discovery walks.
// `discoverSession()` therefore returns undefined for it and the route gate above cannot fire, while
// the adapter still reads its `session_meta` straight off the decoded path and refuses. That is the
// real shape of a stale/absent/peer-served roster row, and it is the ONLY path on which the adapter's
// typed refusal decides the status code.
const hiddenSubagentRollout = join(root, 'rollout-2026-06-16T00-00-03-00000000-0000-4000-8000-00000000f003.jsonl');
writeFileSync(
  hiddenSubagentRollout,
  JSON.stringify({
    type: 'session_meta',
    payload: { cwd: root, id: 'hidden-child-thread', thread_source: 'subagent', parent_thread_id: 'normal-thread' },
  }) + '\n',
);
// Where the fake writes any fork it is asked to make. Its ABSENCE after the refused request is the
// proof that the route stopped short of the adapter's create path.
const forkRolloutPath = join(sessionsDir, 'rollout-2026-06-16T00-00-09-00000000-0000-4000-8000-00000000f009.jsonl');

writeFileSync(
  join(binDir, 'codex'),
  `#!/usr/bin/env bun
const dec = new TextDecoder();
const fs = require('fs');
let buf = '';
const send = (o) => console.log(JSON.stringify(o));
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'thread/fork') {
      fs.writeFileSync(${JSON.stringify(forkRolloutPath)}, JSON.stringify({ type: 'session_meta', payload: { id: 'forked-thread', cwd: ${JSON.stringify(root)} } }) + '\\n');
      send({ id: msg.id, result: { thread: {
        id: 'forked-thread',
        forkedFromId: msg.params.threadId,
        path: ${JSON.stringify(forkRolloutPath)},
        cwd: ${JSON.stringify(root)},
        name: 'Forked thread',
        turns: [],
      }, cwd: ${JSON.stringify(root)} } });
    } else if (msg.id != null) send({ id: msg.id, result: {} });
  }
}
`,
);
chmodSync(join(binDir, 'codex'), 0o755);

// ── the predicate, independent of the HTTP plumbing ───────────────────────────────────────────────
check('isAgentOwnedSession: subagent origin → refused', isAgentOwnedSession({ origin: 'subagent' }) === true);
check('isAgentOwnedSession: exec origin → forkable (automated LAUNCH, no owning parent)', isAgentOwnedSession({ origin: 'exec' }) === false);
check('isAgentOwnedSession: vscode origin → forkable', isAgentOwnedSession({ origin: 'vscode' }) === false);
check('isAgentOwnedSession: no origin → forkable', isAgentOwnedSession({}) === false);
check('isAgentOwnedSession: undiscoverable source → not refused here (adapter still enforces)', isAgentOwnedSession(undefined) === false);

// ── the real route ────────────────────────────────────────────────────────────────────────────────
const TOKEN = 'fork-agent-owned-token';
const port = await freePort();
// Isolate every store `GET /api/sessions` walks, not just codex. This used to spread the DEVELOPER's
// environment and then redirect or delete each store root one at a time — an ambient `OPENCODE_DATA`
// or `PI_CODING_AGENT_SESSION_DIR` outranks `HOME`/`XDG_DATA_HOME` and would walk the real machine
// again. The allow-list inverts that: nothing reaches the broker unless it is named below, so a store
// root nobody thought of cannot leak in.
const brokerEnv: Record<string, string | undefined> = isolatedBrokerFixtureEnvironment(root, {
  overrides: {
  PORT: String(port),
  HOST: '127.0.0.1',
  COSYNCING_TOKEN: TOKEN,
  // Broker's own state, cache, and the `codex` binary the adapter resolves.
  COSYNCING_HOME: join(root, 'cosyncing-home'),
  COSYNCING_CACHE_DIR: join(root, 'cosyncing-cache'),
  COSYNCING_CODEX_BIN: join(binDir, 'codex'),
  // Session-store roots, one per adapter, each the var that adapter actually honors.
  HOME: fakeHome,
  CODEX_HOME: codexHome,
  CLAUDE_CONFIG_DIR: claudeConfigDir,
  // Claude wrapper scripts are DISCOVERED as extra stores (a wrapper is recognised by the
  // CLAUDE_CONFIG_DIR it exports), so the real `~/bin` is a second Claude roster source.
  COSYNCING_CLAUDE_WRAPPER_DIR: claudeWrapperDir,
  PI_CODING_AGENT_DIR: piAgentDir,
  OPENCODE_DATA: join(xdgDataHome, 'opencode'),
  XDG_DATA_HOME: xdgDataHome,
  XDG_CONFIG_HOME: xdgConfigHome,
  XDG_STATE_HOME: xdgStateHome,
  // OpenCode's roster is served by a RUNNING `opencode serve`, not by the data dir, so redirecting
  // OPENCODE_DATA isolates nothing on a machine where one is up: the adapter defaults to
  // 127.0.0.1:4096 and enumerated 240 of the developer's real sessions from it. Pin it at an
  // unreachable loopback port instead (the same idiom this suite already uses for COSYNCING_TOKDASH_URL).
  // NO_AUTOSERVE only stops the broker STARTING one; it does not stop it attaching to one.
  OPENCODE_URL: 'http://127.0.0.1:1',
  COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
  COSYNCING_PI_BRIDGE_AUTOINSTALL: '0',
  COSYNCING_WEB_COI: '0',
  // Sync-server mode OFF: it would have discovery ensure a managed app-server daemon out of the
  // fake binary, which has nothing to do with what is under test here.
  COSYNCING_CODEX_SYNC_SERVER: '0',
  },
});
// Higher-precedence store overrides with no fixture equivalent: they must be ABSENT, not redirected.
// The allow-list drops the ambient ones; the helper sets `PI_CODING_AGENT_SESSION_DIR` itself, which
// would outrank the `PI_CODING_AGENT_DIR` this suite populates.
delete brokerEnv.COSYNCING_PI_SESSIONS_ROOT;
delete brokerEnv.PI_CODING_AGENT_SESSION_DIR;

const broker0 = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
  env: brokerEnv,
  stdout: 'ignore',
  stderr: 'pipe',
});
broker = broker0;
// Nothing read this pipe, and a broker that fills it blocks before it ever
// listens — which the readiness wait can only report as a slow host.
const brokerOutput = captureProcessOutput(broker0);
const base = `http://127.0.0.1:${port}`;

const postFork = async (rolloutPath: string): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}/api/sessions/codex/${enc(rolloutPath)}/fork`, {
    method: 'POST',
    headers: { 'x-cosyncing-token': TOKEN, 'content-type': 'application/json' },
    body: '{}',
  });
  return { status: res.status, body: await res.json().catch(() => undefined) };
};

try {
  await waitHealthy(base);
} catch (error) {
  broker0.kill();
  await broker0.exited;
  throw new Error(`${(error as Error).message}\n${brokerOutput.read().trim().slice(-2000)}`);
}

const refused = await postFork(subagentRollout);
check(
  'fork of an agent-owned session → 409',
  refused.status === 409,
  `status=${refused.status} body=${JSON.stringify(refused.body)}`,
);
check(
  `fork of an agent-owned session → code ${AGENT_OWNED_FORK_REFUSAL_CODE}`,
  refused.body?.code === AGENT_OWNED_FORK_REFUSAL_CODE,
  `code=${refused.body?.code}`,
);
check(
  'the refusal is typed, not the catch-all 502 "native session fork failed"',
  refused.status !== 502 && refused.body?.error !== 'native session fork failed',
  `error=${JSON.stringify(refused.body?.error)}`,
);
check(
  'the refused fork created no rollout',
  !existsSync(forkRolloutPath),
  `forkRollout=${existsSync(forkRolloutPath)}`,
);

// ── the adapter's typed refusal, on the path where the route gate cannot answer ──────────────────
//
// PLACEMENT is the whole point of this group. The gate above returns 409 whenever discovery sees a
// subagent source, which would make the adapter's typing invisible. Here discovery genuinely misses
// the source, so the request reaches `backend.forkSession`, and the status code is decided purely by
// whether the throw is classifiable. Assert the miss first — without it these checks could quietly
// become a second copy of the gate test.
const roster = await fetch(`${base}/api/sessions`, { headers: { 'x-cosyncing-token': TOKEN } });
const rosterBody: any = await roster.json().catch(() => undefined);
const rosterIds = new Set<string>((rosterBody?.sessions ?? []).map((s: any) => String(s?.id)));
check(
  'precondition: the hidden subagent source is NOT discoverable, so the route gate cannot fire',
  !rosterIds.has(enc(hiddenSubagentRollout)) && rosterIds.has(enc(subagentRollout)),
  `hiddenDiscovered=${rosterIds.has(enc(hiddenSubagentRollout))} discoverableChildPresent=${rosterIds.has(enc(subagentRollout))} rosterSize=${rosterIds.size}`,
);
// The isolation itself, asserted rather than assumed. The check above is satisfied by ANY roster that
// happens to contain the discoverable child, including one that also contains every real session on
// the developer's machine — which is exactly what this test used to produce (1,343 of them), because it
// redirected CODEX_HOME and left the Claude/OpenCode/Pi stores pointing at the real $HOME. An
// over-broad roster is not cosmetic here: discovery then walks thousands of unrelated files on every
// request, which is a plausible source of a flaky timeout, and the "not discoverable" precondition
// becomes luck rather than construction. Pinning the exact set is what keeps the isolation from
// silently rotting when a new adapter is added.
const fixtureIds = [enc(normalRollout), enc(subagentRollout)];
const strayIds = [...rosterIds].filter((id) => !fixtureIds.includes(id));
check(
  'hermetic: the roster is EXACTLY the two fixture sessions — no real host sessions leaked in',
  rosterIds.size === fixtureIds.length && strayIds.length === 0,
  `rosterSize=${rosterIds.size} expected=${fixtureIds.length} stray=${JSON.stringify(strayIds.slice(0, 5).map(dec))}`,
);

const undiscoverable = await postFork(hiddenSubagentRollout);
check(
  'undiscoverable agent-owned source → the adapter refusal still maps to 409',
  undiscoverable.status === 409,
  `status=${undiscoverable.status} body=${JSON.stringify(undiscoverable.body)}`,
);
check(
  `undiscoverable agent-owned source → code ${AGENT_OWNED_FORK_REFUSAL_CODE}`,
  undiscoverable.body?.code === AGENT_OWNED_FORK_REFUSAL_CODE,
  `code=${undiscoverable.body?.code}`,
);
check(
  'undiscoverable agent-owned source → never the transient-sounding 502',
  undiscoverable.status !== 502 && undiscoverable.body?.error !== 'native session fork failed',
  `status=${undiscoverable.status} error=${JSON.stringify(undiscoverable.body?.error)}`,
);
check(
  'the undiscoverable refusal created no rollout',
  !existsSync(forkRolloutPath),
  `forkRollout=${existsSync(forkRolloutPath)}`,
);

// Positive control. Without it the assertions above would still pass if the route refused EVERY
// fork (or if the fake codex were simply broken).
const allowed = await postFork(normalRollout);
check(
  'fork of a normal session still succeeds',
  allowed.status === 200 && allowed.body?.ok === true,
  `status=${allowed.status} body=${JSON.stringify(allowed.body)}`,
);
check(
  'the successful fork returned the new session and wrote its rollout',
  typeof allowed.body?.session?.id === 'string' && existsSync(forkRolloutPath),
  `session=${JSON.stringify(allowed.body?.session?.id)} forkRollout=${existsSync(forkRolloutPath)}`,
);
} finally {
  // Reached from EVERY exit path, including a throw out of fixture creation, `freePort()` or the
  // spawn itself. `broker` is optional precisely because those can fail before it is assigned.
  broker?.kill();
  await broker?.exited.catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}

if (failures) {
  console.error(`\nFAIL: ${failures} agent-owned fork check(s) failed.`);
  process.exit(1);
}
console.log('\nPASS: agent-owned fork route checks');
