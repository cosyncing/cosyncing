#!/usr/bin/env bun
/**
 * Regression — a run-state transition must push a `{ kind: 'session' }` frame to attached clients
 * (UI-Issue part1 item 7, "stale Working status").
 *
 * `ManagedConn.accumulateLive` folds `status` / permission messages into `conn.info.status`, but
 * before this fix it never told anyone. An attached websocket client therefore kept whatever status
 * it saw at attach time for the rest of the connection: a session that finished still read `working`
 * until the page was reloaded. `broadcastSession` already existed for metadata updates and uses the
 * existing SessionWireEvent, so this is a broadcast gap, not a contract gap.
 *
 * A: `status: running` → a session frame carrying `working`.
 * B: `status: idle` → a session frame carrying `idle` (the reported bug).
 * C: a permission-request → `needs-input`, and its resolution → back to the derived status.
 * D: messages that do NOT change status (streamed text, a repeated `status: running`) broadcast
 *    nothing — the fix must not turn every token into a control frame.
 */
import { Hub } from '../../src/sessions/hub.ts';
import { authoritativeLiveOwners, type LiveOverlayEntry } from '../../src/roster/roster-overlay.ts';
import { AgentRegistry, type AgentMessage, type SessionConnection, type SessionInfo } from '../../../adapter-api/src/index.ts';

let failures = 0;
const check = (label: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  — ${extra}` : ''}`);
  if (!ok) failures++;
};

function fakeConn(info: SessionInfo): SessionConnection & { emit: (m: AgentMessage) => void } {
  const handlers = new Set<(m: AgentMessage) => void>();
  const conn: any = {
    info,
    emit: (m: AgentMessage) => { for (const h of handlers) h(m); },
    getHistory: async () => [],
    subscribe: (h: (m: AgentMessage) => void) => { handlers.add(h); return () => handlers.delete(h); },
    sendPrompt: async () => {},
    respondPermission: async () => {},
    close: async () => {},
  };
  return conn;
}
const info = (id: string): SessionInfo => ({ id, tool: 'pi', machine: 'test', title: 't', status: 'idle', attachMode: 'live' } as SessionInfo);

const registry = new AgentRegistry();
const conn = fakeConn(info('s1'));
registry.register({
  id: 'pi', displayName: 'Pi', capabilities: {} as any,
  isAvailable: async () => true, discoverSessions: async () => [],
  attach: async () => conn,
} as any);
const hub = new Hub(registry, 15000);
const mc = await hub.ensure('pi', 's1');

const sessionFrames: SessionInfo[] = [];
mc.addClient((ev: any) => { if (ev.kind === 'session') sessionFrames.push({ ...ev.info }); });

// ── A: the turn starts ──────────────────────────────────────────────────────────────────────────
conn.emit({ type: 'status', status: 'running' } as AgentMessage);
check('A1 a `running` status broadcasts one session frame', sessionFrames.length === 1, `frames=${sessionFrames.length}`);
check('A2 the frame carries the working status', sessionFrames.at(-1)?.status === 'working', String(sessionFrames.at(-1)?.status));

// ── D (part 1): non-transitions stay quiet ──────────────────────────────────────────────────────
conn.emit({ type: 'model-output', key: 'k1', delta: 'hello' } as AgentMessage);
conn.emit({ type: 'status', status: 'running' } as AgentMessage);
check('D1 streamed text and a repeated `running` broadcast nothing', sessionFrames.length === 1, `frames=${sessionFrames.length}`);

// ── C: the agent blocks on the user, then unblocks ──────────────────────────────────────────────
conn.emit({ type: 'permission-request', requestId: 'r1', title: 'may i' } as AgentMessage);
check('C1 a permission-request broadcasts needs-input', sessionFrames.length === 2 && sessionFrames.at(-1)?.status === 'needs-input',
  `frames=${sessionFrames.length} status=${sessionFrames.at(-1)?.status}`);
conn.emit({ type: 'permission-resolved', requestId: 'r1', decision: 'approve' } as AgentMessage);
check('C2 resolving it broadcasts the derived status (still running → working)',
  sessionFrames.length === 3 && sessionFrames.at(-1)?.status === 'working',
  `frames=${sessionFrames.length} status=${sessionFrames.at(-1)?.status}`);

// ── B: the turn finishes — the reported bug ─────────────────────────────────────────────────────
conn.emit({ type: 'status', status: 'idle' } as AgentMessage);
check('B1 an `idle` status broadcasts a session frame', sessionFrames.length === 4, `frames=${sessionFrames.length}`);
check('B2 the frame carries idle, so the app drops the stale "Working"', sessionFrames.at(-1)?.status === 'idle', String(sessionFrames.at(-1)?.status));

