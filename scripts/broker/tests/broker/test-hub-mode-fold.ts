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
 */
import { Hub } from '../../../../packages/typescript/broker/src/hub.ts';
import { AgentRegistry, type AgentMessage, type SessionConnection, type SessionInfo } from '../../../../packages/typescript/adapter-api/src/index.ts';

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
    control: { drive: { supported: true, state: 'driving' }, terminalSync: { supported: true, syncAvailable: true, active: false } },
  } as SessionInfo;
  registry.register({
    id: 'opencode', displayName: 'OpenCode', capabilities: {} as any,
    isAvailable: async () => true, discoverSessions: async () => [],
    attach: async () => { attachCalls++; return fakeConn(liveInfo); },
  } as any);
  const hub = new Hub(registry, 15000);
  const bare = await hub.ensure('opencode', 's4'); // tab 1: bare attach, driving by default
  const resumed = await hub.ensure('opencode', 's4', 'resume'); // tab 2: sticky resume
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

console.log(failures ? `\nFAIL: ${failures} check(s) failed.` : '\nAll hub mode-fold checks passed.');
process.exit(failures ? 1 : 0);
