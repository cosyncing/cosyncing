/**
 * Systematic integration tests for the OpenCode path — the CI scope for this build.
 * One test per implemented capability so we can verify regressions in one run.
 *
 * Capability matrix covered:
 *   1. roster discovery                 (GET /api/sessions)
 *   1b. roster completeness             (every on-disk top-level session appears in the roster)
 *   2. new session via the broker       (POST /api/sessions/opencode → attach → drive)
 *   3. live sync / cold-attach stream   (prompt on WS open → model-output; cross-dir /tmp session)
 *   4. role-aware user bubble           (direct-to-OpenCode prompt ≈ CLI → user-message, no left echo)
 *   5. session status                   (working → idle)
 *   6. QA / needs-input                 (question-request → answer via /reply → agent continues)
 *   7. slash commands advertised        (commands frame includes built-in actions incl. undo/redo)
 *   8. slash command run + notice       (stop/compact/undo/redo → {kind:'notice'}, no error)
 *   9. tool-call rendering enrichment   (bash tool-result carries title + exitCode)
 *
 * Creates/deletes ONLY throwaway sessions (scoped to /tmp), free local model, never touches
 * real sessions. Requires a running broker + `opencode serve`.
 *   BROKER=http://127.0.0.1:7734 OC=http://127.0.0.1:4096 bun run packages/typescript/broker/test/opencode/test-opencode.ts
 * Exit 0 = all pass.
 */
export {};
import { mkdirSync, writeFileSync, symlinkSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const BROKER = process.env.BROKER ?? 'http://127.0.0.1:7734';
const OC = process.env.OC ?? 'http://127.0.0.1:4096';
const MODEL = { id: 'qwen3.6-27B-FP8', providerID: 'vllm-hpc' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function createSession(dir: string): Promise<string> {
  mkdirSync(dir, { recursive: true }); // a real cwd so file/bash tools don't error
  const r = await fetch(`${OC}/session?directory=${encodeURIComponent(dir)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'cosyncing-test', model: MODEL }),
  });
  return (await r.json()).id as string;
}
const delSession = (id: string, dir: string) =>
  fetch(`${OC}/session/${id}?directory=${encodeURIComponent(dir)}`, { method: 'DELETE' }).catch(() => {});
const promptDirect = (id: string, dir: string, text: string) =>
  fetch(`${OC}/session/${id}/prompt_async?directory=${encodeURIComponent(dir)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text }] }),
  });
async function statusOf(id: string): Promise<string | undefined> {
  const d = await (await fetch(`${BROKER}/api/sessions`)).json();
  return (d.sessions.find((s: any) => s.id === id) || {}).status;
}
/** Poll until ≥ minAssistant *completed* assistant turns exist — a revert on a still-busy
 *  session returns 409 SessionBusyError, so we must wait for `time.completed`, not mere presence. */
async function waitAssistant(id: string, dir: string, minAssistant: number, ms = 25000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const list = await (await fetch(`${OC}/session/${id}/message?directory=${encodeURIComponent(dir)}`)).json();
    if (list.filter((m: any) => m.info.role === 'assistant' && m.info.time?.completed).length >= minAssistant) return;
    await sleep(600);
  }
}

