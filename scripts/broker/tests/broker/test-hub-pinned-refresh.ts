#!/usr/bin/env bun
/**
 * Regression — Hub.refreshExternalSession must NEVER tear down a PINNED bridge.
 *
 * A pinned connection is a broker-OWNED live bridge: the Pi extension, or the Claude HOOKS overlay. Its
 * control state is authoritative and flows from its own hello/hook endpoints — NOT from adapter discovery.
 * The Claude adapter ALWAYS reports terminalSync.supported:false (Claude sync lives in the hook overlay,
 * not the adapter) and routes its watchSessionInfo through refreshExternalSession. Without the pinned-guard
 * the "sync disappeared" downgrade branch fires on every adapter frame, replacing the live hooks connection
 * with a bare Observe one — killing sync, flipping canMutateSession to supported:false (so the phone can no
 * longer answer the live card), and orphaning the permission/question the hook is still blocking on.
 *
 * Test A: a pinned synced conn + an observe-only adapter refresh → conn is UNCHANGED, registry.attach never
 *         called. Test B (no over-correction): a NON-pinned observe conn that the adapter now reports synced
 *         → the legitimate upgrade still re-attaches.
 */
import { Hub } from '../../../../packages/typescript/broker/src/hub.ts';
import { AgentRegistry, type SessionConnection, type SessionInfo } from '../../../../packages/typescript/adapter-api/src/index.ts';

let failures = 0;
const check = (label: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  — ${extra}` : ''}`);
  if (!ok) failures++;
};

function fakeConn(info: SessionInfo): SessionConnection {
  return {
    info,
    getHistory: async () => [],
    subscribe: () => () => {},
    sendPrompt: async () => {},
    respondPermission: async () => {},
    close: async () => {},
  };
}

const syncedInfo = (id: string): SessionInfo => ({
  id,
  tool: 'claude',
  machine: 'test',
  title: 'Hooks-synced',
  status: 'idle',
  attachMode: 'live',
  control: {
    drive: { supported: false, state: 'unavailable', reason: 'Synced through hooks.' },
    terminalSync: { supported: true, syncAvailable: true, active: true, input: 'answer-only', label: 'Synced via hooks' },
  },
});

// The Claude adapter's view of the SAME session: observe-only, sync NOT supported (it lives in the overlay).
const observeInfo = (id: string): SessionInfo => ({
  id,
  tool: 'claude',
  machine: 'test',
  title: 'Hooks-synced',
  status: 'idle',
  attachMode: 'observe',
  control: {
    drive: { supported: true, state: 'observing' },
    terminalSync: { supported: false, syncAvailable: false, active: false, label: 'Observed from terminal' },
  },
});

// ── Test A: pinned bridge survives an observe-only adapter refresh ──────────────────────────────
{
  let attachCalls = 0;
  const registry = new AgentRegistry();
  registry.register({
    id: 'claude',
    displayName: 'Claude',
    capabilities: {} as any,
    isAvailable: async () => true,
    discoverSessions: async () => [],
    // If the guard is ever removed, refreshExternalSession would call this to build the downgrade conn.
    attach: async () => {
      attachCalls++;
      return fakeConn(observeInfo('s-a'));
    },
  } as any);
  const hub = new Hub(registry, 15000);

  const pinned = fakeConn(syncedInfo('s-a'));
  hub.adopt('claude', 's-a', pinned);

  // The adapter's file watcher fires with an observe-only frame (the everyday case once the transcript
  // exists on disk and discovery returns the session).
  await hub.refreshExternalSession(observeInfo('s-a'));

  const after = hub.getConn('claude', 's-a');
  check('A1 pinned conn is NOT replaced by an observe-only adapter refresh', after?.conn === pinned);
  check('A2 registry.attach was never called (guard returned early)', attachCalls === 0, `attachCalls=${attachCalls}`);
  check(
    'A3 terminalSync stays supported+active (sync survives, mutation gate still allows answering)',
    after?.conn.info.control?.terminalSync.supported === true && after?.conn.info.control?.terminalSync.active === true,
  );
}

// ── Test B: the legitimate (non-pinned) upgrade path still works ────────────────────────────────
{
  let attachCalls = 0;
  const registry = new AgentRegistry();
  registry.register({
    id: 'opencode',
    displayName: 'OpenCode',
    capabilities: {} as any,
    isAvailable: async () => true,
    discoverSessions: async () => [],
    attach: async () => {
      attachCalls++;
      // First attach (ensure) → a bare Observe conn; the second (the refresh upgrade) → live + synced.
      if (attachCalls === 1) return fakeConn({ ...observeInfo('s-b'), tool: 'opencode' });
      const info: SessionInfo = { ...observeInfo('s-b'), tool: 'opencode', attachMode: 'live' };
      info.control = { drive: { supported: false, state: 'unavailable' }, terminalSync: { supported: true, syncAvailable: true, active: true } };
      return fakeConn(info);
    },
  } as any);
  const hub = new Hub(registry, 15000);

  // A bare (NON-pinned) Observe connection, as `ensure` would create for a shared-server session.
  const observe = await hub.ensure('opencode', 's-b');
  void observe;

  // The adapter now reports the same session as synced (a terminal bridge appeared) → upgrade expected.
  const synced: SessionInfo = { ...observeInfo('s-b'), tool: 'opencode', attachMode: 'observe' };
  synced.control = { drive: { supported: false, state: 'unavailable' }, terminalSync: { supported: true, syncAvailable: true, active: true } };
  await hub.refreshExternalSession(synced);

  check('B1 non-pinned observe→sync upgrade still re-attaches (guard did not over-correct)', attachCalls === 2, `attachCalls=${attachCalls}`);
  const after = hub.getConn('opencode', 's-b');
  check('B2 upgraded conn is live + synced', after?.conn.info.attachMode === 'live' && after?.conn.info.control?.terminalSync.active === true);
}

