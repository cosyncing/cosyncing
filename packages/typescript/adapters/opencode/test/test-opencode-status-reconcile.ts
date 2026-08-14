/**
 * Deterministic OpenCode roster lifecycle reconciliation.
 *
 * Uses a fake OpenCode HTTP/SSE server to prove `/session/status` seeds and repairs the
 * edge-triggered global event stream without a model, broker, or live OpenCode process.
 *
 *   bun run packages/typescript/adapters/opencode/test/test-opencode-status-reconcile.ts
 */
export {};
import { mkdirSync } from 'node:fs';
import { OpenCodeAdapter } from '../src/index.ts';

const DIR = '/tmp/cosyncing-opencode-status';
const SESSION = {
  id: 'ses_status',
  slug: 'status',
  directory: DIR,
  title: 'status reconciliation',
  time: { created: 1, updated: 2 },
};

let statusSnapshot: Record<string, { type: 'idle' | 'busy' | 'retry' }> = {};
let statusRequests = 0;
let delayNextStatus = false;
let releaseStatus: (() => void) | undefined;
const eventClients = new Set<ReadableStreamDefaultController>();
let eventStreamStarts = 0;

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

function closeEventStreams(): void {
  for (const client of [...eventClients]) {
    try {
      client.close();
    } catch {
      // already closed
    }
    eventClients.delete(client);
  }
}

let server: ReturnType<typeof Bun.serve> | undefined;
for (let attempt = 0; attempt < 20 && !server; attempt++) {
  try {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 50000 + Math.floor(Math.random() * 15000),
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/global/event') {
          return new Response(new ReadableStream({
            start(controller) {
              eventStreamStarts++;
              eventClients.add(controller);
              // Flush response headers immediately, as OpenCode's real SSE route does with its
              // connected event. Without a first byte Bun's client keeps awaiting fetch(response).
              controller.enqueue(new TextEncoder().encode(': connected\n\n'));
            },
            cancel() {
              // Pruned on the next send/close.
            },
          }), { headers: { 'content-type': 'text/event-stream' } });
        }
        if (url.pathname === '/project') return Response.json([{ worktree: DIR }]);
        if (url.pathname === '/session' && req.method === 'GET') return Response.json([SESSION]);
        if (url.pathname === '/session/status' && req.method === 'GET') {
          statusRequests++;
          const response = structuredClone(statusSnapshot); // point-in-time evidence at request start
          if (delayNextStatus) {
            delayNextStatus = false;
            await new Promise<void>((resolve) => { releaseStatus = resolve; });
          }
          return Response.json(response);
        }
        if (url.pathname === '/question' || url.pathname === '/permission') return Response.json([]);
        return new Response('not found', { status: 404 });
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
  }
}
if (!server) throw new Error('Could not allocate an OpenCode status test port after 20 attempts.');

try {
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const store = `/tmp/cosyncing-opencode-status-store-${server.port}`;
  mkdirSync(`${store}/storage/session`, { recursive: true });
  const adapter = new OpenCodeAdapter({ baseUrl, storageDir: store, sseIdleMs: 30_000 });

  // A late observer receives no historical SSE edge. The REST snapshot must seed Working.
  statusSnapshot = { [SESSION.id]: { type: 'busy' } };
  const initial = await adapter.discoverSessions();
  check(
    'initial busy session reconciles to working',
    initial.find((session) => session.id === SESSION.id)?.status === 'working',
    `status=${initial.find((session) => session.id === SESSION.id)?.status}`,
  );

  // Native lifecycle edges remain authoritative in steady state.
  await waitFor(() => eventClients.size > 0);
  sendEvent({ type: 'session.idle', properties: { sessionID: SESSION.id } });
  const becameIdle = await waitFor(() => !adapter.anySessionBusy());
  check('working→idle SSE transition clears Working', becameIdle, `busy=${adapter.anySessionBusy()}`);

  // Blocking input dominates a later busy status and survives an empty pending-list fallback.
  sendEvent({ type: 'question.asked', properties: { sessionID: SESSION.id, id: 'question-1' } });
  sendEvent({ type: 'session.status', properties: { sessionID: SESSION.id, status: { type: 'busy' } } });
  await Bun.sleep(50);
  const needsInput = await adapter.discoverSessions();
  check(
    'needs-input takes precedence over busy snapshot/event',
    needsInput.find((session) => session.id === SESSION.id)?.status === 'needs-input',
    `status=${needsInput.find((session) => session.id === SESSION.id)?.status}`,
  );
  sendEvent({ type: 'question.replied', properties: { sessionID: SESSION.id, id: 'question-1' } });
  sendEvent({ type: 'session.idle', properties: { sessionID: SESSION.id } });
  await waitFor(() => !adapter.anySessionBusy());

  // A status edge received while REST is in flight must win over that older response.
  statusSnapshot = { [SESSION.id]: { type: 'busy' } };
  delayNextStatus = true;
  const requestsBeforeRace = statusRequests;
  const racedDiscovery = adapter.discoverSessions();
  await waitFor(() => statusRequests > requestsBeforeRace && !!releaseStatus);
  sendEvent({ type: 'session.idle', properties: { sessionID: SESSION.id } });
  await Bun.sleep(50);
  releaseStatus?.();
  releaseStatus = undefined;
  const raced = await racedDiscovery;
  check(
    'newer SSE event wins over late busy reconciliation',
    raced.find((session) => session.id === SESSION.id)?.status === 'idle',
    `status=${raced.find((session) => session.id === SESSION.id)?.status}`,
  );

  // Dropping and reopening SSE must refresh state even without another roster poll.
  statusSnapshot = { [SESSION.id]: { type: 'busy' } };
  const streamsBeforeReconnect = eventStreamStarts;
  const requestsBeforeReconnect = statusRequests;
  closeEventStreams();
  const reconnected = await waitFor(
    () => eventStreamStarts > streamsBeforeReconnect && statusRequests > requestsBeforeReconnect && adapter.anySessionBusy(),
    6000,
  );
  check(
    'SSE reconnect reconciles an already-busy session',
    reconnected,
    `streams=${eventStreamStarts}, statusRequests=${statusRequests}, busy=${adapter.anySessionBusy()}`,
  );

  // OpenCode may omit idle sessions from its status map. Omission must clear stale Working.
  statusSnapshot = {};
  const repaired = await adapter.discoverSessions();
  check(
    'status-map omission clears stale Working',
    repaired.find((session) => session.id === SESSION.id)?.status === 'idle',
    `status=${repaired.find((session) => session.id === SESSION.id)?.status}`,
  );
} finally {
  releaseStatus?.();
  closeEventStreams();
  server.stop(true);
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
