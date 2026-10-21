import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

/**
 * How this build was produced, and therefore what can execute it — and who owns the files it was written to.
 *
 * `packaged` alone used to carry three separate meanings — "not a contributor checkout", "safe to install as
 * a durable service", and "eligible for the signed native binary swap". A JavaScript distribution is the
 * first two and emphatically NOT the third, so the three had to stop sharing one boolean.
 *
 *   source       — a contributor checkout executed through Bun from repository sources.
 *   bun-js       — the legacy npm application: ONE self-contained JavaScript bundle, executed by a
 *                  separately installed Bun runtime. Carries no interpreter of its own.
 *   bootstrap-js — the same bundle and the same external Bun, placed by cosyncing's own signed installer
 *                  into `$COSYNCING_HOME/bin` instead of by a package manager.
 *   native       — a `bun build --compile` executable with Bun embedded. Distribution of this artifact is
 *                  gated (docs/legal/binary-distribution-readiness.md); it stays buildable for CI.
 *
 * `bun-js` and `bootstrap-js` are the same shape of artifact and differ in exactly one thing: who placed the
 * files. That is not cosmetic — it decides whether cosyncing may replace them. npm owns what npm installed
 * and cosyncing must not fight the tool that owns those files; nothing but cosyncing claims
 * `$COSYNCING_HOME/bin`. Two install methods, two honest answers to "update me", and this kind is what tells
 * them apart.
 *
 * Fail-closed by construction: only the exact string `native` selects the signed MACHINE-CODE replacement
 * path, and only the exact string `bootstrap-js` selects the signed JavaScript one, so a dropped or
 * corrupted build define degrades to `source`, which cannot self-replace at all.
 */
export const DISTRIBUTION_KINDS = Object.freeze(['source', 'bun-js', 'bootstrap-js', 'native'] as const);

export type DistributionKind = typeof DISTRIBUTION_KINDS[number];

export function isDistributionKind(value: unknown): value is DistributionKind {
  return typeof value === 'string' && (DISTRIBUTION_KINDS as readonly string[]).includes(value);
}

/**
 * The one answer to "what is the cosyncing artifact, and what runs it".
 *
 * `process.execPath` identifies the cosyncing executable only in the `native` distribution. Everywhere else
 * it identifies Bun, and the application is a separate file Bun was told to run. Every consumer — the setup
 * bootstrap copy, the service unit, foreground relaunch, doctor, repair — reads these two fields instead of
 * re-deriving an answer from `Bun.main`, `process.argv[1]`, `process.execPath`, or an import-relative guess.
 */
export interface ApplicationIdentity {
  distribution: DistributionKind;
  /** Absolute path of the cosyncing application artifact itself: JS bundle, native executable, or entry source. */
  applicationPath: string;
  /**
   * Absolute path of the external runtime that must execute `applicationPath`.
   *
   * Absent for `native` (which embeds its own), and absent when the runtime could not be validated — in
   * which case `runtimeProblem` says why. Read-only commands stay usable in that state; anything that would
   * WRITE a launch command calls {@link requireRuntimePath} and fails closed instead of recording a runtime
   * it could not prove.
   */
  runtimePath?: string;
  /**
   * The Bun version that runtime reports, proven rather than assumed.
   *
   * Present exactly when `runtimePath` is, because a runtime is only recorded once it has identified itself
   * as a Bun new enough to run this application. Surfaced as doctor evidence so an operator can see WHICH
   * Bun answered, not merely that something at that path was executable.
   */
  runtimeVersion?: string;
  /** Why no runtime could be recorded. Present only when `runtimePath` is absent on a non-native build. */
  runtimeProblem?: { detailCode: string; message: string };
  /** True for every distribution that is an installable product rather than a contributor checkout. */
  packaged: boolean;
}

export class ApplicationIdentityError extends Error {
  constructor(readonly detailCode: string, message: string) {
    super(message);
    this.name = 'ApplicationIdentityError';
  }
}

/** Name of the documented escape hatch for hosts where the runtime that launched cosyncing is not the one to record. */
export const BUN_RUNTIME_OVERRIDE_VARIABLE = 'COSYNCING_BUN_BIN';

function assertSafePath(value: string, label: string, detailCode: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApplicationIdentityError(detailCode, `${label} path is empty`);
  }
  // Identity is platform-neutral. Provider-specific grammars validate again when a path is serialized:
  // systemd refuses `%` and `:` because they are a specifier and PATH separator there, while Windows
  // requires the colon in every drive-qualified absolute path.
  if (/[\0\r\n]/.test(value)) {
    throw new ApplicationIdentityError(detailCode, `${label} path contains control characters`);
  }
  if (!isAbsolute(value)) {
    throw new ApplicationIdentityError(detailCode, `${label} path must be absolute, received ${JSON.stringify(value)}`);
  }
  return resolve(value);
}

