/**
 * OpenCode DISPLAY + MODEL-SWITCH wire regression (deterministic, CI-safe — NO real opencode, NO model).
 *
 * Two things, through the REAL app.js DOM (not a unit test):
 *   1. DISPLAY: a shared-server OpenCode session shows its model and native agent in the statusline.
 *   2. NATIVE MODEL CHANGE: a terminal/native `session.updated` model change pushes through SSE -> broker session
 *      frame -> app statusline, so the app shows the latest native model, not only the initially attached model.
 *   3. PLAN AGENT: selecting OpenCode's native `plan` primary agent in the app must ride as `agent:"plan"`
 *      on the next prompt, not as a permission-mode.
 *   4. MODEL-SWITCH IDENTITY (the "minimax X-Api-Key" backlog bug): selecting a different model in the app picker
 *      and sending a prompt must forward the EXACT {providerID, modelID, variant} OpenCode advertised — and must
 *      NEVER forward the provider's `X-Api-Key`/`headers` secret. Diagnosis (2026-06-23): the login-fail is NOT a
 *      cosyncing bug — CA forwards model identity verbatim and (correctly) never carries the provider key, which
 *      the OpenCode `serve` runtime owns. The picker→selectedModel→prompt_async wire path (app.js Hop C) was only
 *      covered by a static string-match; this exercises it behaviorally end-to-end and pins the verbatim+secret-free
 *      contract so a future refactor can't reintroduce a real identity-drop bug.
 *
 *   bun run scripts/broker/tests_traces/opencode-display-trace.ts
 */
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startIsolatedBroker, runDriver, pyOpenOnlySession, CHIP_READER, freePort, sleep } from './_app-trace-helpers.ts';

function fail(msg: string): never { throw new Error(msg); }

const fakePort = await freePort();
const FAKE = `http://127.0.0.1:${fakePort}`;
const WORK = mkdtempSync(join(tmpdir(), 'cosyncing-ocd-work-'));
let SESSION = {
  id: 'ses_display',
  slug: 'display',
  directory: WORK,
  title: 'opencode display session',
  model: { id: 'gpt-5.2', providerID: 'openai', modelID: 'gpt-5.2' },
  time: { created: 1, updated: 2 },
};
// MiniMax has a credential-bearing `fast` variant — the exact backlog shape: the X-Api-Key lives in the variant
// header, OWNED BY THE OPENCODE RUNTIME (the placeholder documents that CA must never forward it).
const MODELS = [
  { providerID: 'openai', id: 'gpt-5.2', name: 'GPT-5.2', capabilities: { tools: true } },
  { providerID: 'vllm-hpc', id: 'qwen3.6-27B-FP8', name: 'qwen3.6-27B-FP8', capabilities: { tools: false } },
  { providerID: 'minimax', id: 'MiniMax-M3', name: 'MiniMax-M3', capabilities: { tools: false }, variants: [{ id: 'default', body: { stream_options: { include_usage: true } } }, { id: 'fast', headers: { 'X-Api-Key': '${OPENCODE_RUNTIME_OWNS_THIS}' } }] },
];
const AGENTS = [
  { name: 'build', mode: 'primary', description: 'Implementation agent' },
  { name: 'plan', mode: 'primary', description: 'Read-only planning agent' },
  { name: 'summary', mode: 'internal', description: '' },
];
const promptBodies: any[] = [];
const eventClients = new Set<any>();

function sendEvent(event: unknown): void {
  const frame = `data: ${JSON.stringify({ payload: event })}\n\n`;
  for (const c of [...eventClients]) {
    try {
      c.enqueue(frame);
    } catch {
      eventClients.delete(c);
    }
  }
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: fakePort,
  idleTimeout: 0, // long-lived SSE stream — don't warn-timeout it
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === '/global/event') {
      return new Response(
        new ReadableStream({
          start(controller: any) { eventClients.add(controller); },
          cancel() { /* closed by the browser; stale controllers are pruned on next send */ },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }
    if (path === '/__test/model' && req.method === 'POST') {
      SESSION = {
        ...SESSION,
        model: { id: 'qwen3.6-27B-FP8', providerID: 'vllm-hpc', modelID: 'qwen3.6-27B-FP8' },
        time: { ...SESSION.time, updated: 3 },
      };
      sendEvent({ type: 'session.updated', properties: { info: SESSION } });
      return Response.json({ ok: true });
    }
    if (path === '/project') return Response.json([{ worktree: WORK }]);
    if (path === '/api/model') return Response.json({ data: MODELS });
    if (path === '/agent') return Response.json(AGENTS);
    if (path === '/command') return Response.json([]);
    if (path === '/session' && req.method === 'GET') return Response.json([SESSION]);
    if (path === `/session/${SESSION.id}` && req.method === 'GET') return Response.json(SESSION);
    if (path === `/session/${SESSION.id}/message`) return Response.json([]);
    if (path === `/session/${SESSION.id}/prompt_async` && req.method === 'POST') { promptBodies.push(await req.json().catch(() => ({}))); return new Response(null, { status: 204 }); }
    if (path === '/question' || path === '/permission') return Response.json([]);
    return new Response('not found', { status: 404 });
  },
});

