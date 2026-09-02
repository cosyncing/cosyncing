#!/usr/bin/env bun
/**
 * Phase 6 OpenCode slice 2 — driving a managed serve on native Windows.
 *
 * Slice 1 proved the broker can prove the serve is its own. This asks the next question: through
 * that serve, can the broker create a session, send a prompt, read the reply back out of its own
 * normalized history, and STOP a running turn? Those are the three things the app does, and each
 * one crosses the boundary Windows changes — a child process launched through a batch shim, a
 * loopback HTTP client, and a cancellation that has to reach a network read inside that child.
 *
 * The model is a fake this probe runs on a bound loopback port and declares to OpenCode through
 * `OPENCODE_CONFIG_CONTENT`. Two reasons, and neither is convenience:
 *   - abort is only testable against a turn that is provably still running. A real model finishes
 *     when it finishes; a fake one streams until told to stop, so "the turn was live when the
 *     broker stopped it" is a fact rather than a race.
 *   - the operator's OpenCode config, credentials, sessions, and data directory stay untouched, and
 *     nothing this probe runs can ask a real provider anything.
 * The fake also answers a question the broker cannot: whether abort reached the model call at all,
 * since it sees its own response stream cancelled.
 *
 * Isolation: a disposable OPENCODE_DATA, OPENCODE_CONFIG_DIR, and workspace under the run root, and
 * a serve port the OS assigned by an actual bind rather than the 4096 default, which is inside a
 * Windows excluded range on this host and is where the operator's own serve would live.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { win32 } from 'node:path';
import { captureHostSnapshot } from './phase6-host-snapshot.ts';
import { HostProcessProvider, terminateHostProcessTree } from '../../../packages/typescript/adapter-api/src/host-process.ts';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Phase 6 OpenCode drive probe requires ${name}`);
  return value;
}

const root = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_ROOT');
const runId = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_RUN_ID');
const sourceCommit = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_COMMIT');
const sourceDirty = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_DIRTY');
if (process.platform !== 'win32') {
  throw new Error('Phase 6 OpenCode drive probe requires its native Windows runner environment');
}

const dataDir = win32.join(root, 'opencode-data');
const configDir = win32.join(root, 'opencode-config');
const workdir = win32.join(root, 'workspace');
const recordPath = win32.join(root, 'serve-ownership.json');
for (const dir of [dataDir, configDir, workdir]) mkdirSync(dir, { recursive: true });

const PROVIDER_ID = 'phase6';
const MODEL_ID = 'phase6-echo';
const SENTINEL = 'PHASE6-REPLY-OK';
const SLOW_MARKER = 'PHASE6-SLOW';

const observations: Record<string, unknown> = {};
const findings: string[] = [];
const note = (message: string): void => { if (!findings.includes(message)) findings.push(message); };

const REQUIRED_ASSERTIONS = [
  'serve.becameReachable',
  'serve.provenOwnByTheBroker',
  'model.configuredModelIsSelectable',
  'create.sessionCreated',
  'create.sessionIsDriveable',
  'create.sessionDiscovered',
  'send.promptAccepted',
  'send.reachedTheModel',
  'send.replyObservedInBrokerHistory',
  'send.replyStreamedLive',
  'abort.turnWasRunningWhenStopped',
  'abort.stopAccepted',
  'abort.cancelledTheModelCall',
  'abort.sessionReturnedToIdle',
  'abort.turnStayedStopped',
  'stop.portFreed',
  'teardown.snapshotsSucceeded',
  'teardown.noSurvivingServeProcess',
  'cleanup.disposableRootRemoved',
] as const;
const required: Record<string, boolean> = {};
const assertRequired = (name: (typeof REQUIRED_ASSERTIONS)[number], held: boolean): boolean => {
  required[name] = held;
  return held;
};

const hostProcesses = new HostProcessProvider();

/** Let the OS assign a port by actually binding one — 4096 is inside a Windows excluded range on
 *  this host, where a bind fails WSAEACCES before any conflict check. */
function assignPortByBind(): number {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const assigned = server.port;
  server.stop(true);
  return assigned;
}

