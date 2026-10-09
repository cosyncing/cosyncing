/**
 * Holds, end to end: the mod's band, the broker's hold store, and the card the app draws, with
 * the app's own answer routed back through the functions the runtime's client-message loop calls.
 *
 * Everything on the broker side is real: `ClaudeModService` bound in a mkdtemp directory, with its
 * `ModSocketServer`, registry, hold store and audit, the real `ClaudeModConnection` drawing the
 * cards, and `routeModApprove` / `routeModAnswer` / `routeModRejectQuestion` taking the app's
 * frames. Everything on the mod side is the shipped `register.js`, loaded fresh per terminal,
 * behind a `$` whose `http.fetch` is a real fetch over that socket. What a test cannot have is
 * faked: the engine beneath `next(e)`, the TUI that draws the band, and the host timer.
 *
 *   bun run packages/typescript/broker/test/claude/test-claude-mod-hold-seam.ts   (exit 0 = all pass)
 */
export {};
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeModService } from '../../src/sessions/claude-mod-service.ts';
import { routeModAnswer, routeModApprove, routeModRejectQuestion } from '../../src/sessions/mod-client-messages.ts';
import { modAnswerMap, modQuestionsAnswerable, modQuestionViews, modSplitLabels } from '../../src/sessions/mod-protocol.ts';
import { ClaudeModConnection } from '../../../adapters/claude/src/mod-connection.ts';
import { AttentionPolicy } from '../../src/attention/attention-policy.ts';
import { AttentionStore } from '../../src/attention/attention-store.ts';
import { ledger, loadMod, MOD_REGISTER, tempRoot, until, type LoadModOptions, type ModInstance, type SentRequest } from './claude-mod-seam-harness.ts';

const { check, finish } = ledger();

const unhandled: string[] = [];
process.on('unhandledRejection', (reason) => {
  unhandled.push(String((reason as Error)?.message ?? reason).slice(0, 200));
});

const cleanups: (() => void)[] = [];
function onCleanup(fn: () => void): void {
  cleanups.push(fn);
}

/** A card as the app receives it: the fields these checks read. */
export interface Card {
  requestId: string;
  type?: string;
  title?: string;
  toolName?: string;
  inputPreview?: string;
  detail?: string;
  permissionMode?: string;
  readOnly?: boolean;
  blocking?: boolean;
  releaseReason?: string;
  questions?: { question?: string; options?: { label?: string }[]; multiple?: boolean; freeText?: boolean }[];
  status?: string;
  answerInTerminal?: boolean;
}

interface Stack {
  sessionId: string;
  service: ClaudeModService;
  connection: ClaudeModConnection;
  mod: ModInstance;
  cards(): Card[];
  frameDeps: Parameters<typeof routeModApprove>[0];
  notices: string[];
  events: { kind: string; sessionId: string; requestId?: string }[];
  /** The terminal's environment, for a second module on the same session. */
  env: Record<string, string>;
  /** The inbox the app's attention items come from, fed by this connection's frames. */
  attention: AttentionStore;
  /** Every frame the connection fanned out to the app, in order. */
  frames: { type?: string; requestId?: string }[];
  /** The mod's requests from index `from` on, for one route. */
  sent(from: number, route?: string): SentRequest[];
  /** Hold the next request on `route` until the returned function is called. */
  stallNext(route: string): () => void;
  /** Hold the first request `when` matches, before it leaves, until the returned function is called. */
  stallWhen(when: (request: SentRequest) => boolean): () => void;
  /** Hold the first broker answer `when` matches, after the broker gave it and before the mod reads it. */
  stallReplyWhen(when: (request: SentRequest, text: string) => boolean): () => void;
  close(): void;
}

interface StackOptions {
  holdLeaseMs?: number;
  holdSleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  killSwitch?: () => boolean;
  sweepIntervalMs?: number;
  holdPollWaitMs?: number;
  timing?: Record<string, unknown>;
  mod?: Partial<LoadModOptions>;
  mode?: string;
}

/** One broker, one app connection and one terminal, all on a fresh temp root. */
async function stack(label: string, options: StackOptions = {}): Promise<Stack> {
  const temp = tempRoot('cmhs-');
  onCleanup(temp.remove);
  const sessionId = randomUUID();
  const transcript = join(temp.root, 'transcript.jsonl');
  writeFileSync(transcript, [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
    { type: 'permission-mode', permissionMode: options.mode ?? 'default' },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');

  const notices: string[] = [];
  const events: { kind: string; sessionId: string; requestId?: string }[] = [];
  let service!: ClaudeModService;
  const connection = new ClaudeModConnection({
    info: { id: sessionId, nativeId: sessionId, tool: 'claude', status: 'working', cwd: '/work', title: label } as never,
    transcriptPath: transcript,
    nativeSessionId: sessionId,
    send: (command: unknown): { ok: boolean; code?: string } => service.send(sessionId, command as never),
    steeringEnabled: () => true,
  });
  const hubRow = { clientCount: 1, conn: connection as unknown };
  service = new ClaudeModService({
    socketPath: join(temp.root, 'claude-mod.sock'),
    hub: () => hubRow,
    transcriptPath: () => transcript,
    killSwitch: options.killSwitch ?? (() => false),
    ...(options.holdLeaseMs ? { holdLeaseMs: options.holdLeaseMs } : {}),
    ...(options.sweepIntervalMs ? { sweepIntervalMs: options.sweepIntervalMs } : {}),
    ...(options.holdSleep ? { holdSleep: options.holdSleep } : {}),
    // The production park of one hold long-poll. A section that wants many polls in a short test
    // says so; the rest see the request pattern the terminal really makes.
    holdPollWaitMs: options.holdPollWaitMs ?? 20_000,
    onEvent: (event) => events.push(event as never),
  });
  await service.start();

  // The inbox, fed the way the runtime feeds it: every frame the connection fans out.
  const attention = new AttentionStore({ path: join(temp.root, 'attention-events.json') });
  const policy = new AttentionPolicy(attention);
  const frames: { type?: string; requestId?: string }[] = [];
  connection.subscribe((message) => {
    frames.push(message as never);
    void policy.handleMessage(connection.info as never, message as never).catch(() => undefined);
  });
  const env = { COSYNCING_CLAUDE_SOCK: service.socketPath, HOME: temp.root };

  const stalls: { when: (request: SentRequest) => boolean; until: Promise<void> }[] = [];
  const replyStalls: { when: (request: SentRequest, text: string) => boolean; until: Promise<void> }[] = [];
  const mod = await loadMod(label, {
    sessionId,
    ...options.mod,
    env: { ...env, ...options.mod?.env },
    beforeFetch: async (request) => {
      const at = stalls.findIndex((stall) => stall.when(request));
      if (at >= 0) await stalls.splice(at, 1)[0]!.until;
      await options.mod?.beforeFetch?.(request);
    },
    afterFetch: async (request, reply) => {
      const at = replyStalls.findIndex((stall) => stall.when(request, reply.text));
      if (at >= 0) await replyStalls.splice(at, 1)[0]!.until;
    },
  });
  (mod.exports.tuneForTest as (o: Record<string, unknown>) => void)({ backoffMs: [100, 200, 300], pollWaitMs: 300, ...options.timing });
  const releases: (() => void)[] = [];
  const gate = (): { until: Promise<void>; release: () => void } => {
    let release!: () => void;
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });
    releases.push(release);
    return { until, release };
  };
  const close = () => {
    for (const release of releases) release();
    mod.kill();
    service.close();
  };
  onCleanup(close);
  await mod.fire('session.start', { cwd: '/work', surface: 'terminal', isInteractive: true });
  await until(() => service.status(sessionId).present);
  await until(() => mod.record.requests.some((r) => r.route === 'poll'));
  return {
    sessionId,
    service,
    connection,
    mod,
    cards: () => (connection as unknown as { getPending(): Card[] }).getPending(),
    frameDeps: {
      get service() {
        return service;
      },
      conn: {
        tool: 'claude',
        id: sessionId,
        respondPermission: (requestId: string, decision: string) => connection.respondPermission(requestId as never, decision as never),
      },
      send: (frame: Record<string, unknown>) => notices.push(String(frame.message ?? '')),
    } as never,
    notices,
    events,
    env,
    attention,
    frames,
    sent: (from, route) => mod.requestsSince(from, route),
    stallNext: (route) => {
      const { until: held, release } = gate();
      stalls.push({ when: (request) => request.route === route, until: held });
      return release;
    },
    stallWhen: (when) => {
      const { until: held, release } = gate();
      stalls.push({ when, until: held });
      return release;
    },
    stallReplyWhen: (when) => {
      const { until: held, release } = gate();
      replyStalls.push({ when, until: held });
      return release;
    },
    close,
  };
}

const permissionCards = (s: Stack) => s.cards().filter((c) => c.type === 'permission-request' && c.readOnly !== true);
/** The title of the band the engine last drew, or '' when the last render was the engine's own. */
function bandTitle(tree: unknown): string {
  const children = (tree as { children?: unknown[] } | undefined)?.children;
  const first = Array.isArray(children) ? (children[0] as { children?: unknown } | undefined) : undefined;
  return typeof first?.children === 'string' ? first.children : '';
}
const decisionOf = (value: unknown) => (value as { decision?: string } | undefined)?.decision;
const bandAnswers = (s: Stack, from: number) => s.sent(from, 'event').filter((r) => r.body.kind === 'hold.answer');

