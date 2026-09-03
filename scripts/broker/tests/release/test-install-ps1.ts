#!/usr/bin/env bun
/**
 * The PowerShell installer, run for real under Windows PowerShell 5.1.
 *
 * The Linux gate asserts everything decided at RENDER time — tokens, keys, the Bun rows, the asset set —
 * in `test-release-supply-chain.ts`. Nothing it can do proves the script RUNS: PowerShell 5.1's P-256
 * verification, its owner-only DACLs, `tar.exe`, and the batch shim only exist on Windows. So this suite
 * assembles a fixture release with a throwaway signing pair, renders the real installer against it, and
 * executes it under the same 5.1 by absolute path that the product itself spawns.
 *
 * The download seam is a FUNCTION named `Invoke-WebRequest` defined in the harness that invokes the
 * installer: a function outranks a cmdlet of the same name, and a script invoked with `&` sees its
 * caller's functions. That assumption is asserted by the first check rather than trusted, because if it
 * ever stopped holding every later check would pass against a script that reached the real network.
 *
 * No test-only branch is added to the template — no `http://`, no `file://`, no environment override for
 * the download or the architecture refusal. Where a case needs the installer to believe something about
 * the host, the RENDERED SCRIPT is rewritten in a copy, the way the shell suite repins its Bun table.
 */
import { generateKeyPairSync } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PUBLISHED_BROKER_CONTRACT,
  PUBLISHED_SCHEMA_VERSIONS,
} from '../../../../packages/typescript/broker/src/runtime/build-info.ts';
import {
  RELEASE_JAVASCRIPT_APP_NAME,
  RELEASE_JAVASCRIPT_APP_TARGET,
} from '../../../../packages/typescript/broker/src/updates/release-upgrade.ts';
import {
  MINIMUM_BUN_RUNTIME_VERSION,
  PINNED_BUN_RUNTIME_ARCHIVES,
} from '../../../../packages/typescript/broker/src/runtime/application-identity.ts';
import { inspectOwnerOnlyDirectory } from '../../../../packages/typescript/broker/src/security/secure-files.ts';
import { windowsPowerShellChildEnvironment } from '../../../../packages/typescript/adapter-api/src/host-process.ts';
import {
  BROKER_CONTRACT,
  CLIENT_MINIMUM_BROKER_CONTRACT_REVISION,
} from '../../../../packages/typescript/protocol/src/index.ts';
import {
  assembleRelease,
  canonicalProductVersion,
  releaseTargetArch,
  releaseTargetPlatform,
  sha256,
  RELEASE_TARGETS,
  WEB_SIDECAR_NAME,
  type JavaScriptPackageEvidence,
  type PackageEvidence,
  type ReleaseTarget,
  type WebPackageEvidence,
} from '../../release/release-files.ts';
import {
  insideSupervisedProcessGroup,
  runSupervised,
} from '../../../verification/supervised-process.ts';

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

if (process.platform !== 'win32') {
  console.error(
    'FAIL install-ps1: this suite runs the installer under Windows PowerShell 5.1; nothing else can'
    + ' stand in for it. The render-time assertions live in test-release-supply-chain.ts.',
  );
  process.exit(1);
}