// ── D (part 2): a repeated terminal status stays quiet ──────────────────────────────────────────
conn.emit({ type: 'status', status: 'idle' } as AgentMessage);
check('D2 a repeated `idle` broadcasts nothing', sessionFrames.length === 4, `frames=${sessionFrames.length}`);

// ── F: replacement starts from the adapter's exact projection ──────────────────────────────────
const replacement = fakeConn({ ...info('s1'), status: 'needs-input' });
mc.replaceConnection(replacement);
check('F1 a replacement owner seeds needs-input before replay/subscription evidence', mc.status === 'needs-input', `status=${mc.status}`);
replacement.emit({ type: 'status', status: 'running' } as AgentMessage);
check('F2 the first authoritative running frame clears provisional needs-input', mc.status === 'working', `status=${mc.status}`);
replacement.emit({ type: 'permission-request', requestId: 'r2', title: 'still blocked' } as AgentMessage);
replacement.emit({ type: 'status', status: 'running' } as AgentMessage);
check('F3 a real pending request remains needs-input across a running frame', mc.status === 'needs-input', `status=${mc.status}`);
replacement.emit({ type: 'permission-resolved', requestId: 'r2', decision: 'approve' } as AgentMessage);
check('F4 resolving the real request restores working', mc.status === 'working', `status=${mc.status}`);
replacement.emit({ type: 'status', status: 'idle' } as AgentMessage);
check('F5 authoritative idle retires the replacement turn', mc.status === 'idle', `status=${mc.status}`);

// ── E: one session, several live owners — the roster overlay must pick exactly one ──────────────
// A read-only Observe tail and an explicit Drive attach are DISTINCT Hub owners of the same session
// id, and their run states legitimately disagree mid-turn. Applying each in turn let Map iteration
// order decide, so a later-iterated Observe entry could push the roster back from working to idle
// with no client event able to undo it (R0b).
const driveOwner: LiveOverlayEntry = {
  key: 'pi:s9#resume',
  info: { ...info('s9'), attachMode: 'resume', control: { drive: { supported: true, state: 'driving' }, terminalSync: { supported: false, active: false } } } as SessionInfo,
  status: 'working',
};
const observeOwner: LiveOverlayEntry = { key: 'pi:s9', info: { ...info('s9'), attachMode: 'live' }, status: 'idle' };

const driveFirst = authoritativeLiveOwners([driveOwner, observeOwner]).get('pi:s9');
const observeFirst = authoritativeLiveOwners([observeOwner, driveOwner]).get('pi:s9');
check('E1 the Drive owner is authoritative when it is seen first', driveFirst?.status === 'working', `status=${driveFirst?.status} key=${driveFirst?.key}`);
check('E2 the Drive owner is still authoritative when the Observe tail is seen first', observeFirst?.status === 'working', `status=${observeFirst?.status} key=${observeFirst?.key}`);
check('E3 both insertion orders select the same owner', driveFirst?.key === observeFirst?.key, `${driveFirst?.key} vs ${observeFirst?.key}`);
check('E4 exactly one owner survives per session', authoritativeLiveOwners([driveOwner, observeOwner]).size === 1, `size=${authoritativeLiveOwners([driveOwner, observeOwner]).size}`);

// Equal control claims must still resolve deterministically: newer info first, then the Hub key.
const staleTwin: LiveOverlayEntry = { key: 'pi:s8#a', info: { ...info('s8'), updatedAt: 100 } as SessionInfo, status: 'idle' };
const freshTwin: LiveOverlayEntry = { key: 'pi:s8#b', info: { ...info('s8'), updatedAt: 200 } as SessionInfo, status: 'working' };
check('E5 equal control claims break the tie by recency, in both orders',
  authoritativeLiveOwners([staleTwin, freshTwin]).get('pi:s8')?.status === 'working' &&
    authoritativeLiveOwners([freshTwin, staleTwin]).get('pi:s8')?.status === 'working');
const twinA: LiveOverlayEntry = { key: 'pi:s7#a', info: { ...info('s7'), updatedAt: 100 } as SessionInfo, status: 'idle' };
const twinB: LiveOverlayEntry = { key: 'pi:s7#b', info: { ...info('s7'), updatedAt: 100 } as SessionInfo, status: 'working' };
check('E6 fully tied owners resolve by Hub key, in both orders',
  authoritativeLiveOwners([twinA, twinB]).get('pi:s7')?.key === 'pi:s7#a' &&
    authoritativeLiveOwners([twinB, twinA]).get('pi:s7')?.key === 'pi:s7#a');

// The Hub itself must hand the overlay the owning key, or the tiebreak has nothing stable to use.
check('E7 the Hub reports the owning key with every live connection', hub.liveSnapshot().every((e) => typeof e.key === 'string' && e.key.length > 0),
  JSON.stringify(hub.liveSnapshot().map((e) => e.key)));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
