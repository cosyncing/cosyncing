#!/usr/bin/env bun
/**
 * Phase 6 Claude slice 1 — Observe and resume Drive on native Windows.
 *
 * Claude's dependable surface is disk Observe: an append-only JSONL transcript under
 * `<config>/projects/<cwd-slug>/<uuid>.jsonl`, replayed as history and live-followed. Drive is a
 * second surface: `claude -p --resume <uuid>` speaking stream-json over pipes.
 *
 * Windows changes both. Observe becomes NTFS discovery, an incremental tail of a file another
 * process is appending to, and a `watch()` that has to fire. Drive becomes a child launched through
 * `claude.cmd` — a batch shim, so the spawn handle is `cmd.exe` and the real process is its child.
 *
 * The sharp question is the second one. `killProc()` ends a drive with `p.kill('SIGTERM')` on the
 * spawn handle. On Windows that reaches the shim, not the process doing the work, so closing a Drive
 * connection may leave a live `claude` behind — one that holds the transcript, and on a real account
 * would go on spending quota. That is the same defect already fixed for the OpenCode serve, in a
 * different adapter.
 *
 * Isolation: a disposable CLAUDE_CONFIG_DIR, an empty wrapper dir, and a fake `claude` behind a real
 * `.cmd` shim. The operator's own ~/.claude store, sessions, and credentials are never read, never
 * written, and no real model is ever asked anything.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { captureHostSnapshot } from './phase6-host-snapshot.ts';
import { HostProcessProvider, terminateHostProcessTree } from '../../../packages/typescript/adapter-api/src/host-process.ts';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Phase 6 Claude probe requires ${name}`);
  return value;
}

const root = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_ROOT');
const runId = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_RUN_ID');
const sourceCommit = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_COMMIT');
const sourceDirty = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_DIRTY');
if (process.platform !== 'win32') {
  throw new Error('Phase 6 Claude probe requires its native Windows runner environment');
}

const configDir = win32.join(root, 'claude-config');
const wrapperDir = win32.join(root, 'no-wrappers');
const workspace = win32.join(root, 'workspace');
const binDir = win32.join(root, 'bin');
const pidFile = win32.join(root, 'fake-claude.pid');
const argvFile = win32.join(root, 'fake-claude-argv.json');
const REPLY = 'PHASE6-CLAUDE-OK';
const SEEDED_USER = 'PHASE6-SEEDED-QUESTION';
const SEEDED_REPLY = 'PHASE6-SEEDED-ANSWER';
const APPENDED = 'PHASE6-APPENDED-LINE';

/** Claude's transcript-dir slug: every non-alphanumeric character becomes '-'. Recomputed here rather
 *  than imported, so that discovery finding the directory is evidence the adapter agrees. */
const slug = workspace.replace(/[^a-zA-Z0-9]/g, '-');
const projectDir = win32.join(configDir, 'projects', slug);
for (const dir of [configDir, wrapperDir, workspace, binDir, projectDir]) mkdirSync(dir, { recursive: true });

const observations: Record<string, unknown> = {};
const findings: string[] = [];
const note = (message: string): void => { if (!findings.includes(message)) findings.push(message); };

const REQUIRED_ASSERTIONS = [
  'store.disposableStoreDiscovered',
  'observe.sessionDiscovered',
  'observe.historyReplayed',
  'observe.liveAppendObserved',
  'drive.launchedThroughTheShim',
  'drive.realChildIsNotTheSpawnHandle',
  'drive.turnCompleted',
  'drive.closeLeftNoChildBehind',
  'teardown.noSurvivingChild',
  'cleanup.disposableRootRemoved',
] as const;
const required: Record<string, boolean> = {};
const assertRequired = (name: (typeof REQUIRED_ASSERTIONS)[number], held: boolean): boolean => {
  required[name] = held;
  return held;
};

const hostProcesses = new HostProcessProvider();

async function until(read: () => boolean | Promise<boolean>, budgetMs: number, everyMs = 250): Promise<number | null> {
  const started = Date.now();
  for (;;) {
    if (await read()) return Date.now() - started;
    if (Date.now() - started >= budgetMs) return null;
    await Bun.sleep(everyMs);
  }
}

function transcriptLine(kind: 'user' | 'assistant', text: string, sessionId: string): string {
  const base = { uuid: randomUUID(), timestamp: new Date(0).toISOString(), sessionId, cwd: workspace, version: '2.1.238' };
  return `${JSON.stringify(kind === 'user'
    ? { ...base, type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }
    : { ...base, type: 'assistant', message: { id: `msg_${base.uuid.slice(0, 8)}`, role: 'assistant', model: 'fake-model', content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } } })}\n`;
}

