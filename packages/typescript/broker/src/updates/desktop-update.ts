/** Same-user desktop updater. No HTTP route can invoke or select its client scope. */
import { captureWindowsProcessSnapshot } from '@cosyncing/adapter-api';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync, renameSync, rmSync, statfsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { acquireInstallationLock } from '../installation/installation-lock.ts';
import { inspectInstallState } from '../installation/install-state.ts';
import { atomicWriteJsonOwnerOnly, atomicWriteOwnerOnly,
  createOwnerOnlyFileExclusive, ensureOwnerOnlyDirectory, inspectOwnerOnlyFile } from '../security/secure-files.ts';
import { assertDesktopClientStopped, assertDesktopClientUnchanged, desktopClientExecutable,
  expectedDesktopClientPath, inspectDesktopClient, renderDesktopClientReceipt, stageDesktopClient,
  type DesktopClientContext, type DesktopClientReceipt, type PreparedDesktopClient } from './desktop-client.ts';
import { isReleaseId, releaseIdFromManifest, releaseKeys, verifySignedManifest,
  type ReleaseManifest } from './release-upgrade.ts';
import { compareReleaseVersions, isSupportedReleaseUpdater, satisfiesMinimum } from './updater-metadata.ts';
import { trustedDesktopHelper } from './desktop-update-bridge.ts';

import { DESKTOP_UPDATE_HELPER_VERSION } from './desktop-updater-support.ts';
export { DESKTOP_UPDATE_HELPER_VERSION } from './desktop-updater-support.ts';
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TERMINAL = new Set(['succeeded', 'failed', 'rolled_back', 'needs_attention', 'cancelled']);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type ProcessIdentity = { pid: number; start: string; executable: string };
export type DesktopUpdateJob = {
  schemaVersion: 1; id: string; releaseId: string; version: string;
  phase: string; detailCode: string; updatedAt: string; installationId: string; installationGeneration: string;
  previous: DesktopClientReceipt; previousReceipt: string;
  process: ProcessIdentity; runner?: ProcessIdentity; startup?: ProcessIdentity;
  stage?: string; candidateName?: string; candidateDigest?: string;
  safeDowngrade: boolean; manifest: ReleaseManifest; environment: Record<string, string>;
};
export interface DesktopUpdateDependencies {
  context: DesktopClientContext;
  /** The installed, signed JS bundle. It is copied outside replaceable trees before handoff. */
  applicationPath: string;
  runtimePath: string;
  fetch?: typeof fetch;
  manifestUrl?: string;
  trustedKeys?: Readonly<Record<string, string>>;
  processIdentity?: (pid: number) => ProcessIdentity | undefined;
  launch?: (executable: string, environment: Record<string, string>) => void;
  wait?: (condition: () => boolean, milliseconds: number) => Promise<boolean>;
}

/** PID reuse never counts as the process that reviewed an update. */
export function desktopProcessIdentity(pid: number): ProcessIdentity | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('desktop-update-process-invalid');
  if (process.platform === 'win32') {
    const snapshot = captureWindowsProcessSnapshot();
    if (!snapshot?.processesOk) throw new Error('desktop-client-process-unknown');
    const row = snapshot.processes.find((entry) => entry.pid === pid);
    if (!row) return undefined;
    if (!row.executable || !row.start) throw new Error('desktop-client-process-unknown');
    return { pid, start: row.start, executable: row.executable };
  }
  if (process.platform === 'linux') {
    try {
      const root = `/proc/${pid}`;
      if (lstatSync(root).uid !== process.getuid?.()) throw new Error('desktop-update-process-owner');
      const stat = readFileSync(join(root, 'stat'), 'utf8');
      return { pid, start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]!,
        executable: readlinkSync(join(root, 'exe')) };
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
      throw error;
    }
  }
  const result = Bun.spawnSync(['/bin/ps', '-p', String(pid), '-o', 'uid=,lstart=,comm='],
    { stdout: 'pipe', stderr: 'pipe', timeout: 5_000 });
  if (result.exitCode === 1 && !result.stdout.length) return undefined;
  const match = /^\s*(\d+)\s+(.{24})\s+(.+)\s*$/.exec(result.stdout.toString());
  if (result.exitCode !== 0 || !match || Number(match[1]) !== process.getuid?.()) {
    throw new Error('desktop-client-process-unknown');
  }
  return { pid, start: match[2]!, executable: match[3]! };
}

