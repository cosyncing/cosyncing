#!/usr/bin/env bun
/**
 * Regression — multi-client composer draft sync (issues-part2).
 *
 * Every client attached to one session shares ONE unsent draft: a `{kind:'draft'}` frame fans out to
 * all clients on change and is replayed to a late joiner. It is relay-only (never touches the agent), so
 * it lives OUTSIDE the mutation gate — an Observe-only client can still see (and contribute to) the draft.
 * Sending a prompt clears it everywhere.
 */
import { ManagedConn } from '../../src/sessions/hub.ts';
import { type SessionConnection, type SessionInfo, type AgentMessageHandler } from '../../../adapter-api/src/index.ts';

let failures = 0;
const check = (label: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  — ${extra}` : ''}`);
  if (!ok) failures++;
};

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

const conn = new ManagedConn(fakeConn());

const a: any[] = [];
const b: any[] = [];
conn.addClient((e: any) => a.push(e));
conn.addClient((e: any) => b.push(e));

// 1. setDraft fans out to BOTH clients with the text + a timestamp.
conn.setDraft('hello world');
const aDraft = a.filter((e) => e.kind === 'draft');
const bDraft = b.filter((e) => e.kind === 'draft');
check('setDraft fans out to every attached client', aDraft.length === 1 && bDraft.length === 1 && aDraft[0].text === 'hello world', JSON.stringify(aDraft[0]));
check('draft frame carries a monotone timestamp', typeof aDraft[0].at === 'number' && aDraft[0].at > 0);

// 2. draftSnapshot replays the CURRENT draft to a late joiner (non-empty only).
const snap = conn.draftSnapshot();
check('draftSnapshot returns the current non-empty draft', !!snap && snap.text === 'hello world');

// 3. Clearing the draft → snapshot is null (nothing to replay).
conn.setDraft('');
check('empty draft → draftSnapshot null (no late-join replay of blank)', conn.draftSnapshot() === null);
const aClear = a.filter((e) => e.kind === 'draft');
check('clearing still broadcasts (so other composers empty too)', aClear.length === 2 && aClear[1].text === '');

console.log(`\n${failures ? `${failures} FAILED` : 'draft-sync regression: all checks passed.'}`);
process.exit(failures ? 1 : 0);
