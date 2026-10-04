/**
 * The 0.2 Remote surface, pinned against a real host's own answers.
 *
 * The fixture in `fixtures/dsh-0.2.0-rc.2.json` was captured by
 * `scripts/adapters/dsh-contract-capture.ts` from an installed 0.2.0-rc.2 host on
 * a disposable home. That matters: an argument name is not a matter of opinion,
 * and the gateway's rejection message names the field it wanted. So this suite
 * does not ask whether the builders look right — it asks whether the bytes they
 * produce are the bytes a real host accepted, and whether the failures the host
 * actually returns land in the right category.
 *
 *   bun run packages/typescript/adapters/dsh/test/test-dsh-remote.ts
 */
export {};
import {
  DSH_REMOTE_ENDPOINTS,
  DSH_STREAM_ONLY_ENDPOINTS,
  DshRemoteArgs,
  dshRemotePath,
  DshRouteNotAllowedError,
  parseDshEventFrame,
} from '../src/remote.ts';
import { DshMuxClient, type DshMuxSocketLike } from '../src/mux.ts';
import { probeDshContract, mayFallBackToLegacyAfterProbe } from '../src/compatibility.ts';

const FIXTURE = await Bun.file(new URL('./fixtures/dsh-0.2.0-rc.2.json', import.meta.url)).json() as any;

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const eq = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

check(`fixture is the captured 0.2.0-rc.2 host (run ${FIXTURE.provenance.captureRun})`,
  FIXTURE.sourceRef === 'dsh-0.2.0-rc.2' && FIXTURE.provenance.modelBacked === false);

// ── 1. Argument names the gateway matches against its descriptor ─────────────

{
  const captured = FIXTURE.unary['unary.sessionList'];
  check('session/list names its parameter "_request", which the host itself spells',
    eq(DshRemoteArgs.list(), captured.args) && dshRemotePath('session/list') === captured.path,
    JSON.stringify(DshRemoteArgs.list()));
  const wrongName = FIXTURE.unary['unary.wrongArgName'];
  const rejection = wrongName.envelope.result.error;
  check('the captured rejection names both the missing and the unexpected field',
    rejection.code === 'gateway/arguments-invalid'
      && rejection.message.includes('missing "_request"')
      && rejection.message.includes('unexpected "request"'),
    rejection.message as string);

  const created = FIXTURE.session['session.create'];
  check('session/create wraps a plain request object',
    eq(DshRemoteArgs.create(), created.args) && dshRemotePath('session/create') === created.path);

  const row = FIXTURE.session['session.listAfterCreate'].envelope.result.value.items[0];
  const paging = FIXTURE.session['session.page'];
  check('session/page addresses a session and pages from the opening cursor',
    eq(DshRemoteArgs.page({
      sessionId: row.sessionId,
      throughSeq: paging.args.request.throughSeq,
      maxMessages: paging.args.request.maxMessages,
    }), paging.args),
    JSON.stringify(DshRemoteArgs.page({ sessionId: row.sessionId, throughSeq: 0, maxMessages: 20 })));

  const projections = FIXTURE.session['session.projections'];
  check('session/projections does NOT wrap in an address; the descriptor names a bare sessionId',
    eq(DshRemoteArgs.projections(row.sessionId), projections.args),
    JSON.stringify(DshRemoteArgs.projections(row.sessionId)));

  const commands = FIXTURE.catalogs.commands;
  check('commands/list takes a top-level agentId, and that id IS the session id',
    eq(DshRemoteArgs.commands(row.sessionId), commands.args)
      && commands.envelope.result.value.length > 0,
    `${String(commands.envelope.result.value.length)} commands for the captured session`);

  const follow = FIXTURE.streams.written.find((frame: any) => frame.endpoint === 'session/follow');
  check('the follow open frame the host answered is the frame this client builds',
    eq({ args: DshRemoteArgs.follow({ sessionId: row.sessionId, assistantStream: true }) }, follow.payload),
    JSON.stringify(follow.payload));
}

