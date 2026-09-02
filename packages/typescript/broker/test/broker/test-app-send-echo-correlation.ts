/**
 * C1R: `PromptInput.clientMessageId` reaches the transcript echo as `clientKey`
 * ONLY over genuine native correlation — equal text is never identity.
 *
 * Covers the echo paths end-to-end without a live agent:
 *  - OpenCode serve: the adapter supplies the native `messageID` on
 *    `prompt_async` (registered BEFORE the POST), so the SSE user part is
 *    attributed by exact id — including when the SSE echo beats the 204 —
 *    and an identical TUI-typed message stays unstamped.
 *  - Claude observe tail (the True-Sync echo surface): Claude Code writes the
 *    JSONL itself with no id handle, so NO echo is ever stamped — a terminal
 *    prompt landing before the app echo cannot steal its identity.
 *  - Pi bridge: Pi user messages have no native id, so the relayed echo stays
 *    unstamped; the prompt itself is still queued for the extension.
 * (Codex's exact clientId round-trip is covered in codex/resume-fake.ts; the
 * OpenCode Run and direct Pi paths stamp their own synchronously-emitted echo.)
 *
 *   bun run packages/typescript/broker/test/broker/test-app-send-echo-correlation.ts
 */
export {};
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage, SessionInfo } from '../../../adapter-api/src/index.ts';
import { ClaudeObserveConnection } from '../../../adapters/claude/src/implementation.ts';
import { OpenCodeAdapter } from '../../../adapters/opencode/src/index.ts';
import { PiBridgeConnection } from '../../../adapters/pi/src/bridge.ts';

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

type UserEcho = Extract<AgentMessage, { type: 'user-message' }>;
const userEchoes = (messages: AgentMessage[]): UserEcho[] =>
  messages.filter((m): m is UserEcho => m.type === 'user-message');

