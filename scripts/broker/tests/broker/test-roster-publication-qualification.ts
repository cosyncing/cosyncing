#!/usr/bin/env bun
/**
 * R0c.1 regression — adapter watcher status must be OWNER-QUALIFIED before any roster revision is
 * written.
 *
 * Reproduced production defect: during one uninterrupted Codex turn, the roster delta journal
 * recorded three Idle → Working reversals with one `task_started` and no native terminal marker.
 * The watcher callback journaled the adapter's raw inferred snapshot (`observeRosterViews(info)`)
 * before `Hub.refreshExternalSession` reconciled the exact live owner, so a bounded rollout
 * catch-up published Idle and the Hub restored Working.
 *
 * This suite drives the REAL publication components — the production Hub/ManagedConn status
 * machinery, the production RosterRevisionStore delta journal (the same store + `eventsAfter`
 * payload `/api/session-roster-deltas` serves), and the production qualification boundary — wired
 * exactly as `runtime.ts` wires them. When the boundary module is absent (the accepted base), the
 * suite falls back to the base runtime's watcher/hub wiring VERBATIM, so running this file on the
 * base demonstrates the exact defect instead of a module-resolution error.
 *
 * Lanes (sessions are codex-shaped; the machinery is capability-driven, never per-tool):
 *   A  exact live Working + raw watcher Idle → NO Idle roster revision (older, same, and newer
 *      watcher `updatedAt` all lose — recency never outranks exact authority), run identically for
 *      a main-shaped and a subagent-shaped session; the authoritative completion then emits
 *      EXACTLY ONE Idle revision and later watcher idle snapshots add none.
 *   A2 the owner owns ALL run states: a watcher-INFERRED needs-input never overrides a live
 *      Working or Idle owner (journal or projection, observe- and live-class snapshots alike);
 *      a real permission frame on the owned connection remains the route to exact Needs input.
 *   B  a watcher reconciliation held in flight (gated reattach) across newer owner frames cannot
 *      overwrite them; queued watcher snapshots are coalesced to the newest and serialized per
 *      session.
 *   C  owner replacement while a watcher reattach is in flight invalidates the stale result (the
 *      replacement keeps its connection; the stale attach is closed).
 *   D  a session with NO live Hub owner still accepts truthful watcher status (working /
 *      needs-input / idle) raw.
 *   E  anti-drift: runtime.ts actually routes BOTH publication paths through the boundary.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hub, type ManagedConn } from '../../../../packages/typescript/broker/src/hub.ts';
import { RosterRevisionStore } from '../../../../packages/typescript/broker/src/roster-revision.ts';
import {
  AgentRegistry,
  type AgentMessage,
  type SessionConnection,
  type SessionInfo,
} from '../../../../packages/typescript/adapter-api/src/index.ts';

let failures = 0;
const check = (label: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  — ${extra}` : ''}`);
  if (!ok) failures++;
};
const REPO = join(import.meta.dir, '..', '..', '..', '..');
const MACHINE = 'r0c1-qualification';

// ── real roster views + real Hub, wired like runtime.ts ────────────────────────────────────────
const rosterRevision = new RosterRevisionStore(512);
const decorate = (info: SessionInfo): SessionInfo => structuredClone({ ...info, machine: MACHINE });
const observeRosterViews = (info: SessionInfo): void => {
  rosterRevision.observe(decorate(info), MACHINE);
};

type Emitter = SessionConnection & { emit: (m: AgentMessage) => void; closed: () => boolean };
function fakeConn(info: SessionInfo): Emitter {
  const handlers = new Set<(m: AgentMessage) => void>();
  let closed = false;
  const conn: any = {
    info: structuredClone(info),
    emit: (m: AgentMessage) => { for (const h of [...handlers]) h(m); },
    closed: () => closed,
    getHistory: async () => [],
    subscribe: (h: (m: AgentMessage) => void) => { handlers.add(h); return () => handlers.delete(h); },
    sendPrompt: async () => {},
    respondPermission: async () => {},
    close: async () => { closed = true; },
  };
  return conn as Emitter;
}

/** Per-session programmable attach: `gate(id)` makes the next attach for that id block until released. */
const attachPlans = new Map<string, { next: () => Emitter; gate?: Promise<void> }>();
const attachLog: string[] = [];
const registry = new AgentRegistry();
registry.register({
  id: 'codex',
  displayName: 'Codex (fake)',
  capabilities: {} as any,
  isAvailable: async () => true,
  discoverSessions: async () => [],
  attach: async (id: string) => {
    attachLog.push(id);
    const plan = attachPlans.get(id);
    if (!plan) throw new Error(`no attach plan for ${id}`);
    if (plan.gate) await plan.gate;
    return plan.next();
  },
} as any);

