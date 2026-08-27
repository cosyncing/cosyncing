/**
 * The mapping boundary: the `(source, type)` fold.
 *
 * Four properties are asserted here, because each is a way an adapter puts words
 * in someone's mouth or hides a change it should have shown:
 *
 *  1. The fold is TOTAL over the sixteen MEASURED pairs, and an unlisted pair
 *     becomes a NAMED neutral row carrying its own source and type — never a
 *     user bubble, never a throw. A silent auto-update can add a step type at
 *     any time (it happened twice during this work), so an unmapped step must be
 *     visible rather than mis-rendered.
 *  2. `USER_EXPLICIT/USER_INPUT` is the ONLY human bubble. Category is decided
 *     by provenance, not by role (reflection §10).
 *  3. The app never renders text the user did not type: agy writes five distinct
 *     wrapper blocks and a `/<mode>` prefix INSIDE the user's own row.
 *  4. Live and replay share one fold and one key function — the stream/file
 *     naming difference is a table, not a case fold.
 *
 * Every input is a sanitized capture whose SHAPE came from a real agy 1.1.17
 * store, or a hand-built row whose shape comes from that same measurement.
 *
 *   bun run packages/typescript/adapters/antigravity/test/test-agy-mapping.ts   (exit 0 = all pass)
 */
export {};
import { CONTEXT_INJECTION_EVENT } from '@cosyncing/adapter-api';
import {
  AGY_CANCELED_STATUS,
  AGY_STEP_INVENTORY,
  AGY_STREAM_STEP_NAMES,
  agyCommandState,
  agyInventoryRow,
  agySettlementOutcome,
  agySourceForStepType,
  agyStepCategory,
  agyStepKey,
  agyTaskListState,
  classifyAgySettlementSender,
  collectAgyTaskReferences,
  createAgyMapState,
  decodeAgyToolArgs,
  foldAgyTaskLedger,
  mapAgySettlement,
  mapAgyUnmappedSettlement,
  normalizeAgyTaskId,
  mapAgyStep,
  normalizeAgyStreamStepType,
  parseAgySettlement,
  parseAgyStep,
  splitAgyToolContent,
  stripAgyUserWrappers,
  type AgyStep,
  type AgyTrace,
} from '../src/index.ts';
import { FIXTURE } from './fixtures/tree.ts';

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const CONVERSATION = FIXTURE.conversationIds.withTranscript;
const STEPS = FIXTURE.transcript as unknown as AgyStep[];

function freshState(options: { liveChild?: boolean; trace?: (t: AgyTrace) => void } = {}) {
  return createAgyMapState(CONVERSATION, {
    liveChild: options.liveChild ?? false,
    ...(options.trace ? { trace: options.trace } : {}),
  });
}

function typesOf(messages: Array<{ type: string }>): string {
  return messages.map((message) => message.type).join(',');
}

/** Fold the whole fixture transcript once, in order. */
function foldAll(options: { liveChild?: boolean; trace?: (t: AgyTrace) => void } = {}) {
  const state = freshState(options);
  const out = STEPS.flatMap((step) => mapAgyStep(step, state));
  return { state, messages: out };
}

// ── 1. The inventory is complete and every pair folds ───────────────────────
{
  // The sixteen pairs measured over the corpus, twice (2,647 lines / 25 files on
  // 2026-08-21; 2,664 lines / 29 files on 2026-08-25) with the same result.
  const MEASURED_PAIRS: Array<[string, string, string]> = [
    ['USER_EXPLICIT', 'USER_INPUT', 'user-message'],
    ['MODEL', 'PLANNER_RESPONSE', 'assistant-turn'],
    ['MODEL', 'RUN_COMMAND', 'tool'],
    ['MODEL', 'VIEW_FILE', 'tool'],
    ['MODEL', 'GREP_SEARCH', 'tool'],
    ['MODEL', 'CODE_ACTION', 'tool'],
    ['MODEL', 'LIST_DIRECTORY', 'tool'],
    ['MODEL', 'GENERIC', 'tool'],
    ['MODEL', 'SEARCH_WEB', 'tool'],
    ['MODEL', 'READ_URL_CONTENT', 'tool'],
    ['MODEL', 'ASK_QUESTION', 'question'],
    ['SYSTEM', 'CONVERSATION_HISTORY', 'history-reset'],
    ['SYSTEM', 'CHECKPOINT', 'context-injection'],
    ['SYSTEM', 'SYSTEM_MESSAGE', 'context-injection'],
    ['SYSTEM', 'DIRECTORY_RULES', 'context-injection'],
    ['SYSTEM', 'ERROR_MESSAGE', 'error'],
  ];

  check('the inventory table holds exactly the sixteen measured pairs',
    AGY_STEP_INVENTORY.length === 16, String(AGY_STEP_INVENTORY.length));

  const wrong = MEASURED_PAIRS.filter(([source, type, category]) => agyStepCategory(source, type) !== category);
  check('every measured pair lands in its stated category', wrong.length === 0,
    wrong.map(([s, t, c]) => `${s}/${t} wanted ${c} got ${agyStepCategory(s, t)}`).join('; '));

  const missing = MEASURED_PAIRS.filter(([source, type]) => !agyInventoryRow(source, type));
  check('every measured pair is present in the table', missing.length === 0, missing.map((p) => p.join('/')).join('; '));

  // The fixture transcript must actually exercise all sixteen, or the fold below
  // would be passing over a subset.
  const covered = new Set(STEPS.map((step) => `${step.source}/${step.type}`));
  const uncovered = MEASURED_PAIRS.filter(([s, t]) => !covered.has(`${s}/${t}`));
  check('the fixture transcript exercises all sixteen pairs', uncovered.length === 0,
    uncovered.map((p) => p.join('/')).join('; '));

  const { messages } = foldAll();
  check('the whole fixture transcript folds without throwing', messages.length > 0, `${messages.length} messages`);
}

