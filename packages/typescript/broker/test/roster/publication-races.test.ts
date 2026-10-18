/**
 * Roster publication races an e2e suite cannot stage.
 *
 * `e2e/broker/session-roster.test.ts` proves through a real broker that a live
 * owner's run state outranks the transcript watcher (Claude hooks owner,
 * watcher-inferred idle and needs-input, a real permission frame) and that a
 * replaced Claude session publishes one row. What it cannot stage is a watcher
 * reconcile held IN FLIGHT while the owner moves on, or replaced, or a carry
 * from an unread adapter racing the selection of a native incarnation: those
 * need an adapter attach that waits on a gate. These are the production Hub,
 * publication boundary and delta journal, wired as `runtime.ts` wires them,
 * with a scripted adapter whose attach the test holds.
 */
import { describe, expect, test } from 'bun:test';
import { Hub, type ManagedConn } from '../../src/sessions/hub.ts';
import { filterSessionsByWindow, sessionWindowRepresentationExpiry } from '../../src/roster/roster-http.ts';
import { RosterRevisionStore } from '../../src/roster/roster-revision.ts';
import {
  createRosterPublicationBoundary,
  NativeIncarnationPublicationAuthority,
} from '../../src/roster/roster-publication.ts';
import {
  AgentRegistry,
  type AgentMessage,
  type SessionConnection,
  type SessionInfo,
} from '../../../adapter-api/src/index.ts';

const MACHINE = 'publication-races';

type Emitter = SessionConnection & { emit: (message: AgentMessage) => void; closed: () => boolean };

function fakeConn(info: SessionInfo): Emitter {
  const handlers = new Set<(message: AgentMessage) => void>();
  let closed = false;
  const conn: any = {
    info: structuredClone(info),
    emit: (message: AgentMessage) => { for (const handler of [...handlers]) handler(message); },
    closed: () => closed,
    getHistory: async () => [],
    subscribe: (handler: (message: AgentMessage) => void) => { handlers.add(handler); return () => handlers.delete(handler); },
    sendPrompt: async () => {},
    respondPermission: async () => {},
    close: async () => { closed = true; },
  };
  return conn as Emitter;
}

const codexInfo = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  tool: 'codex',
  title: `orch ${id}`,
  cwd: '/tmp/cosyncing-orch',
  nativeId: `thread-${id}`,
  status: 'idle',
  attachMode: 'live',
  updatedAt: 10_000,
  control: {
    drive: { supported: true, state: 'driving' },
    terminalSync: { supported: true, syncAvailable: true, active: false },
  },
  ...over,
} as SessionInfo);

const observing = {
  drive: { supported: true, state: 'observing' },
  terminalSync: { supported: true, syncAvailable: true, active: false },
} as SessionInfo['control'];
const syncActive = {
  drive: { supported: true, state: 'unavailable' },
  terminalSync: { supported: true, syncAvailable: true, active: true, presence: 'shared' },
} as SessionInfo['control'];

