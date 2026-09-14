#!/usr/bin/env bun
export {};
import { CONTEXT_INJECTION_EVENT, type AgentMessage } from '@cosyncing/adapter-api';
import {
  mapReasonixRecord,
  mapReasonixInterruptedTail,
  mapReasonixTranscript,
  reasonixMessageKey,
} from '../src/mapping.ts';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function typed<T extends AgentMessage['type']>(messages: AgentMessage[], type: T): Extract<AgentMessage, { type: T }>[] {
  return messages.filter((message): message is Extract<AgentMessage, { type: T }> => message.type === type);
}

const traces: string[] = [];
const mapped = mapReasonixTranscript('session-1', [
  { role: 'system', content: 'Current workspace: /tmp/example' },
  { role: 'user', content: 'normalized', raw_content: 'typed text', createdAt: 1_777_777_777_777 },
  { role: 'assistant', reasoning_content: 'thinking', content: 'answer', workDurationMs: 321 },
  { role: 'future-role', content: 'future payload', futureField: true },
], [
  { index: 0, offset: 0, length: 10, role: 'system', authoredTurn: 0 },
  { index: 1, offset: 10, length: 10, role: 'user', authoredTurn: 1, startsTurn: true },
  { index: 2, offset: 20, length: 10, role: 'assistant', authoredTurn: 1 },
  { index: 3, offset: 30, length: 10, role: 'future-role', authoredTurn: 2 },
], (event) => traces.push(`${event.op}:${event.detail}`));

const users = typed(mapped, 'user-message');
check('only the native user role becomes a human bubble', users.length === 1, JSON.stringify(users));
check('the user row prefers raw_content and carries the native timestamp',
  users[0]?.text === 'typed text'
    && users[0]?.sentAt === 1_777_777_777_777
    && users[0]?.key === reasonixMessageKey('session-1', 1),
  JSON.stringify(users[0]));

const events = typed(mapped, 'event');
check('system material is a context injection, not a notice or user row',
  events.some((event) => event.name === CONTEXT_INJECTION_EVENT
    && (event.payload as Record<string, unknown> | undefined)?.source === 'Reasonix system context'));
check('an unknown role maps to a named neutral context event and is traced',
  events.some((event) => String((event.payload as Record<string, unknown> | undefined)?.source).includes('future-role'))
    && traces.some((trace) => trace.startsWith('unmapped-record:')),
  traces.join(' | '));

const thinking = typed(mapped, 'thinking');
const output = typed(mapped, 'model-output');
check('assistant reasoning and answer become thinking plus final model output',
  thinking[0]?.text === 'thinking' && output[0]?.text === 'answer' && output[0]?.final === true,
  JSON.stringify({ thinking, output }));

const whitespace = mapReasonixRecord(
  { role: 'assistant', reasoning_content: '\n  indented thought  \n', content: '\n```text\n  exact body  \n```\n' },
  { sessionId: 'session-1', lineIndex: 4 },
);
check('assistant content uses trim only for emptiness and preserves stored whitespace',
  whitespace[0]?.type === 'thinking'
    && whitespace[0].text === '\n  indented thought  \n'
    && whitespace[1]?.type === 'model-output'
    && whitespace[1].text === '\n```text\n  exact body  \n```\n',
  JSON.stringify(whitespace));

const toolResult = mapReasonixRecord(
  {
    role: 'tool',
    content: 'done',
    tool_call_id: 'measured-call-id',
    name: 'bash',
    tool_execution: { state: 'completed', exitCode: 0 },
  },
  {
    sessionId: 'session-1',
    lineIndex: 5,
    display: { index: 5, offset: 50, length: 10, role: 'tool', authoredTurn: 1 },
  },
);
const failedToolResult = mapReasonixRecord(
  {
    role: 'tool',
    content: 'failed',
    tool_call_id: 'failed-call-id',
    name: 'bash',
    tool_execution: { state: 'failed', exitCode: 1 },
  },
  { sessionId: 'session-1', lineIndex: 6 },
);
check('measured native tool rows replay as bounded tool results',
  toolResult[0]?.type === 'tool-result'
    && toolResult[0].callId === 'measured-call-id'
    && toolResult[0].toolName === 'bash'
    && toolResult[0].result === 'done'
    && toolResult[0].isError === false
    && failedToolResult[0]?.type === 'tool-result'
    && failedToolResult[0].isError === true,
  JSON.stringify({ toolResult, failedToolResult }));

const summaries = typed(mapped, 'run-summary');
check('run-summary carries authoritative timing only, never invented token fields',
  summaries[0]?.agentRuntimeMs === 321
    && summaries[0]?.status === 'done'
    && summaries[0]?.tokens === undefined,
  JSON.stringify(summaries[0]));

const garbage = mapReasonixRecord(
  { role: null, content: { unexpected: true }, nested: ['shape'] },
  { sessionId: 'session-1', lineIndex: 9 },
);
check('garbage input is total and never becomes a user bubble',
  garbage.length === 1 && garbage[0]?.type === 'event',
  JSON.stringify(garbage));

const mismatches: string[] = [];
mapReasonixRecord(
  { role: 'assistant', content: 'ok' },
  {
    sessionId: 'session-1',
    lineIndex: 2,
    display: { index: 2, offset: 0, length: 1, role: 'user' },
    trace: (event) => mismatches.push(event.op),
  },
);
check('display-index role drift is traced without dropping the record',
  mismatches.includes('display-index-mismatch'), mismatches.join(','));

const interrupted = mapReasonixInterruptedTail(
  'session-1',
  [{ role: 'assistant', content: 'old' }, { role: 'user', content: 'unfinished' }],
  [
    { index: 0, offset: 0, length: 1, role: 'assistant', authoredTurn: 0 },
    { index: 1, offset: 1, length: 1, role: 'user', authoredTurn: 1, startsTurn: true },
  ],
);
check('an ownerless durable user tail maps to a cancelled run instead of running forever',
  interrupted?.type === 'run-summary'
    && interrupted.status === 'cancelled'
    && interrupted.userMessageKey === reasonixMessageKey('session-1', 1),
  JSON.stringify(interrupted));

const interruptedToolTurn = mapReasonixInterruptedTail(
  'session-1',
  [
    { role: 'assistant', content: 'old' },
    { role: 'user', content: 'cancelled while starting a tool' },
    { role: 'tool', name: '__reasonix_local_only__', tool_call_id: '__reasonix_local_only__' },
  ],
  [
    { index: 0, offset: 0, length: 1, role: 'assistant', authoredTurn: 0 },
    { index: 1, offset: 1, length: 1, role: 'user', authoredTurn: 1, startsTurn: true },
    { index: 2, offset: 2, length: 1, role: 'tool', authoredTurn: 1 },
  ],
);
check('a cancelled native user-plus-tool tail maps to the same cancelled run summary',
  interruptedToolTurn?.type === 'run-summary'
    && interruptedToolTurn.status === 'cancelled'
    && interruptedToolTurn.userMessageKey === reasonixMessageKey('session-1', 1),
  JSON.stringify(interruptedToolTurn));

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
