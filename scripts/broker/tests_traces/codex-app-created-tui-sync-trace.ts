/**
 * Codex APP-CREATED session → terminal joins → true sync both ways (OPT-IN, real binary, real model).
 *
 * maintainer's 2026-07-12 re-flag, reproduced verbatim: create a codex session in the app (spark), send a
 * message, run the advertised sync command in a real terminal — before the fix, app prompts kept
 * going to the broker-owned stdio rival while the TUI wrote the same thread through the daemon: no
 * relay either way. The existing codex sync traces all started from a thread ALREADY loaded in the
 * daemon and attached bare, so the app-created→driven(`?mode=resume`)→terminal-joins TRANSITION — the
 * Hub identity seam where the bug lived — was never crossed (same test-blind-spot class as the pi
 * item-3 and draft-sync item-14 splits: uniform attachs can't produce the mode-scoped twin).
 *
 * Proves, against a real codex app-server daemon + real TUI in tmux + real broker WebSocket:
 *   1. the created session attaches in Drive mode and answers a first spark prompt — and the PUSHED
 *      session frame corrects the sync-dialog hint to `-m <model in use>` (2026-07-13 re-flag: the
 *      dialog advertised the config default `-m gpt-5.6-sol` on a spark session);
 *   2. the advertised sync command carries `cd <workspace> && … --remote <our-sock> -m <model>`;
 *   3. running it flips the OPEN socket to live true-sync (fold + upgrade, no reattach by the app);
 *   3a. a message typed INSIDE the join→fold window still reaches the open app socket via the
 *       fold's history resync (2026-07-13 re-flag: typed seconds after joining → invisible forever) —
 *       plus the round-3 hardening lanes: a timing SWEEP (identical sends at ~+1s/+3s straddle the
 *       fold boundary; both must survive as distinct records incl. in the reopen replay), a REVERSE
 *       window recorder (an app prompt at t≈0 post-join must never be silently swallowed; terminal
 *       rendering/persistence recorded — known residual until a send-time loaded check ships), and a
 *       surface-agreement audit (roster row vs session frame must tell one truth for sync command /
 *       mode / model — the spark→sol split lived exactly between those surfaces);
 *   4. an app prompt renders in the terminal, a terminal prompt renders in the app;
 *   4b. (issues-part3 #36) an approval raised under ask-permission and ANSWERED IN THE TERMINAL
 *       auto-clears the app card as 'external' via serverRequest/resolved — no stuck card;
 *   4c. (issues-part3 #37) an explicit approve-for-me pick survives a REOPEN (fresh app socket
 *       shows approve-for-me, not the old "always back to ask permission" reset);
 *   5. killing the terminal drops the synced badge within seconds WITHOUT tearing down the live
 *      conn — the composer still answers (the loaded list alone would have latched the badge on).
 *
 *   COSYNCING_CODEX_APP_CREATED_SYNC=1 bun run scripts/broker/tests_traces/codex-app-created-tui-sync-trace.ts
 */
export {};
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Assertion,
  archiveCodexDaemonThread,
  check,
  command,
  drainProcessOutput,
  freePort,
  hasCommand,
  probeCodexDaemon,
  record,
  sleep,
  tmux,
  tmuxCapture,
  waitForFile,
  waitFrame,
  waitHealth,
} from './_real-tui-app-helpers.ts';

const enabled = process.env.COSYNCING_CODEX_APP_CREATED_SYNC === '1';
if (!enabled) {
  console.log('SKIP codex app-created tui-sync - set COSYNCING_CODEX_APP_CREATED_SYNC=1 (opt-in: real codex daemon + TUI + model turns)');
  process.exit(0);
}

const PORT = Number(process.env.COSYNCING_TEST_PORT ?? await freePort());
const BROKER = `http://127.0.0.1:${PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const short = randomBytes(3).toString('hex');
const outDir = join(process.cwd(), 'output', 'traces', runId, 'codex', 'app-created-tui-sync');
const framesPath = join(outDir, 'frames.ndjson');
const brokerPath = join(outDir, 'broker.ndjson');
const appServerPath = join(outDir, 'app-server.ndjson');
const cleanupAppServerPath = join(outDir, 'cleanup-app-server.ndjson');
const tuiPath = join(outDir, 'tui.txt');
const tracePath = join(outDir, 'trace.json');
const model = process.env.COSYNCING_CODEX_TEST_MODEL ?? 'gpt-5.3-codex-spark';
const appServerRoot = mkdtempSync(join(tmpdir(), `cosyncing-codex-appcreated-appserver-${short}-`));
const sock = join(appServerRoot, 'app-server.sock');
const remote = `unix://${sock}`;
const workspace = mkdtempSync(join(tmpdir(), `cosyncing-codex-appcreated-${short}-`));
const tmuxName = `cosyncing-codex-appcreated-${process.pid}-${short}`;
const assertions: Assertion[] = [];
const frames: any[] = [];
mkdirSync(outDir, { recursive: true });

