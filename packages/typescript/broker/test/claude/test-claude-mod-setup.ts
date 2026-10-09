/**
 * The Claude mod as an installed thing: ownership, the setup plan row, the transaction, and uninstall.
 *
 * Why this suite exists separately from `test-transactional-setup.ts`: the mod is the one integration
 * setup performs by asking ANOTHER program to install something. Every other receipt-owned target is a
 * file cosyncing writes and can therefore prove and reverse alone. Here the reversible half is Claude's
 * and the proof is two keys in Claude's settings, so the ownership rules, the command sequence, and the
 * refusal paths all need their own coverage.
 *
 * Two kinds of check, deliberately separated:
 *  - Pure logic against real temp directories and real settings files. No CLI, no network, no clock.
 *  - End-to-end `runCli`/`runSetup`/`runUninstall`/`refreshClaudeMod` against a FAKE `claude` executable on
 *    PATH (`../helpers/fake-claude-cli.ts`) that answers with the shapes Claude Code 2.1.289 printed on
 *    Linux (2026-10-05) and logs its own argv and environment. The spawn, the
 *    parsing, the ordering, the lock and the rollback are all real; only the vendor is played back.
 *
 * What is NOT tested here, because it cannot be honestly tested hermetically: that a real Claude loads the
 * mod it was handed. That is the physical-pass checklist and the tier-2 smoke, not this file.
 *
 *   bun run packages/typescript/broker/test/claude/test-claude-mod-setup.ts   (exit 0 = all pass)
 */
export {};
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BUILD_INFO } from '../../src/runtime/build-info.ts';
import { createSetupDiagnosisContext } from '../../src/installation/diagnosis-context.ts';
import type { SetupDiagnosisContext } from '../../../adapter-api/src/index.ts';
import {
  committedInstallState,
  inspectInstallState,
  installStatePath,
  writeInstallState,
  type InstalledResourceRecord,
} from '../../src/installation/install-state.ts';
import { readSetupState, writeSetupState } from '../../src/installation/setup-state.ts';
import { createSetupActionCatalog } from '../../src/installation/setup-actions.ts';
import { readSetupTransactionJournal, type SetupTransactionAction } from '../../src/installation/setup-transaction.ts';
import {
  acquireInstallationLock,
  installationLockPath,
  INSTALLATION_MUTATIONS,
} from '../../src/installation/installation-lock.ts';
import { refreshClaudeMod } from '../../src/installation/broker-lifecycle.ts';
import {
  inspectSetupEnvironment,
  runSetup,
  type SetupBlockingIssue,
  type SetupCommandResult,
  type SetupPlan,
  type SetupPresenter,
  type SetupInspection,
  type SetupServiceChoice,
} from '../../src/installation/setup.ts';
import type { SetupLanguage } from '../../src/installation/setup-i18n.ts';
import { setupMessages } from '../../src/installation/setup-i18n.ts';
import {
  agentPreflightLines,
  createClackSetupPresenter,
  createNonInteractiveSetupPresenter,
} from '../../src/installation/setup-presenter.ts';
import {
  inspectUninstall,
  runUninstall,
  type CodexDaemonStatus,
} from '../../src/installation/broker-lifecycle.ts';
import { claudeModChecks } from '../../src/installation/doctor.ts';
import { runCli } from '../../src/cli/cli.ts';
import { renderUninstallResult, translateDoctorTextToChinese } from '../../src/cli/cli-i18n.ts';
import {
  CLAUDE_MOD_MARKETPLACE_FILES,
  CLAUDE_MOD_MARKETPLACE_BUNDLE_SOURCE,
  CLAUDE_MOD_PLUGIN_NAME,
  CLAUDE_MOD_MARKETPLACE_NAME,
  CLAUDE_MOD_SOCKET_STAMP_LINE,
  stampClaudeModMarketplace,
} from '../../src/runtime/runtime-assets.ts';
import {
  claudeConfigDirIsRelative,
  claudeModInstallCommands,
  claudeModMarketplaceDir,
  claudeModMarketplacePaths,
  claudeModMarketplaceSha256,
  claudeModOutcomePath,
  claudeModReceiptFor,
  claudeModRefreshEnvironment,
  claudeModRemoveCommands,
  claudeModStampedSocketPath,
  claudeModSupportForHost,
  claudeUserSettingsPath,
  decideClaudeModOwnership,
  defaultClaudeModCommandRunner,
  inspectClaudeModMarketplace,
  inspectClaudeModSettings,
  inspectClaudeModSupport,
  parseClaudePluginResult,
  allowManagedModsOnlyIsRestriction,
  claudeModCommandBinary,
  claudeModReceiptProvesDisk,
  claudeModRemovable,
  claudePluginFailureIsNoOp,
  readClaudeManagedPolicy,
  readClaudeModOutcome,
  runClaudeModCommands,
  writeClaudeModMarketplace,
  CLAUDE_MOD_POLICY_KEYS,
  CLAUDE_MOD_REFRESH_ENV_ALLOWLIST,
  CLAUDE_MOD_RESOURCE_ID,
  type ClaudeModSupport,
} from '../../src/installation/claude-mod-ownership.ts';
import { CLAUDE_MOD_MIN_VERSION } from '@cosyncing/adapter-claude';
import { fakeClaude as makeFakeClaude, type FakeClaude } from '../helpers/fake-claude-cli.ts';
import { ModSocketServer, modSocketPath } from '../../src/sessions/mod-socket-server.ts';
import { ModRegistry } from '../../src/sessions/mod-registry.ts';
import { ModHoldStore } from '../../src/sessions/mod-holds.ts';
import { ModAuditStore } from '../../src/sessions/mod-audit.ts';

/** The shipped mod, loaded as written. Its exported helpers are plain functions with no `$` behind them. */
// Bun 1.3.8 caches the broker's text-loader import of this same path. Give the executable import its
// own module identity so it loads the real exports rather than the embedded source string.
const { resolveSocketPath } = await import(`${join(import.meta.dir, '../../../../../mods/cosyncing-claude/hooks/register.js')}?claude-mod-setup`) as {
  resolveSocketPath(sources: { override?: string; stamped?: string; cosyncingHome?: string; home?: string }): string;
};

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// macOS reports os.tmpdir() behind the /var -> /private/var symlink, which the state-dir
  // guard refuses; canonicalize the root first, the way security/r2-export.ts does.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'cosyncing-claude-mod-setup-')));
const FIXED_DATE = new Date('2026-10-05T12:00:00.000Z');
const now = (): Date => new Date(FIXED_DATE);
const VERSION = '0.6.4';
const SUPPORTED: ClaudeModSupport = { supported: true, minimumVersion: CLAUDE_MOD_MIN_VERSION };
const BUILD_FILES = CLAUDE_MOD_MARKETPLACE_FILES.map((file) => file.path);
let caseCounter = 0;

/** A fresh state home + Claude config dir, both under this run's temp root. */
function sandbox(): { home: string; configDir: string; settingsPath: string } {
  const base = join(root, `case-${caseCounter++}`);
  const home = join(base, '.cosyncing');
  const configDir = join(base, 'claude-config');
  mkdirSync(home, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  return { home, configDir, settingsPath: join(configDir, 'settings.json') };
}

function writeSettings(configDir: string, settings: unknown): string {
  const path = join(configDir, 'settings.json');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2));
  return path;
}

// ---------------------------------------------------------------------------
// 1. The embedded marketplace bundle
// ---------------------------------------------------------------------------
{
  const paths = CLAUDE_MOD_MARKETPLACE_FILES.map((file) => file.path).sort();
  check('the embedded marketplace is the four runtime files, and the test file is not one of them',
    paths.join(',') === '.claude-plugin/marketplace.json,cosyncing-claude/.claude-plugin/plugin.json,'
      + 'cosyncing-claude/hooks/hooks.json,cosyncing-claude/hooks/register.js'
      && CLAUDE_MOD_MARKETPLACE_FILES.every((file) => file.content.length > 0),
    paths.join(','));

  const stamped = stampClaudeModMarketplace(VERSION);
  const pluginManifest = JSON.parse(stamped.find((f) => f.path.endsWith('plugin.json'))!.content) as { version?: string };
  const marketplaceManifest = JSON.parse(stamped.find((f) => f.path.endsWith('marketplace.json'))!.content) as {
    plugins?: { version?: string; name?: string }[];
  };
  check('stamping writes this build\'s version into BOTH manifests, so `claude plugin` sees one version',
    pluginManifest.version === VERSION
      && marketplaceManifest.plugins?.[0]?.version === VERSION
      && marketplaceManifest.plugins?.[0]?.name === CLAUDE_MOD_PLUGIN_NAME,
    `${pluginManifest.version} / ${marketplaceManifest.plugins?.[0]?.version}`);

  const register = stamped.find((f) => f.path.endsWith('register.js'))!;
  const source = CLAUDE_MOD_MARKETPLACE_FILES.find((f) => f.path.endsWith('register.js'))!;
  check('stamping with no socket path leaves the mod source byte-identical', register.content === source.content);

  // MB7. Setup stamps the socket path into the installed copy, on exactly the one line the mod reads it
  // from, and changes nothing else in the file.
  const socket = '/srv/cosyncing-state/claude-mod.sock';
  const socketStamped = stampClaudeModMarketplace(VERSION, CLAUDE_MOD_MARKETPLACE_FILES, socket)
    .find((f) => f.path.endsWith('register.js'))!;
  check('MB7 setup stamps the socket path into register.js on the one marked line, and nothing else changes',
    socketStamped.content.includes(`const STAMPED_SOCKET_PATH = ${JSON.stringify(socket)};`)
      && !socketStamped.content.includes(CLAUDE_MOD_SOCKET_STAMP_LINE)
      && socketStamped.content.replace(`const STAMPED_SOCKET_PATH = ${JSON.stringify(socket)};`, CLAUDE_MOD_SOCKET_STAMP_LINE)
        === source.content,
    socketStamped.content.split('\n').find((line) => line.includes('STAMPED_SOCKET_PATH =')) ?? 'no line');
  let undialable = '';
  try {
    stampClaudeModMarketplace(VERSION, CLAUDE_MOD_MARKETPLACE_FILES, `/${'x'.repeat(120)}/claude-mod.sock`);
  } catch (error) {
    undialable = error instanceof Error ? error.message : 'unknown';
  }
  check('MB7 a socket path the mod could not dial is refused rather than stamped',
    undialable.includes('could not dial'), undialable.slice(0, 80));
  check('MB7 the stamped path is the state home\'s own socket, resolved, and empty when it is too long to dial',
    claudeModStampedSocketPath('/srv/state') === '/srv/state/claude-mod.sock'
      && claudeModStampedSocketPath(`/${'y'.repeat(120)}`) === '',
    claudeModStampedSocketPath('/srv/state'));

  let refused = '';
  try {
    stampClaudeModMarketplace('main');
  } catch (error) {
    refused = error instanceof Error ? error.message : 'unknown';
  }
  check('a version that is not a version is refused rather than stamped into a manifest',
    refused.includes('not a version'), refused.slice(0, 60));

  const bundle = JSON.parse(CLAUDE_MOD_MARKETPLACE_BUNDLE_SOURCE) as {
    files: { path: string; sha256: string; content: string }[];
    plugin: string;
  };
  check('the bundle names the plugin Claude is asked to install and hashes its own contents',
    bundle.plugin === `${CLAUDE_MOD_PLUGIN_NAME}@${CLAUDE_MOD_MARKETPLACE_NAME}`
      && bundle.files.length === CLAUDE_MOD_MARKETPLACE_FILES.length
      && bundle.files.every((file) => file.sha256.length === 64 && file.content.length > 0),
    bundle.plugin);
}

// ---------------------------------------------------------------------------
// 2. The two settings keys, in the shape the vendor actually writes
// ---------------------------------------------------------------------------
{
  const { configDir } = sandbox();
  const dir = claudeModMarketplaceDir('/h/state');
  const read = (path: string): string | undefined => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  };

  const missingPath = join(configDir, 'nope.json');
  check('a settings file that does not exist reads absent, not unreadable',
    inspectClaudeModSettings(missingPath, dir).status === 'absent');

  writeSettings(configDir, {});
  check('empty settings read absent',
    inspectClaudeModSettings(join(configDir, 'settings.json'), dir).status === 'absent');

  const marketplaceOnly = writeSettings(configDir, {
    extraKnownMarketplaces: { cosyncing: { source: { source: 'directory', path: dir } } },
  });
  check('the marketplace key alone reads marketplace',
    inspectClaudeModSettings(marketplaceOnly, dir).status === 'marketplace');

  // The measured post-install file, verbatim in shape.
  const installed = writeSettings(configDir, {
    extraKnownMarketplaces: { cosyncing: { source: { source: 'directory', path: dir } } },
    enabledPlugins: { 'cosyncing-claude@cosyncing': true },
  });
  check('both keys present reads enabled',
    inspectClaudeModSettings(installed, dir).status === 'enabled');

  const switchedOff = writeSettings(configDir, {
    extraKnownMarketplaces: { cosyncing: { source: { source: 'directory', path: dir } } },
    enabledPlugins: { 'cosyncing-claude@cosyncing': false },
  });
  check('a user switch-off inside Claude reads disabled, not absent',
    inspectClaudeModSettings(switchedOff, dir).status === 'disabled');

  // Measured: the reversal empties both objects rather than deleting the keys.
  const reversed = writeSettings(configDir, { enabledPlugins: {}, extraKnownMarketplaces: {} });
  check('the measured post-reversal file (both keys emptied) reads absent',
    inspectClaudeModSettings(reversed, dir).status === 'absent');

  const elsewhere = writeSettings(configDir, {
    extraKnownMarketplaces: { cosyncing: { source: { source: 'directory', path: '/somewhere/else' } } },
    enabledPlugins: { 'cosyncing-claude@cosyncing': true },
  });
  const foreign = inspectClaudeModSettings(elsewhere, dir);
  check('our marketplace name pointing at another directory reads foreign, and says where',
    foreign.status === 'foreign' && foreign.marketplacePath === '/somewhere/else',
    `${foreign.status} ${foreign.marketplacePath ?? ''}`);

  const fromUrl = writeSettings(configDir, {
    extraKnownMarketplaces: { cosyncing: { source: { source: 'github', repo: 'someone/cosyncing' } } },
  });
  check('our marketplace name with a non-directory source reads foreign too',
    inspectClaudeModSettings(fromUrl, dir).status === 'foreign');

  const broken = join(configDir, 'broken.json');
  writeFileSync(broken, '{ this is not json');
  check('settings that will not parse read unreadable rather than absent',
    inspectClaudeModSettings(broken, dir).status === 'unreadable');

  check('CLAUDE_CONFIG_DIR is honoured, and a relative override is not resolved against the cwd',
    claudeUserSettingsPath('/srv/claude-user', { CLAUDE_CONFIG_DIR: '/tmp/cfg' }) === '/tmp/cfg/settings.json'
      && claudeUserSettingsPath('/srv/claude-user', { CLAUDE_CONFIG_DIR: 'relative' }) === '/srv/claude-user/.claude/settings.json'
      && claudeUserSettingsPath('/srv/claude-user', {}) === '/srv/claude-user/.claude/settings.json');
  check('SU12 a relative CLAUDE_CONFIG_DIR is recognised, so every caller can refuse it instead of guessing',
    claudeConfigDirIsRelative({ CLAUDE_CONFIG_DIR: 'relative/dir' })
      && !claudeConfigDirIsRelative({ CLAUDE_CONFIG_DIR: '/abs/dir' })
      && !claudeConfigDirIsRelative({}));
}

