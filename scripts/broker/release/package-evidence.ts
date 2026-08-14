#!/usr/bin/env bun
import { hostname, tmpdir } from 'node:os';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  BUILD_INFO_SCHEMA_VERSION,
  PUBLISHED_SCHEMA_VERSIONS,
  type BuildInfo,
} from '../../../packages/typescript/broker/src/runtime/build-info.ts';
import { PRODUCT_IDENTITY } from '../../../packages/typescript/protocol/src/product.ts';
import { BROKER_CONTRACT } from '../../../packages/typescript/protocol/src/index.ts';
import {
  KNOWN_RELEASE_TARGETS,
  releaseTargetArch,
  releaseTargetPlatform,
  sha256,
  type PackageEvidence,
  type ReleaseTarget,
} from './release-files.ts';

const ROOT = resolve(import.meta.dir, '../../..');

interface EvidenceOptions {
  artifactPath: string;
  outputPath: string;
  target: ReleaseTarget;
  version: string;
  sourceCommit: string;
  buildDate: string;
}

interface ArtifactScanContext {
  root: string;
  home: string;
  hostname: string;
  environment: Record<string, string | undefined>;
}

interface ForbiddenValue {
  label: string;
  value: string;
  allowedPrefixes?: string[];
}

function gitClean(): boolean {
  const result = Bun.spawnSync(['git', 'status', '--porcelain', '--untracked-files=normal'], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  return result.success && result.stdout.toString().trim() === '';
}

function allowedBuildHomePrefixes(target: ReleaseTarget, home: string): string[] {
  // Bun's darwin-arm64 runtime carries WebKit/JSC assertion source paths from Bun's own hosted build.
  // They are part of the upstream runtime even when this artifact is cross-compiled on Linux; they are
  // not paths from the cosyncing build host. Keep the exception exact so any checkout, credential, or
  // other home-relative path still fails the evidence check.
  const upstreamRunnerHome = ['', 'Users', 'runner'].join('/');
  if (target !== 'darwin-arm64' || home !== upstreamRunnerHome) return [];
  return [`${upstreamRunnerHome}/work/_temp/webkit-release/`];
}

function hasUnapprovedOccurrence(bytes: Buffer, item: ForbiddenValue): boolean {
  const needle = Buffer.from(item.value, 'utf8');
  let offset = 0;
  while (offset <= bytes.length - needle.length) {
    const index = bytes.indexOf(needle, offset);
    if (index < 0) return false;
    const accepted = item.allowedPrefixes?.some((prefix) =>
      bytes.subarray(index, index + Buffer.byteLength(prefix)).equals(Buffer.from(prefix, 'utf8')));
    if (!accepted) return true;
    offset = index + needle.length;
  }
  return false;
}

export function forbiddenArtifactContent(
  bytes: Buffer,
  target: ReleaseTarget,
  context: ArtifactScanContext = {
    root: ROOT,
    home: process.env.HOME ?? '',
    hostname: hostname(),
    environment: process.env,
  },
): string | undefined {
  const hostMarkers = [context.hostname, context.environment.COSYNCING_MACHINE ?? '']
    .filter((value) => /[.0-9_:-]/.test(value) || value.length > 20)
    .map((value) => ({ label: 'private build hostname', value }));
  const values: ForbiddenValue[] = [
    { label: 'repository root', value: context.root },
    {
      label: 'build home',
      value: context.home,
      allowedPrefixes: allowedBuildHomePrefixes(target, context.home),
    },
    ...hostMarkers,
  ];
  for (const [name, value] of Object.entries(context.environment)) {
    if (value && value.length >= 8 && /(?:TOKEN|SECRET|PRIVATE_KEY|PASSWORD|CREDENTIAL)/i.test(name)) {
      values.push({ label: `environment secret ${name}`, value });
    }
  }
  return values
    .filter((item, index, all) =>
      item.value.length >= 4 && all.findIndex((candidate) => candidate.value === item.value) === index)
    .find((item) => hasUnapprovedOccurrence(bytes, item))
    ?.label;
}

const architectureForTarget = releaseTargetArch;

async function offlineVersion(binary: string): Promise<BuildInfo> {
  const isolated = mkdtempSync(join(tmpdir(), 'cosyncing-package-evidence-'));
  try {
    const home = join(isolated, 'home');
    const child = Bun.spawn([binary, 'version', '--json'], {
      cwd: isolated,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        COSYNCING_HOME: join(home, '.cosyncing'),
        COSYNCING_CACHE_DIR: join(home, '.cache', 'cosyncing'),
        LANG: 'C.UTF-8',
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`offline version check failed: ${stderr.trim().slice(0, 160)}`);
    return JSON.parse(stdout) as BuildInfo;
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
}

export async function createPackageEvidence(options: EvidenceOptions): Promise<PackageEvidence> {
  // Evidence is only ever produced ON the target host: the offline `version --json` probe below executes the
  // artifact, so a cross-compiled binary can never be self-attested from the build host.
  if (process.platform !== releaseTargetPlatform(options.target)
      || process.arch !== architectureForTarget(options.target)) {
    throw new Error(`native package evidence for ${options.target} requires a matching ${releaseTargetPlatform(options.target)} runner`);
  }
  const cleanCheckout = gitClean();
  if (!cleanCheckout) throw new Error('native package evidence requires a clean checkout');
  const bytes = readFileSync(options.artifactPath);
  const stats = lstatSync(options.artifactPath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0) throw new Error('release artifact is not a regular file');
  const forbidden = forbiddenArtifactContent(bytes, options.target);
  if (forbidden) throw new Error(`release artifact contains forbidden ${forbidden}`);

  chmodSync(options.artifactPath, 0o755);
  const info = await offlineVersion(options.artifactPath);
  if (info.schemaVersion !== BUILD_INFO_SCHEMA_VERSION || info.version !== options.version
      || info.commit !== options.sourceCommit
      || info.buildDate !== options.buildDate || info.target !== options.target
      // Evidence for a NATIVE release artifact must come from a native build. `packaged` alone would also
      // accept the JavaScript distribution, which this lane must never attest as a signed binary.
      || info.distribution !== 'native' || info.packaged !== true || info.dirty !== false
      || JSON.stringify(info.schemaVersions) !== JSON.stringify(PUBLISHED_SCHEMA_VERSIONS)
      || JSON.stringify(info.contract) !== JSON.stringify(BROKER_CONTRACT)) {
    throw new Error('offline version metadata does not match the native package request');
  }
  const artifact = `${PRODUCT_IDENTITY.releaseAssetPrefix}-${options.target}`;
  if (options.artifactPath.split('/').pop() !== artifact) throw new Error(`artifact must be named ${artifact}`);
  const evidence: PackageEvidence = {
    schemaVersion: 1,
    product: PRODUCT_IDENTITY.productName,
    artifact,
    version: options.version,
    target: options.target,
    sourceCommit: options.sourceCommit,
    buildDate: options.buildDate,
    size: stats.size,
    sha256: sha256(bytes),
    packaged: true,
    dirty: false,
    schemaVersions: PUBLISHED_SCHEMA_VERSIONS,
    contract: info.contract,
    cleanCheckout: true,
    offlineVersionCheck: true,
    forbiddenContentCheck: true,
    runner: {
      os: releaseTargetPlatform(options.target),
      arch: architectureForTarget(options.target),
      image: process.env.ImageOS && process.env.ImageVersion
        ? `${process.env.ImageOS}-${process.env.ImageVersion}`
        : process.env.RUNNER_IMAGE || `local-${releaseTargetPlatform(options.target)}`,
      invocationId: process.env.GITHUB_RUN_ID || `local-${options.sourceCommit.slice(0, 12)}`,
    },
  };
  writeFileSync(options.outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
  return evidence;
}

function usage(): never {
  console.error(`Usage: bun run scripts/broker/release/package-evidence.ts --artifact PATH --output PATH --target ${KNOWN_RELEASE_TARGETS.join('|')} --version X.Y.Z --commit HEX --build-date ISO`);
  process.exit(2);
}

function parseArgs(argv: string[]): EvidenceOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) usage();
    values.set(key, value);
  }
  const artifact = values.get('--artifact');
  const output = values.get('--output');
  const target = values.get('--target');
  const version = values.get('--version');
  const sourceCommit = values.get('--commit');
  const buildDate = values.get('--build-date');
  if (!artifact || !output || !target || !version || !sourceCommit || !buildDate
      || !KNOWN_RELEASE_TARGETS.includes(target as ReleaseTarget)) usage();
  return {
    artifactPath: resolve(artifact),
    outputPath: resolve(output),
    target: target as ReleaseTarget,
    version,
    sourceCommit,
    buildDate,
  };
}

if (import.meta.main) {
  const evidence = await createPackageEvidence(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(evidence));
}
