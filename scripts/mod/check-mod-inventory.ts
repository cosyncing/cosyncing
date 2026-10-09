/**
 * The shipped mod's inventory, checked from source with no Claude and no network.
 *
 * A tripwire, not a sandbox. The mod runs inside every Claude session that installed it, and what
 * it can actually do there is the build's to decide; what this gate guarantees is that a change to
 * its reach cannot land without failing here and being argued for. The build prints the same list
 * (`claude plugin validate` prints the hooks, the `$` calls and the environment reads it found),
 * and the tier-2 smoke asserts that output against these same lists. This suite is the CI half,
 * and it reads the module as a syntax tree -- see mod-capability-scan.ts for the attribution rule.
 *
 * Three things make the gate worth having:
 *   1. the scan attributes every use of the handle and of the registration function to one of a
 *      few readable shapes, and refuses anything else rather than trying to follow it;
 *   2. the evasion corpus in mod-inventory-fixtures.ts runs every rewrite a reviewer can write in
 *      ten seconds, so "it passes today" is not the argument for the scan;
 *   3. the build's own reading is compared against ours when this machine can run it, and named
 *      as a skip -- not a pass -- when it cannot.
 *
 *   bun run scripts/mod/check-mod-inventory.ts      (exit 0 = all pass)
 *   bun run scripts/mod/check-mod-inventory.ts --register-js <copy of register.js>
 *   bun run scripts/mod/check-mod-inventory.ts --probe-timeout-ms <ms>
 *
 * `--register-js` points the scan at another copy of the module -- the copy setup stamps a socket
 * path into, or a fixture copy with one rewrite in it -- so the gate that reviews the tracked file
 * is the same gate that reviews every copy a user can end up with. Everything else it checks is
 * still the tracked tree. `--probe-timeout-ms` bounds the `claude --version` probe (default 60 s);
 * a probe that runs out of it fails the gate, it does not read as "no Claude here".
 */
export {};
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CLAUDE_MOD_MIN_VERSION } from '../../packages/typescript/adapters/claude/src/mod-presence.ts';
import { MAX_POLL_WAIT_MS, MOD_PATH_PREFIX } from '../../packages/typescript/broker/src/sessions/mod-protocol.ts';
import { CLAUDE_MOD_SOCKET_STAMP_LINE, stampClaudeModMarketplace } from '../../packages/typescript/broker/src/runtime/runtime-assets.ts';
import { CLEAN_FIXTURE, CLEAN_STAMPED_FIXTURE, FORBIDDEN_TEXT_FIXTURES, SCAN_FIXTURES } from './mod-inventory-fixtures.ts';
import { FORBIDDEN_TEXT, codeOnlyText, forbiddenTextHits, scanModule } from './mod-capability-scan.ts';

const ROOT = new URL('../..', import.meta.url).pathname;
const MOD_DIR = join(ROOT, 'mods/cosyncing-claude');
const HOOKS_JSON = join(MOD_DIR, 'hooks/hooks.json');

/** A named flag's value, or undefined. A flag given with no value is a usage error, not a default. */
function flagValue(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  if (at < 0) return undefined;
  const value = process.argv[at + 1];
  if (value === undefined || value.startsWith('--')) {
    console.log(`FAILED harness: ${name} needs a value`);
    process.exit(1);
  }
  return value;
}

/** The module the build loads, as tracked. */
const TRACKED_REGISTER_JS = join(MOD_DIR, 'hooks/register.js');
/** The module this run reviews: the tracked one, or the copy `--register-js` names. */
const REGISTER_JS = resolve(flagValue('--register-js') ?? TRACKED_REGISTER_JS);
const PLUGIN_JSON = join(MOD_DIR, '.claude-plugin/plugin.json');
const MARKETPLACE_JSON = join(ROOT, 'mods/marketplace.json');

/**
 * Every `$` call the mod may make. Add to this list only with a reason in the spec's security
 * section: each entry is a capability handed to a plugin in every Claude session that installed
 * it. The build prints its own reading of the same file, and a mismatch between the two lists is
 * a failure here, not a warning.
 */
