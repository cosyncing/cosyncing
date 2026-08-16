// ── Setup and doctor diagnosis ──────────────────────────────────────────────

export type SetupCheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface SetupRemediation {
  kind: 'command' | 'manual' | 'retry';
  message: string;
  /** Customer-facing commands only. Never expose contributor-only environment variables here. */
  command?: string;
}

/** One stable, redacted setup/doctor result. Detail codes are API surface; prose may improve additively. */
export interface SetupCheck {
  id: string;
  status: SetupCheckStatus;
  detailCode: string;
  summary: string;
  evidence?: Record<string, string | number | boolean>;
  remediation?: SetupRemediation;
}

export interface AgentMinimumVersion {
  version: string;
  requiredFeature: string;
  evidenceUrl: string;
  evidenceNote: string;
}

export interface AgentSetupDiagnosis {
  agent: string;
  displayName: string;
  minimumVersion: AgentMinimumVersion;
  checks: SetupCheck[];
}

/** Adapter-to-broker notification for a managed runtime's short-lived launch helper. */
export interface ManagedRuntimeStartFailure {
  detailCode: string;
  /** Native stdout/stderr. The broker sink must bound and redact this before persistence. */
  capturedOutput?: string;
}

export type ManagedRuntimeStartReporter = (failure?: ManagedRuntimeStartFailure) => void;

export interface SetupPathInspection {
  status: 'missing' | 'file' | 'directory' | 'socket' | 'other' | 'unreadable';
  readable: boolean;
  displayPath: string;
}

export interface SetupCommandProbe {
  status: 'ok' | 'nonzero' | 'timeout' | 'unavailable';
  exitCode?: number;
  stdout: string;
  stderr: string;
}

export interface SetupHttpProbe {
  status: 'ok' | 'http-error' | 'unreachable' | 'invalid-response';
  statusCode?: number;
  json?: unknown;
}

/**
 * Capability-limited context for adapter diagnosis. Implementations are read-only and bounded; adapters must
 * never call normal discovery from this path because discovery may launch a managed runtime or install assets.
 */
export interface SetupDiagnosisContext {
  readonly effects: 'forbidden';
  readonly platform: string;
  /**
   * The host CPU architecture, alongside the platform it belongs to.
   *
   * Paired with `platform` deliberately: a diagnosis that reads the platform from an injected context and the
   * architecture from `process` describes a machine that does not exist, and a fixture posing as macOS on an
   * x64 test host would be judged an unsupported Intel Mac. Whoever decides one decides both.
   */
  readonly arch: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  resolveExecutable(command: string): string | undefined;
  inspectPath(path: string): SetupPathInspection;
  readText(path: string, maxBytes?: number): { ok: true; text: string } | { ok: false; reason: 'missing' | 'unreadable' | 'too-large' };
  /**
   * Bounded read-only directory listing: entry NAMES only (no stat, no
   * recursion). `maxEntries` REQUESTS a ceiling; the implementation enforces
   * its own finite maximum, treats a non-finite or non-positive request as
   * the default rather than as permission to list without limit, and BOUNDS
   * THE ITERATION itself — it never materializes the whole directory to slice
   * it. The examined subset is sorted; entries beyond the ceiling are
   * unexamined and reported via `truncated`, never silently. A truncated
   * listing means the caller cannot claim to have seen the directory.
   */
  listDirectory(path: string, maxEntries?: number): { ok: true; names: readonly string[]; truncated: boolean } | { ok: false; reason: 'missing' | 'not-directory' | 'unreadable' };
  /**
   * Effect-free liveness probe for a recorded pid (signal-0 semantics: EPERM
   * means the process exists under another user and counts as alive). Never
   * delivers a real signal — this is the diagnosis-safe form of the probe an
   * adapter needs to tell a live registry record from a stale one.
   */
  processAlive(pid: number): boolean;
  readPackageVersion(executable: string, packageNames: readonly string[]): string | undefined;
  runReadOnly(executable: string, args: readonly string[], timeoutMs?: number): Promise<SetupCommandProbe>;
  /**
   * `maxBytes` caps the DECODED body; over it the probe reports `invalid-response`, never `unreachable`,
   * because the endpoint did answer. Omit it for probing — the default suits a health check. Supply it
   * only to read a response whose size follows the operator's data rather than the protocol, such as this
   * broker's own session roster, which grows with use and cannot be bounded by a probe-sized ceiling.
   *
   * It REQUESTS a ceiling; the implementation decides one. Every implementation must cap it at its own
   * finite maximum and must treat a non-finite or non-positive request as the default rather than as
   * permission to read without limit — otherwise one caller's `Infinity` or `NaN` removes the boundary
   * for a response this side does not control.
   */
  fetchJson(
    url: string,
    headers?: Readonly<Record<string, string>>,
    timeoutMs?: number,
    maxBytes?: number,
  ): Promise<SetupHttpProbe>;
  probeTcp(host: string, port: number, timeoutMs?: number): Promise<'open' | 'closed' | 'unknown'>;
  displayPath(path: string): string;
}

