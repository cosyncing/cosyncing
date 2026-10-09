/**
 * The inventory gate, run as `check` runs it, against copies of the mod it has to refuse or pass.
 *
 * The gate's own corpus runs the scan function in-process. This suite is the other half: it runs
 * the real gate script as a child, pointed at rewritten copies of the TRACKED register.js with
 * `--register-js`, so a hole between the scan and the gate (a check that never sees the scan's
 * refusal, a list comparison that hides it) shows up as a green gate over a red copy. The three
 * rewrites below are the ones that passed the real gate before the scan learnt attribution.
 *
 * The second half is the gate's Claude: it must run the one binary its probe resolved, and a probe
 * that hangs must fail rather than read as "no Claude here". Those children get COSYNCING_CLAUDE_BIN
 * at a fake that records every call and answers like a build at the floor.
 *
 * No real Claude runs here. Every gate child gets COSYNCING_CLAUDE_BIN at a fake or at a path that
 * does not exist, and a PATH whose only `claude` is a sentinel that records being called and
 * answers nothing, so a regression that reaches for a bare `claude` cannot reach the operator's
 * real one.
 *
 *   bun run scripts/mod/test-mod-inventory-gate.ts        (exit 0 = all pass)
 */
export {};
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stampClaudeModMarketplace } from '../../packages/typescript/broker/src/runtime/runtime-assets.ts';
import { scanModule } from './mod-capability-scan.ts';

const ROOT = new URL('../..', import.meta.url).pathname;
const GATE = join(ROOT, 'scripts/mod/check-mod-inventory.ts');
const TRACKED = join(ROOT, 'mods/cosyncing-claude/hooks/register.js');

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const SCRATCH = mkdtempSync(join(tmpdir(), 'cmts-inventory-gate-'));
const sentinelDir = join(SCRATCH, 'path-bin');
const sentinelLog = join(SCRATCH, 'bare-claude.log');
mkdirSync(sentinelDir, { recursive: true });
// A bare `claude` that writes down that it was reached and says nothing a gate could read as an
// answer. Any line in its log is a gate that ran something other than the binary it resolved.
writeFileSync(join(sentinelDir, 'claude'), `#!/bin/sh\necho "bare claude $*" >> '${sentinelLog}'\nexit 1\n`);
chmodSync(join(sentinelDir, 'claude'), 0o755);

/** PATH for every gate child: the sentinel first, then only what the gate itself needs. */
const CHILD_PATH = [sentinelDir, dirname(process.execPath), '/usr/bin', '/bin'].join(':');

