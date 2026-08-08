/**
 * The build-time identity every cosyncing artifact is stamped with, in one place.
 *
 * Two builders emit artifacts — the compiled native executable and the JavaScript application bundle — and
 * both must stamp the SAME version, commit, dirtiness, build date, schema versions, and contract, or two
 * artifacts from one tree would disagree about what they are. Only the distribution kind and the artifact
 * target legitimately differ between them, so those are the arguments.
 */
import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PUBLISHED_SCHEMA_VERSIONS } from '../../../packages/typescript/broker/src/build-info.ts';
import {
  isDistributionKind,
  type DistributionKind,
} from '../../../packages/typescript/broker/src/application-identity.ts';
import { BROKER_CONTRACT } from '../../../packages/typescript/protocol/src/index.ts';

export interface ReleaseChannelInputs {
  releaseManifestUrl?: string;
  releaseChannelManifestUrl?: string;
  releaseKeyId?: string;
  releasePublicKeyPath?: string;
}

export interface BuildIdentityInputs extends ReleaseChannelInputs {
  /** Candidate/test builds only. Absent means the canonical root package.json version. */
  version?: string;
  buildDate?: string;
  commit?: string;
  requireClean: boolean;
}

export interface BuildIdentity {
  version: string;
  commit: string;
  buildDate: string;
  dirty: boolean;
}

function gitValue(args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'ignore' });
  return result.success ? result.stdout.toString().trim() : '';
}

export function gitCommit(): string {
  return gitValue(['rev-parse', 'HEAD']) || 'unknown';
}

export function gitDirty(): boolean {
  const result = Bun.spawnSync(['git', 'status', '--porcelain', '--untracked-files=normal'], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  return !result.success || result.stdout.toString().trim().length > 0;
}

export function canonicalRootVersion(explicit?: string): string {
  const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version?: unknown };
  const version = (explicit ?? (typeof packageJson.version === 'string' ? packageJson.version : '')).trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || version === '0.0.0') {
    throw new Error(`refusing to package invalid canonical root version ${JSON.stringify(version)}`);
  }
  return version;
}

export function resolvedBuildDate(explicit?: string): string {
  const epoch = process.env.SOURCE_DATE_EPOCH?.trim();
  const value = explicit ?? (epoch && /^\d+$/.test(epoch)
    ? new Date(Number(epoch) * 1_000).toISOString()
    : new Date().toISOString());
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`build date must be a canonical ISO-8601 instant, received ${JSON.stringify(value)}`);
  }
  return value;
}

export function resolveBuildIdentity(options: BuildIdentityInputs): BuildIdentity {
  const version = canonicalRootVersion(options.version);
  const buildDate = resolvedBuildDate(options.buildDate);
  const commit = options.commit?.trim() || gitCommit();
  if (commit !== 'unknown' && !/^[a-f0-9]{7,64}$/.test(commit)) {
    throw new Error('build commit must be lowercase hexadecimal');
  }
  const dirty = gitDirty();
  if (options.requireClean && dirty) throw new Error('release build requires a clean checkout');
  return { version, commit, buildDate, dirty };
}

function safeHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !/[\0\r\n]/.test(value);
  } catch {
    return false;
  }
}

export function releaseDefines(options: Readonly<ReleaseChannelInputs>): Record<string, string> {
  const supplied = [
    options.releaseManifestUrl,
    options.releaseChannelManifestUrl,
    options.releaseKeyId,
    options.releasePublicKeyPath,
  ].filter((value) => value !== undefined).length;
  if (supplied === 0) return {};
  if (supplied !== 4) {
    throw new Error('release manifest URL, stable-channel manifest URL, key id, and public key must be supplied together');
  }
  if (!safeHttpsUrl(options.releaseManifestUrl!)) throw new Error('release manifest URL must be credential-free HTTPS');
  if (!safeHttpsUrl(options.releaseChannelManifestUrl!)) throw new Error('release channel manifest URL must be credential-free HTTPS');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(options.releaseKeyId!)) throw new Error('release key id is invalid');
  const publicKey = readFileSync(options.releasePublicKeyPath!, 'utf8').trim();
  const parsed = createPublicKey(publicKey);
  if (parsed.asymmetricKeyType !== 'ed25519') throw new Error('release public key must be Ed25519');
  return {
    COSYNCING_RELEASE_MANIFEST_URL: JSON.stringify(options.releaseManifestUrl),
    COSYNCING_RELEASE_CHANNEL_MANIFEST_URL: JSON.stringify(options.releaseChannelManifestUrl),
    COSYNCING_RELEASE_KEY_ID: JSON.stringify(options.releaseKeyId),
    COSYNCING_RELEASE_PUBLIC_KEY_PEM: JSON.stringify(`${publicKey}\n`),
  };
}

/**
 * Every `define` a cosyncing artifact carries. `distribution` is validated here rather than trusted, so a
 * builder cannot stamp a kind the runtime would silently reinterpret as `source`.
 */
export function buildDefines(options: {
  identity: Readonly<BuildIdentity>;
  distribution: DistributionKind;
  target: string;
  release: Readonly<ReleaseChannelInputs>;
}): Record<string, string> {
  if (!isDistributionKind(options.distribution)) {
    throw new Error(`refusing to stamp unknown distribution kind ${JSON.stringify(options.distribution)}`);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(options.target)) {
    throw new Error(`refusing to stamp invalid build target ${JSON.stringify(options.target)}`);
  }
  return {
    COSYNCING_BUILD_VERSION: JSON.stringify(options.identity.version),
    COSYNCING_BUILD_COMMIT: JSON.stringify(options.identity.commit),
    COSYNCING_BUILD_DATE: JSON.stringify(options.identity.buildDate),
    COSYNCING_BUILD_TARGET: JSON.stringify(options.target),
    COSYNCING_BUILD_DISTRIBUTION: JSON.stringify(options.distribution),
    COSYNCING_BUILD_DIRTY: options.identity.dirty ? 'true' : 'false',
    COSYNCING_BUILD_SCHEMA_VERSIONS: JSON.stringify(JSON.stringify(PUBLISHED_SCHEMA_VERSIONS)),
    COSYNCING_BUILD_CONTRACT: JSON.stringify(JSON.stringify(BROKER_CONTRACT)),
    ...releaseDefines(options.release),
  };
}

export { PUBLISHED_SCHEMA_VERSIONS, BROKER_CONTRACT };