/** Extract a SemVer-shaped version from tool output while ignoring product prefixes and build suffixes. */
export function semanticVersionFromText(value: string): string | undefined {
  const match = value.match(/(?:^|[^0-9])v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return undefined;
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}${match[4] ? `-${match[4]}` : ''}`;
}

/** Compare normalized SemVer values. A prerelease is lower than the corresponding stable version. */
export function compareSemanticVersions(left: string, right: string): number | undefined {
  const parse = (value: string): { core: number[]; prerelease?: string[] } | undefined => {
    const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
    if (!match) return undefined;
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      ...(match[4] ? { prerelease: match[4].split('.') } : {}),
    };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return undefined;
  for (let index = 0; index < 3; index += 1) {
    const delta = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const count = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumber = /^\d+$/.test(x) ? Number(x) : undefined;
    const yNumber = /^\d+$/.test(y) ? Number(y) : undefined;
    if (xNumber !== undefined && yNumber !== undefined) return xNumber < yNumber ? -1 : 1;
    if (xNumber !== undefined) return -1;
    if (yNumber !== undefined) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export interface BinaryVersionDiagnosis {
  executable?: string;
  installedVersion?: string;
  checks: SetupCheck[];
}

/** Shared binary/version branch logic; adapters still own command names, version floors, and feature claims. */
export async function diagnoseBinaryVersion(options: {
  context: SetupDiagnosisContext;
  checkPrefix: string;
  displayName: string;
  command: string;
  versionArgs?: readonly string[];
  packageNames?: readonly string[];
  /** Parse version from a package-managed/standalone executable path without invoking the CLI. */
  versionFromExecutable?: (executable: string) => string | undefined;
  minimum: AgentMinimumVersion;
  installMessage: string;
  upgradeCommand: string;
}): Promise<BinaryVersionDiagnosis> {
  const executable = options.context.resolveExecutable(options.command);
  if (!executable) {
    return {
      checks: [
        {
          id: `${options.checkPrefix}.binary`,
          status: 'warn',
          detailCode: 'binary-missing',
          summary: `${options.displayName} is not installed or is not on PATH.`,
          remediation: { kind: 'manual', message: options.installMessage },
        },
        {
          id: `${options.checkPrefix}.version`,
          status: 'skip',
          detailCode: 'version-not-checked',
          summary: `Version was not checked because the ${options.displayName} binary is missing.`,
        },
      ],
    };
  }

  const checks: SetupCheck[] = [{
    id: `${options.checkPrefix}.binary`,
    status: 'pass',
    detailCode: 'binary-found',
    summary: `${options.displayName} executable found.`,
    evidence: { executable: options.context.displayPath(executable) },
  }];
  let installedVersion = options.packageNames?.length
    ? options.context.readPackageVersion(executable, options.packageNames)
    : undefined;
  installedVersion ??= options.versionFromExecutable?.(executable);
  let probe: SetupCommandProbe | undefined;
  if (!installedVersion && options.versionArgs) {
    probe = await options.context.runReadOnly(executable, options.versionArgs);
    if (probe.status === 'ok' || probe.status === 'nonzero') {
      installedVersion = semanticVersionFromText(`${probe.stdout}\n${probe.stderr}`);
    }
  }
  if (!installedVersion) {
    checks.push({
      id: `${options.checkPrefix}.version`,
      status: 'fail',
      detailCode: probe?.status === 'timeout' ? 'version-probe-timeout' : 'version-unparsable',
      summary: `${options.displayName} version could not be verified.`,
      remediation: {
        kind: 'command',
        message: `Update ${options.displayName}, then rerun doctor.`,
        command: options.upgradeCommand,
      },
    });
    return { executable, checks };
  }

  const comparison = compareSemanticVersions(installedVersion, options.minimum.version);
  if (comparison === undefined || comparison < 0) {
    checks.push({
      id: `${options.checkPrefix}.version`,
      status: 'fail',
      detailCode: comparison === undefined ? 'version-unparsable' : 'version-below-minimum',
      summary: comparison === undefined
        ? `${options.displayName} version could not be compared with the supported floor.`
        : `${options.displayName} ${installedVersion} is below supported ${options.minimum.version}.`,
      evidence: { installedVersion, minimumVersion: options.minimum.version },
      remediation: {
        kind: 'command',
        message: `Update ${options.displayName} to ${options.minimum.version} or newer.`,
        command: options.upgradeCommand,
      },
    });
  } else {
    checks.push({
      id: `${options.checkPrefix}.version`,
      status: 'pass',
      detailCode: 'version-supported',
      summary: `${options.displayName} version is supported.`,
      evidence: { installedVersion, minimumVersion: options.minimum.version },
    });
  }
  return { executable, installedVersion, checks };
}
