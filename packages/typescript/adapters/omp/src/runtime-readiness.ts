import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { open as openFile, type FileHandle } from 'node:fs/promises';
import { dirname, join, parse, win32 } from 'node:path';
import {
  compareSemanticVersions,
  resolveInvocation,
  resolvedInvocationKind,
  semanticVersionFromText,
  spawnSyncResolvedInvocation,
  type ResolvedInvocation,
  type SetupCheck,
  type SetupCommandProbe,
  type SetupDiagnosisContext,
} from '@cosyncing/adapter-api';

export const OMP_DEFAULT_BUN_MINIMUM_VERSION = '1.3.14';
/**
 * The omp versions whose mutable RPC/event/session contract was physically captured (the parity
 * fixtures). Readiness, doctor and the broker's bridge hello accept exactly these; every other
 * version, including one between two listed releases, stays Observe-only until it is captured too.
 */
export const OMP_VERIFIED_VERSIONS: readonly string[] = Object.freeze(['17.4.2', '19.1.0']);
/** The newest verified version: the one remediation recommends installing. */
export const OMP_VERIFIED_VERSION = '19.1.0';
/** `engines.bun` of {@link OMP_VERIFIED_VERSION}; omp 19 does not start on an older Bun. */
export const OMP_VERIFIED_VERSION_BUN_FLOOR = '1.4.4';
export const OMP_MINIMUM_SUPPORTED_VERSION = '17.4.2';

/** Whether `version` is exactly one of the captured omp versions. */
export function isOmpVerifiedVersion(version: unknown): boolean {
  if (typeof version !== 'string') return false;
  return OMP_VERIFIED_VERSIONS.some((verified) => compareSemanticVersions(version, verified) === 0);
}

/**
 * The first captured omp whose RPC has `fork` again (upstream restored it in 18.4.11; 17.4.2 has
 * none). A bare fork copies the whole session; `entryId` keeps that entry (measured on 19.1.0).
 */
export const OMP_RPC_FORK_MINIMUM_VERSION = '19.1.0';

/** Whether this omp build's RPC can fork: a verified version at or above the first one measured. */
export function ompSupportsRpcFork(version: unknown): boolean {
  if (typeof version !== 'string' || !isOmpVerifiedVersion(version)) return false;
  const comparison = compareSemanticVersions(version, OMP_RPC_FORK_MINIMUM_VERSION);
  return comparison !== undefined && comparison >= 0;
}

/** Where omp 19.1.0's writer stamp sits in a serialized entry; only a line that has it is parsed. */
const OMP_WRITER_MARKER = '"runtime":{"version":"';
const OMP_WRITER_SCAN_CHUNK_BYTES = 1024 * 1024;
const OMP_WRITER_CACHE_LIMIT = 64;

/** The omp writer stamps of one session file. */
export interface OmpWriterStamps {
  /** The newest version among the stamps that compare; undefined when there is none. */
  newest?: string;
  /** Some stamp's version does not compare, so no configured omp can be shown to be as new. */
  incomparable: boolean;
}

const ompWriterStampCache = new Map<string, { size: number; mtimeMs: number; stamps: OmpWriterStamps }>();

/**
 * The writer stamps of a session file, from the `runtime.version` omp 19.1.0 sets on every entry it
 * appends (measured; `SessionEntryBase.runtime`). omp 17.4.2 writes none, so a file only it wrote
 * has no newest version. Only an entry's own top-level `runtime` counts: a line that carries the
 * marker is parsed, so an object of the same shape nested in it (a tool's `details`) is not taken
 * for a writer. The file is read asynchronously in bounded chunks, linear in its size, and the
 * result is cached by path, size and mtime, so the broker reads each version of a file once. An
 * unreadable file has no stamps.
 */
export async function readOmpWriterStamps(sessionFile: string): Promise<OmpWriterStamps> {
  let handle: FileHandle | undefined;
  try {
    handle = await openFile(sessionFile, 'r');
    const { size, mtimeMs } = await handle.stat();
    const cached = ompWriterStampCache.get(sessionFile);
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.stamps;
    const stamps: OmpWriterStamps = { incomparable: false };
    const take = (line: string): void => {
      if (!line.includes(OMP_WRITER_MARKER)) return;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        return;
      }
      const runtime = entry !== null && typeof entry === 'object' ? (entry as { runtime?: unknown }).runtime : undefined;
      const version = runtime !== null && typeof runtime === 'object' ? (runtime as { version?: unknown }).version : undefined;
      if (typeof version !== 'string') return;
      if (compareSemanticVersions(version, version) === undefined) {
        stamps.incomparable = true;
        return;
      }
      if (stamps.newest === undefined || (compareSemanticVersions(version, stamps.newest) ?? 0) > 0) stamps.newest = version;
    };
    const buffer = Buffer.alloc(OMP_WRITER_SCAN_CHUNK_BYTES);
    const decoder = new TextDecoder('utf-8');
    // The line still open at the end of the last chunk, in pieces, so a long line stays linear.
    let pieces: string[] = [];
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      const text = decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      let start = 0;
      for (let newline = text.indexOf('\n'); newline >= 0; newline = text.indexOf('\n', start)) {
        pieces.push(text.slice(start, newline));
        take(pieces.join(''));
        pieces = [];
        start = newline + 1;
      }
      if (start < text.length) pieces.push(text.slice(start));
    }
    pieces.push(decoder.decode());
    take(pieces.join(''));
    ompWriterStampCache.delete(sessionFile);
    if (ompWriterStampCache.size >= OMP_WRITER_CACHE_LIMIT) {
      const oldest = ompWriterStampCache.keys().next().value;
      if (oldest !== undefined) ompWriterStampCache.delete(oldest);
    }
    ompWriterStampCache.set(sessionFile, { size, mtimeMs, stamps });
    return stamps;
  } catch {
    return { incomparable: false };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Why the configured omp must not continue or change a session file: a newer omp wrote it, or a
 * stamp's version cannot be compared with the configured one. An older omp does not know the newer
 * one's replay rules (omp 17.4.2 ignores the `activeLeafId` that omp 19.1.0 records for entries
 * written off the active branch), so it could continue on the wrong branch. Undefined when the
 * configured omp is at least as new as every writer, or its version is unknown (readiness refuses
 * that case on its own).
 */