// ── 2. An unknown pair is a NAMED neutral row ───────────────────────────────
{
  const traces: AgyTrace[] = [];
  const state = freshState({ trace: (t) => traces.push(t) });
  const unknown = FIXTURE.unknownPairStep as unknown as AgyStep;
  const mapped = mapAgyStep(unknown, state);

  check('an unlisted pair is categorised as unmapped-step, not as a fallback',
    agyStepCategory(unknown.source, unknown.type) === 'unmapped-step');
  check('it produces exactly one neutral event row', mapped.length === 1 && mapped[0]!.type === 'event', typesOf(mapped));
  check('it is NOT a user message', !mapped.some((message) => message.type === 'user-message'), typesOf(mapped));

  const event = mapped[0] as { type: 'event'; name: string; payload: { source: string; body: string } };
  check('the neutral row carries its OWN source and type in the label',
    event.name === CONTEXT_INJECTION_EVENT
      && event.payload.source.includes('MODEL')
      && event.payload.source.includes('FUTURE_STEP_TYPE_ADDED_BY_AN_AUTO_UPDATE'),
    event.payload.source);
  check('the unmapped pair left a structured trace',
    traces.some((trace) => trace.op === 'unmapped-step' && trace.detail.includes('FUTURE_STEP_TYPE')),
    traces.map((trace) => trace.op).join(', '));

  // Garbage, not just an unknown type: the fold must still not throw.
  let threw = false;
  let garbageOut: ReturnType<typeof mapAgyStep> = [];
  try {
    garbageOut = mapAgyStep({ step_index: 5, source: '', type: '', status: '', created_at: '' }, freshState());
  } catch {
    threw = true;
  }
  check('a wholly empty step folds to a neutral row rather than throwing',
    !threw && !garbageOut.some((message) => message.type === 'user-message'), typesOf(garbageOut));
}

// ── 3. Only USER_EXPLICIT/USER_INPUT is a human bubble ──────────────────────
{
  const { messages } = foldAll();
  const userRows = messages.filter((message) => message.type === 'user-message');
  check('exactly one user bubble in the whole transcript', userRows.length === 1, `${userRows.length}`);

  // Every SYSTEM row lands somewhere that is not a user bubble.
  for (const type of ['SYSTEM_MESSAGE', 'DIRECTORY_RULES', 'CHECKPOINT', 'CONVERSATION_HISTORY', 'ERROR_MESSAGE']) {
    const step = STEPS.find((candidate) => candidate.type === type)!;
    const mapped = mapAgyStep(step, freshState());
    check(`SYSTEM/${type} is never a user-message`,
      !mapped.some((message) => message.type === 'user-message'), typesOf(mapped));
  }

  // Keying on `type` alone would be the bug: a SYSTEM row that happened to carry
  // USER_INPUT must not become a user bubble.
  const spoofed = mapAgyStep(
    { step_index: 7, source: 'SYSTEM', type: 'USER_INPUT', status: 'DONE', created_at: '2026-08-20T10:00:00Z', content: 'not typed by a human' },
    freshState(),
  );
  check('a SYSTEM row carrying USER_INPUT is NOT a user bubble (the pair is the key, not the type)',
    !spoofed.some((message) => message.type === 'user-message'), typesOf(spoofed));
}

