/**
 * Setup wizard string catalog.
 *
 * Plain TypeScript objects keyed by message id — no i18n runtime, no message-format parser, no lookup that
 * can miss. Every catalog implements the same interface, so a missing string is a type error at build time
 * rather than a `???` on an operator's screen.
 *
 * Scope is the WIZARD's own copy: what `cosyncing setup` prompts, titles, and prints. Other human CLI
 * surfaces reuse the validated language through `cli-i18n.ts`; error/detail codes and machine-readable
 * output stay English so tooling and quoted bug reports remain stable.
 *
 * The English catalog is the reference text. Its strings are what the setup regressions pin, so changing one
 * is a deliberate copy change, not a translation side effect.
 *
 * Chinese copy is written as Chinese, not transliterated English. Terms that name a thing on the machine —
 * systemd, launchd, Codex, OpenCode, Claude, Pi, Tokdash, token — stay untranslated,
 * because those are what the operator will type and what they will search for.
 */
import type { SetupAgentSummary, SetupServiceChoice, TokdashProvisionCapability } from './setup.ts';
import type { TokdashEndpointRejection } from './tokdash-quota.ts';

export type SetupLanguage = 'en' | 'zh-Hans';

/**
 * One row of the mutation plan, carried as DATA rather than as a finished sentence.
 *
 * The plan is the thing the operator consents to, so it has to be readable in the language they picked. The
 * same rows are also quoted into `--yes` output, the transaction journal, and receipts, where a translated
 * string would be a moving identifier in a bug report. Keeping the row structured lets the wizard render it
 * in Chinese while every persisted and machine-facing copy stays the English reference text — the plan
 * carries both, produced from one source, so they cannot describe different mutations.
 *
 * Paths, unit names, URLs, versions, and command names are interpolated verbatim in every language.
 */
export type SetupMutationStep =
  | { kind: 'config'; configPath: string; internalUrl: string }
  | { kind: 'credentials' }
  | { kind: 'setup-state'; service: SetupServiceChoice }
  | { kind: 'pi-bridge'; path: string; replaceLegacy?: boolean }
  | { kind: 'omp-bridge'; path: string }
  | { kind: 'durable-state-permissions'; paths: readonly string[] }
  | { kind: 'agent-skill-install' }
  | { kind: 'agent-skill-refresh' }
  | { kind: 'agent-skill-remove' }
  | { kind: 'opencode-shim' }
  | { kind: 'service-install'; definitionPath: string }
  | { kind: 'service-remove'; provider: SetupServiceChoice; product: string }
  | { kind: 'binary-install'; version: string; path: string }
  | { kind: 'codex-legacy-daemon-migration' }
  | { kind: 'commit-receipts'; installStatePath: string };

/**
 * Why the run ended, as a code rather than a sentence. `SetupCommandResult.summary` stays English because it
 * is the machine-readable line `--yes` prints and a bug report quotes; the interactive footer renders THIS.
 */
export type SetupSummaryCode =
  | 'complete'
  | 'complete-no-agents'
  | 'already-configured'
  | 'blocked-preflight'
  | 'blocked-committed-dependency'
  | 'declined-managed-runtime'
  | 'declined-plan'
  | 'blocked-unsafe-plan'
  | 'precondition-changed'
  | 'cancelled'
  | 'failed-rolled-back'
  | 'failed-cleanup-remains';

export const DEFAULT_SETUP_LANGUAGE: SetupLanguage = 'en';
export const CONNECTIVITY_GUIDE_URL = 'https://github.com/cosyncing/cosyncing/tree/main/docs/connectivity';

/** Offered in the language-selection step. Each label is written in its own language, never translated. */
export const SETUP_LANGUAGE_OPTIONS: readonly { value: SetupLanguage; label: string }[] = Object.freeze([
  { value: 'en', label: 'English' },
  { value: 'zh-Hans', label: '简体中文' },
]);

/** Persisted state and env overrides are untrusted input; anything unrecognized falls back to English. */
export function normalizeSetupLanguage(value: unknown): SetupLanguage | undefined {
  return SETUP_LANGUAGE_OPTIONS.some((option) => option.value === value) ? value as SetupLanguage : undefined;
}

/**
 * `COSYNCING_SETUP_LANG` lets the non-interactive path pick a language without a prompt — the only way
 * `setup --yes` can run in anything but the persisted choice or English.
 */
export function setupLanguageFromEnv(env: Readonly<Record<string, string | undefined>>): SetupLanguage | undefined {
  return normalizeSetupLanguage(env.COSYNCING_SETUP_LANG?.trim());
}

