/**
 * The bridge's `session_shutdown` handler must finish inside the host's budget.
 *
 * The extension host gives a shutdown handler a small FIXED budget and prints
 * `handler timed out after 2000ms` when a handler overruns it. The handler used
 * to await an unbounded `flush()` and then an unbounded `/pi/bridge/bye`, so
 * under broker load every reviewed OMP exit -- parent, native child and approval
 * run -- printed that timeout. The cost is not cosmetic: `bye` carries the
 * shutdown REASON that separates a reload from a quit, and losing it downgrades
 * an explicit handover to disconnect-and-grace cleanup.
 *
 * Both stalls are exercised, because they fail through different code: a broker
 * that never answers `/pi/bridge/events` parks the flush, and one that never
 * answers `/pi/bridge/bye` parks the final post.
 *
 *   bun run packages/typescript/broker/test/pi/test-bridge-shutdown-budget.ts
 */
export {};
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { freshModuleSpecifier } from '../helpers/isolated-broker-fixture.ts';

const BRIDGE_MODULE_PATH = resolve(
  import.meta.dir,
  '../../../pi-engine/agent-extensions/cosyncing-bridge/index.ts',
);
const fixtureRoot = mkdtempSync(join(tmpdir(), 'cosyncing-bridge-shutdown-'));

// The budget the extension reads, so the assertion moves with the product
// rather than repeating a number that could drift away from it.
const BUDGET_MS = Number(process.env.COSYNCING_BRIDGE_SHUTDOWN_BUDGET_MS ?? 2_000);

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A wedged broker: accepts the request and never answers. Honours `signal` the
 *  way a real `fetch` does, so aborting is exercised rather than assumed -- but
 *  the handler must hold its budget even for an implementation that does not,
 *  which the bye case checks by making the abort arrive too late to matter. */
const hangUntilAborted = (signal?: AbortSignal | null): Promise<Response> =>
  new Promise<Response>((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) return reject(new Error('aborted'));
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

interface Run {
  elapsedMs: number;
  byeAttempted: boolean;
  byeReason: string | undefined;
}

/** Drive one shutdown against a broker that stalls `stall`. */
async function runShutdown(stall: 'events' | 'bye', emitFirst: boolean): Promise<Run> {
  const originalFetch = globalThis.fetch;
  const handlers = new Map<string, (event?: any, ctx?: any) => unknown>();
  let byeAttempted = false;
  let byeReason: string | undefined;
  let polled = false;
  try {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/pi/bridge/hello')) return Response.json({ id: 'bridge-shutdown-1' });
      if (url.endsWith('/pi/bridge/events')) {
        if (stall === 'events') return await hangUntilAborted(init?.signal);
        return Response.json({ ok: true });
      }
      if (url.endsWith('/pi/bridge/bye')) {
        byeAttempted = true;
        byeReason = JSON.parse(String(init?.body ?? '{}'))?.reason;
        if (stall === 'bye') return await hangUntilAborted(init?.signal);
        return Response.json({ ok: true });
      }
      if (url.includes('/pi/bridge/commands')) {
        polled = true;
        await sleep(20); // stand in for the broker's long poll
        return Response.json({ commands: [] });
      }
      return Response.json({});
    }) as typeof fetch;

    const bridge = await import(freshModuleSpecifier(BRIDGE_MODULE_PATH, fixtureRoot));
    const fakePi = {
      on(name: string, cb: (event?: any, ctx?: any) => unknown) { handlers.set(name, cb); },
      registerTool() { /* not exercised here */ },
      registerCommand() { /* not exercised here */ },
      getThinkingLevel() { return 'medium'; },
      sendUserMessage: async () => undefined,
      setModel: async () => true,
      setThinkingLevel: () => undefined,
    };
    (bridge as any).default(fakePi as any);
    const ctx = {
      cwd: join(fixtureRoot, 'work'),
      signal: new EventTarget(),
      sessionManager: { getSessionFile: () => join(fixtureRoot, 'work', 'session.jsonl'), entries: [] },
      model: { provider: 'fake', id: 'reasoner', name: 'Reasoner', reasoning: true, thinkingLevelMap: {} },
      modelRegistry: { getAvailable: () => [], find: () => undefined },
      ui: { setStatus: () => undefined },
      isIdle: () => true,
    };
    await handlers.get('session_start')?.({}, ctx);
    // A poll proves the registration id is SET. Without it `emit` no-ops and
    // the buffer this test needs to stall on is never filled.
    const readyBy = Date.now() + 5_000;
    while (!polled && Date.now() < readyBy) await sleep(10);

    if (emitFirst) {
      // Real buffered events, so the shutdown flush has work to park on rather
      // than returning early on an empty buffer. `agent_start` emits a status
      // row; `turn_start` alone emits nothing, which would make this vacuous.
      await handlers.get('turn_start')?.({}, ctx);
      await handlers.get('agent_start')?.({}, ctx);
      await handlers.get('tool_execution_start')?.(
        { toolCallId: 'call-1', toolName: 'bash', args: { command: 'true' } }, ctx,
      );
    }

    // Watchdog, not a second budget: a regression here HANGS rather than
    // returning late, and a hung sub-suite would stall the whole deterministic
    // run instead of reporting one failure. Generous enough that it can only
    // fire for a handler that is not bounded at all.
    const startedAt = Date.now();
    const shutdown = Promise.resolve(handlers.get('session_shutdown')?.({ reason: 'quit' }, ctx));
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const returned = await Promise.race([
      shutdown.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        watchdog = setTimeout(() => resolve(false), BUDGET_MS * 4);
      }),
    ]);
    if (watchdog) clearTimeout(watchdog);
    if (!returned) return { elapsedMs: Number.POSITIVE_INFINITY, byeAttempted, byeReason };
    return { elapsedMs: Date.now() - startedAt, byeAttempted, byeReason };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const run = await runShutdown('events', true);
  check(
    'a broker that never answers /pi/bridge/events cannot hold the shutdown handler past its budget',
    run.elapsedMs < BUDGET_MS,
    `${run.elapsedMs}ms of a ${BUDGET_MS}ms budget`,
  );
  check(
    'and the shutdown reason is still delivered, so ownership does not fall back to grace cleanup',
    run.byeAttempted && run.byeReason === 'quit',
    `byeAttempted=${run.byeAttempted} reason=${JSON.stringify(run.byeReason)}`,
  );
}

{
  const run = await runShutdown('bye', false);
  check(
    'a broker that never answers /pi/bridge/bye cannot hold the shutdown handler past its budget',
    run.elapsedMs < BUDGET_MS,
    `${run.elapsedMs}ms of a ${BUDGET_MS}ms budget`,
  );
}

{
  // The ordinary case must stay fast: the budget is a ceiling, not a wait.
  const run = await runShutdown('none' as 'events', true);
  check(
    'a healthy broker still shuts down promptly rather than spending the budget',
    run.elapsedMs < 500 && run.byeAttempted,
    `${run.elapsedMs}ms byeAttempted=${run.byeAttempted}`,
  );
}

rmSync(fixtureRoot, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
