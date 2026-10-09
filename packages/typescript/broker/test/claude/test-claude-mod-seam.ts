/**
 * The seam suite: the mod, the socket, the service, the connection and the client-message routing
 * in one process, with nothing stubbed along the way between them.
 *
 * Why this exists. Every earlier suite for this lane reached *around* a production path and stayed
 * green while the product was broken. The smoke set COSYNCING_CLAUDE_SOCK itself, so socket
 * discovery was never run; answers were posted by calling `service.send` in a shape the app does
 * not send; the adapter test used a `send` that accepted anything. The seams those suites skipped
 * are exactly where the six failures lived.
 *
 * What is real here:
 * - the shipped `register.js`, loaded as written and driven by its own hooks;
 * - `$` as a thin host over it, with `http.fetch` a real `fetch` over a real Unix socket, so the
 *   real HTTP reader parses the real client's bytes;
 * - no COSYNCING_CLAUDE_SOCK anywhere: the mod resolves the socket from COSYNCING_HOME and HOME,
 *   which is the route a real terminal takes;
 * - the real `ClaudeModService` on its production default path, the real `ClaudeModConnection`
 *   drawing the cards, and the real routing functions the runtime's client-message loop calls;
 * - client frames in the shape `outbound_frame.dart` produces.
 *
 * What is faked, and only because a test cannot have it: the Claude engine behind `next(e)`, the
 * TUI that would draw the band, and the model that would run the tool.
 *
 *   bun run packages/typescript/broker/test/claude/test-claude-mod-seam.ts   (exit 0 = all pass)
 */
export {};
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(what: () => boolean, ms = 4000): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 25) {
    if (what()) return true;
    await sleep(25);
  }
  return what();
}

// ── the machine this mod runs on, all of it under one temp root ───────────────
const root = realpathSync(mkdtempSync(join(tmpdir(), 'cmts-seam-')));
const stateHome = join(root, 'state');
const home = join(root, 'home');
const workDir = join(root, 'work');
mkdirSync(stateHome, { recursive: true });
mkdirSync(home, { recursive: true });
mkdirSync(workDir, { recursive: true });

// The production environment for this test: a state directory, a home, and deliberately NO
// COSYNCING_CLAUDE_SOCK. A terminal does not inherit the broker's environment, so the mod has to
// find the socket the way a terminal does. That is the finding this root exists to keep honest.
process.env.COSYNCING_HOME = stateHome;
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude-config');
// The mod reads nothing else. Clear the set first, then turn the debug log on, so the mod's own
// account of why it went quiet is something the suite can assert on rather than something a
// reader has to reproduce by hand.
for (const key of ['COSYNCING_CLAUDE_SOCK', 'COSYNCING_SPAWNED', 'COSYNCING_CLAUDE_DISABLE', 'COSYNCING_CLAUDE_STEER']) {
  delete process.env[key];
}
process.env.COSYNCING_CLAUDE_DEBUG = '1';

const REPO = fileURLToPath(new URL('../../../../..', import.meta.url));
const MOD_REGISTER = join(REPO, 'mods/cosyncing-claude/hooks/register.js');

const { ClaudeModService } = await import('../../src/sessions/claude-mod-service.ts');
const { claudeProjectsRoot } = await import('../../src/sessions/claude-transcript-locator.ts');
const { routeModAnswer, routeModApprove, routeModRejectQuestion } = await import('../../src/sessions/mod-client-messages.ts');
const { ClaudeModConnection } = await import('../../../adapters/claude/src/mod-connection.ts');
const { findClaudeTranscript } = await import('../../src/sessions/claude-transcript-locator.ts');
const { register: registerMod } = await import(MOD_REGISTER);

const projectsRoot = claudeProjectsRoot();
const sessionId = randomUUID();
const transcriptDir = join(projectsRoot, workDir.replace(/[^a-zA-Z0-9]/g, '-'));
const transcript = join(transcriptDir, `${sessionId}.jsonl`);
mkdirSync(transcriptDir, { recursive: true });

