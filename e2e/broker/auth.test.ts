/**
 * Who may call what, proven against a running broker.
 *
 * The broker here is installed the way setup leaves it: the owner token and
 * the Pi and omp integration credentials live in owner-only files, and paired
 * devices live in the peer store. Every principal a request can carry is
 * present at once: no credential, the owner token, a device paired for real
 * (observe + drive + files), devices holding one role each, observe + files,
 * no role at all, and the two integration credentials.
 *
 * The authorization table below is the specification, written out by hand.
 * Every contract route and every method is requested as every principal, and
 * the broker must answer exactly as the table says: allowed requests reach
 * their handler (never 401, never a policy 403), denied ones are refused before
 * it. A route added to the contract without a row here fails the suite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  BROKER_INTEGRATION_ROUTES,
  BROKER_ROUTES,
  PRODUCT_IDENTITY,
} from '../../packages/typescript/protocol/src/index.ts';
import {
  type Broker,
  type BrokerClient,
  eventually,
  scaled,
  startBroker,
} from '../harness/index.ts';
import { type InstalledBroker, startInstalledBroker } from '../harness/installed.ts';
import { pairDevice, type PairedDevice } from '../harness/pairing.ts';

// ── The authorization table ────────────────────────────────────────────────

/**
 * `update` is not a role. It is the narrow, revocable `broker:update` grant the owner issues
 * to one peer, held in an owner-only file the peer cannot write. No principal seeded below
 * holds one, which is exactly what the matrix then proves: `drive` does not buy it, and a
 * paired device cannot hand it to itself.
 */
type Rule = 'public' | 'owner' | 'observe' | 'drive' | 'files' | 'observe+files' | 'update' | 'pi' | 'omp';
type Method = 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'DELETE';

/**
 * Who may call each route. A method not listed is owner-only: an unclassified
 * method fails closed for everyone else.
 */
