#!/usr/bin/env bun
/**
 * CR2 — the broker's pending-request bookkeeping settles exactly once and can
 * neither underflow nor react to a suppressed orphan resolution.
 *
 * `ManagedConn.accumulateLive` folds request/resolution frames into
 * `pendingInput` (the needs-input counter behind SessionInfo.status and the
 * attach-time pending replay). These checks prove:
 *
 *  A: a genuine request flips status to needs-input; its resolution settles it
 *     back to the derived status exactly once;
 *  B: a duplicate resolution for the same id and an orphan resolution for an
 *     id never requested are both no-ops (no underflow, no status change, no
 *     retention flap);
 *  C: pending replay for a late joiner contains only unresolved requests.
 *  D: durable attention resolves a genuine request and ignores an orphan
 *     resolution for another id.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../../src/sessions/hub.ts';
import { AttentionPolicy } from '../../src/attention/attention-policy.ts';
import { AttentionStore } from '../../src/attention/attention-store.ts';
import {
  AgentRegistry,
  type AgentMessage,
  type SessionConnection,
  type SessionInfo,
} from '../../../adapter-api/src/index.ts';

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

const info: SessionInfo = { id: 's1', tool: 'codex', machine: 'test', title: 't', status: 'idle', attachMode: 'resume' } as SessionInfo;
const registry = new AgentRegistry();
const conn = fakeConn(info);
registry.register({
  id: 'codex', displayName: 'Codex', capabilities: {} as any,
  isAvailable: async () => true, discoverSessions: async () => [],
  attach: async () => conn,
} as any);
const hub = new Hub(registry, 15000);
const mc = await hub.ensure('codex', 's1');

// ── A: request → needs-input, one resolution settles it ─────────────────────
conn.emit({ type: 'permission-request', requestId: 'p1', title: 't' } as AgentMessage);
check('A1 a genuine request flips the session to needs-input', mc.status === 'needs-input', mc.status);
check('A2 the pending request retains the zero-client connection', mc.requiresAttentionRetention === true);
conn.emit({ type: 'permission-resolved', requestId: 'p1', decision: 'approve' } as AgentMessage);
check('A3 the genuine resolution settles the counter back to idle', mc.status === 'idle', mc.status);
check('A4 retention releases with the settled request', mc.requiresAttentionRetention === false);

// ── B: duplicates and orphans are no-ops ────────────────────────────────────
conn.emit({ type: 'permission-resolved', requestId: 'p1', decision: 'approve' } as AgentMessage);
check('B1 a duplicate resolution cannot underflow or change status', mc.status === 'idle', mc.status);
conn.emit({ type: 'question-resolved', requestId: 'never-requested' } as AgentMessage);
check('B2 an orphan resolution for an unknown id changes nothing', mc.status === 'idle' && mc.requiresAttentionRetention === false);
conn.emit({ type: 'question-request', requestId: 'q1', questions: [] } as unknown as AgentMessage);
conn.emit({ type: 'permission-resolved', requestId: 'q-other', decision: 'reject' } as AgentMessage);
check('B3 a resolution for one id cannot clear another pending id', mc.status === 'needs-input', mc.status);

// ── C: late-joiner replay carries only unresolved requests ──────────────────
const replayed = mc.liveSnapshot().filter((m: any) => m.type === 'permission-request' || m.type === 'question-request');
check('C1 pending replay contains exactly the unresolved request', replayed.length === 1 && (replayed[0] as any).requestId === 'q1',
  JSON.stringify(replayed.map((m: any) => m.requestId)));
conn.emit({ type: 'question-resolved', requestId: 'q1' } as AgentMessage);
check('C2 settling the last request empties the replay set', mc.liveSnapshot().every((m: any) => m.type !== 'question-request') && mc.status === 'idle');

await hub.dispose();

// ── D: attention follows genuine ids and ignores orphans ────────────────────
const attentionRoot = mkdtempSync(join(tmpdir(), 'cosyncing-cr2-attention-'));
try {
  const store = new AttentionStore({ home: attentionRoot });
  const policy = new AttentionPolicy(store);
  await policy.handleMessage(info, {
    type: 'permission-request',
    requestId: 'attention-p1',
    title: 'approval',
  } as AgentMessage);
  await policy.handleMessage(info, {
    type: 'permission-resolved',
    requestId: 'attention-ghost',
    decision: 'reject',
  } as AgentMessage);
  check(
    'D1 an orphan resolution cannot clear another attention item',
    store.listActive().length === 1 &&
      store.listActive()[0]?.dedupeKey.endsWith(':attention-p1') === true,
  );
  await policy.handleMessage(info, {
    type: 'permission-resolved',
    requestId: 'attention-p1',
    decision: 'approve',
  } as AgentMessage);
  check('D2 a genuine resolution returns the attention count to zero', store.listActive().length === 0);
  await policy.handleMessage(info, {
    type: 'permission-resolved',
    requestId: 'attention-p1',
    decision: 'approve',
  } as AgentMessage);
  check('D3 a duplicate genuine resolution leaves attention at zero', store.listActive().length === 0);
} finally {
  rmSync(attentionRoot, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} request-resolution hygiene check(s) failed.`);
  process.exit(1);
}
console.log('\nAll request-resolution hygiene checks passed.');
