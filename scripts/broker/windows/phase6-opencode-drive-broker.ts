#!/usr/bin/env bun
/**
 * One broker lifetime that DRIVES a managed OpenCode serve, for Phase 6 OpenCode slice 2.
 *
 * Slice 1 proved the broker can own the serve it starts. This proves it can use it: create a
 * session, send a prompt, see the reply arrive in the broker's own normalized history, and stop a
 * running turn. Every call goes through the product's `OpenCodeAdapter` and its `SessionConnection`
 * — never a hand-rolled HTTP call that could agree with a bug the adapter has.
 *
 * The model is a local fake the probe runs, declared to OpenCode through `OPENCODE_CONFIG_CONTENT`.
 * That is not a shortcut around a credential: it is the only way to make "the turn was still
 * running when we stopped it" a deterministic fact rather than a race against a real model's
 * latency, and it keeps the operator's own OpenCode credentials, sessions, and config untouched.
 *
 * Writes one JSON report to a FILE. Counts and booleans only — never a session identifier, never a
 * path outside the disposable root.
 */
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HostProcessProvider } from '../../../packages/typescript/adapter-api/src/host-process.ts';
import {
  OpenCodeAdapter,
  resolveLocalOpencodeBaseUrl,
} from '../../../packages/typescript/adapters/opencode/src/implementation.ts';
import {
  classifyServeOwnership,
  configureManagedOpencodeServeState,
  ensureManagedOpencodeServe,
  readProcessIdentity,
  stopManagedOpencodeServe,
  OPENCODE_SERVE_OWNER_SCHEMA_VERSION,
  type OpencodeServeOwnership,
} from '../../../packages/typescript/adapters/opencode/src/managed-server.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Phase 6 OpenCode drive broker requires ${name}`);
  return value;
}

const recordPath = required('COSYNCING_PHASE6_OC_RECORD');
const reportPath = required('COSYNCING_PHASE6_OC_REPORT');
const workdir = required('COSYNCING_PHASE6_OC_WORKDIR');
const providerId = required('COSYNCING_PHASE6_OC_PROVIDER');
const modelId = required('COSYNCING_PHASE6_OC_MODEL');
const sentinel = required('COSYNCING_PHASE6_OC_SENTINEL');
const slowMarker = required('COSYNCING_PHASE6_OC_SLOW_MARKER');
const modelStatusUrl = required('COSYNCING_PHASE6_OC_MODEL_STATUS');

const base = resolveLocalOpencodeBaseUrl(required('OPENCODE_URL').replace(/\/$/, ''));
const port = Number(new URL(base).port) || 4096;
const hostProcesses = new HostProcessProvider();

function readRecord(): OpencodeServeOwnership | null {
  try {
    const parsed = JSON.parse(readFileSync(recordPath, 'utf8')) as OpencodeServeOwnership;
    return parsed?.schemaVersion === OPENCODE_SERVE_OWNER_SCHEMA_VERSION ? parsed : null;
  } catch { return null; }
}

