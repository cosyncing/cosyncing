#!/usr/bin/env bun
/**
 * Deterministic acceptance for the OpenCode terminal-attach shim: full install↔uninstall symmetry, rc-block
 * excision that preserves unrelated edits, and the KNOWN_INSTALL_RESOURCE_IDS invariant (every id the setup
 * catalog can emit has a matching uninstall handler). Self-contained temp-dir fixtures; no network/real host.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SetupDiagnosisContext } from '../../../adapter-api/src/index.ts';
import { BUILD_INFO } from '../../src/runtime/build-info.ts';
import { defaultBrokerConfig, writeBrokerConfig } from '../../src/runtime/configuration.ts';
import { ensureInstallationCredentials } from '../../src/security/credentials.ts';
import {
  inspectUninstall,
  runUninstall,
  type CodexDaemonStatus,
} from '../../src/installation/broker-lifecycle.ts';
import {
  committedInstallState,
  inspectInstallState,
  writeInstallState,
  type InstalledResourceRecord,
} from '../../src/installation/install-state.ts';
import { KNOWN_INSTALL_RESOURCE_IDS } from '../../src/installation/install-state.ts';
import { AGENT_SKILL_RESOURCE_IDS, agentSkillTargets } from '../../src/installation/agent-skill.ts';
import { TAILSCALE_SERVE_RESOURCE_ID } from '../../src/installation/tailscale-serve.ts';
import {
  OPENCODE_SHIM_BLOCK_BEGIN,
  OPENCODE_SHIM_RC_RESOURCE_IDS,
  OPENCODE_SHIM_RESOURCE_ID,
  OPENCODE_SHIM_SHA256,
  OPENCODE_SHIM_SOURCE,
  inspectRcBlock,
  installRcBlock,
  opencodeShimBlockLines,
  opencodeShimPort,
  opencodeShimRcCandidates,
  opencodeShimShellPath,
} from '../../../adapters/opencode/src/shim.ts';
import {
  createOpencodeShimSetupAction,
  createSetupActionCatalog,
  type SetupActionInputs,
} from '../../src/installation/setup-actions.ts';
import {
  inspectPiBridgeOwnership,
  piBridgeOwnershipPrecondition,
} from '../../src/installation/pi-bridge-ownership.ts';
import { atomicWriteOwnerOnly } from '../../src/security/secure-files.ts';
import { readSetupState, writeSetupState } from '../../src/installation/setup-state.ts';
import type { SetupTransactionContext } from '../../src/installation/setup-transaction.ts';

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const cleanup: string[] = [];

const BUILD = Object.freeze({
  schemaVersion: 2 as const,
  version: '1.0.0',
  commit: '1111111',
  buildDate: '2026-07-17T00:00:00.000Z',
  target: 'linux-x64',
  distribution: 'native' as const,
  packaged: true,
  dirty: false,
  schemaVersions: BUILD_INFO.schemaVersions,
  contract: BUILD_INFO.contract,
});

function contextFor(userHome: string): SetupDiagnosisContext {
  return {
    effects: 'forbidden',
    platform: 'linux',
    arch: 'x64',
    env: { HOME: userHome, PATH: '/usr/bin:/bin' },
    homeDir: userHome,
    resolveExecutable: () => undefined, // no tailscale/systemd/codex on this fixture host.
    inspectPath: (path) => ({ status: 'missing', readable: false, displayPath: path }),
    readText: () => ({ ok: false, reason: 'missing' }),
    readPackageVersion: () => undefined,
    async runReadOnly() { return { status: 'ok', exitCode: 0, stdout: '{}', stderr: '' }; },
    async fetchJson() { return { status: 'unreachable' }; },
    async probeTcp() { return 'closed'; },
    displayPath: (path) => path,
  };
}

interface Machine {
  root: string;
  userHome: string;
  home: string;
  cache: string;
  binary: string;
  context: SetupDiagnosisContext;
}

function machine(): Machine {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-shim-'));
  const userHome = join(root, 'user');
  const home = join(userHome, '.cosyncing');
  const cache = join(userHome, '.cache', 'cosyncing');
  const config = defaultBrokerConfig();
  config.broker.machineLabel = 'fixture-machine';
  writeBrokerConfig(config, home);
  ensureInstallationCredentials({ home, internalUrl: config.broker.internalUrl });
  writeSetupState({
    managedRuntimeAcknowledgedAt: '2026-07-17T00:00:00.000Z',
    serviceChoice: 'foreground',
    opencodeShimRequested: true,
  }, home);
  writeInstallState(committedInstallState('2026-07-17T00:00:00.000Z'), home);
  cleanup.push(root);
  // These fixtures declare a packaged build, so the canonical installed binary must actually exist: the
  // setup catalog's `binary.install` action measures it, and the uninstall planner re-measures it.
  const binary = join(home, 'bin', 'cosyncing');
  atomicWriteOwnerOnly(binary, 'fixture-installed-binary', { mode: 0o700 });
  return { root, userHome, home, cache, binary, context: contextFor(userHome) };
}

function baseOptions(m: Machine) {
  return {
    home: m.home,
    cacheRoot: m.cache,
    buildInfo: BUILD,
    executablePath: m.binary,
    context: m.context,
    piAgentDir: join(m.userHome, '.pi', 'agent'),
    claudeSettingsPath: join(m.userHome, '.claude', 'settings.json'),
    codexDaemonProbe: async (): Promise<CodexDaemonStatus> => ({ binaryAvailable: false, running: false }),
  };
}

function pushResources(m: Machine, resources: readonly InstalledResourceRecord[]): void {
  const install = inspectInstallState(m.home);
  if (!install.committed) throw new Error('fixture install missing');
  install.state.resources.push(...resources);
  writeInstallState(install.state, m.home);
}

function actionInputsFor(m: Machine): SetupActionInputs {
  return {
    home: m.home,
    config: defaultBrokerConfig(),
    setupState: readSetupState(m.home),
    piAgentDir: join(m.userHome, '.pi', 'agent'),
    installPiBridge: false,
    agentSkillTargets: [],
    installAgentSkill: false,
    removeAgentSkillResourceIds: [],
    opencodeShimRcTargets: opencodeShimRcCandidates(m.context),
    installOpencodeShim: true,
    installMetadata: {
      version: BUILD.version,
      packaged: true,
      executablePath: m.binary,
      serviceChoice: 'foreground',
      systemdLingeringRequested: false,
      tailscaleServeRequested: false,
    },
  };
}

/** (shimPath, port) for building/inspecting the canonical rc block against this machine's resolved values. */
function shimArgs(m: Machine): [string, number] {
  return [opencodeShimShellPath(m.home), opencodeShimPort(m.context.env.OPENCODE_URL)];
}

