/**
 * Reading one `fs.watch` event on the directory that holds a session's files.
 *
 * Adapters watch the DIRECTORY, not the files: a file replaced whole keeps a
 * directory watch alive, where a watch on the file follows the old inode. But
 * Bun (1.3.14, Linux) reports a file renamed over another only under the name
 * it was renamed FROM: a snapshot written aside and renamed over a watched file
 * arrives as a `rename` of the temporary name, never under the watched one
 * (Node reports both names). A reader that keeps only its own names misses an
 * atomic replacement until something else wakes it.
 *
 * So a rename of any name may have replaced a watched file. The event never
 * says which file changed or how; the reader decides that from the file itself,
 * its identity (`dev:ino`) and its content, as it does for any change.
 */

/**
 * - `watched`: names a watched file, or names nothing (the platform did not say
 *   which file changed).
 * - `renamed`: a rename of another name, which may have replaced a watched file.
 * - `unrelated`: a content change to a file that is not watched.
 */
export type DirectoryWatchEvent = 'watched' | 'renamed' | 'unrelated';

export function classifyDirectoryWatchEvent(
  eventType: string,
  filename: string | Buffer | null | undefined,
  watchedNames: ReadonlySet<string>,
): DirectoryWatchEvent {
  if (filename === null || filename === undefined) return 'watched';
  if (watchedNames.has(String(filename))) return 'watched';
  return eventType === 'rename' ? 'renamed' : 'unrelated';
}