// ── 4. Wrapper stripping — the app never renders text the user did not type ──
{
  const userStep = STEPS.find((step) => step.type === 'USER_INPUT')!;
  const mapped = mapAgyStep(userStep, freshState());
  const bubble = mapped.find((message) => message.type === 'user-message') as { type: 'user-message'; text: string; key?: string };

  check('the user bubble is the typed text alone',
    bubble.text === 'review the demo project and report', JSON.stringify(bubble.text));
  check('no wrapper syntax survives into the bubble',
    !/<USER_REQUEST>|<ADDITIONAL_METADATA>|<USER_SETTINGS_CHANGE>|USER_SETTINGS_CHANGE/.test(bubble.text), bubble.text);
  check('the local-time metadata the harness appended is gone',
    !/current local time/i.test(bubble.text), bubble.text);
  check('the settings-change narration is gone', !/changed setting/i.test(bubble.text), bubble.text);
  check('the leading /<mode> token is stripped', !bubble.text.startsWith('/plan'), bubble.text);

  const stripped = stripAgyUserWrappers(userStep.content!);
  check('the stripped mode is reported rather than discarded', stripped.mode === 'plan', String(stripped.mode));
  check('the removed wrappers are reported by name',
    stripped.removed.some((block) => block.tag === 'ADDITIONAL_METADATA')
      && stripped.removed.some((block) => block.tag === 'USER_SETTINGS_CHANGE'),
    stripped.removed.map((block) => block.tag).join(', '));
  check('the removed wrappers carry their material, not just their names',
    stripped.removed.every((block) => block.body.length > 0),
    JSON.stringify(stripped.removed));
  const metadataEvent = mapped.find((message) => message.type === 'event' && message.name === CONTEXT_INJECTION_EVENT) as
    | { type: 'event'; name: string; payload: { source: string; body: string } }
    | undefined;
  check('what was stripped is surfaced as context, not deleted',
    metadataEvent !== undefined, typesOf(mapped));
  // An empty body is undecodable on the client — `contextInjection` refuses it
  // and the row degrades to a raw "Event context.injection" chip, which is the
  // exact defect the 2026-08-27 physical pass photographed.
  check('the surfaced context carries the removed material itself',
    metadataEvent!.payload.body.includes('current local time')
      && metadataEvent!.payload.body.includes('changed setting'),
    metadataEvent!.payload.body.slice(0, 160));
  check('the surfaced context labels each block by its tag',
    metadataEvent!.payload.body.includes('### ADDITIONAL_METADATA')
      && metadataEvent!.payload.body.includes('### USER_SETTINGS_CHANGE'),
    metadataEvent!.payload.body.slice(0, 160));

  // The other two measured wrapper tags.
  const withPlan = stripAgyUserWrappers('<USER_REQUEST>\ndo it\n</USER_REQUEST>\n<PLAN>\nstep one\n</PLAN>');
  check('a <PLAN> block is removed from the user row',
    withPlan.text === 'do it' && withPlan.removed.some((block) => block.tag === 'PLAN' && block.body === 'step one'), JSON.stringify(withPlan));
  const withSkill = stripAgyUserWrappers('<USER_REQUEST>\nrun it\n</USER_REQUEST>\n<SKILL>\nskill body\n</SKILL>');
  check('a <SKILL> body is removed from the user row',
    withSkill.text === 'run it' && withSkill.removed.some((block) => block.tag === 'SKILL' && block.body === 'skill body'), JSON.stringify(withSkill));

  // A REAL slash command the user typed must survive — only the three modes
  // `--mode` accepts are treated as a prefix.
  const slash = stripAgyUserWrappers('<USER_REQUEST>\n/help me out\n</USER_REQUEST>');
  check('a genuine slash command the user typed is NOT mistaken for a mode prefix',
    slash.text === '/help me out' && slash.mode === undefined, JSON.stringify(slash));

  const bare = stripAgyUserWrappers('an older bare prompt with no wrappers');
  check('a bare unwrapped row keeps its text rather than rendering empty',
    bare.text === 'an older bare prompt with no wrappers', JSON.stringify(bare));

  const accept = stripAgyUserWrappers('<USER_REQUEST>\n/accept-edits go ahead\n</USER_REQUEST>');
  check('the accept-edits mode prefix is stripped too',
    accept.text === 'go ahead' && accept.mode === 'accept-edits', JSON.stringify(accept));
}

// ── 5. Tool rows: semantics, exit codes, correlation ────────────────────────
{
  const { messages } = foldAll();
  const calls = messages.filter((message) => message.type === 'tool-call');
  const resultRows = messages.filter((message) => message.type === 'tool-result');
  check('every tool call in the fixture produced a call row', calls.length >= 10, `${calls.length} calls`);

  // A result must reuse its CALL's id, not mint a second one.
  const orphanResults = resultRows.filter(
    (result) => !calls.some((call) => call.type === 'tool-call' && call.callId === (result as { callId: string }).callId),
  );
  check('every tool-result shares a callId with a tool-call', orphanResults.length === 0,
    `${orphanResults.length} orphans`);

  const command = resultRows.find((row) => (row as { toolName: string }).toolName === 'run_command') as {
    type: 'tool-result'; exitCode?: number; semantic?: { kind: string; command?: string }; toolClass?: string; durationMs?: number;
  };
  check('a RUN_COMMAND result carries its exit code', command.exitCode === 0, String(command.exitCode));
  check('a RUN_COMMAND result carries a command semantic with the real command line',
    command.semantic?.kind === 'command' && command.semantic.command === 'ls -la', JSON.stringify(command.semantic));
  check('a RUN_COMMAND result is classed execute', command.toolClass === 'execute', String(command.toolClass));
  check('the Created At/Completed At preamble becomes a duration, not body text',
    command.durationMs === 2000, String(command.durationMs));

  const view = resultRows.find((row) => (row as { toolName: string }).toolName === 'view_file') as {
    type: 'tool-result'; semantic?: { kind: string; path?: string }; path?: string; truncated?: boolean;
  };
  check('a VIEW_FILE result carries a file-read semantic with an UNQUOTED path',
    view.semantic?.kind === 'file-read' && view.semantic.path === '/fixture/demo-project/README.md',
    JSON.stringify(view.semantic));
  check('the acted-on path is on the result row too', view.path === '/fixture/demo-project/README.md', String(view.path));

  const grep = resultRows.find((row) => (row as { toolName: string }).toolName === 'grep_search') as {
    type: 'tool-result'; semantic?: { kind: string; query?: string; scope?: string };
  };
  check('a GREP_SEARCH result carries a search semantic with query and scope',
    grep.semantic?.kind === 'search' && grep.semantic.query === 'TODO' && grep.semantic.scope === '/fixture/demo-project',
    JSON.stringify(grep.semantic));

  const web = resultRows.find((row) => (row as { toolName: string }).toolName === 'search_web') as {
    type: 'tool-result'; semantic?: { kind: string; query?: string };
  };
  check('a SEARCH_WEB result carries a web semantic',
    web.semantic?.kind === 'web' && web.semantic.query === 'typescript project layout conventions',
    JSON.stringify(web.semantic));

  const codeAction = resultRows.find((row) => (row as { toolName: string }).toolName === 'write_to_file') as {
    type: 'tool-result'; toolClass?: string; path?: string;
  };
  check('a CODE_ACTION result is classed edit and names its target file',
    codeAction.toolClass === 'edit' && codeAction.path === '/fixture/demo-project/NOTES.md',
    `${codeAction.toolClass} ${codeAction.path}`);

  const title = calls.find((call) => (call as { toolName: string }).toolName === 'run_command') as { title?: string };
  check("the card title is the HOST's own toolSummary, never invented here",
    title.title === 'List project root', String(title.title));
}