export async function ompNativeWriteRefusal(sessionFile: string, configuredVersion: string | undefined): Promise<string | undefined> {
  if (!configuredVersion) return undefined;
  const stamps = await readOmpWriterStamps(sessionFile);
  const outcome = 'so cosyncing will not continue or change it. Continue it in a terminal with the omp that wrote it, or update the omp cosyncing uses; it stays readable here.';
  if (stamps.incomparable) {
    return `This omp session carries an omp version that cosyncing cannot compare with the omp ${configuredVersion} it runs, ${outcome}`;
  }
  if (stamps.newest === undefined) return undefined;
  const comparison = compareSemanticVersions(stamps.newest, configuredVersion);
  if (comparison !== undefined && comparison <= 0) return undefined;
  return `This omp session was written by omp ${stamps.newest}, which is newer than the omp ${configuredVersion} cosyncing runs, ${outcome}`;
}

/** The verified versions as prose: `17.4.2 and 19.1.0`. */
export function ompVerifiedVersionsText(): string {
  const versions = [...OMP_VERIFIED_VERSIONS];
  return versions.length > 1 ? `${versions.slice(0, -1).join(', ')} and ${versions.at(-1)}` : versions[0] ?? '';
}

/** What to install instead, with the newest version's Bun floor (omp 19 refuses an older Bun). */
export function ompVerifiedInstallHint(): string {
  const older = OMP_VERIFIED_VERSIONS.filter((version) => version !== OMP_VERIFIED_VERSION);
  return `Install omp ${OMP_VERIFIED_VERSION} (it needs Bun ${OMP_VERIFIED_VERSION_BUN_FLOOR} or newer)${older.length ? ` or omp ${older.join(' or ')}` : ''}`;
}

/**
 * Where a parsed omp version stands: one of the captured versions, below the floor, or newer than
 * the floor without a capture (above the newest, or between two captured releases). `undefined`
 * when the version does not compare.
 */
export function ompVersionVerdict(version: string): 'verified' | 'below-minimum' | 'unverified' | undefined {
  const floor = compareSemanticVersions(version, OMP_MINIMUM_SUPPORTED_VERSION);
  if (floor === undefined) return undefined;
  if (floor < 0) return 'below-minimum';
  return isOmpVerifiedVersion(version) ? 'verified' : 'unverified';
}

/** The readiness refusal for an omp `subject` (`The installed omp package is 18.2.0`). */
function unsupportedOmpVersionMessage(subject: string, verdict: 'below-minimum' | 'unverified'): string {
  return verdict === 'unverified'
    ? `${subject}, but mutable sync is verified only for omp ${ompVerifiedVersionsText()}. ${ompVerifiedInstallHint()}, or wait for a new protocol capture, then restart cosyncing.`
    : `${subject}, but ${OMP_MINIMUM_SUPPORTED_VERSION} is required. ${ompVerifiedInstallHint()}, then restart cosyncing.`;
}

/**
 * The omp to install on the Bun that would run it, as a runnable command: the newest captured build
 * when that Bun meets its floor, otherwise the older captured build (and say Bun must be upgraded
 * first for the newer one). An unknown Bun gets the build that runs on the default floor.
 */
export function ompInstallAdvice(bunVersion: string | undefined): { command: string; message: string } {
  const install = (version: string) => `bun install -g @oh-my-pi/pi-coding-agent@${version}`;
  const comparison = bunVersion ? compareSemanticVersions(bunVersion, OMP_VERIFIED_VERSION_BUN_FLOOR) : undefined;
  if (comparison !== undefined && comparison >= 0) {
    return { command: install(OMP_VERIFIED_VERSION), message: `Install omp ${OMP_VERIFIED_VERSION}, which Bun ${bunVersion} runs` };
  }
  const older = OMP_VERIFIED_VERSIONS.filter((version) => version !== OMP_VERIFIED_VERSION).at(-1) ?? OMP_MINIMUM_SUPPORTED_VERSION;
  const upgrade = `omp ${OMP_VERIFIED_VERSION} needs Bun ${OMP_VERIFIED_VERSION_BUN_FLOOR} or newer, so upgrade Bun first to use it`;
  return {
    command: install(older),
    message: bunVersion && comparison !== undefined
      ? `Install omp ${older}, which runs on Bun ${bunVersion} (${upgrade})`
      : `Install omp ${older} (${upgrade})`,
  };
}

/** The doctor check for an omp version that is not one of the captured ones. */
function unsupportedOmpVersionDiagnosis(
  detailCode: string,
  subject: string,
  version: string,
  verdict: 'below-minimum' | 'unverified',
  bunVersion: string | undefined,
): SetupCheck {
  const advice = ompInstallAdvice(bunVersion);
  return {
    id: 'omp.bun-runtime',
    status: 'fail',
    detailCode,
    summary: verdict === 'unverified'
      ? `${subject} is omp ${version}, but mutable sync is verified only for omp ${ompVerifiedVersionsText()}.`
      : `${subject} is omp ${version}, but ${OMP_MINIMUM_SUPPORTED_VERSION} is required.`,
    evidence: { installedVersion: version, verifiedVersion: OMP_VERIFIED_VERSION },
    remediation: {
      kind: 'command',
      message: verdict === 'unverified'
        ? `${advice.message}, or wait for a new protocol capture, then rerun doctor.`
        : `${advice.message}, then rerun doctor.`,
      command: advice.command,
    },
  };
}

const OMP_PACKAGE_NAMES: readonly string[] = [
  '@oh-my-pi/pi-coding-agent',
];
const PACKAGE_JSON_MAX_BYTES = 256 * 1024;
const LAUNCHER_PREFIX_MAX_BYTES = 4096;
const RUNTIME_CACHE_TTL_MS = 2_000;

export interface OmpRuntimeReadiness {
  ready: boolean;
  detailCode: string;
  message: string;
  executable?: string;
  bunExecutable?: string;
  bunVersion?: string;
  requiredBunVersion?: string;
  packageVersion?: string;
}

interface OmpPackageRuntimeContract {
  version?: string;
  minimumBunVersion: string;
}

export type OmpBoundedTextRead =
  | { ok: true; text: string }
  | { ok: false; reason: 'missing' | 'unreadable' | 'too-large' };

