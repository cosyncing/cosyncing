#!/usr/bin/env bun
/**
 * Web Push delivery: RFC 8291 encryption, RFC 8292 VAPID, the VAPID key store, endpoint and key
 * validation, registration, the notification each attention delivery shows (or why it shows none),
 * provider response handling, and the broker's own route and dispatch wiring.
 *
 * No real push service is contacted. Unit checks inject `fetch`; the fixture broker points its one
 * subscription at a loopback TCP sink that records the TLS ClientHello the broker opens with.
 */
import { strict as assert } from 'node:assert';
import {
  createDecipheriv,
  createECDH,
  createHmac,
  randomBytes,
  type ECDH,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AttentionEvent, AttentionEventUpsert, WakeRegistrationInput } from '@cosyncing/protocol';
import { ATTENTION_NOTIFICATION_TYPES } from '../../src/attention/attention-notification-type.ts';
import { AttentionReminderScheduler } from '../../src/attention/attention-reminder-scheduler.ts';
import { AttentionStore } from '../../src/attention/attention-store.ts';
import { authorizeBrokerRoute } from '../../src/security/route-authorization.ts';
import {
  dispatchWakePush,
  WakePushError,
  WakePushRegistry,
  type WakeRegistration,
} from '../../src/transport/push-wake.ts';
import {
  deliverWebPush,
  encryptWebPushPayload,
  planWebPushNotification,
  sendWebPush,
  truncateWebPushText,
  WEB_PUSH_PAYLOAD_MAX_BYTES,
  WEB_PUSH_VAPID_SUBJECT,
  WebPushVapidKeyStore,
  webPushTopic,
  type WebPushDeliveryDependencies,
} from '../../src/transport/web-push.ts';
import {
  isAllowedWebPushHost,
  normalizeWebPushSubscription,
  parseWebPushEndpoint,
  webPushExtraHostPatterns,
  WEB_PUSH_CONTEXT_MAX_LENGTH,
} from '../../src/transport/web-push-subscription.ts';
import {
  isolatedBrokerFixtureEnvironment,
  reserveLoopbackFixturePort,
  waitForBrokerHealth,
} from '../helpers/isolated-broker-fixture.ts';

let failures = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name} - ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

const b64 = (value: string): Buffer => Buffer.from(value.replace(/\s+/g, ''), 'base64url');
const POSIX = process.platform !== 'win32';
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const clusters = (text: string): string[] => [...graphemes.segment(text)].map((part) => part.segment);
const roots: string[] = [];
function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `cosyncing-web-push-${label}-`));
  roots.push(root);
  return root;
}

// RFC 8291 §5 and Appendix A, copied from the RFC text.
const RFC8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  header: `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
           mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8`,
  ciphertext: `8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs
               bI_0LpXMuGvnzQ`,
  message: `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
            mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
            pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`,
};

/** A browser's side of a subscription: its key pair and auth secret. */
function userAgent(): { ecdh: ECDH; keys: { p256dh: string; auth: string } } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { ecdh, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}

const hmac = (key: Uint8Array, ...parts: Array<Uint8Array | string>): Buffer =>
  createHmac('sha256', key).update(Buffer.concat(parts.map((part) => Buffer.from(part)))).digest();

/** RFC 8291 receiver, written from the RFC's HMAC steps rather than with the sender's HKDF calls. */
function decryptAsUserAgent(message: Uint8Array, ua: ECDH, authSecret: Buffer): Buffer {
  const bytes = Buffer.from(message);
  const salt = bytes.subarray(0, 16);
  assert.equal(bytes.readUInt32BE(16), 4096, 'record size');
  const idlen = bytes[20]!;
  assert.equal(idlen, 65, 'key id is the sender public key');
  const senderPublic = bytes.subarray(21, 21 + idlen);
  const record = bytes.subarray(21 + idlen);
  assert.ok(record.length <= 4096, 'one record');
  const prkKey = hmac(authSecret, ua.computeSecret(senderPublic));
  const ikm = hmac(prkKey, 'WebPush: info\0', ua.getPublicKey(), senderPublic, Buffer.from([1]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, 'Content-Encoding: aes128gcm\0', Buffer.from([1])).subarray(0, 16);
  const nonce = hmac(prk, 'Content-Encoding: nonce\0', Buffer.from([1])).subarray(0, 12);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  assert.equal(padded[end], 0x02, 'last-record padding delimiter');
  return padded.subarray(0, end);
}

const PRESENT_ALL = Object.fromEntries(ATTENTION_NOTIFICATION_TYPES.map((type) => [type, { title: `title:${type}` }]));

function attentionEvent(overrides: Partial<AttentionEvent> = {}): AttentionEvent {
  return {
    id: 'event-1',
    cursor: 1,
    revision: 1,
    presentationRevision: 1,
    presentationStage: 'immediate',
    kind: 'run-finished',
    state: 'resolved',
    severity: 'informational',
    dedupeKey: 'run-finished:claude:s1:t1',
    createdAt: 1,
    updatedAt: 1,
    agent: 'claude',
    sessionId: 's1',
    sessionTitle: 'Fix the login bug',
    title: 'Agent run finished',
    action: { kind: 'open-session', tool: 'claude', sessionId: 's1' },
    ...overrides,
  };
}

const plan = (input: Partial<Parameters<typeof planWebPushNotification>[0]> = {}) =>
  planWebPushNotification({ event: attentionEvent(), stage: 'immediate', presentation: PRESENT_ALL, ...input });

function notificationOf(result: ReturnType<typeof planWebPushNotification>) {
  assert.ok('notification' in result, `expected a notification, got ${JSON.stringify(result)}`);
  return result.notification;
}

function recordingFetch(respond: number | ((init: RequestInit) => Response | Promise<Response>)) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return typeof respond === 'number' ? new Response(null, { status: respond }) : respond(init ?? {});
  }) as typeof fetch;
  return { calls, fetch: impl };
}

const FCM = 'https://fcm.googleapis.com/fcm/send/capability-path-0123456789';

function webPushRegistration(home: string, overrides: Record<string, unknown> = {}) {
  const ua = userAgent();
  // Registered at the epoch, so every fixture event is newer than the registration.
  const registry = new WakePushRegistry(home, { now: () => 0 });
  const registered = registry.register({
    deviceId: 'web-client-1',
    platform: 'webpush',
    subscription: { endpoint: FCM, keys: ua.keys },
    presentation: PRESENT_ALL,
    ...overrides,
  }, { kind: 'owner' });
  return { ua, registry, registered, registration: registry.getForDispatch(registered.deviceId) };
}

// ── RFC 8291 ────────────────────────────────────────────────────────────────

await test('RFC 8291 Appendix A: the example keys and salt produce the RFC message byte for byte', () => {
  const message = encryptWebPushPayload({
    plaintext: Buffer.from(RFC8291.plaintext),
    uaPublicKey: b64(RFC8291.uaPublic),
    authSecret: b64(RFC8291.auth),
    senderPrivateKey: b64(RFC8291.asPrivate),
    salt: b64(RFC8291.salt),
  });
  // §5 prints `Content-Length: 145`, but the body it shows is 144 octets: the 86-octet header plus
  // 41 plaintext octets, the delimiter, and the 16-octet tag. The bytes are what is checked.
  assert.equal(message.length, 86 + 41 + 1 + 16);
  assert.deepEqual(message.subarray(0, 86), b64(RFC8291.header), 'the 86-octet header');
  assert.deepEqual(message.subarray(86), b64(RFC8291.ciphertext), 'the AES-GCM ciphertext');
  assert.deepEqual(message, b64(RFC8291.message), 'the Section 5 body');
  assert.deepEqual(message.subarray(21, 86), b64(RFC8291.asPublic), 'key id is as_public');
  const receiver = createECDH('prime256v1');
  receiver.setPrivateKey(b64(RFC8291.uaPrivate));
  assert.equal(decryptAsUserAgent(message, receiver, b64(RFC8291.auth)).toString(), RFC8291.plaintext);
});

