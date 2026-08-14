#!/usr/bin/env bun
/**
 * Regression — a terminal-bridge adopt must FOLD the mode-scoped Drive wrapper, and a mode-scoped
 * attach must JOIN a pinned bridge (issues-part2 item 3 re-flag, reproduced live 2026-07-12).
 *
 * The Hub keys `?mode=resume` attaches separately from the canonical `tool:id` identity by design
 * (observe tail vs drivable process are distinct owners). But a Pi bridge hello adopts under the
 * CANONICAL key only — before this fix, a session being DRIVEN kept its broker-owned pi process
 * alive under `pi:<id>#resume` while the TUI wrote the same JSONL: app prompts went to the hidden
 * process (never visible in the terminal), TUI turns never relayed, one file forked into two
 * conversations ("they still diverge, no true sync behaviour").
 *
 * A: adopt folds the client-bearing Drive wrapper into the canonical identity — SAME ManagedConn
 *    object survives (ws.data.mc stays valid), its conn is the bridge, the rival process is closed,
 *    and pre-adopt clients receive post-adopt messages.
 * B: with a pinned bridge, a later ?mode=resume ensure() JOINS it (no rival attach()).
 * C: adopt with both a clientless canonical wrapper AND a client-bearing Drive wrapper keeps the
 *    Drive wrapper and disposes the clientless one.
 * C2: when BOTH wrappers have clients, adoption migrates both subscribers and their runtime targets
 *     to the one bridge-backed survivor.
 * C3: terminal handoff refuses while a peer driver remains, then moves the last requester to
 *     Observe and closes Resume before returning.
 */
import { Hub } from '../../src/sessions/hub.ts';
import { ClientHandoffSequencer } from '../../src/sessions/client-handoff-sequencer.ts';
import { activeOwnerState, JoinExistingError } from '../../src/sessions/session-owner.ts';
import { AgentRegistry, type AgentMessage, type SessionConnection, type SessionInfo } from '../../../adapter-api/src/index.ts';
import { opencodeControlState } from '../../../adapters/opencode/src/index.ts';

let failures = 0;
const check = (label: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  — ${extra}` : ''}`);
  if (!ok) failures++;
};

function fakeConn(info: SessionInfo): SessionConnection & { closed: boolean; emit: (m: AgentMessage) => void } {
  const handlers = new Set<(m: AgentMessage) => void>();
  const conn: any = {
    info,
    closed: false,
    emit: (m: AgentMessage) => { for (const h of handlers) h(m); },
    getHistory: async () => [],
    subscribe: (h: (m: AgentMessage) => void) => { handlers.add(h); return () => handlers.delete(h); },
    sendPrompt: async () => {},
    respondPermission: async () => {},
    close: async () => { conn.closed = true; },
  };
  return conn;
}
const info = (id: string, attachMode: string): SessionInfo => ({ id, tool: 'pi', machine: 'test', title: 't', status: 'idle', attachMode } as SessionInfo);
const controlledInfo = (
  tool: string,
  id: string,
  attachMode: string,
  driveState: 'driving' | 'observing',
): SessionInfo => ({
  ...info(id, attachMode),
  tool,
  control: {
    drive: { supported: true, state: driveState },
    terminalSync: { supported: false, syncAvailable: false, active: false },
  },
} as SessionInfo);