export interface SetupMessages {
  languagePrompt: string;
  introTitle: (product: string) => string;
  installationTitle: string;
  installationBody: (fields: { version: string; install: string; state: string; broker: string }) => string;
  agentPreflightTitle: string;
  /** The preflight's own words for a state and for what cosyncing does with each agent. */
  agentState: (state: SetupAgentSummary['state']) => string;
  agentBehavior: (id: SetupAgentSummary['id']) => string;
  unsupportedVersionUnreadable: string;
  unsupportedDetected: (version: string) => string;
  unsupportedUpgrade: (command: string) => string;
  unsupportedReason: (parts: { detected: string; displayName: string; minimumVersion: string; upgrade: string }) => string;
  runtimeUnavailableReason: (parts: { installedVersion?: string; minimumVersion?: string; remediation: string }) => string;
  codexStandaloneWarning: (command: string) => string;
  networkTitle: string;
  networkLoopback: (summary: string) => string;
  legacyConnectivityPreserved: (targets: readonly string[]) => string;
  blocker: (parts: { summary: string; remediation: string }) => string;
  managedRuntimeTitle: string;
  managedRuntimeBody: (product: string) => string;
  managedRuntimeConfirm: (product: string) => string;
  legacyPiBridgeConfirm: (path: string) => string;
  agentSkillConfirm: string;
  legacyAgentSkillConfirm: (paths: string) => string;
  opencodeShimConfirm: string;
  serviceQuestion: string;
  serviceForegroundLabel: string;
  serviceForegroundHint: (binary: string) => string;
  serviceDurableLabel: (provider: SetupServiceChoice) => string;
  serviceDurableHint: (parts: { provider: SetupServiceChoice; available: boolean }) => string;
  launchdSessionNote: string;
  /**
   * Takes the branch provisioning will actually take, because the second half of this note is a promise
   * about commands that will run. It read only `pipxAvailable` before, which got both ends wrong: a host
   * with the tokdash CLI installed and no pipx was told nothing could be set up, and a host with both was
   * promised a `pipx install` that would be skipped.
   */
  quotaNote: (baseUrl: string, capability: TokdashProvisionCapability) => string;
  /**
   * A refused override. Said out loud, because the endpoint used is not the one asked for — but as a REASON
   * only. The value is operator-supplied and can carry a credential, so no surface prints it.
   */
  quotaUrlRejected: (rejection: TokdashEndpointRejection, baseUrl: string) => string;
  quotaConfirm: string;
  /** Post-commit provisioning outcome. Optional work, so every branch reports rather than fails. */
  quotaReused: (baseUrl: string) => string;
  /**
   * Takes whether cosyncing installed the package, so the outcome agrees with whichever prompt case applied:
   * "installed and started" is a lie about a host where the CLI was already there and only got configured.
   */
  quotaProvisioned: (baseUrl: string, installed: boolean) => string;
  /** An endpoint Tokdash cannot be set up on at all, as opposed to one where setting it up went wrong. */
  quotaEndpointUnsupported: (baseUrl: string) => string;
  quotaProvisionFailed: (detail: string) => string;
  planTitle: string;
  planEmpty: string;
  planStep: (step: SetupMutationStep) => string;
  applyConfirm: string;
  /** The interactive footer. The English rendering is also the reference text `--yes` and receipts carry. */
  resultSummary: (code: SetupSummaryCode, parts: { binary: string; stage: string }) => string;
  recoveredNote: string;
  outroTitle: (product: string) => string;
  outroStateDirectory: (path: string) => string;
  /** Printed instead of an "open it" line when setup could not prove a broker is answering. */
  outroStartBroker: (binary: string) => string;
  outroOpenHere: (url: string) => string;
  outroOpenHereAfterStart: (url: string) => string;
  /** Native-client endpoint proved by setup; unlike the browser URL, it has no app path. */
  outroLocalServerAddress: (url: string) => string;
  outroPairInstead: (binary: string) => string;
  /** The same four lines for a build with no Flutter bundle: `/cosy` there is the pairing-guidance page. */
  outroPairPageHere: (url: string) => string;
  outroPairPageHereAfterStart: (url: string) => string;
  outroLoopbackOnly: string;
  outroShortCommand: (alias: string, commands: readonly string[]) => string;
  outroTokenRead: (path: string) => string;
  outroTokenSignIn: (appPath: string) => string;
  outroPreferPairing: (binary: string) => string;
  cancelledNote: (stage: string) => string;
  failureTitle: string;
  failureStep: (value: string) => string;
  failureReason: (value: string) => string;
  failureCode: (value: string) => string;
  failureRollback: (value: string) => string;
  failureDiagnostic: (value: string) => string;
  failureAlsoInDoctor: (binary: string) => string;
}

