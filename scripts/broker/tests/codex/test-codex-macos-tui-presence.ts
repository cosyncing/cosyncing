#!/usr/bin/env bun
/** Deterministic macOS Codex terminal-presence evidence and fail-closed restore classification. */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEX_MAC_SCAN_CANDIDATE_LIMIT,
  CODEX_MAC_LSOF_PATH,
  CODEX_MAC_PS_PATH,
  codexAttachedTuisAsync,
  resetCodexTuiPresenceCache,
  resolveCodexMacConfiguredExecutable,
  runBoundedMacCommand,
  scanCodexRemoteTuisAsync,
  scanCodexRemoteTuisMac,
  type CodexMacConfiguredExecutable,
  type CodexMacCommandResult,
  type CodexMacCommandRunner,
} from '../../../../packages/typescript/adapters/codex/src/tui-presence.ts';
import { classifyCodexTerminalPresence } from '../../../../packages/typescript/adapters/codex/src/implementation.ts';

let failures = 0;
const check = (label: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  — ${extra}` : ''}`);
  if (!ok) failures++;
};

const SOCK = '/tmp/cosyncing-mac/app-server-control.sock';
const OTHER_SOCK = '/tmp/other/app-server-control.sock';
const WORK = '/tmp/cosyncing-mac-work';
const THREAD = '019f5801-0000-7000-8000-000000000001';
const START = 'Sun Aug  9 12:00:00 2026';
const ok = (stdout: string): CodexMacCommandResult => ({
  exitCode: 0,
  stdout,
  timedOut: false,
  outputLimitExceeded: false,
});

interface FixtureOptions {
  initialIdentity: string;
  initialArgs?: string;
  finalIdentity?: string;
  finalArgs?: string;
  cwd?: string;
  sockets?: string;
  override?: (call: number) => CodexMacCommandResult | undefined;
  configuredExecutable?: CodexMacConfiguredExecutable | null;
}

function fixtureRunner(options: FixtureOptions): {
  runner: CodexMacCommandRunner;
  calls: Array<{ executable: string; args: readonly string[]; timeoutMs: number; maxOutputBytes: number }>;
} {
  const calls: Array<{ executable: string; args: readonly string[]; timeoutMs: number; maxOutputBytes: number }> = [];
  let argsProbe = 0;
  const runner: CodexMacCommandRunner = async (executable, args, limits) => {
    calls.push({ executable, args, ...limits });
    const overridden = options.override?.(calls.length);
    if (overridden) return overridden;
    if (args.includes('-axo')) return ok(options.initialIdentity);
    if (args.includes('-d')) return ok(options.cwd ?? '');
    if (args.includes('-U')) return ok(options.sockets ?? '');
    if (args.includes('pid=,lstart=,comm=')) return ok(options.finalIdentity ?? options.initialIdentity);
    if (args.includes('pid=,args=')) {
      const output = argsProbe++ === 0 ? options.initialArgs : options.finalArgs ?? options.initialArgs;
      return ok(output ?? '');
    }
    return { exitCode: 1, stdout: '', timedOut: false, outputLimitExceeded: false };
  };
  return { runner, calls };
}

const identityRow = (pid: number, executable: string, start = START) => `${pid} ${start} ${executable}\n`;
const argsRow = (pid: number, argv: string) => `${pid} ${argv}\n`;
const cwdRow = (pid: number, cwd = WORK) => `p${pid}\nfcwd\nn${cwd}\n`;
const socketRow = (pid: number, socket: string) => `p${pid}\nf7\nn${socket}\n`;
const presence = async (options: FixtureOptions) => {
  const fixture = fixtureRunner(options);
  const scan = await scanCodexRemoteTuisMac(SOCK, {
    runner: fixture.runner,
    ...(options.configuredExecutable !== undefined
      ? { configuredExecutable: options.configuredExecutable }
      : {}),
  });
  return { scan, ...fixture };
};

