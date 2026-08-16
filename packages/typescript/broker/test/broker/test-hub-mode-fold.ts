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
    id: 'pi', displayName: 'Pi', capabilities: { supportsCrossClientDriveSharing: true, attachModes: ['observe', 'resume'] } as any,
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
    id: 'pi', displayName: 'Pi', capabilities: { supportsCrossClientDriveSharing: true, attachModes: ['observe', 'resume'] } as any,
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
    id: 'pi', displayName: 'Pi', capabilities: { supportsCrossClientDriveSharing: true, attachModes: ['observe', 'resume'] } as any,
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

// ── C7: handoff resolves a LIVE owner, not only a resume one ────────────────────────────────────
// The defect this replaces: the owner lookup was hardcoded to `#resume`, and
// `Hub.key` folds any non-observe mode onto `tool:id#<mode>`, so a live-mode
// driver (kimi, dsh) could never be found and every handoff threw
// `driver-changed`. Reproduced physically on 2026-08-16 against a real host.
{
  const registry = new AgentRegistry();
  const driveConn = fakeConn(controlledInfo('pi', 's7-live', 'live', 'driving'));
  const observeConn = fakeConn(controlledInfo('pi', 's7-live', 'observe', 'observing'));
  registry.register({
    id: 'pi', displayName: 'Pi', capabilities: { attachModes: ['observe', 'live'] } as any,
    isAvailable: async () => true, discoverSessions: async () => [],
    attach: async (_id: string, mode?: string) => mode === 'live' ? driveConn : observeConn,
  } as any);
  const hub = new Hub(registry, 15000);
  const driver = await hub.ensure('pi', 's7-live', 'live');
  let requesterTarget = driver;
  const requester: any = () => {};
  requester.onManagedConnChanged = (next: any) => { requesterTarget = next; };
  driver.addClient(requester);

  const handedOff = await hub.handoffToTerminal('pi', 's7-live', driver);
  const projected = hub.sessionDetailFrame(handedOff, true);
  check('C7.1 a live-mode owner is found and handed off', handedOff !== driver && driveConn.closed);
  check('C7.2 the requester moves to the Observe wrapper', requesterTarget === handedOff);
  check('C7.3 owner truth reports none after a live handoff', projected.info.sessionOwner?.state === 'none');
  check('C7.4 the live key is unregistered', hub.getConn('pi', 's7-live') === handedOff);
  await hub.dispose();
}

// ── C8: two mutable owners REFUSE rather than picking one ───────────────────────────────────────
// Preferring either silently ends one writer while the other keeps writing —
// exactly the divergence handoff exists to prevent. Refusal must happen before
// anything is mutated.
{
  const registry = new AgentRegistry();
  const resumeConn = fakeConn(controlledInfo('pi', 's8-ambiguous', 'resume', 'driving'));
  const liveConn = fakeConn(controlledInfo('pi', 's8-ambiguous', 'live', 'driving'));
  const observeConn = fakeConn(controlledInfo('pi', 's8-ambiguous', 'observe', 'observing'));
  registry.register({
    id: 'pi', displayName: 'Pi', capabilities: { attachModes: ['observe', 'resume', 'live'] } as any,
    isAvailable: async () => true, discoverSessions: async () => [],
    attach: async (_id: string, mode?: string) =>
      mode === 'resume' ? resumeConn : mode === 'live' ? liveConn : observeConn,
  } as any);
  const hub = new Hub(registry, 15000);
  const resumeOwner = await hub.ensure('pi', 's8-ambiguous', 'resume');
  const liveOwner = await hub.ensure('pi', 's8-ambiguous', 'live');
  resumeOwner.addClient(() => {});
  liveOwner.addClient(() => {});

  let refusal: unknown;
  try {
    await hub.handoffToTerminal('pi', 's8-ambiguous', resumeOwner);
  } catch (error) {
    refusal = error;
  }
  check('C8.1 an ambiguous owner set refuses', refusal instanceof Error);
  check('C8.2 refusal closes NEITHER owner', !resumeConn.closed && !liveConn.closed);
  check('C8.3 both owners remain registered', hub.getConn('pi', 's8-ambiguous') === resumeOwner);
  await hub.dispose();
}