const SYSTEM_ROOT = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
const POWERSHELL = join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const TAR_EXE = join(SYSTEM_ROOT, 'System32', 'tar.exe');
// The .NET Framework compiler, which is how a fixture gets a real `bun.exe`. A batch file cannot stand in:
// the installer expects `bun-windows-x64\bun.exe` inside the archive and places it as `bun.exe`, and
// cmd.exe will not execute a script under that extension.
const CSC = join(SYSTEM_ROOT, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

for (const [label, path] of [['PowerShell 5.1', POWERSHELL], ['tar.exe', TAR_EXE], ['csc.exe', CSC]]) {
  if (!existsSync(path!)) {
    console.error(`FAIL install-ps1: ${label} is missing at ${path}`);
    process.exit(1);
  }
}

const VERSION = canonicalProductVersion();
const COMMIT = '7'.repeat(40);
const BUILD_DATE = '2026-09-03T00:00:00.000Z';
const BASE_URL = `https://releases.example/cosyncing/v${VERSION}`;
const KEY_ID = 'install-ps1-fixture';

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runPowerShell(options: {
  script: string;
  arguments: readonly string[];
  env?: Readonly<Record<string, string>>;
  stage: string;
}): Promise<RunResult> {
  // 5.1 by absolute path with its module path pinned to the system store: a host with PowerShell 7 —
  // every GitHub-hosted Windows runner — exports a PSModulePath 5.1 cannot auto-load its own
  // Microsoft.PowerShell.Security from, and a check about ACLs must not silently lose Get-Acl.
  const child = await runSupervised(
    [POWERSHELL, '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', options.script, ...options.arguments],
    {
      cwd: SYSTEM_ROOT,
      env: {
        ...windowsPowerShellChildEnvironment({ ...process.env, ...(options.env ?? {}) }),
      } as NodeJS.ProcessEnv,
      timeoutMs: 120_000,
      maxBufferBytes: 8 << 20,
      isolateProcessGroup: !insideSupervisedProcessGroup(),
    },
  );
  if (child.timedOut) throw new Error(`${options.stage} timed out`);
  return { exitCode: child.exitCode, stdout: child.stdout, stderr: child.stderr };
}

const root = mkdtempSync(join(tmpdir(), 'cosyncing-install-ps1-'));
try {
  // ---- Fixtures -----------------------------------------------------------------------------------
  const fixtures = join(root, 'fixtures');
  mkdirSync(fixtures, { recursive: true });

  /**
   * A real `bun.exe` that stands in for the two things the installer asks a runtime to do: answer
   * `--revision`, and run the verified bundle's `version --json`. It prints the bundle file back, so the
   * fixture "bundle" is the identity JSON itself and every other property under test — digests,
   * signatures, the receipt — stays real.
   */
  function buildFakeBun(name: string, revision: string): string {
    const source = join(fixtures, `${name}.cs`);
    const output = join(fixtures, `${name}.exe`);
    writeFileSync(source, `using System;
using System.IO;
public static class FakeBun {
  public static int Main(string[] args) {
    if (args.Length == 1 && args[0] == "--revision") {
      Console.Out.Write("${revision}+fixturebuild\\n");
      return 0;
    }
    if (args.Length == 3 && args[1] == "version" && args[2] == "--json" && File.Exists(args[0])) {
      Console.Out.Write(File.ReadAllText(args[0]));
      return 0;
    }
    Console.Error.Write("fake bun: unexpected invocation\\n");
    return 2;
  }
}
`);
    const compiled = Bun.spawnSync([CSC, '/nologo', '/optimize+', '/target:exe', `/out:${output}`, source], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (!compiled.success || !existsSync(output)) {
      throw new Error(`fake bun.exe could not be compiled: ${compiled.stderr.toString()}`);
    }
    return output;
  }

  const currentBun = buildFakeBun('bun-current', '1.3.14');
  const staleBun = buildFakeBun('bun-stale', '1.2.99');
  const pinnedBun = buildFakeBun('bun-pinned', MINIMUM_BUN_RUNTIME_VERSION);
  // A build that cannot run on this host at all: the case the installer must survive by advancing to the
  // next pinned candidate rather than failing the install.
  const unrunnableBun = join(fixtures, 'bun-unrunnable.exe');
  writeFileSync(unrunnableBun, 'MZ not a real executable\n');

  const artifactDirectory = join(root, 'artifacts');
  const evidenceDirectory = join(root, 'evidence');
  const releaseDirectory = join(root, 'release');
  mkdirSync(artifactDirectory, { recursive: true });
  mkdirSync(evidenceDirectory, { recursive: true });

  // The compiled per-host artifacts. This installer never touches them — it places one universal bundle —
  // but `assembleRelease` publishes the whole signed set, so the fixture provides the whole set.
  for (const target of RELEASE_TARGETS) {
    const name = `cosyncing-${target}`;
    const path = join(artifactDirectory, name);
    writeFileSync(path, `#!/usr/bin/env bash\n# fixture ${target}\nexit 2\n`);
    const bytes = readFileSync(path);
    const evidence: PackageEvidence = {
      schemaVersion: 1,
      product: 'cosyncing',
      artifact: name,
      version: VERSION,
      target,
      sourceCommit: COMMIT,
      buildDate: BUILD_DATE,
      size: bytes.byteLength,
      sha256: sha256(bytes),
      packaged: true,
      dirty: false,
      schemaVersions: PUBLISHED_SCHEMA_VERSIONS,
      contract: PUBLISHED_BROKER_CONTRACT,
      cleanCheckout: true,
      offlineVersionCheck: true,
      forbiddenContentCheck: true,
      runner: {
        os: releaseTargetPlatform(target),
        arch: releaseTargetArch(target),
        image: `fixture-${target}`,
        invocationId: `200${RELEASE_TARGETS.indexOf(target as ReleaseTarget) + 1}`,
      },
    };
    writeFileSync(
      join(evidenceDirectory, `${name}.evidence.json`),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
  }

  // The bundle IS the identity JSON, because the fake bun prints the file it is asked to run. The shape
  // is the one the real `version --json` emits, and the installer checks four fields of it exactly.
  const applicationPath = join(artifactDirectory, RELEASE_JAVASCRIPT_APP_NAME);
  writeFileSync(applicationPath, `${JSON.stringify({
    schemaVersion: 2,
    product: 'cosyncing',
    binary: 'cosyncing',
    alias: 'cosy',
    version: VERSION,
    commit: COMMIT,
    buildDate: BUILD_DATE,
    target: RELEASE_JAVASCRIPT_APP_TARGET,
    distribution: 'bootstrap-js',
    packaged: true,
    dirty: false,
    schemaVersions: PUBLISHED_SCHEMA_VERSIONS,
    contract: PUBLISHED_BROKER_CONTRACT,
  }, null, 2)}\n`);
  const applicationBytes = readFileSync(applicationPath);
  const applicationEvidence: JavaScriptPackageEvidence = {
    schemaVersion: 1,
    product: 'cosyncing',
    artifact: RELEASE_JAVASCRIPT_APP_NAME,
    version: VERSION,
    target: RELEASE_JAVASCRIPT_APP_TARGET,
    distribution: 'bootstrap-js',
    sourceCommit: COMMIT,
    buildDate: BUILD_DATE,
    size: applicationBytes.byteLength,
    sha256: sha256(applicationBytes),
    minimumBunVersion: MINIMUM_BUN_RUNTIME_VERSION,
    packaged: true,
    dirty: false,
    schemaVersions: PUBLISHED_SCHEMA_VERSIONS,
    contract: PUBLISHED_BROKER_CONTRACT,
    cleanCheckout: true,
    offlineVersionCheck: true,
    forbiddenContentCheck: true,
    runner: { os: 'linux', arch: 'x64', image: 'fixture-universal', invocationId: '2004' },
  };
  writeFileSync(
    join(evidenceDirectory, `${RELEASE_JAVASCRIPT_APP_NAME}.evidence.json`),
    `${JSON.stringify(applicationEvidence, null, 2)}\n`,
  );

  // A real gzipped tar holding the one `app/` tree the installer unpacks, packed by the same `tar.exe`
  // the installer will unpack it with.
  const webArtifactPath = join(artifactDirectory, WEB_SIDECAR_NAME);
  {
    const staging = join(root, 'web-fixture');
    mkdirSync(join(staging, 'app', 'assets'), { recursive: true });
    writeFileSync(join(staging, 'app', 'index.html'), '<html><base href="/cosy/"></html>\n');
    writeFileSync(join(staging, 'app', 'assets', 'NOTICES'), 'fixture notices\n');
    const packed = Bun.spawnSync([TAR_EXE, '-czf', webArtifactPath, '-C', staging, 'app'], {
      stdout: 'ignore',
      stderr: 'pipe',
    });
    if (!packed.success) {
      throw new Error(`web sidecar fixture could not be packed: ${packed.stderr.toString()}`);
    }
  }
  const webBytes = readFileSync(webArtifactPath);
  const webEvidence: WebPackageEvidence = {
    schemaVersion: 1,
    product: 'cosyncing',
    artifact: WEB_SIDECAR_NAME,
    version: VERSION,
    sourceCommit: COMMIT,
    buildDate: BUILD_DATE,
    size: webBytes.byteLength,
    sha256: sha256(webBytes),
    baseHref: '/cosy/',
    contract: {
      ...BROKER_CONTRACT,
      clientMinimumBrokerRevision: CLIENT_MINIMUM_BROKER_CONTRACT_REVISION,
    },
    buildId: 'fedcba9876543210',
    cacheManifestSha256: '5'.repeat(64),
    mainDartSha256: '6'.repeat(64),
    directorySha256: '7'.repeat(64),
    fileCount: 3,
    cleanCheckout: true,
  };
  writeFileSync(
    join(evidenceDirectory, `${WEB_SIDECAR_NAME}.evidence.json`),
    `${JSON.stringify(webEvidence, null, 2)}\n`,
  );

  const ed25519 = generateKeyPairSync('ed25519');
  const p256 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const signing = {
    baseUrl: BASE_URL,
    version: VERSION,
    sourceCommit: COMMIT,
    publishedAt: BUILD_DATE,
    keyId: KEY_ID,
    privateKeyPem: ed25519.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: ed25519.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    p256PrivateKeyPem: p256.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    p256PublicKeyPem: p256.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  } as const;
  assembleRelease({
    artifactDirectory,
    evidenceDirectory,
    outputDirectory: releaseDirectory,
    ...signing,
  });

  /** The declaration the elevation refusal hangs off, stubbed below in copies of the rendered script. */
  const ELEVATION_PROBE = 'function Test-ElevatedProcess {';
  /** Insert a `return` as the first statement of one function in a RENDERED installer. */
  function stubProbe(installer: string, declaration: string, value: string): void {
    const source = readFileSync(installer, 'utf8');
    if (!source.includes(declaration)) throw new Error(`rendered installer has no ${declaration}`);
    writeFileSync(installer, source.replace(declaration, `${declaration}\n  return ${value}`));
  }

  /**
   * The rendered installer every check below starts from, with ONE host property neutralised where the
   * host forces it.
   *
   * `install.ps1` refuses an elevated install, and every GitHub-hosted Windows runner runs as a local
   * administrator with a full token — so on CI the refusal is correct and fires before the installer does
   * anything, and the suite could otherwise never execute a single line past it. The product itself is not
   * this strict: `windows-dacl.ts` deliberately accepts an object owned by an elevated token's default
   * owner, because refusing it "made the product reject files it had just created itself". The refusal is
   * this installer's own policy, mirroring the shell installer's root refusal.
   *
   * So on an elevated host the probe is stubbed to `$false` once, here, and every check runs the real
   * logic against real DACLs. That is not a hole in the refusal: the template writes `O:<user>` explicitly
   * into every descriptor and `$CURRENT_USER_SID` is the token's USER SID, which is the person either way,
   * so what the owner-only inspection reads is the same object it would read unelevated. On an unelevated
   * host — the physical one this lane was built against — nothing is touched and the pristine script runs.
   *
   * The refusal itself is proven separately, and deterministically on both kinds of host, by forcing the
   * probe the other way.
   */
  const elevationProbeScript = join(root, 'elevation-probe.ps1');
  writeFileSync(elevationProbeScript, `Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal $identity
Write-Output $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
`);
  const elevationProbe = await runPowerShell({
    script: elevationProbeScript,
    arguments: [],
    stage: 'elevation probe',
  });
  const HOST_IS_ELEVATED = /^\s*True\s*$/i.test(elevationProbe.stdout);
  const pristineInstaller = readFileSync(join(releaseDirectory, 'install.ps1'), 'utf8');
  if (HOST_IS_ELEVATED) stubProbe(join(releaseDirectory, 'install.ps1'), ELEVATION_PROBE, '$false');
  console.log(`      (host is ${HOST_IS_ELEVATED ? 'ELEVATED, probe neutralised' : 'unelevated, script pristine'})`);

  /**
   * A second release, correctly signed, whose web sidecar is not a tarball.
   *
   * Corrupting the shipped archive would fail the digest check instead, which is a different case that is
   * already covered. This one is signed over the broken bytes, so it is the only way to reach the
   * extraction failure — the path that decides whether `tar.exe` failing loses the operator's previous
   * web client.
   */
  function assembleBrokenWebSidecarRelease(): string {
    const artifacts = join(root, 'artifacts-broken-web');
    const evidence = join(root, 'evidence-broken-web');
    const output = join(root, 'release-broken-web');
    cpSync(artifactDirectory, artifacts, { recursive: true });
    cpSync(evidenceDirectory, evidence, { recursive: true });
    const broken = Buffer.from('this is not a gzipped tar\n');
    writeFileSync(join(artifacts, WEB_SIDECAR_NAME), broken);
    writeFileSync(
      join(evidence, `${WEB_SIDECAR_NAME}.evidence.json`),
      `${JSON.stringify({ ...webEvidence, size: broken.byteLength, sha256: sha256(broken) }, null, 2)}\n`,
    );
    assembleRelease({
      artifactDirectory: artifacts,
      evidenceDirectory: evidence,
      outputDirectory: output,
      ...signing,
    });
    // Freshly rendered, so it needs the same neutralisation the shared release got.
    if (HOST_IS_ELEVATED) stubProbe(join(output, 'install.ps1'), ELEVATION_PROBE, '$false');
    return output;
  }

  /**
   * A pinned Bun archive as Bun publishes it: a zip holding `<asset without .zip>\bun.exe`.
   *
   * Bun's real archives are ~90 MB, which no deterministic suite can host, so the rendered Bun table is
   * repointed at these and at their true digests. The mismatch case below is what proves the REAL pins
   * are enforced.
   */
  async function writeBunArchive(directory: string, asset: string, executable: string): Promise<string> {
    const staging = join(root, `bun-zip-${asset}`);
    const inner = join(staging, asset.replace(/\.zip$/, ''));
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(inner, { recursive: true });
    cpSync(executable, join(inner, 'bun.exe'));
    const target = join(directory, asset);
    rmSync(target, { force: true });
    const zipScript = join(root, 'zip.ps1');
    writeFileSync(zipScript, `param([string] $Source, [string] $Destination)
$ErrorActionPreference = 'Stop'
Compress-Archive -Path $Source -DestinationPath $Destination -Force
`);
    const zipped = await runPowerShell({
      script: zipScript,
      arguments: [inner, target],
      stage: `zip ${asset}`,
    });
    if (zipped.exitCode !== 0 || !existsSync(target)) {
      throw new Error(`Bun archive fixture could not be zipped: ${zipped.stderr}`);
    }
    return sha256(readFileSync(target));
  }

  // ---- The harness --------------------------------------------------------------------------------

  const harness = join(root, 'install-harness.ps1');
  writeFileSync(harness, `param(
  [Parameter(Mandatory = $true)][string] $Installer,
  [Parameter(Mandatory = $true)][string] $ReleaseRoot
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Paths arrive as script PARAMETERS rather than through the command line, because \`cmd /c "..."\` with
# inner quotes exits 0 on a syntax error and a harness that reported success while doing nothing would
# make every check below meaningless.
$CosyncingFixtureReleaseRoot = $ReleaseRoot

# The download seam. A function outranks a cmdlet of the same name, and a script invoked with \`&\` runs in
# a child scope that sees its caller's functions — so the installer's own \`Invoke-Download\` wrapper calls
# this instead of reaching the network, with no test-only branch in the template.
function Invoke-WebRequest {
  param([string] $Uri, [string] $OutFile, [switch] $UseBasicParsing)
  $name = ($Uri -split '/')[-1]
  $source = Join-Path $CosyncingFixtureReleaseRoot $name
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "fixture release has no asset named $name"
  }
  Copy-Item -LiteralPath $source -Destination $OutFile -Force
}

& $Installer
exit $LASTEXITCODE
`);

  const PATH_KEY = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';

  /** A PATH that reaches the host's real tools but no `bun`, for the cases about resolving a runtime. */
  function pathWithoutBun(): string {
    return (process.env.PATH ?? process.env.Path ?? '')
      .split(delimiter)
      .filter((entry) => entry !== ''
        && !['bun.exe', 'bun.cmd', 'bun.bat', 'bun'].some((name) => existsSync(join(entry, name))))
      .join(delimiter);
  }

  let caseIndex = 0;
  async function install(options: {
    release: string;
    stage: string;
    home?: string;
    bun?: string;
    bunInstall?: string;
    hideBun?: boolean;
    env?: Readonly<Record<string, string>>;
  }): Promise<RunResult & { home: string }> {
    caseIndex += 1;
    const home = options.home ?? join(root, `home-${caseIndex}-${options.stage.replace(/\W+/g, '-')}`);
    const environment: Record<string, string> = {
      COSYNCING_HOME: home,
      // Never the operator's own %USERPROFILE%\.bun: an install that placed a runtime there would
      // rewrite the ACLs on a directory this suite does not own.
      BUN_INSTALL: options.bunInstall ?? join(root, `bun-prefix-${caseIndex}`),
      ...(options.bun ? { COSYNCING_BUN_BIN: options.bun } : {}),
      // One PATH key, spelled the way this host spells it: an environment block carrying both `PATH`
      // and `Path` is ambiguous, and `process.env` on Windows reports whichever case the OS used.
      ...(options.hideBun ? { [PATH_KEY]: pathWithoutBun() } : {}),
      ...(options.env ?? {}),
    };
    const result = await runPowerShell({
      script: harness,
      arguments: [join(options.release, 'install.ps1'), options.release],
      env: environment,
      stage: options.stage,
    });
    return { ...result, home };
  }

  function releaseCopy(name: string): string {
    const copy = join(root, `release-${name}`);
    rmSync(copy, { recursive: true, force: true });
    cpSync(releaseDirectory, copy, { recursive: true });
    return copy;
  }

  /** Rewrite one single-quoted assignment in a RENDERED installer, the way the shell suite repins Bun. */
  function rewriteAssignment(installer: string, variable: string, value: string): void {
    const source = readFileSync(installer, 'utf8');
    const assignment = `$${variable}`;
    const replaced = source.replace(
      // `[^']*` spans newlines, which is what lets one pattern rewrite the multi-line Bun table too.
      new RegExp(`^\\${assignment} = '[^']*'$`, 'm'),
      // A function replacement, so a `$` in the value is never read as a replacement pattern.
      () => `${assignment} = '${value}'`,
    );
    if (replaced === source) throw new Error(`rendered installer has no ${assignment} assignment`);
    writeFileSync(installer, replaced);
  }

  // ---- The seam itself ----------------------------------------------------------------------------

  // Asserted before anything rests on it. If shadowing ever stopped working, the installer would reach
  // releases.example, every download would fail, and a suite that had not checked this would report a
  // plausible-looking failure about the network instead of about its own harness.
  {
    const seamScript = join(root, 'seam.ps1');
    writeFileSync(seamScript, `param([Parameter(Mandatory = $true)][string] $Probe)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Invoke-WebRequest {
  param([string] $Uri, [string] $OutFile, [switch] $UseBasicParsing)
  Set-Content -LiteralPath $OutFile -Value ('shadowed:' + $Uri) -NoNewline
}
& $Probe
`);
    const probeScript = join(root, 'seam-probe.ps1');
    const seamOut = join(root, 'seam.out');
    writeFileSync(probeScript, `Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Invoke-Download {
  param([string] $Uri, [string] $OutFile)
  Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing
}
Invoke-Download -Uri 'https://releases.example/probe' -OutFile '${seamOut}'
`);
    const seam = await runPowerShell({
      script: seamScript,
      arguments: [probeScript],
      stage: 'download seam',
    });
    check('a caller-defined Invoke-WebRequest shadows the cmdlet inside the script it invokes',
      seam.exitCode === 0 && existsSync(seamOut)
        && readFileSync(seamOut, 'utf8') === 'shadowed:https://releases.example/probe',
      `${seam.exitCode}: ${seam.stderr.trim().slice(0, 200)}`);
  }

  // ---- Happy path ---------------------------------------------------------------------------------

  const happy = await install({ release: releaseDirectory, stage: 'happy path', bun: currentBun });
  const installDir = join(happy.home, 'bin');
  const application = join(installDir, 'cosyncing');
  const webRoot = join(installDir, `cosyncing-web-${VERSION}`);
  const shim = join(installDir, 'cosy.cmd');
  const receiptPath = join(happy.home, 'bootstrap-receipt');
  const receipt = existsSync(receiptPath) ? readFileSync(receiptPath, 'utf8') : '';
  check('the installer places the bundle, the web client, the receipt and the shim',
    happy.exitCode === 0 && existsSync(application) && existsSync(shim)
      && existsSync(join(webRoot, 'index.html')) && existsSync(join(webRoot, 'assets', 'NOTICES'))
      && receipt.includes(`sha256=${sha256(readFileSync(application))}`),
    `${happy.exitCode}: ${happy.stderr.trim().slice(0, 300) || happy.stdout.trim().split('\n').slice(-3).join(' | ')}`);
  check('the receipt records the installer-owned distribution, the Windows host, and the resolved runtime',
    receipt.includes('schemaVersion=2\n')
      && receipt.includes('product=cosyncing\n')
      && receipt.includes('target=universal\n')
      && receipt.includes('distribution=bootstrap-js\n')
      && receipt.includes('host=windows-x64\n')
      && receipt.includes(`application=${application}\n`)
      && receipt.includes(`webRoot=${webRoot}\n`)
      && receipt.includes(`runtime=${currentBun}\n`)
      // LF and no byte-order mark, so a receipt is the same bytes on every host.
      && !receipt.includes('\r') && !receipt.startsWith('\ufeff'),
    receipt.trim().replaceAll('\n', ' | '));
  check('the release is reported as P-256 verified, with no degraded state to fall into',
    /Release signature: verified \(ECDSA P-256 over the signed release manifest and checksum list\)/
      .test(happy.stdout)
      && /Artifact digests: matched/.test(happy.stdout)
      && !/skipped/i.test(happy.stdout)
      && !/delivered over TLS/.test(happy.stdout),
    happy.stdout.trim().split('\n').slice(-6).join(' | '));
  check('PATH is not changed and the printed setup command names the runtime and the bundle absolutely',
    happy.stdout.includes('PATH was not changed')
      && happy.stdout.includes(`& '${currentBun}' '${application}' setup`),
    happy.stdout.trim().split('\n').slice(-2).join(' | '));

  // The product's own inspection, not a restatement of it. `doctor` reports `state.directory.state-root`
  // from exactly this call, and `setup` refuses a version root that fails it — so a directory this
  // installer created with inherited ACLs would be called unsafe by the next command the operator runs.
  const inspected = [happy.home, installDir, webRoot].map((path) => {
    const inspection = inspectOwnerOnlyDirectory(path);
    return { path, status: inspection.status, problem: inspection.problem };
  });
  check('every directory the installer created passes the product\'s owner-only inspection',
    inspected.every((entry) => entry.status === 'ok'),
    inspected.map((entry) => `${entry.path}=${entry.status}${entry.problem ? `/${entry.problem}` : ''}`)
      .join(' | '));

  // The shim is for humans, and the only way to know it works is to run it. `%~dp0` has to resolve to the
  // install directory and the Bun path has to survive the batch quoting.
  {
    const shimRun = await runSupervised(
      [join(SYSTEM_ROOT, 'System32', 'cmd.exe'), '/c', shim, 'version', '--json'],
      {
        cwd: SYSTEM_ROOT,
        env: process.env,
        timeoutMs: 30_000,
        maxBufferBytes: 1 << 20,
        isolateProcessGroup: !insideSupervisedProcessGroup(),
      },
    );
    let reported: { version?: unknown; distribution?: unknown } = {};
    try {
      reported = JSON.parse(shimRun.stdout);
    } catch { /* asserted below */ }
    const shimText = existsSync(shim) ? readFileSync(shim, 'utf8') : '<no shim>';
    check('the cosy.cmd shim runs the installed bundle through the recorded runtime',
      shimRun.exitCode === 0 && reported.version === VERSION
        && reported.distribution === 'bootstrap-js'
        && shimText.includes('%~dp0cosyncing'),
      `${shimRun.exitCode}: ${shimText.trim()}`);
  }

  // ---- A second run over a valid install ----------------------------------------------------------

  const second = await install({
    release: releaseDirectory,
    stage: 'second run',
    home: happy.home,
    bun: currentBun,
  });
  const leftovers = existsSync(installDir)
    ? readdirSync(installDir).filter((entry) => entry.startsWith('.cosyncing'))
    : ['<install directory is gone>'];
  check('a second run over a valid install succeeds, retires the old web root, and leaves no staging',
    second.exitCode === 0 && existsSync(join(webRoot, 'index.html'))
      && leftovers.length === 0
      && inspectOwnerOnlyDirectory(webRoot).status === 'ok',
    `${second.exitCode}: ${leftovers.join(',')} ${second.stderr.trim().slice(0, 200)}`);

  // The one window in which the operator's PREVIOUS web client exists only under a staging name. The
  // cleanup contract is that it goes back, never gets discarded — losing it would leave a host with no web
  // client at all. No filesystem trick makes the second rename fail on demand, so the failure is injected
  // between the two renames in a copy of the rendered script and what is asserted is the restore.
  {
    const release = releaseCopy('retired-web-restore');
    const installer = join(release, 'install.ps1');
    const anchor = '  Move-Item -LiteralPath $stagedApp -Destination $WEB_ROOT -Force';
    const source = readFileSync(installer, 'utf8');
    if (!source.includes(anchor)) throw new Error('rendered installer has no web root rename');
    writeFileSync(installer, source.replace(
      anchor,
      `  Fail 'injected: the web root rename failed'\n${anchor}`,
    ));
    writeFileSync(join(webRoot, 'operator-marker'), 'the previous web client\n');
    const run = await install({
      release,
      stage: 'retired web root restored',
      home: happy.home,
      bun: currentBun,
    });
    const residue = existsSync(installDir)
      ? readdirSync(installDir).filter((entry) => entry.startsWith('.cosyncing'))
      : ['<install directory is gone>'];
    check('a failure after the web root is retired puts the operator\'s previous web client back',
      run.exitCode !== 0
        && existsSync(join(webRoot, 'operator-marker'))
        && existsSync(join(webRoot, 'index.html'))
        && residue.length === 0,
      `${run.exitCode}: ${residue.join(',')} ${run.stderr.trim().slice(0, 200)}`);
  }

  // ---- Refusals -----------------------------------------------------------------------------------

  // A flipped signature byte. The whole reason the P-256 sibling signature exists is that PowerShell
  // cannot check the Ed25519 one, so this is the check that proves the Windows path has a cryptographic
  // check at all rather than resting on digests delivered by TLS.
  {
    const release = releaseCopy('flipped-signature');
    const signaturePath = join(release, 'release-manifest.json.p256.sig');
    const bytes = readFileSync(signaturePath);
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    writeFileSync(signaturePath, bytes);
    const run = await install({ release, stage: 'flipped signature', bun: currentBun });
    check('a flipped signature byte is fatal and installs nothing',
      run.exitCode !== 0
        && /release manifest signature verification failed/.test(run.stderr)
        && !existsSync(join(run.home, 'bin', 'cosyncing')),
      `${run.exitCode}: ${run.stderr.trim().slice(0, 200)}`);
  }

  // A tampered manifest, signed by nobody. Same refusal, reached through the payload rather than the
  // signature — the case that would pass if the script verified the wrong bytes.
  {
    const release = releaseCopy('tampered-manifest');
    writeFileSync(join(release, 'release-manifest.json'), ' ', { flag: 'a' });
    const run = await install({ release, stage: 'tampered manifest', bun: currentBun });
    check('a tampered manifest is fatal before any artifact is downloaded',
      run.exitCode !== 0
        && /release manifest signature verification failed/.test(run.stderr)
        && !existsSync(join(run.home, 'bin')),
      `${run.exitCode}: ${run.stderr.trim().slice(0, 200)}`);
  }

  // The embedded digest is the pin the script carries itself. A wrong one must stop the install even
  // though the signed chain is perfectly valid — the two disagreeing is the whole point of checking both.
  {
    const release = releaseCopy('wrong-embedded-digest');
    const installer = join(release, 'install.ps1');
    const source = readFileSync(installer, 'utf8');
    const table = /^\$ARTIFACT_TABLE = '([^']*)'$/m.exec(source)?.[1] ?? '';
    const rewritten = table.split('\n')
      .map((row) => (row.startsWith(`${RELEASE_JAVASCRIPT_APP_NAME} `)
        ? row.replace(/ [0-9a-f]{64} /, ` ${'a'.repeat(64)} `)
        : row))
      .join('\n');
    rewriteAssignment(installer, 'ARTIFACT_TABLE', rewritten);
    const run = await install({ release, stage: 'wrong embedded digest', bun: currentBun });
    check('a digest the installer carries that disagrees with the signed chain is fatal',
      run.exitCode !== 0
        && /signed checksum list disagrees with the digest embedded in this installer/.test(run.stderr)
        && !existsSync(join(run.home, 'bin', 'cosyncing')),
      `${run.exitCode}: ${run.stderr.trim().slice(0, 200)}`);
  }

  // One key id covers the Ed25519/P-256 pair, so pinning it is how this installer asserts the release's
  // single identity while verifying only half the signatures.
  {
    const release = releaseCopy('wrong-key-id');
    rewriteAssignment(join(release, 'install.ps1'), 'KEY_ID', 'some-other-key');
    const run = await install({ release, stage: 'wrong key id', bun: currentBun });
    check('a manifest key id that is not the pinned one is fatal',
      run.exitCode !== 0
        && /signed manifest key id does not match this pinned installer/.test(run.stderr)
        && !existsSync(join(run.home, 'bin', 'cosyncing')),
      `${run.exitCode}: ${run.stderr.trim().slice(0, 200)}`);
  }

  // `tar.exe` failing is a refusal, not a partial install. The sidecar here is correctly signed and
  // digest-correct and simply is not a tarball — the only way to reach the extraction failure, since
  // corrupting the shipped archive stops at the digest check instead.
  {
    const release = assembleBrokenWebSidecarRelease();
    const run = await install({ release, stage: 'broken web sidecar', bun: currentBun });
    const residue = existsSync(join(run.home, 'bin')) ? readdirSync(join(run.home, 'bin')) : [];
    check('a web sidecar tar cannot unpack is fatal and leaves no staging directory behind',
      run.exitCode !== 0
        && /web client archive could not be extracted/.test(run.stderr)
        && !existsSync(join(run.home, 'bin', 'cosyncing'))
        && residue.every((entry) => !entry.startsWith('.cosyncing')),
      `${run.exitCode}: ${residue.join(',')} ${run.stderr.trim().slice(0, 200)}`);
  }

  // Receipt 1 recorded a compiled per-host executable. Overwriting one with a JavaScript bundle would
  // leave a Scheduled Task naming a file that is no longer an executable.
  {
    const home = join(root, 'home-compiled-install');
    mkdirSync(join(home, 'bin'), { recursive: true });
    writeFileSync(join(home, 'bin', 'cosyncing'), 'fixture compiled build\n');
    writeFileSync(join(home, 'bootstrap-receipt'), [
      'schemaVersion=1',
      'product=cosyncing',
      `version=${VERSION}`,
      'target=windows-x64',
      `binary=${join(home, 'bin', 'cosyncing')}`,
      `sha256=${sha256(readFileSync(join(home, 'bin', 'cosyncing')))}`,
      '',
    ].join('\n'));
    const run = await install({
      release: releaseDirectory,
      stage: 'compiled receipt',
      home,
      bun: currentBun,
    });
    check('a schemaVersion=1 receipt is refused with the message that names the remedy',
      run.exitCode !== 0
        && /this path holds a compiled cosyncing install/.test(run.stderr)
        && readFileSync(join(home, 'bin', 'cosyncing'), 'utf8') === 'fixture compiled build\n',
      `${run.exitCode}: ${run.stderr.trim().slice(0, 200)}`);
  }

  // An existing `cosy.cmd` that this installer did not write is somebody else's file.
  {
    const home = join(root, 'home-foreign-shim');
    mkdirSync(join(home, 'bin'), { recursive: true });
    writeFileSync(join(home, 'bin', 'cosy.cmd'), '@echo somebody else owns this name\r\n');
    const run = await install({
      release: releaseDirectory,
      stage: 'foreign shim',
      home,
      bun: currentBun,
    });
    check('an unowned cosy path is refused rather than replaced',
      run.exitCode !== 0
        && /refusing to replace an unowned cosy path/.test(run.stderr)
        && readFileSync(join(home, 'bin', 'cosy.cmd'), 'utf8').includes('somebody else'),
      `${run.exitCode}: ${run.stderr.trim().slice(0, 200)}`);
  }

  /**
   * Stub what the kernel says the NATIVE machine is, in a copy of the rendered script.
   *
   * There is no environment override for this in the template and there must not be — an installer whose
   * host refusal can be turned off by a variable does not have a host refusal. Only `IsWow64Process2`'s
   * answer is replaced, so the `IMAGE_FILE_MACHINE` mapping, the choice of refusal and the wording all
   * run for real; the one thing a test cannot do is make this host be an ARM64 machine.
   */
  function stubNativeMachine(installer: string, value: string): void {
    const anchor = 'function Get-NativeMachineValue {';
    const source = readFileSync(installer, 'utf8');
    if (!source.includes(anchor)) throw new Error('rendered installer has no native-machine probe');
    writeFileSync(installer, source.replace(anchor, `${anchor}\n  return [uint16] ${value}`));
  }

  // The refusal this whole probe exists for. `RuntimeInformation.OSArchitecture` cannot reach it: on
  // .NET Framework it reports the EMULATED architecture to an x64 process on an ARM64 machine, so an
  // installer keyed on it would admit exactly the host the product refuses.
  {
    const release = releaseCopy('arm64-machine');
    stubNativeMachine(join(release, 'install.ps1'), '0xaa64');
    const run = await install({ release, stage: 'arm64 machine', bun: currentBun });
    check('an ARM64 native machine is refused with the product\'s own not-yet-qualified wording',
      run.exitCode !== 0
        && /Windows ARM64 is not yet qualified for this broker/.test(run.stderr)
        && /Run the broker on Windows x64/.test(run.stderr)
        && !existsSync(run.home),
      `${run.exitCode}: ${run.stderr.trim().slice(0, 200)}`);
  }

  // Any other machine is refused too, and the message names what the kernel reported rather than
  // claiming ARM64. `0x01c4` is IMAGE_FILE_MACHINE_ARMNT — a machine no cosyncing artifact targets.
  {
    const release = releaseCopy('other-machine');
    stubNativeMachine(join(release, 'install.ps1'), '0x01c4');
    const run = await install({ release, stage: 'other machine', bun: currentBun });
    check('a machine that is neither x64 nor ARM64 is refused by the name the kernel gave it',
      run.exitCode !== 0
        && /this installer supports Windows x64; this machine reports IMAGE_FILE_MACHINE 0x01c4/
          .test(run.stderr)
        && !existsSync(run.home),
      `${run.exitCode}: ${run.stderr.trim().slice(0, 200)}`);
  }

  // The elevation refusal, forced on whatever kind of host this is. On the physical unelevated host the
  // probe is stubbed `$true`; on an elevated runner the pristine script is restored and refuses for real.
  // Either way the assertion is identical, so the refusal is proven on both rather than being a property
  // of how the suite happened to be launched.
  {
    const release = releaseCopy('elevated');
    const installer = join(release, 'install.ps1');
    writeFileSync(installer, pristineInstaller);
    if (!HOST_IS_ELEVATED) stubProbe(installer, ELEVATION_PROBE, '$true');
    const run = await install({ release, stage: 'elevated install', bun: currentBun });
    check('an elevated install is refused before anything is created',
      run.exitCode !== 0
        && /refusing an elevated install/.test(run.stderr)
        && /as the user who will own the broker/.test(run.stderr)
        && !existsSync(run.home),
      `${HOST_IS_ELEVATED ? 'real' : 'stubbed'} — ${run.exitCode}: ${run.stderr.trim().slice(0, 160)}`);
  }

  // The one refusal an operator can trigger by typing, and the only place the template reads a path it
  // did not build. A relative value would resolve against whatever directory the shell happened to be in.
  {
    const run = await install({
      release: releaseDirectory,
      stage: 'relative state home',
      bun: currentBun,
      env: { COSYNCING_HOME: 'cosyncing-relative' },
    });
    check('a relative COSYNCING_HOME is refused before anything is created',
      run.exitCode !== 0
        && /COSYNCING_HOME must be absolute when set/.test(run.stderr)
        && !existsSync(join(SYSTEM_ROOT, 'cosyncing-relative')),
      `${run.exitCode}: ${run.stderr.trim().slice(0, 200)}`);
  }

  // ---- Bun ----------------------------------------------------------------------------------------

  // The runtime that executes every verified artifact is held to the artifacts' own rule. The rendered
  // installer carries Bun's real published digests, so a substituted archive is refused with nothing
  // repointed: the fixture zip simply is not the bytes Bun published for this tag.
  {
    const release = releaseCopy('bun-substituted');
    await writeBunArchive(release, 'bun-windows-x64.zip', pinnedBun);
    const bunInstall = join(root, 'bun-prefix-substituted');
    const run = await install({
      release,
      stage: 'substituted Bun archive',
      bun: staleBun,
      bunInstall,
      hideBun: true,
    });
    check('a substituted Bun archive is refused against the checksum embedded in the installer',
      run.exitCode !== 0
        && /does not match the checksum embedded in this installer/.test(run.stderr)
        && !existsSync(join(bunInstall, 'bin', 'bun.exe'))
        && !existsSync(join(run.home, 'bin', 'cosyncing')),
      `${run.exitCode}: ${run.stderr.trim().slice(0, 250)}`);
  }

  // A host whose Bun is below the floor gets the pinned archive, and the receipt records THAT runtime
  // rather than the stale one the host already had.
  {
    const release = releaseCopy('bun-install');
    const digest = await writeBunArchive(release, 'bun-windows-x64.zip', pinnedBun);
    rewriteAssignment(join(release, 'install.ps1'), 'BUN_TABLE',
      `windows-x64 bun-windows-x64.zip ${digest}`);
    const bunInstall = join(root, 'bun-prefix-install');
    const run = await install({
      release,
      stage: 'pinned Bun install',
      bun: staleBun,
      bunInstall,
      hideBun: true,
    });
    const installedBun = join(bunInstall, 'bin', 'bun.exe');
    check('a host whose Bun is below the floor gets the pinned archive, not the stale runtime',
      run.exitCode === 0 && existsSync(installedBun)
        && readFileSync(join(run.home, 'bootstrap-receipt'), 'utf8')
          .includes(`runtime=${installedBun}\n`)
        && run.stdout.includes('Installing the pinned Bun')
        && run.stdout.includes(`Bun runtime: installed by this script (${MINIMUM_BUN_RUNTIME_VERSION}`),
      `${run.exitCode}: ${run.stdout.trim().split('\n').slice(-4).join(' | ')} ${run.stderr.trim().slice(0, 250)}`);
  }

  // One host target is not one binary: a pre-AVX2 x64 needs the baseline build. A pinned build that
  // cannot run here is the wrong candidate, not a failed install.
  {
    const release = releaseCopy('bun-fallback');
    const plainDigest = await writeBunArchive(release, 'bun-windows-x64.zip', unrunnableBun);
    const baselineDigest = await writeBunArchive(
      release, 'bun-windows-x64-baseline.zip', pinnedBun);
    rewriteAssignment(join(release, 'install.ps1'), 'BUN_TABLE', [
      `windows-x64 bun-windows-x64.zip ${plainDigest}`,
      `windows-x64 bun-windows-x64-baseline.zip ${baselineDigest}`,
    ].join('\n'));
    const bunInstall = join(root, 'bun-prefix-fallback');
    const run = await install({
      release,
      stage: 'pinned Bun fallback',
      bun: staleBun,
      bunInstall,
      hideBun: true,
    });
    check('a pinned build that cannot run on this host advances to the next pinned build',
      run.exitCode === 0 && existsSync(join(bunInstall, 'bin', 'bun.exe'))
        && /does not run on this host; trying the next pinned build/.test(run.stdout),
      `${run.exitCode}: ${run.stdout.trim().split('\n').slice(-5).join(' | ')} ${run.stderr.trim().slice(0, 250)}`);
  }

  // An operator who does not want this script installing a runtime gets a refusal naming the floor,
  // rather than a silent install of a bundle nothing on the host can execute.
  {
    const run = await install({
      release: releaseDirectory,
      stage: 'skip Bun install',
      bun: staleBun,
      hideBun: true,
      env: { COSYNCING_SKIP_BUN_INSTALL: '1' },
    });
    check('COSYNCING_SKIP_BUN_INSTALL=1 refuses by naming the floor instead of downloading a runtime',
      run.exitCode !== 0
        && run.stderr.includes(`Bun ${MINIMUM_BUN_RUNTIME_VERSION} or newer is required`)
        && run.stderr.includes('COSYNCING_SKIP_BUN_INSTALL=1')
        && !existsSync(join(run.home, 'bin', 'cosyncing')),
      `${run.exitCode}: ${run.stderr.trim().slice(0, 250)}`);
  }

  // The rendered installer must carry the real Windows rows, so an operator's install reaches Bun's own
  // tagged release rather than whatever a fixture repointed it at.
  {
    const source = readFileSync(join(releaseDirectory, 'install.ps1'), 'utf8');
    const rows = (/^\$BUN_TABLE = '([^']*)'$/m.exec(source)?.[1] ?? '')
      .split('\n')
      .filter((row) => row.startsWith('windows-x64 '));
    const pinned = PINNED_BUN_RUNTIME_ARCHIVES['windows-x64'] ?? [];
    check('the published installer carries the real pinned windows-x64 Bun rows',
      rows.length === pinned.length
        && pinned.every((build, index) => rows[index] === `windows-x64 ${build.asset} ${build.sha256}`),
      rows.join(' | '));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length}/${results.length} install.ps1 checks failed.`);
  process.exit(1);
}
console.log(`\nPASS ${results.length}/${results.length} install.ps1 checks`);
