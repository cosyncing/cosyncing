/**
 * Narrow, kept on purpose: the resource bounds of the shared-draft store, which an e2e suite cannot
 * reach cheaply. The clear-tombstone backstop needs two thousand cleared sessions; the revision
 * clock's amortized reservation and constant size, and one shard rewritten per edit, are disk-write
 * properties with no client-visible effect until a disk fills. Everything a device sees (fan-out,
 * arbitration, tombstones, restart, retention, the lost-clock refusal) is in
 * e2e/broker/composer-drafts.test.ts.
 */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_SHARED_DRAFT_CLEAR_TOMBSTONES,
  REVISION_CLOCK_FILE,
  REVISION_RESERVATION_BLOCK,
  SharedDraftStore,
} from '../../src/sessions/draft-store.ts';

function withStore(
  run: (store: SharedDraftStore, directory: string, tick: () => void, reopen: () => SharedDraftStore) => void,
  seed: (directory: string) => void = () => {},
): void {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-draft-bounds-'));
  const directory = join(root, 'drafts');
  let now = 1_000_000;
  const open = (): SharedDraftStore => new SharedDraftStore({ directory, now: () => now });
  try {
    seed(directory);
    run(open(), directory, () => { now += 1; }, open);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const shards = (directory: string): string[] =>
  readdirSync(directory).filter((name) => name.endsWith('.json') && name !== REVISION_CLOCK_FILE);

/**
 * The store directory a restart finds when an earlier run already holds `count` clear tombstones,
 * `flood-0` oldest, with the revision clock that covers them. Written as plain files: reaching the
 * backstop through `write()` costs two thousand durable writes of two fsyncs each, about 13 ms apiece
 * on a quiet host and over 60 ms in a full check, which spent minutes on setup alone.
 */
function seedClearTombstones(directory: string, count: number): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (let index = 0; index < count; index += 1) {
    writeFileSync(join(directory, `seed-${index}.json`), JSON.stringify({
      version: 1,
      tool: 'claude',
      sessionId: `flood-${index}`,
      text: '',
      revision: index + 1,
      updatedAt: index + 1,
      lastUpdateId: `flood-${index}`,
    }), { mode: 0o600 });
  }
  writeFileSync(join(directory, REVISION_CLOCK_FILE), JSON.stringify({ version: 1, reservedThrough: count }), { mode: 0o600 });
}

test('clear tombstones have their own backstop cap, oldest out first', () => {
  const overflow = 25;
  const flood = MAX_SHARED_DRAFT_CLEAR_TOMBSTONES + overflow;
  // Which flood sessions still hold their tombstone.
  const kept = (store: SharedDraftStore): number[] =>
    Array.from({ length: flood }, (_, index) => index).filter((index) => store.get('claude', `flood-${index}`)?.text === '');
  const newest = Array.from({ length: MAX_SHARED_DRAFT_CLEAR_TOMBSTONES }, (_, index) => index + overflow);
  withStore((store, directory, tick, reopen) => {
    expect(store.size()).toBe(MAX_SHARED_DRAFT_CLEAR_TOMBSTONES);
    for (let index = MAX_SHARED_DRAFT_CLEAR_TOMBSTONES; index < flood; index += 1) {
      tick();
      expect(store.write('claude', `flood-${index}`, '', { updateId: `flood-${index}` }).status).toBe('applied');
    }
    expect(store.size()).toBe(MAX_SHARED_DRAFT_CLEAR_TOMBSTONES);
    expect(kept(store)).toEqual(newest);
    // Evicted tombstones leave the disk too, so the backstop bounds the shard count across a restart.
    expect(shards(directory)).toHaveLength(MAX_SHARED_DRAFT_CLEAR_TOMBSTONES);
    expect(kept(reopen())).toEqual(newest);
  }, (directory) => seedClearTombstones(directory, MAX_SHARED_DRAFT_CLEAR_TOMBSTONES));
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