const INTENDED_CALLS = [
  // The parked poll loop's re-arm. A host timer, not a hook's own budget: the loop is detached
  // from the dispatch that started it, and the alternative to a capped wait is a loop that ends
  // and never restarts, which is how a `cosy restart` used to kill sync in every open terminal.
  '$.clock.after',
  '$.env.get',
  '$.http.fetch',
  '$.prompt.submit',
  '$.session.append',
  // Both read only on the path that revives the loop after a plugin hot reload, where the
  // `session.start` event that normally carries these facts has already fired and will not
  // fire again. They are the build's own readings of two of the fields that event carries,
  // never invented, and never called per poll.
  '$.session.cwd',
  '$.session.id',
  '$.session.surfaces',
  '$.session.version',
  '$.turn.abort',
  '$.ui.invalidate',
  '$.ui.log',
  '$.ui.resolve',
].sort();

/** The environment the mod reads. A literal list, so "what can it see" has one answer. */
const INTENDED_ENV_READS = [
  'COSYNCING_CLAUDE_DEBUG',
  'COSYNCING_CLAUDE_DISABLE',
  'COSYNCING_CLAUDE_SOCK',
  'COSYNCING_CLAUDE_STEER',
  // The two that say where the broker's socket lives when setup's stamped path and the explicit
  // override are both absent. A terminal does not inherit the broker's environment, so these are
  // the mod's only way to find a state directory it was not told about.
  'COSYNCING_HOME',
  'COSYNCING_SPAWNED',
  'HOME',
].sort();

/** The hooks it registers, with the matchers that scope them. */
const INTENDED_HOOKS = [
  'session.attach',
  'session.end',
  'session.start',
  'tool.call{tool=AskUserQuestion}',
  'tool.check',
  'turn.complete',
  'turn.start',
  'turn.step',
  'ui.render{component=AbovePrompt}',
].sort();

/**
 * The only address the mod may name. It is a placeholder: with `socketPath` set the host is never
 * resolved, and the scan refuses any call that sets no socket, because then the name in the URL
 * is what the request actually goes to.
 */
const INTENDED_FETCH_ORIGIN = 'http://cosyncing.local';

/** The four broker endpoints, all under the mod's own prefix, never a route on the token surface. */
const INTENDED_ROUTES = ['/claude/mod/event', '/claude/mod/hold', '/claude/mod/poll', '/claude/mod/register'];