function samePath(a: string, b: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  return normalize(a) === normalize(b);
}
function identity(deps: DesktopUpdateDependencies, pid: number): ProcessIdentity | undefined {
  return (deps.processIdentity ?? desktopProcessIdentity)(pid);
}
function sameProcess(a: ProcessIdentity | undefined, b: ProcessIdentity): boolean {
  return a?.pid === b.pid && a.start === b.start && samePath(a.executable, b.executable);
}
function installation(deps: DesktopUpdateDependencies): string {
  const state = inspectInstallState(deps.context.home);
  if (!state.committed || !state.state.installationId) throw new Error('desktop-update-setup-required');
  return state.state.installationId;
}
function generation(deps: DesktopUpdateDependencies): string {
  const state = inspectInstallState(deps.context.home);
  if (!state.committed) throw new Error('desktop-update-setup-required');
  return state.state.setup.committedAt;
}
function root(deps: DesktopUpdateDependencies, id: string): string {
  if (!ID.test(id)) throw new Error('desktop-update-id-invalid');
  return join(deps.context.home, 'updates', 'desktop', id);
}
function jobPath(deps: DesktopUpdateDependencies, id: string): string { return join(root(deps, id), 'job.json'); }
function write(deps: DesktopUpdateDependencies, job: DesktopUpdateJob, phase: string, detailCode: string): DesktopUpdateJob {
  job.phase = phase; job.detailCode = detailCode; job.updatedAt = new Date().toISOString();
  atomicWriteJsonOwnerOnly(jobPath(deps, job.id), job);
  return job;
}
export function readDesktopUpdate(deps: DesktopUpdateDependencies, id: string): DesktopUpdateJob {
  const path = jobPath(deps, id);
  const inspected = inspectOwnerOnlyFile(path);
  if (inspected.status === 'missing') throw new Error('desktop-update-job-not-found');
  if (inspected.status !== 'ok') throw new Error('desktop-update-job-unsafe');
  const bytes = readFileSync(path);
  if (bytes.length > 512 * 1024) throw new Error('desktop-update-job-invalid');
  const job = JSON.parse(bytes.toString('utf8')) as DesktopUpdateJob;
  if (job.schemaVersion !== 1 || job.id !== id || !isReleaseId(job.releaseId)
      || !job.previous || !job.process || typeof job.previousReceipt !== 'string'
      || job.installationId !== installation(deps)
      || job.installationGeneration !== generation(deps)
      || !samePath(job.previous.path, expectedDesktopClientPath(deps.context) ?? '')) throw new Error('desktop-update-job-invalid');
  // Never trust arbitrary paths or a new signature supplied by a journal from a future engine.
  const manifest = verifySignedManifest(job.manifest, deps.trustedKeys ?? releaseKeys());
  if (releaseIdFromManifest(manifest) !== job.releaseId || manifest.version !== job.version) {
    throw new Error('desktop-update-target-changed');
  }
  if (job.stage && (dirname(job.stage) !== dirname(job.previous.path)
      || !/^\.cosyncing-client\.staging-[A-Za-z0-9]+$/.test(job.stage.slice(dirname(job.stage).length + 1)))) {
    throw new Error('desktop-update-stage-unsafe');
  }
  if (job.candidateName && !/^[A-Za-z0-9_.-]+$/.test(job.candidateName)) throw new Error('desktop-update-stage-unsafe');
  return job;
}
function prepared(job: DesktopUpdateJob, deps: DesktopUpdateDependencies): PreparedDesktopClient {
  return { receipt: job.previous, receiptPath: join(deps.context.home, 'client-receipt'),
    receiptBytes: Buffer.from(job.previousReceipt), legacy: false };
}
async function download(deps: DesktopUpdateDependencies, url: string, maximum: number): Promise<Uint8Array> {
  const response = await (deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok || !response.body) throw new Error('desktop-update-download-failed');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > maximum) throw new Error('desktop-update-download-too-large');
      chunks.push(next.value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}
function executableProcess(deps: DesktopUpdateDependencies, pid: number, executable: string): ProcessIdentity {
  const process = identity(deps, pid);
  if (!process || !samePath(process.executable, executable)) throw new Error('desktop-update-identity-mismatch');
  return process;
}

