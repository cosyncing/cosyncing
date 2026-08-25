#!/usr/bin/env bun
/**
 * The separation between the cosyncing APPLICATION and the RUNTIME that executes it.
 *
 * Every assertion here fails on the pre-migration design, where `process.execPath` was assumed to be the
 * cosyncing executable. In the published JavaScript distribution that assumption is false: `process.execPath`
 * is Bun, and confusing the two produces failures that are invisible until a real service tries to start —
 * a unit that execs the interpreter with a stray `broker` argument, a bootstrap copy of Bun itself sitting
 * at `~/.cosyncing/bin/cosyncing`, or a web sidecar looked for beside `~/.bun/bin/`.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  applicationLaunchCommand,
  applicationRuntimePathEntries,
  bunVersionAtLeast,
  DISTRIBUTION_KINDS,
  isDistributionKind,
  MINIMUM_BUN_RUNTIME_VERSION,
  requireRuntimePath,
  resolveApplicationIdentity,
  resolveBunRuntime,
  type ApplicationIdentity,
} from '../../src/runtime/application-identity.ts';
import { BUILD_INFO, buildFingerprint } from '../../src/runtime/build-info.ts';
import { brokerRelaunchCommand } from '../../src/runtime/service-boundary.ts';
import {
  brokerServiceLaunchArgv,
  servicePathEntries,
} from '../../src/installation/service-manager.ts';
import { inspectInstalledBinary } from '../../src/installation/setup-actions.ts';
import { installedBinaryPath } from '../../src/installation/install-state.ts';

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, ...(detail ? { detail } : {}) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function threw(work: () => unknown): string | undefined {
  try {
    work();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const root = mkdtempSync(join(tmpdir(), 'cosyncing-application-identity-'));

try {
  // A believable install tree: an npm package directory whose `bin/cosyncing` is the JavaScript bundle, the
  // global bin symlinks npm creates for both command names, and a separately installed Bun.
  const npmPackageBin = join(root, 'prefix', 'lib', 'node_modules', 'cosyncing', 'bin');
  const globalBin = join(root, 'prefix', 'bin');
  const bunBin = join(root, 'runtimes', 'bun-1.3.8', 'bin');
  const stateHome = join(root, 'state');
  mkdirSync(npmPackageBin, { recursive: true });
  mkdirSync(globalBin, { recursive: true });
  mkdirSync(bunBin, { recursive: true });
  mkdirSync(join(stateHome, 'bin'), { recursive: true });

  // The entry a contributor checkout would run. Inert for the packaged distributions, which resolve the
  // artifact Bun was handed instead.
  const sourceCheckoutEntry = join(root, 'repo', 'cli.ts');
  const applicationBundle = join(npmPackageBin, 'cosyncing');
  writeFileSync(applicationBundle, '#!/usr/bin/env bun\nconsole.log("cosyncing");\n', { mode: 0o755 });
  // These stand-ins answer `--revision` the way the real runtimes do, so the probe below is the production
  // one rather than an injected fake: a Bun that is new enough, a Bun that is too old, something executable
  // that is not Bun at all, and something that fails outright.
  function fakeRuntime(path: string, script: string): string {
    writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return path;
  }
  const bunRuntime = fakeRuntime(join(bunBin, 'bun'), 'echo 1.3.8+aaaaaaaaaa');
  // One patch below the floor: the refusal must hold at the boundary, not only for an ancient Bun.
  const outdatedBun = fakeRuntime(join(root, 'runtimes', 'outdated-bun'), 'echo 1.3.7+aaaaaaaaaa');
  const silentExecutable = fakeRuntime(join(root, 'runtimes', 'not-bun'), 'exit 0');
  const failingExecutable = fakeRuntime(join(root, 'runtimes', 'broken'), 'exit 3');
  symlinkSync(applicationBundle, join(globalBin, 'cosyncing'));
  symlinkSync(applicationBundle, join(globalBin, 'cosy'));

  check('the distribution vocabulary is closed and recognizes only its own members',
    DISTRIBUTION_KINDS.length === 3
      && DISTRIBUTION_KINDS.every((kind) => isDistributionKind(kind))
      && !isDistributionKind('packaged') && !isDistributionKind('') && !isDistributionKind(undefined),
    DISTRIBUTION_KINDS.join(','));

  // ---- The central regression: the application is never the runtime -------------------------------------
  //
  // Bun resolves `Bun.main` through the bin symlink to the real file, so a JavaScript install invoked as
  // `cosyncing`, as `cosy`, or directly all name the same bundle — and none of them name Bun.
  const jsIdentity = resolveApplicationIdentity({
    distribution: 'bun-js',
    execPath: bunRuntime,
    mainPath: applicationBundle,
    sourceEntry: sourceCheckoutEntry,
  });
  check('a JavaScript application never resolves its artifact to the runtime executing it',
    jsIdentity.applicationPath === applicationBundle
      && jsIdentity.applicationPath !== jsIdentity.runtimePath
      && jsIdentity.runtimePath === bunRuntime
      && jsIdentity.packaged === true,
    `${jsIdentity.applicationPath} via ${jsIdentity.runtimePath}`);

  // The alias and the primary command are the same file, so both must produce the identical identity — a
  // package that answered differently for `cosy` would receipt and service two different artifacts.
  const aliasIdentity = resolveApplicationIdentity({
    distribution: 'bun-js',
    execPath: bunRuntime,
    // What Bun reports after resolving `<prefix>/bin/cosy`: the real file, not the link.
    mainPath: applicationBundle,
    sourceEntry: sourceCheckoutEntry,
  });
  check('the cosy alias and the cosyncing command resolve to one identical application identity',
    JSON.stringify(aliasIdentity) === JSON.stringify(jsIdentity));

  // The receipt-owned copy the service actually execs answers as itself, not as the acquisition package.
  const installedCopy = installedBinaryPath(stateHome);
  writeFileSync(installedCopy, '#!/usr/bin/env bun\nconsole.log("cosyncing");\n', { mode: 0o700 });
  const installedIdentity = resolveApplicationIdentity({
    distribution: 'bun-js',
    execPath: bunRuntime,
    mainPath: installedCopy,
    sourceEntry: sourceCheckoutEntry,
  });
  check('the installed copy under the state home resolves as its own application',
    installedIdentity.applicationPath === installedCopy
      && installedIdentity.applicationPath !== jsIdentity.applicationPath);

  const nativeIdentity = resolveApplicationIdentity({
    distribution: 'native',
    execPath: applicationBundle,
    sourceEntry: sourceCheckoutEntry,
  });
  check('a compiled native build is its own runtime and records no external interpreter',
    nativeIdentity.applicationPath === applicationBundle
      && nativeIdentity.runtimePath === undefined
      && nativeIdentity.packaged === true);

  const sourceIdentity = resolveApplicationIdentity({
    distribution: 'source',
    execPath: bunRuntime,
    mainPath: applicationBundle,
    sourceEntry: join(root, 'repo', 'cli.ts'),
  });
  mkdirSync(join(root, 'repo'), { recursive: true });
  check('a source checkout resolves its declared entry rather than whatever file Bun was handed',
    sourceIdentity.applicationPath === join(root, 'repo', 'cli.ts')
      && sourceIdentity.runtimePath === bunRuntime
      && sourceIdentity.packaged === false);

  // ---- Launch commands ---------------------------------------------------------------------------------
  check('a JavaScript launch names the runtime first and the application second',
    JSON.stringify(applicationLaunchCommand(jsIdentity, ['broker']))
      === JSON.stringify([bunRuntime, applicationBundle, 'broker']));
  check('a native launch is the executable alone, with no interpreter prefix',
    JSON.stringify(applicationLaunchCommand(nativeIdentity, ['broker']))
      === JSON.stringify([applicationBundle, 'broker']));
  check('relaunch re-enters Bun plus the application, never bare Bun and never the bundle alone',
    JSON.stringify(brokerRelaunchCommand({ identity: jsIdentity, argv: [] }))
      === JSON.stringify([bunRuntime, applicationBundle, 'broker']));
  check('the service argv and the relaunch argv agree about the launch model',
    JSON.stringify(brokerServiceLaunchArgv({
      executablePath: installedCopy,
      distribution: 'bun-js',
      runtimePath: bunRuntime,
    })) === JSON.stringify([bunRuntime, installedCopy, 'broker']));

  // The unit is refused rather than written in a shape that would look installed and never start. Omitting
  // the runtime does not produce an obviously broken `ExecStart=` — it produces a valid one that resolves
  // the interpreter through the deliberately restricted service PATH, which is the failure worth refusing.
  const argvWithoutRuntime = threw(() => brokerServiceLaunchArgv({
    executablePath: installedCopy,
    distribution: 'bun-js',
  }));
  const nativeArgvWithRuntime = threw(() => brokerServiceLaunchArgv({
    executablePath: installedCopy,
    distribution: 'native',
    runtimePath: bunRuntime,
  }));
  check('a JavaScript service definition without a validated runtime is refused, and a native one with a runtime too',
    !!argvWithoutRuntime && !!nativeArgvWithRuntime,
    `${argvWithoutRuntime} / ${nativeArgvWithRuntime}`);

  // ---- Fail-closed runtime resolution -------------------------------------------------------------------
  //
  // A launch command is written to a file a service manager will exec long after this process is gone. An
  // unprovable interpreter must therefore be refused at the point of writing, not discovered at boot.
  const relativeOverride = threw(() => resolveBunRuntime({ execPath: bunRuntime, override: 'bun' }));
  const traversalOverride = threw(() => resolveBunRuntime({ execPath: bunRuntime, override: '../bun' }));
  const missingOverride = threw(() => resolveBunRuntime({
    execPath: bunRuntime,
    override: join(bunBin, 'not-installed'),
  }));
  const directoryOverride = threw(() => resolveBunRuntime({ execPath: bunRuntime, override: bunBin }));
  const nonExecutable = join(root, 'runtimes', 'not-executable');
  writeFileSync(nonExecutable, 'text\n', { mode: 0o644 });
  const nonExecutableOverride = threw(() => resolveBunRuntime({
    execPath: bunRuntime,
    override: nonExecutable,
  }));
  check('a relative, traversing, missing, non-file, or non-executable runtime override is refused, never ignored',
    !!relativeOverride && !!traversalOverride && !!missingOverride
      && !!directoryOverride && !!nonExecutableOverride,
    [relativeOverride, traversalOverride, missingOverride, directoryOverride, nonExecutableOverride]
      .filter(Boolean).length + '/5 refused');

  // ---- Being executable is not being Bun ----------------------------------------------------------------
  //
  // Structural validation accepts anything the kernel will run, and `/bin/true` passes all of it while
  // starting nothing. These are the states where the operator pointed the variable at a real file that
  // simply is not the interpreter this application needs.
  function overrideProblem(override: string): string | undefined {
    return resolveApplicationIdentity({
      distribution: 'bun-js',
      execPath: bunRuntime,
      mainPath: applicationBundle,
      sourceEntry: sourceCheckoutEntry,
      runtimeOverride: override,
    }).runtimeProblem?.detailCode;
  }
  check('an executable that is not Bun is refused for not identifying itself, not accepted for being executable',
    overrideProblem(silentExecutable) === 'bun-runtime-unrecognized'
      && overrideProblem(failingExecutable) === 'bun-runtime-probe-failed',
    `${overrideProblem(silentExecutable)} / ${overrideProblem(failingExecutable)}`);
  check('a Bun older than the published engines floor is refused rather than warned about',
    overrideProblem(outdatedBun) === 'bun-runtime-outdated', overrideProblem(outdatedBun));

  // The floor is published in `engines.bun` and enforced here. npm only WARNS on an unsatisfied engine and
  // installs anyway, so a manifest number that nothing enforces is documentation, not a requirement.
  const declaredEngine = ((await Bun.file(join(import.meta.dir, '../../../../../package.json')).json())
    .engines?.bun ?? '') as string;
  check('the enforced minimum Bun version is exactly the one the npm package publishes',
    declaredEngine === `>=${MINIMUM_BUN_RUNTIME_VERSION}`, `engines.bun=${declaredEngine}`);
  check('version comparison is numeric, so 1.10.0 is newer than 1.9.0 rather than lexically older',
    bunVersionAtLeast('1.10.0', '1.9.0') && bunVersionAtLeast('1.3.8+abc', '1.3.0')
      && !bunVersionAtLeast('1.2.9', '1.3.0') && !bunVersionAtLeast('v22.14.0', '1.3.0')
      && !bunVersionAtLeast('', '1.3.0'));

  // The running runtime has already proved it can execute this bundle by executing it, so it is taken on
  // that evidence — every OTHER candidate is spawned. Without the short-circuit each command would pay a
  // subprocess at startup.
  let probes = 0;
  const selfEvident = resolveBunRuntime({
    execPath: bunRuntime,
    runningVersion: '1.3.8',
    probe: () => { probes += 1; return '1.3.8'; },
  });
  const overrideProbed = resolveBunRuntime({
    execPath: bunRuntime,
    override: outdatedBun,
    runningVersion: '1.3.8',
    probe: () => { probes += 1; return '1.3.8'; },
  });
  check('the running runtime is trusted without a subprocess, and any other candidate is still probed',
    probes === 1 && selfEvident.version === '1.3.8' && overrideProbed.path === outdatedBun,
    `${probes} probe(s)`);

  // Identity rejects only cross-platform control characters. Provider serializers own their narrower
  // grammars: the systemd suite separately proves that it refuses `%` and colon-bearing PATH entries, while
  // Windows drive-qualified paths must survive this shared boundary.
  const unsafeCharacters = threw(() => resolveBunRuntime({
    execPath: bunRuntime,
    override: `${bunRuntime}\nExecStart=/bin/sh`,
  }));
  const colonDirectory = join(root, 'runtimes', 'a:b');
  mkdirSync(colonDirectory, { recursive: true });
  const colonRuntime = fakeRuntime(join(colonDirectory, 'bun'), 'echo 1.3.8+aaaaaaaaaa');
  const colonIdentity = resolveBunRuntime({ execPath: bunRuntime, override: colonRuntime });
  const percentDirectory = join(root, 'runtimes', 'a%b');
  mkdirSync(percentDirectory, { recursive: true });
  const percentRuntime = fakeRuntime(join(percentDirectory, 'bun'), 'echo 1.3.8+aaaaaaaaaa');
  const percentIdentity = resolveBunRuntime({ execPath: bunRuntime, override: percentRuntime });
  check('identity refuses control characters but preserves provider-specific path characters',
    !!unsafeCharacters && colonIdentity.path === colonRuntime && percentIdentity.path === percentRuntime,
    unsafeCharacters);

  // A symlinked / version-manager Bun is a legitimate installation and must be accepted as given: pinning
  // its realpath would break an in-place upgrade behind a stable shim.
  const shimmedBun = join(root, 'runtimes', 'shim-bun');
  symlinkSync(bunRuntime, shimmedBun);
  check('a symlinked version-manager runtime is accepted at the path the operator uses',
    resolveBunRuntime({ execPath: shimmedBun }).path === shimmedBun);

  // Read-only commands survive an unusable runtime; writing commands do not.
  const strandedIdentity = resolveApplicationIdentity({
    distribution: 'bun-js',
    execPath: bunRuntime,
    mainPath: applicationBundle,
    sourceEntry: sourceCheckoutEntry,
    runtimeOverride: join(bunBin, 'removed-by-a-package-manager'),
  });
  check('an unresolvable runtime degrades to a reported problem instead of crashing diagnosis',
    strandedIdentity.applicationPath === applicationBundle
      && strandedIdentity.runtimePath === undefined
      && strandedIdentity.runtimeVersion === undefined
      && !!strandedIdentity.runtimeProblem?.detailCode,
    strandedIdentity.runtimeProblem?.detailCode);
  check('every command that would WRITE a launch command fails closed on that same state',
    !!threw(() => requireRuntimePath(strandedIdentity))
      && !!threw(() => applicationLaunchCommand(strandedIdentity, ['broker']))
      && !!threw(() => brokerServiceLaunchArgv({
        executablePath: installedCopy,
        distribution: strandedIdentity.distribution,
        ...(strandedIdentity.runtimePath ? { runtimePath: strandedIdentity.runtimePath } : {}),
      })));

  // ---- Setup copies the application, not the runtime ----------------------------------------------------
  //
  // This is the check that would have caught a bootstrap copy of Bun landing at ~/.cosyncing/bin/cosyncing:
  // the inspection's source is the APPLICATION path, so a stale copy is compared against the bundle's bytes.
  rmSync(installedCopy, { force: true });
  const beforeCopy = inspectInstalledBinary({
    home: stateHome,
    packaged: true,
    executablePath: jsIdentity.applicationPath,
  });
  writeFileSync(installedCopy, '#!/usr/bin/env bun\nconsole.log("cosyncing");\n', { mode: 0o700 });
  const afterCopy = inspectInstalledBinary({
    home: stateHome,
    packaged: true,
    executablePath: jsIdentity.applicationPath,
  });
  const runtimeMistakenForApplication = inspectInstalledBinary({
    home: stateHome,
    packaged: true,
    executablePath: bunRuntime,
  });
  check('setup measures the JavaScript application as the copy source, so a Bun copy reads as stale',
    beforeCopy.status === 'missing' && afterCopy.status === 'current'
      && runtimeMistakenForApplication.status === 'stale',
    `${beforeCopy.status} → ${afterCopy.status}; runtime-as-source=${runtimeMistakenForApplication.status}`);

  // ---- Restricted service PATH --------------------------------------------------------------------------
  const pathEntries = servicePathEntries(join(root, 'home'), installedCopy, [], bunRuntime);
  check('the runtime directory joins the restricted service PATH without widening it to the shell PATH',
    pathEntries.includes(bunBin)
      && pathEntries.includes(dirname(installedCopy))
      && pathEntries.every((entry) => entry.startsWith('/') && !entry.includes(':'))
      && pathEntries.length === new Set(pathEntries).size
      && pathEntries.length <= 10,
    pathEntries.join(':'));
  check('a native install adds no runtime directory to the service PATH',
    !servicePathEntries(join(root, 'home'), installedCopy, []).includes(bunBin)
      && applicationRuntimePathEntries(nativeIdentity).length === 0
      && JSON.stringify(applicationRuntimePathEntries(jsIdentity)) === JSON.stringify([bunBin]));

  // ---- Build identity -----------------------------------------------------------------------------------
  //
  // Two artifacts built from one commit at one instant — a JavaScript bundle and a compiled executable — are
  // different software with different launch models. A fingerprint that could not tell them apart would let
  // one answer setup's post-install health check on behalf of the other.
  const base = { ...BUILD_INFO, version: '1.0.0', commit: 'abc1234', buildDate: '2026-08-08T00:00:00.000Z', dirty: false };
  check('the build fingerprint distinguishes a JavaScript artifact from a compiled one',
    buildFingerprint({ ...base, distribution: 'bun-js', target: 'universal' })
      !== buildFingerprint({ ...base, distribution: 'native', target: 'universal' })
      && buildFingerprint({ ...base, distribution: 'bun-js', target: 'universal' }).endsWith('/bun-js'));

  // A source checkout is what an unstamped or corrupted define degrades to, and a source build can neither
  // install a durable service nor replace itself — so the fallback cannot reach the native swap path.
  check('the running build reports a recognized distribution kind and a packaged flag derived from it',
    isDistributionKind(BUILD_INFO.distribution)
      && BUILD_INFO.packaged === (BUILD_INFO.distribution !== 'source'),
    `${BUILD_INFO.distribution}/packaged=${BUILD_INFO.packaged}`);

  // A native identity has no runtime to require, and saying so distinctly keeps a native regression from
  // being reported as a missing Bun.
  const nativeRequire = threw(() => requireRuntimePath(nativeIdentity as ApplicationIdentity));
  check('requiring a runtime from a native build names that specific impossibility',
    !!nativeRequire && nativeRequire.includes('embeds'), nativeRequire);

  // Directories are not launchable; neither is a path that does not exist. Both are refused before a unit
  // can be written naming them.
  chmodSync(applicationBundle, 0o755);
  check('an application path that is empty or relative is refused',
    !!threw(() => resolveApplicationIdentity({
      distribution: 'bun-js', execPath: bunRuntime, mainPath: 'bin/cosyncing', sourceEntry: sourceCheckoutEntry,
    }))
      && !!threw(() => resolveApplicationIdentity({
        distribution: 'bun-js', execPath: bunRuntime, sourceEntry: sourceCheckoutEntry,
      })));
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length}/${results.length} application-identity checks failed.`);
  process.exit(1);
}
console.log(`\nPASS ${results.length}/${results.length} application-identity checks`);
