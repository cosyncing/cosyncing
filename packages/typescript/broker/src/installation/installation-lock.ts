import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { setupStateHome } from './setup-state.ts';
import {
  createOwnerOnlyFileExclusive,
  ensureOwnerOnlyDirectory,
  inspectOwnerOnlyFile,
} from '../security/secure-files.ts';

export const INSTALLATION_LOCK_SCHEMA_VERSION = 1 as const;
export const INSTALLATION_LOCK_FILENAME = 'installation.lock';

export type InstallationMutation = 'setup' | 'repair' | 'upgrade' | 'uninstall';

interface InstallationLockRecord {
  schemaVersion: typeof INSTALLATION_LOCK_SCHEMA_VERSION;
  pid: number;
  nonce: string;
  command: InstallationMutation;
  acquiredAt: string;
}

export class InstallationLockError extends Error {
  constructor(readonly reason: 'busy' | 'unsafe' | 'unreadable') {
    super(`installation mutation lock is ${reason}`);
    this.name = 'InstallationLockError';
  }
}

export interface InstallationLockHandle {
  path: string;
  recoveredStaleLock: boolean;
  release(): void;
}

export function installationLockPath(home = setupStateHome()): string {
  return join(home, INSTALLATION_LOCK_FILENAME);
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== 'ESRCH';
  }
}

function parseRecord(path: string): InstallationLockRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new InstallationLockError('unreadable');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InstallationLockError('unsafe');
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== INSTALLATION_LOCK_SCHEMA_VERSION
      || !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0
      || typeof record.nonce !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(record.nonce)
      || !['setup', 'repair', 'upgrade', 'uninstall'].includes(String(record.command))
      || typeof record.acquiredAt !== 'string' || !Number.isFinite(Date.parse(record.acquiredAt))) {
    throw new InstallationLockError('unsafe');
  }
  return record as unknown as InstallationLockRecord;
}

/** Acquire the one cross-command mutation lock, recovering only a parseable record whose PID is gone. */
export function acquireInstallationLock(options: {
  command: InstallationMutation;
  home?: string;
  now?: () => Date;
}): InstallationLockHandle {
  const home = options.home ?? setupStateHome();
  ensureOwnerOnlyDirectory(home);
  const path = installationLockPath(home);
  let recoveredStaleLock = false;

  if (existsSync(path)) {
    const inspection = inspectOwnerOnlyFile(path);
    if (inspection.status !== 'ok' || lstatSync(path).isSymbolicLink()) {
      throw new InstallationLockError('unsafe');
    }
    const existing = parseRecord(path);
    if (processAlive(existing.pid)) throw new InstallationLockError('busy');
    const stale = `${path}.stale-${existing.pid}-${Date.now()}`;
    renameSync(path, stale);
    recoveredStaleLock = true;
  }

  const nonce = randomBytes(16).toString('base64url');
  const record: InstallationLockRecord = {
    schemaVersion: INSTALLATION_LOCK_SCHEMA_VERSION,
    pid: process.pid,
    nonce,
    command: options.command,
    acquiredAt: (options.now?.() ?? new Date()).toISOString(),
  };
  // The shared primitive is the only creation path that is owner-only on every supported host; a private
  // openSync would leave the lock carrying inherited Windows access and fail its own inspectOwnerOnlyFile.
  if (createOwnerOnlyFileExclusive(path, `${JSON.stringify(record, null, 2)}\n`) === 'exists') {
    throw new InstallationLockError('busy');
  }

  let released = false;
  return {
    path,
    recoveredStaleLock,
    release(): void {
      if (released) return;
      released = true;
      if (!existsSync(path)) return;
      const current = parseRecord(path);
      if (current.pid !== process.pid || current.nonce !== nonce) {
        throw new InstallationLockError('busy');
      }
      unlinkSync(path);
    },
  };
}