await test('RFC 8291 round trip: a fresh browser key decrypts, and every message draws a new key and salt', () => {
  const ua = userAgent();
  const plaintext = Buffer.from(JSON.stringify({ v: 1, title: '権限の確認 🔐', body: 'x'.repeat(2000) }));
  const first = encryptWebPushPayload({ plaintext, uaPublicKey: b64(ua.keys.p256dh), authSecret: b64(ua.keys.auth) });
  const second = encryptWebPushPayload({ plaintext, uaPublicKey: b64(ua.keys.p256dh), authSecret: b64(ua.keys.auth) });
  assert.deepEqual(decryptAsUserAgent(first, ua.ecdh, b64(ua.keys.auth)), plaintext);
  assert.deepEqual(decryptAsUserAgent(second, ua.ecdh, b64(ua.keys.auth)), plaintext);
  assert.notDeepEqual(first.subarray(0, 16), second.subarray(0, 16), 'salt is fresh');
  assert.notDeepEqual(first.subarray(21, 86), second.subarray(21, 86), 'ephemeral key is fresh');
  assert.throws(() => decryptAsUserAgent(first, userAgent().ecdh, b64(ua.keys.auth)), 'another browser cannot read it');
  assert.throws(
    () => encryptWebPushPayload({ plaintext: Buffer.alloc(4096 - 16), uaPublicKey: b64(ua.keys.p256dh), authSecret: b64(ua.keys.auth) }),
    /one record/,
    'a payload that cannot fit one record is refused',
  );
});

// ── RFC 8292 and the key store ──────────────────────────────────────────────

await test('VAPID: an ES256 JWT for the endpoint origin, 12 h expiry, cosyncing subject, verifiable with k', async () => {
  const store = new WebPushVapidKeyStore(tempRoot('vapid-jwt'), { warn: () => {} });
  const now = Date.parse('2026-09-23T12:00:00.500Z');
  const header = store.authorization('https://updates.push.services.mozilla.com:8443/wpush/v2/secret', now);
  const match = /^vapid t=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/.exec(header);
  assert.ok(match, header);
  const [, jwtHeader, jwtClaims, jwtSignature, k] = match;
  assert.deepEqual(JSON.parse(b64(jwtHeader!).toString()), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(b64(jwtClaims!).toString()), {
    aud: 'https://updates.push.services.mozilla.com:8443',
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: WEB_PUSH_VAPID_SUBJECT,
  });
  assert.equal(WEB_PUSH_VAPID_SUBJECT, 'https://cosyncing.com');
  assert.equal(k, store.publicKey());
  const publicKey = b64(k!);
  assert.equal(publicKey.length, 65);
  assert.equal(publicKey[0], 0x04);
  const signature = b64(jwtSignature!);
  assert.equal(signature.length, 64, 'JOSE r || s, not DER');
  // WebCrypto verifies raw r || s natively, so this does not trust node's dsaEncoding option.
  const key = await crypto.subtle.importKey('raw', new Uint8Array(publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const verify = (signed: string) =>
    crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, new Uint8Array(signature), new TextEncoder().encode(signed));
  assert.equal(await verify(`${jwtHeader}.${jwtClaims}`), true);
  assert.equal(
    await verify(`${jwtHeader}.${jwtClaims}x`),
    false,
  );
});

await test('VAPID key store: generated on first use, 0600, reloaded unchanged, never rewritten by a load', () => {
  const home = tempRoot('vapid-store');
  const path = join(home, 'web-push-vapid.json');
  const first = new WebPushVapidKeyStore(home, { warn: () => {} });
  assert.equal(existsSync(path), false, 'loading creates nothing');
  const publicKey = first.publicKey();
  assert.equal(existsSync(path), true);
  if (POSIX) assert.equal(statSync(path).mode & 0o777, 0o600);
  const bytes = readFileSync(path, 'utf8');
  const file = JSON.parse(bytes);
  assert.equal(file.version, 1);
  assert.equal(file.publicKey, publicKey);
  assert.equal(b64(file.privateKey).length, 32);
  assert.equal(first.publicKey(), publicKey, 'stable within a process');
  const warnings: string[] = [];
  const second = new WebPushVapidKeyStore(home, { warn: (message) => warnings.push(message) });
  assert.equal(second.publicKey(), publicKey, 'stable across a restart');
  assert.equal(readFileSync(path, 'utf8'), bytes);
  assert.deepEqual(warnings, []);
  assert.equal(first.authorization(FCM).includes(file.privateKey), false, 'the private key never leaves');
});

await test('VAPID key store: a corrupt or mismatched file is moved aside and reported before a new key', () => {
  for (const [label, contents] of [
    ['garbage', 'not json at all'],
    ['mismatched pair', (() => {
      const home = tempRoot('vapid-source');
      const store = new WebPushVapidKeyStore(home, { warn: () => {} });
      store.publicKey();
      const file = JSON.parse(readFileSync(join(home, 'web-push-vapid.json'), 'utf8'));
      file.publicKey = userAgent().keys.p256dh;
      return JSON.stringify(file);
    })()],
  ] as const) {
    const home = tempRoot('vapid-corrupt');
    const path = join(home, 'web-push-vapid.json');
    writeFileSync(path, contents, { mode: 0o600 });
    const warnings: string[] = [];
    const store = new WebPushVapidKeyStore(home, { warn: (message) => warnings.push(message) });
    const aside = readdirSync(home).filter((name) => name.startsWith('web-push-vapid.json.corrupt-'));
    assert.equal(aside.length, 1, `${label}: quarantined`);
    assert.equal(readFileSync(join(home, aside[0]!), 'utf8'), contents, `${label}: evidence kept`);
    assert.equal(warnings.length, 1, `${label}: reported`);
    assert.match(warnings[0]!, /moved aside .* subscribe again/);
    const publicKey = store.publicKey();
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).publicKey, publicKey, `${label}: new key persisted`);
  }
});

await test('VAPID key store: a loose file is tightened, not replaced; an immovable corrupt file serves no key', () => {
  if (!POSIX) return;
  const home = tempRoot('vapid-loose');
  const path = join(home, 'web-push-vapid.json');
  const publicKey = new WebPushVapidKeyStore(home, { warn: () => {} }).publicKey();
  chmodSync(path, 0o644);
  const warnings: string[] = [];
  const reloaded = new WebPushVapidKeyStore(home, { warn: (message) => warnings.push(message) });
  assert.equal(reloaded.publicKey(), publicKey, 'the key survives');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.match(warnings.join('\n'), /readable by other users/);

  if (process.getuid?.() === 0) return;
  const locked = tempRoot('vapid-locked');
  const lockedPath = join(locked, 'web-push-vapid.json');
  writeFileSync(lockedPath, 'corrupt', { mode: 0o600 });
  chmodSync(locked, 0o500);
  let store: WebPushVapidKeyStore;
  const lockedWarnings: string[] = [];
  try {
    store = new WebPushVapidKeyStore(locked, { warn: (message) => lockedWarnings.push(message) });
  } finally {
    chmodSync(locked, 0o700);
  }
  // Writable again, so only the store's own refusal keeps the corrupt file from being replaced.
  assert.throws(() => store.publicKey(), (error) => error instanceof WakePushError && error.status === 503);
  assert.equal(readFileSync(lockedPath, 'utf8'), 'corrupt', 'never overwritten');
  assert.match(lockedWarnings.join('\n'), /could not be loaded/);

  const unwritable = tempRoot('vapid-unwritable');
  let attempts = 0;
  const fresh = new WebPushVapidKeyStore(unwritable, {
    warn: () => {},
    persist: () => { attempts += 1; throw new Error('disk full'); },
  });
  assert.throws(() => fresh.publicKey(), (error) => error instanceof WakePushError && error.status === 503);
  assert.throws(() => fresh.publicKey(), /could not be saved/, 'a key that was never saved is never served');
  assert.throws(() => fresh.authorization(FCM), /could not be saved/);
  assert.equal(attempts, 3);
  assert.deepEqual(readdirSync(unwritable), []);
});