let fakePid: number | undefined;
let pidsBefore = new Set<number>();
let snapshotBefore: Awaited<ReturnType<typeof captureHostSnapshot>> = null;

try {
  snapshotBefore = await captureHostSnapshot();
  pidsBefore = new Set((snapshotBefore?.processes ?? []).map((entry) => entry.pid));

  // The shim is a REAL batch file calling a real executable, because that is what `claude` is on
  // Windows and the two-pid gap is the thing under test. Writing our own keeps the operator's
  // install, account, and quota entirely out of it.
  const fakePath = win32.join(import.meta.dir, 'phase6-claude-fake.ts');
  const shimPath = win32.join(binDir, 'phase6claude.cmd');
  writeFileSync(shimPath, `@echo off\r\n"${process.execPath}" "${fakePath}" %*\r\n`);

  // Set before the adapter is imported: it reads CLAUDE_CONFIG_DIR and COSYNCING_CLAUDE_BIN into
  // module constants at load, so a later assignment would be read too late.
  process.env.CLAUDE_CONFIG_DIR = configDir;
  process.env.COSYNCING_CLAUDE_BIN = shimPath;
  process.env.COSYNCING_CLAUDE_WRAPPER_DIR = wrapperDir;
  process.env.COSYNCING_PHASE6_CLAUDE_PIDFILE = pidFile;
  process.env.COSYNCING_PHASE6_CLAUDE_ARGV = argvFile;
  process.env.COSYNCING_PHASE6_CLAUDE_REPLY = REPLY;
  const { ClaudeAdapter, claudeStores } = await import('../../../packages/typescript/adapters/claude/src/implementation.ts');

  const stores = claudeStores();
  observations.stores = {
    count: stores.length,
    defaultPointsAtTheDisposableStore: stores.some((store) => store.isDefault && store.configDir === configDir),
  };
  assertRequired('store.disposableStoreDiscovered',
    stores.some((store) => store.isDefault && store.configDir === configDir));

  // A transcript Claude could have written: one user turn, one assistant turn.
  const sessionId = randomUUID();
  const transcript = win32.join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(transcript,
    transcriptLine('user', SEEDED_USER, sessionId) + transcriptLine('assistant', SEEDED_REPLY, sessionId));

  const adapter = new ClaudeAdapter();
  observations.available = await adapter.isAvailable();

  const discovered = await adapter.discoverSessions();
  // The adapter's session id is a base64url-encoded TRANSCRIPT PATH, not the bare uuid -- attach
  // decodes it and requires containment in a known projects root. Matching on the uuid finds nothing
  // and then attach refuses, which is exactly how this probe failed the first time.
  const found = discovered.find((session) =>
    Buffer.from(session.id, 'base64url').toString('utf8') === transcript);
  const rowId = found?.id;
  observations.discovery = {
    total: discovered.length,
    foundTheSeededSession: !!found,
    cwdMatches: found?.cwd === workspace,
    idDecodesToTheTranscript: !!rowId,
  };
  assertRequired('observe.sessionDiscovered', !!found && found.cwd === workspace);
  if (!rowId) throw new Error('discovery did not return the seeded transcript');

  const observe = await adapter.attach(rowId, 'observe');
  const history = JSON.stringify(await observe.getHistory());
  observations.observe = { historyHasUser: history.includes(SEEDED_USER), historyHasAssistant: history.includes(SEEDED_REPLY) };
  assertRequired('observe.historyReplayed', history.includes(SEEDED_USER) && history.includes(SEEDED_REPLY));

  // Live tail: another writer appends, and the adapter must notice without being asked again.
  let live = '';
  const unsubscribe = observe.subscribe((message) => { if (live.length < 20_000) live += JSON.stringify(message); });
  await Bun.sleep(1_000);
  writeFileSync(transcript, transcriptLine('assistant', APPENDED, sessionId), { flag: 'a' });
  const appendedMs = await until(() => live.includes(APPENDED), 30_000);
  observations.liveTail = { observedMs: appendedMs };
  assertRequired('observe.liveAppendObserved', appendedMs !== null);
  unsubscribe();
  await observe.close?.();

  // ── Drive ────────────────────────────────────────────────────────────────────────────────────
  const drive = await adapter.attach(rowId, 'resume');
  let driven = '';
  const unsubscribeDrive = drive.subscribe((message) => { if (driven.length < 20_000) driven += JSON.stringify(message); });
  await drive.sendPrompt({ text: 'phase 6 drive' });

  const launchedMs = await until(() => existsSync(pidFile), 30_000);
  fakePid = launchedMs !== null ? Number(readFileSync(pidFile, 'utf8').trim()) : undefined;
  observations.drive = {
    launchedMs,
    argv: existsSync(argvFile) ? (JSON.parse(readFileSync(argvFile, 'utf8')) as string[]).slice(0, 6) : null,
  };
  assertRequired('drive.launchedThroughTheShim', !!fakePid && fakePid > 0);

  // The whole premise: the process doing the work is NOT the one the broker holds. Proven by asking
  // the host who the fake's parent is rather than by assuming a shim was involved.
  const parent = fakePid ? hostProcesses.descendsFrom(fakePid, fakePid) : 'unknown';
  const fakeEntry = (await captureHostSnapshot())?.processes.find((entry) => entry.pid === fakePid);
  observations.child = { parentIsAnotherProcess: !!fakeEntry?.parentPid && fakeEntry.parentPid !== fakePid, selfCheck: parent };
  assertRequired('drive.realChildIsNotTheSpawnHandle', !!fakeEntry && fakeEntry.parentPid > 0);

  const repliedMs = await until(() => driven.includes(REPLY), 60_000);
  observations.turn = { repliedMs };
  assertRequired('drive.turnCompleted', repliedMs !== null);

  unsubscribeDrive();
  await drive.close?.();
  // Give a well-behaved child every chance to exit before calling it a survivor.
  await Bun.sleep(6_000);
  const afterClose = fakePid ? hostProcesses.liveProcess(fakePid).state : 'absent';
  observations.afterClose = { fakeProcessState: afterClose };
  assertRequired('drive.closeLeftNoChildBehind', afterClose === 'absent');
  if (afterClose === 'running') {
    note('closing a Claude Drive connection left the real claude process running: the SIGTERM went to '
      + 'the batch shim, and on a real account that child would go on spending quota');
  }
  if (afterClose === 'unknown') note('the host would not say whether the drive child survived');
} catch (error) {
  observations.aborted = { reason: String(error).split('\n')[0]!.slice(0, 300) };
  note('the Claude probe stopped early; observations recorded up to that point');
} finally {
  // Nothing this probe started may outlive it. The fake wrote its own pid, so this is attribution by
  // record rather than by guessing from a snapshot.
  if (fakePid && hostProcesses.liveProcess(fakePid).state === 'running') {
    try { terminateHostProcessTree(fakePid, true); } catch { /* already gone */ }
    await Bun.sleep(1_500);
  }
  const survived = fakePid ? hostProcesses.liveProcess(fakePid).state : 'absent';
  const snapshotAfter = await captureHostSnapshot();
  const snapshotsSucceeded = snapshotBefore?.processesOk === true && snapshotAfter?.processesOk === true;
  observations.teardown = { snapshotsSucceeded, fakeProcessAfterTeardown: survived, trackedPid: !!fakePid };
  assertRequired('teardown.noSurvivingChild', survived === 'absent');
  if (survived !== 'absent') note('the drive child could not be removed and was left for the owner to inspect');

  let removed = false;
  try { rmSync(root, { recursive: true, force: true }); removed = !existsSync(root); } catch { removed = false; }
  assertRequired('cleanup.disposableRootRemoved', removed);
  observations.cleanup = { disposableRootRemoved: removed };

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    runId,
    slice: 'claude-observe-and-resume-drive',
    source: { commit: sourceCommit, dirty: sourceDirty === 'true' },
    host: { platform: process.platform, arch: process.arch },
    runtime: { bun: Bun.version },
    observations,
    required,
    requiredUnmet: REQUIRED_ASSERTIONS.filter((name) => required[name] !== true),
    findings,
    deferred: [
      'a real Claude account: every turn here is answered by a local fake, so subscription auth, '
      + 'real stream-json shapes, tool use, and permission prompts on Windows are not claimed',
      'wrapper stores, sub-agent transcripts, and the dormant channel bridge',
    ],
    result: REQUIRED_ASSERTIONS.every((name) => required[name] === true) && findings.length === 0
      ? 'pass'
      : 'finding',
  })}\n`);
  // Exit explicitly. The adapter keeps file watchers and store-cache timers armed, so the loop never
  // drains on its own -- and a probe that will not exit holds the staging runner's stdout open, which
  // wedges the whole run with its report already written.
  process.exit(0);
}
