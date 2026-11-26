import {
  probeResolvedInvocation,
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
  // 2026-11: questions (T1), background-task and wakeup report rows, `offline`/`scheduled` statuses.
  '7.5.16',
  '7.8.32',
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

/**
 * Kilo v2: Kilo rebuilt on the OpenCode V2 runtime, released as `0.0.0-v2-<build>` (the `kilo-v2`
 * line; 0.0.0-v2-239 on 2026-11-20). It installs a `kilo2` binary, keeps its own `kilo2` data and
 * config directories, and serves its API under `/api` with none of what this adapter reads (no
 * `/global/health`, `/global/event`, `prompt_async` or `question.*`). Upstream plans to rename
 * `kilo2` to `kilo` at cutover. Its version sorts below the 7.x floor, so without this it would be
 * reported as an old Kilo and the operator told to upgrade; it is named as unsupported instead.
 */
const KILO_V2_VERSION = /^0\.0\.0-v2(?:[.-]|$)/u;

/** The binary Kilo v2 installs. Only ever resolved on PATH to name it; never executed. */
export const KILO_V2_COMMAND = 'kilo2';

export type KiloVersionStanding = 'measured' | 'newer-unmeasured' | 'below-floor' | 'kilo-v2' | 'unreadable';

export function kiloVersionStanding(version: string | undefined): KiloVersionStanding {
  if (!version) return 'unreadable';
  if (KILO_V2_VERSION.test(version)) return 'kilo-v2';
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

const cache = new Map<string, { standing: KiloVersionStanding; expiresAt: number }>();

function key(invocation: ResolvedInvocation): string | undefined {
  try {
    const stat = statSync(invocation.originalPath);
    return `${invocation.originalPath}\0${stat.size}\0${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
}

/** What the configured kilo is: not on PATH, or the standing its `--version` probe reported. */
export interface KiloProbe {
  invocation?: ResolvedInvocation;
  standing: KiloVersionStanding | 'missing';
}

/**
 * The one version probe, cached by path, size and mtime. A failed or unparsable probe is
 * `unreadable`. Callers that need only the gate use {@link kiloVerifiedInvocation}; a refusal that
 * has to say WHY reads the standing from here, from the same cached probe, never a second launch.
 */
export async function probeKilo(command: string, env: NodeJS.ProcessEnv): Promise<KiloProbe> {
  const invocation = resolveInvocation(command, { env });
  if (!invocation) return { standing: 'missing' };
  const identity = key(invocation);
  const now = Date.now();
  const remembered = identity ? cache.get(identity) : undefined;
  if (remembered && remembered.expiresAt > now) return { invocation, standing: remembered.standing };
  let standing: KiloVersionStanding = 'unreadable';
  try {
    const probe = await probeResolvedInvocation(invocation, ['--version'], {
      // Applied HERE because this is the only place the adapter starts a kilo
      // child outside the `kilo serve` descriptor. Wrapping the env handed to
      // `discoverKiloStore` LOOKED like suppression but was not: that env is
      // read only for `XDG_DATA_HOME`/`KILO_DATA_DIR` path resolution and
      // spawns nothing.
      env: kiloChildEnv(env),
      timeout: 5_000, maxBuffer: 64 * 1024,
    });
    if (!probe.error && probe.status === 0) {
      standing = kiloVersionStanding(reportedProductVersion(
        `${probe.stdout}\n${probe.stderr}`,
        ['kilo', 'kilocode'],
      ));
    }
  } catch {
    standing = 'unreadable';
  }
  if (identity) {
    cache.set(identity, { standing, expiresAt: now + (kiloStandingAllowsDrive(standing) ? 300_000 : 30_000) });
    while (cache.size > 64) cache.delete(cache.keys().next().value!);
  }
  return { invocation, standing };
}

/** Whether a probed standing may Drive: the same rule as {@link kiloVersionAllowsDrive}. */
export function kiloStandingAllowsDrive(standing: KiloProbe['standing']): boolean {
  return standing === 'measured' || standing === 'newer-unmeasured';
}

export async function kiloVerifiedInvocation(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<ResolvedInvocation | undefined> {
  const probe = await probeKilo(command, env);
  return kiloStandingAllowsDrive(probe.standing) ? probe.invocation : undefined;
}
