import {
  probeResolvedInvocation,
  reportedProductVersion,
  resolveInvocation,
  type ResolvedInvocation,
} from '@cosyncing/adapter-api';
import { statSync } from 'node:fs';
import { clineChildEnvWithoutHubLaunch } from './hub.ts';
import { clineVersionAllowsDrive } from './store.ts';

/**
 * How long a SUCCESSFUL version probe is trusted for one executable identity.
 *
 * It was five minutes, which is shorter than the roster's own cadence: sweeps
 * landed every 5m05–5m20 on the owner's host, so nearly every sweep paid for a
 * fresh `cline --version` (1.65–2.06 s measured, a Node resolver plus the
 * compiled CLI). An hour makes that one probe per ~12 sweeps.
 *
 * It can be that long because the key below changes whenever the resolved file
 * is rewritten or replaced, which is what an install, update or downgrade does.
 * The TTL is only the backstop for what the key cannot see: the resolver's own
 * target (`bin/.cline`, `@cline/cli-<platform>`, `CLINE_BIN_PATH`) changing
 * while the resolver file stays untouched. A stale "allowed" answer in that
 * window still leaves the Hub core floor and protocol check (`probeClineHub`)
 * in front of Create, Drive and Resume.
 */
export const CLINE_VERSION_SUCCESS_TTL_MS = 60 * 60_000;
const VERSION_FAILURE_TTL_MS = 30_000;
const versionCache = new Map<string, { result: boolean; expiresAt: number }>();

/**
 * The identity of the file `resolveInvocation` landed on.
 *
 * Path, size and mtime were not enough. On a Bun or npm install that file is
 * `cline/bin/cline`, a ~5 KB Node resolver rather than the CLI, at a path with
 * no version in it (`~/.bun/install/global/node_modules/cline/bin/cline`). A
 * release that ships the same resolver bytes through an installer that keeps
 * file times would leave all three unchanged. Inode and ctime close that: a
 * reinstall writes a new file (new inode), an in-place write moves ctime, and
 * no installer can set ctime back.
 */
function invocationCacheKey(invocation: ResolvedInvocation): string | undefined {
  if (!invocation) return undefined;
  try {
    const stat = statSync(invocation.originalPath);
    return [
      invocation.originalPath,
      stat.dev,
      stat.ino,
      stat.size,
      stat.mtimeMs,
      stat.ctimeMs,
    ].join('\0');
  } catch {
    return undefined;
  }
}

export function clearClineVersionProbeCache(): void {
  versionCache.clear();
}

export async function clineVerifiedInvocation(
  command: string,
  env: NodeJS.ProcessEnv,
  clock: () => number = Date.now,
): Promise<ResolvedInvocation | undefined> {
  const invocation = resolveInvocation(command, { env });
  if (!invocation) return undefined;
  const key = invocationCacheKey(invocation);
  const now = clock();
  const cached = key ? versionCache.get(key) : undefined;
  if (cached && cached.expiresAt > now) return cached.result ? invocation : undefined;
  // Spawning can throw outright — EMFILE, EAGAIN, EACCES on the resolved path —
  // and this runs inside `discoverSessions` via `describeManagedHost`. An
  // escaping throw took the whole Cline lane out of the roster and published
  // every one of its sessions as deleted. Fail closed on the version, not on
  // the lane: kilocode's identical probe already wraps this.
  let result = false;
  try {
    const probe = await probeResolvedInvocation(invocation, ['--version'], {
      env: { ...clineChildEnvWithoutHubLaunch(env), CLINE_NO_AUTO_UPDATE: '1' },
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    result = !probe.error && probe.status === 0
      && clineVersionAllowsDrive(reportedProductVersion(
        `${probe.stdout}\n${probe.stderr}`,
        ['cline'],
      ));
  } catch {
    result = false;
  }
  if (key) {
    versionCache.set(key, {
      result,
      expiresAt: now + (result ? CLINE_VERSION_SUCCESS_TTL_MS : VERSION_FAILURE_TTL_MS),
    });
    while (versionCache.size > 64) versionCache.delete(versionCache.keys().next().value!);
  }
  return result ? invocation : undefined;
}
