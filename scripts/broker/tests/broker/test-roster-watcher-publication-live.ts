#!/usr/bin/env bun
/**
 * R0c.1 end-to-end regression — the REAL broker's roster delta journal must never record an
 * adapter-watcher Idle reversal for a session whose exact live owner is mid-turn.
 *
 * This drives one real broker (`main.ts`) in a fully isolated fixture home and consumes
 * `/api/session-roster-deltas` at the same revisions the Flutter roster feed uses. The live owner
 * is a Claude hooks bridge (`/claude/hook/hello` + `/claude/hook/status`, a pinned Hub connection
 * with exact turn-boundary evidence); the inferred snapshots come from the Claude adapter's REAL
 * `watchSessionInfo` (a bridge-dir `.sock` churn re-runs discovery and emits the transcript-derived
 * row). The transcript is arranged to infer Idle while the hook owner is Working — the same shape
 * as a bounded Codex rollout catch-up racing a live daemon turn, expressed through the identical
 * capability-driven publication path (no per-tool branch exists to differ).
 *
 * The periodic discovery safety-reconcile is pushed out of the way
 * (COSYNCING_ROSTER_SAFETY_RECONCILE_MS=1h) so after one initial reconcile the journal is fed by
 * the watcher and Hub publication paths alone.
 *
 * Lanes:
 *   L1 initial discovery journals the truthful on-disk row (idle, no owner).
 *   L2 with NO live owner, a truthful watcher status change (idle→working) publishes raw.
 *   L3 exact live Working + watcher-inferred Idle catch-up → the watcher publication PROVABLY
 *      arrives (watcher-titled sentinel row, armed only after the hook-caused revisions are
 *      drained to quiescence) but NO Idle revision is journaled.  ← the reproduced defect
 *   L4 the authoritative live terminal event journals EXACTLY ONE Idle revision, and further
 *      watcher churn provably arrives (same sentinel) with no status flip.
 */
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeSessionId } from '../../../../packages/typescript/adapters/claude/src/index.ts';
import {
  isolatedBrokerFixtureEnvironment,
  reserveLoopbackFixturePort,
} from '../helpers/isolated-broker-fixture.ts';

let failures = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REPO = join(import.meta.dir, '..', '..', '..', '..');

const work = mkdtempSync(join(tmpdir(), 'cosyncing-r0c1-live-'));
const claudeDir = join(work, 'claude');
const projDir = join(claudeDir, 'projects', 'r0c1-proj');
const bridgeDir = join(claudeDir, 'cosyncing', 'bridge');
mkdirSync(projDir, { recursive: true });
const uuid = '0e0c1000-0000-4000-8000-000000000001';
const transcriptPath = join(projDir, `${uuid}.jsonl`);
const id = claudeSessionId(transcriptPath);
const fakeClaude = join(work, 'fake-claude');
writeFileSync(fakeClaude, `#!/usr/bin/env bash
if [[ "$1" == "agents" && "$2" == "--json" ]]; then
  printf '%s\\n' '[{"sessionId":"${uuid}","status":"busy"}]'
  exit 0
fi
exit 2
`);
chmodSync(fakeClaude, 0o755);

const line = (obj: unknown): string => `${JSON.stringify(obj)}\n`;
const userLine = (n: number): string => line({
  type: 'user', uuid: `u${n}`, sessionId: uuid, cwd: work,
  timestamp: new Date().toISOString(), message: { role: 'user', content: `prompt ${n}` },
});
const assistantEndTurn = (n: number): string => line({
  type: 'assistant', uuid: `a${n}`, sessionId: uuid, timestamp: new Date().toISOString(),
  message: { role: 'assistant', content: [{ type: 'text', text: `answer ${n}` }], stop_reason: 'end_turn' },
});
// Latest exact marker: assistant end_turn → transcript authority 'terminal' → inferred idle.
writeFileSync(transcriptPath, userLine(1) + assistantEndTurn(1));

