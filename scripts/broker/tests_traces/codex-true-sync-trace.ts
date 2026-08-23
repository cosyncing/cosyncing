/**
 * Codex true-sync scenario trace driver.
 *
 * Simulates the managed Codex app-server daemon over WebSocket on a Unix socket, starts an isolated
 * cosyncing broker, then proves app->daemon and daemon->app live flow plus the approval path.
 * No model turn is sent to real Codex.
 *
 * Writes trace artifacts under output/traces/<run-id>/codex/ST-03-ST-04-ST-14/.
 *
 *   bun run scripts/broker/tests_traces/codex-true-sync-trace.ts
 */
export {};
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';

const PORT = Number(process.env.COSYNCING_TEST_PORT ?? 22000 + Math.floor(Math.random() * 20000));
const BROKER = `http://127.0.0.1:${PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(process.cwd(), 'output', 'traces', runId, 'codex', 'ST-03-ST-04-ST-14');
const framesPath = join(outDir, 'frames.ndjson');
const daemonPath = join(outDir, 'daemon.ndjson');
const tracePath = join(outDir, 'trace.json');
const scenarioIds = ['ST-03', 'ST-04', 'ST-14'];
const steps = [
  'start fake Codex daemon WebSocket on a Unix socket',
  'create visible and hidden rollout JSONL sessions under an isolated CODEX_HOME',
  'start isolated broker with COSYNCING_CODEX_SYNC_SERVER=1',
  'discover sessions and verify only visible daemon-loaded rows are live',
  'attach a browser WebSocket client to the visible live Codex row',
  'send app-originated prompt and observe daemon turn/start plus app echo',
  'emit daemon-originated terminal prompt and observe app user/model frames',
  'emit daemon approval request, approve from app, and observe daemon response',
  'verify prompts without an explicit pick do not override approvalPolicy, while explicit picks ride turn/start',
  'emit approval request, resolve it via serverRequest/resolved (terminal answered), and verify the app card settles as external',
  'emit approval request, end the turn unanswered, and verify settlement plus no replay to a late-joining client',
  'broadcast thread/settings/updated and verify currentMode mirrors into the app session frame',
  'resume-attach a non-loaded thread and verify the rollout approval policy is restored via thread/settings/update',
  'close the app during a daemon active turn and verify no turn/interrupt is sent',
  'remove the thread from daemon loaded-list and verify the app downgrades to Observe with no stale active sync',
];
const THREAD_ID = '019ed333-0000-7000-8000-000000000001';
const HIDDEN_ID = '019ed333-0000-7000-8000-000000000002';
const NOT_LOADED_ID = '019ed333-0000-7000-8000-000000000003';
const TRACE_TOKEN = 'codex-true-sync-trace-token';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const traceAuthHeaders = { 'x-cosyncing-token': TRACE_TOKEN };

async function traceStreamUrl(
  sessionId: string,
  params: Record<string, string> = {},
): Promise<string> {
  const response = await fetch(`${BROKER}/api/ws-auth-tickets`, {
    method: 'POST',
    headers: { ...traceAuthHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'codex', sessionId, params }),
  });
  const body = await response.json().catch(() => ({})) as any;
  if (response.status !== 201 || typeof body.wsAuthTicket !== 'string') {
    throw new Error(`WebSocket ticket issuance failed (${response.status})`);
  }
  return `${WSBASE}/api/sessions/codex/${encodeURIComponent(sessionId)}`
    + `/stream?wsAuthTicket=${encodeURIComponent(body.wsAuthTicket)}`;
}

interface Assertion {
  name: string;
  ok: boolean;
  detail?: string;
}

const assertions: Assertion[] = [];
mkdirSync(outDir, { recursive: true });

function record(path: string, obj: unknown): void {
  appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...(obj as Record<string, unknown>) }) + '\n');
}

function check(name: string, ok: boolean, detail = ''): void {
  assertions.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`);
}

const tempRoot = mkdtempSync(join(tmpdir(), 'cosyncing-codex-trace-'));
const codexHome = join(tempRoot, 'codex-home');
const workDir = join(tempRoot, 'workspace');
const sockPath = join(tempRoot, 'daemon.sock');
const procRoot = join(tempRoot, 'proc');
mkdirSync(codexHome, { recursive: true });
mkdirSync(workDir, { recursive: true });
writeRollout(THREAD_ID, false);
writeRollout(HIDDEN_ID, true);
// The non-loaded thread carries Codex's real auto-review pair so cold restore must preserve both
// approvalPolicy and approvalsReviewer instead of silently demoting the session to user approval.
writeRollout(NOT_LOADED_ID, false, 'on-request', 'auto_review');
// terminalSync.active is presence-based (daemon-loaded alone is a one-way latch): give the fake
// daemon a matching fake TUI process so the visible thread carries the full synced claim.
mkdirSync(join(procRoot, '4242'), { recursive: true });
writeFileSync(join(procRoot, '4242', 'cmdline'), ['codex', 'resume', '--remote', `unix://${sockPath}`, THREAD_ID].join('\0') + '\0');

