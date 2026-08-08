import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { redactTranscript } from './r2-redactor.ts';
import { setupStateHome } from './setup-state.ts';
import {
  atomicWriteJsonOwnerOnly,
  inspectOwnerOnlyFile,
} from './secure-files.ts';

export const MANAGED_RUNTIME_FAILURE_SCHEMA_VERSION = 1 as const;
export const MANAGED_RUNTIME_FAILURE_OUTPUT_LIMIT = 16 * 1024;
const MANAGED_RUNTIME_FAILURE_AGENTS = new Set(['codex', 'opencode']);

export type ManagedRuntimeAgent = 'codex' | 'opencode';

export interface ManagedRuntimeFailure {
  detailCode: string;
  recordedAt: string;
  /** Bounded and fail-closed-redacted at write time. Never returned by doctor. */
  capturedOutput: string;
}

export interface ManagedRuntimeFailureJournal {
  schemaVersion: typeof MANAGED_RUNTIME_FAILURE_SCHEMA_VERSION;
  failures: Partial<Record<ManagedRuntimeAgent, ManagedRuntimeFailure>>;
}

function emptyJournal(): ManagedRuntimeFailureJournal {
  return { schemaVersion: MANAGED_RUNTIME_FAILURE_SCHEMA_VERSION, failures: {} };
}

export function managedRuntimeFailurePath(home = setupStateHome()): string {
  return join(home, 'logs', 'managed-runtime-failures.json');
}

function validFailure(value: unknown): value is ManagedRuntimeFailure {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.detailCode === 'string'
    && /^[a-z0-9][a-z0-9-]{0,79}$/.test(record.detailCode)
    && typeof record.recordedAt === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.recordedAt)
    && Number.isFinite(Date.parse(record.recordedAt))
    && typeof record.capturedOutput === 'string'
    && record.capturedOutput.length <= MANAGED_RUNTIME_FAILURE_OUTPUT_LIMIT;
}

export function readManagedRuntimeFailureJournal(home = setupStateHome()): ManagedRuntimeFailureJournal {
  const path = managedRuntimeFailurePath(home);
  const inspection = inspectOwnerOnlyFile(path);
  if (inspection.status === 'missing') return emptyJournal();
  if (inspection.status !== 'ok') throw new Error('managed-runtime failure journal is unsafe or unreadable');
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch {
    throw new Error('managed-runtime failure journal is malformed');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('managed-runtime failure journal is malformed');
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== MANAGED_RUNTIME_FAILURE_SCHEMA_VERSION
      || !record.failures || typeof record.failures !== 'object' || Array.isArray(record.failures)) {
    throw new Error('managed-runtime failure journal has an unsupported schema');
  }
  const rawFailures = record.failures as Record<string, unknown>;
  if (Object.keys(rawFailures).some((agent) => !MANAGED_RUNTIME_FAILURE_AGENTS.has(agent))) {
    throw new Error('managed-runtime failure journal contains an unknown agent');
  }
  const failures: ManagedRuntimeFailureJournal['failures'] = {};
  for (const agent of ['codex', 'opencode'] as const) {
    const value = rawFailures[agent];
    if (value === undefined) continue;
    if (!validFailure(value)) throw new Error('managed-runtime failure journal contains a malformed entry');
    failures[agent] = value;
  }
  return { schemaVersion: MANAGED_RUNTIME_FAILURE_SCHEMA_VERSION, failures };
}

/**
 * Keep enough native output to diagnose a silent launch failure, while applying the same fail-closed secret
 * redaction used for transcript exports. Undecodable or still-secret output is replaced, never persisted.
 */
export function sanitizeManagedRuntimeOutput(value: string): string {
  const bounded = String(value ?? '').slice(0, MANAGED_RUNTIME_FAILURE_OUTPUT_LIMIT);
  const redacted = redactTranscript(bounded, { homeDirs: [homedir()] });
  return redacted.ok ? redacted.text : '[captured output withheld because it could not be safely redacted]';
}

export function recordManagedRuntimeFailure(options: {
  agent: ManagedRuntimeAgent;
  detailCode: string;
  capturedOutput?: string;
  home?: string;
  now?: () => Date;
}): void {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(options.detailCode)) {
    throw new Error('invalid managed-runtime failure detail code');
  }
  const home = options.home ?? setupStateHome();
  const journal = readManagedRuntimeFailureJournal(home);
  journal.failures[options.agent] = {
    detailCode: options.detailCode,
    recordedAt: (options.now?.() ?? new Date()).toISOString(),
    capturedOutput: sanitizeManagedRuntimeOutput(options.capturedOutput ?? ''),
  };
  atomicWriteJsonOwnerOnly(managedRuntimeFailurePath(home), journal);
}

export function clearManagedRuntimeFailure(agent: ManagedRuntimeAgent, home = setupStateHome()): void {
  const journal = readManagedRuntimeFailureJournal(home);
  if (!journal.failures[agent]) return;
  delete journal.failures[agent];
  atomicWriteJsonOwnerOnly(managedRuntimeFailurePath(home), journal);
}
