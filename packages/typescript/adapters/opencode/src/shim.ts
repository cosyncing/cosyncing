import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
// @ts-expect-error Bun's text loader embeds the shell source in source and packaged builds.
import opencodeShimModule from '../assets/opencode-shim.sh' with { type: 'text' };
import { windowsPathOwnedByCurrentUser, type SetupDiagnosisContext } from '@cosyncing/adapter-api';
import { resolveLocalOpencodeBaseUrl } from './implementation.ts';

/** The package-owned R1 asset: the `opencode()` shell function sourced by the managed rc block. */
export const OPENCODE_SHIM_SOURCE = opencodeShimModule as unknown as string;
export const OPENCODE_SHIM_SHA256 = createHash('sha256').update(OPENCODE_SHIM_SOURCE).digest('hex');

/** R1 receipt id (the hash-owned shim script) and the two R2 receipt ids (delimited rc blocks). */
export const OPENCODE_SHIM_RESOURCE_ID = 'opencode-shim';
export const OPENCODE_SHIM_RC_RESOURCE_IDS = {
  bash: 'opencode-shim-rc-bash',
  zsh: 'opencode-shim-rc-zsh',
} as const;

/** The managed R2 block. Delimiters are the ownership marker; the body sources the RESOLVED absolute shim path. */
export const OPENCODE_SHIM_BLOCK_BEGIN = '# >>> cosyncing (opencode) >>>';
export const OPENCODE_SHIM_BLOCK_END = '# <<< cosyncing <<<';

/**
 * Wrap a value in POSIX single quotes, escaping any embedded single quote as the standard `'\''` idiom. Single
 * quoting disables every shell expansion, so an absolute path (spaces, `$`, globs, and all) is sourced
 * literally — the block no longer assumes the shim lives under `$HOME`.
 */
export function posixSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Resolve the managed-serve port the shim should default to from `OPENCODE_URL` (a portless local URL pins to
 * :4096, matching resolveLocalOpencodeBaseUrl — the single source of truth the broker uses to launch/probe the
 * serve, so the block, the adapter, and the serve never diverge). Anything unparseable falls back to 4096.
 */
export function opencodeShimPort(opencodeUrl: string | undefined): number {
  const base = resolveLocalOpencodeBaseUrl((opencodeUrl ?? 'http://127.0.0.1:4096').replace(/\/$/, ''));
  try {
    const port = Number(new URL(base).port);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 4096;
  } catch {
    return 4096;
  }
}

export const OPENCODE_SHIM_DEFAULT_HOST = '127.0.0.1';

/**
 * Resolve the loopback HOST the shim should default to from `OPENCODE_URL`, so a broker serving on `::1` or
 * `localhost` (which `resolveLocalOpencodeBaseUrl` preserves rather than normalizing to 127.0.0.1) is still
 * reachable — the shim would otherwise always dial 127.0.0.1 and silently fail on an IPv6-only serve. `URL`
 * strips the IPv6 brackets, so `http://[::1]:4096` yields `::1`; the shim re-brackets it. Anything unparseable
 * falls back to 127.0.0.1.
 */
export function opencodeShimHost(opencodeUrl: string | undefined): string {
  const base = resolveLocalOpencodeBaseUrl((opencodeUrl ?? 'http://127.0.0.1:4096').replace(/\/$/, ''));
  try {
    return new URL(base).hostname || OPENCODE_SHIM_DEFAULT_HOST;
  } catch {
    return OPENCODE_SHIM_DEFAULT_HOST;
  }
}

/**
 * The canonical managed block, line by line, as a function of the RESOLVED shim path, managed port, and host.
 * install writes exactly these; excise removes exactly these; the owned-match is exact on ALL values.
 *
 * The `: "${COSYNCING_OPENCODE_PORT:=<port>}"` / `: "${COSYNCING_OPENCODE_HOST:=<host>}"` lines are POSIX
 * set-if-unset that pin the endpoint the sourced shim probes/attaches to while still honoring a user override,
 * running in the SAME shell that sources the shim (no export needed). Changing the managed port/host after
 * install re-canonicalizes on the next setup: the drifted block is recognized as owned-stale (our markers +
 * our source line for this shim path) and rewritten in place, and uninstall still excises it.
 */
