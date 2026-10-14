/**
 * An OpenCode server (`opencode serve`) for one session: its transcript, run
 * status, pending permissions and event bus, as the broker reads them through
 * `OPENCODE_URL`. The test moves the session the way OpenCode does (a write
 * that moves `time.updated`, one that does not, a revert), every request is
 * recorded, and a transcript read can be held open so concurrent requests
 * provably overlap it.
 *
 * Prompts (`prompt_async`) are recorded with the body the broker sent. Like
 * OpenCode, the server announces the new user row on its event bus before it
 * answers the POST (the bus can beat the 204), and the 204 itself can be held
 * so a test owns a prompt that is still in flight.
 */

export type OpenCodeRow = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };

const zeroTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

export const openCodeRows = {
  user(id: string, created: number, text: string): OpenCodeRow {
    return { info: { id, role: 'user', time: { created } }, parts: [{ id: `prt_${id}`, type: 'text', text }] };
  },
  /** An assistant message; one without `completed` is still running. */
  assistant(id: string, parent: string, created: number, parts: Array<Record<string, unknown>>, completed?: number): OpenCodeRow {
    return {
      info: {
        id,
        role: 'assistant',
        parentID: parent,
        time: completed ? { created, completed } : { created },
        ...(completed ? { finish: 'stop' } : {}),
        tokens: completed ? { ...zeroTokens, input: 10, output: 5 } : zeroTokens,
        cost: completed ? 0.01 : 0,
      },
      parts,
    };
  },
  /** A text part; one without an end time is still streaming. */
  text(id: string, body: string, start: number, end?: number, type = 'text'): Record<string, unknown> {
    return { id, type, text: body, time: end ? { start, end } : { start } };
  },
  tool(id: string, callID: string, status: 'running' | 'completed', command: string): Record<string, unknown> {
    return {
      id,
      type: 'tool',
      tool: 'bash',
      callID,
      state: status === 'completed'
        ? { status, input: { command }, output: 'ok', title: command, metadata: { exit: 0, output: 'ok' }, time: { start: 1, end: 2 } }
        : { status, input: { command }, time: { start: 1 } },
    };
  },
};

/** One `prompt_async` the broker sent: the id it supplied (if any), the text, the whole body. */
export interface OpenCodePrompt {
  messageID?: string;
  text: string;
  body: Record<string, any>;
}

export interface FakeOpenCodeServer {
  readonly url: string;
  readonly sessionId: string;
  /** Every request, as `METHOD /path`. */
  readonly requests: string[];
  /** Transcript reads answered so far. */
  transcriptReads(): number;
  /** Replace the transcript and move `time.updated`, as a write that bumps the session does. */
  setRows(rows: OpenCodeRow[]): void;
  /**
   * Replace the transcript WITHOUT moving `time.updated`: OpenCode moves it only every few
   * writes, so most writes are invisible to the session revision.
   */
  setRowsQuietly(rows: OpenCodeRow[]): void;
  /** While set, every transcript read observes a newer revision than the one before it. */
  setWriting(writing: boolean): void;
  /** Record a revert on the session, as OpenCode does. */
  setRevert(messageID: string): void;
  /** Set the run status and announce it on the event bus. */
  setBusy(busy: boolean): void;
  /** Announce a row's message and parts on the event bus, as OpenCode does for each write. */
  announce(row: OpenCodeRow): void;
  /** Publish any event on the bus (`message.removed`, `session.compacted`, ...). */
  publish(event: { type: string; properties: Record<string, unknown> }): void;
  /** Hold transcript reads until `release()`; `started` resolves once one is waiting. */
  holdReads(): { started: Promise<void>; release(): void };
  /** Every `prompt_async` received, oldest first. */
  readonly prompts: OpenCodePrompt[];
  /**
   * Hold `prompt_async` answers (after the user row is announced) until
   * `release()`; `started` resolves once one is waiting.
   */
  holdPrompts(): { started: Promise<void>; release(): void };
  /** The agents `GET /agent` lists (OpenCode's shape: name, mode, description). */
  setAgents(agents: Array<{ name: string; mode?: string; description?: string }>): void;
  /** Every agent switch the broker requested, oldest first. */
  readonly agentSwitches: string[];
  stop(): void;
}

