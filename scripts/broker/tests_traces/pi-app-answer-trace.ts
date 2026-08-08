/**
 * Pi PERMISSION + QUESTION answer-from-app regression (deterministic, CI-safe — NO real `pi`, NO model) — the
 * real-app (Playwright) guard that a Pi true-sync (bridge) permission AND question render as ACTIONABLE cards and
 * that answering them in the real app DOM flows back to the in-session extension's command queue.
 *
 * Pi true-sync is the BRIDGE: an in-session extension POSTs events to `/pi/bridge/events` and long-polls
 * `/pi/bridge/commands` for the app's actions. So — exactly like Claude's hook endpoints — the test plays the
 * extension over that HTTP wire (the same wire scripts/broker/tests/pi/test-pi-bridge-reload.ts uses): `hello` adopts a
 * pinned live bridge session (surfaced in the roster via the hub's live snapshot, no disk file needed; no Drive
 * takeover — it's already synced), `events` pushes the permission + question (they replay on attach via the
 * bridge's pendingFrames), and after the app's Allow / Submit, `commands` drains the queued decisions we assert.
 *
 * SCOPE — what is and isn't end-to-end here (honest after the 2026-06-23 review):
 *   • PERMISSION is a real LIVE-BRIDGE end-to-end guard: the live extension genuinely emits `permission-request`
 *     (its `tool_call` gate) and consumes the `permission` command, so this round-trips the real code path.
 *   • QUESTION exercises the BROKER+APP WIRE only (ingest → pendingFrames replay → DOM card → `answer` command
 *     queue), NOT the live extension's ability to PRODUCE a question. A live (TUI-mode) Pi extension cannot
 *     intercept Pi's interactive dialogs (confirm/select/input/editor arrive via `extension_ui_request`, which
 *     Pi emits only in RPC mode — never to a TUI extension), so a synced Pi session keeps interactive questions
 *     terminal-only; the wire is forward-ready and the extension now handles a stray `answer`/`reject-question`
 *     gracefully (clears the card, posts an honest notice) instead of dropping it. The Pi RESUME path answers
 *     questions for real (covered by scripts/broker/tests/pi/test-pi-observe.ts + the resume adapter's RPC handling).
 *
 *   bun run scripts/broker/tests_traces/pi-app-answer-trace.ts
 */
import { join } from 'node:path';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startIsolatedBroker, runDriver, pyOpenOnlySession, sleep } from './_app-trace-helpers.ts';

function fail(msg: string): never { throw new Error(msg); }

// A real (but discovery-isolated) session file so bridgeId() can canonicalize it; PI_CODING_AGENT_DIR points at a
// SEPARATE empty dir so disk discovery finds nothing → only the live bridge row appears.
const piRoot = mkdtempSync(join(tmpdir(), 'cosyncing-pi-answer-'));
const WORK = join(piRoot, 'work');
const emptyAgentDir = join(piRoot, 'agent-empty');
mkdirSync(WORK, { recursive: true });
mkdirSync(join(emptyAgentDir, 'sessions'), { recursive: true });
const sessionFile = join(piRoot, 'session_pi-answer.jsonl');
const denyProof = join(WORK, 'pi-deny-proof.txt');
writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3, id: 'pi-answer', timestamp: '2026-06-22T00:00:00.000Z', cwd: WORK }) + '\n');

