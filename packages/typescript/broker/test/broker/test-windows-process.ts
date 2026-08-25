#!/usr/bin/env bun
import assert from 'node:assert/strict';
import {
  parseWindowsProcessSnapshot,
  WindowsProcessProvider,
  type WindowsProcessSnapshot,
} from '../../src/runtime/windows-process.ts';

const complete: WindowsProcessSnapshot = {
  processesOk: true,
  listenersOk: true,
  processes: [{
    pid: 4242,
    parentPid: 1,
    start: '2026-08-21T09:10:11.1234567Z',
    name: 'bun.exe',
    executable: 'C:\\Users\\owner\\.bun\\bin\\bun.exe',
  }],
  listeners: [
    { port: 4096, pid: 4242, address: '127.0.0.1' },
    { port: 4096, pid: 4242, address: '::1' },
  ],
};

const encoded = JSON.stringify(complete);
assert.deepEqual(parseWindowsProcessSnapshot(encoded), complete);
assert.equal(parseWindowsProcessSnapshot('{"processesOk":true}'), null);
assert.equal(parseWindowsProcessSnapshot(JSON.stringify({
  ...complete,
  processes: [{ ...complete.processes[0], pid: 0 }],
})), null);

let calls = 0;
let clock = 1_000;
const provider = new WindowsProcessProvider({
  platform: 'win32',
  runWindowsSnapshot: () => {
    calls += 1;
    return structuredClone(complete);
  },
  now: () => clock,
  windowsSnapshotTtlMs: 250,
});

assert.deepEqual(provider.liveProcess(4242), {
  state: 'running',
  identity: {
    pid: 4242, start: '2026-08-21T09:10:11.1234567Z', boot: '', comm: 'bun.exe',
    executable: 'C:\\Users\\owner\\.bun\\bin\\bun.exe',
  },
});
assert.deepEqual(provider.listener(4096), { state: 'identified', pid: 4242 });
assert.equal(calls, 1, 'ordinary process and listener reads share one snapshot');

clock += 10;
assert.deepEqual(provider.liveProcess(4242, { fresh: true }), {
  state: 'running',
  identity: {
    pid: 4242, start: '2026-08-21T09:10:11.1234567Z', boot: '', comm: 'bun.exe',
    executable: 'C:\\Users\\owner\\.bun\\bin\\bun.exe',
  },
});
assert.equal(calls, 2, 'fresh identity proof bypasses the cache');

assert.deepEqual(new WindowsProcessProvider({ platform: 'win32', runWindowsSnapshot: () => ({
  ...complete,
  processes: [{ ...complete.processes[0]!, executable: null }],
}) }).liveProcess(4242), { state: 'unknown' });
assert.deepEqual(new WindowsProcessProvider({ platform: 'win32', runWindowsSnapshot: () => ({ ...complete, processes: [] }) }).liveProcess(4242), { state: 'absent' });
assert.deepEqual(new WindowsProcessProvider({ platform: 'win32', runWindowsSnapshot: () => ({ ...complete, processesOk: false }) }).liveProcess(4242), { state: 'unknown' });
assert.deepEqual(new WindowsProcessProvider({ platform: 'win32', runWindowsSnapshot: () => ({ ...complete, listeners: [] }) }).listener(4096), { state: 'absent' });
assert.deepEqual(new WindowsProcessProvider({ platform: 'win32', runWindowsSnapshot: () => ({
  ...complete,
  listeners: [...complete.listeners, { port: 4096, pid: 5151, address: '0.0.0.0' }],
}) }).listener(4096), { state: 'unknown' });
assert.deepEqual(new WindowsProcessProvider({ platform: 'win32', runWindowsSnapshot: () => ({ ...complete, listenersOk: false }) }).listener(4096), { state: 'unknown' });
assert.deepEqual(new WindowsProcessProvider({ platform: 'win32', runWindowsSnapshot: () => null }).listener(4096), { state: 'unknown' });

console.log('PASS 15/15 Windows process-provider checks');
