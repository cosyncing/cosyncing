#!/usr/bin/env bun

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

type JsonObject = Record<string, any>;

const repositoryRoot = resolve(import.meta.dir, '../../..');
const argumentsByName = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!name?.startsWith('--') || !value) throw new Error('Arguments must be --name value pairs.');
  argumentsByName.set(name.slice(2), value);
}

const runId = argumentsByName.get('run-id');
if (!runId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(runId)) {
  throw new Error('--run-id must be a safe Phase 0 run identifier.');
}
const outputRoot = resolve(repositoryRoot, argumentsByName.get('output-root') ?? 'output/windows-broker');
const outputPath = resolve(repositoryRoot, argumentsByName.get('output') ?? 'output/windows-broker/spike-report.json');
const verificationPath = resolve(
  repositoryRoot,
  argumentsByName.get('verification') ?? `output/windows-broker/verification-${runId}.json`,
);

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, 'utf8')) as JsonObject;
}

const evidencePaths = {
  host: resolve(outputRoot, `host-probe-${runId}.json`),
  runtime: resolve(outputRoot, `runtime-probe-${runId}.json`),
  behavior: resolve(outputRoot, `behavior-probe-${runId}.json`),
  scheduler: resolve(outputRoot, `scheduler-probe-${runId}.json`),
  verification: verificationPath,
};
const evidence = Object.fromEntries(
  Object.entries(evidencePaths).map(([name, path]) => [name, readJson(path)]),
) as Record<keyof typeof evidencePaths, JsonObject>;

const failures: string[] = [];
const requireEvidence = (condition: unknown, message: string): void => {
  if (!condition) failures.push(message);
};
const revision = evidence.host.candidate?.revision;
requireEvidence(typeof revision === 'string' && revision.length === 40, 'host candidate revision is not exact');
requireEvidence(evidence.host.candidate?.dirty === false, 'host candidate was dirty');
requireEvidence(evidence.host.candidate?.archiveMode === 'clean-commit', 'candidate was not archived from a clean commit');

for (const lane of ['bunFloor', 'bunCurrent'] as const) {
  const bundle = evidence.runtime.brokerBundle?.[lane];
  requireEvidence(bundle?.exitCode === 0 && bundle?.validJson === true, `${lane} did not execute the bundle`);
  requireEvidence(bundle?.commit === revision && bundle?.dirty === false, `${lane} bundle identity does not match candidate`);
}
requireEvidence(
  evidence.runtime.brokerBundle?.doctor?.hostDiagnosticCode === 'native-windows-not-v1',
  'doctor did not capture the native Windows policy diagnostic',
);
for (const shim of ['cosyncingShimVersion', 'cosyShimVersion'] as const) {
  const result = evidence.runtime.npmPrefix?.[shim];
  requireEvidence(result?.exitCode === 0 && result?.validJson === true, `${shim} did not launch the bundle`);
  requireEvidence(result?.commit === revision && result?.dirty === false, `${shim} bundle identity does not match candidate`);
}
requireEvidence(evidence.scheduler.rollback?.taskRemoved === true, 'scheduler task rollback failed');
requireEvidence(evidence.scheduler.rollback?.childFolderRemoved === true, 'scheduler child-folder rollback failed');
requireEvidence(evidence.scheduler.rollback?.topFolderRemoved === true, 'scheduler top-folder rollback failed');
requireEvidence(evidence.verification.candidate?.revision === revision, 'verification used a different candidate revision');
requireEvidence(evidence.verification.candidate?.dirtyAtStart === false, 'verification started from a dirty candidate');
requireEvidence(evidence.verification.passed === true, 'repository verification did not pass');

const report = {
  schemaVersion: 2,
  generator: 'scripts/broker/windows/generate-phase0-report.ts',
  generatedAt: new Date().toISOString(),
  investigationDate: '2026-08-21',
  runId,
  status: failures.length === 0 ? 'phase0-checkpoint-verified' : 'phase0-evidence-invalid',
  productPolicy: 'native-windows-remains-disabled',
  candidate: evidence.host.candidate,
  bundle: evidence.runtime.brokerBundle.bunCurrent,
  host: evidence.host.host,
  filesystems: evidence.host.filesystems,
  toolchains: evidence.runtime.toolchains,
  brokerBundle: evidence.runtime.brokerBundle,
  npmPrefix: evidence.runtime.npmPrefix,
  environment: evidence.behavior.environment,
  invocation: evidence.behavior.invocation,
  filesystem: evidence.behavior.filesystem,
  process: evidence.behavior.process,
  scheduler: evidence.scheduler,
  nativeAgentAvailability: evidence.host.tooling?.agents,
  verification: evidence.verification,
  failures,
  explicitDeferrals: [
    'production Windows batch invocation primitive',
    'sleep/resume and logout/login task behavior',
    'visual console-window behavior',
    'second ordinary-user scheduler denial',
    'constrained-language and restrictive ExecutionPolicy mutation',
    'real agent installation, authentication, and adapter interface traces',
    'Windows ARM64 and Windows 10 support',
    'native directory-handle fsync',
  ],
  cleanup: {
    productionBrokerUntouched: true,
    normalCosyncingStateUntouched: true,
    disposableSchedulerHierarchyRemoved: evidence.scheduler.rollback,
    ntfsStagingPreservedForReview: true,
  },
  evidenceFiles: Object.values(evidencePaths).map((path) => basename(path)),
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Phase 0 aggregate report: ${outputPath}`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}