// ---------------------------------------------------------------------------
// 3. Host support: the four skip reasons, decided before anything is asked
// ---------------------------------------------------------------------------
{
  const support = inspectClaudeModSupport({ platform: 'win32', detectedVersion: '9.9.9' });
  check('native Windows is declined on platform alone, whatever the version',
    support.skipReason === 'native-windows' && support.supported === false);

  check('no claude on PATH reads missing-cli',
    inspectClaudeModSupport({ platform: 'linux' }).skipReason === 'missing-cli');

  check('2.1.90 is BELOW 2.1.288, so the floor is compared numerically and not as text',
    inspectClaudeModSupport({ platform: 'linux', detectedVersion: '2.1.90' }).skipReason
      === 'below-minimum-version');

  check('the floor itself is supported (a build bump must not need a code change at the boundary)',
    inspectClaudeModSupport({ platform: 'linux', detectedVersion: CLAUDE_MOD_MIN_VERSION })
      .supported === true);

  check('a newer build is supported',
    inspectClaudeModSupport({ platform: 'linux', detectedVersion: '2.2.0' }).supported === true);

  // SU11. Every managed channel the 2.1.291 binary reads, through injected roots: the platform file, its
  // drop-in directory, and the server-delivered cache in Claude's own config directory.
  const policyRoot = join(root, 'policy-root');
  const policyConfig = join(root, 'policy-config');
  mkdirSync(policyRoot, { recursive: true });
  mkdirSync(policyConfig, { recursive: true });
  const managed = join(policyRoot, 'managed-settings.json');
  const policyFor = (settings: unknown): string[] => {
    writeFileSync(managed, JSON.stringify(settings));
    return readClaudeManagedPolicy({ platform: 'linux', roots: [policyRoot], configDir: policyConfig }).keys;
  };
  const supportFor = (settings: unknown) => {
    writeFileSync(managed, JSON.stringify(settings));
    return inspectClaudeModSupport({
      platform: 'linux',
      detectedVersion: '2.1.289',
      policy: readClaudeManagedPolicy({ platform: 'linux', roots: [policyRoot], configDir: policyConfig }),
    });
  };
  const policy = supportFor({ strictKnownMarketplaces: [{ source: 'github', repo: 'org/allowed' }] });
  check('a managed policy key declines and names the key it found',
    policy.skipReason === 'org-policy' && policy.policyKeys?.[0] === 'strictKnownMarketplaces',
    JSON.stringify(policy.policyKeys));
  check('SU11 an EMPTY strictKnownMarketplaces admits nothing, so it restricts too',
    policyFor({ strictKnownMarketplaces: [] }).join(',') === 'strictKnownMarketplaces',
    policyFor({ strictKnownMarketplaces: [] }).join(','));
  check('managed policy is read from the file, and only the keys that matter are reported',
    policyFor({ allowManagedModsOnly: true, permissions: { allow: ['Bash'] } }).join(',') === 'allowManagedModsOnly'
      && CLAUDE_MOD_POLICY_KEYS.length === 5);
  check('SU11 allowManagedHooksOnly and disableAllHooks each restrict, because the mod would load and do nothing',
    policyFor({ allowManagedHooksOnly: true }).join(',') === 'allowManagedHooksOnly'
      && policyFor({ disableAllHooks: true }).join(',') === 'disableAllHooks');
  check('SU11 disableSideloadFlags:false is the rule switched off, not a restriction; true restricts',
    policyFor({ disableSideloadFlags: false }).length === 0
      && policyFor({ disableSideloadFlags: true }).join(',') === 'disableSideloadFlags');
  writeFileSync(managed, '{}');
  mkdirSync(join(policyRoot, 'managed-settings.d'), { recursive: true });
  writeFileSync(join(policyRoot, 'managed-settings.d', '10-org.json'), JSON.stringify({ disableAllHooks: true }));
  writeFileSync(join(policyRoot, 'managed-settings.d', '.hidden.json'), JSON.stringify({ allowManagedModsOnly: true }));
  check('SU11 a drop-in under managed-settings.d is read, and a hidden file there is not',
    readClaudeManagedPolicy({ platform: 'linux', roots: [policyRoot] }).keys.join(',') === 'disableAllHooks',
    readClaudeManagedPolicy({ platform: 'linux', roots: [policyRoot] }).keys.join(','));
  rmSync(join(policyRoot, 'managed-settings.d'), { recursive: true, force: true });
  writeFileSync(join(policyConfig, 'remote-settings.json'), JSON.stringify({ strictKnownMarketplaces: [] }));
  check('SU11 the server-delivered settings cached in Claude\'s config directory are read as policy',
    readClaudeManagedPolicy({ platform: 'linux', roots: [policyRoot], configDir: policyConfig }).keys.join(',')
      === 'strictKnownMarketplaces');
  rmSync(join(policyConfig, 'remote-settings.json'), { force: true });

  writeFileSync(managed, 'not json at all');
  const unreadablePolicy = inspectClaudeModSupport({
    platform: 'linux',
    detectedVersion: '2.1.289',
    policy: readClaudeManagedPolicy({ platform: 'linux', roots: [policyRoot] }),
  });
  check('SU11 an unparseable managed-settings file skips the mod as managed-settings-unreadable',
    unreadablePolicy.supported === false && unreadablePolicy.skipReason === 'managed-settings-unreadable'
      && unreadablePolicy.policyUnreadable?.[0] === managed,
    `${unreadablePolicy.skipReason} ${JSON.stringify(unreadablePolicy.policyUnreadable)}`);
  rmSync(managed, { force: true });
  check('no managed-settings file is no policy',
    readClaudeManagedPolicy({ platform: 'linux', roots: [policyRoot] }).keys.length === 0
      && readClaudeManagedPolicy({ platform: 'linux', roots: [policyRoot] }).unreadable.length === 0);
  // The old test-only redirect is gone. An environment variable that any inherited process environment
  // could set must not pick the file that decides whether an install is allowed at all.
  check('SU11 COSYNCING_CLAUDE_MANAGED_SETTINGS no longer redirects the policy read',
    claudeModSupportForHost({
      platform: 'linux',
      env: { COSYNCING_CLAUDE_MANAGED_SETTINGS: join(root, 'redirect.json') },
      homeDir: join(root, 'no-home'),
      detectedVersion: '2.1.289',
      policyRoots: [policyRoot],
    }).supported === true
      && !readFileSync(join(import.meta.dir, '../../src/installation/claude-mod-ownership.ts'), 'utf8')
        .includes('COSYNCING_CLAUDE_MANAGED_SETTINGS'));
  check('SU12 a relative CLAUDE_CONFIG_DIR is a stated skip, after the version floor',
    claudeModSupportForHost({
      platform: 'linux',
      env: { CLAUDE_CONFIG_DIR: 'cfg' },
      homeDir: join(root, 'no-home'),
      detectedVersion: '2.1.289',
      policyRoots: [policyRoot],
    }).skipReason === 'config-dir-relative');
}

// ---------------------------------------------------------------------------
// 4. The marketplace directory on disk
// ---------------------------------------------------------------------------
{
  const { home } = sandbox();
  const dir = claudeModMarketplaceDir(home);
  check('nothing on disk reads missing',
    inspectClaudeModMarketplace(dir, VERSION).status === 'missing');

  const written = writeClaudeModMarketplace(dir, VERSION);
  const copy = inspectClaudeModMarketplace(dir, VERSION);
  check('our own freshly written copy reads owned, and the write reports the hash it just proved',
    copy.status === 'owned' && copy.expectedSha256 === written.sha256 && copy.actualSha256 === written.sha256,
    `${copy.status} ${written.files.length} files`);
  const privateDir = join(home, 'private', 'marketplace');
  writeClaudeModMarketplace(privateDir, VERSION);
  const modes = claudeModMarketplacePaths(privateDir);
  check('the copy is written owner-only: directories 0700, files 0600, nothing readable by group or other',
    modes.every((path) => ((statSync(path).mode & 0o777) === (statSync(path).isDirectory() ? 0o700 : 0o600)))
      && (statSync(dirname(modes[0]!)).mode & 0o777) === 0o700,
    modes.map((p) => (statSync(p).mode & 0o777).toString(8)).join(' '));
  check('a symlinked marketplace path is refused rather than written through',
    (() => {
      const linkRoot = join(home, 'symlink');
      mkdirSync(linkRoot, { recursive: true });
      symlinkSync(join(home, 'elsewhere'), join(linkRoot, 'marketplace'));
      try {
        writeClaudeModMarketplace(join(linkRoot, 'marketplace'), VERSION);
        return false;
      } catch {
        return true;
      }
    })());

  writeClaudeModMarketplace(join(home, 'v1', 'marketplace'), '0.5.0');
  check('the same file set at an older version reads drifted: only a receipt can say it is ours to refresh',
    inspectClaudeModMarketplace(join(home, 'v1', 'marketplace'), VERSION).status === 'drifted');

  const driftDir = join(home, 'drift', 'marketplace');
  writeClaudeModMarketplace(driftDir, VERSION);
  writeFileSync(join(driftDir, 'cosyncing-claude/hooks/register.js'), '// edited by hand\n');
  check('an edited mod file reads drifted, so setup must not overwrite it without a receipt',
    inspectClaudeModMarketplace(driftDir, VERSION).status === 'drifted');

  const missingOne = join(home, 'partial', 'marketplace');
  writeClaudeModMarketplace(missingOne, VERSION);
  rmSync(join(missingOne, 'cosyncing-claude/hooks/hooks.json'));
  check('a copy missing one of its files reads drifted, not missing: the rest of it is still on disk',
    inspectClaudeModMarketplace(missingOne, VERSION).status === 'drifted'
      && inspectClaudeModMarketplace(missingOne, VERSION).actualSha256 === undefined);
  const emptyDir = join(home, 'empty', 'marketplace');
  mkdirSync(emptyDir, { recursive: true, mode: 0o700 });
  check('an empty marketplace directory reads missing, because there is nothing in it anyone could lose',
    inspectClaudeModMarketplace(emptyDir, VERSION).status === 'missing');

  check('the hash is order-normalised, so two builds of the same file set agree',
    claudeModMarketplaceSha256([
      { path: 'a', content: 'x' },
      { path: 'b', content: 'y' },
    ]) === claudeModMarketplaceSha256([
      { path: 'b', content: 'y' },
      { path: 'a', content: 'x' },
    ]));
}

// ---------------------------------------------------------------------------
// 5. The one decision every caller reads, and the order it is decided in
// ---------------------------------------------------------------------------
{
  const { home, configDir, settingsPath } = sandbox();
  const dir = claudeModMarketplaceDir(home);
  const uncommitted = inspectInstallState(home);
  const decide = (input: Partial<Parameters<typeof decideClaudeModOwnership>[0]>) => decideClaudeModOwnership({
    install: uncommitted,
    support: SUPPORTED,
    stateHome: home,
    version: VERSION,
    settingsPath,
    ...input,
  });

  check('nothing asked, nothing on disk is absent', decide({}).status === 'absent');

  const socket = claudeModStampedSocketPath(home);
  writeClaudeModMarketplace(dir, VERSION, socket);
  writeSettings(configDir, {
    extraKnownMarketplaces: { cosyncing: { source: { source: 'directory', path: dir } } },
    enabledPlugins: { 'cosyncing-claude@cosyncing': true },
  });
  check('our bytes with no receipt read unowned: cosyncing will not claim or overwrite them',
    decide({}).status === 'unowned');

  check('an explicit decline outranks an installed copy (that is what sticky has to mean)',
    decide({ requested: false }).status === 'declined');

  check('an unsupported host reads skipped even with a matching receipt, so repair cannot re-offer it',
    decide({ support: { supported: false, skipReason: 'native-windows', minimumVersion: '2.1.288' } }).status
      === 'skipped');

  const committedState = (resources: InstalledResourceRecord[]) => ({
    ...uncommitted,
    committed: true as const,
    state: { ...committedInstallState(FIXED_DATE.toISOString()), resources },
  });
  check('a receipt whose hash matches nothing on disk is receipt-invalid, not a reason to write',
    decideClaudeModOwnership({
      install: committedState([claudeModReceiptFor(dir, 'f'.repeat(64), BUILD_FILES)]),
      support: SUPPORTED,
      stateHome: home,
      version: VERSION,
      settingsPath,
    }).status === 'receipt-invalid');

  const goodReceipt = claudeModReceiptFor(
    dir,
    inspectClaudeModMarketplace(dir, VERSION, { socketPath: socket }).actualSha256!,
    BUILD_FILES,
  );
  const good = committedState([goodReceipt]);
  check('a receipt proving the exact on-disk copy at this version is owned-current',
    decideClaudeModOwnership({
      install: good, support: SUPPORTED, stateHome: home, version: VERSION, settingsPath,
    }).status === 'owned-current');
  check('the same receipt proving an older on-disk copy is owned-stale, which setup may refresh',
    decideClaudeModOwnership({
      install: good, support: SUPPORTED, stateHome: home, version: '9.9.9', settingsPath,
    }).status === 'owned-stale');

  const otherTarget = committedState([
    claudeModReceiptFor('/elsewhere/marketplace', goodReceipt.ownership.installedSha256!, BUILD_FILES),
  ]);
  check('a receipt whose TARGET moved is receipt-invalid: the directory is not ours to delete',
    decideClaudeModOwnership({
      install: otherTarget, support: SUPPORTED, stateHome: home, version: VERSION, settingsPath,
    }).status === 'receipt-invalid');

  // SU6. Claude's settings decide BEFORE the version does. A receipt-proven copy from an older build,
  // under a Claude whose entries are gone, is a person who removed the mod inside Claude; reading the
  // version first called it owned-stale and every upgrade refreshed it straight back in.
  const older = join(home, 'older-build');
  mkdirSync(older, { recursive: true });
  const olderDir = claudeModMarketplaceDir(older);
  const olderWritten = writeClaudeModMarketplace(olderDir, '0.6.0', claudeModStampedSocketPath(older));
  const olderInstall = committedState([claudeModReceiptFor(olderDir, olderWritten.sha256, olderWritten.files)]);
  const decideOlder = (settings: unknown) => {
    writeSettings(configDir, settings);
    return decideClaudeModOwnership({
      install: olderInstall, support: SUPPORTED, stateHome: older, version: VERSION, settingsPath, requested: true,
    }).status;
  };
  const olderSource = { cosyncing: { source: { source: 'directory', path: olderDir } } };
  check('SU6 an older receipt-proven copy whose Claude plugin entry is gone reads removed-in-claude, not owned-stale',
    decideOlder({ extraKnownMarketplaces: olderSource, enabledPlugins: {} }) === 'removed-in-claude'
      && decideOlder({ extraKnownMarketplaces: {}, enabledPlugins: {} }) === 'removed-in-claude',
    decideOlder({ extraKnownMarketplaces: olderSource, enabledPlugins: {} }));
  check('SU6 an older receipt-proven copy switched off inside Claude reads disabled, not owned-stale',
    decideOlder({ extraKnownMarketplaces: olderSource, enabledPlugins: { 'cosyncing-claude@cosyncing': false } })
      === 'disabled');
  check('SU6 the same copy still enabled in Claude is owned-stale, which is the one state a refresh writes',
    decideOlder({ extraKnownMarketplaces: olderSource, enabledPlugins: { 'cosyncing-claude@cosyncing': true } })
      === 'owned-stale');

  // SU8. The receipt carries its own file list, and ownership is proved over THAT list. An older build
  // that shipped a file this one dropped, or lacked one this one added, is still provably ours.
  const fileSets = join(home, 'file-sets');
  mkdirSync(fileSets, { recursive: true });
  const fileSetDir = claudeModMarketplaceDir(fileSets);
  writeSettings(configDir, {
    extraKnownMarketplaces: { cosyncing: { source: { source: 'directory', path: fileSetDir } } },
    enabledPlugins: { 'cosyncing-claude@cosyncing': true },
  });
  const added = writeClaudeModMarketplace(fileSetDir, '0.6.0', claudeModStampedSocketPath(fileSets));
  const extraPath = 'cosyncing-claude/hooks/retired-helper.js';
  writeFileSync(join(fileSetDir, extraPath), '// a file an older build shipped and this one dropped\n', { mode: 0o600 });
  const withExtra = [...added.files, extraPath];
  const extraSha = inspectClaudeModMarketplace(fileSetDir, VERSION, { receiptFiles: withExtra }).actualSha256!;
  const extraDecision = decideClaudeModOwnership({
    install: committedState([claudeModReceiptFor(fileSetDir, extraSha, withExtra)]),
    support: SUPPORTED, stateHome: fileSets, version: VERSION, settingsPath, requested: true,
  });
  check('SU8 a receipt listing a file this build dropped still proves the copy, which reads owned-stale',
    extraDecision.status === 'owned-stale' && claudeModReceiptProvesDisk(extraDecision),
    `${extraDecision.status} copy=${extraDecision.copy.status}`);
  rmSync(join(fileSetDir, extraPath));
  rmSync(join(fileSetDir, 'cosyncing-claude/hooks/hooks.json'));
  const withoutOne = added.files.filter((path) => path !== 'cosyncing-claude/hooks/hooks.json');
  const fewerSha = inspectClaudeModMarketplace(fileSetDir, VERSION, { receiptFiles: withoutOne }).actualSha256!;
  const fewerDecision = decideClaudeModOwnership({
    install: committedState([claudeModReceiptFor(fileSetDir, fewerSha, withoutOne)]),
    support: SUPPORTED, stateHome: fileSets, version: VERSION, settingsPath, requested: true,
  });
  check('SU8 a receipt from a build that lacked a file this one adds still proves the copy, which reads owned-stale',
    fewerDecision.status === 'owned-stale' && claudeModReceiptProvesDisk(fewerDecision),
    `${fewerDecision.status} copy=${fewerDecision.copy.status}`);
  check('SU8 a receipt whose file list names a path outside the directory is receipt-invalid, never read',
    decideClaudeModOwnership({
      install: committedState([claudeModReceiptFor(fileSetDir, fewerSha, ['../outside.js'])]),
      support: SUPPORTED, stateHome: fileSets, version: VERSION, settingsPath, requested: true,
    }).status === 'receipt-invalid');
}

// ---------------------------------------------------------------------------
// 6. Setup end to end, against a Claude that is played back rather than run
// ---------------------------------------------------------------------------

/**
 * The vendor CLI, played back by `../helpers/fake-claude-cli.ts`.
 *
 * Its settings file is `$CLAUDE_CONFIG_DIR/settings.json` read from the environment it was GIVEN, so every
 * case here also proves the command runner hands Claude the diagnosis context's environment rather than
 * this test process's: a runner that leaked the process environment would leave the variable unset and the
 * fake would refuse, never writing anywhere near a real Claude configuration.
 */
function fakeClaude(label: string, version: string): FakeClaude {
  return makeFakeClaude(root, label, version);
}

/** The wizard answers setup needs, pinned to the safe service choice: a fixture never touches a service. */
class ModPresenter implements SetupPresenter {
  readonly calls: string[] = [];
  plan?: SetupPlan;
  blockers: readonly SetupBlockingIssue[] = [];

  /**
   * `claudeMod` is the wizard's answer; `claudeModFlag` is an operator's `--install-claude-mod` or
   * `--no-install-claude-mod`, which is the difference between "answered this run" and "--yes carried
   * the stored answer forward". The two are separate because the product treats them differently.
   */
  constructor(private readonly answers: { claudeMod?: boolean; claudeModFlag?: boolean; apply?: boolean } = {}) {}

