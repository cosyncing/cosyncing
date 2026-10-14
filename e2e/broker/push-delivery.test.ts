/**
 * Push delivery: how attention reaches a phone or a browser that is not looking.
 *
 * Native apps register an APNs/FCM token and are woken through the provider relay
 * (`COSYNCING_WAKE_PUSH_WEBHOOK`, a fake here) with a content-free wake. Browsers register a Web
 * Push subscription and receive the notification itself, encrypted to them, over TLS from the
 * broker to their push service (a fake on 127.0.0.1 with a certificate the broker is made to trust).
 * Each test reads what a device would receive: the wake bodies, or the decrypted notifications.
 * Agent activity comes from a scripted Pi session; delivery retries are reached by moving the
 * broker's test clock.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Broker, type BrokerClient, eventually, startBroker } from '../harness/index.ts';
import { pairDevice } from '../harness/pairing.ts';
import { PiBridgeSession } from '../harness/fakes/pi-bridge-session.ts';
import {
  startWakeWebhook,
  startWebPushService,
  type WakeWebhook,
  WebPushSubscriber,
  type WebPushService,
} from '../harness/fakes/push-services.ts';
import { HOUR, MINUTE, TestClock } from '../harness/fakes/test-clock.ts';

const POSIX = process.platform !== 'win32';
const WAKE_WINDOW_MS = 2_000;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const clusters = (text: string): string[] => [...graphemes.segment(text)].map((part) => part.segment);

let broker: Broker;
let owner: BrokerClient;
let clock: TestClock;
let webhook: WakeWebhook;
let service: WebPushService;

beforeAll(async () => {
  webhook = startWakeWebhook();
  broker = await startBroker({
    name: 'push',
    token: true,
    env: (paths) => {
      clock = new TestClock(paths.root);
      service = startWebPushService(paths.root);
      return {
        ...clock.env,
        COSYNCING_WAKE_PUSH_WEBHOOK: webhook.url,
        COSYNCING_WAKE_PUSH_TIMEOUT_MS: '2000',
        COSYNCING_TEST_WAKE_COALESCE_WINDOW_MS: String(WAKE_WINDOW_MS),
        COSYNCING_WEB_PUSH_EXTRA_HOSTS: '127.0.0.1,*.push.example.test',
        NODE_EXTRA_CA_CERTS: service.caFile,
      };
    },
  });
  owner = broker.client();
});

afterAll(async () => {
  await broker?.stop();
  webhook?.stop();
  service?.stop();
});

const register = (body: Record<string, unknown>, client: BrokerClient = owner) => client.post('/api/push/wake-tokens', body);
const registrations = async (client: BrokerClient = owner): Promise<any[]> => {
  const response = await client.get('/api/push/wake-tokens');
  expect(response.status).toBe(200);
  return response.body.registrations;
};
const unregister = (deviceId: string, client: BrokerClient = owner) =>
  client.delete(`/api/push/wake-tokens/${encodeURIComponent(deviceId)}`);
const wakesFor = (token: string) => webhook.wakes.filter((wake) => wake.token === token);
const open = (name: string, title?: string) => PiBridgeSession.open(owner, broker.paths.root, name, { title });

async function registered(body: Record<string, unknown>, client: BrokerClient = owner): Promise<any> {
  const response = await register(body, client);
  expect(response.status).toBe(201);
  return response.body.registration;
}

/** The event a session raised, once it is in the feed. */
async function raisedEvent(session: PiBridgeSession, dedupeKey: string): Promise<any> {
  return eventually(async () => {
    const page = await owner.get('/api/attention-events?clientId=push-e2e&limit=200&after=0');
    let events = page.body.events as any[];
    let next = page.body;
    while (next.hasMore) {
      next = (await owner.get(`/api/attention-events?clientId=push-e2e&limit=200&after=${next.cursor}`)).body;
      events = events.concat(next.events);
    }
    return events.find((event) => event.dedupeKey === dedupeKey && event.sessionId === session.id);
  }, { what: `event ${dedupeKey}` });
}

/** The broker's record of delivering `eventId` to `deviceId`: the durable state it retries from. */
function delivery(deviceId: string, eventId: string): any {
  try {
    const store = JSON.parse(readFileSync(join(broker.paths.cosyncingHome, 'attention-events.json'), 'utf8'));
    return store.deliveries.find((item: any) => item.deviceId === deviceId && item.eventId === eventId);
  } catch {
    return undefined;
  }
}

/** Wait until the broker has recorded `attempts` failed attempts, so a clock move lands after them. */
const failuresRecorded = (deviceId: string, eventId: string, attempts: number) =>
  eventually(() => delivery(deviceId, eventId)?.attempts === attempts, { what: `${attempts} failed attempts recorded for ${deviceId}` });

