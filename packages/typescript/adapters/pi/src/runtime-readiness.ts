import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, join, parse, win32 } from 'node:path';
import {
  compareSemanticVersions,
  resolveInvocation,
  resolvedInvocationKind,
  semanticVersionFromText,
  spawnSyncResolvedInvocation,
  type ResolvedInvocation,
  type SetupCheck,
  type SetupCommandProbe,
  type SetupDiagnosisContext,
} from '@cosyncing/adapter-api';

export const PI_DEFAULT_NODE_MINIMUM_VERSION = '22.19.0';
export const PI_MINIMUM_SUPPORTED_VERSION = '0.78.1';
const PI_PACKAGE_NAMES: readonly string[] = [
  '@earendil-works/pi-coding-agent',
  '@mariozechner/pi-coding-agent',
];
const PACKAGE_JSON_MAX_BYTES = 256 * 1024;
const LAUNCHER_PREFIX_MAX_BYTES = 4096;
const RUNTIME_CACHE_TTL_MS = 2_000;

export interface PiRuntimeReadiness {
  ready: boolean;
  detailCode: string;
  message: string;
  executable?: string;
  nodeExecutable?: string;
  nodeVersion?: string;
  requiredNodeVersion?: string;
  packageVersion?: string;
}

interface PiPackageRuntimeContract {
  version?: string;
  minimumNodeVersion: string;
}

export type PiBoundedTextRead =
  | { ok: true; text: string }
  | { ok: false; reason: 'missing' | 'unreadable' | 'too-large' };

/**
 * The host surface Pi readiness touches: PATH resolution, two bounded reads, and one bounded
 * version probe.
 *
 * Injectable because a launcher shape is a property of the host, not of the code under test.
 * Windows resolves `pi` to a `.cmd` shim with no shebang, no symlink, and a package directory
 * beside it; none of that can be reproduced on a POSIX test runner with real files, and a rule
 * about Windows that is only ever exercised on Linux is not covered. Production supplies the real
 * filesystem and a real spawn, so the injected form changes nothing outside tests.
 */
