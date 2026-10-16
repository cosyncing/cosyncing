import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { PRODUCT_IDENTITY } from '@cosyncing/protocol';
import {
  BUN_RELEASE_DOWNLOAD_BASE,
  PINNED_BUN_RUNTIME_ARCHIVES,
  PINNED_BUN_RUNTIME_VERSION,
  bunVersionAtLeast,
  probeBunRuntimeBySpawn,
  type BunRuntimeArchive,
  type BunRuntimeProbe,
} from '../runtime/application-identity.ts';
import {
  atomicWriteOwnerOnly,
  assertNoSymlinkComponents,
  ensureOwnerOnlyDirectory,
  inspectOwnerOnlyDirectory,
  inspectOwnerOnlyFile,
} from '../security/secure-files.ts';
import { isOwnedBunRuntimeEntryName, OWNED_BUN_RUNTIME_DIRECTORY } from '../installation/bun-runtime-receipt.ts';

/**
 * The Bun runtime an installer-owned cosyncing runs under, and how `cosy update` moves it forward.
 *
 * ONE layout, written by both installers and by `cosy update`:
 *
 *   <COSYNCING_HOME>/runtime/bun-<version>/bun        (bun.exe on Windows)
 *
 * Versioned, so a newer runtime is installed NEXT TO the one the service is executing rather than over it --
 * on Windows an in-use `bun.exe` cannot be replaced at all, and on every host replacing it mid-transaction
 * would leave nothing to roll back to. The previous runtime stays until an update that no longer needs it
 * for rollback has committed.
 *
 * The older, unversioned layout -- the installer placing Bun at `$BUN_INSTALL/bin/bun` (default `~/.bun`) --
 * is still READ: an install whose service runs that Bun upgrades by installing the versioned runtime beside
 * it and switching to it. That file is never written, moved or removed here: it sits in Bun's own prefix and
 * may be the operator's own Bun.
 */
export { OWNED_BUN_RUNTIME_DIRECTORY };

/** Ceiling on one pinned archive, matching the release artifact ceiling. */
export const MAX_BUN_RUNTIME_ARCHIVE_BYTES = 256 * 1024 * 1024;
/** Ceiling on the extracted executable. Bun is ~100 MB; anything far beyond that is not Bun. */
export const MAX_BUN_RUNTIME_EXECUTABLE_BYTES = 512 * 1024 * 1024;

export const RUNTIME_UPGRADE_REQUIRED_DETAIL = 'release-runtime-upgrade-required';

/** The Bun runtime a release needs, carried signed inside its manifest (`jsApp.bunRuntime`). */
export interface ReleaseBunRuntime {
  /** The exact Bun version every archive below is a build of. */
  version: string;
  /** Official Bun archives for that version, keyed by installer host, most likely first. */
  archives: Record<string, BunRuntimeArchive[]>;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validArchive(value: unknown): value is BunRuntimeArchive {
  return plainObject(value)
    && Object.keys(value).length === 3
    && typeof value.asset === 'string' && /^bun-[a-z0-9][a-z0-9-]*\.zip$/.test(value.asset)
    && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)
    && Number.isSafeInteger(value.size) && (value.size as number) > 0
    && (value.size as number) <= MAX_BUN_RUNTIME_ARCHIVE_BYTES;
}

export function validReleaseBunRuntime(value: unknown): value is ReleaseBunRuntime {
  if (!plainObject(value) || Object.keys(value).length !== 2
      || typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.version)
      || !plainObject(value.archives)) return false;
  const hosts = Object.entries(value.archives);
  if (hosts.length === 0 || hosts.length > 8) return false;
  const assets = new Set<string>();
  for (const [host, rows] of hosts) {
    if (!/^[a-z0-9]+-[a-z0-9]+$/.test(host) || !Array.isArray(rows) || rows.length === 0 || rows.length > 8
        || !rows.every(validArchive)) return false;
    for (const row of rows as BunRuntimeArchive[]) {
      if (assets.has(row.asset)) return false;
      assets.add(row.asset);
    }
  }
  return true;
}

