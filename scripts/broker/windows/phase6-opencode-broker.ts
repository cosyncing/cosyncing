#!/usr/bin/env bun
/**
 * One broker lifetime, as a separate process, for the Phase 6 OpenCode slice.
 *
 * The claim the slice exists to test is about what survives a broker RESTART, and module state is
 * what a restart clears. Calling `ensureManagedOpencodeServe()` twice inside one process proves
 * nothing: the second call sees `managed` still set and returns early. So each broker lifetime is a
 * real process that imports the module fresh, reads the durable ownership record from a file, and
 * exits — leaving whatever the product leaves behind.
 *
 * Modes:
 *   start        — ensure a serve, report what was recorded, exit cleanly. The module's exit teardown
 *                  runs, so this is a graceful broker shutdown and leaves no serve behind.
 *   crash        — ensure a serve, then die WITHOUT running any exit handler. This is what the
 *                  ownership record exists for: a killed service, a crash, a power-cut broker. The
 *                  serve survives, and the next broker must prove it is ours before reclaiming it.
 *   restart-stop — ensure again (this is the restart), then stop through the product's own stop.
 *
 * Writes one JSON line to stdout. Never prints a path outside the disposable root, and never a
 * session identifier: this process only starts and stops a server.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { HostProcessProvider } from '../../../packages/typescript/adapter-api/src/host-process.ts';
import { resolveLocalOpencodeBaseUrl } from '../../../packages/typescript/adapters/opencode/src/implementation.ts';
import {
  classifyServeOwnership,
  configureManagedOpencodeServeState,
  ensureManagedOpencodeServe,
  readProcessIdentity,
  stopManagedOpencodeServe,
  OPENCODE_SERVE_OWNER_SCHEMA_VERSION,
  __getManagedOpencodeServeStateForTest,
  type OpencodeServeOwnership,
  type ProcessIdentity,
} from '../../../packages/typescript/adapters/opencode/src/managed-server.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Phase 6 OpenCode broker requires ${name}`);
  return value;
}

const recordPath = required('COSYNCING_PHASE6_OC_RECORD');
// The report goes to a FILE, not stdout. The product logs to stdout too, and a report that shares a
// pipe with another writer depends on the reader winning a race it does not have to win.
const reportPath = required('COSYNCING_PHASE6_OC_REPORT');
const mode = required('COSYNCING_PHASE6_OC_MODE');
if (mode !== 'start' && mode !== 'crash' && mode !== 'restart-stop') {
  throw new Error(`unknown broker mode: ${mode}`);
}

const base = resolveLocalOpencodeBaseUrl((required('OPENCODE_URL')).replace(/\/$/, ''));
const port = Number(new URL(base).port) || 4096;
const hostProcesses = new HostProcessProvider();

/** The listener's identity, resolved exactly the way the product resolves it. */
function listenerIdentity(): { pid?: number; state: string; identity: ProcessIdentity | null } {
  const listener = hostProcesses.listener(port, { fresh: true });
  if (listener.state !== 'identified') return { state: listener.state, identity: null };
  return { state: listener.state, pid: listener.pid, identity: readProcessIdentity(listener.pid, { fresh: true }) };
}

function readRecord(): OpencodeServeOwnership | null {
  try {
    const parsed = JSON.parse(readFileSync(recordPath, 'utf8')) as OpencodeServeOwnership;
    return parsed?.schemaVersion === OPENCODE_SERVE_OWNER_SCHEMA_VERSION ? parsed : null;
  } catch { return null; }
}

