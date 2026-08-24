import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJsonOwnerOnly } from './secure-files.ts';

export const REVISION_17_SECURITY_MIGRATION_FILE = 'security-migration-revision-17.json';

/** Write the cross-store completion marker only after peer, wake, and schedule constructors have
 * returned. The marker never bypasses their own validation; it records that one startup completed
 * every security migration and makes an interrupted run distinguishable to operators. */
export function completeRevision17SecurityMigration(
  home: string,
  now: () => Date = () => new Date(),
): void {
  const path = join(home, REVISION_17_SECURITY_MIGRATION_FILE);
  try {
    const current = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (current.version === 1 && current.securityRevision === 17 && typeof current.completedAt === 'string') {
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  atomicWriteJsonOwnerOnly(path, {
    version: 1,
    securityRevision: 17,
    completedAt: now().toISOString(),
  });
}