export function inspectDesktopUpdater(deps: DesktopUpdateDependencies, pid: number, executable: string, version?: string) {
  const current = inspectDesktopClient(deps.context);
  if (!current || current.legacy) throw new Error('desktop-update-setup-required');
  if (!samePath(desktopClientExecutable(current.receipt), executable)) throw new Error('desktop-update-identity-mismatch');
  executableProcess(deps, pid, executable);
  if (version !== undefined && current.receipt.version !== version) throw new Error('desktop-update-restart-required');
  return { helperVersion: DESKTOP_UPDATE_HELPER_VERSION, runtimeVersion: Bun.version, version: current.receipt.version,
    installationId: installation(deps), host: current.receipt.host };
}

/** Stage a fixed signed release while the old app remains fully usable. */
export async function prepareDesktopUpdate(deps: DesktopUpdateDependencies,
  request: { id: string; releaseId: string; pid: number; executable: string }): Promise<DesktopUpdateJob> {
  const existing = jobPath(deps, request.id);
  if (existsSync(existing)) {
    const job = readDesktopUpdate(deps, request.id);
    if (job.releaseId !== request.releaseId) throw new Error('desktop-update-idempotency-conflict');
    if (job.phase === 'preparing') {
      const claim = join(root(deps, request.id), 'prepare.json');
      if (inspectOwnerOnlyFile(claim).status === 'ok') {
        const owner = JSON.parse(readFileSync(claim, 'utf8')) as { schemaVersion: number; process: ProcessIdentity };
        if (owner.schemaVersion === 1 && owner.process
            && sameProcess(identity(deps, owner.process.pid), owner.process)) return job;
      }
      return write(deps, job, 'failed', 'desktop-update-preparation-interrupted');
    }
    if (job.phase === 'ready') {
      inspectDesktopUpdater(deps, request.pid, request.executable);
      job.process = executableProcess(deps, request.pid, request.executable);
      return write(deps, job, 'ready', 'prepared');
    }
    return job;
  }
  if (!isReleaseId(request.releaseId)) throw new Error('desktop-update-target-invalid');
  inspectDesktopUpdater(deps, request.pid, request.executable);
  const current = inspectDesktopClient(deps.context)!;
  const claim = join(root(deps, request.id), 'prepare.json');
  ensureOwnerOnlyDirectory(root(deps, request.id));
  if (existsSync(claim)) {
    if (inspectOwnerOnlyFile(claim).status !== 'ok') throw new Error('desktop-update-claim-unsafe');
    const old = JSON.parse(readFileSync(claim, 'utf8')) as { schemaVersion: number; releaseId: string; process: ProcessIdentity };
    if (old.schemaVersion !== 1 || !old.process) throw new Error('desktop-update-claim-unsafe');
    if (old.releaseId !== request.releaseId) throw new Error('desktop-update-idempotency-conflict');
    if (sameProcess(identity(deps, old.process.pid), old.process)) throw new Error('desktop-update-preparing');
    rmSync(claim);
  }
  const owner = identity(deps, process.pid);
  if (!owner || createOwnerOnlyFileExclusive(claim, JSON.stringify({ schemaVersion: 1,
    releaseId: request.releaseId, process: owner })) !== 'created') throw new Error('desktop-update-preparing');
  try {
  const version = /^rel-(\d+\.\d+\.\d+)\+/.exec(request.releaseId)![1]!;
  // Production never resolves latest after review. Fixture feeds may be injected by tests only.
  const url = deps.manifestUrl ?? `https://github.com/cosyncing/cosyncing/releases/download/broker-v${version}/release-manifest.json`;
  const manifest = verifySignedManifest(JSON.parse(Buffer.from(await download(deps, url, 256 * 1024)).toString()),
    deps.trustedKeys ?? releaseKeys());
  if (releaseIdFromManifest(manifest) !== request.releaseId) throw new Error('desktop-update-target-changed');
  const metadata = manifest.updater;
  const platform = metadata && isSupportedReleaseUpdater(metadata) ? metadata.desktop?.[current.receipt.host] : undefined;
  if (!metadata || !isSupportedReleaseUpdater(metadata) || !platform
      || metadata.releaseId !== request.releaseId || !metadata.clientContract
      || !satisfiesMinimum(DESKTOP_UPDATE_HELPER_VERSION, metadata.minimumHelperVersion)
      || !satisfiesMinimum(Bun.version, platform.minimumRuntimeVersion)
      || !['prepare', 'client-replace', 'client-relaunch'].every((cap) => platform.capabilities.includes(cap as never))) {
    throw new Error('desktop-update-helper-or-release-unsupported');
  }
  if (platform.minimumOsVersion) throw new Error('desktop-update-os-requirement-unverified');
  const row = manifest.desktopClients?.[current.receipt.host];
  if (!row || compareReleaseVersions(row.version, current.receipt.version) <= 0) throw new Error('desktop-update-not-newer');
  const disk = statfsSync(dirname(current.receipt.path));
  const required = Math.max(platform.stagingBytes ?? 0, row.size * 4);
  if (disk.bavail * disk.bsize < required) throw new Error('desktop-update-insufficient-space');
  ensureOwnerOnlyDirectory(root(deps, request.id));
  const job: DesktopUpdateJob = { schemaVersion: 1, id: request.id, releaseId: request.releaseId,
    version: row.version, phase: 'preparing', detailCode: 'downloading', updatedAt: new Date().toISOString(),
    installationId: installation(deps), installationGeneration: generation(deps), previous: current.receipt as DesktopClientReceipt,
    previousReceipt: current.receiptBytes!.toString('utf8'), process: executableProcess(deps, request.pid, request.executable),
    manifest, safeDowngrade: metadata.safeDowngrade === true, environment: {} };
  for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY',
    'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    const value = (deps.context.env ?? process.env)[key]; if (value) job.environment[key] = value;
  }
  write(deps, job, 'preparing', 'downloading');
  try {
    const staged = await stageDesktopClient({ prepared: current, context: deps.context, row,
      download: (url, maximum) => download(deps, url, maximum) });
    if (readDesktopUpdate(deps, job.id).phase === 'cancelled') {
      rmSync(staged.stage, { recursive: true });
      return readDesktopUpdate(deps, job.id);
    }
    job.stage = staged.stage; job.candidateName = staged.candidate.slice(join(staged.stage, 'unpack').length + 1);
    job.candidateDigest = sha(readFileSync(desktopClientExecutable({ ...current.receipt, path: staged.candidate })));
    return write(deps, job, 'ready', 'prepared');
  } catch (error) {
    write(deps, job, 'failed', error instanceof Error ? error.message : 'preparation-failed'); throw error;
  }
  } finally { rmSync(claim); }
}

