#!/usr/bin/env bun
/**
 * Coexistence test — AGENT-DRIVEN harness (answers maintainer's "can an agent run the TUI test?").
 *
 * Drives the Claude Code TUI in a detached **tmux** session (send-keys + capture-pane) and our channel
 * socket (the co-client), so the whole local test runs without a human:
 *   1. launch claude (installed-plugin channel + dev-flag override, cheap haiku) in /tmp/coexist-test
 *   2. accept the folder-trust / dev-channel prompts (send-keys)
 *   3. [--coexist] type `/remote-control` to also attach claude.ai's cse_ bridge (it's a TTY slash command)
 *   4. type a task that needs approval (`sudo ls /root`)
 *   5. our socket co-client receives the permission_request and sends `allow`
 *   6. capture-pane to verify the TTY permission prompt CLEARED → reply honored (PASS) or persisted (FAIL)
 *
 * This needs an allowlist rule so the auto-mode classifier permits it (an agent auto-approving permissions):
 *   add  "Bash(bun run scripts/broker/coexistence-test/auto-drive.ts:*)"  to .claude/settings.local.json → permissions.allow
 *
 * Usage:  bun run scripts/broker/coexistence-test/auto-drive.ts [--coexist] [--model haiku] [--keep]
 *   --coexist : also send `/remote-control` (full coexistence: our channel + claude.ai cse_ both attached)
 *   --keep    : leave the tmux session + /tmp/coexist-test for inspection
 * Logs to ~/.claude/cosyncing/bridge/auto-drive.log and prints PASS/FAIL.
 */
import { connect } from 'node:net';
import { readdirSync, statSync, rmSync, mkdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SESSION = 'coexist-auto';
// Dedicated dir — NOT the `/tmp/coexist-test` a manual launch-plugin.sh run uses, so this harness never
// rmSync's the cwd (or local-scope plugin install) out from under a live manual session.
const WORK = '/tmp/coexist-auto';
const REPO = join(import.meta.dir, '..', '..', '..');
const PLUGIN = join(REPO, 'packages', 'adapters', 'claude', 'plugin');
const BRIDGE = join(homedir(), '.claude', 'cosyncing', 'bridge');
const LOG = join(BRIDGE, 'auto-drive.log');
const args = process.argv.slice(2);
const COEXIST = args.includes('--coexist');
const KEEP = args.includes('--keep');
// The installed-plugin channel form is the PRODUCTION form; a manual run proved it spawns the server+socket
// WITHOUT the dev flag. `--dev` opts into `--dangerously-load-development-channels` to test that axis too.
const DEV = args.includes('--dev');
const MODEL = (args[args.indexOf('--model') + 1] && args.includes('--model')) ? args[args.indexOf('--model') + 1] : 'haiku';

const ts = () => new Date().toISOString();
function log(s: string): void { const l = `${ts()} ${s}`; console.log(l); try { mkdirSync(BRIDGE, { recursive: true }); appendFileSync(LOG, l + '\n'); } catch {} }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[()][AB0]/g, '').replace(/\x1b[>=]/g, '');

function tmux(...a: string[]): string {
  const p = Bun.spawnSync(['tmux', ...a]);
  return new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
}
const cap = () => stripAnsi(tmux('capture-pane', '-t', SESSION, '-p'));
function send(keys: string, enter = true): void { tmux('send-keys', '-t', SESSION, '--', keys); if (enter) tmux('send-keys', '-t', SESSION, 'Enter'); }
async function waitFor(pred: (t: string) => boolean, ms: number, label: string): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const t = cap(); if (pred(t)) { log(`✓ ${label}`); return true; } await sleep(800); }
  log(`✗ TIMEOUT waiting for ${label}`); return false;
}
const socksNow = () => { try { return new Set(readdirSync(BRIDGE).filter((f) => f.endsWith('.sock'))); } catch { return new Set<string>(); } };
// run a `claude plugin …` subcommand with cwd=WORK so local-scope records land in WORK/.claude
function claudePlugin(...a: string[]): string {
  const p = Bun.spawnSync(['claude', 'plugin', ...a], { cwd: WORK });
  return (new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr)).trim();
}
const lastLines = (s: string, n = 2) => s.split('\n').filter(Boolean).slice(-n).join(' | ');