export interface PiRuntimeHost {
  platform: string;
  /** Resolution seams shared with `resolveInvocation`, for Windows-shaped fixture paths. */
  isExecutableFile?: (path: string) => boolean;
  canonicalize?: (path: string) => string;
  /** Raw launcher head, for the POSIX shebang branch only. */
  readLauncherPrefix: (path: string, maxBytes: number) => string | undefined;
  readBoundedText: (path: string, maxBytes: number) => PiBoundedTextRead;
  /**
   * Combined stdout+stderr of a bounded, hidden `--version`.
   *
   * Takes the INVOCATION rather than a path: a Windows `.cmd` launcher is only safely spawnable
   * through the shared boundary's private cmd.exe encoding, and probing it is now part of proving
   * its identity.
   */
  probeVersionOutput: (invocation: ResolvedInvocation, env: NodeJS.ProcessEnv) => PiVersionProbe;
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

function defaultPiRuntimeHost(): PiRuntimeHost {
  return {
    platform: process.platform,
    readLauncherPrefix: (path, maxBytes) => readPrefix(path, maxBytes),
    readBoundedText: (path, maxBytes) => {
      try {
        const stat = statSync(path);
        if (!stat.isFile()) return { ok: false, reason: 'unreadable' };
        if (stat.size > maxBytes) return { ok: false, reason: 'too-large' };
        return { ok: true, text: readFileSync(path, 'utf8') };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        return { ok: false, reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable' };
      }
    },
    probeVersionOutput: (invocation, env) => boundedVersionProbe(invocation, env),
  };
}

function resolveHostInvocation(
  command: string,
  env: NodeJS.ProcessEnv,
  host: PiRuntimeHost,
): ResolvedInvocation | undefined {
  return resolveInvocation(command, {
    env,
    platform: host.platform,
    ...(host.isExecutableFile ? { isExecutableFile: host.isExecutableFile } : {}),
    ...(host.canonicalize ? { canonicalize: host.canonicalize } : {}),
  });
}

function readPrefix(path: string, maxBytes = LAUNCHER_PREFIX_MAX_BYTES): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const bytes = Buffer.alloc(maxBytes);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    return bytes.subarray(0, count).toString('utf8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
  }
}

function minimumVersionFromNodeEngine(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const lowerBound = value.match(/(?:^|[|\s])>=\s*v?(\d+\.\d+\.\d+)/)?.[1];
  if (lowerBound) return lowerBound;
  return value.trim().match(/^[~^]?v?(\d+\.\d+\.\d+)$/)?.[1];
}

function packageRuntimeContract(
  executable: string,
  readText: (path: string) => string | undefined,
): PiPackageRuntimeContract {
  let current = dirname(canonical(executable));
  const root = parse(current).root;
  for (let depth = 0; depth < 10; depth += 1) {
    const text = readText(join(current, 'package.json'));
    if (text !== undefined) {
      try {
        const pkg = JSON.parse(text) as {
          name?: unknown;
          version?: unknown;
          engines?: { node?: unknown };
        };
        if (typeof pkg.name === 'string' && PI_PACKAGE_NAMES.includes(pkg.name)) {
          return {
            ...(typeof pkg.version === 'string' ? { version: pkg.version } : {}),
            minimumNodeVersion:
              minimumVersionFromNodeEngine(pkg.engines?.node)
              ?? PI_DEFAULT_NODE_MINIMUM_VERSION,
          };
        }
      } catch {
        // Keep walking through wrapper/package nesting. An unrelated malformed package cannot
        // lower the conservative fallback used for the actual Pi launcher.
      }
    }
    if (current === root) break;
    current = dirname(current);
  }
  return { minimumNodeVersion: PI_DEFAULT_NODE_MINIMUM_VERSION };
}

type PiBatchIdentity =
  | { status: 'ok'; contract: PiPackageRuntimeContract }
  | { status: 'missing' }
  | { status: 'ambiguous' }
  | { status: 'invalid' };

/**
 * Recover the installed Pi package from a Windows npm launcher.
 *
 * npm installs the shim in the global prefix root and the package under
 * `<prefix>\node_modules\<name>`, with no symlink between them. The POSIX walk-up therefore
 * cannot reach it — it climbs out of the prefix and finds the user profile's own `package.json` —
 * so this reads the documented layout directly. It does NOT read the shim: a `.cmd` file's
 * contents are not a contract, and parsing them would make cosyncing depend on npm's generated
 * batch text.
 *
 * Fails closed. Missing, unreadable, oversized, malformed, foreign, and ambiguous metadata all
 * refuse rather than fall back to the default floor, because on this path the package IS the
 * identity proof: nothing else has established that the resolved `.cmd` is Pi at all.
 */
function batchPackageIdentity(
  launcher: string,
  readText: (path: string, maxBytes: number) => PiBoundedTextRead,
): PiBatchIdentity {
  const modules = win32.join(win32.dirname(launcher), 'node_modules');
  const found: PiPackageRuntimeContract[] = [];
  for (const name of PI_PACKAGE_NAMES) {
    const read = readText(win32.join(modules, ...name.split('/'), 'package.json'), PACKAGE_JSON_MAX_BYTES);
    if (!read.ok) {
      if (read.reason === 'missing') continue;
      return { status: 'invalid' };
    }
    let parsed: unknown;
    try { parsed = JSON.parse(read.text); } catch { return { status: 'invalid' }; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'invalid' };
    const pkg = parsed as { name?: unknown; version?: unknown; engines?: { node?: unknown } };
    if (pkg.name !== name || typeof pkg.version !== 'string') return { status: 'invalid' };
    found.push({
      version: pkg.version,
      minimumNodeVersion:
        minimumVersionFromNodeEngine(pkg.engines?.node) ?? PI_DEFAULT_NODE_MINIMUM_VERSION,
    });
  }
  if (found.length === 0) return { status: 'missing' };
  if (found.length > 1) return { status: 'ambiguous' };
  return { status: 'ok', contract: found[0]! };
}

/**
 * The interpreter an npm Windows shim actually uses: `node.exe` beside the shim when the global
 * prefix is the Node installation directory (the default layout), and PATH `node` otherwise.
 * Answering from PATH alone would name the wrong interpreter whenever an older Node shadows the
 * one Pi is installed under.
 */
function batchNodeCandidates(launcher: string): readonly string[] {
  return [win32.join(win32.dirname(launcher), 'node.exe'), 'node'];
}

function nodeRuntimeRemediation(minimumNodeVersion: string): { kind: 'manual'; message: string } {
  return {
    kind: 'manual',
    message: `Install Node ${minimumNodeVersion} or newer, ensure the durable broker service PATH selects it, then restart cosyncing.`,
  };
}

function nodeCommandFromShebang(prefix: string): string | undefined | null {
  if (!prefix.startsWith('#!')) return null; // native/compiled Pi executable: Node is not involved
  const firstLine = prefix.slice(2).split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!firstLine) return undefined;
  const tokens = firstLine.split(/\s+/).filter(Boolean);
  const interpreter = tokens.shift();
  if (!interpreter) return undefined;
  if (interpreter.endsWith('/env')) {
    while (tokens[0]?.startsWith('-')) tokens.shift();
    const command = tokens[0]?.split('=')[0];
    if (command === 'bun') return null;
    return command === 'node' ? 'node' : undefined;
  }
  const basename = interpreter.split('/').pop();
  if (basename === 'bun') return null;
  return basename === 'node' ? interpreter : undefined;
}

