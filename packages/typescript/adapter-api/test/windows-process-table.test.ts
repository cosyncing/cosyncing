/**
 * The Windows process table read through the FFI layer instead of a PowerShell `Win32_Process` query.
 *
 * Everywhere: the pure pieces (a `FILETIME` as the snapshot's start string, the pid-reuse rule, one
 * `PROCESSENTRY32W`) and the snapshot built from a table. On Windows also the real table: this
 * process and a child it starts, ancestry through the shared provider's rules, and the table against
 * the PowerShell snapshot it replaces, process by process.
 */
import { describe, expect, test } from 'bun:test';
import {
  captureWindowsProcessSnapshotAsync,
  captureWindowsProcessTable,
  HostProcessProvider,
  readProcessEntry32W,
  windowsFfi,
  windowsFileTimeIso,
  windowsProcessStart,
  type WindowsProcessTableEntry,
} from '../src/index.ts';

const EPOCH = 116_444_736_000_000_000n;
const fileTime = (iso: string, ticks = 0n) => BigInt(Date.parse(iso)) * 10_000n + EPOCH + ticks;

describe('the start string', () => {
  test('is UTC in the seven-digit round-trip form, and orders like the time it names', () => {
    expect(windowsFileTimeIso(fileTime('2026-10-15T10:00:00.000Z', 1_234_567n))).toBe('2026-10-15T10:00:00.1234567Z');
    expect(windowsFileTimeIso(fileTime('2026-10-15T10:00:00.000Z', 42n))).toBe('2026-10-15T10:00:00.0000042Z');
    expect(windowsFileTimeIso(fileTime('2026-10-15T10:00:00.999Z', 9_999n))).toBe('2026-10-15T10:00:00.9999999Z');
    expect(windowsFileTimeIso(EPOCH)).toBe('1970-01-01T00:00:00.0000000Z');
    expect(windowsFileTimeIso(EPOCH - 1n)).toBe('');
    // The same shape PowerShell writes, so a table's starts compare as strings exactly as the ticks do.
    const ticks = [0n, 1n, 9n, 10n, 9_999_999n, 10_000_000n, 36_000_000_000n].map((step) => fileTime('2026-10-15T09:59:59.000Z', step));
    for (const a of ticks) {
      for (const b of ticks) {
        expect(windowsFileTimeIso(a) > windowsFileTimeIso(b)).toBe(a > b);
        expect(windowsFileTimeIso(a) === windowsFileTimeIso(b)).toBe(a === b);
      }
    }
  });

  test('is withheld for an unknown creation time and for a process created after the list was taken', () => {
    const listedAt = fileTime('2026-10-15T10:00:00.000Z');
    expect(windowsProcessStart(listedAt - 1n, listedAt)).toBe('2026-10-15T09:59:59.9999999Z');
    expect(windowsProcessStart(listedAt, listedAt)).toBe('2026-10-15T10:00:00.0000000Z');
    // The listed process exited and its pid went to a newer one: that start belongs to someone else.
    expect(windowsProcessStart(listedAt + 1n, listedAt)).toBe('');
    expect(windowsProcessStart(0n, listedAt)).toBe('');
  });
});

describe('one PROCESSENTRY32W', () => {
  const entryOf = (pid: number, parentPid: number, name: string) => {
    const bytes = new Uint8Array(568);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 568, true);
    view.setUint32(8, pid, true);
    view.setBigUint64(16, 0xdead_beefn, true);
    view.setUint32(28, 7, true);
    view.setUint32(32, parentPid, true);
    view.setInt32(36, 8, true);
    bytes.set(Buffer.from(name, 'utf16le'), 44);
    return bytes;
  };

  test('reads the pid, the parent pid and the image name up to its NUL', () => {
    expect(readProcessEntry32W(entryOf(4_242, 600, 'codex.exe'))).toEqual({ pid: 4_242, parentPid: 600, name: 'codex.exe' });
    expect(readProcessEntry32W(entryOf(0xffff_fffc, 0, '[System Process]'))).toEqual({ pid: 0xffff_fffc, parentPid: 0, name: '[System Process]' });
    // A name filling all of MAX_PATH has no NUL inside the field (the padding after it is not zero
    // either); the read stops at the field's end.
    expect(readProcessEntry32W(entryOf(5, 4, 'x'.repeat(262))).name).toBe('x'.repeat(260));
    expect(() => readProcessEntry32W(new Uint8Array(556))).toThrow();
  });
});

