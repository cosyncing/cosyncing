#!/usr/bin/env bun
export {};
import { type AgentMessage } from '@cosyncing/adapter-api';
import {
  mapReasonixRecord,
  mapReasonixTranscript,
  reasonixMessageKey,
} from '../src/mapping.ts';
import { mapReasonixSessionUpdate } from '../src/drive.ts';

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
// display-index-drift, interrupted-tail). What stays here is live ACP parity and positional call ids.

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

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
