/**
 * D20 — the broker auto-launches and OWNS the lifecycle of a managed `opencode serve`, so OpenCode is
 * sync-by-default: a session from the shared server attaches live with no user setup.
 *
 * We only ever manage a serve we launched ourselves. We SKIP launching when:
 *  - the operator opts out (`COSYNCING_OPENCODE_NO_AUTOSERVE=1`);
 *  - `OPENCODE_URL` points at a non-local host (a remote serve is not ours to own);
 *  - a serve we ALREADY own is reachable there (never double-launch our own);
 *  - the `opencode` binary is not installed (OpenCode then stays observe/resume only).
 *
 * When a serve is reachable at our local base but this broker does not own it IN THIS PROCESS, we must
 * decide whether it is OURS (an orphan from a prior broker run) or a FOREIGN serve (a user's own
 * `opencode serve` — :4096 is OpenCode's default port, so this is a real collision). We NEVER dispose or
 * kill a serve we cannot PROVE we started. Proof is a durable ownership record ({@link OpencodeServeOwnership}:
 * pid + a locale-free process start token + comm + base) written whenever the broker spawns the serve, and
 * re-verified against the live listener's process identity at startup:
 *  - PROVEN OWNED (record matches the live pid + start token + comm) → reclaim it: free the port (graceful
 *    `POST /instance/dispose`, else signal the listener — safe, it is our own process) and relaunch under
 *    broker control so `managed` is set and the config-reload watch activates.
 *  - UNPROVEN (no record / stale / mismatched pid / pid-reuse / different executable) or INDETERMINATE
 *    (the listener's identity can't be resolved) → PRESERVE it untouched and log a conflict hint. Config
 *    reloads won't apply to a serve we don't own — the safe default (never kill a stranger's serve).
 * A pre-existing serve that is merely ADOPTED read-only leaves `managed = null`, so the watch no-ops and
 * config edits (new provider/model) never reload — which is exactly why proven-owned orphans are reclaimed.
 * Opt-out (`COSYNCING_OPENCODE_NO_AUTOSERVE=1`) suppresses all of this; `COSYNCING_OPENCODE_REPLACE_UNOWNED_SERVE=1`
 * is the explicit operator-approved escape hatch to replace an UNPROVEN serve.
 *
 * The child is killed on broker exit so we never orphan a server. On a broker restart (the Codex
 * live-toggle path) the child is killed and the replacement broker relaunches it — a brief, rare blip.
 *
 * Governing contract: docs/architecture/client-ui.md §3 (D20).
 */
import { resolveLocalOpencodeBaseUrl } from '@cosyncing/adapter-opencode';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PRODUCT_IDENTITY } from './product.ts';
import { atomicWriteJsonOwnerOnly } from './secure-files.ts';
import { setupStateHome } from './setup-state.ts';
import {
  clearManagedRuntimeFailure,
  recordManagedRuntimeFailure,
} from './runtime-failure-store.ts';

const LOG_PREFIX = `[${PRODUCT_IDENTITY.productName}]`;

let managed: Bun.Subprocess | null = null;
let managedStartedAt = 0;
let managedBaseUrl: string | null = null;
let managedLifecycleRestart: Promise<void> | null = null;
let teardownRegistered = false;

function boundedStreamCapture(stream: ReadableStream<Uint8Array>, limit = 8 * 1024): {
  read: () => string;
  done: Promise<void>;
} {
  let value = '';
  const done = (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (value.length < limit) value += decoder.decode(next.value, { stream: true }).slice(0, limit - value.length);
      }
      if (value.length < limit) value += decoder.decode().slice(0, limit - value.length);
    } catch {
      /* process ended while the bounded diagnostic stream was draining */
    }
  })();
  return { read: () => value, done };
}

function capturedOutput(stdout: { read(): string }, stderr: { read(): string }): string {
  return `stdout:\n${stdout.read()}\nstderr:\n${stderr.read()}`;
}

function recordStartFailure(detailCode: string, output = ''): void {
  try { recordManagedRuntimeFailure({ agent: 'opencode', detailCode, capturedOutput: output }); } catch {
    /* diagnostics are best-effort and must never break the managed runtime */
  }
}

function clearStartFailure(): void {
  try { clearManagedRuntimeFailure('opencode'); } catch {
    /* diagnostics are best-effort and must never break the managed runtime */
  }
}

export function normalizeOpencodeVersion(raw: string): string {
  return raw.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] ?? raw.trim().split(/\s+/)[0] ?? '';
}

function isLocalHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/** Mirror the OpenCode adapter's reachability probe (`GET /session`) so "already up" means the same thing. */
async function serveReachable(baseUrl: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/session`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Poll until the base is no longer reachable (the port has been released), or the deadline elapses. */
async function waitUntilPortFree(baseUrl: string, timeoutMs: number, pollMs = 150): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await serveReachable(baseUrl, 750))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * POST one of OpenCode's graceful-dispose endpoints. OpenCode's OpenAPI (GET /doc) exposes
 * POST /instance/dispose ("dispose the current instance") and POST /global/dispose ("dispose all
 * instances"), both documented as releasing all resources. Best-effort: the serve may drop the
 * connection mid-dispose (a throw here is expected), so we do NOT trust the response — the caller
 * confirms success by the port actually freeing, and re-proves ownership between the two calls
 * because both are PORT-addressed (see takeOverExistingServe, Codex finding 1).
 */
async function postDispose(baseUrl: string, path: string, timeoutMs = 1500): Promise<void> {
  try {
    await fetch(`${baseUrl}${path}`, { method: 'POST', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    /* endpoint absent on this OpenCode version, or the serve closed the socket as it disposed */
  }
}

/** PID of the process LISTENING on a TCP port (Linux + macOS via `lsof`). undefined if it can't be
 *  resolved (lsof absent, no match) — the caller then keeps the adopt-and-log fallback. */
function pidListeningOnPort(port: number): number | undefined {
  const lsof = Bun.which('lsof');
  if (!lsof) return undefined;
  try {
    // -t: pids only; -iTCP:<port> -sTCP:LISTEN: the listening socket on that TCP port. Same flags on
    // Linux and macOS. A local serve is the sole listener, so matching by port is unambiguous.
    const res = Bun.spawnSync([lsof, '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', env: { ...process.env }, timeout: 3000,
    });
    if (res.exitCode !== 0) return undefined;
    const pid = Number(new TextDecoder().decode(res.stdout).trim().split(/\s+/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

// ── ownership proof ─────────────────────────────────────────────────────────
// Mirrors setup-state.ts CodexDaemonOwnership: we only ever dispose/kill a serve we can PROVE this broker
// started. A serve on :4096 may be the user's own — killing it on "reachable + not opted out" was the
// blocking bug this replaces. Proof = the live listener's pid AND a stable start token AND comm all match a
// durable record we wrote when we spawned it. The start token defeats pid reuse (a reused pid starts at a
// different time); comm guards a reused pid running a different program.

const OPENCODE_SERVE_OWNER_SCHEMA_VERSION = 1 as const;

/** Stable OS identity of a process (used to prove we started the live serve). */
export interface ProcessIdentity {
  pid: number;
  /** Locale-free start token: Linux `/proc/<pid>/stat` field 22 (starttime in clock ticks); macOS `ps -o lstart=`. */
  start: string;
  /** Command name (Linux `/proc/<pid>/comm`; macOS `ps -o comm=`); '' when it can't be read. */
  comm: string;
}

/** Durable ownership record for a broker-spawned `opencode serve`. Written on spawn, re-verified on restart. */
export interface OpencodeServeOwnership extends ProcessIdentity {
  schemaVersion: typeof OPENCODE_SERVE_OWNER_SCHEMA_VERSION;
  /** The managed base URL this record was written for; a record for a different base does not prove ownership. */
  baseUrl: string;
  /** Wall-clock ms when ownership was recorded (diagnostic; mirrors CodexDaemonOwnership.recordedAt). */
  recordedAtMs: number;
}

/** Ownership record file lives beside setup-state.json under `${COSYNCING_HOME ?? ~/.cosyncing}` (D18). */
function ownerRecordPath(home = setupStateHome()): string {
  return join(home, 'opencode-serve-owner.json');
}

/** Read + FULLY validate the ownership record. Anything missing, malformed, wrong-schema, or out-of-range →
 *  null (unproven; never fabricated). A permissive read here would let a corrupt/forged record authorize a
 *  dispose/kill, so every field is range-checked: matching schema, a positive-integer pid, a non-empty start
 *  token + base, and a finite timestamp. */
function readOwnershipRecord(home = setupStateHome()): OpencodeServeOwnership | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(ownerRecordPath(home), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (r.schemaVersion !== OPENCODE_SERVE_OWNER_SCHEMA_VERSION) return null;
    if (typeof r.pid !== 'number' || !Number.isInteger(r.pid) || r.pid <= 0) return null;
    if (typeof r.start !== 'string' || r.start.length === 0) return null;
    if (typeof r.comm !== 'string') return null; // comm may legitimately be '' (best-effort at write time)
    if (typeof r.baseUrl !== 'string' || r.baseUrl.length === 0) return null;
    if (typeof r.recordedAtMs !== 'number' || !Number.isFinite(r.recordedAtMs)) return null;
    return {
      schemaVersion: OPENCODE_SERVE_OWNER_SCHEMA_VERSION,
      pid: r.pid,
      start: r.start,
      comm: r.comm,
      baseUrl: r.baseUrl,
      recordedAtMs: r.recordedAtMs,
    };
  } catch {
    return null;
  }
}

/** Persist the ownership record (owner-only, atomic). Best-effort: a write failure just degrades to
 *  "unproven next time" (we then preserve rather than reclaim) — it never breaks startup. */
function writeOwnershipRecord(identity: ProcessIdentity, baseUrl: string, home = setupStateHome()): void {
  try {
    const record: OpencodeServeOwnership = {
      schemaVersion: OPENCODE_SERVE_OWNER_SCHEMA_VERSION,
      pid: identity.pid,
      start: identity.start,
      comm: identity.comm,
      baseUrl,
      recordedAtMs: Date.now(),
    };
    atomicWriteJsonOwnerOnly(ownerRecordPath(home), record);
  } catch {
    /* ownership proof degrades safely to "preserve" — never break the managed runtime over a state write */
  }
}

/** Remove the ownership record (the broker-owned serve is gone / being replaced). */
function clearOwnershipRecord(home = setupStateHome()): void {
  try {
    rmSync(ownerRecordPath(home), { force: true });
  } catch {
    /* already gone */
  }
}

/** Read a live process's stable identity. Returns null when it can't be determined — the caller then treats
 *  ownership as INDETERMINATE and PRESERVES the serve (never touches a process it can't identify). */
export function readProcessIdentity(pid: number): ProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      // `/proc/<pid>/stat`: `pid (comm) state ...`. comm may contain spaces/parens, so parse AFTER the last
      // ')'. The remaining fields start at `state` (field 3); starttime is field 22 → index 19 from there.
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const rparen = stat.lastIndexOf(')');
      if (rparen < 0) return null;
      const after = stat.slice(rparen + 1).trim().split(/\s+/);
      const start = after[19];
      if (!start) return null;
      let comm = '';
      try { comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { /* best-effort */ }
      return { pid, start, comm };
    } catch {
      return null;
    }
  }
  // macOS / other unix: `ps -o lstart=` is an absolute (stable) start time; `-o comm=` the executable.
  const ps = Bun.which('ps');
  if (!ps) return null;
  const psField = (fmt: string): string | undefined => {
    try {
      const res = Bun.spawnSync([ps, '-o', fmt, '-p', String(pid)], {
        stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', env: { ...process.env }, timeout: 3000,
      });
      if (res.exitCode !== 0) return undefined;
      const out = new TextDecoder().decode(res.stdout).trim();
      return out || undefined;
    } catch {
      return undefined;
    }
  };
  const start = psField('lstart=');
  if (!start) return null;
  return { pid, start, comm: psField('comm=') ?? '' };
}

export type ServeOwnershipVerdict = 'owned' | 'unowned' | 'indeterminate';

/**
 * Pure ownership decision (unit-testable without processes). We reclaim (dispose/kill+respawn) ONLY a serve
 * we can prove this broker started; everything else is preserved untouched:
 *  - live identity unresolved            → 'indeterminate' (never touch a process we can't identify)
 *  - no record / base mismatch           → 'unowned' (not ours)
 *  - pid mismatch                        → 'unowned' (stale record; the serve we started is gone)
 *  - pid matches but start token differs → 'unowned' (pid reuse — a different process now holds it)
 *  - pid+start match but comm differs    → 'unowned' (pid reuse by a different program)
 *  - pid + start + comm all match        → 'owned'
 */
export function classifyServeOwnership(
  record: OpencodeServeOwnership | null,
  live: ProcessIdentity | null,
  base: string,
): ServeOwnershipVerdict {
  if (!live) return 'indeterminate';
  if (!record || record.baseUrl !== base) return 'unowned';
  if (record.pid !== live.pid) return 'unowned';
  if (record.start !== live.start) return 'unowned';
  if (record.comm !== live.comm) return 'unowned';
  return 'owned';
}

/** Test seam: override how the live listener's identity is resolved so the wiring is deterministic without
 *  depending on lsof / `/proc` / `ps` in CI. null → use the real resolver (production path). */
let liveIdentityOverrideForTest: ((port: number) => ProcessIdentity | null) | null = null;

/** Resolve the identity of the process listening on `port` (lsof → pid → OS identity), or the test override. */
function resolveLiveIdentity(port: number): ProcessIdentity | null {
  if (liveIdentityOverrideForTest) return liveIdentityOverrideForTest(port);
  const pid = pidListeningOnPort(port);
  return pid !== undefined ? readProcessIdentity(pid) : null;
}

/** True when the operator explicitly authorized replacing an UNPROVEN serve (not merely opting in to autoserve). */
function replaceUnownedServeRequested(): boolean {
  const raw = process.env.COSYNCING_OPENCODE_REPLACE_UNOWNED_SERVE;
  return !!raw && raw !== '0';
}

function identityMatches(a: ProcessIdentity | null, b: ProcessIdentity): boolean {
  return a !== null && a.pid === b.pid && a.start === b.start && a.comm === b.comm;
}

/**
 * A serve is reachable at our managed local base and we either PROVED it is ours (`expected` = the proven
 * identity) or the operator authorized replacing an unproven one (`expected` = null). Free the port so the
 * broker can relaunch: graceful `POST /instance/dispose` first, then signal the listening process (SIGTERM,
 * escalate to SIGKILL).
 *
 * TOCTOU guard (Codex finding 1): ownership was proven at classification time, but the proven process can
 * exit and ANOTHER serve grab the port before we act. So when `expected` is set we re-resolve the live
 * listener's identity IMMEDIATELY before every dispose/signal and abort (preserve) if it no longer matches —
 * we must never dispose or kill a replacement stranger. This includes the window BETWEEN the two
 * port-addressed dispose calls: /instance/dispose can make the proven process exit and free the port, so we
 * re-prove ownership (and stop early if the port already freed) before ever issuing /global/dispose ("dispose
 * ALL instances"), which would otherwise land on whatever grabbed the port. We also signal ONLY the expected
 * pid (re-resolved), and never our own pid. When `expected` is null the operator explicitly opted into
 * replacing whatever is there, so the identity guard is skipped (still never our own pid). Fail-safe: any path
 * that can't free the port returns false and the caller leaves the serve in place (degraded, never adopted).
 */
async function takeOverExistingServe(baseUrl: string, expected: ProcessIdentity | null, graceMs = 3000): Promise<boolean> {
  const port = Number(new URL(baseUrl).port) || 4096;
  const stillExpected = (): boolean => !expected || identityMatches(resolveLiveIdentity(port), expected);

  // 1. Graceful shutdown via OpenCode's dispose endpoints, confirmed by the port actually freeing. Both are
  //    PORT-addressed, so re-prove ownership before EACH and stop the instant the port frees — never let
  //    /global/dispose land on a stranger that grabbed the port after our process exited from the first call.
  if (!stillExpected()) return false; // the proven serve is gone/replaced — never dispose a stranger
  await postDispose(baseUrl, '/instance/dispose');
  if (await waitUntilPortFree(baseUrl, Math.min(graceMs, 1000))) return true;
  if (!stillExpected()) return false; // re-prove before the broader "dispose all instances" call
  await postDispose(baseUrl, '/global/dispose');
  if (await waitUntilPortFree(baseUrl, graceMs)) return true;

  // 2. Force: signal the OS process holding the port. Re-validate immediately before signaling, signal ONLY
  //    the expected pid (re-resolved), and never our own pid (in tests the fake serve is in-process).
  if (!stillExpected()) return false;
  const pid = pidListeningOnPort(port);
  if (!pid || pid === process.pid) return false;
  if (expected && (pid !== expected.pid || !identityMatches(readProcessIdentity(pid), expected))) return false;
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  if (await waitUntilPortFree(baseUrl, graceMs)) return true;

  // 3. Escalate to SIGKILL — SIGTERM may have freed the port and a stranger taken it, so re-resolve and
  //    re-validate the pid one more time before the harder signal.
  if (!stillExpected()) return false;
  const pid2 = pidListeningOnPort(port);
  if (!pid2 || pid2 === process.pid) return false;
  if (expected && (pid2 !== expected.pid || !identityMatches(readProcessIdentity(pid2), expected))) return false;
  try { process.kill(pid2, 'SIGKILL'); } catch { /* already gone */ }
  return waitUntilPortFree(baseUrl, graceMs);
}

function registerTeardown(): void {
  if (teardownRegistered) return;
  teardownRegistered = true;
  const kill = () => {
    try {
      managed?.kill();
    } catch {
      /* already gone */
    }
    managed = null;
  };
  // Last-resort synchronous cleanup for an unexpected process exit. Normal SIGINT/SIGTERM handling
  // belongs to the broker runtime boundary, which stops accepting work and awaits child teardown.
  process.on('exit', kill);
}

/**
 * Launch a broker-owned `opencode serve` if appropriate (see module doc). Best-effort and non-fatal:
 * any failure leaves OpenCode on its observe/resume path. Safe to call once at broker startup.
 */
export async function ensureManagedOpencodeServe(shouldContinue: () => boolean = () => true): Promise<void> {
  if (!shouldContinue()) return;
  const optOut = process.env.COSYNCING_OPENCODE_NO_AUTOSERVE;
  if (optOut && optOut !== '0') return;

  const raw = (process.env.OPENCODE_URL ?? 'http://127.0.0.1:4096').replace(/\/$/, '');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return;
  }
  if (!isLocalHost(u.hostname)) return; // remote serve — not ours to manage (D20 owns only local)
  // Resolve the base via the SHARED helper so the probe and the spawn target EXACTLY what the OpenCode
  // adapter connects to (both read OPENCODE_URL; a portless local URL pins to :4096). This is what prevents
  // broker↔adapter port divergence — without it the adapter would hit the implicit :80/:443 while we launch
  // :4096, and a no-port URL would also make us probe :80, loop "not reachable", and re-spawn every restart.
  const base = resolveLocalOpencodeBaseUrl(raw);
  const bu = new URL(base);
  if (await serveReachable(base)) {
    // A serve is already listening at our managed base. If WE already own it in THIS process, nothing to do.
    if (managed && managedBaseUrl === base) return;

    // SAFETY: :4096 is OpenCode's default port, so this may be the USER'S OWN serve. Never dispose or kill a
    // serve we can't PROVE we started. Verify the durable ownership record against the live listener.
    const port = Number(bu.port) || 4096;
    const live = resolveLiveIdentity(port);
    const verdict = classifyServeOwnership(readOwnershipRecord(), live, base);

    if (verdict === 'owned' || replaceUnownedServeRequested()) {
      // Proven ours (reclaim our previous orphan) OR the operator authorized replacing an unproven serve.
      // Pass the proven identity so the take-over re-validates it before every dispose/signal (owned); for the
      // operator-forced case there is no proven identity to guard against (`live` may be null/mismatched).
      const expected = verdict === 'owned' ? live : null;
      if (!(await takeOverExistingServe(base, expected))) {
        clearOwnershipRecord();
        console.log(`${LOG_PREFIX} could not reclaim the opencode serve at ${base}; leaving it in place — config-driven model reloads won't apply until the broker owns a serve here (D20)`);
        return;
      }
      if (!shouldContinue()) return;
      // fall through to the broker-owned spawn below (which rewrites the ownership record)
    } else {
      // Unproven ('unowned') or unidentifiable ('indeterminate'): PRESERVE it. Config reloads won't apply to
      // a serve we don't own — the safe default. A serve started before cosyncing managed one lands here too.
      const why = verdict === 'indeterminate' ? "couldn't identify the process holding the port" : 'not started by cosyncing';
      console.log(`${LOG_PREFIX} an opencode serve is already running at ${base} that cosyncing did not start (${why}); leaving it untouched — config-driven model reloads won't apply. Stop it and restart the broker, or set COSYNCING_OPENCODE_REPLACE_UNOWNED_SERVE=1 to replace it (COSYNCING_OPENCODE_NO_AUTOSERVE=1 silences this).`);
      return;
    }
  }
  if (!shouldContinue()) return;

  const bin = Bun.which('opencode');
  if (!bin) return; // not installed → OpenCode stays observe/resume only
  if (!shouldContinue()) return;

  let child: Bun.Subprocess;
  let stdout: ReturnType<typeof boundedStreamCapture> | undefined;
  let stderr: ReturnType<typeof boundedStreamCapture> | undefined;
  try {
    const spawned = Bun.spawn([bin, 'serve', '--hostname', bu.hostname, '--port', bu.port || '4096'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    });
    child = spawned;
    stdout = boundedStreamCapture(spawned.stdout);
    stderr = boundedStreamCapture(spawned.stderr);
    managed = child;
    managedStartedAt = Date.now();
    managedBaseUrl = base;
  } catch (err) {
    recordStartFailure('opencode-serve-spawn-error', String(err));
    console.error(`${LOG_PREFIX} failed to launch managed opencode serve`);
    managed = null;
    return;
  }
  registerTeardown();

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    if (!shouldContinue()) {
      if (managed === child) await stopManagedOpencodeServe();
      return;
    }
    if (child.exitCode != null) {
      if (stdout && stderr) await Promise.all([stdout.done, stderr.done]);
      recordStartFailure(
        'opencode-serve-exited',
        stdout && stderr ? capturedOutput(stdout, stderr) : '',
      );
      console.error(`${LOG_PREFIX} managed opencode serve exited before becoming reachable`);
      if (managed === child) {
        managed = null;
        managedBaseUrl = null;
      }
      return;
    }
    if (await serveReachable(base)) {
      if (!shouldContinue()) {
        if (managed === child) await stopManagedOpencodeServe();
        return;
      }
      clearStartFailure();
      // Record ownership so a later broker restart can PROVE this serve is ours and reclaim it (rather than
      // preserving it as a stranger's). If we can't fingerprint our own child, clear any stale record so we
      // never falsely claim ownership — next restart then preserves it instead of killing it.
      const identity = child.pid ? readProcessIdentity(child.pid) : null;
      if (identity) writeOwnershipRecord(identity, base);
      else clearOwnershipRecord();
      console.log(`${LOG_PREFIX} managed opencode serve ready at ${base} (pid ${child.pid}) — OpenCode sync-by-default (D20)`);
      return;
    }
  }
  recordStartFailure(
    'opencode-serve-start-timeout',
    stdout && stderr ? capturedOutput(stdout, stderr) : '',
  );
  console.error(`${LOG_PREFIX} managed opencode serve not reachable at ${base} after 8s; OpenCode stays observe/resume`);
}

