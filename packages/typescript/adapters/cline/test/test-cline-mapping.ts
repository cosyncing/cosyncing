#!/usr/bin/env bun
export {};
import { CONTEXT_INJECTION_EVENT, type AgentMessage } from '@cosyncing/adapter-api';
import {
  clinePendingToolUse,
  clineSessionUsage,
  clineTurnTokens,
  mapClineInterruptedTail,
  mapClineTranscript,
  mapClineMessage,
} from '../src/mapping.ts';
import type { ClineStoredSession } from '../src/store.ts';
import { CLINE_FIXTURE_ID, fixtureParentMessages } from './fixtures/tree.ts';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
function typed<T extends AgentMessage['type']>(messages: AgentMessage[], type: T): Extract<AgentMessage, { type: T }>[] {
  return messages.filter((message): message is Extract<AgentMessage, { type: T }> => message.type === type);
}

const messages = fixtureParentMessages();
const mapped = mapClineTranscript(CLINE_FIXTURE_ID, messages);
const users = typed(mapped, 'user-message');
check('only user text blocks become human bubbles',
  users.length === 1 && users[0]?.text === 'fixture prompt', JSON.stringify(users));
check('assistant text and thinking preserve exact content',
  typed(mapped, 'model-output').some((message) => message.text === 'fixture answer')
    && typed(mapped, 'thinking').some((message) => message.text === 'fixture thought'));
check('spawn_agent call/result pairs share identity and activity state',
  typed(mapped, 'tool-call').some((message) => message.callId === 'call-spawn')
    && typed(mapped, 'tool-result').some((message) => message.callId === 'call-spawn')
    && typed(mapped, 'agent-activity').some((message) => message.key === 'agent:call-spawn' && message.status === 'running')
    && typed(mapped, 'agent-activity').some((message) => message.key === 'agent:call-spawn' && message.status === 'done'));
const token = typed(mapped, 'token-count')[0];
check('input tokens remain cache-inclusive without double addition',
  token?.input === 100 && token.output === 20 && token.cacheRead === 40 && token.cacheWrite === 10,
  JSON.stringify(token));

// The exact shape a real `run_commands` result has -- read off the installed
// v70 session file. Note what is NOT there: no `is_error` key, on a block whose
// only keys are content/name/tool_use_id/type. Cline states the outcome in
// `content[].success`, and the row used to render "state unknown" beside its own
// prose saying the command had succeeded because nothing read it.
function commandBody(body: unknown, isError?: boolean) {
  return typed(mapClineMessage({
    id: 'cmd-1',
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'call-cmd',
      name: 'run_commands',
      content: body,
      ...(isError === undefined ? {} : { is_error: isError }),
    }],
  }, { sessionId: CLINE_FIXTURE_ID }), 'tool-result')[0];
}
function commandResult(success: unknown, extra: Record<string, unknown> = {}) {
  return mapClineMessage({
    id: 'cmd-1',
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'call-cmd',
      name: 'run_commands',
      content: [{ query: 'rm -f /tmp/marker && touch /tmp/marker', result: '', ...(success === undefined ? {} : { success }), ...extra }],
    }],
  }, { sessionId: CLINE_FIXTURE_ID });
}
const succeeded = typed(commandResult(true), 'tool-result')[0];
check('a command Cline reports as successful resolves a completed lifecycle',
  succeeded?.semantic?.kind === 'command'
    && succeeded.semantic.state === 'completed'
    && succeeded.semantic.command === 'rm -f /tmp/marker && touch /tmp/marker'
    && succeeded.isError === false,
  JSON.stringify(succeeded));
const failedCommand = typed(commandResult(false), 'tool-result')[0];
check('a command Cline reports as failed is both failed and an error',
  failedCommand?.semantic?.kind === 'command'
    && failedCommand.semantic.state === 'failed'
    && failedCommand.isError === true,
  JSON.stringify(failedCommand));
// The honest unknown must survive: a source that states no outcome must not be
// promoted to success by this change.
const silent = typed(commandResult(undefined), 'tool-result')[0];
check('a command result that states no outcome publishes no lifecycle',
  silent?.type === 'tool-result' && silent.semantic === undefined && silent.isError === false,
  JSON.stringify(silent));

// Silence is not consent. Filtering unreported entries out of the verdict made
// `[{success:true},{result:'boom'}]` render a completed command AND drop the
// unreported one from the command line, so the row claimed success for a chain
// it was not showing in full.
const partlySilent = commandBody([{ query: 'a', success: true }, { query: 'b', result: 'boom' }]);
check('a chain with an unreported command states no lifecycle',
  partlySilent?.semantic === undefined && partlySilent?.isError === false,
  JSON.stringify(partlySilent));
const nonBoolean = commandBody([{ query: 'a', success: true }, { query: 'b', success: 'false' }]);
check('a non-boolean success is unreported, not a success',
  nonBoolean?.semantic === undefined, JSON.stringify(nonBoolean));
const statedFailureWins = commandBody([{ query: 'a', success: true }, { query: 'b', success: false }]);
check('one stated failure fails the chain and names every command',
  statedFailureWins?.semantic?.kind === 'command'
    && statedFailureWins.semantic.state === 'failed'
    && statedFailureWins.semantic.command === 'a\nb'
    && statedFailureWins.isError === true,
  JSON.stringify(statedFailureWins));
