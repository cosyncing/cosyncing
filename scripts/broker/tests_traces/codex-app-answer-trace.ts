/**
 * Codex permission/question answer-from-app regression (deterministic, CI-safe — NO real codex, NO model) — the
 * real-app (Playwright) guard that Codex permission/question requests raised by a broker-owned resume
 * (app-server) connection render as ACTIONABLE cards and resolve back through the daemon.
 *
 * This is the Codex analog of claude-app-answer-trace.ts. Codex's permission flow is app-server (resume) only — it
 * is not a durable rollout record — so the deterministic path points the broker at a FAKE `codex` binary via
 * COSYNCING_CODEX_BIN (the same technique scripts/broker/tests/codex/resume-fake.ts uses). The fake speaks just enough of the
 * app-server JSON-RPC to complete the resume handshake, then emits a native model-change notification and
 * proactively raises an exec-command approval, a user-input question, and a second exec-command approval
 * that the app denies. The fake records each response.
 *
 * Full DOM path exercised: open session (observe) → "Take over" (#control) → confirm Drive (.modalback .mok) →
 * resume attach spawns the fake → permission/question cards render → click Allow/Submit/Deny → fake records
 * accept/question/decline and does not write the deny proof file.
 *
 *   bun run scripts/broker/tests_traces/codex-app-answer-trace.ts
 */
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startIsolatedBroker, runDriver, pyOpenOnlySession, CHIP_READER, sleep } from './_app-trace-helpers.ts';

function fail(msg: string): never { throw new Error(msg); }

// A fake `codex` app-server: resume handshake + proactively-raised approval/question/deny approval requests.
const FAKE = String.raw`#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
const DECISION_FILE = '__DECISION__';
const QUESTION_FILE = '__QUESTION__';
const DENY_DECISION_FILE = '__DENY_DECISION__';
const DENY_PROOF = '__DENY_PROOF__';
const enc = new TextDecoder();
let buf = '';
const send = (o) => console.log(JSON.stringify(o));
function raiseRequests() {
  send({ id: 77, method: 'item/commandExecution/requestApproval', params: {
    threadId: 'fake-thread', turnId: 'turn1', itemId: 'cmd1',
    command: 'rm -rf /tmp/scratch-dir', cwd: '/tmp', reason: 'the agent wants to delete a scratch dir',
    availableDecisions: ['acceptForSession', 'accept', 'reject'],
  } });
  send({ id: 78, method: 'item/tool/requestUserInput', params: {
    threadId: 'fake-thread', turnId: 'turn1', itemId: 'ask1',
    questions: [{ id: 'choice', header: 'Trace decision', question: 'Continue with Codex?', options: [{ label: 'Proceed', description: 'continue' }, { label: 'Stop', description: 'stop' }] }],
  } });
  send({ id: 79, method: 'item/commandExecution/requestApproval', params: {
    threadId: 'fake-thread', turnId: 'turn1', itemId: 'cmd-deny',
    command: 'touch ' + DENY_PROOF, cwd: '/tmp', reason: 'negative outcome guard',
    availableDecisions: ['accept', 'reject'],
  } });
}
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const raw = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    let msg; try { msg = JSON.parse(raw); } catch { continue; }
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') {
      send({ id: msg.id, result: { thread: { name: 'fake' }, model: 'gpt-5.4-codex', modelProvider: 'openai',
        reasoningEffort: 'high', approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' } } });
      setTimeout(() => send({ method: 'turn/started', params: { threadId: 'fake-thread', turn: {
        id: 'turn-native-model', model: 'gpt-5.5-codex-native', modelProvider: 'openai', reasoningEffort: 'low'
      } } }), 250);
      setTimeout(raiseRequests, 900); // after the app's resume WS has subscribed
    }
    else if (msg.method === 'model/list') send({ id: msg.id, result: { data: [{ model: 'gpt-5.4-codex', providerID: 'openai', displayName: 'GPT-5.4 Codex', supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' }] } });
    else if (msg.method === 'config/read') send({ id: msg.id, result: { config: { model_provider: 'openai' } } });
    else if (msg.id === 77 && msg.result !== undefined) writeFileSync(DECISION_FILE, JSON.stringify(msg.result));
    else if (msg.id === 78 && msg.result !== undefined) writeFileSync(QUESTION_FILE, JSON.stringify(msg.result));
    else if (msg.id === 79 && msg.result !== undefined) {
      writeFileSync(DENY_DECISION_FILE, JSON.stringify(msg.result));
      if (msg.result?.decision !== 'decline') writeFileSync(DENY_PROOF, 'DENY_WAS_APPROVED');
    }
    else if (msg.id != null && msg.method) send({ id: msg.id, result: {} }); // catch-all so start() never stalls
  }
}
`;

