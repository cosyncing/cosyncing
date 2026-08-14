<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)"
            srcset="apps/client/assets/brand/source/cosyncing-lockup-stacked-reverse.svg">
    <img src="apps/client/assets/brand/source/cosyncing-lockup-stacked.svg"
         alt="cosyncing" width="280">
  </picture>
</p>

<p align="center">
  <b>代码随处。同步无界。</b><br>
  智能体照常运转，你持续前行。
</p>

<p align="center">
  <img alt="许可证：Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-0F766E">
  <img alt="Broker 宿主机：macOS、WSL、Linux" src="https://img.shields.io/badge/broker-macOS%20%C2%B7%20WSL%20%C2%B7%20Linux-0F766E">
  <img alt="客户端：Android、iOS、Linux、macOS、Windows、浏览器" src="https://img.shields.io/badge/clients-6%20platforms-0F766E">
</p>

<p align="center">
  <a href="https://cosyncing.com/zh/">官网</a> ·
  <a href="#安装">安装</a> ·
  <a href="#客户端">客户端</a> ·
  <a href="docs/README.md">文档</a> ·
  <a href="docs/CONTRIBUTING.md">参与贡献</a> ·
  <a href="README.md">English</a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)"
            srcset="apps/client/assets/brand/marketing/social-banner-zh-1280x640.png">
    <img src="apps/client/assets/brand/marketing/social-banner-light-zh-1280x640.png"
         alt="代码随处。同步无界。智能体照常运转，你持续前行。"
         width="830">
  </picture>
</p>

---


让智能体从 CLI 到 GUI、从桌面到手机保持同步。无论身在何处，都能从上次停下的地方继续。
cosyncing 让编码智能体通过你自己的网络保持同步。

Broker 运行在智能体所在的那台机器上，负责观察它们的会话，并提供一个客户端：会话按项目归组，
各自带着完整的对话记录、diff、命令，以及智能体正在等待你回应的提问。你可以阅读会话、回答提问，
或者直接接管。不需要注册账号，客户端与 Broker 之间也不经过我们运营的任何服务。

## 支持的智能体

<p>
  <a href="https://www.claude.com/product/claude-code" title="Claude Code"><img src="docs/assets/agents/pills/claude.png" alt="Claude Code" height="34"></a>
  <a href="https://openai.com/codex/" title="Codex"><img src="docs/assets/agents/pills/codex.png" alt="Codex" height="34"></a>
  <a href="https://opencode.ai/" title="OpenCode"><img src="docs/assets/agents/pills/opencode.png" alt="OpenCode" height="34"></a>
  <a href="https://pi.dev/" title="Pi"><img src="docs/assets/agents/pills/pi.png" alt="Pi" height="34"></a>
</p>

四者共用同一套协议；各家智能体开放的能力并不一致，应用会如实显示某个会话实际支持什么。
Claude Code 的会话在接管之前保持只读。版本与安装方法见
[支持的智能体](docs/supported_agents/README.md)，逐项能力见
[适配器支持](docs/protocol/adapter-support.md)（均为英文）。

前台客户端可以加入同一个由 Broker 托管的 Codex 或 Pi Drive 会话，而不会再次启动原生 Resume。
Claude Code 在另一客户端继续使用“观察/接管”流程，OpenCode 继续使用共享实时会话；后台观察连接始终只读。

## 前置要求

