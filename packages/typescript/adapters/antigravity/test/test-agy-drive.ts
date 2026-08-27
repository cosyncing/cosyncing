/**
 * Drive: every write is the host's own contract, or it refuses.
 *
 * The properties asserted here are each a way a driven session loses the user's
 * words or lies about what happened:
 *
 *  1. Attaching costs NOTHING. The child spawns on the first prompt, never on
 *     attach, because every `agy` invocation pays a full workspace init.
 *  2. The invocation contract is exact — and `--print` is NEVER passed. On
 *     ≤1.1.17 it swallows the next flag as its prompt; on 1.1.18+ it is an error.
 *  3. An accepted prompt is DURABLE before the child admits it, and survives a
 *     `getHistory()` replay — otherwise a page refresh deletes what the user typed.
 *  4. The delivering transcript line CLAIMS that row's key instead of minting a
 *     second one, and a byte fence stops a line written before the send from
 *     claiming it — repeated prompts ("continue", "yes") recur verbatim.
 *  5. A send against a dead child REJECTS before touching run state.
 *  6. Demotion keeps accepted prompts; only close() drops them.
 *  7. A turn whose stream closes with no `result` SURFACES — that is the measured
 *     exit-0 trap, and a silent version of it hangs forever.
 *  8. Turn outcome is read from `result`, never from an exit code.
 *
 * The real `agy` is never spawned: the child is a scripted fake that speaks the
 * measured wire and records its argv and stdin.
 *
 *   bun run packages/typescript/adapters/antigravity/test/test-agy-drive.ts   (exit 0 = all pass)
 */
export {};
import { appendFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentMessage, SessionInfo } from '@cosyncing/adapter-api';
import {
  AGY_CANCELED_STATUS,
  AGY_MAX_STEP_TEXT_BYTES,
  AGY_STEP_TRUNCATION_NOTE,
  AgyAdapter,
  AgyDriveConnection,
  AgyLineFramer,
  agyCommandState,
  agyDriveArgs,
  agyStepStatusForState,
  isTerminalStreamState,
  truncateToUtf8Bytes,
  type AgyTrace,
} from '../src/index.ts';
import { buildAgyFixtureTree, FIXTURE, jsonl, writeFakeAgyBinary, type AgyFakeScript } from './fixtures/tree.ts';

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const CONVERSATION = FIXTURE.conversationIds.withTranscript;

