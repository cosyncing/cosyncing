#!/usr/bin/env bun
/**
 * HOOKS spike — resolves decision D-A / RQ-6 (docs/protocol/adapter-support.md).
 *
 * Question: can Claude Code HOOKS (a different mechanism than the archived claude/channel) give us Tier-1
 * control — answer permission prompts AND surface/answer the in-flight question — for a session we launch,
 * WITHOUT the channel allowlist? If yes, the tmux TUI monitor is only needed for unconfigured, externally
 * owned terminal sessions, which shrinks the whole scope.
 *
 * Method: headless `claude -p --output-format stream-json` (deterministic, no TTY to parse) with a PreToolUse
 * hook wired via --settings. We read the stream to see whether a permission-gated Bash tool actually RAN.
 *
 * Sub-tests:
 *   T0  baseline (no hook)            → tool should be DENIED in headless default mode (establishes the gate)
 *   T1  allow-expected               → hook returns allow → tool RUNS, no prompt (Tier-1 allow works)
 *   T2  deny-all                     → hook returns deny  → tool BLOCKED
 *   T3  defer→allow (THE ONE)        → hook BLOCKS polling a decision file; we write allow after ~4s → RUNS
 *   T3b defer→deny                   → same, write deny → BLOCKED  (proves remote async control both ways)
 *   T4  AskUserQuestion injection    → hook returns allow + updatedInput.answers → model proceeds with choice
 *   T5  event probe                  → wire PreToolUse + PermissionRequest + Notification; see which FIRE
 *
 * Cost: first-party claude on the subscription; --model haiku, tiny turns. Run from repo root.
 *   bun run scripts/broker/coexistence-test/hooks-spike.ts [--only T3] [--keep] [--model haiku]
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..', '..', '..');
const HOOK = join(import.meta.dir, 'hook.ts');
const DIR = '/tmp/hooks-spike';
const BUN = process.execPath;
const args = process.argv.slice(2);
const MODEL = args.includes('--model') ? args[args.indexOf('--model') + 1]! : 'haiku';
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1]! : '';
const KEEP = args.includes('--keep');

const ts = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function logline(s: string): void { console.log(`${ts()} ${s}`); }

type Settings = Record<string, unknown>;
/** Build a settings.json that wires `events` (PreToolUse/PermissionRequest/Notification/...) to our hook. */
function settingsFor(events: { event: string; matcher: string; label: string; env: Record<string, string> }[]): Settings {
  const hooks: Record<string, unknown[]> = {};
  for (const e of events) {
    const envStr = Object.entries({ HOOK_SPIKE_DIR: DIR, ...e.env }).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
    (hooks[e.event] ||= []).push({ matcher: e.matcher, hooks: [{ type: 'command', command: `${envStr} ${BUN} ${HOOK} ${e.label}`, timeout: 60 }] });
  }
  return { hooks };
}

interface RunResult { events: any[]; ran: boolean; blocked: boolean; marker: string; finalText: string; toolUses: any[]; toolResults: any[]; raw: string; exitCode: number; }
async function runClaude(prompt: string, settings: Settings, marker: string, tag = '', timeoutMs = 90000): Promise<RunResult> {
  const proc = Bun.spawn(
    ['claude', '-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', MODEL, '--permission-mode', 'default', '--settings', JSON.stringify(settings)],
    { cwd: DIR, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env: { ...process.env } },
  );
  const killer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
  const raw = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  clearTimeout(killer);
  const events: any[] = [];
  for (const ln of raw.split('\n')) { const s = ln.trim(); if (!s) continue; try { events.push(JSON.parse(s)); } catch {} }
  const toolUses: any[] = [];
  const toolResults: any[] = [];
  let finalText = '';
  for (const ev of events) {
    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      for (const b of ev.message.content) {
        if (b.type === 'tool_use') toolUses.push({ name: b.name, id: b.id, input: b.input });
        if (b.type === 'text') finalText = b.text;
      }
    } else if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
      for (const b of ev.message.content) if (b.type === 'tool_result') toolResults.push({ id: b.tool_use_id, isError: b.is_error, content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) });
    } else if (ev.type === 'result') {
      finalText = ev.result ?? finalText;
    }
  }
  // "ran" = a REAL successful tool_result carried the marker output. NOT finalText (the model echoes the
  // marker string in its prose — e.g. "I couldn't run echo MARKER" — which is not the tool running).
  const ran = toolResults.some((r) => String(r.content).includes(marker) && r.isError !== true);
  const blocked = toolUses.length > 0 && !ran;
  if (tag) { try { writeFileSync(join(DIR, `events-${tag}.ndjson`), raw); } catch {} }
  if (err.trim() && exitCode !== 0) logline(`  stderr: ${err.trim().split('\n').slice(0, 3).join(' | ')}`);
  return { events, ran, blocked, marker, finalText, toolUses, toolResults, raw, exitCode };
}