/**
 * Prove a path is something the operating system can actually exec.
 *
 * `statSync` follows symlinks deliberately: a version-manager Bun (`~/.local/bin/bun`, an asdf/mise shim, a
 * Homebrew Cellar link) is a legitimate installation and must be accepted. What is refused is a path that is
 * not a regular file at the end of the chain, or one the current user cannot execute — either of which
 * becomes an unstartable service written with a green setup report.
 */
function assertExecutableFile(path: string, label: string, detailCode: string): string {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    throw new ApplicationIdentityError(detailCode, `${label} is missing: ${path}`);
  }
  if (!stat.isFile()) {
    throw new ApplicationIdentityError(detailCode, `${label} is not a regular file: ${path}`);
  }
  try {
    accessSync(path, constants.X_OK);
  } catch {
    throw new ApplicationIdentityError(detailCode, `${label} is not executable: ${path}`);
  }
  return path;
}

/**
 * The oldest Bun allowed to execute this application.
 *
 * Kept equal to the root package’s `engines.bun` floor, as checked by the application identity suite.
 * Runtime enforcement remains necessary regardless of how the application was acquired. This is also
 * the `minimumBunVersion` every release manifest declares.
 *
 * Streamed artifact downloads require HTTP backpressure: Bun 1.3.14 drains a response into
 * memory even when its receiver stalls (oven-sh/bun#32469). The tested 1.4.3 runtime
 * includes that fix. Existing bridge updaters install the runtime pinned by the release.
 */
export const MINIMUM_BUN_RUNTIME_VERSION = '1.4.3';

/**
 * The Bun version every build in {@link PINNED_BUN_RUNTIME_ARCHIVES} is: what the installers place, and what
 * a release signs into its manifest for `cosy update` to install. Never below the floor, and asserted so.
 */
export const PINNED_BUN_RUNTIME_VERSION = '1.4.3';

/**
 * The official Bun release archives for exactly {@link PINNED_BUN_RUNTIME_VERSION}, by installer host.
 *
 * The curl installer digest-pins every cosyncing artifact it places, so the runtime that executes them
 * cannot be the one link resting on TLS alone. Piping `bun.sh/install` to a shell would do exactly that:
 * an unpinned third-party script, fetched fresh, choosing and placing a binary nothing here ever checks.
 * These digests come from Bun's published tagged-release asset metadata, are baked into
 * the installer at assembly time, and are enforced before anything is unpacked.
 *
 * They live next to the pinned version because they are one fact with it: these are the checksums OF that
 * version, and changing the version without replacing them would pin the wrong bytes. Nothing offline can
 * prove that binding — Bun's asset names carry no version, the tag alone does — so adjacency is the whole
 * guard, and moving the pinned version means replacing this table from the new tag's release asset metadata.
 *
 * Several builds per host, most likely first, because one host target is not one binary: glibc and musl
 * need different builds, and pre-AVX2 x64 needs the baseline one. The installer reorders on what it can
 * detect and then PROVES the choice by running `--revision` — a build that cannot run on this machine is
 * simply the wrong candidate, and the next one is tried. Detection is an optimization; the probe decides.
 *
 * The same table is carried, signed, inside every release manifest (`jsApp.bunRuntime`), because the
 * updater that has to install a newer Bun is always the OLDER build: its own compiled pins describe the
 * runtime it was built for, never the one a later release needs. `cosy update` therefore installs the
 * runtime the RELEASE pins, from exactly this table as that release's source carried it.
 *
 * Keyed by INSTALLER host, which is not the same set as the release's compiled targets: `windows-x64` has
 * no compiled artifact and never will, and it is here because the PowerShell installer places the same
 * universal bundle and needs the same pinned runtime to execute it. Windows publishes no musl build (there
 * is no musl there) and no ARM64 row, because the broker refuses Windows ARM64 outright — a pinned archive
 * for a host the product declines would be a runtime nothing is allowed to use.
 */