interface Attached {
  send: (o: any) => void;
  frames: any[];
  msgs: () => any[];
  commands: () => any[];
  /** Accumulated assistant text across model-output frames (text replace OR delta append),
   *  exactly how the UI reconstructs the stream — needed since text now arrives token-by-token. */
  assistantText: () => string;
  waitMsg: (pred: (m: any) => boolean, ms: number) => Promise<any | undefined>;
  waitFrame: (pred: (f: any) => boolean, ms: number) => Promise<any | undefined>;
  waitText: (re: RegExp, ms: number) => Promise<boolean>;
  close: () => void;
}
function attach(id: string, onOpen?: (a: Attached) => void): Promise<Attached> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${BROKER.replace(/^http/, 'ws')}/api/sessions/opencode/${encodeURIComponent(id)}/stream`);
    const frames: any[] = [];
    const waitFor = async (pred: (x: any) => boolean, pick: (f: any) => any, ms: number) => {
      const end = Date.now() + ms;
      for (;;) {
        const hit = frames.map(pick).find((x) => x && pred(x));
        if (hit) return hit;
        if (Date.now() > end) return undefined;
        await sleep(150);
      }
    };
    const assistantText = () => {
      const by = new Map<string, string>();
      for (const f of frames) {
        if (f.kind === 'message' && f.message?.type === 'model-output') {
          const k = f.message.key || '_';
          const cur = by.get(k) || '';
          by.set(k, f.message.text != null ? f.message.text : cur + (f.message.delta || ''));
        }
      }
      return [...by.values()].join('\n');
    };
    const a: Attached = {
      send: (o) => ws.send(JSON.stringify(o)),
      frames,
      msgs: () => frames.filter((f) => f.kind === 'message').map((f) => f.message),
      commands: () => frames.filter((f) => f.kind === 'commands').flatMap((f) => f.commands || []),
      assistantText,
      waitMsg: (pred, ms) => waitFor(pred, (f) => (f.kind === 'message' ? f.message : null), ms),
      waitFrame: (pred, ms) => waitFor(pred, (f) => f, ms),
      waitText: async (re, ms) => {
        const end = Date.now() + ms;
        for (;;) {
          if (re.test(assistantText())) return true;
          if (Date.now() > end) return false;
          await sleep(150);
        }
      },
      close: () => { try { ws.close(); } catch {} },
    };
    ws.onmessage = (e) => { try { frames.push(JSON.parse(String(e.data))); } catch {} };
    ws.onopen = () => { onOpen?.(a); resolve(a); };
  });
}

// Judge what happens AFTER a frame index: an error frame = failure (e.g. a reply 404 the UI would
// show as a toast); a message matching `ok` = success. This is what catches silent reply failures.
async function outcomeAfter(a: Attached, mark: number, ok: (m: any) => boolean, ms = 15000): Promise<string> {
  const end = Date.now() + ms;
  for (;;) {
    const after = a.frames.slice(mark);
    const err = after.find((f) => f.kind === 'error');
    if (err) return 'error: ' + String(err.message).slice(0, 90);
    if (after.some((f) => f.kind === 'message' && ok(f.message))) return 'ok';
    if (Date.now() > end) return 'timeout';
    await sleep(200);
  }
}

const results: { name: string; status: 'pass' | 'fail' | 'skip'; detail: string }[] = [];
async function test(name: string, fn: () => Promise<[boolean | 'skip', string]>) {
  process.stdout.write(`• ${name} … `);
  try {
    const [ok, detail] = await fn();
    const status = ok === 'skip' ? 'skip' : ok ? 'pass' : 'fail';
    results.push({ name, status, detail });
    console.log(`${status.toUpperCase()}  ${detail}`);
  } catch (e) {
    results.push({ name, status: 'fail', detail: String(e) });
    console.log('FAIL  threw: ' + e);
  }
}

// 1) roster discovery
await test('roster discovery', async () => {
  const d = await (await fetch(`${BROKER}/api/sessions`)).json();
  return [Array.isArray(d.sessions), `${d.sessions?.length ?? 0} sessions, machine=${d.machine}`];
});

// 1b) roster COMPLETENESS — every top-level session OpenCode has on disk must appear in the roster.
// Disk is the authoritative full set (the HTTP API can't enumerate orphaned-projectID or non-project
// -dir sessions); this guards the 197→302 fix from silently regressing. Ground truth = parentID-less
// session-info files under <store>/session. Skips if the store isn't local (remote serve / CI box).
await test('roster completeness vs on-disk session count', async () => {
  const store = join(
    process.env.OPENCODE_DATA ?? join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode'),
    'storage',
    'session',
  );
  if (!existsSync(store)) return ['skip', `no local OpenCode storage at ${store} (remote serve?)`];
  const walk = (dir: string, depth: number): string[] => {
    if (depth < 0) return [];
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(f, depth - 1));
      else if (e.name.endsWith('.json')) out.push(f);
    }
    return out;
  };
  const diskParents = new Set<string>();
  for (const f of walk(store, 2)) {
    try {
      const s = JSON.parse(readFileSync(f, 'utf8'));
      if (s?.id && !s.parentID) diskParents.add(s.id);
    } catch {
      /* skip partial file */
    }
  }
  const d = await (await fetch(`${BROKER}/api/sessions`)).json();
  const roster = new Set((d.sessions ?? []).filter((s: any) => s.tool === 'opencode').map((s: any) => s.id));
  const missing = [...diskParents].filter((id) => !roster.has(id));
  const detail = `disk top-level=${diskParents.size}, roster opencode=${roster.size}, missing=${missing.length}${
    missing.length ? ` (e.g. ${missing.slice(0, 3).join(', ')})` : ''
  }`;
  return [missing.length === 0, detail];
});

// 2) new session via broker + 3) cold-attach streaming + cross-dir (one flow)
await test('new session (broker) + cold-attach stream + cross-dir', async () => {
  mkdirSync('/tmp/cany-new', { recursive: true });
  const r = await fetch(`${BROKER}/api/sessions/opencode`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ directory: '/tmp/cany-new' }),
  });
  const id = (await r.json()).session?.id;
  if (!id) return [false, 'broker did not return a new session'];
  const a = await attach(id, (a) => a.send({ kind: 'prompt', text: 'Reply with exactly: OK' }));
  const hit = await a.waitText(/OK/, 30000); // text now streams as deltas; accumulate like the UI
  a.close();
  await delSession(id, '/tmp/cany-new');
  return [hit, hit ? 'created + streamed' : 'no stream from new session'];
});

// 3b) streaming is token-level: a multi-sentence answer arrives as many model-output deltas,
// not one big block (the "paragraph by paragraph" fix). Assert we see plenty of delta frames.
await test('streaming is token-level (deltas)', async () => {
  const dir = '/tmp/cany-stream';
  const id = await createSession(dir);
  const a = await attach(id, (a) => a.send({ kind: 'prompt', text: 'Write a 60-word paragraph about the sea. Plain prose, no tools.' }));
  await a.waitText(/\w+\s+\w+\s+\w+/, 25000); // some words arrived
  await sleep(2000);
  const deltas = a.msgs().filter((m) => m.type === 'model-output' && m.delta != null).length;
  const text = a.assistantText();
  a.close();
  await delSession(id, dir);
  if (!text) return ['skip', 'model produced no text this run'];
  // many small deltas (not 1-2 big snapshots) is the whole point
  return [deltas >= 8, `${deltas} delta frames, ${text.length} chars`];
});

// 3c) reasoning deltas go to the THINKING lane, not the answer (qwen mislabels them field:'text')
await test('reasoning routed to thinking, not the answer', async () => {
  const dir = '/tmp/cany-reason';
  const id = await createSession(dir);
  const a = await attach(id, (a) => a.send({ kind: 'prompt', text: 'What is 17 plus 25? Think step by step, then give just the final number.' }));
  for (let i = 0; i < 40; i++) { await sleep(500); if (a.msgs().some((m) => m.type === 'status' && m.status === 'idle') && i > 4) break; }
  await sleep(1000);
  const answer = a.assistantText();
  const thinking = a.msgs().filter((m) => m.type === 'thinking').length;
  a.close();
  await delSession(id, dir);
  if (thinking === 0) return ['skip', 'model emitted no reasoning this run'];
  // the answer must not contain the chain-of-thought ("the user wants…", "step by step", "let me…")
  const clean = !/user wants|step by step|let me /i.test(answer);
  return [clean, `answer="${answer.slice(0, 40).replace(/\n/g, ' ')}" cleanOfReasoning=${clean}`];
});

// 3d) late-join: a client attaching mid-stream gets the text streamed BEFORE it joined
await test('late-join gets pre-join stream', async () => {
  const dir = '/tmp/cany-late';
  const id = await createSession(dir);
  const A = await attach(id, (a) => a.send({ kind: 'prompt', text: 'Count from 1 to 40, one per line, with a short note after each.' }));
  let joinAt = 0;
  for (let i = 0; i < 50; i++) { await sleep(300); if (A.assistantText().length > 150) { joinAt = A.assistantText().length; break; } }
  if (!joinAt) { A.close(); await delSession(id, dir); return ['skip', 'stream too slow to test late-join this run']; }
  const B = await attach(id); // join mid-stream
  for (let i = 0; i < 70; i++) { await sleep(500); if (A.msgs().some((m) => m.type === 'status' && m.status === 'idle') && i > 3) break; }
  await sleep(2000);
  const aFinal = A.assistantText().length, bFinal = B.assistantText().length;
  A.close(); B.close();
  await delSession(id, dir);
  // B must end with ~the same full text as A, despite missing the first joinAt chars live
  return [bFinal >= joinAt && Math.abs(aFinal - bFinal) < 30, `joinedAt=${joinAt} A=${aFinal} B=${bFinal}`];
});

// 4) role-aware user bubble (direct prompt ≈ CLI)
await test('CLI prompt → user-message (no left echo)', async () => {
  const dir = '/tmp/cany-role';
  const id = await createSession(dir);
  const a = await attach(id);
  await sleep(1500);
  await promptDirect(id, dir, 'PING_CLI_MARKER');
  await sleep(9000);
  const user = a.msgs().some((m) => m.type === 'user-message' && /PING_CLI_MARKER/.test(m.text ?? ''));
  const echo = a.msgs().some((m) => m.type === 'model-output' && /PING_CLI_MARKER/.test(m.text ?? ''));
  a.close();
  await delSession(id, dir);
  return [user && !echo, `user-bubble=${user} left-echo=${echo}`];
});

// 5) session status working → idle
await test('status working→idle', async () => {
  const dir = '/tmp/cany-status';
  const id = await createSession(dir);
  await fetch(`${BROKER}/api/sessions`);
  await sleep(1500);
  await promptDirect(id, dir, 'Reply with exactly: OK');
  const timeline: (string | undefined)[] = [];
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const s = await statusOf(id);
    if (s !== timeline[timeline.length - 1]) timeline.push(s);
  }
  await delSession(id, dir);
  return [timeline.includes('working') && timeline[timeline.length - 1] === 'idle', timeline.join('→')];
});

// 6) QA — question answered via its own channel, agent continues
await test('question answered via /reply (not queued)', async () => {
  const dir = '/tmp/cany-qa';
  const id = await createSession(dir);
  const a = await attach(id, (a) =>
    a.send({ kind: 'prompt', text: 'Use the question tool to ask me an interactive question. The question is test, options are a, b and c.' }),
  );
  const q = await a.waitMsg((m) => m.type === 'question-request', 25000);
  if (!q) { a.close(); await delSession(id, dir); return [false, 'no question-request']; }
  // Mark the frame boundary so we only judge what happens AFTER the answer (avoids matching the
  // assistant's pre-question text — the false-positive that hid the reply-404 bug).
  const mark = a.frames.length;
  a.send({ kind: 'answer', requestId: q.requestId, answers: [[q.questions?.[0]?.options?.[0]?.label ?? 'a']] });
  const outcome = await outcomeAfter(a, mark, (m) => m.type === 'question-resolved' || m.type === 'model-output');
  a.close();
  await delSession(id, dir);
  return [outcome === 'ok', outcome];
});

// 6b) permission approve — exercises the same directory-scoped reply path as questions
await test('permission approve (no 404)', async () => {
  const dir = '/tmp/cany-perm';
  mkdirSync(dir, { recursive: true });
  const id = (await (await fetch(`${OC}/session?directory=${encodeURIComponent(dir)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'perm', model: MODEL, permission: [{ permission: 'bash', pattern: '*', action: 'ask' }] }),
  })).json()).id;
  const a = await attach(id, (a) => a.send({ kind: 'prompt', text: 'Use your bash tool to run exactly: echo perm-test' }));
  const p = await a.waitMsg((m) => m.type === 'permission-request', 25000);
  if (!p) { a.close(); await delSession(id, dir); return ['skip', 'model did not trigger a permission this run']; }
  const advertisesAlways = Array.isArray(p.options) && p.options.includes('approve-session');
  const mark = a.frames.length;
  a.send({ kind: 'approve', requestId: p.requestId, decision: 'approve' });
  const outcome = await outcomeAfter(a, mark, (m) => m.type === 'permission-resolved' || m.type === 'tool-result' || m.type === 'model-output');
  a.close();
  await delSession(id, dir);
  return [advertisesAlways && outcome === 'ok', `${outcome}; approve-session=${advertisesAlways}`];
});

