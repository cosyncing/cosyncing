/**
 * The cosyncing Claude mod, seen from the broker's installation boundary.
 *
 * Setup installs the mod through Claude's own `claude plugin` commands, so cosyncing never
 * hand-edits `~/.claude`. That choice decides the shape of everything here: the
 * broker owns ONE directory it materializes (a stable local marketplace under the state home) and
 * Claude owns the two settings keys and its own plugin cache. Reversal therefore runs Claude's
 * own uninstall and remove, and the only thing cosyncing deletes is the directory it wrote.
 *
 * Two rules the file keeps together, because they were each measured rather than assumed:
 *
 * - The settings keys land in `<config>/settings.json`, not in `.claude.json`, and there are exactly two:
 *   `extraKnownMarketplaces.cosyncing` with `source: {source: "directory", path}`, and
 *   `enabledPlugins["cosyncing-claude@cosyncing"]: true`. Both were read back out of a scratch
 *   `CLAUDE_CONFIG_DIR` on Claude Code 2.1.289 on Linux (2026-10-05), together with every command's
 *   machine-readable answer and what the reversal leaves behind (both keys, emptied). The fake CLI in
 *   `test/helpers/fake-claude-cli.ts` plays those answers back.
 * - `claude plugin install` reads the plugin IN PLACE from the marketplace directory, so the
 *   marketplace path is not a build artefact that can move. It is the one path here with a
 *   stability contract, and the reason it sits under the state home rather than beside the
 *   executable, which is where the 0.6.3 web sidecar path went stale.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { resolveInvocation, spawnResolvedInvocation } from '@cosyncing/adapter-api';
import {
  CLAUDE_MOD_MARKETPLACE_FILES,
  CLAUDE_MOD_MARKETPLACE_NAME,
  CLAUDE_MOD_PLUGIN_NAME,
  stampClaudeModMarketplace,
} from '../runtime/runtime-assets.ts';
import { CLAUDE_MOD_MIN_VERSION, claudeVersionAtLeast } from '@cosyncing/adapter-claude';
import { MOD_SOCKET_FILENAME, modSocketPathDialable } from '../sessions/mod-socket-path.ts';
import {
  assertNoSymlinkComponents,
  atomicWriteJsonOwnerOnly,
  ensureOwnerOnlyDirectory,
  inspectOwnerOnlyDirectory,
} from '../security/secure-files.ts';
import type { InstalledResourceRecord, InstallStateInspection } from './install-state.ts';

/** Receipt id. Also the runtime asset id, so the ledger names the thing the package ships. */
export const CLAUDE_MOD_RESOURCE_ID = 'claude-mod-marketplace';

/** The marketplace name the mod is installed under, and the plugin id inside it. */
export const CLAUDE_MOD_PLUGIN_ID = `${CLAUDE_MOD_PLUGIN_NAME}@${CLAUDE_MOD_MARKETPLACE_NAME}`;

/**
 * The two settings keys the install writes, spelled the way Claude spells them.
 *
 * Named here so uninstall, doctor, and the consent text all point at the same pair. Nothing else
 * in `~/.claude` is cosyncing's to touch, and a rollback that removed a third key would be a
 * rollback that broke someone else's plugin.
 */
export const CLAUDE_MOD_SETTINGS_KEYS = Object.freeze({
  marketplace: 'extraKnownMarketplaces.cosyncing',
  plugin: 'enabledPlugins["cosyncing-claude@cosyncing"]',
});

/** Why this host will not get the mod, in the words the plan prints. Ordered by how it is decided. */
export type ClaudeModSkipReason =
  | 'missing-cli'
  | 'below-minimum-version'
  | 'native-windows'
  /**
   * `CLAUDE_CONFIG_DIR` is set to a relative path. Claude resolves it against whatever directory each
   * session starts in, so there is no one settings file to install into or to read back; cosyncing
   * refuses it with this reason rather than guessing which directory the operator meant.
   */
  | 'config-dir-relative'
  | 'org-policy'
  /** A managed policy file exists and cannot be read or parsed: not evidence of permission. */
  | 'managed-settings-unreadable'
  /**
   * Claude's own `settings.json` will not parse.
   *
   * Its own reason, because the two fixes are nothing alike: the operator's Claude settings are not
   * cosyncing's to repair, and reading a broken file as a security failure made every setup run on
   * that host refuse to do ANYTHING, over a mod the host was never going to install. Everything else
   * in setup carries on; this one item is skipped and says what it found.
   */
  | 'settings-invalid';

export interface ClaudeModSupport {
  supported: boolean;
  skipReason?: ClaudeModSkipReason;
  /** The Claude version the host reported, when it reported one. */
  detectedVersion?: string;
  minimumVersion: string;
  /** Org policy keys that would refuse a directory marketplace, when any are present. */
  policyKeys?: string[];
  /** Managed policy files that exist and could not be read or parsed, when that is the reason. */
  policyUnreadable?: string[];
}

/** Marketplace directory the host is told about. Stable across versions by contract. */
export function claudeModMarketplaceDir(stateHome: string): string {
  return join(stateHome, 'claude-mod', 'marketplace');
}

/**
 * The socket path stamped into this installation's copy of the mod: where its broker binds.
 *
 * The broker binds `<state home>/claude-mod.sock` unless `COSYNCING_CLAUDE_SOCK` overrides it, and an
 * override is a per-process test and review lever that the installed service does not carry, so the
 * stamp is the state home's path. A path the mod could not dial (too long, not absolute) is not
 * stamped at all: the mod then falls back to its environment rules, and the broker's own bind fails
 * with the same named reason.
 */
export function claudeModStampedSocketPath(stateHome: string): string {
  const path = join(resolve(stateHome), MOD_SOCKET_FILENAME);
  return modSocketPathDialable(path) ? path : '';
}

/**
 * The `claude` this host's mod work must use, named the way the AGENT READ names it.
 *
 * The version floor is checked against the binary the Claude agent read resolves, which honours
 * `COSYNCING_CLAUDE_BIN`. Setup and uninstall used to exec a bare `claude` instead, so a host with
 * that override -- an env var cosyncing itself writes into its service unit -- could pass the floor
 * on one binary and run `plugin install` on another, recording a version in Claude that the mod was
 * never gated against. One rule, read from the same env, on both sides.
 */
export function claudeModCommandBinary(
  env: Readonly<Record<string, string | undefined>>,
  resolveExecutable: (command: string) => string | undefined,
): string {
  const named = env.COSYNCING_CLAUDE_BIN?.trim() || 'claude';
  return resolveExecutable(named) ?? named;
}

/**
 * True when `CLAUDE_CONFIG_DIR` is set to something that is not an absolute path.
 *
 * Claude honours such a value relative to each process's own working directory, so the settings file
 * it names moves with wherever a session was started. cosyncing reads one file and installs into one
 * configuration; with a relative override there is no single answer to either, so the mod is skipped
 * with `config-dir-relative` instead of being installed into, or read back from, the wrong place.
 */
export function claudeConfigDirIsRelative(env: Readonly<Record<string, string | undefined>>): boolean {
  const override = env.CLAUDE_CONFIG_DIR?.trim();
  return !!override && !isAbsolute(override);
}

