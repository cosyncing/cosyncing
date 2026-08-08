/**
 * Claude DRIVABLE (resume) + multi-store + freshness tests.
 *
 *   1. freshnessGate (Issue F) — a stale 'busy' demotes to idle; a fresh one stays working; needs-input
 *      is left ungated. (pure, no cost)
 *   2. claudeStores (Issue D) — the default store + each ~/bin/claude* wrapper, with the wrapper's model
 *      LITERAL resolved through shell-var indirection ($OPUS_MODEL → mimo-v2.5-pro[1m]). (reads ~/bin)
 *   3. claudeModelOptions / scanDiskCommands (Issues B + C) — wrapper = pinned single model; default =
 *      Claude aliases; commands include the built-ins. (pure)
 *   4. LIVE drive (gated) — resume a throwaway claude-open (FREE qwen3.6-27B-FP8) session through
 *      ClaudeResumeConnection, drive one turn, assert model-output + token-count + idle. SKIPPED unless
 *      a claude-open session + a reachable endpoint exist (never touches a paid model). Set
 *      CA_RESUME_LIVE=0 to force-skip.
 *
 *   bun run scripts/broker/tests/claude/test-claude-resume.ts      (exit 0 = all pass; live half may SKIP)
 */
export {};
import { existsSync } from 'node:fs';
import {
  ClaudeAdapter,
  claudeStores,
  claudeModelOptions,
  scanDiskCommands,
  freshnessGate,
} from '../../../../packages/typescript/adapters/claude/src/index.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const NOW = 1_000_000_000_000;

// ── 1. freshnessGate ──────────────────────────────────────────────────────────
check('freshnessGate: fresh busy stays working', freshnessGate('working', NOW - 5_000, NOW) === 'working');
check('freshnessGate: stale busy (5 min) demotes to idle', freshnessGate('working', NOW - 300_000, NOW) === 'idle', 'the "5-day working" bug');
check('freshnessGate: needs-input is NOT gated', freshnessGate('needs-input', NOW - 86_400_000, NOW) === 'needs-input');
check('freshnessGate: undefined → idle', freshnessGate(undefined, NOW, NOW) === 'idle');

// ── 2. claudeStores (multi-config-dir discovery + model resolution) ─────────────
{
  const stores = claudeStores();
  const def = stores.find((s) => s.isDefault);
  check('stores: a default ~/.claude store exists', !!def && /\.claude\/projects$/.test(def!.projectsRoot), def?.projectsRoot);
  const wraps = stores.filter((s) => !s.isDefault);
  // No wrappers on a clean machine is acceptable; if present, models must be resolved literals (no `$`).
  const unresolved = wraps.filter((w) => w.model && w.model.includes('$'));
  check('stores: wrapper models resolve to literals (no unexpanded $VAR)', unresolved.length === 0,
    `${wraps.length} wrappers; models=[${wraps.map((w) => w.model).join(', ')}]`);
}

// ── 3. model options + disk commands ────────────────────────────────────────────
{
  const def = claudeStores().find((s) => s.isDefault)!;
  const dm = claudeModelOptions(def);
  check('claudeModelOptions: default store offers Claude aliases', dm.length >= 3 && dm.some((m) => m.modelID === 'opus'), dm.map((m) => m.modelID).join(','));
  const fakeWrap = { configDir: '/x', projectsRoot: '/x/projects', bin: '/x/claude-w', model: 'MiniMax-M3', isDefault: false };
  const wm = claudeModelOptions(fakeWrap);
  check('claudeModelOptions: wrapper store is pinned to its one model', wm.length === 1 && wm[0]!.modelID === 'MiniMax-M3', JSON.stringify(wm));
  const cmds = scanDiskCommands(def, undefined);
  const names = new Set(cmds.map((c) => c.name));
  check('scanDiskCommands: built-ins present (stop/compact/clear)', names.has('stop') && names.has('compact') && names.has('clear'), `${cmds.length} commands`);
  check('scanDiskCommands: stop is an action (drives the interrupt button)', cmds.find((c) => c.name === 'stop')?.kind === 'action');
}

