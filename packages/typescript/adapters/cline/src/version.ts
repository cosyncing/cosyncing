import {
  bunSpawnSyncResolvedInvocation,
  reportedProductVersion,
  resolveInvocation,
  type ResolvedInvocation,
} from '@cosyncing/adapter-api';
import { statSync } from 'node:fs';
import { clineChildEnvWithoutHubLaunch } from './hub.ts';
import { clineVersionAllowsDrive } from './store.ts';

const VERSION_SUCCESS_TTL_MS = 5 * 60_000;
const VERSION_FAILURE_TTL_MS = 30_000;
const versionCache = new Map<string, { result: boolean; expiresAt: number }>();

function invocationCacheKey(invocation: ResolvedInvocation): string | undefined {
  if (!invocation) return undefined;
  try {
    const stat = statSync(invocation.originalPath);
    return `${invocation.originalPath}\0${stat.size}\0${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
}

export function clearClineVersionProbeCache(): void {
  versionCache.clear();
}

export function clineBinaryMatchesVerifiedVersion(
  command: string,
  env: NodeJS.ProcessEnv,
): boolean {
  return clineVerifiedInvocation(command, env) !== undefined;
}

export function clineVerifiedInvocation(
  command: string,
  env: NodeJS.ProcessEnv,
): ResolvedInvocation | undefined {
  const invocation = resolveInvocation(command, { env });
  if (!invocation) return undefined;
  const key = invocationCacheKey(invocation);
  const now = Date.now();
  const cached = key ? versionCache.get(key) : undefined;
  if (cached && cached.expiresAt > now) return cached.result ? invocation : undefined;
  // Spawning can throw outright — EMFILE, EAGAIN, EACCES on the resolved path —
  // and this runs inside `discoverSessions` via `describeManagedHost`. An
  // escaping throw took the whole Cline lane out of the roster and published
  // every one of its sessions as deleted. Fail closed on the version, not on
  // the lane: kilocode's identical probe already wraps this.
  let result = false;
  try {
    const probe = bunSpawnSyncResolvedInvocation(invocation, ['--version'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...clineChildEnvWithoutHubLaunch(env), CLINE_NO_AUTO_UPDATE: '1' },
      timeout: 5_000,
      windowsHide: true,
    });
    result = probe.exitCode === 0
      && clineVersionAllowsDrive(reportedProductVersion(
        `${new TextDecoder().decode(probe.stdout)}\n${new TextDecoder().decode(probe.stderr)}`,
        ['cline'],
      ));
  } catch {
    result = false;
  }
  if (key) {
    versionCache.set(key, {
      result,
      expiresAt: now + (result ? VERSION_SUCCESS_TTL_MS : VERSION_FAILURE_TTL_MS),
    });
    while (versionCache.size > 64) versionCache.delete(versionCache.keys().next().value!);
  }
  return result ? invocation : undefined;
}
