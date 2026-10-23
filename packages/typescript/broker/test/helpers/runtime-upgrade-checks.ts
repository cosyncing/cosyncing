import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PRODUCT_IDENTITY } from '@cosyncing/protocol';
import { BUILD_INFO } from '../../src/runtime/build-info.ts';
import {
  BUN_RELEASE_DOWNLOAD_BASE, MINIMUM_BUN_RUNTIME_VERSION, PINNED_BUN_RUNTIME_ARCHIVES, PINNED_BUN_RUNTIME_VERSION,
  bunVersionAtLeast,
} from '../../src/runtime/application-identity.ts';
import { defaultBrokerConfig, writeBrokerConfig } from '../../src/runtime/configuration.ts';
import {
  committedInstallState, inspectInstallState, writeInstallState, type InstalledResourceRecord,
} from '../../src/installation/install-state.ts';
import { writeSetupState } from '../../src/installation/setup-state.ts';
import { bunRuntimesReceipt } from '../../src/installation/bun-runtime-receipt.ts';
import {
  LaunchdUserServiceProvider, SystemdUserServiceProvider, type DurableServiceVersions,
} from '../../src/installation/service-manager.ts';
import { atomicWriteOwnerOnly, ensureOwnerOnlyDirectory, inspectOwnerOnlyFile } from '../../src/security/secure-files.ts';
import {
  RUNTIME_UPGRADE_REQUIRED_DETAIL, extractZipEntry, installBunRuntime, orderedBunRuntimeArchives,
  ownedBunRuntimePath, pinnedReleaseBunRuntime, planBunRuntimeUpgrade, pruneOwnedBunRuntimes, shellQuote,
  validReleaseBunRuntime, windowsLauncherText, type ReleaseBunRuntime,
} from '../../src/updates/bun-runtime-upgrade.ts';
import {
  checkReleaseUpdate, releaseManifestForTests, runUpgrade,
  type ReleaseJavaScriptApp, type ReleaseManifest, type ReleaseWebSidecar, type UpgradeDependencies,
  type UpgradeServiceController,
} from '../../src/updates/release-upgrade.ts';
import { bunArchiveFixture, writeZipFixture } from './zip-fixture.ts';

type Check = (name: string, ok: boolean, detail?: string) => void;
const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const rejects = async (work: () => unknown, code: string): Promise<string | true> => {
  try {
    await work();
    return 'resolved';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message === code ? true : message;
  }
};
const read = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '<missing>');

/**
 * `cosy update` installing the release's pinned Bun (defect 33), and the shared versioned runtime layout the
 * installers and the updater agree on (defect 34).
 *
 * Every runtime here is a fixture: archives are written in-process with test digests, the "Bun" inside is a
 * text file, and the probe that would spawn `--revision` reads that text instead. Nothing is downloaded,
 * and no service manager is ever called: the real systemd and launchd providers are constructed only to
 * RENDER the files setup would have written, with a runner that refuses every command.
 */