// ---------------------------------------------------------------------------------------------
// The fake model. An OpenAI-compatible streaming chat endpoint, deliberately minimal: the point is
// never what it says, only WHEN it says it and whether its stream gets cancelled.
// ---------------------------------------------------------------------------------------------
const model = {
  requests: 0,
  slowRequests: 0,
  slowCancelled: 0,
  slowCompleted: 0,
  lastPath: '',
};

function sseChunk(text: string): string {
  return `data: ${JSON.stringify({
    id: 'phase6', object: 'chat.completion.chunk', created: 0, model: MODEL_ID,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  })}\n\n`;
}
function sseDone(): string {
  return `data: ${JSON.stringify({
    id: 'phase6', object: 'chat.completion.chunk', created: 0, model: MODEL_ID,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })}\n\ndata: [DONE]\n\n`;
}

const modelServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    model.lastPath = url.pathname;
    // The driving broker cannot see these counters from its own process, and "the turn is running"
    // is exactly the precondition abort needs, so the fake publishes them.
    if (url.pathname === '/phase6-status') {
      return new Response(JSON.stringify(model), { headers: { 'content-type': 'application/json' } });
    }
    if (!url.pathname.endsWith('/chat/completions')) return new Response('{}', { status: 404 });
    model.requests += 1;
    let body: any = {};
    try { body = await request.json(); } catch { /* an unparseable body is still a request */ }
    const prompt = JSON.stringify(body?.messages ?? []);
    const slow = prompt.includes(SLOW_MARKER);
    if (slow) model.slowRequests += 1;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          if (!slow) {
            controller.enqueue(encoder.encode(sseChunk(SENTINEL)));
            controller.enqueue(encoder.encode(sseDone()));
            controller.close();
            return;
          }
          // Long enough that the turn is unambiguously live when the broker stops it, bounded so a
          // probe that never aborts still ends rather than hanging the run.
          for (let tick = 0; tick < 120; tick += 1) {
            controller.enqueue(encoder.encode(sseChunk(`${SLOW_MARKER} ${tick} `)));
            await Bun.sleep(500);
          }
          controller.enqueue(encoder.encode(sseDone()));
          controller.close();
          model.slowCompleted += 1;
        } catch {
          // enqueue throws once the consumer is gone: that IS the cancellation signal.
        }
      },
      cancel() { if (slow) model.slowCancelled += 1; },
    });
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
    });
  },
});
const modelPort = modelServer.port ?? 0;
if (!modelPort) throw new Error('the fake model server did not bind a port');
const modelBaseUrl = `http://127.0.0.1:${modelPort}/v1`;

// OpenCode reads this instead of the operator's config file. The provider is fully specified here,
// so nothing has to be looked up from a catalog or authenticated against a real endpoint.
const opencodeConfig = JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  model: `${PROVIDER_ID}/${MODEL_ID}`,
  provider: {
    [PROVIDER_ID]: {
      npm: '@ai-sdk/openai-compatible',
      name: 'Phase 6 local fake',
      options: { baseURL: modelBaseUrl, apiKey: 'phase6-no-secret' },
      models: { [MODEL_ID]: { name: 'Phase 6 echo' } },
    },
  },
});

let port = 0;
let baseUrl = '';
let pidsBefore = new Set<number>();
let snapshotBefore: Awaited<ReturnType<typeof captureHostSnapshot>> = null;
/** Every pid this run spawned, so teardown can prove what is its own instead of assuming. */
const helperPids: number[] = [];

