import { bunSpawnSyncResolvedInvocation, resolveInvocation } from '@cosyncing/adapter-api';
import { statSync } from 'node:fs';

export interface OpencodeGeneration {
  kind: 'v1' | 'v2' | 'future' | 'unparsable' | 'absent';
  version?: string;
  executable?: string;
}

export function normalizeOpencodeVersion(raw: string): string {
  return raw.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] ?? raw.trim().split(/\s+/)[0] ?? '';
}

/** Disable in-place updates only for children cosyncing starts. */
export function opencodeChildEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return { ...env, OPENCODE_DISABLE_AUTOUPDATE: '1' };
}

const cache = new Map<string, { result: OpencodeGeneration; expiresAt: number }>();

/** Stat on every use so a replacement binary is noticed before any lifecycle or CLI action.
 * Unknown output retains the historical V1 path; it must not become a new version floor. */
export function opencodeGeneration(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  command = 'opencode',
): OpencodeGeneration {
  const invocation = resolveInvocation(command, { env, platform });
  if (!invocation) return { kind: 'absent' };
  const executable = invocation.originalPath;
  let identity: string | undefined;
  try {
    const stat = statSync(executable);
    identity = `${executable}\0${stat.size}\0${stat.mtimeMs}`;
  } catch { /* An unstatable executable is probed without caching. */ }
  const now = Date.now();
  const remembered = identity ? cache.get(identity) : undefined;
  if (remembered && remembered.expiresAt > now) return remembered.result;
  let version: string | undefined;
  try {
    const result = bunSpawnSyncResolvedInvocation(invocation, ['--version'], {
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      env: opencodeChildEnv(env), timeout: 3000, windowsHide: platform === 'win32',
    });
    if (result.exitCode === 0) version = normalizeOpencodeVersion(new TextDecoder().decode(result.stdout)) || undefined;
  } catch { /* A failed or hung probe preserves the historical unknown-version behavior. */ }
  const major = version?.match(/^(\d+)\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/)?.[1];
  const kind = major === '1' ? 'v1' : major === '2' ? 'v2' : major && Number(major) >= 3 ? 'future' : 'unparsable';
  const result: OpencodeGeneration = { kind, executable, ...(version ? { version } : {}) };
  if (identity) {
    cache.set(identity, { result, expiresAt: now + (kind === 'unparsable' ? 30_000 : 300_000) });
    while (cache.size > 64) cache.delete(cache.keys().next().value!);
  }
  return result;
}

export function opencodeAllowsV1(generation: OpencodeGeneration): boolean {
  // Missing/unknown binaries keep the historical V1 read and missing-CLI behavior.
  return generation.kind !== 'v2' && generation.kind !== 'future';
}

export const OPENCODE_V1_READ_ONLY_REASON = 'cosyncing supports OpenCode 1; the installed OpenCode generation is detected but not yet supported. These V1 sessions remain read-only.';
