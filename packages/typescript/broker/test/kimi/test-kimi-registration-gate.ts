#!/usr/bin/env bun
/**
 * Kimi registration: unconditional, and filtered per client.
 *
 * Registration used to hide behind `COSYNCING_ENABLE_KIMI`, because
 * `/api/agents` was not revision-filtered: one Kimi row made any client that
 * decodes `IntegrationKind` strictly throw, and a single unknown row aborts the
 * WHOLE roster decode, so such a client lost every agent — Kimi installed or
 * not. A flag answered that by denying Kimi to everyone, including the clients
 * that could read it perfectly well and a managed service that could never set
 * it. The route now answers the same question per client, against each
 * adapter's declared minimum revision.
 *
 * `COSYNCING_KIMI_DRIVE` is gone with it. It was a controlled-rollout gate for
 * the write surface, and a second configuration of the adapter that nobody was
 * expected to set — so the surface most users would meet was the one that never
 * shipped. Drive is now an ordinary capability, permitted per session by
 * ownership and the requested attach mode, which is what was doing the real
 * safety work all along.
 *
 * Proved against a REAL broker over its real `/api/agents` and create routes
 * rather than by reading the registration source, because "is the row served"
 * and "does the create button work" are the only forms of the question that
 * matter to those clients.
 *
 *   bun run packages/typescript/broker/test/kimi/test-kimi-registration-gate.ts
 */
export {};
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureProcessOutput,
  isolatedBrokerFixtureEnvironment,
  startHealthyFixtureBroker,
} from '../helpers/isolated-broker-fixture.ts';
import {
  rosterRepresentationKey,
  rosterVisibility,
  visibleSessions,
} from '../../src/runtime/roster-visibility.ts';
import {
  ATTACH_MODES_KNOWN_BEFORE_TOLERANT_DECODE,
  BROKER_CONTRACT_REVISION,
  CLIENT_REVISION_WITH_TOLERANT_ATTACH_MODE_DECODE,
  CLIENT_REVISION_WITH_TOLERANT_INTEGRATION_KIND_DECODE,
} from '@cosyncing/protocol';
import { agentSummaries } from '../../src/installation/setup.ts';
import { setupMessages } from '../../src/installation/setup-i18n.ts';
import { defaultDoctorAdapters } from '../../src/installation/doctor.ts';
import { brokerServiceEnvironmentEntries } from '../../src/installation/service-manager.ts';
import { managedHostServiceEnvironmentEntries } from '../../src/installation/shipped-adapters.ts';