export async function runRuntimeUpgradeChecks(check: Check): Promise<void> {
  const roots: string[] = [];
  try {
    await zipChecks(check, roots);
    await planChecks(check);
    await installChecks(check, roots);
    await updateCheckChecks(check);
    if (process.platform !== 'win32') await upgradeChecks(check, roots);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}

// -------------------------------------------------------------------------------------------------------
// The archive reader
// -------------------------------------------------------------------------------------------------------

async function zipChecks(check: Check, roots: string[]): Promise<void> {
  const payload = Buffer.from('fixture-bun 1.3.20\n'.repeat(257));
  const entries = (method: 'store' | 'deflate') => [
    { name: 'bun-linux-x64/' },
    { name: 'bun-linux-x64/README', data: 'not the runtime', method },
    { name: 'bun-linux-x64/bun', data: payload, method },
  ];
  for (const method of ['store', 'deflate'] as const) {
    for (const [label, options] of [
      ['plain', {}], ['data descriptor', { dataDescriptor: true }], ['ZIP64', { zip64: true }],
      ['ZIP64 with data descriptor', { dataDescriptor: true, zip64: true }],
    ] as const) {
      const archive = writeZipFixture(entries(method), options);
      let extracted: Uint8Array | undefined;
      try { extracted = extractZipEntry(archive, 'bun-linux-x64/bun'); } catch { /* asserted below */ }
      check(`runtime archive: a ${method} entry in a ${label} zip extracts byte-exact`,
        !!extracted && Buffer.compare(Buffer.from(extracted), payload) === 0);
    }
  }
  const good = writeZipFixture(entries('deflate'));
  const outcomes = {
    crc: await rejects(() => extractZipEntry(writeZipFixture(entries('deflate'), { corruptCrcOf: 'bun-linux-x64/bun' }), 'bun-linux-x64/bun'), 'release-runtime-archive-invalid'),
    missing: await rejects(() => extractZipEntry(good, 'bun-linux-x64-baseline/bun'), 'release-runtime-archive-missing-executable'),
    encrypted: await rejects(() => extractZipEntry(writeZipFixture(entries('store'), { encrypted: true }), 'bun-linux-x64/bun'), 'release-runtime-archive-invalid'),
    truncated: await rejects(() => extractZipEntry(good.subarray(0, good.byteLength - 30), 'bun-linux-x64/bun'), 'release-runtime-archive-invalid'),
    garbage: await rejects(() => extractZipEntry(new Uint8Array(4096).fill(7), 'bun-linux-x64/bun'), 'release-runtime-archive-invalid'),
    oversized: await rejects(() => extractZipEntry(good, 'bun-linux-x64/bun', 64), 'release-runtime-archive-invalid'),
  };
  check('runtime archive: a CRC mismatch, encryption, truncation, garbage or an oversized entry is refused; a missing executable is named',
    Object.values(outcomes).every((outcome) => outcome === true), JSON.stringify(outcomes));

  // The same reader against archives a real zip tool wrote, where one exists:
  // deflated, stored, and forced ZIP64. The byte fixtures above separately cover
  // streamed data descriptors, including ZIP64 descriptors.
  const zip = process.platform === 'win32' ? null : Bun.which('zip');
  if (zip) {
    const root = mkdtempSync(join(tmpdir(), 'cosyncing-runtime-zip-'));
    roots.push(root);
    mkdirSync(join(root, 'bun-linux-x64'));
    writeFileSync(join(root, 'bun-linux-x64', 'bun'), payload, { mode: 0o755 });
    const results: Record<string, boolean> = {};
    for (const [label, args] of [['deflate', ['-q', '-r', '-X']], ['stored', ['-q', '-r', '-X', '-0']]] as const) {
      const out = join(root, `${label}.zip`);
      const made = Bun.spawnSync([zip, ...args, out, 'bun-linux-x64'], { cwd: root, stdout: 'ignore', stderr: 'pipe' });
      try {
        results[label] = made.success
          && Buffer.compare(Buffer.from(extractZipEntry(readFileSync(out), 'bun-linux-x64/bun')), payload) === 0;
      } catch { results[label] = false; }
    }
    // Write to a seekable file. Info-ZIP 3 can emit an invalid central-directory
    // offset and omit its ZIP64 end record when stdout is a non-seekable pipe.
    const zip64Path = join(root, 'zip64.zip');
    const zip64 = Bun.spawnSync([zip, '-q', '-fz', zip64Path, '-'], {
      stdin: payload, stdout: 'ignore', stderr: 'pipe',
    });
    try {
      results.zip64 = zip64.success
        && Buffer.compare(Buffer.from(extractZipEntry(readFileSync(zip64Path), '-')), payload) === 0;
    } catch { results.zip64 = false; }
    check('runtime archive: archives written by the zip tool (deflated, stored, ZIP64) read byte-exact',
      Object.values(results).every(Boolean), JSON.stringify(results));
  }
}

// -------------------------------------------------------------------------------------------------------
// Planning: who may have their runtime upgraded, and what the others are told
// -------------------------------------------------------------------------------------------------------

const RELEASE_RUNTIME_VERSION = '1.3.20';

async function planChecks(check: Check): Promise<void> {
  const releaseRuntime: ReleaseBunRuntime = {
    version: RELEASE_RUNTIME_VERSION,
    archives: { 'linux-x64': [{ asset: 'bun-linux-x64.zip', sha256: 'a'.repeat(64), size: 10 }] },
  };
  // Every raise below uses fixture floors, never the build's own: a floor this build already meets would
  // turn each of these into a check that nothing happens. Guarded so that cannot happen silently.
  check('runtime plan: the fixture floors sit above the fixture runtimes, so the raise path really runs',
    !bunVersionAtLeast('1.3.14', RELEASE_RUNTIME_VERSION) && !bunVersionAtLeast('1.3.8', PINNED_BUN_RUNTIME_VERSION),
    `${RELEASE_RUNTIME_VERSION}/${PINNED_BUN_RUNTIME_VERSION}`);
  const satisfied = planBunRuntimeUpgrade({ minimumBunVersion: '1.3.14', runtimeVersion: '1.3.14', toVersion: '2.0.0' });
  const noFloor = planBunRuntimeUpgrade({ runtimeVersion: '1.3.8', toVersion: '2.0.0' });
  check('runtime plan: a met floor, or none, needs nothing', satisfied.kind === 'satisfied' && noFloor.kind === 'satisfied');

  const install = planBunRuntimeUpgrade({
    minimumBunVersion: RELEASE_RUNTIME_VERSION, runtimeVersion: '1.3.14', runtimePath: '/srv/fixture-user/.bun/bin/bun',
    releaseRuntime, host: 'linux-x64', toVersion: '2.0.0',
  });
  check('runtime plan: an installer-owned runtime below the floor installs the release\'s own signed pins',
    install.kind === 'install' && install.version === RELEASE_RUNTIME_VERSION
      && install.archives === releaseRuntime.archives['linux-x64'], JSON.stringify(install));

  // A manifest published before releases carried `bunRuntime`: the updater's own compiled pins serve,
  // because they satisfy the floor they were compiled for.
  const compiled = planBunRuntimeUpgrade({
    minimumBunVersion: PINNED_BUN_RUNTIME_VERSION, runtimeVersion: '1.3.8', host: 'linux-x64', toVersion: '2.0.0',
  });
  // This build's OWN floor, offered to a host still on the previous one: what every bridge-release host
  // meets on its first update past it. The pinned Bun is installed rather than the update refused.
  const ownFloor = planBunRuntimeUpgrade({
    minimumBunVersion: MINIMUM_BUN_RUNTIME_VERSION, runtimeVersion: '1.3.8', host: 'linux-x64', toVersion: '2.0.0',
  });
  check('runtime plan: a host on Bun 1.3.8 offered this build\'s floor gets the pinned Bun installed',
    ownFloor.kind === 'install' && ownFloor.version === PINNED_BUN_RUNTIME_VERSION,
    JSON.stringify(ownFloor));
  check('runtime plan: without release pins, this build\'s compiled pins serve a floor they satisfy',
    compiled.kind === 'install' && compiled.version === PINNED_BUN_RUNTIME_VERSION
      && JSON.stringify(compiled.archives) === JSON.stringify(PINNED_BUN_RUNTIME_ARCHIVES['linux-x64']),
    JSON.stringify(compiled));

  const overridden = planBunRuntimeUpgrade({
    minimumBunVersion: RELEASE_RUNTIME_VERSION, runtimeVersion: '1.3.14', runtimePath: '/opt/bun/bin/bun',
    runtimeOverridden: true, releaseRuntime, host: 'linux-x64', toVersion: '2.0.0',
  });
  check('runtime plan: a COSYNCING_BUN_BIN runtime is never replaced, and the refusal says what to do',
    overridden.kind === 'refused' && overridden.detailCode === RUNTIME_UPGRADE_REQUIRED_DETAIL
      && overridden.summary.includes(`needs Bun ${RELEASE_RUNTIME_VERSION} or newer`)
      && overridden.summary.includes('Bun 1.3.14 (/opt/bun/bin/bun)')
      && overridden.summary.includes('COSYNCING_BUN_BIN')
      && overridden.summary.includes('`cosy update`')
      && overridden.summary.endsWith('Nothing was changed.'),
    overridden.kind === 'refused' ? overridden.summary : overridden.kind);

  const noHost = planBunRuntimeUpgrade({
    minimumBunVersion: RELEASE_RUNTIME_VERSION, runtimeVersion: '1.3.14', releaseRuntime, host: 'linux-arm64', toVersion: '2.0.0',
  });
  const unsupported = planBunRuntimeUpgrade({
    minimumBunVersion: RELEASE_RUNTIME_VERSION, runtimeVersion: '1.3.14', releaseRuntime, toVersion: '2.0.0',
  });
  // Release pins that do not meet the floor they travel with are not used, and older compiled pins cannot.
  const stale = planBunRuntimeUpgrade({
    minimumBunVersion: '9.9.9', runtimeVersion: '1.3.14', releaseRuntime, host: 'linux-x64', toVersion: '2.0.0',
  });
  check('runtime plan: no pinned build for this host (or none meeting the floor) is refused with install instructions',
    [noHost, unsupported, stale].every((plan) => plan.kind === 'refused' && plan.detailCode === RUNTIME_UPGRADE_REQUIRED_DETAIL
      && plan.summary.includes('https://bun.sh') && plan.summary.includes('no pinned Bun build for this host')
      && plan.summary.endsWith('Nothing was changed.'))
      && stale.kind === 'refused' && stale.summary.includes('needs Bun 9.9.9 or newer'),
    JSON.stringify([noHost, unsupported, stale]));

  const pinned = pinnedReleaseBunRuntime();
  const withExtra = { ...pinned, extra: true };
  const duplicate = { version: '1.3.20', archives: {
    'linux-x64': [{ asset: 'bun-linux-x64.zip', sha256: 'a'.repeat(64), size: 1 }],
    'linux-arm64': [{ asset: 'bun-linux-x64.zip', sha256: 'b'.repeat(64), size: 1 }],
  } };
  const badDigest = { version: '1.3.20', archives: { 'linux-x64': [{ asset: 'bun-linux-x64.zip', sha256: 'A'.repeat(64), size: 1 }] } };
  const legacyName = { version: '1.3.20', archives: { 'linux-x64': [{ name: 'bun-linux-x64.zip', sha256: 'a'.repeat(64), size: 1 }] } };
  check('runtime plan: the signed release table is exactly the compiled pins, and nothing looser parses',
    validReleaseBunRuntime(pinned) && pinned.version === PINNED_BUN_RUNTIME_VERSION
      && Object.entries(PINNED_BUN_RUNTIME_ARCHIVES).every(([host, rows]) =>
        JSON.stringify(pinned.archives[host]) === JSON.stringify(rows.map(({ asset, sha256, size }) => ({ asset, sha256, size }))))
      && Object.values(PINNED_BUN_RUNTIME_ARCHIVES).flat().every((row) => Number.isSafeInteger(row.size) && row.size > 1_000_000)
      && ![withExtra, duplicate, badDigest, legacyName].some(validReleaseBunRuntime));

  const rows = ['bun-linux-x64.zip', 'bun-linux-x64-baseline.zip', 'bun-linux-x64-musl.zip', 'bun-linux-x64-musl-baseline.zip']
    .map((asset) => ({ asset, sha256: 'a'.repeat(64), size: 1 }));
  const order = (facts: { musl?: boolean; avx2?: boolean }) => orderedBunRuntimeArchives(rows, facts).map((row) => row.asset);
  check('runtime plan: musl and pre-AVX2 hosts try their own builds first, as the installers do',
    order({ musl: false, avx2: true })[0] === 'bun-linux-x64.zip'
      && order({ musl: true, avx2: true })[0] === 'bun-linux-x64-musl.zip'
      && order({ musl: false, avx2: false })[0] === 'bun-linux-x64-baseline.zip'
      && order({ musl: true, avx2: false })[0] === 'bun-linux-x64-musl-baseline.zip'
      && order({ musl: true, avx2: false }).length === 4);

  // cmd.exe resumes a running batch file at the byte offset after the line it last ran. The rewritten shim
  // must put `@exit /b` exactly there, whatever the old first line's length in BYTES.
  const legacyRuntime = 'C:\\Users\\Zoë Åström\\.bun\\bin\\bun.exe';
  const legacy = `@"${legacyRuntime}" "%~dp0cosyncing" %*\r\n`;
  const offset = Buffer.byteLength(legacy, 'utf8');
  const next = Buffer.from(windowsLauncherText('C:\\Users\\Zoë Åström\\.cosyncing\\runtime\\bun-1.3.20\\bun.exe', offset), 'utf8');
  const unpadded = windowsLauncherText('C:\\bun.exe');
  check('runtime plan: a rewritten cosy.cmd resumes a running old shim at `@exit /b`, and refuses unquotable paths',
    next.subarray(offset).toString('utf8').startsWith('@exit /b\r\n')
      && next.toString('utf8').startsWith('@goto :run')
      && unpadded.startsWith('@goto :run\r\n@exit /b\r\n:run\r\n@"C:\\bun.exe" "%~dp0cosyncing" %* & exit /b\r\n')
      && (await rejects(() => windowsLauncherText('C:\\100%\\bun.exe'), 'launcher runtime path cannot be quoted for cmd.exe')) === true
      && (await rejects(() => windowsLauncherText('C:\\a"b\\bun.exe'), 'launcher runtime path cannot be quoted for cmd.exe')) === true);
}

// -------------------------------------------------------------------------------------------------------
// Placing a runtime
// -------------------------------------------------------------------------------------------------------

/** A fixture runtime "answers --revision" with the version written after `fixture-bun `. */
const fixtureProbe = (probed?: string[]) => (path: string): string => {
  probed?.push(path);
  const version = /^fixture-bun (\S+)/.exec(readFileSync(path, 'utf8'))?.[1];
  if (!version) throw new Error('fixture runtime does not run');
  return `${version}+fixture`;
};

async function installChecks(check: Check, roots: string[]): Promise<void> {
  const executable = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const archive = (asset: string, text: string) => bunArchiveFixture(asset, text);
  const glibc = archive('bun-linux-x64.zip', `fixture-bun ${RELEASE_RUNTIME_VERSION}\n`);
  const musl = archive('bun-linux-x64-musl.zip', 'not a runtime that runs here\n');
  const rows = [
    { asset: 'bun-linux-x64.zip', sha256: hash(glibc), size: glibc.byteLength },
    { asset: 'bun-linux-x64-musl.zip', sha256: hash(musl), size: musl.byteLength },
  ];
  const served: Record<string, Uint8Array> = { 'bun-linux-x64.zip': glibc, 'bun-linux-x64-musl.zip': musl };
  const fresh = () => {
    const root = mkdtempSync(join(tmpdir(), 'cosyncing-runtime-install-'));
    roots.push(root);
    const home = join(root, '.cosyncing');
    ensureOwnerOnlyDirectory(home);
    const downloads: Array<{ url: string; maximum: number }> = [];
    const download = (bytes?: (asset: string) => Uint8Array) => async (url: string, maximum: number) => {
      downloads.push({ url, maximum });
      const asset = url.slice(url.lastIndexOf('/') + 1);
      return bytes ? bytes(asset) : served[asset]!;
    };
    return { home, downloads, download, target: ownedBunRuntimePath(home, RELEASE_RUNTIME_VERSION) };
  };
  const runtimeEntries = (home: string) => {
    try { return readdirSync(join(home, 'runtime')).sort(); } catch { return []; }
  };

  {
    // musl first on a musl host; its build does not run here, so the next pinned build is tried.
    const f = fresh();
    const probed: string[] = [];
    const installed = await installBunRuntime({
      home: f.home, version: RELEASE_RUNTIME_VERSION, archives: rows, download: f.download(), probe: fixtureProbe(probed),
      facts: { musl: true },
    });
    check('runtime install: a verified build that does not run moves to the next pinned build, and lands versioned',
      installed.installed && installed.path === f.target
        && read(f.target) === `fixture-bun ${RELEASE_RUNTIME_VERSION}\n`
        && f.downloads.map((entry) => entry.url).join(' ') === [
          `${BUN_RELEASE_DOWNLOAD_BASE}/bun-v${RELEASE_RUNTIME_VERSION}/bun-linux-x64-musl.zip`,
          `${BUN_RELEASE_DOWNLOAD_BASE}/bun-v${RELEASE_RUNTIME_VERSION}/bun-linux-x64.zip`,
        ].join(' ')
        && f.downloads[0]!.maximum === musl.byteLength && f.downloads[1]!.maximum === glibc.byteLength
        && JSON.stringify(runtimeEntries(f.home)) === JSON.stringify([`bun-${RELEASE_RUNTIME_VERSION}`])
        && inspectOwnerOnlyFile(f.target).status === 'ok'
        && (process.platform === 'win32' || (statSync(f.target).mode & 0o777) === 0o700),
      JSON.stringify({ installed, downloads: f.downloads, entries: runtimeEntries(f.home) }));

    const again = await installBunRuntime({
      home: f.home, version: RELEASE_RUNTIME_VERSION, archives: rows, download: f.download(), probe: fixtureProbe(),
    });
    check('runtime install: a runtime already in place that answers with the pinned version is reused, not fetched',
      !again.installed && again.path === f.target && f.downloads.length === 2);
  }

  {
    // Debris from an interrupted run at the destination: replaced. The SAME debris as the runtime this
    // process is executing from: never touched.
    const f = fresh();
    ensureOwnerOnlyDirectory(join(f.home, 'runtime'));
    ensureOwnerOnlyDirectory(dirname(f.target));
    atomicWriteOwnerOnly(f.target, 'half-written', { mode: 0o700 });
    const inUse = await rejects(() => installBunRuntime({
      home: f.home, version: RELEASE_RUNTIME_VERSION, archives: rows, download: f.download(), probe: fixtureProbe(),
      currentRuntimePath: f.target,
    }), 'release-runtime-target-in-use');
    const keptInUse = read(f.target) === 'half-written';
    const replaced = await installBunRuntime({
      home: f.home, version: RELEASE_RUNTIME_VERSION, archives: rows, download: f.download(), probe: fixtureProbe(),
      facts: { musl: false },
    });
    check('runtime install: debris at the destination is replaced, but never the runtime in use',
      inUse === true && keptInUse && replaced.installed && read(f.target) === `fixture-bun ${RELEASE_RUNTIME_VERSION}\n`,
      String(inUse));
  }

  {
    // Different bytes are substitution, not a wrong build: fatal at the first archive, before extraction.
    const outcomes: Record<string, unknown> = {};
    for (const [label, code, bytes] of [
      ['size', 'release-runtime-size-mismatch', (asset: string) => served[asset]!.subarray(0, served[asset]!.byteLength - 1)],
      ['digest', 'release-runtime-checksum-mismatch', (asset: string) => {
        const copy = Uint8Array.from(served[asset]!);
        copy[copy.byteLength - 40] = copy[copy.byteLength - 40]! ^ 0xff;
        return copy;
      }],
    ] as const) {
      const f = fresh();
      const probed: string[] = [];
      const refused = await rejects(() => installBunRuntime({
        home: f.home, version: RELEASE_RUNTIME_VERSION, archives: rows, download: f.download(bytes), probe: fixtureProbe(probed),
        facts: { musl: false },
      }), code);
      outcomes[label] = refused === true && f.downloads.length === 1 && probed.length === 0
        && runtimeEntries(f.home).length === 0 ? true : { refused, downloads: f.downloads.length, entries: runtimeEntries(f.home) };
    }
    check('runtime install: a size or digest mismatch is refused before extraction and leaves nothing behind',
      Object.values(outcomes).every((outcome) => outcome === true), JSON.stringify(outcomes));
  }

  {
    const f = fresh();
    const unrunnable = await rejects(() => installBunRuntime({
      home: f.home, version: RELEASE_RUNTIME_VERSION, archives: rows, download: f.download(), probe: () => { throw new Error('exec format error'); },
    }), 'release-runtime-unrunnable');
    const wrongFolder = writeZipFixture([{ name: `elsewhere/${executable}`, data: 'fixture-bun 1.3.20\n' }]);
    const g = fresh();
    const missing = await rejects(() => installBunRuntime({
      home: g.home, version: RELEASE_RUNTIME_VERSION,
      archives: [{ asset: 'bun-linux-x64.zip', sha256: hash(wrongFolder), size: wrongFolder.byteLength }],
      download: g.download(() => wrongFolder), probe: fixtureProbe(),
    }), 'release-runtime-archive-missing-executable');
    check('runtime install: no runnable build, or an archive without the executable, fails with nothing installed',
      unrunnable === true && missing === true && runtimeEntries(f.home).length === 0 && runtimeEntries(g.home).length === 0,
      JSON.stringify({ unrunnable, missing, f: runtimeEntries(f.home), g: runtimeEntries(g.home) }));
  }

  {
    const f = fresh();
    const keep = ['1.3.14', '1.3.20'].map((version) => ownedBunRuntimePath(f.home, version));
    for (const name of ['bun-1.3.9', 'bun-1.3.14', 'bun-1.3.20', '.bun-1.3.20.staging.k3Jd9q', '.bun-1.3.20.staging-41-a1b2c3', 'notes']) {
      ensureOwnerOnlyDirectory(join(f.home, 'runtime', name));
      atomicWriteOwnerOnly(join(f.home, 'runtime', name, executable), name, { mode: 0o700 });
    }
    const legacy = join(dirname(f.home), '.bun', 'bin', executable);
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, 'operator bun');
    pruneOwnedBunRuntimes(f.home, [...keep, legacy]);
    check('runtime prune: only versioned runtimes and staging debris go; the kept pair, the old layout and anything else stay',
      JSON.stringify(runtimeEntries(f.home)) === JSON.stringify(['bun-1.3.14', 'bun-1.3.20', 'notes'])
        && read(legacy) === 'operator bun',
      JSON.stringify(runtimeEntries(f.home)));
  }
}

