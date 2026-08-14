<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)"
            srcset="apps/client/assets/brand/source/cosyncing-lockup-stacked-reverse.svg">
    <img src="apps/client/assets/brand/source/cosyncing-lockup-stacked.svg"
         alt="cosyncing" width="280">
  </picture>
</p>





<p align="center"><b>From CLI to GUI, live and in sync</b></p>

<p align="center">
  <a href="https://cosyncing.com/#sync">
    <picture>
      <source media="(prefers-color-scheme: dark)"
              srcset="https://cosyncing.com/assets/sync/sync-demo-dark.gif">
      <img src="https://cosyncing.com/assets/sync/sync-demo-light.gif"
           alt="cosyncing app and agent CLI staying in sync through takeover and a permission request" width="830">
    </picture>
  </a>
</p>



<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)"
            srcset="apps/client/assets/brand/marketing/social-banner-1280x640.png">
    <img src="apps/client/assets/brand/marketing/social-banner-white-1280x640.png"
         alt="Code anywhere. Sync everywhere. Your agents keep working. You keep moving."
         width="830">
  </picture>
</p>

<p align="center">
  <a href="https://cosyncing.com/">Website</a> ·
  <a href="#install">Install</a> ·
  <a href="#client">Client</a> ·
  <a href="docs/README.md">Docs</a> ·
  <a href="docs/CONTRIBUTING.md">Contributing</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

---

Synchronize and control your agents — from CLI to GUI, from desktop to phone. Pick up right where you left
off, anywhere. cosyncing keeps your coding agents in sync across your own network.

The broker runs on the machine where your agents work. It watches their sessions and serves
a client that shows each one — grouped by project, with its transcript, diffs, commands, and any
prompt waiting on you. Read a session, answer a prompt, or take over. No account to create, no
hosted service between the client and the broker.

## Supported agents

<p>
  <a href="https://www.claude.com/product/claude-code" title="Claude Code"><img src="docs/assets/agents/pills/claude.png" alt="Claude Code" height="34"></a>
  <a href="https://openai.com/codex/" title="Codex"><img src="docs/assets/agents/pills/codex.png" alt="Codex" height="34"></a>
  <a href="https://opencode.ai/" title="OpenCode"><img src="docs/assets/agents/pills/opencode.png" alt="OpenCode" height="34"></a>
  <a href="https://pi.dev/" title="Pi"><img src="docs/assets/agents/pills/pi.png" alt="Pi" height="34"></a>
</p>

One protocol covers all four. Per-agent control differs, and Claude Code sessions open read-only
until you take over. See [supported-agent setup](docs/supported_agents/README.md) for versions and
installation, and [adapter support](docs/protocol/adapter-support.md) for the capability matrix.

Foreground clients can join the same broker-owned Codex or Pi Drive session without starting a
second native Resume. Claude Code keeps its Observe/Take-over flow on another client, while OpenCode
keeps its shared-live behavior. Background Observe connections stay read-only.

## Prerequisites

