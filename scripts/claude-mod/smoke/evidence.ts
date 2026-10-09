/**
 * What the tier-2 smoke accepts as proof that a step happened, as pure functions.
 *
 * The smoke itself spends model turns, so everything that decides "did this happen" lives here,
 * where `selftest.ts` can run it against recorded rows and events with no Claude at all. A step
 * proves itself from the session's transcript rows or from the broker's own events, never from
 * the pane: a pane is what was on screen at one instant of scrolling, and the dialog text a
 * previous step left behind is still on it. Two pane checks were green for exactly that reason.
 *
 * Every transcript check is keyed on the step's own probe file name, so a row the previous step
 * wrote can never stand in for this step's.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

export interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  text?: string;
  is_error?: boolean;
}

export interface TranscriptRow {
  type?: string;
  isMeta?: boolean;
  /** A subagent's row. Its mode and its prompts are not the session's. */
  isSidechain?: boolean;
  /** On a prompt row and on the title block's `permission-mode` row: the mode Claude was in. */
  permissionMode?: string;
  message?: { role?: string; content?: unknown };
  /** The tool's own result object, recorded beside the text rendered from it. */
  toolUseResult?: unknown;
}

/** One broker event as the harness records it: `ModSocketEvent`, structurally. */
export interface BrokerEvent {
  sessionId: string;
  kind: string;
  requestId?: string;
  detail?: Record<string, unknown>;
}

/** A broker event with the moment the harness saw it, which is what a "within N s" rule reads. */
export interface TimedBrokerEvent extends BrokerEvent {
  at: number;
}

export function parseTranscript(text: string): TranscriptRow[] {
  const out: TranscriptRow[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line) as TranscriptRow);
    } catch {
      // A half-written final line is normal while the session lives; it is not a parse failure.
    }
  }
  return out;
}

export function readTranscript(path: string | undefined): TranscriptRow[] {
  if (!path || !existsSync(path)) return [];
  return parseTranscript(readFileSync(path, 'utf8'));
}

export function blocksOf(row: TranscriptRow): ContentBlock[] {
  const content = row.message?.content;
  if (Array.isArray(content)) return content as ContentBlock[];
  // A user row can carry its text as a bare string instead of a block list, and a prompted turn
  // is written that way. Returning [] here hid the one row the prompt step exists to find: the
  // PONG turn was in the transcript and the check said it was not.
  if (typeof content === 'string') return content.length > 0 ? [{ type: 'text', text: content }] : [];
  return [];
}

export function blockText(block: ContentBlock): string {
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) {
    return (block.content as ContentBlock[]).map((part) => part.text ?? '').join(' ');
  }
  return block.text ?? '';
}

/** One tool call the transcript recorded, with its input and, once it has one, its result. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: { text: string; isError: boolean };
}

export function toolCalls(rows: readonly TranscriptRow[]): ToolCall[] {
  const calls = new Map<string, ToolCall>();
  for (const row of rows) {
    if (row.message?.role !== 'assistant') continue;
    for (const block of blocksOf(row)) {
      if (block.type === 'tool_use' && block.id) {
        calls.set(block.id, { id: block.id, name: block.name ?? '', input: block.input ?? {} });
      }
    }
  }
  for (const row of rows) {
    if (row.message?.role !== 'user') continue;
    for (const block of blocksOf(row)) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue;
      const call = calls.get(block.tool_use_id);
      if (call) call.result = { text: blockText(block), isError: block.is_error === true };
    }
  }
  return [...calls.values()];
}

/** One entry per tool result the transcript recorded, with the name of the call it answers. */
export function toolOutcomes(rows: readonly TranscriptRow[]): { id: string; name: string; text: string; isError: boolean }[] {
  return toolCalls(rows)
    .filter((call) => call.result !== undefined)
    .map((call) => ({ id: call.id, name: call.name, text: call.result!.text, isError: call.result!.isError }));
}

export function assistantText(rows: readonly TranscriptRow[]): string {
  return rows
    .filter((row) => row.message?.role === 'assistant')
    .flatMap((row) => blocksOf(row))
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join(' \n');
}

/** Text the session records as a user message, which is what `$.prompt.submit` must produce. */
export function userTexts(rows: readonly TranscriptRow[]): string[] {
  return rows
    .filter((row) => row.message?.role === 'user')
    .flatMap((row) => blocksOf(row))
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '');
}

