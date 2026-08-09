#!/usr/bin/env bun
/**
 * Release regression: artifact delivery and replay are qualified by the exact
 * broker source, tool, and native session. The primary assertions use real
 * broker HTTP/WebSocket routes and process restarts. Only the adapter-internal
 * history-reset signal uses a direct ManagedConn seam because Pi cannot emit
 * that signal over its bridge protocol.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../../../../packages/typescript/broker/src/artifact-store.ts';
import { ManagedConn } from '../../../../packages/typescript/broker/src/hub.ts';
import type {
  AgentMessage,
  SessionConnection,
  SessionInfo,
} from '../../../../packages/typescript/adapter-api/src/index.ts';
import {
  captureProcessOutput,
  isolatedBrokerFixtureEnvironment,
  reserveLoopbackFixturePort,
  settledProcessOutput,
  waitForBrokerHealth,
  type ProcessOutputCapture,
} from '../helpers/isolated-broker-fixture.ts';

let failures = 0;
const check = (label: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  — ${extra}` : ''}`);
  if (!ok) failures++;
};

function filesBelow(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return filesBelow(path);
      return entry.isFile() ? [path] : [];
    }).sort();
  } catch {
    return [];
  }
}

const sleep = (ms: number) => Bun.sleep(ms);
const enc = (value: string): string => encodeURIComponent(value);
type Artifact = Extract<AgentMessage, { type: 'file-artifact' }>;

interface BrokerProcess {
  child: ReturnType<typeof Bun.spawn>;
  output: ProcessOutputCapture;
  origin: string;
}

async function startBroker(fixtureRoot: string, port: number): Promise<BrokerProcess> {
  const origin = `http://127.0.0.1:${port}`;
  const child = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: isolatedBrokerFixtureEnvironment(fixtureRoot, {
      overrides: {
        PORT: String(port),
        HOST: '127.0.0.1',
        COSYNCING_CACHE_DIR: join(fixtureRoot, 'artifact-cache'),
        COSYNCING_ARTIFACT_CACHE_MAX_RECORDS: '5',
        COSYNCING_ARTIFACT_SESSION_REPLAY_LIMIT: '3',
        COSYNCING_PI_SESSIONS_ROOT: '',
        PI_CODING_AGENT_SESSION_DIR: '',
      },
    }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = captureProcessOutput(child);
  try {
    await waitForBrokerHealth(child, `${origin}/api/health`);
  } catch (error) {
    child.kill();
    await child.exited;
    const log = await settledProcessOutput(output);
    throw new Error(`${String(error)}\n${log.slice(-2_000)}`);
  }
  return { child, output, origin };
}

async function stopBroker(process: BrokerProcess | undefined): Promise<void> {
  if (!process) return;
  if (process.child.exitCode == null) process.child.kill();
  await process.child.exited;
  await settledProcessOutput(process.output);
}

async function post(origin: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function hello(origin: string, sessionFile: string, cwd: string): Promise<string> {
  const response = await post(origin, '/pi/bridge/hello', {
    sessionFile,
    cwd,
    title: 'artifact-isolation',
  });
  if (!response.ok) throw new Error(`bridge hello failed: ${response.status} ${await response.text()}`);
  return String((await response.json() as { id?: unknown }).id ?? '');
}

async function sendFile(origin: string, id: string, path: string): Promise<Response> {
  return post(origin, '/pi/bridge/send-file', { id, path });
}

interface Phone {
  frames: any[];
  waitFrame(predicate: (frame: any) => boolean, timeoutMs?: number): Promise<any>;
  close(): void;
}

async function attach(origin: string, id: string): Promise<Phone> {
  const wsOrigin = origin.replace(/^http/, 'ws');
  const socket = new WebSocket(
    `${wsOrigin}/api/sessions/pi/${enc(id)}/stream?artifactMode=reference`,
  );
  const frames: any[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket open timed out')), 10_000);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error('WebSocket open failed'));
    };
    socket.onmessage = (event) => {
      try { frames.push(JSON.parse(String(event.data))); } catch { /* ignore malformed fixture data */ }
    };
  });
  return {
    frames,
    waitFrame: async (predicate, timeoutMs = 5_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const frame = frames.find(predicate);
        if (frame) return frame;
        if (Date.now() >= deadline) return undefined;
        await sleep(25);
      }
    },
    close: () => {
      try { socket.close(); } catch { /* already closed */ }
    },
  };
}

