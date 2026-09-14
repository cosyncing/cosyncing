/**
 * The product-version reader four gates depend on -- three as a floor,
 * Reasonix still exactly.
 *
 * `reportedProductVersion` decides, with `===`, whether cline, kilo, grok and
 * reasonix may open a WRITE-CAPABLE child. Both directions are expensive: a
 * false negative takes a correctly installed lane dark, a false positive admits
 * a build nobody measured. It shipped with no test at all, and an adversarial
 * review then found six inputs that broke it — every one of them is below.
 *
 * The gates feed it `stdout + "\n" + stderr`, so the noise cases are not
 * hypothetical; they are what a Node deprecation warning or an update banner
 * does to a real probe.
 */
import { lowestSemanticVersion, reportedProductVersion } from '../src/diagnosis.ts';

let failures = 0;
let total = 0;

function check(name: string, ok: boolean, detail?: string): void {
  total += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

function reads(
  name: string,
  output: string,
  productNames: readonly string[],
  expected: string | undefined,
): void {
  const actual = reportedProductVersion(output, productNames);
  check(name, actual === expected, `${JSON.stringify(output)} -> ${String(actual)} (want ${String(expected)})`);
}

// ── The four measured `--version` outputs, byte for byte ────────────────────
reads('cline prints a bare version', '3.0.61\n', ['cline'], '3.0.61');
reads('kilo prints a bare version', '7.4.23\n', ['kilo', 'kilocode'], '7.4.23');
reads('grok names itself and adds a build and a channel',
  'grok 1.0.13 (5e9a58528b76) [stable]\n', ['grok'], '1.0.13');
reads('reasonix names itself with a v prefix', 'reasonix v1.25.2\n', ['reasonix'], '1.25.2');

// ── The three bypasses this reader was written to close ─────────────────────
reads('a four-part build number is not the pinned triple', '3.0.60.1\n', ['cline'], undefined);
reads('a version inside a path is not a version', '~/.cache/cline/3.0.60/bin\n', ['cline'], undefined);
reads('an update notice answers nothing, whichever version it leads with',
  'update available: 3.0.60 -> 3.1.0\n', ['cline'], undefined);

// ── Noise on the other stream must not darken a correct install ─────────────
reads('a Node deprecation warning beside a bare version does not answer for it',
  '3.0.60\n(node:1) Warning: cline is using deprecated API v0.9.1\n', ['cline'], '3.0.60');
reads('a bun notice does not make a correct install unverifiable',
  '7.4.23\nbun: a newer release is available\n', ['kilo', 'kilocode'], '7.4.23');
reads('a line naming the product without a version beside it contributes nothing',
  '1.25.2\nreasonix is running in restricted mode\n', ['reasonix'], '1.25.2');

// ── Adjacency, in both directions ───────────────────────────────────────────
reads('the runtime on the same line is not the product answer',
  'node v22.11.0, reasonix v1.25.2\n', ['reasonix'], '1.25.2');
reads('the oclif name/version shape names the product',
  'cline/3.0.60 linux-x64 node-v22.11.0\n', ['cline'], '3.0.60');
reads('a path ENDING in a version is still a path, not the oclif shape',
  'using /usr/lib/node_modules/cline/3.0.60\n3.1.0\n', ['cline'], '3.1.0');
reads('an inline update notice does not hide the version beside the product',
  'cline 3.0.60 (update available: 3.1.0)\n', ['cline'], '3.0.60');
reads('a channel word does not eat the version',
  'grok 1.0.13 (5e9a58528b76) [latest]\n', ['grok'], '1.0.13');
reads('a hyphenated product name still names the product',
  'kilo-code 7.4.23\n', ['kilo', 'kilocode'], '7.4.23');
reads('a product name that merely appears on the line does not answer',
  'resolved cline from PATH; runtime v0.9.1\n', ['cline'], undefined);

// ── Disagreement and absence both fail closed ───────────────────────────────
reads('two product lines that disagree answer nothing',
  'cline 3.0.60\ncline 3.1.0\n', ['cline'], undefined);
reads('two bare lines that disagree answer nothing', '3.0.60\n3.1.0\n', ['cline'], undefined);
reads('the same version stated twice is not a disagreement',
  'cline 3.0.60\ncline/3.0.60 linux-x64\n', ['cline'], '3.0.60');
reads('empty output answers nothing', '', ['cline'], undefined);
reads('output with no version answers nothing', 'command not found\n', ['cline'], undefined);
reads('a version with no product and no bare line answers nothing',
  'built 3.0.60 at some point\n', ['cline'], undefined);

// ── Shapes that must keep working ───────────────────────────────────────────
reads('CRLF is stripped like LF', '3.0.60\r\n', ['cline'], '3.0.60');
reads('a bare v-prefixed line answers', 'v1.25.2\n', ['reasonix'], '1.25.2');
reads('a prerelease is carried through', 'reasonix v1.25.2-rc.1\n', ['reasonix'], '1.25.2-rc.1');
reads('a trailing sentence period is punctuation, not part of the version',
  'reasonix v1.25.2.\n', ['reasonix'], '1.25.2');
reads('leading and trailing blank lines are ignored', '\n\n3.0.60\n\n', ['cline'], '3.0.60');

// ── The floor derived from a measured-version list ──────────────────────────
//
// Adapters used `MEASURED_VERSIONS[0]`, which made the floor depend on list
// ORDER: appending is safe, but PREPENDING a newer build -- the natural
// "newest first" habit -- silently raised the floor and stranded the older
// build the evidence still covers.
function floors(name: string, versions: readonly string[], expected: string): void {
  check(name, lowestSemanticVersion(versions) === expected,
    `[${versions.join(', ')}] -> ${lowestSemanticVersion(versions)} (want ${expected})`);
}

floors('a single measured version is its own floor', ['7.4.23'], '7.4.23');
floors('oldest-first gives the oldest', ['3.0.60', '3.0.61'], '3.0.60');
floors('newest-first gives the oldest too, so order cannot move the floor',
  ['3.0.61', '3.0.60'], '3.0.60');
floors('ordering is semantic, not lexicographic', ['1.0.9', '1.0.24'], '1.0.9');
floors('a major bump does not confuse the floor', ['2.0.0', '1.9.9'], '1.9.9');
floors('a prerelease sorts below its own release', ['1.0.13', '1.0.13-rc.1'], '1.0.13-rc.1');
floors('an unparsable entry is ignored rather than treated as lowest',
  ['3.0.60', 'nightly'], '3.0.60');
// Position must not matter. Seeding the reduce with `versions[0]` meant an
// unparsable HEAD could never be displaced, so the floor became a value no
// version compares against -- which disables the gate instead of tightening it.
floors('an unparsable entry is ignored at the HEAD too, not just later',
  ['nightly', '3.0.60'], '3.0.60');
floors('an unparsable head does not survive a longer list',
  ['nightly', '3.0.61', '3.0.60'], '3.0.60');
floors('an all-unparsable list falls back to the first entry rather than throwing',
  ['nightly', 'bogus'], 'nightly');
check('an empty list is a programming error, not a silently absent floor',
  (() => { try { lowestSemanticVersion([]); return false; } catch { return true; } })());

console.log(`\n${failures === 0 ? '✅' : '❌'} ${total - failures}/${total} reported-product-version checks passed.`);
if (failures > 0) process.exit(1);
