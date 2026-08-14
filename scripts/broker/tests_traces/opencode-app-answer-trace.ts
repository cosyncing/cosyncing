/**
 * OpenCode PERMISSION + QUESTION answer-from-app regression (deterministic, CI-safe — NO real opencode, NO model)
 * — the real-app (Playwright) guard that an OpenCode permission AND an OpenCode question raised over the server's
 * SSE event bus render as ACTIONABLE cards and that answering them in the real app DOM flows back to the server.
 *
 * OpenCode is driven over HTTP/SSE against a reachable `opencode serve`; a shared-server session is already
 * app-drivable (control.drive.state === 'driving'), so NO takeover is needed — opening the session is enough. This
 * points the broker at a FAKE opencode server (in-process Bun.serve, OPENCODE_URL) — the same technique
 * packages/typescript/adapters/opencode/test/test-opencode-control.ts uses — that emits a `permission.v2.asked` and a `question.v2.asked`
 * on `/global/event` shortly after the connection subscribes, and records the `POST /permission/<id>/reply` +
 * `POST /question/<id>/reply` the app's Allow / Submit produce.
 *
 *   bun run scripts/broker/tests_traces/opencode-app-answer-trace.ts
 */
import { join } from 'node:path';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startIsolatedBroker, runDriver, pyOpenOnlySession, freePort, sleep } from './_app-trace-helpers.ts';

function fail(msg: string): never { throw new Error(msg); }

const fakePort = await freePort();
const FAKE = `http://127.0.0.1:${fakePort}`;
const WORK = mkdtempSync(join(tmpdir(), 'cosyncing-oc-work-'));
const SESSION = {
  id: 'ses_answer',
  slug: 'answer',
  directory: WORK,
  title: 'opencode answer session',
  model: { id: 'gpt-5.2', providerID: 'openai', modelID: 'gpt-5.2' },
  time: { created: 1, updated: 2 },
};
const MODELS = [{ providerID: 'openai', id: 'gpt-5.2', name: 'GPT-5.2', capabilities: { tools: true } }];
const replies: { permission: any[]; question: any[] } = { permission: [], question: [] };
const denyProof = join(WORK, 'opencode-deny-proof.txt');