// ── Test C: a freshly-adopted pinned bridge survives a pending evict timer (round-2 sibling of fix 1) ──
{
  let attachCalls = 0;
  const registry = new AgentRegistry();
  registry.register({
    id: 'claude',
    displayName: 'Claude',
    capabilities: {} as any,
    isAvailable: async () => true,
    discoverSessions: async () => [],
    attach: async () => {
      attachCalls++;
      return fakeConn(observeInfo('s-c'));
    },
  } as any);
  const GRACE = 50;
  const hub = new Hub(registry, GRACE);

  // A bare Observe conn with zero clients → release() arms the grace-window dispose timer.
  await hub.ensure('claude', 's-c');
  hub.release('claude', 's-c');

  // Within the grace window a hook hello adopts the live bridge (the existing-branch upgrade path).
  let bridgeClosed = false;
  const bridge = fakeConn(syncedInfo('s-c'));
  bridge.close = async () => { bridgeClosed = true; };
  hub.adopt('claude', 's-c', bridge);

  // Wait past the grace window: the stale timer must NOT dispose the now-pinned bridge.
  await new Promise((r) => setTimeout(r, GRACE + 80));

  const after = hub.getConn('claude', 's-c');
  check('C1 freshly-adopted pinned bridge survives the pending evict timer', after?.conn === bridge);
  check('C2 the live bridge was NOT close()d by the stale timer', bridgeClosed === false);
  check('C3 sync stays active after the grace window elapses', after?.conn.info.control?.terminalSync.active === true);
}

// ── Test D: rekey() merge frees the OLD wrapper's local resources without closing the transferred conn ──
// (round-3 leak: the merged-away wrapper kept its fs.watch + 2s interval + a 2nd live subscription forever.)
{
  let existingSubs = 0;
  let existingClosed: boolean = false;
  const existingConn: SessionConnection = {
    info: { ...observeInfo('canon'), tool: 'pi' },
    getHistory: async () => [],
    subscribe: () => { existingSubs++; return () => { existingSubs--; }; },
    sendPrompt: async () => {},
    respondPermission: async () => {},
    close: async () => { existingClosed = true; },
  };
  const registry = new AgentRegistry();
  registry.register({
    id: 'pi', displayName: 'Pi', capabilities: {} as any, isAvailable: async () => true,
    discoverSessions: async () => [], attach: async () => existingConn,
  } as any);
  const hub = new Hub(registry, 15000);

  // The conn already at newKey (a WS Observe client attached under the canonical id), subscribed once.
  await hub.ensure('pi', 'canon');

  // The pinned bridge adopted under the symlink id (oldKey), subscribed once to its own conn.
  let bridgeSubs = 0;
  let bridgeClosed: boolean = false;
  const bridgeConn: SessionConnection = {
    info: { ...syncedInfo('sym'), tool: 'pi' },
    getHistory: async () => [],
    subscribe: () => { bridgeSubs++; return () => { bridgeSubs--; }; },
    sendPrompt: async () => {},
    respondPermission: async () => {},
    close: async () => { bridgeClosed = true; },
  };
  hub.adopt('pi', 'sym', bridgeConn);

  // Canonicalize: merge oldKey (pi:sym) into newKey (pi:canon) — `existing` adopts the bridge conn.
  hub.rekey('pi', 'sym', 'canon');

  check('D1 bridge conn ends with exactly ONE live subscription (old wrapper detached — no leak)', bridgeSubs === 1, `bridgeSubs=${bridgeSubs}`);
  check('D2 the transferred bridge conn was NOT closed (existing owns it now)', !bridgeClosed);
  check('D3 existing previous conn was closed + unsubscribed by replaceConnection', existingClosed && existingSubs === 0, `existingClosed=${existingClosed} existingSubs=${existingSubs}`);
  const after = hub.getConn('pi', 'canon');
  check('D4 surviving wrapper at newKey serves the bridge conn', after?.conn === bridgeConn);
}

if (failures) {
  console.error(`\nFAIL: ${failures} hub pinned-refresh check(s) failed.`);
  process.exit(1);
}
console.log('\n✅ hub pinned-refresh regression: all checks passed.');
