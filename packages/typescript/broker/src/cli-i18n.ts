import type { SetupCheck, SetupCheckStatus } from '@cosyncing/adapter-api';
import type { DoctorSection } from './doctor.ts';
import type {
  LifecycleCommandResult,
  LifecycleStatusReport,
  UninstallPlan,
} from './broker-lifecycle.ts';
import type { DurableServiceStatus } from './service-manager.ts';
import type {
  TailscaleBackendState,
  TailscaleServeRouteState,
  TailscaleTopology,
} from './tailscale-serve.ts';
import { PRODUCT_IDENTITY } from './product.ts';
import { readSetupState, setupStateHome } from './setup-state.ts';
import {
  DEFAULT_SETUP_LANGUAGE,
  normalizeSetupLanguage,
  type SetupLanguage,
} from './setup-i18n.ts';

/**
 * Human-only CLI copy. Structured reports, plan rows, detail codes, and result summaries remain the English
 * source-of-truth objects; renderers select a catalog only when writing terminal prose.
 */
export interface CliMessages {
  doctor: {
    title: (product: string) => string;
    sectionTitle: (section: Pick<DoctorSection, 'id' | 'title'>) => string;
    mark: Readonly<Record<SetupCheckStatus, string>>;
    checkSummary: (check: SetupCheck) => string;
    fixLabel: string;
    remediation: (check: SetupCheck) => string;
    totals: (summary: Readonly<Record<SetupCheckStatus, number>>) => string;
    internalFailureSummary: string;
  };
  status: {
    headline: (report: LifecycleStatusReport) => string;
    installation: (report: LifecycleStatusReport) => string;
    service: (report: LifecycleStatusReport) => string;
    internalEndpoint: (report: LifecycleStatusReport) => string;
    advertisedEndpoint: (report: LifecycleStatusReport) => string;
    tailscale: (report: LifecycleStatusReport) => string;
    agents: (report: LifecycleStatusReport) => string;
    sessions: (report: LifecycleStatusReport) => string;
    updates: (report: LifecycleStatusReport) => string;
    fix: (detailCodes: readonly string[]) => string;
  };
  uninstall: {
    planTitle: (count: number) => string;
    noExternalResources: string;
    beforeConfirm: string;
    advisory: (item: UninstallPlan['advisories'][number]) => string;
    purgeRoots: string;
    confirmOwned: string;
    confirmLegacy: string;
    confirmPurge: string;
    resultSummary: (result: LifecycleCommandResult, facts: UninstallRenderFacts) => string;
  };
}

export interface UninstallRenderFacts {
  purgeData: boolean;
  acquisitionPackagePreserved: boolean;
}

export type CliStatusValue =
  | LifecycleStatusReport['service']['mode']
  | DurableServiceStatus['active']
  | DurableServiceStatus['enabled']
  | LifecycleStatusReport['endpoints']['internal']
  | TailscaleTopology
  | TailscaleBackendState
  | TailscaleServeRouteState;

/** Invalid, absent, older, or newer persisted choices all degrade to English. */
export function persistedCliLanguage(home?: string): SetupLanguage {
  try {
    return normalizeSetupLanguage(readSetupState(home ?? setupStateHome()).language) ?? DEFAULT_SETUP_LANGUAGE;
  } catch {
    return DEFAULT_SETUP_LANGUAGE;
  }
}

const DOCTOR_SECTION_ZH: Readonly<Record<DoctorSection['id'], string>> = Object.freeze({
  package: '软件包',
  state: '配置和状态',
  agents: '编程智能体',
  host: '主机',
  service: '服务管理器',
  network: '网络',
  runtime: '托管运行时',
});