// -------------------------------------------------------------------------------------------------------
// Signed manifests
// -------------------------------------------------------------------------------------------------------

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const keyId = 'runtime-upgrade-fixture';
const trustedKeys = { [keyId]: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
const jsBundle = Buffer.from('#!/usr/bin/env bun\n// runtime-upgrade candidate v2\n');
const oldBundle = Buffer.from('#!/usr/bin/env bun\n// runtime-upgrade installed v1\n');
const RUNTIME_ASSET = 'bun-linux-x64.zip';
const runtimeZip = bunArchiveFixture(RUNTIME_ASSET, `fixture-bun ${RELEASE_RUNTIME_VERSION}\n`, 'linux');
const releaseRuntimeFixture = (archives?: ReleaseBunRuntime['archives']): ReleaseBunRuntime => ({
  version: RELEASE_RUNTIME_VERSION,
  archives: archives ?? { 'linux-x64': [{ asset: RUNTIME_ASSET, sha256: hash(runtimeZip), size: runtimeZip.byteLength }] },
});
const jsBuild = {
  ...BUILD_INFO,
  version: '1.0.0',
  commit: '1111111',
  buildDate: '2026-07-17T00:00:00.000Z',
  target: 'universal',
  distribution: 'bootstrap-js' as const,
  packaged: true,
  dirty: false,
};
const selfCheck = JSON.stringify({
  version: '2.0.0', commit: '2222222', buildDate: '2026-07-17T12:00:00.000Z',
  target: 'universal', distribution: 'bootstrap-js', packaged: true, dirty: false,
});

function manifestFor(options: {
  minimumBunVersion?: string;
  bunRuntime?: ReleaseBunRuntime | null;
  webApp?: ReleaseWebSidecar;
  /** Defaults to the release one above this build; pass this build's own pair for an answer about the release it is on. */
  version?: string;
  sourceCommit?: string;
}): ReleaseManifest {
  const jsApp: ReleaseJavaScriptApp = {
    name: 'cosyncing-app.js',
    target: 'universal',
    size: jsBundle.byteLength,
    sha256: hash(jsBundle),
    url: 'https://releases.example/cosyncing-app.js',
    provenanceUrl: 'https://releases.example/cosyncing-app.js.intoto.jsonl',
    minimumBunVersion: options.minimumBunVersion ?? RELEASE_RUNTIME_VERSION,
    ...(options.bunRuntime === null ? {} : { bunRuntime: options.bunRuntime ?? releaseRuntimeFixture() }),
  };
  return releaseManifestForTests({
    version: options.version ?? '2.0.0', sourceCommit: options.sourceCommit ?? '2222222', publishedAt: '2026-07-17T12:00:00.000Z', keyId,
    contract: { revision: 1, minimumClientRevision: 1, surfaceHash: 'fnv1a32:00000000' },
    webApp: options.webApp ?? {
      name: 'cosyncing-web-app.tar.gz', mount: '/cosy/', size: 1, sha256: '1'.repeat(64),
      url: 'https://releases.example/cosyncing-web-app.tar.gz', buildId: '0'.repeat(16),
      cacheManifestSha256: '2'.repeat(64), mainDartSha256: '3'.repeat(64), directorySha256: '4'.repeat(64), fileCount: 2,
    },
    jsApp,
    sign: (payload) => sign(null, payload, privateKey),
  });
}

function manifestFetch(manifest: ReleaseManifest, files: (url: string) => Uint8Array = () => jsBundle) {
  const urls: string[] = [];
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = String(input);
    urls.push(url);
    const bytes = url.endsWith('manifest.json') ? Buffer.from(JSON.stringify(manifest)) : files(url);
    return new Response(Buffer.from(bytes), { status: 200, headers: { 'content-length': String(bytes.byteLength) } });
  }) as typeof globalThis.fetch;
  return { fetch, urls };
}

