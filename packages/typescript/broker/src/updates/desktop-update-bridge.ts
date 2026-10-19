/** The sandboxed macOS client reaches this independent same-user helper over
 * authenticated loopback. Its bearer capability lives in the existing client
 * container, never in a server profile or a command line.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { acquireInstallationLock } from '../installation/installation-lock.ts';
import { inspectInstallState, writeInstallState } from '../installation/install-state.ts';
import { atomicWriteJsonOwnerOnly, atomicWriteOwnerOnly, ensureOwnerOnlyDirectory,
  inspectOwnerOnlyFile } from '../security/secure-files.ts';
import { inspectDesktopClient } from './desktop-client.ts';
import type { DesktopUpdateDependencies } from './desktop-update.ts';
import { DESKTOP_HELPER_RESOURCE_ID } from './desktop-updater-support.ts';

const LABEL = 'dev.cosyncing.desktop-updater';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const escapeXml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export function desktopBridgePaths(home: string, userHome = homedir()) {
  const root = join(home, 'updates', 'helper');
  return { root, application: join(root, 'application.js'), receipt: join(root, 'receipt.json'),
    plist: join(userHome, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    endpoint: join(userHome, 'Library', 'Containers', 'com.cosyncing.client', 'Data', '.cosyncing', 'desktop-updater.json') };
}

export function trustedDesktopHelper(deps: DesktopUpdateDependencies): boolean {
  const paths = desktopBridgePaths(deps.context.home, deps.context.env?.HOME ?? homedir());
  if (deps.applicationPath !== paths.application || inspectOwnerOnlyFile(paths.receipt).status !== 'ok'
      || inspectOwnerOnlyFile(paths.application).status !== 'ok') return false;
  const receipt = JSON.parse(readFileSync(paths.receipt, 'utf8')) as Record<string, unknown>;
  const install = inspectInstallState(deps.context.home);
  return receipt.schemaVersion === 1 && receipt.application === paths.application
    && receipt.runtime === deps.runtimePath && install.committed
    && receipt.installationId === install.state.installationId
    && digest(readFileSync(paths.application)) === receipt.applicationDigest;
}

/** Invoked by the all-in-one installer, after setup and desktop ownership exist. */
export async function installDesktopBridge(deps: DesktopUpdateDependencies): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('desktop-update-bridge-unsupported');
  const lock = acquireInstallationLock({ home: deps.context.home, command: 'setup' });
  try {
    const install = inspectInstallState(deps.context.home);
    const client = inspectDesktopClient(deps.context);
    const binary = install.committed && install.state.resources.find((r) => r.id === 'broker-binary');
    if (!install.committed || !install.state.installationId || !client || client.legacy
        || !binary || binary.target !== deps.applicationPath
        || inspectOwnerOnlyFile(deps.applicationPath).status !== 'ok') throw new Error('desktop-update-setup-required');
    const bytes = readFileSync(deps.applicationPath);
    if (digest(bytes) !== binary.ownership.installedSha256) throw new Error('desktop-update-runner-untrusted');
    const paths = desktopBridgePaths(deps.context.home, deps.context.env?.HOME ?? homedir());
    if (existsSync(paths.plist)) {
      const record = install.state.resources.find((r) => r.id === DESKTOP_HELPER_RESOURCE_ID);
      if (!record || inspectOwnerOnlyFile(paths.plist).status !== 'ok'
          || digest(readFileSync(paths.plist)) !== record.ownership.installedSha256) {
        throw new Error('desktop-update-helper-service-unowned');
      }
      const stopped = Bun.spawnSync(['/bin/launchctl', 'bootout', `gui/${process.getuid!()}`, paths.plist],
        { stdout: 'pipe', stderr: 'pipe', timeout: 15_000 });
      if (stopped.exitCode !== 0) throw new Error('desktop-update-helper-stop-failed');
    }
    ensureOwnerOnlyDirectory(paths.root);
    atomicWriteOwnerOnly(paths.application, bytes);
    atomicWriteJsonOwnerOnly(paths.receipt, { schemaVersion: 1, application: paths.application,
      applicationDigest: digest(bytes), runtime: deps.runtimePath, installationId: install.state.installationId });
    const argv = ['/usr/bin/env', `COSYNCING_HOME=${deps.context.home}`, `HOME=${homedir()}`,
      deps.runtimePath, paths.application, 'client-update-bridge'];
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${argv.map((a) => `<string>${escapeXml(a)}</string>`).join('')}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>AbandonProcessGroup</key><true/>
</dict></plist>\n`;
    atomicWriteOwnerOnly(paths.plist, plist);
    // The record exists before launch: an interrupted install remains owned and repairable.
    writeInstallState({ ...install.state, resources: [
      ...install.state.resources.filter((r) => r.id !== DESKTOP_HELPER_RESOURCE_ID),
      { id: DESKTOP_HELPER_RESOURCE_ID, kind: 'other', target: paths.root,
        ownership: { proof: 'receipt', installedSha256: digest(Buffer.from(plist)), marker: 'cosyncing:desktop-helper:v1' } },
    ] }, deps.context.home);
    const started = Bun.spawnSync(['/bin/launchctl', 'bootstrap', `gui/${process.getuid!()}`, paths.plist],
      { stdout: 'pipe', stderr: 'pipe', timeout: 15_000 });
    if (started.exitCode !== 0) throw new Error('desktop-update-helper-start-failed');
  } finally { lock.release(); }
}

/** Strictly local command vocabulary; request bodies cannot choose a path or executable to run. */
export async function startDesktopBridge(deps: DesktopUpdateDependencies) {
  if ((deps.context.platform ?? process.platform) !== 'darwin' || !trustedDesktopHelper(deps)) throw new Error('desktop-update-runner-untrusted');
  const paths = desktopBridgePaths(deps.context.home, deps.context.env?.HOME ?? homedir());
  const token = randomBytes(32).toString('base64url');
  const { runDesktopUpdateCommand } = await import('../cli/desktop-update-command.ts');
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    async fetch(request, server) {
      if (request.headers.has('origin') || request.method !== 'POST'
          || request.headers.get('x-cosyncing-desktop-update') !== token) {
        return new Response(null, { status: 403 });
      }
      const url = new URL(request.url);
      if (url.pathname !== '/update' || Number(request.headers.get('content-length') ?? 0) > 16_384) {
        return new Response(null, { status: 400 });
      }
      let body: Record<string, unknown>;
      try {
        // Stream cap applies even when Content-Length is absent or false.
        if (!request.body) throw new Error('missing');
        const reader = request.body.getReader(); let bytes = Buffer.alloc(0);
        try {
          while (true) {
            const row = await reader.read(); if (row.done) break;
            if (bytes.length + row.value.length > 16_384) throw new Error('oversized');
            bytes = Buffer.concat([bytes, row.value]);
          }
        } finally { await reader.cancel(); }
        body = JSON.parse(bytes.toString()) as Record<string, unknown>;
      } catch { return new Response(null, { status: 400 }); }
      const { action, id, pid, executable, releaseId, version } = body;
      if (typeof action !== 'string' || !['inspect', 'prepare', 'apply', 'status', 'cancel', 'ack'].includes(action)) {
        return new Response(null, { status: 400 });
      }
      const args = [action];
      if (action !== 'inspect') {
        if (typeof id !== 'string') return new Response(null, { status: 400 });
        args.push(id);
      }
      if (action === 'inspect' || action === 'prepare' || action === 'ack') {
        if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return new Response(null, { status: 400 });
        args.push('--pid', String(pid));
      }
      if (action === 'inspect' || action === 'prepare') {
        if (typeof executable !== 'string') return new Response(null, { status: 400 });
        args.push('--executable', executable);
        if (action === 'inspect' && typeof version === 'string') args.push('--version', version);
      }
      if (action === 'prepare') {
        if (typeof releaseId !== 'string') return new Response(null, { status: 400 });
        args.push('--release', releaseId);
      }
      if (action === 'ack') {
        if (typeof version !== 'string') return new Response(null, { status: 400 });
        args.push('--version', version);
      }
      let output = '';
      // Authenticated preparation can exceed Bun's ordinary HTTP idle window.
      // The command itself has bounded downloads and reports a durable job.
      server.timeout(request, 0);
      await runDesktopUpdateCommand(args, deps, { write: (text) => { output += text; } });
      return new Response(output, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    },
  });
  const install = inspectInstallState(deps.context.home);
  atomicWriteJsonOwnerOnly(paths.endpoint, { schemaVersion: 1, port: server.port, token,
    installationId: install.committed ? install.state.installationId : undefined });
  return server;
}

export function desktopBridgeIsOwned(home: string, expectedDigest: string | undefined): boolean {
  if (process.platform !== 'darwin' || !expectedDigest) return false;
  const paths = desktopBridgePaths(home);
  if (inspectOwnerOnlyFile(paths.plist).status !== 'ok' || digest(readFileSync(paths.plist)) !== expectedDigest
      || inspectOwnerOnlyFile(paths.receipt).status !== 'ok'
      || inspectOwnerOnlyFile(paths.application).status !== 'ok') return false;
  const receipt = JSON.parse(readFileSync(paths.receipt, 'utf8')) as Record<string, unknown>;
  return receipt.schemaVersion === 1 && receipt.application === paths.application
    && receipt.applicationDigest === digest(readFileSync(paths.application));
}

/** Called only under the normal uninstall lock after its ownership plan is confirmed. */
export function removeDesktopBridge(home: string, expectedDigest: string | undefined): void {
  if (!desktopBridgeIsOwned(home, expectedDigest)) throw new Error('desktop-update-helper-drift');
  const paths = desktopBridgePaths(home);
  const result = Bun.spawnSync(['/bin/launchctl', 'bootout', `gui/${process.getuid!()}`, paths.plist],
    { stdout: 'pipe', stderr: 'pipe', timeout: 15_000 });
  if (result.exitCode !== 0) throw new Error('desktop-update-helper-stop-failed');
  rmSync(paths.plist);
  if (inspectOwnerOnlyFile(paths.endpoint).status === 'ok') rmSync(paths.endpoint);
  for (const file of [paths.receipt, paths.application]) {
    if (inspectOwnerOnlyFile(file).status === 'ok') rmSync(file);
  }
}