// ── C9: an adapter with no Observe surface refuses BEFORE its owner is closed ────────────────────
// dsh serves one undifferentiated client contract and refuses every non-live
// attach, so handing off would close its only owner and then fail to build the
// connection meant to replace it. Read from the backend's own capabilities.
{
  const registry = new AgentRegistry();
  const driveConn = fakeConn(controlledInfo('dsh', 's9-no-observe', 'live', 'driving'));
  let observeAttempts = 0;
  registry.register({
    id: 'dsh', displayName: 'DSH', capabilities: { attachModes: ['live'] } as any,
    isAvailable: async () => true, discoverSessions: async () => [],
    attach: async (_id: string, mode?: string) => {
      if (mode !== 'live') { observeAttempts++; throw new Error('dsh has no read-only observe attach'); }
      return driveConn;
    },
  } as any);
  const hub = new Hub(registry, 15000);
  const driver = await hub.ensure('dsh', 's9-no-observe', 'live');
  driver.addClient(() => {});

  let refusal: unknown;
  try {
    await hub.handoffToTerminal('dsh', 's9-no-observe', driver);
  } catch (error) {
    refusal = error;
  }
  const projected = hub.sessionDetailFrame(driver, true);
  check('C9.1 an adapter without observe refuses handoff', refusal instanceof Error);
  check('C9.2 the refusal never closed the only owner', !driveConn.closed);
  check('C9.3 no observe attach was even attempted', observeAttempts === 0);
  check('C9.4 owner truth still reports drive', projected.info.sessionOwner?.state === 'drive');
  await hub.dispose();
}

// ── C10: unregister is immediate, and revocation precedes the observer ───────────────────────────
// Two orderings in one run, because both are load-bearing:
//  - the drive wrapper must already be unregistered when revocation runs, so no
//    failure after the close can leave a closed wrapper projecting Drive; and
//  - revocation must precede the observe attach, or an adapter that still
//    believes it owns the session publishes a DRIVABLE observer and the next
//    open silently retakes Drive.
{
  const order: string[] = [];
  const registry = new AgentRegistry();
  const driveConn = fakeConn(controlledInfo('pi', 's10-order', 'live', 'driving'));
  const observeConn = fakeConn(controlledInfo('pi', 's10-order', 'observe', 'observing'));
  driveConn.close = async () => { order.push('close'); (driveConn as any).closed = true; };
  let hub!: Hub;
  let driveKeyStillRegistered = true;
  registry.register({
    id: 'pi', displayName: 'Pi', capabilities: { attachModes: ['observe', 'live'] } as any,
    isAvailable: async () => true, discoverSessions: async () => [],
    releaseDriveEligibility: (_id: string) => {
      order.push('revoke');
      // Observed from INSIDE revocation: the mutable owner is already gone.
      driveKeyStillRegistered = hub.getConn('pi', 's10-order') !== undefined;
    },
    attach: async (_id: string, mode?: string) => {
      order.push(mode === 'live' ? 'attach:live' : 'attach:observe');
      return mode === 'live' ? driveConn : observeConn;
    },
  } as any);
  hub = new Hub(registry, 15000);
  const driver = await hub.ensure('pi', 's10-order', 'live');
  driver.addClient(() => {});
  await hub.handoffToTerminal('pi', 's10-order', driver);

  check('C10.1 close precedes revocation precedes the observer',
    order.join(',') === 'attach:live,close,revoke,attach:observe', order.join(','));
  check('C10.2 the drive wrapper is unregistered before revocation runs', !driveKeyStillRegistered);
  await hub.dispose();
}