const enc = new TextEncoder();
function eventStream(): Response {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Response(new ReadableStream({
    start(controller) {
      const send = (obj: unknown) => { try { controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch {} };
      // Emit AFTER the connection has subscribed + the app WS is live (so the cards render where a human is looking).
      timer = setTimeout(() => {
        send({ payload: { type: 'permission.v2.asked', properties: { id: 'perm_1', sessionID: SESSION.id, action: 'Delete scratch.txt', resources: ['/tmp/scratch.txt'] } } });
        send({ payload: { type: 'permission.v2.asked', properties: { id: 'perm_deny', sessionID: SESSION.id, action: 'Create opencode-deny-proof.txt', resources: [denyProof] } } });
        send({ payload: { type: 'question.v2.asked', properties: { id: 'que_1', sessionID: SESSION.id, questions: [{ question: 'Which approach should I take?', header: 'Approach', options: [{ label: 'Refactor in place' }, { label: 'Rewrite from scratch' }], multiple: false }] } } });
      }, 1300);
    },
    cancel() { if (timer) clearTimeout(timer); },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: fakePort,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === '/global/event') return eventStream();
    if (path === '/project') return Response.json([{ worktree: WORK }]);
    if (path === '/api/model') return Response.json({ data: MODELS });
    if (path === '/agent') return Response.json([]);
    if (path === '/command') return Response.json([]);
    if (path === '/session' && req.method === 'GET') return Response.json([SESSION]);
    if (path === `/session/${SESSION.id}` && req.method === 'GET') return Response.json(SESSION);
    if (path === `/session/${SESSION.id}/message`) return Response.json([]);
    if (path === `/permission/perm_1/reply` && req.method === 'POST') { replies.permission.push({ id: 'perm_1', ...(await req.json().catch(() => ({}))) }); return new Response(null, { status: 204 }); }
    if (path === `/permission/perm_deny/reply` && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      replies.permission.push({ id: 'perm_deny', ...body });
      if (body?.reply !== 'reject') writeFileSync(denyProof, 'DENY_WAS_APPROVED');
      return new Response(null, { status: 204 });
    }
    if (path === `/question/que_1/reply` && req.method === 'POST') { replies.question.push(await req.json().catch(() => ({}))); return new Response(null, { status: 204 }); }
    if (path === '/question' || path === '/permission') return Response.json([]);
    return new Response('not found', { status: 404 });
  },
});

const ocData = mkdtempSync(join(tmpdir(), 'cosyncing-oc-data-'));
mkdirSync(join(ocData, 'storage', 'session'), { recursive: true });
const b = await startIsolatedBroker({ OPENCODE_URL: FAKE, OPENCODE_DATA: ocData });
try {
  let found = false;
  for (let i = 0; i < 40 && !found; i++) {
    try {
      const data = (await (await fetch(`${b.base}/api/sessions`)).json()) as any;
      const ss: any[] = Array.isArray(data) ? data : (data?.sessions ?? []);
      found = ss.some((s) => s.tool === 'opencode' && s.id === SESSION.id);
    } catch {}
    if (!found) await sleep(200);
  }
  if (!found) fail('seeded OpenCode session never appeared in /api/sessions (discovery)');

  const shot = '/tmp/opencode-app-answer.png';
  const PY = pyOpenOnlySession(String.raw`
    # a shared-server OpenCode session is already drivable — the cards arrive over SSE ~1.3s after attach
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
            qTitle: q ? (q.textContent||'').slice(0,60) : null,
        };
    }""")
    # answer the QUESTION: pick the first option, then Submit
    q = pg.locator("[id^='q-']").first
    q.locator(".qopt").first.click(timeout=8000)
    pg.wait_for_timeout(200)
    q.locator("button.ok").first.click(timeout=8000)
    # answer the PERMISSION: Allow once
    pg.locator("[id^='perm-']", has_text="scratch").locator("button.ok").first.click(timeout=8000)
    # answer the negative PERMISSION: Deny
    pg.locator("[id^='perm-']", has_text="deny-proof").locator("button.no").first.click(timeout=8000)
    pg.wait_for_timeout(1500)
`);
  const res = await runDriver(b.home, b.base, PY, [shot]);
  if (res.skip) { console.log(`SKIP opencode answer — ${res.skip}`); }
  else if (res.error) { fail(`driver error: ${res.error} (screenshot ${shot})`); }
  else {
    await sleep(500);
    console.log(`before: ${JSON.stringify(res.before)}`);
    console.log(`server replies: permission=${JSON.stringify(replies.permission)} question=${JSON.stringify(replies.question)}  📸 ${shot}`);
    const before = res.before || {};
    const permReply = replies.permission.find((r) => r.id === 'perm_1');
    const denyReply = replies.permission.find((r) => r.id === 'perm_deny');
    const qReply = replies.question[0];
    const checks: [string, boolean, string][] = [
      ['the OpenCode permission renders as an ACTIONABLE card', !!before.permActionable, `permActionable=${JSON.stringify(before.permActionable)}`],
      ['the permission card shows its action detail', /scratch|delete/i.test(before.permTitle || ''), `permTitle=${JSON.stringify(before.permTitle)}`],
      ['the OpenCode deny permission renders with a Deny button', !!before.denyActionable, `deny=${JSON.stringify({ a: before.denyActionable, title: before.denyTitle })}`],
      ['the OpenCode question renders an ACTIONABLE card with its options', before.qActionable === true && (before.qOptions || 0) >= 2, `q=${JSON.stringify({ a: before.qActionable, n: before.qOptions })}`],
      ['answering the question reached the server (POST /question/reply)', !!qReply && Array.isArray(qReply.answers), `qReply=${JSON.stringify(qReply)}`],
      ['the question answer carries the selected option label', !!qReply && JSON.stringify(qReply.answers).includes('Refactor in place'), `qReply=${JSON.stringify(qReply)}`],
      ['Allow reached the server (POST /permission/reply)', !!permReply, `permReply=${JSON.stringify(permReply)}`],
      ['the permission reply is an approval (once/always, not reject)', !!permReply && (permReply.reply === 'once' || permReply.reply === 'always'), `permReply=${JSON.stringify(permReply)}`],
      ['Deny reached the server as a reject', !!denyReply && denyReply.reply === 'reject', `denyReply=${JSON.stringify(denyReply)}`],
      ['the denied OpenCode command did NOT create the proof file', !existsSync(denyProof), denyProof],
    ];
    let allPass = true;
    for (const [name, ok, detail] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${name} — ${detail}`); if (!ok) allPass = false; }
    if (!allPass) fail('opencode permission+question answer-from-app regression FAILED (see ❌; screenshot saved)');
    console.log('PASS opencode answer — permission AND question are answerable from the real app DOM (→ server reply).');
  }
} finally {
  b.broker.kill();
  await b.broker.exited.catch(() => null);
  server.stop(true);
  rmSync(b.home, { recursive: true, force: true });
  rmSync(WORK, { recursive: true, force: true });
  rmSync(ocData, { recursive: true, force: true });
}
