#!/usr/bin/env bun
/**
 * Phase 6 slice 2 — Pi drive trace on native Windows.
 *
 * Slice 1 proved the launcher: resolution, runtime readiness, bridge install, and one non-model
 * RPC round trip. This drives the adapter's OWN surface instead — `PiAdapter.createSession`,
 * `discoverSessions`, `attach(..., 'resume')`, `sendPrompt`, `sendFile`, `runCommand('stop')`,
 * `getHistory`, `close` — because that, not a hand-rolled RPC client, is what the broker calls.
 *
 * The session root and workspace are disposable and on NTFS. The agent directory is the
 * operator's own, because providers, model selection, and credentials live there and a disposable
 * copy would either have no providers or require copying their secrets; the two writes that would
 * reach it — bridge auto-install and the session root — are switched off instead, and the probe
 * records that its entry list is unchanged. The report carries provider and model IDENTIFIERS
 * (already documented in the harness state) and never credentials, prompts' answers, or
 * transcript content.
 *
 * Model turns are MEASURED, not asserted. An unreachable provider is a finding about this host on
 * this day, not a reason to discard the deterministic evidence around it.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { win32 } from 'node:path';
import { captureHostSnapshot } from './phase6-host-snapshot.ts';
import { AgentDirectoryGuard } from './phase6-agent-dir-guard.ts';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Phase 6 Pi trace probe requires ${name}`);
  return value;
}

const root = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_ROOT');
const runId = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_RUN_ID');
const sourceCommit = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_COMMIT');
const sourceDirty = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_DIRTY');
if (process.platform !== 'win32') {
  throw new Error('Phase 6 Pi trace probe requires its native Windows runner environment');
}

const sessionDir = win32.join(root, 'sessions');
const workspace = win32.join(root, 'workspace');
mkdirSync(sessionDir, { recursive: true });
mkdirSync(workspace, { recursive: true });

// The agent directory is deliberately NOT redirected. Providers, model selection, and credentials
// all live there, and a disposable copy would either have no providers — the first run of this
// probe reported an empty catalog and `No API key found` on every turn, which said nothing about
// Windows — or require copying the operator's secrets somewhere new. So Pi reads the operator's
// real configuration exactly as it would in production, and the two things that would WRITE there
// are switched off instead:
//
//   * bridge auto-install, which is the only write `discoverSessions` performs;
//   * the session root, so no transcript of this probe joins the operator's history and no
//     session of theirs is discovered, attached, or driven.
//
// The adapter already forces COSYNCING_NO_BRIDGE for every Pi it spawns; setting it here keeps
// this probe's own children consistent with that.
const agentDir = process.env.PI_CODING_AGENT_DIR?.trim()
  || win32.join(requiredEnvironment('USERPROFILE'), '.pi', 'agent');
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
process.env.COSYNCING_PI_BRIDGE_AUTOINSTALL = '0';
process.env.COSYNCING_NO_BRIDGE = '1';
delete process.env.COSYNCING_PI_SESSIONS_ROOT;

/**
 * Exclusive use of the operator's Pi directory, and the rollback that use requires.
 *
 * Both live in `phase6-agent-dir-guard.ts` rather than here: every Phase 6 probe that reads the
 * operator's own directory needs the same lock, the same link-safe capture, and the same bounded
 * restore, and the rollback is the part most able to do harm. One implementation, not one per
 * probe.
 */
const guard = AgentDirectoryGuard.acquire({
  agentDir,
  runId,
  fallbackLockDir: root,
  declarationVariable: 'COSYNCING_WINDOWS_PHASE6_EXCLUSIVE_AGENT',
});

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const pi = await import('../../../packages/typescript/adapters/pi/src/implementation.ts');

const observations: Record<string, unknown> = {};
const findings: string[] = [];
const note = (message: string): void => { if (!findings.includes(message)) findings.push(message); };

/**
 * The assertions this slice exists to make. Recording an observation is not the same as requiring
 * it: an earlier revision of this probe reported `pass` while proving neither that the attachment
 * reached a tool nor that Pi applied the model it was asked for. Every name below must be present
 * AND true, so a trace that stops early fails rather than passing on the assertions it reached.
 */