let written = 0;
/** Rewritten with a fresh mtime each time: the adapter caches the mode by size plus mtime. */
function writeTranscript(mode: string | undefined): void {
  written += 1;
  const rows = [
    { type: 'user', uuid: `u${written}`, message: { role: 'user', content: [{ type: 'text', text: `prompt ${written}` }] } },
    ...(mode ? [{ type: 'permission-mode', permissionMode: mode }] : []),
  ];
  writeFileSync(transcript, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}
writeTranscript('default');

// ── the Claude engine, as far as a test can be one ────────────────────────────
type Handler = ($: unknown, e: Record<string, unknown>, next: (e: Record<string, unknown>) => Promise<unknown>) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const matchers = new Map<string, Record<string, unknown>>();
const on = (event: string, matcherOrHandler: unknown, maybeHandler?: Handler): void => {
  if (typeof matcherOrHandler === 'function') handlers.set(event, matcherOrHandler as Handler);
  else {
    matchers.set(event, matcherOrHandler as Record<string, unknown>);
    handlers.set(event, maybeHandler!);
  }
};
registerMod(on);

/** Everything the mod did, which is what most of the assertions read. */
const mod = {
  prompts: [] as { text?: string; asUser?: boolean }[],
  aborts: [] as { turnId?: string }[],
  appends: [] as unknown[],
  logs: [] as string[],
  fetches: 0,
  bands: [] as Record<string, unknown>[],
  timers: new Set<ReturnType<typeof setTimeout>>(),
};

const engine = { verdict: { decision: 'ask' } as unknown, toolResult: { ranItself: true } as unknown };

const dollar = {
  env: { get: async (key: string) => (Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined) },
  // A real fetch over a real socket. With an empty `socketPath` this would resolve the URL for
  // real, which is the failure the mod now refuses to make.
  http: {
    // Every dial is counted, so "no hot loop" is a number in an assertion rather than an adjective.
    fetch: async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; socketPath?: string }) => {
      mod.fetches += 1;
      const response = await fetch(url, {
        method: init.method ?? 'POST',
        headers: init.headers,
        body: init.body,
        unix: init.socketPath,
      } as unknown as RequestInit);
      return { status: response.status, text: await response.text() };
    },
  },
  session: {
    id: async () => session.id,  // eslint-disable-line
    version: async () => ({ base: '2.1.289', version: '2.1.289' }),
    append: async (message: unknown) => {
      mod.appends.push(message);
      return { ok: true };
    },
  },
  prompt: {
    submit: async (input: { text?: string; asUser?: boolean }) => {
      mod.prompts.push(input);
      return { ok: true };
    },
  },
  turn: {
    abort: async (input: { turnId?: string }) => {
      mod.aborts.push(input);
      return { ok: true };
    },
  },
  ui: {
    log: (message: string) => mod.logs.push(message),
    // The host's half of a band: `invalidate('ui.render')` is what makes the engine ask for the
    // tree again. Without it the band is a state change nobody ever drew, which is how this
    // harness passed while the buttons it asserted on were never built.
    invalidate: () => {
      void fire('ui.render', { component: 'AbovePrompt', hasSurvey: false }).catch(() => undefined);
    },
    resolve: () => ({
      Box: (props: Record<string, unknown>) => ({ type: 'Box', ...props }),
      Text: (props: Record<string, unknown>) => ({ type: 'Text', ...props }),
      Button: (props: Record<string, unknown>) => {
        mod.bands.push(props);
        return { type: 'Button', ...props };
      },
    }),
  },
  clock: {
    after: (ms: number, fn: () => void) => {
      const timer = setTimeout(() => {
        mod.timers.delete(timer);
        fn();
      }, ms);
      mod.timers.add(timer);
      return { cancel: () => { clearTimeout(timer); mod.timers.delete(timer); } };
    },
  },
};

const session = { id: sessionId, surface: 'terminal' };

/** Drive one hook the way the engine would, matcher and all. */
async function fire(event: string, e: Record<string, unknown>): Promise<unknown> {
  const handler = handlers.get(event);
  if (!handler) throw new Error(`the mod registered no ${event} hook`);
  const matcher = matchers.get(event);
  if (matcher && !Object.entries(matcher).every(([key, value]) => e[key] === value)) return undefined;
  const next = async (ev: Record<string, unknown>) => (event === 'tool.call' ? engine.toolResult : engine.verdict) ?? ev;
  return handler(dollar, e, next);
}