// ── band timing (MB10): the band is drawn only for a hold the broker said it holds ────────────
async function bandTimingSection(): Promise<void> {
  // A render while the ask is still on its way draws nothing; the ack is what puts the band up.
  {
    const s = await stack('band-ack');
    const release = s.stallNext('hold');
    const before = s.mod.record.requests.length;
    const call = s.mod.fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-bt-1', input: { command: 'make' } });
    await until(() => s.sent(before, 'hold').length === 1);
    const drawnBeforeAck = s.mod.record.bands.length;
    const early = await s.mod.renderNow();
    check('band timing: a render while the ask is unanswered draws no band',
      (early as { engineDrew?: boolean } | undefined)?.engineDrew === true && s.mod.record.bands.length === drawnBeforeAck,
      JSON.stringify(early).slice(0, 160));
    release();
    check('band timing: the ack puts the band up', await until(() => s.mod.record.bands.some((b) => b.label === 'Allow')),
      JSON.stringify(s.mod.record.bands.map((b) => b.label)));
    const card = await until(() => permissionCards(s).length === 1) ? permissionCards(s)[0] : undefined;
    routeModApprove(s.frameDeps, { requestId: String(card?.requestId ?? ''), decision: 'approve' });
    check('band timing: and the call it stood for is answered', decisionOf(await call) === 'allow');
    s.close();
  }

  // An ask that never got its ack leaves nothing on screen that could still be pressed.
  {
    const s = await stack('band-never-acked', { timing: { ackMs: 400 } });
    s.stallNext('hold');
    const before = s.mod.record.requests.length;
    const invalidationsBefore = s.mod.record.invalidations;
    const call = s.mod.fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-bt-2', input: { command: 'make' } });
    await until(() => s.sent(before, 'hold').length === 1);
    await s.mod.renderNow();
    check('band timing: an ask with no ack yet is given back to the engine', decisionOf(await call) === 'ask');
    const drawn = [...s.mod.record.bands].reverse().find((b) => b.label === 'Allow') as { onPress?: () => void } | undefined;
    const lastRender = await s.mod.renderNow();
    const repainted = s.mod.record.invalidations > invalidationsBefore;
    check('band timing: a band that ends before its ack leaves no band on screen',
      drawn === undefined || (repainted && (lastRender as { engineDrew?: boolean })?.engineDrew === true),
      `drawn=${drawn !== undefined} invalidations=${s.mod.record.invalidations - invalidationsBefore}`);
    const tapFrom = s.mod.record.requests.length;
    drawn?.onPress?.();
    await until(() => false, 200);
    check('band timing: and no button left behind can answer anything', bandAnswers(s, tapFrom).length === 0,
      JSON.stringify(bandAnswers(s, tapFrom).map((r) => r.body)));
    s.close();
  }

  // A band that was up and whose hold ended because the broker stopped answering it -- a request
  // that outlived its bound: the stale picture's buttons are dead.
  {
    const s = await stack('band-request-bound', { timing: { holdPollMs: 900 }, holdPollWaitMs: 20_000 });
    const call = s.mod.fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-bt-3', input: { command: 'make' } });
    await until(() => s.mod.record.bands.some((b) => b.label === 'Allow'));
    const stale = [...s.mod.record.bands].reverse().find((b) => b.label === 'Allow') as { onPress?: () => void } | undefined;
    const invalidationsBefore = s.mod.record.invalidations;
    check('band timing: a shown band whose hold ran out hands the call back', decisionOf(await call) === 'ask');
    check('band timing: and asks the engine to draw it away', s.mod.record.invalidations > invalidationsBefore
      && (await s.mod.renderNow() as { engineDrew?: boolean })?.engineDrew === true);
    const tapFrom = s.mod.record.requests.length;
    stale?.onPress?.();
    await until(() => false, 200);
    check('band timing: a tap on a band whose hold already ended sends nothing', bandAnswers(s, tapFrom).length === 0,
      JSON.stringify(bandAnswers(s, tapFrom).map((r) => r.body)));
    check('band timing: and the broker\'s hold is not answered by it', s.service.auditTrail(s.sessionId).every((row) => (row as { answeredBy?: string }).answeredBy !== 'band'),
      JSON.stringify(s.service.auditTrail(s.sessionId)).slice(0, 200));
    s.close();
  }
}

// ── two asks at once: each call gets its own answer, from whichever seat ─────────────────────
async function twoAsksSection(): Promise<void> {
  const s = await stack('two-asks', { mod: { env: { COSYNCING_CLAUDE_DEBUG: '1' } } });
  const first = s.mod.fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-two-a', input: { command: 'make first' } });
  await until(() => permissionCards(s).length === 1);
  const second = s.mod.fire('tool.check', { tool: 'Write', tool_use_id: 'tu-two-b', input: { file_path: '/work/second.md' } });
  check('two asks at once: each one has its own card in the app', await until(() => permissionCards(s).length === 2),
    JSON.stringify(permissionCards(s).map((c) => c.inputPreview ?? c.title)));
  const lastTree = () => s.mod.record.renders[s.mod.record.renders.length - 1];
  // TH6 (C3): asked once BOTH asks are on the band -- the second one's ack is in -- and from a render
  // taken now, so an earlier picture of the first ask alone cannot answer for it.
  const ackedHeld = (requestId: string) => s.mod.record.replies.some((reply) => reply.request.route === 'hold'
    && reply.request.body.requestId === requestId && /"held":true/.test(reply.text));
  await until(() => ackedHeld('cm-1') && ackedHeld('cm-2'));
  const bothShown = await s.mod.renderNow();
  check('two asks at once: the band shows the first ask', ackedHeld('cm-2') && bandTitle(bothShown).includes('Bash')
    && !bandTitle(bothShown).includes('Write'), bandTitle(bothShown));
  // Answered once the second call is parked on the broker. An answer that lands between its ack
  // and that wait is the re-offer case, which the settled-elsewhere checks hold the line on.
  await until(() => s.sent(0, 'hold').filter((r) => r.body.requestId === 'cm-2').length >= 2);
  await until(() => false, 100);
  const secondCard = permissionCards(s).find((c) => (c.inputPreview ?? '').includes('second.md'));
  check('two asks at once: the app answers the second', routeModApprove(s.frameDeps, { requestId: String(secondCard?.requestId ?? ''), decision: 'reject' }),
    JSON.stringify(secondCard));
  const secondAnswer = await second;
  check('two asks at once: and only the second call gets that answer', decisionOf(secondAnswer) === 'deny',
    JSON.stringify({ secondAnswer, replies: s.mod.record.replies.filter((r) => r.text.length > 40).map((r) => [r.request.route, r.request.body.requestId, r.text.slice(30, 140)]) }));
  check('two asks at once: the first is still waiting, and still on the band', await until(() => bandTitle(lastTree()).includes('Bash'))
    && permissionCards(s).length === 1, JSON.stringify([bandTitle(lastTree()), permissionCards(s).map((c) => c.inputPreview)]));
  s.mod.tapBand('Allow');
  const firstAnswer = await first;
  check('two asks at once: the band answers the first, not the second', decisionOf(firstAnswer) === 'allow', JSON.stringify(firstAnswer));
  check('two asks at once: and both cards are closed', await until(() => permissionCards(s).length === 0), JSON.stringify(permissionCards(s)));
  s.close();
}

// ── MB3: a call the broker says was settled elsewhere is never offered again ─────────────────
async function settledElsewhereSection(): Promise<void> {
  const s = await stack('settled-elsewhere');
  let offers = 0;
  // The wait's request -- the call's second -- is held back until the app has answered and the poll
  // leg has carried that answer, so the broker has nothing left to give the hold leg but the news.
  const releaseHold = s.stallWhen((r) => r.route === 'hold' && r.body.requestId === 'cm-1' && ++offers === 2);
  // And the poll leg's answer is held after the broker gave it, so the hold leg is heard from first.
  const releasePollReply = s.stallReplyWhen((r, text) => r.route === 'poll' && text.includes('"verdict"'));
  const call = s.mod.fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-se', input: { command: 'make settle' } });
  await until(() => s.mod.record.bands.some((b) => b.label === 'Allow'));
  await until(() => s.sent(0, 'hold').filter((r) => r.body.requestId === 'cm-1').length === 2);
  const card = await until(() => permissionCards(s).length === 1) ? permissionCards(s)[0] : undefined;
  check('MB3: the app answers while the mod is between its ack and its wait',
    routeModApprove(s.frameDeps, { requestId: String(card?.requestId ?? ''), decision: 'approve' }), JSON.stringify(card));
  check('MB3: the poll leg takes the answer', await until(() => s.mod.record.replies.some((r) => r.request.route === 'poll' && r.text.includes('"verdict"'))));
  releaseHold();
  check('MB3: the hold leg is told settled-elsewhere',
    await until(() => s.mod.record.replies.some((r) => r.request.route === 'hold' && r.text.includes('settledElsewhere'))),
    JSON.stringify(s.mod.record.replies.filter((r) => r.request.route === 'hold').map((r) => r.text.slice(30, 120))));
  const toldAt = s.mod.record.requests.length;
  await until(() => false, 300);
  check('MB3: the mod does not offer the call again', s.sent(toldAt, 'hold').length === 0,
    JSON.stringify(s.sent(toldAt, 'hold').map((r) => r.body.requestId)));
  const opened = s.mod.record.replies.filter((r) => r.request.route === 'hold' && r.text.includes('"held":true'));
  check('MB3: and no second hold, and no second card, exists for it', opened.length === 1 && permissionCards(s).length === 0
    && s.service.auditTrail(s.sessionId).length === 1, JSON.stringify([opened.length, permissionCards(s), s.service.auditTrail(s.sessionId).length]));
  releasePollReply();
  const answered = await call;
  check('MB3: the answer the poll leg carried is the call\'s answer', decisionOf(answered) === 'allow', JSON.stringify(answered));
  s.close();
}

// ── MB2: the id the app answers by is never another process's ────────────────────────────────
const QUESTIONS = [{ question: 'Which build?', header: 'Build', multiSelect: false, options: [{ label: 'Debug' }, { label: 'Release' }] }];
const questionCards = (s: Stack) => s.cards().filter((c) => c.type === 'question-request' && c.readOnly !== true);