// Positive absence is the only evidence that may authorize automatic restoration.
{
  const { scan, calls } = await presence({ initialIdentity: identityRow(1, '/sbin/launchd') });
  check('macOS: a complete scan with no Codex candidates proves absence',
    classifyCodexTerminalPresence(scan, THREAD, WORK, Date.now()) === 'absent');
  check('macOS: an empty candidate scan stops after one bounded ps command', calls.length === 1);

  const empty = await presence({ initialIdentity: '' });
  check('macOS: empty ps output is incomplete evidence, never positive absence',
    classifyCodexTerminalPresence(empty.scan, THREAD, WORK, Date.now()) === 'unknown' &&
      !empty.scan.processScanAvailable);
}

{
  const argv = `codex resume --remote unix://${SOCK} ${THREAD}`;
  const { scan, calls } = await presence({
    initialIdentity: identityRow(123, 'codex'),
    initialArgs: argsRow(123, argv),
    cwd: cwdRow(123),
    sockets: socketRow(123, SOCK),
  });
  check('macOS: stable pid/start/argv/cwd/socket evidence classifies the shared terminal',
    classifyCodexTerminalPresence(scan, THREAD, WORK, scan.candidates[0]?.startedAtMs) === 'shared');
  check('macOS: evidence uses fixed ps/lsof argv without a shell command surface',
    calls.length === 6 && calls.every((call) =>
      call.executable === CODEX_MAC_PS_PATH || call.executable === CODEX_MAC_LSOF_PATH) &&
      calls.every((call) => Array.isArray(call.args) && call.args.every((arg) => !arg.includes(';'))));
  check('macOS: every command receives a finite deadline and bounded output cap',
    calls.every((call) => call.timeoutMs > 0 && call.timeoutMs <= 1_500 && call.maxOutputBytes <= 512 * 1024));
}

{
  const argv = `codex resume --remote unix://${OTHER_SOCK} ${THREAD}`;
  const { scan } = await presence({
    initialIdentity: identityRow(124, 'codex'),
    initialArgs: argsRow(124, argv),
    cwd: cwdRow(124),
    sockets: socketRow(124, OTHER_SOCK),
  });
  check('macOS: a stable terminal on another Codex socket is private',
    classifyCodexTerminalPresence(scan, THREAD, WORK, scan.candidates[0]?.startedAtMs) === 'private');
}

{
  const argv = `codex resume ${THREAD}`;
  const { scan } = await presence({
    initialIdentity: identityRow(125, 'codex'),
    initialArgs: argsRow(125, argv),
    cwd: cwdRow(125),
    sockets: '',
  });
  check('macOS: a candidate without trustworthy Unix-socket ownership remains unknown',
    classifyCodexTerminalPresence(scan, THREAD, WORK, scan.candidates[0]?.startedAtMs) === 'unknown');
}

// Incomplete, contradictory, or changing process identity invalidates the whole scan.
{
  const argv = `codex resume ${THREAD}`;
  const inaccessible = await presence({
    initialIdentity: identityRow(126, 'codex'),
    initialArgs: argsRow(126, argv),
    sockets: socketRow(126, SOCK),
  });
  check('macOS: inaccessible cwd evidence fails closed globally',
    classifyCodexTerminalPresence(inaccessible.scan, THREAD, WORK, Date.now()) === 'unknown' &&
      !inaccessible.scan.processScanAvailable);

  const stale = await presence({
    initialIdentity: identityRow(127, 'codex'),
    initialArgs: argsRow(127, argv),
    finalIdentity: identityRow(127, 'codex', 'Sun Aug  9 12:00:01 2026'),
    cwd: cwdRow(127),
    sockets: socketRow(127, SOCK),
  });
  check('macOS: PID/start-time reuse between probes fails closed',
    classifyCodexTerminalPresence(stale.scan, THREAD, WORK, Date.now()) === 'unknown' &&
      !stale.scan.processScanAvailable);

  const untrustedArgv = await presence({
    initialIdentity: identityRow(128, 'codex'),
    initialArgs: argsRow(128, `codex resume "${THREAD}"`),
  });
  check('macOS: argv that cannot be parsed without shell guessing fails closed',
    classifyCodexTerminalPresence(untrustedArgv.scan, THREAD, WORK, Date.now()) === 'unknown');

  const unrelatedQuotedNode = await presence({
    initialIdentity: identityRow(140, '/usr/local/bin/node'),
    initialArgs: argsRow(140, 'node -e "console.log(1)"'),
  });
  check('macOS: an unrelated quoted Node command still permits positive absence',
    unrelatedQuotedNode.scan.processScanAvailable && unrelatedQuotedNode.scan.candidates.length === 0 &&
      unrelatedQuotedNode.calls.length === 2 &&
      classifyCodexTerminalPresence(
        unrelatedQuotedNode.scan,
        THREAD,
        WORK,
        Date.now(),
      ) === 'absent');

  const malformedCodexWrapper = await presence({
    initialIdentity: identityRow(141, '/usr/local/bin/node'),
    initialArgs: argsRow(141, 'node "codex" resume'),
  });
  check('macOS: malformed Node argv that mentions Codex remains unknown',
    !malformedCodexWrapper.scan.processScanAvailable &&
      classifyCodexTerminalPresence(
        malformedCodexWrapper.scan,
        THREAD,
        WORK,
        Date.now(),
      ) === 'unknown');

  const malformedPossibleIdentity = await presence({
    initialIdentity: '134 invalid-start-time /usr/local/bin/node\n',
  });
  check('macOS: an unparseable possible-Codex executable identity fails closed',
    classifyCodexTerminalPresence(malformedPossibleIdentity.scan, THREAD, WORK, Date.now()) === 'unknown' &&
      !malformedPossibleIdentity.scan.processScanAvailable);
}

