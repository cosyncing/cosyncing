/**
 * Claude tmux-visible ornament classifier and opt-in trace.
 *
 * Default run is deterministic and exits SKIP. Set COSYNCING_CLAUDE_TMUX_ORNAMENTS=1 to launch a real Claude TUI in
 * tmux, capture the pane, classify visible chrome/ornaments, and write a trace artifact.
 *
 *   bun run scripts/broker/tests_traces/claude-tmux-ornaments-trace.ts
 *   COSYNCING_CLAUDE_TMUX_ORNAMENTS=1 bun run scripts/broker/tests_traces/claude-tmux-ornaments-trace.ts
 */
export interface OrnamentClassification {
  kind:
    | 'selected-editor-lines'
    | 'diagnostics-summary'
    | 'thought-timer'
    | 'recap'
    | 'crunched-timer'
    | 'trace-checklist'
    | 'task-list';
  observed: boolean;
  disposition: 'canonical-rendered' | 'should-map' | 'tui-only' | 'status-or-tui-only' | 'not-observed';
  evidence?: string;
  reason: string;
}

import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TARGETS: Array<Omit<OrnamentClassification, 'observed' | 'evidence'>> = [
  {
    kind: 'selected-editor-lines',
    disposition: 'tui-only',
    reason: 'IDE selection chrome is not generally persisted in Claude JSONL; keep as terminal-only unless an IDE-side protocol is adopted.',
  },
  {
    kind: 'diagnostics-summary',
    disposition: 'should-map',
    reason: 'Diagnostics may appear in assistant-message metadata or only in IDE/TUI chrome; map when structured data exists, otherwise document as TUI-only.',
  },
  {
    kind: 'thought-timer',
    disposition: 'tui-only',
    reason: 'Collapsed thinking duration is terminal chrome; structured thinking content is already the canonical product surface.',
  },
  {
    kind: 'recap',
    disposition: 'canonical-rendered',
    reason: 'Claude compact recap maps through the transcript as a compact summary/history-reset style surface.',
  },
  {
    kind: 'crunched-timer',
    disposition: 'status-or-tui-only',
    reason: 'Live elapsed/crunched timers are status chrome; product should prefer runtime/run-summary frames and avoid leaking timer text into assistant output.',
  },
  {
    kind: 'trace-checklist',
    disposition: 'should-map',
    reason: 'Checklist-looking output should map to task-list-state only when it comes from a real TodoWrite/task source; otherwise it remains normal model text or TUI-only trace chrome.',
  },
  {
    kind: 'task-list',
    disposition: 'canonical-rendered',
    reason: 'Claude TodoWrite content is represented by canonical task-list-state rather than raw TUI checklist chrome.',
  },
];

const PATTERNS: Record<OrnamentClassification['kind'], RegExp> = {
  'selected-editor-lines': /(?:⧉\s*)?Selected\s+\d+\s+lines?\s+from\s+.+?(?:Visual Studio Code|VS Code|editor)/i,
  'diagnostics-summary': /Found\s+\d+\s+new\s+diagnostic\s+issues?/i,
  'thought-timer': /Thought\s+for\s+\d+\s*(?:s|sec|secs|seconds|m|min)/i,
  recap: /※\s*recap:/i,
  'crunched-timer': /Crunched\s+for\s+\d+[^\n]*(?:esc to interrupt|interrupt)/i,
  'trace-checklist': /Trace checklist:|☐\s+compare app DOM|☒\s+inspect native transcript/i,
  'task-list': /TodoWrite|☐\s+Investigate tmux ornaments|◐\s+Classify diagnostics|☒\s+Record trace artifact/i,
};

export function classifyClaudeTmuxOrnaments(capture: string): OrnamentClassification[] {
  return TARGETS.map((target) => {
    const evidence = capture.match(PATTERNS[target.kind])?.[0]?.trim();
    return {
      ...target,
      observed: !!evidence,
      ...(evidence ? { evidence } : {}),
      disposition: evidence ? target.disposition : 'not-observed',
      reason: evidence ? target.reason : `No ${target.kind} ornament was visible in this capture; do not count it as covered.`,
    };
  });
}

if (import.meta.main) {
  await main();
}

async function main(): Promise<void> {
  const short = randomBytes(3).toString('hex');
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(process.cwd(), 'output', 'traces', runId, 'claude-tmux-ornaments');
  const tracePath = join(outDir, 'trace.json');
  mkdirSync(outDir, { recursive: true });

  if (process.env.COSYNCING_CLAUDE_TMUX_ORNAMENTS !== '1') {
    const rows = classifyClaudeTmuxOrnaments('');
    writeFileSync(tracePath, JSON.stringify({ status: 'skip', reason: 'set COSYNCING_CLAUDE_TMUX_ORNAMENTS=1 to run real Claude tmux capture', classifications: rows }, null, 2));
    console.log(`SKIP Claude tmux ornaments trace - set COSYNCING_CLAUDE_TMUX_ORNAMENTS=1\ntrace: ${tracePath}`);
    return;
  }

  const session = `cosyncing-claude-ornaments-${short}`;
  const workspace = join(tmpdir(), `cosyncing-claude-ornaments-${short}`);
  mkdirSync(workspace, { recursive: true });
  const prompt = [
    'For a cosyncing tmux ornament trace, do a short safe response.',
    'If available, use TodoWrite with three items: inspect native transcript, compare app DOM, record trace artifact.',
    'Then briefly summarize with the words "trace checklist" and "recap".',
  ].join(' ');

  try {
    await cmd(['tmux', 'new-session', '-d', '-s', session, '-c', workspace, 'claude']);
    await sleep(2500);
    await cmd(['tmux', 'send-keys', '-t', session, prompt, 'C-m']);
    await sleep(15000);
    const capture = await cmd(['tmux', 'capture-pane', '-p', '-t', session, '-S', '-300']);
    const ansi = await cmd(['tmux', 'capture-pane', '-p', '-e', '-t', session, '-S', '-300']);
    const classifications = classifyClaudeTmuxOrnaments(capture);
    writeFileSync(join(outDir, 'tmux.txt'), capture);
    writeFileSync(join(outDir, 'tmux-ansi.txt'), ansi);
    writeFileSync(tracePath, JSON.stringify({ status: 'pass', session, workspace, classifications }, null, 2));
    const observed = classifications.filter((row) => row.observed).length;
    console.log(`PASS Claude tmux ornaments classified ${observed}/${classifications.length} observed targets\ntrace: ${tracePath}`);
  } catch (err) {
    writeFileSync(tracePath, JSON.stringify({ status: 'fail', error: String(err) }, null, 2));
    console.error(`FAIL Claude tmux ornaments trace - ${String(err)}\ntrace: ${tracePath}`);
    process.exit(1);
  } finally {
    await cmd(['tmux', 'kill-session', '-t', session]).catch(() => '');
  }
}

async function cmd(args: string[]): Promise<string> {
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${args.join(' ')} exited ${code}: ${stderr}`);
  return stdout;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
