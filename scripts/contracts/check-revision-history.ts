#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BROKER_CONTRACT,
  CLIENT_MINIMUM_BROKER_CONTRACT_REVISION,
} from '../../packages/typescript/protocol/src/index.ts';

export interface ContractRevisionRecord {
  revision: number;
  surfaceHash: string;
  minimumClientRevision: number;
  clientMinimumBrokerRevision: number;
  change: string;
  compatibilityChange?: string;
}

export interface ContractRevisionRegistry {
  schemaVersion: 1;
  product: 'cosyncing';
  revisions: ContractRevisionRecord[];
}

export interface CurrentContractIdentity {
  revision: number;
  surfaceHash: string;
  minimumClientRevision: number;
  clientMinimumBrokerRevision: number;
}

function fail(message: string): never {
  throw new Error(`contract revision history: ${message}`);
}

function safeRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseRegistry(value: unknown, label: string): ContractRevisionRegistry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} is not an object`);
  }
  const registry = value as Partial<ContractRevisionRegistry>;
  if (registry.schemaVersion !== 1 || registry.product !== 'cosyncing'
      || !Array.isArray(registry.revisions) || registry.revisions.length === 0) {
    fail(`${label} has an invalid header`);
  }
  for (const [index, raw] of registry.revisions.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      fail(`${label} revision ${index} is not an object`);
    }
    const record = raw as Partial<ContractRevisionRecord>;
    if (!safeRevision(record.revision)
        || typeof record.surfaceHash !== 'string'
        || !/^fnv1a32:[a-f0-9]{8}$/.test(record.surfaceHash)
        || !safeRevision(record.minimumClientRevision)
        || !safeRevision(record.clientMinimumBrokerRevision)
        || record.minimumClientRevision > record.revision
        || record.clientMinimumBrokerRevision > record.revision
        || typeof record.change !== 'string'
        || !record.change.trim()
        || (record.compatibilityChange !== undefined
          && (typeof record.compatibilityChange !== 'string'
            || !record.compatibilityChange.trim()))) {
      fail(`${label} revision record ${index} is invalid`);
    }
    if (index > 0) {
      const previous = registry.revisions[index - 1]!;
      if (record.revision !== previous.revision + 1) {
        fail(`${label} revisions must be consecutive`);
      }
      const minimumChanged =
        record.minimumClientRevision !== previous.minimumClientRevision
        || record.clientMinimumBrokerRevision
          !== previous.clientMinimumBrokerRevision;
      if (minimumChanged && !record.compatibilityChange?.trim()) {
        fail(
          `${label} revision ${record.revision} changes a minimum-supported `
          + 'revision without compatibilityChange evidence',
        );
      }
    }
  }
  return registry as ContractRevisionRegistry;
}

function canonicalRecord(record: ContractRevisionRecord): string {
  return JSON.stringify(record);
}

export function validateContractRevisionHistory(options: {
  current: CurrentContractIdentity;
  registry: unknown;
  baseRegistry?: unknown;
}): ContractRevisionRegistry {
  const registry = parseRegistry(options.registry, 'current registry');
  const latest = registry.revisions.at(-1)!;
  const current = options.current;
  if (latest.revision !== current.revision
      || latest.surfaceHash !== current.surfaceHash
      || latest.minimumClientRevision !== current.minimumClientRevision
      || latest.clientMinimumBrokerRevision
        !== current.clientMinimumBrokerRevision) {
    fail(
      `published revision ${latest.revision}/${latest.surfaceHash} does not `
      + `match source ${current.revision}/${current.surfaceHash}`,
    );
  }

  if (options.baseRegistry !== undefined) {
    const base = parseRegistry(options.baseRegistry, 'base registry');
    if (registry.revisions.length < base.revisions.length) {
      fail('current registry deletes published revisions');
    }
    for (const [index, published] of base.revisions.entries()) {
      const candidate = registry.revisions[index];
      if (!candidate || canonicalRecord(candidate) !== canonicalRecord(published)) {
        fail(`published revision ${published.revision} was rebound or reordered`);
      }
    }
  }
  return registry;
}

function gitOutput(args: string[]): { success: boolean; stdout: string } {
  const result = Bun.spawnSync(['git', ...args], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  return { success: result.success, stdout: result.stdout.toString() };
}

function defaultBaseRef(): string | undefined {
  const githubBase = process.env.GITHUB_BASE_REF?.trim();
  if (githubBase) return `origin/${githubBase}`;
  return gitOutput(['rev-parse', '--verify', 'HEAD^']).success ? 'HEAD^' : undefined;
}

function baseRegistryAt(ref: string | undefined): unknown | undefined {
  if (!ref) return undefined;
  const resolved = gitOutput(['rev-parse', '--verify', `${ref}^{commit}`]);
  if (!resolved.success || !resolved.stdout.trim()) {
    fail(`base ref ${JSON.stringify(ref)} does not resolve to a commit`);
  }
  const result = gitOutput([
    'show',
    `${ref}:contracts/contract-revisions.json`,
  ]);
  // A resolved commit from before the registry existed is the one legitimate
  // no-base-registry case. An unresolved/shallow ref was rejected above.
  if (!result.success) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`base ref ${JSON.stringify(ref)} contains malformed contract history`);
  }
}

function parseArgs(argv: string[]): { registryPath: string; baseRef?: string; noBase: boolean } {
  let registryPath = resolve('contracts/contract-revisions.json');
  let baseRef: string | undefined;
  let noBase = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--registry') {
      const value = argv[++index];
      if (!value) fail('--registry requires a path');
      registryPath = resolve(value);
    } else if (arg === '--base-ref') {
      const value = argv[++index];
      if (!value) fail('--base-ref requires a Git ref');
      baseRef = value;
    } else if (arg === '--no-base') {
      noBase = true;
    } else {
      fail(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return { registryPath, ...(baseRef ? { baseRef } : {}), noBase };
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const baseRef = args.noBase ? undefined : args.baseRef ?? defaultBaseRef();
    const registry = JSON.parse(readFileSync(args.registryPath, 'utf8'));
    const baseRegistry = baseRegistryAt(baseRef);
    const checked = validateContractRevisionHistory({
      current: {
        ...BROKER_CONTRACT,
        clientMinimumBrokerRevision:
          CLIENT_MINIMUM_BROKER_CONTRACT_REVISION,
      },
      registry,
      ...(baseRegistry !== undefined ? { baseRegistry } : {}),
    });
    const latest = checked.revisions.at(-1)!;
    console.log(
      `PASS: immutable contract revision ${latest.revision} `
      + `is ${latest.surfaceHash}${baseRef ? ` (base ${baseRef})` : ''}.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
