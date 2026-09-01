#!/usr/bin/env bun
/**
 * Phase 6 OpenCode slice 3 — terminal routing and TUI presence on native Windows.
 *
 * Two advertised capabilities, and the plan requires each to be qualified or explicitly disabled
 * and explained, never silently inferred:
 *
 *   Terminal routing. The opt-in shim is a POSIX shell function: cosyncing writes
 *   `<state home>/shell/opencode-shim.sh` and a delimited block into rc files that ALREADY exist,
 *   and the block's install line is `[ -f '<path>' ] && . '<path>'`. So the question on Windows is
 *   not whether the block is written correctly. It is whether any shell on the host would ever
 *   source it — and, since the rc owner check was `process.getuid`-shaped, whether the
 *   file it edits was proven to be the operator's at all.
 *
 *   TUI presence. `tuiPresenceSupported` is gated to Linux because presence is read from /proc, and
 *   the stated posture is to under-claim rather than guess. This checks that the posture HOLDS with
 *   a real `opencode attach` client running against the broker's own serve: the badge must stay
 *   dark, and nothing may claim a sync it cannot see.
 *
 * The host's own rc files are READ, never written. Everything the probe writes goes into a
 * disposable home under the run root.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { homedir } from 'node:os';
import { captureHostSnapshot } from './phase6-host-snapshot.ts';
import { HostProcessProvider, terminateHostProcessTree, windowsPathOwnedByCurrentUser } from '../../../packages/typescript/adapter-api/src/host-process.ts';
import {
  OPENCODE_SHIM_SOURCE,
  inspectRcFile,
  opencodeShimBlockLines,
  opencodeShimRcCandidates,
  opencodeShimShellPath,
} from '../../../packages/typescript/adapters/opencode/src/shim.ts';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Phase 6 OpenCode terminal probe requires ${name}`);
  return value;
}

const root = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_ROOT');
const runId = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_RUN_ID');
const sourceCommit = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_COMMIT');
const sourceDirty = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_DIRTY');
if (process.platform !== 'win32') {
  throw new Error('Phase 6 OpenCode terminal probe requires its native Windows runner environment');
}

const dataDir = win32.join(root, 'opencode-data');
const workdir = win32.join(root, 'workspace');
const disposableHome = win32.join(root, 'home');
const recordPath = win32.join(root, 'serve-ownership.json');
for (const dir of [dataDir, workdir, disposableHome]) mkdirSync(dir, { recursive: true });

const observations: Record<string, unknown> = {};
const findings: string[] = [];
const note = (message: string): void => { if (!findings.includes(message)) findings.push(message); };

const REQUIRED_ASSERTIONS = [
  'routing.blockIsPosixOnly',
  'routing.noRcCandidateIsOfferedOnWindows',
  'routing.noWindowsShellCouldHaveSourcedOne',
  'routing.ownershipOfAnRcFileIsProvable',
  'presence.disabledOnWindows',
  'presence.attachClientRan',
  'presence.badgeStayedDarkWithALiveClient',
  'presence.attachClientStopped',
  'serve.stopFreedThePort',
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

function assignPortByBind(): number {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const assigned = server.port;
  server.stop(true);
  return assigned;
}

let port = 0;
let baseUrl = '';
let pidsBefore = new Set<number>();
let snapshotBefore: Awaited<ReturnType<typeof captureHostSnapshot>> = null;
const helperPids: number[] = [];

async function runBroker(): Promise<Record<string, unknown>> {
  const helperPath = win32.join(import.meta.dir, 'phase6-opencode-terminal-broker.ts');
  const helperReport = win32.join(root, 'broker-terminal.json');
  const outPath = win32.join(root, 'broker-terminal.out.log');
  const errPath = win32.join(root, 'broker-terminal.err.log');
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
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
        COSYNCING_PHASE6_OC_RECORD: recordPath,
        COSYNCING_PHASE6_OC_REPORT: helperReport,
        COSYNCING_PHASE6_OC_WORKDIR: workdir,
      },
    });
    if (child.pid) helperPids.push(child.pid);
    await Promise.race([child.exited, Bun.sleep(240_000)]);
    if (child.exitCode === null) { try { child.kill(); } catch { /* already gone */ } }
    if (!existsSync(helperReport)) {
      const tail = [errPath, outPath]
        .map((path) => { try { return readFileSync(path, 'utf8').trim(); } catch { return ''; } })
        .find((text) => text.length > 0)?.split('\n').filter(Boolean).at(-1) ?? 'no output';
      throw new Error(`the terminal broker wrote no report (exit ${child.exitCode}): ${tail.slice(0, 300)}`);
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

  // ---------------------------------------------------------------------------------------------
  // Terminal routing. Every read below is of the product's own planning functions; the host's rc
  // files are inspected, never written.
  // ---------------------------------------------------------------------------------------------
  const shimPath = opencodeShimShellPath(win32.join(disposableHome, '.cosyncing'));
  const blockLines = opencodeShimBlockLines(shimPath, 4096);
  const sourceLine = blockLines.find((line) => line.startsWith('[ -f '));
  observations.routing = {
    shimScriptIsAShellScript: OPENCODE_SHIM_SOURCE.includes('opencode()') || OPENCODE_SHIM_SOURCE.startsWith('#'),
    installLineShape: sourceLine ? sourceLine.split(shimPath).join('<shim>') : null,
  };
  // `. '<path>'` is the POSIX dot-source. Neither cmd.exe nor PowerShell can execute this line.
  assertRequired('routing.blockIsPosixOnly', !!sourceLine && sourceLine.includes("] && . '"));

  // The candidates the product offers for the REAL Windows home, read-only.
  //
  // This assertion is INVERTED from the one this probe first carried. It used to prove the defect —
  // that setup would edit a real rc file here and report success — and that finding was recorded as
  // a Phase 7 requirement. The requirement is now met: no candidate is offered on Windows at all, so
  // there is nothing to edit, and the setup planner refuses the opt-in in words instead of silently
  // doing nothing.
  const hostHome = homedir();
  const hostCandidates = opencodeShimRcCandidates({ homeDir: hostHome, platform: process.platform });
  const posixCandidates = opencodeShimRcCandidates({ homeDir: hostHome, platform: 'linux' });
  observations.hostRcCandidates = {
    offeredOnThisPlatform: hostCandidates.length,
    offeredOnPosix: posixCandidates.length,
  };
  assertRequired('routing.noRcCandidateIsOfferedOnWindows',
    hostCandidates.length === 0 && posixCandidates.length === 2);

  // Which POSIX shells exist here at all. `bash` on a Windows PATH is normally System32's WSL
  // launcher, whose HOME is the WSL home and not this one, so a block written here is not on its path.
  const shells = ['zsh', 'bash', 'sh'].map((name) => {
    const resolved = Bun.which(name);
    return { name, resolved: resolved ? resolved.replace(/\\/g, '/') : null };
  });
  observations.posixShells = shells;
  const zsh = shells.find((shell) => shell.name === 'zsh');
  const bash = shells.find((shell) => shell.name === 'bash');
  const bashIsWslLauncher = !!bash?.resolved && /\/Windows\/(System32|SysWOW64)\//i.test(bash.resolved);
  // Kept as the EVIDENCE FOR the refusal rather than as a finding against the product: no zsh exists
  // here, and the only `bash` is System32's WSL launcher, whose HOME is the WSL home — so a block
  // written into this profile would have been on nobody's path. That is why offering no candidate is
  // the right answer and not merely a conservative one.
  const unsourceable = !zsh?.resolved && (bashIsWslLauncher || !bash?.resolved);
  observations.routingReach = { zshPresent: !!zsh?.resolved, bashIsWslLauncher, unsourceable };
  assertRequired('routing.noWindowsShellCouldHaveSourcedOne', unsourceable);
  if (!unsourceable) {
    note('a POSIX shell on this host could have sourced an rc block, so the blanket Windows refusal '
      + 'is broader than this machine strictly requires — worth revisiting if Git Bash routing is '
      + 'ever made a supported configuration');
  }

  // The owner check, also inverted. It used to degrade on Windows to "it is a regular file" — no
  // owner proof, no DACL consulted — because the test asked `process.getuid`, which Windows does not
  // have, and then simply skipped the question. Ownership is now decided by comparing owner SIDs, so
  // a file this run created in its own disposable home must read as ours, and the answer must be a
  // definite 'yes' rather than the 'unknown' a machine returns when it will not say.
  const disposableRc = win32.join(disposableHome, '.zshrc');
  writeFileSync(disposableRc, '# phase 6 disposable rc\n');
  const ownedAnswer = windowsPathOwnedByCurrentUser(disposableRc);
  const strangerAnswer = windowsPathOwnedByCurrentUser(win32.join(disposableHome, 'does-not-exist.rc'));
  observations.rcOwnership = {
    uidAvailable: typeof process.getuid === 'function',
    ownFileAnswer: ownedAnswer,
    missingFileAnswer: strangerAnswer,
  };
  assertRequired('routing.ownershipOfAnRcFileIsProvable',
    ownedAnswer === 'yes' && strangerAnswer !== 'yes');
  if (ownedAnswer !== 'yes') {
    note('the Windows owner check could not prove this run owns a file it just created, so every '
      + 'rc-file safety test that depends on it will decline rather than proceed');
  }

  // ---------------------------------------------------------------------------------------------
  // TUI presence, against a real serve and a real attach client.
  // ---------------------------------------------------------------------------------------------
  port = assignPortByBind();
  baseUrl = `http://127.0.0.1:${port}`;
  const terminal = await runBroker();
  observations.terminal = terminal;
  if (terminal.error) note(`the terminal broker stopped at ${(terminal.error as any).step}: ${(terminal.error as any).reason}`);

  assertRequired('presence.disabledOnWindows',
    terminal.presenceSupported === false && terminal.presenceSupportedOnLinux === true);
  // If an attach client cannot even run here, that is a bigger statement about terminal routing on
  // Windows than a dark badge is, so it is required rather than tolerated.
  assertRequired('presence.attachClientRan',
    terminal.attachSpawned === true && terminal.attachStillRunning === true
    && terminal.attachLiveOnHost === 'running');
  if (terminal.attachStillRunning !== true) {
    note('the opencode attach client did not stay running on this host');
  }
  assertRequired('presence.badgeStayedDarkWithALiveClient',
    terminal.attachedSessionsSeen === 0 && terminal.sessionReportedAsSynced === false);
  assertRequired('presence.attachClientStopped', terminal.attachStoppedCleanly === true);
  assertRequired('serve.stopFreedThePort', (terminal.afterStop as any)?.listener === 'absent');
} catch (error) {
  observations.aborted = { reason: String(error).split('\n')[0]!.slice(0, 200) };
  note('the OpenCode terminal probe stopped early; observations recorded up to that point');
} finally {
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
    slice: 'opencode-terminal-routing-and-presence',
    source: { commit: sourceCommit, dirty: sourceDirty === 'true' },
    host: { platform: process.platform, arch: process.arch },
    runtime: { bun: Bun.version },
    observations,
    required,
    requiredUnmet: REQUIRED_ASSERTIONS.filter((name) => required[name] !== true),
    findings,
    deferred: [
      'what setup, doctor, and repair SAY about terminal routing on Windows: host policy still '
      + 'refuses Windows, so no lifecycle command can be run here yet',
      'a Windows-native presence source; this slice only proves the Linux-only gate holds',
    ],
    result: REQUIRED_ASSERTIONS.every((name) => required[name] === true) && findings.length === 0
      ? 'pass'
      : 'finding',
  })}\n`);
}