const AUTHORIZATION: Record<string, Partial<Record<Method, Rule>>> = {
  '/api/health': { GET: 'public', HEAD: 'public' },
  '/api/agents': { GET: 'observe' },
  '/api/agents/{id}/models': { GET: 'observe' },
  '/api/agents/{id}/modes': { GET: 'observe' },
  '/api/agents/codex/sync': { GET: 'observe', POST: 'owner' },
  '/api/agent-runtime-updates': { GET: 'observe' },
  '/api/agent-runtime-update-policy': { GET: 'observe', POST: 'owner' },
  '/api/agent-runtime-updates/{id}/restart': { POST: 'owner' },
  '/api/attention-events': { GET: 'observe' },
  '/api/attention-events/dismiss-batch': { POST: 'drive' },
  '/api/attention-events/{id}/ack': { POST: 'drive' },
  '/api/attention-events/{id}/dismiss': { POST: 'drive' },
  '/api/broker/health': { GET: 'observe' },
  '/api/broker/features/workspace-browsing': { GET: 'observe', POST: 'owner' },
  '/api/broker/restart': { POST: 'owner' },
  '/api/broker/restart-all': { POST: 'owner' },
  '/api/broker/update': { GET: 'owner', POST: 'owner' },
  // The in-app update surface: discovery for whoever may watch, commit only with the grant.
  '/api/broker/updates': { GET: 'observe' },
  '/api/broker/updates/check': { GET: 'observe' },
  '/api/broker/updates/history': { GET: 'observe' },
  '/api/broker/updates/plans': { POST: 'update' },
  '/api/broker/updates/jobs': { POST: 'update' },
  '/api/broker/updates/jobs/{id}': { GET: 'observe' },
  '/api/broker/updates/jobs/{id}/apply': { POST: 'update' },
  '/api/broker/updates/jobs/{id}/cancel': { POST: 'update' },
  '/api/broker/update-grants': { GET: 'owner', POST: 'owner' },
  '/api/broker/update-grants/{id}': { DELETE: 'owner' },
  '/api/broker/update-grants/request': { POST: 'observe' },
  '/api/machines': { GET: 'observe' },
  '/api/machines/resolve': { GET: 'observe' },
  '/api/projects/rename': { PATCH: 'drive', POST: 'drive' },
  '/api/push/wake': { POST: 'owner' },
  '/api/push/wake-tokens': { GET: 'observe', POST: 'observe' },
  '/api/push/wake-tokens/{id}': { DELETE: 'observe' },
  '/api/push/web-push-key': { GET: 'observe' },
  // A scheduled send is a prompt with a clock on it: reading the queue needs
  // what reading the sessions needs, changing it needs what prompting needs.
  '/api/schedules': { GET: 'observe', POST: 'drive' },
  '/api/schedules/{id}': { PATCH: 'drive', DELETE: 'drive' },
  '/api/schedules/{id}/actions': { POST: 'drive' },
  '/api/claude/hooks': { GET: 'owner', POST: 'owner' },
  '/api/session-roster-deltas': { GET: 'observe' },
  '/api/sessions': { GET: 'observe' },
  '/api/sessions/{id}': { POST: 'drive' },
  '/api/sessions/{id}/{id}/artifact/{id}': { GET: 'files', HEAD: 'files' },
  '/api/sessions/{id}/{id}/artifact/{id}/ticket': { POST: 'observe+files' },
  '/api/sessions/{id}/{id}/fs': { GET: 'files' },
  '/api/sessions/{id}/{id}/fs/read': { GET: 'files' },
  '/api/sessions/{id}/{id}/fs/search': { GET: 'files' },
  '/api/sessions/{id}/{id}/fs/download': { GET: 'files' },
  '/api/sessions/{id}/{id}/uploads': { POST: 'files' },
  '/api/sessions/{id}/{id}/uploads/{id}': { GET: 'files', PATCH: 'files', DELETE: 'files' },
  '/api/sessions/{id}/{id}/uploads/{id}/complete': { POST: 'files' },
  '/api/sessions/{id}/{id}/cache': { DELETE: 'files' },
  '/api/sessions/{id}/{id}/clone': { POST: 'drive' },
  '/api/sessions/{id}/{id}/export': { POST: 'observe+files' },
  '/api/sessions/{id}/{id}/export/preflight': { POST: 'observe+files' },
  '/api/sessions/{id}/{id}/fork': { POST: 'drive' },
  '/api/sessions/{id}/{id}/rename': { PATCH: 'drive', POST: 'drive' },
  '/api/sessions/{id}/{id}/stream': { GET: 'observe' },
  '/api/tokdash/usage': { GET: 'observe' },
  '/api/tokdash/quota': { GET: 'observe' },
  '/api/tokdash/quota-preference': { GET: 'observe', POST: 'owner' },
  '/api/tokdash/report': { GET: 'observe' },
  // Surfacing a workspace file is scoped to the session's own cwd, the same
  // boundary the fs routes use, so it carries the files role, not ownership.
  '/api/tool/send_file': { POST: 'files' },
  '/api/transport/envelopes': { GET: 'observe', POST: 'observe' },
  '/api/transport/peers': { GET: 'owner' },
  '/api/transport/peers/{id}': { DELETE: 'owner' },
  '/api/transport/pairings': { POST: 'owner' },
  '/api/transport/pairings/{id}': { GET: 'owner' },
  '/api/transport/pairings/{id}/accept': { POST: 'public' },
  '/api/transport/session-control': { POST: 'drive' },
  '/api/ws-auth-tickets': { POST: 'observe' },
  '/pi/bridge/hello': { POST: 'pi' },
  '/pi/bridge/events': { POST: 'pi' },
  '/pi/bridge/send-file': { POST: 'pi' },
  '/pi/bridge/bye': { POST: 'pi' },
  '/pi/bridge/commands': { GET: 'pi' },
  '/pi/bridge/status': { GET: 'pi' },
  '/omp/bridge/hello': { POST: 'omp' },
  '/omp/bridge/events': { POST: 'omp' },
  '/omp/bridge/send-file': { POST: 'omp' },
  '/omp/bridge/bye': { POST: 'omp' },
  '/omp/bridge/commands': { GET: 'omp' },
  '/omp/bridge/status': { GET: 'omp' },
  '/claude/hook/hello': { POST: 'owner' },
  '/claude/hook/status': { POST: 'owner' },
  '/claude/hook/request': { POST: 'owner' },
  '/claude/hook/bye': { POST: 'owner' },
};

/**
 * Owner requests that would leave the machine or act on it for real. The owner
 * bypasses the table entirely, so these add nothing to the matrix.
 */
const OWNER_NOT_EXERCISED = new Set(['/api/broker/update', '/api/broker/restart', '/api/broker/restart-all',
  '/api/agent-runtime-updates/{id}/restart']);

type PrincipalName =
  | 'anonymous' | 'owner' | 'paired device' | 'observe peer' | 'drive peer' | 'files peer'
  | 'observe+files peer' | 'zero-role peer' | 'Pi credential' | 'omp credential';

const SEEDED_PEERS: Record<string, string[]> = {
  'observe peer': ['observe'],
  'drive peer': ['drive'],
  'files peer': ['files'],
  'observe+files peer': ['observe', 'files'],
  'zero-role peer': [],
};

const PEER_ROLES: Record<string, readonly string[]> = {
  ...SEEDED_PEERS,
  'paired device': ['observe', 'drive', 'files'],
};

/** The refusals the route policy itself produces. Anything else came from a handler. */
const POLICY_REFUSAL = /^(owner credential required|broker:update grant required|[a-z+ ]+ roles? required|peer credential is not authorized for this route|integration credential is not authorized for this route|authenticated credential required)$/;

type Verdict = 'allowed' | 'unauthenticated' | 'forbidden';