/**
 * The host surface omp readiness touches: PATH resolution, two bounded reads, and one bounded
 * version probe. Same injection rule as the pi gate: a launcher shape is a property of the host,
 * not of the code under test, so Windows-shaped fixtures inject this surface rather than being
 * approximated on a POSIX runner.
 */
export interface OmpRuntimeHost {
  platform: string;
  /** Resolution seams shared with `resolveInvocation`, for Windows-shaped fixture paths. */
  isExecutableFile?: (path: string) => boolean;
  canonicalize?: (path: string) => string;
  /** Raw launcher head, for the POSIX shebang branch only. */
  readLauncherPrefix: (path: string, maxBytes: number) => string | undefined;
  readBoundedText: (path: string, maxBytes: number) => OmpBoundedTextRead;
  /**
   * Combined stdout+stderr of a bounded, hidden `--version`.
   *
   * Takes the INVOCATION rather than a path: a Windows `.cmd` launcher is only safely spawnable
   * through the shared boundary's private cmd.exe encoding, and probing it is now part of proving
   * its identity.
   */
  probeVersionOutput: (invocation: ResolvedInvocation, env: NodeJS.ProcessEnv) => OmpVersionProbe;
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

function defaultOmpRuntimeHost(): OmpRuntimeHost {
  return {
    platform: process.platform,
    readLauncherPrefix: (path, maxBytes) => readPrefix(path, maxBytes),
    readBoundedText: (path, maxBytes) => {
      try {
        const stat = statSync(path);
        if (!stat.isFile()) return { ok: false, reason: 'unreadable' };
        if (stat.size > maxBytes) return { ok: false, reason: 'too-large' };
        return { ok: true, text: readFileSync(path, 'utf8') };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        return { ok: false, reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable' };
      }
    },
    probeVersionOutput: (invocation, env) => boundedVersionProbe(invocation, env),
  };
}

function resolveHostInvocation(
  command: string,
  env: NodeJS.ProcessEnv,
  host: OmpRuntimeHost,
): ResolvedInvocation | undefined {
  return resolveInvocation(command, {
    env,
    platform: host.platform,
    ...(host.isExecutableFile ? { isExecutableFile: host.isExecutableFile } : {}),
    ...(host.canonicalize ? { canonicalize: host.canonicalize } : {}),
  });
}

function readPrefix(path: string, maxBytes = LAUNCHER_PREFIX_MAX_BYTES): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const bytes = Buffer.alloc(maxBytes);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    return bytes.subarray(0, count).toString('utf8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
  }
}

function minimumVersionFromBunEngine(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const lowerBound = value.match(/(?:^|[|\s])>=\s*v?(\d+\.\d+\.\d+)/)?.[1];
  if (lowerBound) return lowerBound;
  return value.trim().match(/^[~^]?v?(\d+\.\d+\.\d+)$/)?.[1];
}

function packageRuntimeContract(
  executable: string,
  readText: (path: string) => string | undefined,
): OmpPackageRuntimeContract {
  let current = dirname(canonical(executable));
  const root = parse(current).root;
  for (let depth = 0; depth < 10; depth += 1) {
    const text = readText(join(current, 'package.json'));
    if (text !== undefined) {
      try {
        const pkg = JSON.parse(text) as {
          name?: unknown;
          version?: unknown;
          engines?: { bun?: unknown };
        };
        if (typeof pkg.name === 'string' && OMP_PACKAGE_NAMES.includes(pkg.name)) {
          return {
            ...(typeof pkg.version === 'string' ? { version: pkg.version } : {}),
            minimumBunVersion:
              minimumVersionFromBunEngine(pkg.engines?.bun)
              ?? OMP_DEFAULT_BUN_MINIMUM_VERSION,
          };
        }
      } catch {
        // Keep walking through wrapper/package nesting. An unrelated malformed package cannot
        // lower the conservative fallback used for the actual omp launcher.
      }
    }
    if (current === root) break;
    current = dirname(current);
  }
  return { minimumBunVersion: OMP_DEFAULT_BUN_MINIMUM_VERSION };
}

type OmpBatchIdentity =
  | { status: 'ok'; contract: OmpPackageRuntimeContract }
  | { status: 'missing' }
  | { status: 'ambiguous' }
  | { status: 'invalid' };

/**
 * Recover the installed omp package from a Windows bun/npm launcher. Same layout rule as the pi
 * gate: the shim sits in the global prefix root and the package under `<prefix>\node_modules\<name>`,
 * with no symlink, so the POSIX walk-up cannot reach it. Fails closed: on this path the package IS
 * the identity proof.
 */
function batchPackageIdentity(
  launcher: string,
  readText: (path: string, maxBytes: number) => OmpBoundedTextRead,
): OmpBatchIdentity {
  const modules = win32.join(win32.dirname(launcher), 'node_modules');
  const found: OmpPackageRuntimeContract[] = [];
  for (const name of OMP_PACKAGE_NAMES) {
    const read = readText(win32.join(modules, ...name.split('/'), 'package.json'), PACKAGE_JSON_MAX_BYTES);
    if (!read.ok) {
      if (read.reason === 'missing') continue;
      return { status: 'invalid' };
    }
    let parsed: unknown;
    try { parsed = JSON.parse(read.text); } catch { return { status: 'invalid' }; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'invalid' };
    const pkg = parsed as { name?: unknown; version?: unknown; engines?: { bun?: unknown } };
    if (pkg.name !== name || typeof pkg.version !== 'string') return { status: 'invalid' };
    found.push({
      version: pkg.version,
      minimumBunVersion:
        minimumVersionFromBunEngine(pkg.engines?.bun) ?? OMP_DEFAULT_BUN_MINIMUM_VERSION,
    });
  }
  if (found.length === 0) return { status: 'missing' };
  if (found.length > 1) return { status: 'ambiguous' };
  return { status: 'ok', contract: found[0]! };
}

/**
 * The interpreter a Windows shim actually uses: `bun.exe` beside the shim when the global prefix is
 * the Bun installation directory, and PATH `bun` otherwise. Answering from PATH alone would name the
 * wrong interpreter whenever an older Bun shadows the one omp is installed under.
 */
function batchBunCandidates(launcher: string): readonly string[] {
  return [win32.join(win32.dirname(launcher), 'bun.exe'), 'bun'];
}

function bunRuntimeRemediation(minimumBunVersion: string): { kind: 'manual'; message: string } {
  return {
    kind: 'manual',
    message: `Install Bun ${minimumBunVersion} or newer, ensure the durable broker service PATH selects it, then restart cosyncing.`,
  };
}

/**
 * The interpreter an omp POSIX launcher needs. omp is Bun-distributed: a `#!/usr/bin/env bun`
 * (or direct bun-path) shebang means Bun is required; NO shebang means a native/compiled executable
 * where Bun is not involved. Anything else (node, python, …) is not a supported omp launcher.
 */
function bunCommandFromShebang(prefix: string): string | undefined | null {
  if (!prefix.startsWith('#!')) return null; // native/compiled omp executable: Bun is not involved
  const firstLine = prefix.slice(2).split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!firstLine) return undefined;
  const tokens = firstLine.split(/\s+/).filter(Boolean);
  const interpreter = tokens.shift();
  if (!interpreter) return undefined;
  if (interpreter.endsWith('/env')) {
    while (tokens[0]?.startsWith('-')) tokens.shift();
    const command = tokens[0]?.split('=')[0];
    return command === 'bun' ? 'bun' : undefined;
  }
  const basename = interpreter.split('/').pop();
  return basename === 'bun' ? interpreter : undefined;
}

