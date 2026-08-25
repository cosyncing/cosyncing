/**
 * Protection for the operator's OWN Pi agent directory, shared by every Phase 6 probe that reads it.
 *
 * The probes deliberately do not redirect `PI_CODING_AGENT_DIR`: providers, model selection, and
 * credentials live there, and a disposable copy either has no providers — the first drive trace
 * reported an empty catalogue and `No API key found` on every turn, which said nothing about
 * Windows — or requires copying the operator's secrets somewhere new. So Pi reads the real
 * configuration, and this module is what keeps that safe to do.
 *
 * It exists as one module rather than one copy per probe because the rollback is the part most
 * able to do harm, and two divergent copies of it is the defect class this replaces.
 *
 * What it guarantees, and what it does not:
 *
 *   * EXCLUSIVITY is half machine, half human. The machine half is a lock held for the whole run,
 *     kept outside the agent directory so it is not one more entry to explain. The human half is
 *     an explicit declaration, because no process snapshot available here distinguishes the
 *     operator's own `pi` from any other `node.exe` — the Windows shim IS Node. Both are required,
 *     and the report says which is which rather than implying the machine proved both.
 *   * LINKS are never followed. `lstat` decides every entry kind: `stat` would capture a symlinked
 *     entry from its target and then restore THROUGH it, writing bytes outside the agent directory
 *     to a path no probe ever inspected.
 *   * CREATED entries are removed, not merely reported — but only a name proven absent by a
 *     listing that succeeded at capture, only a regular file, and only when the removal verifies.
 *   * BYTES are never recorded, logged, or returned. The observations carry entry NAMES and counts.
 */
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { win32 } from 'node:path';

/** Files above this are reported rather than held in memory, and are never written back. */
const RESTORABLE_FILE_MAX_BYTES = 1024 * 1024;

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * A bounded, non-invasive fingerprint of the directory.
 *
 * Top-level names alone were too weak for the claim made from them: bridge auto-install writes
 * `extensions/cosyncing-bridge/index.ts`, which is nested, and an overwrite of `models.json`
 * changes no name at all. This records each top-level entry's kind, size, and mtime plus one level
 * of child names, and never reads a file's contents.
 */
interface Fingerprint { entries: string[]; stats: string[]; children: string[] }

interface CapturedFiles {
  /** Regular top-level files small enough to hold, by name. */
  bytes: Map<string, Buffer>;
  /** Regular files past the ceiling: reported, never held, never written. */
  oversized: string[];
  /** Reparse points, which are neither read nor written. */
  symlinked: string[];
  /** Every top-level name the listing saw, or `undefined` when the listing itself failed. */
  names: string[] | undefined;
}

export interface AgentDirectoryRestore {
  /** Every captured file is back to its original bytes and nothing else moved. */
  restored: boolean;
  /** Nothing this probe created was left behind. */
  createdEntriesRemoved: boolean;
  /** Sanitized, name-only evidence for the probe report. */
  observations: Record<string, unknown>;
  /** Findings to fold into the probe's own list. */
  notes: string[];
}

export interface AgentDirectoryGuardOptions {
  agentDir: string;
  runId: string;
  /** Where the lock lives when the platform names no temp directory. */
  fallbackLockDir: string;
  /** Environment variable carrying the operator's exclusive-use declaration. */
  declarationVariable: string;
  /**
   * Top-level entries this probe DECLARES it may create, and may therefore remove afterwards even
   * when they are directories — the bridge extension tree is the case this exists for.
   *
   * Declaring one does not weaken the rule that only a name proven ABSENT at capture is ever
   * removed. It widens exactly one thing: an undeclared created directory is reported and left
   * alone, and a declared one is deleted with its contents. A probe that needs this must also
   * refuse to run when the entry already exists, because then the tree is the operator's and
   * neither creating into it nor removing it is this harness's business.
   */
  removableCreatedEntries?: readonly string[];
}

export class AgentDirectoryGuard {
  private lockHeld = false;
  private released = false;
  private constructor(
    private readonly agentDir: string,
    private readonly lockPath: string,
    private readonly before: Fingerprint,
    private readonly filesBefore: CapturedFiles,
    private readonly removableCreatedEntries: ReadonlySet<string>,
  ) {}

  /** Was this top-level entry already there when the guard captured? */
  has(entry: string): boolean { return this.before.entries.includes(entry); }

