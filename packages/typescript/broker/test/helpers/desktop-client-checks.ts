import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BUILD_INFO } from '../../src/runtime/build-info.ts';
import { defaultBrokerConfig, writeBrokerConfig } from '../../src/runtime/configuration.ts';
import { committedInstallState, writeInstallState } from '../../src/installation/install-state.ts';
import { acquireInstallationLock } from '../../src/installation/installation-lock.ts';
import { writeSetupState } from '../../src/installation/setup-state.ts';
import { atomicWriteOwnerOnly, ensureOwnerOnlyDirectory } from '../../src/security/secure-files.ts';
import {
  desktopClientHost, expectedDesktopClientPath, desktopClientExecutable,
  renderDesktopClientReceipt, validateDesktopClientTree, windowsDesktopClientRunning,
  inspectLegacyDesktopClient, legacyDesktopVersionPath, type DesktopClientReceipt,
} from '../../src/updates/desktop-client.ts';
import { desktopClientAssetName, type ReleaseDesktopClients } from '../../src/updates/desktop-client-types.ts';
import { validateDesktopZip } from '../../src/updates/desktop-client-archive.ts';
import zipFixtures from './desktop-zip-fixtures.json';
import legacyIdentityFixtures from './legacy-desktop-identity-fixtures.json';
import {
  releaseManifestForTests, releaseManifestSigningPayload, runUpgrade, type UpgradeDependencies,
} from '../../src/updates/release-upgrade.ts';

type Check = (name: string, ok: boolean, detail?: string) => void;
const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