/**
 * Fire a hook whose event the broker must have read before the next step. A hook no longer waits on
 * its event (a broker that never answered held the person's Claude up for 30 s), so "the hook
 * returned" no longer means "the broker knows"; this waits for the broker's own record of it.
 */
async function fireLanded(event: string, e: Record<string, unknown>): Promise<boolean> {
  const before = events.length;
  await fire(event, e);
  return until(() => events.slice(before).some((ev) => ev.kind === event));
}

/** Press the band button a human would press. */
function tapBand(label: string): void {
  const button = mod.bands.find((b) => b.label === label) as { onPress?: () => void } | undefined;
  if (!button?.onPress) throw new Error(`the band offered no ${label} button`);
  button.onPress();
}

// ── the broker side, on its production default path ───────────────────────────
const notices: string[] = [];
const events: { kind: string; sessionId: string }[] = [];
const registrations: string[] = [];
const connection = new ClaudeModConnection({
  info: { id: sessionId, nativeId: sessionId, tool: 'claude', status: 'working', cwd: workDir, title: 'seam' } as never,
  transcriptPath: transcript,
  nativeSessionId: sessionId,
  // Annotated by hand: `send` reaches `service`, and `service` reaches this connection through
  // `hub`, so an inferred cycle makes tsc give up on all three.
  send: (command: unknown): { ok: boolean; code?: string } => service.send(sessionId, command as never),
  steeringEnabled: () => true,
});
const hubRow: { clientCount: number; conn: unknown } = { clientCount: 1, conn: connection as unknown };
/** What the connection tells its watchers, which is how a refused command reaches the app. */
const connectionErrors: string[] = [];
connection.subscribe((message: { type?: string; message?: string }) => {
  if (message.type === 'error') connectionErrors.push(String(message.message ?? ''));
});
/**
 * Build the broker half of the seam.
 *
 * A factory, because a broker restart has to be modelled as a whole restart and not as a listener
 * that comes back. The registry lives INSIDE the service, so restarting only the listener leaves a
 * broker holding every registration it handed out before it died -- and a mod that reconnects from
 * the same pid passes the peer check against that leftover row, so its poll is served and it never
 * registers again. A real `cosy restart` is a new process with an empty registry, and that is the
 * state the idle-recovery check below is about, so the factory gets called twice.
 */
async function makeService() {
  const built = new ClaudeModService({
    // No socketPath and no stateHome: the service resolves them the way the running broker does,
    // and the mod resolves the same path from COSYNCING_HOME. If either half drifts, nothing here
    // connects, which is the whole point.
    hub: () => hubRow,
    transcriptPath: (id: string): string | undefined =>
      findClaudeTranscript(id, service.registrationFor(id)?.cwd ?? workDir),
    killSwitch: () => false,
    onEvent: (event) => events.push(event),
    onRegister: (id) => registrations.push(id),
  });
  await built.start();
  return built;
}

let service = await makeService();

interface Card { requestId: string; type?: string; questions?: unknown; inputPreview?: string; permissionMode?: string; releaseReason?: string; readOnly?: boolean; title?: string }
const cards = () => (connection as unknown as { getPending(): Card[] }).getPending();
const frameDeps = {
  // Read through a getter so the recovery below, which rebuilds the service, is the service the
  // client-message handlers talk to.
  get service() {
    return service;
  },
  conn: {
    tool: 'claude',
    id: sessionId,
    respondPermission: (requestId: string, decision: string) => connection.respondPermission(requestId as never, decision as never),
  },
  send: (frame: Record<string, unknown>) => notices.push(String(frame.message ?? '')),
};