let appServer: ReturnType<typeof Bun.spawn> | undefined;
let cleanupAppServer: ReturnType<typeof Bun.spawn> | undefined;
let broker: ReturnType<typeof Bun.spawn> | undefined;
let ws: WebSocket | undefined;
let threadId = '';
let sessionId = '';
let skipReason: string | null = null;

try {
  if (!(await hasCommand('codex'))) skip('codex is not on PATH');
  if (!(await hasCommand('tmux'))) skip('tmux is not on PATH');

  appServer = startAppServer(appServerPath);
  check(assertions, 'temporary real Codex app-server socket appears', await waitForFile(sock, 15000), remote);
  if (!assertions.at(-1)?.ok) throw new Error(`temporary Codex app-server did not create ${sock}: ${fileTail(appServerPath)}`);
  const probe = await probeCodexDaemon(sock);
  check(assertions, 'real Codex app-server WebSocket probe succeeds', probe.ok, probe.detail);
  if (!probe.ok) throw new Error(`Codex app-server probe failed at ${remote}: ${probe.detail}`);

  broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      COSYNCING_CODEX_SYNC_SERVER: '1',
      COSYNCING_CODEX_SYNC_WATCH_MS: '250',
      COSYNCING_CODEX_APP_SERVER_SOCK: sock,
      COSYNCING_CODEX_REMOTE_ADDR: remote,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  drainProcessOutput(broker, brokerPath);
  check(assertions, 'sync-enabled broker starts', await waitHealth(`${BROKER}/api/health`, 15000), BROKER);
  if (!assertions.at(-1)?.ok) throw new Error(`broker did not start at ${BROKER}: ${fileTail(brokerPath)}`);

  // ── 1. create in the app + first driven spark turn ──────────────────────────────────────────────
  const createResp = await fetch(`${BROKER}/api/sessions/codex`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ directory: workspace, title: `app-created sync trace ${short}` }),
  });
  const created: any = await createResp.json();
  sessionId = String(created?.session?.id ?? '');
  check(assertions, 'app-created Codex session exists with the requested cwd', !!sessionId && created?.session?.cwd === workspace, JSON.stringify({ cwd: created?.session?.cwd, attachMode: created?.attachMode }));
  check(assertions, 'the broker directs the app to open it in Drive mode (the identity under test)', created?.attachMode === 'resume', String(created?.attachMode));

  ws = new WebSocket(`${WSBASE}/api/sessions/codex/${encodeURIComponent(sessionId)}/stream?mode=resume`);
  ws.onmessage = (e) => {
    try {
      const frame = JSON.parse(String(e.data));
      frames.push(frame);
      record(framesPath, frame);
    } catch {
      /* malformed frame */
    }
  };
  await new Promise<void>((resolve, reject) => {
    ws!.onopen = () => resolve();
    ws!.onerror = () => reject(new Error('trace WebSocket failed'));
  });
  await waitFrame(frames, (f) => f.kind === 'session', 10000);

  const initMark = frames.length;
  ws.send(JSON.stringify({ kind: 'prompt', text: `Reply with exactly INIT_OK_${short} and nothing else. Do not run tools.`, model: { providerID: 'openai', modelID: model } }));
  const initReply = await waitFrame(frames, (f) => frames.indexOf(f) >= initMark && f.kind === 'message' && f.message?.type === 'model-output' && new RegExp(`INIT_OK_${short}`).test((f.message.text ?? '') + (f.message.delta ?? '')), 120000);
  check(assertions, 'driven first prompt answers on the app-created session (spark)', !!initReply, initReply?.message?.key ?? 'no reply in 120s');
  threadId = codexThreadId(created.session) || codexThreadId(await rosterRow());

  // issues-part2 item-15 follow-up: the SESSION-FRAME hint (what the app's sync dialog copies) must
  // advertise the model this session actually runs. The attach-time frame carries the config default
  // (the thread was created before any pick); the explicit spark prompt above must push a corrected
  // frame — before the fix the update was silent and maintainer copied `-m gpt-5.6-sol` off a spark session.
  const sparkHintFrame = await waitFrame(
    frames,
    (f) => f.kind === 'session' && String(f.info?.control?.terminalSync?.command ?? '').includes(`-m ${model}`),
    15000,
  );
  check(assertions, 'a pushed session frame corrects the sync-dialog hint to the model in use (-m spark, not the config default)', !!sparkHintFrame, String([...frames].reverse().find((f) => f.kind === 'session')?.info?.control?.terminalSync?.command ?? 'no session frame'));

  // ── 2. the advertised sync command (roster row: hint model comes from the recorded rollout, which
  // codex flushes shortly after the turn — poll briefly instead of racing the write) ───────────────
  let syncCmd = '';
  for (let i = 0; i < 20; i++) {
    const row = await rosterRow();
    syncCmd = String(row?.control?.terminalSync?.command ?? row?.terminalSyncHint?.command ?? '');
    if (syncCmd.includes(' -m ')) break;
    await sleep(1000);
  }
  check(assertions, 'sync hint leads with cd <workspace> && codex resume --remote <our-sock>', syncCmd.startsWith(`cd ${workspace} && codex resume --remote ${remote}`), syncCmd);
  check(assertions, 'sync hint pins the recorded model (-m) so the terminal does not drift', syncCmd.includes(` -m ${model} `) || syncCmd.includes(` -m '${model}' `), syncCmd);
  check(assertions, 'sync hint names this thread', !!threadId && syncCmd.includes(threadId), threadId);

  // Surface-agreement audit (lessons A9): the SAME fact reaches the client via the roster row AND
  // the session frame (the dialog copies the frame) — the spark→sol bug was a split between them
  // that stayed green because only one surface was asserted. Compare whichever facts both carry.
  const auditSurfaces = async (label: string, frameSource: () => any) => {
    const row = await rosterRow();
    const frame = frameSource();
    const facts: Array<[string, unknown, unknown]> = [
      ['syncCommand', row?.control?.terminalSync?.command, frame?.info?.control?.terminalSync?.command],
      ['currentMode', row?.currentMode, frame?.info?.currentMode],
      ['currentModel', row?.currentModel?.modelID, frame?.info?.currentModel?.modelID],
    ];
    const splits = facts.filter(([, a, b]) => a !== undefined && b !== undefined && a !== b);
    check(assertions, `surface agreement ${label}: roster row and session frame tell one truth`, splits.length === 0,
      splits.length ? JSON.stringify(splits) : facts.map(([k, a]) => `${k}=${String(a).slice(0, 60)}`).join(' | '));
  };
  const lastSessionFrame = () => [...frames].reverse().find((f) => f.kind === 'session');
  await auditSurfaces('(post-prompt)', lastSessionFrame);

  // ── 3. run it in a real terminal → the OPEN app socket must flip to live true-sync ──────────────
  // The -m/effort pin is COST SAFETY for the trace: if the hint assertion above regressed, the TUI
  // must still never run the user's default model at default effort. clap rejects a duplicate -m,
  // so pin it only when the hint lacks one.
  const modelPin = syncCmd.includes(' -m ') ? '' : ` -m ${model}`;
  const flipMark = frames.length;
  await tmux(['new-session', '-d', '-s', tmuxName, '-c', workspace]);
  // check_for_update_on_startup=false: a fresh codex release otherwise blocks the TUI on an
  // interactive "Update available — press enter" gate, eating the join window and every keystroke
  // this trace sends (observed live when 0.144.2 shipped mid-run).
  await tmux(['send-keys', '-t', tmuxName, '--', `${syncCmd} --no-alt-screen${modelPin} -c model_reasoning_effort="low" -c check_for_update_on_startup=false`, 'C-m']);

  // ── 3a. type INSIDE the join→fold window (maintainer's real timing) ──────────────────────────────────
  // He joined the terminal and typed within seconds; the thread was daemon-loaded but the broker's
  // sync watch (2.5s poll) had not folded yet, so the message went through the daemon while the app
  // still listened to the stdio rival — and without the fold-resync it stayed invisible forever.
  const fastMarker = `FAST_TUI_${short}`;
  let tuiBanner = false;
  for (let i = 0; i < 30 && !tuiBanner; i++) {
    tuiBanner = /OpenAI Codex/.test(await tmuxCapture(tmuxName, 200));
    if (!tuiBanner) await sleep(500);
  }
  check(assertions, 'the joining TUI renders its composer', tuiBanner);

  // ── 3a-i. REVERSE window recorder: an APP prompt at t≈0 post-join ────────────────────────────────
  // Known residual limit (documented, not yet closed): this prompt races the fold and usually routes
  // through the stdio rival, which the fold then closes mid-turn — it must NEVER be swallowed
  // silently (hard assert: echo or an explicit error), while pane rendering and persistence are
  // RECORDED so drift shows in every run. Flip the recorder to hard asserts when a send-time
  // daemon-loaded check ships.
  const revMarker = `REV_APP_${short}`;
  const revMark = frames.length;
  ws.send(JSON.stringify({ kind: 'prompt', text: `Reply with exactly ACK_REV_${short} and nothing else. Marker: ${revMarker}` }));

  await tmux(['send-keys', '-t', tmuxName, '--', `Reply with exactly ACK_FAST_${short} and nothing else. Marker: ${fastMarker}`]);
  await sleep(300);
  await tmux(['send-keys', '-t', tmuxName, 'Enter']);
  // ── 3a-ii. timing sweep: two more identical sends at ~+1s and ~+3s straddle the fold boundary, so
  // the window is swept every run instead of sampled at one lucky offset (a single timing drifts
  // green as machine speed changes). Identical text on purpose: distinct records are the merge guard.
  // CONFIRMED-SUBMIT typing: while a turn is streaming, the codex composer can coalesce text+Enter
  // as a paste (Enter becomes a newline — observed live: both sweeps merged into ONE two-line
  // message). Retry Enter until the submitted `›` echo appears, and never type the next sweep before
  // the previous one is confirmed — delivery is the sweep's point, exact offsets are not.
  const sweepText = `Sweep ping SWEEP_${short} — reply with exactly OK and nothing else.`;
  const sweepEchoes = async (): Promise<number> => ((await tmuxCapture(tmuxName, 2000)).match(/› Sweep ping SWEEP_/g) ?? []).length;
  const typeSweep = async (n: number): Promise<void> => {
    await tmux(['send-keys', '-t', tmuxName, '--', sweepText]);
    await sleep(400);
    await tmux(['send-keys', '-t', tmuxName, 'Enter']);
    for (let i = 0; i < 15 && (await sweepEchoes()) < n; i++) {
      await sleep(700);
      await tmux(['send-keys', '-t', tmuxName, 'Enter']); // empty-composer Enter is a no-op; a pending multi-line composer submits
    }
  };
  await sleep(700);
  await typeSweep(1);
  await sleep(1000);
  await typeSweep(2);

  const flipped = await waitFrame(
    frames,
    (f) => frames.indexOf(f) >= flipMark && f.kind === 'session' && f.info?.attachMode === 'live' && f.info?.control?.terminalSync?.active === true,
    45000,
  );
  check(assertions, 'terminal join upgrades the OPEN app socket to live true-sync (fold, no app reattach)', !!flipped, JSON.stringify(flipped?.info?.control?.terminalSync ?? frames.at(-1)?.info?.control ?? null));
  check(assertions, 'the upgrade does not emit a misleading ended frame', !frames.slice(flipMark).some((f) => f.kind === 'ended'));
  // The fast-typed message may arrive live (typed post-fold) or inside the fold's resync history
  // frame (typed pre-fold) — both count; NEVER arriving is the reported bug.
  const hasFast = (f: any) =>
    (f.kind === 'message' && f.message?.type === 'user-message' && f.message.text?.includes(fastMarker)) ||
    (f.kind === 'history' && Array.isArray(f.messages) && f.messages.some((m: any) => m?.type === 'user-message' && String(m.text ?? '').includes(fastMarker)));
  const fastSeen = await waitFrame(frames, hasFast, 30000);
  check(assertions, 'a TUI message typed INSIDE the join window reaches the open app socket (fold resync — the exact reported miss)', !!fastSeen, fastSeen?.kind ?? 'never arrived');
  // The sweep sends below STEER into this turn, so the model obeys the newest queued instruction —
  // the reply may be ACK_FAST or the sweep's "OK". What must hold: the turn's output reaches the
  // app (live post-fold delta, or the ACK inside a resync snapshot if it all happened pre-fold).
  const fastAt = frames.indexOf(fastSeen!);
  const hasFastReply = (f: any) =>
    (frames.indexOf(f) > fastAt && f.kind === 'message' && f.message?.type === 'model-output') ||
    (f.kind === 'history' && Array.isArray(f.messages) && f.messages.some((m: any) => m?.type === 'model-output' && new RegExp(`ACK_FAST_${short}`).test(String(m.text ?? ''))));
  const fastReply = await waitFrame(frames, hasFastReply, 120000);
  check(assertions, "the join-window turn's output reaches the app (reply may follow any queued instruction)", !!fastReply, fastReply?.kind ?? 'no output in 120s');

  // Timing-sweep arrival: count sweeps in the CURRENT VIEW the app would render — the latest history
  // frame (a history frame resets the thread) plus live user-message frames after it. Identical
  // texts must still count 2: distinct records, the merge guard from the cardinality rule.
  const sweepVisible = (fs: any[]): number => {
    let lastHistIdx = -1;
    fs.forEach((f, i) => { if (f.kind === 'history') lastHistIdx = i; });
    const inHist = lastHistIdx >= 0
      ? (fs[lastHistIdx].messages ?? []).filter((m: any) => m?.type === 'user-message' && String(m.text ?? '').includes(`SWEEP_${short}`)).length
      : 0;
    const liveAfter = fs.slice(lastHistIdx + 1).filter((f) => f.kind === 'message' && f.message?.type === 'user-message' && String(f.message.text ?? '').includes(`SWEEP_${short}`)).length;
    return inHist + liveAfter;
  };
  let sweepSeen = 0;
  for (let i = 0; i < 60 && sweepSeen < 2; i++) {
    sweepSeen = sweepVisible(frames);
    if (sweepSeen < 2) await sleep(1000);
  }
  check(assertions, 'timing sweep: identical messages at ~+1s/+3s BOTH reach the app view as distinct records', sweepSeen >= 2, `visible=${sweepSeen}`);

  // REVERSE window: the join-window app prompt must never be silently swallowed — an echo, its
  // presence in a resync snapshot, or an explicit error are all acceptable; silence is the bug.
  const revAck = await waitFrame(
    frames,
    (f) => frames.indexOf(f) >= revMark && (
      (f.kind === 'message' && f.message?.type === 'user-message' && f.message.text?.includes(revMarker)) ||
      (f.kind === 'history' && Array.isArray(f.messages) && f.messages.some((m: any) => m?.type === 'user-message' && String(m.text ?? '').includes(revMarker))) ||
      (f.kind === 'message' && f.message?.type === 'error') ||
      f.kind === 'error'
    ),
    30000,
  );
  check(assertions, 'a join-window APP prompt is never silently swallowed (echo, resync, or explicit error)', !!revAck, revAck ? `${revAck.kind}/${revAck.message?.type ?? ''}` : 'silence for 30s');
  // Recorded, not gated (known residual — the rival serves it and the fold may kill that turn):
  // whether the reverse prompt rendered in the terminal and whether its turn answered.
  const revInPane = (await tmuxCapture(tmuxName, 2000)).includes(revMarker);
  const revAnswered = frames.some((f) =>
    (f.kind === 'message' && f.message?.type === 'model-output' && new RegExp(`ACK_REV_${short}`).test((f.message.text ?? '') + (f.message.delta ?? ''))) ||
    (f.kind === 'history' && Array.isArray(f.messages) && f.messages.some((m: any) => m?.type === 'model-output' && new RegExp(`ACK_REV_${short}`).test(String(m.text ?? '')))));
  check(assertions, 'REVERSE WINDOW recorded (expected-miss lane, flip to hard asserts with a send-time loaded check)', true, `renderedInTerminal=${revInPane} answered=${revAnswered}`);

  // Let the in-flight turns settle before the app prompt below, so it rides a fresh turn/start.
  await waitFrame(frames, (f) => frames.indexOf(f) > frames.indexOf(fastReply ?? flipped!) && f.kind === 'message' && f.message?.type === 'status' && f.message.status === 'idle', 60000);
  await auditSurfaces('(post-join)', lastSessionFrame);

  // ── 4. both-way relay ────────────────────────────────────────────────────────────────────────────
  const appMark = frames.length;
  const appMarker = `APP_TO_TUI_${short}`;
  ws.send(JSON.stringify({ kind: 'prompt', text: `Reply with exactly ACK_APP_${short} and nothing else. Marker: ${appMarker}` }));
  const appEcho = await waitFrame(frames, (f) => frames.indexOf(f) >= appMark && f.kind === 'message' && f.message?.type === 'user-message' && f.message.text?.includes(appMarker), 20000);
  const appReply = await waitFrame(frames, (f) => frames.indexOf(f) >= appMark && f.kind === 'message' && f.message?.type === 'model-output' && new RegExp(`ACK_APP_${short}`).test((f.message.text ?? '') + (f.message.delta ?? '')), 120000);
  check(assertions, 'post-join app prompt echoes and answers through the daemon', !!appEcho && !!appReply, JSON.stringify({ echo: appEcho?.message?.key, reply: appReply?.message?.key }));
  let paneHasAppPrompt = false;
  for (let i = 0; i < 30 && !paneHasAppPrompt; i++) {
    paneHasAppPrompt = (await tmuxCapture(tmuxName, 2000)).includes(appMarker);
    if (!paneHasAppPrompt) await sleep(1000);
  }
  check(assertions, 'the app prompt RENDERS IN THE TERMINAL (the exact reported failure)', paneHasAppPrompt, appMarker);

  const tuiMark = frames.length;
  const tuiMarker = `TUI_TO_APP_${short}`;
  // Two-step submit (text, pause, Enter) — a trailing C-m in the same send-keys call is treated as
  // pasted input by the codex composer and inserts a newline instead of submitting.
  await tmux(['send-keys', '-t', tmuxName, '--', `Reply with exactly ACK_TUI_${short} and nothing else. Marker: ${tuiMarker}`]);
  await sleep(300);
  await tmux(['send-keys', '-t', tmuxName, 'Enter']);
  const tuiUser = await waitFrame(frames, (f) => frames.indexOf(f) >= tuiMark && f.kind === 'message' && f.message?.type === 'user-message' && f.message.text?.includes(tuiMarker), 30000);
  const tuiReply = await waitFrame(frames, (f) => frames.indexOf(f) >= tuiMark && f.kind === 'message' && f.message?.type === 'model-output' && new RegExp(`ACK_TUI_${short}`).test((f.message.text ?? '') + (f.message.delta ?? '')), 120000);
  check(assertions, 'a terminal-typed prompt RENDERS IN THE APP with its reply (the other direction)', !!tuiUser && !!tuiReply, JSON.stringify({ user: tuiUser?.message?.key, reply: tuiReply?.message?.key }));

  // ── 4b. issues-part3 #36: an approval answered IN THE TERMINAL must clear the app card ──────────
  // Explicit ask-permission (approvalPolicy untrusted) guarantees the shell command raises approval —
  // but only on a fresh turn/start (steer ignores permissionMode), so wait out the TUI turn first.
  const tuiReplyAt = frames.indexOf(tuiReply);
  await waitFrame(frames, (f) => frames.indexOf(f) > tuiReplyAt && f.kind === 'message' && f.message?.type === 'status' && f.message.status === 'idle', 60000);
  const permMark = frames.length;
  ws.send(JSON.stringify({
    kind: 'prompt',
    text: `Use the shell to run exactly this command: touch APPROVAL_PROBE_${short}.txt — then reply with exactly DONE_${short}.`,
    permissionMode: 'ask-permission',
  }));
  const permCard = await waitFrame(frames, (f) => frames.indexOf(f) >= permMark && f.kind === 'message' && f.message?.type === 'permission-request' && !f.message.readOnly, 120000);
  check(assertions, 'untrusted-policy command raises a live approval card in the app', !!permCard, permCard?.message?.detail?.slice(0, 120) ?? 'no card in 120s');
  // The synced TUI shows the same approval dialog; Enter accepts its default ("Yes"). Give the TUI a
  // moment to focus the dialog, and snapshot the pane first so a miss is diagnosable from artifacts.
  await sleep(2000);
  writeFileSync(join(outDir, 'tui-approval-dialog.txt'), await tmuxCapture(tmuxName, 2000));
  await tmux(['send-keys', '-t', tmuxName, 'Enter']);
  const permCleared = await waitFrame(frames, (f) => frames.indexOf(f) >= permMark && f.kind === 'message' && f.message?.type === 'permission-resolved' && f.message.requestId === permCard?.message?.requestId, 30000);
  check(assertions, 'CLI approval auto-clears the app card (was: stuck forever)', !!permCleared, JSON.stringify(permCleared?.message ?? null));
  check(assertions, "externally answered card resolves as 'external' (decision is not fabricated)", permCleared?.message?.decision === 'external', String(permCleared?.message?.decision ?? 'none'));
  const permReply = await waitFrame(frames, (f) => frames.indexOf(f) >= permMark && f.kind === 'message' && f.message?.type === 'model-output' && new RegExp(`DONE_${short}`).test((f.message.text ?? '') + (f.message.delta ?? '')), 120000);
  check(assertions, 'the approved command turn completes normally', !!permReply, permReply?.message?.key ?? 'no reply in 120s');
  // The reply text lands before turn/completed: wait for idle, or the next prompt STEERS into this
  // turn and its permissionMode is (by design) ignored — the pick below must ride a fresh turn/start.
  const permReplyAt = frames.indexOf(permReply);
  await waitFrame(frames, (f) => frames.indexOf(f) > permReplyAt && f.kind === 'message' && f.message?.type === 'status' && f.message.status === 'idle', 60000);

  // ── 4c. issues-part3 #37: an explicit approve-for-me pick must survive a REOPEN ─────────────────
  const modeMark = frames.length;
  ws.send(JSON.stringify({ kind: 'prompt', text: `Reply with exactly MODE_OK_${short} and nothing else. Do not run tools.`, permissionMode: 'approve-for-me' }));
  const modeReply = await waitFrame(frames, (f) => frames.indexOf(f) >= modeMark && f.kind === 'message' && f.message?.type === 'model-output' && new RegExp(`MODE_OK_${short}`).test((f.message.text ?? '') + (f.message.delta ?? '')), 120000);
  check(assertions, 'approve-for-me pick rides a turn and answers', !!modeReply, modeReply?.message?.key ?? 'no reply in 120s');
  const reopenFrames: any[] = [];
  const reopenWs = new WebSocket(`${WSBASE}/api/sessions/codex/${encodeURIComponent(sessionId)}/stream`);
  reopenWs.onmessage = (e) => {
    try {
      const frame = JSON.parse(String(e.data));
      reopenFrames.push(frame);
      record(framesPath, { phase: 'reopen', frame });
    } catch {
      /* malformed frame */
    }
  };
  await new Promise<void>((resolve, reject) => {
    reopenWs.onopen = () => resolve();
    reopenWs.onerror = () => reject(new Error('reopen WebSocket failed'));
  });
  const reopenSession = await waitFrame(reopenFrames, (f) => f.kind === 'session', 10000);
  check(assertions, 'REOPENING the session shows approve-for-me, not the old reset to "ask permission"', reopenSession?.info?.currentMode === 'approve-for-me', String(reopenSession?.info?.currentMode ?? 'none'));
  const reopenStuckCards = reopenFrames.filter((f) => f.kind === 'message' && f.message?.type === 'permission-request');
  check(assertions, 'the reopened socket replays no settled approval cards (was: previously approved reappear)', reopenStuckCards.length === 0, `${reopenStuckCards.length} replayed cards`);
  // The replay is one snapshot of the whole thread: exact cardinality for the identical sweep sends
  // (2 records, not 1 merged bubble), and the recorded fate of the reverse-window prompt.
  const reopenHistory = await waitFrame(reopenFrames, (f) => f.kind === 'history' && Array.isArray(f.messages), 15000);
  const reopenSweeps = (reopenHistory?.messages ?? []).filter((m: any) => m?.type === 'user-message' && String(m.text ?? '').includes(`SWEEP_${short}`)).length;
  check(assertions, 'reopen replay preserves BOTH identical sweep messages as distinct records (cardinality)', reopenSweeps === 2, `replayed=${reopenSweeps}`);
  const reopenHasRev = (reopenHistory?.messages ?? []).some((m: any) => m?.type === 'user-message' && String(m.text ?? '').includes(revMarker));
  check(assertions, 'REVERSE WINDOW persistence recorded on reopen (expected-miss lane)', true, `reverse prompt in replay=${reopenHasRev}`);
  await auditSurfaces('(post-reopen)', () => [...reopenFrames].reverse().find((f) => f.kind === 'session'));
  reopenWs.close();

  // ── 5. terminal exit → badge OFF, live conn intact ──────────────────────────────────────────────
  writeFileSync(tuiPath, await tmuxCapture(tmuxName, 3000));
  const exitMark = frames.length;
  await command(['tmux', 'kill-session', '-t', tmuxName]);
  const badgeOff = await waitFrame(
    frames,
    (f) => frames.indexOf(f) >= exitMark && f.kind === 'session' && f.info?.control?.terminalSync?.active === false,
    15000,
  );
  check(assertions, 'terminal exit drops the synced badge within seconds (loaded list alone would latch it on)', !!badgeOff, JSON.stringify(badgeOff?.info?.control?.terminalSync ?? null));
  check(assertions, 'badge-off never emits a misleading ended frame', !frames.slice(exitMark).some((f) => f.kind === 'ended'));
  // After the TUI exits, the daemon EITHER keeps the thread loaded (conn stays live; the composer
  // must still answer) OR unloads it (the watch downgrades the conn class to observe; the prompt
  // gate must reject honestly). Both are honest ends — what must NEVER remain is a stale synced
  // claim or a mismatched observe-info-on-live-conn transport.
  await waitFrame(frames, (f) => frames.indexOf(f) >= exitMark && f.kind === 'session' && f.info?.attachMode !== 'live', 5000);
  const lastSession = [...frames].reverse().find((f) => f.kind === 'session');
  const stillLive = lastSession?.info?.attachMode === 'live';
  const postMark = frames.length;
  ws.send(JSON.stringify({ kind: 'prompt', text: `Reply with exactly ACK_POST_${short} and nothing else.` }));
  if (stillLive) {
    const postReply = await waitFrame(frames, (f) => frames.indexOf(f) >= postMark && f.kind === 'message' && f.message?.type === 'model-output' && new RegExp(`ACK_POST_${short}`).test((f.message.text ?? '') + (f.message.delta ?? '')), 120000);
    check(assertions, 'thread stayed daemon-loaded: the composer still answers after the terminal left', !!postReply, postReply?.message?.key ?? 'no reply in 120s');
  } else {
    const rejected = await waitFrame(frames, (f) => frames.indexOf(f) >= postMark && f.kind === 'error' && /read-only observe session/.test(String(f.message ?? '')), 8000);
    check(assertions, 'daemon unloaded the thread: the socket downgraded cleanly and rejects prompts at the boundary', !!rejected && lastSession?.info?.control?.terminalSync?.active === false, JSON.stringify({ error: rejected?.message, control: lastSession?.info?.control?.terminalSync }));
  }
} catch (err) {
  if (!skipReason) check(assertions, 'codex app-created tui-sync completed without exception', false, String(err));
} finally {
  try {
    if (!readFileSafe(tuiPath)) writeFileSync(tuiPath, await tmuxCapture(tmuxName, 3000).catch(() => '<no pane>'));
  } catch {
    /* no pane */
  }
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  try {
    broker?.kill();
  } catch {
    /* ignore */
  }
  try {
    appServer?.kill();
  } catch {
    /* ignore */
  }
  await command(['tmux', 'kill-session', '-t', tmuxName]).catch(() => undefined);
  if (threadId) {
    rmSync(sock, { force: true });
    cleanupAppServer = startAppServer(cleanupAppServerPath);
    if (await waitForFile(sock, 15000)) {
      const archived = await archiveCodexDaemonThread(sock, threadId);
      check(assertions, 'real Codex test thread archived during cleanup', archived.ok, archived.detail);
    } else {
      check(assertions, 'real Codex test thread archived during cleanup', false, `cleanup app-server socket missing: ${fileTail(cleanupAppServerPath)}`);
    }
  }
  try {
    cleanupAppServer?.kill();
  } catch {
    /* ignore */
  }
  const failed = assertions.filter((a) => !a.ok).length;
  writeFileSync(tracePath, JSON.stringify({
    agent: 'codex',
    scenarioIds: ['ST-33'],
    mode: 'app-created-tui-sync',
    broker: BROKER,
    workspace,
    tmuxName,
    model,
    remote,
    sessionId,
    threadId,
    output: { frames: framesPath, broker: brokerPath, appServer: appServerPath, cleanupAppServer: cleanupAppServerPath, tui: tuiPath },
    assertions,
    status: skipReason ? 'skip' : failed ? 'fail' : 'pass',
    skipReason,
  }, null, 2));
  rmSync(workspace, { recursive: true, force: true });
  rmSync(appServerRoot, { recursive: true, force: true });
  console.log(`\ntrace: ${tracePath}`);
  console.log(skipReason ? `SKIP ${skipReason}` : `${assertions.length - failed} passed, ${failed} failed`);
  process.exit(skipReason || failed === 0 ? 0 : 1);
}

function startAppServer(logPath: string): ReturnType<typeof Bun.spawn> {
  const proc = Bun.spawn(['codex', 'app-server', '--listen', remote], {
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  drainProcessOutput(proc, logPath);
  return proc;
}

function skip(reason: string): never {
  skipReason = reason;
  throw new Error(reason);
}

async function rosterRow(): Promise<any> {
  const resp = await fetch(`${BROKER}/api/sessions`);
  const body: any = await resp.json();
  const sessions: any[] = Array.isArray(body) ? body : body.sessions ?? [];
  return sessions.find((s) => s.tool === 'codex' && s.id === sessionId);
}

function codexThreadId(session: any): string {
  const hint = String(session?.terminalSyncHint?.command ?? session?.control?.terminalSync?.command ?? '');
  const fromHint = hint.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  if (fromHint) return fromHint;
  try {
    const raw = String(session?.id ?? '').replace(/-/g, '+').replace(/_/g, '/');
    const path = Buffer.from(raw, 'base64').toString('utf8');
    return path.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? '';
  } catch {
    return '';
  }
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function fileTail(path: string): string {
  try {
    return readFileSync(path, 'utf8').slice(-2000);
  } catch {
    return '<no output captured>';
  }
}
