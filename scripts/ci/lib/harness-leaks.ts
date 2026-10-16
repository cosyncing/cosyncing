/**
 * Harness processes that outlive the test that started them.
 *
 * Every isolated fixture root a test creates (the HOME, COSYNCING_HOME and fake
 * agent `bin` of a test broker) is appended to the ledger file the runner names
 * in {@link HARNESS_LEDGER_ENV}, one path a line. A process whose environment,
 * argv or working directory points into one of those roots belongs to this run
 * by construction: the roots are `mkdtemp` directories, unique to the test that
 * made them. After a task the runner looks for such processes, and one still
 * running is a leak. Nothing that is not provably under a recorded root is ever
 * signalled.
 *
 * A process outside this run (an earlier run's, killed with its runner) is only
 * reported: {@link staleHarnessProcesses}.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

/** Set by the runner for each task attempt: the file the harness records its roots in. */
export const HARNESS_LEDGER_ENV = 'COSYNCING_CHECK_HARNESS_LEDGER';

/** The `mkdtemp` prefix every e2e harness root carries. */
export const HARNESS_ROOT_PREFIX = 'cosyncing-e2e-';

const IS_LINUX = process.platform === 'linux';
const IS_DARWIN = process.platform === 'darwin';

function temporaryDirectories(): Set<string> {
  const bases = new Set([resolve(tmpdir())]);
  try {
    bases.add(realpathSync(tmpdir()));
  } catch {
    // The resolved spelling is enough.
  }
  return bases;
}

/**
 * Whether `path` is shaped like a harness root: a `cosyncing-e2e-*` directory directly in the temp
 * directory, as `mkdtemp` makes one. Anything broader (the temp directory itself, a checkout, a home)
 * is refused, so no ledger line can ever reach past the run's own roots.
 */
export function isHarnessRoot(path: string): boolean {
  const resolved = resolve(path);
  return basename(resolved).startsWith(HARNESS_ROOT_PREFIX)
    && basename(resolved).length > HARNESS_ROOT_PREFIX.length
    && temporaryDirectories().has(dirname(resolved));
}

/** Record `root` in this task's ledger, when the runner gave it one. Never throws. */
export function recordHarnessRoot(root: string): void {
  const ledger = process.env[HARNESS_LEDGER_ENV]?.trim();
  if (!ledger || !isHarnessRoot(root)) return;
  const spellings = new Set([resolve(root)]);
  try {
    spellings.add(realpathSync(root));
  } catch {
    // Not created yet: the resolved spelling is the one its processes will carry.
  }
  try {
    appendFileSync(ledger, [...spellings].map((path) => `${path}\n`).join(''));
  } catch {
    // A ledger that cannot be written loses attribution, never the test.
  }
}

