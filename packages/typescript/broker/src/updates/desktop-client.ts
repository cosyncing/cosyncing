import { captureWindowsProcessSnapshot, windowsPathOwnedByCurrentUser, type WindowsProcessSnapshot } from '@cosyncing/adapter-api';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync,
  readlinkSync, realpathSync, renameSync, rmSync, type Stats,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep, win32 } from 'node:path';
import {
  assertNoSymlinkComponents, atomicWriteOwnerOnly, enforceOwnerOnlyFile,
  ensureOwnerOnlyDirectory, inspectOwnerOnlyDirectory, inspectOwnerOnlyFile,
} from '../security/secure-files.ts';
import { extractDesktopArchive } from './desktop-client-archive.ts';
import type {
  DesktopClientHost, DesktopClientOutcome, ReleaseDesktopClient,
} from './desktop-client-types.ts';

export interface DesktopClientContext {
  home: string;
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Process and rename seams for deterministic refusal/restoration tests. */
  isRunning?: (path: string) => boolean;
  rename?: (from: string, to: string) => void;
  writeReceipt?: (path: string, bytes: Uint8Array | string) => void;
  remove?: (path: string) => void;
}

export interface DesktopClientReceipt {
  host: DesktopClientHost;
  path: string;
  version: string;
  sha256: string;
  executableSha256: string;
}

export interface PreparedDesktopClient {
  receipt: Omit<DesktopClientReceipt, 'sha256'> & { sha256?: string };
  receiptPath: string;
  receiptBytes?: Buffer;
  legacy: boolean;
}

/** Only positive running-process evidence may stop a broker update. */
export class DesktopClientRunningError extends Error {
  readonly detailCode = 'desktop-client-running';
  constructor(path: string) {
    super(`The desktop client is running from ${path}; quit it (from its icon in the notification area if its window is closed) and run cosy update again.`);
  }
}

function desktopClientErrorCode(error: unknown): string {
  if (error instanceof DesktopClientRunningError) return error.detailCode;
  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 'desktop-client-missing';
  const message = error instanceof Error ? error.message : '';
  return /^desktop-client-[a-z0-9-]+$/.test(message) ? message : 'desktop-client-inspection-failed';
}

/** Inspection failures leave the desktop untouched, while the broker can still be upgraded. */
export function skippedDesktopClient(error: unknown): DesktopClientOutcome {
  const detailCode = desktopClientErrorCode(error);
  const reasons: Record<string, string> = {
    'desktop-client-missing': 'its installation is missing',
    'desktop-client-receipt-invalid': 'its ownership record is invalid',
    'desktop-client-receipt-unsafe': 'its ownership record is unsafe',
    'desktop-client-receipt-changed': 'its ownership record changed during the update',
    'desktop-client-receipt-content-mismatch': 'its executable differs from its ownership record',
    'desktop-client-path-unsafe': 'its installation ownership or permissions could not be verified',
    'desktop-client-process-unknown': 'its running state could not be determined',
    'desktop-client-legacy-version-unreadable': 'the older installation has no readable Flutter version metadata',
    'desktop-client-legacy-identity-invalid': 'the older installation does not identify the cosyncing app',
  };
  const remedy = detailCode === 'desktop-client-process-unknown'
    ? 'Close the client and run cosy update again.'
    : 'Rerun the signed all-in-one installer to restore the desktop installation and its ownership record.';
  const removalRemedy = detailCode === 'desktop-client-missing'
    ? ' If you removed it on purpose, delete client-receipt.' : '';
  return { status: 'skipped', detailCode,
    clause: ` Desktop client skipped because ${reasons[detailCode] ?? 'its installation could not be safely inspected'}; no client was changed. ${remedy}${removalRemedy}` };
}

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const validDigest = (value: string): boolean => /^[a-f0-9]{64}$/.test(value);
const validVersion = (value: string): boolean => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);

export function desktopClientHost(context: DesktopClientContext): DesktopClientHost | undefined {
  const platform = context.platform ?? process.platform;
  const arch = context.arch ?? process.arch;
  if (platform === 'win32' && arch === 'x64') return 'windows-x64';
  if (platform === 'darwin' && arch === 'arm64') return 'macos-arm64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  return undefined;
}