let boundary: {
  publishOwnerFrame(info: SessionInfo): void;
  submitWatcherSnapshot(info: SessionInfo): void;
  settle(): Promise<void>;
};
const hub = new Hub(registry, 15000, undefined, {
  onSessionInfo: (info) => boundary.publishOwnerFrame(info),
});

const boundaryModule = await import('../../../../packages/typescript/broker/src/roster-publication.ts')
  .catch(() => undefined);
if (boundaryModule) {
  // Production wiring — mirrors runtime.ts exactly.
  const nativeAuthority = new boundaryModule.NativeIncarnationPublicationAuthority();
  boundary = boundaryModule.createRosterPublicationBoundary({
    liveOwners: () => hub.liveSnapshot(),
    publish: observeRosterViews,
    acceptWatcher: (info: SessionInfo) => nativeAuthority.acceptsWatcher(info),
    reconcile: (info: SessionInfo) => hub.refreshExternalSession(decorate(info)),
    onReconcileError: () => {},
  });
} else {
  // BASE-REPRODUCTION WIRING — the watcher callback and Hub onSessionInfo hook of
  // packages/typescript/broker/src/runtime.ts at 1bc738a, verbatim. Only reachable when the
  // qualified publication boundary module does not exist (fail-proof runs on the accepted base).
  const inflight = new Set<Promise<void>>();
  boundary = {
    publishOwnerFrame: (info) => { observeRosterViews(info); },
    submitWatcherSnapshot: (info) => {
      const decorated = decorate(info);
      observeRosterViews(info);
      const p = hub.refreshExternalSession(decorated).catch(() => {});
      inflight.add(p);
      void p.finally(() => inflight.delete(p));
    },
    settle: async () => { while (inflight.size > 0) await Promise.all([...inflight]); },
  };
}
console.log(`mode: ${boundaryModule ? 'qualified boundary (production wiring)' : 'BASE reproduction wiring'}`);

// ── codex-shaped fixtures ──────────────────────────────────────────────────────────────────────
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
/** A bounded rollout catch-up snapshot: observe-class, inferred idle, drive observing. */
const watcherIdle = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => codexInfo(id, {
  status: 'idle',
  attachMode: 'observe',
  control: {
    drive: { supported: true, state: 'observing' },
    terminalSync: { supported: true, syncAvailable: true, active: false },
  },
  ...over,
});

/** Every status value journaled for one session after `after`, in revision order. */
function statusTrail(after: number, sessionId: string): string[] {
  const trail: string[] = [];
  for (const delta of rosterRevision.eventsAfter(after).deltas) {
    if (delta.sessionId !== sessionId || delta.removed) continue;
    const status = String(delta.session?.status ?? '');
    if (trail.at(-1) !== status) trail.push(status);
  }
  return trail;
}
function idleRevisions(after: number, sessionId: string): number {
  return rosterRevision.eventsAfter(after).deltas.filter((delta) =>
    delta.sessionId === sessionId && !delta.removed &&
    (delta.changedFields.includes('status') || delta.changedFields.includes('session')) &&
    delta.session?.status === 'idle').length;
}