/** Realistic inputs that enable every catalog-installed integration, so the catalog emits its full id set. */
function fullActionInputsFor(m: Machine): SetupActionInputs {
  const inputs = actionInputsFor(m);
  const piBridge = inspectPiBridgeOwnership(inspectInstallState(m.home), inputs.piAgentDir);
  return {
    ...inputs,
    installPiBridge: true,
    piBridgePrecondition: piBridgeOwnershipPrecondition(piBridge),
    agentSkillTargets: agentSkillTargets(m.context),
    installAgentSkill: true,
    installMetadata: {
      version: BUILD.version,
      packaged: true,
      executablePath: m.binary,
      aliasPath: join(m.home, 'bin', 'cosync'),
      serviceChoice: 'foreground',
      systemdLingeringRequested: false,
      tailscaleServeRequested: false,
    },
  };
}

/** apply() ignores its context; a structurally-valid stub keeps the call type-safe. */
function fakeTxContext(m: Machine): SetupTransactionContext {
  return {
    home: m.home,
    transactionDirectory: m.home,
    plan: { schemaVersion: 1, id: 'fixture', preconditionHash: '0'.repeat(64), actions: [] },
  };
}

try {
  // 1. FULL-catalog install↔uninstall symmetry (not just the shim fixture). Build the whole setup action
  //    catalog with realistic inputs that enable every integration, run every action's apply(), fold the
  //    receipts into the committed install-state, and assert: (a) every emitted id is a member of
  //    KNOWN_INSTALL_RESOURCE_IDS, and (b) the uninstall PLANNER never drops any emitted id into the unknown
  //    `resource-<id>-preserved` catch-all — i.e. each has a real (id or kind) handler branch.
  {
    const m = machine();
    const userHome = m.userHome;
    const bashrc = join(userHome, '.bashrc');
    const zshrc = join(userHome, '.zshrc');
    writeFileSync(bashrc, 'export EDITOR=vim\n', { mode: 0o644 });
    writeFileSync(zshrc, '# zsh\nsetopt AUTO_CD\n', { mode: 0o644 });

    const catalog = createSetupActionCatalog(fullActionInputsFor(m));
    const emittedResources: InstalledResourceRecord[] = [];
    for (const action of catalog.actions) {
      const outcome = await action.apply(fakeTxContext(m));
      emittedResources.push(...(outcome?.resources ?? []));
    }
    // The commit action folds receiptResources (broker-binary / broker-alias) plus the collected resources
    // into the committed install-state — the complete set of ids the catalog can emit for these inputs.
    await catalog.commitAction.apply(fakeTxContext(m), emittedResources);
    const committed = inspectInstallState(m.home);
    if (!committed.committed) throw new Error('fixture commit failed');
    const emittedIds = [...new Set(committed.state.resources.map((resource) => resource.id))];

    check('every setup-catalog-emitted resource id is a member of KNOWN_INSTALL_RESOURCE_IDS',
      emittedIds.length > 0 && emittedIds.every((id) => KNOWN_INSTALL_RESOURCE_IDS.has(id)),
      emittedIds.join(','));
    check('catalog emits the expected binary/alias, pi-bridge, agent-skill, and opencode-shim ids',
      emittedIds.includes('broker-binary') && emittedIds.includes('broker-alias')
        && emittedIds.includes('pi-bridge')
        && Object.values(AGENT_SKILL_RESOURCE_IDS).every((id) => emittedIds.includes(id))
        && emittedIds.includes(OPENCODE_SHIM_RESOURCE_ID)
        && emittedIds.includes(OPENCODE_SHIM_RC_RESOURCE_IDS.bash)
        && emittedIds.includes(OPENCODE_SHIM_RC_RESOURCE_IDS.zsh),
      emittedIds.join(','));

    const plan = await inspectUninstall({ ...baseOptions(m), purgeData: false });
    const unhandled = emittedIds.filter((id) => plan.warnings.some((warning) => warning.detailCode === `resource-${id}-preserved`));
    check('the uninstall planner routes every emitted id to a real handler (never the unknown catch-all)',
      unhandled.length === 0, `unhandled=${unhandled.join(',')}`);

    // The known-id constant set still covers every resource-id constant the codebase declares.
    const knownConstants = [
      'broker-binary', 'broker-binary-previous', 'broker-alias',
      'service-systemd', 'service-environment', 'service-systemd-linger',
      'pi-bridge', TAILSCALE_SERVE_RESOURCE_ID,
      ...Object.values(AGENT_SKILL_RESOURCE_IDS),
      OPENCODE_SHIM_RESOURCE_ID, ...Object.values(OPENCODE_SHIM_RC_RESOURCE_IDS),
    ];
    check('KNOWN_INSTALL_RESOURCE_IDS covers every known resource id constant',
      knownConstants.every((id) => KNOWN_INSTALL_RESOURCE_IDS.has(id)));
    // The shim action really installed R1 + R2 into both existing rc files, preserving unrelated content.
    check('shim install writes the hash-owned script and a managed block in both existing rc files',
      existsSync(opencodeShimShellPath(m.home))
        && inspectRcBlock(readFileSync(bashrc, 'utf8'), ...shimArgs(m)) === 'owned'
        && inspectRcBlock(readFileSync(zshrc, 'utf8'), ...shimArgs(m)) === 'owned'
        && readFileSync(bashrc, 'utf8').includes('export EDITOR=vim')
        && readFileSync(zshrc, 'utf8').includes('setopt AUTO_CD'));
  }

  // 1b. Owned-stale upgrade / removal (Codex finding 2): a shim script that DIFFERS from this package but which
  //     a receipt proves WE installed (installedSha256 == the on-disk hash, i.e. a previous package version) is
  //     a safe in-place upgrade AND still removes cleanly on uninstall — while a user edit (no matching receipt)
  //     is always preserved.
  {
    const m = machine();
    const shimPath = opencodeShimShellPath(m.home);
    mkdirSync(join(shimPath, '..'), { recursive: true });
    const previous = `${OPENCODE_SHIM_SOURCE}\n# older build marker\n`;
    const previousSha = createHash('sha256').update(previous).digest('hex');

    // (a) upgrade: with the owned-stale flag set, apply overwrites a drifted-but-ours script with the current source.
    writeFileSync(shimPath, previous, { mode: 0o600 });
    const upgrade = createOpencodeShimSetupAction({ ...actionInputsFor(m), opencodeShimStaleUpgrade: true });
    await upgrade.apply(fakeTxContext(m));
    const upgradeVerified = await upgrade.verify(fakeTxContext(m));
    check('owned-stale upgrade: apply rewrites a previous-version shim to the current package source',
      readFileSync(shimPath, 'utf8') === OPENCODE_SHIM_SOURCE && upgradeVerified && previousSha !== OPENCODE_SHIM_SHA256);

    // (b) preserve: a user-edited script (no owned-stale proof) is never overwritten.
    writeFileSync(shimPath, '# hand-edited by the user\n', { mode: 0o600 });
    const noUpgrade = createOpencodeShimSetupAction({ ...actionInputsFor(m), opencodeShimStaleUpgrade: false });
    let preserved = false;
    try { await noUpgrade.apply(fakeTxContext(m)); } catch { preserved = true; }
    check('drifted-without-proof: apply refuses to overwrite a user-edited shim (preserved)',
      preserved && readFileSync(shimPath, 'utf8') === '# hand-edited by the user\n');

    // (c) uninstall removes a receipt-proven PREVIOUS version (receipt hash == on-disk hash, != current package).
    writeFileSync(shimPath, previous, { mode: 0o600 });
    pushResources(m, [{ id: OPENCODE_SHIM_RESOURCE_ID, kind: 'path-entry', target: shimPath, ownership: { proof: 'package-hash', installedSha256: previousSha } }]);
    const plan = await inspectUninstall({ ...baseOptions(m), purgeData: false });
    check('uninstall plans removal of a receipt-proven previous-version shim (not preserved)',
      !plan.warnings.some((w) => w.detailCode === 'opencode-shim-preserved'));
    await runUninstall({ ...baseOptions(m), confirmed: true, allowLegacyIntegrations: false, purgeData: false, purgeConfirmed: false });
    check('uninstall removes the receipt-proven previous-version shim file', !existsSync(shimPath));
  }

  // 1c. R2 owned-stale re-canonicalization (Codex finding 5): a managed block that drifted (a different pinned
  //     port/host, or the older format) is recognized as owned-stale — our markers + our source line for THIS
  //     shim path + only our managed set-if-unset lines — so it re-canonicalizes in place on install and still
  //     excises on uninstall (preserving unrelated content). A user edit inside the markers stays foreign.
  {
    const m = machine();
    const bashrc = join(m.userHome, '.bashrc');
    const [shimPath, port] = shimArgs(m);

    // A pre-existing block with our markers + our source line but a STALE pinned port (9999 != resolved 4096).
    const drifted = `# pre-existing user config\n${opencodeShimBlockLines(shimPath, 9999).join('\n')}\n`;
    writeFileSync(bashrc, drifted, { mode: 0o644 });
    check('R2 drift is recognized as owned-stale, not foreign',
      inspectRcBlock(readFileSync(bashrc, 'utf8'), shimPath, port) === 'owned-stale');

    // A user edit (a foreign line injected inside the markers) is NOT owned-stale — it stays foreign.
    const tampered = [...opencodeShimBlockLines(shimPath, port)];
    tampered.splice(1, 0, 'echo pwned');
    check('R2 user-edited block (foreign line inside markers) stays foreign',
      inspectRcBlock(tampered.join('\n'), shimPath, port) === 'foreign');

    // apply re-canonicalizes the owned-stale block in place to the current port/host, preserving unrelated content.
    mkdirSync(join(shimPath, '..'), { recursive: true });
    writeFileSync(shimPath, OPENCODE_SHIM_SOURCE, { mode: 0o600 });
    await createOpencodeShimSetupAction({ ...actionInputsFor(m) }).apply(fakeTxContext(m));
    check('R2 owned-stale re-canonicalizes to the current block on install (unrelated content preserved)',
      inspectRcBlock(readFileSync(bashrc, 'utf8'), shimPath, port) === 'owned'
        && readFileSync(bashrc, 'utf8').includes('# pre-existing user config'));

    // uninstall excises the (now owned) managed block, leaving unrelated content.
    pushResources(m, [
      { id: OPENCODE_SHIM_RESOURCE_ID, kind: 'path-entry', target: shimPath, ownership: { proof: 'package-hash', installedSha256: OPENCODE_SHIM_SHA256 } },
      { id: OPENCODE_SHIM_RC_RESOURCE_IDS.bash, kind: 'shell-init-block', target: bashrc, ownership: { proof: 'receipt', marker: OPENCODE_SHIM_BLOCK_BEGIN } },
    ]);
    await runUninstall({ ...baseOptions(m), confirmed: true, allowLegacyIntegrations: false, purgeData: false, purgeConfirmed: false });
    check('R2 uninstall excises the managed block, preserving unrelated content',
      !readFileSync(bashrc, 'utf8').includes(OPENCODE_SHIM_BLOCK_BEGIN)
        && readFileSync(bashrc, 'utf8').includes('# pre-existing user config'));
  }

  // 2. install -> uninstall round-trip: after a confirmed uninstall the shim script is gone, BOTH rc blocks are
  //    excised, and the pre-existing unrelated content is byte-preserved. Clean removal exits 0.
  {
    const m = machine();
    const bashrc = join(m.userHome, '.bashrc');
    const zshrc = join(m.userHome, '.zshrc');
    const bashOriginal = 'export EDITOR=vim\nalias gs="git status"\n';
    const zshOriginal = '# zshrc\nHISTSIZE=10000\n';
    writeFileSync(bashrc, bashOriginal, { mode: 0o644 });
    writeFileSync(zshrc, zshOriginal, { mode: 0o644 });
    const catalog = createSetupActionCatalog(actionInputsFor(m));
    const shimAction = catalog.actions.find((action) => action.id === 'opencode-shim.reconcile')!;
    const outcome = await shimAction.apply(fakeTxContext(m));
    pushResources(m, outcome?.resources ?? []);
    const shimPath = opencodeShimShellPath(m.home);
    const installedOk = existsSync(shimPath)
      && inspectRcBlock(readFileSync(bashrc, 'utf8'), ...shimArgs(m)) === 'owned'
      && inspectRcBlock(readFileSync(zshrc, 'utf8'), ...shimArgs(m)) === 'owned';

    const uninstalled = await runUninstall({
      ...baseOptions(m), confirmed: true, allowLegacyIntegrations: false,
      purgeData: false, purgeConfirmed: false,
    });
    check('install then confirmed uninstall removes the shim script and both rc blocks, exit 0',
      installedOk && uninstalled.exitCode === 0
        && !existsSync(shimPath)
        && readFileSync(bashrc, 'utf8') === bashOriginal
        && readFileSync(zshrc, 'utf8') === zshOriginal,
      `${uninstalled.exitCode}/${uninstalled.detailCode}`);
    check('round-trip clears the committed install gate for the shim resources',
      !inspectInstallState(m.home).committed);
  }

  // 3a. Drift: the user edits inside the managed block. Uninstall preserves the block (never excises a modified
  //     region) and leaves unrelated content untouched; the receipt is retained as an honest remaining resource.
  {
    const m = machine();
    const bashrc = join(m.userHome, '.bashrc');
    const original = 'export EDITOR=vim\n';
    const installed = installRcBlock(original, ...shimArgs(m));
    // Insert a stray line inside the block, keeping exactly one BEGIN/END pair — the region drifts from the
    // canonical block, so inspectRcBlock classifies it foreign (preserved, never excised).
    const edited = installed.replace(OPENCODE_SHIM_BLOCK_BEGIN, `${OPENCODE_SHIM_BLOCK_BEGIN}\n# user tweak`);
    writeFileSync(bashrc, edited, { mode: 0o644 });
    pushResources(m, [{
      id: OPENCODE_SHIM_RC_RESOURCE_IDS.bash, kind: 'shell-init-block', target: bashrc,
      ownership: { proof: 'receipt', marker: OPENCODE_SHIM_BLOCK_BEGIN },
    }]);
    const uninstalled = await runUninstall({
      ...baseOptions(m), confirmed: true, allowLegacyIntegrations: false,
      purgeData: false, purgeConfirmed: false,
    });
    check('3a edited-in-block: uninstall preserves the drifted block and unrelated content (cleanup-required)',
      uninstalled.exitCode === 4
        && readFileSync(bashrc, 'utf8') === edited
        && readFileSync(bashrc, 'utf8').includes('export EDITOR=vim')
        && (uninstalled.remaining?.includes('opencode-shim-rc-bash-preserved') ?? false),
      `${uninstalled.exitCode}/${uninstalled.detailCode}`);
  }

  // 3b. Drift: the user deletes the shim script. Its path-entry receipt is preserved (the file is already gone,
  //     but the recorded PATH mutation is retained as remaining evidence); no unrelated content is touched.
  {
    const m = machine();
    const shimPath = opencodeShimShellPath(m.home);
    const bashrc = join(m.userHome, '.bashrc');
    const bashOriginal = 'export EDITOR=vim\n';
    const installed = installRcBlock(bashOriginal, ...shimArgs(m));
    writeFileSync(bashrc, installed, { mode: 0o644 });
    // R1 receipt present, but the user deleted the script.
    pushResources(m, [
      { id: OPENCODE_SHIM_RESOURCE_ID, kind: 'path-entry', target: shimPath, ownership: { proof: 'package-hash', installedSha256: OPENCODE_SHIM_SHA256 } },
    ]);
    check('3b precondition: shim script is absent (user deleted it)', !existsSync(shimPath));
    const uninstalled = await runUninstall({
      ...baseOptions(m), confirmed: true, allowLegacyIntegrations: false,
      purgeData: false, purgeConfirmed: false,
    });
    check('3b deleted-shim: uninstall never recreates/leaves it, preserves the rc file, and completes safely',
      uninstalled.exitCode === 4
        && !existsSync(shimPath)
        && readFileSync(bashrc, 'utf8') === installed,
      `${uninstalled.exitCode}/${uninstalled.detailCode}`);
  }

  // 3c. Drift: the rc file is replaced by a symlink. Uninstall refuses the symlinked target, preserves the
  //     symlink and its outside content, and never follows the link to delete unrelated content.
  {
    const m = machine();
    const bashrc = join(m.userHome, '.bashrc');
    const outside = join(m.userHome, 'outside-rc');
    const outsideOriginal = 'export EDITOR=vim\n';
    writeFileSync(outside, outsideOriginal, { mode: 0o644 });
    symlinkSync(outside, bashrc);
    pushResources(m, [{
      id: OPENCODE_SHIM_RC_RESOURCE_IDS.bash, kind: 'shell-init-block', target: bashrc,
      ownership: { proof: 'receipt', marker: OPENCODE_SHIM_BLOCK_BEGIN },
    }]);
    const plan = await inspectUninstall({ ...baseOptions(m), purgeData: false });
    const uninstalled = await runUninstall({
      ...baseOptions(m), confirmed: true, allowLegacyIntegrations: false,
      purgeData: false, purgeConfirmed: false,
    });
    check('3c symlinked-rc: uninstall refuses the symlink, preserves it and its outside content, exit cleanup-required',
      uninstalled.exitCode === 4
        && lstatSync(bashrc).isSymbolicLink()
        && readFileSync(outside, 'utf8') === outsideOriginal
        && !plan.actions.some((action) => action.id.startsWith('shell-init-block.excise.')),
      `${uninstalled.exitCode}/${uninstalled.detailCode}`);
  }

  // The stand-alone action install/verify contract holds without the transaction harness.
  {
    const m = machine();
    writeFileSync(join(m.userHome, '.bashrc'), 'export EDITOR=vim\n', { mode: 0o644 });
    const action = createOpencodeShimSetupAction(actionInputsFor(m));
    await action.apply(fakeTxContext(m));
    check('opencode-shim action verify() passes after its own apply()', action.verify(fakeTxContext(m)) === true);
  }

  // 4. OUTSIDE-$HOME state home (custom COSYNCING_HOME): the shim script installs under a state home that is NOT
  //    a descendant of $HOME. install→uninstall must still CREATE then FULLY REMOVE the shim script and both rc
  //    blocks — the R1 dedicated id-based branch removes the script without the path-entry pathWithin($HOME)
  //    guard (which would otherwise strand a state home outside the user's home directory).
  {
    const root = mkdtempSync(join(tmpdir(), 'cosyncing-shim-outside-'));
    cleanup.push(root);
    const userHome = join(root, 'user');
    const outsideHome = join(root, 'state-outside-home'); // sibling of userHome — NOT under $HOME
    const cache = join(root, 'cache');
    const context = contextFor(userHome);
    const binary = join(outsideHome, 'bin', 'cosyncing');
    const isOutside = !`${outsideHome}/`.startsWith(`${userHome}/`) && outsideHome !== userHome;

    const config = defaultBrokerConfig();
    config.broker.machineLabel = 'fixture-outside';
    writeBrokerConfig(config, outsideHome);
    ensureInstallationCredentials({ home: outsideHome, internalUrl: config.broker.internalUrl });
    writeSetupState({
      managedRuntimeAcknowledgedAt: '2026-07-17T00:00:00.000Z',
      serviceChoice: 'foreground',
      opencodeShimRequested: true,
    }, outsideHome);
    writeInstallState(committedInstallState('2026-07-17T00:00:00.000Z'), outsideHome);

    mkdirSync(userHome, { recursive: true });
    const bashrc = join(userHome, '.bashrc');
    const zshrc = join(userHome, '.zshrc');
    const bashOriginal = 'export EDITOR=vim\nalias gs="git status"\n';
    const zshOriginal = '# zshrc\nHISTSIZE=10000\n';
    writeFileSync(bashrc, bashOriginal, { mode: 0o644 });
    writeFileSync(zshrc, zshOriginal, { mode: 0o644 });

    const shimPath = opencodeShimShellPath(outsideHome);
    const port = opencodeShimPort(context.env.OPENCODE_URL);
    const inputs: SetupActionInputs = {
      home: outsideHome,
      config: defaultBrokerConfig(),
      setupState: readSetupState(outsideHome),
      piAgentDir: join(userHome, '.pi', 'agent'),
      installPiBridge: false,
      agentSkillTargets: [],
      installAgentSkill: false,
      removeAgentSkillResourceIds: [],
      opencodeShimRcTargets: opencodeShimRcCandidates(context),
      installOpencodeShim: true,
      opencodeShimPort: port,
      installMetadata: {
        version: BUILD.version,
        packaged: true,
        executablePath: binary,
        serviceChoice: 'foreground',
        systemdLingeringRequested: false,
        tailscaleServeRequested: false,
      },
    };
    const txContext: SetupTransactionContext = {
      home: outsideHome,
      transactionDirectory: outsideHome,
      plan: { schemaVersion: 1, id: 'fixture', preconditionHash: '0'.repeat(64), actions: [] },
    };
    const outcome = await createOpencodeShimSetupAction(inputs).apply(txContext);
    const install = inspectInstallState(outsideHome);
    if (!install.committed) throw new Error('fixture install missing');
    install.state.resources.push(...(outcome?.resources ?? []));
    writeInstallState(install.state, outsideHome);

    const createdOk = isOutside
      && existsSync(shimPath)
      && inspectRcBlock(readFileSync(bashrc, 'utf8'), shimPath, port) === 'owned'
      && inspectRcBlock(readFileSync(zshrc, 'utf8'), shimPath, port) === 'owned';

    const uninstalled = await runUninstall({
      home: outsideHome,
      cacheRoot: cache,
      buildInfo: BUILD,
      executablePath: binary,
      context,
      piAgentDir: join(userHome, '.pi', 'agent'),
      claudeSettingsPath: join(userHome, '.claude', 'settings.json'),
      codexDaemonProbe: async (): Promise<CodexDaemonStatus> => ({ binaryAvailable: false, running: false }),
      confirmed: true,
      allowLegacyIntegrations: false,
      purgeData: false,
      purgeConfirmed: false,
    });

    check('4 outside-$HOME: install then uninstall fully removes the shim script + both rc blocks, exit 0',
      createdOk
        && uninstalled.exitCode === 0
        && !existsSync(shimPath)
        && readFileSync(bashrc, 'utf8') === bashOriginal
        && readFileSync(zshrc, 'utf8') === zshOriginal
        && !inspectInstallState(outsideHome).committed,
      `outside=${isOutside} ${uninstalled.exitCode}/${uninstalled.detailCode}`);
  }
} finally {
  for (const root of cleanup) rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length}/${results.length} opencode-shim symmetry checks failed.`);
  process.exit(1);
}
console.log(`\nPASS ${results.length}/${results.length} opencode-shim symmetry checks`);