/** Fixed doctor sentences and remediations. Dynamic variants are handled immediately below. */
const ZH_HUMAN_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'All detected Codex terminals are attached to the shared server.': '检测到的所有 Codex 终端都已连接共享服务器。',
  'Agent executable coverage cannot be checked until the service environment is repaired.': '修复服务环境后才能检查智能体可执行文件的覆盖情况。',
  'The receipt-owned service environment does not contain a valid PATH.': '收据自有的服务环境不包含有效的 PATH。',
  'The receipt-owned service executable state cannot produce a valid bounded PATH.': '收据自有的服务可执行文件状态无法生成有效的受限 PATH。',
  'The durable service agent environment matches the bounded PATH, detected executable directories, and explicit overrides.': '持久服务智能体环境与受限 PATH、检测到的可执行文件目录及显式覆盖项一致。',
  'The durable service agent environment does not match the bounded PATH and overrides for the currently detected executables.': '持久服务智能体环境与当前检测到的可执行文件所需的受限 PATH 和覆盖项不一致。',
  'The running broker did not report agent creation readiness.': '正在运行的 broker 未报告智能体创建会话的就绪状态。',
  'Rebuild the durable service environment.': '重新生成持久服务环境。',
  'Reconcile the service PATH with the currently installed agent executables.': '根据当前安装的智能体可执行文件修复服务 PATH。',
  'Reconcile the durable service PATH and restart the broker.': '修复持久服务 PATH 并重启 broker。',
  'Restart the broker-managed OpenCode shared server; inspect `cosyncing logs` if it remains unavailable.': '重启由 broker 管理的 OpenCode 共享服务器；若仍不可用，请检查 `cosyncing logs`。',
  'Verify the durable service and agent runtime state, then rerun doctor.': '检查持久服务和智能体运行时状态，然后重新运行 doctor。',
  'Reconcile and restart the broker, then rerun doctor.': '修复并重启 broker，然后重新运行 doctor。',
  'Codex terminal attachment could not be confirmed safely.': '无法安全确认 Codex 终端的连接状态。',
  'Rerun doctor after Codex and the broker settle; use the generated Resume command if needed.': '等待 Codex 和 broker 状态稳定后重新运行 doctor；需要时使用生成的 Resume 命令。',
  'Codex terminal readiness is unavailable because the shared server is not running.': '共享服务器未运行，因此无法检查 Codex 终端就绪状态。',
  'Start or reconcile the managed Codex shared server.': '启动或修复托管的 Codex 共享服务器。',
  'Codex terminal readiness inspection is unavailable on this platform.': '此平台不支持检查 Codex 终端就绪状态。',
  'Codex terminal readiness inspection failed safely.': 'Codex 终端就绪状态检查已安全失败。',
  'Close and reopen those terminals; new Codex terminals connect to the shared server automatically.': '请关闭并重新打开这些终端；新的 Codex 终端会自动连接共享服务器。',
  'Close and reopen those terminals with the generated custom remote command; use Resume to keep their threads.': '请用生成的自定义远程命令关闭并重新打开这些终端；使用 Resume 保留原有对话。',
  'Broker configuration is valid.': 'Broker 配置有效。',
  'Broker configuration is missing.': '缺少 broker 配置。',
  'Create validated broker configuration through setup.': '通过 setup 创建经过验证的 broker 配置。',
  'Broker configuration is unsafe, malformed, unsupported, or requires migration.': 'Broker 配置不安全、格式错误、不受支持或需要迁移。',
  'Inspect, migrate, or repair broker configuration.': '检查、迁移或修复 broker 配置。',
  'Back up and reconcile durable state.': '备份并修复持久状态。',
  'Source-development environment overrides take precedence over stored configuration.': '源码开发环境变量覆盖了已保存的配置。',
  'No source-development environment override changes effective broker configuration.': '没有源码开发环境变量改变 broker 的实际配置。',
  'Remove stale development overrides before validating packaged behavior.': '验证发行包行为前，请移除过期的开发环境变量。',
  'Effective broker configuration is invalid.': 'Broker 的实际配置无效。',
  'Repair configuration before starting the broker.': '启动 broker 前请先修复配置。',
  'WSL is supported through the declared Linux subset.': '通过已声明的 Linux 子集支持 WSL。',
  'Linux is a supported v1 broker host.': 'Linux 是 v1 支持的 broker 主机。',
  'macOS on Apple Silicon is a supported broker host.': 'Apple Silicon macOS 是受支持的 broker 主机。',
  'Native Windows broker hosting is a named near-term follow-up, not part of v1.': '原生 Windows broker 托管不属于 v1，将在后续版本支持。',
  'Run the broker inside the supported WSL subset.': '请在受支持的 WSL 子集中运行 broker。',
  'launchctl is not on PATH, so the launchd user domain cannot be inspected; foreground mode remains supported.': 'PATH 中没有 launchctl，因此无法检查 launchd 用户域；仍可使用前台模式。',
  'Run the broker in the foreground on this host.': '请在此主机上以前台模式运行 broker。',
  'The launchd GUI user domain is available.': 'launchd GUI 用户域可用。',
  'The launchd GUI user domain could not be inspected; foreground mode remains supported.': '无法检查 launchd GUI 用户域；仍可使用前台模式。',
  'Sign in to a macOS GUI session for service mode, or run the broker in the foreground.': '如需服务模式，请登录 macOS GUI 会话；也可以以前台模式运行 broker。',
  'WSL systemd is unavailable; foreground broker mode remains supported.': 'WSL systemd 不可用；仍可使用 broker 前台模式。',
  'systemd user-service tooling is unavailable.': 'systemd 用户服务工具不可用。',
  'Run the broker in the foreground, or enable WSL systemd for persistence.': '请以前台模式运行 broker，或启用 WSL systemd 以保持后台运行。',
  'Install/enable a systemd user manager before service setup.': '配置服务前，请安装并启用 systemd 用户管理器。',
  'The systemd user manager is degraded but reachable.': 'systemd 用户管理器状态降级，但仍可访问。',
  'The systemd user manager is available.': 'systemd 用户管理器可用。',
  'Inspect failed user units before service installation.': '安装服务前，请检查失败的用户单元。',
  'WSL has systemctl but no usable user manager; foreground mode remains supported.': 'WSL 有 systemctl，但没有可用的用户管理器；仍可使用前台模式。',
  'The systemd user manager is not reachable.': '无法访问 systemd 用户管理器。',
  'Use foreground mode or enable WSL systemd and user services.': '请使用前台模式，或启用 WSL systemd 和用户服务。',
  'Enable the systemd user manager and login session.': '请启用 systemd 用户管理器和登录会话。',
  'Persistent broker service mode is not selected.': '未选择 broker 持久服务模式。',
  'The broker service definition or owner-only environment file is missing, unsafe, or changed outside its receipt.': 'Broker 服务定义或仅所有者可读的环境文件缺失、不安全，或已在收据记录之外被修改。',
  'The receipt-owned broker service is enabled and active.': '收据证明归属的 broker 服务已启用并正在运行。',
  'The broker service is failed or crash-looping.': 'Broker 服务已失败或反复崩溃。',
  'The broker service is disabled, inactive, or still transitioning.': 'Broker 服务已禁用、未运行或仍在切换状态。',
  'Inspect the redacted service log output, then repair or restart the service.': '检查已脱敏的服务日志，然后修复或重启服务。',
  'Reconcile and start the owned service.': '修复并启动自有服务。',
  'launchd has no user-lingering equivalent; the broker runs from GUI login to logout.': 'launchd 没有与用户 lingering 对应的机制；broker 只在 GUI 登录期间运行。',
  'Systemd user lingering was not requested; service persistence begins with a login session.': '未请求 systemd 用户 lingering；服务从登录会话开始保持运行。',
  'Requested boot and post-logout persistence cannot be verified because loginctl is unavailable.': 'loginctl 不可用，因此无法验证所请求的开机及注销后持续运行。',
  'Restore loginctl or decline lingering explicitly.': '请恢复 loginctl，或明确取消 lingering。',
  'Requested user lingering cannot be tied to a safe local user identifier.': '无法将所请求的用户 lingering 关联到安全的本地用户标识。',
  'Reconcile the installing user and lingering state.': '请修复安装用户和 lingering 状态。',
  'Systemd user lingering is enabled for boot and post-logout persistence.': '已启用 systemd 用户 lingering，可在开机及注销后保持运行。',
  'Systemd user lingering was requested but is not enabled.': '已请求 systemd 用户 lingering，但尚未启用。',
  'Reconcile the separately consented lingering policy.': '请修复单独确认过的 lingering 策略。',
  'Tailscale is running and authenticated with a MagicDNS HTTPS hostname.': 'Tailscale 正在运行且已认证，并提供 MagicDNS HTTPS 主机名。',
  'The receipt-owned private HTTPS root route targets this broker.': '收据证明归属的私有 HTTPS 根路由指向此 broker。',
  'A matching private HTTPS root route is available and remains foreign-owned.': '存在匹配的私有 HTTPS 根路由，其归属仍为外部。',
  'Inspect the existing Serve configuration; cosyncing preserves foreign routes and never converts Funnel.': '请检查现有 Serve 配置；cosyncing 会保留外部路由，且绝不会转换 Funnel。',
  'Confirm and register the private HTTPS route.': '请确认并注册私有 HTTPS 路由。',
  'The installed broker internal endpoint is not healthy.': '已安装 broker 的内部端点状态异常。',
  'The broker internal endpoint is not running yet.': 'Broker 内部端点尚未运行。',
  'Reconcile and start the broker service.': '修复并启动 broker 服务。',
  'Broker health is critical.': 'Broker 健康状态严重异常。',
  'Broker health is degraded.': 'Broker 健康状态已降级。',
  'Broker internal endpoint is healthy.': 'Broker 内部端点状态正常。',
  'Broker health returned an unknown status.': 'Broker 健康检查返回未知状态。',
  'Inspect and repair failing broker health components.': '请检查并修复异常的 broker 健康组件。',
  'One or more managed runtimes could not report update state.': '一个或多个托管运行时无法报告更新状态。',
  'One or more managed runtimes have a pending update.': '一个或多个托管运行时有待安装的更新。',
  'Managed runtime versions are current.': '托管运行时均为当前版本。',
  'Reconcile managed runtime versions when sessions are safe to restart.': '请在会话可安全重启时修复托管运行时版本。',
  'Managed runtime update status is unavailable.': '托管运行时更新状态不可用。',
  'Retry managed runtime diagnosis.': '请重试托管运行时诊断。',
  'No private advertised endpoint is configured; the broker remains loopback-only.': '未配置私有公开端点；broker 仍仅限本机访问。',
  'Configure Tailscale Serve only if private remote access is wanted.': '仅在需要私有远程访问时配置 Tailscale Serve。',
  'The advertised private endpoint is reachable.': '私有公开端点可访问。',
  'The configured advertised endpoint is unreachable.': '无法访问已配置的公开端点。',
  'Repair the private Serve route or advertised URL.': '请修复私有 Serve 路由或公开 URL。',
  'Update cosyncing to a build with complete adapter diagnosis.': '请将 cosyncing 更新到包含完整适配器诊断的版本。',
  'Retry diagnosis after checking the agent installation.': '检查智能体安装后，请重试诊断。',
  'Repair or reinstall the packaged runtime assets.': '请修复或重新安装发行包运行时资源。',
  'This build embeds its own runtime, so no external interpreter is required.': '此版本自带运行时，无需外部解释器。',
  'The Bun runtime this build requires is installed and executable.': '此版本所需的 Bun 运行时已安装且可执行。',
  'cosyncing could not resolve the Bun runtime that must execute it.': '无法解析用于执行 cosyncing 的 Bun 运行时。',
  'The Bun runtime is older than cosyncing requires.': 'Bun 运行时版本低于 cosyncing 的要求。',
  'The configured runtime did not identify itself as Bun.': '所配置的运行时未表明自己是 Bun。',
  'COSYNCING_BUN_BIN does not name a usable Bun runtime.': 'COSYNCING_BUN_BIN 指向的不是可用的 Bun 运行时。',
  'Install a supported Bun runtime, then rerun `cosyncing setup`.': '请安装受支持的 Bun 运行时，然后重新运行 `cosyncing setup`。',
  'Rewrite the service definition with the current runtime path.': '请用当前运行时路径重写服务定义。',
  'Run the broker on a supported host: linux-x64, linux-arm64, or darwin-arm64.': '请在受支持的主机上运行 broker：linux-x64、linux-arm64 或 darwin-arm64。',
  'No legacy cosyncing-hook settings entry is present.': '没有旧版 cosyncing-hook 设置项。',
  'Legacy Claude hook entries are present; their command may contain an embedded shared credential.': '存在旧版 Claude hook 项；其中的命令可能含有嵌入式共享凭据。',
  'Review marker-owned entries and rotate any embedded credential before confirmed removal.': '确认移除前，请检查带归属标记的条目并轮换其中的嵌入式凭据。',
  'Claude settings cannot be inspected safely for legacy hook entries.': '无法安全检查 Claude 设置中的旧版 hook 项。',
  'Fix Claude settings readability, then rerun `cosyncing doctor`.': '请修复 Claude 设置的可读性，然后重新运行 `cosyncing doctor`。',
  'Claude transcript storage is readable.': 'Claude 对话记录存储可读。',
  'Claude transcript storage is not present yet.': 'Claude 对话记录存储尚不存在。',
  'Start Claude Code once to create its transcript store.': '请启动一次 Claude Code，以创建对话记录存储。',
  'Claude transcript storage is unreadable or has an unexpected type.': 'Claude 对话记录存储不可读或类型异常。',
  'Repair Claude transcript access.': '请修复 Claude 对话记录访问。',
  'Pi session storage is readable.': 'Pi 会话存储可读。',
  'Pi session storage is not present yet.': 'Pi 会话存储尚不存在。',
  'Start Pi once to create its session store.': '请启动一次 Pi，以创建会话存储。',
  'Pi session storage is unreadable or has an unexpected type.': 'Pi 会话存储不可读或类型异常。',
  'Repair the Pi integration paths.': '请修复 Pi 集成路径。',
  'Pi is installed, but its launcher cannot be inspected safely.': 'Pi 已安装，但无法安全检查其启动器。',
  'Repair the Pi installation, then rerun doctor.': '请修复 Pi 安装，然后重新运行 doctor。',
  'Pi launcher runtime could not be verified.': '无法验证 Pi 启动器运行时。',
  'Pi uses a native executable and does not depend on Node launcher compatibility.': 'Pi 使用原生可执行文件，不依赖 Node 启动器兼容性。',
  'Installed Pi bridge matches the packaged asset.': '已安装的 Pi bridge 与发行包资源一致。',
  'The Pi bridge extension is not installed.': '未安装 Pi bridge 扩展。',
  'Install the packaged Pi bridge through setup.': '请通过 setup 安装发行包中的 Pi bridge。',
  'A legacy cosyncing Pi bridge is present and requires confirmation before replacement.': '存在旧版 cosyncing Pi bridge；替换前需要确认。',
  'Review and reconcile the legacy bridge.': '请检查并修复旧版 bridge。',
  'The Pi bridge target contains unowned content and will not be overwritten.': 'Pi bridge 目标中含有非自有内容，不会被覆盖。',
  'Back up or relocate the existing extension, then rerun `cosyncing repair`.': '请备份或移动现有扩展，然后重新运行 `cosyncing repair`。',
  'The Pi bridge target cannot be inspected safely.': '无法安全检查 Pi bridge 目标。',
  'Repair Pi bridge ownership and permissions.': '请修复 Pi bridge 的归属和权限。',
  'No optional Pi bridge approval configuration is present.': '没有可选的 Pi bridge 审批配置。',
  'Pi bridge configuration is unreadable.': 'Pi bridge 配置不可读。',
  'Reconcile the Pi bridge configuration.': '请修复 Pi bridge 配置。',
  'Legacy Pi bridge configuration may contain a fixed broker URL or embedded shared credential.': '旧版 Pi bridge 配置可能含有固定 broker URL 或嵌入式共享凭据。',
  'Rotate and move integration data into the owner-only scoped record.': '请轮换集成数据，并将其移入仅所有者可读的作用域记录。',
  'Pi bridge configuration contains approval preferences only.': 'Pi bridge 配置仅含审批偏好。',
  'Pi bridge configuration is malformed.': 'Pi bridge 配置格式错误。',
  'OpenCode local session storage is readable.': 'OpenCode 本地会话存储可读。',
  'OpenCode local session storage is not present yet.': 'OpenCode 本地会话存储尚不存在。',
  'Start OpenCode once or use a reachable shared server.': '请启动一次 OpenCode，或使用可访问的共享服务器。',
  'OpenCode local session storage is unreadable or has an unexpected type.': 'OpenCode 本地会话存储不可读或类型异常。',
  'Repair the OpenCode integration paths.': '请修复 OpenCode 集成路径。',
  'The configured OpenCode server URL is invalid.': '已配置的 OpenCode 服务器 URL 无效。',
  'Reconfigure the OpenCode integration.': '请重新配置 OpenCode 集成。',
  'OpenCode shared server is reachable.': 'OpenCode 共享服务器可访问。',
  'The OpenCode port is occupied but does not expose the expected health contract.': 'OpenCode 端口已被占用，但未提供预期的健康检查协议。',
  'Reconcile the managed OpenCode server without killing an unowned process.': '请修复托管的 OpenCode 服务器，不要终止非自有进程。',
  'The configured OpenCode server is unreachable.': '无法访问已配置的 OpenCode 服务器。',
  'No shared OpenCode server is currently reachable.': '当前没有可访问的 OpenCode 共享服务器。',
  'Let setup reconcile the managed OpenCode server.': '请让 setup 修复托管的 OpenCode 服务器。',
  'Install OpenCode before enabling its shared server.': '启用共享服务器前，请先安装 OpenCode。',
  'OpenCode uses an externally managed server; cosyncing will not launch another one.': 'OpenCode 使用外部管理的服务器；cosyncing 不会再启动一个。',
  'Managed OpenCode serve is disabled by source-development configuration.': '源码开发配置已禁用托管的 OpenCode serve。',
  'Reconcile packaged configuration.': '请修复发行包配置。',
  'OpenCode is eligible for the broker-managed shared server.': 'OpenCode 可使用由 broker 管理的共享服务器。',
  'Managed serve eligibility was not checked because OpenCode is missing.': '缺少 OpenCode，因此未检查托管 serve 资格。',
  'Codex daemon status was not queried because its binary or safe socket is unavailable.': 'Codex 可执行文件或安全套接字不可用，因此未查询 daemon 状态。',
  'The standalone Codex package was not checked because Codex is missing.': '缺少 Codex，因此未检查独立版安装。',
  'An external Codex daemon is configured, so cosyncing does not require the standalone package.': '已配置外部 Codex daemon，因此 cosyncing 不要求安装独立版。',
  'The official standalone Codex package is installed for the managed daemon and terminal sync.': '官方独立版 Codex 已安装，可用于托管 daemon 和终端同步。',
  'Codex is supported, but the official standalone package is missing; the broker-managed daemon and terminal sync are unavailable.': 'Codex 版本受支持，但缺少官方独立版；由 broker 托管的 daemon 和终端同步不可用。',
  'The official standalone Codex package is unreadable or has an unexpected file type.': '官方独立版 Codex 不可读或文件类型异常。',
  'Install the official standalone Codex CLI, open a new terminal, then rerun `cosy setup`.': '请安装官方独立版 Codex，打开新终端，然后重新运行 `cosy setup`。',
  'The Codex daemon socket is present; active-listener verification is Linux/WSL-only on this host.': 'Codex daemon 套接字存在；此主机仅在 Linux/WSL 上支持活动监听器验证。',
  'Codex daemon socket has an active Unix listener.': 'Codex daemon 套接字有活动的 Unix 监听器。',
  'The Codex daemon socket exists but no active listener could be verified.': 'Codex daemon 套接字存在，但无法确认活动监听器。',
  'The Codex daemon socket exists, but Linux Unix-listener state is unreadable.': 'Codex daemon 套接字存在，但无法读取 Linux Unix 监听器状态。',
  'Reconcile the managed Codex daemon.': '请修复托管的 Codex daemon。',
  'Authoritative Codex terminal-presence detection is unavailable on this platform.': '此平台不支持可靠的 Codex 终端存在性检测。',
  'Use Observe or explicit Take over; automatic Drive restoration stays disabled.': '请使用 Observe 或明确执行 Take over；自动恢复 Drive 将保持禁用。',
  'macOS process identity, cwd, and Unix-socket diagnostics are available.': 'macOS 进程身份、工作目录和 Unix 套接字诊断可用。',
  'Codex terminal presence cannot be proved on this Mac because ps or lsof is unavailable.': '此 Mac 缺少 ps 或 lsof，因此无法确认 Codex 终端是否存在。',
  'Restore the standard macOS ps and lsof tools; automatic Drive restoration stays disabled until presence can be proved.': '请恢复标准 macOS ps 和 lsof 工具；在能够确认终端存在性之前，自动恢复 Drive 将保持禁用。',
  'Linux process and Unix-socket diagnostics are available.': 'Linux 进程和 Unix 套接字诊断可用。',
  'Codex terminal presence cannot be proved on this host.': '无法在此主机上确认 Codex 终端是否存在。',
  'Ensure Linux /proc process state is readable.': '请确保 Linux /proc 进程状态可读。',
  'The managed-runtime failure record is unreadable.': '托管运行时失败记录不可读。',
  'The managed-runtime failure record is malformed.': '托管运行时失败记录格式错误。',
  'Repair broker-owned diagnostic state.': '请修复 broker 自有的诊断状态。',
  'Retry the managed runtime check and inspect the recorded failure.': '请重试托管运行时检查，并查看已记录的失败。',
  'Install the official Codex CLI, then rerun doctor.': '请安装官方 Codex CLI，然后重新运行 doctor。',
  'Install the official OpenCode CLI, then rerun doctor.': '请安装官方 OpenCode CLI，然后重新运行 doctor。',
  'Install the supported Pi coding-agent package, then rerun doctor.': '请安装受支持的 Pi coding-agent 软件包，然后重新运行 doctor。',
  'Install the official Claude Code CLI, then rerun doctor.': '请安装官方 Claude Code CLI，然后重新运行 doctor。',
  'Run setup or repair after installing Codex.': '安装 Codex 后，请运行 setup 或 repair。',
  'Inspect and repair the Codex installation state.': '请检查并修复 Codex 安装状态。',
  'Repair the package.': '请修复软件包。',
  'Packaged asset is verified.': '发行包资源已验证。',
  'Packaged asset is missing.': '缺少发行包资源。',
  'Repair the installation, then rerun doctor.': '请修复安装，然后重新运行 doctor。',
  'Preserve or reconcile the user-managed copy explicitly; repair will not overwrite it.': '请明确保留或修复用户管理的副本；repair 不会覆盖它。',
  'Rerun setup or repair to refresh the receipt-owned packaged skill.': '请重新运行 setup 或 repair，以更新收据证明归属的发行包 skill。',
  'Restore the receipt-owned packaged skill.': '请恢复收据证明归属的发行包 skill。',
  'Address the reported cause, then rerun setup.': '请处理报告的原因，然后重新运行 setup。',
  'Cleanup from that run remains; rerun setup, which rolls the remainder back before replanning.': '上次运行仍有清理项；请重新运行 setup，它会先回滚剩余改动再重新规划。',
  'Tailscale is not installed in the broker host environment.': 'Broker 主机环境中未安装 Tailscale。',
  'Windows-host Tailscale cannot Serve a broker bound to WSL loopback.': 'Windows 主机上的 Tailscale 无法为绑定到 WSL 回环地址的 broker 提供 Serve。',
  'Install and run Tailscale inside WSL; Windows-host Tailscale cannot Serve WSL loopback.': '请在 WSL 内安装并运行 Tailscale；Windows 主机上的 Tailscale 无法为 WSL 回环地址提供 Serve。',
  'Start or log in to Tailscale explicitly; cosyncing never runs `tailscale up` and never enables Funnel.': '请明确启动或登录 Tailscale；cosyncing 绝不会运行 `tailscale up`，也绝不会启用 Funnel。',
  'The Tailscale CLI is installed, but its local daemon is not reachable.': 'Tailscale CLI 已安装，但无法访问其本地 daemon。',
  'Tailscale returned malformed status JSON.': 'Tailscale 返回了格式错误的状态 JSON。',
  'Tailscale requires an explicit login before private Serve can be configured.': '配置私有 Serve 前，需要明确登录 Tailscale。',
  'Tailscale is not in the running state.': 'Tailscale 未处于运行状态。',
  'Tailscale is running, but no MagicDNS HTTPS hostname is available.': 'Tailscale 正在运行，但没有可用的 MagicDNS HTTPS 主机名。',
  'Tailscale Serve is ready but has no root HTTPS route for cosyncing.': 'Tailscale Serve 已就绪，但没有供 cosyncing 使用的 HTTPS 根路由。',
  'Tailscale Serve configuration could not be inspected safely.': '无法安全检查 Tailscale Serve 配置。',
  'Tailscale Serve returned malformed configuration JSON.': 'Tailscale Serve 返回了格式错误的配置 JSON。',
  'The private HTTPS root route already targets this broker.': '私有 HTTPS 根路由已指向此 broker。',
  'No private HTTPS root route targets this broker yet.': '尚无私有 HTTPS 根路由指向此 broker。',
  'The HTTPS root is currently public through Funnel and will not be changed.': 'HTTPS 根路由当前通过 Funnel 公开，不会被更改。',
  'An existing HTTPS root route conflicts with the broker target and will be preserved.': '现有 HTTPS 根路由与 broker 目标冲突，将予以保留。',
  'The broker remains loopback-only.': 'Broker 仍仅限本机访问。',
  'Loopback-only operation remains supported.': '仍支持仅限本机运行。',
});