// ── Lane A — exact live Working + raw watcher Idle, main- and subagent-shaped ──────────────────
async function laneA(label: string, id: string, shape: Partial<SessionInfo>): Promise<string[]> {
  const conn = fakeConn(codexInfo(id, shape));
  attachPlans.set(id, { next: () => conn });
  await hub.ensure('codex', id);
  const start = rosterRevision.revision;
  conn.emit({ type: 'status', status: 'running' } as AgentMessage);
  check(`A/${label} the live owner's running frame journals Working`,
    statusTrail(start, id).at(-1) === 'working', statusTrail(start, id).join('→'));

  // Bounded catch-up: raw inferred Idle with an OLDER, the SAME, and a NEWER updatedAt than the
  // owner frame. None may reorder status — exact authority is not a recency contest.
  for (const updatedAt of [9_000, 10_000, 99_000]) {
    boundary.submitWatcherSnapshot(watcherIdle(id, { ...shape, updatedAt }));
    await boundary.settle();
  }
  const trail = statusTrail(start, id);
  check(`A/${label} no watcher Idle revision while the exact turn is active (older/same/newer updatedAt)`,
    !trail.includes('idle'), trail.join('→'));
  check(`A/${label} the owner connection's projection still carries the exact run status`,
    hub.getConn('codex', id)?.conn.info.status === 'working',
    String(hub.getConn('codex', id)?.conn.info.status));

  // Authoritative completion → exactly one Idle revision; later watcher idle adds none.
  conn.emit({ type: 'status', status: 'idle' } as AgentMessage);
  check(`A/${label} the authoritative completion journals exactly one Idle revision`,
    idleRevisions(start, id) === 1 && statusTrail(start, id).at(-1) === 'idle',
    `idleRevisions=${idleRevisions(start, id)} trail=${statusTrail(start, id).join('→')}`);
  boundary.submitWatcherSnapshot(watcherIdle(id, { ...shape, updatedAt: 120_000 }));
  await boundary.settle();
  check(`A/${label} a post-terminal watcher idle snapshot adds no second Idle status flip`,
    idleRevisions(start, id) === 1 && statusTrail(start, id).filter((s) => s === 'idle').length === 1,
    `idleRevisions=${idleRevisions(start, id)}`);
  return statusTrail(start, id);
}

const mainTrail = await laneA('main', 's-main', {});
const subagentTrail = await laneA('subagent', 's-sub', {
  origin: 'subagent',
  parentThreadId: 'thread-s-main',
  attachMode: 'observe',
  control: {
    drive: { supported: false, state: 'unavailable' },
    terminalSync: { supported: false, syncAvailable: false, active: false },
  },
} as Partial<SessionInfo>);
check('A main- and subagent-shaped sessions publish the identical status sequence',
  mainTrail.join('→') === subagentTrail.join('→'),
  `${mainTrail.join('→')} vs ${subagentTrail.join('→')}`);

// ── Lane A2 — the owner owns ALL run states: watcher needs-input never overrides ───────────────
{
  const id = 's-owner-owns-status';
  const conn = fakeConn(codexInfo(id));
  attachPlans.set(id, { next: () => conn });
  await hub.ensure('codex', id);
  const start = rosterRevision.revision;
  conn.emit({ type: 'status', status: 'running' } as AgentMessage);
  // Inferred needs-input in BOTH connection classes: observe-class exercises the qualification +
  // downgrade-reattach path, live-class (same class as the owner) exercises the plain
  // metadata-refresh `updateInfo` path in Hub.refreshExternalSession.
  boundary.submitWatcherSnapshot(watcherIdle(id, { status: 'needs-input', updatedAt: 50_000 }));
  await boundary.settle();
  boundary.submitWatcherSnapshot(codexInfo(id, { status: 'needs-input', updatedAt: 51_000 }));
  await boundary.settle();
  const workingTrail = statusTrail(start, id);
  check('A2 an inferred watcher needs-input never overrides a live Working owner',
    !workingTrail.includes('needs-input') && workingTrail.at(-1) === 'working', workingTrail.join('→'));
  check('A2 the Working owner projection is never weakened to inferred needs-input',
    hub.getConn('codex', id)?.status === 'working', String(hub.getConn('codex', id)?.status));

  conn.emit({ type: 'status', status: 'idle' } as AgentMessage);
  const idleFrom = rosterRevision.revision;
  boundary.submitWatcherSnapshot(watcherIdle(id, { status: 'needs-input', updatedAt: 60_000 }));
  await boundary.settle();
  boundary.submitWatcherSnapshot(codexInfo(id, { status: 'needs-input', updatedAt: 61_000 }));
  await boundary.settle();
  const idleTrail = statusTrail(idleFrom, id);
  check('A2 an inferred watcher needs-input never overrides a live Idle owner',
    !idleTrail.includes('needs-input'), idleTrail.join('→') || '(none)');
  check('A2 the Idle owner projection stays idle',
    hub.getConn('codex', id)?.status === 'idle', String(hub.getConn('codex', id)?.status));

  // Exact Needs input still has its one legitimate route: a real permission frame on the owned conn.
  conn.emit({ type: 'permission-request', requestId: 'rq-a2', title: 'gate' } as AgentMessage);
  check('A2 a real permission frame on the owned connection still publishes exact needs-input',
    statusTrail(idleFrom, id).at(-1) === 'needs-input' && hub.getConn('codex', id)?.status === 'needs-input',
    statusTrail(idleFrom, id).join('→') || '(none)');
}

