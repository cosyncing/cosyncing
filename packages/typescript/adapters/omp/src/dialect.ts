/**
 * omp (oh-my-pi) dialect descriptor.
 *
 * Every value here is a measured delta from the pi dialect (see the investigation's facts section
 * in docs-internal): the `omp` binary, `~/.omp/agent` (honoring PI_CONFIG_DIR), the XDG sessions
 * redirect, `get_available_commands`, no RPC fork/clone, omp-owned title entries, and the combined
 * `provider/modelId` model_change shape. The engine itself is unchanged — it reads this descriptor.
 */
import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  ompDefaultSessionsRoot,
  ompParseModelChange,
  PI_DIALECT,
  resolvePiDialectPaths,
  type PiDialect,
} from '@cosyncing/pi-engine';

export const OMP_DIALECT: PiDialect = {
  toolId: 'omp',
  displayName: 'omp',
  bin: 'omp',
  binEnvOverride: 'COSYNCING_OMP_BIN',
  sessionsRootEnvOverrides: ['COSYNCING_OMP_SESSIONS_ROOT', 'PI_CODING_AGENT_SESSION_DIR'],
  // Dedicated override wins. The inherited Pi variable remains compatible when Pi is not enabled,
  // while inspectOmpPathCollision fails closed if it would collapse the two shipped adapters.
  agentDirEnvOverrides: ['COSYNCING_OMP_AGENT_DIR', 'PI_CODING_AGENT_DIR'],
  nameScanBytesEnvOverride: 'COSYNCING_OMP_NAME_SCAN_BYTES',
  bridgeAutoinstallEnvOverride: 'COSYNCING_OMP_BRIDGE_AUTOINSTALL',
  bridgeRoutePrefix: '/omp/bridge',
  rpcAliases: { getCommands: 'get_available_commands' },
  lifecycleCommands: { fork: false, clone: false },
  // omp owns its title natively: the durable leading `title` slot plus `title_change` events,
  // read last-write-wins. session_info stays readable for migrated/pi-shaped files.
  titleEntryTypes: ['session_info', 'title', 'title_change'],
  createTimeTitle: 'native',
  eventKeyNamespace: 'omp:run:',
  eventSources: { rpc: 'omp-rpc', jsonl: 'omp-jsonl', bridge: 'omp-bridge' },
  parseModelChange: ompParseModelChange,
  defaultAgentDir: (env) => join(env.HOME?.trim() || homedir(), env.PI_CONFIG_DIR?.trim() || '.omp', 'agent'),
  defaultSessionsRoot: ompDefaultSessionsRoot,
};

export interface OmpPathCollision {
  code: 'omp-pi-path-collision';
  agentDirCollision: boolean;
  sessionsRootCollision: boolean;
  piAgentDir: string;
  ompAgentDir: string;
  piSessionsRoot: string;
  ompSessionsRoot: string;
  summary: string;
  remediation: string;
}

/**
 * Resolve the existing prefix through the filesystem, then retain any suffix that setup has not
 * created yet. This catches two symlink aliases of the same target without requiring bridge or
 * session directories to exist already.
 */
function canonicalPathIdentity(path: string, platform: string): string {
  let existingPrefix = resolve(path);
  const missingSuffix: string[] = [];
  const foldMissingComponent = (component: string): string =>
    platform === 'darwin' || platform === 'win32'
      ? component.normalize('NFC').toLocaleLowerCase('en-US')
      : component;
  for (;;) {
    try {
      return resolve(
        realpathSync.native(existingPrefix),
        ...missingSuffix.reverse().map(foldMissingComponent),
      );
    } catch {
      const parent = dirname(existingPrefix);
      if (parent === existingPrefix) {
        const unresolved = resolve(path);
        return platform === 'darwin' || platform === 'win32'
          ? unresolved.normalize('NFC').toLocaleLowerCase('en-US')
          : unresolved;
      }
      missingSuffix.push(basename(existingPrefix));
      existingPrefix = parent;
    }
  }
}

/**
 * Pi and omp inherit the same native path variables. With both adapters shipped, resolving either
 * bridge target or session store to the same path is unsafe: discovery duplicates rows and either
 * bridge installer can overwrite the other dialect's asset.
 */
export function inspectOmpPathCollision(
  env: NodeJS.ProcessEnv,
  platform: string = process.platform,
): OmpPathCollision | undefined {
  const pi = resolvePiDialectPaths(PI_DIALECT, env);
  const omp = resolvePiDialectPaths(OMP_DIALECT, env);
  const same = (left: string, right: string) =>
    canonicalPathIdentity(left, platform) === canonicalPathIdentity(right, platform);
  const agentDirCollision = same(pi.agentDir, omp.agentDir);
  const sessionsRootCollision = same(pi.sessionsRoot, omp.sessionsRoot);
  if (!agentDirCollision && !sessionsRootCollision) return undefined;
  const collided = [
    ...(agentDirCollision ? ['bridge extension target'] : []),
    ...(sessionsRootCollision ? ['session store'] : []),
  ].join(' and ');
  return {
    code: 'omp-pi-path-collision',
    agentDirCollision,
    sessionsRootCollision,
    piAgentDir: pi.agentDir,
    ompAgentDir: omp.agentDir,
    piSessionsRoot: pi.sessionsRoot,
    ompSessionsRoot: omp.sessionsRoot,
    summary: `Pi and omp resolve to the same ${collided}.`,
    remediation: 'Set COSYNCING_PI_AGENT_DIR/COSYNCING_OMP_AGENT_DIR and COSYNCING_PI_SESSIONS_ROOT/COSYNCING_OMP_SESSIONS_ROOT to distinct paths, or unset the shared PI_CODING_AGENT_DIR and PI_CODING_AGENT_SESSION_DIR overrides.',
  };
}