const en: SetupMessages = {
  languagePrompt: 'Language',
  introTitle: (product) => `${product} setup`,
  installationTitle: 'Installation',
  installationBody: ({ version, install, state, broker }) =>
    `Version: ${version}\nInstall: ${install}\nState: ${state}\nBroker: ${broker}`,
  agentPreflightTitle: 'Agent preflight',
  agentState: (state) => state,
  agentBehavior: (id) => ({
    codex: 'Managed shared app-server; remote terminals may join it.',
    opencode: 'Managed shared serve; externally managed servers remain untouched.',
    pi: 'Packaged in-session bridge when Pi is installed.',
    omp: 'Packaged in-session bridge when omp is installed.',
    claude: 'Observe + Take over only; setup never edits Claude settings.',
    agy: 'Observe + Resume only; agy has no daemon to manage, and setup never touches Antigravity state.',
    kimi: 'Managed `kimi web` host; a server you started yourself is never touched.',
    dsh: 'Managed `dsh web` host; one you started yourself, or on another machine, is never touched.',
  }[id] ?? 'Managed external host; one you started yourself is never touched.'),
  unsupportedVersionUnreadable: 'the installed version could not be read',
  unsupportedDetected: (version) => `detected ${version}`,
  unsupportedUpgrade: (command) => ` Run \`${command}\`.`,
  unsupportedReason: ({ detected, displayName, minimumVersion, upgrade }) =>
    `\n  Unsupported: ${detected}; ${displayName} ${minimumVersion} or newer is required.${upgrade}`,
  runtimeUnavailableReason: ({ installedVersion, minimumVersion, remediation }) =>
    `\n  Runtime unavailable: effective Node ${installedVersion ?? 'could not be verified'}; `
      + `${minimumVersion ? `Node ${minimumVersion} or newer is required. ` : ''}Fix: ${remediation}`,
  codexStandaloneWarning: (command) =>
    `Warning: app-created sessions remain available, but the broker-managed daemon and terminal sync require `
      + `the official standalone Codex package. `
      + `Run \`${command}\`; its installer detects npm-managed Codex and offers to remove it. `
      + 'Then open a new terminal and rerun `cosy setup`.',
  networkTitle: 'Network and authentication',
  networkLoopback: () =>
    `Loopback-only. External connectivity is managed by the operator. See ${CONNECTIVITY_GUIDE_URL}, `
      + 'or copy that URL to a coding agent and ask it to configure Tailscale Serve, EasyTier, or another '
      + 'connectivity method after `cosyncing setup`.',
  legacyConnectivityPreserved: (targets) =>
    `Legacy external connectivity was left unchanged and is now operator-owned${targets.length ? `: ${targets.join(', ')}` : '.'} `
      + 'For future setup, see docs/connectivity/tailscale-serve.md and '
      + 'docs/connectivity/migrating-from-managed-tailscale.md.',
  blocker: ({ summary, remediation }) => `${summary}\nFix: ${remediation}`,
  managedRuntimeTitle: 'Required managed-runtime acknowledgement',
  managedRuntimeBody: (product) =>
    `${product} will manage supported shared Codex/OpenCode runtimes, the packaged Pi and omp bridges, and the \`kimi web\` and \`dsh web\` hosts — starting one when none is running, restarting it if it crashes, and stopping only the one it started. Externally managed processes stay untouched. Claude remains Observe + Take over and its settings are never edited.`,
  managedRuntimeConfirm: (product) =>
    `I understand and want ${product} to manage the supported shared runtimes.`,
  legacyPiBridgeConfirm: (path) =>
    `Replace the exact known legacy Pi bridge at ${path} with this packaged version? A rollback restores it byte-for-byte.`,
  agentSkillConfirm: 'Install the cosyncing agent skill so agents with a supported session-bound tool can deliver files to the app?',
  legacyAgentSkillConfirm: (paths) =>
    `Upgrade the known preceding cosyncing skill at ${paths}? Unknown or edited skill content is never overwritten.`,
  opencodeShimConfirm:
    'Route `opencode` in your terminal to the shared cosyncing serve so its status shows live in the app?',
  serviceQuestion: 'How should the broker run after setup?',
  serviceForegroundLabel: 'Foreground',
  serviceForegroundHint: (binary) => `Run \`${binary} broker\` explicitly after setup.`,
  serviceDurableLabel: (provider) => provider === 'launchd' ? 'launchd user agent' : 'systemd user service',
  // Never describe the other platform's manager as "unavailable" — on macOS systemd is not a thing that
  // could be enabled, and saying so reads as a broken install rather than a host difference.
  serviceDurableHint: ({ provider, available }) => available
    ? provider === 'launchd'
      ? 'Persistent macOS LaunchAgent; runs from GUI login to logout.'
      : 'Persistent Linux service (installed by the service package).'
    : provider === 'launchd'
      ? 'Needs a packaged install and a macOS GUI session; foreground remains supported.'
      : 'Unavailable on this host; foreground remains supported.',
  launchdSessionNote: 'The launchd agent runs from GUI login to logout. cosyncing does not install a system-wide '
    + 'LaunchDaemon, so the broker does not run before you sign in or after you sign out.',
  // Every case, truthfully. A Tokdash that is already running is reused and never touched; below that, the
  // note names the commands that will actually run, which is not the same list on every host.
  quotaNote: (baseUrl, capability) => `Quota comes from Tokdash at ${baseUrl} (override with COSYNCING_TOKDASH_URL). `
    + 'A Tokdash already running there is reused as-is and never modified. '
    + {
      'setup-only': 'If none is running, cosyncing starts the tokdash already installed here: `tokdash setup`, '
        + 'then quota tracking is turned on. Nothing is installed. Uninstall reverses only the service cosyncing '
        + 'started.',
      install: 'If none is running, cosyncing installs and starts one for you: `pipx install tokdash`, then '
        + '`tokdash setup`, then quota tracking is turned on. Uninstall reverses only what cosyncing installed.',
      unavailable: 'If none is running, cosyncing cannot set one up here: neither tokdash nor pipx is installed. '
        + 'Install pipx (it needs Python 3.9+) — `sudo apt install pipx` on Ubuntu, `brew install pipx` on macOS '
        + '— then run setup again and it will finish this step.',
    }[capability],
  // The value is withheld on purpose and the copy says so, or an operator retypes the variable looking for
  // the typo that was quoted back at them. An override can carry a credential; the reason cannot.
  quotaUrlRejected: (rejection, baseUrl) =>
    `COSYNCING_TOKDASH_URL was refused because ${({
      unparseable: 'it is not a valid URL',
      'not-http': 'Tokdash serves http(s) only',
      'not-loopback': 'it does not point at localhost',
      credentials: 'it embeds credentials',
    })[rejection]}, so ${baseUrl} is used instead — by setup and by the broker alike. `
    + 'The value itself is not printed, because an override can carry a secret.',
  quotaConfirm: 'Enable local token and usage quota tracking via Tokdash?',
  quotaReused: (baseUrl) => `Using the Tokdash already running at ${baseUrl}; nothing was installed or changed.`,
  quotaProvisioned: (baseUrl, installed) => installed
    ? `Installed and started Tokdash at ${baseUrl} with quota tracking enabled.`
    : `Started the Tokdash already installed here at ${baseUrl}, with quota tracking enabled. Nothing was installed.`,
  quotaEndpointUnsupported: (baseUrl) =>
    `cosyncing cannot set up a Tokdash at ${baseUrl}: Tokdash serves plain HTTP from the root of a loopback port. `
    + 'Setup itself is complete; start Tokdash there yourself, or change COSYNCING_TOKDASH_URL.',
  // Optional work: say what did not happen and that the install is fine, or this reads as a failed setup.
  quotaProvisionFailed: (detail) =>
    `Tokdash could not be set up, so quota warnings are off. Setup itself is complete. ${detail}`,
  planTitle: 'Exact mutation plan',
  planEmpty: 'No filesystem or service mutation is required.',
  // This rendering is the reference text: the plan's `mutationSummary`, the `--yes` `[plan]` lines, and the
  // journal all quote it, so a change here is a change to what the receipts say.
  planStep: (step) => {
    switch (step.kind) {
      case 'config':
        return `Write owner-only ${step.configPath} with internal ${step.internalUrl}.`;
      case 'credentials':
        return 'Create owner-only broker and Pi-scoped credentials without printing or placing them in '
          + 'process arguments.';
      case 'setup-state':
        return `Record managed-runtime acknowledgement, ${step.service} service choice, separate lingering `
          + 'consent, and quota consent.';
      case 'pi-bridge':
        return step.replaceLegacy
          ? `Transactionally replace the exact known legacy bridge at ${step.path}; rollback restores the previous bytes.`
          : `Write the exact packaged bridge to ${step.path}; unrelated content is never overwritten.`;
      case 'omp-bridge':
        return `Write the exact packaged omp bridge to ${step.path}; unrelated content is never overwritten.`;
      case 'durable-state-permissions':
        return `Tighten owner-only permissions on current-schema durable state: ${step.paths.join(', ')}; content is unchanged.`;
      case 'agent-skill-install':
        return 'Install the packaged skill into both Claude and shared .agents discovery roots and record '
          + 'one ownership receipt per target.';
      case 'agent-skill-refresh':
        return "Refresh the packaged cosyncing skill to this build's version in both Claude and shared "
          + '.agents discovery roots and update each ownership receipt.';
      case 'agent-skill-remove':
        return 'Remove only exact receipt-owned copies from both native discovery roots.';
      case 'opencode-shim':
        return 'Install the cosyncing opencode shim and add a managed source block to detected bash/zsh rc '
          + 'files; open a new shell or source your rc file (e.g. `source ~/.bashrc`) to activate. Unrelated '
          + 'rc content is preserved byte-for-byte.';
      case 'service-install':
        return `Stop only the owned service when needed, write and enable ${step.definitionPath}, commit `
          + 'receipts, then start and health-check once.';
      case 'service-remove':
        return `Stop and remove only the receipt-owned ${step.provider} service; remove its lingering policy `
          + `only when ${step.product} enabled it.`;
      case 'binary-install':
        return `Copy the running ${step.version} executable to owner-only ${step.path} and record its `
          + 'measured ownership receipt; the acquisition artifact (for example an npm package) is left '
          + 'untouched.';
      case 'codex-legacy-daemon-migration':
        return 'Stop the exact legacy unmanaged Codex app-server process, start it through the managed '
          + 'daemon command, and record the new control-socket ownership. Attached Codex sessions will disconnect.';
      case 'commit-receipts':
        return `Commit owner receipts to ${step.installStatePath} only after verification.`;
    }
  },
  applyConfirm: 'Apply and verify this exact plan?',
  resultSummary: (code, { binary, stage }) => {
    switch (code) {
      case 'complete': return 'Setup committed successfully.';
      case 'complete-no-agents':
        return 'Setup committed successfully. No supported coding agents were found; install one and rerun doctor.';
      case 'already-configured':
        return 'Setup is already committed; health and preflight results were refreshed without mutation.';
      case 'blocked-preflight': return 'Setup is blocked by preflight findings; no mutation was applied.';
      case 'blocked-committed-dependency':
        return 'Committed setup has a newly unsafe or unavailable dependency; no mutation was applied.';
      case 'declined-managed-runtime':
        return 'Required managed-runtime acknowledgement was declined; no mutation was applied.';
      case 'declined-plan': return 'The mutation plan was declined; no mutation was applied.';
      case 'blocked-unsafe-plan': return 'Setup cannot apply this plan safely; no mutation was applied.';
      case 'precondition-changed':
        return 'Setup preconditions changed after confirmation; rerun to review the new plan.';
      case 'cancelled': return `Setup cancelled during ${stage}; no mutation was applied.`;
      case 'failed-rolled-back':
        return 'Setup failed and completed actions were rolled back. Rerun setup for a fresh inspection.';
      case 'failed-cleanup-remains':
        return `Setup failed and cleanup remains. Keep the transaction journal and rerun \`${binary} setup\`, `
          + 'which rolls the remainder back before replanning.';
    }
  },
  recoveredNote: 'Recovered an interrupted setup transaction by rolling it back to its journaled pre-state.',
  outroTitle: (product) => `Open ${product}`,
  outroStateDirectory: (path) => `State directory: ${path}`,
  outroStartBroker: (binary) => `Nothing is listening yet. Start the broker: \`${binary} broker\`.`,
  outroOpenHere: (url) => `Local web app: ${url}`,
  outroOpenHereAfterStart: (url) => `Local web app: ${url}`,
  outroLocalServerAddress: (url) => `Local server address: ${url}`,
  outroPairInstead: (binary) => `Run \`${binary} pair\` and scan the QR to pair a client.`,
  outroPairPageHere: (url) => `The same steps in a browser: ${url}`,
  outroPairPageHereAfterStart: (url) => `Then the same steps in a browser: ${url}`,
  outroLoopbackOnly:
    `Loopback only. External connectivity is managed by the operator. See ${CONNECTIVITY_GUIDE_URL}, `
      + 'or copy that URL to a coding agent and ask it to configure connectivity after `cosyncing setup`.',
  outroShortCommand: (alias, commands) =>
    `Short command: \`${alias}\` is an alias for \`cosyncing\`, for example ${commands.map((value) => `\`${value}\``).join(', ')}.`,
  outroTokenRead: (path) => `Read authentication token file: cat ${path}`,
  outroTokenSignIn: (appPath) => `The web app (${appPath}) asks for this token to sign in.`,
  outroPreferPairing: (binary) =>
    `Prefer \`${binary} pair\` for phones and tablets. It issues one credential per device, so you can `
      + 'revoke a single device. The token file above is the master secret: full broker API access, and '
      + 'the same one for everybody who has it.',
  cancelledNote: (stage) => `Setup cancelled during ${stage}. No mutation was applied.`,
  failureTitle: 'Why setup failed',
  failureStep: (value) => `Failed step: ${value}`,
  failureReason: (value) => `Reason: ${value}`,
  failureCode: (value) => `Failure code: ${value}`,
  failureRollback: (value) => `Rollback: ${value}`,
  failureDiagnostic: (value) => `Saved diagnostic: ${value}`,
  failureAlsoInDoctor: (binary) => `Also reported by \`${binary} doctor\`.`,
};