// 6c) a pending question flips the session to needs-input in the roster
await test('question sets needs-input status', async () => {
  const dir = '/tmp/cany-ni';
  const id = await createSession(dir);
  await fetch(`${BROKER}/api/sessions`); // ensure tracker is subscribed
  await sleep(1500);
  await promptDirect(id, dir, 'Use the question tool to ask me: test, options a, b, c.');
  let st = '';
  const end = Date.now() + 22000;
  while (Date.now() < end) {
    await sleep(600);
    st = (await statusOf(id)) ?? '';
    if (st === 'needs-input') break;
  }
  await delSession(id, dir);
  return [st === 'needs-input', `status=${st}`];
});

// 6d) a question asked BEFORE attach surfaces as a card (not a raw JSON tool block)
await test('pending question surfaced on attach', async () => {
  const dir = '/tmp/cany-pend';
  const id = await createSession(dir);
  await promptDirect(id, dir, 'Use the question tool to ask me: test, options a, b, c.');
  await sleep(9000); // let the question be asked while we are NOT attached
  const a = await attach(id); // attach AFTER — pending question must replay as a card
  const q = await a.waitMsg((m) => m.type === 'question-request', 8000);
  const rawBlock = a.msgs().some((m) => (m.type === 'tool-call' || m.type === 'tool-result') && m.toolName === 'question');
  a.close();
  await delSession(id, dir);
  if (!q) return ['skip', 'model did not ask a question this run'];
  return [!rawBlock, rawBlock ? 'raw question tool block leaked' : 'card surfaced, no raw block'];
});

