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
  /**
   * Present ONLY when the last component of the path is a symbolic link, in which case `status` above
   * still describes the LINK and this describes what the link reaches.
   *
   * Reported alongside `status` rather than by resolving the link into it, because an alias is not the
   * thing it names: an ownership or write-capable decision must keep refusing the alias even when its
   * target is perfectly good, while a read-only "is there a live endpoint here" question may follow it.
   *
   * `resolvedPath` is RAW, not display-shortened, and every intermediate link is already followed. A
   * kernel socket table records the bound target, so a listener lookup against a `~/...` rendering would
   * silently match nothing; render it with `displayPath` before showing it to anyone.
   */
  link?: {
    status: 'file' | 'directory' | 'socket' | 'missing' | 'other' | 'unreadable';
    readable: boolean;
    resolvedPath: string;
  };
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
 * The process that owns a TCP listener, as the operating system names it.
 *
 * This proves WHERE the listener is, which is a weaker claim than the identity a
 * termination authority needs, so it is deliberately its own type: nothing may read
 * it as permission to stop the process.
 */
export interface SetupListenerProcess {
  /** The process image name, e.g. `wslrelay.exe`. Casing follows the OS. */
  name: string;
  executable?: string;
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
   * Read only the bounded prefix of a regular, non-symlink file.  Unlike
   * `readText`, a larger file is valid: launcher diagnosis needs the shebang,
   * not the whole bundled CLI.  Optional for compatibility with injected
   * contexts; adapters fall back to `readText` in older fixtures.
   */
  readTextPrefix?(path: string, maxBytes: number): { ok: true; text: string } | { ok: false; reason: 'missing' | 'unreadable' | 'too-large' };
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
  /**
   * The current POSIX uid, as a decimal string, or undefined where the host has none. A seam rather
   * than a direct `process.getuid` call because a diagnosis context can describe a platform other than
   * the one running it: a darwin context evaluated on Windows has a platform, an arch, and a home, and
   * it needs a uid for the same reason — otherwise the launchd domain probe is unreachable from any
   * host that lacks uids, and the check silently degrades instead of running.
   */
  currentUid?(): string | undefined;
  /**
   * The native machine architecture on Windows, which is not the same question as `arch`: an emulated x64
   * process reports x64 for itself while running on an ARM64 machine. Seamed so a fixture can present a
   * host it does not have.
   */
  windowsMachineArchitecture?(): 'x64' | 'arm64' | 'other' | 'unknown';
  readPackageVersion(executable: string, packageNames: readonly string[]): string | undefined;
  runReadOnly(
    executable: string,
    args: readonly string[],
    timeoutMs?: number,
    envOverrides?: Readonly<Record<string, string | undefined>>,
  ): Promise<SetupCommandProbe>;
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
  /**
   * The one process that owns the listener on `port`, when the host can prove there is exactly
   * one. Seamed because a fixture cannot present another machine's process table: an install
   * has to be able to describe a listener that lives somewhere it cannot see.
   *
   * `undefined` means the owner could NOT be proven, which is not evidence that nothing is
   * listening. Callers must fail closed on it.
   */
  listenerProcess?(port: number): Promise<SetupListenerProcess | undefined>;
  displayPath(path: string): string;
  /**
   * WHICH of this agent's external hosts cosyncing is responsible for starting
   * on this machine — as identity keys, in the adapter's own identity space
   * ({@link AgentBackend.managedHostIdentity}: a home for one agent, an address
   * for another).
   *
   * Supplied per agent by the broker, which is the only side that can answer it:
   * the decision comes from durable installation state — a service configured to
   * manage this host, or an ownership record proving one was started — and an
   * adapter can see neither.
   *
   * IDENTITIES RATHER THAN A FLAG, because management is per configuration and
   * not per agent, and a boolean is wrong in both directions at once. The
   * installed service manages the host its OWN environment resolves; an operator
   * whose shell points the same adapter somewhere else — a different home, a
   * host on another machine — is diagnosing a host that nothing here manages. A
   * flag would tell that operator their host is supervised when it is not, and
   * the inverse case is worse: it would let a diagnosis offer a local start
   * command whose host collides with the managed one.
   *
   * So a diagnosis applies the managed posture only when the identity it
   * actually resolved appears here. Absent or empty means nothing on this
   * machine is managed, which is the posture where manual instructions are safe
   * — a context that was never told stays useful rather than silently
   * withholding guidance.
   */
  readonly managedExternalHostIdentities?: readonly string[];
}

