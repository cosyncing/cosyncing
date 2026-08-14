/**
 * C5 serve-restart guardrail (2026-07-08). The broker owns the managed `opencode serve` and restarts it
 * when the config file is newer than the process (to load a newly-added provider/model). A naive restart
 * interrupts an in-flight turn; this guardrail DEFERS the restart while a turn is running, up to a
 * max-defer cap so a hung turn can't block new-model loading forever. Tests the pure decision function
 * `evaluateConfigRestart` across the four cases — no serve/process is spawned.
 *
 *   bun run packages/typescript/broker/test/broker/test-opencode-serve-restart-guardrail.ts
 */
export {};
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateConfigRestart, newestConfigMtime } from '../../../adapters/opencode/src/managed-server.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const startedAt = 1_000_000; // managed serve start mtime
const cap = 10 * 60_000; // 10 min max defer

// A full review-broker restart also owns the managed OpenCode server. It must not bypass the C5
// runtime guardrail and silently terminate an active model turn while leaving `opencode attach`
// alive. This checks the shipped restart workflow itself so deleting either the roster query or the
// pre-SIGTERM call is a deterministic regression.
{
  const script = readFileSync(join(import.meta.dir, '../../../../../scripts/dev/rebuild-restart-app.sh'), 'utf8');
  const stopStart = script.indexOf('stop_review_broker()');
  const stopEnd = script.indexOf('\nstart_review_broker()', stopStart);
  const stopBody = script.slice(stopStart, stopEnd);
  check(
    'review restart queries a fresh roster for active OpenCode turns',
    script.includes('/api/sessions?window=all&refresh=1')
      && script.includes('.tool == "opencode"')
      && script.includes('.status == "working" or .status == "needs-input"'),
  );
  check(
    'review restart fails closed before SIGTERM when active OpenCode proof is unavailable',
    script.includes('could not verify whether the broker owns an active OpenCode turn; refusing restart')
      && stopBody.indexOf('assert_no_active_opencode_turns') >= 0
      && stopBody.indexOf('assert_no_active_opencode_turns') < stopBody.indexOf('kill -TERM'),
  );
}

// 1. Config not newer than the running serve → no restart, pending cleared.
{
  const d = evaluateConfigRestart({ cfgMtime: startedAt - 5000, managedStartedAt: startedAt, pendingSince: 0, now: startedAt + 1000, busy: false, maxDeferMs: cap });
  check('config not newer → no restart, no pending', !d.restart && d.pendingSince === 0, JSON.stringify(d));
}

// 2. Config newer + serve IDLE → restart now.
{
  const d = evaluateConfigRestart({ cfgMtime: startedAt + 60_000, managedStartedAt: startedAt, pendingSince: 0, now: startedAt + 61_000, busy: false, maxDeferMs: cap });
  check('config newer + idle → restart now', d.restart === true, JSON.stringify(d));
}

// 3. Config newer + BUSY within the cap → DEFER (no restart), pending clock started.
{
  const now = startedAt + 61_000;
  const d = evaluateConfigRestart({ cfgMtime: startedAt + 60_000, managedStartedAt: startedAt, pendingSince: 0, now, busy: true, maxDeferMs: cap });
  check('config newer + busy (within cap) → defer, pending set', d.restart === false && d.pendingSince === now, JSON.stringify(d));
}

// 4. Deferral accumulates across ticks but stays deferred while busy under the cap.
{
  const pendingSince = startedAt + 61_000;
  const now = pendingSince + 5 * 60_000; // 5 min later, still under the 10-min cap
  const d = evaluateConfigRestart({ cfgMtime: startedAt + 60_000, managedStartedAt: startedAt, pendingSince, now, busy: true, maxDeferMs: cap });
  check('still busy under cap → keep deferring, same pending clock', d.restart === false && d.pendingSince === pendingSince && d.deferredMs === 5 * 60_000, JSON.stringify(d));
}

// 5. Busy but PAST the cap → restart anyway (a hung turn must not block new models forever).
{
  const pendingSince = startedAt + 61_000;
  const now = pendingSince + cap + 1000; // just past the cap
  const d = evaluateConfigRestart({ cfgMtime: startedAt + 60_000, managedStartedAt: startedAt, pendingSince, now, busy: true, maxDeferMs: cap });
  check('busy past the cap → restart anyway', d.restart === true, JSON.stringify(d));
}

// 6. Was pending+busy, then goes IDLE → restart now (the deferred reload proceeds the moment the turn ends).
{
  const pendingSince = startedAt + 61_000;
  const now = pendingSince + 30_000;
  const d = evaluateConfigRestart({ cfgMtime: startedAt + 60_000, managedStartedAt: startedAt, pendingSince, now, busy: false, maxDeferMs: cap });
  check('deferred then idle → restart now', d.restart === true && d.deferredMs === 30_000, JSON.stringify(d));
}

// The config-staleness input must include the global agent-definition dir (`<XDG>/opencode/agent/`) so an
// edited/added agent def triggers the reload, not just opencode.json. Drive `newestConfigMtime` via a temp
// XDG_CONFIG_HOME with no config json present, so the value reflects the agent tree alone.
{
  const prevXdg = process.env.XDG_CONFIG_HOME;
  const prevExplicit = process.env.OPENCODE_CONFIG;
  const temp = mkdtempSync(join(tmpdir(), 'cosyncing-opencode-agentwatch-'));
  process.env.XDG_CONFIG_HOME = temp;
  delete process.env.OPENCODE_CONFIG;
  const agentDir = join(temp, 'opencode', 'agent');
  const foo = join(agentDir, 'foo.md');
  try {
    check('no opencode config/agents present → newest mtime is 0', newestConfigMtime() === 0, String(newestConfigMtime()));

    mkdirSync(agentDir, { recursive: true });
    writeFileSync(foo, '# agent foo\n');
    utimesSync(foo, new Date(1_000), new Date(1_000));
    utimesSync(agentDir, new Date(1_000), new Date(1_000));
    check('agent def file mtime is folded into the config-staleness input', newestConfigMtime() === 1_000, String(newestConfigMtime()));

    writeFileSync(foo, '# agent foo edited\n');
    utimesSync(foo, new Date(2_000), new Date(2_000));
    utimesSync(agentDir, new Date(1_000), new Date(1_000));
    check('editing an agent def advances the config-staleness input', newestConfigMtime() === 2_000, String(newestConfigMtime()));

    const bar = join(agentDir, 'bar.md');
    writeFileSync(bar, '# agent bar\n');
    utimesSync(bar, new Date(3_000), new Date(3_000));
    utimesSync(foo, new Date(2_000), new Date(2_000));
    utimesSync(agentDir, new Date(3_000), new Date(3_000));
    check('adding an agent def advances the config-staleness input', newestConfigMtime() === 3_000, String(newestConfigMtime()));
  } finally {
    rmSync(temp, { recursive: true, force: true });
    if (prevXdg == null) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevExplicit == null) delete process.env.OPENCODE_CONFIG;
    else process.env.OPENCODE_CONFIG = prevExplicit;
  }
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\nFAIL: ${failed.length}/${results.length} C5 guardrail check(s) failed.`);
  process.exit(1);
}
console.log(`\nPASS ${results.length}/${results.length} C5 serve-restart guardrail + agent-watch checks`);