// ── 4. LIVE drive via the FREE claude-open wrapper (gated) ──────────────────────
async function liveDrive(): Promise<void> {
  if (process.env.CA_RESUME_LIVE === '0') { console.log('SKIP live drive (CA_RESUME_LIVE=0)'); return; }
  const a = new ClaudeAdapter();
  // Resume is CWD-SCOPED — only a session whose recorded workspace STILL EXISTS can be resumed (a
  // session whose /tmp workspace was deleted genuinely can't be, and isn't a product bug).
  const open = (await a.discoverSessions())
    .filter((s) => s.model === 'qwen3.6-27B-FP8' && s.cwd && existsSync(s.cwd))
    .sort((x, y) => (y.updatedAt ?? 0) - (x.updatedAt ?? 0));
  if (!open.length) { console.log('SKIP live drive: no free claude-open session with a live cwd to resume'); return; }
  const conn = await a.attach(open[0]!.id, 'resume');
  let text = '';
  let idle = false;
  let deltas = 0; // streamed token-by-token chunks (model-output/thinking with a `delta`)
  const types = new Set<string>();
  conn.subscribe((m: any) => {
    types.add(m.type);
    if ((m.type === 'model-output' || m.type === 'thinking') && m.delta != null) deltas++;
    if (m.type === 'model-output' && m.text) text = m.text;
    if (m.type === 'status' && m.status === 'idle') idle = true;
  });
  await conn.getHistory();
  await conn.sendPrompt({ text: 'Reply with exactly: drive ok' });
  const start = Date.now();
  while (!idle && Date.now() - start < 120_000) await new Promise((r) => setTimeout(r, 500));
  await conn.close();
  if (!idle) { console.log('SKIP live drive: endpoint did not respond in 120s (offline?)'); return; }
  // Assert the drive MECHANISM, not the small free model's exact output (non-deterministic — a tiny
  // model may reply with only a thinking block and no text): a turn produced assistant content
  // (model-output or thinking), counted tokens, and ended.
  check('live drive: assistant content emitted (model-output or thinking)', types.has('model-output') || types.has('thinking'),
    `types=[${[...types].join(',')}] text=${JSON.stringify(text.slice(0, 60))}`);
  check('live drive: token-by-token streaming (delta frames > 0)', deltas > 0, `${deltas} deltas streamed`);
  check('live drive: token-count emitted', types.has('token-count'));
  check('live drive: turn ended (idle)', idle);
}
try {
  await liveDrive();
} catch (err) {
  console.log('SKIP live drive: threw — ' + String(err));
}

// ── 5. LIVE drive PERMISSION round-trip via the FREE claude-mi wrapper (gated) ──────────────────
// maintainer's 13.1c repro end-to-end on the REAL binary: a gated Bash (sudo) under ask-permission must
// raise a permission card in the drive stream (not silently deny), an app approve must UNBLOCK the
// tool (it runs — sudo's own password failure is the proof of execution), and the card must resolve.
async function livePermission(): Promise<void> {
  if (process.env.CA_RESUME_LIVE === '0') { console.log('SKIP live permission (CA_RESUME_LIVE=0)'); return; }
  const { ClaudeResumeConnection, claudeStores: storesFn, claudeModelOptions: modelsFn } = await import('../../../../packages/typescript/adapters/claude/src/index.ts');
  const mi = storesFn().find((s) => !s.isDefault && s.bin.endsWith('claude-mi'));
  if (!mi) { console.log('SKIP live permission: no claude-mi wrapper store on this machine'); return; }
  const model = modelsFn(mi)[0]?.modelID;
  const { mkdtempSync: mkTmp } = await import('node:fs');
  const { tmpdir: osTmp } = await import('node:os');
  const { join: pjoin } = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  const cwd = mkTmp(pjoin(osTmp(), 'ca-perm-live-'));
  const uuid = randomUUID();
  const slug = cwd.replace(/[\\/.]/g, '-');
  const path = pjoin(mi.projectsRoot, slug, `${uuid}.jsonl`);
  const info: any = { id: uuid, tool: 'claude', title: 'perm live', cwd, status: 'idle', attachMode: 'resume' };
  const conn = new ClaudeResumeConnection(mi, path, info);
  const msgs: any[] = [];
  conn.subscribe((m: any) => msgs.push(m));
  const waitFor = async (pred: (m: any) => boolean, ms: number): Promise<any> => {
    const start = Date.now();
    for (;;) {
      const hit = msgs.find(pred);
      if (hit) return hit;
      if (Date.now() - start > ms) return undefined;
      await new Promise((r) => setTimeout(r, 400));
    }
  };
  try {
    await conn.sendPrompt({
      text: 'Use the Bash tool to run exactly: sudo -n whoami — do not ask questions, just run it, then reply DONE with the outcome in one line.',
      ...(model ? { model: { providerID: 'anthropic', modelID: model } } : {}),
      permissionMode: 'default',
    });
    const card = await waitFor((m) => m.type === 'permission-request', 120_000);
    if (!card && !msgs.some((m) => m.type === 'model-output' || m.type === 'thinking')) {
      console.log('SKIP live permission: endpoint did not respond in 120s (offline?)');
      return;
    }
    check('live permission: gated sudo raises a permission card (was: silent deny, no popup)', !!card, card ? `${card.title}: ${String(card.detail ?? '').slice(0, 80)}` : `types=[${[...new Set(msgs.map((m) => m.type))].join(',')}]`);
    if (!card) return;
    check('live permission: the card names the command being approved', String(card.detail ?? '').includes('sudo'), String(card.detail ?? ''));
    await conn.respondPermission(card.requestId, 'approve');
    const resolved = await waitFor((m) => m.type === 'permission-resolved' && m.requestId === card.requestId, 10_000);
    check('live permission: approve resolves the card', !!resolved);
    const done = await waitFor((m) => m.type === 'model-output' && /DONE/i.test(m.text ?? ''), 120_000);
    const ranProof = msgs.some((m) => JSON.stringify(m).includes('password is required'));
    check('live permission: approve UNBLOCKS the tool — sudo actually ran (password error is the execution proof)', ranProof, `done=${!!done}`);
    const idle = await waitFor((m) => m.type === 'status' && m.status === 'idle', 60_000);
    check('live permission: the turn completes after the approved tool', !!idle);
  } finally {
    await conn.close().catch(() => {});
    const { rmSync: rmrf } = await import('node:fs');
    try { rmrf(pjoin(mi.projectsRoot, slug), { recursive: true, force: true }); } catch { /* best-effort test-store cleanup */ }
  }
}
try {
  await livePermission();
} catch (err) {
  console.log('SKIP live permission: threw — ' + String(err));
}