// ── Endpoint allowlist and subscription keys ────────────────────────────────

await test('endpoint allowlist: only https on the four push services, no lookalikes, no userinfo', () => {
  for (const endpoint of [
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/abc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
    'https://FCM.googleapis.com/fcm/send/abc',
  ]) {
    assert.doesNotThrow(() => parseWebPushEndpoint(endpoint, []), endpoint);
  }
  for (const endpoint of [
    'http://fcm.googleapis.com/fcm/send/abc',
    'wss://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com.evil.test/fcm/send/abc',
    'https://evil-fcm.googleapis.com/abc',
    'https://xfcm.googleapis.com/abc',
    'https://push.services.mozilla.com/abc',
    'https://.push.services.mozilla.com/abc',
    'https://.notify.windows.com/abc',
    'https://fcm.googleapis.com./abc',
    'https://evilpush.services.mozilla.com/abc',
    'https://push.services.mozilla.com.evil.test/abc',
    'https://notify.windows.com/abc',
    'https://web.push.apple.com.evil.test/abc',
    'https://user:pw@fcm.googleapis.com/abc',
    'https://user@fcm.googleapis.com/abc',
    'https://fcm.googleapis.com@evil.test/abc',
    'https://127.0.0.1/abc',
    'not a url',
    '',
    `https://fcm.googleapis.com/${'a'.repeat(4096)}`,
  ]) {
    assert.throws(() => parseWebPushEndpoint(endpoint, []), JSON.stringify(endpoint.slice(0, 80)));
  }
});

await test('endpoint allowlist: COSYNCING_WEB_PUSH_EXTRA_HOSTS adds exact hosts and *.suffix subdomains only', () => {
  assert.deepEqual(webPushExtraHostPatterns(' 127.0.0.1 , *.push.example.test,*,*.test,bad/host,, Push.Example.org '), [
    '127.0.0.1',
    '*.push.example.test',
    'push.example.org',
  ]);
  const extra = webPushExtraHostPatterns('127.0.0.1,*.push.example.test,push.example.org');
  assert.equal(isAllowedWebPushHost('127.0.0.1', extra), true);
  assert.equal(isAllowedWebPushHost('a.push.example.test', extra), true);
  assert.equal(isAllowedWebPushHost('push.example.test', extra), false, 'a wildcard is subdomains only');
  assert.equal(isAllowedWebPushHost('.push.example.test', extra), false);
  assert.equal(isAllowedWebPushHost('a.push.example.test.evil', extra), false);
  assert.equal(isAllowedWebPushHost('xpush.example.test', extra), false);
  assert.equal(isAllowedWebPushHost('push.example.org', extra), true);
  assert.equal(isAllowedWebPushHost('a.push.example.org', extra), false, 'an exact host is exact');
  assert.equal(isAllowedWebPushHost('127.0.0.1', []), false);
  assert.throws(() => parseWebPushEndpoint('http://127.0.0.1/abc', extra), /https/, 'extras are still https only');
  assert.equal(webPushExtraHostPatterns(undefined).length, 0);
});

await test('subscription keys: p256dh is a 65-byte uncompressed P-256 point and auth 16 bytes, canonicalized', () => {
  const ua = userAgent();
  const valid = normalizeWebPushSubscription({ endpoint: FCM, keys: { p256dh: `${ua.keys.p256dh}=`, auth: `${ua.keys.auth}==` } }, []);
  assert.deepEqual(valid, { endpoint: FCM, keys: ua.keys }, 'padding is dropped');
  const compressed = createECDH('prime256v1');
  compressed.generateKeys();
  const offCurve = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 1)]).toString('base64url');
  for (const [label, keys] of [
    ['missing keys', undefined],
    ['short p256dh', { p256dh: b64(ua.keys.p256dh).subarray(0, 64).toString('base64url'), auth: ua.keys.auth }],
    ['compressed p256dh', { p256dh: compressed.getPublicKey(undefined, 'compressed').toString('base64url'), auth: ua.keys.auth }],
    ['not 0x04', { p256dh: Buffer.concat([Buffer.from([0x05]), b64(ua.keys.p256dh).subarray(1)]).toString('base64url'), auth: ua.keys.auth }],
    ['off-curve p256dh', { p256dh: offCurve, auth: ua.keys.auth }],
    // The RFC key has both `-` and `_`, so its standard form is certain to carry `+` and `/`.
    ['standard base64', { p256dh: b64(RFC8291.uaPublic).toString('base64'), auth: ua.keys.auth }],
    ['auth 15 bytes', { p256dh: ua.keys.p256dh, auth: randomBytes(15).toString('base64url') }],
    ['auth 17 bytes', { p256dh: ua.keys.p256dh, auth: randomBytes(17).toString('base64url') }],
  ] as const) {
    assert.throws(() => normalizeWebPushSubscription({ endpoint: FCM, keys }, []), label);
  }
});

// ── Registration ────────────────────────────────────────────────────────────

await test('webpush registration: subscription required, token ignored, public view leaks no capability', () => {
  const home = tempRoot('registry');
  const registry = new WakePushRegistry(home);
  assert.throws(
    () => registry.register({ deviceId: 'web', platform: 'webpush', token: 'ignored' }, { kind: 'owner' }),
    (error) => error instanceof WakePushError && error.code === 'BAD_PARAM' && error.status === 400,
  );
  assert.throws(
    () => registry.register({ deviceId: 'web', platform: 'webpush', subscription: { endpoint: 'http://fcm.googleapis.com/x', keys: userAgent().keys } }, { kind: 'owner' }),
    (error) => error instanceof WakePushError && error.code === 'BAD_PARAM',
  );
  const ua = userAgent();
  const context = '{"profile":"p-7","route":"/s/claude/abc"}';
  const registered = registry.register({
    deviceId: 'web-client-1',
    platform: 'webpush',
    token: 'must-not-be-stored',
    subscription: { endpoint: FCM, keys: ua.keys },
    presentation: {
      question: { title: '  Question \n asked  ' },
      turn_finished: { title: 'Turn finished', typeOnly: true, silent: true },
      turn_failed: { title: 'Turn failed', typeOnly: false, silent: false },
      future_type: { title: 'From a newer client' },
    },
    context,
  }, { kind: 'owner' });
  assert.deepEqual(registered, {
    deviceId: 'web-client-1',
    platform: 'webpush',
    tokenPreview: 'https://fcm.googleapis.com',
    presentationTypes: ['question', 'turn_finished', 'turn_failed'],
    createdAt: registered.createdAt,
    updatedAt: registered.updatedAt,
  });
  const listed = JSON.stringify(registry.list({ kind: 'owner' }));
  for (const secret of ['capability-path', ua.keys.p256dh, ua.keys.auth, context, 'Question', 'must-not-be-stored']) {
    assert.equal(listed.includes(secret), false, `list leaks ${secret}`);
    assert.equal(JSON.stringify(registered).includes(secret), false, `response leaks ${secret}`);
  }
  const stored = registry.getForDispatch('web-client-1');
  assert.equal(stored.token, '');
  assert.deepEqual(stored.subscription, { endpoint: FCM, keys: ua.keys });
  assert.deepEqual(stored.presentation, {
    question: { title: 'Question asked' },
    turn_finished: { title: 'Turn finished', typeOnly: true, silent: true },
    turn_failed: { title: 'Turn failed' },
  }, 'false flags are dropped, true flags kept');
  assert.equal(stored.context, context);
  const path = join(home, 'push-wake-tokens.json');
  if (POSIX) assert.equal(statSync(path).mode & 0o777, 0o600);
  const reloaded = new WakePushRegistry(home).getForDispatch('web-client-1');
  assert.deepEqual(reloaded, stored, 'persisted and reloaded intact');
});

