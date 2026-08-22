#!/usr/bin/env bun
/** Transactional setup acceptance: prompts, no-op rerun, rollback, recovery, and zero-agent setup. */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createSetupDiagnosisContext } from '../../src/installation/diagnosis-context.ts';
import { BUILD_INFO, buildFingerprint, type BuildInfo } from '../../src/runtime/build-info.ts';
import { defaultBrokerConfig, writeBrokerConfig } from '../../src/runtime/configuration.ts';
import {
  brokerTokenPath,
  inspectBrokerToken,
  inspectPiIntegration,
  readBrokerToken,
} from '../../src/security/credentials.ts';
import {
  durableStateLayout,
  planDurableStateMigrations,
} from '../../src/security/durable-state.ts';
import { inspectInstallState, writeInstallState } from '../../src/installation/install-state.ts';
import { LEGACY_TAILSCALE_RESOURCE_ID } from '../../src/installation/legacy-connectivity-migration.ts';
import { acquireInstallationLock } from '../../src/installation/installation-lock.ts';
import {
  atomicWriteOwnerOnly,
  ensureOwnerOnlyDirectory,
} from '../../src/security/secure-files.ts';
import { PRODUCT_IDENTITY } from '../../../protocol/src/product.ts';
import {
  SYSTEMD_SERVICE_NAME,
  type DurableServiceProvider,
  type DurableServiceStatus,
} from '../../src/installation/service-manager.ts';
import {
  createSetupActionCatalog,
  type SetupActionInputs,
} from '../../src/installation/setup-actions.ts';
import {
  buildSetupPlan,
  inspectSetupEnvironment,
  runSetup,
  SETUP_PROMPT_CANCELLED,
  tokdashProvisionCapability,
  type SetupAccessReport,
  type SetupBlockingIssue,
  type SetupCommandResult,
  type SetupInspection,
  type SetupPlan,
  type SetupPresenter,
  type SetupPromptResult,
  type SetupServiceChoice,
} from '../../src/installation/setup.ts';
import {
  agentPreflightLines,
  createClackSetupPresenter,
  createNonInteractiveSetupPresenter,
  type OpencodeShimSignal,
} from '../../src/installation/setup-presenter.ts';
import { CLAUDE_MINIMUM_VERSION } from '../../../adapters/claude/src/diagnostics.ts';
import {
  clearTokdashCompletion,
  clearTokdashOwnership,
  readSetupState,
  readTokdashCompletion,
  readTokdashOwnership,
  setTokdashOwnership,
  writeSetupState,
} from '../../src/installation/setup-state.ts';
import {
  reverseTokdashProvisioning,
  runTokdashCommand,
  tokdashSetupArgs,
  TOKDASH_OUTPUT_TAIL_CHARS,
  type TokdashOwnership,
} from '../../src/installation/tokdash-provision.ts';
import {
  resolveTokdashEndpoint,
  tokdashRejectionReason,
  TOKDASH_DEFAULT_BASE_URL,
} from '../../src/installation/tokdash-quota.ts';
import {
  normalizeSetupLanguage,
  setupMessages,
  type SetupLanguage,
  type SetupMutationStep,
} from '../../src/installation/setup-i18n.ts';
import {
  agentSkillTargets,
  AGENT_SKILL_SHA256,
  AGENT_SKILL_SOURCE,
} from '../../src/installation/agent-skill.ts';
import {
  PI_BRIDGE_EMBEDDED_SHA256,
  PI_BRIDGE_EMBEDDED_SOURCE,
} from '../../../adapters/pi/src/implementation.ts';
import {
  executeSetupTransaction,
  readSetupFailureDiagnostic,
  readSetupTransactionJournal,
  setupFailureDiagnosticPath,
  type SetupTransactionAction,
  type SetupTransactionPlan,
} from '../../src/installation/setup-transaction.ts';

function readFrozenTextFixture(path: string): string {
  const asset = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  if (asset.schemaVersion !== 1 || asset.release !== '0.1.0'
    || !Array.isArray(asset.lines) || !asset.lines.every((line) => typeof line === 'string')
    || typeof asset.trailingNewline !== 'boolean') throw new Error(`invalid frozen text fixture: ${path}`);
  return `${asset.lines.join('\n')}${asset.trailingNewline ? '\n' : ''}`;
}

// Migration inputs come from immutable released assets, not the production constants under test. This
// catches any future attempt to redefine a predecessor by editing the current bridge or skill.
const AGENT_SKILL_V010_FIXTURE = readFileSync(join(
  import.meta.dir,
  '../../skills/legacy/cosyncing-v0.1.0.md',
), 'utf8');
const PI_BRIDGE_V010_FIXTURE = readFrozenTextFixture(join(
  import.meta.dir,
  '../../../adapters/pi/assets/legacy/cosyncing-bridge-v0.1.0.json',
));

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

const FIXED_DATE = new Date('2026-07-17T12:00:00.000Z');
const now = (): Date => new Date(FIXED_DATE);

class ScriptedPresenter implements SetupPresenter {
  readonly calls: string[] = [];
  lastResult?: SetupCommandResult;
  lastBlockers?: SetupBlockingIssue[];

  constructor(readonly options: {
    cancelAt?: 'ack' | 'legacyPi' | 'skill' | 'legacySkill' | 'opencodeShim' | 'service' | 'quota' | 'confirm';
    managed?: boolean;
    service?: SetupServiceChoice;
    lingering?: boolean;
    quota?: boolean;
    apply?: boolean;
    skill?: boolean;
    opencodeShim?: boolean;
    language?: SetupLanguage;
    cancelLanguage?: boolean;
    legacyPi?: boolean;
    legacySkill?: boolean;
  } = {}) {}

  async chooseLanguage(): Promise<SetupPromptResult<SetupLanguage>> {
    this.calls.push('language');
    return this.options.cancelLanguage ? SETUP_PROMPT_CANCELLED : this.options.language ?? 'en';
  }
  intro(): void { this.calls.push('intro'); }
  showBlockers(issues: readonly SetupBlockingIssue[]): void {
    this.calls.push('blockers');
    this.lastBlockers = [...issues];
  }
  async confirmManagedRuntime(): Promise<SetupPromptResult<boolean>> {
    this.calls.push('ack');
    return this.options.cancelAt === 'ack' ? SETUP_PROMPT_CANCELLED : this.options.managed ?? true;
  }
  async confirmLegacyPiBridge(): Promise<SetupPromptResult<boolean>> {
    this.calls.push('legacy-pi');
    return this.options.cancelAt === 'legacyPi' ? SETUP_PROMPT_CANCELLED : this.options.legacyPi ?? false;
  }
  async confirmAgentSkill(): Promise<SetupPromptResult<boolean>> {
    this.calls.push('skill');
    return this.options.cancelAt === 'skill' ? SETUP_PROMPT_CANCELLED : this.options.skill ?? true;
  }
  async confirmLegacyAgentSkill(): Promise<SetupPromptResult<boolean>> {
    this.calls.push('legacy-skill');
    return this.options.cancelAt === 'legacySkill' ? SETUP_PROMPT_CANCELLED : this.options.legacySkill ?? false;
  }
  async confirmOpencodeShim(): Promise<SetupPromptResult<boolean>> {
    this.calls.push('opencode-shim');
    return this.options.cancelAt === 'opencodeShim' ? SETUP_PROMPT_CANCELLED : this.options.opencodeShim ?? true;
  }
  async chooseService(): Promise<SetupPromptResult<SetupServiceChoice>> {
    this.calls.push('service');
    return this.options.cancelAt === 'service' ? SETUP_PROMPT_CANCELLED : this.options.service ?? 'foreground';
  }
  async confirmQuotaWarnings(): Promise<SetupPromptResult<boolean>> {
    this.calls.push('quota');
    return this.options.cancelAt === 'quota' ? SETUP_PROMPT_CANCELLED : this.options.quota ?? false;
  }
  showPlan(): void { this.calls.push('plan'); }
  async confirmApply(): Promise<SetupPromptResult<boolean>> {
    this.calls.push('confirm');
    return this.options.cancelAt === 'confirm' ? SETUP_PROMPT_CANCELLED : this.options.apply ?? true;
  }
  recoveredInterruptedTransaction(): void { this.calls.push('recovered'); }
  complete(result: Readonly<SetupCommandResult>): void { this.calls.push('complete'); this.lastResult = { ...result }; }
  cancelled(stage: string): void { this.calls.push(`cancelled:${stage}`); }
  failed(result: Readonly<SetupCommandResult>): void { this.calls.push('failed'); this.lastResult = { ...result }; }
}

function contextFor(home: string, extraEnv: Record<string, string> = {}, platform = 'linux') {
  const context = createSetupDiagnosisContext({
    homeDir: home,
    platform,
    // The arch travels with the platform: a darwin fixture is an Apple Silicon Mac, which is the supported
    // macOS host. Reading it from the test host instead would judge every darwin fixture an Intel Mac.
    arch: platform === 'darwin' ? 'arm64' : 'x64',
    env: {
      HOME: home,
      PATH: '',
      COSYNCING_HOME: join(home, '.cosyncing'),
      COSYNCING_CACHE_DIR: join(home, '.cache', 'cosyncing'),
      CODEX_HOME: join(home, '.codex'),
      PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'),
      ...extraEnv,
    },
  });
  // Setup fixtures own their network topology. A developer's live broker on the
  // default port must not turn the zero-agent lane into an environment-dependent
  // failure; the occupied-port case below overrides these probes explicitly.
  return {
    ...context,
    probeTcp: async () => 'closed' as const,
    fetchJson: async () => ({ status: 'unreachable' as const }),
  };
}

function setupOptions(root: string, presenter: SetupPresenter, overrides: Record<string, unknown> = {}) {
  const home = join(root, '.cosyncing');
  return {
    buildInfo: BUILD_INFO,
    executablePath: join(root, 'bin', 'cosyncing'),
    home,
    context: contextFor(root),
    presenter,
    now,
    ...overrides,
  } as Parameters<typeof runSetup>[0];
}

function supportedPiFixture(machine: string): { context: ReturnType<typeof contextFor>; bridge: string } {
  const packageRoot = join(machine, 'pi-package');
  const piBin = join(packageRoot, 'pi');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@earendil-works/pi-coding-agent',
    version: '0.78.1',
  }));
  writeFileSync(piBin, `#!${process.execPath}\nconsole.log('Pi 0.78.1');\n`);
  chmodSync(piBin, 0o755);
  return {
    context: contextFor(machine, { PATH: packageRoot }),
    bridge: join(machine, '.pi', 'agent', 'extensions', 'cosyncing-bridge', 'index.ts'),
  };
}

function treeSnapshot(root: string): string {
  if (!existsSync(root)) return '<missing>';
  const rows: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const target = join(path, entry.name);
      const label = relative(root, target);
      if (entry.isDirectory()) {
        rows.push(`d:${label}:${statSync(target).mode & 0o777}`);
        walk(target);
      } else {
        rows.push(`f:${label}:${statSync(target).mode & 0o777}:${readFileSync(target, 'base64')}`);
      }
    }
  };
  walk(root);
  return rows.sort().join('\n');
}

async function zeroAgentSetup(root: string, presenter = new ScriptedPresenter()): Promise<SetupCommandResult> {
  return runSetup(setupOptions(root, presenter));
}

async function crashChild(home: string, marker: string): Promise<never> {
  const inputs: SetupActionInputs = {
    home,
    config: defaultBrokerConfig(),
    setupState: { schemaVersion: 1 },
    piAgentDir: join(home, 'pi-agent'),
    installPiBridge: false,
    agentSkillTargets: agentSkillTargets(contextFor(home)),
    installAgentSkill: true,
    removeAgentSkillResourceIds: [],
    installMetadata: {
      version: BUILD_INFO.version,
      packaged: false,
      executablePath: import.meta.path,
      serviceChoice: 'foreground',
      systemdLingeringRequested: false,
    },
    now,
  };
  const catalog = createSetupActionCatalog(inputs);
  const config = catalog.actions.find((action) => action.id === 'config.ensure')!;
  const hanging: SetupTransactionAction = {
    ...config,
    async apply(context) {
      await config.apply(context);
      writeFileSync(marker, 'ready');
      await Bun.sleep(60_000);
    },
  };
  const plan: SetupTransactionPlan = {
    schemaVersion: 1,
    id: 'setup-crash-fixture',
    preconditionHash: '0'.repeat(64),
    actions: [{ id: 'config.ensure', title: 'fixture', summary: 'fixture', reversible: true }],
  };
  const lock = acquireInstallationLock({ command: 'setup', home });
  try {
    await executeSetupTransaction({
      home,
      plan,
      actions: [hanging, ...catalog.actions.filter((action) => action.id !== hanging.id)],
      commitAction: catalog.commitAction,
      verifyAll: () => true,
      now,
    });
  } finally {
    lock.release();
  }
  throw new Error('crash child unexpectedly completed');
}

if (process.argv[2] === '--crash-child') {
  await crashChild(process.argv[3]!, process.argv[4]!);
}