export function expectedDesktopClientPath(context: DesktopClientContext): string | undefined {
  const env = context.env ?? process.env;
  switch (desktopClientHost(context)) {
    case 'linux-x64': return resolve(context.home, 'client');
    case 'macos-arm64': return env.HOME && isAbsolute(env.HOME)
      ? resolve(env.HOME, 'Applications', 'Cosyncing.app') : undefined;
    case 'windows-x64': {
      const local = env.LOCALAPPDATA ?? (env.USERPROFILE ? join(env.USERPROFILE, 'AppData', 'Local') : undefined);
      return local && isAbsolute(local) ? resolve(local, 'cosyncing', 'client') : undefined;
    }
    default: return undefined;
  }
}

export function desktopClientExecutable(receipt: Pick<DesktopClientReceipt, 'host' | 'path'>): string {
  return receipt.host === 'macos-arm64' ? join(receipt.path, 'Contents', 'MacOS', 'Cosyncing')
    : join(receipt.path, receipt.host === 'windows-x64' ? 'cosyncing.exe' : 'cosyncing');
}

function within(path: string, root: string): boolean {
  const fold = (value: string): string => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  const candidate = fold(path); const parent = fold(root);
  return candidate === parent || candidate.startsWith(`${parent}${sep}`);
}

function inspectClientNode(path: string, stat: Stats, staging: boolean, legacy = false): void {
  if (process.platform === 'win32') {
    if (legacy) {
      if (windowsPathOwnedByCurrentUser(path) !== 'yes') throw new Error('desktop-client-path-unsafe');
      return;
    }
    const result = stat.isDirectory() ? inspectOwnerOnlyDirectory(path) : inspectOwnerOnlyFile(path);
    // Extracted nodes inherit only from the freshly protected staging root. Before commit they get
    // protected descriptors of their own; a recorded installed tree must already have those.
    if (result.status !== 'ok' && !(staging && result.daclProblem === 'inherited-access')) {
      throw new Error('desktop-client-path-unsafe');
    }
  } else if (stat.uid !== process.getuid?.() || (!staging && !legacy && (stat.mode & 0o022) !== 0)) {
    throw new Error('desktop-client-path-unsafe');
  }
}

/** Validate the complete tree before changing any modes; allow only internal macOS bundle links. */
export function validateDesktopClientTree(root: string, host: DesktopClientHost, staging = false, legacy = false): void {
  assertNoSymlinkComponents(root);
  const nodes: Array<{ path: string; stat: Stats }> = [];
  const files = new Map<string, { count: number; links: number }>();
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      if (host !== 'macos-arm64' || isAbsolute(target) || !within(resolve(dirname(path), target), root)) {
        throw new Error('desktop-client-link-unsafe');
      }
      try {
        if (!within(realpathSync(path), root)) throw new Error('desktop-client-link-unsafe');
      } catch (error) {
        // Framework header aliases can legitimately name an absent internal directory.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (stat.uid !== process.getuid?.()) throw new Error('desktop-client-path-unsafe');
      return;
    }
    if (!stat.isDirectory() && !stat.isFile()) throw new Error('desktop-client-path-unsafe');
    inspectClientNode(path, stat, staging, legacy);
    nodes.push({ path, stat });
    if (nodes.length > 100_000) throw new Error('desktop-client-archive-too-large');
    if (stat.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
    else if (process.platform !== 'win32') {
      const key = `${stat.dev}:${stat.ino}`;
      const entry = files.get(key) ?? { count: 0, links: stat.nlink };
      entry.count++; files.set(key, entry);
    }
  };
  visit(root);
  if (!lstatSync(root).isDirectory() || [...files.values()].some((file) => file.count !== file.links)) {
    throw new Error('desktop-client-path-unsafe');
  }
  const executable = desktopClientExecutable({ host, path: root });
  assertNoSymlinkComponents(executable);
  if (!lstatSync(executable).isFile()
      || (process.platform !== 'win32' && (lstatSync(executable).mode & 0o100) === 0)) {
    throw new Error('desktop-client-executable-invalid');
  }
  if (staging) for (const { path, stat } of nodes) {
    if (stat.isDirectory()) ensureOwnerOnlyDirectory(path);
    else enforceOwnerOnlyFile(path, stat.mode & 0o700);
  }
}

export function renderDesktopClientReceipt(receipt: DesktopClientReceipt): string {
  return ['schemaVersion=1', 'product=cosyncing', `host=${receipt.host}`, `path=${receipt.path}`,
    `version=${receipt.version}`, `sha256=${receipt.sha256}`,
    `executableSha256=${receipt.executableSha256}`, ''].join('\n');
}