/** This build's own compiled pins, in the manifest shape. What release assembly signs into every manifest. */
export function pinnedReleaseBunRuntime(): ReleaseBunRuntime {
  return {
    version: PINNED_BUN_RUNTIME_VERSION,
    archives: Object.fromEntries(Object.entries(PINNED_BUN_RUNTIME_ARCHIVES)
      .map(([host, rows]) => [host, rows.map((row) => ({ asset: row.asset, sha256: row.sha256, size: row.size }))])),
  };
}

/** The installer host key a pinned table is indexed by, or undefined for a host no installer supports. */
export function bunRuntimeHost(
  platform: string = process.platform,
  arch: string = process.arch,
): string | undefined {
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'win32' && arch === 'x64') return 'windows-x64';
  return undefined;
}

function pathApi(platform: string): typeof posix {
  return platform === 'win32' ? win32 : posix;
}

export function bunExecutableName(platform: string = process.platform): string {
  return platform === 'win32' ? 'bun.exe' : 'bun';
}

/** `<home>/runtime/bun-<version>/bun`: the only place cosyncing ever installs a runtime. */
export function ownedBunRuntimePath(home: string, version: string, platform: string = process.platform): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('bun runtime version is invalid');
  const api = pathApi(platform);
  return api.join(home, OWNED_BUN_RUNTIME_DIRECTORY, `bun-${version}`, bunExecutableName(platform));
}

/** The version of an owned runtime path, or undefined when the path is anything else. */
export function ownedBunRuntimeVersion(
  home: string,
  path: string,
  platform: string = process.platform,
): string | undefined {
  const api = pathApi(platform);
  const resolved = api.resolve(path);
  const directory = api.dirname(resolved);
  const match = /^bun-(\d+\.\d+\.\d+)$/.exec(api.basename(directory));
  if (!match || api.basename(resolved) !== bunExecutableName(platform)) return undefined;
  const expected = api.resolve(api.join(home, OWNED_BUN_RUNTIME_DIRECTORY, `bun-${match[1]}`, bunExecutableName(platform)));
  const same = platform === 'win32' ? expected.toLowerCase() === resolved.toLowerCase() : expected === resolved;
  return same ? match[1] : undefined;
}

// ---------------------------------------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------------------------------------

export type BunRuntimeUpgradePlan =
  | { kind: 'satisfied' }
  | { kind: 'install'; version: string; host: string; archives: readonly BunRuntimeArchive[] }
  | { kind: 'refused'; detailCode: string; summary: string };

/**
 * Does this release need a newer Bun, and can this install put one in place itself?
 *
 * Decided BEFORE anything is downloaded. Three answers:
 *
 * - `satisfied`: the release declares no floor, or the runtime running this command already meets it.
 * - `install`: the release's own signed pins (falling back to this build's compiled pins when those satisfy
 *   the floor) name an archive for this host. The installer-owned distribution may place a runtime in its
 *   own state home, so `cosy update` downloads it, verifies it and switches to it in the same transaction
 *   as the broker files.
 * - `refused`: the runtime is one cosyncing does not manage -- the operator pinned it with
 *   `COSYNCING_BUN_BIN` -- or no pinned build exists for this host. The answer names the Bun version needed
 *   and what to do, rather than the generic "failed verification" a floor refusal used to read as.
 *
 * Only `bootstrap-js` reaches this: npm installs are refused earlier with the package manager's own
 * instructions, and a compiled build carries its interpreter and declares no floor.
 */