  async chooseLanguage(): Promise<SetupLanguage> { this.calls.push('language'); return 'en'; }
  intro(): void { this.calls.push('intro'); }
  showBlockers(issues: readonly SetupBlockingIssue[]): void { this.calls.push('blockers'); this.blockers = issues; }
  async confirmManagedRuntime(): Promise<boolean> { this.calls.push('ack'); return true; }
  async confirmLegacyPiBridge(): Promise<boolean> { return false; }
  async confirmAgentSkill(): Promise<boolean> { this.calls.push('skill'); return true; }
  async confirmLegacyAgentSkill(): Promise<boolean> { return false; }
  async confirmOpencodeShim(): Promise<boolean> { this.calls.push('opencode-shim'); return false; }
  /**
   * The wizard's answer. With no answer supplied for this fixture it starts from the stored choice,
   * because that is what the real prompt does: `initialValue` is the previous yes or no, so an
   * operator who walks through and taps Enter twice gets their old answer back rather than a default.
   * A fixture that answered a flat `true` here could not tell "asked again" apart from "asked again
   * and agreed", which is the distinction the sticky-decline tests are about.
   */
  async confirmClaudeMod(inspection: Readonly<SetupInspection>): Promise<boolean> {
    this.calls.push('claude-mod');
    return this.answers.claudeMod ?? inspection.setupState.claudeModRequested !== false;
  }
  async chooseService(): Promise<SetupServiceChoice> { this.calls.push('service'); return 'foreground'; }
  async confirmQuotaWarnings(): Promise<boolean> { return false; }
  showPlan(plan: Readonly<SetupPlan>): void { this.calls.push('plan'); this.plan = plan as SetupPlan; }
  async confirmApply(): Promise<boolean> { this.calls.push('confirm'); return this.answers.apply ?? true; }
  /**
   * The flag seam, spelled the way the non-interactive presenter spells it.
   *
   * A committed setup short-circuits to `already-configured` from the STORED choices unless the presenter
   * can report a flag-driven intent, so this is what `--no-install-claude-mod` actually is. Without it a
   * decline after an install could never be seen, which is exactly the bug this fixture would otherwise hide.
   */
  intendedChoices(): {
    installAgentSkill: boolean;
    installOpencodeShim: boolean;
    installClaudeMod: boolean;
    claudeModAnsweredThisRun: boolean;
  } {
    return {
      installAgentSkill: true,
      installOpencodeShim: false,
      claudeModAnsweredThisRun: this.answers.claudeModFlag !== undefined,
      installClaudeMod: this.answers.claudeMod ?? true,
    };
  }
  /** As the real presenters report it: here only a flag, given or patched in, answers the mod question. */
  claudeModAnsweredThisRun(): boolean {
    return this.answers.claudeModFlag !== undefined || (this as SetupPresenter).claudeModFlag?.() !== undefined;
  }
  recoveredInterruptedTransaction(): void { this.calls.push('recovered'); }
  complete(result: Readonly<SetupCommandResult>): void { this.calls.push('complete'); this.result = { ...result }; }
  cancelled(stage: string): void { this.calls.push(`cancelled:${stage}`); }
  failed(result: Readonly<SetupCommandResult>): void { this.calls.push('failed'); this.result = { ...result }; }
  result?: SetupCommandResult;
}

/**
 * A host whose only executable is the fake Claude, run against the real `runSetup`.
 *
 * The network probes are pinned closed the way every other setup fixture pins them: a developer's live
 * broker on the default port must not decide what an isolated installation plans.
 */
function modFixture(label: string, claudeVersion = '2.1.289', stateDirName = '.cosyncing') {
  const fake = fakeClaude(label, claudeVersion);
  const base = join(root, `case-${label}`);
  const userHome = join(base, 'user-home');
  const home = join(userHome, stateDirName);
  mkdirSync(userHome, { recursive: true });
  const context: SetupDiagnosisContext = {
    ...createSetupDiagnosisContext({
      homeDir: userHome,
      platform: 'linux',
      arch: 'x64',
      env: {
        HOME: userHome,
        PATH: fake.binDir,
        COSYNCING_HOME: home,
        COSYNCING_CACHE_DIR: join(userHome, '.cache', 'cosyncing'),
        CODEX_HOME: join(userHome, '.codex'),
        PI_CODING_AGENT_DIR: join(userHome, '.pi', 'agent'),
        COSYNCING_OMP_AGENT_DIR: join(userHome, '.omp', 'agent'),
        CLAUDE_CONFIG_DIR: fake.configDir,
      },
    }),
    probeTcp: async () => 'closed' as const,
    fetchJson: async () => ({ status: 'unreachable' as const }),
    listenerProcess: async () => undefined,
  };
  const marketplaceDir = claudeModMarketplaceDir(home);
  let lastPlan: SetupPlan | undefined;
  const run = async (answers: { claudeMod?: boolean } = {}): Promise<SetupCommandResult> => {
    const presenter = new ModPresenter(answers);
    // The committed-setup short-circuit returns before any plan is shown, so a stale plan from an earlier
    // run in this same fixture would otherwise be read as THIS run's answer.
    lastPlan = undefined;
    const result = await runSetup({
      buildInfo: BUILD_INFO,
      executablePath: join(userHome, 'bin', 'cosyncing'),
      home,
      context,
      presenter,
      now,
    });
    lastPlan = presenter.plan;
    return result;
  };
  return {
    fake,
    home,
    userHome,
    context,
    marketplaceDir,
    settingsPath: fake.settingsPath,
    plan: () => lastPlan,
    run,
  };
}

/** The fixture's own copy, inspected the way the product inspects it: against its stamped socket path. */
const copyAt = (fixture: { marketplaceDir: string; home: string }, version: string) =>
  inspectClaudeModMarketplace(fixture.marketplaceDir, version, { socketPath: claudeModStampedSocketPath(fixture.home) });
/** Write the fixture's copy the way setup writes it, stamped with its socket path. */
const writeAt = (fixture: { marketplaceDir: string; home: string }, version: string) =>
  writeClaudeModMarketplace(fixture.marketplaceDir, version, claudeModStampedSocketPath(fixture.home));

const modActionId = 'claude-mod.marketplace';
/** The English reference rows, matched as prefixes because they name the directory. */
const installRow = 'Write the cosyncing Claude mod at ';
const refreshRow = 'Refresh the cosyncing Claude mod at ';
const removeRow = 'Uninstall the cosyncing Claude mod with Claude';
const rows = (plan: SetupPlan | undefined, prefix: string): boolean =>
  (plan?.mutationSummary ?? []).some((row) => row.startsWith(prefix));
const resourcesAt = (home: string): InstalledResourceRecord[] => {
  const install = inspectInstallState(home);
  return install.committed ? install.state.resources : [];
};
const hasReceipt = (home: string): boolean => resourcesAt(home).some((r) => r.id === CLAUDE_MOD_RESOURCE_ID);

{
  const fixture = modFixture('install');
  const result = await fixture.run();
  const plan = fixture.plan();
  const expected = claudeModInstallCommands(fixture.marketplaceDir).map((argv) => argv.join(' '));
  check('a supported host gets exactly the four measured Claude commands, in order',
    fixture.fake.calls().join(' | ') === expected.join(' | '),
    fixture.fake.calls().join(' | '));
  check('the plan says it is installing the mod, and the transaction completed',
    plan?.claudeModIntent === 'install'
      && rows(plan, installRow)
      && plan.actions.some((action) => action.id === modActionId)
      && result.status === 'complete',
    `${plan?.claudeModIntent} ${result.status}`);
  check('the marketplace on disk is the copy this build can prove',
    copyAt(fixture, BUILD_INFO.version).status === 'owned');
  check('Claude ends up with both settings keys, written by Claude',
    inspectClaudeModSettings(fixture.settingsPath, fixture.marketplaceDir).status === 'enabled',
    readFileSync(fixture.settingsPath, 'utf8').trim());
  const receipt = resourcesAt(fixture.home).find((resource) => resource.id === CLAUDE_MOD_RESOURCE_ID);
  check('the receipt proves the exact bytes, so a later run can tell ours from someone else\'s',
    receipt?.ownership?.proof === 'package-hash'
      && receipt.ownership.installedSha256
        === copyAt(fixture, BUILD_INFO.version).actualSha256,
    receipt?.ownership?.installedSha256?.slice(0, 12) ?? 'none');
  check('the consent is recorded, which is what makes a later decline sticky',
    readSetupState(fixture.home).claudeModRequested === true);

  // The same command sequence has to serve a repair and a `cosy update`, so a second identical run must
  // be silent: a plan that re-offers an up-to-date mod every time makes `cosy update` noise.
  fixture.fake.reset();
  const again = await fixture.run();
  check('an unchanged second run short-circuits before it plans anything or asks Claude again',
    again.status === 'already-configured'
      && fixture.fake.calls().length === 0
      && fixture.plan() === undefined,
    `${fixture.fake.calls().length} calls ${again.status}`);

  // A version bump is the `cosy update` case. Claude loads the plugin in place from the marketplace
  // directory, so the running code is already new; what `update` fixes is the RECORDED version.
  fixture.fake.reset();
  const bumped = await runSetup({
    buildInfo: { ...BUILD_INFO, version: '9.9.9' },
    executablePath: join(fixture.userHome, 'bin', 'cosyncing'),
    home: fixture.home,
    context: fixture.context,
    presenter: new ModPresenter(),
    now,
  });
  check('a broker upgrade refreshes the mod and says it is refreshing, not installing',
    (bumped as unknown as { status: string }).status === 'complete'
      && copyAt(fixture, '9.9.9').status === 'owned',
    copyAt(fixture, '9.9.9').status);
  check('the refresh re-records the version with Claude rather than trusting the bytes on disk',
    fixture.fake.calls().join(' | ')
      === claudeModInstallCommands(fixture.marketplaceDir).map((argv) => argv.join(' ')).join(' | '),
    `${bumped.status} ${fixture.fake.calls().join(' | ')}`);
}

{
  const fixture = modFixture('decline');
  const result = await fixture.run({ claudeMod: false });
  check('a decline writes no marketplace and asks Claude for nothing',
    !existsSync(fixture.marketplaceDir)
      && fixture.fake.calls().length === 0
      && !existsSync(fixture.settingsPath),
    `${fixture.fake.calls().length} calls`);
  check('a decline still records the answer, because a decline that is not remembered is not a decline',
    readSetupState(fixture.home).claudeModRequested === false && result.status === 'complete',
    String(readSetupState(fixture.home).claudeModRequested));

  // Sticky: the decline has to survive the next run, which is what `cosy update` is.
  fixture.fake.reset();
  await runSetup({
    buildInfo: BUILD_INFO,
    executablePath: join(fixture.userHome, 'bin', 'cosyncing'),
    home: fixture.home,
    context: fixture.context,
    // No `claudeMod: false` here: the stored decline is the thing under test.
    presenter: new ModPresenter(),
    now,
  });
  check('a later run that asks nothing honours the stored decline instead of re-offering',
    !existsSync(fixture.marketplaceDir) && fixture.fake.calls().length === 0,
    fixture.fake.calls().join(' | '));
}

{
  // The removal half of a decline: the mod was accepted once, so the next decline has to take it back.
  const fixture = modFixture('decline-after-install');
  await fixture.run();
  fixture.fake.reset();
  await fixture.run({ claudeMod: false });
  const removed = claudeModRemoveCommands().map((argv) => argv.join(' ')).join(' | ');
  check('a decline after an install asks Claude to reverse its own two keys and nothing else',
    fixture.fake.calls().join(' | ') === removed, fixture.fake.calls().join(' | '));
  check('the marketplace directory and the receipt both go',
    !existsSync(fixture.marketplaceDir)
      && !hasReceipt(fixture.home));
  check('nothing of ours is left in Claude\'s settings',
    inspectClaudeModSettings(fixture.settingsPath, fixture.marketplaceDir).status === 'absent',
    readFileSync(fixture.settingsPath, 'utf8').trim());
}

{
  // The refusal path, which is the one that can strand something. Setup wrote the marketplace, Claude
  // said no, and the operator is left with either a directory or a dangling settings entry unless the
  // step takes both back down. SU7: and the mod is never the reason setup fails.
  const fixture = modFixture('refusal');
  fixture.fake.refuse('install');
  const result = await fixture.run();
  check('SU7 a refused first install completes setup and reports the mod outcome instead of failing the run',
    result.status === 'complete' && result.exitCode === 0
      && result.claudeMod?.operation === 'install'
      && result.claudeMod.detailCode === 'claude-mod-install-refused'
      && result.claudeMod.failureCode === 'policy_blocked'
      && result.claudeMod.commands.includes('cosyncing setup --install-claude-mod'),
    `${result.status} ${JSON.stringify(result.claudeMod)}`);
  check('a refused install leaves no marketplace directory behind',
    !existsSync(fixture.marketplaceDir),
    existsSync(fixture.marketplaceDir) ? `still at ${fixture.marketplaceDir}` : 'gone');
  check('a refused install records no receipt',
    !hasReceipt(fixture.home));
  check('SU7 a refused first install takes back what it added to Claude, so nothing names a missing directory',
    inspectClaudeModSettings(fixture.settingsPath, fixture.marketplaceDir).status === 'absent'
      && fixture.fake.calls().slice(-2).join(' | ')
        === claudeModRemoveCommands().map((argv) => argv.join(' ')).join(' | '),
    fixture.fake.calls().join(' | '));
  check('SU7 the refused install is recorded beside the marketplace, for doctor and the next run',
    readClaudeModOutcome(fixture.home)?.detailCode === 'claude-mod-install-refused',
    JSON.stringify(readClaudeModOutcome(fixture.home)));
  // The next run retries from a state it can prove: nothing installed, nothing receipted.
  fixture.fake.clearMisbehaviour();
  fixture.fake.reset();
  const retried = await fixture.run();
  check('SU7 the next run retries the install and clears the recorded outcome',
    retried.status === 'complete' && hasReceipt(fixture.home)
      && copyAt(fixture, BUILD_INFO.version).status === 'owned'
      && !existsSync(claudeModOutcomePath(fixture.home)),
    `${retried.status} receipt=${hasReceipt(fixture.home)} outcome=${existsSync(claudeModOutcomePath(fixture.home))}`);
}

{
  // Measured: a second reversal answers not_installed and not_configured. Those are the states a user
  // who already removed the mod inside Claude leaves, and setup must not fail on them.
  const fixture = modFixture('already-gone');
  await fixture.run();
  fixture.fake.reset();
  fixture.fake.forgetInsideClaude();
  const reversal = await fixture.run({ claudeMod: false });
  check('a reversal Claude has nothing to do is a success, not a failure',
    reversal.status === 'complete'
      && !existsSync(fixture.marketplaceDir)
      && !hasReceipt(fixture.home)
      && fixture.fake.calls().length === 2,
    `${reversal.status} dir=${existsSync(fixture.marketplaceDir)} receipt=${hasReceipt(fixture.home)} `
      + `calls=${fixture.fake.calls().length} ${fixture.fake.calls().join(' | ')}`);
}

{
  // The settings entry pointing somewhere else is the one state where setup must not speak for the user.
  const fixture = modFixture('foreign');
  await fixture.run();
  fixture.fake.reset();
  writeFileSync(fixture.settingsPath, JSON.stringify({
    extraKnownMarketplaces: { cosyncing: { source: { source: 'directory', path: '/srv/other/marketplace' } } },
    enabledPlugins: { 'cosyncing-claude@cosyncing': true },
  }, null, 2));
  await fixture.run({ claudeMod: false });
  check('a cosyncing marketplace entry that points elsewhere is left exactly where the user put it',
    fixture.fake.calls().length === 0
      && JSON.parse(readFileSync(fixture.settingsPath, 'utf8')).extraKnownMarketplaces.cosyncing.source.path
        === '/srv/other/marketplace',
    fixture.fake.calls().join(' | '));
}

{
  // A host without Claude, or with an old one, never sees a row. This is the promise the plan makes: no
  // plan row that the host could then fail at install time.
  for (const [label, version, reason] of [
    ['old-claude', '2.1.90', 'below-minimum-version'],
    ['new-claude', '2.2.0', ''],
  ] as const) {
    const fixture = modFixture(label, version);
    await fixture.run();
    const planned = fixture.plan()?.claudeModIntent;
    check(`Claude ${version} on this host ${reason ? `is skipped as ${reason}` : 'is offered the mod'}`,
      reason === '' ? planned === 'install' : planned === 'none' && !existsSync(fixture.marketplaceDir),
      String(planned));
  }
  const missing = modFixture('no-claude', '2.1.289');
  const missingContext: SetupDiagnosisContext = {
    ...missing.context,
    resolveExecutable: () => undefined,
    runReadOnly: async () => ({ status: 'unavailable' as const, stdout: '', stderr: '' }),
  };
  await runSetup({
    buildInfo: BUILD_INFO,
    executablePath: join(missing.userHome, 'bin', 'cosyncing'),
    home: missing.home,
    context: missingContext,
    presenter: new ModPresenter(),
    now,
  });
  check('a host with no claude on PATH plans no mod row',
    !existsSync(missing.marketplaceDir));
}

// ---------------------------------------------------------------------------
// 7. Uninstall
// ---------------------------------------------------------------------------

/** No managed Codex daemon to report on, which is the truth for every fixture here. */
const codexDaemonProbe = async (): Promise<CodexDaemonStatus> => ({ binaryAvailable: false, running: false });

{
  const fixture = modFixture('uninstall');
  await fixture.run();
  const asked: string[][] = [];
  const options = {
    buildInfo: BUILD_INFO,
    executablePath: join(fixture.userHome, 'bin', 'cosyncing'),
    home: fixture.home,
    cacheRoot: join(fixture.userHome, '.cache', 'cosyncing'),
    context: fixture.context,
    claudeSettingsPath: fixture.settingsPath,
    runClaudeMod: async (argv: readonly string[]) => {
      asked.push([...argv]);
      return { ok: true, stdout: '{"outcome":"ok"}', stderr: '' };
    },
    codexDaemonProbe,
    purgeData: false,
  };
  const plan = await inspectUninstall(options);
  check('uninstall names the mod removal and points it at the marketplace directory',
    plan.actions.some((action) => action.id === 'claude-mod.remove' && action.target === fixture.marketplaceDir),
    plan.actions.map((action) => action.id).join(','));
  const result = await runUninstall({
    ...options, confirmed: true, allowLegacyIntegrations: true, purgeData: false, purgeConfirmed: false,
  });
  check('uninstall reverses the Claude half with Claude\'s own two commands, in order',
    asked.map((argv) => argv.join(' ')).join(' | ') === claudeModRemoveCommands().map((a) => a.join(' ')).join(' | '),
    asked.map((argv) => argv.join(' ')).join(' | '));
  check('uninstall takes the directory and the receipt, and reports success',
    result.status === 'complete'
      && !existsSync(fixture.marketplaceDir)
      && !hasReceipt(fixture.home),
    `${result.status} ${result.detailCode}`);
}

{
  // An unprovable copy is preserved rather than deleted, with a warning that says so. Deleting bytes the
  // receipt cannot prove is the exact thing the ownership rules forbid.
  const fixture = modFixture('uninstall-preserved');
  await fixture.run();
  writeFileSync(join(fixture.marketplaceDir, 'cosyncing-claude/hooks/register.js'), '// hand edited\n');
  const options = {
    buildInfo: BUILD_INFO,
    executablePath: join(fixture.userHome, 'bin', 'cosyncing'),
    home: fixture.home,
    cacheRoot: join(fixture.userHome, '.cache', 'cosyncing'),
    context: fixture.context,
    claudeSettingsPath: fixture.settingsPath,
    runClaudeMod: async () => ({ ok: true, stdout: '{"outcome":"ok"}', stderr: '' }),
    codexDaemonProbe,
    purgeData: false,
  };
  const plan = await inspectUninstall(options);
  check('a drifted marketplace is preserved with a warning, not removed',
    !plan.actions.some((action) => action.id === 'claude-mod.remove')
      && plan.warnings.some((warning) => warning.detailCode.startsWith('claude-mod-')
        && warning.detailCode.endsWith('-preserved')),
    plan.warnings.map((warning) => warning.detailCode).join(','));
}

