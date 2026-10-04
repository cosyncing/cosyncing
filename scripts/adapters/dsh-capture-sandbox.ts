/**
 * The capture sandbox: the rules that keep a contract capture off real storage.
 *
 * Split out of the capture runner so the runner and its test read the same
 * rules. A guard only the runner can see is a guard nobody can test, and the
 * first version of this was exactly that: it overrode `HOME`, inherited
 * everything else, and so let an exported `DSH_HOME` point an "isolated" child
 * at the operator's real sessions and provider credentials.
 */
export {};
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * Refuse a home that could reach the owner's real sessions or their credentials.
 *
 * The risk is not that the disposable directory sits somewhere under the account;
 * `/tmp` on this machine does, and a ban on that would be a ban on running. The
 * risk is that a REAL state root ends up inside the directory we hand the child as
 * HOME, because then the child reads the owner's sessions and provider
 * credentials and calls them its own. So the containment test points inwards.
 */
export function assertDisposableHome(
  home: string,
  options: { cosyncingHome?: string } = {},
): void {
  const realHome = homedir();
  if (resolve(home) === resolve(realHome)) {
    throw new Error('refusing to hand the child the real account home as its home');
  }
  const protectedRoots = [
    join(realHome, '.dsh'),
    options.cosyncingHome ?? process.env['COSYNCING_HOME'] ?? join(realHome, '.cosyncing'),
  ];
  for (const protectedPath of protectedRoots) {
    const rel = relative(home, protectedPath);
    if (!rel.startsWith('..') && !isAbsolute(rel)) {
      throw new Error(`the capture home would contain a real data root: ${protectedPath}`);
    }
  }
  if (existsSync(home) && readdirSync(home).length > 0) {
    throw new Error(`the capture home already has content: ${home}`);
  }
}

/**
 * The child's environment, built rather than inherited.
 *
 * Overriding `HOME` is not enough. The installed host resolves `DSH_HOME`,
 * through `@deepseek-ai/dsh-home-paths`, BEFORE `~/.dsh`, so an operator who
 * exports `DSH_HOME` for their own harness keeps all of their real sessions and
 * provider credentials in play while the run record still says the capture was
 * isolated. Spreading `process.env` also forwards every provider key in the
 * shell, which is what made the old comment about credentials being
 * inaccessible through a temporary HOME simply untrue.
 *
 * So the child gets a named list of OS plumbing plus state roots that all sit
 * under the disposable home, and nothing else. Anything the host needs in order
 * to spend money has to be named on the command line, which puts the decision in
 * front of the operator and writes it into the provenance record.
 */
export const INHERITED_NAMES = [
  'PATH', 'SHELL', 'TERM', 'TERM_PROGRAM', 'TZ', 'LANG', 'LC_ALL', 'TMPDIR',
  'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
] as const;

/**
 * Names that may never arrive by deliberate injection.
 *
 * The allowlist already keeps these out on the normal path. They are checked
 * again on the injection path, where the operator supplies a NAME rather than a
 * value: forwarding a variable that relocates storage would hand the child the
 * owner's harness home while the run still looked contained.
 */
export const NEVER_INJECTABLE = [
  'DSH_HOME', 'DSH_AGENTS_HOME', 'HOME', 'USERPROFILE', 'TMPDIR', 'XDG_', 'COSYNCING_', 'PATH', 'SystemRoot', 'WINDIR',
];

export function isNeverInjectable(name: string): boolean {
  const upper = name.toUpperCase();
  return NEVER_INJECTABLE.some((blocked) => upper === blocked || upper.startsWith(blocked));
}

