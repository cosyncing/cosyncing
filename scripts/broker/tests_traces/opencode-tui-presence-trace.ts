/**
 * OpenCode synced-badge presence trace (issues-part2 follow-up: "opencode does not display the
 * synced status when it is completely in sync" — pi flips its badge on bridge hello/shutdown;
 * opencode's serve exposes no client presence, so ours is proven from /proc, see tui-presence.ts).
 *
 * Drives the REAL flow with a REAL serve and a REAL `opencode attach` TUI in tmux — no prompts, no
 * model turns, zero cost:
 *
 *   P1 fresh session advertises sync AVAILABLE, not active (join command present)
 *   P2 TUI joins via the ADVERTISED command verbatim → attached client receives a session frame with
 *      terminalSync.active === true (the synced badge), within a poll-tick bound
 *   P3 attribution is EXACT: the roster lights ONLY this session's row (a second created session
 *      stays active:false — cardinality, not presence)
 *   P4 terminal closes (tmux kill = no goodbye handshake) → active flips back false within bound
 *
 * Requirements: real `opencode` + `tmux` on PATH (else SKIP). Isolated broker on a random port with
 * its own managed serve (OPENCODE_URL pinned to a random port) — production is untouched.
 *
 *   bun run scripts/broker/tests_traces/opencode-tui-presence-trace.ts
 */
export {};
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const PORT = Number(process.env.COSYNCING_TEST_PORT ?? 26000 + Math.floor(Math.random() * 20000));
const OCPORT = PORT + 1;
const BROKER = `http://127.0.0.1:${PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const TMUX = `octuipresence${PORT}`;
const DIR = `/tmp/cosyncing-opencode-tui-presence-${PORT}`;
mkdirSync(DIR, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

function have(cmd: string): boolean {
  try { execSync(`command -v ${cmd}`, { stdio: 'ignore' }); return true; } catch { return false; }
}
if (!have('opencode') || !have('tmux')) {
  console.log('SKIP: real `opencode` and `tmux` are required for this trace.');
  process.exit(0);
}
if (process.platform !== 'linux') {
  console.log('SKIP: TUI presence is /proc-based (linux only); the badge intentionally never lights elsewhere.');
  process.exit(0);
}

function attach(id: string): Promise<{ frames: any[]; close: () => void }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WSBASE}/api/sessions/opencode/${encodeURIComponent(id)}/stream`);
    const frames: any[] = [];
    ws.onmessage = (e) => { try { frames.push(JSON.parse(String(e.data))); } catch {} };
    ws.onopen = () => resolve({ frames, close: () => ws.close() });
  });
}
async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(300); }
  return pred();
}
const lastSync = (frames: any[]): any => {
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    if (f.kind === 'session' && f.info?.control?.terminalSync) return f.info.control.terminalSync;
  }
  return undefined;
};

const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    OPENCODE_URL: `http://127.0.0.1:${OCPORT}`,
    COSYNCING_CODEX_SYNC_SERVER: '0',
  },
  stdout: 'pipe',
  stderr: 'pipe',
});
try {
  const healthy = await (async () => {
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      try { const r = await fetch(`${BROKER}/api/broker/health`); if (r.ok) return true; } catch {}
      await sleep(500);
    }
    return false;
  })();
  if (!healthy) throw new Error('isolated broker did not start');

  // The managed serve boots asynchronously — retry create until it answers.
  const create = async (title: string): Promise<any> => {
    const end = Date.now() + 45000;
    for (;;) {
      const r = await fetch(`${BROKER}/api/sessions/opencode`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ directory: DIR, title }),
      }).catch(() => undefined);
      if (r?.ok) {
        const d: any = await r.json();
        if (d?.session?.id) return d.session;
      }
      if (Date.now() > end) throw new Error(`create '${title}' failed: ${r ? await r.text().catch(() => r.status) : 'unreachable'}`);
      await sleep(1500);
    }
  };
  const session = await create('OC-TUI-PRESENCE-TRACE (safe to delete)');
  const control = await create('OC-TUI-PRESENCE-CONTROL (safe to delete)'); // must stay unsynced (P3)
  const syncCmd: string = session?.control?.terminalSync?.command ?? '';
  if (!syncCmd) throw new Error('no advertised sync command on the created session');

  const c1 = await attach(session.id);
  await waitFor(() => !!lastSync(c1.frames), 15000);
  const initial = lastSync(c1.frames);
  check('P1 fresh session: sync AVAILABLE, not active, join command advertised',
    initial?.syncAvailable === true && initial?.active === false && !!initial?.command,
    JSON.stringify({ active: initial?.active, cmd: !!initial?.command }));

  // TUI joins via the ADVERTISED command verbatim
  try { execSync(`tmux kill-session -t ${TMUX} 2>/dev/null`); } catch {}
  const joinedAt = Date.now();
  execSync(`tmux new-session -d -s ${TMUX} -c '${DIR}' "${syncCmd.replace(/"/g, '\\"')}"`);
  const joined = await waitFor(() => lastSync(c1.frames)?.active === true, 20000);
  check('P2 TUI join flips the attached client to Synced (badge on)', joined,
    joined ? `after ${((Date.now() - joinedAt) / 1000).toFixed(1)}s` : `last=${JSON.stringify(lastSync(c1.frames))}`);

  // P3 exact attribution on the roster
  const roster: any = await (await fetch(`${BROKER}/api/sessions`)).json();
  const rows: any[] = (Array.isArray(roster) ? roster : roster.sessions ?? []).filter((s: any) => s.tool === 'opencode');
  const mine = rows.find((s: any) => s.id === session.id);
  const other = rows.find((s: any) => s.id === control.id);
  check('P3 roster lights ONLY the attached session (control row stays unsynced)',
    mine?.control?.terminalSync?.active === true && other?.control?.terminalSync?.active === false,
    `mine=${mine?.control?.terminalSync?.active} control=${other?.control?.terminalSync?.active}`);

  // P4 terminal closes with NO goodbye handshake (tmux kill) → badge must drop from the OS truth
  const leftAt = Date.now();
  try { execSync(`tmux kill-session -t ${TMUX}`); } catch {}
  const left = await waitFor(() => lastSync(c1.frames)?.active === false, 20000);
  check('P4 TUI exit flips the badge back off (kill -9-safe, no bye needed)', left,
    left ? `after ${((Date.now() - leftAt) / 1000).toFixed(1)}s` : `last=${JSON.stringify(lastSync(c1.frames))}`);
  c1.close();
} catch (error) {
  check('trace ran to completion', false, String(error).slice(0, 300));
} finally {
  try { execSync(`tmux kill-session -t ${TMUX} 2>/dev/null`); } catch {}
  broker.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\nFAIL: ${failed.length}/${results.length}` : `\n${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