const artifactFrames = (phone: Phone): Artifact[] => phone.frames
  .filter((frame) => frame?.kind === 'message' && frame.message?.type === 'file-artifact')
  .map((frame) => frame.message as Artifact);

const artifactNamed = (name: string) => (frame: any): boolean =>
  frame?.kind === 'message' && frame.message?.type === 'file-artifact' && frame.message?.name === name;

function urlForSession(message: Artifact, sessionId: string, origin?: string): string {
  const url = new URL(String(message.fetchUrl));
  if (origin) {
    const target = new URL(origin);
    url.protocol = target.protocol;
    url.host = target.host;
  }
  url.pathname = `/api/sessions/pi/${enc(sessionId)}/artifact/${enc(String(message.artifactKey))}`;
  return url.toString();
}

type FakeConnection = SessionConnection & {
  emit(message: AgentMessage): void;
  closed: boolean;
  subscribers: number;
};

function fakeConnection(tool: string, id: string, cwd: string): FakeConnection {
  const handlers = new Set<(message: AgentMessage) => void>();
  const info: SessionInfo = {
    tool,
    id,
    cwd,
    machine: 'test',
    title: id,
    status: 'idle',
    attachMode: 'live',
  } as SessionInfo;
  const connection: FakeConnection = {
    info,
    closed: false,
    get subscribers() { return handlers.size; },
    emit(message) { for (const handler of handlers) handler(message); },
    getHistory: async () => [{ type: 'user-message', text: 'history baseline' } as AgentMessage],
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    sendPrompt: async () => {},
    respondPermission: async () => {},
    close: async () => { connection.closed = true; },
  };
  return connection;
}

const root = mkdtempSync(join(tmpdir(), 'cosyncing-artifact-session-isolation-'));
const fixtureA = join(root, 'broker-a');
const fixtureB = join(root, 'broker-b');
const cwd = join(root, 'workspace');
const outbox = join(cwd, '.cosyncing', 'outbox');
const sessionFileA = join(root, 'pi-session-a.jsonl');
const sessionFileB = join(root, 'pi-session-b.jsonl');
mkdirSync(outbox, { recursive: true });
writeFileSync(sessionFileA, `${JSON.stringify({ type: 'session', id: 'same-native-a', cwd })}\n`);
writeFileSync(sessionFileB, `${JSON.stringify({ type: 'session', id: 'same-native-b', cwd })}\n`);
// This is the reproduction condition. It remains in place for the lifetime of
// both brokers and every reattach/restart assertion.
writeFileSync(join(outbox, 'old-report.txt'), 'old bytes');

const leaseA = await reserveLoopbackFixturePort();
const leaseB = await reserveLoopbackFixturePort();
const portA = leaseA.port;
const portB = leaseB.port;
let brokerA: BrokerProcess | undefined;
let brokerB: BrokerProcess | undefined;
const phones = new Set<Phone>();