// ── C11: a failure after authority is released settles completely ───────────────────────────────
// Once the native owner is closed, Drive cannot be handed back. The requester
// must be told the session ended and detached — never left fanning out from a
// ManagedConn whose connection is already closed — and owner truth must not
// claim Drive.
{
  const registry = new AgentRegistry();
  const driveConn = fakeConn(controlledInfo('pi', 's11-settle', 'live', 'driving'));
  registry.register({
    id: 'pi', displayName: 'Pi', capabilities: { attachModes: ['observe', 'live'] } as any,
    isAvailable: async () => true, discoverSessions: async () => [],
    releaseDriveEligibility: () => { throw new Error('revocation exploded'); },
    attach: async (_id: string, mode?: string) => {
      if (mode === 'live') return driveConn;
      throw new Error('observer must not be built after a failed revocation');
    },
  } as any);
  const hub = new Hub(registry, 15000);
  const driver = await hub.ensure('pi', 's11-settle', 'live');
  const seen: string[] = [];
  const requester: any = (frame: any) => { seen.push(frame.kind); };
  driver.addClient(requester);

  let failure: unknown;
  try {
    await hub.handoffToTerminal('pi', 's11-settle', driver);
  } catch (error) {
    failure = error;
  }
  const projected = hub.sessionDetailFrame(driver, true);
  check('C11.1 the failure reaches the caller', failure instanceof Error && (failure as Error).message.includes('revocation exploded'));
  check('C11.2 the native owner really was closed', driveConn.closed);
  check('C11.3 the requester is told the session ended', seen.includes('ended'));
  check('C11.4 Drive is NOT restored', hub.getConn('pi', 's11-settle') === undefined);
  check('C11.5 owner truth does not claim Drive', projected.info.sessionOwner?.state !== 'drive');
  await hub.dispose();
}

// ── C12: a LIVE attach cannot enter during handoff either ───────────────────────────────────────
// The fence guarded `resume` only, which left the window wide open for every
// live-mode adapter — the same adapters C7 exists for.
{
  let releaseObserver!: () => void;
  const observerGate = new Promise<void>((resolve) => { releaseObserver = resolve; });
  const registry = new AgentRegistry();
  const driveConn = fakeConn(controlledInfo('pi', 's12-fence', 'live', 'driving'));
  const observeConn = fakeConn(controlledInfo('pi', 's12-fence', 'observe', 'observing'));
  registry.register({
    id: 'pi', displayName: 'Pi', capabilities: { attachModes: ['observe', 'live'] } as any,
    isAvailable: async () => true, discoverSessions: async () => [],
    attach: async (_id: string, mode?: string) => {
      if (mode === 'live') return driveConn;
      await observerGate;
      return observeConn;
    },
  } as any);
  const hub = new Hub(registry, 15000);
  const driver = await hub.ensure('pi', 's12-fence', 'live');
  driver.addClient(() => {});
  const handoff = hub.handoffToTerminal('pi', 's12-fence', driver);
  await Promise.resolve();

  let liveBlocked = false;
  try {
    await hub.ensure('pi', 's12-fence', 'live');
  } catch {
    liveBlocked = true;
  }
  check('C12.1 a live attach cannot acquire the owner during terminal handoff', liveBlocked);
  releaseObserver();
  await handoff;
  await hub.dispose();
}

