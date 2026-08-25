#!/usr/bin/env bun
/**
 * Phase 6 slice 4 — Pi terminal true-sync and approvals on native Windows.
 *
 * The last two advertised capabilities without native evidence, and they are one mechanism wearing
 * two hats. `PiAdapter.attach(..., 'live')` refuses by construction; a live Pi session reaches
 * cosyncing only through the bridge EXTENSION loaded inside that Pi, which hellos to a broker and
 * then relays events out and pulls commands back in. So neither true-sync nor a permission prompt
 * is reachable from the adapter alone, and this slice runs the whole path: a real broker, a real
 * Pi process, the real extension, on this host.
 *
 * The Windows-specific risk is concentrated in ONE place and this slice exists to hit it: session
 * IDENTITY. The extension hellos with the session path as Pi sees it — a drive letter, backslashes,
 * whatever case the shell produced — and the broker derives a bridge id from that string, while the
 * adapter derives a session id from its own discovery of the same file. If those two ids disagree
 * on Windows, the live row and the discovered row are two different sessions and true-sync silently
 * never attaches to anything. Nothing about that risk exists on a POSIX path.
 *
 * Deliberately NOT claimed: the interactive TUI. Pi runs here in RPC mode, which loads the same
 * extension and fires the same `tool_call` approval hook; the terminal shell around it is not
 * exercised and is not evidenced.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { win32 } from 'node:path';
import {
  bunSpawnResolvedInvocation,
  resolveInvocation,
} from '../../../packages/typescript/adapter-api/src/invocation.ts';
import {
  terminateHostProcessTree,
} from '../../../packages/typescript/adapter-api/src/host-process.ts';
import {
  BROKER_CONTRACT_REVISION,
  CLIENT_MINIMUM_BROKER_CONTRACT_REVISION,
} from '../../../packages/typescript/protocol/src/index.ts';
import { captureHostSnapshot } from './phase6-host-snapshot.ts';
import { AgentDirectoryGuard } from './phase6-agent-dir-guard.ts';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Phase 6 Pi bridge probe requires ${name}`);
  return value;
}

const root = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_ROOT');
const runId = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_RUN_ID');
const sourceCommit = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_COMMIT');
const sourceDirty = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_DIRTY');
if (process.platform !== 'win32') {
  throw new Error('Phase 6 Pi bridge probe requires its native Windows runner environment');
}

const sessionDir = win32.join(root, 'sessions');
const workspace = win32.join(root, 'workspace');
const brokerHome = win32.join(root, 'broker-home');
mkdirSync(sessionDir, { recursive: true });
mkdirSync(workspace, { recursive: true });
mkdirSync(brokerHome, { recursive: true });

const agentDir = process.env.PI_CODING_AGENT_DIR?.trim()
  || win32.join(requiredEnvironment('USERPROFILE'), '.pi', 'agent');
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
// Unlike the other slices this one WANTS the extension installed — that is the thing under test —
// so auto-install stays on. `COSYNCING_NO_BRIDGE` still keeps the probe's OWN adapter children
// dormant: only the one Pi this probe spawns deliberately is bridged, and its environment clears
// the variable explicitly.
delete process.env.COSYNCING_PI_BRIDGE_AUTOINSTALL;
process.env.COSYNCING_NO_BRIDGE = '1';
delete process.env.COSYNCING_PI_SESSIONS_ROOT;

/**
 * `extensions` is declared removable because this slice creates it, and the guard refuses to
 * remove a directory it merely found. If the operator already has one, this probe does not run at
 * all: installing into their tree and then deleting it is not this harness's business.
 */
const guard = AgentDirectoryGuard.acquire({
  agentDir,
  runId,
  fallbackLockDir: root,
  declarationVariable: 'COSYNCING_WINDOWS_PHASE6_EXCLUSIVE_AGENT',
  removableCreatedEntries: ['extensions'],
});
if (guard.has('extensions')) {
  guard.release();
  throw new Error(
    'The Pi agent directory already has an extensions tree. This probe installs and then removes '
    + 'the bridge extension, and it will not touch a tree the operator owns.',
  );
}

const pi = await import('../../../packages/typescript/adapters/pi/src/implementation.ts');

const observations: Record<string, unknown> = {};
const findings: string[] = [];
const note = (message: string): void => { if (!findings.includes(message)) findings.push(message); };

