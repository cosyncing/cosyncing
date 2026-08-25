#!/usr/bin/env bun
import assert from 'node:assert/strict';
import {
  captureWindowsProcessSnapshot,
  HostProcessProvider,
  terminateHostProcessTree,
} from '../../../packages/typescript/adapter-api/src/host-process.ts';

const mode = process.argv[2];
if (mode === '--grandchild') {
  setInterval(() => undefined, 60_000);
} else if (mode === '--server') {
  const grandchild = Bun.spawn([process.execPath, import.meta.path, '--grandchild'], {
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', windowsHide: true,
  });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('phase3') });
  console.log(JSON.stringify({ pid: process.pid, grandchildPid: grandchild.pid, port: server.port }));
  setInterval(() => undefined, 60_000);
} else {
  const root = process.env.COSYNCING_WINDOWS_PHASE3_ROOT;
  const runId = process.env.COSYNCING_WINDOWS_PHASE3_RUN_ID;
  const sourceCommit = process.env.COSYNCING_WINDOWS_PHASE3_SOURCE_COMMIT;
  if (process.platform !== 'win32' || !root || !runId || !sourceCommit) {
    throw new Error('Phase 3 process probe requires native Windows and an explicit run identity');
  }

  const child = Bun.spawn([process.execPath, import.meta.path, '--server'], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true,
  });
  const checks: Record<string, boolean> = {};
  try {
    const reader = child.stdout.getReader();
    let line = '';
    while (!line.includes('\n')) {
      const next = await reader.read();
      if (next.done) break;
      line += new TextDecoder().decode(next.value);
      if (line.length > 8_192) throw new Error('Phase 3 child announcement exceeded its bound');
    }
    reader.releaseLock();
    const announced = JSON.parse(line.split(/\r?\n/, 1)[0]!) as {
      pid: number; grandchildPid: number; port: number;
    };
    assert.equal(announced.pid, child.pid);

    const provider = new HostProcessProvider();
    const first = provider.liveProcess(announced.pid, { fresh: true });
    const second = provider.liveProcess(announced.pid, { fresh: true });
    checks.identityComplete = first.state === 'running'
      && first.identity.start.length > 0 && first.identity.comm.length > 0;
    checks.identityStable = first.state === 'running' && second.state === 'running'
      && first.identity.start === second.identity.start && first.identity.comm === second.identity.comm;
    checks.listenerAttributed = JSON.stringify(provider.listener(announced.port, { fresh: true }))
      === JSON.stringify({ state: 'identified', pid: announced.pid });

    const raw = captureWindowsProcessSnapshot();
    checks.processTableBatched = raw?.processesOk === true && raw.listenersOk === true
      && raw.processes.length > 0;
    const unreadable = raw?.processes.find((entry) => entry.executable === null);
    checks.unreadableExecutableFailsClosed = unreadable !== undefined
      && provider.liveProcess(unreadable.pid, { fresh: true }).state === 'unknown';

    terminateHostProcessTree(announced.pid, true);
    const deadline = Date.now() + 5_000;
    let parentState = provider.liveProcess(announced.pid, { fresh: true });
    let childState = provider.liveProcess(announced.grandchildPid, { fresh: true });
    while (Date.now() < deadline && (parentState.state !== 'absent' || childState.state !== 'absent')) {
      await Bun.sleep(50);
      parentState = provider.liveProcess(announced.pid, { fresh: true });
      childState = provider.liveProcess(announced.grandchildPid, { fresh: true });
    }
    checks.parentTerminated = parentState.state === 'absent';
    checks.childTreeTerminated = childState.state === 'absent';
    checks.listenerReleased = provider.listener(announced.port, { fresh: true }).state === 'absent';
    checks.hiddenSpawnRequested = true;

    assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks));
    console.log(JSON.stringify({
      schema: 1, runId, sourceCommit,
      sourceDirty: process.env.COSYNCING_WINDOWS_PHASE3_SOURCE_DIRTY === 'true',
      platform: process.platform, arch: process.arch, bunVersion: Bun.version,
      filesystem: 'NTFS', provider: 'Win32_Process + MSFT_NetTCPConnection',
      termination: 'taskkill /PID /T /F', checks, status: 'passed',
    }, null, 2));
  } finally {
    if (child.exitCode === null) terminateHostProcessTree(child.pid, true);
    await Promise.race([child.exited, Bun.sleep(5_000)]);
  }
}