// ── OpenCode serve end-to-end: native messageID correlation ─────────────────
{
  const DIR = join(tmpdir(), 'cosyncing-c1r-opencode');
  mkdirSync(DIR, { recursive: true });
  const SESSION = {
    id: 'ses_c1r',
    slug: 'c1r',
    directory: DIR,
    title: 'echo correlation',
    time: { created: 1, updated: 2 },
  };
  const eventClients = new Set<ReadableStreamDefaultController>();
  const sendEvent = (event: unknown) => {
    const frame = new TextEncoder().encode(`data: ${JSON.stringify({ payload: event })}\n\n`);
    for (const client of [...eventClients]) {
      try {
        client.enqueue(frame);
      } catch {
        eventClients.delete(client);
      }
    }
  };
  /** The messageID our adapter supplied on prompt_async, captured by the fake server. */
  let promptedMessageID: string | undefined;
  let promptedText = '';
  let server: ReturnType<typeof Bun.serve> | undefined;
  for (let attempt = 0; attempt < 20 && !server; attempt++) {
    try {
      server = Bun.serve({
        hostname: '127.0.0.1',
        port: 50000 + Math.floor(Math.random() * 15000),
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === '/global/event') {
            return new Response(
              new ReadableStream({
                start(controller) {
                  eventClients.add(controller);
                  controller.enqueue(new TextEncoder().encode(': connected\n\n'));
                },
              }),
              { headers: { 'content-type': 'text/event-stream' } },
            );
          }
          if (url.pathname === '/project') return Response.json([{ worktree: DIR }]);
          if (url.pathname === '/session' && req.method === 'GET') return Response.json([SESSION]);
          if (url.pathname === '/session/status') return Response.json({});
          if (url.pathname === `/session/${SESSION.id}/message`) {
            // After a prompt, history contains the app-send row under OUR supplied id.
            if (!promptedMessageID) return Response.json([]);
            return Response.json([
              {
                info: { id: promptedMessageID, role: 'user', time: { created: 5000 } },
                parts: [{ type: 'text', text: promptedText }],
              },
            ]);
          }
          if (url.pathname === `/session/${SESSION.id}/prompt_async`) {
            return (async () => {
              const body = (await req.json().catch(() => ({}))) as any;
              promptedMessageID = typeof body?.messageID === 'string' ? body.messageID : undefined;
              promptedText = String(body?.parts?.[0]?.text ?? '');
              // Regression: the event bus can beat the HTTP response — emit the
              // user echo BEFORE the 204 so a response-time registration would
              // provably miss it.
              if (promptedMessageID) {
                sendEvent({
                  type: 'message.updated',
                  properties: {
                    sessionID: SESSION.id,
                    info: { id: promptedMessageID, role: 'user', time: { created: 5000 } },
                  },
                });
                sendEvent({
                  type: 'message.part.updated',
                  properties: {
                    sessionID: SESSION.id,
                    part: { id: `prt_${promptedMessageID}`, type: 'text', text: promptedText, messageID: promptedMessageID },
                  },
                });
              }
              await Bun.sleep(100);
              return new Response(null, { status: 204 });
            })();
          }
          if (url.pathname === `/session/${SESSION.id}`) return Response.json(SESSION);
          if (url.pathname === '/question' || url.pathname === '/permission') return Response.json([]);
          return new Response('not found', { status: 404 });
        },
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
  if (!server) throw new Error('Could not allocate an OpenCode echo test port.');
  let conn: Awaited<ReturnType<OpenCodeAdapter['attach']>> | undefined;
  try {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const store = `/tmp/cosyncing-c1r-opencode-store-${server.port}`;
    mkdirSync(`${store}/storage/session`, { recursive: true });
    const adapter = new OpenCodeAdapter({ baseUrl, storageDir: store, sseIdleMs: 30_000 });
    conn = await adapter.attach(SESSION.id, 'live');
    const messages: AgentMessage[] = [];
    conn.subscribe((m) => messages.push(m));
    await conn.getHistory();

    await conn.sendPrompt({ text: 'serve me', clientMessageId: 'ca.oc.1' });
    check(
      'opencode serve: prompt_async carries a native-format messageID we supplied',
      typeof promptedMessageID === 'string' && /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(promptedMessageID),
      `messageID=${promptedMessageID}`,
    );
    await waitFor(() => userEchoes(messages).some((m) => m.key === promptedMessageID));
    const stamped = userEchoes(messages).find((m) => m.key === promptedMessageID);
    check(
      'opencode serve: an SSE echo arriving BEFORE the prompt_async response is stamped by exact id',
      stamped?.clientKey === 'ca.oc.1',
      JSON.stringify(stamped),
    );

    sendEvent({
      type: 'message.updated',
      properties: { sessionID: SESSION.id, info: { id: 'msg_tui', role: 'user', time: { created: 6000 } } },
    });
    sendEvent({
      type: 'message.part.updated',
      properties: {
        sessionID: SESSION.id,
        part: { id: 'prt_tui', type: 'text', text: 'serve me', messageID: 'msg_tui' },
      },
    });
    await waitFor(() => userEchoes(messages).some((m) => m.key === 'msg_tui'));
    const tui = userEchoes(messages).find((m) => m.key === 'msg_tui');
    check(
      'opencode serve: an identical TUI-typed message stays unstamped',
      tui !== undefined && tui.clientKey === undefined,
      JSON.stringify(tui),
    );

    const history = userEchoes(await conn.getHistory());
    check(
      'opencode serve: history keeps the stamp for reattach convergence',
      history.some((m) => m.key === promptedMessageID && m.clientKey === 'ca.oc.1'),
      JSON.stringify(history),
    );
  } finally {
    await conn?.close().catch(() => {});
    server.stop(true);
    rmSync(DIR, { recursive: true, force: true });
  }
}

// ── Claude observe tail: NO text-based stamping on this surface ─────────────
{
  const dir = join(tmpdir(), `cosyncing-c1r-claude-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const jsonl = join(dir, 'session.jsonl');
  const line = (o: unknown) => JSON.stringify(o) + '\n';
  writeFileSync(
    jsonl,
    line({
      type: 'user',
      uuid: 'uu0',
      timestamp: '2026-07-23T00:00:00.000Z',
      message: { role: 'user', content: 'history line' },
    }),
  );
  const info = {
    id: 'claude-c1r',
    tool: 'claude',
    title: 'tail echo',
    status: 'idle',
    attachMode: 'observe',
    cwd: dir,
  } as unknown as SessionInfo;
  const conn = new ClaudeObserveConnection(jsonl, info);
  const messages: AgentMessage[] = [];
  const unsubscribe = conn.subscribe((m) => messages.push(m));
  try {
    await conn.getHistory(); // baselines the tail
    // Regression (terminal-before-app-echo): a terminal prompt with the SAME
    // text as an in-flight app send lands first. Claude Code gives the app send
    // no id handle, so NEITHER line may claim the app identity — text-FIFO
    // stamping here would hand `uu1` (the terminal line) the app's clientKey.
    appendFileSync(
      jsonl,
      line({
        type: 'user',
        uuid: 'uu1',
        timestamp: '2026-07-23T00:01:00.000Z',
        message: { role: 'user', content: 'hello from app' },
      }) +
        line({
          type: 'user',
          uuid: 'uu2',
          timestamp: '2026-07-23T00:02:00.000Z',
          message: { role: 'user', content: 'hello from app' },
        }),
    );
    await waitFor(() => userEchoes(messages).filter((m) => m.text === 'hello from app').length >= 2);
    const echoes = userEchoes(messages).filter((m) => m.text === 'hello from app');
    check(
      'claude tail: terminal-before-app-echo — no user line is ever stamped',
      echoes.length === 2 && echoes.every((m) => m.clientKey === undefined),
      JSON.stringify(echoes),
    );
    check(
      'claude tail: both identical lines keep distinct native keys (no merge/drop)',
      echoes[0]?.key !== undefined && echoes[1]?.key !== undefined && echoes[0]?.key !== echoes[1]?.key,
      JSON.stringify(echoes.map((m) => m.key)),
    );
  } finally {
    unsubscribe();
    await conn.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Pi bridge: relayed echoes stay unstamped (no native id exists) ──────────
{
  const info = {
    id: 'pi-bridge-c1r',
    tool: 'pi',
    title: 'bridge echo',
    status: 'idle',
    attachMode: 'live',
  } as unknown as SessionInfo;
  const conn = new PiBridgeConnection(info);
  const messages: AgentMessage[] = [];
  conn.subscribe((m) => messages.push(m));
  await conn.sendPrompt({ text: 'ping from app', clientMessageId: 'ca.pi.1' });
  const commands = await conn.takeCommands();
  check(
    'pi-bridge: the app send is queued for the extension',
    commands.some((c) => c.kind === 'prompt' && c.text === 'ping from app'),
    JSON.stringify(commands),
  );
  conn.ingest({ t: 'user', key: 'pik1', text: 'ping from app', sentAt: 1000 });
  conn.ingest({ t: 'user', key: 'pik2', text: 'ping from app', sentAt: 2000 });
  const echoes = userEchoes(messages);
  check(
    'pi-bridge: relayed user echoes are never stamped (terminal is indistinguishable)',
    echoes.length === 2 && echoes.every((m) => m.clientKey === undefined),
    JSON.stringify(echoes),
  );
  const history = userEchoes(await conn.getHistory());
  check(
    'pi-bridge: history carries both unstamped echoes with their relay keys',
    history.length === 2 && history[0]?.key === 'pik1' && history[1]?.key === 'pik2' &&
      history.every((m) => m.clientKey === undefined),
    JSON.stringify(history),
  );
  await conn.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
// Watchers/SSE reconnect timers keep the loop alive; exit explicitly like the
// other standalone adapter tests.
process.exit(failed.length ? 1 : 0);