export function planBunRuntimeUpgrade(options: {
  minimumBunVersion?: string;
  runtimeVersion?: string;
  runtimePath?: string;
  runtimeOverridden?: boolean;
  releaseRuntime?: ReleaseBunRuntime;
  host?: string;
  toVersion: string;
}): BunRuntimeUpgradePlan {
  const floor = options.minimumBunVersion;
  if (!floor) return { kind: 'satisfied' };
  if (options.runtimeVersion && bunVersionAtLeast(options.runtimeVersion, floor)) return { kind: 'satisfied' };
  const running = options.runtimeVersion
    ? `Bun ${options.runtimeVersion}${options.runtimePath ? ` (${options.runtimePath})` : ''}`
    : 'a Bun whose version could not be read';
  if (options.runtimeOverridden) {
    return {
      kind: 'refused',
      detailCode: RUNTIME_UPGRADE_REQUIRED_DETAIL,
      summary: `${PRODUCT_IDENTITY.productName} ${options.toVersion} needs Bun ${floor} or newer, but this install `
        + `runs ${running}, chosen with COSYNCING_BUN_BIN, which \`cosy update\` does not replace. Upgrade that `
        + `Bun to ${floor} or newer (or unset COSYNCING_BUN_BIN so \`cosy update\` can install the pinned Bun), `
        + 'then run `cosy update` again. Nothing was changed.',
    };
  }
  const source = options.releaseRuntime && bunVersionAtLeast(options.releaseRuntime.version, floor)
    ? options.releaseRuntime
    : bunVersionAtLeast(PINNED_BUN_RUNTIME_VERSION, floor) ? pinnedReleaseBunRuntime() : undefined;
  const archives = options.host && source ? source.archives[options.host] : undefined;
  if (!source || !options.host || !archives || archives.length === 0) {
    return {
      kind: 'refused',
      detailCode: RUNTIME_UPGRADE_REQUIRED_DETAIL,
      summary: `${PRODUCT_IDENTITY.productName} ${options.toVersion} needs Bun ${floor} or newer, but this install `
        + `runs ${running} and the release carries no pinned Bun build for this host. Install Bun ${floor} `
        + 'or newer from https://bun.sh, then re-run the cosyncing installer (or `cosy setup`) so the service '
        + 'uses it. Nothing was changed.',
    };
  }
  return { kind: 'install', version: source.version, host: options.host, archives };
}

// ---------------------------------------------------------------------------------------------------------
// Archive extraction
// ---------------------------------------------------------------------------------------------------------

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * One file out of a zip archive, by exact entry name.
 *
 * Bun publishes zips, and no unzip is guaranteed on a Linux host (the installers probe for one only when they
 * must place Bun). The archive has already matched its pinned digest when this runs, so this is a reader of
 * trusted bytes, not a defence against hostile ones -- but it still refuses anything it does not fully
 * understand (encryption, an unknown method, a size or CRC that disagrees with the directory) rather than
 * returning bytes it cannot vouch for. Sizes come from the central directory, so archives written with data
 * descriptors and ZIP64 records both read correctly.
 */