// 7) slash commands advertised
await test('slash commands advertised', async () => {
  const dir = '/tmp/cany-cmds';
  const id = await createSession(dir);
  const a = await attach(id);
  await a.waitFrame((f) => f.kind === 'commands', 6000);
  const names = a.commands().map((c) => c.name);
  a.close();
  await delSession(id, dir);
  const want = ['compact', 'undo', 'redo', 'stop', 'share'];
  const missing = want.filter((n) => !names.includes(n));
  return [missing.length === 0, missing.length ? `missing ${missing.join(',')}` : `${names.length} commands (${want.join(',')}…)`];
});

// 8) slash command run (built-in action accepted, no error)
await test('slash command run (stop) accepted', async () => {
  const dir = '/tmp/cany-cmdrun';
  const id = await createSession(dir);
  const a = await attach(id);
  await sleep(800);
  a.send({ kind: 'command', name: 'stop' });
  const err = await a.waitFrame((f) => f.kind === 'error', 3000);
  a.close();
  await delSession(id, dir);
  return [!err, err ? `error: ${err.message}` : 'accepted, no error'];
});

// 8b) slash command run (compact) — routes via summarize, not the dormant v2 /compact
await test('slash command run (compact) accepted', async () => {
  const dir = '/tmp/cany-compact';
  const id = await createSession(dir);
  const a = await attach(id, (a) => a.send({ kind: 'prompt', text: 'say hi' }));
  await a.waitMsg((m) => m.type === 'model-output', 15000); // give the session some content
  await sleep(500);
  const mark = a.frames.length;
  a.send({ kind: 'command', name: 'compact' });
  await sleep(4000);
  const err = a.frames.slice(mark).find((f) => f.kind === 'error');
  a.close();
  await delSession(id, dir);
  return [!err, err ? 'error: ' + String(err.message).slice(0, 80) : 'accepted, no error'];
});

