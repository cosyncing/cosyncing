/**
 * Fake push providers a broker under test is pointed at, observable from outside.
 *
 * - {@link startWakeWebhook}: the APNs/FCM relay (`COSYNCING_WAKE_PUSH_WEBHOOK`). It records every
 *   wake body exactly as received and can be told to hang.
 * - {@link startWebPushService}: a Web Push service on `https://127.0.0.1:<port>`, with a
 *   certificate from a throwaway authority the broker trusts (`NODE_EXTRA_CA_CERTS`). It records
 *   every request and answers with whatever status the test scripts per subscription.
 * - {@link WebPushSubscriber}: a browser's side of a subscription. Its keys go into the
 *   registration, and it decrypts what the service received for it (RFC 8291, written from the
 *   RFC's receiver steps, not with the broker's code), so a test reads the notification a browser
 *   would show.
 */
import { createDecipheriv, createECDH, createHmac, randomBytes, type ECDH } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { testCertificates } from './tls-ca.ts';

// ── APNs/FCM relay ──────────────────────────────────────────────────────────

export interface WakeWebhook {
  url: string;
  /** Every body received, parsed, in arrival order. */
  readonly wakes: Array<Record<string, unknown>>;
  /** While on, requests are held unanswered (a provider that hangs). */
  hang(on: boolean): void;
  stop(): void;
}

export function startWakeWebhook(): WakeWebhook {
  const wakes: Array<Record<string, unknown>> = [];
  let hanging = false;
  const held: Array<() => void> = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = await request.json().catch(() => ({ unparseable: true })) as Record<string, unknown>;
      if (hanging) {
        await new Promise<void>((resolve) => held.push(resolve));
        return Response.json({ ok: false }, { status: 504 });
      }
      wakes.push(body);
      return Response.json({ ok: true });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/wake`,
    wakes,
    hang(on) {
      hanging = on;
      if (!on) for (const release of held.splice(0)) release();
    },
    stop() {
      for (const release of held.splice(0)) release();
      server.stop(true);
    },
  };
}

// ── Web Push service ────────────────────────────────────────────────────────

export interface PushRequest {
  path: string;
  headers: Headers;
  body: Uint8Array;
}

/** How the service answers one request: a status, or a response built (or held) by the test. */
export type PushAnswer = number | ((request: PushRequest) => Response | Promise<Response>);

export interface WebPushService {
  /** `https://127.0.0.1:<port>`. */
  origin: string;
  /** PEM file of the authority to trust (`NODE_EXTRA_CA_CERTS`). */
  caFile: string;
  readonly requests: PushRequest[];
  /** Answer requests for `path` with `answers` in turn, then with the last one forever. */
  answer(path: string, ...answers: PushAnswer[]): void;
  stop(): void;
}

export function startWebPushService(directory: string): WebPushService {
  const certificates = testCertificates();
  const caFile = join(directory, 'web-push-test-authority.pem');
  writeFileSync(caFile, certificates.caPem);
  const requests: PushRequest[] = [];
  const scripts = new Map<string, PushAnswer[]>();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { cert: certificates.certPem, key: certificates.keyPem },
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const received: PushRequest = {
        path,
        headers: request.headers,
        body: new Uint8Array(await request.arrayBuffer()),
      };
      requests.push(received);
      const script = scripts.get(path);
      const answer = script && script.length > 1 ? script.shift()! : script?.[0] ?? 201;
      return typeof answer === 'number' ? new Response(null, { status: answer }) : answer(received);
    },
  });
  return {
    origin: `https://127.0.0.1:${server.port}`,
    caFile,
    requests,
    answer(path, ...answers) {
      scripts.set(path, answers);
    },
    stop() {
      server.stop(true);
    },
  };
}

// ── A browser's subscription ────────────────────────────────────────────────

const hmac = (key: Uint8Array, ...parts: Array<Uint8Array | string>): Buffer =>
  createHmac('sha256', key).update(Buffer.concat(parts.map((part) => Buffer.from(part)))).digest();

export class WebPushSubscriber {
  readonly service: WebPushService;
  readonly path: string;
  readonly endpoint: string;
  readonly keys: { p256dh: string; auth: string };
  readonly #ecdh: ECDH;

  constructor(service: WebPushService, name: string) {
    this.service = service;
    // The path is the subscription's capability: it must never surface anywhere else.
    this.path = `/push/${name}-capability-${randomBytes(6).toString('hex')}`;
    this.endpoint = `${service.origin}${this.path}`;
    this.#ecdh = createECDH('prime256v1');
    this.#ecdh.generateKeys();
    this.keys = {
      p256dh: this.#ecdh.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    };
  }

  /** The registration body a browser posts to `/api/push/wake-tokens`. */
  registration(deviceId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { deviceId, platform: 'webpush', subscription: { endpoint: this.endpoint, keys: this.keys }, ...extra };
  }

  /** Requests the service received for this subscription, in order. */
  requests(): PushRequest[] {
    return this.service.requests.filter((request) => request.path === this.path);
  }

  /** The notifications this browser was sent, decrypted, in order. */
  notifications(): any[] {
    return this.requests().map((request) => JSON.parse(this.decrypt(request.body).toString('utf8')));
  }

  /** RFC 8291 §3.4 and §2, receiver side: one aes128gcm record. */
  decrypt(message: Uint8Array): Buffer {
    const bytes = Buffer.from(message);
    const salt = bytes.subarray(0, 16);
    const recordSize = bytes.readUInt32BE(16);
    const idLength = bytes[20]!;
    if (recordSize !== 4096 || idLength !== 65) throw new Error(`unexpected aes128gcm header rs=${recordSize} idlen=${idLength}`);
    const senderPublic = bytes.subarray(21, 21 + idLength);
    const record = bytes.subarray(21 + idLength);
    const authSecret = Buffer.from(this.keys.auth, 'base64url');
    const prkKey = hmac(authSecret, this.#ecdh.computeSecret(senderPublic));
    const ikm = hmac(prkKey, 'WebPush: info\0', this.#ecdh.getPublicKey(), senderPublic, Buffer.from([1]));
    const prk = hmac(salt, ikm);
    const key = hmac(prk, 'Content-Encoding: aes128gcm\0', Buffer.from([1])).subarray(0, 16);
    const nonce = hmac(prk, 'Content-Encoding: nonce\0', Buffer.from([1])).subarray(0, 12);
    const decipher = createDecipheriv('aes-128-gcm', key, nonce);
    decipher.setAuthTag(record.subarray(record.length - 16));
    const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
    let end = padded.length - 1;
    while (end >= 0 && padded[end] === 0) end -= 1;
    if (padded[end] !== 0x02) throw new Error('missing the last-record padding delimiter');
    return padded.subarray(0, end);
  }
}