async function waitUntil(condition: () => boolean, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (!condition()) {
    const remaining = deadline - Date.now(); if (remaining <= 0) return false;
    // Bounded process/IPC observation, not a fixed synchronization delay.
    await new Promise((done) => setTimeout(done, Math.min(200, remaining)));
  }
  return true;
}
function launchApp(deps: DesktopUpdateDependencies, job: DesktopUpdateJob): void {
  const executable = desktopClientExecutable(job.previous);
  const environment = { ...job.environment, COSYNCING_DESKTOP_UPDATE_HOME: deps.context.home,
    COSYNCING_DESKTOP_UPDATE_ID: job.id };
  if (deps.launch) { deps.launch(executable, environment); return; }
  if (job.previous.host === 'macos-arm64') {
    // LaunchServices gives a sandboxed app its own container home and GUI
    // lifetime. Only the operation reference crosses the launch boundary.
    const child = spawn('/usr/bin/open', ['-n', '-a', job.previous.path, '--args', `--cosyncing-update=${job.id}`],
      { detached: true, stdio: 'ignore' });
    child.on('error', () => {}); child.unref(); return;
  }
  const child = spawn(executable, [], { detached: true, stdio: 'ignore', windowsHide: false,
    cwd: dirname(executable), env: environment });
  child.on('error', () => { /* startup deadline records the authoritative failure */ }); child.unref();
}

/** Arm an independent, pinned runner before the app is allowed to quit. */
export async function armDesktopUpdate(deps: DesktopUpdateDependencies, id: string): Promise<DesktopUpdateJob> {
  const job = readDesktopUpdate(deps, id);
  if (job.phase !== 'ready') return job;
  assertDesktopClientUnchanged(prepared(job, deps), deps.context, true);
  const state = inspectInstallState(deps.context.home);
  const owned = state.committed && state.state.resources.find((row) => row.id === 'broker-binary');
  const installedRunner = owned && samePath(owned.target, deps.applicationPath)
    && sha(readFileSync(deps.applicationPath)) === owned.ownership.installedSha256;
  if (!installedRunner && !trustedDesktopHelper(deps)) {
    throw new Error('desktop-update-runner-untrusted');
  }
  const runner = join(root(deps, id), 'runner.js');
  atomicWriteOwnerOnly(runner, readFileSync(deps.applicationPath));
  const child = spawn(deps.runtimePath, [runner, 'client-update', 'run', id],
    { detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...job.environment, COSYNCING_HOME: deps.context.home }, cwd: root(deps, id) });
  child.on('error', () => { /* no acknowledgement means the app stays open */ }); child.unref();
  if (!await (deps.wait ?? waitUntil)(() => readDesktopUpdate(deps, id).phase !== 'ready', 10_000)) {
    throw new Error('desktop-update-runner-unavailable');
  }
  return readDesktopUpdate(deps, id);
}