// ── 6. args decoding — the JSON-encoded-value trap ──────────────────────────
{
  // MEASURED over all 1,230 corpus tool calls: `args` is an object whose every
  // VALUE is a JSON-encoded string. A naive read yields a path WITH quotes.
  const raw = { AbsolutePath: '"/fixture/x.md"', StartLine: '12', IsSkillFile: 'false', toolSummary: '"Read x"' };
  const decoded = decodeAgyToolArgs(raw);
  check('a string-valued arg decodes out of its JSON quoting',
    decoded.AbsolutePath === '/fixture/x.md', JSON.stringify(decoded.AbsolutePath));
  check('a numeric arg decodes to a number', decoded.StartLine === 12, JSON.stringify(decoded.StartLine));
  check('a boolean arg decodes to a boolean', decoded.IsSkillFile === false, JSON.stringify(decoded.IsSkillFile));
  check('a value that is not valid JSON falls back to the raw string',
    decodeAgyToolArgs({ Weird: 'not json at all' }).Weird === 'not json at all');
  check('a non-object args decodes to an empty record',
    Object.keys(decodeAgyToolArgs(null)).length === 0 && Object.keys(decodeAgyToolArgs('x')).length === 0);
}

// ── 7. Uncorrelated tool results are self-contained, never mis-joined ───────
{
  const traces: AgyTrace[] = [];
  const state = freshState({ trace: (t) => traces.push(t) });
  // A result row with NO preceding call — 12 of 1,217 real result rows are like
  // this, and a positional join would attach them to an unrelated call.
  const orphan = mapAgyStep(
    { step_index: 3, source: 'MODEL', type: 'RUN_COMMAND', status: 'DONE', exit_code: 2, created_at: '2026-08-20T10:00:00Z', content: 'Created At: 2026-08-20T11:00:00+01:00\nCompleted At: 2026-08-20T11:00:00+01:00\nboom' },
    state,
  );
  check('an uncorrelated result emits a SELF-CONTAINED call+result pair',
    typesOf(orphan) === 'tool-call,tool-result', typesOf(orphan));
  check('both halves share one callId',
    (orphan[0] as { callId: string }).callId === (orphan[1] as { callId: string }).callId);
  check('it keeps its real exit code', (orphan[1] as { exitCode?: number }).exitCode === 2);
  check('the uncorrelated result left a structured trace',
    traces.some((trace) => trace.op === 'tool-result-uncorrelated'), traces.map((t) => t.op).join(', '));

  // A call whose result never arrives still renders as a call.
  const state2 = freshState();
  const unanswered = mapAgyStep(
    { step_index: 9, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-08-20T10:00:00Z', tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 1"' } }] },
    state2,
  );
  check('a tool call with no result still renders (a cut-off turn is not hidden)',
    unanswered.some((message) => message.type === 'tool-call'), typesOf(unanswered));
}

