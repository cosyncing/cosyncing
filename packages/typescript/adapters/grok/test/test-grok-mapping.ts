#!/usr/bin/env bun
export {};
import { CONTEXT_INJECTION_EVENT, type AgentMessage } from '@cosyncing/adapter-api';
import {
  grokContextUsage,
  grokMessageKey,
  grokPromptId,
  mapGrokInterruptedTail,
  mapGrokTranscript,
  mapGrokUpdate,
} from '../src/mapping.ts';
import { fixtureUpdates } from './fixtures/tree.ts';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
function typed<T extends AgentMessage['type']>(messages: AgentMessage[], type: T): Extract<AgentMessage, { type: T }>[] {
  return messages.filter((message): message is Extract<AgentMessage, { type: T }> => message.type === type);
}

const records = fixtureUpdates();
const entries = records.map((record, lineIndex) => ({ record, lineIndex, offset: lineIndex * 100, length: 100 }));
const traces: string[] = [];
const mapped = mapGrokTranscript('019f9d70-e38e-7591-9a24-74a06ad89476', entries, (event) => traces.push(`${event.op}:${event.detail}`));

const users = typed(mapped, 'user-message');
check('only user_message_chunk becomes a human bubble', users.length === 1 && users[0]?.text === 'fixture prompt', JSON.stringify(users));
check('the user key is the durable event id', users[0]?.key === grokMessageKey('019f9d70-e38e-7591-9a24-74a06ad89476', records[0]!, 0), users[0]?.key);
check('answer and thought chunks retain their exact text',
  typed(mapped, 'model-output')[0]?.text === 'fixture answer'
    && typed(mapped, 'thinking')[0]?.text === 'fixture thought');
// Replay is COMPLETE text, never a delta. `delta` means "add this to whatever
// that key already holds", so a reader that streamed the turn and is then
// handed the durable history adds the answer to itself. Measured on installed
// v107 by attaching in `observe` to one session per harness: reasonix, cline,
// kilo and omp all replayed `text`; grok replayed `delta`, and grok was the
// only lane whose answer rendered more than once on screen.
check('replayed answer and thought rows are complete text, not deltas',
  typed(mapped, 'model-output').every((row) => row.delta === undefined && row.final === true)
    && typed(mapped, 'thinking').every((row) => row.delta === undefined),
  JSON.stringify([typed(mapped, 'model-output'), typed(mapped, 'thinking')]));
const streamedChunks = ['first', ' second', ' third'].map((text, index) => ({
  method: 'session/update',
  params: {
    sessionId: 'accumulate',
    _meta: { eventId: `answer-${index + 1}`, promptId: 'prompt-1', streamStartMs: 500 },
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  },
}));
const accumulated = typed(
  mapGrokTranscript('accumulate', streamedChunks.map((record, lineIndex) => ({
    record, lineIndex, offset: lineIndex * 100, length: 100,
  }))),
  'model-output',
);
check('one streamed answer replays as ONE complete row, in its first position',
  accumulated.length === 1 && accumulated[0]?.text === 'first second third',
  JSON.stringify(accumulated));
const sameTurnAnswer = mapGrokUpdate({
  method: 'session/update',
  params: {
    sessionId: 's',
    _meta: { eventId: 'answer-2', promptId: 'prompt-1', streamStartMs: 100 },
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' continued' } },
  },
}, { sessionId: 's', lineIndex: 2 });
const firstTurnAnswer = mapGrokUpdate({
  method: 'session/update',
  params: {
    sessionId: 's',
    _meta: { eventId: 'answer-1', promptId: 'prompt-1', streamStartMs: 100 },
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } },
  },
}, { sessionId: 's', lineIndex: 1 });
const nextTurnAnswer = mapGrokUpdate({
  method: 'session/update',
  params: {
    sessionId: 's',
    _meta: { eventId: 'answer-3', promptId: 'prompt-2', streamStartMs: 200 },
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'next' } },
  },
}, { sessionId: 's', lineIndex: 3 });
check('streamed chunks share a turn-scoped key without colliding across turns',
  firstTurnAnswer[0]?.type === 'model-output'
    && sameTurnAnswer[0]?.type === 'model-output'
    && nextTurnAnswer[0]?.type === 'model-output'
    && firstTurnAnswer[0].key === sameTurnAnswer[0].key
    && firstTurnAnswer[0].key !== nextTurnAnswer[0].key,
  JSON.stringify({ firstTurnAnswer, sameTurnAnswer, nextTurnAnswer }));