const REQUIRED_ASSERTIONS = [
  'extension.installedByTheAdapter',
  'broker.becameHealthy',
  'bridge.helloReachedTheBroker',
  'bridge.idMatchesTheAdapterSessionId',
  'bridge.rosterRowIsLiveAndSynced',
  'bridge.driveTakeoverIsNotOffered',
  'client.socketOpened',
  'client.socketIsWritable',
  'client.historyPrimedBeforeLiveRows',
  'permission.requestReachedTheClient',
  'permission.decisionReachedTheExtension',
  'permission.toolRanAfterApproval',
  'permission.approvedToolNamedTheFile',
  'turn.completed',
  'bridge.byeRetiredTheLiveRow',
  'teardown.snapshotsSucceeded',
  'teardown.noSurvivingAgentProcess',
  'cleanup.disposableRootRemoved',
  'cleanup.agentDirectoryRestored',
  'cleanup.probeCreatedEntriesRemoved',
] as const;
const required: Record<string, boolean> = {};
const assertRequired = (name: (typeof REQUIRED_ASSERTIONS)[number], held: boolean): boolean => {
  required[name] = held;
  return held;
};

/**
 * Every request this probe makes, bounded.
 *
 * `until()` checks its deadline BETWEEN attempts, so an unbounded `fetch` inside the predicate
 * defeats the bound entirely — one hung request and the wait never ends. That is not theoretical:
 * a lane sat for twenty minutes on a wait written as if it were bounded.
 */
async function ask(url: string, timeoutMs = 10_000): Promise<Response | undefined> {
  try { return await fetch(url, { signal: AbortSignal.timeout(timeoutMs) }); } catch { return undefined; }
}

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(200);
  }
}

/** A loopback port nothing is listening on, taken by binding and releasing it. */
async function reservePort(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const port = server.port;
  server.stop(true);
  if (typeof port !== 'number') throw new Error('could not reserve a loopback port');
  return port;
}

const READ_TARGET = 'phase6-approval.txt';
const READ_TOKEN = 'phase6approvaltoken';
writeFileSync(win32.join(workspace, READ_TARGET), `${READ_TOKEN}\n`, 'utf8');

const adapter = new pi.PiAdapter({ brokerUrl: 'http://127.0.0.1:1' });
const snapshotBefore = await captureHostSnapshot();
const pidsBefore = new Set((snapshotBefore?.processes ?? []).map((entry) => entry.pid));
let broker: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
let piChild: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;
let socket: WebSocket | undefined;
let base = '';
let bridgeId = '';