/** The transport constants, pinned to the broker's own numbers rather than a copy of them. */
const INTENDED_POLL_WAIT_MS = MAX_POLL_WAIT_MS;

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function json(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

/** A module-scope `const NAME = literal;` line, quotes stripped, when there is exactly one. */
function topLevelConst(source: string, name: string): string | undefined {
  const matches = [...source.matchAll(new RegExp(`^const ${name} = ([^;\\n]+);`, 'gm'))];
  if (matches.length !== 1) return undefined;
  const raw = matches[0]![1]!.trim();
  return raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw;
}

/**
 * `claude plugin test` runs the mod's tests with the build's own loader, which is the only
 * loader able to import `claude-code/testing`. The build can also refuse to run them at all:
 * its hooks-module feature sits behind a rollout switch that an earlier session can leave saved
 * off (measured on 2.1.289: "the rollout switch was saved off by an earlier session and is not
 * refreshed yet"), and it can be turned off remotely for an installed copy. That is a fact about
 * this machine's Claude and not a verdict on the mod's tests, so it reports as a named skip. A
 * `pass`/`fail` tally is decided by that tally; output with neither a tally nor a known refusal
 * fails, because an unrecognised answer must not read as success.
 */
type PluginTestVerdict =
  | { verdict: 'pass'; detail: string }
  | { verdict: 'fail'; detail: string }
  | { verdict: 'skip'; reason: string };

/** Measured output, kept as the fixture the classifier is tested against. */
const VENDOR_REFUSAL_FIXTURE = 'claude plugin test: hooks modules are turned off in this process: '
  + 'the rollout switch was saved off by an earlier session and is not refreshed yet. Start `claude` '
  + 'once with network access, then run the tests again; if this message returns, installed mods are '
  + 'turned off remotely';

/**
 * This only ever runs after the probe found a runnable Claude at or above the floor, so silence is
 * not "no Claude here" any more: a run killed or timed out (`status` null) and a run that printed
 * nothing are both answers nobody can read, and both fail. Reading them as a skip is how a hung or
 * crashing `plugin test` turned the mod's own test run green.
 */
function classifyPluginTest(status: number | null, output: string): PluginTestVerdict {
  const text = output.trim();
  if (status === null) return { verdict: 'fail', detail: `the run was killed or timed out before it answered: ${text.slice(0, 120)}` };
  if (text.length === 0) return { verdict: 'fail', detail: `no output at all (exit ${String(status)})` };
  const passed = /(?:^|\n)\s*(\d+) pass/.exec(text)?.[1];
  const failed = /(?:^|\n)\s*(\d+) fail/.exec(text)?.[1];
  if (passed === undefined && failed === undefined) {
    if (/turned off|rollout switch|not refreshed/i.test(text)) {
      return { verdict: 'skip', reason: `the build will not run plugin tests here: ${text.split('\n')[0]!.slice(0, 120)}` };
    }
    return { verdict: 'fail', detail: `no pass/fail tally (exit ${String(status)}): ${text.slice(0, 160)}` };
  }
  const passCount = Number(passed ?? '0');
  const failCount = Number(failed ?? '0');
  const summary = `${passCount} pass, ${failCount} fail${status === 0 ? '' : ` (exit ${String(status)})`}`;
  if (status === 0 && failCount === 0 && passCount > 0) return { verdict: 'pass', detail: summary };
  return { verdict: 'fail', detail: summary };
}

/**
 * The Claude this machine has, read from the binary the product would use.
 *
 * Only one answer skips: no binary at all (the spawn says ENOENT). Below the floor the build cannot
 * run the mod, so its `plugin validate` and `plugin test` say nothing about this mod and are
 * skipped by name too. Everything else is a failure: a `--version` that ran out of time, a binary
 * that could not be run or died on a signal, and a version that cannot be read -- because "I could
 * not read it" must never borrow the pass that "there is none" or "it is too old" earns. A timeout
 * used to read as absent, which turned a hung Claude into a skipped gate.
 *
 * The probe also names the binary, and `plugin validate` and `plugin test` run that binary. They
 * used to run a bare `claude` from PATH, so the gate could check one Claude's version and another
 * Claude's opinion of the mod.
 */
type ClaudeProbe =
  | { state: 'absent'; bin: string; detail: string }
  | { state: 'timeout'; bin: string; detail: string }
  | { state: 'unrunnable'; bin: string; detail: string }
  | { state: 'unparsable'; bin: string; detail: string }
  | { state: 'found'; bin: string; version: string; atOrAboveFloor: boolean };

/** The binary every Claude call in this gate runs: the product's override, else `claude`. */
function claudeBinary(): string {
  return (process.env.COSYNCING_CLAUDE_BIN ?? '').trim() || 'claude';
}

const DEFAULT_PROBE_TIMEOUT_MS = 60_000;

function probeTimeoutMs(): number {
  const raw = flagValue('--probe-timeout-ms');
  if (raw === undefined) return DEFAULT_PROBE_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    console.log(`FAILED harness: --probe-timeout-ms needs a positive whole number of milliseconds, not ${raw}`);
    process.exit(1);
  }
  return value;
}

