/**
 * Identity: live and replay agree, and the drive registry cannot be evicted by a ghost.
 *
 * Two properties, and both exist because their absence shipped as a real defect
 * on another adapter:
 *
 *  1. ONE recorded run, played through the transcript replay and through the
 *     live drive stream, produces IDENTICAL KEYS IN IDENTICAL ORDER. Where a
 *     live path and a replay path both produce the same row, they drift
 *     (reflection §5) — claude's P1b assigned two different keys to one message,
 *     so its queued bubble could never clear and a refetch orphaned the row.
 *     Here the two wire shapes genuinely differ (`agent_response` ↔
 *     `PLANNER_RESPONSE` is not a case fold), so the normalization table is what
 *     is really under test.
 *  2. The drive registry is IDENTITY-KEYED, so a stale connection closing cannot
 *     deregister the live replacement that already took over. claude's registry
 *     was an identity-blind `Set`; the session drove fine while every roster row
 *     reported "observing".
 *
 * The real `agy` is never spawned — the live half runs against the scripted fake.
 *
 *   bun run packages/typescript/adapters/antigravity/test/test-agy-identity.ts   (exit 0 = all pass)
 */
export {};
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentMessage, SessionInfo } from '@cosyncing/adapter-api';
import {
  AgyAdapter,
  AgyDriveConnection,
  AgyObserveConnection,
  agySourceForStepType,
  agyStepKey,
  createAgyMapState,
  mapAgyStep,
  normalizeAgyStreamStepType,
  parseAgyStep,
  type AgyStep,
} from '../src/index.ts';
import { buildAgyFixtureTree, FIXTURE, jsonl, writeFakeAgyBinary } from './fixtures/tree.ts';

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const CONVERSATION = FIXTURE.conversationIds.withTranscript;