/** Notifications `subscriber` received for one event. */
const notificationsFor = (subscriber: WebPushSubscriber, eventId: string) =>
  subscriber.notifications().filter((notification) => notification.eventId === eventId);

// ── Native apps: opaque wakes ──────────────────────────────────────────────

describe('native apps', () => {
  test('a burst of events wakes each phone at once and once more after the window, the trailing wake on its newest token', async () => {
    // First in the file: no event exists yet, so registering wakes nothing.
    await registered({ deviceId: 'burst-apns', platform: 'apns', token: 'apns-burst-token-0001' });
    await registered({ deviceId: 'burst-fcm', platform: 'fcm', token: 'fcm-burst-token-0001' });
    const pi = await open('burst');
    const secret = 'deploy secret-production';
    await pi.emit(...Array.from({ length: 5 }, (_, index) => ({
      t: 'permission-request', requestId: `burst-${index}`, title: `Run ${secret} ${index}`,
    })));

    await eventually(() => wakesFor('fcm-burst-token-0001').length === 1, { what: 'the leading wake' });
    // The phone refreshes its token while the window is open.
    await registered({ deviceId: 'burst-fcm', platform: 'fcm', token: 'fcm-burst-token-0002' });
    await eventually(() => wakesFor('fcm-burst-token-0002').length === 1, { what: 'the trailing wake on the new token' });
    await eventually(() => wakesFor('apns-burst-token-0001').length === 2, { what: 'the other phone\'s trailing wake' });
    expect(wakesFor('fcm-burst-token-0001')).toHaveLength(1);
    expect(wakesFor('apns-burst-token-0001')).toHaveLength(2);
    // A wake says nothing: no reason, session, event or prompt reaches the provider.
    for (const wake of webhook.wakes) {
      expect(Object.keys(wake).sort()).toEqual(['platform', 'token', 'type']);
      expect(wake.type).toBe('wake');
    }
    expect(JSON.stringify(webhook.wakes)).not.toContain('secret');
    await pi.emit(...Array.from({ length: 5 }, (_, index) => ({ t: 'permission-resolved', requestId: `burst-${index}`, decision: 'deny' })));
    await unregister('burst-apns');
    await unregister('burst-fcm');
  });

  test('a registered token is never shown again, and an unchanged registration is not rewritten', async () => {
    const created = await registered({ deviceId: 'phone-1', platform: 'apns', token: 'raw-secret-token-123456', label: 'Test phone' });
    expect(created).toMatchObject({ deviceId: 'phone-1', platform: 'apns', tokenPreview: 'raw-se...123456', label: 'Test phone' });
    const listed = await registrations();
    expect(listed.find((entry) => entry.deviceId === 'phone-1')).toEqual(created);
    expect(JSON.stringify(listed)).not.toContain('raw-secret-token-123456');

    const path = join(broker.paths.cosyncingHome, 'push-wake-tokens.json');
    const bytes = readFileSync(path, 'utf8');
    if (POSIX) expect(statSync(path).mode & 0o777).toBe(0o600);
    clock.advance(1_000);
    expect(await registered({ deviceId: 'phone-1', platform: 'apns', token: 'raw-secret-token-123456', label: 'Test phone' })).toEqual(created);
    expect(readFileSync(path, 'utf8')).toBe(bytes);

    for (const body of [
      { deviceId: 'phone-2', platform: 'apns' },
      { deviceId: 'phone-2', platform: 'sms', token: 'x' },
      { deviceId: 'not a token id', platform: 'fcm', token: 'x' },
      { deviceId: 'phone-2', platform: 'fcm', token: 'x'.repeat(4097) },
    ]) {
      const refused = await register(body);
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('BAD_PARAM');
    }
    expect((await unregister('phone-1')).body.revoked).toBe(true);
  });

  test('a manual wake carries nothing the caller sent, and a provider that hangs is cut off', async () => {
    await registered({ deviceId: 'manual', platform: 'fcm', token: 'fcm-manual-token-0001' });
    const wake = await owner.post('/api/push/wake', {
      deviceId: 'manual', reason: 'needs-input', sessionId: 'must-not-forward', prompt: 'must-not-forward',
    });
    expect(wake.status).toBe(202);
    expect(wake.body).toMatchObject({ ok: true, deviceId: 'manual', platform: 'fcm', provider: 'webhook' });
    const sent = await eventually(() => wakesFor('fcm-manual-token-0001').at(-1), { what: 'the manual wake' });
    expect(sent).toEqual({ platform: 'fcm', token: 'fcm-manual-token-0001', type: 'wake' });

    webhook.hang(true);
    try {
      const hung = await owner.post('/api/push/wake', { deviceId: 'manual' });
      expect(hung.status).toBe(502);
      expect(hung.body.code).toBe('PUSH_DELIVERY_FAILED');
      expect(hung.body.error).toMatch(/timed out/);
    } finally {
      webhook.hang(false);
    }
    expect((await owner.post('/api/push/wake', { deviceId: 'no-such-device' })).status).toBe(404);
    await unregister('manual');
  });

  test('paired devices see only their own registrations, and revoking one removes its devices and its pending wake', async () => {
    const peerA = await pairDevice(owner, { peerId: 'push-peer-a' });
    const peerB = await pairDevice(owner, { peerId: 'push-peer-b' });
    const a = owner.as({ kind: 'peer', peerToken: peerA.peerToken });
    const b = owner.as({ kind: 'peer', peerToken: peerB.peerToken });

    const ownA = await registered({ deviceId: 'phone', platform: 'fcm', token: 'fcm-peer-a-0001' }, a);
    const ownB = await registered({ deviceId: 'phone', platform: 'apns', token: 'apns-peer-b-0001' }, b);
    expect(ownA.deviceId).not.toBe('phone');
    expect(ownA.deviceId).not.toBe(ownB.deviceId);
    expect((await registrations(a)).map((entry) => entry.deviceId)).toEqual([ownA.deviceId]);
    expect((await registrations(b)).map((entry) => entry.deviceId)).toEqual([ownB.deviceId]);
    expect((await unregister(ownB.deviceId, a)).body.revoked).toBe(false);
    expect((await registrations()).map((entry) => entry.deviceId)).toEqual(expect.arrayContaining([ownA.deviceId, ownB.deviceId]));

    // A paired device must name its device, may hold four, and may change them thirty times a minute.
    expect((await register({ platform: 'fcm', token: 'fcm-unnamed' }, a)).status).toBe(400);
    for (const name of ['tablet', 'laptop', 'watch']) await registered({ deviceId: name, platform: 'fcm', token: `fcm-peer-a-${name}` }, a);
    const fifth = await register({ deviceId: 'fifth', platform: 'fcm', token: 'fcm-peer-a-fifth' }, a);
    expect(fifth.status).toBe(429);
    expect(await registrations(a)).toHaveLength(4);
    let accepted = 'apns-peer-b-0001';
    let limited = false;
    for (let attempt = 2; attempt <= 40 && !limited; attempt += 1) {
      const token = `apns-peer-b-${String(attempt).padStart(4, '0')}`;
      const response = await register({ deviceId: 'phone', platform: 'apns', token }, b);
      if (response.status === 429) limited = true;
      else {
        expect(response.status).toBe(201);
        accepted = token;
      }
    }
    expect(limited).toBe(true);
    expect((await registrations(b))[0].tokenPreview).toBe(`${accepted.slice(0, 6)}...${accepted.slice(-6)}`);

    // A's phone is woken by the pairing notices; an event right after waits out the window, and A
    // is revoked meanwhile.
    await eventually(() => wakesFor('fcm-peer-a-0001').length >= 1, { what: 'device A woken' });
    const pi = await open('peer-wake');
    await pi.turn('while-a-is-paired');
    expect((await owner.delete(`/api/transport/peers/${encodeURIComponent(peerA.peerId)}`)).status).toBe(200);
    expect((await registrations()).some((entry) => entry.deviceId === ownA.deviceId)).toBe(false);
    expect((await registrations()).some((entry) => entry.deviceId === ownB.deviceId)).toBe(true);
    const woken = wakesFor('fcm-peer-a-0001').length;
    // A phone registered now is woken at once and again a full window later, by which time any
    // wake A was waiting on has come due.
    await registered({ deviceId: 'sentinel', platform: 'fcm', token: 'fcm-revocation-sentinel' });
    await eventually(() => wakesFor('fcm-revocation-sentinel').length >= 2, { what: 'the sentinel phone woken twice' });
    expect(wakesFor('fcm-peer-a-0001')).toHaveLength(woken);
    await unregister('sentinel');
    await unregister(ownB.deviceId);
  });
});

