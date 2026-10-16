import { lstatSync, readdirSync, realpathSync, rmdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { InstalledResourceRecord } from './install-state.ts';
import { assertNoSymlinkComponents } from '../security/secure-files.ts';

/**
 * The receipt for the Bun runtimes cosyncing placed, and the one uninstall step that takes them back.
 *
 * Installers and `cosy update` place Bun in exactly one layout, `<COSYNCING_HOME>/runtime/bun-<version>/`
 * (see `updates/bun-runtime-upgrade.ts`). The receipt names that directory and nothing else, so what a
 * non-purge uninstall may remove is bounded twice: by the directory, and inside it by the names only those
 * writers use. A Bun anywhere else -- the operator's own, `$BUN_INSTALL/bin/bun` that older installers
 * used, or whatever `COSYNCING_BUN_BIN` names -- is never cosyncing's to remove.
 */
export const OWNED_BUN_RUNTIME_DIRECTORY = 'runtime';
export const BUN_RUNTIMES_RESOURCE_ID = 'bun-runtimes';

/** `bun-<version>`, and the staging directory a run interrupted before its rename could leave beside it. */
export function isOwnedBunRuntimeEntryName(name: string): boolean {
  return /^bun-\d+\.\d+\.\d+$/.test(name) || /^\.bun-\d+\.\d+\.\d+\.staging[.-]/.test(name);
}

export function ownedBunRuntimeRoot(home: string): string {
  return join(home, OWNED_BUN_RUNTIME_DIRECTORY);
}

export function bunRuntimesReceipt(home: string): InstalledResourceRecord {
  return {
    id: BUN_RUNTIMES_RESOURCE_ID,
    kind: 'other',
    target: ownedBunRuntimeRoot(home),
    ownership: { proof: 'receipt' },
  };
}

export function validBunRuntimesReceipt(home: string, record: InstalledResourceRecord): boolean {
  return record.id === BUN_RUNTIMES_RESOURCE_ID
    && record.kind === 'other'
    && record.ownership?.proof === 'receipt'
    && typeof record.target === 'string'
    && isAbsolute(record.target)
    && resolve(record.target) === resolve(ownedBunRuntimeRoot(home));
}

export type OwnedBunRuntimesInspection =
  | { status: 'missing' }
  | { status: 'unsafe' }
  /** `owned`: runtime and staging directories this user owns. `foreign`: every other entry, never touched. */
  | { status: 'present'; owned: string[]; foreign: string[] };

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function ownedDirectory(path: string): boolean {
  try {
    assertNoSymlinkComponents(path, false);
    const stat = lstatSync(path);
    const uid = currentUid();
    return !stat.isSymbolicLink() && stat.isDirectory() && (uid === undefined || stat.uid === uid);
  } catch {
    return false;
  }
}

export function inspectOwnedBunRuntimes(home: string): OwnedBunRuntimesInspection {
  const root = ownedBunRuntimeRoot(home);
  try {
    lstatSync(root);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { status: 'missing' } : { status: 'unsafe' };
  }
  if (!ownedDirectory(root)) return { status: 'unsafe' };
  let entries: string[];
  try { entries = readdirSync(root).sort(); } catch { return { status: 'unsafe' }; }
  const owned: string[] = [];
  const foreign: string[] = [];
  for (const entry of entries) {
    (isOwnedBunRuntimeEntryName(entry) && ownedDirectory(join(root, entry)) ? owned : foreign).push(entry);
  }
  return { status: 'present', owned, foreign };
}

/** True when the state home holds at least one runtime an installer or `cosy update` placed. */
export function ownedBunRuntimesPresent(home: string): boolean {
  const inspection = inspectOwnedBunRuntimes(home);
  return inspection.status === 'present' && inspection.owned.some((entry) => /^bun-\d+\.\d+\.\d+$/.test(entry));
}

/**
 * The owned runtime directory `path` lies inside, or undefined. Both the path as given and where it really
 * leads are compared, so a symlink on PATH that points into a runtime still counts as naming it.
 */
export function ownedBunRuntimeEntryOf(
  home: string,
  path: string | undefined,
  options: { caseInsensitive?: boolean } = {},
): string | undefined {
  const value = path?.trim();
  if (!value) return undefined;
  const fold = (text: string): string => options.caseInsensitive ? text.toLowerCase() : text;
  const real = (text: string): string[] => {
    try { return [realpathSync(text)]; } catch { return []; }
  };
  const root = ownedBunRuntimeRoot(home);
  const roots = [resolve(root), ...real(root)];
  const candidates = [resolve(value), ...real(value)];
  for (const base of roots) {
    for (const candidate of candidates) {
      const inside = relative(fold(base), fold(candidate));
      if (!inside || inside.startsWith('..') || isAbsolute(inside)) continue;
      const entry = inside.split(sep)[0]!;
      if (isOwnedBunRuntimeEntryName(entry)) return entry;
    }
  }
  return undefined;
}

/**
 * Remove every owned runtime under `<home>/runtime` except `keep`, then the directory itself if that left
 * it empty. Foreign entries are never touched, and a directory still holding one stays.
 *
 * A runtime that cannot be removed (on Windows: a `bun.exe` something still runs) is reported in `failed`
 * rather than thrown, so one stubborn runtime does not stop the others from going.
 */
export function removeOwnedBunRuntimes(
  home: string,
  keep: ReadonlySet<string>,
): { removed: string[]; failed: string[] } {
  const inspection = inspectOwnedBunRuntimes(home);
  if (inspection.status === 'missing') return { removed: [], failed: [] };
  if (inspection.status === 'unsafe') throw new Error('bun-runtimes-root-unsafe');
  const root = ownedBunRuntimeRoot(home);
  const removed: string[] = [];
  const failed: string[] = [];
  for (const entry of inspection.owned) {
    if (keep.has(entry)) continue;
    const path = join(root, entry);
    try {
      if (!ownedDirectory(path)) throw new Error('bun-runtime-unsafe');
      rmSync(path, { recursive: true, force: false });
      removed.push(entry);
    } catch {
      failed.push(entry);
    }
  }
  try {
    if (readdirSync(root).length === 0) rmdirSync(root);
  } catch {
    // An empty directory left behind is untidy, never a failed uninstall.
  }
  return { removed, failed };
}
