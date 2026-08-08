/**
 * Extension-side regression: the bridge must RE-HELLO after a broker restart.
 *
 * issues-part2 item 3 re-flag: a broker restart forgets every live bridge registration; the old
 * bridge kept polling `/pi/bridge/commands` with its stale id, got 404 forever, and silently ran
 * unbridged — the app then diverged onto the resume adapter. The fix makes registration a loop:
 * poll 404 → drop out → re-hello (with history backfill), and hello failure (broker down) retries.
 *
 * Runs the REAL extension module against a fake broker + fake pi ExtensionAPI. No pi binary, no
 * real broker, no model cost.
 *
 *   bun run scripts/broker/tests/pi/test-pi-bridge-rehello.ts   (exit 0 = all pass)
 */
export {};

const PORT = Number(process.env.COSYNCING_TEST_PORT ?? 19000 + Math.floor(Math.random() * 20000));
process.env.COSYNCING_BROKER = `http://127.0.0.1:${PORT}`; // must be set BEFORE the module import below

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(100);
  }
  return pred();
}

// ── fake broker ──────────────────────────────────────────────────────────────
const helloBodies: any[] = [];
const knownIds = new Set<string>();
let nextBridgeId = 1;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/pi/bridge/hello' && req.method === 'POST') {
      const body = await req.json();
      helloBodies.push(body);
      const id = `bridge-${nextBridgeId++}`;
      knownIds.add(id);
      return Response.json({ id });
    }
    if (url.pathname === '/pi/bridge/commands' && req.method === 'GET') {
      const id = url.searchParams.get('id') ?? '';
      if (!knownIds.has(id)) return new Response('unknown bridge', { status: 404 });
      await sleep(200); // stand in for the real broker's long-poll so the loop doesn't spin hot
      return Response.json({ commands: [] });
    }
    return Response.json({}); // events/flush/bye — accept and ignore
  },
});

// ── fake pi ExtensionAPI + ctx ───────────────────────────────────────────────
const handlers = new Map<string, (event: any, ctx: any) => unknown>();
const fakePi: any = {
  on(name: string, fn: (event: any, ctx: any) => unknown) { handlers.set(name, fn); },
  registerTool() {},
  sendUserMessage() {},
  setModel() {},
  getThinkingLevel: () => undefined,
  setThinkingLevel() {},
};
const fakeCtx: any = {
  cwd: '/tmp/cosyncing-pi-rehello',
  sessionManager: {
    getSessionFile: () => '/tmp/cosyncing-pi-rehello/2026-07-12T00-00-00-000Z_rehello.jsonl',
    getEntries: () => [],
  },
  ui: { setStatus() {} },
};

try {
  const ext = (await import('../../../../packages/typescript/adapters/pi/agent-extensions/cosyncing-bridge/index.ts')).default;
  ext(fakePi);
  await handlers.get('session_start')?.({}, fakeCtx);

  // 1) initial registration
  const helloed = await waitFor(() => helloBodies.length === 1, 5000);
  check('bridge hellos on session_start', helloed, `hellos=${helloBodies.length}`);
  check('hello carries the session file', helloBodies[0]?.sessionFile?.includes('rehello.jsonl') === true);

  // 2) broker restart: forget every registration → the stale-id poll 404s → bridge must RE-HELLO
  knownIds.clear();
  const rehelloed = await waitFor(() => helloBodies.length === 2, 15000);
  check('poll 404 (broker restart) triggers an automatic re-hello', rehelloed, `hellos=${helloBodies.length}`);
  check('re-hello carries a fresh history backfill payload', rehelloed && Array.isArray(helloBodies[1]?.history));

  // 3) after re-registering, polling resumes under the NEW id (registration is live again)
  const rebridged = await waitFor(() => knownIds.size === 1, 5000);
  check('bridge resumes polling under the new registration', rebridged);

  // 4) session_shutdown stops the loop for good — another forget must NOT re-hello
  await handlers.get('session_shutdown')?.({ reason: 'quit' }, fakeCtx);
  knownIds.clear();
  const hellosAtShutdown = helloBodies.length;
  await sleep(7000); // > hello retry interval — long enough for a leak to show
  check('after session_shutdown the bridge never re-hellos again', helloBodies.length === hellosAtShutdown, `hellos=${helloBodies.length} (was ${hellosAtShutdown})`);
} finally {
  server.stop(true);
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\nFAIL: ${failed.length}/${results.length}` : `\n${results.length} passed, 0 failed`);
process.exit(failed.length ? 1 : 0);
