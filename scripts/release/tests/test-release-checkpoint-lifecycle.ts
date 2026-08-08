#!/usr/bin/env bun
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../../..');
const fixture = mkdtempSync(join(tmpdir(), 'cosyncing-release-checkpoint-lifecycle-'));
let checks = 0;

function check(condition: unknown, message: string): void {
  checks += 1;
  if (!condition) throw new Error(message);
}

try {
  const output = join(fixture, 'release-checkpoint');
  const checkReport = join(fixture, 'partial-check.json');
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, 'report.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      kind: 'release-checkpoint',
      status: 'pass',
      publicationEligible: true,
    })}\n`,
  );
  writeFileSync(join(output, 'cosyncing-linux-x64'), 'stale publishable artifact\n');
  writeFileSync(
    checkReport,
    `${JSON.stringify({
      status: 'pass',
      coverage: { mode: 'changed', complete: false },
      source: { stable: true, before: {}, after: {} },
    })}\n`,
  );

  const rejected = Bun.spawnSync(
    ['bun', 'run', 'scripts/release/verify-release-checkpoint.ts'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        COSYNCING_RELEASE_CHECKPOINT_OUTPUT: output,
        COSYNCING_RELEASE_CHECKPOINT_CHECK_REPORT: checkReport,
      },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 20_000,
      killSignal: 'SIGKILL',
    },
  );
  check(
    rejected.exitCode === 1
      && rejected.stderr.toString().includes('absent, partial, failed'),
    'partial check evidence must reject the checkpoint before any build',
  );
  check(
    !existsSync(output),
    'rejection must invalidate the old eligible report and binary',
  );
  check(
    readdirSync(fixture).every((name) => !name.startsWith('.release-checkpoint-')),
    'rejection must leave no staging checkpoint behind',
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log(`PASS ${checks}/${checks} release-checkpoint lifecycle checks`);