/** The roots a ledger records (only harness-shaped ones: see {@link isHarnessRoot}). */
export function readHarnessLedger(ledger: string): string[] {
  if (!existsSync(ledger)) return [];
  const roots = readFileSync(ledger, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
  return [...new Set(roots.filter(isHarnessRoot))];
}

export interface HarnessProcess {
  pid: number;
  /** The recorded root it points into. */
  root: string;
  /** Where the proof was found. */
  via: 'environment' | 'argv' | 'cwd';
  command: string;
}

interface ProcessFacts {
  pid: number;
  argv: string[];
  environment: string[];
  cwd?: string;
}

/** `value` names `root` or something under it (a PATH list and a `unix://` URL included). */
function pointsInto(value: string, root: string): boolean {
  return value === root || value.endsWith(`=${root}`) || value.includes(`${root}${sep}`)
    || value.split(/[:;]/).includes(root);
}

function linuxProcesses(): ProcessFacts[] {
  const facts: ProcessFacts[] = [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return facts;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    const read = (name: string): string[] => {
      try {
        return readFileSync(`/proc/${entry}/${name}`, 'latin1').split('\0').filter(Boolean);
      } catch {
        return [];
      }
    };
    let cwd: string | undefined;
    try {
      cwd = readlinkSync(`/proc/${entry}/cwd`);
    } catch {
      cwd = undefined;
    }
    facts.push({ pid, argv: read('cmdline'), environment: read('environ'), cwd });
  }
  return facts;
}

/** macOS has no /proc: `ps -E` appends a process's environment to its command line (own uid only). */
function darwinProcesses(): ProcessFacts[] {
  const result = Bun.spawnSync(['ps', '-axww', '-E', '-o', 'pid=,command='], { stdout: 'pipe', stderr: 'ignore' });
  if (!result.success) return [];
  const facts: ProcessFacts[] = [];
  for (const line of result.stdout.toString().split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    facts.push({ pid, argv: [match[2]!], environment: [] });
  }
  return facts;
}

function processFacts(): ProcessFacts[] {
  if (IS_LINUX) return linuxProcesses();
  if (IS_DARWIN) return darwinProcesses();
  return [];
}

function proofFor(facts: ProcessFacts, roots: string[]): HarnessProcess | undefined {
  const command = facts.argv.join(' ').slice(0, 300);
  for (const root of roots) {
    if (facts.environment.some((value) => pointsInto(value, root))) {
      return { pid: facts.pid, root, via: 'environment', command };
    }
    if (facts.argv.some((value) => pointsInto(value, root))) return { pid: facts.pid, root, via: 'argv', command };
    if (facts.cwd && pointsInto(facts.cwd, root)) return { pid: facts.pid, root, via: 'cwd', command };
  }
  return undefined;
}

/** Live processes provably under one of `roots`. Linux and macOS; elsewhere none are found. */
export function findHarnessProcesses(roots: string[]): HarnessProcess[] {
  if (roots.length === 0) return [];
  return processFacts().flatMap((facts) => proofFor(facts, roots) ?? []);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop `found`: SIGTERM, then SIGKILL once `graceMs` has passed. Each pid is proved under its root
 * again immediately before every signal, so a pid the kernel has since recycled is never touched.
 * Resolves with the pids still running afterwards (none, unless one could not be signalled).
 */
export async function reapHarnessProcesses(found: HarnessProcess[], graceMs = 5_000): Promise<number[]> {
  const roots = [...new Set(found.map((entry) => entry.root))];
  const stillProved = (): Set<number> => new Set(findHarnessProcesses(roots).map((entry) => entry.pid));
  const signal = (pids: Iterable<number>, name: NodeJS.Signals): void => {
    const proved = stillProved();
    for (const pid of pids) {
      if (!proved.has(pid)) continue;
      try {
        process.kill(pid, name);
      } catch {
        // Gone already.
      }
    }
  };
  const pids = found.map((entry) => entry.pid);
  signal(pids, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && pids.some(alive)) await Bun.sleep(100);
  signal(pids.filter(alive), 'SIGKILL');
  const killDeadline = Date.now() + 2_000;
  while (Date.now() < killDeadline && pids.some(alive)) await Bun.sleep(50);
  const proved = stillProved();
  return pids.filter((pid) => alive(pid) && proved.has(pid));
}

/** One line per process, for a log or a report. */
export function describeHarnessProcesses(found: HarnessProcess[]): string[] {
  return found.map((entry) => `pid ${entry.pid} (${entry.via} under ${entry.root}): ${entry.command}`);
}

/**
 * Harness processes from some earlier run: their environment or argv points into a
 * `cosyncing-e2e-*` directory under this host's temp directory. They are not this run's, so they
 * are only reported, never signalled.
 */
export function staleHarnessProcesses(): HarnessProcess[] {
  const prefixes = [...temporaryDirectories()].map((base) => join(base, HARNESS_ROOT_PREFIX));
  const found: HarnessProcess[] = [];
  for (const facts of processFacts()) {
    for (const value of [...facts.environment, ...facts.argv]) {
      const prefix = prefixes.find((candidate) => value.includes(candidate));
      if (!prefix) continue;
      const start = value.indexOf(prefix);
      const root = value.slice(start).split(sep).slice(0, prefix.split(sep).length).join(sep);
      found.push({ pid: facts.pid, root, via: facts.environment.includes(value) ? 'environment' : 'argv', command: facts.argv.join(' ').slice(0, 300) });
      break;
    }
  }
  return found;
}