export function opencodeShimBlockLines(shimPath: string, port: number, host: string = OPENCODE_SHIM_DEFAULT_HOST): readonly string[] {
  const quoted = posixSingleQuote(shimPath);
  return [
    OPENCODE_SHIM_BLOCK_BEGIN,
    `: "\${COSYNCING_OPENCODE_PORT:=${port}}"`,
    `: "\${COSYNCING_OPENCODE_HOST:=${host}}"`,
    `[ -f ${quoted} ] && . ${quoted}`,
    OPENCODE_SHIM_BLOCK_END,
  ];
}

export type OpencodeShimRcId = keyof typeof OPENCODE_SHIM_RC_RESOURCE_IDS;

export interface OpencodeShimRcTarget {
  id: OpencodeShimRcId;
  resourceId: string;
  path: string;
}

/**
 * R1 lives under the cosyncing state home (`~/.cosyncing/shell/opencode-shim.sh` by default) so it survives
 * cache wipes. Uninstall removes it through a DEDICATED id-based branch (keyed on OPENCODE_SHIM_RESOURCE_ID)
 * that validates the receipt target === this exact path and then hash-verified-deletes — so a custom
 * COSYNCING_HOME pointing OUTSIDE $HOME still removes cleanly (it never flows through path-entry's
 * `pathWithin($HOME)` guard, which would otherwise strand a state home outside the user's home directory).
 */
export function opencodeShimShellPath(stateHome: string): string {
  return join(stateHome, 'shell', 'opencode-shim.sh');
}

/**
 * The candidate interactive rc files. Callers install only into the ones that already exist.
 *
 * EMPTY on Windows, deliberately. These are POSIX interactive shell rc files, and no Windows shell
 * sources them: `cmd` and PowerShell have their own profile mechanisms and read neither. A Windows
 * user who has a `.bashrc` at all has it because Git Bash or MSYS put it there, and installing a
 * routing block into it would report success for a block that the terminal the user actually types
 * in never reads. Whether Git-Bash-only routing is worth supporting is a product question; writing
 * a file nothing sources and calling it done is not an answer to it.
 *
 * Returning nothing here is the structural half of the refusal — even a caller that skips the setup
 * planner cannot install a block on Windows. The planner reports the refusal in words.
 */
export function opencodeShimRcCandidates(
  context: Pick<SetupDiagnosisContext, 'homeDir' | 'platform'>,
): OpencodeShimRcTarget[] {
  if (context.platform === 'win32') return [];
  return [
    { id: 'bash', resourceId: OPENCODE_SHIM_RC_RESOURCE_IDS.bash, path: join(context.homeDir, '.bashrc') },
    { id: 'zsh', resourceId: OPENCODE_SHIM_RC_RESOURCE_IDS.zsh, path: join(context.homeDir, '.zshrc') },
  ];
}

export type OpencodeShimStatus = 'owned' | 'drifted' | 'foreign' | 'missing';

/**
 * Classify the on-disk shim script:
 *   owned   — byte-identical to THIS package.
 *   drifted — a regular, uid-owned file whose content differs. It may be a PREVIOUS package version we
 *             installed (a safe in-place upgrade) OR a user edit — the receipt disambiguates the two at the
 *             setup/lifecycle layer via opencodeShimActualSha256 (mirrors the agent-skill owned-stale proof).
 *   foreign — a symlink, a non-regular file, or one owned by another uid: structurally unsafe, never touched.
 *   missing — not present.
 */
export interface OpencodeShimProof {
  status: OpencodeShimStatus;
  /** The proving hash when the file is structurally safe and ours to act on; undefined otherwise. */
  actualSha256: string | undefined;
}

/**
 * The status and its proving hash from ONE pass over the file.
 *
 * Both answers come from the same structural-safety proof, and on Windows that proof costs a PowerShell
 * process to establish ownership. A caller wanting both — setup's inspection does — otherwise pays for
 * that proof twice for a single file, because the status form computes the hash and then discards it.
 */
export function proveOpencodeShim(path: string): OpencodeShimProof {
  const sha = opencodeShimActualSha256(path);
  if (sha !== undefined) {
    return { status: sha === OPENCODE_SHIM_SHA256 ? 'owned' : 'drifted', actualSha256: sha };
  }
  return { status: existsSync(path) ? 'foreign' : 'missing', actualSha256: undefined };
}

export function inspectOpencodeShim(path: string): OpencodeShimStatus {
  return proveOpencodeShim(path).status;
}