await test('webpush registration: presentation and context are bounded and validated', () => {
  const registry = new WakePushRegistry(tempRoot('registry-bounds'));
  const base = { deviceId: 'web', platform: 'webpush' as const, subscription: { endpoint: FCM, keys: userAgent().keys } };
  for (const [label, extra] of [
    ['empty title', { presentation: { question: { title: '   ' } } }],
    ['missing title', { presentation: { question: {} } }],
    ['string typeOnly', { presentation: { question: { title: 'Q', typeOnly: 'yes' } } }],
    ['numeric silent', { presentation: { question: { title: 'Q', silent: 1 } } }],
    ['array presentation', { presentation: [] }],
    ['numeric context', { context: 7 }],
    ['oversize context', { context: 'c'.repeat(WEB_PUSH_CONTEXT_MAX_LENGTH + 1) }],
  ] as const) {
    assert.throws(
      () => registry.register({ ...base, ...(extra as object) }, { kind: 'owner' }),
      (error) => error instanceof WakePushError && error.code === 'BAD_PARAM',
      label,
    );
  }
  const longTitle = '通知'.repeat(60);
  registry.register({
    ...base,
    presentation: { question: { title: longTitle } },
    context: `  ${'c'.repeat(WEB_PUSH_CONTEXT_MAX_LENGTH)}  `,
  }, { kind: 'owner' });
  const stored = registry.getForDispatch('web');
  assert.equal(clusters(stored.presentation!.question!.title).length, 80);
  assert.equal(stored.context, 'c'.repeat(WEB_PUSH_CONTEXT_MAX_LENGTH), 'trimmed, then at the limit');
  registry.register({ ...base, context: '   ' }, { kind: 'owner' });
  assert.equal(Object.hasOwn(registry.getForDispatch('web'), 'context'), false, 'blank context is absent');
});

await test('webpush re-registration is idempotent only when subscription, presentation, and context all match', () => {
  const home = tempRoot('registry-idempotent');
  let now = Date.parse('2026-09-23T00:00:00Z');
  const registry = new WakePushRegistry(home, { now: () => now });
  const ua = userAgent();
  const input = {
    deviceId: 'web',
    platform: 'webpush' as const,
    subscription: { endpoint: FCM, keys: ua.keys },
    presentation: { question: { title: 'Question' } },
    context: 'ctx-1',
  };
  const path = join(home, 'push-wake-tokens.json');
  const first = registry.register(input, { kind: 'owner' });
  const bytes = readFileSync(path, 'utf8');
  now += 1_000;
  assert.deepEqual(registry.register(input, { kind: 'owner' }), first);
  assert.equal(readFileSync(path, 'utf8'), bytes, 'an unchanged registration does not rewrite state');
  const changes: Array<Partial<WakeRegistrationInput>> = [
    { presentation: { question: { title: 'Question', typeOnly: true } } },
    { presentation: { question: { title: 'Question', silent: true } } },
    { presentation: { question: { title: 'Frage' } } },
    { presentation: { question: { title: 'Question' }, turn_failed: { title: 'Failed' } } },
    { context: 'ctx-2' },
    { context: undefined },
    { subscription: { endpoint: `${FCM}-rotated`, keys: ua.keys } },
    { subscription: { endpoint: FCM, keys: userAgent().keys } },
  ];
  for (const change of changes) {
    now += 1_000;
    const before = registry.register(input, { kind: 'owner' }).updatedAt;
    now += 1_000;
    const updated = registry.register({ ...input, ...change }, { kind: 'owner' });
    assert.notEqual(updated.updatedAt, before, `${JSON.stringify(change)} is an update`);
    const stored = registry.getForDispatch('web');
    const expected = { ...input, ...change };
    assert.equal(stored.context, expected.context, 'the change is stored');
    assert.equal(stored.subscription?.endpoint, expected.subscription!.endpoint);
    assert.equal(stored.subscription?.keys.p256dh, expected.subscription!.keys.p256dh);
    assert.deepEqual(stored.presentation, expected.presentation);
  }
});

await test('stored registrations: older files load, and a webpush record on a no-longer-allowed host is dropped', () => {
  const home = tempRoot('registry-stored');
  const ua = userAgent();
  writeFileSync(join(home, 'push-wake-tokens.json'), JSON.stringify({
    version: 2,
    registrations: [
      { deviceId: 'phone', owner: { kind: 'owner' }, platform: 'fcm', token: 'fcm-token', createdAt: 'c', updatedAt: 'u' },
      { deviceId: 'web-ok', owner: { kind: 'owner' }, platform: 'webpush', token: '', subscription: { endpoint: FCM, keys: ua.keys }, presentation: { question: { title: 'Q' } }, createdAt: 'c', updatedAt: 'u' },
      { deviceId: 'web-foreign', owner: { kind: 'owner' }, platform: 'webpush', token: '', subscription: { endpoint: 'https://push.example.test/x', keys: ua.keys }, createdAt: 'c', updatedAt: 'u' },
      { deviceId: 'web-no-subscription', owner: { kind: 'owner' }, platform: 'webpush', token: 'x', createdAt: 'c', updatedAt: 'u' },
    ],
  }), { mode: 0o600 });
  const registry = new WakePushRegistry(home);
  assert.deepEqual(registry.listForDispatch().map((registration) => registration.deviceId).sort(), ['phone', 'web-ok']);
  assert.deepEqual(registry.getForDispatch('phone'), {
    deviceId: 'phone', owner: { kind: 'owner' }, platform: 'fcm', token: 'fcm-token', createdAt: 'c', updatedAt: 'u',
  }, 'an apns/fcm record is unchanged');
  assert.equal(Object.hasOwn(registry.list({ kind: 'owner' }).find((entry) => entry.deviceId === 'phone')!, 'presentationTypes'), false);
});

await test('revokeForDispatch removes only the registration that still holds the gone endpoint', () => {
  const home = tempRoot('registry-revoke');
  const { registry, registration, ua } = webPushRegistration(home);
  const stale = { ...registration, subscription: { endpoint: `${FCM}-older`, keys: ua.keys } };
  assert.equal(registry.revokeForDispatch(stale), false, 'a raced re-subscription survives');
  assert.equal(registry.listForDispatch().length, 1);
  assert.equal(registry.revokeForDispatch({ deviceId: 'phone' }), false, 'nothing without a subscription');
  assert.equal(registry.revokeForDispatch(registration), true);
  assert.deepEqual(new WakePushRegistry(home).listForDispatch(), [], 'removal is durable');
});

await test('apns/fcm stay opaque wakes and a webpush registration never takes one', async () => {
  const registration = webPushRegistration(tempRoot('opaque')).registration;
  let called = false;
  await assert.rejects(
    () => dispatchWakePush(registration, { fetch: (async () => { called = true; return new Response(null, { status: 200 }); }) as unknown as typeof fetch }),
    (error) => error instanceof WakePushError && error.code === 'BAD_PARAM',
  );
  assert.equal(called, false);
});