/** Claude's configuration directory, honouring an absolute `CLAUDE_CONFIG_DIR` as the CLI does. */
export function claudeConfigDir(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim();
  // A relative override is refused by every caller that acts on it (see `claudeConfigDirIsRelative`);
  // resolving it here against the process cwd would make the answer depend on where cosyncing started.
  return override && isAbsolute(override) ? resolve(override) : join(homeDir, '.claude');
}

/** Claude's user settings file, honouring the config-dir override the CLI itself honours. */
export function claudeUserSettingsPath(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return join(claudeConfigDir(homeDir, env), 'settings.json');
}

/**
 * Read a settings file, or say nothing.
 *
 * Shared because three separate places ask the same question — managed policy, the user's own two keys —
 * and each must treat "absent" and "will not open" the same way, or doctor reports a missing plugin for
 * a file it merely could not read.
 */
export function readSettingsFileOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------
// Org policy
// ---------------------------------------------------------------------------------------------------

/**
 * Where an administrator's managed settings live for this platform, as the 2.1.291 binary spells it.
 *
 * The build reads `managed-settings.json` in this directory and then every drop-in under
 * `managed-settings.d/` beside it, merged in name order. There is deliberately no environment override:
 * an override any inherited environment could set would let a process pick the file that decides whether
 * an install is allowed at all. A test hands its own roots to {@link readClaudeManagedPolicy} instead.
 */
export function claudeManagedPolicyRoot(platform: string): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode';
  return '/etc/claude-code';
}

/**
 * The Windows policy directory as a WSL host sees it through DrvFs.
 *
 * Measured in the 2.1.291 binary's own setting description: when `wslInheritsWindowsSettings` is true in
 * an administrator Windows source, a WSL Claude reads the Windows policy chain in addition to
 * `/etc/claude-code`, Windows first. cosyncing can read the file half of that chain from here. The
 * registry half (HKLM and HKCU `SOFTWARE\Policies\ClaudeCode`) is not readable from a Linux process
 * without a Windows helper and is a recorded gap; the install-time refusal is the backstop for it.
 */
export const CLAUDE_WSL_WINDOWS_POLICY_ROOT = '/mnt/c/Program Files/ClaudeCode';

/**
 * The managed keys that keep this mod from working, and only those.
 *
 * Every name here was read out of the 2.1.291 binary's own refusal text, not out of documentation:
 *  - `strictKnownMarketplaces`: an allowlist of marketplace sources. ANY value is a restriction, the empty
 *    list included -- the build's own message for an invalid value is "enforcing an empty allowlist (no
 *    marketplaces admitted)", so an empty list admits nothing, and cosyncing's directory is on no list.
 *  - `allowManagedModsOnly`: "mods are limited to your organization's by policy".
 *  - `allowManagedHooksOnly`: only managed plugins' hooks run, so ours would load and do nothing.
 *  - `disableAllHooks`: hooks modules are switched off on this machine; the mod would be inert.
 *  - `disableSideloadFlags`: confines plugins to sources the administrator approved.
 * For the four switches, `false` and `null` are the rule switched off; anything else is read as on,
 * because an unrecognised value in a file cosyncing does not control is not evidence that it may proceed.
 *
 * `blockedMarketplaces` and `disableCommandPluginSources` are deliberately not pre-checked: the first
 * names marketplaces this one may not be among, the second concerns command-sourced plugins and this is
 * a directory source. Claude's own install refuses either if it applies, and setup turns that refusal into
 * a stated skip.
 */
export const CLAUDE_MOD_POLICY_KEYS = Object.freeze([
  'strictKnownMarketplaces',
  'allowManagedModsOnly',
  'allowManagedHooksOnly',
  'disableAllHooks',
  'disableSideloadFlags',
] as const);

/** Whether one managed key's value restricts this mod. See {@link CLAUDE_MOD_POLICY_KEYS}. */
export function claudePolicyKeyRestricts(key: string, value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (key === 'strictKnownMarketplaces') return true;
  if ((CLAUDE_MOD_POLICY_KEYS as readonly string[]).includes(key)) return value !== false;
  return false;
}

/** Kept by name for the callers that ask about this one key. */
export function allowManagedModsOnlyIsRestriction(value: unknown): boolean {
  return claudePolicyKeyRestricts('allowManagedModsOnly', value);
}

export type ClaudePolicyFileRead =
  | { status: 'absent' }
  | { status: 'ok'; text: string }
  | { status: 'unreadable' };

export type ClaudePolicyDirectoryList =
  | { status: 'absent' }
  | { status: 'ok'; names: string[] }
  | { status: 'unreadable' };

function defaultPolicyRead(path: string): ClaudePolicyFileRead {
  try {
    return { status: 'ok', text: readFileSync(path, 'utf8') };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { status: 'absent' } : { status: 'unreadable' };
  }
}

