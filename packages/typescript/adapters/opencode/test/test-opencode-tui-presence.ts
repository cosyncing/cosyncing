#!/usr/bin/env bun
/**
 * PERMANENT guard for the OpenCode synced badge (issues-part2 follow-up: "does not display the
 * synced status when it is completely in sync").
 *
 * The serve exposes NO client-presence surface (verified 1.17.18 — see tui-presence.ts), so the
 * badge is proven from the OS: a live `opencode attach <our-url> -s <id>` process. These checks run
 * the real scanner against a FAKE /proc tree (injectable root), so they cover the parsing/attribution
 * contract — including CARDINALITY (two TUIs ⇒ two distinct ids), per the sync-test lessons — without
 * needing a real TUI. The live join/leave flip is covered by the real-TUI trace
 * (scripts/broker/tests_traces/opencode-tui-presence-trace.ts).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  attachSessionIdsFromArgv,
  attachedTuiSessions,
  resetTuiPresenceCache,
  scanAttachedTuiSessions,
  tuiPresenceSupported,
} from '../src/tui-presence.ts';
import { opencodeControlState } from '../src/index.ts';

let failures = 0;
const check = (label: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  — ${extra}` : ''}`);
  if (!ok) failures++;
};

const PROC = join(process.env.COSYNCING_TEST_TMP ?? '/tmp', `cosyncing-fake-proc-${process.pid}`);
rmSync(PROC, { recursive: true, force: true });
const addProc = (pid: number, argv: string[] | string) => {
  mkdirSync(join(PROC, String(pid)), { recursive: true });
  const raw = typeof argv === 'string' ? argv : argv.join('\0') + '\0';
  writeFileSync(join(PROC, String(pid), 'cmdline'), raw);
};

// ── argv parsing contract ──────────────────────────────────────────────────────
check('`-s <id>` on a matching loopback URL is attributed',
  attachSessionIdsFromArgv(['opencode', 'attach', 'http://127.0.0.1:4096', '-s', 'ses_a'], '4096').join() === 'ses_a');
check('`--session=<id>` form is attributed',
  attachSessionIdsFromArgv(['opencode', 'attach', 'http://localhost:4096', '--session=ses_b'], '4096').join() === 'ses_b');
check('a DIFFERENT port never lights our badge',
  attachSessionIdsFromArgv(['opencode', 'attach', 'http://127.0.0.1:9999', '-s', 'ses_a'], '4096').length === 0);
check('a NON-LOOPBACK host never lights our badge (another machine\'s :4096)',
  attachSessionIdsFromArgv(['opencode', 'attach', 'http://10.0.0.5:4096', '-s', 'ses_a'], '4096').length === 0);
check('no `attach` verb (serve/run/etc.) is never attributed',
  attachSessionIdsFromArgv(['opencode', 'run', 'http://127.0.0.1:4096', '-s', 'ses_a'], '4096').length === 0);
check('bare attach (no -s/--session) is ignored — under-claim by design',
  attachSessionIdsFromArgv(['opencode', 'attach', 'http://127.0.0.1:4096', '--continue'], '4096').length === 0);
check('malformed `-s <flag>` is not attributed',
  attachSessionIdsFromArgv(['opencode', 'attach', 'http://127.0.0.1:4096', '-s', '--dir'], '4096').length === 0);

// ── /proc scan: cardinality + fault isolation ─────────────────────────────────
{
  addProc(101, ['opencode', 'attach', 'http://127.0.0.1:4096', '-s', 'ses_one', '--dir', '/tmp/w']);
  addProc(102, ['opencode', 'attach', 'http://127.0.0.1:4096', '--session=ses_two']);
  addProc(103, ['sh', '-c', 'opencode attach http://127.0.0.1:4096 -s ses_one']); // tmux wrapper line: single token, NOT double-counted
  addProc(104, ['opencode', 'attach', 'http://127.0.0.1:5555', '-s', 'ses_other_serve']);
  addProc(105, ['vim', 'notes-about-opencode-attach.md']);
  mkdirSync(join(PROC, '106'), { recursive: true }); // exited mid-scan: dir with no readable cmdline
  const got = scanAttachedTuiSessions('4096', PROC);
  check('TWO attached TUIs ⇒ TWO distinct session ids (cardinality, not presence)',
    got.size === 2 && got.has('ses_one') && got.has('ses_two'), `got=${[...got].join(',')}`);
  check('shell-wrapper cmdline (single token) does not double- or mis-count', !got.has('sh'), '');
  check('a dead/unreadable proc entry is skipped, not fatal', true); // reaching here proves no throw
}

// ── TTL cache behavior ─────────────────────────────────────────────────────────
{
  resetTuiPresenceCache();
  const first = attachedTuiSessions('http://127.0.0.1:4096', PROC);
  addProc(107, ['opencode', 'attach', 'http://127.0.0.1:4096', '-s', 'ses_three']);
  const cached = attachedTuiSessions('http://127.0.0.1:4096', PROC);
  check('within the TTL the scan is amortized (same snapshot back)', cached === first);
  resetTuiPresenceCache();
  const fresh = attachedTuiSessions('http://127.0.0.1:4096', PROC);
  check('after the TTL a new join is picked up', fresh.has('ses_three'), `got=${[...fresh].join(',')}`);
}

// ── platform / remote-serve gating ─────────────────────────────────────────────
check('loopback serve on linux is supported', tuiPresenceSupported('http://127.0.0.1:4096', 'linux'));
check('non-linux platform under-claims (badge never lights, never lies)', !tuiPresenceSupported('http://127.0.0.1:4096', 'darwin'));
check('remote serve under-claims (cannot pair with a remote machine\'s /proc)', !tuiPresenceSupported('http://build-box:4096', 'linux'));

// ── control-state projection ───────────────────────────────────────────────────
{
  const hint = { label: 'Sync with your terminal (optional)', command: 'opencode attach http://127.0.0.1:4096 -s ses_x' };
  const active = opencodeControlState(hint, true).terminalSync;
  const idle = opencodeControlState(hint, false).terminalSync;
  check('attached ⇒ active:true, synced label, join command dropped',
    active.active === true && active.syncAvailable === true && !('command' in active && active.command) && /Synced/i.test(active.label ?? ''));
  check('not attached ⇒ active:false with the join command still advertised',
    idle.active === false && idle.syncAvailable === true && idle.command === hint.command);
}

rmSync(PROC, { recursive: true, force: true });
console.log(failures ? `\nFAIL: ${failures} check(s) failed.` : '\nAll opencode tui-presence checks passed.');
process.exit(failures ? 1 : 0);
