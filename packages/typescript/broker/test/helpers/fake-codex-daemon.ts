/**
 * A programmable stand-in for the Codex app-server control daemon.
 *
 * The daemon speaks JSON-RPC over a WebSocket carried on a unix socket, which is the ONLY transport
 * `CodexResumeConnection`'s daemon-proxy mode accepts. Suites that need to drive a production
 * connection's notification handling — permuted turn events, exactly-once terminals, exact-evidence
 * repair probes — need to both answer RPCs and PUSH notifications at chosen moments, which a fake
 * `codex` binary on stdio cannot do without a second control channel.
 *
 * Hermetic and offline: a unix socket inside the caller's temp dir, no ports, no host state.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';

function frame(payload: Buffer): Buffer {
  const head = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : payload.length < 65536
      ? (() => {
          const b = Buffer.alloc(4);
          b[0] = 0x81;
          b[1] = 126;
          b.writeUInt16BE(payload.length, 2);
          return b;
        })()
      : (() => {
          const b = Buffer.alloc(10);
          b[0] = 0x81;
          b[1] = 127;
          b.writeBigUInt64BE(BigInt(payload.length), 2);
          return b;
        })();
  return Buffer.concat([head, payload]);
}

class FakeDaemonClient {
  private buffer = Buffer.alloc(0);
  private handshake = Buffer.alloc(0);
  private ready = false;

  constructor(
    private readonly socket: Socket,
    private readonly onMessage: (message: any) => void,
    onClose: () => void,
  ) {
    socket.on('data', (chunk) => this.consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.on('error', () => socket.destroy());
    socket.on('close', onClose);
  }

  send(message: unknown): void {
    if (!this.ready) return;
    try {
      this.socket.write(frame(Buffer.from(JSON.stringify(message), 'utf8')));
    } catch {
      /* the client went away mid-push */
    }
  }

  close(): void {
    this.socket.destroy();
  }

  private consume(chunk: Buffer): void {
    if (!this.ready) {
      this.handshake = Buffer.concat([this.handshake, chunk]);
      const end = this.handshake.indexOf('\r\n\r\n');
      if (end === -1) return;
      const header = this.handshake.subarray(0, end).toString('utf8');
      const key = /sec-websocket-key:\s*(\S+)/i.exec(header)?.[1] ?? '';
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      this.socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'));
      this.ready = true;
      const rest = this.handshake.subarray(end + 4);
      if (rest.length) this.consume(rest);
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const opcode = this.buffer[0]! & 0x0f;
      const masked = Boolean(this.buffer[1]! & 0x80);
      let len = this.buffer[1]! & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buffer.length < off + 2) return;
        len = this.buffer.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (this.buffer.length < off + 8) return;
        len = Number(this.buffer.readBigUInt64BE(off));
        off += 8;
      }
      const mask = masked ? this.buffer.subarray(off, off + 4) : undefined;
      if (masked) off += 4;
      if (this.buffer.length < off + len) return;
      const raw = Buffer.from(this.buffer.subarray(off, off + len));
      if (mask) for (let i = 0; i < raw.length; i++) raw[i] = raw[i]! ^ mask[i % 4]!;
      this.buffer = this.buffer.subarray(off + len);
      if (opcode === 0x8) {
        this.socket.destroy();
        return;
      }
      if (opcode !== 0x1) continue;
      try {
        this.onMessage(JSON.parse(raw.toString('utf8')));
      } catch {
        /* skip malformed */
      }
    }
  }
}

export interface FakeCodexDaemonOptions {
  /** Methods accepted at the socket but deliberately left unanswered. */
  ignoreMethods?: string[];
  /** Threads `thread/loaded/list` reports. */
  loadedThreadIds?: string[];
  /** Result for `thread/resume`; the thread id is filled in when omitted. */
  resumeResult?: (params: any) => unknown;
  /** Result for `thread/read` — the exact-evidence probe the repair channel reads. */
  readResult?: (params: any) => unknown;
  /** Result for `thread/turns/list`. */
  turnsResult?: (params: any) => unknown;
}

/** A fake app-server daemon with recorded RPC traffic and a push channel for notifications. */
export class FakeCodexDaemon {
  private server: Server | undefined;
  private readonly clients = new Set<FakeDaemonClient>();
  /** Every method name this daemon answered, in order. */
  readonly calls: string[] = [];

  constructor(
    private readonly socketPath: string,
    private options: FakeCodexDaemonOptions = {},
  ) {}

  configure(options: FakeCodexDaemonOptions): void {
    this.options = { ...this.options, ...options };
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        const client: FakeDaemonClient = new FakeDaemonClient(
          socket,
          (message) => this.handle(client, message),
          () => this.clients.delete(client),
        );
        this.clients.add(client);
      });
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => resolve());
    });
  }

  /** Push one server→client notification to every connected client. */
  notify(method: string, params: unknown): void {
    for (const client of this.clients) client.send({ method, params });
  }

  async stop(): Promise<void> {
    for (const client of this.clients) client.close();
    this.clients.clear();
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private handle(client: FakeDaemonClient, message: any): void {
    if (!message?.method) return;
    this.calls.push(String(message.method));
    if (this.options.ignoreMethods?.includes(String(message.method))) return;
    const reply = (result: unknown): void => {
      if (message.id != null) client.send({ id: message.id, result });
    };
    switch (message.method) {
      case 'initialize':
        return reply({ userAgent: 'codex-fake/0.0.0' });
      case 'thread/loaded/list':
        return reply({ data: this.options.loadedThreadIds ?? [], nextCursor: null });
      case 'thread/resume':
        return reply(this.options.resumeResult?.(message.params) ?? {
          thread: { id: String(message.params?.threadId ?? ''), name: 'fake daemon thread' },
        });
      case 'thread/read':
        return reply(this.options.readResult?.(message.params) ?? {});
      case 'thread/turns/list':
        return reply(this.options.turnsResult?.(message.params) ?? { data: [] });
      default:
        return reply({});
    }
  }
}