describe('the snapshot built from the table', () => {
  const table: WindowsProcessTableEntry[] = [
    { pid: 600, parentPid: 4, name: 'explorer.exe', start: '2026-10-15T10:00:00.0000000Z' },
    { pid: 700, parentPid: 600, name: 'bun.exe', start: '2026-10-15T10:00:01.0000000Z' },
    { pid: 710, parentPid: 700, name: 'codex.exe', start: '2026-10-15T10:00:02.0000000Z' },
    // A pid the list named, reused before its start was read.
    { pid: 720, parentPid: 700, name: 'codex.exe', start: '' },
  ];

  test('carries processes for ancestry, and claims neither listeners nor executables', () => {
    const snapshot = captureWindowsProcessTable(() => table);
    expect(snapshot).toEqual({
      processesOk: true,
      listenersOk: false,
      processes: table.map((entry) => ({ ...entry, executable: null })),
      listeners: [],
    });
    const tree = new HostProcessProvider({ platform: 'win32', runWindowsSnapshot: () => snapshot });
    expect(tree.descendsFrom(710, 700)).toBe('yes');
    expect(tree.descendsFrom(710, 600)).toBe('yes');
    expect(tree.descendsFrom(720, 700)).toBe('unknown');
    // No executable is a partial identity, and a partial identity never authorizes anything.
    expect(tree.liveProcess(710)).toEqual({ state: 'unknown' });
    expect(tree.listener(4096)).toEqual({ state: 'unknown' });
  });

  test('is null when the table cannot be read', () => {
    expect(captureWindowsProcessTable(() => undefined)).toBeNull();
    expect(captureWindowsProcessTable(() => { throw new Error('the process list stopped early'); })).toBeNull();
    if (process.platform !== 'win32') expect(captureWindowsProcessTable()).toBeNull();
  });
});

describe.skipIf(process.platform !== 'win32')('the real table on Windows', () => {
  test('lists this process and a child it starts, each with its start, parent first', async () => {
    const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    try {
      const table = windowsFfi()!.processTable();
      const self = table.find((entry) => entry.pid === process.pid);
      const started = table.find((entry) => entry.pid === child.pid);
      expect(self).toMatchObject({ parentPid: process.ppid });
      expect(self!.name.toLowerCase()).toBe(process.execPath.split(/[\\/]/).pop()!.toLowerCase());
      expect(started).toMatchObject({ parentPid: process.pid, name: self!.name });
      expect(self!.start).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/);
      expect(started!.start > self!.start).toBe(true);
      expect(started!.start <= new Date().toISOString().replace('Z', '9999Z')).toBe(true);
      expect(table.some((entry) => entry.pid === 0)).toBe(false);
      expect(new Set(table.map((entry) => entry.pid)).size).toBe(table.length);

      const tree = new HostProcessProvider({ platform: 'win32', runWindowsSnapshot: () => captureWindowsProcessTable() });
      expect(tree.descendsFrom(child.pid, process.pid)).toBe('yes');
      // Walking up from this process never reaches the child; where the walk ends depends on the host.
      expect(tree.descendsFrom(process.pid, child.pid)).not.toBe('yes');
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test('agrees with the PowerShell snapshot it replaces on every process alive across both', async () => {
    // A process whose start reads the same before and after the PowerShell query lived through it,
    // so PowerShell saw that same process under that pid.
    const before = new Map(windowsFfi()!.processTable().map((entry) => [entry.pid, entry]));
    const powershell = await captureWindowsProcessSnapshotAsync(30_000);
    const after = windowsFfi()!.processTable();
    expect(powershell?.processesOk).toBe(true);
    const reported = new Map(powershell!.processes.map((entry) => [entry.pid, entry]));
    let compared = 0;
    for (const entry of after) {
      const earlier = before.get(entry.pid);
      const theirs = reported.get(entry.pid);
      if (!entry.start || !earlier || earlier.start !== entry.start || !theirs) continue;
      compared += 1;
      // WMI truncates CreationDate to the microsecond; the kernel's tick is finer.
      expect({ pid: entry.pid, parentPid: entry.parentPid, name: entry.name.toLowerCase(), start: `${entry.start.slice(0, 26)}0Z` })
        .toEqual({ pid: theirs.pid, parentPid: theirs.parentPid, name: theirs.name.toLowerCase(), start: theirs.start });
    }
    expect(compared).toBeGreaterThan(0);
    expect(compared).toBeGreaterThanOrEqual(after.filter((entry) => entry.start).length / 2);
  }, 60_000);
});