// -------------------------------------------------------------------------------------------------------
// The update check
// -------------------------------------------------------------------------------------------------------

async function updateCheckChecks(check: Check): Promise<void> {
  const base = (manifest: ReleaseManifest) => ({
    buildInfo: jsBuild,
    manifestUrl: 'https://releases.example/manifest.json',
    trustedKeys,
    fetch: manifestFetch(manifest).fetch,
    now: () => new Date('2026-10-14T00:00:00.000Z'),
    runtimeVersion: '1.3.14',
    runtimePath: '/srv/fixture-user/.cosyncing/runtime/bun-1.3.14/bun',
    runtimeHost: 'linux-x64',
  });
  const manifest = manifestFor({});
  const owned = await checkReleaseUpdate(base(manifest));
  check('update check: a release above this Bun is an ordinary update where `cosy update` installs the pinned Bun',
    owned.status === 'update-available' && owned.detailCode === 'release-update-available' && owned.latestVersion === '2.0.0',
    JSON.stringify(owned));

  const pinned = await checkReleaseUpdate({ ...base(manifest), runtimeOverridden: true });
  const noBuild = await checkReleaseUpdate({ ...base(manifest), runtimeHost: 'linux-arm64' });
  check('update check: where this install cannot move its own Bun, it reports that state, not "update available"',
    [pinned, noBuild].every((result) => result.status === 'unknown'
      && result.detailCode === RUNTIME_UPGRADE_REQUIRED_DETAIL
      && result.latestVersion === '2.0.0' && result.publishedAt === '2026-07-17T12:00:00.000Z'),
    JSON.stringify([pinned, noBuild]));

  const met = await checkReleaseUpdate({ ...base(manifest), runtimeOverridden: true, runtimeVersion: '1.3.21' });
  check('update check: an operator-pinned Bun that already meets the floor sees a normal update',
    met.status === 'update-available', JSON.stringify(met));

  const npmFetch = manifestFetch(manifest);
  const npm = await checkReleaseUpdate({
    ...base(manifest), fetch: npmFetch.fetch, buildInfo: { ...jsBuild, distribution: 'bun-js' as const },
  });
  check('update check: the npm distribution keeps its package-manager answer and never fetches the channel',
    npm.status === 'unknown' && npm.detailCode === 'upgrade-package-manager-owned' && npmFetch.urls.length === 0,
    JSON.stringify(npm));
}

