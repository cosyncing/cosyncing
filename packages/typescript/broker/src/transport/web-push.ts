import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';
import { readFileSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AttentionEvent, WebPushNotificationPayload } from '@cosyncing/protocol';
import {
  attentionNotificationCollapseKey,
  attentionNotificationType,
  isSessionOutcomeNotificationType,
  type AttentionNotificationType,
} from '../attention/attention-notification-type.ts';
import { presentationStageStartedAt, RESOLVED_ONE_SHOT_KINDS } from '../attention/attention-reminder-scheduler.ts';
import type { AttentionClientState, AttentionDelivery, AttentionStore } from '../attention/attention-store.ts';
import { setupStateHome } from '../installation/setup-state.ts';
import {
  atomicWriteOwnerOnly,
  enforceOwnerOnlyFile,
  inspectOwnerOnlyFile,
} from '../security/secure-files.ts';
import { WakePushError, type WakeRegistration } from './push-wake.ts';
import {
  decodeBase64Url,
  parseWebPushEndpoint,
  webPushEndpointOrigin,
  type WebPushPresentation,
  type WebPushSubscription,
} from './web-push-subscription.ts';

// ── RFC 8291 message encryption ─────────────────────────────────────────────

/** The one record's size. The whole message is `WEB_PUSH_HEADER_BYTES` plus at most this. */
export const WEB_PUSH_RECORD_SIZE = 4096;
const HEADER_BYTES = 16 + 4 + 1 + 65;
const TAG_BYTES = 16;

export interface WebPushEncryptionInput {
  plaintext: Uint8Array;
  /** The subscription's `p256dh`: an uncompressed P-256 point. */
  uaPublicKey: Uint8Array;
  /** The subscription's 16-byte `auth` secret. */
  authSecret: Uint8Array;
  /** Test vectors only. Every real message draws a fresh ephemeral key and salt. */
  senderPrivateKey?: Uint8Array;
  salt?: Uint8Array;
}

/**
 * RFC 8291 `aes128gcm` in one record: an ephemeral ECDH P-256 agreement with the browser's key,
 * combined with its auth secret (§3.3–3.4), then RFC 8188 content coding with the last-record
 * padding delimiter 0x02. The header carries the salt, a 4096 record size, and the sender's public
 * key as the key id.
 */
export function encryptWebPushPayload(input: WebPushEncryptionInput): Buffer {
  const uaPublic = Buffer.from(input.uaPublicKey);
  const authSecret = Buffer.from(input.authSecret);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('web push p256dh must be an uncompressed P-256 point');
  if (authSecret.length !== 16) throw new Error('web push auth secret must be 16 bytes');
  const salt = Buffer.from(input.salt ?? randomBytes(16));
  if (salt.length !== 16) throw new Error('web push salt must be 16 bytes');
  if (input.plaintext.length + 1 + TAG_BYTES > WEB_PUSH_RECORD_SIZE) throw new Error('web push payload exceeds one record');

  const sender = createECDH('prime256v1');
  if (input.senderPrivateKey) sender.setPrivateKey(Buffer.from(input.senderPrivateKey));
  else sender.generateKeys();
  const asPublic = sender.getPublicKey();
  const ecdhSecret = sender.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12));

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from(input.plaintext), Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(HEADER_BYTES);
  salt.copy(header, 0);
  header.writeUInt32BE(WEB_PUSH_RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  asPublic.copy(header, 21);
  return Buffer.concat([header, ciphertext]);
}

// ── RFC 8292 VAPID key and authorization ────────────────────────────────────

export const WEB_PUSH_VAPID_SUBJECT = 'https://cosyncing.com';
const VAPID_TOKEN_LIFETIME_S = 12 * 60 * 60;

interface VapidKeyFile {
  version: 1;
  /** base64url uncompressed P-256 point. */
  publicKey: string;
  /** base64url 32-byte private scalar. */
  privateKey: string;
  createdAt: string;
}

interface VapidKeyMaterial {
  publicKey: string;
  signingKey: KeyObject;
}

export interface WebPushVapidKeyStoreOptions {
  now?: () => number;
  warn?: (message: string) => void;
  /** Deterministic persistence fault injection. Defaults to an owner-only atomic write. */
  persist?: (path: string, contents: string) => void;
}

/**
 * The broker's one VAPID key pair: generated on first use, kept at `<state home>/web-push-vapid.json`
 * with mode 0600, and never sent anywhere but as its public half. Every browser subscription is bound
 * to this key, so a replacement strands all of them until each re-subscribes. A file that cannot be
 * used is therefore moved aside and reported, never overwritten, and a key that cannot be persisted
 * is never used.
 */