const REQUIRED_ASSERTIONS = [
  'adapter.available',
  'adapter.capabilitiesAsExpected',
  'models.catalogueNonEmpty',
  'session.emptyRootDiscoversNothing',
  'session.createdIsDiscovered',
  'session.titleRoundTrips',
  'session.cwdIsWorkspace',
  'session.driveSupported',
  'attach.liveRefusedWithoutBridge',
  'attach.resumeIsDriving',
  'prompt.accepted',
  'prompt.endedDone',
  'prompt.streamedModelOutput',
  'attachment.accepted',
  'attachment.endedDone',
  'attachment.materializedUnderWorkspace',
  'attachment.toolOpenedTheAbsolutePath',
  'models.appliedRequestedModel',
  'abort.runStarted',
  'abort.endedCancelled',
  'history.hasUserAndAssistantTurns',
  'resume.containsLiveTranscriptAsPrefix',
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

interface ToolCall { toolName: string; args: string }

interface Recorded {
  kinds: Record<string, number>;
  sawModelOutput: boolean;
  statuses: string[];
  runSummaries: string[];
  permissionRequests: number;
  questionRequests: number;
  errors: string[];
  /** Held in memory only: a tool's arguments carry the operator's absolute paths. */
  toolCalls: ToolCall[];
  toolResults: number;
  /** Model IDs Pi itself reported through `sessionInfo`, which is the authoritative selection. */
  appliedModelIds: string[];
}

function recorder(): { recorded: Recorded; handle: (message: any) => void } {
  const recorded: Recorded = {
    kinds: {},
    sawModelOutput: false,
    statuses: [],
    runSummaries: [],
    permissionRequests: 0,
    questionRequests: 0,
    errors: [],
    toolCalls: [],
    toolResults: 0,
    appliedModelIds: [],
  };
  return {
    recorded,
    handle: (message: any) => {
      const kind = String(message?.type ?? 'unknown');
      recorded.kinds[kind] = (recorded.kinds[kind] ?? 0) + 1;
      if (kind === 'model-output') recorded.sawModelOutput = true;
      if (kind === 'status' && typeof message.status === 'string') recorded.statuses.push(message.status);
      if (kind === 'run-summary' && typeof message.status === 'string') recorded.runSummaries.push(message.status);
      if (kind === 'permission-request') recorded.permissionRequests += 1;
      if (kind === 'question-request') recorded.questionRequests += 1;
      // Only the first line and a bounded length: an error can quote provider responses.
      if (kind === 'error') recorded.errors.push(String(message.message ?? '').split('\n')[0]!.slice(0, 160));
      if (kind === 'tool-call') {
        let args = '';
        try { args = typeof message.args === 'string' ? message.args : JSON.stringify(message.args ?? {}); }
        catch { args = ''; }
        recorded.toolCalls.push({ toolName: String(message.toolName ?? 'tool'), args: args.slice(0, 8192) });
      }
      if (kind === 'tool-result') recorded.toolResults += 1;
      if (kind === 'metadata-update' && message.key === 'sessionInfo') {
        const applied = message.value?.currentModel?.modelID;
        if (typeof applied === 'string' && applied) recorded.appliedModelIds.push(applied);
      }
    },
  };
}

/** Wait for a predicate over the recorded stream, bounded. Returns whether it became true. */
async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(200);
  }
  return predicate();
}

const TERMINAL_RUN_STATUSES = new Set(['done', 'error', 'cancelled', 'interrupted']);

/**
 * Where the stream stood before a turn was sent.
 *
 * Turn boundaries have to be measured from a mark rather than from the stream's tail: a session
 * that has already run one turn is sitting at `idle`, so "the last status is idle" is true the
 * instant the NEXT turn is sent and every wait on it returns immediately. The first run of this
 * probe reported an attachment turn as settled without ever waiting for it.
 */
interface StreamMark { runs: number; statuses: number; kinds: Record<string, number> }
const mark = (recorded: Recorded): StreamMark => ({
  runs: recorded.runSummaries.length,
  statuses: recorded.statuses.length,
  kinds: { ...recorded.kinds },
});
const settled = (recorded: Recorded, at: StreamMark): boolean => {
  if (recorded.runSummaries.slice(at.runs).some((status) => TERMINAL_RUN_STATUSES.has(status))) return true;
  // Fallback for a degraded stream that forwards status but no run summary: this turn's own
  // running -> idle transition, not a stale idle from the previous one.
  const since = recorded.statuses.slice(at.statuses);
  const running = since.indexOf('running');
  return running !== -1 && since.lastIndexOf('idle') > running;
};
const kindsSince = (recorded: Recorded, at: StreamMark): Record<string, number> => {
  const delta: Record<string, number> = {};
  for (const [kind, count] of Object.entries(recorded.kinds)) {
    const added = count - (at.kinds[kind] ?? 0);
    if (added > 0) delta[kind] = added;
  }
  return delta;
};

