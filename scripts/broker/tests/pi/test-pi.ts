/**
 * Integration tests for the Pi adapter (observe-first, explicit Drive via resume).
 * Creates a THROWAWAY Pi session (never touches real ~/.pi sessions under real cwds) on the free
 * default model, drives it through the broker WebSocket, and checks the capability matrix:
 *   1. observe attach + history replay
 *   2. observe attach rejects input until Drive
 *   3. Drive/resume user-message echo for a LIVE prompt (Pi emits no echo event → adapter does it)
 *   3. token streaming (model-output deltas) + working→idle status
 *   4. file upload → <cwd>/.cosyncing/inbox (byte-exact)
 *   5. agent→user outbox file → file-artifact (universal Hub watcher)
 *   6. detach evicts + kills the spawned `pi` process (no leak)
 *
 *   BROKER=http://127.0.0.1:7734 bun run scripts/broker/test-pi.ts
 * Exit 0 = all pass. Requires a running broker + `pi` on PATH (free vllm default model).
 */
export {};
import { mkdirSync, rmSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const BROKER = process.env.BROKER ?? 'http://127.0.0.1:7734';
const SESSIONS_ROOT = join(homedir(), '.pi', 'agent', 'sessions');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = () => Math.random().toString(36).slice(2, 8);

/** Seed a throwaway Pi session in a fresh /tmp dir; returns {dir, sessionFile, encDir, sessionId}.
 *  Dir name is dash-FREE on purpose: Pi encodes cwd as `--a-b-c--` (/ -> -) and the adapter decodes
 *  - -> /, which is lossy on real dashes — a dash-free dir round-trips cleanly. */
async function seedSession(): Promise<{ dir: string; file: string; encDir: string; id: string }> {
  const dir = `/tmp/pitest${rand()}`;
  mkdirSync(dir, { recursive: true });
  const proc = Bun.spawn(['pi', '-p', '-n', 'citest', 'Reply with exactly: PISEED'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  await proc.exited;
  // session lands under ~/.pi/agent/sessions/--<encoded-dir>--/<iso>_<uuid>.jsonl
  const encDir = '--' + dir.slice(1).replace(/\//g, '-') + '--'; // /tmp/pitestX -> --tmp-pitestX--
  const realDir = join(SESSIONS_ROOT, encDir);
  const file = join(realDir, readdirSync(realDir).find((f) => f.endsWith('.jsonl'))!);
  return { dir, file, encDir, id: Buffer.from(file, 'utf8').toString('base64url') };
}
function cleanup(s: { dir: string; encDir: string }) {
  try { rmSync(s.dir, { recursive: true, force: true }); } catch {}
  try { rmSync(join(SESSIONS_ROOT, s.encDir), { recursive: true, force: true }); } catch {}
}

interface A { send: (o: any) => void; frames: any[]; msgs: () => any[]; assistantText: () => string; waitMsg: (p: (m: any) => boolean, ms: number) => Promise<any>; close: () => void; }
function attach(id: string, mode?: 'observe' | 'resume'): Promise<A> {
  return new Promise((resolve) => {
    const qs = mode ? `?mode=${encodeURIComponent(mode)}` : '';
    const ws = new WebSocket(`${BROKER.replace(/^http/, 'ws')}/api/sessions/pi/${encodeURIComponent(id)}/stream${qs}`);
    const frames: any[] = [];
    const assistantText = () => {
      const by = new Map<string, string>();
      for (const f of frames) if (f.kind === 'message' && f.message?.type === 'model-output') {
        const k = f.message.key || '_';
        by.set(k, f.message.text != null ? f.message.text : (by.get(k) || '') + (f.message.delta || ''));
      }
      return [...by.values()].join('');
    };
    const a: A = {
      send: (o) => ws.send(JSON.stringify(o)),
      frames,
      msgs: () => frames.filter((f) => f.kind === 'message').map((f) => f.message),
      assistantText,
      waitMsg: async (pred, ms) => { const end = Date.now() + ms; for (;;) { const h = frames.filter((f) => f.kind === 'message').map((f) => f.message).find(pred); if (h) return h; if (Date.now() > end) return undefined; await sleep(150); } },
      close: () => { try { ws.close(); } catch {} },
    };
    ws.onmessage = (e) => { try { frames.push(JSON.parse(String(e.data))); } catch {} };
    ws.onopen = () => resolve(a);
  });
}

const results: { name: string; status: 'pass' | 'fail' | 'skip'; detail: string }[] = [];
async function test(name: string, fn: () => Promise<[boolean | 'skip', string]>) {
  process.stdout.write(`• ${name} … `);
  try { const [ok, d] = await fn(); const s = ok === 'skip' ? 'skip' : ok ? 'pass' : 'fail'; results.push({ name, status: s, detail: d }); console.log(`${s.toUpperCase()}  ${d}`); }
  catch (e) { results.push({ name, status: 'fail', detail: String(e) }); console.log('FAIL  threw: ' + e); }
}

// roster discovery
await test('roster lists pi sessions', async () => {
  const d = await (await fetch(`${BROKER}/api/sessions`)).json();
  const pi = (d.sessions || []).filter((s: any) => s.tool === 'pi');
  return [pi.length > 0, `${pi.length} pi sessions`];
});

// one throwaway session drives the rest
const s = await seedSession();
try {
  await test('attach + history replay (seed)', async () => {
    const a = await attach(s.id);
    await sleep(2500);
    const hist = a.frames.find((f) => f.kind === 'history');
    const info = a.frames.find((f) => f.kind === 'session')?.info;
    a.close();
    const seed = JSON.stringify(hist?.messages || []).includes('PISEED');
    return [!!hist && seed && info?.attachMode === 'observe' && !!info?.control, `${(hist?.messages || []).length} messages, seed=${seed} attachMode=${info?.attachMode} control=${!!info?.control}`];
  });

  await test('observe attach rejects prompt until Drive', async () => {
    const a = await attach(s.id);
    await sleep(1500);
    a.frames.length = 0;
    a.send({ kind: 'prompt', text: 'Reply with exactly: SHOULD_NOT_RUN' });
    for (let i = 0; i < 12; i++) { await sleep(250); if (a.frames.some((f) => f.kind === 'error')) break; }
    const err = a.frames.find((f) => f.kind === 'error')?.message || '';
    a.close();
    return [/read-only/i.test(err), err || 'no error frame'];
  });

  await test('live prompt: user echo + streaming + idle', async () => {
    const a = await attach(s.id, 'resume');
    await sleep(2000);
    a.frames.length = 0;
    a.send({ kind: 'prompt', text: 'Reply with exactly: PONGPI' });
    let idle = false;
    for (let i = 0; i < 60; i++) { await sleep(500); if (a.msgs().some((m) => m.type === 'status' && m.status === 'idle')) { idle = true; break; } }
    const echo = a.msgs().some((m) => m.type === 'user-message' && /PONGPI/.test(m.text || ''));
    const deltas = a.msgs().filter((m) => m.type === 'model-output' && m.delta != null).length;
    const replied = /PONGPI/.test(a.assistantText());
    a.close();
    return [echo && replied && idle, `echo=${echo} replied=${replied} idle=${idle} deltas=${deltas}`];
  });

  await test('file upload → inbox (byte-exact)', async () => {
    const a = await attach(s.id, 'resume');
    await sleep(2000);
    const data = Buffer.from('PI-UPLOAD-CONTENT-42').toString('base64');
    a.send({
      kind: 'file',
      clientMessageId: `pi-file-${Date.now()}`,
      name: 'note.txt',
      mimeType: 'text/plain',
      data,
    });
    let ok = false;
    for (let i = 0; i < 16; i++) { await sleep(500); try { if (existsSync(join(s.dir, '.cosyncing', 'inbox', 'note.txt'))) { ok = true; break; } } catch {} }
    a.close();
    const content = ok ? await Bun.file(join(s.dir, '.cosyncing', 'inbox', 'note.txt')).text() : '';
    return [ok && content === 'PI-UPLOAD-CONTENT-42', ok ? `inbox written, content matches=${content === 'PI-UPLOAD-CONTENT-42'}` : 'no inbox file'];
  });

  await test('agent→user outbox file → artifact', async () => {
    const a = await attach(s.id);
    await sleep(1500);
    const ob = join(s.dir, '.cosyncing', 'outbox');
    mkdirSync(ob, { recursive: true });
    writeFileSync(join(ob, 'out.txt'), 'from pi');
    const art = await a.waitMsg((m) => m.type === 'file-artifact' && /out\.txt/.test(m.name || ''), 8000);
    a.close();
    return [!!art && !!art.url, art ? `artifact ${art.name} inline=${!!art.url}` : 'no artifact'];
  });

  await test('multi-turn streaming keys are distinct (no bubble collapse)', async () => {
    const a = await attach(s.id, 'resume');
    await sleep(2000);
    const keys = new Set<string>();
    for (const t of ['Reply with exactly: K1', 'Reply with exactly: K2']) {
      a.frames.length = 0;
      a.send({ kind: 'prompt', text: t });
      for (let i = 0; i < 50; i++) { await sleep(500); if (a.msgs().some((m) => m.type === 'status' && m.status === 'idle')) break; }
      a.msgs().filter((m) => m.type === 'model-output' && m.key).forEach((m) => keys.add(m.key));
    }
    a.close();
    // Pi gives no message.id; without the per-turn key the two turns share one key and merge.
    return [keys.size >= 2, `distinct keys=${[...keys].join(',')}`];
  });

  await test('detach evicts the spawned pi process (no leak)', async () => {
    const a = await attach(s.id, 'resume');
    await sleep(1500);
    a.close();
    await sleep(18000); // grace (15s) + margin
    const ps = Bun.spawnSync(['pgrep', '-fa', 'pi --mode rpc']);
    const leaked = ps.stdout.toString().includes(s.file);
    return [!leaked, leaked ? 'pi process LEAKED after detach' : 'process evicted'];
  });
} finally {
  cleanup(s);
}

// CRITICAL regression: a HYPHENATED project dir must resolve the real cwd (was lossily decoded
// `-`→`/` → undefined → all file IO dead). Own throwaway session in a hyphenated dir.
{
  const dir = `/tmp/pi-hy-${rand()}`;
  mkdirSync(dir, { recursive: true });
  const proc = Bun.spawn(['pi', '-p', '-n', 'hytest', 'Reply with exactly: HYSEED'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  await proc.exited;
  const encDir = '--' + dir.slice(1).replace(/\//g, '-') + '--';
  const file = join(SESSIONS_ROOT, encDir, readdirSync(join(SESSIONS_ROOT, encDir)).find((f) => f.endsWith('.jsonl'))!);
  const id = Buffer.from(file, 'utf8').toString('base64url');
  try {
    await test('hyphenated cwd resolves + file IO works (cwd-from-JSONL)', async () => {
      const a = await attach(id, 'resume');
      await sleep(2000);
      const cwd = a.frames.find((f) => f.kind === 'session')?.info?.cwd;
      a.send({ kind: 'file', name: 'hy.txt', mimeType: 'text/plain', data: Buffer.from('HY-OK').toString('base64') });
      let landed = false;
      for (let i = 0; i < 16; i++) { await sleep(500); if (existsSync(join(dir, '.cosyncing', 'inbox', 'hy.txt'))) { landed = true; break; } }
      a.close();
      return [cwd === dir && landed, `cwd=${JSON.stringify(cwd)} uploadLanded=${landed}`];
    });
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    try { rmSync(join(SESSIONS_ROOT, encDir), { recursive: true, force: true }); } catch {}
  }
}

const failed = results.filter((r) => r.status === 'fail').length;
const passed = results.filter((r) => r.status === 'pass').length;
const skipped = results.filter((r) => r.status === 'skip').length;
console.log(`\n${passed} passed, ${skipped} skipped, ${failed} failed`);
process.exit(failed ? 1 : 0);