async function appIdSection(): Promise<void> {
  const s = await stack('app-ids');
  // The first process: one permission and one question open, cm-1 and cm-2 in its own count.
  void s.mod.fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-old', input: { command: 'make old' } });
  await until(() => permissionCards(s).length === 1);
  void s.mod.fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: 'tu-old-q', questions: QUESTIONS });
  await until(() => questionCards(s).length === 1);
  const oldPermission = permissionCards(s)[0]!.requestId;
  const oldQuestion = questionCards(s)[0]!.requestId;

  // It dies, and `claude --resume` brings the same session back in a new process, whose count
  // starts again: its first two calls are cm-1 and cm-2 as well.
  s.mod.kill();
  const resumed = await loadMod('app-ids-resumed', { env: s.env, sessionId: s.sessionId });
  onCleanup(resumed.kill);
  (resumed.exports.tuneForTest as (o: Record<string, unknown>) => void)({ backoffMs: [100, 200, 300], pollWaitMs: 300 });
  await resumed.fire('session.start', { cwd: '/work', surface: 'terminal', isInteractive: true });
  await until(() => resumed.record.requests.some((r) => r.route === 'poll'));
  const newCall = resumed.fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-new', input: { command: 'rm -rf build' } });
  await until(() => permissionCards(s).some((c) => (c.inputPreview ?? '').includes('rm -rf')));
  const newQuestionCall = resumed.fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: 'tu-new-q', questions: QUESTIONS });
  await until(() => questionCards(s).length === 1);
  const newPermission = permissionCards(s).find((c) => (c.inputPreview ?? '').includes('rm -rf'))?.requestId ?? '';
  const newQuestion = questionCards(s)[0]?.requestId ?? '';
  check('MB2: the resumed process\'s cards carry ids the old cards never had',
    newPermission !== '' && newPermission !== oldPermission && newQuestion !== '' && newQuestion !== oldQuestion,
    JSON.stringify({ oldPermission, newPermission, oldQuestion, newQuestion }));

  // Taps that were in flight on the old cards land now.
  const noticesBefore = s.notices.length;
  const staleApprove = routeModApprove(s.frameDeps, { requestId: oldPermission, decision: 'approve' });
  const staleDeny = routeModApprove(s.frameDeps, { requestId: oldPermission, decision: 'reject' });
  const staleAnswer = routeModAnswer(s.frameDeps, { requestId: oldQuestion, answers: [['Release']] });
  const staleReject = routeModRejectQuestion(s.frameDeps, { requestId: oldQuestion });
  await until(() => false, 300);
  const stillOpen = (p: Promise<unknown>) => Promise.race([p.then(() => false), until(() => false, 50).then(() => true)]);
  check('MB2: a stale approve does not decide the new process\'s call', await stillOpen(newCall) && s.service.isHeld(s.sessionId, newPermission),
    JSON.stringify(permissionCards(s).map((c) => c.requestId)));
  check('MB2: nor does a stale deny', staleDeny === true && s.service.isHeld(s.sessionId, newPermission));
  check('MB2: a stale answer does not answer the new process\'s question', await stillOpen(newQuestionCall) && s.service.isHeld(s.sessionId, newQuestion),
    JSON.stringify(questionCards(s).map((c) => c.requestId)));
  check('MB2: nor does a stale reject', staleReject === true && s.service.isHeld(s.sessionId, newQuestion));
  check('MB2: each stale tap is refused out loud, and kept from the adapter', staleApprove === true && staleAnswer === true
    && s.notices.length - noticesBefore === 4, JSON.stringify(s.notices.slice(noticesBefore)));

  // The inbox: the new call is its own item, and the old one's resolution did not close it.
  const items = () => s.attention.listEvents().filter((e) => e.kind === 'permission-required');
  check('MB2: the new card has its own attention item, still open', await until(() => items().some((e) => e.requestId === newPermission && e.state === 'active')),
    JSON.stringify(items().map((e) => [e.requestId, e.state])));
  check('MB2: and the old card\'s item is resolved, not reopened as the new one', items().some((e) => e.requestId === oldPermission && e.state === 'resolved')
    && items().filter((e) => e.state === 'active').length === 1, JSON.stringify(items().map((e) => [e.requestId, e.state])));

  // The right ids still work.
  check('MB2: the new card\'s own id answers the new call', routeModApprove(s.frameDeps, { requestId: newPermission, decision: 'approve' })
    && decisionOf(await newCall) === 'allow');
  check('MB2: and the new question\'s id answers the new question', routeModAnswer(s.frameDeps, { requestId: newQuestion, answers: [['Debug']] })
    && JSON.stringify((await newQuestionCall as { result?: { answers?: unknown } })?.result?.answers) === JSON.stringify({ 'Which build?': 'Debug' }));
  resumed.kill();
  s.close();
}

// ── MB5(a): a question that ends without an app answer closes as a question ──────────────────
async function questionEndsSection(): Promise<void> {
  const items = (s: Stack) => s.attention.listEvents().filter((e) => e.kind === 'question-required');
  const ends: { label: string; options?: StackOptions; end: (s: Stack, card: Card) => Promise<void> }[] = [
    // The terminal stops asking about it -- the process is gone, and its connections with it -- and
    // the lease runs out with nobody looking.
    { label: 'its terminal stopped asking', options: { holdLeaseMs: 800, sweepIntervalMs: 100 }, end: async (s) => s.mod.kill() },
    { label: 'the app dismissed it', end: async (s, card) => void routeModRejectQuestion(s.frameDeps, { requestId: card.requestId }) },
    { label: 'its turn ended', end: async (s) => void await s.mod.fire('turn.complete', { turnId: 'turn-q' }) },
    {
      // Band 1 hands the question to Claude's own picker, which is open until it is answered or the
      // turn ends. The card stays for that long (R5-A, below); here the turn ends.
      label: 'the person chose Claude\'s dialog, and the turn ended',
      end: async (s) => {
        s.mod.tapBand("Answer in Claude's dialog");
        await until(() => s.cards().some((c) => c.type === 'question-request' && c.answerInTerminal === true));
        await s.mod.fire('turn.complete', { turnId: 'turn-q' });
      },
    },
    {
      label: 'a resumed process took the session over',
      end: async (s) => {
        s.mod.kill();
        const resumed = await loadMod('question-resumed', { env: s.env, sessionId: s.sessionId });
        onCleanup(resumed.kill);
        (resumed.exports.tuneForTest as (o: Record<string, unknown>) => void)({ backoffMs: [100, 200, 300], pollWaitMs: 300 });
        await resumed.fire('session.start', { cwd: '/work', surface: 'terminal', isInteractive: true });
      },
    },
  ];
  for (const [index, { label, options, end }] of ends.entries()) {
    const s = await stack(`question-end-${index}`, options);
    await s.mod.fire('turn.start', { turnId: 'turn-q' });
    void s.mod.fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: `tu-q-${index}`, questions: QUESTIONS }).catch(() => undefined);
    await until(() => questionCards(s).length === 1);
    const card = questionCards(s)[0]!;
    await until(() => s.mod.record.bands.length > 0);
    await until(() => items(s).some((e) => e.requestId === card.requestId && e.state === 'active'));
    await end(s, card);
    check(`MB5a (${label}): the question card closes`, await until(() => questionCards(s).length === 0, 3000), JSON.stringify(questionCards(s)));
    check(`MB5a (${label}): closed as a question, not as a permission`,
      await until(() => s.frames.some((f) => f.type === 'question-resolved' && f.requestId === card.requestId), 3000)
        && !s.frames.some((f) => f.type === 'permission-resolved' && f.requestId === card.requestId),
      JSON.stringify(s.frames.filter((f) => f.requestId === card.requestId).map((f) => f.type)));
    check(`MB5a (${label}): and its inbox item is resolved`,
      await until(() => items(s).some((e) => e.requestId === card.requestId && e.state === 'resolved'), 3000),
      JSON.stringify(items(s).map((e) => [e.requestId, e.state])));
    s.close();
  }

  // R5-A: the picker is open, so the question is not over. Its card stays, read-only and open in the
  // terminal, and the session still waits on a person.
  const s = await stack('question-end-dialog');
  await s.mod.fire('turn.start', { turnId: 'turn-q' });
  void s.mod.fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: 'tu-q-dialog', questions: QUESTIONS }).catch(() => undefined);
  await until(() => questionCards(s).length === 1 && s.mod.record.bands.length > 0);
  const card = questionCards(s)[0]!;
  await until(() => items(s).some((e) => e.requestId === card.requestId && e.state === 'active'));
  s.mod.tapBand("Answer in Claude's dialog");
  const restated = await until(() => s.cards().some((c) => c.type === 'question-request' && c.requestId === card.requestId && c.answerInTerminal === true), 3000);
  await until(() => false, 200);
  const open = s.cards().filter((c) => c.type === 'question-request');
  check('MB5a (the person chose Claude\'s dialog): the card stays, read-only and open in the terminal, under the same id',
    restated && open.length === 1 && open[0]?.requestId === card.requestId && open[0]?.readOnly === true && open[0]?.blocking !== false,
    JSON.stringify(open));
  check('MB5a (the person chose Claude\'s dialog): nothing has closed it yet', !s.frames.some((f) => f.type === 'question-resolved' && f.requestId === card.requestId),
    JSON.stringify(s.frames.filter((f) => f.requestId === card.requestId).map((f) => f.type)));
  check('MB5a (the person chose Claude\'s dialog): and its inbox item is still open: the session still waits on a person',
    items(s).some((e) => e.requestId === card.requestId && e.state === 'active'), JSON.stringify(items(s).map((e) => [e.requestId, e.state])));
  s.close();
}

// ── MB5(d): a question is held only for a real call, and the hold says which call ────────────
async function questionCallSection(): Promise<void> {
  const s = await stack('question-call');
  const before = s.mod.record.requests.length;
  const query = await s.mod.fire('tool.call', { tool: 'AskUserQuestion', questions: QUESTIONS });
  check('MB5d: a question tool.call with no tool_use_id is not held', (query as { ranItself?: boolean })?.ranItself === true
    && s.sent(before, 'hold').length === 0, JSON.stringify(s.sent(before, 'hold').map((r) => r.body.requestId)));
  const call = s.mod.fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: 'tu-q-real', questions: QUESTIONS });
  await until(() => questionCards(s).length === 1);
  check('MB5d: a held question carries its tool_use_id to the broker', s.sent(before, 'hold').some((r) => r.body.toolUseId === 'tu-q-real'),
    JSON.stringify(s.sent(before, 'hold').map((r) => r.body.toolUseId)));
  routeModRejectQuestion(s.frameDeps, { requestId: questionCards(s)[0]!.requestId });
  await call;
  s.close();
}

// ── MB5(b), (c): one rule for what a question takes, and the questions the app cannot answer ──
const SINGLE = { question: 'Which build?', header: 'Build', multiSelect: false, options: [{ label: 'Debug' }, { label: 'Release' }] };
const MULTI = { question: 'Which checks?', header: 'Checks', multiSelect: true, options: [{ label: 'Lint' }, { label: 'Test' }, { label: 'Types' }] };
const COMMA_MULTI = { question: 'Which sizes?', multiSelect: true, options: [{ label: 'Small, cheap' }, { label: 'Large' }] };
const QUOTED_MULTI = { question: 'Which phrases?', multiSelect: true, options: [{ label: 'Say "hi", now' }, { label: 'Tokyo' }, { label: 'Quote " only' }] };
const PADDED_MULTI = { question: 'Which side?', multiSelect: true, options: [{ label: ' Left' }, { label: 'Right' }] };
const TEXT = { question: 'Name the branch?', kind: 'text' };
const NUMBER = { question: 'How many workers?', kind: 'number', min: 1, max: 8 };
const NUMBER_NO_RANGE = { question: 'How many?', kind: 'number' };
/**
 * Three multi-select answers Claude 2.1.292's own picker wrote, read from the session transcripts of
 * the 2026-10-06 probe: the labels the model offered, the ones picked in the terminal, and the
 * answer string the tool result carried. Claude's words, not ours.
 */