async function reachable(timeoutMs = 1_500): Promise<boolean> {
  try {
    const response = await fetch(`${base}/app`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok || response.status === 404;
  } catch { return false; }
}

/** Poll `read` until it answers true or the budget runs out. Returns how long it took, or null. */
async function until(read: () => Promise<boolean>, budgetMs: number, everyMs = 500): Promise<number | null> {
  const started = Date.now();
  for (;;) {
    if (await read()) return Date.now() - started;
    if (Date.now() - started >= budgetMs) return null;
    await Bun.sleep(everyMs);
  }
}

/** The tail of the serve's own log. OpenCode writes under `<OPENCODE_DATA>/log`, which is inside the
 *  disposable root, so this is this run's log and no one else's. */
function readServeLogTail(limit = 4_000): string {
  try {
    const logDir = join(required('OPENCODE_DATA'), 'log');
    const newest = readdirSync(logDir)
      .map((name) => ({ name, at: statSync(join(logDir, name)).mtimeMs }))
      .sort((left, right) => right.at - left.at)[0];
    if (!newest) return '';
    const text = readFileSync(join(logDir, newest.name), 'utf8');
    return text.slice(-limit);
  } catch { return ''; }
}

configureManagedOpencodeServeState({
  readOwnership: () => readRecord(),
  writeOwnership: (identity, baseUrl) => {
    const record: OpencodeServeOwnership = {
      ...identity,
      baseUrl,
      schemaVersion: OPENCODE_SERVE_OWNER_SCHEMA_VERSION,
      recordedAtMs: Date.now(),
    };
    writeFileSync(recordPath, JSON.stringify(record));
  },
  clearOwnership: () => { try { rmSync(recordPath, { force: true }); } catch { /* already gone */ } },
  recordStartFailure: () => {},
  clearStartFailure: () => {},
});

const report: Record<string, unknown> = { port };
let step = 'start';
try {
  step = 'ensure-serve';
  await ensureManagedOpencodeServe();
  report.reachable = await reachable();
  const listener = hostProcesses.listener(port, { fresh: true });
  const identity = listener.state === 'identified' ? readProcessIdentity(listener.pid, { fresh: true }) : null;
  // Drive is only meaningful against a serve this broker can prove is its own, so slice 1's verdict
  // is re-established here rather than assumed to still hold.
  report.serveVerdict = classifyServeOwnership(readRecord(), identity, base);

  step = 'adapter';
  const adapter = new OpenCodeAdapter({ baseUrl: base });
  report.adapterAvailable = await adapter.isAvailable();

  step = 'models';
  // The picker's own source. A model the adapter cannot list is one the app could never select.
  const models = await adapter.listModels();
  report.modelCount = models.length;
  report.configuredModelListed = models.some((model) =>
    model.providerID === providerId && model.modelID === modelId);

  step = 'create';
  const created = await adapter.createSession({ directory: workdir, title: 'phase6 drive' });
  const sessionId = created.id;
  report.sessionCreated = typeof sessionId === 'string' && sessionId.length > 0;
  report.createdAttachMode = created.attachMode;
  report.createdDriveState = created.control?.drive.state ?? null;

  step = 'discover';
  // Creating a session is not the same claim as the broker being able to FIND it: discovery is what
  // the app's roster is built from, and on Windows it also reads the on-disk store.
  const discovered = await adapter.discoverSessions();
  report.sessionDiscovered = discovered.some((session) => session.id === sessionId);
  report.discoveredCount = discovered.length;

  step = 'attach';
  const connection = await adapter.attach(sessionId, 'live');
  // The live subscription is where mid-turn output arrives. `getHistory` exposes a model-output part
  // only once the turn ends -- proven here: 30 seconds of streamed chunks were invisible to history
  // and appeared, whole, the moment the turn was cancelled. Asserting live streaming against history
  // would be asserting it against the wrong surface.
  let liveMessages = 0;
  let liveText = '';
  const unsubscribe = connection.subscribe((message) => {
    liveMessages += 1;
    if (liveText.length < 20_000) liveText += JSON.stringify(message);
  });

  const historyText = async (): Promise<string> => {
    try { return JSON.stringify(await connection.getHistory()); } catch { return ''; }
  };
  const statusOf = async (): Promise<string> => {
    try {
      const sessions = await adapter.discoverSessions();
      return sessions.find((session) => session.id === sessionId)?.status ?? 'unknown';
    } catch { return 'unknown'; }
  };
  const model = { providerID: providerId, modelID: modelId };

  step = 'send';
  // The prompt must NOT contain the sentinel. History includes the user's own message, so a prompt
  // that names the phrase satisfies "the reply arrived" with no model involved at all -- which is
  // exactly what the first run of this probe claimed.
  report.sentinelAbsentBeforeSend = !(await historyText()).includes(sentinel);
  await connection.sendPrompt({ text: 'Answer with your fixed phrase and nothing else.', model });
  report.promptAccepted = true;
  // The reply has to reach the BROKER's normalized history, not just the serve's database: that
  // read is the one the app makes.
  report.sentinelObservedMs = await until(async () => (await historyText()).includes(sentinel), 90_000);
  report.sentinelObserved = report.sentinelObservedMs !== null;
  report.liveMessagesAfterSend = liveMessages;
  report.replyStreamedLive = liveText.includes(sentinel);
  report.statusAfterReply = await statusOf();

  step = 'send-slow';
  await connection.sendPrompt({ text: `${slowMarker} keep going`, model });
  report.busyObservedMs = await until(async () => (await statusOf()) === 'working', 30_000, 250);
  report.busyObserved = report.busyObservedMs !== null;
  const historyAtAbort = await historyText();

  // A stop issued before OpenCode has even called the model proves nothing: the first attempt
  // cancelled the turn 94ms in, the fake model saw no request at all, and the run still looked like
  // a successful abort. Wait for the call to be OPEN and for its output to have reached history.
  report.modelCallOpenBeforeAbortMs = await until(async () => {
    try {
      const status = await (await fetch(modelStatusUrl, { signal: AbortSignal.timeout(2_000) })).json();
      return Number(status?.slowRequests) > 0;
    } catch { return false; }
  }, 30_000, 250);
  report.modelCallOpenBeforeAbort = report.modelCallOpenBeforeAbortMs !== null;
  report.slowOutputObservedBeforeAbortMs = await until(
    async () => liveText.includes(`${slowMarker} 0`), 30_000, 250);
  report.slowOutputObservedBeforeAbort = report.slowOutputObservedBeforeAbortMs !== null;

  step = 'abort';
  if (typeof connection.runCommand !== 'function') throw new Error('the OpenCode session exposes no runCommand');
  const notice = await connection.runCommand('stop');
  report.abortAccepted = true;
  report.abortReturnedNotice = !!notice;
  report.idleAfterAbortMs = await until(async () => (await statusOf()) === 'idle', 30_000, 250);
  report.idleAfterAbort = report.idleAfterAbortMs !== null;
  // A stopped turn must stay stopped. Two reads a few seconds apart, both taken AFTER the session
  // went idle: if the model stream were still running, the second would be longer than the first.
  const historyAtIdle = await historyText();
  await Bun.sleep(4_000);
  const historyAfterSettling = await historyText();
  report.historyGrewAfterAbort = historyAfterSettling !== historyAtIdle;
  report.historyGrewDuringTurn = historyAtIdle.length > historyAtAbort.length;

  unsubscribe();
  step = 'diagnostics';
  // Bounded, and from a disposable session whose only correspondent is a local fake model: when a
  // turn produces no model call, the answer is in one of these two and nowhere else.
  report.historySample = (await historyText()).slice(0, 3_000);
  report.serveLogTail = readServeLogTail();

  step = 'stop-serve';
  await stopManagedOpencodeServe();
  const stopped = hostProcesses.listener(port, { fresh: true });
  report.afterStop = { reachable: await reachable(), listener: { state: stopped.state } };
  step = 'done';
} catch (error) {
  report.error = { step, reason: String(error).split('\n')[0]!.slice(0, 300) };
}
report.reachedStep = step;

await Bun.write(reportPath, JSON.stringify(report));
await Bun.write(Bun.stdout, `${JSON.stringify(report)}\n`);
// Exit explicitly: a broker holding a serve keeps its diagnostic capture open by construction, so
// the loop never drains on its own.
process.exit(0);