// ── A: adopt folds the Drive wrapper ────────────────────────────────────────────────────────────
{
  const registry = new AgentRegistry();
  const driveConn = fakeConn(info('s1', 'resume'));
  registry.register({
    id: 'pi', displayName: 'Pi', capabilities: {} as any,
    isAvailable: async () => true, discoverSessions: async () => [],
    attach: async () => driveConn,
  } as any);
  const hub = new Hub(registry, 15000);

  const driveMc = await hub.ensure('pi', 's1', 'resume'); // the app's created-session Drive attach
  const seen: AgentMessage[] = [];
  const adoptHistories: any[][] = [];
  driveMc.addClient((ev: any) => {
    if (ev.kind === 'message') seen.push(ev.message);
    if (ev.kind === 'history') adoptHistories.push(ev.messages ?? []);
  });

  const bridgeConn = fakeConn(info('s1', 'live'));
  // A turn that happened in the TUI BEFORE the bridge registered (pi's hello-window twin of the
  // codex join→fold window): only the bridge's history/backfill knows it.
  (bridgeConn as any).getHistory = async () => [{ type: 'user-message', text: 'typed before the bridge hello' } as AgentMessage];
  const adopted = hub.adopt('pi', 's1', bridgeConn); // the TUI's hello

  check('A1 the Drive wrapper itself becomes the canonical identity (ws.data.mc stays valid)', adopted === driveMc);
  check('A2 the wrapper now speaks through the bridge conn', (adopted as any).conn === bridgeConn);
  check('A3 the rival broker-owned process was closed', driveConn.closed);
  check('A4 canonical lookup finds the folded wrapper', hub.getConn('pi', 's1') === driveMc);
  bridgeConn.emit({ type: 'notice', message: 'from the terminal' } as AgentMessage);
  check('A5 pre-adopt client receives post-adopt bridge messages', seen.some((m: any) => m.message === 'from the terminal'));
  await new Promise((r) => setTimeout(r, 100)); // resync is fire-and-forget off replaceConnection
  check('A6 adopt resyncs history so hello-window messages reach the open socket (pi twin of codex F4b)',
    adoptHistories.some((msgs) => msgs.some((m: any) => m?.text === 'typed before the bridge hello')), `histories=${adoptHistories.length}`);
}

// ── B: ensure(?mode=resume) joins a pinned bridge instead of spawning a rival ───────────────────
{
  let attachCalls = 0;
  const registry = new AgentRegistry();
  registry.register({
    id: 'pi', displayName: 'Pi', capabilities: {} as any,
    isAvailable: async () => true, discoverSessions: async () => [],
    attach: async () => { attachCalls++; return fakeConn(info('s2', 'resume')); },
  } as any);
  const hub = new Hub(registry, 15000);
  const bridgeConn = fakeConn(info('s2', 'live'));
  const bridged = hub.adopt('pi', 's2', bridgeConn);
  const joined = await hub.ensure('pi', 's2', 'resume');
  check('B1 mode-scoped attach JOINS the pinned bridge', joined === bridged);
  check('B2 no rival broker-owned process was spawned', attachCalls === 0, `attachCalls=${attachCalls}`);
}

// ── C: clientless canonical wrapper loses to the client-bearing Drive wrapper ───────────────────
{
  const registry = new AgentRegistry();
  const observeConn = fakeConn(info('s3', 'observe'));
  const driveConn = fakeConn(info('s3', 'resume'));
  let mode: string | undefined;
  registry.register({
    id: 'pi', displayName: 'Pi', capabilities: {} as any,
    isAvailable: async () => true, discoverSessions: async () => [],
    attach: async (_id: string, m?: string) => ((mode = m), m === 'resume' ? driveConn : observeConn),
  } as any);
  const hub = new Hub(registry, 15000);
  await hub.ensure('pi', 's3'); // clientless observe wrapper on the canonical key
  const driveMc = await hub.ensure('pi', 's3', 'resume');
  driveMc.addClient(() => {});
  const bridgeConn = fakeConn(info('s3', 'live'));
  const adopted = hub.adopt('pi', 's3', bridgeConn);
  check('C1 the client-bearing Drive wrapper survives the fold', adopted === driveMc);
  check('C2 the clientless observe wrapper was disposed', observeConn.closed);
  check('C3 rival Drive process closed, bridge is the transport', driveConn.closed && (adopted as any).conn === bridgeConn);
  void mode;
}

