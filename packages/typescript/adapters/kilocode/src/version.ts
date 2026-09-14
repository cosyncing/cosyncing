import {
  bunSpawnSyncResolvedInvocation,
  compareSemanticVersions,
  lowestSemanticVersion,
  reportedProductVersion,
  resolveInvocation,
  type ResolvedInvocation,
} from '@cosyncing/adapter-api';
import { statSync } from 'node:fs';

/**
 * Kilo builds whose CLI, HTTP/SSE, auth and SQLite contracts were captured.
 *
 * INFORMATIONAL: it records what the evidence covers, not what may Drive.
 */
export const KILO_MEASURED_VERSIONS: readonly string[] = Object.freeze([
  '7.4.23',
]);

const KILO_MEASURED_VERSION_SET = new Set(KILO_MEASURED_VERSIONS);

/**
 * The floor, and the only version comparison that gates Kilo.
 *
 * Kilo is not ACP, so this reasoning is its own rather than borrowed from Grok.
 * Everything the adapter depends on is checked STRUCTURALLY at runtime and
 * fails closed with a specific message:
 *
 *  - SQLite shape — `schemaMatches` requires WAL journalling, the `migration`,
 *    `session`, `message` and `part` tables, and each REQUIRED_*_COLUMNS entry
 *    by name. A migrated schema is refused there, not guessed from a version.
 *  - server identity — `probeLiveServer` requires `healthy === true`, and
 *    reports 401/403 as a rejected credential rather than a version problem.
 *  - authentication — the broker mints the Basic credential and hands it to the
 *    server it launched, so it owns both ends.
 *  - ownership — Drive is confined to durable root sessions this broker created;
 *    a foreign write or transcript rewrite demotes the writer.
 *
 * An OLDER build is still refused: a capability that was never there is exactly
 * what none of the above can detect.
 */
export const KILO_MINIMUM_SUPPORTED_VERSION = lowestSemanticVersion(KILO_MEASURED_VERSIONS);

/** Retained under its original name for operator-facing copy. */
export const KILO_VERIFIED_VERSION = KILO_MINIMUM_SUPPORTED_VERSION;

export type KiloVersionStanding = 'measured' | 'newer-unmeasured' | 'below-floor' | 'unreadable';

export function kiloVersionStanding(version: string | undefined): KiloVersionStanding {
  if (!version) return 'unreadable';
  if (KILO_MEASURED_VERSION_SET.has(version)) return 'measured';
  const order = compareSemanticVersions(version, KILO_MINIMUM_SUPPORTED_VERSION);
  if (order === undefined) return 'unreadable';
  return order < 0 ? 'below-floor' : 'newer-unmeasured';
}

/** Whether this build may Drive. Measured and newer-unmeasured both qualify. */
export function kiloVersionAllowsDrive(version: string | undefined): boolean {
  const standing = kiloVersionStanding(version);
  return standing === 'measured' || standing === 'newer-unmeasured';
}

/**
 * The environment every Kilo child starts with, in-place self-updater off.
 *
 * The npm shim carries no update logic, which is misleading: the updater lives
 * in the platform binary at `@kilocode/cli-linux-x64/bin/kilo`, whose strings
 * include `KILO_DISABLE_AUTOUPDATE`. Grok drifted eleven releases under an
 * unattended broker for exactly this reason, and the gate below is weaker than
 * Grok's uncached one — it keys on path, size and mtime, so an update landing
 * while an entry is live is not noticed until that entry expires.
 *
 * Only children Cosyncing spawns are affected; `npm install -g @kilocode/cli`
 * remains the supported way to move versions deliberately.
 */
export function kiloChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, KILO_DISABLE_AUTOUPDATE: '1' };
}

const cache = new Map<string, { result: boolean; expiresAt: number }>();

function key(invocation: ResolvedInvocation): string | undefined {
  try {
    const stat = statSync(invocation.originalPath);
    return `${invocation.originalPath}\0${stat.size}\0${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
}

export function kiloVerifiedInvocation(
  command: string,
  env: NodeJS.ProcessEnv,
): ResolvedInvocation | undefined {
  const invocation = resolveInvocation(command, { env });
  if (!invocation) return undefined;
  const identity = key(invocation);
  const now = Date.now();
  const remembered = identity ? cache.get(identity) : undefined;
  if (remembered && remembered.expiresAt > now) return remembered.result ? invocation : undefined;
  let result = false;
  try {
    const probe = bunSpawnSyncResolvedInvocation(invocation, ['--version'], {
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      // Applied HERE because this is the only place the adapter starts a kilo
      // child outside the `kilo serve` descriptor. Wrapping the env handed to
      // `discoverKiloStore` LOOKED like suppression but was not: that env is
      // read only for `XDG_DATA_HOME`/`KILO_DATA_DIR` path resolution and
      // spawns nothing.
      env: kiloChildEnv(env),
      timeout: 5_000, windowsHide: true,
    });
    result = probe.exitCode === 0
      && kiloVersionAllowsDrive(reportedProductVersion(
        `${new TextDecoder().decode(probe.stdout)}\n${new TextDecoder().decode(probe.stderr)}`,
        ['kilo', 'kilocode'],
      ));
  } catch {
    result = false;
  }
  if (identity) {
    cache.set(identity, { result, expiresAt: now + (result ? 300_000 : 30_000) });
    while (cache.size > 64) cache.delete(cache.keys().next().value!);
  }
  return result ? invocation : undefined;
}