const MEASURED_MULTI = [
  { labels: ['Paris, France', 'Austin, Texas', 'Tokyo'], picked: ['Paris, France', 'Tokyo'], answer: '"Paris, France", Tokyo' },
  { labels: ['Say "hi", now', 'Tokyo', 'Quote " only'], picked: ['Say "hi", now', 'Tokyo', 'Quote " only'], answer: '"Say \\"hi\\", now", Tokyo, "Quote \\" only"' },
  { labels: ['C:\\temp', 'Tokyo', 'x y'], picked: ['C:\\temp', 'Tokyo', 'x y'], answer: 'C:\\temp, Tokyo, x y' },
];

async function questionRuleSection(): Promise<void> {
  // The mod's own check, as the shipped file exports it: the other half of the rule.
  const { validateAnswers } = await import(`${MOD_REGISTER}?rule-corpus`) as { validateAnswers: (q: unknown, a: unknown) => boolean };
  const sets: { name: string; questions: unknown[]; answerable: boolean }[] = [
    { name: 'single choice', questions: [SINGLE], answerable: true },
    { name: 'multi-select', questions: [MULTI], answerable: true },
    { name: 'text', questions: [TEXT], answerable: true },
    { name: 'single and multi', questions: [SINGLE, MULTI], answerable: true },
    { name: 'multi-select with a comma in a label', questions: [COMMA_MULTI], answerable: true },
    { name: 'multi-select with quotes and commas in its labels', questions: [QUOTED_MULTI], answerable: true },
    { name: 'multi-select with space around a label', questions: [PADDED_MULTI], answerable: false },
    { name: 'number', questions: [NUMBER], answerable: true },
    { name: 'number with no range', questions: [NUMBER_NO_RANGE], answerable: false },
    { name: 'text and number', questions: [TEXT, NUMBER], answerable: true },
    { name: 'the same question twice', questions: [SINGLE, { ...SINGLE, options: [{ label: 'Other' }] }], answerable: false },
  ];
  const candidates = (question: Record<string, unknown>): unknown[] => {
    const labels = Array.isArray(question.options) ? (question.options as { label: string }[]).map((o) => o.label) : [];
    return [
      labels.slice(0, 1), labels, labels.slice(0, 2).map((l) => ` ${l} `), [labels[0], labels[0]],
      ['something else'], ['a, b'], ['x'.repeat(8192)], ['x'.repeat(8193)], ['4'], ['8'], ['99'], ['-1'], ['7.5'], ['1e1'], ['four'], [], [''],
    ].filter((row) => (row as unknown[]).every((v) => v !== undefined));
  };
  let accepted = 0;
  const brokerOnly: string[] = [];
  const refusedUnanswerable: string[] = [];
  for (const set of sets) {
    const perQuestion = set.questions.map((q) => candidates(q as Record<string, unknown>));
    const combos: unknown[][] = perQuestion.reduce<unknown[][]>((acc, options) => acc.flatMap((prefix) => options.map((o) => [...prefix, o])), [[]]);
    for (const rows of combos) {
      const answers = modAnswerMap(set.questions, rows);
      if (!answers) continue;
      accepted += 1;
      if (!set.answerable) refusedUnanswerable.push(`${set.name}: ${JSON.stringify(rows).slice(0, 60)}`);
      if (!validateAnswers(set.questions, answers)) brokerOnly.push(`${set.name}: ${JSON.stringify(rows).slice(0, 80)}`);
    }
  }
  check('MB5b: whatever the broker accepts as an answer, the mod accepts too', brokerOnly.length === 0 && accepted > 0,
    `${accepted} accepted; broker-only: ${brokerOnly.slice(0, 4).join(' | ')}`);
  check('MB5b: a question set the app cannot answer faithfully takes no answer from it', refusedUnanswerable.length === 0,
    refusedUnanswerable.slice(0, 4).join(' | '));
  check('MB5b: the rule names exactly those sets', sets.every((set) => modQuestionsAnswerable(set.questions) === set.answerable),
    JSON.stringify(sets.map((set) => [set.name, modQuestionsAnswerable(set.questions)])));
  check('MB5b: an answerable set still takes what a person would give', modAnswerMap([SINGLE, MULTI], [['Release'], ['Lint', 'Types']]) !== undefined
    && modAnswerMap([SINGLE], [['my own build']]) !== undefined && modAnswerMap([TEXT], [['feature/x']]) !== undefined);
  // IQ1: a multi-select answer is spelled exactly as Claude's own picker spells it, and read back by
  // the mod with Claude's own parser.
  for (const measured of MEASURED_MULTI) {
    const question = { question: 'Which?', multiSelect: true, options: measured.labels.map((label) => ({ label })) };
    const map = modAnswerMap([question], [measured.picked]);
    check(`IQ1: the broker writes ${JSON.stringify(measured.answer)} byte for byte as Claude's picker did`,
      map?.['Which?'] === measured.answer, JSON.stringify(map));
    check(`IQ1: the mod takes Claude's own ${JSON.stringify(measured.answer)}`, validateAnswers([question], { 'Which?': measured.answer }));
    check(`IQ1: and reads it back to the labels picked`, JSON.stringify(modSplitLabels(measured.answer)) === JSON.stringify(measured.picked),
      JSON.stringify(modSplitLabels(measured.answer)));
  }
  check('IQ1: a multi-select answer split on bare commas is not one Claude wrote',
    !validateAnswers([COMMA_MULTI], { 'Which sizes?': 'Small, cheap, Large' }), 'Small, cheap, Large');
  // Claude's parser reads these as no answer at all: an open quote, text after a closing one, a
  // trailing separator, and a quote in a label the picker would have written as a JSON string.
  const unwritten = ['"Small, cheap', '"Small, cheap"Large', 'Small, cheap, ', 'La"rge'];
  const quotedLabels = { question: 'Which?', multiSelect: true, options: [{ label: 'La"rge' }, { label: 'Small, cheap' }, { label: 'Large' }] };
  check('IQ1: text Claude\'s picker could not have written reads as no labels, on both sides',
    unwritten.every((text) => modSplitLabels(text) === undefined && !validateAnswers([quotedLabels], { 'Which?': text })),
    JSON.stringify(unwritten.map((text) => [modSplitLabels(text), validateAnswers([quotedLabels], { 'Which?': text })])));
  // IQ2: a number is one plain number inside the question's range, as Claude's control writes it.
  check('IQ2: a number in range is the answer', modAnswerMap([NUMBER], [['8']])?.['How many workers?'] === '8'
    && modAnswerMap([NUMBER], [['1']]) !== undefined);
  check('IQ2: and one outside it, or not written plainly, is not, on either side',
    ['9', '0', '1e1', 'four', '8.', '+3'].every((value) => modAnswerMap([NUMBER], [[value]]) === undefined
      && !validateAnswers([NUMBER], { 'How many workers?': value })));
  // IQ3: Claude's own limit on a hook's answer, not a smaller one of ours.
  check('IQ3: an answer as long as Claude takes is taken on both sides', modAnswerMap([TEXT], [['x'.repeat(8192)]]) !== undefined
    && validateAnswers([TEXT], { 'Name the branch?': 'x'.repeat(8192) }));
  check('IQ3: and a longer one is refused on both sides', modAnswerMap([TEXT], [['x'.repeat(8193)]]) === undefined
    && !validateAnswers([TEXT], { 'Name the branch?': 'x'.repeat(8193) }));
  // IQ4: the card is told what kind of answer to collect.
  const numberView = modQuestionViews([{ ...NUMBER, step: 1, unit: 'workers' }])[0];
  check('IQ4: a number question\'s card carries its kind, range, step and unit', numberView?.kind === 'number' && numberView?.min === 1
    && numberView?.max === 8 && numberView?.step === 1 && numberView?.unit === 'workers', JSON.stringify(numberView));
  check('IQ4: and a choice question\'s carries no kind', modQuestionViews([SINGLE])[0]?.kind === undefined
    && modQuestionViews([{ ...SINGLE, min: 1 }])[0]?.min === undefined, JSON.stringify(modQuestionViews([SINGLE])));

  check('MB5b: the card offers free text only where the rule takes it',
    modQuestionViews([MULTI])[0]?.freeText === false && modQuestionViews([SINGLE])[0]?.freeText === undefined && modQuestionViews([TEXT])[0]?.freeText === undefined,
    JSON.stringify(modQuestionViews([SINGLE, MULTI, TEXT]).map((v) => v.freeText)));

  // Through the real path: a multi-select held for the app.
  {
    const s = await stack('question-rule');
    const call = s.mod.fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: 'tu-rule-1', questions: [MULTI] });
    await until(() => questionCards(s).length === 1);
    const card = questionCards(s)[0]!;
    check('MB5b: a multi-select card offers no free-text field', card.questions?.[0]?.freeText === false, JSON.stringify(card.questions));
    const noticesBefore = s.notices.length;
    const routed = routeModAnswer(s.frameDeps, { requestId: card.requestId, answers: [['something else']] });
    check('MB5b: free text on a multi-select is refused before the hold settles', routed && s.service.isHeld(s.sessionId, card.requestId),
      JSON.stringify(questionCards(s).map((c) => c.requestId)));
    check('MB5b: and said for what it is, not as a question that had gone', /does not fit/.test(s.notices[s.notices.length - 1] ?? '')
      && s.notices.length === noticesBefore + 1, JSON.stringify(s.notices.slice(noticesBefore)));
    const stillWaiting = await Promise.race([call.then(() => false), until(() => false, 200).then(() => true)]);
    check('MB5b: the terminal is still waiting on the app, not handed a picker after the app said Sent', stillWaiting);
    routeModAnswer(s.frameDeps, { requestId: card.requestId, answers: [['Lint', 'Test']] });
    const result = await call as { result?: { answers?: Record<string, string> } };
    check('MB5b: a fitting answer still answers it', result?.result?.answers?.['Which checks?'] === 'Lint, Test', JSON.stringify(result));
    s.close();
  }

  // IQ5: through the real path, questions the app used to leave to the terminal.
  {
    const s = await stack('question-quoted');
    const call = s.mod.fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: 'tu-quoted', questions: [QUOTED_MULTI, NUMBER] });
    check('IQ5 seam: a multi-select with commas and quotes in its labels, and a number, are held for the app',
      await until(() => questionCards(s).length === 1), JSON.stringify(s.cards()));
    const card = questionCards(s)[0]!;
    routeModAnswer(s.frameDeps, { requestId: card.requestId, answers: [['Say "hi", now', 'Quote " only'], ['5']] });
    const result = await call as { result?: { answers?: Record<string, string> } };
    check('IQ5 seam: and the tool is answered as Claude\'s own picker and number control would answer it',
      result?.result?.answers?.['Which phrases?'] === '"Say \\"hi\\", now", "Quote \\" only"'
        && result?.result?.answers?.['How many workers?'] === '5', JSON.stringify(result));
    check('IQ5 seam: the card closes with the labels picked, not with pieces of them',
      await until(() => s.frames.some((f) => f.type === 'question-resolved' && f.requestId === card.requestId)), JSON.stringify(s.frames.slice(-3)));
    s.close();
  }
  // IQ6: option previews -- mock-ups Claude draws beside its options -- stay out of the hold, so a
  // question carrying large ones is held like any other, and the tool still gets them back whole.
  {
    const s = await stack('question-previews');
    const preview = '<div>' + 'x'.repeat(30_000) + '</div>';
    const questions = [{ question: 'Which layout?', multiSelect: false, options: [
      { label: 'Grid', preview }, { label: 'List', preview }, { label: 'Cards', preview },
    ] }];
    const before = s.mod.record.requests.length;
    const call = s.mod.fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: 'tu-previews', questions });
    check('IQ6 seam: a question with 90 KB of option previews is held for the app', await until(() => questionCards(s).length === 1),
      JSON.stringify(s.cards()).slice(0, 200));
    const sentBody = JSON.stringify(s.sent(before, 'hold')[0]?.body ?? {});
    check('IQ6 seam: its hold carries no preview', !sentBody.includes('xxxxxxxxxx') && sentBody.length < 4096, `${sentBody.length} bytes`);
    routeModAnswer(s.frameDeps, { requestId: questionCards(s)[0]!.requestId, answers: [['List']] });
    const result = await call as { result?: { questions?: unknown; answers?: Record<string, string> } };
    check('IQ6 seam: and the tool gets its own questions back, previews and all, with the answer',
      result?.result?.questions === questions && result?.result?.answers?.['Which layout?'] === 'List', JSON.stringify(result?.result?.answers));
    s.close();
  }

  // The questions the app cannot answer the tool's way: shown, read-only, and asked in the terminal.
  const readOnlyCases: { id: string; title: string; questions: unknown[] }[] = [
    { id: 'MB5b', title: 'a multi-select with space around a label', questions: [PADDED_MULTI] },
    { id: 'MB5c', title: 'a number question with no range', questions: [NUMBER_NO_RANGE] },
    { id: 'MB5c', title: 'a question payload the app cannot draw', questions: [{ question: 'Broken?', options: 'not a list' }] },
  ];
  for (const [index, { id, title, questions }] of readOnlyCases.entries()) {
    const s = await stack(`question-terminal-${index}`);
    await s.mod.fire('turn.start', { turnId: 'turn-ro' });
    const before = s.mod.record.requests.length;
    // Bounded: a hold has no deadline, so a question wrongly held here would wait forever.
    const result = await Promise.race([
      s.mod.fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: `tu-ro-${index}`, questions }),
      until(() => false, 3000).then(() => ({ heldInstead: true })),
    ]);
    check(`${id}: ${title} is not held: Claude's own picker asks it`, (result as { ranItself?: boolean })?.ranItself === true
      && s.mod.record.bands.length === 0, `${JSON.stringify(result)} after ${s.sent(before, 'hold').length} hold requests`);
    const card = await until(() => s.cards().some((c) => c.type === 'question-request')) ? s.cards().find((c) => c.type === 'question-request') : undefined;
    // Blocking (R5-A): Claude's picker is open in the terminal, and the session is waiting on a person.
    check(`${id}: ${title} is shown read-only, to be answered in the terminal`, card?.readOnly === true && card?.answerInTerminal === true
      && card?.blocking !== false && !s.cards().some((c) => c.type === 'permission-request'), JSON.stringify(s.cards()));
    await until(() => false, 150);
    check(`${id}: ${title} raises no inbox item asking the app for an answer`,
      !s.attention.listEvents().some((e) => e.kind === 'question-required' || e.kind === 'permission-required'),
      JSON.stringify(s.attention.listEvents().map((e) => e.kind)));
    await s.mod.fire('turn.complete', { turnId: 'turn-ro' });
    check(`${id}: ${title} retires as a question when its turn ends`,
      await until(() => s.frames.some((f) => f.type === 'question-resolved' && f.requestId === card?.requestId))
        && !s.frames.some((f) => f.type === 'permission-resolved' && f.requestId === card?.requestId),
      JSON.stringify(s.frames.filter((f) => f.requestId === card?.requestId).map((f) => f.type)));
    s.close();
  }

  // A text question is answerable, and held: its answer is typed.
  {
    const s = await stack('question-text');
    const call = s.mod.fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: 'tu-text', questions: [TEXT] });
    await until(() => questionCards(s).length === 1);
    const card = questionCards(s)[0]!;
    check('MB5c: a text question is held for the app, with nothing to pick and a field to type in', card.questions?.[0]?.options?.length === 0
      && card.questions?.[0]?.freeText === undefined && card.readOnly !== true, JSON.stringify(card));
    routeModAnswer(s.frameDeps, { requestId: card.requestId, answers: [['feature/x']] });
    const result = await call as { result?: { answers?: Record<string, string> } };
    check('MB5c: and the typed answer is the tool\'s answer', result?.result?.answers?.['Name the branch?'] === 'feature/x', JSON.stringify(result));
    s.close();
  }
}

