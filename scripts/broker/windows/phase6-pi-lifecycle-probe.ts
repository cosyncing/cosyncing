#!/usr/bin/env bun
/**
 * Phase 6 slice 3 — Pi session lifecycle on native Windows.
 *
 * Slice 1 proved the launcher; slice 2 drove a session. This covers the advertised surface neither
 * of them touched, and all of it is deterministic: `attach(..., 'observe')`, `forkSession` with and
 * without a message, `cloneSession`, and `exportTranscript`. None needs a model to answer, so none
 * of it is measured — every claim here is required.
 *
 * Why that matters: the Windows support claim is per-capability. A capability advertised with no
 * native evidence behind it is exactly the gap the support matrix exists to keep closed, and
 * fork, clone, and HTML export were all advertised and all unproven on this platform.
 *
 * Agent-directory posture is slice 2's, enforced by the shared guard: the operator's real
 * directory is read (providers and credentials live there), the two writes that would reach it are
 * switched off, and whatever Pi still changes is put back.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { win32 } from 'node:path';
import { captureHostSnapshot } from './phase6-host-snapshot.ts';
import { AgentDirectoryGuard } from './phase6-agent-dir-guard.ts';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Phase 6 Pi lifecycle probe requires ${name}`);
  return value;
}

const root = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_ROOT');
const runId = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_RUN_ID');
const sourceCommit = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_COMMIT');
const sourceDirty = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_DIRTY');
if (process.platform !== 'win32') {
  throw new Error('Phase 6 Pi lifecycle probe requires its native Windows runner environment');
}

const sessionDir = win32.join(root, 'sessions');
const workspace = win32.join(root, 'workspace');
const exportDir = win32.join(root, 'export');
mkdirSync(sessionDir, { recursive: true });
mkdirSync(workspace, { recursive: true });
mkdirSync(exportDir, { recursive: true });

// Same posture as the drive trace: the operator's own agent directory, with the two writes that
// would reach it switched off. See `phase6-agent-dir-guard.ts` for what that costs and buys.
const agentDir = process.env.PI_CODING_AGENT_DIR?.trim()
  || win32.join(requiredEnvironment('USERPROFILE'), '.pi', 'agent');
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
process.env.COSYNCING_PI_BRIDGE_AUTOINSTALL = '0';
process.env.COSYNCING_NO_BRIDGE = '1';
delete process.env.COSYNCING_PI_SESSIONS_ROOT;

const guard = AgentDirectoryGuard.acquire({
  agentDir,
  runId,
  fallbackLockDir: root,
  declarationVariable: 'COSYNCING_WINDOWS_PHASE6_EXCLUSIVE_AGENT',
});

const pi = await import('../../../packages/typescript/adapters/pi/src/implementation.ts');

const observations: Record<string, unknown> = {};
const findings: string[] = [];
const note = (message: string): void => { if (!findings.includes(message)) findings.push(message); };

/**
 * Every claim this slice exists to make. Present AND true, or the run is a finding: a probe that
 * stops early must not pass on the assertions it happened to reach.
 */