/** Run the driving broker as its own process and return the JSON report it wrote. */
async function runBroker(): Promise<Record<string, unknown>> {
  const helperPath = win32.join(import.meta.dir, 'phase6-opencode-drive-broker.ts');
  const helperReport = win32.join(root, 'broker-drive.json');
  observations.helper = { path: win32.basename(helperPath), exists: existsSync(helperPath) };
  // Output goes to FILES: a serve that outlives its broker inherits whatever handles it was given,
  // and a pipe handle here is one the staging runner ends up waiting on.
  const outFd = openSync(win32.join(root, 'broker-drive.out.log'), 'w');
  const errFd = openSync(win32.join(root, 'broker-drive.err.log'), 'w');
  try {
    const child = Bun.spawn({
      cmd: [process.execPath, helperPath],
      stdin: 'ignore',
      stdout: outFd,
      stderr: errFd,
      cwd: root,
      env: {
        ...process.env,
        OPENCODE_URL: baseUrl,
        OPENCODE_DATA: dataDir,
        OPENCODE_CONFIG_DIR: configDir,
        OPENCODE_CONFIG_CONTENT: opencodeConfig,
        COSYNCING_PHASE6_OC_RECORD: recordPath,
        COSYNCING_PHASE6_OC_REPORT: helperReport,
        COSYNCING_PHASE6_OC_WORKDIR: workdir,
        COSYNCING_PHASE6_OC_PROVIDER: PROVIDER_ID,
        COSYNCING_PHASE6_OC_MODEL: MODEL_ID,
        COSYNCING_PHASE6_OC_SENTINEL: SENTINEL,
        COSYNCING_PHASE6_OC_SLOW_MARKER: SLOW_MARKER,
        COSYNCING_PHASE6_OC_MODEL_STATUS: `http://127.0.0.1:${modelPort}/phase6-status`,
      },
    });
    if (child.pid) helperPids.push(child.pid);
    await Promise.race([child.exited, Bun.sleep(420_000)]);
    if (child.exitCode === null) { try { child.kill(); } catch { /* already gone */ } }
    if (!existsSync(helperReport)) {
      const tail = [win32.join(root, 'broker-drive.err.log'), win32.join(root, 'broker-drive.out.log')]
        .map((path) => { try { return readFileSync(path, 'utf8').trim(); } catch { return ''; } })
        .find((text) => text.length > 0)?.split('\n').filter(Boolean).at(-1) ?? 'no output';
      throw new Error(`the driving broker wrote no report (exit ${child.exitCode}): ${tail.slice(0, 300)}`);
    }
    return JSON.parse(readFileSync(helperReport, 'utf8')) as Record<string, unknown>;
  } finally {
    try { closeSync(outFd); } catch { /* already closed */ }
    try { closeSync(errFd); } catch { /* already closed */ }
  }
}