// ── 8. CONVERSATION_HISTORY, notices, errors ────────────────────────────────
{
  const historyStep = STEPS.find((step) => step.type === 'CONVERSATION_HISTORY')!;
  const mapped = mapAgyStep(historyStep, freshState());
  check('CONVERSATION_HISTORY is a history reset', mapped.length === 1 && mapped[0]!.type === 'history-reset', typesOf(mapped));
  check('the reset is labelled a compaction',
    (mapped[0] as { semantic?: { kind: string } }).semantic?.kind === 'compaction');
  check('a CONVERSATION_HISTORY row carrying no content at all still folds', historyStep.content === undefined);

  // The physical pass (2026-08-27) found the checkpoint rendered as a raw
  // notice quoting `{{ CHECKPOINT 0 }}` at the reader. The machine-written
  // truncation summary is context the agent was handed — the same material
  // class as kimi's `compaction_summary` — so it folds to the one collapsible
  // context presentation, carrying the WHOLE summary rather than a three-line
  // head.
  const checkpoint = mapAgyStep(STEPS.find((step) => step.type === 'CHECKPOINT')!, freshState());
  check('CHECKPOINT is a context-injection event, not a raw notice',
    checkpoint.length === 1 && checkpoint[0]!.type === 'event'
      && (checkpoint[0] as { name: string }).name === CONTEXT_INJECTION_EVENT,
    typesOf(checkpoint));
  const checkpointPayload = (checkpoint[0] as { payload: { source: string; body: string } }).payload;
  check('the checkpoint names its own origin',
    checkpointPayload.source === 'agy checkpoint summary', checkpointPayload.source);
  check('the checkpoint body carries the whole summary, past the old three-line head',
    checkpointPayload.body.includes('# USER Objective'), checkpointPayload.body.slice(0, 120));
  check('a checkpoint body is never empty (an empty body is undecodable on the client)',
    checkpointPayload.body.length > 0);

  const errorStep = STEPS.find((step) => step.type === 'ERROR_MESSAGE')!;
  const errorOut = mapAgyStep(errorStep, freshState());
  check('ERROR_MESSAGE is an error carrying the `error` field', errorOut[0]!.type === 'error'
    && (errorOut[0] as { message: string }).message.includes('problem parsing the tool call'),
    JSON.stringify(errorOut[0]));

  const injection = mapAgyStep(STEPS.find((step) => step.type === 'SYSTEM_MESSAGE')!, freshState());
  check('SYSTEM_MESSAGE is a context-injection event',
    injection[0]!.type === 'event' && (injection[0] as { name: string }).name === CONTEXT_INJECTION_EVENT,
    typesOf(injection));
  const rules = mapAgyStep(STEPS.find((step) => step.type === 'DIRECTORY_RULES')!, freshState());
  check('DIRECTORY_RULES is a context-injection event naming its own origin',
    rules[0]!.type === 'event'
      && (rules[0] as { payload: { source: string } }).payload.source.includes('directory rules'),
    JSON.stringify((rules[0] as { payload: { source: string } }).payload.source));
}

// ── 9. A RUNNING row with no live child is interrupted ──────────────────────
{
  const running = STEPS.find((step) => step.status === 'RUNNING')!;
  const replayed = mapAgyStep(running, freshState({ liveChild: false }));
  check('the fixture really contains a RUNNING row', !!running, String(running?.step_index));
  check('a RUNNING planner row still renders its text', replayed.some((message) => message.type === 'model-output'), typesOf(replayed));

  // The tool row it opened, replayed with no live child, must not read as running.
  const state = freshState({ liveChild: false });
  mapAgyStep(running, state);
  const result = mapAgyStep(
    { step_index: 30, source: 'MODEL', type: 'RUN_COMMAND', status: 'RUNNING', created_at: '2026-08-20T10:16:00Z', content: 'Created At: 2026-08-20T11:16:00+01:00\npartial' },
    state,
  ).find((message) => message.type === 'tool-result') as { isError?: boolean };
  check('a RUNNING tool row replayed with NO live child reads as failed/interrupted, not running',
    result.isError === true, JSON.stringify(result));

  const liveState = freshState({ liveChild: true });
  mapAgyStep(running, liveState);
  const liveResult = mapAgyStep(
    { step_index: 30, source: 'MODEL', type: 'RUN_COMMAND', status: 'RUNNING', created_at: '2026-08-20T10:16:00Z', content: 'Created At: 2026-08-20T11:16:00+01:00\npartial' },
    liveState,
  ).find((message) => message.type === 'tool-result') as { isError?: boolean };
  check('the same row WITH a live child is not marked failed', liveResult.isError === undefined, JSON.stringify(liveResult));
}

// ── 9b. A CANCELED row is terminal, and is not a failure ────────────────────
//
// The fourth status. The file corpus carries only DONE/RUNNING/ERROR, so this
// value only ever arrives from the drive stream — but it lands in the SAME fold,
// and the fold has to give it a terminal reading. Two things it must not do:
// leave it running (a spinner nothing will stop), or paint it as an error (the
// host did what it was told).
{
  check('the canceled status is terminal whether or not a child is alive',
    agyCommandState(AGY_CANCELED_STATUS, true) === 'interrupted'
    && agyCommandState(AGY_CANCELED_STATUS, false) === 'interrupted',
    `${agyCommandState(AGY_CANCELED_STATUS, true)}/${agyCommandState(AGY_CANCELED_STATUS, false)}`);
  check('a live RUNNING row is still the one that reads as running',
    agyCommandState('RUNNING', true) === 'running' && agyCommandState('RUNNING', false) === 'interrupted');
  check('the other three statuses are unchanged',
    agyCommandState('DONE', false) === 'completed'
    && agyCommandState('ERROR', false) === 'failed'
    && agyCommandState('SOMETHING_ELSE', false) === 'unknown');

  // The row that would otherwise be the trap: a canceled tool row replayed with
  // NO live child. As RUNNING it would be painted red; a cancel is not a failure.
  const canceled = mapAgyStep(
    {
      step_index: 31,
      source: 'MODEL',
      type: 'RUN_COMMAND',
      status: AGY_CANCELED_STATUS,
      created_at: '2026-08-20T10:16:00Z',
      content: 'Created At: 2026-08-20T11:16:00+01:00\nstopped part-way',
    },
    freshState({ liveChild: false }),
  ).find((message) => message.type === 'tool-result') as { isError?: boolean };
  check('a CANCELED tool row is not marked as an error', canceled.isError === undefined, JSON.stringify(canceled));
}

