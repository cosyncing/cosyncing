/**
 * A Kilo Code host for one session: the HTTP API the broker's Kilo adapter
 * reads (`KILO_URL`), plus the `kilo` executable it version-probes
 * (`COSYNCING_KILO_BIN`). The transcript read can be failed once or held open,
 * and every request is recorded, so a test observes what the broker asked.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const KILO_FAKE_VERSION = '7.4.23';

/**
 * A `kilo` that answers `--version` and nothing else. POSIX: a script whose
 * shebang names this Bun. Windows: a `.cmd` shim beside the script.
 */
export function installFakeKiloBinary(bin: string): string {
  mkdirSync(bin, { recursive: true });
  const program = `console.log('kilo ${KILO_FAKE_VERSION}');\n`;
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'kilo.fake.js'), program);
    const shim = join(bin, 'kilo.cmd');
    writeFileSync(shim, `@"${process.execPath}" "%~dp0kilo.fake.js" %*\r\n`);
    return shim;
  }
  const path = join(bin, 'kilo');
  writeFileSync(path, `#!${process.execPath}\n${program}`);
  chmodSync(path, 0o755);
  return path;
}

export type KiloRow = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };

export function kiloAssistantRow(sessionId: string, id: string, text: string): KiloRow {
  return {
    info: { id, role: 'assistant', sessionID: sessionId },
    parts: [{ id: `part-${id}`, type: 'text', text }],
  };
}

export interface FakeKiloHost {
  readonly url: string;
  readonly sessionId: string;
  /** Every request, as `METHOD /path`. */
  readonly requests: string[];
  rows: KiloRow[];
  /** The next transcript read answers 503. */
  failNextRead(): void;
  /** The next transcript read waits until `release()`; resolves once it started. */
  holdNextRead(): { started: Promise<void>; aborted: Promise<void>; release(): void };
  /** Move the session's `updated` time, as a write does. */
  touch(): void;
  stop(): void;
}

export function startFakeKiloHost(sessionId: string, directory: string): FakeKiloHost {
  let updated = 4;
  let mode: 'normal' | 'fail' | 'hold' = 'normal';
  let hold: { onStart: () => void; onAbort: () => void; released: Promise<void> } | undefined;
  const requests: string[] = [];
  const sessionRow = () => ({ id: sessionId, title: 'Kilo history fixture', directory, time: { created: 1, updated } });
  const host: FakeKiloHost = {
    url: '',
    sessionId,
    requests,
    rows: [],
    failNextRead() {
      mode = 'fail';
    },
    holdNextRead() {
      mode = 'hold';
      let onStart!: () => void;
      let onAbort!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { onStart = resolve; });
      const aborted = new Promise<void>((resolve) => { onAbort = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      hold = { onStart, onAbort, released };
      return { started, aborted, release };
    },
    touch() {
      updated += 1;
    },
    stop() {
      server.stop(true);
    },
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      if (url.pathname === '/global/health') return Response.json({ healthy: true, version: KILO_FAKE_VERSION });
      if (url.pathname === '/global/event') {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(': ready\n\n'));
          },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }
      if (url.pathname === '/session' && request.method === 'GET') return Response.json([sessionRow()]);
      if (url.pathname === '/session/status') return Response.json({ [sessionId]: { type: 'idle' } });
      if (url.pathname === '/provider') return Response.json({ connected: [], all: [] });
      if (url.pathname === '/permission') return Response.json([]);
      if (url.pathname === `/session/${sessionId}` && request.method === 'GET') return Response.json(sessionRow());
      if (url.pathname === `/session/${sessionId}/message` && request.method === 'GET') {
        if (mode === 'fail') {
          mode = 'normal';
          return Response.json({ error: 'temporary history failure' }, { status: 503 });
        }
        if (mode === 'hold' && hold) {
          mode = 'normal';
          const current = hold;
          hold = undefined;
          const snapshot = host.rows;
          request.signal.addEventListener('abort', () => current.onAbort(), { once: true });
          current.onStart();
          await current.released;
          return Response.json(snapshot);
        }
        return Response.json(host.rows);
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  (host as { url: string }).url = `http://127.0.0.1:${server.port}`;
  return host;
}