/**
 * The answers an AskUserQuestion call came back with, as the session recorded them.
 *
 * Read from the tool's own result object (`toolUseResult.answers`), never from the sentence Claude
 * renders from it: that sentence quotes the answer inside quotes of its own, so a label holding a
 * quote or a comma cannot be read back out of it. Keyed on the question, so an earlier step's
 * answer to another question never stands in for this one.
 */
export function questionAnswers(rows: readonly TranscriptRow[], question: string): Record<string, string> | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const result = rows[index]!.toolUseResult;
    const answers = result && typeof result === 'object' ? (result as { answers?: unknown }).answers : undefined;
    if (answers && typeof answers === 'object' && !Array.isArray(answers) && question in answers) {
      return answers as Record<string, string>;
    }
  }
  return undefined;
}

/** The latest Write call aimed at a file of this name: the step's own call, never a neighbour's. */
export function writeCallFor(rows: readonly TranscriptRow[], fileName: string): ToolCall | undefined {
  return toolCalls(rows)
    .filter((call) => call.name === 'Write' && typeof call.input.file_path === 'string'
      && basename(call.input.file_path) === fileName)
    .at(-1);
}

export interface StepVerdict {
  ok: boolean;
  detail: string;
}

/**
 * Claude's own dialog decided this step's Write, and the human declined it there.
 *
 * Button 3 hands the call back to Claude, which puts its own permission dialog up; the smoke then
 * declines it with Escape. The only record of that dialog having been the thing that decided is
 * the call's result in the transcript: an error result on this step's Write, with the file not
 * written. The pane check this replaces matched the previous step's dialog text.
 */
export function writeDeclinedByClaude(rows: readonly TranscriptRow[], fileName: string, writtenOnDisk: boolean): StepVerdict {
  const call = writeCallFor(rows, fileName);
  if (!call) return { ok: false, detail: `no Write call for ${fileName} in the transcript` };
  if (!call.result) return { ok: false, detail: `the Write call for ${fileName} (${call.id}) has no result yet` };
  if (!call.result.isError) return { ok: false, detail: `the Write call for ${fileName} succeeded: ${call.result.text.slice(0, 120)}` };
  if (writtenOnDisk) return { ok: false, detail: `the Write call for ${fileName} is recorded as declined, but the file exists` };
  return { ok: true, detail: `declined in Claude's own dialog: ${call.result.text.slice(0, 120)}` };
}

/**
 * Claude settled this step's Write by itself: its classifier ran it, or its own dialog asked the
 * human and was declined. Either way the call has a result, and the result agrees with the disk.
 */
export function writeSettledByClaude(rows: readonly TranscriptRow[], fileName: string, writtenOnDisk: boolean): StepVerdict & { how: 'ran' | 'declined' | 'none' } {
  const call = writeCallFor(rows, fileName);
  if (!call || !call.result) {
    return { ok: false, how: 'none', detail: call ? `the Write call for ${fileName} has no result` : `no Write call for ${fileName} in the transcript` };
  }
  if (!call.result.isError) {
    return writtenOnDisk
      ? { ok: true, how: 'ran', detail: `Claude ran it: ${call.result.text.slice(0, 120)}` }
      : { ok: false, how: 'ran', detail: `the Write for ${fileName} succeeded in the transcript but the file is not there` };
  }
  return writtenOnDisk
    ? { ok: false, how: 'declined', detail: `the Write for ${fileName} is recorded as an error but the file exists` }
    : { ok: true, how: 'declined', detail: `Claude declined it itself: ${call.result.text.slice(0, 120)}` };
}

/**
 * The mod reported, over its event leg, that the human chose Claude's own dialog for this hold.
 *
 * Request ids restart in every process, so the caller passes only the events that arrived after
 * the step began, and the session that raised the hold.
 */
export function userCancelSeen(events: readonly BrokerEvent[], sessionId: string, requestId: string): boolean {
  return events.some((event) => event.kind === 'user-cancel' && event.sessionId === sessionId && event.requestId === requestId);
}

/**
 * A Stop the app sent while this step's call was held ended the turn within `withinMs`.
 *
 * The witness is the mod's `turn.complete` for the session: the first one the broker saw after the
 * Stop went out. A turn whose tool call is held on the app cannot end by itself, so one that soon is
 * the Stop's doing; the caller checks on its own that the held call never ran. One from before the
 * Stop is the previous step's turn, and one from another session is another terminal's.
 */