export function extractZipEntry(archive: Uint8Array, entryName: string, maxBytes = MAX_BUN_RUNTIME_EXECUTABLE_BYTES): Uint8Array {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const fail = (): never => { throw new Error('release-runtime-archive-invalid'); };
  const u16 = (offset: number): number => (offset + 2 <= archive.byteLength ? view.getUint16(offset, true) : fail());
  const u32 = (offset: number): number => (offset + 4 <= archive.byteLength ? view.getUint32(offset, true) : fail());
  const u64 = (offset: number): number => {
    const low = u32(offset);
    const high = u32(offset + 4);
    const value = high * 0x1_0000_0000 + low;
    return Number.isSafeInteger(value) ? value : fail();
  };
  let eocd = -1;
  for (let offset = archive.byteLength - 22; offset >= Math.max(0, archive.byteLength - 22 - 0xffff); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) fail();
  let entries = u16(eocd + 10);
  let directorySize = u32(eocd + 12);
  let directoryOffset = u32(eocd + 16);
  if (entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || u32(locator) !== 0x07064b50) fail();
    const record = u64(locator + 8);
    if (u32(record) !== 0x06064b50) fail();
    entries = u64(record + 32);
    directorySize = u64(record + 40);
    directoryOffset = u64(record + 48);
  }
  if (directoryOffset + directorySize > archive.byteLength) fail();
  let cursor = directoryOffset;
  let found: { method: number; flags: number; crc: number; compressed: number; size: number; local: number } | undefined;
  for (let index = 0; index < entries; index += 1) {
    if (u32(cursor) !== 0x02014b50) fail();
    const flags = u16(cursor + 8);
    const method = u16(cursor + 10);
    const crc = u32(cursor + 16);
    let compressed = u32(cursor + 20);
    let size = u32(cursor + 24);
    const nameLength = u16(cursor + 28);
    const extraLength = u16(cursor + 30);
    const commentLength = u16(cursor + 32);
    let local = u32(cursor + 42);
    const nameStart = cursor + 46;
    if (nameStart + nameLength + extraLength > archive.byteLength) fail();
    const name = Buffer.from(archive.subarray(nameStart, nameStart + nameLength)).toString('utf8');
    if (name === entryName) {
      if (found) fail();
      // ZIP64 extended information: only the fields whose 32-bit slot is saturated are present, in order.
      if (size === 0xffffffff || compressed === 0xffffffff || local === 0xffffffff) {
        let extra = nameStart + nameLength;
        const extraEnd = extra + extraLength;
        let resolved = false;
        while (extra + 4 <= extraEnd) {
          const header = u16(extra);
          const length = u16(extra + 2);
          if (header === 0x0001) {
            let field = extra + 4;
            if (size === 0xffffffff) { size = u64(field); field += 8; }
            if (compressed === 0xffffffff) { compressed = u64(field); field += 8; }
            if (local === 0xffffffff) { local = u64(field); field += 8; }
            if (field > extra + 4 + length) fail();
            resolved = true;
            break;
          }
          extra += 4 + length;
        }
        if (!resolved) fail();
      }
      found = { method, flags, crc, compressed, size, local };
    }
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  if (!found) throw new Error('release-runtime-archive-missing-executable');
  if ((found.flags & 0x1) !== 0 || (found.method !== 0 && found.method !== 8)) fail();
  if (found.size > maxBytes) throw new Error('release-runtime-archive-invalid');
  if (u32(found.local) !== 0x04034b50) fail();
  const dataStart = found.local + 30 + u16(found.local + 26) + u16(found.local + 28);
  if (dataStart + found.compressed > archive.byteLength) fail();
  const data = archive.subarray(dataStart, dataStart + found.compressed);
  let bytes: Uint8Array;
  if (found.method === 0) {
    if (found.compressed !== found.size) fail();
    bytes = Uint8Array.from(data);
  } else {
    try {
      bytes = new Uint8Array(inflateRawSync(data));
    } catch {
      return fail();
    }
  }
  if (bytes.byteLength !== found.size || crc32(bytes) !== found.crc) fail();
  return bytes;
}

// ---------------------------------------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------------------------------------

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Remove a path only when it is provably a plain directory owned by this user at exactly that path. */
function removeOwnedDirectory(path: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(path); } catch { return; }
  assertNoSymlinkComponents(path, false);
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (stat.isSymbolicLink() || !stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) {
    throw new Error('release-runtime-target-unsafe');
  }
  rmSync(path, { recursive: true, force: true });
}

/**
 * The pinned builds for this host, most likely first.
 *
 * One host target is not one binary: glibc and musl need different builds, and a pre-AVX2 x64 needs the
 * baseline one. The same reordering the installers do; detection never decides on its own -- the extracted
 * binary has to answer `--revision` with the pinned version before it is installed, so a wrong guess costs
 * one download and moves to the next pinned build.
 */
export function orderedBunRuntimeArchives(
  archives: readonly BunRuntimeArchive[],
  facts: { musl?: boolean; avx2?: boolean } = hostRuntimeFacts(),
): BunRuntimeArchive[] {
  let rows = [...archives];
  if (facts.musl) rows = [...rows.filter((row) => row.asset.includes('-musl')), ...rows.filter((row) => !row.asset.includes('-musl'))];
  if (facts.avx2 === false) {
    rows = [...rows.filter((row) => row.asset.includes('-baseline')), ...rows.filter((row) => !row.asset.includes('-baseline'))];
  }
  return rows;
}