// ── Lane B — a held watcher reconciliation cannot overwrite newer owner frames ─────────────────
{
  const id = 's-held';
  const observed = fakeConn(codexInfo(id, {
    attachMode: 'observe',
    control: {
      drive: { supported: true, state: 'observing' },
      terminalSync: { supported: true, syncAvailable: true, active: false },
    },
  }));
  attachPlans.set(id, { next: () => observed });
  await hub.ensure('codex', id);
  const start = rosterRevision.revision;
  observed.emit({ type: 'status', status: 'running' } as AgentMessage);

  // S1: sync became active → the reconcile takes the reattach path, which we hold open.
  let release!: () => void;
  const upgraded = fakeConn(codexInfo(id, {
    status: 'working',
    control: {
      drive: { supported: true, state: 'unavailable' },
      terminalSync: { supported: true, syncAvailable: true, active: true },
    },
  }));
  attachPlans.set(id, { next: () => upgraded, gate: new Promise<void>((r) => { release = r; }) });
  const syncActive = {
    drive: { supported: true, state: 'unavailable' },
    terminalSync: { supported: true, syncAvailable: true, active: true },
  } as SessionInfo['control'];
  boundary.submitWatcherSnapshot(watcherIdle(id, { title: 'S1 stale', control: syncActive, updatedAt: 11_000 }));
  await Bun.sleep(20); // the held reconcile is now in flight

  // Newer owner frames land while S1 is held; S2 then S3 queue behind it (S2 must coalesce away).
  observed.emit({ type: 'permission-request', requestId: 'r1', title: 'gate' } as AgentMessage);
  boundary.submitWatcherSnapshot(watcherIdle(id, { title: 'S2 coalesced away', control: syncActive, updatedAt: 12_000 }));
  boundary.submitWatcherSnapshot(watcherIdle(id, { title: 'S3 newest', control: syncActive, updatedAt: 13_000 }));
  const heldTrail = statusTrail(start, id);
  check('B newer owner frames journal while the watcher reconcile is held',
    heldTrail.includes('needs-input'), heldTrail.join('→'));
  release();
  await boundary.settle();
  const trail = statusTrail(start, id);
  check('B a watcher callback held across newer owner frames never journals Idle',
    !trail.includes('idle'), trail.join('→'));
  check('B queued watcher snapshots coalesce to the newest and stay serialized',
    attachLog.filter((a) => a === id).length <= 2 &&
      hub.getConn('codex', id)?.conn.info.title !== 'S2 coalesced away',
    `attaches=${attachLog.filter((a) => a === id).length} title=${hub.getConn('codex', id)?.conn.info.title}`);
  // The sync upgrade is a real class change: the upgraded connection's EXACT projection takes over
  // (provisional pending input from the retired transport is cleared, R0c replacement semantics),
  // and the roster reflects that exact status — never the watcher's inferred Idle.
  check('B the landed reattach installs the upgraded connection\'s exact projection',
    hub.getConn('codex', id)?.conn === upgraded && hub.getConn('codex', id)?.status === 'working',
    `status=${hub.getConn('codex', id)?.status}`);
}

