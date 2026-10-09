/**
 * The Claude transcript type audit, tested against a fixture instead of a home directory.
 *
 * The audit itself reads whatever real transcripts exist on the machine, which is the point of it
 * and the reason it cannot be a CI assertion — a build machine has no transcripts, and a developer
 * machine's change without anyone deciding anything. So the tested contract is the script's own:
 * what it counts, what it calls unknown, and that it writes what it claims to write. The fixture
 * is two transcripts with a torn trailing line, a non-JSON line, a duplicate type and one line
 * whose type no build has ever written, which is what real transcripts actually look like -- plus
 * the sibling tree a Task subagent writes, `<uuid>/subagents/agent-*.jsonl` and the nested
 * `subagents/workflows/<run>/agent-*.jsonl`, which the first version of the audit never read.
 *
 *   bun run scripts/adapters/test-audit-claude-jsonl-types.ts
 */
export {};
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const ROOT = mkdtempSync(join(tmpdir(), 'claude-jsonl-audit-'));
// The root the script is pointed at is the projects root; transcripts live one level down, in the
// per-cwd slug directory. Getting that shape wrong is the one way this fixture could pass while
// reading nothing, so it is spelled out rather than derived.
const projects = join(ROOT, 'projects');
const slugDir = join(projects, '-fixture-workspace');
const out = join(ROOT, 'out');
mkdirSync(slugDir, { recursive: true });

const line = (row: Record<string, unknown>): string => JSON.stringify(row);
writeFileSync(join(slugDir, 'a.jsonl'), [
  line({ type: 'user', uuid: 'u1', version: '2.1.289', message: { role: 'user', content: 'hi' } }),
  line({ type: 'atis-latch', version: '2.1.289', value: 1 }),
  line({ type: 'atis-latch', version: '2.1.289', value: 2 }),
  line({ type: 'mode', mode: 'default' }),
  '{"type":"assistant","unclose', // a torn trailing line, which a live transcript has
].join('\n') + '\n');
writeFileSync(join(slugDir, 'b.jsonl'), [
  line({ type: 'assistant', uuid: 'a1', version: '2.1.288', message: { role: 'assistant', content: [] } }),
  line({ type: 'worktree-state', version: '2.1.288' }),
  // A type no build has written and no list names. This is the only thing in the fixture that may
  // be reported undocumented: every other type here is one the audit has already seen, and those
  // are on the adapter's known list by decision, so they must stay silent.
  line({ type: 'synthetic-line-from-a-future-build', version: '2.1.288' }),
  'not json at all',
].join('\n') + '\n');
writeFileSync(join(slugDir, 'notes.txt'), 'ignored, not a transcript');
// A subagent's transcript, in the directory named after its parent session beside the parent's own
// transcript. `fork-context-ref` is written only here, so an audit that reads only `<slug>/*.jsonl`
// can never measure it. The nested workflow run carries a type nothing else in the fixture has, so
// reading that file is visible on its own. The `.meta.json` beside an agent transcript is not one.
const sessionDir = join(slugDir, '0f0e0d0c-0000-4000-8000-000000000001');
mkdirSync(join(sessionDir, 'subagents', 'workflows', 'run-1'), { recursive: true });
writeFileSync(join(sessionDir, 'subagents', 'agent-a1.jsonl'), [
  line({ type: 'fork-context-ref', version: '2.1.291', parentUuid: 'u1' }),
  line({ type: 'assistant', uuid: 'sa1', version: '2.1.291', message: { role: 'assistant', content: [] } }),
].join('\n') + '\n');
writeFileSync(join(sessionDir, 'subagents', 'agent-a1.meta.json'), JSON.stringify({ toolUseId: 'toolu_1', type: 'not-a-line-type' }));
writeFileSync(join(sessionDir, 'subagents', 'workflows', 'run-1', 'agent-w1.jsonl'),
  line({ type: 'synthetic-workflow-only-line', version: '2.1.291' }) + '\n');

