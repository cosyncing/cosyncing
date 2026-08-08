/**
 * No-cost probe for Codex sync-server mode.
 *
 * It verifies only the local app-server daemon WebSocket transport and loaded-thread enumeration:
 *   initialize -> thread/loaded/list
 *
 * It does not start a turn, call a model, mutate files, or start the daemon. If the daemon control
 * socket is absent, the probe exits 0 with SKIP so it can live in the broader test loop safely.
 *
 *   COSYNCING_CODEX_SYNC_SERVER=1 bun run scripts/broker/tests/codex/live-proxy.ts
 */
export {};
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_SOCK = join(homedir(), '.codex', 'app-server-control', 'app-server-control.sock');
const sock = process.env.COSYNCING_CODEX_APP_SERVER_SOCK || DEFAULT_SOCK;

if (!/^(1|true|yes|on)$/i.test(process.env.COSYNCING_CODEX_SYNC_SERVER ?? process.env.COSYNCING_CODEX_LIVE ?? '')) {
  console.log('SKIP  Codex sync-server mode is disabled (set COSYNCING_CODEX_SYNC_SERVER=1)');
  process.exit(0);
}

if (!existsSync(sock)) {
  console.log(`SKIP  Codex app-server control socket not found: ${sock}`);
  process.exit(0);
}

type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

let nextId = 0;
const pending = new Map<string, Pending>();
let transport: UnixSocketWebSocket | undefined;

const write = (obj: unknown) => {
  transport?.write(obj);
};

const rpc = <T = any>(method: string, params: unknown, timeoutMs = 5000): Promise<T> => {
  const id = ++nextId;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(String(id))) reject(new Error(`timeout ${method}`));
    }, timeoutMs);
    pending.set(String(id), { resolve, reject, timer });
    write({ id, method, params });
  });
};

function handleLine(line: string): void {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg?.id == null || (!('result' in msg) && !('error' in msg))) return;
  const p = pending.get(String(msg.id));
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(String(msg.id));
  msg.error ? p.reject(new Error(String(msg.error?.message ?? msg.error))) : p.resolve(msg.result);
}

class UnixSocketWebSocket {
  private socket: Socket | undefined;
  private buffer = Buffer.alloc(0);
  private connected = false;
  private closed = false;

  constructor(
    private readonly socketPath: string,
    private readonly onMessage: (line: string) => void,
  ) {}

  connect(timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.socketPath);
      this.socket = socket;
      const key = randomBytes(16).toString('base64');
      let handshake = Buffer.alloc(0);
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        err ? reject(err) : resolve();
      };
      const timer = setTimeout(() => finish(new Error('handshake timeout')), timeoutMs);
      socket.on('connect', () => {
        socket.write(
          [
            'GET / HTTP/1.1',
            'Host: localhost',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            '',
            '',
          ].join('\r\n'),
        );
      });
      socket.on('data', (chunk) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (!this.connected) {
          handshake = Buffer.concat([handshake, data]);
          const idx = handshake.indexOf('\r\n\r\n');
          if (idx === -1) return;
          const header = handshake.subarray(0, idx).toString('utf8');
          if (!/^HTTP\/1\.[01] 101\b/.test(header)) {
            finish(new Error(`upgrade failed: ${header.split('\r\n')[0] || 'no status'}`));
            socket.destroy();
            return;
          }
          this.connected = true;
          finish();
          const rest = handshake.subarray(idx + 4);
          if (rest.length) this.consume(rest);
          return;
        }
        this.consume(data);
      });
      socket.on('error', (err) => finish(err instanceof Error ? err : new Error(String(err))));
      socket.on('close', () => {
        this.closed = true;
      });
    });
  }

  write(obj: unknown): void {
    if (!this.socket || this.closed) return;
    this.socket.write(webSocketFrame(Buffer.from(JSON.stringify(obj), 'utf8'), 0x1));
  }

  close(): void {
    this.closed = true;
    this.socket?.destroy();
    this.socket = undefined;
    this.buffer = Buffer.alloc(0);
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = readWebSocketFrame(this.buffer);
      if (!frame) return;
      this.buffer = this.buffer.subarray(frame.bytes);
      if (frame.opcode === 0x1) {
        this.onMessage(frame.payload.toString('utf8'));
      } else if (frame.opcode === 0x8) {
        this.close();
        return;
      } else if (frame.opcode === 0x9 && this.socket && !this.closed) {
        this.socket.write(webSocketFrame(frame.payload, 0xA));
      }
    }
  }
}

function webSocketFrame(payload: Buffer, opcode: number): Buffer {
  const mask = randomBytes(4);
  const header =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, 0x80 | payload.length])
      : payload.length <= 0xffff
        ? Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 126]), u16(payload.length)])
        : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), u64(payload.length)]);
  const out = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i]! ^ mask[i % 4]!;
  return Buffer.concat([header, mask, out]);
}

function readWebSocketFrame(buf: Buffer): { opcode: number; payload: Buffer; bytes: number } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0]! & 0x0f;
  const masked = Boolean(buf[1]! & 0x80);
  let len = buf[1]! & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < off + 2) return null;
    len = buf.readUInt16BE(off);
    off += 2;
  } else if (len === 127) {
    if (buf.length < off + 8) return null;
    len = Number(buf.readBigUInt64BE(off));
    off += 8;
  }
  const mask = masked ? buf.subarray(off, off + 4) : undefined;
  if (masked) off += 4;
  if (buf.length < off + len) return null;
  let payload = buf.subarray(off, off + len);
  if (mask) {
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = payload[i]! ^ mask[i % 4]!;
    payload = out;
  }
  return { opcode, payload, bytes: off + len };
}

function u16(n: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(n);
  return buf;
}

function u64(n: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(n));
  return buf;
}

transport = new UnixSocketWebSocket(sock, handleLine);

try {
  await transport.connect();
  await rpc('initialize', {
    clientInfo: { name: 'cosyncing-live-probe', title: 'cosyncing Live Probe', version: '0.0.0' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  write({ method: 'initialized', params: {} });
  const resp: any = await rpc('thread/loaded/list', { limit: 100 });
  const ids = Array.isArray(resp?.data) ? resp.data.map(String) : [];
  console.log(`PASS  Codex app-server WebSocket reachable; loadedThreads=${ids.length}${ids.length ? ` ids=${ids.join(',')}` : ''}`);
} catch (e) {
  console.log(`FAIL  Codex app-server WebSocket probe failed: ${String(e)}`);
  process.exitCode = 1;
} finally {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
  transport?.close();
}