export const PINNED_BUN_RUNTIME_ARCHIVES: Readonly<Record<string, readonly BunRuntimeArchive[]>> =
  Object.freeze({
    'linux-x64': Object.freeze([
      { asset: 'bun-linux-x64.zip', sha256: '3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18', size: 42015139 },
      { asset: 'bun-linux-x64-baseline.zip', sha256: '1fc2edac843102909e3a1be1d8d9802cc6071cf074e67e88231f4ffe0f8b397b', size: 42015103 },
      { asset: 'bun-linux-x64-musl.zip', sha256: '6e9ea98554ea0d05efda5840ae292618aaa3adefd66b0853520c5c86a37eac9c', size: 38594621 },
      { asset: 'bun-linux-x64-musl-baseline.zip', sha256: '4b5b0b5503f6ebf15161e8c56eb5a263134c05cd98a86dc11ee43ac5bda9862e', size: 38594585 },
    ]),
    'linux-arm64': Object.freeze([
      { asset: 'bun-linux-aarch64.zip', sha256: 'efa9813da5ed72423bf847f916e8d2c47c0d776add972354026a75e10da9aa21', size: 41786424 },
      { asset: 'bun-linux-aarch64-musl.zip', sha256: '8de8a0003cc2707bb555887e3d450e24e1edf3f605f491393e89ed61a8853420', size: 38194544 },
    ]),
    'darwin-arm64': Object.freeze([
      { asset: 'bun-darwin-aarch64.zip', sha256: '80afd4c069b46a6fa8f3ec520bebc750a7843e4a8d5b9583d29ad436c00a3403', size: 30530705 },
    ]),
    'windows-x64': Object.freeze([
      { asset: 'bun-windows-x64.zip', sha256: '0bf84e808552beea67bf1202a287a35c6c825d837b287b3f8e9dd513dba35d3d', size: 44639930 },
      { asset: 'bun-windows-x64-baseline.zip', sha256: 'd7a7d3eb216614544aab0cde2d8d9f2e4e87839bf5a30a1cd11d077f02d84e0c', size: 44639910 },
    ]),
  });

/** Where Bun publishes the tagged archives these digests describe. */
export const BUN_RELEASE_DOWNLOAD_BASE = 'https://github.com/oven-sh/bun/releases/download';

/**
 * One official Bun build: the release asset name, the sha256 Bun published for it, and its byte size.
 *
 * The size is the one GitHub reports for that release asset. It is not a second integrity claim -- the
 * digest is -- but it lets `cosy update` refuse an oversized or truncated download before reading a byte
 * past it, and before anything is extracted.
 */
export interface BunRuntimeArchive {
  asset: string;
  sha256: string;
  size: number;
}

/** Bounded because it runs during setup, repair, and doctor on a path an operator may have typed wrong. */
const RUNTIME_PROBE_TIMEOUT_MS = 5_000;
const RUNTIME_PROBE_MAX_BYTES = 4_096;

/** Reports the Bun version at `path`, or throws {@link ApplicationIdentityError}. Injectable for tests. */
export type BunRuntimeProbe = (path: string) => string;

