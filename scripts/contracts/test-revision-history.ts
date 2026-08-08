#!/usr/bin/env bun
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  validateContractRevisionHistory,
  type ContractRevisionRecord,
} from './check-revision-history.ts';

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, ...(detail ? { detail } : {}) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const revision5: ContractRevisionRecord = {
  revision: 5,
  surfaceHash: 'fnv1a32:5c84fbb8',
  minimumClientRevision: 0,
  clientMinimumBrokerRevision: 2,
  change: 'revision five',
};
const revision6: ContractRevisionRecord = {
  revision: 6,
  surfaceHash: 'fnv1a32:095fc995',
  minimumClientRevision: 0,
  clientMinimumBrokerRevision: 2,
  change: 'revision six',
};
const registry = (revisions: ContractRevisionRecord[]) => ({
  schemaVersion: 1,
  product: 'cosyncing',
  revisions,
});
const current = (record: ContractRevisionRecord) => ({
  revision: record.revision,
  surfaceHash: record.surfaceHash,
  minimumClientRevision: record.minimumClientRevision,
  clientMinimumBrokerRevision: record.clientMinimumBrokerRevision,
});

function rejects(name: string, task: () => void, pattern: RegExp): void {
  try {
    task();
    check(name, false, 'accepted invalid history');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, pattern.test(message), message);
  }
}

validateContractRevisionHistory({
  current: current(revision6),
  registry: registry([revision5, revision6]),
  baseRegistry: registry([revision5, revision6]),
});
check('unchanged published identity passes', true);

rejects(
  'a surface mutation without a revision bump fails',
  () => validateContractRevisionHistory({
    current: { ...current(revision6), surfaceHash: 'fnv1a32:11111111' },
    registry: registry([revision5, revision6]),
  }),
  /does not match source/,
);

rejects(
  'regenerating only current artifacts cannot satisfy the gate',
  () => validateContractRevisionHistory({
    current: { ...current(revision6), surfaceHash: 'fnv1a32:11111111' },
    registry: registry([
      revision5,
      { ...revision6, surfaceHash: 'fnv1a32:11111111' },
    ]),
    baseRegistry: registry([revision5, revision6]),
  }),
  /was rebound/,
);

const revision7: ContractRevisionRecord = {
  revision: 7,
  surfaceHash: 'fnv1a32:11111111',
  minimumClientRevision: 0,
  clientMinimumBrokerRevision: 2,
  change: 'next public contract',
};
validateContractRevisionHistory({
  current: current(revision7),
  registry: registry([revision5, revision6, revision7]),
  baseRegistry: registry([revision5, revision6]),
});
check('one appended revision passes and preserves prior identities', true);

rejects(
  'a revision jump fails',
  () => validateContractRevisionHistory({
    current: { ...current(revision7), revision: 8 },
    registry: registry([revision5, revision6, { ...revision7, revision: 8 }]),
  }),
  /consecutive/,
);

rejects(
  'a published historical revision cannot be rebound',
  () => validateContractRevisionHistory({
    current: current(revision6),
    registry: registry([
      { ...revision5, surfaceHash: 'fnv1a32:22222222' },
      revision6,
    ]),
    baseRegistry: registry([revision5, revision6]),
  }),
  /was rebound/,
);

rejects(
  'minimum compatibility changes require explicit evidence',
  () => validateContractRevisionHistory({
    current: {
      ...current(revision7),
      minimumClientRevision: 1,
    },
    registry: registry([
      revision5,
      revision6,
      { ...revision7, minimumClientRevision: 1 },
    ]),
  }),
  /compatibilityChange/,
);

function run(command: string[], cwd: string): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(command, {
    cwd,
    env: process.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

const gitFixture = mkdtempSync(join(tmpdir(), 'cosyncing-contract-history-'));
try {
  for (const command of [
    ['git', 'init', '--quiet'],
    ['git', 'config', 'user.name', 'Release verification fixture'],
    ['git', 'config', 'user.email', 'contract-fixture@example.invalid'],
  ]) {
    const result = run(command, gitFixture);
    if (!result.success) {
      throw new Error(result.stderr.toString().trim() || command.join(' '));
    }
  }
  writeFileSync(join(gitFixture, 'pre-registry.txt'), 'before registry\n');
  for (const command of [
    ['git', 'add', 'pre-registry.txt'],
    ['git', 'commit', '--quiet', '-m', 'pre-registry'],
  ]) {
    const result = run(command, gitFixture);
    if (!result.success) {
      throw new Error(result.stderr.toString().trim() || command.join(' '));
    }
  }
  const script = resolve(import.meta.dir, 'check-revision-history.ts');
  const registryPath = resolve('contracts/contract-revisions.json');
  const preRegistry = run([
    'bun',
    script,
    '--registry',
    registryPath,
    '--base-ref',
    'HEAD',
  ], gitFixture);
  check(
    'a resolved commit from before the registry existed passes',
    preRegistry.success,
    preRegistry.stderr.toString().trim(),
  );

  const missingBase = run([
    'bun',
    script,
    '--registry',
    registryPath,
    '--base-ref',
    'refs/heads/definitely-missing-contract-base',
  ], gitFixture);
  check(
    'an unresolved or shallow base ref fails closed',
    !missingBase.success
      && /does not resolve to a commit/.test(missingBase.stderr.toString()),
    missingBase.stderr.toString().trim(),
  );
} finally {
  rmSync(gitFixture, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`${failed.length} contract revision history test(s) failed`);
  process.exit(1);
}
console.log(`${results.length} contract revision history checks passed.`);