function assertNoSymlinkParents(target: string): void {
  if (!isAbsolute(target)) throw new Error('OpenCode shim path must be absolute');
  const absolute = resolve(target);
  const root = parse(absolute).root;
  let cursor = dirname(absolute);
  while (cursor !== root) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error('OpenCode shim path contains a symlink');
    }
    cursor = dirname(cursor);
  }
}

/** The on-disk hash of a STRUCTURALLY-SAFE shim script (present, regular, non-symlink, uid-owned); undefined
 *  otherwise. Proves receipt ownership of a possibly-previous package version for an owned-stale upgrade or a
 *  clean removal, exactly as the agent-skill receipt proof compares a file to its recorded installedSha256. */
export function opencodeShimActualSha256(path: string): string | undefined {
  try {
    assertNoSymlinkParents(path);
    if (!existsSync(path)) return undefined;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return undefined;
    // Ownership must be PROVEN, on every platform. The old form asked
    // `process.getuid` and, finding it absent on Windows, simply skipped the
    // question — so a file owned by another account hashed as ours and was
    // eligible to be modified or deleted. That is fail-open on the one check
    // that exists to stop us touching somebody else's file.
    if (typeof process.getuid === 'function') {
      if (stat.uid !== process.getuid()) return undefined;
    } else if (process.platform === 'win32') {
      // 'unknown' is not 'yes'. A machine that will not say who owns a file has
      // not told us it is ours.
      if (windowsPathOwnedByCurrentUser(path) !== 'yes') return undefined;
    } else {
      return undefined; // no way to establish ownership here; claim nothing
    }
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return undefined;
  }
}

export type RcBlockState = 'absent' | 'owned' | 'owned-stale' | 'foreign';

/** split/join with '\n' is exactly reversible, so every mutation below is byte-exact outside the block. */
function splitLines(content: string): string[] {
  return content.split('\n');
}

/** Count exact BEGIN / END marker lines across the WHOLE file (not just the first pair). */
function markerCounts(lines: readonly string[]): { begin: number; end: number } {
  let begin = 0;
  let end = 0;
  for (const line of lines) {
    if (line === OPENCODE_SHIM_BLOCK_BEGIN) begin += 1;
    else if (line === OPENCODE_SHIM_BLOCK_END) end += 1;
  }
  return { begin, end };
}

/**
 * Classify the rc file's managed region against the canonical block for THIS (shimPath, port, host):
 *   absent      — ZERO begin and ZERO end markers anywhere in the file.
 *   owned       — EXACTLY one begin/end (end after begin) and the delimited region equals the canonical block
 *                 byte-for-byte. Exactly one of each marker means no additional/lone/nested marker exists.
 *   owned-stale — one clean marker pair whose body is unmistakably OURS (the exact source line for THIS shim
 *                 path plus only our managed COSYNCING_OPENCODE_PORT/HOST set-if-unset lines) but with a drifted
 *                 port/host or an older line set. Safe to re-canonicalize in place and to excise on uninstall.
 *   foreign     — everything else: a lone begin/end, duplicate/nested blocks, an edited body (any non-managed
 *                 line, or a source line for a DIFFERENT path). foreign is never rewritten or excised —
 *                 preserved-and-warned.
 */
export function inspectRcBlock(content: string, shimPath: string, port: number, host: string = OPENCODE_SHIM_DEFAULT_HOST): RcBlockState {
  const lines = splitLines(content);
  const counts = markerCounts(lines);
  if (counts.begin === 0 && counts.end === 0) return 'absent';
  if (counts.begin !== 1 || counts.end !== 1) return 'foreign';
  const begin = lines.indexOf(OPENCODE_SHIM_BLOCK_BEGIN);
  const end = lines.indexOf(OPENCODE_SHIM_BLOCK_END);
  if (end <= begin) return 'foreign';
  const region = lines.slice(begin, end + 1);
  const canonical = opencodeShimBlockLines(shimPath, port, host);
  if (region.length === canonical.length && region.every((line, index) => line === canonical[index])) return 'owned';
  return rcRegionIsOurTemplate(region, shimPath) ? 'owned-stale' : 'foreign';
}

