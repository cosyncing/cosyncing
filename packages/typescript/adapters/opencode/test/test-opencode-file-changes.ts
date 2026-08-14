/**
 * Adapter-level regression for OpenCode's production fileChanges[] mapping (T1b finding 5):
 * a completed tool part's `metadata.diff` / `filediff.patch` must reach the canonical
 * tool-result as per-file FileChange entries (path, operation, additions/deletions), with the
 * part-level path injected when the diff itself is headerless.
 *
 * Exercises the REAL adapter path — a fake OpenCode HTTP/SSE server (same harness as
 * test-opencode-status-reconcile.ts) feeds `attach()` + `getHistory()` and a live
 * `message.part.updated` event, so the private mapPart seam is covered from both directions
 * without a live OpenCode process or model cost.
 *
 *   bun run packages/typescript/adapters/opencode/test/test-opencode-file-changes.ts   (exit 0 = all pass)
 */
export {};
import { mkdirSync } from 'node:fs';
import type { AgentMessage } from '../../../adapter-api/src/index.ts';
import { OpenCodeAdapter } from '../src/index.ts';

const DIR = '/tmp/cosyncing-opencode-filechanges';
const SESSION = {
  id: 'ses_filechanges',
  slug: 'filechanges',
  directory: DIR,
  title: 'fileChanges regression',
  time: { created: 1, updated: 2 },
};

// Single file, proper `---`/`+++` headers with a ranged hunk: +2 −1.
const SINGLE_DIFF = [
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,2 +1,3 @@',
  ' context',
  '+added one',
  '+added two',
  '-removed',
].join('\n');

// Two files in one git-style diff: an edit (+1 −1) and a created file (+2 −0).
const MULTI_DIFF = [
  'diff --git a/lib/a.ts b/lib/a.ts',
  '--- a/lib/a.ts',
  '+++ b/lib/a.ts',
  '@@ -1,2 +1,2 @@',
  '-old a',
  '+new a',
  ' keep',
  'diff --git a/lib/b.ts b/lib/b.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/lib/b.ts',
  '@@ -0,0 +1,2 @@',
  '+b one',
  '+b two',
].join('\n');

// Headerless hunk (OpenCode `filediff.patch` shape): the part-level file must become the path.
const BARE_DIFF = ['@@ -1,1 +1,1 @@', '-x', '+y'].join('\n');

const toolPart = (id: string, tool: string, callID: string, state: Record<string, unknown>) => ({
  id,
  type: 'tool',
  tool,
  callID,
  messageID: 'msg_a1',
  sessionID: SESSION.id,
  state: { status: 'completed', ...state },
});

