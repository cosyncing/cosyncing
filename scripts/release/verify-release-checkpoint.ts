#!/usr/bin/env bun
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { sourceFingerprint } from '../verification/verification-graph.ts';

const ROOT = resolve(import.meta.dir, '../..');
const OUTPUT = resolve(
  process.env.COSYNCING_RELEASE_CHECKPOINT_OUTPUT
    ?? join(ROOT, 'output', 'release-checkpoint'),
);
const CHECK_REPORT = resolve(
  process.env.COSYNCING_RELEASE_CHECKPOINT_CHECK_REPORT
    ?? join(ROOT, 'output', 'check', 'report.json'),
);
const MAX_BUFFER_BYTES = 64 << 20;

interface StepResult {
  id: string;
  command: string[];
  status: 'pass' | 'fail';
  exitCode: number;
  durationMs: number;
  log: string;
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

if (process.argv.length > 2) {
  console.error('Usage: bun run release:checkpoint');
  process.exit(2);
}
if (basename(OUTPUT) !== 'release-checkpoint') {
  fail('checkpoint output must end in release-checkpoint');
}

// An invalid invocation must never leave the previous run looking eligible.
// Remove the published checkpoint before reading its prerequisite evidence;
// subsequent work happens in a sibling staging directory and is promoted only
// after its report describes the final state.
rmSync(OUTPUT, { recursive: true, force: true });
if (!existsSync(CHECK_REPORT)) {
  fail('run bun run check successfully before the release checkpoint');
}

const check = JSON.parse(readFileSync(CHECK_REPORT, 'utf8')) as {
  status?: unknown;
  coverage?: { mode?: unknown; complete?: unknown };
  source?: {
    before?: { sha256?: unknown };
    after?: { sha256?: unknown };
    stable?: unknown;
  };
};
const sourceBefore = sourceFingerprint(ROOT);
if (
    check.status !== 'pass'
  || check.coverage?.mode !== 'complete'
  || check.coverage?.complete !== true
  || check.source?.stable !== true
  || check.source.before?.sha256 !== sourceBefore.sha256
  || check.source.after?.sha256 !== sourceBefore.sha256
) {
  fail(
    'the repository check is absent, partial, failed, source-unstable, or belongs to a different source fingerprint',
  );
}
if (!existsSync(join(ROOT, 'apps', 'client', 'build', 'web', 'index.html'))) {
  fail('the canonical web build from bun run check is missing');
}

mkdirSync(dirname(OUTPUT), { recursive: true });
const WORK_OUTPUT = mkdtempSync(join(dirname(OUTPUT), '.release-checkpoint-'));
const LOGS = join(WORK_OUTPUT, 'logs');
const BROKER = join(WORK_OUTPUT, 'cosyncing-linux-x64');
let workPublished = false;
process.on('exit', () => {
  if (!workPublished) rmSync(WORK_OUTPUT, { recursive: true, force: true });
});

const version = (
  JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    version: string;
  }
).version;
const epochResult = Bun.spawnSync(['git', 'show', '-s', '--format=%ct', 'HEAD'], {
  cwd: ROOT,
  stdout: 'pipe',
  stderr: 'pipe',
});
if (!epochResult.success) fail(epochResult.stderr.toString().trim());
const buildDate = new Date(
  Number(epochResult.stdout.toString().trim()) * 1000,
).toISOString();

mkdirSync(LOGS, { recursive: true });
const steps: StepResult[] = [];

function publishOutput(): void {
  rmSync(OUTPUT, { recursive: true, force: true });
  renameSync(WORK_OUTPUT, OUTPUT);
  workPublished = true;
}