function replaceMatch(source: string, pattern: RegExp, replacement: (...parts: string[]) => string): string | undefined {
  const match = source.match(pattern);
  return match ? replacement(...match.slice(1)) : undefined;
}

function zhLabel(label: string): string {
  const translated: Readonly<Record<string, string>> = {
    'Broker credential': 'Broker 凭据',
    'Pi integration credential': 'Pi 集成凭据',
    'Codex session store': 'Codex 会话存储',
    'Codex configuration': 'Codex 配置',
    'Codex managed app-server socket': 'Codex 托管 app-server 套接字',
  };
  return translated[label] ?? label;
}

/** Translate current dynamic doctor sentences; callers use a Chinese detail-code fallback for unknown copy. */
export function translateDoctorTextToChinese(source: string): string | undefined {
  const exact = ZH_HUMAN_TEXT[source];
  if (exact) return exact;
  const dynamic =
    replaceMatch(source, /^(.*) is present and verified\.$/, (asset) => `${asset} 存在且已验证。`)
    ?? replaceMatch(
      source,
      /^([a-z0-9]+-[a-z0-9]+) is not a supported cosyncing broker host\.$/,
      (host) => `${host} 不是受支持的 cosyncing broker 主机。`,
    )
    ?? replaceMatch(
      source,
      /^The installed service runs (.*), but cosyncing is now executed by (.*); the service cannot start until the unit is rewritten\.$/,
      (recorded, current) => `已安装的服务使用 ${recorded}，但 cosyncing 现在由 ${current} 执行；在重写服务定义前，该服务无法启动。`,
    )
    ?? replaceMatch(source, /^(.*) failed package verification\.$/, (asset) => `${asset} 未通过软件包验证。`)
    ?? replaceMatch(source, /^(.*) is not part of the required v1 package\.$/, (asset) => `${asset} 不属于 v1 必需的软件包内容。`)
    ?? replaceMatch(source, /^(.*) is valid and owner-only\.$/, (label) => `${zhLabel(label)}有效且仅所有者可访问。`)
    ?? replaceMatch(source, /^(.*) is missing, unsafe, unreadable, or malformed\.$/, (label) => `${zhLabel(label)}缺失、不安全、不可读或格式错误。`)
    ?? replaceMatch(source, /^Create (.*) through setup\.$/, (label) => `请通过 setup 创建${zhLabel(label)}。`)
    ?? replaceMatch(source, /^Repair or rotate (.*)\.$/, (label) => `请修复或轮换${zhLabel(label)}。`)
    ?? replaceMatch(source, /^(.*) state schema is current\.$/, (id) => `${id} 状态 schema 为当前版本。`)
    ?? replaceMatch(source, /^(.*) state has not been created yet\.$/, (id) => `${id} 状态尚未创建。`)
    ?? replaceMatch(source, /^(.*) state requires repair or migration\.$/, (id) => `${id} 状态需要修复或迁移。`)
    ?? replaceMatch(source, /^(\d+) already-running Codex terminal(?:s)? must be reopened to join the shared server\.$/, (count) => `需要重新打开 ${count} 个正在运行的 Codex 终端，才能连接共享服务器。`)
    ?? replaceMatch(source, /^(.*) is not installed or is not on PATH\.$/, (name) => `${name} 未安装或不在 PATH 中。`)
    ?? replaceMatch(source, /^Version was not checked because the (.*) binary is missing\.$/, (name) => `缺少 ${name} 可执行文件，因此未检查版本。`)
    ?? replaceMatch(source, /^(.*) executable found\.$/, (name) => `已找到 ${name} 可执行文件。`)
    ?? replaceMatch(source, /^(.*) version could not be verified\.$/, (name) => `无法验证 ${name} 版本。`)
    ?? replaceMatch(source, /^(.*) version could not be compared with the supported floor\.$/, (name) => `无法将 ${name} 版本与最低支持版本比较。`)
    ?? replaceMatch(source, /^(.*) ([^ ]+) is below supported ([^ ]+)\.$/, (name, installed, minimum) => `${name} ${installed} 低于最低支持版本 ${minimum}。`)
    ?? replaceMatch(source, /^(.*) version is supported\.$/, (name) => `${name} 版本受支持。`)
    ?? replaceMatch(source, /^Update (.*), then rerun doctor\.$/, (name) => `请更新 ${name}，然后重新运行 doctor。`)
    ?? replaceMatch(source, /^Update (.*) to ([^ ]+) or newer\.$/, (name, minimum) => `请将 ${name} 更新到 ${minimum} 或更高版本。`)
    ?? replaceMatch(source, /^Install Node ([^ ]+) or newer, ensure the durable broker service PATH selects it, then restart cosyncing\.$/, (minimum) => `请安装 Node ${minimum} 或更高版本，确保持久 broker 服务 PATH 选择该版本，然后重启 cosyncing。`)
    ?? replaceMatch(source, /^Pi requires Node ([^ ]+) or newer, but its effective interpreter is unavailable\.$/, (minimum) => `Pi 需要 Node ${minimum} 或更高版本，但其实际解释器不可用。`)
    ?? replaceMatch(source, /^Pi requires Node ([^ ]+) or newer, but its effective interpreter is Node ([^ ]+)\.$/, (minimum, installed) => `Pi 需要 Node ${minimum} 或更高版本，但其实际解释器为 Node ${installed}。`)
    ?? replaceMatch(source, /^Pi requires Node ([^ ]+) or newer, but its effective interpreter version could not be verified\.$/, (minimum) => `Pi 需要 Node ${minimum} 或更高版本，但无法验证实际解释器版本。`)
    ?? replaceMatch(source, /^Pi effective Node ([^ ]+) satisfies the installed distribution floor\.$/, (installed) => `Pi 的实际 Node ${installed} 满足已安装发行版的最低要求。`)
    ?? replaceMatch(source, /^No (.*) managed-start failure is recorded\.$/, (name) => `没有记录 ${name} 的托管启动失败。`)
    ?? replaceMatch(source, /^The last managed (.*) start failed\.$/, (name) => `上次托管启动 ${name} 失败。`)
    ?? replaceMatch(source, /^(.*) is readable\.$/, (label) => `${zhLabel(label)}可读。`)
    ?? replaceMatch(source, /^(.*) is not present\.$/, (label) => `${zhLabel(label)}不存在。`)
    ?? replaceMatch(source, /^(.*) is unreadable or has an unexpected file type\.$/, (label) => `${zhLabel(label)}不可读或文件类型异常。`)
    ?? replaceMatch(source, /^The configured broker service cannot be inspected because (.*) is unavailable\.$/, (manager) => `${manager} 不可用，因此无法检查已配置的 broker 服务。`)
    ?? replaceMatch(source, /^Restore (.*) or switch explicitly to foreground mode\.$/, (manager) => `请恢复 ${manager}，或明确切换到前台模式。`)
    ?? replaceMatch(source, /^Reconcile the receipt-owned (.*) service files\.$/, (provider) => `请修复收据证明归属的 ${provider} 服务文件。`)
    ?? replaceMatch(source, /^The package-owned cosyncing skill is present in the (.*) discovery root\.$/, (target) => `软件包自有的 cosyncing skill 已存在于 ${target} 发现根目录。`)
    ?? replaceMatch(source, /^The (.*) cosyncing skill is an older packaged version; setup or repair will refresh it to this build's version\.$/, (target) => `${target} cosyncing skill 是较旧的发行包版本；setup 或 repair 会将其更新到当前构建版本。`)
    ?? replaceMatch(source, /^The requested (.*) cosyncing skill is missing( and lacks a matching receipt)?\.$/, (target, noReceipt) => `缺少所请求的 ${target} cosyncing skill${noReceipt ? '，且没有匹配的收据' : ''}。`)
    ?? replaceMatch(source, /^The (.*) cosyncing skill is modified, unsafe, or lacks matching ownership evidence\.$/, (target) => `${target} cosyncing skill 已被修改、不安全或缺少匹配的归属证据。`)
    ?? replaceMatch(source, /^The last setup run failed while applying ([^:]+): (.*)$/, (action, detail) => `上次 setup 在应用 ${action} 时失败：${detail}`)
    ?? replaceMatch(source, /^The last setup run failed while in the ([^ ]+) stage: (.*)$/, (stage, detail) => `上次 setup 在 ${stage} 阶段失败：${detail}`)
    ?? replaceMatch(source, /^(.*) The broker remains loopback-only\.$/, (summary) => `${translateDoctorTextToChinese(summary) ?? 'Tailscale 状态异常。'} Broker 仍仅限本机访问。`)
    ?? replaceMatch(source, /^The requested private Serve route is not ready: (.*)$/, (summary) => `所请求的私有 Serve 路由尚未就绪：${translateDoctorTextToChinese(summary) ?? 'Tailscale 状态异常。'}`)
    ?? replaceMatch(source, /^(.*) Loopback-only operation remains supported\.$/, (summary) => `${translateDoctorTextToChinese(summary) ?? 'Tailscale 状态异常。'} 仍支持仅限本机运行。`)
    ?? replaceMatch(source, /^(.*) does not provide setup diagnosis\.$/, (name) => `${name} 未提供 setup 诊断。`)
    ?? replaceMatch(source, /^(.*) diagnosis failed safely\.$/, (name) => `${name} 诊断已安全失败。`)
    ?? replaceMatch(source, /^(.*) is registered in the running broker and can create sessions\.$/, (name) => `${name} 已在运行中的 broker 注册，并且可以创建会话。`)
    ?? replaceMatch(source, /^(.*) is registered in the running broker, but creation readiness was not reported\.$/, (name) => `${name} 已在运行中的 broker 注册，但未报告创建会话的就绪状态。`)
    ?? replaceMatch(source, /^(.*) is installed and registered, but the durable service PATH is stale\.$/, (name) => `${name} 已安装并注册，但持久服务 PATH 已过期。`)
    ?? replaceMatch(source, /^(.*) has a current durable service PATH, but its runtime or shared server is unavailable\.$/, (name) => `${name} 的持久服务 PATH 正确，但其运行时或共享服务器不可用。`)
    ?? replaceMatch(source, /^(.*) is installed in this shell and registered, but the running broker cannot create sessions\.$/, (name) => `${name} 已在当前 shell 安装并注册，但运行中的 broker 无法创建会话。`)
    ?? replaceMatch(source, /^(.*) is registered, but its executable is not installed or not visible to the running broker\.$/, (name) => `${name} 已注册，但其可执行文件未安装或对运行中的 broker 不可见。`)
    ?? replaceMatch(source, /^Restart the broker-managed (.*) runtime or shared server; inspect `cosyncing logs` if it remains unavailable\.$/, (name) => `重启由 broker 管理的 ${name} 运行时或共享服务器；若仍不可用，请检查 \`cosyncing logs\`。`);
  return dynamic;
}

function englishResultSummary(result: LifecycleCommandResult, _facts: UninstallRenderFacts): string {
  return result.summary || 'Command completed.';
}

const en: CliMessages = {
  doctor: {
    title: (product) => `${product} doctor`,
    sectionTitle: (section) => section.title,
    mark: { pass: 'ok', warn: 'warning', fail: 'error', skip: 'info' },
    checkSummary: (check) => check.summary,
    fixLabel: 'Fix:',
    remediation: (check) => check.remediation?.message ?? '',
    totals: (summary) => `Summary: ${summary.pass} passed, ${summary.warn} warnings, ${summary.fail} failed, ${summary.skip} skipped.`,
    internalFailureSummary: 'Doctor could not complete its read-only inspection.',
  },
  status: {
    headline: (report) => `${PRODUCT_IDENTITY.productName} ${report.version}: ${report.ok ? 'ready' : 'attention required'}`,
    installation: (report) => `Installation: ${report.installation.committed ? 'committed' : report.installation.detailCode}`,
    service: (report) => `Service: ${report.service.mode} / ${report.service.active} / ${report.service.enabled}`,
    internalEndpoint: (report) => `Internal endpoint: ${report.endpoints.internal}`,
    advertisedEndpoint: (report) => `Advertised endpoint: ${report.endpoints.advertised}`,
    tailscale: (report) => `Tailscale: ${report.network.topology} / ${report.network.backend} / ${report.network.route}${report.network.owned ? ' (owned)' : ''}`,
    agents: (report) => `Agents (registered): ${report.agents.length ? report.agents.map((agent) => {
      const readiness = agent.canCreateSession === true
        ? 'create ready'
        : agent.canCreateSession === false ? 'create unavailable' : 'create unknown';
      const sync = agent.syncEnabled === undefined ? '' : `; sync ${agent.syncEnabled ? 'enabled' : 'disabled'}`;
      return `${agent.displayName ?? agent.id} [${readiness}${sync}]`;
    }).join(', ') : 'broker unavailable'}${report.agents.some((agent) => agent.canCreateSession === false)
      ? `; run ${PRODUCT_IDENTITY.primaryBinary} doctor for creation setup guidance`
      : ''}`,
    sessions: (report) => `Sessions: ${report.sessions ? `${report.sessions.active} active / ${report.sessions.total} total` : 'broker unavailable'}`,
    updates: (report) => `Updates: ${report.updates ? `${report.updates.pending} pending` : 'broker unavailable'}`,
    fix: (detailCodes) => `Fix: ${detailCodes.join(', ')}; run ${PRODUCT_IDENTITY.primaryBinary} doctor.`,
  },
  uninstall: {
    planTitle: (count) => `Uninstall plan (${count} owned actions):`,
    noExternalResources: '  - no external resources',
    beforeConfirm: 'Before you confirm:',
    advisory: (item) => item.summary,
    purgeRoots: 'Purge roots:',
    confirmOwned: 'Remove only the listed owned integrations?',
    confirmLegacy: 'Remove only marker-matched repo-era Pi/Claude entries?',
    confirmPurge: 'Permanently delete both listed durable roots, including prompts, peers, keys, and artifacts?',
    resultSummary: englishResultSummary,
  },
};

export const ZH_STATUS_VALUES = Object.freeze({
  ready: '就绪',
  foreground: '前台',
  systemd: 'systemd',
  launchd: 'launchd',
  unconfigured: '未配置',
  active: '运行中',
  inactive: '未运行',
  failed: '失败',
  transitioning: '切换中',
  enabled: '已启用',
  disabled: '已禁用',
  unknown: '未知',
  unreachable: '无法访问',
  'identity-mismatch': '身份不匹配',
  missing: '缺失',
  running: '运行中',
  stopped: '已停止',
  'logged-out': '未登录',
  'daemon-unavailable': 'daemon 不可用',
  desired: '符合预期',
  conflict: '冲突',
  'funnel-conflict': 'Funnel 冲突',
  unavailable: '不可用',
  malformed: '格式错误',
  'native-linux': '原生 Linux',
  'native-macos': '原生 macOS',
  'inside-wsl': 'WSL 内部',
  'windows-host-only': '仅 Windows 主机',
} satisfies Readonly<Record<CliStatusValue, string>>);

export function localizeCliStatusValue(value: CliStatusValue, language: SetupLanguage): string {
  return language === 'zh-Hans' ? ZH_STATUS_VALUES[value] : value;
}

function zhUninstallAdvisory(item: UninstallPlan['advisories'][number]): string {
  switch (item.detailCode) {
    case 'codex-daemon-preserved':
      return 'Codex CLI 不可用，因此无法停止由 cosyncing 启动的 app-server daemon；该进程会继续运行，现有会话仍可通过 `codex resume` 恢复。';
    case 'codex-daemon-sessions-disconnect': {
      return 'daemon 停止时会断开已同步的 Codex 会话；这些会话仍可通过 `codex resume` 恢复。';
    }
    case 'codex-daemon-replaced-preserved':
      return '无法证明正在运行的 Codex app-server daemon 就是 cosyncing 启动的实例；该进程会继续运行。';
    case 'codex-daemon-preexisting-preserved':
      return 'Codex app-server daemon 不是由 cosyncing 启动的，因此会继续运行。';
    case 'codex-daemon-not-running':
      return '由 cosyncing 启动的 Codex app-server daemon 已不再运行，无需停止。';
    case 'tokdash-command-missing-preserved':
      return 'PATH 中已没有 tokdash 命令，因此无法自动移除由 cosyncing 安装的 Tokdash 实例。';
    case 'opencode-serve-disconnect':
      return '停止自有服务也会停止由 broker 管理的 `opencode serve`，并断开已同步的 OpenCode 终端会话；重新打开 `opencode` 即可恢复。';
    case 'acquisition-package-preserved':
      return `将移除 ${PRODUCT_IDENTITY.primaryBinary} 状态目录中的已安装副本，但保留其来源软件包；请另行移除该软件包（例如 \`npm uninstall -g ${PRODUCT_IDENTITY.productName}\`），否则 \`${PRODUCT_IDENTITY.primaryBinary}\` 仍会留在 PATH 中。`;
    case 'pi-bridge-sessions-disconnect':
      return '移除 Pi bridge 会断开所有实时桥接会话与应用的连接，但终端会话本身不会中断。';
    default:
      return `卸载提示（${item.detailCode}）。`;
  }
}

function zhUninstallResult(result: LifecycleCommandResult, facts: UninstallRenderFacts): string {
  switch (result.detailCode) {
    case 'uninstall-confirmation-required': return '显示归属计划后，需要确认才能卸载。';
    case 'purge-data-confirmation-required': return '清除两个持久目录需要单独确认。';
    case 'legacy-integration-confirmation-required': return '移除旧版标记项需要单独确认。';
    case 'installation-lock-unavailable': return '另一个安装变更正在进行，或安装锁不安全。';
    case 'uninstall-plan-changed': return '确认后卸载状态发生变化；请检查并确认新计划。';
    case 'purge-data-incomplete': return '自有集成已移除，但有一个持久目录无法安全清除。';
    case 'uninstall-complete': {
      return (facts.purgeData
        ? '自有集成和两个已确认的持久目录均已移除。'
        : '自有集成已移除；持久状态和制品缓存已保留。')
        + (facts.acquisitionPackagePreserved
          ? ` \`${PRODUCT_IDENTITY.primaryBinary}\` 命令仍由其来源软件包提供；请另行移除该软件包（例如 \`npm uninstall -g ${PRODUCT_IDENTITY.productName}\`）。`
          : '');
    }
    default:
      if (result.status === 'cleanup-required') return '已保留被修改、未知或发生漂移的资源，需要继续清理。';
      return `命令已结束（${result.detailCode}）。`;
  }
}

const zhHans: CliMessages = {
  doctor: {
    title: (product) => `${product} 诊断`,
    sectionTitle: (section) => DOCTOR_SECTION_ZH[section.id],
    mark: { pass: '正常', warn: '警告', fail: '错误', skip: '信息' },
    checkSummary: (check) => translateDoctorTextToChinese(check.summary)
      ?? `检查 ${check.id} 返回 ${check.detailCode}。`,
    fixLabel: '处理：',
    remediation: (check) => translateDoctorTextToChinese(check.remediation?.message ?? '')
      ?? '请根据此检查的错误码处理。',
    totals: (summary) => `汇总：${summary.pass} 项通过，${summary.warn} 项警告，${summary.fail} 项失败，${summary.skip} 项跳过。`,
    internalFailureSummary: 'Doctor 无法完成只读检查。',
  },
  status: {
    headline: (report) => `${PRODUCT_IDENTITY.productName} ${report.version}：${report.ok ? '就绪' : '需要处理'}`,
    installation: (report) => `安装：${report.installation.committed ? '已提交' : report.installation.detailCode}`,
    service: (report) => `服务：${localizeCliStatusValue(report.service.mode, 'zh-Hans')} / ${localizeCliStatusValue(report.service.active, 'zh-Hans')} / ${localizeCliStatusValue(report.service.enabled, 'zh-Hans')}`,
    internalEndpoint: (report) => `内部端点：${localizeCliStatusValue(report.endpoints.internal, 'zh-Hans')}`,
    advertisedEndpoint: (report) => `公开端点：${localizeCliStatusValue(report.endpoints.advertised, 'zh-Hans')}`,
    tailscale: (report) => `Tailscale：${localizeCliStatusValue(report.network.topology, 'zh-Hans')} / ${localizeCliStatusValue(report.network.backend, 'zh-Hans')} / ${localizeCliStatusValue(report.network.route, 'zh-Hans')}${report.network.owned ? '（自有）' : ''}`,
    agents: (report) => `已注册智能体：${report.agents.length ? report.agents.map((agent) => {
      const readiness = agent.canCreateSession === true
        ? '可创建会话'
        : agent.canCreateSession === false ? '无法创建会话' : '创建状态未知';
      const sync = agent.syncEnabled === undefined ? '' : `；同步${agent.syncEnabled ? '已启用' : '已禁用'}`;
      return `${agent.displayName ?? agent.id} [${readiness}${sync}]`;
    }).join(', ') : 'broker 不可用'}${report.agents.some((agent) => agent.canCreateSession === false)
      ? `；会话创建配置请运行 ${PRODUCT_IDENTITY.primaryBinary} doctor 检查`
      : ''}`,
    sessions: (report) => `会话：${report.sessions ? `${report.sessions.active} 个活跃 / 共 ${report.sessions.total} 个` : 'broker 不可用'}`,
    updates: (report) => `更新：${report.updates ? `${report.updates.pending} 个待处理` : 'broker 不可用'}`,
    fix: (detailCodes) => `处理：${detailCodes.join(', ')}；请运行 ${PRODUCT_IDENTITY.primaryBinary} doctor。`,
  },
  uninstall: {
    planTitle: (count) => `卸载计划（${count} 个自有操作）：`,
    noExternalResources: '  - 没有外部资源',
    beforeConfirm: '确认前请注意：',
    advisory: zhUninstallAdvisory,
    purgeRoots: '清除目录：',
    confirmOwned: '只移除以上列出的自有集成吗？',
    confirmLegacy: '只移除与标记匹配的旧版 Pi/Claude 项吗？',
    confirmPurge: '永久删除以上两个持久目录，包括提示词、对等设备、密钥和制品吗？',
    resultSummary: zhUninstallResult,
  },
};

const CATALOG: Readonly<Record<SetupLanguage, CliMessages>> = Object.freeze({
  en,
  'zh-Hans': zhHans,
});

export function cliMessages(language: SetupLanguage | undefined): CliMessages {
  return CATALOG[language ?? DEFAULT_SETUP_LANGUAGE];
}

export function renderUninstallPlan(plan: UninstallPlan, language: SetupLanguage = 'en'): string {
  const text = cliMessages(language).uninstall;
  let output = `${text.planTitle(plan.actions.length)}\n${plan.actions.map((action) => `  - ${action.id}: ${action.target}`).join('\n') || text.noExternalResources}\n`;
  if (plan.advisories.length) {
    output += `${text.beforeConfirm}\n${plan.advisories.map((item) => `  - ${text.advisory(item)}`).join('\n')}\n`;
  }
  if (plan.purgeInventory.length) {
    output += `${text.purgeRoots}\n${plan.purgeInventory.map((item) => `  - ${item.path}`).join('\n')}\n`;
  }
  return output;
}

export function renderUninstallResult(
  result: LifecycleCommandResult,
  facts: UninstallRenderFacts,
  language: SetupLanguage = 'en',
): string {
  return cliMessages(language).uninstall.resultSummary(result, facts);
}