const ATTACHMENT_PAYLOAD = Buffer.from('phase 6 attachment probe\n', 'utf8');
const ATTACHMENT_BYTES = ATTACHMENT_PAYLOAD.byteLength;

const EXPECTED_CAPABILITIES = [
  'supportsCrossClientDriveSharing',
  'supportsLiveAttach',
  'supportsModelSwitch',
  'supportsNativeFileInput',
  'supportsObserve',
  'supportsResume',
];

const adapter = new pi.PiAdapter({ brokerUrl: 'http://127.0.0.1:1' });
let connection: any;
let reattached: any;
const snapshotBefore = await captureHostSnapshot();
const pidsBefore = new Set((snapshotBefore?.processes ?? []).map((entry) => entry.pid));

try {
  observations.operatorInstallation = {
    // Named as a posture, never as a path.
    agentDirectory: 'operator-default',
    sessionRootRedirected: true,
    bridgeAutoInstallSuppressed: true,
    entriesBefore: guard.entryCount,
  };
  observations.exclusiveUse = guard.exclusiveUse;
  observations.availability = {
    isAvailable: await adapter.isAvailable(),
    canCreateSession: adapter.canCreateSession(),
    capabilities: Object.entries(adapter.capabilities)
      .filter(([, value]) => value === true)
      .map(([key]) => key)
      .sort(),
    transcriptExportFormat: adapter.transcriptExportFormat,
  };
  const capabilities = Object.entries(adapter.capabilities)
    .filter(([, value]) => value === true).map(([key]) => key).sort();
  assertRequired('adapter.available', (await adapter.isAvailable()) && adapter.canCreateSession());
  // Exact, not superset: a capability appearing without a native trace behind it is the release
  // blocker this slice exists to keep closed.
  assertRequired('adapter.capabilitiesAsExpected', sameList(capabilities, EXPECTED_CAPABILITIES));
  if (!adapter.canCreateSession()) {
    throw new Error('Pi runtime readiness refused session creation on this host');
  }

  // 1. Model catalog. This spawns Pi in catalog-only mode and reads the operator's configured
  //    providers, which is the picker's real source.
  const models = await adapter.listModels();
  const defaultModel = models[0];
  observations.modelCatalog = {
    count: models.length,
    providers: [...new Set(models.map((model: any) => String(model.providerID)))].sort(),
    firstModelId: defaultModel ? String(defaultModel.modelID) : undefined,
  };
  assertRequired('models.catalogueNonEmpty', models.length > 0);
  if (!defaultModel) note('the model catalog was empty, so per-turn model override was not traced');
  const secondModel = models.find((model: any) => String(model.modelID) !== String(defaultModel?.modelID));

  // 2. Discovery over an empty disposable root, then over one created session.
  const before = await adapter.discoverSessions();
  const created = await adapter.createSession({
    directory: workspace,
    title: `Phase 6 trace ${runId}`,
  });
  const after = await adapter.discoverSessions();
  const discovered = after.find((session: any) => session.id === created.id);
  observations.sessionLifecycle = {
    discoveredBeforeCreate: before.length,
    discoveredAfterCreate: after.length,
    createdIsDiscovered: !!discovered,
    titleRoundTrips: discovered?.title === created.title,
    cwdIsWorkspace: discovered?.cwd?.toLowerCase() === workspace.toLowerCase(),
    attachMode: discovered?.attachMode,
    status: discovered?.status,
    driveSupported: discovered?.control?.drive?.supported,
    driveState: discovered?.control?.drive?.state,
    sessionFileOnNtfs: readdirSync(sessionDir).filter((entry) => entry.endsWith('.jsonl')).length,
    currentModel: created.currentModel ? Object.keys(created.currentModel).sort() : undefined,
  };
  assertRequired('session.emptyRootDiscoversNothing', before.length === 0);
  assertRequired('session.createdIsDiscovered', !!discovered);
  assertRequired('session.titleRoundTrips', discovered?.title === created.title);
  assertRequired('session.cwdIsWorkspace', discovered?.cwd?.toLowerCase() === workspace.toLowerCase());
  assertRequired('session.driveSupported', discovered?.control?.drive?.supported === true);
  if (!discovered) throw new Error('a created Pi session was not discovered from its session root');

  // 3. Drive attach. `resume` is Pi's driving mode; `live` is refused until a terminal bridge owns
  //    the session, which is itself part of the contract.
  let liveRefused = false;
  try { await adapter.attach(created.id, 'live'); } catch { liveRefused = true; }
  const stream = recorder();
  connection = await adapter.attach(created.id, 'resume');
  const unsubscribe = connection.subscribe(stream.handle);
  observations.attach = {
    liveRefusedWithoutBridge: liveRefused,
    resumeAttachMode: connection.info.attachMode,
    resumeDriveState: connection.info.control?.drive?.state,
    historyOnAttach: (await connection.getHistory()).length,
    commands: (await connection.listCommands?.())?.length ?? 0,
    models: (await connection.listModels?.())?.length ?? 0,
  };
  assertRequired('attach.liveRefusedWithoutBridge', liveRefused);
  assertRequired(
    'attach.resumeIsDriving',
    connection.info.attachMode === 'resume' && connection.info.control?.drive?.state === 'driving',
  );

  // 4. One completing turn.
  const turnStart = mark(stream.recorded);
  // The override rides the COMPLETING turn: a turn that ran to `done` is the one whose selection
  // Pi durably records, and the durable record is the only authoritative answer available here.
  // `connection.info.currentModel` is not one — on the success path the adapter assigns it without
  // emitting anything, and falls back to echoing the very values that were requested.
  const requestedModel = secondModel ?? defaultModel;
  const promptFailure = await connection.sendPrompt({
    text: 'Reply with exactly one word: OK',
    ...(requestedModel
      ? { model: { providerID: requestedModel.providerID, modelID: requestedModel.modelID } }
      : {}),
  })
    .then(() => undefined)
    .catch((error: unknown) => String(error).split('\n')[0]!.slice(0, 160));
  const turnSettled = promptFailure
    ? false
    : await until(() => settled(stream.recorded, turnStart), 120_000);
  observations.promptTurn = {
    modelRequested: requestedModel ? String(requestedModel.modelID) : undefined,
    modelRequestedWasADifferentModel: !!secondModel,
    accepted: !promptFailure,
    rejection: promptFailure,
    settled: turnSettled,
    sawModelOutput: stream.recorded.sawModelOutput,
    runStatuses: stream.recorded.runSummaries.slice(turnStart.runs),
    eventKinds: kindsSince(stream.recorded, turnStart),
  };
  const promptStatuses = stream.recorded.runSummaries.slice(turnStart.runs);
  assertRequired('prompt.accepted', !promptFailure);
  // The exact terminal status, not merely "some terminal status": a turn that errored out is not a
  // turn that completed.
  assertRequired('prompt.endedDone', turnSettled && promptStatuses.includes('done'));
  assertRequired('prompt.streamedModelOutput', stream.recorded.sawModelOutput);
  if (!turnSettled) note('the completing model turn did not settle within its bound on this host');

  // 5. Attachment. Pi materializes an upload into `<cwd>\.cosyncing\inbox` and references it by
  //    absolute path, so the Windows-specific claim is that the inbox lands on NTFS under the
  //    workspace and the absolute path survives into the turn.
  const attachmentStart = mark(stream.recorded);
  const attachmentToolCallsBefore = stream.recorded.toolCalls.length;
  const attachmentToolResultsBefore = stream.recorded.toolResults;
  const attachmentFailure = await connection.sendFile?.({
    name: 'phase6-notes.txt',
    mimeType: 'text/plain',
    data: ATTACHMENT_PAYLOAD.toString('base64'),
  }).then(() => undefined).catch((error: unknown) => String(error).split('\n')[0]!.slice(0, 160));
  const inbox = win32.join(workspace, '.cosyncing', 'inbox');
  const inboxEntries = existsSync(inbox) ? readdirSync(inbox) : [];
  const attachmentSettled = attachmentFailure
    ? false
    : await until(() => settled(stream.recorded, attachmentStart), 120_000);
  // The delivery claim is that the model can OPEN the file at the absolute path Pi wrote into the
  // turn. Accepting the prompt proves only that the note was sent, so the tool call is the
  // evidence: it must name that exact path. The path itself is never recorded — it contains the
  // operator's profile directory — only the basename and whether a tool named it.
  const expectedAttachment = win32.join(inbox, 'phase6-notes.txt');
  const materializedBytes = (): number | undefined => {
    try { return statSync(expectedAttachment).size; } catch { return undefined; }
  };
  // A tool's arguments reach us JSON-encoded, so every separator in the path it was given is a
  // DOUBLED backslash. Comparing against the raw Windows path found nothing while the model was in
  // fact opening the file. Normalise separators on both sides rather than matching the encoding.
  const normalizePath = (value: string): string => value.toLowerCase().replace(/\\+/g, '/');
  const wantedPath = normalizePath(expectedAttachment);
  const openingCalls = stream.recorded.toolCalls
    .slice(attachmentToolCallsBefore)
    .filter((call) => normalizePath(call.args).includes(wantedPath));
  const attachmentStatuses = stream.recorded.runSummaries.slice(attachmentStart.runs);
  observations.attachment = {
    accepted: !attachmentFailure,
    rejection: attachmentFailure,
    inboxCreatedUnderWorkspace: existsSync(inbox),
    inboxPathIsAbsoluteWindows: /^[A-Za-z]:\\/.test(inbox),
    inboxEntries,
    materializedBytes: materializedBytes(),
    settled: attachmentSettled,
    runStatuses: attachmentStatuses,
    eventKinds: kindsSince(stream.recorded, attachmentStart),
    toolsNamingTheAttachment: openingCalls.map((call) => call.toolName).sort(),
    toolResultsAfterOpen: stream.recorded.toolResults - attachmentToolResultsBefore,
  };
  assertRequired('attachment.accepted', !attachmentFailure);
  assertRequired('attachment.endedDone', attachmentSettled && attachmentStatuses.includes('done'));
  assertRequired(
    'attachment.materializedUnderWorkspace',
    existsSync(inbox) && /^[A-Za-z]:\\/.test(inbox)
      && inboxEntries.length === 1 && inboxEntries[0] === 'phase6-notes.txt'
      && materializedBytes() === ATTACHMENT_BYTES,
  );
  assertRequired(
    'attachment.toolOpenedTheAbsolutePath',
    openingCalls.length > 0 && stream.recorded.toolResults > attachmentToolResultsBefore,
  );
  if (!attachmentSettled) note('the attachment turn did not settle within its bound on this host');

  // 6. Abort, with a per-turn model override applied on the way in. The override runs before
  //    delivery, so it is exercised even though the turn is stopped.
  const abortStart = mark(stream.recorded);
  const abortPrompt = connection.sendPrompt({
    text: 'Count slowly from 1 to 200, one number per line, with no other text.',
  }).catch((error: unknown) => String(error).split('\n')[0]!.slice(0, 160));
  const started = await until(
    () => stream.recorded.runSummaries.length > abortStart.runs
      || stream.recorded.statuses.slice(abortStart.statuses).includes('running'),
    60_000,
  );
  await connection.runCommand?.('stop');
  const abortSettled = await until(() => settled(stream.recorded, abortStart), 60_000);
  const abortRejection = await abortPrompt;
  const abortStatuses = stream.recorded.runSummaries.slice(abortStart.runs);
  observations.abort = {
    rejection: abortRejection,
    runStarted: started,
    stopAccepted: abortSettled,
    runStatuses: abortStatuses,
    endedIdle: stream.recorded.statuses.slice(-1)[0] === 'idle',
  };
  assertRequired('abort.runStarted', started);
  assertRequired(
    'abort.endedCancelled',
    abortSettled && abortStatuses.includes('cancelled')
      && stream.recorded.statuses.slice(-1)[0] === 'idle',
  );
  if (!abortSettled) note('the aborted turn did not return to idle within its bound on this host');

  // 7. History, then teardown of this connection.
  const history = await connection.getHistory();
  observations.history = {
    messageCount: history.length,
    roles: [...new Set(history.map((message: any) => String(message.type ?? message.role ?? 'unknown')))].sort(),
    permissionRequests: stream.recorded.permissionRequests,
    questionRequests: stream.recorded.questionRequests,
    errors: stream.recorded.errors,
  };
  const historyKinds = new Set<string>(history.map((message: any) => String(message.type ?? '')));
  assertRequired(
    'history.hasUserAndAssistantTurns',
    history.length > 0 && historyKinds.has('user-message') && historyKinds.has('model-output'),
  );
  unsubscribe();
  await connection.close();
  connection = undefined;

  // 8. Resume: a second drive attach must read the same durable transcript back.
  reattached = await adapter.attach(created.id, 'resume');
  const resumedHistory = await reattached.getHistory();
  // Equality is the wrong contract here and the first native run said so: the live read happens
  // while the aborted turn is still being written, so the durable transcript is legitimately
  // longer. What resume must guarantee is that it CONTAINS what the live connection had, in order.
  const identity = (message: any): string => `${String(message.type ?? '')}#${String(message.key ?? '')}`;
  const liveIdentities: string[] = history.map(identity);
  const resumedIdentities: string[] = resumedHistory.map(identity);
  const containsLiveAsPrefix = liveIdentities
    .every((key: string, index: number) => resumedIdentities[index] === key);
  // Authoritative: a fresh drive attach reads the selection out of the session file Pi wrote, not
  // out of anything this process assigned.
  const resumedModelId = reattached.info.currentModel?.modelID
    ? String(reattached.info.currentModel.modelID)
    : undefined;
  const appliedRequested = !!requestedModel && resumedModelId === String(requestedModel.modelID);
  observations.models = {
    requested: requestedModel ? String(requestedModel.modelID) : undefined,
    durablySelected: resumedModelId,
    appliedRequestedModel: appliedRequested,
    // Corroborating, not authoritative: the adapter republishes `sessionInfo` only when it has had
    // to reconcile a switch with Pi's own state, so an empty list is the ordinary success path.
    sessionInfoModelUpdates: stream.recorded.appliedModelIds,
  };
  assertRequired('models.appliedRequestedModel', appliedRequested);
  observations.resume = {
    reattached: true,
    liveHistoryCount: history.length,
    resumedHistoryCount: resumedHistory.length,
    containsLiveTranscriptAsPrefix: containsLiveAsPrefix,
    appendedAfterLiveRead: resumedHistory.length - history.length,
    driveState: reattached.info.control?.drive?.state,
    sessionFilesInRoot: readdirSync(sessionDir).filter((entry) => entry.endsWith('.jsonl')).length,
  };
  assertRequired('resume.containsLiveTranscriptAsPrefix', containsLiveAsPrefix && resumedHistory.length > 0);
  if (!containsLiveAsPrefix) {
    note('a resumed drive attach did not contain the live transcript as an ordered prefix');
  }
  await reattached.close();
  reattached = undefined;
} catch (error) {
  observations.aborted = { reason: String(error).split('\n')[0]!.slice(0, 200) };
  note('the trace stopped early; observations recorded up to that point');
} finally {
  try { await connection?.close(); } catch { /* already closing */ }
  try { await reattached?.close(); } catch { /* already closing */ }
  // 9. Process cleanup: no Pi child may outlive the trace.
  await Bun.sleep(1_000);
  const snapshotAfter = await captureHostSnapshot();
  const survivors = (snapshotAfter?.processes ?? []).filter((entry) =>
    !pidsBefore.has(entry.pid) && /^(?:pi|node)(?:\.exe)?$/i.test(entry.name));
  // A snapshot this probe could not take yields an empty survivor list, which reads exactly like a
  // clean teardown. So a successful snapshot is itself required, at both ends.
  const snapshotsSucceeded = snapshotBefore?.processesOk === true && snapshotAfter?.processesOk === true;
  observations.teardown = {
    snapshotsSucceeded,
    survivingAgentProcesses: snapshotsSucceeded ? survivors.length : undefined,
    survivingNames: snapshotsSucceeded ? [...new Set(survivors.map((entry) => entry.name))].sort() : undefined,
  };
  assertRequired('teardown.snapshotsSucceeded', snapshotsSucceeded);
  assertRequired('teardown.noSurvivingAgentProcess', snapshotsSucceeded && survivors.length === 0);
  if (!snapshotsSucceeded) note('a process snapshot failed, so surviving agent processes are unknown');
  if (survivors.length) note('agent processes outlived the trace and were left for the owner to inspect');
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
    slice: 'pi-drive-trace',
    source: { commit: sourceCommit, dirty: sourceDirty === 'true' },
    host: { platform: process.platform, arch: process.arch },
    runtime: { bun: Bun.version },
    observations,
    required,
    requiredUnmet: REQUIRED_ASSERTIONS.filter((name) => required[name] !== true),
    findings,
    deferred: [
      'permission and question prompts: they arrive through the bridge extension on an approval-'
      + 'gated tool call, which a model turn cannot be made to produce deterministically',
      'terminal true-sync attach and takeover',
      'fork/clone lifecycle and HTML transcript export',
    ],
    // Pass requires every named assertion to be present and true. Absence counts as failure, so a
    // trace that stopped early cannot pass on the assertions it happened to reach.
    result: REQUIRED_ASSERTIONS.every((name) => required[name] === true) && findings.length === 0
      ? 'pass'
      : 'finding',
  })}\n`);
}
