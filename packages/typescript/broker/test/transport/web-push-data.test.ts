/**
 * Web Push as data: the RFC 8291 test vector, what a notification for each kind of event shows, and
 * the headers each type is sent with.
 *
 * `e2e/broker/push-delivery.test.ts` decrypts what a real broker sends to a fake push service. What stays here
 * is pure: the RFC's own bytes, grapheme-exact truncation of CJK and emoji, the payload bound, the
 * per-type TTL and Urgency, and the skip rules for stages only an older broker could have stored.
 */
import { describe, expect, test } from 'bun:test';
import { createDecipheriv, createECDH, createHmac, randomBytes, type ECDH } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttentionEvent } from '@cosyncing/protocol';
import { ATTENTION_NOTIFICATION_TYPES } from '../../src/attention/attention-notification-type.ts';
import {
  encryptWebPushPayload,
  planWebPushNotification,
  sendWebPush,
  truncateWebPushText,
  WEB_PUSH_PAYLOAD_MAX_BYTES,
  WebPushVapidKeyStore,
  webPushTopic,
  type WebPushSkipReason,
} from '../../src/transport/web-push.ts';

const b64 = (value: string): Buffer => Buffer.from(value.replace(/\s+/g, ''), 'base64url');
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const clusters = (text: string): string[] => [...graphemes.segment(text)].map((part) => part.segment);
const H = 3_600_000;

// RFC 8291 §5 and Appendix A, copied from the RFC text.
const RFC8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
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

/** A browser's side of a subscription. */
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
  expect(bytes.readUInt32BE(16)).toBe(4096);
  const idlen = bytes[20]!;
  expect(idlen).toBe(65);
  const senderPublic = bytes.subarray(21, 21 + idlen);
  const record = bytes.subarray(21 + idlen);
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
  expect(padded[end]).toBe(0x02);
  return padded.subarray(0, end);
}

const PRESENT_ALL = Object.fromEntries(ATTENTION_NOTIFICATION_TYPES.map((type) => [type, { title: `title:${type}` }]));

function attentionEvent(overrides: Partial<AttentionEvent> = {}): AttentionEvent {
  return {
    id: 'event-1', cursor: 1, revision: 1, presentationRevision: 1, presentationStage: 'immediate',
    kind: 'run-finished', state: 'resolved', severity: 'informational', dedupeKey: 'run-finished:claude:s1:t1',
    createdAt: 1, updatedAt: 1, agent: 'claude', sessionId: 's1', sessionTitle: 'Fix the login bug',
    title: 'Agent run finished', action: { kind: 'open-session', tool: 'claude', sessionId: 's1' },
    ...overrides,
  };
}

const plan = (input: Partial<Parameters<typeof planWebPushNotification>[0]> = {}) =>
  planWebPushNotification({ event: attentionEvent(), stage: 'immediate', presentation: PRESENT_ALL, ...input });

function payloadOf(result: ReturnType<typeof planWebPushNotification>) {
  if (!('notification' in result)) throw new Error(`expected a notification, got ${JSON.stringify(result)}`);
  return result.notification.payload;
}

describe('RFC 8291', () => {
  test('Appendix A: the example keys and salt produce the RFC message byte for byte', () => {
    const message = encryptWebPushPayload({
      plaintext: Buffer.from(RFC8291.plaintext),
      uaPublicKey: b64(RFC8291.uaPublic),
      authSecret: b64(RFC8291.auth),
      senderPrivateKey: b64(RFC8291.asPrivate),
      salt: b64(RFC8291.salt),
    });
    // §5 prints `Content-Length: 145`, but the body it shows is 144 octets: the 86-octet header plus
    // 41 plaintext octets, the delimiter and the 16-octet tag. The bytes are what is checked.
    expect(message.length).toBe(86 + 41 + 1 + 16);
    const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
    const rfc = (value: string) => value.replace(/\s+/g, '');
    expect(text(message.subarray(0, 86))).toBe(rfc(RFC8291.header));
    expect(text(message.subarray(86))).toBe(rfc(RFC8291.ciphertext));
    expect(text(message)).toBe(rfc(RFC8291.message));
    expect(text(message.subarray(21, 86))).toBe(RFC8291.asPublic);
    const receiver = createECDH('prime256v1');
    receiver.setPrivateKey(b64(RFC8291.uaPrivate));
    expect(decryptAsUserAgent(message, receiver, b64(RFC8291.auth)).toString()).toBe(RFC8291.plaintext);
  });

  test('every message draws a fresh key and salt, only its browser can read it, and one record is the limit', () => {
    const ua = userAgent();
    const plaintext = Buffer.from(JSON.stringify({ v: 1, title: '権限の確認 🔐', body: 'x'.repeat(2000) }));
    const encrypt = () => encryptWebPushPayload({ plaintext, uaPublicKey: b64(ua.keys.p256dh), authSecret: b64(ua.keys.auth) });
    const first = encrypt();
    const second = encrypt();
    const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
    expect(text(decryptAsUserAgent(first, ua.ecdh, b64(ua.keys.auth)))).toBe(text(plaintext));
    expect(text(decryptAsUserAgent(second, ua.ecdh, b64(ua.keys.auth)))).toBe(text(plaintext));
    expect(text(first.subarray(0, 16))).not.toBe(text(second.subarray(0, 16)));
    expect(text(first.subarray(21, 86))).not.toBe(text(second.subarray(21, 86)));
    expect(() => decryptAsUserAgent(first, userAgent().ecdh, b64(ua.keys.auth))).toThrow();
    expect(() => encryptWebPushPayload({ plaintext: Buffer.alloc(4096 - 16), uaPublicKey: b64(ua.keys.p256dh), authSecret: b64(ua.keys.auth) }))
      .toThrow(/one record/);
  });
});

