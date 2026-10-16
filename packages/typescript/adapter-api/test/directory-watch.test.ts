/**
 * Reading a directory watch event for a session's watched files
 * (`src/directory-watch.ts`).
 *
 * The conformance suite (C06, C15, `e2e/adapters/conformance`) proves each
 * adapter notices a log replaced by rename. These are the helper's own edges,
 * and one run of the real `fs.watch` on this runtime: whatever names the
 * platform reports for a rename-over, at least one of them is not `unrelated`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyDirectoryWatchEvent } from '../src/index.ts';

const watched = new Set(['updates.jsonl', 'summary.json']);
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('classifyDirectoryWatchEvent', () => {
  test('an event that names a watched file, or no file, is watched', () => {
    expect(classifyDirectoryWatchEvent('change', 'updates.jsonl', watched)).toBe('watched');
    expect(classifyDirectoryWatchEvent('rename', 'summary.json', watched)).toBe('watched');
    expect(classifyDirectoryWatchEvent('change', Buffer.from('updates.jsonl'), watched)).toBe('watched');
    expect(classifyDirectoryWatchEvent('change', null, watched)).toBe('watched');
    expect(classifyDirectoryWatchEvent('rename', undefined, watched)).toBe('watched');
  });

  test('a rename of any other name may have replaced a watched file', () => {
    expect(classifyDirectoryWatchEvent('rename', 'updates.jsonl.tmp', watched)).toBe('renamed');
    expect(classifyDirectoryWatchEvent('rename', '.summary.json.1f2e', watched)).toBe('renamed');
  });

  test('a content change to another file is unrelated', () => {
    expect(classifyDirectoryWatchEvent('change', 'updates.jsonl.tmp', watched)).toBe('unrelated');
    expect(classifyDirectoryWatchEvent('change', 'signals.json', watched)).toBe('unrelated');
  });

  test('this runtime\'s fs.watch reports a rename-over under a name the reader acts on', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cosyncing-directory-watch-'));
    roots.push(root);
    const target = join(root, 'updates.jsonl');
    writeFileSync(target, 'one\n');
    writeFileSync(`${target}.tmp`, readFileSync(target));
    const events: Array<{ eventType: string; filename: string | null }> = [];
    const watcher = watch(root, { persistent: false }, (eventType, filename) => {
      events.push({ eventType, filename: filename === null ? null : String(filename) });
    });
    try {
      // Only the rename happens while the directory is watched.
      await Bun.sleep(50);
      renameSync(`${target}.tmp`, target);
      for (let attempt = 0; attempt < 100 && events.length === 0; attempt += 1) await Bun.sleep(10);
    } finally {
      watcher.close();
    }
    expect(events.length).toBeGreaterThan(0);
    expect(events.some(({ eventType, filename }) =>
      classifyDirectoryWatchEvent(eventType, filename, watched) !== 'unrelated')).toBe(true);
  });
});