  /**
   * Declare exclusive use, take the lock, and capture the directory — in that order, so nothing is
   * captured that a second writer could already be changing. Throws rather than degrading: a probe
   * that cannot promise a safe rollback must not start one.
   */
  static acquire(options: AgentDirectoryGuardOptions): AgentDirectoryGuard {
    if (process.env[options.declarationVariable] !== '1') {
      throw new Error(
        `This probe requires ${options.declarationVariable}=1: it restores files in the operator's `
        + 'Pi agent directory and must not run while Pi is in use elsewhere',
      );
    }
    const lockPath = win32.join(
      process.env.TEMP || process.env.TMP || options.fallbackLockDir,
      `cosyncing-phase6-${options.agentDir.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase().slice(-80)}.lock`,
    );
    let handle: number;
    try {
      handle = openSync(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      let holder = '(unreadable)';
      try { holder = readFileSync(lockPath, 'utf8').trim(); } catch { /* reported as unreadable */ }
      throw new Error(
        `A Phase 6 probe is already running against this agent directory (held by ${holder}). `
        + `Remove ${lockPath} only after confirming no other probe is running.`,
      );
    }
    writeFileSync(handle, `${options.runId} pid=${process.pid}\n`);
    closeSync(handle);
    const guard = new AgentDirectoryGuard(
      options.agentDir,
      lockPath,
      fingerprint(options.agentDir),
      captureFiles(options.agentDir),
      new Set(options.removableCreatedEntries ?? []),
    );
    guard.lockHeld = true;
    // Belt and braces: a throw anywhere in the probe must not strand the lock.
    process.on('exit', () => { guard.release(); });
    return guard;
  }

  /** How many top-level entries were present at capture — a count, never the names. */
  get entryCount(): number { return this.before.entries.length; }

  /** What exclusivity actually rests on, stated so it is not read as stronger than it is. */
  get exclusiveUse(): Record<string, unknown> {
    return { declaredByOperator: true, lockHeldForRun: true, lockReleased: this.released };
  }

  release(): boolean {
    if (!this.lockHeld) return this.released;
    try { unlinkSync(this.lockPath); this.lockHeld = false; this.released = true; }
    catch { this.released = false; }
    return this.released;
  }

  /**
   * Put back what this probe's use of Pi changed, remove what it created, and report both.
   *
   * Restored files are compared by CONTENT, not mtime: writing the same bytes back changes the
   * mtime by construction, so a stat comparison would call a faithful restore a change.
   */
  restore(): AgentDirectoryRestore {
    const notes: string[] = [];
    const restoredFiles: string[] = [];
    const unrestoredFiles: string[] = [];
    for (const [name, original] of this.filesBefore.bytes) {
      const full = win32.join(this.agentDir, name);
      let current: Buffer | undefined;
      try { current = readFileSync(full); } catch { current = undefined; }
      if (current && original.equals(current)) continue;
      // The entry's KIND is re-checked immediately before writing. If a captured file became a
      // directory or a reparse point while the probe ran, writing would either fail or land
      // outside the agent directory; report it and leave it alone. A file that simply disappeared
      // is safe to recreate, because it existed at capture.
      let writable: boolean;
      try { writable = lstatSync(full).isFile(); }
      catch (error) { writable = (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
      if (!writable) { unrestoredFiles.push(name); continue; }
      try {
        writeFileSync(full, original);
        (readFileSync(full).equals(original) ? restoredFiles : unrestoredFiles).push(name);
      } catch {
        unrestoredFiles.push(name);
      }
    }

    const filesAfter = captureFiles(this.agentDir);
    const oversizedChanged = filesAfter.oversized
      .filter((name) => !this.filesBefore.oversized.includes(name));

    const entriesCreated: string[] = [];
    const entriesRemoved: string[] = [];
    const entriesNotRemoved: string[] = [];
    const listingsSucceeded = this.filesBefore.names !== undefined && filesAfter.names !== undefined;
    if (this.filesBefore.names && filesAfter.names) {
      const before = new Set(this.filesBefore.names);
      for (const name of filesAfter.names) {
        if (before.has(name)) continue;
        entriesCreated.push(name);
        const full = win32.join(this.agentDir, name);
        let removable = false;
        let recursive = false;
        try {
          const stat = lstatSync(full);
          if (stat.isSymbolicLink()) removable = false;
          else if (stat.isFile()) removable = true;
          else if (stat.isDirectory() && this.removableCreatedEntries.has(name)) {
            removable = true;
            recursive = true;
          }
        } catch { removable = false; }
        if (!removable) { entriesNotRemoved.push(name); continue; }
        try {
          rmSync(full, { force: true, ...(recursive ? { recursive: true } : {}) });
          (existsSync(full) ? entriesNotRemoved : entriesRemoved).push(name);
        } catch {
          entriesNotRemoved.push(name);
        }
      }
    }

    // Taken after the removals, so the comparison reflects the directory the operator is left with
    // rather than the one mid-cleanup — and BEFORE the lock goes, because evidence read after
    // releasing it describes a directory another probe was already free to change.
    const after = fingerprint(this.agentDir);
    const lockReleased = this.release();
    const topLevelEntrySetUnchanged = sameList(after.entries, this.before.entries);
    const touched = new Set([...restoredFiles, ...unrestoredFiles]);
    const withoutRestored = (stats: readonly string[]): string[] =>
      stats.filter((entry) => !touched.has(entry.split('|')[0]!));
    const entryStatsUnchanged = sameList(withoutRestored(after.stats), withoutRestored(this.before.stats));
    const childNameSetsUnchanged = sameList(after.children, this.before.children);
    const linksUnchanged = sameList(filesAfter.symlinked, this.filesBefore.symlinked);

    if (!topLevelEntrySetUnchanged) notes.push("the operator's Pi agent directory gained or lost an entry");
    else if (!entryStatsUnchanged || !childNameSetsUnchanged) {
      notes.push("an entry inside the operator's Pi agent directory changed size, mtime, or children");
    }
    if (unrestoredFiles.length) {
      notes.push("a file in the operator's Pi agent directory could not be restored to its original bytes");
    }
    if (oversizedChanged.length) {
      notes.push("a file too large to capture appeared in the operator's Pi agent directory");
    }
    if (!listingsSucceeded) {
      notes.push("the operator's Pi agent directory could not be listed, so created entries are unknown");
    }
    if (entriesNotRemoved.length) {
      notes.push('an entry this probe created could not be removed and was left for the owner to inspect');
    }
    if (!linksUnchanged) notes.push("a linked entry appeared in or left the operator's Pi agent directory");
    if (this.filesBefore.symlinked.length) {
      notes.push('a linked entry was present and deliberately neither captured nor restored');
    }
    if (!lockReleased) notes.push('the exclusive-use lock could not be released');

    return {
      restored: topLevelEntrySetUnchanged && entryStatsUnchanged && childNameSetsUnchanged
        && unrestoredFiles.length === 0 && oversizedChanged.length === 0 && linksUnchanged,
      createdEntriesRemoved: listingsSucceeded && entriesNotRemoved.length === 0,
      observations: {
        // Named for what was actually compared: kind, size, and mtime per top-level entry plus one
        // level of child names — enough to see a nested bridge install or an overwritten
        // models.json, and not claimed to be more.
        topLevelEntrySetUnchanged,
        entryStatsUnchanged,
        childNameSetsUnchanged,
        // Names only: which of Pi's own files the probe had to put back.
        filesRestored: restoredFiles,
        filesNotRestored: unrestoredFiles,
        filesTooLargeToRestore: this.filesBefore.oversized,
        entriesCreatedByProbe: entriesCreated,
        entriesRemoved,
        entriesNotRemoved,
        symlinkedEntriesNotCaptured: this.filesBefore.symlinked,
        listingsSucceeded,
        // Entry NAMES only, so a change can be attributed instead of guessed at. Restored files are
        // excluded because their content is the authoritative answer above and a faithful restore
        // leaves a new mtime.
        changedEntries: withoutRestored(after.stats)
          .filter((entry, index) => entry !== withoutRestored(this.before.stats)[index])
          .map((entry) => entry.split('|')[0]!)
          .concat(after.children
            .filter((entry, index) => entry !== this.before.children[index])
            .map((entry) => entry.split('/')[0]!))
          .filter((name, index, all) => all.indexOf(name) === index)
          .sort(),
      },
      notes,
    };
  }
}

function fingerprint(agentDir: string): Fingerprint {
  const entries: string[] = [];
  const stats: string[] = [];
  const children: string[] = [];
  let names: string[];
  try { names = readdirSync(agentDir).sort(); } catch { return { entries, stats, children }; }
  for (const name of names) {
    entries.push(name);
    try {
      // lstat, not stat: a reparse point must be recorded as the link it is, not as whatever it
      // points at, or a swapped target would read here as no change at all.
      const stat = lstatSync(win32.join(agentDir, name));
      const kind = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : 'file';
      stats.push(`${name}|${kind}|${stat.size}|${Math.trunc(stat.mtimeMs)}`);
      if (kind === 'dir') {
        children.push(`${name}/${readdirSync(win32.join(agentDir, name)).sort().join(',')}`);
      }
    } catch {
      stats.push(`${name}|unreadable`);
    }
  }
  return { entries, stats, children };
}

function captureFiles(agentDir: string): CapturedFiles {
  const bytes = new Map<string, Buffer>();
  const oversized: string[] = [];
  const symlinked: string[] = [];
  let names: string[];
  try { names = readdirSync(agentDir).sort(); }
  catch { return { bytes, oversized, symlinked, names: undefined }; }
  for (const name of names) {
    const full = win32.join(agentDir, name);
    try {
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) { symlinked.push(name); continue; }
      if (!stat.isFile()) continue;
      if (stat.size > RESTORABLE_FILE_MAX_BYTES) { oversized.push(name); continue; }
      bytes.set(name, readFileSync(full));
    } catch { /* an unreadable entry is reported by the stat comparison instead */ }
  }
  return { bytes, oversized, symlinked, names };
}