/** State roots the host may write under. All of them are ours, under `home`. */
export function isolatedStateRoots(home: string): Record<string, string> {
  const dshHome = join(home, '.dsh');
  return {
    HOME: home,
    USERPROFILE: home,
    // Pinned, not inherited: this override is the one that defeated the HOME guard.
    DSH_HOME: dshHome,
    DSH_AGENTS_HOME: join(dshHome, 'agents'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    // A capture that phones home about the owner's machine is a leak of a
    // different kind, and the child must not be able to opt out of this one.
    DSH_TELEMETRY_DISABLED: '1',
  };
}

export function buildChildEnvironment(options: {
  home: string;
  inherited: Readonly<Record<string, string | undefined>>;
  injectedNames?: readonly string[];
}): { env: Record<string, string>; injected: string[] } {
  const env: Record<string, string> = {};
  for (const name of INHERITED_NAMES) {
    const value = options.inherited[name];
    if (value !== undefined) env[name] = value;
  }
  // Credential variables arrive by name only, and only for a scenario the
  // operator asked for; the value is read at spawn time and never recorded.
  const injected: string[] = [];
  for (const name of options.injectedNames ?? []) {
    if (isNeverInjectable(name)) {
      throw new Error(`--credential-env ${name} names a state or path root; those are pinned, not injectable`);
    }
    const value = options.inherited[name];
    if (value === undefined || value.trim() === '') {
      throw new Error(`--credential-env ${name} is not set here; refusing to run a scenario that cannot work`);
    }
    env[name] = value;
    injected.push(name);
  }
  // Applied last: no inherited or injected name can win against a state root.
  Object.assign(env, isolatedStateRoots(options.home));
  return { env, injected };
}

/**
 * Prove that every root the child can write to sits inside the disposable home.
 *
 * `assertDisposableHome` reasons about where the home is. This reasons about
 * where the child actually ends up, which is the thing the provenance record
 * claims, and is the check that the `DSH_HOME` override used to slip past.
 */
export function assertRootsContained(
  home: string,
  env: Readonly<Record<string, string>>,
  workspace: string,
): void {
  const roots = [env['DSH_HOME'], env['HOME'], env['DSH_AGENTS_HOME'], env['XDG_STATE_HOME'], env['XDG_CACHE_HOME'], workspace];
  const realHome = resolve(homedir());
  for (const root of roots) {
    if (root === undefined) continue;
    // The home itself counts as contained: HOME is legitimately the home, and
    // only an escape out of it is a finding.
    const rel = relative(home, resolve(root));
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`the child would write outside the disposable home: ${root} is not under ${home}`);
    }
    const fromReal = relative(realHome, resolve(root));
    if (!fromReal.startsWith('..') && !isAbsolute(fromReal)) {
      throw new Error(`the child would write inside the real account home: ${root}`);
    }
  }
}

/**
 * The first-use Workspace directory, pinned inside the disposable home.
 *
 * A host with no Workspace and no Session asks the operating system for its
 * Documents directory and creates `<Documents>/deepseek-harness/<default>`
 * before the web composer will enable itself. On linux that lookup is
 * `xdg-user-dir DOCUMENTS`, and for an account with no `user-dirs.dirs` it
 * prints `$HOME`. The host reads that as "this user directory is disabled" and
 * refuses to create the default Workspace, so the web composer stays disabled.
 * Direct API session creation can instead use the host's working directory;
 * this UI prerequisite does not establish whether an API prompt is admissible.
 *
 * The same lookup is an isolation hole on the platforms that interrogate the OS
 * instead of a config file: macOS resolves the operator's real Documents folder
 * and the host would create a directory inside it. So the pin is claimed only
 * where writing the file actually controls the answer, and every other platform
 * is reported as unable to create a Workspace safely.
 */
export interface DocumentsProvision {
  /** Where a first-use host will look, absolute, whether or not we control it. */
  documentsDirectory: string;
  userDirsFile: string;
  /** True only where this function's own file decides what the host resolves. */
  pinned: boolean;
  reason: string;
}

const USER_DIRS_CONTENTS = [
  '# Written by the cosyncing DSH contract capture so a first-use host can',
  '# create its default Workspace inside the disposable home.',
  'XDG_DESKTOP_DIR="$HOME/Desktop"',
  'XDG_DOWNLOAD_DIR="$HOME/Downloads"',
  'XDG_TEMPLATES_DIR="$HOME/Templates"',
  'XDG_PUBLICSHARE_DIR="$HOME/Public"',
  'XDG_DOCUMENTS_DIR="$HOME/Documents"',
  'XDG_MUSIC_DIR="$HOME/Music"',
  'XDG_PICTURES_DIR="$HOME/Pictures"',
  'XDG_VIDEOS_DIR="$HOME/Videos"',
].join('\n');

