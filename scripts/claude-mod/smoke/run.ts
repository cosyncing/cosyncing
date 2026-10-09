/**
 * Tier-2 smoke: real Claude, the real mod, M2's modules hosted in this process.
 *
 * A gate of its own, excluded from `bun run check`, because it spends model turns. It
 * proves the two halves agree: the pid the broker reads is the Claude process, a held call
 * is answered within the poll budget from either end, a release puts Claude's own dialog
 * back on screen, and a question is answered only in the shape the tool validates.
 *
 * Real-Claude rules this file exists to obey, each one learned the expensive way:
 *   the operator's real `~/.claude` config, so no second process can rotate the token;
 *   `--plugin-dir`, never an install into `~/.claude`;
 *   a scratch working folder, so the transcripts written here are ours to delete;
 *   `/usage` read before anything that can spend, and the run stops above 90%;
 *   NEVER an answer to the folder-trust dialog. It writes `hasTrustDialogAccepted` into the
 *   operator's `~/.claude.json`, which is a change to their machine that outlives the run and is
 *   not this harness's to make. The run refuses it and stops instead. `reportConfigWrites()`
 *   is the backstop: it compares the project keys and their trust flags before and after, and
 *   any key added or removed, or any trust gained, fails the run.
 *   NEVER `COSYNCING_CLAUDE_SOCK`. An earlier version exported it, which proved the socket and
 *   proved nothing about discovery -- and discovery is how the mod finds the broker in
 *   production. This run exports `COSYNCING_HOME` at the harness's own state directory and lets
 *   the mod resolve the path itself, which is the same chain a real terminal walks.
 *   NEVER a fixed scratch path or a shared tmux socket. `/tmp/cmts3` plus `tmux -L cmts3
 *   kill-server` is a cleanup that reaches for somebody else's session server. Every run gets its
 *   own run id, its own directory and its own tmux socket, and kills only those.
 *
 * The report always lands under `output/claude-mod-smoke/<run-id>/`; `--keep` additionally keeps
 * the scratch tree (socket, marketplace, debug log) that is otherwise removed on the way out.
 *
 *   bun run scripts/claude-mod/smoke/run.ts [--model haiku] [--keep] [--skip=<step>]... [--long-hold-ms 180000]
 *   bun run scripts/claude-mod/smoke/run.ts --stop-on-fail
 */
export {};
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHarness, type Harness, type Seat } from './harness.ts';
import {
  appPromptIsNextUserRow,
  appStopLeftIdle,
  closedByTerminal,
  modeFollowedPrompt,
  nothingHeld,
  oneQuestionCard,
  planApprovalOptions,
  questionClosedBy,
  questionKeptInTerminal,
  questionResolvedWith,
  questionSettledInTerminal,
  seatMode,
  resyncShowsNotRunning,
  toolCalls as toolCallsOf,
  turnEndGaps,
  type SeatFrame,
  assistantText as assistantTextOf,
  brokerChildRefusedOnce,
  configAuditVerdicts,
  questionAnswers,
  readTranscript,
  spawnedStayedSilent,
  stopEndedTurn,
  toolOutcomes as toolOutcomesOf,
  userCancelSeen,
  userTexts as userTextsOf,
  writeDeclinedByClaude,
  writeSettledByClaude,
} from './evidence.ts';
import { findClaudeTranscript } from '../../../packages/typescript/broker/src/sessions/claude-transcript-locator.ts';
import { CLAUDE_MOD_MIN_VERSION, claudeVersionAtLeast } from '../../../packages/typescript/adapters/claude/src/mod-presence.ts';
import { CLAUDE_MOD_TURN_END_GRACE_MS } from '../../../packages/typescript/adapters/claude/src/implementation.ts';
import { modJoinLabels } from '../../../packages/typescript/broker/src/sessions/mod-protocol.ts';

/**
 * One identity per run, used for the tmux socket, the scratch tree and the report.
 *
 * A tmux server is per socket name, so `-L cmts3 kill-server` is only safe while exactly one
 * run exists. Two runs -- or a run and a person's own session on that name -- and the cleanup
 * takes down a server it did not start.
 */