// 8c) app /undo + /redo commands → revert the last turn, resync + notice (no error).
// Needs ≥2 turns: reverting to the FIRST message would empty the session (OpenCode 409).
await test('slash command undo + redo (app)', async () => {
  const dir = '/tmp/cany-undo';
  const id = await createSession(dir);
  await promptDirect(id, dir, 'Reply with exactly: ONE');
  await waitAssistant(id, dir, 1);
  await promptDirect(id, dir, 'Reply with exactly: TWO');
  await waitAssistant(id, dir, 2);
  const a = await attach(id);
  await sleep(1500);
  a.send({ kind: 'command', name: 'undo' });
  const undoNote = await a.waitFrame((f) => f.kind === 'notice', 8000);
  const err = a.frames.find((f) => f.kind === 'error');
  let redoNote: any;
  if (!err) {
    a.send({ kind: 'command', name: 'redo' });
    redoNote = await a.waitFrame((f) => f.kind === 'notice' && /[Rr]estored/.test(f.message), 8000);
  }
  a.close();
  await delSession(id, dir);
  if (err) return [false, 'error: ' + String(err.message).slice(0, 80)];
  return [!!undoNote && !!redoNote, `undo=${JSON.stringify(undoNote?.message)} redo=${!!redoNote}`];
});

