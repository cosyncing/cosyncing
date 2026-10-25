/** Bounded reassembly for large Pi-family integration messages. Each HTTP request remains small. */
export const PI_BRIDGE_CHUNK_BYTES = 128 * 1024;
export const PI_BRIDGE_PAYLOAD_MAX_BYTES = 32 * 1024 * 1024;

export class PiBridgePayloadError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

interface Transfer {
  totalBytes: number;
  count: number;
  chunks: Buffer[];
  timer: ReturnType<typeof setTimeout>;
  startedAt: number;
  lastAt: number;
  epoch?: string;
}

export class PiBridgePayloads {
  private readonly transfers = new Map<string, Transfer>();
  private reservedBytes = 0;
  constructor(private readonly now: () => number = Date.now) {}

  cancelEpoch(epoch: string): void {
    for (const [key, transfer] of this.transfers) if (transfer.epoch === epoch) this.remove(key);
  }

  private arm(key: string, transfer: Transfer): void {
    clearTimeout(transfer.timer);
    transfer.lastAt = this.now();
    transfer.timer = setTimeout(() => this.remove(key), Math.min(60_000, 30 * 60_000 - (transfer.lastAt - transfer.startedAt)));
    transfer.timer.unref?.();
  }

  private remove(key: string): void {
    const transfer = this.transfers.get(key);
    if (!transfer) return;
    clearTimeout(transfer.timer);
    this.reservedBytes -= transfer.totalBytes;
    this.transfers.delete(key);
  }

  /** Pending fragments never mutate the session. Only the final, validated JSON reaches a route. */
  accept(route: string, body: any): { pending: true } | { pending: false; body: any } {
    if (!body?.bridgeChunk) return { pending: false, body };
    const c = body.bridgeChunk;
    const id = typeof c.transferId === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(c.transferId) ? c.transferId : '';
    const key = `${route}:${id}`;
    const reject = (status: number, message: string): never => {
      this.remove(key);
      throw new PiBridgePayloadError(status, message);
    };
    if ((c.epoch !== undefined && (typeof c.epoch !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(c.epoch))) || !id || !Number.isSafeInteger(c.totalBytes) || c.totalBytes <= 0 ||
        !Number.isSafeInteger(c.index) || !Number.isSafeInteger(c.count) || c.index < 0 ||
        c.count !== Math.ceil(c.totalBytes / PI_BRIDGE_CHUNK_BYTES) || c.index >= c.count) {
      return reject(400, 'invalid bridge transfer metadata');
    }
    if (c.totalBytes > PI_BRIDGE_PAYLOAD_MAX_BYTES) return reject(413, 'bridge payload exceeds 32 MiB');
    if (typeof c.data !== 'string' || c.data.length > Math.ceil(PI_BRIDGE_CHUNK_BYTES / 3) * 4 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(c.data)) return reject(400, 'invalid bridge transfer data');
    const bytes = Buffer.from(c.data, 'base64');
    const expectedBytes = Math.min(PI_BRIDGE_CHUNK_BYTES, c.totalBytes - c.index * PI_BRIDGE_CHUNK_BYTES);
    if (bytes.length !== expectedBytes || bytes.toString('base64') !== c.data) return reject(400, 'invalid bridge transfer length');
    let transfer = this.transfers.get(key);
    if (!transfer) {
      if (c.index !== 0) return reject(409, 'bridge transfer expired or out of order');
      if (this.transfers.size >= 8 || this.reservedBytes + c.totalBytes > 64 * 1024 * 1024) {
        return reject(429, 'too many bridge transfers');
      }
      const timer = setTimeout(() => this.remove(key), 60_000);
      timer.unref?.();
      transfer = { totalBytes: c.totalBytes, count: c.count, chunks: [], timer, startedAt: this.now(), lastAt: this.now(), epoch: c.epoch };
      this.transfers.set(key, transfer);
      this.reservedBytes += c.totalBytes;
    }
    if (this.now() - transfer.lastAt > 60_000 || this.now() - transfer.startedAt >= 30 * 60_000) return reject(409, 'bridge transfer expired');
    if (transfer.totalBytes !== c.totalBytes || transfer.count !== c.count || transfer.chunks.length !== c.index || transfer.epoch !== c.epoch) {
      return reject(409, 'bridge transfer changed or out of order');
    }
    transfer.chunks.push(bytes);
    if (transfer.chunks.length < transfer.count) { this.arm(key, transfer); return { pending: true }; }
    this.remove(key);
    try {
      const decoded = JSON.parse(Buffer.concat(transfer.chunks, transfer.totalBytes).toString('utf8'));
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) || decoded.bridgeChunk) {
        return reject(400, 'invalid assembled bridge payload');
      }
      if (decoded.epoch !== transfer.epoch) return reject(400, 'bridge generation changed');
      return { pending: false, body: decoded };
    } catch (error) {
      if (error instanceof PiBridgePayloadError) throw error;
      return reject(400, 'invalid assembled bridge JSON');
    }
  }
}