/** New app calls only after durable storage and the first shell frame are ready. */
export function acknowledgeDesktopUpdate(deps: DesktopUpdateDependencies, id: string, pid: number, version: string) {
  const job = readDesktopUpdate(deps, id);
  if (job.phase !== 'verifying' || version !== job.version) throw new Error('desktop-update-startup-mismatch');
  const installed = inspectDesktopClient(deps.context);
  if (!installed || installed.receipt.version !== job.version || installed.receipt.executableSha256 !== job.candidateDigest) {
    throw new Error('desktop-update-startup-mismatch');
  }
  const startup = executableProcess(deps, pid, desktopClientExecutable(installed.receipt));
  atomicWriteJsonOwnerOnly(join(root(deps, id), 'startup.json'), startup);
  return { acknowledged: true };
}

/** Own the mutation lock through exit, swap and observed startup. Never stops a broker. */
export async function runDesktopUpdate(deps: DesktopUpdateDependencies, id: string): Promise<DesktopUpdateJob> {
  const job = readDesktopUpdate(deps, id);
  if (TERMINAL.has(job.phase)) return job;
  const lock = acquireInstallationLock({ home: deps.context.home, command: 'upgrade' });
  const previous = prepared(job, deps);
  const retired = join(dirname(job.previous.path), `.cosyncing-client.retired-${id}`);
  const wait = deps.wait ?? waitUntil;
  let observedExit = false;
  try {
    if (job.phase !== 'ready') {
      // Recovery inspects both rename locations. Unknown live state never authorizes a swap.
      if (job.phase === 'waiting-for-exit' && !existsSync(retired)) {
        assertDesktopClientUnchanged(previous, deps.context, true);
        if (sameProcess(identity(deps, job.process.pid), job.process)) {
          return write(deps, job, 'ready', 'desktop-update-worker-interrupted');
        }
        assertDesktopClientStopped(previous, deps.context);
        launchApp(deps, job);
        return write(deps, job, 'failed', 'desktop-update-interrupted-before-swap');
      }
      if (job.phase === 'verifying') {
        const startup = join(root(deps, id), 'startup.json');
        if (inspectOwnerOnlyFile(startup).status === 'ok') {
          const ack = JSON.parse(readFileSync(startup, 'utf8')) as ProcessIdentity;
          const installed = inspectDesktopClient(deps.context);
          if (installed?.receipt.version === job.version &&
              installed.receipt.executableSha256 === job.candidateDigest &&
              samePath(ack.executable, desktopClientExecutable(installed.receipt)) &&
              sameProcess(identity(deps, ack.pid), ack)) {
            write(deps, job, 'succeeded', 'app-updated-and-running');
            try { rmSync(retired, { recursive: true }); } catch { /* inert backup */ }
            return job;
          }
        }
      }
      assertDesktopClientStopped(previous, deps.context);
      if (existsSync(retired) && (!existsSync(job.previous.path) || job.safeDowngrade)) {
        // The retired executable must still be the version the journal recorded.
        const retiredExecutable = desktopClientExecutable({ ...job.previous, path: retired });
        if (sha(readFileSync(retiredExecutable)) !== job.previous.executableSha256) {
          return write(deps, job, 'needs_attention', 'desktop-update-backup-changed');
        }
        if (existsSync(job.previous.path)) rmSync(job.previous.path, { recursive: true });
        renameSync(retired, job.previous.path);
        atomicWriteOwnerOnly(previous.receiptPath, job.previousReceipt);
        launchApp(deps, job);
        return write(deps, job, 'rolled_back', 'interrupted-swap-restored');
      }
      return write(deps, job, 'needs_attention', 'interrupted-update-inspection-required');
    }
    assertDesktopClientUnchanged(previous, deps.context, true);
    job.runner = identity(deps, process.pid);
    write(deps, job, 'waiting-for-exit', 'runner-ready');
    if (!await wait(() => !sameProcess(identity(deps, job.process.pid), job.process), 30_000)) {
      return write(deps, job, 'failed', 'app-did-not-exit');
    }
    observedExit = true;
    assertDesktopClientUnchanged(previous, deps.context);
    if (!job.stage || !job.candidateName) throw new Error('desktop-update-stage-missing');
    // Re-extract the authenticated archive at the commit boundary; a prepared
    // directory is never accepted merely because its executable still matches.
    const oldStage = job.stage;
    const staged = await stageDesktopClient({ prepared: previous, context: deps.context,
      row: job.manifest.desktopClients![job.previous.host]!,
      download: async () => readFileSync(join(oldStage, 'client.archive')) });
    job.stage = staged.stage; job.candidateName = staged.candidate.slice(join(staged.stage, 'unpack').length + 1);
    const candidate = staged.candidate;
    if (sha(readFileSync(desktopClientExecutable({ ...job.previous, path: candidate }))) !== job.candidateDigest) {
      throw new Error('desktop-update-stage-changed');
    }
    readDesktopUpdate(deps, id); // installation identity/generation still belongs to this job
    assertDesktopClientUnchanged(previous, deps.context);
    write(deps, job, 'replacing', 'swap-started');
    rmSync(oldStage, { recursive: true });
    renameSync(job.previous.path, retired);
    renameSync(candidate, job.previous.path);
    const row = job.manifest.desktopClients![job.previous.host]!;
    const receipt: DesktopClientReceipt = { ...job.previous, version: row.version, sha256: row.sha256,
      executableSha256: job.candidateDigest! };
    atomicWriteOwnerOnly(previous.receiptPath, renderDesktopClientReceipt(receipt));
    write(deps, job, 'verifying', 'opening-app');
    launchApp(deps, job);
    const startup = join(root(deps, id), 'startup.json');
    const started = await wait(() => {
      if (inspectOwnerOnlyFile(startup).status !== 'ok') return false;
      const ack = JSON.parse(readFileSync(startup, 'utf8')) as ProcessIdentity;
      return samePath(ack.executable, desktopClientExecutable(receipt)) && sameProcess(identity(deps, ack.pid), ack);
    }, 60_000);
    if (!started) throw new Error('desktop-update-startup-unconfirmed');
    write(deps, job, 'succeeded', 'app-updated-and-running');
    try { rmSync(retired, { recursive: true }); rmSync(job.stage, { recursive: true }); } catch { /* retain inert copies */ }
    return job;
  } catch (error) {
    const code = error instanceof Error ? error.message : 'desktop-update-failed';
    if (existsSync(retired)) {
      try {
        assertDesktopClientStopped(previous, deps.context);
        if (!existsSync(job.previous.path) || job.safeDowngrade) {
          if (existsSync(job.previous.path)) rmSync(job.previous.path, { recursive: true });
          renameSync(retired, job.previous.path);
          atomicWriteOwnerOnly(previous.receiptPath, job.previousReceipt);
          launchApp(deps, job);
          return write(deps, job, 'rolled_back', code);
        }
      } catch { /* uncertain running state keeps both copies for explicit recovery */ }
      return write(deps, job, 'needs_attention', code);
    }
    if (observedExit && ['waiting-for-exit', 'replacing'].includes(job.phase)) {
      try {
        // Nothing was swapped. Reopen only the same intact, stopped install,
        // under the original installation identity and mutation lock.
        readDesktopUpdate(deps, id);
        assertDesktopClientUnchanged(previous, deps.context);
        launchApp(deps, job);
      } catch {
        return write(deps, job, 'needs_attention', code);
      }
    }
    return write(deps, job, 'failed', code);
  } finally { lock.release(); }
}

export function cancelDesktopUpdate(deps: DesktopUpdateDependencies, id: string): DesktopUpdateJob {
  const job = readDesktopUpdate(deps, id);
  if (job.phase !== 'ready' && job.phase !== 'preparing') throw new Error('desktop-update-cannot-cancel');
  write(deps, job, 'cancelled', 'cancelled-before-commit');
  if (job.stage) rmSync(job.stage, { recursive: true });
  return job;
}

/** A dead worker never leaves progress looking live forever. Recovery takes the
 * same installation lock and inspects both rename locations before restoring. */
export async function inspectDesktopUpdateProgress(deps: DesktopUpdateDependencies, id: string): Promise<DesktopUpdateJob> {
  const job = readDesktopUpdate(deps, id);
  if (!['waiting-for-exit', 'replacing', 'verifying'].includes(job.phase)) return job;
  if (job.runner && sameProcess(identity(deps, job.runner.pid), job.runner)) return job;
  return runDesktopUpdate(deps, id);
}