// ── 10. Background-task settlement ──────────────────────────────────────────
{
  const settlement = parseAgySettlement(JSON.stringify(FIXTURE.settlement))!;
  check('a settlement message parses', !!settlement, JSON.stringify(settlement).slice(0, 80));
  check('it is keyed by its sender (<conversationId>/task-<N>)',
    settlement.sender === `${CONVERSATION}/task-7`, settlement.sender);
  check('it joins to its spawning step through sourceMetadata.tool.stepIndex',
    settlement.stepIndex === 14, String(settlement.stepIndex));

  const mapped = mapAgySettlement(settlement, CONVERSATION);
  check('a settlement is a SELF-CONTAINED tool block, not a user message',
    typesOf(mapped) === 'tool-call,tool-result', typesOf(mapped));
  check('the block is keyed by the sender',
    (mapped[0] as { callId: string }).callId.includes(`${CONVERSATION}/task-7`),
    (mapped[0] as { callId: string }).callId);
  check('its title is renderDetails.messageTitle',
    (mapped[0] as { title?: string }).title === 'Demo background task finished',
    String((mapped[0] as { title?: string }).title));
  check('the spawning step is recorded as the SAME key the transcript step gets',
    JSON.stringify((mapped[0] as { args?: Record<string, unknown> }).args).includes(agyStepKey(CONVERSATION, 14)),
    JSON.stringify((mapped[0] as { args?: Record<string, unknown> }).args));
  check('the settlement body survives into the result',
    String((mapped[1] as { result?: unknown }).result).includes('finished with result'),
    String((mapped[1] as { result?: unknown }).result).slice(0, 60));
  // A settlement with NO sender still parses — refused, it would silently
  // disappear from history, and the file still holds words the host wrote. It
  // classifies `unknown`, which the observe path renders as a stated notice,
  // never a tool block (round-2b review finding 4).
  const senderless = parseAgySettlement(JSON.stringify(FIXTURE.round2b.senderlessSettlement));
  check('a settlement with no sender parses with an empty sender instead of vanishing',
    senderless !== undefined && senderless.sender === ''
      && classifyAgySettlementSender(senderless.sender).category === 'unknown',
    JSON.stringify(senderless).slice(0, 100));
  const senderlessNotice = mapAgyUnmappedSettlement(senderless!);
  check('...and renders as a notice carrying the host\'s own words',
    senderlessNotice.type === 'notice'
      && senderlessNotice.message.includes('no sender')
      && senderlessNotice.message.includes('A notice with no sender'),
    JSON.stringify(senderlessNotice));
  const systemNotice = mapAgyUnmappedSettlement(
    parseAgySettlement(JSON.stringify(FIXTURE.round2b.systemSettlement))!,
  );
  check('a `system` settlement is a notice, never an invented background-task tool call',
    systemNotice.type === 'notice'
      && systemNotice.message.includes('All your subagents have been stopped'),
    JSON.stringify(systemNotice));
  check('...that does not stutter the title when the content repeats it',
    systemNotice.message === 'Antigravity system notice: All your subagents have been stopped.',
    systemNotice.message);
  // Only sender === 'system' EXACTLY earns the system label. `unknown` also
  // covers nonempty senders the taxonomy has never seen, and future drift must
  // be named as drift, not presented with provenance the file does not carry.
  const drifted = mapAgyUnmappedSettlement(
    parseAgySettlement(JSON.stringify({ ...FIXTURE.round2b.systemSettlement, sender: 'some-agent-name' }))!,
  );
  check('an unrecognized nonempty sender is NAMED, never presented as a system notice',
    drifted.type === 'notice'
      && drifted.message.includes('unrecognized sender ("some-agent-name")')
      && !drifted.message.includes('system notice'),
    drifted.message);
  check('a settlement document that is not a JSON object is still refused',
    parseAgySettlement('[1,2]') === undefined && parseAgySettlement('"x"') === undefined
      && parseAgySettlement('null') === undefined);
}