/** A bounded rollout catch-up snapshot: observe-class, inferred idle. */
const watcherIdle = (id: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  codexInfo(id, { status: 'idle', attachMode: 'observe', control: observing, ...over });

/** The production pieces, wired as `runtime.ts` wires them, around a scripted adapter. */
function world() {
  const journal = new RosterRevisionStore(512);
  const decorate = (info: SessionInfo): SessionInfo => structuredClone({ ...info, machine: MACHINE });
  const plans = new Map<string, { next: () => Emitter; gate?: Promise<void>; entered?: () => void }>();
  const attaches: string[] = [];
  const registry = new AgentRegistry();
  registry.register({
    id: 'codex',
    displayName: 'Codex (scripted)',
    capabilities: {} as any,
    isAvailable: async () => true,
    discoverSessions: async () => [],
    attach: async (id: string) => {
      attaches.push(id);
      const plan = plans.get(id);
      if (!plan) throw new Error(`no attach plan for ${id}`);
      plan.entered?.();
      if (plan.gate) await plan.gate;
      return plan.next();
    },
  } as any);
  const authority = new NativeIncarnationPublicationAuthority();
  let boundary!: ReturnType<typeof createRosterPublicationBoundary>;
  const hub = new Hub(registry, 15_000, undefined, { onSessionInfo: (info) => boundary.publishOwnerFrame(info) });
  boundary = createRosterPublicationBoundary({
    liveOwners: () => hub.liveSnapshot(),
    publish: (info: SessionInfo) => journal.observe(decorate(info), MACHINE),
    acceptWatcher: (info: SessionInfo) => authority.acceptsWatcher(info),
    reconcile: (info: SessionInfo) => hub.refreshExternalSession(decorate(info)),
    onReconcileError: () => {},
  });
  /** Hold the next attach for `id` until released; resolves `entered` once it is waiting. */
  const holdAttach = (id: string, next: () => Emitter) => {
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    plans.set(id, { next, gate: new Promise<void>((resolve) => { release = resolve; }), entered });
    return { reached, release };
  };
  /** Status values journalled for one session after `after`, collapsing repeats. */
  const statusTrail = (after: number, id: string): string[] => {
    const trail: string[] = [];
    for (const delta of journal.eventsAfter(after).deltas) {
      if (delta.sessionId !== id || delta.removed) continue;
      const status = String(delta.session?.status ?? '');
      if (trail.at(-1) !== status) trail.push(status);
    }
    return trail;
  };
  return { journal, plans, attaches, hub, boundary, authority, holdAttach, statusTrail };
}

describe('a watcher reconcile held in flight', () => {
  test('cannot overwrite the owner frames that land while it waits, and queued snapshots coalesce', async () => {
    const { journal, plans, attaches, hub, boundary, holdAttach, statusTrail } = world();
    const id = 's-held';
    const observed = fakeConn(codexInfo(id, { attachMode: 'observe', control: observing }));
    plans.set(id, { next: () => observed });
    await hub.ensure('codex', id);
    const start = journal.revision;
    observed.emit({ type: 'status', status: 'running' } as AgentMessage);

    // Sync became active, so the reconcile reattaches; the reattach is held.
    const upgraded = fakeConn(codexInfo(id, { status: 'working', control: syncActive }));
    const held = holdAttach(id, () => upgraded);
    boundary.submitWatcherSnapshot(watcherIdle(id, { title: 'S1 stale', control: syncActive, updatedAt: 11_000 }));
    await held.reached;

    observed.emit({ type: 'permission-request', requestId: 'r1', title: 'gate' } as AgentMessage);
    boundary.submitWatcherSnapshot(watcherIdle(id, { title: 'S2 coalesced away', control: syncActive, updatedAt: 12_000 }));
    boundary.submitWatcherSnapshot(watcherIdle(id, { title: 'S3 newest', control: syncActive, updatedAt: 13_000 }));
    expect(statusTrail(start, id)).toContain('needs-input');

    held.release();
    await boundary.settle();
    expect(statusTrail(start, id)).not.toContain('idle');
    expect(attaches.filter((attached) => attached === id).length).toBeLessThanOrEqual(2);
    expect(hub.getConn('codex', id)?.conn.info.title).not.toBe('S2 coalesced away');
    // The upgraded connection's exact projection takes over, never the inferred idle.
    expect(hub.getConn('codex', id)?.conn).toBe(upgraded);
    expect(hub.getConn('codex', id)?.status).toBe('working');
    await hub.dispose();
  });

  test('is discarded when the owner is replaced underneath it, and its connection is closed', async () => {
    const { journal, plans, hub, boundary, holdAttach, statusTrail } = world();
    const id = 's-replaced';
    const original = fakeConn(codexInfo(id, { attachMode: 'observe', control: observing }));
    plans.set(id, { next: () => original });
    await hub.ensure('codex', id);
    original.emit({ type: 'status', status: 'running' } as AgentMessage);

    const stale = fakeConn(codexInfo(id, { status: 'idle', title: 'stale attach result' }));
    const held = holdAttach(id, () => stale);
    boundary.submitWatcherSnapshot(watcherIdle(id, { control: syncActive, updatedAt: 11_000 }));
    await held.reached;

    const start = journal.revision;
    await hub.evict('codex', id, 'replaced');
    const replacement = fakeConn(codexInfo(id, { status: 'working', title: 'replacement owner' }));
    hub.adopt('codex', id, replacement);
    held.release();
    await boundary.settle();
    const managed = hub.getConn('codex', id) as ManagedConn;
    expect(managed.conn).toBe(replacement);
    expect(stale.closed()).toBe(true);
    expect(managed.status).toBe('working');
    expect(statusTrail(start, id)).not.toContain('idle');

    // Qualification now answers to the replacement.
    boundary.submitWatcherSnapshot(watcherIdle(id, { updatedAt: 30_000 }));
    await boundary.settle();
    replacement.emit({ type: 'permission-request', requestId: 'r2', title: 'gate' } as AgentMessage);
    const trail = statusTrail(start, id);
    expect(trail).not.toContain('idle');
    expect(trail.at(-1)).toBe('needs-input');
    await hub.dispose();
  });
});

describe('native incarnation selection', () => {
  test('an exact native replacement retires the superseded owner exactly once', async () => {
    const ended: string[] = [];
    const registry = new AgentRegistry();
    const hub = new Hub(registry, 15_000, undefined, { onSessionEnded: (info) => ended.push(info.id) });
    const nativeId = 'claude-bridge:exact-incarnation';
    const old = fakeConn({ ...codexInfo('claude-old', { status: 'working', nativeId }), tool: 'claude' });
    hub.adopt('claude', 'claude-old', old);
    const replacement: SessionInfo = { ...codexInfo('claude-new', { status: 'idle', nativeId }), tool: 'claude' };
    const retired = await hub.retireSupersededOwners([replacement]);
    const again = await hub.retireSupersededOwners([replacement]);
    expect(retired.map((info) => info.id)).toEqual(['claude-old']);
    expect(hub.getConn('claude', 'claude-old')).toBeUndefined();
    expect(old.closed()).toBe(true);
    expect(again).toEqual([]);
    expect(ended).toEqual(['claude-old']);
    await hub.dispose();
  });

  test('a late or concurrent watcher frame of the old incarnation cannot reverse the selection', async () => {
    const { journal, hub, authority } = world();
    let gate: Promise<void> = Promise.resolve();
    const accepted: string[] = [];
    const boundary = createRosterPublicationBoundary({
      liveOwners: () => hub.liveSnapshot(),
      publish: (info: SessionInfo) => journal.observe(info, MACHINE),
      acceptWatcher: (info: SessionInfo) => authority.acceptsWatcher(info),
      onWatcherAccepted: (info: SessionInfo) => accepted.push(info.id),
      reconcile: async () => { await gate; },
    });
    const nativeId = 'claude-bridge:watcher-generation';
    const oldInfo = { ...codexInfo('watcher-old', { nativeId, status: 'working' }), tool: 'claude' } as SessionInfo;
    const newInfo = { ...codexInfo('watcher-new', { nativeId, status: 'idle' }), tool: 'claude' } as SessionInfo;
    const oldConn = fakeConn(oldInfo);
    const newConn = fakeConn(newInfo);
    hub.adopt('claude', newInfo.id, newConn);
    journal.observe(newInfo, MACHINE);
    expect(authority.reconcile([newInfo]).map((info: SessionInfo) => info.id)).toEqual([newInfo.id]);

    const late = journal.revision;
    boundary.submitWatcherSnapshot(oldInfo);
    await boundary.settle();
    expect(hub.getConn('claude', newInfo.id)?.conn).toBe(newConn);
    expect(newConn.closed()).toBe(false);
    expect(accepted).not.toContain(oldInfo.id);
    expect(journal.eventsAfter(late).deltas.map((delta) => delta.sessionId)).not.toContain(oldInfo.id);

    let release!: () => void;
    gate = new Promise<void>((resolve) => { release = resolve; });
    const concurrent = journal.revision;
    boundary.submitWatcherSnapshot(newInfo); // holds the native-identity drain
    boundary.submitWatcherSnapshot(oldInfo);
    boundary.submitWatcherSnapshot(newInfo);
    release();
    await boundary.settle();
    expect(journal.eventsAfter(concurrent).deltas.map((delta) => delta.sessionId)).not.toContain(oldInfo.id);
    expect(newConn.closed()).toBe(false);

    // Two incarnations the generations cannot order: neither is retired.
    const ambiguous = authority.reconcile([oldInfo, newInfo]);
    hub.adopt('claude', oldInfo.id, oldConn);
    expect(ambiguous).toEqual([]);
    expect(await hub.retireSupersededOwners(ambiguous)).toEqual([]);
    expect([oldConn.closed(), newConn.closed()]).toEqual([false, false]);
    await hub.dispose();
  });

  test("a carry from an adapter nobody could read selects nothing and retires no live owner", async () => {
    const { journal, hub, authority } = world();
    const boundary = createRosterPublicationBoundary({
      liveOwners: () => hub.liveSnapshot(),
      publish: (info: SessionInfo) => journal.observe(info, MACHINE),
      acceptWatcher: (info: SessionInfo) => authority.acceptsWatcher(info),
      reconcile: async () => {},
    });
    const nativeId = 'claude-bridge:unread-leg';
    const oldInfo = { ...codexInfo('carried-old', { nativeId, status: 'idle' }), tool: 'claude' } as SessionInfo;
    const newInfo = { ...codexInfo('live-new', { nativeId, status: 'working' }), tool: 'claude' } as SessionInfo;
    const ompInfo = { ...codexInfo('omp-live', { nativeId: 'omp:whole-leg' }), tool: 'omp' } as SessionInfo;
    const newConn = fakeConn(newInfo);
    // What a real broker holds: a complete sweep selected the old incarnation,
    // and only then did its replacement appear as a live owner.
    authority.reconcile([oldInfo, ompInfo]);
    hub.adopt('claude', newInfo.id, newConn);

    // The next sweep could not read Claude; the old row is only its carry.
    const canonical = authority.reconcile([oldInfo, ompInfo], { withheldTools: ['claude'] });
    expect(canonical.map((info: SessionInfo) => info.id)).toEqual([ompInfo.id]);
    expect(await hub.retireSupersededOwners(canonical)).toEqual([]);
    expect(hub.getConn('claude', newInfo.id)?.conn).toBe(newConn);
    expect(newConn.closed()).toBe(false);
    // The retained selection is unchanged, so the owner's exact frames still
    // publish while its watcher-inferred ones wait for a sweep that reads Claude.
    expect([authority.acceptsWatcher(oldInfo), authority.acceptsWatcher(newInfo)]).toEqual([true, false]);
    const frames = journal.revision;
    boundary.publishOwnerFrame({ ...newInfo, title: 'exact owner frame' });
    await boundary.settle();
    expect(journal.eventsAfter(frames).deltas.some((delta) => delta.session?.title === 'exact owner frame')).toBe(true);
    const watcher = journal.revision;
    boundary.submitWatcherSnapshot({ ...newInfo, title: 'inferred watcher frame' });
    await boundary.settle();
    expect(journal.eventsAfter(watcher).deltas.some((delta) => delta.session?.title === 'inferred watcher frame')).toBe(false);

    // Once Claude is read again, the superseded incarnation retires as usual.
    const recovered = authority.reconcile([newInfo, ompInfo]);
    hub.adopt('claude', oldInfo.id, fakeConn(oldInfo));
    expect((await hub.retireSupersededOwners(recovered)).map((info) => info.id)).toEqual([oldInfo.id]);
    expect(newConn.closed()).toBe(false);
    expect([authority.acceptsWatcher(newInfo), authority.acceptsWatcher(oldInfo)]).toEqual([true, false]);
    await hub.dispose();
  });
});

// The exact millisecond and backwards clock are not reproducible over a real
// socket. Exercise the same membership/expiry definition with a controlled clock.
test('bounded publication expires at the first excluded millisecond, not the inclusive cutoff', () => {
  const day = 86_400_000;
  const now = 20 * day;
  const rows = [
    codexInfo('parent', { updatedAt: now - day }),
    codexInfo('old-child', { updatedAt: now - 8 * day, parentThreadId: 'parent' }),
    codexInfo('old-conversation', { updatedAt: now - 10 * day }),
    codexInfo('old-active', { updatedAt: now - 30 * day, status: 'working' }),
    codexInfo('cutoff', { updatedAt: now - 7 * day }),
  ];
  const journal = new RosterRevisionStore();
  const publish = (at: number) => {
    const included = filterSessionsByWindow(rows, 7 * day, at);
    journal.reconcile(included, MACHINE);
    return sessionWindowRepresentationExpiry(included, 7 * day);
  };
  expect(publish(now)).toBe(now + 1);
  expect(journal.snapshot().map((row) => row.id)).toEqual(['parent', 'old-active', 'cutoff']);
  const before = journal.revision;
  expect(publish(now + 1)).toBe(now + 6 * day + 1);
  expect(journal.eventsAfter(before).deltas).toMatchObject([{ sessionId: 'cutoff', removed: true }]);
  expect(publish(now - 1)).toBe(now + 1);
  rows[3]!.status = 'idle';
  publish(now);
  expect(journal.snapshot().map((row) => row.id)).not.toContain('old-active');
});
