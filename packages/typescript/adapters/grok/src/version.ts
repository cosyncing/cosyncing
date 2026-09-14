/** Exact native-version qualification for every Grok child start. */
import {
  reportedProductVersion,
  resolveInvocation,
  spawnSyncResolvedInvocation,
} from '@cosyncing/adapter-api';
import { grokVersionAllowsDrive } from './store.ts';

/**
 * The environment every Grok child starts with, in-place self-updater off.
 *
 * Grok updates itself during an ACP bring-up, not during the `--version` probe:
 * measured, a guarded and an unguarded probe both left `checked_at` unchanged,
 * while `~/.grok/logs/unified.jsonl` recorded a full bring-up in the same second
 * the binary moved 1.0.13 to 1.0.24 under an unattended broker.
 *
 * The gate above is why that matters. It revalidates on every child start and
 * correctly revokes ownership once the binary moves — but revoking is all it can
 * do. An adapter that hands its children the ambient environment is pointing
 * that gate at a target the children themselves can move, so a long-running
 * broker eventually refuses every Drive leg against a version the operator never
 * chose to install.
 *
 * `GROK_DISABLE_AUTOUPDATER` is read by the shipped binary. This suppresses
 * updates only in children Cosyncing spawns; a user's own `grok update` is
 * untouched and stays the supported way to move versions deliberately.
 */
export function grokChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, GROK_DISABLE_AUTOUPDATER: '1' };
}

/**
 * DELIBERATELY UNCACHED, unlike the cline and kilo gates.
 *
 * Grok self-updates in place. Caching this on path+size+mtime the way cline and
 * kilo do was tried and reverted: `test-grok-identity` pins two properties that
 * a cache breaks — "the version gate is re-read after a self-update instead of
 * cached", and "every lazy child start revalidates the native version and
 * revokes ownership on drift" — and the second is what stops a write-capable
 * ACP child being opened against a binary that changed under us. A stat-keyed
 * cache cannot see an update that preserves size, and the failure it would let
 * through is exactly the one this gate exists to prevent.
 *
 * The cost is one blocking `spawnSync` per sweep, measured at ~20ms against a
 * 1s budget, and it is NOT per session — `discoverSessions` calls it once. That
 * is a real cost on a shared event loop and it is the smaller of the two.
 *
 * `grokChildEnv` above reduces how often drift happens; it does not remove the
 * need for this gate. A user can still update Grok themselves at any moment,
 * which is their right, so the answer has to stay re-read rather than cached.
 */
export function grokBinaryMatchesVerifiedVersion(
  command: string,
  env: NodeJS.ProcessEnv,
): boolean {
  const invocation = resolveInvocation(command, { env });
  if (!invocation) return false;
  try {
    const probe = spawnSyncResolvedInvocation(invocation, ['--version'], {
      encoding: 'utf8',
      // Suppressed here too. `--version` was measured NOT to trigger an update,
      // but that is a property of one release of an updater we do not control,
      // and this probe runs on every Drive-eligibility question. `drive.ts`
      // already wraps the identical probe; leaving this one bare made the two
      // call sites disagree for no reason a reader could recover.
      env: grokChildEnv(env),
      timeout: 1_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    return !probe.error
      && probe.status === 0
      && grokVersionAllowsDrive(
        reportedProductVersion(`${probe.stdout}\n${probe.stderr}`, ['grok']));
  } catch {
    // Spawning can throw outright — EMFILE, EAGAIN, EACCES on the resolved
    // path. Fail closed on the version rather than letting it escape into a
    // discovery leg, where an uncaught throw empties the whole lane.
    return false;
  }
}