// `is_error` outranks a per-entry success: the client reads the semantic BEFORE
// `isError` (tool_presentation.dart:536), so a completed semantic on a block
// Cline flagged as an error would paint success over its own error.
const flaggedError = commandBody([{ query: 'a', success: true }], true);
check('a block flagged is_error never renders a completed command',
  flaggedError?.semantic?.kind === 'command'
    && flaggedError.semantic.state === 'failed'
    && flaggedError.isError === true,
  JSON.stringify(flaggedError));
// `boundedString` REJECTS past its bound rather than clipping, which published
// an empty command for a large heredoc -- a failed row that cannot say what
// failed.
const huge = commandBody([{ query: 'x'.repeat(70_000), result: '', success: false }]);
check('a command too large to carry whole is clipped, never blanked',
  huge?.semantic?.kind === 'command'
    && huge.semantic.command.startsWith('xxxx')
    && huge.semantic.command.includes('truncated')
    && huge.semantic.command.length < 70_000,
  JSON.stringify({ len: huge?.semantic?.kind === 'command' ? huge.semantic.command.length : null }));
// Every sibling field in this file is capped; the joined command had no
// aggregate bound, so N entries published up to N x 64KB.
const manyEntries = commandBody(Array.from({ length: 100 }, (_, index) => ({ query: `${'y'.repeat(1_000)}${index}`, success: true })));
check('the joined command line is bounded in aggregate, not just per entry',
  manyEntries?.semantic?.kind === 'command'
    && manyEntries.semantic.command.length <= 64 * 1024 + 200,
  JSON.stringify({ len: manyEntries?.semantic?.kind === 'command' ? manyEntries.semantic.command.length : null }));

// Per-turn usage. Cline reports counts on the assistant message and the drive
// path emits no live `token-count`, so before this the turn published no
// attributable usage at all -- `usagePublished: false` on every raw-wire run,
// while the browser showed numbers because that claim only asks whether a token
// row reached the socket, not whether it belongs to the turn.
const turnMessages = [
  { id: 'u1', role: 'user', content: [{ type: 'text', text: 'first prompt' }] },
  { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'partial' }],
    metrics: { inputTokens: 10, outputTokens: 1 } },
  { id: 'tr', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', name: 'run_commands', content: [] }] },
  { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'done' }],
    metrics: { inputTokens: 3900, outputTokens: 321, cacheReadTokens: 12 } },
  { id: 'u2', role: 'user', content: [{ type: 'text', text: 'second prompt' }] },
  { id: 'a3', role: 'assistant', content: [{ type: 'text', text: 'next turn' }],
    metrics: { inputTokens: 99999, outputTokens: 7 } },
];
const firstTurn = clineTurnTokens(turnMessages, 'u1');
check('a turn reports the last counts of its own assistant messages',
  firstTurn?.input === 3900 && firstTurn.output === 321 && firstTurn.cacheRead === 12,
  JSON.stringify(firstTurn));
const secondTurn = clineTurnTokens(turnMessages, 'u2');
check('the next prompt closes the turn, so its counts do not leak backwards',
  secondTurn?.input === 99999 && secondTurn.output === 7,
  JSON.stringify(secondTurn));
check('a turn whose assistant reported nothing publishes no counts',
  clineTurnTokens(
    [{ id: 'u9', role: 'user', content: [{ type: 'text', text: 'p' }] },
     { id: 'a9', role: 'assistant', content: [{ type: 'text', text: 'a' }] }],
    'u9',
  ) === undefined);

const traces: string[] = [];
const unknown = mapClineMessage({
  id: 'unknown-1', role: 'user', content: [{ type: 'future_block', text: 'must not become human' }],
}, { sessionId: CLINE_FIXTURE_ID, trace: (event) => traces.push(event.op) });
check('unknown blocks map to neutral context and trace, never a human bubble',
  unknown.length === 1
    && unknown[0]?.type === 'event'
    && unknown[0].name === CONTEXT_INJECTION_EVENT
    && traces.includes('unknown-block'),
  JSON.stringify(unknown));

const interruptedSession = {
  id: CLINE_FIXTURE_ID, interrupted: true,
} as ClineStoredSession;
const interrupted = mapClineInterruptedTail(interruptedSession, messages.slice(0, 1));
check('an interrupted dead-pid tail maps a cancelled summary',
  interrupted?.type === 'run-summary' && interrupted.status === 'cancelled', JSON.stringify(interrupted));

const pendingMessages = [...messages, {
  id: 'pending-1', role: 'assistant', content: [{ type: 'tool_use', id: 'pending-call', name: 'execute', input: { command: 'true' } }],
}];
const pending = clinePendingToolUse(pendingMessages);
check('unmatched native tool use is shown as read-only pending state',
  pending?.requestId === 'pending-call' && pending.readOnly === true, JSON.stringify(pending));

const aggregate = clineSessionUsage({ inputTokens: 100, cacheReadTokens: 40, cacheWriteTokens: 10 });
check('session usage records that input already includes cache subsets',
  aggregate?.type === 'metadata-update'
    && (aggregate.value as { input?: number; inputIncludesCacheSubsets?: boolean }).input === 100
    && (aggregate.value as { inputIncludesCacheSubsets?: boolean }).inputIncludesCacheSubsets === true,
  JSON.stringify(aggregate));

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