const zhHans: SetupMessages = {
  languagePrompt: '选择语言 / Language',
  introTitle: (product) => `${product} 安装配置`,
  installationTitle: '安装信息',
  installationBody: ({ version, install, state, broker }) =>
    `版本：${version}\n程序位置：${install}\n数据目录：${state}\nBroker 地址：${broker}`,
  agentPreflightTitle: '编程助手检查',
  agentState: (state) => ({
    missing: '未安装',
    supported: '已支持',
    unsupported: '版本过低',
    'runtime-unavailable': '运行时不可用',
  })[state],
  agentBehavior: (id) => ({
    codex: '由 cosyncing 托管共享 app-server，远程终端可以接入。',
    opencode: '由 cosyncing 托管共享 serve；你自己启动的 server 不受影响。',
    pi: '装有 Pi 时，随包提供会话内 bridge。',
    omp: '装有 omp 时，随包提供会话内 bridge。',
    claude: '只有「观察 + 接管」两种模式；安装过程不会改动 Claude 的配置。',
    agy: '只有「观察 + 继续」两种模式；agy 没有常驻进程，安装过程不会改动 Antigravity 的数据。',
    kimi: '由 cosyncing 托管 `kimi web` host；你自己启动的 server 不受影响。',
    dsh: '由 cosyncing 托管 `dsh web` host；你自己启动的、或在其他机器上的 host 都不受影响。',
  }[id] ?? '由 cosyncing 托管的外部 host；你自己启动的不受影响。'),
  unsupportedVersionUnreadable: '无法读取已安装的版本',
  unsupportedDetected: (version) => `检测到 ${version}`,
  unsupportedUpgrade: (command) => `请执行 \`${command}\` 升级。`,
  unsupportedReason: ({ detected, displayName, minimumVersion, upgrade }) =>
    `\n  版本过低：${detected}；${displayName} 需要 ${minimumVersion} 或更新版本。${upgrade}`,
  runtimeUnavailableReason: ({ installedVersion, minimumVersion }) =>
    `\n  运行时不可用：实际 Node ${installedVersion ?? '无法验证'}；`
      + `${minimumVersion ? `需要 Node ${minimumVersion} 或更新版本。` : ''}请升级实际 Node 运行时，然后重启 cosyncing。`,
  codexStandaloneWarning: (command) =>
    `警告：App 创建会话仍可使用；由 broker 托管的 daemon 和终端同步需要官方独立版 Codex。请执行 \`${command}\`；`
      + '官方安装器会检测 npm 版 Codex，并询问是否移除。安装完成后，请打开新终端并重新运行 `cosy setup`。',
  networkTitle: '网络与认证',
  networkLoopback: () =>
    `仅限回环访问。外部连接由操作者自行管理。参考 ${CONNECTIVITY_GUIDE_URL}，`
      + '或将这个网址复制给编程助手，请它在 `cosyncing setup` 完成后帮你配置 Tailscale Serve、EasyTier 或其他连接方式。',
  legacyConnectivityPreserved: (targets) =>
    `旧版外部连接保持不变，现由操作者管理${targets.length ? `：${targets.join('、')}` : '。'} `
      + '后续配置请参阅 docs/connectivity/tailscale-serve.md 和 '
      + 'docs/connectivity/migrating-from-managed-tailscale.md。',
  blocker: ({ summary, remediation }) => `${summary}\n解决办法：${remediation}`,
  managedRuntimeTitle: '需要确认：由 cosyncing 托管运行时',
  managedRuntimeBody: (product) =>
    `${product} 会接管支持的 Codex/OpenCode 共享运行时、随包提供的 Pi 与 omp bridge，以及 \`kimi web\` 和 \`dsh web\` host：没有运行时会启动，崩溃后会重启，并且只停止它自己启动的那个。你自己启动的进程不受影响。Claude 仍然只有「观察 + 接管」两种模式，其配置文件不会被改动。`,
  managedRuntimeConfirm: (product) => `我已了解，同意由 ${product} 托管这些共享运行时。`,
  legacyPiBridgeConfirm: (path) =>
    `用当前随包版本替换 ${path} 中内容完全匹配的已知旧版 Pi bridge？如果回滚，会逐字节恢复旧文件。`,
  agentSkillConfirm: '安装 cosyncing agent skill，让具备安全会话工具的编程助手可以把文件直接送到 App？',
  legacyAgentSkillConfirm: (paths) =>
    `升级 ${paths} 中已知的上一版 cosyncing skill？未知或已编辑的 skill 内容永远不会被覆盖。`,
  opencodeShimConfirm: '把终端里的 `opencode` 指向 cosyncing 的共享 serve，让它的状态实时显示在 App 里？',
  serviceQuestion: '安装完成后，broker 以哪种方式运行？',
  serviceForegroundLabel: '前台运行',
  serviceForegroundHint: (binary) => `每次自己执行 \`${binary} broker\` 启动。`,
  serviceDurableLabel: (provider) => provider === 'launchd' ? 'launchd 用户代理' : 'systemd 用户服务',
  serviceDurableHint: ({ provider, available }) => available
    ? provider === 'launchd'
      ? '常驻的 macOS LaunchAgent，从图形界面登录起运行到注销为止。'
      : '常驻的 Linux 服务（由服务包安装）。'
    : provider === 'launchd'
      ? '需要打包安装并处于 macOS 图形会话中；前台运行始终可用。'
      : '此主机不支持；前台运行始终可用。',
  launchdSessionNote: 'launchd 代理从图形界面登录起运行到注销为止。cosyncing 不会安装系统级 LaunchDaemon，'
    + '所以登录前和注销后 broker 都不会运行。',
  quotaNote: (baseUrl, capability) => `配额数据来自 ${baseUrl} 上的 Tokdash（可用 COSYNCING_TOKDASH_URL 覆盖）。`
    + '如果那里已经有 Tokdash 在运行，就直接复用，不会做任何改动；'
    + {
      'setup-only': '如果没有，cosyncing 会直接启动这台机器上已经装好的 tokdash：运行 `tokdash setup`，'
        + '然后打开配额跟踪。不会安装任何东西。卸载时只会撤销 cosyncing 自己启动的那个服务。',
      install: '如果没有，cosyncing 会自动帮你装一个并启动：先 `pipx install tokdash`，再 `tokdash setup`，'
        + '然后打开配额跟踪。卸载时只会撤销 cosyncing 自己装的东西。',
      unavailable: '如果没有，cosyncing 在这台机器上没法自动安装：系统里既没有 tokdash 也没有 pipx。'
        + '请先装好 pipx（它需要 Python 3.9+）——Ubuntu 上用 `sudo apt install pipx`，'
        + 'macOS 上用 `brew install pipx`——然后重新运行 setup，这一步就会自动补上。',
    }[capability],
  quotaUrlRejected: (rejection, baseUrl) =>
    `COSYNCING_TOKDASH_URL 被拒绝了，原因是${({
      unparseable: '它不是合法的 URL',
      'not-http': 'Tokdash 只提供 http(s) 服务',
      'not-loopback': '它指向的不是本机地址',
      credentials: '它里面带了账号密码',
    })[rejection]}，因此改用 ${baseUrl}——安装配置和 broker 用的都是它。`
    + '这个值本身不会被打印出来，因为覆盖值里可能带着密钥。',
  quotaConfirm: '启用基于 Tokdash 的本地 token 与用量配额跟踪？',
  quotaReused: (baseUrl) => `直接使用 ${baseUrl} 上已经在运行的 Tokdash，没有安装也没有改动任何东西。`,
  quotaProvisioned: (baseUrl, installed) => installed
    ? `已经装好并启动了 Tokdash（${baseUrl}），配额跟踪也已打开。`
    : `已经把这台机器上原本装好的 Tokdash 启动起来了（${baseUrl}），配额跟踪也已打开，没有安装任何东西。`,
  quotaEndpointUnsupported: (baseUrl) =>
    `cosyncing 无法在 ${baseUrl} 上自动安装 Tokdash：Tokdash 只在本机端口的根路径上提供普通 HTTP 服务。`
    + '安装配置本身已经完成；请自行在该地址启动 Tokdash，或修改 COSYNCING_TOKDASH_URL。',
  quotaProvisionFailed: (detail) => `Tokdash 没能装好，配额提醒暂时不可用。安装配置本身已经完成。${detail}`,
  planTitle: '将要执行的改动',
  planEmpty: '无需改动任何文件或服务。',
  // 路径、unit 名、URL、版本号、命令名一律保持原样：这些是操作者要输入和搜索的东西。
  planStep: (step) => {
    switch (step.kind) {
      case 'config':
        return `写入仅本人可读的 ${step.configPath}，内部地址为 ${step.internalUrl}。`;
      case 'credentials':
        return '生成仅本人可读的 broker 凭据和 Pi 专用凭据；不会打印出来，也不会出现在进程参数里。';
      case 'setup-state':
        return `记录托管运行时的确认结果、${step.service} 运行方式、单独的 lingering 授权，以及配额跟踪的选择。`;
      case 'pi-bridge':
        return step.replaceLegacy
          ? `以事务方式替换 ${step.path} 中内容完全匹配的已知旧版 bridge；回滚时会恢复原始字节。`
          : `把随包提供的 bridge 原样写入 ${step.path}；不会覆盖任何无关内容。`;
      case 'omp-bridge':
        return `把随包提供的 omp bridge 原样写入 ${step.path}；不会覆盖任何无关内容。`;
      case 'durable-state-permissions':
        return `收紧当前架构持久状态的仅本人访问权限：${step.paths.join('、')}；不修改文件内容。`;
      case 'agent-skill-install':
        return '把随包提供的 skill 安装到 Claude 和共享 .agents 两个发现目录，并为每个目标记录一条归属凭证。';
      case 'agent-skill-refresh':
        return '把 Claude 和共享 .agents 两个发现目录里的 cosyncing skill 更新到本版本，并刷新各自的归属凭证。';
      case 'agent-skill-remove':
        return '只从两个原生发现目录中删除凭证证明属于我们的副本。';
      case 'opencode-shim':
        return '安装 cosyncing 的 opencode shim，并在检测到的 bash/zsh rc 文件中加入一段受管理的 source 块；'
          + '打开新终端或执行 `source ~/.bashrc` 后生效。rc 里的其他内容会逐字节保留。';
      case 'service-install':
        return `必要时只停止我们自己的服务，写入并启用 ${step.definitionPath}，提交凭证，然后启动并做一次健康检查。`;
      case 'service-remove':
        return `只停止并删除凭证证明属于我们的 ${step.provider} 服务；`
          + `lingering 策略仅在当初由 ${step.product} 启用时才会一并取消。`;
      case 'binary-install':
        return `把正在运行的 ${step.version} 可执行文件复制到仅本人可读的 ${step.path}，`
          + '并记录其校验过的归属凭证；获取来源（例如 npm 包）不会被改动。';
      case 'codex-legacy-daemon-migration':
        return '停止身份已精确确认的旧版非托管 Codex app-server 进程，通过托管 daemon 命令重新启动，'
          + '并记录新控制 socket 的归属。当前已连接的 Codex 会话会断开。';
      case 'commit-receipts':
        return `全部校验通过之后，才把归属凭证提交到 ${step.installStatePath}。`;
    }
  },
  applyConfirm: '按以上清单执行并逐项校验？',
  resultSummary: (code, { binary, stage }) => {
    switch (code) {
      case 'complete': return '安装配置已完成。';
      case 'complete-no-agents':
        return '安装配置已完成。没有检测到受支持的编程助手；装好一个之后再跑一次 doctor。';
      case 'already-configured': return '已经配置过了；这次只刷新了健康检查和环境检查，没有做任何改动。';
      case 'blocked-preflight': return '环境检查发现阻塞项，安装中止，没有做任何改动。';
      case 'blocked-committed-dependency':
        return '已完成的安装出现了新的不安全或不可用的依赖项，没有做任何改动。';
      case 'declined-managed-runtime': return '必须的托管运行时确认被拒绝，没有做任何改动。';
      case 'declined-plan': return '改动清单未被确认，没有做任何改动。';
      case 'blocked-unsafe-plan': return '无法安全地执行这份清单，没有做任何改动。';
      case 'precondition-changed': return '确认之后前置条件发生了变化；请重新运行以查看新的清单。';
      case 'cancelled': return `安装已在「${stage}」这一步取消，没有做任何改动。`;
      case 'failed-rolled-back': return '安装失败，已执行的改动都已回滚。重新运行 setup 会重新检查一遍环境。';
      case 'failed-cleanup-remains':
        return `安装失败，且仍有未清理的改动。请保留事务日志并重新执行 \`${binary} setup\`，`
          + '它会先把剩下的部分回滚，再重新生成清单。';
    }
  },
  recoveredNote: '发现一次中断的安装事务，已按日志回滚到改动前的状态。',
  outroTitle: (product) => `打开 ${product}`,
  outroStateDirectory: (path) => `数据目录：${path}`,
  outroStartBroker: (binary) => `broker 还没有在运行，先启动它：\`${binary} broker\`。`,
  outroOpenHere: (url) => `本机 Web 应用：${url}`,
  outroOpenHereAfterStart: (url) => `本机 Web 应用：${url}`,
  outroLocalServerAddress: (url) => `本机服务器地址：${url}`,
  outroPairInstead: (binary) => `执行 \`${binary} pair\` 并扫描二维码，即可配对一台客户端。`,
  outroPairPageHere: (url) => `浏览器里也有同样的步骤：${url}`,
  outroPairPageHereAfterStart: (url) => `启动后，浏览器里也有同样的步骤：${url}`,
  outroLoopbackOnly:
    `仅限回环访问。外部连接由操作者自行管理。参考 ${CONNECTIVITY_GUIDE_URL}，`
      + '或将这个网址复制给编程助手，请它在 `cosyncing setup` 完成后帮你配置外部连接。',
  outroShortCommand: (alias, commands) =>
    `快捷命令：\`${alias}\` 是 \`cosyncing\` 的别名，例如 ${commands.map((value) => `\`${value}\``).join('、')}。`,
  outroTokenRead: (path) => `查看认证令牌文件：cat ${path}`,
  outroTokenSignIn: (appPath) => `网页版（${appPath}）用这个 token 登录。`,
  outroPreferPairing: (binary) =>
    `手机和平板建议用 \`${binary} pair\` 配对：每台设备拿到各自的凭据，可以单独吊销。`
      + '上面这个 token 文件是主密钥，拥有 broker API 的全部权限，而且所有人拿到的都是同一个。',
  cancelledNote: (stage) => `安装已在「${stage}」这一步取消，没有做任何改动。`,
  failureTitle: '安装失败原因',
  failureStep: (value) => `失败步骤：${value}`,
  failureReason: (value) => `原因：${value}`,
  failureCode: (value) => `错误码：${value}`,
  failureRollback: (value) => `回滚：${value}`,
  failureDiagnostic: (value) => `已保存的诊断文件：${value}`,
  failureAlsoInDoctor: (binary) => `\`${binary} doctor\` 也会报告这一项。`,
};

const CATALOG: Record<SetupLanguage, SetupMessages> = { en, 'zh-Hans': zhHans };

export function setupMessages(language: SetupLanguage | undefined): SetupMessages {
  return CATALOG[language ?? DEFAULT_SETUP_LANGUAGE];
}