async function managedOpencodeRunningVersion(): Promise<string | undefined> {
  if (!managed || !managedBaseUrl) return undefined;
  try {
    const response = await fetch(`${managedBaseUrl}/global/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return undefined;
    const body: any = await response.json();
    const version = normalizeOpencodeVersion(String(body?.version ?? ''));
    return version || undefined;
  } catch {
    return undefined;
  }
}

function installedOpencodeVersion(): string | undefined {
  const bin = Bun.which('opencode');
  if (!bin) return undefined;
  try {
    // timeout: this runs synchronously ON the broker event loop (every poll + every status GET) — a
    // hung binary must not freeze the whole broker.
    const result = Bun.spawnSync([bin, '--version'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env }, timeout: 3000 });
    if (result.exitCode !== 0) return undefined;
    const version = normalizeOpencodeVersion(new TextDecoder().decode(result.stdout));
    return version || undefined;
  } catch {
    return undefined;
  }
}

export async function readManagedOpencodeVersions(): Promise<{ managed: boolean; installedVersion?: string; runningVersion?: string; detail?: string }> {
  if (!managed) return { managed: false, detail: 'OpenCode serve is external, disabled, unavailable, or not yet broker-managed.' };
  const [runningVersion, installedVersion] = await Promise.all([
    managedOpencodeRunningVersion(),
    Promise.resolve(installedOpencodeVersion()),
  ]);
  return {
    managed: true,
    ...(installedVersion ? { installedVersion } : {}),
    ...(runningVersion ? { runningVersion } : {}),
    ...(!installedVersion || !runningVersion ? { detail: 'Could not compare the managed serve version with the installed OpenCode CLI.' } : {}),
  };
}

export async function restartManagedOpencodeRuntime(shouldContinue: () => boolean = () => true): Promise<void> {
  if (managedLifecycleRestart) return managedLifecycleRestart;
  if (!managed) throw new Error('OpenCode serve is not managed by this broker.');
  managedLifecycleRestart = (async () => {
    if (!shouldContinue()) return;
    await stopManagedOpencodeServe();
    if (!shouldContinue()) return;
    await ensureManagedOpencodeServe(shouldContinue);
    if (!shouldContinue()) return;
    if (!managed) throw new Error('Managed OpenCode serve did not restart under broker ownership.');
  })();
  try {
    await managedLifecycleRestart;
  } finally {
    managedLifecycleRestart = null;
  }
}

// ── config-staleness watch (issues-part2) ───────────────────────────────────
// OpenCode's serve loads providers/models ONCE at startup: after a config edit the /api/model LIST
// endpoint re-reads the file, but SENDS with a newly-added model fail (verified live: doubao-seed-code
// listed, send → UnknownError). Since the broker OWNS this serve, restart it when the config file is
// newer than the process — that's what "auto-detect new models" means in practice for OpenCode.
let configWatchTimer: ReturnType<typeof setInterval> | null = null;
let restartInFlight = false;
// C5 guardrail state: when the config first looks stale we record the wall-clock so a restart that is
// deferred (because a turn is in flight) can eventually proceed past a max-defer cap. 0 = none pending.
let pendingRestartSince = 0;

export interface OpencodeConfigWatchOptions {
  /** Poll interval for the config-staleness check. */
  intervalMs?: number;
  /**
   * C5 serve-restart guardrail: returns true while a turn is in flight on the managed serve. When
   * provided and true, the restart is DEFERRED (the new provider/model loads after the turn finishes)
   * rather than interrupting the turn — unless the deferral exceeds `maxDeferMs`, at which point a hung
   * turn must not block new-model loading forever and we restart anyway. Best-effort: any throw ⇒ idle.
   */
  isBusy?: () => boolean;
  /** Process-lifecycle guard checked immediately before restarting a managed child. */
  shouldContinue?: () => boolean;
  /** Cap on how long a restart may be deferred while busy before proceeding regardless (default 10 min,
   *  or `COSYNCING_OPENCODE_SERVE_RESTART_MAX_DEFER_MS`). */
  maxDeferMs?: number;
}

function opencodeConfigPaths(): string[] {
  const xdg = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  const paths = [join(xdg, 'opencode', 'opencode.json'), join(xdg, 'opencode', 'opencode.jsonc')];
  const explicit = process.env.OPENCODE_CONFIG?.trim();
  if (explicit) paths.unshift(explicit);
  return paths;
}

/** Global agent-definition directories whose edits change the managed serve's behaviour and so warrant a
 *  reload — OpenCode reads `agent/*.md` (and inline `opencode.json` agents, already watched above) once at
 *  serve startup. Project-local `.opencode/agent` is intentionally excluded: it is per-cwd, not part of
 *  this one global broker-owned serve. XDG-based like the config files. */
function opencodeAgentDirs(): string[] {
  const xdg = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return [join(xdg, 'opencode', 'agent')];
}

/** Newest mtime across a directory tree: the directory itself (catches add/remove/rename) plus every
 *  regular file within (catches content edits). Bounded by depth and a file budget so a pathological tree
 *  can never stall the 20s poll; symlinks are skipped (Dirent type is neither file nor dir) so there is no
 *  loop risk. Returns 0 when the root is absent/unreadable. */
function newestTreeMtime(root: string, depth = 6, budget = { files: 2000 }): number {
  let newest = 0;
  try {
    newest = statSync(root).mtimeMs; // dir mtime catches add/remove/rename
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (budget.files <= 0) break;
      const child = join(root, entry.name);
      try {
        if (entry.isDirectory()) {
          if (depth > 0) newest = Math.max(newest, newestTreeMtime(child, depth - 1, budget));
        } else if (entry.isFile()) {
          budget.files -= 1;
          newest = Math.max(newest, statSync(child).mtimeMs);
        }
      } catch {
        /* raced: the entry vanished between readdir and stat — ignore */
      }
    }
  } catch {
    /* root absent/unreadable, or readdir failed → return whatever mtime we resolved (0 if none) */
  }
  return newest;
}

/** Newest mtime across every input that governs the managed serve's providers/models/agents: the config
 *  files plus the global agent-definition dirs. The config-staleness watch restarts when this exceeds the
 *  serve's start time. Exported for tests. */
export function newestConfigMtime(): number {
  let newest = 0;
  for (const p of opencodeConfigPaths()) {
    try {
      newest = Math.max(newest, statSync(p).mtimeMs);
    } catch {
      /* absent */
    }
  }
  for (const dir of opencodeAgentDirs()) {
    newest = Math.max(newest, newestTreeMtime(dir));
  }
  return newest;
}

/**
 * Pure decision for the config-staleness watch (extracted so the C5 guardrail is unit-testable without
 * spawning a serve). Given the current config/serve mtimes, the pending-restart clock, whether a turn is
 * in flight, and the max-defer cap, decide whether to restart NOW and what the next pending clock is.
 *
 * - config not newer than the running serve → no restart, clear the pending clock.
 * - newer + idle → restart now.
 * - newer + busy + within the cap → DEFER (no restart), keep/start the pending clock (C5 guardrail).
 * - newer + busy + past the cap → restart anyway (a hung turn must not block new-model loading forever).
 */
export function evaluateConfigRestart(input: {
  cfgMtime: number;
  managedStartedAt: number;
  pendingSince: number;
  now: number;
  busy: boolean;
  maxDeferMs: number;
}): { restart: boolean; pendingSince: number; deferredMs: number } {
  const { cfgMtime, managedStartedAt, now, busy, maxDeferMs } = input;
  if (cfgMtime <= managedStartedAt + 1000) return { restart: false, pendingSince: 0, deferredMs: 0 };
  const pendingSince = input.pendingSince === 0 ? now : input.pendingSince;
  const deferredMs = now - pendingSince;
  if (busy && deferredMs < maxDeferMs) return { restart: false, pendingSince, deferredMs };
  return { restart: true, pendingSince, deferredMs };
}

/** Poll the config/agent-definition mtime and restart the MANAGED serve when any of them is newer than the
 *  process (a new provider/model in opencode.json, or an edited/added `agent/*.md`). Only a serve we own is
 *  ever restarted; an external serve just logs a hint. The restart is DEFERRED while a turn is in flight
 *  (C5 guardrail) so an edit never interrupts an active turn, up to a max-defer cap so a hung turn can't
 *  block reloading forever. Attached OpenCode TUIs auto-reconnect across the restart, so this is safe. */
export function startOpencodeConfigWatch(opts: OpencodeConfigWatchOptions = {}): void {
  if (configWatchTimer) return;
  const intervalMs = opts.intervalMs ?? 20_000;
  const envCap = Number(process.env.COSYNCING_OPENCODE_SERVE_RESTART_MAX_DEFER_MS);
  const maxDeferMs = opts.maxDeferMs ?? (Number.isFinite(envCap) && envCap > 0 ? envCap : 10 * 60_000);
  configWatchTimer = setInterval(() => {
    void (async () => {
      if (opts.shouldContinue?.() === false || restartInFlight || !managed || managedStartedAt === 0) return;
      let busy = false;
      try {
        busy = opts.isBusy?.() ?? false;
      } catch {
        busy = false; // best-effort: an unavailable liveness signal must not block the reload
      }
      const decision = evaluateConfigRestart({
        cfgMtime: newestConfigMtime(),
        managedStartedAt,
        pendingSince: pendingRestartSince,
        now: Date.now(),
        busy,
        maxDeferMs,
      });
      pendingRestartSince = decision.pendingSince;
      if (!decision.restart) return;
      if (opts.shouldContinue?.() === false) return;

      restartInFlight = true;
      try {
        const why = busy ? `deferred ${Math.round(decision.deferredMs / 1000)}s, exceeded the busy cap` : decision.deferredMs > intervalMs ? `deferred ${Math.round(decision.deferredMs / 1000)}s until idle` : 'serve idle';
        console.log(`${LOG_PREFIX} opencode config changed — restarting the managed serve to load new providers/models (${why})`);
        await restartManagedOpencodeRuntime(opts.shouldContinue);
        pendingRestartSince = 0;
      } finally {
        restartInFlight = false;
      }
    })();
  }, intervalMs);
  if (typeof configWatchTimer.unref === 'function') configWatchTimer.unref();
}

export function stopOpencodeConfigWatch(): void {
  if (configWatchTimer) {
    clearInterval(configWatchTimer);
    configWatchTimer = null;
  }
  pendingRestartSince = 0;
}

/** Test-only reset of the config-watch deferral state. */
export function __resetOpencodeConfigWatchForTest(): void {
  stopOpencodeConfigWatch();
  restartInFlight = false;
}

/** Test-only read of managed-serve ownership state (the take-over path in ensureManagedOpencodeServe). */
export function __getManagedOpencodeServeStateForTest(): {
  managed: boolean;
  managedStartedAt: number;
  managedBaseUrl: string | null;
  pid: number | undefined;
} {
  return { managed: managed !== null, managedStartedAt, managedBaseUrl, pid: managed?.pid };
}

/** Test-only: override the live-listener identity resolver so ownership wiring is deterministic without
 *  lsof / `/proc` / `ps`. Pass null to restore the production resolver. */
export function __setLiveIdentityOverrideForTest(fn: ((port: number) => ProcessIdentity | null) | null): void {
  liveIdentityOverrideForTest = fn;
}

/** Test-only: write a durable ownership record so the take-over path classifies a reachable serve as OWNED. */
export function __writeOpencodeServeOwnershipForTest(identity: ProcessIdentity, baseUrl: string): void {
  writeOwnershipRecord(identity, baseUrl);
}

/** Test-only: remove any durable ownership record. */
export function __clearOpencodeServeOwnershipForTest(): void {
  clearOwnershipRecord();
}

/**
 * Stop the broker-owned serve and WAIT for it to actually exit. Used on restart, where the replacement
 * broker must find the port freed: a fire-and-forget kill can leave the old child still holding it, so the
 * replacement's reachability probe sees "already up" and DROPS the orphan from management (an untracked
 * serve that survives the very restart meant to re-own it — D20). SIGTERM, escalate to SIGKILL after a
 * grace, then await exit. No-op if we never launched one.
 */
export async function stopManagedOpencodeServe(graceMs = 2000): Promise<void> {
  const m = managed;
  managed = null;
  managedBaseUrl = null;
  if (!m) return;
  // The serve we owned is going away (shutdown or restart). Drop the ownership record so a stale pid is never
  // reclaimed later; the restart path rewrites a fresh record once the replacement serve is ready.
  clearOwnershipRecord();
  try {
    m.kill(); // SIGTERM
    const killer = setTimeout(() => {
      try {
        m.kill(9); // escalate if it ignores SIGTERM
      } catch {
        /* already gone */
      }
    }, graceMs);
    await m.exited;
    clearTimeout(killer);
  } catch {
    /* already gone */
  }
}
