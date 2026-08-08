/**
 * Live F1 evidence: a real OpenCode turn must surface as Working in the roster and
 * clear to Idle when it finishes — proven against a real `opencode serve` and a real
 * (free) model, not a fake HTTP server.
 *
 * The decisive case is the RECONCILE path added in Wave 1: a freshly constructed
 * adapter has no `/global/event` history, so if it still reports an already-running
 * turn as Working, that can only have come from the `/session/status` reconciliation.
 *
 * Zero model cost by default: drives the `vllm-hpc` provider (self-hosted vLLM).
 * Requires a reachable `opencode serve` with that provider configured; SKIPS (exit 0)
 * otherwise, so hermetic CI and machines without the endpoint stay green.
 *
 *   bun run scripts/broker/tests/opencode/test-opencode-status-live.ts
 *
 * Overridable via env:
 *   OPENCODE_URL                 (default http://127.0.0.1:4096)
 *   COSYNCING_TEST_OC_PROVIDER   (default vllm-hpc)
 *   COSYNCING_TEST_OC_MODEL      (default qwen3.6-27B-FP8)
 *   COSYNCING_TEST_OC_DIR        (default process.cwd())
 */
export {};
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodeAdapter } from '../../../../packages/typescript/adapters/opencode/src/index.ts';

const BASE = (process.env.OPENCODE_URL ?? 'http://127.0.0.1:4096').replace(/\/+$/, '');
const PROVIDER = process.env.COSYNCING_TEST_OC_PROVIDER ?? 'vllm-hpc';
const MODEL = process.env.COSYNCING_TEST_OC_MODEL ?? 'qwen3.6-27B-FP8';
const DIR = process.env.COSYNCING_TEST_OC_DIR ?? process.cwd();
const dirq = `?directory=${encodeURIComponent(DIR)}`;

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const skip = (why: string): never => {
  console.log(`SKIP  opencode live status — ${why}`);
  process.exit(0);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(path: string, timeoutMs = 5000): Promise<any> {
  const res = await fetch(BASE + path, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}
async function rawStatusType(sessionId: string): Promise<string> {
  try {
    const map = (await getJson('/session/status' + dirq, 4000)) as Record<string, { type?: string }>;
    return map?.[sessionId]?.type ?? 'absent';
  } catch {
    return 'err';
  }
}

// --- Preflight: skip cleanly when the environment can't run a real turn. ---
let config: any;
try {
  await getJson('/session', 4000); // serve reachable
  config = await getJson('/config', 4000);
} catch (error) {
  skip(`no reachable opencode serve at ${BASE} (${(error as Error).message})`);
}
if (!config?.provider?.[PROVIDER]) skip(`provider '${PROVIDER}' not configured on ${BASE}`);

let sessionId = '';
try {
  // 1) Throwaway session in a known project directory.
  const created = await (await fetch(BASE + '/session' + dirq, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'cosyncing F1 live status probe (safe to delete)' }),
    signal: AbortSignal.timeout(10_000),
  })).json();
  sessionId = created?.id ?? '';
  if (!sessionId) skip('session create returned no id');
  console.log(`session: ${sessionId}  provider: ${PROVIDER}/${MODEL}  dir: ${DIR}`);

  // 2) Fire a real turn (async) that stays busy long enough to observe.
  const prompt =
    'Write a detailed ~400-word explanation of how TCP congestion control works ' +
    '(slow start, congestion avoidance, fast retransmit, fast recovery), then count ' +
    'slowly from 1 to 20, one number per line.';
  const promptRes = await fetch(BASE + `/session/${sessionId}/prompt_async` + dirq, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: { providerID: PROVIDER, modelID: MODEL },
      parts: [{ type: 'text', text: prompt }],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!promptRes.ok) skip(`prompt_async rejected (HTTP ${promptRes.status}) — model likely unavailable`);

  // 3) Wait until OpenCode itself reports the turn busy. This is ground truth; if it
  //    never happens the model/endpoint is down, which is an environment skip, not an
  //    F1 regression.
  let busy = false;
  for (let i = 0; i < 80 && !busy; i++) {
    const t = await rawStatusType(sessionId);
    if (t === 'busy' || t === 'retry') busy = true;
    else await sleep(250);
  }
  if (!busy) skip('turn never entered busy (model/endpoint unavailable)');

  // 4) THE F1 ASSERTION. A brand-new adapter has no SSE history for this turn, so a
  //    Working result can only come from /session/status reconciliation on discovery.
  const lateAdapter = new OpenCodeAdapter({
    baseUrl: BASE,
    storageDir: mkdtempSync(join(tmpdir(), 'cosyncing-oc-live-')),
    sseIdleMs: 30_000,
  });
  const discovered = await lateAdapter.discoverSessions();
  const row = discovered.find((s) => s.id === sessionId);
  check(
    'reconcile seeds Working for a late observer (no SSE edge seen)',
    row?.status === 'working',
    `roster status=${row?.status ?? 'not-found'} (raw=${await rawStatusType(sessionId)})`,
  );
  check('adapter reports a busy session', lateAdapter.anySessionBusy(), `anySessionBusy=${lateAdapter.anySessionBusy()}`);

  // 5) When the turn finishes, absence from the status map must clear Working to Idle.
  let idle = false;
  for (let i = 0; i < 160 && !idle; i++) {
    if ((await rawStatusType(sessionId)) === 'absent') idle = true;
    else await sleep(250);
  }
  const afterIdle = await lateAdapter.discoverSessions();
  const idleRow = afterIdle.find((s) => s.id === sessionId);
  check(
    'completed turn clears to Idle on next discovery',
    idle && idleRow?.status === 'idle',
    `raw-idle=${idle} roster status=${idleRow?.status ?? 'not-found'}`,
  );

  // The adapter's SSE tracker runs until the process exits; the final process.exit
  // below tears it down, matching the deterministic reconcile test.
} finally {
  if (sessionId) {
    try {
      await fetch(BASE + `/session/${sessionId}` + dirq, { method: 'DELETE', signal: AbortSignal.timeout(8000) });
    } catch {
      console.log(`(cleanup) could not delete probe session ${sessionId} — delete it manually if it lingers`);
    }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