/** Poll until `predicate` holds. Test synchronization, not production polling. */
async function waitFor(predicate: () => boolean, timeoutMs = 6000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

const settle = (ms = 300): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A LONE surrogate — a high one with no low after it, or a low one with no high
 * before it. Matching the bare range `[\uD800-\uDFFF]` would be wrong: a correct
 * emoji is a surrogate PAIR and both of its halves live in that range, so the
 * naive test flags every valid emoji as damaged.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Round-tripping through UTF-8 is the real proof: a lone surrogate comes back as U+FFFD. */
function isValidUtf8(text: string): boolean {
  return Buffer.from(text, 'utf8').toString('utf8') === text && !LONE_SURROGATE.test(text);
}

/** A transcript `USER_INPUT` line, wrapped exactly the way agy writes one. */
function userInputStep(stepIndex: number, text: string): Record<string, unknown> {
  return {
    step_index: stepIndex,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    status: 'DONE',
    created_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: ${new Date().toISOString()}.\n</ADDITIONAL_METADATA>`,
  };
}

const RESULT_OK = {
  conversation_id: CONVERSATION,
  status: 'SUCCESS',
  response: 'ok',
  duration_seconds: 1.2,
  num_turns: 1,
  usage: { input: 120, output: 30, thinking: 7, cache_read: 64 },
};

const INIT_EVENT = {
  init: {},
  conversation_id: CONVERSATION,
  model: 'gemini-3.5-flash-low',
  cwd: '/fixture/demo-project',
  permission_mode: 'request-review',
  tools: ['run_command', 'view_file'],
};

interface Harness {
  connection: AgyDriveConnection;
  messages: AgentMessage[];
  users(): Array<{ key?: string; text: string; queued?: boolean }>;
  /** Structured degradations. A bounded reader that drops data must SAY it dropped data. */
  traces: AgyTrace[];
  statuses(): string[];
  errors(): string[];
  transcriptPath: string;
  fake: ReturnType<typeof writeFakeAgyBinary>;
  cleanup(): void;
}

function newDrive(
  script: AgyFakeScript,
  options: { transcriptSteps?: number; noSubscribe?: boolean; tailReadMaxBytes?: number; mode?: string } = {},
): Harness {
  const tree = buildAgyFixtureTree({
    transcriptSteps: options.transcriptSteps ?? 3,
    withoutSettlement: true,
  });
  const fake = writeFakeAgyBinary(join(tree.dir, 'bin'), script);
  const info: SessionInfo = {
    id: CONVERSATION,
    nativeId: CONVERSATION,
    tool: 'agy',
    title: 'Demo Project Review',
    status: 'idle',
    attachMode: 'resume',
  };
  const traces: AgyTrace[] = [];
  const connection = new AgyDriveConnection({
    roots: tree.roots,
    conversationId: CONVERSATION,
    info,
    binary: fake.path,
    trace: (trace) => traces.push(trace),
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
    ...(options.tailReadMaxBytes !== undefined ? { tailReadMaxBytes: options.tailReadMaxBytes } : {}),
  });
  const messages: AgentMessage[] = [];
  // Subscribing is what starts the transcript tail, so a harness WITHOUT a
  // subscriber exercises the replay-only path — the one where a delivered prompt
  // is first seen by `getHistory()` rather than by the tail.
  if (!options.noSubscribe) connection.subscribe((message) => messages.push(message));
  return {
    connection,
    messages,
    traces,
    users: () => messages.filter((m) => m.type === 'user-message') as never,
    statuses: () => messages.filter((m) => m.type === 'status').map((m) => (m as { status: string }).status),
    errors: () => messages.filter((m) => m.type === 'error').map((m) => (m as { message: string }).message),
    transcriptPath: tree.transcriptPath,
    fake,
    cleanup: () => {
      void connection.close();
      tree.cleanup();
    },
  };
}

// ── 1. The invocation contract ──────────────────────────────────────────────
{
  const args = agyDriveArgs(CONVERSATION, { model: 'gemini-3.5-flash-low', mode: 'plan' });
  check('the child is never given --print', !args.includes('--print') && !args.includes('--prompt'), args.join(' '));
  check('the conversation is resumed in place',
    args[0] === '--conversation' && args[1] === CONVERSATION, args.join(' '));
  check('both stream-json formats are set',
    args.includes('--output-format=stream-json') && args.includes('--input-format=stream-json'), args.join(' '));
  check('model and mode ride as separate argv entries (never fused onto --print)',
    args.includes('--model') && args[args.indexOf('--model') + 1] === 'gemini-3.5-flash-low'
      && args.includes('--mode') && args[args.indexOf('--mode') + 1] === 'plan',
    args.join(' '));
  const bare = agyDriveArgs(undefined);
  check('a new session omits --conversation and adopts the id from init',
    !bare.includes('--conversation') && bare.includes('--input-format=stream-json'), bare.join(' '));
}

// ── 2. Attach spawns nothing; the first prompt spawns ───────────────────────
{
  const h = newDrive({ init: INIT_EVENT, defaultTurn: [RESULT_OK] });
  try {
    await h.connection.getHistory();
    await settle(200);
    check('attaching and replaying history spawns NO child (an opened row costs nothing)',
      h.fake.argv() === undefined, JSON.stringify(h.fake.argv()));

    await h.connection.sendPrompt({ text: 'hello there' });
    check('the first sendPrompt spawned the child', await waitFor(() => h.fake.argv() !== undefined),
      JSON.stringify(h.fake.argv()));
    const argv = h.fake.argv()!;
    check('the spawned argv carries no --print', !argv.includes('--print'), argv.join(' '));
    check('the spawned argv resumes this conversation',
      argv.includes('--conversation') && argv.includes(CONVERSATION), argv.join(' '));

    check('the prompt was written to stdin as one NDJSON `event: user` line',
      await waitFor(() => h.fake.stdin().length === 1)
        && h.fake.stdin()[0]!.event === 'user'
        && JSON.stringify(h.fake.stdin()[0]!.message) === JSON.stringify({ role: 'user', content: 'hello there' }),
      JSON.stringify(h.fake.stdin()));
  } finally {
    h.cleanup();
  }
}

// ── 3. The minted pending row (Q7) ──────────────────────────────────────────
{
  const h = newDrive({ init: INIT_EVENT, defaultTurn: [RESULT_OK] });
  try {
    await h.connection.getHistory();
    await h.connection.sendPrompt({ text: 'first prompt' });

    const minted = h.users().find((row) => row.text === 'first prompt');
    check('the prompt gets a row IMMEDIATELY, before the child admits it', !!minted, JSON.stringify(minted));
    check('the row is keyed in the adapter-minted namespace',
      !!minted?.key?.startsWith('queued:agy:'), String(minted?.key));
    check('a first prompt on an idle session is NOT flagged queued',
      minted?.queued === undefined, JSON.stringify(minted));

    // A page refresh is exactly this: attach, replay getHistory(), and nothing else.
    const replay = await h.connection.getHistory();
    const replayed = replay.filter((m) => m.type === 'user-message' && (m as { text: string }).text === 'first prompt');
    check('the pending row SURVIVES a getHistory() replay (a refresh keeps the words)',
      replayed.length === 1, `${replayed.length} rows`);
    check('the replayed row keeps the SAME key it was minted under',
      (replayed[0] as { key?: string }).key === minted?.key, String((replayed[0] as { key?: string }).key));

    // A second prompt while the turn is still running is the queued case.
    await h.connection.sendPrompt({ text: 'second prompt' });
    const second = h.users().find((row) => row.text === 'second prompt');
    check('a prompt sent during a live turn is flagged queued', second?.queued === true, JSON.stringify(second));
  } finally {
    h.cleanup();
  }
}

// ── 4. The delivering line claims the key; the byte fence holds ─────────────
{
  const h = newDrive({ init: INIT_EVENT, defaultTurn: [RESULT_OK] });
  try {
    await h.connection.getHistory();
    await h.connection.sendPrompt({ text: 'continue' });
    const minted = h.users().find((row) => row.text === 'continue')!;
    const before = h.users().length;

    // agy writes the delivering line itself, AFTER our send.
    appendFileSync(h.transcriptPath, jsonl([userInputStep(50, 'continue')]));
    await waitFor(() => h.users().length > before);
    await settle(200);

    const delivered = h.users().filter((row) => row.text === 'continue');
    check('the delivering transcript line does NOT mint a second row',
      delivered.length === 2, `${delivered.length} rows for one prompt`);
    check('the delivering line CLAIMS the minted key, so the queued bubble clears in place',
      delivered[1]!.key === minted.key, `${String(delivered[1]!.key)} vs ${String(minted.key)}`);
    check('the delivered row is no longer flagged queued', delivered[1]!.queued === undefined);

    // Once claimed, the row is durable upstream — the replay must stop re-adding ours.
    const replay = await h.connection.getHistory();
    const replayedContinues = replay.filter(
      (m) => m.type === 'user-message' && (m as { text: string }).text === 'continue',
    );
    check('after delivery the replay carries the transcript row ONCE, not the pending row too',
      replayedContinues.length === 1, `${replayedContinues.length} rows`);
    check('the replayed row still carries the minted key (one identity across the transition)',
      (replayedContinues[0] as { key?: string }).key === minted.key,
      String((replayedContinues[0] as { key?: string }).key));
  } finally {
    h.cleanup();
  }
}

// ── 5. A repeated prompt cannot claim a line written BEFORE its send ────────
{
  // The transcript ALREADY contains "yes" before the connection ever sends one.
  const h = newDrive({ init: INIT_EVENT, defaultTurn: [RESULT_OK] });
  try {
    appendFileSync(h.transcriptPath, jsonl([userInputStep(60, 'yes')]));
    await h.connection.getHistory();
    const sizeBeforeSend = statSync(h.transcriptPath).size;

    await h.connection.sendPrompt({ text: 'yes' });
    const minted = h.users().find((row) => row.text === 'yes' && row.key?.startsWith('queued:agy:'))!;
    check('the send minted its own row even though an identical line already existed', !!minted, String(minted?.key));

    // Re-read history. The replay walks the OLD "yes" line, which sits at a byte
    // offset BELOW the fence — it must not be able to claim the pending key.
    //
    // The discriminator is the KEY the old line ends up with, not its `queued`
    // flag: an unqueued pending row and a delivered transcript row both lack the
    // flag, so keying the assertion on it would pass for the wrong reason.
    const replay = await h.connection.getHistory();
    const yesRows = replay.filter((m) => m.type === 'user-message' && (m as { text: string }).text === 'yes') as
      Array<{ key?: string; queued?: boolean }>;
    const oldLineKey = `agy:${CONVERSATION}:60`;
    check('the replay carries exactly two "yes" rows: the old transcript line and our pending one',
      yesRows.length === 2, JSON.stringify(yesRows.map((r) => r.key)));
    check('an identical line written BEFORE the send keeps its OWN step key',
      yesRows.some((row) => row.key === oldLineKey), JSON.stringify(yesRows.map((r) => r.key)));
    check('an identical line written BEFORE the send cannot claim the pending key',
      !yesRows.some((row) => row.key === minted.key && row.key === oldLineKey)
        && yesRows.filter((row) => row.key === minted.key).length === 1,
      JSON.stringify(yesRows.map((r) => r.key)));
    check('the pending row is still replayed, still waiting for its own delivery',
      yesRows.some((row) => row.key === minted.key),
      JSON.stringify(yesRows.map((r) => ({ k: r.key, q: r.queued }))));
    check('the fence was taken at the transcript size at send time', sizeBeforeSend > 0, String(sizeBeforeSend));

    // Now the REAL delivery lands, after the fence.
    const before = h.users().length;
    appendFileSync(h.transcriptPath, jsonl([userInputStep(61, 'yes')]));
    await waitFor(() => h.users().length > before);
    await settle(200);
    const claimed = h.users().filter((row) => row.text === 'yes' && row.key === minted.key);
    check('the line written AFTER the send does claim it', claimed.length >= 1, `${claimed.length}`);
  } finally {
    h.cleanup();
  }
}

// ── 6. A send against a dead child rejects BEFORE run state ─────────────────
{
  const h = newDrive({ init: INIT_EVENT, defaultTurn: [RESULT_OK] });
  try {
    await h.connection.getHistory();
    // Point the connection at a binary that cannot spawn.
    (h.connection as unknown as { binary: string }).binary = join('/nonexistent', 'agy-does-not-exist');
    const before = h.messages.length;

    let rejected = false;
    let message = '';
    try {
      await h.connection.sendPrompt({ type: undefined, text: 'this must not vanish' } as never);
    } catch (error) {
      rejected = true;
      message = String(error);
    }
    check('a send with no launchable child REJECTS rather than silently dropping the prompt', rejected, message);

    const after = h.messages.slice(before);
    check('it did not publish a running turn',
      !after.some((m) => m.type === 'status' && (m as { status: string }).status === 'running'),
      after.map((m) => m.type).join(','));
    check('it minted no pending row for a prompt that was never written',
      !after.some((m) => m.type === 'user-message' && (m as { text: string }).text === 'this must not vanish'),
      after.map((m) => m.type).join(','));
  } finally {
    h.cleanup();
  }
}

// ── 7. Foreign write self-demotes, keeps prompts, keeps the tail ────────────
{
  const h = newDrive({ init: INIT_EVENT, defaultTurn: [RESULT_OK] });
  try {
    await h.connection.getHistory();
    await h.connection.sendPrompt({ text: 'ours' });
    const minted = h.users().find((row) => row.text === 'ours')!;
    check('the connection starts out driving', h.connection.driving === true);

    const before = h.messages.length;
    // A prompt WE never sent appears: a terminal took the conversation.
    appendFileSync(h.transcriptPath, jsonl([userInputStep(70, 'typed in a terminal')]));
    await waitFor(() => h.connection.driving === false);
    await settle(250);

    check('a USER_EXPLICIT line we did not submit self-demotes the connection',
      h.connection.driving === false);
    const after = h.messages.slice(before);
    check('the demotion broadcasts the new posture to every subscriber',
      after.some((m) => m.type === 'metadata-update'
        && (m as { key: string }).key === 'sessionInfo'
        && JSON.stringify((m as { value: unknown }).value).includes('observing')),
      after.filter((m) => m.type === 'metadata-update').map((m) => JSON.stringify(m)).join(','));
    check('the demotion says so in words', after.some((m) => m.type === 'notice'));

    // The tail must keep running: the session is still watchable.
    const usersBefore = h.users().length;
    appendFileSync(h.transcriptPath, jsonl([{
      step_index: 71, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE',
      created_at: '2026-08-25T10:00:00Z', content: 'still following along',
    }]));
    await waitFor(() => h.messages.some((m) => m.type === 'model-output'
      && String((m as { text?: string }).text).includes('still following along')));
    check('demotion does NOT kill the transcript tail',
      h.messages.some((m) => m.type === 'model-output'
        && String((m as { text?: string }).text).includes('still following along')),
      `users ${usersBefore}`);

    // Reflection §6: demotion keeps the accepted prompts.
    const replay = await h.connection.getHistory();
    check('demotion KEEPS the accepted prompts (they were already written to stdin)',
      replay.some((m) => m.type === 'user-message' && (m as { key?: string }).key === minted.key),
      JSON.stringify(replay.filter((m) => m.type === 'user-message').map((m) => (m as { key?: string }).key)));

    let sendRefused = false;
    try {
      await h.connection.sendPrompt({ text: 'after demotion' });
    } catch {
      sendRefused = true;
    }
    check('a demoted connection refuses to write', sendRefused);

    // Only close() drops them.
    await h.connection.close();
    const afterClose = await h.connection.getHistory();
    check('only close() drops the pending rows',
      !afterClose.some((m) => m.type === 'user-message' && (m as { key?: string }).key === minted.key));
  } finally {
    h.cleanup();
  }
}

// ── 8. The stream-closed-without-result trap ────────────────────────────────
{
  // MEASURED: an unrecognized input `event` makes agy exit 0 with only `init`
  // and no `result`. An adapter that just waits would hang forever.
  const h = newDrive({
    init: INIT_EVENT,
    turns: ['silent'],
    silentExitCode: 0,
    stderr: 'warning: ignoring unsupported stream input message event "x"',
  });
  try {
    await h.connection.getHistory();
    await h.connection.sendPrompt({ text: 'this turn will be swallowed' });

    const surfaced = await waitFor(() => h.messages.some((m) => m.type === 'error'));
    check('a turn whose stream closes with NO result surfaces an error', surfaced,
      h.messages.map((m) => m.type).join(','));
    check('the error names the missing result rather than a generic failure',
      h.messages.some((m) => m.type === 'error' && /without reporting the result/i.test((m as { message: string }).message)),
      h.messages.filter((m) => m.type === 'error').map((m) => (m as { message: string }).message).join(' | '));
    check('the session stops reporting a running turn',
      await waitFor(() => {
        const statuses = h.messages.filter((m) => m.type === 'status');
        return statuses.length > 0 && (statuses[statuses.length - 1] as { status: string }).status === 'idle';
      }),
      h.messages.filter((m) => m.type === 'status').map((m) => (m as { status: string }).status).join(','));
    check('the words the user typed are NOT lost by the failure',
      h.users().some((row) => row.text === 'this turn will be swallowed'));
  } finally {
    h.cleanup();
  }
}

// ── 9. result drives the outcome; usage becomes token-count ─────────────────
{
  const h = newDrive({
    init: INIT_EVENT,
    turns: [[
      { step_update: {}, conversation_id: CONVERSATION, step_index: 40, state: 'STEP_RUNNING', step_type: 'agent_response', text_delta: 'partial ' },
      { step_update: {}, conversation_id: CONVERSATION, step_index: 40, state: 'STEP_DONE', step_type: 'agent_response', text_delta: 'answer', usage: { input: 5, output: 2 } },
      RESULT_OK,
    ]],
  });
  try {
    await h.connection.getHistory();
    await h.connection.sendPrompt({ text: 'go' });
    await waitFor(() => h.messages.some((m) => m.type === 'token-count'));
    await settle(200);

    const output = h.messages.find((m) => m.type === 'model-output' && String((m as { text?: string }).text).includes('partial answer'));
    check('step_update deltas accumulate into ONE model-output row', !!output,
      JSON.stringify(h.messages.filter((m) => m.type === 'model-output')));
    check('the live step is keyed by the SAME agyStepKey the replay would use',
      String((output as { key?: string })?.key).startsWith(`agy:${CONVERSATION}:40`),
      String((output as { key?: string })?.key));

    const tokens = h.messages.find((m) => m.type === 'token-count') as
      { input?: number; output?: number; cacheRead?: number } | undefined;
    check('the result usage becomes a token-count', !!tokens, JSON.stringify(tokens));
    check('input/output/cache_read map onto the contract fields',
      tokens?.input === 120 && tokens.output === 30 && tokens.cacheRead === 64, JSON.stringify(tokens));
    check('the unmapped `thinking` bucket is NOT silently folded into output',
      tokens?.output === 30, JSON.stringify(tokens));

    check('the turn ends idle after its result',
      await waitFor(() => {
        const statuses = h.messages.filter((m) => m.type === 'status');
        return statuses.length >= 2 && (statuses[statuses.length - 1] as { status: string }).status === 'idle';
      }),
      h.messages.filter((m) => m.type === 'status').map((m) => (m as { status: string }).status).join(','));
    check('a SUCCESS result raises no error', !h.messages.some((m) => m.type === 'error'),
      h.messages.filter((m) => m.type === 'error').map((m) => JSON.stringify(m)).join(','));
  } finally {
    h.cleanup();
  }
}

// ── 10. A non-SUCCESS result is an error, whatever the exit code ────────────
{
  const h = newDrive({
    init: INIT_EVENT,
    turns: [[{ result: {}, conversation_id: CONVERSATION, status: 'ERROR', error: 'message field missing', num_turns: 1 }]],
  });
  try {
    await h.connection.getHistory();
    await h.connection.sendPrompt({ text: 'bad turn' });
    check('a non-SUCCESS result event raises an error, read from the RESULT and not an exit code',
      await waitFor(() => h.messages.some((m) => m.type === 'error'
        && /ERROR/.test((m as { message: string }).message))),
      h.messages.filter((m) => m.type === 'error').map((m) => (m as { message: string }).message).join(' | '));
    check('a turn that DID report its result raises no missing-result error',
      !h.messages.some((m) => m.type === 'error' && /without reporting the result/i.test((m as { message: string }).message)),
      h.messages.filter((m) => m.type === 'error').map((m) => (m as { message: string }).message).join(' | '));
  } finally {
    h.cleanup();
  }
}

// ── 11. init re-derives the MODEL; the mode comes from the launch ───────────
//
// TWO AXES, and `init` answers the wrong one. `--mode` takes `default`,
// `accept-edits` or `plan`; `init.permission_mode` reports `request-review`
// under ALL THREE and under no `--mode` at all (MEASURED 2026-08-25, 1.1.20) —
// it is the auto-approval policy, which has no flag. So the model IS re-derived
// from the live child and the mode is NOT: `currentMode` is the posture this
// connection launched with, because nothing else knows it.
{
  const h = newDrive({ init: INIT_EVENT, defaultTurn: [RESULT_OK] }, { mode: 'plan' });
  try {
    await h.connection.getHistory();
    await h.connection.sendPrompt({ text: 'go' });
    await waitFor(() => h.messages.some((m) => m.type === 'metadata-update'));
    await settle(200);

    check('the live init re-derives the model rather than trusting what attach decided',
      h.connection.info.currentModel?.modelID === 'gemini-3.5-flash-low',
      JSON.stringify(h.connection.info.currentModel));
    check('the mode published is the one we LAUNCHED with, not the one init reported',
      h.connection.info.currentMode === 'plan',
      JSON.stringify({ currentMode: h.connection.info.currentMode, initReported: INIT_EVENT.permission_mode }));
    check('the contract field is `currentMode`; `permissionMode` never appears on info',
      !('permissionMode' in h.connection.info));
    check('init reporting a different value is TRACED rather than silently ignored',
      h.traces.some((trace) => trace.op === 'drive-init-permission-mode-ignored'),
      h.traces.map((trace) => trace.op).join(','));
    // The LAUNCH mode is on `info` before anyone can subscribe, which is what the
    // attach snapshot carries. A mid-session CHANGE is the case that needs a
    // broadcast, because by then the clients are already watching — and a mode
    // switch is exactly what would otherwise leave every row on the old posture.
    await h.connection.sendPrompt({ text: 'switch posture', permissionMode: 'accept-edits' });
    check('a mid-session mode change is BROADCAST, not merely stored',
      await waitFor(() => h.messages.some((m) => m.type === 'metadata-update'
        && (m as { key: string }).key === 'sessionInfo'
        && JSON.stringify((m as { value: unknown }).value).includes('"currentMode":"accept-edits"'))),
      h.messages.filter((m) => m.type === 'metadata-update').map((m) => JSON.stringify(m)).join(' | '));
    // The child writes its argv on startup, so this is read AFTER the spawn lands
    // rather than immediately after the parent-side broadcast.
    check('the switched-to mode is one agy accepts, and reaches the argv',
      await waitFor(() => (h.fake.argv() ?? []).join(' ').includes('--mode accept-edits')),
      (h.fake.argv() ?? []).join(' '));
    check('the re-derived model is broadcast too',
      h.messages.some((m) => m.type === 'metadata-update'
        && JSON.stringify((m as { value: unknown }).value).includes('gemini-3.5-flash-low')),
      h.messages.filter((m) => m.type === 'metadata-update').map((m) => JSON.stringify(m)).join(' | '));
  } finally {
    h.cleanup();
  }
}

// ── 11b. A mode agy would silently drop never becomes `currentMode` ─────────
//
// The host's own 1.1.20 changelog records fixing "`--mode` being ignored … an
// unrecognized value produced no warning at all". So passing one leaves the
// child in `default` while the row advertises the mode that was asked for: the
// client believes X, the session is Y, and nothing says so (reflection §11).
{
  const h = newDrive({ init: INIT_EVENT, defaultTurn: [RESULT_OK] }, { mode: 'request-review' });
  try {
    check('an off-vocabulary launch mode is refused before it can be advertised',
      h.connection.info.currentMode === undefined,
      JSON.stringify({ currentMode: h.connection.info.currentMode }));
    await h.connection.getHistory();
    await h.connection.sendPrompt({ text: 'go', permissionMode: 'full-access' });
    await waitFor(() => h.fake.launches() === 1);
    await settle(200);
    const launched = h.fake.argv() ?? [];
    check('a per-turn mode agy does not have is dropped from the argv, with a trace',
      !launched.includes('--mode') && h.traces.some((trace) => trace.op === 'drive-mode-rejected'),
      `${launched.join(' ')} / ${h.traces.map((trace) => trace.op).join(',')}`);
    check('the dropped mode never reaches `currentMode` either',
      h.connection.info.currentMode === undefined,
      String(h.connection.info.currentMode));
  } finally {
    h.cleanup();
  }
}

// ── 11c. A per-turn EFFORT switch launches the sibling id (P2a + F1) ────────
//
// The picker collapses a family's effort variants into one row, so the client
// sends `{modelID: <some variant>, reasoningEffort: 'low'}`. The switch must
// resolve to the SIBLING id before it is compared to the launch model and before
// it reaches the argv — and `--effort` must never be passed, because every
// catalog id is already a variant and the binary rejects the pair. The relaunch
// still obeys the F1 settlement rules: the abandoned turn is named and the
// session returns to idle.
{
  const h = newDrive({
    init: INIT_EVENT,
    turnsByLaunch: [[[]], [[RESULT_OK]]],
    defaultTurn: [],
  });
  try {
    await h.connection.getHistory();
    await h.connection.sendPrompt({ text: 'first, which never answers' });
    await waitFor(() => h.fake.stdin().length === 1);

    await h.connection.sendPrompt({
      text: 'second, at a different effort',
      model: { providerID: 'google-antigravity', modelID: 'gemini-3.7-flash-high', reasoningEffort: 'low' },
    });
    check('an effort switch relaunches the child',
      await waitFor(() => h.fake.launches() === 2), `${h.fake.launches()} launches`);
    const argv = h.fake.argv() ?? [];
    check('the relaunch names the SIBLING id rather than the id the client sent',
      argv.includes('gemini-3.7-flash-low') && !argv.includes('gemini-3.7-flash-high'),
      argv.join(' '));
    check('`--effort` is never passed — the id already carries the effort',
      !argv.includes('--effort'), argv.join(' '));
    check('`--print` is still absent from the relaunched argv', !argv.includes('--print'), argv.join(' '));

    // F1, unchanged by the model resolution in front of it.
    check('the turn the effort switch abandoned is named to the user',
      h.errors().some((message) => /cancelled without a result/i.test(message)),
      h.errors().join(' | '));
    check('the effort switch settles the abandoned generation exactly once',
      h.traces.filter((trace) => trace.op === 'drive-turn-abandoned-by-relaunch').length === 1,
      h.traces.filter((trace) => trace.op === 'drive-turn-abandoned-by-relaunch').length.toString());
    check('the replacement turn CAN return the session to idle',
      await waitFor(() => h.statuses()[h.statuses().length - 1] === 'idle'),
      h.statuses().join(','));
  } finally {
    h.cleanup();
  }
}

// ── 12. Two sockets share ONE connection and one writer (Q14) ───────────────
{
  const h = newDrive({ init: INIT_EVENT, defaultTurn: [RESULT_OK] });
  try {
    await h.connection.getHistory();
    // A peer socket joins the EXISTING connection — `Hub.joinExisting` never attaches.
    const peer: AgentMessage[] = [];
    h.connection.subscribe((message) => peer.push(message));

    await h.connection.sendPrompt({ text: 'from socket A' });
    await h.connection.sendPrompt({ text: 'from socket B' });
    await waitFor(() => h.fake.stdin().length === 2);

    check('both sockets\' prompts reach ONE child stdin, in order',
      h.fake.stdin().map((line) => (line.message as { content: string }).content).join('|')
        === 'from socket A|from socket B',
      JSON.stringify(h.fake.stdin().map((l) => (l.message as { content: string }).content)));
    check('the peer socket sees the other socket\'s pending row',
      peer.some((m) => m.type === 'user-message' && (m as { text: string }).text === 'from socket A'));
    check('a peer socket\'s prompt is NOT treated as a foreign writer',
      h.connection.driving === true);

    // And the delivery of a peer prompt still claims its key rather than demoting.
    const before = h.users().length;
    appendFileSync(h.transcriptPath, jsonl([userInputStep(80, 'from socket B')]));
    await waitFor(() => h.users().length > before);
    await settle(200);
    check('the delivering line for a peer prompt does not demote the shared connection',
      h.connection.driving === true);
  } finally {
    h.cleanup();
  }
}

// ── 13. The adapter's registry (Q9) ─────────────────────────────────────────
{
  const tree = buildAgyFixtureTree();
  try {
    const fake = writeFakeAgyBinary(join(tree.dir, 'bin'), { init: INIT_EVENT, defaultTurn: [RESULT_OK] });
    const adapter = new AgyAdapter({
      roots: tree.roots,
      env: { PATH: join(tree.dir, 'bin') },
      trace: () => {},
    });

    const rowsBefore = await adapter.discoverSessions();
    check('before any drive, every roster row reports observing',
      rowsBefore.every((row) => row.control?.drive.state === 'observing'),
      JSON.stringify(rowsBefore.map((r) => r.control?.drive.state)));

    const drive = await adapter.attach(CONVERSATION, 'resume');
    check('a resume attach returns a drive connection', drive instanceof AgyDriveConnection);
    check('attach registered it as driving', adapter.isDriving(CONVERSATION) === true);
    check('the child is STILL not spawned by attach alone', fake.argv() === undefined);

    const rowsDuring = await adapter.discoverSessions();
    const driven = rowsDuring.find((row) => row.id === CONVERSATION);
    check('EVERY client\'s roster row reports the drive, not just the driver\'s',
      driven?.control?.drive.state === 'driving', JSON.stringify(driven?.control?.drive));
    const others = rowsDuring.filter((row) => row.id !== CONVERSATION);
    check('an unrelated row is unaffected',
      others.every((row) => row.control?.drive.state === 'observing'),
      JSON.stringify(others.map((r) => r.control?.drive.state)));

    await drive.close();
    check('closing the registered owner deregisters it', adapter.isDriving(CONVERSATION) === false);
  } finally {
    tree.cleanup();
  }
}

// ── 14. A relaunch mid-turn SETTLES the generation it abandoned ─────────────
//
// The trap is that the abandoned turn cannot settle itself. `killChild()` clears
// `this.proc` before the child's `exit` fires, so the exit handler's "have we
// already replaced this child?" guard returns early — correctly, since that
// handler must never end the REPLACEMENT's turn. Nothing else was closing the
// books, so `awaitingResult` stayed elevated and the next turn's single `result`
// decremented it to a non-zero number: the session never went idle again.
{
  const h = newDrive({
    init: INIT_EVENT,
    // Launch 1 answers nothing at all — a turn genuinely in flight when the
    // relaunch happens. Launch 2 answers normally.
    turnsByLaunch: [[[]], [[RESULT_OK]]],
    defaultTurn: [],
  });
  try {
    await h.connection.getHistory();
    await h.connection.sendPrompt({ text: 'first, which never answers' });
    await waitFor(() => h.fake.stdin().length === 1);
    check('the first turn is in flight',
      h.statuses().join(',') === 'running', h.statuses().join(','));

    // An EXPLICIT model switch is the one thing that relaunches mid-conversation.
    await h.connection.sendPrompt({
      text: 'second, with a different model',
      model: { providerID: 'google-antigravity', modelID: 'gemini-4-pro-preview' },
    });
    check('the model switch actually relaunched the child',
      await waitFor(() => h.fake.launches() === 2), `${h.fake.launches()} launches`);

    check('the abandoned turn is named to the user, not just dropped',
      h.errors().some((message) => /cancelled without a result/i.test(message)),
      h.errors().join(' | '));
    check('the abandoned turn is traced',
      h.traces.some((trace) => trace.op === 'drive-turn-abandoned-by-relaunch'),
      h.traces.map((trace) => trace.op).join(','));
    check('the relaunch published idle before starting the new turn',
      h.statuses().slice(0, 3).join(',') === 'running,idle,running', h.statuses().join(','));

    // THE assertion. Under the leak, `awaitingResult` was 2 and the replacement's
    // single `result` took it to 1 — so this final idle never arrived and the
    // client sat on a spinner forever.
    check('the replacement turn CAN return the session to idle',
      await waitFor(() => h.statuses()[h.statuses().length - 1] === 'idle'),
      h.statuses().join(','));

    check('a cold start settles nothing and emits no spurious error',
      h.errors().filter((message) => /cancelled without a result/i.test(message)).length === 1,
      h.errors().join(' | '));
  } finally {
    h.cleanup();
  }
}

// ── 15. Demotion mid-turn settles and publishes ─────────────────────────────
//
// Same accounting hole, reached the other way: demotion kills the child to stop
// being a second writer, and killing it settles nothing by itself. A demoted
// connection stuck at Running is the worst of both — no writer left, and a UI
// that says a turn is still going.
{
  const h = newDrive({ init: INIT_EVENT, defaultTurn: [] });
  try {
    await h.connection.getHistory();
    await h.connection.sendPrompt({ text: 'ours, still running' });
    await waitFor(() => h.fake.stdin().length === 1);
    check('the turn is running when the takeover lands',
      h.statuses().join(',') === 'running', h.statuses().join(','));

    appendFileSync(h.transcriptPath, jsonl([userInputStep(80, 'typed in a terminal')]));
    await waitFor(() => h.connection.driving === false);
    await settle(250);

    check('the demotion settles the outstanding turn back to idle',
      h.statuses()[h.statuses().length - 1] === 'idle', h.statuses().join(','));
    check('the demotion says what happened to the turn that was running',
      h.errors().some((message) => /never reported its result/i.test(message)),
      h.errors().join(' | '));
    check('the abandoned turn is traced with its cause',
      h.traces.some((trace) => trace.op === 'drive-turn-abandoned-by-demotion'),
      h.traces.map((trace) => trace.op).join(','));
    check('the demotion still publishes the observing posture to everyone',
      h.messages.some((m) => m.type === 'metadata-update'
        && JSON.stringify((m as { value: unknown }).value).includes('observing')));
  } finally {
    h.cleanup();
  }
}

// ── 16. Ownership is proved by the consumed claim, never by matching text ────
//
// The removed fallback exonerated any tail prompt whose text matched one of the
// last 32 sends. Those strings outlived delivery, so a terminal typing a common
// prompt — "continue", "yes", "run the tests" — was waved through and two
// writers ran at once. The byte-fenced key claim is consumed exactly once, which
// is the whole difference between "our prompt arrived" and "that text arrived
// again".
{
  const h = newDrive({ init: INIT_EVENT, defaultTurn: [RESULT_OK] });
  try {
    await h.connection.getHistory();
    await h.connection.sendPrompt({ text: 'continue' });
    const minted = h.users().find((row) => row.text === 'continue')!;

    // OUR prompt's delivery: appended past the fence, so it claims the key.
    appendFileSync(h.transcriptPath, jsonl([userInputStep(90, 'continue')]));
    await settle(300);
    check('our own prompt delivering does NOT demote', h.connection.driving === true);

    // The key SURVIVES delivery: the mapper re-keys that transcript line to the
    // same key on every re-read, which is what keeps the user's words stable
    // across a reload. What must not survive is the minted row ALONGSIDE it —
    // once the transcript carries the prompt, the replay is its record, and a
    // still-pending row would put two copies under one key in one history.
    const replay = await h.connection.getHistory();
    const underTheKey = replay.filter(
      (m) => m.type === 'user-message' && (m as { key?: string }).key === minted.key,
    );
    check('the delivering line consumed the pending row, leaving ONE row under that key',
      underTheKey.length === 1, `${underTheKey.length} rows under ${minted.key}`);

    // The SAME words again, from a terminal. Nothing is left to claim.
    appendFileSync(h.transcriptPath, jsonl([userInputStep(91, 'continue')]));
    const demoted = await waitFor(() => h.connection.driving === false);
    check('the SAME text arriving a second time self-demotes (the claim was consumed)',
      demoted, `driving=${h.connection.driving}`);
    check('the demotion is stated', h.messages.some((m) => m.type === 'notice'));
  } finally {
    h.cleanup();
  }
}

// ── 17. The live stream retains nothing unbounded ───────────────────────────
{
  // A single stdout line larger than the reader's cap. The reader buffers until
  // a newline, so before the cap this grew broker memory by the whole line.
  const h = newDrive({ init: INIT_EVENT, defaultTurn: [RESULT_OK], oversizedLineBytes: 2 * 1024 * 1024 });
  try {
    await h.connection.getHistory();
    await h.connection.sendPrompt({ text: 'after the noise' });

    check('an oversized stream line is dropped rather than buffered',
      await waitFor(() => h.traces.some((trace) => trace.op === 'drive-stream-line-oversized')),
      h.traces.map((trace) => trace.op).join(','));
    check('dropping it is SAID, not swallowed',
      h.errors().some((message) => /too large to read/i.test(message)), h.errors().join(' | '));
    // Resync: the tail of the dropped line must not be reported as bad JSON, and
    // the next real line must parse.
    check('the reader resyncs at the next newline and the turn still completes',
      await waitFor(() => h.statuses()[h.statuses().length - 1] === 'idle'),
      h.statuses().join(','));
    check('the dropped line is not misreported as unparseable JSON',
      !h.traces.some((trace) => trace.op === 'drive-stream-unparseable'),
      h.traces.map((trace) => trace.op).join(','));
  } finally {
    h.cleanup();
  }
}

{
  // One step whose accumulated deltas pass the per-step cap. Each delta is a
  // legal line; it is the SUM that has to be bounded.
  const deltas: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 10; i += 1) {
    deltas.push({
      type: 'step_update',
      conversation_id: CONVERSATION,
      step_index: 500,
      step_type: 'agent_response',
      state: 'STEP_RUNNING',
      text_delta: 'w'.repeat(600 * 1024),
    });
  }
  deltas.push({
    type: 'step_update',
    conversation_id: CONVERSATION,
    step_index: 500,
    step_type: 'agent_response',
    state: 'STEP_DONE',
  });
  const h = newDrive({ init: INIT_EVENT, defaultTurn: [...deltas, RESULT_OK] });
  try {
    await h.connection.getHistory();
    await h.connection.sendPrompt({ text: 'stream a lot' });
    check('a step past the accumulated-text cap is capped',
      await waitFor(() => h.traces.some((trace) => trace.op === 'drive-step-text-oversized')),
      h.traces.map((trace) => trace.op).join(','));

    const flushed = await waitFor(() => h.messages.some(
      (m) => m.type === 'model-output' && String((m as { text?: string }).text).includes(AGY_STEP_TRUNCATION_NOTE),
    ));
    check('the capped step RENDERS its cap rather than ending mid-sentence', flushed,
      h.messages.filter((m) => m.type === 'model-output')
        .map((m) => String((m as { text?: string }).text).length).join(','));

    const output = h.messages.find(
      (m) => m.type === 'model-output' && String((m as { text?: string }).text).includes(AGY_STEP_TRUNCATION_NOTE),
    ) as { text?: string } | undefined;
    const emitted = (output?.text ?? '').length;
    const streamed = 10 * 600 * 1024;
    check('the capped step is far smaller than what was streamed at it',
      emitted > 0 && emitted < streamed,
      `${emitted} emitted of ${streamed} streamed`);
  } finally {
    h.cleanup();
  }
}

{
  // Many steps that never settle. The map is keyed by an index the CHILD picks,
  // so without a ceiling a misbehaving stream grows it forever.
  const opens: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 400; i += 1) {
    opens.push({
      type: 'step_update',
      conversation_id: CONVERSATION,
      step_index: 1000 + i,
      step_type: 'agent_response',
      state: 'STEP_RUNNING',
      text_delta: `step ${i}`,
    });
  }
  const h = newDrive({ init: INIT_EVENT, defaultTurn: [...opens, RESULT_OK] });
  try {
    await h.connection.getHistory();
    await h.connection.sendPrompt({ text: 'open many steps' });
    check('the open-step table is bounded',
      await waitFor(() => h.traces.some((trace) => trace.op === 'drive-open-steps-overflow')),
      h.traces.filter((trace) => trace.op === 'drive-open-steps-overflow').length.toString());
    // §9: collapse, never delete. An evicted step is FLUSHED, so what it had is
    // still rendered rather than silently discarded.
    check('an evicted step is flushed, not discarded',
      await waitFor(() => h.messages.filter((m) => m.type === 'model-output').length > 100),
      h.messages.filter((m) => m.type === 'model-output').length.toString());
    check('the turn still completes',
      await waitFor(() => h.statuses()[h.statuses().length - 1] === 'idle'), h.statuses().join(','));
  } finally {
    h.cleanup();
  }
}

// ── 18. A canceled step is TERMINAL, not running ────────────────────────────
//
// `isTerminalStreamState` accepted CANCEL, so the step flushed and nothing more
// would ever arrive for it — while the status mapper below it had no CANCEL arm
// and returned RUNNING. A step that is finished and says it is running is a
// spinner with nothing left to stop it.
{
  for (const state of ['STEP_CANCELED', 'STEP_CANCELLED', 'CANCEL', 'STEP_ABORTED', 'STEP_INTERRUPTED']) {
    check(`${state} is terminal AND maps to a terminal status`,
      isTerminalStreamState(state) && agyStepStatusForState(state) !== 'RUNNING',
      `terminal=${isTerminalStreamState(state)} status=${agyStepStatusForState(state)}`);
  }
  check('every terminal stream state maps to a non-RUNNING status',
    ['STEP_DONE', 'STEP_COMPLETE', 'STEP_ERROR', 'STEP_FAILED', 'STEP_CANCELED']
      .every((state) => !isTerminalStreamState(state) || agyStepStatusForState(state) !== 'RUNNING'));
  check('a still-running state is still RUNNING',
    agyStepStatusForState('STEP_RUNNING') === 'RUNNING' && !isTerminalStreamState('STEP_RUNNING'));
  check('a cancel is not painted as a host failure',
    agyStepStatusForState('STEP_CANCELED') === AGY_CANCELED_STATUS
    && agyStepStatusForState('STEP_ERROR') === 'ERROR');
  check('the canceled status reads as interrupted even with a live child',
    agyCommandState(AGY_CANCELED_STATUS, true) === 'interrupted'
    && agyCommandState('RUNNING', true) === 'running',
    `${agyCommandState(AGY_CANCELED_STATUS, true)} vs ${agyCommandState('RUNNING', true)}`);
}

{
  // The fixture the finding asked for. It lives in the shared wire fixture under
  // `canceledStepUpdates`, flagged CONSTRUCTED rather than measured: only
  // STEP_DONE was ever captured, so this pair is a probe for the invariant, not a
  // recording of a 1.1.17 envelope.
  const h = newDrive({
    init: INIT_EVENT,
    defaultTurn: [
      ...FIXTURE.streamEvents.canceledStepUpdates.map((event) => ({ type: 'step_update', ...event })),
      RESULT_OK,
    ],
  });
  try {
    await h.connection.getHistory();
    await h.connection.sendPrompt({ text: 'cancel me' });
    check('a canceled step flushes exactly once, carrying what it had',
      await waitFor(() => h.messages.some(
        (m) => m.type === 'model-output' && String((m as { text?: string }).text).includes('half an answ'),
      )),
      h.messages.map((m) => m.type).join(','));
    check('a canceled step does not leave the turn running',
      await waitFor(() => h.statuses()[h.statuses().length - 1] === 'idle'), h.statuses().join(','));
    check('a cancel is not reported as an error',
      !h.errors().some((message) => /cancel/i.test(message)), h.errors().join(' | '));
  } finally {
    h.cleanup();
  }
}

// ── 19. Retirement is source-independent; only demotion is tail-only ────────
//
// The owner's repro. With NO subscriber there is no tail, so the delivering line
// is first seen by the REPLAY inside `getHistory()`. The mapper consumes the
// byte-fenced link on that path too — it does not care which path admitted the
// line — but the retirement used to sit behind a `source !== 'tail'` early
// return, so `pendingRows` kept the row and `extraHistoryRows()` appended it
// again: two identical rows under one key, in one history payload.
{
  const h = newDrive({ init: INIT_EVENT, defaultTurn: [RESULT_OK] }, { noSubscribe: true });
  try {
    await h.connection.getHistory();
    await h.connection.sendPrompt({ text: 'delivered with nobody listening' });
    const pending = (await h.connection.getHistory()).filter(
      (m) => m.type === 'user-message'
        && String((m as { text: string }).text) === 'delivered with nobody listening',
    );
    check('before delivery the minted row stands in for the prompt',
      pending.length === 1, `${pending.length} rows`);
    const key = (pending[0] as { key?: string }).key!;

    // agy writes the line. Nothing is subscribed, so only a replay will see it.
    appendFileSync(h.transcriptPath, jsonl([userInputStep(95, 'delivered with nobody listening')]));

    const replay = await h.connection.getHistory();
    const rows = replay.filter((m) => m.type === 'user-message' && (m as { key?: string }).key === key);
    check('an unsubscribed delivery leaves EXACTLY ONE row under the key',
      rows.length === 1, `${rows.length} rows under ${key}`);
    check('the surviving row still carries the words the user typed',
      String((rows[0] as { text?: string })?.text) === 'delivered with nobody listening',
      JSON.stringify(rows.map((m) => (m as { text?: string }).text)));

    // Re-reading must stay idempotent: a second replay re-keys the same line to
    // the same key rather than minting a second row.
    const again = await h.connection.getHistory();
    check('a second replay is still exactly one row under that key',
      again.filter((m) => m.type === 'user-message' && (m as { key?: string }).key === key).length === 1);

    // Retiring on the replay path must NOT have made replays demote: every user
    // line in a replay is history, so an ordinary attach to a used conversation
    // would otherwise demote itself instantly.
    check('a replay containing prompts we never sent does NOT demote',
      h.connection.driving === true, `driving=${h.connection.driving}`);
  } finally {
    h.cleanup();
  }
}

{
  // The other half of the split: a foreign line arriving LIVE still demotes.
  const h = newDrive({ init: INIT_EVENT, defaultTurn: [RESULT_OK] });
  try {
    await h.connection.getHistory();
    appendFileSync(h.transcriptPath, jsonl([userInputStep(96, 'typed in a terminal')]));
    check('a foreign line on the TAIL still demotes after the retirement change',
      await waitFor(() => h.connection.driving === false), `driving=${h.connection.driving}`);
  } finally {
    h.cleanup();
  }
}

// ── 20. The step-text cap is a BYTE budget, not a code-unit one ─────────────
{
  // A CJK body: 3 UTF-8 bytes per character, 1 UTF-16 code unit each. Against a
  // `.length` check this passed at ~3× the stated budget.
  const cjk = '数据处理与分析'.repeat(40_000);
  const deltas: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 6; i += 1) {
    deltas.push({
      type: 'step_update',
      conversation_id: CONVERSATION,
      step_index: 700,
      step_type: 'agent_response',
      state: 'STEP_RUNNING',
      text_delta: cjk,
    });
  }
  deltas.push({
    type: 'step_update',
    conversation_id: CONVERSATION,
    step_index: 700,
    step_type: 'agent_response',
    state: 'STEP_DONE',
  });
  const h = newDrive({ init: INIT_EVENT, defaultTurn: [...deltas, RESULT_OK] });
  try {
    await h.connection.getHistory();
    await h.connection.sendPrompt({ text: 'stream multibyte' });
    const arrived = await waitFor(() => h.messages.some(
      (m) => m.type === 'model-output' && String((m as { text?: string }).text).includes(AGY_STEP_TRUNCATION_NOTE),
    ));
    check('a multibyte step past the cap is truncated', arrived,
      h.traces.filter((t) => t.op === 'drive-step-text-oversized').length.toString());

    const output = h.messages.find(
      (m) => m.type === 'model-output' && String((m as { text?: string }).text).includes(AGY_STEP_TRUNCATION_NOTE),
    ) as { text?: string } | undefined;
    const body = (output?.text ?? '').replace(`\n\n${AGY_STEP_TRUNCATION_NOTE}`, '');
    const bytes = Buffer.byteLength(body, 'utf8');
    check('the CJK body lands within the BYTE budget, not 3x over it',
      bytes <= AGY_MAX_STEP_TEXT_BYTES,
      `${bytes} bytes vs cap ${AGY_MAX_STEP_TEXT_BYTES} (${body.length} code units)`);
    check('the truncated body is still valid UTF-8 (no split code point)', isValidUtf8(body));
  } finally {
    h.cleanup();
  }
}

{
  // Emoji are the surrogate-pair case: a code-unit cut can land between halves.
  // Every budget from 1 to 64, so a cut is forced at each position inside the
  // 4-byte emoji, the 3-byte CJK character and the 1-byte ASCII one.
  const body = '🙂中a'.repeat(50);
  let allWithin = true;
  let allValid = true;
  let worst = '';
  for (let cap = 1; cap <= 64; cap += 1) {
    const cut = truncateToUtf8Bytes(body, cap);
    const bytes = Buffer.byteLength(cut.text, 'utf8');
    if (bytes > cap) { allWithin = false; worst = `cap ${cap} produced ${bytes} bytes`; }
    if (!isValidUtf8(cut.text)) { allValid = false; worst = `cap ${cap} produced invalid UTF-8`; }
  }
  check('every budget from 1 to 64 bytes stays within budget', allWithin, worst);
  check('every budget from 1 to 64 bytes yields valid UTF-8 (never a split pair)', allValid, worst);
  check('a 7-byte budget fits the emoji plus the CJK character and stops',
    truncateToUtf8Bytes(body, 7).text === '🙂中',
    JSON.stringify(truncateToUtf8Bytes(body, 7).text));
  check('a 3-byte budget cannot fit the 4-byte emoji and yields nothing',
    truncateToUtf8Bytes(body, 3).text === '', JSON.stringify(truncateToUtf8Bytes(body, 3).text));
  check('a body already inside its budget is returned untouched',
    truncateToUtf8Bytes('hello', 64).text === 'hello'
    && truncateToUtf8Bytes('hello', 64).truncated === false);
}

// ── 21. The stdout framer bounds a line however it is chunked ───────────────
{
  // The defect: the cap was checked only on the unterminated remainder, so an
  // over-cap line that arrived WITH its newline was framed and handled whole.
  // Both arrival shapes must now be refused identically.
  const bytes = (text: string): Buffer => Buffer.from(text, 'utf8');

  const framer = new AgyLineFramer(16);
  const wholeLine = framer.push(bytes('x'.repeat(40) + '\n'));
  check('an over-cap line arriving complete in ONE chunk is dropped',
    wholeLine.length === 1 && wholeLine[0]!.dropped && wholeLine[0]!.reason === 'oversized'
    && wholeLine[0]!.bytes === 40,
    JSON.stringify(wholeLine));

  const split = new AgyLineFramer(16);
  const a = split.push(bytes('y'.repeat(10)));
  const b = split.push(bytes('y'.repeat(10)));
  const c = split.push(bytes('y'.repeat(10) + '\n'));
  check('an over-cap line SPLIT across chunks is dropped too',
    a.length === 0
    && b.some((f) => f.dropped && f.reason === 'oversized')
    && c.every((f) => f.dropped),
    `${JSON.stringify(a)} | ${JSON.stringify(b)} | ${JSON.stringify(c)}`);

  const resync = new AgyLineFramer(16);
  resync.push(bytes('z'.repeat(40)));
  const after = resync.push(bytes('tail-of-it\n{"ok":1}\n'));
  check('the framer resyncs and delivers the NEXT line intact',
    after.filter((f) => !f.dropped).map((f) => f.text).join('') === '{"ok":1}',
    JSON.stringify(after));

  const ok = new AgyLineFramer(1024);
  check('ordinary lines pass through unchanged',
    ok.push(bytes('{"a":1}\n{"b":2}\n')).map((f) => f.text).join('|') === '{"a":1}|{"b":2}');

  // Byte-aware, not code-unit-aware: 7 CJK characters are 21 UTF-8 bytes.
  const multibyte = new AgyLineFramer(20);
  const cjkFrames = multibyte.push(bytes('数据处理与分析\n'));
  check('a line under the code-unit count but OVER the byte cap is dropped',
    cjkFrames.length === 1 && cjkFrames[0]!.dropped,
    `${'数据处理与分析'.length} code units, ${Buffer.byteLength('数据处理与分析', 'utf8')} bytes`);

  // Offsets stay honest across a drop, or the drive's byte fence would drift.
  const offsets = new AgyLineFramer(8);
  const mixed = offsets.push(bytes('ab\n' + 'c'.repeat(30) + '\nde\n'));
  check('a dropped frame still reports the bytes it occupied',
    mixed.map((f) => f.bytes).join(',') === '2,30,2', JSON.stringify(mixed.map((f) => f.bytes)));

  // ── The owner's exact repro, at the framer ──────────────────────────────
  //
  // An 8-byte line, `aaaa界\n`, cut INSIDE 界 (3 bytes: E7 95 8C) by a range
  // boundary. Decoding each range on its own gave "aaaa�" and "��\n",
  // and re-encoding those charged 7 + 7 = 14 bytes for an 8-byte line.
  const line = Buffer.from('aaaa界\n', 'utf8');
  check('the repro line really is 8 bytes with the cut inside the character',
    line.length === 8 && (line[5]! & 0xc0) === 0x80, `${line.length} bytes`);

  const straddle = new AgyLineFramer(64);
  const firstHalf = straddle.push(line.subarray(0, 5));
  const secondHalf = straddle.push(line.subarray(5));
  check('a character split across ranges yields NO frame until it is whole',
    firstHalf.length === 0, JSON.stringify(firstHalf));
  check('the reassembled line decodes intact — no replacement characters',
    secondHalf.length === 1
    && secondHalf[0]!.text === 'aaaa界'
    && !secondHalf[0]!.text.includes('�'),
    JSON.stringify(secondHalf));
  check('it frames as 7 content bytes + newline = 8, not 14',
    secondHalf[0]!.bytes + 1 === 8, `${secondHalf[0]!.bytes + 1} bytes charged`);

  // Every cut position inside a 4-byte emoji and a 3-byte character.
  const mixedLine = Buffer.from('a🙂b界c\n', 'utf8');
  let allIntact = true;
  for (let cut = 0; cut <= mixedLine.length; cut += 1) {
    const f = new AgyLineFramer(64);
    const produced = [...f.push(mixedLine.subarray(0, cut)), ...f.push(mixedLine.subarray(cut))];
    const kept = produced.filter((frame) => !frame.dropped);
    if (kept.length !== 1 || kept[0]!.text !== 'a🙂b界c' || kept[0]!.bytes !== mixedLine.length - 1) {
      allIntact = false;
    }
  }
  check('a line stays intact and correctly measured for EVERY cut position',
    allIntact, `${mixedLine.length - 1} content bytes`);
}

// ── 22. Ownership survives a character split across a drain boundary ────────
//
// The consequence the finding is really about. The byte-offset fence decides
// whether a transcript line delivers a prompt THIS connection sent. When the
// per-drain read cut a multibyte character, both halves decoded to U+FFFD, so
// the delivering line's text no longer matched what we sent — the claim failed,
// the line looked like somebody else's write, and the connection demoted itself
// off a conversation it legitimately owned.
{
  const PROMPT = '继续处理这个问题';
  // Derive the drain bound from the line that must be cut, so the boundary lands
  // inside the prompt's own CJK rather than somewhere incidental.
  const delivering = Buffer.from(jsonl([userInputStep(120, PROMPT)]), 'utf8');
  const cjkAt = delivering.indexOf(Buffer.from('继', 'utf8'));
  const DRAIN = cjkAt + 1;

  const h = newDrive({ init: INIT_EVENT, defaultTurn: [RESULT_OK] }, { tailReadMaxBytes: DRAIN });
  try {
    check('the drain boundary falls inside the prompt’s own multibyte character',
      cjkAt > 0 && (delivering[DRAIN]! & 0xc0) === 0x80,
      `drain=${DRAIN}, byte=0x${delivering[DRAIN]!.toString(16)}`);

    await h.connection.getHistory();
    await h.connection.sendPrompt({ text: PROMPT });
    const minted = h.users().find((row) => row.text === PROMPT)!;
    check('the prompt minted a fenced pending row', minted?.key !== undefined, JSON.stringify(minted));

    // agy writes the delivering line. The tail will cut it mid-character.
    appendFileSync(h.transcriptPath, delivering);

    // Let the tail drain across the boundary and settle either way — a demotion
    // is the failure mode under test, so waiting on "still driving" would pass
    // vacuously by timing out.
    await settle(600);

    check('(3) the fenced key claim still lands on the delivering line',
      h.connection.driving === true, `driving=${h.connection.driving}`);
    check('the split prompt was NOT mistaken for a foreign write',
      !h.messages.some((m) => m.type === 'notice'
        && /taken over in a terminal/.test((m as { message: string }).message)),
      h.messages.filter((m) => m.type === 'notice').length.toString());

    // And the row is not duplicated: the claim consumed the pending row.
    const replay = await h.connection.getHistory();
    const rows = replay.filter((m) => m.type === 'user-message'
      && String((m as { text: string }).text).includes(PROMPT));
    check('exactly one row carries the prompt after delivery',
      rows.length === 1, `${rows.length} rows`);
    check('the delivered text is intact — no replacement characters',
      rows.length === 1 && !String((rows[0] as { text: string }).text).includes('�'),
      JSON.stringify(rows.map((m) => (m as { text: string }).text)));
  } finally {
    h.cleanup();
  }
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