const root = mkdtempSync(join(tmpdir(), 'cosyncing-transactional-setup-'));
try {
  // A darwin host completes foreground setup end-to-end. No launchd provider is supplied, so this is the
  // "durable service unavailable" path: it must commit foreground rather than block, and must never explain
  // itself with systemd wording that has no meaning on macOS.
  {
    const machine = join(root, 'darwin-foreground');
    mkdirSync(machine, { recursive: true });
    const presenter = new ScriptedPresenter();
    const setup = await runSetup(setupOptions(machine, presenter, {
      context: contextFor(machine, {}, 'darwin'),
    }));
    const home = join(machine, '.cosyncing');
    const state = readSetupState(home);
    check('darwin foreground setup completes end-to-end and commits its receipts',
      setup.status === 'complete' && setup.exitCode === 0
        && inspectInstallState(home).committed
        && state.serviceChoice === 'foreground'
        && inspectBrokerToken(join(home, 'secrets', 'broker-token')).status === 'ok',
      `${setup.status}: ${setup.summary} ${JSON.stringify(setup.issueCodes ?? [])}`);
    check('darwin setup never blocks on, or explains itself with, systemd wording',
      !JSON.stringify(setup).toLowerCase().includes('systemd')
        && presenter.calls.join(',') === 'language,intro,ack,skill,opencode-shim,service,quota,plan,confirm,complete',
      presenter.calls.join(','));
  }

  // A prior managed-connectivity receipt is relinquished as state only. Setup reports the retained target
  // and never adds a provider prompt or command to the transaction.
  {
    const machine = join(root, 'legacy-connectivity-migration');
    const home = join(machine, '.cosyncing');
    await zeroAgentSetup(machine, new ScriptedPresenter());
    const state = readSetupState(home);
    writeFileSync(join(home, 'setup-state.json'), `${JSON.stringify({ ...state, tailscaleServeRequested: true }, null, 2)}\n`, { mode: 0o600 });
    const install = inspectInstallState(home);
    if (!install.committed) throw new Error('legacy connectivity fixture install missing');
    const target = 'https://legacy.example.test/ -> http://127.0.0.1:7734';
    writeFileSync(join(home, 'install-state.json'), `${JSON.stringify({
      ...install.state,
      resources: [...install.state.resources, {
        id: LEGACY_TAILSCALE_RESOURCE_ID,
        kind: 'other',
        target,
        ownership: { proof: 'receipt' },
      }],
    }, null, 2)}\n`, { mode: 0o600 });
    const presenter = new ScriptedPresenter();
    const migrated = await zeroAgentSetup(machine, presenter);
    const after = inspectInstallState(home);
    check('setup relinquishes legacy connectivity without a provider prompt or command',
      migrated.status === 'complete'
        && migrated.legacyConnectivityMigration?.preservedTargets.includes(target) === true
        && !('tailscaleServeRequested' in readSetupState(home))
        && after.committed
        && !after.state.resources.some((resource) => resource.id === LEGACY_TAILSCALE_RESOURCE_ID)
        && !presenter.calls.some((call) => /tailscale/i.test(call)),
      `${presenter.calls.join(',')}:${JSON.stringify(migrated.legacyConnectivityMigration)}`);
  }

  // Planner purity and the first real zero-agent transaction.
  {
    const machine = join(root, 'zero-agent');
    mkdirSync(join(machine, '.claude'), { recursive: true });
    const claudeSettings = join(machine, '.claude', 'settings.json');
    writeFileSync(claudeSettings, '{"preserve":true}\n');
    const presenter = new ScriptedPresenter({ quota: true });
    const setup = await zeroAgentSetup(machine, presenter);
    const home = join(machine, '.cosyncing');
    const install = inspectInstallState(home);
    const state = readSetupState(home);
    check('zero-agent machine commits broker setup with honest guidance',
      setup.status === 'complete' && setup.exitCode === 0 && setup.summary.includes('No supported coding agents') && install.committed,
      `${setup.status}: ${setup.summary}`);
    check('required managed acknowledgement precedes every optional choice and mutation confirmation',
      presenter.calls.join(',') === 'language,intro,ack,skill,opencode-shim,service,quota,plan,confirm,complete',
      presenter.calls.join(','));
    check('setup creates separate valid owner-only credentials',
      inspectBrokerToken(join(home, 'secrets', 'broker-token')).status === 'ok'
        && inspectPiIntegration(join(home, 'secrets', 'pi-integration.json')).status === 'ok'
        && (statSync(join(home, 'secrets', 'broker-token')).mode & 0o777) === 0o600);
    check('setup state has no per-agent mode picker and keeps independent consent fields',
      state.agents?.codex === false && state.quotaWarningsEnabled === true
        && state.serviceChoice === 'foreground' && !('tailscaleServeRequested' in state)
        && state.agentSkillRequested === true
        && !Object.keys(state).some((key) => /mode|claude|hook/i.test(key)));
    const skillTargets = agentSkillTargets(contextFor(machine));
    // R10 reversed the R8 decision: consent now provisions a Tokdash when none is running. Provisioning is
    // still NOT part of the transaction — no plan action, no install receipt — because it must never roll a
    // committed broker install back. This fixture has no pipx, so the attempt reports itself and stops.
    check('the Tokdash consent stays outside the transaction and its receipts',
      state.quotaWarningsEnabled === true
        && setup.actions.every((id) => !/tokdash|quota/i.test(id))
        && install.committed
        && !install.state.resources.some((item) => /tokdash|quota/i.test(`${item.id} ${item.target}`)),
      setup.actions.join(','));
    check('a host without pipx completes setup and says why quota tracking is off',
      setup.status === 'complete' && setup.exitCode === 0
        && setup.tokdash?.status === 'unavailable' && setup.tokdash.reason === 'pipx-missing'
        && readSetupState(home).tokdash === undefined,
      JSON.stringify(setup.tokdash));
    check('setup installs and receipts the cosyncing skill in both native discovery roots',
      skillTargets.every((target) => existsSync(target.path))
        && install.committed
        && skillTargets.every((target) => install.state.resources.some((item) => item.id === target.resourceId)));
    check('packaged skill advertises only callable exact-session delivery routes',
      AGENT_SKILL_SOURCE.includes('- OpenCode: `send_file`')
        && AGENT_SKILL_SOURCE.includes('- Pi: the cosyncing bridge `send_file` action')
        && !AGENT_SKILL_SOURCE.includes('- Claude Code: `SendUserFile`')
        && AGENT_SKILL_SOURCE.includes('including Claude Code and Codex')
        && AGENT_SKILL_SOURCE.includes('Do not place files in `<cwd>/.cosyncing/outbox/`'));
    check('setup never edits Claude settings', readFileSync(claudeSettings, 'utf8') === '{"preserve":true}\n');
    check('successful setup removes the pending transaction journal', !readSetupTransactionJournal(home));

    const before = treeSnapshot(home);
    const rerunPresenter = new ScriptedPresenter();
    const rerun = await zeroAgentSetup(machine, rerunPresenter);
    const after = treeSnapshot(home);
    check('rerunning successful setup is a no-op apart from refreshed inspection',
      rerun.status === 'already-configured' && rerun.exitCode === 0 && before === after
        && rerunPresenter.calls.join(',') === 'language,intro,complete',
      rerunPresenter.calls.join(','));

    const inspection = await inspectSetupEnvironment({
      buildInfo: BUILD_INFO,
      executablePath: join(machine, 'bin', 'cosyncing'),
      home,
      context: contextFor(machine),
    });
    const plan = buildSetupPlan({
      inspection,
      choices: { language: 'en', service: 'foreground', enableLingering: false, quotaWarnings: true, installAgentSkill: true, installOpencodeShim: true },
      now,
    });
    const skillChecks = inspection.doctor.sections.flatMap((section) => section.checks)
      .filter((candidate) => candidate.id.startsWith('state.agent-skill.'));
    check('doctor sees both receipt-owned skill targets after setup',
      skillChecks.length === 2
        && skillChecks.every((candidate) => candidate.status === 'pass'
          && candidate.detailCode === 'agent-skill-present'));
    check('committed planner emits no Claude, hook, or control-mode mutation',
      plan.noOp && !JSON.stringify(plan).match(/claude.*(write|install)|hook|mode.?picker/i));
  }

  // Tokdash auto-provisioning (R10). Consent means "poll a Tokdash, and set one up if there is none". The
  // hard requirement is containment: none of this may fail, roll back, or even slow down a broker install
  // that is otherwise complete, because quota tracking is optional.
  {
    // A context that can see pipx and tokdash on PATH, with the health probe under the test's control.
    const provisionContext = (
      machine: string,
      options: { healthy: boolean; tokdashOnPath?: boolean; env?: Record<string, string> },
    ) => ({
      ...contextFor(machine, options.env ?? {}),
      resolveExecutable: (command: string): string | undefined => {
        if (command === 'pipx') return '/usr/bin/pipx';
        if (command === 'tokdash') return options.tokdashOnPath === false ? undefined : '/usr/bin/tokdash';
        return undefined;
      },
      fetchJson: async (url: string) => url.endsWith('/health') && options.healthy
        ? { status: 'ok' as const, json: { status: 'ok', service: 'tokdash', version: '1.5.7' } }
        : { status: 'unreachable' as const },
    });
    const recordingRunner = (fail?: string) => {
      const calls: string[] = [];
      const run = async (executable: string, args: readonly string[]) => {
        const line = `${executable} ${args.join(' ')}`;
        calls.push(line);
        return { ok: !fail || !line.includes(fail), stdout: '', stderr: fail ? `${fail} exploded` : '' };
      };
      return { calls, run };
    };

    // 1) An instance is already answering: reuse it, touch nothing, record no ownership. This is the R8b
    // read-only behaviour and it has to survive the reversal.
    {
      const machine = join(root, 'tokdash-reuse');
      const runner = recordingRunner();
      const reuse = await runSetup(setupOptions(machine, new ScriptedPresenter({ quota: true }), {
        context: provisionContext(machine, { healthy: true }),
        tokdashRunner: runner.run,
      }));
      check('a reachable Tokdash is reused, never installed over, and leaves nothing to uninstall',
        reuse.status === 'complete' && reuse.tokdash?.status === 'reused'
          && runner.calls.length === 0
          && readSetupState(join(machine, '.cosyncing')).tokdash === undefined
          // Not even a completion marker: reuse issued no consent and provisioned nothing, so it has
          // nothing to mark. A later rerun re-probes and reuses again, which is the read-only behaviour.
          && readTokdashCompletion(join(machine, '.cosyncing')) === undefined,
        `${JSON.stringify(reuse.tokdash)} calls=${runner.calls.join(' | ')}`);
    }

    // 2) Nothing answering and nothing installed: install, run Tokdash's own onboarding, then turn quota
    // tracking on explicitly — `tokdash setup --auto` skips its quota prompt by design, so without this the
    // instance would run and report nothing to warn about.
    {
      const machine = join(root, 'tokdash-provision');
      const runner = recordingRunner();
      let healthy = false;
      const context = {
        ...provisionContext(machine, { healthy: false, tokdashOnPath: false }),
        resolveExecutable: (command: string): string | undefined => {
          if (command === 'pipx') return '/usr/bin/pipx';
          // Appears on PATH only after `pipx install` has run, as it would on a real host.
          if (command === 'tokdash') return runner.calls.some((c) => c.includes('pipx install')) ? '/usr/bin/tokdash' : undefined;
          return undefined;
        },
        fetchJson: async (url: string) => url.endsWith('/health') && healthy
          ? { status: 'ok' as const, json: { status: 'ok', service: 'tokdash' } }
          : { status: 'unreachable' as const },
      };
      const wrapped = async (executable: string, args: readonly string[], timeoutMs: number) => {
        const outcome = await runner.run(executable, args);
        if (args[0] === 'quota') healthy = true;
        return { ...outcome, timeoutMs } as { ok: boolean; stdout: string; stderr: string };
      };
      const provisioned = await runSetup(setupOptions(machine, new ScriptedPresenter({ quota: true }), {
        context,
        tokdashRunner: wrapped,
      }));
      const owned = readSetupState(join(machine, '.cosyncing')).tokdash;
      check('setup installs Tokdash, starts it the way Tokdash intends, and enables quota tracking',
        provisioned.status === 'complete' && provisioned.tokdash?.status === 'provisioned'
          && runner.calls[0] === '/usr/bin/pipx install tokdash'
          && runner.calls[1] === '/usr/bin/tokdash setup --auto --yes'
          && (runner.calls[2] ?? '').startsWith('/usr/bin/tokdash quota consent --enabled on --credential-scan on')
          && (runner.calls[2] ?? '').includes('--codex-api on')
          && (runner.calls[2] ?? '').includes('--claude-api on'),
        runner.calls.join(' | '));
      check('provisioning records both reversible facts so uninstall reverses only what it created',
        owned?.installedByBroker === true && owned.serviceStartedByBroker === true,
        JSON.stringify(owned));

      // The reversal is Tokdash's own uninstall plus the pipx removal, in that order, and only those.
      const reversal = recordingRunner();
      const reversed = await reverseTokdashProvisioning({
        context,
        ownership: { installedByBroker: true, serviceStartedByBroker: true, recordedAt: '' },
        run: reversal.run,
      });
      check('uninstall reverses a provisioned Tokdash with its own uninstall, then pipx',
        reversed.removed
          && reversal.calls[0] === '/usr/bin/tokdash uninstall --yes'
          && reversal.calls[1] === '/usr/bin/pipx uninstall tokdash'
          && reversal.calls.length === 2,
        reversal.calls.join(' | '));
      // A pre-existing instance records nothing, so this is what uninstall does for one: nothing.
      const untouched = recordingRunner();
      const nothing = await reverseTokdashProvisioning({
        context,
        ownership: { installedByBroker: false, serviceStartedByBroker: false, recordedAt: '' },
        run: untouched.run,
      });
      check('uninstall never touches a Tokdash cosyncing did not provision',
        nothing.removed && untouched.calls.length === 0, untouched.calls.join(' | '));
    }

    // 3) Containment, the hard requirement. A failure at any provisioning step leaves setup complete,
    // committed, and rolled back nowhere — the operator keeps a working broker and loses only the dashboard.
    const failures = [
      // Nothing on PATH at all, so `pipx install` is the step that runs and fails.
      { label: 'install', failAt: 'pipx install', onPath: false, reason: 'install-failed' },
      { label: 'service', failAt: 'setup --auto', onPath: true, reason: 'service-failed' },
      { label: 'consent', failAt: 'quota consent', onPath: true, reason: 'consent-failed' },
    ] as const;
    for (const { label, failAt, onPath, reason } of failures) {
      const machine = join(root, `tokdash-fail-${label}`);
      const runner = recordingRunner(failAt);
      const failed = await runSetup(setupOptions(machine, new ScriptedPresenter({ quota: true }), {
        context: provisionContext(machine, { healthy: false, tokdashOnPath: onPath }),
        tokdashRunner: runner.run,
      }));
      const home = join(machine, '.cosyncing');
      check(`a Tokdash ${label} failure never fails or rolls back the setup itself`,
        failed.status === 'complete' && failed.exitCode === 0
          && inspectInstallState(home).committed
          && !readSetupTransactionJournal(home)
          && failed.tokdash?.status === 'unavailable'
          && failed.tokdash.reason === reason
          && failed.tokdash.detail.includes(failAt),
        `${failed.status}:${JSON.stringify(failed.tokdash)}`);
    }

    // 4) Consent off means nothing is attempted at all — not a probe, not a command.
    {
      const machine = join(root, 'tokdash-declined');
      const runner = recordingRunner();
      const off = await runSetup(setupOptions(machine, new ScriptedPresenter({ quota: false }), {
        context: provisionContext(machine, { healthy: false }),
        tokdashRunner: runner.run,
      }));
      check('declining quota tracking provisions nothing and probes nothing',
        off.status === 'complete' && off.tokdash?.status === 'skipped' && runner.calls.length === 0,
        `${JSON.stringify(off.tokdash)} calls=${runner.calls.length}`);
    }

    // 5) Ownership is persisted per mutation, and a mutation whose record will not write is undone rather
    // than reported as done. Setup finishing over an install nothing proves cosyncing made is the case that
    // leaves uninstall no right to remove it — so provisioning compensates instead of claiming completion.
    {
      const machine = join(root, 'tokdash-unrecordable');
      const home = join(machine, '.cosyncing');
      const statePath = join(home, 'setup-state.json');
      const calls: string[] = [];
      let saved = '';
      // A directory where the state file belongs: the atomic writer refuses a non-file target on any host,
      // root included, so the write fails for exactly as long as the install is unrecorded.
      const runner = async (executable: string, args: readonly string[]) => {
        const line = `${executable} ${args.join(' ')}`;
        calls.push(line);
        if (line.endsWith('pipx install tokdash')) {
          saved = readFileSync(statePath, 'utf8');
          rmSync(statePath);
          mkdirSync(statePath);
        }
        if (line.endsWith('pipx uninstall tokdash')) {
          rmSync(statePath, { recursive: true });
          writeFileSync(statePath, saved, { mode: 0o600 });
        }
        return { ok: true, stdout: '', stderr: '' };
      };
      const unrecorded = await runSetup(setupOptions(machine, new ScriptedPresenter({ quota: true }), {
        context: provisionContext(machine, { healthy: false, tokdashOnPath: false }),
        tokdashRunner: runner,
      }));
      check('an install whose ownership will not record is reversed, not claimed as complete',
        unrecorded.status === 'complete' && unrecorded.exitCode === 0
          && unrecorded.tokdash?.status === 'unavailable'
          && unrecorded.tokdash.reason === 'record-failed'
          && calls.join(' | ') === '/usr/bin/pipx install tokdash | /usr/bin/pipx uninstall tokdash'
          && readSetupState(home).tokdash === undefined,
        `${JSON.stringify(unrecorded.tokdash)} calls=${calls.join(' | ')}`);
    }

    // 6) A partial reversal has to be resumable. Clearing both facts only at the end meant a successful
    // `tokdash uninstall` followed by a failing `pipx uninstall` left both set, so the retry repeated the
    // service removal that had already happened and could die there again without ever reaching pipx.
    {
      const machine = join(root, 'tokdash-resume');
      const home = join(machine, '.cosyncing');
      mkdirSync(home, { recursive: true, mode: 0o700 });
      writeSetupState({ tokdash: { installedByBroker: true, serviceStartedByBroker: true, recordedAt: 'r12' } }, home);
      const context = provisionContext(machine, { healthy: false });
      const persist = (left: TokdashOwnership | undefined): void => {
        if (left) setTokdashOwnership(left, home); else clearTokdashOwnership(home);
      };
      const stalledRunner = recordingRunner('pipx uninstall');
      const stalled = await reverseTokdashProvisioning({
        context, ownership: readTokdashOwnership(home)!, run: stalledRunner.run, onReversed: persist,
      });
      const midway = readTokdashOwnership(home);
      const retryRunner = recordingRunner();
      const finished = await reverseTokdashProvisioning({
        context, ownership: readTokdashOwnership(home)!, run: retryRunner.run, onReversed: persist,
      });
      check('a partial Tokdash reversal drops each fact as it lands, so the retry resumes at what is left',
        !stalled.removed
          && midway?.serviceStartedByBroker === false && midway.installedByBroker === true
          && finished.removed
          && retryRunner.calls.join(' | ') === '/usr/bin/pipx uninstall tokdash'
          && readTokdashOwnership(home) === undefined,
        `${JSON.stringify(midway)} first=${stalledRunner.calls.join(' | ')} retry=${retryRunner.calls.join(' | ')}`);
    }

    // 7) One URL-resolution policy. An override used to be normalized by setup, taken raw by the runtime,
    // and ignored by the copy — so an alternate port installed a default-port instance, probed the port
    // nobody had installed on, and failed. Every surface resolves through `resolveTokdashEndpoint` now.
    {
      const machine = join(root, 'tokdash-alt-port');
      const altUrl = 'http://127.0.0.1:45999';
      const probed: string[] = [];
      const runner = recordingRunner();
      let healthy = false;
      const context = {
        ...provisionContext(machine, { healthy: false, env: { COSYNCING_TOKDASH_URL: altUrl } }),
        resolveExecutable: (command: string): string | undefined => {
          if (command === 'pipx') return '/usr/bin/pipx';
          if (command === 'tokdash') return runner.calls.some((c) => c.includes('pipx install')) ? '/usr/bin/tokdash' : undefined;
          return undefined;
        },
        fetchJson: async (url: string) => {
          probed.push(url);
          return url === `${altUrl}/health` && healthy
            ? { status: 'ok' as const, json: { status: 'ok', service: 'tokdash' } }
            : { status: 'unreachable' as const };
        },
      };
      const wrapped = async (executable: string, args: readonly string[], timeoutMs: number) => {
        const outcome = await runner.run(executable, args);
        if (args[0] === 'quota') healthy = true;
        return { ...outcome, timeoutMs } as { ok: boolean; stdout: string; stderr: string };
      };
      const alt = await runSetup(setupOptions(machine, new ScriptedPresenter({ quota: true }), {
        context,
        tokdashRunner: wrapped,
      }));
      check('an alternate-port override is what gets set up, probed, and reported — not the default',
        alt.tokdash?.status === 'provisioned' && alt.tokdash.baseUrl === altUrl
          && runner.calls[1] === '/usr/bin/tokdash setup --auto --yes --bind 127.0.0.1 --port 45999'
          && probed.includes(`${altUrl}/health`)
          && ![...probed, ...runner.calls].some((entry) => entry.includes('55423')),
        `${JSON.stringify(alt.tokdash)} calls=${runner.calls.join(' | ')} probed=${probed.join(' | ')}`);

      // The default endpoint keeps the bare invocation: Tokdash's own defaults already are that address, and
      // restating them is a second place for the two to drift apart.
      const unset = tokdashSetupArgs(resolveTokdashEndpoint(undefined))?.join(' ');
      const explicit = tokdashSetupArgs(resolveTokdashEndpoint(TOKDASH_DEFAULT_BASE_URL))?.join(' ');
      check('the default endpoint is still provisioned with Tokdash\'s own defaults, unstated',
        unset === 'setup --auto --yes' && explicit === 'setup --auto --yes',
        `unset=${unset} explicit=${explicit}`);
    }

    // An override that will not parse must not make setup and the runtime disagree — setup used to fall back
    // silently while the runtime went on using the invalid string. One resolver, one answer, said out loud.
    {
      const machine = join(root, 'tokdash-bad-url');
      const bad = 'http://evil.example:55423';
      const runner = recordingRunner();
      const rejected = resolveTokdashEndpoint(bad);
      const invalid = await runSetup(setupOptions(machine, new ScriptedPresenter({ quota: true }), {
        context: provisionContext(machine, { healthy: false, env: { COSYNCING_TOKDASH_URL: bad } }),
        tokdashRunner: runner.run,
      }));
      check('an unusable override resolves to one endpoint everywhere, and the refusal is reported',
        rejected.rejected === 'not-loopback' && rejected.baseUrl === TOKDASH_DEFAULT_BASE_URL && rejected.isDefault
          && invalid.status === 'complete' && invalid.tokdash?.baseUrl === rejected.baseUrl
          && setupMessages('en').quotaUrlRejected(rejected.rejected, rejected.baseUrl).includes('localhost')
          && setupMessages('zh-Hans').quotaUrlRejected(rejected.rejected, rejected.baseUrl).includes('本机'),
        `${JSON.stringify(rejected)} outcome=${JSON.stringify(invalid.tokdash)}`);

      // A refused override is operator-supplied text. `http://user:secret@127.0.0.1:55423` is refused for
      // exactly the right reason and used to be echoed back verbatim — into the broker log, the wizard, and
      // `setup --yes` — which put the password in all three. Nothing retains it now, so nothing can print it.
      {
        const secret = 'http://leaked-user:leaked-secret@127.0.0.1:55423';
        const endpoint = resolveTokdashEndpoint(secret);
        // Every rendering of the refusal, on every surface, from the one resolution.
        const surfaces = [
          JSON.stringify(endpoint),
          tokdashRejectionReason(endpoint.rejected!),
          setupMessages('en').quotaUrlRejected(endpoint.rejected!, endpoint.baseUrl),
          setupMessages('zh-Hans').quotaUrlRejected(endpoint.rejected!, endpoint.baseUrl),
        ];
        // The non-interactive path prints its own line, at the same point the wizard prints its warning.
        let scripted = '';
        const priorUrl = process.env.COSYNCING_TOKDASH_URL;
        process.env.COSYNCING_TOKDASH_URL = secret;
        try {
          await createNonInteractiveSetupPresenter({ write: (value) => { scripted += value; } })
            .confirmQuotaWarnings({ setupState: {} } as unknown as SetupInspection);
        } finally {
          if (priorUrl === undefined) delete process.env.COSYNCING_TOKDASH_URL;
          else process.env.COSYNCING_TOKDASH_URL = priorUrl;
        }
        surfaces.push(scripted);
        // And the broker's own startup warning, which is built from the same reason phrase.
        surfaces.push(`ignoring COSYNCING_TOKDASH_URL (value withheld): `
          + `${tokdashRejectionReason(endpoint.rejected!)}; using ${endpoint.baseUrl}`);
        check('a credential-bearing override is refused without its username or password reaching any surface',
          endpoint.rejected === 'credentials' && endpoint.baseUrl === TOKDASH_DEFAULT_BASE_URL
            && scripted.includes('[tokdash] url-rejected reason=credentials')
            && !surfaces.some((surface) => /leaked-user|leaked-secret/.test(surface)),
          surfaces.join(' ~ '));
      }

      // An endpoint Tokdash cannot serve at all is refused before anything is installed, and said so in both
      // languages — "we tried and it broke" would be a lie about a thing that was never attempted.
      const tls = join(root, 'tokdash-https');
      const tlsRunner = recordingRunner();
      const unsupported = await runSetup(setupOptions(tls, new ScriptedPresenter({ quota: true }), {
        context: provisionContext(tls, { healthy: false, env: { COSYNCING_TOKDASH_URL: 'https://127.0.0.1:8443' } }),
        tokdashRunner: tlsRunner.run,
      }));
      check('an endpoint Tokdash cannot serve is refused before any mutation, in both languages',
        unsupported.status === 'complete'
          && unsupported.tokdash?.status === 'unavailable'
          && unsupported.tokdash.reason === 'endpoint-unsupported'
          && unsupported.tokdash.baseUrl === 'https://127.0.0.1:8443'
          && tlsRunner.calls.length === 0
          && setupMessages('en').quotaEndpointUnsupported('u').includes('u')
          && setupMessages('zh-Hans').quotaEndpointUnsupported('u').includes('u'),
        `${JSON.stringify(unsupported.tokdash)} calls=${tlsRunner.calls.join(' | ')}`);
    }

    // The prompt describes commands that will run, and provisioning takes one of three branches. Reading
    // only pipx got both ends wrong: a host with the tokdash CLI installed and no pipx was told nothing
    // could be set up, though provisioning would skip pipx and run `tokdash setup`; a host with both was
    // promised a `pipx install` that would never run. Prompt and result must agree in every case.
    {
      const neither = join(root, 'tokdash-cap-neither');
      const pipxOnly = join(root, 'tokdash-cap-pipx');
      const cliPresent = join(root, 'tokdash-cap-cli');
      for (const path of [neither, pipxOnly, cliPresent]) mkdirSync(path, { recursive: true });
      const inspectWith = async (machine: string, context: ReturnType<typeof contextFor>) =>
        inspectSetupEnvironment({
          buildInfo: BUILD_INFO,
          executablePath: join(machine, 'bin', 'cosyncing'),
          home: join(machine, '.cosyncing'),
          context,
        });
      // contextFor's PATH is empty, so nothing resolves; provisionContext resolves pipx, and its
      // `tokdashOnPath` switch is the only difference between the other two.
      const absent = await inspectWith(neither, contextFor(neither));
      const installable = await inspectWith(
        pipxOnly,
        provisionContext(pipxOnly, { healthy: false, tokdashOnPath: false }) as ReturnType<typeof contextFor>,
      );
      const installed = await inspectWith(
        cliPresent,
        provisionContext(cliPresent, { healthy: false }) as ReturnType<typeof contextFor>,
      );
      // The CLI without pipx is the case the old copy denied outright, so it gets its own inspection.
      const cliNoPipx = {
        ...contextFor(cliPresent),
        resolveExecutable: (command: string): string | undefined =>
          command === 'tokdash' ? '/usr/bin/tokdash' : undefined,
      } as ReturnType<typeof contextFor>;
      const cliOnly = await inspectWith(cliPresent, cliNoPipx);
      const runner = recordingRunner();
      const stranded = await runSetup(setupOptions(neither, new ScriptedPresenter({ quota: true }), {
        tokdashRunner: runner.run,
      }));
      const strandedDetail = stranded.tokdash?.status === 'unavailable' ? stranded.tokdash.detail : '';
      check('the prompt reads both executables, so each host lands in the branch provisioning will take',
        tokdashProvisionCapability(absent) === 'unavailable'
          && tokdashProvisionCapability(installable) === 'install'
          && tokdashProvisionCapability(installed) === 'setup-only'
          // The CLI is enough on its own: provisioning never touches pipx when it does not have to.
          && tokdashProvisionCapability(cliOnly) === 'setup-only'
          && absent.tokdashAvailable === false && installed.tokdashAvailable === true
          && cliOnly.pipxAvailable === false && cliOnly.tokdashAvailable === true,
        `absent=${tokdashProvisionCapability(absent)} installable=${tokdashProvisionCapability(installable)} `
          + `installed=${tokdashProvisionCapability(installed)} cliOnly=${tokdashProvisionCapability(cliOnly)}`);
      for (const [label, language] of [['en', 'en'], ['zh-Hans', 'zh-Hans']] as const) {
        const text = setupMessages(language);
        const reuse = language === 'en' ? 'is reused as-is and never modified' : '直接复用';
        check(`the quota prompt promises exactly what will run, in all three cases (${label})`,
          // (a) the CLI is here: `tokdash setup` and nothing installed.
          text.quotaNote('u', 'setup-only').includes('tokdash setup')
            && !text.quotaNote('u', 'setup-only').includes('pipx install tokdash')
            // (b) pipx can install it: both commands named.
            && text.quotaNote('u', 'install').includes('pipx install tokdash')
            && text.quotaNote('u', 'install').includes('tokdash setup')
            // (c) neither: a prerequisite to install first, with the Python floor and the way back.
            && !text.quotaNote('u', 'unavailable').includes('pipx install tokdash')
            && text.quotaNote('u', 'unavailable').includes('brew install pipx')
            && text.quotaNote('u', 'unavailable').includes('sudo apt install pipx')
            && text.quotaNote('u', 'unavailable').includes('Python 3.9+')
            // The standing invariant: reuse is stated the same way in every case, before any probe.
            && (['setup-only', 'install', 'unavailable'] as const)
              .every((capability) => text.quotaNote('u', capability).includes(reuse)),
          `${label}: ${text.quotaNote('u', 'setup-only')}`);
        // ...and the outcome agrees with whichever case applied: "installed and started" is a lie on a host
        // where the CLI was already there.
        check(`the provisioning outcome agrees with the prompt case that applied (${label})`,
          text.quotaProvisioned('u', true) !== text.quotaProvisioned('u', false)
            && !text.quotaProvisioned('u', false).includes(language === 'en' ? 'Installed and started' : '已经装好并启动'),
          `${label}: ${text.quotaProvisioned('u', false)}`);
      }
      check('the pipx-missing result names the same fix the prompt did',
        stranded.tokdash?.status === 'unavailable' && stranded.tokdash.reason === 'pipx-missing'
          && strandedDetail.includes('brew install pipx')
          && strandedDetail.includes('sudo apt install pipx')
          && strandedDetail.includes('Python 3.9+')
          && strandedDetail.includes('run setup again'),
        strandedDetail);
    }

    // 8) Provisioning is post-commit and best-effort, so it is the one thing a committed rerun must still
    // evaluate. Exiting "already-configured" before reaching it meant the documented recovery — install the
    // missing pipx, run setup again — did nothing at all, forever.
    {
      const machine = join(root, 'tokdash-retry');
      const home = join(machine, '.cosyncing');
      const firstRunner = recordingRunner();
      // contextFor's PATH is empty, so nothing on it resolves: this is the host without pipx.
      const first = await runSetup(setupOptions(machine, new ScriptedPresenter({ quota: true }), {
        tokdashRunner: firstRunner.run,
      }));
      const strandedRun = first.tokdash?.status === 'unavailable' && first.tokdash.reason === 'pipx-missing'
        && firstRunner.calls.length === 0 && readSetupState(home).tokdash === undefined;

      const retryRunner = recordingRunner();
      let healthy = false;
      const retryContext = {
        ...provisionContext(machine, { healthy: false }),
        resolveExecutable: (command: string): string | undefined => {
          if (command === 'pipx') return '/usr/bin/pipx';
          if (command === 'tokdash') return retryRunner.calls.some((c) => c.includes('pipx install')) ? '/usr/bin/tokdash' : undefined;
          return undefined;
        },
        fetchJson: async (url: string) => url.endsWith('/health') && healthy
          ? { status: 'ok' as const, json: { status: 'ok', service: 'tokdash' } }
          : { status: 'unreachable' as const },
      };
      const wrapped = async (executable: string, args: readonly string[], timeoutMs: number) => {
        const outcome = await retryRunner.run(executable, args);
        if (args[0] === 'quota') healthy = true;
        return { ...outcome, timeoutMs } as { ok: boolean; stdout: string; stderr: string };
      };
      const retry = await runSetup(setupOptions(machine, new ScriptedPresenter({ quota: true }), {
        context: retryContext,
        tokdashRunner: wrapped,
      }));
      check('a rerun after the operator installs pipx provisions what the first run could not',
        strandedRun
          && retry.status === 'already-configured' && retry.exitCode === 0
          && retry.tokdash?.status === 'provisioned'
          && retryRunner.calls[0] === '/usr/bin/pipx install tokdash'
          && retryRunner.calls[1] === '/usr/bin/tokdash setup --auto --yes'
          && readTokdashOwnership(home)?.installedByBroker === true
          && readTokdashOwnership(home)?.serviceStartedByBroker === true,
        `stranded=${strandedRun} ${retry.status}:${JSON.stringify(retry.tokdash)} calls=${retryRunner.calls.join(' | ')}`);

      // ...and the retry is a one-shot: the completed run wrote the marker, so a third run attempts nothing.
      const thirdRunner = recordingRunner();
      const third = await runSetup(setupOptions(machine, new ScriptedPresenter({ quota: true }), {
        context: retryContext,
        tokdashRunner: thirdRunner.run,
      }));
      check('a rerun of a completed provisioning re-provisions nothing',
        third.status === 'already-configured' && third.tokdash === undefined && thirdRunner.calls.length === 0
          && readTokdashCompletion(home)?.baseUrl === TOKDASH_DEFAULT_BASE_URL,
        `${third.status}:${JSON.stringify(third.tokdash)} calls=${thirdRunner.calls.join(' | ')}`);
    }

    // 8b) Partial success used to be permanent failure. The retry above only ran when NOTHING was owned, so
    // a first run that started the service and then failed at consent recorded ownership, satisfied that
    // gate forever, and left quota tracking off with no way back. Round 13 fixed that with a best-effort
    // stage list — which reintroduced the same permanence one write down, because a lost note put the state
    // back to "owned, nothing outstanding". The rerun now decides from ownership and the host, and stops
    // only on a positive completion marker, so no write can fail its way into "there is nothing to do".
    {
      const machine = join(root, 'tokdash-resume-consent');
      const home = join(machine, '.cosyncing');
      // The service is started by the first run, so it answers `/health` from then on — which is precisely
      // what made the naive "something is answering, reuse it" shortcut skip the consent that never ran.
      let serviceUp = false;
      const startedContext = {
        ...provisionContext(machine, { healthy: false }),
        resolveExecutable: (command: string): string | undefined =>
          command === 'pipx' || command === 'tokdash' ? `/usr/bin/${command}` : undefined,
        fetchJson: async (url: string) => url.endsWith('/health') && serviceUp
          ? { status: 'ok' as const, json: { status: 'ok', service: 'tokdash' } }
          : { status: 'unreachable' as const },
      };
      const firstRunner = recordingRunner('quota consent');
      const first = await runSetup(setupOptions(machine, new ScriptedPresenter({ quota: true }), {
        context: startedContext,
        tokdashRunner: async (executable: string, args: readonly string[]) => {
          const outcome = await firstRunner.run(executable, args);
          if (args[0] === 'setup') serviceUp = true;
          return outcome;
        },
      }));
      const ownedAfterFirst = readTokdashOwnership(home);
      const markerAfterFirst = readTokdashCompletion(home);

      const retryRunner = recordingRunner();
      const retry = await runSetup(setupOptions(machine, new ScriptedPresenter({ quota: true }), {
        context: startedContext,
        tokdashRunner: retryRunner.run,
      }));
      const ownedAfterRetry = readTokdashOwnership(home);
      check('a run that started the service but failed consent is finished by an unchanged rerun',
        first.status === 'complete' && first.tokdash?.status === 'unavailable'
          && first.tokdash.reason === 'consent-failed'
          // The service exists and is recorded as ours; nothing claims the job is finished.
          && ownedAfterFirst?.serviceStartedByBroker === true
          && markerAfterFirst === undefined
          && retry.status === 'already-configured' && retry.tokdash?.status === 'provisioned'
          // The whole point: consent, and only consent. No `pipx install`, no second `tokdash setup`.
          && retryRunner.calls.length === 1
          && (retryRunner.calls[0] ?? '').startsWith('/usr/bin/tokdash quota consent ')
          // Ownership survives the resume rather than being overwritten by the stage that just ran.
          && ownedAfterRetry?.serviceStartedByBroker === true
          // Consent landed and the instance answered, so now — and only now — the endpoint is marked done.
          && readTokdashCompletion(home)?.baseUrl === TOKDASH_DEFAULT_BASE_URL,
        `first=${JSON.stringify(first.tokdash)} owned=${JSON.stringify(ownedAfterFirst)} `
          + `retry=${JSON.stringify(retry.tokdash)} calls=${retryRunner.calls.join(' | ')}`);
    }

    // 8c) The same class, one stage earlier: `pipx install` succeeds but its bin directory is not on this
    // shell's PATH yet, so the tokdash command cannot be found until the next shell. The install is real and
    // recorded, so the rerun that can finally see the command must continue from there — never install over
    // a package it already owns.
    {
      const machine = join(root, 'tokdash-path-lag');
      const home = join(machine, '.cosyncing');
      let commandVisible = false;
      let serviceUp = false;
      const laggingContext = {
        ...provisionContext(machine, { healthy: false }),
        resolveExecutable: (command: string): string | undefined => {
          if (command === 'pipx') return '/usr/bin/pipx';
          if (command === 'tokdash') return commandVisible ? '/usr/bin/tokdash' : undefined;
          return undefined;
        },
        fetchJson: async (url: string) => url.endsWith('/health') && serviceUp
          ? { status: 'ok' as const, json: { status: 'ok', service: 'tokdash' } }
          : { status: 'unreachable' as const },
      };
      const firstRunner = recordingRunner();
      const first = await runSetup(setupOptions(machine, new ScriptedPresenter({ quota: true }), {
        context: laggingContext,
        tokdashRunner: firstRunner.run,
      }));
      const markerAfterFirst = readTokdashCompletion(home);
      // The next shell has pipx's bin directory on PATH.
      commandVisible = true;
      const retryRunner = recordingRunner();
      const retry = await runSetup(setupOptions(machine, new ScriptedPresenter({ quota: true }), {
        context: laggingContext,
        tokdashRunner: async (executable: string, args: readonly string[]) => {
          const outcome = await retryRunner.run(executable, args);
          if (args[0] === 'quota') serviceUp = true;
          return outcome;
        },
      }));
      check('an install the shell cannot see yet is resumed, not repeated, by the next run',
        first.tokdash?.status === 'unavailable' && first.tokdash.reason === 'install-failed'
          && firstRunner.calls.join(' | ') === '/usr/bin/pipx install tokdash'
          // The ownership record is the whole resume: it is what tells the next run not to install again,
          // and it is written with compensation, so it cannot go missing while the package stays behind.
          && readTokdashOwnership(home)?.installedByBroker === true
          && markerAfterFirst === undefined
          && retry.tokdash?.status === 'provisioned'
          && retryRunner.calls[0] === '/usr/bin/tokdash setup --auto --yes'
          && !retryRunner.calls.some((call) => call.includes('pipx install'))
          && readTokdashOwnership(home)?.installedByBroker === true
          && readTokdashOwnership(home)?.serviceStartedByBroker === true
          && readTokdashCompletion(home)?.baseUrl === TOKDASH_DEFAULT_BASE_URL,
        `first=${JSON.stringify(first.tokdash)} marker=${JSON.stringify(markerAfterFirst)} `
          + `retry=${JSON.stringify(retry.tokdash)} calls=${retryRunner.calls.join(' | ')}`);

      // Uninstall drops both records: what it reversed is no longer owned, and the marker asserting a live
      // consented instance at this endpoint is false the moment the first resource behind it is gone.
      const reversalRunner = recordingRunner();
      const reversed = await reverseTokdashProvisioning({
        context: laggingContext,
        ownership: readTokdashOwnership(home)!,
        run: reversalRunner.run,
        onReversed: (left) => {
          clearTokdashCompletion(home);
          if (left) setTokdashOwnership(left, home); else clearTokdashOwnership(home);
        },
      });
      check('a successful uninstall drops the ownership record and the completion marker together',
        reversed.removed && readTokdashOwnership(home) === undefined
          && readTokdashCompletion(home) === undefined,
        `${JSON.stringify(reversed)} calls=${reversalRunner.calls.join(' | ')}`);
    }

    // 8d) The failure the stage list reintroduced, and the reason there is no stage list any more.
    //
    // Round 13 wrote a best-effort note after `tokdash setup` and read it back to decide what to skip. The
    // write is swallowed on failure by design — and the retry gate ("no ownership OR a surviving note")
    // then read owned-resources-with-no-note as COMPLETE. So: service created and recorded, note lost,
    // consent failed, and every unchanged rerun from then on skipped provisioning entirely. Consent was off
    // permanently. Nothing best-effort decides anything now, and the one best-effort write left — the
    // completion marker — costs a repeated idempotent consent when it fails, which is the direction that
    // converges.
    {
      const machine = join(root, 'tokdash-lost-note');
      const home = join(machine, '.cosyncing');
      const statePath = join(home, 'setup-state.json');
      const health = `${TOKDASH_DEFAULT_BASE_URL}/health`;
      const probes: string[] = [];
      let serviceUp = false;
      const hostContext = {
        ...provisionContext(machine, { healthy: false }),
        resolveExecutable: (command: string): string | undefined =>
          command === 'pipx' || command === 'tokdash' ? `/usr/bin/${command}` : undefined,
        fetchJson: async (url: string) => {
          probes.push(url);
          return url === health && serviceUp
            ? { status: 'ok' as const, json: { status: 'ok', service: 'tokdash' } }
            : { status: 'unreachable' as const };
        },
      };
      const runOnce = (runner: (executable: string, args: readonly string[]) => Promise<unknown>) =>
        runSetup(setupOptions(machine, new ScriptedPresenter({ quota: true }), {
          context: hostContext,
          tokdashRunner: runner,
        }));

      // Run 1 — the service lands and is recorded; consent fails. This is the state Codex named.
      const firstRunner = recordingRunner('quota consent');
      const first = await runOnce(async (executable, args) => {
        const outcome = await firstRunner.run(executable, args);
        if (args[0] === 'setup') serviceUp = true;
        return outcome;
      });
      check('a service that is owned but not consented leaves nothing claiming the job is done',
        first.tokdash?.status === 'unavailable' && first.tokdash.reason === 'consent-failed'
          && readTokdashOwnership(home)?.serviceStartedByBroker === true
          && readTokdashCompletion(home) === undefined
          // There is no best-effort note between the service landing and consent failing, so there is no
          // write whose loss could make the next run believe there is nothing left to do.
          && readSetupState(home).tokdashProgress === undefined,
        `${JSON.stringify(first.tokdash)} state=${JSON.stringify(readSetupState(home).tokdash)}`);

      // Run 2 — the unchanged rerun resumes, and the marker write is refused at the instant it happens: the
      // state file is swapped for a directory, which the atomic writer refuses on any host, root included.
      const secondRunner = recordingRunner();
      let saved = '';
      const second = await runOnce(async (executable, args) => {
        const outcome = await secondRunner.run(executable, args);
        if (args[0] === 'quota') {
          saved = readFileSync(statePath, 'utf8');
          rmSync(statePath);
          mkdirSync(statePath);
        }
        return outcome;
      });
      rmSync(statePath, { recursive: true });
      writeFileSync(statePath, saved, { mode: 0o600 });
      check('an unchanged rerun retries consent without recreating the service or reinstalling',
        second.status === 'already-configured' && second.tokdash?.status === 'provisioned'
          && secondRunner.calls.length === 1
          && (secondRunner.calls[0] ?? '').startsWith('/usr/bin/tokdash quota consent ')
          // The refused write is swallowed: provisioning really did succeed, and the marker is simply absent.
          && readTokdashCompletion(home) === undefined
          && readTokdashOwnership(home)?.serviceStartedByBroker === true,
        `${JSON.stringify(second.tokdash)} calls=${secondRunner.calls.join(' | ')}`);

      // Run 3 — the marker never landed, so this run evaluates again. Consent is already effective on the
      // host; re-issuing it is the same command with the same arguments, and the marker lands this time.
      const thirdRunner = recordingRunner();
      const third = await runOnce(thirdRunner.run);
      check('a refused marker costs one idempotent re-consent, and the next run converges',
        third.tokdash?.status === 'provisioned'
          && thirdRunner.calls.length === 1
          && (thirdRunner.calls[0] ?? '').startsWith('/usr/bin/tokdash quota consent ')
          && !thirdRunner.calls.some((call) => call.includes('pipx install') || call.includes('setup --auto'))
          && readTokdashCompletion(home)?.baseUrl === TOKDASH_DEFAULT_BASE_URL,
        `${JSON.stringify(third.tokdash)} marker=${JSON.stringify(readTokdashCompletion(home))} `
          + `calls=${thirdRunner.calls.join(' | ')}`);

      // Run 4 — the marker is the only thing that stops a rerun, and it stops it completely: no command, and
      // not even a probe of the endpoint.
      const probedBefore = probes.filter((url) => url === health).length;
      const fourthRunner = recordingRunner();
      const fourth = await runOnce(fourthRunner.run);
      check('a marked endpoint is not probed and not touched by a rerun',
        fourth.status === 'already-configured' && fourth.tokdash === undefined
          && fourthRunner.calls.length === 0
          && probes.filter((url) => url === health).length === probedBefore,
        `${JSON.stringify(fourth.tokdash)} calls=${fourthRunner.calls.length} `
          + `probes=${probes.filter((url) => url === health).length} before=${probedBefore}`);

      // ...and it stops a rerun at THAT endpoint only. Completion at one address proves nothing about
      // another, so moving the override reopens provisioning rather than inheriting a marker for a URL the
      // operator has left behind.
      const movedRunner = recordingRunner();
      const moved = await runSetup(setupOptions(machine, new ScriptedPresenter({ quota: true }), {
        context: {
          ...hostContext,
          env: { ...hostContext.env, COSYNCING_TOKDASH_URL: 'http://127.0.0.1:45123' },
        },
        tokdashRunner: movedRunner.run,
      }));
      check('a completion marker binds to its endpoint, so moving the override provisions again',
        moved.tokdash?.baseUrl === 'http://127.0.0.1:45123'
          && moved.tokdash.status === 'unavailable' && moved.tokdash.reason === 'not-answering'
          && movedRunner.calls.length === 1
          && (movedRunner.calls[0] ?? '').startsWith('/usr/bin/tokdash quota consent '),
        `${JSON.stringify(moved.tokdash)} calls=${movedRunner.calls.join(' | ')}`);
    }

    // 8e) A record from the build before this one, and a malformed one, must never suppress a stage. Round
    // 13's reader accepted any subset of stage names, so a `tokdashProgress` holding only `consent` — a
    // truncated write, a hand-edited file, a build that meant something else by the word — skipped the
    // consent step with nothing whatsoever supporting it. There is no reader now: the key is legacy, so the
    // stage is redone and the remnant is dropped the moment provisioning finishes.
    {
      const machine = join(root, 'tokdash-legacy-progress');
      const home = join(machine, '.cosyncing');
      let serviceUp = false;
      const hostContext = {
        ...provisionContext(machine, { healthy: false }),
        resolveExecutable: (command: string): string | undefined =>
          command === 'pipx' || command === 'tokdash' ? `/usr/bin/${command}` : undefined,
        fetchJson: async (url: string) => url.endsWith('/health') && serviceUp
          ? { status: 'ok' as const, json: { status: 'ok', service: 'tokdash' } }
          : { status: 'unreachable' as const },
      };
      // The round-13 end state this upgrades from: the service is ours, consent never landed, and the note
      // on disk claims the one stage that never ran.
      const first = await runSetup(setupOptions(machine, new ScriptedPresenter({ quota: true }), {
        context: hostContext,
        tokdashRunner: async (executable: string, args: readonly string[]) => {
          if (args[0] === 'setup') serviceUp = true;
          return { ok: args[0] !== 'quota', stdout: '', stderr: 'consent exploded' };
        },
      }));
      writeSetupState({
        ...readSetupState(home),
        tokdashProgress: { baseUrl: TOKDASH_DEFAULT_BASE_URL, stages: ['consent'], recordedAt: 'r13' },
      }, home);
      const runner = recordingRunner();
      const upgraded = await runSetup(setupOptions(machine, new ScriptedPresenter({ quota: true }), {
        context: hostContext,
        tokdashRunner: runner.run,
      }));
      check('a legacy record claiming a stage nothing else supports does not suppress that stage',
        first.tokdash?.status === 'unavailable' && first.tokdash.reason === 'consent-failed'
          && upgraded.tokdash?.status === 'provisioned'
          // The stage the record claimed is exactly the one that runs.
          && runner.calls.length === 1
          && (runner.calls[0] ?? '').startsWith('/usr/bin/tokdash quota consent ')
          && readTokdashCompletion(home)?.baseUrl === TOKDASH_DEFAULT_BASE_URL
          // ...and the remnant is gone, so an upgraded host stops carrying a record nothing reads.
          && readSetupState(home).tokdashProgress === undefined,
        `${JSON.stringify(upgraded.tokdash)} calls=${runner.calls.join(' | ')} `
          + `legacy=${JSON.stringify(readSetupState(home).tokdashProgress)}`);
    }

    // 9) The real command runner, against real processes. Everything above injects a runner, so these are
    // the only checks that exercise what an unattended setup actually spawns for up to three minutes.
    {
      // A noisy child must not be able to grow the broker's heap by talking. The tail is what
      // `failureDetail` quotes, so it is the end that has to survive, not the beginning.
      const noisy = await runTokdashCommand('/bin/sh', [
        '-c',
        `head -c ${TOKDASH_OUTPUT_TAIL_CHARS * 4} /dev/zero | tr '\\0' x; printf TAILMARK`,
      ], 30_000);
      check('command output is drained but retained only as a bounded tail',
        noisy.ok && noisy.stdout.length <= TOKDASH_OUTPUT_TAIL_CHARS && noisy.stdout.endsWith('TAILMARK'),
        `ok=${noisy.ok} bytes=${noisy.stdout.length} cap=${TOKDASH_OUTPUT_TAIL_CHARS}`);

      // A wedged child ignores SIGTERM, so the runner has to escalate — and must not report a result while
      // the process it gave up on is still running and still holding whatever it holds. The child prints its
      // own pid, so "is it really gone" is answerable at the instant the promise resolves.
      const startedAt = Date.now();
      const wedged = await runTokdashCommand(process.execPath, [
        '-e',
        // writeSync, not console.log: a buffered pid would be lost to the SIGKILL this check is about.
        'import { writeSync } from "node:fs"; writeSync(1, String(process.pid));'
        + ' process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
      ], 500);
      const elapsedMs = Date.now() - startedAt;
      const pid = Number.parseInt(wedged.stdout.trim(), 10);
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      check('a timed-out child is escalated to SIGKILL and awaited, never abandoned alive',
        !wedged.ok && Number.isInteger(pid) && !alive && elapsedMs >= 500,
        `ok=${wedged.ok} pid=${pid} alive=${alive} elapsed=${elapsedMs}ms`);
    }
  }

  // "unsupported" with no explanation is what a physical audit asked about. The preflight must answer it
  // inline: detected version, the required floor read from the adapter's own constant, and the fix command.
  {
    const machine = join(root, 'claude-unsupported');
    mkdirSync(machine, { recursive: true });
    const fakeClaude = join(machine, 'fake-claude');
    writeFileSync(fakeClaude, '#!/bin/sh\necho "1.0.99 (Claude Code)"\n', { mode: 0o755 });
    const inspection = await inspectSetupEnvironment({
      buildInfo: BUILD_INFO,
      executablePath: join(machine, 'bin', 'cosyncing'),
      home: join(machine, '.cosyncing'),
      context: contextFor(machine, { COSYNCING_CLAUDE_BIN: fakeClaude }),
    });
    const claude = inspection.agents.find((agent) => agent.id === 'claude');
    check('an unsupported Claude CLI carries its detected version, the required floor, and the fix command',
      claude?.state === 'unsupported' && claude.installedVersion === '1.0.99'
        && claude.minimumVersion === CLAUDE_MINIMUM_VERSION.version
        && claude.upgradeCommand === 'claude update',
      JSON.stringify(claude));
    const preflight = agentPreflightLines(inspection.agents);
    check('the setup preflight explains what unsupported means where it reports it',
      preflight.includes('Claude Code 1.0.99: unsupported')
        && preflight.includes(`detected 1.0.99; Claude Code ${CLAUDE_MINIMUM_VERSION.version} or newer is required.`)
        && preflight.includes('Run `claude update`.'),
      preflight.split('\n').filter((row) => /claude/i.test(row)).join(' | '));
    let preflightOut = '';
    createNonInteractiveSetupPresenter({ write: (value) => { preflightOut += value; } }).intro(inspection);
    check('the non-interactive preflight reports the same reason in its machine-readable form',
      preflightOut.includes(`agent.claude.unsupported=detected:1.0.99 minimum:${CLAUDE_MINIMUM_VERSION.version} fix:claude update`),
      preflightOut.trim().split('\n').filter((row) => row.includes('claude')).join(' | '));
  }

  // npm Codex supports ordinary app-server calls, but not the managed daemon used for terminal sync. Setup
  // must disclose that distinction without blocking or silently replacing the user's installation.
  {
    const machine = join(root, 'codex-npm-only');
    const fakeCodex = join(machine, 'bin', 'codex');
    mkdirSync(dirname(fakeCodex), { recursive: true });
    writeFileSync(fakeCodex, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const base = contextFor(machine);
    const inspection = await inspectSetupEnvironment({
      buildInfo: BUILD_INFO,
      executablePath: join(machine, 'bin', 'cosyncing'),
      home: join(machine, '.cosyncing'),
      context: {
        ...base,
        resolveExecutable: (command) => command === 'codex' ? fakeCodex : undefined,
        readPackageVersion: (_path, packages) => packages.includes('@openai/codex') ? '0.146.1' : undefined,
      },
    });
    const codex = inspection.agents.find((agent) => agent.id === 'codex');
    const english = agentPreflightLines(inspection.agents, 'en');
    const chinese = agentPreflightLines(inspection.agents, 'zh-Hans');
    check('setup warns without blocking when supported npm Codex lacks the standalone daemon package',
      codex?.state === 'supported'
        && codex.managedRuntimeWarning?.detailCode === 'codex-standalone-install-missing'
        && english.includes('curl -fsSL https://chatgpt.com/codex/install.sh | sh')
        && english.includes('app-created sessions remain available')
        && english.includes('rerun `cosy setup`')
        && chinese.includes('App 创建会话仍可使用')
        && chinese.includes('官方安装器会检测 npm 版 Codex，并询问是否移除')
        && chinese.includes('重新运行 `cosy setup`'),
      `${english}\n${chinese}`);
    let nonInteractive = '';
    createNonInteractiveSetupPresenter({ write: (value) => { nonInteractive += value; } }).intro(inspection);
    check('non-interactive setup carries the same standalone warning and recovery command',
      nonInteractive.includes('agent.codex.warning=codex-standalone-install-missing')
        && nonInteractive.includes('then:cosy setup'),
      nonInteractive);
  }

  // Required decline and Ctrl+C at every prompt leave setup uncommitted.
  {
    const machine = join(root, 'decline');
    const presenter = new ScriptedPresenter({ managed: false });
    const declined = await zeroAgentSetup(machine, presenter);
    check('declining managed-runtime acknowledgement aborts before mutation',
      declined.status === 'declined' && !existsSync(join(machine, '.cosyncing'))
        && presenter.calls.join(',') === 'language,intro,ack,failed',
      presenter.calls.join(','));
  }
  for (const stage of ['ack', 'skill', 'opencodeShim', 'service', 'quota', 'confirm'] as const) {
    const machine = join(root, `cancel-${stage}`);
    const presenter = new ScriptedPresenter({ cancelAt: stage });
    const cancelled = await zeroAgentSetup(machine, presenter);
    check(`Ctrl+C at ${stage} cancels without committed state`,
      cancelled.status === 'cancelled' && cancelled.exitCode === 130
        && !inspectInstallState(join(machine, '.cosyncing')).committed,
      presenter.calls.join(','));
  }

  // The dedicated skill consent can be declined without making doctor report an absent integration.
  {
    const machine = join(root, 'decline-skill');
    const presenter = new ScriptedPresenter({ skill: false });
    const setup = await zeroAgentSetup(machine, presenter);
    const home = join(machine, '.cosyncing');
    const inspection = await inspectSetupEnvironment({
      buildInfo: BUILD_INFO,
      executablePath: join(machine, 'bin', 'cosyncing'),
      home,
      context: contextFor(machine),
    });
    const skillChecks = inspection.doctor.sections.flatMap((section) => section.checks)
      .filter((candidate) => candidate.id.startsWith('state.agent-skill.'));
    check('declining agent skill installs nothing and doctor stays quiet',
      setup.status === 'complete'
        && readSetupState(home).agentSkillRequested === false
        && agentSkillTargets(contextFor(machine)).every((target) => !existsSync(target.path))
        && skillChecks.length === 0,
      presenter.calls.join(','));
  }

  // Receipt-proved upgrade path: a broker build change makes installed copies owned-stale, and setup/doctor
  // refresh them in place instead of blocking (the "updating the broker auto-updates the skill" behavior).
  {
    const machine = join(root, 'skill-upgrade');
    const home = join(machine, '.cosyncing');
    await zeroAgentSetup(machine, new ScriptedPresenter());
    const targets = agentSkillTargets(contextFor(machine));
    // Simulate copies installed by an earlier broker build: rewrite each to older content and re-point its
    // receipt at that exact older sha, proving we (a prior build) installed it.
    const oldContent = '---\nname: cosyncing\n---\n\n# older packaged version\n';
    const oldSha = createHash('sha256').update(oldContent).digest('hex');
    const install = inspectInstallState(home);
    if (!install.committed) throw new Error('fixture install missing');
    for (const target of targets) {
      atomicWriteOwnerOnly(target.path, oldContent, { mode: 0o600 });
      const receipt = install.state.resources.find((item) => item.id === target.resourceId)!;
      receipt.ownership.installedSha256 = oldSha;
    }
    writeInstallState(install.state, home);

    const inspection = await inspectSetupEnvironment({
      buildInfo: BUILD_INFO,
      executablePath: join(machine, 'bin', 'cosyncing'),
      home,
      context: contextFor(machine),
    });
    const staleChecks = inspection.doctor.sections.flatMap((section) => section.checks)
      .filter((candidate) => candidate.id.startsWith('state.agent-skill.'));
    check('doctor reports receipt-proved stale skill copies as agent-skill-stale (non-fail)',
      staleChecks.length === 2
        && staleChecks.every((candidate) => candidate.detailCode === 'agent-skill-stale' && candidate.status === 'warn'),
      staleChecks.map((candidate) => candidate.detailCode).join(','));

    const upgradePlan = buildSetupPlan({
      inspection,
      choices: { language: 'en', service: 'foreground', enableLingering: false, quotaWarnings: false, installAgentSkill: true, installOpencodeShim: true },
      now,
    });
    const reconcile = upgradePlan.actions.find((action) => action.id === 'agent-skill.reconcile');
    check('setup plans a non-blocking refresh for owned-stale skill copies',
      upgradePlan.blockingIssues.length === 0 && !!reconcile
        && /refresh/i.test(`${reconcile.title} ${reconcile.summary}`),
      `blockers=${upgradePlan.blockingIssues.map((issue) => issue.code).join(',')} title=${reconcile?.title}`);

    const upgraded = await zeroAgentSetup(machine, new ScriptedPresenter());
    const afterInstall = inspectInstallState(home);
    check('re-running setup upgrades owned-stale skill copies in place and refreshes their receipts',
      upgraded.status === 'complete'
        && upgraded.actions.includes('agent-skill.reconcile')
        && targets.every((target) => readFileSync(target.path, 'utf8') === AGENT_SKILL_SOURCE)
        && afterInstall.committed
        && targets.every((target) => afterInstall.state.resources.some((item) =>
          item.id === target.resourceId && item.ownership.installedSha256 === AGENT_SKILL_SHA256)),
      `${upgraded.status}:${upgraded.actions.join(',')}`);
  }

  // An unowned/modified copy (no receipt proving its content) still blocks setup, fail-closed and preserved.
  {
    const machine = join(root, 'skill-known-legacy');
    const agentsSkill = join(machine, '.agents', 'skills', 'cosyncing', 'SKILL.md');
    mkdirSync(dirname(agentsSkill), { recursive: true });
    writeFileSync(agentsSkill, AGENT_SKILL_V010_FIXTURE, { mode: 0o600 });
    const presenter = new ScriptedPresenter({ legacySkill: true });
    const upgraded = await zeroAgentSetup(machine, presenter);
    const targets = agentSkillTargets(contextFor(machine));
    check('setup identifies and separately confirms the known preceding cosyncing skill',
      upgraded.status === 'complete'
        && presenter.calls.indexOf('skill') < presenter.calls.indexOf('legacy-skill')
        && presenter.calls.indexOf('legacy-skill') < presenter.calls.indexOf('opencode-shim')
        && targets.every((target) => readFileSync(target.path, 'utf8') === AGENT_SKILL_SOURCE),
      `${upgraded.status}:${presenter.calls.join(',')}`);
  }
  {
    const machine = join(root, 'skill-known-legacy-declined');
    const agentsSkill = join(machine, '.agents', 'skills', 'cosyncing', 'SKILL.md');
    mkdirSync(dirname(agentsSkill), { recursive: true });
    writeFileSync(agentsSkill, AGENT_SKILL_V010_FIXTURE, { mode: 0o600 });
    const presenter = new ScriptedPresenter({ legacySkill: false });
    const declined = await zeroAgentSetup(machine, presenter);
    check('declining the known skill upgrade preserves it and commits nothing',
      declined.status === 'declined'
        && readFileSync(agentsSkill, 'utf8') === AGENT_SKILL_V010_FIXTURE
        && !inspectInstallState(join(machine, '.cosyncing')).committed,
      `${declined.status}:${presenter.calls.join(',')}`);
  }
  {
    const machine = join(root, 'skill-legacy-modified');
    const agentsSkill = join(machine, '.agents', 'skills', 'cosyncing', 'SKILL.md');
    const modified = `${AGENT_SKILL_V010_FIXTURE}\nuser note\n`;
    mkdirSync(dirname(agentsSkill), { recursive: true });
    writeFileSync(agentsSkill, modified, { mode: 0o600 });
    const presenter = new ScriptedPresenter({ legacySkill: true });
    const blocked = await zeroAgentSetup(machine, presenter);
    check('an edited older skill remains unknown, blocked, and untouched',
      blocked.status === 'blocked'
        && blocked.issueCodes?.includes('agent-skill-agents-drifted') === true
        && !presenter.calls.includes('legacy-skill')
        && readFileSync(agentsSkill, 'utf8') === modified,
      `${blocked.status}:${blocked.issueCodes?.join(',')}`);
  }

  {
    const machine = join(root, 'skill-unowned');
    const claudeSkill = join(machine, '.claude', 'skills', 'cosyncing', 'SKILL.md');
    mkdirSync(join(machine, '.claude', 'skills', 'cosyncing'), { recursive: true });
    atomicWriteOwnerOnly(claudeSkill, '# user-authored skill\n', { mode: 0o600 });
    const presenter = new ScriptedPresenter();
    const blocked = await zeroAgentSetup(machine, presenter);
    check('an unowned modified skill copy blocks setup and is preserved',
      blocked.status === 'blocked'
        && blocked.issueCodes?.includes('agent-skill-claude-drifted') === true
        && readFileSync(claudeSkill, 'utf8') === '# user-authored skill\n'
        && presenter.calls.includes('blockers'),
      `${blocked.status}:${blocked.issueCodes?.join(',')}`);
  }

  // A failed later step rolls all earlier file mutations back.
  {
    const machine = join(root, 'rollback');
    const home = join(machine, '.cosyncing');
    const factory = (inputs: SetupActionInputs) => {
      const catalog = createSetupActionCatalog(inputs);
      return {
        ...catalog,
        actions: catalog.actions.map((action): SetupTransactionAction => action.id !== 'setup-state.write'
          ? action
          : {
              ...action,
              async apply(context) {
                await action.apply(context);
                throw new Error('fixture failure after setup-state write');
              },
            }),
      };
    };
    const failed = await runSetup(setupOptions(machine, new ScriptedPresenter(), { actionCatalogFactory: factory }));
    check('failed-step rollback removes every completed reversible file mutation',
      failed.status === 'failed' && failed.exitCode === 3
        && !existsSync(join(home, 'config.json'))
        && !existsSync(join(home, 'setup-state.json'))
        && !existsSync(join(home, 'secrets', 'broker-token'))
        && !existsSync(join(home, 'install-state.json'))
        && !readSetupTransactionJournal(home));
    // "Setup failed" alone is what a physical audit reported as unusable. The failing action and the raw
    // error text it threw must both reach the operator.
    check('a failed action names itself and quotes the underlying error',
      failed.failure?.code === 'action-failed'
        && failed.failure.step.includes('setup-state.write')
        && failed.failure.detail === 'fixture failure after setup-state write'
        && failed.failure.rollback === 'complete'
        && failed.failure.diagnosticPath === setupFailureDiagnosticPath(home),
      `${failed.failure?.step} — ${failed.failure?.detail}`);
    const diagnostic = readSetupFailureDiagnostic(home);
    check('the persisted diagnostic records the failing action, stage, and transaction id',
      diagnostic?.actionId === 'setup-state.write' && diagnostic.stage === 'applying'
        && diagnostic.code === 'action-failed'
        && diagnostic.detail === 'fixture failure after setup-state write'
        && diagnostic.transactionId.length > 0,
      JSON.stringify(diagnostic));
    // Rollback restores files; it must also drop the directories its own writes created and then emptied.
    check('rollback leaves no empty directories behind from the reverted writes',
      !existsSync(join(home, 'secrets')) && !existsSync(join(home, 'transactions')),
      `secrets=${existsSync(join(home, 'secrets'))} transactions=${existsSync(join(home, 'transactions'))}`);
    let nonInteractive = '';
    createNonInteractiveSetupPresenter({ write: (value) => { nonInteractive += value; } })
      .failed(failed);
    check('the non-interactive presenter prints the reason, not just the status line',
      nonInteractive.includes('reason=fixture failure after setup-state write')
        && nonInteractive.includes('step=')
        && nonInteractive.includes(`diagnostic=${setupFailureDiagnosticPath(home)}`),
      nonInteractive.trim());
  }

  // A rollback failure is not mislabeled as clean: exit 4 preserves the journal for repair.
  {
    const machine = join(root, 'rollback-incomplete');
    const home = join(machine, '.cosyncing');
    const factory = (inputs: SetupActionInputs) => {
      const catalog = createSetupActionCatalog(inputs);
      return {
        ...catalog,
        actions: catalog.actions.map((action): SetupTransactionAction => {
          if (action.id === 'config.ensure') {
            return { ...action, rollback: () => { throw new Error('fixture rollback failure'); } };
          }
          if (action.id === 'setup-state.write') {
            return {
              ...action,
              async apply(context) {
                await action.apply(context);
                throw new Error('fixture apply failure');
              },
            };
          }
          return action;
        }),
      };
    };
    const failed = await runSetup(setupOptions(machine, new ScriptedPresenter(), { actionCatalogFactory: factory }));
    const journal = readSetupTransactionJournal(home);
    check('incomplete rollback exits 4 and preserves a failed journal for recovery',
      failed.status === 'failed' && failed.exitCode === 4
        && journal?.stage === 'failed' && failed.summary.includes('cleanup remains'));
    // The remediation must name the command that actually resolves this. `repair` reconciles COMMITTED
    // state and never consumes setup journals; a physical run followed that advice and got
    // "already matches declared state" while the transaction sat pending and the service stayed changed.
    check('the cleanup-required remediation points at setup, which owns the journal, not repair',
      /rerun `?cosyncing setup/.test(failed.summary) && !/cosyncing repair/.test(failed.summary),
      failed.summary);
    // Rollback is best-effort across ALL pending actions. `config.ensure` throws above, and aborting the
    // chain there used to strand every action applied BEFORE it — including the service posture, the most
    // consequential entry. Only the action that genuinely failed may remain in the journal.
    const remaining = [
      ...(journal?.inFlight ? [journal.inFlight.id] : []),
      ...(journal?.applied ?? []).map((item) => item.id),
    ];
    check('one failing rollback does not strand the actions applied before it',
      remaining.length > 0 && remaining.every((id) => id === 'config.ensure'),
      remaining.join(','));
    // The diagnostic is written after rollback settles, so it can state that cleanup did not finish while
    // still naming the ORIGINAL cause rather than the rollback error that masked it.
    check('an incomplete rollback still records the original cause and flags the remaining cleanup',
      failed.failure?.rollback === 'incomplete'
        && failed.failure.code === 'action-failed'
        && failed.failure.detail === 'fixture apply failure'
        && readSetupFailureDiagnostic(home)?.rollback === 'incomplete',
      `${failed.failure?.code}/${failed.failure?.rollback}: ${failed.failure?.detail}`);
  }

  // Repair must refuse to run against a pending setup transaction rather than reporting a clean machine.
  {
    const machine = join(root, 'repair-stale-journal');
    const home = join(machine, '.cosyncing');
    const factory = (inputs: SetupActionInputs) => {
      const catalog = createSetupActionCatalog(inputs);
      return {
        ...catalog,
        actions: catalog.actions.map((action): SetupTransactionAction => (action.id === 'config.ensure'
          ? {
              ...action,
              rollback: () => { throw new Error('fixture rollback failure'); },
              async apply(context) {
                await action.apply(context);
                throw new Error('fixture apply failure');
              },
            }
          : action)),
      };
    };
    await runSetup(setupOptions(machine, new ScriptedPresenter(), { actionCatalogFactory: factory }));
    const pending = readSetupTransactionJournal(home);
    const { inspectRepair, runRepair } = await import('../../src/installation/broker-lifecycle.ts');
    const repairOptions = {
      home,
      buildInfo: BUILD_INFO,
      executablePath: join(machine, 'bin', 'cosyncing'),
      context: contextFor(machine),
    };
    const plan = await inspectRepair(repairOptions);
    const attempted = await runRepair({ ...repairOptions, confirmed: true, allowLegacyIntegrations: false });
    check('repair blocks on a pending setup transaction instead of claiming the install already matches',
      !!pending
        && plan.blockers.some((item) => item.detailCode === 'repair-setup-transaction-pending')
        && attempted.status === 'blocked'
        // The journal is left for setup's recovery to consume, never silently discarded by repair.
        && !!readSetupTransactionJournal(home),
      `${plan.blockers.map((item) => item.detailCode).join(',')} / ${attempted.status}`);
  }

  // A killed process leaves an in-flight journal; the next setup deterministically rolls it back first.
  {
    const machine = join(root, 'recovery');
    const home = join(machine, '.cosyncing');
    const marker = join(root, 'crash-ready');
    const child = Bun.spawn(['bun', import.meta.path, '--crash-child', home, marker], {
      cwd: join(import.meta.dir, '../../../../..'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    for (let index = 0; index < 200 && !existsSync(marker); index += 1) await Bun.sleep(10);
    check('crash fixture reaches a journaled in-flight mutation', existsSync(marker) && !!readSetupTransactionJournal(home));
    child.kill('SIGKILL');
    await child.exited;
    const presenter = new ScriptedPresenter();
    const recovered = await zeroAgentSetup(machine, presenter);
    check('next setup rolls back the interrupted transaction before replanning',
      recovered.status === 'complete' && recovered.recoveredInterruptedTransaction
        && presenter.calls[0] === 'recovered' && !readSetupTransactionJournal(home)
        && inspectInstallState(home).committed,
      presenter.calls.join(','));
  }

  // Port conflicts are visible and never killed.
  {
    const machine = join(root, 'port-conflict');
    const base = contextFor(machine);
    const conflictContext = {
      ...base,
      probeTcp: async () => 'open' as const,
      fetchJson: async () => ({ status: 'ok' as const, statusCode: 200, json: { service: 'contributor' } }),
    };
    const presenter = new ScriptedPresenter();
    const blocked = await runSetup(setupOptions(machine, presenter, { context: conflictContext }));
    check('unowned port 7734 blocks safely with actionable remediation and no mutation',
      blocked.status === 'blocked' && blocked.issueCodes?.includes('broker-port-conflict') === true
        && !existsSync(join(machine, '.cosyncing')) && presenter.calls.includes('blockers'));
  }

  // A current-schema legacy state file whose only defect is its mode is safe to tighten inside setup's
  // transaction. Any content/schema ambiguity remains a preflight blocker, and rollback restores the mode.
  {
    const machine = join(root, 'durable-setup-unversioned');
    const home = join(machine, '.cosyncing');
    const setupState = join(home, 'setup-state.json');
    mkdirSync(home, { recursive: true });
    writeFileSync(setupState, JSON.stringify({ language: 'zh-Hans' }), { mode: 0o600 });
    const layout = durableStateLayout({
      stateRoot: home,
      cacheRoot: join(machine, '.cache', 'cosyncing'),
    });
    const migration = planDurableStateMigrations(layout);
    const before = treeSnapshot(machine);
    const presenter = new ScriptedPresenter();
    const blocked = await zeroAgentSetup(machine, presenter);
    const issue = presenter.lastBlockers?.find((candidate) => candidate.code === 'setup-unversioned');
    check('a known migratable unversioned store blocks preflight before mutation choices or writes',
      migration.steps.some((step) => step.store === 'setup')
        && blocked.status === 'blocked'
        && blocked.issueCodes?.includes('setup-unversioned') === true
        && presenter.calls.join(',') === 'language,intro,blockers,failed'
        && treeSnapshot(machine) === before
        && issue?.remediation.includes('move the existing setup state file') === true
        && issue.localized?.['zh-Hans']?.remediation.includes('移出') === true,
      `${blocked.status}:${presenter.calls.join(',')}:${blocked.issueCodes?.join(',')}`);
  }
  {
    const machine = join(root, 'durable-peers-unversioned');
    const home = join(machine, '.cosyncing');
    const peers = join(home, 'transport-peers.json');
    mkdirSync(home, { recursive: true });
    writeFileSync(peers, JSON.stringify({ peers: [] }), { mode: 0o600 });
    const layout = durableStateLayout({
      stateRoot: home,
      cacheRoot: join(machine, '.cache', 'cosyncing'),
    });
    const migration = planDurableStateMigrations(layout);
    const before = treeSnapshot(machine);
    const presenter = new ScriptedPresenter();
    const blocked = await zeroAgentSetup(machine, presenter);
    const issue = presenter.lastBlockers?.find((candidate) => candidate.code === 'peers-unversioned');
    check('a non-migratable unversioned store blocks preflight before mutation choices or writes',
      migration.blockers.some((item) => item.store === 'peers' && item.detailCode === 'peers-unversioned')
        && blocked.status === 'blocked'
        && blocked.issueCodes?.includes('peers-unversioned') === true
        && presenter.calls.join(',') === 'language,intro,blockers,failed'
        && treeSnapshot(machine) === before
        && issue?.remediation.includes('will not guess an unversioned format') === true
        && issue.localized?.['zh-Hans']?.summary.includes('不支持自动迁移') === true,
      `${blocked.status}:${presenter.calls.join(',')}:${blocked.issueCodes?.join(',')}`);
  }
  {
    const machine = join(root, 'durable-peers-permissions');
    const peers = join(machine, '.cosyncing', 'transport-peers.json');
    mkdirSync(dirname(peers), { recursive: true });
    writeFileSync(peers, JSON.stringify({ version: 1, peers: [] }), { mode: 0o644 });
    chmodSync(peers, 0o644);
    const complete = await zeroAgentSetup(machine, new ScriptedPresenter());
    const inspection = await inspectSetupEnvironment({
      buildInfo: BUILD_INFO,
      executablePath: join(machine, 'bin', 'cosyncing'),
      home: join(machine, '.cosyncing'),
      context: contextFor(machine),
    });
    const peerDoctor = inspection.doctor.sections.flatMap((section) => section.checks)
      .find((candidate) => candidate.id === 'state.schema.peers');
    check('setup transactionally tightens a valid owner-held legacy peers file before committing',
      complete.status === 'complete'
        && complete.actions.includes('durable-state.permissions')
        && (statSync(peers).mode & 0o777) === 0o600
        && peerDoctor?.status === 'pass'
        && inspectInstallState(join(machine, '.cosyncing')).committed,
      `${complete.status}:mode=${(statSync(peers).mode & 0o777).toString(8)} doctor=${peerDoctor?.status}`);
  }
  {
    const machine = join(root, 'durable-peers-malformed');
    const peers = join(machine, '.cosyncing', 'transport-peers.json');
    mkdirSync(dirname(peers), { recursive: true });
    writeFileSync(peers, '{"version":1', { mode: 0o644 });
    chmodSync(peers, 0o644);
    const blocked = await zeroAgentSetup(machine, new ScriptedPresenter());
    check('setup blocks malformed loose-mode durable state instead of laundering it with chmod',
      blocked.status === 'blocked'
        && blocked.issueCodes?.includes('peers-unsafe') === true
        && readFileSync(peers, 'utf8') === '{"version":1'
        && (statSync(peers).mode & 0o777) === 0o644
        && !inspectInstallState(join(machine, '.cosyncing')).committed,
      `${blocked.status}:${blocked.issueCodes?.join(',')}`);
  }
  {
    const machine = join(root, 'durable-peers-rollback');
    const peers = join(machine, '.cosyncing', 'transport-peers.json');
    const original = JSON.stringify({ version: 1, peers: [] });
    mkdirSync(dirname(peers), { recursive: true });
    writeFileSync(peers, original, { mode: 0o644 });
    chmodSync(peers, 0o644);
    const factory = (inputs: SetupActionInputs) => {
      const catalog = createSetupActionCatalog(inputs);
      return {
        ...catalog,
        actions: catalog.actions.map((action): SetupTransactionAction => action.id !== 'agent-skill.reconcile'
          ? action
          : {
              ...action,
              async apply(context) {
                await action.apply(context);
                throw new Error('fixture failure after durable permission repair');
              },
            }),
      };
    };
    const failed = await runSetup(setupOptions(machine, new ScriptedPresenter(), { actionCatalogFactory: factory }));
    check('a later setup failure restores the legacy peers bytes and permissions',
      failed.status === 'failed'
        && readFileSync(peers, 'utf8') === original
        && (statSync(peers).mode & 0o777) === 0o644
        && !inspectInstallState(join(machine, '.cosyncing')).committed,
      `${failed.status}:mode=${(statSync(peers).mode & 0o777).toString(8)}`);
  }

  // First-install migration owns its own confirmation path. Only the full preceding packaged source is
  // eligible; a copied marker plus any edit remains foreign and blocks before mutation.
  {
    const machine = join(root, 'pi-known-legacy');
    const { context, bridge } = supportedPiFixture(machine);
    mkdirSync(dirname(bridge), { recursive: true });
    writeFileSync(bridge, PI_BRIDGE_V010_FIXTURE, { mode: 0o600 });
    const presenter = new ScriptedPresenter({ legacyPi: true });
    const migrated = await runSetup(setupOptions(machine, presenter, { context }));
    check('first-time setup separately confirms and replaces the exact known legacy Pi bridge',
      migrated.status === 'complete'
        && migrated.actions.includes('pi-bridge.install')
        && readFileSync(bridge, 'utf8') === PI_BRIDGE_EMBEDDED_SOURCE
        && presenter.calls.indexOf('ack') < presenter.calls.indexOf('legacy-pi')
        && presenter.calls.indexOf('legacy-pi') < presenter.calls.indexOf('skill')
        && inspectInstallState(join(machine, '.cosyncing')).committed,
      `${migrated.status}:${presenter.calls.join(',')}`);
  }
  {
    const machine = join(root, 'pi-known-legacy-declined');
    const { context, bridge } = supportedPiFixture(machine);
    mkdirSync(dirname(bridge), { recursive: true });
    writeFileSync(bridge, PI_BRIDGE_V010_FIXTURE, { mode: 0o600 });
    const presenter = new ScriptedPresenter({ legacyPi: false });
    const declined = await runSetup(setupOptions(machine, presenter, { context }));
    check('declining the separate legacy Pi migration preserves the bridge and commits nothing',
      declined.status === 'declined'
        && readFileSync(bridge, 'utf8') === PI_BRIDGE_V010_FIXTURE
        && !inspectInstallState(join(machine, '.cosyncing')).committed,
      `${declined.status}:${presenter.calls.join(',')}`);
  }
  {
    const machine = join(root, 'pi-known-legacy-rollback');
    const { context, bridge } = supportedPiFixture(machine);
    mkdirSync(dirname(bridge), { recursive: true });
    writeFileSync(bridge, PI_BRIDGE_V010_FIXTURE, { mode: 0o600 });
    const factory = (inputs: SetupActionInputs) => {
      const catalog = createSetupActionCatalog(inputs);
      return {
        ...catalog,
        actions: catalog.actions.map((action): SetupTransactionAction => action.id !== 'agent-skill.reconcile'
          ? action
          : {
              ...action,
              async apply(actionContext) {
                await action.apply(actionContext);
                throw new Error('fixture failure after legacy Pi replacement');
              },
            }),
      };
    };
    const failed = await runSetup(setupOptions(
      machine,
      new ScriptedPresenter({ legacyPi: true }),
      { context, actionCatalogFactory: factory },
    ));
    check('a later setup failure restores the exact legacy Pi bridge bytes',
      failed.status === 'failed'
        && readFileSync(bridge, 'utf8') === PI_BRIDGE_V010_FIXTURE
        && !inspectInstallState(join(machine, '.cosyncing')).committed,
      failed.status);
  }
  {
    const machine = join(root, 'pi-marker-modified');
    const { context, bridge } = supportedPiFixture(machine);
    const modified = `${PI_BRIDGE_V010_FIXTURE}\n// local change\n`;
    mkdirSync(dirname(bridge), { recursive: true });
    writeFileSync(bridge, modified, { mode: 0o600 });
    const presenter = new ScriptedPresenter({ legacyPi: true });
    const blocked = await runSetup(setupOptions(machine, presenter, { context }));
    check('a marker-bearing modified Pi bridge remains blocked and is never offered for migration',
      blocked.status === 'blocked'
        && blocked.issueCodes?.includes('pi-bridge-unowned') === true
        && !presenter.calls.includes('legacy-pi')
        && readFileSync(bridge, 'utf8') === modified,
      `${blocked.status}:${blocked.issueCodes?.join(',')}`);
  }

  // A committed package-hash receipt upgrades the prior packaged bridge automatically. The receipt, safe
  // file bytes, and canonical target form one ownership proof; any missing or mismatched part fails closed.
  {
    const machine = join(root, 'pi-owned-stale-setup');
    const { context, bridge } = supportedPiFixture(machine);
    const home = join(machine, '.cosyncing');
    await runSetup(setupOptions(machine, new ScriptedPresenter(), { context }));
    const priorPackaged = `${PI_BRIDGE_EMBEDDED_SOURCE}\n// prior packaged comment\n`;
    atomicWriteOwnerOnly(bridge, priorPackaged, { mode: 0o600 });
    const install = inspectInstallState(home);
    if (!install.committed) throw new Error('fixture install missing');
    install.state.resources.find((item) => item.id === 'pi-bridge')!.ownership.installedSha256 = sha256(priorPackaged);
    writeInstallState(install.state, home);

    const presenter = new ScriptedPresenter();
    const refreshed = await runSetup(setupOptions(machine, presenter, { context }));
    const after = inspectInstallState(home);
    check('receipt-proven prior packaged Pi bridge refreshes through setup without a legacy prompt',
      refreshed.status === 'complete'
        && refreshed.actions.includes('pi-bridge.install')
        && !presenter.calls.includes('legacy-pi')
        && readFileSync(bridge, 'utf8') === PI_BRIDGE_EMBEDDED_SOURCE
        && after.committed
        && after.state.resources.some((item) => item.id === 'pi-bridge'
          && item.ownership.installedSha256 === PI_BRIDGE_EMBEDDED_SHA256),
      `${refreshed.status}:${presenter.calls.join(',')}`);
  }
  {
    const machine = join(root, 'pi-user-edit');
    const { context, bridge } = supportedPiFixture(machine);
    await runSetup(setupOptions(machine, new ScriptedPresenter(), { context }));
    const edited = `${PI_BRIDGE_EMBEDDED_SOURCE}\n// user edit\n`;
    atomicWriteOwnerOnly(bridge, edited, { mode: 0o600 });
    const blocked = await runSetup(setupOptions(machine, new ScriptedPresenter(), { context }));
    check('a Pi bridge edited after installation remains blocked and untouched',
      blocked.status === 'blocked'
        && blocked.issueCodes?.includes('pi-bridge-receipt-invalid') === true
        && readFileSync(bridge, 'utf8') === edited,
      `${blocked.status}:${blocked.issueCodes?.join(',')}`);
  }
  {
    const outcomes: string[] = [];
    for (const receiptCase of ['missing', 'wrong-target', 'mismatched'] as const) {
      const machine = join(root, `pi-stale-${receiptCase}`);
      const { context, bridge } = supportedPiFixture(machine);
      const home = join(machine, '.cosyncing');
      await runSetup(setupOptions(machine, new ScriptedPresenter(), { context }));
      const priorPackaged = `${PI_BRIDGE_EMBEDDED_SOURCE}\n// ${receiptCase} prior package\n`;
      atomicWriteOwnerOnly(bridge, priorPackaged, { mode: 0o600 });
      const install = inspectInstallState(home);
      if (!install.committed) throw new Error('fixture install missing');
      const receiptIndex = install.state.resources.findIndex((item) => item.id === 'pi-bridge');
      const receipt = install.state.resources[receiptIndex]!;
      if (receiptCase === 'missing') install.state.resources.splice(receiptIndex, 1);
      else if (receiptCase === 'wrong-target') {
        receipt.target = join(machine, 'other', 'index.ts');
        receipt.ownership.installedSha256 = sha256(priorPackaged);
      } else receipt.ownership.installedSha256 = sha256('different packaged bytes');
      writeInstallState(install.state, home);
      const blocked = await runSetup(setupOptions(machine, new ScriptedPresenter(), { context }));
      outcomes.push(`${receiptCase}:${blocked.status}:${blocked.issueCodes?.join(',')}`);
      if (blocked.status !== 'blocked' || readFileSync(bridge, 'utf8') !== priorPackaged) {
        outcomes.push(`${receiptCase}:unexpected-mutation`);
      }
    }
    check('missing, wrong-target, and mismatched Pi receipts cannot authorize a stale bridge refresh',
      outcomes.length === 3 && outcomes.every((outcome) => outcome.includes(':blocked:')),
      outcomes.join(' | '));
  }
  {
    const outcomes: string[] = [];
    for (const unsafeCase of ['loose-mode', 'symlink', 'broken-symlink'] as const) {
      const machine = join(root, `pi-unsafe-${unsafeCase}`);
      const { context, bridge } = supportedPiFixture(machine);
      await runSetup(setupOptions(machine, new ScriptedPresenter(), { context }));
      if (unsafeCase === 'loose-mode') {
        chmodSync(bridge, 0o644);
      } else if (unsafeCase === 'symlink') {
        const userFile = join(machine, 'user-owned-extension.ts');
        writeFileSync(userFile, PI_BRIDGE_EMBEDDED_SOURCE, { mode: 0o600 });
        rmSync(bridge);
        symlinkSync(userFile, bridge);
      } else {
        rmSync(bridge);
        symlinkSync(join(machine, 'missing-extension.ts'), bridge);
      }
      const blocked = await runSetup(setupOptions(machine, new ScriptedPresenter(), { context }));
      outcomes.push(`${unsafeCase}:${blocked.status}:${blocked.issueCodes?.join(',')}`);
      if (unsafeCase === 'symlink' && !statSync(join(machine, 'user-owned-extension.ts')).isFile()) {
        outcomes.push('symlink:target-removed');
      }
    }
    check('unsafe-mode, symlinked, and broken-symlink Pi bridge targets remain blocked',
      outcomes.length === 3
        && outcomes.every((outcome) => outcome.includes(':blocked:pi-bridge-unsafe')),
      outcomes.join(' | '));
  }
  {
    const outcomes: string[] = [];
    for (const changed of ['file', 'receipt'] as const) {
      const machine = join(root, `pi-toctou-${changed}`);
      const { context, bridge } = supportedPiFixture(machine);
      const home = join(machine, '.cosyncing');
      await runSetup(setupOptions(machine, new ScriptedPresenter(), { context }));
      const priorPackaged = `${PI_BRIDGE_EMBEDDED_SOURCE}\n// prior package for ${changed} race\n`;
      atomicWriteOwnerOnly(bridge, priorPackaged, { mode: 0o600 });
      const install = inspectInstallState(home);
      if (!install.committed) throw new Error('fixture install missing');
      install.state.resources.find((item) => item.id === 'pi-bridge')!.ownership.installedSha256 = sha256(priorPackaged);
      writeInstallState(install.state, home);
      const factory = (inputs: SetupActionInputs) => {
        const catalog = createSetupActionCatalog(inputs);
        return {
          ...catalog,
          actions: catalog.actions.map((action): SetupTransactionAction => action.id !== 'pi-bridge.install'
            ? action
            : {
                ...action,
                apply(actionContext) {
                  if (changed === 'file') {
                    atomicWriteOwnerOnly(bridge, `${priorPackaged}// concurrent edit\n`, { mode: 0o600 });
                  } else {
                    const concurrent = inspectInstallState(home);
                    if (!concurrent.committed) throw new Error('fixture install missing');
                    concurrent.state.resources.find((item) => item.id === 'pi-bridge')!
                      .ownership.installedSha256 = sha256('concurrent receipt');
                    writeInstallState(concurrent.state, home);
                  }
                  return action.apply(actionContext);
                },
              }),
        };
      };
      const failed = await runSetup(setupOptions(
        machine,
        new ScriptedPresenter(),
        { context, actionCatalogFactory: factory },
      ));
      outcomes.push(`${changed}:${failed.status}:${readFileSync(bridge, 'utf8') === priorPackaged}`);
    }
    check('file or Pi receipt changes between planning and replacement abort and roll back bridge bytes',
      outcomes.every((outcome) => /:(failed|blocked):true$/.test(outcome)),
      outcomes.join(' | '));
  }

  // Supported Pi gets the exact package-owned bridge; no migration question is introduced.
  {
    const machine = join(root, 'pi');
    const { context, bridge } = supportedPiFixture(machine);
    const presenter = new ScriptedPresenter();
    const installed = await runSetup(setupOptions(machine, presenter, { context }));
    check('supported Pi installs the exact packaged bridge under the one global acknowledgement',
      installed.status === 'complete' && existsSync(bridge)
        && presenter.calls.filter((call) => call === 'ack').length === 1
        && !presenter.calls.some((call) => /legacy|mode|claude|hook/.test(call)));
  }

  // The outro: state directory, only the endpoints the applied plan actually produced, and the shared token
  // as a path plus a read command. The raw secret value never appears in either presenter's output.
  {
    const machine = join(root, 'presenter-credential');
    const setup = await zeroAgentSetup(machine, new ScriptedPresenter({ quota: true }));
    const home = join(machine, '.cosyncing');
    if (setup.status !== 'complete') throw new Error(`fixture setup did not complete: ${setup.status}`);
    const inspection = await inspectSetupEnvironment({
      buildInfo: BUILD_INFO,
      executablePath: join(machine, 'bin', 'cosyncing'),
      home,
      context: contextFor(machine),
    });
    const tokenPath = brokerTokenPath(home);
    const actualToken = readBrokerToken(tokenPath);
    const loopbackUrl = inspection.targetConfig.broker.internalUrl;
    const resultWith = (access: SetupAccessReport): SetupCommandResult => ({
      schemaVersion: 1,
      status: 'complete',
      exitCode: 0,
      summaryCode: 'complete',
      summary: 'Setup committed successfully.',
      actions: [],
      agents: inspection.agents,
      access,
      recoveredInterruptedTransaction: false,
    });
    const successResult = resultWith({ stateHome: home, loopbackUrl, webApp: true, brokerListening: true });

    // The applied plan is the only source of the outro's endpoints. A LAN address would be the lie that
    // matters most here — the broker binds config.broker.host, which setup only ever writes as 127.0.0.1 —
    // so the report carries loopback plus, when the Serve route was registered, the tailnet name. Nothing else.
    check('setup reports the state directory and only the endpoints the plan produced',
      setup.access.stateHome === home
        && setup.access.loopbackUrl === loopbackUrl
        && setup.access.webApp === inspection.webAppAvailable,
      JSON.stringify(setup.access));

    // A foreground setup starts nothing. The outro used to say "Open the app on this machine" anyway, which
    // is a dead link on an install where no broker is running — the configured URL was mistaken for a served
    // one. Only the durable-service path health-checks a listener, so this run must report none and every
    // surface must lead with the command that starts one, in whichever language the wizard ran.
    check('a foreground setup completes with no listener and never claims a served URL',
      setup.access.brokerListening === false,
      JSON.stringify(setup.access));
    {
      const openAccess: SetupAccessReport = { stateHome: home, loopbackUrl, webApp: true, brokerListening: false };
      const renderOutro = (language: SetupLanguage): string => {
        let captured = '';
        createNonInteractiveSetupPresenter({ write: (text) => { captured += text; } }, {
          acceptManagedRuntimeOwnership: true,
          enableSystemdLingering: false,
          installAgentSkill: true,
          opencodeShim: 'unset',
          language,
        }).complete(resultWith(openAccess));
        return captured;
      };
      const englishOutro = renderOutro('en');
      const chineseOutro = renderOutro('zh-Hans');
      check('the no-listener outro says to start the broker before opening the URL, in both languages',
        englishOutro.includes('[access] Nothing is listening yet. Start the broker: `cosyncing broker`.')
          && englishOutro.includes(`[access] Local web app: ${loopbackUrl}/cosy`)
          && englishOutro.includes(`[access] Local server address: ${loopbackUrl}`)
          && chineseOutro.includes('[access] broker 还没有在运行，先启动它：`cosyncing broker`。')
          && chineseOutro.includes(`[access] 本机 Web 应用：${loopbackUrl}/cosy`)
          && chineseOutro.includes(`[access] 本机服务器地址：${loopbackUrl}`),
        `${englishOutro}\n${chineseOutro}`);
      // The verified durable-service path is the only one that keeps the plain "open it" wording, and it
      // must keep it — a service setup that health-checked its broker should not send anyone to a terminal.
      let verified = '';
      createNonInteractiveSetupPresenter({ write: (text) => { verified += text; } })
        .complete(resultWith({ ...openAccess, brokerListening: true }));
      check('a health-verified install still tells the operator to just open the app',
        verified.includes(`[access] Local web app: ${loopbackUrl}/cosy`)
          && verified.includes(`[access] Local server address: ${loopbackUrl}`)
          && !/Nothing is listening/.test(verified),
        verified);
    }

    // Non-interactive (`--yes`) presenter: machine-oriented tagged lines.
    {
      let captured = '';
      const nonInteractive = createNonInteractiveSetupPresenter({ write: (text) => { captured += text; } });
      await nonInteractive.intro(inspection);
      await nonInteractive.complete(successResult);
      check('non-interactive outro prints tagged web and native-client endpoints plus one token-file instruction',
        captured.includes(`[access] State directory: ${home}`)
          && captured.includes(`[access] Local web app: ${loopbackUrl}/cosy`)
          && captured.includes(`[access] Local server address: ${loopbackUrl}`)
          && captured.includes('[access] Loopback only. External connectivity is managed by the operator.')
          && captured.includes('[access] Short command: `cosy` is an alias for `cosyncing`, for example `cosy status`, `cosy doctor`, `cosy update`.')
          && captured.includes(`[credential] Read authentication token file: cat ${tokenPath}`)
          && !captured.includes('[credential] Authentication token file:')
          && !captured.includes('[credential] Read it:')
          // The pairing recommendation must still carry BOTH halves of its substance: per-device revocation
          // is the reason to pair, and full API access is the reason not to hand the token around.
          && /revoke a single device/.test(captured)
          && /master secret: full broker API access/.test(captured)
          && !/poc.?ui/i.test(captured)
          && !captured.includes(actualToken),
        captured);
    }

    // R10 withheld the app URL from a build with no Flutter bundle, because it answered "not built".
    // R16 prints it: /cosy on such a build IS the user-facing pairing-guidance page, so the URL is a true
    // onward step. The property is now linkage, not omission — the outro names the URL, and the URL serves
    // that page. This half pins the copy; the served half is pinned in the runtime-assets suite, which has
    // a real packaged binary with no web sidecar to fetch it from.
    {
      let captured = '';
      const presenter = createNonInteractiveSetupPresenter({ write: (text) => { captured += text; } });
      await presenter.complete(resultWith({ stateHome: home, loopbackUrl, webApp: false, brokerListening: true }));
      check('an outro for a build with no web client prints the /cosy URL and leads with pairing',
        captured.includes('[access] Run `cosyncing pair` and scan the QR to pair a client.')
          && captured.includes(`[access] The same steps in a browser: ${loopbackUrl}/cosy`)
          && captured.includes(`[access] Local server address: ${loopbackUrl}`)
          // The wording must not promise an app that is not in this build.
          && !/Open the app on this machine/.test(captured)
          // R10 deleted the "no browser client, so there is no app URL" line: it explained an absence the
          // operator never asked about. What remains has to be the actionable half, and only that.
          && !/no app URL|browser client/i.test(captured)
          && captured.includes('[access] Loopback only. External connectivity is managed by the operator.'),
        captured);

      let chineseNoWeb = '';
      createNonInteractiveSetupPresenter({ write: (text) => { chineseNoWeb += text; } }, {
        acceptManagedRuntimeOwnership: true,
        enableSystemdLingering: false,
        installAgentSkill: true,
        opencodeShim: 'unset',
        language: 'zh-Hans',
      }).complete(resultWith({ stateHome: home, loopbackUrl, webApp: false, brokerListening: true }));
      check('the Chinese no-web outro carries the loopback /cosy URL',
        chineseNoWeb.includes(`[access] 浏览器里也有同样的步骤：${loopbackUrl}/cosy`)
          && chineseNoWeb.includes(`[access] 本机服务器地址：${loopbackUrl}`)
          && chineseNoWeb.includes('[access] 仅限回环访问。外部连接由操作者自行管理。')
          && chineseNoWeb.includes('[access] 快捷命令：`cosy` 是 `cosyncing` 的别名，例如 `cosy status`、`cosy doctor`、`cosy update`。'),
        chineseNoWeb);

      // Round 12 stays intact on this branch too: with nothing listening, every URL line is deferred
      // behind the command that starts a broker.
      let noListener = '';
      createNonInteractiveSetupPresenter({ write: (text) => { noListener += text; } })
        .complete(resultWith({ stateHome: home, loopbackUrl, webApp: false, brokerListening: false }));
      check('a no-web foreground outro still says to start the broker before opening the URL',
        noListener.includes('[access] Nothing is listening yet. Start the broker: `cosyncing broker`.')
          && noListener.includes(`[access] Then the same steps in a browser: ${loopbackUrl}/cosy`)
          && !noListener.includes(`[access] The same steps in a browser: ${loopbackUrl}/cosy`),
        noListener);
    }

    // Interactive (clack) presenter: capture its real terminal output via a temporary stdout shim.
    {
      const clack = createClackSetupPresenter();
      let captured = '';
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: unknown) => {
        captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
        return true;
      }) as typeof process.stdout.write;
      try {
        await clack.intro(inspection);
        await clack.complete(successResult);
      } finally {
        process.stdout.write = originalWrite;
      }
      // clack's note() box word-wraps long lines (it split the token path mid-word in
      // practice), so compare with ANSI codes, box-drawing borders, and all whitespace
      // stripped from both sides rather than a literal substring -- stripping the same
      // characters from both sides preserves character order, so a wrapped path still
      // reconstructs correctly.
      const squash = (text: string): string => text
        .replace(/\x1b\[[0-9;]*m/g, '')
        .replace(/[\u2500-\u257f\u25a0-\u25ff\s]/g, '');
      const plain = squash(captured);
      check('interactive outro shows the state directory, local app URL, and one token-file instruction, never the value',
        plain.includes(squash(`State directory: ${home}`))
          && plain.includes(squash(`${loopbackUrl}/cosy`))
          && plain.includes(squash(`Read authentication token file: cat ${tokenPath}`))
          && !plain.includes(squash('Authentication token file:'))
          && !plain.includes(squash('Read it:'))
          && plain.includes(squash('revoke a single device'))
          && plain.includes(squash('master secret: full broker API access'))
          && !/poc.?ui/i.test(plain)
          && !plain.includes(actualToken),
        captured);
    }
  }


  // Language is the wizard's first step, and the choice survives the run so a later one opens in it.
  {
    // Every catalog implements one interface, so a missing string is a build error rather than a blank
    // panel. This proves the two catalogs really carry different copy and that neither has empty entries.
    const english = setupMessages('en');
    const chinese = setupMessages('zh-Hans');
    const keys = Object.keys(english) as Array<keyof typeof english>;
    // Most catalog entries take one bag of named parts, so one generic bag renders them all. The few whose
    // argument is a union or a structured plan step need their own sample, or they would render `undefined`
    // identically in both catalogs and slip past the "not echoed back" check below.
    const samples: Partial<Record<keyof typeof english, unknown[]>> = {
      agentState: ['missing'],
      agentBehavior: ['codex'],
      codexStandaloneWarning: ['curl -fsSL https://chatgpt.com/codex/install.sh | sh'],
      outroShortCommand: ['cosy', ['cosy status', 'cosy doctor', 'cosy update']],
      planStep: [{ kind: 'credentials' }],
      resultSummary: ['complete', { binary: 'cosyncing', stage: 's' }],
    };
    const render = (messages: typeof english, key: keyof typeof english): string => {
      const entry = messages[key];
      if (typeof entry !== 'function') return String(entry);
      const args = samples[key] ?? [{
        product: 'cosyncing', version: 'v', install: 'i', state: 's', broker: 'b',
        detected: 'd', displayName: 'n', minimumVersion: 'm', upgrade: '',
        summary: 'x', remediation: 'y', provider: 'systemd', available: true,
      }];
      return String((entry as (...values: never[]) => string)(...(args as never[])));
    };
    check('every catalog key renders nonempty copy in both languages',
      keys.length > 30 && keys.every((key) => render(english, key).length > 0 && render(chinese, key).length > 0),
      `${keys.length} keys`);
    // Every plan row has to survive translation on its own. Coverage over the union is what stops a new step
    // kind from being added in English and rendering the English string in the Chinese wizard.
    const everyStep: SetupMutationStep[] = [
      { kind: 'config', configPath: '/h/config.json', internalUrl: 'http://127.0.0.1:8765' },
      { kind: 'credentials' },
      { kind: 'setup-state', service: 'systemd' },
      { kind: 'pi-bridge', path: '/h/.pi/x.ts' },
      { kind: 'pi-bridge', path: '/h/.pi/x.ts', replaceLegacy: true },
      { kind: 'durable-state-permissions', paths: ['/h/transport-peers.json'] },
      { kind: 'agent-skill-install' },
      { kind: 'agent-skill-refresh' },
      { kind: 'agent-skill-remove' },
      { kind: 'opencode-shim' },
      { kind: 'service-install', definitionPath: '/h/.config/systemd/user/cosyncing.service' },
      { kind: 'service-remove', provider: 'systemd', product: 'cosyncing' },
      { kind: 'binary-install', version: '0.1.0', path: '/h/bin/cosyncing' },
      { kind: 'commit-receipts', installStatePath: '/h/install-state.json' },
    ];
    check('every mutation-plan step renders differently in each language and keeps its literals',
      everyStep.every((step) => {
        const en = english.planStep(step);
        const zh = chinese.planStep(step);
        const literals = Object.values(step).filter((value) => typeof value === 'string' && value.includes('/'));
        return en.length > 0 && zh.length > 0 && en !== zh
          && literals.every((literal) => zh.includes(literal as string));
      }),
      everyStep.filter((step) => english.planStep(step) === chinese.planStep(step)).map((s) => s.kind).join(','));
    const shared = keys.filter((key) => render(english, key) === render(chinese, key));
    check('the Chinese catalog is real copy, not the English strings echoed back',
      shared.length === 0, shared.join(','));

    // The English catalog is the reference text, so these are byte-exact. Changing one is a deliberate copy
    // change; adding a translation must never move them.
    check('English copy is unchanged by the catalog seam',
      english.serviceQuestion === 'How should the broker run after setup?'
        && english.applyConfirm === 'Apply and verify this exact plan?'
        && english.planTitle === 'Exact mutation plan'
        && english.planEmpty === 'No filesystem or service mutation is required.'
        && english.agentSkillConfirm === 'Install the cosyncing agent skill so agents with a supported session-bound tool can deliver files to the app?'
        && english.quotaConfirm === 'Enable local token and usage quota tracking via Tokdash?'
        && english.installationTitle === 'Installation'
        && english.networkTitle === 'Network and authentication'
        && english.agentPreflightTitle === 'Agent preflight'
        && english.failureTitle === 'Why setup failed'
        && english.cancelledNote('x') === 'Setup cancelled during x. No mutation was applied.');
    // Terms that name a thing on the machine are what the operator types and searches for, so they stay
    // untranslated even inside Chinese sentences.
    check('Chinese copy keeps the terms an operator has to type',
      chinese.serviceDurableLabel('systemd').includes('systemd')
        && chinese.serviceDurableLabel('launchd').includes('launchd')
        && chinese.quotaConfirm.includes('Tokdash')
        // R10 reversed the R8 copy. Both catalogs must cover BOTH cases truthfully: reuse an instance that
        // is already running, or install one. Neither may still claim cosyncing installs nothing.
        && !/never installs|不会安装/.test(english.quotaNote('u', 'install') + chinese.quotaNote('u', 'install'))
        && english.quotaNote('http://127.0.0.1:55423', 'install').includes('pipx install tokdash')
        && english.quotaNote('http://127.0.0.1:55423', 'install').includes('is reused as-is and never modified')
        && chinese.quotaNote('http://127.0.0.1:55423', 'install').includes('pipx install tokdash')
        && chinese.quotaNote('http://127.0.0.1:55423', 'install').includes('直接复用')
        && chinese.quotaProvisioned('u', true).includes('Tokdash')
        && chinese.outroTokenRead('/p') === '查看认证令牌文件：cat /p'
        && chinese.outroPreferPairing('cosyncing').includes('broker API')
        && chinese.outroPairInstead('cosyncing').includes('cosyncing pair'));
    check('an unrecognized persisted or env language degrades to English, never to a blank wizard',
      normalizeSetupLanguage('klingon') === undefined
        && normalizeSetupLanguage(undefined) === undefined
        && setupMessages(normalizeSetupLanguage('klingon')).serviceQuestion === english.serviceQuestion);

    // Catalog-key coverage does not prove the WIZARD is Chinese: the mixed-language panels a physical run
    // produced were all composed outside the catalog. This renders the real clack presenter — the recovery
    // warning that precedes the language prompt, the intro panels, the mutation plan, the outro, and the
    // completion footer — and asserts nothing English-shaped survives in it.
    {
      const machine = join(root, 'chinese-wizard');
      mkdirSync(machine, { recursive: true });
      const inspection = await inspectSetupEnvironment({
        buildInfo: BUILD_INFO,
        executablePath: join(machine, 'bin', 'cosyncing'),
        home: join(machine, '.cosyncing'),
        context: contextFor(machine),
      });
      const plan = buildSetupPlan({
        inspection,
        choices: { language: 'zh-Hans', service: 'foreground', enableLingering: false, quotaWarnings: true, installAgentSkill: true, installOpencodeShim: true },
        now,
      });
      const clack = createClackSetupPresenter();
      let captured = '';
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: unknown) => {
        captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
        return true;
      }) as typeof process.stdout.write;
      try {
        // Before the language prompt, exactly as a real recovery run reaches it.
        await clack.recoveredInterruptedTransaction('zh-Hans');
        await clack.intro(inspection);
        await clack.showBlockers([{
          code: 'fixture-migration',
          summary: 'Existing legacy ownership needs explicit confirmation.',
          remediation: 'Back up the legacy target and rerun setup.',
          localized: {
            'zh-Hans': {
              summary: '现有旧版目标需要单独确认归属。',
              remediation: '请先备份旧版目标，然后重新运行安装。',
            },
          },
        }]);
        await clack.showPlan(plan, inspection);
        await clack.complete({
          schemaVersion: 1,
          status: 'complete',
          exitCode: 0,
          summaryCode: 'complete-no-agents',
          summary: 'Setup committed successfully. No supported coding agents were found; install one and rerun doctor.',
          actions: [],
          agents: inspection.agents,
          access: { stateHome: join(machine, '.cosyncing'), loopbackUrl: 'http://127.0.0.1:8765', webApp: false, brokerListening: false },
          recoveredInterruptedTransaction: true,
        });
      } finally {
        process.stdout.write = originalWrite;
      }
      // An English SENTENCE is what we are hunting, so the scan strips everything that is legitimately
      // literal in any language — ANSI, clack's box drawing, backticked commands, URLs, and filesystem
      // paths — and then looks for three or more consecutive ASCII words. Two-word technical names
      // (`Tailscale Serve`, `Claude Code`, `broker API`, `macOS LaunchAgent`) are deliberately below the
      // threshold: those are what the operator types and searches for, and they stay untranslated.
      const scanned = captured
        .replace(/\x1b\[[0-9;]*m/g, '')
        .replace(/[─-╿■-◿]/g, ' ')
        .replace(/`[^`]*`/g, ' ')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/\/\S+/g, ' ')
        ;
      const englishSentences = scanned.match(/[A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){2,}/g) ?? [];
      check('the Chinese wizard renders no English sentences in its own copy',
        captured.includes('发现一次中断的安装事务')
          && captured.includes('编程助手检查')
          && captured.includes('现有旧版目标需要单独确认归属')
          && !captured.includes('Existing legacy ownership needs explicit confirmation')
          && captured.includes('将要执行的改动')
          && captured.includes('安装配置已完成')
          && englishSentences.length === 0,
        englishSentences.join(' | ') || captured.slice(-400));
      // The plan panel is the specific thing the owner read in English on a Chinese run.
      check('the mutation plan renders in Chinese while keeping paths and unit names literal',
        plan.mutationSteps.length > 0
          && plan.mutationSteps.every((step) => captured.includes(chinese.planStep(step).slice(0, 12)))
          && plan.mutationSummary.every((row) => !captured.includes(row)),
        plan.mutationSummary.join(' | '));
    }

    // The choice is persisted through the ordinary transaction, not a side write, so a cancelled run leaves
    // nothing behind and a completed one is preloaded by the next.
    const machine = join(root, 'language-persistence');
    const chosen = await zeroAgentSetup(machine, new ScriptedPresenter({ quota: true, language: 'zh-Hans' }));
    const home = join(machine, '.cosyncing');
    check('the chosen language is persisted with the rest of the setup state',
      chosen.status === 'complete' && readSetupState(home).language === 'zh-Hans',
      JSON.stringify(readSetupState(home).language));
    // Re-running in the already-stored language must stay the no-op it was before this step existed.
    const rerun = new ScriptedPresenter({ quota: true, language: 'zh-Hans' });
    const rerunResult = await runSetup(setupOptions(machine, rerun));
    check('re-running in the already-stored language is still a no-op',
      rerunResult.status === 'already-configured' && rerun.calls.join(',') === 'language,intro,complete',
      `${rerunResult.status}:${rerun.calls.join(',')}`);

    const cancelMachine = join(root, 'language-cancel');
    const cancelPresenter = new ScriptedPresenter({ cancelLanguage: true });
    const cancelledRun = await runSetup(setupOptions(cancelMachine, cancelPresenter));
    check('cancelling at the language step stops before the intro and mutates nothing',
      cancelledRun.status === 'cancelled'
        && cancelPresenter.calls.join(',') === 'language,cancelled:language choice'
        && !existsSync(join(cancelMachine, '.cosyncing', 'setup-state.json')),
      cancelPresenter.calls.join(','));

    // `setup --yes` has no prompt to answer. It must never invent a language: the stored choice first, then
    // the env override, then English.
    const resolveNonInteractive = async (
      state: Record<string, unknown>,
      env?: string,
    ): Promise<SetupLanguage> => {
      const previous = process.env.COSYNCING_SETUP_LANG;
      if (env === undefined) delete process.env.COSYNCING_SETUP_LANG;
      else process.env.COSYNCING_SETUP_LANG = env;
      try {
        const presenter = createNonInteractiveSetupPresenter({ write: () => {} });
        return await presenter.chooseLanguage({ setupState: state } as unknown as SetupInspection) as SetupLanguage;
      } finally {
        if (previous === undefined) delete process.env.COSYNCING_SETUP_LANG;
        else process.env.COSYNCING_SETUP_LANG = previous;
      }
    };
    check('non-interactive setup defaults to English and honours the stored choice, then the env override',
      await resolveNonInteractive({}) === 'en'
        && await resolveNonInteractive({ language: 'zh-Hans' }) === 'zh-Hans'
        && await resolveNonInteractive({}, 'zh-Hans') === 'zh-Hans'
        && await resolveNonInteractive({}, 'klingon') === 'en'
        && await resolveNonInteractive({ language: 'en' }, 'zh-Hans') === 'en');
  }

  // Tri-state opencode-shim consent in the NON-interactive (`--yes`) presenter: it must never default-true.
  // 'unset' (neither flag) honors ONLY a prior stored opt-in; 'off' always declines; 'on' always installs.
  {
    const shimInspection = (requested: boolean | undefined): SetupInspection => ({
      setupState: { schemaVersion: 1, ...(requested === undefined ? {} : { opencodeShimRequested: requested }) },
    } as unknown as SetupInspection);
    const presenterFor = (opencodeShim: OpencodeShimSignal): SetupPresenter =>
      createNonInteractiveSetupPresenter({ write: () => {} }, {
        acceptManagedRuntimeOwnership: true,
        enableSystemdLingering: false,
        installAgentSkill: true,
        opencodeShim,
      });
    const decideUnsetFresh = await presenterFor('unset').confirmOpencodeShim(shimInspection(undefined));
    const decideUnsetStored = await presenterFor('unset').confirmOpencodeShim(shimInspection(true));
    const decideOffStored = await presenterFor('off').confirmOpencodeShim(shimInspection(true));
    const decideOnFresh = await presenterFor('on').confirmOpencodeShim(shimInspection(undefined));
    check('--yes with no stored consent and no --install-opencode-shim does NOT install the shim',
      decideUnsetFresh === false, String(decideUnsetFresh));
    check('--yes with a stored opencodeShimRequested:true opt-in installs the shim',
      decideUnsetStored === true, String(decideUnsetStored));
    check('--no-install-opencode-shim declines even when a prior opt-in is stored',
      decideOffStored === false, String(decideOffStored));
    check('--install-opencode-shim installs the shim even without stored consent',
      decideOnFresh === true, String(decideOnFresh));
  }

  // Committed-setup early-return honors non-interactive choices: re-running an already-committed install with
  // --install-opencode-shim must not drop the choice.
  {
    const presenterFor = (
      opencodeShim: OpencodeShimSignal,
      installAgentSkill = true,
    ): SetupPresenter =>
      createNonInteractiveSetupPresenter({ write: () => {} }, {
        acceptManagedRuntimeOwnership: true, enableSystemdLingering: false,
        installAgentSkill, opencodeShim,
      });
    const shimInspection = (requested: boolean | undefined): SetupInspection => ({
      setupState: {
        schemaVersion: 1,
        ...(requested === undefined ? {} : { opencodeShimRequested: requested }),
      },
    } as unknown as SetupInspection);

    // intendedChoices resolves the flag intent without prompting (the seam the early-return uses).
    check('intendedChoices honors --install-opencode-shim on a fresh (unrequested) install',
      presenterFor('on').intendedChoices?.(shimInspection(undefined))?.installOpencodeShim === true);
    check('intendedChoices honors --no-install-opencode-shim over a stored opt-in',
      presenterFor('off').intendedChoices?.(shimInspection(true))?.installOpencodeShim === false);
    check('intendedChoices honors --no-install-agent-skill',
      presenterFor('unset', false).intendedChoices?.(shimInspection(undefined))?.installAgentSkill === false);

    // End-to-end: commit WITHOUT the shim, then re-run WITH --install-opencode-shim.
    const machine = join(root, 'shim-flag-rerun');
    const first = await runSetup(setupOptions(machine, presenterFor('unset')));
    check('shim-flag-rerun: initial non-interactive setup commits', first.exitCode === 0, first.status);
    const rerunSame = await runSetup(setupOptions(machine, presenterFor('unset')));
    check('shim-flag-rerun: a no-new-intent re-run short-circuits as already-configured',
      rerunSame.status === 'already-configured', rerunSame.status);
    const rerunOn = await runSetup(setupOptions(machine, presenterFor('on')));
    check('shim-flag-rerun: --install-opencode-shim on a committed install is NOT dropped by the early-return',
      rerunOn.status !== 'already-configured' && rerunOn.exitCode === 0, rerunOn.status);
    check('shim-flag-rerun: the shim opt-in is now recorded in setup-state',
      readSetupState(join(machine, '.cosyncing')).opencodeShimRequested === true,
      JSON.stringify(readSetupState(join(machine, '.cosyncing'))));

  }

  // Bootstrap copy (npm acquisition layout). `npm i -g cosyncing` leaves the compiled binary at
  // <prefix>/lib/node_modules/cosyncing/bin/cosyncing, which can never be the installed binary: npm owns it,
  // and receipting it produced a permanent broker-binary-receipt-invalid blocker. Setup must instead copy the
  // running packaged executable into <home>/bin/cosyncing and receipt THAT.
  {
    // The distribution the npm channel actually ships. `packaged: true` alone would be incoherent —
    // it is derived from the kind — and would exercise the native lane rather than this one.
    const packagedBuild = {
      ...BUILD_INFO, distribution: 'bun-js' as const, packaged: true,
    } as typeof BUILD_INFO;
    const npmSetupOptions = (machineRoot: string, presenter: SetupPresenter, npmBinary: string) =>
      setupOptions(machineRoot, presenter, { buildInfo: packagedBuild, executablePath: npmBinary });
    /** Stage a fake npm-owned binary outside the state home, exactly as `npm i -g` would. */
    const stageNpmBinary = (machineRoot: string, content: string): string => {
      const npmBinary = join(machineRoot, 'npm-global', 'lib', 'node_modules', 'cosyncing', 'bin', 'cosyncing');
      mkdirSync(join(machineRoot, 'npm-global', 'lib', 'node_modules', 'cosyncing', 'bin'), { recursive: true });
      writeFileSync(npmBinary, content, { mode: 0o755 });
      // writeFileSync's mode is umask-masked; chmod explicitly (the product
      // does the same after every creation) so a restrictive umask cannot
      // flake the exact-mode assertions below.
      chmodSync(npmBinary, 0o755);
      return npmBinary;
    };
    const binaryReceipt = (home: string) => {
      const install = inspectInstallState(home);
      return install.committed
        ? install.state.resources.find((item) => item.id === 'broker-binary')
        : undefined;
    };

    const machine = join(root, 'npm-bootstrap');
    const home = join(machine, '.cosyncing');
    const homeCopy = join(home, 'bin', 'cosyncing');
    const npmBinary = stageNpmBinary(machine, 'npm-packaged-binary-v1');
    const v1Sha = createHash('sha256').update('npm-packaged-binary-v1').digest('hex');

    const first = await runSetup(npmSetupOptions(machine, new ScriptedPresenter(), npmBinary));
    check('npm-layout setup copies the packaged binary into the state home and plans it explicitly',
      first.status === 'complete' && first.actions.includes('binary.install')
        && existsSync(homeCopy) && readFileSync(homeCopy, 'utf8') === 'npm-packaged-binary-v1',
      `${first.status}:${first.actions.join(',')}`);
    check('the bootstrap copy is owner-only executable and the npm-owned artifact is never mutated',
      (statSync(homeCopy).mode & 0o777) === 0o700
        && readFileSync(npmBinary, 'utf8') === 'npm-packaged-binary-v1'
        && (statSync(npmBinary).mode & 0o777) === 0o755);
    check('the broker-binary receipt names the home copy with a measured package hash, never the npm path',
      binaryReceipt(home)?.target === homeCopy
        && binaryReceipt(home)?.kind === 'binary'
        && binaryReceipt(home)?.ownership.proof === 'package-hash'
        && binaryReceipt(home)?.ownership.installedSha256 === v1Sha,
      JSON.stringify(binaryReceipt(home)));

    // Idempotent: an unchanged re-run neither rewrites the copy nor leaves the no-op short-circuit.
    const before = treeSnapshot(home);
    const rerun = await runSetup(npmSetupOptions(machine, new ScriptedPresenter(), npmBinary));
    check('re-running npm-layout setup with an unchanged binary is a byte-identical no-op',
      rerun.status === 'already-configured' && treeSnapshot(home) === before,
      rerun.status);

    // `npm update -g cosyncing` replaces the acquisition artifact; the next setup re-copies and re-measures.
    writeFileSync(npmBinary, 'npm-packaged-binary-v2', { mode: 0o755 });
    chmodSync(npmBinary, 0o755);
    const v2Sha = createHash('sha256').update('npm-packaged-binary-v2').digest('hex');
    const upgraded = await runSetup(npmSetupOptions(machine, new ScriptedPresenter(), npmBinary));
    check('setup after an npm update re-copies the changed binary and refreshes its measured receipt',
      upgraded.status === 'complete' && upgraded.actions.includes('binary.install')
        && readFileSync(homeCopy, 'utf8') === 'npm-packaged-binary-v2'
        && binaryReceipt(home)?.ownership.installedSha256 === v2Sha,
      `${upgraded.status}:${upgraded.actions.join(',')}`);

    // An unowned/unsafe file at the canonical path is preserved, never clobbered.
    {
      const blockedMachine = join(root, 'npm-bootstrap-unsafe');
      const blockedHome = join(blockedMachine, '.cosyncing');
      const blockedNpm = stageNpmBinary(blockedMachine, 'npm-packaged-binary-v1');
      mkdirSync(join(blockedHome, 'bin'), { recursive: true });
      writeFileSync(join(blockedMachine, 'foreign-target'), 'not ours\n');
      symlinkSync(join(blockedMachine, 'foreign-target'), join(blockedHome, 'bin', 'cosyncing'));
      const blocked = await runSetup(npmSetupOptions(blockedMachine, new ScriptedPresenter(), blockedNpm));
      check('a symlinked installed-binary path blocks setup and is preserved untouched',
        blocked.status === 'blocked'
          && blocked.issueCodes?.includes('installed-binary-unsafe') === true
          && readFileSync(join(blockedMachine, 'foreign-target'), 'utf8') === 'not ours\n',
        `${blocked.status}:${blocked.issueCodes?.join(',')}`);
    }

    // Source builds are unchanged: they own no packaged executable, so they claim no binary receipt.
    {
      const sourceMachine = join(root, 'source-build-binary');
      const sourceHome = join(sourceMachine, '.cosyncing');
      const sourceSetup = await zeroAgentSetup(sourceMachine);
      const plan = buildSetupPlan({
        inspection: await inspectSetupEnvironment({
          buildInfo: BUILD_INFO,
          executablePath: join(sourceMachine, 'bin', 'cosyncing'),
          home: sourceHome,
          context: contextFor(sourceMachine),
        }),
        choices: { language: 'en', service: 'foreground', enableLingering: false, quotaWarnings: false, installAgentSkill: true, installOpencodeShim: true },
        now,
      });
      check('a source build neither copies a binary nor records a broker-binary receipt',
        sourceSetup.status === 'complete'
          && !sourceSetup.actions.includes('binary.install')
          && !plan.actions.some((action) => action.id === 'binary.install')
          && !binaryReceipt(sourceHome)
          && !existsSync(join(sourceHome, 'bin', 'cosyncing')),
        `${sourceSetup.actions.join(',')} receipt=${JSON.stringify(binaryReceipt(sourceHome))}`);
    }
  }

  // Replacing the installed binary must restart the durable service that execs it.
  //
  // Physically observed on Ubuntu: after `npm i -g` of a new version, setup planned `binary.install`,
  // replaced <home>/bin/cosyncing and committed — but planned NO service action, so the still-running unit
  // kept executing the deleted image (`/proc/PID/exe -> ".../bin/cosyncing (deleted)"`) and served the
  // previous build's routes. The cause was ordering: `binary.install` is unshifted into the plan AFTER the
  // service decision (so it lands ahead of `service.systemd` at execution time), so a service predicate that
  // reads `actions.length` cannot see it. These two pins hold both halves — the reconcile fires on a
  // binary-only change, and a genuinely unchanged rerun still plans nothing.
  {
    const config = defaultBrokerConfig();
    const machine = join(root, 'binary-change-service');
    const home = join(machine, '.cosyncing');
    const homeBinary = join(home, 'bin', 'cosyncing');
    const definitionPath = join(machine, '.config', 'systemd', 'user', 'cosyncing.service');
    const environmentPath = join(home, 'service', 'broker.env');
    const installedSha = 'a'.repeat(64);
    const packagedSha = 'b'.repeat(64);
    const acknowledgedAt = FIXED_DATE.toISOString();
    const choices = {
      language: 'en' as const,
      service: 'systemd' as SetupServiceChoice,
      enableLingering: false,
      quotaWarnings: false,
      installAgentSkill: false,
      installOpencodeShim: false,
    };
    const ownedFile = (id: string, kind: string, target: string) => ({
      id, kind, target, ownership: { proof: 'package-hash' as const, installedSha256: installedSha },
    });
    // Everything except the binary is current: config, credentials, setup-state, installer metadata, and an
    // owned systemd unit that is enabled AND active.
    const current = {
      schemaVersion: 1,
      product: 'cosyncing',
      version: BUILD_INFO.version,
      installLocation: join(machine, 'npm-global', 'lib', 'node_modules', 'cosyncing', 'bin', 'cosyncing'),
      stateHome: home,
      installState: {
        committed: true,
        path: join(home, 'install-state.json'),
        state: {
          schemaVersion: 1,
          product: 'cosyncing',
          setup: { status: 'committed', committedAt: acknowledgedAt },
          installer: {
            version: BUILD_INFO.version,
            serviceChoice: 'systemd',
            systemdLingeringRequested: false,
          },
          resources: [
            { ...ownedFile('broker-binary', 'binary', homeBinary) },
            ownedFile('service-systemd', 'service', definitionPath),
            ownedFile('service-environment', 'file', environmentPath),
          ],
          migrations: [],
        },
      },
      installedBinary: {
        path: homeBinary,
        status: 'current',
        expectedSha256: installedSha,
        actualSha256: installedSha,
        selfInstalled: false,
      },
      config: { status: 'ok', path: join(home, 'config.json'), config },
      targetConfig: config,
      brokerCredential: { status: 'ok', path: join(home, 'broker-token'), detailCode: 'broker-token-ok' },
      piCredential: { status: 'ok', path: join(home, 'pi-integration.json'), detailCode: 'pi-integration-ok' },
      piCredentialUrlMatches: true,
      setupState: {
        schemaVersion: 1,
        agents: { codex: false },
        managedRuntimeAcknowledgedAt: acknowledgedAt,
        serviceChoice: 'systemd',
        systemdLingeringRequested: false,
        agentSkillRequested: false,
        opencodeShimRequested: false,
        quotaWarningsEnabled: false,
        language: 'en',
      },
      piAgentDir: join(machine, '.pi', 'agent'),
      piBridge: {
        status: 'missing',
        path: join(machine, '.pi', 'agent', 'extensions', 'cosyncing.ts'),
        expectedSha256: '0'.repeat(64),
        requiresConfirmation: false,
      },
      agentSkills: [],
      opencodeShim: { shimPath: join(home, 'shell', 'opencode-shim.sh'), shimStatus: 'missing', rc: [] },
      // The service owns the port, exactly as it does on a real host mid-upgrade.
      portStatus: 'owned-running',
      pipxAvailable: false,
      tokdashAvailable: false,
      durableServiceProvider: 'systemd',
      systemdAvailable: true,
      systemdStatus: {
        provider: 'systemd', supported: true, definition: 'current', environment: 'current',
        enabled: 'enabled', active: 'active', lingering: 'disabled',
      },
      systemdDefinitionPath: definitionPath,
      systemdEnvironmentPath: environmentPath,
      systemdPersistenceTarget: 'systemd-user-linger:fixture',
      webAppAvailable: false,
      agents: [],
      doctor: {
        schemaVersion: 1, product: 'cosyncing', version: BUILD_INFO.version, effects: 'forbidden', ok: true,
        summary: { pass: 0, warn: 0, fail: 0, skip: 0 }, minimumVersions: [], sections: [],
      },
      blockingIssues: [],
      preconditionHash: '0'.repeat(64),
    } as unknown as SetupInspection;

    const unchangedPlan = buildSetupPlan({ inspection: current, choices, now });
    check('a fully-current rerun under an owned active service still plans zero actions',
      unchangedPlan.actions.length === 0 && unchangedPlan.noOp && !unchangedPlan.requiresCommit
        && unchangedPlan.blockingIssues.length === 0,
      `${unchangedPlan.actions.map((action) => action.id).join(',')} noOp=${unchangedPlan.noOp}`);

    // `npm i -g` of a new version: the acquisition executable's hash moves, nothing else changes.
    const upgraded = buildSetupPlan({
      inspection: {
        ...current,
        installedBinary: { ...current.installedBinary, status: 'stale', expectedSha256: packagedSha },
      },
      choices,
      now,
    });
    const ids = upgraded.actions.map((action) => action.id);
    check('a binary-only change plans BOTH the bootstrap copy and the service reconcile',
      ids.includes('binary.install') && ids.includes('service.systemd')
        && upgraded.blockingIssues.length === 0,
      ids.join(','));
    check('the bootstrap copy still executes before the service reconcile',
      ids.indexOf('binary.install') === 0 && ids.indexOf('service.systemd') === 1,
      ids.join(','));
  }

  // ---------------------------------------------------------------------------------------------------
  // Process-level proof for the same defect. The plan-shape pins above say the reconcile is PLANNED; they
  // cannot say the running broker changed, and "the file on disk moved while the old process kept serving"
  // is precisely the bug. So this lane runs real child processes: the durable-service provider spawns and
  // kills the installed binary path for real, and "V1"/"V2" are two fabricated executables that answer
  // `/api/health` in the shape setup's post-commit check reads, each carrying its own build marker.
  //
  // Everything the provider does is otherwise the ordinary systemd contract: `start()` on an already-active
  // unit is a no-op, `stop()` signals and waits, and `inspect()` reports the process it owns.
  // ---------------------------------------------------------------------------------------------------
  {
    const probeTcp = createSetupDiagnosisContext({ homeDir: root, platform: 'linux', env: {} }).probeTcp;

    /** Take a loopback port the OS says is free right now. */
    const reservePort = (): number => {
      const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
      const { port } = server;
      server.stop(true);
      if (typeof port !== 'number') throw new Error('the OS did not report an ephemeral port');
      return port;
    };

    /**
     * A packaged broker stand-in: a real executable that binds the broker port and answers `/api/health`
     * with the fields setup reads (`ok`, `product`, `machine`, and the `buildFingerprint` that identifies
     * the artifact) plus a build marker that is unique per fabricated build. The marker is what makes
     * "which PROCESS is answering" observable independently of the identity setup itself checks.
     */
    const stubSource = (options: {
      marker: string;
      build: Readonly<Omit<BuildInfo, 'schemaVersions' | 'contract'>>;
      port: number;
      machine: string;
    }): string =>
      `#!/usr/bin/env bun\n`
      + `const body = ${JSON.stringify({
        ok: true,
        product: PRODUCT_IDENTITY.productName,
        version: options.build.version,
        commit: options.build.commit,
        // Derived here from the same single definition the real broker reports, so a stub can never claim
        // an identity shape the product does not produce.
        buildFingerprint: buildFingerprint(options.build),
        machine: options.machine,
        buildMarker: options.marker,
      })};\n`
      + `Bun.serve({\n`
      + `  port: ${options.port},\n`
      + `  hostname: '127.0.0.1',\n`
      + `  fetch(request) {\n`
      + `    return new URL(request.url).pathname === '/api/health'\n`
      + `      ? Response.json(body)\n`
      + `      : new Response('not found', { status: 404 });\n`
      + `  },\n`
      + `});\n`;

    class SpawnedBrokerService implements DurableServiceProvider {
      readonly id = 'systemd' as const;
      readonly serviceName = SYSTEMD_SERVICE_NAME;
      readonly definitionPath: string;
      readonly environmentPath: string;
      readonly persistenceTarget = 'systemd-user-linger:fixture';
      enabled = false;
      lingering = false;
      readonly calls: string[] = [];
      private child?: ReturnType<typeof Bun.spawn>;

      /**
       * @param execPath what this unit's ExecStart actually runs. Normally the home copy setup writes; a
       *   fixture may point it at a path still holding a previous build to model a unit that never came to
       *   execute the newly installed image.
       */
      constructor(
        readonly serviceRoot: string,
        readonly stateHome: string,
        readonly execPath: string,
        readonly servicePort: number,
      ) {
        this.definitionPath = join(serviceRoot, 'service', SYSTEMD_SERVICE_NAME);
        this.environmentPath = join(stateHome, 'service', 'broker.env');
      }
      logsCommand(): readonly string[] {
        return ['/usr/bin/journalctl', '--user', '-u', SYSTEMD_SERVICE_NAME, '--no-pager'];
      }
      expectedDefinition(): string { return `[Service]\nExecStart=${this.execPath}\n`; }
      expectedEnvironment(): string { return `COSYNCING_HOME="${this.stateHome}"\n`; }
      running(): boolean { return !!this.child && this.child.exitCode === null && this.child.signalCode === null; }
      pid(): number | undefined { return this.running() ? this.child?.pid : undefined; }
      async inspect(): Promise<DurableServiceStatus> {
        const state = (path: string, expected: string): 'missing' | 'current' | 'drifted' =>
          !existsSync(path) ? 'missing' : readFileSync(path, 'utf8') === expected ? 'current' : 'drifted';
        return {
          provider: 'systemd',
          supported: true,
          definition: state(this.definitionPath, this.expectedDefinition()),
          environment: state(this.environmentPath, this.expectedEnvironment()),
          enabled: this.enabled ? 'enabled' : 'disabled',
          active: this.running() ? 'active' : 'inactive',
          lingering: this.lingering ? 'enabled' : 'disabled',
        };
      }
      async installDefinition(): Promise<void> {
        this.calls.push('install');
        atomicWriteOwnerOnly(this.definitionPath, this.expectedDefinition());
        atomicWriteOwnerOnly(this.environmentPath, this.expectedEnvironment());
        this.enabled = true;
      }
      async reloadDefinition(): Promise<void> { this.calls.push('reload'); }
      async setEnabled(value: boolean): Promise<void> { this.enabled = value; }
      async enableLingering(): Promise<void> { this.lingering = true; }
      async disableLingering(): Promise<void> { this.lingering = false; }
      async start(): Promise<void> {
        this.calls.push('start');
        // `systemctl start` on an already-active unit does nothing. Reproducing that is load-bearing: it is
        // exactly why replacing the binary without a reconcile leaves the previous process serving.
        if (this.running()) return;
        this.child = Bun.spawn([this.execPath], { stdout: 'ignore', stderr: 'ignore' });
        for (let index = 0; index < 80 && await probeTcp('127.0.0.1', this.servicePort) !== 'open'; index += 1) {
          if (!this.running()) break;
          await Bun.sleep(25);
        }
      }
      async stop(): Promise<void> {
        this.calls.push('stop');
        const child = this.child;
        this.child = undefined;
        if (!child) return;
        child.kill('SIGKILL');
        await child.exited;
        for (let index = 0; index < 80 && await probeTcp('127.0.0.1', this.servicePort) !== 'closed'; index += 1) {
          await Bun.sleep(25);
        }
      }
      async restart(): Promise<void> { await this.stop(); await this.start(); }
      async uninstall(): Promise<void> {
        this.calls.push('uninstall');
        await this.stop();
        this.enabled = false;
        for (const path of [this.definitionPath, this.environmentPath]) if (existsSync(path)) rmSync(path, { force: true });
      }
    }

    /** Is this pid still a live process? Proof that the replaced build was signalled, not merely ignored. */
    const processAlive = (pid: number): boolean => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    };

    /** A context whose network probes are REAL — this lane's claims are about a live listener — and whose
     *  systemd availability is supplied by the fixture rather than by the host running the suite. */
    const liveContext = (machineRoot: string) => {
      const base = createSetupDiagnosisContext({
        homeDir: machineRoot,
        platform: 'linux',
        env: {
          HOME: machineRoot,
          PATH: '',
          COSYNCING_HOME: join(machineRoot, '.cosyncing'),
          COSYNCING_CACHE_DIR: join(machineRoot, '.cache', 'cosyncing'),
          CODEX_HOME: join(machineRoot, '.codex'),
          PI_CODING_AGENT_DIR: join(machineRoot, '.pi', 'agent'),
        },
      });
      return {
        ...base,
        resolveExecutable: (command: string): string | undefined =>
          command === 'systemctl' ? '/usr/bin/systemctl'
            : command === 'journalctl' ? '/usr/bin/journalctl'
              : undefined,
        async runReadOnly(executable: string, args: readonly string[]) {
          return executable === '/usr/bin/systemctl' && args[1] === 'is-system-running'
            ? { status: 'ok' as const, exitCode: 0, stdout: 'running\n', stderr: '' }
            : { status: 'unavailable' as const, stdout: '', stderr: '' };
        },
      };
    };

    const healthMarker = async (servicePort: number): Promise<string> => {
      try {
        const response = await fetch(`http://127.0.0.1:${servicePort}/api/health`);
        const body = await response.json() as Record<string, unknown>;
        return typeof body.buildMarker === 'string' ? body.buildMarker : '<no-marker>';
      } catch {
        return '<unreachable>';
      }
    };

    const stageAcquisitionBinary = (machineRoot: string, source: string): string => {
      const npmBinary = join(machineRoot, 'npm-global', 'lib', 'node_modules', 'cosyncing', 'bin', 'cosyncing');
      mkdirSync(dirname(npmBinary), { recursive: true });
      writeFileSync(npmBinary, source, { mode: 0o755 });
      return npmBinary;
    };

    const servicePresenter = (): ScriptedPresenter => new ScriptedPresenter({
      service: 'systemd', skill: false, opencodeShim: false, quota: false,
    });

    // ---- The literal ask: install V1, start it, replace it with V2, rerun setup, prove the RUNNING
    // process is V2. Both builds report the SAME version, so nothing but the reconcile can flip the
    // responder: this isolates the planner predicate bdedc28 fixed.
    const upgradePort = reservePort();
    const upgrade = new SpawnedBrokerService(
      join(root, 'live-upgrade'),
      join(root, 'live-upgrade', '.cosyncing'),
      join(root, 'live-upgrade', '.cosyncing', 'bin', 'cosyncing'),
      upgradePort,
    );
    // A second machine for the post-commit health binding: its unit still execs a path holding the previous
    // build, so after a textbook reconcile the process that answers is NOT the build setup just installed.
    const stalePort = reservePort();
    const stalePath = join(root, 'live-stale', 'previous-build', 'cosyncing');
    const stale = new SpawnedBrokerService(
      join(root, 'live-stale'),
      join(root, 'live-stale', '.cosyncing'),
      stalePath,
      stalePort,
    );
    try {
      {
        const machine = join(root, 'live-upgrade');
        const home = join(machine, '.cosyncing');
        const homeCopy = join(home, 'bin', 'cosyncing');
        const servicePort = upgradePort;
        ensureOwnerOnlyDirectory(home);
        const config = defaultBrokerConfig();
        config.broker.port = servicePort;
        config.broker.machineLabel = 'live-upgrade-fixture';
        config.broker.internalUrl = `http://127.0.0.1:${servicePort}`;
        writeBrokerConfig(config, home);
        // V1 and V2 are the SAME build identity — same version AND same commit — differing only in bytes.
        // That is deliberate: it leaves the reconcile as the only thing that can change which process
        // answers, so this machine isolates the planner predicate. (A differing commit would not have
        // helped it along either: `installMetadataMatches` reads version, not commit, so it never reaches
        // `needsServiceReconcile`.) Machine B below owns the identity-binding half.
        const build = {
          ...BUILD_INFO, distribution: 'bun-js' as const, packaged: true, version: '9.9.9', commit: 'abc1234',
          buildDate: '2026-08-06T00:00:00.000Z', dirty: false,
        } as typeof BUILD_INFO;
        const stub = (marker: string): string => stubSource({
          marker, build, port: servicePort, machine: config.broker.machineLabel,
        });
        const npmBinary = stageAcquisitionBinary(machine, stub('v1'));
        const options = (): Record<string, unknown> => ({
          buildInfo: build,
          executablePath: npmBinary,
          context: liveContext(machine),
          systemdProviderFactory: () => upgrade,
        });

        const first = await runSetup(setupOptions(machine, servicePresenter(), options()));
        const v1Pid = upgrade.pid();
        check('live setup installs the packaged binary and leaves a real service process answering as V1',
          first.status === 'complete' && first.actions.includes('service.systemd')
            && readFileSync(homeCopy, 'utf8') === stub('v1')
            && v1Pid !== undefined && await healthMarker(servicePort) === 'v1',
          `${first.status}:${first.actions.join(',')} pid=${v1Pid} marker=${await healthMarker(servicePort)}`);

        // `npm update -g` replaces the acquisition artifact with a byte-different build of the SAME version.
        writeFileSync(npmBinary, stub('v2'), { mode: 0o755 });
        const second = await runSetup(setupOptions(machine, servicePresenter(), options()));
        const v2Pid = upgrade.pid();
        const marker = await healthMarker(servicePort);
        check('a binary replacement reconciles the service and the RUNNING process becomes the new build',
          second.status === 'complete'
            && second.actions.includes('binary.install') && second.actions.includes('service.systemd')
            && readFileSync(homeCopy, 'utf8') === stub('v2')
            && marker === 'v2' && v2Pid !== undefined && v2Pid !== v1Pid,
          `${second.status}:${second.actions.join(',')} pid ${v1Pid}->${v2Pid} marker=${marker}`);
        check('the replaced build was stopped rather than left holding the port',
          upgrade.calls.filter((call) => call === 'stop').length >= 1
            && (v1Pid === undefined || !processAlive(v1Pid)),
          upgrade.calls.join(','));
      }

      // ---- Post-commit health must be answered by the build setup just installed, not merely by SOMETHING
      // healthy on the port. Here the reconcile itself is textbook (stop, reinstall, start) but the unit
      // re-execs a path that still holds the previous build, so a bare `ok: true` would report a verified
      // install of a binary nothing is running.
      //
      // The two builds share ONE semver AND ONE commit, differing only in that the previous one was built
      // from a dirty checkout — the hardest case, and a real one: a dev binary left running under a unit
      // whose ExecStart now holds the clean release build of the same tree. Nothing in the version/commit
      // pair separates them, so only the full artifact identity can refuse this.
      {
        const machine = join(root, 'live-stale');
        const home = join(machine, '.cosyncing');
        const servicePort = stalePort;
        ensureOwnerOnlyDirectory(home);
        const config = defaultBrokerConfig();
        config.broker.port = servicePort;
        config.broker.machineLabel = 'live-stale-fixture';
        config.broker.internalUrl = `http://127.0.0.1:${servicePort}`;
        writeBrokerConfig(config, home);
        const sharedIdentity = {
          ...BUILD_INFO, distribution: 'bun-js' as const, packaged: true, version: '0.1.0', commit: '1111111',
          buildDate: '2026-08-06T00:00:00.000Z',
        } as typeof BUILD_INFO;
        const previousBuild = { ...sharedIdentity, dirty: true } as typeof BUILD_INFO;
        const currentBuild = { ...sharedIdentity, dirty: false } as typeof BUILD_INFO;
        const stub = (marker: string, build: typeof BUILD_INFO): string => stubSource({
          marker, build, port: servicePort, machine: config.broker.machineLabel,
        });
        mkdirSync(dirname(stalePath), { recursive: true });
        writeFileSync(stalePath, stub('previous', previousBuild), { mode: 0o755 });
        const npmBinary = stageAcquisitionBinary(machine, stub('previous', previousBuild));
        const options = (build: typeof BUILD_INFO): Record<string, unknown> => ({
          buildInfo: build,
          executablePath: npmBinary,
          context: liveContext(machine),
          systemdProviderFactory: () => stale,
          serviceHealthAttempts: 6,
        });

        const first = await runSetup(setupOptions(machine, servicePresenter(), options(previousBuild)));
        check('the stale-unit fixture first commits normally while the running build matches the installed one',
          first.status === 'complete' && await healthMarker(servicePort) === 'previous', first.status);

        writeFileSync(npmBinary, stub('current', currentBuild), { mode: 0o755 });
        const upgraded = await runSetup(setupOptions(machine, servicePresenter(), options(currentBuild)));
        check('setup refuses to report success while a same-version same-commit previous build answers',
          upgraded.status === 'failed' && upgraded.failure?.code === 'verify-post-commit'
            && upgraded.failure.detail.includes('dirty') && upgraded.failure.detail.includes('clean')
            && await healthMarker(servicePort) === 'previous',
          `${upgraded.status}:${upgraded.failure?.code}:${upgraded.failure?.detail}`);
      }
    } finally {
      await upgrade.stop().catch(() => undefined);
      await stale.stop().catch(() => undefined);
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

// The known-legacy skill prompt defaults Yes; every other confirmation keeps its own default. The clack
// presenter takes no injectable seam and these suites run outside `bun test`, so the default is bound at
// the source. It is a weaker binding than a behavioural one — it would not catch a change in how clack
// reads initialValue — but it does catch the flip that matters: this prompt silently reverting to No, or
// a neighbouring destructive prompt being switched to Yes alongside it.
{
  const presenterSource = readFileSync(
    resolve(import.meta.dir, '../../src/installation/setup-presenter.ts'),
    'utf8',
  );
  const legacyBlock = presenterSource.slice(
    presenterSource.indexOf('async confirmLegacyAgentSkill('),
    presenterSource.indexOf('async confirmOpencodeShim('),
  );
  check('the exact-known legacy skill prompt defaults to Yes',
    legacyBlock.includes('initialValue: true') && !legacyBlock.includes('initialValue: false'),
    legacyBlock.split('\n').find((line) => line.includes('initialValue'))?.trim() ?? '(no initialValue)');
  // The Pi bridge is the OTHER legacy migration prompt and sits immediately above this one. It must stay
  // default-No, so this pins that the change was scoped to the skill rather than applied to both.
  const bridgeBlock = presenterSource.slice(
    presenterSource.indexOf('async confirmLegacyPiBridge('),
    presenterSource.indexOf('async confirmAgentSkill('),
  );
  check('the adjacent legacy Pi bridge prompt still defaults to No',
    bridgeBlock.length > 0
      && bridgeBlock.includes('initialValue: false')
      && !bridgeBlock.includes('initialValue: true'),
    bridgeBlock.split('\n').find((line) => line.includes('initialValue'))?.trim() ?? '(no initialValue)');
}

const failed = results.filter((entry) => !entry.ok);
if (failed.length) {
  console.error(`\nFAIL ${failed.length}/${results.length} transactional setup checks`);
  process.exit(1);
}
console.log(`\nPASS ${results.length}/${results.length} transactional setup checks`);