function defaultPolicyList(path: string): ClaudePolicyDirectoryList {
  try {
    return { status: 'ok', names: readdirSync(path) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { status: 'absent' } : { status: 'unreadable' };
  }
}

export interface ClaudePolicyReading {
  /** Restricting keys found, each named once. */
  keys: string[];
  /** Policy files that exist and could not be read, or would not parse as a JSON object. */
  unreadable: string[];
  /** Every file that was read, in the order read. */
  sources: string[];
}

/**
 * Read every managed policy source this host can see, and say which keys restrict the mod.
 *
 * Channels, each traced to the 2.1.291 binary:
 *  1. `<root>/managed-settings.json` and every `*.json` drop-in under `<root>/managed-settings.d/`.
 *  2. On WSL, the Windows policy directory through DrvFs, but only when that file itself opts WSL in
 *     with `wslInheritsWindowsSettings: true` (the registry half of that opt-in is a recorded gap).
 *  3. `<claude config dir>/remote-settings.json`: the server-delivered managed settings, which the build
 *     caches as a JSON object in the user's config directory. Read on the assumption the cache is a flat
 *     settings object, which is all that was measured (an empty `{}` on an account with none).
 * A file that exists and will not read or parse is reported, never treated as permission: an unreadable
 * policy is not evidence that there is no policy.
 */
export function readClaudeManagedPolicy(options: {
  platform: string;
  /** Claude's config directory, for the server-delivered cache. Absent skips that channel. */
  configDir?: string;
  /** Injected roots for a test. Production passes nothing and gets the platform root. */
  roots?: readonly string[];
  /** True on a WSL host, where the Windows file chain may apply. Ignored when `roots` is given. */
  wsl?: boolean;
  read?: (path: string) => ClaudePolicyFileRead;
  list?: (path: string) => ClaudePolicyDirectoryList;
}): ClaudePolicyReading {
  const read = options.read ?? defaultPolicyRead;
  const list = options.list ?? defaultPolicyList;
  const keys = new Set<string>();
  const unreadable: string[] = [];
  const sources: string[] = [];
  const parseObject = (path: string): Record<string, unknown> | undefined => {
    const file = read(path);
    if (file.status === 'absent') return undefined;
    sources.push(path);
    if (file.status === 'unreadable') {
      unreadable.push(path);
      return undefined;
    }
    try {
      const parsed = JSON.parse(file.text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Falls through to the unreadable report below.
    }
    unreadable.push(path);
    return undefined;
  };
  const weigh = (settings: Record<string, unknown> | undefined): void => {
    if (!settings) return;
    for (const key of CLAUDE_MOD_POLICY_KEYS) {
      if (claudePolicyKeyRestricts(key, settings[key])) keys.add(key);
    }
  };
  const readRoot = (root: string): Record<string, unknown> | undefined => {
    const base = parseObject(join(root, 'managed-settings.json'));
    weigh(base);
    const dropIns = join(root, 'managed-settings.d');
    const listing = list(dropIns);
    if (listing.status === 'unreadable') {
      sources.push(dropIns);
      unreadable.push(dropIns);
    } else if (listing.status === 'ok') {
      for (const name of [...listing.names].sort()) {
        if (name.startsWith('.') || !name.endsWith('.json')) continue;
        weigh(parseObject(join(dropIns, name)));
      }
    }
    return base;
  };
  const roots = options.roots ?? [claudeManagedPolicyRoot(options.platform)];
  for (const root of roots) readRoot(root);
  if (!options.roots && options.wsl === true && options.platform === 'linux') {
    // Read first only to learn whether it opts WSL in; its keys count only when it does.
    const probe = read(join(CLAUDE_WSL_WINDOWS_POLICY_ROOT, 'managed-settings.json'));
    if (probe.status === 'ok') {
      let optedIn = false;
      try {
        optedIn = (JSON.parse(probe.text) as Record<string, unknown>)?.wslInheritsWindowsSettings === true;
      } catch {
        optedIn = false;
      }
      if (optedIn) readRoot(CLAUDE_WSL_WINDOWS_POLICY_ROOT);
    }
  }
  if (options.configDir) weigh(parseObject(join(options.configDir, 'remote-settings.json')));
  return { keys: [...keys], unreadable, sources };
}

/** Decide whether this host can be offered the mod at all, before any consent question is asked. */
export function inspectClaudeModSupport(options: {
  /** A diagnosis context's platform, which is a string because a fixture may describe another host. */
  platform: string;
  detectedVersion?: string | undefined;
  policy?: ClaudePolicyReading | undefined;
  configDirRelative?: boolean;
}): ClaudeModSupport {
  const base = {
    minimumVersion: CLAUDE_MOD_MIN_VERSION,
    ...(options.detectedVersion ? { detectedVersion: options.detectedVersion } : {}),
  };
  // Native Windows keeps Take over. WSL is a Linux host and is supported, so this keys off
  // the platform the broker is actually running on rather than any env hint.
  if (options.platform === 'win32') return { ...base, supported: false, skipReason: 'native-windows' };
  if (!options.detectedVersion) return { ...base, supported: false, skipReason: 'missing-cli' };
  // The same floor the socket refuses below at register time: a setup that offered the mod to a
  // Claude the socket would then refuse would show a plan row that could never work.
  if (!claudeVersionAtLeast(options.detectedVersion, CLAUDE_MOD_MIN_VERSION)) {
    return { ...base, supported: false, skipReason: 'below-minimum-version' };
  }
  if (options.configDirRelative === true) return { ...base, supported: false, skipReason: 'config-dir-relative' };
  const policyKeys = (options.policy?.keys ?? [])
    .filter((key) => (CLAUDE_MOD_POLICY_KEYS as readonly string[]).includes(key));
  if (policyKeys.length > 0) return { ...base, supported: false, skipReason: 'org-policy', policyKeys };
  if ((options.policy?.unreadable.length ?? 0) > 0) {
    return {
      ...base,
      supported: false,
      skipReason: 'managed-settings-unreadable',
      policyUnreadable: [...(options.policy?.unreadable ?? [])],
    };
  }
  return { ...base, supported: true };
}

/**
 * The host-support verdict from the facts every caller has: platform, environment, and the Claude
 * version the agent preflight resolved. Setup, doctor and the refresh all ask through here, so the three
 * cannot disagree about whether a host may have the mod.
 */
export function claudeModSupportForHost(options: {
  platform: string;
  env: Readonly<Record<string, string | undefined>>;
  homeDir: string;
  detectedVersion?: string | undefined;
  /** Injected policy roots for a test; production reads the platform's own. */
  policyRoots?: readonly string[];
}): ClaudeModSupport {
  return inspectClaudeModSupport({
    platform: options.platform,
    ...(options.detectedVersion ? { detectedVersion: options.detectedVersion } : {}),
    configDirRelative: claudeConfigDirIsRelative(options.env),
    policy: readClaudeManagedPolicy({
      platform: options.platform,
      configDir: claudeConfigDir(options.homeDir, options.env),
      ...(options.policyRoots ? { roots: options.policyRoots } : {}),
      wsl: !!(options.env.WSL_DISTRO_NAME || options.env.WSL_INTEROP),
    }),
  });
}

// ---------------------------------------------------------------------------------------------------
// Claude's settings and the copy on disk
// ---------------------------------------------------------------------------------------------------

/** What the two settings keys currently say about the mod. */
export interface ClaudeModSettingsState {
  settingsPath: string;
  /** 'absent': neither key. 'marketplace': added but not enabled. 'enabled': installed and on.
   *  'disabled': installed and switched off by the user. 'foreign': our marketplace name points
   *  somewhere that is not cosyncing's directory. 'unreadable': the file could not be read. */
  status: 'absent' | 'marketplace' | 'enabled' | 'disabled' | 'foreign' | 'unreadable';
  /** The directory `extraKnownMarketplaces.cosyncing` points at, when it is a directory source. */
  marketplacePath?: string;
}

interface ClaudeSettingsShape {
  extraKnownMarketplaces?: Record<string, { source?: { source?: string; path?: string } }>;
  enabledPlugins?: Record<string, boolean>;
}

export function inspectClaudeModSettings(
  settingsPath: string,
  expectedMarketplaceDir: string,
  read: (path: string) => string | undefined = readSettingsFileOrUndefined,
): ClaudeModSettingsState {
  const raw = read(settingsPath);
  if (raw === undefined) {
    // A missing file is an ordinary state on a host where Claude has never written settings; a
    // file that exists and will not open is not, and the two must not read the same.
    let exists = false;
    try {
      exists = !!lstatSync(settingsPath);
    } catch {
      exists = false;
    }
    return { settingsPath, status: exists ? 'unreadable' : 'absent' };
  }
  let settings: ClaudeSettingsShape;
  try {
    settings = JSON.parse(raw) as ClaudeSettingsShape;
  } catch {
    return { settingsPath, status: 'unreadable' };
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return { settingsPath, status: 'unreadable' };
  }
  const entry = settings.extraKnownMarketplaces?.[CLAUDE_MOD_MARKETPLACE_NAME];
  const source = entry?.source;
  if (entry && source?.path) {
    if (resolve(source.path) !== resolve(expectedMarketplaceDir)) {
      return { settingsPath, status: 'foreign', marketplacePath: source.path };
    }
  } else if (entry) {
    // Our name, someone else's source (a URL, a GitHub repo, a hand-edit). Not ours to reuse.
    return { settingsPath, status: 'foreign' };
  }
  const enabled = settings.enabledPlugins?.[CLAUDE_MOD_PLUGIN_ID];
  if (enabled === true) return { settingsPath, status: 'enabled', ...(source?.path ? { marketplacePath: source.path } : {}) };
  if (enabled === false) return { settingsPath, status: 'disabled', ...(source?.path ? { marketplacePath: source.path } : {}) };
  return {
    settingsPath,
    status: entry ? 'marketplace' : 'absent',
    ...(source?.path ? { marketplacePath: source.path } : {}),
  };
}

/**
 * The marketplace copy on disk, compared against this build's stamped files.
 *
 * `owned` means byte-identical to what this build would write now; `drifted` means anything else that
 * could be read. Whether a drifted copy is cosyncing's to replace is the RECEIPT's question, never this
 * one's: {@link decideClaudeModOwnership} answers it from the hash the receipt recorded.
 */
export type ClaudeModCopyStatus = 'missing' | 'owned' | 'drifted' | 'unsafe' | 'unreadable';

export interface ClaudeModCopyInspection {
  dir: string;
  status: ClaudeModCopyStatus;
  /** Hash over this build's stamped file set. */
  expectedSha256: string;
  /** Hash over `files` as read from disk, present only when every one of them could be read. */
  actualSha256?: string;
  /** The relative paths `actualSha256` covers: the receipt's own list when it has one, else this build's. */
  files: string[];
  version?: string;
}

/**
 * True when a string is a version the marketplace can be stamped with.
 *
 * Owned by the stamper's own rule, so the two cannot drift: anywhere this says no,
 * `stampClaudeModMarketplace` would throw, and callers that only want to COMPARE a copy need to be
 * able to ask without trying.
 */
export function isModVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+[-\w.]*$/.test(version);
}

/** Hash of a stamped marketplace file set, order-normalised so two builds agree. */
export function claudeModMarketplaceSha256(files: readonly { path: string; content: string }[]): string {
  const ordered = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return createHash('sha256')
    .update(ordered.map((file) => `${file.path}\n${file.content.length}\n${file.content}`).join('\n\0\n'))
    .digest('hex');
}

/** The relative file list this build writes. */
export function claudeModBuildFiles(): string[] {
  return CLAUDE_MOD_MARKETPLACE_FILES.map((file) => file.path);
}

/**
 * A receipt's own file list, validated, or `undefined` when it carries none and `null` when it carries one
 * that is not a list of plain relative paths.
 *
 * The list is what makes a release that adds or drops a file provable: ownership is the hash over the
 * files the receipt says were written, not over whatever THIS build happens to write. A list that names
 * an absolute path, a `..` segment or a duplicate is a corrupt receipt, never something to read files by.
 */
export function claudeModReceiptFiles(receipt: InstalledResourceRecord | undefined): string[] | undefined | null {
  const files = receipt?.ownership?.files;
  if (files === undefined) return undefined;
  if (!Array.isArray(files) || files.length === 0 || files.length > 64) return null;
  const seen = new Set<string>();
  for (const entry of files) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 256 || /[\0\\]/.test(entry)) return null;
    if (posix.isAbsolute(entry) || posix.normalize(entry) !== entry || entry.split('/').includes('..')) return null;
    if (seen.has(entry)) return null;
    seen.add(entry);
  }
  return [...seen];
}

