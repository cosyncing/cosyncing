/**
 * Finding the transcript file that belongs to a mod registration.
 *
 * The permission mode that decides whether a hold is taken is not something a mod can see and
 * is not something the broker is told: Claude writes it into the session transcript, and the
 * only honest read is the one the adapter already does on that file. So the socket's
 * registration, which carries a session id and a working directory, has to be tied back to the
 * transcript path, and this module is that tie.
 *
 * The layout is Claude's own and has been stable across the builds this lane measured:
 * `<configDir>/projects/<cwd with every non-alphanumeric byte replaced by '-'>/<uuid>.jsonl`.
 * The adapter computes the same slug (`slugForCwd` in `adapters/claude/src/implementation.ts`),
 * and because that function is module-private the expression is repeated here rather than
 * reaching across a package boundary for one line of string replacement. It is asserted in
 * `test:claude-mod-socket` against a real fixture tree, so a silent divergence in either copy
 * fails a suite instead of quietly turning every hold into `mode:unknown`.
 *
 * Every candidate passes `isClaudeTranscriptPathAllowed` before it is opened. That guard exists
 * because a planted symlink under a projects root would otherwise turn "read the mode" into
 * "read whatever this path points at", and the socket's peer is a same-uid process, which is not
 * an authorisation boundary.
 */

import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { claudeStores, isClaudeTranscriptPathAllowed } from '@cosyncing/adapter-claude';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function slugForCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Where Claude keeps its transcripts, honouring `CLAUDE_CONFIG_DIR` the way the CLI does. */
export function claudeProjectsRoot(configDir?: string): string {
  const dir = configDir?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
  return join(dir, 'projects');
}

/**
 * Every projects root the Claude adapter can see.
 *
 * The adapter, not the broker's own environment, is what knows where transcripts live: it walks
 * the official `~/.claude` AND each wrapper's `CLAUDE_CONFIG_DIR` (claude-mi and friends), and it
 * is the adapter's rows the user is looking at. Reading `process.env.CLAUDE_CONFIG_DIR` here
 * searched the one directory the packaged broker never sets, and returned nothing for a session
 * whose transcript sat in a store the roster had just listed.
 */
function knownProjectsRoots(): string[] {
  const roots: string[] = [];
  try {
    for (const store of claudeStores()) {
      if (store.projectsRoot && !roots.includes(store.projectsRoot)) roots.push(store.projectsRoot);
    }
  } catch {
    // An adapter that cannot enumerate its stores falls back to the single default root below.
  }
  if (roots.length === 0) roots.push(claudeProjectsRoot());
  return roots;
}

/**
 * The transcript for a session id, or nothing.
 *
 * Fast path first, then a bounded scan of the projects root: a session whose cwd moved (a
 * symlinked checkout, a `cd` before launch) would otherwise read as `mode:unknown` forever,
 * and an unknown mode means the phone never shows a card, which reads as a broken feature
 * rather than as a fail-open.
 */
/**
 * How long a located path is trusted.
 *
 * The hold gate asks for the transcript on EVERY hold -- twice to read the mode, and again each
 * time a verdict is polled -- and the answer moves once per turn at most. Without a cache the
 * fast path is a stat and the slow path is a readdir of every project slug, repeated five or six
 * times per hold, per session. Sixty seconds is shorter than the registry's own staleness window,
 * so a row cannot outlive the path it was found by; a session whose transcript genuinely moved
 * (a rename, a wrapper that rotated its store) re-resolves on the next hold after the entry ages.
 */
const LOCATE_TTL_MS = 60_000;
const located = new Map<string, { path: string; at: number }>();
/** A located path that stops existing is a miss, not a stale entry: the next lookup re-searches. */
const locatedMisses = new Map<string, number>();

/** Drop every cached location. Exported for the suite and for a store that changed under us. */
export function clearClaudeTranscriptCache(): void {
  located.clear();
  locatedMisses.clear();
}

export function findClaudeTranscript(
  sessionId: string,
  cwd: string | undefined,
  options: { projectsRoot?: string; configDir?: string } = {},
): string | undefined {
  if (!sessionId || !UUID_SHAPE.test(sessionId)) return undefined;
  const readable = (path: string): boolean => {
    try {
      if (!isClaudeTranscriptPathAllowed(path)) return false;
      return statSync(path).isFile();
    } catch {
      return false;
    }
  };

  // The cache answers the broker's own question -- "where is this session's transcript" -- and
  // nothing else. A call that pins a root is asking a different question ("is it under THIS
  // root"), and answering it from a path found under another root would defeat the pin.
  const pinned = options.projectsRoot !== undefined || options.configDir !== undefined;

  const cached = pinned ? undefined : located.get(sessionId);
  if (cached && Date.now() - cached.at < LOCATE_TTL_MS && readable(cached.path)) return cached.path;
  if (cached) located.delete(sessionId);

  // A miss is cached too, for less than a second, so one turn's cluster of mode reads does not
  // pay for the scan five times over. Long enough to cover a hold, short enough that a transcript
  // appearing a moment later is found by the next one.
  const missedAt = pinned ? undefined : locatedMisses.get(sessionId);
  if (missedAt !== undefined && Date.now() - missedAt < 2_000) return undefined;

  // An explicit root means THAT root, and nothing else: the suite and any future caller pin the
  // search to it, and widening it would make the pin meaningless. Only the implicit call -- the
  // broker's own, from the hold gate -- gets every store the adapter can see.
  const roots = options.projectsRoot
    ? [options.projectsRoot]
    : options.configDir
      ? [claudeProjectsRoot(options.configDir)]
      : knownProjectsRoots();
  for (const root of roots) {
    if (cwd) {
      const direct = resolve(join(root, slugForCwd(cwd), `${sessionId}.jsonl`));
      if (readable(direct)) {
        if (!pinned) {
          located.set(sessionId, { path: direct, at: Date.now() });
          locatedMisses.delete(sessionId);
        }
        return direct;
      }
    }
  }

  // The cwd the mod reported is the registration's own, and Claude puts the transcript under the
  // directory it was STARTED in, which is not the same thing after a symlinked checkout or a `cd`
  // before launch. A miss there is not a missing session, and `mode:unknown` on every hold is a
  // worse answer than one bounded scan per session per minute.
  for (const root of roots) {
    let slugs: string[];
    try {
      slugs = readdirSync(root);
    } catch {
      continue;
    }
    for (const slug of slugs) {
      const candidate = resolve(join(root, slug, `${sessionId}.jsonl`));
      if (readable(candidate)) {
        if (!pinned) {
          located.set(sessionId, { path: candidate, at: Date.now() });
          locatedMisses.delete(sessionId);
        }
        return candidate;
      }
    }
  }
  if (!pinned) locatedMisses.set(sessionId, Date.now());
  return undefined;
}

/** True when two independently computed transcript paths point at the same file. */
export function sameTranscriptPath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return left === right;
  }
}

/** Whether a directory looks like a Claude projects root, for a startup sanity log. */
export function claudeProjectsRootExists(projectsRoot?: string): boolean {
  try {
    return existsSync(projectsRoot ?? claudeProjectsRoot()) && statSync(projectsRoot ?? claudeProjectsRoot()).isDirectory();
  } catch {
    return false;
  }
}