try {
  // 1. The adapter installs the bridge extension, exactly as it does in production on first
  //    discovery. This is the install path under test, not a hand-copied file.
  const inspectionBefore = pi.inspectPiBridgeAsset(agentDir);
  await adapter.discoverSessions();
  const inspectionAfter = pi.inspectPiBridgeAsset(agentDir);
  observations.extension = {
    statusBefore: inspectionBefore.status,
    statusAfter: inspectionAfter.status,
    // Names only: the path is under the operator's profile.
    fileName: inspectionAfter.path.split(/[\\/]/).pop(),
  };
  assertRequired('extension.installedByTheAdapter',
    inspectionBefore.status === 'missing' && inspectionAfter.status === 'owned');
  if (inspectionAfter.status !== 'owned') {
    throw new Error(`the bridge extension did not install (${inspectionAfter.status})`);
  }

  // 2. The session, BEFORE the broker. Nothing needs a broker until Pi runs, and `createSession`
  //    runs Pi's bounded runtime-readiness probe: the first run of this probe started a broker
  //    first and had that three-second probe lose its budget to the boot, refusing session
  //    creation on a Pi that was working perfectly.
  const created = await adapter.createSession({
    directory: workspace,
    title: `Phase 6 bridge ${runId}`,
  });
  const sessionFile = Buffer.from(created.id, 'base64url').toString('utf8');
  observations.session = {
    idIsBase64UrlOfThePath: existsSync(sessionFile),
    // Shape only, never the path: whether Pi's own file name carries a drive letter is the
    // Windows-specific thing worth recording.
    pathIsWindowsShaped: /^[A-Za-z]:\\/.test(sessionFile),
  };

  // 3. A fixture broker: its own state root, its own port, no host credentials, and no managed
  //    external hosts. It exists only to be the thing the extension hellos to.
  const port = await reservePort();
  base = `http://127.0.0.1:${port}`;
  // Resolved from THIS file, and started with the Bun already running it. The staged candidate is
  // not the working directory the runner hands the probe, so a relative entry path would miss it,
  // and `bun` is not necessarily on the machine PATH — the runner downloads the one in use.
  const candidateRoot = win32.resolve(import.meta.dir, '..', '..', '..');
  broker = Bun.spawn([process.execPath, 'run', win32.join(candidateRoot, 'packages', 'typescript', 'broker', 'src', 'main.ts')], {
    cwd: candidateRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      COSYNCING_HOME: brokerHome,
      COSYNCING_TOKEN: '',
      // The broker must not reach the operator's agents or start anything of theirs.
      PI_CODING_AGENT_DIR: win32.join(root, 'broker-pi-agent'),
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      COSYNCING_PI_BRIDGE_AUTOINSTALL: '0',
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
      COSYNCING_KIMI_MANAGED_HOST: '0',
      COSYNCING_DSH_MANAGED_HOST: '0',
      OPENCODE_URL: 'http://127.0.0.1:1',
      COSYNCING_DSH_BASE_URL: 'http://127.0.0.1:1',
      COSYNCING_TOKDASH_URL: 'http://127.0.0.1:1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const healthy = await until(async () => {
    return (await ask(`${base}/api/health`, 5_000))?.ok === true;
  }, 90_000);
  observations.broker = { healthy, port: 'reserved-loopback' };
  assertRequired('broker.becameHealthy', healthy);
  if (!healthy) throw new Error('the fixture broker did not become healthy');

  // 4. The real Pi, bridged. Everything about this child is the production shape except that its
  //    broker is ours: the operator's agent directory (providers, models, and now the extension),
  //    the disposable session root, and no `COSYNCING_NO_BRIDGE`.
  const invocation = resolveInvocation('pi');
  if (!invocation) throw new Error('Pi is not resolvable on PATH');
  const childEnv: Record<string, string> = { ...process.env as Record<string, string> };
  delete childEnv.COSYNCING_NO_BRIDGE;
  childEnv.COSYNCING_BROKER = base;
  // Every tool asks. The default only asks for dangerous shell commands, which a probe cannot make
  // a model produce on purpose — and asking a model to run a dangerous command to test approvals
  // is a bad trade.
  childEnv.COSYNCING_BRIDGE_APPROVALS = 'all';
  childEnv.COSYNCING_BRIDGE_APPROVAL_TIMEOUT_MS = '120000';
  piChild = bunSpawnResolvedInvocation(invocation, ['--mode', 'rpc', '--session', sessionFile], {
    cwd: workspace,
    env: childEnv,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // 5. The identity assertion. `status` is asked with the ADAPTER's id: a true answer is the
  //    broker having derived that same id from the Windows path Pi sent.
  bridgeId = created.id;
  const bridged = await until(async () => {
    const response = await ask(`${base}/pi/bridge/status?id=${encodeURIComponent(bridgeId)}`, 5_000);
    if (!response?.ok) return false;
    try { return (await response.json() as { bridged?: boolean }).bridged === true; } catch { return false; }
  }, 90_000);
  observations.bridge = { helloObserved: bridged, idQueried: 'adapter-session-id' };
  assertRequired('bridge.helloReachedTheBroker', bridged);
  assertRequired('bridge.idMatchesTheAdapterSessionId', bridged);
  if (!bridged) throw new Error('no bridge hello arrived for the adapter session id');

  // 6. The roster row a client would see.
  const rosterResponse = await ask(`${base}/api/sessions`, 15_000);
  if (!rosterResponse?.ok) throw new Error('the broker did not answer its session roster');
  const roster = await rosterResponse.json() as any;
  const rosterRows: any[] = Array.isArray(roster) ? roster : (roster?.sessions ?? []);
  const row = rosterRows.find((entry: any) => entry?.tool === 'pi' && entry?.id === bridgeId);
  observations.rosterRow = {
    present: !!row,
    attachMode: row?.attachMode,
    terminalSyncActive: row?.control?.terminalSync?.active,
    driveSupported: row?.control?.drive?.supported,
    driveState: row?.control?.drive?.state,
  };
  assertRequired('bridge.rosterRowIsLiveAndSynced',
    row?.attachMode === 'live' && row?.control?.terminalSync?.active === true);
  // A bridged session already has a writer. Offering Drive would invite a second one.
  assertRequired('bridge.driveTakeoverIsNotOffered', row?.control?.drive?.supported === false);

  // 7. A client socket, then a prompt whose tool call must be approved before it can run.
  /**
   * The socket speaks FRAMES, not agent messages: an attach arrives as `{kind:'history', messages}`
   * and every later row as `{kind:'message', message}`. Unwrapping here keeps every assertion below
   * written against the agent message the adapter actually emitted.
   */
  const frames: any[] = [];
  const rows: any[] = [];
  const wsBase = base.replace(/^http/, 'ws');
  /**
   * A client that declares an old contract is negotiated READ-ONLY, and a read-only socket's
   * prompt goes nowhere: the first run of this probe declared revision 5 — copied from a fixture
   * older than the current floor — and then waited three minutes for a permission request that
   * could never come, having sent a prompt the broker was never going to run. Declared from the
   * protocol constants so it cannot go stale again.
   */
  const params = new URLSearchParams({
    artifactMode: 'reference',
    contractRevision: String(BROKER_CONTRACT_REVISION),
    minimumBrokerRevision: String(CLIENT_MINIMUM_BROKER_CONTRACT_REVISION),
  });
  socket = new WebSocket(`${wsBase}/api/sessions/pi/${encodeURIComponent(bridgeId)}/stream?${params}`);
  socket.onmessage = (event) => {
    try {
      const frame = JSON.parse(String(event.data));
      frames.push(frame);
      if (frame?.kind === 'message' && frame.message) rows.push(frame.message);
      else if (frame?.kind === 'history' && Array.isArray(frame.messages)) rows.push(...frame.messages);
    } catch { /* asserted by the waits below */ }
  };
  const opened = await new Promise<boolean>((resolve) => {
    socket!.onopen = () => resolve(true);
    socket!.onerror = () => resolve(false);
    setTimeout(() => resolve(false), 30_000);
  });
  assertRequired('client.socketOpened', opened);
  if (!opened) throw new Error('the client socket did not open');
  // History primes an attach before any live row: a client must not see a row twice, once live and
  // once in the reset that follows it.
  // A read-only negotiation is announced, not guessed at: the broker says so in `hello` and in a
  // `notice`. Recorded rather than inferred, because it is the difference between "the prompt was
  // refused" and "the prompt ran and produced nothing".
  // WAIT for it. A socket that has just opened has no frames yet, and reading the negotiation
  // immediately raced the first one: the 1.3.8 lane judged an empty frame list and the 1.4.0 lane
  // happened to have the hello already. Under the earlier permissive check that race read as
  // "writable" from a frame that had not arrived — right by luck, on one lane, sometimes.
  const helloArrived = await until(() => frames.some((frame) => frame?.kind === 'hello'), 15_000);
  const helloFrame = frames.find((frame) => frame?.kind === 'hello');
  // Fail closed: an absent or unreadable hello is "we could not read the negotiation", which must
  // not pass as "the negotiation was fine". Only a hello that positively names the broker's own
  // contract revision AND does not declare read-only counts as writable.
  const negotiationRead = helloArrived && typeof helloFrame?.broker?.contract?.revision === 'number';
  const readOnly = !negotiationRead || helloFrame?.compatibility?.readOnly === true;
  observations.negotiation = {
    readOnly,
    helloArrived,
    compatibilityStatus: helloFrame?.compatibility?.status,
    declaredContractRevision: BROKER_CONTRACT_REVISION,
    brokerContractRevision: helloFrame?.broker?.contract?.revision,
    notices: frames.filter((frame) => frame?.kind === 'notice')
      .map((frame) => String(frame.message ?? '').slice(0, 160)),
    nacks: frames.filter((frame) => frame?.kind === 'nack')
      .map((frame) => `${String(frame.code ?? '')}: ${String(frame.message ?? '').slice(0, 120)}`),
  };
  assertRequired('client.socketIsWritable', !readOnly);
  if (readOnly) {
    throw new Error(negotiationRead
      ? 'the client socket was negotiated read-only, so no prompt can run'
      : helloArrived
        ? 'the broker did not state a contract revision, so the negotiation could not be read'
        : 'the broker sent no hello, so the negotiation could not be read');
  }
  const primed = await until(() => frames.some((frame) => frame?.kind === 'history'), 30_000);
  const firstLiveIndex = frames.findIndex((frame) => frame?.kind === 'message');
  const firstPrimeIndex = frames.findIndex((frame) => frame?.kind === 'history');
  observations.attach = {
    primed,
    frameKinds: [...new Set(frames.map((frame) => String(frame?.kind ?? 'unknown')))].sort(),
  };
  assertRequired('client.historyPrimedBeforeLiveRows',
    primed && firstPrimeIndex !== -1 && (firstLiveIndex === -1 || firstPrimeIndex < firstLiveIndex));

  socket.send(JSON.stringify({
    kind: 'prompt',
    text: `Use your file reading tool to read ${READ_TARGET} in the current directory, then reply with the single word it contains.`,
  }));

  const permissionFrame = await until(
    () => rows.some((row) => row?.type === 'permission-request' && row?.requestId),
    180_000,
  );
  const request = rows.find((row) => row?.type === 'permission-request' && row?.requestId);
  observations.permission = {
    requested: permissionFrame,
    // The tool NAME is evidence; its arguments carry the operator's paths and are not recorded.
    toolName: request?.toolName ?? request?.title ?? undefined,
  };
  assertRequired('permission.requestReachedTheClient', permissionFrame && !!request);
  if (!request) throw new Error('no permission request reached the client');

  socket.send(JSON.stringify({ kind: 'approve', requestId: String(request.requestId), decision: 'allow' }));
  const resolved = await until(
    () => rows.some((row) => row?.type === 'permission-resolved'
      && String(row?.requestId) === String(request.requestId)),
    120_000,
  );
  assertRequired('permission.decisionReachedTheExtension', resolved);
  // The point of approving is that the tool then RUNS. A resolved card with no tool result would
  // mean the decision was recorded and dropped.
  const toolRan = await until(
    () => rows.some((row) => row?.type === 'tool-result'),
    120_000,
  );
  /**
   * The approved tool must have been asked to open the file this probe named.
   *
   * An earlier revision corroborated the read by looking for a token in the model's PROSE, and
   * then reported a finding when the model summarized instead of quoting — turning ordinary model
   * behaviour into a defect. What the approval actually has to prove is that the call that was
   * gated is the call that ran, and the tool's own arguments say so. Tool arguments arrive
   * JSON-encoded, so backslashes are doubled; matching on the basename avoids the escaping
   * entirely and never records the operator's path.
   */
  const approvedToolNamedTheFile = rows.some((row) => {
    if (row?.type !== 'tool-call') return false;
    let args = '';
    try { args = typeof row.args === 'string' ? row.args : JSON.stringify(row.args ?? {}); }
    catch { return false; }
    return args.toLowerCase().includes(READ_TARGET.toLowerCase());
  });
  assertRequired('permission.toolRanAfterApproval', resolved && toolRan);
  assertRequired('permission.approvedToolNamedTheFile', approvedToolNamedTheFile);
  const completed = await until(
    () => rows.some((row) => row?.type === 'run-summary'
      && ['done', 'error', 'cancelled', 'interrupted'].includes(String(row?.status))),
    180_000,
  );
  const summaries = rows
    .filter((row) => row?.type === 'run-summary')
    .map((row) => String(row.status));
  observations.turn = {
    completed,
    runSummaries: summaries,
    toolResults: rows.filter((row) => row?.type === 'tool-result').length,
    // Measured, never required: whether the model happened to quote the file back. A model that
    // summarizes instead is behaving normally, and the approval path is proven by the tool call.
    modelQuotedTheFile: rows.some((row) => row?.type === 'model-output'
      && String(row?.text ?? row?.delta ?? '').includes(READ_TOKEN)),
    approvedToolNamedTheFile,
    kinds: [...new Set(rows.map((row) => String(row?.type ?? 'unknown')))].sort(),
  };
  assertRequired('turn.completed', completed);
  if (!approvedToolNamedTheFile) {
    note('the approved tool call did not name the file the prompt asked for');
  }

  /**
   * 8. Retirement. A terminal session that ends must stop being advertised as live.
   *
   * Pi is ended the way a terminal session ends — by closing its input, which Pi's RPC mode turns
   * into its own shutdown — because the `bye` that retires the row is sent by the EXTENSION from
   * Pi's shutdown event. A killed process never gets to say goodbye, and the row would then be
   * retired by nothing at all.
   */
  piChild.stdin.end();
  const exitedCleanly = await Promise.race([
    piChild.exited.then(() => true),
    Bun.sleep(30_000).then(() => false),
  ]);
  if (!exitedCleanly) {
    piChild.kill();
    note('Pi did not exit when its input closed, so retirement was not exercised the way it happens');
  }
  const retired = await until(async () => {
    const response = await ask(`${base}/pi/bridge/status?id=${encodeURIComponent(bridgeId)}`, 5_000);
    if (!response?.ok) return false;
    try { return (await response.json() as { bridged?: boolean }).bridged === false; } catch { return false; }
  }, 60_000);
  observations.retirement = { liveRowRetired: retired };
  assertRequired('bridge.byeRetiredTheLiveRow', retired);
  if (!retired) note('the live row was still advertised after the Pi process ended');
} catch (error) {
  observations.aborted = { reason: String(error).split('\n')[0]!.slice(0, 200) };
  note('the bridge probe stopped early; observations recorded up to that point');
} finally {
  try { socket?.close(); } catch { /* already closing */ }
  // The tree, not the process: `pi` is `cmd.exe /c pi.cmd`, so killing what we hold leaves the
  // `node.exe` actually running Pi alive — still holding this probe's pipes, which is why a lane
  // that had finished its work could not exit.
  for (const child of [piChild, broker]) {
    if (!child) continue;
    try { child.stdin?.end?.(); } catch { /* already closed */ }
    try { terminateHostProcessTree(child.pid, true); } catch { /* already gone */ }
    try { child.kill(); } catch { /* already gone */ }
  }
  await Promise.race([
    Promise.allSettled([piChild?.exited, broker?.exited].filter(Boolean) as Promise<unknown>[]),
    Bun.sleep(15_000),
  ]);
  await Bun.sleep(1_000);
  const snapshotAfter = await captureHostSnapshot();
  const survivors = (snapshotAfter?.processes ?? []).filter((entry) =>
    !pidsBefore.has(entry.pid) && /^(?:pi|node|bun)(?:\.exe)?$/i.test(entry.name));
  const snapshotsSucceeded = snapshotBefore?.processesOk === true && snapshotAfter?.processesOk === true;
  observations.teardown = {
    snapshotsSucceeded,
    survivingAgentProcesses: snapshotsSucceeded ? survivors.length : undefined,
    survivingNames: snapshotsSucceeded ? [...new Set(survivors.map((entry) => entry.name))].sort() : undefined,
  };
  assertRequired('teardown.snapshotsSucceeded', snapshotsSucceeded);
  assertRequired('teardown.noSurvivingAgentProcess', snapshotsSucceeded && survivors.length === 0);
  if (!snapshotsSucceeded) note('a process snapshot failed, so surviving processes are unknown');
  if (survivors.length) note('processes outlived the probe and were left for the owner to inspect');

  let removed = false;
  try { rmSync(root, { recursive: true, force: true }); removed = !existsSync(root); } catch { removed = false; }
  const cleanup = guard.restore();
  for (const message of cleanup.notes) note(message);
  observations.cleanup = { disposableRootRemoved: removed, agentDirectory: cleanup.observations };
  observations.exclusiveUse = guard.exclusiveUse;
  assertRequired('cleanup.disposableRootRemoved', removed);
  assertRequired('cleanup.agentDirectoryRestored', cleanup.restored);
  assertRequired('cleanup.probeCreatedEntriesRemoved', cleanup.createdEntriesRemoved);
  if (!removed) note('the disposable probe root could not be removed');

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    runId,
    slice: 'pi-bridge-truesync',
    source: { commit: sourceCommit, dirty: sourceDirty === 'true' },
    host: { platform: process.platform, arch: process.arch },
    runtime: { bun: Bun.version },
    observations,
    required,
    requiredUnmet: REQUIRED_ASSERTIONS.filter((name) => required[name] !== true),
    findings,
    deferred: [
      "Pi's interactive TUI shell: this runs the same extension and the same approval hook under "
      + 'RPC mode, and does not evidence the terminal UI around it',
    ],
    result: REQUIRED_ASSERTIONS.every((name) => required[name] === true) && findings.length === 0
      ? 'pass'
      : 'finding',
  })}\n`);
}