// ── MB6: a client that predates inputPreview still sees what it approves ──────────────────────
async function oldClientDetailSection(): Promise<void> {
  const s = await stack('old-client-detail');
  const call = s.mod.fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-detail', input: { command: 'rm -rf build' } });
  await until(() => permissionCards(s).length === 1);
  const card = permissionCards(s)[0]!;
  check('MB6: a held card keeps the preview where a current client reads it', card.inputPreview === 'command: rm -rf build', JSON.stringify(card));
  check('MB6: and puts the call in detail, the field a client older than inputPreview draws', card.detail === 'command: rm -rf build', JSON.stringify(card));
  routeModApprove(s.frameDeps, { requestId: card.requestId, decision: 'reject' });
  await call;
  s.close();

  // A call the broker released has a card too, and it says what the terminal is asking. (Bypass
  // mode: auto mode and dontAsk draw no card at all.)
  const auto = await stack('old-client-release', { mode: 'bypassPermissions' });
  await auto.mod.fire('tool.check', { tool: 'Write', tool_use_id: 'tu-detail-2', input: { file_path: '/work/notes.md' } });
  const released = await until(() => auto.cards().some((c) => c.type === 'permission-request' && c.readOnly === true))
    ? auto.cards().find((c) => c.type === 'permission-request' && c.readOnly === true)
    : undefined;
  check('MB6: a released card puts the call in detail too', released?.detail === 'file_path: /work/notes.md', JSON.stringify(released));
  auto.close();
}

// ── Full detail: a permission card leads with one line and opens to the whole call ────────────
async function fullDetailSection(): Promise<void> {
  const s = await stack('full-detail');
  const input = { command: 'npm test -- --runInBand', description: 'Run the suite', timeout: 120000 };
  const call = s.mod.fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-full', input });
  await until(() => permissionCards(s).length === 1);
  const card = permissionCards(s)[0]!;
  check('full detail: the card still leads with the one-line preview', card.inputPreview === 'command: npm test -- --runInBand', JSON.stringify(card));
  check('full detail: and its details carry every field of the call', card.detail === 'command: npm test -- --runInBand\ndescription: Run the suite\ntimeout: 120000',
    JSON.stringify(card.detail));
  routeModApprove(s.frameDeps, { requestId: card.requestId, decision: 'reject' });
  await call;
  check('full detail: the audit row keeps a digest, not the call', !JSON.stringify(s.service.auditTrail(s.sessionId)).includes('Run the suite'),
    JSON.stringify(s.service.auditTrail(s.sessionId)).slice(0, 200));

  // A Write of a large file: whole up to the bound, and the hold still fits the socket's body.
  const content = 'const line = 1;\n'.repeat(2000);
  const write = s.mod.fire('tool.check', { tool: 'Write', tool_use_id: 'tu-full-2', input: { file_path: '/work/big.ts', content } });
  await until(() => permissionCards(s).length === 1);
  const big = permissionCards(s)[0];
  check('full detail: a large write is still held, not refused for its size', big?.inputPreview === 'file_path: /work/big.ts', JSON.stringify(big ?? {}).slice(0, 200));
  check('full detail: its details are cut at 8,000 characters, with an ellipsis',
    (big?.detail ?? '').length === 8002 && (big?.detail ?? '').endsWith('\n\u2026') && (big?.detail ?? '').startsWith('file_path: /work/big.ts\ncontent: const line = 1;'),
    String((big?.detail ?? '').length));
  if (big) routeModApprove(s.frameDeps, { requestId: big.requestId, decision: 'reject' });
  await write;
  s.close();
}

// ── BH1: a lapsed hold is closed with nobody looking, and a late tap is refused ───────────────
async function deadlineSweepSection(): Promise<void> {
  // The lease is 800 ms. After the ack the mod never asks again: its next hold request and its next
  // poll are both stalled before they leave, which is a terminal that stopped asking. Those two
  // legs are the only places an expiry used to be noticed, short of a roster reading status.
  const s = await stack('deadline-sweep', { holdLeaseMs: 800, sweepIntervalMs: 100, timing: { holdPollMs: 30_000 } });
  let holdRequests = 0;
  s.stallWhen((request) => request.route === 'hold' && ++holdRequests === 2);
  const call = s.mod.fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-sweep-1', input: { command: 'make deploy' } });
  check('BH1: the call is held for the app', await until(() => permissionCards(s).length === 1), JSON.stringify(s.cards()));
  s.stallWhen((request) => request.route === 'poll');
  const card = permissionCards(s)[0]!.requestId;
  const items = () => s.attention.listEvents().filter((e) => e.kind === 'permission-required' && e.requestId === card);
  check('BH1: with an inbox item', await until(() => items().some((e) => e.state === 'active')), JSON.stringify(items()));
  const openedAt = Date.now();
  check('BH1: the card closes when the lease lapses, with no app reading status and the mod not asking',
    await until(() => permissionCards(s).length === 0, 4000), JSON.stringify(s.cards()));
  const closedAfterMs = Date.now() - openedAt;
  check('BH1: within a bounded time of the lapse', closedAfterMs < 2500, `${closedAfterMs} ms`);
  check('BH1: its inbox item is resolved with it', await until(() => items().some((e) => e.state === 'resolved') && !items().some((e) => e.state === 'active')),
    JSON.stringify(items().map((e) => e.state)));
  check('BH1: the audit names the expiry', s.service.auditTrail(s.sessionId).some((row) => row.answeredBy === 'expired' && row.released === 'deadline'),
    JSON.stringify(s.service.auditTrail(s.sessionId).map((row) => [row.answeredBy, row.released])));
  const noticesBefore = s.notices.length;
  check('BH1: a tap after that is refused, not taken', routeModApprove(s.frameDeps, { requestId: card, decision: 'approve' }) === true
    && s.notices.length === noticesBefore + 1 && /Nothing was sent/.test(s.notices.at(-1) ?? ''), JSON.stringify(s.notices.slice(noticesBefore)));
  check('BH1: and nothing was approved', !s.service.auditTrail(s.sessionId).some((row) => row.answeredBy === 'app'));
  s.close();
  await call.catch(() => undefined);
}