async function reachable(timeoutMs = 1_500): Promise<boolean> {
  try {
    const response = await fetch(`${base}/app`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok || response.status === 404;
  } catch { return false; }
}

// Durable persistence, standing in for the broker's own. Every effect is counted so "it reclaimed"
// and "it preserved" are told apart by what the product DID, not by parsing a log line.
const writes: Array<{ pid: number; comm: string; baseUrl: string }> = [];
let clears = 0;
let startFailure: { detailCode: string } | undefined;
configureManagedOpencodeServeState({
  readOwnership: () => readRecord(),
  writeOwnership: (identity, baseUrl) => {
    writes.push({ pid: identity.pid, comm: identity.comm, baseUrl });
    const record: OpencodeServeOwnership = {
      ...identity,
      baseUrl,
      schemaVersion: OPENCODE_SERVE_OWNER_SCHEMA_VERSION,
      recordedAtMs: Date.now(),
    };
    writeFileSync(recordPath, JSON.stringify(record));
  },
  clearOwnership: () => { clears += 1; try { rmSync(recordPath, { force: true }); } catch { /* already gone */ } },
  // The captured output is the serve's own stderr and may name paths; only the code is kept.
  recordStartFailure: (detailCode) => { startFailure = { detailCode }; },
  clearStartFailure: () => { startFailure = undefined; },
});

const report: Record<string, unknown> = { mode, port };
// Every step is named as it is entered. This process's whole contract is to print ONE json line, so
// it must hold on the failure path too: a crash that prints nothing tells the probe only that the
// stream ended, which is the least informative thing that can happen and cost a run to learn.
let step = 'start';
try {
  const recordBefore = readRecord();
  step = 'listener-before';
  const liveBefore = listenerIdentity();
  report.reachableBefore = await reachable();
  report.recordBefore = recordBefore ? { pid: recordBefore.pid, comm: recordBefore.comm } : null;
  report.listenerBefore = { state: liveBefore.state, pid: liveBefore.pid, comm: liveBefore.identity?.comm };
  // The product's own verdict on what it found, from the product's own function.
  report.verdictBefore = classifyServeOwnership(recordBefore, liveBefore.identity, base);

  step = 'ensure-serve';
  await ensureManagedOpencodeServe();

  step = 'listener-after';
  const managedState = __getManagedOpencodeServeStateForTest();
  const liveAfter = listenerIdentity();
  const recordAfter = readRecord();
  report.spawnHandlePid = managedState.pid ?? null;
  report.managedInThisProcess = managedState.managed;
  report.reachableAfter = await reachable();
  report.listenerAfter = { state: liveAfter.state, pid: liveAfter.pid, comm: liveAfter.identity?.comm };
  report.recordAfter = recordAfter ? { pid: recordAfter.pid, comm: recordAfter.comm } : null;
  report.verdictAfter = classifyServeOwnership(recordAfter, liveAfter.identity, base);
  report.ownershipWrites = writes;
  report.ownershipClears = clears;
  report.startFailure = startFailure ?? null;

  if (mode === 'restart-stop') {
    step = 'stop';
    await stopManagedOpencodeServe();
    const liveStopped = listenerIdentity();
    report.afterStop = {
      reachable: await reachable(),
      listener: { state: liveStopped.state, pid: liveStopped.pid, comm: liveStopped.identity?.comm },
    };
  }
  step = 'done';
} catch (error) {
  report.error = { step, reason: String(error).split('\n')[0]!.slice(0, 300) };
}
report.reachedStep = step;

await Bun.write(reportPath, JSON.stringify(report));
if (mode === 'crash') {
  // No teardown, no flush, no exit handler — exactly what a force-stopped service leaves behind.
  // The report is already on disk, which is why it is a file rather than a stream.
  process.kill(process.pid, 'SIGKILL');
}
// Also on stdout, where it is a convenience for a human reading a log rather than the contract.
await Bun.write(Bun.stdout, `${JSON.stringify(report)}\n`);
// Exit explicitly rather than letting the loop drain. It never would: the managed serve's stdout is
// held open by the module's own bounded diagnostic capture, so a broker with a running serve stays
// alive by construction — correct for a broker, fatal for a one-shot process someone is reading.
//
// This is also the faithful restart. `process.exit` runs the module's registered exit teardown, so
// `start` leaves exactly what a service restart leaves: on Windows that teardown kills the cmd.exe
// wrapper and orphans the opencode.exe holding the port, which is the state the next broker meets.
process.exit(0);