describe('what a notification shows', () => {
  test('skip rules: gone, over, silent, not presented, read, seen before a reminder, or raised before the browser registered', () => {
    const request = attentionEvent({ kind: 'permission-required', state: 'active', dedupeKey: 'permission:r1' });
    const seen = { ...request, seenAt: 9 };
    const runtime = attentionEvent({ kind: 'runtime-update-ready', state: 'active', severity: 'maintenance', dedupeKey: 'runtime:r1' });
    const health = attentionEvent({ kind: 'broker-health', state: 'active', severity: 'action-required', dedupeKey: 'health:r1' });
    const skips: Array<[string, Parameters<typeof plan>[0], WebPushSkipReason]> = [
      ['a missing event', { event: undefined }, 'event-missing'],
      ['an answered request', { event: { ...request, state: 'resolved' } }, 'event-resolved'],
      ['a resolved runtime update', { event: attentionEvent({ kind: 'runtime-update-ready', state: 'resolved' }) }, 'event-resolved'],
      ['a resolved scheduled send', { event: attentionEvent({ kind: 'scheduled-send', state: 'resolved' }) }, 'event-resolved'],
      ['a scheduled send', { event: attentionEvent({ kind: 'scheduled-send', state: 'active' }) }, 'not-a-notification'],
      ['maintenance health', { event: attentionEvent({ kind: 'broker-health', state: 'active', severity: 'maintenance' }) }, 'not-a-notification'],
      ['sync degraded', { event: attentionEvent({ kind: 'sync-degraded', state: 'active' }) }, 'not-a-notification'],
      ['a type not presented', { presentation: { question: { title: 'Q' } } }, 'type-not-presented'],
      ['no presentation', { presentation: undefined }, 'type-not-presented'],
      ['read on this device', { deviceState: { readAt: 5 } }, 'device-read'],
      ['dismissed on this device', { deviceState: { dismissedAt: 5 } }, 'device-read'],
      ['a reminder already seen', { event: seen, stage: '15m' }, 'seen-before-reminder'],
      ['a later reminder already seen', { event: seen, stage: '7h' }, 'seen-before-reminder'],
      ['an alert from before the registration', { registeredAt: 2 }, 'before-registration'],
      ['a runtime alert from before the registration', { event: runtime, stage: '2h', registeredAt: 2 + 2 * H }, 'before-registration'],
      ['an escalation from before the registration', { event: health, stage: `health-${5 * H}`, registeredAt: 6 * H }, 'before-registration'],
      // Stages an older broker stored before its reminders were removed: an upgrade must not replay
      // them to every browser that registers afterwards.
      ['an older broker\'s 517 h stage', { event: request, stage: '517h', registeredAt: 1 + 518 * H }, 'before-registration'],
      ['an older broker\'s 15 m stage', { event: request, stage: '15m', registeredAt: 1 + H }, 'before-registration'],
      ['an id that cannot fit the payload', { event: attentionEvent({ id: 'e'.repeat(WEB_PUSH_PAYLOAD_MAX_BYTES) }) }, 'payload-too-large'],
    ];
    for (const [what, input, skip] of skips) expect({ what, result: plan(input) }).toEqual({ what, result: { skip } });

    const sends: Array<[string, Parameters<typeof plan>[0]]> = [
      ['an open request', { event: request }],
      ['an empty device state', { deviceState: {} }],
      ['an alert from the same instant as the registration', { registeredAt: 1 }],
      ['an unreadable registration time', { registeredAt: Number.NaN }],
      ['a runtime alert after the registration', { event: runtime, stage: '2h', registeredAt: 1 + H }],
      ['an escalation after the registration', { event: health, stage: `health-${5 * H}`, registeredAt: 4 * H }],
      ['a stored later stage raised after the registration', { event: request, stage: '15m', registeredAt: 2 }],
      ['a stage this broker cannot place', { event: request, stage: 'unknown-stage', registeredAt: 1 + H }],
      ['a first alert that raced a read', { event: seen, stage: 'immediate' }],
      ['an unseen reminder', { event: request, stage: '15m' }],
      ...['run-finished', 'goal-finished', 'run-failed', 'device-paired', 'security-alert', 'scheduled-send-failed'].map((kind) =>
        [`${kind}, born resolved`, { event: attentionEvent({ kind, state: 'resolved', severity: 'action-required' }) }] as [string, Parameters<typeof plan>[0]]),
    ];
    for (const [what, input] of sends) expect({ what, sent: 'notification' in plan(input) }).toEqual({ what, sent: true });
    expect(payloadOf(plan({ event: health })).type).toBe('server_problem');
  });

  test('body and tag: whitespace collapses, an event outside a session shows its title, tags fall back to the event', () => {
    const request = payloadOf(plan({
      event: attentionEvent({ kind: 'permission-required', state: 'active', dedupeKey: 'permission-required:claude:s1:r9', sessionTitle: '  Deploy \n\t staging  ' }),
      stage: '1h',
    }));
    expect([request.tag, request.body, request.stage]).toEqual(['permission-required:claude:s1:r9', 'Deploy staging', '1h']);
    const realerted = payloadOf(plan({ event: attentionEvent({ kind: 'permission-required', state: 'active', presentationRevision: 4 }), stage: '7h' }));
    expect([realerted.eventId, realerted.revision, realerted.stage]).toEqual(['event-1', 4, '7h']);

    const paired = payloadOf(plan({
      event: attentionEvent({
        kind: 'device-paired', agent: undefined, sessionId: undefined, sessionTitle: 'ignored', title: 'New device paired',
        dedupeKey: 'device-paired:p1:5', action: { kind: 'open-attention-inbox' },
      }),
    }));
    expect([paired.body, paired.action]).toEqual(['New device paired', { kind: 'open-attention-inbox' }]);
    expect(payloadOf(plan({ event: attentionEvent({ dedupeKey: '  ' }) })).tag).toBe('session-outcome:claude:s1');
    expect(payloadOf(plan({ event: attentionEvent({ kind: 'device-paired', dedupeKey: ' ', action: { kind: 'open-attention-inbox' } }) })).tag)
      .toBe('event:event-1');
    expect(payloadOf(plan({ event: attentionEvent({ sessionTitle: undefined }) })).body).toBe('');
  });

  test('the body is 48 whole grapheme clusters with an ellipsis, never splitting CJK, emoji or combining marks', () => {
    const title = `${'修复登录'.repeat(6)}${'👨‍👩‍👧‍👦'.repeat(10)}${'🇯🇵'.repeat(10)}é́${'字'.repeat(10)}`;
    const body = payloadOf(plan({ event: attentionEvent({ sessionTitle: title }) })).body;
    const kept = clusters(body);
    expect(kept).toHaveLength(48);
    expect(kept.at(-1)).toBe('…');
    expect(kept.slice(0, 47)).toEqual(clusters(title).slice(0, 47));
    expect(body.isWellFormed()).toBe(true);
    expect(truncateWebPushText('字'.repeat(48))).toBe('字'.repeat(48));
    expect(truncateWebPushText(`${'字'.repeat(46)}   ${'x'.repeat(5)}`)).toBe(`${'字'.repeat(46)}…`);
    expect(clusters(truncateWebPushText('字'.repeat(49)))).toHaveLength(48);
  });

  test('an unbounded grapheme drops the body, never the notification, and the payload stays within its bound', () => {
    const payload = payloadOf(plan({ event: attentionEvent({ sessionTitle: `Z${'́'.repeat(4000)}` }) }));
    expect(payload.body).toBe('');
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(WEB_PUSH_PAYLOAD_MAX_BYTES);
  });
});