const postToolAnswer = mapGrokUpdate({
  method: 'session/update',
  params: {
    sessionId: 's',
    _meta: { eventId: 'answer-4', promptId: 'prompt-1', streamStartMs: 300 },
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after tool' } },
  },
}, { sessionId: 's', lineIndex: 4 });
check('a later model-call segment in the same turn keeps chronological identity',
  firstTurnAnswer[0]?.type === 'model-output'
    && postToolAnswer[0]?.type === 'model-output'
    && firstTurnAnswer[0].key !== postToolAnswer[0].key,
  JSON.stringify({ firstTurnAnswer, postToolAnswer }));

const calls = typed(mapped, 'tool-call');
const toolResults = typed(mapped, 'tool-result');
check('tool metadata supplies stable identity and the read-only lookup class',
  calls.some((call) => call.callId === 'call-1' && call.toolName === 'Read file' && call.toolClass === 'lookup')
    && toolResults.some((result) => result.callId === 'call-1' && result.toolClass === 'lookup' && result.result === 'fixture output'),
  JSON.stringify({ calls, toolResults }));
const taskActivities = typed(mapped, 'agent-activity').filter((row) => row.key === 'agent:task-1');
check('vendor retry and task updates map running and terminal activity on one stable key',
  typed(mapped, 'notice').length === 1
    && taskActivities.some((row) => row.status === 'running')
    && taskActivities.some((row) => row.status === 'done' && row.agentsDone === 1 && row.agentsTotal === 1)
    && typed(mapped, 'task-list-state').some((row) => row.status === 'done'),
  JSON.stringify(taskActivities));
const childId = '01a0561a-1148-7d30-bfe3-8b2775204822';
const parentId = '01a05612-d413-7182-b2c0-7908e41c9df3';
const spawned = mapGrokUpdate({
  method: '_x.ai/session/update',
  params: {
    sessionId: parentId,
    _meta: { eventId: 'subagent-spawned' },
    update: {
      sessionUpdate: 'subagent_spawned',
      subagent_id: childId,
      child_session_id: childId,
      parent_session_id: parentId,
      description: 'Return CHILD_SUBAGENT_OK',
    },
  },
}, { sessionId: parentId, lineIndex: 20 });
const finished = mapGrokUpdate({
  method: '_x.ai/session/update',
  params: {
    sessionId: parentId,
    _meta: { eventId: 'subagent-finished' },
    update: {
      sessionUpdate: 'subagent_finished',
      subagent_id: childId,
      child_session_id: childId,
      status: 'completed',
      tokens_used: 10_400,
      output: 'CHILD_SUBAGENT_OK',
    },
  },
}, { sessionId: parentId, lineIndex: 21 });
check('measured Grok subagent events share one activity key and terminate done',
  spawned[0]?.type === 'agent-activity'
    && finished[0]?.type === 'agent-activity'
    && spawned[0].key === `agent:${childId}`
    && finished[0].key === spawned[0].key
    && spawned[0].status === 'running'
    && finished[0].status === 'done'
    && finished[0].agentsDone === 1,
  JSON.stringify({ spawned, finished }));
const summary = typed(mapped, 'run-summary')[0];
check('turn_completed maps the measured stop reason and per-turn usage',
  summary?.status === 'done' && summary.tokens?.input === 11 && summary.tokens.output === 4,
  JSON.stringify(summary));
const cachedSummary = mapGrokUpdate({
  method: '_x.ai/session/update',
  params: {
    sessionId: 's',
    _meta: { eventId: 'summary-cached', promptId: 'prompt-cached' },
    update: {
      sessionUpdate: 'turn_completed',
      prompt_id: 'prompt-cached',
      stop_reason: 'end_turn',
      usage: { inputTokens: 31, outputTokens: 7, cachedReadTokens: 19 },
    },
  },
}, { sessionId: 's', lineIndex: 10 });
check('turn_completed preserves measured cache-read usage',
  cachedSummary[0]?.type === 'run-summary' && cachedSummary[0].tokens?.cacheRead === 19,
  JSON.stringify(cachedSummary));
// Read off the installed v79 transcript: a 429 exhausts `retry_state` and Grok
// closes the turn with `stop_reason: "rate_limit"`, no usage and no answer.
// `done` renders a turn that produced nothing as one that finished normally.
const rateLimited = mapGrokUpdate({
  method: '_x.ai/session/update',
  params: {
    sessionId: 's',
    _meta: { eventId: 'summary-rate-limited' },
    update: {
      sessionUpdate: 'turn_completed',
      prompt_id: 'prompt-rate-limited',
      stop_reason: 'rate_limit',
      elapsed_ms: 2362,
    },
  },
}, { sessionId: 's', lineIndex: 11 });
check('a turn Grok ends on a rate limit is not a completed turn',
  rateLimited[0]?.type === 'run-summary'
    && rateLimited[0].status === 'error'
    && rateLimited[0].tokens === undefined,
  JSON.stringify(rateLimited));