/** These are the native archive locations, not an arbitrary search for a version file. */
export function legacyDesktopVersionPath(path: string, host: DesktopClientHost): string {
  return host === 'macos-arm64'
    ? join(path, 'Contents', 'Frameworks', 'App.framework', 'Versions', 'A', 'Resources', 'flutter_assets', 'version.json')
    : join(path, 'data', 'flutter_assets', 'version.json');
}

/** Read-only legacy eligibility. No receipt or permission change occurs before the signed swap. */
export function inspectLegacyDesktopClient(
  context: DesktopClientContext, path = expectedDesktopClientPath(context),
): PreparedDesktopClient | undefined {
  const host = desktopClientHost(context);
  const wanted = expectedDesktopClientPath(context);
  if (!host || !path || !wanted) return undefined;
  if (!within(path, wanted) || !within(wanted, path)) throw new Error('desktop-client-path-unsafe');
  try { lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  // Legacy permissions may be ordinary inherited ACLs/0755; ownership and path/link checks still hold.
  // Internal macOS framework links remain supported. No shared ancestor or retired tree is chmodded.
  validateDesktopClientTree(path, host, false, true);
  let identity: Record<string, unknown>;
  try {
    const versionPath = legacyDesktopVersionPath(path, host);
    assertNoSymlinkComponents(versionPath);
    const bytes = readFileSync(versionPath);
    if (bytes.length > 16_384) throw new Error('oversized version metadata');
    identity = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) throw new Error('invalid version metadata');
  } catch { throw new Error('desktop-client-legacy-version-unreadable'); }
  if (identity.app_name !== 'cosyncing_client' || identity.package_name !== 'cosyncing_client'
      || typeof identity.version !== 'string' || !validVersion(identity.version)) {
    throw new Error('desktop-client-legacy-identity-invalid');
  }
  if (host === 'macos-arm64') {
    const info = join(path, 'Contents', 'Info.plist');
    assertNoSymlinkComponents(info);
    const bundle = Bun.spawnSync(['/usr/bin/plutil', '-extract', 'CFBundleIdentifier', 'raw', '-o', '-', info],
      { stdout: 'pipe', stderr: 'pipe', timeout: 5_000 });
    if (bundle.exitCode !== 0 || bundle.stdout.toString().trim() !== 'com.cosyncing.client') {
      throw new Error('desktop-client-legacy-identity-invalid');
    }
  }
  return { receipt: { host, path, version: identity.version,
    executableSha256: digest(readFileSync(desktopClientExecutable({ host, path }))) },
    receiptPath: join(context.home, 'client-receipt'), legacy: true };
}

export function inspectDesktopClient(context: DesktopClientContext): PreparedDesktopClient | undefined {
  const receiptPath = join(context.home, 'client-receipt');
  const inspected = inspectOwnerOnlyFile(receiptPath);
  if (inspected.status === 'missing') return inspectLegacyDesktopClient(context);
  if (inspected.status !== 'ok') throw new Error('desktop-client-receipt-unsafe');
  const receiptBytes = readFileSync(receiptPath);
  if (receiptBytes.length > 16_384) throw new Error('desktop-client-receipt-invalid');
  const values = new Map<string, string>();
  for (const line of receiptBytes.toString('utf8').split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf('=');
    const key = line.slice(0, separator);
    if (separator < 1 || values.has(key)) throw new Error('desktop-client-receipt-invalid');
    values.set(key, line.slice(separator + 1));
  }
  const expected = ['schemaVersion', 'product', 'host', 'path', 'version', 'sha256', 'executableSha256'];
  const path = values.get('path') ?? '';
  const host = desktopClientHost(context);
  const wanted = expectedDesktopClientPath(context);
  if (values.size !== expected.length || expected.some((key) => !values.has(key))
      || values.get('schemaVersion') !== '1' || values.get('product') !== 'cosyncing'
      || !host || values.get('host') !== host || !wanted || !isAbsolute(path) || !within(path, wanted)
      || !within(wanted, path) || /[\0\r\n]/.test(path)
      || !validVersion(values.get('version')!) || !validDigest(values.get('sha256')!)
      || !validDigest(values.get('executableSha256')!)) throw new Error('desktop-client-receipt-invalid');
  const receipt: DesktopClientReceipt = { host, path, version: values.get('version')!,
    sha256: values.get('sha256')!, executableSha256: values.get('executableSha256')! };
  validateDesktopClientTree(path, host);
  if (digest(readFileSync(desktopClientExecutable(receipt))) !== receipt.executableSha256) {
    throw new Error('desktop-client-receipt-content-mismatch');
  }
  return { receipt, receiptPath, receiptBytes, legacy: false };
}