function unsupportedReadiness(
  detailCode: string,
  message: string,
  evidence: Omit<PiRuntimeReadiness, 'ready' | 'detailCode' | 'message'> = {},
): PiRuntimeReadiness {
  return { ready: false, detailCode, message, ...evidence };
}

/**
 * What a bounded `--version` probe learned. A launcher that answered something unusable and one
 * that did not answer in time are different facts, and telling an operator to reinstall Pi is only
 * right for the first.
 */
export interface PiVersionProbe {
  output?: string;
  /** The probe hit its own deadline. Says nothing about the installation. */
  timedOut?: boolean;
}

/** Attempts for a probe that times out. See {@link boundedVersionProbe}. */
const VERSION_PROBE_ATTEMPTS = 2;

function runVersionProbe(
  invocation: ResolvedInvocation,
  env: NodeJS.ProcessEnv,
): PiVersionProbe {
  try {
    const probe = spawnSyncResolvedInvocation(invocation, ['--version'], {
      encoding: 'utf8',
      env: { ...env },
      input: '',
      timeout: 3_000,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    // A killed probe is a DEADLINE, not an answer. Node reports the timeout kill through `signal`
    // (and an ETIMEDOUT `error` on some hosts); either way nothing was learned about the launcher.
    const timedOut = !!probe.signal
      || (probe.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
    if (timedOut) return { timedOut: true };
    if (probe.error || probe.status !== 0) return {};
    return { output: `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`.trim() };
  } catch {
    return {};
  }
}

/**
 * One retry, and only for a timeout.
 *
 * The probe's budget is three seconds against an operation that takes about one on a Windows npm
 * shim — Node start, plus `cmd.exe`. That margin disappears when the machine is busy: a native
 * Phase 6 lane starting a broker beside this call had session creation refused, telling the
 * operator to reinstall a perfectly good Pi. A busy host gets a second chance; a launcher that
 * cannot answer still fails fast, and a launcher that answers wrongly is never retried at all.
 */
function boundedVersionProbe(
  invocation: ResolvedInvocation,
  env: NodeJS.ProcessEnv,
): PiVersionProbe {
  let probe: PiVersionProbe = {};
  for (let attempt = 1; attempt <= VERSION_PROBE_ATTEMPTS; attempt += 1) {
    probe = runVersionProbe(invocation, env);
    if (!probe.timedOut) return probe;
  }
  return probe;
}

function piIdentityVersion(output: string): string | undefined {
  const version = semanticVersionFromText(output);
  if (!version) return undefined;
  const identifiesPi = output.split(/\r?\n/).some((line) =>
    /(?:^|[\s/@-])pi(?:-coding-agent)?(?:$|[\s:@-])/i.test(line) && line.includes(version));
  return identifiesPi ? version : undefined;
}

export function inspectPiRuntimeReadiness(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<PiRuntimeHost> = {},
): PiRuntimeReadiness {
  const host: PiRuntimeHost = { ...defaultPiRuntimeHost(), ...overrides };
  const configured = env.COSYNCING_PI_BIN?.trim() || 'pi';
  const invocation = resolveInvocation(configured, {
    env,
    platform: host.platform,
    ...(host.isExecutableFile ? { isExecutableFile: host.isExecutableFile } : {}),
    ...(host.canonicalize ? { canonicalize: host.canonicalize } : {}),
  });
  if (!invocation) {
    return unsupportedReadiness(
      'pi-binary-missing',
      'Pi is not installed or is not visible to the broker service. Install Pi, then restart cosyncing.',
    );
  }
  const executable = invocation.originalPath;

  let contract: PiPackageRuntimeContract;
  let nodeCandidates: readonly string[];

  if (invocation.kind === 'batch') {
    // The resolver already decided this file is launched through cmd.exe. That is what makes it an
    // npm/Node launcher — not the presence of a shebang, which no `.cmd` shim has.
    const identity = batchPackageIdentity(executable, host.readBoundedText);
    if (identity.status === 'missing') {
      return unsupportedReadiness(
        'pi-package-identity-missing',
        'Pi resolves to a Windows npm launcher, but no supported Pi package is installed beside it. Reinstall Pi with npm or point COSYNCING_PI_BIN at the supported Pi executable, then restart cosyncing.',
        { executable },
      );
    }
    if (identity.status === 'ambiguous') {
      return unsupportedReadiness(
        'pi-package-identity-ambiguous',
        'Pi resolves to a Windows npm launcher with more than one supported Pi package installed beside it, so its effective runtime contract is ambiguous. Remove the unused Pi package, then restart cosyncing.',
        { executable },
      );
    }
    if (identity.status === 'invalid') {
      return unsupportedReadiness(
        'pi-package-metadata-invalid',
        'Pi resolves to a Windows npm launcher whose installed package metadata cannot be read safely. Reinstall Pi with npm, then restart cosyncing.',
        { executable },
      );
    }
    // A package beside the shim proves a Pi installation exists there. It does NOT prove that THIS
    // shim launches it — a replaced or foreign `pi.cmd` dropped into the same npm prefix would
    // otherwise pass on its neighbour's evidence. So the launcher is asked what it is, through the
    // shared boundary's own cmd.exe encoding rather than by reading the batch file, and its answer
    // must be the version installed beside it.
    const declaredVersion = semanticVersionFromText(identity.contract.version ?? '');
    const versionProbe = host.probeVersionOutput(invocation, env);
    if (versionProbe.timedOut) {
      return unsupportedReadiness(
        'pi-version-probe-timed-out',
        'Pi did not answer a bounded version check in time, which usually means the machine is busy rather than that Pi is broken. Try again; if it keeps happening, repair the Pi installation.',
        { executable, ...(identity.contract.version ? { packageVersion: identity.contract.version } : {}) },
      );
    }
    const reportedVersion = semanticVersionFromText(versionProbe.output ?? '');
    if (!declaredVersion || !reportedVersion) {
      return unsupportedReadiness(
        'pi-batch-version-unverified',
        'Pi resolves to a Windows npm launcher that did not return a bounded, parsable version. Reinstall Pi with npm or point COSYNCING_PI_BIN at the supported Pi executable, then restart cosyncing.',
        { executable, ...(identity.contract.version ? { packageVersion: identity.contract.version } : {}) },
      );
    }
    if (declaredVersion !== reportedVersion) {
      return unsupportedReadiness(
        'pi-batch-identity-mismatch',
        `The resolved Pi launcher reports ${reportedVersion}, but the Pi package installed beside it is ${declaredVersion}, so the launcher does not run that installation. Reinstall Pi with npm or point COSYNCING_PI_BIN at the supported Pi executable, then restart cosyncing.`,
        { executable, packageVersion: identity.contract.version },
      );
    }
    const supportedPi = compareSemanticVersions(reportedVersion, PI_MINIMUM_SUPPORTED_VERSION);
    if (supportedPi === undefined || supportedPi < 0) {
      return unsupportedReadiness(
        'pi-batch-version-below-minimum',
        `The resolved Pi launcher is Pi ${reportedVersion}, but ${PI_MINIMUM_SUPPORTED_VERSION} or newer is required. Upgrade Pi, then restart cosyncing.`,
        { executable, packageVersion: reportedVersion },
      );
    }
    contract = identity.contract;
    nodeCandidates = batchNodeCandidates(executable);
  } else {
    const prefix = host.readLauncherPrefix(executable, LAUNCHER_PREFIX_MAX_BYTES);
    if (prefix === undefined) {
      return unsupportedReadiness(
        'pi-launcher-unreadable',
        'Pi is installed, but its launcher cannot be inspected safely. Repair the Pi installation, then restart cosyncing.',
        { executable },
      );
    }
    const nodeCommand = nodeCommandFromShebang(prefix);
    if (nodeCommand === null) {
      const nativeProbe = host.probeVersionOutput(invocation, env);
      if (nativeProbe.timedOut) {
        return unsupportedReadiness(
          'pi-version-probe-timed-out',
          'Pi did not answer a bounded version check in time, which usually means the machine is busy rather than that Pi is broken. Try again; if it keeps happening, repair the Pi installation.',
          { executable },
        );
      }
      const version = nativeProbe.output === undefined ? undefined : piIdentityVersion(nativeProbe.output);
      if (!version) {
        return unsupportedReadiness(
          'pi-native-identity-unverified',
          'The configured Pi executable does not provide a bounded, recognizable Pi version response. Point COSYNCING_PI_BIN at the supported Pi executable, then restart cosyncing.',
          { executable },
        );
      }
      const comparison = compareSemanticVersions(version, PI_MINIMUM_SUPPORTED_VERSION);
      if (comparison === undefined || comparison < 0) {
        return unsupportedReadiness(
          'pi-native-version-below-minimum',
          `The configured Pi executable is Pi ${version}, but ${PI_MINIMUM_SUPPORTED_VERSION} or newer is required. Upgrade Pi, then restart cosyncing.`,
          { executable, packageVersion: version },
        );
      }
      return {
        ready: true,
        detailCode: 'pi-native-runtime-ready',
        message: `Pi ${version} uses a verified native runtime and is available for session creation.`,
        executable,
        packageVersion: version,
      };
    }
    if (!nodeCommand) {
      return unsupportedReadiness(
        'pi-node-interpreter-unresolved',
        'Pi uses a launcher whose effective Node interpreter cannot be verified. Point COSYNCING_PI_BIN at the supported Pi executable or repair its launcher.',
        { executable },
      );
    }
    contract = packageRuntimeContract(executable, (path) => {
      const read = host.readBoundedText(path, PACKAGE_JSON_MAX_BYTES);
      return read.ok ? read.text : undefined;
    });
    nodeCandidates = [nodeCommand];
  }

  let nodeInvocation: ResolvedInvocation | undefined;
  for (const candidate of nodeCandidates) {
    nodeInvocation = resolveHostInvocation(candidate, env, host);
    if (nodeInvocation) break;
  }
  const nodeExecutable = nodeInvocation?.originalPath;
  const evidence = {
    executable,
    ...(nodeExecutable ? { nodeExecutable } : {}),
    requiredNodeVersion: contract.minimumNodeVersion,
    ...(contract.version ? { packageVersion: contract.version } : {}),
  };
  if (!nodeInvocation || !nodeExecutable) {
    return unsupportedReadiness(
      'pi-node-interpreter-missing',
      `Pi requires Node ${contract.minimumNodeVersion} or newer, but its effective Node interpreter is not on the broker service PATH. Upgrade/configure Node, then restart cosyncing.`,
      evidence,
    );
  }

  const nodeProbe = host.probeVersionOutput(nodeInvocation, env);
  // Same rule as the launcher above: a probe that ran out of time says nothing about Node, and
  // "Repair Node" is the wrong instruction for a machine that was merely busy.
  if (nodeProbe.timedOut) {
    return unsupportedReadiness(
      'pi-version-probe-timed-out',
      `Pi requires Node ${contract.minimumNodeVersion} or newer, and its effective interpreter did not answer a bounded version check in time. The machine is likely busy; try again.`,
      evidence,
    );
  }
  const nodeVersion = semanticVersionFromText(nodeProbe.output ?? '');
  if (!nodeVersion) {
    return unsupportedReadiness(
      'pi-node-version-unavailable',
      `Pi requires Node ${contract.minimumNodeVersion} or newer, but the effective interpreter version could not be verified. Repair Node, then restart cosyncing.`,
      evidence,
    );
  }
  const supported = compareSemanticVersions(nodeVersion, contract.minimumNodeVersion);
  if (supported === undefined || supported < 0) {
    return unsupportedReadiness(
      'pi-node-version-below-minimum',
      `Pi requires Node ${contract.minimumNodeVersion} or newer, but its effective interpreter is Node ${nodeVersion}. Upgrade Node and ensure the broker service PATH or COSYNCING_PI_BIN resolves Pi through it, then restart cosyncing.`,
      { ...evidence, nodeVersion },
    );
  }
  return {
    ready: true,
    detailCode: 'pi-node-runtime-supported',
    message: `Pi uses supported Node ${nodeVersion}.`,
    ...evidence,
    nodeVersion,
  };
}

let readinessCache: { key: string; at: number; value: PiRuntimeReadiness } | undefined;

export function currentPiRuntimeReadiness(): PiRuntimeReadiness {
  const key = `${process.env.COSYNCING_PI_BIN ?? ''}\0${process.env.PATH ?? ''}`;
  const now = Date.now();
  if (readinessCache && readinessCache.key === key && now - readinessCache.at < RUNTIME_CACHE_TTL_MS) {
    return readinessCache.value;
  }
  const value = inspectPiRuntimeReadiness(process.env);
  readinessCache = { key, at: now, value };
  return value;
}

export function resetPiRuntimeReadinessCache(): void {
  readinessCache = undefined;
}

/**
 * A doctor version probe with readiness's one-retry-on-timeout rule.
 *
 * Doctor's probe contract already distinguishes `timeout` from a bad answer; it was simply folded
 * in with the others, so a busy machine was diagnosed as a broken Pi or a broken Node and the
 * operator told to reinstall something that worked. One retry, and only for a timeout.
 */
async function boundedDoctorProbe(
  context: SetupDiagnosisContext,
  executable: string,
): Promise<SetupCommandProbe> {
  const probe = await context.runReadOnly(executable, ['--version'], 3_000);
  if (probe.status !== 'timeout') return probe;
  return context.runReadOnly(executable, ['--version'], 3_000);
}

/** The only diagnosis a timed-out probe supports: nothing is known, and the fix is to try again. */
function piProbeTimedOutDiagnosis(what: 'launcher' | 'interpreter', executable: string): SetupCheck {
  return {
    id: 'pi.node-runtime',
    status: 'fail',
    detailCode: 'node-runtime-probe-timed-out',
    summary: `Pi's ${what} did not answer a bounded version check in time, so its version is unknown.`,
    evidence: { executable },
    remediation: {
      kind: 'manual',
      message: 'The machine is likely busy rather than misconfigured. Rerun doctor; if it keeps happening, repair the installation.',
    },
  };
}

export async function diagnosePiNodeRuntime(
  context: SetupDiagnosisContext,
  executable: string | undefined,
): Promise<import('@cosyncing/adapter-api').SetupCheck> {
  if (!executable) {
    return {
      id: 'pi.node-runtime',
      status: 'skip',
      detailCode: 'node-runtime-binary-missing',
      summary: 'Pi Node runtime was not checked because Pi is missing.',
    };
  }
  const kind = resolvedInvocationKind(executable, context.platform);
  let contract: PiPackageRuntimeContract;
  let nodeCandidates: readonly string[];
  if (kind === 'batch') {
    // Same rule as readiness: cmd.exe hosting is what marks a Node launcher on Windows, and the
    // installed package beside the shim is the only identity proof available for one.
    const identity = batchPackageIdentity(executable, (path, maxBytes) => context.readText(path, maxBytes));
    if (identity.status !== 'ok') {
      const failure = {
        missing: {
          detailCode: 'node-runtime-package-missing',
          summary: 'Pi resolves to a Windows npm launcher, but no supported Pi package is installed beside it.',
          message: 'Reinstall Pi with npm, then rerun doctor.',
        },
        ambiguous: {
          detailCode: 'node-runtime-package-ambiguous',
          summary: 'Pi resolves to a Windows npm launcher with more than one supported Pi package installed beside it.',
          message: 'Remove the unused Pi package, then rerun doctor.',
        },
        invalid: {
          detailCode: 'node-runtime-package-invalid',
          summary: 'Pi resolves to a Windows npm launcher whose installed package metadata cannot be read safely.',
          message: 'Reinstall Pi with npm, then rerun doctor.',
        },
      }[identity.status];
      return {
        id: 'pi.node-runtime',
        status: 'fail',
        detailCode: failure.detailCode,
        summary: failure.summary,
        evidence: { executable: context.displayPath(executable) },
        remediation: { kind: 'manual', message: failure.message },
      };
    }
    // Same binding as readiness: the package beside the shim is not evidence that THIS shim runs
    // it. `runReadOnly` resolves and launches through the shared boundary, so the batch encoding
    // stays private here too.
    const declaredVersion = semanticVersionFromText(identity.contract.version ?? '');
    const launcherProbe = await boundedDoctorProbe(context, executable);
    if (launcherProbe.status === 'timeout') {
      return piProbeTimedOutDiagnosis('launcher', context.displayPath(executable));
    }
    const reportedVersion = launcherProbe.status === 'ok'
      ? semanticVersionFromText(`${launcherProbe.stdout}\n${launcherProbe.stderr}`)
      : undefined;
    const piFloor = reportedVersion
      ? compareSemanticVersions(reportedVersion, PI_MINIMUM_SUPPORTED_VERSION)
      : undefined;
    if (!declaredVersion || !reportedVersion) {
      return {
        id: 'pi.node-runtime',
        status: 'fail',
        detailCode: 'node-runtime-launcher-version-unverified',
        summary: 'The resolved Pi launcher did not return a bounded, parsable version.',
        evidence: { executable: context.displayPath(executable) },
        remediation: {
          kind: 'manual',
          message: 'Reinstall Pi with npm or point COSYNCING_PI_BIN at the supported Pi executable, then rerun doctor.',
        },
      };
    }
    if (declaredVersion !== reportedVersion) {
      return {
        id: 'pi.node-runtime',
        status: 'fail',
        detailCode: 'node-runtime-launcher-package-mismatch',
        summary: `The resolved Pi launcher reports ${reportedVersion}, but the Pi package installed beside it is ${declaredVersion}, so the launcher does not run that installation.`,
        evidence: { executable: context.displayPath(executable), installedVersion: declaredVersion },
        remediation: {
          kind: 'manual',
          message: 'Reinstall Pi with npm or point COSYNCING_PI_BIN at the supported Pi executable, then rerun doctor.',
        },
      };
    }
    if (piFloor === undefined || piFloor < 0) {
      return {
        id: 'pi.node-runtime',
        status: 'fail',
        detailCode: 'node-runtime-launcher-below-minimum',
        summary: `The resolved Pi launcher is Pi ${reportedVersion}, but ${PI_MINIMUM_SUPPORTED_VERSION} or newer is required.`,
        evidence: { installedVersion: reportedVersion, minimumVersion: PI_MINIMUM_SUPPORTED_VERSION },
        remediation: { kind: 'command', message: 'Update Pi, then rerun doctor.', command: 'pi update self' },
      };
    }
    contract = identity.contract;
    nodeCandidates = batchNodeCandidates(executable);
  } else {
    const launcher = context.readText(executable, 8 * 1024 * 1024);
    if (!launcher.ok) {
      return {
        id: 'pi.node-runtime',
        status: 'fail',
        detailCode: 'node-runtime-launcher-unreadable',
        summary: 'Pi is installed, but its launcher cannot be inspected safely.',
        remediation: { kind: 'manual', message: 'Repair the Pi installation, then rerun doctor.' },
      };
    }
    const nodeCommand = nodeCommandFromShebang(launcher.text.slice(0, LAUNCHER_PREFIX_MAX_BYTES));
    if (nodeCommand === null) {
      const probe = await boundedDoctorProbe(context, executable);
      if (probe.status === 'timeout') {
        return piProbeTimedOutDiagnosis('launcher', context.displayPath(executable));
      }
      const version = probe.status === 'ok' ? piIdentityVersion(`${probe.stdout}\n${probe.stderr}`) : undefined;
      const comparison = version ? compareSemanticVersions(version, PI_MINIMUM_SUPPORTED_VERSION) : undefined;
      if (!version || comparison === undefined || comparison < 0) {
        return {
          id: 'pi.node-runtime',
          status: 'fail',
          detailCode: version ? 'native-runtime-version-below-minimum' : 'native-runtime-identity-unverified',
          summary: version
            ? `The configured Pi executable is Pi ${version}, but ${PI_MINIMUM_SUPPORTED_VERSION} or newer is required.`
            : 'The configured Pi executable did not provide a recognizable Pi version response.',
          ...(version ? { evidence: { installedVersion: version, minimumVersion: PI_MINIMUM_SUPPORTED_VERSION } } : {}),
          remediation: {
            kind: 'manual',
            message: 'Point COSYNCING_PI_BIN at the supported Pi executable, then restart cosyncing.',
          },
        };
      }
      return {
        id: 'pi.node-runtime',
        status: 'pass',
        detailCode: 'native-runtime-ready',
        summary: `Pi ${version} uses a verified native executable and does not depend on Node launcher compatibility.`,
        evidence: { installedVersion: version, minimumVersion: PI_MINIMUM_SUPPORTED_VERSION },
      };
    }
    contract = packageRuntimeContract(executable, (path) => {
      const read = context.readText(path, PACKAGE_JSON_MAX_BYTES);
      return read.ok ? read.text : undefined;
    });
    if (!nodeCommand) {
      return {
        id: 'pi.node-runtime',
        status: 'fail',
        detailCode: 'node-runtime-interpreter-unresolved',
        summary: 'Pi launcher runtime could not be verified.',
        remediation: nodeRuntimeRemediation(contract.minimumNodeVersion),
      };
    }
    nodeCandidates = [nodeCommand];
  }
  const remediation = nodeRuntimeRemediation(contract.minimumNodeVersion);
  let nodeExecutable: string | undefined;
  for (const candidate of nodeCandidates) {
    nodeExecutable = context.resolveExecutable(candidate);
    if (nodeExecutable) break;
  }
  if (!nodeExecutable) {
    return {
      id: 'pi.node-runtime',
      status: 'fail',
      detailCode: 'node-runtime-interpreter-missing',
      summary: `Pi requires Node ${contract.minimumNodeVersion} or newer, but its effective interpreter is unavailable.`,
      evidence: { minimumVersion: contract.minimumNodeVersion },
      remediation,
    };
  }
  const probe = await boundedDoctorProbe(context, nodeExecutable);
  if (probe.status === 'timeout') {
    return piProbeTimedOutDiagnosis('interpreter', context.displayPath(nodeExecutable));
  }
  const nodeVersion = semanticVersionFromText(`${probe.stdout}\n${probe.stderr}`);
  const comparison = nodeVersion
    ? compareSemanticVersions(nodeVersion, contract.minimumNodeVersion)
    : undefined;
  if (!nodeVersion || comparison === undefined || comparison < 0) {
    return {
      id: 'pi.node-runtime',
      status: 'fail',
      detailCode: nodeVersion ? 'node-runtime-below-minimum' : 'node-runtime-version-unavailable',
      summary: nodeVersion
        ? `Pi requires Node ${contract.minimumNodeVersion} or newer, but its effective interpreter is Node ${nodeVersion}.`
        : `Pi requires Node ${contract.minimumNodeVersion} or newer, but its effective interpreter version could not be verified.`,
      evidence: {
        executable: context.displayPath(nodeExecutable),
        minimumVersion: contract.minimumNodeVersion,
        ...(nodeVersion ? { installedVersion: nodeVersion } : {}),
      },
      remediation,
    };
  }
  return {
    id: 'pi.node-runtime',
    status: 'pass',
    detailCode: 'node-runtime-supported',
    summary: `Pi effective Node ${nodeVersion} satisfies the installed distribution floor.`,
    evidence: {
      executable: context.displayPath(nodeExecutable),
      installedVersion: nodeVersion,
      minimumVersion: contract.minimumNodeVersion,
    },
  };
}