function readCopyFile(dir: string, path: string): string | undefined | 'unsafe' {
  const target = join(dir, path);
  try {
    assertNoSymlinkComponents(target, true);
  } catch {
    return existsSync(target) ? 'unsafe' : undefined;
  }
  try {
    const stat = lstatSync(target);
    if (!stat.isFile()) return 'unsafe';
    return readFileSync(target, 'utf8');
  } catch {
    return undefined;
  }
}

export function inspectClaudeModMarketplace(
  dir: string,
  version: string,
  options: {
    /** The socket path this installation stamps; part of the expected bytes. */
    socketPath?: string;
    /** The receipt's own file list; ownership is proved over it. Absent uses this build's list. */
    receiptFiles?: readonly string[];
  } = {},
): ClaudeModCopyInspection {
  // A contributor build carries a version that is not a version, and the stamper refuses it. That is
  // the stamper being right, but this function is called by doctor and uninstall as well as setup,
  // and none of them may fall over because the build they are running was built from a branch.
  const buildFiles = isModVersion(version)
    ? stampClaudeModMarketplace(version, CLAUDE_MOD_MARKETPLACE_FILES, options.socketPath ?? '')
    : undefined;
  const expectedSha256 = buildFiles ? claudeModMarketplaceSha256(buildFiles) : '';
  const files = [...(options.receiptFiles ?? claudeModBuildFiles())];
  const directory = inspectOwnerOnlyDirectory(dir);
  if (directory.status === 'unsafe') return { dir, status: 'unsafe', expectedSha256, files };
  if (directory.status === 'unreadable') return { dir, status: 'unreadable', expectedSha256, files };
  if (directory.status === 'missing') return { dir, status: 'missing', expectedSha256, files };
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { dir, status: 'unreadable', expectedSha256, files };
  }
  // An empty directory holds nothing anyone could lose, so it is as good as no directory.
  if (entries.length === 0) return { dir, status: 'missing', expectedSha256, files };
  if (!buildFiles) return { dir, status: 'unreadable', expectedSha256, files };

  const read = new Map<string, string | undefined>();
  for (const path of new Set([...files, ...buildFiles.map((file) => file.path)])) {
    const content = readCopyFile(dir, path);
    if (content === 'unsafe') return { dir, status: 'unsafe', expectedSha256, files };
    read.set(path, content);
  }
  let versionSeen: string | undefined;
  const manifest = read.get('cosyncing-claude/.claude-plugin/plugin.json');
  if (manifest !== undefined) {
    try {
      const parsed = JSON.parse(manifest) as { version?: unknown };
      // Read back only when it is a version: a hand-edited or corrupt manifest is simply a version we
      // cannot name, and the hash comparison below says the copy is drifted.
      if (typeof parsed.version === 'string' && isModVersion(parsed.version)) versionSeen = parsed.version;
    } catch {
      // Unparseable: drifted, which the comparison says next.
    }
  }
  const listed = files.map((path) => ({ path, content: read.get(path) }));
  const actualSha256 = listed.every((file) => file.content !== undefined)
    ? claudeModMarketplaceSha256(listed as { path: string; content: string }[])
    : undefined;
  // Current means exactly this build's bytes AND nothing left from a file set this build dropped: an old
  // `hooks/extra.js` beside a new `register.js` is the mixture a refresh exists to remove.
  const buildPaths = new Set(buildFiles.map((file) => file.path));
  const current = buildFiles.every((file) => read.get(file.path) === file.content)
    && files.every((path) => buildPaths.has(path) || read.get(path) === undefined);
  return {
    dir,
    status: current ? 'owned' : 'drifted',
    expectedSha256,
    ...(actualSha256 ? { actualSha256 } : {}),
    files,
    ...(versionSeen ? { version: versionSeen } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------
// The one decision
// ---------------------------------------------------------------------------------------------------

export type ClaudeModOwnershipStatus =
  | 'absent'
  | 'owned-current'
  | 'owned-stale'
  | 'declined'
  | 'disabled'
  /** Our copy and our receipt, with Claude's two entries gone: the user removed the mod inside
   *  Claude. Sticky, like a decline, and never a reinstall. */
  | 'removed-in-claude'
  | 'foreign-marketplace'
  | 'unowned'
  | 'receipt-invalid'
  | 'unsafe'
  | 'unreadable'
  | 'skipped';

export interface ClaudeModOwnershipDecision {
  status: ClaudeModOwnershipStatus;
  support: ClaudeModSupport;
  copy: ClaudeModCopyInspection;
  settings: ClaudeModSettingsState;
  marketplaceDir: string;
  /** The socket path this installation stamps into the copy it writes. */
  socketPath: string;
  receipt?: InstalledResourceRecord;
}

function claudeModReceipt(install: InstallStateInspection): InstalledResourceRecord | undefined {
  if (!install.committed) return undefined;
  const matches = install.state.resources.filter((resource) => resource.id === CLAUDE_MOD_RESOURCE_ID);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * True when a receipt's own hash proves bytes on disk are the ones cosyncing wrote there.
 *
 * Over the receipt's own file list, which is what `actualSha256` was measured over when the copy was
 * inspected with that list, so a release that adds or drops a file can still prove an older copy.
 */
export function claudeModReceiptProves(
  receipt: InstalledResourceRecord | undefined,
  marketplaceDir: string,
  actualSha256: string | undefined,
): boolean {
  return !!receipt
    && receipt.kind === 'agent-integration'
    && receipt.ownership?.proof === 'package-hash'
    && typeof receipt.ownership.installedSha256 === 'string'
    && actualSha256 !== undefined
    && receipt.ownership.installedSha256 === actualSha256
    && claudeModReceiptFiles(receipt) !== null
    && resolve(receipt.target ?? marketplaceDir) === resolve(marketplaceDir);
}

/**
 * True when the install ledger's own hash proves the bytes on disk are the ones cosyncing wrote.
 *
 * The removal question and the install question are different, and only this answers the first. "Is the mod
 * on?" is decided by Claude's two settings keys, and a user who uninstalled inside Claude leaves them
 * emptied. cosyncing deletes files it can prove it wrote, whatever Claude currently thinks about them.
 */
export function claudeModReceiptProvesDisk(decision: ClaudeModOwnershipDecision): boolean {
  return claudeModReceiptProves(decision.receipt, decision.marketplaceDir, decision.copy.actualSha256);
}

/**
 * One verdict that setup, doctor, the refresh, and uninstall all read.
 *
 * The order is the policy: host first (a host that cannot run the mod has no opinion to consult), then
 * the user's standing decline, then what is on disk, then -- once the receipt proves the bytes are ours --
 * what Claude's own settings say, and only after that whether the bytes are this build's.
 *
 * That last ordering is the one a reinstall turns on. A copy cosyncing wrote at an older version, sitting
 * under a Claude whose two entries are gone, is a person who took the mod out of Claude. Comparing the
 * version first called it `owned-stale`, and every `cosy update` then refreshed it straight back in.
 */
export function decideClaudeModOwnership(input: {
  install: InstallStateInspection;
  support: ClaudeModSupport;
  stateHome: string;
  version: string;
  settingsPath: string;
  /** Setup-state's `claudeModRequested`. Absent means never asked, which is not a decline. */
  requested?: boolean | undefined;
  /**
   * The answer given THIS run, from the wizard or an explicit flag. Absent means nobody answered
   * this run, which leaves the stored answer in charge.
   *
   * Without this the stored decline outranks the answer the operator is giving right now, so "yes"
   * after a "no" takes two runs. It also has to be a separate input rather than a rewriting of
   * `requested`, because a plain `--yes` re-derives the choice from that stored answer, and a
   * stored decline has to survive a plain `--yes`.
   */
  explicit?: boolean | undefined;
  settingsRead?: (path: string) => string | undefined;
}): ClaudeModOwnershipDecision {
  const marketplaceDir = claudeModMarketplaceDir(input.stateHome);
  const socketPath = claudeModStampedSocketPath(input.stateHome);
  const receipt = claudeModReceipt(input.install);
  const receiptFiles = claudeModReceiptFiles(receipt);
  const copy = inspectClaudeModMarketplace(marketplaceDir, input.version, {
    socketPath,
    ...(receiptFiles ? { receiptFiles } : {}),
  });
  const settings = inspectClaudeModSettings(input.settingsPath, marketplaceDir, input.settingsRead);
  const base = {
    support: input.support,
    copy,
    settings,
    marketplaceDir,
    socketPath,
    ...(receipt ? { receipt } : {}),
  };
  if (!input.support.supported) return { ...base, status: 'skipped' };
  if (input.explicit === false) return { ...base, status: 'declined' };
  if (input.requested === false && input.explicit !== true) return { ...base, status: 'declined' };
  if (settings.status === 'unreadable') {
    // Claude's file, Claude's to fix. Report it as a stated skip on a host that cannot be offered
    // the mod right now rather than as a broken install of ours, which is what turned a syntax
    // error in someone's editor config into a setup that would not run at all.
    return {
      ...base,
      support: { ...base.support, supported: false, skipReason: 'settings-invalid' },
      status: 'skipped',
    };
  }
  if (copy.status === 'unsafe') return { ...base, status: 'unsafe' };
  if (settings.status === 'foreign') return { ...base, status: 'foreign-marketplace' };
  if (copy.status === 'unreadable') return { ...base, status: 'unreadable' };
  if (receipt && receiptFiles === null) return { ...base, status: 'receipt-invalid' };

  if (copy.status === 'missing') {
    // Switched off inside Claude is the person's word whether or not a receipt survived, and an
    // install over it would switch it back on.
    if (!receipt) return { ...base, status: settings.status === 'disabled' ? 'disabled' : 'absent' };
    // Our receipt names a copy that is gone. If Claude still lists the mod, the directory it loads from
    // has to come back, which is a refresh. If Claude does not, nothing is installed anywhere and the
    // person's last word on it was taking it out: that is a removal, and it stays one.
    if (settings.status === 'enabled') return { ...base, status: 'owned-stale' };
    if (settings.status === 'disabled') return { ...base, status: 'disabled' };
    return { ...base, status: 'removed-in-claude' };
  }
  // Bytes with no receipt are not ours to overwrite, whatever they look like.
  if (!receipt) return { ...base, status: 'unowned' };
  if (!claudeModReceiptProves(receipt, marketplaceDir, copy.actualSha256)) return { ...base, status: 'receipt-invalid' };
  // Proven ours. Claude's settings decide BEFORE the version does.
  if (settings.status === 'disabled') return { ...base, status: 'disabled' };
  // Measured on 2.1.289: `claude plugin uninstall` empties `enabledPlugins` and LEAVES
  // `extraKnownMarketplaces.cosyncing` pointing at our directory, so a mod the person removed inside
  // Claude arrives here as `marketplace`, and one whose entries were both cleared as `absent`.
  if (settings.status === 'absent' || settings.status === 'marketplace') {
    return { ...base, status: 'removed-in-claude' };
  }
  return { ...base, status: copy.status === 'owned' ? 'owned-current' : 'owned-stale' };
}

/**
 * Stable, non-secret identity of the state setup planned against.
 *
 * Carried from the plan into the transaction and re-derived at apply time, so a marketplace that
 * changed between the operator reading the plan and the plan being executed is caught rather than
 * written over. Only the disk copy and the two settings keys are named: the receipt is compared
 * separately, because the ledger is committed at the end of the same transaction that wrote it.
 */
export function claudeModPlanPrecondition(
  copy: ClaudeModCopyInspection,
  settings: ClaudeModSettingsState,
): string {
  return JSON.stringify({
    copy: copy.status,
    expectedSha256: copy.expectedSha256,
    actualSha256: copy.actualSha256 ?? null,
    version: copy.version ?? null,
    settings: settings.status,
    settingsPath: resolve(settings.settingsPath),
    marketplaceDir: resolve(copy.dir),
  });
}

/**
 * True when cosyncing's side of the mod may be taken back: the directory and the receipt.
 *
 * Only a receipt can say so. Either it proves the bytes on disk, or the bytes are already gone and the
 * receipt is all that is left of the install. Claude's settings do not enter into it: a switched-off or
 * removed-inside-Claude mod is still cosyncing's directory, and the reversal commands treat "nothing to
 * remove" as done.
 */
export function claudeModRemovable(decision: ClaudeModOwnershipDecision): boolean {
  if (!decision.receipt || claudeModReceiptFiles(decision.receipt) === null) return false;
  if (decision.copy.status === 'missing') return true;
  return claudeModReceiptProvesDisk(decision);
}

/** The receipt a completed install records: `package-hash` over the stamped files it lists. */
export function claudeModReceiptFor(dir: string, sha256: string, files: readonly string[]): InstalledResourceRecord {
  return {
    id: CLAUDE_MOD_RESOURCE_ID,
    kind: 'agent-integration',
    target: resolve(dir),
    ownership: { proof: 'package-hash', installedSha256: sha256, files: [...files].sort() },
  };
}

/**
 * Write the marketplace directory from the embedded asset, stamped with this build's version and socket.
 *
 * Refuses a symlink anywhere on the path, then writes owner-only. The rewrite is whole-directory: a
 * marketplace that half-updated would offer Claude a plugin manifest and a register.js from two
 * different versions, which a session only reports as a hook that fails to load. The caller snapshots
 * the previous directory first (the setup action does), because this replaces it.
 */
export function writeClaudeModMarketplace(
  dir: string,
  version: string,
  socketPath = '',
): { sha256: string; files: string[] } {
  assertNoSymlinkComponents(dirname(dir), true);
  const files = stampClaudeModMarketplace(version, CLAUDE_MOD_MARKETPLACE_FILES, socketPath);
  // Staged in a sibling directory and moved in, rather than written in place. Claude reads this
  // directory IN PLACE while a session is running, and a file-by-file rewrite is a window in which
  // the plugin manifest is from one build and `register.js` is from the next. The rename is atomic
  // within one filesystem, so the directory is either the old mod or the new one, never a mixture.
  const staging = `${dir}.staging-${process.pid}-${Date.now()}`;
  try {
    assertNoSymlinkComponents(staging, true);
    for (const file of files) {
      const target = join(staging, file.path);
      assertNoSymlinkComponents(dirname(target), true);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, file.content, { mode: 0o600 });
    }
    // Files a newer build dropped go with the directory they came in. Left behind, an orphaned file
    // from an earlier build stays readable to Claude beside the new manifest.
    if (existsSync(dir)) {
      const retired = `${dir}.retired-${process.pid}-${Date.now()}`;
      renameSync(dir, retired);
      renameSync(staging, dir);
      rmSync(retired, { recursive: true, force: true });
    } else {
      mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
      renameSync(staging, dir);
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { sha256: claudeModMarketplaceSha256(files), files: files.map((file) => file.path).sort() };
}

/** Remove the directory cosyncing wrote. The caller proves ownership from its receipt first. */
export function removeClaudeModMarketplace(dir: string): void {
  assertNoSymlinkComponents(dir, true);
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Copy the marketplace directory, as it is now, into a private backup.
 *
 * This is the previous copy a refresh restores when Claude refuses the new one, and the copy an
 * interrupted refresh is recovered from: the backup lives in the transaction directory, which the
 * journal names, so a run that died between the swap and the commit still has it. Regular files and
 * directories only; anything else in the tree is refused rather than copied as something it is not.
 */
export function snapshotClaudeModMarketplace(dir: string, backupDir: string): { existed: boolean } {
  assertNoSymlinkComponents(dir, true);
  if (!existsSync(dir)) return { existed: false };
  const copyTree = (from: string, to: string): void => {
    const stat = lstatSync(from);
    if (stat.isDirectory()) {
      mkdirSync(to, { recursive: true, mode: 0o700 });
      for (const name of readdirSync(from)) copyTree(join(from, name), join(to, name));
      return;
    }
    if (!stat.isFile()) throw new Error(`claude-mod-snapshot-unsafe-entry:${from}`);
    writeFileSync(to, readFileSync(from), { mode: stat.mode & 0o700 });
  };
  rmSync(backupDir, { recursive: true, force: true });
  ensureOwnerOnlyDirectory(dirname(backupDir));
  copyTree(dir, backupDir);
  return { existed: true };
}

/**
 * Put the marketplace directory back the way {@link snapshotClaudeModMarketplace} found it.
 *
 * Staged and swapped like the forward write, so a session reading the directory sees the old mod or
 * the new one and never a half-restored tree. A directory that did not exist before is removed.
 */
export function restoreClaudeModMarketplace(dir: string, backupDir: string, existed: boolean): void {
  assertNoSymlinkComponents(dirname(dir), true);
  if (!existed) {
    if (existsSync(dir)) removeClaudeModMarketplace(dir);
    return;
  }
  if (!existsSync(backupDir)) throw new Error('claude-mod-backup-missing');
  const staging = `${dir}.restore-${process.pid}-${Date.now()}`;
  rmSync(staging, { recursive: true, force: true });
  snapshotClaudeModMarketplace(backupDir, staging);
  if (existsSync(dir)) {
    const retired = `${dir}.retired-${process.pid}-${Date.now()}`;
    renameSync(dir, retired);
    renameSync(staging, dir);
    rmSync(retired, { recursive: true, force: true });
  } else {
    mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
    renameSync(staging, dir);
  }
}

/** The marketplace file paths this build writes, so a caller can name exactly those. */
export function claudeModMarketplacePaths(dir: string): string[] {
  return claudeModBuildFiles().map((path) => join(dir, path));
}

// ---------------------------------------------------------------------------------------------------
// Claude's CLI
// ---------------------------------------------------------------------------------------------------

/**
 * The vendor commands, one argv each, in the order setup runs them. Measured on Claude Code 2.1.289 on
 * Linux (2026-10-05), including the idempotent repeat of this exact sequence.
 *
 * `--json` everywhere: the human line is prose that changes, and the machine line carries an `outcome` and
 * a `failureCode` that setup can branch on. Every step is idempotent — a second `add` reports ok with
 * "already on disk", a second `install` reports ok with "already installed" — which is what lets ONE
 * sequence serve a first install, a repair, and a `cosy update` refresh.
 *
 * The fourth command is the one that is easy to miss and was found by measurement rather than reading.
 * After a broker upgrade the marketplace directory holds the new bytes and Claude loads the plugin IN
 * PLACE from it, so the running code is already new — but `install` answers "already installed" and leaves
 * the RECORDED version at the old number. `plugin update` is what re-records it (`updated`, or
 * `up_to_date`), and without it `claude plugin list` shows a version that no longer exists on disk.
 */
export function claudeModInstallCommands(marketplaceDir: string): readonly string[][] {
  return [
    ['plugin', 'marketplace', 'add', marketplaceDir, '--json'],
    // `marketplace update` re-reads a directory source, which is how `cosy update` picks up the
    // rewritten files without the operator removing and re-adding the marketplace.
    ['plugin', 'marketplace', 'update', CLAUDE_MOD_MARKETPLACE_NAME, '--json'],
    ['plugin', 'install', CLAUDE_MOD_PLUGIN_ID, '--json'],
    ['plugin', 'update', CLAUDE_MOD_PLUGIN_ID, '--json'],
  ] as const satisfies readonly string[][];
}

/**
 * Reversal commands. Uninstall first, then the marketplace, in the order that keeps both idempotent.
 *
 * Measured reversal leaves both settings keys BEHIND as empty objects rather than deleting them, which is
 * why the post-removal check asks whether the cosyncing entries are gone rather than whether the keys are.
 */
export function claudeModRemoveCommands(): readonly string[][] {
  return [
    // The qualified id, not the bare name. Measured on 2.1.289 both are accepted and both answer the
    // same `pluginId`; the qualified form is the one that cannot come back `not_installed` because a
    // different marketplace happens to carry a plugin under the same short name.
    ['plugin', 'uninstall', CLAUDE_MOD_PLUGIN_ID, '--json'],
    ['plugin', 'marketplace', 'remove', CLAUDE_MOD_MARKETPLACE_NAME, '--json'],
  ] as const satisfies readonly string[][];
}

/**
 * The reversal as an operator types it, for a report that says what is left to do by hand.
 *
 * A `CLAUDE_CONFIG_DIR` the run was using is carried onto the line, because the same command without it
 * acts on `~/.claude` and would report success over a configuration it never touched.
 */
export function claudeModManualRemoveCommands(env: Readonly<Record<string, string | undefined>> = {}): string[] {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  const prefix = configDir && isAbsolute(configDir) ? `CLAUDE_CONFIG_DIR=${JSON.stringify(configDir)} ` : '';
  return [
    `${prefix}claude plugin uninstall ${CLAUDE_MOD_PLUGIN_ID}`,
    `${prefix}claude plugin marketplace remove ${CLAUDE_MOD_MARKETPLACE_NAME}`,
  ];
}

/** How one `claude` run ended when it did not end with a parseable answer. */
export type ClaudeModRunFailure = 'not-found' | 'spawn-failed' | 'timeout';

/**
 * Parse one `--json` result line from a `claude plugin` run.
 *
 * The CLI prints the machine line LAST on stdout and, on failure, repeats the human line on stderr
 * with a non-zero-ish marker, so the parse takes the last JSON-looking line rather than assuming
 * stdout is pure. Three outcomes are this function's own rather than Claude's, and they are kept
 * apart because their consequences differ:
 *  - `unavailable`: no `claude` could be run at all. Nothing in Claude changed.
 *  - `timeout`: a `claude` ran and was stopped before it answered. Its effect is unknown.
 *  - `unparseable`: a `claude` ran and printed no machine line. Its effect is unknown.
 * Reading the last two as "no CLI" let uninstall delete cosyncing's directory while Claude kept two
 * entries pointing at it.
 */
export function parseClaudePluginResult(stdout: string, stderr: string, failure?: ClaudeModRunFailure): {
  outcome: string;
  failureCode?: string;
  message?: string;
  raw?: string;
} {
  if (failure === 'not-found' || failure === 'spawn-failed') {
    return { outcome: 'unavailable', failureCode: failure, raw: [stdout, stderr].join('\n').slice(0, 500) };
  }
  const lines = [...stdout.split('\n'), ...stderr.split('\n')]
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') && line.endsWith('}'));
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index] ?? '') as Record<string, unknown>;
      if (typeof parsed.outcome === 'string') {
        return {
          outcome: parsed.outcome,
          ...(typeof parsed.failureCode === 'string' ? { failureCode: parsed.failureCode } : {}),
          ...(typeof parsed.message === 'string' ? { message: parsed.message } : {}),
        };
      }
    } catch {
      // Not JSON; the next line up may be.
    }
  }
  return {
    outcome: failure === 'timeout' ? 'timeout' : 'unparseable',
    raw: [stdout, stderr].join('\n').slice(0, 500),
  };
}

