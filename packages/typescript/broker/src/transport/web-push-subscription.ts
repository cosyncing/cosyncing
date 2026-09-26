import { ECDH } from 'node:crypto';
import {
  ATTENTION_NOTIFICATION_TYPES,
  type AttentionNotificationType,
} from '../attention/attention-notification-type.ts';

/** A browser Push API subscription after validation. Keys are canonical unpadded base64url. */
export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** The types a Web Push registration presents, keyed by type id, in {@link ATTENTION_NOTIFICATION_TYPES} order. */
export type WebPushPresentation = Partial<Record<AttentionNotificationType, { title: string; typeOnly?: true; silent?: true }>>;

/** A web push registration field the broker will not store. The registry reports it as `BAD_PARAM`. */
export class WebPushSubscriptionError extends Error {}

const ENDPOINT_MAX_LENGTH = 4096;
export const WEB_PUSH_CONTEXT_MAX_LENGTH = 512;
const TITLE_MAX_CHARACTERS = 80;
// A grapheme cluster has no length bound of its own, so a title is also capped in UTF-16 units.
const TITLE_MAX_UNITS = 240;

// The push services browsers subscribe through. The broker only ever POSTs to one of these (or to an
// operator-listed extra host), so a registered endpoint can never aim a broker request elsewhere.
const EXACT_HOSTS = new Set(['fcm.googleapis.com', 'web.push.apple.com']);
const SUBDOMAIN_SUFFIXES = ['.push.services.mozilla.com', '.notify.windows.com'];
const HOST_PATTERN = /^(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Operator-added push hosts from `COSYNCING_WEB_PUSH_EXTRA_HOSTS`: a comma list of exact hosts or
 * `*.suffix` patterns, where `*.example.com` matches a subdomain of `example.com` but not the name
 * itself. A malformed entry is ignored rather than widened.
 */
export function webPushExtraHostPatterns(raw = process.env.COSYNCING_WEB_PUSH_EXTRA_HOSTS): string[] {
  if (!raw) return [];
  return raw.split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => HOST_PATTERN.test(entry) && (!entry.startsWith('*.') || entry.slice(2).includes('.')));
}

export function isAllowedWebPushHost(hostname: string, extraPatterns = webPushExtraHostPatterns()): boolean {
  const host = hostname.toLowerCase();
  if (EXACT_HOSTS.has(host)) return true;
  if (SUBDOMAIN_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length)) return true;
  return extraPatterns.some((pattern) => pattern.startsWith('*.')
    ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1
    : host === pattern);
}

/**
 * The endpoint as the broker will POST to it. `https:` on an allowed host only, and no userinfo.
 * Ports are not restricted: the host is the trust boundary, TLS authenticates it, and a port on an
 * allowed host reaches only that operator's servers.
 */
export function parseWebPushEndpoint(raw: unknown, extraPatterns = webPushExtraHostPatterns()): URL {
  if (typeof raw !== 'string' || !raw.trim()) throw new WebPushSubscriptionError('subscription.endpoint is required');
  if (raw.length > ENDPOINT_MAX_LENGTH) throw new WebPushSubscriptionError('subscription.endpoint is too long');
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new WebPushSubscriptionError('subscription.endpoint must be a URL');
  }
  if (url.protocol !== 'https:') throw new WebPushSubscriptionError('subscription.endpoint must use https');
  if (url.username || url.password) throw new WebPushSubscriptionError('subscription.endpoint must not carry credentials');
  if (!isAllowedWebPushHost(url.hostname, extraPatterns)) {
    throw new WebPushSubscriptionError('subscription.endpoint is not a known push service');
  }
  return url;
}

/** The endpoint's origin, the only part of it that is safe to show: the path is the capability. */
export function webPushEndpointOrigin(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return '';
  }
}

export function normalizeWebPushSubscription(raw: unknown, extraPatterns = webPushExtraHostPatterns()): WebPushSubscription {
  if (!isRecord(raw)) throw new WebPushSubscriptionError('subscription is required for webpush');
  const endpoint = parseWebPushEndpoint(raw.endpoint, extraPatterns).href;
  const keys = isRecord(raw.keys) ? raw.keys : undefined;
  const p256dh = decodeBase64Url(keys?.p256dh);
  if (!p256dh || p256dh.length !== 65 || p256dh[0] !== 0x04 || !isP256Point(p256dh)) {
    throw new WebPushSubscriptionError('subscription.keys.p256dh must be an uncompressed P-256 public key');
  }
  const auth = decodeBase64Url(keys?.auth);
  if (!auth || auth.length !== 16) throw new WebPushSubscriptionError('subscription.keys.auth must be 16 bytes');
  return { endpoint, keys: { p256dh: p256dh.toString('base64url'), auth: auth.toString('base64url') } };
}

/**
 * The enabled types with their titles. Unknown ids are dropped, not refused, so a newer client can
 * register against this broker; a known id with an unusable entry is refused.
 */
export function normalizeWebPushPresentation(raw: unknown): WebPushPresentation {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new WebPushSubscriptionError('presentation must be an object');
  const presentation: WebPushPresentation = {};
  for (const type of ATTENTION_NOTIFICATION_TYPES) {
    if (!Object.hasOwn(raw, type)) continue;
    const entry = raw[type];
    if (!isRecord(entry) || typeof entry.title !== 'string') {
      throw new WebPushSubscriptionError(`presentation.${type} needs a title`);
    }
    for (const flag of ['typeOnly', 'silent'] as const) {
      if (entry[flag] !== undefined && typeof entry[flag] !== 'boolean') {
        throw new WebPushSubscriptionError(`presentation.${type}.${flag} must be a boolean`);
      }
    }
    const title = boundedTitle(entry.title);
    if (!title) throw new WebPushSubscriptionError(`presentation.${type} needs a title`);
    presentation[type] = {
      title,
      ...(entry.typeOnly === true ? { typeOnly: true } : {}),
      ...(entry.silent === true ? { silent: true } : {}),
    };
  }
  return presentation;
}

/** Client-local routing data the broker only echoes. Trimmed; absent when empty. */
export function normalizeWebPushContext(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new WebPushSubscriptionError('context must be a string');
  const context = raw.trim();
  if (context.length > WEB_PUSH_CONTEXT_MAX_LENGTH) {
    throw new WebPushSubscriptionError(`context must be at most ${WEB_PUSH_CONTEXT_MAX_LENGTH} characters`);
  }
  return context || undefined;
}

/** Strict base64url (padding tolerated); undefined for anything else. */
export function decodeBase64Url(value: unknown): Buffer | undefined {
  if (typeof value !== 'string') return undefined;
  const unpadded = value.replace(/={1,2}$/, '');
  if (!unpadded || !/^[A-Za-z0-9_-]+$/.test(unpadded)) return undefined;
  return Buffer.from(unpadded, 'base64url');
}

function isP256Point(bytes: Buffer): boolean {
  try {
    ECDH.convertKey(bytes, 'prime256v1', undefined, undefined, 'uncompressed');
    return true;
  } catch {
    return false;
  }
}

function boundedTitle(raw: string): string {
  let title = '';
  let count = 0;
  for (const { segment } of graphemes.segment(raw.replace(/\s+/g, ' ').trim())) {
    if (count === TITLE_MAX_CHARACTERS || title.length + segment.length > TITLE_MAX_UNITS) break;
    title += segment;
    count += 1;
  }
  return title.trimEnd();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