// ── Browsers: Web Push ─────────────────────────────────────────────────────

describe('browsers', () => {
  let publicKey = '';

  test('the push key is made on first use, kept owner-only, and stays the same', async () => {
    const path = join(broker.paths.cosyncingHome, 'web-push-vapid.json');
    expect(existsSync(path)).toBe(false);
    const first = await owner.get('/api/push/web-push-key');
    expect(first.status).toBe(200);
    publicKey = first.body.publicKey;
    const raw = Buffer.from(publicKey, 'base64url');
    expect(raw).toHaveLength(65);
    expect(raw[0]).toBe(0x04);
    expect((await owner.get('/api/push/web-push-key')).body.publicKey).toBe(publicKey);
    expect(existsSync(path)).toBe(true);
    if (POSIX) expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('a subscription is accepted only on a push service or a configured host, over https, with sound keys', async () => {
    const keys = new WebPushSubscriber(service, 'keys').keys;
    // No presentation: such a browser shows nothing, so nothing is ever sent to these hosts.
    const attempt = (endpoint: string, subscriptionKeys: unknown = keys) =>
      register({ deviceId: 'allowlist', platform: 'webpush', subscription: { endpoint, keys: subscriptionKeys } });
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/abc',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
      'https://FCM.googleapis.com/fcm/send/abc',
      'https://a.push.example.test/abc',
      'https://127.0.0.1:9/abc',
    ]) {
      const response = await attempt(endpoint);
      expect([endpoint, response.status]).toEqual([endpoint, 201]);
    }
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'wss://fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com.evil.test/fcm/send/abc',
      'https://evil-fcm.googleapis.com/abc',
      'https://push.services.mozilla.com/abc',
      'https://evilpush.services.mozilla.com/abc',
      'https://notify.windows.com/abc',
      'https://web.push.apple.com.evil.test/abc',
      'https://fcm.googleapis.com./abc',
      'https://user:pw@fcm.googleapis.com/abc',
      'https://fcm.googleapis.com@evil.test/abc',
      'https://push.example.test/abc',
      'https://a.push.example.test.evil/abc',
      'http://127.0.0.1/abc',
      'https://127.0.0.2/abc',
      'not a url',
      '',
      `https://fcm.googleapis.com/${'a'.repeat(4096)}`,
    ]) {
      const response = await attempt(endpoint);
      expect([endpoint.slice(0, 60), response.status, response.body.code]).toEqual([endpoint.slice(0, 60), 400, 'BAD_PARAM']);
    }

    const browser = new WebPushSubscriber(service, 'key-checks');
    const point = Buffer.from(browser.keys.p256dh, 'base64url');
    const offCurve = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 1)]).toString('base64url');
    for (const [label, bad] of [
      ['missing keys', null],
      ['short p256dh', { p256dh: point.subarray(0, 64).toString('base64url'), auth: browser.keys.auth }],
      ['compressed p256dh', { p256dh: Buffer.concat([Buffer.from([0x02 | (point[64]! & 1)]), point.subarray(1, 33)]).toString('base64url'), auth: browser.keys.auth }],
      ['not uncompressed', { p256dh: Buffer.concat([Buffer.from([0x05]), point.subarray(1)]).toString('base64url'), auth: browser.keys.auth }],
      ['off-curve p256dh', { p256dh: offCurve, auth: browser.keys.auth }],
      ['standard base64', { p256dh: point.toString('base64').replace(/=+$/, '') + '+/', auth: browser.keys.auth }],
      ['auth 15 bytes', { p256dh: browser.keys.p256dh, auth: Buffer.alloc(15, 7).toString('base64url') }],
      ['auth 17 bytes', { p256dh: browser.keys.p256dh, auth: Buffer.alloc(17, 7).toString('base64url') }],
    ] as const) {
      const response = await attempt(browser.endpoint, bad);
      expect([label, response.status]).toEqual([label, 400]);
    }
    expect((await attempt(browser.endpoint, { p256dh: `${browser.keys.p256dh}=`, auth: `${browser.keys.auth}==` })).status).toBe(201);
    expect((await register({ deviceId: 'allowlist', platform: 'webpush', token: 'no-subscription' })).status).toBe(400);
    await unregister('allowlist');
  });

  test('a registration\'s titles and context are bounded, and nothing secret about it is ever shown back', async () => {
    const browser = new WebPushSubscriber(service, 'bounds');
    const base = browser.registration('bounds');
    for (const [label, extra] of [
      ['empty title', { presentation: { question: { title: '   ' } } }],
      ['missing title', { presentation: { question: {} } }],
      ['string typeOnly', { presentation: { question: { title: 'Q', typeOnly: 'yes' } } }],
      ['numeric silent', { presentation: { question: { title: 'Q', silent: 1 } } }],
      ['array presentation', { presentation: [] }],
      ['numeric context', { context: 7 }],
      ['oversize context', { context: 'c'.repeat(513) }],
    ] as const) {
      const response = await register({ ...base, ...(extra as object) });
      expect([label, response.status]).toEqual([label, 400]);
    }
    const context = '{"profile":"p-7","route":"/s/pi/abc"}';
    const created = await registered({
      ...base,
      token: 'must-not-be-stored',
      presentation: {
        question: { title: '  Question \n asked  ' },
        turn_finished: { title: 'Turn finished', typeOnly: true, silent: true },
        future_type: { title: 'From a newer client' },
      },
      context,
    });
    expect(created).toEqual({
      deviceId: 'bounds',
      platform: 'webpush',
      tokenPreview: service.origin,
      presentationTypes: ['question', 'turn_finished'],
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    });
    const listed = JSON.stringify(await registrations());
    for (const secret of [browser.path, browser.keys.p256dh, browser.keys.auth, context, 'Question', 'must-not-be-stored']) {
      expect(listed).not.toContain(secret);
    }
    expect(readFileSync(join(broker.paths.cosyncingHome, 'push-wake-tokens.json'), 'utf8')).not.toContain('must-not-be-stored');
    // A browser never takes an opaque wake.
    const opaque = await owner.post('/api/push/wake', { deviceId: 'bounds' });
    expect(opaque.status).toBe(400);
    expect(opaque.body.code).toBe('BAD_PARAM');
    await unregister('bounds');
  });

  test('a browser receives each notification it enabled, encrypted to it, over verified TLS, and nothing it did not', async () => {
    const all = new WebPushSubscriber(service, 'requests');
    const outcomes = new WebPushSubscriber(service, 'outcomes');
    const context = 'route:{"tab":"s1"} ✓';
    await registered(all.registration('browser-requests', {
      presentation: { permission_request: { title: '  Permission \n needed ' }, turn_finished: { title: 'Turn finished', silent: true } },
      context,
    }));
    await registered(outcomes.registration('browser-outcomes', { presentation: { turn_finished: { title: 'Done', typeOnly: true } } }));

    const family = '👨‍👩‍👧‍👦';
    const title = `${'修复登录'.repeat(6)}${family.repeat(10)}${'🇯🇵'.repeat(10)}é́${'字'.repeat(10)}`;
    const pi = await open('web-push', title);
    await pi.emit({ t: 'permission-request', requestId: 'deploy', title: 'Run deploy secret-production' });
    const request = await raisedEvent(pi, `permission-required:pi:${pi.id}:deploy`);
    await eventually(() => all.requests().length === 1, { what: 'the request notification' });

    const [sent] = all.requests();
    const [notification] = all.notifications();
    const kept = clusters(title).slice(0, 47).join('');
    expect(notification).toEqual({
      v: 1,
      eventId: request.id,
      revision: 1,
      type: 'permission_request',
      title: 'Permission needed',
      body: `${kept}…`,
      tag: request.dedupeKey,
      stage: 'immediate',
      action: { kind: 'open-session', tool: 'pi', sessionId: pi.id },
      context,
    });
    expect(clusters(notification.body)).toHaveLength(48);
    expect(JSON.stringify(notification)).not.toContain('secret');
    expect(sent!.body.byteLength).toBeLessThanOrEqual(4096);
    expect(sent!.headers.get('ttl')).toBe('86400');
    expect(sent!.headers.get('urgency')).toBe('high');
    expect(sent!.headers.get('content-encoding')).toBe('aes128gcm');
    expect(sent!.headers.get('content-type')).toBe('application/octet-stream');
    expect(sent!.headers.get('topic')).toMatch(/^[A-Za-z0-9_-]{32}$/);

    // VAPID (RFC 8292): an ES256 token for the push service's origin, verifiable with the served key.
    const authorization = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(sent!.headers.get('authorization') ?? '');
    expect(authorization).not.toBeNull();
    const [, jwtHeader, jwtClaims, jwtSignature, k] = authorization!;
    expect(k).toBe(publicKey);
    expect(JSON.parse(Buffer.from(jwtHeader!, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    const claims = JSON.parse(Buffer.from(jwtClaims!, 'base64url').toString());
    expect(claims.aud).toBe(service.origin);
    expect(claims.sub).toBe('https://cosyncing.com');
    expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
    expect(claims.exp).toBeLessThanOrEqual(Date.now() / 1000 + 12 * 3600 + 60);
    const key = await crypto.subtle.importKey('raw', new Uint8Array(Buffer.from(k!, 'base64url')), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new Uint8Array(Buffer.from(jwtSignature!, 'base64url')),
      new TextEncoder().encode(`${jwtHeader}.${jwtClaims}`),
    )).toBe(true);

    // The outcome reaches both; the request never reached the browser that did not enable it.
    await pi.turn('finished');
    const outcome = await raisedEvent(pi, `run-finished:pi:${pi.id}:finished`);
    await eventually(() => outcomes.requests().length === 1 && all.requests().length === 2, { what: 'the outcome notifications' });
    expect(outcomes.notifications()[0]).toMatchObject({ eventId: outcome.id, type: 'turn_finished', title: 'Done', body: '' });
    expect(all.notifications()[1]).toMatchObject({ eventId: outcome.id, type: 'turn_finished', silent: true, tag: `session-outcome:pi:${pi.id}` });
    expect(all.requests()[1]!.headers.get('ttl')).toBe('14400');
    expect(all.requests()[1]!.headers.get('urgency')).toBe('normal');
    await pi.emit({ t: 'permission-resolved', requestId: 'deploy', decision: 'deny' });
    await unregister('browser-requests');
    await unregister('browser-outcomes');
  });

  test('a push service\'s answer decides what follows: gone removes the browser, a refusal is final, busy is retried at 5 min, 30 min and 2 h, then never', async () => {
    const gone = new WebPushSubscriber(service, 'gone');
    const refused = new WebPushSubscriber(service, 'refused');
    const busy = new WebPushSubscriber(service, 'busy');
    const sentinel = new WebPushSubscriber(service, 'answers-sentinel');
    service.answer(gone.path, 410);
    service.answer(refused.path, 413);
    service.answer(busy.path, 429, 503, 500, 503);
    const presentation = { permission_request: { title: 'Permission' } };
    for (const [subscriber, id] of [[gone, 'gone'], [refused, 'refused'], [busy, 'busy'], [sentinel, 'answers-sentinel']] as const) {
      await registered(subscriber.registration(id, { presentation }));
    }

    const pi = await open('answers');
    await pi.emit({ t: 'permission-request', requestId: 'first', title: 'Approve' });
    const first = await raisedEvent(pi, `permission-required:pi:${pi.id}:first`);
    await eventually(() => gone.requests().length === 1 && refused.requests().length === 1 && busy.requests().length === 1,
      { what: 'every first attempt' });
    await eventually(async () => !(await registrations()).some((entry) => entry.deviceId === 'gone'), { what: 'the gone browser removed' });

    await failuresRecorded('busy', first.id, 1);
    for (const [step, attempts] of [[5 * MINUTE, 2], [30 * MINUTE, 3], [2 * HOUR, 4]] as const) {
      clock.advance(step);
      await eventually(() => notificationsFor(busy, first.id).length === attempts, { what: `attempt ${attempts}` });
      await failuresRecorded('busy', first.id, attempts);
    }
    clock.advance(12 * HOUR);
    // Two later events, each delivered to the sentinel browser after a full pass of the scheduler.
    for (const later of ['later-1', 'later-2']) {
      await pi.emit({ t: 'permission-request', requestId: later, title: 'Approve' });
      const event = await raisedEvent(pi, `permission-required:pi:${pi.id}:${later}`);
      await eventually(() => notificationsFor(sentinel, event.id).length === 1, { what: `the sentinel for ${later}` });
    }
    expect(notificationsFor(busy, first.id)).toHaveLength(4);
    expect(notificationsFor(refused, first.id)).toHaveLength(1);
    expect(gone.requests()).toHaveLength(1);
    await pi.emit(...['first', 'later-1', 'later-2'].map((requestId) => ({ t: 'permission-resolved', requestId, decision: 'deny' })));
    for (const id of ['refused', 'busy', 'answers-sentinel']) await unregister(id);
  });

  test('nothing stale is retried: not an answered request, nor one this browser read or dismissed', async () => {
    const browser = new WebPushSubscriber(service, 'stale');
    service.answer(browser.path, 503, 503, 503, 201);
    await registered(browser.registration('stale', { presentation: { permission_request: { title: 'Permission' } } }));
    const pi = await open('stale');
    await pi.emit(
      { t: 'permission-request', requestId: 'answered', title: 'A' },
      { t: 'permission-request', requestId: 'read', title: 'B' },
      { t: 'permission-request', requestId: 'dismissed', title: 'C' },
    );
    const answered = await raisedEvent(pi, `permission-required:pi:${pi.id}:answered`);
    const read = await raisedEvent(pi, `permission-required:pi:${pi.id}:read`);
    const dismissed = await raisedEvent(pi, `permission-required:pi:${pi.id}:dismissed`);
    for (const event of [answered, read, dismissed]) await failuresRecorded('stale', event.id, 1);

    await pi.emit({ t: 'permission-resolved', requestId: 'answered', decision: 'approve' });
    await eventually(async () => (await raisedEvent(pi, answered.dedupeKey)).state === 'resolved', { what: 'the answer' });
    expect((await owner.post(`/api/attention-events/${read.id}/ack`, { clientId: 'stale' })).status).toBe(200);
    expect((await owner.post(`/api/attention-events/${dismissed.id}/dismiss`, { clientId: 'stale' })).status).toBe(200);

    clock.advance(5 * MINUTE);
    for (const later of ['later-1', 'later-2']) {
      await pi.emit({ t: 'permission-request', requestId: later, title: 'D' });
      const event = await raisedEvent(pi, `permission-required:pi:${pi.id}:${later}`);
      await eventually(() => notificationsFor(browser, event.id).length === 1, { what: `the browser's ${later}` });
    }
    for (const event of [answered, read, dismissed]) expect(notificationsFor(browser, event.id)).toHaveLength(1);
    await pi.emit(...['read', 'dismissed', 'later-1', 'later-2'].map((requestId) => ({ t: 'permission-resolved', requestId, decision: 'deny' })));
    await unregister('stale');
  });

  test('a browser registered after an event is never alerted to it, while a phone registered late still is', async () => {
    const pi = await open('late');
    await pi.emit({ t: 'permission-request', requestId: 'before', title: 'Before' });
    const before = await raisedEvent(pi, `permission-required:pi:${pi.id}:before`);
    clock.advance(1_000);
    const browser = new WebPushSubscriber(service, 'late');
    await registered(browser.registration('late-browser', { presentation: { permission_request: { title: 'Permission' } } }));
    await registered({ deviceId: 'late-phone', platform: 'fcm', token: 'fcm-late-phone-0001' });
    await eventually(() => wakesFor('fcm-late-phone-0001').length >= 1, { what: 'the late phone caught up' });
    await unregister('late-phone');

    await pi.emit({ t: 'permission-request', requestId: 'after', title: 'After' });
    const after = await raisedEvent(pi, `permission-required:pi:${pi.id}:after`);
    await eventually(() => browser.requests().length >= 1, { what: 'the new alert' });
    expect(browser.notifications().map((notification) => notification.eventId)).toEqual([after.id]);
    expect(notificationsFor(browser, before.id)).toEqual([]);
    await pi.emit(...['before', 'after'].map((requestId) => ({ t: 'permission-resolved', requestId, decision: 'deny' })));
    await unregister('late-browser');
  });

  test('a browser that re-subscribed while its old endpoint was reported gone keeps the new subscription', async () => {
    const old = new WebPushSubscriber(service, 'resubscribe-old');
    const fresh = new WebPushSubscriber(service, 'resubscribe-new');
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    service.answer(old.path, async () => {
      await held;
      return new Response('push subscription has unsubscribed or expired', { status: 410 });
    });
    const presentation = { permission_request: { title: 'Permission' } };
    await registered(old.registration('resubscribe', { presentation }));
    const pi = await open('resubscribe');
    await pi.emit({ t: 'permission-request', requestId: 'one', title: 'One' });
    await eventually(() => old.requests().length === 1, { what: 'the push to the old endpoint' });

    await registered(fresh.registration('resubscribe', { presentation }));
    release();
    await pi.emit({ t: 'permission-request', requestId: 'two', title: 'Two' });
    const two = await raisedEvent(pi, `permission-required:pi:${pi.id}:two`);
    await eventually(() => notificationsFor(fresh, two.id).length === 1, { what: 'the push to the new endpoint' });
    expect((await registrations()).some((entry) => entry.deviceId === 'resubscribe')).toBe(true);
    await pi.emit(...['one', 'two'].map((requestId) => ({ t: 'permission-resolved', requestId, decision: 'deny' })));
    await unregister('resubscribe');
  });

  test('the push key survives a restart', async () => {
    await broker.restart();
    expect((await owner.get('/api/push/web-push-key')).body.publicKey).toBe(publicKey);
  });
});