async function waitFor(predicate: () => boolean, timeoutMs = 6000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

/** Every stable identity a message carries, in order. This is what must match. */
function keysOf(messages: AgentMessage[]): string[] {
  return messages.map((message) => {
    const record = message as unknown as Record<string, unknown>;
    return `${message.type}#${String(record.key ?? record.callId ?? '')}`;
  });
}

/**
 * ONE recorded run, in both wire shapes.
 *
 * The transcript half is what agy writes to `transcript.jsonl`; the stream half
 * is the `step_update` sequence the drive child emits for the SAME run, with the
 * same `step_index` values (which agree exactly across the two, MEASURED) and the
 * lower-snake-case step names the stream uses.
 */
const RUN_TRANSCRIPT: Array<Record<string, unknown>> = [
  {
    step_index: 10, source: 'SYSTEM', type: 'CHECKPOINT', status: 'DONE',
    created_at: '2026-08-25T09:00:00Z', content: '{{ CHECKPOINT 0 }}\n a resume boundary',
  },
  {
    step_index: 11, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE',
    created_at: '2026-08-25T09:00:01Z', content: 'the answer is ok',
  },
  {
    step_index: 12, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE',
    created_at: '2026-08-25T09:00:02Z', content: 'a system message from the harness',
  },
  // A SECOND keyed row at a different index, so the comparison below is over two
  // distinct keys in a specific order rather than one — an ordering assertion
  // with a single keyed element proves almost nothing.
  {
    step_index: 13, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE',
    created_at: '2026-08-25T09:00:03Z', content: 'and here is the follow-up',
  },
];

/** The same three steps as the stream emits them. Names differ; indices do not. */
const RUN_STREAM: Array<Record<string, unknown>> = [
  { step_update: {}, conversation_id: CONVERSATION, step_index: 10, state: 'STEP_DONE', step_type: 'checkpoint', text_delta: '{{ CHECKPOINT 0 }}\n a resume boundary' },
  { step_update: {}, conversation_id: CONVERSATION, step_index: 11, state: 'STEP_RUNNING', step_type: 'agent_response', text_delta: 'the answer ' },
  { step_update: {}, conversation_id: CONVERSATION, step_index: 11, state: 'STEP_DONE', step_type: 'agent_response', text_delta: 'is ok', usage: { input: 3, output: 4 } },
  { step_update: {}, conversation_id: CONVERSATION, step_index: 12, state: 'STEP_DONE', step_type: 'system_message', text_delta: 'a system message from the harness' },
  { step_update: {}, conversation_id: CONVERSATION, step_index: 13, state: 'STEP_DONE', step_type: 'agent_response', text_delta: 'and here is the follow-up' },
  { result: {}, conversation_id: CONVERSATION, status: 'SUCCESS', response: 'ok', num_turns: 1, usage: { input: 3, output: 4, thinking: 0, cache_read: 0 } },
];

// ── 1. The normalization table maps the run onto the same pairs ─────────────
{
  const streamTypes = ['checkpoint', 'agent_response', 'system_message'];
  const normalized = streamTypes.map(normalizeAgyStreamStepType);
  check('the stream names normalize onto the transcript vocabulary',
    normalized.join(',') === 'CHECKPOINT,PLANNER_RESPONSE,SYSTEM_MESSAGE', normalized.join(','));
  check('agent_response → PLANNER_RESPONSE is not a case fold',
    'agent_response'.toUpperCase() !== 'PLANNER_RESPONSE' && normalized[1] === 'PLANNER_RESPONSE');
  check('the source is completed from the inventory, so the PAIR is keyed on, never the type alone',
    agySourceForStepType('PLANNER_RESPONSE') === 'MODEL' && agySourceForStepType('CHECKPOINT') === 'SYSTEM',
    `${agySourceForStepType('PLANNER_RESPONSE')}/${agySourceForStepType('CHECKPOINT')}`);
}

// ── 2. The pure fold: same steps, both shapes, same keys ────────────────────
{
  const replayState = createAgyMapState(CONVERSATION);
  const replayMessages = RUN_TRANSCRIPT.flatMap((row) => mapAgyStep(row as unknown as AgyStep, replayState));

  // Rebuild the same steps the way the live path does: normalize the stream
  // name, complete the source from the inventory, accumulate the deltas.
  const liveState = createAgyMapState(CONVERSATION, { liveChild: true });
  const accumulated = new Map<number, { type: string; text: string }>();
  for (const event of RUN_STREAM) {
    if (typeof event.step_index !== 'number') continue;
    const type = normalizeAgyStreamStepType(String(event.step_type));
    const open = accumulated.get(event.step_index) ?? { type, text: '' };
    open.text += String(event.text_delta ?? '');
    accumulated.set(event.step_index, open);
  }
  const liveMessages = [...accumulated.entries()].flatMap(([stepIndex, open]) => mapAgyStep({
    step_index: stepIndex,
    source: agySourceForStepType(open.type),
    type: open.type,
    status: 'DONE',
    created_at: '2026-08-25T09:00:00Z',
    content: open.text,
  }, liveState));

  check('replay and live produce the same NUMBER of messages',
    replayMessages.length === liveMessages.length, `${replayMessages.length} vs ${liveMessages.length}`);
  check('replay and live produce IDENTICAL KEYS IN IDENTICAL ORDER',
    keysOf(replayMessages).join('|') === keysOf(liveMessages).join('|'),
    `${keysOf(replayMessages).join('|')}  vs  ${keysOf(liveMessages).join('|')}`);
  check('the keys are the agyStepKey of their own step',
    keysOf(replayMessages).some((key) => key.includes(agyStepKey(CONVERSATION, 11)))
      && keysOf(replayMessages).some((key) => key.includes(agyStepKey(CONVERSATION, 13))),
    keysOf(replayMessages).join('|'));
  // The equality above is only meaningful if more than one row actually carries a
  // key: `notice` and `event` carry none by contract, so a single-keyed run would
  // make the ordering assertion nearly vacuous.
  const keyed = keysOf(replayMessages).filter((key) => !key.endsWith('#'));
  check('at least two rows in the compared run carry real keys, in a specific order',
    keyed.length >= 2 && keyed[0]!.includes(':11:') && keyed[1]!.includes(':13:'),
    keyed.join('|'));
}

// ── 3. End to end: the real replay vs the real drive stream ─────────────────
{
  // The replay half: an observe connection over a transcript holding the run.
  const replayTree = buildAgyFixtureTree({ withoutSettlement: true, withoutTranscriptFull: true });
  let replayKeys: string[] = [];
  try {
    writeFileSync(replayTree.transcriptPath, jsonl(RUN_TRANSCRIPT));
    const info: SessionInfo = {
      id: CONVERSATION, nativeId: CONVERSATION, tool: 'agy', title: 'run',
      status: 'idle', attachMode: 'observe',
    };
    const observe = new AgyObserveConnection({
      roots: replayTree.roots, conversationId: CONVERSATION, info, trace: () => {},
    });
    replayKeys = keysOf(await observe.getHistory());
    await observe.close();
    check('the replay half produced messages', replayKeys.length > 0, replayKeys.join('|'));
  } finally {
    replayTree.cleanup();
  }

  // The live half: a drive connection over an EMPTY transcript, fed the same run
  // by the scripted child through the real stdout pump.
  const liveTree = buildAgyFixtureTree({ withoutSettlement: true, withoutTranscriptFull: true });
  try {
    writeFileSync(liveTree.transcriptPath, '');
    const fake = writeFakeAgyBinary(join(liveTree.dir, 'bin'), { turns: [RUN_STREAM] });
    const info: SessionInfo = {
      id: CONVERSATION, nativeId: CONVERSATION, tool: 'agy', title: 'run',
      status: 'idle', attachMode: 'resume',
    };
    const drive = new AgyDriveConnection({
      roots: liveTree.roots, conversationId: CONVERSATION, info, binary: fake.path, trace: () => {},
    });
    const live: AgentMessage[] = [];
    drive.subscribe((message) => live.push(message));
    await drive.getHistory();
    await drive.sendPrompt({ text: 'run it' });
    await waitFor(() => live.some((m) => m.type === 'token-count'));
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Drop the frames that belong to the SEND rather than to the run: the minted
    // pending row, its status/metadata traffic and the turn's token accounting
    // have no transcript counterpart by construction.
    const liveKeys = keysOf(live.filter((message) =>
      message.type !== 'status'
      && message.type !== 'token-count'
      && message.type !== 'metadata-update'
      && !(message.type === 'user-message' && String((message as { key?: string }).key).startsWith('queued:agy:')),
    ));

    check('the live half produced messages', liveKeys.length > 0, liveKeys.join('|'));
    check('ONE recorded run through replay and through the live stream yields IDENTICAL KEYS IN IDENTICAL ORDER',
      liveKeys.join('|') === replayKeys.join('|'),
      `live: ${liveKeys.join('|')}\n            replay: ${replayKeys.join('|')}`);

    await drive.close();
  } finally {
    liveTree.cleanup();
  }
}

// ── 4. A step seen on BOTH paths is admitted once ──────────────────────────
{
  // The stream reports a step, and then agy writes the same step to the
  // transcript. The shared `seenSteps` fence must admit it exactly once.
  const tree = buildAgyFixtureTree({ withoutSettlement: true, withoutTranscriptFull: true });
  try {
    writeFileSync(tree.transcriptPath, '');
    const fake = writeFakeAgyBinary(join(tree.dir, 'bin'), { turns: [RUN_STREAM] });
    const info: SessionInfo = {
      id: CONVERSATION, nativeId: CONVERSATION, tool: 'agy', title: 'run',
      status: 'idle', attachMode: 'resume',
    };
    const drive = new AgyDriveConnection({
      roots: tree.roots, conversationId: CONVERSATION, info, binary: fake.path, trace: () => {},
    });
    const live: AgentMessage[] = [];
    drive.subscribe((message) => live.push(message));
    await drive.getHistory();
    await drive.sendPrompt({ text: 'run it' });
    await waitFor(() => live.some((m) => m.type === 'token-count'));

    const before = live.filter((m) => m.type === 'model-output').length;
    // agy now writes the SAME step to the transcript; the tail sees it too.
    writeFileSync(tree.transcriptPath, jsonl(RUN_TRANSCRIPT));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const after = live.filter((m) => m.type === 'model-output').length;

    check('a step reported by the stream is not re-emitted when the transcript catches up',
      after === before, `${before} → ${after}`);
    await drive.close();
  } finally {
    tree.cleanup();
  }
}

// ── 5. The registry is identity-keyed ──────────────────────────────────────
{
  const tree = buildAgyFixtureTree();
  try {
    const fake = writeFakeAgyBinary(join(tree.dir, 'bin'), { turns: [] });
    const adapter = new AgyAdapter({
      roots: tree.roots,
      env: { PATH: join(tree.dir, 'bin') },
      trace: () => {},
    });

    const first = await adapter.attach(CONVERSATION, 'resume') as AgyDriveConnection;
    check('the first drive attach registers', adapter.isDriving(CONVERSATION) === true);

    // The hub attaches a REPLACEMENT before closing the incumbent it displaced.
    const second = await adapter.attach(CONVERSATION, 'resume') as AgyDriveConnection;
    check('two drive connections have distinct identities', first.identity !== second.identity,
      `${first.identity} vs ${second.identity}`);
    check('the replacement is now the registered owner',
      adapter.driveConnection(CONVERSATION) === second);

    // Now the STALE one closes. An identity-blind registry would delete the entry
    // here and the session would drive on while every roster row said observing.
    await first.close();
    check('a stale close does NOT deregister the live replacement',
      adapter.isDriving(CONVERSATION) === true);
    check('the replacement is still the registered owner after the stale close',
      adapter.driveConnection(CONVERSATION) === second);

    const rows = await adapter.discoverSessions();
    check('the roster still reports the session as driven after the stale close',
      rows.find((row) => row.id === CONVERSATION)?.control?.drive.state === 'driving',
      JSON.stringify(rows.find((row) => row.id === CONVERSATION)?.control?.drive));

    // The real owner closing DOES deregister.
    await second.close();
    check('the registered owner closing deregisters it', adapter.isDriving(CONVERSATION) === false);
    check('the roster reports observing again',
      (await adapter.discoverSessions()).find((row) => row.id === CONVERSATION)?.control?.drive.state === 'observing');

    // A close AFTER deregistration is a no-op, not a resurrection or a throw.
    await first.close();
    check('closing an already-deregistered connection is a no-op',
      adapter.isDriving(CONVERSATION) === false);
    check('no child was ever spawned across the whole registry exercise', fake.argv() === undefined,
      JSON.stringify(fake.argv()));
  } finally {
    tree.cleanup();
  }
}

// ── 6. The key function itself ─────────────────────────────────────────────
{
  check('agyStepKey is deterministic across calls', agyStepKey(CONVERSATION, 7) === agyStepKey(CONVERSATION, 7));
  check('different steps get different keys', agyStepKey(CONVERSATION, 7) !== agyStepKey(CONVERSATION, 8));
  check('different conversations get different keys', agyStepKey('other', 7) !== agyStepKey(CONVERSATION, 7));
  check('the key carries no clock',
    !/\d{13}/.test(agyStepKey(CONVERSATION, 7)), agyStepKey(CONVERSATION, 7));
  // The parsed step keeps its identity through a parse round trip.
  const parsed = parseAgyStep(JSON.stringify(RUN_TRANSCRIPT[1]), 0)!;
  const state = createAgyMapState(CONVERSATION);
  const mapped = mapAgyStep(parsed, state);
  check('a parsed transcript line keys the same as the raw object',
    keysOf(mapped).join('|')
      === keysOf(mapAgyStep(RUN_TRANSCRIPT[1] as unknown as AgyStep, createAgyMapState(CONVERSATION))).join('|'),
    keysOf(mapped).join('|'));
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