const ocData = mkdtempSync(join(tmpdir(), 'cosyncing-ocd-data-'));
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

  const shot = '/tmp/opencode-display.png';
  const PY = pyOpenOnlySession(String.raw`
    import urllib.request
    pg.wait_for_selector("#statusline", state="visible", timeout=15000)
    pg.wait_for_timeout(600)
    out["chips"] = pg.evaluate("""` + CHIP_READER + String.raw`""")
    # PLAN AGENT: choose OpenCode's native plan primary agent. This is agent, not permissionMode.
    pg.click("#agentPick", timeout=10000)
    pg.wait_for_selector("#optmenu .oitem", state="visible", timeout=10000)
    out["pickedAgent"] = pg.evaluate("""() => {
        const items = [...document.querySelectorAll('#optmenu .oitem')];
        const t = items.find(d => (d.textContent||'').trim().toLowerCase().startsWith('plan'));
        if (t) { t.click(); return t.textContent.trim(); }
        return null;
    }""")
    pg.wait_for_function("""() => {
        const e = document.getElementById('statusAgent');
        return e && /plan/i.test(e.textContent || '');
    }""", timeout=10000)
    out["agentChips"] = pg.evaluate("""` + CHIP_READER + String.raw`""")
    # Native/terminal-side model change: emit OpenCode's session.updated event from the fake serve.
    urllib.request.urlopen(urllib.request.Request(sys.argv[3] + "/__test/model", data=b"{}", method="POST"), timeout=5).read()
    pg.wait_for_function("""() => {
        const e = document.getElementById('statusModel');
        return e && /qwen3\\.6-27B-FP8|vllm-hpc/i.test(e.textContent || '');
    }""", timeout=10000)
    out["nativeChips"] = pg.evaluate("""` + CHIP_READER + String.raw`""")
    # MODEL SWITCH: open the picker, choose the MiniMax fast variant
    pg.click("#modelPick", timeout=10000)
    pg.wait_for_selector("#optmenu .oitem", state="visible", timeout=10000)
    out["picked"] = pg.evaluate("""() => {
        const items = [...document.querySelectorAll('#optmenu .oitem')];
        const t = items.find(d => /MiniMax/i.test(d.textContent) && /fast/i.test(d.textContent)) || items.find(d => /MiniMax/i.test(d.textContent));
        if (t) { t.click(); return t.textContent.trim(); }
        return null;
    }""")
    pg.wait_for_timeout(300)
    # send a prompt carrying the switched model
    pg.fill("#input", "use the switched model please")
    pg.wait_for_timeout(150)
    pg.click("#send", timeout=10000)
    pg.wait_for_timeout(1600)
`);
  const res = await runDriver(b.home, b.base, PY, [shot, FAKE]);
  if (res.skip) { console.log(`SKIP opencode display — ${res.skip}`); }
  else if (res.error) { fail(`driver error: ${res.error} (screenshot ${shot})`); }
  else {
    await sleep(500);
    const c = res.chips || {};
    const native = res.nativeChips || {};
    const agentChips = res.agentChips || {};
    const body = promptBodies[0];
    const raw = JSON.stringify(body ?? {});
    console.log(`statusline chips: ${JSON.stringify(c)}`);
    console.log(`plan-agent chips: ${JSON.stringify(agentChips)}`);
    console.log(`native model-change chips: ${JSON.stringify(native)}`);
    console.log(`picked agent: ${JSON.stringify(res.pickedAgent)}`);
    console.log(`picked: ${JSON.stringify(res.picked)}`);
    console.log(`prompt_async body: ${raw}  📸 ${shot}`);
    const model = (c.statusModel || '').toLowerCase();
    const checks: [string, boolean, string][] = [
      ['the OpenCode model is SHOWN in the statusline', !!c.statusModel && !/unknown/.test(model), `statusModel=${JSON.stringify(c.statusModel)}`],
      ['the statusline reflects the session model (gpt-5.2)', /gpt-5\.2|gpt/.test(model), `statusModel=${JSON.stringify(c.statusModel)}`],
      ['the native OpenCode plan agent is selectable in the app', !!res.pickedAgent && /plan/i.test(res.pickedAgent), `pickedAgent=${JSON.stringify(res.pickedAgent)}`],
      ['selecting plan updates the app statusline agent chip', /plan/i.test(String(agentChips.statusAgent ?? '')), `statusAgent=${JSON.stringify(agentChips.statusAgent)}`],
      ['a native session.updated model change refreshes the app statusline to qwen', /qwen3\.6-27b-fp8|vllm-hpc/.test(String(native.statusModel ?? '').toLowerCase()), `nativeStatusModel=${JSON.stringify(native.statusModel)}`],
      ['the model picker offered the MiniMax variant row', !!res.picked && /MiniMax/i.test(res.picked), `picked=${JSON.stringify(res.picked)}`],
      ['the prompt forwarded plan as OpenCode agent, not permissionMode', !!body && body.agent === 'plan' && body.permissionMode === undefined, `agent=${JSON.stringify(body?.agent)} permissionMode=${JSON.stringify(body?.permissionMode)}`],
      ['the prompt forwarded the EXACT switched provider/model', !!body && body.model?.providerID === 'minimax' && body.model?.modelID === 'MiniMax-M3', `model=${JSON.stringify(body?.model)}`],
      ['the prompt forwarded the variant verbatim (top-level)', !!body && body.variant === 'fast', `variant=${JSON.stringify(body?.variant)}`],
      ['cosyncing did NOT forward the provider secret (no X-Api-Key / headers)', !!body && !/x-api-key/i.test(raw) && !/"headers"/.test(raw), `body=${raw.slice(0, 160)}`],
    ];
    let allPass = true;
    for (const [name, ok, detail] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${name} — ${detail}`); if (!ok) allPass = false; }
    if (!allPass) fail('opencode display/model-switch regression FAILED (see ❌; screenshot saved)');
    console.log('PASS opencode display — model shown, native model change reflected, and app model switch forwards EXACT identity without provider secret.');
  }
} finally {
  b.broker.kill();
  await b.broker.exited.catch(() => null);
  server.stop(true);
  rmSync(b.home, { recursive: true, force: true });
  rmSync(WORK, { recursive: true, force: true });
  rmSync(ocData, { recursive: true, force: true });
}