const script = join(import.meta.dir, 'audit-claude-jsonl-types.ts');
const run = Bun.spawnSync([process.execPath, 'run', script, '--root', projects, '--out', out], {
  stdout: 'pipe',
  stderr: 'pipe',
});
const stdout = run.stdout.toString();
check('the audit exits clean', run.exitCode === 0, `${run.exitCode} ${run.stderr.toString().slice(0, 200)}`);
check('it read the two session transcripts and the two subagent ones', /read 4 transcripts \(2 subagent\)/.test(stdout), stdout.split('\n')[0]);
// user, assistant, mode, atis-latch, worktree-state and the synthetic future line from the session
// transcripts; fork-context-ref and the workflow-only line from the subagent ones. The repeated
// atis-latch is one type, the assistant row a subagent repeats is the same type, and the torn line
// is no type at all.
check('it counted the eight distinct types the fixture carries', /8 types/.test(stdout), stdout.split('\n')[0]);
check('it named the type nobody has seen', /undocumented: synthetic-line-from-a-future-build/.test(stdout), stdout);
check('it named the type only a nested workflow subagent carries', /undocumented: synthetic-workflow-only-line/.test(stdout), stdout);
check('and named only those two', (stdout.match(/undocumented: /g) ?? []).length === 2, stdout);
check('fork-context-ref from a subagent transcript is documented, not a surprise', !/undocumented: fork-context-ref/.test(stdout), stdout);
check('it did not call a known sidecar type unknown', !/undocumented: mode/.test(stdout), stdout);
// The 2026-10-05 rule: a type the audit has already found is on the known list and is skipped in
// silence. Before it, `atis-latch` -- which sits in a quarter of the corpus -- raised an
// "some session details are not shown" inbox item on every replay of an old transcript.
check('a sidecar the audit already found is documented now, not a surprise',
  !/undocumented: atis-latch/.test(stdout) && !/undocumented: worktree-state/.test(stdout), stdout);
check('it noted a documented type this fixture lacks', /documented but not seen here: pr-link/.test(stdout), stdout);

check('types.json exists', existsSync(join(out, 'types.json')));
const types = JSON.parse(readFileSync(join(out, 'types.json'), 'utf8')) as {
  files: number;
  types: { type: string; lines: number; files: number; documented: boolean; versions: string[] }[];
};
check('the torn line and the meta file were not counted', types.files === 4, String(types.files));
const forkRef = types.types.find((t) => t.type === 'fork-context-ref');
check('a type only a subagent transcript carries is counted', forkRef?.lines === 1 && forkRef?.files === 1, JSON.stringify(forkRef));
check('and it is marked documented', forkRef?.documented === true, JSON.stringify(forkRef?.documented));
const atis = types.types.find((t) => t.type === 'atis-latch');
check('both lines of a repeated type are counted', atis?.lines === 2, JSON.stringify(atis));
check('a type is attributed to the files it appeared in', atis?.files === 1, JSON.stringify(atis?.files));
check('and it is marked documented on the row the report writes', atis?.documented === true, JSON.stringify(atis?.documented));
const user = types.types.find((t) => t.type === 'user');
check('a mapped type is marked documented', user?.documented === true, JSON.stringify(user?.documented));

const unknown = JSON.parse(readFileSync(join(out, 'unknown.json'), 'utf8')) as { unknown: { type: string }[] };
check(
  'unknown.json holds exactly the types nobody has seen',
  unknown.unknown.map((u) => u.type).sort().join(',') === 'synthetic-line-from-a-future-build,synthetic-workflow-only-line',
  unknown.unknown.map((u) => u.type).join(','),
);
check('the human summary was written', existsSync(join(out, 'summary.md')));

// An empty root is the CI-machine case: the script must report honestly rather than crash.
const emptyOut = join(ROOT, 'empty-out');
const emptyRun = Bun.spawnSync([process.execPath, 'run', script, '--root', join(ROOT, 'nope'), '--out', emptyOut], {
  stdout: 'pipe',
  stderr: 'pipe',
});
check('an absent projects root is not a failure', emptyRun.exitCode === 0, `${emptyRun.exitCode} ${emptyRun.stderr.toString().slice(0, 160)}`);
check('and it says it read nothing', /read 0 transcripts/.test(emptyRun.stdout.toString()), emptyRun.stdout.toString().split('\n')[0]);

rmSync(ROOT, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
