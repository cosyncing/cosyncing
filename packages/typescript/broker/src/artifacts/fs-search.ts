import { opendir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FsSearchResult } from '@cosyncing/protocol';
import { FsBrowseError, readSessionStat, validateBrowsePath } from './fs-browse.ts';

const skippedDirectories = new Set(['.git', 'node_modules', '.cache', '.dart_tool', '.venv', '__pycache__']);

/** On-demand filename/suffix lookup. Never reads file contents or follows symlinks. */
export async function searchSessionFiles(
  cwd: string,
  rawQuery: string | null,
  options: { maxEntries?: number; maxMatches?: number; maxDepth?: number; maxMs?: number; signal?: AbortSignal } = {},
): Promise<FsSearchResult> {
  const query = rawQuery?.trim().replaceAll('\\', '/') ?? '';
  if (!query || query.length > 4096 || /[\x00-\x1f]/.test(query)
      || query.startsWith('/') || /^[a-zA-Z]:/.test(query)
      || query.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new FsBrowseError('BAD_PARAM', 'search requires a relative filename or path suffix');
  }
  const root = readSessionStat(cwd, '');
  if (!root.isDirectory) throw new FsBrowseError('NOT_DIRECTORY', 'workspace is not a directory');
  const maxEntries = options.maxEntries ?? 10_000;
  const maxMatches = options.maxMatches ?? 50;
  const maxDepth = options.maxDepth ?? 16;
  const deadline = performance.now() + (options.maxMs ?? 1000);
  const pending = [{ path: '', depth: 0 }];
  const result: FsSearchResult = { query, matches: [], truncated: false };
  let visited = 0;
  const exhausted = () => options.signal?.aborted || performance.now() >= deadline || visited >= maxEntries;
  for (let cursor = 0; cursor < pending.length; cursor++) {
    if (exhausted()) { result.truncated = true; break; }
    const directory = pending[cursor]!;
    try {
      const { abs } = validateBrowsePath(cwd, directory.path);
      const handle = await opendir(abs);
      try {
        // Recheck containment after opening, before consuming directory names.
        validateBrowsePath(cwd, directory.path);
        for await (const entry of handle) {
          if (exhausted()) { result.truncated = true; break; }
          visited++;
          if (entry.isSymbolicLink()) continue;
          const path = join(directory.path, entry.name).replaceAll('\\', '/');
          if (entry.isDirectory() && !skippedDirectories.has(entry.name)) {
            if (directory.depth < maxDepth) pending.push({ path, depth: directory.depth + 1 });
            else result.truncated = true;
          } else if (entry.isFile() && (path === query || path.endsWith(`/${query}`))) {
            // The same authoritative stat/containment check used by Open.
            const stat = readSessionStat(cwd, path);
            if (stat.isRegularFile) result.matches.push(stat);
            if (result.matches.length >= maxMatches) { result.truncated = true; break; }
          }
        }
      } finally {
        try { await handle.close(); } catch { /* async iteration also closes it */ }
      }
    } catch (error) {
      // Disappearing/unreadable directories cannot make the entire search fail.
      if (directory.path === '') throw error;
      result.truncated = true;
    }
    if (result.matches.length >= maxMatches) break;
  }
  result.matches.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}
