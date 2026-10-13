import { classifyCodexTerminalPresence, codexControlState } from '../src/implementation.ts';
import { createCodexNewThreadFolderScan, readCodexDaemonCwd } from '../src/daemon-process.ts';
import { CODEX_TUI_PRESENCE_TTL_MS, codexNewThreadFolders, type CodexTuiCandidate, type CodexTuiScan } from '../src/tui-presence.ts';

type Check = (name: string, ok: boolean, detail?: string) => void;

export async function remoteFolderChecks(check: Check): Promise<void> {
  const daemon = '/fixture/daemon'; const project = '/fixture/project';
  const start = 1_000_000; const born = start + 2_000;
  const terminal = (overrides: Partial<CodexTuiCandidate> = {}): CodexTuiCandidate => ({
    pid: 42, cwd: project, processCwd: project, startedAtMs: start, proof: 'shared',
    startToken: 'stable start', argv: ['codex', '--remote', 'unix:///fixture/socket'],
    socketPaths: ['/fixture/socket'], ...overrides,
  });
  const raw = (candidates: CodexTuiCandidate[], mac = false): CodexTuiScan => {
    const bucket = (proof: string) => candidates.filter((c) => c.proof === proof && !c.threadIds?.length)
      .map((c) => ({ cwd: c.cwd, startedAtMs: c.startedAtMs, processCwd: c.processCwd, cwdOverride: c.cwdOverride }));
    const ids = (proof: string) => new Set(candidates.filter((c) => c.proof === proof).flatMap((c) => c.threadIds ?? []));
    return { candidates, attributed: ids('shared'), privateThreadIds: ids('private'), unknownThreadIds: ids('unknown'),
      unattributed: bucket('shared'), privateUnattributed: bucket('private'), unknownUnattributed: bucket('unknown'),
      socketDiagAvailable: true, processScanAvailable: true, ...(mac ? { source: 'darwin' as const } : {}) };
  };
  for (const mac of [false, true]) {
    const host = mac ? 'macOS' : 'Linux';
    const scan = codexNewThreadFolders(raw([terminal()], mac), daemon);
    const presence = classifyCodexTerminalPresence(scan, 'new-thread', daemon, born, 'user');
    check(`PR3 ${host} plain shared terminal matches the user thread in the daemon folder`, presence === 'shared');
    check(`PR3 ${host} app-shaped thread without thread_source does not match`,
      classifyCodexTerminalPresence(scan, 'app-thread', daemon, born) === 'absent');
    check(`PR3 ${host} thread older than terminal start beyond clock skew does not match`,
      classifyCodexTerminalPresence(scan, 'old-thread', daemon, start - 6_000, 'user') === 'absent');
    check(`PR3 ${host} five-second clock skew remains accepted`,
      classifyCodexTerminalPresence(scan, 'clock-skew', daemon, start - 5_000, 'user') === 'shared');
    check(`PR3 ${host} unreadable daemon folder never falls back to the process folder`,
      classifyCodexTerminalPresence(codexNewThreadFolders(raw([terminal()], mac)), 'unknown-folder', project, born, 'user') === 'absent');
    const explicit = codexNewThreadFolders(raw([terminal({ cwdOverride: project, processCwd: daemon })], mac), daemon);
    check(`PR3 ${host} explicit -C terminal never matches the different daemon folder`,
      classifyCodexTerminalPresence(explicit, 'daemon-thread', daemon, born, 'user') === 'absent');
    check(`PR3 ${host} explicit -C retains the existing folder rule`,
      classifyCodexTerminalPresence(explicit, 'project-thread', project, born) === 'shared');
    const relative = codexNewThreadFolders(raw([terminal({ cwdOverride: '../relative project' })], mac), daemon);
    check(`PR3 ${host} relative -C resolves against the terminal process folder`,
      classifyCodexTerminalPresence(relative, 'relative-thread', '/fixture/relative project', born) === 'shared');
    const pair = codexNewThreadFolders(raw([terminal(), terminal({ pid: 43, startedAtMs: start + 3_000, startToken: 'second start' })], mac), daemon);
    check(`PR3 ${host} two plain terminals three seconds apart match both user threads`,
      classifyCodexTerminalPresence(pair, 'thread-one', daemon, born, 'user') === 'shared'
        && classifyCodexTerminalPresence(pair, 'thread-two', daemon, start + 5_000, 'user') === 'shared');
    const privateScan = codexNewThreadFolders(raw([terminal({ proof: 'private' })], mac), daemon);
    check(`PR3 ${host} a private terminal does not match the shared daemon folder`,
      classifyCodexTerminalPresence(privateScan, 'private-thread', daemon, born, 'user') === 'absent');
    check(`PR3 ${host} outside the birth window does not match`,
      classifyCodexTerminalPresence(scan, 'late-thread', daemon, start + 16 * 60_000, 'user') === 'absent');
    const joined = codexNewThreadFolders(raw([terminal({ threadIds: ['joined-thread'] })], mac), undefined);
    check(`PR3 ${host} explicit resume id retains shared proof without creator or folder inference`,
      classifyCodexTerminalPresence(joined, 'joined-thread') === 'shared');
    const control = codexControlState({ canResume: true, driveState: 'unavailable', terminalSyncActive: true,
      terminalSyncPresence: presence, syncEnabled: true });
    check(`PR3 ${host} shared presence renders Synced and does not offer Drive`,
      control.terminalSync.label === 'Synced with Codex terminal' && control.terminalSync.active
        && control.drive.state === 'unavailable');
    const appPresence = classifyCodexTerminalPresence(scan, 'app-thread', daemon, born);
    const app = codexControlState({ canResume: true, driveState: 'driving', terminalSyncActive: false,
      terminalSyncPresence: appPresence, syncEnabled: true });
    check(`PR3 ${host} app-only presence keeps the Driving state`, app.drive.state === 'driving' && !app.terminalSync.active);
  }

  let folderReads = 0; let scanTime = 0;
  const prepare = createCodexNewThreadFolderScan({ now: () => scanTime,
    readFolder: async () => { folderReads++; return daemon; } });
  for (const candidates of [[], [terminal({ proof: 'private' })], [terminal({ proof: 'unknown' })],
    [terminal({ threadIds: ['joined-thread'] })], [terminal({ cwdOverride: project })],
    [terminal({ cwdOverride: '../relative project' })]]) {
    await prepare(raw(candidates), '/fixture/socket', '/fixture/home', '/fixture/codex');
  }
  check('PR3 scan without a plain proven-shared terminal reads no daemon folder', folderReads === 0);
  const first = await prepare(raw([terminal()]), '/fixture/socket', '/fixture/home', '/fixture/codex');
  scanTime = CODEX_TUI_PRESENCE_TTL_MS - 1;
  const second = await prepare(raw([terminal({ pid: 43 })]), '/fixture/socket', '/fixture/home', '/fixture/codex');
  check('PR3 two scans within the presence TTL read the daemon folder once', folderReads === 1
    && classifyCodexTerminalPresence(first, 'first', daemon, born, 'user') === 'shared'
    && classifyCodexTerminalPresence(second, 'second', daemon, born, 'user') === 'shared');

  const process = { pid: 424242, start: 'start', boot: 'boot', comm: '/fixture/codex', executable: '/fixture/codex', argv: [], home: '/fixture/home', cli: '/fixture/codex' };
  const readProcess = () => ({ state: 'running' as const, process });
  let freshIdentity = false;
  const liveProcess = (pid: number, options?: { fresh?: boolean }) => {
    freshIdentity = pid === process.pid && options?.fresh === true;
    return { state: 'running' as const, identity: process };
  };
  let readPath = '';
  const linux = await readCodexDaemonCwd('/fixture/home', '/fixture/codex', { platform: 'linux', readProcess, liveProcess,
    readLink: (path) => { readPath = path; return daemon; } });
  check('PR3 daemon folder read uses the proven PID rather than the broker folder', linux === daemon && readPath === '/proc/424242/cwd' && freshIdentity);
  const unreadable = await readCodexDaemonCwd('/fixture/home', '/fixture/codex', { platform: 'linux', readProcess, liveProcess,
    readLink: () => { throw new Error('unreadable cwd'); } });
  check('PR3 unreadable proven daemon cwd returns no folder evidence', unreadable === undefined);
  const changed = await readCodexDaemonCwd('/fixture/home', '/fixture/codex', { platform: 'linux', readProcess,
    liveProcess: () => ({ state: 'running', identity: { ...process, start: 'replacement start' } }), readLink: () => daemon });
  const changedBoot = await readCodexDaemonCwd('/fixture/home', '/fixture/codex', { platform: 'linux', readProcess,
    liveProcess: () => ({ state: 'running', identity: { ...process, boot: 'replacement boot' } }), readLink: () => daemon });
  check('PR3 daemon PID identity change invalidates its folder evidence', changed === undefined && changedBoot === undefined);
  let args: readonly string[] = [];
  const mac = await readCodexDaemonCwd('/fixture/home', '/fixture/codex', { platform: 'darwin', readProcess, liveProcess,
    macRunner: async (_binary, command, limits) => {
      args = command;
      return { exitCode: limits.timeoutMs <= 1_000 && limits.maxOutputBytes <= 8_192 ? 0 : 1,
        stdout: 'p424242\nn/fixture/mac daemon\n', timedOut: false, outputLimitExceeded: false };
    } });
  check('PR3 macOS proven daemon folder uses bounded fixed-argv lsof and preserves spaces',
    mac === '/fixture/mac daemon' && JSON.stringify(args) === JSON.stringify(['-a', '-p', '424242', '-d', 'cwd', '-Fn']));
}

if (import.meta.main) {
  let failed = 0;
  await remoteFolderChecks((name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failed++; });
  process.exitCode = failed ? 1 : 0;
}