{
  const executable = '/Applications/Codex CLI/codex';
  const argv = `${executable} resume ${THREAD}`;
  const spaced = await presence({
    initialIdentity: identityRow(133, executable),
    initialArgs: argsRow(133, argv),
    cwd: cwdRow(133),
    sockets: '',
  });
  check('macOS: a Codex executable path containing spaces can never disappear into positive absence',
    spaced.scan.candidates.length === 1 &&
      classifyCodexTerminalPresence(spaced.scan, THREAD, WORK, spaced.scan.candidates[0]?.startedAtMs) === 'unknown');
}

{
  const executable = '/opt/agents/codex-terminal';
  const configuredExecutable = { invocationPath: executable, resolvedPath: executable };
  const direct = await presence({
    configuredExecutable,
    initialIdentity: identityRow(135, executable),
    initialArgs: argsRow(135, `${executable} resume --remote unix://${SOCK} ${THREAD}`),
    cwd: cwdRow(135),
    sockets: socketRow(135, SOCK),
  });
  check('macOS: a direct nonstandard COSYNCING_CODEX_BIN identity cannot disappear into absence',
    direct.scan.candidates.length === 1 &&
      classifyCodexTerminalPresence(direct.scan, THREAD, WORK, direct.scan.candidates[0]?.startedAtMs) === 'shared');

  const wrapper = await presence({
    configuredExecutable,
    initialIdentity: identityRow(136, '/usr/local/bin/node'),
    initialArgs: argsRow(136, `/usr/local/bin/node ${executable} resume --remote unix://${SOCK} ${THREAD}`),
    cwd: cwdRow(136),
    sockets: socketRow(136, SOCK),
  });
  check('macOS: a Node wrapper around a nonstandard COSYNCING_CODEX_BIN remains a candidate',
    wrapper.scan.candidates.length === 1 &&
      classifyCodexTerminalPresence(wrapper.scan, THREAD, WORK, wrapper.scan.candidates[0]?.startedAtMs) === 'shared');

  const malformedConfiguredIdentity = await presence({
    configuredExecutable,
    initialIdentity: '139 invalid-start-time codex-terminal\n',
  });
  check('macOS: an unparseable configured executable row fails closed',
    !malformedConfiguredIdentity.scan.processScanAvailable &&
      classifyCodexTerminalPresence(malformedConfiguredIdentity.scan, THREAD, WORK, Date.now()) === 'unknown');

  const managedHelper = await presence({
    configuredExecutable,
    initialIdentity: identityRow(138, executable),
    initialArgs: argsRow(138, `${executable} app-server --stdio`),
  });
  check('macOS: a recognized noninteractive custom Codex helper does not block proven absence',
    managedHelper.scan.processScanAvailable && managedHelper.scan.candidates.length === 0 &&
      classifyCodexTerminalPresence(managedHelper.scan, THREAD, WORK, Date.now()) === 'absent');

  const unmappable = await presence({
    configuredExecutable: null,
    initialIdentity: identityRow(1, '/sbin/launchd'),
  });
  check('macOS: an unmappable COSYNCING_CODEX_BIN makes absence unknown without probing',
    !unmappable.scan.processScanAvailable && unmappable.calls.length === 0 &&
      classifyCodexTerminalPresence(unmappable.scan, THREAD, WORK, Date.now()) === 'unknown');
}