export function stopEndedTurn(events: readonly TimedBrokerEvent[], sessionId: string, sentAt: number, withinMs: number): StepVerdict & { afterMs?: number } {
  const ended = events.find((event) => event.kind === 'turn.complete' && event.sessionId === sessionId && event.at >= sentAt);
  if (!ended) return { ok: false, detail: `no turn.complete for ${sessionId} after the Stop` };
  const afterMs = ended.at - sentAt;
  const turn = typeof ended.detail?.turnId === 'string' ? ended.detail.turnId : '(no id)';
  return afterMs <= withinMs
    ? { ok: true, afterMs, detail: `turn ${turn} ended ${afterMs} ms after the Stop` }
    : { ok: false, afterMs, detail: `turn ${turn} ended ${afterMs} ms after the Stop, over ${withinMs} ms` };
}

/**
 * The first thing anyone said after `stepPrompt`: the next user row with text in it.
 *
 * Tool results are user rows too, but they carry no text block, and a row Claude marks `isMeta` is
 * its own context rather than words somebody sent; neither is a turn of the conversation.
 */
export function nextUserTextAfter(rows: readonly TranscriptRow[], stepPrompt: string): string | undefined {
  const at = rows.findIndex((row) => row.message?.role === 'user' && !row.isMeta && userTexts([row]).some((text) => text.includes(stepPrompt)));
  if (at < 0) return undefined;
  for (const row of rows.slice(at + 1)) {
    if (row.message?.role !== 'user' || row.isMeta) continue;
    const texts = userTexts([row]);
    if (texts.length > 0) return texts.join('\n');
  }
  return undefined;
}

/**
 * The prompt the app sent while this step's card was open was delivered, as the next user row.
 *
 * A plugin's prompt runs once the session is idle (build: `$.prompt.submit` "runs once it is
 * idle"), so the held turn's tool result and the model's rows come between, and nothing else
 * anybody typed. A prompt found earlier, or after some other user row, is not this delivery.
 */
export function appPromptIsNextUserRow(rows: readonly TranscriptRow[], stepPrompt: string, appPrompt: string): StepVerdict {
  const next = nextUserTextAfter(rows, stepPrompt);
  if (next === undefined) {
    return { ok: false, detail: rows.some((row) => userTexts([row]).some((text) => text.includes(stepPrompt))) ? 'no user row after the step\'s prompt yet' : 'the step\'s own prompt is not in the transcript' };
  }
  return next.includes(appPrompt)
    ? { ok: true, detail: `the next user row is the app's prompt: ${next.slice(0, 120)}` }
    : { ok: false, detail: `the next user row is something else: ${next.slice(0, 120)}` };
}

/** The broker's log line for one refused request, as `ModSocketServer` writes it. */
const REFUSED_LINE = /^mod socket refused (\S+): (\S+)/;

/**
 * A Claude cosyncing itself started (`COSYNCING_SPAWNED=1`) said nothing to the broker: nothing
 * registered under its session id, and the broker logged no refused request while it ran. Before
 * the fix it registered, was refused as `broker_child`, and the log said so on every retry.
 */
export function spawnedStayedSilent(registers: readonly { sessionId: string }[], logWhileItRan: readonly string[], sessionId: string): StepVerdict {
  const registered = registers.some((row) => row.sessionId === sessionId);
  const refused = logWhileItRan.filter((line) => REFUSED_LINE.test(line));
  if (registered) return { ok: false, detail: `${sessionId} registered with the broker` };
  if (refused.length > 0) return { ok: false, detail: `the broker refused ${refused.length} request(s): ${refused[0]!.slice(0, 120)}` };
  return { ok: true, detail: `no registration for ${sessionId}, and no refused request in ${logWhileItRan.length} log lines` };
}

/**
 * The control for the run above: the same launch without `COSYNCING_SPAWNED` is a broker child the
 * broker refuses, and refuses once. Zero would mean the mod never loaded headless, which would make
 * the silent run prove nothing; more than one would mean the terminal kept dialling after a
 * refusal that cannot change.
 */
export function brokerChildRefusedOnce(logWhileItRan: readonly string[]): StepVerdict {
  const refused = logWhileItRan.filter((line) => REFUSED_LINE.exec(line)?.[1] === 'register');
  const children = refused.filter((line) => REFUSED_LINE.exec(line)?.[2] === 'broker_child');
  if (children.length === 1 && refused.length === 1) return { ok: true, detail: refused[0]!.slice(0, 140) };
  return { ok: false, detail: `${children.length} broker_child refusal(s) among ${refused.length} refused register(s): ${refused.join(' / ').slice(0, 200)}` };
}