/**
 * True when a marker region is unmistakably a cosyncing-written block for THIS shim path that only drifted in
 * its pinned port/host (or predates the host line): the region is delimited by our exact markers, contains
 * EXACTLY one source line that dot-sources THIS shim path, and every other inner line is one of our managed
 * `: "${COSYNCING_OPENCODE_PORT:=<digits>}"` / `: "${COSYNCING_OPENCODE_HOST:=<value>}"` set-if-unset lines. A
 * user edit (any other inner line, or a source line for a different path) fails this and stays foreign.
 */
function rcRegionIsOurTemplate(region: readonly string[], shimPath: string): boolean {
  if (region.length < 3) return false;
  if (region[0] !== OPENCODE_SHIM_BLOCK_BEGIN || region[region.length - 1] !== OPENCODE_SHIM_BLOCK_END) return false;
  const quoted = posixSingleQuote(shimPath);
  const sourceLine = `[ -f ${quoted} ] && . ${quoted}`;
  const inner = region.slice(1, -1);
  if (inner.filter((line) => line === sourceLine).length !== 1) return false;
  return inner.every((line) =>
    line === sourceLine
    || /^: "\$\{COSYNCING_OPENCODE_PORT:=[0-9]+\}"$/.test(line)
    || /^: "\$\{COSYNCING_OPENCODE_HOST:=[^"]*\}"$/.test(line));
}

/**
 * Idempotently install the managed block for (shimPath, port, host). When exactly one marker region already
 * exists, replace it in place with the canonical block (re-canonicalize); otherwise append after one
 * blank-line separator. Every other byte is preserved. Callers MUST gate on inspectRcBlock ∈ {absent, owned,
 * owned-stale}: a foreign block (lone/duplicate/edited markers, or a source line for another path) is never
 * passed here, so this never clobbers unrecognized content.
 */
export function installRcBlock(content: string, shimPath: string, port: number, host: string = OPENCODE_SHIM_DEFAULT_HOST): string {
  const canonical = opencodeShimBlockLines(shimPath, port, host);
  const lines = splitLines(content);
  const counts = markerCounts(lines);
  if (counts.begin === 1 && counts.end === 1) {
    const begin = lines.indexOf(OPENCODE_SHIM_BLOCK_BEGIN);
    const end = lines.indexOf(OPENCODE_SHIM_BLOCK_END);
    if (end > begin) {
      lines.splice(begin, end - begin + 1, ...canonical);
      return lines.join('\n');
    }
  }
  const block = `${canonical.join('\n')}\n`;
  if (content.length === 0) return block;
  const terminated = content.endsWith('\n') ? content : `${content}\n`;
  return `${terminated}\n${block}`;
}

/**
 * Remove the single managed region (BEGIN..END) plus one adjacent blank line — preferring the leading separator
 * install added — preserving every other byte. Returns undefined when no complete region exists. It runs only
 * on an 'owned' file (gated in the lifecycle), where exactly one region exists, so it exactly reverses
 * installRcBlock and a round-trip restores the file's original content.
 */
export function exciseRcBlock(content: string): string | undefined {
  const lines = splitLines(content);
  const begin = lines.indexOf(OPENCODE_SHIM_BLOCK_BEGIN);
  if (begin === -1) return undefined;
  const end = lines.indexOf(OPENCODE_SHIM_BLOCK_END);
  if (end === -1 || end <= begin) return undefined;
  let start = begin;
  let stop = end;
  if (start > 0 && lines[start - 1] === '') start -= 1;
  else if (stop + 1 < lines.length && lines[stop + 1] === '') stop += 1;
  lines.splice(start, stop - start + 1);
  return lines.join('\n');
}

export type RcFileInspection =
  | { status: 'absent' }
  | { status: 'unsafe' }
  | { status: 'present'; content: string; blockState: RcBlockState };

/**
 * Safe read of an rc file for block inspection/mutation: refuse symlinks and non-owned/non-regular files
 * (rc files are commonly 0644, so owner-only *mode* is NOT required here — only ownership and no symlink).
 */
export function inspectRcFile(path: string, shimPath: string, port: number, host: string = OPENCODE_SHIM_DEFAULT_HOST): RcFileInspection {
  try {
    assertNoSymlinkParents(path);
    if (!existsSync(path)) return { status: 'absent' };
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return { status: 'unsafe' };
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid !== undefined && stat.uid !== uid) return { status: 'unsafe' };
    const content = readFileSync(path, 'utf8');
    return { status: 'present', content, blockState: inspectRcBlock(content, shimPath, port, host) };
  } catch {
    return { status: 'unsafe' };
  }
}