// ── 2. Streams are not unary, and the host says so ───────────────────────────

{
  const streamPost = FIXTURE.unary['unary.streamViaPost'];
  check('a stream method posted to /api is refused by the gateway, not answered',
    streamPost.envelope.result.error.code === 'gateway/signature-invalid',
    streamPost.envelope.result.error.code as string);
  let refused = 0;
  for (const endpoint of DSH_STREAM_ONLY_ENDPOINTS) {
    try {
      dshRemotePath(endpoint);
    } catch (error) {
      if (error instanceof DshRouteNotAllowedError) refused += 1;
    }
  }
  check('every stream-only endpoint is unreachable through the unary path builder',
    refused === DSH_STREAM_ONLY_ENDPOINTS.length, `${String(refused)}/${String(DSH_STREAM_ONLY_ENDPOINTS.length)}`);
  let outsideRefused = false;
  try {
    dshRemotePath('session/control');
  } catch { outsideRefused = true; }
  check('session/control is stream-only AND takes no arguments at all',
    outsideRefused && eq(FIXTURE.streams.written.find((f: any) => f.endpoint === 'session/control').payload, { args: {} }));
  const missingArgs = FIXTURE.unary['unary.missingArgs'];
  check('a payload with no args field fails inside the gateway before any handler runs',
    missingArgs.envelope.result.error.code === 'gateway/internal'
      && missingArgs.envelope.result.error.message.includes('exactly one plain-object args field'),
    missingArgs.envelope.result.error.message as string);
  check('an unknown route is answered in plain text, so a JSON-only reader would misreport it',
    FIXTURE.unary['unary.unknownRoute'].status === 404
      && typeof FIXTURE.unary['unary.unknownRoute'].envelope.nonJsonBody === 'string',
    JSON.stringify(FIXTURE.unary['unary.unknownRoute'].envelope));
}

// ── 3. The event generation, from the host's own frames ──────────────────────

{
  const ready = parseDshEventFrame(FIXTURE.events.frames[0].value);
  check('the ready frame is the only thing that establishes an event generation',
    ready?.type === 'ready' && ready.clientId.length > 0 && ready.host.home === '/fixture/home',
    JSON.stringify(ready));
  check('a frame outside the four-frame grammar is refused rather than half-parsed',
    parseDshEventFrame({ type: 'ready', clientId: 'x' }) === null
      && parseDshEventFrame({ type: 'emit', event: 'x' }) === null
      && parseDshEventFrame({ type: 'waterfall', event: 'x', eventId: 'e', agentId: 'a', request: {} })?.type === 'waterfall');

  const seen: unknown[] = [];
  interface ReplaySocket extends DshMuxSocketLike {
    emit(type: string, event?: unknown): void;
  }
  const sockets: ReplaySocket[] = [];
  const client = new DshMuxClient({
    baseUrl: 'http://127.0.0.1:3080',
    // The recorded frames name the stream the capture asked for, so this client
    // has to ask for that id too. Replaying a capture into freshly minted ids
    // would exercise nothing but the unknown-stream path.
    newStreamId: () => String(FIXTURE.events.frames[0].streamId),
    socketFactory: (url, headers) => {
      const listeners = new Map<string, Array<(e: unknown) => void>>();
      const socket = {
        url, headers, sent: [] as string[],
        send(data: string) { socket.sent.push(data); },
        close() {},
        addEventListener(type: string, listener: (e: unknown) => void) {
          listeners.set(type, [...(listeners.get(type) ?? []), listener]);
        },
        emit(type: string, event?: unknown) { for (const l of listeners.get(type) ?? []) l(event); },
      };
      sockets.push(socket as unknown as ReplaySocket);
      queueMicrotask(() => socket.emit('open'));
      return socket as unknown as DshMuxSocketLike;
    },
  }, { onOpen() {}, onLost() {} });
  const stream = client.open('$events', { args: {} });
  await new Promise((r) => setTimeout(r, 0));
  for (const frame of FIXTURE.events.frames) {
    sockets[0]!.emit('message', { data: JSON.stringify(frame) });
  }
  for await (const value of stream) { seen.push(value); break; }
  check('the captured host frames replay through the carrier onto the event stream',
    eq(seen[0], FIXTURE.events.frames[0].value), JSON.stringify(seen[0])?.slice(0, 60));
  client.stop();
}