function probeClaude(bin: string, timeoutMs: number): ClaudeProbe {
  const run = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: timeoutMs });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
  // `code` is a Node addition to Error, not something the shared Error type carries.
  const failure = run.error as (Error & { code?: string }) | undefined;
  if (failure?.code === 'ENOENT') return { state: 'absent', bin, detail: `${bin}: ENOENT` };
  if (failure?.code === 'ETIMEDOUT') {
    return { state: 'timeout', bin, detail: `${bin} --version timed out after ${timeoutMs} ms` };
  }
  if (failure !== undefined) return { state: 'unrunnable', bin, detail: `${bin}: ${String(failure.code ?? failure.message)}` };
  if (run.status === null) {
    return { state: 'unrunnable', bin, detail: `${bin} --version ended on ${String(run.signal ?? 'a signal')} before it answered` };
  }
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (match === null) return { state: 'unparsable', bin, detail: `${bin} --version: ${output.slice(0, 80)}` };
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  const floorParts = /(\d+)\.(\d+)\.(\d+)/.exec(CLAUDE_MOD_MIN_VERSION);
  const floor = floorParts === null ? [0, 0, 0] : [Number(floorParts[1]), Number(floorParts[2]), Number(floorParts[3])];
  let atOrAboveFloor = true;
  for (let i = 0; i < 3; i += 1) {
    if ((parts[i] ?? 0) !== (floor[i] ?? 0)) {
      atOrAboveFloor = (parts[i] ?? 0) > (floor[i] ?? 0);
      break;
    }
  }
  return { state: 'found', bin, version: parts.join('.'), atOrAboveFloor };
}