/** What `~/.claude.json` says about projects: the keys, and which of them carry trust. */
export interface ClaudeConfigSnapshot {
  keys: string[];
  trusted: string[];
  problem: string;
}

/**
 * The run's marks on the operator's `~/.claude.json`, as the checks the run must pass.
 *
 * A trust flag is a standing decision about the operator's machine. A new project key is a smaller
 * mark, but it is still a write to their file that outlives the run, and the rule the harness was
 * built on is that the set of keys is the same before and after. It used to be logged and passed;
 * now any key added or removed fails the run.
 */
export function configAuditVerdicts(before: ClaudeConfigSnapshot, after: ClaudeConfigSnapshot): { name: string; ok: boolean; detail: string }[] {
  const gained = after.trusted.filter((key) => !before.trusted.includes(key));
  const added = after.keys.filter((key) => !before.keys.includes(key));
  const removed = before.keys.filter((key) => !after.keys.includes(key));
  return [
    {
      name: 'the run wrote no trust into ~/.claude.json',
      ok: gained.length === 0,
      detail: gained.length === 0 ? `${after.keys.length} project keys, unchanged trust` : `now trusted: ${gained.join(', ')}`,
    },
    {
      name: 'the run left the project keys in ~/.claude.json as it found them',
      ok: added.length === 0 && removed.length === 0,
      detail: added.length === 0 && removed.length === 0
        ? `${before.keys.length} keys before and after`
        : `added: ${added.join(', ') || 'none'}; removed: ${removed.join(', ') || 'none'}`,
    },
    { name: '~/.claude.json still parses', ok: after.problem.length === 0, detail: after.problem },
  ];
}

/**
 * One frame the synced seat sent, as a watching app's Hub would broadcast it, with the moment the
 * harness saw it. Typed loosely on purpose: the rules below read a handful of fields, and the
 * seat's frames are the adapter's `AgentMessage`s.
 */
export interface SeatFrame {
  at: number;
  message: {
    type: string;
    status?: string;
    key?: string;
    requestId?: string;
    answers?: unknown;
    releaseReason?: string;
    decidedBy?: string;
    readOnly?: boolean;
    answerInTerminal?: boolean;
    blocking?: boolean;
    /** A `metadata-update`'s payload: for `key: sessionInfo`, the fields of the row that moved. */
    value?: unknown;
  };
}

/**
 * A Stop the app sent, with no call held, left the session idle within `withinMs` of the mod's
 * `turn.complete`.
 *
 * Idle is what the seat told the app: its first `status: idle` after the Stop, and a turn summary
 * closed after it. The witness is never the pane. The window starts at `turn.complete`, not at the
 * Stop, because that is the moment the terminal said the turn was over; before the fix the row
 * stayed Working until the next prompt fenced the turn. A `status: running` after the idle one
 * means the session was not left idle.
 */
export function appStopLeftIdle(frames: readonly SeatFrame[], events: readonly TimedBrokerEvent[], sessionId: string, sentAt: number, withinMs: number): StepVerdict & { idleAfterMs?: number } {
  const ended = events.find((event) => event.kind === 'turn.complete' && event.sessionId === sessionId && event.at >= sentAt && event.detail?.agentId === undefined);
  if (!ended) return { ok: false, detail: `no turn.complete for ${sessionId} after the Stop` };
  const after = frames.filter((frame) => frame.at >= sentAt);
  const idle = after.find((frame) => frame.message.type === 'status' && frame.message.status === 'idle');
  if (!idle) return { ok: false, detail: `the seat never said idle after the Stop (${after.length} frames)` };
  const idleAfterMs = idle.at - ended.at;
  const closed = after.find((frame) => frame.message.type === 'run-summary' && frame.message.status !== undefined && frame.message.status !== 'running');
  if (!closed) return { ok: false, idleAfterMs, detail: 'no turn summary closed after the Stop' };
  const rerun = after.find((frame) => frame.at > idle.at && frame.message.type === 'status' && frame.message.status === 'running');
  if (rerun) return { ok: false, idleAfterMs, detail: `the seat said running again ${rerun.at - idle.at} ms after it said idle` };
  return idleAfterMs <= withinMs
    ? { ok: true, idleAfterMs, detail: `idle ${idleAfterMs} ms after turn.complete; the turn closed ${closed.message.status}` }
    : { ok: false, idleAfterMs, detail: `idle ${idleAfterMs} ms after turn.complete, over ${withinMs} ms` };
}

