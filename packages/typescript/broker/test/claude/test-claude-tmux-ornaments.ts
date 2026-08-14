import { strict as assert } from 'node:assert';
import { classifyClaudeTmuxOrnaments } from '../../../../../scripts/broker/tests_traces/claude-tmux-ornaments-trace.ts';

let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${name} - ${err instanceof Error ? err.message : String(err)}`);
  }
}

const fixture = `
│ ⧉ Selected 12 lines from apps/poc-ui/public/app.js in Visual Studio Code
│ Found 29 new diagnostic issues (ctrl+o to expand)
│ Thought for 10s (ctrl+o to expand)
│ ※ recap: We need keep the transport boundary honest.
│ Crunched for 4m 12s (esc to interrupt)
│ Trace checklist:
│  ☒ inspect native transcript
│  ☐ compare app DOM
│ TodoWrite
│  ☐ Investigate tmux ornaments
│  ◐ Classify diagnostics
│  ☒ Record trace artifact
`;

await test('classifier identifies every ST-31 target ornament with explicit disposition', () => {
  const rows = classifyClaudeTmuxOrnaments(fixture);
  const byKind = new Map(rows.map((row) => [row.kind, row]));
  for (const kind of ['selected-editor-lines', 'diagnostics-summary', 'thought-timer', 'recap', 'crunched-timer', 'trace-checklist'] as const) {
    assert.ok(byKind.has(kind), `missing ${kind}`);
    assert.match(byKind.get(kind)!.disposition, /canonical-rendered|should-map|tui-only|status-or-tui-only/);
    assert.ok(byKind.get(kind)!.reason.length > 8, `${kind} needs a reason`);
  }
});

await test('classifier keeps TodoWrite/task list separate from chrome ornaments', () => {
  const rows = classifyClaudeTmuxOrnaments(fixture);
  const task = rows.find((row) => row.kind === 'task-list');
  assert.equal(task?.disposition, 'canonical-rendered');
  assert.match(task?.reason || '', /task-list-state/);
});

await test('classifier records absent ornaments instead of padding pass counts', () => {
  const rows = classifyClaudeTmuxOrnaments('plain assistant output only');
  assert.ok(rows.length >= 6);
  assert.ok(rows.every((row) => row.observed === false));
  assert.ok(rows.every((row) => row.disposition === 'not-observed'));
});

if (failed) {
  console.error(`\nFAIL: ${failed} Claude tmux ornament test(s) failed.`);
  process.exit(1);
}

console.log('\nPASS Claude tmux ornament tests');