try {
  snapshotBefore = await captureHostSnapshot();
  pidsBefore = new Set((snapshotBefore?.processes ?? []).map((entry) => entry.pid));

  port = assignPortByBind();
  baseUrl = `http://127.0.0.1:${port}`;
  observations.ports = { serveAssignedByBind: port > 0, modelServerBound: modelPort > 0 };

  const drive = await runBroker();
  observations.drive = drive;
  if (drive.error) note(`the driving broker stopped at ${(drive.error as any).step}: ${(drive.error as any).reason}`);

  assertRequired('serve.becameReachable', drive.reachable === true);
  assertRequired('serve.provenOwnByTheBroker', drive.serveVerdict === 'owned');
  assertRequired('model.configuredModelIsSelectable', drive.configuredModelListed === true);
  assertRequired('create.sessionCreated', drive.sessionCreated === true);
  // A created session the app could not type into is not a driveable session.
  assertRequired('create.sessionIsDriveable', drive.createdAttachMode === 'live' && drive.createdDriveState !== 'unavailable');
  assertRequired('create.sessionDiscovered', drive.sessionDiscovered === true);
  assertRequired('send.promptAccepted', drive.promptAccepted === true);
  assertRequired('send.reachedTheModel', model.requests > 0);
  // Guarded on both sides: the phrase was absent before the send, and the prompt never contained it.
  assertRequired('send.replyObservedInBrokerHistory',
    drive.sentinelObserved === true && drive.sentinelAbsentBeforeSend === true);
  // History and the live subscription are two different surfaces, and the app reads both.
  assertRequired('send.replyStreamedLive', drive.replyStreamedLive === true);
  // Not "the session said working": the model call itself was open, and had already streamed into
  // the broker's history, when the stop was issued.
  assertRequired('abort.turnWasRunningWhenStopped',
    drive.busyObserved === true && drive.modelCallOpenBeforeAbort === true
    && drive.slowOutputObservedBeforeAbort === true && model.slowRequests > 0);
  assertRequired('abort.stopAccepted', drive.abortAccepted === true);
  // The broker calling stop is not proof the turn stopped: the model's own stream is.
  assertRequired('abort.cancelledTheModelCall', model.slowCancelled > 0 && model.slowCompleted === 0);
  assertRequired('abort.sessionReturnedToIdle', drive.idleAfterAbort === true);
  assertRequired('abort.turnStayedStopped', drive.historyGrewAfterAbort === false);
  const afterStop = drive.afterStop as { reachable?: boolean } | undefined;
  assertRequired('stop.portFreed', afterStop?.reachable === false);
  if (afterStop?.reachable !== false) note('the port was still serving after the product stopped its serve');
} catch (error) {
  observations.aborted = { reason: String(error).split('\n')[0]!.slice(0, 200) };
  note('the OpenCode drive probe stopped early; observations recorded up to that point');
} finally {
  try { modelServer.stop(true); } catch { /* already stopped */ }
  observations.model = { ...model };

  // Only what this run can PROVE is its own is killed: the process holding the port it bound, or a
  // descendant of a process it spawned. Anything else opencode-shaped is counted and left alone.
  await Bun.sleep(500);
  const listener = port ? hostProcesses.listener(port, { fresh: true }) : { state: 'absent' as const };
  const listenerPid = listener.state === 'identified' ? listener.pid : undefined;
  const isOurs = (pid: number): boolean => pid === listenerPid
    || helperPids.some((helper) => hostProcesses.descendsFrom(pid, helper) === 'yes');
  if (listenerPid !== undefined && !pidsBefore.has(listenerPid)) {
    terminateHostProcessTree(listenerPid, true);
    await Bun.sleep(1_000);
  }
  const snapshotAfter = await captureHostSnapshot();
  const appeared = (snapshotAfter?.processes ?? []).filter((entry) =>
    !pidsBefore.has(entry.pid) && /^opencode(?:\.exe)?$/i.test(entry.name));
  const survivors = appeared.filter((entry) => isOurs(entry.pid));
  const unattributed = appeared.filter((entry) => !isOurs(entry.pid));
  const removedByProbe: number[] = [];
  for (const entry of survivors) {
    try { terminateHostProcessTree(entry.pid, true); removedByProbe.push(entry.pid); } catch { /* already gone */ }
  }
  if (removedByProbe.length) await Bun.sleep(1_000);
  const snapshotFinal = removedByProbe.length ? await captureHostSnapshot() : snapshotAfter;
  const stillThere = (snapshotFinal?.processes ?? []).filter((entry) =>
    !pidsBefore.has(entry.pid) && isOurs(entry.pid));
  const snapshotsSucceeded = snapshotBefore?.processesOk === true && snapshotAfter?.processesOk === true;
  observations.teardown = {
    snapshotsSucceeded,
    survivingServeProcesses: snapshotsSucceeded ? survivors.length : undefined,
    unattributedOpencodeProcesses: snapshotsSucceeded ? unattributed.length : undefined,
    removedByProbe: removedByProbe.length,
    leftOnTheHost: snapshotsSucceeded ? stillThere.length : undefined,
  };
  assertRequired('teardown.snapshotsSucceeded', snapshotsSucceeded);
  assertRequired('teardown.noSurvivingServeProcess', snapshotsSucceeded && survivors.length === 0);
  if (!snapshotsSucceeded) note('a process snapshot failed, so surviving serve processes are unknown');
  if (survivors.length) note('serve processes outlived the probe; the probe removed them from the host');
  if (stillThere.length) note('serve processes could not be removed and were left for the owner to inspect');
  if (unattributed.length) note('opencode processes the probe could not attribute to itself were running; they were left alone');

  let removed = false;
  try { rmSync(root, { recursive: true, force: true }); removed = !existsSync(root); } catch { removed = false; }
  assertRequired('cleanup.disposableRootRemoved', removed);
  observations.cleanup = { disposableRootRemoved: removed };

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    runId,
    slice: 'opencode-drive-through-a-managed-serve',
    source: { commit: sourceCommit, dirty: sourceDirty === 'true' },
    host: { platform: process.platform, arch: process.arch },
    runtime: { bun: Bun.version },
    observations,
    required,
    requiredUnmet: REQUIRED_ASSERTIONS.filter((name) => required[name] !== true),
    findings,
    deferred: [
      'terminal routing and TUI presence',
      'file attachments, permissions, and questions, none of which this slice sends',
      'a real model provider: every turn here is answered by a local fake, so provider auth, '
      + 'streaming shape, and tool calls on Windows are not claimed',
    ],
    result: REQUIRED_ASSERTIONS.every((name) => required[name] === true) && findings.length === 0
      ? 'pass'
      : 'finding',
  })}\n`);
}