/**
 * True when a failed result means "already in that state".
 *
 * `reversal` is the whole question: on the install half the two codes are real failures (an install
 * whose `plugin update` answers `not_installed` is a mod Claude refused), and on the reversal half they
 * are honest no-ops, which is what makes a retried uninstall idempotent.
 */
export function claudePluginFailureIsNoOp(
  result: { outcome: string; failureCode?: string },
  reversal: boolean,
): boolean {
  if (!reversal) return false;
  return result.failureCode === 'not_installed' || result.failureCode === 'not_configured';
}

export const CLAUDE_MOD_COMMAND_TIMEOUT_MS = 30_000;
/** Cap on how much of a CLI's output setup keeps, for the failure line it prints. */
export const CLAUDE_MOD_OUTPUT_TAIL_CHARS = 8_192;

/**
 * How this module runs Claude's CLI, and how a test replaces it.
 *
 * The default runner spawns the resolved `claude` binary with no shell. A test injects a runner that
 * emulates the measured `--json` shapes. `failure` says why a run produced no answer, when it did not.
 */
export type ClaudeModCommandRunner = (
  argv: readonly string[],
) => Promise<{ ok: boolean; stdout: string; stderr: string; failure?: ClaudeModRunFailure }>;

export interface ClaudeModCommandOutcome {
  ok: boolean;
  argv: readonly string[];
  outcome: string;
  failureCode?: string;
  message?: string;
  raw?: string;
}