// ── C2: both client-bearing wrappers converge onto the adopted bridge ──────────────────────────
{
  const registry = new AgentRegistry();
  const observeConn = fakeConn(info('s3-both', 'observe'));
  const driveConn = fakeConn(info('s3-both', 'resume'));
  registry.register({
    id: 'pi', displayName: 'Pi', capabilities: {} as any,
    isAvailable: async () => true, discoverSessions: async () => [],
    attach: async (_id: string, mode?: string) => mode === 'resume' ? driveConn : observeConn,
  } as any);
  const hub = new Hub(registry, 15000);
  const observer = await hub.ensure('pi', 's3-both');
  const driver = await hub.ensure('pi', 's3-both', 'resume');
  const observeSeen: string[] = [];
  const driveSeen: string[] = [];
  let observeTarget = observer;
  let driveTarget = driver;
  const observeClient: any = (event: any) => {
    if (event.kind === 'message') observeSeen.push(event.message?.message);
  };
  observeClient.onManagedConnChanged = (next: any) => { observeTarget = next; };
  const driveClient: any = (event: any) => {
    if (event.kind === 'message') driveSeen.push(event.message?.message);
  };
  driveClient.onManagedConnChanged = (next: any) => { driveTarget = next; };
  observer.addClient(observeClient);
  driver.addClient(driveClient);

  const bridgeConn = fakeConn(info('s3-both', 'live'));
  const adopted = hub.adopt('pi', 's3-both', bridgeConn);
  bridgeConn.emit({ type: 'notice', message: 'shared terminal event' } as AgentMessage);

  check('C2.1 the client-bearing Drive wrapper remains the bridge-backed survivor', adopted === driver);
  check('C2.2 both runtime socket targets move to the survivor', observeTarget === adopted && driveTarget === adopted);
  check('C2.3 both pre-adopt clients receive terminal events',
    observeSeen.includes('shared terminal event') && driveSeen.includes('shared terminal event'));
  check('C2.4 the discarded Observe transport and rival Drive process both close',
    observeConn.closed && driveConn.closed);
}

// ── C3: terminal handoff refuses peers, then migrates the last Drive client ──────────────
{
  const registry = new AgentRegistry();
  const observeConn = fakeConn(controlledInfo('pi', 's3-handoff', 'observe', 'observing'));
  const driveConn = fakeConn(controlledInfo('pi', 's3-handoff', 'resume', 'driving'));
  registry.register({
    id: 'pi', displayName: 'Pi', capabilities: { supportsCrossClientDriveSharing: true } as any,
    isAvailable: async () => true, discoverSessions: async () => [],
    attach: async (_id: string, mode?: string) => mode === 'resume' ? driveConn : observeConn,
  } as any);
  const hub = new Hub(registry, 15000);
  const observer = await hub.ensure('pi', 's3-handoff');
  const driver = await hub.ensure('pi', 's3-handoff', 'resume');
  const requesterSeen: string[] = [];
  let requesterTarget = driver;
  const requester: any = (event: any) => {
    if (event.kind === 'message') requesterSeen.push(event.message?.message);
  };
  requester.onManagedConnChanged = (next: any) => { requesterTarget = next; };
  const peer: any = (event: any) => {
    void event;
  };
  driver.addClient(requester);
  driver.addClient(peer);

  let peerRefusal: unknown;
  try {
    await hub.handoffToTerminal('pi', 's3-handoff', driver);
  } catch (error) {
    peerRefusal = error;
  }
  check('C3.1 handoff refuses while another foreground driver remains',
    peerRefusal instanceof Error && peerRefusal.message.includes('foreground client'));
  check('C3.2 refusal leaves the shared Resume owner active', !driveConn.closed && requesterTarget === driver);

  driver.removeClient(peer);
  const handedOff = await hub.handoffToTerminal('pi', 's3-handoff', driver);
  observeConn.emit({ type: 'notice', message: 'after shared handoff' } as AgentMessage);
  const projected = hub.sessionDetailFrame(observer, true);

  check('C3.3 last-client handoff returns the terminal-facing Observe wrapper', handedOff === observer);
  check('C3.4 the requester moves to the Observe authority target', requesterTarget === observer);
  check('C3.5 the shared Resume owner closes before handoff resolves', driveConn.closed);
  check('C3.6 the migrated requester receives future Observe events', requesterSeen.includes('after shared handoff'));
  check('C3.7 owner truth no longer reports Drive', projected.info.sessionOwner?.state === 'none');
}

