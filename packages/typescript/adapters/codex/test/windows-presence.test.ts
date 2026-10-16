/**
 * The Windows restore check, on fakes: the host snapshot and the command-line reads are injected, so
 * this runs anywhere. Only a `codex.exe` outside the broker's own process tree is ever read, the read
 * happens once and only when there is one, and an unreadable host refuses.
 */
import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostProcessProvider, type WindowsProcessEntry, type WindowsProcessSnapshot } from '@cosyncing/adapter-api';
import {
  CODEX_WINDOWS_PRESENCE_MAX_PROCESSES,
  codexWindowsPresenceEvidence,
  codexWindowsTerminalPresence,
  type CodexWindowsPresenceEvidence,
} from '../src/windows-presence.ts';

const THREAD = '019f5799-0000-7000-8000-00000000d71e';
const BROKER = 700;
const at = (minute: number) => `2026-10-15T10:${String(minute).padStart(2, '0')}:00.0000000Z`;
const entry = (pid: number, parentPid: number, minute: number, name: string): WindowsProcessEntry => ({
  pid, parentPid, start: at(minute), name, executable: `C:\\bin\\${name}`,
});

/** explorer (10) → terminal (20); the broker (700) and its own Resume owner chain. */
const base = [
  entry(10, 4, 0, 'explorer.exe'),
  entry(20, 10, 1, 'WindowsTerminal.exe'),
  entry(BROKER, 600, 2, 'bun.exe'),
  entry(710, BROKER, 3, 'cmd.exe'),
  entry(711, 710, 3, 'node.exe'),
  entry(712, 711, 4, 'codex.exe'),
];
const snapshot = (...extra: WindowsProcessEntry[]): WindowsProcessSnapshot => ({
  processesOk: true, listenersOk: true, processes: [...base, ...extra], listeners: [],
});

function evidence(
  table: WindowsProcessSnapshot | null,
  lines: Record<number, string | null | undefined> | undefined,
): CodexWindowsPresenceEvidence & { reads: number[][] } {
  const reads: number[][] = [];
  return {
    reads,
    brokerPid: BROKER,
    snapshot: async () => table,
    commandLines: (pids) => {
      reads.push([...pids]);
      return lines ? new Map(pids.map((pid) => [pid, lines[pid]] as const)) : undefined;
    },
  };
}

describe('codexWindowsTerminalPresence', () => {
  test('no codex.exe outside the broker\'s tree is absent, with no command line read', async () => {
    for (const table of [snapshot(), snapshot(entry(30, 20, 5, 'notepad.exe'))]) {
      const fake = evidence(table, {});
      expect(await codexWindowsTerminalPresence(THREAD, fake)).toEqual({ presence: 'absent', foreignProcesses: 0 });
      expect(fake.reads).toEqual([]);
    }
  });

  test('a foreign codex.exe naming the thread is private; one that does not is absent', async () => {
    const terminal = entry(30, 20, 5, 'codex.exe');
    const app = entry(31, 10, 5, 'Codex.EXE');
    const named = evidence(snapshot(terminal, app), {
      30: `"C:\\Users\\me\\codex.exe" resume ${THREAD.toUpperCase()}`,
      31: 'codex.exe app-server --listen stdio://',
    });
    expect(await codexWindowsTerminalPresence(THREAD, named)).toEqual({ presence: 'private', foreignProcesses: 2 });
    // One read, of exactly the foreign processes: the broker's own owner (712) is never read.
    expect(named.reads).toEqual([[30, 31]]);

    const unrelated = evidence(snapshot(terminal, app), {
      30: `codex.exe resume ${THREAD}0`,
      31: 'codex.exe app-server --listen stdio://',
    });
    expect(await codexWindowsTerminalPresence(THREAD, unrelated)).toEqual({ presence: 'absent', foreignProcesses: 2 });
  });

  test('a codex.exe whose ancestry cannot be proven is read like any foreign one', async () => {
    // Its parent left: reparented, so nothing ties it to the broker.
    const orphan = entry(40, 9999, 6, 'codex.exe');
    // A parent pid that is reused: the "parent" started after its child, so it is not that parent.
    const reused = entry(41, BROKER, 1, 'codex.exe');
    const fake = evidence(snapshot(orphan, reused), { 40: 'codex.exe', 41: `codex.exe resume ${THREAD}` });
    expect((await codexWindowsTerminalPresence(THREAD, fake)).presence).toBe('private');
    expect(fake.reads).toEqual([[40, 41]]);
  });

  test('a process that exited since the snapshot is ignored', async () => {
    const fake = evidence(snapshot(entry(30, 20, 5, 'codex.exe')), { 30: null });
    expect((await codexWindowsTerminalPresence(THREAD, fake)).presence).toBe('absent');
  });

  test('anything unreadable is unknown, which refuses the restore', async () => {
    const terminal = entry(30, 20, 5, 'codex.exe');
    const cases: Array<[string, CodexWindowsPresenceEvidence]> = [
      ['no snapshot', evidence(null, {})],
      ['a failed process query', evidence({ ...snapshot(terminal), processesOk: false }, {})],
      ['no command-line reader', evidence(snapshot(terminal), undefined)],
      ['one process that would not say', evidence(snapshot(terminal, entry(31, 20, 5, 'codex.exe')), { 30: 'codex.exe', 31: undefined })],
      ['a snapshot that throws', { ...evidence(null, {}), snapshot: async () => { throw new Error('timed out'); } }],
    ];
    for (const [label, fake] of cases) {
      expect({ label, presence: (await codexWindowsTerminalPresence(THREAD, fake)).presence }).toEqual({ label, presence: 'unknown' });
    }
    const crowd = Array.from({ length: CODEX_WINDOWS_PRESENCE_MAX_PROCESSES + 1 }, (_, index) => entry(1000 + index, 20, 5, 'codex.exe'));
    const crowded = evidence(snapshot(...crowd), {});
    expect((await codexWindowsTerminalPresence(THREAD, crowded)).presence).toBe('unknown');
    expect(crowded.reads).toEqual([]);
  });
});