const ROWS = [
  {
    info: { id: 'msg_u1', role: 'user', time: { created: 1000 } },
    parts: [{ id: 'prt_u1', type: 'text', text: 'edit the files' }],
  },
  {
    info: { id: 'msg_a1', role: 'assistant', time: { created: 2000 } },
    parts: [
      toolPart('prt_edit', 'edit', 'call-edit', {
        input: { filePath: 'src/app.ts' },
        output: 'ok',
        metadata: { diff: SINGLE_DIFF, filediff: { file: 'src/app.ts', additions: 2, deletions: 1 } },
      }),
      toolPart('prt_patch', 'patch', 'call-patch', {
        input: {},
        output: 'applied',
        metadata: { diff: MULTI_DIFF },
      }),
      toolPart('prt_write', 'write', 'call-write', {
        input: {},
        output: 'ok',
        metadata: { filediff: { file: 'src/only.ts', patch: BARE_DIFF, additions: 1, deletions: 1 } },
      }),
      toolPart('prt_bash', 'bash', 'call-bash', {
        input: { command: 'ls' },
        output: 'listing',
        metadata: { exit: 0, output: 'listing' },
      }),
    ],
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
              // Flush headers immediately, as OpenCode's real SSE route does.
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
if (!server) throw new Error('Could not allocate an OpenCode fileChanges test port after 20 attempts.');

let conn: Awaited<ReturnType<OpenCodeAdapter['attach']>> | undefined;
try {
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const store = `/tmp/cosyncing-opencode-filechanges-store-${server.port}`;
  mkdirSync(`${store}/storage/session`, { recursive: true }); // pin discovery to an empty store, not the real one
  const adapter = new OpenCodeAdapter({ baseUrl, storageDir: store, sseIdleMs: 30_000 });

  conn = await adapter.attach(SESSION.id, 'live');
  const history = await conn.getHistory();
  const tool = (callId: string) =>
    history.find((m): m is Extract<AgentMessage, { type: 'tool-result' }> => m.type === 'tool-result' && m.callId === callId);

  const edit = tool('call-edit') as any;
  check(
    'history edit: single-file diff → one fileChange with path/operation/± from the diff',
    edit?.fileChanges?.length === 1 &&
      edit.fileChanges[0].path === 'src/app.ts' &&
      edit.fileChanges[0].operation === 'edit' &&
      edit.fileChanges[0].additions === 2 &&
      edit.fileChanges[0].deletions === 1 &&
      edit.fileChanges[0].diff === SINGLE_DIFF,
    JSON.stringify(edit?.fileChanges?.map((c: any) => ({ p: c.path, o: c.operation, a: c.additions, d: c.deletions }))),
  );
  check(
    'history edit: top-level chips kept (path, inline diff, filediff ±)',
    edit?.path === 'src/app.ts' && edit?.diff === SINGLE_DIFF && edit?.additions === 2 && edit?.deletions === 1,
    `path=${edit?.path} +${edit?.additions} -${edit?.deletions}`,
  );

  const patch = tool('call-patch') as any;
  check(
    'history multi-file: splits into per-file entries with per-file operations and ±',
    patch?.fileChanges?.length === 2 &&
      patch.fileChanges[0].path === 'lib/a.ts' &&
      patch.fileChanges[0].operation === 'edit' &&
      patch.fileChanges[0].additions === 1 &&
      patch.fileChanges[0].deletions === 1 &&
      patch.fileChanges[1].path === 'lib/b.ts' &&
      patch.fileChanges[1].operation === 'create' &&
      patch.fileChanges[1].additions === 2 &&
      patch.fileChanges[1].deletions === 0,
    JSON.stringify(patch?.fileChanges?.map((c: any) => ({ p: c.path, o: c.operation, a: c.additions, d: c.deletions }))),
  );
  check(
    'history multi-file: per-file diff bodies are split, not the whole aggregate',
    typeof patch?.fileChanges?.[0]?.diff === 'string' &&
      patch.fileChanges[0].diff.includes('+new a') &&
      !patch.fileChanges[0].diff.includes('+b one') &&
      patch.fileChanges[1].diff.includes('+b one'),
  );

  const write = tool('call-write') as any;
  check(
    'history filediff.patch fallback: headerless hunk gets the part-level path injected',
    write?.fileChanges?.length === 1 &&
      write.fileChanges[0].path === 'src/only.ts' &&
      write.fileChanges[0].operation === 'edit' &&
      write.fileChanges[0].additions === 1 &&
      write.fileChanges[0].deletions === 1 &&
      write?.diff === BARE_DIFF &&
      write?.path === 'src/only.ts',
    JSON.stringify(write?.fileChanges),
  );

  const bash = tool('call-bash') as any;
  check(
    'history bash: no diff → no fileChanges invented',
    !!bash && bash.fileChanges === undefined && bash.diff === undefined,
    JSON.stringify({ fileChanges: bash?.fileChanges, diff: bash?.diff }),
  );

  // Live wire: the same mapping must hold for a message.part.updated tool part (the SSE path).
  const seen: AgentMessage[] = [];
  const unsub = conn.subscribe((m) => seen.push(m));
  await waitFor(() => eventClients.size > 0);
  sendEvent({
    type: 'message.part.updated',
    properties: {
      sessionID: SESSION.id,
      part: toolPart('prt_live', 'edit', 'call-live', {
        input: { filePath: 'src/app.ts' },
        output: 'ok',
        metadata: { diff: SINGLE_DIFF, filediff: { file: 'src/app.ts', additions: 2, deletions: 1 } },
      }),
    },
  });
  await waitFor(() => seen.some((m) => m.type === 'tool-result' && m.callId === 'call-live'));
  unsub();
  const live = seen.find((m) => m.type === 'tool-result' && (m as any).callId === 'call-live') as any;
  check(
    'live SSE tool part maps to the same fileChanges as history',
    live?.fileChanges?.length === 1 &&
      live.fileChanges[0].path === 'src/app.ts' &&
      live.fileChanges[0].operation === 'edit' &&
      live.fileChanges[0].additions === 2 &&
      live.fileChanges[0].deletions === 1,
    JSON.stringify(live?.fileChanges),
  );
} catch (err) {
  check('opencode fileChanges adapter regression', false, `threw: ${String(err)}`);
} finally {
  await conn?.close().catch(() => undefined);
  for (const client of [...eventClients]) {
    try {
      client.close();
    } catch {
      // already closed
    }
  }
  server.stop(true);
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