function hostRuntimeFacts(): { musl: boolean; avx2?: boolean } {
  const musl = process.platform === 'linux'
    && (existsSync('/lib/ld-musl-x86_64.so.1') || existsSync('/lib/ld-musl-aarch64.so.1'));
  let avx2: boolean | undefined;
  if (process.platform === 'linux' && process.arch === 'x64') {
    try { avx2 = /\bavx2\b/.test(readFileSync('/proc/cpuinfo', 'utf8')); } catch { avx2 = undefined; }
  }
  return { musl, ...(avx2 === undefined ? {} : { avx2 }) };
}

function versionCore(reported: string): string | undefined {
  return /^(\d+\.\d+\.\d+)(?:[-+][0-9A-Za-z.+-]*)?$/.exec(reported.trim())?.[1];
}

export interface InstalledBunRuntime {
  /** Absolute path of the runtime executable. */
  path: string;
  version: string;
  /** True when THIS run created the directory, so an abandoned transaction may remove it. */
  installed: boolean;
}

/**
 * Place the pinned Bun for this host at `<home>/runtime/bun-<version>/`, verified before it is unpacked.
 *
 * Every archive is held to the rule the installers apply: the downloaded bytes must match the pinned size
 * and digest BEFORE anything is extracted, and a mismatch is fatal rather than "try the next one" -- these
 * are the bytes Bun published for that tag, so different bytes mean substitution, not a wrong build. Only
 * a verified build that does not RUN here advances to the next pinned candidate.
 *
 * The runtime is unpacked into a staging directory beside its destination and renamed into place, so the
 * versioned directory either holds a complete, probed runtime or does not exist. An existing directory that
 * already answers with the pinned version is reused: an earlier installer or update put it there through
 * this same path.
 */
export async function installBunRuntime(options: {
  home: string;
  version: string;
  archives: readonly BunRuntimeArchive[];
  download: (url: string, maximum: number) => Promise<Uint8Array>;
  probe?: BunRuntimeProbe;
  platform?: string;
  facts?: { musl?: boolean; avx2?: boolean };
  /** The runtime executing now. Never removed, even when it sits at the destination and fails its probe. */
  currentRuntimePath?: string;
}): Promise<InstalledBunRuntime> {
  const platform = options.platform ?? process.platform;
  const probe = options.probe ?? probeBunRuntimeBySpawn;
  const path = ownedBunRuntimePath(options.home, options.version, platform);
  const directory = dirname(path);
  const runtimeRoot = dirname(directory);
  const answers = (candidate: string): boolean => {
    try { return versionCore(probe(candidate)) === options.version; } catch { return false; }
  };
  ensureOwnerOnlyDirectory(runtimeRoot);
  if (existsSync(directory)) {
    if (inspectOwnerOnlyDirectory(directory).status === 'ok' && inspectOwnerOnlyFile(path).status === 'ok'
        && answers(path)) {
      return { path, version: options.version, installed: false };
    }
    if (options.currentRuntimePath && resolve(options.currentRuntimePath) === resolve(path)) {
      throw new Error('release-runtime-target-in-use');
    }
    // A directory at the destination that does not hold a working pinned runtime is debris from an
    // interrupted run, not something anything is executing: replace it.
    removeOwnedDirectory(directory);
  }
  const executableName = bunExecutableName(platform);
  for (const archive of orderedBunRuntimeArchives(options.archives, options.facts)) {
    const url = `${BUN_RELEASE_DOWNLOAD_BASE}/bun-v${options.version}/${archive.asset}`;
    const bytes = await options.download(url, archive.size);
    if (bytes.byteLength !== archive.size) throw new Error('release-runtime-size-mismatch');
    if (sha256(bytes) !== archive.sha256) throw new Error('release-runtime-checksum-mismatch');
    const executable = extractZipEntry(bytes, `${archive.asset.replace(/\.zip$/, '')}/${executableName}`);
    const staging = join(runtimeRoot, `.bun-${options.version}.staging-${process.pid}-${randomBytes(6).toString('hex')}`);
    ensureOwnerOnlyDirectory(staging);
    try {
      const stagedExecutable = join(staging, executableName);
      atomicWriteOwnerOnly(stagedExecutable, executable, { mode: 0o700 });
      if (!answers(stagedExecutable)) {
        removeOwnedDirectory(staging);
        continue;
      }
      renameSync(staging, directory);
    } catch (error) {
      try { removeOwnedDirectory(staging); } catch { /* report the original failure */ }
      throw error;
    }
    if (inspectOwnerOnlyDirectory(directory).status !== 'ok' || inspectOwnerOnlyFile(path).status !== 'ok') {
      throw new Error('release-runtime-target-unsafe');
    }
    return { path, version: options.version, installed: true };
  }
  throw new Error('release-runtime-unrunnable');
}