function run(id: string, command: string[]): void {
  const started = performance.now();
  const child = Bun.spawnSync(command, {
    cwd: ROOT,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30 * 60_000,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_BUFFER_BYTES,
  });
  const log = `logs/${id}.log`;
  writeFileSync(
    join(WORK_OUTPUT, log),
    [
      `$ ${command.join(' ')}`,
      '',
      '--- stdout ---',
      child.stdout.toString(),
      '',
      '--- stderr ---',
      child.stderr.toString(),
    ].join('\n'),
  );
  const result: StepResult = {
    id,
    command,
    status: child.success ? 'pass' : 'fail',
    exitCode: child.exitCode ?? 1,
    durationMs: Math.round(performance.now() - started),
    log,
  };
  steps.push(result);
  console.log(`${result.status.toUpperCase()} ${id}`);
  if (!child.success) {
    rmSync(BROKER, { force: true });
    writeReport('fail', `step ${id} failed`);
    publishOutput();
    process.exit(result.exitCode);
  }
}

function writeReport(
  status: 'pass' | 'fail',
  failure: string | null,
  sourceAfter = sourceFingerprint(ROOT),
): void {
  const reportSourceStable = sourceBefore.sha256 === sourceAfter.sha256;
  const artifacts = status === 'pass' ? ['cosyncing-linux-x64'] : [];
  const report = {
    schemaVersion: 1,
    kind: 'release-checkpoint',
    verificationInventory: 'scripts/verification/verification-graph.json',
    status,
    failure,
    source: {
      before: sourceBefore,
      after: sourceAfter,
      stable: reportSourceStable,
    },
    checkReport: 'output/check/report.json',
    publicationEligible:
      status === 'pass' && reportSourceStable && !sourceBefore.dirty,
    version,
    buildDate,
    generatedAt: new Date().toISOString(),
    exclusions: [
      'release publication and protected-channel promotion',
      'cross-platform packages',
      'physical-device, multi-host, and real-agent evidence',
    ],
    artifacts,
    steps,
  };
  writeFileSync(
    join(WORK_OUTPUT, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync(
    join(WORK_OUTPUT, 'report.md'),
    [
      '# Release checkpoint',
      '',
      `- Status: **${status.toUpperCase()}**`,
      `- Source fingerprint: \`${sourceBefore.sha256}\``,
      `- Source stable: ${report.source.stable}`,
      `- Publication eligible: ${report.publicationEligible}`,
      `- Version: \`${version}\``,
      `- Build date: ${buildDate}`,
      failure ? `- Failure: ${failure}` : '',
      '',
      '| Step | Status | Evidence |',
      '|---|---|---|',
      ...steps.map((step) =>
        `| \`${step.id}\` | ${step.status} | [log](${step.log}) |`
      ),
      '',
      '## Artifacts',
      '',
      ...artifacts.map((artifact) => `- \`${artifact}\``),
      '',
      'A dirty source fingerprint is reviewable but not publication eligible.',
      '',
    ].filter(Boolean).join('\n'),
  );
}

run('build-broker', [
  'bun',
  'run',
  'scripts/broker/build-broker.ts',
  '--target',
  'bun-linux-x64',
  '--outfile',
  BROKER,
  '--commit',
  sourceBefore.commit,
  '--build-date',
  buildDate,
  '--minify',
  '--no-alias',
]);
run('verify-candidate-pair', [
  'bun',
  'run',
  'release:verify-pair',
  '--',
  '--broker',
  BROKER,
  '--web-dir',
  'apps/client/build/web',
  '--commit',
  sourceBefore.commit,
  '--version',
  version,
  ...(sourceBefore.dirty
    ? ['--allow-dirty-web-review', 'true']
    : []),
]);

const sourceAfter = sourceFingerprint(ROOT);
if (sourceAfter.sha256 !== sourceBefore.sha256) {
  rmSync(BROKER, { force: true });
  writeReport('fail', 'source changed during the release checkpoint', sourceAfter);
  publishOutput();
  fail('source changed during the release checkpoint');
}
for (const artifact of [BROKER]) {
  if (!existsSync(artifact)) {
    writeReport('fail', `missing expected artifact ${artifact}`, sourceAfter);
    publishOutput();
    fail(`missing expected artifact ${artifact}`);
  }
}
writeReport('pass', null, sourceAfter);
publishOutput();
console.log(`PASS release checkpoint — ${join(OUTPUT, 'report.md')}`);