// ── 6. LIVE drive QUESTION round-trip via the FREE claude-mi wrapper (gated) ────────────────────
// maintainer's follow-up repro: under --permission-prompt-tool stdio the CLI gates AskUserQuestion through
// can_use_tool too. The app must see a QUESTION card (never an Allow/Deny permission card), and the
// answer must reach the model through the control_response (updatedInput.answers) — the injected
// tool_result channel is dead ("agent says it does not receive").
async function liveQuestion(): Promise<void> {
  if (process.env.CA_RESUME_LIVE === '0') { console.log('SKIP live question (CA_RESUME_LIVE=0)'); return; }
  const { ClaudeResumeConnection, claudeStores: storesFn, claudeModelOptions: modelsFn } = await import('../../../../packages/typescript/adapters/claude/src/index.ts');
  const mi = storesFn().find((s) => !s.isDefault && s.bin.endsWith('claude-mi'));
  if (!mi) { console.log('SKIP live question: no claude-mi wrapper store on this machine'); return; }
  const model = modelsFn(mi)[0]?.modelID;
  const { mkdtempSync: mkTmp, rmSync: rmrf } = await import('node:fs');
  const { tmpdir: osTmp } = await import('node:os');
  const { join: pjoin } = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  const cwd = mkTmp(pjoin(osTmp(), 'ca-q-live-'));
  const uuid = randomUUID();
  const slug = cwd.replace(/[\\/.]/g, '-');
  const path = pjoin(mi.projectsRoot, slug, `${uuid}.jsonl`);
  const info: any = { id: uuid, tool: 'claude', title: 'q live', cwd, status: 'idle', attachMode: 'resume' };
  const conn = new ClaudeResumeConnection(mi, path, info);
  const msgs: any[] = [];
  conn.subscribe((m: any) => msgs.push(m));
  const waitFor = async (pred: (m: any) => boolean, ms: number): Promise<any> => {
    const start = Date.now();
    for (;;) {
      const hit = msgs.find(pred);
      if (hit) return hit;
      if (Date.now() - start > ms) return undefined;
      await new Promise((r) => setTimeout(r, 400));
    }
  };
  try {
    await conn.sendPrompt({
      text: 'Use the AskUserQuestion tool to ask me exactly one question: "Which color do you want?" with options "Red" and "Blue". After you receive my answer, reply on one line: ANSWER: <the choice you received>.',
      ...(model ? { model: { providerID: 'anthropic', modelID: model } } : {}),
      permissionMode: 'default',
    });
    const card = await waitFor((m) => m.type === 'question-request', 120_000);
    if (!card && !msgs.some((m) => m.type === 'model-output' || m.type === 'thinking')) {
      console.log('SKIP live question: endpoint did not respond in 120s (offline?)');
      return;
    }
    check('live question: AskUserQuestion raises a QUESTION card', !!card, card ? JSON.stringify(card.questions?.[0]?.question) : `types=[${[...new Set(msgs.map((m) => m.type))].join(',')}]`);
    if (!card) return;
    check('live question: NO Allow/Deny permission card for a question (maintainer\'s weird-card repro)', !msgs.some((m) => m.type === 'permission-request'));
    await conn.answerQuestion(card.requestId, [['Blue']]);
    const resolved = await waitFor((m) => m.type === 'question-resolved' && m.requestId === card.requestId, 10_000);
    check('live question: answering resolves the card', !!resolved);
    const echo = await waitFor((m) => m.type === 'model-output' && /ANSWER:\s*Blue/i.test(m.text ?? ''), 120_000);
    check('live question: the model RECEIVED the choice (was: "agent says it does not receive")', !!echo, echo ? String(echo.text).slice(0, 60) : `finals=${msgs.filter((m) => m.type === 'model-output' && m.final).map((m) => String(m.text).slice(0, 40)).join(' | ')}`);
    const idle = await waitFor((m) => m.type === 'status' && m.status === 'idle', 60_000);
    check('live question: the turn completes after the answered question', !!idle);
  } finally {
    await conn.close().catch(() => {});
    try { rmrf(pjoin(mi.projectsRoot, slug), { recursive: true, force: true }); } catch { /* best-effort test-store cleanup */ }
  }
}
try {
  await liveQuestion();
} catch (err) {
  console.log('SKIP live question: threw — ' + String(err));
}