const b = await startIsolatedBroker({ PI_CODING_AGENT_DIR: emptyAgentDir, COSYNCING_PI_SESSIONS_ROOT: '', PI_CODING_AGENT_SESSION_DIR: '' });
const post = (path: string, body: unknown) => fetch(`${b.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const drainCommands = async (id: string): Promise<any[]> => ((await (await fetch(`${b.base}/pi/bridge/commands?id=${encodeURIComponent(id)}`)).json())?.commands ?? []);
try {
  const hello = await (await post('/pi/bridge/hello', { sessionFile, cwd: WORK, title: 'pi sync session', model: { providerID: 'anthropic', modelID: 'pi-default', label: 'Pi' } })).json();
  const id = String(hello?.id ?? '');
  if (!id) fail(`bridge hello returned no id: ${JSON.stringify(hello)}`);
  // Push the pending permission + question BEFORE the app attaches — they replay on attach via pendingFrames.
  // NOTE (scope, see header): the live TUI-mode extension emits `permission-request` for real but CANNOT emit
  // `question-request` (no extension_ui_request in TUI mode), so the question here tests the broker+app WIRE
  // (ingest → replay → DOM → command queue), not live-extension production of a question.
  await post('/pi/bridge/events', { id, events: [
    { t: 'permission-request', requestId: 'pi_perm_1', title: 'Run a shell command', detail: 'rm -rf /tmp/pi-scratch-dir', toolName: 'bash' },
    { t: 'permission-request', requestId: 'pi_perm_deny', title: 'Run a shell command', detail: `touch ${denyProof}`, toolName: 'bash' },
    { t: 'question-request', requestId: 'pi_q_1', questions: [{ question: 'Which approach should I take?', header: 'Approach', options: [{ label: 'Refactor in place' }, { label: 'Rewrite from scratch' }], multiple: false }] },
  ] });

  let found = false;
  for (let i = 0; i < 40 && !found; i++) {
    try {
      const data = (await (await fetch(`${b.base}/api/sessions`)).json()) as any;
      const ss: any[] = Array.isArray(data) ? data : (data?.sessions ?? []);
      found = ss.some((s) => s.tool === 'pi');
    } catch {}
    if (!found) await sleep(200);
  }
  if (!found) fail('Pi bridge session never appeared in /api/sessions');

  const shot = '/tmp/pi-app-answer.png';
  const PY = pyOpenOnlySession(String.raw`
    # a synced Pi bridge session is already drivable — both cards replay on attach
    pg.wait_for_selector("[id^='perm-']", state="visible", timeout=20000)
    pg.wait_for_selector("[id^='q-']", state="visible", timeout=20000)
    pg.wait_for_function("() => document.querySelectorAll('[id^=perm-]').length >= 2", timeout=20000)
    pg.wait_for_timeout(400)
    out["before"] = pg.evaluate("""() => {
        const perm = [...document.querySelectorAll("[id^='perm-']")].find(x => /scratch/i.test(x.textContent || ''));
        const deny = [...document.querySelectorAll("[id^='perm-']")].find(x => /deny-proof/i.test(x.textContent || ''));
        const q = document.querySelector("[id^='q-']");
        return {
            permActionable: !!(perm && perm.querySelector('button.ok')) && (perm.getAttribute('data-pending-input') || 'actionable'),
            permTitle: perm ? (perm.textContent||'').slice(0,60) : null,
            denyActionable: !!(deny && deny.querySelector('button.no')) && (deny.getAttribute('data-pending-input') || 'actionable'),
            denyTitle: deny ? (deny.textContent||'').slice(0,80) : null,
            qActionable: !!(q && q.querySelector('button.ok')),
            qOptions: q ? [...q.querySelectorAll('.qopt')].length : 0,
        };
    }""")
    # answer the QUESTION (pick first option → Submit), then the PERMISSION (Allow)
    q = pg.locator("[id^='q-']").first
    q.locator(".qopt").first.click(timeout=8000)
    pg.wait_for_timeout(200)
    q.locator("button.ok").first.click(timeout=8000)
    pg.locator("[id^='perm-']", has_text="scratch").locator("button.ok").first.click(timeout=8000)
    pg.locator("[id^='perm-']", has_text="deny-proof").locator("button.no").first.click(timeout=8000)
    pg.wait_for_timeout(1500)
`);
  const res = await runDriver(b.home, b.base, PY, [shot]);
  if (res.skip) { console.log(`SKIP pi answer — ${res.skip}`); }
  else if (res.error) { fail(`driver error: ${res.error} (screenshot ${shot})`); }
  else {
    // Drain the extension's command queue (where the app's answers land), collecting over a few polls.
    const cmds: any[] = [];
    for (let i = 0; i < 5 && !(cmds.filter((c) => c.kind === 'permission').length >= 2 && cmds.some((c) => c.kind === 'answer')); i++) {
      cmds.push(...(await drainCommands(id)));
      if (!(cmds.filter((c) => c.kind === 'permission').length >= 2 && cmds.some((c) => c.kind === 'answer'))) await sleep(300);
    }
    const before = res.before || {};
    const permCmd = cmds.find((c) => c.kind === 'permission' && c.requestId === 'pi_perm_1');
    const denyCmd = cmds.find((c) => c.kind === 'permission' && c.requestId === 'pi_perm_deny');
    const ansCmd = cmds.find((c) => c.kind === 'answer');
    if (denyCmd && denyCmd.decision !== 'reject') writeFileSync(denyProof, 'DENY_WAS_APPROVED');
    console.log(`before: ${JSON.stringify(before)}`);
    console.log(`extension command queue: ${JSON.stringify(cmds)}  📸 ${shot}`);
    const checks: [string, boolean, string][] = [
      ['the Pi bridge permission renders as an ACTIONABLE card', !!before.permActionable, `permActionable=${JSON.stringify(before.permActionable)}`],
      ['the permission card shows its command detail', /scratch|rm -rf|shell|command/i.test(before.permTitle || ''), `permTitle=${JSON.stringify(before.permTitle)}`],
      ['the Pi bridge deny permission renders with a Deny button', !!before.denyActionable, `deny=${JSON.stringify({ a: before.denyActionable, title: before.denyTitle })}`],
      ['the Pi bridge question renders an ACTIONABLE card with its options (broker+app wire)', before.qActionable === true && (before.qOptions || 0) >= 2, `q=${JSON.stringify({ a: before.qActionable, n: before.qOptions })}`],
      ['answering the question reached the extension command queue (wire end; live extension can\'t produce questions in TUI mode)', !!ansCmd && ansCmd.requestId === 'pi_q_1' && Array.isArray(ansCmd.answers), `ansCmd=${JSON.stringify(ansCmd)}`],
      ['the question answer carries the selected option label', !!ansCmd && JSON.stringify(ansCmd.answers).includes('Refactor in place'), `ansCmd=${JSON.stringify(ansCmd)}`],
      ['Allow reached the extension queue for the right request', !!permCmd && permCmd.requestId === 'pi_perm_1', `permCmd=${JSON.stringify(permCmd)}`],
      ['the permission decision is an approval (not reject)', !!permCmd && permCmd.decision !== 'reject' && /approve|allow|once|always|accept/i.test(String(permCmd.decision)), `permCmd=${JSON.stringify(permCmd)}`],
      ['Deny reached the extension queue as a reject', !!denyCmd && denyCmd.decision === 'reject', `denyCmd=${JSON.stringify(denyCmd)}`],
      ['the denied Pi command did NOT create the proof file', !existsSync(denyProof), denyProof],
    ];
    let allPass = true;
    for (const [name, ok, detail] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${name} — ${detail}`); if (!ok) allPass = false; }
    if (!allPass) fail('pi permission+question answer-from-app regression FAILED (see ❌; screenshot saved)');
    console.log('PASS pi answer — LIVE-bridge permission round-trips end-to-end; the question card + answer ride the broker/app wire (live TUI extension can\'t emit questions — terminal-only; resume path answers them for real).');
  }
} finally {
  b.broker.kill();
  await b.broker.exited.catch(() => null);
  rmSync(b.home, { recursive: true, force: true });
  rmSync(piRoot, { recursive: true, force: true });
}