const portLease = await reserveLoopbackFixturePort();
const PORT = portLease.port;
const BASE = `http://127.0.0.1:${PORT}`;
const fixtureEnvironment = isolatedBrokerFixtureEnvironment(work, {
  overrides: {
    PORT: String(PORT),
    HOST: '127.0.0.1',
    COSYNCING_MACHINE: 'r0c1-live',
    COSYNCING_DEV_MODE: '1',
    CLAUDE_CONFIG_DIR: claudeDir,
    // Only the watcher/Hub publication paths may feed the journal after the initial reconcile.
    COSYNCING_ROSTER_SAFETY_RECONCILE_MS: '3600000',
    // Deterministic discovery: the native process row is busy, but no Hub owner exists until L3.
    // Exact terminal transcript evidence still keeps L1/L3 Idle on the inferred path.
    COSYNCING_CLAUDE_BIN: fakeClaude,
    COSYNCING_CODEX_SYNC_SERVER: '0',
    COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
    COSYNCING_RESTART_DRY_RUN: '1',
  },
});

type Delta = { revision: number; sessionId: string; changedFields: string[]; session?: any; removed?: true };
const seen: Delta[] = [];
let cursor = 0;
async function pollDeltas(waitMs = 2_000): Promise<Delta[]> {
  const res = await fetch(`${BASE}/api/session-roster-deltas?after=${cursor}&waitMs=${waitMs}`);
  if (!res.ok) throw new Error(`deltas ${res.status}`);
  const batch = (await res.json()) as { revision: number; deltas: Delta[]; resetRequired?: boolean };
  if (batch.resetRequired) throw new Error('unexpected resetRequired');
  cursor = batch.revision;
  const mine = batch.deltas.filter((d) => d.sessionId === id);
  seen.push(...mine);
  return mine;
}
async function waitForSessionStatus(want: string, timeoutMs = 15_000): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: string | undefined;
  while (Date.now() < deadline) {
    for (const d of await pollDeltas()) if (d.session?.status) last = String(d.session.status);
    if (last === want) return last;
  }
  return last;
}
/** Drain until two consecutive empty polls: every already-caused revision is in `seen`, so a
 *  sentinel armed afterwards can only be satisfied by revisions the NEXT stimulus causes. */
async function drainToQuiescence(): Promise<void> {
  for (let quiet = 0; quiet < 2;) quiet = (await pollDeltas(600)).length === 0 ? quiet + 1 : 0;
}
/** Wait for a revision at index >= from that only the adapter WATCHER can produce: the
 *  transcript-derived row titles itself off the first user prompt ('prompt 1'), while every hook
 *  owner frame carries the hello title ('r0c1 live'). Metadata churn from the hook path can never
 *  satisfy this. */
async function waitForWatcherDelta(from: number, timeoutMs = 15_000): Promise<Delta | undefined> {
  const deadline = Date.now() + timeoutMs;
  let found: Delta | undefined;
  while (!found && Date.now() < deadline) {
    await pollDeltas();
    found = seen.slice(from).find((d) => !d.removed && d.session?.title === 'prompt 1');
  }
  return found;
}
/** Journaled STATUS transitions at index >= from. Metadata-only revisions (e.g. updatedAt moved,
 *  status unchanged) are legitimate journal traffic and are not status flips. */
const statusFlipsSince = (from: number): string[] =>
  seen.slice(from)
    .filter((d) => !d.removed && d.session?.status
      && (d.changedFields.includes('status') || d.changedFields.includes('session')))
    .map((d) => String(d.session.status));

const post = async (path: string, body: unknown): Promise<any> => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return res.json().catch(() => ({}));
};

await portLease.release();
const broker = Bun.spawn(['bun', 'packages/typescript/broker/src/main.ts'], {
  cwd: REPO, env: fixtureEnvironment, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
});