await test('GET /api/push/web-push-key carries the registration route authority', () => {
  const observer = { kind: 'peer' as const, roles: new Set(['observe'] as const) };
  assert.deepEqual(authorizeBrokerRoute({ kind: 'owner' }, '/api/push/web-push-key', 'GET'), { allowed: true });
  assert.deepEqual(authorizeBrokerRoute(observer, '/api/push/web-push-key', 'GET'), { allowed: true });
  assert.equal(authorizeBrokerRoute({ kind: 'peer', roles: new Set(['drive'] as const) }, '/api/push/web-push-key', 'GET').allowed, false);
  assert.deepEqual(authorizeBrokerRoute(undefined, '/api/push/web-push-key', 'GET'), { allowed: false, status: 401, error: 'authenticated credential required' });
  assert.equal(authorizeBrokerRoute(observer, '/api/push/web-push-key', 'POST').allowed, false);
  assert.equal(authorizeBrokerRoute({ kind: 'integration', integration: 'pi' }, '/api/push/web-push-key', 'GET').allowed, false);
});

// ── What a delivery shows ───────────────────────────────────────────────────

await test('skip rules: nothing is sent for an event that is gone, over, silent, not presented, or already seen', () => {
  assert.deepEqual(plan({ event: undefined }), { skip: 'event-missing' });
  const request = attentionEvent({ kind: 'permission-required', state: 'active', dedupeKey: 'permission:r1' });
  assert.ok('notification' in plan({ event: request }));
  assert.deepEqual(plan({ event: { ...request, state: 'resolved' } }), { skip: 'event-resolved' }, 'an answered request');
  assert.deepEqual(plan({ event: attentionEvent({ kind: 'runtime-update-ready', state: 'resolved' }) }), { skip: 'event-resolved' });
  for (const kind of ['run-finished', 'goal-finished', 'run-failed', 'device-paired', 'security-alert', 'scheduled-send-failed']) {
    assert.ok('notification' in plan({ event: attentionEvent({ kind, state: 'resolved', severity: 'action-required' }) }), `${kind} is born resolved and still delivers`);
  }
  assert.deepEqual(plan({ event: attentionEvent({ kind: 'scheduled-send', state: 'resolved' }) }), { skip: 'event-resolved' });
  assert.deepEqual(plan({ event: attentionEvent({ kind: 'scheduled-send', state: 'active' }) }), { skip: 'not-a-notification' });
  assert.deepEqual(plan({ event: attentionEvent({ kind: 'broker-health', state: 'active', severity: 'maintenance' }) }), { skip: 'not-a-notification' });
  assert.equal(notificationOf(plan({ event: attentionEvent({ kind: 'broker-health', state: 'active', severity: 'action-required' }) })).payload.type, 'server_problem');
  assert.deepEqual(plan({ event: attentionEvent({ kind: 'sync-degraded', state: 'active' }) }), { skip: 'not-a-notification' });
  assert.deepEqual(plan({ presentation: { question: { title: 'Q' } } }), { skip: 'type-not-presented' });
  assert.deepEqual(plan({ presentation: undefined }), { skip: 'type-not-presented' });
  assert.deepEqual(plan({ deviceState: { readAt: 5 } }), { skip: 'device-read' });
  assert.deepEqual(plan({ deviceState: { dismissedAt: 5 } }), { skip: 'device-read' });
  assert.ok('notification' in plan({ deviceState: {} }));
  const seen = { ...request, seenAt: 9 };
  assert.deepEqual(plan({ event: seen, stage: '15m' }), { skip: 'seen-before-reminder' });
  assert.deepEqual(plan({ event: seen, stage: '7h' }), { skip: 'seen-before-reminder' });
  // A browser that registered after the alert is already looking at the inbox that lists it.
  assert.deepEqual(plan({ registeredAt: 2 }), { skip: 'before-registration' }, 'an alert from before the registration');
  assert.ok('notification' in plan({ registeredAt: 1 }), 'an alert from the same instant still shows');
  assert.ok('notification' in plan({ registeredAt: Number.NaN }), 'an unreadable registration time never silences');
  // An alert is placed by the stage it was raised at, so a delayed one after the registration is new.
  const H = 3_600_000;
  const runtime = attentionEvent({ kind: 'runtime-update-ready', state: 'active', severity: 'maintenance', dedupeKey: 'runtime:r1' });
  assert.ok('notification' in plan({ event: runtime, stage: '2h', registeredAt: 1 + H }), 'a runtime update alerted after the registration');
  assert.deepEqual(plan({ event: runtime, stage: '2h', registeredAt: 2 + 2 * H }), { skip: 'before-registration' });
  const health = attentionEvent({ kind: 'broker-health', state: 'active', severity: 'action-required', dedupeKey: 'health:r1' });
  assert.ok('notification' in plan({ event: health, stage: `health-${5 * H}`, registeredAt: 4 * H }), 'an escalation after the registration');
  assert.deepEqual(plan({ event: health, stage: `health-${5 * H}`, registeredAt: 6 * H }), { skip: 'before-registration' });
  // Stages an older broker stored before its reminders were removed: an upgrade must not replay
  // them to every browser that registers afterwards.
  assert.deepEqual(plan({ event: request, stage: '517h', registeredAt: 1 + 518 * H }), { skip: 'before-registration' });
  assert.deepEqual(plan({ event: request, stage: '15m', registeredAt: 1 + H }), { skip: 'before-registration' });
  assert.ok('notification' in plan({ event: request, stage: '15m', registeredAt: 2 }), 'a stored later stage raised after the registration');
  assert.ok('notification' in plan({ event: request, stage: 'unknown-stage', registeredAt: 1 + H }), 'a stage this broker cannot place never silences');
  assert.ok('notification' in plan({ event: seen, stage: 'immediate' }), 'the first alert may race a read');
  assert.ok('notification' in plan({ event: request, stage: '15m' }), 'an unseen reminder is sent');
});

await test('payload: title from the registration, session-title body, collapse-key tag, stage, action, context', () => {
  const context = '{"profile":"p-7","route":"/s/claude/s1?x=1&y=\\"z\\""} ✓';
  const turn = notificationOf(plan({ presentation: { turn_finished: { title: 'Turn finished' } }, context }));
  assert.deepEqual(turn.payload, {
    v: 1,
    eventId: 'event-1',
    revision: 1,
    type: 'turn_finished',
    title: 'Turn finished',
    body: 'Fix the login bug',
    tag: 'session-outcome:claude:s1',
    stage: 'immediate',
    action: { kind: 'open-session', tool: 'claude', sessionId: 's1' },
    context,
  });
  assert.equal(JSON.parse(JSON.stringify(turn.payload)).context, context, 'context survives the wire byte for byte');
  assert.equal(Object.hasOwn(notificationOf(plan()).payload, 'context'), false, 'absent context is omitted');
  assert.equal(Object.hasOwn(turn.payload, 'silent'), false, 'a sounding type carries no silent flag');
  const quiet = notificationOf(plan({ presentation: { turn_finished: { title: 'Turn finished', silent: true } } }));
  assert.equal(quiet.payload.silent, true, 'a silent type says so');
  assert.equal(quiet.payload.body, 'Fix the login bug', 'silent is not typeOnly');

  const request = notificationOf(plan({
    event: attentionEvent({ kind: 'permission-required', state: 'active', dedupeKey: 'permission-required:claude:s1:r9', sessionTitle: '  Deploy \n\t staging  ' }),
    stage: '1h',
  }));
  assert.equal(request.payload.tag, 'permission-required:claude:s1:r9', 'a request collapses on its dedupe key');
  assert.equal(request.payload.body, 'Deploy staging', 'whitespace collapses');
  assert.equal(request.payload.stage, '1h');
  const realerted = notificationOf(plan({ event: attentionEvent({ kind: 'permission-required', state: 'active', presentationRevision: 4 }), stage: '7h' }));
  assert.deepEqual([realerted.payload.eventId, realerted.payload.revision, realerted.payload.stage], ['event-1', 4, '7h'], 'one alert is (eventId, revision, stage)');

  const paired = notificationOf(plan({
    event: attentionEvent({ kind: 'device-paired', agent: undefined, sessionId: undefined, sessionTitle: 'ignored', title: 'New device paired', dedupeKey: 'device-paired:p1:5', action: { kind: 'open-attention-inbox' } }),
  }));
  assert.equal(paired.payload.body, 'New device paired', 'an event outside a session shows its own title');
  assert.deepEqual(paired.payload.action, { kind: 'open-attention-inbox' });
  assert.equal(notificationOf(plan({ event: attentionEvent({ dedupeKey: '  ' }), presentation: { device_paired: { title: 'x' }, turn_finished: { title: 'y' } } })).payload.tag, 'session-outcome:claude:s1');
  assert.equal(
    notificationOf(plan({ event: attentionEvent({ kind: 'device-paired', dedupeKey: ' ', action: { kind: 'open-attention-inbox' } }) })).payload.tag,
    'event:event-1',
  );
  assert.equal(notificationOf(plan({ event: attentionEvent({ sessionTitle: undefined }) })).payload.body, '', 'an untitled session sends no body');
  assert.equal(notificationOf(plan({ presentation: { turn_finished: { title: 'Turn finished', typeOnly: true } } })).payload.body, '', 'typeOnly');
});