/** Wait until the deferring hook has actually started blocking (its defer-start landed in the hooklog), so a
 *  decision we then write genuinely tests "hook blocked, THEN remote answered" — not "answer pre-existed". */
async function waitForDeferStart(timeoutMs = 60000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (readHookLog().some((h) => h.phase === 'defer-start')) return true; await sleep(200); }
  return false;
}

function resetLog(): void { try { writeFileSync(join(DIR, 'hooklog.ndjson'), ''); } catch {} }
function readHookLog(): any[] {
  try { return readFileSync(join(DIR, 'hooklog.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}
let counter = 0;
const newMarker = () => `HOOKSPIKE_${Date.now()}_${counter++}`;
const want = (id: string) => !ONLY || ONLY.split(',').includes(id);

const results: { id: string; pass: boolean | null; note: string }[] = [];
function record(id: string, pass: boolean | null, note: string): void { results.push({ id, pass, note }); logline(`  ${pass === null ? '•' : pass ? 'PASS' : 'FAIL'} ${id}: ${note}`); }

logline(`=== hooks-spike start (model=${MODEL}${ONLY ? ` only=${ONLY}` : ''}) ===`);
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
// Make the work dir trusted-by-default so headless doesn't choke on folder-trust.
writeFileSync(join(DIR, 'README.md'), 'hooks spike scratch\n');

try {
  // ---- T0: baseline, NO hook → headless default should DENY the gated tool. ----
  if (want('T0')) {
    const m = newMarker();
    resetLog();
    const r = await runClaude(`Use the Bash tool to run exactly this command: echo ${m}. Then stop.`, {}, m);
    record('T0', !r.ran, r.ran ? `tool RAN without a hook (headless default does NOT gate?) toolUses=${r.toolUses.length}` : `tool blocked/not run as expected (toolUses=${r.toolUses.length}, results=${r.toolResults.length})`);
  }

  // ---- T1: allow-expected hook → tool RUNS, no prompt. ----
  if (want('T1')) {
    const m = newMarker();
    resetLog();
    const s = settingsFor([{ event: 'PreToolUse', matcher: 'Bash', label: 'pretooluse', env: { HOOK_MODE: 'allow-expected', HOOK_EXPECT: m } }]);
    const r = await runClaude(`Use the Bash tool to run exactly this command: echo ${m}. Then stop.`, s, m, 'T1');
    const hl = readHookLog();
    const fired = hl.find((h) => h.phase === 'received' && h.tool_name === 'Bash');
    record('T1', r.ran && !!fired, `ran=${r.ran} hookFired=${!!fired} sawToolInput.command=${fired?.command ? 'yes' : 'no'}`);
  }

  // ---- T2: deny-all hook → tool BLOCKED. ----
  if (want('T2')) {
    const m = newMarker();
    resetLog();
    const s = settingsFor([{ event: 'PreToolUse', matcher: 'Bash', label: 'pretooluse', env: { HOOK_MODE: 'deny-all' } }]);
    const r = await runClaude(`Use the Bash tool to run exactly this command: echo ${m}. Then stop.`, s, m, 'T2');
    record('T2', !r.ran && r.toolUses.length > 0, `ran=${r.ran} blocked=${r.blocked} toolUses=${r.toolUses.length} (expected blocked after attempting)`);
  }

  // ---- T3: defer → write allow after ~4s while the hook BLOCKS. THE make-or-break. ----
  if (want('T3')) {
    const m = newMarker();
    resetLog();
    rmSync(join(DIR, 'decision.json'), { force: true });
    const s = settingsFor([{ event: 'PreToolUse', matcher: 'Bash', label: 'pretooluse', env: { HOOK_MODE: 'defer', HOOK_DEFER_MS: '40000' } }]);
    // Remote answers only AFTER the hook is observed blocking, +3s → waitedMs proves a genuine block-and-defer.
    const writer = (async () => { if (await waitForDeferStart()) { await sleep(3000); writeFileSync(join(DIR, 'decision.json'), JSON.stringify({ decision: 'allow' })); logline('  [remote] wrote decision.json=allow (3s after hook began blocking)'); } })();
    const r = await runClaude(`Use the Bash tool to run exactly this command: echo ${m}. Then stop.`, s, m, 'T3');
    await writer;
    const hl = readHookLog();
    const resolved = hl.find((h) => h.phase === 'defer-resolved');
    record('T3', r.ran && !!resolved && resolved.waitedMs >= 2500, `ran=${r.ran} deferResolved=${!!resolved} waitedMs=${resolved?.waitedMs} (hook genuinely blocked, then honored remote allow)`);
    rmSync(join(DIR, 'decision.json'), { force: true });
  }

  // ---- T3b: defer → deny. ----
  if (want('T3b')) {
    const m = newMarker();
    resetLog();
    rmSync(join(DIR, 'decision.json'), { force: true });
    const s = settingsFor([{ event: 'PreToolUse', matcher: 'Bash', label: 'pretooluse', env: { HOOK_MODE: 'defer', HOOK_DEFER_MS: '40000' } }]);
    const writer = (async () => { if (await waitForDeferStart()) { await sleep(3000); writeFileSync(join(DIR, 'decision.json'), JSON.stringify({ decision: 'deny' })); logline('  [remote] wrote decision.json=deny (3s after hook began blocking)'); } })();
    const r = await runClaude(`Use the Bash tool to run exactly this command: echo ${m}. Then stop.`, s, m, 'T3b');
    await writer;
    const hl = readHookLog();
    const resolved = hl.find((h) => h.phase === 'defer-resolved');
    record('T3b', !r.ran && !!resolved && resolved.decision === 'deny', `ran=${r.ran} blocked=${r.blocked} deferResolved=${!!resolved} waitedMs=${resolved?.waitedMs} decision=${resolved?.decision} (expected blocked)`);
    rmSync(join(DIR, 'decision.json'), { force: true });
  }

  // ---- T4: AskUserQuestion answer injection via updatedInput.answers. ----
  if (want('T4')) {
    resetLog();
    // Inject option index 1 (BRAVO) — distinguishable from the model/tool default (typically the first, ALPHA).
    // If the model then reports BRAVO, the hook CONTROLLED the answer, not just allowed the tool.
    const s = settingsFor([{ event: 'PreToolUse', matcher: '.*', label: 'pretooluse', env: { HOOK_MODE: 'answer-question', HOOK_ANSWER_INDEX: '1' } }]);
    const r = await runClaude(
      'Use the AskUserQuestion tool to ask the user ONE question with header "Pick" and exactly two options labelled "ALPHA" and "BRAVO". After the user answers, reply with ONLY the exact label the user chose and nothing else.',
      s, 'no-marker', 'T4',
    );
    const hl = readHookLog();
    const askFired = hl.find((h) => h.phase === 'received' && h.tool_name === 'AskUserQuestion');
    const built = hl.find((h) => h.phase === 'answer-built');
    const chosen = /ALPHA|BRAVO/.exec(r.finalText || '')?.[0] || '(none)';
    record('T4', !!askFired && chosen === 'BRAVO', `askUserQuestionFired=${!!askFired} injected=${JSON.stringify(built?.answers)} finalText="${(r.finalText || '').slice(0, 40)}" modelReported=${chosen} (PASS iff BRAVO ⇒ hook controlled the answer)`);
  }

  // ---- T5: event probe — which of PreToolUse / PermissionRequest / Notification actually FIRE? ----
  if (want('T5')) {
    const m = newMarker();
    resetLog();
    const s = settingsFor([
      { event: 'PreToolUse', matcher: 'Bash', label: 'pretooluse', env: { HOOK_MODE: 'allow-expected', HOOK_EXPECT: m } },
      { event: 'PermissionRequest', matcher: '.*', label: 'permissionrequest', env: { HOOK_MODE: 'log-only' } },
      { event: 'Notification', matcher: '.*', label: 'notification', env: { HOOK_MODE: 'log-only' } },
    ]);
    const r = await runClaude(`Use the Bash tool to run exactly this command: echo ${m}. Then stop.`, s, m, 'T5');
    const hl = readHookLog();
    const byEvent = new Map<string, any[]>();
    for (const h of hl) { if (h.phase === 'received') (byEvent.get(h.event) || byEvent.set(h.event, []).get(h.event)!).push(h); }
    const fired = [...byEvent.keys()];
    const notif = (byEvent.get('notification') || [])[0];
    record('T5', fired.includes('pretooluse'), `firedEvents=[${fired.join(',')}] ran=${r.ran} notificationType=${notif?.notification_type ?? '(none)'} notificationMsg=${notif?.message ? JSON.stringify(String(notif.message).slice(0, 50)) : '(none)'}`);
  }

  // ---- Summary ----
  logline('\n=== HOOKS SPIKE SUMMARY ===');
  for (const r of results) logline(`  ${r.pass === null ? '•' : r.pass ? '✅ PASS' : '❌ FAIL'}  ${r.id.padEnd(4)} ${r.note}`);
  const decisive = results.filter((r) => ['T1', 'T2', 'T3', 'T3b'].includes(r.id));
  const tier1 = decisive.length > 0 && decisive.every((r) => r.pass);
  logline(`\n  D-A verdict: hooks ${tier1 ? 'CAN' : 'CANNOT (or untested)'} give Tier-1 permission control without the channel allowlist.`);
  logline(`  (decisive = T1 allow + T2 deny + T3 defer-allow + T3b defer-deny)`);
} catch (e) {
  logline('ERROR ' + String(e));
} finally {
  logline(`hooklog: ${join(DIR, 'hooklog.ndjson')}${KEEP ? ' (kept)' : ''}`);
  if (!KEEP) { /* keep DIR for inspection regardless; it's throwaway /tmp */ }
}