// ── 11. One fold, one key function: live and replay agree ───────────────────
{
  check('agyStepKey is deterministic and clock-free',
    agyStepKey(CONVERSATION, 4) === agyStepKey(CONVERSATION, 4)
      && agyStepKey(CONVERSATION, 4) !== agyStepKey(CONVERSATION, 5));

  // The stream/file naming difference is a TABLE, not a case fold.
  check('agent_response normalizes to PLANNER_RESPONSE (NOT a case fold)',
    normalizeAgyStreamStepType('agent_response') === 'PLANNER_RESPONSE');
  check('user_input and checkpoint normalize by case', normalizeAgyStreamStepType('user_input') === 'USER_INPUT'
    && normalizeAgyStreamStepType('checkpoint') === 'CHECKPOINT');
  check('an unlisted stream name passes through uppercased, into the same unmapped category',
    normalizeAgyStreamStepType('brand_new_step') === 'BRAND_NEW_STEP'
      && agyStepCategory(agySourceForStepType('BRAND_NEW_STEP'), 'BRAND_NEW_STEP') === 'unmapped-step');

  // Every name in the table must resolve to a pair the inventory knows.
  const unknownTargets = Object.values(AGY_STREAM_STEP_NAMES).filter(
    (type) => !AGY_STEP_INVENTORY.some((row) => row.type === type),
  );
  check('every stream name maps onto a type the inventory declares', unknownTargets.length === 0,
    unknownTargets.join(', '));

  // The real proof: a stream step_update, normalized, folds to the SAME keys the
  // transcript line for that step produces.
  const update = FIXTURE.streamEvents.stepUpdates[0] as { step_index: number; step_type: string };
  const streamType = normalizeAgyStreamStepType(update.step_type);
  const fileStep = STEPS.find((step) => step.step_index === update.step_index)!;
  check('the stream and the file name the same step_index the same way after normalization',
    streamType === fileStep.type, `${streamType} vs ${fileStep.type}`);

  const fromFile = mapAgyStep(fileStep, freshState());
  const fromStream = mapAgyStep(
    { ...fileStep, source: agySourceForStepType(streamType), type: streamType },
    freshState(),
  );
  const keysOf = (messages: Array<Record<string, unknown>>) =>
    messages.map((message) => String(message.key ?? message.callId ?? message.type)).join('|');
  check('replay and a normalized live event produce identical keys in identical order',
    keysOf(fromFile as unknown as Array<Record<string, unknown>>) === keysOf(fromStream as unknown as Array<Record<string, unknown>>),
    `${keysOf(fromFile as unknown as Array<Record<string, unknown>>)} vs ${keysOf(fromStream as unknown as Array<Record<string, unknown>>)}`);
}

// ── 12. Parsing and content splitting ───────────────────────────────────────
{
  check('a transcript line parses', parseAgyStep(JSON.stringify(STEPS[0]))?.step_index === 0);
  check('a blank line parses to undefined', parseAgyStep('   ') === undefined);
  check('malformed JSON parses to undefined', parseAgyStep('{not json') === undefined);
  check('a line with no step_index is refused', parseAgyStep('{"source":"MODEL"}') === undefined);
  check('a JSON array line is refused', parseAgyStep('[1,2,3]') === undefined);

  const split = splitAgyToolContent('Created At: 2026-08-20T11:10:03+01:00\nCompleted At: 2026-08-20T11:10:05+01:00\nthe real body');
  check('the preamble is split off the body', split.body === 'the real body', JSON.stringify(split.body));
  check('the preamble yields a duration', split.completedAt! - split.createdAt! === 2000, String(split.completedAt! - split.createdAt!));
  check('content with no preamble is returned whole',
    splitAgyToolContent('just a body').body === 'just a body');
  check('undefined content splits to an empty body', splitAgyToolContent(undefined).body === '');
}

// ── The settlement-sender taxonomy (P2c) ───────────────────────────────────
//
// MEASURED over all 36 settlements on the probe host, 2026-08-25: 29 senders are
// `<uuid>/task-<N>` (a background task), 2 are a bare `<uuid>` (a subagent
// reporting home), 3 are `system`, and 1 has no sender at all. The trap this
// closes is that "not a task" is NOT "a subagent": four of the six non-task
// senders are neither, and treating them as children would invent sessions.
{
  const live = FIXTURE.conversationIds.withTranscript;
  const child = FIXTURE.conversationIds.subagentChild;

  const task = classifyAgySettlementSender(`${live}/task-7`);
  check('a `<uuid>/task-N` sender classifies as a TASK, keeping both halves',
    task.category === 'task' && task.category === 'task' && task.taskId === 'task-7' && task.conversationId === live,
    JSON.stringify(task));
  const subagent = classifyAgySettlementSender(child);
  check('a bare conversation id classifies as a SUBAGENT',
    subagent.category === 'subagent' && subagent.category === 'subagent' && subagent.conversationId === child,
    JSON.stringify(subagent));
  check('`system` is a host notice, not a subagent',
    classifyAgySettlementSender('system').category === 'system');
  check('no sender at all is unknown, not a subagent',
    classifyAgySettlementSender(undefined).category === 'unknown'
      && classifyAgySettlementSender('   ').category === 'unknown');
  check('a sender that is neither shape is unknown rather than force-fitted',
    classifyAgySettlementSender('some-agent-name').category === 'unknown');
  check('a task id whose conversation half is not a uuid is NOT a task',
    classifyAgySettlementSender('not-a-uuid/task-7').category === 'unknown');

  // The outcome is read from the title the host wrote, because there is no
  // structured status field anywhere in a settlement.
  check('a "was canceled" title reads as cancelled',
    agySettlementOutcome('Demo background task was canceled') === 'cancelled');
  check('a "finished" title reads as done',
    agySettlementOutcome('Demo background task finished') === 'done');
  check('an unrecognized ending is `done`, not a guessed failure — the settlement proves it ENDED',
    agySettlementOutcome('Timer has expired') === 'done');
}