/** A resync's history draws the newest turn as not running: what a reload or a reconnect shows. */
export function resyncShowsNotRunning(history: readonly { type: string; status?: string; key?: string }[]): StepVerdict {
  const newest = [...history].reverse().find((message) => message.type === 'run-summary');
  if (!newest) return { ok: false, detail: 'the resync carried no turn summary' };
  return newest.status === 'running'
    ? { ok: false, detail: `the resync draws ${newest.key ?? 'the newest turn'} as running` }
    : { ok: true, detail: `the resync draws ${newest.key ?? 'the newest turn'} as ${newest.status}` };
}

/**
 * The app saw this question as one card, under the call's own `tool_use` id.
 *
 * The transcript's copy and the held copy of one AskUserQuestion share Claude's call id; a card
 * under any other id, or two ids, is two cards for one question in front of the person.
 */
export function oneQuestionCard(frames: readonly SeatFrame[], toolUseId: string): StepVerdict {
  const ids = [...new Set(frames.filter((frame) => frame.message.type === 'question-request').map((frame) => frame.message.requestId ?? ''))];
  if (ids.length === 1 && ids[0] === toolUseId) return { ok: true, detail: `one card, ${toolUseId}` };
  return { ok: false, detail: `question card ids ${JSON.stringify(ids)}, the call is ${toolUseId}` };
}

/**
 * The question's card closed carrying the answer the app sent, row for row.
 *
 * Every resolution that names an answer has to name this one; at least one has to. A resolution
 * with no answer is allowed beside it, because a card can close before the answer is read back.
 */
export function questionResolvedWith(frames: readonly SeatFrame[], requestId: string, rows: readonly (readonly string[])[]): StepVerdict {
  const resolutions = frames.filter((frame) => frame.message.type === 'question-resolved' && frame.message.requestId === requestId);
  if (resolutions.length === 0) return { ok: false, detail: `no question-resolved for ${requestId}` };
  const want = JSON.stringify(rows);
  const said = resolutions.filter((frame) => frame.message.answers !== undefined).map((frame) => JSON.stringify(frame.message.answers));
  if (said.length === 0) return { ok: false, detail: `${resolutions.length} resolution(s), none carrying the answer` };
  const wrong = said.filter((answers) => answers !== want);
  return wrong.length === 0
    ? { ok: true, detail: `${said.length} resolution(s) carried ${want}` }
    : { ok: false, detail: `a resolution carried ${wrong[0]}, the app sent ${want}` };
}

/**
 * A card the terminal took back closed saying so: `releaseReason: band`, which the app draws as
 * "You answered it in your terminal." Bare, it read "Resolved in another client."
 */
export function closedByTerminal(frames: readonly SeatFrame[], cardId: string): StepVerdict {
  const closes = frames.filter((frame) => frame.message.type === 'permission-resolved' && frame.message.requestId === cardId);
  if (closes.length === 0) return { ok: false, detail: `no permission-resolved for ${cardId}` };
  const last = closes.at(-1)!.message;
  return last.releaseReason === 'band'
    ? { ok: true, detail: `closed with releaseReason band` }
    : { ok: false, detail: `closed with ${JSON.stringify({ releaseReason: last.releaseReason ?? null, decidedBy: last.decidedBy ?? null })}` };
}

/**
 * How long after the mod's `turn.complete` the transcript closed each turn: the gap the P-2 grace
 * must sit above.
 *
 * Each main-loop `turn.complete` is paired with the turn summary the seat closed nearest to it. A
 * `done` close came from the transcript's own end row; a `cancelled` one, with no `done` near it,
 * is the grace settling a turn the transcript had not closed yet, and is reported as such, because
 * a grace below the real gap closes normal turns as stopped. A negative gap means the row landed
 * first.
 */