function parseVersionCore(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.+-]*)?$/.exec(value.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True when `reported` is at least `minimum`, comparing numerically so 1.10.0 is newer than 1.9.0. */
export function bunVersionAtLeast(reported: string, minimum: string): boolean {
  const found = parseVersionCore(reported);
  const floor = parseVersionCore(minimum);
  if (!found || !floor) return false;
  for (let index = 0; index < 3; index += 1) {
    if (found[index]! !== floor[index]!) return found[index]! > floor[index]!;
  }
  return true;
}

/**
 * Ask the executable to identify itself, using Bun's own flag.
 *
 * `--revision` is chosen over evaluating an expression like `--print 'Bun.version'` deliberately: it makes
 * the probe answerable without executing any JavaScript, so it cannot be induced to run a `preload` from a
 * `bunfig.toml` that happens to sit in the working directory. Anything that is not Bun fails it — Node
 * rejects the flag, a shell rejects it, and `/bin/true` exits cleanly with no version to report, which is
 * why an empty answer is a failure rather than a pass.
 */
export function probeBunRuntimeBySpawn(path: string): string {
  const result = spawnSync(path, ['--revision'], {
    timeout: RUNTIME_PROBE_TIMEOUT_MS,
    maxBuffer: RUNTIME_PROBE_MAX_BYTES,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new ApplicationIdentityError(
      'bun-runtime-probe-failed',
      `${path} did not answer \`--revision\`, so it could not be confirmed as a Bun runtime`,
    );
  }
  const reported = (result.stdout ?? '').trim().split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!parseVersionCore(reported)) {
    throw new ApplicationIdentityError(
      'bun-runtime-unrecognized',
      `${path} is executable but did not report a Bun version, so it is not a Bun runtime`,
    );
  }
  return reported;
}

/**
 * Prove the executable at `path` is a Bun new enough to run this application, and return its version.
 *
 * Structural validation — absolute, safe characters, a regular executable file — says only that the OS can
 * exec it. `/bin/true` passes all of that and then starts nothing. This is the step that separates "a file
 * the kernel will run" from "the interpreter this JavaScript application needs".
 */
export function verifyBunRuntime(path: string, probe: BunRuntimeProbe = probeBunRuntimeBySpawn): string {
  const reported = probe(path);
  if (!bunVersionAtLeast(reported, MINIMUM_BUN_RUNTIME_VERSION)) {
    throw new ApplicationIdentityError(
      'bun-runtime-outdated',
      `${path} reports Bun ${reported}, but this build requires Bun ${MINIMUM_BUN_RUNTIME_VERSION} or newer`,
    );
  }
  return reported;
}

/**
 * The Bun that must appear in a service definition, validated before it can be written anywhere.
 *
 * The default is the runtime already executing this process, which is the one the operator proved works by
 * running the command. `COSYNCING_BUN_BIN` overrides it for hosts where those differ, and an override that
 * is relative, unsafe, not an executable file, not Bun, or too old is REFUSED rather than ignored —
 * silently falling back would write a unit naming a different interpreter from the one the operator asked
 * for.
 *
 * `runningVersion` short-circuits the probe for the one path that needs no proof: the runtime executing
 * this very process has already demonstrated it is a Bun that can run this bundle. Every other candidate is
 * spawned, so a mistyped override cannot be recorded on the strength of being executable.
 */
export function resolveBunRuntime(options: {
  execPath: string;
  override?: string;
  runningVersion?: string;
  probe?: BunRuntimeProbe;
}): { path: string; version: string } {
  const override = options.override?.trim();
  const path = override
    ? assertExecutableFile(
        assertSafePath(override, `${BUN_RUNTIME_OVERRIDE_VARIABLE} runtime`, 'bun-runtime-override-invalid'),
        `${BUN_RUNTIME_OVERRIDE_VARIABLE} runtime`,
        'bun-runtime-override-unusable',
      )
    : assertExecutableFile(
        assertSafePath(options.execPath, 'Bun runtime', 'bun-runtime-invalid'),
        'Bun runtime',
        'bun-runtime-unusable',
      );
  // Compared without re-validating `execPath`: an override is allowed to be the answer on a host whose own
  // exec path is unusable, and there "not self-evident" is simply the correct conclusion.
  const selfEvident = options.runningVersion && resolve(path) === resolve(options.execPath);
  const version = selfEvident
    ? verifyBunRuntime(path, () => options.runningVersion!)
    : verifyBunRuntime(path, options.probe ?? probeBunRuntimeBySpawn);
  return { path, version };
}

/**
 * Resolve the running artifact and its runtime, once, from primitives no call site should read directly.
 *
 * `mainPath` is `Bun.main`, which Bun has already resolved through the npm `cosyncing` bin symlink and the
 * `cosy` alias symlink to the real file — so the `bun-js` answer is the package's own bundle whichever
 * command name was typed, and the installed copy under `~/.cosyncing/bin/` answers as itself.
 */
export function resolveApplicationIdentity(options: {
  distribution: DistributionKind;
  execPath: string;
  mainPath?: string;
  sourceEntry: string;
  runtimeOverride?: string;
  /** Version of the Bun executing this process; lets the common case skip the subprocess probe. */
  runningRuntimeVersion?: string;
  /** Overrides how a non-running candidate identifies itself. Tests only; production spawns the candidate. */
  runtimeProbe?: BunRuntimeProbe;
}): ApplicationIdentity {
  const packaged = options.distribution !== 'source';
  if (options.distribution === 'native') {
    // The compiled executable IS the runtime; there is nothing external to validate or record.
    return {
      distribution: 'native',
      applicationPath: assertSafePath(options.execPath, 'native application', 'native-application-invalid'),
      packaged,
    };
  }
  // Every packaged JavaScript kind is the bundle Bun is executing; only a contributor checkout has no
  // packaged artifact and falls back to whichever module the contributor ran.
  const candidate = options.distribution === 'source' ? options.sourceEntry : options.mainPath;
  if (!candidate) {
    throw new ApplicationIdentityError(
      'application-entry-unresolved',
      'the running JavaScript application could not identify its own entry file',
    );
  }
  const applicationPath = assertSafePath(candidate, 'application', 'application-path-invalid');
  // The runtime is resolved defensively so `version`, `help`, and `doctor` keep working on a host whose Bun
  // has been moved or removed — those are exactly the moments an operator needs a diagnosis, and a hard
  // throw here would replace it with a stack trace. Every WRITING caller goes through requireRuntimePath.
  try {
    const runtime = resolveBunRuntime({
      execPath: options.execPath,
      ...(options.runtimeOverride ? { override: options.runtimeOverride } : {}),
      ...(options.runningRuntimeVersion ? { runningVersion: options.runningRuntimeVersion } : {}),
      ...(options.runtimeProbe ? { probe: options.runtimeProbe } : {}),
    });
    return {
      distribution: options.distribution,
      applicationPath,
      runtimePath: runtime.path,
      runtimeVersion: runtime.version,
      packaged,
    };
  } catch (error) {
    if (!(error instanceof ApplicationIdentityError)) throw error;
    return {
      distribution: options.distribution,
      applicationPath,
      runtimeProblem: { detailCode: error.detailCode, message: error.message },
      packaged,
    };
  }
}

/**
 * The validated runtime, or a refusal.
 *
 * Called by everything that writes a launch command — the setup transaction, the service providers, repair,
 * and the foreground relaunch. Recording an unprovable interpreter would produce a unit that reports
 * "installed" and can never start, so this fails closed rather than guessing `bun` and hoping PATH agrees.
 */
export function requireRuntimePath(identity: Readonly<ApplicationIdentity>): string {
  if (identity.runtimePath) return identity.runtimePath;
  if (identity.distribution === 'native') {
    throw new ApplicationIdentityError(
      'native-distribution-has-no-external-runtime',
      'a compiled native build embeds its runtime and has none to record',
    );
  }
  throw new ApplicationIdentityError(
    identity.runtimeProblem?.detailCode ?? 'bun-runtime-unresolved',
    identity.runtimeProblem?.message ?? 'the Bun runtime that must execute cosyncing could not be resolved',
  );
}

/**
 * The running process's own identity, read from the primitives exactly once.
 *
 * Every command entry point calls this instead of touching `process.execPath` or `Bun.main` itself, which is
 * what keeps the npm bin link, the `cosy` alias, the installed copy, and a source checkout from each growing
 * their own slightly different answer.
 *
 * @param sourceEntry the caller's own entry file, used only by a source checkout, where there is no packaged
 *   artifact and the "application" is whichever module the contributor ran.
 */
export function currentApplicationIdentity(
  distribution: DistributionKind,
  sourceEntry: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ApplicationIdentity {
  const override = environment[BUN_RUNTIME_OVERRIDE_VARIABLE]?.trim();
  return resolveApplicationIdentity({
    distribution,
    execPath: process.execPath,
    // Bun resolves this through the npm `cosyncing`/`cosy` bin symlinks to the real bundle, so both command
    // names and the receipt-owned copy each answer as the file that is actually executing.
    mainPath: Bun.main,
    sourceEntry,
    // The running runtime needs no subprocess to identify itself, which keeps every command that is not
    // overriding the runtime free of a spawn on startup.
    runningRuntimeVersion: Bun.version,
    ...(override ? { runtimeOverride: override } : {}),
  });
}

/**
 * The exact argv that runs this application, for a service manager, a relaunch, or a subprocess.
 *
 * One definition, so a systemd `ExecStart=`, a launchd `ProgramArguments`, and an in-process restart cannot
 * disagree about whether the runtime is part of the command.
 */
export function applicationLaunchCommand(
  identity: Readonly<ApplicationIdentity>,
  args: readonly string[] = [],
): string[] {
  // Never a bare `[applicationPath, ...]` for a JavaScript build. That would silently delegate to the
  // `#!/usr/bin/env bun` shebang and therefore to PATH — which the durable service deliberately restricts —
  // so the interpreter is always named explicitly, or the command is refused.
  return identity.distribution === 'native'
    ? [identity.applicationPath, ...args]
    : [requireRuntimePath(identity), identity.applicationPath, ...args];
}

/**
 * Directories a durable service needs on its restricted PATH because of HOW this artifact is launched.
 *
 * The runtime is exec'd by absolute path, so this is not about finding Bun. It is about the child processes
 * the broker starts: a `bun-js` install whose Bun lives in a version-manager directory would otherwise run
 * with a PATH that has no `bun` on it at all. Empty for `native`, which brings its own interpreter.
 */
export function applicationRuntimePathEntries(
  identity: Pick<ApplicationIdentity, 'runtimePath'>,
): string[] {
  return identity.runtimePath ? [dirname(identity.runtimePath)] : [];
}