// ── C4: a handoff fences new Drive acquisition until its native owner closes ───────────────────
{
  let releaseObserver!: () => void;
  const observerGate = new Promise<void>((resolve) => { releaseObserver = resolve; });
  let attachCalls = 0;
  const registry = new AgentRegistry();
  const driveConn = fakeConn(controlledInfo('pi', 's3-handoff-race', 'resume', 'driving'));
  const observeConn = fakeConn(controlledInfo('pi', 's3-handoff-race', 'observe', 'observing'));
  registry.register({
    id: 'pi', displayName: 'Pi', capabilities: { supportsCrossClientDriveSharing: true } as any,
    isAvailable: async () => true, discoverSessions: async () => [],
    attach: async (_id: string, mode?: string) => {
      attachCalls++;
      if (mode === 'resume') return driveConn;
      await observerGate;
      return observeConn;
    },
  } as any);
  const hub = new Hub(registry, 15000);
  const driver = await hub.ensure('pi', 's3-handoff-race', 'resume');
  driver.addClient(() => {});
  const revision = hub.projectSessionInfo(driver.conn.info).sessionOwner!.revision;
  const handoff = hub.handoffToTerminal('pi', 's3-handoff-race', driver);
  await Promise.resolve();

  let restoreBlocked = false;
  try {
    await hub.ensure('pi', 's3-handoff-race', 'resume', 'app-restore');
  } catch {
    restoreBlocked = true;
  }
  let joinCode = '';
  try {
    hub.joinExisting('pi', 's3-handoff-race', revision);
  } catch (error) {
    joinCode = error instanceof JoinExistingError ? error.code : String(error);
  }
  check('C4.1 a reason-tagged Drive attach cannot enter during terminal handoff', restoreBlocked);
  check('C4.2 join-existing cannot acquire the owner during terminal handoff', joinCode === 'JOIN_OWNER_NOT_FOUND');
  check('C4.3 fenced acquisitions perform no additional native attach', attachCalls === 2, `attachCalls=${attachCalls}`);

  releaseObserver();
  await handoff;
  check('C4.4 the original handoff still closes the one Resume owner', driveConn.closed);
  await hub.dispose();
}

// ── C5: a failed native close keeps the registered Drive owner truthful ────────────────────────
{
  const registry = new AgentRegistry();
  const driveConn = fakeConn(controlledInfo('pi', 's3-handoff-close-fail', 'resume', 'driving'));
  driveConn.close = async () => { throw new Error('simulated close failure'); };
  const observeConn = fakeConn(controlledInfo('pi', 's3-handoff-close-fail', 'observe', 'observing'));
  registry.register({
    id: 'pi', displayName: 'Pi', capabilities: { supportsCrossClientDriveSharing: true } as any,
    isAvailable: async () => true, discoverSessions: async () => [],
    attach: async (_id: string, mode?: string) => mode === 'resume' ? driveConn : observeConn,
  } as any);
  const hub = new Hub(registry, 15000);
  const driver = await hub.ensure('pi', 's3-handoff-close-fail', 'resume');
  let requesterTarget = driver;
  const requester: any = () => {};
  requester.onManagedConnChanged = (next: any) => { requesterTarget = next; };
  driver.addClient(requester);

  let closeFailure: unknown;
  try {
    await hub.handoffToTerminal('pi', 's3-handoff-close-fail', driver);
  } catch (error) {
    closeFailure = error;
  }
  const projected = hub.sessionDetailFrame(driver, true);
  check('C5.1 native close failure is returned to the requester', closeFailure instanceof Error && closeFailure.message.includes('close failure'));
  check('C5.2 failed close leaves the requester on the registered Drive wrapper', hub.getConn('pi', 's3-handoff-close-fail') === driver && requesterTarget === driver);
  check('C5.3 failed close never fabricates owner=none', projected.info.sessionOwner?.state === 'drive');
  await hub.dispose();
}