{
  const identityRoot = mkdtempSync(join(tmpdir(), 'cosyncing-codex-custom-identity-'));
  try {
    const custom = join(identityRoot, 'codex-terminal');
    writeFileSync(custom, '#!/bin/sh\nexit 0\n');
    chmodSync(custom, 0o755);
    const resolved = resolveCodexMacConfiguredExecutable(custom);
    check('macOS: COSYNCING_CODEX_BIN resolves to a bounded executable process identity',
      resolved?.invocationPath === custom && resolved.resolvedPath === custom);
    chmodSync(custom, 0o644);
    check('macOS: a non-executable override cannot be mapped to positive-absence evidence',
      resolveCodexMacConfiguredExecutable(custom) === null);
    check('macOS: a missing override cannot be mapped to positive-absence evidence',
      resolveCodexMacConfiguredExecutable(join(identityRoot, 'missing')) === null);
  } finally {
    rmSync(identityRoot, { recursive: true, force: true });
  }
}

{
  const argv = `codex resume --remote unix://${SOCK} ${THREAD}`;
  const initialIdentity = identityRow(129, 'codex') + identityRow(130, 'codex');
  const initialArgs = argsRow(129, argv) + argsRow(130, argv);
  const cwd = cwdRow(129) + cwdRow(130);
  const sockets = socketRow(129, SOCK) + socketRow(130, SOCK);
  const { scan } = await presence({ initialIdentity, initialArgs, cwd, sockets });
  check('macOS: multiple matching candidates are ambiguous, never positive absence or ownership',
    classifyCodexTerminalPresence(scan, THREAD, WORK, scan.candidates[0]?.startedAtMs) === 'unknown');
}

{
  const unrelatedWrapperCount = CODEX_MAC_SCAN_CANDIDATE_LIMIT + 1;
  const unrelatedWrapperIdentities = Array.from({ length: unrelatedWrapperCount }, (_, index) =>
    identityRow(2_000 + index, index % 2 === 0 ? 'node' : 'bun')).join('');
  const unrelatedWrapperArgs = Array.from({ length: unrelatedWrapperCount }, (_, index) =>
    argsRow(2_000 + index, `${index % 2 === 0 ? 'node' : 'bun'} -e "console.log(${index})"`)).join('');
  const unrelatedWrappers = await presence({
    initialIdentity: unrelatedWrapperIdentities,
    initialArgs: unrelatedWrapperArgs,
  });
  check('macOS: unrelated Node/Bun processes do not consume the Codex candidate ceiling',
    unrelatedWrappers.scan.processScanAvailable && unrelatedWrappers.scan.candidates.length === 0 &&
      unrelatedWrappers.calls.length === 2 &&
      classifyCodexTerminalPresence(
        unrelatedWrappers.scan,
        THREAD,
        WORK,
        Date.now(),
      ) === 'absent');

  const tooMany = Array.from({ length: CODEX_MAC_SCAN_CANDIDATE_LIMIT + 1 }, (_, index) =>
    identityRow(1_000 + index, 'codex')).join('');
  const bounded = await presence({ initialIdentity: tooMany });
  check('macOS: excess candidate count fails closed before per-process probes',
    !bounded.scan.processScanAvailable && bounded.calls.length === 1);

  const timeout = await presence({
    initialIdentity: identityRow(131, 'codex'),
    initialArgs: argsRow(131, `codex resume ${THREAD}`),
    override: (call) => call === 1
      ? { exitCode: null, stdout: '', timedOut: true, outputLimitExceeded: false }
      : undefined,
  });
  check('macOS: a command deadline failure remains unknown', !timeout.scan.processScanAvailable);

  const overflow = await presence({
    initialIdentity: identityRow(132, 'codex'),
    initialArgs: argsRow(132, `codex resume ${THREAD}`),
    override: (call) => call === 1
      ? { exitCode: null, stdout: '', timedOut: false, outputLimitExceeded: true }
      : undefined,
  });
  check('macOS: an output-bound failure remains unknown', !overflow.scan.processScanAvailable);
}