// ── LH5: no deadline. A held call waits as long as its terminal does ──────────────────────────
async function patientHoldSection(): Promise<void> {
  // Scaled the way production is shaped: the broker parks each hold long-poll longer than the lease
  // (450 ms against 300 ms; 20 s against 15 s for real), so a hold survives a park only because the
  // parked request keeps renewing it. Three seconds is ten leases and six or seven polls. The mod's
  // request bounds are production's; its "answered without waiting" mark is scaled with the park,
  // or a 450 ms park would read as one. The old hold ended at its fourth poll or 55 s, whichever
  // came first; this one ends when somebody answers.
  const s = await stack('lease-patient', { holdLeaseMs: 300, holdPollWaitMs: 450, sweepIntervalMs: 50, timing: { quickEmptyMs: 50 } });
  const before = s.mod.record.requests.length;
  const call = s.mod.fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-patient', input: { command: 'make release' } });
  check('LH5 seam: the call is held for the app', await until(() => permissionCards(s).length === 1), JSON.stringify(s.cards()));
  const card = permissionCards(s)[0]!.requestId;
  let settled = false;
  void call.then(() => {
    settled = true;
  });
  await until(() => false, 3000);
  const holdPolls = s.sent(before, 'hold').length;
  check('LH5 seam: ten leases later the call is still held and its card still up',
    !settled && s.service.isHeld(s.sessionId, card) && permissionCards(s).length === 1,
    `settled=${settled} held=${s.service.isHeld(s.sessionId, card)} cards=${permissionCards(s).length}`);
  check('LH5 seam: the terminal kept asking the whole time, past the old four-poll budget', holdPolls >= 6, `${holdPolls} hold requests`);
  check('LH5 seam: and the app\'s answer then still decides the call',
    routeModApprove(s.frameDeps, { requestId: card, decision: 'approve' }) && decisionOf(await call) === 'allow');
  check('LH5 seam: the audit records an app approval, not an expiry',
    s.service.auditTrail(s.sessionId).some((row) => row.answeredBy === 'app')
      && !s.service.auditTrail(s.sessionId).some((row) => row.answeredBy === 'expired'),
    JSON.stringify(s.service.auditTrail(s.sessionId).map((row) => [row.answeredBy, row.released, row.polls])));
  s.close();
}

// ── R4-3: an open hold waits on events, not on a clock ────────────────────────────────────────
async function eventDrivenHoldSection(): Promise<void> {
  // Production waits on every side: the broker parks a hold long-poll and an idle poll for 20 s,
  // and the mod asks for 20 s. So a command that reaches the terminal in well under that while a
  // card is open went out because the queue woke the wait it was behind.
  {
    const s = await stack('queue-during-hold', { timing: { pollWaitMs: 20_000 } });
    await s.mod.fire('turn.start', { turnId: 'turn-held' });
    await until(() => s.events.some((event) => event.kind === 'turn.start'));
    const call = s.mod.fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-queue', input: { command: 'make' } });
    check('R4-3 seam: the call is held for the app', await until(() => permissionCards(s).length === 1), JSON.stringify(s.cards()));
    const card = permissionCards(s)[0]!.requestId;
    // The poll that was already parked when the call was held is woken by the first message. Every
    // poll after it is asked with the card open, which is the wait under test.
    const delivered = () => s.mod.record.appends.length + s.mod.record.prompts.length;
    const firstFrom = s.mod.record.requests.length;
    await s.connection.sendPrompt({ text: 'first words while the card is open' } as never);
    await until(() => delivered() === 1 && s.sent(firstFrom, 'poll').length > 0, 3000);
    await until(() => false, 300);
    const stopAt = Date.now();
    await s.connection.runCommand('stop');
    const stopped = await until(() => s.mod.record.aborts.length > 0, 5000);
    const stopMs = Date.now() - stopAt;
    check('R4-3 seam: with a hold open, a Stop from the app reaches $.turn.abort within 1 s',
      stopped && stopMs < 1000 && s.mod.record.aborts[0]?.turnId === 'turn-held',
      `${stopMs} ms, aborts=${JSON.stringify(s.mod.record.aborts)}`);
    check('R4-3 seam: and the call is still held for the app after the Stop went out',
      s.service.isHeld(s.sessionId, card) && permissionCards(s).length === 1, JSON.stringify(s.cards()));
    const againFrom = s.mod.record.requests.length;
    await until(() => s.sent(againFrom, 'poll').length > 0, 3000);
    await until(() => false, 300);
    const promptAt = Date.now();
    await s.connection.sendPrompt({ text: 'second words while the card is open' } as never);
    const second = await until(() => delivered() === 2, 5000);
    const promptMs = Date.now() - promptAt;
    check('R4-3 seam: a prompt the app sends while a card is open is delivered within 1 s',
      second && promptMs < 1000, `${promptMs} ms, appends=${s.mod.record.appends.length} prompts=${s.mod.record.prompts.length}`);
    check('R4-3 seam: and the app\'s answer still decides the call afterwards',
      routeModApprove(s.frameDeps, { requestId: card, decision: 'approve' }) && decisionOf(await call) === 'allow');
    s.close();
  }
  {
    // Every timer an open hold's waits take, counted at the hold store's own sleep. A lease of
    // 800 ms against the production 20 s park means the lease timer is the only thing that can
    // fire inside the window: one per lease per leg, never a 50 ms slice.
    const sleeps: number[] = [];
    let counting = false;
    const holdSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
      if (counting) sleeps.push(ms);
      if (signal?.aborted) return resolve();
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    const s = await stack('idle-hold-wakeups', { holdLeaseMs: 800, holdSleep, timing: { pollWaitMs: 20_000 } });
    const call = s.mod.fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-idle', input: { command: 'make' } });
    check('R4-3 seam: an idle call is held for the app', await until(() => permissionCards(s).length === 1), JSON.stringify(s.cards()));
    // One message, so the terminal's poll leg is asked again with the card open and waits on the
    // hold too: both legs are then parked on it, the hold leg renewing the lease.
    const from = s.mod.record.requests.length;
    await s.connection.sendPrompt({ text: 'words before the quiet' } as never);
    await until(() => s.mod.record.appends.length + s.mod.record.prompts.length === 1 && s.sent(from, 'poll').length > 0, 3000);
    await until(() => false, 500);
    counting = true;
    const windowMs = 3_000;
    await until(() => false, windowMs);
    counting = false;
    const bound = 2 * (Math.ceil(windowMs / 800) + 1);
    check('R4-3 seam: an idle open hold makes no wakeups beyond its lease and timeout timers',
      sleeps.length <= bound && sleeps.every((ms) => ms >= 400),
      `${sleeps.length} sleeps in ${windowMs} ms (bound ${bound}); shortest ${sleeps.length ? Math.min(...sleeps) : 'none'} ms`);
    check('R4-3 seam: and it is still held, its card up, after the window',
      permissionCards(s).length === 1 && s.service.isHeld(s.sessionId, permissionCards(s)[0]!.requestId));
    routeModApprove(s.frameDeps, { requestId: permissionCards(s)[0]!.requestId, decision: 'approve' });
    check('R4-3 seam: and an answer then still decides it', decisionOf(await call) === 'allow');
    s.close();
  }
}

// ── R4-4: a band answer that does not land leaves the band answerable ─────────────────────────
async function failedTapSection(): Promise<void> {
  const isBandAnswer = (request: SentRequest) => request.route === 'event' && request.body.kind === 'hold.answer';
  /** A stack whose first band answer never reaches the broker, the way a dropped connection loses it. */
  const failingOnce = async (label: string) => {
    let failures = 1;
    const s = await stack(label, {
      mod: {
        beforeFetch: (request) => {
          if (isBandAnswer(request) && failures > 0) {
            failures -= 1;
            throw new Error('connection reset');
          }
        },
      },
    });
    return s;
  };
  const acked = (s: Stack, requestId: string) => s.mod.record.replies.some((reply) => reply.request.route === 'hold'
    && reply.request.body.requestId === requestId && /"held":true/.test(reply.text));
  const within = async (call: Promise<unknown>, ms: number) => Promise.race([call, until(() => false, ms).then(() => 'still waiting')]);
  {
    const s = await failingOnce('tap-fails-then-lands');
    const call = s.mod.fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-tap-retry', input: { command: 'make' } });
    await until(() => permissionCards(s).length === 1 && acked(s, 'cm-1'));
    await s.mod.renderNow();
    const from = s.mod.record.requests.length;
    const repaintsBefore = s.mod.record.invalidations;
    s.mod.tapBand('Allow');
    await until(() => s.mod.record.invalidations > repaintsBefore, 2000);
    check('R4-4 seam: a band answer that never reached the broker repaints the band', s.mod.record.invalidations > repaintsBefore,
      `${s.mod.record.invalidations} invalidations, ${repaintsBefore} before`);
    await s.mod.renderNow();
    s.mod.tapBand('Allow');
    const decided = await within(call, 3000);
    check('R4-4 seam: a second tap lands, and the call runs', decisionOf(decided) === 'allow'
      && s.sent(from).filter(isBandAnswer).length === 2, `${JSON.stringify(decided)} after ${s.sent(from).filter(isBandAnswer).length} band answers`);
    s.close();
  }
  {
    const s = await failingOnce('tap-fails-then-dialog');
    const call = s.mod.fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-tap-dialog', input: { command: 'make' } });
    await until(() => permissionCards(s).length === 1 && acked(s, 'cm-1'));
    await s.mod.renderNow();
    const repaintsBefore = s.mod.record.invalidations;
    s.mod.tapBand('Deny');
    await until(() => s.mod.record.invalidations > repaintsBefore, 2000);
    await s.mod.renderNow();
    s.mod.tapBand("Show Claude's dialog");
    const decided = await within(call, 3000);
    check('R4-4 seam: "Show Claude\'s dialog" still works after a failed tap', decisionOf(decided) === 'ask', JSON.stringify(decided));
    check('R4-4 seam: and the app\'s card closes with it', await until(() => permissionCards(s).length === 0, 2000), JSON.stringify(s.cards()));
    s.close();
  }
  {
    // A tap that lands after the call was settled from the app: the broker answers that it holds no
    // such call. The band leaves, and the call ends with what the app decided.
    const s = await stack('tap-after-app');
    const call = s.mod.fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-tap-late', input: { command: 'make' } });
    await until(() => permissionCards(s).length === 1 && acked(s, 'cm-1'));
    await s.mod.renderNow();
    const release = s.stallWhen(isBandAnswer);
    s.mod.tapBand('Allow');
    await until(() => false, 100);
    routeModApprove(s.frameDeps, { requestId: permissionCards(s)[0]!.requestId, decision: 'reject' });
    const decided = await within(call, 3000);
    release();
    check('R4-4 seam: a tap the broker no longer holds a call for leaves the call to the app\'s answer', decisionOf(decided) === 'deny',
      JSON.stringify(decided));
    check('R4-4 seam: and that tap was answered as not taken', await until(() => s.mod.record.replies.some((reply) =>
      isBandAnswer(reply.request) && /"answered":false/.test(reply.text)), 2000));
    s.close();
  }
}