export function turnEndGaps(events: readonly TimedBrokerEvent[], frames: readonly SeatFrame[], sessionId: string, windowMs = 10_000): { turnId: string; closedBy: 'transcript' | 'grace' | 'none'; gapMs?: number }[] {
  const closes = frames.filter((frame) => frame.message.type === 'run-summary' && (frame.message.status === 'done' || frame.message.status === 'cancelled'));
  return events
    .filter((event) => event.kind === 'turn.complete' && event.sessionId === sessionId && event.detail?.agentId === undefined)
    .map((event) => {
      const turnId = typeof event.detail?.turnId === 'string' ? event.detail.turnId : '(no id)';
      const near = closes.filter((frame) => Math.abs(frame.at - event.at) <= windowMs);
      const done = near.filter((frame) => frame.message.status === 'done').sort((a, b) => Math.abs(a.at - event.at) - Math.abs(b.at - event.at))[0];
      if (done) return { turnId, closedBy: 'transcript' as const, gapMs: done.at - event.at };
      return near.length > 0 ? { turnId, closedBy: 'grace' as const } : { turnId, closedBy: 'none' as const };
    });
}

/**
 * The permission mode a transcript records last, read where Claude 2.1.29x writes it.
 *
 * Every main-chain prompt row carries the live mode as `permissionMode`, and the title block carries
 * a `permission-mode` row beside `last-prompt`, though not on every turn. Tool results never carry
 * it, and a subagent's rows are not the session's. A plan approved since the newest of those rows
 * changed the mode without writing one, so the mode is then unknown. Written apart from the
 * adapter's reader, so a run can hold what the gate read against what the file says.
 */
export function transcriptMode(rows: readonly TranscriptRow[]): string | undefined {
  const planCalls = new Set<string>();
  let mode: string | undefined;
  for (const row of rows) {
    if (row.type === 'permission-mode') {
      if (typeof row.permissionMode === 'string') mode = row.permissionMode;
      continue;
    }
    if (row.isSidechain === true) continue;
    if (row.message?.role === 'assistant') {
      for (const block of blocksOf(row)) {
        if (block.type === 'tool_use' && block.name === 'ExitPlanMode' && block.id) planCalls.add(block.id);
      }
      continue;
    }
    if (row.type !== 'user') continue;
    if (typeof row.permissionMode === 'string') {
      mode = row.permissionMode;
      continue;
    }
    const approved = blocksOf(row).some((block) => block.type === 'tool_result' && block.is_error !== true
      && block.tool_use_id !== undefined && planCalls.has(block.tool_use_id));
    if (approved) mode = undefined;
  }
  return mode;
}

/**
 * What a watching app's Hub holds as waiting on a person, replayed from one seat's frames, and
 * whether it reads the session as Needs input.
 *
 * The Hub's own rule (`hub.ts`): a request is pending under its id, a later request under the same
 * id replaces it, a resolution for that id removes it, and the row reads Needs input while any
 * pending request is not `blocking: false`. The smoke hosts no Hub, so the rule is replayed over the
 * frames the Hub would have been handed.
 */
export function seatPendingInput(frames: readonly SeatFrame[]): { pending: Map<string, SeatFrame['message']>; needsInput: boolean } {
  const pending = new Map<string, SeatFrame['message']>();
  for (const { message } of frames) {
    if (!message.requestId) continue;
    if (message.type === 'permission-request' || message.type === 'question-request') pending.set(message.requestId, message);
    else if (message.type === 'permission-resolved' || message.type === 'question-resolved') pending.delete(message.requestId);
  }
  return { pending, needsInput: [...pending.values()].some((message) => message.blocking !== false) };
}

/**
 * Band 1 on a held question handed it to Claude's own picker, and the app kept it as waiting.
 *
 * Checked while the picker is open: one card, under the call's `tool_use` id, restated read-only and
 * open in the terminal, still pending, and the session still Needs input. A resolution for the card
 * before the picker is answered is the defect this rule exists for (R5-A): the card closed with
 * nothing picked, and the session read Working while a person was being asked.
 */
export function questionKeptInTerminal(frames: readonly SeatFrame[], toolUseId: string): StepVerdict {
  const one = oneQuestionCard(frames, toolUseId);
  if (!one.ok) return one;
  const restated = frames.some((frame) => frame.message.type === 'question-request' && frame.message.requestId === toolUseId
    && frame.message.readOnly === true && frame.message.answerInTerminal === true);
  if (!restated) return { ok: false, detail: `the card ${toolUseId} was never restated read-only and open in the terminal` };
  const closes = frames.filter((frame) => frame.message.type === 'question-resolved' && frame.message.requestId === toolUseId).length;
  if (closes > 0) return { ok: false, detail: `the card closed ${closes} time(s) while the picker was open` };
  const { pending, needsInput } = seatPendingInput(frames);
  const card = pending.get(toolUseId);
  if (!card) return { ok: false, detail: `nothing is pending under ${toolUseId}` };
  if (card.readOnly !== true || card.answerInTerminal !== true) return { ok: false, detail: 'the pending card can still be answered from the app' };
  if (!needsInput) return { ok: false, detail: 'the seat does not read Needs input' };
  return { ok: true, detail: `one read-only card open in the terminal under ${toolUseId}, and Needs input` };
}