try {
  for (const file of [REGISTER_JS, HOOKS_JSON, PLUGIN_JSON, MARKETPLACE_JSON]) {
    check(`present: ${file.replace(ROOT + '/', '')}`, existsSync(file));
  }

  const source = readFileSync(REGISTER_JS, 'utf8');
  const scan = scanModule(REGISTER_JS, source, {
    intendedCalls: INTENDED_CALLS,
    intendedEnvReads: INTENDED_ENV_READS,
    fetchOrigin: INTENDED_FETCH_ORIGIN,
  });

  check('the mod parses', scan.syntaxErrors.length === 0, scan.syntaxErrors.join(' / ').slice(0, 200));

  // One check for the whole scan, with every refusal printed: a capability added to the mod has
  // to be argued about in this file before it ships, and "unreadable" is one of those arguments.
  check('the mod stays inside its inventory', scan.violations.length === 0,
    scan.violations.length === 0 ? `calls ${scan.calls.length}, hooks ${scan.hooks.length}, env ${scan.envReads.length}`
      : `\n  ${scan.violations.join('\n  ').slice(0, 2000)}`);

  check('the mod makes exactly the intended $ calls', JSON.stringify(scan.calls) === JSON.stringify(INTENDED_CALLS),
    scan.calls.filter((call) => !INTENDED_CALLS.includes(call)).join(', ')
      || `missing: ${INTENDED_CALLS.filter((call) => !scan.calls.includes(call)).join(', ')}`);

  // The matcher value is resolved through its constant, so `tool: QUESTION_TOOL` reads as the
  // tool it names. The build prints the same resolution.
  check('the mod registers exactly the intended hooks', JSON.stringify(scan.hooks) === JSON.stringify(INTENDED_HOOKS),
    scan.hooks.filter((hook) => !INTENDED_HOOKS.includes(hook)).join(', ')
      || `missing: ${INTENDED_HOOKS.filter((hook) => !scan.hooks.includes(hook)).join(', ')}`);

  check('the mod reads exactly the intended environment variables', JSON.stringify(scan.envReads) === JSON.stringify(INTENDED_ENV_READS),
    JSON.stringify(scan.envReads));
  check('the mod writes no environment variable', scan.envWrites.length === 0, JSON.stringify(scan.envWrites));

  // The transport's one address and four routes, read from the same tree as the calls.
  check('the transport host is the pinned placeholder', topLevelConst(source, 'HOST') === INTENDED_FETCH_ORIGIN,
    String(topLevelConst(source, 'HOST')));
  const routes = [...source.matchAll(/^(?:\s{2})?(\w+): '(\/[^\']*)'/gm)].map((match) => match[2]!);
  const routePaths = [...new Set(routes.filter((route) => route.startsWith(MOD_PATH_PREFIX)))].sort();
  check('every route is under the mod namespace', routePaths.length === INTENDED_ROUTES.length
    && JSON.stringify(routePaths) === JSON.stringify(INTENDED_ROUTES), routePaths.join(', '));
  // Comments are stripped first, so this counts the addresses the mod can dial, not the ones the
  // comments warn about. Anything beside the pinned placeholder is a second door.
  const urls = [...new Set(codeOnlyText(source).match(/https?:\/\/[^\s'",;`)]+/g) ?? [])].sort();
  check('the only address in the mod is the pinned placeholder',
    urls.length === 1 && urls[0] === INTENDED_FETCH_ORIGIN, urls.join(', ') || 'none');

  // The copy a user actually loads is the stamped one: setup writes the broker's socket path into
  // it. That copy has to clear the same scan, stamped by the product's own function rather than by
  // a string edit here, or the rule that keeps a stamped path reviewable is untested.
  const trackedSource = readFileSync(TRACKED_REGISTER_JS, 'utf8');
  const stampedFiles = stampClaudeModMarketplace('0.0.0',
    [{ path: 'cosyncing-claude/hooks/register.js', content: trackedSource }],
    '/srv/cosyncing-moved/claude-mod.sock');
  const stampedSource = stampedFiles[0]?.content ?? '';
  check('setup stamps the tracked mod at its one stamp line',
    trackedSource.includes(CLAUDE_MOD_SOCKET_STAMP_LINE) && !stampedSource.includes(CLAUDE_MOD_SOCKET_STAMP_LINE)
      && stampedSource.includes('const STAMPED_SOCKET_PATH = "/srv/cosyncing-moved/claude-mod.sock";'),
    'stampClaudeModMarketplace replaced the empty stamp with an absolute path');
  const stamped = scanModule(join(ROOT, 'stamped-register.js'), stampedSource, {
    intendedCalls: INTENDED_CALLS, intendedEnvReads: INTENDED_ENV_READS, fetchOrigin: INTENDED_FETCH_ORIGIN,
  });
  check('the setup-stamped copy of the mod stays inside its inventory',
    stamped.violations.length === 0 && stamped.syntaxErrors.length === 0
      && JSON.stringify(stamped.calls) === JSON.stringify(INTENDED_CALLS),
    stamped.violations.join(' / ').slice(0, 400) || `calls ${stamped.calls.length}`);

  // The scan itself, against the rewrites that used to walk past it.
  const scanOptions = { intendedCalls: INTENDED_CALLS, intendedEnvReads: INTENDED_ENV_READS, fetchOrigin: INTENDED_FETCH_ORIGIN };
  const clean = scanModule(join(ROOT, 'clean-fixture.js'), CLEAN_FIXTURE, scanOptions);
  check('the scan passes a mod that does nothing wrong', clean.violations.length === 0 && clean.syntaxErrors.length === 0,
    clean.violations.join(' / ').slice(0, 200));
  check('the clean fixture is itself meaningful', clean.calls.includes('$.http.fetch') && clean.hooks.length === 2,
    JSON.stringify(clean.calls));
  const cleanStamped = scanModule(join(ROOT, 'clean-stamped-fixture.js'), CLEAN_STAMPED_FIXTURE, scanOptions);
  check('the scan passes the clean fixture with a socket path stamped in', cleanStamped.violations.length === 0,
    cleanStamped.violations.join(' / ').slice(0, 200));

  // Every variant must be refused for its own reason. A variant refused only for some other,
  // incidental reason proves nothing about the rule it was written for.
  const missed: string[] = [];
  for (const fixture of SCAN_FIXTURES) {
    const outcome = scanModule(join(ROOT, 'evasion-fixture.js'), fixture.code, scanOptions);
    const codes = [...outcome.violations.map((violation) => violation.split(':')[0] ?? ''),
      ...outcome.syntaxErrors.map(() => 'syntaxErrors')];
    const caught = codes.some((code) => code.startsWith(fixture.expect));
    if (!caught) missed.push(`${fixture.name} (expected ${fixture.expect}, got ${codes.join('|') || 'nothing'})`);
  }
  // The text backstop is only worth its lines if each needle can match the code it names. Two of
  // the four never could: the token text was joined with spaces, so `process.env` in code read
  // `process . env`. One fixture per needle, written so the needle is why it trips.
  const deadNeedles = FORBIDDEN_TEXT.filter((needle) => {
    const fixture = FORBIDDEN_TEXT_FIXTURES[needle];
    if (fixture === undefined) return true;
    const outcome = scanModule(join(ROOT, 'forbidden-text-fixture.js'), fixture, scanOptions);
    return !outcome.violations.includes(`forbidden-text: the code contains ${JSON.stringify(needle)}`);
  });
  check('every forbidden-text needle trips on a fixture written for it',
    deadNeedles.length === 0 && Object.keys(FORBIDDEN_TEXT_FIXTURES).sort().join() === [...FORBIDDEN_TEXT].sort().join(),
    deadNeedles.length > 0 ? `never trips: ${deadNeedles.join(', ')}` : `${FORBIDDEN_TEXT.length} needles live`);
  check('"process.env" trips on code, not only inside a string',
    forbiddenTextHits('const home = process.env.HOME;').includes('process.env')
      && forbiddenTextHits('void process . env;').includes('process.env'),
    JSON.stringify(forbiddenTextHits('const home = process.env.HOME;')));
  check('"classic." trips on a member chain, not only inside a string',
    forbiddenTextHits('const name = classic.PreToolUse;').includes('classic.'),
    JSON.stringify(forbiddenTextHits('const name = classic.PreToolUse;')));

  check('the evasion corpus has at least 23 variants', SCAN_FIXTURES.length >= 23, String(SCAN_FIXTURES.length));
  check(`the scan refuses all ${SCAN_FIXTURES.length} evasions, each for its own reason`, missed.length === 0,
    missed.join('\n  ').slice(0, 1500));

  // Gate shapes the mod has to keep, asserted on the code rather than on prose about it.
  check('the band gates on a terminal surface', /state\.surface === 'terminal'/.test(source));
  check('the band refuses a broker-spawned session', /state\.spawned/.test(source) && /COSYNCING_SPAWNED/.test(source));
  check('the mod re-reads the session id in the loop', /currentSessionId\(\$/.test(source) && /id !== state\.sessionId/.test(source));
  check('an answer is allowed only from a human press', /onPress: tap\('allow'\)/.test(source));
  check('AskUserQuestion returns next(e) on a shape doubt', /return next\(e\)/.test(
    source.slice(source.indexOf('if (!validateAnswers'), source.indexOf('if (!validateAnswers') + 300)));
  check('the poll wait is the ceiling the broker answers', topLevelConst(source, 'POLL_WAIT_MS') === String(INTENDED_POLL_WAIT_MS),
    String(topLevelConst(source, 'POLL_WAIT_MS')));
  // A hold has no deadline and no poll budget: it lasts as long as the person takes. What keeps the
  // hook from waiting for ever on a dead broker is the bound on each request, which has to outlast
  // the broker's own park of one hold long-poll or every held call would be handed back at 20 s.
  const holdPollBound = Number(topLevelConst(source, 'HOLD_POLL_BREAK_MS'));
  check('each hold request outlasts the broker\'s park of it', holdPollBound > INTENDED_POLL_WAIT_MS && holdPollBound < 30_000,
    String(topLevelConst(source, 'HOLD_POLL_BREAK_MS')));
  check('the hold has no deadline and no poll budget', topLevelConst(source, 'HOLD_BREAK_MS') === undefined
    && topLevelConst(source, 'MAX_HOLD_POLLS') === undefined && !/TIMING\.holdBreakMs/.test(source),
    'HOLD_BREAK_MS/MAX_HOLD_POLLS/holdBreakMs');

  const hooksManifest = json(HOOKS_JSON);
  check('hooks.json loads one module, register.js', JSON.stringify(hooksManifest.modules) === JSON.stringify(['./register.js']),
    JSON.stringify(hooksManifest.modules));

  const plugin = json(PLUGIN_JSON);
  const marketplace = json(MARKETPLACE_JSON);
  const plugins = (marketplace.plugins ?? []) as Record<string, unknown>[];
  check('the marketplace names one plugin', plugins.length === 1, JSON.stringify(plugins.map((entry) => entry.name)));
  const entry = plugins[0] ?? {};
  check('the marketplace entry points at the sibling directory', entry.source === './cosyncing-claude', String(entry.source));
  check('plugin and marketplace agree on the name', plugin.name === entry.name && plugin.name === 'cosyncing-claude', `${String(plugin.name)} / ${String(entry.name)}`);
  check('plugin and marketplace agree on the version', typeof plugin.version === 'string' && plugin.version === entry.version, `${String(plugin.version)} / ${String(entry.version)}`);
  check('the marketplace is named cosyncing', marketplace.name === 'cosyncing', String(marketplace.name));
  check('the marketplace carries no network source', !JSON.stringify(marketplace).includes('http'), JSON.stringify(marketplace).slice(0, 80));

  // The laid types are a build artefact of a local `--plugin-dir` load: the installed build's
  // file, written next to the mod that loaded it. The question is what the repository ships, so
  // the question goes to git. A folder on this disk is someone's probe; a tracked file is ours.
  const tracked = spawnSync('git', ['-C', ROOT, 'ls-files', '--', 'mods/'], { encoding: 'utf8', timeout: 30_000 });
  const trackedFiles = (tracked.stdout ?? '').trim().split('\n').filter((line) => line.length > 0);
  check('git can list the mod tree', tracked.status === 0 && trackedFiles.length > 0,
    trackedFiles.length > 0 ? `${trackedFiles.length} tracked files` : (tracked.stderr ?? '').slice(0, 120));
  const laidTypes = trackedFiles.filter((path) => path.includes('.claude-plugin/types/'));
  check('no laid types are tracked in the mod tree', laidTypes.length === 0, laidTypes.join(', '));

  // The build's reading of the same file. It only speaks if this machine has a Claude that can
  // load the mod at all, which is the same floor setup offers it on.
  const claude = probeClaude(claudeBinary(), probeTimeoutMs());
  const canAskBuild = claude.state === 'found' && claude.atOrAboveFloor;
  const claudeDetail = claude.state === 'found'
    ? `claude ${claude.version} (${claude.bin}) sits ${claude.atOrAboveFloor ? 'at or above' : 'below'} the floor ${CLAUDE_MOD_MIN_VERSION}`
    : claude.state === 'absent' ? `no claude binary here (${claude.detail})`
      : claude.state === 'timeout' ? `the probe timed out: ${claude.detail}`
        : claude.state === 'unrunnable' ? `the binary could not be run: ${claude.detail}`
          : `cannot read a version: ${claude.detail}`;
  check('the Claude here can be read', claude.state === 'found' || claude.state === 'absent', claudeDetail);

  if (!canAskBuild) {
    const reason = claude.state === 'absent' ? `no claude binary here (${claude.detail})`
      : claude.state === 'found' ? `claude ${claude.version} is below ${CLAUDE_MOD_MIN_VERSION}, which cannot load this mod`
        : `the probe failed (${claude.state}), which the check above already failed`;
    // The probe above carries a failed probe on its own; two more reds for one broken
    // `--version` would only make a red run harder to read.
    check('claude plugin validate agrees with the intended inventory', true, `skipped: ${reason}`);
    check("the build runs the mod's tests", true, `skipped: ${reason}`);
  } else {
    const validate = spawnSync(claude.bin, ['plugin', 'validate', MOD_DIR], { encoding: 'utf8', timeout: 120_000 });
    const validateOut = `${validate.stdout ?? ''}${validate.stderr ?? ''}`;
    if (validateOut.length === 0) {
      check('claude plugin validate agrees with the intended inventory', false, `claude ${claude.version} produced no output`);
    } else {
      // Anchored on the module's own line, because the same word opens the `Validating hooks:`
      // banner, whose value is a path.
      const printedHooks = (/register\.js hooks: (.+)/.exec(validateOut)?.[1] ?? '').split(',').map((part) => part.trim()).filter(Boolean).sort();
      check('the build prints the intended hooks', JSON.stringify(printedHooks) === JSON.stringify(INTENDED_HOOKS),
        printedHooks.join(', ') || validateOut.slice(0, 160));
      // Each call is followed by `(via <function>)`, whose own comma would split on a naive
      // comma split, so the parentheticals come off first.
      const printedCalls = (/register\.js calls: (.+)/.exec(validateOut)?.[1] ?? '')
        .replace(/\(via[^)]*\)/g, '')
        .split(',').map((part) => part.trim()).filter(Boolean).sort();
      check('the build prints the intended $ calls', JSON.stringify(printedCalls) === JSON.stringify(INTENDED_CALLS),
        printedCalls.filter((call) => !INTENDED_CALLS.includes(call)).join(', ') || printedCalls.join(', '));
      const printedReads = (/\benv reads: (.+)/.exec(validateOut)?.[1] ?? '').split(',').map((part) => part.trim()).filter(Boolean).sort();
      check('the build prints the intended env reads', JSON.stringify(printedReads) === JSON.stringify(INTENDED_ENV_READS),
        printedReads.join(', '));
      check('the build reports no env writes', /env writes: nothing/.test(validateOut), 'see `claude plugin validate`');
      check('the build validates the mod', /Validation passed/.test(validateOut), validateOut.split('\n').filter(Boolean).slice(-3).join(' / ').slice(0, 200));
      // Two readers of one file. When they disagree the build is right about what it loads, but
      // the disagreement is still the finding, so this compares the two answers directly.
      check('the scan and the build agree on the calls', JSON.stringify(printedCalls) === JSON.stringify(scan.calls),
        `build ${printedCalls.join(', ')} | scan ${scan.calls.join(', ')}`);
      check('the scan and the build agree on the hooks', JSON.stringify(printedHooks) === JSON.stringify(scan.hooks),
        `build ${printedHooks.join(', ')} | scan ${scan.hooks.join(', ')}`);
    }

    // The mod's own tests run with the build's runner, not ours, so the assertions are checked
    // against the loader that will actually run them.
    const pluginTest = spawnSync(claude.bin, ['plugin', 'test', MOD_DIR], { encoding: 'utf8', timeout: 180_000 });
    const testOutcome = classifyPluginTest(pluginTest.status, `${pluginTest.stdout ?? ''}${pluginTest.stderr ?? ''}`);
    check("the build runs the mod's tests", testOutcome.verdict !== 'fail',
      testOutcome.verdict === 'fail' ? testOutcome.detail
        : testOutcome.verdict === 'skip' ? `skipped: ${testOutcome.reason}` : testOutcome.detail);
  }

  // The classifier's own contract, so a vendor wording change is caught here rather than
  // quietly turning a red mod test green.
  check('the plugin-test verdict separates refusal from failure',
    classifyPluginTest(1, VENDOR_REFUSAL_FIXTURE).verdict === 'skip'
      && classifyPluginTest(1, '10 pass, 1 fail').verdict === 'fail'
      && classifyPluginTest(0, '10 pass, 0 fail').verdict === 'pass'
      && classifyPluginTest(1, 'something else went wrong').verdict === 'fail'
      && classifyPluginTest(null, '').verdict === 'fail'
      && classifyPluginTest(1, '').verdict === 'fail',
    'refusal skips, a tally decides, an unknown answer or silence fails');

  const failed = results.filter((item) => !item.ok);
  console.log('');
  console.log(failed.length === 0 ? `OK ${results.length} passed` : `FAILED ${results.length - failed.length}/${results.length}`);
  for (const item of failed) console.log(`  failed: ${item.name}${item.detail ? ' — ' + item.detail : ''}`);
  process.exit(failed.length ? 1 : 0);
} catch (error) {
  console.log(`FAILED harness: ${String((error as Error)?.stack ?? error)}`);
  process.exit(1);
}