// ── The background-task ledger (P2c) ───────────────────────────────────────
{
  const live = FIXTURE.conversationIds.withTranscript;

  check('a `<uuid>/task-9` id normalizes to the bare form the log file is named for',
    normalizeAgyTaskId(`${live}/task-9`) === 'task-9' && normalizeAgyTaskId('task-9') === 'task-9');
  check('a value that names no task normalizes to nothing',
    normalizeAgyTaskId('task') === undefined && normalizeAgyTaskId(7) === undefined);

  const statusStep = parseAgyStep(JSON.stringify(FIXTURE.transcript.find((row) => row.step_index === 13)), 0)!;
  const references = collectAgyTaskReferences(statusStep);
  check('a `manage_task` call is picked out of the step with its JSON-encoded args decoded',
    references.length === 1 && references[0]!.taskId === 'task-7' && references[0]!.action === 'status',
    JSON.stringify(references));
  check('the host\'s own one-line summary rides the reference',
    references[0]!.summary === 'Check task status', String(references[0]!.summary));

  const killStep = parseAgyStep(JSON.stringify(FIXTURE.round2b.killStep), 0)!;
  const killed = collectAgyTaskReferences(killStep);
  const otherStep = parseAgyStep(JSON.stringify(FIXTURE.transcript.find((row) => row.step_index === 3)), 0)!;
  check('a step with no `manage_task` call contributes nothing',
    collectAgyTaskReferences(otherStep).length === 0);

  // A settlement is the ONLY positive proof a task ended, so it wins over
  // anything the transcript said earlier.
  const settled = new Map([['task-7', { outcome: 'done' as const, title: 'Demo background task finished' }]]);
  const ledger = foldAgyTaskLedger([...references, ...killed], settled);
  const byId = new Map(ledger.map((entry) => [entry.taskId, entry]));
  check('a settled task reports the outcome and title the host wrote',
    byId.get('task-7')?.status === 'done' && byId.get('task-7')?.title === 'Demo background task finished',
    JSON.stringify(byId.get('task-7')));
  check('a `kill` marks a task cancelled even with no settlement',
    byId.get('task-9')?.status === 'cancelled', JSON.stringify(byId.get('task-9')));

  const unsettled = foldAgyTaskLedger(references, new Map());
  check('an unsettled task is `in-progress` — the honest word for "no ending was recorded"',
    unsettled[0]?.status === 'in-progress', JSON.stringify(unsettled));
  check('the ledger keeps first-seen order',
    JSON.stringify(ledger.map((entry) => entry.taskId)) === JSON.stringify(['task-7', 'task-9']),
    ledger.map((entry) => entry.taskId).join(','));

  const panel = agyTaskListState(live, ledger) as { type: string; key: string; status: string; items: unknown[] };
  check('the ledger renders as ONE upserted panel keyed per conversation',
    panel.type === 'task-list-state' && panel.key === `agy:${live}:tasks` && panel.items.length === 2,
    JSON.stringify({ key: panel.key, items: panel.items.length }));
  check('a panel with nothing live is done, not running', panel.status === 'done', panel.status);
  const running = agyTaskListState(live, unsettled) as { status: string };
  check('a panel with an in-progress task is running', running.status === 'running');
  check('no tasks means no panel at all, rather than an empty one',
    agyTaskListState(live, []) === undefined);
}

// ── A settled task's captured output (P2c) ─────────────────────────────────
//
// The settlement stays a durable TOOL BLOCK and is deliberately not promoted to
// `agent-activity`: a settlement exists only because the work ended, so every one
// would carry a terminal status, and the protocol REMOVES the live surface on a
// terminal `agent-activity`. Promoting would delete the record.
{
  const live = FIXTURE.conversationIds.withTranscript;
  const settlement = parseAgySettlement(JSON.stringify(FIXTURE.settlement))!;

  const plain = mapAgySettlement(settlement, live);
  check('a settlement with no log keeps its result a plain string',
    typeof (plain[1] as { result: unknown }).result === 'string');
  check('a settlement is a durable tool-call/tool-result pair, never an agent-activity card',
    plain.length === 2 && plain[0]!.type === 'tool-call' && plain[1]!.type === 'tool-result'
      && !plain.some((message) => message.type === 'agent-activity'),
    plain.map((message) => message.type).join(','));

  const withLog = mapAgySettlement(settlement, live, { text: 'stdout here', truncated: false });
  const result = withLog[1] as { result: { summary: unknown; log: unknown }; truncated?: boolean };
  check('the host\'s OUTCOME sentence and the task\'s stdout are separate fields',
    result.result.summary === settlement.content && result.result.log === 'stdout here',
    JSON.stringify(result.result).slice(0, 120));
  check('an untruncated log sets no truncation flag', result.truncated === undefined);

  const cut = mapAgySettlement(settlement, live, { text: 'partial', truncated: true });
  check('a log the reader had to cut short says so on the row',
    (cut[1] as { truncated?: boolean }).truncated === true);
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
