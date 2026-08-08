/**
 * CR4: OpenCode's live and history surfaces must key one assistant message the same way.
 *
 * The contract's acceptance list asks for a live/history identity fixture per adapter, because the
 * attach boundary delivers saved history AND the still-accumulating live text: if the two surfaces
 * key one message differently, a joining client stores it twice. OpenCode was previously audited by
 * reading the code; this exercises it.
 *
 * Both surfaces are supposed to carry OpenCode's own part id — `message.part.delta` streams under
 * `properties.partID`, and history maps each stored part under `part.id`. This drives the REAL
 * adapter against a fake OpenCode HTTP/SSE server (same harness as test-opencode-file-changes.ts):
 * no live OpenCode process, no model cost.
 *
 *   bun run scripts/broker/tests/opencode/test-opencode-message-identity.ts   (exit 0 = all pass)
 */
export {};
import { mkdirSync } from 'node:fs';
import type { AgentMessage } from '../../../../packages/typescript/adapter-api/src/index.ts';
import { OpenCodeAdapter } from '../../../../packages/typescript/adapters/opencode/src/index.ts';

const DIR = '/tmp/cosyncing-opencode-identity';
const SESSION = {
  id: 'ses_identity',
  slug: 'identity',
  directory: DIR,
  title: 'message identity regression',
  time: { created: 1, updated: 2 },
};

// Two assistant turns whose answers are byte-identical. Identity is never text: they must stay two
// messages under their two part ids, exactly as the Codex lane asserts for its own producer.
const ANSWER = 'Yes.';
const ROWS = [
  {
    info: { id: 'msg_u1', role: 'user', time: { created: 1000 } },
    parts: [{ id: 'prt_u1', type: 'text', text: 'first question', messageID: 'msg_u1', sessionID: SESSION.id }],
  },
  {
    info: { id: 'msg_a1', role: 'assistant', time: { created: 2000 } },
    parts: [{ id: 'prt_a1', type: 'text', text: ANSWER, messageID: 'msg_a1', sessionID: SESSION.id }],
  },
  {
    info: { id: 'msg_u2', role: 'user', time: { created: 3000 } },
    parts: [{ id: 'prt_u2', type: 'text', text: 'second question', messageID: 'msg_u2', sessionID: SESSION.id }],
  },
  {
    info: { id: 'msg_a2', role: 'assistant', time: { created: 4000 } },
    parts: [{ id: 'prt_a2', type: 'text', text: ANSWER, messageID: 'msg_a2', sessionID: SESSION.id }],
  },
];

const eventClients = new Set<ReadableStreamDefaultController>();

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(25);
  }
  return predicate();
}

function sendEvent(event: unknown): void {
  const frame = new TextEncoder().encode(`data: ${JSON.stringify({ payload: event })}\n\n`);
  for (const client of [...eventClients]) {
    try {
      client.enqueue(frame);
    } catch {
      eventClients.delete(client);
    }
  }
}

let server: ReturnType<typeof Bun.serve> | undefined;
for (let attempt = 0; attempt < 20 && !server; attempt++) {
  try {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 50000 + Math.floor(Math.random() * 15000),
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/global/event') {
          return new Response(new ReadableStream({
            start(controller) {
              eventClients.add(controller);
              controller.enqueue(new TextEncoder().encode(': connected\n\n'));
            },
          }), { headers: { 'content-type': 'text/event-stream' } });
        }
        if (url.pathname === '/project') return Response.json([{ worktree: DIR }]);
        if (url.pathname === '/session' && req.method === 'GET') return Response.json([SESSION]);
        if (url.pathname === '/session/status') return Response.json({});
        if (url.pathname === `/session/${SESSION.id}/message`) return Response.json(ROWS);
        if (url.pathname === `/session/${SESSION.id}`) return Response.json(SESSION);
        if (url.pathname === '/question' || url.pathname === '/permission') return Response.json([]);
        return new Response('not found', { status: 404 });
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
  }
}
if (!server) throw new Error('Could not allocate an OpenCode identity test port after 20 attempts.');

let conn: Awaited<ReturnType<OpenCodeAdapter['attach']>> | undefined;
try {
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const store = `/tmp/cosyncing-opencode-identity-store-${server.port}`;
  mkdirSync(`${store}/storage/session`, { recursive: true }); // pin discovery to an empty store, not the real one
  const adapter = new OpenCodeAdapter({ baseUrl, storageDir: store, sseIdleMs: 30_000 });

  conn = await adapter.attach(SESSION.id, 'live');
  const live: AgentMessage[] = [];
  const unsubscribe = conn.subscribe((m) => live.push(m));

  const history = await conn.getHistory();
  const answers = history.filter((m): m is Extract<AgentMessage, { type: 'model-output' }> => m.type === 'model-output');
  const [firstAnswer, secondAnswer] = answers;
  check(
    'history keys each assistant text part by the part id OpenCode gave it',
    answers.length === 2 && firstAnswer?.key === 'prt_a1' && secondAnswer?.key === 'prt_a2',
    JSON.stringify(answers.map((m) => m.key)),
  );
  check(
    'two byte-identical answers stay two messages (identity is never text)',
    answers.length === 2 && firstAnswer?.text === secondAnswer?.text && firstAnswer?.key !== secondAnswer?.key,
    JSON.stringify(answers.map((m) => ({ key: m.key, text: m.text }))),
  );

  // The live surface for the SAME part: a streamed delta while that answer is still in flight. This
  // is the copy the broker's attach snapshot carries, so it has to land on the history key.
  sendEvent({
    type: 'message.part.delta',
    properties: { sessionID: SESSION.id, messageID: 'msg_a2', partID: 'prt_a2', field: 'text', delta: ' Still going.' },
  });
  const streamed = await waitFor(() => live.some((m) => m.type === 'model-output'));
  const liveAnswer = live.find((m) => m.type === 'model-output') as any;
  check(
    'a live delta streams under that same part id',
    streamed && liveAnswer?.key === 'prt_a2' && liveAnswer?.delta === ' Still going.',
    JSON.stringify(liveAnswer ?? null),
  );
  check(
    'live and history therefore agree on one identity for one message',
    liveAnswer?.key === answers.at(-1)?.key,
    `live=${liveAnswer?.key} history=${answers.at(-1)?.key}`,
  );

  // Reasoning travels the same seam and must not collide with the text part beside it.
  sendEvent({
    type: 'message.part.delta',
    properties: { sessionID: SESSION.id, messageID: 'msg_a2', partID: 'prt_r2', field: 'reasoning', delta: 'weighing it' },
  });
  const thought = await waitFor(() => live.some((m) => m.type === 'thinking'));
  const liveThinking = live.find((m) => m.type === 'thinking') as any;
  check(
    'a live reasoning delta keys by its own part id, distinct from the text part',
    thought && liveThinking?.key === 'prt_r2' && liveThinking.key !== liveAnswer?.key,
    JSON.stringify(liveThinking ?? null),
  );

  unsubscribe();
} catch (error) {
  check('test harness completed', false, error instanceof Error ? error.message : String(error));
} finally {
  await conn?.close();
  server.stop(true);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