// ── C14: a PRE-EXISTING observer must not survive handoff with pre-revocation truth ─────────────
// The topology is ordinary — a resident/background observer coexisting with the
// #live owner — and it is the one case the other handoff checks miss, because
// they all let Observe be constructed AFTER revocation.
//
// That older wrapper was built while the session was still owned, so its cached
// control says `supported: true`. Revocation changes the ADAPTER's mind, not the
// info already captured on a live connection, so reusing it would move the
// foreground client onto a wrapper that still offers Drive — handing control to
// the terminal and simultaneously telling the app it may take it back.
//
// Replacement is scoped to adapters that declare `releaseDriveEligibility`:
// C3.3 pins the converse, that an adapter WITHOUT adapter-owned eligibility
// still gets its existing Observe wrapper back by identity. Nothing about that
// adapter's answer changed, so there is nothing to re-ask.
{
  const registry = new AgentRegistry();
  let owned = true;
  const observerInfo = () => ({
    ...controlledInfo('pi', 's14-stale', 'observe', 'observing'),
    control: {
      drive: owned
        ? { supported: true, state: 'observing' }
        : { supported: false, state: 'observing', reason: 'terminal-owned' },
      terminalSync: { supported: false, syncAvailable: false, active: false },
    },
  } as SessionInfo);
  const driveConn = fakeConn(controlledInfo('pi', 's14-stale', 'live', 'driving'));
  const observeConns: Array<ReturnType<typeof fakeConn>> = [];
  registry.register({
    id: 'pi', displayName: 'Pi', capabilities: { attachModes: ['observe', 'live'] } as any,
    isAvailable: async () => true, discoverSessions: async () => [],
    releaseDriveEligibility: () => { owned = false; },
    attach: async (_id: string, mode?: string) => {
      if (mode === 'live') return driveConn;
      const conn = fakeConn(observerInfo());
      observeConns.push(conn);
      return conn;
    },
  } as any);
  const hub = new Hub(registry, 15000);

  // A resident observer attaches FIRST, while the session is still owned.
  const resident = await hub.ensure('pi', 's14-stale');
  const residentSeen: string[] = [];
  const residentFrames: any[] = [];
  const residentClient: any = (frame: any) => { residentSeen.push(frame.kind); residentFrames.push(frame); };
  let residentTarget = resident;
  residentClient.onManagedConnChanged = (next: any) => { residentTarget = next; };
  resident.addClient(residentClient);
  check('C14.1 the resident observer starts out drivable', resident.conn.info.control?.drive.supported === true);

  const driver = await hub.ensure('pi', 's14-stale', 'live');
  let requesterTarget = driver;
  const requester: any = () => {};
  requester.onManagedConnChanged = (next: any) => { requesterTarget = next; };
  driver.addClient(requester);

  const handedOff = await hub.handoffToTerminal('pi', 's14-stale', driver);
  const projected = hub.sessionDetailFrame(handedOff, true);
  check('C14.2 the surviving observer publishes post-revocation truth',
    handedOff.conn.info.control?.drive.supported === false,
    JSON.stringify(handedOff.conn.info.control?.drive));
  check('C14.3 the handed-off requester lands on that observer', requesterTarget === handedOff);
  check('C14.4 the resident client is carried onto it too', residentTarget === handedOff);
  check('C14.5 owner truth reports none', projected.info.sessionOwner?.state === 'none');
  check('C14.6 the session is what getConn resolves', hub.getConn('pi', 's14-stale') === handedOff);
  // Connection state is not client state. The carried-over resident had already
  // been told Drive was available; it has to be told otherwise, or its UI keeps
  // offering a Drive the adapter no longer grants.
  const residentDrive = residentFrames
    .filter((frame) => frame.kind === 'session')
    .map((frame) => frame.info?.control?.drive?.supported);
  check('C14.7 the carried-over resident is TOLD Drive is gone',
    residentDrive.length > 0 && residentDrive.at(-1) === false, JSON.stringify(residentDrive));
  await hub.dispose();
}

// ── C15: a failed observer replacement settles like any post-release failure ─────────────────────
{
  const registry = new AgentRegistry();
  const driveConn = fakeConn(controlledInfo('pi', 's15-replace-fail', 'live', 'driving'));
  let observeAttaches = 0;
  registry.register({
    id: 'pi', displayName: 'Pi', capabilities: { attachModes: ['observe', 'live'] } as any,
    isAvailable: async () => true, discoverSessions: async () => [],
    releaseDriveEligibility: () => {},
    attach: async (_id: string, mode?: string) => {
      if (mode === 'live') return driveConn;
      observeAttaches++;
      if (observeAttaches > 1) throw new Error('replacement observer failed');
      return fakeConn(controlledInfo('pi', 's15-replace-fail', 'observe', 'observing'));
    },
  } as any);
  const hub = new Hub(registry, 15000);
  const resident = await hub.ensure('pi', 's15-replace-fail');
  const residentSeen: string[] = [];
  resident.addClient(((frame: any) => { residentSeen.push(frame.kind); }) as any);
  const driver = await hub.ensure('pi', 's15-replace-fail', 'live');
  const driverSeen: string[] = [];
  driver.addClient(((frame: any) => { driverSeen.push(frame.kind); }) as any);

  let failure: unknown;
  try {
    await hub.handoffToTerminal('pi', 's15-replace-fail', driver);
  } catch (error) {
    failure = error;
  }
  check('C15.1 the replacement failure reaches the caller', failure instanceof Error);
  check('C15.2 the driver settles as ended', driverSeen.includes('ended'));
  check('C15.3 the stale observer settles as ended too', residentSeen.includes('ended'));
  check('C15.4 no wrapper is left registered claiming Drive',
    hub.getConn('pi', 's15-replace-fail') === undefined);
  await hub.dispose();
}