let verdict = 'INCONCLUSIVE';
try {
  log(`=== auto-drive start (coexist=${COEXIST} model=${MODEL} dev=${DEV}) ===`);
  tmux('kill-session', '-t', SESSION); rmSync(WORK, { recursive: true, force: true }); mkdirSync(WORK, { recursive: true });

  // self-install the plugin at LOCAL scope into WORK (so WORK/.claude carries the channel). Idempotent:
  // marketplace-add may say "already exists"; that's fine. Enable it so the channel is loadable.
  log('installing plugin (local scope) into ' + WORK);
  log('  marketplace: ' + lastLines(claudePlugin('marketplace', 'add', PLUGIN, '--scope', 'local')));
  log('  install:     ' + lastLines(claudePlugin('install', 'cosyncing@cosyncing', '--scope', 'local')));
  log('  enable:      ' + lastLines(claudePlugin('enable', 'cosyncing@cosyncing')));

  const before = socksNow();
  const devFlag = DEV ? ' --dangerously-load-development-channels plugin:cosyncing@cosyncing' : '';
  tmux('new-session', '-d', '-s', SESSION, '-x', '220', '-y', '50');
  send(`cd ${WORK} && claude --model ${MODEL} --channels plugin:cosyncing@cosyncing${devFlag}`);

  // 1) accept startup prompts (dev-channel warning, folder trust) until the IDLE input box is ready.
  //    NB: `❯` is NOT a readiness signal — it also fronts the dev-channel menu (`❯ 1. I am using…`).
  //    The idle box is identified by "for shortcuts" / the "Try …" placeholder AND no live menu.
  const enter = () => tmux('send-keys', '-t', SESSION, 'Enter');
  const MENU = /Enter to confirm|Enter to continue|Do you want to trust|trust the files|Loading development channels|local development|❯\s*1\.\s*(I am using|Yes)/i;
  const READY = (t: string) => /for shortcuts|Try "|Welcome back/i.test(t);
  let ready = false;
  const answered = new Set<string>();
  for (let i = 0; i < 45 && !ready; i++) {
    await sleep(1000);
    const t = cap();
    if (MENU.test(t)) {
      const kind = /development|local development/i.test(t) ? 'dev-channel' : /trust/i.test(t) ? 'folder-trust' : 'menu';
      if (!answered.has(kind)) { log(`… accepting startup menu: ${kind} (Enter on highlighted default)`); enter(); answered.add(kind); await sleep(1500); }
      continue;
    }
    if (READY(t)) { ready = true; break; }
  }
  log(ready ? '✓ claude TUI ready (idle input box)' : '✗ TUI not ready — pane follows');
  if (!ready) { log(cap()); throw new Error('startup'); }

  // 2) find the NEW bridge socket and attach as a co-client
  let sockPath = '';
  for (let i = 0; i < 25 && !sockPath; i++) { const cur = socksNow(); for (const s of cur) if (!before.has(s)) sockPath = join(BRIDGE, s); if (!sockPath) await sleep(700); }
  if (!sockPath) { log('✗ no new bridge socket — channel did not load. Pane (look for "approved channels allowlist"):\n' + cap()); throw new Error('no new bridge socket appeared (channel did not load)'); }
  log(`✓ new bridge socket: ${sockPath}`);
  // SAFETY: this harness is a SCOPED approver, not a blanket auto-approver. It ALLOWS only the one expected
  // test command and DENIES anything else, so a misbehaving nested agent can't get a free yes-loop.
  const EXPECT = 'sudo ls /root';
  let allowed = false, sawPermission = false;
  const sock = connect(sockPath);
  let buf = '';
  sock.on('data', (b: Buffer) => {
    buf += b.toString('utf8'); let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const ln = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!ln) continue;
      log('SOCKET<= ' + ln);
      try {
        const o = JSON.parse(ln);
        if (o.type === 'permission_request' && o.request_id) {
          const pv = String(o.input_preview ?? '');
          if (pv.includes(EXPECT)) { sawPermission = true; allowed = true; sock.write(JSON.stringify({ type: 'permission', request_id: o.request_id, behavior: 'allow' }) + '\n'); log(`→ ALLOW (expected) ${o.request_id}`); }
          else { sock.write(JSON.stringify({ type: 'permission', request_id: o.request_id, behavior: 'deny' }) + '\n'); log(`→ DENY (unexpected) ${o.request_id}: ${pv.slice(0, 80)}`); }
        }
      } catch {}
    }
  });
  sock.on('error', (e) => log('socket error ' + e));
  await sleep(500);

  // 3) optional: attach claude.ai cse_ bridge via the /remote-control slash command (TTY, no web step)
  if (COEXIST) { send('/remote-control'); await waitFor((t) => /remote-control is active/i.test(t), 15000, 'cse_ remote-control active'); }

  // 4) trigger a permission-gated tool
  send('Use Bash to run: sudo ls /root');
  await waitFor((t) => /Do you want to proceed|requires approval/i.test(t), 30000, 'permission prompt shown in TUI');

  // 5) our channel allow should clear it (give it time after allow)
  await waitFor(() => allowed, 10000, 'permission_request received + allow sent over our channel');
  const cleared = await waitFor((t) => !/Do you want to proceed|requires approval/i.test(t), 25000, 'TTY permission prompt CLEARED after our allow');

  verdict = cleared && sawPermission && allowed ? 'PASS' : 'FAIL';
  log(`\n=== VERDICT: ${verdict} ===  (sawPermission=${sawPermission} allowed=${allowed} cleared=${cleared}${COEXIST ? ' coexist=yes' : ''})`);
  log('--- final pane ---\n' + cap());
  try { const u = sockPath.split('/').pop()!.replace('.sock', ''); log('--- bridge log tail ---\n' + Bun.spawnSync(['tail', '-8', join(BRIDGE, u + '.log')]).stdout.toString()); } catch {}
  sock.end();
} catch (e) {
  log('ERROR ' + String(e));
  verdict = 'ERROR';
} finally {
  if (!KEEP) { tmux('kill-session', '-t', SESSION); rmSync(WORK, { recursive: true, force: true }); }
  log(`auto-drive done: ${verdict}${KEEP ? ' (session/dir kept)' : ' (cleaned up)'}`);
  process.exit(verdict === 'PASS' ? 0 : 1);
}
