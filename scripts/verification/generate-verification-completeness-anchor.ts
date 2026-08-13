#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  loadVerificationGraph,
  verificationBindingFingerprint,
} from './verification-graph.ts';

const ROOT = resolve(import.meta.dir, '../..');
const ACCEPTED_BASE_FLAG = '--accepted-base';
const acceptedBaseIndex = process.argv.indexOf(ACCEPTED_BASE_FLAG);
const acceptedBase = acceptedBaseIndex >= 0
  ? process.argv[acceptedBaseIndex + 1]
  : Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: ROOT }).stdout.toString().trim();

if (!acceptedBase || !/^[0-9a-f]{40}$/.test(acceptedBase)) {
  throw new Error(`Usage: ${ACCEPTED_BASE_FLAG} <40-character commit SHA>`);
}
const resolved = Bun.spawnSync(
  ['git', 'rev-parse', '--verify', `${acceptedBase}^{commit}`],
  { cwd: ROOT, stdout: 'ignore', stderr: 'pipe' },
);
if (!resolved.success) {
  throw new Error(`accepted base does not resolve: ${acceptedBase}`);
}

const graph = loadVerificationGraph(ROOT);
const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};
const packageScripts = packageJson.scripts ?? {};
const brokerGate = graph.gates.find((gate) => gate.id === 'broker-deterministic');
if (!brokerGate?.subSuites) {
  throw new Error('broker-deterministic declares no sub-suites');
}

const fingerprint = (
  binding: {
    command: string[];
    sourceOwners: string[];
    workingDirectory?: string;
    claimIds: string[];
    requirement?: 'required' | 'advisory';
    advisoryBaseline?: string;
    expectedArtifacts?: Array<{
      path: string;
      kind: 'log' | 'report' | 'directory' | 'artifact';
    }>;
  },
): string => verificationBindingFingerprint(binding, packageScripts);

const anchor = {
  schemaVersion: 4,
  acceptedBase,
  requiredClaimIds: graph.claims.map((claim) => claim.id).sort(),
  requiredGateBindings: graph.gates
    .map((gate) => ({
      id: gate.id,
      fingerprint: fingerprint({
        command: gate.command,
        sourceOwners: gate.sourceOwners,
        workingDirectory: gate.cwd,
        claimIds: gate.claimIds,
        requirement: gate.requirement ?? 'required',
        advisoryBaseline: gate.advisoryBaseline,
        expectedArtifacts: gate.expectedArtifacts,
      }),
    }))
    .sort((left, right) => left.id.localeCompare(right.id)),
  requiredBrokerSubSuiteBindings: brokerGate.subSuites
    .map((suite) => ({
      id: suite.id,
      fingerprint: fingerprint({
        command: suite.command,
        sourceOwners: suite.sourceOwners,
        claimIds: [suite.claimId],
      }),
    }))
    .sort((left, right) => left.id.localeCompare(right.id)),
};

const output = join(
  ROOT,
  'scripts',
  'verification',
  'verification-completeness-anchor.json',
);
writeFileSync(output, `${JSON.stringify(anchor, null, 2)}\n`);
console.log(
  `WROTE ${output}: ${anchor.requiredClaimIds.length} claims, `
    + `${anchor.requiredGateBindings.length} gates, `
    + `${anchor.requiredBrokerSubSuiteBindings.length} broker sub-suites`,
);
