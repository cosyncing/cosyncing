import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJsonOwnerOnly, inspectOwnerOnlyFile } from '../security/secure-files.ts';

export type UpgradePhase = 'recovering' | 'preparing' | 'stopping-service' | 'switching-binary'
  | 'activating-service' | 'starting-service' | 'verifying-broker' | 'verifying-web' | 'committing';

export interface UpgradeHealthCheck {
  ok: boolean;
  endpoint: '/api/health' | '/cosy/version.json';
  expectedVersion: string;
  observedVersion?: string;
  statusCode?: number;
  /** Transport failures can retry even when response headers supplied a status. */
  retryable?: boolean;
  detail: string;
}

/** Kept outside the transaction so a clean rollback cannot erase the cause. */
export interface UpgradeFailureDiagnostic {
  schemaVersion: 1;
  recordedAt: string;
  fromVersion: string;
  toVersion?: string;
  phase: UpgradePhase;
  code: string;
  detail: string;
  health?: UpgradeHealthCheck;
  rollback: 'complete' | 'incomplete' | 'pending' | 'not-needed';
  rollbackDetail?: string;
}

const PHASES: readonly string[] = ['recovering', 'preparing', 'stopping-service', 'switching-binary',
  'activating-service', 'starting-service', 'verifying-broker', 'verifying-web', 'committing'];

/** Bound terminal text and remove credential-bearing URL parts and common credential assignments. */
export function upgradeFailureDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/https?:\/\/[^\s<>"']+/gi, (text) => {
      try {
        const url = new URL(text);
        url.username = ''; url.password = ''; url.search = ''; url.hash = '';
        return url.toString();
      } catch { return '[url]'; }
    })
    .replace(/\b(Bearer)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(/\b((?:[a-z_-]*token|password|secret|api[-_]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\s+/g, ' ').trim().slice(0, 1024) || 'No underlying error detail was reported.';
}

export function upgradeFailureDiagnosticPath(home: string): string {
  return join(home, 'logs', 'last-upgrade-failure.json');
}

export function readUpgradeFailureDiagnostic(home: string): UpgradeFailureDiagnostic | undefined {
  const path = upgradeFailureDiagnosticPath(home);
  if (inspectOwnerOnlyFile(path).status !== 'ok') return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as UpgradeFailureDiagnostic;
    if (value?.schemaVersion !== 1 || typeof value.recordedAt !== 'string'
        || !Number.isFinite(Date.parse(value.recordedAt)) || !PHASES.includes(value.phase)
        || typeof value.fromVersion !== 'string' || value.fromVersion.length > 128
        || value.toVersion !== undefined && (typeof value.toVersion !== 'string' || value.toVersion.length > 128)
        || typeof value.code !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(value.code)
        || typeof value.detail !== 'string' || value.detail.length > 1024
        || !['complete', 'incomplete', 'pending', 'not-needed'].includes(value.rollback)
        || value.rollbackDetail !== undefined && typeof value.rollbackDetail !== 'string') return undefined;
    const health = value.health;
    if (health && (!['/api/health', '/cosy/version.json'].includes(health.endpoint)
        || typeof health.ok !== 'boolean' || typeof health.expectedVersion !== 'string'
        || health.expectedVersion.length > 128 || typeof health.detail !== 'string'
        || health.retryable !== undefined && typeof health.retryable !== 'boolean'
        || health.observedVersion !== undefined && typeof health.observedVersion !== 'string'
        || health.statusCode !== undefined && (!Number.isInteger(health.statusCode) || health.statusCode < 100 || health.statusCode > 599))) return undefined;
    return { schemaVersion: 1, recordedAt: value.recordedAt,
      fromVersion: upgradeFailureDetail(value.fromVersion).slice(0, 128),
      ...(value.toVersion ? { toVersion: upgradeFailureDetail(value.toVersion).slice(0, 128) } : {}),
      phase: value.phase, code: value.code, detail: upgradeFailureDetail(value.detail), rollback: value.rollback,
      ...(value.rollbackDetail ? { rollbackDetail: upgradeFailureDetail(value.rollbackDetail) } : {}),
      ...(health ? { health: { ok: health.ok, endpoint: health.endpoint,
        expectedVersion: upgradeFailureDetail(health.expectedVersion).slice(0, 128),
        ...(health.retryable !== undefined ? { retryable: health.retryable } : {}),
        ...(health.statusCode ? { statusCode: health.statusCode } : {}), detail: upgradeFailureDetail(health.detail),
        ...(health.observedVersion ? { observedVersion: upgradeFailureDetail(health.observedVersion).slice(0, 128) } : {}) } } : {}) };
  } catch { return undefined; }
}

/** Diagnostics must never turn a completed restoration into another transaction failure. */
export function recordUpgradeFailureDiagnostic(home: string, failure: UpgradeFailureDiagnostic): string | undefined {
  try {
    const path = upgradeFailureDiagnosticPath(home);
    atomicWriteJsonOwnerOnly(path, failure);
    return path;
  } catch { return undefined; }
}

export function clearUpgradeFailureDiagnostic(home: string): void {
  const path = upgradeFailureDiagnosticPath(home);
  try {
    if (existsSync(path) && inspectOwnerOnlyFile(path).status === 'ok') unlinkSync(path);
  } catch { /* A diagnostic cannot undo a committed update. */ }
}