// ── A phone's held wake and everyone else's alerts ─────────────────────────

describe('a phone wake held back by its window', () => {
  let held: Broker;
  beforeAll(async () => {
    held = await startBroker({
      name: 'push-held',
      env: {
        COSYNCING_WAKE_PUSH_WEBHOOK: webhook.url,
        // Ten minutes: a held wake that anything else waits on cannot come due inside the test.
        COSYNCING_TEST_WAKE_COALESCE_WINDOW_MS: String(10 * MINUTE),
        COSYNCING_WEB_PUSH_EXTRA_HOSTS: '127.0.0.1',
        NODE_EXTRA_CA_CERTS: service.caFile,
      },
    });
  });
  afterAll(() => held?.stop());

  // KNOWN DEFECT (reported, not fixed): a scheduler pass awaits every dispatch it starts, a phone's
  // coalesced trailing wake included, and passes run one at a time. So once a phone's wake is held
  // for its window (30 s in production), every later alert, to a browser or another phone, waits
  // for that window. `test.failing` passes while the defect stands; make it `test` once fixed.
  test.failing('a browser is alerted to a new event while a phone\'s wake is held back', async () => {
    const client = held.client();
    const browser = new WebPushSubscriber(service, 'held');
    expect((await register({ deviceId: 'held-phone', platform: 'fcm', token: 'fcm-held-0001' }, client)).status).toBe(201);
    expect((await register(browser.registration('held-browser', { presentation: { permission_request: { title: 'Permission' } } }), client)).status).toBe(201);
    const pi = await PiBridgeSession.open(client, held.paths.root, 'held');
    const alerted = (requestId: string) => eventually(
      () => browser.notifications().find((notification) => notification.tag === `permission-required:pi:${pi.id}:${requestId}`),
      // The phone's wake is held for ten minutes; this only has to tell "promptly" from "after it".
      { what: `the browser alerted to ${requestId}`, timeoutMs: 5_000 },
    );

    await pi.emit({ t: 'permission-request', requestId: 'one', title: 'One' });
    await alerted('one');
    await eventually(() => wakesFor('fcm-held-0001').length === 1, { what: 'the phone\'s leading wake' });
    // The phone is inside its window now: its wake for "two" is held, the browser's alert is not.
    await pi.emit({ t: 'permission-request', requestId: 'two', title: 'Two' });
    await alerted('two');
    await pi.emit({ t: 'permission-request', requestId: 'three', title: 'Three' });
    await alerted('three');
  });
});

