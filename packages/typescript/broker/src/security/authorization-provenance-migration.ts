import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJsonOwnerOnly } from './secure-files.ts';

export const AUTHORIZATION_PROVENANCE_MIGRATION_FILE = 'authorization-provenance-migration.json';
export const AUTHORIZATION_PROVENANCE_MIGRATION_ID = 'authorization-provenance-v1';

/** Write the cross-store completion marker only after the rollback fence and the peer, wake, and
 * schedule constructors have returned. The marker never bypasses store validation; it records one
 * complete, idempotent authorization-provenance migration for diagnostics and repair tooling. */
export function completeAuthorizationProvenanceMigration(
  home: string,
  options: {
    now?: () => Date;
    /** Deterministic completion-marker fault injection. */
    beforePersist?: () => void;
  } = {},
): void {
  const path = join(home, AUTHORIZATION_PROVENANCE_MIGRATION_FILE);
  try {
    const current = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (current.schemaVersion === 1
        && current.migration === AUTHORIZATION_PROVENANCE_MIGRATION_ID
        && typeof current.completedAt === 'string') {
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  options.beforePersist?.();
  atomicWriteJsonOwnerOnly(path, {
    schemaVersion: 1,
    migration: AUTHORIZATION_PROVENANCE_MIGRATION_ID,
    completedAt: (options.now?.() ?? new Date()).toISOString(),
  });
}
