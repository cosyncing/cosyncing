/**
 * An OpenCode server (`opencode serve`) as the broker sees it when the app creates a session or
 * opens a session's pickers: the provider and model catalog (`/provider`), the agent list
 * (`/agent`), session creation (`POST /session`), prompts (`POST /session/:id/prompt_async`),
 * and one attachable session with an empty transcript. The broker reaches it through `OPENCODE_URL`, with autoserve off.
 *
 * The test changes the catalog at will, can fail it with an HTTP status, and can hold each catalog
 * read until it answers it, so it decides exactly what every read the broker makes returns. Every
 * request and every create body is recorded.
 *
 *   const opencode = startFakeOpenCodeCatalog(worktree, { models: [{ id: 'm', name: 'M' }] });
 *   startBroker({ env: { OPENCODE_URL: opencode.url } });
 */

export const CATALOG_PROVIDER = 'test-provider';

export interface CatalogModel {
  id: string;
  name: string;
}

export interface CatalogAgent {
  name: string;
  description: string;
}

/** What `/provider` answers: the connected provider's models, or an HTTP failure status. */
export type CatalogAnswer = CatalogModel[] | number;

export interface HeldCatalogRead {
  answer(answer: CatalogAnswer): void;
}

export interface FakeOpenCodeCatalog {
  readonly url: string;
  /** The attachable session's id. */
  readonly sessionId: string;
  /** Every request, as `METHOD /path`. */
  readonly requests: string[];
  /** Every `POST /session` body, in order. */
  readonly creates: Array<Record<string, unknown>>;
  /** Every prompt sent to a session (`POST /session/:id/prompt_async`), in order. */
  readonly prompts: Array<{ sessionId: string; body: Record<string, unknown> }>;
  setModels(answer: CatalogAnswer): void;
  setAgents(agents: CatalogAgent[] | number): void;
  /** Answer the next `POST /session` with this HTTP status instead of creating a session. */
  failNextCreate(status: number): void;
  /** From now on every `/provider` read waits for {@link nextCatalogRead} to answer it (`false`: answer at once again). */
  holdCatalogReads(hold?: boolean): void;
  /** The next held `/provider` read (one already waiting, or the next to arrive). */
  nextCatalogRead(): Promise<HeldCatalogRead>;
  /** `/provider` reads answered so far. */
  catalogReads(): number;
  stop(): void;
}

function providerBody(models: CatalogModel[]): unknown {
  return {
    connected: [CATALOG_PROVIDER],
    all: [{
      id: CATALOG_PROVIDER,
      name: 'Test provider',
      models: Object.fromEntries(models.map((model) => [model.id, { id: model.id, name: model.name }])),
    }],
  };
}

export function startFakeOpenCodeCatalog(
  worktree: string,
  initial: { models?: CatalogAnswer; agents?: CatalogAgent[] | number; sessionId?: string } = {},
): FakeOpenCodeCatalog {
  const sessionId = initial.sessionId ?? 'ses_catalog';
  let models: CatalogAnswer = initial.models ?? [{ id: 'test-model', name: 'Test model' }];
  let agents: CatalogAgent[] | number = initial.agents ?? [{ name: 'build', description: 'Build things' }];
  let createFailure: number | undefined;
  let holding = false;
  let answered = 0;
  const waiting: Array<(read: HeldCatalogRead) => void> = [];
  const held: HeldCatalogRead[] = [];
  const requests: string[] = [];
  const creates: Array<Record<string, unknown>> = [];
  const prompts: Array<{ sessionId: string; body: Record<string, unknown> }> = [];
  const sessions: Array<Record<string, unknown>> = [
    { id: sessionId, slug: 'catalog', directory: worktree, title: 'Catalog session', time: { created: 1, updated: 2 } },
  ];

  const answerCatalog = (answer: CatalogAnswer): Response => {
    answered += 1;
    return typeof answer === 'number'
      ? new Response('catalog unavailable', { status: answer })
      : Response.json(providerBody(answer));
  };

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      requests.push(`${request.method} ${path}`);
      if (path === '/provider') {
        if (!holding) return answerCatalog(models);
        return new Promise<Response>((resolve) => {
          const read: HeldCatalogRead = { answer: (answer) => resolve(answerCatalog(answer)) };
          const taker = waiting.shift();
          if (taker) taker(read);
          else held.push(read);
        });
      }
      if (path === '/agent') {
        if (typeof agents === 'number') return new Response('agents unavailable', { status: agents });
        return Response.json(agents.map((agent) => ({ ...agent, mode: 'primary' })));
      }
      if (path === '/session' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        creates.push(body);
        if (createFailure !== undefined) {
          const status = createFailure;
          createFailure = undefined;
          return Response.json({ name: 'UnknownError', data: { message: 'refused by the fake' } }, { status });
        }
        // A real server rejects prompt-only fields on create.
        if (body.model != null || body.variant != null) return Response.json({ _tag: 'BadRequest' }, { status: 400 });
        const now = Date.now();
        const created = {
          id: `ses_created_${creates.length}`,
          slug: `created-${creates.length}`,
          title: typeof body.title === 'string' ? body.title : 'New session',
          directory: url.searchParams.get('directory') ?? worktree,
          time: { created: now, updated: now },
        };
        sessions.push(created);
        return Response.json(created);
      }
      if (path === '/session') return Response.json(sessions);
      if (path === '/session/status') return Response.json({});
      if (path === '/project') return Response.json([{ worktree }]);
      if (path === '/permission' || path === '/question') return Response.json([]);
      if (path === '/global/health') return Response.json({ healthy: true, version: '1.17.19' });
      if (path === '/event' || path === '/global/event') {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(': connected\n\n'));
          },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }
      const prompted = sessions.find((candidate) => path === `/session/${candidate.id}/prompt_async`);
      if (prompted && request.method === 'POST') {
        prompts.push({ sessionId: String(prompted.id), body: (await request.json().catch(() => ({}))) as Record<string, unknown> });
        return new Response(null, { status: 204 });
      }
      const session = sessions.find((candidate) => path === `/session/${candidate.id}`);
      if (session) return Response.json(session);
      if (sessions.some((candidate) => path === `/session/${candidate.id}/message`)) return Response.json([]);
      return new Response('not found', { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    sessionId,
    requests,
    creates,
    prompts,
    setModels(answer) {
      models = answer;
    },
    setAgents(next) {
      agents = next;
    },
    failNextCreate(status) {
      createFailure = status;
    },
    holdCatalogReads(hold = true) {
      holding = hold;
      // Reads already waiting are answered with the current catalog once holding stops.
      if (!hold) for (const read of held.splice(0)) read.answer(models);
    },
    nextCatalogRead() {
      const read = held.shift();
      if (read) return Promise.resolve(read);
      return new Promise((resolve) => waiting.push(resolve));
    },
    catalogReads: () => answered,
    stop() {
      for (const read of held.splice(0)) read.answer(503);
      server.stop(true);
    },
  };
}