/** Drop a runtime this transaction installed and then abandoned. Never the one anything else names. */
export function removeAbandonedBunRuntime(home: string, runtimePath: string, platform: string = process.platform): void {
  if (!ownedBunRuntimeVersion(home, runtimePath, platform)) return;
  removeOwnedDirectory(dirname(runtimePath));
}

/**
 * After a committed update: keep the runtime now in use and the one it replaced, drop every other owned
 * runtime and any staging debris. Only `<home>/runtime/bun-<x.y.z>` directories are ever considered; a Bun
 * anywhere else -- including the old unversioned `~/.bun/bin/bun` -- is not cosyncing's to remove.
 */
export function pruneOwnedBunRuntimes(home: string, keep: readonly string[], platform: string = process.platform): void {
  const root = join(home, OWNED_BUN_RUNTIME_DIRECTORY);
  const kept = new Set(keep.flatMap((path) => {
    const version = ownedBunRuntimeVersion(home, path, platform);
    return version ? [`bun-${version}`] : [];
  }));
  let entries: string[];
  try { entries = readdirSync(root); } catch { return; }
  for (const entry of entries) {
    if (kept.has(entry)) continue;
    if (!isOwnedBunRuntimeEntryName(entry)) continue;
    try { removeOwnedDirectory(join(root, entry)); } catch { /* an unused runtime is inert; leave it */ }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Launchers
// ---------------------------------------------------------------------------------------------------------

/** One installer-written command launcher, before and after its runtime moves. */
export interface LauncherRuntimeChange {
  path: string;
  before: string;
  after: string;
}

const POSIX_LAUNCHER_MARKER = '# cosyncing command launcher v1';

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellUnquote(token: string): string | undefined {
  if (!/^'(?:[^']|'\\'')*'$/.test(token)) return undefined;
  const value = token.slice(1, -1).replaceAll("'\\''", "'");
  return shellQuote(value) === token ? value : undefined;
}

/** The launcher paths an installer may have written for this state home. */
export function installerLauncherPaths(home: string, platform: string = process.platform): string[] {
  return platform === 'win32'
    ? [win32.join(home, 'bin', 'cosy.cmd')]
    : [join(home, 'shell-bin', 'cosyncing'), join(home, 'shell-bin', 'cosy')];
}

/**
 * The Windows `cosy.cmd` shim.
 *
 * cmd.exe re-opens a running batch file and continues at the byte offset after the line it last executed,
 * so a shim rewritten while it is the one running `cosy update` would otherwise have the TAIL of its new
 * text executed as a command when Bun exits. Two properties make every rewrite safe:
 *
 * - the command line ends in `& exit /b`, so a shim of this shape never reads past the line that ran;
 * - the first line is `@goto :run`, padded so it is exactly as long as the first line of the shim being
 *   replaced: an older one-line shim still resumes at that offset, and finds `@exit /b` there.
 *
 * `exit /b` without a number keeps the exit code Bun returned.
 */
export function windowsLauncherText(runtime: string, padTo = 0): string {
  if (/["\r\n%]/.test(runtime)) throw new Error('launcher runtime path cannot be quoted for cmd.exe');
  const head = '@goto :run';
  const first = `${head}${' '.repeat(Math.max(0, padTo - head.length - 2))}\r\n`;
  return `${first}@exit /b\r\n:run\r\n@"${runtime}" "%~dp0${PRODUCT_IDENTITY.primaryBinary}" %* & exit /b\r\n`;
}

function windowsLauncherRuntime(text: string): string | undefined {
  const legacy = /^@"([^"\r\n]+)" "%~dp0cosyncing" %\*\r?\n$/.exec(text);
  if (legacy) return legacy[1];
  const current = /^@goto :run *\r\n@exit \/b\r\n:run\r\n@"([^"\r\n]+)" "%~dp0cosyncing" %\* & exit \/b\r\n$/.exec(text);
  return current?.[1];
}