// ── R4-5: a message the terminal could not deliver is said out loud ─────────────────────────────
async function failedCommandSection(): Promise<void> {
  const words = 'please rename the secret-project files';
  const refusals = (s: Stack) => s.events.filter((event) => event.kind === 'command.refused') as
    { kind: string; requestId?: string; detail?: Record<string, unknown> }[];
  const notices = (s: Stack) => s.frames.filter((frame) => frame.type === 'error') as { type?: string; message?: string }[];
  const leaks = (s: Stack) => [
    ...refusals(s).map((event) => JSON.stringify(event)),
    ...s.mod.record.logs.map((line) => line.text),
    ...notices(s).map((frame) => String(frame.message ?? '')),
  ].filter((text) => text.includes('secret-project'));
  {
    const s = await stack('prompt-host-error', {
      mod: {
        env: { COSYNCING_CLAUDE_DEBUG: '1' },
        promptSubmit: (input) => {
          throw new Error(`the host could not take: ${String(input.text)}`);
        },
      },
    });
    const sent = s.service.send(s.sessionId, { requestId: 'prompt-fails', op: 'prompt', text: words, queuedAt: Date.now() });
    check('R4-5 seam: the prompt was handed to the terminal', sent.ok === true && await until(() => s.mod.record.prompts.length === 1),
      JSON.stringify(sent));
    check('R4-5 seam: a prompt $.prompt.submit refused reaches the broker as command.refused, op prompt',
      await until(() => refusals(s).some((event) => event.detail?.op === 'prompt' && event.detail?.reason === 'host_error'
        && event.requestId === 'prompt-fails')),
      JSON.stringify(refusals(s)));
    check('R4-5 seam: and the app is told, on the session\'s connection',
      await until(() => notices(s).some((frame) => /could not carry out that prompt/.test(String(frame.message)))),
      JSON.stringify(notices(s)));
    check('R4-5 seam: the person\'s words are in neither the event nor any log', leaks(s).length === 0, JSON.stringify(leaks(s)));
    s.close();
  }
  {
    // A steer: a turn is running, and the in-turn append throws.
    const s = await stack('steer-host-error', {
      mod: {
        env: { COSYNCING_CLAUDE_DEBUG: '1' },
        appendResult: () => {
          throw new Error(`the host could not append: ${words}`);
        },
      },
    });
    await s.mod.fire('turn.start', { turnId: 'turn-steer' });
    await until(() => s.events.some((event) => event.kind === 'turn.start'));
    await s.connection.sendPrompt({ text: words } as never);
    check('R4-5 seam: a steer whose append threw reaches the broker as command.refused, op steer',
      await until(() => refusals(s).some((event) => event.detail?.op === 'steer' && event.detail?.reason === 'host_error')),
      JSON.stringify(refusals(s)));
    check('R4-5 seam: and the app is told about the steer too',
      await until(() => notices(s).some((frame) => /could not carry out that steer/.test(String(frame.message)))),
      JSON.stringify(notices(s)));
    check('R4-5 seam: the steer\'s words are in neither the event nor any log', leaks(s).length === 0, JSON.stringify(leaks(s)));
    s.close();
  }
}

// ── R4-10: one hold the broker refuses is that hold's problem, not the transport's ─────────────
async function refusedHoldSection(): Promise<void> {
  // Production poll pace, so no poll answer happens to reset the mod's fault count in between.
  const s = await stack('refused-hold', { timing: { pollWaitMs: 20_000 }, mod: { env: { COSYNCING_CLAUDE_DEBUG: '1' } } });
  const healthy = s.mod.fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-healthy', input: { command: 'make' } });
  check('R4-10 seam: a healthy call is held for the app', await until(() => permissionCards(s).length === 1), JSON.stringify(s.cards()));
  // A question whose hold body is past the broker's 64 KB ceiling: refused with `body_too_large`
  // every time it is offered, however often.
  const long = (letter: string) => letter.repeat(30_000) + '?';
  const questions = ['a', 'b', 'c'].map((letter) => ({
    question: long(letter), header: letter.toUpperCase(), multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }],
  }));
  const asked = await Promise.race([
    s.mod.fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: 'tu-too-large', questions }),
    until(() => false, 5000).then(() => 'still waiting'),
  ]);
  const refusedHolds = s.mod.record.replies.filter((reply) => reply.request.route === 'hold' && /body_too_large/.test(reply.text));
  check('R4-10 seam: the refused question goes to Claude\'s own picker', (asked as { ranItself?: boolean })?.ranItself === true,
    `${JSON.stringify(asked)} after ${refusedHolds.length} refused offers`);
  check('R4-10 seam: offered once, not again: a refusal about its body will not change on a retry',
    refusedHolds.length === 1, `${refusedHolds.length} refused offers`);
  check('R4-10 seam: the healthy call is still held, its band and card up',
    permissionCards(s).length === 1 && !s.mod.record.logs.some((line) => /band cleared: transport/.test(line.text)),
    JSON.stringify({ cards: permissionCards(s).length, logs: s.mod.record.logs.map((line) => line.text).filter((text) => /band|hold refused/.test(text)) }));
  routeModApprove(s.frameDeps, { requestId: permissionCards(s)[0]?.requestId ?? '', decision: 'approve' });
  const decided = await Promise.race([healthy, until(() => false, 3000).then(() => 'still waiting')]);
  check('R4-10 seam: and the app\'s answer to it still decides it', decisionOf(decided) === 'allow', JSON.stringify(decided));

  // The other side of the rule: a broker that is gone is still a transport fault, and two of them
  // still clear every band, each call back to Claude's own dialog.
  const first = s.mod.fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-gone-1', input: { command: 'make one' } });
  const second = s.mod.fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-gone-2', input: { command: 'make two' } });
  await until(() => permissionCards(s).length === 2);
  s.service.close();
  const both = await Promise.race([Promise.all([first, second]), until(() => false, 5000).then(() => 'still waiting')]);
  check('R4-10 seam: a broker that went away still clears every band as a transport fault',
    Array.isArray(both) && both.every((result) => decisionOf(result) === 'ask')
      && s.mod.record.logs.some((line) => /band cleared: transport \(2 open\)/.test(line.text)),
    JSON.stringify({ both, logs: s.mod.record.logs.map((line) => line.text).filter((text) => /band|refused|hand/.test(text)) }));
  s.close();
}

// ── LH7: an aborted hook ends its hold, and says so ──────────────────────────────────────────
async function abortedHookSection(): Promise<void> {
  // The production lease, so a card that closes inside two seconds was closed by the mod saying so,
  // not by the broker noticing the silence.
  const s = await stack('aborted-hook');
  const controller = new AbortController();
  const call = s.mod.fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-aborted', input: { command: 'make' } }, controller.signal);
  check('LH7 seam: the call is held for the app', await until(() => permissionCards(s).length === 1), JSON.stringify(s.cards()));
  const card = permissionCards(s)[0]!.requestId;
  const abortedAt = Date.now();
  controller.abort();
  let decided: unknown;
  await Promise.race([call.then((value) => {
    decided = value;
  }), until(() => false, 2000)]);
  check('LH7 seam: the engine\'s abort hands the call back at once', decisionOf(decided) === 'ask' && Date.now() - abortedAt < 1000,
    `${JSON.stringify(decided)} after ${Date.now() - abortedAt} ms`);
  check('LH7 seam: and the app\'s card closes, well inside the lease', await until(() => permissionCards(s).length === 0, 2000),
    JSON.stringify(s.cards()));
  check('LH7 seam: closed as the terminal\'s own cancel', s.service.auditTrail(s.sessionId).some((row) => row.released === 'user-cancel'),
    JSON.stringify(s.service.auditTrail(s.sessionId).map((row) => [row.answeredBy, row.released])));
  check('LH7 seam: and a tap after it decides nothing', !s.service.isHeld(s.sessionId, card));
  s.close();
}

// ── A decision the mod cannot carry is refused out loud, and the call stays held ──────────────
async function unsendableDecisionSection(): Promise<void> {
  const s = await stack('unsendable-decision');
  const call = s.mod.fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-unsendable', input: { command: 'make' } });
  const card = await until(() => permissionCards(s).length === 1) ? permissionCards(s)[0]!.requestId : '';
  for (const decision of ['external', 'approve-always', '']) {
    const before = s.notices.length;
    const routed = routeModApprove(s.frameDeps, { requestId: card, decision });
    check(`a "${decision}" decision on a held card is refused out loud, not dropped`, routed === true && s.notices.length === before + 1
      && /nothing was sent/i.test(s.notices.at(-1) ?? ''), JSON.stringify(s.notices.slice(before)));
  }
  check('and the call is still held for a real answer', s.service.isHeld(s.sessionId, card));
  // CX5: the card's title is data, the tool's own name, never an English phrase; with no name at
  // all it is empty, and every client draws its own localized fallback.
  const titled = s.cards().find((c) => c.requestId === card);
  check('CX5: a card with no session title is titled with the tool\'s name, not an English phrase', titled?.title === 'Bash',
    JSON.stringify(titled?.title));
  s.connection.ingestRequest({ requestId: 'cx5-bare@0000000000000000', kind: 'permission' });
  const bare = s.cards().find((c) => c.requestId === 'cx5-bare@0000000000000000');
  check('CX5: and a card with no tool name has an empty title, for the client\'s own words', bare !== undefined && bare.title === '',
    JSON.stringify(bare?.title));
  void s.connection.respondPermission('cx5-bare@0000000000000000', 'external');
  check('which still decides it', routeModApprove(s.frameDeps, { requestId: card, decision: 'reject' }) && decisionOf(await call) === 'deny');
  s.close();
}