/**
 * The picker's answer closed the card that band 1 kept: one resolution, carrying the rows the
 * transcript recorded, no second card, and the session no longer Needs input.
 */
export function questionSettledInTerminal(frames: readonly SeatFrame[], toolUseId: string, rows: readonly (readonly string[])[]): StepVerdict {
  const closes = frames.filter((frame) => frame.message.type === 'question-resolved' && frame.message.requestId === toolUseId);
  if (closes.length !== 1) return { ok: false, detail: `${closes.length} resolution(s) for ${toolUseId}` };
  const said = JSON.stringify(closes[0]!.message.answers ?? null);
  if (said !== JSON.stringify(rows)) return { ok: false, detail: `closed with ${said}, the picker recorded ${JSON.stringify(rows)}` };
  const one = oneQuestionCard(frames, toolUseId);
  if (!one.ok) return one;
  const { pending, needsInput } = seatPendingInput(frames);
  if (pending.has(toolUseId)) return { ok: false, detail: `${toolUseId} is still pending` };
  if (needsInput) return { ok: false, detail: `the seat still reads Needs input on ${[...pending.keys()].join(', ')}` };
  return { ok: true, detail: `one resolution carrying ${said}; nothing pending` };
}

/**
 * Every close of this question says who closed it: `decidedBy` as given, and no release reason.
 *
 * Each copy counts, the broker's own and the transcript's, because a reload draws whichever one it
 * rebuilt from, and a bare one there reads "Settled in your terminal or another app."
 */
export function questionClosedBy(frames: readonly SeatFrame[], requestId: string, decidedBy: string): StepVerdict {
  const closes = frames.filter((frame) => frame.message.type === 'question-resolved' && frame.message.requestId === requestId);
  if (closes.length === 0) return { ok: false, detail: `no question-resolved for ${requestId}` };
  const wrong = closes.filter((frame) => frame.message.decidedBy !== decidedBy || frame.message.releaseReason !== undefined);
  if (wrong.length > 0) {
    const first = wrong[0]!.message;
    return { ok: false, detail: `${wrong.length} of ${closes.length} close(s) said ${JSON.stringify({ decidedBy: first.decidedBy ?? null, releaseReason: first.releaseReason ?? null })}` };
  }
  return { ok: true, detail: `${closes.length} close(s), each decidedBy ${decidedBy}` };
}

/** The newest `currentMode` the seat sent in a `sessionInfo` update; `null` when it said "no mode". */
export function seatMode(frames: readonly SeatFrame[]): string | null | undefined {
  let mode: string | null | undefined;
  for (const { message } of frames) {
    if (message.type !== 'metadata-update' || message.key !== 'sessionInfo') continue;
    const value = message.value;
    if (!value || typeof value !== 'object' || !('currentMode' in value)) continue;
    const said = (value as { currentMode?: unknown }).currentMode;
    mode = typeof said === 'string' ? said : null;
  }
  return mode;
}

/**
 * A mode changed while idle reached the seat and the gate at the next prompt, from that prompt's row.
 *
 * `stepPrompt` is the text the step sent after shift+tab, `before` the mode the transcript held
 * before the change, and `gateMode` the mode the gate recorded for the step's next ask. The prompt
 * row is the main-chain user row carrying the step's text; its `permissionMode` is what Claude wrote.
 * The mode must have moved, or the step changed nothing and proves nothing.
 */
