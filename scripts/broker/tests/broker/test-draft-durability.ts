#!/usr/bin/env bun
/**
 * Regression — DR1 durable, versioned shared composer drafts.
 *
 * The broker keeps ONE versioned latest-draft record per (tool, session) in a durable per-session
 * shard. It must survive the normal zero-client owner eviction AND a broker restart, arbitrate
 * reconnect retries by idempotency updateId and optimistic baseRevision (never client clocks),
 * reject stale-base writes instead of silently overwriting a newer shared draft, refuse to
 * acknowledge a mutation it could not durably store, replay clear tombstones to versioned late
 * joiners, clear on Send only the draft the sender actually observed, and stay bounded (TTL + LRU
 * caps, one shard rewritten per edit) without any polling or background loop.
 */
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SharedDraftStore,
  MAX_SHARED_DRAFT_CLEAR_TOMBSTONES,
  MAX_SHARED_DRAFT_SESSIONS,
  SHARED_DRAFT_TTL_MS,
  SHARED_DRAFT_CLEAR_RETENTION_MS,
  MAX_SHARED_DRAFT_TEXT_CHARS,
  REVISION_CLOCK_FILE,
  REVISION_RESERVATION_BLOCK,
} from '../../../../packages/typescript/broker/src/draft-store.ts';
import { ManagedConn } from '../../../../packages/typescript/broker/src/hub.ts';
import type { SessionConnection, SessionInfo, AgentMessageHandler } from '../../../../packages/typescript/adapter-api/src/index.ts';

let failures = 0;
const check = (label: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  — ${extra}` : ''}`);
  if (!ok) failures++;
};

const root = mkdtempSync(join(tmpdir(), 'dr1-draft-store-'));
const storeDir = join(root, 'drafts');
let nowMs = 1_000_000;
const now = () => nowMs;

/** Same stable shard name the store derives, so the test can target one session's file. */
const shardFile = (directory: string, tool: string, sessionId: string) =>
  join(directory, `${createHash('sha256').update(`${tool}\0${sessionId}`).digest('hex').slice(0, 32)}.json`);

const info: SessionInfo = { id: 's1', tool: 'claude', machine: 't', title: 'draft', status: 'idle', attachMode: 'observe' };
function fakeConn(): SessionConnection {
  const handlers: AgentMessageHandler[] = [];
  return {
    info,
    getHistory: async () => [],
    subscribe: (h: AgentMessageHandler) => { handlers.push(h); return () => {}; },
    sendPrompt: async () => {},
    respondPermission: async () => {},
    close: async () => {},
  };
}