// ── CX3: a read-only card is never resolved by a client ─────────────────────────────────────
async function readOnlyCardSection(): Promise<void> {
  // Bypass mode, the one mode that still draws a read-only card for both kinds of call.
  const s = await stack('read-only-card', { mode: 'bypassPermissions' });
  void s.mod.fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-ro-1', input: { command: 'make' } });
  const card = await until(() => s.cards().some((c) => c.readOnly === true))
    ? s.cards().find((c) => c.readOnly === true)!.requestId
    : '';
  const approvedFrames = () => s.frames.filter((f) => f.type === 'permission-resolved' && f.requestId === card);
  const noticesBefore = s.notices.length;
  check('CX3: an approve on a read-only card is refused out loud through the app\'s own route',
    routeModApprove(s.frameDeps, { requestId: card, decision: 'approve' }) === true && s.notices.length === noticesBefore + 1
      && /open in your terminal and can only be answered there\. Nothing was sent\./.test(s.notices.at(-1) ?? ''),
    JSON.stringify(s.notices.slice(noticesBefore)));
  // Under the route, the connection itself: even a frame that reached it cannot decide the card.
  await s.connection.respondPermission(card, 'approve');
  await s.connection.respondPermission(card, 'reject');
  check('CX3: and nothing a client sends resolves it: no seat is told it was approved or denied',
    approvedFrames().length === 0 && s.cards().some((c) => c.requestId === card), JSON.stringify(approvedFrames()));
  // The same for a question the terminal is asking.
  void s.mod.fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: 'tu-ro-2', questions: [
    { question: 'Which target?', header: 'Target', multiSelect: false, options: [{ label: 'debug' }, { label: 'release' }] },
  ] });
  const question = await until(() => s.cards().some((c) => c.type === 'question-request' && c.readOnly === true))
    ? s.cards().find((c) => c.type === 'question-request' && c.readOnly === true)!.requestId
    : '';
  await s.connection.answerQuestion(question, [['release']]);
  check('CX3: an answer that reaches a read-only question card does not resolve it',
    question !== '' && !s.frames.some((f) => f.type === 'question-resolved' && f.requestId === question)
      && s.cards().some((c) => c.requestId === question), question);
  // The broker retires it when the turn it explained is over, as an outside resolution.
  await s.mod.fire('turn.complete', { turnId: 'turn-ro', answer: 'done', durationMs: 1, isAborted: false });
  check('CX3: the broker still retires it, as external, when its turn ends',
    await until(() => approvedFrames().length === 1) && (approvedFrames()[0] as { decision?: string }).decision === 'external',
    JSON.stringify(approvedFrames()));
  s.close();
}

// ── PM1/PM2/AM1/AM2: which modes hold what, through the real mod and the app's own routes ─────
async function modeSection(): Promise<void> {
  // PM1: plan mode puts an ordinary tool call to a person, so the app can answer it.
  {
    const s = await stack('plan-mode-ask', { mode: 'plan' });
    const call = s.mod.fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-plan-ask', input: { command: 'curl -sI https://example.com' } });
    check('PM1 seam: a plan-mode ask is held for the app', await until(() => permissionCards(s).length === 1), JSON.stringify(s.cards()));
    const card = permissionCards(s)[0];
    check('PM1 seam: and its card names plan mode', card?.permissionMode === 'plan', JSON.stringify(card));
    check('PM1 seam: and the app\'s answer decides it', routeModApprove(s.frameDeps, { requestId: String(card?.requestId), decision: 'approve' })
      && decisionOf(await call) === 'allow');
    s.close();
  }
  // PM2: the plan itself is shown, whole, and left to the terminal: approving it also picks a mode.
  {
    const s = await stack('plan-approval', { mode: 'plan' });
    const plan = '# Ship the release\n\n1. Tag it.\n2. Promote it.';
    const call = s.mod.fire('tool.check', { tool: 'ExitPlanMode', tool_use_id: 'tu-plan', input: { plan, planFilePath: '/work/.claude/plan.md' } });
    check('PM2 seam: the plan goes back to Claude\'s own dialog', decisionOf(await call) === 'ask');
    const card = await until(() => s.cards().some((c) => c.readOnly === true)) ? s.cards().find((c) => c.readOnly === true) : undefined;
    check('PM2 seam: the app shows it read-only, with the plan rule as its reason',
      card?.releaseReason === 'plan:terminal-only' && card?.toolName === 'ExitPlanMode', JSON.stringify(card));
    check('PM2 seam: led by the plan\'s first line', card?.inputPreview === 'plan: # Ship the release', JSON.stringify(card?.inputPreview));
    check('PM2 seam: with the whole plan in its detail', (card?.detail ?? '').includes('2. Promote it.'), JSON.stringify(card?.detail));
    check('PM2 seam: and no band, since nothing here can answer it', !s.mod.record.bands.some((b) => b.label === 'Allow'),
      JSON.stringify(s.mod.record.bands.map((b) => b.label)));
    s.close();
  }
  // AM1: a question in auto mode is a person's, so the app answers it; AM2: the tool call is the
  // classifier's, so the app shows nothing at all for it.
  {
    const s = await stack('auto-mode', { mode: 'auto' });
    const before = s.cards().length;
    const call = s.mod.fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-auto', input: { command: 'make' } });
    check('AM2 seam: an auto-mode tool call goes straight back to Claude', decisionOf(await call) === 'ask');
    await until(() => false, 300);
    check('AM2 seam: with no card in the app, read-only or otherwise', s.cards().length === before, JSON.stringify(s.cards()));
    check('AM2 seam: and the release is still audited', s.service.auditTrail(s.sessionId).some((row) => row.released === 'mode:auto'),
      JSON.stringify(s.service.auditTrail(s.sessionId).map((row) => row.released)));
    const question = s.mod.fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: 'tu-auto-q', questions: QUESTIONS });
    check('AM1 seam: an auto-mode question is held for the app', await until(() => questionCards(s).length === 1), JSON.stringify(s.cards()));
    const qCard = questionCards(s)[0]!;
    check('AM1 seam: and the app\'s answer becomes the tool\'s result', routeModAnswer(s.frameDeps, { requestId: qCard.requestId, answers: [['Release']] })
      && JSON.stringify((await question as { result?: { answers?: unknown } })?.result?.answers) === JSON.stringify({ 'Which build?': 'Release' }));
    s.close();
  }
  // AM2: dontAsk refuses an ask after the hooks run; nothing is shown for it.
  {
    const s = await stack('dont-ask', { mode: 'dontAsk' });
    const call = s.mod.fire('tool.check', { tool: 'Write', tool_use_id: 'tu-dont', input: { file_path: '/work/x', content: 'hi' } });
    check('AM2 seam: a dontAsk call goes straight back to Claude', decisionOf(await call) === 'ask');
    void s.mod.fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: 'tu-dont-q', questions: QUESTIONS }).catch(() => undefined);
    await until(() => s.service.auditTrail(s.sessionId).length >= 2, 2000);
    check('AM2 seam: neither it nor a dontAsk question draws a card', s.cards().length === 0, JSON.stringify(s.cards()));
    s.close();
  }
}

// ── TH6: the kill-switch and attach-surface claims that had no seam test ──────────────────────
// (Two asks in one turn are `twoAsksSection`; band timing is `bandTimingSection`; hot reload and the
// steer fallback are in test-claude-mod-lifecycle-seam.ts.)
async function roundOneClaimsSection(): Promise<void> {
  // C6: the kill switch reaches the mod on the register reply itself. Every poll is held back
  // before it leaves, so the register reply is the only place the mod could have learned it.
  {
    let releasePolls!: () => void;
    const pollsHeld = new Promise<void>((resolve) => {
      releasePolls = resolve;
    });
    const s = await stack('kill-switch-on-register', {
      killSwitch: () => true,
      mod: { beforeFetch: async (request) => { if (request.route === 'poll') await pollsHeld; } },
    });
    const before = s.mod.record.requests.length;
    const decided = await s.mod.fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-ks-1', input: { command: 'make' } });
    check('TH6 (C6): with the kill switch on at registration, the mod asks the broker nothing and the engine decides',
      decisionOf(decided) === 'ask' && s.sent(before, 'hold').length === 0 && s.sent(0, 'poll').every((r) => !s.mod.record.replies.some((reply) => reply.request === r)),
      `${s.sent(before, 'hold').length} hold request(s)`);
    releasePolls();
    s.close();
  }
  // C9: an app attaching is a client's surface, not the terminal's. Copying it over the terminal's
  // left a synced session holding nothing until a restart.
  {
    const s = await stack('attach-surface');
    await s.mod.fire('session.attach', { surface: 'mobile', clientId: 'app-1' });
    const call = s.mod.fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-attach-1', input: { command: 'make' } });
    check('TH6 (C9): after an app attaches, the terminal still holds its next ask for the app', await until(() => permissionCards(s).length === 1),
      JSON.stringify(s.cards()));
    check('TH6 (C9): and its row still says terminal', s.service.status(s.sessionId).registration?.surface === 'terminal',
      String(s.service.status(s.sessionId).registration?.surface));
    routeModApprove(s.frameDeps, { requestId: permissionCards(s)[0]?.requestId ?? '', decision: 'approve' });
    check('TH6 (C9): and the app\'s answer decides it', decisionOf(await call) === 'allow');
    s.close();
  }
}

try {
  await roundOneClaimsSection();
  await readOnlyCardSection();
  await modeSection();
  await unsendableDecisionSection();
  await deadlineSweepSection();
  await patientHoldSection();
  await eventDrivenHoldSection();
  await failedTapSection();
  await failedCommandSection();
  await refusedHoldSection();
  await abortedHookSection();
  await bandTimingSection();
  await twoAsksSection();
  await settledElsewhereSection();
  await appIdSection();
  await questionEndsSection();
  await questionCallSection();
  await questionRuleSection();
  await oldClientDetailSection();
  await fullDetailSection();
  check('no unhandled rejection escaped the mod', unhandled.length === 0, unhandled.join(' | '));
} catch (error) {
  check('the suite ran to the end', false, String((error as Error)?.stack ?? error).slice(0, 600));
} finally {
  for (const cleanup of cleanups.reverse()) {
    try {
      cleanup();
    } catch {
      /* best effort */
    }
  }
}
finish();