export class WebPushVapidKeyStore {
  readonly path: string;
  private material?: VapidKeyMaterial;
  private unavailable?: string;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private readonly persist: (path: string, contents: string) => void;

  constructor(home = setupStateHome(), options: WebPushVapidKeyStoreOptions = {}) {
    this.path = join(home, 'web-push-vapid.json');
    this.now = options.now ?? Date.now;
    this.warn = options.warn ?? ((message) => console.warn(message));
    this.persist = options.persist ?? ((path, contents) => atomicWriteOwnerOnly(path, contents));
    try {
      this.load();
    } catch (error) {
      this.unavailable = error instanceof Error ? error.message : String(error);
      this.warn(`web push key could not be loaded: ${this.unavailable}`);
    }
  }

  /** The base64url uncompressed public key, the `applicationServerKey` a browser subscribes with. */
  publicKey(): string {
    return this.ensure().publicKey;
  }

  /** `Authorization` for one push request: an ES256 JWT for the endpoint's origin, plus the key. */
  authorization(endpoint: string, nowMs = this.now()): string {
    const material = this.ensure();
    const header = base64UrlJson({ typ: 'JWT', alg: 'ES256' });
    const claims = base64UrlJson({
      aud: new URL(endpoint).origin,
      exp: Math.floor(nowMs / 1000) + VAPID_TOKEN_LIFETIME_S,
      sub: WEB_PUSH_VAPID_SUBJECT,
    });
    const signingInput = `${header}.${claims}`;
    // JOSE ES256 is the raw 64-byte r || s, not the DER that node signs by default.
    const signature = sign('sha256', Buffer.from(signingInput), { key: material.signingKey, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${signingInput}.${signature.toString('base64url')}, k=${material.publicKey}`;
  }

  private ensure(): VapidKeyMaterial {
    if (this.material) return this.material;
    if (this.unavailable !== undefined) {
      throw new WakePushError('PUSH_NOT_CONFIGURED', 'web push key is unavailable', 503);
    }
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = privateKey.export({ format: 'jwk' });
    const file: VapidKeyFile = {
      version: 1,
      publicKey: Buffer.concat([
        Buffer.from([0x04]),
        Buffer.from(jwk.x!, 'base64url'),
        Buffer.from(jwk.y!, 'base64url'),
      ]).toString('base64url'),
      privateKey: jwk.d!,
      createdAt: new Date(this.now()).toISOString(),
    };
    try {
      this.persist(this.path, `${JSON.stringify(file, null, 2)}\n`);
    } catch (error) {
      // A key that is not on disk would strand every subscription made with it at the next restart.
      throw new WakePushError('PUSH_NOT_CONFIGURED', `web push key could not be saved: ${error instanceof Error ? error.message : String(error)}`, 503);
    }
    this.material = { publicKey: file.publicKey, signingKey: privateKey };
    return this.material;
  }

  private load(): void {
    const inspection = inspectOwnerOnlyFile(this.path);
    if (inspection.status === 'missing') return;
    if (inspection.status === 'unsafe' && (inspection.problem === 'unsafe-mode' || inspection.problem === 'unsafe-dacl')) {
      // Readable by others is a leak to report, not a reason to strand every subscription.
      enforceOwnerOnlyFile(this.path);
      this.warn('web push key file was readable by other users; its permissions were tightened');
    } else if (inspection.status !== 'ok') {
      this.quarantine(`it is not a private regular file (${inspection.problem ?? inspection.status})`);
      return;
    }
    let material: VapidKeyMaterial | undefined;
    try {
      material = parseVapidKeyFile(readFileSync(this.path, 'utf8'));
    } catch {
      material = undefined;
    }
    if (!material) {
      this.quarantine('it does not hold a valid key pair');
      return;
    }
    this.material = material;
  }

  private quarantine(reason: string): void {
    const aside = `${this.path}.corrupt-${this.now()}-${randomBytes(4).toString('hex')}`;
    // If the file cannot be moved aside it is not replaced either: the broker serves no key instead.
    renameSync(this.path, aside);
    this.warn(`web push key file was moved aside to ${basename(aside)} because ${reason}; a new key will be generated and existing browser subscriptions must subscribe again`);
  }
}

function parseVapidKeyFile(text: string): VapidKeyMaterial | undefined {
  const raw = JSON.parse(text) as Partial<VapidKeyFile>;
  if (raw?.version !== 1) return undefined;
  const publicKey = decodeBase64Url(raw.publicKey);
  const privateKey = decodeBase64Url(raw.privateKey);
  if (!publicKey || publicKey.length !== 65 || publicKey[0] !== 0x04 || !privateKey || privateKey.length !== 32) {
    return undefined;
  }
  // The pair must agree: a public key that is not this private key's would fail every push.
  const check = createECDH('prime256v1');
  check.setPrivateKey(privateKey);
  if (!check.getPublicKey().equals(publicKey)) return undefined;
  const signingKey = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: privateKey.toString('base64url'),
      x: publicKey.subarray(1, 33).toString('base64url'),
      y: publicKey.subarray(33).toString('base64url'),
    },
    format: 'jwk',
  });
  return { publicKey: publicKey.toString('base64url'), signingKey };
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

// ── Notification content and skip rules ─────────────────────────────────────

/** Longest body, in user-perceived characters. Mirrors the client's notification body. */
export const WEB_PUSH_BODY_MAX_CHARACTERS = 48;
/** Largest payload before encryption. */
export const WEB_PUSH_PAYLOAD_MAX_BYTES = 3072;

const REQUEST_TYPES: ReadonlySet<AttentionNotificationType> = new Set(['permission_request', 'question']);
const URGENT_TYPES: ReadonlySet<AttentionNotificationType> = new Set([
  'permission_request',
  'question',
  'security_alert',
  'server_problem',
]);
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export interface WebPushPayload extends WebPushNotificationPayload {
  type: AttentionNotificationType;
}

export interface WebPushNotification {
  payload: WebPushPayload;
  ttlSeconds: number;
  urgency: 'high' | 'normal';
}

export type WebPushSkipReason =
  | 'no-subscription'
  | 'event-missing'
  | 'event-resolved'
  | 'not-a-notification'
  | 'type-not-presented'
  | 'device-read'
  | 'seen-before-reminder'
  | 'before-registration'
  | 'payload-too-large';

/**
 * What one delivery shows, or why it shows nothing. A skipped delivery is complete: nothing is sent
 * and nothing is retried.
 */
export function planWebPushNotification(input: {
  event: AttentionEvent | undefined;
  stage: string;
  presentation: WebPushPresentation | undefined;
  /** The registration's routing data, echoed verbatim. */
  context?: string;
  deviceState?: Pick<AttentionClientState, 'readAt' | 'dismissedAt'>;
  /** When this browser registered (epoch ms). */
  registeredAt?: number;
}): { skip: WebPushSkipReason } | { notification: WebPushNotification } {
  const { event, stage } = input;
  if (!event) return { skip: 'event-missing' };
  // Outcomes are born resolved and still deliver once; any other resolved event is over.
  if (event.state !== 'active' && !RESOLVED_ONE_SHOT_KINDS.has(event.kind)) return { skip: 'event-resolved' };
  const type = attentionNotificationType(event);
  if (!type) return { skip: 'not-a-notification' };
  const presented = input.presentation?.[type];
  if (!presented) return { skip: 'type-not-presented' };
  if (input.deviceState?.readAt !== undefined || input.deviceState?.dismissedAt !== undefined) {
    return { skip: 'device-read' };
  }
  // Another client read it before a delayed alert (a runtime update's, or a stage an older broker
  // stored): the original alert may still race that read, a later one must not.
  if (stage !== 'immediate' && event.seenAt !== undefined) return { skip: 'seen-before-reminder' };
  // A browser registers from an open app, whose inbox already lists every earlier event: alerting
  // them now would replay the past as a burst of notifications. An alert raised after it is new.
  const raisedAt = presentationStageStartedAt(event, stage);
  if (input.registeredAt !== undefined && raisedAt !== undefined && raisedAt < input.registeredAt) {
    return { skip: 'before-registration' };
  }

  const action = event.action.kind === 'open-session' ? event.action : undefined;
  const payload: WebPushPayload = {
    v: 1,
    eventId: event.id,
    revision: event.presentationRevision,
    type,
    title: presented.title,
    body: presented.typeOnly ? '' : webPushBody(event),
    tag: attentionNotificationCollapseKey(event, type),
    stage,
    action: {
      kind: event.action.kind,
      ...(action?.tool ? { tool: action.tool } : {}),
      ...(action?.sessionId ? { sessionId: action.sessionId } : {}),
    },
    ...(presented.silent ? { silent: true as const } : {}),
    ...(input.context !== undefined ? { context: input.context } : {}),
  };
  // A title is bounded, but one grapheme cluster is not. Drop the body before giving up.
  if (payloadBytes(payload) > WEB_PUSH_PAYLOAD_MAX_BYTES) payload.body = '';
  if (payloadBytes(payload) > WEB_PUSH_PAYLOAD_MAX_BYTES) return { skip: 'payload-too-large' };
  return {
    notification: {
      payload,
      ttlSeconds: REQUEST_TYPES.has(type) ? 24 * 3600 : isSessionOutcomeNotificationType(type) ? 4 * 3600 : 12 * 3600,
      urgency: URGENT_TYPES.has(type) ? 'high' : 'normal',
    },
  };
}

/**
 * The client's notification body: the session title for a session event, else the event title.
 * An untitled session sends an empty body; the client words that itself.
 */
function webPushBody(event: AttentionEvent): string {
  const sessionId = (event.action.kind === 'open-session' ? event.action.sessionId : undefined) ?? event.sessionId;
  const title = sessionId?.trim() ? event.sessionTitle : event.title;
  return title?.trim() ? truncateWebPushText(title) : '';
}

/** [text] cut to [max] grapheme clusters with an ellipsis, exactly as the client cuts a body. */
export function truncateWebPushText(text: string, max = WEB_PUSH_BODY_MAX_CHARACTERS): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  const clusters = [...graphemes.segment(normalized)].map((part) => part.segment);
  if (clusters.length <= max) return normalized;
  return `${clusters.slice(0, max - 1).join('').trimEnd()}…`;
}

function payloadBytes(payload: WebPushPayload): number {
  return Buffer.byteLength(JSON.stringify(payload));
}

/**
 * The `Topic` for a collapse key: 32 base64url characters, so a newer message for one slot replaces
 * a queued one. Keyed with the subscription's auth secret, so the push service cannot confirm a
 * guessed session id from it.
 */
export function webPushTopic(collapseKey: string, authSecret: string): string {
  return createHmac('sha256', decodeBase64Url(authSecret) ?? Buffer.alloc(0))
    .update(collapseKey)
    .digest()
    .subarray(0, 24)
    .toString('base64url');
}

// ── Sending ─────────────────────────────────────────────────────────────────

export type WebPushSendResult =
  | { kind: 'sent'; status: number }
  /** 404/410: the browser dropped the subscription. */
  | { kind: 'gone'; status: number; detail?: string }
  /** Refused for good (413, other 4xx, a redirect): retrying the same request cannot help. */
  | { kind: 'rejected'; status: number; detail?: string };

const REFUSAL_DETAIL_BYTES = 1024;
const REFUSAL_DETAIL_CHARACTERS = 200;
// Push services explain a refusal in these headers (WNS) or in a short body (FCM, Mozilla, Apple).
const REFUSAL_DETAIL_HEADERS = ['x-wns-status', 'x-wns-error-description', 'x-wns-notificationstatus'];

/**
 * A push service's own words for a refusal, for the log: a few known headers and the start of the
 * body, bounded, on one line, with the endpoint's path removed since that path is the capability.
 */
async function refusalDetail(res: Response, endpoint: string): Promise<string | undefined> {
  const parts = REFUSAL_DETAIL_HEADERS.flatMap((name) => {
    const value = res.headers.get(name);
    return value ? [`${name}: ${value}`] : [];
  });
  const reader = res.body?.getReader();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (bytes < REFUSAL_DETAIL_BYTES) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        chunks.push(value);
        bytes += value.byteLength;
      }
    } catch {
      // The detail is best effort; the status alone still decides the outcome.
    } finally {
      void reader.cancel().catch(() => {});
    }
    const text = Buffer.concat(chunks).subarray(0, REFUSAL_DETAIL_BYTES).toString('utf8').trim();
    if (text) parts.push(text);
  }
  const { pathname, search } = new URL(endpoint);
  let detail = parts.join('; ').replace(/\s+/g, ' ');
  for (const secret of [pathname + search, pathname, search]) {
    if (secret.length > 1) detail = detail.split(secret).join('<endpoint>');
  }
  detail = detail.slice(0, REFUSAL_DETAIL_CHARACTERS).trim();
  return detail || undefined;
}

export interface WebPushSendOptions {
  vapid: Pick<WebPushVapidKeyStore, 'authorization'>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  /** Test vectors only. */
  encryption?: Pick<WebPushEncryptionInput, 'senderPrivateKey' | 'salt'>;
}

/**
 * Encrypt and POST one notification. A transient failure (429, 5xx, network, timeout) throws, so the
 * attention scheduler records it and backs off. Errors name no endpoint: its path is a capability.
 */
export async function sendWebPush(
  subscription: WebPushSubscription,
  notification: WebPushNotification,
  options: WebPushSendOptions,
): Promise<WebPushSendResult> {
  const endpoint = parseWebPushEndpoint(subscription.endpoint).href;
  const body = encryptWebPushPayload({
    plaintext: Buffer.from(JSON.stringify(notification.payload)),
    uaPublicKey: decodeBase64Url(subscription.keys.p256dh) ?? Buffer.alloc(0),
    authSecret: decodeBase64Url(subscription.keys.auth) ?? Buffer.alloc(0),
    ...options.encryption,
  });
  const configuredTimeout = options.timeoutMs ?? Number(process.env.COSYNCING_WAKE_PUSH_TIMEOUT_MS ?? 5000);
  const timeoutMs = Math.max(1, Number.isFinite(configuredTimeout) ? configuredTimeout : 5000);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res: Response;
  try {
    res = await (options.fetch ?? fetch)(endpoint, {
      method: 'POST',
      signal: ac.signal,
      // Only the allowlisted endpoint is ever contacted, never where it points.
      redirect: 'manual',
      headers: {
        authorization: options.vapid.authorization(endpoint, options.now?.()),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(notification.ttlSeconds),
        urgency: notification.urgency,
        topic: webPushTopic(notification.payload.tag, subscription.keys.auth),
      },
      body: new Uint8Array(body),
    });
  } catch (err) {
    const timedOut = ac.signal.aborted || (err instanceof Error && err.name === 'AbortError');
    const cause = err instanceof Error ? ((err as NodeJS.ErrnoException).code ?? err.name) : 'error';
    throw new WakePushError('PUSH_DELIVERY_FAILED', timedOut ? `web push timed out after ${timeoutMs}ms` : `web push failed (${cause})`, 502);
  } finally {
    clearTimeout(timer);
  }
  if (res.status >= 200 && res.status < 300) {
    void res.body?.cancel().catch(() => {});
    return { kind: 'sent', status: res.status };
  }
  if (res.status === 429 || res.status >= 500) {
    void res.body?.cancel().catch(() => {});
    throw new WakePushError('PUSH_DELIVERY_FAILED', `web push service returned HTTP ${res.status}`, 502);
  }
  const detail = await refusalDetail(res, endpoint);
  const kind = res.status === 404 || res.status === 410 ? 'gone' : 'rejected';
  return { kind, status: res.status, ...(detail ? { detail } : {}) };
}

// ── Attention delivery ──────────────────────────────────────────────────────

export type WebPushDeliveryOutcome =
  | { kind: 'skipped'; reason: WebPushSkipReason }
  | WebPushSendResult;

export interface WebPushDeliveryDependencies extends WebPushSendOptions {
  store: Pick<AttentionStore, 'getEvent' | 'getClientState'>;
  /** Remove a registration whose subscription is gone. */
  revoke: (registration: WakeRegistration) => unknown;
  warn?: (message: string) => void;
}

/**
 * Deliver one attention reservation to a `webpush` registration. Returning completes the delivery;
 * throwing leaves it for the scheduler's retry backoff.
 */
export async function deliverWebPush(
  delivery: Pick<AttentionDelivery, 'deviceId' | 'eventId' | 'stage'>,
  registration: WakeRegistration,
  deps: WebPushDeliveryDependencies,
): Promise<WebPushDeliveryOutcome> {
  if (!registration.subscription) return { kind: 'skipped', reason: 'no-subscription' };
  const plan = planWebPushNotification({
    event: deps.store.getEvent(delivery.eventId),
    stage: delivery.stage,
    presentation: registration.presentation,
    context: registration.context,
    deviceState: deps.store.getClientState(delivery.deviceId, delivery.eventId),
    registeredAt: Date.parse(registration.createdAt),
  });
  if ('skip' in plan) return { kind: 'skipped', reason: plan.skip };
  const result = await sendWebPush(registration.subscription, plan.notification, deps);
  if (result.kind === 'sent') return result;
  const service = webPushEndpointOrigin(registration.subscription.endpoint);
  const said = result.detail ? `: ${result.detail}` : '';
  if (result.kind === 'gone') {
    deps.revoke(registration);
    deps.warn?.(`web push subscription for ${registration.deviceId} is gone (${service} HTTP ${result.status}${said}); registration removed`);
  } else {
    deps.warn?.(`web push to ${registration.deviceId} was refused (${service} HTTP ${result.status}${said}); not retried`);
  }
  return result;
}