await test('payload body: 48 grapheme clusters with an ellipsis, never splitting CJK or emoji', () => {
  const family = '👨‍👩‍👧‍👦';
  const flag = '🇯🇵';
  const title = `${'修复登录'.repeat(6)}${family.repeat(10)}${flag.repeat(10)}e\u0301\u0301`;
  const input = clusters(title);
  assert.equal(input.length, 24 + 10 + 10 + 1);
  const long = `${title}${'字'.repeat(10)}`;
  const body = notificationOf(plan({ event: attentionEvent({ sessionTitle: long }) })).payload.body;
  const kept = clusters(body);
  assert.equal(kept.length, 48);
  assert.equal(kept.at(-1), '…');
  assert.deepEqual(kept.slice(0, 47), clusters(long).slice(0, 47), 'whole clusters, in order');
  assert.equal(body.isWellFormed(), true, 'no lone surrogate');
  const exact = '字'.repeat(48);
  assert.equal(truncateWebPushText(exact), exact, 'exactly 48 is untouched');
  assert.equal(truncateWebPushText(`${'字'.repeat(46)}   ${'x'.repeat(5)}`), `${'字'.repeat(46)}…`, 'trailing space trimmed before the ellipsis');
  assert.equal(clusters(truncateWebPushText('字'.repeat(49))).length, 48);
});

await test('payload: stays under 3 KB; an unbounded grapheme drops the body, never the notification', () => {
  const zalgo = `Z${'́'.repeat(4000)}`;
  const result = notificationOf(plan({ event: attentionEvent({ sessionTitle: zalgo }) }));
  assert.equal(result.payload.body, '');
  assert.ok(Buffer.byteLength(JSON.stringify(result.payload)) <= WEB_PUSH_PAYLOAD_MAX_BYTES);
  assert.deepEqual(
    plan({ event: attentionEvent({ id: 'e'.repeat(WEB_PUSH_PAYLOAD_MAX_BYTES) }) }),
    { skip: 'payload-too-large' },
  );
});

await test('headers: TTL by type family, Urgency for urgent types, a stable keyed 32-char Topic', async () => {
  const home = tempRoot('headers');
  const vapid = new WebPushVapidKeyStore(home, { warn: () => {} });
  const ua = userAgent();
  const subscription = { endpoint: FCM, keys: ua.keys };
  const cases: Array<[Partial<AttentionEvent>, number, 'high' | 'normal']> = [
    [{ kind: 'permission-required', state: 'active' }, 86_400, 'high'],
    [{ kind: 'question-required', state: 'active' }, 86_400, 'high'],
    [{ kind: 'run-finished' }, 14_400, 'normal'],
    [{ kind: 'goal-finished' }, 14_400, 'normal'],
    [{ kind: 'run-failed' }, 14_400, 'normal'],
    [{ kind: 'security-alert' }, 43_200, 'high'],
    [{ kind: 'broker-health', state: 'active', severity: 'action-required' }, 43_200, 'high'],
    [{ kind: 'device-paired' }, 43_200, 'normal'],
    [{ kind: 'scheduled-send-failed' }, 43_200, 'normal'],
    [{ kind: 'runtime-update-ready', state: 'active' }, 43_200, 'normal'],
    [{ kind: 'usage-threshold', state: 'active' }, 43_200, 'normal'],
  ];
  for (const [overrides, ttl, urgency] of cases) {
    const notification = notificationOf(plan({ event: attentionEvent(overrides) }));
    const { calls, fetch } = recordingFetch(201);
    assert.deepEqual(await sendWebPush(subscription, notification, { vapid, fetch }), { kind: 'sent', status: 201 });
    const [call] = calls;
    const headers = new Headers(call!.init.headers);
    assert.equal(call!.url, FCM);
    assert.equal(call!.init.method, 'POST');
    assert.equal(call!.init.redirect, 'manual', 'never follows the push service elsewhere');
    assert.equal(headers.get('ttl'), String(ttl), `${overrides.kind} TTL`);
    assert.equal(headers.get('urgency'), urgency, `${overrides.kind} Urgency`);
    assert.equal(headers.get('content-encoding'), 'aes128gcm');
    assert.equal(headers.get('content-type'), 'application/octet-stream');
    assert.match(headers.get('authorization') ?? '', new RegExp(`^vapid t=[^,]+, k=${vapid.publicKey()}$`));
    assert.match(headers.get('topic') ?? '', /^[A-Za-z0-9_-]{32}$/);
    assert.equal(headers.get('topic'), webPushTopic(notification.payload.tag, ua.keys.auth));
    const decrypted = decryptAsUserAgent(call!.init.body as Uint8Array, ua.ecdh, b64(ua.keys.auth));
    assert.deepEqual(JSON.parse(decrypted.toString()), notification.payload, 'the body is the payload, encrypted to this browser');
  }
  const topic = webPushTopic('session-outcome:claude:s1', ua.keys.auth);
  assert.equal(webPushTopic('session-outcome:claude:s1', ua.keys.auth), topic, 'stable, so a newer outcome replaces a queued one');
  assert.notEqual(webPushTopic('session-outcome:claude:s2', ua.keys.auth), topic);
  assert.notEqual(webPushTopic('session-outcome:claude:s1', userAgent().keys.auth), topic, 'keyed per subscription');
});