// ── C6: same-socket work cannot overlap or cross terminal handoff ───────────────────────────────
{
  const sequencer = new ClientHandoffSequencer();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = sequencer.run(async () => {
    order.push('first-start');
    await firstGate;
    order.push('first-end');
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('C6.1 active work is visible so runtime can refuse a late, unbounded handoff', sequencer.hasActiveWork && order.join(',') === 'first-start', `order=${order.join(',')}`);
  releaseFirst();
  await first;

  let releaseHandoff!: () => void;
  const handoffGate = new Promise<void>((resolve) => { releaseHandoff = resolve; });
  const handoff = sequencer.run(async () => {
    order.push('handoff-start');
    await handoffGate;
    order.push('handoff-end');
  }, { handoff: true });
  const after = sequencer.run(async () => { order.push('after'); });
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('C6.2 work accepted after handoff waits for socket retargeting', order.join(',') === 'first-start,first-end,handoff-start', `order=${order.join(',')}`);
  releaseHandoff();
  await Promise.all([handoff, after]);
  check('C6.3 an accepted handoff is exclusive', order.join(',') === 'first-start,first-end,handoff-start,handoff-end,after', `order=${order.join(',')}`);
}

// ── D: ensure(?mode=resume) joins a bare conn that is ALREADY the driving owner ──────────────────
// issues-part2 item 14: two app tabs on one opencode serve session. Tab 1 attached bare (the serve
// conn reports drive:'driving'); tab 2 carried a sticky ?mode=resume — before this fix that minted an
// `opencode:<id>#resume` rival (`opencode run` twin), so drafts/messages never mirrored across tabs.
{
  let attachCalls = 0;
  const registry = new AgentRegistry();
  const liveInfo: SessionInfo = {
    ...info('s4', 'live'),
    tool: 'opencode',
    control: opencodeControlState({
      label: 'Sync with OpenCode terminal',
      command: 'opencode attach http://127.0.0.1:4096 -s s4',
    }),
  } as SessionInfo;
  registry.register({
    id: 'opencode', displayName: 'OpenCode', capabilities: {} as any,
    isAvailable: async () => true, discoverSessions: async () => [],
    attach: async () => { attachCalls++; return fakeConn(liveInfo); },
  } as any);
  const hub = new Hub(registry, 15000);
  const bare = await hub.ensure('opencode', 's4'); // tab 1: bare attach, driving by default
  const resumed = await hub.ensure('opencode', 's4', 'resume'); // tab 2: sticky resume
  check('D0 OpenCode shared-live keeps its terminal command on the join path', liveInfo.control?.terminalSync.action === 'join');
  check('D1 resume attach JOINS the bare driving owner (one identity, drafts mirror)', resumed === bare);
  check('D2 no rival run-conn spawned for the resume twin', attachCalls === 1, `attachCalls=${attachCalls}`);
  // The genuine resume flow must still get its own owner: a bare OBSERVE conn is not a driving owner.
  const observeInfo2: SessionInfo = { ...info('s5', 'observe'), tool: 'opencode', control: { drive: { supported: true, state: 'observing' }, terminalSync: { supported: false, syncAvailable: false, active: false } } } as SessionInfo;
  registry.register({
    id: 'opencode2', displayName: 'OpenCode2', capabilities: {} as any,
    isAvailable: async () => true, discoverSessions: async () => [],
    attach: async () => fakeConn(observeInfo2),
  } as any);
  const obs = await hub.ensure('opencode2', 's5');
  const drv = await hub.ensure('opencode2', 's5', 'resume');
  check('D3 a bare OBSERVE conn does not absorb an explicit resume (Drive still gets its own owner)', obs !== drv);
}

// ── E: a native rename patches the open conn's in-memory title (item-15 flicker) ────────────────
// After `renameSession` the broker alias is cleared; if the attached conn kept its attach-time title,
// every later broadcastSession (status flips) resurrected the OLD name until the next roster poll —
// the "original name, then the new name, and repeat" report.
{
  const registry = new AgentRegistry();
  const conn = fakeConn({ ...info('s6', 'live'), tool: 'opencode', title: 'old name' } as SessionInfo);
  registry.register({
    id: 'opencode', displayName: 'OpenCode', capabilities: {} as any,
    isAvailable: async () => true, discoverSessions: async () => [],
    attach: async () => conn,
  } as any);
  const hub = new Hub(registry, 15000);
  const mc = await hub.ensure('opencode', 's6');
  const seen: any[] = [];
  mc.addClient((ev: any) => { if (ev.kind === 'session') seen.push(ev.info?.title); });
  hub.patchSessionInfoWhere((i) => i.tool === 'opencode' && i.id === 's6', { title: 'new name' });
  hub.broadcastSessionWhere((i) => i.tool === 'opencode' && i.id === 's6', (i) => i);
  check('E1 patched title rides the rename broadcast', seen.at(-1) === 'new name', `seen=${seen.join(',')}`);
  mc.broadcastSession(mc.conn.info); // any later status-flip broadcast
  check('E2 later broadcasts can no longer resurrect the old title', seen.at(-1) === 'new name' && !seen.includes('old name'), `seen=${seen.join(',')}`);
}

// ── F: refreshExternalSession folds a #resume rival when the terminal becomes the owner ──────────
// issues-part2 codex re-flag: app-CREATED session driven via ?mode=resume (broker-owned stdio child),
// then the user runs the advertised sync command in a terminal. The adapter's loaded-watch reports
// terminalSync.active:true — but the bare-key lookup missed the `codex:<id>#resume` owner, so the app
// kept prompting its rival stdio process while the TUI wrote the same thread: no relay either way.
{
  let resumeAttaches = 0;
  let liveAttaches = 0;
  const registry = new AgentRegistry();
  const resumeInfo: SessionInfo = {
    ...info('s8', 'resume'),
    tool: 'codex',
    control: { drive: { supported: true, state: 'driving' }, terminalSync: { supported: true, syncAvailable: true, active: false } },
  } as SessionInfo;
  const liveInfo: SessionInfo = {
    ...info('s8', 'live'),
    tool: 'codex',
    control: { drive: { supported: false, state: 'unavailable' }, terminalSync: { supported: true, syncAvailable: true, active: true } },
  } as SessionInfo;
  const resumeConn = fakeConn(resumeInfo);
  const liveConn = fakeConn(liveInfo);
  // A message the user typed in the terminal DURING the watch window (join → fold): it exists only
  // in the daemon-side history — the rival stdio conn never relayed it.
  (liveConn as any).getHistory = async () => [{ type: 'user-message', text: 'typed in the join window' } as AgentMessage];
  registry.register({
    id: 'codex', displayName: 'Codex', capabilities: {} as any,
    isAvailable: async () => true, discoverSessions: async () => [],
    attach: async (_id: string, m?: string) => (m === 'resume' ? (resumeAttaches++, resumeConn) : (liveAttaches++, liveConn)),
  } as any);
  const hub = new Hub(registry, 15000);

  const driveMc = await hub.ensure('codex', 's8', 'resume'); // the app's created-session Drive attach
  const seen: AgentMessage[] = [];
  const histories: any[][] = [];
  driveMc.addClient((ev: any) => {
    if (ev.kind === 'message') seen.push(ev.message);
    if (ev.kind === 'history') histories.push(ev.messages ?? []);
  });

  // the terminal ran the sync command → the adapter watch reports the thread synced
  await hub.refreshExternalSession(structuredClone(liveInfo));

  check('F1 the Drive wrapper is folded onto the canonical key (open sockets keep their identity)', hub.getConn('codex', 's8') === driveMc);
  check('F2 the wrapper was reattached through the live daemon path', (driveMc as any).conn === liveConn && liveAttaches === 1, `liveAttaches=${liveAttaches}`);
  check('F3 the rival broker-owned process was closed', resumeConn.closed);
  liveConn.emit({ type: 'notice', message: 'relayed from the terminal' } as AgentMessage);
  check('F4 the pre-fold client receives post-fold live frames', seen.some((m: any) => m.message === 'relayed from the terminal'));
  // F4b (issues-part2 item-15 re-flag, 2026-07-13): the fold must RESYNC — without it, anything the
  // terminal typed before the fold stayed invisible on the open socket forever.
  await new Promise((r) => setTimeout(r, 100)); // resync is fire-and-forget off replaceConnection
  check('F4b the fold resyncs history so join-window messages reach the open socket', histories.some((msgs) => msgs.some((m: any) => m?.text === 'typed in the join window')), `histories=${histories.length}`);

  // the terminal exits: badge-off is info-only for a still-live conn — never a teardown (the daemon
  // conn is intact and mid-run deltas must survive; only the presence indicator changed)
  const offInfo: SessionInfo = { ...structuredClone(liveInfo), control: { drive: { supported: false, state: 'unavailable' }, terminalSync: { supported: true, syncAvailable: true, active: false } } } as SessionInfo;
  await hub.refreshExternalSession(offInfo);
  check('F5 badge-off on a live conn updates info without teardown', (driveMc as any).conn === liveConn && !liveConn.closed && driveMc.conn.info.control?.terminalSync?.active === false && liveAttaches === 1, `liveAttaches=${liveAttaches}`);
}

// ── G: ensure(?mode=resume) joins a bare LIVE true-sync owner instead of minting a rival ─────────
// A codex daemon-live conn reports drive 'unavailable' (the live conn IS the mutable path), so the
// driving-owner join rule alone missed it: a sticky/explicit resume attach would spawn a rival that
// the adapter rejects ("already using true terminal sync") — an error frame instead of a join.
{
  let attachCalls = 0;
  const registry = new AgentRegistry();
  const liveInfo: SessionInfo = {
    ...info('s9', 'live'),
    tool: 'codex',
    control: { drive: { supported: false, state: 'unavailable' }, terminalSync: { supported: true, syncAvailable: true, active: true } },
  } as SessionInfo;
  registry.register({
    id: 'codex', displayName: 'Codex', capabilities: {} as any,
    isAvailable: async () => true, discoverSessions: async () => [],
    attach: async () => { attachCalls++; return fakeConn(liveInfo); },
  } as any);
  const hub = new Hub(registry, 15000);
  const bare = await hub.ensure('codex', 's9');
  const resumed = await hub.ensure('codex', 's9', 'resume');
  check('G1 resume attach JOINS the bare live true-sync owner', resumed === bare);
  check('G2 no rival process was spawned for the resume twin', attachCalls === 1, `attachCalls=${attachCalls}`);
}

// ── H: Codex/Pi Session Detail exposes owner truth separately from socket authority ─────────────
// A second client first lands on its own Observe connection. The broker advertises the existing
// Drive owner and a revision-conditional join action, while keeping that Observe socket read-only.
// Joining reuses the exact ManagedConn and never calls the adapter again.
{
  let attachCalls = 0;
  const registry = new AgentRegistry();
  registry.register({
    id: 'pi', displayName: 'Pi', capabilities: { supportsCrossClientDriveSharing: true } as any,
    isAvailable: async () => true, discoverSessions: async () => [],
    attach: async (id: string, mode?: string) => {
      attachCalls++;
      return fakeConn(controlledInfo('pi', id, mode === 'resume' ? 'resume' : 'observe', mode === 'resume' ? 'driving' : 'observing'));
    },
  } as any);
  const hub = new Hub(registry, 15000);
  const driver = await hub.ensure('pi', 's10', 'resume');
  driver.addClient(() => {});
  const observer = await hub.ensure('pi', 's10');
  const frame = hub.sessionDetailFrame(observer, true);
  const revision = frame.joinExisting?.ownerRevision;

  check('H1 Session Detail reports the session-level Drive owner', frame.info.sessionOwner?.state === 'drive');
  check('H2 the attached Observe socket remains explicitly read-only', frame.authority?.canMutate === false && frame.authority.prompt === 'none');
  check('H3 a compatible foreground client receives an exact join-existing action', revision !== undefined);
  const joined = hub.joinExisting('pi', 's10', revision!);
  check('H4 join-existing reuses the exact active Drive wrapper', joined === driver);
  check('H5 join-existing performs no native attach', attachCalls === 2, `attachCalls=${attachCalls}`);
  const concurrent = await Promise.all([
    Promise.resolve().then(() => hub.joinExisting('pi', 's10', revision!)),
    Promise.resolve().then(() => hub.joinExisting('pi', 's10', revision!)),
  ]);
  check('H6 concurrent joins converge on one owner', concurrent[0] === driver && concurrent[1] === driver && attachCalls === 2);

  let staleCode = '';
  try {
    hub.joinExisting('pi', 's10', { ...revision!, seq: revision!.seq + 1 });
  } catch (error) {
    staleCode = error instanceof JoinExistingError ? error.code : String(error);
  }
  check('H7 a stale owner revision fails closed', staleCode === 'JOIN_OWNER_STALE', `code=${staleCode}`);
  check('H8 stale join performs no native attach', attachCalls === 2, `attachCalls=${attachCalls}`);

  let genericJoinRejected = false;
  try {
    await hub.ensure('pi', 's10', 'resume', 'join-existing');
  } catch {
    genericJoinRejected = true;
  }
  check('H8b generic ensure cannot route join-existing into native attach',
    genericJoinRejected && attachCalls === 2, `attachCalls=${attachCalls}`);

  const replacement = fakeConn(controlledInfo('pi', 's10', 'resume', 'driving'));
  const adopted = hub.adopt('pi', 's10', replacement);
  const replacementFrame = hub.sessionDetailFrame(observer, true);
  check('H9 replacing the native owner advances its revision even when state stays Drive',
    adopted === driver
      && replacementFrame.info.sessionOwner!.revision.seq > revision!.seq,
    `before=${revision!.seq}, after=${replacementFrame.info.sessionOwner?.revision.seq}`);
  let replacedCode = '';
  try {
    hub.joinExisting('pi', 's10', revision!);
  } catch (error) {
    replacedCode = error instanceof JoinExistingError ? error.code : String(error);
  }
  check('H10 a pre-replacement join is stale', replacedCode === 'JOIN_OWNER_STALE', `code=${replacedCode}`);
}

// ── I: Claude remains one-foreground-owner; no cross-client join action is advertised ───────────
{
  let attachCalls = 0;
  const registry = new AgentRegistry();
  registry.register({
    id: 'claude', displayName: 'Claude Code', capabilities: { supportsCrossClientDriveSharing: false } as any,
    isAvailable: async () => true, discoverSessions: async () => [],
    attach: async (id: string, mode?: string) => {
      attachCalls++;
      return fakeConn(controlledInfo('claude', id, mode === 'resume' ? 'resume' : 'observe', mode === 'resume' ? 'driving' : 'observing'));
    },
  } as any);
  const hub = new Hub(registry, 15000);
  await hub.ensure('claude', 's11', 'resume');
  const observer = await hub.ensure('claude', 's11');
  const frame = hub.sessionDetailFrame(observer, true);
  check('I1 Claude still publishes the existing owner truth', frame.info.sessionOwner?.state === 'drive');
  check('I2 Claude Observe remains read-only', frame.authority?.canMutate === false);
  check('I3 Claude receives no join-existing action', frame.joinExisting === undefined);
  let unsupportedCode = '';
  try {
    hub.joinExisting('claude', 's11', frame.info.sessionOwner!.revision);
  } catch (error) {
    unsupportedCode = error instanceof JoinExistingError ? error.code : String(error);
  }
  check('I4 direct Claude join fails closed without native attach', unsupportedCode === 'JOIN_NOT_SUPPORTED' && attachCalls === 2,
    `code=${unsupportedCode}, attachCalls=${attachCalls}`);
}

// ── J: attach mode is not owner proof, and owner disappearance is pushed to observers ───────────
{
  check('J1 attachMode=resume without active control is not an owner', activeOwnerState(info('mode-only-resume', 'resume')) === undefined);
  check('J2 attachMode=live without active control is not an owner', activeOwnerState(info('mode-only-live', 'live')) === undefined);

  let attachCalls = 0;
  const registry = new AgentRegistry();
  registry.register({
    id: 'codex', displayName: 'Codex', capabilities: { supportsCrossClientDriveSharing: true } as any,
    isAvailable: async () => true, discoverSessions: async () => [],
    attach: async (id: string, mode?: string) => {
      attachCalls++;
      return fakeConn(controlledInfo('codex', id, mode === 'resume' ? 'resume' : 'observe', mode === 'resume' ? 'driving' : 'observing'));
    },
  } as any);
  const hub = new Hub(registry, 15000);
  const driver = await hub.ensure('codex', 's12', 'resume');
  const observer = await hub.ensure('codex', 's12');
  const seen: any[] = [];
  observer.addClient((event: any) => {
    if (event.kind === 'session') seen.push(event.info.sessionOwner);
  });
  const before = hub.sessionDetailFrame(observer, true);
  driver.updateInfo(controlledInfo('codex', 's12', 'resume', 'observing'));
  const after = hub.sessionDetailFrame(observer, true);
  check('J3 losing Drive republishes authoritative owner=none to matching observers',
    after.info.sessionOwner?.state === 'none'
      && after.info.sessionOwner.revision.seq > before.info.sessionOwner!.revision.seq
      && seen.some((owner) => owner?.state === 'none'));
  check('J4 roster/detail projection reads the same owner revision',
    hub.projectSessionInfo(observer.conn.info).sessionOwner?.revision.seq === after.info.sessionOwner?.revision.seq);
  let missingCode = '';
  try {
    hub.joinExisting('codex', 's12', before.joinExisting!.ownerRevision);
  } catch (error) {
    missingCode = error instanceof JoinExistingError ? error.code : String(error);
  }
  check('J5 a disappeared owner fails as not-found without native attach',
    missingCode === 'JOIN_OWNER_NOT_FOUND' && attachCalls === 2,
    `code=${missingCode}, attachCalls=${attachCalls}`);
}

console.log(failures ? `\nFAIL: ${failures} check(s) failed.` : '\nAll hub mode-fold checks passed.');
process.exit(failures ? 1 : 0);
