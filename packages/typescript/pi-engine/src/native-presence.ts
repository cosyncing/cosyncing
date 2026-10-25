import { lstatSync, readdirSync, readFileSync, realpathSync, statSync, rmdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { OwnershipConflictError, HostProcessProvider, captureWindowsProcessSnapshotAsync, type WindowsProcessSnapshot } from '@cosyncing/adapter-api';

const processes = new HostProcessProvider();
let windowsCache: { at: number; value: WindowsProcessSnapshot | null } | undefined;
let windowsInflight: Promise<WindowsProcessSnapshot | null> | undefined;
async function windowsSnapshot(fresh = false): Promise<WindowsProcessSnapshot | null> {
  if (!fresh && windowsCache && Date.now() - windowsCache.at < 250) return windowsCache.value;
  // A negative ownership proof must start after the record was read. An older in-flight
  // snapshot can predate a new terminal, even when its eventual response is recent.
  if (fresh && windowsInflight) await windowsInflight;
  if (!windowsInflight) windowsInflight = captureWindowsProcessSnapshotAsync().then((value) => {
    windowsCache = { at: Date.now(), value }; return value;
  }).finally(() => { windowsInflight = undefined; });
  return windowsInflight;
}

/** A record names a canonical file and a process lifetime; PID/comm alone never prove ownership. */
export async function assertNoPiNativeOwner(sessionFile: string, displayName: string): Promise<void> {
  const unknown = (): never => { throw new OwnershipConflictError(`Cannot verify ${displayName} terminal ownership; reconnect its terminal bridge before using Drive.`, 'terminal-unknown'); };
  let expected: string, directory: string, records: string[];
  try {
    expected = realpathSync(sessionFile);
    directory = join(dirname(expected), '.cosyncing-presence', `${basename(expected)}.owners`);
    try { records = readdirSync(directory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      return unknown();
    }
  } catch { return unknown(); }
  const expectedRecords = new Set(records.filter((record) => record.endsWith('.json')));
  let provider = processes;
  let captured = false, refreshed = false;
  for (const record of records) {
    if (!record.endsWith('.json')) continue;
    const path = join(directory, record);
    let value: any;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 16 * 1024) return unknown();
      value = JSON.parse(readFileSync(path, 'utf8'));
      // Scope before validation. A record explicitly naming another file is not this owner.
      if (typeof value?.sessionFile !== 'string') return unknown();
      let recorded: string;
      try { recorded = realpathSync(value.sessionFile); } catch { return unknown(); }
      if (recorded !== expected) {
        const wanted = statSync(expected, { bigint: true }), actual = statSync(recorded, { bigint: true });
        if (wanted.ino === 0n || actual.ino === 0n) return unknown();
        if (wanted.dev !== actual.dev || wanted.ino !== actual.ino) continue;
      }
      if (value.schemaVersion !== 3 || (value.platform !== undefined && value.platform !== process.platform) || !Number.isSafeInteger(value.pid) || value.pid <= 0
        || typeof value.token !== 'string' || record !== `${value.pid}-${value.token}.json`) return unknown();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { expectedRecords.delete(record); continue; }
      return unknown();
    }
    if (process.platform === 'win32' && !captured) {
      const snapshot = await windowsSnapshot();
      provider = new HostProcessProvider({ runWindowsSnapshot: () => snapshot });
      captured = true;
    }
    const start = typeof value.start === 'string' ? value.start : '';
    const boot = typeof value.boot === 'string' ? value.boot : undefined;
    const knownIdentity = process.platform === 'linux'
      ? /^\d+$/.test(start) && typeof boot === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(boot)
      : process.platform === 'win32'
        ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(start) && Number.isFinite(Date.parse(start)) && boot === ''
        : /^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(start) && Number.isFinite(Date.parse(`${start} GMT`)) && boot === '';
    const matches = (owner: ReturnType<HostProcessProvider['liveProcess']>): boolean => {
      if (owner.state !== 'running' || !knownIdentity) return false;
      if (process.platform === 'linux') return BigInt(owner.identity.start) === BigInt(start) && owner.identity.boot.toLowerCase() === boot!.toLowerCase();
      if (process.platform === 'win32') return owner.identity.start === start && owner.identity.boot === boot;
      return Date.parse(`${owner.identity.start} GMT`) === Date.parse(`${start} GMT`) && owner.identity.boot === boot;
    };
    let owner = provider.liveProcess(value.pid);
    // Cached positive ownership can refuse safely. Absence/mismatch needs fresh evidence:
    // an earlier cached snapshot must not delete a newly started native owner's record.
    if (process.platform === 'win32' && owner.state !== 'unknown' && (owner.state === 'absent' || knownIdentity && !matches(owner)) && !refreshed) {
      const snapshot = await windowsSnapshot(true);
      provider = new HostProcessProvider({ runWindowsSnapshot: () => snapshot });
      refreshed = true;
      owner = provider.liveProcess(value.pid);
    }
    if (owner.state === 'unknown') return unknown();
    const stale = owner.state === 'absent' || owner.state === 'running' && knownIdentity && !matches(owner);
    if (stale) {
      try {
        if (JSON.parse(readFileSync(path, 'utf8')).token === value.token) { unlinkSync(path); expectedRecords.delete(record); }
        try { rmdirSync(directory); rmdirSync(dirname(directory)); } catch { /* another file/record remains */ }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return unknown();
        expectedRecords.delete(record);
      }
      continue;
    }
    if (!matches(owner)) return unknown();
    throw new OwnershipConflictError(`This ${displayName} session is open in a native terminal. Reconnect its bridge or close the terminal before using Drive.`, 'terminal-private');
  }
  // An asynchronous probe must not admit a writer after a new record appeared meanwhile.
  let current: string[];
  try { current = readdirSync(directory).filter((record) => record.endsWith('.json')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return unknown();
    current = [];
  }
  if (current.length !== expectedRecords.size || current.some((record) => !expectedRecords.has(record))) return unknown();
}