function runGate(args: string[], env: Record<string, string> = {}): { status: number | null; out: string } {
  const run = spawnSync(process.execPath, ['run', GATE, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      HOME: process.env.HOME ?? SCRATCH,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      PATH: CHILD_PATH,
      COSYNCING_CLAUDE_BIN: join(SCRATCH, 'no-such-claude'),
      ...env,
    },
  });
  return { status: run.status, out: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

/** A copy of the tracked mod with exactly one rewrite, refused if the anchor is not there once. */
function rewrite(name: string, edits: [string, string][]): string {
  let source = readFileSync(TRACKED, 'utf8');
  for (const [anchor, replacement] of edits) {
    const count = source.split(anchor).length - 1;
    if (count !== 1) throw new Error(`${name}: anchor found ${count} times: ${anchor}`);
    source = source.replace(anchor, replacement);
  }
  const path = join(SCRATCH, `${name}.js`);
  writeFileSync(path, source);
  return path;
}

try {
  // The control: the tracked file, through the same child invocation the copies get.
  const tracked = runGate([]);
  check('the gate passes the tracked mod', tracked.status === 0, tracked.out.split('\n').filter((line) => /^(OK|FAILED)/.test(line)).join(' '));

  // The copy setup installs. Stamped by the product's own function, not by an edit here.
  const stampedPath = join(SCRATCH, 'stamped.js');
  const stampedFile = stampClaudeModMarketplace('0.0.0',
    [{ path: 'cosyncing-claude/hooks/register.js', content: readFileSync(TRACKED, 'utf8') }],
    '/srv/cosyncing-moved/claude-mod.sock')[0]!;
  writeFileSync(stampedPath, stampedFile.content);
  const stamped = runGate(['--register-js', stampedPath]);
  check('the gate passes the setup-stamped copy of the mod', stamped.status === 0
    && readFileSync(stampedPath, 'utf8').includes('"/srv/cosyncing-moved/claude-mod.sock"'),
  stamped.out.split('\n').filter((line) => /^(OK|FAILED)|^  failed/.test(line)).join(' ').slice(0, 300));
  // R4-9: a socket path with every replacement pattern in it, stamped the same way.
  const dollarSocket = "/srv/c$$o$&s$`y$'n/claude-mod.sock";
  const dollarPath = join(SCRATCH, 'stamped-dollars.js');
  writeFileSync(dollarPath, stampClaudeModMarketplace('0.0.0',
    [{ path: 'cosyncing-claude/hooks/register.js', content: readFileSync(TRACKED, 'utf8') }], dollarSocket)[0]!.content);
  const dollars = runGate(['--register-js', dollarPath]);
  check('R4-9 the gate passes a copy stamped with a socket path holding $$, $&, $` and $\'', dollars.status === 0
    && readFileSync(dollarPath, 'utf8').includes(`const STAMPED_SOCKET_PATH = ${JSON.stringify(dollarSocket)};`),
  dollars.out.split('\n').filter((line) => /^(OK|FAILED)|^  failed/.test(line)).join(' ').slice(0, 300));

  const comma = runGate(['--register-js', rewrite('comma', [[
    '    state.version = await sessionVersion($);\n',
    "    state.version = await sessionVersion($);\n    await (0, $.process.run)(['id']);\n",
  ]])]);
  check('the gate refuses a comma expression around a forbidden call', comma.status === 1
    && /handle-unattributable: line \d+ uses \$ as a value \(\$\.process\.run\)/.test(comma.out),
  comma.out.split('\n').filter((line) => /handle-|^(OK|FAILED)/.test(line)).slice(0, 3).join(' | '));

  const emptySocket = runGate(['--register-js', rewrite('empty-socket', [
    ["const SOCKET_FILENAME = 'claude-mod.sock';\n", "const SOCKET_FILENAME = 'claude-mod.sock';\nconst NO_SOCKET = '';\n"],
    ['    socketPath: state.socketPath,\n', '    socketPath: NO_SOCKET,\n'],
  ])]);
  check('the gate refuses an empty constant as the socket', emptySocket.status === 1
    && /fetch-destination: line \d+ takes its socket from NO_SOCKET, which resolveSocketPath never writes/.test(emptySocket.out),
  emptySocket.out.split('\n').filter((line) => /fetch-|^(OK|FAILED)/.test(line)).slice(0, 3).join(' | '));

  const atRoute = runGate(['--register-js', rewrite('at-route', [[
    'let target = HOST + ROUTES[route] + ',
    "let target = HOST + '@evil.example' + ROUTES[route] + ",
  ]])]);
  check('the gate refuses an @ route after the pinned host', atRoute.status === 1
    && /fetch-destination: line \d+ continues the pinned host with "@evil\.example"/.test(atRoute.out),
  atRoute.out.split('\n').filter((line) => /fetch-|^(OK|FAILED)/.test(line)).slice(0, 3).join(' | '));

  // ---- the gate's Claude ----

  // What the build prints for the tracked mod, from the scan's own reading of it: the gate checks
  // the scan against the intended lists, so a fake that prints the scan's lists is a build that
  // agrees, and the run can only go red for the reason under test.
  const reading = scanModule(TRACKED, readFileSync(TRACKED, 'utf8'), { intendedCalls: [], intendedEnvReads: [], fetchOrigin: 'http://cosyncing.local' });
  const validateText = join(SCRATCH, 'validate.txt');
  writeFileSync(validateText, [
    `Validating hooks: ${join(ROOT, 'mods/cosyncing-claude/hooks')}`,
    `  register.js hooks: ${reading.hooks.join(', ')}`,
    `  register.js calls: ${reading.calls.join(', ')}`,
    `  env reads: ${reading.envReads.join(', ')}`,
    '  env writes: nothing',
    'Validation passed',
  ].join('\n') + '\n');

  /** A fake Claude at the floor that writes down every call it gets. `testReply` is `plugin test`'s. */
  function fakeClaude(name: string, testReply: string): { bin: string; log: string } {
    const bin = join(SCRATCH, name);
    const log = join(SCRATCH, `${name}.log`);
    writeFileSync(bin, `#!/bin/sh
echo "$*" >> '${log}'
case "$1" in
  --version) echo "2.1.291 (Claude Code)" ;;
  plugin) case "$2" in
    validate) cat '${validateText}' ;;
    test) ${testReply} ;;
  esac ;;
esac
`);
    chmodSync(bin, 0o755);
    return { bin, log };
  }

  const named = fakeClaude('named-claude', "printf '12 pass\\n0 fail\\n'");
  const namedRun = runGate([], { COSYNCING_CLAUDE_BIN: named.bin });
  const namedCalls = existsSync(named.log) ? readFileSync(named.log, 'utf8').trim().split('\n') : [];
  const modDir = join(ROOT, 'mods/cosyncing-claude');
  check('validate and test run the binary the version probe resolved',
    namedCalls.includes('--version') && namedCalls.includes(`plugin validate ${modDir}`) && namedCalls.includes(`plugin test ${modDir}`),
    JSON.stringify(namedCalls));
  check('the gate passes when the resolved Claude agrees with the scan', namedRun.status === 0
    && /PASS {2}the scan and the build agree on the calls/.test(namedRun.out) && /PASS {2}the build runs the mod's tests {2}— 12 pass, 0 fail/.test(namedRun.out),
  namedRun.out.split('\n').filter((line) => /^FAIL|^(OK|FAILED)/.test(line)).join(' | ').slice(0, 300));

  // A `--version` that never answers. The fake execs `sleep` so the probe's kill lands on it and
  // nothing outlives the run.
  const slow = join(SCRATCH, 'slow-claude');
  writeFileSync(slow, '#!/bin/sh\nexec sleep 30\n');
  chmodSync(slow, 0o755);
  const started = Date.now();
  const slowRun = runGate(['--probe-timeout-ms', '500'], { COSYNCING_CLAUDE_BIN: slow });
  const slowMs = Date.now() - started;
  check('a --version that times out fails the gate instead of reading as no Claude', slowRun.status === 1
    && /FAIL {2}the Claude here can be read {2}— the probe timed out: .* --version timed out after 500 ms/.test(slowRun.out)
    && !/no claude binary here/.test(slowRun.out),
  `${slowMs} ms; ${slowRun.out.split('\n').filter((line) => /Claude here|^(OK|FAILED)/.test(line)).join(' | ').slice(0, 300)}`);

  // A `plugin test` that says nothing is not a skip once the probe found a Claude at the floor.
  const mute = fakeClaude('mute-claude', 'exit 1');
  const muteRun = runGate([], { COSYNCING_CLAUDE_BIN: mute.bin });
  check("a plugin test that prints nothing fails instead of reading as skipped", muteRun.status === 1
    && /FAIL {2}the build runs the mod's tests {2}— no output at all \(exit 1\)/.test(muteRun.out),
  muteRun.out.split('\n').filter((line) => /mod's tests|^(OK|FAILED)/.test(line)).join(' | ').slice(0, 300));

  check('no gate child reached a bare claude', !existsSync(sentinelLog),
    existsSync(sentinelLog) ? readFileSync(sentinelLog, 'utf8').trim() : 'sentinel never called');
} catch (error) {
  check('the suite ran to the end', false, String((error as Error)?.stack ?? error));
} finally {
  rmSync(SCRATCH, { recursive: true, force: true });
}

const failed = results.filter((entry) => !entry.ok);
console.log('');
console.log(failed.length === 0 ? `OK ${results.length}/${results.length} passed` : `FAILED ${results.length - failed.length}/${results.length}`);
for (const entry of failed) console.log(`  failed: ${entry.name}${entry.detail ? ' — ' + entry.detail : ''}`);
process.exit(failed.length ? 1 : 0);