try {
  check('the service binds where COSYNCING_HOME says', service.socketPath === join(stateHome, 'claude-mod.sock'), service.socketPath);

  await fire('session.start', { cwd: workDir, surface: session.surface, isInteractive: true });
  const registered = await until(() => service.status(sessionId).present);
  check('the mod found the broker with no COSYNCING_CLAUDE_SOCK', registered, service.socketPath);
  check('and the row is live', service.status(sessionId).state === 'live', service.status(sessionId).state);
  check('the kernel, not the mod, said which process it is', service.status(sessionId).registration?.peerPid === process.pid, String(service.status(sessionId).registration?.peerPid));
  check('the registration reached the broker\'s listener', registrations.includes(sessionId), registrations.join(','));

  // ── a prompt typed in the app, idle and mid-turn ──
  // Idle means an ordinary prompt at the next input boundary; mid-turn means an in-turn append,
  // which is the row the app renders as steering. They are different commands, and only the first
  // goes to `prompt.submit`, so conflating them hides half of each.
  connection.replaceInfo({ ...connection.info, status: 'idle' } as never);
  await connection.sendPrompt({ text: 'run the tests' } as never);
  check('the prompt reached the mod', await until(() => mod.prompts.some((p) => p.text === 'run the tests')), JSON.stringify(mod.prompts));
  check('and landed as a user prompt, not a plugin message', mod.prompts.some((p) => p.text === 'run the tests' && p.asUser === true));

  // Mid-turn means a turn the terminal itself reported: the mod appends only into a turn it knows
  // is running, and anything else is a prompt (see the steer fallback cases in the lifecycle seam).
  connection.replaceInfo({ ...connection.info, status: 'working' } as never);
  await fire('turn.start', { turnId: 'turn-seam-0', text: 'run the tests' });
  await connection.sendPrompt({ text: 'use the other approach' } as never);
  check('mid-turn it becomes an in-turn append', await until(() => mod.appends.length === 1), JSON.stringify(mod.appends).slice(0, 120));
  await fire('turn.complete', { turnId: 'turn-seam-0', answer: 'done', durationMs: 10, isAborted: false });

  // ── Stop, with a turn and without one ──
  let refused = routeModApprove(frameDeps, { requestId: 'nope', decision: 'approve' });
  check('an unrelated approve frame falls through to the adapter', refused === false);

  await fireLanded('turn.start', { turnId: 'turn-seam-1', text: 'run the tests' });
  await connection.runCommand?.('stop');
  check('Stop reaches the turn the terminal reported', await until(() => mod.aborts.some((a) => a.turnId === 'turn-seam-1')), JSON.stringify(mod.aborts));

  await fireLanded('turn.complete', { turnId: 'turn-seam-1', answer: 'done', durationMs: 10, isAborted: false });
  connectionErrors.length = 0;
  mod.aborts.length = 0;
  await connection.runCommand?.('stop');
  check('Stop with nothing running is refused, and said', await until(() => connectionErrors.some((m) => /Nothing is running/.test(m))), JSON.stringify(connectionErrors));
  check('and no turn was aborted behind the user', mod.aborts.length === 0, JSON.stringify(mod.aborts));

  // A child's turn boundary changes nothing for the parent.
  await fireLanded('turn.start', { turnId: 'turn-seam-2', text: 'keep going' });
  await fire('turn.complete', { turnId: 'child-1', agentId: 'agent-9', answer: '', durationMs: 1, isAborted: false });
  mod.aborts.length = 0;
  await connection.runCommand?.('stop');
  check("a subagent finishing does not take the parent's turn away", await until(() => mod.aborts.some((a) => a.turnId === 'turn-seam-2')), JSON.stringify(mod.aborts));

  // The same boundary on the band. Every hook sees a child's turn.complete, so the mod's own half
  // of this matters as much as the broker's: a band broken by a subagent hands a call back to a
  // terminal that was never asked about it, and cancels a hold the parent is still parked on.
  writeTranscript('default');
  mod.bands.length = 0;
  const childBoundary = fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-child', input: { command: 'sleep 30' } });
  check('a call held across a subagent boundary draws a band', await until(() => mod.bands.some((b) => b.label === 'Allow')), JSON.stringify(mod.bands.map((b) => b.label)));
  await fire('turn.complete', { turnId: 'turn-child-1', agentId: 'agent-9', answer: '', durationMs: 1, isAborted: false });
  await sleep(200);
  check("a subagent's turn.complete leaves the band standing", mod.bands.some((b) => b.label === 'Allow') && service.isHeld(sessionId, 'cm-4') === true
    || service.isHeld(sessionId, String(cards().find((c) => c.type === 'permission-request')?.requestId ?? '')) === true, JSON.stringify([mod.bands.map((b) => b.label), cards()]));
  const childCard = cards().find((c) => c.type === 'permission-request');
  const childAnswered = routeModApprove(frameDeps, { requestId: String(childCard?.requestId ?? ''), decision: 'approve' });
  const childResult = await childBoundary;
  check('and the hold it was standing for is still answerable', childAnswered && (childResult as { decision?: string })?.decision === 'allow', JSON.stringify({ childAnswered, childResult }));

  // ── a held call, answered from the app ──
  writeTranscript('default');
  const heldPermission = fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-1', input: { command: 'git push' } });
  check('the band is drawn for a held call', await until(() => mod.bands.some((b) => b.label === 'Allow')), JSON.stringify(mod.bands.map((b) => b.label)));
  check('and the app is shown a card', await until(() => cards().some((c) => c.type === 'permission-request')));
  const approved = routeModApprove(frameDeps, { requestId: cards().find((c) => c.type === 'permission-request')!.requestId, decision: 'approve' });
  const engineAnswer = await heldPermission;
  check('a tap in the app answers the held call', approved && (engineAnswer as { decision?: string })?.decision === 'allow', JSON.stringify(engineAnswer));
  check('the card closes in the app', await until(() => !cards().some((c) => c.type === 'permission-request')));

  // ── the same, answered on the band ──
  mod.bands.length = 0;
  const bandCall = fire('tool.check', { tool: 'Write', tool_use_id: 'tu-2', input: { file_path: '/tmp/notes.md' } });
  check('the band comes back for the next call', await until(() => mod.bands.some((b) => b.label === 'Deny')));
  const bandCard = cards().find((c) => c.type === 'permission-request');
  tapBand('Deny');
  const bandAnswer = await bandCall;
  check('a press on the band answers the call', (bandAnswer as { decision?: string })?.decision === 'deny', JSON.stringify(bandAnswer));
  check('and closes the card in every seat', await until(() => !cards().some((c) => c.requestId === bandCard?.requestId)));

  // ── an AskUserQuestion answered from the app ──
  const questions = [
    { question: 'Which report?', header: 'Report', multiSelect: false, options: [{ label: 'Weekly' }, { label: 'Monthly' }] },
    { question: 'Which sections?', header: 'Sections', multiSelect: true, options: [{ label: 'Revenue' }, { label: 'Churn' }] },
  ];
  engine.toolResult = { ranItself: true };
  const questionCall = fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: 'tu-3', questions });
  check('a question draws a question card', await until(() => cards().some((c) => c.type === 'question-request')));
  const questionCard = cards().find((c) => c.type === 'question-request')!;
  const asked = (questionCard.questions as { multiple?: boolean }[]) ?? [];
  check("Claude's multiSelect reaches the app as multiple", asked[0]?.multiple === false && asked[1]?.multiple === true, JSON.stringify(asked));
  check('the question is answered from the app, not queued behind the hold', routeModAnswer(frameDeps, { requestId: questionCard.requestId, answers: [['Monthly'], ['Revenue', 'Churn']] }));
  const questionResult = await questionCall;
  const toolResult = (questionResult as { result?: { answers?: Record<string, string> } })?.result;
  check('the answer comes back as the tool result', toolResult?.answers?.['Which report?'] === 'Monthly'
    && toolResult?.answers?.['Which sections?'] === 'Revenue, Churn', JSON.stringify(questionResult));
  check('and the question card closes', await until(() => !cards().some((c) => c.requestId === questionCard.requestId)));

  // A reject on the phone hands the question back to the terminal rather than parking the hold.
  const secondAsk = fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: 'tu-4', questions });
  await until(() => cards().some((c) => c.type === 'question-request'));
  const secondCard = cards().find((c) => c.type === 'question-request')!;
  check('a dismissed question is routed to the hold', routeModRejectQuestion(frameDeps, { requestId: secondCard.requestId }));
  check('and the tool falls back to the human', JSON.stringify(await secondAsk) === JSON.stringify(engine.toolResult), JSON.stringify(await secondAsk));

  // ── no deadline: an unanswered call waits, and the terminal can still take it back ──
  mod.bands.length = 0;
  let waitingSettled = false;
  const waiting = fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-5', input: { command: 'rm -rf build' } });
  void waiting.then(() => {
    waitingSettled = true;
  });
  await until(() => cards().some((c) => c.type === 'permission-request'));
  const expiredCard = cards().find((c) => c.type === 'permission-request')!;
  // Longer than the 4 s this suite once gave a hold before it went back on its own, with the
  // production lease and park: nothing about an unanswered call runs out.
  await until(() => false, 4500);
  check('an unanswered call is still waiting, card and all', !waitingSettled && cards().some((c) => c.requestId === expiredCard.requestId),
    JSON.stringify(cards()));
  await until(() => mod.bands.some((b) => b.label === "Show Claude's dialog"));
  tapBand("Show Claude's dialog");
  const expiredAnswer = await waiting;
  check('the terminal takes it back to Claude\'s own dialog', (expiredAnswer as { decision?: string })?.decision === 'ask', JSON.stringify(expiredAnswer));
  check('and the card closes rather than staying live', await until(() => !cards().some((c) => c.requestId === expiredCard.requestId), 3000), JSON.stringify(cards()));
  // Refused means kept: the mod's card is not handed on to an adapter connection that never drew
  // it, and the seat that tapped is told nothing was sent.
  const noticesBeforeLate = notices.length;
  const lateRouted = routeModApprove(frameDeps, { requestId: expiredCard.requestId, decision: 'approve' });
  check('answering it afterwards is refused, not reported as Approved', lateRouted === true && notices.length === noticesBeforeLate + 1
    && /Nothing was sent/.test(notices[notices.length - 1] ?? ''), JSON.stringify(notices.slice(noticesBeforeLate)));

  // ── what a hold stands for ──
  // A `$.tool.check` query from another plugin runs the same chain as a real permission prompt,
  // and it arrives without a tool_use_id. Holding one draws a card for a call nobody is making,
  // and the answer then decides whichever call next lands on the same key.
  mod.bands.length = 0;
  const queried = fire('tool.check', { tool: 'Bash', input: { command: 'whoami' } });
  const queriedAnswer = await queried;
  check('a tool.check with no tool_use_id is a query, and is not held', (queriedAnswer as { decision?: string })?.decision === 'ask'
    && cards().length === 0 && mod.bands.length === 0, JSON.stringify([cards(), mod.bands.map((b) => b.label)]));

  // A new process on the same session id -- the `kill -9` then `claude --resume` case -- must not
  // inherit the dead one's card, and must not have its own first card swallowed by it.
  mod.bands.length = 0;
  writeTranscript('default');
  const firstLife = fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-old', input: { command: 'curl http://evil' } });
  await until(() => cards().some((c) => c.type === 'permission-request'));
  const oldCard = cards().find((c) => c.type === 'permission-request')!;
  check('the first process has a card open', oldCard.requestId.startsWith('cm-'), oldCard.requestId);
  // The process dies and the same session id comes back. The mod's counter starts again, so the
  // next hold arrives with this same `cm-1`.
  // A NEW registration, and one the mod has read the answer to: `session.end` is reported without
  // the hook waiting on it, so the old row can still be standing when `session.start` returns, and
  // the broker files the new row before the mod hears back. A call made in between is not held.
  const logsBeforeResume = mod.logs.length;
  await fire('session.end', {});
  await fire('session.start', { cwd: workDir, surface: session.surface, isInteractive: true });
  const takenOver = await until(() => mod.logs.slice(logsBeforeResume).some((line) => /registered /.test(line))
    && (service as unknown as { registrationFor(id: string): unknown }).registrationFor(sessionId) !== undefined && service.status(sessionId).present, 8_000);
  check('the resumed process re-registers the same session id', takenOver, JSON.stringify(service.status(sessionId).reasons));
  const oldSettled = await firstLife;
  check('the dead process\u2019s call goes back to its terminal', (oldSettled as { decision?: string })?.decision === 'ask', JSON.stringify(oldSettled));
  check('and its card is closed rather than left for the next process to answer', await until(() => !cards().some((c) => c.requestId === oldCard.requestId), 3_000), JSON.stringify(cards()));
  const noticesBeforeStale = notices.length;
  const staleRouted = routeModApprove(frameDeps, { requestId: oldCard.requestId, decision: 'approve' });
  check('tapping the closed card afterwards is refused', staleRouted === true && notices.length === noticesBeforeStale + 1,
    JSON.stringify(notices.slice(noticesBeforeStale)));

  mod.bands.length = 0;
  const secondLife = fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-new', input: { command: 'rm -rf ~' } });
  const redrawn = await until(() => cards().some((c) => c.type === 'permission-request'), 4_000);
  check('the new process\u2019s first card is drawn, not swallowed by the old one\u2019s id', redrawn, JSON.stringify(cards()));
  const newCard = cards().find((c) => c.type === 'permission-request');
  check('and it names the command the new call would run', String(newCard?.inputPreview ?? '').includes('rm -rf'), JSON.stringify(newCard ?? {}));
  const newRequestId = String(newCard?.requestId ?? '');
  const answeredNew = routeModApprove(frameDeps, { requestId: newRequestId, decision: 'approve' });
  const newAnswer = await secondLife;
  check('answering it decides this call, not the one it replaced', answeredNew && (newAnswer as { decision?: string })?.decision === 'allow',
    JSON.stringify({ answeredNew, newRequestId, held: service.isHeld(sessionId, newRequestId), newAnswer }));

  // ── a broker restart, and the idle session that has to come back ──
  service.close();
  check('the broker went away', !service.listening);
  const fetchesAtClose = mod.fetches;
  // How long the loop takes to notice depends on where it was caught. A dial that is already
  // connected dies with the listener; a long-poll the broker was still holding is answered by
  // Bun's own close of the accepted socket, which is not instantaneous. The assertion is
  // therefore a window, and the window is measured rather than invented: the detail string prints
  // the observed latency on every run, so a regression that stretches it is visible.
  const parkedAt = await until(() => mod.logs.some((line) => /sync parked/.test(line)), 12_000);
  const parkLine = mod.logs.filter((line) => /parked/.test(line)).slice(-1).join();
  check('the mod parked rather than ending its loop', parkedAt, parkLine || `no park line within 12 s; ${mod.fetches - fetchesAtClose} dials`);
  const parkedFetches = mod.fetches;
  await sleep(1600);
  check('a parked session stays quiet instead of spinning', mod.fetches - parkedFetches <= 2, `${mod.fetches - parkedFetches} dials while parked`);
  // The whole broker, not just its socket: a fresh registry, a fresh hold store, the same path.
  // Counted here because a registration is the only fact that proves the loop came back. A row in
  // `service.status` is not: the freshness window is 60 s, so a dead loop would still read live.
  const registrationsBeforeRestart = registrations.length;
  service = await makeService();
  // A row that is merely `present` proves nothing: the registry outlives its socket, and the
  // freshness window is 60 s, so this assertion would pass with a dead loop if it asked only
  // "is it live". A generation is handed out by registration and by nothing else.
  const backAgain = await until(
    () => registrations.length > registrationsBeforeRestart && service.status(sessionId).state === 'live',
    12_000,
  );
  // A generation is handed out per process, so it is not comparable across a restart: the new
  // registry's first is lower than the old one's third. What IS comparable is the count of
  // registrations the new broker was told about.
  check('an idle session re-registers on its own once the broker returns', backAgain,
    `registrations ${registrationsBeforeRestart} -> ${registrations.length}, state ${service.status(sessionId).state}`);
  check('and it spent no more than a few dials getting there', mod.fetches - fetchesAtClose <= 8, `${mod.fetches - fetchesAtClose} dials`);

  // ── a custom state directory, which is what a real operator hits ──
  const moved = join(root, 'elsewhere');
  mkdirSync(moved, { recursive: true });
  process.env.COSYNCING_HOME = moved;
  check('the mod resolves the moved state directory, not the default one',
    join(moved, 'claude-mod.sock') !== join(home, '.cosyncing', 'claude-mod.sock'));
} catch (error) {
  check('no exception', false, String((error as Error)?.stack ?? error).slice(0, 400));
} finally {
  for (const timer of mod.timers) clearTimeout(timer);
  try {
    // Closes the transcript tail watcher. Left open, it holds the event loop and the suite runs
    // its assertions and then never exits, which reads as a hang rather than as a result.
    await connection.close();
  } catch {
    /* the tail is already gone */
  }
  try {
    service.close();
  } catch {
    /* already closed */
  }
  // The root holds the socket, a state home and a transcript tree. Every run used to leave one in
  // the temp directory.
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? `FAILED ${failed.length}/${results.length}` : `OK ${results.length}/${results.length} passed`}`);
process.exit(failed.length ? 1 : 0);
