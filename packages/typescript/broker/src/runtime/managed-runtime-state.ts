/** Broker persistence for adapter-owned managed runtime lifecycles. */
import { readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PRODUCT_IDENTITY, type SetupCheck, type SetupDiagnosisContext } from '@cosyncing/adapter-api';
import {
  configureManagedOpencodeServeState,
  OPENCODE_SERVE_OWNER_SCHEMA_VERSION,
  type OpencodeServeOwnership,
  type ProcessIdentity,
} from '@cosyncing/adapter-opencode';
import { redactTranscript } from '../security/r2-redactor.ts';
import { atomicWriteJsonOwnerOnly, inspectOwnerOnlyFile } from '../security/secure-files.ts';
import { setupStateHome } from '../installation/setup-state.ts';

export const MANAGED_RUNTIME_FAILURE_SCHEMA_VERSION = 1 as const;
export const MANAGED_RUNTIME_FAILURE_OUTPUT_LIMIT = 16 * 1024;
const MANAGED_RUNTIME_AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type ManagedRuntimeAgent = string;

export interface ManagedRuntimeFailure {
  detailCode: string;
  recordedAt: string;
  capturedOutput: string;
}

export interface ManagedRuntimeFailureJournal {
  schemaVersion: typeof MANAGED_RUNTIME_FAILURE_SCHEMA_VERSION;
  failures: Record<ManagedRuntimeAgent, ManagedRuntimeFailure | undefined>;
}

function emptyFailureJournal(): ManagedRuntimeFailureJournal {
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
  if (inspection.status === 'missing') return emptyFailureJournal();
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
  const failures: ManagedRuntimeFailureJournal['failures'] = {};
  for (const [agent, value] of Object.entries(record.failures as Record<string, unknown>)) {
    if (!MANAGED_RUNTIME_AGENT_ID.test(agent)) throw new Error('managed-runtime failure journal contains an invalid agent id');
    if (!validFailure(value)) throw new Error('managed-runtime failure journal contains a malformed entry');
    failures[agent] = value;
  }
  return { schemaVersion: MANAGED_RUNTIME_FAILURE_SCHEMA_VERSION, failures };
}

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
  if (!MANAGED_RUNTIME_AGENT_ID.test(options.agent)) throw new Error('invalid managed-runtime agent id');
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
  if (!MANAGED_RUNTIME_AGENT_ID.test(agent)) throw new Error('invalid managed-runtime agent id');
  const journal = readManagedRuntimeFailureJournal(home);
  if (!journal.failures[agent]) return;
  delete journal.failures[agent];
  atomicWriteJsonOwnerOnly(managedRuntimeFailurePath(home), journal);
}

/** Read broker-owned launch failures without exposing captured native output. */
export function diagnoseManagedRuntimeFailure(
  context: SetupDiagnosisContext,
  agent: string,
  displayName: string,
): SetupCheck {
  const stateRoot = context.env.COSYNCING_HOME?.trim()
    || `${context.homeDir}/${PRODUCT_IDENTITY.stateDirectoryName}`;
  const read = context.readText(`${stateRoot}/logs/managed-runtime-failures.json`, 128 * 1024);
  if (!read.ok && read.reason === 'missing') {
    return {
      id: `${agent}.managed-start-failure`, status: 'skip', detailCode: 'no-recorded-failure',
      summary: `No ${displayName} managed-start failure is recorded.`,
    };
  }
  if (!read.ok) {
    return {
      id: `${agent}.managed-start-failure`, status: 'fail', detailCode: 'failure-record-unreadable',
      summary: 'The managed-runtime failure record is unreadable.',
      remediation: { kind: 'command', message: 'Repair broker-owned diagnostic state.', command: 'cosyncing repair' },
    };
  }
  try {
    const parsed = JSON.parse(read.text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('malformed');
    const journal = parsed as Record<string, unknown>;
    if (journal.schemaVersion !== MANAGED_RUNTIME_FAILURE_SCHEMA_VERSION
        || !journal.failures || typeof journal.failures !== 'object' || Array.isArray(journal.failures)) {
      throw new Error('malformed');
    }
    const failures = journal.failures as Record<string, unknown>;
    const present = Object.prototype.hasOwnProperty.call(failures, agent);
    const failure = failures[agent];
    if (!present) {
      return {
        id: `${agent}.managed-start-failure`, status: 'skip', detailCode: 'no-recorded-failure',
        summary: `No ${displayName} managed-start failure is recorded.`,
      };
    }
    if (!validFailure(failure)) throw new Error('malformed');
    return {
      id: `${agent}.managed-start-failure`, status: 'fail', detailCode: failure.detailCode,
      summary: `The last managed ${displayName} start failed.`,
      evidence: { recordedAt: failure.recordedAt },
      remediation: { kind: 'command', message: 'Retry the managed runtime check and inspect the recorded failure.', command: 'cosyncing repair' },
    };
  } catch {
    return {
      id: `${agent}.managed-start-failure`, status: 'fail', detailCode: 'failure-record-malformed',
      summary: 'The managed-runtime failure record is malformed.',
      remediation: { kind: 'command', message: 'Repair broker-owned diagnostic state.', command: 'cosyncing repair' },
    };
  }
}

function opencodeServeOwnerPath(): string {
  return join(setupStateHome(), 'opencode-serve-owner.json');
}

/** Malformed state is unproven and can never authorize process disposal. */
function readOpencodeServeOwnership(): OpencodeServeOwnership | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(opencodeServeOwnerPath(), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    if (record.schemaVersion !== OPENCODE_SERVE_OWNER_SCHEMA_VERSION) return null;
    if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0) return null;
    if (typeof record.start !== 'string' || record.start.length === 0) return null;
    if (typeof record.comm !== 'string') return null;
    if (typeof record.baseUrl !== 'string' || record.baseUrl.length === 0) return null;
    if (typeof record.recordedAtMs !== 'number' || !Number.isFinite(record.recordedAtMs)) return null;
    return {
      schemaVersion: OPENCODE_SERVE_OWNER_SCHEMA_VERSION,
      pid: record.pid,
      start: record.start,
      comm: record.comm,
      baseUrl: record.baseUrl,
      recordedAtMs: record.recordedAtMs,
    };
  } catch {
    return null;
  }
}

function writeOpencodeServeOwnership(identity: ProcessIdentity, baseUrl: string): void {
  const record: OpencodeServeOwnership = {
    schemaVersion: OPENCODE_SERVE_OWNER_SCHEMA_VERSION,
    ...identity,
    baseUrl,
    recordedAtMs: Date.now(),
  };
  atomicWriteJsonOwnerOnly(opencodeServeOwnerPath(), record);
}

configureManagedOpencodeServeState({
  readOwnership: readOpencodeServeOwnership,
  writeOwnership: writeOpencodeServeOwnership,
  clearOwnership: () => rmSync(opencodeServeOwnerPath(), { force: true }),
  recordStartFailure: (detailCode, capturedOutput) => {
    recordManagedRuntimeFailure({ agent: 'opencode', detailCode, capturedOutput });
  },
  clearStartFailure: () => clearManagedRuntimeFailure('opencode'),
});