// ---------------------------------------------------------------------------
// 8. Doctor
// ---------------------------------------------------------------------------
{
  const fixture = modFixture('doctor');
  const supported: ClaudeModSupport = { supported: true, minimumVersion: CLAUDE_MOD_MIN_VERSION };
  const checks = (version: string) => claudeModChecks(fixture.home, fixture.context, version, supported);
  check('a machine with no mod and no receipt gets no doctor line', checks(BUILD_INFO.version).length === 0);
  await fixture.run();
  check('an installed, current mod passes and says so',
    checks(BUILD_INFO.version).length === 1
      && checks(BUILD_INFO.version)[0]!.status === 'pass'
      && checks(BUILD_INFO.version)[0]!.detailCode === 'claude-mod-present',
    checks(BUILD_INFO.version).map((c) => c.detailCode).join(','));
  const stale = checks('9.9.9');
  check('a mod older than this broker warns and names the fix',
    stale.length === 1 && stale[0]!.status === 'warn' && stale[0]!.detailCode === 'claude-mod-stale'
      && !!stale[0]!.remediation,
    stale.map((c) => c.detailCode).join(','));
  const settings = JSON.parse(readFileSync(fixture.settingsPath, 'utf8')) as Record<string, Record<string, unknown>>;
  writeFileSync(fixture.settingsPath, JSON.stringify(
    { ...settings, enabledPlugins: { 'cosyncing-claude@cosyncing': false } },
    null, 2,
  ));
  const switchedOff = checks(BUILD_INFO.version);
  check('a mod the user switched off inside Claude is reported, not assumed',
    switchedOff.length === 1 && switchedOff[0]!.detailCode === 'claude-mod-disabled',
    switchedOff.map((c) => c.detailCode).join(','));
}

// ---------------------------------------------------------------------------
// 10. The host states that used to block setup (U1-U12)
// ---------------------------------------------------------------------------

{
  // U1. The upgrade case the review caught: a broker whose mod bytes differ. The old rule called a
  // copy "stale" only when everything but the version stamp matched, so any real change to
  // register.js read as "drifted", then receipt-invalid, then a setup blocker. A copy the receipt
  // proves we wrote is ours to refresh whatever version it carries.
  const fixture = modFixture('u1-changed-bytes');
  await fixture.run();
  // A NEWER broker whose mod code also changed. The only way to get that from one embedded asset is
  // to say, through the receipt, that the bytes now on disk are the ones cosyncing itself wrote --
  // which is precisely the state a broker upgrade creates: the disk holds the PREVIOUS build's code,
  // the receipt proves it, and this build wants to write different code over it.
  const registerPath = join(fixture.marketplaceDir, 'cosyncing-claude/hooks/register.js');
  writeFileSync(registerPath, '// the previous build\'s mod code, which cosyncing wrote\n');
  const ledger = installStatePath(fixture.home);
  const proved = JSON.parse(readFileSync(ledger, 'utf8')) as {
    resources: { id: string; ownership?: { installedSha256?: string } }[];
  };
  const provedResource = proved.resources.find((resource) => resource.id === CLAUDE_MOD_RESOURCE_ID);
  if (!provedResource?.ownership) throw new Error('U1 fixture has no mod receipt to re-prove');
  provedResource.ownership.installedSha256
    = copyAt(fixture, BUILD_INFO.version).actualSha256 ?? '';
  writeFileSync(ledger, JSON.stringify(proved));
  const provedCopy = decideClaudeModOwnership({
    install: inspectInstallState(fixture.home),
    support: SUPPORTED,
    stateHome: fixture.home,
    version: BUILD_INFO.version,
    settingsPath: fixture.settingsPath,
    requested: true,
  });
  check('U1 a copy the receipt proves is ours even when its bytes differ from this build\'s',
    provedCopy.status === 'owned-stale' || provedCopy.status === 'owned-current',
    `${provedCopy.status} copy=${provedCopy.copy.status}`);
  const bumped = await runSetup({
    buildInfo: { ...BUILD_INFO, version: '9.9.9' },
    executablePath: join(fixture.userHome, 'bin', 'cosyncing'),
    home: fixture.home,
    context: fixture.context,
    presenter: new ModPresenter(),
    now,
  });
  check('U1 a receipt that proves the bytes outranks the version, so the upgrade refreshes instead of blocking',
    (bumped as unknown as { status: string }).status === 'complete'
      && bumped.actions.includes(modActionId)
      && !(bumped.issueCodes ?? []).some((code) => code.includes('claude-mod')),
    `${(bumped as unknown as { status: string }).status} ${(bumped.issueCodes ?? []).join(',')} ${bumped.failure?.code ?? ''} ${bumped.failure?.detail ?? ''}`);
  check('U1 the refresh overwrote the changed bytes with this build\'s own',
    copyAt(fixture, '9.9.9').status === 'owned',
    copyAt(fixture, '9.9.9').status);
}

{
  // U4. Uninstall inside Claude, measured on 2.1.289: `plugin uninstall` empties enabledPlugins and
  // LEAVES extraKnownMarketplaces.cosyncing pointing at our directory. That reads `marketplace`, and
  // the old code read `marketplace` as "installable", so the next setup run put the mod back over
  // the person's own removal.
  const fixture = modFixture('u4-removed-in-claude');
  await fixture.run();
  fixture.fake.forgetInsideClaude();
  const afterRemoval = decideClaudeModOwnership({
    install: inspectInstallState(fixture.home),
    support: SUPPORTED,
    stateHome: fixture.home,
    version: BUILD_INFO.version,
    settingsPath: fixture.settingsPath,
    requested: true,
  });
  check('U4 a receipt-owned copy whose Claude entries went away reads removed-in-claude, not installable',
    afterRemoval.status === 'removed-in-claude',
    `${afterRemoval.status} settings=${afterRemoval.settings.status}`);
  fixture.fake.reset();
  const rerun = await fixture.run();
  check('U4 the next setup run does not reinstall over their removal',
    rerun.status === 'already-configured' && fixture.fake.calls().length === 0,
    `${rerun.status} calls=${fixture.fake.calls().length}`);
  check('U4 the removal is sticky: the stored yes is not enough to put it back',
    readSetupState(fixture.home).claudeModRequested === true,
    String(readSetupState(fixture.home).claudeModRequested));
}

{
  // U3. "Not offered" must never be stored as "declined": a later `claude update` would find a
  // decision nobody made. The host here has a Claude BELOW the floor.
  const fixture = modFixture('u3-unsupported-host', '2.1.90');
  const result = await fixture.run();
  const state = readSetupState(fixture.home);
  check('U3 a host that could not run the mod stores no consent answer at all',
    !('claudeModRequested' in state) && result.status === 'complete',
    `${JSON.stringify(state.claudeModRequested)} ${result.status}`);
  check('U3 an unsupported host plans no mod row, in either direction',
    fixture.plan()?.claudeModIntent === 'none',
    fixture.plan()?.claudeModIntent ?? 'no plan');
  fixture.fake.reset();
  const again = await fixture.run();
  check('U3 a host that cannot run the mod never plans a remove that could not run',
    again.status !== 'blocked'
      && !fixture.fake.calls().some((call) => call.startsWith('plugin uninstall')),
    `${again.status} ${fixture.fake.calls().join(' | ')}`);
  // And the mirror: an unsupported host that DOES have our files (a Claude that was later removed)
  // must not be repaired back on, and must not be recorded as a decline either.
  const withFiles = modFixture('u3-unsupported-with-receipt');
  await withFiles.run();
  const downgraded = await runSetup({
    buildInfo: BUILD_INFO,
    executablePath: join(withFiles.userHome, 'bin', 'cosyncing'),
    home: withFiles.home,
    context: {
      ...withFiles.context,
      // A Claude that has since been downgraded: the receipt and the directory stay, the version does
      // not clear the floor. This is the state the review called "unsupported host that still has a
      // receipt".
      runReadOnly: async (executable: string) => (executable.endsWith('claude')
        ? { status: 'ok' as const, exitCode: 0, stdout: '2.1.90 (Claude Code)\n', stderr: '' }
        : { status: 'unavailable' as const, stdout: '', stderr: '' }),
    },
    presenter: new ModPresenter(),
    now,
  });
  // The first run WAS offered the mod and answered yes, so `true` is a real answer. The downgrade
  // must leave that answer where it is: not revoked to a decline, and not acted on.
  // `already-configured` is the honest short-circuit: nothing about the mod changed, so there is no
  // row to plan and no CLI to call. The point under test is that the stored yes survived and that
  // the run did not try to install onto a Claude that cannot carry it.
  // The status alternatives are grouped: without the parentheses `&&` bound tighter than `||`, so a
  // `complete` run passed whatever happened to the stored answer and the mod row.
  check('U3 a downgraded Claude keeps the answer it was given and acts on none of it',
    ((downgraded as unknown as { status: string }).status === 'complete'
      || (downgraded as unknown as { status: string }).status === 'already-configured')
      && readSetupState(withFiles.home).claudeModRequested === true
      && !downgraded.actions.includes(modActionId),
    `${downgraded.status} ${JSON.stringify(readSetupState(withFiles.home).claudeModRequested)} ${downgraded.actions.join(',')}`);
}

{
  // U5. The answer given THIS run is the answer this run acts on; a plain --yes keeps a stored decline.
  const fixture = modFixture('u5-yes-after-decline');
  await fixture.run({ claudeMod: false });
  check('U5 the decline is stored', readSetupState(fixture.home).claudeModRequested === false);
  fixture.fake.reset();
  // A run that ASKS and is answered yes: the operator changed their mind, in this run.
  const presenter = new ModPresenter({ claudeMod: true, claudeModFlag: true });
  const changed = await runSetup({
    buildInfo: BUILD_INFO,
    executablePath: join(fixture.userHome, 'bin', 'cosyncing'),
    home: fixture.home,
    context: fixture.context,
    presenter,
    now,
  });
  check('U5 an explicit yes after a stored decline installs in THIS run, not the next one',
    changed.actions.includes(modActionId)
      && existsSync(fixture.marketplaceDir)
      && changed.status === 'complete',
    `${changed.status} ${changed.actions.join(',')}`);
  // Now decline again, and check a plain --yes (which re-derives from the stored answer and does NOT
  // answer this run) cannot overturn it.
  const declined = await runSetup({
    buildInfo: BUILD_INFO,
    executablePath: join(fixture.userHome, 'bin', 'cosyncing'),
    home: fixture.home,
    context: fixture.context,
    presenter: new ModPresenter({ claudeMod: false, claudeModFlag: true }),
    now,
  });
  check('U5 a stated decline is acted on at once',
    declined.status === 'complete' && !existsSync(fixture.marketplaceDir),
    `${declined.status} dir=${existsSync(fixture.marketplaceDir)}`);
  const stored = readSetupState(fixture.home);
  const plainYes = new ModPresenter();
  plainYes.intendedChoices = () => ({
    installAgentSkill: true,
    installOpencodeShim: false,
    installClaudeMod: stored.claudeModRequested !== false,
    // The point: no answer was given this run.
    claudeModAnsweredThisRun: false,
  });
  const carried = await runSetup({
    buildInfo: BUILD_INFO,
    executablePath: join(fixture.userHome, 'bin', 'cosyncing'),
    home: fixture.home,
    context: fixture.context,
    presenter: plainYes,
    now,
  });
  check('U5 a plain --yes cannot overturn a stored decline',
    !existsSync(fixture.marketplaceDir) && !carried.actions.includes(modActionId),
    `${carried.status} ${carried.actions.join(',')}`);
}

{
  // U7 / SU3 / SU7. A refresh Claude refuses puts the previous copy back, leaves Claude's entries alone,
  // and is reported on a setup that still completes: the mod is never the reason setup fails.
  const fixture = modFixture('u7-rollback-refresh');
  await fixture.run();
  const before = readFileSync(join(fixture.marketplaceDir, 'cosyncing-claude/hooks/register.js'), 'utf8');
  const receiptBefore = resourcesAt(fixture.home).find((resource) => resource.id === CLAUDE_MOD_RESOURCE_ID);
  fixture.fake.reset();
  // The fake branches on the subcommand alone (`$2` of `claude plugin <sub>`).
  fixture.fake.refuse('install');
  const failed = await runSetup({
    buildInfo: { ...BUILD_INFO, version: '9.9.9' },
    executablePath: join(fixture.userHome, 'bin', 'cosyncing'),
    home: fixture.home,
    context: fixture.context,
    presenter: new ModPresenter(),
    now,
  });
  check('SU7 a refused refresh completes setup and reports the refresh outcome instead of failing it',
    failed.status === 'complete' && failed.claudeMod?.operation === 'refresh'
      && failed.claudeMod.detailCode === 'claude-mod-refresh-refused',
    `${failed.status} ${JSON.stringify(failed.claudeMod)} ${failed.failure?.code ?? ''}`);
  check('U7 the refresh rolled BACK by restoring the bytes that were there, not by deleting the mod',
    existsSync(join(fixture.marketplaceDir, 'cosyncing-claude/hooks/register.js'))
      && readFileSync(join(fixture.marketplaceDir, 'cosyncing-claude/hooks/register.js'), 'utf8') === before,
    'restored');
  check('SU3 the receipt still names exactly the restored bytes, so the next run can prove them',
    JSON.stringify(resourcesAt(fixture.home).find((resource) => resource.id === CLAUDE_MOD_RESOURCE_ID))
      === JSON.stringify(receiptBefore),
    JSON.stringify(resourcesAt(fixture.home).find((resource) => resource.id === CLAUDE_MOD_RESOURCE_ID)?.ownership));
  check('U7 a rolled-back refresh left Claude\'s two entries alone',
    inspectClaudeModSettings(fixture.settingsPath, fixture.marketplaceDir).status === 'enabled',
    inspectClaudeModSettings(fixture.settingsPath, fixture.marketplaceDir).status);
  check('U7 the rollback reversal was NOT run for a refresh (the mod was in Claude before this run)',
    !fixture.fake.calls().some((call) => call.startsWith('plugin uninstall')),
    fixture.fake.calls().join(' | '));
}

{
  // U8. Uninstall with no `claude` binary: cosyncing's own directory still goes, Claude's two
  // entries are reported as left behind with the commands to clear them, and the run finishes.
  const fixture = modFixture('u8-uninstall-no-cli');
  await fixture.run();
  const options = {
    buildInfo: BUILD_INFO,
    executablePath: join(fixture.userHome, 'bin', 'cosyncing'),
    home: fixture.home,
    cacheRoot: join(fixture.userHome, '.cache', 'cosyncing'),
    context: fixture.context,
    claudeSettingsPath: fixture.settingsPath,
    // The CLI cannot run at all: not a refusal, a host that has no Claude. The production runner, pointed
    // at a binary that is not there, is what reports that.
    runClaudeMod: defaultClaudeModCommandRunner(join(fixture.userHome, 'no-such-claude'), fixture.context.env),
    codexDaemonProbe,
    purgeData: false,
  };
  const result = await runUninstall({
    ...options, confirmed: true, allowLegacyIntegrations: true, purgeData: false, purgeConfirmed: false,
  });
  check('U8 an uninstall with no claude CLI finishes instead of blocking',
    result.status === 'complete', `${result.status} ${result.detailCode}`);
  check('U8 cosyncing\'s own directory is gone',
    !existsSync(fixture.marketplaceDir) && !hasReceipt(fixture.home));
  check('U8 the two Claude entries are named as left behind, with the commands that clear them',
    (result as unknown as { leftBehind?: string[] }).leftBehind?.length === 1
      && String((result as unknown as { leftBehind: string[] }).leftBehind?.[0]).includes('cosyncing-claude@cosyncing')
      && String((result as unknown as { leftBehind: string[] }).leftBehind?.[0]).includes('marketplace remove cosyncing'),
    JSON.stringify((result as unknown as { leftBehind?: string[] }).leftBehind));
  check('U8 the summary text carries the leftovers, so a caller that prints only the line still says it',
    result.summary.includes('Left behind'), result.summary.slice(-160));
}

{
  // U8b. A real refusal (the CLI ran and said no) still blocks, so this fix did not become a way to
  // uninstall past a genuine failure.
  const fixture = modFixture('u8b-uninstall-refused');
  await fixture.run();
  const result = await runUninstall({
    buildInfo: BUILD_INFO,
    executablePath: join(fixture.userHome, 'bin', 'cosyncing'),
    home: fixture.home,
    cacheRoot: join(fixture.userHome, '.cache', 'cosyncing'),
    context: fixture.context,
    claudeSettingsPath: fixture.settingsPath,
    runClaudeMod: async () => ({ ok: false, stdout: '{"outcome":"failed","failureCode":"policy_blocked"}', stderr: '' }),
    codexDaemonProbe,
    purgeData: false,
    confirmed: true, allowLegacyIntegrations: true, purgeConfirmed: false,
  });
  check('U8 a refusal the CLI actually answered still stops the uninstall, with nothing deleted',
    result.status !== 'complete' && existsSync(fixture.marketplaceDir),
    `${result.status} dir=${existsSync(fixture.marketplaceDir)}`);
}

{
  // U9. A malformed ~/.claude/settings.json. It used to block ALL of setup behind
  // `claude-mod-receipt-invalid`, and the message named the wrong thing.
  const fixture = modFixture('u9-bad-settings');
  writeFileSync(fixture.settingsPath, '{ not json at all\n');
  const result = await fixture.run();
  check('U9 broken Claude settings do not block setup',
    result.status === 'complete' && result.exitCode === 0,
    `${result.status} ${(result.issueCodes ?? []).join(',')}`);
  check('U9 the mod is not offered, for the reason that is actually true',
    !existsSync(fixture.marketplaceDir)
      && inspectClaudeModSettings(fixture.settingsPath, fixture.marketplaceDir).status === 'unreadable',
    inspectClaudeModSettings(fixture.settingsPath, fixture.marketplaceDir).status);
  check('U9 a corrupt plugin.json does not throw out of the inspector',
    (() => {
      const f = modFixture('u9b-bad-manifest');
      f.fake.reset();
      // Write a marketplace we own, then corrupt the manifest inside it.
      writeAt(f, BUILD_INFO.version);
      const manifest = join(f.marketplaceDir, 'cosyncing-claude/.claude-plugin/plugin.json');
      writeFileSync(manifest, '{"version": \n');
      const inspected = copyAt(f, BUILD_INFO.version);
      return inspected.status === 'drifted';
    })(), 'inspected without throwing');
}