// ── C19/C20: an Observe attach begun BEFORE revocation is never admitted after it ────────────────
// The dangerous generation is the one that is in flight, not the one that is
// registered: an adapter snapshots what it may do when the attach STARTS, so a
// bare attach parked on its HTTP call is carrying `supported: true` while
// handoff revokes underneath it. It is invisible to `conns` — it lives only in
// `pending` — so a registry lookup cannot fence it, and the handoff's own
// replacement `ensure` would otherwise coalesce straight onto it.
const parkedObserverCase = async (
  label: 'C19' | 'C20',
  revocationThrows: boolean,
) => {
  const session = revocationThrows ? 's20-park-throw' : 's19-park';
  const registry = new AgentRegistry();
  const driveConn = fakeConn(controlledInfo('pi', session, 'live', 'driving'));
  const observeInfo = (supported: boolean) => ({
    ...controlledInfo('pi', session, 'observe', 'observing'),
    control: {
      drive: supported
        ? { supported: true, state: 'observing' }
        : { supported: false, state: 'observing', reason: 'terminal-owned' },
      terminalSync: { supported: false, syncAvailable: false, active: false },
    },
  } as SessionInfo);

  let owned = true;
  let unpark: () => void = () => {};
  const parked = new Promise<void>((resolve) => { unpark = resolve; });
  const snapshots: boolean[] = [];
  let parkedConn: ReturnType<typeof fakeConn> | undefined;
  let freshConn: ReturnType<typeof fakeConn> | undefined;
  registry.register({
    id: 'pi', displayName: 'Pi', capabilities: { attachModes: ['observe', 'live'] } as any,
    isAvailable: async () => true, discoverSessions: async () => [],
    releaseDriveEligibility: async () => {
      owned = false;
      if (revocationThrows) throw new Error('revocation half-applied');
    },
    attach: async (_id: string, mode?: string) => {
      if (mode === 'live') return driveConn;
      // Snapshot eligibility the way a real adapter does — at the START of the
      // attach — then block, exactly like an adapter awaiting its own host.
      const snapshot = owned;
      snapshots.push(snapshot);
      const first = snapshots.length === 1;
      if (first) await parked;
      const conn = fakeConn(observeInfo(snapshot));
      if (first) parkedConn = conn; else freshConn = conn;
      return conn;
    },
  } as any);
  const hub = new Hub(registry, 15000);

  let backgroundError: unknown;
  const background = hub.ensure('pi', session)
    .then((mc) => mc, (error) => { backgroundError = error; return undefined; });
  await Promise.resolve();
  check(`${label}.1 the parked attach snapshotted PRE-revocation eligibility`,
    snapshots.length === 1 && snapshots[0] === true, JSON.stringify(snapshots));

  const driver = await hub.ensure('pi', session, 'live');
  const driverSeen: string[] = [];
  driver.addClient(((frame: any) => { driverSeen.push(frame.kind); }) as any);

  let handedOff: any;
  let failure: unknown;
  try {
    handedOff = await hub.handoffToTerminal('pi', session, driver);
  } catch (error) {
    failure = error;
  }
  // Release the parked generation only now — after handoff has finished — so
  // its admission attempt lands squarely in the window the fence must cover.
  unpark();
  await background;
  return {
    hub, session, snapshots, parkedConn, freshConn, backgroundError, handedOff, failure, driverSeen,
  };
};

{
  const r = await parkedObserverCase('C19', false);
  check('C19.2 handoff did not coalesce onto the parked generation',
    r.snapshots.length === 2 && r.snapshots[1] === false, JSON.stringify(r.snapshots));
  check('C19.3 the observer it returned is the post-revocation one',
    r.handedOff?.conn === r.freshConn
      && r.handedOff?.conn.info.control?.drive.supported === false,
    JSON.stringify(r.handedOff?.conn.info.control?.drive));
  check('C19.4 the parked generation is refused at admission',
    r.backgroundError instanceof Error && (r.backgroundError as Error).name === 'SupersededAttachError',
    String((r.backgroundError as Error | undefined)?.name));
  check('C19.5 its connection is closed, not registered', r.parkedConn?.closed === true);
  check('C19.6 the session still resolves to the post-revocation observer',
    r.hub.getConn('pi', r.session) === r.handedOff);
  await r.hub.dispose();
}