export function windowsDesktopClientRunning(snapshot: WindowsProcessSnapshot | null, path: string): boolean {
  if (!snapshot?.processesOk) throw new Error('desktop-client-process-unknown');
  const root = win32.resolve(path).toLowerCase();
  for (const process of snapshot.processes) {
    if (process.name.toLowerCase() !== 'cosyncing.exe') continue;
    if (!process.executable) throw new Error('desktop-client-process-unknown');
    const executable = win32.resolve(process.executable).toLowerCase();
    if (executable === root || executable.startsWith(`${root}\\`)) return true;
  }
  return false;
}

export function desktopClientIsRunning(path: string): boolean {
  if (process.platform === 'win32') return windowsDesktopClientRunning(captureWindowsProcessSnapshot(), path);
  if (process.platform === 'linux') {
    for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
      const base = join('/proc', pid);
      try {
        if (lstatSync(base).uid !== process.getuid?.()
            || readFileSync(join(base, 'comm'), 'utf8').trim() !== 'cosyncing') continue;
        const executable = readlinkSync(join(base, 'exe')).replace(/ \(deleted\)$/, '');
        const argument = readFileSync(join(base, 'cmdline'), 'utf8').split('\0')[0];
        if (within(executable, path) || (argument && isAbsolute(argument) && within(argument, path))) return true;
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          throw new Error('desktop-client-process-unknown');
        }
      }
    }
    return false;
  }
  const result = Bun.spawnSync(['/bin/ps', '-axo', 'uid=,pid=,comm='], { stdout: 'pipe', stderr: 'pipe', timeout: 5_000 });
  if (result.exitCode !== 0) throw new Error('desktop-client-process-unknown');
  for (const line of result.stdout.toString().split('\n')) {
    const match = /^\s*(\d+)\s+\d+\s+(.+)$/.exec(line);
    if (!match || Number(match[1]) !== process.getuid?.()) continue;
    const executable = match[2]!;
    if (isAbsolute(executable) && within(executable, path)) return true;
    if (!isAbsolute(executable) && basename(executable) === 'Cosyncing') throw new Error('desktop-client-process-unknown');
  }
  return false;
}

export function assertDesktopClientStopped(prepared: PreparedDesktopClient | undefined, context: DesktopClientContext): void {
  if (prepared && (context.isRunning ?? desktopClientIsRunning)(prepared.receipt.path)) {
    throw new DesktopClientRunningError(prepared.receipt.path);
  }
}

export function assertDesktopClientUnchanged(prepared: PreparedDesktopClient | undefined, context: DesktopClientContext): void {
  const current = inspectDesktopClient(context);
  if (!!current !== !!prepared || (current && prepared && (current.legacy !== prepared.legacy
      || JSON.stringify(current.receipt) !== JSON.stringify(prepared.receipt)
      || !current.legacy && !current.receiptBytes!.equals(prepared.receiptBytes!)))) {
    throw new Error('desktop-client-receipt-changed');
  }
  assertDesktopClientStopped(current, context);
}

