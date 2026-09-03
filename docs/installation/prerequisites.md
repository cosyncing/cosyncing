# Installation prerequisites

cosyncing requires Bun to run the broker and npm to install and update the
package. Tokdash is an optional but strongly recommended quota integration.
No VPN, proxy, tunnel, or mesh product is required for local operation.

The broker listens only on `127.0.0.1`. Cross-device access is an independent
deployment choice; compare the [connectivity methods](../connectivity/README.md)
after completing the local installation.

## Required on the broker host: Bun

cosyncing requires Bun 1.3.8 or newer. The npm package contains JavaScript and
the web client; it does not embed the Bun runtime.

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

You can skip this step on Windows if you install cosyncing with
[its own installer](script-install.md): `install.ps1` installs a digest-pinned
Bun for you when the host has none new enough.

Open a new login shell, then verify the selected executable:

```bash
type -a bun
bun --version
```

## Required on the broker host: npm and Node.js

Install a current Node.js release, which includes npm. npm owns the acquisition
package and its updates; cosyncing itself still runs with Bun.

Common package-manager commands are:

```bash
# Apple Silicon or Intel macOS with Homebrew
brew install node

# Ubuntu or Debian; distribution versions may lag the current Node.js LTS
sudo apt update
sudo apt install -y nodejs npm
```

For a current LTS release, follow the
[official Node.js and npm installation guide](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm/).
Then install cosyncing:

```bash
npm install --global cosyncing
```

In a new shell, `type -a cosyncing` should show the npm-managed installation
you intend to run.

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