{
  const r = await parkedObserverCase('C20', true);
  check('C20.2 the half-applied revocation reaches the caller', r.failure instanceof Error);
  check('C20.3 the parked generation is refused even though handoff failed',
    r.backgroundError instanceof Error && (r.backgroundError as Error).name === 'SupersededAttachError',
    String((r.backgroundError as Error | undefined)?.name));
  check('C20.4 releasing it afterwards registers nothing',
    r.hub.getConn('pi', r.session) === undefined);
  check('C20.5 its connection is closed rather than leaked', r.parkedConn?.closed === true);
  check('C20.6 the driver still settles as ended', r.driverSeen.includes('ended'));
  await r.hub.dispose();
}

// ── C21/C22: a mutable attach parked BEFORE the fence never becomes a new Drive owner ────────────
// C12 proves an attach STARTED during handoff is refused. This is the other
// half: one already sitting in `pending` when the fence went up. `ensure` reads
// `terminalHandoffs` at the start of the request, so that attach has already
// cleared the fence check and would register a fresh Drive owner for a session
// whose control has just been handed to the terminal — possibly after `finally`
// clears the fence, leaving nothing behind to explain it.
//
// Run in BOTH directions: the registered owner can be either mutable mode, and
// the parked rival is the other one.
const parkedMutableCase = async (
  label: 'C21' | 'C22',
  ownerMode: 'resume' | 'live',
  rivalMode: 'resume' | 'live',
) => {
  const session = `s-${label.toLowerCase()}-${ownerMode}-vs-${rivalMode}`;
  const registry = new AgentRegistry();
  const ownerConn = fakeConn(controlledInfo('pi', session, ownerMode, 'driving'));
  let unpark: () => void = () => {};
  const parked = new Promise<void>((resolve) => { unpark = resolve; });
  let rivalStarted = false;
  let rivalConn: ReturnType<typeof fakeConn> | undefined;
  registry.register({
    id: 'pi', displayName: 'Pi', capabilities: { attachModes: ['observe', 'resume', 'live'] } as any,
    isAvailable: async () => true, discoverSessions: async () => [],
    attach: async (_id: string, mode?: string) => {
      if (mode === ownerMode) return ownerConn;
      if (mode === rivalMode) {
        rivalStarted = true;
        await parked;
        rivalConn = fakeConn(controlledInfo('pi', session, rivalMode, 'driving'));
        return rivalConn;
      }
      return fakeConn(controlledInfo('pi', session, 'observe', 'observing'));
    },
  } as any);
  const hub = new Hub(registry, 15000);

  const driver = await hub.ensure('pi', session, ownerMode);
  driver.addClient((() => {}) as any);
  let rivalError: unknown;
  const rival = hub.ensure('pi', session, rivalMode)
    .then((mc) => mc, (error) => { rivalError = error; return undefined; });
  await Promise.resolve();
  check(`${label}.1 the rival ${rivalMode} attach is in flight before the fence`, rivalStarted);

  const handedOff = await hub.handoffToTerminal('pi', session, driver);
  // Released only after handoff returned AND its `finally` cleared the fence, so
  // the refusal cannot be coming from `terminalHandoffs`.
  unpark();
  await rival;

  const projected = hub.sessionDetailFrame(handedOff, true);
  check(`${label}.2 the superseded ${rivalMode} attach is refused`,
    rivalError instanceof Error && (rivalError as Error).name === 'SupersededAttachError',
    String((rivalError as Error | undefined)?.name));
  check(`${label}.3 its connection is closed, never registered`, rivalConn?.closed === true);
  check(`${label}.4 no new Drive owner exists`, hub.getConn('pi', session) === handedOff);
  check(`${label}.5 owner truth stays off Drive`, projected.info.sessionOwner?.state === 'none',
    String(projected.info.sessionOwner?.state));
  await hub.dispose();
};
await parkedMutableCase('C21', 'live', 'resume');
await parkedMutableCase('C22', 'resume', 'live');