export function provisionDocumentsDirectory(
  home: string,
  platform: NodeJS.Platform = process.platform,
): DocumentsProvision {
  const documentsDirectory = join(home, 'Documents');
  // Derived from the pin so the file cannot drift from where the child looks;
  // the fallback only satisfies the index type, the pin always supplies it.
  const configHome = isolatedStateRoots(home)['XDG_CONFIG_HOME'] ?? join(home, '.config');
  const userDirsFile = join(configHome, 'user-dirs.dirs');
  if (platform !== 'linux') {
    return {
      documentsDirectory, userDirsFile, pinned: false,
      reason: `the ${platform} Documents lookup asks the operating system, which resolves the operator's own account`,
    };
  }
  mkdirSync(documentsDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(userDirsFile), { recursive: true, mode: 0o700 });
  writeFileSync(userDirsFile, `${USER_DIRS_CONTENTS}\n`, { mode: 0o600 });
  return {
    documentsDirectory, userDirsFile, pinned: true,
    reason: 'user-dirs.dirs pins XDG_DOCUMENTS_DIR inside the disposable home',
  };
}

/**
 * Read a real `xdg-user-dir DOCUMENTS` answer the way the host reads it.
 *
 * The first two rules are the host's own: empty and equal-to-home both mean
 * "unavailable" upstream, and the host throws before anything is created. The
 * containment rule is ours and is stricter: an answer that leaves the
 * disposable home would have the host create a Workspace we cannot clean up, so
 * it is treated exactly like the upstream refusals.
 */
export function acceptsDefaultWorkspace(
  resolved: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
): { usable: boolean; reason: string } {
  if (platform !== 'linux') {
    return { usable: false, reason: `the ${platform} Documents lookup cannot be pinned` };
  }
  const trimmed = resolved.trim();
  if (trimmed === '') return { usable: false, reason: 'xdg-user-dir DOCUMENTS returned nothing' };
  const normalized = resolve(trimmed);
  if (normalized === resolve(home)) {
    return { usable: false, reason: 'xdg-user-dir DOCUMENTS resolved to the home, which the host calls unavailable' };
  }
  const rel = relative(home, normalized);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { usable: false, reason: `xdg-user-dir DOCUMENTS resolved outside the disposable home: ${normalized}` };
  }
  return { usable: true, reason: `the default Workspace will be created under ${normalized}` };
}

export interface DocumentsProbe {
  probed: boolean;
  exit: number | null;
  resolvedUnderHome: string | null;
  resolvedWasHome: boolean;
  usable: boolean;
  reason: string;
}

/** Record the web UI's default-directory prerequisite without aborting free captures. */
export function probeDefaultWorkspace(
  home: string,
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): DocumentsProbe {
  const unavailable: DocumentsProbe = {
    probed: false, exit: null, resolvedUnderHome: null, resolvedWasHome: false,
    usable: false, reason: `the ${platform} Documents lookup cannot be pinned`,
  };
  // These platforms consult the real OS account, not the isolated XDG config.
  // Do not execute a Linux helper or probe the operator's Documents directory.
  if (platform !== 'linux') return unavailable;
  try {
    const probe = Bun.spawnSync(['xdg-user-dir', 'DOCUMENTS'], {
      env, stdout: 'pipe', stderr: 'pipe', timeout: 5_000,
    });
    if (probe.exitCode !== 0) {
      return { ...unavailable, probed: true, exit: probe.exitCode,
        reason: `xdg-user-dir DOCUMENTS failed (exit ${String(probe.exitCode)})` };
    }
    const stdout = probe.stdout.toString().trim();
    const verdict = acceptsDefaultWorkspace(stdout, home, platform);
    return {
      probed: true, exit: probe.exitCode,
      resolvedUnderHome: verdict.usable ? relative(home, resolve(stdout)) : null,
      resolvedWasHome: stdout !== '' && resolve(stdout) === resolve(home),
      usable: verdict.usable, reason: verdict.reason,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ...unavailable, reason: code === 'ENOENT'
      ? 'xdg-user-dir is unavailable; the default Workspace lookup was not verified'
      : 'xdg-user-dir DOCUMENTS could not be executed' };
  }
}