test('headers: TTL by type family, Urgency for urgent types, a stable 32-character Topic keyed per subscription', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-web-push-headers-'));
  try {
    const vapid = new WebPushVapidKeyStore(home, { warn: () => {} });
    const ua = userAgent();
    const endpoint = 'https://fcm.googleapis.com/fcm/send/capability-path-0123456789';
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
      const result = plan({ event: attentionEvent(overrides) });
      if (!('notification' in result)) throw new Error(`${overrides.kind} is not a notification`);
      const calls: RequestInit[] = [];
      const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push(init ?? {});
        return new Response(null, { status: 201 });
      }) as typeof globalThis.fetch;
      expect(await sendWebPush({ endpoint, keys: ua.keys }, result.notification, { vapid, fetch })).toEqual({ kind: 'sent', status: 201 });
      const headers = new Headers(calls[0]!.headers);
      expect({ kind: overrides.kind, ttl: headers.get('ttl'), urgency: headers.get('urgency'), redirect: calls[0]!.redirect })
        .toEqual({ kind: overrides.kind, ttl: String(ttl), urgency, redirect: 'manual' });
      expect(headers.get('topic')).toBe(webPushTopic(result.notification.payload.tag, ua.keys.auth));
      expect(JSON.parse(decryptAsUserAgent(calls[0]!.body as Uint8Array, ua.ecdh, b64(ua.keys.auth)).toString())).toEqual(result.notification.payload);
    }
    const topic = webPushTopic('session-outcome:claude:s1', ua.keys.auth);
    expect(topic).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(webPushTopic('session-outcome:claude:s1', ua.keys.auth)).toBe(topic);
    expect(webPushTopic('session-outcome:claude:s2', ua.keys.auth)).not.toBe(topic);
    expect(webPushTopic('session-outcome:claude:s1', userAgent().keys.auth)).not.toBe(topic);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
