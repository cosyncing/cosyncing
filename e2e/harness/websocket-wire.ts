/** A read-only session client that inspects actual WebSocket frame bits/bytes.
 * Offers no context takeover so each compressed message can be decoded alone.
 * All waits end on a frame, an error, or a bounded deadline. */
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { constants, inflateRawSync } from 'node:zlib';
import { BROKER_CONTRACT_REVISION, BROKER_CONTRACT_SURFACE_HASH, CLIENT_MINIMUM_BROKER_CONTRACT_REVISION } from '../../packages/typescript/protocol/src/index.ts';
import type { BrokerClient, Frame } from './client.ts';
import { scaled } from './wait.ts';

export interface WireFrame {
  value: Frame;
  compressed: boolean;
  wireBytes: number;
  decodedBytes: number;
}

export class WebSocketWire {
  readonly frames: WireFrame[] = [];
  extension = '';
  private readonly events = new EventEmitter();
  private error?: Error;
  private buffer = Buffer.alloc(0);
  private upgraded = false;
  private fragments: Buffer[] = [];
  private compressed = false;
  private wireBytes = 0;
  private readonly socket: net.Socket;

  private constructor(url: URL, path: string, deflate: boolean) {
    this.socket = net.createConnection(Number(url.port), url.hostname);
    this.socket.on('connect', () => this.socket.write(
      `GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n` +
      (deflate ? 'Sec-WebSocket-Extensions: permessage-deflate; server_no_context_takeover; client_no_context_takeover\r\n' : '') + '\r\n',
    ));
    this.socket.on('data', (chunk) => {
      // No setEncoding: this socket always delivers binary buffers.
      try { this.receive(chunk as Buffer); } catch (error) { this.fail(error as Error); }
    });
    this.socket.on('error', (error) => this.fail(error));
    this.socket.on('close', () => this.fail(new Error('wire socket closed')));
  }

  static async open(client: BrokerClient, tool: string, sessionId: string, deflate: boolean): Promise<WebSocketWire> {
    const params: Record<string, string> = {
      readOnly: '1', initialHistory: '50', artifactMode: 'reference', clientVersion: 'e2e',
      contractRevision: String(BROKER_CONTRACT_REVISION),
      minimumBrokerRevision: String(CLIENT_MINIMUM_BROKER_CONTRACT_REVISION),
      contractSurfaceHash: BROKER_CONTRACT_SURFACE_HASH,
    };
    if (client.auth.kind !== 'none') {
      const ticket = await client.post('/api/ws-auth-tickets', { tool, sessionId, params });
      if (ticket.status !== 201) throw new Error(`wire ticket: ${ticket.status}`);
      params.wsAuthTicket = ticket.body.wsAuthTicket;
    }
    return new WebSocketWire(new URL(client.url),
      `/api/sessions/${tool}/${encodeURIComponent(sessionId)}/stream?${new URLSearchParams(params)}`, deflate);
  }

  waitFor(predicate: (frame: WireFrame) => boolean): Promise<WireFrame> {
    return new Promise((resolve, reject) => {
      const finish = () => {
        const found = this.frames.find(predicate);
        if (!found && !this.error) return;
        clearTimeout(timer);
        this.events.off('change', finish);
        if (found) resolve(found); else reject(this.error);
      };
      const timer = setTimeout(() => {
        this.events.off('change', finish);
        reject(new Error('timed out waiting for a wire frame'));
      }, scaled(20_000));
      this.events.on('change', finish);
      finish();
    });
  }

  send(value: unknown): void {
    const payload = Buffer.from(JSON.stringify(value));
    const mask = randomBytes(4);
    const head = Buffer.alloc(payload.length < 126 ? 2 : 4);
    head[0] = 0x81;
    head[1] = 0x80 | (payload.length < 126 ? payload.length : 126);
    if (payload.length >= 126) head.writeUInt16BE(payload.length, 2);
    for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
    this.socket.write(Buffer.concat([head, mask, payload]));
  }

  close(): void { this.socket.destroy(); }

  private fail(error: Error): void { this.error = error; this.events.emit('change'); }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.upgraded) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = this.buffer.subarray(0, end).toString();
      if (!head.startsWith('HTTP/1.1 101')) throw new Error(`upgrade refused: ${head.split('\r\n')[0]}`);
      this.extension = head.split('\r\n').find((line) => /^sec-websocket-extensions:/i.test(line))?.slice('sec-websocket-extensions:'.length).trim() ?? '';
      this.buffer = this.buffer.subarray(end + 4);
      this.upgraded = true;
    }
    while (this.buffer.length >= 2) {
      const first = this.buffer[0]!;
      let size = this.buffer[1]! & 0x7f;
      let offset = 2;
      if (size === 126) {
        if (this.buffer.length < 4) return;
        size = this.buffer.readUInt16BE(2); offset = 4;
      } else if (size === 127) {
        if (this.buffer.length < 10) return;
        size = Number(this.buffer.readBigUInt64BE(2)); offset = 10;
      }
      if (size > 16 * 1024 * 1024) throw new Error('wire fixture frame too large');
      if (this.buffer.length < offset + size) return;
      const payload = this.buffer.subarray(offset, offset + size);
      this.buffer = this.buffer.subarray(offset + size);
      const opcode = first & 15;
      if (opcode !== 0 && opcode !== 1) continue;
      if (opcode === 1) { this.compressed = (first & 64) !== 0; this.fragments = []; this.wireBytes = 0; }
      this.fragments.push(payload);
      this.wireBytes += offset + size;
      if (!(first & 128)) continue;
      const encoded = Buffer.concat(this.fragments);
      const decoded = this.compressed
        ? inflateRawSync(Buffer.concat([encoded, Buffer.from([0, 0, 255, 255])]), { finishFlush: constants.Z_SYNC_FLUSH })
        : encoded;
      this.frames.push({ value: JSON.parse(decoded.toString()), compressed: this.compressed, wireBytes: this.wireBytes, decodedBytes: decoded.length });
      this.events.emit('change');
    }
  }
}