受支持的跨设备使用需要服务器与客户端设备安装 [Tailscale](https://tailscale.com/)，服务器还需要
[Bun](https://bun.sh) 1.3.8 或更高版本来运行 cosyncing，并需要 Node.js/npm 来安装和更新。
强烈建议安装
[Tokdash](https://github.com/JingbiaoMei/tokdash)，用于配额跟踪与预警。

Linux、macOS 命令、WSL 注意事项与 Tokdash 配置见
[安装前置要求](docs/installation/prerequisites.md)（英文）。

## 安装

该发行包包含一个 JavaScript 应用包和网页客户端。受支持的 Broker 主机为 Linux x64、Linux arm64
与 Apple Silicon macOS；Windows 上请在 WSL 内运行 Broker。

setup 前只安装你要使用的智能体；详见[智能体安装与 PATH
预检](docs/supported_agents/README.md#preflight)（英文）。

安装当前发行版：

```bash
npm install --global cosyncing
```

打开一个新的登录 shell，然后配置服务：

```bash
cosyncing setup

# setup 完成后，使用 cosy 作为 cosyncing 的简写
cosy restart
cosy doctor
cosy status
cosy pair
```

`setup` 会检查这台机器，展示将要做的全部变更，然后要么整体应用、要么完全不动。它把 Broker
复制到 `~/.cosyncing/bin/cosyncing`，安装用户服务（由你的 Bun 运行该副本），并打印你的 Broker
地址。在 setup 提交之前，Broker 拒绝启动。

更新时，先让 npm 更新全局包，再重新运行 setup；setup 会把新应用复制到托管服务并协调安装状态：

```bash
npm update --global cosyncing
cosy setup
```

`cosy update` 会报告这条由包管理器负责的更新路径；它不会代替用户运行 npm，也不会修改全局包。

`cosy pair` 打印一张五分钟内有效、一次性的配对二维码。用客户端扫码即可授权该设备；
`cosy devices list` 列出已配对设备，`cosy devices revoke <id>` 撤销指定设备。

setup 完成后，`cosy doctor` 只诊断、不改动机器；`cosy status` 汇总安装、服务、智能体与会话的状态。

## 客户端

发行包内的 Flutter 网页应用由你自己的 Broker 在 `/cosy/` 提供；运行时不会从第三方主机
拉取应用代码。setup 会打印访问地址；任何能连到 Broker 的浏览器都可以打开。Android 与桌面
客户端可从 [GitHub Releases](https://github.com/cosyncing/cosyncing/releases/latest) 下载。
iOS 客户端将在后续通过 TestFlight 发布。

<p align="center">
  <a href="https://cosyncing.com/demo/">
    <picture>
      <source media="(prefers-color-scheme: dark)"
              srcset="https://cosyncing.com/assets/shots/demo/real/dark/workspace.png">
      <img src="https://cosyncing.com/assets/shots/demo/real/light/workspace.png"
           alt="cosyncing 横屏工作区：会话列表与实时对话并排显示" width="620">
    </picture>
    <picture>
      <source media="(prefers-color-scheme: dark)"
              srcset="https://cosyncing.com/assets/shots/demo/real/dark/sessions.png">
      <img src="https://cosyncing.com/assets/shots/demo/real/light/sessions.png"
           alt="cosyncing 竖屏客户端：会话按项目归组并显示实时状态" width="180">
    </picture>
  </a>
</p>

<p align="center"><b>从 CLI 到 GUI，保持实时同步</b></p>

<p align="center">
  <a href="https://cosyncing.com/zh/#sync">
    <picture>
      <source media="(prefers-color-scheme: dark)"
              srcset="https://cosyncing.com/assets/sync/sync-demo-dark.gif">
      <img src="https://cosyncing.com/assets/sync/sync-demo-light.gif"
           alt="cosyncing 应用与智能体 CLI 在接管和权限请求期间保持实时同步" width="830">
    </picture>
  </a>
</p>

**Broker 宿主机**

<p>
  <img alt="Linux x64 与 arm64" src="https://img.shields.io/badge/Linux-x64%20%C2%B7%20arm64-0F766E?logo=linux&logoColor=white">
  <img alt="Apple 芯片 macOS" src="https://img.shields.io/badge/macOS-Apple%20Silicon-0F766E?logo=apple&logoColor=white">
</p>

**客户端** — 源码与 CI 覆盖六个平台：

<p>
  <img alt="Android" src="https://img.shields.io/badge/Android-3DDC84?logo=android&logoColor=white">
  <img alt="iOS" src="https://img.shields.io/badge/iOS-0D96F6?logo=apple&logoColor=white">
  <img alt="Linux" src="https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=black">
  <img alt="macOS" src="https://img.shields.io/badge/macOS-6E6E73?logo=apple&logoColor=white">
  <img alt="Windows" src="https://img.shields.io/badge/Windows-0078D4">
  <img alt="浏览器" src="https://img.shields.io/badge/Web-E34F26?logo=html5&logoColor=white">
</p>

本版本不支持原生 Windows 与 Intel 芯片 Mac 作为 Broker 宿主机。Windows 上请在 WSL 内运行
Broker——WSL 属于受支持的 Linux 宿主机；Tailscale 也要装在 WSL 内，因为 Windows 侧的
Tailscale 无法代理 WSL 的回环地址。

## 隐私与安全

Broker 由你运行，跑在你自己的机器和账号下。Broker 状态存储在那台机器上；会话内容只会通过
你选择的网络发送给已认证的客户端。cosyncing 不在连接路径中运营托管服务，也不含分析或广告
遥测。可选功能只会联系其明确说明的服务，例如 Tailscale Serve 与本机 Tokdash 配额数据。通过 npm
安装的 Broker 不会静默替换自身：npm 负责更新软件包，更新后由 `cosy setup` 协调托管服务。

安全漏洞请通过 GitHub 私密漏洞报告提交，流程见 [SECURITY.md](SECURITY.md)。

## 仓库结构

- `packages/typescript/` — Broker、线上契约的所有者、智能体适配器、传输与加密包。
- `packages/dart/` — 客户端契约、传输、Flutter 适配器与加密包。
- `apps/client/` — 完整的 Flutter 应用，含全部平台 runner、测试套件、集成驱动与开发工具。
- `contracts/generated/` — 由 Broker 拥有、扁平化的客户端契约快照。
- `apps/poc-ui/` — 非生产的概念验证 UI，保留用于确定性的 Broker 测试。

## 开发

仓库在 `.fvmrc` 固定 Flutter 3.44.3，在 `package.json` 固定 Bun 1.3.8。命令一律在仓库根
目录执行。

```bash
bun install --frozen-lockfile
bun run client:pub-get
bun run typecheck
bun run client:analyze
bun run client:test
```

用 `bun run contract:generate` 重新生成 Broker 拥有的客户端契约。CI 运行
`bun run contract:check`，快照过期即失败。

入口文档是 [docs/README.md](docs/README.md) 与
[build and test](docs/development/build-test.md)。提交改动前请阅读
[CONTRIBUTING.md](docs/CONTRIBUTING.md) 与 [CODE_OF_CONDUCT.md](docs/CODE_OF_CONDUCT.md)；贡献采用
fork + Pull Request 流程，每个提交需要 `git commit -s` 签署。使用问题走 GitHub
Discussions，可复现的缺陷走 GitHub Issues——见 [SUPPORT.md](docs/SUPPORT.md)。从前代客户端
迁移的安装会重新开始，见 [local data and upgrades](docs/development/data-and-upgrades.md)。
（贡献者文档目前均为英文。）

## 许可证

第一方源代码以 Apache License 2.0 授权。见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
