#!/usr/bin/env bun
/**
 * An isolated broker for a physical Web Push pass, beside the installed one.
 *
 * Serves this checkout's web build on a loopback port with its own temporary home, and a fake
 * `claude` that answers each prompt after a delay. A browser on this machine opens
 * `http://localhost:<port>/cosy/` (localhost is a secure context, so the Push API works without
 * TLS), saves the printed token, turns notifications on, sends a prompt in the seeded session, and
 * closes every Cosyncing tab before the answer lands. The broker then delivers "Turn finished" as a
 * Web Push, through the browser's real push service.
 *
 * It never touches the installed broker, its port, its state, or any real agent: the fixture
 * environment owns every home and state directory under the fixture root, and no model is called.
 *
 *   bun run client:build:web
 *   bun run scripts/dev/web-push-fixture.ts [--port 27734] [--delay-ms 20000]
 *
 * Environment: COSYNCING_WEB_PUSH_FIXTURE_PORT, COSYNCING_WEB_PUSH_FIXTURE_DELAY_MS. Ctrl-C stops
 * the broker; the fixture root (logs, attention store, VAPID key) stays under
 * output/notifications/web-push-fixture/ for inspection.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { isolatedBrokerFixtureEnvironment } from '../../packages/typescript/broker/test/helpers/isolated-broker-fixture.ts';

const REPOSITORY_ROOT = resolve(import.meta.dir, '../..');
const WEB_BUILD = join(REPOSITORY_ROOT, 'apps/client/build/web');

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: process.env.COSYNCING_WEB_PUSH_FIXTURE_PORT ?? '27734' },
    'delay-ms': { type: 'string', default: process.env.COSYNCING_WEB_PUSH_FIXTURE_DELAY_MS ?? '20000' },
  },
});
const port = Number(values.port);
const delayMs = Number(values['delay-ms']);
if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`bad --port ${values.port}`);
if (port === 7734 || port === 17734) throw new Error(`port ${port} belongs to the installed or review broker`);
if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error(`bad --delay-ms ${values['delay-ms']}`);
if (!existsSync(join(WEB_BUILD, 'index.html'))) {
  throw new Error(`no web build at ${WEB_BUILD}; run: bun run client:build:web`);
}

const origin = `http://127.0.0.1:${port}`;
const alreadyUp = await fetch(`${origin}/api/health`).then(() => true, () => false);
if (alreadyUp) throw new Error(`something already answers on ${origin}; pick another --port`);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = join(REPOSITORY_ROOT, 'output/notifications/web-push-fixture', stamp);
const workspace = join(root, 'workspace');
const bin = join(root, 'bin');
for (const directory of [workspace, bin]) mkdirSync(directory, { recursive: true });

// Enough of Claude's stream-json Drive protocol to run one turn per prompt, answered late so the
// tester can close every tab first. Probes (`agents`, `--version`) answer and exit.
const fakeClaude = join(bin, 'claude');
writeFileSync(fakeClaude, `#!/usr/bin/env bun
const args = process.argv.slice(2);
const driveAt = args.findIndex((arg) => arg === '--resume' || arg === '--session-id');
if (driveAt < 0) {
  if (args[0] === 'agents') process.stdout.write('[]\\n');
  else if (args.includes('--version')) process.stdout.write('2.1.0 (Claude Code)\\n');
  process.exit(0);
}
const sessionId = args[driveAt + 1] ?? 'unknown';
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
out({ type: 'system', subtype: 'init', session_id: sessionId, tools: [], slash_commands: [], model: 'fixture-model' });
let turn = 0;
const answer = (prompt) => {
  turn += 1;
  out({ type: 'assistant', session_id: sessionId, message: { id: 'msg_fixture_' + turn, role: 'assistant', model: 'fixture-model',
    content: [{ type: 'text', text: 'Fixture answer ' + turn + ' to: ' + prompt.slice(0, 80) }], usage: { input_tokens: 1, output_tokens: 1 } } });
  out({ type: 'result', subtype: 'success', session_id: sessionId, is_error: false, duration_ms: ${delayMs}, num_turns: turn,
    total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
};
const textOf = (message) => typeof message?.content === 'string' ? message.content
  : Array.isArray(message?.content) ? message.content.map((part) => part?.text ?? '').join(' ') : '';
let buffered = '';
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buffered += decoder.decode(chunk, { stream: true });
  let newline;
  while ((newline = buffered.indexOf('\\n')) !== -1) {
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.type === 'user') setTimeout(() => answer(textOf(parsed.message)), ${delayMs});
    } catch {}
  }
}
setInterval(() => {}, 1000);
`);
chmodSync(fakeClaude, 0o755);

const token = randomBytes(24).toString('base64url');
const log = openSync(join(root, 'broker.log'), 'a');
const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
  cwd: REPOSITORY_ROOT,
  env: isolatedBrokerFixtureEnvironment(root, {
    overrides: {
      PORT: String(port),
      HOST: '127.0.0.1',
      COSYNCING_TOKEN: token,
      COSYNCING_WEB_DIR: WEB_BUILD,
      COSYNCING_CACHE_DIR: join(root, 'cache'),
      COSYNCING_CLAUDE_BIN: fakeClaude,
      COSYNCING_PI_SESSIONS_ROOT: '',
      PI_CODING_AGENT_SESSION_DIR: '',
    },
  }),
  stdout: log,
  stderr: log,
});
// Wait for the broker to go: exiting first would orphan it on its port when only this process is
// signalled (a terminal's Ctrl-C reaches both, a plain `kill` reaches only this one).
const stop = async (): Promise<void> => {
  if (broker.exitCode !== null) return;
  broker.kill('SIGTERM');
  const exited = await Promise.race([broker.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
  if (!exited) broker.kill('SIGKILL');
};
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void stop().finally(() => process.exit(0)); });
}

const deadline = Date.now() + 60_000;
while (!(await fetch(`${origin}/api/health`).then((res) => res.ok, () => false))) {
  if (broker.exitCode !== null || Date.now() > deadline) {
    await stop();
    throw new Error(`the fixture broker did not start; see ${join(root, 'broker.log')}`);
  }
  await Bun.sleep(250);
}

// One seeded Claude session with a delivered exchange, so the roster lists it and a prompt drives it.
const created = await fetch(`${origin}/api/sessions/claude`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-cosyncing-token': token },
  body: JSON.stringify({ directory: workspace, title: 'Web Push fixture' }),
});
if (!created.ok) {
  await stop();
  throw new Error(`creating the fixture session failed: ${created.status} ${await created.text()}`);
}
const session = (await created.json()) as { id?: string; session?: { id?: string } };
const sessionId = session.session?.id ?? session.id;
if (!sessionId) {
  await stop();
  throw new Error(`the create response named no session id: ${JSON.stringify(session)}`);
}
// A Claude session id is the base64url of its transcript path.
const transcript = Buffer.from(sessionId, 'base64url').toString('utf8');
const uuid = transcript.split('/').pop()!.replace(/\.jsonl$/, '');
const at = new Date().toISOString();
mkdirSync(dirname(transcript), { recursive: true });
writeFileSync(transcript,
  `${JSON.stringify({ type: 'user', uuid: 'fixture-u1', parentUuid: null, isSidechain: false, sessionId: uuid, cwd: workspace, timestamp: at,
    message: { role: 'user', content: 'Web Push fixture seed' } })}\n`
  + `${JSON.stringify({ type: 'assistant', uuid: 'fixture-a1', parentUuid: 'fixture-u1', isSidechain: false, sessionId: uuid, cwd: workspace, timestamp: at,
    message: { id: 'msg_fixture_seed', type: 'message', role: 'assistant', model: 'fixture-model', content: [{ type: 'text', text: 'Ready.' }],
      stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } })}\n`);

console.log(`
Web Push fixture broker (this checkout), isolated from the installed one.

  Open:     http://localhost:${port}/cosy/
  Token:    ${token}
  Session:  "Web Push fixture" (claude), answers ${Math.round(delayMs / 1000)} s after each prompt
  Root:     ${root}

1. Settings → Pairing: paste the token and save it.
2. Turn notifications on and allow them.
3. Open the session, send any prompt, then close EVERY Cosyncing tab within ${Math.round(delayMs / 1000)} s.
4. "Turn finished" should arrive as a notification. Click it: the app opens on the session.

Ctrl-C stops the broker.`);
await broker.exited;
