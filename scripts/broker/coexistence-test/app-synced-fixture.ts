#!/usr/bin/env bun
/**
 * Seed a hooks-SYNCED Claude session into a running broker for the Playwright app review (NO claude).
 * Writes a rich transcript + activity tree on disk, hello's it as a synced live session, then keeps a
 * PERMISSION and a QUESTION pending (re-posting like the real hook) so the browser can answer them live.
 *
 *   Start the source broker through `bun run broker` (the explicit D14 development bypass), then:
 *   PORT=7796 bun run scripts/broker/coexistence-test/app-synced-fixture.ts   (keeps running; Ctrl-C to stop)
 *   Packaged v1 intentionally returns 404 for this contributor-only hook fixture.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeSessionId, claudeActivityDir } from '../../../packages/typescript/adapters/claude/src/index.ts';

const PORT = Number(process.env.PORT || '7796');
const BASE = `http://127.0.0.1:${PORT}`;
// The broker validates transcriptPath is under a Claude projects root → place it under CLAUDE_CONFIG_DIR/projects.
const CONFIG = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const WORK = join(CONFIG, 'projects', 'app-synced-fixture');
const transcriptPath = join(WORK, 'session.jsonl');
const id = claudeSessionId(transcriptPath);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);
async function post(path: string, body: unknown): Promise<any> { try { return await (await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json(); } catch { return null; } }

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
writeFileSync(transcriptPath, [
  { type: 'user', uuid: 'u1', message: { role: 'user', content: 'investigate the queue health and dispatch a reviewer' } },
  { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Let me investigate the queue health, then I will run a quick audit.' }] } },
  { type: 'assistant', uuid: 'a2', message: { id: 'm2', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'grep -rn enqueue src' } }] } },
  { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'src/queue.ts:42: enqueue(job)' }] } },
  { type: 'assistant', uuid: 'a3', message: { id: 'm3', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_todo', name: 'TodoWrite', input: { todos: [
    { content: 'Investigate queue health', status: 'completed', activeForm: 'Investigating queue health' },
    { content: 'Add the queue-health guard', status: 'in_progress', activeForm: 'Adding the guard' },
    { content: 'Write a regression test', status: 'pending', activeForm: 'Writing the test' },
  ] } }] } },
  { type: 'assistant', uuid: 'a4', message: { id: 'm4', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_A', name: 'Task', input: { description: 'Review the queue health guard', subagent_type: 'general-purpose' } }] } },
  { type: 'assistant', uuid: 'a5', message: { id: 'm5', role: 'assistant', content: [{ type: 'text', text: 'Reviewer dispatched; launching the audit workflow while it runs.' }] } },
].map((l) => JSON.stringify(l)).join('\n') + '\n');

const sess = claudeActivityDir(transcriptPath);
mkdirSync(join(sess, 'subagents', 'workflows', 'wf_live01'), { recursive: true });
writeFileSync(join(sess, 'subagents', 'agent-A.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Review the queue health guard', toolUseId: 'toolu_A' }));
writeFileSync(join(sess, 'subagents', 'agent-A.jsonl'), JSON.stringify({ type: 'assistant', timestamp: '2026-06-22T10:00:00.000Z', message: { id: 'sm1', usage: { output_tokens: 120 } } }) + '\n');
writeFileSync(join(sess, 'subagents', 'workflows', 'wf_live01', 'journal.jsonl'), [JSON.stringify({ agentId: 'L1', type: 'started' }), JSON.stringify({ agentId: 'L2', type: 'started' }), JSON.stringify({ agentId: 'L1', type: 'result', result: {} })].join('\n') + '\n');

log(`fixture written. id=${id}`);
const hello = await post('/claude/hook/hello', { transcriptPath, sessionUuid: 'app-synced', cwd: WORK, title: 'queue health (synced)' });
if (!hello?.ok) {
  throw new Error('Claude hook fixture is unavailable. Start the source broker with `bun run broker`; packaged v1 has no hook surface.');
}
log(`hello: ${JSON.stringify(hello)}`);
log(`open the app:  ${BASE}   → session "queue health (synced)"`);

// Keep a permission AND a question pending until the browser answers them (re-post like the real hook).
async function keepPending(requestId: string, body: any): Promise<void> {
  for (;;) {
    const r = await post('/claude/hook/request', { id, requestId, transcriptPath, ...body });
    if (r?.resolved) { log(`✓ ${requestId} resolved from the app: ${JSON.stringify(r)}`); return; }
    await sleep(r?.viewers === 0 ? 1500 : 300); // viewers:0 → no browser yet; else long-poll returned empty
  }
}
void keepPending('pw-perm', { kind: 'permission', toolName: 'Bash', title: 'Run command', detail: 'sudo systemctl restart queue-worker' });
void keepPending('pw-q', { kind: 'question', questions: [{ question: 'Add the queue-health guard now?', header: 'Queue guard', options: [{ label: 'Yes, add it', description: 'apply the guard this turn' }, { label: 'Not now', description: 'defer to a follow-up' }], multiSelect: false }] });
log('keeping pw-perm + pw-q pending for the browser to answer…');
await new Promise(() => {}); // stay alive