export function startFakeOpenCode(worktree: string, sessionId = 'ses_append'): FakeOpenCodeServer {
  const session: Record<string, any> = {
    id: sessionId, slug: 'append', directory: worktree, title: 'append', time: { created: 1, updated: 2 },
  };
  let rows: OpenCodeRow[] = [];
  let busy = false;
  let writing = false;
  let reads = 0;
  let hold: { onStart: () => void; released: Promise<void> } | undefined;
  let promptHold: { onStart: () => void; released: Promise<void> } | undefined;
  let agents: Array<{ name: string; mode?: string; description?: string }> = [];
  const prompts: OpenCodePrompt[] = [];
  const agentSwitches: string[] = [];
  let promptSequence = 0;
  const requests: string[] = [];
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const publish = (payload: unknown) => {
    const frame = new TextEncoder().encode(`data: ${JSON.stringify({ payload })}\n\n`);
    for (const controller of streams) {
      try {
        controller.enqueue(frame);
      } catch {
        streams.delete(controller);
      }
    }
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    // A held read or prompt (and a quiet event stream) must outlive Bun's 10 s idle default.
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      if (url.pathname === '/global/event' || url.pathname === '/event') {
        let own: ReadableStreamDefaultController<Uint8Array> | undefined;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            own = controller;
            streams.add(controller);
            controller.enqueue(new TextEncoder().encode(': connected\n\n'));
          },
          cancel() {
            if (own) streams.delete(own);
          },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }
      if (url.pathname === '/project') return Response.json([{ worktree }]);
      if (url.pathname === '/session' && request.method === 'GET') return Response.json([session]);
      if (url.pathname === '/session/status') return Response.json(busy ? { [sessionId]: { type: 'busy' } } : {});
      if (url.pathname === `/session/${sessionId}/message`) {
        if (writing) session.time.updated += 1;
        const answer = rows;
        if (hold) {
          const current = hold;
          current.onStart();
          await current.released;
        }
        reads += 1;
        return Response.json(answer);
      }
      if (url.pathname === `/session/${sessionId}/prompt_async` && request.method === 'POST') {
        const body = await request.json().catch(() => ({})) as Record<string, any>;
        const messageID = typeof body.messageID === 'string' ? body.messageID : undefined;
        const text = String(body.parts?.find((part: any) => part?.type === 'text')?.text ?? '');
        prompts.push({ ...(messageID ? { messageID } : {}), text, body });
        // The user row lands in the transcript and on the bus before the POST is answered.
        const row = openCodeRows.user(messageID ?? `msg_fake${String(++promptSequence).padStart(6, '0')}`, Date.now(), text);
        rows = [...rows, row];
        session.time.updated += 1;
        publish({ type: 'message.updated', properties: { sessionID: sessionId, info: { ...row.info, sessionID: sessionId } } });
        for (const part of row.parts) {
          publish({ type: 'message.part.updated', properties: { sessionID: sessionId, part: { ...part, sessionID: sessionId, messageID: row.info.id } } });
        }
        if (promptHold) {
          const current = promptHold;
          current.onStart();
          await current.released;
        }
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/agent') return Response.json(agents);
      if (url.pathname === `/api/session/${sessionId}/agent` && request.method === 'POST') {
        const body = await request.json().catch(() => ({})) as Record<string, any>;
        agentSwitches.push(String(body.agent ?? ''));
        return new Response(null, { status: 204 });
      }
      if (url.pathname === `/session/${sessionId}`) return Response.json(session);
      if (url.pathname === '/permission') return Response.json([]);
      if (url.pathname === '/question') return Response.json([]);
      return new Response('not found', { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    sessionId,
    requests,
    transcriptReads: () => reads,
    setRows(next) {
      rows = next;
      session.time.updated += 1;
    },
    setRowsQuietly(next) {
      rows = next;
    },
    setWriting(next) {
      writing = next;
    },
    setRevert(messageID) {
      session.revert = { messageID };
    },
    setBusy(next) {
      busy = next;
      publish({ type: 'session.status', properties: { sessionID: sessionId, status: { type: next ? 'busy' : 'idle' } } });
    },
    announce(row) {
      publish({ type: 'message.updated', properties: { sessionID: sessionId, info: { ...row.info, sessionID: sessionId } } });
      for (const part of row.parts) {
        publish({ type: 'message.part.updated', properties: { sessionID: sessionId, part: { ...part, sessionID: sessionId, messageID: row.info.id } } });
      }
    },
    publish(event) {
      publish(event);
    },
    holdReads() {
      let onStart!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { onStart = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      hold = { onStart, released };
      return {
        started,
        release() {
          hold = undefined;
          release();
        },
      };
    },
    prompts,
    holdPrompts() {
      let onStart!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { onStart = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      promptHold = { onStart, released };
      return {
        started,
        release() {
          promptHold = undefined;
          release();
        },
      };
    },
    setAgents(next) {
      agents = next;
    },
    agentSwitches,
    stop() {
      promptHold = undefined;
      server.stop(true);
    },
  };
}