function expectedVerdict(rule: Rule | undefined, principal: PrincipalName, path: string): Verdict {
  if (principal === 'owner' || rule === 'public') return 'allowed';
  if (principal === 'anonymous') return 'unauthenticated';
  if (principal === 'Pi credential' || principal === 'omp credential') {
    // An integration credential authenticates only on its own bridge family.
    const family = principal === 'Pi credential' ? '/pi/bridge/' : '/omp/bridge/';
    if (!path.startsWith(family)) return 'unauthenticated';
    return rule === (principal === 'Pi credential' ? 'pi' : 'omp') ? 'allowed' : 'forbidden';
  }
  const roles = PEER_ROLES[principal]!;
  if (!rule || rule === 'owner' || rule === 'update' || rule === 'pi' || rule === 'omp') return 'forbidden';
  return rule.split('+').every((role) => roles.includes(role)) ? 'allowed' : 'forbidden';
}

async function observedVerdict(response: globalThis.Response): Promise<{ verdict: Verdict; detail: string }> {
  const text = await response.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = undefined; }
  const detail = `${response.status} ${text.slice(0, 120)}`;
  // A stream with no ticket is refused AFTER the route policy passed: streams
  // take only a one-use ticket, never a long-lived credential.
  if (response.status === 401 && body?.error === 'valid WebSocket authorization ticket required') {
    return { verdict: 'allowed', detail };
  }
  if (response.status === 401) return { verdict: 'unauthenticated', detail };
  if (response.status === 403 && (response.headers.get('content-type') ?? '').includes('json')
    && typeof body?.error === 'string' && POLICY_REFUSAL.test(body.error)) {
    return { verdict: 'forbidden', detail };
  }
  return { verdict: 'allowed', detail };
}

const hash = (token: string): string => createHash('sha256').update(token).digest('base64url');

function seededPeerToken(name: string): string {
  return `seeded-${name.replaceAll(/[^a-z]+/g, '-')}-credential-0123456789abcdef`;
}

/** Peers whose roles no pairing can produce, written into the v2 peer store. */
function seedPeerStore(home: string): void {
  const peers = Object.entries(SEEDED_PEERS).map(([name, roles], index) => ({
    peerId: `seeded-peer-${index}`,
    identityPublicKey: `seeded-identity-${index}`,
    peerTokenHash: hash(`seeded-mailbox-${index}`),
    brokerPeerId: `broker-seeded-${index}`,
    brokerPeerTokenHash: hash(seededPeerToken(name)),
    brokerIdentityPublicKey: 'seeded-broker-identity',
    dataKey: { algorithm: 'AES-256-GCM', bytes: '' },
    wrappedDataKey: {},
    acceptedAt: new Date(0).toISOString(),
    authGeneration: 1,
    roles,
  }));
  writeFileSync(join(home, 'transport-peers.json'), `${JSON.stringify({ version: 2, peers })}\n`, { mode: 0o600 });
}

/** Run `work` over `items`, at most `limit` at a time. */
async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  }));
}

// ── The installed broker ───────────────────────────────────────────────────

let installed: InstalledBroker;
let broker: Broker;
let owner: BrokerClient;
let device: PairedDevice;
const headersFor: Partial<Record<PrincipalName, Record<string, string>>> = {};

beforeAll(async () => {
  installed = await startInstalledBroker({
    name: 'auth',
    features: { httpWorkspaceBrowsing: true, httpTranscriptExport: true },
    setup: (paths) => seedPeerStore(paths.cosyncingHome),
  });
  broker = installed.broker;
  owner = installed.owner;
  device = await pairDevice(owner, { peerId: 'auth-phone', clientLabel: 'Auth phone' });
  headersFor.anonymous = {};
  headersFor.owner = { [PRODUCT_IDENTITY.tokenHeader]: installed.credentials.brokerToken };
  headersFor['paired device'] = { 'x-cosyncing-peer-token': device.peerToken };
  for (const name of Object.keys(SEEDED_PEERS)) {
    headersFor[name as PrincipalName] = { 'x-cosyncing-peer-token': seededPeerToken(name) };
  }
  headersFor['Pi credential'] = { 'x-cosyncing-integration-token': installed.credentials.piCredential };
  headersFor['omp credential'] = { 'x-cosyncing-integration-token': installed.credentials.ompCredential };
});

afterAll(async () => {
  await installed?.stop();
});

