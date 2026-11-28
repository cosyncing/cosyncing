#!/usr/bin/env bun
export {};
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AgentMessage } from '@cosyncing/adapter-api';
import {
  mapReasonixRecord,
  mapReasonixTranscript,
  reasonixMessageKey,
  reasonixPlanKey,
  type ReasonixTranscriptRecord,
} from '../src/mapping.ts';
import { mapReasonixSessionUpdate, reasonixPlanUpdate } from '../src/drive.ts';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function typed<T extends AgentMessage['type']>(messages: AgentMessage[], type: T): Extract<AgentMessage, { type: T }>[] {
  return messages.filter((message): message is Extract<AgentMessage, { type: T }> => message.type === type);
}

// Transcript mapping (roles, raw_content, context injection, unknown roles, reasoning/answer rows, whitespace,
// tool results, run-summary timing, garbage input, display-index drift, interrupted tails) is asserted by the
// corpus e2e/adapters/mapping/reasonix.test.ts (cases turn-with-tools, unknown-additive-values, garbage-input,
// display-index-drift, interrupted-tail). What stays here is live ACP parity (calls, results and plans) and
// positional call ids.

// A tool step's calls. v1.25.2 dispatches each stored `tool_calls` entry over ACP under its own
// id (the result's tool row carries the same id), so a replayed call is the row the live drive
// emitted for it: a client that watched the turn and one that reloads it hold the same call.
const bigInput = { content: 'x'.repeat(70_000) };
const toolStep = mapReasonixTranscript('session-1', [
  { role: 'user', content: 'list it', raw_content: 'list it' },
  {
    role: 'assistant',
    content: 'checking',
    workDurationMs: 4,
    tool_calls: [
      { id: 'call_00_list', name: 'bash', arguments: '{"command":"ls"}' },
      { id: 'call_01_read', name: 'read_file', arguments: 'not json' },
      { id: 'call_02_write', name: 'write_file', arguments: JSON.stringify(bigInput) },
    ],
  },
  { role: 'tool', name: 'bash', tool_call_id: 'call_00_list', content: 'README.md' },
  { role: 'tool', name: 'read_file', tool_call_id: 'call_01_read', content: 'refused' },
  { role: 'tool', name: 'write_file', tool_call_id: 'call_02_write', content: 'written' },
  { role: 'assistant', content: 'done', workDurationMs: 9 },
]);
// What ACP sent for the same calls: `rawInput` is the stored arguments when they parse, else absent.
const liveCalls = [
  { sessionUpdate: 'tool_call', toolCallId: 'call_00_list', title: 'bash', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } },
  { sessionUpdate: 'tool_call', toolCallId: 'call_01_read', title: 'read_file', kind: 'read', status: 'pending' },
  { sessionUpdate: 'tool_call', toolCallId: 'call_02_write', title: 'write_file', kind: 'edit', status: 'pending', rawInput: bigInput },
].flatMap((update) => mapReasonixSessionUpdate(update));
const replayedCalls = typed(toolStep, 'tool-call');
check('a tool step replays each call as the row the live drive emitted for it',
  replayedCalls.length === 3 && JSON.stringify(replayedCalls) === JSON.stringify(liveCalls),
  JSON.stringify({ replayedCalls, liveCalls }).slice(0, 600));
const stepShape = toolStep.map((message) => message.type === 'tool-call' || message.type === 'tool-result'
  ? `${message.type}:${message.callId}` : message.type);
check('the calls follow their step footer, just before the tool rows holding their results',
  JSON.stringify(stepShape) === JSON.stringify([
    'user-message', 'model-output', 'run-summary',
    'tool-call:call_00_list', 'tool-call:call_01_read', 'tool-call:call_02_write',
    'tool-result:call_00_list', 'tool-result:call_01_read', 'tool-result:call_02_write',
    'model-output', 'run-summary',
  ]),
  JSON.stringify(stepShape));
const unnamed = () => mapReasonixRecord(
  { role: 'assistant', tool_calls: ['garbage', { name: 'bash', arguments: '{}' }] },
  { sessionId: 'session-1', lineIndex: 7 },
);
check('a stored call with no usable id keeps a positional id, the same on every read',
  JSON.stringify(unnamed()) === JSON.stringify(unnamed())
    && unnamed().length === 1
    && unnamed()[0]?.type === 'tool-call'
    && (unnamed()[0] as { callId: string }).callId === `${reasonixMessageKey('session-1', 7)}:call:1`,
  JSON.stringify(unnamed()));
const interruptedDisplay = mapReasonixRecord(
  {
    role: 'tool',
    name: '__reasonix_local_only__',
    tool_call_id: '__reasonix_local_only__',
    tool_calls: [{ id: 'call_partial', name: 'bash' }],
  },
  { sessionId: 'session-1', lineIndex: 8 },
);
check('only an assistant row restates calls: an interrupted stream\'s partial calls never ran',
  typed(interruptedDisplay, 'tool-call').length === 0, JSON.stringify(interruptedDisplay));