describe('the host evidence a restore reads', () => {
  test('starts no process: the table and the command lines are Windows API reads', () => {
    // The table used to be a PowerShell `Win32_Process` query, about 1.4 s per restore.
    const source = readFileSync(join(import.meta.dir, '../src/windows-presence.ts'), 'utf8');
    expect(source).not.toMatch(/captureWindowsProcessSnapshot|powershell\.exe|Bun\.spawn|child_process/i);
    expect(source).toContain('captureWindowsProcessTable()');
  });

  test.skipIf(process.platform === 'win32')('answers unknown where there is no Windows table to read', async () => {
    expect(await codexWindowsPresenceEvidence.snapshot()).toBeNull();
    expect(await codexWindowsTerminalPresence(THREAD)).toEqual({ presence: 'unknown', foreignProcesses: 0 });
  });

  test.skipIf(process.platform !== 'win32')('on Windows, a stand-in codex.exe is the broker\'s own under it and private under another', async () => {
    // Stand-ins only: a copy of this runtime named codex.exe, started and stopped here, plus a sibling
    // that plays a different broker. Nothing else on the host is signalled.
    const directory = mkdtempSync(join(tmpdir(), 'codex-presence-'));
    const codex = join(directory, 'codex.exe');
    copyFileSync(process.execPath, codex);
    const idle = ['-e', 'setInterval(() => {}, 1000)'];
    const standIn = Bun.spawn([codex, ...idle, 'resume', THREAD], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    const otherBroker = Bun.spawn([process.execPath, ...idle], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    try {
      const snapshot = await codexWindowsPresenceEvidence.snapshot();
      expect(snapshot?.processesOk).toBe(true);
      expect(snapshot!.processes.find((entry) => entry.pid === standIn.pid)).toMatchObject({ parentPid: process.pid, name: 'codex.exe' });
      const tree = new HostProcessProvider({ platform: 'win32', runWindowsSnapshot: () => snapshot });
      expect(tree.descendsFrom(standIn.pid, process.pid)).toBe('yes');
      expect(tree.descendsFrom(standIn.pid, otherBroker.pid)).not.toBe('yes');

      const reads: number[][] = [];
      const recorded = (brokerPid: number): CodexWindowsPresenceEvidence => ({
        ...codexWindowsPresenceEvidence,
        brokerPid,
        commandLines: (pids) => {
          reads.push([...pids]);
          return codexWindowsPresenceEvidence.commandLines(pids);
        },
      });
      // Under this broker the stand-in is its own Resume owner, never read; other codex.exe on the host
      // may be, and decide the answer, so only the stand-in's absence from the reads is asserted.
      await codexWindowsTerminalPresence(THREAD, recorded(process.pid));
      expect(reads.flat()).not.toContain(standIn.pid);
      // Under another broker it is a foreign terminal naming the thread.
      reads.length = 0;
      expect((await codexWindowsTerminalPresence(THREAD, recorded(otherBroker.pid))).presence).toBe('private');
      expect(reads.flat()).toContain(standIn.pid);
    } finally {
      standIn.kill();
      otherBroker.kill();
      await Promise.all([standIn.exited, otherBroker.exited]);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