Supported cross-device use requires [Tailscale](https://tailscale.com/) on the server and client
devices. The server requires [Bun](https://bun.sh) 1.3.8 or newer to run cosyncing and Node.js/npm
to install and update it.
[Tokdash](https://github.com/JingbiaoMei/tokdash) is optional but strongly recommended for quota
tracking and warnings.

See [installation prerequisites](docs/installation/prerequisites.md) for Linux and macOS commands,
WSL notes, and Tokdash setup.

## Install

The package contains one JavaScript application bundle and the web client. Supported broker hosts
are Linux x64, Linux arm64, and Apple Silicon macOS; on Windows, run the broker inside WSL.

Before setup, install only the agents you use; see [agent setup and PATH
preflight](docs/supported_agents/README.md#preflight).

Install the current release:

```bash
npm install --global cosyncing
```

Open a new login shell, then configure the service:

```bash
cosyncing setup

# After setup, use cosy as the shorthand for cosyncing
cosy restart
cosy doctor
cosy status
cosy pair
```

`setup` inspects the machine, shows exactly what it will change, and applies the whole plan or none
of it. It copies the broker to `~/.cosyncing/bin/cosyncing`, installs a user service that runs that
copy with your Bun, and prints your broker URL. The broker refuses to start until setup has
committed.

To update, let npm replace the global package, then re-run setup so cosyncing copies the new
application into its managed service and reconciles the installation:

```bash
npm update --global cosyncing
cosy setup
```

`cosy update` reports this package-manager-owned update path; it does not run npm or modify the
global package.

`cosy pair` prints a five-minute, one-use QR code. Scan it from a client to grant that device access;
`cosy devices list` lists paired devices, and `cosy devices revoke <id>` revokes one.

After setup, `cosy doctor` diagnoses the machine without changing it, and `cosy status` summarizes
install, service, agents, and sessions.

## Client

The packaged Flutter web app is served by your own broker at `/cosy/`; it does not fetch application
code from a third-party host at runtime. Setup prints the URL; open it in any browser that can reach
the broker. Android and desktop clients are available from
[GitHub Releases](https://github.com/cosyncing/cosyncing/releases/latest).
The iOS client will follow later through TestFlight.

<p align="center">
  <a href="https://cosyncing.com/demo/">
    <picture>
      <source media="(prefers-color-scheme: dark)"
              srcset="https://cosyncing.com/assets/shots/demo/real/dark/workspace.png">
      <img src="https://cosyncing.com/assets/shots/demo/real/light/workspace.png"
           alt="cosyncing landscape workspace with a session roster beside a live conversation" width="620">
    </picture>
    <picture>
      <source media="(prefers-color-scheme: dark)"
              srcset="https://cosyncing.com/assets/shots/demo/real/dark/sessions.png">
      <img src="https://cosyncing.com/assets/shots/demo/real/light/sessions.png"
           alt="cosyncing portrait client with sessions grouped by project and live status" width="180">
    </picture>
  </a>
</p>


**Server** — the broker runs on:

<p>
  <img alt="macOS on Apple Silicon" src="https://img.shields.io/badge/macOS-Apple%20Silicon-0F766E?logo=apple&logoColor=white">
  <img alt="Windows via WSL" src="https://img.shields.io/badge/WSL-supported%20Linux%20host-0F766E?logo=windows&logoColor=white">
  <img alt="Linux x64 and arm64" src="https://img.shields.io/badge/Linux-x64%20%C2%B7%20arm64-0F766E?logo=linux&logoColor=white">
</p>

**Clients** — the source tree and CI cover six platforms:

<p>
  <img alt="Android" src="https://img.shields.io/badge/Android-3DDC84?logo=android&logoColor=white">
  <img alt="iOS" src="https://img.shields.io/badge/iOS-0D96F6?logo=apple&logoColor=white">
  <img alt="Linux" src="https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=black">
  <img alt="macOS" src="https://img.shields.io/badge/macOS-6E6E73?logo=apple&logoColor=white">
  <img alt="Windows" src="https://img.shields.io/badge/Windows-0078D4">
  <img alt="Web" src="https://img.shields.io/badge/Web-E34F26?logo=html5&logoColor=white">
</p>

Native Windows and Intel macOS server hosting are not supported in this release. On Windows, run
the broker inside WSL, where it is a supported Linux host; install Tailscale inside WSL too, since
Windows-host Tailscale cannot proxy WSL loopback.

## Privacy and security

The broker runs on your machine, under your account. Broker state is stored there; session content
is sent only to authenticated clients over the network you choose. cosyncing operates no hosted
service in that connection path and includes no analytics or advertising telemetry. Optional
features contact only the services they name, such as Tailscale Serve and local Tokdash quota data.
The npm-installed broker does not silently replace itself: npm owns package updates, and `cosy setup`
reconciles the installed service after an update.

Report vulnerabilities through GitHub private vulnerability reporting, per [SECURITY.md](SECURITY.md).

## Repository layout

- `packages/typescript/` — broker, wire-contract owner, agent adapters, transport, and crypto.
- `packages/dart/` — client contract, transport, Flutter adapter, and crypto.
- `apps/client/` — the Flutter application, including every platform runner, test suite,
  integration driver, and developer tool.
- `contracts/generated/` — broker-owned, flattened client contract snapshot.
- `apps/poc-ui/` — non-production proof-of-concept UI retained for deterministic broker tests.

## Development

The repository pins Flutter 3.44.3 in `.fvmrc` and Bun 1.3.8 in `package.json`. Run commands from
the repository root.

```bash
bun install --frozen-lockfile
bun run client:pub-get
bun run typecheck
bun run client:analyze
bun run client:test
```

Regenerate broker-owned client contracts with `bun run contract:generate`. CI runs
`bun run contract:check` and fails on a stale snapshot.

Start with [docs/README.md](docs/README.md) and [build and test](docs/development/build-test.md).
Read [CONTRIBUTING.md](docs/CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](docs/CODE_OF_CONDUCT.md) before opening
a change; contributions use fork-and-pull-request and require a signed-off commit. Usage questions
go to GitHub Discussions and reproducible defects to GitHub Issues — see [SUPPORT.md](docs/SUPPORT.md).
Installs from a predecessor client start fresh; see
[local data and upgrades](docs/development/data-and-upgrades.md).

## License

First-party source is licensed under the Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