/** The mode every terminal this run starts is launched in, unless its step is about another one. */
const BASELINE_MODE = ['--permission-mode', 'manual'] as const;
const RUN_ID = `${Math.floor(Date.now() / 1000).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SESSION = `cmts-${RUN_ID}`;
const PANE = 'smoke';
const argv = process.argv.slice(2);
const has = (name: string) => argv.includes(name);
function flag(name: string, fallback = ''): string {
  const at = argv.indexOf(name);
  const value = argv[at + 1];
  return at >= 0 && value !== undefined ? value : fallback;
}
const skip = new Set(argv.filter((a) => a.startsWith('--skip=')).map((a) => a.slice(7)));
const model = flag('--model', 'haiku');
/** The auto-mode step is the one step that must not run on Haiku. */
const autoModel = flag('--auto-model', 'sonnet');
const repoRoot = join(import.meta.dir, '../../..');
const outDir = join(repoRoot, 'output/claude-mod-smoke', RUN_ID);
// The lane's declared artifact, and the only path in this file under `output/`. A gate that
// promises a report has to leave one behind whether the run passed or died on the way, because
// a missing report is what turns one failure into a lane that looks like it never ran.
const reportPath = join(repoRoot, 'output/claude-mod-smoke', RUN_ID, 'report.json');
const SCRATCH = join(tmpdir(), `cmts-${RUN_ID}`);
const socketRoot = join(SCRATCH, 'run');
// The workspace is the Claude session's cwd, so its path decides whether the folder-trust dialog
// appears. A scratch directory under the OS temp root inherits the trust the operator already
// gave `/tmp` (measured: the 2026-10-04 evidence records `folder-trust seen:false` for
// `/tmp/cmts3/workspace`, with nothing answered). The repo's own `output/` sits under a trusted
// ancestor too but has never been measured there, and this harness does not find out by writing
// to the operator's config.
const workspace = join(SCRATCH, 'workspace');
const marketDir = join(SCRATCH, 'marketplace');
/** Stands in for `~/.cosyncing`. The mod is expected to find the socket inside it, unaided. */
const stateHome = join(SCRATCH, 'state');
/** The name the broker binds and the mod derives, spelled once so the two cannot drift. */
const SOCKET_FILENAME = 'claude-mod.sock';
const socketPath = join(stateHome, SOCKET_FILENAME);
const debugLog = join(SCRATCH, 'claude-debug.log');

const evidencePath = join(SCRATCH, 'evidence.ndjson');
let lines: string[] = [];
function emit(type: string, data: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ at: new Date().toISOString(), type, ...data });
  lines.push(line);
  writeFileSync(evidencePath, lines.join('\n') + '\n');
  console.log(line);
}

const verdicts: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): boolean {
  verdicts.push({ name, ok, detail });
  emit('assert', { name, ok, detail });
  if (!ok && has('--stop-on-fail')) throw new Error(`assertion failed: ${name} ${detail}`);
  return ok;
}
const step = (name: string) => !skip.has(name);

function tmux(args: string[], tolerate = false): string {
  const run = spawnSync('tmux', ['-L', SESSION, ...args], { encoding: 'utf8' });
  if (run.status !== 0 && !tolerate) throw new Error(`tmux ${args.join(' ')}: ${run.stderr.trim()}`);
  return run.stdout;
}

/**
 * Where `-L <name>` puts its socket: `/tmp/tmux-<uid>/<name>`, unless $TMPDIR moved the pair.
 *
 * `kill-server` removes the server but the socket file is what a later audit looks at, so cleanup
 * takes both and reports what it found.
 */
function tmuxSocketFile(): string {
  const base = (process.env.TMUX_TMPDIR ?? `/tmp/tmux-${process.getuid?.() ?? 0}`).replace(/\/$/, '');
  return join(base, SESSION);
}
const keys = (...what: string[]) => tmux(['send-keys', '-t', PANE, ...what]);
/**
 * `-l` sends literal keystrokes. Without it tmux reads the text as key names, which is how
 * a prompt can end up as nothing on the screen and a turn charged for a message never sent.
 */
const type = (text: string) => tmux(['send-keys', '-t', PANE, '-l', text]);
const pane = (from = 80) => tmux(['capture-pane', '-pt', PANE, '-S', `-${from}`], true);
/**
 * The mode the terminal itself says it is in.
 *
 * Measured on 2.1.290, the indicator is one line: `⏵⏵ auto mode on (shift+tab to cycle)`,
 * `⏸ manual mode on`, `⏵⏵ accept edits on`, `⏸ plan mode on`. It is the only place a mode chosen
 * before the first message is written down -- a session with no turn has no transcript, and a
 * mode set before that first message never reaches one.
 */
function modeIndicator(): string | undefined {
  for (const entry of pane(60).split('\n')) {
    const match = /(auto mode on|manual mode on|accept edits on|plan mode on)/.exec(entry);
    if (match) return match[1];
  }
  return undefined;
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Wait until the TUI has drawn. A prompt typed into a pane that has not rendered yet is a turn
 * that never happens, and a step that then sees "no card" is proving the launch, not the rule.
 */
async function paneReady(timeoutMs = 30_000): Promise<boolean> {
  return waitFor(() => pane(10).trim().length > 0, timeoutMs);
}

/** Poll a condition until it holds or the budget runs out. A fixed sleep reads "not yet" as "never". */
async function waitFor(done: () => boolean, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (done()) return true;
    if (Date.now() >= until) return false;
    await sleep(1000);
  }
}

let turns = 0;
/** One model turn: type it, submit it, wait for the pane to go quiet. */
async function submit(text: string, timeoutMs = 150_000): Promise<string> {
  if (text.startsWith('/')) {
    type(text);
    await sleep(200);
    keys('Enter');
    await sleep(2500);
    return pane();
  }
  turns += 1;
  emit('turn', { n: turns, text });
  type(text);
  await sleep(300);
  keys('Enter');
  const deadline = Date.now() + timeoutMs;
  let last = '';
  let quiet = 0;
  while (Date.now() < deadline) {
    await sleep(1500);
    const now = pane();
    if (/esc to interrupt/.test(now)) {
      quiet = 0;
      last = now;
      continue;
    }
    quiet = now === last ? quiet + 1 : 0;
    last = now;
    if (quiet >= 2) break;
  }
  return last;
}

/**
 * What the operator's `~/.claude.json` says about trust, captured before and after the run.
 *
 * Comparing the whole file would report Claude's own harmless bookkeeping (usage counters move).
 * Trust is the write that matters: `projects[path].hasTrustDialogAccepted` is a standing decision
 * about the operator's machine, and a harness that answers a dialog owns one of those.
 */
function trustSnapshot(): { keys: string[]; trusted: string[]; problem: string } {
  const file = join(process.env.HOME ?? '', '.claude.json');
  if (!existsSync(file)) return { keys: [], trusted: [], problem: 'no ~/.claude.json' };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> };
    const projects = parsed.projects ?? {};
    return {
      keys: Object.keys(projects).sort(),
      trusted: Object.entries(projects).filter(([, value]) => value?.hasTrustDialogAccepted === true).map(([key]) => key).sort(),
      problem: '',
    };
  } catch (error) {
    return { keys: [], trusted: [], problem: `unreadable: ${String((error as Error)?.message ?? error)}` };
  }
}

/** The transcript directories Claude keeps, so a run can name what it added without deleting. */
function transcriptDirs(): string[] {
  const dir = join(process.env.HOME ?? '', '.claude', 'projects');
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

/**
 * The plan files Claude keeps. In plan mode Claude writes its plan into `~/.claude/plans/` before it
 * presents it -- its own file, which the plan step cannot avoid -- so the run names what it added
 * there, as it does for transcripts, and deletes nothing.
 */
function planFiles(): string[] {
  try {
    return readdirSync(join(process.env.HOME ?? '', '.claude', 'plans')).sort();
  } catch {
    return [];
  }
}

let configBefore = trustSnapshot();
let projectsBefore = transcriptDirs();
let plansBefore = planFiles();
let createdPlans: string[] = [];
let lastConfigAudit: Record<string, unknown> = { reported: false };
let createdDirs: string[] = [];

/**
 * Refuse the folder-trust dialog.
 *
 * Answering it is the one thing in this file that leaves a mark: `hasTrustDialogAccepted` for the
 * cwd, in the operator's own config, whether or not anyone meant to grant it. So the answer is no
 * and the run stops with instructions, rather than spending the operator's trust to save a step.
 */
async function refuseTrustPrompt(where: string): Promise<void> {
  const shown = pane(30);
  const seen = /trust the files|trust the folder|do you trust|1\. yes,/i.test(shown);
  emit('folder-trust', { step: where, seen, action: seen ? 'refused to answer; aborting' : 'not shown' });
  if (!seen) return;
  writeReport('aborted', `folder-trust dialog is up in ${where}`);
  throw new Error(`refusing to answer the folder-trust dialog in ${where}; it would write trust into ~/.claude.json.`
    + ` Run Claude once in ${workspace} yourself if you want this cwd trusted; the harness never answers the prompt.`);
}

// ---- transcript readers ----
// The assertions live in evidence.ts, not in the pane. A pane is what a human happened to be able
// to see at one instant of scrolling; a transcript row is what the session actually recorded, and
// it survives a resize, a fast turn and an unhelpful terminal height. Pane checks here were green
// while the thing they named had not happened, matching dialog text a previous step left behind.

const transcriptRows = (path: string | undefined) => readTranscript(path);
/** One entry per tool call the transcript recorded, with what the tool answered. */
const toolOutcomes = (path: string | undefined) => toolOutcomesOf(readTranscript(path));
const assistantText = (path: string | undefined) => assistantTextOf(readTranscript(path));
/** Text the session records as a user message, which is what `$.prompt.submit` must produce. */
const userTexts = (path: string | undefined) => userTextsOf(readTranscript(path));

/** The transcript of the session currently registered, re-located after a /clear or a resume. */
function currentTranscript(): string | undefined {
  const last = harness.registers.at(-1);
  return last ? findClaudeTranscript(last.sessionId, last.cwd) : undefined;
}

/**
 * Point the harness's mode read at the session that is actually alive, right now.
 *
 * Called immediately before a probe rather than once after a launch: between the two, the process
 * being killed gets a chance to re-register on its way out, and a step that read the registration
 * list at the wrong moment aimed the read at a dead session's transcript. That is not a harmless
 * mistake -- the transcript of the process that just died still carries its own launch-time mode,
 * and the harness then reported the live session as being in a mode it had left. It cost a Sonnet
 * turn and three runs to see: the card that came back said `default` for a terminal in auto mode.
 */
function pointGateAtLiveSession(): string | undefined {
  // Each hold is read against its own session's transcript, looked up on every read the way the
  // broker looks it up. A path fixed here was wrong for a fresh launch: its transcript, and its
  // first mode row, appear with the first message, after this call, so a 2026-10-07 run read a
  // session launched in auto mode as unknown for its whole first turn.
  harness.useTranscript(transcriptOf);
  const path = currentTranscript();
  emit('gate-pointed', { path: path ?? null, session: harness.registers.at(-1)?.sessionId ?? null, reads: 'each hold\u2019s own session' });
  return path;
}

/** A session's transcript as the broker finds it, from the cwd that session registered with. */
function transcriptOf(sessionId: string): string | undefined {
  const row = [...harness.registers].reverse().find((entry) => entry.sessionId === sessionId);
  return findClaudeTranscript(sessionId, row?.cwd ?? workspace);
}

/**
 * Wait for the process this step just launched to register.
 *
 * A changed registration COUNT is not the signal. The process being shut down re-registers on its
 * way out, the count moves, and the step reads the dying row -- which is what happened here, twice,
 * and each time it pointed the mode read at a transcript that no longer described anything. The
 * registration that can only be the new process is a new pid.
 */
async function waitForNewProcess(beforePid: number, timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (harness.registers.some((row) => row.peerPid !== beforePid && row.peerPid > 0 && existsSync(`/proc/${row.peerPid}/comm`))) return true;
    await sleep(500);
  }
  return false;
}

let harness: Harness;

/** The next hold this run has not handed to a step yet, held or released. */
interface FoundHold {
  sessionId: string;
  /** The mod's own id, which the audit rows carry. */
  requestId: string;
  /** The card's id, which the broker minted for this hold alone and the app answers by. A
   *  question's card carries Claude's own call id instead, and `requestId` is that id too. */
  cardId?: string;
  released?: string;
  card?: boolean;
  /** How long the audit trail was when the card was found: a question's row is the next one. */
  auditFrom?: number;
}

/** The card the broker drew for one of the mod's calls in one session, if it drew one. */
function cardIdFor(modRequestId: string, hubSessionId: string): string | undefined {
  return harness.cards.filter((card) => card.sessionId === hubSessionId && card.requestId.startsWith(`${modRequestId}@`))
    .at(-1)?.requestId;
}

/**
 * How far each append-only evidence list had been read when the current search started.
 *
 * Freshness was the highest `cm-<n>` seen, then a set of `(session, request id)` pairs, and both
 * are wrong in opposite directions. The id restarts at one in every process, so a resumed
 * session's first card -- on screen, waiting -- read as older than the watermark and the step
 * waiting for it timed out. The pair is not unique either: a killed process and the process that
 * resumed its session are the same session, and both call their first tool `cm-1`, which is the
 * collision S1 exists to prevent. Neither list needs a proxy for time. Cards and audit rows are
 * appended in arrival order, so an offset into those two lists is the clock -- and a step that
 * timed out with a card still up does not hand that card to the next step.
 */
let cardsRead = 0;
let auditRead = 0;

/** Draw the line where a new search begins: only evidence past it counts as fresh. */
function markEvidenceRead(): void {
  cardsRead = harness.cards.length;
  auditRead = harness.audit().length;
}

/**
 * The id the hub knows a session by.
 *
 * Cards arrive through the hub row, which is keyed by the encoded transcript path; audit rows
 * name the session by the native uuid the mod speaks. Two names, one session -- so the audit
 * side is translated before it is compared, rather than the two being keyed apart forever.
 */
function hubKey(sessionId: string): string {
  return harness.service.hubIdFor(sessionId) ?? sessionId;
}

/** The id the mod speaks for a session the hub handed over by its encoded path. */
function modSessionOf(hubSessionId: string): string {
  return harness.registers.map((row) => row.sessionId).filter((id) => hubKey(id) === hubSessionId).at(-1) ?? hubSessionId;
}

async function nextHold(timeoutMs = 70_000, tool?: string): Promise<FoundHold | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const audit = harness.audit();
    if (!tool) {
      for (let index = auditRead; index < audit.length; index += 1) {
        const row = audit[index]!;
        if (!row.requestId.startsWith('cm-')) continue;
        auditRead = index + 1;
        const cardId = cardIdFor(row.requestId, hubKey(row.sessionId));
        if (row.released) return { sessionId: hubKey(row.sessionId), requestId: row.requestId, ...(cardId ? { cardId } : {}), released: row.released };
        if ((cardId && harness.service.isHeld(row.sessionId, cardId)) || row.answeredBy) {
          return { sessionId: hubKey(row.sessionId), requestId: row.requestId, ...(cardId ? { cardId } : {}), card: true };
        }
      }
    }
    for (let index = cardsRead; index < harness.cards.length; index += 1) {
      const card = harness.cards[index]!;
      // A held question's card carries Claude's own call id, not a minted one: one question is
      // one card, whichever of its copies the app saw first.
      const minted = card.requestId.startsWith('cm-');
      if (!minted && !(card.kind === 'question' && card.readOnly !== true)) continue;
      if (tool && card.toolName !== tool) continue;
      cardsRead = index + 1;
      return {
        sessionId: card.sessionId,
        requestId: minted ? card.requestId.split('@')[0]! : card.requestId,
        cardId: card.requestId,
        card: true,
        auditFrom: harness.audit().length,
      };
    }
    await sleep(400);
  }
  return undefined;
}

/**
 * Press one of the band's buttons, and name the route that armed it.
 *
 * The build documents two: a bare digit in an empty composer answers a band Button, and any
 * Button hotkey arms once the band itself holds the keyboard (`ctrl+x` then `tab`). A real
 * session answered neither a bare digit sent mid-turn, so the smoke tries the bare digit,
 * clears the composer, then takes the band's keys, and records which route worked. That answer
 * is a product fact, not a test detail: it is what the shipped band will have to tell the human.
 */
async function pressBandKey(requestId: string | undefined, digit: string, expectAnswer = true): Promise<string> {
  // Button 3 answers nothing by design: it hands the call to Claude's own dialog. Its press is
  // therefore proved by the user-cancel the mod reports for this hold, not by a band answer that
  // never comes -- and not by the band text leaving the pane, which a redraw can do on its own.
  // A question's step knows its hold by Claude's call id, not the mod's, so it passes no id: with
  // one hold open, any user-cancel after the press is that hold's.
  const eventsFrom = harness.events.length;
  const armed = async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (expectAnswer) {
        if (requestId !== undefined && auditFor(requestId)?.answeredBy === 'band') return true;
      } else if (harness.events.slice(eventsFrom).some((event) => event.kind === 'user-cancel' && (requestId === undefined || event.requestId === requestId))) {
        return true;
      }
      await sleep(400);
    }
    return false;
  };
  type(digit);
  if (await armed()) return 'bare digit in the composer';
  keys('C-u');
  await sleep(200);
  keys('C-x');
  await sleep(250);
  keys('Tab');
  await sleep(400);
  type(digit);
  if (await armed()) return 'ctrl+x then tab, then the digit';
  keys('C-u');
  return 'neither documented route armed the band';
}

function answer(hold: FoundHold, decision: 'approve' | 'reject'): boolean {
  return harness.service.approve({ sessionId: modSessionOf(hold.sessionId), requestId: hold.cardId ?? hold.requestId, decision });
}

/**
 * The audit row for one call.
 *
 * Request ids are the mod's to mint and restart at one in every process, so the id alone can
 * name two different calls in one run -- the call a killed process left and the one its
 * replacement opened. Steps pass the session they are talking about.
 */
function auditFor(requestId: string, sessionId?: string) {
  const rows = harness.audit().filter((row) => row.requestId === requestId
    && (sessionId === undefined || row.sessionId === sessionId));
  return rows.at(-1);
}

/** The audit row for a hold this run found, in the session that raised it. */
function auditOf(hold: FoundHold) {
  if (hold.requestId.startsWith('cm-')) return auditFor(hold.requestId, modSessionOf(hold.sessionId));
  // A question's card names Claude's call and its audit row names the mod's hold, so the row is
  // the first question row in the session written after the card was found.
  return harness.audit().slice(hold.auditFrom ?? 0)
    .find((row) => row.sessionId === modSessionOf(hold.sessionId) && row.tool === 'AskUserQuestion');
}

/**
 * The synced seat on the session alive now, opened once its transcript exists.
 *
 * Steps that prove what the app was shown -- the row going idle, the card ids it drew, what a
 * resync replays -- read this seat's frames. It is opened before the step's turn so it receives
 * the step's cards as a watching app would.
 */
async function liveSeat(): Promise<Seat | undefined> {
  const last = harness.registers.at(-1);
  const path = currentTranscript();
  if (!last || !path || !existsSync(path)) return undefined;
  return harness.openSeat(last.sessionId, path);
}

/** One seat's frames from `from` on, in the shape the proof rules read. */
function seatFrames(seat: Seat, from: number): SeatFrame[] {
  return harness.frames.slice(from).filter((frame) => frame.sessionId === seat.sessionId) as unknown as SeatFrame[];
}

/** The lane's report: verdicts, turns spent, and the broker's own audit rows. */
function writeReport(status: 'passed' | 'failed' | 'aborted', failure = ''): void {
  const failed = verdicts.filter((entry) => !entry.ok);
  writeFileSync(reportPath, JSON.stringify({
    schemaVersion: 1,
    at: new Date().toISOString(),
    status,
    ...(failure ? { failure } : {}),
    model,
    turns,
    checks: { total: verdicts.length, passed: verdicts.length - failed.length, failed: failed.length },
    verdicts,
    registers: harness?.registers ?? [],
    audit: harness?.audit() ?? [],
    configAudit: lastConfigAudit,
    transcriptDirsCreated: createdDirs,
    planFilesCreated: createdPlans,
    scratch: { runId: RUN_ID, dir: SCRATCH, tmuxSocket: SESSION, kept: has('--keep') },
    claudeEnv: claudeEnv(),
  }, null, 2) + '\n');
}

/**
 * The environment every launch gets, built once so "did this run hand the socket to the mod?"
 * has one answer instead of three that can drift apart.
 *
 * `COSYNCING_HOME` is the only hint: the mod must resolve `<COSYNCING_HOME>/claude-mod.sock`
 * itself, the way a terminal that inherited nothing from the broker does. Handing it
 * `COSYNCING_CLAUDE_SOCK` would test the socket and miss the discovery, which is the defect that
 * made the whole feature dead on a real install.
 */
function claudeEnv(): string[] {
  return [
    `COSYNCING_HOME=${stateHome}`,
    'COSYNCING_CLAUDE_DEBUG=1',
    // Steering is behind a flag in the mod, and this run is where its transcript row gets
    // measured -- the adapter's `isMeta` rule is written from what lands here, not from hope.
    'COSYNCING_CLAUDE_STEER=1',
  ];
}

/** One Claude launch, into a pane, with the scratch cwd. Every step goes through here. */
function launchClaude(dir: string, args: string[]): void {
  tmux(['new-session', '-d', '-s', PANE, '-c', workspace, '-x', '220', '-y', '50',
    'env', ...claudeEnv(), 'claude', '--plugin-dir', dir, ...args,
    '--debug', '--debug-file', debugLog]);
}

/** A pane that has not drawn yet swallows keystrokes: a prompt typed too early is a turn that
 *  never happens, and the step that follows then proves the launch rather than the rule. */
function shutdown(): void {
  spawnSync('tmux', ['-L', SESSION, 'kill-server'], { encoding: 'utf8' });
  try {
    rmSync(tmuxSocketFile(), { force: true });
  } catch {
    // A socket file left behind is reported by the orphan scan, not lost here.
  }
}

let pump: ReturnType<typeof setInterval> | undefined;
let closed = false;
/** The headless Claudes the spawned step starts, which register nothing and so are not in `registers`. */
const headlessPids: number[] = [];

/**
 * Leave nothing running, on every road out of the process.
 *
 * A killed run used to take its tmux server, its socket and its harness with it, which is how a
 * smoke test ends up as an orphan holding a Unix socket the next run cannot claim.
 */
function cleanup(): void {
  if (closed) return;
  closed = true;
  if (pump !== undefined) clearInterval(pump);
  shutdown();
  try {
    harness?.close();
  } catch {
    // Already closed on the normal path.
  }
  if (!has('--keep')) {
    // A Claude killed with its tmux server still flushes its debug log on the way out, and on
    // 2026-10-07 that write landed after the tree was gone and put the scratch directory back.
    // So the tree goes only once every Claude this run registered has exited, or after 10 s.
    // Synchronous on purpose: this also runs from the `exit` hook.
    const alive = () => [...(harness?.registers ?? []).map((row) => row.peerPid), ...headlessPids].some((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && alive()) spawnSync('sleep', ['0.2']);
    rmSync(SCRATCH, { recursive: true, force: true });
  }
}

let configAudited = false;

function reportConfigWrites(): void {
  // Called on the normal path and again from the `exit` hook, so it reports once and no more.
  if (configAudited) return;
  configAudited = true;
  const after = trustSnapshot();
  const gained = after.trusted.filter((key) => !configBefore.trusted.includes(key));
  const added = after.keys.filter((key) => !configBefore.keys.includes(key));
  const removed = configBefore.keys.filter((key) => !after.keys.includes(key));
  emit('config-audit', {
    before: configBefore.keys.length, after: after.keys.length,
    added, removed, gainedTrust: gained, problem: after.problem,
  });
  // Trust, the set of project keys, and that the file still parses. A new project key used to be
  // logged and passed; it is a write to the operator's file that outlives the run, so it fails.
  for (const verdict of configAuditVerdicts(configBefore, after)) check(verdict.name, verdict.ok, verdict.detail);

  const dirs = transcriptDirs();
  const created = dirs.filter((name) => !projectsBefore.includes(name));
  createdDirs = created;
  lastConfigAudit = {
    reported: true,
    projectKeysBefore: configBefore.keys.length,
    projectKeysAfter: after.keys.length,
    keysAdded: added,
    keysRemoved: removed,
    trustGained: gained,
    problem: after.problem,
  };
  emit('transcript-dirs', { created, total: dirs.length });
  createdPlans = planFiles().filter((name) => !plansBefore.includes(name));
  emit('plan-files', { created: createdPlans });
  if (createdPlans.length > 0) console.log(`plan files Claude wrote under ~/.claude/plans (left in place): ${createdPlans.join(', ')}`);
  console.log(`transcript directories this run created under ~/.claude/projects: ${created.length === 0 ? 'none' : created.join(', ')}`);
  console.log('  (left in place: they are session history, and deleting them is not this run\u2019s call)');
}

process.on('SIGINT', () => {
  emit('signal', { signal: 'SIGINT' });
  process.exit(130);
});
process.on('SIGTERM', () => {
  emit('signal', { signal: 'SIGTERM' });
  process.exit(143);
});
// The one cleanup that cannot be skipped. `process.exit()` does not run `finally`, so a hook on
// `exit` is the only place that covers the normal path, both signal paths and the fatal catch
// without three copies of the same three lines.
process.on('exit', () => {
  try {
    reportConfigWrites();
  } catch {
    // The report is already written; a failed audit must not hide it.
  }
  cleanup();
});

async function dismissDialog(): Promise<void> {
  // A released call leaves Claude's own dialog up. Escape declines it, which is the
  // answer that cannot be wrong: it runs nothing and ends the turn.
  keys('Escape');
  await sleep(1500);
  if (/Yes,|No,|1\.|2\./.test(pane(25))) keys('Escape');
  await sleep(1500);
}

try {
  mkdirSync(socketRoot, { recursive: true });
  mkdirSync(stateHome, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const build = spawnSync('bun', ['run', 'scripts/mod/build-mod-marketplace.ts', '--out', marketDir], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (build.status !== 0) throw new Error(`marketplace build failed: ${build.stderr || build.stdout}`);
  const pluginDir = join(marketDir, 'cosyncing-claude');

  // Captured before anything can spend a turn, so an abort mid-run still reports against it.
  configBefore = trustSnapshot();
  projectsBefore = transcriptDirs();
  plansBefore = planFiles();

  harness = await startHarness({ root: socketRoot, socketPath });
  harness.onEmit(emit as never);
  // The baseline a live session presents: somebody watching, default mode. Each step that
  // tests another rule overrides it, and a run that skips steps starts coherent anyway.
  harness.setViewers(1);
  harness.setMode('default');
  pump = setInterval(() => {
    const drained = harness.drain();
    for (const registration of drained.registers) emit('register', registration as unknown as Record<string, unknown>);
    for (const card of drained.cards) emit('card', card as unknown as Record<string, unknown>);
    for (const event of drained.events) emit('event', event as unknown as Record<string, unknown>);
  }, 300);

  shutdown();
  // The baseline is set, not inherited. 2.1.289 dropped `default` from the flag's choices
  // (acceptEdits, auto, bypassPermissions, manual, dontAsk, plan); `manual` is the spelling its
  // transcripts record as permissionMode:"default". A flagless launch takes the operator's
  // `permissions.defaultMode`, and on 2026-10-08 that was `auto`: every call ran under Claude's own
  // classifier, and "Show Claude's dialog" handed a Write back to a mode that allowed it with no
  // dialog at all, so the step that declines it in Claude's dialog failed on the operator's
  // setting rather than on the mod. The `real:` field below still records what the session wrote.
  launchClaude(pluginDir, [...BASELINE_MODE, '--model', model]);
  emit('started', {
    runId: RUN_ID, socketPath, stateHome, workspace, model, pluginDir,
    // The absence is the point: this is the discovery run, not the socket run.
    handedTheModTheSocket: claudeEnv().some((entry) => entry.startsWith('COSYNCING_CLAUDE_SOCK')),
  });

  const registerDeadline = Date.now() + 120_000;
  while (Date.now() < registerDeadline && harness.registers.length === 0) await sleep(1000);
  const registration = harness.registers[0];
  if (!check('the mod registered over the socket', !!registration, JSON.stringify(registration ?? null))) throw new Error('no registration');

  await refuseTrustPrompt('the first launch');

  const comm = existsSync(`/proc/${registration!.peerPid}/comm`) ? readFileSync(`/proc/${registration!.peerPid}/comm`, 'utf8').trim() : 'gone';
  check('the peer pid is the claude process', comm === 'claude', `pid ${registration!.peerPid} comm ${comm}`);
  // Numeric, not lexical: `'2.1.289' >= '2.1.30'` is true in JavaScript, which is the kind of
  // floor check that passes while shipping a build the feature was never measured on.
  check('the build is at or above the version floor', claudeVersionAtLeast(registration!.claudeVersion, CLAUDE_MOD_MIN_VERSION),
    `${registration!.claudeVersion} vs floor ${CLAUDE_MOD_MIN_VERSION}`);
  // B1's production path: nothing told the mod where the socket was. It read COSYNCING_HOME and
  // built the same path the broker bound, which is the chain every real terminal has to walk.
  check('the mod found the socket by discovery, not by hand', existsSync(socketPath) && claudeEnv().every((entry) => !entry.startsWith('COSYNCING_CLAUDE_SOCK')),
    `${socketPath} exists=${String(existsSync(socketPath))}`);

  const transcript = findClaudeTranscript(registration!.sessionId, registration!.cwd);
  harness.useTranscript(transcript);
  emit('transcript', { path: transcript ?? null });

  const usage = await submit('/usage');
  const used = Number(/Current session[\s\S]{0,240}?(\d+)% used/.exec(usage)?.[1] ?? -1);
  check('usage is below the 90% stop line', used >= 0 && used <= 90, `session ${used}%`);
  keys('Escape');
  await sleep(800);
  if (used > 90) throw new Error(`usage ${used}% is over the stop line`);

  // Each probe is a `Write` to a fresh file, and that choice is measured rather than casual.
  // The first version of this script asked Claude to run `echo <marker>` and every turn settled
  // in ~20 ms with no hold: a read-only Bash command is auto-approved on this build, so
  // `tool.check` returned `allow` and there was nothing for the mod to hold. A `Write` to a path
  // the operator's allow rules do not cover is a real `ask`, and the file on disk is a better
  // witness than the pane: it says whether the call ran, not what was scrolled past.
  const probeFile = (name: string) => join(workspace, `${name}.txt`);
  const writePrompt = (name: string) =>
    `Use the Write tool to create the file ${name}.txt in the current directory containing exactly one line: ${name}. Use no other tool.`;
  const ran = (name: string) => existsSync(probeFile(name));

  /** Fire a turn and return the hold it produced, held or released. */
  async function probe(name: string, prompt: string, options: { timeoutMs?: number; tool?: string } = {}) {
    markEvidenceRead();
    const pending = nextHold(options.timeoutMs ?? 70_000, options.tool);
    void submit(prompt);
    return await pending;
  }

  /**
   * Restart the terminal on the same session with other flags, and wait for the new process.
   *
   * A mode is written with the next prompt: on that prompt's own row, and sometimes on the title
   * block's `permission-mode` row beside it. Until then the transcript holds the previous mode, which
   * is the window the public true-sync guide describes. A step that asserts a mode's rule launches
   * into that mode and primes it, so it tests the rule and not the window.
   */
  async function relaunch(label: string, args: string[], mode?: string): Promise<boolean> {
    const sessionId = harness.registers.at(-1)?.sessionId ?? '';
    const beforePid = harness.registers.at(-1)?.peerPid ?? 0;
    shutdown();
    await sleep(2000);
    launchClaude(pluginDir, ['--resume', sessionId, ...args]);
    emit('relaunched', { step: label, sessionId, args });
    const registered = await waitForNewProcess(beforePid);
    check(`the ${label} terminal registered`, registered, `waiting for a pid other than ${beforePid}`);
    await refuseTrustPrompt(`the ${label} launch`);
    emit('pane-ready', { step: label, drawn: await paneReady() });
    pointGateAtLiveSession();
    if (mode) {
      // A restarted session writes its new mode only once a prompt is sent. The steps test each
      // mode's rule, so a turn with no tool puts the mode on disk before the step's own ask. Since
      // P-9 the read takes the prompt row's own `permissionMode`, so one priming turn is enough. The
      // title block's row, which the read used to wait for, is written beside `last-prompt` and not
      // on every turn: in a 2026-10-07 rerun, two identical one-second "OK" replies wrote none. So
      // each priming turn still has new text, and up to three are tried.
      const topics = ['rivers', 'mountains', 'forests'];
      let landed = false;
      let primes = 0;
      while (!landed && primes < topics.length) {
        const topic = topics[primes]!;
        primes += 1;
        await submit(`Write three short sentences about ${topic}. Use no tool.`);
        landed = await waitFor(() => harness.observedMode() === mode, 15_000);
      }
      emit('mode-primed', { step: label, mode, landed, primes });
      check(`the ${label} terminal's mode is on disk before its first ask`, landed,
        `transcript reads ${harness.observedMode() ?? 'no row'} after ${primes} turn(s)`);
    }
    return registered;
  }

  /** Wait for the turn on screen to end, so the next prompt starts a turn instead of steering it. */
  const settle = () => waitFor(() => !/esc to interrupt/.test(pane()), 90_000);

  if (step('release-unknown')) {
    harness.setViewers(1);
    harness.setMode(undefined);
    const hold = await probe('cmts-unknown-mode', writePrompt('cmts-unknown-mode'));
    check('an unreadable mode releases with mode:unknown', hold?.released === 'mode:unknown', JSON.stringify(hold ?? null));
    const row = hold ? auditOf(hold) : undefined;
    check('a release is recorded as a release, not a decision', row?.released === 'mode:unknown', JSON.stringify(row ?? null));
    check('a released call is not answered, so the audit names nobody', !row?.answeredBy || row.answeredBy === 'cancel', String(row?.answeredBy));
    await dismissDialog();
  }

  if (step('release-noviewer')) {
    harness.setViewers(0);
    harness.setMode('default');
    emit('mode-observed', { real: harness.observedMode() ?? null, note: 'the gate is pinned; the real session mode is recorded beside it' });
    const hold = await probe('cmts-no-viewer', writePrompt('cmts-no-viewer'));
    check('no viewer releases with viewer:none', hold?.released === 'viewer:none', JSON.stringify(hold ?? null));
    await dismissDialog();
  }

  if (step('hold-from-app')) {
    harness.setViewers(1);
    harness.setMode('default');
    const hold = await probe('cmts-from-app', writePrompt('cmts-from-app'));
    if (check('a held call reaches the broker', !!hold?.card, JSON.stringify(hold ?? null))) {
      // Mid-turn steering, while the turn is parked on this hold: the one moment the app can
      // prove it is talking to a live turn rather than queueing a second one. The row it lands
      // is `isMeta:true`, which the adapter used to drop, so its exact shape is evidence.
      const steerMarker = `STEER-MARKER-${Date.now()}`;
      harness.service.send(harness.registers.at(-1)!.sessionId, {
        requestId: 'cmd-steer', op: 'steer', text: steerMarker, queuedAt: Date.now(),
      });
      await sleep(3000);
      const answered = answer(hold!, 'approve');
      check('the app can answer the hold', answered, hold!.requestId);
      await sleep(4000);
      const row = auditOf(hold!);
      check('the hold was answered from the app', row?.answeredBy === 'app', JSON.stringify(row ?? null));
      check('the audit counts the hold\'s polls', (row?.polls ?? 0) >= 1, String(row?.polls));
      await sleep(4000);
      const ranIt = await waitFor(() => ran('cmts-from-app'), 45_000);
      check('the held call ran after the app allowed it', ranIt, probeFile('cmts-from-app'));
      await sleep(3000);
      const transcriptNow = findClaudeTranscript(harness.registers.at(-1)!.sessionId, harness.registers.at(-1)!.cwd);
      const metaRows = transcriptNow
        ? readFileSync(transcriptNow, 'utf8').split('\n').filter((line) => line.includes(steerMarker))
        : [];
      // What the adapter will key on, read off the row rather than inferred: is it `isMeta`, and
      // does it carry the text as a user message. Recorded whether or not the count check passes.
      const steerRows = transcriptRows(transcriptNow).filter((row) => JSON.stringify(row).includes(steerMarker));
      emit('steer-row-shapes', { count: steerRows.length, isMeta: steerRows.map((row) => row.isMeta ?? null), roles: steerRows.map((row) => row.message?.role ?? null) });
      writeFileSync(join(outDir, 'steer-rows.json'), JSON.stringify({ marker: steerMarker, rows: metaRows.map((line) => JSON.parse(line)) }, null, 2));
      emit('steer-row', { found: metaRows.length, shape: metaRows[0]?.slice(0, 400) ?? 'no row carried the marker' });
      check('a steered row reached the transcript', metaRows.length > 0, metaRows.length ? 'see steer-rows.json' : 'nothing carried the marker');
    } else {
      await dismissDialog();
    }
  }

  if (step('hold-long')) {
    // A held call has no deadline: it waits on the app for as long as Claude's own dialog would.
    // Minutes rather than seconds, because every bound a hold used to have -- a 60 s deadline, a
    // poll budget, the hook's 10 s of its own time, the fetch's 30 s -- is shorter than this wait.
    harness.setViewers(1);
    harness.setMode('default');
    const waitMs = Number(flag('--long-hold-ms', '180000'));
    const hold = await probe('cmts-long-hold', writePrompt('cmts-long-hold'));
    if (check('the long hold reached the broker', !!hold?.card, JSON.stringify(hold ?? null))) {
      const heldId = hold!.cardId ?? hold!.requestId;
      const modSession = modSessionOf(hold!.sessionId);
      const eventsFrom = harness.events.length;
      const startedAt = Date.now();
      let letGo = false;
      while (Date.now() - startedAt < waitMs) {
        await sleep(5000);
        if (!harness.service.isHeld(modSession, heldId)) {
          letGo = true;
          break;
        }
      }
      const waited = Date.now() - startedAt;
      const row = auditOf(hold!);
      check(`a held call is still waiting on the app after ${Math.round(waitMs / 1000)} s`,
        !letGo && !row?.answeredBy && !row?.released && !ran('cmts-long-hold'),
        `waited ${waited} ms, held=${String(!letGo)}: ${JSON.stringify(row ?? null).slice(0, 200)}`);
      check('the terminal never handed the call back while it waited',
        !harness.events.slice(eventsFrom).some((event) => event.kind === 'user-cancel' && event.requestId === hold!.requestId),
        JSON.stringify(harness.events.slice(eventsFrom).map((event) => event.kind)));
      answer(hold!, 'approve');
      const ranIt = await waitFor(() => ran('cmts-long-hold'), 45_000);
      check('the app\u2019s answer, minutes later, still runs the call', ranIt, probeFile('cmts-long-hold'));
      const settled = auditOf(hold!);
      check('the audit records it answered from the app, after a poll per park',
        settled?.answeredBy === 'app' && (settled?.polls ?? 0) >= Math.floor(waitMs / 30_000),
        JSON.stringify(settled ?? null).slice(0, 200));
    } else {
      await dismissDialog();
    }
  }

  if (step('band-allow')) {
    const hold = await probe('cmts-band-allow', writePrompt('cmts-band-allow'));
    if (check('the second hold reached the broker', !!hold?.card, JSON.stringify(hold ?? null))) {
      // The mod puts its band up only once the broker answers that it is holding the call, so the
      // broker's own state is the band's precondition. Each of the three buttons is then proven by
      // what pressing it leaves behind: a band answer (allow, deny) or a user-cancel event (dialog).
      // The broker keys a held call by the card id it minted; the audit row keeps the mod's own id.
      const heldId = hold!.cardId ?? hold!.requestId;
      const heldRow = auditOf(hold!);
      check('the broker is holding the call, which is what puts the band up',
        harness.service.isHeld(modSessionOf(hold!.sessionId), heldId) && !heldRow?.released,
        `${heldId} held=${String(harness.service.isHeld(modSessionOf(hold!.sessionId), heldId))} released=${String(heldRow?.released ?? null)}`);
      const card = harness.cards.find((entry) => entry.requestId === heldId);
      check('the card says what is being approved', typeof card?.inputPreview === 'string' && card.inputPreview.includes('cmts-band-allow'),
        JSON.stringify(card?.inputPreview ?? null));
      check('the card names the mode it was decided in', typeof card?.permissionMode === 'string' && card.permissionMode.length > 0, String(card?.permissionMode));
      check('a card that waits is a card the hub may count as blocking', card?.blocking !== false, String(card?.blocking));
      const route = await pressBandKey(hold!.requestId, '1');
      emit('band-route', { button: 'allow', route });
      const row = auditOf(hold!);
      check('the band answered from the terminal', row?.answeredBy === 'band', String(row?.answeredBy) + ' via ' + route);
      const written = await waitFor(() => ran('cmts-band-allow'), 45_000);
      check('the band answer ran the call', written, probeFile('cmts-band-allow'));
      // The session's own record of what the tool said, which is the permission outcome rather
      // than a screenshot of a moment.
      const outcome = await waitFor(() => toolOutcomes(currentTranscript()).some((entry) => entry.name === 'Write'), 30_000);
      const write_ = toolOutcomes(currentTranscript()).filter((entry) => entry.name === 'Write').at(-1);
      check('the transcript records the allowed Write as a result, not an error',
        outcome && write_ !== undefined && !write_.isError, JSON.stringify(write_ ?? null).slice(0, 200));
    } else {
      await dismissDialog();
    }
  }

  if (step('band-deny')) {
    const hold = await probe('cmts-band-deny', writePrompt('cmts-band-deny'));
    if (check('the third hold reached the broker', !!hold?.card, JSON.stringify(hold ?? null))) {
      const route = await pressBandKey(hold!.requestId, '2');
      emit('band-route', { button: 'deny', route });
      const row = auditOf(hold!);
      check('the band denied from the terminal', row?.answeredBy === 'band', String(row?.answeredBy) + ' via ' + route);
      await sleep(3000);
      check('the denied call did not run', !ran('cmts-band-deny'), probeFile('cmts-band-deny'));
      const denied = await waitFor(() => toolOutcomes(currentTranscript()).some((entry) => entry.name === 'Write' && entry.isError), 30_000);
      const deniedRow = toolOutcomes(currentTranscript()).filter((entry) => entry.name === 'Write' && entry.isError).at(-1);
      check('the transcript records the denial as an errored tool result', denied, JSON.stringify(deniedRow ?? null).slice(0, 200));
      await dismissDialog();
    } else {
      await dismissDialog();
    }
  }

  if (step('band-dialog')) {
    const seat = await liveSeat();
    const framesFrom = harness.frames.length;
    const hold = await probe('cmts-own-dialog', writePrompt('cmts-own-dialog'));
    if (check('the fourth hold reached the broker', !!hold?.card, JSON.stringify(hold ?? null))) {
      // Only events from here on count: request ids restart in every process, so a user-cancel a
      // previous process sent for its own cm-N must not stand in for this one.
      const eventsFrom = harness.events.length;
      const route3 = await pressBandKey(hold!.requestId, '3', false);
      emit('band-route', { button: 'dialog', route: route3 });
      await sleep(2000);
      const modSession = modSessionOf(hold!.sessionId);
      check('button 3 handed the call back to Claude over the event leg',
        userCancelSeen(harness.events.slice(eventsFrom), modSession, hold!.requestId),
        `user-cancel for ${hold!.requestId} in ${modSession}: ${JSON.stringify(harness.events.slice(eventsFrom).map((event) => event.kind))}`);
      const row = auditOf(hold!);
      check('choosing the dialog answered nothing on the human\u2019s behalf', !row?.answeredBy || row.answeredBy === 'cancel', JSON.stringify(row ?? null));
      // What the app was shown: the card closed as answered in the terminal, not by another client.
      await waitFor(() => !!seat && closedByTerminal(seatFrames(seat, framesFrom), hold!.cardId ?? '').ok, 10_000);
      const closed = seat ? closedByTerminal(seatFrames(seat, framesFrom), hold!.cardId ?? '') : { ok: false, detail: 'no synced seat: the transcript did not exist yet' };
      check('the card button 3 closed says the terminal answered it (releaseReason band)', closed.ok, closed.detail);
      // Claude's own dialog is what decides the call now; the smoke declines it there. The proof
      // is that call's own result in the transcript -- this step's Write, by its file name -- not
      // dialog text on the pane, which the previous step's dialog had already put there.
      await dismissDialog();
      await waitFor(() => writeDeclinedByClaude(transcriptRows(currentTranscript()), 'cmts-own-dialog.txt', ran('cmts-own-dialog')).ok, 30_000);
      const declined = writeDeclinedByClaude(transcriptRows(currentTranscript()), 'cmts-own-dialog.txt', ran('cmts-own-dialog'));
      check("Claude's own dialog decided the call the band handed back", declined.ok, declined.detail);
    } else {
      await dismissDialog();
    }
  }

  if (step('escape-mid-hold')) {
    // P-1 on a real Claude: Escape at the keyboard while the app holds the call takes it back, and
    // the app's card says the terminal answered it.
    const seat = await liveSeat();
    const framesFrom = harness.frames.length;
    const hold = await probe('cmts-escape-held', writePrompt('cmts-escape-held'));
    if (check('the Escape step\u2019s call is held for the app', !!hold?.card, JSON.stringify(hold ?? null))) {
      const modSession = modSessionOf(hold!.sessionId);
      const eventsFrom = harness.events.length;
      keys('Escape');
      await waitFor(() => userCancelSeen(harness.events.slice(eventsFrom), modSession, hold!.requestId), 15_000);
      const cancel = harness.events.slice(eventsFrom).find((event) => event.kind === 'user-cancel' && event.sessionId === modSession && event.requestId === hold!.requestId);
      check('Escape took the held call back over the event leg', !!cancel, JSON.stringify(cancel ?? harness.events.slice(eventsFrom).map((event) => event.kind)));
      emit('escape-mid-hold', { via: cancel?.detail?.via ?? null });
      await waitFor(() => !!seat && closedByTerminal(seatFrames(seat, framesFrom), hold!.cardId ?? '').ok, 10_000);
      const closed = seat ? closedByTerminal(seatFrames(seat, framesFrom), hold!.cardId ?? '') : { ok: false, detail: 'no synced seat: the transcript did not exist yet' };
      check('the card Escape closed says the terminal answered it (releaseReason band)', closed.ok, closed.detail);
      await sleep(2000);
      check('and the call Escape took back never ran', !ran('cmts-escape-held'), probeFile('cmts-escape-held'));
    } else {
      await dismissDialog();
    }
    await settle();
  }

  if (step('clear-reregisters')) {
    const before = harness.registers.map((entry) => entry.sessionId);
    await submit('/clear');
    // The build does not re-fire `session.start` for a plugin mod after /clear, so the poll
    // loop's own re-register is the only route. Give it a real wait, not a fixed nap.
    const clearDeadline = Date.now() + 30_000;
    while (Date.now() < clearDeadline && harness.registers.every((entry) => before.includes(entry.sessionId))) await sleep(1000);
    const hold = await probe('cmts-after-clear', writePrompt('cmts-after-clear'));
    const after = harness.registers.map((entry) => entry.sessionId);
    check('the mod re-registered after /clear under a new id', after.length > before.length && !before.includes(after.at(-1)!), JSON.stringify(before) + ' -> ' + JSON.stringify(after));
    check('the session still holds after /clear', !!hold, JSON.stringify(hold ?? null));
    if (hold?.card) {
      answer(hold, 'approve');
      await sleep(4000);
    }
    await dismissDialog();
  }

  if (step('question')) {
    const seat = await liveSeat();
    const framesFrom = harness.frames.length;
    // Two questions in one call: a single choice, and a multi-select whose labels hold a comma and
    // a double quote -- labels the app used to leave to the terminal. The wording is the one a
    // 2026-10-06 probe used to get these labels out of the model exactly.
    const hold = await probe('cmts-question', 'Call the AskUserQuestion tool exactly once with these two questions and nothing else. '
      + 'Question 1: question "Which colour?", header "Colour", multiSelect false, option labels "Red" and "Blue". '
      + 'Question 2: question "Which phrases?", header "Phrases", multiSelect true, option labels exactly: Paris, France | Say "hi", now | Tokyo '
      + '(three options; the labels are separated by | here, do not include the |). Do not answer it yourself.',
    { timeoutMs: 90_000, tool: 'AskUserQuestion' });
    if (check('the question reached the broker', !!hold?.card, JSON.stringify(hold ?? null))) {
      const card = harness.cards.find((entry) => entry.requestId === (hold!.cardId ?? hold!.requestId));
      check('the question card is a question card', card?.kind === 'question', String(card?.kind));
      check('the question card carried the questions', Array.isArray(card?.questions), JSON.stringify(card?.questions ?? null).slice(0, 200));
      const questions = card?.questions as { question: string; multiple?: boolean; options: { label: string }[] }[];
      // The app's shape, which is the contract's: `outbound_frame.dart` answers a question with
      // one row per question and the picked labels in each row, and the broker converts using the
      // questions the hold carries. This step used to call `service.send` with a
      // `{ question: label }` map -- a shape no client can produce, which the queue accepted and
      // nobody consumed -- so the answer sat there while the mod parked on the hold, and the run
      // still called it green. Answering the hold is the only route that can reach the tool.
      // A multi-select picks the labels that need quoting, so the answer that comes back is the
      // case under test rather than one a plain comma join would also have produced.
      const rows: string[][] = (questions ?? []).map((question) => {
        const labels = (question.options ?? []).map((option) => option.label);
        if (!question.multiple) return [labels[0] ?? 'Red'];
        const quoted = labels.filter((label) => label.includes(', ') || label.includes('"'));
        return quoted.length > 0 ? quoted : labels.slice(0, 2);
      });
      emit('question-labels', {
        questions: (questions ?? []).map((question) => ({
          question: question.question, multiple: question.multiple ?? false, labels: (question.options ?? []).map((option) => option.label),
        })),
        rows,
      });
      const accepted = harness.service.answerQuestion({
        sessionId: modSessionOf(hold!.sessionId),
        requestId: hold!.cardId ?? hold!.requestId,
        answers: rows,
      });
      check('the hold took the app answer', accepted, JSON.stringify(rows));
      // Matched on the transcript, in the shape Claude answers its own tool with. A pane check
      // here used to read the marker the harness had just typed into a variable, which is a green
      // light wired to nothing; the tool_result row is the answer arriving back as the tool's
      // result, which is the whole claim.
      const chosen = rows[0]?.[0] ?? 'Red';
      const answeredRow = await waitFor(() => toolOutcomes(currentTranscript())
        .some((entry) => entry.name === 'AskUserQuestion' && entry.text.includes(chosen) && !entry.isError), 45_000);
      const questionOutcome = toolOutcomes(currentTranscript()).filter((entry) => entry.name === 'AskUserQuestion').at(-1);
      check('the answered question came back as the tool\u2019s result', answeredRow,
        JSON.stringify(questionOutcome ?? null).slice(0, 240));
      // Claude's own record of the answers, read off the tool's result object: each one spelled as
      // its picker spells it, so a label holding a comma is still one label to the model.
      const expected = Object.fromEntries((questions ?? []).map((question, index) => [question.question,
        question.multiple ? modJoinLabels(rows[index] ?? []) : (rows[index]?.[0] ?? '')]));
      const firstQuestion = questions?.[0]?.question ?? '';
      await waitFor(() => questionAnswers(transcriptRows(currentTranscript()), firstQuestion) !== undefined, 15_000);
      const recorded = questionAnswers(transcriptRows(currentTranscript()), firstQuestion);
      check('Claude recorded every answer exactly as its own picker would have written it',
        recorded !== undefined && Object.keys(expected).length === 2 && JSON.stringify(recorded) === JSON.stringify(expected),
        `recorded ${JSON.stringify(recorded ?? null)} expected ${JSON.stringify(expected)}`);
      check('the multi-select carried a label with a comma or a quote',
        rows.some((row) => row.some((label) => label.includes(', ') || label.includes('"'))), JSON.stringify(rows));
      const questionRow = auditOf(hold!);
      check('the broker recorded the answer as answered, not dropped', questionRow?.answeredBy === 'app', JSON.stringify(questionRow ?? null).slice(0, 200));
      // A refusal would have looked like a dropped answer: the app sent it, the broker kept it,
      // and the only witness is the log line the socket wrote.
      const refused = harness.log.filter((line) => line.includes(hold!.requestId) && /refus|reject|invalid|dropped/i.test(line));
      check('the answer was not refused on the way in', refused.length === 0, refused.join(' / ').slice(0, 200));
      // What the app was shown. Claude's call id is the card's, so the transcript's copy and the
      // held one are one card; and the card closed carrying the rows the app sent.
      const call = toolCallsOf(transcriptRows(currentTranscript())).filter((entry) => entry.name === 'AskUserQuestion').at(-1);
      check('the question card carries the call\u2019s own tool_use id', !!call && hold!.cardId === call.id,
        `card ${hold!.cardId ?? '(none)'}, call ${call?.id ?? '(none)'}`);
      if (seat && call) {
        await waitFor(() => questionResolvedWith(seatFrames(seat, framesFrom), call.id, rows).ok
          && seatFrames(seat, framesFrom).filter((frame) => frame.message.type === 'question-resolved').length >= 2, 15_000);
        const one = oneQuestionCard(seatFrames(seat, framesFrom), call.id);
        check('the app saw exactly one question card, under the call\u2019s tool_use id', one.ok, one.detail);
        const closedWith = questionResolvedWith(seatFrames(seat, framesFrom), call.id, rows);
        check('the question card closed carrying the rows the app sent', closedWith.ok, closedWith.detail);
        // P-8(a): and saying who answered it, so the seat that sent the answer reads "Answered in
        // the app" rather than "Settled in your terminal or another app", after a reload too.
        const by = questionClosedBy(seatFrames(seat, framesFrom), call.id, 'app');
        check('every close of the question the app answered says decidedBy app', by.ok, by.detail);
      } else {
        check('a synced seat watched the question', false, seat ? 'no AskUserQuestion call in the transcript' : 'no synced seat: the transcript did not exist yet');
      }
    }
    await dismissDialog();
  }

  if (step('question-band-dialog')) {
    // R5-A on a real Claude: band 1 on a held question hands it to Claude's own picker. The app keeps
    // the card, read-only and open in the terminal, and the session Needs input until the picker is
    // answered there. Then the picker's answer closes that one card. Before the fix the card closed at
    // once with nothing picked, and the session read Working while the picker waited on a person.
    await settle();
    harness.setViewers(1);
    harness.setMode('default');
    const seat = await liveSeat();
    const framesFrom = harness.frames.length;
    const question = 'Which shape?';
    const hold = await probe('cmts-question-band', 'Call the AskUserQuestion tool exactly once with one question and nothing else: '
      + `question "${question}", header "Shape", multiSelect false, option labels "Circle" and "Square". Do not answer it yourself.`,
    { timeoutMs: 90_000, tool: 'AskUserQuestion' });
    if (check('the band step\u2019s question is held for the app', !!hold?.card && !!seat,
      `${JSON.stringify(hold ?? null)}${seat ? '' : ' (no synced seat: the transcript did not exist yet)'}`)) {
      const toolUseId = hold!.cardId ?? hold!.requestId;
      const modSession = modSessionOf(hold!.sessionId);
      const eventsFrom = harness.events.length;
      const route = await pressBandKey(undefined, '1', false);
      emit('band-route', { button: 'question-dialog', route });
      const cancel = harness.events.slice(eventsFrom).find((event) => event.kind === 'user-cancel' && event.sessionId === modSession);
      check('band 1 handed the question to Claude\u2019s picker over the event leg', cancel?.detail?.via === 'dialog',
        JSON.stringify(cancel ?? harness.events.slice(eventsFrom).map((event) => event.kind)));
      await waitFor(() => questionKeptInTerminal(seatFrames(seat!, framesFrom), toolUseId).ok, 10_000);
      // Long enough for anything that would close the card early to have done it.
      await sleep(3000);
      const kept = questionKeptInTerminal(seatFrames(seat!, framesFrom), toolUseId);
      check('after band 1 the seat still Needs input, with one read-only card open in the terminal under the call\u2019s id', kept.ok, kept.detail);
      check('and the call has no result yet: the picker is waiting on the person',
        !toolOutcomes(currentTranscript()).some((entry) => entry.id === toolUseId), toolUseId);
      // Answer Claude's own picker in the terminal, with its first option. A digit picks a row; the
      // keys after it are the build's confirmation, if it asks for one. Which ones it took is recorded.
      const answered = () => questionAnswers(transcriptRows(currentTranscript()), question) !== undefined;
      const pickerKeys: string[] = [];
      for (const key of ['1', 'Enter', 'Enter']) {
        if (answered()) break;
        if (key === 'Enter') keys('Enter');
        else type(key);
        pickerKeys.push(key);
        await waitFor(answered, 6000);
      }
      emit('picker-keys', { keys: pickerKeys, answered: answered() });
      const recorded = questionAnswers(transcriptRows(currentTranscript()), question);
      check('the picker\u2019s answer came back as the tool\u2019s result', recorded !== undefined, JSON.stringify(recorded ?? null));
      const rows = recorded ? [[recorded[question]!]] : [];
      await waitFor(() => questionSettledInTerminal(seatFrames(seat!, framesFrom), toolUseId, rows).ok, 15_000);
      await sleep(2000);
      const settled = questionSettledInTerminal(seatFrames(seat!, framesFrom), toolUseId, rows);
      check('the picker\u2019s answer closed that one card with the pick, and the seat no longer Needs input', settled.ok, settled.detail);
    }
    // Escape only when something is still up: after a recorded answer it would interrupt the reply.
    if (questionAnswers(transcriptRows(currentTranscript()), question) === undefined) await dismissDialog();
    await settle();
  }

  if (step('prompt-command')) {
    harness.service.send(harness.registers.at(-1)!.sessionId, {
      requestId: 'cmd-prompt',
      op: 'prompt',
      text: 'Reply with exactly the word PONG and nothing else.',
      queuedAt: Date.now(),
    });
    // `asUser: true` is the claim, and the transcript is the only place that can show it: a
    // steering row and a user message look the same in a pane until you read the row type.
    const promptText = 'Reply with exactly the word PONG and nothing else.';
    const asUser = await waitFor(() => userTexts(currentTranscript()).some((text) => text.includes(promptText)), 60_000);
    check('a prompt from the app landed as a user message', asUser,
      userTexts(currentTranscript()).filter((text) => text.includes('PONG')).join(' / ').slice(0, 180));
    const replied = await waitFor(() => assistantText(currentTranscript()).includes('PONG'), 60_000);
    check('the session answered the prompted turn', replied, assistantText(currentTranscript()).slice(-160));
  }

  if (step('turn-end-gap')) {
    // P-2's grace waits for the transcript's own closing row after the mod says a turn ended. It
    // has to sit above the real gap, or a normal turn closes as stopped. Measured on plain turns.
    await settle();
    const seat = await liveSeat();
    if (check('a synced seat is open on the live session', !!seat, currentTranscript() ?? 'no transcript')) {
      const framesFrom = harness.frames.length;
      const eventsFrom = harness.events.length;
      for (const word of ['ALPHA', 'BRAVO', 'CHARLIE']) {
        await submit(`Reply with exactly the word ${word} and nothing else.`);
        await settle();
        // Past the grace, so a turn the transcript had not closed in time shows as the grace's.
        await sleep(CLAUDE_MOD_TURN_END_GRACE_MS + 1500);
      }
      const gaps = turnEndGaps(harness.events.slice(eventsFrom), seatFrames(seat!, framesFrom), seat!.sessionId);
      emit('turn-end-gap', { graceMs: CLAUDE_MOD_TURN_END_GRACE_MS, gaps });
      check('each plain turn was closed by the transcript, not by the grace', gaps.length >= 3 && gaps.every((gap) => gap.closedBy === 'transcript'), JSON.stringify(gaps));
      check(`every measured turn.complete \u2192 end_turn gap sits under the ${CLAUDE_MOD_TURN_END_GRACE_MS} ms grace`,
        gaps.length >= 3 && gaps.every((gap) => gap.gapMs !== undefined && gap.gapMs < CLAUDE_MOD_TURN_END_GRACE_MS), JSON.stringify(gaps.map((gap) => gap.gapMs ?? null)));
    }
  }

  if (step('stop-no-hold')) {
    // P-2 on a real Claude: a Stop from the app on a running turn that holds nothing. `$.turn.abort`
    // writes no interruption row, so before the fix the row read Working until the next prompt.
    // The proof is what the seat told the app, timed from the mod's turn.complete.
    await settle();
    const seat = await liveSeat();
    if (check('a synced seat is open for the Stop', !!seat, currentTranscript() ?? 'no transcript')) {
      const framesFrom = harness.frames.length;
      const eventsFrom = harness.events.length;
      await seat!.conn.sendPrompt({ text: 'Write a 500-word story about a lighthouse keeper who counts ships at night. Use no tool.' });
      const running = await waitFor(() => harness.events.slice(eventsFrom).some((event) => event.kind === 'turn.start' && event.sessionId === seat!.sessionId)
        && seatFrames(seat!, framesFrom).some((frame) => frame.message.type === 'status' && frame.message.status === 'running'), 60_000);
      check('the app\u2019s prompt started a turn the seat drew as running', running,
        JSON.stringify(seatFrames(seat!, framesFrom).filter((frame) => frame.message.type === 'status').map((frame) => frame.message.status)));
      await sleep(1500);
      const sentAt = Date.now();
      await seat!.conn.runCommand('stop');
      await waitFor(() => appStopLeftIdle(seatFrames(seat!, framesFrom), harness.events.slice(eventsFrom), seat!.sessionId, sentAt, 2000).idleAfterMs !== undefined, 15_000);
      // Long enough for anything that would put the row back to Working to have done it.
      await sleep(3000);
      const left = appStopLeftIdle(seatFrames(seat!, framesFrom), harness.events.slice(eventsFrom), seat!.sessionId, sentAt, 2000);
      check('an app Stop with no hold leaves the session idle within 2 s of turn.complete', left.ok, left.detail);
      const resync = resyncShowsNotRunning(await seat!.conn.getHistory());
      check('a resync after the Stop draws the turn as not running', resync.ok, resync.detail);
      emit('stop-no-hold', { idleAfterMs: left.idleAfterMs ?? null, resync: resync.detail });
    }
    await settle();
  }

  if (step('stop-while-held')) {
    // R4-3 on a real Claude: a Stop from the app reaches a terminal whose turn is parked on a held
    // call. The proof is the turn's end on the broker's event leg, timed from the moment the Stop
    // went out, and the held Write never running.
    harness.setViewers(1);
    harness.setMode('default');
    const hold = await probe('cmts-stop-held', writePrompt('cmts-stop-held'));
    if (check('the Stop step\u2019s call is held for the app', !!hold?.card, JSON.stringify(hold ?? null))) {
      const modSession = modSessionOf(hold!.sessionId);
      const eventsFrom = harness.events.length;
      const sentAt = Date.now();
      const sent = harness.service.send(harness.registers.at(-1)!.sessionId, { requestId: 'cmd-stop-held', op: 'abort', queuedAt: sentAt });
      check('the broker took the Stop while the call was held', sent.ok === true, JSON.stringify(sent));
      await waitFor(() => stopEndedTurn(harness.events.slice(eventsFrom), modSession, sentAt, 2000).afterMs !== undefined, 15_000);
      const stopped = stopEndedTurn(harness.events.slice(eventsFrom), modSession, sentAt, 2000);
      check('with a hold open, a Stop from the app ends the turn within 2 s', stopped.ok, stopped.detail);
      emit('stop-while-held', { afterMs: stopped.afterMs ?? null, events: harness.events.slice(eventsFrom).map((event) => ({ kind: event.kind, requestId: event.requestId ?? null, afterMs: event.at - sentAt })) });
      await sleep(3000);
      check('and the held call never ran', !ran('cmts-stop-held'), probeFile('cmts-stop-held'));
    } else {
      await dismissDialog();
    }
    await settle();
  }

  if (step('prompt-while-held')) {
    // R4-3 on a real Claude: a prompt the app sends while a card is open is delivered, and the card
    // still decides its call. A plugin's prompt runs once the session is idle, so the proof is the
    // transcript's next user row after this step's own prompt, once the held turn has ended.
    harness.setViewers(1);
    harness.setMode('default');
    const stepPrompt = writePrompt('cmts-prompt-held');
    const hold = await probe('cmts-prompt-held', stepPrompt);
    if (check('the prompt step\u2019s call is held for the app', !!hold?.card, JSON.stringify(hold ?? null))) {
      const heldId = hold!.cardId ?? hold!.requestId;
      const modSession = modSessionOf(hold!.sessionId);
      const appPrompt = `Reply with exactly the word QUEUED${RUN_ID.toUpperCase()} and nothing else.`;
      const sent = harness.service.send(harness.registers.at(-1)!.sessionId, { requestId: 'cmd-prompt-held', op: 'prompt', text: appPrompt, queuedAt: Date.now() });
      check('the broker took the prompt while the card was open', sent.ok === true, JSON.stringify(sent));
      await sleep(3000);
      check('the card is still open after the prompt went out', harness.service.isHeld(modSession, heldId), heldId);
      answer(hold!, 'approve');
      check('the app\u2019s answer still ran the held call', await waitFor(() => ran('cmts-prompt-held'), 45_000), probeFile('cmts-prompt-held'));
      await waitFor(() => appPromptIsNextUserRow(transcriptRows(currentTranscript()), stepPrompt, appPrompt).ok, 90_000);
      const delivered = appPromptIsNextUserRow(transcriptRows(currentTranscript()), stepPrompt, appPrompt);
      check('a prompt the app sent while a card was open is the next user row in the transcript', delivered.ok, delivered.detail);
    } else {
      await dismissDialog();
    }
    await settle();
  }

  if (step('mode-from-prompt')) {
    // P-9 on a real Claude. A mode changed with shift+tab while the session is idle is written with
    // the next prompt, on that prompt's own row, and not before (owner decision (a): the transcript is
    // the only mode source). The seat's chip and the gate's read must both take it from there.
    await settle();
    harness.setViewers(1);
    const seat = await liveSeat();
    if (check('a synced seat is open for the mode step', !!seat, currentTranscript() ?? 'no transcript')) {
      pointGateAtLiveSession();
      const before = harness.observedMode();
      const framesFrom = harness.frames.length;
      const walk = [modeIndicator()];
      keys('BTab');
      await sleep(1600);
      walk.push(modeIndicator());
      // What an idle shift+tab left behind, recorded and not asserted: if the build ever writes the
      // mode at once, the seat follows earlier, which the rule below still accepts.
      emit('mode-idle-shift-tab', {
        walk, transcriptBefore: before ?? null, transcriptAfter: harness.observedMode() ?? null,
        seatAfter: seatMode(seatFrames(seat!, framesFrom)) ?? null,
      });
      // A Bash call the terminal asks about in default, acceptEdits and plan mode alike, so the next
      // ask reaches the gate whichever mode one press lands in.
      const stepPrompt = 'Run exactly this Bash command to check connectivity: '
        + "curl -sI https://example.com -o /dev/null -w '%{http_code}' . Report its output and stop. Use no other tool.";
      const hold = await probe('cmts-mode-prompt', stepPrompt, { timeoutMs: 90_000 });
      const card = hold?.cardId ? harness.cards.find((entry) => entry.requestId === hold.cardId) : undefined;
      if (hold?.card) {
        answer(hold, 'approve');
        await waitFor(() => auditOf(hold)?.answeredBy !== undefined, 30_000);
      } else if (hold) {
        // Released: Claude's own dialog has the call, and declining it there runs nothing.
        await dismissDialog();
      }
      const row = hold ? auditOf(hold) : undefined;
      await waitFor(() => modeFollowedPrompt(transcriptRows(currentTranscript()), seatFrames(seat!, framesFrom), stepPrompt, before, row?.modeSeen).ok, 15_000);
      const followed = modeFollowedPrompt(transcriptRows(currentTranscript()), seatFrames(seat!, framesFrom), stepPrompt, before, row?.modeSeen);
      emit('mode-from-prompt', {
        walk, before: before ?? null, promptMode: followed.promptMode ?? null, seat: seatMode(seatFrames(seat!, framesFrom)) ?? null,
        gate: row?.modeSeen ?? null, released: row?.released ?? null, card: card?.permissionMode ?? null,
      });
      check('after an idle shift+tab, the next prompt row carries the new mode, and the seat and the gate both read it', followed.ok, followed.detail);
      if (card) check('the held card names the prompt row\u2019s mode', card.permissionMode === followed.promptMode, `${card.permissionMode} vs ${followed.promptMode}`);
      await settle();
      // Back to the baseline the later steps were written against: the terminal in manual mode, and
      // the gate on the harness's pin.
      for (let press = 0; press < 6 && modeIndicator() !== 'manual mode on'; press += 1) {
        keys('BTab');
        await sleep(1600);
      }
      check('the terminal is back in manual mode after the mode step', modeIndicator() === 'manual mode on', String(modeIndicator()));
    }
    harness.setMode('default');
  }

  if (step('spawned-silent')) {
    // R4-6 on a real Claude. The harness hosts no Drive, so this starts a Claude the way a Drive does:
    // a child of the broker's own process, with `COSYNCING_SPAWNED=1`, headless, with the plugin and
    // the scratch cwd. The control is the same launch without the variable: the broker must refuse
    // it as a broker child, once, or the silent run would prove only a mod that never loaded.
    // `spawn`, not `spawnSync`: the socket is served by this process, and a blocked event loop would
    // turn the control's refusal into a request nobody answered.
    const inherited: Record<string, string | undefined> = { ...process.env };
    delete inherited.COSYNCING_CLAUDE_SOCK;
    delete inherited.COSYNCING_SPAWNED;
    const runEnv = Object.fromEntries(claudeEnv().map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]));
    const headless = async (label: string, extra: Record<string, string>) => {
      const sessionId = randomUUID();
      const logFrom = harness.log.length;
      const registersFrom = harness.registers.length;
      const child = spawn('claude', ['-p', '--model', model, '--plugin-dir', pluginDir, '--session-id', sessionId,
        '--debug', '--debug-file', join(SCRATCH, `${label}-debug.log`), 'Reply with exactly the word OK and nothing else.'],
      { cwd: workspace, env: { ...inherited, ...runEnv, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
      if (child.pid) headlessPids.push(child.pid);
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', () => {});
      const timer = setTimeout(() => child.kill('SIGTERM'), 180_000);
      const status = await new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
      clearTimeout(timer);
      turns += 1;
      // A request still on its way out lands within the poll loop's first backoff, not later.
      await sleep(3000);
      const debug = existsSync(join(SCRATCH, `${label}-debug.log`)) ? readFileSync(join(SCRATCH, `${label}-debug.log`), 'utf8') : '';
      const result = { label, sessionId, pid: child.pid ?? 0, status, stdout: stdout.trim().slice(0, 80), log: harness.log.slice(logFrom), registers: harness.registers.slice(registersFrom),
        modLines: debug.split('\n').filter((line) => line.includes('cosyncing:')).map((line) => line.slice(0, 200)).slice(0, 8) };
      emit('headless', result);
      return result;
    };
    const spawned = await headless('spawned', { COSYNCING_SPAWNED: '1' });
    check('a Claude started with COSYNCING_SPAWNED=1 ran its turn', spawned.status === 0 && /OK/.test(spawned.stdout), `exit ${spawned.status}: ${spawned.stdout}`);
    const silent = spawnedStayedSilent(spawned.registers, spawned.log, spawned.sessionId);
    check('and made no register request: nothing registered, and no "mod socket refused" line in the broker log', silent.ok, silent.detail);
    const control = await headless('control', {});
    check('the same launch without COSYNCING_SPAWNED ran its turn', control.status === 0 && /OK/.test(control.stdout), `exit ${control.status}: ${control.stdout}`);
    const refusedOnce = brokerChildRefusedOnce(control.log);
    check('and is refused as a broker child exactly once, so the silent run is the variable\u2019s doing', refusedOnce.ok, refusedOnce.detail);
  }

  if (step('plan-mode')) {
    // Plan mode, launched into rather than walked to, so the mode is on disk before the first ask.
    harness.setViewers(1);
    harness.setMode(undefined);
    await relaunch('plan-mode', ['--permission-mode', 'plan', '--model', model], 'plan');
    // An ordinary ask in plan mode is held like one in `default`. The command is the one a
    // 2026-10-06 probe saw Claude put to its own dialog in plan mode.
    const ask = await probe('cmts-plan-ask', 'Before planning anything, run exactly this Bash command to check connectivity: '
      + "curl -sI https://example.com -o /dev/null -w '%{http_code}' . Report its output and stop: make no plan and call no other tool.",
    { tool: 'Bash', timeoutMs: 90_000 });
    const askCard = ask?.cardId ? harness.cards.find((card) => card.requestId === ask.cardId) : undefined;
    emit('mode-read', { step: 'plan-mode', transcript: harness.observedMode() ?? null });
    if (check('a tool call Claude asks about in plan mode is held for the app', !!askCard && askCard.readOnly !== true,
      JSON.stringify(askCard ?? ask ?? null).slice(0, 300))) {
      check('its card names plan mode', askCard?.permissionMode === 'plan', String(askCard?.permissionMode));
      answer(ask!, 'approve');
      await waitFor(() => auditOf(ask!)?.answeredBy !== undefined, 30_000);
      check('the app answered it in plan mode', auditOf(ask!)?.answeredBy === 'app', JSON.stringify(auditOf(ask!) ?? null).slice(0, 200));
      const bashDone = await waitFor(() => toolOutcomes(currentTranscript()).some((entry) => entry.name === 'Bash'), 45_000);
      const bash = toolOutcomes(currentTranscript()).filter((entry) => entry.name === 'Bash').at(-1);
      check('and Claude ran the call it was allowed', bashDone && bash !== undefined && !/doesn't want to proceed|was rejected/i.test(bash.text),
        JSON.stringify(bash ?? null).slice(0, 200));
    } else {
      await dismissDialog();
    }
    await settle();

    // Claude's plan: shown in the app, answered only in the terminal. In plan mode Claude may also
    // ask to write its own plan file; such a call is answered here so the turn reaches the plan,
    // and anything else is refused.
    const planCardsFrom = harness.cards.length;
    const swept: string[] = [];
    const sweeper = setInterval(() => {
      for (const card of harness.cards.slice(planCardsFrom)) {
        if (card.toolName === 'ExitPlanMode' || card.readOnly === true || swept.includes(card.requestId)) continue;
        if (!harness.service.isHeld(modSessionOf(card.sessionId), card.requestId)) continue;
        swept.push(card.requestId);
        const ownPlanFile = /\.claude\/plans\//.test(`${card.inputPreview ?? ''} ${card.detail ?? ''}`);
        harness.service.approve({ sessionId: modSessionOf(card.sessionId), requestId: card.requestId, decision: ownPlanFile ? 'approve' : 'reject' });
        emit('plan-step-other-hold', { tool: card.toolName ?? null, preview: card.inputPreview ?? null, decision: ownPlanFile ? 'approve' : 'reject' });
      }
    }, 1000);
    const plan = await probe('cmts-plan', 'Plan this task: create a file named cmts-plan.txt in the current directory containing the single word ready. '
      + 'Keep the plan to one line and present it for approval with ExitPlanMode. Do not create the file yet.',
    { tool: 'ExitPlanMode', timeoutMs: 150_000 });
    clearInterval(sweeper);
    const planCard = plan?.cardId ? harness.cards.find((card) => card.requestId === plan.cardId) : undefined;
    check("Claude's plan is shown in the app, read-only", planCard?.readOnly === true && planCard.blocking === false,
      JSON.stringify(planCard ?? null).slice(0, 300));
    check('the card says why: a plan is answered in the terminal', planCard?.releaseReason === 'plan:terminal-only', String(planCard?.releaseReason));
    check('the card leads with the plan', typeof planCard?.inputPreview === 'string' && planCard.inputPreview.startsWith('plan:'),
      String(planCard?.inputPreview));
    check('the app cannot approve the plan', plan !== undefined && answer(plan, 'approve') === false, plan?.cardId ?? 'no card');
    const planRow = plan ? auditOf(plan) : undefined;
    check('the audit records the plan as left to the terminal', planRow?.released === 'plan:terminal-only', JSON.stringify(planRow ?? null).slice(0, 200));
    // Claude's "Ready to code?" dialog is the plan's only seat. Declined there, nothing is built.
    await sleep(2000);
    await dismissDialog();
    await sleep(3000);
    check('declined in the terminal, the plan built nothing', !ran('cmts-plan'), probeFile('cmts-plan'));
    await settle();
  }

  if (step('dontask-no-card')) {
    // dontAsk: Claude refuses whatever would need asking, so the app has nothing to answer and
    // shows nothing -- not even a read-only note, which would only report a refusal Claude made.
    harness.setViewers(1);
    harness.setMode(undefined);
    await relaunch('dontAsk', ['--permission-mode', 'dontAsk', '--model', model], 'dontAsk');
    const cardsFrom = harness.cards.length;
    const hold = await probe('cmts-dontask', writePrompt('cmts-dontask'), { timeoutMs: 60_000 });
    if (hold?.card) {
      // Cleared rather than left: a held call in a mode that must not hold would decide the next turn.
      answer(hold, 'reject');
    }
    await sleep(6000);
    emit('mode-read', { step: 'dontask-no-card', transcript: harness.observedMode() ?? null });
    const drawn = harness.cards.slice(cardsFrom);
    check('dontAsk draws nothing in the app, not even a note', drawn.length === 0,
      JSON.stringify(drawn.map((card) => [card.toolName, card.releaseReason ?? null])));
    check('a dontAsk call is released by name, never held', hold === undefined || hold.released === 'mode:dontAsk',
      hold === undefined ? 'the engine never asked the mod' : String(hold.released ?? 'held'));
    // Only a call cosyncing did not hold is Claude's refusal: a held one was refused by the reject above.
    check('Claude refused the call itself', !hold?.card && !ran('cmts-dontask'),
      hold?.card ? 'cosyncing held it, so the app\u2019s reject refused it, not Claude' : probeFile('cmts-dontask'));
    await dismissDialog();
  }

  if (step('auto-never-hold')) {
    // Auto mode is the one mode this feature must never enter: Claude runs its own classifier
    // there, and a mod `allow` would sit in that seat. The mode is read from the session's real
    // transcript with the harness's own pin released, so this is also the only step that proves
    // the broker's mode read against a live session rather than a fixture. Run it on Sonnet:
    // auto mode's behaviour is a model's judgement, and Haiku is not the model a user meets it
    // with. One turn.
    const beforePid = harness.registers.at(-1)?.peerPid ?? 0;
    shutdown();
    await sleep(2000);
    // Auto mode is a model's judgement, and Haiku is not the model a user meets it with, so this
    // step is the one place the run spends Sonnet. `--auto-model` overrides it for a rerun that
    // must not -- and it is not a free override: 2.1.290 does not offer auto mode to Haiku at all,
    // so an `--auto-model haiku` run proves the mode READ and not the auto rule, and says so.
    // Launched into auto mode, so the mode is on disk before the first call (see relaunch); the
    // shift+tab walk below still runs, from auto round to auto. Haiku is not offered auto mode, so
    // an `--auto-model haiku` rerun launches plain and walks, as before.
    const autoFlag = autoModel === 'haiku' ? [...BASELINE_MODE] : ['--permission-mode', 'auto'];
    launchClaude(pluginDir, [...autoFlag, '--model', autoModel]);
    emit('auto-mode-launched', { model: autoModel, route: autoModel === 'haiku' ? 'manual, then shift+tab in session' : '--permission-mode auto, then a shift+tab cycle' });
    const launchedInTime = await waitForNewProcess(beforePid);
    check('the relaunched terminal registered', launchedInTime, `waiting for a pid other than ${beforePid}`);
    await refuseTrustPrompt('the auto-mode launch');
    const drawnBeforeTurn = await paneReady();
    emit('pane-ready', { step: 'auto-never-hold', drawn: drawnBeforeTurn });
    harness.setViewers(1);
    // Nothing in this step may read a mode the harness set. `setMode(undefined)` empties the
    // harness's own file first, so a session with no transcript reads as unknown -- the same thing
    // the gate would say -- rather than as whatever an earlier step left pinned. Skipping steps
    // used to hand this step a stale `default`, and it held a session that was in auto mode.
    harness.setMode(undefined);
    // Re-arm immediately: every moment between here and the probe is a chance for the read to be
    // pointing at a transcript that no longer describes the live session.
    pointGateAtLiveSession();
    // shift+tab, measured rather than assumed, and it cost three smoke runs to learn: on this
    // build the chord walks manual -> accept edits -> plan, and returns to auto only when the
    // session's model offers auto mode at all. Measured on 2.1.290 with the same launch flags and
    // nothing else changed -- Sonnet produced `permission-mode: auto` rows from these presses,
    // Haiku never did, only default / acceptEdits / plan. So the walk records what the model
    // offers, parks the session in auto when it can, and spends no model turn doing it.
    const walk: (string | undefined)[] = [modeIndicator()];
    for (let press = 0; press < 6; press += 1) {
      keys('BTab');
      await sleep(1600);
      walk.push(modeIndicator());
      const now = walk.at(-1);
      if (now === 'auto mode on') break;
      // Back where the cycle started means this model's cycle is closed and auto is not in it.
      if (press >= 2 && now !== undefined && walk.slice(1, -1).includes(now)) break;
    }
    const indicator = walk.at(-1);
    const autoOffered = walk.includes('auto mode on');
    emit('mode-walk', { model: autoModel, walk, autoOffered, transcriptModeBefore: harness.observedMode() ?? null });
    check('shift+tab walks the modes the terminal names',
      ['manual mode on', 'accept edits on', 'plan mode on'].every((mode) => walk.includes(mode)),
      `${JSON.stringify(walk)} on ${autoModel}`);
    check('the terminal is in auto mode when the call arrives', indicator === 'auto mode on' || !autoOffered,
      autoOffered ? `indicator ${String(indicator)}` : `${autoModel} is not offered auto mode; cycle ${JSON.stringify(walk)}`);

    pointGateAtLiveSession();
    const autoCardsFrom = harness.cards.length;
    const hold = await probe('cmts-auto-mode', writePrompt('cmts-auto-mode'));
    if (hold?.card) {
      // Cleared rather than left dangling: a held call in a mode that must not hold would
      // otherwise decide the next step's turn too.
      answer(hold, 'reject');
      await sleep(2000);
    }
    // Now the transcript has rows, so the mode read can be checked against the terminal itself.
    // The two do not use the same words -- the pane's `manual mode on` is `default` in the
    // transcript -- and the mapping below is the adapter's contract for the gate, measured here
    // against a real session rather than asserted from a fixture.
    const seen: string | undefined = harness.observedMode();
    const asTranscript: Record<string, string> = {
      'auto mode on': 'auto',
      'manual mode on': 'default',
      'accept edits on': 'acceptEdits',
      'plan mode on': 'plan',
    };
    emit('mode-read', { pane: indicator ?? null, transcript: seen ?? null });
    check('the broker reads the mode the terminal is in',
      indicator !== undefined && seen === asTranscript[indicator],
      `pane ${String(indicator)} vs transcript ${seen ?? 'no mode on record'}`);
    // Two shapes honour the rule and one breaks it. The engine's own classifier can settle the
    // call before the mod is consulted, so nothing reaches the broker; or the engine asks and the
    // gate names the mode it saw. A card in the app is the break. The names it may answer with
    // are `auto` (it saw the mode) and `unknown` (the mode was chosen before the session had
    // written a row, which is the case here and is safe in the same direction); what it may never
    // do is hold a call in auto mode.
    // The auto rule is asserted only of a session that is in auto mode. On a model that is not
    // offered auto mode there is nothing to assert, and a check that passes because the case never
    // happened is the kind of green this review exists to remove.
    if (indicator === 'auto mode on') {
      const releaseOk = hold === undefined || hold.released === 'mode:auto';
      check('auto mode never raises an approval card', !hold?.card,
        JSON.stringify(hold ?? null) + ` indicator=${String(indicator)}`);
      // Auto mode is Claude's classifier's seat, and a note in the app would report a decision
      // nobody there can make, so a released call draws nothing at all.
      const drawn = harness.cards.slice(autoCardsFrom);
      check('auto mode draws nothing in the app for a tool call, not even a note', drawn.length === 0,
        JSON.stringify(drawn.map((card) => [card.toolName, card.releaseReason ?? null])));
      check('an auto session is released by name, never held', releaseOk,
        hold === undefined ? 'the engine never asked the mod: its classifier answered' : `${hold.released ?? 'held'} (transcript mode: ${seen ?? 'no row'})`);
    } else {
      emit('auto-rule-not-exercised', {
        model: autoModel, indicator: indicator ?? null,
        reason: 'this model is not offered auto mode on 2.1.290, so the step cannot assert the auto rule',
      });
    }
    await sleep(6000);
    // Claude's own way has two shapes on this build and both are Claude deciding: its classifier
    // runs the call, or it puts its own dialog to the human, which the smoke declines. A cosyncing
    // card is the shape that breaks the rule, and the assertion above is the one that catches
    // that, so this one records which of the two honest shapes happened rather than betting on
    // one -- from this step's Write and its result in the transcript, never from the pane, whose
    // dialog text the band steps had already left on it.
    await dismissDialog();
    emit('auto-mode-shape', { engineAskedTheMod: hold !== undefined, released: hold?.released ?? null });
    if (indicator === 'auto mode on') {
      await waitFor(() => writeSettledByClaude(transcriptRows(currentTranscript()), 'cmts-auto-mode.txt', ran('cmts-auto-mode')).ok, 30_000);
      const settled = writeSettledByClaude(transcriptRows(currentTranscript()), 'cmts-auto-mode.txt', ran('cmts-auto-mode'));
      check('auto mode left the call to Claude', !hold?.card && settled.ok,
        hold?.card ? `cosyncing held ${hold.requestId} instead` : `${settled.how}: ${settled.detail}`);

      // Questions stay the person's in auto mode: the classifier decides tool calls, not answers.
      // The second question asks for a number where the tool takes one. The number kind sits
      // behind a Claude feature switch, so the step records whether it arrived and answers
      // whichever kind did.
      await settle();
      const asked = await probe('cmts-auto-question', 'Call the AskUserQuestion tool exactly once with these two questions and nothing else. '
        + 'Question 1: question "Which colour?", header "Colour", multiSelect false, option labels "Red" and "Blue". '
        + 'Question 2: question "How many workers?", header "Workers": if your AskUserQuestion tool accepts a question kind "number" with min and max, '
        + 'make it kind "number" with min 1, max 8 and no options; otherwise give it the option labels "2" and "4". Do not answer it yourself.',
      { tool: 'AskUserQuestion', timeoutMs: 120_000 });
      const askedCard = asked?.cardId ? harness.cards.find((card) => card.requestId === asked.cardId) : undefined;
      if (check('a question in auto mode is held for the app', !!askedCard && askedCard.readOnly !== true, JSON.stringify(asked ?? null))) {
        const questions = (askedCard!.questions ?? []) as { question: string; kind?: string; min?: number; max?: number; options?: { label: string }[] }[];
        const numberQuestion = questions.find((question) => question.kind === 'number');
        const numberAnswer = numberQuestion ? String(Math.min(numberQuestion.max ?? 5, Math.max(numberQuestion.min ?? 5, 5))) : undefined;
        emit('number-kind', { offered: numberQuestion !== undefined, model: autoModel, question: numberQuestion ?? null });
        const rows = questions.map((question) => question.kind === 'number' ? [numberAnswer!] : [question.options?.[0]?.label ?? 'Red']);
        check('the app answered the auto-mode question', harness.service.answerQuestion({
          sessionId: modSessionOf(asked!.sessionId), requestId: asked!.cardId ?? asked!.requestId, answers: rows,
        }), JSON.stringify(rows));
        const first = questions[0]?.question ?? '';
        await waitFor(() => questionAnswers(transcriptRows(currentTranscript()), first) !== undefined, 45_000);
        const recorded = questionAnswers(transcriptRows(currentTranscript()), first);
        const expected = Object.fromEntries(questions.map((question, index) => [question.question, rows[index]![0]!]));
        check('auto mode: Claude recorded the app\u2019s answers as the tool\u2019s result',
          recorded !== undefined && JSON.stringify(recorded) === JSON.stringify(expected),
          `recorded ${JSON.stringify(recorded ?? null)} expected ${JSON.stringify(expected)}`);
        if (numberQuestion) {
          check('a number question was answered from the app with a number', recorded?.[numberQuestion.question] === numberAnswer,
            JSON.stringify(recorded ?? null));
        } else {
          emit('number-kind-not-exercised', { model: autoModel, reason: 'the model\u2019s AskUserQuestion offered no number kind on this account' });
        }
      }
      await dismissDialog();
    }
  }

  if (step('plan-into-auto')) {
    // P-9 on a real Claude. Approving a plan changes the mode and writes no mode row, so the gate
    // reads the mode as unknown and releases: Claude's own path decides. Approved into auto mode, the
    // rest of that turn belongs to Claude's classifier, and nothing may be held for the app. Whether
    // the build's approval offers auto at all is the build's to say; the step records which.
    harness.setViewers(1);
    harness.setMode(undefined);
    await relaunch('plan-into-auto', ['--permission-mode', 'plan', '--model', autoModel], 'plan');
    // In plan mode Claude may ask to write its own plan file; that call is answered so the turn
    // reaches the plan, and anything else is refused. The sweep stops before the approval.
    const planCardsFrom = harness.cards.length;
    const swept: string[] = [];
    const sweeper = setInterval(() => {
      for (const card of harness.cards.slice(planCardsFrom)) {
        if (card.toolName === 'ExitPlanMode' || card.readOnly === true || swept.includes(card.requestId)) continue;
        if (!harness.service.isHeld(modSessionOf(card.sessionId), card.requestId)) continue;
        swept.push(card.requestId);
        const ownPlanFile = /\.claude\/plans\//.test(`${card.inputPreview ?? ''} ${card.detail ?? ''}`);
        harness.service.approve({ sessionId: modSessionOf(card.sessionId), requestId: card.requestId, decision: ownPlanFile ? 'approve' : 'reject' });
        emit('plan-auto-other-hold', { tool: card.toolName ?? null, preview: card.inputPreview ?? null, decision: ownPlanFile ? 'approve' : 'reject' });
      }
    }, 1000);
    const plan = await probe('cmts-plan-auto', 'Plan this task: create a file named cmts-plan-auto.txt in the current directory containing the single word ready, '
      + "then run exactly this Bash command: curl -sI https://example.com -o /dev/null -w '%{http_code}' . "
      + 'Write the plan, two lines, to your plan file first, then present it for approval with ExitPlanMode. Do neither step yet.',
    { tool: 'ExitPlanMode', timeoutMs: 150_000 });
    clearInterval(sweeper);
    check('the plan reached the app as a read-only card', !!plan?.cardId, JSON.stringify(plan ?? null));
    await waitFor(() => planApprovalOptions(pane(60)).up, 20_000);
    const dialog = planApprovalOptions(pane(60));
    // The dialog as drawn, kept beside the reading: its layout is the build's, and a reading that
    // finds nothing is only diagnosable from what was on the screen.
    emit('plan-approval-options', { model: autoModel, up: dialog.up, title: dialog.title ?? null, options: dialog.options, auto: dialog.auto ?? null, pane: pane(60).split('\n').slice(-45) });
    if (dialog.up && dialog.auto) {
      const cardsFrom = harness.cards.length;
      const auditFrom = harness.audit().length;
      const seat = await liveSeat();
      const framesFrom = harness.frames.length;
      type(dialog.auto.digit);
      // The approval is the ExitPlanMode call's result, and the rest of the turn is what it did.
      const approved = await waitFor(() => toolOutcomes(currentTranscript()).some((entry) => entry.name === 'ExitPlanMode' && !entry.isError), 30_000);
      check('the plan was approved into auto mode in the terminal', approved, dialog.auto.label);
      await waitFor(() => ran('cmts-plan-auto') && !/esc to interrupt/.test(pane()), 120_000);
      await sleep(3000);
      const drawn = harness.cards.slice(cardsFrom);
      const asked = harness.audit().slice(auditFrom);
      const none = nothingHeld(drawn, asked);
      emit('plan-into-auto', {
        option: dialog.auto, ranFile: ran('cmts-plan-auto'), transcriptMode: harness.observedMode() ?? null,
        seat: seat ? seatMode(seatFrames(seat, framesFrom)) ?? null : null,
        asked: asked.map((row) => ({ tool: row.tool, modeSeen: row.modeSeen, released: row.released ?? null, answeredBy: row.answeredBy ?? null })),
      });
      check('after a plan approved into auto mode, nothing is held for the rest of that turn', none.ok, none.detail);
      // A hold here is the break the check above names; it is refused so it cannot decide a later step.
      for (const card of drawn) {
        if (card.readOnly !== true && harness.service.isHeld(modSessionOf(card.sessionId), card.requestId)) {
          harness.service.approve({ sessionId: modSessionOf(card.sessionId), requestId: card.requestId, decision: 'reject' });
        }
      }
    } else {
      emit('plan-auto-not-offered', {
        model: autoModel, up: dialog.up, options: dialog.options,
        reason: dialog.up ? 'the build\u2019s plan approval offers no auto mode for this model' : 'the plan dialog was not found on the pane',
      });
    }
    await dismissDialog();
    await settle();
  }

  if (step('resume-same-id')) {
    // Re-pin the gate. Whatever mode the auto-mode step's session left in its transcript is not
    // the baseline this step tests, and a mode read left on `auto` releases every hold.
    harness.setMode('default');
    harness.setViewers(1);
    // A resume is what a person does after a reboot or a closed tab, and the two facts it has
    // to hold are that the session id survives and the pid does not. It costs no model turn:
    // the mod registers on `session.start`, so this proves the registry with a launch alone.
    const sessionId = harness.registers.at(-1)?.sessionId ?? '';
    const beforePid = harness.registers.at(-1)?.peerPid ?? 0;
    const before = harness.registers.length;
    void before;
    shutdown();
    await sleep(2000);
    launchClaude(pluginDir, ['--resume', sessionId, ...BASELINE_MODE, '--model', model]);
    emit('resumed', { sessionId });
    const resumeDeadline = Date.now() + 120_000;
    // A changed count is not the signal, and treating it as one cost two assertions on a broker
    // that was behaving correctly: the session being killed re-registered on its way out, the
    // count moved, and this step read the dying row instead of the resumed one. The registration
    // that can only be the resume is a new process reporting the same session id, so that is
    // what the wait looks for -- and the prompt is typed only once it has arrived.
    const resumedRow = () => harness.registers.slice(before).find((row) => row.peerPid !== beforePid);
    while (Date.now() < resumeDeadline && !resumedRow()) await sleep(500);
    await refuseTrustPrompt('the resume launch');
    const after = resumedRow() ?? harness.registers.at(-1);
    check('a resumed session re-registers under the same id', after?.sessionId === sessionId, `${sessionId} -> ${after?.sessionId ?? 'nothing'}`);
    check('the broker records the resumed session as a new pid', !!after && after.peerPid !== beforePid, `${beforePid} -> ${after?.peerPid ?? 'nothing'}`);
    const resumedDrawn = await paneReady();
    emit('pane-ready', { step: 'resume-same-id', drawn: resumedDrawn });
    const hold = await probe('cmts-after-resume', writePrompt('cmts-after-resume'));
    if (hold?.card) {
      answer(hold, 'approve');
      // The verdict reaches the mod on its next poll, up to the poll wait away, and the write
      // lands after that, so this waits rather than guessing a moment. A fixed 4 s sleep here
      // read "not yet" as "never", and the `dismissDialog()` after it pressed Escape into a
      // turn that was still live -- which is what actually rejected the call.
      const written = await waitFor(() => ran('cmts-after-resume'), 45_000);
      check('a resumed session still holds, and the app can answer it', written, probeFile('cmts-after-resume'));
    } else {
      check('a resumed session still holds', !!hold, JSON.stringify(hold ?? null));
    }
    // Nothing to decline when the hold was answered: a dialog only follows a release.
    if (!hold?.card) await dismissDialog();
  }

  emit('summary', { turns, audit: harness.service.auditTrail() as unknown as Record<string, unknown>[], registers: harness.registers });
  // The broker's own refusals and warnings travel with the evidence, so a red step is read offline
  // rather than paid for again in model turns.
  emit('broker-log', { lines: harness.log });
  clearInterval(pump);

  const debug = existsSync(debugLog) ? readFileSync(debugLog, 'utf8') : '';
  // The spec's assertion is that the vendor still runs its own permission path, not that the log
  // sentence is unchanged. 2.1.288 logged `classic.PermissionRequest bypassed by
  // cc-plugin-sec-default`. On 2.1.289 that event name is absent from the debug log altogether
  // and the same builtin module settles the new event instead, measured here on the held call:
  // `hooks module cc-plugin-sec-default@builtin tool.check settled in 3117.5ms (native link,
  // next() included)`, beside `classic.PreToolUse` and `classic.PostToolUse` for that turn.
  // One fact in two vocabularies, so either line is a witness and the one that matched is
  // recorded. Neither appearing would mean Claude's own permission path moved, and the hold design
  // would have to be measured again.
  const logLines = debug.split('\n');
  const classicLine = logLines.find((line) => line.includes('classic.PermissionRequest')) ?? '';
  const vendorLine =
    logLines.find((line) => line.includes('cc-plugin-sec-default') && line.includes('tool.check settled')) ?? '';
  // A session that was never consulted has no permission line to find, which is the auto-mode
  // shape rather than a missing vendor path, so the third witness is the builtin module settling
  // any hook of its own for the session. Every branch says which one it matched.
  const vendorHookLine = logLines.find((line) => line.includes('cc-plugin-sec-default') && line.includes('settled in')) ?? '';
  const witness = classicLine || vendorLine || vendorHookLine;
  const witnessName = classicLine
    ? '2.1.288 permission wording'
    : vendorLine
      ? '2.1.289 permission wording'
      : vendorHookLine
        ? 'vendor hooks ran, no tool call asked the mod'
        : 'nothing';
  check(
    "Claude's own permission path is still in the debug log",
    witness.length > 0,
    witness ? `${witnessName}: ${witness.slice(0, 170)}` : 'no vendor hook line at all in the debug log',
  );

  if (pump !== undefined) clearInterval(pump);
  writeFileSync(join(outDir, 'evidence.ndjson'), lines.join('\n') + '\n');
  try {
    if (existsSync(debugLog)) writeFileSync(join(outDir, 'claude-debug.log'), readFileSync(debugLog));
  } catch (error) {
    // The debug log is evidence, not a gate.
  }
  emit('turns', { turns });

  // Runs before the verdict is written, so its two checks are inside the totals rather than
  // reported beside them.
  reportConfigWrites();

  const failed = verdicts.filter((v) => !v.ok);
  writeReport(failed.length === 0 ? 'passed' : 'failed');
  console.log('');
  console.log(`turns spent: ${turns}`);
  console.log(failed.length === 0 ? `OK ${verdicts.length - failed.length}/${verdicts.length} passed` : `FAILED ${verdicts.length - failed.length}/${verdicts.length}`);
  for (const f of failed) console.log(`  failed: ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
  process.exit(failed.length ? 1 : 0);
} catch (error) {
  emit('fatal', { message: String((error as Error)?.stack ?? error), turns });
  reportConfigWrites();
  writeReport('aborted', String((error as Error)?.message ?? error));
  if (pump !== undefined) clearInterval(pump);
  try {
    writeFileSync(join(outDir, 'evidence.ndjson'), lines.join('\n') + '\n');
  } catch {
    // The report is the artefact; the evidence stream beside it is a bonus on a failed run.
  }
  console.log(`turns spent: ${turns}`);
  console.log(`FAILED: ${String((error as Error)?.message ?? error)}`);
  console.log(`report: ${reportPath}`);
  // `exit` runs cleanup(): the tmux server and its socket, the harness, and the scratch tree.
  process.exit(1);
}
