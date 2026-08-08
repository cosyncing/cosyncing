/**
 * @cosyncing/transport — opaque envelope transport layer.
 *
 * Wave 2.1 scaffold: transports move bytes and metadata only. Crypto and broker/session semantics live
 * above this package, so relay/direct implementations must not parse payload contents.
 */

export interface TransportEnvelope {
  id: string;
  from?: string;
  to?: string;
  channel: string;
  bytes: Uint8Array;
  headers?: Record<string, string>;
}

export interface Transport {
  readonly kind: string;
  send(envelope: TransportEnvelope): Promise<void>;
  receive(signal?: AbortSignal): AsyncIterable<TransportEnvelope>;
  close?(): Promise<void> | void;
}

export function textEnvelope(input: {
  id: string;
  from?: string;
  to?: string;
  channel: string;
  text: string;
  headers?: Record<string, string>;
}): TransportEnvelope {
  return {
    id: input.id,
    from: input.from,
    to: input.to,
    channel: input.channel,
    bytes: new TextEncoder().encode(input.text),
    headers: input.headers,
  };
}

class AsyncQueue<T> {
  private values: T[] = [];
  private waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) throw new Error('transport endpoint is closed');
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as T, done: true });
  }

  async *iterate(signal?: AbortSignal): AsyncIterable<T> {
    while (!this.closed) {
      if (signal?.aborted) return;
      const next = this.values.shift();
      if (next) {
        yield next;
        continue;
      }
      const value = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (value.done) return;
      yield value.value;
    }
  }
}

export class MemoryRelay {
  private queues = new Map<string, AsyncQueue<TransportEnvelope>>();

  endpoint(peerId: string): RelayTransport {
    this.queue(peerId);
    return new RelayTransport(this, peerId);
  }

  deliver(envelope: TransportEnvelope): void {
    if (!envelope.to) throw new Error('relay envelope requires a destination peer');
    this.queue(envelope.to).push(cloneEnvelope(envelope));
  }

  receive(peerId: string, signal?: AbortSignal): AsyncIterable<TransportEnvelope> {
    return this.queue(peerId).iterate(signal);
  }

  close(peerId: string): void {
    this.queues.get(peerId)?.close();
  }

  private queue(peerId: string): AsyncQueue<TransportEnvelope> {
    let q = this.queues.get(peerId);
    if (!q) {
      q = new AsyncQueue<TransportEnvelope>();
      this.queues.set(peerId, q);
    }
    return q;
  }
}

export class RelayTransport implements Transport {
  readonly kind = 'relay';

  constructor(
    private readonly relay: MemoryRelay,
    readonly peerId: string,
  ) {}

  async send(envelope: TransportEnvelope): Promise<void> {
    this.relay.deliver({ ...envelope, from: envelope.from ?? this.peerId });
  }

  receive(signal?: AbortSignal): AsyncIterable<TransportEnvelope> {
    return this.relay.receive(this.peerId, signal);
  }

  close(): void {
    this.relay.close(this.peerId);
  }
}

export interface TailscaleDirectTransportOptions {
  baseUrl: string;
  peerId?: string;
  peerToken?: string;
  pollMs?: number;
  headers?: Record<string, string>;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export class TailscaleDirectTransport implements Transport {
  readonly kind = 'tailscale-direct';
  private readonly baseUrl: string;
  private readonly peerId?: string;
  private readonly peerToken?: string;
  private readonly pollMs: number;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

  constructor(options: TailscaleDirectTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.peerId = options.peerId;
    this.peerToken = options.peerToken;
    this.pollMs = options.pollMs ?? 1000;
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetch ?? fetch;
  }

  async send(envelope: TransportEnvelope): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/transport/envelopes`, {
      method: 'POST',
      headers: { ...this.headers, ...envelopeHeaders(envelope) },
      body: exactArrayBuffer(envelope.bytes),
    });
    if (!res.ok) throw new Error(`tailscale-direct send failed: HTTP ${res.status}`);
  }

  async *receive(signal?: AbortSignal): AsyncIterable<TransportEnvelope> {
    if (!this.peerId) throw new Error('tailscale-direct receive requires peerId');
    if (!this.peerToken) throw new Error('tailscale-direct receive requires peerToken');
    while (!signal?.aborted) {
      const url = `${this.baseUrl}/api/transport/envelopes?peer=${encodeURIComponent(this.peerId)}`;
      const res = await this.fetchImpl(url, { headers: { ...this.headers, accept: 'application/json', 'x-cosyncing-peer-token': this.peerToken }, signal });
      if (!res.ok) throw new Error(`tailscale-direct receive failed: HTTP ${res.status}`);
      const body: any = await res.json();
      for (const item of Array.isArray(body?.envelopes) ? body.envelopes : []) yield envelopeFromJson(item);
      if (signal?.aborted) return;
      await delay(this.pollMs, signal);
    }
  }
}

function envelopeHeaders(envelope: TransportEnvelope): Record<string, string> {
  return {
    ...envelope.headers,
    'content-type': 'application/octet-stream',
    'x-cosyncing-envelope-id': envelope.id,
    'x-cosyncing-channel': envelope.channel,
    ...(envelope.from ? { 'x-cosyncing-from': envelope.from } : {}),
    ...(envelope.to ? { 'x-cosyncing-to': envelope.to } : {}),
  };
}

function cloneEnvelope(envelope: TransportEnvelope): TransportEnvelope {
  return { ...envelope, bytes: copyBytes(envelope.bytes), headers: envelope.headers ? { ...envelope.headers } : undefined };
}

function envelopeFromJson(item: any): TransportEnvelope {
  if (!item?.id || !item?.channel || typeof item?.bytes !== 'string') throw new Error('malformed transport envelope');
  return {
    id: String(item.id),
    channel: String(item.channel),
    ...(item.from ? { from: String(item.from) } : {}),
    ...(item.to ? { to: String(item.to) } : {}),
    ...(item.headers && typeof item.headers === 'object' ? { headers: Object.fromEntries(Object.entries(item.headers).map(([k, v]) => [k, String(v)])) } : {}),
    bytes: new Uint8Array(Buffer.from(item.bytes, 'base64url')),
  };
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = copyBytes(bytes);
  const out = new ArrayBuffer(copy.byteLength);
  new Uint8Array(out).set(copy);
  return out;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