/**
 * One command sequence run in order, stopping at the first step that is not a success.
 *
 * `reversal` says which half of the lifecycle this is, because the two read a failed step
 * differently. Pass true for `claudeModRemoveCommands()`, where "nothing to remove" is the goal.
 */
export async function runClaudeModCommands(
  run: ClaudeModCommandRunner,
  commands: readonly string[][],
  options: { reversal?: boolean } = {},
): Promise<{ ok: boolean; steps: ClaudeModCommandOutcome[]; failed?: ClaudeModCommandOutcome }> {
  const reversal = options.reversal === true;
  const steps: ClaudeModCommandOutcome[] = [];
  for (const argv of commands) {
    let result: Awaited<ReturnType<ClaudeModCommandRunner>>;
    try {
      result = await run(argv);
    } catch {
      result = { ok: false, stdout: '', stderr: '', failure: 'spawn-failed' };
    }
    const parsed = parseClaudePluginResult(result.stdout, result.stderr, result.failure);
    const noOp = claudePluginFailureIsNoOp(parsed, reversal);
    // A zero exit is not an answer. A build that printed prose instead of its machine line said nothing
    // setup can act on, and counting it as success receipted installs Claude never confirmed.
    const answered = parsed.outcome !== 'unparseable' && parsed.outcome !== 'failed';
    const step: ClaudeModCommandOutcome = {
      ok: (result.ok && !result.failure && answered) || noOp,
      argv,
      outcome: parsed.outcome,
      ...(parsed.failureCode ? { failureCode: parsed.failureCode } : {}),
      ...(parsed.message ? { message: parsed.message } : {}),
      ...(parsed.raw ? { raw: parsed.raw } : {}),
    };
    steps.push(step);
    if (!step.ok) return { ok: false, steps, failed: step };
  }
  return { ok: true, steps };
}