function call(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<globalThis.Response> {
  const hasBody = body !== undefined || (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE' && method !== 'OPTIONS');
  return fetch(`${broker.url}${path}`, {
    method,
    headers: { ...headers, ...(hasBody ? { 'content-type': 'application/json' } : {}) },
    body: hasBody ? JSON.stringify(body ?? {}) : undefined,
    signal: AbortSignal.timeout(scaled(30_000)),
  });
}

const PRINCIPALS: PrincipalName[] = [
  'anonymous', 'owner', 'paired device', 'observe peer', 'drive peer', 'files peer',
  'observe+files peer', 'zero-role peer', 'Pi credential', 'omp credential',
];

describe('the authorization table', () => {
  test('covers every route the contract publishes, and nothing else', () => {
    const contract = new Set<string>([...BROKER_ROUTES, ...BROKER_INTEGRATION_ROUTES]);
    expect([...Object.keys(AUTHORIZATION)].sort()).toEqual([...contract].sort());
  });

  test.each(PRINCIPALS)('%s: every route and method is answered as the table says', async (principal) => {
    const headers = headersFor[principal]!;
    const mismatches: string[] = [];
    const probes: Array<{ route: string; method: Method }> = [];
    for (const [route, rules] of Object.entries(AUTHORIZATION)) {
      if (principal === 'owner' && OWNER_NOT_EXERCISED.has(route)) continue;
      const methods = new Set<Method>(['GET', 'POST', 'PATCH', 'DELETE', ...Object.keys(rules) as Method[]]);
      // A HEAD carries no body to tell a policy refusal from a handler's; the
      // public health HEAD is the one that matters.
      if (route !== '/api/health') methods.delete('HEAD');
      for (const method of methods) probes.push({ route, method });
    }
    await pool(probes, 16, async ({ route, method }) => {
      const path = route.replaceAll('{id}', 'route-id');
      const query = route.endsWith('/commands') ? '?id=route-id' : '';
      const response = await call(method, `${path}${query}`, headers);
      const expected = expectedVerdict(AUTHORIZATION[route]![method], principal, path);
      const observed = method === 'HEAD'
        ? { verdict: (response.status === 401 ? 'unauthenticated' : response.status === 403 ? 'forbidden' : 'allowed') as Verdict, detail: String(response.status) }
        : await observedVerdict(response);
      if (observed.verdict !== expected) {
        mismatches.push(`${method} ${route}: expected ${expected}, got ${observed.verdict} (${observed.detail})`);
      }
    });
    expect(mismatches).toEqual([]);
  });

  test('a route or method nobody classified is the owner\'s alone', async () => {
    for (const principal of PRINCIPALS.filter((name) => name !== 'owner')) {
      const unknownRoute = await observedVerdict(await call('GET', '/api/future-unclassified-route', headersFor[principal]!));
      expect(unknownRoute.verdict, principal).not.toBe('allowed');
      const unknownMethod = await observedVerdict(await call('POST', '/api/machines', headersFor[principal]!));
      expect(unknownMethod.verdict, principal).not.toBe('allowed');
    }
    expect((await call('GET', '/api/future-unclassified-route', headersFor.owner!)).status).toBe(404);
  });

  test('the argued decisions: observe reads schedules, drive changes them, files surfaces a workspace file', async () => {
    const observe = headersFor['observe peer']!;
    const drive = headersFor['drive peer']!;
    expect((await call('GET', '/api/schedules', observe)).status).toBe(200);
    expect((await call('GET', '/api/schedules', headersFor['zero-role peer']!)).status).toBe(403);
    for (const [method, path] of [
      ['POST', '/api/schedules'], ['PATCH', '/api/schedules/route-id'],
      ['DELETE', '/api/schedules/route-id'], ['POST', '/api/schedules/route-id/actions'],
    ] as const) {
      expect((await call(method, path, observe)).status, `observe ${method} ${path}`).toBe(403);
      expect([400, 404], `drive ${method} ${path}`).toContain((await call(method, path, drive)).status);
    }
    // 400, not 403: the paired device was authorized and then the body was validated.
    expect((await call('POST', '/api/tool/send_file', headersFor['files peer']!)).status).toBe(400);
    expect((await call('POST', '/api/schedules', headersFor['paired device']!)).status).toBe(400);
    const notFiles = await call('POST', '/api/tool/send_file', { 'x-cosyncing-peer-token': seededPeerToken('drive peer') });
    expect(notFiles.status).toBe(403);
  });
});

describe('public surface', () => {
  test('anonymous health is minimal; authenticated health names the machine and the contract', async () => {
    const anonymous = await call('GET', '/api/health', {});
    const body = await anonymous.json() as any;
    expect(anonymous.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.machine).toBeUndefined();
    expect(body.contract).toBeUndefined();
    expect(body.healthStatus).toBeUndefined();
    expect(anonymous.headers.get('cache-control')).toBe('private, no-store');

    const authenticated = await call('GET', '/api/health', headersFor.owner!);
    const full = await authenticated.json() as any;
    expect(full.machine).toBe(installed.machineLabel);
    expect(typeof full.contract?.revision).toBe('number');
    expect(authenticated.headers.get('cache-control')).toBe('private, no-store');
  });

  test('OPTIONS neither bypasses authentication nor runs the GET handler', async () => {
    const sessions = await call('OPTIONS', '/api/sessions', {});
    expect(sessions.status).toBe(401);
    expect(await sessions.text()).not.toContain('sessions');
    const agents = await call('OPTIONS', '/api/agents', {});
    expect(agents.status).toBe(401);
    expect(await agents.text()).not.toContain('capabilities');
    const authenticated = await call('OPTIONS', '/api/sessions', headersFor.owner!);
    expect(authenticated.status).toBe(404);
    expect(await authenticated.text()).not.toContain('sessions');
  });

  test('a credential in the query string authenticates nothing', async () => {
    const token = encodeURIComponent(installed.credentials.brokerToken);
    expect((await call('POST', `/api/agents/codex/sync?token=${token}`, {}, { enabled: false })).status).toBe(401);
    expect((await call('GET', `/api/sessions?token=${token}`, {})).status).toBe(401);
    const peer = encodeURIComponent(device.peerToken);
    expect((await call('GET', `/api/sessions?peerToken=${peer}`, {})).status).toBe(401);
    const stream = await call('GET', `/api/sessions/pi/missing/stream?token=${token}`, {});
    expect(stream.status).toBe(401);
  });

  test('request bodies are bounded before a handler reads them', async () => {
    const peer = headersFor['paired device']!;
    const ticket = await call('POST', '/api/ws-auth-tickets', peer, { padding: 'x'.repeat(64 * 1024) });
    expect(ticket.status).toBe(413);
    const ordinary = await call('POST', '/api/projects/rename', peer, { padding: 'x'.repeat(1024 * 1024) });
    expect(ordinary.status).toBe(413);
    const accept = await call('POST', '/api/transport/pairings/pair_not_real_12345678901/accept', {}, {
      padding: 'x'.repeat(17 * 1024),
    });
    expect(accept.status).toBe(413);
  });

  test('a malformed public path is a controlled JSON error; other route failures are content-free', async () => {
    const accept = await call('POST', '/api/transport/pairings/%E0%A4%A/accept', {}, {});
    const acceptText = await accept.text();
    expect(accept.status).toBe(400);
    expect(accept.headers.get('content-type') ?? '').toContain('application/json');
    expect(acceptText).toContain('PAIRING_INVALID_INPUT');
    expect(acceptText).not.toContain('URIError');

    const revoke = await call('DELETE', '/api/transport/peers/%E0%A4%A', headersFor.owner!);
    expect(revoke.status).toBe(500);
    expect(revoke.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await revoke.text()).toBe('internal server error');
  });
});

// ── Pi and omp integration credentials ─────────────────────────────────────

async function openPiSession(title: string, extra: Record<string, unknown> = {}): Promise<{ id: string; cwd: string }> {
  const cwd = join(broker.paths.root, `workspace-${title}`);
  mkdirSync(cwd, { recursive: true });
  const hello = await call('POST', '/pi/bridge/hello', headersFor['Pi credential']!, {
    sessionFile: join(broker.paths.root, `pi-${title}.jsonl`),
    cwd,
    title,
    history: [],
    ...extra,
  });
  expect(hello.status).toBe(200);
  return { id: String((await hello.json() as any).id), cwd };
}

describe('integration credentials', () => {
  test('the Pi credential opens its bridge: hello, the GET legs, and send-file through a live bridge', async () => {
    const pi = headersFor['Pi credential']!;
    const { id, cwd } = await openPiSession('pi-legs');
    const status = await call('GET', `/pi/bridge/status?id=${encodeURIComponent(id)}`, pi);
    expect(status.status).toBe(200);
    expect((await status.json() as any).bridged).toBe(true);

    writeFileSync(join(cwd, 'output.txt'), 'scoped bridge output');
    const stream = await owner.attach('pi', id);
    await stream.waitForKind('history');
    const sent = await call('POST', '/pi/bridge/send-file', pi, { id, path: join(cwd, 'output.txt') });
    expect(sent.status).toBe(200);
    expect((await sent.json() as any).ok).toBe(true);
    await stream.waitForMessage((message) => message.type === 'file-artifact' && message.name === 'output.txt');

    const forged = await call('POST', '/pi/bridge/send-file', pi, { id: 'pi:forged', path: join(cwd, 'output.txt') });
    expect(forged.status).toBe(404);
    stream.close();
  });

  test('the Pi credential is worthless anywhere else, and the two credentials never stand in for each other', async () => {
    const pi = installed.credentials.piCredential;
    const shared = installed.credentials.brokerToken;
    const asPi = { 'x-cosyncing-integration-token': pi };
    expect((await call('POST', '/api/agents/codex/sync', asPi, { enabled: false })).status).toBe(401);
    const resume = await call('GET', '/api/sessions/pi/missing/stream?mode=resume', asPi);
    expect(resume.status).toBe(401);
    expect((await resume.json() as any).code).toBe('RESUME_AUTH_REQUIRED');
    expect((await call('GET', '/api/machines', asPi)).status).toBe(401);
    // Each credential belongs in exactly one header.
    expect((await call('POST', '/pi/bridge/hello', { [PRODUCT_IDENTITY.tokenHeader]: pi }, {})).status).toBe(401);
    expect((await call('POST', '/pi/bridge/hello', { 'x-cosyncing-integration-token': shared }, {})).status).toBe(401);
    const missing = await call('GET', '/pi/bridge/status?id=missing', {});
    expect(missing.status).toBe(401);
    expect((await missing.json() as any).code).toBe('PI_INTEGRATION_AUTH_REQUIRED');
  });

  test('the omp credential is scoped exactly like Pi\'s, and the two families are disjoint', async () => {
    const omp = { 'x-cosyncing-integration-token': installed.credentials.ompCredential };
    const pi = { 'x-cosyncing-integration-token': installed.credentials.piCredential };
    // Authenticated: the request reaches the omp runtime gate, which reports
    // that no supported omp is installed here. Never a 401 or 403.
    const hello = await call('POST', '/omp/bridge/hello', omp, { sessionFile: join(broker.paths.root, 'omp.jsonl') });
    expect(hello.status).toBe(409);
    expect(typeof (await hello.json() as any).code).toBe('string');
    expect((await call('GET', '/omp/bridge/status?id=missing', omp)).status).toBe(409);

    const anonymous = await call('POST', '/omp/bridge/hello', {}, {});
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json() as any).code).toBe('AUTH_REQUIRED');
    expect((await call('POST', '/omp/bridge/hello', pi, {})).status).toBe(401);
    expect((await call('POST', '/pi/bridge/hello', omp, {})).status).toBe(401);
    expect((await call('POST', '/api/agents/codex/sync', omp, { enabled: false })).status).toBe(401);
    expect((await call('POST', '/omp/bridge/hello', { [PRODUCT_IDENTITY.tokenHeader]: installed.credentials.ompCredential }, {})).status).toBe(401);
    expect((await call('POST', '/omp/bridge/hello', { 'x-cosyncing-integration-token': installed.credentials.brokerToken }, {})).status).toBe(401);
  });
});

