#!/usr/bin/env bun
/**
 * Codex TUI presence — the OS-level proof behind the Codex synced badge (issues-part2 item 15
 * follow-ups: badge must DROP when the terminal exits, and only a terminal on OUR daemon may light
 * it). This test suite also verifies deterministic socket-diagnostic parsing for automatic
 * post-daemon discovery without `--remote`.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexAttachedTuis,
  codexAttachedTuisAsync,
  codexRemoteArgvFacts,
  codexTuiPresenceSupported,
  codexTuiThreadAttached,
  parseCodexSocketOwnership,
  resetCodexTuiPresenceCache,
  scanCodexRemoteTuis,
} from '../src/tui-presence.ts';

let failures = 0;
const check = (label: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  — ${extra}` : ''}`);
  if (!ok) failures++;
};

const SOCK = '/tmp/cosyncing-test-daemon/app-server-control.sock';
const REMOTE = `unix://${SOCK}`;
const UUID_A = '019f5701-0000-7000-8000-00000000000a';
const UUID_B = '019f5702-0000-7000-8000-00000000000b';
const UUID_C = '019f5703-0000-7000-8000-00000000000c';
const UUID_D = '019f5704-0000-7000-8000-00000000000d';
const UUID_E = '019f5705-0000-7000-8000-00000000000e';
const UUID_F = '019f5706-0000-7000-8000-00000000000f';

const socketProbe = (text: string) => () => text;

const PROBE_POST_DAEMON = `
u_str ESTAB 0 0 ${SOCK} 1606154843 * 1606198953 users:(("codex",pid=1212851,fd=21))
u_str ESTAB 0 0 * 1606198953 * 1606154843 users:(("codex",pid=101,fd=30))
u_str ESTAB 0 0 * 1606198953 * 1606154843 users:(("codex",pid=104,fd=31))
u_str LISTEN 0 4096 ${SOCK} 1475208987 * 0 users:(("codex",pid=1212851,fd=27))
`;

const PROBE_REAL_FORMAT = `
u_str ESTAB 0 0 /workspace/tester/.codex/app-server-control/app-server-control.sock 1606154843 * 1606198953 users:(("codex",pid=1212851,fd=21))
u_str ESTAB 0 0 * 1606198953 * 1606154843 users:(("codex",pid=2562266,fd=30))
u_str LISTEN 0 4096 /workspace/tester/.codex/app-server-control/app-server-control.sock 1475208987 * 0 users:(("codex",pid=1212851,fd=27))
`;

const PROBE_SHARED_NOT_DOWNGRADED = `
u_str ESTAB 0 0 /workspace/tester/.codex/app-server-control/app-server-control.sock 1606154843 * 1606198954 users:(("codex",pid=2562266,fd=32))
u_str LISTEN 0 4096 /tmp/other.sock 1475208999 * 0 users:(("codex",pid=2562266,fd=33))
u_str ESTAB 0 0 * 1606198953 * 1606198955 users:(("codex",pid=2562266,fd=34))
`;

const PROBE_SHARED_NOT_DOWNGRADED_REVERSED = PROBE_SHARED_NOT_DOWNGRADED
  .trim()
  .split('\n')
  .reverse()
  .map((line) => line.trim())
  .join('\n');

const PROBE_LISTEN_ONLY = `u_str LISTEN 0 4096 /workspace/tester/.codex/app-server-control/app-server-control.sock 1475208987 * 0 users:(("codex",pid=1212851,fd=27))`;

const PROBE_NO_SOCKET: string[] = [];

// ── argv parsing ─────────────────────────────────────────────────────────────────────────────────
{
  const explicit = codexRemoteArgvFacts(['codex', 'resume', '--remote', REMOTE, UUID_A], SOCK);
  check('tier-1: resume --remote <our-sock> <uuid> attributes the thread', explicit?.threadIds[0] === UUID_A);

  const explicitUpper = codexRemoteArgvFacts(['codex', 'resume', `--remote=${REMOTE}`, UUID_A.toUpperCase()], SOCK);
  check('tier-1: --remote= form and uppercase uuid normalize', explicitUpper?.threadIds[0] === UUID_A.toLowerCase());

  const plainResume = codexRemoteArgvFacts(['codex', 'resume', UUID_A], SOCK);
  check('plain `codex resume <uuid>` is attributed by verb-only resume parsing', plainResume?.threadIds[0] === UUID_A && plainResume?.remoteMatch === 'missing');

  const plainTui = codexRemoteArgvFacts(['codex'], SOCK);
  check('plain `codex` argv[0] form is considered interactive', !!plainTui && plainTui.threadIds.length === 0);

  const absoluteCodex = codexRemoteArgvFacts(['/tmp/codex-bin/codex', 'resume', UUID_B], SOCK);
  check('absolute Codex argv[0] is recognized as the executable', absoluteCodex?.threadIds[0] === UUID_B);

  const nodeWrapper = codexRemoteArgvFacts(['/usr/bin/node', '/tmp/codex-bin/codex', 'resume', UUID_C], SOCK);
  check('node wrapper with immediate Codex entrypoint is recognized', nodeWrapper?.threadIds[0] === UUID_C);

  const nestedSandboxHelper = ['bwrap', ...new Array(54).fill('keep'), 'codex', '--remote', REMOTE, UUID_D, '--sandbox-policy-cwd', '/tmp', '--apply-seccomp-then-exec'];
  check('bwrap/internal-sandbox helper argv arrays do not trigger false Codex attribution', codexRemoteArgvFacts(nestedSandboxHelper, SOCK) === undefined);

  const conflicting = codexRemoteArgvFacts(['codex', 'resume', '--remote', 'unix:///tmp/other.sock', UUID_A], SOCK);
  check('a --remote on ANOTHER daemon socket stays conflicting', conflicting?.remoteMatch === 'other');

  const remoteTcp = codexRemoteArgvFacts(['codex', 'resume', '--remote', 'ws://127.0.0.1:9999', UUID_A], SOCK);
  check('a ws:// remote is explicitly conflicting (not missing)', remoteTcp?.remoteMatch === 'other');

  const remoteMalformed = codexRemoteArgvFacts(['codex', 'resume', '--remote', 'not-a-socket', UUID_A], SOCK);
  check('a malformed remote string is explicitly conflicting', remoteMalformed?.remoteMatch === 'other');

  const noVerb = codexRemoteArgvFacts(['codex', '--remote', REMOTE, UUID_A], SOCK);
  check('a uuid-looking arg without resume does not become thread evidence', !!noVerb && noVerb.threadIds.length === 0);
  const conservativeResume = codexRemoteArgvFacts(['codex', 'resume', '--model', UUID_A, 'query'], SOCK);
  check('a UUID passed as resume option value is not auto-attributed', conservativeResume?.threadIds.length === 0);

  const excluded1 = codexRemoteArgvFacts(['codex', 'app-server', 'daemon', 'start'], SOCK);
  check('excluded non-interactive command `app-server` is ignored', excluded1 === undefined);

  const excluded2 = codexRemoteArgvFacts(['codex', 'helper'], SOCK);
  check('excluded non-interactive command `helper` is ignored', excluded2 === undefined);

  const excluded3 = codexRemoteArgvFacts(['codex', '-C', '/work', 'exec', 'list'], SOCK);
  check('exclude non-interactive subcommand after option value', excluded3 === undefined);

  const excluded4 = codexRemoteArgvFacts(['codex', '--config', 'x=y', 'app-server', '--status'], SOCK);
  check('exclude option-value prompt contamination for `app-server`', excluded4 === undefined);

  const excluded5 = codexRemoteArgvFacts(['codex', '--model', 'gpt', 'review', 'something'], SOCK);
  check('exclude option-value prompt contamination for `review`', excluded5 === undefined);

  const excluded6 = codexRemoteArgvFacts(['codex', '--search', 'exec', 'list'], SOCK);
  check('exclude non-interactive `exec` after boolean-like option flag', excluded6 === undefined);

  const excluded7 = codexRemoteArgvFacts(['codex', '--no-alt-screen', 'app-server', 'status'], SOCK);
  check('exclude non-interactive `app-server` after boolean-like option flag', excluded7 === undefined);

  const excluded8 = codexRemoteArgvFacts(['codex', 'login'], SOCK);
  check('exclude non-interactive `login`', excluded8 === undefined);

  const excluded9 = codexRemoteArgvFacts(['codex', 'plugin', 'list'], SOCK);
  check('exclude non-interactive `plugin`', excluded9 === undefined);

  const excluded10 = codexRemoteArgvFacts(['codex', 'doctor'], SOCK);
  check('exclude non-interactive `doctor`', excluded10 === undefined);

  for (const flag of ['--version', '-V', '--help', '-h']) {
    check(`exclude one-shot codex ${flag} invocation`, codexRemoteArgvFacts(['codex', flag], SOCK) === undefined);
  }
}

// ── socket-diagnostic parsing ─────────────────────────────────────────────────────────────────
{
  const parsed = parseCodexSocketOwnership(PROBE_POST_DAEMON, SOCK);
  const asRecord = Object.fromEntries(parsed);
  check('socket-diagnostic parser classifies shared paired ESTAB rows', parsed.get(101) === 'shared' && parsed.get(104) === 'shared');
  check('socket-diagnostic parser leaves unmatched sockets unknown, not private', parsed.get(9999) === undefined || parsed.get(9999) === 'unknown');
  check('parser output remains a bounded map keyed by pid', typeof asRecord['101'] === 'string');

  const realParsed = parseCodexSocketOwnership(PROBE_REAL_FORMAT, '/workspace/tester/.codex/app-server-control/app-server-control.sock');
  check('exact-host-format fixture marks reverse peer pid as shared', realParsed.get(2562266) === 'shared');
  check('listener-only socket row does not force non-client shared proof', realParsed.get(1212851) !== 'private');
  const realParsedListenOnly = parseCodexSocketOwnership(PROBE_LISTEN_ONLY, '/workspace/tester/.codex/app-server-control/app-server-control.sock');
  check('listener-only context cannot prove a reverse shared client', realParsedListenOnly.get(2562266) !== 'shared');

  const realParsedNoDowngrade = parseCodexSocketOwnership(PROBE_SHARED_NOT_DOWNGRADED, '/workspace/tester/.codex/app-server-control/app-server-control.sock');
  check('pid with shared ESTAB followed by unrelated rows remains shared', realParsedNoDowngrade.get(2562266) === 'shared');
  const realParsedNoDowngradeReversed = parseCodexSocketOwnership(
    PROBE_SHARED_NOT_DOWNGRADED_REVERSED,
    '/workspace/tester/.codex/app-server-control/app-server-control.sock',
  );
  check('reverse-row-order mixed rows preserve shared proof without downgrade', realParsedNoDowngradeReversed.get(2562266) === 'shared');
}

// ── attribution rules: post-daemon plain, plain resume, private, conflict, and cached scans ───
const procRoot = mkdtempSync(join(tmpdir(), 'cosyncing-codex-proc-'));
const workDir = mkdtempSync(join(tmpdir(), 'cosyncing-codex-work-'));
const bootUptimeSec = 5_000;
const baseNow = Date.now();

const writeProc = (
  pid: string,
  argv: string[],
  opts: { cwd?: string; startTicks?: number } = {},
) => {
  const dir = join(procRoot, pid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cmdline'), argv.join('\0') + '\0');
  if (opts.cwd) symlinkSync(opts.cwd, join(dir, 'cwd'));
  if (opts.startTicks !== undefined) {
    writeFileSync(
      join(dir, 'stat'),
      `${pid} (codex tui) S 1 1 1 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 ${opts.startTicks} 0 0`,
    );
  }
};
writeFileSync(join(procRoot, 'uptime'), `${bootUptimeSec}.00 20000.00\n`);

try {
  writeProc('101', ['codex', '--cd', workDir], { cwd: workDir, startTicks: (bootUptimeSec - 120) * 100 });
  writeProc('102', ['codex', 'app-server', 'status']); // excluded
  writeProc('103', ['codex', 'resume', '--remote', REMOTE, UUID_A], { cwd: workDir, startTicks: (bootUptimeSec - 90) * 100 });
  writeProc('104', ['codex', 'resume', UUID_B], { cwd: workDir, startTicks: (bootUptimeSec - 10) * 100 });
  writeProc('105', ['codex', 'resume', '--remote', 'unix:///tmp/cosyncing-test-daemon/other.sock', UUID_C], {
    cwd: workDir,
    startTicks: (bootUptimeSec - 20) * 100,
  });
  writeProc('106', ['codex', 'resume', '--remote', 'unix:///tmp/cosyncing-test-daemon/old-private.sock', UUID_D], {
    cwd: workDir,
    startTicks: (bootUptimeSec - 30) * 100,
  });
  writeProc('107', ['vim', 'notes.md']);
  writeProc('108', ['codex', 'resume', UUID_F], { cwd: workDir, startTicks: (bootUptimeSec - 15) * 100 });
  writeProc('109', ['codex', 'resume', UUID_E], { cwd: workDir, startTicks: (bootUptimeSec - 16) * 100 });
  writeProc('110', ['codex', '--version']);
  writeProc('111', ['codex', '-h']);
  rmSync(join(procRoot, '109'), { recursive: true, force: true }); // process exits between enumeration and read

  const scan = scanCodexRemoteTuis(SOCK, procRoot, baseNow, { socketProbe: socketProbe(PROBE_POST_DAEMON) });
  check(
    'explicit matching remote keeps authoritative shared proof',
    scan.attributed.has(UUID_A),
  );
  check(
    'plain `codex resume <uuid>` after-daemon is now shared by socket proof',
    scan.attributed.has(UUID_B),
  );
  check('conflicting remote is marked private, not shared', scan.privateThreadIds.has(UUID_C) && !scan.attributed.has(UUID_C));
  check(
    'candidate connected to old socket is private and excluded from shared',
    scan.privateThreadIds.has(UUID_D) && !scan.attributed.has(UUID_D),
  );
  check(
    'bounded candidates are per-process and include pid + proof',
    scan.candidates.length >= 5 &&
      scan.candidates.some((c) => c.pid === 101 && c.proof === 'shared') &&
      scan.candidates.some((c) => c.pid === 105 && c.proof === 'private') &&
      scan.candidates.some((c) => c.pid === 108 && c.proof === 'unknown' && (c.threadIds ?? []).length === 1),
  );
  const candidate101 = scan.candidates.find((c) => c.pid === 101);
  const candidate105 = scan.candidates.find((c) => c.pid === 105);
  const candidate108 = scan.candidates.find((c) => c.pid === 108);
  check('candidate list preserves exact threadIds and cwd/start fields', candidate101?.proof === 'shared' && candidate105?.threadIds?.[0] === UUID_C && candidate108?.cwd === workDir);
  check('non-interactive app-server helpers are excluded from attribution', !scan.attributed.has(UUID_C));
  check('post-daemon plain `codex` is unattributed-shared candidate', scan.unattributed.length === 1 && scan.unattributed[0]!.cwd === workDir);
  check('private-vs-unknown separation: non-matching socket resume-only process is unknown', scan.unknownThreadIds.has(UUID_F) && !scan.privateThreadIds.has(UUID_F));
  check('unknown-only candidates stay in unknown thread-id bucket', scan.unknownThreadIds.has(UUID_F) && scan.unknownUnattributed.length === 0);
  check('excluded commands never appear as candidates', !scan.candidates.some((c) => c.pid === 102) && !scan.candidates.some((c) => c.pid === 107));
  check('one-shot version/help invocations never appear as candidates', !scan.candidates.some((c) => c.pid === 110) && !scan.candidates.some((c) => c.pid === 111));
  check(
    'process exit/read races are ignored and do not introduce ghost attribution',
    !scan.attributed.has(UUID_E) && !scan.privateThreadIds.has(UUID_E),
  );
  const postDaemonCreated = scan.unattributed[0]!.startedAtMs ?? baseNow;
  check(
    'new-session plain codex + shared socket + cwd+birth aligns by window for tier-2',
    codexTuiThreadAttached(scan, '019f9999-0000-4000-8000-0000000000fd', workDir, postDaemonCreated),
  );
  check(
    'tier-2: an old thread in the same cwd does not align',
    !codexTuiThreadAttached(scan, '019f9999-0000-4000-8000-00000000ffff', workDir, baseNow - 20_000_000),
  );

  // Pre-daemon/private process: same argv pattern without managed socket proof should be private, not shared.
  rmSync(join(procRoot, '104', 'cwd'), { force: true }); // harmless process-exit style read fault
  resetCodexTuiPresenceCache();
  const privateScan = scanCodexRemoteTuis(
    SOCK,
    procRoot,
    baseNow,
    {
      socketProbe: () =>
        `u_str ESTAB 0 0 /tmp/cosyncing-test-daemon/old-private.sock 999 * 888 users:(("codex",pid=104,fd=31))`,
    },
  );
  check('plain pre-daemon process without matching socket proof is unknown, not private', privateScan.unknownThreadIds.has(UUID_B));

  // socket diagnostic unavailable: explicit remote remains authoritative, plain resume does not become shared.
  const noDiagScan = scanCodexRemoteTuis(
    SOCK,
    procRoot,
    baseNow,
    { socketProbe: () => undefined },
  );
  check('unavailable ss/diagnostic is fail-closed for automatic discovery', !noDiagScan.attributed.has(UUID_B));
  check('explicit remote still authoritatively classifies shared when ss is unavailable', noDiagScan.attributed.has(UUID_A));
  const noDiagCandidate104 = noDiagScan.candidates.find((c) => c.pid === 104);
  check('socket diagnostic unavailability marks resume-only process as unknown in candidates', noDiagCandidate104?.proof === 'unknown');
  check('socket diagnostic unavailability keeps process-scan available marker true', noDiagScan.processScanAvailable === true);

  // TTL cache remains bounded and returns the same object within TTL.
  resetCodexTuiPresenceCache();
  const first = codexAttachedTuis(SOCK, procRoot);
  rmSync(join(procRoot, '101'), { recursive: true, force: true });
  const second = codexAttachedTuis(SOCK, procRoot);
  check('scan is TTL-cached within the window', first === second);
  resetCodexTuiPresenceCache();
  const third = codexAttachedTuis(SOCK, procRoot);
  check('cache reset re-scans (shared plain TUI disappears)', third.unattributed.length === 0);

  let asyncProbeCalls = 0;
  let asyncProbeActive = 0;
  let asyncProbeMax = 0;
  const asyncProbe = async () => {
    asyncProbeCalls += 1;
    asyncProbeActive += 1;
    asyncProbeMax = Math.max(asyncProbeMax, asyncProbeActive);
    await Bun.sleep(25);
    asyncProbeActive -= 1;
    return PROBE_POST_DAEMON;
  };
  resetCodexTuiPresenceCache();
  const [asyncFirst, asyncSecond] = await Promise.all([
    codexAttachedTuisAsync(SOCK, procRoot, { socketProbe: asyncProbe }),
    codexAttachedTuisAsync(SOCK, procRoot, { socketProbe: asyncProbe }),
  ]);
  check('async socket refresh coalesces same-key in-flight scans', asyncProbeCalls === 1 && asyncProbeMax === 1 && asyncFirst === asyncSecond);
  const asyncThird = await codexAttachedTuisAsync(SOCK, procRoot, { socketProbe: asyncProbe });
  check('async socket refresh reuses the completed TTL cache', asyncThird === asyncFirst && asyncProbeCalls === 1);

  // ── platform gate ──────────────────────────────────────────────────────────────────────────────
  check('presence supports bounded Linux and macOS evidence while other platforms under-claim',
    codexTuiPresenceSupported('linux') && codexTuiPresenceSupported('darwin') && !codexTuiPresenceSupported('win32'));
  if (!codexTuiPresenceSupported()) {
    const unsupportedScan = codexAttachedTuis(SOCK, procRoot);
    check('unsupported cached presence marks process scan unavailable', unsupportedScan.processScanAvailable === false);
  }
  check('missing proc root never throws and returns empty', scanCodexRemoteTuis(SOCK, join(procRoot, 'does-not-exist')).attributed.size === 0);
  if (process.platform === 'linux') {
    const unreadableRoot = mkdtempSync(join(tmpdir(), 'cosyncing-unreadable-proc-'));
    try {
      chmodSync(unreadableRoot, 0o000);
      const unreadableScan = scanCodexRemoteTuis(SOCK, unreadableRoot);
      check('unreadable proc root returns empty candidate set', unreadableScan.candidates.length === 0 && unreadableScan.attributed.size === 0);
      check('unreadable proc root marks processScanAvailable as false', unreadableScan.processScanAvailable === false);
    } finally {
      chmodSync(unreadableRoot, 0o700);
      rmSync(unreadableRoot, { recursive: true, force: true });
    }
  }
  check('socket diagnostic parse is optional and does not panic on empty output', parseCodexSocketOwnership(PROBE_NO_SOCKET.join('\n'), SOCK).size === 0);
} finally {
  rmSync(procRoot, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
}

console.log(failures ? `\nFAIL: ${failures} check(s) failed.` : '\nAll codex tui-presence checks passed.');
process.exit(failures ? 1 : 0);