/**
 * Point the installer's command launchers at a new runtime, as journaled before/after pairs.
 *
 * A launcher is rewritten only when it is provably the installer's own: owner-only, the installer's marker,
 * and exactly the one `exec <runtime> <application>` line it writes. Anything else -- an operator's own
 * wrapper, a launcher naming another application -- is left alone, and the commands it starts keep the
 * runtime they had, which still exists.
 */
export function planLauncherRuntimeChanges(options: {
  home: string;
  applicationPath: string;
  toRuntime: string;
  platform?: string;
}): LauncherRuntimeChange[] {
  const platform = options.platform ?? process.platform;
  const changes: LauncherRuntimeChange[] = [];
  for (const path of installerLauncherPaths(options.home, platform)) {
    if (inspectOwnerOnlyFile(path).status !== 'ok') continue;
    let before: string;
    try { before = readFileSync(path, 'utf8'); } catch { continue; }
    if (platform === 'win32') {
      if (!windowsLauncherRuntime(before)) continue;
      // A byte offset, because that is what cmd.exe resumes at: a profile path with a non-ASCII name is
      // longer in bytes than in characters.
      const firstLine = Buffer.byteLength(before.slice(0, before.indexOf('\n') + 1), 'utf8');
      let after: string;
      try { after = windowsLauncherText(options.toRuntime, firstLine); } catch { continue; }
      if (after !== before) changes.push({ path, before, after });
      continue;
    }
    const lines = before.split('\n');
    if (lines[0] !== '#!/bin/sh' || lines[1] !== POSIX_LAUNCHER_MARKER) continue;
    const suffix = ` ${shellQuote(options.applicationPath)} "$@"`;
    const index = lines.findIndex((line) => line.startsWith('exec ') && line.endsWith(suffix));
    if (index < 0 || lines.filter((line) => line.startsWith('exec ')).length !== 1) continue;
    const token = lines[index]!.slice('exec '.length, lines[index]!.length - suffix.length);
    if (shellUnquote(token) === undefined) continue;
    const next = [...lines];
    next[index] = `exec ${shellQuote(options.toRuntime)}${suffix}`;
    const after = next.join('\n');
    if (after !== before) changes.push({ path, before, after });
  }
  return changes;
}

/** Write (or with `restore`, put back) launcher changes. A launcher that is neither text is left alone. */
export function writeLauncherChanges(changes: readonly LauncherRuntimeChange[], restore = false): void {
  for (const change of changes) {
    if (inspectOwnerOnlyFile(change.path).status !== 'ok') throw new Error('upgrade-launcher-unsafe');
    const current = readFileSync(change.path, 'utf8');
    const text = restore ? change.before : change.after;
    if (current === text) continue;
    if (current !== change.before && current !== change.after) throw new Error('upgrade-launcher-drifted');
    atomicWriteOwnerOnly(change.path, text, { mode: 0o700 });
  }
}

export function validLauncherChanges(value: unknown, home: string, platform: string = process.platform): value is LauncherRuntimeChange[] {
  const allowed = installerLauncherPaths(home, platform).map((path) => resolve(path));
  return Array.isArray(value) && value.length <= allowed.length
    && new Set(value.map((change) => (plainObject(change) ? String(change.path) : ''))).size === value.length
    && value.every((change) => plainObject(change)
      && typeof change.path === 'string' && allowed.includes(resolve(change.path))
      && typeof change.before === 'string' && change.before.length <= 16 * 1024
      && typeof change.after === 'string' && change.after.length <= 16 * 1024
      && Object.keys(change).length === 3);
}