try {
  // 1. Versioned writes assign monotone broker revisions and persist.
  const store = new SharedDraftStore({ directory: storeDir, now });
  const w1 = store.write('claude', 's1', 'hello', { updateId: 'u-1', baseRevision: 0 });
  check('first write applies at revision 1', w1.status === 'applied' && w1.record?.revision === 1);
  const w2 = store.write('claude', 's1', 'hello world', { updateId: 'u-2', baseRevision: 1 });
  check('second write bumps the revision', w2.status === 'applied' && w2.record?.revision === 2);

  // 2. Idempotent retry: same updateId is a duplicate — no revision bump, no mutation.
  const dup = store.write('claude', 's1', 'hello world', { updateId: 'u-2', baseRevision: 1 });
  check('reconnect retry with the same updateId is an idempotent duplicate', dup.status === 'duplicate' && dup.record?.revision === 2);
  check('duplicate keeps the accepted text', dup.record?.text === 'hello world');

  // 3. Stale-base rejection: an offline edit based on an old revision never overwrites the newer shared draft.
  const stale = store.write('claude', 's1', 'conflicting offline edit', { updateId: 'u-3', baseRevision: 1 });
  check('stale-base write is rejected', stale.status === 'stale-base');
  check('the shared record is untouched by the rejection', stale.record?.text === 'hello world' && stale.record?.revision === 2);
  check('the store still holds the newer shared draft', store.get('claude', 's1')?.text === 'hello world');

  // 4. A retry based on the CURRENT revision applies (conflict resolved client-side first).
  const resolved = store.write('claude', 's1', 'conflicting offline edit', { updateId: 'u-3', baseRevision: 2 });
  check('a write based on the current revision applies', resolved.status === 'applied' && resolved.record?.revision === 3);

  // 5. Legacy unversioned frames keep last-writer-wins.
  const legacy = store.write('claude', 's1', 'legacy value');
  check('legacy write without tokens applies', legacy.status === 'applied' && legacy.record?.revision === 4);

  // 6. Broker restart: a new store instance over the same directory keeps record AND revision sequence.
  const reopened = new SharedDraftStore({ directory: storeDir, now });
  const afterRestart = reopened.get('claude', 's1');
  check('shared draft survives broker restart', afterRestart?.text === 'legacy value' && afterRestart.revision === 4);
  const continued = reopened.write('claude', 's1', 'after restart', { updateId: 'u-5', baseRevision: 4 });
  // Revisions come from the store-wide clock, so what matters is that a restart never
  // hands one out again — not that the sequence is dense.
  check('revision sequence continues across restart', (continued.record?.revision ?? 0) > 4);

  // 7. Zero-client owner eviction: a reconstructed ManagedConn hydrates from the store.
  const evicted = new ManagedConn(fakeConn(), undefined, {}, reopened);
  evicted.setDraft('from live owner', { updateId: 'u-6', baseRevision: reopened.currentRevision('claude', 's1') });
  await evicted.dispose(); // the 15-second zero-client eviction destroys the owner
  const reconstructed = new ManagedConn(fakeConn(), undefined, {}, reopened);
  const snapshot = reconstructed.draftSnapshot();
  const evictedRevision = reopened.currentRevision('claude', 's1');
  check('draft survives zero-client owner eviction', snapshot?.text === 'from live owner' && snapshot.revision === evictedRevision);

  // 8. Broadcast frames carry the version contract; prompt-clear empties every composer.
  const frames: any[] = [];
  reconstructed.addClient((e: any) => frames.push(e));
  reconstructed.setDraft('broadcast me', { updateId: 'u-7', baseRevision: evictedRevision });
  const broadcast = frames.find((e) => e.kind === 'draft');
  check(
    'broadcast carries text, revision and updateId',
    broadcast?.text === 'broadcast me' && broadcast?.revision > evictedRevision && broadcast?.updateId === 'u-7',
  );
  reconstructed.setDraft(''); // prompt accepted → shared draft cleared
  const clearedRevision = reopened.currentRevision('claude', 's1');
  check('prompt clear empties the shared draft for every client', frames.at(-1)?.text === '' && frames.at(-1)?.revision === clearedRevision);
  check('the clear keeps a tombstone revision for stale-base arbitration', clearedRevision > broadcast.revision);

  // 9. Clear tombstones ARE replayed to versioned late joiners.
  //    A device that was offline across the clear holds an older CLEAN local row. Replaying nothing
  //    leaves it convinced its stale draft is current; replaying the empty revision lets it adopt
  //    the clear. Legacy clients cannot compare revisions, so they still get nothing to apply.
  check('a versioned late joiner receives the clear tombstone', (() => {
    const tomb = reconstructed.draftSnapshot({ includeTombstone: true });
    return tomb !== null && tomb.text === '' && tomb.revision === clearedRevision;
  })());
  check('a legacy late joiner is not sent an empty draft', reconstructed.draftSnapshot({ includeTombstone: false }) === null);
  // Retention removes evicted and expired NON-EMPTY drafts by the same route it
  // removes tombstones, so "no record" cannot be reported as an authoritative
  // clear: a device's clean local row is then the last copy of that text
  // anywhere, and an empty frame would delete it. Silence leaves the device
  // stale but recoverable; deletion is not.
  check('a session with no retained record replays nothing', (() => {
    const fresh = new ManagedConn({ ...fakeConn(), info: { ...info, id: 'never-drafted' } }, undefined, {}, reopened);
    return fresh.draftSnapshot({ includeTombstone: true }) === null;
  })());
  check('an evicted non-empty draft is never reported as cleared', (() => {
    const evictStore = new SharedDraftStore({ directory: join(root, 'evict-semantics'), now });
    evictStore.write('claude', 'forgotten', 'the only surviving copy', { updateId: 'f-1' });
    nowMs += SHARED_DRAFT_TTL_MS + 1;
    evictStore.write('claude', 'trigger', 'x', { updateId: 'tr-1' }); // prunes 'forgotten'
    const stranded = new ManagedConn(
      { ...fakeConn(), info: { ...info, id: 'forgotten' } },
      undefined,
      {},
      evictStore,
    );
    return evictStore.get('claude', 'forgotten') === undefined
      && stranded.draftSnapshot({ includeTombstone: true }) === null;
  })());

  // 10. Send clears only the draft the SENDER observed. Device A sending must never erase the newer
  //     shared draft device B typed in the meantime.
  const shared = new SharedDraftStore({ directory: join(root, 'send'), now });
  const sender = new ManagedConn({ ...fakeConn(), info: { ...info, id: 'send' } }, undefined, {}, shared);
  sender.setDraft('device A text', { updateId: 'a-1', baseRevision: 0 }); // revision 1
  sender.setDraft('device B typed this later', { updateId: 'b-1', baseRevision: 1 }); // revision 2
  const skipped = sender.clearDraftAfterPrompt(1); // A sends, still holding revision 1
  check('a send based on a superseded revision does not clear the shared draft', skipped === undefined);
  check("the other device's newer shared draft survives the send", shared.get('claude', 'send')?.text === 'device B typed this later');
  const cleared = sender.clearDraftAfterPrompt(2); // a sender holding the current revision
  check('a send based on the current revision clears the shared draft', cleared?.applied === true && shared.get('claude', 'send')?.text === '');
  const legacySender = new ManagedConn({ ...fakeConn(), info: { ...info, id: 'legacy-send' } }, undefined, {}, shared);
  legacySender.setDraft('legacy draft', { updateId: 'l-1' });
  check('a legacy sender (no observed revision) keeps the unconditional clear', legacySender.clearDraftAfterPrompt(undefined)?.applied === true);

  // 10b. Send while this device's OWN draft write is still unacknowledged.
  //      Both frames ride one socket, so the broker applies the draft first and the revision the
  //      prompt reports is already stale — but the draft it advanced to IS this prompt's text.
  //      Revision alone would refuse the clear and strand the sent prompt as the shared draft.
  const raceStore = new SharedDraftStore({ directory: join(root, 'race'), now });
  const racer = new ManagedConn({ ...fakeConn(), info: { ...info, id: 'race' } }, undefined, {}, raceStore);
  racer.setDraft('prompt text', { updateId: 'race-1', baseRevision: 0 }); // accepted as revision 1
  const rescued = racer.clearDraftAfterPrompt(0, 'race-1'); // the sender still believes revision 0
  check('a send racing its own unacknowledged draft still clears it', rescued?.applied === true);
  check('the sent prompt does not survive as the shared draft', raceStore.get('claude', 'race')?.text === '');

  // 10c. The update token proves ownership of THIS device's draft only — it can never rescue a
  //      clear of someone else's newer draft.
  const otherStore = new SharedDraftStore({ directory: join(root, 'other'), now });
  const other = new ManagedConn({ ...fakeConn(), info: { ...info, id: 'other' } }, undefined, {}, otherStore);
  other.setDraft('my draft', { updateId: 'mine-1', baseRevision: 0 });
  other.setDraft('their newer draft', { updateId: 'theirs-1', baseRevision: 1 });
  const refused = other.clearDraftAfterPrompt(0, 'mine-1');
  check('a stale update token never clears another device newer draft', refused === undefined);
  check("the other device's draft is intact", otherStore.get('claude', 'other')?.text === 'their newer draft');

  // 11. A dirty retry against a cleared tombstone is still rejected (never silently resurrected over a NEWER value).
  const overClear = reopened.write('claude', 's1', 'old text', { updateId: 'u-9', baseRevision: 7 });
  check('stale retry over a clear tombstone is rejected', overClear.status === 'stale-base');

  // 12. Oversized text is rejected so one session can never pin unbounded durable state.
  let rejected = false;
  try {
    reopened.write('claude', 's1', 'x'.repeat(MAX_SHARED_DRAFT_TEXT_CHARS + 1));
  } catch {
    rejected = true;
  }
  check('oversized draft text is rejected', rejected);

  // 13. A mutation that cannot be durably stored is NOT applied and NOT acknowledged.
  //     Otherwise a client marks its local row clean against a shared copy a restart would lose.
  const failDir = join(root, 'fail');
  let reportedError: unknown;
  const failing = new SharedDraftStore({ directory: failDir, now, onPersistenceError: (e) => { reportedError = e; } });
  failing.write('claude', 'disk', 'durable value', { updateId: 'd-1', baseRevision: 0 });
  const durableRevision = failing.currentRevision('claude', 'disk');
  const failingConn = new ManagedConn({ ...fakeConn(), info: { ...info, id: 'disk' } }, undefined, {}, failing);
  const failingFrames: any[] = [];
  failingConn.addClient((e: any) => failingFrames.push(e));
  // Occupy the shard path with a directory: the atomic owner-only write now fails on a LIVE store,
  // which is the real shape of a full/failing disk (not a corrupt file discovered at startup).
  rmSync(shardFile(failDir, 'claude', 'disk'), { force: true });
  mkdirSync(shardFile(failDir, 'claude', 'disk'));
  const unavailable = failing.write('claude', 'disk', 'lost on restart', { updateId: 'd-2', baseRevision: durableRevision });
  check('a shard that cannot be written returns unavailable', unavailable.status === 'unavailable');
  check('the failed persistence is reported to the operator', reportedError !== undefined);
  check('an unstorable mutation does not change the in-memory record', failing.get('claude', 'disk')?.text === 'durable value');
  check('an unstorable mutation does not advance the revision', failing.currentRevision('claude', 'disk') === durableRevision);
  const failResult = failingConn.setDraft('also lost', { updateId: 'd-3', baseRevision: durableRevision });
  check('an unstorable mutation is reported unavailable, not applied', failResult.unavailable === true && failResult.applied === false);
  check('an unstorable mutation is never broadcast', !failingFrames.some((e) => e.kind === 'draft'));
  check('the fan-out cache is not advanced past the durable record', failingConn.draftSnapshot()?.text === 'durable value');
  // The post-send clear is the same write, so it fails the same way — but the prompt itself
  // succeeded. The result must carry the revision the shared record was LEFT at: that is what
  // the acknowledgement hands the sender, and it is what keeps the sender's retry conditional
  // instead of an unconditional empty overwrite of whatever another device typed since.
  const failedClear = failingConn.clearDraftAfterPrompt(durableRevision);
  check('a prompt clear that cannot be stored reports unavailable', failedClear?.unavailable === true && failedClear.applied === false);
  check('the failed clear names the revision the sender must retry against', failedClear?.record.revision === durableRevision);
  check('the sent text survives as the shared draft when its clear fails', failing.get('claude', 'disk')?.text === 'durable value');
  check('a failed clear is never broadcast as a tombstone', !failingFrames.some((e) => e.kind === 'draft'));

  // 14. Retention: non-empty rows AND clear tombstones both outlive the device-local draft retention,
  //     so an offline device can always still learn the clear instead of resurrecting a stale draft.
  check('clear tombstones are retained as long as non-empty drafts', SHARED_DRAFT_CLEAR_RETENTION_MS === SHARED_DRAFT_TTL_MS);
  const ttlStore = new SharedDraftStore({ directory: join(root, 'ttl'), now });
  ttlStore.write('claude', 'old', 'stale', { updateId: 'o1' });
  ttlStore.write('claude', 'cleared', '', { updateId: 'c1' });
  nowMs += SHARED_DRAFT_TTL_MS - 1;
  ttlStore.write('claude', 'keep', 'fresh', { updateId: 'k1' });
  check('a tombstone survives right up to the retention limit', ttlStore.get('claude', 'cleared')?.text === '');
  check('non-empty rows survive to the same limit', ttlStore.get('claude', 'old')?.text === 'stale');
  nowMs += 2;
  ttlStore.write('claude', 'trigger2', 'x', { updateId: 't2' });
  check('non-empty rows expire after the draft TTL', ttlStore.get('claude', 'old') === undefined);
  check('tombstones expire after the same TTL', ttlStore.get('claude', 'cleared') === undefined);
  check('fresh rows are never expired', ttlStore.get('claude', 'keep')?.text === 'fresh');
  check('expired shards are deleted from disk, not just from memory', readdirSync(join(root, 'ttl')).filter((n) => n.endsWith('.json') && n !== REVISION_CLOCK_FILE).length === ttlStore.size());

  // 15. Retention: the session cap is an LRU bound, pruned on write (bounded work per write).
  const lruStore = new SharedDraftStore({ directory: join(root, 'lru'), now });
  for (let i = 0; i < MAX_SHARED_DRAFT_SESSIONS + 10; i += 1) {
    nowMs += 1;
    lruStore.write('claude', `s-${i}`, `draft ${i}`, { updateId: `l-${i}` });
  }
  check('LRU cap bounds the number of retained sessions', lruStore.size() === MAX_SHARED_DRAFT_SESSIONS);
  check('the oldest sessions are evicted first', lruStore.get('claude', 's-0') === undefined && lruStore.get('claude', `s-${MAX_SHARED_DRAFT_SESSIONS + 9}`) !== undefined);

  // 15b. Cap pressure never evicts a clear tombstone. The tombstone is the only
  //      durable proof an explicit clear happened; discarding it under LRU
  //      pressure while an offline device still holds its pre-clear local row
  //      resurrects a draft the user already sent or discarded. Only the TTL
  //      retires tombstones — they are a few hundred bytes and never compete
  //      with full-size draft records.
  const capTombStore = new SharedDraftStore({ directory: join(root, 'cap-tombstone'), now });
  capTombStore.write('claude', 'cleared-under-pressure', 'sent text', { updateId: 'cp-a' });
  capTombStore.write('claude', 'cleared-under-pressure', '', { updateId: 'cp-b' });
  for (let i = 0; i < MAX_SHARED_DRAFT_SESSIONS + 10; i += 1) {
    nowMs += 1;
    capTombStore.write('claude', `cap-${i}`, `draft ${i}`, { updateId: `cap-${i}` });
  }
  check(
    'cap pressure keeps the tombstone beside the bounded non-empty set',
    capTombStore.size() === MAX_SHARED_DRAFT_SESSIONS + 1
      && capTombStore.get('claude', 'cleared-under-pressure')?.text === '',
  );
  const informedLateJoiner = new ManagedConn(
    { ...fakeConn(), info: { ...info, id: 'cleared-under-pressure' } },
    undefined,
    {},
    capTombStore,
  ).draftSnapshot({ includeTombstone: true });
  check(
    'the tombstone surviving cap pressure still replays the clear',
    informedLateJoiner !== null && informedLateJoiner.text === '',
    JSON.stringify(informedLateJoiner),
  );

  // 15c. Tombstones have their own generous backstop cap, so pathological use
  //      cannot grow the record and shard-file count without bound. Only the
  //      oldest tombstones are evicted once it is crossed.
  const tombFloodStore = new SharedDraftStore({ directory: join(root, 'tomb-flood'), now });
  for (let i = 0; i < MAX_SHARED_DRAFT_CLEAR_TOMBSTONES + 25; i += 1) {
    nowMs += 1;
    tombFloodStore.write('claude', `flood-${i}`, '', { updateId: `fl-${i}` });
  }
  check(
    'the tombstone count is bounded by its own backstop cap',
    tombFloodStore.size() === MAX_SHARED_DRAFT_CLEAR_TOMBSTONES,
    String(tombFloodStore.size()),
  );
  check(
    'tombstone eviction is LRU: oldest out, newest retained',
    tombFloodStore.get('claude', 'flood-0') === undefined
      && tombFloodStore.get('claude', `flood-${MAX_SHARED_DRAFT_CLEAR_TOMBSTONES + 24}`)?.text === '',
  );

  // 16. Bounded write amplification: one accepted edit rewrites exactly ONE shard. A single combined
  //     file would rewrite and fsync every retained draft on every 300 ms composer debounce.
  const shardDir = join(root, 'shards');
  const shardStore = new SharedDraftStore({ directory: shardDir, now });
  for (const id of ['a', 'b', 'c']) shardStore.write('claude', id, `draft ${id}`, { updateId: `s-${id}` });
  check('each session gets its own shard', readdirSync(shardDir).filter((n) => n.endsWith('.json') && n !== REVISION_CLOCK_FILE).length === 3);
  const untouched = ['b', 'c'].map((id) => {
    const path = shardFile(shardDir, 'claude', id);
    return { path, stat: statSync(path) };
  });
  nowMs += 1000;
  shardStore.write('claude', 'a', 'edited again', { updateId: 's-a2', baseRevision: 1 });
  check('editing one session does not rewrite the others', untouched.every(({ path, stat }) => {
    const after = statSync(path);
    return after.mtimeMs === stat.mtimeMs && after.ino === stat.ino;
  }));
  check('each shard holds exactly one session', untouched.every(({ path }) => {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed.sessionId === 'string' && typeof parsed.text === 'string';
  }));

  // 17. The revision clock: revisions are allocated globally and NEVER reused, so eviction,
  //     expiry, restart, and failed writes can all take a record away without ever handing a
  //     client a revision it has already seen. A reused revision is indistinguishable from a
  //     stale one, so the client would ignore every later frame for that session — forever.
  const clockDir = join(root, 'clock');
  const clockStore = new SharedDraftStore({ directory: clockDir, now });
  for (let i = 0; i < 12; i += 1) {
    nowMs += 1;
    clockStore.write('claude', 'victim', `edit ${i}`, { updateId: `victim-${i}` });
  }
  const victimRevision = clockStore.currentRevision('claude', 'victim');
  check('the evicted session reached a high revision', victimRevision >= 12, String(victimRevision));
  for (let i = 0; i < MAX_SHARED_DRAFT_SESSIONS + 5; i += 1) {
    nowMs += 1;
    clockStore.write('claude', `pressure-${i}`, 'x', { updateId: `p-${i}` });
  }
  check('LRU pressure evicted the session entirely', clockStore.get('claude', 'victim') === undefined);
  nowMs += 1;
  const recreated = clockStore.write('claude', 'victim', 'typed again', { updateId: 'victim-again' });
  check(
    'a recreated session never restarts below the revision clients retained',
    (recreated.record?.revision ?? 0) > victimRevision,
    `${recreated.record?.revision} vs ${victimRevision}`,
  );

  const reopenedClock = new SharedDraftStore({ directory: clockDir, now });
  nowMs += 1;
  const afterClockRestart = reopenedClock.write('claude', 'victim-2', 'fresh session', { updateId: 'v2' });
  check(
    'a restart never hands back a revision the clock already spent',
    (afterClockRestart.record?.revision ?? 0) > (recreated.record?.revision ?? 0),
  );

  // A tombstone must outlive the local rows it has to inform, which is why its
  // retention matches the device-local draft TTL rather than expiring first.
  // Once it does expire, the broker no longer knows the draft was cleared —
  // and must not guess, because an expired NON-EMPTY record looks identical.
  const tombstoneStore = new SharedDraftStore({ directory: join(root, 'absence'), now });
  tombstoneStore.write('claude', 'cleared-session', 'was here', { updateId: 'g-1' });
  tombstoneStore.write('claude', 'cleared-session', '', { updateId: 'g-2' });
  nowMs += SHARED_DRAFT_TTL_MS - 1;
  const stillTold = new ManagedConn(
    { ...fakeConn(), info: { ...info, id: 'cleared-session' } },
    undefined,
    {},
    tombstoneStore,
  ).draftSnapshot({ includeTombstone: true });
  check(
    'a retained tombstone is replayed for the whole local draft lifetime',
    stillTold !== null && stillTold.text === '',
    JSON.stringify(stillTold),
  );

  // A clock that cannot reserve fails the write closed: nothing is applied, nothing is broadcast,
  // and the writer keeps its dirty row rather than converging on a revision that means nothing.
  const brokenClockDir = join(root, 'broken-clock');
  const brokenClock = new SharedDraftStore({ directory: brokenClockDir, now });
  brokenClock.write('claude', 'first', 'seed', { updateId: 'b-1' });
  rmSync(join(brokenClockDir, REVISION_CLOCK_FILE), { force: true });
  mkdirSync(join(brokenClockDir, REVISION_CLOCK_FILE)); // reservation writes now fail
  const brokenStore = new SharedDraftStore({ directory: brokenClockDir, now });
  const brokenFrames: any[] = [];
  const brokenConn = new ManagedConn({ ...fakeConn(), info: { ...info, id: 'first' } }, undefined, {}, brokenStore);
  brokenConn.addClient((e: any) => brokenFrames.push(e));
  const clockRefused = brokenConn.setDraft('never stored', { updateId: 'b-2' });
  check('a clock that cannot be read fails writes closed', clockRefused.unavailable === true && clockRefused.applied === false);
  check('a failed reservation mutates no shard', brokenStore.get('claude', 'first')?.text === 'seed');
  check('a failed reservation broadcasts nothing', !brokenFrames.some((e) => e.kind === 'draft'));

  // A lost clock must stay fail-closed across restarts. Quarantining a corrupt shard leaves
  // a directory with no `.json` file in it, and calling that "pristine" would restart the
  // sequence at 1 — handing clients revisions they already hold and will ignore forever.
  const lostClockDir = join(root, 'lost-clock');
  const lostClockStore = new SharedDraftStore({ directory: lostClockDir, now });
  lostClockStore.write('claude', 'only', 'seed', { updateId: 'l-1' });
  writeFileSync(shardFile(lostClockDir, 'claude', 'only'), '{not json');
  rmSync(join(lostClockDir, REVISION_CLOCK_FILE), { force: true });
  const firstAfterLoss = new SharedDraftStore({ directory: lostClockDir, now });
  const refusedAfterLoss = firstAfterLoss.write('claude', 'only', 'retry', { updateId: 'l-2' });
  check('a lost clock fails the first write closed', refusedAfterLoss.status === 'unavailable');
  const secondAfterLoss = new SharedDraftStore({ directory: lostClockDir, now });
  const refusedAgain = secondAfterLoss.write('claude', 'only', 'retry again', { updateId: 'l-3' });
  check(
    'a quarantined shard keeps the next restart fail-closed too',
    refusedAgain.status === 'unavailable',
    JSON.stringify(refusedAgain.record ?? null),
  );

  // A shard write that fails still consumes its revision, and a restart never hands it back.
  const spentDir = join(root, 'spent');
  const spentStore = new SharedDraftStore({ directory: spentDir, now });
  spentStore.write('claude', 'spend', 'seed', { updateId: 's-1' });
  const spentBefore = spentStore.currentRevision('claude', 'spend');
  rmSync(shardFile(spentDir, 'claude', 'spend'), { force: true });
  mkdirSync(shardFile(spentDir, 'claude', 'spend'));
  const lost = spentStore.write('claude', 'spend', 'never lands', { updateId: 's-2' });
  check('a failed shard write is unavailable', lost.status === 'unavailable');
  rmSync(shardFile(spentDir, 'claude', 'spend'), { recursive: true, force: true });
  const spentReopened = new SharedDraftStore({ directory: spentDir, now });
  const afterSpent = spentReopened.write('claude', 'spend-2', 'next', { updateId: 's-3' });
  check(
    'a revision consumed by a failed write is never reused',
    (afterSpent.record?.revision ?? 0) > spentBefore + 1,
    `${afterSpent.record?.revision} vs ${spentBefore}`,
  );

  // Reservation writes are amortized and the clock never grows.
  const amortizedDir = join(root, 'amortized');
  const amortizedStore = new SharedDraftStore({ directory: amortizedDir, now });
  const clockPath = join(amortizedDir, REVISION_CLOCK_FILE);
  amortizedStore.write('claude', 'amortized', 'first', { updateId: 'a-0' });
  const firstClockStat = statSync(clockPath);
  for (let i = 1; i < 200; i += 1) {
    nowMs += 1;
    amortizedStore.write('claude', 'amortized', `edit ${i}`, { updateId: `a-${i}` });
  }
  const laterClockStat = statSync(clockPath);
  check(
    'a whole block of edits rewrites the clock at most once',
    laterClockStat.mtimeMs === firstClockStat.mtimeMs && 200 < REVISION_RESERVATION_BLOCK,
  );
  check('the clock stays a constant-size record', laterClockStat.size === firstClockStat.size && laterClockStat.size < 128);

  // 17. Malformed shards are preserved for diagnosis; valid siblings still load.
  const corruptDir = join(root, 'corrupt');
  const corruptStore = new SharedDraftStore({ directory: corruptDir, now });
  corruptStore.write('claude', 'broken', 'value', { updateId: 'x' });
  corruptStore.write('claude', 'intact', 'survivor', { updateId: 'y' });
  writeFileSync(shardFile(corruptDir, 'claude', 'broken'), '{not json');
  let persistedError: unknown;
  const recovered = new SharedDraftStore({ directory: corruptDir, now, onPersistenceError: (e) => { persistedError = e; } });
  check('a corrupt shard recovers empty with a reported error', recovered.get('claude', 'broken') === undefined && persistedError !== undefined);
  check('valid sibling shards still load', recovered.get('claude', 'intact')?.text === 'survivor');
  check('the corrupt shard is moved aside, not silently overwritten', readdirSync(corruptDir).some((name) => name.includes('.corrupt-')));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${failures ? `${failures} FAILED` : 'draft-durability regression: all checks passed.'}`);
process.exit(failures ? 1 : 0);
