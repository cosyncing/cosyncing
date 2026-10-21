# Installation prerequisites

cosyncing requires Bun to run the JavaScript broker; the installer acquires it when needed. Tokdash is an optional but strongly recommended quota integration.
No VPN, proxy, tunnel, or mesh product is required for local operation.

The broker listens only on `127.0.0.1`. Cross-device access is an independent
deployment choice; compare the [connectivity methods](../connectivity/README.md)
after completing the local installation.

## Required on the broker host: Bun

cosyncing requires Bun 1.4.3 or newer. The broker contains JavaScript and does not
embed the Bun runtime.

The official installer works on Linux and macOS:

```bash
curl -fsSL https://bun.com/install | bash
```

On Windows x64, install Bun with PowerShell:

```powershell
powershell -c "irm bun.com/install.ps1 | iex"
```

Windows ARM64 is not a qualified broker host yet, and the broker refuses it —
including an x64 process running under ARM64 emulation, which reports itself as
x64, so the broker asks Windows what the underlying machine is.

You can skip preinstalling Bun when using the signed-release
[cosyncing installers](script-install.md). Both shell and PowerShell templates
reuse a suitable Bun or download a digest-pinned runtime directly from upstream
into `$COSYNCING_HOME/runtime/bun-<version>`. Bun is installed separately; its
runtime is not a cosyncing release asset. When a later release needs a newer
Bun, `cosy update` on such an installation installs it the same way; see
[the Bun runtime](script-install.md#the-bun-runtime).

Open a new login shell, then verify the selected executable:

```bash
type -a bun
bun --version
```

## Optional: Tokdash quota tracking

[Tokdash](https://github.com/JingbiaoMei/tokdash) provides local token and quota
data. It is strongly recommended for quota tracking and warnings, but it is not
required for the broker, sessions, pairing, or Drive.

When you enable Tokdash during `cosyncing setup`, setup behaves as follows:

1. Reuse a healthy Tokdash already running at the configured local endpoint.
2. If the `tokdash` command is installed, run its unattended setup and enable
   the quota providers you approved.
3. If Tokdash is absent but `pipx` is installed, run `pipx install tokdash`,
   then configure it. cosyncing records this ownership so uninstall removes
   only the Tokdash installation it created.
4. If neither Tokdash nor pipx is available, finish the broker installation
   without quota tracking and report how to enable it later.

To preinstall Tokdash yourself, first install pipx and open a new shell:

```bash
# macOS with Homebrew
brew install pipx
pipx ensurepath

# Ubuntu 23.04 or newer
sudo apt update
sudo apt install -y pipx
pipx ensurepath
```

Then install and verify Tokdash:

```bash
pipx install tokdash
tokdash --version
```

Tokdash and current pipx releases require Python 3.10 or newer. See the
[Tokdash repository](https://github.com/JingbiaoMei/tokdash) for its standalone
service and configuration options.

## Configure cosyncing

Install only the coding agents you use, following the
[supported-agent guides](../supported_agents/README.md), then open a new login
shell and run:

```bash
cosyncing setup

# After setup, use cosy as the shorthand for cosyncing
cosy restart
cosy doctor
cosy status
cosy pair
```

To pair across an operator-owned connectivity layer, pass its client-reachable
origin once: `cosy pair --broker-url https://cosy.example.com`.