// ── C18: the migrated client is TOLD the session left Drive ──────────────────────────────────────
// Owner truth is published synchronously the moment the drive wrapper is
// unregistered — which is before the observer exists, so that broadcast reaches
// nobody, and the later reconcile sees no change to announce. A client that is
// acked and never told keeps rendering the Drive it just handed away; the real
// -broker fixture caught this as "handoff is acknowledged only after owner truth
// leaves Drive", and it belongs here where it is deterministic.
{
  const registry = new AgentRegistry();
  const driveConn = fakeConn(controlledInfo('pi', 's18-tell', 'resume', 'driving'));
  registry.register({
    id: 'pi', displayName: 'Pi', capabilities: { attachModes: ['observe', 'resume'] } as any,
    isAvailable: async () => true, discoverSessions: async () => [],
    attach: async (_id: string, mode?: string) => (mode === 'resume'
      ? driveConn
      : fakeConn(controlledInfo('pi', 's18-tell', 'observe', 'observing'))),
  } as any);
  const hub = new Hub(registry, 15000);

  const driver = await hub.ensure('pi', 's18-tell', 'resume');
  const frames: any[] = [];
  const requester: any = (frame: any) => { frames.push(frame); };
  requester.onManagedConnChanged = () => {};
  driver.addClient(requester);

  await hub.handoffToTerminal('pi', 's18-tell', driver);
  const ownerStates = frames
    .filter((frame) => frame.kind === 'session')
    .map((frame) => frame.info?.sessionOwner?.state);
  check('C18.1 the handed-off client receives a session frame', ownerStates.length > 0,
    JSON.stringify(frames.map((f) => f.kind)));
  check('C18.2 it says owner truth left Drive', ownerStates.includes('none'),
    JSON.stringify(ownerStates));
  check('C18.3 and it is never told Drive is still supported',
    frames.every((frame) => frame.kind !== 'session'
      || frame.info?.sessionOwner?.state !== 'drive'));
  await hub.dispose();
}

// ── C16: revocation that MUTATES and then throws still settles the observer it invalidated ───────
// `stale` is captured after the revocation await, so on this path it is never
// captured at all — yet eligibility is already gone and the pre-existing
// observer's cached `supported: true` is already a lie. The failure settlement
// therefore reads the registry rather than that variable.
{
  const registry = new AgentRegistry();
  const revoked: string[] = [];
  const driveConn = fakeConn(controlledInfo('pi', 's16-revoke-throw', 'live', 'driving'));
  registry.register({
    id: 'pi', displayName: 'Pi', capabilities: { attachModes: ['observe', 'live'] } as any,
    isAvailable: async () => true, discoverSessions: async () => [],
    releaseDriveEligibility: async (id: string) => {
      revoked.push(id);
      throw new Error('revocation half-applied');
    },
    attach: async (_id: string, mode?: string) => (mode === 'live'
      ? driveConn
      : fakeConn(controlledInfo('pi', 's16-revoke-throw', 'observe', 'observing'))),
  } as any);
  const hub = new Hub(registry, 15000);

  const resident = await hub.ensure('pi', 's16-revoke-throw');
  const residentSeen: string[] = [];
  resident.addClient(((frame: any) => { residentSeen.push(frame.kind); }) as any);
  check('C16.1 the resident observer is registered claiming Drive',
    resident.conn.info.control?.drive.supported === true);
  const driver = await hub.ensure('pi', 's16-revoke-throw', 'live');
  const driverSeen: string[] = [];
  driver.addClient(((frame: any) => { driverSeen.push(frame.kind); }) as any);

  let failure: unknown;
  try {
    await hub.handoffToTerminal('pi', 's16-revoke-throw', driver);
  } catch (error) {
    failure = error;
  }
  check('C16.2 the half-applied revocation reaches the caller', failure instanceof Error);
  check('C16.3 eligibility really was mutated before it threw',
    revoked.join(',') === 's16-revoke-throw', revoked.join(','));
  check('C16.4 the driver settles as ended', driverSeen.includes('ended'));
  check('C16.5 the observer that mutation invalidated settles too', residentSeen.includes('ended'));
  check('C16.6 nothing is left registered for the session',
    hub.getConn('pi', 's16-revoke-throw') === undefined);
  await hub.dispose();
}

