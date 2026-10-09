/**
 * What top-level line types do real Claude transcripts actually carry?
 *
 * The adapter skips anything it does not recognise, which is the right failure mode and the wrong
 * way to find out that a Claude build started writing something the transcript should show. This
 * script is the finding-out: it reads the transcripts already on this machine, counts every
 * top-level `type`, and writes what it saw plus the version each one came from.
 *
 * "The transcripts" means both kinds Claude writes: a session's own `<slug>/<uuid>.jsonl`, and the
 * Task subagent transcripts in the sibling tree `<slug>/<uuid>/subagents/agent-*.jsonl` (including
 * the nested `subagents/workflows/<run>/agent-*.jsonl`). The adapter reads both, and the first
 * version of this audit read only the first, so a type that only subagents write --
 * `fork-context-ref` -- was never measured and raised an unknown-type event instead.
 *
 * It is a measurement and not a runtime feature. Nothing imports it. "Documented" means the
 * adapter's own `CLAUDE_KNOWN_LINE_TYPES`, imported rather than copied: a hand-copied list here
 * drifted within one session (it lost `cost-state`, which the adapter reads for the context
 * window) and reported a type the adapter knows as a surprise. The set stays a claim a person
 * has read; what must not be a second opinion is its spelling.
 *
 * Output: `output/claude-jsonl-types/{types.json,unknown.json,summary.md}`. Re-run after a Claude
 * upgrade; the value is in the diff against the previous run.
 *
 * Usage: bun run scripts/adapters/audit-claude-jsonl-types.ts [--root <projectsRoot>] [--out <dir>]
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { CLAUDE_KNOWN_LINE_TYPES } from '../../packages/typescript/adapters/claude/src/implementation.ts';

/**
 * What the adapter claims to know, read from the adapter itself. A copy of this list here went
 * stale the same session it was written in, so the audit asks the adapter instead of remembering.
 */
const DOCUMENTED_TYPES = [...CLAUDE_KNOWN_LINE_TYPES].sort();

interface TypeReport {
  type: string;
  lines: number;
  files: number;
  /** Every Claude build that wrote a line of this type, newest first. */
  versions: string[];
  /** One example, trimmed to what fits a reading of the shape. */
  example: string;
  documented: boolean;
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

// `--root` is the projects root verbatim; with no flag this is where the CLI actually keeps
// transcripts, honoring CLAUDE_CONFIG_DIR the way the binary does.
const projectsRoot = flag('root')
  ?? join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude'), 'projects');
const outDir = flag('out') ?? join('output', 'claude-jsonl-types');

const MAX_EXAMPLE = 600;

/** How deep a `subagents/` tree is walked: `workflows/<run>/` is two levels, and nothing measured goes deeper. */
const MAX_SUBAGENT_DEPTH = 3;

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Every `agent-*.jsonl` under a session's `subagents/` tree, nested workflow runs included. */
function subagentFiles(sessionDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_SUBAGENT_DEPTH) walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.startsWith('agent-') && entry.name.endsWith('.jsonl')) {
        out.push(full);
      }
    }
  };
  walk(join(sessionDir, 'subagents'), 0);
  return out;
}

function transcriptFiles(root: string): { main: string[]; subagent: string[] } {
  const main: string[] = [];
  const subagent: string[] = [];
  let slugs: string[];
  try {
    slugs = readdirSync(root);
  } catch {
    return { main, subagent };
  }
  for (const slug of slugs) {
    const dir = join(root, slug);
    if (!isDirectory(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (entry.endsWith('.jsonl')) main.push(full);
      else if (isDirectory(full)) subagent.push(...subagentFiles(full));
    }
  }
  return { main, subagent };
}

const counts = new Map<string, TypeReport>();
const found = transcriptFiles(projectsRoot);
const files = [...found.main, ...found.subagent];
let unreadable = 0;

for (const file of files) {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    unreadable += 1;
    continue;
  }
  const seenInFile = new Set<string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // a torn trailing line is normal in a live transcript
    }
    const type = typeof parsed?.type === 'string' ? parsed.type : '<none>';
    const version = typeof parsed?.version === 'string' ? parsed.version : 'unknown';
    let entry = counts.get(type);
    if (!entry) {
      entry = { type, lines: 0, files: 0, versions: [], example: '', documented: DOCUMENTED_TYPES.includes(type) };
      counts.set(type, entry);
    }
    entry.lines += 1;
    if (!seenInFile.has(type)) {
      seenInFile.add(type);
      entry.files += 1;
    }
    if (version !== 'unknown' && !entry.versions.includes(version)) entry.versions.push(version);
    if (!entry.example) entry.example = trimmed.slice(0, MAX_EXAMPLE);
  }
}

const report = [...counts.values()].sort((a, b) => b.lines - a.lines);
const unknown = report.filter((entry) => !entry.documented);
const missing = DOCUMENTED_TYPES.filter((type) => !counts.has(type));

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'types.json'), `${JSON.stringify({ projectsRoot, files: files.length, subagentFiles: found.subagent.length, unreadable, types: report }, null, 2)}\n`);
writeFileSync(join(outDir, 'unknown.json'), `${JSON.stringify({ projectsRoot, files: files.length, unknown, documentedButAbsent: missing }, null, 2)}\n`);

const lines = [
  `# Claude transcript type audit`,
  '',
  `- Projects root: \`${projectsRoot}\``,
  `- Transcripts read: ${files.length} (${found.subagent.length} subagent, ${unreadable} unreadable)`,
  `- Distinct top-level types: ${report.length}`,
  `- Not in the adapter's documented list: ${unknown.length}`,
  `- Documented but absent here: ${missing.length ? missing.join(', ') : 'none'}`,
  '',
  '| type | lines | files | builds | documented |',
  '| --- | --- | --- | --- | --- |',
  ...report.map((entry) => `| \`${entry.type}\` | ${entry.lines} | ${entry.files} | ${entry.versions.slice(-3).join(', ') || '—'} | ${entry.documented ? 'yes' : '**no**'} |`),
  '',
];
writeFileSync(join(outDir, 'summary.md'), `${lines.join('\n')}\n`);

// A path that escapes the projects root would mean this script read something it was not pointed
// at; say so rather than reporting a clean run.
for (const file of files) {
  const rel = relative(projectsRoot, file);
  if (rel.startsWith('..')) {
    console.error(`refusing: transcript outside the projects root: ${file}`);
    process.exit(1);
  }
}

console.log(`read ${files.length} transcripts (${found.subagent.length} subagent), ${report.length} types, ${unknown.length} undocumented`);
for (const entry of unknown) console.log(`  undocumented: ${entry.type} (${entry.lines} lines, ${entry.files} files)`);
for (const type of missing) console.log(`  documented but not seen here: ${type}`);
console.log(`wrote ${join(outDir, 'types.json')}, unknown.json, summary.md`);