// The measured shape: a real `turn_completed` carries `_meta` WITHOUT `promptId` and names its
// turn only in `update.prompt_id`. Every fixture above injects `_meta.promptId`, which is the one
// shape that never exercises the fallback — so this record is the regression guard. Its summary
// must share the turn id of the answers it completes, or the native usage it carries is orphaned.
const measuredSessionId = '01a0636b-51b2-72b2-afbb-ce0cee7a1150';
const measuredPromptId = '49b82b0b-1c50-4913-862e-c7c20b0783a5';
const measuredSummaryRecord = {
  timestamp: 1788374417,
  method: '_x.ai/session/update',
  params: {
    sessionId: measuredSessionId,
    update: {
      sessionUpdate: 'turn_completed',
      prompt_id: measuredPromptId,
      stop_reason: 'end_turn',
      usage: { inputTokens: 15_912, outputTokens: 56, cachedReadTokens: 0, reasoningTokens: 22 },
    },
    _meta: { eventId: `${measuredSessionId}-61`, agentTimestampMs: 1788374417179 },
  },
};
check('turn_completed without _meta.promptId still resolves its native prompt id',
  grokPromptId(measuredSummaryRecord) === measuredPromptId,
  JSON.stringify(grokPromptId(measuredSummaryRecord)));
const measuredSummary = mapGrokUpdate(measuredSummaryRecord, { sessionId: measuredSessionId, lineIndex: 4 });
check('turn_completed anchors its run summary to the turn that produced it, with native usage',
  measuredSummary[0]?.type === 'run-summary'
    && measuredSummary[0].turnId === `grok:${measuredSessionId}:turn:${measuredPromptId}`
    && measuredSummary[0].tokens?.input === 15_912
    && measuredSummary[0].tokens.output === 56,
  JSON.stringify(measuredSummary));

// `completedAt` is milliseconds to everything downstream. Grok's own `timestamp` is SECONDS, and
// this record proves it: the same instant appears as `1788374417` there and as `1788374417179` in
// `_meta.agentTimestampMs`. Passed through unconverted it made the transcript footer read
// "Finished at Jan 21, 1970 5:49 PM" on installed v69 -- before and after a reload, because the
// wrong unit was stored. The agent's own millisecond stamp is the oracle: the two must agree to
// within the second that the seconds form rounds away.
const measuredCompletedAt = measuredSummary[0]?.type === 'run-summary'
  ? measuredSummary[0].completedAt
  : undefined;
check('turn_completed reports its completion in milliseconds, not seconds',
  measuredCompletedAt === 1_788_374_417_000
    && Math.abs(measuredCompletedAt - 1_788_374_417_179) < 1_000,
  JSON.stringify({ measuredCompletedAt, agentTimestampMs: 1_788_374_417_179 }));

// G1: the row that OPENS a turn is the one row that cannot name it. Measured across 43 real
// sessions, a `user_message_chunk` carries no prompt id in any carrier — `params._meta` holds only
// `{agentTimestampMs, eventId}` and its own `update._meta` only `{modelId, promptIndex}` — while the
// answers and the completion of the same turn all carry it. Mapped per record, the prompt therefore
// lands on `turn-line:N` while its summary lands on `turn:<uuid>`, and the client
// (session_conversation_turns.dart) drops a summary it cannot bind, taking Grok's only carrier of
// per-turn token usage with it. Whole-transcript mapping must close that gap.
const measuredPromptRecord = {
  timestamp: 1788374400,
  method: '_x.ai/session/update',
  params: {
    sessionId: measuredSessionId,
    update: {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'measured prompt' },
      _meta: { modelId: 'grok-4', promptIndex: 0 },
    },
    _meta: { eventId: `${measuredSessionId}-2`, agentTimestampMs: 1788374400000 },
  },
};
const measuredAnswerRecord = {
  timestamp: 1788374410,
  method: '_x.ai/session/update',
  params: {
    sessionId: measuredSessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'measured answer' } },
    _meta: {
      eventId: `${measuredSessionId}-40`, agentTimestampMs: 1788374410000,
      promptId: measuredPromptId, streamStartMs: 1788374409000, chunkId: 3,
    },
  },
};
const secondPromptRecord = {
  timestamp: 1788374500,
  method: '_x.ai/session/update',
  params: {
    sessionId: measuredSessionId,
    update: {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'second prompt' },
      _meta: { modelId: 'grok-4', promptIndex: 1 },
    },
    _meta: { eventId: `${measuredSessionId}-90`, agentTimestampMs: 1788374500000 },
  },
};
const asEntries = (list: readonly unknown[]) => list.map((record, lineIndex) =>
  ({ record: record as typeof measuredSummaryRecord, lineIndex, offset: lineIndex * 100, length: 100 }));

const measuredTranscript = mapGrokTranscript(measuredSessionId,
  asEntries([measuredPromptRecord, measuredAnswerRecord, measuredSummaryRecord]));