// ── WebSocket tickets ──────────────────────────────────────────────────────

async function issueTicket(
  headers: Record<string, string>,
  tool: string,
  sessionId: string,
  params: Record<string, string> = {},
): Promise<globalThis.Response> {
  return call('POST', '/api/ws-auth-tickets', headers, { tool, sessionId, params });
}

function streamWithTicket(tool: string, sessionId: string, ticket: string): Promise<globalThis.Response> {
  return fetch(`${broker.url}/api/sessions/${tool}/${encodeURIComponent(sessionId)}/stream?wsAuthTicket=${encodeURIComponent(ticket)}`);
}

describe('WebSocket tickets', () => {
  test('a ticket opens one stream, once', async () => {
    const { id } = await openPiSession('ticket-once');
    const issued = await issueTicket(headersFor.owner!, 'pi', id);
    expect(issued.status).toBe(201);
    const ticket = String((await issued.json() as any).wsAuthTicket);
    const socket = new WebSocket(`${broker.wsUrl}/api/sessions/pi/${encodeURIComponent(id)}/stream?wsAuthTicket=${encodeURIComponent(ticket)}`);
    const opened = await new Promise<boolean>((resolve) => {
      socket.addEventListener('open', () => resolve(true), { once: true });
      socket.addEventListener('close', () => resolve(false), { once: true });
    });
    expect(opened).toBe(true);
    socket.close();
    const replay = await streamWithTicket('pi', id, ticket);
    expect(replay.status).toBe(401);
    expect((await replay.json() as any).code).toBe('AUTH_REQUIRED');
  });

  test('a ticket is bound to the tool and session it was issued for', async () => {
    const issued = await issueTicket(headersFor.owner!, 'pi', 'session-a', { mode: 'resume' });
    const ticket = String((await issued.json() as any).wsAuthTicket);
    expect((await streamWithTicket('pi', 'session-b', ticket)).status).toBe(401);
    expect((await streamWithTicket('codex', 'session-a', ticket)).status).toBe(401);
    // The misuse consumed nothing: a fresh ticket for the right session reaches the upgrade.
    const fresh = String((await (await issueTicket(headersFor.owner!, 'codex', 'session-a', { mode: 'resume' })).json() as any).wsAuthTicket);
    expect((await streamWithTicket('codex', 'session-a', fresh)).status).toBe(426);
  });

  test('a peer without drive gets observe tickets only, and needs the observe role for any', async () => {
    const observe = headersFor['observe peer']!;
    expect((await issueTicket(observe, 'pi', 'x')).status).toBe(201);
    for (const mode of ['resume', 'live']) {
      const refused = await issueTicket(observe, 'pi', 'x', { mode });
      expect(refused.status, mode).toBe(403);
      expect((await refused.json() as any).error).toBe('drive role required');
    }
    expect((await issueTicket(headersFor['drive peer']!, 'pi', 'x')).status).toBe(403);
    expect((await issueTicket(headersFor['paired device']!, 'pi', 'x', { mode: 'resume' })).status).toBe(201);
  });

  test('an integration credential gets no ticket, and ticket parameters are an allowlist', async () => {
    expect((await issueTicket(headersFor['Pi credential']!, 'pi', 'x')).status).toBe(401);
    const unknown = await issueTicket(headersFor.owner!, 'pi', 'x', { token: 'smuggled' });
    expect(unknown.status).toBe(400);
    expect((await unknown.json() as any).code).toBe('BAD_PARAM');
  });

  test('revoking a device invalidates the tickets it already holds', async () => {
    const doomed = await pairDevice(owner, { peerId: 'ticket-revoke-phone' });
    const peer = { 'x-cosyncing-peer-token': doomed.peerToken };
    const ticket = String((await (await issueTicket(peer, 'pi', 'x')).json() as any).wsAuthTicket);
    expect((await call('DELETE', `/api/transport/peers/${doomed.peerId}`, headersFor.owner!)).status).toBe(200);
    const used = await streamWithTicket('pi', 'x', ticket);
    expect(used.status).toBe(401);
    expect((await call('GET', '/api/sessions', peer)).status).toBe(401);
  });
});