function unsupportedReadiness(
  detailCode: string,
  message: string,
  evidence: Omit<OmpRuntimeReadiness, 'ready' | 'detailCode' | 'message'> = {},
): OmpRuntimeReadiness {
  return { ready: false, detailCode, message, ...evidence };
}

/**
 * What a bounded `--version` probe learned. A launcher that answered something unusable and one
 * that did not answer in time are different facts, and telling an operator to reinstall omp is only
 * right for the first.
 */
export interface OmpVersionProbe {
  output?: string;
  /** The probe hit its own deadline. Says nothing about the installation. */
  timedOut?: boolean;
}

/** Attempts for a probe that times out. See {@link boundedVersionProbe}. */
const VERSION_PROBE_ATTEMPTS = 2;

function runVersionProbe(
  invocation: ResolvedInvocation,
  env: NodeJS.ProcessEnv,
): OmpVersionProbe {
  try {
    const probe = spawnSyncResolvedInvocation(invocation, ['--version'], {
      encoding: 'utf8',
      env: { ...env },
      input: '',
      timeout: 3_000,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    // A killed probe is a DEADLINE, not an answer. Node reports the timeout kill through `signal`
    // (and an ETIMEDOUT `error` on some hosts); either way nothing was learned about the launcher.
    const timedOut = !!probe.signal
      || (probe.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
    if (timedOut) return { timedOut: true };
    if (probe.error || probe.status !== 0) return {};
    return { output: `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`.trim() };
  } catch {
    return {};
  }
}

/**
 * One retry, and only for a timeout. Same rule as the pi gate: a probe's three-second budget
 * disappears when the machine is busy, and "reinstall omp" is the wrong instruction for that.
 */
function boundedVersionProbe(
  invocation: ResolvedInvocation,
  env: NodeJS.ProcessEnv,
): OmpVersionProbe {
  let probe: OmpVersionProbe = {};
  for (let attempt = 1; attempt <= VERSION_PROBE_ATTEMPTS; attempt += 1) {
    probe = runVersionProbe(invocation, env);
    if (!probe.timedOut) return probe;
  }
  return probe;
}

/**
 * Recognize omp's `--version` answer. omp 17.4.2 prints a BARE version (`17.4.2\n`) with no name
 * token, so the pi-style "name on the version line" rule alone would reject a genuine omp; omp
 * 19.1.0 prints `omp/19.1.0\n` (measured). Accept an omp/oh-my-pi name line carrying the version
 * (including the `name/version` form), or output that IS exactly one version.
 */
export function ompIdentityVersion(output: string): string | undefined {
  const version = semanticVersionFromText(output);
  if (!version) return undefined;
  const identifiesOmp = output.split(/\r?\n/).some((line) =>
    /(?:^|[\s/@-])(?:omp|oh-my-pi)(?:$|[\s:@/-])/i.test(line) && line.includes(version));
  if (identifiesOmp) return version;
  return output.trim() === version ? version : undefined;
}

export function inspectOmpRuntimeReadiness(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<OmpRuntimeHost> = {},
): OmpRuntimeReadiness {
  const host: OmpRuntimeHost = { ...defaultOmpRuntimeHost(), ...overrides };
  const configured = env.COSYNCING_OMP_BIN?.trim() || 'omp';
  const invocation = resolveInvocation(configured, {
    env,
    platform: host.platform,
    ...(host.isExecutableFile ? { isExecutableFile: host.isExecutableFile } : {}),
    ...(host.canonicalize ? { canonicalize: host.canonicalize } : {}),
  });
  if (!invocation) {
    return unsupportedReadiness(
      'omp-binary-missing',
      'omp is not installed or is not visible to the broker service. Install omp, then restart cosyncing.',
    );
  }
  const executable = invocation.originalPath;

  let contract: OmpPackageRuntimeContract;
  let bunCandidates: readonly string[];

  if (invocation.kind === 'batch') {
    // The resolver already decided this file is launched through cmd.exe. That is what makes it a
    // bun/npm launcher — not the presence of a shebang, which no `.cmd` shim has.
    const identity = batchPackageIdentity(executable, host.readBoundedText);
    if (identity.status === 'missing') {
      return unsupportedReadiness(
        'omp-package-identity-missing',
        'omp resolves to a Windows launcher, but no supported omp package is installed beside it. Reinstall omp with bun or point COSYNCING_OMP_BIN at the supported omp executable, then restart cosyncing.',
        { executable },
      );
    }
    if (identity.status === 'ambiguous') {
      return unsupportedReadiness(
        'omp-package-identity-ambiguous',
        'omp resolves to a Windows launcher with more than one supported omp package installed beside it, so its effective runtime contract is ambiguous. Remove the unused omp package, then restart cosyncing.',
        { executable },
      );
    }
    if (identity.status === 'invalid') {
      return unsupportedReadiness(
        'omp-package-metadata-invalid',
        'omp resolves to a Windows launcher whose installed package metadata cannot be read safely. Reinstall omp with bun, then restart cosyncing.',
        { executable },
      );
    }
    // A package beside the shim proves an omp installation exists there. It does NOT prove that THIS
    // shim launches it — a replaced or foreign `omp.cmd` dropped into the same prefix would otherwise
    // pass on its neighbour's evidence. So the launcher is asked what it is, through the shared
    // boundary's own cmd.exe encoding, and its answer must be the version installed beside it.
    const declaredVersion = semanticVersionFromText(identity.contract.version ?? '');
    const versionProbe = host.probeVersionOutput(invocation, env);
    if (versionProbe.timedOut) {
      return unsupportedReadiness(
        'omp-version-probe-timed-out',
        'omp did not answer a bounded version check in time, which usually means the machine is busy rather than that omp is broken. Try again; if it keeps happening, repair the omp installation.',
        { executable, ...(identity.contract.version ? { packageVersion: identity.contract.version } : {}) },
      );
    }
    const reportedVersion = semanticVersionFromText(versionProbe.output ?? '');
    if (!declaredVersion || !reportedVersion) {
      return unsupportedReadiness(
        'omp-batch-version-unverified',
        'omp resolves to a Windows launcher that did not return a bounded, parsable version. Reinstall omp with bun or point COSYNCING_OMP_BIN at the supported omp executable, then restart cosyncing.',
        { executable, ...(identity.contract.version ? { packageVersion: identity.contract.version } : {}) },
      );
    }
    if (declaredVersion !== reportedVersion) {
      return unsupportedReadiness(
        'omp-batch-identity-mismatch',
        `The resolved omp launcher reports ${reportedVersion}, but the omp package installed beside it is ${declaredVersion}, so the launcher does not run that installation. Reinstall omp with bun or point COSYNCING_OMP_BIN at the supported omp executable, then restart cosyncing.`,
        { executable, packageVersion: identity.contract.version },
      );
    }
    const batchVerdict = ompVersionVerdict(reportedVersion);
    if (batchVerdict !== 'verified') {
      const verdict = batchVerdict === 'unverified' ? 'unverified' : 'below-minimum';
      return unsupportedReadiness(
        verdict === 'unverified' ? 'omp-batch-version-above-verified' : 'omp-batch-version-below-minimum',
        unsupportedOmpVersionMessage(`The resolved omp launcher is omp ${reportedVersion}`, verdict),
        { executable, packageVersion: reportedVersion },
      );
    }
    contract = identity.contract;
    bunCandidates = batchBunCandidates(executable);
  } else {
    const prefix = host.readLauncherPrefix(executable, LAUNCHER_PREFIX_MAX_BYTES);
    if (prefix === undefined) {
      return unsupportedReadiness(
        'omp-launcher-unreadable',
        'omp is installed, but its launcher cannot be inspected safely. Repair the omp installation, then restart cosyncing.',
        { executable },
      );
    }
    const bunCommand = bunCommandFromShebang(prefix);
    if (bunCommand === null) {
      const nativeProbe = host.probeVersionOutput(invocation, env);
      if (nativeProbe.timedOut) {
        return unsupportedReadiness(
          'omp-version-probe-timed-out',
          'omp did not answer a bounded version check in time, which usually means the machine is busy rather than that omp is broken. Try again; if it keeps happening, repair the omp installation.',
          { executable },
        );
      }
      const version = nativeProbe.output === undefined ? undefined : ompIdentityVersion(nativeProbe.output);
      if (!version) {
        return unsupportedReadiness(
          'omp-native-identity-unverified',
          'The configured omp executable does not provide a bounded, recognizable omp version response. Point COSYNCING_OMP_BIN at the supported omp executable, then restart cosyncing.',
          { executable },
        );
      }
      const nativeVerdict = ompVersionVerdict(version);
      if (nativeVerdict !== 'verified') {
        const verdict = nativeVerdict === 'unverified' ? 'unverified' : 'below-minimum';
        return unsupportedReadiness(
          verdict === 'unverified' ? 'omp-native-version-above-verified' : 'omp-native-version-below-minimum',
          unsupportedOmpVersionMessage(`The configured omp executable is omp ${version}`, verdict),
          { executable, packageVersion: version },
        );
      }
      return {
        ready: true,
        detailCode: 'omp-native-runtime-ready',
        message: `omp ${version} uses a verified native runtime and is available for session creation.`,
        executable,
        packageVersion: version,
      };
    }
    if (!bunCommand) {
      return unsupportedReadiness(
        'omp-bun-interpreter-unresolved',
        'omp uses a launcher whose effective Bun interpreter cannot be verified. Point COSYNCING_OMP_BIN at the supported omp executable or repair its launcher.',
        { executable },
      );
    }
    contract = packageRuntimeContract(executable, (path) => {
      const read = host.readBoundedText(path, PACKAGE_JSON_MAX_BYTES);
      return read.ok ? read.text : undefined;
    });
    if (!contract.version) {
      const launcherProbe = host.probeVersionOutput(invocation, env);
      if (launcherProbe.timedOut) {
        return unsupportedReadiness(
          'omp-version-probe-timed-out',
          'omp did not answer a bounded version check in time, which usually means the machine is busy rather than that omp is broken. Try again; if it keeps happening, repair the omp installation.',
          { executable },
        );
      }
      const launcherVersion = ompIdentityVersion(launcherProbe.output ?? '');
      if (!launcherVersion) {
        return unsupportedReadiness(
          'omp-posix-identity-unverified',
          'The configured Bun launcher has no recognized omp package metadata and did not provide a bounded, recognizable omp version response. Point COSYNCING_OMP_BIN at the supported omp executable, then restart cosyncing.',
          { executable },
        );
      }
      const launcherVerdict = ompVersionVerdict(launcherVersion);
      if (launcherVerdict !== 'verified') {
        const verdict = launcherVerdict === 'unverified' ? 'unverified' : 'below-minimum';
        return unsupportedReadiness(
          verdict === 'unverified' ? 'omp-posix-version-above-verified' : 'omp-posix-version-below-minimum',
          unsupportedOmpVersionMessage(`The configured Bun launcher is omp ${launcherVersion}`, verdict),
          { executable, packageVersion: launcherVersion },
        );
      }
      contract = { ...contract, version: launcherVersion };
    } else {
      const packageVersion = semanticVersionFromText(contract.version);
      const packageVerdict = packageVersion ? ompVersionVerdict(packageVersion) : undefined;
      if (!packageVersion || packageVerdict === undefined) {
        return unsupportedReadiness(
          'omp-package-version-unverified',
          'The installed omp package has an invalid version, so its RPC/session compatibility cannot be verified. Reinstall omp with bun, then restart cosyncing.',
          { executable, packageVersion: contract.version },
        );
      }
      if (packageVerdict !== 'verified') {
        return unsupportedReadiness(
          packageVerdict === 'unverified' ? 'omp-package-version-above-verified' : 'omp-package-version-below-minimum',
          unsupportedOmpVersionMessage(`The installed omp package is ${packageVersion}`, packageVerdict),
          { executable, packageVersion },
        );
      }
    }
    bunCandidates = [bunCommand];
  }

  let bunInvocation: ResolvedInvocation | undefined;
  for (const candidate of bunCandidates) {
    bunInvocation = resolveHostInvocation(candidate, env, host);
    if (bunInvocation) break;
  }
  const bunExecutable = bunInvocation?.originalPath;
  const evidence = {
    executable,
    ...(bunExecutable ? { bunExecutable } : {}),
    requiredBunVersion: contract.minimumBunVersion,
    ...(contract.version ? { packageVersion: contract.version } : {}),
  };
  if (!bunInvocation || !bunExecutable) {
    return unsupportedReadiness(
      'omp-bun-interpreter-missing',
      `omp requires Bun ${contract.minimumBunVersion} or newer, but its effective Bun interpreter is not on the broker service PATH. Upgrade/configure Bun, then restart cosyncing.`,
      evidence,
    );
  }

  const bunProbe = host.probeVersionOutput(bunInvocation, env);
  // Same rule as the launcher above: a probe that ran out of time says nothing about Bun, and
  // "Repair Bun" is the wrong instruction for a machine that was merely busy.
  if (bunProbe.timedOut) {
    return unsupportedReadiness(
      'omp-version-probe-timed-out',
      `omp requires Bun ${contract.minimumBunVersion} or newer, and its effective interpreter did not answer a bounded version check in time. The machine is likely busy; try again.`,
      evidence,
    );
  }
  const bunVersion = semanticVersionFromText(bunProbe.output ?? '');
  if (!bunVersion) {
    return unsupportedReadiness(
      'omp-bun-version-unavailable',
      `omp requires Bun ${contract.minimumBunVersion} or newer, but the effective interpreter version could not be verified. Repair Bun, then restart cosyncing.`,
      evidence,
    );
  }
  const supported = compareSemanticVersions(bunVersion, contract.minimumBunVersion);
  if (supported === undefined || supported < 0) {
    return unsupportedReadiness(
      'omp-bun-version-below-minimum',
      `omp requires Bun ${contract.minimumBunVersion} or newer, but its effective interpreter is Bun ${bunVersion}. Upgrade Bun and ensure the broker service PATH or COSYNCING_OMP_BIN resolves omp through it, then restart cosyncing.`,
      { ...evidence, bunVersion },
    );
  }
  return {
    ready: true,
    detailCode: 'omp-bun-runtime-supported',
    message: `omp uses supported Bun ${bunVersion}.`,
    ...evidence,
    bunVersion,
  };
}

let readinessCache: { key: string; at: number; value: OmpRuntimeReadiness } | undefined;

export function currentOmpRuntimeReadiness(): OmpRuntimeReadiness {
  const key = `${process.env.COSYNCING_OMP_BIN ?? ''}\0${process.env.PATH ?? ''}`;
  const now = Date.now();
  if (readinessCache && readinessCache.key === key && now - readinessCache.at < RUNTIME_CACHE_TTL_MS) {
    return readinessCache.value;
  }
  const value = inspectOmpRuntimeReadiness(process.env);
  readinessCache = { key, at: now, value };
  return value;
}

export function resetOmpRuntimeReadinessCache(): void {
  readinessCache = undefined;
}

/**
 * A doctor version probe with readiness's one-retry-on-timeout rule.
 *
 * Doctor's probe contract already distinguishes `timeout` from a bad answer; it was simply folded
 * in with the others, so a busy machine was diagnosed as a broken omp or a broken Bun and the
 * operator told to reinstall something that worked. One retry, and only for a timeout.
 */
async function boundedDoctorProbe(
  context: SetupDiagnosisContext,
  executable: string,
): Promise<SetupCommandProbe> {
  const probe = await context.runReadOnly(executable, ['--version'], 3_000);
  if (probe.status !== 'timeout') return probe;
  return context.runReadOnly(executable, ['--version'], 3_000);
}

/** The version of the first of `candidates` that resolves and answers, or undefined. */
async function doctorBunVersion(context: SetupDiagnosisContext, candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    const bun = context.resolveExecutable(candidate);
    if (!bun) continue;
    const probe = await boundedDoctorProbe(context, bun);
    return probe.status === 'ok' ? semanticVersionFromText(`${probe.stdout}\n${probe.stderr}`) : undefined;
  }
  return undefined;
}

/**
 * The Bun version an omp launcher would run on, for advice on which omp to install: the Bun beside
 * a Windows shim, or the one a POSIX launcher's shebang names. Undefined for a native executable,
 * an unreadable launcher, or a Bun that does not answer.
 */
export async function detectOmpBunVersion(context: SetupDiagnosisContext, executable: string): Promise<string | undefined> {
  if (resolvedInvocationKind(executable, context.platform) === 'batch') {
    return doctorBunVersion(context, batchBunCandidates(executable));
  }
  const launcherPath = canonical(executable);
  const launcher = context.readTextPrefix
    ? context.readTextPrefix(launcherPath, LAUNCHER_PREFIX_MAX_BYTES)
    : context.readText(launcherPath, LAUNCHER_PREFIX_MAX_BYTES);
  if (!launcher.ok) return undefined;
  const bunCommand = bunCommandFromShebang(launcher.text);
  return bunCommand ? doctorBunVersion(context, [bunCommand]) : undefined;
}

/** The only diagnosis a timed-out probe supports: nothing is known, and the fix is to try again. */
function ompProbeTimedOutDiagnosis(what: 'launcher' | 'interpreter', executable: string): SetupCheck {
  return {
    id: 'omp.bun-runtime',
    status: 'fail',
    detailCode: 'bun-runtime-probe-timed-out',
    summary: `omp's ${what} did not answer a bounded version check in time, so its version is unknown.`,
    evidence: { executable },
    remediation: {
      kind: 'manual',
      message: 'The machine is likely busy rather than misconfigured. Rerun doctor; if it keeps happening, repair the installation.',
    },
  };
}

export async function diagnoseOmpBunRuntime(
  context: SetupDiagnosisContext,
  executable: string | undefined,
): Promise<import('@cosyncing/adapter-api').SetupCheck> {
  if (!executable) {
    return {
      id: 'omp.bun-runtime',
      status: 'skip',
      detailCode: 'bun-runtime-binary-missing',
      summary: 'omp Bun runtime was not checked because omp is missing.',
    };
  }
  const kind = resolvedInvocationKind(executable, context.platform);
  let contract: OmpPackageRuntimeContract;
  let bunCandidates: readonly string[];
  if (kind === 'batch') {
    // Same rule as readiness: cmd.exe hosting is what marks a launcher on Windows, and the
    // installed package beside the shim is the only identity proof available for one.
    const identity = batchPackageIdentity(executable, (path, maxBytes) => context.readText(path, maxBytes));
    if (identity.status !== 'ok') {
      const failure = {
        missing: {
          detailCode: 'bun-runtime-package-missing',
          summary: 'omp resolves to a Windows launcher, but no supported omp package is installed beside it.',
          message: 'Reinstall omp with bun, then rerun doctor.',
        },
        ambiguous: {
          detailCode: 'bun-runtime-package-ambiguous',
          summary: 'omp resolves to a Windows launcher with more than one supported omp package installed beside it.',
          message: 'Remove the unused omp package, then rerun doctor.',
        },
        invalid: {
          detailCode: 'bun-runtime-package-invalid',
          summary: 'omp resolves to a Windows launcher whose installed package metadata cannot be read safely.',
          message: 'Reinstall omp with bun, then rerun doctor.',
        },
      }[identity.status];
      return {
        id: 'omp.bun-runtime',
        status: 'fail',
        detailCode: failure.detailCode,
        summary: failure.summary,
        evidence: { executable: context.displayPath(executable) },
        remediation: { kind: 'manual', message: failure.message },
      };
    }
    // Same binding as readiness: the package beside the shim is not evidence that THIS shim runs
    // it. `runReadOnly` resolves and launches through the shared boundary, so the batch encoding
    // stays private here too.
    const declaredVersion = semanticVersionFromText(identity.contract.version ?? '');
    const launcherProbe = await boundedDoctorProbe(context, executable);
    if (launcherProbe.status === 'timeout') {
      return ompProbeTimedOutDiagnosis('launcher', context.displayPath(executable));
    }
    const reportedVersion = launcherProbe.status === 'ok'
      ? semanticVersionFromText(`${launcherProbe.stdout}\n${launcherProbe.stderr}`)
      : undefined;
    const ompVerdict = reportedVersion ? ompVersionVerdict(reportedVersion) : undefined;
    if (!declaredVersion || !reportedVersion) {
      return {
        id: 'omp.bun-runtime',
        status: 'fail',
        detailCode: 'bun-runtime-launcher-version-unverified',
        summary: 'The resolved omp launcher did not return a bounded, parsable version.',
        evidence: { executable: context.displayPath(executable) },
        remediation: {
          kind: 'manual',
          message: 'Reinstall omp with bun or point COSYNCING_OMP_BIN at the supported omp executable, then rerun doctor.',
        },
      };
    }
    if (declaredVersion !== reportedVersion) {
      return {
        id: 'omp.bun-runtime',
        status: 'fail',
        detailCode: 'bun-runtime-launcher-package-mismatch',
        summary: `The resolved omp launcher reports ${reportedVersion}, but the omp package installed beside it is ${declaredVersion}, so the launcher does not run that installation.`,
        evidence: { executable: context.displayPath(executable), installedVersion: declaredVersion },
        remediation: {
          kind: 'manual',
          message: 'Reinstall omp with bun or point COSYNCING_OMP_BIN at the supported omp executable, then rerun doctor.',
        },
      };
    }
    if (ompVerdict !== 'verified') {
      const verdict = ompVerdict === 'unverified' ? 'unverified' : 'below-minimum';
      return unsupportedOmpVersionDiagnosis(
        verdict === 'unverified' ? 'bun-runtime-launcher-above-verified' : 'bun-runtime-launcher-below-minimum',
        'The resolved omp launcher',
        reportedVersion,
        verdict,
        await doctorBunVersion(context, batchBunCandidates(executable)),
      );
    }
    contract = identity.contract;
    bunCandidates = batchBunCandidates(executable);
  } else {
    // PATH installations normally expose omp through a symlink (for example
    // ~/.bun/bin/omp -> the package's dist/cli.js).  The diagnosis context
    // intentionally refuses to read symlinks, so inspect the already-resolved
    // target just as the runtime readiness path does.  Keep launching through
    // `executable` below: canonicalization is only for the bounded read.
    const launcherPath = canonical(executable);
    const launcher = context.readTextPrefix
      ? context.readTextPrefix(launcherPath, LAUNCHER_PREFIX_MAX_BYTES)
      : context.readText(launcherPath, LAUNCHER_PREFIX_MAX_BYTES);
    if (!launcher.ok) {
      return {
        id: 'omp.bun-runtime',
        status: 'fail',
        detailCode: 'bun-runtime-launcher-unreadable',
        summary: 'omp is installed, but its launcher cannot be inspected safely.',
        remediation: { kind: 'manual', message: 'Repair the omp installation, then rerun doctor.' },
      };
    }
    const bunCommand = bunCommandFromShebang(launcher.text);
    if (bunCommand === null) {
      const probe = await boundedDoctorProbe(context, executable);
      if (probe.status === 'timeout') {
        return ompProbeTimedOutDiagnosis('launcher', context.displayPath(executable));
      }
      const version = probe.status === 'ok' ? ompIdentityVersion(`${probe.stdout}\n${probe.stderr}`) : undefined;
      const nativeVerdict = version ? ompVersionVerdict(version) : undefined;
      if (!version || nativeVerdict !== 'verified') {
        return {
          id: 'omp.bun-runtime',
          status: 'fail',
          detailCode: version
            ? nativeVerdict === 'unverified'
              ? 'native-runtime-version-above-verified'
              : 'native-runtime-version-below-minimum'
            : 'native-runtime-identity-unverified',
          summary: version
            ? nativeVerdict === 'unverified'
              ? `The configured omp executable is omp ${version}, but mutable sync is verified only for omp ${ompVerifiedVersionsText()}.`
              : `The configured omp executable is omp ${version}, but ${OMP_MINIMUM_SUPPORTED_VERSION} is required.`
            : 'The configured omp executable did not provide a recognizable omp version response.',
          ...(version ? { evidence: { installedVersion: version, minimumVersion: OMP_MINIMUM_SUPPORTED_VERSION } } : {}),
          remediation: {
            kind: 'manual',
            message: 'Point COSYNCING_OMP_BIN at the supported omp executable, then restart cosyncing.',
          },
        };
      }
      return {
        id: 'omp.bun-runtime',
        status: 'pass',
        detailCode: 'native-runtime-ready',
        summary: `omp ${version} uses a verified native executable and does not depend on Bun launcher compatibility.`,
        evidence: { installedVersion: version, minimumVersion: OMP_MINIMUM_SUPPORTED_VERSION },
      };
    }
    contract = packageRuntimeContract(executable, (path) => {
      const read = context.readText(path, PACKAGE_JSON_MAX_BYTES);
      return read.ok ? read.text : undefined;
    });
    if (!bunCommand) {
      return {
        id: 'omp.bun-runtime',
        status: 'fail',
        detailCode: 'bun-runtime-interpreter-unresolved',
        summary: 'omp launcher runtime could not be verified.',
        remediation: bunRuntimeRemediation(contract.minimumBunVersion),
      };
    }
    if (!contract.version) {
      // Same rule as readiness: a Bun launcher with no package metadata beside it is identified by
      // its own bounded `--version` answer, which must be exactly the verified omp.
      const launcherProbe = await boundedDoctorProbe(context, executable);
      if (launcherProbe.status === 'timeout') {
        return ompProbeTimedOutDiagnosis('launcher', context.displayPath(executable));
      }
      const launcherVersion = launcherProbe.status === 'ok'
        ? ompIdentityVersion(`${launcherProbe.stdout}\n${launcherProbe.stderr}`)
        : undefined;
      if (!launcherVersion) {
        return {
          id: 'omp.bun-runtime',
          status: 'fail',
          detailCode: 'bun-runtime-launcher-identity-unverified',
          summary: 'The omp Bun launcher has no omp package metadata beside it and did not answer a bounded version check as omp.',
          evidence: { executable: context.displayPath(executable) },
          remediation: {
            kind: 'manual',
            message: 'Point COSYNCING_OMP_BIN at the supported omp executable, then rerun doctor.',
          },
        };
      }
      const launcherVerdict = ompVersionVerdict(launcherVersion);
      if (launcherVerdict !== 'verified') {
        const verdict = launcherVerdict === 'unverified' ? 'unverified' : 'below-minimum';
        return unsupportedOmpVersionDiagnosis(
          verdict === 'unverified' ? 'bun-runtime-launcher-above-verified' : 'bun-runtime-launcher-below-minimum',
          'The omp Bun launcher',
          launcherVersion,
          verdict,
          await doctorBunVersion(context, [bunCommand]),
        );
      }
      contract = { ...contract, version: launcherVersion };
    }
    const packageVersion = semanticVersionFromText(contract.version ?? '');
    const packageVerdict = packageVersion ? ompVersionVerdict(packageVersion) : undefined;
    if (packageVersion && packageVerdict !== undefined && packageVerdict !== 'verified') {
      return unsupportedOmpVersionDiagnosis(
        packageVerdict === 'unverified' ? 'bun-runtime-package-above-verified' : 'bun-runtime-package-version-unverified',
        'The installed omp package',
        packageVersion,
        packageVerdict,
        await doctorBunVersion(context, [bunCommand]),
      );
    }
    if (!packageVersion || packageVerdict === undefined) {
      return {
        id: 'omp.bun-runtime',
        status: 'fail',
        detailCode: 'bun-runtime-package-version-unverified',
        summary: 'The installed omp package version could not be verified.',
        remediation: {
          kind: 'manual',
          message: `${ompVerifiedInstallHint()}, then rerun doctor.`,
        },
      };
    }
    bunCandidates = [bunCommand];
  }
  const remediation = bunRuntimeRemediation(contract.minimumBunVersion);
  let bunExecutable: string | undefined;
  for (const candidate of bunCandidates) {
    bunExecutable = context.resolveExecutable(candidate);
    if (bunExecutable) break;
  }
  if (!bunExecutable) {
    return {
      id: 'omp.bun-runtime',
      status: 'fail',
      detailCode: 'bun-runtime-interpreter-missing',
      summary: `omp requires Bun ${contract.minimumBunVersion} or newer, but its effective interpreter is unavailable.`,
      evidence: { minimumVersion: contract.minimumBunVersion },
      remediation,
    };
  }
  const probe = await boundedDoctorProbe(context, bunExecutable);
  if (probe.status === 'timeout') {
    return ompProbeTimedOutDiagnosis('interpreter', context.displayPath(bunExecutable));
  }
  const bunVersion = semanticVersionFromText(`${probe.stdout}\n${probe.stderr}`);
  const comparison = bunVersion
    ? compareSemanticVersions(bunVersion, contract.minimumBunVersion)
    : undefined;
  if (!bunVersion || comparison === undefined || comparison < 0) {
    return {
      id: 'omp.bun-runtime',
      status: 'fail',
      detailCode: bunVersion ? 'bun-runtime-below-minimum' : 'bun-runtime-version-unavailable',
      summary: bunVersion
        ? `omp requires Bun ${contract.minimumBunVersion} or newer, but its effective interpreter is Bun ${bunVersion}.`
        : `omp requires Bun ${contract.minimumBunVersion} or newer, but its effective interpreter version could not be verified.`,
      evidence: {
        executable: context.displayPath(bunExecutable),
        minimumVersion: contract.minimumBunVersion,
        ...(bunVersion ? { installedVersion: bunVersion } : {}),
      },
      remediation,
    };
  }
  return {
    id: 'omp.bun-runtime',
    status: 'pass',
    detailCode: 'bun-runtime-supported',
    summary: `omp effective Bun ${bunVersion} satisfies the installed distribution floor.`,
    evidence: {
      executable: context.displayPath(bunExecutable),
      installedVersion: bunVersion,
      minimumVersion: contract.minimumBunVersion,
    },
  };
}