const REQUIRED_ASSERTIONS = [
  'adapter.available',
  'session.createdIsDiscovered',
  'session.hasTranscriptToCopy',
  'observe.attachIsObserving',
  'observe.historyIsNonEmpty',
  'observe.promptRefused',
  'observe.fileRefused',
  'observe.commandRefused',
  'fork.createsDistinctSession',
  'fork.isDiscovered',
  'fork.copiesTranscript',
  'fork.leavesSourceUnchanged',
  'forkAtMessage.createsDistinctSession',
  'forkAtMessage.keepsEveryTurnBeforeTheForkPoint',
  'clone.createsDistinctSession',
  'clone.isDiscovered',
  'clone.copiesTranscript',
  'clone.leavesSourceUnchanged',
  'export.reportsHtml',
  'export.wroteInsideTheContainedDirectory',
  'export.isANonEmptyHtmlDocument',
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

/** Identity only — transcript TEXT never leaves this process. Matches the drive trace's shape. */
const identities = (history: readonly any[]): string[] =>
  history.map((message) => `${String(message?.type ?? '')}#${String(message?.key ?? '')}`);
const isPrefix = (prefix: readonly string[], whole: readonly string[]): boolean =>
  prefix.length <= whole.length && prefix.every((value, index) => value === whole[index]);

/**
 * A copy-stable shape for comparing one transcript against another.
 *
 * Keys cannot do this job: a fork or a clone is a NEW session file, and Pi is free to mint fresh
 * entry ids in it — a key comparison would then report a faithful copy as a mismatch. Kind and
 * length travel with the content instead. Length is not content and never leaves this process
 * either; only the boolean does.
 */
/** The USER turns alone — the thing a fork point is defined over. */
const userTurns = (history: readonly any[]): string[] =>
  shapes(history.filter((message) => message?.type === 'user-message'));

const shapes = (history: readonly any[]): string[] =>
  history.map((message) => {
    const text = typeof message?.text === 'string' ? message.text
      : typeof message?.delta === 'string' ? message.delta : '';
    return `${String(message?.type ?? '')}|${text.length}`;
  });
const TERMINAL_RUN_STATUSES = new Set(['done', 'error', 'cancelled', 'interrupted']);

const adapter = new pi.PiAdapter({ brokerUrl: 'http://127.0.0.1:1' });
let drive: any;
let observer: any;
const snapshotBefore = await captureHostSnapshot();
const pidsBefore = new Set((snapshotBefore?.processes ?? []).map((entry) => entry.pid));

try {
  observations.operatorInstallation = {
    agentDirectory: 'operator-default',
    sessionRootRedirected: true,
    bridgeAutoInstallSuppressed: true,
    entriesBefore: guard.entryCount,
  };
  observations.exclusiveUse = guard.exclusiveUse;
  assertRequired('adapter.available', (await adapter.isAvailable()) && adapter.canCreateSession());
  if (!adapter.canCreateSession()) {
    throw new Error('Pi runtime readiness refused session creation on this host');
  }

  // 1. One session with something in it. The turn is sent for its USER message, which Pi records
  //    whether or not a provider answers — fork, clone, and export all need a transcript, and none
  //    of them needs a model to have produced one.
  const created = await adapter.createSession({
    directory: workspace,
    title: `Phase 6 lifecycle ${runId}`,
  });
  drive = await adapter.attach(created.id, 'resume');
  const runStatuses: string[] = [];
  const unsubscribe = drive.subscribe((message: any) => {
    if (message?.type === 'run-summary' && typeof message.status === 'string') {
      runStatuses.push(message.status);
    }
  });
  /**
   * TWO turns, deliberately.
   *
   * Pi's fork takes a user entry and copies everything BEFORE it, so a single-turn session can
   * only ever fork to an empty one — which proves nothing about copying. With two turns, forking
   * before the second yields a transcript that is non-empty AND strictly shorter than its source,
   * which is what a fork point means.
   */
  const settle = async (): Promise<void> => {
    const already = runStatuses.length;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline
      && !runStatuses.slice(already).some((status) => TERMINAL_RUN_STATUSES.has(status))) {
      await Bun.sleep(250);
    }
  };
  await drive.sendPrompt({ text: 'Reply with the single word: ready.' }).catch(() => undefined);
  await settle();
  await drive.sendPrompt({ text: 'Reply with the single word: again.' }).catch(() => undefined);
  await settle();
  const driveHistory = await drive.getHistory();
  observations.source = {
    // Counts and roles, never text.
    messages: driveHistory.length,
    kinds: [...new Set(driveHistory.map((message: any) => String(message?.type ?? '?')))].sort(),
    turnSettled: runStatuses.some((status) => TERMINAL_RUN_STATUSES.has(status)),
    // Measured, not asserted: an unreachable provider is a fact about this host today. What IS
    // asserted is that a transcript exists to copy, because forking an empty session proves little.
    runStatuses: [...runStatuses],
  };
  assertRequired('session.createdIsDiscovered',
    (await adapter.discoverSessions()).some((session: any) => session.id === created.id));
  assertRequired('session.hasTranscriptToCopy', driveHistory.length > 0);
  if (driveHistory.length === 0) {
    note('the source session recorded no transcript, so every copy claim below is about an empty one');
  }
  unsubscribe?.();
  await drive.close();
  drive = undefined;

  // 2. Observe attach: the read-only half of the advertised attach modes. Every write door must be
  //    shut, not just the prompt — an observer that can still upload a file or run a command is
  //    not read-only, and the client has no other gate in front of it.
  observer = await adapter.attach(created.id, 'observe');
  const observeHistory = await observer.getHistory();
  const refused = async (call: () => Promise<unknown>): Promise<boolean> => {
    try { await call(); return false; } catch { return true; }
  };
  const promptRefused = await refused(() => observer.sendPrompt({ text: 'this must not be sent' }));
  const fileRefused = await refused(() => observer.sendFile({
    name: 'phase6.txt',
    mimeType: 'text/plain',
    data: Buffer.from('phase 6 lifecycle probe\n', 'utf8').toString('base64'),
  }));
  const commandRefused = await refused(() => observer.runCommand('stop'));
  observations.observe = {
    attachMode: observer.info.attachMode,
    driveState: observer.info.control?.drive?.state,
    messages: observeHistory.length,
    driveMessages: driveHistory.length,
    // Recorded, NOT required. A drive connection's history is the live view — it carries
    // `metadata-update` and `token-count` rows the file mapper has no source for — so the two
    // counts differing is the two views being different views, not a defect. The first run of this
    // probe asserted them equal and failed on 8 against 6.
    sameLengthAsDriveHistory: observeHistory.length === driveHistory.length,
    promptRefused,
    fileRefused,
    commandRefused,
  };
  assertRequired('observe.attachIsObserving',
    observer.info.attachMode === 'observe' && observer.info.control?.drive?.state === 'observing');
  assertRequired('observe.historyIsNonEmpty', observeHistory.length > 0);
  assertRequired('observe.promptRefused', promptRefused);
  assertRequired('observe.fileRefused', fileRefused);
  assertRequired('observe.commandRefused', commandRefused);
  if (!promptRefused || !fileRefused || !commandRefused) {
    note('an observe-mode Pi connection accepted a write');
  }
  await observer.close();
  observer = undefined;

  /**
   * The copy baseline is the FILE view, not the drive view.
   *
   * A fork and a clone are read back through an observe attach, so comparing them against a live
   * drive connection's history would compare two different views and call a faithful copy a
   * mismatch. Both sides of every comparison below come from the same mapper.
   */
  const sourceIdentities = identities(observeHistory);
  const sourceShapes = shapes(observeHistory);
  const sourceUserTurns = userTurns(observeHistory);

  // 3. Fork — whole session, then at a chosen message.
  const forked = await adapter.forkSession(created.id);
  const forkConnection = await adapter.attach(forked.id, 'observe');
  const forkHistory = await forkConnection.getHistory();
  await forkConnection.close();
  const afterFork = await adapter.discoverSessions();
  const sourceAfterFork = await adapter.attach(created.id, 'observe');
  const sourceAfterForkHistory = await sourceAfterFork.getHistory();
  await sourceAfterFork.close();
  observations.fork = {
    distinctSession: forked.id !== created.id,
    discovered: afterFork.some((session: any) => session.id === forked.id),
    messages: forkHistory.length,
    // The fork is a copy, so the source's messages must all be in it, in order.
    copiesTranscript: isPrefix(sourceShapes, shapes(forkHistory)),
    sourceMessagesAfter: sourceAfterForkHistory.length,
    titleFromNative: typeof forked.title === 'string' && forked.title.length > 0,
    cwdIsWorkspace: forked.cwd?.toLowerCase() === workspace.toLowerCase(),
  };
  assertRequired('fork.createsDistinctSession', forked.id !== created.id);
  assertRequired('fork.isDiscovered', afterFork.some((session: any) => session.id === forked.id));
  assertRequired('fork.copiesTranscript', isPrefix(sourceShapes, shapes(forkHistory)));
  assertRequired('fork.leavesSourceUnchanged',
    isPrefix(sourceIdentities, identities(sourceAfterForkHistory))
      && sourceAfterForkHistory.length === observeHistory.length);

  /**
   * Pi's fork point is Pi's OWN entry id, which is the id on a transcript line — the same value
   * the history mapper uses as its key base. It is read from the session file rather than guessed
   * at from a mapped key, because a mapped key can carry a per-content suffix and Pi would refuse
   * it. Whether the id a CLIENT would send is that same value is recorded separately below; it is
   * a contract question about every platform, not a Windows one, so it is measured, not asserted.
   */
  const sessionFile = readdirSync(sessionDir)
    .filter((entry) => entry.endsWith('.jsonl'))
    .map((entry) => win32.join(sessionDir, entry))
    .find((full) => readFileSync(full, 'utf8').includes('"message"'));
  const nativeEntries = sessionFile
    ? readFileSync(sessionFile, 'utf8').split('\n')
      .map((line) => { try { return JSON.parse(line); } catch { return undefined; } })
      .filter((entry) => entry?.type === 'message' && entry?.id != null)
    : [];
  const nativeEntryIds = nativeEntries.map((entry) => String(entry.id));
  const userEntryIds = nativeEntries
    .filter((entry) => entry?.message?.role === 'user')
    .map((entry) => String(entry.id));
  // The LAST user turn: forking before it keeps everything earlier, so the copy is neither empty
  // nor the whole thing. Anchoring on the first would fork to an empty session and assert nothing.
  const anchor = userEntryIds[userEntryIds.length - 1];
  const forkedAt = anchor
    ? await adapter.forkSession(created.id, { messageId: anchor })
    : undefined;
  let forkedAtHistory: any[] = [];
  if (forkedAt) {
    const connection = await adapter.attach(forkedAt.id, 'observe');
    forkedAtHistory = await connection.getHistory();
    await connection.close();
  }
  observations.forkAtMessage = {
    anchored: !!anchor,
    nativeEntryIds: nativeEntryIds.length,
    userEntries: userEntryIds.length,
    // Does the id a client would send for the first transcript row equal a native entry id? If it
    // does not, fork-from-here is unreachable from the app on EVERY platform, which is worth
    // knowing and is not this slice's to decide.
    clientVisibleKeyIsNativeEntryId: nativeEntryIds.includes(
      String(observeHistory[0]?.key ?? '').split(':')[0]!,
    ),
    distinctSession: !!forkedAt && forkedAt.id !== created.id && forkedAt.id !== forked.id,
    messages: forkedAtHistory.length,
    sourceMessages: observeHistory.length,
    userTurns: userTurns(forkedAtHistory).length,
    sourceUserTurns: sourceUserTurns.length,
    // Kinds only, no lengths and no text: enough to see WHERE two transcripts diverge without
    // guessing, which is what the first failure of this assertion cost.
    kindSequence: forkedAtHistory.map((message: any) => String(message?.type ?? '?')),
    sourceKindSequence: observeHistory.map((message: any) => String(message?.type ?? '?')),
  };
  assertRequired('forkAtMessage.createsDistinctSession',
    !!forkedAt && forkedAt.id !== created.id && forkedAt.id !== forked.id);
  // Pi decides where a message-anchored fork cuts; this asserts only what the operation MEANS —
  // a fork at a message cannot be longer than what it forked from.
  /**
   * A fork point means: every user turn BEFORE the chosen one, and none from it onwards.
   *
   * Stated over user turns rather than the whole transcript on purpose. A run summary is derived
   * per turn and closed by the NEXT user entry, so the last turn of a fork and the same turn
   * mid-source are summarized from different evidence — comparing whole transcripts called a
   * correct fork wrong, with 6 rows against the source's 11.
   */
  const forkedUserTurns = userTurns(forkedAtHistory);
  assertRequired('forkAtMessage.keepsEveryTurnBeforeTheForkPoint',
    !!forkedAt && forkedAtHistory.length > 0
      && isPrefix(forkedUserTurns, sourceUserTurns)
      && forkedUserTurns.length === sourceUserTurns.length - 1);
  if (!anchor) note('the session file carried no user entry, so no anchored fork was traced');

  // 4. Clone.
  const cloned = await adapter.cloneSession(created.id);
  const cloneConnection = await adapter.attach(cloned.id, 'observe');
  const cloneHistory = await cloneConnection.getHistory();
  await cloneConnection.close();
  const afterClone = await adapter.discoverSessions();
  const sourceAfterClone = await adapter.attach(created.id, 'observe');
  const sourceAfterCloneHistory = await sourceAfterClone.getHistory();
  await sourceAfterClone.close();
  observations.clone = {
    distinctSession: cloned.id !== created.id && cloned.id !== forked.id,
    discovered: afterClone.some((session: any) => session.id === cloned.id),
    messages: cloneHistory.length,
    copiesTranscript: isPrefix(sourceShapes, shapes(cloneHistory)),
    sourceMessagesAfter: sourceAfterCloneHistory.length,
    sessionFilesInRoot: readdirSync(sessionDir).filter((entry) => entry.endsWith('.jsonl')).length,
  };
  assertRequired('clone.createsDistinctSession', cloned.id !== created.id && cloned.id !== forked.id);
  assertRequired('clone.isDiscovered', afterClone.some((session: any) => session.id === cloned.id));
  assertRequired('clone.copiesTranscript', isPrefix(sourceShapes, shapes(cloneHistory)));
  assertRequired('clone.leavesSourceUnchanged',
    isPrefix(sourceIdentities, identities(sourceAfterCloneHistory))
      && sourceAfterCloneHistory.length === observeHistory.length);

  // 5. HTML transcript export. The adapter chooses the path inside the directory it is handed and
  //    realpath-verifies that Pi wrote exactly that file; this checks the outcome independently
  //    rather than trusting the return value — containment is the security property here.
  const exported = await adapter.exportTranscript(created.id, {
    tempDir: exportDir,
    maxBytes: 8 * 1024 * 1024,
    timeoutMs: 60_000,
  });
  const exportReal = existsSync(exported.path) ? realpathSync(exported.path) : '';
  const containerReal = realpathSync(exportDir);
  const contained = exportReal.toLowerCase().startsWith(`${containerReal.toLowerCase()}${win32.sep}`);
  const exportBytes = contained ? statSync(exported.path).size : 0;
  // Read only the opening bytes: enough to tell a document from an empty file, and far too few to
  // carry transcript content anywhere.
  const opening = contained ? readFileSync(exported.path).subarray(0, 512).toString('utf8') : '';
  const looksLikeHtml = /^\s*<(?:!doctype html|html\b)/i.test(opening) || /<html[\s>]/i.test(opening);
  observations.export = {
    format: exported.format,
    contained,
    bytes: exportBytes,
    looksLikeHtml,
    filesInExportDirectory: readdirSync(exportDir).length,
  };
  assertRequired('export.reportsHtml', exported.format === 'html');
  assertRequired('export.wroteInsideTheContainedDirectory', contained);
  assertRequired('export.isANonEmptyHtmlDocument', exportBytes > 0 && looksLikeHtml);
  if (!looksLikeHtml) note('the exported transcript did not open as an HTML document');
} catch (error) {
  observations.aborted = { reason: String(error).split('\n')[0]!.slice(0, 200) };
  note('the lifecycle probe stopped early; observations recorded up to that point');
} finally {
  try { await drive?.close(); } catch { /* already closing */ }
  try { await observer?.close(); } catch { /* already closing */ }
  // Fork, clone, and export each spawn their own `pi --mode rpc`; none may outlive the probe.
  await Bun.sleep(1_000);
  const snapshotAfter = await captureHostSnapshot();
  const survivors = (snapshotAfter?.processes ?? []).filter((entry) =>
    !pidsBefore.has(entry.pid) && /^(?:pi|node)(?:\.exe)?$/i.test(entry.name));
  // A snapshot the probe could not take yields an empty survivor list, which reads exactly like a
  // clean teardown, so a successful snapshot is itself required at both ends.
  const snapshotsSucceeded = snapshotBefore?.processesOk === true && snapshotAfter?.processesOk === true;
  observations.teardown = {
    snapshotsSucceeded,
    survivingAgentProcesses: snapshotsSucceeded ? survivors.length : undefined,
    survivingNames: snapshotsSucceeded ? [...new Set(survivors.map((entry) => entry.name))].sort() : undefined,
  };
  assertRequired('teardown.snapshotsSucceeded', snapshotsSucceeded);
  assertRequired('teardown.noSurvivingAgentProcess', snapshotsSucceeded && survivors.length === 0);
  if (!snapshotsSucceeded) note('a process snapshot failed, so surviving agent processes are unknown');
  if (survivors.length) note('agent processes outlived the probe and were left for the owner to inspect');

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
    slice: 'pi-session-lifecycle',
    source: { commit: sourceCommit, dirty: sourceDirty === 'true' },
    host: { platform: process.platform, arch: process.arch },
    runtime: { bun: Bun.version },
    observations,
    required,
    requiredUnmet: REQUIRED_ASSERTIONS.filter((name) => required[name] !== true),
    findings,
    deferred: [
      'permission and question prompts and terminal true-sync attach: both arrive through the '
      + 'bridge extension loaded inside a terminal Pi, which needs a broker to hello to',
    ],
    result: REQUIRED_ASSERTIONS.every((name) => required[name] === true) && findings.length === 0
      ? 'pass'
      : 'finding',
  })}\n`);
}