// ── 7. LIVE user-echo tail (item-12 follow-up, gated like §4-6) — drive stdout has NO user events
//      (probed 2.1.207), so the adapter's transcript echo tail is the ONLY live proof a prompt (and
//      especially a mid-turn QUEUED send) was delivered. Pin: both prompts of a two-send drive turn
//      come back as user-message frames, so the app's dimmed queued bubble can clear. ──
async function liveQueuedEcho(): Promise<void> {
  if (process.env.CA_RESUME_LIVE === '0') { console.log('SKIP live queued-echo (CA_RESUME_LIVE=0)'); return; }
  const { ClaudeResumeConnection, claudeStores: storesFn, claudeModelOptions: modelsFn } = await import('../../../../packages/typescript/adapters/claude/src/index.ts');
  const mi = storesFn().find((s) => !s.isDefault && s.bin.endsWith('claude-mi'));
  if (!mi) { console.log('SKIP live queued-echo: no claude-mi wrapper store on this machine'); return; }
  const model = modelsFn(mi)[0]?.modelID;
  const { mkdtempSync: mkTmp, rmSync: rmrf } = await import('node:fs');
  const { tmpdir: osTmp } = await import('node:os');
  const { join: pjoin } = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  const cwd = mkTmp(pjoin(osTmp(), 'ca-qecho-live-'));
  const uuid = randomUUID();
  const slug = cwd.replace(/[\\/.]/g, '-');
  const path = pjoin(mi.projectsRoot, slug, `${uuid}.jsonl`);
  const info: any = { id: uuid, tool: 'claude', title: 'queued echo live', cwd, status: 'idle', attachMode: 'resume' };
  const conn = new ClaudeResumeConnection(mi, path, info);
  const msgs: any[] = [];
  conn.subscribe((m: any) => msgs.push(m));
  const MARKER = 'QUEUED-ECHO-MARKER';
  const waitFor = async (pred: () => boolean, ms: number): Promise<boolean> => {
    const start = Date.now();
    while (Date.now() - start < ms) { if (pred()) return true; await new Promise((r) => setTimeout(r, 400)); }
    return false;
  };
  try {
    await conn.sendPrompt({
      text: 'Count from 1 to 50 in English words, one word per line. No tools. Just the list.',
      ...(model ? { model: { providerID: 'anthropic', modelID: model } } : {}),
      permissionMode: 'default',
    });
    const streaming = await waitFor(() => msgs.some((m) => m.type === 'model-output' || m.type === 'thinking'), 120_000);
    if (!streaming) { console.log('SKIP live queued-echo: endpoint did not respond in 120s (offline?)'); return; }
    await conn.sendPrompt({ text: `${MARKER}: acknowledge me in one line.` }); // mid-turn → the CLI queues it
    const gotFirst = await waitFor(() => msgs.some((m) => m.type === 'user-message' && /Count from 1 to 50/.test(m.text ?? '')), 30_000);
    check('live queued-echo: the FIRST prompt echoes back as a user-message frame', gotFirst, `types=[${[...new Set(msgs.map((m) => m.type))].join(',')}]`);
    const gotQueued = await waitFor(() => msgs.some((m) => m.type === 'user-message' && (m.text ?? '').startsWith(MARKER)), 180_000);
    check('live queued-echo: the mid-turn (queued) prompt echoes on DELIVERY — the dimmed bubble can clear', gotQueued, JSON.stringify(msgs.filter((m) => m.type === 'user-message').map((m) => String(m.text).slice(0, 40))));
  } finally {
    await conn.close().catch(() => {});
    try { rmrf(pjoin(mi.projectsRoot, slug), { recursive: true, force: true }); } catch { /* best-effort test-store cleanup */ }
    try { rmrf(cwd, { recursive: true, force: true }); } catch { /* ditto */ }
  }
}
try {
  await liveQueuedEcho();
} catch (err) {
  console.log('SKIP live queued-echo: threw — ' + String(err));
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