/** Extract a SemVer-shaped version from tool output while ignoring product prefixes and build suffixes. */
export function semanticVersionFromText(value: string): string | undefined {
  const match = value.match(/(?:^|[^0-9])v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return undefined;
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}${match[4] ? `-${match[4]}` : ''}`;
}

const VERSION_TOKEN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u;

/** The words of one line, with the punctuation that wraps them removed but the
 *  word itself intact — `(5e9a58528b76)` and `3.1.0)` both lose their brackets,
 *  `cline/3.0.60` keeps its slash, `kilo-code` keeps its hyphen. */
function lineWords(line: string): string[] {
  return line
    .split(/\s+/u)
    .map((word) => word.replace(/^[([{'"`]+/u, '').replace(/[)\]}'"`,;:.]+$/u, ''))
    .filter((word) => word.length > 0);
}

/** The version this word IS, or undefined. A version inside a longer dotted
 *  number (`3.0.60.1`) or inside a path (`~/.cache/cline/3.0.60/bin`) is not a
 *  token and does not count. */
function versionWord(word: string): string | undefined {
  const match = VERSION_TOKEN.exec(word);
  if (!match) return undefined;
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}${match[4] ? `-${match[4]}` : ''}`;
}

/** Fold a word to the letters and digits that could spell a product name, so
 *  `Kilo-Code:` and `kilocode` compare equal. */
function productToken(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]+/gu, '');
}

function namesProduct(word: string, productNames: readonly string[]): boolean {
  const token = productToken(word);
  return token.length > 0 && productNames.some((name) => productToken(name) === token);
}

/**
 * The version this line reports FOR THIS PRODUCT, by adjacency.
 *
 * Adjacency is the whole rule. "The line mentions the product somewhere" is not
 * enough and was measured wrong in both directions: `(node:1) Warning: cline is
 * using deprecated API v0.9.1` handed a gate the phantom `0.9.1` and shut a
 * correct install, and `node v22.11.0, reasonix v1.25.2` answered with the
 * runtime. The product has to be the word immediately before the version, or
 * joined to it as `name/version`.
 *
 * That also retires the update-notice special case. `cline 3.0.60 (update
 * available: 3.1.0)` answers 3.0.60, because only that one is adjacent —
 * whereas skipping notice lines wholesale lost the version entirely, and the
 * `\blatest\b` in that filter ate `grok 1.0.13 (5e9a58528b76) [latest]`.
 * `update available: 3.0.60 -> 3.1.0` still answers nothing: neither version
 * has the product beside it.
 */
function namedVersionOnLine(line: string, productNames: readonly string[]): string | undefined {
  const words = lineWords(line);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    // `cline/3.0.60` is the oclif shape and names the product itself. Exactly
    // one slash, so a PATH is not this shape however it ends — including
    // `/usr/lib/node_modules/cline/3.0.60`, whose last segment is a version and
    // which a last-segment rule accepted.
    const slash = word.indexOf('/');
    if (slash > 0 && word.indexOf('/', slash + 1) < 0) {
      const version = versionWord(word.slice(slash + 1));
      if (version !== undefined && namesProduct(word.slice(0, slash), productNames)) return version;
      continue;
    }
    const version = versionWord(word);
    if (version === undefined) continue;
    const previous = index > 0 ? words[index - 1]! : undefined;
    if (previous !== undefined && namesProduct(previous, productNames)) return version;
  }
  return undefined;
}

/**
 * The version a `--version` probe reports FOR A NAMED PRODUCT.
 *
 * {@link semanticVersionFromText} answers "is there a version-shaped thing
 * anywhere in this text", which is the right question for a diagnostic and the
 * wrong one for a gate. The four version gates compare against it to decide
 * whether to open a WRITE-CAPABLE child -- three as a floor, Reasonix still
 * exactly -- and it has no right boundary,
 * no token boundary and no product identity, so the first match in
 * `stdout+stderr` wins. Measured against the real function:
 *
 *     3.0.60.1                                 -> 3.0.60
 *     ~/.cache/cline/3.0.60/bin                -> 3.0.60
 *     update available: 3.0.60 -> 3.1.0        -> 3.0.60
 *
 * — three ways for an unverified build to pass a gate that exists to keep
 * unverified builds out. This asks the narrower question instead:
 *
 *   - the version must be a whole WORD, so `3.0.60.1` is not a version and
 *     neither is any segment of a path;
 *   - a line answers for this product only where the product name is ADJACENT
 *     to the version — the word before it, or joined as `name/version` (the
 *     oclif shape, `cline/3.0.60 linux-x64 node-v22.11.0`);
 *   - failing that, a line that is nothing BUT a version answers, because cline
 *     and kilo each print a bare `3.0.60\n` with no name to demand;
 *   - two surviving lines that disagree answer nothing.
 *
 * Both passes are per LINE and not "the whole output is one version". That
 * stricter form was tried and it is a lane-darkening bug: the gates feed this
 * `stdout + "\n" + stderr`, so a single Node `DeprecationWarning`, a bun notice,
 * or an update banner on any other line made a correct 3.0.60 install
 * unverifiable and shut Drive — trading a narrow fail-open for a broad
 * fail-closed. Noise lines are simply not version lines, and with adjacency a
 * noise line that happens to name the product is not one either.
 *
 * Still fails closed where it matters: `undefined` means "this probe did not
 * establish a version", never "any version will do".
 */
export function reportedProductVersion(
  output: string,
  productNames: readonly string[],
): string | undefined {
  const lines = output.split(/\r?\n/u);
  const named = new Set<string>();
  for (const line of lines) {
    const version = namedVersionOnLine(line, productNames);
    if (version !== undefined) named.add(version);
  }
  if (named.size > 0) return named.size === 1 ? [...named][0] : undefined;
  const bare = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();
    const version = versionWord(trimmed);
    if (version !== undefined) bare.add(version);
  }
  return bare.size === 1 ? [...bare][0] : undefined;
}

/**
 * The lowest of a non-empty measured-version list, used as an adapter's floor.
 *
 * Adapters derived the floor from `MEASURED_VERSIONS[0]`, which made the floor
 * an artifact of list ORDER: adding a newer build at the front — the natural
 * "newest first" convention — would silently RAISE the floor and strand an
 * older build the evidence still covers. Order must not carry meaning here.
 *
 * An unparsable entry is ignored rather than becoming the floor. A floor no
 * version can be compared against does not loosen the gate — it REFUSES
 * everything, because `compareSemanticVersions` returns `undefined` for every
 * comparison and each adapter's standing function maps that to `unreadable`.
 * `diagnoseBinaryVersion` then reports a hard failure for a correctly installed
 * binary, so a typo here takes the adapter dark rather than opening it up.
 */
export function lowestSemanticVersion(versions: readonly string[]): string {
  const first = versions[0];
  if (first === undefined) throw new Error('lowestSemanticVersion requires a non-empty list');
  // Seeded with the first PARSABLE entry, not `versions[0]`. Seeding with the
  // raw first entry meant an unparsable one at the head could never be
  // displaced -- every later comparison against it returns `undefined` -- so
  // `['nightly', '3.0.60']` answered `nightly`, a floor against which every
  // installed version reads as `unreadable` and is refused. Measured across
  // 1.0.13, 99.99.99 and 0.0.1: all three refused.
  const parsable = versions.filter((value) =>
    compareSemanticVersions(value, value) !== undefined);
  const seed = parsable[0];
  if (seed === undefined) return first;
  return parsable.reduce((lowest, candidate) => {
    const order = compareSemanticVersions(candidate, lowest);
    return order !== undefined && order < 0 ? candidate : lowest;
  }, seed);
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
  /**
   * Product names that may carry the version on a `--version` line, for
   * {@link reportedProductVersion}. Supplying them makes doctor read the PROBE
   * output the same way this agent's runtime gate does; omitting them keeps the
   * looser {@link semanticVersionFromText} reading.
   *
   * Not a promise that doctor and the gate always agree: when the probe
   * establishes nothing, doctor still falls back to `packageNames` and the gate
   * has no fallback at all. That gap is narrow by construction — the gate reads
   * exactly what this returns — but it exists, and a doctor `pass` beside a
   * closed lane is what it would look like.
   */
  productNames?: readonly string[];
  /**
   * Ask the BINARY before `package.json`.
   *
   * Off by default, and that default is a safety property rather than an
   * accident: for Codex and Pi, invoking the CLI is mutation-prone, and doctor
   * deliberately reads installed metadata instead — `test-broker-doctor` pins
   * it by name. Set this only for an agent whose runtime enforces an EXACT
   * version by running `--version` itself. There, reading the manifest first
   * lets doctor report a version the gate has never seen — a stale or
   * hand-edited `package.json` beside a different executable, or an npm shim
   * whose manifest names the wrapper rather than the platform binary — and
   * present it as the definite installed build. The manifest stays as the
   * fallback for when the probe establishes nothing.
   */
  preferVersionProbe?: boolean;
  /** Parse version from a package-managed/standalone executable path without invoking the CLI. */
  versionFromExecutable?: (executable: string) => string | undefined;
  /** Extra environment required to keep a nominally read-only version probe side-effect-free. */
  versionProbeEnv?: Readonly<Record<string, string | undefined>>;
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
  // Only a SUCCESSFUL probe establishes a version FOR A GATED ADAPTER. A
  // non-zero exit means the command failed; its output may be a usage message,
  // a crash trace, or an update notice, and mining a version out of it asserts
  // something that was never demonstrated. All four version gates require
  // exit 0.
  //
  // Everyone else keeps the older, lenient rule. `nonzero` was always accepted
  // here, and a CLI that prints its version and exits non-zero — `--version`
  // routed through a subcommand dispatcher that then reports "no command
  // given" is the common shape — would otherwise turn a `pass` into a
  // `version-unparsable` fail for eight adapters that this gate was never about.
  const readProbe = (probe: SetupCommandProbe): string | undefined => {
    if (options.productNames?.length) {
      return probe.status === 'ok'
        ? reportedProductVersion(`${probe.stdout}\n${probe.stderr}`, options.productNames)
        : undefined;
    }
    return probe.status === 'ok' || probe.status === 'nonzero'
      ? semanticVersionFromText(`${probe.stdout}\n${probe.stderr}`)
      : undefined;
  };
  let probe: SetupCommandProbe | undefined;
  let installedVersion: string | undefined;
  if (options.preferVersionProbe && options.versionArgs) {
    probe = await options.context.runReadOnly(executable, options.versionArgs, undefined, options.versionProbeEnv);
    installedVersion = readProbe(probe);
  }
  installedVersion ??= options.packageNames?.length
    ? options.context.readPackageVersion(executable, options.packageNames)
    : undefined;
  installedVersion ??= options.versionFromExecutable?.(executable);
  if (!installedVersion && !probe && options.versionArgs) {
    probe = await options.context.runReadOnly(executable, options.versionArgs, undefined, options.versionProbeEnv);
    installedVersion = readProbe(probe);
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