async function main(): Promise<void> {
  const daemon = new FakeCodexDaemon(sockPath, [THREAD_ID, HIDDEN_ID]);
  let broker: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;

  try {
    await daemon.start();
    broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: '127.0.0.1',
        CODEX_HOME: codexHome,
        COSYNCING_CODEX_SYNC_SERVER: '1',
        COSYNCING_CODEX_SYNC_WATCH_MS: '250',
        COSYNCING_CODEX_SYNC_DROP_GRACE_POLLS: '3',
        COSYNCING_CODEX_APP_SERVER_SOCK: sockPath,
        COSYNCING_CODEX_REMOTE_ADDR: `unix://${sockPath}`,
        COSYNCING_CODEX_PROC_ROOT: procRoot,
        COSYNCING_TOKEN: TRACE_TOKEN,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    drainBrokerOutput(broker);
    if (!(await waitHealth())) throw new Error(`broker did not start at ${BROKER}`);

    const sessionsResp = await fetch(`${BROKER}/api/sessions`, { headers: traceAuthHeaders });
    const sessionsBody = await sessionsResp.json();
    const sessions = Array.isArray(sessionsBody) ? sessionsBody : sessionsBody.sessions ?? [];
    const visible = sessions.find((s: any) => s.tool === 'codex' && s.nativeId === THREAD_ID);
    const hidden = sessions.find((s: any) => s.tool === 'codex' && s.nativeId === HIDDEN_ID);
    const notLoaded = sessions.find((s: any) => s.tool === 'codex' && s.nativeId === NOT_LOADED_ID);
    check('visible daemon-loaded Codex row is discovered', !!visible, JSON.stringify(sessions.filter((s: any) => s.tool === 'codex').map((s: any) => s.title)));
    check('guardian row is tagged for the client hidden-origin filter', hidden?.origin === 'subagent' && hidden?.parentThreadId === THREAD_ID, JSON.stringify(hidden ?? null));
    check('visible row advertises true terminal sync', visible?.attachMode === 'live' && visible?.control?.terminalSync?.active === true, JSON.stringify(visible?.control));
    check('visible row disables Drive while true-sync is active', visible?.control?.drive?.supported === false && visible?.control?.drive?.state === 'unavailable', JSON.stringify(visible?.control?.drive));
    check('non-loaded Codex row does not claim active terminal sync', notLoaded?.attachMode === 'observe' && notLoaded?.control?.terminalSync?.supported === true && notLoaded?.control?.terminalSync?.active === false, JSON.stringify(notLoaded?.control));
    const craftedResumeError = visible?.id ? await attachError(visible.id, 'resume') : undefined;
    check('crafted resume attach is rejected for daemon-loaded Codex thread', /true terminal sync|Drive is unavailable/.test(craftedResumeError ?? ''), craftedResumeError ?? '');
    const craftedLiveError = notLoaded?.id ? await attachError(notLoaded.id, 'live') : undefined;
    check('crafted live attach is rejected for non-loaded Codex thread', /not loaded in the managed app-server daemon/.test(craftedLiveError ?? ''), craftedLiveError ?? '');

    const frames: any[] = [];
    const ws = new WebSocket(await traceStreamUrl(visible.id));
    ws.onmessage = (e) => {
      try {
        const frame = JSON.parse(String(e.data));
        frames.push(frame);
        record(framesPath, frame);
      } catch {
        /* skip malformed */
      }
    };
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('browser WebSocket failed'));
    });

    const sessionFrame = await waitFrame(frames, (f) => f.kind === 'session', 5000);
    const historyFrame = await waitFrame(frames, (f) => f.kind === 'history', 5000);
    check('attach session frame is live true-sync', sessionFrame?.info?.attachMode === 'live' && sessionFrame.info.control?.terminalSync?.active === true, JSON.stringify(sessionFrame?.info?.control));
    const autoReviewFrame = await waitFrame(frames, (f) => f.kind === 'session' && f.info?.currentMode === 'approve-for-me', 5000);
    check('native auto_review settings surface as approve-for-me', !!autoReviewFrame, JSON.stringify([...frames].reverse().find((f) => f.kind === 'session')?.info?.currentMode ?? null));
    check('attach history frame replays rollout history', Array.isArray(historyFrame?.messages) && historyFrame.messages.length > 0, `${historyFrame?.messages?.length ?? 0} messages`);

    const markApp = frames.length;
    ws.send(JSON.stringify({ kind: 'prompt', text: 'APP_TRACE_PROMPT' }));
    const appTurn = await daemon.waitFor((e) => e.direction === 'client->daemon' && e.method === 'turn/start' && /APP_TRACE_PROMPT/.test(JSON.stringify(e.params)), 5000);
    check('app prompt reaches shared Codex daemon as turn/start', !!appTurn, JSON.stringify(appTurn?.params?.input));
    const appEcho = await waitFrame(frames, (f) => frames.indexOf(f) >= markApp && f.kind === 'message' && f.message?.type === 'user-message' && /APP_TRACE_PROMPT/.test(f.message.text ?? ''), 5000);
    check('app prompt echo streams back through live daemon', !!appEcho, appEcho?.message?.key);
    // issues-part3: an ordinary prompt must NOT re-assert an approval policy (that used to clobber a
    // synced terminal's approve-for-me back to "ask" on every send) — only an explicit pick rides.
    check(
      'prompt without an explicit pick omits all permission overrides from turn/start',
      !!appTurn && appTurn.params?.approvalPolicy === undefined && appTurn.params?.approvalsReviewer === undefined && appTurn.params?.sandboxPolicy === undefined,
      JSON.stringify({ approvalPolicy: appTurn?.params?.approvalPolicy ?? null, approvalsReviewer: appTurn?.params?.approvalsReviewer ?? null, sandboxPolicy: appTurn?.params?.sandboxPolicy ?? null }),
    );
    ws.send(JSON.stringify({ kind: 'prompt', text: 'APP_MODE_PROMPT', permissionMode: 'approve-for-me' }));
    const modeTurn = await daemon.waitFor((e) => e.direction === 'client->daemon' && e.method === 'turn/start' && /APP_MODE_PROMPT/.test(JSON.stringify(e.params)), 5000);
    check(
      'approve-for-me rides turn/start as on-request plus Codex auto-review',
      modeTurn?.params?.approvalPolicy === 'on-request' && modeTurn?.params?.approvalsReviewer === 'auto_review' && modeTurn?.params?.sandboxPolicy?.type === 'workspaceWrite',
      JSON.stringify({ approvalPolicy: modeTurn?.params?.approvalPolicy ?? null, approvalsReviewer: modeTurn?.params?.approvalsReviewer ?? null, sandboxPolicy: modeTurn?.params?.sandboxPolicy ?? null }),
    );

    const markTerminal = frames.length;
    daemon.emitTerminalTurn('TERMINAL_TRACE_PROMPT', 'TERMINAL_TRACE_OK');
    const terminalUser = await waitFrame(frames, (f) => frames.indexOf(f) >= markTerminal && f.kind === 'message' && f.message?.type === 'user-message' && /TERMINAL_TRACE_PROMPT/.test(f.message.text ?? ''), 5000);
    const terminalOutput = await waitFrame(frames, (f) => frames.indexOf(f) >= markTerminal && f.kind === 'message' && f.message?.type === 'model-output' && /TERMINAL_TRACE_OK/.test((f.message.text ?? '') + (f.message.delta ?? '')), 5000);
    check('terminal-originated prompt reaches app as user-message', !!terminalUser, terminalUser?.message?.key);
    check('terminal-originated assistant stream reaches app', !!terminalOutput, terminalOutput?.message?.key);
    const terminalEchoCount = frames.filter((f) => f.kind === 'message' && f.message?.type === 'user-message' && /TERMINAL_TRACE_PROMPT/.test(f.message.text ?? '')).length;
    check('terminal-originated prompt is not duplicated', terminalEchoCount === 1, `${terminalEchoCount} matching user messages`);

    const markApproval = frames.length;
    daemon.requestApproval('approval-trace-1');
    const permission = await waitFrame(frames, (f) => frames.indexOf(f) >= markApproval && f.kind === 'message' && f.message?.type === 'permission-request', 5000);
    check('daemon approval request reaches app', !!permission, permission?.message?.detail ?? '');
    ws.send(JSON.stringify({ kind: 'approve', requestId: permission?.message?.requestId, decision: 'approve' }));
    const approvalResponse = await daemon.waitFor((e) => e.direction === 'client->daemon' && e.responseId === 'approval-trace-1', 5000);
    check('app approval returns through daemon RPC response channel', approvalResponse?.result?.decision === 'accept', JSON.stringify(approvalResponse?.result));
    const resolved = await waitFrame(frames, (f) => frames.indexOf(f) >= markApproval && f.kind === 'message' && f.message?.type === 'permission-resolved' && f.message.requestId === permission?.message?.requestId, 5000);
    check('app emits approval resolution frame', !!resolved, resolved?.message?.decision);

    // ── issues-part3 #36: an approval answered in ANOTHER daemon client (synced terminal) must
    // clear the app card via serverRequest/resolved instead of sticking forever. ──
    const markExternal = frames.length;
    daemon.requestApproval('approval-trace-2');
    const externalPerm = await waitFrame(frames, (f) => frames.indexOf(f) >= markExternal && f.kind === 'message' && f.message?.type === 'permission-request', 5000);
    check('second daemon approval request reaches app', !!externalPerm, externalPerm?.message?.requestId ?? '');
    daemon.broadcastToThread(THREAD_ID, { method: 'serverRequest/resolved', params: { threadId: THREAD_ID, requestId: 'approval-trace-2' } });
    const externalResolved = await waitFrame(frames, (f) => frames.indexOf(f) >= markExternal && f.kind === 'message' && f.message?.type === 'permission-resolved' && f.message.requestId === externalPerm?.message?.requestId, 5000);
    check('terminal-answered approval auto-resolves the app card as external', externalResolved?.message?.decision === 'external', JSON.stringify(externalResolved?.message ?? null));
    const externalAnswer = await daemon.waitFor((e) => e.direction === 'client->daemon' && e.responseId === 'approval-trace-2', 400);
    check('externally resolved approval sends no rival RPC response from the app conn', !externalAnswer, JSON.stringify(externalAnswer ?? null));

    // ── issues-part3 #36: a card orphaned by turn end must settle and must NOT replay to a
    // late-joining client (maintainer: "it even appears for previously approved permissions"). ──
    const markOrphan = frames.length;
    daemon.requestApproval('approval-trace-3');
    const orphanPerm = await waitFrame(frames, (f) => frames.indexOf(f) >= markOrphan && f.kind === 'message' && f.message?.type === 'permission-request', 5000);
    check('third daemon approval request reaches app', !!orphanPerm, orphanPerm?.message?.requestId ?? '');
    daemon.broadcastToThread(THREAD_ID, { method: 'turn/completed', params: { threadId: THREAD_ID, turn: { id: 'turn-approval', status: 'completed' } } });
    const orphanResolved = await waitFrame(frames, (f) => frames.indexOf(f) >= markOrphan && f.kind === 'message' && f.message?.type === 'permission-resolved' && f.message.requestId === orphanPerm?.message?.requestId, 5000);
    check('turn end settles an unanswered approval card as external', orphanResolved?.message?.decision === 'external', JSON.stringify(orphanResolved?.message ?? null));
    const replayFrames: any[] = [];
    const replayWs = new WebSocket(await traceStreamUrl(visible.id));
    replayWs.onmessage = (e) => {
      try {
        const frame = JSON.parse(String(e.data));
        replayFrames.push(frame);
        record(framesPath, { phase: 'replay', frame });
      } catch {
        /* skip malformed */
      }
    };
    await new Promise<void>((resolve, reject) => {
      replayWs.onopen = () => resolve();
      replayWs.onerror = () => reject(new Error('replay WebSocket failed'));
    });
    await waitFrame(replayFrames, (f) => f.kind === 'history', 5000);
    await sleep(500);
    const replayedCards = replayFrames.filter((f) => f.kind === 'message' && f.message?.type === 'permission-request');
    check('late-joining client receives no settled approval cards as pending', replayedCards.length === 0, `${replayedCards.length} replayed cards`);
    replayWs.close();

    // ── issues-part3 #37: a settings change from another client (terminal) mirrors into the app. ──
    const markSettings = frames.length;
    daemon.broadcastToThread(THREAD_ID, {
      method: 'thread/settings/updated',
      params: {
        threadId: THREAD_ID,
        threadSettings: { cwd: workDir, approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' }, model: 'gpt-5.5', modelProvider: 'openai' },
      },
    });
    const modeFrame = await waitFrame(frames, (f) => frames.indexOf(f) >= markSettings && f.kind === 'session' && f.info?.currentMode === 'full-access', 5000);
    check('terminal-side settings change mirrors currentMode into the app session frame', !!modeFrame, JSON.stringify(modeFrame?.info?.currentMode ?? null));

    // ── issues-part3 #37: cold-loading a thread must restore the rollout's approval policy instead
    // of silently resetting to the daemon config default ("always back to ask permission"). ──
    const coldFrames: any[] = [];
    const coldWs = new WebSocket(await traceStreamUrl(notLoaded.id, { mode: 'resume' }));
    coldWs.onmessage = (e) => {
      try {
        const frame = JSON.parse(String(e.data));
        coldFrames.push(frame);
        record(framesPath, { phase: 'cold-load', frame });
      } catch {
        /* skip malformed */
      }
    };
    await new Promise<void>((resolve, reject) => {
      coldWs.onopen = () => resolve();
      coldWs.onerror = () => reject(new Error('cold-load WebSocket failed'));
    });
    // Drive is the rival stdio owner by design: the restore runs against a REAL `codex app-server
    // --stdio` child (its cold thread/resume returns the config default), NOT the fake daemon.
    // attach() seeds currentMode from the rollout surface, so the discriminating assert is that no
    // post-start frame REGRESSES to the daemon default — start() overwrites currentMode with the
    // (restored) thread settings, so a failed restore would surface ask-permission here.
    const coldSession = await waitFrame(coldFrames, (f) => f.kind === 'session' && f.info?.currentMode === 'approve-for-me', 15000);
    check('cold-loaded session surfaces the rollout mode, not the daemon default', !!coldSession, JSON.stringify(coldSession?.info?.currentMode ?? null));
    await sleep(1200);
    const coldRegressed = coldFrames.find((f) => f.kind === 'session' && f.info?.currentMode === 'ask-permission');
    check('cold-load start() does not regress the mode to the daemon default (restore held)', !coldRegressed, JSON.stringify(coldRegressed?.info?.currentMode ?? null));
    // Model restore mirrors the mode restore (2026-07-13 re-flag): the cold-load frame must carry
    // the rollout's recorded model — not the stdio server's config default — and the sync-dialog
    // hint must pin that model so a terminal join cannot drift (`-m gpt-5.6-sol` on a spark session).
    const coldModelFrame = coldFrames.find((f) => f.kind === 'session' && f.info?.currentModel?.modelID === 'gpt-5.3-codex-spark');
    check('cold-loaded session surfaces the rollout model, not the config default', !!coldModelFrame, JSON.stringify([...coldFrames].reverse().find((f) => f.kind === 'session')?.info?.currentModel ?? null));
    const coldHintFrame = coldFrames.find((f) => f.kind === 'session' && String(f.info?.control?.terminalSync?.command ?? '').includes('-m gpt-5.3-codex-spark'));
    check('cold-load sync hint pins the restored model (-m spark)', !!coldHintFrame, String([...coldFrames].reverse().find((f) => f.kind === 'session')?.info?.control?.terminalSync?.command ?? 'none'));
    const coldDaemonRestore = daemon.events.find((e) => e.direction === 'client->daemon' && e.method === 'thread/settings/update' && String(e.params?.threadId ?? '') === NOT_LOADED_ID);
    check('drive attach keeps its own stdio owner (no settings/update leaks to the shared daemon)', !coldDaemonRestore, JSON.stringify(coldDaemonRestore?.params ?? null));
    const visibleRestore = daemon.events.find((e) => e.direction === 'client->daemon' && e.method === 'thread/settings/update' && String(e.params?.threadId ?? '') === THREAD_ID);
    check('rejoining the already-loaded thread never overwrites live settings from the rollout', !visibleRestore, JSON.stringify(visibleRestore?.params ?? null));
    coldWs.close();
    await sleep(200);

    daemon.emitActiveTurn('terminal-close-turn');
    await sleep(100);
    ws.close();
    await sleep(16_000);
    const interrupts = daemon.events.filter((e) => e.direction === 'client->daemon' && e.method === 'turn/interrupt');
    check('closing app during daemon-live turn does not interrupt terminal turn', interrupts.length === 0, `${interrupts.length} interrupts`);

    const degradeFrames: any[] = [];
    const degradeWs = new WebSocket(await traceStreamUrl(visible.id));
    degradeWs.onmessage = (e) => {
      try {
        const frame = JSON.parse(String(e.data));
        degradeFrames.push(frame);
        record(framesPath, { phase: 'degrade', frame });
      } catch {
        /* skip malformed */
      }
    };
    await new Promise<void>((resolve, reject) => {
      degradeWs.onopen = () => resolve();
      degradeWs.onerror = () => reject(new Error('degrade WebSocket failed'));
    });
    const degradeInitial = await waitFrame(degradeFrames, (f) => f.kind === 'session' && f.info?.control?.terminalSync?.active === true, 5000);
    check('degrade probe starts from live true-sync', !!degradeInitial, JSON.stringify(degradeInitial?.info?.control));
    const markFlap = degradeFrames.length;
    daemon.setLoadedThreadIds([]);
    await sleep(320);
    daemon.setLoadedThreadIds([THREAD_ID, HIDDEN_ID]);
    await sleep(500);
    const flapDowngrade = degradeFrames
      .slice(markFlap)
      .find((f) => f.kind === 'session' && f.info?.attachMode === 'observe' && f.info?.control?.terminalSync?.active === false);
    check('one transient Codex loaded-list miss does not downgrade active sync', !flapDowngrade, JSON.stringify(flapDowngrade?.info?.control));
    const markDegrade = degradeFrames.length;
    daemon.setLoadedThreadIds([]);
    const downgraded = await waitFrame(
      degradeFrames,
      (f) =>
        degradeFrames.indexOf(f) >= markDegrade &&
        f.kind === 'session' &&
        f.info?.attachMode === 'observe' &&
        f.info?.control?.terminalSync?.supported === true &&
        f.info?.control?.terminalSync?.active === false,
      8000,
    );
    check('daemon owner disappearance downgrades open Codex socket to observe', !!downgraded, JSON.stringify(downgraded?.info?.control));
    check('downgrade does not send a misleading ended frame', !degradeFrames.slice(markDegrade).some((f) => f.kind === 'ended'));
    degradeWs.send(JSON.stringify({ kind: 'prompt', text: 'SHOULD_NOT_REACH_DAEMON_AFTER_DEGRADE' }));
    const readOnlyError = await waitFrame(
      degradeFrames,
      (f) => degradeFrames.indexOf(f) >= markDegrade && f.kind === 'error' && /read-only observe session/.test(String(f.message ?? '')),
      3000,
    );
    const leakedPrompt = await daemon.waitFor((e) => e.direction === 'client->daemon' && e.method === 'turn/start' && /SHOULD_NOT_REACH/.test(JSON.stringify(e.params)), 500);
    check('downgraded Codex socket rejects app prompt at broker boundary', !!readOnlyError && !leakedPrompt, `error=${readOnlyError?.message ?? ''} leaked=${!!leakedPrompt}`);
    degradeWs.close();
  } catch (err) {
    check('trace driver completed without exception', false, String(err));
  } finally {
    broker?.kill();
    await daemon.stop();
    const failed = assertions.filter((a) => !a.ok).length;
    writeFileSync(tracePath, JSON.stringify({
      scenarioIds,
      agent: 'codex',
      version: { cosyncing: 'local-source', codexDaemon: 'simulated-websocket-unix-socket' },
      broker: BROKER,
      codexHome,
      daemonSocket: sockPath,
      steps,
      output: { frames: framesPath, daemon: daemonPath },
      assertions,
      status: failed ? 'fail' : 'pass',
      skipReason: null,
    }, null, 2));
    rmSync(tempRoot, { recursive: true, force: true });
    console.log(`\ntrace: ${tracePath}`);
    console.log(`${assertions.length - failed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
}

function writeRollout(threadId: string, hidden: boolean, approvalPolicy?: string, approvalsReviewer?: string): void {
  const dir = join(codexHome, 'sessions', '2026', '06', '16');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-06-16T00-00-00-${threadId}.jsonl`);
  const meta: any = {
    id: threadId,
    timestamp: '2026-06-16T00:00:00.000Z',
    cwd: workDir,
    originator: 'codex-tui',
    cli_version: 'trace',
  };
  if (hidden) {
    meta.parent_thread_id = THREAD_ID;
    meta.thread_source = 'subagent';
    meta.source = { subagent: { other: 'guardian' } };
  }
  const lines: any[] = [
    { timestamp: '2026-06-16T00:00:00.000Z', type: 'session_meta', payload: meta },
    { timestamp: '2026-06-16T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: hidden ? 'hidden' : 'visible history prompt' } },
    { timestamp: '2026-06-16T00:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: hidden ? 'hidden output' : 'visible history output' } },
  ];
  if (approvalPolicy) {
    lines.push({
      timestamp: '2026-06-16T00:00:03.000Z',
      type: 'turn_context',
      // model/effort mirror the approval-policy case: a cold resume returns the config default for
      // BOTH, so the restore path must recover the recorded model too (2026-07-13: maintainer's spark
      // session reopened advertising/running gpt-5.6-sol).
      payload: {
        turn_id: 'turn-ctx-1',
        cwd: workDir,
        approval_policy: approvalPolicy,
        ...(approvalsReviewer ? { approvals_reviewer: approvalsReviewer } : {}),
        sandbox_policy: { type: 'workspace-write', network_access: false },
        model: 'gpt-5.3-codex-spark',
        effort: 'low',
      },
    });
  }
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
}

function drainBrokerOutput(proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>): void {
  void (async () => {
    for (const stream of [proc.stdout, proc.stderr]) {
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
        /* process ended */
      }
    }
  })();
}

async function waitHealth(): Promise<boolean> {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${BROKER}/api/health`)).ok) return true;
    } catch {
      /* broker not ready */
    }
    await sleep(100);
  }
  return false;
}

async function attachError(sessionId: string, mode: string): Promise<string | undefined> {
  const frames: any[] = [];
  const ws = new WebSocket(await traceStreamUrl(sessionId, { mode }));
  ws.onmessage = (e) => {
    try {
      const frame = JSON.parse(String(e.data));
      frames.push(frame);
      record(framesPath, { mode, frame });
    } catch {
      /* skip malformed */
    }
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('browser WebSocket failed'));
  });
  const err = await waitFrame(frames, (f) => f.kind === 'error', 5000);
  try {
    ws.close();
  } catch {
    /* already closed */
  }
  return err?.message;
}

async function waitFrame(frames: any[], pred: (f: any) => boolean, ms: number): Promise<any> {
  const end = Date.now() + ms;
  for (;;) {
    const frame = frames.find(pred);
    if (frame) return frame;
    if (Date.now() > end) return undefined;
    await sleep(60);
  }
}

type DaemonEvent = {
  direction: string;
  method?: string;
  id?: string | number;
  responseId?: string | number;
  params?: any;
  result?: any;
};

class FakeCodexDaemon {
  private server: Server | undefined;
  private clients = new Set<DaemonClient>();
  readonly events: DaemonEvent[] = [];
  private loadedThreadIds: string[];

  constructor(
    private readonly socketPath: string,
    loadedThreadIds: string[],
  ) {
    this.loadedThreadIds = [...loadedThreadIds];
  }

  setLoadedThreadIds(ids: string[]): void {
    this.loadedThreadIds = [...ids];
    record(daemonPath, { direction: 'trace->daemon', action: 'set-loaded-thread-ids', ids });
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        const client = new DaemonClient(socket, (msg) => this.handle(client, msg), () => this.clients.delete(client));
        this.clients.add(client);
      });
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => resolve());
    });
  }

  stop(): Promise<void> {
    for (const c of this.clients) c.close();
    return new Promise((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  private handle(client: DaemonClient, msg: any): void {
    if (msg?.method) {
      const event = { direction: 'client->daemon', id: msg.id, method: String(msg.method), params: msg.params };
      this.events.push(event);
      record(daemonPath, event);
      switch (msg.method) {
        case 'initialize':
          client.send({ id: msg.id, result: { userAgent: 'codex-trace/0.0.0', codexHome, platformFamily: 'unix', platformOs: 'linux' } });
          client.send({ method: 'remoteControl/status/changed', params: { status: 'connected', serverName: 'trace', environmentId: 'env_trace' } });
          return;
        case 'thread/loaded/list':
          client.send({ id: msg.id, result: { data: this.loadedThreadIds, nextCursor: null } });
          return;
        case 'thread/resume':
          client.threadId = String(msg.params?.threadId ?? '');
          client.send({
            id: msg.id,
            result: {
              thread: { id: client.threadId, name: 'codex true sync trace' },
              model: 'gpt-5.5',
              modelProvider: 'openai',
              approvalPolicy: 'on-request',
              approvalsReviewer: 'auto_review',
              sandbox: { type: 'workspaceWrite', writableRoots: [workDir], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
            },
          });
          client.send({ method: 'thread/status/changed', params: { threadId: client.threadId, status: { type: 'idle' } } });
          return;
        case 'turn/start':
          this.handleTurnStart(client, msg);
          return;
        case 'thread/settings/update': {
          // Mirror 0.144.1: acknowledge, then notify the thread's clients with the merged settings.
          client.send({ id: msg.id, result: {} });
          const threadId = String(msg.params?.threadId ?? '');
          this.broadcastToThread(threadId, {
            method: 'thread/settings/updated',
            params: {
              threadId,
              threadSettings: {
                cwd: workDir,
                approvalPolicy: msg.params?.approvalPolicy,
                sandboxPolicy: msg.params?.sandboxPolicy,
                approvalsReviewer: msg.params?.approvalsReviewer,
                model: 'gpt-5.5',
                modelProvider: 'openai',
              },
            },
          });
          return;
        }
        case 'turn/steer':
        case 'turn/interrupt':
        case 'thread/compact/start':
        case 'model/list':
        case 'config/read':
        case 'skills/list':
          client.send({ id: msg.id, result: msg.method === 'config/read' ? { config: { model_provider: 'openai' } } : msg.method === 'model/list' ? { data: [] } : msg.method === 'skills/list' ? { data: [] } : {} });
          return;
        default:
          client.send({ id: msg.id, result: {} });
          return;
      }
    }
    if (msg?.id != null && ('result' in msg || 'error' in msg)) {
      const event = { direction: 'client->daemon', responseId: msg.id, result: msg.result, error: msg.error };
      this.events.push(event);
      record(daemonPath, event);
    }
  }

  private handleTurnStart(client: DaemonClient, msg: any): void {
    const turnId = `turn-app-${Date.now()}`;
    const itemId = `item-app-${Date.now()}`;
    const input = msg.params?.input ?? [];
    client.send({ id: msg.id, result: { turn: { id: turnId } } });
    client.send({ method: 'turn/started', params: { threadId: THREAD_ID, turn: { id: turnId } } });
    client.send({ method: 'item/started', params: { threadId: THREAD_ID, turnId, item: { type: 'userMessage', id: `user-${itemId}`, clientId: msg.params?.clientUserMessageId, content: input } } });
    client.send({ method: 'item/agentMessage/delta', params: { threadId: THREAD_ID, turnId, itemId, delta: 'APP_TRACE_OK' } });
    client.send({ method: 'item/completed', params: { threadId: THREAD_ID, turnId, item: { type: 'agentMessage', id: itemId, text: 'APP_TRACE_OK' } } });
    client.send({ method: 'turn/completed', params: { threadId: THREAD_ID, turn: { id: turnId, status: 'completed' } } });
  }

  emitTerminalTurn(userText: string, outputText: string): void {
    const turnId = `turn-terminal-${Date.now()}`;
    const itemId = `item-terminal-${Date.now()}`;
    for (const client of this.visibleThreadClients()) {
      client.send({ method: 'turn/started', params: { threadId: THREAD_ID, turn: { id: turnId } } });
      client.send({ method: 'item/started', params: { threadId: THREAD_ID, turnId, item: { type: 'userMessage', id: `user-${itemId}`, content: [{ type: 'text', text: userText, text_elements: [] }] } } });
      client.send({ method: 'item/agentMessage/delta', params: { threadId: THREAD_ID, turnId, itemId, delta: outputText } });
      client.send({ method: 'item/completed', params: { threadId: THREAD_ID, turnId, item: { type: 'agentMessage', id: itemId, text: outputText } } });
      client.send({ method: 'turn/completed', params: { threadId: THREAD_ID, turn: { id: turnId, status: 'completed' } } });
    }
  }

  emitActiveTurn(turnId: string): void {
    for (const client of this.visibleThreadClients()) {
      client.send({ method: 'turn/started', params: { threadId: THREAD_ID, turn: { id: turnId } } });
      client.send({ method: 'thread/status/changed', params: { threadId: THREAD_ID, status: { type: 'active', activeFlags: [] } } });
    }
  }

  requestApproval(id: string): void {
    for (const client of this.visibleThreadClients()) {
      client.send({
        id,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: THREAD_ID,
          turnId: 'turn-approval',
          itemId: 'cmd-approval',
          command: 'echo CODEX_PERMISSION_TRACE',
          cwd: workDir,
          reason: 'trace approval',
          availableDecisions: ['accept', 'decline', 'acceptForSession'],
        },
      });
    }
  }

  async waitFor(pred: (e: DaemonEvent) => boolean, ms: number): Promise<DaemonEvent | undefined> {
    const end = Date.now() + ms;
    for (;;) {
      const event = this.events.find(pred);
      if (event) return event;
      if (Date.now() > end) return undefined;
      await sleep(50);
    }
  }

  broadcastToThread(threadId: string, msg: unknown): void {
    for (const client of this.clients) {
      if (client.threadId === threadId) client.send(msg);
    }
  }

  private visibleThreadClients(): DaemonClient[] {
    return [...this.clients].filter((c) => c.threadId === THREAD_ID);
  }
}

class DaemonClient {
  private buffer = Buffer.alloc(0);
  private handshake = Buffer.alloc(0);
  private ready = false;
  threadId = '';

  constructor(
    private readonly socket: Socket,
    private readonly onMessage: (msg: any) => void,
    private readonly onClose: () => void,
  ) {
    socket.on('data', (chunk) => this.consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.on('close', onClose);
    socket.on('error', onClose);
  }

  send(obj: unknown): void {
    if (this.socket.destroyed) return;
    this.socket.write(webSocketFrame(Buffer.from(JSON.stringify(obj), 'utf8'), 0x1, false));
    record(daemonPath, { direction: 'daemon->client', message: obj });
  }

  close(): void {
    this.socket.destroy();
  }

  private consume(chunk: Buffer): void {
    if (!this.ready) {
      this.handshake = Buffer.concat([this.handshake, chunk]);
      const idx = this.handshake.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const header = this.handshake.subarray(0, idx).toString('utf8');
      const key = /^Sec-WebSocket-Key:\s*(.+)$/im.exec(header)?.[1]?.trim();
      if (!key) {
        this.socket.destroy();
        return;
      }
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      this.socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'));
      this.ready = true;
      const rest = this.handshake.subarray(idx + 4);
      if (rest.length) this.consume(rest);
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = readWebSocketFrame(this.buffer);
      if (!frame) return;
      this.buffer = this.buffer.subarray(frame.bytes);
      if (frame.opcode === 0x1) {
        try {
          this.onMessage(JSON.parse(frame.payload.toString('utf8')));
        } catch {
          /* skip malformed */
        }
      } else if (frame.opcode === 0x8) {
        this.socket.destroy();
        return;
      } else if (frame.opcode === 0x9) {
        this.socket.write(webSocketFrame(frame.payload, 0xA, false));
      }
    }
  }
}

function webSocketFrame(payload: Buffer, opcode: number, masked: boolean): Buffer {
  const second = (masked ? 0x80 : 0) | (payload.length < 126 ? payload.length : payload.length <= 0xffff ? 126 : 127);
  const header =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, second])
      : payload.length <= 0xffff
        ? Buffer.concat([Buffer.from([0x80 | opcode, second]), u16(payload.length)])
        : Buffer.concat([Buffer.from([0x80 | opcode, second]), u64(payload.length)]);
  if (!masked) return Buffer.concat([header, payload]);
  const mask = randomBytes(4);
  const out = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i]! ^ mask[i % 4]!;
  return Buffer.concat([header, mask, out]);
}

function readWebSocketFrame(buf: Buffer): { opcode: number; payload: Buffer; bytes: number } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0]! & 0x0f;
  const masked = Boolean(buf[1]! & 0x80);
  let len = buf[1]! & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < off + 2) return null;
    len = buf.readUInt16BE(off);
    off += 2;
  } else if (len === 127) {
    if (buf.length < off + 8) return null;
    len = Number(buf.readBigUInt64BE(off));
    off += 8;
  }
  const mask = masked ? buf.subarray(off, off + 4) : undefined;
  if (masked) off += 4;
  if (buf.length < off + len) return null;
  let payload = buf.subarray(off, off + len);
  if (mask) {
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = payload[i]! ^ mask[i % 4]!;
    payload = out;
  }
  return { opcode, payload, bytes: off + len };
}

function u16(n: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(n);
  return buf;
}

function u64(n: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(n));
  return buf;
}

await main();