// 8e) a revert done OUTSIDE the app (= `/undo` typed in the terminal) syncs to attached clients:
// the transcript re-pushes with the reverted turn gone, then restored — the CLI↔app sync gap.
await test('CLI revert/redo syncs to app', async () => {
  const dir = '/tmp/cany-revsync';
  const id = await createSession(dir);
  // two turns BEFORE attaching, so the revert target isn't the first message (would 409)
  await promptDirect(id, dir, 'Reply with exactly: ONE');
  await waitAssistant(id, dir, 1);
  await promptDirect(id, dir, 'Reply with exactly: TWO');
  await waitAssistant(id, dir, 2);
  const a = await attach(id);
  await sleep(1500);
  const userCount = () => {
    const h = [...a.frames].reverse().find((f) => f.kind === 'history');
    return (h?.messages || []).filter((m: any) => m.type === 'user-message').length;
  };
  const before = userCount();
  // revert directly via OpenCode — the app is a bystander, exactly like a terminal `/undo`
  const list = await (await fetch(`${OC}/session/${id}/message?directory=${encodeURIComponent(dir)}`)).json();
  let lastUser: string | undefined;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].info.role === 'user') { lastUser = list[i].info.id; break; }
  let mark = a.frames.length;
  await fetch(`${OC}/session/${id}/revert?directory=${encodeURIComponent(dir)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messageID: lastUser }),
  });
  await a.waitFrame((f) => f.kind === 'history', 8000); // resync snapshot must arrive
  await sleep(600);
  const afterRevert = userCount();
  const revNote = a.frames.slice(mark).some((f) => f.kind === 'notice');
  // redo (CLI unrevert) restores it
  mark = a.frames.length;
  await fetch(`${OC}/session/${id}/unrevert?directory=${encodeURIComponent(dir)}`, { method: 'POST' });
  await a.waitFrame((f) => f.kind === 'history', 8000);
  await sleep(600);
  const afterRedo = userCount();
  const redoNote = a.frames.slice(mark).some((f) => f.kind === 'notice');
  a.close();
  await delSession(id, dir);
  const ok = before >= 1 && afterRevert < before && revNote && afterRedo === before && redoNote;
  return [ok, `users ${before}→${afterRevert}→${afterRedo}, notes rev=${revNote} redo=${redoNote}`];
});

// 8f) model + agent pickers advertised on attach (the {kind:'options'} frame)
await test('model + agent options advertised', async () => {
  const dir = '/tmp/cany-opts';
  const id = await createSession(dir);
  const a = await attach(id);
  const opt = await a.waitFrame((f) => f.kind === 'options', 6000);
  a.close();
  await delSession(id, dir);
  if (!opt) return [false, 'no options frame'];
  const agents = (opt.agents || []).map((x: any) => x.name);
  const models = (opt.models || []) as any[];
  // the session's OWN model must be in the picker even though qwen reports tools:false
  const hasOwn = models.some((m) => m.modelID === MODEL.id && m.providerID === MODEL.providerID);
  const ok = models.length > 0 && agents.includes('build') && agents.includes('plan') && hasOwn;
  return [ok, `${models.length} models (own model present=${hasOwn}), agents=[${agents.join(',')}]`];
});

// 8f-2) a bogus model surfaces the async session.error (no more dead-silent failures)
await test('bogus model surfaces session.error', async () => {
  const dir = '/tmp/cany-badmodel';
  const id = await createSession(dir);
  const a = await attach(id);
  await sleep(800);
  a.send({ kind: 'prompt', text: 'hi', model: { providerID: 'nope', modelID: 'nope' } });
  const err = await a.waitMsg((m) => m.type === 'error', 12000); // adapter emits an error AgentMessage
  a.close();
  await delSession(id, dir);
  return [!!err, err ? `error surfaced: ${String(err.message).slice(0, 50)}` : 'silent failure (no error)'];
});

// 8g) per-prompt agent override (plan mode) is accepted and streams a reply
await test('per-prompt agent override (plan)', async () => {
  const dir = '/tmp/cany-agent';
  const id = await createSession(dir);
  const a = await attach(id, (a) => a.send({ kind: 'prompt', text: 'Briefly say hello.', agent: 'plan' }));
  const hit = await a.waitText(/\w/, 22000);
  const err = a.frames.find((f) => f.kind === 'error');
  a.close();
  await delSession(id, dir);
  if (err) return [false, 'error: ' + String(err.message).slice(0, 80)];
  return [hit, hit ? 'plan agent streamed a reply' : 'no reply'];
});

// 8h) user→agent file upload: a {kind:'file'} reaches the agent (its caption echoes as a user msg)
await test('file upload reaches the agent', async () => {
  const dir = '/tmp/cany-fileup';
  const id = await createSession(dir);
  const a = await attach(id);
  await sleep(800);
  const mark = a.frames.length;
  // 1x1 transparent PNG
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  a.send({ kind: 'file', name: 'pixel.png', mimeType: 'image/png', data: png });
  const got = await a.waitMsg((m) => m.type === 'user-message' && /pixel\.png/.test(m.text || ''), 12000);
  const err = a.frames.slice(mark).find((f) => f.kind === 'error');
  a.close();
  await delSession(id, dir);
  if (err) return [false, 'error: ' + String(err.message).slice(0, 80)];
  return [!!got, got ? 'file delivered (caption echoed)' : 'no file echo'];
});

// 8i) agent→user file pipeline: the session-qualified send_file route surfaces an artifact.
await test('session-qualified send_file surfaces artifact', async () => {
  const dir = '/tmp/cany-send-file';
  const id = await createSession(dir);
  writeFileSync(`${dir}/report.txt`, 'hello from the agent');
  const a = await attach(id);
  const response = await fetch(`${BROKER}/api/tool/send_file`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionID: id, tool: 'opencode', path: 'report.txt' }),
  });
  const art = await a.waitMsg((m) => m.type === 'file-artifact' && /report\.txt/.test(m.name || ''), 8000);
  a.close();
  await delSession(id, dir);
  return [response.ok && !!art && !!(art.fetchUrl || art.url), art ? `artifact ${art.name} (${art.mimeType})` : 'no artifact surfaced'];
});

// 8i-1b) received files survive a reattach (refresh / switch-away-and-back). Broker-injected
// artifacts aren't in getHistory(), so the broker must replay them on attach — regression for the
// "received files in the chat disappeared" bug.
await test('received artifact survives reattach', async () => {
  const dir = '/tmp/cany-reattach';
  const id = await createSession(dir);
  writeFileSync(`${dir}/keepme.txt`, 'persist across reattach');
  const a1 = await attach(id);
  await fetch(`${BROKER}/api/tool/send_file`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionID: id, tool: 'opencode', path: 'keepme.txt' }),
  });
  const live = await a1.waitMsg((m) => m.type === 'file-artifact' && /keepme\.txt/.test(m.name || ''), 8000);
  a1.close();
  await sleep(500); // reattach within the 15s grace → same ManagedConn reused (the refresh case)
  const a2 = await attach(id);
  const replayed = await a2.waitMsg((m) => m.type === 'file-artifact' && /keepme\.txt/.test(m.name || ''), 6000);
  a2.close();
  await delSession(id, dir);
  return [!!live && !!replayed && !!(replayed.fetchUrl || replayed.url), `live=${!!live} afterReattach=${!!replayed}`];
});

// 8i-2) send_file is hardened: a symlink is NOT followed, and a rewrite of the
// SAME filename remains a distinct version for this exact session.
await test('send_file hardening (symlink reject + rewrite versioning)', async () => {
  const dir = '/tmp/cany-send-file2';
  const id = await createSession(dir);
  const a = await attach(id);
  writeFileSync('/tmp/cany-secret-leak.txt', 'SECRET-LEAK-XYZ');
  try { symlinkSync('/tmp/cany-secret-leak.txt', `${dir}/link.txt`); } catch { /* symlink may be unsupported */ }
  const symlinkResponse = await fetch(`${BROKER}/api/tool/send_file`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionID: id, tool: 'opencode', path: 'link.txt' }),
  });
  writeFileSync(`${dir}/doc.txt`, 'v1');
  await fetch(`${BROKER}/api/tool/send_file`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionID: id, tool: 'opencode', path: 'doc.txt' }),
  });
  await sleep(300);
  writeFileSync(`${dir}/doc.txt`, 'v2-updated');
  await fetch(`${BROKER}/api/tool/send_file`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionID: id, tool: 'opencode', path: 'doc.txt' }),
  });
  await sleep(500);
  const arts = a.msgs().filter((m) => m.type === 'file-artifact');
  const docArtifacts = arts.filter((m) => m.name === 'doc.txt');
  const versions = new Set(docArtifacts.map((m) => m.artifactKey || m.contentHash || m.url));
  const absPathLeak = arts.some((m) => typeof m.path === 'string' && m.path.startsWith('/'));
  a.close();
  await delSession(id, dir);
  const ok = !symlinkResponse.ok && docArtifacts.length >= 2 && versions.size >= 2 && !absPathLeak;
  return [ok, `symlinkRejected=${!symlinkResponse.ok} versions=${versions.size} absPath=${absPathLeak}`];
});

// 8j) /compact is fire-and-forget: its notice arrives fast, never blocking the socket ~47s
await test('compact is non-blocking (fast notice)', async () => {
  const dir = '/tmp/cany-cfast';
  const id = await createSession(dir);
  const a = await attach(id, (a) => a.send({ kind: 'prompt', text: 'Say hi.' }));
  await a.waitText(/\w/, 15000);
  for (let i = 0; i < 20; i++) { await sleep(500); if (a.msgs().some((m) => m.type === 'status' && m.status === 'idle')) break; }
  const t0 = Date.now();
  a.send({ kind: 'command', name: 'compact' });
  const notice = await a.waitFrame((f) => f.kind === 'notice' && /[Cc]ompact/.test(f.message), 5000);
  const ms = Date.now() - t0;
  a.close();
  await delSession(id, dir);
  return [!!notice && ms < 4000, notice ? `notice in ${ms}ms (was ~47s blocking)` : `no notice in ${ms}ms`];
});

// 8k) rapid-fire prompts keep their send order (broker spaces them; opencode reorders <~250ms)
await test('rapid prompts stay ordered', async () => {
  const dir = '/tmp/cany-order';
  const id = await createSession(dir);
  const a = await attach(id);
  await sleep(800);
  a.send({ kind: 'prompt', text: 'AAA first' });
  a.send({ kind: 'prompt', text: 'BBB second' });
  a.send({ kind: 'prompt', text: 'CCC third' });
  await sleep(4000);
  const list = await (await fetch(`${OC}/session/${id}/message?directory=${encodeURIComponent(dir)}`)).json();
  const order = list
    .filter((m: any) => m.info.role === 'user')
    .map((m: any) => {
      const t = (m.parts || []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('');
      return /AAA/.test(t) ? 'A' : /BBB/.test(t) ? 'B' : /CCC/.test(t) ? 'C' : '?';
    })
    .join('');
  a.close();
  await delSession(id, dir);
  return [order === 'ABC', `creation order: ${order}`];
});

// 9) tool-call rendering enrichment (bash carries title + exitCode)
await test('tool result enrichment (bash title + exitCode)', async () => {
  const dir = '/tmp/cany-tool';
  const id = await createSession(dir);
  const a = await attach(id, (a) =>
    a.send({ kind: 'prompt', text: 'Use your bash tool to run exactly this command and nothing else: echo hi-from-test' }),
  );
  await a.waitMsg((m) => m.type === 'tool-result' && m.toolName === 'bash', 25000);
  await sleep(3000); // let the final completed frame (which carries exit) arrive
  const bashes = a.msgs().filter((m) => m.type === 'tool-result' && m.toolName === 'bash');
  const bash = bashes[bashes.length - 1];
  a.close();
  await delSession(id, dir);
  // The mapping is deterministic; whether the model calls bash is not — skip if it didn't.
  if (!bash) return ['skip', 'model did not call the bash tool this run'];
  return [!!bash.title && bash.exitCode != null, `title=${JSON.stringify(bash.title)} exit=${bash.exitCode}`];
});

// ── Model-in-the-loop file IO (the AGENT's half of the pipeline — not stubbed) ────────────────
// The earlier file tests only proved the broker half (inbox bytes, or a file the TEST dropped in
// the outbox). These drive the real model end-to-end, so a sandboxed read or a missing send
// affordance can no longer pass green. Run with the filesystem MCP DISABLED (native tools only).

// MIL-1) upload → the agent actually READS the uploaded file and can quote its contents
await test('upload → agent reads & quotes the file (model)', async () => {
  const dir = '/tmp/cany-mil-read';
  const id = await createSession(dir);
  const a = await attach(id);
  await sleep(800);
  const token = 'READ-TOKEN-7788';
  a.send({ kind: 'file', name: 'note.txt', mimeType: 'text/plain', data: Buffer.from(token).toString('base64') });
  await sleep(1200);
  a.send({ kind: 'prompt', text: 'Read the file I just sent and reply with its exact contents.' });
  let ok = false;
  for (let i = 0; i < 120 && !ok; i++) {
    await sleep(500);
    ok =
      a.msgs().some((m) => m.type === 'tool-result' && m.toolName === 'read' && String(m.result ?? '').includes(token)) ||
      a.assistantText().includes(token);
  }
  a.close();
  await delSession(id, dir);
  return [ok, ok ? 'agent read the uploaded file & saw its content' : 'agent could not read the upload'];
});

// MIL-2) agent writes a deliverable-type file → broker auto-surfaces it as an artifact (any model)
await test('agent writes a deliverable → auto-surfaced as artifact', async () => {
  const dir = '/tmp/cany-mil-write';
  const id = await createSession(dir);
  const token = 'ARTIFACT-5566';
  const a = await attach(id, (x) =>
    x.send({ kind: 'prompt', text: `Use your write tool to create a file named report.md whose entire content is exactly: ${token}` }),
  );
  const art = await a.waitMsg((m) => m.type === 'file-artifact' && /report\.md/.test(m.name || ''), 60000);
  a.close();
  await delSession(id, dir);
  const body = art?.url ? Buffer.from(String(art.url).split(',')[1] || '', 'base64').toString() : '';
  return [!!art && body.includes(token), art ? `artifact ${art.name}, contentMatch=${body.includes(token)}` : 'no artifact surfaced'];
});

// MIL-3) explicit send_file tool: a NON-deliverable file (.bin) reaches the app only via the tool
await test('send_file tool delivers a file the agent sends (model)', async () => {
  const dir = '/tmp/cany-mil-sendfile';
  const id = await createSession(dir);
  writeFileSync(`${dir}/payload.bin`, 'EXPLICIT-9001'); // .bin ∉ deliverable set → only send_file can deliver it
  const a = await attach(id, (x) =>
    x.send({ kind: 'prompt', text: 'Call the tool named send_file with argument path="payload.bin". Use ONLY that tool; do not glob, read, or list.' }),
  );
  const art = await a.waitMsg((m) => m.type === 'file-artifact' && /payload\.bin/.test(m.name || ''), 60000);
  const called = a.msgs().some((m) => m.type === 'tool-call' && m.toolName === 'send_file');
  a.close();
  await delSession(id, dir);
  if (!called && !art) return ['skip', 'model did not invoke send_file this run'];
  return [!!art, art ? `send_file delivered ${art.name}` : 'send_file called but no artifact surfaced'];
});

// MIL-4) HTML artifact is self-contained: a local <img src> is inlined as a data-URI by the broker
// (deterministic — bundling is broker logic; surfaced via the send_file endpoint, no model needed)
await test('HTML artifact is self-contained (local image inlined)', async () => {
  const dir = '/tmp/cany-mil-bundle';
  const id = await createSession(dir);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  writeFileSync(`${dir}/pic.png`, Buffer.from(png, 'base64'));
  writeFileSync(`${dir}/report.html`, '<html><body><h1>Report</h1><img src="pic.png"><img src="./pic.png"></body></html>');
  const a = await attach(id);
  await sleep(800);
  const r = await fetch(`${BROKER}/api/tool/send_file`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionID: id, path: `${dir}/report.html`, tool: 'opencode' }),
  });
  const okPost = r.ok;
  const art = await a.waitMsg((m) => m.type === 'file-artifact' && /report\.html/.test(m.name || ''), 8000);
  a.close();
  await delSession(id, dir);
  const html = art?.url ? Buffer.from(String(art.url).split(',')[1] || '', 'base64').toString() : '';
  const inlined = html.includes('data:image/png;base64,');
  const noRawRef = !/src=["']\.?\/?pic\.png["']/.test(html);
  return [okPost && !!art && inlined && noRawRef, art ? `inlined=${inlined} rawRefGone=${noRawRef}` : 'no html artifact'];
});

// MIL-5) a failing/unreachable API surfaces as a retry WARNING (running+detail), not silent idle.
// Deterministic: a throwaway project opencode.json points a provider at a dead port → connection
// retries. Covers connection refused AND 429 rate-limits (same opencode retry mechanism).
await test('API failure surfaces as a retry warning (not silent idle)', async () => {
  const dir = '/tmp/cany-retry-test';
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    `${dir}/opencode.json`,
    JSON.stringify({
      provider: {
        deadprov: { npm: '@ai-sdk/openai-compatible', name: 'Dead', options: { baseURL: 'http://127.0.0.1:59999/v1', apiKey: 'x' }, models: { deadmodel: { name: 'Dead' } } },
      },
    }),
  );
  const id = (await (await fetch(`${OC}/session?directory=${encodeURIComponent(dir)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'retrytest', model: { id: 'deadmodel', providerID: 'deadprov' } }),
  })).json()).id;
  const a = await attach(id, (x) => x.send({ kind: 'prompt', text: 'hello' }));
  const warn = await a.waitMsg((m) => m.type === 'status' && m.status === 'running' && /retry|connect|rate/i.test(m.detail || ''), 20000);
  a.close();
  await delSession(id, dir);
  return [!!warn, warn ? `surfaced: ${String(warn.detail).slice(0, 48)}` : 'no retry warning (silent)'];
});