export function modeFollowedPrompt(
  rows: readonly TranscriptRow[],
  frames: readonly SeatFrame[],
  stepPrompt: string,
  before: string | undefined,
  gateMode: string | undefined,
): StepVerdict & { promptMode?: string } {
  const row = rows.find((entry) => entry.type === 'user' && entry.isSidechain !== true && !entry.isMeta
    && userTexts([entry]).some((text) => text.includes(stepPrompt)));
  if (!row) return { ok: false, detail: 'the step\'s prompt row is not in the transcript' };
  const promptMode = typeof row.permissionMode === 'string' ? row.permissionMode : undefined;
  if (!promptMode) return { ok: false, detail: 'the step\'s prompt row carries no permissionMode' };
  if (promptMode === before) return { ok: false, promptMode, detail: `the prompt row still says ${before}: the change never reached the transcript` };
  const seat = seatMode(frames);
  if (seat !== promptMode) return { ok: false, promptMode, detail: `the seat says ${seat ?? 'nothing'}, the prompt row ${promptMode}` };
  if (gateMode !== promptMode) return { ok: false, promptMode, detail: `the gate recorded ${gateMode ?? 'nothing'}, the prompt row ${promptMode}` };
  return { ok: true, promptMode, detail: `${before ?? 'no mode'} -> ${promptMode}: prompt row, seat and gate agree` };
}

/** One numbered option on a dialog the pane shows. */
export interface DialogOption {
  digit: string;
  label: string;
}

/**
 * Claude's plan-approval dialog, read off the pane: whether it is up, which of its two forms, what it
 * offers, and the option that approves into auto mode, if the build offers one.
 *
 * Measured on 2.1.295, the dialog has two forms. "Ready to code?" follows a plan Claude wrote to its
 * plan file: when auto mode is available it offers "Yes, clear context … and use auto mode" and an
 * auto row that keeps the context, and its last row, "No, keep planning", takes text. "Exit plan
 * mode?" follows a plan passed inline: Yes, which returns to the mode the session had before plan
 * mode, or No. The pane is the only place the offer exists, so the dialog is found by its title,
 * and only the numbered rows under the last title count: a list a previous step left on the screen
 * is not read as this one. An auto option that also clears the context is taken only when no other
 * is on offer: clearing starts a new session, and the step is about the rest of this one's turn.
 */
export function planApprovalOptions(pane: string): { up: boolean; title?: string; options: DialogOption[]; auto?: DialogOption } {
  const lines = pane.split('\n');
  const at = lines.findLastIndex((line) => /Ready to code\?|Exit plan mode\?/.test(line));
  if (at < 0) return { up: false, options: [] };
  const title = /Ready to code\?|Exit plan mode\?/.exec(lines[at]!)![0];
  // The options are the last numbered run under the title, 1 upward: the plan itself, drawn above
  // them, can hold a numbered list of its own. A line between two options is an option's own
  // description or a blank, and is passed over.
  let options: DialogOption[] = [];
  for (const line of lines.slice(at + 1)) {
    const match = /^[\s│|]*[❯>]?\s*(\d+)\.\s+(.+?)[\s│|]*$/.exec(line);
    if (!match) continue;
    const option = { digit: match[1]!, label: match[2]!.trim() };
    if (option.digit === '1') options = [option];
    else if (Number(option.digit) === options.length + 1) options.push(option);
  }
  // "auto mode", "switch to auto", but never "auto-accept edits".
  const auto = options.filter((entry) => /\bauto\b(?!-)/i.test(entry.label));
  const chosen = auto.find((entry) => !/clear context/i.test(entry.label)) ?? auto[0];
  return { up: options.length >= 2, title, options, ...(chosen ? { auto: chosen } : {}) };
}

/**
 * Nothing was held for the app: every card drawn is read-only, and every call that asked the mod
 * was released. After a plan approved into auto mode, Claude's classifier decides the rest of the
 * turn, so a card with buttons on it, or a hold somebody answered, is the break.
 */
export function nothingHeld(
  cards: readonly { requestId: string; toolName?: string; readOnly?: boolean }[],
  audit: readonly { requestId: string; tool: string; released?: string }[],
): StepVerdict {
  const held = cards.filter((card) => card.readOnly !== true);
  if (held.length > 0) return { ok: false, detail: `held for the app: ${held.map((card) => `${card.toolName ?? '?'} ${card.requestId}`).join(', ')}` };
  const decided = audit.filter((row) => !row.released);
  if (decided.length > 0) return { ok: false, detail: `the audit records ${decided.length} hold(s): ${decided.map((row) => `${row.tool} ${row.requestId}`).join(', ')}` };
  return { ok: true, detail: audit.length === 0 ? 'no call asked the mod' : `${audit.length} call(s) asked the mod, each released: ${audit.map((row) => `${row.tool} ${row.released}`).join(', ')}` };
}