// -------------------------------------------------------------------------------------------------------
// The whole transaction
// -------------------------------------------------------------------------------------------------------

type Backend = 'systemd' | 'launchd' | 'none';

async function upgradeChecks(check: Check, roots: string[]): Promise<void> {
  if (!Bun.which('tar')) return;
  const webSource = mkdtempSync(join(tmpdir(), 'cosyncing-runtime-web-'));
  roots.push(webSource);
  mkdirSync(join(webSource, 'app', 'assets'), { recursive: true });
  writeFileSync(join(webSource, 'app', 'index.html'), '<html><base href="/cosy/"></html>\n');
  writeFileSync(join(webSource, 'app', 'assets', 'FontManifest.json'), '[]\n');
  const packed = Bun.spawnSync(['tar', '-czf', join(webSource, 'app.tar.gz'), '-C', webSource, 'app'], { stdout: 'ignore', stderr: 'pipe' });
  if (!packed.success) throw new Error(`web sidecar fixture could not be packed: ${packed.stderr.toString()}`);
  const sidecar = Buffer.from(readFileSync(join(webSource, 'app.tar.gz')));
  const webApp: ReleaseWebSidecar = {
    name: 'cosyncing-web-app.tar.gz', mount: '/cosy/', size: sidecar.byteLength, sha256: hash(sidecar),
    url: 'https://releases.example/cosyncing-web-app.tar.gz', buildId: '0'.repeat(16),
    cacheManifestSha256: '2'.repeat(64), mainDartSha256: '3'.repeat(64), directorySha256: '4'.repeat(64), fileCount: 2,
  };
  const releaseFiles = (runtimeBytes: Uint8Array = runtimeZip) => (url: string): Uint8Array => {
    if (url.startsWith(`${BUN_RELEASE_DOWNLOAD_BASE}/`)) return runtimeBytes;
    if (url.endsWith('.tar.gz')) return sidecar;
    return jsBundle;
  };

  const provider = (backend: Exclude<Backend, 'none'>, f: { userHome: string; home: string; cache: string; binary: string }, runtime: string, webDir: string) => {
    const common = {
      context: { env: {}, platform: process.platform, resolveExecutable: () => undefined } as never,
      homeDir: f.userHome,
      stateHome: f.home,
      cacheRoot: f.cache,
      executablePath: f.binary,
      distribution: 'bootstrap-js' as const,
      runtimePath: runtime,
      webDir,
      agentExecutableDirectories: [join(f.userHome, 'agents', 'bin')],
      runner: { run: async () => { throw new Error('fixture: no service manager command may run'); } },
    };
    return backend === 'systemd'
      ? new SystemdUserServiceProvider({
        ...common, configHome: join(f.userHome, '.config'), systemctlPath: '/usr/bin/systemctl',
        journalctlPath: '/usr/bin/journalctl', loginctlPath: '/usr/bin/loginctl', userIdentifier: '1000',
      })
      : new LaunchdUserServiceProvider({
        ...common, launchAgentsHome: join(f.userHome, 'Library', 'LaunchAgents'), launchctlPath: '/bin/launchctl',
        tailPath: '/usr/bin/tail', userIdentifier: '501',
      });
  };

  const fixture = (options: { backend: Backend; layout: 'legacy' | 'owned'; versions?: DurableServiceVersions }) => {
    const root = mkdtempSync(join(tmpdir(), 'cosyncing-runtime-upgrade-'));
    roots.push(root);
    const userHome = join(root, 'user');
    const home = join(userHome, '.cosyncing');
    const cache = join(userHome, '.cache', 'cosyncing');
    ensureOwnerOnlyDirectory(home);
    ensureOwnerOnlyDirectory(cache);
    writeBrokerConfig(defaultBrokerConfig(), home);
    writeSetupState({ serviceChoice: options.backend === 'none' ? 'foreground' : options.backend }, home);
    // The runtime the install runs today: Bun's own prefix (what the installers used to write), or the
    // versioned layout an earlier update or installer created.
    const oldRuntime = options.layout === 'legacy'
      ? join(userHome, '.bun', 'bin', 'bun')
      : ownedBunRuntimePath(home, '1.3.14');
    if (options.layout === 'legacy') {
      mkdirSync(dirname(oldRuntime), { recursive: true });
      writeFileSync(oldRuntime, 'fixture-bun 1.3.14\n');
      chmodSync(oldRuntime, 0o755);
    } else {
      ensureOwnerOnlyDirectory(join(home, 'runtime'));
      ensureOwnerOnlyDirectory(dirname(oldRuntime));
      atomicWriteOwnerOnly(oldRuntime, 'fixture-bun 1.3.14\n', { mode: 0o700 });
    }
    // An owned runtime nothing uses any more, and staging debris: what a committed update may prune.
    const stale = ownedBunRuntimePath(home, '1.3.9');
    ensureOwnerOnlyDirectory(join(home, 'runtime'));
    ensureOwnerOnlyDirectory(dirname(stale));
    atomicWriteOwnerOnly(stale, 'fixture-bun 1.3.9\n', { mode: 0o700 });
    const debris = join(home, 'runtime', `.bun-${RELEASE_RUNTIME_VERSION}.staging.k3Jd9q`);
    ensureOwnerOnlyDirectory(debris);

    const binary = join(home, 'bin', PRODUCT_IDENTITY.primaryBinary);
    ensureOwnerOnlyDirectory(dirname(binary));
    atomicWriteOwnerOnly(binary, oldBundle, { mode: 0o700 });
    const oldWeb = join(home, 'bin', 'cosyncing-web-1.0.0');
    ensureOwnerOnlyDirectory(oldWeb);
    atomicWriteOwnerOnly(join(oldWeb, 'index.html'), '<html>v1</html>');
    const resources: InstalledResourceRecord[] = [{
      id: 'broker-binary', kind: 'binary', target: binary, ownership: { proof: 'package-hash', installedSha256: hash(oldBundle) },
    }];
    const serviceFiles: string[] = [];
    if (options.backend !== 'none') {
      const rendered = provider(options.backend, { userHome, home, cache, binary }, oldRuntime, oldWeb);
      for (const [id, kind, path, text] of [
        [options.backend === 'systemd' ? 'service-systemd' : 'service-launchd', 'service', rendered.definitionPath, rendered.expectedDefinition()],
        ['service-environment', 'environment-file', rendered.environmentPath, rendered.expectedEnvironment()],
      ] as const) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        atomicWriteOwnerOnly(path, text);
        serviceFiles.push(path);
        resources.push({ id, kind, target: path, ownership: { proof: 'package-hash', installedSha256: hash(text) } });
      }
    }
    const state = committedInstallState('2026-10-01T00:00:00.000Z');
    state.resources = resources;
    writeInstallState(state, home);

    const launcherText = (runtime: string) => [
      '#!/bin/sh',
      '# cosyncing command launcher v1',
      'if [ -z "${COSYNCING_HOME:-}" ]; then',
      `  export COSYNCING_HOME=${shellQuote(home)}`,
      'fi',
      `exec ${shellQuote(runtime)} ${shellQuote(binary)} "$@"`,
      '',
    ].join('\n');
    const launchers = ['cosyncing', 'cosy'].map((name) => join(home, 'shell-bin', name));
    ensureOwnerOnlyDirectory(join(home, 'shell-bin'));
    for (const path of launchers) atomicWriteOwnerOnly(path, launcherText(oldRuntime), { mode: 0o700 });
    // An operator's own wrapper in the same directory is never the installer's to rewrite.
    const foreign = join(home, 'shell-bin', 'my-wrapper');
    atomicWriteOwnerOnly(foreign, `#!/bin/sh\nexec ${shellQuote(oldRuntime)} "$@"\n`, { mode: 0o700 });

    const receiptPath = join(home, 'bootstrap-receipt');
    const receipt = (version: string, runtime: string, sha: string) => [
      'schemaVersion=2', `product=${PRODUCT_IDENTITY.productName}`, `version=${version}`, 'target=universal',
      'distribution=bootstrap-js', 'host=linux-x64', `application=${binary}`,
      `webRoot=${join(home, 'bin', `cosyncing-web-${version}`)}`, `runtime=${runtime}`, `sha256=${sha}`, '',
    ].join('\n');
    atomicWriteOwnerOnly(receiptPath, receipt('1.0.0', oldRuntime, hash(oldBundle)), { mode: 0o600 });

    let active = true;
    const calls: string[] = [];
    const service: UpgradeServiceController = {
      async inspect() { return { active }; },
      async stop() { calls.push('stop'); active = false; },
      async start() { calls.push('start'); active = true; },
      async reloadDefinition() { calls.push('reload'); },
      ...(options.versions ? { versions: options.versions } : {}),
    };
    const launches: Array<{ executable: string; args: readonly string[] }> = [];
    const snapshot = () => [binary, ...serviceFiles, ...launchers, foreign, receiptPath, oldRuntime].map(read);
    return {
      root, userHome, home, cache, binary, oldRuntime, oldWeb, stale, debris, serviceFiles, launchers, foreign, receiptPath,
      calls, launches, active: () => active, snapshot, launcherText, receipt,
      newRuntime: ownedBunRuntimePath(home, RELEASE_RUNTIME_VERSION),
      newWeb: join(home, 'bin', 'cosyncing-web-2.0.0'),
      backend: options.backend,
      rendered: (runtime: string, webDir: string) => {
        if (options.backend === 'none') return [];
        const next = provider(options.backend, { userHome, home, cache, binary }, runtime, webDir);
        return [next.expectedDefinition(), next.expectedEnvironment()];
      },
      service,
    };
  };
  type Fixture = ReturnType<typeof fixture>;
  const dependencies = (f: Fixture, manifest: ReleaseManifest, runtimeBytes?: Uint8Array): UpgradeDependencies & { urls: string[] } => {
    const served = manifestFetch(manifest, releaseFiles(runtimeBytes));
    return {
      urls: served.urls,
      home: f.home,
      cacheRoot: f.cache,
      buildInfo: jsBuild,
      executablePath: f.binary,
      runtimePath: f.oldRuntime,
      runtimeVersion: '1.3.14',
      runtimeProbe: fixtureProbe(),
      runtimeFacts: { musl: false, avx2: true },
      manifestUrl: 'https://releases.example/manifest.json',
      trustedKeys,
      fetch: served.fetch,
      runBinary: async (executable, args) => {
        f.launches.push({ executable, args });
        return { status: 'ok', exitCode: 0, stdout: selfCheck, stderr: '' };
      },
      service: f.service,
      verifyBrokerVersion: async () => true,
      verifyWebVersion: async () => true,
      healthAttempts: 1,
      sleep: async () => undefined,
      env: { HOME: f.userHome, PATH: '/usr/bin:/bin' },
    };
  };
  const resource = (f: Fixture, id: string) => {
    const install = inspectInstallState(f.home);
    return install.committed ? install.state.resources.find((entry) => entry.id === id) : undefined;
  };
  const runtimeEntries = (f: Fixture) => {
    try { return readdirSync(join(f.home, 'runtime')).sort(); } catch { return []; }
  };
  const manifest = manifestFor({ webApp });
  const runtimeUrl = `${BUN_RELEASE_DOWNLOAD_BASE}/bun-v${RELEASE_RUNTIME_VERSION}/${RUNTIME_ASSET}`;

  // ---- The update that moves the runtime, from the old unversioned layout and from the versioned one.
  for (const [backend, layout] of [['systemd', 'legacy'], ['launchd', 'legacy'], ['systemd', 'owned']] as const) {
    // The versioned-layout run is also the run told which release to install, so the pin is honoured
    // by a real transaction rather than by a fixture of its own. The two runs above keep the
    // historical meaning of `cosy upgrade`: install whatever the channel serves.
    const pinnedReleaseId = layout === 'owned' ? 'rel-2.0.0+2222222' : undefined;
    const label = `${backend}, ${layout === 'legacy' ? 'old ~/.bun layout' : 'versioned layout'}${pinnedReleaseId ? ', pinned' : ''}`;
    const f = fixture({ backend, layout });
    const before = f.snapshot();
    const options = { ...dependencies(f, manifest), ...(pinnedReleaseId ? { pinnedReleaseId } : {}) };
    const upgraded = await runUpgrade(options);
    const [definition, environment] = f.rendered(f.newRuntime, f.newWeb);
    const definitionId = backend === 'systemd' ? 'service-systemd' : 'service-launchd';
    const launches = f.launches.map((entry) => entry.executable);
    check(`runtime upgrade (${label}): the update completes on the pinned Bun it installed`,
      upgraded.exitCode === 0 && upgraded.detailCode === 'upgrade-complete'
        && read(f.binary) === jsBundle.toString()
        && read(f.newRuntime) === `fixture-bun ${RELEASE_RUNTIME_VERSION}\n`
        && inspectOwnerOnlyFile(f.newRuntime).status === 'ok'
        && options.urls.includes(runtimeUrl)
        && !existsSync(join(f.home, 'upgrade-journal.json')),
      `${upgraded.exitCode}/${upgraded.detailCode}: ${upgraded.summary}`);
    check(`runtime upgrade (${label}): the previous runtime is kept byte-identical for rollback`,
      read(f.oldRuntime) === before[before.length - 1] && read(f.oldRuntime) === 'fixture-bun 1.3.14\n');
    check(`runtime upgrade (${label}): the service definition and environment are exactly what setup renders for the new runtime`,
      read(f.serviceFiles[0]!) === definition && read(f.serviceFiles[1]!) === environment
        && resource(f, definitionId)?.ownership.installedSha256 === hash(definition!)
        && resource(f, 'service-environment')?.ownership.installedSha256 === hash(environment!)
        && f.calls.filter((call) => call === 'reload').length === 1
        && f.calls.join(',') === 'stop,reload,start',
      `${f.calls.join(',')}\n--- have\n${read(f.serviceFiles[0]!)}\n--- want\n${definition}`);
    check(`runtime upgrade (${label}): the shell launchers and the installer receipt move to the new runtime; a foreign wrapper does not`,
      f.launchers.every((path) => read(path) === f.launcherText(f.newRuntime))
        && read(f.receiptPath) === f.receipt('2.0.0', f.newRuntime, hash(jsBundle))
        && read(f.foreign) === before[before.length - 3],
      read(f.launchers[0]!));
    check(`runtime upgrade (${label}): the candidate was self-checked, and its mod refresh run, under the NEW runtime`,
      launches.length >= 2 && launches.every((executable) => executable === f.newRuntime)
        && f.launches[0]!.args[1] === 'version',
      JSON.stringify(f.launches));
    const keptOwned = layout === 'owned' ? ['bun-1.3.14', `bun-${RELEASE_RUNTIME_VERSION}`] : [`bun-${RELEASE_RUNTIME_VERSION}`];
    check(`runtime upgrade (${label}): a committed update prunes older owned runtimes and debris, keeping the new and previous`,
      JSON.stringify(runtimeEntries(f)) === JSON.stringify(keptOwned) && existsSync(f.oldRuntime),
      JSON.stringify(runtimeEntries(f)));
    check(`runtime upgrade (${label}): the commit receipts the runtime directory, so a non-purge uninstall takes it back`,
      JSON.stringify(resource(f, 'bun-runtimes')) === JSON.stringify(bunRuntimesReceipt(f.home)),
      JSON.stringify(resource(f, 'bun-runtimes')));
  }

  // ---- Substituted runtime bytes: refused before the journal, the service, or any file moves.
  for (const [label, code, bytes] of [
    ['size', 'release-runtime-size-mismatch', runtimeZip.subarray(0, runtimeZip.byteLength - 1)],
    ['digest', 'release-runtime-checksum-mismatch', (() => {
      const copy = Uint8Array.from(runtimeZip);
      copy[copy.byteLength - 40] = copy[copy.byteLength - 40]! ^ 0xff;
      return copy;
    })()],
  ] as const) {
    const f = fixture({ backend: 'systemd', layout: 'legacy' });
    const before = f.snapshot();
    const entriesBefore = runtimeEntries(f);
    const refused = await runUpgrade(dependencies(f, manifest, bytes));
    check(`runtime upgrade: a runtime ${label} mismatch is refused before anything changes`,
      refused.status === 'failed' && refused.detailCode === code
        && JSON.stringify(f.snapshot()) === JSON.stringify(before)
        && JSON.stringify(runtimeEntries(f)) === JSON.stringify(entriesBefore)
        && f.calls.length === 0 && f.active() && f.launches.length === 0
        && !existsSync(join(f.home, 'bin', 'cosyncing.staging-2.0.0'))
        && !existsSync(f.newWeb) && !existsSync(join(f.home, 'upgrade-journal.json')),
      `${refused.status}/${refused.detailCode} calls=${f.calls.join(',')} entries=${JSON.stringify(runtimeEntries(f))}`);
  }

  // ---- A run pinned to an immutable release installs that release or nothing.
  // The app's update button delegates to this command in a transient unit that starts seconds
  // later, so the only thing keeping "install the release I reviewed" from quietly becoming
  // "install whatever is latest by then" is the pin being honoured here.
  {
    const f = fixture({ backend: 'systemd', layout: 'legacy' });
    const before = f.snapshot();
    const entriesBefore = runtimeEntries(f);
    const moved = await runUpgrade({ ...dependencies(f, manifest), pinnedReleaseId: 'rel-1.9.0+1111111' });
    check('runtime upgrade: a pinned release the channel no longer serves is refused before anything moves',
      moved.status === 'blocked' && moved.exitCode === 1 && moved.detailCode === 'release-target-moved'
        && JSON.stringify(f.snapshot()) === JSON.stringify(before)
        && JSON.stringify(runtimeEntries(f)) === JSON.stringify(entriesBefore)
        && f.calls.length === 0 && f.active() && f.launches.length === 0
        && !existsSync(join(f.home, 'upgrade-journal.json')),
      `${moved.status}/${moved.detailCode} calls=${f.calls.join(',')} entries=${JSON.stringify(runtimeEntries(f))}`);

    // The other direction, and it is deliberately cheap to prove: a pin the verified manifest
    // agrees with is accepted. The two sides compute that identity together, so a disagreement
    // would refuse everything, which the refusal above cannot show. Answering about the release
    // the pin names -- and not installing anything, because it is the release already running --
    // is that acceptance. The install itself is what the unpinned runs above already prove.
    const running = manifestFor({ version: jsBuild.version, sourceCommit: jsBuild.commit });
    const matched = await runUpgrade({ ...dependencies(f, running), pinnedReleaseId: 'rel-1.0.0+1111111' });
    check('runtime upgrade: a pin the verified manifest agrees with is honoured, not refused',
      matched.status === 'already-current' && matched.exitCode === 0 && matched.detailCode === 'release-already-current'
        && JSON.stringify(f.snapshot()) === JSON.stringify(before)
        && f.calls.length === 0 && f.active(),
      `${matched.status}/${matched.detailCode}: ${matched.summary}`);
  }

  // ---- The candidate fails its health check after the switch: broker AND runtime go back.
  for (const backend of ['systemd', 'launchd'] as const) {
    const f = fixture({ backend, layout: 'legacy' });
    const before = f.snapshot();
    const hashes = [backend === 'systemd' ? 'service-systemd' : 'service-launchd', 'service-environment']
      .map((id) => resource(f, id)?.ownership.installedSha256);
    const rolled = await runUpgrade({ ...dependencies(f, manifest), verifyBrokerVersion: async (_config, version) => version === '1.0.0' });
    check(`runtime upgrade (${backend}): a failed health check restores the broker, the service files, the launchers and the receipt`,
      rolled.exitCode === 3 && rolled.detailCode === 'upgrade-rolled-back'
        && JSON.stringify(f.snapshot()) === JSON.stringify(before)
        && JSON.stringify([backend === 'systemd' ? 'service-systemd' : 'service-launchd', 'service-environment']
          .map((id) => resource(f, id)?.ownership.installedSha256)) === JSON.stringify(hashes)
        && f.calls.join(',') === 'stop,reload,start,stop,reload,start' && f.active(),
      `${rolled.exitCode}/${rolled.detailCode} calls=${f.calls.join(',')}`);
    check(`runtime upgrade (${backend}): the rolled-back runtime this update installed is removed, and the old one kept`,
      !existsSync(dirname(f.newRuntime)) && read(f.oldRuntime) === 'fixture-bun 1.3.14\n'
        && runtimeEntries(f).includes('bun-1.3.9') && resource(f, 'bun-runtimes') === undefined,
      JSON.stringify(runtimeEntries(f)));
  }

  // ---- A crash after the switch: the next run's recovery restores the runtime with everything else.
  {
    const f = fixture({ backend: 'systemd', layout: 'legacy' });
    const before = f.snapshot();
    const interrupted = await runUpgrade({ ...dependencies(f, manifest), faultAfter: 'binary-switched' });
    const switchedUnit = read(f.serviceFiles[0]!);
    const switchedLauncher = read(f.launchers[0]!);
    const recovered = await runUpgrade(dependencies(f, manifest));
    check('runtime upgrade: recovery after a crash mid-switch restores broker, service files, launchers and receipt',
      interrupted.detailCode === 'upgrade-interrupted'
        && switchedUnit.includes(f.newRuntime) && switchedLauncher.includes(f.newRuntime)
        && recovered.detailCode === 'upgrade-interrupted-recovered'
        && JSON.stringify(f.snapshot()) === JSON.stringify(before)
        && !existsSync(dirname(f.newRuntime)) && f.active()
        && !existsSync(join(f.home, 'upgrade-journal.json')),
      `${interrupted.detailCode} -> ${recovered.detailCode} calls=${f.calls.join(',')}`);
  }

  // ---- Installs whose runtime cosyncing does not own, or cannot replace here.
  {
    const f = fixture({ backend: 'systemd', layout: 'legacy' });
    const before = f.snapshot();
    const options = dependencies(f, manifest);
    const refused = await runUpgrade({ ...options, runtimeOverridden: true });
    check('runtime upgrade: a COSYNCING_BUN_BIN runtime below the floor is refused by name, before any download',
      refused.status === 'blocked' && refused.detailCode === RUNTIME_UPGRADE_REQUIRED_DETAIL
        && refused.summary.includes(`needs Bun ${RELEASE_RUNTIME_VERSION} or newer`)
        && refused.summary.includes('COSYNCING_BUN_BIN')
        && refused.summary.includes(f.oldRuntime)
        && refused.toVersion === '2.0.0'
        && options.urls.length === 1 && options.urls[0]!.endsWith('manifest.json')
        && JSON.stringify(f.snapshot()) === JSON.stringify(before) && f.calls.length === 0,
      `${refused.status}/${refused.detailCode}: ${refused.summary}`);
  }
  {
    const f = fixture({ backend: 'systemd', layout: 'legacy' });
    const before = f.snapshot();
    const armOnly = manifestFor({ webApp, bunRuntime: releaseRuntimeFixture({
      'linux-arm64': [{ asset: 'bun-linux-aarch64.zip', sha256: hash(runtimeZip), size: runtimeZip.byteLength }],
    }) });
    const options = dependencies(f, armOnly);
    const refused = await runUpgrade(options);
    check('runtime upgrade: a release with no pinned Bun for this host is refused with install instructions, before any download',
      refused.status === 'blocked' && refused.detailCode === RUNTIME_UPGRADE_REQUIRED_DETAIL
        && refused.summary.includes('https://bun.sh')
        && options.urls.length === 1
        && JSON.stringify(f.snapshot()) === JSON.stringify(before) && f.calls.length === 0,
      `${refused.status}/${refused.detailCode}: ${refused.summary}`);
  }

  // ---- A versioned (Windows-shaped) service moves its runtime through the version activation.
  {
    const planned: unknown[] = [];
    const restored: unknown[] = [];
    let applied = 0;
    const versions: DurableServiceVersions = {
      plan(_build, runtime) {
        planned.push(runtime);
        return {
          record: {
            installationId: 'install-fixture', fromVersionKey: 'version-1', toVersionKey: 'version-2',
            ...(runtime ? { fromRuntimePath: runtime.fromRuntimePath, toRuntimePath: runtime.toRuntimePath } : {}),
          },
          async apply() { applied += 1; },
        };
      },
      async restore(record) { restored.push(record); },
      async finalize() { /* nothing superseded in the fixture */ },
      resources() { return []; },
    };
    const f = fixture({ backend: 'none', layout: 'legacy', versions });
    const upgraded = await runUpgrade(dependencies(f, manifest));
    check('runtime upgrade (versioned service): the activation is handed both runtimes and the record carries them',
      upgraded.exitCode === 0 && applied === 1
        && JSON.stringify(planned) === JSON.stringify([{ fromRuntimePath: f.oldRuntime, toRuntimePath: f.newRuntime }])
        && f.launchers.every((path) => read(path) === f.launcherText(f.newRuntime)),
      `${upgraded.detailCode} ${JSON.stringify(planned)}`);

    const g = fixture({ backend: 'none', layout: 'legacy', versions });
    planned.length = 0;
    const before = g.snapshot();
    const rolled = await runUpgrade({ ...dependencies(g, manifest), verifyBrokerVersion: async (_config, version) => version === '1.0.0' });
    check('runtime upgrade (versioned service): a rollback restores the activation with the runtime it ran before',
      rolled.detailCode === 'upgrade-rolled-back'
        && JSON.stringify(restored) === JSON.stringify([{
          installationId: 'install-fixture', fromVersionKey: 'version-1', toVersionKey: 'version-2',
          fromRuntimePath: g.oldRuntime, toRuntimePath: g.newRuntime,
        }])
        && JSON.stringify(g.snapshot()) === JSON.stringify(before) && !existsSync(dirname(g.newRuntime)),
      `${rolled.detailCode} ${JSON.stringify(restored)}`);
  }

  // ---- A release whose floor this runtime already meets touches no runtime at all.
  {
    const f = fixture({ backend: 'systemd', layout: 'legacy' });
    const options = dependencies(f, manifestFor({ webApp, minimumBunVersion: '1.3.14' }));
    const upgraded = await runUpgrade(options);
    check('runtime upgrade: a met floor downloads no runtime and leaves the service on the Bun it had',
      upgraded.exitCode === 0 && !options.urls.some((url) => url.startsWith(BUN_RELEASE_DOWNLOAD_BASE))
        && !existsSync(dirname(f.newRuntime)) && read(f.serviceFiles[0]!).includes(f.oldRuntime)
        && f.launchers.every((path) => read(path) === f.launcherText(f.oldRuntime))
        && !f.calls.includes('reload'),
      `${upgraded.detailCode} calls=${f.calls.join(',')}`);
  }
}