// MIL-6) multi-file + file+prompt in ONE turn: both attachments reach the agent, it reads both,
// and the user sees a SINGLE turn (not one per file).
await test('multi-file attachment + prompt (one turn)', async () => {
  const dir = '/tmp/cany-mil-attach';
  const id = await createSession(dir);
  const a = await attach(id);
  await sleep(800);
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  a.send({
    kind: 'prompt',
    clientMessageId: `mil-files-${Date.now()}`,
    text: 'Read both attached files and reply with their contents.',
    files: [
      { name: 'a.txt', mimeType: 'text/plain', data: b64('ALPHA111') },
      { name: 'b.txt', mimeType: 'text/plain', data: b64('BETA222') },
    ],
  });
  let ok = false;
  for (let i = 0; i < 120 && !ok; i++) {
    await sleep(500);
    const reads = a.msgs().filter((m) => m.type === 'tool-result' && m.toolName === 'read').map((m) => String(m.result ?? '')).join(' ');
    ok = /ALPHA111/.test(reads) && /BETA222/.test(reads);
  }
  const echoes = a.msgs().filter((m) => m.type === 'user-message').length;
  a.close();
  await delSession(id, dir);
  return [ok && echoes === 1, ok ? `both read; userTurns=${echoes}` : 'agent did not read both attachments'];
});

const failed = results.filter((r) => r.status === 'fail').length;
const passed = results.filter((r) => r.status === 'pass').length;
const skipped = results.filter((r) => r.status === 'skip').length;
console.log(`\n${passed} passed, ${skipped} skipped, ${failed} failed`);
process.exit(failed ? 1 : 0);