export async function runDesktopClientChecks(check: Check): Promise<void> {
  const host = desktopClientHost({ home: '' });
  if (!host) return;
  const roots: string[] = [];
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyId = 'desktop-client-fixture';
  const trustedKeys = { [keyId]: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  const candidateBroker = Buffer.from('desktop-fixture-broker-v2');
  const newClient = 'desktop-fixture-client-v2';
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'cosyncing-desktop-client-'));
    roots.push(root);
    const userHome = join(root, 'user');
    const home = join(userHome, '.cosyncing');
    const env = { HOME: userHome, USERPROFILE: userHome, LOCALAPPDATA: join(userHome, 'local-app-data') };
    ensureOwnerOnlyDirectory(home);
    writeBrokerConfig(defaultBrokerConfig(), home);
    writeSetupState({ serviceChoice: 'foreground' }, home);
    const binary = join(home, 'bin', 'cosyncing');
    atomicWriteOwnerOnly(binary, 'desktop-fixture-broker-v1', { mode: 0o700 });
    const state = committedInstallState('2026-10-01T00:00:00.000Z');
    state.resources = [{ id: 'broker-binary', kind: 'binary', target: binary,
      ownership: { proof: 'package-hash', installedSha256: hash(readFileSync(binary)) } }];
    writeInstallState(state, home);
    const path = expectedDesktopClientPath({ home, env })!;
    ensureOwnerOnlyDirectory(path);
    const executable = desktopClientExecutable({ host, path });
    atomicWriteOwnerOnly(executable, 'desktop-fixture-client-v1', { mode: 0o700 });
    const receipt: DesktopClientReceipt = { host, path, version: '1.0.0',
      sha256: '1'.repeat(64), executableSha256: hash(readFileSync(executable)) };
    const receiptPath = join(home, 'client-receipt');
    atomicWriteOwnerOnly(receiptPath, renderDesktopClientReceipt(receipt));
    const recordBefore = readFileSync(receiptPath);
    const pack = join(root, 'pack'); ensureOwnerOnlyDirectory(pack);
    const app = join(pack, host === 'macos-arm64' ? 'Cosyncing.app' : 'client-v2');
    ensureOwnerOnlyDirectory(app);
    atomicWriteOwnerOnly(desktopClientExecutable({ host, path: app }), newClient, { mode: 0o700 });
    const archive = join(root, host === 'linux-x64' ? 'client.tar.gz' : 'client.zip');
    const args = host === 'linux-x64' ? ['tar', '-czf', archive, '-C', pack, 'client-v2']
      : host === 'macos-arm64' ? ['/usr/bin/ditto', '-c', '-k', '--keepParent', app, archive]
        : ['tar.exe', '-a', '-cf', archive, '-C', pack, 'client-v2'];
    const packed = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
    if (packed.exitCode !== 0) throw new Error(`desktop archive fixture failed: ${packed.stderr.toString()}`);
    const bytes = readFileSync(archive);
    const row = { name: desktopClientAssetName(host, '2.0.0'), version: '2.0.0',
      size: bytes.length, sha256: hash(bytes), url: 'https://desktop.example/client.archive' };
    const clients: ReleaseDesktopClients = { [host]: row };
    const manifest = releaseManifestForTests({ version: '2.0.0', sourceCommit: '2222222',
      publishedAt: '2026-10-01T00:00:00.000Z', keyId,
      artifact: { name: 'cosyncing-linux-x64', target: 'linux-x64', platform: 'linux', arch: 'x64',
        size: candidateBroker.length, sha256: hash(candidateBroker), url: 'https://desktop.example/broker',
        provenanceUrl: 'https://desktop.example/provenance' },
      desktopClients: clients, sign: (payload) => sign(null, payload, privateKey) });
    const events: string[] = [];
    const options: UpgradeDependencies = {
      home, env, buildInfo: { ...BUILD_INFO, version: '1.0.0', target: 'linux-x64', distribution: 'native', packaged: true, dirty: false },
      executablePath: binary, manifestUrl: 'https://desktop.example/manifest.json', trustedKeys,
      fetch: (async (input) => {
        const url = String(input);
        if (url.endsWith('manifest.json')) { events.push('manifest'); return Response.json(manifest); }
        if (url.endsWith('client.archive')) { events.push('client-download'); return new Response(bytes); }
        events.push('broker-download'); return new Response(candidateBroker);
      }) as typeof fetch,
      runBinary: async (_executable, args) => {
        // The closing checks are the installed build's read-only `status --readiness` and `doctor`.
        events.push(args.includes('claude-mod') ? 'mod' : args.includes('doctor') ? 'doctor'
          : args.includes('--readiness') ? 'readiness' : 'self-check');
        return { status: 'ok', exitCode: 0, stderr: '', stdout: JSON.stringify({ version: '2.0.0',
          target: 'linux-x64', distribution: 'native', packaged: true }) };
      },
      service: { inspect: async () => ({ active: true }), stop: async () => { events.push('stop'); },
        start: async () => { events.push('start'); } },
      verifyBrokerVersion: async () => { events.push('health'); return true; },
      healthAttempts: 1, sleep: async () => undefined,
      desktop: { isRunning: () => false },
    };
    return { root, home, env, binary, path, executable, receiptPath, recordBefore, receipt, bytes,
      options, events, manifest, row };
  };
  const oldClientPreserved = (f: ReturnType<typeof fixture>): boolean =>
    readFileSync(f.executable, 'utf8') === 'desktop-fixture-client-v1'
      && readFileSync(f.receiptPath).equals(f.recordBefore);
  const makeLegacy = (f: ReturnType<typeof fixture>, version = '0.6.4', appName = 'cosyncing_client'): string => {
    rmSync(f.receiptPath);
    const path = legacyDesktopVersionPath(f.path, host);
    // An elevated Windows token otherwise stamps Administrators on the raw metadata nodes.
    // Model the user-owned prior install with the same explicit-owner creators as the installer.
    ensureOwnerOnlyDirectory(dirname(path));
    atomicWriteOwnerOnly(path, JSON.stringify({ ...legacyIdentityFixtures.linux.version, version, app_name: appName }));
    if (process.platform !== 'win32') {
      chmodSync(f.path, 0o775); chmodSync(f.executable, 0o755); chmodSync(path, 0o644);
    }
    return path;
  };
  try {
    {
      const root = 'C:\\scratch\\client';
      const snapshot = (executable: string | null) => ({ processesOk: true, listenersOk: false,
        listeners: [], processes: [{ pid: 42, parentPid: 1, start: 'fixture', name: 'cosyncing.exe', executable }] });
      check('PR6B Windows process matching is case-insensitive and independent of listener discovery',
        windowsDesktopClientRunning(snapshot('C:\\SCRATCH\\CLIENT\\cosyncing.exe'), root));
      check('PR6B Windows sibling and unrecorded client paths do not block the recorded installation',
        !windowsDesktopClientRunning(snapshot('C:\\scratch\\client-other\\cosyncing.exe'), root)
          && !windowsDesktopClientRunning(snapshot('C:\\manual\\cosyncing.exe'), root));
      let unreadable = false; let unknown = false;
      try { windowsDesktopClientRunning(null, root); } catch { unreadable = true; }
      try { windowsDesktopClientRunning(snapshot(null), root); } catch { unknown = true; }
      check('PR6B Windows unavailable process evidence fails closed before mutation', unreadable && unknown);
    }
    {
      let valid = true;
      try { validateDesktopZip(Buffer.from(zipFixtures.safe, 'base64'), 'macos-arm64');
        validateDesktopZip(Buffer.from(zipFixtures.plain, 'base64'), 'windows-x64'); } catch { valid = false; }
      check('PR6B ZIP metadata permits ordinary files and internal macOS framework link chains', valid);
      for (const name of ['parent_path', 'absolute_path', 'alternate_stream', 'external_link',
        'cyclic_links', 'duplicate_path', 'special_file', 'expanded_limit'] as const) {
        let rejected = false;
        try { validateDesktopZip(Buffer.from(zipFixtures[name], 'base64'), 'macos-arm64'); }
        catch (error) { rejected = (error as Error).message.startsWith('desktop-client-'); }
        check(`PR6B ZIP metadata rejects ${name} before native extraction`, rejected);
      }
      let rejected = false;
      try { validateDesktopZip(Buffer.from(zipFixtures.safe, 'base64'), 'windows-x64'); }
      catch (error) { rejected = (error as Error).message === 'desktop-client-archive-type-unsafe'; }
      check('PR6B Windows ZIP rejects Unix links before extraction', rejected);
    }
    {
      const f = fixture(); let lockCalls = 0;
      const refused = await runUpgrade({ ...f.options, desktop: { isRunning: () => true },
        acquireLock: () => { lockCalls++; throw new Error('running-client guard did not run first'); } });
      check('PR6B running recorded client refuses before lock, download, journal recovery or service mutation',
        refused.detailCode === 'desktop-client-running' && /quit it.*cosy update again/.test(refused.summary)
          && lockCalls === 0 && f.events.length === 0 && oldClientPreserved(f)
          && readFileSync(f.binary, 'utf8') === 'desktop-fixture-broker-v1');
    }
    {
      const f = fixture(); rmSync(f.receiptPath); let processChecks = 0;
      const upgraded = await runUpgrade({ ...f.options, desktop: { isRunning: () => { processChecks++; return false; } } });
      check('PR6B unrecorded client is neither adopted, queried nor downloaded',
        upgraded.status === 'complete' && upgraded.desktopClient?.detailCode === 'desktop-client-legacy-version-unreadable'
          && processChecks === 0 && !f.events.includes('client-download')
          && !existsSync(f.receiptPath) && readFileSync(f.executable, 'utf8') === 'desktop-fixture-client-v1');
    }
    if (host !== 'macos-arm64') {
      {
        const f = fixture(); makeLegacy(f);
        let receiptAtDownload = false;
        const fetcher = f.options.fetch!;
        const upgraded = await runUpgrade({ ...f.options, fetch: (async (input, init) => {
          if (String(input).endsWith('client.archive')) receiptAtDownload = existsSync(f.receiptPath);
          return fetcher(input, init);
        }) as typeof fetch });
        check('PR6B legacy exact-destination owned client with public Linux version metadata is adopted only after signed swap',
          upgraded.status === 'complete' && upgraded.desktopClient?.status === 'updated'
            && !receiptAtDownload && readFileSync(f.executable, 'utf8') === newClient
            && readFileSync(f.receiptPath, 'utf8').includes('version=2.0.0')
            && readFileSync(f.binary).equals(candidateBroker)
            && (process.platform === 'win32' || (lstatSync(f.path).mode & 0o077) === 0));
      }
      {
        const f = fixture(); makeLegacy(f, '3.0.0');
        const upgraded = await runUpgrade(f.options);
        check('PR6B newer legacy client is never adopted or downgraded',
          upgraded.status === 'complete' && upgraded.desktopClient?.detailCode === 'desktop-client-legacy-newer'
            && !f.events.includes('client-download') && !existsSync(f.receiptPath)
            && readFileSync(f.executable, 'utf8') === 'desktop-fixture-client-v1');
      }
      {
        const f = fixture(); const versionPath = makeLegacy(f); writeFileSync(versionPath, '{not-json');
        const upgraded = await runUpgrade(f.options);
        check('PR6B unreadable legacy version skips adoption and gives the installer remedy',
          upgraded.status === 'complete' && upgraded.desktopClient?.detailCode === 'desktop-client-legacy-version-unreadable'
            && !f.events.includes('client-download') && !existsSync(f.receiptPath)
            && /no readable Flutter version metadata.*Rerun the signed all-in-one installer/.test(upgraded.summary));
      }
      {
        const f = fixture(); makeLegacy(f, '0.6.4', 'another_app');
        const upgraded = await runUpgrade(f.options);
        check('PR6B legacy metadata naming another app is never adopted',
          upgraded.desktopClient?.detailCode === 'desktop-client-legacy-identity-invalid'
            && !f.events.includes('client-download') && !existsSync(f.receiptPath));
      }
      {
        const f = fixture(); makeLegacy(f);
        const outside = join(f.root, 'manually-copied-client'); renameSync(f.path, outside);
        let rejected = false;
        try { inspectLegacyDesktopClient({ home: f.home, env: f.env }, outside); }
        catch (error) { rejected = (error as Error).message === 'desktop-client-path-unsafe'; }
        const upgraded = await runUpgrade(f.options);
        check('PR6B a legacy client outside the exact installer destination is never adopted',
          rejected && upgraded.status === 'complete' && !f.events.includes('client-download')
            && !existsSync(f.receiptPath)
            && readFileSync(desktopClientExecutable({ host, path: outside }), 'utf8') === 'desktop-fixture-client-v1');
      }
      {
        const f = fixture(); makeLegacy(f); let writes = 0;
        const upgraded = await runUpgrade({ ...f.options, desktop: { isRunning: () => false,
          writeReceipt: (path, bytes) => { atomicWriteOwnerOnly(path, bytes); writes++; throw new Error('fixture-legacy-receipt-failed'); } } });
        check('PR6B legacy receipt-commit failure restores the old client and leaves no adoption record',
          upgraded.status === 'complete' && upgraded.desktopClient?.status === 'failed' && writes === 1
            && readFileSync(f.executable, 'utf8') === 'desktop-fixture-client-v1'
            && !existsSync(f.receiptPath) && readFileSync(f.binary).equals(candidateBroker));
      }
    }
    {
      const f = fixture(); const upgraded = await runUpgrade(f.options);
      check('PR6B signed client download and swap occur only after healthy committed broker',
        upgraded.status === 'complete' && upgraded.desktopClient?.status === 'updated'
          && f.events.indexOf('health') < f.events.indexOf('client-download')
          && readFileSync(f.binary).equals(candidateBroker) && readFileSync(f.executable, 'utf8') === newClient
          && readFileSync(f.receiptPath, 'utf8').includes(`sha256=${f.row.sha256}`)
          && readFileSync(f.receiptPath, 'utf8').includes('version=2.0.0')
          && (process.platform === 'win32' || (lstatSync(f.executable).mode & 0o100) !== 0)
          && !existsSync(join(f.home, 'upgrade-journal.json')),
        JSON.stringify(upgraded));
    }
    {
      const f = fixture(); rmSync(f.path, { recursive: true });
      const upgraded = await runUpgrade(f.options);
      check('PR6B missing recorded client skips desktop and still updates the broker',
        upgraded.status === 'complete' && upgraded.desktopClient?.status === 'skipped'
          && upgraded.desktopClient.detailCode === 'desktop-client-missing'
          && readFileSync(f.binary).equals(candidateBroker) && !existsSync(f.path)
          && !f.events.includes('client-download') && readFileSync(f.receiptPath).equals(f.recordBefore)
          && /installation is missing.*If you removed it on purpose, delete client-receipt\./.test(upgraded.summary));
    }
    {
      const f = fixture(); atomicWriteOwnerOnly(f.receiptPath, 'not-a-client-record\n');
      const upgraded = await runUpgrade(f.options);
      check('PR6B invalid receipt skips desktop and still updates the broker',
        upgraded.status === 'complete' && upgraded.desktopClient?.status === 'skipped'
          && upgraded.desktopClient.detailCode === 'desktop-client-receipt-invalid'
          && readFileSync(f.binary).equals(candidateBroker) && !f.events.includes('client-download')
          && readFileSync(f.executable, 'utf8') === 'desktop-fixture-client-v1'
          && readFileSync(f.receiptPath, 'utf8') === 'not-a-client-record\n'
          && /ownership record is invalid.*Rerun the signed all-in-one installer/.test(upgraded.summary)
          && !upgraded.summary.includes('If you removed it on purpose'));
    }
    {
      const f = fixture(); const upgraded = await runUpgrade({ ...f.options,
        desktop: { isRunning: () => { throw new Error('desktop-client-process-unknown'); } } });
      check('PR6B unknown process state skips desktop and still updates the broker',
        upgraded.status === 'complete' && upgraded.desktopClient?.status === 'skipped'
          && upgraded.desktopClient.detailCode === 'desktop-client-process-unknown'
          && readFileSync(f.binary).equals(candidateBroker) && oldClientPreserved(f)
          && !f.events.includes('client-download')
          && /Close the client and run cosy update again/.test(upgraded.summary));
    }
    {
      const f = fixture(); const fetcher = f.options.fetch!;
      // Change valid archive metadata, preserving length and extractability. Without the digest guard
      // this substituted archive really installs v2 rather than failing in the decompressor.
      const changed = Buffer.from(f.bytes); const metadataOffset = host === 'linux-x64' ? 4 : 10;
      changed[metadataOffset] = changed[metadataOffset]! ^ 1;
      const upgraded = await runUpgrade({ ...f.options, fetch: (async (input, init) =>
        String(input).endsWith('client.archive') ? new Response(changed) : fetcher(input, init)) as typeof fetch });
      check('PR6B digest mismatch keeps old client and receipt while broker stays updated',
        upgraded.status === 'complete' && upgraded.desktopClient?.detailCode === 'desktop-client-digest-mismatch'
          && oldClientPreserved(f) && readFileSync(f.binary).equals(candidateBroker));
    }
    {
      const f = fixture();
      const upgraded = await runUpgrade({ ...f.options, desktop: { isRunning: () => false,
        rename: (from, to) => { if (to === f.path && from.includes('staging-')) throw new Error('fixture-swap-failed'); renameSync(from, to); } } });
      check('PR6B failed swap restores retired client and preserves receipt and healthy broker',
        upgraded.desktopClient?.status === 'failed' && upgraded.status === 'complete'
          && oldClientPreserved(f) && readFileSync(f.binary).equals(candidateBroker));
    }
    {
      const f = fixture(); let writes = 0;
      const upgraded = await runUpgrade({ ...f.options, desktop: { isRunning: () => false,
        writeReceipt: (path, bytes) => { atomicWriteOwnerOnly(path, bytes); if (++writes === 1) throw new Error('fixture-receipt-failed'); } } });
      check('PR6B receipt-commit failure restores both old tree and old receipt without broker rollback',
        writes === 2 && upgraded.desktopClient?.status === 'failed' && upgraded.status === 'complete'
          && oldClientPreserved(f) && readFileSync(f.binary).equals(candidateBroker));
    }
    {
      const f = fixture(); let writes = 0;
      const upgraded = await runUpgrade({ ...f.options, desktop: { isRunning: () => false,
        writeReceipt: (path, bytes) => {
          if (++writes === 1) atomicWriteOwnerOnly(path, bytes);
          throw new Error(writes === 1 ? 'fixture-record-commit-failed' : 'fixture-record-restore-failed');
        } } });
      check('PR6B receipt restoration failure preserves the old tree and names record recovery',
        writes === 2 && upgraded.status === 'complete'
          && upgraded.desktopClient?.detailCode === 'desktop-client-restore-failed'
          && readFileSync(f.executable, 'utf8') === 'desktop-fixture-client-v1'
          && readFileSync(f.receiptPath, 'utf8').includes('version=2.0.0')
          && !readdirSync(dirname(f.path)).some((name) => name.includes('retired-'))
          && /previous desktop client was restored/.test(upgraded.summary)
          && /client-receipt.*rerun the signed all-in-one installer/.test(upgraded.summary)
          && !upgraded.summary.includes('.cosyncing-client.retired-')
          && readFileSync(f.binary).equals(candidateBroker));
    }
    {
      const f = fixture(); const upgraded = await runUpgrade({ ...f.options,
        desktop: { isRunning: () => false, remove: (path) => {
          if (path.includes('retired-')) throw new Error('fixture-cleanup-failed'); rmSync(path, { recursive: true });
        } } });
      check('PR6B cleanup failure after receipt commit preserves new client and reports inert backup',
        upgraded.desktopClient?.status === 'updated' && upgraded.desktopClient.detailCode === 'desktop-client-cleanup-pending'
          && readFileSync(f.executable, 'utf8') === newClient
          && readFileSync(f.receiptPath, 'utf8').includes('version=2.0.0')
          && readdirSync(dirname(f.path)).some((name) => name.includes('retired-')));
    }
    {
      const f = fixture(); const before = readFileSync(f.binary);
      const upgraded = await runUpgrade({ ...f.options, buildInfo: { ...f.options.buildInfo, version: '2.0.0' } });
      check('PR6B current broker updates older recorded client only, without service, mod or broker acquisition',
        upgraded.detailCode === 'desktop-client-only-updated' && upgraded.desktopClient?.status === 'updated'
          && readFileSync(f.binary).equals(before) && readFileSync(f.executable, 'utf8') === newClient
          && f.events.join(',') === 'manifest,client-download,readiness,doctor',
        f.events.join(','));
    }
    {
      const f = fixture(); const rolledBack = await runUpgrade({ ...f.options,
        verifyBrokerVersion: async () => false });
      check('PR6B unhealthy broker never downloads or replaces client',
        rolledBack.status === 'rolled-back' && !f.events.includes('client-download') && oldClientPreserved(f));
    }
    {
      const f = fixture(); let probes = 0;
      const upgraded = await runUpgrade({ ...f.options, desktop: { isRunning: () => ++probes >= 4 } });
      check('PR6B client starting during update is refused again before swap and remains untouched',
        upgraded.status === 'complete' && upgraded.desktopClient?.status === 'failed'
          && upgraded.desktopClient.detailCode === 'desktop-client-running'
          && /quit it.*cosy update again/.test(upgraded.summary) && oldClientPreserved(f)
          && readFileSync(f.binary).equals(candidateBroker));
    }
    {
      const f = fixture(); const refused = await runUpgrade({ ...f.options, acquireLock: (options) => {
        atomicWriteOwnerOnly(f.receiptPath, renderDesktopClientReceipt({ ...f.receipt, version: '9.0.0' }));
        return acquireInstallationLock(options);
      } });
      check('PR6B receipt drift after preflight skips the desktop with a sentence while the broker updates',
        refused.status === 'complete' && refused.desktopClient?.status === 'skipped'
          && refused.desktopClient.detailCode === 'desktop-client-receipt-changed'
          && /ownership record changed during the update/.test(refused.summary)
          && !f.events.includes('client-download') && readFileSync(f.binary).equals(candidateBroker));
    }
    {
      const f = fixture(); atomicWriteOwnerOnly(f.executable, 'user-edited-client', { mode: 0o700 });
      const refused = await runUpgrade(f.options);
      check('PR6B changed installed executable skips the client while the broker updates',
        refused.desktopClient?.detailCode === 'desktop-client-receipt-content-mismatch'
          && refused.desktopClient.status === 'skipped' && !f.events.includes('client-download')
          && readFileSync(f.binary).equals(candidateBroker)
          && readFileSync(f.executable, 'utf8') === 'user-edited-client');
    }
    {
      const f = fixture(); const manual = join(f.root, 'manually-installed');
      atomicWriteOwnerOnly(desktopClientExecutable({ host, path: manual }), 'desktop-fixture-client-v1', { mode: 0o700 });
      atomicWriteOwnerOnly(f.receiptPath, renderDesktopClientReceipt({ ...f.receipt, path: manual }));
      const refused = await runUpgrade(f.options);
      check('PR6B receipt cannot take ownership of another application path',
        refused.desktopClient?.detailCode === 'desktop-client-receipt-invalid'
          && refused.desktopClient.status === 'skipped' && !f.events.includes('client-download')
          && readFileSync(f.binary).equals(candidateBroker)
          && readFileSync(desktopClientExecutable({ host, path: manual }), 'utf8') === 'desktop-fixture-client-v1');
    }
    {
      const f = fixture(); atomicWriteOwnerOnly(f.receiptPath,
        renderDesktopClientReceipt({ ...f.receipt, version: '2.0.0' }));
      const refused = await runUpgrade({ ...f.options, buildInfo: { ...f.options.buildInfo, version: '2.0.0' } });
      check('PR6B reused client version with different digest is refused without acquisition',
        refused.desktopClient?.detailCode === 'desktop-client-version-reused'
          && !f.events.includes('client-download') && readFileSync(f.executable, 'utf8') === 'desktop-fixture-client-v1');
    }
    {
      const f = fixture();
      const { signature, desktopClients: _clients, ...unsigned } = f.manifest;
      const legacy = { ...unsigned, signature: { ...signature,
        value: sign(null, releaseManifestSigningPayload(unsigned), privateKey).toString('base64') } };
      const fetcher = f.options.fetch!;
      const upgraded = await runUpgrade({ ...f.options, fetch: (async (input, init) =>
        String(input).endsWith('manifest.json') ? Response.json(legacy) : fetcher(input, init)) as typeof fetch });
      check('PR6B legacy manifest without desktop rows preserves recorded client and normal broker update',
        upgraded.status === 'complete' && upgraded.desktopClient?.status === 'skipped'
          && !f.events.includes('client-download') && oldClientPreserved(f));
    }
    if (host === 'windows-x64') {
      const f = fixture(); const launcher = '@echo off\r\nset "COSYNCING_HOME=fixture-custom-home"\r\n';
      atomicWriteOwnerOnly(join(f.path, 'cosyncing-launch.cmd'), launcher);
      const upgraded = await runUpgrade(f.options);
      check('PR6B Windows custom-home launcher survives replacement at the unchanged shortcut target',
        upgraded.desktopClient?.status === 'updated'
          && existsSync(join(f.path, 'cosyncing-launch.cmd'))
          && readFileSync(join(f.path, 'cosyncing-launch.cmd'), 'utf8') === launcher);
    }
    if (process.platform !== 'win32') {
      const f = fixture(); const app = join(f.root, 'Cosyncing.app');
      atomicWriteOwnerOnly(join(app, 'Contents', 'MacOS', 'Cosyncing'), 'executable', { mode: 0o700 });
      ensureOwnerOnlyDirectory(join(app, 'Contents', 'Frameworks', 'Fixture.framework', 'Versions', 'A'));
      const versions = join(app, 'Contents', 'Frameworks', 'Fixture.framework', 'Versions');
      symlinkSync('A', join(versions, 'Current'));
      symlinkSync('Versions/Current/Headers', join(dirname(versions), 'Headers'));
      let valid = true; try { validateDesktopClientTree(app, 'macos-arm64', true); } catch { valid = false; }
      check('PR6B macOS internal framework links and dangling internal header aliases remain valid', valid
        && lstatSync(join(versions, 'Current')).isSymbolicLink()
        && readlinkSync(join(versions, 'Current')) === 'A'
        && (lstatSync(join(app, 'Contents', 'MacOS', 'Cosyncing')).mode & 0o100) !== 0);
      symlinkSync(f.root, join(app, 'outside'));
      let rejected = false; try { validateDesktopClientTree(app, 'macos-arm64', true); } catch { rejected = true; }
      check('PR6B external bundle links are rejected before chmod or placement', rejected);
    }
  } finally { for (const root of roots) rmSync(root, { recursive: true, force: true }); }
}
