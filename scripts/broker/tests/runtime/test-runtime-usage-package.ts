/**
 * Package-level runtime/timestamp/usage gate.
 *
 * Mapper tests are necessary but not sufficient for this feature. This suite runs the user-visible web
 * checks plus the zero-model adapter/broker traces that prove `sentAt`, `run-summary`,
 * `runtimeTotals`, and usage text survive through the full package.
 *
 *   bun run scripts/broker/tests/runtime/test-runtime-usage-package.ts
 */
export {};
import { dirname } from 'node:path';

type Step = {
  name: string;
  cmd: string[];
};

const bun = process.execPath;
const bunDir = dirname(bun);
const env = {
  ...process.env,
  PATH: `${bunDir}:${process.env.PATH ?? ''}`,
};

const steps: Step[] = [
  {
    name: 'web static runtime/statusline guards',
    cmd: [bun, 'run', 'scripts/broker/tests/app/test-web-ui-static.ts'],
  },
  {
    name: 'web component runtime finished-at and usage rendering',
    cmd: [bun, 'run', 'scripts/broker/tests/app/test-web-ui-components.ts'],
  },
  {
    name: 'Claude runtime mapper + Observe idle/working finalization',
    cmd: [bun, 'run', 'scripts/broker/tests/claude/test-claude-runtime.ts'],
  },
  {
    name: 'Claude broker Observe runtime trace',
    cmd: [bun, 'run', 'scripts/broker/tests_traces/claude-runtime-trace.ts'],
  },
  {
    name: 'Codex rollout runtime mapping',
    cmd: [bun, 'run', 'scripts/broker/tests/codex/rollout.ts'],
  },
  {
    name: 'Codex app-server runtime mapping',
    cmd: [bun, 'run', 'scripts/broker/tests/codex/resume-fake.ts'],
  },
  {
    name: 'Pi observe runtime mapping',
    cmd: [bun, 'run', 'scripts/broker/tests/pi/test-pi-observe.ts'],
  },
  {
    name: 'Pi bridge runtime wire',
    cmd: [bun, 'run', 'scripts/broker/tests/pi/test-tool-result-enrich.ts'],
  },
  {
    name: 'OpenCode private Observe/Drive runtime mapping',
    cmd: [bun, 'run', 'scripts/broker/tests/opencode/test-opencode-private.ts'],
  },
];

let failed = 0;
for (const step of steps) {
  console.log(`\n── ${step.name} ──`);
  const p = Bun.spawnSync(step.cmd, {
    cwd: process.cwd(),
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = p.stdout.toString();
  const stderr = p.stderr.toString();
  if (stdout.trim()) process.stdout.write(stdout.endsWith('\n') ? stdout : stdout + '\n');
  if (stderr.trim()) process.stderr.write(stderr.endsWith('\n') ? stderr : stderr + '\n');
  if (p.exitCode !== 0) {
    failed++;
    console.error(`FAIL ${step.name} exited ${p.exitCode}`);
  } else {
    console.log(`PASS ${step.name}`);
  }
}

if (failed) {
  console.error(`\nFAIL: ${failed}/${steps.length} runtime/usage package gate(s) failed.`);
  process.exit(1);
}

console.log(`\nPASS: ${steps.length}/${steps.length} runtime/usage package gates passed.`);