// ── What an older or damaged broker left behind ────────────────────────────

describe('stored push state', () => {
  let stored: Broker;
  const corruptKey = 'not json at all';
  beforeAll(async () => {
    stored = await startBroker({
      name: 'push-stored',
      token: true,
      env: { COSYNCING_WEB_PUSH_EXTRA_HOSTS: '127.0.0.1' },
      setup: (paths) => {
        writeFileSync(join(paths.cosyncingHome, 'push-wake-tokens.json'), JSON.stringify({
          version: 1,
          registrations: [{
            deviceId: 'ownerless-phone', platform: 'fcm', token: 'legacy-token',
            createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
          }],
        }), { mode: 0o600 });
        writeFileSync(join(paths.cosyncingHome, 'web-push-vapid.json'), corruptKey, { mode: 0o600 });
      },
    });
  });
  afterAll(() => stored?.stop());

  test('registrations an older broker kept without an owner are dropped before anything is sent', async () => {
    expect(await registrations(stored.client())).toEqual([]);
    expect(JSON.parse(readFileSync(join(stored.paths.cosyncingHome, 'push-wake-tokens.json'), 'utf8')))
      .toEqual({ version: 2, registrations: [] });
  });

  test('a corrupt push key is moved aside with its bytes and reported, and a new key is served', async () => {
    const served = await stored.client().get('/api/push/web-push-key');
    expect(served.status).toBe(200);
    const aside = readdirSync(stored.paths.cosyncingHome).filter((name) => name.startsWith('web-push-vapid.json.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(stored.paths.cosyncingHome, aside[0]!), 'utf8')).toBe(corruptKey);
    expect(stored.output()).toMatch(/moved aside .* subscribe again/);
    const file = JSON.parse(readFileSync(join(stored.paths.cosyncingHome, 'web-push-vapid.json'), 'utf8'));
    expect(file.publicKey).toBe(served.body.publicKey);
  });

  test('after a restart, only registrations still allowed load; a loosened key file is tightened, not replaced', async () => {
    const key = (await stored.client().get('/api/push/web-push-key')).body.publicKey;
    const keys = new WebPushSubscriber({ origin: 'https://127.0.0.1:9' } as WebPushService, 'stored').keys;
    await stored.stop({ keepState: true });
    writeFileSync(join(stored.paths.cosyncingHome, 'push-wake-tokens.json'), JSON.stringify({
      version: 2,
      registrations: [
        { deviceId: 'phone', owner: { kind: 'owner' }, platform: 'fcm', token: 'fcm-token', createdAt: 'c', updatedAt: 'u' },
        { deviceId: 'web-ok', owner: { kind: 'owner' }, platform: 'webpush', token: '', subscription: { endpoint: 'https://127.0.0.1:9/x', keys }, createdAt: 'c', updatedAt: 'u' },
        { deviceId: 'web-foreign', owner: { kind: 'owner' }, platform: 'webpush', token: '', subscription: { endpoint: 'https://push.example.test/x', keys }, createdAt: 'c', updatedAt: 'u' },
        { deviceId: 'web-no-subscription', owner: { kind: 'owner' }, platform: 'webpush', token: 'x', createdAt: 'c', updatedAt: 'u' },
      ],
    }), { mode: 0o600 });
    const vapid = join(stored.paths.cosyncingHome, 'web-push-vapid.json');
    if (POSIX) chmodSync(vapid, 0o644);
    await stored.start();

    expect((await registrations(stored.client())).map((entry) => entry.deviceId).sort()).toEqual(['phone', 'web-ok']);
    expect((await stored.client().get('/api/push/web-push-key')).body.publicKey).toBe(key);
    if (POSIX) {
      expect(statSync(vapid).mode & 0o777).toBe(0o600);
      expect(stored.output()).toMatch(/readable by other users/);
    }
  });

  test('the device limit refuses a new registration with 429 and never evicts one', async () => {
    const client = stored.client();
    let count = (await registrations(client)).length;
    let refused: any;
    while (!refused) {
      const response = await register({ deviceId: `fill-${count}`, platform: 'fcm', token: `fcm-fill-${count}` }, client);
      if (response.status === 429) refused = response;
      else {
        expect(response.status).toBe(201);
        count += 1;
      }
      expect(count).toBeLessThanOrEqual(256);
    }
    expect(count).toBe(256);
    const listed = await registrations(client);
    expect(listed).toHaveLength(256);
    expect(listed.map((entry) => entry.deviceId)).toContain('phone');
  });
});