/**
 * The production runner: spawn Claude's CLI with no shell, a bounded tail, and a short ceiling.
 *
 * `env` is the environment the CLI runs in, which is the diagnosis context's -- not this process's by
 * default -- so the `CLAUDE_CONFIG_DIR` setup read is the one the CLI writes. A wedged command must not
 * hang setup or uninstall, so the timeout escalates the way the other CLI runners in this repository do:
 * TERM, then KILL, then give up and report what came back.
 */
export function defaultClaudeModCommandRunner(
  binary: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  timeoutMs = CLAUDE_MOD_COMMAND_TIMEOUT_MS,
): ClaudeModCommandRunner {
  return async (argv) => {
    const invocation = resolveInvocation(binary, { env, platform: process.platform });
    if (!invocation) {
      return { ok: false, stdout: '', stderr: `claude executable not found: ${binary}`, failure: 'not-found' };
    }
    let child: ReturnType<typeof spawnResolvedInvocation>;
    try {
      child = spawnResolvedInvocation(invocation, [...argv], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...env } as NodeJS.ProcessEnv,
      });
    } catch {
      return { ok: false, stdout: '', stderr: '', failure: 'spawn-failed' };
    }
    let stdout = '';
    let stderr = '';
    return await new Promise((resolveResult) => {
      let settled = false;
      let timedOut = false;
      const timers: ReturnType<typeof setTimeout>[] = [];
      const after = (ms: number, action: () => void): void => {
        timers.push(setTimeout(action, ms));
      };
      const finish = (ok: boolean, failure?: ClaudeModRunFailure): void => {
        if (settled) return;
        settled = true;
        for (const timer of timers) clearTimeout(timer);
        resolveResult({ ok, stdout, stderr, ...(failure ? { failure } : {}) });
      };
      after(timeoutMs, () => {
        timedOut = true;
        child.kill('SIGTERM');
        after(2_000, () => {
          child.kill('SIGKILL');
          after(1_000, () => finish(false, 'timeout'));
        });
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = (stdout + chunk.toString('utf8')).slice(-CLAUDE_MOD_OUTPUT_TAIL_CHARS);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-CLAUDE_MOD_OUTPUT_TAIL_CHARS);
      });
      child.on('error', (error: NodeJS.ErrnoException) => finish(false, error.code === 'ENOENT' ? 'not-found' : 'spawn-failed'));
      child.on('close', (code: number | null) => finish(code === 0 && !timedOut, timedOut ? 'timeout' : undefined));
    });
  };
}