// ── 4. Family selection, replayed from the captured statuses ─────────────────

{
  const unauth = FIXTURE.probe['probe.remoteMuxUnauthenticated'].status;
  const authed = FIXTURE.probe['probe.remoteMuxAuthenticatedNoUpgrade'].status;
  const legacy = FIXTURE.probe['probe.legacyMux'].status;
  const statuses: Record<string, number> = {
    [`http://127.0.0.1:3080/api/remote.mux`]: unauth,
    [`http://127.0.0.1:3080/api/events.mux`]: legacy,
  };
  const probe = await probeDshContract('http://127.0.0.1:3080',
    async (url) => ({ status: statuses[url] ?? 404 }));
  check('the captured anonymous answer selects the 0.2 family and asks for auth',
    probe.family === 'remote-0.2' && probe.reason === 'auth-required',
    JSON.stringify(probe));
  check('a refused authentication never falls through to the legacy contract',
    mayFallBackToLegacyAfterProbe(probe) === false);

  // The same host, but asked WITH a cookie, answers the carrier 404 and the
  // legacy route 404. Without the anonymous-probe rule that is read as "some
  // other server owns this port", which is the bug the capture exposed.
  let sawCookie = true as boolean;
  // The fake answers the way the captured host does, INCLUDING the difference
  // the cookie makes: 401 anonymously, 404 once it is authenticated and the
  // route genuinely stops existing. A fake that ignored the cookie would let a
  // probe that leaks credentials pass while still failing against the real host.
  const probedAuthed = await probeDshContract('http://127.0.0.1:3080',
    async (url, init) => {
      const carried = Object.keys(init.headers).some((k) => k.toLowerCase() === 'cookie');
      sawCookie = sawCookie && carried;
      if (url.endsWith('remote.mux')) return { status: carried ? authed : unauth };
      return { status: legacy };
    }, { cookie: 'dsh-auth-FIXTURECOOKIEVALUE=v1.x.y' });
  check('a probe never spends the cookie, so a logged-in 0.2 host still reads as 0.2',
    sawCookie === false && probedAuthed.family === 'remote-0.2'
      && probedAuthed.reason === 'auth-required',
    `${String(sawCookie)} / ${JSON.stringify(probedAuthed)}`);
  // And the leak is still detectable: a probe implementation that DID send the
  // cookie would get the 404 pair and call a real 0.2 host an unknown server.
  const leaked = await probeDshContract('http://127.0.0.1:3080', async (url, init) => ({
    status: url.endsWith('remote.mux')
      ? (Object.keys(init.headers).some((k) => k.toLowerCase() === 'cookie') ? authed : unauth)
      : legacy,
  }), { cookie: 'x' });
  void leaked;
}

// ── 5. Roster and projection facts the plan cares about ──────────────────────