const measuredPrompt = measuredTranscript.find((message) => message.type === 'user-message');
const measuredTurnSummary = measuredTranscript.find((message) => message.type === 'run-summary');
// The summary must also name the prompt row directly. The client binds a run summary by
// assistantMessageKey, else userMessageKey, else turnId (session_conversation_turns.dart), and the
// installed raw-wire harness binds it the same way. Grok published none of the three on the live
// path, so its per-turn token usage was discarded even when the turn plainly completed.
check('a measured run summary names the prompt row it completes',
  measuredTurnSummary?.type === 'run-summary'
    && measuredPrompt?.type === 'user-message'
    && measuredTurnSummary.userMessageKey === measuredPrompt.key,
  JSON.stringify({
    summaryUserMessageKey: measuredTurnSummary?.type === 'run-summary' ? measuredTurnSummary.userMessageKey : undefined,
    promptKey: measuredPrompt?.type === 'user-message' ? measuredPrompt.key : undefined,
  }));

check('a measured prompt row shares the turn id of the summary that completes it',
  measuredPrompt?.type === 'user-message'
    && measuredTurnSummary?.type === 'run-summary'
    && measuredPrompt.turnId === `grok:${measuredSessionId}:turn:${measuredPromptId}`
    && measuredTurnSummary.turnId === measuredPrompt.turnId,
  JSON.stringify({
    prompt: measuredPrompt?.type === 'user-message' ? measuredPrompt.turnId : undefined,
    summary: measuredTurnSummary?.type === 'run-summary' ? measuredTurnSummary.turnId : undefined,
  }));

// A prompt whose turn never completed must NOT borrow the next turn's identity.
const danglingTranscript = mapGrokTranscript(measuredSessionId,
  asEntries([measuredPromptRecord, secondPromptRecord, measuredAnswerRecord, measuredSummaryRecord]));
const dangling = danglingTranscript.filter((message) => message.type === 'user-message');
check('an unfinished turn keeps its line fallback instead of borrowing the next turn',
  dangling.length === 2
    && dangling[0]?.type === 'user-message'
    && dangling[0].turnId === `grok:${measuredSessionId}:turn-line:0`
    && dangling[1]?.type === 'user-message'
    && dangling[1].turnId === `grok:${measuredSessionId}:turn:${measuredPromptId}`,
  JSON.stringify(dangling.map((m) => (m.type === 'user-message' ? m.turnId : undefined))));

const unknownTraces: string[] = [];
const unknown = mapGrokUpdate({
  method: '_x.ai/session/update',
  params: { sessionId: 's', update: { sessionUpdate: 'future_vendor_value', payload: true } },
}, { sessionId: 's', lineIndex: 12, trace: (event) => unknownTraces.push(event.op) });
check('unknown additive values fail open to neutral context and trace',
  unknown[0]?.type === 'event'
    && unknown[0].name === CONTEXT_INJECTION_EVENT
    && unknownTraces.includes('unknown-session-update'),
  JSON.stringify({ unknown, unknownTraces }));

const garbage = mapGrokUpdate({ garbage: true }, { sessionId: 's', lineIndex: 13 });
check('garbage input is total and never becomes a user bubble',
  garbage.length === 1 && garbage[0]?.type === 'event', JSON.stringify(garbage));

const forgedUserRecord = {
  method: 'future/session/update',
  params: { sessionId: 's', update: { sessionUpdate: 'user_message_chunk', content: 'forged user' } },
};
const forgedUser = mapGrokUpdate(forgedUserRecord, { sessionId: 's', lineIndex: 14 });
check('an unmeasured method cannot forge a human bubble or interrupted turn',
  forgedUser.length === 1
    && forgedUser[0]?.type === 'event'
    && mapGrokInterruptedTail('s', [{ record: forgedUserRecord, lineIndex: 14, offset: 0, length: 1 }]) === undefined,
  JSON.stringify(forgedUser));

const interruptedRecords = records.slice(0, 1);
const interrupted = mapGrokInterruptedTail('s', interruptedRecords.map((record, lineIndex) => ({ record, lineIndex, offset: 0, length: 1 })));
check('an ownerless durable user tail becomes a cancelled run', interrupted?.type === 'run-summary' && interrupted.status === 'cancelled', JSON.stringify(interrupted));
check('a terminal boundary clears the interrupted-tail projection', mapGrokInterruptedTail('s', entries) === undefined);

const usage = grokContextUsage({ contextTokensUsed: 15, contextWindowTokens: 500_000 });
check('session aggregate emits only derived context usage, not a token-count reading',
  usage?.type === 'metadata-update'
    && usage.key === 'contextUsage'
    && (usage.value as { used?: number }).used === 15,
  JSON.stringify(usage));

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