// ── Control boundaries on a live session ───────────────────────────────────

describe('control boundaries', () => {
  test('a crafted permission mode, an unadvertised model and malformed attachments never reach the agent', async () => {
    const advertised = { providerID: 'managed:kimi-code', modelID: 'kimi-code/k3-256k', label: 'K3-256k' };
    const { id } = await openPiSession('control', { models: [advertised] });
    const stream = await owner.attach('pi', id, { mode: 'resume' });
    await stream.waitForKind('history');

    const refusals: Array<[Record<string, unknown>, string]> = [
      [{ permissionMode: 'crafted-native-bypass' }, 'PERMISSION_MODE_UNSUPPORTED'],
      [{ model: { providerID: advertised.providerID, modelID: `${advertised.modelID}\n` } }, 'MODEL_UNSUPPORTED'],
      [{ model: { providerID: advertised.providerID, modelID: 'kimi-code/k3-unadvertised' } }, 'MODEL_UNSUPPORTED'],
      [{ images: {} }, 'ATTACHMENT_INVALID'],
      [{
        images: Array.from({ length: 9 }, () => ({
          data: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'),
          mimeType: 'image/png',
        })),
      }, 'ATTACHMENT_LIMIT_EXCEEDED'],
    ];
    for (const [fields, code] of refusals) {
      const reply = await stream.sendAndAwait({ kind: 'prompt', text: 'must not reach Pi', ...fields });
      expect(reply.kind, code).toBe('nack');
      expect(reply.code).toBe(code);
    }

    // The sentinel: an exact advertised model is accepted, and it is the only
    // thing the agent's command queue ever received.
    const accepted = await stream.sendAndAwait({
      kind: 'prompt',
      text: 'the only prompt Pi may see',
      model: { providerID: advertised.providerID, modelID: advertised.modelID },
    });
    expect(accepted.kind).toBe('ack');
    const commands = await call('GET', `/pi/bridge/commands?id=${encodeURIComponent(id)}`, headersFor['Pi credential']!);
    const queued = (await commands.json() as any).commands as any[];
    expect(JSON.stringify(queued)).not.toContain('must not reach Pi');
    expect(queued.find((command) => command.kind === 'set-model')).toMatchObject({
      providerID: advertised.providerID,
      modelID: advertised.modelID,
    });
    expect(queued.find((command) => command.kind === 'prompt')?.text).toBe('the only prompt Pi may see');
    stream.close();
  });

  test('Observe leaves the workspace byte-identical, and only an explicit send-file makes an artifact', async () => {
    const { id, cwd } = await openPiSession('observe-workspace');
    writeFileSync(join(cwd, 'seed.txt'), 'preserve me');
    const before = snapshotTree(cwd);
    const stream = await owner.attach('pi', id);
    await stream.waitForKind('history');
    expect(snapshotTree(cwd)).toEqual(before);
    expect(existsSync(join(cwd, '.cosyncing'))).toBe(false);

    // Bare writes into the workspace are not deliverables.
    writeFileSync(join(cwd, 'unclaimed.txt'), 'not an artifact');
    writeFileSync(join(cwd, 'unclaimed.html'), '<h1>not an artifact</h1>');
    // A symlinked directory cannot carry send-file outside the workspace.
    const outside = join(broker.paths.root, 'outside-workspace');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'outside workspace');
    symlinkSync(outside, join(cwd, 'link-out'));
    const pi = headersFor['Pi credential']!;
    const escaped = await call('POST', '/pi/bridge/send-file', pi, { id, path: join(cwd, 'link-out', 'secret.txt') });
    expect(escaped.status).toBe(400);

    writeFileSync(join(cwd, 'result.txt'), 'explicit output');
    expect((await call('POST', '/pi/bridge/send-file', pi, { id, path: join(cwd, 'result.txt') })).status).toBe(200);
    await stream.waitForMessage((message) => message.type === 'file-artifact' && message.name === 'result.txt');
    const artifacts = stream.messages().filter((message) => message.type === 'file-artifact').map((message) => message.name);
    expect(artifacts).toEqual(['result.txt']);
    stream.close();
  });
});