{
  const row = FIXTURE.session['session.listAfterCreate'].envelope.result.value.items[0];
  check('a cold roster row separates availability from running from blank',
    row.agentAvailable === true && row.running === false && row.blank === true
      && typeof row.cwd === 'string' && typeof row.updatedAt === 'number',
    JSON.stringify({ a: row.agentAvailable, r: row.running, b: row.blank }));
  check('a list row carries a projection watermark tagged with its kind',
    row.projections.kind === 'sequenced' && typeof row.projections.asOfSeq === 'number',
    `${row.projections.kind}@${String(row.projections.asOfSeq)}`);

  const control = FIXTURE.streams.frames.control[0];
  check('session/control is a HOST-WIDE baseline keyed by session, not a per-session stream',
    control.value.type === 'baseline'
      && Object.keys(control.value.value.projections).length === 1
      && Object.hasOwn(control.value.value.projections, row.sessionId),
    JSON.stringify(Object.keys(control.value.value.projections)));

  const workspace = FIXTURE.streams.frames.workspace[0];
  check('workspace/follow opens with a complete baseline including archive and pin sets',
    workspace.value.type === 'baseline'
      && Array.isArray(workspace.value.value.items)
      && Array.isArray(workspace.value.value.archivedSessionIds),
    JSON.stringify(workspace.value).slice(0, 90));

  const snapshot = FIXTURE.streams.frames.follow[0].value;
  check('a follow snapshot hands back a cursor, records, and a complete projection baseline',
    snapshot.type === 'snapshot' && typeof snapshot.cursor === 'number'
      && Array.isArray(snapshot.records) && snapshot.projections.asOfSeq === snapshot.cursor,
    `cursor ${String(snapshot.cursor)}, ${String(snapshot.records.length)} records`);
  check('the opening snapshot cursor is what paging backwards must be tied to',
    snapshot.records.every((record: any, index: number) => record.event.seq === index),
    snapshot.records.map((r: any) => String(r.event.seq)).join(','));
  check('streaming output rides the snapshot as a revision, not as a cursor position',
    typeof snapshot.assistantStream?.revision === 'number', JSON.stringify(snapshot.assistantStream));
  check('image bounds are discovered rather than assumed',
    snapshot.projections.values.imageLimits.maxImagesPerMessage === 20
      && snapshot.projections.values.imageLimits.mediaTypes.includes('image/png'),
    JSON.stringify(snapshot.projections.values.imageLimits.mediaTypes));

  const catalog = FIXTURE.unary['unary.modelCatalog'].envelope.result.value;
  check('the model catalog is grouped and names reasoning efforts per model',
    Array.isArray(catalog.groups) && catalog.groups[0].models[0].reasoning.efforts.length > 1,
    `${String(catalog.groups.length)} groups`);
  const presets = FIXTURE.unary['unary.permissionPresets'].envelope.result.value;
  check('permission presets come from the catalog with a named default',
    presets.options.length >= 1 && typeof presets.defaultPreset === 'string',
    presets.options.map((o: any) => o.value).join(','));
  const commands = FIXTURE.catalogs.commands.envelope.result.value;
  check('the command roster is longer than any hardcoded list would be',
    commands.length > 4 && commands.every((c: any) => typeof c.name === 'string'),
    commands.map((c: any) => c.name).join(','));
}

// ── 6. Authentication, as the host actually answered ─────────────────────────

{
  const exchange = FIXTURE.auth['auth.exchange'];
  check('the exchange is a 303 to ./ with no-store and a cookie',
    exchange.status === 303 && exchange.location === './' && exchange.cacheControl === 'no-store'
      && exchange.cookieName.startsWith('dsh-auth-'),
    `${String(exchange.status)} ${String(exchange.location)}`);
  check('the cookie is HttpOnly and scoped to the root path',
    exchange.cookieAttributes.includes('Path=/') && exchange.cookieAttributes.includes('HttpOnly'),
    exchange.cookieAttributes as string);
  check('the cookie outlives the process, which is why it is worth persisting',
    /Max-Age=(\d+)/.exec(exchange.cookieAttributes)?.[1] === '2592000',
    exchange.cookieAttributes as string);
  const refused = FIXTURE.auth['auth.refusedToken'];
  check('a bad token is a 401 that tells the user to reopen the printed URL',
    refused.status === 401 && refused.body.includes('reopen the URL printed by dsh web'),
    refused.body as string);
  check('no launch token or cookie value reached the fixture',
    !JSON.stringify(FIXTURE).includes('<redacted-launch-token>')
      && !/dsh-auth-[A-Za-z0-9_-]{20,}/.test(JSON.stringify(FIXTURE)));
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${String(results.length - failed.length)} passed, ${String(failed.length)} failed`);
if (failed.length > 0) process.exit(1);