// ── Lane C — owner replacement invalidates an in-flight watcher reattach ───────────────────────
{
  const id = 's-replaced';
  const original = fakeConn(codexInfo(id, {
    attachMode: 'observe',
    control: {
      drive: { supported: true, state: 'observing' },
      terminalSync: { supported: true, syncAvailable: true, active: false },
    },
  }));
  attachPlans.set(id, { next: () => original });
  await hub.ensure('codex', id);
  original.emit({ type: 'status', status: 'running' } as AgentMessage);

  let release!: () => void;
  const stale = fakeConn(codexInfo(id, { status: 'idle', title: 'stale attach result' }));
  attachPlans.set(id, { next: () => stale, gate: new Promise<void>((r) => { release = r; }) });
  boundary.submitWatcherSnapshot(watcherIdle(id, {
    control: {
      drive: { supported: true, state: 'unavailable' },
      terminalSync: { supported: true, syncAvailable: true, active: true },
    },
    updatedAt: 11_000,
  }));
  await Bun.sleep(20); // the reattach for the old owner is now held in flight

  // The old owner retires and a replacement takes the session (the R0c seeded-replacement path).
  const start = rosterRevision.revision;
  await hub.evict('codex', id, 'replaced');
  const replacement = fakeConn(codexInfo(id, { status: 'working', title: 'replacement owner' }));
  hub.adopt('codex', id, replacement);
  release();
  await boundary.settle();
  const mc = hub.getConn('codex', id) as ManagedConn;
  check('C the stale in-flight attach result never displaces the replacement owner',
    mc.conn === replacement && mc.conn.info.title === 'replacement owner',
    `title=${mc.conn.info.title}`);
  check('C the stale attach connection is closed, not leaked', stale.closed() === true);
  check('C the replacement seeds the exact Working authority with no Idle gap in the journal',
    mc.status === 'working' && !statusTrail(start, id).includes('idle'),
    `status=${mc.status} trail=${statusTrail(start, id).join('→') || '(none)'}`);
  // Qualification now answers to the REPLACEMENT owner: a fresh watcher catch-up idle still loses,
  // and the replacement's own live evidence still publishes.
  boundary.submitWatcherSnapshot(watcherIdle(id, { updatedAt: 30_000 }));
  await boundary.settle();
  replacement.emit({ type: 'permission-request', requestId: 'r2', title: 'gate' } as AgentMessage);
  const trail = statusTrail(start, id);
  check('C watcher idle loses to the replacement owner while its live evidence publishes',
    !trail.includes('idle') && trail.at(-1) === 'needs-input', trail.join('→') || '(none)');
}

// ── Lane C2 — exact native identity retires a cross-id owner exactly once ─────────────────────
{
  const ended: string[] = [];
  const retirementHub = new Hub(registry, 15000, undefined, {
    onSessionEnded: (info) => ended.push(info.id),
  });
  const nativeId = 'claude-bridge:exact-incarnation';
  const old = fakeConn({
    ...codexInfo('claude-old', { status: 'working', nativeId }),
    tool: 'claude',
  });
  retirementHub.adopt('claude', 'claude-old', old);
  const replacementInfo: SessionInfo = {
    ...codexInfo('claude-new', { status: 'idle', nativeId }),
    tool: 'claude',
  };
  const retired = await retirementHub.retireSupersededOwners([replacementInfo]);
  const duplicate = await retirementHub.retireSupersededOwners([replacementInfo]);
  check(
    'C2 exact native replacement removes the superseded cross-id owner before publication',
    retired.length === 1 &&
      retired[0]?.id === 'claude-old' &&
      retirementHub.getConn('claude', 'claude-old') === undefined &&
      old.closed(),
  );
  check(
    'C2 duplicate retirement produces one ended/Attention cleanup outcome',
    duplicate.length === 0 && ended.join(',') === 'claude-old',
    `retired=${duplicate.length} ended=${ended.join(',')}`,
  );
  await retirementHub.dispose();
}