// One planning turn captured on both versions (scrubbed 2026-11-28 capture): todo_write with two
// steps, a bash command, complete_step for step 1, todo_write again, complete_step for step 2, and
// the answer. `live` is every session/update while the prompt ran, `replay` every session/update
// session/load sent for the same session in a fresh child, `transcript` the stored rows.
type PlanCapture = {
  sessionId: string;
  live: Array<{ sessionId: string; update: Record<string, unknown> }>;
  replay: Array<{ sessionId: string; update: Record<string, unknown> }>;
  transcript: string;
};
const capturedPlan = JSON.parse(readFileSync(
  join(import.meta.dir, 'fixtures', 'reasonix-plan-capture.json'),
  'utf8',
)) as Record<'v1.25.2' | 'v2.61.0', PlanCapture>;
for (const label of ['v1.25.2', 'v2.61.0'] as const) {
  const capture = capturedPlan[label];
  const rows = capture.transcript.split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as ReasonixTranscriptRecord);
  const stored = mapReasonixTranscript(capture.sessionId, rows);
  const storedPanels = typed(stored, 'task-list-state');
  const replayedPanels = capture.replay.flatMap(({ update }) => reasonixPlanUpdate(capture.sessionId, update) ?? []);
  const livePanels = capture.live.flatMap(({ update }) => reasonixPlanUpdate(capture.sessionId, update) ?? []);
  check(`${label}: each stored todo_write shows the plan Reasonix itself replays for it on session/load`,
    storedPanels.length === 2
      && storedPanels.every((panel) => panel.key === reasonixPlanKey(capture.sessionId))
      && JSON.stringify(storedPanels) === JSON.stringify(replayedPanels)
      && JSON.stringify(storedPanels[0]?.items) === JSON.stringify([
        { id: '0', title: 'Inspect the workspace', status: 'in-progress' },
        { id: '1', title: 'Report the result', status: 'open' },
      ]),
    JSON.stringify({ storedPanels, replayedPanels }).slice(0, 800));
  const firstCall = stored.findIndex((message) => message.type === 'tool-call' && message.toolName === 'todo_write');
  check(`${label}: a stored plan sits just before its todo_write call, where the live plan arrives`,
    firstCall > 0
      && stored[firstCall - 1]?.type === 'task-list-state'
      && capture.live.find(({ update }) => update.sessionUpdate === 'plan' || update.sessionUpdate === 'tool_call')
        ?.update.sessionUpdate === 'plan',
    JSON.stringify(stored.map((message) => message.type)));
  // complete_step advances the list on the host and sends that plan live only: the stored list
  // stops at the last todo_write, one step behind.
  check(`${label}: the live plan finishes the list while the stored one stays at the last todo_write`,
    livePanels.at(-1)?.status === 'done'
      && livePanels.at(-1)?.items.every((item) => item.status === 'done') === true
      && storedPanels.at(-1)?.status === 'running'
      && JSON.stringify(storedPanels.at(-1)?.items.map((item) => item.status)) === JSON.stringify(['done', 'in-progress']),
    JSON.stringify({ live: livePanels.at(-1), stored: storedPanels.at(-1) }));

  const storedResults = new Map(typed(stored, 'tool-result').map((message) => [message.callId, message.result] as const));
  const liveResults = typed(capture.live.flatMap(({ update }) => mapReasonixSessionUpdate(update)), 'tool-result')
    .filter((message) => storedResults.has(message.callId));
  const replayedResults = typed(capture.replay.flatMap(({ update }) => mapReasonixSessionUpdate(update)), 'tool-result');
  check(`${label}: a live tool result shows the text its stored row and the session/load replay hold`,
    liveResults.length >= 4
      && liveResults.every((message) => message.result === storedResults.get(message.callId))
      && replayedResults.length === storedResults.size
      && replayedResults.every((message) => message.result === storedResults.get(message.callId))
      && liveResults.some((message) => message.result === 'CAPT_TOOL_LINE_1\nCAPT_TOOL_LINE_2\n'),
    JSON.stringify({ liveResults, stored: [...storedResults] }).slice(0, 800));
}

// The edges of the same parsing, as upstream `planEntriesFromTodoArgs` decides them.
check('an empty live plan clears the panel; one with no showable entry is not a plan',
  reasonixPlanUpdate('session-1', { sessionUpdate: 'plan', entries: [] })?.status === 'cleared'
    && reasonixPlanUpdate('session-1', { sessionUpdate: 'plan', entries: [{ content: '  ', status: 'pending' }] }) === undefined
    && reasonixPlanUpdate('session-1', { sessionUpdate: 'plan' }) === undefined);
const storedPlan = (args: string) => typed(mapReasonixRecord(
  { role: 'assistant', tool_calls: [{ id: 'call_plan', name: 'todo_write', arguments: args }] },
  { sessionId: 'session-1', lineIndex: 3 },
), 'task-list-state');
check('a stored todo_write skips blank items and reads an unknown status as pending',
  JSON.stringify(storedPlan('{"todos":[{"content":"a","status":"blocked"},{"content":" ","status":"completed"},null]}')[0]?.items)
    === JSON.stringify([{ id: '0', title: 'a', status: 'open' }]));
check('a stored todo_write Reasonix could not decode, or with nothing to show, has no plan',
  storedPlan('{"todos":[{"content":"a","status":1}]}').length === 0
    && storedPlan('{"todos":[{"content":"a","level":0.5}]}').length === 0
    && storedPlan('{"todos":[]}').length === 0
    && storedPlan('not json').length === 0);
const emptyResult = typed(mapReasonixRecord(
  { role: 'tool', name: 'bash', tool_call_id: 'call_quiet' },
  { sessionId: 'session-1', lineIndex: 4 },
), 'tool-result')[0];
const liveEmptyResult = typed(mapReasonixSessionUpdate({
  sessionUpdate: 'tool_call_update',
  toolCallId: 'call_quiet',
  status: 'completed',
  content: [{ type: 'content', content: { type: 'text' } }],
}), 'tool-result')[0];
check('an empty tool result is empty text, stored (no content key) and live (no text) alike',
  emptyResult?.result === '' && liveEmptyResult?.result === '',
  JSON.stringify({ emptyResult, liveEmptyResult }));

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
