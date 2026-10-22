/**
 * A fault-injecting front for a real broker, so a browser scenario can break
 * the network the way a user's network breaks while the bytes, headers and
 * routes still come from the broker itself.
 *
 * Every scenario gets its own proxy: its own origin means its own service
 * workers and caches, so scenarios never share browser state even in one
 * browser. Controls are applied per request and read live:
 *
 *   hold(path)     requests for a /cosy/ file wait until the returned release() runs
 *   block(path)    503 for a /cosy/ file
 *   replace(path, fn)  rewrite a /cosy/ file's body (a different build, a poisoned bundle)
 *   goOffline()    every connection is dropped until goOnline()
 *
 * A neighbouring app on the same origin is mounted at `/other-app/`, for
 * scope-isolation scenarios.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ServerWebSocket } from 'bun';
import { testCertificates } from './tls-ca.ts';

const NEIGHBOUR_WORKER = `self.addEventListener('install', (event) => {
  event.waitUntil(caches.open('neighbour-app-cache').then((cache) =>
    cache.put('/other-app/asset.txt', new Response('neighbour asset'))));
});
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
`;

type Rewrite = (body: string) => string | Promise<string>;

export class WebProxy {
  readonly requests: string[] = [];
  #server: Server;
  #upstream: string;
  #blocked = new Set<string>();
  #held = new Map<string, Promise<void>>();
  #rewrites = new Map<string, Rewrite>();
  #offline = false;
  #sockets = new Set<import('node:net').Socket>();
  #answering = new Set<{ path: string; since: number }>();
  port = 0;

  private constructor(upstream: string) {
    this.#upstream = upstream;
    this.#server = createServer((req, res) => void this.#answer(req, res));
    this.#server.on('connection', (socket) => {
      this.#sockets.add(socket);
      socket.on('close', () => this.#sockets.delete(socket));
    });
    // The app's live WebSocket is out of scope for these scenarios.
    this.#server.on('upgrade', (_req, socket) => socket.destroy());
  }

  static async start(upstream: string): Promise<WebProxy> {
    const proxy = new WebProxy(upstream);
    await new Promise<void>((resolve) => proxy.#server.listen(0, '127.0.0.1', resolve));
    proxy.port = (proxy.#server.address() as AddressInfo).port;
    return proxy;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** The app mount, `/cosy/`. */
  get base(): string {
    return `${this.origin}/cosy/`;
  }

  hold(path: string): () => void {
    let release!: () => void;
    this.#held.set(path, new Promise<void>((resolve) => { release = resolve; }));
    return () => { release(); this.#held.delete(path); };
  }

  block(path: string): void { this.#blocked.add(path); }
  unblock(path: string): void { this.#blocked.delete(path); }
  replace(path: string, rewrite: Rewrite): void { this.#rewrites.set(path, rewrite); }
  restore(path: string): void { this.#rewrites.delete(path); }

  goOffline(): void {
    this.#offline = true;
    for (const socket of this.#sockets) socket.destroy();
  }
  goOnline(): void { this.#offline = false; }

  requestCount(path: string): number {
    return this.requests.filter((entry) => entry === path).length;
  }

  /** Requests this proxy has received and not yet finished answering, oldest first. */
  unanswered(): { path: string; ms: number }[] {
    const now = Date.now();
    return [...this.#answering].map(({ path, since }) => ({ path, ms: now - since }));
  }

  async stop(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  /**
   * Bookkeeping for `unanswered()`: an entry lives exactly as long as the handler. Bun emits no
   * `close` on a response whose client has gone, so the handler's own end is the only signal.
   */
  async #answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const answering = { path: new URL(req.url ?? '/', 'http://x').pathname, since: Date.now() };
    this.#answering.add(answering);
    try {
      await this.#handle(req, res);
    } finally {
      this.#answering.delete(answering);
    }
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.#offline) return void req.socket.destroy();
    const url = new URL(req.url ?? '/', 'http://x');
    const path = decodeURIComponent(url.pathname);
    this.requests.push(path);

    if (path === '/other-app/sw.js') {
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
      return void res.end(NEIGHBOUR_WORKER);
    }
    if (path.startsWith('/other-app/')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return void res.end('<!doctype html><title>neighbour</title>neighbour app');
    }

    const rel = path.startsWith('/cosy/') ? path.slice('/cosy/'.length) || 'index.html' : undefined;
    if (rel !== undefined) {
      if (this.#blocked.has(rel)) return void res.writeHead(503).end('blocked');
      const gate = this.#held.get(rel);
      if (gate) await gate;
      if (this.#offline) return void req.socket.destroy();
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (name === 'host' || name === 'connection' || value === undefined) continue;
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    let upstream: Response;
    try {
      upstream = await fetch(`${this.#upstream}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
        redirect: 'manual',
      });
    } catch {
      return void res.writeHead(502).end('upstream unavailable');
    }
    const outHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(name)) {
        outHeaders[name] = value;
      }
    });
    let body: Buffer | string = Buffer.from(await upstream.arrayBuffer());
    const rewrite = rel === undefined ? undefined : this.#rewrites.get(rel);
    if (rewrite && upstream.status === 200) body = await rewrite(body.toString('utf8'));
    res.writeHead(upstream.status, outHeaders);
    res.end(body);
  }
}

interface SecureRouteSocket {
  target: string;
  origin: string;
  upstream?: WebSocket;
  waiting: Array<string | Buffer>;
}

/** TLS-terminating operator route for real-browser connection journeys. */
export class SecureWebRoute {
  readonly requests: Array<{ path: string; authenticated: boolean }> = [];
  readonly sockets = new Set<ServerWebSocket<SecureRouteSocket>>();
  private readonly upstreamSockets = new Set<WebSocket>();
  private readonly forwarding = new Set<AbortController>();
  blockedWebSockets = false;
  offline = false;
  private readonly server;

  constructor(upstream: string) {
    const certificates = testCertificates();
    this.server = Bun.serve<SecureRouteSocket>({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0, // Broker attention feeds use bounded long-poll requests.
      tls: { cert: certificates.certPem, key: certificates.keyPem },
      fetch: async (request, server) => {
        const url = new URL(request.url);
        this.requests.push({
          path: url.pathname,
          authenticated: request.headers.has("x-cosyncing-token"),
        });
        if (this.offline) return new Response("offline", { status: 503 });
        if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          if (this.blockedWebSockets)
            return new Response("blocked", { status: 502 });
          if (
            server.upgrade(request, {
              data: {
                target: `${upstream.replace(/^http/, "ws")}${url.pathname}${url.search}`,
                origin: request.headers.get("origin") ?? "",
                waiting: [],
              },
            })
          )
            return;
          return new Response("upgrade failed", { status: 400 });
        }
        const headers = new Headers(request.headers);
        headers.delete("host");
        headers.delete("connection");
        const abort = new AbortController();
        this.forwarding.add(abort);
        try {
          return await fetch(`${upstream}${url.pathname}${url.search}`, {
            method: request.method,
            headers,
            body: ["GET", "HEAD"].includes(request.method)
              ? undefined
              : request.body,
            signal: AbortSignal.any([request.signal, abort.signal]),
            redirect: "manual",
          });
        } catch (error) {
          if (abort.signal.aborted || request.signal.aborted)
            return new Response(null, { status: 499 });
          throw error;
        } finally {
          this.forwarding.delete(abort);
        }
      },
      websocket: {
        open: (socket) => {
          this.sockets.add(socket);
          const NativeWebSocket = WebSocket as typeof WebSocket & {
            new (
              url: string,
              options: { headers: Record<string, string> },
            ): WebSocket;
          };
          const upstreamSocket = (socket.data.upstream = new NativeWebSocket(
            socket.data.target,
            {
              headers: { origin: socket.data.origin },
            },
          ));
          this.upstreamSockets.add(upstreamSocket);
          upstreamSocket.onopen = () => {
            for (const frame of socket.data.waiting) upstreamSocket.send(frame);
            socket.data.waiting.length = 0;
          };
          upstreamSocket.onmessage = (event) => socket.send(event.data);
          upstreamSocket.onclose = () => {
            this.upstreamSockets.delete(upstreamSocket);
            socket.close();
          };
          upstreamSocket.onerror = () => socket.close();
        },
        message: (socket, message) => {
          if (socket.data.upstream?.readyState === WebSocket.OPEN)
            socket.data.upstream.send(message);
          else if (socket.data.waiting.length < 16)
            socket.data.waiting.push(message);
          else socket.close();
        },
        close: (socket) => {
          socket.terminate();
          this.sockets.delete(socket);
          if (socket.data.upstream) {
            (socket.data.upstream as WebSocket & { terminate(): void }).terminate();
          }
        },
      },
    });
  }

  get origin(): string {
    return `https://127.0.0.1:${this.server.port}`;
  }
  stop(): void {
    for (const abort of this.forwarding) abort.abort();
    for (const socket of this.sockets) socket.terminate();
    for (const socket of this.upstreamSockets) {
      (socket as WebSocket & { terminate(): void }).terminate();
    }
    // Bun 1.3.14 keeps a stale pendingWebSockets count after Chromium closes
    // these TLS sockets, even after both tracked socket sets are empty. Its
    // stop promise then never settles. Force-close resources above and stop
    // the listener synchronously, as the other Bun fixture servers do.
    void this.server.stop(true);
    this.server.unref();
  }
}
