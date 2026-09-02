#!/usr/bin/env bun
/**
 * One broker lifetime that starts a managed OpenCode serve, creates a session, and then asks what
 * the broker says about a TERMINAL joined to that serve — for Phase 6 OpenCode slice 3.
 *
 * No model is involved: presence is a question about processes and badges, not about turns.
 *
 * The attach client is spawned through the product's own invocation boundary, so it is launched the
 * way the broker would launch it: on Windows that means a batch shim calling the real executable.
 *
 * Writes one JSON report to a FILE. Counts and booleans only — never a session identifier.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { HostProcessProvider, terminateHostProcessTree } from '../../../packages/typescript/adapter-api/src/host-process.ts';
import { bunSpawnResolvedInvocation, resolveInvocation } from '../../../packages/typescript/adapter-api/src/invocation.ts';
import {
  OpenCodeAdapter,
  resolveLocalOpencodeBaseUrl,
} from '../../../packages/typescript/adapters/opencode/src/implementation.ts';
import { attachedTuiSessions, tuiPresenceSupported } from '../../../packages/typescript/adapters/opencode/src/tui-presence.ts';
import {
  configureManagedOpencodeServeState,
  ensureManagedOpencodeServe,
  stopManagedOpencodeServe,
  OPENCODE_SERVE_OWNER_SCHEMA_VERSION,
  type OpencodeServeOwnership,
} from '../../../packages/typescript/adapters/opencode/src/managed-server.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Phase 6 OpenCode terminal broker requires ${name}`);
  return value;
}

const recordPath = required('COSYNCING_PHASE6_OC_RECORD');
const reportPath = required('COSYNCING_PHASE6_OC_REPORT');
const workdir = required('COSYNCING_PHASE6_OC_WORKDIR');
const base = resolveLocalOpencodeBaseUrl(required('OPENCODE_URL').replace(/\/$/, ''));
const port = String(Number(new URL(base).port) || 4096);
const hostProcesses = new HostProcessProvider();

function readRecord(): OpencodeServeOwnership | null {
  try {
    const parsed = JSON.parse(readFileSync(recordPath, 'utf8')) as OpencodeServeOwnership;
    return parsed?.schemaVersion === OPENCODE_SERVE_OWNER_SCHEMA_VERSION ? parsed : null;
  } catch { return null; }
}

configureManagedOpencodeServeState({
  readOwnership: () => readRecord(),
  writeOwnership: (identity, baseUrl) => {
    writeFileSync(recordPath, JSON.stringify({
      ...identity, baseUrl, schemaVersion: OPENCODE_SERVE_OWNER_SCHEMA_VERSION, recordedAtMs: Date.now(),
    } satisfies OpencodeServeOwnership));
  },
  clearOwnership: () => { try { rmSync(recordPath, { force: true }); } catch { /* already gone */ } },
  recordStartFailure: () => {},
  clearStartFailure: () => {},
});

/** The hint's shape, never its text: the command it suggests embeds a session identifier and a
 *  workspace path, and neither belongs in a report. */
function hintShape(hint: { label?: string; command?: string; note?: string } | undefined | null) {
  if (!hint) return null;
  return {
    hasLabel: typeof hint.label === 'string' && hint.label.length > 0,
    suggestsAttach: typeof hint.command === 'string' && hint.command.startsWith('opencode attach '),
    namesADirectory: typeof hint.command === 'string' && hint.command.includes('--dir '),
    hasNote: typeof hint.note === 'string' && hint.note.length > 0,
  };
}

const report: Record<string, unknown> = {};
let step = 'start';
let attachPid: number | undefined;
try {
  step = 'ensure-serve';
  await ensureManagedOpencodeServe();

  step = 'create';
  const adapter = new OpenCodeAdapter({ baseUrl: base });
  const created = await adapter.createSession({ directory: workdir, title: 'phase6 terminal' });
  const sessionId = created.id;
  report.sessionCreated = typeof sessionId === 'string' && sessionId.length > 0;
  // What the broker tells the app about terminal sync for a session nobody has attached to yet.
  report.hintBeforeAttach = hintShape(created.terminalSyncHint);

  step = 'presence-support';
  // The platform gate, read from the product. Windows has no /proc to pair a TUI with, and the
  // module's stated posture is to under-claim rather than guess.
  report.presenceSupported = tuiPresenceSupported(base);
  report.presenceSupportedOnLinux = tuiPresenceSupported(base, 'linux');

  step = 'attach';
  const invocation = resolveInvocation('opencode', { env: process.env, platform: process.platform });
  report.opencodeResolved = invocation !== null;
  if (!invocation) throw new Error('opencode did not resolve through the shared invocation boundary');
  const attach = bunSpawnResolvedInvocation(invocation, ['attach', base, '-s', sessionId], {
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', cwd: workdir, env: process.env,
  });
  attachPid = attach.pid;
  // A TUI needs a moment to come up, and the question is whether it STAYS up: a client that exits
  // immediately is not a terminal joined to the serve, and saying so is the point of the slice.
  await Bun.sleep(6_000);
  report.attachSpawned = typeof attachPid === 'number' && attachPid > 0;
  report.attachStillRunning = attach.exitCode === null && attach.killed === false;
  report.attachExitCode = attach.exitCode;
  // Whether the OS still shows a process for the pid we spawned, independent of Bun's own bookkeeping.
  report.attachLiveOnHost = attachPid ? hostProcesses.liveProcess(attachPid).state : 'absent';

  step = 'presence-with-tui';
  const attached = attachedTuiSessions(base);
  report.attachedSessionsSeen = attached.size;
  report.sessionReportedAsSynced = attached.has(sessionId);
  const rediscovered = (await adapter.discoverSessions()).find((session) => session.id === sessionId);
  report.hintWithTuiRunning = hintShape(rediscovered?.terminalSyncHint);
  report.controlWithTuiRunning = rediscovered?.control?.drive.state ?? null;

  step = 'stop-attach';
  // The attach client is reached through the same batch shim the serve is: `attach.kill()` kills the
  // cmd.exe wrapper and leaves the real opencode.exe running, orphaned and -- with its parent gone --
  // no longer provably anyone's. Take the tree.
  try {
    if (attachPid) terminateHostProcessTree(attachPid, true);
    else attach.kill();
  } catch { /* already gone */ }
  await Bun.sleep(1_500);
  report.attachStoppedCleanly = attachPid ? hostProcesses.liveProcess(attachPid).state === 'absent' : true;

  step = 'stop-serve';
  await stopManagedOpencodeServe();
  report.afterStop = { listener: hostProcesses.listener(Number(port), { fresh: true }).state };
  step = 'done';
} catch (error) {
  report.error = { step, reason: String(error).split('\n')[0]!.slice(0, 300) };
}
report.reachedStep = step;
report.attachPidRecorded = attachPid ?? null;

await Bun.write(reportPath, JSON.stringify(report));
await Bun.write(Bun.stdout, `${JSON.stringify(report)}\n`);
process.exit(0);