try {
  await leaseA.release();
  brokerA = await startBroker(fixtureA, portA);
  const idA = await hello(brokerA.origin, sessionFileA, cwd);
  const idB = await hello(brokerA.origin, sessionFileB, cwd);
  const owner = await attach(brokerA.origin, idA);
  const peer = await attach(brokerA.origin, idB);
  phones.add(owner);
  phones.add(peer);
  await Promise.all([
    owner.waitFrame((frame) => frame?.kind === 'history'),
    peer.waitFrame((frame) => frame?.kind === 'history'),
  ]);
  await sleep(100);
  check('1 old outbox file is absent from a newly created real session', artifactFrames(owner).length === 0);
  check('1a the same old file is absent from a simultaneous peer sharing cwd', artifactFrames(peer).length === 0);

  const report = join(cwd, 'report.txt');
  writeFileSync(report, 'version one');
  const sentFirst = await sendFile(brokerA.origin, idA, report);
  const firstFrame = await owner.waitFrame(artifactNamed('report.txt'));
  await sleep(100);
  check('2 exact Pi send-file HTTP route accepts the owner file', sentFirst.status === 200, `status=${sentFirst.status}`);
  check('2a owner WebSocket receives exactly one artifact', artifactFrames(owner).length === 1, `count=${artifactFrames(owner).length}`);
  check('2b simultaneous peer WebSocket receives no artifact', artifactFrames(peer).length === 0, `count=${artifactFrames(peer).length}`);
  const first = firstFrame?.message as Artifact | undefined;
  const exactResponse = first?.fetchUrl ? await fetch(first.fetchUrl) : undefined;
  const exactBytes = exactResponse ? await exactResponse.text() : '';
  check('2c signed HTTP reference returns exact owner bytes', exactResponse?.status === 200 && exactBytes === 'version one', `status=${exactResponse?.status ?? 0}`);
  const wrongSessionResponse = first ? await fetch(urlForSession(first, idB)) : undefined;
  check('2d another session cannot download the owner reference', wrongSessionResponse?.status === 403, `status=${wrongSessionResponse?.status ?? 0}`);

  owner.close();
  peer.close();
  phones.delete(owner);
  phones.delete(peer);
  const reattachedOwner = await attach(brokerA.origin, idA);
  const reattachedPeer = await attach(brokerA.origin, idB);
  phones.add(reattachedOwner);
  phones.add(reattachedPeer);
  await Promise.all([
    reattachedOwner.waitFrame((frame) => frame?.kind === 'history'),
    reattachedPeer.waitFrame((frame) => frame?.kind === 'history'),
  ]);
  check('3 WebSocket reattach replays the artifact only to its session', artifactFrames(reattachedOwner).length === 1);
  check('3a peer reattach remains empty', artifactFrames(reattachedPeer).length === 0);

  reattachedOwner.close();
  reattachedPeer.close();
  phones.delete(reattachedOwner);
  phones.delete(reattachedPeer);
  await stopBroker(brokerA);
  brokerA = undefined;
  brokerA = await startBroker(fixtureA, portA);
  const restartedIdA = await hello(brokerA.origin, sessionFileA, cwd);
  const restartedIdB = await hello(brokerA.origin, sessionFileB, cwd);
  const restartedOwner = await attach(brokerA.origin, restartedIdA);
  const restartedPeer = await attach(brokerA.origin, restartedIdB);
  phones.add(restartedOwner);
  phones.add(restartedPeer);
  await Promise.all([
    restartedOwner.waitFrame((frame) => frame?.kind === 'history'),
    restartedPeer.waitFrame((frame) => frame?.kind === 'history'),
  ]);
  const oldReferenceAfterRestart = first?.fetchUrl ? await fetch(first.fetchUrl) : undefined;
  check('4 process restart hydrates the owner artifact over WebSocket', artifactFrames(restartedOwner).length === 1);
  check('4a process restart does not cross-attribute it to the peer', artifactFrames(restartedPeer).length === 0);
  check('4b the durable signed reference still returns exact bytes after restart',
    oldReferenceAfterRestart?.status === 200 && await oldReferenceAfterRestart.text() === 'version one');

  writeFileSync(report, 'version two');
  const sentSecond = await sendFile(brokerA.origin, restartedIdA, report);
  await restartedOwner.waitFrame((frame) =>
    artifactNamed('report.txt')(frame) && frame.message?.artifactKey !== first?.artifactKey
  );
  const versions = artifactFrames(restartedOwner).filter((message) => message.name === 'report.txt');
  const versionBodies = await Promise.all(versions.map(async (message) =>
    message.fetchUrl ? (await fetch(message.fetchUrl)).text() : ''
  ));
  check('5 rewritten path is accepted through the exact owner route', sentSecond.status === 200);
  check('5a owner retains two immutable versions at the same path',
    versions.length === 2 && versions[0]?.artifactKey !== versions[1]?.artifactKey,
    `count=${versions.length}`);
  check('5b both owner versions return their exact bytes',
    versionBodies.includes('version one') && versionBodies.includes('version two'));

  await leaseB.release();
  brokerB = await startBroker(fixtureB, portB);
  const sameIdOnB = await hello(brokerB.origin, sessionFileA, cwd);
  const switchedBrokerPhone = await attach(brokerB.origin, sameIdOnB);
  phones.add(switchedBrokerPhone);
  await switchedBrokerPhone.waitFrame((frame) => frame?.kind === 'history');
  const brokerBUsingAReference = first
    ? await fetch(urlForSession(first, sameIdOnB, brokerB.origin))
    : undefined;
  check('6 different broker has the identical native session id', sameIdOnB === restartedIdA);
  check('6a actual broker switch displays no source-broker artifact', artifactFrames(switchedBrokerPhone).length === 0);
  check('6b switched broker cannot authorize broker A reference', brokerBUsingAReference?.status === 403, `status=${brokerBUsingAReference?.status ?? 0}`);

  const outside = join(root, 'outside.txt');
  const symlink = join(cwd, 'linked.txt');
  writeFileSync(outside, 'outside');
  symlinkSync(outside, symlink);
  const escaped = await sendFile(brokerA.origin, restartedIdA, outside);
  const linked = await sendFile(brokerA.origin, restartedIdA, symlink);
  const large = join(cwd, 'large.bin');
  writeFileSync(large, Buffer.alloc(5_000_001, 0x61));
  const largeSent = await sendFile(brokerA.origin, restartedIdA, large);
  const largeFrame = await restartedOwner.waitFrame(artifactNamed('large.bin'));
  check('7 path escape remains rejected by the production route', escaped.status === 400);
  check('7a symlink remains rejected by the production route', linked.status === 400);
  check('7b oversized bytes use the accepted lazy reference path',
    largeSent.status === 200 && Boolean(largeFrame?.message?.fetchUrl) && !largeFrame?.message?.url);

  // Tiny/empty artifacts used to evade the byte ceiling indefinitely. Exercise
  // both the persisted global count and the per-session replay-frame bound.
  const overflowNames: string[] = [];
  for (let index = 0; index < 6; index++) {
    const name = `overflow-${index}.txt`;
    const path = join(cwd, name);
    overflowNames.push(name);
    writeFileSync(path, index % 2 === 0 ? '' : `${index}`);
    const response = await sendFile(brokerA.origin, restartedIdA, path);
    check(`8.${index} tiny artifact ${index} is accepted`, response.status === 200);
    await sleep(2);
  }
  const indexFile = join(fixtureA, 'artifact-cache', 'artifacts', 'index.json');
  const persisted = JSON.parse(readFileSync(indexFile, 'utf8')) as { records?: unknown[] };
  check('8a persisted artifact index is deterministically record-bounded', persisted.records?.length === 5, `count=${persisted.records?.length ?? 0}`);

  restartedOwner.close();
  restartedPeer.close();
  phones.delete(restartedOwner);
  phones.delete(restartedPeer);
  const boundedReattach = await attach(brokerA.origin, restartedIdA);
  phones.add(boundedReattach);
  await boundedReattach.waitFrame((frame) => frame?.kind === 'history');
  const boundedNames = artifactFrames(boundedReattach).map((message) => String(message.name));
  check('8b live reattach emits at most the configured replay-frame bound', boundedNames.length === 3, `count=${boundedNames.length}`);
  check('8c replay contains only the newest owner versions',
    JSON.stringify(boundedNames) === JSON.stringify(overflowNames.slice(-3)), boundedNames.join(','));

  boundedReattach.close();
  phones.delete(boundedReattach);
  await stopBroker(brokerA);
  brokerA = undefined;
  brokerA = await startBroker(fixtureA, portA);
  await hello(brokerA.origin, sessionFileA, cwd);
  await hello(brokerA.origin, sessionFileB, cwd);
  const boundedRestartOwner = await attach(brokerA.origin, restartedIdA);
  const boundedRestartPeer = await attach(brokerA.origin, restartedIdB);
  phones.add(boundedRestartOwner);
  phones.add(boundedRestartPeer);
  await Promise.all([
    boundedRestartOwner.waitFrame((frame) => frame?.kind === 'history'),
    boundedRestartPeer.waitFrame((frame) => frame?.kind === 'history'),
  ]);
  const restartNames = artifactFrames(boundedRestartOwner).map((message) => String(message.name));
  check('8d bounded hydration survives a real broker restart',
    JSON.stringify(restartNames) === JSON.stringify(overflowNames.slice(-3)), restartNames.join(','));
  check('8e bounded restart replay does not cross to the peer', artifactFrames(boundedRestartPeer).length === 0);

  // Adapter-internal history reset: assert the same bounded cache is replayed
  // only by its owning ManagedConn. This signal is not exposed by Pi's bridge.
  const historyRoot = join(root, 'history-reset');
  mkdirSync(historyRoot, { recursive: true });
  const historyStore = new ArtifactStore('http://history.test', join(historyRoot, 'store'), {
    maxRecords: 4,
    sessionReplayLimit: 2,
  });
  const historyOwnerConn = fakeConnection('opencode', 'history-owner', historyRoot);
  const historyPeerConn = fakeConnection('opencode', 'history-peer', historyRoot);
  const historyOwner = new ManagedConn(historyOwnerConn, historyStore);
  const historyPeer = new ManagedConn(historyPeerConn, historyStore);
  const ownerEvents: any[] = [];
  const peerEvents: any[] = [];
  historyOwner.addClient((event) => ownerEvents.push(event));
  historyPeer.addClient((event) => peerEvents.push(event));
  for (let index = 0; index < 3; index++) {
    const path = join(historyRoot, `reset-${index}.txt`);
    writeFileSync(path, `${index}`);
    historyOwner.surfaceExplicit(path);
    await sleep(2);
  }
  ownerEvents.length = 0;
  peerEvents.length = 0;
  historyOwnerConn.emit({ type: 'history-reset', notice: 'reset' } as AgentMessage);
  historyPeerConn.emit({ type: 'history-reset', notice: 'reset' } as AgentMessage);
  await sleep(50);
  const resetOwnerArtifacts = ownerEvents.filter((event) => event?.kind === 'message' && event.message?.type === 'file-artifact');
  const resetPeerArtifacts = peerEvents.filter((event) => event?.kind === 'message' && event.message?.type === 'file-artifact');
  check('9 history reset replays only the bounded owner artifact cache', resetOwnerArtifacts.length === 2, `count=${resetOwnerArtifacts.length}`);
  check('9a peer history reset remains empty', resetPeerArtifacts.length === 0);
  check('9b one native subscription per wrapper is cleanly disposed', historyOwnerConn.subscribers === 1 && historyPeerConn.subscribers === 1);
  await historyOwner.dispose();
  await historyPeer.dispose();
  check('9c disposal removes native subscriptions and closes connections',
    historyOwnerConn.subscribers === 0 && historyPeerConn.subscribers === 0 && historyOwnerConn.closed && historyPeerConn.closed);

  // An oversized legacy index is rejected before JSON materialization. The
  // diagnostic backup is retained and no artifact is replayed.
  const oversizedRoot = join(root, 'oversized-index');
  const oversizedDir = join(oversizedRoot, 'artifacts');
  mkdirSync(oversizedDir, { recursive: true });
  writeFileSync(
    join(oversizedDir, 'index.json'),
    JSON.stringify({ version: 1, records: [], padding: 'x'.repeat(512) }),
  );
  const oversizedStore = new ArtifactStore('http://bounded-index.test', oversizedRoot, {
    maxIndexBytes: 128,
  });
  check('10 oversized index fails closed before replay',
    oversizedStore.sessionQualifiedArtifacts({ tool: 'pi', id: 'anything' }).length === 0);
  check('10a oversized index bytes are retained as diagnostic evidence',
    readdirSync(oversizedDir).some((name) => name.startsWith('index.json.corrupt-')));

  // Persistence must obey the same byte ceiling as loading. A record that
  // cannot fit by itself is rejected without replacing the last valid index,
  // so restart cannot turn an acknowledged artifact into a quarantined index.
  const refusalRoot = join(root, 'index-persist-refusal');
  const refusalDir = join(refusalRoot, 'artifacts');
  const refusalIndex = join(refusalDir, 'index.json');
  mkdirSync(refusalDir, { recursive: true });
  const emptyIndex = JSON.stringify({ version: 1, records: [] });
  writeFileSync(refusalIndex, emptyIndex);
  const persistenceResults: Array<{ ok: boolean; operation: string }> = [];
  const refusalStore = new ArtifactStore('http://persist-refusal.test', refusalRoot, {
    maxIndexBytes: 128,
    onPersistenceResult: (result) => persistenceResults.push(result),
  });
  let refused = false;
  try {
    refusalStore.putBytes(
      { tool: 'pi', id: 'owner' },
      {
        type: 'file-artifact',
        name: 'cannot-fit.txt',
        path: 'cannot-fit.txt',
        mimeType: 'text/plain',
      },
      Buffer.from('x'),
      'text/plain',
      undefined,
      { sessionQualified: true },
    );
  } catch {
    refused = true;
  }
  check('11 a single unfit record is refused before index replacement', refused);
  check('11a refusal leaves the last valid bounded index byte-exact',
    readFileSync(refusalIndex, 'utf8') === emptyIndex && readFileSync(refusalIndex).byteLength <= 128);
  check('11b refusal reports a failed put persistence result',
    persistenceResults.some((result) => !result.ok && result.operation === 'put'));
  const refusalFile = join(refusalRoot, 'route-refusal.txt');
  writeFileSync(refusalFile, 'route refusal');
  const refusalConn = fakeConnection('pi', 'owner', refusalRoot);
  const refusalManaged = new ManagedConn(refusalConn, refusalStore);
  const routeRefusal = refusalManaged.surfaceExplicit(refusalFile);
  check('11c the session-qualified route reports store refusal truthfully', !routeRefusal.ok);
  await refusalManaged.dispose();
  const refusalRestart = new ArtifactStore('http://persist-refusal.test', refusalRoot, {
    maxIndexBytes: 128,
  });
  check('11d refusal survives restart without quarantine or ghost replay',
    refusalRestart.sessionQualifiedArtifacts({ tool: 'pi', id: 'owner' }).length === 0 &&
    !readdirSync(refusalDir).some((name) => name.startsWith('index.json.corrupt-')));

  // When several valid records collectively exceed the index ceiling, retain
  // the newest deterministic suffix and persist only a loadable representation.
  const evictionRoot = join(root, 'index-persist-eviction');
  const evictionIndex = join(evictionRoot, 'artifacts', 'index.json');
  const evictionStore = new ArtifactStore('http://persist-eviction.test', evictionRoot, {
    maxIndexBytes: 1_600,
    maxRecords: 10,
    sessionReplayLimit: 10,
  });
  for (let index = 0; index < 5; index++) {
    evictionStore.putBytes(
      { tool: 'pi', id: 'owner' },
      {
        type: 'file-artifact',
        name: `bounded-${index}.txt`,
        path: `bounded-${index}.txt`,
        mimeType: 'text/plain',
      },
      Buffer.from(`${index}`),
      'text/plain',
      undefined,
      { sessionQualified: true },
    );
    check(`12.${index} every persisted index remains within its load ceiling`,
      readFileSync(evictionIndex).byteLength <= 1_600);
  }
  const evictionJson = JSON.parse(readFileSync(evictionIndex, 'utf8')) as {
    records?: Array<{ name?: string }>;
  };
  const persistedNames = (evictionJson.records ?? []).map((record) => record.name);
  check('12a byte pressure evicts an older deterministic prefix',
    persistedNames.length > 0 && persistedNames.length < 5 && persistedNames.at(-1) === 'bounded-4.txt',
    persistedNames.join(','));
  const evictionRestart = new ArtifactStore('http://persist-eviction.test', evictionRoot, {
    maxIndexBytes: 1_600,
    maxRecords: 10,
    sessionReplayLimit: 10,
  });
  const restartedEvictionNames = evictionRestart
    .sessionQualifiedArtifacts({ tool: 'pi', id: 'owner' })
    .map((message) => message.name);
  check('12b the bounded persisted suffix replays unchanged after restart',
    JSON.stringify(restartedEvictionNames) === JSON.stringify(persistedNames),
    restartedEvictionNames.join(','));

  // Freeze wall time and choose the new key so it sorts before the existing
  // key. The former timestamp+key eviction would acknowledge `a`, evict it in
  // the same put, and leave only `z`. The required record must survive the
  // persistence transaction, immediate download, and restart replay.
  const collisionRoot = join(root, 'index-persist-clock-collision');
  const collisionIndex = join(collisionRoot, 'artifacts', 'index.json');
  const originalNow = Date.now;
  try {
    Date.now = () => 1_900_000_000_000;
    const collisionStore = new ArtifactStore('http://persist-collision.test', collisionRoot, {
      maxIndexBytes: 1_000,
      maxRecords: 10,
      sessionReplayLimit: 10,
    });
    collisionStore.putBytes(
      { tool: 'pi', id: 'owner' },
      {
        type: 'file-artifact',
        artifactKey: 'z',
        name: 'older-z.txt',
        path: 'older-z.txt',
        mimeType: 'text/plain',
      },
      Buffer.from('older-z'),
      'text/plain',
      undefined,
      { sessionQualified: true },
    );
    const accepted = collisionStore.putBytes(
      { tool: 'pi', id: 'owner' },
      {
        type: 'file-artifact',
        artifactKey: 'a',
        name: 'newer-a.txt',
        path: 'newer-a.txt',
        mimeType: 'text/plain',
      },
      Buffer.from('newer-a'),
      'text/plain',
      undefined,
      { sessionQualified: true },
    );
    const collisionJson = JSON.parse(readFileSync(collisionIndex, 'utf8')) as {
      records?: Array<{ artifactKey?: string }>;
    };
    check('13 frozen-clock pressure retains the acknowledged reverse-sorted key',
      collisionJson.records?.length === 1 && collisionJson.records[0]?.artifactKey === 'a',
      (collisionJson.records ?? []).map((record) => record.artifactKey).join(','));
    const acceptedUrl = new URL(String(accepted.fetchUrl));
    const immediate = collisionStore.serve(
      'pi',
      'owner',
      'a',
      acceptedUrl.searchParams.get('expires'),
      acceptedUrl.searchParams.get('sig'),
    );
    check('13a frozen-clock acknowledged artifact downloads immediately',
      immediate.status === 200 && await immediate.text() === 'newer-a',
      `status=${immediate.status}`);
    const collisionRestart = new ArtifactStore('http://persist-collision.test', collisionRoot, {
      maxIndexBytes: 1_000,
      maxRecords: 10,
      sessionReplayLimit: 10,
    });
    const collisionReplay = collisionRestart
      .sessionQualifiedArtifacts({ tool: 'pi', id: 'owner' });
    check('13b frozen-clock acknowledged artifact replays after restart',
      collisionReplay.length === 1 && collisionReplay[0]?.artifactKey === 'a',
      collisionReplay.map((message) => message.artifactKey).join(','));
    const afterRestart = collisionRestart.serve(
      'pi',
      'owner',
      'a',
      acceptedUrl.searchParams.get('expires'),
      acceptedUrl.searchParams.get('sig'),
    );
    check('13c frozen-clock replay remains downloadable after restart',
      afterRestart.status === 200 && await afterRestart.text() === 'newer-a',
      `status=${afterRestart.status}`);
  } finally {
    Date.now = originalNow;
  }

  // A protected artifact larger than the cache cannot satisfy retention. Its
  // refusal must roll back the map and durable index from before the put, and
  // must remove the content-addressed blob created before the transaction.
  const capacityRoot = join(root, 'cache-byte-capacity-refusal');
  const capacityIndex = join(capacityRoot, 'artifacts', 'index.json');
  const capacityBlobs = join(capacityRoot, 'artifacts', 'blobs');
  const priorMaxBytes = process.env.COSYNCING_ARTIFACT_CACHE_MAX_BYTES;
  try {
    process.env.COSYNCING_ARTIFACT_CACHE_MAX_BYTES = '1';
    const capacityStore = new ArtifactStore('http://capacity-refusal.test', capacityRoot, {
      maxRecords: 10,
      sessionReplayLimit: 10,
    });
    capacityStore.putBytes(
      { tool: 'pi', id: 'owner' },
      {
        type: 'file-artifact',
        artifactKey: 'keep',
        name: 'keep.txt',
        path: 'keep.txt',
        mimeType: 'text/plain',
      },
      Buffer.from('k'),
      'text/plain',
      undefined,
      { sessionQualified: true },
    );
    const indexBeforeRefusal = readFileSync(capacityIndex, 'utf8');
    const blobsBeforeRefusal = filesBelow(capacityBlobs);
    let capacityRefused = false;
    try {
      capacityStore.putBytes(
        { tool: 'pi', id: 'owner' },
        {
          type: 'file-artifact',
          artifactKey: 'too-big',
          name: 'too-big.txt',
          path: 'too-big.txt',
          mimeType: 'text/plain',
        },
        Buffer.from('xx'),
        'text/plain',
        undefined,
        { sessionQualified: true },
      );
    } catch {
      capacityRefused = true;
    }
    check('14 over-capacity artifact is refused', capacityRefused);
    const liveCapacityKeys = capacityStore
      .sessionQualifiedArtifacts({ tool: 'pi', id: 'owner' })
      .map((message) => message.artifactKey);
    check('14a refusal restores the prior live record map',
      JSON.stringify(liveCapacityKeys) === JSON.stringify(['keep']),
      liveCapacityKeys.join(','));
    check('14b refusal leaves the prior durable index byte-exact',
      readFileSync(capacityIndex, 'utf8') === indexBeforeRefusal);
    const blobsAfterRefusal = filesBelow(capacityBlobs);
    check('14c refusal removes the newly created unreferenced blob',
      JSON.stringify(blobsAfterRefusal) === JSON.stringify(blobsBeforeRefusal),
      `before=${blobsBeforeRefusal.length},after=${blobsAfterRefusal.length}`);
    const capacityRestart = new ArtifactStore('http://capacity-refusal.test', capacityRoot, {
      maxRecords: 10,
      sessionReplayLimit: 10,
    });
    const capacityRestartKeys = capacityRestart
      .sessionQualifiedArtifacts({ tool: 'pi', id: 'owner' })
      .map((message) => message.artifactKey);
    check('14d refusal has no restart replay or ghost record',
      JSON.stringify(capacityRestartKeys) === JSON.stringify(['keep']),
      capacityRestartKeys.join(','));
  } finally {
    if (priorMaxBytes == null) delete process.env.COSYNCING_ARTIFACT_CACHE_MAX_BYTES;
    else process.env.COSYNCING_ARTIFACT_CACHE_MAX_BYTES = priorMaxBytes;
  }
} catch (error) {
  failures++;
  console.error(`FAIL  production-path fixture threw\n${error instanceof Error ? error.stack : String(error)}`);
} finally {
  for (const phone of phones) phone.close();
  await stopBroker(brokerA);
  await stopBroker(brokerB);
  await leaseA.release().catch(() => undefined);
  await leaseB.release().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
