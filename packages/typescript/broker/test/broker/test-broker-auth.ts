#!/usr/bin/env bun
/**
 * Broker auth model (default-deny on data-bearing APIs) — deterministic, no real agents.
 *
 * When COSYNCING_TOKEN is set (required for any non-loopback bind), EVERY mutating route (POST/PATCH/DELETE)
 * must require the token. Only minimal health and pairing acceptance stay public. WebSocket
 * upgrades use a short-lived ticket issued over authenticated HTTP; long-lived query credentials are refused.
 *
 *   bun run packages/typescript/broker/test/broker/test-broker-auth.ts
 */
export {};
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, createServer, type Socket } from 'node:net';
import { WsAuthTicketRegistry } from '../../src/security/ws-auth-tickets.ts';
import { defaultBrokerConfig, writeBrokerConfig } from '../../src/runtime/configuration.ts';
import { tokenHash } from '../../src/transport/transport-pairing.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

async function spawnBroker(
  port: number,
  env: Record<string, string>,
  prepare?: (home: string) => void,
) {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-auth-'));
  prepare?.(home);
  const broker = Bun.spawn(['bun', 'packages/typescript/broker/src/main.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      COSYNCING_MACHINE: 'auth-test',
      COSYNCING_DEV_MODE: '1', // source-only Claude hook contract; packaged builds expose no hook routes
      COSYNCING_HOME: home,
      COSYNCING_TOKEN_FILE: '',
      COSYNCING_RESTART_DRY_RUN: '1', // never actually relaunch during the test
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1', // don't spawn a managed opencode serve
      COSYNCING_CODEX_SYNC_SERVER: '0', // never inherit a developer daemon/socket
      COSYNCING_CODEX_APP_SERVER_SOCK: '',
      COSYNCING_CODEX_REMOTE_ADDR: '',
      ...env,
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try { up = (await fetch(`${base}/api/health`)).ok; } catch {}
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  return { broker, base, home, up };
}
const status = async (base: string, path: string, init?: RequestInit): Promise<number> => {
  try { return (await fetch(`${base}${path}`, init)).status; } catch { return -1; }
};

async function loopbackForwarder(targetPort: number): Promise<{ base: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect({ host: '127.0.0.1', port: targetPort });
    sockets.add(client);
    sockets.add(upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => sockets.delete(client));
    upstream.on('close', () => sockets.delete(upstream));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('forwarder did not obtain a port');
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

async function wsTicket(base: string, token: string, tool: string, sessionId: string, params: Record<string, string>) {
  const response = await fetch(`${base}/api/ws-auth-tickets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cosyncing-token': token },
    body: JSON.stringify({ tool, sessionId, params }),
  });
  const body = await response.json().catch(() => ({})) as any;
  return { status: response.status, ticket: String(body.wsAuthTicket ?? '') };
}

const TOKEN = 'auth-test-secret';
const PEER_TOKEN = 'paired-device-token-0123456789abcdefghijklmnop';
const PI_CREDENTIAL = 'pi-route-only-credential-0123456789abcdefghijklmno';
const withTok: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json', 'x-cosyncing-token': TOKEN }, body: '{}' };
const noTok = (method = 'POST'): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: method === 'DELETE' ? undefined : '{}' });

{
  let now = 1_000;
  const tickets = new WsAuthTicketRegistry({ now: () => now, ttlMs: 10 });
  const binding = {
    tool: 'codex',
    sessionId: 'session-a',
    params: { mode: 'resume' },
    identity: 'fixture',
    uploadIdentity: 'fixture',
    credentialAuthenticated: true,
    principal: { kind: 'owner' as const, credentialId: 'fixture-owner' },
  };
  const wrongRoute = tickets.issue(binding).wsAuthTicket;
  check('WebSocket ticket is bound to one tool and session',
    tickets.consume(wrongRoute, 'codex', 'session-b') === undefined
      && tickets.consume(wrongRoute, 'codex', 'session-a') === undefined);
  const expired = tickets.issue(binding).wsAuthTicket;
  now += 11;
  check('WebSocket ticket expires before upgrade',
    tickets.consume(expired, 'codex', 'session-a') === undefined);
  const peerTicket = tickets.issue({
    ...binding,
    principal: {
      kind: 'peer',
      peerId: 'peer-a',
      authGeneration: 1,
      roles: ['observe', 'drive', 'files'],
    },
  }).wsAuthTicket;
  check('peer revocation invalidates every unused WebSocket ticket',
    tickets.invalidatePeer('peer-a') === 1
      && tickets.consume(peerTicket, 'codex', 'session-a') === undefined);
}

// Mutating routes that MUST be gated when a token is set (one representative per class the review flagged).
const MUTATING: [string, RequestInit][] = [
  ['/api/broker/restart', noTok()],
  ['/api/broker/restart-all', noTok()],
  ['/api/agents/codex/sync', noTok()],
  ['/api/agent-runtime-update-policy', noTok()],
  ['/api/agent-runtime-updates/codex/restart', noTok()],
  ['/api/tool/send_file', noTok()],
  ['/pi/bridge/hello', noTok()],
  ['/claude/hook/request', noTok()],
  ['/api/projects/rename', { ...noTok(), method: 'PATCH' }],
  ['/api/sessions/codex', noTok()], // createSession spawns a process — must be gated
  ['/api/attention-events/missing/ack', noTok()],
  ['/api/attention-events/missing/dismiss', noTok()],
  ['/api/attention-events/dismiss-batch', noTok()],
  ['/api/tokdash/quota-preference', noTok()],
  ['/api/schedules', noTok()],
  ['/api/schedules/missing', noTok('DELETE')],
  ['/api/schedules/missing', { ...noTok(), method: 'PATCH' }],
  ['/api/schedules/missing/actions', noTok()],
];

const SENSITIVE_GETS = [
  '/api/sessions/opencode/missing-session/fs',
  '/api/sessions/opencode/missing-session/fs/read?path=a.txt',
  '/api/sessions/opencode/missing-session/fs/download?path=a.txt',
  '/api/attention-events?clientId=auth-test',
  '/api/broker/health',
  '/api/tokdash/quota',
  '/api/tokdash/quota-preference',
  '/api/schedules', // carries complete future prompt text
  '/api/schedules/missing', // every schedule subroute is prompt-bearing/future-compatible
];

let piCredentialFile = '';
const tokened = await spawnBroker(7796, { COSYNCING_TOKEN: TOKEN }, (home) => {
  const secrets = join(home, 'secrets');
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  piCredentialFile = join(secrets, 'pi-integration.json');
  writeFileSync(piCredentialFile, JSON.stringify({
    schemaVersion: 1,
    kind: 'pi-bridge',
    internalUrl: 'http://127.0.0.1:7796',
    credential: PI_CREDENTIAL,
  }), { mode: 0o600 });
  chmodSync(piCredentialFile, 0o600);
  process.env.COSYNCING_PI_INTEGRATION_FILE = piCredentialFile;
  writeFileSync(join(home, 'transport-peers.json'), JSON.stringify({
    version: 2,
    peers: [{
      peerId: 'peer-auth-test',
      identityPublicKey: 'fixture-identity-key',
      peerTokenHash: tokenHash('fixture-client-mailbox-token'),
      brokerPeerId: 'broker_auth_test',
      brokerPeerTokenHash: tokenHash(PEER_TOKEN),
      brokerIdentityPublicKey: 'fixture-broker-key',
      dataKey: { algorithm: 'AES-256-GCM', bytes: '' },
      wrappedDataKey: {},
      acceptedAt: new Date(0).toISOString(),
      authGeneration: 1,
      roles: ['observe', 'drive', 'files'],
      securityRevision: 17,
    }],
  }), { mode: 0o600 });
});
try {
  check('tokened broker is up', tokened.up, tokened.base);

  // Only minimal liveness stays open without a token.
  const publicHealthResponse = await fetch(`${tokened.base}/api/health`);
  const publicHealth = await publicHealthResponse.json() as any;
  check('GET /api/health is open and minimal without token',
    publicHealthResponse.status === 200
      && publicHealth.ok === true
      && publicHealth.machine === undefined
      && publicHealth.contract === undefined
      && publicHealthResponse.headers.get('cache-control') === 'private, no-store');
  const privateHealthResponse = await fetch(`${tokened.base}/api/health`, {
    headers: { 'x-cosyncing-token': TOKEN },
  });
  const privateHealth = await privateHealthResponse.json() as any;
  check('authenticated health includes setup and compatibility identity',
    privateHealth.machine === 'auth-test'
      && typeof privateHealth.contract?.revision === 'number'
      && privateHealthResponse.headers.get('cache-control') === 'private, no-store');
  check('GET /api/sessions requires a token', (await status(tokened.base, '/api/sessions')) === 401);
  check('GET /api/sessions accepts a token', (await status(tokened.base, '/api/sessions', {
    headers: { 'x-cosyncing-token': TOKEN },
  })) === 200);
  const peerHeaders = { 'x-cosyncing-peer-token': PEER_TOKEN };
  check('paired device can observe the session roster',
    (await status(tokened.base, '/api/sessions', { headers: peerHeaders })) === 200);
  check('paired device cannot create another pairing offer',
    (await status(tokened.base, '/api/transport/pairings', {
      method: 'POST',
      headers: { ...peerHeaders, 'content-type': 'application/json' },
      body: '{}',
    })) === 403);
  check('paired device cannot list peer credentials',
    (await status(tokened.base, '/api/transport/peers', { headers: peerHeaders })) === 403);
  check('paired device cannot restart the broker',
    (await status(tokened.base, '/api/broker/restart', {
      method: 'POST',
      headers: { ...peerHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ confirmRestart: true }),
    })) === 403);
  check('paired device cannot invoke broker update checks',
    (await status(tokened.base, '/api/broker/update', { headers: peerHeaders })) === 403);
  const peerOwnerOnlyRequests: Array<[string, string, string]> = [
    ['read pairing status', 'GET', '/api/transport/pairings/pair_not_real_12345678901'],
    ['revoke another device', 'DELETE', '/api/transport/peers/other-peer'],
    ['restart every managed runtime', 'POST', '/api/broker/restart-all'],
    ['change runtime update policy', 'POST', '/api/agent-runtime-update-policy'],
    ['restart an updated runtime', 'POST', '/api/agent-runtime-updates/codex/restart'],
    ['synchronize Codex runtime state', 'POST', '/api/agents/codex/sync'],
    ['change the global quota preference', 'POST', '/api/tokdash/quota-preference'],
    ['create a durable schedule', 'POST', '/api/schedules'],
    ['list durable schedules', 'GET', '/api/schedules'],
    ['invoke the agent-only send-file route', 'POST', '/api/tool/send_file'],
    ['trigger a wake for another device', 'POST', '/api/push/wake'],
  ];
  for (const [label, method, path] of peerOwnerOnlyRequests) {
    check(`paired device cannot ${label}`,
      (await status(tokened.base, path, {
        method,
        headers: { ...peerHeaders, 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      })) === 403);
  }
  const tokdashOverride = await fetch(
    `${tokened.base}/api/tokdash/usage?base=${encodeURIComponent('http://127.0.0.1:1/private')}`,
    { headers: peerHeaders },
  );
  const tokdashOverrideBody = await tokdashOverride.json().catch(() => ({})) as any;
  check('remote Tokdash reads ignore caller-selected upstream URLs',
    tokdashOverrideBody.baseUrl !== 'http://127.0.0.1:1/private');

  const oversizedTicket = await fetch(`${tokened.base}/api/ws-auth-tickets`, {
    method: 'POST',
    headers: { ...peerHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(64 * 1024) }),
  });
  check('WebSocket ticket JSON is bounded in the broker', oversizedTicket.status === 413, `status=${oversizedTicket.status}`);
  const oversizedOrdinaryJson = await fetch(`${tokened.base}/api/projects/rename`, {
    method: 'POST',
    headers: { ...peerHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }),
  });
  check('ordinary API JSON is bounded in the broker', oversizedOrdinaryJson.status === 413, `status=${oversizedOrdinaryJson.status}`);
  const unauthenticatedOptionsSessions = await fetch(`${tokened.base}/api/sessions`, { method: 'OPTIONS' });
  check('OPTIONS /api/sessions cannot bypass roster authentication',
    unauthenticatedOptionsSessions.status === 401 && !(await unauthenticatedOptionsSessions.text()).includes('sessions'));
  const unauthenticatedOptionsAgents = await fetch(`${tokened.base}/api/agents`, { method: 'OPTIONS' });
  check('OPTIONS /api/agents cannot bypass agent-roster authentication',
    unauthenticatedOptionsAgents.status === 401 && !(await unauthenticatedOptionsAgents.text()).includes('capabilities'));
  const authenticatedOptionsSessions = await fetch(`${tokened.base}/api/sessions`, {
    method: 'OPTIONS',
    headers: { 'x-cosyncing-token': TOKEN },
  });
  check('authenticated OPTIONS /api/sessions does not execute the GET handler',
    authenticatedOptionsSessions.status === 404 && !(await authenticatedOptionsSessions.text()).includes('sessions'));

  const malformedPublicPairing = await fetch(`${tokened.base}/api/transport/pairings/%E0%A4%A/accept`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const malformedPublicPairingBody = await malformedPublicPairing.text();
  check('malformed public pairing path returns a controlled JSON error',
    malformedPublicPairing.status === 400
      && malformedPublicPairing.headers.get('content-type')?.includes('application/json') === true
      && malformedPublicPairingBody.includes('PAIRING_INVALID_INPUT')
      && !malformedPublicPairingBody.includes('URIError'),
    `status=${malformedPublicPairing.status}`);

  const malformedAuthenticatedPath = await fetch(`${tokened.base}/api/transport/peers/%E0%A4%A`, {
    method: 'DELETE',
    headers: { 'x-cosyncing-token': TOKEN },
  });
  const malformedAuthenticatedBody = await malformedAuthenticatedPath.text();
  check('unexpected route errors use a content-free production response',
    malformedAuthenticatedPath.status === 500
      && malformedAuthenticatedPath.headers.get('content-type') === 'text/plain; charset=utf-8'
      && malformedAuthenticatedBody === 'internal server error'
      && !malformedAuthenticatedBody.includes('URIError'),
    `status=${malformedAuthenticatedPath.status}`);

  const proxy = await loopbackForwarder(7796);
  try {
    check('proxy path keeps unauthenticated roster private', (await status(proxy.base, '/api/sessions')) === 401);
    check('proxy path accepts an authenticated roster request', (await status(proxy.base, '/api/sessions', {
      headers: { 'x-cosyncing-token': TOKEN, 'x-forwarded-for': '127.0.0.1' },
    })) === 200);
    check('proxy loopback TCP source remains T2 for filesystem access', (await status(
      proxy.base,
      '/api/sessions/codex/missing/fs',
      { headers: { 'x-cosyncing-token': TOKEN, forwarded: 'for=127.0.0.1' } },
    )) === 403);
    check('proxy loopback TCP source remains T2 for R2 actions', (await status(
      proxy.base,
      '/api/sessions/opencode/missing/export/preflight',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-cosyncing-token': TOKEN, 'x-forwarded-for': '127.0.0.1' },
        body: '{}',
      },
    )) === 403);
  } finally {
    await proxy.close();
  }

  // Every mutating route is 401 WITHOUT the token.
  for (const [p, init] of MUTATING) {
    const s = await status(tokened.base, p, init);
    check(`${init.method} ${p} → 401 without token`, s === 401, `status=${s}`);
  }

  for (const p of SENSITIVE_GETS) {
    const s = await status(tokened.base, p, { method: 'GET' });
    check(`GET ${p} → 401 without token`, s === 401, `status=${s}`);
  }

  // WITH the token, a mutating route is NOT 401 (codex/sync dry-run → 200; proves the token unlocks it).
  const okSync = await status(tokened.base, '/api/agents/codex/sync', { ...withTok, body: JSON.stringify({ enabled: false }) });
  check('POST /api/agents/codex/sync with token is accepted (not 401)', okSync !== 401 && okSync !== -1, `status=${okSync}`);
  // Long-lived query credentials are deliberately not accepted.
  const okQuery = await status(tokened.base, `/api/agents/codex/sync?token=${TOKEN}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  check('mutating route rejects ?token= query param', okQuery === 401, `status=${okQuery}`);

  const unauthResume = await fetch(`${tokened.base}/api/sessions/codex/missing/stream?mode=resume`);
  const unauthResumeBody = await unauthResume.json().catch(() => ({})) as any;
  check('unauthenticated direct resume is rejected with stable code',
    unauthResume.status === 401 && unauthResumeBody.code === 'RESUME_AUTH_REQUIRED',
    `status=${unauthResume.status} code=${String(unauthResumeBody.code)}`);
  const resumeTicket = await wsTicket(tokened.base, TOKEN, 'codex', 'missing', { mode: 'resume' });
  const authResume = await status(tokened.base, `/api/sessions/codex/missing/stream?wsAuthTicket=${resumeTicket.ticket}`, { method: 'GET' });
  check('authenticated direct resume reaches the websocket upgrade boundary', authResume === 426, `status=${authResume}`);
  const replayedResume = await status(tokened.base, `/api/sessions/codex/missing/stream?wsAuthTicket=${resumeTicket.ticket}`, { method: 'GET' });
  check('WebSocket authorization ticket is single-use', replayedResume === 401, `status=${replayedResume}`);

  const piHeaders = { 'content-type': 'application/json', 'x-cosyncing-integration-token': PI_CREDENTIAL };
  const hello = await fetch(`${tokened.base}/pi/bridge/hello`, {
    method: 'POST',
    headers: piHeaders,
    body: JSON.stringify({ sessionFile: join(tokened.home, 'pi-session.jsonl'), cwd: tokened.home }),
  });
  const helloBody = await hello.json().catch(() => ({})) as any;
  check('route-scoped Pi credential authenticates Pi hello', hello.status === 200 && typeof helloBody.id === 'string', `status=${hello.status}`);
  const piStatus = await status(tokened.base, `/pi/bridge/status?id=${encodeURIComponent(String(helloBody.id ?? ''))}`, {
    method: 'GET', headers: { 'x-cosyncing-integration-token': PI_CREDENTIAL },
  });
  check('route-scoped Pi credential authenticates Pi GET legs', piStatus === 200, `status=${piStatus}`);
  const surfacedPath = join(tokened.home, 'pi-output.txt');
  writeFileSync(surfacedPath, 'scoped bridge output');
  const piSendFile = await fetch(`${tokened.base}/pi/bridge/send-file`, {
    method: 'POST',
    headers: piHeaders,
    body: JSON.stringify({ id: helloBody.id, path: surfacedPath }),
  });
  const piSendFileBody = await piSendFile.json().catch(() => ({})) as any;
  check('route-scoped Pi credential can surface a file only through its live bridge',
    piSendFile.status === 200 && piSendFileBody.ok === true,
    `status=${piSendFile.status}`);
  const forgedBridge = await status(tokened.base, '/pi/bridge/send-file', {
    method: 'POST', headers: piHeaders, body: JSON.stringify({ id: 'pi:forged', path: surfacedPath }),
  });
  check('route-scoped Pi send-file rejects a forged bridge identity', forgedBridge === 404, `status=${forgedBridge}`);

  const generalWithPi = await status(tokened.base, '/api/agents/codex/sync', {
    method: 'POST', headers: piHeaders, body: JSON.stringify({ enabled: false }),
  });
  check('Pi credential cannot authorize general broker control', generalWithPi === 401, `status=${generalWithPi}`);
  const resumeWithPi = await fetch(`${tokened.base}/api/sessions/codex/missing/stream?mode=resume`, {
    headers: { 'x-cosyncing-integration-token': PI_CREDENTIAL },
  });
  const resumeWithPiBody = await resumeWithPi.json().catch(() => ({})) as any;
  check('Pi credential cannot authorize Drive resume',
    resumeWithPi.status === 401 && resumeWithPiBody.code === 'RESUME_AUTH_REQUIRED',
    `status=${resumeWithPi.status}`);

  const confusedGeneralHeader = await status(tokened.base, '/pi/bridge/hello', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-cosyncing-token': PI_CREDENTIAL }, body: '{}',
  });
  check('Pi credential is rejected in the shared-token header', confusedGeneralHeader === 401, `status=${confusedGeneralHeader}`);
  const confusedPiHeader = await status(tokened.base, '/pi/bridge/hello', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-cosyncing-integration-token': TOKEN }, body: '{}',
  });
  check('shared token is rejected in the Pi integration header', confusedPiHeader === 401, `status=${confusedPiHeader}`);

  const scheduleHeaders = { 'content-type': 'application/json', 'x-cosyncing-token': TOKEN };
  const repeatingMessage = await status(tokened.base, '/api/schedules', {
    method: 'POST', headers: scheduleHeaders,
    body: JSON.stringify({ kind: 'message', tool: 'codex', sessionId: 's', text: 'later', at: Date.now() + 60_000, repeat: 'daily' }),
  });
  check('existing-session schedules reject repeat (D5 one-shot)', repeatingMessage === 400, `status=${repeatingMessage}`);
  const unknownRepeat = await status(tokened.base, '/api/schedules', {
    method: 'POST', headers: scheduleHeaders,
    body: JSON.stringify({ kind: 'new-session', tool: 'codex', text: 'later', at: Date.now() + 60_000, repeat: 'weekly' }),
  });
  check('unknown repeat values fail instead of silently becoming one-shot', unknownRepeat === 400, `status=${unknownRepeat}`);

  const invalidCron = await fetch(`${tokened.base}/api/schedules`, {
    method: 'POST', headers: scheduleHeaders,
    body: JSON.stringify({ kind: 'message', tool: 'codex', sessionId: 's', text: 'later', cron: { expression: '0 25 * * *', timeZone: 'UTC' } }),
  });
  const invalidCronBody = await invalidCron.json().catch(() => ({})) as any;
  check('invalid cron has a stable typed failure',
    invalidCron.status === 400 && invalidCronBody.code === 'SCHEDULE_CRON_INVALID',
    `status=${invalidCron.status} code=${String(invalidCronBody.code)}`);

  const recurringMessage = await fetch(`${tokened.base}/api/schedules`, {
    method: 'POST', headers: scheduleHeaders,
    body: JSON.stringify({ kind: 'message', tool: 'codex', sessionId: 's', text: 'later', cron: { expression: '0 0 * * *', timeZone: 'UTC' } }),
  });
  const recurringMessageBody = await recurringMessage.json().catch(() => ({})) as any;
  check('crafted existing-session cron remains rejected by the D5 one-shot boundary',
    recurringMessage.status === 400 && recurringMessageBody.code === 'SCHEDULE_INVALID',
    `status=${recurringMessage.status} code=${String(recurringMessageBody.code)}`);

  const createCron = await fetch(`${tokened.base}/api/schedules`, {
    method: 'POST', headers: scheduleHeaders,
    body: JSON.stringify({
      kind: 'new-session', tool: 'codex', title: 'Scheduled target', text: 'full private prompt',
      cron: { expression: '0 0 1 1 *', timeZone: 'UTC' },
      retryPolicy: { maxRetries: 2, delayMs: 60_000, backoff: 'exponential', retryOn: ['delivery', 'quota'] },
      futureAdditiveField: { ignored: true },
    }),
  });
  const createCronBody = await createCron.json().catch(() => ({})) as any;
  const scheduleId = String(createCronBody.schedule?.id ?? '');
  check('authenticated arbitrary-cron schedule is broker-timed and revisioned',
    createCron.status === 201 && scheduleId.length > 0 && createCronBody.schedule?.revision === 1
      && createCronBody.schedule?.at > Date.now() && createCronBody.schedule?.retryPolicy?.maxRetries === 2,
    `status=${createCron.status} revision=${String(createCronBody.schedule?.revision)}`);

  const edit = await fetch(`${tokened.base}/api/schedules/${encodeURIComponent(scheduleId)}`, {
    method: 'PATCH', headers: scheduleHeaders,
    body: JSON.stringify({ expectedRevision: 1, text: 'edited private prompt', title: 'Edited', futureAdditiveField: true }),
  });
  const editBody = await edit.json().catch(() => ({})) as any;
  check('schedule edit accepts additive data and advances revision',
    edit.status === 200 && editBody.schedule?.revision === 2 && editBody.schedule?.text === 'edited private prompt',
    `status=${edit.status} revision=${String(editBody.schedule?.revision)}`);

  const staleEdit = await fetch(`${tokened.base}/api/schedules/${encodeURIComponent(scheduleId)}`, {
    method: 'PATCH', headers: scheduleHeaders,
    body: JSON.stringify({ expectedRevision: 1, text: 'stale overwrite' }),
  });
  const staleEditBody = await staleEdit.json().catch(() => ({})) as any;
  check('stale schedule edit is a stable conflict',
    staleEdit.status === 409 && staleEditBody.code === 'SCHEDULE_STALE',
    `status=${staleEdit.status} code=${String(staleEditBody.code)}`);

  const pause = await fetch(`${tokened.base}/api/schedules/${encodeURIComponent(scheduleId)}/actions`, {
    method: 'POST', headers: scheduleHeaders,
    body: JSON.stringify({ action: 'pause', expectedRevision: 2 }),
  });
  const pauseBody = await pause.json().catch(() => ({})) as any;
  check('typed pause action advances a schedule to paused',
    pause.status === 200 && pauseBody.schedule?.state === 'paused' && pauseBody.schedule?.revision === 3,
    `status=${pause.status} state=${String(pauseBody.schedule?.state)}`);

  const invalidRunNow = await fetch(`${tokened.base}/api/schedules/${encodeURIComponent(scheduleId)}/actions`, {
    method: 'POST', headers: scheduleHeaders,
    body: JSON.stringify({ action: 'run-now', expectedRevision: 3 }),
  });
  const invalidRunNowBody = await invalidRunNow.json().catch(() => ({})) as any;
  check('unsupported lifecycle transition has a stable typed conflict',
    invalidRunNow.status === 409 && invalidRunNowBody.code === 'SCHEDULE_INVALID_STATE',
    `status=${invalidRunNow.status} code=${String(invalidRunNowBody.code)}`);

  const resume = await fetch(`${tokened.base}/api/schedules/${encodeURIComponent(scheduleId)}/actions`, {
    method: 'POST', headers: scheduleHeaders,
    body: JSON.stringify({ action: 'resume', expectedRevision: 3 }),
  });
  const resumeScheduleBody = await resume.json().catch(() => ({})) as any;
  check('typed resume action returns to scheduled',
    resume.status === 200 && resumeScheduleBody.schedule?.state === 'scheduled' && resumeScheduleBody.schedule?.revision === 4,
    `status=${resume.status} state=${String(resumeScheduleBody.schedule?.state)}`);

  const noQuotaEvidence = await fetch(`${tokened.base}/api/schedules/${encodeURIComponent(scheduleId)}/actions`, {
    method: 'POST', headers: scheduleHeaders,
    body: JSON.stringify({ action: 'recover-quota', expectedRevision: 4 }),
  });
  const noQuotaEvidenceBody = await noQuotaEvidence.json().catch(() => ({})) as any;
  check('quota recovery requires an exhausted native quota failure',
    noQuotaEvidence.status === 409 && noQuotaEvidenceBody.code === 'SCHEDULE_QUOTA_RECOVERY_UNAVAILABLE',
    `status=${noQuotaEvidence.status} code=${String(noQuotaEvidenceBody.code)}`);
} finally {
  tokened.broker.kill();
  await tokened.broker.exited.catch(() => null);
  rmSync(tokened.home, { recursive: true, force: true });
  delete process.env.COSYNCING_PI_INTEGRATION_FILE;
}

const featureEnabled = await spawnBroker(7798, { COSYNCING_TOKEN: TOKEN }, (home) => {
  writeBrokerConfig({
    ...defaultBrokerConfig(),
    features: {
      httpWorkspaceBrowsing: true,
      httpTranscriptExport: true,
    },
  }, home);
});
try {
  check('locally configured workspace browsing is reachable through authenticated HTTP',
    (await status(featureEnabled.base, '/api/sessions/codex/missing/fs', {
      headers: { 'x-cosyncing-token': TOKEN },
    })) === 404);
  check('locally configured transcript export passes the HTTP feature gate',
    (await status(featureEnabled.base, '/api/sessions/opencode/missing/export/preflight', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cosyncing-token': TOKEN },
      body: '{}',
    })) === 404);
} finally {
  featureEnabled.broker.kill();
  await featureEnabled.broker.exited.catch(() => null);
  rmSync(featureEnabled.home, { recursive: true, force: true });
}

// Loopback baseline: NO token → every route open (a mutation is not 401).
const open = await spawnBroker(7797, {});
try {
  check('no-token broker is up', open.up, open.base);
  const s = await status(open.base, '/api/agents/codex/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  check('no-token baseline: mutating route is NOT gated (open)', s !== 401 && s !== -1, `status=${s}`);
  const observe = await status(open.base, '/api/sessions/codex/missing/stream', { method: 'GET' });
  check('no-token loopback Observe still reaches websocket upgrade boundary', observe === 426, `status=${observe}`);
  const resume = await fetch(`${open.base}/api/sessions/codex/missing/stream?mode=resume`);
  const resumeBody = await resume.json().catch(() => ({})) as any;
  check('no-token loopback Drive resume still requires a credential',
    resume.status === 401 && resumeBody.code === 'RESUME_AUTH_REQUIRED',
    `status=${resume.status} code=${String(resumeBody.code)}`);
} finally {
  open.broker.kill();
  await open.broker.exited.catch(() => null);
  rmSync(open.home, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
if (failed.length) { console.error(`\nFAIL: ${failed.length}/${results.length} broker-auth check(s) failed.`); process.exit(1); }
console.log(`\n✅ ${results.length}/${results.length} broker-auth checks passed.`);