try {
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) up = true; } catch { /* not yet */ }
    if (!up) await sleep(250);
  }
  check('L0 broker up', up, up ? `:${PORT}` : 'never became healthy');
  if (!up) throw new Error('broker did not start');

  // ── L1: initial reconcile journals the truthful on-disk row (no owner) ───────────────────────
  const initial = await waitForSessionStatus('idle');
  check('L1 initial discovery journals the on-disk row as idle', initial === 'idle', String(initial));

  // ── L2: no live owner → a truthful watcher status change publishes raw ───────────────────────
  appendFileSync(transcriptPath, userLine(2)); // latest marker 'active' → inferred working
  mkdirSync(bridgeDir, { recursive: true }); // created by the adapter at startup; tolerate slow init
  writeFileSync(join(bridgeDir, `${uuid}.sock`), '');
  const unownedWorking = await waitForSessionStatus('working');
  check('L2 with no live owner the watcher publishes truthful working', unownedWorking === 'working', String(unownedWorking));

  // ── L3: exact live Working + watcher-inferred Idle catch-up ──────────────────────────────────
  // The transcript's latest exact marker becomes terminal (inferred idle) while the live hook
  // owner is mid-turn — the bounded catch-up race.
  appendFileSync(transcriptPath, assistantEndTurn(2));
  const hello = await post('/claude/hook/hello', { transcriptPath, cwd: work, title: 'r0c1 live' });
  check('L3 hook hello adopts the SAME session identity the watcher publishes', hello.ok === true && hello.id === id, `id match=${hello.id === id}`);
  const st = await post('/claude/hook/status', { transcriptPath, state: 'working' });
  check('L3 hook status marks the live owner working', st.ok === true && st.tracked === true, JSON.stringify(st));
  const liveWorking = await waitForSessionStatus('working');
  check('L3 the live owner\'s working status is journaled', liveWorking === 'working', String(liveWorking));

  // Every revision the hello/status posts caused must be drained BEFORE the sentinel is armed —
  // otherwise a still-pending hook revision could prove `seen` grew even if the .sock churn never
  // reached the watcher, and the no-Idle check would pass vacuously.
  await drainToQuiescence();
  const raceFrom = seen.length;
  writeFileSync(join(bridgeDir, `${uuid}.sock`), 'poke'); // watcher re-derives the (idle) row
  const watcherDelta = await waitForWatcherDelta(raceFrom);
  check('L3 the watcher publication reached the delta journal (watcher-titled row)',
    watcherDelta !== undefined,
    watcherDelta ? `title=${watcherDelta.session?.title}` : `deltas past sentinel=${seen.length - raceFrom}`);
  await pollDeltas(1_000); // absorb any trailing reversal the defect would journal
  const raceStatuses = statusFlipsSince(raceFrom);
  check('L3 NO Idle (or inferred needs-input) revision is journaled while the exact live owner is mid-turn',
    raceStatuses.every((s) => s === 'working'), raceStatuses.join('→') || '(none)');

  // ── L4: the authoritative terminal event → exactly one Idle revision ─────────────────────────
  await drainToQuiescence();
  const terminalFrom = seen.length;
  const idleSt = await post('/claude/hook/status', { transcriptPath, state: 'idle' });
  check('L4 hook status idle accepted', idleSt.ok === true, JSON.stringify(idleSt));
  const settled = await waitForSessionStatus('idle');
  check('L4 the authoritative live terminal event journals idle', settled === 'idle', String(settled));
  // Post-terminal watcher churn: the publication must be OBSERVED (the hook idle frame restored
  // the 'r0c1 live' title, so a fresh watcher-titled row is unambiguous churn evidence) and must
  // contribute no status flip.
  await drainToQuiescence();
  const churnFrom = seen.length;
  writeFileSync(join(bridgeDir, `${uuid}.sock`), 'poke-2');
  const churnDelta = await waitForWatcherDelta(churnFrom);
  check('L4 the post-terminal watcher churn reached the journal (watcher-titled row)',
    churnDelta !== undefined,
    churnDelta ? `title=${churnDelta.session?.title}` : `deltas past sentinel=${seen.length - churnFrom}`);
  await pollDeltas(1_000);
  const terminalStatuses = statusFlipsSince(terminalFrom);
  check('L4 exactly one Idle revision, no reversal after the terminal event',
    terminalStatuses.filter((s) => s === 'idle').length === 1 && !terminalStatuses.includes('working'),
    terminalStatuses.join('→') || '(none)');
} catch (error) {
  check('L-harness the broker stays reachable for the whole run', false, String((error as Error)?.message ?? error));
} finally {
  broker.kill();
  await broker.exited.catch(() => undefined);
  rmSync(work, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
