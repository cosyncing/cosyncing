import {
  captureWindowsProcessTable,
  HostProcessProvider,
  windowsFfi,
  type WindowsProcessSnapshot,
} from '@cosyncing/adapter-api';

/**
 * Windows has no Codex terminal scanner (no `/proc`, no control socket for a terminal to join), so an
 * automatic Drive restore asks one narrower question, only when it is about to restore: is a Codex
 * terminal outside this broker running THIS thread?
 *
 * One host process table answers most of it. No `codex.exe` outside the broker's own process tree
 * means absent, with nothing more read. Otherwise the command lines of exactly those processes are
 * read once, and one that names the thread is a private terminal. A table or command line that
 * cannot be read is unknown, which refuses the restore. Both are read-only Windows API calls through
 * the FFI layer; nothing here starts a process.
 */
export type CodexWindowsTerminalPresence = 'absent' | 'private' | 'unknown';

export interface CodexWindowsPresenceEvidence {
  /** The host process table: names, parents and start times. Null when the machine would not say. */
  snapshot(): Promise<WindowsProcessSnapshot | null>;
  /**
   * The command lines of exactly these processes, read once: a string, `null` for one that has exited,
   * `undefined` for one that would not say. The whole answer is undefined when it cannot be read at all.
   */
  commandLines(pids: readonly number[]): Map<number, string | null | undefined> | undefined;
  /** This broker: its own descendants (Resume owners it spawned) are never a competing terminal. */
  brokerPid: number;
}

/** More foreign Codex processes than this is not a host this check can read in one bounded pass. */
export const CODEX_WINDOWS_PRESENCE_MAX_PROCESSES = 64;

function readCommandLines(pids: readonly number[]): Map<number, string | null | undefined> | undefined {
  const ffi = windowsFfi();
  if (!ffi) return undefined;
  const lines = new Map<number, string | null | undefined>();
  for (const pid of pids) {
    try {
      lines.set(pid, ffi.processCommandLine(pid));
    } catch {
      lines.set(pid, undefined);
    }
  }
  return lines;
}

// The table comes from the Windows API (Toolhelp plus `GetProcessTimes`), not a PowerShell
// `Win32_Process` query: the same pids, parents, names and starts, without a process per restore. It
// is read fresh for every restore; nothing is reused once it has answered.
export const codexWindowsPresenceEvidence: CodexWindowsPresenceEvidence = {
  snapshot: async () => captureWindowsProcessTable(),
  commandLines: readCommandLines,
  brokerPid: process.pid,
};

function namesThread(commandLine: string, threadId: string): boolean {
  const id = threadId.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^0-9a-z-])${id}($|[^0-9a-z-])`).test(commandLine.toLowerCase());
}

export async function codexWindowsTerminalPresence(
  threadId: string,
  evidence: CodexWindowsPresenceEvidence = codexWindowsPresenceEvidence,
): Promise<{ presence: CodexWindowsTerminalPresence; foreignProcesses: number }> {
  const snapshot = await evidence.snapshot().catch(() => null);
  if (!snapshot?.processesOk) return { presence: 'unknown', foreignProcesses: 0 };
  // Ancestry through the shared provider's rules (parents must not post-date their children), read
  // from this one snapshot. Anything not proven to descend from the broker counts as foreign.
  const tree = new HostProcessProvider({ platform: 'win32', runWindowsSnapshot: () => snapshot });
  const foreign = snapshot.processes
    .filter((entry) => entry.name.toLowerCase() === 'codex.exe')
    .filter((entry) => tree.descendsFrom(entry.pid, evidence.brokerPid) !== 'yes')
    .map((entry) => entry.pid);
  if (foreign.length === 0) return { presence: 'absent', foreignProcesses: 0 };
  if (foreign.length > CODEX_WINDOWS_PRESENCE_MAX_PROCESSES) return { presence: 'unknown', foreignProcesses: foreign.length };
  const lines = evidence.commandLines(foreign);
  if (!lines) return { presence: 'unknown', foreignProcesses: foreign.length };
  let unreadable = false;
  for (const pid of foreign) {
    const line = lines.get(pid);
    if (line === null) continue; // exited since the snapshot
    if (line === undefined) {
      unreadable = true;
      continue;
    }
    if (namesThread(line, threadId)) return { presence: 'private', foreignProcesses: foreign.length };
  }
  return { presence: unreadable ? 'unknown' : 'absent', foreignProcesses: foreign.length };
}
