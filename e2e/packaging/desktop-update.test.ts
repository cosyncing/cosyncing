/** Local update journeys through the CLI boundary and real installation trees.
 * Process exit/startup are controlled observations; these tests do not claim
 * native GUI acceptance or a successful OS background-job handoff.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openUpdateManagementHost } from '../../packages/typescript/broker/src/updates/update-management-host.ts';
import { updateCheck, createUpdatePlan, createUpdateJob, applyUpdateJob } from '../../packages/typescript/broker/src/updates/update-management.ts';
import type { BuildInfo } from '../../packages/typescript/broker/src/runtime/build-info.ts';
import { captureProcessOutput, isolatedBrokerFixtureEnvironment } from '../../packages/typescript/broker/test/helpers/isolated-broker-fixture.ts';
import { runDesktopUpdateCommand } from '../../packages/typescript/broker/src/cli/desktop-update-command.ts';
import { committedInstallState, writeInstallState } from '../../packages/typescript/broker/src/installation/install-state.ts';
import { acquireInstallationLock } from '../../packages/typescript/broker/src/installation/installation-lock.ts';
import { atomicWriteJsonOwnerOnly, atomicWriteOwnerOnly, ensureOwnerOnlyDirectory } from '../../packages/typescript/broker/src/security/secure-files.ts';
import { renderDesktopClientReceipt } from '../../packages/typescript/broker/src/updates/desktop-client.ts';
import { acknowledgeDesktopUpdate, type DesktopUpdateDependencies } from '../../packages/typescript/broker/src/updates/desktop-update.ts';
import { releaseManifestForTests } from '../../packages/typescript/broker/src/updates/release-upgrade.ts';
import { desktopClientAssetName } from '../../packages/typescript/broker/src/updates/desktop-client-types.ts';
import { feedUpdater, createFakeReleaseFeed, FEED_MANIFEST_URL, FEED_TRUSTED_KEYS, feedSurfaceHash } from '../../packages/typescript/broker/test/helpers/update-release-feed.ts';
import { desktopBridgePaths, startDesktopBridge } from '../../packages/typescript/broker/src/updates/desktop-update-bridge.ts';
import { desktopClientExecutable } from '../../packages/typescript/broker/src/updates/desktop-client.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

function fixture(options: { startup?: 'ack' | 'crash' | 'unknown'; safeDowngrade?: boolean; metadata?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-desktop-update-')); roots.push(root);
  const home = join(root, '.cosyncing'); ensureOwnerOnlyDirectory(home);
  const appData = join(root, 'custom-data'); ensureOwnerOnlyDirectory(appData);
  atomicWriteOwnerOnly(join(appData, 'draft.txt'), 'durable user draft');
  const client = join(home, 'client'); ensureOwnerOnlyDirectory(client);
  const executable = join(client, 'cosyncing');
  const old = 'old-client'; const next = 'new-client';
  atomicWriteOwnerOnly(executable, old, { mode: 0o700 });
  const receipt = renderDesktopClientReceipt({ host: 'linux-x64', path: client,
    version: '1.0.0', sha256: '1'.repeat(64), executableSha256: digest(old) });
  atomicWriteOwnerOnly(join(home, 'client-receipt'), receipt);
  const bundle = join(home, 'bin', 'cosyncing');
  atomicWriteOwnerOnly(bundle, 'signed fixture bundle');
  const state = committedInstallState(); state.installationId = randomUUID();
  state.resources.push({ id: 'broker-binary', kind: 'binary', target: bundle,
    ownership: { proof: 'package-hash', installedSha256: digest(readFileSync(bundle)) } });
  writeInstallState(state, home);
  const pack = join(root, 'pack'); ensureOwnerOnlyDirectory(join(pack, 'client'));
  atomicWriteOwnerOnly(join(pack, 'client', 'cosyncing'), next, { mode: 0o700 });
  const archive = join(root, 'client.tar.gz');
  const tar = Bun.spawnSync(['tar', '-czf', archive, '-C', pack, 'client'], { stderr: 'pipe' });
  if (tar.exitCode !== 0) throw new Error(tar.stderr.toString());
  const bytes = readFileSync(archive);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const metadata = feedUpdater({ version: '2.0.0', sourceCommit: '2222222',
    clientContract: { revision: 32, minimumBrokerRevision: 16 },
    safeDowngrade: options.safeDowngrade ?? true, desktop: { 'linux-x64': {} } });
  const manifest = releaseManifestForTests({ version: '2.0.0', sourceCommit: '2222222',
    publishedAt: '2026-01-01T00:00:00.000Z', keyId: 'fixture',
    sign: (payload) => sign(null, payload, privateKey),
    artifact: { name: 'cosyncing-linux-x64', target: 'linux-x64', platform: 'linux', arch: 'x64',
      size: 1, sha256: digest('x'), url: 'https://fixture.invalid/broker', provenanceUrl: 'https://fixture.invalid/provenance' },
    ...(options.metadata === false ? {} : { updater: metadata }),
    desktopClients: { 'linux-x64': { name: desktopClientAssetName('linux-x64', '2.0.0'),
      version: '2.0.0', size: bytes.length, sha256: digest(bytes), url: 'https://fixture.invalid/client.tar.gz' } },
  });
  const id = randomUUID();
  let oldRunning = true; let newRunning = false; let launches = 0; let downloads = 0;
  let corruptArchive = false;
  const deps: DesktopUpdateDependencies = {
    context: { home, env: { HOME: root, XDG_DATA_HOME: appData },
      platform: 'linux', arch: 'x64', isRunning: () => oldRunning || newRunning },
    applicationPath: bundle, runtimePath: process.execPath, manifestUrl: 'https://fixture.invalid/manifest.json',
    trustedKeys: { fixture: publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    fetch: (async (input) => {
      if (String(input).endsWith('manifest.json')) return Response.json(manifest);
      downloads++; return new Response(corruptArchive ? Buffer.from('tampered') : bytes);
    }) as typeof fetch,
    processIdentity: (pid) => pid === 10001 ? oldRunning ? { pid, start: 'old-start', executable } : undefined
      : pid === 10002 ? newRunning ? { pid, start: 'new-start', executable } : undefined
        : { pid, start: 'runner-start', executable: process.execPath },
    launch: (_executable, environment) => {
      // Reopening must see the same device-local state, even with a custom
      // XDG root. A healthy empty default database would not prove recovery.
      expect(readFileSync(join(environment.XDG_DATA_HOME!, 'draft.txt'), 'utf8')).toBe('durable user draft');
      launches++; newRunning = options.startup !== 'crash';
    },
    wait: async (condition, timeout) => {
      if (timeout === 30_000) oldRunning = false;
      if (timeout === 60_000 && (options.startup ?? 'ack') === 'ack') {
        acknowledgeDesktopUpdate(deps, id, 10002, '2.0.0');
      }
      return condition();
    },
  };
  async function command(...args: string[]) {
    let stdout = '';
    const code = await runDesktopUpdateCommand(args, deps, { write: (text) => { stdout += text; } });
    return { code, result: JSON.parse(stdout) };
  }
  const prepare = () => command('prepare', id, '--pid', '10001', '--executable', executable,
    '--release', 'rel-2.0.0+2222222');
  return { deps, id, home, executable, receipt, prepare, command,
    corrupt: () => { corruptArchive = true; },
    stopOld: () => { oldRunning = false; },
    get downloads() { return downloads; },
    get launches() { return launches; },
    get oldRunning() { return oldRunning; },
  };
}

describe.skipIf(process.platform !== 'linux')('desktop in-app update lifecycle', () => {
  test('a failed prepared server update reports its CLI result and settles the job immediately on Linux', async () => {
    const f = fixture();
    const contract = { revision: 35, minimumClientRevision: 16, surfaceHash: feedSurfaceHash(35) };
    const feed = createFakeReleaseFeed({ releases: [{ name: 'candidate', version: '2.0.0', sourceCommit: '2222222',
      publishedAt: '2026-01-01T00:00:00.000Z', contract,
      updater: feedUpdater({ version: '2.0.0', sourceCommit: '2222222' }) }] });
    const buildInfo = { version: '1.0.0', commit: '1111111', packaged: true, dirty: false,
      distribution: 'native', target: 'linux-x64', contract } as BuildInfo;
    const host = openUpdateManagementHost({ home: f.home, buildInfo,
      manifestUrl: FEED_MANIFEST_URL, fetch: feed.fetch, trustedKeys: FEED_TRUSTED_KEYS,
      handoff: async (_job, mayLaunch) => {
        const authority = mayLaunch();
        return { accepted: authority.allowed, detailCode: authority.allowed ? 'handoff-accepted' : authority.detailCode };
      } });
    const caller = { kind: 'remote-owner', id: 'owner', updateGranted: true } as const;
    await updateCheck(host.dependencies);
    const plan = await createUpdatePlan(host.dependencies, caller, { releaseId: 'rel-2.0.0+2222222',
      components: ['broker'], expected: { version: '1.0.0', buildId: '1111111' },
      acknowledgements: ['server-will-disconnect', 'compatibility-unconfirmed', 'interruption-during-work'] });
    if (!plan.ok) throw new Error(JSON.stringify(plan));
    const job = await createUpdateJob(host.dependencies, caller, { planId: plan.value.planId, idempotencyKey: randomUUID() });
    if (!job.ok) throw new Error(JSON.stringify(job));
    expect(job.value.phase).toBe('ready');
    const applied = await applyUpdateJob(host.dependencies, caller, job.value.jobId, { idempotencyKey: randomUUID() });
    expect(applied.ok).toBe(true);
    // Damage bytes after signed preparation. The real installer must reject
    // them and the shared CLI must persist that failure before its deadline.
    atomicWriteOwnerOnly(join(f.home, 'updates/staging', job.value.jobId, 'cosyncing-linux-x64'), 'damaged');
    const driver = join(f.home, 'fixture-cli.ts');
    const cli = join(import.meta.dir, '../../packages/typescript/broker/src/cli/cli.ts');
    const upgrade = join(import.meta.dir, '../../packages/typescript/broker/src/updates/release-upgrade.ts');
    atomicWriteOwnerOnly(driver, `import { runCli } from ${JSON.stringify(cli)};
import { runUpgrade } from ${JSON.stringify(upgrade)};
process.exitCode = await runCli(process.argv.slice(2), { buildInfo: ${JSON.stringify(buildInfo)},
  upgradeTransaction: (deps) => runUpgrade({ ...deps, executablePath: ${JSON.stringify(f.deps.applicationPath)},
    trustedKeys: ${JSON.stringify(FEED_TRUSTED_KEYS)} }) });`);
    const env = isolatedBrokerFixtureEnvironment(f.home, { overrides: { COSYNCING_HOME: f.home } });
    const child = Bun.spawn([process.execPath, driver, 'upgrade', '--yes', '--json', '--components', 'broker',
      '--release', 'rel-2.0.0+2222222', '--prepared-job', job.value.jobId, '--manifest', FEED_MANIFEST_URL],
    { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const capture = captureProcessOutput(child);
    const timer = setTimeout(() => child.kill(), 15_000);
    try {
      const code = await child.exited; await capture.done;
      expect(code, capture.read()).toBe(1);
      expect(JSON.parse(capture.read())).toMatchObject({ status: 'failed', detailCode: 'release-download-unavailable' });
      const settled = host.store.readJob(job.value.jobId);
      expect(settled.ok && settled.value.phase).toBe('failed');
      expect(settled.ok && settled.value.events.at(-1)?.detailCode).toBe('release-download-unavailable');
      expect(readFileSync(f.deps.applicationPath, 'utf8')).toBe('signed fixture bundle');
    } finally { clearTimeout(timer); child.kill(); await child.exited; }
  });

  test('prepares while the app runs, installs only after exit, and requires observed startup', async () => {
    const f = fixture();
    const doubleClick = await Promise.all([f.prepare(), f.prepare()]);
    expect(doubleClick.some((r) => r.result.phase === 'ready')).toBe(true);
    expect(f.downloads).toBe(1);
    expect(f.oldRunning).toBe(true);
    expect(readFileSync(f.executable, 'utf8')).toBe('old-client');
    expect((await f.prepare()).result.id).toBe(f.id);
    const applied = await f.command('run', f.id);
    expect(applied.result.phase).toBe('succeeded');
    expect(readFileSync(f.executable, 'utf8')).toBe('new-client');
    expect(readFileSync(join(f.home, 'client-receipt'), 'utf8')).toContain('version=2.0.0');
    expect(f.launches).toBe(1);
    expect((await f.command('run', f.id)).result.phase).toBe('succeeded');
    expect(f.launches).toBe(1);
  });

  test('a candidate that crashes restores the prior client and receipt, independently of broker state', async () => {
    const f = fixture({ startup: 'crash' }); await f.prepare();
    expect((await f.command('run', f.id)).result.phase).toBe('rolled_back');
    expect(readFileSync(f.executable, 'utf8')).toBe('old-client');
    expect(readFileSync(join(f.home, 'client-receipt'), 'utf8')).toBe(f.receipt);
    expect(f.launches).toBe(2);
  });

  test('a pre-swap failure reopens only the unchanged stopped installation', async () => {
    for (const unsafe of ['none', 'content', 'running', 'installation']) {
      const f = fixture({ safeDowngrade: false }); await f.prepare();
      const path = join(f.home, 'updates', 'desktop', f.id, 'job.json');
      const job = JSON.parse(readFileSync(path, 'utf8'));
      atomicWriteOwnerOnly(join(job.stage, 'client.archive'), 'corrupted after preparation');
      const wait = f.deps.wait!;
      f.deps.wait = async (condition, timeout) => {
        const exited = await wait(condition, timeout);
        if (timeout === 30_000) {
          if (unsafe === 'content') atomicWriteOwnerOnly(f.executable, 'changed-client', { mode: 0o700 });
          if (unsafe === 'running') f.deps.context.isRunning = () => true;
          if (unsafe === 'installation') {
            const state = committedInstallState(); state.installationId = randomUUID();
            writeInstallState(state, f.home);
          }
        }
        return exited;
      };
      const result = await f.command('run', f.id);
      expect(result.result.phase).toBe(unsafe === 'none' ? 'failed' : 'needs_attention');
      expect(f.launches).toBe(unsafe === 'none' ? 1 : 0);
      expect(readFileSync(f.executable, 'utf8')).toBe(unsafe === 'content' ? 'changed-client' : 'old-client');
      expect(readFileSync(join(f.home, 'client-receipt'), 'utf8')).toBe(f.receipt);
      expect(existsSync(join(f.home, `.cosyncing-client.retired-${f.id}`))).toBe(false);
      if (unsafe !== 'installation') await f.command('status', f.id);
      expect(f.launches).toBe(unsafe === 'none' ? 1 : 0);
    }
  });

  test('unconfirmed live startup or unsafe durable-state rollback preserves both builds for recovery', async () => {
    for (const options of [{ startup: 'unknown' as const }, { startup: 'crash' as const, safeDowngrade: false }]) {
      const f = fixture(options); await f.prepare();
      expect((await f.command('run', f.id)).result.phase).toBe('needs_attention');
      expect(readFileSync(f.executable, 'utf8')).toBe('new-client');
      expect(existsSync(join(f.home, `.cosyncing-client.retired-${f.id}`))).toBe(true);
    }
  });

  test('unauthenticated archives, absent capabilities, wrong executable and another updater cannot mutate the installation', async () => {
    const damaged = fixture(); damaged.corrupt();
    expect((await damaged.prepare()).code).toBe(1);
    expect(readFileSync(damaged.executable, 'utf8')).toBe('old-client');
    const legacy = fixture({ metadata: false });
    expect((await legacy.prepare()).result.detailCode).toBe('desktop-update-helper-or-release-unsupported');
    expect((await legacy.command('inspect', '--pid', '10001', '--executable', '/unowned/cosyncing')).code).toBe(1);
    const busy = fixture(); await busy.prepare();
    const lock = acquireInstallationLock({ home: busy.home, command: 'upgrade' });
    try { expect((await busy.command('run', busy.id)).code).toBe(1); }
    finally { lock.release(); }
    expect(readFileSync(busy.executable, 'utf8')).toBe('old-client');
  });

  test('cancellation preserves the running installation and cannot be mistaken for a completed update', async () => {
    const f = fixture(); await f.prepare();
    expect((await f.command('cancel', f.id)).result.phase).toBe('cancelled');
    expect((await f.command('run', f.id)).result.phase).toBe('cancelled');
    expect(readFileSync(f.executable, 'utf8')).toBe('old-client');
    expect(f.launches).toBe(0);
  });

  test('a crash between filesystem renames restores the owned previous app; a future journal is preserved', async () => {
    const f = fixture(); await f.prepare();
    const path = join(f.home, 'updates', 'desktop', f.id, 'job.json');
    const job = JSON.parse(readFileSync(path, 'utf8'));
    job.phase = 'waiting-for-exit';
    job.runner = { pid: 10001, start: 'interrupted-worker', executable: f.executable };
    atomicWriteJsonOwnerOnly(path, job);
    expect((await f.command('status', f.id)).result.phase).toBe('ready');
    expect(f.launches).toBe(0);
    f.stopOld();
    renameSync(join(f.home, 'client'), join(f.home, `.cosyncing-client.retired-${f.id}`));
    job.phase = 'replacing'; atomicWriteJsonOwnerOnly(path, job);
    expect((await f.command('status', f.id)).result.phase).toBe('rolled_back');
    expect(readFileSync(f.executable, 'utf8')).toBe('old-client');
    job.schemaVersion = 2; atomicWriteJsonOwnerOnly(path, job);
    const before = readFileSync(path, 'utf8');
    expect((await f.command('run', f.id)).code).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});

test('the sandbox bridge requires its private capability, refuses browser origins and arbitrary commands, and rotates authority after restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-desktop-bridge-')); roots.push(root);
  const home = join(root, '.cosyncing');
  const paths = desktopBridgePaths(home, root);
  ensureOwnerOnlyDirectory(paths.root);
  const state = committedInstallState(); state.installationId = randomUUID(); writeInstallState(state, home);
  atomicWriteOwnerOnly(paths.application, 'fixture authenticated helper');
  atomicWriteJsonOwnerOnly(paths.receipt, { schemaVersion: 1, application: paths.application,
    applicationDigest: digest(readFileSync(paths.application)), runtime: process.execPath, installationId: state.installationId });
  const client = join(root, 'Applications', 'Cosyncing.app');
  const executable = desktopClientExecutable({ host: 'macos-arm64', path: client });
  ensureOwnerOnlyDirectory(join(client, 'Contents', 'MacOS'));
  atomicWriteOwnerOnly(executable, 'fixture mac client', { mode: 0o700 });
  atomicWriteOwnerOnly(join(home, 'client-receipt'), renderDesktopClientReceipt({ host: 'macos-arm64', path: client,
    version: '1.0.0', sha256: '1'.repeat(64), executableSha256: digest(readFileSync(executable)) }));
  const deps: DesktopUpdateDependencies = { context: { home, platform: 'darwin', arch: 'arm64', env: { HOME: root } },
    applicationPath: paths.application, runtimePath: process.execPath,
    processIdentity: (pid) => ({ pid, start: 'fixture-start', executable }) };
  let server = await startDesktopBridge(deps);
  const endpoint = () => JSON.parse(readFileSync(paths.endpoint, 'utf8')) as { token: string; port: number };
  const first = endpoint();
  const request = (token: string, body: unknown, origin?: string) => fetch(`http://127.0.0.1:${server.port}/update`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-cosyncing-desktop-update': token,
      ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
  try {
    const inspect = { action: 'inspect', pid: 42, executable };
    expect((await request('wrong', inspect)).status).toBe(403);
    expect((await request(first.token, inspect, 'https://attacker.invalid')).status).toBe(403);
    const accepted = await request(first.token, inspect);
    expect(accepted.status).toBe(200);
    const json = await accepted.json() as Record<string, unknown>;
    expect(json.installationId).toBe(state.installationId);
    expect(json).not.toHaveProperty('token');
    expect((await request(first.token, { action: 'run', command: 'arbitrary' })).status).toBe(400);
    expect((await request(first.token, { action: 'inspect', extra: 'x'.repeat(20_000) })).status).toBe(400);
    await server.stop(true);
    server = await startDesktopBridge(deps);
    expect(endpoint().token).not.toBe(first.token);
    expect((await request(first.token, inspect)).status).toBe(403);
    expect((await request(endpoint().token, inspect)).status).toBe(200);
  } finally { await server.stop(true); }
});