const fakeDir = mkdtempSync(join(tmpdir(), 'cosyncing-codexfake-'));
const fakeBin = join(fakeDir, 'codex');
const decisionFile = join(fakeDir, 'decision.json');
const questionFile = join(fakeDir, 'question.json');
const denyDecisionFile = join(fakeDir, 'deny-decision.json');
const denyProofFile = join(fakeDir, 'deny-proof.txt');
writeFileSync(fakeBin, FAKE
  .replace('__DECISION__', decisionFile)
  .replace('__QUESTION__', questionFile)
  .replace('__DENY_DECISION__', denyDecisionFile)
  .replace('__DENY_PROOF__', denyProofFile));
chmodSync(fakeBin, 0o755);

const b = await startIsolatedBroker({ COSYNCING_CODEX_BIN: fakeBin });
try {
  const work = join(b.home, 'work', 'codexperm');
  mkdirSync(work, { recursive: true });
  const UUID = '019ed222-bbbb-7ccc-8ddd-e0f0a0b0c0d0';
  const sessionsDir = join(b.home, '.codex', 'sessions', '2026', '06', '22');
  mkdirSync(sessionsDir, { recursive: true });
  const rolloutPath = join(sessionsDir, `rollout-2026-06-22T13-00-00-${UUID}.jsonl`);
  // Minimal idle rollout — enough for Observe discovery; the resume connection reloads from the fake daemon.
  writeFileSync(rolloutPath, [
    { type: 'session_meta', payload: { cwd: work, id: UUID, model_provider: 'openai' } },
    { type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-5.4-codex', model_provider: 'openai', reasoning_effort: 'high', approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write' } } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'clean up the scratch dir', turn_id: 't1' }, timestamp: '2026-06-22T13:00:00.000Z' },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' }, timestamp: '2026-06-22T13:00:00.000Z' },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' }, timestamp: '2026-06-22T13:00:01.000Z' },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');

  let found = false;
  for (let i = 0; i < 40 && !found; i++) {
    try {
      const data = (await (await fetch(`${b.base}/api/sessions`)).json()) as any;
      const ss: any[] = Array.isArray(data) ? data : (data?.sessions ?? []);
      found = ss.some((s) => s.tool === 'codex' && typeof s.cwd === 'string' && s.cwd.includes('codexperm'));
    } catch {}
    if (!found) await sleep(200);
  }
  if (!found) fail('seeded Codex session never appeared in /api/sessions (discovery)');

  const shot = '/tmp/codex-app-answer.png';
  const PY = pyOpenOnlySession(String.raw`
    # observe→drive: click "Take over" then confirm the takeover modal
    pg.wait_for_selector("#control", state="visible", timeout=15000)
    pg.wait_for_function("() => { const x=document.getElementById('control'); return x && x.offsetParent!==null && x.dataset.kind==='takeover' && !x.disabled; }", timeout=15000)
    pg.locator("#control").click(timeout=10000)
    pg.wait_for_selector(".modalback .mok", state="visible", timeout=10000)
    pg.locator(".modalback .mok").click(timeout=10000)
    # native app-server model notification should move the generic statusline to the latest model/effort
    pg.wait_for_function("""() => /5\.5|native/i.test(document.getElementById('statusModel')?.textContent || '')""", timeout=15000)
    pg.wait_for_function("""() => /low/i.test(document.getElementById('statusEffort')?.textContent || '')""", timeout=15000)
    out["nativeChips"] = pg.evaluate("""` + CHIP_READER + String.raw`""")
    # the resume (fake) daemon raises permission/question/deny requests → actionable cards must render
    pg.wait_for_selector("[id^='perm-']", state="visible", timeout=20000)
    pg.wait_for_selector("[id^='q-']", state="visible", timeout=20000)
    pg.wait_for_function("() => document.querySelectorAll('[id^=perm-]').length >= 2", timeout=20000)
    pg.wait_for_timeout(400)
    out["card"] = pg.evaluate("""() => {
        const c = [...document.querySelectorAll("[id^='perm-']")].find(x => /scratch/.test(x.textContent || '')); if (!c) return null;
        const ok = c.querySelector('button.ok');
        return { id: c.id, hasAllow: !!ok, pending: c.getAttribute('data-pending-input'), title: (c.textContent||'').slice(0,80) };
    }""")
    out["question"] = pg.evaluate("""() => {
        const q = document.querySelector("[id^='q-']"); if (!q) return null;
        return { id: q.id, hasSubmit: !!q.querySelector('button.ok'), options: q.querySelectorAll('.qopt').length, title: (q.textContent||'').slice(0,80) };
    }""")
    out["denyCard"] = pg.evaluate("""() => {
        const c = [...document.querySelectorAll("[id^='perm-']")].find(x => /negative outcome guard|touch/.test(x.textContent || '')); if (!c) return null;
        return { id: c.id, hasDeny: !!c.querySelector('button.no'), pending: c.getAttribute('data-pending-input'), title: (c.textContent||'').slice(0,80) };
    }""")
    # click Allow once
    allow = pg.locator("[id^='perm-']", has_text="scratch").locator("button.ok").first
    allow.click(timeout=10000)
    # answer the question through the DOM
    q = pg.locator("[id^='q-']").first
    q.locator(".qopt").first.click(timeout=8000)
    pg.wait_for_timeout(200)
    q.locator("button.ok").first.click(timeout=8000)
    # deny the second permission through the DOM
    pg.locator("[id^='perm-']", has_text="negative outcome guard").locator("button.no").first.click(timeout=10000)
    pg.wait_for_timeout(1800)
    out["afterAllow"] = pg.evaluate("""() => {
        const c = [...document.querySelectorAll("[id^='perm-']")].find(x => /scratch/.test(x.textContent || ''));
        if (!c) return { cleared: true };
        const ok = c.querySelector('button.ok');
        return { cleared: false, allowGone: !ok, disabled: ok ? ok.disabled===true : null, pending: c.getAttribute('data-pending-input') };
    }""")
    out["afterDeny"] = pg.evaluate("""() => {
        const c = [...document.querySelectorAll("[id^='perm-']")].find(x => /negative outcome guard|touch/.test(x.textContent || ''));
        if (!c) return { cleared: true };
        const no = c.querySelector('button.no');
        return { cleared: false, denyGone: !no, disabled: no ? no.disabled===true : null, pending: c.getAttribute('data-pending-input') };
    }""")
`);
  const res = await runDriver(b.home, b.base, PY, [shot]);
  if (res.skip) { console.log(`SKIP codex permission — ${res.skip}`); }
  else if (res.error) { fail(`driver error: ${res.error} (screenshot ${shot})`); }
  else {
    // GROUND TRUTH: the fake daemon recorded the decision the broker wrote back on Allow.
    await sleep(500);
    const decisionRaw = existsSync(decisionFile) ? readFileSync(decisionFile, 'utf8') : '';
    const questionRaw = existsSync(questionFile) ? readFileSync(questionFile, 'utf8') : '';
    const denyRaw = existsSync(denyDecisionFile) ? readFileSync(denyDecisionFile, 'utf8') : '';
    let decision: any = null; try { decision = JSON.parse(decisionRaw); } catch {}
    let question: any = null; try { question = JSON.parse(questionRaw); } catch {}
    let denyDecision: any = null; try { denyDecision = JSON.parse(denyRaw); } catch {}
    console.log(`card: ${JSON.stringify(res.card)}`);
    console.log(`native update chips: ${JSON.stringify(res.nativeChips)}`);
    console.log(`question: ${JSON.stringify(res.question)}`);
    console.log(`denyCard: ${JSON.stringify(res.denyCard)}`);
    console.log(`afterAllow: ${JSON.stringify(res.afterAllow)}`);
    console.log(`afterDeny: ${JSON.stringify(res.afterDeny)}`);
    console.log(`daemon-recorded allow decision: ${decisionRaw || '<none>'}`);
    console.log(`daemon-recorded question answer: ${questionRaw || '<none>'}`);
    console.log(`daemon-recorded deny decision: ${denyRaw || '<none>'}  📸 ${shot}`);
    const cardCleared = res.afterAllow && (res.afterAllow.cleared === true || res.afterAllow.allowGone === true || res.afterAllow.disabled === true || res.afterAllow.pending === 'resolved');
    const denyCleared = res.afterDeny && (res.afterDeny.cleared === true || res.afterDeny.denyGone === true || res.afterDeny.disabled === true || res.afterDeny.pending === 'resolved');
    const checks: [string, boolean, string][] = [
      ['the resumed Codex daemon\'s permission renders as an ACTIONABLE card', !!res.card && res.card.hasAllow === true, `card=${JSON.stringify(res.card)}`],
      ['the native Codex model update renders as the latest statusline model', /5\.5|native/i.test(res.nativeChips?.statusModel || ''), `nativeChips=${JSON.stringify(res.nativeChips)}`],
      ['the native Codex effort update renders as the latest statusline effort', /low/i.test(res.nativeChips?.statusEffort || ''), `nativeChips=${JSON.stringify(res.nativeChips)}`],
      ['the permission card shows the command detail', !!res.card && /scratch|rm -rf|command/i.test(res.card.title || ''), `title=${JSON.stringify(res.card?.title)}`],
      ['the Codex question renders as an ACTIONABLE card with options', !!res.question && res.question.hasSubmit === true && res.question.options >= 2, `question=${JSON.stringify(res.question)}`],
      ['the Codex deny permission renders with a Deny button', !!res.denyCard && res.denyCard.hasDeny === true, `denyCard=${JSON.stringify(res.denyCard)}`],
      ['clicking Allow resolved the card in the UI', !!cardCleared, `afterAllow=${JSON.stringify(res.afterAllow)}`],
      ['clicking Deny resolved the deny card in the UI', !!denyCleared, `afterDeny=${JSON.stringify(res.afterDeny)}`],
      ['the Allow click reached the daemon and was recorded (decision written)', !!decisionRaw, `decision=${decisionRaw || '<none>'}`],
      ['the recorded decision is an APPROVAL (accept), not a reject', !!decision && decision.decision === 'accept', `decision=${JSON.stringify(decision)}`],
      ['the question answer reached the daemon', !!questionRaw && JSON.stringify(question).includes('Proceed'), `question=${JSON.stringify(question)}`],
      ['the Deny click reached the daemon as a rejection', !!denyDecision && denyDecision.decision === 'decline', `deny=${JSON.stringify(denyDecision)}`],
      ['the denied Codex command did NOT create the proof file', !existsSync(denyProofFile), denyProofFile],
    ];
    let allPass = true;
    for (const [name, ok, detail] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${name} — ${detail}`); if (!ok) allPass = false; }
    if (!allPass) fail('codex permission answer-from-app regression FAILED (see ❌; screenshot saved)');
    console.log('PASS codex app-answer — native model refresh plus permission allow, question answer, and permission deny round-trip from the real app DOM.');
  }
} finally {
  b.broker.kill();
  await b.broker.exited.catch(() => null);
  rmSync(b.home, { recursive: true, force: true });
  rmSync(fakeDir, { recursive: true, force: true });
}