await test('responses: 2xx sent, 404/410 revoke, 413 and other refusals complete, 429/5xx/network retry', async () => {
  const home = tempRoot('responses');
  const vapid = new WebPushVapidKeyStore(home, { warn: () => {} });
  const context = 'ctx:{"tab":"s1"} ✓';
  const { registration, registry, ua } = webPushRegistration(join(home, 'registry'), { context });
  const event = attentionEvent();
  const delivery = { deviceId: registration.deviceId, eventId: event.id, stage: 'immediate' };
  const run = async (respond: Parameters<typeof recordingFetch>[0], readBy?: string) => {
    const revoked: WakeRegistration[] = [];
    const warnings: string[] = [];
    const { calls, fetch } = recordingFetch(respond);
    const deps: WebPushDeliveryDependencies = {
      store: {
        getEvent: (id) => (id === event.id ? event : undefined),
        getClientState: (clientId, eventId) => (clientId === readBy && eventId === event.id
          ? { clientId, eventId, cursor: 1, readAt: 5 }
          : undefined),
      },
      vapid,
      fetch,
      timeoutMs: 50,
      revoke: (gone) => { revoked.push(gone); },
      warn: (message) => warnings.push(message),
    };
    return { calls, revoked, warnings, outcome: () => deliverWebPush(delivery, registration, deps) };
  };
  for (const status of [201, 202]) {
    const probe = await run(status);
    assert.deepEqual(await probe.outcome(), { kind: 'sent', status });
    assert.equal(probe.revoked.length, 0);
    assert.deepEqual(probe.warnings, []);
    const sent = JSON.parse(decryptAsUserAgent(probe.calls[0]!.init.body as Uint8Array, ua.ecdh, b64(ua.keys.auth)).toString());
    assert.equal(sent.context, context, 'the registration context rides every push');
    assert.equal(sent.title, 'title:turn_finished', 'the registration title');
  }
  const readHere = await run(201, registration.deviceId);
  assert.deepEqual(await readHere.outcome(), { kind: 'skipped', reason: 'device-read' }, 'the delivery device read it');
  assert.equal(readHere.calls.length, 0);
  const readElsewhere = await run(201, 'another-client');
  assert.deepEqual(await readElsewhere.outcome(), { kind: 'sent', status: 201 }, 'another client reading it is not this device');
  for (const status of [404, 410]) {
    const probe = await run(status);
    assert.deepEqual(await probe.outcome(), { kind: 'gone', status });
    assert.deepEqual(probe.revoked, [registration], `${status} revokes`);
    assert.match(probe.warnings.join(), /gone/);
  }
  for (const status of [413, 400, 403, 301]) {
    const probe = await run(status);
    assert.deepEqual(await probe.outcome(), { kind: 'rejected', status }, `${status} completes without retry`);
    assert.equal(probe.revoked.length, 0, `${status} does not revoke`);
    assert.match(probe.warnings.join(), new RegExp(`HTTP ${status}\\); not retried`));
  }
  // The service's own words reach the log, bounded and without the endpoint's capability path.
  const explained = await run(() => new Response(`push subscription ${new URL(FCM).pathname} has unsubscribed or expired.\n${'x'.repeat(5000)}`, {
    status: 410,
    headers: { 'x-wns-status': 'dropped' },
  }));
  assert.deepEqual(await explained.outcome(), {
    kind: 'gone',
    status: 410,
    detail: `x-wns-status: dropped; push subscription <endpoint> has unsubscribed or expired. ${'x'.repeat(5000)}`.slice(0, 200),
  });
  const logged = explained.warnings.join();
  assert.match(logged, /is gone \(https:\/\/fcm\.googleapis\.com HTTP 410: x-wns-status: dropped; push subscription <endpoint> has unsubscribed/);
  assert.ok(!logged.includes('capability-path'), 'the endpoint path never reaches the log');
  for (const status of [429, 500, 503]) {
    const probe = await run(status);
    await assert.rejects(probe.outcome(), (error) => error instanceof WakePushError && error.code === 'PUSH_DELIVERY_FAILED', `${status} retries`);
    assert.equal(probe.revoked.length, 0);
  }
  const network = await run(() => { throw new TypeError(`connect failed to ${FCM}`); });
  await assert.rejects(network.outcome(), (error) => error instanceof WakePushError
    && error.code === 'PUSH_DELIVERY_FAILED'
    && !error.message.includes('capability-path'));
  // A real fetch rejects when its signal aborts; so does this one.
  const slow = await run((init) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  await assert.rejects(slow.outcome(), /timed out after 50ms/);
  const guard = recordingFetch(201);
  const deps: WebPushDeliveryDependencies = {
    store: { getEvent: () => undefined, getClientState: () => undefined },
    vapid,
    fetch: guard.fetch,
    revoke: () => {},
  };
  assert.deepEqual(await deliverWebPush(delivery, registration, deps), { kind: 'skipped', reason: 'event-missing' });
  assert.equal(guard.calls.length, 0, 'a skip sends nothing');
  assert.equal(registry.listForDispatch().length, 1);
});

await test('scheduler: a skip or a send completes the delivery, a retryable failure backs off, gone revokes', async () => {
  for (const [label, respond, expected] of [
    ['sent', 201, { state: 'delivered', attempts: 0, registered: 1, sends: 1 }],
    ['retry', 503, { state: 'reserved', attempts: 1, registered: 1, sends: 1 }],
    ['gone', 410, { state: 'delivered', attempts: 0, registered: 0, sends: 1 }],
    ['skipped', 201, { state: 'delivered', attempts: 0, registered: 1, sends: 0 }],
  ] as const) {
    const root = tempRoot(`scheduler-${label}`);
    let now = 1_000_000;
    const store = new AttentionStore({ home: root, now: () => now, idFactory: () => 'event-1', onWarning: () => {} });
    const { registry, registration } = webPushRegistration(join(root, 'registry'), label === 'skipped'
      ? { presentation: { question: { title: 'Q' } } }
      : {});
    const { calls, fetch } = recordingFetch(respond);
    const vapid = new WebPushVapidKeyStore(root, { warn: () => {} });
    const scheduler = new AttentionReminderScheduler(store, {
      now: () => now,
      listDeviceIds: () => registry.listForDispatch().map((entry) => entry.deviceId),
      setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
      dispatchReservation: (delivery) => deliverWebPush(delivery, registry.getForDispatch(delivery.deviceId), {
        store, vapid, fetch, revoke: (gone) => registry.revokeForDispatch(gone),
      }),
      onError: () => {},
    });
    const upsert: AttentionEventUpsert = {
      dedupeKey: 'run-finished:claude:s1:t1',
      kind: 'run-finished',
      state: 'resolved',
      severity: 'informational',
      agent: 'claude',
      sessionId: 's1',
      sessionTitle: 'Fix the login bug',
      title: 'Agent run finished',
      action: { kind: 'open-session', tool: 'claude', sessionId: 's1' },
      presentationRevision: 1,
      presentationStage: 'immediate',
    };
    await store.upsertEvent(upsert);
    await scheduler.tick();
    const deliveries = store.listDeliveries().filter((entry) => entry.deviceId === registration.deviceId);
    if (label === 'sent') {
      // A browser that registers only now completes the same event without a send.
      const late = new WakePushRegistry(join(root, 'late'), { now: () => now + 1 });
      const lateUa = userAgent();
      late.register({ deviceId: 'web-client-late', platform: 'webpush', subscription: { endpoint: FCM, keys: lateUa.keys }, presentation: PRESENT_ALL }, { kind: 'owner' });
      const lateScheduler = new AttentionReminderScheduler(store, {
        now: () => now,
        listDeviceIds: () => late.listForDispatch().map((entry) => entry.deviceId),
        setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
        clearTimer: () => {},
        dispatchReservation: (delivery) => deliverWebPush(delivery, late.getForDispatch(delivery.deviceId), {
          store, vapid, fetch, revoke: (gone) => late.revokeForDispatch(gone),
        }),
        onError: () => {},
      });
      const sendsBefore = calls.length;
      await lateScheduler.tick();
      const lateDelivery = store.listDeliveries().find((entry) => entry.deviceId === 'web-client-late');
      assert.equal(lateDelivery?.state, 'delivered', 'the late browser completes the old event');
      assert.equal(calls.length, sendsBefore, 'without replaying it as a push');
    }
    assert.equal(deliveries.length, 1, label);
    assert.equal(deliveries[0]!.state, expected.state, `${label} state`);
    assert.equal(deliveries[0]!.attempts, expected.attempts, `${label} attempts`);
    if (label === 'retry') assert.equal(deliveries[0]!.nextAttemptAt, now + 5 * 60_000, 'the scheduler backoff applies');
    assert.equal(registry.listForDispatch().length, expected.registered, `${label} registration`);
    assert.equal(calls.length, expected.sends, `${label} sends`);
    now += 1;
  }
});

// ── The broker's own wiring ─────────────────────────────────────────────────

await test('fixture broker: key route, webpush registration, and a real dispatch over TLS beside an opaque fcm wake', async () => {
  const root = tempRoot('broker');
  const home = join(root, 'cosyncing-home');
  const token = 'web-push-fixture-token';
  const sinks = await Promise.all([tlsSink(), tlsSink()]);
  const webhookBodies: Array<Record<string, unknown>> = [];
  const webhook = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req) => {
      webhookBodies.push(await req.json().catch(() => ({})) as Record<string, unknown>);
      return Response.json({ ok: true });
    },
  });
  const lease = await reserveLoopbackFixturePort();
  const port = lease.port;
  await lease.release();
  const broker = Bun.spawn(['bun', resolve(import.meta.dir, '../../src/main.ts')], {
    cwd: resolve(import.meta.dir, '../../../../..'),
    env: isolatedBrokerFixtureEnvironment(root, {
      overrides: {
        PORT: String(port),
        HOST: '127.0.0.1',
        COSYNCING_TOKEN: token,
        COSYNCING_TOKEN_FILE: '',
        COSYNCING_PI_INTEGRATION_FILE: '',
        COSYNCING_WAKE_PUSH_WEBHOOK: `http://127.0.0.1:${webhook.port}/wake`,
        COSYNCING_WEB_PUSH_EXTRA_HOSTS: '127.0.0.1',
      },
    }),
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const auth = { 'x-cosyncing-token': token };
  try {
    await waitForBrokerHealth(broker, `${base}/api/health`);
    const vapidPath = join(home, 'web-push-vapid.json');
    assert.equal(existsSync(vapidPath), false, 'no key before first use');
    assert.equal((await fetch(`${base}/api/push/web-push-key`)).status, 401);
    const keyResponse = await fetch(`${base}/api/push/web-push-key`, { headers: auth });
    assert.equal(keyResponse.status, 200);
    const key = await keyResponse.json() as { ok: boolean; publicKey: string };
    assert.equal(key.ok, true);
    assert.equal(b64(key.publicKey).length, 65);
    assert.equal(b64(key.publicKey)[0], 0x04);
    assert.equal(((await (await fetch(`${base}/api/push/web-push-key`, { headers: auth })).json()) as { publicKey: string }).publicKey, key.publicKey);
    assert.equal(existsSync(vapidPath), true);
    if (POSIX) assert.equal(statSync(vapidPath).mode & 0o777, 0o600);

    const register = (body: Record<string, unknown>) => fetch(`${base}/api/push/wake-tokens`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const ua = userAgent();
    const bad = await register({ deviceId: 'web-bad', platform: 'webpush', subscription: { endpoint: `http://127.0.0.1:${sinks[0]!.port}/x`, keys: ua.keys } });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { code: string }).code, 'BAD_PARAM');
    const tooLong = await register({ deviceId: 'web-bad', platform: 'webpush', subscription: { endpoint: `https://127.0.0.1:${sinks[0]!.port}/x`, keys: ua.keys }, context: 'c'.repeat(513) });
    assert.equal(tooLong.status, 400);

    const endpoint = `https://127.0.0.1:${sinks[0]!.port}/push/capability-path-alerts`;
    const registered = await register({
      deviceId: 'web-alerts',
      platform: 'webpush',
      subscription: { endpoint, keys: ua.keys },
      presentation: { security_alert: { title: 'Security alert' } },
      context: 'route-context-secret',
    });
    assert.equal(registered.status, 201);
    const registeredJson = await registered.json() as { registration: Record<string, unknown> };
    assert.equal(registeredJson.registration.tokenPreview, `https://127.0.0.1:${sinks[0]!.port}`);
    assert.deepEqual(registeredJson.registration.presentationTypes, ['security_alert']);
    assert.equal((await register({
      deviceId: 'web-quiet',
      platform: 'webpush',
      subscription: { endpoint: `https://127.0.0.1:${sinks[1]!.port}/push/capability-path-quiet`, keys: userAgent().keys },
      presentation: { turn_finished: { title: 'Turn finished' } },
    })).status, 201);
    assert.equal((await register({ deviceId: 'phone', platform: 'fcm', token: 'fcm-token' })).status, 201);
    const listed = await (await fetch(`${base}/api/push/wake-tokens`, { headers: auth })).text();
    for (const secret of ['capability-path', ua.keys.p256dh, ua.keys.auth, 'route-context-secret']) {
      assert.equal(listed.includes(secret), false, `list leaks ${secret}`);
      assert.equal(JSON.stringify(registeredJson).includes(secret), false, `registration leaks ${secret}`);
    }

    // Five unauthenticated requests raise a security alert, which the scheduler delivers to all three.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await fetch(`${base}/api/sessions`)).status, 401);
    }
    const deadline = Date.now() + 15_000;
    const deliveries = (): Array<{ deviceId: string; state: string; attempts: number }> => {
      try {
        return JSON.parse(readFileSync(join(home, 'attention-events.json'), 'utf8')).deliveries ?? [];
      } catch {
        return [];
      }
    };
    const settled = () => {
      const byDevice = new Map(deliveries().map((entry) => [entry.deviceId, entry]));
      return sinks[0]!.hellos.length > 0
        && byDevice.get('web-alerts')?.attempts === 1
        && byDevice.get('web-quiet')?.state === 'delivered'
        && byDevice.get('phone')?.state === 'delivered';
    };
    while (!settled() && Date.now() < deadline) await Bun.sleep(50);
    const byDevice = new Map(deliveries().map((entry) => [entry.deviceId, entry]));
    assert.equal(sinks[0]!.hellos[0]?.[0], 0x16, 'the broker opened TLS to the subscription endpoint');
    assert.equal(sinks[0]!.hellos[0]?.[1], 0x03);
    assert.deepEqual(
      { state: byDevice.get('web-alerts')?.state, attempts: byDevice.get('web-alerts')?.attempts },
      { state: 'reserved', attempts: 1 },
      'the failed handshake is a retryable failure',
    );
    assert.deepEqual(
      { state: byDevice.get('web-quiet')?.state, attempts: byDevice.get('web-quiet')?.attempts },
      { state: 'delivered', attempts: 0 },
      'a type the registration does not present completes unsent',
    );
    assert.equal(sinks[1]!.hellos.length, 0, 'and its endpoint is never contacted');
    assert.equal(byDevice.get('phone')?.state, 'delivered');
    assert.ok(webhookBodies.some((body) => body.platform === 'fcm' && body.token === 'fcm-token'), 'fcm still gets the opaque wake');
    assert.ok(webhookBodies.every((body) => body.platform === 'fcm' && Object.keys(body).sort().join() === 'platform,token,type'));
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
    webhook.stop(true);
    for (const sink of sinks) sink.close();
  }
});

/** A loopback TCP listener that records the first bytes of each connection and hangs up. */
async function tlsSink(): Promise<{ port: number; hellos: Buffer[]; close: () => void }> {
  const hellos: Buffer[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('data', (chunk) => {
      hellos.push(Buffer.from(chunk));
      socket.destroy();
    });
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  return {
    port: (server.address() as AddressInfo).port,
    hellos,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

for (const root of roots) rmSync(root, { recursive: true, force: true });

if (failures) {
  console.error(`\nFAIL: ${failures} web push test(s) failed`);
  process.exit(1);
}
console.log('\nPASS: web push encryption, VAPID, registration, content, responses, and broker wiring');