function snapshotTree(root: string): string[] {
  const out: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (lstatSync(path).isDirectory()) {
        out.push(`${rel}/`);
        walk(path, rel);
      } else {
        out.push(`${rel}:${readFileSync(path).toString('base64')}`);
      }
    }
  };
  walk(root, '');
  return out;
}

// ── Workspace exposure ─────────────────────────────────────────────────────

describe('workspace exposure', () => {
  test('the owner alone changes it, only with an explicit confirmation; devices may read it', async () => {
    const endpoint = '/api/broker/features/workspace-browsing';
    const state = await call('GET', endpoint, headersFor.owner!);
    expect(state.status).toBe(200);
    expect((await state.json() as any).enabled).toBe(true);
    expect((await call('GET', endpoint, headersFor['paired device']!)).status).toBe(200);
    expect((await call('POST', endpoint, headersFor['paired device']!, {
      enabled: true, confirmRemoteFileAccess: true,
    })).status).toBe(403);
    // Unchanged with the confirmation: accepted, and nothing to restart.
    const unchanged = await call('POST', endpoint, headersFor.owner!, { enabled: true, confirmRemoteFileAccess: true });
    expect(unchanged.status).toBe(200);
  });

  test('locally enabled workspace browsing and transcript export pass the HTTP feature gate', async () => {
    expect((await call('GET', '/api/sessions/codex/missing/fs', headersFor.owner!)).status).toBe(404);
    expect((await call('POST', '/api/sessions/opencode/missing/export/preflight', headersFor.owner!, {})).status).toBe(404);
  });
});