// ---------------------------------------------------------------------------------------------------
// The refresh child's environment
// ---------------------------------------------------------------------------------------------------

/**
 * What the `claude-mod refresh` child may inherit, and nothing else.
 *
 * The child runs the Claude adapter's own diagnosis, reads Claude's settings and policy, resolves its
 * state home, and runs `claude plugin`. Each name here is something one of those reads: Claude's config
 * directory and binary override, cosyncing's state and cache homes, the WSL markers the policy reader
 * keys on, and the ordinary process identity, locale and temp directory a CLI needs to run at all.
 * Defined once, so the upgrade that spawns the child and the test that proves it agree on the list.
 */
export const CLAUDE_MOD_REFRESH_ENV_ALLOWLIST = Object.freeze([
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'CLAUDE_CONFIG_DIR',
  'COSYNCING_HOME',
  'COSYNCING_CACHE_DIR',
  'COSYNCING_CLAUDE_BIN',
  'WSL_DISTRO_NAME',
  'WSL_INTEROP',
] as const);

export function claudeModRefreshEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of CLAUDE_MOD_REFRESH_ENV_ALLOWLIST) {
    const value = env[name];
    if (typeof value === 'string') out[name] = value;
  }
  out.HOME ??= '';
  out.PATH ??= '/usr/bin:/bin';
  return out;
}

// ---------------------------------------------------------------------------------------------------
// The last outcome, kept where doctor and the next run can read it
// ---------------------------------------------------------------------------------------------------

/**
 * A mod step that did not finish, recorded beside the marketplace directory.
 *
 * Setup and the upgrade never fail because of the mod: a Claude that refuses, times out or prints
 * nothing usable is a reported outcome instead. This is where that outcome survives the run, so doctor
 * can repeat it and name the commands that finish the job by hand. Cleared by the next clean run.
 */
export interface ClaudeModOutcomeRecord {
  schemaVersion: 1;
  at: string;
  operation: 'install' | 'refresh' | 'remove' | 'rollback' | 'uninstall';
  status: 'failed' | 'leftovers';
  /** Stable code, `claude-mod-<operation>-<why>`. */
  detailCode: string;
  /** The Claude step that answered, and how, when one did. */
  failureCode?: string;
  /** What finishes the job by hand. Literal commands; nothing secret. */
  commands: string[];
}

export function claudeModOutcomePath(stateHome: string): string {
  return join(stateHome, 'claude-mod', 'last-outcome.json');
}

export function readClaudeModOutcome(stateHome: string): ClaudeModOutcomeRecord | undefined {
  const raw = readSettingsFileOrUndefined(claudeModOutcomePath(stateHome));
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<ClaudeModOutcomeRecord>;
    if (parsed.schemaVersion !== 1 || typeof parsed.detailCode !== 'string' || !Array.isArray(parsed.commands)) {
      return undefined;
    }
    return parsed as ClaudeModOutcomeRecord;
  } catch {
    return undefined;
  }
}

/** Write the record, or remove it when `record` is undefined. Never throws: it is a report, not a step. */
export function writeClaudeModOutcome(stateHome: string, record: ClaudeModOutcomeRecord | undefined): void {
  const path = claudeModOutcomePath(stateHome);
  try {
    if (record === undefined) {
      if (existsSync(path)) unlinkSync(path);
      return;
    }
    ensureOwnerOnlyDirectory(dirname(path));
    atomicWriteJsonOwnerOnly(path, record);
  } catch {
    // A report that could not be written must not turn a finished step into a failed one.
  }
}

/** Why a command sequence stopped, in the four words the outcome codes use. */
export type ClaudeModFailureWhy = 'refused' | 'timeout' | 'unavailable' | 'unparseable';

export function claudeModFailureWhy(step: Pick<ClaudeModCommandOutcome, 'outcome'> | undefined): ClaudeModFailureWhy {
  if (step?.outcome === 'unavailable') return 'unavailable';
  if (step?.outcome === 'timeout') return 'timeout';
  if (step?.outcome === 'unparseable') return 'unparseable';
  return 'refused';
}

/**
 * The record a mod step leaves when Claude's side did not finish, with the commands that finish it.
 *
 * An install or refresh that Claude refused has already been put back the way it was, so what is left
 * is to run setup again once Claude accepts it. A removal or a rollback that could not reach Claude
 * leaves Claude's two entries behind, and the commands are Claude's own reversal, carrying the
 * configuration directory the run was using.
 */
export function claudeModFailureRecord(options: {
  operation: ClaudeModOutcomeRecord['operation'];
  failed: Pick<ClaudeModCommandOutcome, 'outcome' | 'failureCode'> | undefined;
  env: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
}): ClaudeModOutcomeRecord {
  const why = claudeModFailureWhy(options.failed);
  const leftovers = options.operation === 'remove' || options.operation === 'rollback' || options.operation === 'uninstall';
  const commands = options.operation === 'install' || options.operation === 'refresh'
    ? ['cosyncing setup --install-claude-mod']
    : [
        ...claudeModManualRemoveCommands(options.env),
        ...(options.operation === 'remove' ? ['cosyncing setup --no-install-claude-mod'] : []),
      ];
  return {
    schemaVersion: 1,
    at: (options.now?.() ?? new Date()).toISOString(),
    operation: options.operation,
    status: leftovers ? 'leftovers' : 'failed',
    detailCode: `claude-mod-${options.operation}-${why}`,
    ...(options.failed?.failureCode ? { failureCode: options.failed.failureCode } : {}),
    commands,
  };
}
