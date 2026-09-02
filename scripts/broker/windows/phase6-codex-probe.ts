#!/usr/bin/env bun
/**
 * Phase 6 Codex slice 1 — install shape, app-server stdio, and Observe on native Windows.
 *
 * Codex is the agent whose Windows story was already known to be about PACKAGING. Phase 0 recorded
 * that the winget MSIX install resolves on PATH but swallows a redirected child's stdio, so the
 * broker-owned `codex app-server --stdio` child cannot be created against it; the standalone
 * install.ps1 package fixes that, and the operator installed it. This slice checks the things that
 * follow from that, against the real install:
 *
 *   - `codex` must resolve to a REAL native executable, not the MSIX app alias. That is the whole
 *     difference between a working app-server and a silent one, and PATH order is what decides it.
 *   - the product's own `codex.standalone-install` check must recognize the real Windows layout —
 *     `current\bin\codex.exe` behind a junction — rather than telling the operator to reinstall what
 *     they already have.
 *   - the app-server child must actually speak JSONL over stdio and must be stoppable.
 *   - Observe must find and replay a rollout from a disposable CODEX_HOME.
 *   - true sync must be OFF: there is no `app-server-control` socket on Windows, and Windows is not
 *     where the macOS shared-daemon flow works. Under-claiming is the requirement.
 *
 * No model is ever asked anything: the app-server is started and handshaken, never given a turn.
 *
 * The operator runs Codex Desktop, which owns its own app-server. That process is a FOREIGN WRITER.
 * This probe only ever terminates pids it started itself, by pid, and never scans for codex
 * processes to clean up.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { captureHostSnapshot } from './phase6-host-snapshot.ts';
import { HostProcessProvider, terminateHostProcessTree } from '../../../packages/typescript/adapter-api/src/host-process.ts';
import { resolveInvocation, bunSpawnResolvedInvocation } from '../../../packages/typescript/adapter-api/src/invocation.ts';
import { createSetupDiagnosisContext } from '../../../packages/typescript/broker/src/installation/diagnosis-context.ts';
import { diagnoseCodexSetup } from '../../../packages/typescript/adapters/codex/src/diagnostics.ts';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Phase 6 Codex probe requires ${name}`);
  return value;
}

const root = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_ROOT');
const runId = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_RUN_ID');
const sourceCommit = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_COMMIT');
const sourceDirty = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_DIRTY');
if (process.platform !== 'win32') {
  throw new Error('Phase 6 Codex probe requires its native Windows runner environment');
}

const codexHome = win32.join(root, 'codex-home');
const workspace = win32.join(root, 'workspace');
const SEEDED_USER = 'PHASE6-CODEX-QUESTION';
const SEEDED_REPLY = 'PHASE6-CODEX-ANSWER';
for (const dir of [codexHome, workspace]) mkdirSync(dir, { recursive: true });

const observations: Record<string, unknown> = {};
const findings: string[] = [];
const note = (message: string): void => { if (!findings.includes(message)) findings.push(message); };

const REQUIRED_ASSERTIONS = [
  'install.codexResolves',
  'install.resolvesToANativeExecutable',
  'install.notTheMsixAppAlias',
  'install.standaloneCheckRecognizesTheRealInstall',
  'appServer.startedAndHandshook',
  'appServer.stoppedCleanly',
  'observe.rolloutDiscovered',
  'observe.historyReplayed',
  'trueSync.unavailableOnWindows',
  'teardown.noSurvivingChild',
  'cleanup.disposableRootRemoved',
] as const;
const required: Record<string, boolean> = {};
const assertRequired = (name: (typeof REQUIRED_ASSERTIONS)[number], held: boolean): boolean => {
  required[name] = held;
  return held;
};

const hostProcesses = new HostProcessProvider();
let appServerPid: number | undefined;
let snapshotBefore: Awaited<ReturnType<typeof captureHostSnapshot>> = null;

try {
  snapshotBefore = await captureHostSnapshot();

  // ── Install shape ────────────────────────────────────────────────────────────────────────────
  const invocation = resolveInvocation('codex', { env: process.env, platform: 'win32' });
  assertRequired('install.codexResolves', invocation !== null);
  if (!invocation) throw new Error('codex did not resolve through the shared invocation boundary');
  const executable = invocation.kind === 'native' ? invocation.executable : invocation.script;
  observations.invocation = { kind: invocation.kind, leaf: win32.basename(executable) };
  // A batch shim would mean the two-pid problem; the MSIX alias would mean a child whose stdio never
  // comes back. Both are install-shape failures, and both are invisible until something is spawned.
  assertRequired('install.resolvesToANativeExecutable', invocation.kind === 'native');
  const msixAlias = /\\WinGet\\Links\\/i.test(executable) || /\\WindowsApps\\/i.test(executable);
  observations.pathShape = { underWinGetLinks: msixAlias };
  assertRequired('install.notTheMsixAppAlias', !msixAlias);
  if (msixAlias) {
    note('PATH resolves codex to the winget MSIX app alias, whose child stdio never reaches the '
      + 'broker; the standalone package must come first on PATH');
  }

  // The product's own check, against the operator's REAL install and its junctioned layout.
  const context = createSetupDiagnosisContext();
  const codexChecks = await diagnoseCodexSetup(context);
  const standalone = codexChecks.checks.find((entry) => entry.id === 'codex.standalone-install');
  observations.standaloneCheck = { status: standalone?.status, detailCode: standalone?.detailCode };
  assertRequired('install.standaloneCheckRecognizesTheRealInstall', standalone?.status === 'pass');
  if (standalone?.status !== 'pass') {
    note(`the standalone-install check did not recognize the real Windows install: ${standalone?.detailCode}`);
  }

  // ── The app-server child ─────────────────────────────────────────────────────────────────────
  // Started against the DISPOSABLE codex home, handshaken, and stopped. Never given a turn, so no
  // model is asked anything and no quota is spent.
  const child = bunSpawnResolvedInvocation(invocation, ['app-server', '--stdio'], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
    cwd: workspace,
    env: { ...process.env, CODEX_HOME: codexHome },
  });
  appServerPid = child.pid;
  child.stdin.write(`${JSON.stringify({
    id: 1, method: 'initialize',
    params: { clientInfo: { name: 'cosyncing-phase6', version: '0' } },
  })}\n`);
  child.stdin.flush?.();

  let answer = '';
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !answer.includes('"id":1')) {
    const next = await Promise.race([reader.read(), Bun.sleep(2_000).then(() => null)]);
    if (!next) continue;
    if (next.done) break;
    answer += decoder.decode(next.value, { stream: true });
  }
  try { reader.releaseLock(); } catch { /* already released */ }
  let handshook = false;
  let platformFamily: string | undefined;
  for (const line of answer.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.id === 1 && parsed?.result) {
        handshook = true;
        platformFamily = typeof parsed.result.platformFamily === 'string' ? parsed.result.platformFamily : undefined;
      }
    } catch { /* a partial or unmodelled line */ }
  }
  observations.appServer = { pid: !!appServerPid, handshook, platformFamily, bytes: answer.length };
  assertRequired('appServer.startedAndHandshook', handshook && platformFamily === 'windows');

  if (appServerPid) terminateHostProcessTree(appServerPid, true);
  await Bun.sleep(2_000);
  const stopped = appServerPid ? hostProcesses.liveProcess(appServerPid).state : 'absent';
  observations.appServerStop = { state: stopped };
  assertRequired('appServer.stoppedCleanly', stopped === 'absent');

  // ── Observe ──────────────────────────────────────────────────────────────────────────────────
  // A rollout shaped the way Codex writes them: line 1 session_meta, then turns.
  const threadId = randomUUID();
  const rolloutDir = win32.join(codexHome, 'sessions', '2026', '08', '26');
  mkdirSync(rolloutDir, { recursive: true });
  const rollout = win32.join(rolloutDir, `rollout-2026-08-26T00-00-00-${threadId}.jsonl`);
  // Turn-framed, the way Codex actually writes one. A user prompt carries no native id: its identity
  // is (turnId, ordinal), and the rollout opens the turn with task_started BEFORE the prompt line.
  // A prompt with no enclosing turn has no identity to be mapped under and is simply not replayed --
  // which is what the first run of this probe measured, and it was the fixture's fault, not Codex's.
  const turnId = randomUUID();
  writeFileSync(rollout, [
    JSON.stringify({ type: 'session_meta', payload: { id: threadId, cwd: workspace, timestamp: '2026-08-26T00:00:00.000Z', source: 'cli' } }),
    JSON.stringify({ type: 'turn_context', payload: { turn_id: turnId, cwd: workspace, model: 'fake-model' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: SEEDED_USER } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: SEEDED_USER }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: SEEDED_REPLY }] } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } }),
  ].join('\n') + '\n');

  process.env.CODEX_HOME = codexHome;
  const { CodexAdapter } = await import('../../../packages/typescript/adapters/codex/src/implementation.ts');
  const adapter = new CodexAdapter();
  const discovered = await adapter.discoverSessions();
  const found = discovered.find((session) => session.id === threadId || session.cwd === workspace);
  observations.discovery = { total: discovered.length, foundTheSeededRollout: !!found };
  assertRequired('observe.rolloutDiscovered', !!found);

  let history = '';
  if (found) {
    const observe = await adapter.attach(found.id, 'observe');
    history = JSON.stringify(await observe.getHistory());
    await observe.close?.();
  }
  observations.observe = { hasUser: history.includes(SEEDED_USER), hasAssistant: history.includes(SEEDED_REPLY) };
  assertRequired('observe.historyReplayed', history.includes(SEEDED_USER) && history.includes(SEEDED_REPLY));

  // ── True sync ────────────────────────────────────────────────────────────────────────────────
  // Windows has no app-server control socket, and the shared-daemon flow terminals join on macOS is
  // not available here. The requirement is that cosyncing says so rather than inferring a sync.
  const controlDir = win32.join(codexHome, 'app-server-control');
  const realControlDir = win32.join(homedir(), '.codex', 'app-server-control', 'app-server-control.sock');
  // The invariant is `active => syncAvailable => supported`. What must not happen on Windows is an
  // OFFER: `syncAvailable` is what puts the affordance in front of the operator, and `active` is what
  // claims the session is already synced. Neither can be true without a control plane.
  const sync = found?.control?.terminalSync;
  const syncOffered = sync?.active === true || sync?.syncAvailable === true;
  observations.trueSync = {
    disposableControlSocketPresent: existsSync(win32.join(controlDir, 'app-server-control.sock')),
    hostControlSocketPresent: existsSync(realControlDir),
    supported: sync?.supported,
    syncAvailable: sync?.syncAvailable,
    active: sync?.active,
  };
  assertRequired('trueSync.unavailableOnWindows', !!found && !syncOffered);
  if (syncOffered) {
    note('a Codex session offered or claimed terminal sync on Windows, where there is no app-server '
      + 'control socket and no shared daemon for a terminal to join');
  }
} catch (error) {
  observations.aborted = { reason: String(error).split('\n')[0]!.slice(0, 300) };
  note('the Codex probe stopped early; observations recorded up to that point');
} finally {
  // Only the pid this probe started. The operator's Codex Desktop runs its own app-server and is a
  // foreign writer: this probe never scans for codex processes to tidy up.
  if (appServerPid && hostProcesses.liveProcess(appServerPid).state === 'running') {
    try { terminateHostProcessTree(appServerPid, true); } catch { /* already gone */ }
    await Bun.sleep(1_500);
  }
  const survived = appServerPid ? hostProcesses.liveProcess(appServerPid).state : 'absent';
  const snapshotAfter = await captureHostSnapshot();
  observations.teardown = {
    snapshotsSucceeded: snapshotBefore?.processesOk === true && snapshotAfter?.processesOk === true,
    appServerAfterTeardown: survived,
    startedOne: !!appServerPid,
  };
  assertRequired('teardown.noSurvivingChild', survived === 'absent');
  if (survived !== 'absent') note('the app-server child could not be removed and was left for the owner to inspect');

  let removed = false;
  try { rmSync(root, { recursive: true, force: true }); removed = !existsSync(root); } catch { removed = false; }
  assertRequired('cleanup.disposableRootRemoved', removed);
  observations.cleanup = { disposableRootRemoved: removed };

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    runId,
    slice: 'codex-install-shape-app-server-and-observe',
    source: { commit: sourceCommit, dirty: sourceDirty === 'true' },
    host: { platform: process.platform, arch: process.arch },
    runtime: { bun: Bun.version },
    observations,
    required,
    requiredUnmet: REQUIRED_ASSERTIONS.filter((name) => required[name] !== true),
    findings,
    deferred: [
      'a driven Codex turn: the app-server is handshaken and stopped, never given a turn, so nothing '
      + 'here claims model interaction, tool use, or approvals on Windows',
      'attaching a closed Codex Desktop session, which the Phase 0 notes leave open for the codex owner',
      'terminal sync, which has no Windows control-plane equivalent today',
    ],
    result: REQUIRED_ASSERTIONS.every((name) => required[name] === true) && findings.length === 0
      ? 'pass'
      : 'finding',
  })}\n`);
  process.exit(0);
}