{
  // U11. `allowManagedModsOnly: false` is the ABSENCE of the rule and must not skip.
  check('U11 allowManagedModsOnly:false is not a restriction, but true and an unknown value are',
    allowManagedModsOnlyIsRestriction(false) === false
      && allowManagedModsOnlyIsRestriction(true) === true
      && allowManagedModsOnlyIsRestriction('yes') === true);
}

{
  // U12. The smaller setup items, one check each.
  // (a) `disabled` proves the bytes before anything deletes them.
  const fixture = modFixture('u12-disabled-proof');
  await fixture.run();
  const settings = JSON.parse(readFileSync(fixture.settingsPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(fixture.settingsPath, JSON.stringify(
    { ...settings, enabledPlugins: { 'cosyncing-claude@cosyncing': false } }, null, 2,
  ));
  const proven = decideClaudeModOwnership({
    install: inspectInstallState(fixture.home),
    support: SUPPORTED,
    stateHome: fixture.home,
    version: BUILD_INFO.version,
    settingsPath: fixture.settingsPath,
    // The mod was accepted, then switched off inside Claude. A stored decline would outrank the
    // disk and read `declined`, which is a different branch with different rules.
    requested: true,
  });
  check('U12 a disabled mod the receipt proves is removable, because the proof is what says so',
    proven.status === 'disabled' && claudeModRemovable(proven) && claudeModReceiptProvesDisk(proven),
    `${proven.status} removable=${claudeModRemovable(proven)}`);
  // The same settings with the receipt taken out of the ledger: the switch is still off, but nothing
  // proves the bytes are ours, so an `rm -rf` has no business running.
  const ledger = installStatePath(fixture.home);
  const ledgerBackup = readFileSync(ledger, 'utf8');
  const unproven = (() => {
    try {
      const state = JSON.parse(ledgerBackup) as { resources: { id: string }[] };
      state.resources = state.resources.filter((resource) => resource.id !== CLAUDE_MOD_RESOURCE_ID);
      writeFileSync(ledger, JSON.stringify(state));
      return decideClaudeModOwnership({
        install: inspectInstallState(fixture.home),
        support: SUPPORTED,
        stateHome: fixture.home,
        version: BUILD_INFO.version,
        settingsPath: fixture.settingsPath,
        requested: true,
      });
    } finally {
      writeFileSync(ledger, ledgerBackup);
    }
  })();
  check('U12 a disabled mod the receipt CANNOT prove is never removed, whatever Claude\'s switch says',
    unproven.status === 'unowned' && !claudeModRemovable(unproven),
    `${unproven.status} removable=${claudeModRemovable(unproven)}`);

  // (b) The reversal names the plugin by its qualified id.
  check('U12 the reversal uses the qualified plugin id',
    claudeModRemoveCommands()[0]?.[2] === `${CLAUDE_MOD_PLUGIN_NAME}@${CLAUDE_MOD_MARKETPLACE_NAME}`,
    claudeModRemoveCommands()[0]?.join(' '));

  // (c) The commands run the same binary the version floor was checked against.
  check('U12 COSYNCING_CLAUDE_BIN is honoured by the command runner, not only by the version check',
    claudeModCommandBinary({ COSYNCING_CLAUDE_BIN: '/opt/claude-9/bin/claude' }, () => undefined)
      === '/opt/claude-9/bin/claude'
      && claudeModCommandBinary({}, (command) => `/usr/local/bin/${command}`) === '/usr/local/bin/claude'
      && claudeModCommandBinary({ COSYNCING_CLAUDE_BIN: '/opt/claude-9/bin/claude' }, () => '/opt/claude-9/bin/claude')
        === '/opt/claude-9/bin/claude',
    claudeModCommandBinary({ COSYNCING_CLAUDE_BIN: '/opt/claude-9/bin/claude' }, () => undefined));

  // (d) not_installed / not_configured are no-ops on the reversal and failures on the install.
  check('U12 not_installed is a no-op when taking things back and a failure when putting them in',
    claudePluginFailureIsNoOp({ outcome: 'failed', failureCode: 'not_installed' }, true) === true
      && claudePluginFailureIsNoOp({ outcome: 'failed', failureCode: 'not_configured' }, true) === true
      && claudePluginFailureIsNoOp({ outcome: 'failed', failureCode: 'not_installed' }, false) === false
      && claudePluginFailureIsNoOp({ outcome: 'failed', failureCode: 'not_configured' }, false) === false);
  const installSteps = await runClaudeModCommands(
    async () => ({ ok: false, stdout: '{"outcome":"failed","failureCode":"not_installed"}', stderr: '' }),
    claudeModInstallCommands('/x'),
  );
  check('U12 an install whose plugin step answers not_installed fails the run instead of receipting it',
    installSteps.ok === false && installSteps.steps.length === 1,
    `ok=${installSteps.ok} steps=${installSteps.steps.length}`);
  const reversalSteps = await runClaudeModCommands(
    async () => ({ ok: false, stdout: '{"outcome":"failed","failureCode":"not_installed"}', stderr: '' }),
    claudeModRemoveCommands(),
    { reversal: true },
  );
  check('U12 a retried uninstall still walks through both no-op steps',
    reversalSteps.ok === true && reversalSteps.steps.length === 2,
    `ok=${reversalSteps.ok} steps=${reversalSteps.steps.length}`);
}

{
  // U6. A run that dies with the mod already applied leaves a journal, and the NEXT run has to
  // reverse that step. Reversal needs the direction the interrupted run chose -- an install and a
  // removal share one action id -- and the recovery inputs used to omit the mod entirely, so
  // recovery got a declared no-op with no rollback: the marketplace directory, Claude's two entries
  // and the receipt all stayed on the machine behind a setup that reported it had rolled the run
  // back.
  //
  // A `throw` in apply is caught and rolled back, which leaves no journal, so the interrupted state
  // is built the way the product itself builds it: the mod step applies, its own rollback cannot
  // complete, and a later step fails. That is the `cleanup-required` journal a kill leaves behind,
  // reached through the real transaction rather than by writing a journal file by hand.
  const fixture = modFixture('u6-recovery');
  let journalSawIntent = 'no plan';
  const factory: typeof createSetupActionCatalog = (inputs) => {
    journalSawIntent = inputs.claudeMod?.intent ?? 'no plan';
    const catalog = createSetupActionCatalog(inputs);
    return {
      ...catalog,
      // The mod step is the last thing before the commit, so the interrupted moment is the commit
      // itself: every step has applied, nothing has been reversed.
      commitAction: {
        ...catalog.commitAction,
        async apply(context) {
          throw new Error('fixture died with the mod applied and nothing committed');
          void context;
        },
      },
      actions: catalog.actions.map((action): SetupTransactionAction => action.id === modActionId
        // And the reversal cannot complete, which is what turns a clean rollback into the journal a
        // kill leaves behind. Without this the transaction undoes the mod and reports a tidy failure.
        ? { ...action, rollback: () => { throw new Error('fixture could not reverse the mod step'); } }
        : action),
    };
  };
  const crashed = await runSetup({
    buildInfo: BUILD_INFO,
    executablePath: join(fixture.userHome, 'bin', 'cosyncing'),
    home: fixture.home,
    context: fixture.context,
    presenter: new ModPresenter(),
    now,
    actionCatalogFactory: factory,
  } as Parameters<typeof runSetup>[0]);
  check('U6 recovery inputs are built WITH the mod step, so a journaled mod has a rollback to run',
    journalSawIntent === 'install', journalSawIntent);
  let journalNote = 'unset';
  let journal: ReturnType<typeof readSetupTransactionJournal>;
  try {
    journal = readSetupTransactionJournal(fixture.home);
    journalNote = `${journal?.stage ?? 'no journal'} intent=${journal?.plan.claudeModIntent ?? 'none'}`;
  } catch (error) {
    journalNote = `throw:${error instanceof Error ? error.message : 'unknown'}`;
  }
  check('U6 the interrupted run leaves a journal that records the direction it was applying',
    crashed.status !== 'complete' && journal?.plan.claudeModIntent === 'install'
      && journal?.stage === 'failed',
    `${crashed.status} ${journalNote} code=${crashed.failure?.code ?? ''}`);
  check('U6 the failed run reports its own rollback as incomplete, which is what keeps the journal',
    crashed.failure?.rollback === 'incomplete', crashed.failure?.rollback ?? 'none');
  check('U6 the mod is still on disk behind that journal, which is the thing recovery must undo',
    existsSync(fixture.marketplaceDir), 'directory present');
  fixture.fake.reset();
  const recovered = await runSetup({
    buildInfo: BUILD_INFO,
    executablePath: join(fixture.userHome, 'bin', 'cosyncing'),
    home: fixture.home,
    context: fixture.context,
    presenter: new ModPresenter(),
    now,
  });
  check('U6 the next run reports it recovered the interrupted transaction and clears the journal',
    recovered.recoveredInterruptedTransaction === true && !readSetupTransactionJournal(fixture.home),
    `${recovered.status} recovered=${recovered.recoveredInterruptedTransaction}`);
  // The reversal is the FIRST thing recovery does, before it replans, so the mod's own two commands
  // lead the log. After that the run replans from the stored yes and puts the mod back, which is a
  // separate question from whether the interrupted step was reversed.
  const reversal = claudeModRemoveCommands().map((argv) => argv.join(' '));
  check('U6 recovery reversed the interrupted mod step with Claude\'s own commands, in order, first',
    fixture.fake.calls().slice(0, 2).join(' | ') === reversal.join(' | '),
    fixture.fake.calls().join(' | '));
}

// U2: a curl install's `cosy update` must bring the Claude mod with it. The upgrade cannot do it from
// its own process -- the marketplace embedded in the OLD binary IS the old mod -- so it asks the newly
// installed binary to run `claude-mod refresh`, which is this lifecycle function. These checks are that
// function against real directories, a real receipt and a fake `claude` that logs its own argv.
{
  const fx = modFixture('refresh-owned');
  await fx.run({ claudeMod: true });
  check('U2 the setup run leaves an owned copy and a receipt for it',
    copyAt(fx, BUILD_INFO.version).status === 'owned' && hasReceipt(fx.home));

  // The state a broker upgrade leaves behind when the mod does not move with it: our own bytes, from
  // an earlier build, with a receipt that proves exactly those bytes.
  const writeReceipt = (sha256: string) => {
    const install = inspectInstallState(fx.home);
    if (!install.committed) throw new Error('the fixture lost its install state');
    writeInstallState({
      ...install.state,
      resources: [
        ...install.state.resources.filter((resource) => resource.id !== CLAUDE_MOD_RESOURCE_ID),
        claudeModReceiptFor(fx.marketplaceDir, sha256, BUILD_FILES),
      ],
    }, fx.home);
  };
  const previous = writeAt(fx, '0.6.0');
  writeReceipt(previous.sha256);
  const callsBefore = fx.fake.calls().length;
  const refreshed = await refreshClaudeMod({
    buildInfo: BUILD_INFO,
    home: fx.home,
    context: fx.context,
  });
  const copy = copyAt(fx, BUILD_INFO.version);
  const receipt = resourcesAt(fx.home).find((resource) => resource.id === CLAUDE_MOD_RESOURCE_ID);
  check('U2 the refresh replaces our own older copy with this build\'s bytes',
    refreshed.status === 'refreshed' && copy.status === 'owned'
      && copy.actualSha256 === claudeModMarketplaceSha256(stampClaudeModMarketplace(
        BUILD_INFO.version, CLAUDE_MOD_MARKETPLACE_FILES, claudeModStampedSocketPath(fx.home),
      ))
      && copy.actualSha256 !== previous.sha256,
    `${refreshed.status}/${copy.status}/${copy.actualSha256?.slice(0, 12)}`);
  // A receipt left on the old hash would make the next run read its own refresh as receipt-invalid,
  // which turns one successful upgrade into a permanent setup blocker.
  check('U2 the receipt moves with the bytes the refresh wrote',
    receipt?.ownership.installedSha256 === copy.actualSha256
      && JSON.stringify(receipt?.ownership.files) === JSON.stringify([...BUILD_FILES].sort()),
    `${receipt?.ownership.installedSha256?.slice(0, 12)}/${copy.actualSha256?.slice(0, 12)}`);
  // The whole measured sequence, not just `install`: `marketplace update` is what makes Claude re-read
  // the directory and `plugin update` is what re-records the version.
  check('U2 the refresh runs Claude\'s whole measured sequence, in order',
    fx.fake.calls().slice(callsBefore).join(' | ') === claudeModInstallCommands(fx.marketplaceDir).map((argv) => argv.join(' ')).join(' | '),
    fx.fake.calls().slice(callsBefore).join(' | '));
  check('SU2 the refresh took and released the real installation lock, leaving no lock file behind',
    !existsSync(installationLockPath(fx.home))
      && (() => {
        const again = acquireInstallationLock({ command: 'setup', home: fx.home });
        again.release();
        return !existsSync(installationLockPath(fx.home));
      })());
  check('SU3 the refresh left no transaction journal or backup behind',
    readSetupTransactionJournal(fx.home) === undefined
      && !existsSync(join(fx.home, 'setup-transactions')),
    existsSync(join(fx.home, 'setup-transactions')) ? readdirSync(join(fx.home, 'setup-transactions')).join(',') : 'clean');

  // A copy the receipt cannot prove is not ours to overwrite, whatever the upgrade says.
  const driftHome = modFixture('refresh-drifted');
  await driftHome.run({ claudeMod: true });
  const edited = join(driftHome.marketplaceDir, CLAUDE_MOD_PLUGIN_NAME, 'hooks', 'register.js');
  const editedBytes = `${readFileSync(edited, 'utf8')}\n// edited by hand\n`;
  writeFileSync(edited, editedBytes);
  const driftCalls = driftHome.fake.calls().length;
  const drifted = await refreshClaudeMod({
    buildInfo: BUILD_INFO,
    home: driftHome.home,
    context: driftHome.context,
  });
  // The receipt IS the ownership proof, so a hand-edit reads `receipt-invalid` rather than `drifted`.
  // Either way the rule under test is the same: bytes cosyncing cannot prove are bytes it does not write.
  check('U2 a copy the receipt cannot prove is skipped by name, untouched, and never offered to Claude',
    drifted.status === 'skipped' && drifted.detailCode === 'claude-mod-refresh-skipped-receipt-invalid'
      && readFileSync(edited, 'utf8') === editedBytes
      && driftHome.fake.calls().length === driftCalls,
    `${drifted.status}/${drifted.detailCode}/calls=${driftHome.fake.calls().length - driftCalls}`);

  // A stored decline is sticky across an upgrade: the refresh asks the same decision setup asks.
  const declined = modFixture('refresh-declined');
  await declined.run({ claudeMod: true });
  await declined.run({ claudeMod: false });
  const reappeared = writeAt(declined, '0.6.0');
  {
    const install = inspectInstallState(declined.home);
    if (install.committed) {
      writeInstallState({
        ...install.state,
        resources: [
          ...install.state.resources.filter((resource) => resource.id !== CLAUDE_MOD_RESOURCE_ID),
          claudeModReceiptFor(declined.marketplaceDir, reappeared.sha256, BUILD_FILES),
        ],
      }, declined.home);
    }
  }
  const declinedRefresh = await refreshClaudeMod({
    buildInfo: BUILD_INFO,
    home: declined.home,
    context: declined.context,
  });
  check('U2 an upgrade does not reinstall a mod the operator declined',
    declinedRefresh.status === 'skipped'
      && declinedRefresh.detailCode === 'claude-mod-refresh-skipped-declined'
      && existsSync(declined.marketplaceDir),
    `${declinedRefresh.status}/${declinedRefresh.detailCode}`);

  // Claude refusing the install is reported, with the vendor's code, and does not receipt itself.
  const refused = modFixture('refresh-refused');
  await refused.run({ claudeMod: true });
  const refusedPrevious = writeAt(refused, '0.6.0');
  {
    const install = inspectInstallState(refused.home);
    if (install.committed) {
      writeInstallState({
        ...install.state,
        resources: [
          ...install.state.resources.filter((resource) => resource.id !== CLAUDE_MOD_RESOURCE_ID),
          claudeModReceiptFor(refused.marketplaceDir, refusedPrevious.sha256, BUILD_FILES),
        ],
      }, refused.home);
    }
  }
  refused.fake.refuse('install');
  const refusedRefresh = await refreshClaudeMod({
    buildInfo: BUILD_INFO,
    home: refused.home,
    context: refused.context,
  });
  check('U2 a Claude that refuses the install is reported with its own code, and nothing is receipted',
    refusedRefresh.status === 'failed'
      && refusedRefresh.detailCode === 'claude-mod-refresh-refused'
      && refusedRefresh.outcome?.failureCode === 'policy_blocked'
      && resourcesAt(refused.home).find((resource) => resource.id === CLAUDE_MOD_RESOURCE_ID)
        ?.ownership.installedSha256 === refusedPrevious.sha256,
    `${refusedRefresh.status}/${refusedRefresh.detailCode}/${JSON.stringify(refusedRefresh.outcome)}`);
  check('SU3 a refused refresh restores the previous copy byte for byte, and leaves Claude alone',
    copyAt(refused, '0.6.0').actualSha256 === refusedPrevious.sha256
      && inspectClaudeModSettings(refused.settingsPath, refused.marketplaceDir).status === 'enabled'
      && !refused.fake.calls().some((call) => call.startsWith('plugin uninstall')),
    `${copyAt(refused, '0.6.0').actualSha256?.slice(0, 12)} ${refused.fake.calls().join(' | ')}`);

  // The refresh writes a directory AND the ledger, so it holds the installation mutation lock.
  const locked = modFixture('refresh-locked');
  await locked.run({ claudeMod: true });
  {
    const stale = writeAt(locked, '0.6.0');
    const install = inspectInstallState(locked.home);
    if (install.committed) {
      writeInstallState({
        ...install.state,
        resources: [
          ...install.state.resources.filter((resource) => resource.id !== CLAUDE_MOD_RESOURCE_ID),
          claudeModReceiptFor(locked.marketplaceDir, stale.sha256, BUILD_FILES),
        ],
      }, locked.home);
    }
  }
  const bytesBefore = copyAt(locked, '0.6.0').actualSha256;
  // A real lock, held by a live process (this one), exactly as a concurrent setup would hold it.
  const held = acquireInstallationLock({ command: 'setup', home: locked.home });
  const lockedRefresh = await refreshClaudeMod({
    buildInfo: BUILD_INFO,
    home: locked.home,
    context: locked.context,
  });
  held.release();
  check('U2 a held installation lock refuses the refresh before it writes anything',
    lockedRefresh.status === 'refused'
      && lockedRefresh.detailCode === 'claude-mod-refresh-lock-unavailable'
      && copyAt(locked, '0.6.0').actualSha256 === bytesBefore,
    `${lockedRefresh.status}/${lockedRefresh.detailCode}`);
}


// ---------------------------------------------------------------------------
// 11. Proofs through the real entry points (SU1-SU12)
// ---------------------------------------------------------------------------

/** Collects what a CLI wrote, line by line. */
function captured(): { write(text: string): void; text(): string; lines(): string[] } {
  let buffer = '';
  return {
    write(text: string) { buffer += text; },
    text: () => buffer,
    lines: () => buffer.split('\n').filter((line) => line.length > 0),
  };
}

/** Rewrite the fixture's copy as an older build's, with a receipt that proves exactly those bytes. */
function ageCopy(fixture: { marketplaceDir: string; home: string }, version = '0.6.0'): string {
  const written = writeAt(fixture, version);
  const install = inspectInstallState(fixture.home);
  if (!install.committed) throw new Error('the fixture has no committed install to age');
  writeInstallState({
    ...install.state,
    resources: [
      ...install.state.resources.filter((resource) => resource.id !== CLAUDE_MOD_RESOURCE_ID),
      claudeModReceiptFor(fixture.marketplaceDir, written.sha256, written.files),
    ],
  }, fixture.home);
  return written.sha256;
}

/** Bounded wait for a fixture condition; a test helper, not a poll of a background job. */
async function waitFor(condition: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return condition();
}

function processGone(pid: number | undefined): boolean {
  if (pid === undefined) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

/**
 * `runCli` with the REAL argv parser, the REAL presenter it builds, and the REAL `runSetup`, pointed at the
 * fixture's scratch home and context. Nothing about setup is stubbed; only where it lives is chosen.
 */
async function cliSetup(
  fixture: ReturnType<typeof modFixture>,
  flags: string[],
  extra: { policyRoots?: readonly string[]; context?: SetupDiagnosisContext; buildInfo?: typeof BUILD_INFO } = {},
): Promise<{ exitCode: number; out: string[]; err: string }> {
  const stdout = captured();
  const stderr = captured();
  const exitCode = await runCli(['setup', ...flags], {
    buildInfo: extra.buildInfo ?? BUILD_INFO,
    stdout,
    stderr,
    setupOverrides: {
      executablePath: join(fixture.userHome, 'bin', 'cosyncing'),
      home: fixture.home,
      context: extra.context ?? fixture.context,
      now,
      claudePolicyRoots: extra.policyRoots ?? [join(fixture.userHome, 'no-managed-policy')],
    },
  });
  return { exitCode, out: stdout.lines(), err: stderr.text() };
}

const YES = ['--yes', '--accept-managed-runtime-ownership'];

{
  // SU2. The lock record accepts its own command, so the refresh's release() finds its own record, and a
  // refresh that died holding the lock is recovered like any other.
  const home = join(root, 'su2-lock');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  check('SU2 the lock record accepts every command it can be taken for, and release() removes it',
    INSTALLATION_MUTATIONS.every((command) => {
      const handle = acquireInstallationLock({ command, home });
      handle.release();
      return !existsSync(installationLockPath(home));
    }) && INSTALLATION_MUTATIONS.includes('claude-mod-refresh'));
  const exited = spawnSyncTrue();
  writeFileSync(installationLockPath(home), `${JSON.stringify({
    schemaVersion: 1,
    pid: exited,
    nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
    command: 'claude-mod-refresh',
    acquiredAt: FIXED_DATE.toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  let recovered = false;
  try {
    const handle = acquireInstallationLock({ command: 'setup', home });
    recovered = handle.recoveredStaleLock;
    handle.release();
  } catch {
    recovered = false;
  }
  check('SU2 a refresh lock left by a dead process is recovered, not read as unsafe',
    recovered && !existsSync(installationLockPath(home)), `pid=${exited} recovered=${recovered}`);
}

function spawnSyncTrue(): number {
  const child = Bun.spawnSync(['/bin/sh', '-c', 'exit 0']);
  return child.pid;
}

{
  // SU4. One allowlist, and only the allowlist.
  const env = Object.fromEntries([
    ...CLAUDE_MOD_REFRESH_ENV_ALLOWLIST.map((name) => [name, `value-of-${name}`]),
    ['COSYNCING_TEST_SECRET', 'must-not-pass'],
    ['ANTHROPIC_API_KEY', 'must-not-pass'],
  ]);
  const passed = claudeModRefreshEnvironment(env);
  check('SU4 the refresh environment keeps every allowlisted name and nothing else',
    CLAUDE_MOD_REFRESH_ENV_ALLOWLIST.every((name) => passed[name] === `value-of-${name}`)
      && !('COSYNCING_TEST_SECRET' in passed) && !('ANTHROPIC_API_KEY' in passed)
      && ['HOME', 'PATH', 'CLAUDE_CONFIG_DIR', 'COSYNCING_HOME', 'COSYNCING_CLAUDE_BIN']
        .every((name) => (CLAUDE_MOD_REFRESH_ENV_ALLOWLIST as readonly string[]).includes(name)),
    Object.keys(passed).join(','));
  // The setup runner hands Claude the context's environment: the fake reads CLAUDE_CONFIG_DIR from what it
  // was given, and this test process has none set for it.
  const fixture = modFixture('su4-runner-env');
  await fixture.run();
  const seen = fixture.fake.environments().filter((entry) => entry.CLAUDE_CONFIG_DIR !== '<unset>');
  check('SU4 every claude plugin command setup ran saw the context\'s CLAUDE_CONFIG_DIR and COSYNCING_HOME',
    fixture.fake.calls().length === 4 && seen.length >= 4
      && seen.every((entry) => entry.CLAUDE_CONFIG_DIR === fixture.fake.configDir && entry.COSYNCING_HOME === fixture.home),
    JSON.stringify(seen[0]));
}

{
  // SU5. Through the real argv parser and the real non-interactive presenter.
  const fixture = modFixture('su5-cli');
  const declined = await cliSetup(fixture, [...YES, '--no-install-claude-mod']);
  check('SU5 `setup --yes --no-install-claude-mod` stores a decline and installs nothing',
    declined.exitCode === 0 && readSetupState(fixture.home).claudeModRequested === false
      && !existsSync(fixture.marketplaceDir) && fixture.fake.calls().length === 0,
    `${declined.exitCode} ${declined.err}`);
  fixture.fake.reset();
  const plain = await cliSetup(fixture, YES);
  check('SU5 a plain `setup --yes` keeps the stored decline: no plan row, no Claude command',
    plain.exitCode === 0 && !existsSync(fixture.marketplaceDir) && fixture.fake.calls().length === 0
      && readSetupState(fixture.home).claudeModRequested === false,
    `${plain.exitCode} ${plain.out.slice(-2).join(' / ')}`);
  const yes = await cliSetup(fixture, [...YES, '--install-claude-mod']);
  check('SU5 `setup --yes --install-claude-mod` after a decline installs in that same run',
    yes.exitCode === 0 && copyAt(fixture, BUILD_INFO.version).status === 'owned' && hasReceipt(fixture.home)
      && readSetupState(fixture.home).claudeModRequested === true
      && yes.out.some((line) => line.startsWith('[plan] Write the cosyncing Claude mod at ')),
    `${yes.exitCode} ${yes.out.filter((line) => line.startsWith('[plan]')).join(' / ')}`);
  // Removed inside Claude: sticky against a plain --yes, undone by an explicit yes in the same run.
  fixture.fake.forgetInsideClaude({ keepMarketplace: true });
  fixture.fake.reset();
  const sticky = await cliSetup(fixture, YES);
  check('SU5 a plain `setup --yes` leaves a mod removed inside Claude removed',
    sticky.exitCode === 0 && fixture.fake.calls().length === 0
      && inspectClaudeModSettings(fixture.settingsPath, fixture.marketplaceDir).status === 'marketplace',
    `${sticky.exitCode} ${fixture.fake.calls().join(' | ')}`);
  const back = await cliSetup(fixture, [...YES, '--install-claude-mod']);
  check('SU5 `--install-claude-mod` after a removal inside Claude reinstalls in that same run',
    back.exitCode === 0
      && inspectClaudeModSettings(fixture.settingsPath, fixture.marketplaceDir).status === 'enabled'
      && fixture.fake.calls().join(' | ')
        === claudeModInstallCommands(fixture.marketplaceDir).map((argv) => argv.join(' ')).join(' | '),
    `${back.exitCode} ${fixture.fake.calls().join(' | ')}`);
  const both = await cliSetup(fixture, [...YES, '--install-claude-mod', '--no-install-claude-mod']);
  check('SU5 both mod flags together are refused before anything runs',
    both.exitCode === 2 && both.err.includes('both --install-claude-mod and --no-install-claude-mod'),
    both.err.trim());
  const help = captured();
  await runCli(['help'], { buildInfo: BUILD_INFO, stdout: help, stderr: captured() });
  check('SU5 the help text names the explicit yes beside the decline',
    help.text().includes('[--install-claude-mod | --no-install-claude-mod]'));

  // The interactive presenter: the flag is the answer, so the wizard does not ask, and an otherwise
  // unchanged rerun is not short-circuited before it is heard.
  const clack = createClackSetupPresenter({ installClaudeMod: true });
  const supportedInspection = { claudeMod: { support: SUPPORTED } } as unknown as SetupInspection;
  check('SU5 the interactive presenter takes --install-claude-mod as its answer without prompting',
    clack.claudeModFlag?.() === true && await clack.confirmClaudeMod(supportedInspection) === true);
  const interactive = modFixture('su5-interactive');
  await interactive.run({ claudeMod: false });
  interactive.fake.reset();
  const flagged = new ModPresenter({ claudeMod: true });
  (flagged as { intendedChoices?: unknown }).intendedChoices = undefined;
  (flagged as SetupPresenter).claudeModFlag = () => true;
  const asked = await runSetup({
    buildInfo: BUILD_INFO,
    executablePath: join(interactive.userHome, 'bin', 'cosyncing'),
    home: interactive.home,
    context: interactive.context,
    presenter: flagged,
    now,
  });
  check('SU5 an interactive rerun with --install-claude-mod and nothing else to do still installs, not already-configured',
    asked.status === 'complete' && asked.actions.includes(modActionId)
      && copyAt(interactive, BUILD_INFO.version).status === 'owned',
    `${asked.status} ${asked.actions.join(',')}`);
}

/** ANSI escapes stripped, so a prompt's text can be matched however clack coloured it. */
const plainTerminalText = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '');

/**
 * The interactive wizard, for real: `runCli(['setup'])` with no `--yes`, in a child on a pseudo-terminal
 * (script(1)), so the clack presenter draws and reads its own prompts.
 *
 * Each prompt is answered as it appears. The Claude mod's question gets `modKey` ('y' or 'n', which clack
 * takes as the answer itself); the OpenCode shim and Tokdash get a no, so the run never provisions either;
 * every other prompt gets Enter, its own default. The child runs a source build, whose durable service is
 * offered disabled, so Enter on the service question is the foreground choice.
 */
async function wizardSetup(
  fixture: ReturnType<typeof modFixture>,
  options: { version: string; modKey: 'y' | 'n'; flags?: string[] },
): Promise<{ exitCode: number | null; modAsked: boolean; output: string }> {
  const messages = setupMessages('en');
  const startOf = (message: string): string => message.slice(0, 40);
  const answers: Array<[string, string]> = [
    [startOf(messages.claudeModConfirm), options.modKey],
    [startOf(messages.opencodeShimConfirm), 'n'],
    [startOf(messages.quotaConfirm), 'n'],
  ];
  const input = JSON.stringify({
    userHome: fixture.userHome,
    home: fixture.home,
    fakeBinDir: fixture.fake.binDir,
    fakeConfigDir: fixture.fake.configDir,
    version: options.version,
    flags: options.flags ?? [],
    now: FIXED_DATE.toISOString(),
  });
  const childPath = join(import.meta.dir, '../helpers/setup-wizard-child.ts');
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `stty cols 400 rows 50 && exec ${quote(process.execPath)} ${quote(childPath)} ${quote(input)}`;
  const argv = process.platform === 'darwin'
    ? ['script', '-q', '/dev/null', 'sh', '-c', command]
    : ['script', '-q', '-e', '-c', command, '/dev/null'];
  const child = Bun.spawn(argv, {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: fixture.userHome,
      COSYNCING_SETUP_LANG: 'en',
      TERM: 'xterm-256color',
    },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  const killer = setTimeout(() => child.kill(), 60_000);
  const decoder = new TextDecoder();
  let output = '';
  let answeredAt = -1;
  let modAsked = false;
  let settle: ReturnType<typeof setTimeout> | undefined;
  // Answer the newest active prompt once the screen has settled. An answered prompt is redrawn as
  // submitted, so a newer active marker than the last one answered is always a new question.
  const answerIfWaiting = (): void => {
    const plain = plainTerminalText(output);
    const at = plain.lastIndexOf('◆');
    if (at <= answeredAt) return;
    answeredAt = at;
    const prompt = plain.slice(at, at + 400);
    const answer = answers.find(([start]) => prompt.includes(start));
    if (answer?.[0] === startOf(messages.claudeModConfirm)) modAsked = true;
    child.stdin.write(answer?.[1] ?? '\r');
    void child.stdin.flush();
  };
  const reader = child.stdout.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
      if (settle) clearTimeout(settle);
      settle = setTimeout(answerIfWaiting, 250);
    }
    const exitCode = await child.exited;
    output += await new Response(child.stderr).text();
    return { exitCode, modAsked, output: plainTerminalText(output) };
  } finally {
    if (settle) clearTimeout(settle);
    clearTimeout(killer);
    reader.releaseLock();
    child.stdin.end();
    if (child.exitCode === null) { child.kill(); await child.exited; }
  }
}

{
  // R4-1. A removal inside Claude is sticky, and a plain --yes keeps the stored choice. setup used to
  // mark every run as having answered the mod question, so a `setup --yes` with any real work to do (an
  // installer rerun, an npm update, a broker content change) read the stored yes as a fresh one and put the
  // mod back. Each run below claims a newer build, so none of them is the unchanged-host shortcut.
  const fixture = modFixture('r4-1-removed-sticky');
  const installed = await cliSetup(fixture, YES);
  fixture.fake.forgetInsideClaude({ keepMarketplace: true });
  fixture.fake.reset();
  const settingsStatus = () => inspectClaudeModSettings(fixture.settingsPath, fixture.marketplaceDir).status;
  const bumped = await cliSetup(fixture, YES, { buildInfo: { ...BUILD_INFO, version: '9.9.1' } });
  check('R4-1 a plain `setup --yes` that has other work to do leaves a mod removed inside Claude removed',
    installed.exitCode === 0 && bumped.exitCode === 0
      && bumped.out.some((line) => line.startsWith('[plan]'))
      && fixture.fake.calls().length === 0 && settingsStatus() === 'marketplace',
    `${bumped.exitCode} plan=${bumped.out.filter((line) => line.startsWith('[plan]')).length} `
      + `calls=${fixture.fake.calls().join(' | ')} settings=${settingsStatus()}`);
  fixture.fake.reset();
  const flagged = await cliSetup(fixture, [...YES, '--install-claude-mod'], { buildInfo: { ...BUILD_INFO, version: '9.9.2' } });
  check('R4-1 `setup --yes --install-claude-mod` on such a run reinstalls it',
    flagged.exitCode === 0 && settingsStatus() === 'enabled'
      && fixture.fake.calls().join(' | ')
        === claudeModInstallCommands(fixture.marketplaceDir).map((argv) => argv.join(' ')).join(' | '),
    `${flagged.exitCode} ${fixture.fake.calls().join(' | ')} settings=${settingsStatus()}`);

  // The wizard: a yes it asked for and was given is an answer, and so is a no.
  fixture.fake.forgetInsideClaude({ keepMarketplace: true });
  fixture.fake.reset();
  const yes = await wizardSetup(fixture, { version: '9.9.3', modKey: 'y' });
  check('R4-1 the wizard asked, and its yes reinstalls a mod removed inside Claude',
    yes.exitCode === 0 && yes.modAsked && settingsStatus() === 'enabled'
      && readSetupState(fixture.home).claudeModRequested === true,
    `exit=${yes.exitCode} asked=${yes.modAsked} settings=${settingsStatus()} ${yes.output.slice(-600)}`);
  fixture.fake.forgetInsideClaude({ keepMarketplace: true });
  fixture.fake.reset();
  const no = await wizardSetup(fixture, { version: '9.9.4', modKey: 'n' });
  check('R4-1 the wizard asked, and its no leaves the mod removed and stores the decline',
    no.exitCode === 0 && no.modAsked && settingsStatus() !== 'enabled'
      && !fixture.fake.calls().some((call) => call.startsWith('plugin install'))
      && readSetupState(fixture.home).claudeModRequested === false,
    `exit=${no.exitCode} asked=${no.modAsked} settings=${settingsStatus()} calls=${fixture.fake.calls().join(' | ')}`);
  fixture.fake.reset();
  const after = await cliSetup(fixture, YES, { buildInfo: { ...BUILD_INFO, version: '9.9.5' } });
  check('R4-1 after the wizard\'s no, the next plain `setup --yes` keeps it removed',
    after.exitCode === 0 && settingsStatus() !== 'enabled'
      && !fixture.fake.calls().some((call) => call.startsWith('plugin install'))
      && readSetupState(fixture.home).claudeModRequested === false,
    `${after.exitCode} calls=${fixture.fake.calls().join(' | ')} settings=${settingsStatus()}`);
}

{
  // R4-9. The stamp is a string replacement, and a replacement STRING expands `$$`, `$&`, `$'` and
  // `` $` ``. A state home whose path held one of them got a different path stamped -- or the rest of
  // the file spliced into the literal -- and the receipt then vouched for the corrupted bytes.
  for (const [name, dirName] of [['dollars', 'st$$h'], ['match', 'st$&h'], ['before', 'st$`h'], ['after', "st$'h"]] as const) {
    const fixture = modFixture(`r4-9-${name}`, '2.1.289', dirName);
    const result = await fixture.run();
    const socket = claudeModStampedSocketPath(fixture.home);
    const installed = existsSync(join(fixture.marketplaceDir, 'cosyncing-claude/hooks/register.js'))
      ? readFileSync(join(fixture.marketplaceDir, 'cosyncing-claude/hooks/register.js'), 'utf8')
      : '';
    const line = installed.split('\n').find((text) => text.startsWith('const STAMPED_SOCKET_PATH =')) ?? 'none';
    check(`R4-9 a state home holding ${dirName.slice(2, 4)} is stamped as exactly JSON.stringify(path)`,
      result.status === 'complete' && socket.includes(dirName) && line === `const STAMPED_SOCKET_PATH = ${JSON.stringify(socket)};`,
      `${result.status} ${line.slice(0, 160)}`);
    check(`R4-9 and the receipt proves that copy (${dirName.slice(2, 4)})`,
      copyAt(fixture, BUILD_INFO.version).status === 'owned' && hasReceipt(fixture.home),
      copyAt(fixture, BUILD_INFO.version).status);
  }
}

{
  // SU6. Through refresh and setup: a removal inside Claude survives an older copy and a newer broker.
  const fixture = modFixture('su6-removed-older');
  await fixture.run();
  ageCopy(fixture);
  fixture.fake.forgetInsideClaude({ keepMarketplace: true });
  fixture.fake.reset();
  const refreshed = await refreshClaudeMod({ buildInfo: BUILD_INFO, home: fixture.home, context: fixture.context });
  check('SU6 the refresh leaves an older copy that was removed inside Claude alone',
    refreshed.status === 'skipped' && refreshed.detailCode === 'claude-mod-refresh-skipped-removed-in-claude'
      && fixture.fake.calls().length === 0 && copyAt(fixture, '0.6.0').status === 'owned',
    `${refreshed.status}/${refreshed.detailCode}`);
  const rerun = await fixture.run();
  check('SU6 a setup on a newer broker does not reinstall it either',
    !rerun.actions.includes(modActionId) && fixture.fake.calls().length === 0,
    `${rerun.status} ${rerun.actions.join(',')}`);
  const disabled = modFixture('su6-disabled-older');
  await disabled.run();
  ageCopy(disabled);
  const settings = JSON.parse(readFileSync(disabled.settingsPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(disabled.settingsPath, JSON.stringify({ ...settings, enabledPlugins: { 'cosyncing-claude@cosyncing': false } }));
  disabled.fake.reset();
  const disabledRefresh = await refreshClaudeMod({ buildInfo: BUILD_INFO, home: disabled.home, context: disabled.context });
  check('SU6 the refresh leaves an older copy switched off inside Claude alone',
    disabledRefresh.detailCode === 'claude-mod-refresh-skipped-disabled' && disabled.fake.calls().length === 0,
    disabledRefresh.detailCode);
}

{
  // SU7. The decline-and-remove direction, a CLI that hangs, and a CLI that prints prose: none of them is
  // the reason setup fails, and each leaves a state the ledger proves.
  const fixture = modFixture('su7-remove-refused');
  await fixture.run();
  const receiptBefore = JSON.stringify(resourcesAt(fixture.home).find((resource) => resource.id === CLAUDE_MOD_RESOURCE_ID));
  fixture.fake.refuse('uninstall');
  fixture.fake.reset();
  const result = await cliSetup(fixture, [...YES, '--no-install-claude-mod']);
  check('SU7 a removal Claude refuses still completes setup, with the outcome and its commands printed',
    result.exitCode === 0
      && result.out.some((line) => line === '[claude-mod] leftovers operation=remove code=claude-mod-remove-refused claude=policy_blocked')
      && result.out.some((line) => line === `[claude-mod] run=claude plugin uninstall cosyncing-claude@cosyncing`.replace('claude plugin', `CLAUDE_CONFIG_DIR=${JSON.stringify(fixture.fake.configDir)} claude plugin`)),
    result.out.filter((line) => line.startsWith('[claude-mod]')).join(' / '));
  check('SU7 the refused removal keeps the directory and re-asserts the receipt, so the ledger matches the disk',
    copyAt(fixture, BUILD_INFO.version).status === 'owned'
      && JSON.stringify(resourcesAt(fixture.home).find((resource) => resource.id === CLAUDE_MOD_RESOURCE_ID)) === receiptBefore
      && readSetupState(fixture.home).claudeModRequested === false,
    receiptBefore.slice(0, 80));
  fixture.fake.clearMisbehaviour();
  fixture.fake.reset();
  const retried = await cliSetup(fixture, YES);
  check('SU7 the next plain run retries the removal once Claude accepts it',
    retried.exitCode === 0 && !existsSync(fixture.marketplaceDir) && !hasReceipt(fixture.home)
      && !existsSync(claudeModOutcomePath(fixture.home)),
    `${retried.exitCode} dir=${existsSync(fixture.marketplaceDir)} ${fixture.fake.calls().join(' | ')}`);

  // A CLI that never answers. The production runner, with a short ceiling, is what times it out.
  const hung = modFixture('su7-timeout');
  hung.fake.hang('install');
  const shortRunner: typeof createSetupActionCatalog = (inputs) => createSetupActionCatalog({
    ...inputs,
    ...(inputs.claudeMod
      ? { claudeMod: { ...inputs.claudeMod, run: defaultClaudeModCommandRunner(hung.fake.bin, hung.context.env, 400) } }
      : {}),
  });
  const timedOut = await runSetup({
    buildInfo: BUILD_INFO,
    executablePath: join(hung.userHome, 'bin', 'cosyncing'),
    home: hung.home,
    context: hung.context,
    presenter: new ModPresenter(),
    now,
    actionCatalogFactory: shortRunner,
  });
  check('SU7 a Claude that hangs is timed out and reported, and setup completes',
    timedOut.status === 'complete' && timedOut.claudeMod?.detailCode === 'claude-mod-install-timeout'
      && !existsSync(hung.marketplaceDir) && !hasReceipt(hung.home),
    `${timedOut.status} ${JSON.stringify(timedOut.claudeMod)}`);
  check('SU7 the timed-out claude process is gone, not orphaned',
    await waitFor(() => processGone(hung.fake.hangingPid()), 5_000), String(hung.fake.hangingPid()));

  const garbled = modFixture('su7-garbled');
  garbled.fake.garble('install');
  const prose = await garbled.run();
  check('SU7 a Claude that prints prose instead of JSON is reported as unparseable, and setup completes',
    prose.status === 'complete' && prose.claudeMod?.detailCode === 'claude-mod-install-unparseable'
      && !existsSync(garbled.marketplaceDir),
    `${prose.status} ${JSON.stringify(prose.claudeMod)}`);
}

{
  // SU8. A refresh over a receipt-proven copy whose file set differs: the dropped file goes, the receipt
  // records the new list.
  const fixture = modFixture('su8-file-set');
  await fixture.run();
  const older = writeAt(fixture, '0.6.0');
  const extraPath = 'cosyncing-claude/hooks/retired-helper.js';
  writeFileSync(join(fixture.marketplaceDir, extraPath), '// shipped by an older build\n', { mode: 0o600 });
  const listed = [...older.files, extraPath];
  const sha = inspectClaudeModMarketplace(fixture.marketplaceDir, BUILD_INFO.version, {
    socketPath: claudeModStampedSocketPath(fixture.home),
    receiptFiles: listed,
  }).actualSha256!;
  const install = inspectInstallState(fixture.home);
  if (!install.committed) throw new Error('su8 fixture lost its install');
  writeInstallState({
    ...install.state,
    resources: [
      ...install.state.resources.filter((resource) => resource.id !== CLAUDE_MOD_RESOURCE_ID),
      claudeModReceiptFor(fixture.marketplaceDir, sha, listed),
    ],
  }, fixture.home);
  const refreshed = await refreshClaudeMod({ buildInfo: BUILD_INFO, home: fixture.home, context: fixture.context });
  const receipt = resourcesAt(fixture.home).find((resource) => resource.id === CLAUDE_MOD_RESOURCE_ID);
  check('SU8 a refresh over a copy with a file this build dropped deletes that file and receipts the new set',
    refreshed.status === 'refreshed' && !existsSync(join(fixture.marketplaceDir, extraPath))
      && copyAt(fixture, BUILD_INFO.version).status === 'owned'
      && JSON.stringify(receipt?.ownership.files) === JSON.stringify([...BUILD_FILES].sort()),
    `${refreshed.status}/${refreshed.detailCode} extra=${existsSync(join(fixture.marketplaceDir, extraPath))}`);
}

{
  // SU9 / SU3. A refresh KILLED half way, through the real built CLI as a child process: the next setup
  // recovers the journal, puts the old copy back, and leaves Claude's entries alone.
  const bundleDir = join(root, 'built-cli');
  mkdirSync(bundleDir, { recursive: true });
  const bundle = join(bundleDir, 'cosyncing.js');
  const built = Bun.spawnSync([process.execPath, 'run', join(import.meta.dir, '../../../../../scripts/broker/build-broker-bundle.ts'),
    '--outfile', bundle, '--distribution', 'bootstrap-js'], { stdout: 'pipe', stderr: 'pipe' });
  check('SU9 the CLI under test is the built bundle', built.exitCode === 0 && existsSync(bundle),
    built.stderr.toString().slice(0, 200));
  const builtVersion = (JSON.parse(Bun.spawnSync([process.execPath, bundle, 'version', '--json']).stdout.toString()) as { version: string }).version;

  const fixture = modFixture('su9-killed-refresh');
  await fixture.run();
  const oldSha = ageCopy(fixture, '0.6.0');
  fixture.fake.hang('install');
  fixture.fake.reset();
  const child = spawn(process.execPath, [bundle, 'claude-mod', 'refresh', '--json', '--home', fixture.home], {
    env: { ...claudeModRefreshEnvironment(fixture.context.env), COSYNCING_CLAUDE_BIN: fixture.fake.bin },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const reachedClaude = await waitFor(() => fixture.fake.hangingPid() !== undefined);
  const journalBeforeKill = (() => {
    try {
      return readSetupTransactionJournal(fixture.home)?.plan.claudeModIntent;
    } catch {
      return 'unreadable';
    }
  })();
  child.kill('SIGKILL');
  await new Promise((resolveExit) => child.once('exit', resolveExit));
  const sleeper = fixture.fake.hangingPid();
  if (sleeper !== undefined && !processGone(sleeper)) process.kill(sleeper, 'SIGKILL');
  check('SU9 the killed refresh had reached Claude with the new copy written and its intent journaled',
    reachedClaude && journalBeforeKill === 'install' && copyAt(fixture, builtVersion).status === 'owned'
      && existsSync(installationLockPath(fixture.home)),
    `reached=${reachedClaude} journal=${journalBeforeKill} copy=${copyAt(fixture, builtVersion).status}`);
  fixture.fake.clearMisbehaviour();
  const callsBeforeRecovery = fixture.fake.calls().length;
  let atRecovery: { sha?: string; settings: string; calls: string[] } | undefined;
  const watching = new ModPresenter();
  watching.recoveredInterruptedTransaction = () => {
    watching.calls.push('recovered');
    atRecovery = {
      ...(copyAt(fixture, '0.6.0').actualSha256 ? { sha: copyAt(fixture, '0.6.0').actualSha256 } : {}),
      settings: inspectClaudeModSettings(fixture.settingsPath, fixture.marketplaceDir).status,
      calls: fixture.fake.calls().slice(callsBeforeRecovery),
    };
  };
  const recovered = await runSetup({
    buildInfo: BUILD_INFO,
    executablePath: join(fixture.userHome, 'bin', 'cosyncing'),
    home: fixture.home,
    context: fixture.context,
    presenter: watching,
    now,
  });
  check('SU9 the next setup recovers the killed refresh and restores the previous copy byte for byte',
    recovered.recoveredInterruptedTransaction === true && atRecovery?.sha === oldSha,
    `${recovered.status} recovered=${recovered.recoveredInterruptedTransaction} sha=${atRecovery?.sha?.slice(0, 12)}/${oldSha.slice(0, 12)}`);
  check('SU9 recovering a refresh leaves Claude\'s entries alone: no uninstall, still enabled',
    atRecovery?.settings === 'enabled' && (atRecovery?.calls ?? ['x']).length === 0,
    JSON.stringify(atRecovery));
  check('SU9 after recovery the same run refreshes cleanly and leaves no journal or lock behind',
    recovered.status === 'complete' && copyAt(fixture, BUILD_INFO.version).status === 'owned'
      && readSetupTransactionJournal(fixture.home) === undefined && !existsSync(installationLockPath(fixture.home)),
    `${recovered.status} ${copyAt(fixture, BUILD_INFO.version).status}`);

  // SU9. An interrupted FIRST install recovered on a host whose `claude` has since gone: the cosyncing side
  // is taken back, Claude's side is recorded as leftovers, and recovery does not throw on every later run.
  const noCli = modFixture('su9-no-cli-recovery');
  const dying: typeof createSetupActionCatalog = (inputs) => {
    const catalog = createSetupActionCatalog(inputs);
    return {
      ...catalog,
      commitAction: { ...catalog.commitAction, async apply() { throw new Error('fixture died before commit'); } },
      actions: catalog.actions.map((action): SetupTransactionAction => action.id === modActionId
        ? { ...action, rollback: () => { throw new Error('fixture could not reverse the mod step'); } }
        : action),
    };
  };
  await runSetup({
    buildInfo: BUILD_INFO,
    executablePath: join(noCli.userHome, 'bin', 'cosyncing'),
    home: noCli.home,
    context: noCli.context,
    presenter: new ModPresenter(),
    now,
    actionCatalogFactory: dying,
  });
  const journaled = readSetupTransactionJournal(noCli.home)?.plan.claudeModIntent;
  const withoutClaude: SetupDiagnosisContext = {
    ...noCli.context,
    env: { ...noCli.context.env, PATH: join(noCli.userHome, 'empty-bin') },
    resolveExecutable: () => undefined,
    runReadOnly: async () => ({ status: 'unavailable' as const, stdout: '', stderr: '' }),
  };
  const afterLoss = await runSetup({
    buildInfo: BUILD_INFO,
    executablePath: join(noCli.userHome, 'bin', 'cosyncing'),
    home: noCli.home,
    context: withoutClaude,
    presenter: new ModPresenter(),
    now,
  });
  const leftover = readClaudeModOutcome(noCli.home);
  check('SU9 recovery with no runnable claude finishes the cosyncing side and records the leftovers',
    journaled === 'install' && afterLoss.recoveredInterruptedTransaction === true
      && afterLoss.status === 'complete' && !existsSync(noCli.marketplaceDir)
      && readSetupTransactionJournal(noCli.home) === undefined
      && leftover?.operation === 'rollback' && leftover.detailCode === 'claude-mod-rollback-unavailable'
      && leftover.commands.some((command) => command.endsWith('claude plugin uninstall cosyncing-claude@cosyncing')),
    `${journaled} ${afterLoss.status} ${JSON.stringify(leftover)}`);
}

{
  // SU9. `refreshing` is THIS run's decision, not the inspection's stored-answer view. The case that tells
  // them apart: a removal Claude refused (directory, receipt and Claude's entries all stay, the decline is
  // stored), then an explicit yes on a newer build. The inspection says `declined`; the run says this is a
  // refresh of a mod that is in Claude. When Claude then refuses the refresh, a run that thought it was a
  // first install would take the mod out of Claude.
  const fixture = modFixture('su9-refreshing-from-run');
  await fixture.run();
  fixture.fake.refuse('uninstall');
  await cliSetup(fixture, [...YES, '--no-install-claude-mod']);
  ageCopy(fixture);
  fixture.fake.refuse('install');
  fixture.fake.reset();
  const yes = await cliSetup(fixture, [...YES, '--install-claude-mod']);
  check('SU9 an explicit yes over a refused decline is a refresh, so Claude refusing it leaves Claude alone',
    yes.exitCode === 0
      && yes.out.some((line) => line.startsWith('[plan] Refresh the cosyncing Claude mod at '))
      && yes.out.some((line) => line.startsWith('[claude-mod] failed operation=refresh'))
      && !fixture.fake.calls().some((call) => call.startsWith('plugin uninstall'))
      && inspectClaudeModSettings(fixture.settingsPath, fixture.marketplaceDir).status === 'enabled',
    `${yes.out.filter((line) => line.startsWith('[plan]') || line.startsWith('[claude-mod]')).join(' / ')} | ${fixture.fake.calls().join(' | ')}`);
}

{
  // SU10. Doctor says nothing about what was never there, and its advice works.
  const unsupported: ClaudeModSupport = {
    supported: false, skipReason: 'missing-cli', minimumVersion: CLAUDE_MOD_MIN_VERSION,
  };
  const committed = modFixture('su10-committed-no-claude', '2.1.90');
  const setup = await committed.run();
  check('SU10 a committed host that cannot run the mod and has nothing on disk gets no doctor line',
    setup.status === 'complete' && inspectInstallState(committed.home).committed
      && claudeModChecks(committed.home, committed.context, BUILD_INFO.version, unsupported).length === 0,
    claudeModChecks(committed.home, committed.context, BUILD_INFO.version, unsupported).map((c) => c.detailCode).join(','));
  check('SU10 a committed install that was never asked about the mod is not told it requested one',
    readSetupState(committed.home).claudeModRequested === undefined
      && claudeModChecks(committed.home, committed.context, BUILD_INFO.version, SUPPORTED).length === 0,
    claudeModChecks(committed.home, committed.context, BUILD_INFO.version, SUPPORTED).map((c) => c.detailCode).join(','));
  const removed = modFixture('su10-removed');
  await removed.run();
  removed.fake.forgetInsideClaude({ keepMarketplace: true });
  const line = claudeModChecks(removed.home, removed.context, BUILD_INFO.version, SUPPORTED)
    .find((c) => c.detailCode === 'claude-mod-removed-in-claude');
  const advice = line?.remediation?.message ?? '';
  check('SU10 the removed-in-claude advice names the command that puts it back, in English and Chinese',
    advice.includes('`cosyncing setup --install-claude-mod`') && advice.includes('`cosyncing setup --no-install-claude-mod`')
      && (translateDoctorTextToChinese(advice) ?? '').includes('cosyncing setup --install-claude-mod'),
    advice);
  // The advice is followed, through the real CLI.
  const followed = await cliSetup(removed, ['--yes', '--accept-managed-runtime-ownership', '--install-claude-mod']);
  check('SU10 following that advice reinstalls the mod',
    followed.exitCode === 0 && inspectClaudeModSettings(removed.settingsPath, removed.marketplaceDir).status === 'enabled');
  const refusedOnce = modFixture('su10-outcome');
  refusedOnce.fake.refuse('install');
  await refusedOnce.run();
  const outcomeLines = claudeModChecks(refusedOnce.home, refusedOnce.context, BUILD_INFO.version, SUPPORTED);
  const outcomeLine = outcomeLines.find((c) => c.id === 'state.claude-mod.last-outcome');
  check('SU10 doctor repeats an unfinished mod step with the commands that finish it',
    outcomeLine?.status === 'warn' && outcomeLine.detailCode === 'claude-mod-install-refused'
      && String((outcomeLine.evidence as Record<string, unknown>).commands).includes('cosyncing setup --install-claude-mod')
      && translateDoctorTextToChinese(outcomeLine.summary) !== undefined,
    outcomeLines.map((c) => c.detailCode).join(','));
}

{
  // SU11. Through the real CLI: an unreadable managed policy and an install-time policy refusal are both
  // stated skips on a setup that completes.
  const fixture = modFixture('su11-policy');
  const policyRoot = join(fixture.userHome, 'managed-policy');
  mkdirSync(policyRoot, { recursive: true });
  writeFileSync(join(policyRoot, 'managed-settings.json'), '{ not json');
  const unreadable = await cliSetup(fixture, YES, { policyRoots: [policyRoot] });
  check('SU11 an unparseable managed-settings file is a stated skip, and setup completes',
    unreadable.exitCode === 0 && !existsSync(fixture.marketplaceDir) && fixture.fake.calls().length === 0
      && unreadable.out.some((line) => line.startsWith('[claude-mod] skipped:managed-settings-unreadable')),
    unreadable.out.filter((line) => line.startsWith('[claude-mod]')).join(' / '));
  writeFileSync(join(policyRoot, 'managed-settings.json'), JSON.stringify({ disableSideloadFlags: false }));
  fixture.fake.refuse('add', 'policy_blocked');
  const refusedAtInstall = await cliSetup(fixture, YES, { policyRoots: [policyRoot] });
  check('SU11 disableSideloadFlags:false does not skip, and an install-time policy_blocked is a reported skip',
    refusedAtInstall.exitCode === 0 && !existsSync(fixture.marketplaceDir) && !hasReceipt(fixture.home)
      && refusedAtInstall.out.some((line) => line === '[claude-mod] failed operation=install code=claude-mod-install-refused claude=policy_blocked'),
    refusedAtInstall.out.filter((line) => line.startsWith('[claude-mod]') || line.startsWith('[complete]')).join(' / '));
}

{
  // SU12. Uninstall against a Claude that ran but did not answer: the directory stays under its receipt,
  // the leftovers are named with commands, and Chinese output carries them too.
  const fixture = modFixture('su12-uninstall-timeout');
  await fixture.run();
  fixture.fake.hang('uninstall');
  const options = {
    buildInfo: BUILD_INFO,
    executablePath: join(fixture.userHome, 'bin', 'cosyncing'),
    home: fixture.home,
    cacheRoot: join(fixture.userHome, '.cache', 'cosyncing'),
    context: fixture.context,
    claudeSettingsPath: fixture.settingsPath,
    runClaudeMod: defaultClaudeModCommandRunner(fixture.fake.bin, fixture.context.env, 400),
    codexDaemonProbe,
    purgeData: false,
  };
  const result = await runUninstall({
    ...options, confirmed: true, allowLegacyIntegrations: true, purgeData: false, purgeConfirmed: false,
  });
  check('SU12 an uninstall whose claude times out keeps the directory and receipt and names the leftovers',
    result.status === 'cleanup-required' && copyAt(fixture, BUILD_INFO.version).status === 'owned'
      && hasReceipt(fixture.home)
      && result.claudeModLeftovers?.detailCode === 'claude-mod-uninstall-timeout'
      && (result.claudeModLeftovers?.commands ?? []).some((command) => command.includes('claude plugin uninstall cosyncing-claude@cosyncing'))
      && (result.claudeModLeftovers?.commands ?? []).some((command) => command.startsWith('rm -r ')),
    `${result.status} ${JSON.stringify(result.claudeModLeftovers)}`);
  check('SU12 the timed-out uninstall left no claude process behind',
    await waitFor(() => processGone(fixture.fake.hangingPid()), 5_000));
  const chinese = renderUninstallResult(result, { purgeData: false, acquisitionPackagePreserved: false }, 'zh-Hans');
  check('SU12 the Chinese uninstall output carries the leftovers and their commands',
    chinese.includes('仍需手动处理') && chinese.includes('claude plugin uninstall cosyncing-claude@cosyncing'),
    chinese);

  const garbled = modFixture('su12-uninstall-garbled');
  await garbled.run();
  garbled.fake.garble('uninstall');
  const prose = await runUninstall({
    ...options,
    home: garbled.home,
    executablePath: join(garbled.userHome, 'bin', 'cosyncing'),
    cacheRoot: join(garbled.userHome, '.cache', 'cosyncing'),
    context: garbled.context,
    claudeSettingsPath: garbled.settingsPath,
    runClaudeMod: defaultClaudeModCommandRunner(garbled.fake.bin, garbled.context.env),
    confirmed: true, allowLegacyIntegrations: true, purgeConfirmed: false,
  });
  check('SU12 an uninstall whose claude prints no JSON is leftovers, not "no CLI": the directory stays',
    prose.status === 'cleanup-required' && existsSync(garbled.marketplaceDir)
      && prose.claudeModLeftovers?.detailCode === 'claude-mod-uninstall-unparseable',
    `${prose.status} ${JSON.stringify(prose.claudeModLeftovers)}`);

  // A relative CLAUDE_CONFIG_DIR: setup refuses it by name, and uninstall does not run Claude against it.
  const relative = modFixture('su12-relative-config');
  await relative.run();
  const relativeContext: SetupDiagnosisContext = {
    ...relative.context,
    env: { ...relative.context.env, CLAUDE_CONFIG_DIR: 'claude-config' },
  };
  relative.fake.reset();
  const relativeSetup = await cliSetup(relative, YES, { context: relativeContext });
  check('SU12 setup with a relative CLAUDE_CONFIG_DIR states the skip and runs no Claude command',
    relativeSetup.exitCode === 0 && relative.fake.calls().length === 0
      && relativeSetup.out.some((line) => line.startsWith('[claude-mod] skipped:config-dir-relative')),
    relativeSetup.out.filter((line) => line.startsWith('[claude-mod]')).join(' / '));
  const relativeUninstall = await runUninstall({
    ...options,
    home: relative.home,
    executablePath: join(relative.userHome, 'bin', 'cosyncing'),
    cacheRoot: join(relative.userHome, '.cache', 'cosyncing'),
    context: relativeContext,
    claudeSettingsPath: relative.settingsPath,
    runClaudeMod: defaultClaudeModCommandRunner(relative.fake.bin, relativeContext.env),
    confirmed: true, allowLegacyIntegrations: true, purgeConfirmed: false,
  });
  check('SU12 uninstall with a relative CLAUDE_CONFIG_DIR takes cosyncing\'s side back and names Claude\'s',
    relativeUninstall.status === 'complete' && !existsSync(relative.marketplaceDir) && relative.fake.calls().length === 0
      && relativeUninstall.claudeModLeftovers?.detailCode === 'claude-mod-uninstall-config-dir-relative',
    `${relativeUninstall.status} ${JSON.stringify(relativeUninstall.claudeModLeftovers)}`);
}

{
  // MB7, end to end: the copy setup installed carries this state home's socket.
  const fixture = modFixture('mb7-installed-stamp');
  await fixture.run();
  const installed = readFileSync(join(fixture.marketplaceDir, 'cosyncing-claude/hooks/register.js'), 'utf8');
  check('MB7 the installed register.js carries the socket under this installation\'s state home',
    installed.includes(`const STAMPED_SOCKET_PATH = ${JSON.stringify(join(fixture.home, 'claude-mod.sock'))};`),
    installed.split('\n').find((text) => text.includes('STAMPED_SOCKET_PATH =')) ?? 'none');

  // The mod's order: an absolute override, then the stamp, then COSYNCING_HOME, then ~/.cosyncing. A
  // relative override is refused outright; it does not fall through to the (usually production) stamp.
  const sources = { stamped: '/srv/stamped/claude-mod.sock', cosyncingHome: '/srv/moved', home: '/srv/op-home' };
  check('MB7 the mod resolves the socket in the settled order, and refuses a relative override',
    resolveSocketPath({ ...sources, override: '/tmp/review/claude-mod.sock' }) === '/tmp/review/claude-mod.sock'
      && resolveSocketPath({ ...sources, override: 'relative.sock' }) === ''
      && resolveSocketPath(sources) === '/srv/stamped/claude-mod.sock'
      && resolveSocketPath({ ...sources, stamped: '' }) === '/srv/moved/claude-mod.sock'
      && resolveSocketPath({ ...sources, stamped: '', cosyncingHome: '' }) === '/srv/op-home/.cosyncing/claude-mod.sock',
    resolveSocketPath({ ...sources, override: 'relative.sock' }));
  // And the broker refuses to bind the same relative override, so the two sides cannot disagree.
  const previous = process.env.COSYNCING_CLAUDE_SOCK;
  process.env.COSYNCING_CLAUDE_SOCK = 'relative.sock';
  let bindRefusal = '';
  try {
    const registry = new ModRegistry({ startTime: () => 'start', liveness: () => ({ alive: true, identityKnown: true }) });
    const server = new ModSocketServer({
      socketPath: modSocketPath(fixture.home),
      registry,
      holds: new ModHoldStore({ registry, audit: new ModAuditStore(), gate: () => ({ mode: 'default', viewers: 1, killSwitch: false }) }),
      killSwitch: () => false,
      log: { warn: () => {} },
    });
    await server.start();
    server.close();
  } catch (error) {
    bindRefusal = error instanceof Error ? error.message : 'unknown';
  } finally {
    if (previous === undefined) delete process.env.COSYNCING_CLAUDE_SOCK; else process.env.COSYNCING_CLAUDE_SOCK = previous;
  }
  check('MB7 the broker refuses to bind a relative COSYNCING_CLAUDE_SOCK',
    bindRefusal.includes('must be absolute') && !existsSync(join(fixture.home, 'relative.sock')),
    bindRefusal);
}

// ---------------------------------------------------------------------------
// 12. The agent preflight's Claude row, as the wizard prints it
// ---------------------------------------------------------------------------
// The row used to say that setup never edits Claude settings, which stopped being true when setup began
// to offer the mod. Its replacement has to be true on a host that is offered the mod AND on native
// Windows, which never is. So both hosts are inspected for real, with the same mod-capable Claude, and
// the row is read from the presenter in both wizard languages: the panel function, the interactive
// clack panel that draws it, and the English record the summary carries for machine-readable output.
{
  const expectedRow: Record<SetupLanguage, string> = {
    en: 'Observe plus Take over, and true sync through the optional cosyncing Claude mod, which setup '
      + 'offers where supported and installs only with consent.',
    'zh-Hans': '支持「观察 + 接管」，并可通过 cosyncing 的可选 Claude mod 实现真同步；'
      + '安装过程仅在受支持的环境中提供这个 mod，并且须经你同意才会安装。',
  };
  const stale = ['never edits Claude settings', 'Observe + Take over only', '不会改动 Claude 的配置', '只有「观察 + 接管」两种模式'];
  // The same squash the setup suite uses on clack output: its note box wraps long lines, so borders,
  // ANSI codes and all whitespace go from both sides before comparing.
  const squash = (text: string): string => plainTerminalText(text).replace(/[─-╿■-◿\s]/g, '');
  /** The sentence printed under the Claude Code line, exactly as `agentPreflightLines` renders it. */
  const claudeRow = (preflight: string): string | undefined => {
    const lines = preflight.split('\n');
    const at = lines.findIndex((line) => /^[✓○!] Claude Code\b/.test(line));
    return at < 0 ? undefined : lines[at + 1]?.trim();
  };
  const clackPanel = async (inspection: SetupInspection, language: SetupLanguage): Promise<string> => {
    const previous = process.env.COSYNCING_SETUP_LANG;
    const originalWrite = process.stdout.write.bind(process.stdout);
    let captured = '';
    // The env language is how the real presenter skips its first prompt; nothing else is answered.
    process.env.COSYNCING_SETUP_LANG = language;
    try {
      const clack = createClackSetupPresenter();
      await clack.chooseLanguage(inspection);
      process.stdout.write = ((chunk: unknown) => {
        captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
        return true;
      }) as typeof process.stdout.write;
      clack.intro(inspection);
    } finally {
      process.stdout.write = originalWrite;
      if (previous === undefined) delete process.env.COSYNCING_SETUP_LANG; else process.env.COSYNCING_SETUP_LANG = previous;
    }
    return captured;
  };

  const linux = modFixture('preflight-row-linux');
  // Native Windows with the same Claude. A `#!/bin/sh` fake is not runnable on Windows, so its resolution
  // and version are injected, the way the setup suite's unsupported-Claude case does it; what is exercised
  // is the host verdict and the row, not how a host executes a file.
  const windowsFake = fakeClaude('preflight-row-win32', '2.1.289');
  const windowsUserHome = join(root, 'case-preflight-row-win32', 'user-home');
  mkdirSync(windowsUserHome, { recursive: true });
  const windowsContext: SetupDiagnosisContext = {
    ...createSetupDiagnosisContext({
      homeDir: windowsUserHome,
      platform: 'win32',
      arch: 'x64',
      env: {
        HOME: windowsUserHome,
        USERPROFILE: windowsUserHome,
        PATH: windowsFake.binDir,
        COSYNCING_HOME: join(windowsUserHome, '.cosyncing'),
        COSYNCING_CACHE_DIR: join(windowsUserHome, '.cache', 'cosyncing'),
        CODEX_HOME: join(windowsUserHome, '.codex'),
        PI_CODING_AGENT_DIR: join(windowsUserHome, '.pi', 'agent'),
        COSYNCING_OMP_AGENT_DIR: join(windowsUserHome, '.omp', 'agent'),
        CLAUDE_CONFIG_DIR: windowsFake.configDir,
      },
    }),
    probeTcp: async () => 'closed' as const,
    fetchJson: async () => ({ status: 'unreachable' as const }),
    listenerProcess: async () => undefined,
    windowsMachineArchitecture: () => 'x64' as const,
    resolveExecutable: (command: string) => (command === 'claude' ? join(windowsFake.binDir, 'claude') : undefined),
    runReadOnly: async (executable: string) => (executable === join(windowsFake.binDir, 'claude')
      ? { status: 'ok' as const, exitCode: 0, stdout: '2.1.289 (Claude Code)\n', stderr: '' }
      : { status: 'unavailable' as const, stdout: '', stderr: 'not a fixture executable' }),
  };
  // No managed-policy roots: this host's own /etc/claude-code must not decide what the fixture is offered.
  const linuxInspection = await inspectSetupEnvironment({
    buildInfo: BUILD_INFO,
    executablePath: join(linux.userHome, 'bin', 'cosyncing'),
    home: linux.home,
    context: linux.context,
    claudePolicyRoots: [],
  });
  const windowsInspection = await inspectSetupEnvironment({
    buildInfo: BUILD_INFO,
    executablePath: join(windowsUserHome, 'bin', 'cosyncing'),
    home: join(windowsUserHome, '.cosyncing'),
    context: windowsContext,
    claudePolicyRoots: [],
  });
  const claudeOf = (inspection: SetupInspection) => inspection.agents.find((agent) => agent.id === 'claude');
  check('preflight row: a linux host with a mod-capable Claude is offered the mod',
    claudeOf(linuxInspection)?.state === 'supported' && linuxInspection.claudeMod.support.supported === true,
    JSON.stringify(linuxInspection.claudeMod.support));
  check('preflight row: native Windows with the same Claude is not offered the mod',
    claudeOf(windowsInspection)?.state === 'supported'
      && claudeOf(windowsInspection)?.installedVersion === '2.1.289'
      && windowsInspection.claudeMod.support.supported === false
      && windowsInspection.claudeMod.support.skipReason === 'native-windows',
    `${claudeOf(windowsInspection)?.state} ${JSON.stringify(windowsInspection.claudeMod.support)}`);
  const hosts = [
    { platform: 'linux', inspection: linuxInspection },
    { platform: 'win32', inspection: windowsInspection },
  ] as const;
  for (const { platform, inspection } of hosts) {
    for (const language of ['en', 'zh-Hans'] as const) {
      const preflight = agentPreflightLines(inspection.agents, language);
      const panel = squash(await clackPanel(inspection, language));
      const row = claudeRow(preflight);
      check(`the Claude preflight row names the optional mod setup installs only with consent (${platform}, ${language})`,
        row === expectedRow[language]
          && panel.includes(squash(expectedRow[language]))
          && !stale.some((phrase) => preflight.includes(phrase) || panel.includes(squash(phrase))),
        `${row ?? 'no Claude row'}`);
    }
    check(`the machine-readable Claude summary carries the same English row (${platform})`,
      claudeOf(inspection)?.managedBehavior === expectedRow.en,
      claudeOf(inspection)?.managedBehavior ?? 'no Claude summary');
  }
}

// Every case lives under this run's own temp root, fake CLIs and their state included.
rmSync(root, { recursive: true, force: true });

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} ${results.length - failed.length}/${results.length} claude-mod setup checks`);
for (const entry of failed) console.log(`  failed: ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`);
process.exit(failed.length === 0 ? 0 : 1);