// ── The tokenless development baseline ─────────────────────────────────────

describe('tokenless source broker on loopback', () => {
  let open: Broker;
  beforeAll(async () => {
    open = await startBroker({ name: 'auth-tokenless', env: { COSYNCING_RESTART_DRY_RUN: '1' } });
  });
  afterAll(() => open?.stop());

  test('mutations are open, but Drive resume and live takeover still demand a credential', async () => {
    const client = open.client();
    const sync = await client.post('/api/agents/codex/sync', { enabled: false });
    expect([200, 202]).toContain(sync.status);
    expect((await fetch(`${open.url}/api/sessions/codex/missing/stream`)).status).toBe(426);
    const resume = await client.get('/api/sessions/codex/missing/stream?mode=resume');
    expect(resume.status).toBe(401);
    expect(resume.body.code).toBe('RESUME_AUTH_REQUIRED');
    const takeover = await client.get('/api/sessions/codex/missing/stream?mode=live&reason=takeover');
    expect(takeover.status).toBe(401);
    expect(takeover.body.code).toBe('RESUME_AUTH_REQUIRED');
  });

  test('workspace files and transcript export stay closed to HTTP clients unless configured', async () => {
    const fs = await open.client().get('/api/sessions/codex/missing/fs');
    expect(fs.status).toBe(403);
    expect(fs.body.code).toBe('FS_REMOTE_DISABLED');
    const exported = await open.client().post('/api/sessions/opencode/missing/export/preflight', {});
    expect(exported.status).toBe(403);
    const browsing = await open.client().get('/api/broker/features/workspace-browsing');
    expect(browsing.body.enabled).toBe(false);
    const unconfirmed = await open.client().post('/api/broker/features/workspace-browsing', { enabled: true });
    expect(unconfirmed.status).toBe(400);
  });
});

// ── Repeated authentication failures, and ticket expiry ────────────────────

describe('a broker with short-lived tickets', () => {
  let fresh: Broker;
  beforeAll(async () => {
    fresh = await startBroker({
      name: 'auth-short',
      token: true,
      env: { COSYNCING_TEST_WS_TICKET_TTL_MS: '300', COSYNCING_RESTART_DRY_RUN: '1' },
    });
  });
  afterAll(() => fresh?.stop());

  async function securityAlerts(): Promise<any[]> {
    const events = await fresh.client().get('/api/attention-events?clientId=auth-e2e');
    expect(events.status).toBe(200);
    return (events.body.events as any[]).filter((event) => event.kind === 'security-alert');
  }

  test('a burst of failed authentications raises one content-free security alert', async () => {
    const anonymous = fresh.client({ kind: 'none' });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await anonymous.get('/api/sessions')).status).toBe(401);
    }
    // Sentinel: a later, unrelated event is visible, and still no alert.
    await pairDevice(fresh.client(), { peerId: 'storm-sentinel' });
    const afterFour = await fresh.client().get('/api/attention-events?clientId=auth-e2e');
    expect((afterFour.body.events as any[]).some((event) => event.kind === 'device-paired')).toBe(true);
    expect(await securityAlerts()).toEqual([]);

    expect((await anonymous.get('/api/sessions')).status).toBe(401);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await fresh.client({ kind: 'owner', token: 'wrong-token' }).get('/api/agents');
    }
    const alerts = await eventually(async () => {
      const found = await securityAlerts();
      return found.length > 0 ? found : undefined;
    }, { what: 'a repeated-authentication-failure alert' });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toBe('Repeated broker authentication failures');
    expect(alerts[0].severity).toBe('action-required');
    const wire = JSON.stringify(alerts[0]);
    expect(wire).not.toContain('wrong-token');
    expect(wire).not.toContain('127.0.0.1');
    expect(wire).not.toContain(fresh.paths.root);
  });

  test('an unused ticket expires', async () => {
    const issued = await fresh.client().post('/api/ws-auth-tickets', { tool: 'pi', sessionId: 'x', params: {} });
    expect(issued.status).toBe(201);
    const expiresAt = Date.parse(issued.body.expiresAt);
    await eventually(() => Date.now() > expiresAt + 50, { what: 'the ticket lifetime to pass' });
    const used = await fetch(`${fresh.url}/api/sessions/pi/x/stream?wsAuthTicket=${encodeURIComponent(issued.body.wsAuthTicket)}`);
    expect(used.status).toBe(401);
  });
});
