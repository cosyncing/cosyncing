#!/usr/bin/env bun
/** Deterministic version surfaces, compatibility, signed update checks, and auth acceptance. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BROKER_CONTRACT,
  evaluateBrokerClientCompatibility,
} from '../../../adapter-api/src/index.ts';
import { parseQrPairingPayload } from '../../../crypto/src/index.ts';
import {
  isolatedBrokerFixtureEnvironment,
  reserveLoopbackFixturePort,
  waitForBrokerHealth,
} from '../helpers/isolated-broker-fixture.ts';
import {
  BUILD_INFO,
  PUBLISHED_BROKER_CONTRACT,
  PUBLISHED_SCHEMA_VERSIONS,
  buildFingerprint,
  type BuildInfo,
} from '../../src/runtime/build-info.ts';
import {
  BrokerUpdateChecker,
  brokerUpdateHandoffCommand,
  triggerBrokerUpdate,
} from '../../src/updates/broker-update.ts';
import {
  checkReleaseUpdate,
  releaseManifestForTests,
  type ReleaseArtifact,
  type ReleaseManifest,
} from '../../src/updates/release-upgrade.ts';

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const equal = evaluateBrokerClientCompatibility({
  revision: BROKER_CONTRACT.revision,
  minimumBrokerRevision: 0,
  surfaceHash: BROKER_CONTRACT.surfaceHash,
});
const previousRevisionClient = evaluateBrokerClientCompatibility({
  revision: BROKER_CONTRACT.revision - 1,
  minimumBrokerRevision: 0,
  surfaceHash: 'fnv1a32:revision-1-client',
});
const belowClientFloor = evaluateBrokerClientCompatibility({
  revision: BROKER_CONTRACT.minimumClientRevision - 1,
  minimumBrokerRevision: 0,
});
const brokerBehind = evaluateBrokerClientCompatibility({
  revision: BROKER_CONTRACT.revision + 1,
  minimumBrokerRevision: 0,
});
const beyondOverlap = evaluateBrokerClientCompatibility({
  revision: BROKER_CONTRACT.revision + 2,
  minimumBrokerRevision: 0,
});
const hardMinimum = evaluateBrokerClientCompatibility({
  revision: BROKER_CONTRACT.revision + 1,
  minimumBrokerRevision: BROKER_CONTRACT.revision + 1,
});
const hardHash = evaluateBrokerClientCompatibility({
  revision: BROKER_CONTRACT.revision,
  minimumBrokerRevision: 0,
  surfaceHash: 'fnv1a32:00000000',
});
const legacy = evaluateBrokerClientCompatibility();
check('contract surface hash is deterministic and machine-readable', /^fnv1a32:[a-f0-9]{8}$/.test(BROKER_CONTRACT.surfaceHash));
check('published build/schema metadata carries the exact current contract identity',
  PUBLISHED_SCHEMA_VERSIONS.brokerContract === BROKER_CONTRACT.revision
    && PUBLISHED_BROKER_CONTRACT.revision === BROKER_CONTRACT.revision
    && PUBLISHED_BROKER_CONTRACT.surfaceHash === BROKER_CONTRACT.surfaceHash
    && PUBLISHED_BROKER_CONTRACT.minimumClientRevision === BROKER_CONTRACT.minimumClientRevision);
check('equal revisions are compatible', equal.status === 'compatible' && !equal.readOnly);
check('a client below the revision-17 security floor still fails closed',
  belowClientFloor.status === 'hard-incompatible' && belowClientFloor.readOnly);
// The literal is a deliberate tripwire, not a duplicate of the constant: every
// revision bump must land here and re-argue its compatibility boundary.
// Revision 13 added only additive owner, authority, capability, attach-reason,
// and refusal fields, which a released revision-12 client can ignore.
//
// Revision 14 is additive CONDITIONALLY, and the condition is what renews the
// claim rather than the usual "new fields are ignorable" argument. It adds an
// enumerated VALUE — `IntegrationKind: 'http-websocket'` — and a new value in a
// closed enum is not ignorable: a revision-13 client that decodes roster rows
// strictly throws on it, and because `/api/agents` decodes as one list, that
// aborts the whole roster rather than one row. What keeps the claim true is
// that the only producer of the new value, the Kimi adapter, is registered
// behind an explicit default-off opt-in, so a default revision-14 broker never
// emits it and a revision-13 client sees a byte-identical roster. Revision 14
// also gives the first-party client the tolerant `unknown` fallback that makes
// the value safe to serve.
//
// So the gate is load-bearing, not cosmetic: flipping Kimi registration on by
// default BREAKS this claim for every client below revision 14, and that flip
// must not happen until the supported-client floor has crossed it.
//
// Revision 15 is additive in the ORDINARY sense, and deliberately so — it is
// the contrast that shows why 14 needed its own argument. It adds three
// OPTIONAL fields to an existing object (`SessionDriveControl.handoffAvailable`,
// `takeoverAvailable`, `takeoverMode`); it adds no route, frame kind, message
// type, error code, or enumerated wire VALUE. A revision-14 client decodes that
// object with `@JsonSerializable()` defaults, which ignore unrecognized keys, so
// it sees exactly what it saw before.
//
// `takeoverMode` is typed as an `AttachMode`, but every value the broker can put
// there — `live`, `resume` — already existed at revision 14. The new
// `AttachMode.unknown` member is a CLIENT-side fallback that no broker ever
// emits; it exists so a FUTURE mode degrades one field to read-only instead of
// aborting a session decode, which is the lesson revision 14 paid for.
//
// Revision 17 is intentionally breaking at the artifact authentication
// boundary. Protected downloads now require the active principal credential,
// which revision-16 clients did not send. Client releases therefore ship first
// and retain a revision-16 broker fallback; once this broker ships, its
// minimum-client floor makes stale clients visibly read-only instead of letting
// downloads fail later with an unexplained 401.
//
// Revision 18 is additive. It adds one owner-authenticated HTTP route and
// optional health data for a feature that remains default-off. Revision-17
// clients do not call the route and ignore the extra health field, so the
// security floor remains 17 and the normal one-revision overlap applies.
//
// Revision 19 changes first-party presentation rather than the wire surface:
// it is the visibility floor for the new omp row. Revision-18 clients remain
// writable for every agent they already understand, while roster filtering
// keeps omp out of their response.
//
// Revision 20 is additive on revision 18's terms: one read-only route
// (`GET /api/tokdash/report`) that older clients never call. What it is NOT is
// free for shipped clients — 18 is the revision they advertise, and 20 puts
// them two revisions back, outside the overlap window. `a revision outside the
// one-version overlap window fails closed` below is what enforces that; the
// release consequence is that a revision-19-or-later client ships first.
//
// The assertion tracks the constants rather than a literal revision. An
// additive bump should not need this line edited — but raising the floor, or
// making a previous-revision client read-only, must still fail here.
check('the current broker retains the intentional revision-17 client floor',
  BROKER_CONTRACT.minimumClientRevision === 17
    && BROKER_CONTRACT.revision > BROKER_CONTRACT.minimumClientRevision
    && previousRevisionClient.status === 'client-behind'
    && !previousRevisionClient.readOnly);
check('the overlap window never overrides the explicit security floor',
  belowClientFloor.status === 'hard-incompatible' && belowClientFloor.readOnly);
check('one overlap revision ahead nudges the broker without disabling control', brokerBehind.status === 'broker-behind' && !brokerBehind.readOnly);
check('a revision outside the one-version overlap window fails closed',
  beyondOverlap.status === 'hard-incompatible' && beyondOverlap.readOnly);
check('a client requiring a newer broker degrades to read-only', hardMinimum.status === 'hard-incompatible' && hardMinimum.readOnly);
check('same revision with a different public surface fails closed', hardHash.status === 'hard-incompatible' && hardHash.readOnly);
check('pre-handshake negotiation remains unknown; stream auth enforces the ticket boundary separately',
  legacy.status === 'unknown' && !legacy.readOnly);

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const keyId = 'update-contract-fixture';
const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
const artifactBytes = Buffer.from('update-contract-candidate');
const artifact: ReleaseArtifact = {
  name: 'cosyncing-linux-x64',
  target: 'linux-x64',
  platform: 'linux',
  arch: 'x64',
  size: artifactBytes.byteLength,
  sha256: createHash('sha256').update(artifactBytes).digest('hex'),
  url: 'https://releases.example/cosyncing-linux-x64',
  provenanceUrl: 'https://releases.example/cosyncing-linux-x64.intoto.jsonl',
};
const manifest = (version: string): ReleaseManifest => releaseManifestForTests({
  version,
  sourceCommit: '2222222',
  publishedAt: '2026-07-18T12:00:00.000Z',
  artifact,
  keyId,
  sign: (payload) => sign(null, payload, privateKey),
});
const buildInfo: BuildInfo = {
  ...BUILD_INFO,
  version: '1.0.0',
  target: 'linux-x64',
  packaged: true,
  dirty: false,
};
let manifestFetches = 0;
const manifestFetcher = (value: ReleaseManifest): typeof fetch => (async () => {
  manifestFetches += 1;
  const body = JSON.stringify(value);
  return new Response(body, { status: 200, headers: { 'content-length': String(Buffer.byteLength(body)) } });
}) as unknown as typeof fetch;
const checkDependencies = (value: ReleaseManifest, fetcher = manifestFetcher(value)) => ({
  buildInfo,
  manifestUrl: 'https://releases.example/release-manifest.json',
  trustedKeys: { [keyId]: publicPem },
  fetch: fetcher,
  now: () => new Date('2026-07-18T13:00:00.000Z'),
});
const available = await checkReleaseUpdate(checkDependencies(manifest('1.1.0')));
const current = await checkReleaseUpdate(checkDependencies(manifest('1.0.0')));
const unreachable = await checkReleaseUpdate(checkDependencies(
  manifest('1.1.0'),
  (async () => { throw new Error('offline'); }) as unknown as typeof fetch,
));
check('signed metadata reports a newer stable release without downloading its artifact',
  available.status === 'update-available' && available.latestVersion === '1.1.0');
check('signed metadata reports an equal release as current', current.status === 'current');
check('an unreachable release channel fails quiet as unknown',
  unreachable.status === 'unknown' && unreachable.detailCode === 'release-download-unavailable');

manifestFetches = 0;
let clock = Date.parse('2026-07-18T13:00:00.000Z');
const checker = new BrokerUpdateChecker(checkDependencies(manifest('1.1.0')), {
  ttlMs: 60_000,
  now: () => clock,
});
const firstCheck = await checker.inspect();
const cachedCheck = await checker.inspect();
clock += 60_001;
const expiredCheck = await checker.inspect();
check('daily cache reuses both available and unknown metadata results until expiry',
  !firstCheck.cached && cachedCheck.cached && !expiredCheck.cached && manifestFetches === 2,
  `fetches=${manifestFetches}`);

const systemdDependencies = {
  buildInfo,
  service: { provider: 'systemd' as const, managed: true, restartStrategy: 'service-manager-exit' as const },
  executablePath: '/opt/cosyncing-fixture/.cosyncing/bin/cosyncing',
  stateHome: '/opt/cosyncing-fixture/.cosyncing',
  cacheRoot: '/opt/cosyncing-fixture/.cache/cosyncing',
  userHome: '/opt/cosyncing-fixture',
  systemdRunPath: '/usr/bin/systemd-run',
};
const handoffCommand = brokerUpdateHandoffCommand(systemdDependencies);
const candidateManifestUrl = 'https://releases.example/cosyncing/v1.1.0/release-manifest.json';
const candidateHandoff = brokerUpdateHandoffCommand({
  ...systemdDependencies,
  manifestUrl: candidateManifestUrl,
});
let handedOff: readonly string[] = [];
const accepted = await triggerBrokerUpdate({
  ...systemdDependencies,
  run: async (argv) => { handedOff = argv; return { ok: true }; },
}, '1.1.0');
const sourceBlocked = await triggerBrokerUpdate({
  ...systemdDependencies,
  buildInfo: { ...buildInfo, packaged: false },
  run: async () => ({ ok: true }),
}, '1.1.0');
check('app update handoff is argv-only, delayed, and invokes the existing confirmed CLI upgrader',
  accepted.status === 'accepted'
    && handoffCommand?.includes('--on-active=2s') === true
    && handedOff.slice(-3).join(' ') === 'upgrade --yes --json');
check('candidate acceptance can hand a pinned signed manifest to the same upgrader',
  candidateHandoff?.slice(-2).join(' ') === `--manifest ${candidateManifestUrl}`
    && brokerUpdateHandoffCommand({ ...systemdDependencies, manifestUrl: 'http://127.0.0.1/manifest.json' }) === undefined);
check('source builds refuse self-replacement', sourceBlocked.status === 'blocked');

// launchd has no systemd-run equivalent, so the handoff degrades to undefined and the trigger must say so
// plainly — naming the CLI upgrader that DOES work there rather than implying an update was queued.
const launchdDependencies = {
  ...systemdDependencies,
  service: { provider: 'launchd' as const, managed: true, restartStrategy: 'service-manager-exit' as const },
};
let launchdRan = false;
const launchdBlocked = await triggerBrokerUpdate({
  ...launchdDependencies,
  run: async () => { launchdRan = true; return { ok: true }; },
}, '1.1.0');
check('launchd degrades the app-triggered update to an honest block naming the upgrade command',
  brokerUpdateHandoffCommand(launchdDependencies) === undefined
    && launchdBlocked.status === 'blocked'
    && launchdBlocked.detailCode === 'broker-update-handoff-unavailable'
    && launchdBlocked.message.includes('cosyncing upgrade')
    && !launchdRan,
  `${launchdBlocked.detailCode}: ${launchdBlocked.message}`);

const token = 'update-contract-test-token';
const home = mkdtempSync(join(tmpdir(), 'cosyncing-update-contract-'));
// Leased rather than hard-coded: a fixed 18713 is a collision waiting for a
// second run, and the lease is released just before the broker claims it.
const portLease = await reserveLoopbackFixturePort();
const port = portLease.port;
await portLease.release();
const broker = Bun.spawn(['bun', 'packages/typescript/broker/src/main.ts'], {
  cwd: process.cwd(),
  env: isolatedBrokerFixtureEnvironment(home, {
    overrides: {
      PORT: String(port),
      HOST: '127.0.0.1',
      COSYNCING_HOME: home,
      COSYNCING_TOKEN: token,
      COSYNCING_MACHINE: 'update-contract-fixture',
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
    },
  }),
  stdin: 'ignore',
  stdout: 'ignore',
  stderr: 'ignore',
});
const base = `http://127.0.0.1:${port}`;
// Readiness gets no wall-clock budget of its own: a broker booting beside
// other suites is slow, not broken, and the fixed 10s here was really a claim
// about how fast the host is. Losing that bet also left the broker running,
// because the suite went on to fail somewhere that does not clean it up.
try {
  await waitForBrokerHealth(broker, `${base}/api/health`);
} catch (error) {
  broker.kill();
  await broker.exited;
  throw error;
}

async function firstWsFrame(sessionId: string, query: string): Promise<any> {
  const ticketResponse = await fetch(`${base}/api/ws-auth-tickets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cosyncing-token': token },
    body: JSON.stringify({
      tool: 'pi',
      sessionId,
      params: Object.fromEntries(new URLSearchParams(query)),
    }),
  });
  const ticketBody = await ticketResponse.json() as any;
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/pi/${encodeURIComponent(sessionId)}/stream?wsAuthTicket=${encodeURIComponent(String(ticketBody.wsAuthTicket ?? ''))}`);
    const timer = setTimeout(() => { ws.close(); reject(new Error('websocket hello timeout')); }, 12_000);
    ws.onmessage = (event) => {
      clearTimeout(timer);
      try {
        const frame = JSON.parse(String(event.data));
        settled = true;
        resolve(frame);
      } catch (error) {
        settled = true;
        reject(error);
      } finally {
        ws.close();
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('websocket failed before hello'));
    };
    ws.onclose = (event) => {
      clearTimeout(timer);
      if (!settled) reject(new Error(`websocket closed before hello (${event.code}: ${event.reason})`));
    };
  });
}

try {
  // Reaching here means the readiness wait returned. It throws otherwise,
  // after killing the broker, so there is no longer a flag to consult.
  check('update-contract fixture broker starts', true);
  const health = await (await fetch(`${base}/api/health`, {
    headers: { 'x-cosyncing-token': token },
  })).json() as any;
  // The commit rides alongside the version because the version alone cannot identify a build: every build
  // in a release cycle shares one semver, so setup's post-commit check — which must tell a just-installed
  // build from the previous one still holding the port — has nothing else to bind to.
  check('health advertises broker version, commit, build fingerprint, and contract identity',
    health.version === BUILD_INFO.version && health.commit === BUILD_INFO.commit
      && health.buildFingerprint === buildFingerprint(BUILD_INFO)
      && health.contract?.surfaceHash === BROKER_CONTRACT.surfaceHash,
    `${health.buildFingerprint}`);

  const pairingResponse = await fetch(`${base}/api/transport/pairings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cosyncing-token': token },
    body: '{}',
  });
  const pairing = await pairingResponse.json() as any;
  const qr = parseQrPairingPayload(pairing.qr);
  // The descriptor rides the response, not the QR. Carrying it in the payload too cost 154 characters and
  // took the printed symbol past an 80-column terminal; a client that scans the QR then talks to this same
  // broker, and learns the version and contract from /api/health, from the accept response, and from the
  // WebSocket hello checked further down this file.
  check('the pairing response advertises broker version and contract, and the QR stays free of them',
    pairingResponse.status === 201
      && pairing.broker?.version === BUILD_INFO.version
      && pairing.broker?.contract?.revision === BROKER_CONTRACT.revision
      && pairing.broker?.contract?.surfaceHash === BROKER_CONTRACT.surfaceHash
      && qr.broker === undefined);

  const piHelloResponse = await fetch(`${base}/pi/bridge/hello`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cosyncing-token': token },
    body: JSON.stringify({
      sessionFile: join(home, 'update-contract-pi-session.jsonl'),
      cwd: home,
      title: 'Update-contract handshake fixture',
      history: [{ t: 'user', text: 'version handshake', key: 'update-contract-user' }],
    }),
  });
  const piHello = await piHelloResponse.json() as any;
  check('fake Pi bridge creates a deterministic WebSocket target',
    piHelloResponse.status === 200 && typeof piHello.id === 'string');

  const hello = await firstWsFrame(piHello.id,
    `contractRevision=${BROKER_CONTRACT.revision}&minimumBrokerRevision=0&contractSurfaceHash=${encodeURIComponent(BROKER_CONTRACT.surfaceHash)}&clientVersion=1.0.0`,
  );
  // The immediately previous revision, whatever it currently is: this is the
  // overlap window the compatibility matrix promises, so derive it instead of
  // re-pinning a literal on every contract bump.
  const previousRevisionHello = await firstWsFrame(piHello.id,
    `contractRevision=${BROKER_CONTRACT.revision - 1}&minimumBrokerRevision=2`
    + '&contractSurfaceHash=fnv1a32%3A3ff9de78&clientVersion=0.9.8',
  );
  const belowFloorHello = await firstWsFrame(piHello.id,
    `contractRevision=${BROKER_CONTRACT.minimumClientRevision - 1}&minimumBrokerRevision=2`
    + '&clientVersion=0.9.7',
  );
  const hardHello = await firstWsFrame(piHello.id,
    `contractRevision=${BROKER_CONTRACT.revision + 1}&minimumBrokerRevision=${BROKER_CONTRACT.revision + 1}&clientVersion=2.0.0`,
  );
  const legacyHello = await firstWsFrame(piHello.id, 'clientVersion=0.9.0');
  check('WebSocket hello advertises broker identity and equal compatibility',
    hello.kind === 'hello' && hello.broker?.version === BUILD_INFO.version
      && hello.compatibility?.status === 'compatible');
  check('an additive previous-revision WebSocket client remains writable',
    previousRevisionHello.kind === 'hello'
      && previousRevisionHello.compatibility?.status === 'client-behind'
      && previousRevisionHello.compatibility?.readOnly === false);
  check('a WebSocket client below the ticket floor is explicitly read-only',
    belowFloorHello.kind === 'hello'
      && belowFloorHello.compatibility?.status === 'hard-incompatible'
      && belowFloorHello.compatibility?.readOnly === true);
  check('hard WebSocket mismatch explicitly degrades to read-only',
    hardHello.kind === 'hello' && hardHello.compatibility?.status === 'hard-incompatible'
      && hardHello.compatibility?.readOnly === true);
  check('legacy WebSocket clients negotiate unknown without forced read-only',
    legacyHello.kind === 'hello' && legacyHello.compatibility?.status === 'unknown'
      && legacyHello.compatibility?.readOnly === false);

  const badContractTicket = await fetch(`${base}/api/ws-auth-tickets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cosyncing-token': token },
    body: JSON.stringify({ tool: 'missing', sessionId: 'missing', params: { contractRevision: 'wat' } }),
  }).then((response) => response.json() as Promise<any>);
  const badContract = await fetch(`${base}/api/sessions/missing/missing/stream?wsAuthTicket=${encodeURIComponent(String(badContractTicket.wsAuthTicket ?? ''))}`);
  check('malformed client contract metadata is rejected before WebSocket upgrade', badContract.status === 400);

  const unauthGet = await fetch(`${base}/api/broker/update`);
  const unauthPost = await fetch(`${base}/api/broker/update`, { method: 'POST' });
  check('broker update status and trigger both require authentication',
    unauthGet.status === 401 && unauthPost.status === 401);
  const authUpdate = await fetch(`${base}/api/broker/update`, {
    headers: { 'x-cosyncing-token': token },
  });
  const authUpdateBody = await authUpdate.json() as any;
  check('source broker exposes an offline-safe unknown update status',
    authUpdate.status === 200 && authUpdateBody.update?.status === 'unknown'
      && authUpdateBody.update?.detailCode === 'release-channel-unconfigured');
  const candidateOverride = await fetch(`${base}/api/broker/update`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cosyncing-token': token },
    body: JSON.stringify({ manifestUrl: 'https://releases.example/release-manifest.json' }),
  });
  const candidateOverrideBody = await candidateOverride.json() as any;
  check('HTTP update trigger refuses every caller-supplied manifest URL',
    candidateOverride.status === 400
      && candidateOverrideBody.code === 'BAD_PARAM'
      && /local operator CLI/.test(candidateOverrideBody.error));
} finally {
  broker.kill();
  await broker.exited.catch(() => undefined);
  rmSync(home, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
if (failed.length) {
  console.error(`\nFAIL ${failed.length}/${results.length} update-contract checks`);
  process.exit(1);
}
console.log(`\nPASS ${results.length}/${results.length} update-contract checks`);