// ── C17: a migration that throws AFTER the replacement exists takes the replacement down too ─────
// By the time client retargeting runs, the fresh observer is already built and
// registered and is already holding part of the client set. Settling only the
// two wrappers named before the failure would leave that replacement registered,
// half-populated, and — since it was built post-revocation and reads correctly —
// perfectly plausible.
{
  const registry = new AgentRegistry();
  const driveConn = fakeConn(controlledInfo('pi', 's17-migrate-throw', 'live', 'driving'));
  const observers: Array<ReturnType<typeof fakeConn>> = [];
  registry.register({
    id: 'pi', displayName: 'Pi', capabilities: { attachModes: ['observe', 'live'] } as any,
    isAvailable: async () => true, discoverSessions: async () => [],
    releaseDriveEligibility: () => {},
    attach: async (_id: string, mode?: string) => {
      if (mode === 'live') return driveConn;
      const conn = fakeConn(controlledInfo('pi', 's17-migrate-throw', 'observe', 'observing'));
      observers.push(conn);
      return conn;
    },
  } as any);
  const hub = new Hub(registry, 15000);

  const resident = await hub.ensure('pi', 's17-migrate-throw');
  const residentSeen: string[] = [];
  resident.addClient(((frame: any) => { residentSeen.push(frame.kind); }) as any);
  const driver = await hub.ensure('pi', 's17-migrate-throw', 'live');
  const requesterSeen: string[] = [];
  const requester: any = (frame: any) => { requesterSeen.push(frame.kind); };
  requester.onManagedConnChanged = () => { throw new Error('client retarget exploded'); };
  driver.addClient(requester);

  let failure: unknown;
  try {
    await hub.handoffToTerminal('pi', 's17-migrate-throw', driver);
  } catch (error) {
    failure = error;
  }
  check('C17.1 the migration failure reaches the caller', failure instanceof Error);
  check('C17.2 a replacement observer really had been built', observers.length === 2, `built ${observers.length}`);
  // The requester was already moved onto the replacement when retargeting threw,
  // so the replacement is the only wrapper that can still reach it.
  check('C17.3 the half-migrated client is still told the session ended', requesterSeen.includes('ended'));
  check('C17.4 the observer left behind settles as ended', residentSeen.includes('ended'));
  check('C17.5 the replacement is unregistered too',
    hub.getConn('pi', 's17-migrate-throw') === undefined);
  check('C17.6 the replacement transport is closed', observers[1]?.closed === true);
  await hub.dispose();
}

// ── C13: getConn keeps its own resolution, including the bare fallback ───────────────────────────
// The handoff resolver is deliberately a SEPARATE helper. getConn answers a
// different question — "whichever connection is live, for file delivery" — and
// its bare fallback is load-bearing: an OpenCode bare conn can report
// `drive: 'driving'` and a Codex bare conn at `attachMode: 'live'` IS the
// mutable path. Folding the two would have taken that away.
{
  const registry = new AgentRegistry();
  const bareConn = fakeConn(controlledInfo('pi', 's13-bare', 'observe', 'observing'));
  const liveConn = fakeConn(controlledInfo('pi', 's13-live-pref', 'live', 'driving'));
  const bareOther = fakeConn(controlledInfo('pi', 's13-live-pref', 'observe', 'observing'));
  registry.register({
    id: 'pi', displayName: 'Pi', capabilities: { attachModes: ['observe', 'live'] } as any,
    isAvailable: async () => true, discoverSessions: async () => [],
    attach: async (id: string, mode?: string) => {
      if (id === 's13-bare') return bareConn;
      return mode === 'live' ? liveConn : bareOther;
    },
  } as any);
  const hub = new Hub(registry, 15000);

  const bare = await hub.ensure('pi', 's13-bare');
  check('C13.1 getConn still resolves a bare-only session', hub.getConn('pi', 's13-bare') === bare);

  const bareFirst = await hub.ensure('pi', 's13-live-pref');
  const live = await hub.ensure('pi', 's13-live-pref', 'live');
  check('C13.2 getConn still prefers a mutable owner over the bare one',
    hub.getConn('pi', 's13-live-pref') === live && bareFirst !== live);
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
    id: 'pi', displayName: 'Pi', capabilities: { supportsCrossClientDriveSharing: true, attachModes: ['observe', 'resume'] } as any,
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