// The display cache is bounded, while a restore decision explicitly requests fresh evidence.
{
  resetCodexTuiPresenceCache();
  const fixture = fixtureRunner({ initialIdentity: identityRow(1, '/sbin/launchd') });
  await codexAttachedTuisAsync(SOCK, undefined, { platform: 'darwin', macRunner: fixture.runner });
  await codexAttachedTuisAsync(SOCK, undefined, { platform: 'darwin', macRunner: fixture.runner });
  check('macOS: normal roster scans reuse the two-second cache', fixture.calls.length === 1);
  await codexAttachedTuisAsync(SOCK, undefined, { platform: 'darwin', macRunner: fixture.runner, fresh: true });
  check('macOS: restoration bypasses cached absence and performs a fresh scan', fixture.calls.length === 2);

  resetCodexTuiPresenceCache();
  const executable = '/opt/agents/codex-terminal';
  const configuredFixture = fixtureRunner({
    initialIdentity: identityRow(137, executable),
    initialArgs: argsRow(137, `${executable} resume ${THREAD}`),
    cwd: cwdRow(137),
    sockets: '',
  });
  await codexAttachedTuisAsync(SOCK, undefined, {
    platform: 'darwin',
    macRunner: configuredFixture.runner,
  });
  const configuredExecutable = { invocationPath: executable, resolvedPath: executable };
  const configuredScan = await codexAttachedTuisAsync(SOCK, undefined, {
    platform: 'darwin',
    macRunner: configuredFixture.runner,
    macConfiguredExecutable: configuredExecutable,
  });
  check('macOS: configured executable identity is part of the cache key',
    configuredFixture.calls.length === 7 && configuredScan.candidates.length === 1);
}

// The production runner waits for confirmed child close/stdio drain after its deadline. This real child
// would remain observable if the runner resolved immediately after sending SIGKILL.
{
  const childRoot = mkdtempSync(join(tmpdir(), 'cosyncing-codex-mac-child-'));
  try {
    const executable = join(childRoot, 'hang');
    writeFileSync(executable, '#!/usr/bin/env bun\nconsole.log(process.pid);\nawait Bun.sleep(60_000);\n');
    chmodSync(executable, 0o755);
    const started = Date.now();
    const result = await runBoundedMacCommand(executable, [], { timeoutMs: 100, maxOutputBytes: 4_096 });
    const pid = Number(result.stdout.trim());
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    check('macOS runner: deadline waits for real child exit and output drain',
      result.timedOut && Number.isSafeInteger(pid) && !alive && Date.now() - started < 1_000);
  } finally {
    rmSync(childRoot, { recursive: true, force: true });
  }
}

// Linux keeps its existing /proc + socket-probe behavior.
{
  const procRoot = mkdtempSync(join(tmpdir(), 'cosyncing-codex-linux-presence-'));
  try {
    mkdirSync(join(procRoot, '1'));
    writeFileSync(join(procRoot, 'uptime'), '100.00 200.00\n');
    writeFileSync(join(procRoot, '1', 'cmdline'), '/sbin/init\0');
    const linux = await scanCodexRemoteTuisAsync(SOCK, procRoot, Date.now(), {
      platform: 'linux',
      socketProbe: async () => '',
    });
    check('Linux behavior remains the /proc scanner with positive empty evidence',
      linux.source === 'linux' && linux.processScanAvailable &&
        classifyCodexTerminalPresence(linux, THREAD, WORK, Date.now()) === 'absent');
  } finally {
    rmSync(procRoot, { recursive: true, force: true });
  }
}

if (failures) {
  console.error(`\nFAIL: ${failures} macOS Codex terminal-presence check(s) failed.`);
  process.exit(1);
}
console.log('\nAll macOS Codex terminal-presence checks passed.');