/** Desktop failure never escapes into the already committed broker's rollback handler. */
export async function reconcileDesktopClient(options: {
  prepared: PreparedDesktopClient | undefined;
  context: DesktopClientContext;
  row?: ReleaseDesktopClient;
  download: (url: string, maximum: number) => Promise<Uint8Array>;
  compareVersions: (left: string, right: string) => number;
}): Promise<DesktopClientOutcome> {
  const { prepared, context, row } = options;
  const outcome = (status: DesktopClientOutcome['status'], detailCode: string, clause: string): DesktopClientOutcome => ({ status, detailCode, clause });
  if (!prepared) return outcome('skipped', 'desktop-client-unrecorded',
    ' Desktop client: no installer-owned record; no client was changed.');
  if (!row) return outcome('skipped', 'desktop-client-host-unavailable', ' Desktop client: this release has no archive for this host; the recorded client was left unchanged.');
  let stage: string | undefined;
  let retired: string | undefined;
  let placed = false;
  const move = context.rename ?? renameSync;
  const writeReceipt = context.writeReceipt ?? atomicWriteOwnerOnly;
  const remove = context.remove ?? ((path: string) => rmSync(path, { recursive: true }));
  try {
    assertDesktopClientUnchanged(prepared, context);
    const previous = prepared.receipt;
    const comparison = options.compareVersions(row.version, previous.version);
    if (comparison < 0) {
      if (prepared.legacy) return outcome('skipped', 'desktop-client-legacy-newer',
        ' The legacy desktop client is newer than this release; it was left unchanged and no ownership record was written.');
      throw new Error('desktop-client-downgrade-refused');
    }
    if (comparison === 0) {
      if (prepared.legacy) return outcome('skipped', 'desktop-client-legacy-current',
        ' The legacy desktop client already has this version; it was left unchanged and no ownership record was written.');
      if (row.sha256 !== previous.sha256) throw new Error('desktop-client-version-reused');
      return outcome('current', 'desktop-client-current', ' The installer-owned desktop client is current.');
    }
    const parent = dirname(previous.path);
    assertNoSymlinkComponents(parent);
    inspectClientNode(parent, lstatSync(parent), false, prepared.legacy);
    stage = mkdtempSync(join(parent, '.cosyncing-client.staging-'));
    ensureOwnerOnlyDirectory(stage);
    const bytes = await options.download(row.url, 256 * 1024 * 1024);
    if (bytes.length !== row.size || digest(bytes) !== row.sha256) throw new Error('desktop-client-digest-mismatch');
    const archive = join(stage, 'client.archive');
    atomicWriteOwnerOnly(archive, bytes);
    const unpack = join(stage, 'unpack'); ensureOwnerOnlyDirectory(unpack);
    await extractDesktopArchive(archive, unpack, previous.host);
    const roots = readdirSync(unpack);
    if (roots.length !== 1 || (previous.host === 'macos-arm64' && roots[0] !== 'Cosyncing.app')) {
      throw new Error('desktop-client-archive-layout-invalid');
    }
    const candidate = join(unpack, roots[0]!);
    validateDesktopClientTree(candidate, previous.host, true);
    if (previous.host === 'windows-x64') {
      const launcher = join(previous.path, 'cosyncing-launch.cmd');
      if (existsSync(launcher)) {
        if (prepared.legacy) {
          assertNoSymlinkComponents(launcher);
          const stat = lstatSync(launcher);
          if (!stat.isFile()) throw new Error('desktop-client-launcher-unsafe');
          inspectClientNode(launcher, stat, false, true);
        } else if (inspectOwnerOnlyFile(launcher).status !== 'ok') throw new Error('desktop-client-launcher-unsafe');
        atomicWriteOwnerOnly(join(candidate, 'cosyncing-launch.cmd'), readFileSync(launcher));
      }
    }
    assertDesktopClientUnchanged(prepared, context);
    retired = join(parent, `.cosyncing-client.retired-${randomUUID()}`);
    move(previous.path, retired);
    move(candidate, previous.path);
    placed = true;
    const receipt: DesktopClientReceipt = { ...previous, version: row.version, sha256: row.sha256,
      executableSha256: digest(readFileSync(desktopClientExecutable(previous))) };
    writeReceipt(prepared.receiptPath, renderDesktopClientReceipt(receipt));
    // Receipt commit is the desktop commit point. Cleanup cannot roll a complete client back to
    // a backup that cleanup might already have partly removed.
    const obsolete = retired; retired = undefined;
    let residue = false;
    try { remove(obsolete); } catch { residue = true; }
    return outcome('updated', residue ? 'desktop-client-cleanup-pending' : 'desktop-client-updated',
      ` Updated the installer-owned desktop client to ${row.version}; open it again to connect.${residue ? ' An inert previous-client directory remains for cleanup.' : ''}`);
  } catch (error) {
    let restored = true;
    try {
      if (retired) {
        if (placed) remove(prepared.receipt.path);
        move(retired, prepared.receipt.path);
        retired = undefined;
        if (prepared.receiptBytes) writeReceipt(prepared.receiptPath, prepared.receiptBytes);
        else if (existsSync(prepared.receiptPath)) remove(prepared.receiptPath);
      }
    } catch { restored = false; }
    const code = desktopClientErrorCode(error);
    const reason = error instanceof DesktopClientRunningError ? error.message
      : error instanceof Error && error.message === 'desktop-client-receipt-changed'
        ? 'The desktop client ownership record changed during the update; rerun the signed all-in-one installer to restore it.'
        : `Desktop client update failed (${code}); the previous client was preserved or restored.`;
    return outcome('failed', restored ? code : 'desktop-client-restore-failed', restored
      ? ` ${reason} The broker remains current.`
      : retired
        ? ` Desktop client restoration needs manual recovery from ${retired}. The broker remains current.`
        : ' The previous desktop client was restored, but client-receipt could not be restored; rerun the signed all-in-one installer to restore its ownership record. The broker remains current.');
  } finally {
    if (stage) try { rmSync(stage, { recursive: true }); } catch { /* inert staging residue */ }
  }
}