const ROOT = join(import.meta.dir, '../../../../..');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'cosyncing-kimi-gate-fixture-'));
const home = mkdtempSync(join(tmpdir(), 'cosyncing-kimi-gate-home-'));

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate a free TCP port');
  const { port } = address;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function spawnBroker(port: number, env: Record<string, string>) {
  return Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    cwd: ROOT,
    // A scrubbed fixture environment, never ...process.env: an inherited
    // developer environment lets the broker reach real host agent state.
    env: isolatedBrokerFixtureEnvironment(fixtureRoot, {
      overrides: {
        HOST: '127.0.0.1',
        PORT: String(port),
        COSYNCING_HOME: home,
        COSYNCING_RESTART_DRY_RUN: '1',
        COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
        COSYNCING_CLAUDE_HOOKS: '0',
        ...env,
      },
    }),
    stdin: 'ignore',
    // PIPED, not ignored, and drained by the caller. Silence is evidence: the
    // shared starter only retires and respawns a stalled start once it can
    // prove the process wrote nothing, and a discarded stream proves nothing.
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function stopBroker(broker: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (broker.exitCode === null) broker.kill('SIGTERM');
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let exited = await Promise.race([broker.exited.then(() => true).catch(() => true), sleep(5_000).then(() => false)]);
  if (!exited && broker.exitCode === null) {
    broker.kill('SIGKILL');
    exited = await Promise.race([broker.exited.then(() => true).catch(() => true), sleep(5_000).then(() => false)]);
  }
  if (!exited) throw new Error('broker did not exit after SIGTERM/SIGKILL');
}

/** One real broker, one question. Each spawn is expensive, so each one answers everything it can. */
async function withBroker<T>(env: Record<string, string>, ask: (base: string) => Promise<T>): Promise<T> {
  // Through the shared starter, so a lost port race costs a respawn rather than
  // the suite: the reservation releases the port before the child binds it, and
  // a sibling fixture doing the same thing can take it in between.
  let output!: ReturnType<typeof captureProcessOutput>;
  const { child: broker, port } = await startHealthyFixtureBroker({
    reservePort: freePort,
    spawn: (attemptPort) => {
      const spawned = spawnBroker(attemptPort, env);
      output = captureProcessOutput(spawned, { maxChars: 4_000 });
      return spawned as unknown as { exitCode: number | null; exited: Promise<number> };
    },
    healthUrl: (attemptPort) => `http://127.0.0.1:${attemptPort}/api/health`,
    capture: () => output,
    stop: (child) => stopBroker(child as unknown as ReturnType<typeof Bun.spawn>),
  });
  try {
    return await ask(`http://127.0.0.1:${port}`);
  } finally {
    await stopBroker(broker as unknown as ReturnType<typeof Bun.spawn>);
  }
}

/**
 * The roster as a client of a given contract revision receives it.
 *
 * `revision` omitted models a client built before the parameter existed, which
 * is the case the filtering exists to protect.
 */
async function agentRows(base: string, revision?: string): Promise<Array<Record<string, unknown>>> {
  const query = revision === undefined ? '' : `?contractRevision=${encodeURIComponent(revision)}`;
  const response = await fetch(`${base}/api/agents${query}`);
  if (!response.ok) throw new Error(`/api/agents answered ${response.status}`);
  return await response.json() as Array<Record<string, unknown>>;
}

/** What the create route answers for a tool. The status and the message are both the contract. */
async function createKimiSession(base: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/api/sessions/kimi`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ directory: '/tmp' }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
}

async function rosterAgents(
  env: Record<string, string>,
  revision?: string,
): Promise<Array<Record<string, unknown>>> {
  return withBroker(env, (base) => agentRows(base, revision));
}

/**
 * The revision this adapter's floor is, and the one it is deliberately NOT.
 *
 * Kimi needs the INTEGRATION-KIND tolerance and nothing later: `http-websocket`
 * is the one value in its row a released client could fail to decode, and both
 * its attach modes predate either fallback. Pinning the floor at the newer
 * attach-mode tolerance instead would hide the agent from every client of the
 * generation in between, all of which decode the row perfectly.
 */
const FLOOR = String(CLIENT_REVISION_WITH_TOLERANT_INTEGRATION_KIND_DECODE);
const LATER_TOLERANCE = String(CLIENT_REVISION_WITH_TOLERANT_ATTACH_MODE_DECODE);

try {
  // ── The filter, on ONE broker with no flags at all ────────────────────────
  //
  // Every case below comes from the same default broker, which is the whole
  // point: registration no longer varies with the environment, only the view
  // does. A pre-tolerance client is protected without anyone setting anything,
  // and a current client is served without anyone setting anything either.
  const {
    legacy, current, older, later, noncanonical,
  } = await withBroker({}, async (base) => ({
    legacy: await agentRows(base),
    current: await agentRows(base, FLOOR),
    older: await agentRows(base, String(CLIENT_REVISION_WITH_TOLERANT_INTEGRATION_KIND_DECODE - 1)),
    later: await agentRows(base, LATER_TOLERANCE),
    // Every spelling `Number()` would have accepted as a revision at or above
    // the floor. Each one is a client whose encoding this broker does not
    // recognize, claiming a decode ability the roster would then act on.
    noncanonical: await Promise.all(
      ['not-a-number', '', '0xF', '1e2', ` ${FLOOR} `, `+${FLOOR}`, `0${FLOOR}`, 'Infinity']
        .map(async (raw) => [raw, await agentRows(base, raw)] as const),
    ),
  }));
  const idsOf = (rows: Array<Record<string, unknown>>) => rows.map((row) => String(row.id));
  const withoutIds = idsOf(legacy);
  const withIds = idsOf(current);

  check('a client that declares nothing is served no kimi row',
    !withoutIds.includes('kimi'), withoutIds.join(','));
  check('a client one revision too old is served no kimi row',
    !idsOf(older).includes('kimi'), idsOf(older).join(','));
  // Fail closed on nonsense rather than 400: refusing the request would cost
  // the caller every agent, which is the failure this filtering prevents. The
  // grammar has to be exactly as narrow as the policy claims — `0xF` and `1e2`
  // are both ≥ the floor to `Number`, and neither is a revision.
  const leaked = noncanonical.filter(([, rows]) => idsOf(rows).includes('kimi')).map(([raw]) => raw);
  check('every non-canonical revision spelling is read as the oldest client, not rejected',
    leaked.length === 0, leaked.map((raw) => JSON.stringify(raw)).join(','));
  check('a client at the tolerant revision IS served the kimi row',
    withIds.includes('kimi'), withIds.join(','));
  // The floor is a MINIMUM, not an equality: a newer client is served too.
  check('a client past the floor is still served the kimi row',
    idsOf(later).includes('kimi'), idsOf(later).join(','));
  // The filter withholds ONLY what it must. An agent every client can decode is
  // never collateral, in either view.
  check('the established agents are served to both, filtered and unfiltered',
    ['opencode', 'pi', 'codex', 'claude'].every((id) =>
      withoutIds.includes(id) && withIds.includes(id)),
    `${withoutIds.join(',')} | ${withIds.join(',')}`);
  // Kimi and dsh both declare the same minimum, so the tolerant view adds
  // exactly those two. Asserted as a set difference rather than a count, so a
  // third gated agent later fails this loudly instead of sliding past a number.
  check('the tolerant view adds exactly the agents that declare a minimum',
    JSON.stringify(withIds.filter((id) => !withoutIds.includes(id)).sort()) === '["dsh","kimi"]'
      && withoutIds.every((id) => withIds.includes(id)),
    `${withoutIds.join(',')} -> ${withIds.join(',')}`);

  // ── The served row, on a broker with no flags at all ──────────────────────
  //
  // This is now the ONLY posture: there is no second configuration of the
  // adapter, so the surface asserted here is the surface every user meets.
  const { rows: served, create: createOnHostlessMachine } = await withBroker(
    {},
    async (base) => ({ rows: await agentRows(base, FLOOR), create: await createKimiSession(base) }),
  );

  // The served row is what a client decodes, so assert the wire posture rather
  // than the adapter's in-process capabilities object.
  const kimiRow = served.find((row) => String(row.id) === 'kimi');
  const capabilities = kimiRow?.capabilities as Record<string, unknown> | undefined;
  check('the served kimi row advertises observe FIRST, with live attach and model switching',
    capabilities?.integrationKind === 'http-websocket'
      // Observe leads: it is the mode EVERY Kimi session supports. Drive is
      // reachable only for a session cosyncing created in this broker process.
      && JSON.stringify(capabilities?.attachModes) === '["observe","live"]'
      && capabilities?.supportsObserve === true
      // The adapter never owns the Kimi process, so there is nothing to resume
      // into.
      && capabilities?.supportsResume === false
      && capabilities?.supportsLiveAttach === true
      && capabilities?.supportsModelSwitch === true
      && capabilities?.permissionGranularity === 'per-session',
    JSON.stringify(capabilities));
  check('the served kimi row advertises native file input and still no artifact signal',
    capabilities?.supportsNativeFileInput === true
      && capabilities?.supportsNativeArtifact === false,
    JSON.stringify(capabilities));
  // `canSelectModelAtCreation` is derived from HOOK PRESENCE
  // (`runtime.ts:5136-5139`) and proves the create surface is genuinely wired.
  // `canCreateSession` is FALSE on this machine anyway, and that pairing is the
  // point: the route derives it as "the hook exists AND the adapter says it can
  // create right now", and this fixture host runs no `kimi web`, so the
  // adapter's live probe correctly answers no.
  check('create-time model selection and native rename are wired, and no other write-class action is',
    kimiRow?.canSelectModelAtCreation === true
      && kimiRow?.canCreateSession === false
      && kimiRow?.canRenameNative === true
      && kimiRow?.canFork === false && kimiRow?.canClone === false
      && kimiRow?.canTranscriptExport === false,
    JSON.stringify(kimiRow));
  // The route the create button hits, and the answer CHANGED with the gate.
  // It used to be 400 "tool 'kimi' cannot create sessions" — a permanent
  // statement about the tool, produced by the absent hook. The tool can create
  // sessions now, so the honest refusal is about the missing host: temporary
  // and retryable.
  //
  // And it must NOT tell the user to start one. The broker starts and supervises
  // that host itself wherever it is authorized to, which the installed service
  // is by default, so `kimi web` in a user-facing failure races the managed
  // startup and invites a second server on the same home — the ambiguity the
  // whole ownership proof exists to prevent.
  check('the create route refuses a hostless machine as temporary and retryable',
    createOnHostlessMachine.status === 503
      && createOnHostlessMachine.body.code === 'SESSION_CREATE_TEMPORARILY_UNAVAILABLE'
      && createOnHostlessMachine.body.detailCode === 'kimi-server-unavailable'
      && createOnHostlessMachine.body.retryable === true,
    `${createOnHostlessMachine.status} ${JSON.stringify(createOnHostlessMachine.body)}`);
  check('...and never instructs the user to start a competing host',
    !String(createOnHostlessMachine.body.error).includes('kimi web')
      && String(createOnHostlessMachine.body.error).includes('cosyncing doctor'),
    String(createOnHostlessMachine.body.error));

  // ── The floor is 14 because of what the row CONTAINS ──────────────────────
  //
  // The declared minimum is a claim about decodability, and this is the claim's
  // evidence: every attach mode Kimi publishes — in EITHER drive posture, since
  // the gate changes the row — predates both tolerance fallbacks, so the
  // integration kind is the only thing forcing a floor at all. Adding a newer
  // attach mode without raising the minimum would hand a revision-14 client a
  // row it cannot decode, and it would fail HERE rather than in the field.
  const publishedModes = (capabilities?.attachModes as unknown[] ?? []).map(String);
  const needingTolerance = publishedModes.filter(
    (mode) => !ATTACH_MODES_KNOWN_BEFORE_TOLERANT_DECODE.includes(mode as never));
  check('every attach mode kimi publishes predates the attach-mode tolerance',
    publishedModes.length > 0 && needingTolerance.length === 0,
    `published=${publishedModes.join(',')} needing-tolerance=${needingTolerance.join(',')}`);

  // The durable service environment is a closed enumerated list, and what is in
  // it is what an INSTALLED cosyncing can do. Registration needs nothing in it —
  // a managed broker serves Kimi to any client that can decode it — and the
  // drive gate is gone rather than excluded. What must be there is managed-host
  // activation: without it the installed service can use a `kimi web` the
  // operator keeps running by hand, but cannot start one, recover a crashed one,
  // or stop the one it started.
  const serviceEnvironment = brokerServiceEnvironmentEntries({
    homeDir: '/fixture/home',
    stateHome: '/fixture/state',
    cacheRoot: '/fixture/cache',
    executablePath: '/fixture/bin/cosyncing',
    webDir: '/fixture/web',
  }).map(([name]) => name);
  check('the durable service environment activates managed hosts for every external-host agent',
    managedHostServiceEnvironmentEntries().length > 0
      && managedHostServiceEnvironmentEntries().every(([name]) => serviceEnvironment.includes(name)),
    serviceEnvironment.join(','));
  // Derived from what adapters DECLARE, never from a list of tool names, so an
  // adapter that gains an external host is managed without editing the service
  // environment — and one that never had a host is not handed a variable.
  check('managed-host activation is derived from the adapters, not from tool names',
    JSON.stringify(managedHostServiceEnvironmentEntries(defaultDoctorAdapters({})))
      === JSON.stringify(managedHostServiceEnvironmentEntries())
      && managedHostServiceEnvironmentEntries().every(([, value]) => value === '1'),
    JSON.stringify(managedHostServiceEnvironmentEntries()));
  // The retired gates leave nothing behind: a stale name in this list would be
  // dead configuration an operator could still find and set.
  check('no retired kimi rollout gate survives in the durable environment',
    !serviceEnvironment.some((name) => name.includes('ENABLE_KIMI') || name.includes('KIMI_DRIVE')),
    serviceEnvironment.join(','));

  // Doctor diagnoses Kimi unconditionally, and no longer varies with the
  // environment at all. It reports what is installed and reachable, and "the
  // host is not running" is precisely what an operator opened it to be told —
  // an adapter that vanishes unless a variable is set cannot report that.
  const doctorDefault = defaultDoctorAdapters({}).map((adapter) => adapter.id);

  // ── the same visibility decision, applied to the SESSION roster and its cache ─
  //
  // Filtering the agent list alone was half a fix. A client told an agent does
  // not exist was still sent that agent's sessions — rows for a tool it has no
  // capabilities for and cannot attach to — and once those are filtered, a
  // roster cache keyed by time window alone would serve one client's projection
  // (or a 304 for it) to another.
  {
    const backends = [
      { id: 'codex' },
      { id: 'kimi', minimumClientRevision: Number(FLOOR) },
      { id: 'dsh', minimumClientRevision: Number(FLOOR) },
    ];
    const old = rosterVisibility(backends, Number(FLOOR) - 1);
    const current = rosterVisibility(backends, Number(FLOOR));
    check('a client below the floor is shown neither the agent nor a single one of its sessions',
      !old.tools.has('kimi') && old.tools.has('codex')
        && visibleSessions(
          [{ tool: 'codex', id: 'a' }, { tool: 'kimi', id: 'b' }, { tool: 'dsh', id: 'c' }],
          old,
        ).map((session) => session.id).join(',') === 'a',
      JSON.stringify([...old.tools]));
    check('a client at the floor is shown both, and its sessions come with them',
      current.tools.has('kimi') && current.tools.has('dsh')
        && visibleSessions(
          [{ tool: 'codex', id: 'a' }, { tool: 'kimi', id: 'b' }],
          current,
        ).map((session) => session.id).join(',') === 'a,b',
      JSON.stringify([...current.tools]));
    // Deltas UPDATE that snapshot, so they carry the same visibility or they
    // undo it: one delta mentioning a hidden agent's session reintroduces
    // exactly the row the snapshot withheld, and the client then holds a session
    // for an agent it was told does not exist. Removals are dropped too — a
    // removal for a session it never had is noise at best.
    const deltas = [
      { tool: 'codex', sessionId: 'a' },
      { tool: 'kimi', sessionId: 'b' },
      { tool: 'dsh', sessionId: 'c', removed: true as const },
    ];
    check('roster deltas for a hidden agent never reach a client that cannot decode it',
      visibleSessions(deltas, old).map((delta) => delta.sessionId).join(',') === 'a'
        && visibleSessions(deltas, current).map((delta) => delta.sessionId).join(',') === 'a,b,c',
      JSON.stringify(visibleSessions(deltas, old)));

    // The cache key is what stops those two projections colliding. Same window,
    // different visibility, therefore different entry — and an ETag computed
    // over one body can never be matched against the other.
    check('two clients with different visibility cannot share one cached roster representation',
      rosterRepresentationKey('7d', old) !== rosterRepresentationKey('7d', current),
      `${rosterRepresentationKey('7d', old)} vs ${rosterRepresentationKey('7d', current)}`);
    // ...but clients that CAN see the same agents still share one, which is the
    // reason the key is the projection rather than the revision.
    check('clients at different revisions that see the same agents still share one representation',
      rosterRepresentationKey('7d', rosterVisibility(backends, Number(LATER_TOLERANCE)))
        === rosterRepresentationKey('7d', current),
      rosterRepresentationKey('7d', current));
    // Registration order is not part of the identity.
    check('the projection key is order-independent, so registration order cannot fragment the cache',
      rosterRepresentationKey('7d', rosterVisibility([...backends].reverse(), Number(FLOOR)))
        === rosterRepresentationKey('7d', current),
      rosterRepresentationKey('7d', current));
  }


  // ── the same visibility, proved over the REAL routes ───────────────────────
  //
  // Helper-level proof is not enough here: the defect this replaces was three
  // roster consumers disagreeing about which revision they spoke for, and only
  // a request against a running broker can show what each route actually
  // returns. A stub PEER supplies the Kimi session, so no Kimi host is involved.
  {
    const peerPort = await freePort();
    const peerToken = 'fixture-peer-token';
    let peerAskedRevision: string | null = null;
    const peer = Bun.serve({
      hostname: '127.0.0.1',
      port: peerPort,
      fetch(request) {
        const requested = new URL(request.url);
        if (requested.pathname !== '/api/sessions') {
          return Response.json({ error: 'not found' }, { status: 404 });
        }
        peerAskedRevision = requested.searchParams.get('contractRevision');
        // A real peer is a broker, so it filters its roster to what the CALLER
        // declared it can decode. Modelling that is the point: a broker that
        // asks bare is served no Kimi session by any real peer, and a stub that
        // answered generously would hide exactly that.
        const asked = Number(requested.searchParams.get('contractRevision') ?? '0');
        const canDecodeKimi = Number.isSafeInteger(asked)
          && asked >= CLIENT_REVISION_WITH_TOLERANT_INTEGRATION_KIND_DECODE;
        return Response.json({
          machine: 'fixture-peer',
          generatedAt: Date.now(),
          sessions: [
            { id: 'peer-codex', tool: 'codex', title: 'Peer codex', status: 'idle', attachMode: 'observe' },
            ...(canDecodeKimi
              ? [{ id: 'peer-kimi', tool: 'kimi', title: 'Peer kimi', status: 'idle', attachMode: 'observe' }]
              : []),
          ],
        });
      },
    });
    const brokerToken = 'fixture-broker-token';
    try {
      const sessionsFor = async (base: string, query: string): Promise<string[]> => {
        const response = await fetch(`${base}/api/machines${query}`, {
          headers: { 'x-cosyncing-token': brokerToken },
        });
        if (!response.ok) throw new Error(`/api/machines answered ${response.status}`);
        const body = await response.json() as { machines: Array<{ sessions?: Array<{ id: string }> }> };
        return body.machines.flatMap((entry) => (entry.sessions ?? []).map((session) => session.id));
      };
      // Resolution is the second half of the same read: the app finds a session
      // in the aggregated roster and then asks which broker owns it. Both must
      // answer for the same client, or a row the user can see refuses to open.
      const resolveStatus = async (base: string, query: string): Promise<string> => {
        const response = await fetch(
          `${base}/api/machines/resolve${query}&machineId=fixture-peer&tool=kimi&sessionId=peer-kimi`,
          { headers: { 'x-cosyncing-token': brokerToken } },
        );
        const body = await response.json() as { status?: string };
        return body.status ?? `http-${response.status}`;
      };
      const observed = await withBroker(
        {
          COSYNCING_TOKEN: brokerToken,
          COSYNCING_MACHINE: 'fixture-local',
          COSYNCING_MACHINE_PEERS: JSON.stringify([
            { id: 'fixture-peer', url: `http://127.0.0.1:${peerPort}`, token: peerToken },
          ]),
        },
        async (base) => ({
          current: await sessionsFor(base, `?contractRevision=${FLOOR}`),
          legacy: await sessionsFor(base, `?contractRevision=${Number(FLOOR) - 1}`),
          undeclared: await sessionsFor(base, ''),
          resolvedCurrent: await resolveStatus(base, `?contractRevision=${FLOOR}`),
          resolvedLegacy: await resolveStatus(base, `?contractRevision=${Number(FLOOR) - 1}`),
        }),
      );
      check('the broker asks a peer for its roster as the current client it is',
        peerAskedRevision === String(BROKER_CONTRACT_REVISION), String(peerAskedRevision));
      check('a machine roster serves a kimi session only to a client that can decode kimi',
        observed.current.includes('peer-kimi')
          && !observed.legacy.includes('peer-kimi')
          && !observed.undeclared.includes('peer-kimi'),
        JSON.stringify(observed));
      check('withholding kimi from a machine roster never costs that client the other agents',
        observed.legacy.includes('peer-codex') && observed.undeclared.includes('peer-codex'),
        JSON.stringify(observed));
      check('a client that can see a kimi session in the machine roster can also resolve its owner',
        observed.resolvedCurrent === 'resolved', observed.resolvedCurrent);
      check('a client that was not shown the kimi session cannot resolve it either',
        observed.resolvedLegacy === 'not-found', observed.resolvedLegacy);
    } finally {
      peer.stop(true);
    }
  }

  check('doctor diagnoses kimi with no flag set',
    doctorDefault.includes('kimi'), doctorDefault.join(','));
  check('doctor no longer varies with the environment',
    JSON.stringify(defaultDoctorAdapters({ COSYNCING_ENABLE_KIMI: '1' }).map((a) => a.id))
      === JSON.stringify(doctorDefault),
    doctorDefault.join(','));

  // Setup advertises what the service it installs can actually DELIVER, and it
  // now delivers this one. Kimi was off the preflight while setup neither
  // started nor managed `kimi web` — listing it then would have promised a
  // working agent where the honest answer was "run the host yourself". The
  // service this setup installs now starts that host when none is running,
  // restarts it, and stops the one it started, which is precisely the condition
  // the omission was waiting on.
  //
  // It matters beyond the panel: the same install asks the operator to consent
  // to the runtimes cosyncing will manage, and a host missing from the list is a
  // host managed without being disclosed.
  const summaryFor = (agents: string[]) => agentSummaries({
    minimumVersions: agents.map((agent) => ({
      agent, displayName: agent, version: '0.0.0',
      requiredFeature: 'fixture', evidenceUrl: '', evidenceNote: 'fixture',
    })),
    sections: [{ id: 'agents', title: 'Agents', checks: [] }],
  } as never).map((row) => row.id as string);
  check('setup lists kimi, whose host the installed service now manages',
    summaryFor(['codex', 'opencode', 'pi', 'claude']).includes('kimi'),
    summaryFor(['codex', 'opencode', 'pi', 'claude']).join(','));
  // Membership follows the adapter's DECLARATION, not the doctor report it was
  // handed: an agent the report never mentions is still listed (as missing), so
  // a host that failed to answer cannot quietly drop out of the disclosure.
  check('...whether or not the doctor report happened to carry a row for it',
    summaryFor(['codex', 'opencode', 'pi', 'claude', 'kimi']).includes('kimi'),
    summaryFor(['codex', 'opencode', 'pi', 'claude', 'kimi']).join(','));
  // The consent an operator gives must name it. This is the text shown right
  // before setup writes the managed-host activation into the service
  // environment, so a host absent from it is one managed without disclosure.
  for (const language of ['en', 'zh-Hans'] as const) {
    const body = setupMessages(language).managedRuntimeBody('cosyncing');
    check(`the managed-runtime consent names the kimi host (${language})`,
      body.includes('kimi web'), body.slice(0, 160));
  }
} catch (error) {
  check('test harness completed', false, error instanceof Error ? error.message : String(error));
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
