/**
 * Narrow, kept on purpose: the resource bounds of the shared-draft store, which an e2e suite cannot
 * reach cheaply. The clear-tombstone backstop needs two thousand cleared sessions; the revision
 * clock's amortized reservation and constant size, and one shard rewritten per edit, are disk-write
 * properties with no client-visible effect until a disk fills. Everything a device sees (fan-out,
 * arbitration, tombstones, restart, retention, the lost-clock refusal) is in
 * e2e/broker/composer-drafts.test.ts.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_SHARED_DRAFT_CLEAR_TOMBSTONES,
  REVISION_CLOCK_FILE,
  REVISION_RESERVATION_BLOCK,
  SharedDraftStore,
} from '../../src/sessions/draft-store.ts';

function withStore(run: (store: SharedDraftStore, directory: string, tick: () => void) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-draft-bounds-'));
  const directory = join(root, 'drafts');
  let now = 1_000_000;
  try {
    run(new SharedDraftStore({ directory, now: () => now }), directory, () => { now += 1; });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const shards = (directory: string): string[] =>
  readdirSync(directory).filter((name) => name.endsWith('.json') && name !== REVISION_CLOCK_FILE);

test('clear tombstones have their own backstop cap, oldest out first', () => {
  withStore((store, _directory, tick) => {
    for (let index = 0; index < MAX_SHARED_DRAFT_CLEAR_TOMBSTONES + 25; index += 1) {
      tick();
      store.write('claude', `flood-${index}`, '', { updateId: `flood-${index}` });
    }
    expect(store.size()).toBe(MAX_SHARED_DRAFT_CLEAR_TOMBSTONES);
    expect(store.get('claude', 'flood-0')).toBeUndefined();
    expect(store.get('claude', `flood-${MAX_SHARED_DRAFT_CLEAR_TOMBSTONES + 24}`)?.text).toBe('');
  });
});

test('one edit rewrites only its own session’s shard', () => {
  withStore((store, directory, tick) => {
    for (const id of ['a', 'b', 'c']) store.write('claude', id, `draft ${id}`, { updateId: `w-${id}` });
    expect(shards(directory)).toHaveLength(3);
    const before = new Map(shards(directory).map((name) => [name, statSync(join(directory, name))]));
    tick();
    store.write('claude', 'a', 'edited again', { updateId: 'w-a2', baseRevision: store.currentRevision('claude', 'a') });
    const untouched = [...before].filter(([name, stat]) => {
      const after = statSync(join(directory, name));
      return after.mtimeMs === stat.mtimeMs && after.ino === stat.ino;
    });
    expect(untouched).toHaveLength(2);
  });
});

test('the revision clock is written once per reserved block and stays a constant size', () => {
  withStore((store, directory, tick) => {
    store.write('claude', 'amortized', 'first', { updateId: 'a-0' });
    const clock = join(directory, REVISION_CLOCK_FILE);
    const first = statSync(clock);
    for (let index = 1; index < 200; index += 1) {
      tick();
      store.write('claude', 'amortized', `edit ${index}`, { updateId: `a-${index}` });
    }
    const later = statSync(clock);
    expect(200).toBeLessThan(REVISION_RESERVATION_BLOCK);
    expect([later.mtimeMs, later.size]).toEqual([first.mtimeMs, first.size]);
    expect(later.size).toBeLessThan(128);
  });
});