// ── Lane C3 — watcher ordering cannot reverse complete-discovery incarnation authority ────────
if (boundaryModule) {
  const raceStore = new RosterRevisionStore(64);
  const raceHub = new Hub(registry);
  const authority = new boundaryModule.NativeIncarnationPublicationAuthority();
  const nativeId = 'claude-bridge:watcher-generation';
  const oldInfo = { ...codexInfo('watcher-old', { nativeId, status: 'working' }), tool: 'claude' };
  const newInfo = { ...codexInfo('watcher-new', { nativeId, status: 'idle' }), tool: 'claude' };
  const oldConn = fakeConn(oldInfo);
  const newConn = fakeConn(newInfo);
  raceHub.adopt('claude', newInfo.id, newConn);
  raceStore.observe(newInfo, MACHINE);
  const canonical = authority.reconcile([newInfo]);
  let releaseReconcile!: () => void;
  let reconcileGate = Promise.resolve();
  const acceptedWatchers: string[] = [];
  const raceBoundary = boundaryModule.createRosterPublicationBoundary({
    liveOwners: () => raceHub.liveSnapshot(),
    publish: (info: SessionInfo) => raceStore.observe(info, MACHINE),
    acceptWatcher: (info: SessionInfo) => authority.acceptsWatcher(info),
    onWatcherAccepted: (info: SessionInfo) => acceptedWatchers.push(info.id),
    reconcile: async () => { await reconcileGate; },
  });
  check(
    'C3 complete discovery selects one canonical native replacement',
    canonical.length === 1 && canonical[0]?.id === newInfo.id,
    JSON.stringify(canonical.map((info: SessionInfo) => info.id)),
  );

  const lateStart = raceStore.revision;
  raceBoundary.submitWatcherSnapshot(oldInfo);
  await raceBoundary.settle();
  check(
    'C3 a late old watcher neither retires the new owner nor republishes the old row',
    raceHub.getConn('claude', newInfo.id)?.conn === newConn &&
      !newConn.closed() &&
      !acceptedWatchers.includes(oldInfo.id) &&
      raceStore.eventsAfter(lateStart).deltas.every((delta) => delta.sessionId !== oldInfo.id),
  );

  reconcileGate = new Promise<void>((resolve) => { releaseReconcile = resolve; });
  const concurrentStart = raceStore.revision;
  raceBoundary.submitWatcherSnapshot(newInfo); // holds the native-key drain in flight
  raceBoundary.submitWatcherSnapshot(oldInfo);
  raceBoundary.submitWatcherSnapshot(newInfo);
  releaseReconcile();
  await raceBoundary.settle();
  const concurrentDeltas = raceStore.eventsAfter(concurrentStart).deltas;
  check(
    'C3 concurrent old/new watcher snapshots serialize by native identity and converge to new',
    concurrentDeltas.every((delta) => delta.sessionId !== oldInfo.id) &&
      raceHub.getConn('claude', newInfo.id)?.conn === newConn && !newConn.closed(),
    JSON.stringify(concurrentDeltas.map((delta) => delta.sessionId)),
  );

  const ambiguous = authority.reconcile([oldInfo, newInfo]);
  raceHub.adopt('claude', oldInfo.id, oldConn);
  const retired = await raceHub.retireSupersededOwners(ambiguous);
  check(
    'C3 ambiguous generation selection retires neither incarnation',
    ambiguous.length === 0 && retired.length === 0 &&
      raceHub.getConn('claude', oldInfo.id)?.conn === oldConn &&
      raceHub.getConn('claude', newInfo.id)?.conn === newConn &&
      !oldConn.closed() && !newConn.closed(),
  );
  await raceHub.dispose();
}

// ── Lane D — no live Hub owner → truthful watcher status is accepted raw ───────────────────────
{
  const id = 's-unowned';
  const start = rosterRevision.revision;
  boundary.submitWatcherSnapshot(codexInfo(id, { status: 'working', updatedAt: 20_000 }));
  await boundary.settle();
  boundary.submitWatcherSnapshot(codexInfo(id, { status: 'needs-input', updatedAt: 21_000 }));
  await boundary.settle();
  boundary.submitWatcherSnapshot(codexInfo(id, { status: 'idle', updatedAt: 22_000 }));
  await boundary.settle();
  check('D with no live owner, truthful watcher working/needs-input/idle all publish',
    statusTrail(start, id).join('→') === 'working→needs-input→idle',
    statusTrail(start, id).join('→'));
}

// ── Lane E — anti-drift: runtime.ts routes BOTH paths through the qualified boundary ───────────
if (boundaryModule) {
  const runtimeSource = readFileSync(
    join(REPO, 'packages', 'typescript', 'broker', 'src', 'runtime.ts'),
    'utf8',
  );
  const watcherBlock = runtimeSource.match(/backend\.watchSessionInfo\?\.\(\(info\) => \{[\s\S]*?\}\)/)?.[0] ?? '';
  check('E runtime.ts submits watcher snapshots through the qualification boundary',
    watcherBlock.includes('rosterPublication.submitWatcherSnapshot(info)'), watcherBlock.slice(0, 200));
  check('E the runtime watcher callback no longer journals or reconciles raw snapshots directly',
    watcherBlock !== '' && !watcherBlock.includes('observeRosterViews(') && !watcherBlock.includes('refreshExternalSession('),
    watcherBlock.slice(0, 200));
  check('E runtime.ts publishes Hub owner frames through the same boundary',
    /onSessionInfo: \(info\) => \{\s*rosterPublication\.publishOwnerFrame\(info\);/.test(runtimeSource));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
