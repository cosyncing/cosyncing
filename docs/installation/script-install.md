# Installing with cosyncing's own installer

npm is the documented default and remains so; see [Install](../../README.md#install). This page
documents the alternative: cosyncing publishes its own installers beside every signed release. Use them
when you want cosyncing without Node.js and npm on the host, or when you want the release's signature
checked before anything is placed.

Each release publishes four installers, rendered from two templates in one step:

| Installer | What it does |
| --- | --- |
| `install.sh`, `install.ps1` | everything: broker, desktop client, `setup`, and a pairing |
| `install-server.sh`, `install-server.ps1` | the broker's files only, then stop |

An `install-server.*` run places the JavaScript application bundle and the web client sidecar into
`$COSYNCING_HOME/bin`, bootstraps a pinned Bun if the host has none new enough, writes an ownership
receipt, and stops. It starts no service, changes no `PATH`, and edits no shell startup file. That is
the right installer for a headless box, for a configuration-managed host, and for anywhere you want the
files and the service to be two decisions.

## Publication status

The native-free signed release path is prepared in source. The live download
URLs below acquire it only after a new candidate is published and promoted;
merging this change does not change an existing 0.5.2 release or the live installer.

The release carries JavaScript and the web sidecar, plus matching Flutter desktop
clients. It carries no compiled native broker and no Bun runtime archive. You do
not need to preinstall Bun: both installers reuse a suitable runtime or download
the pinned runtime directly from upstream. The broker still runs under that
separate Bun installation.

## The one-liner

```bash
curl --proto '=https' --tlsv1.2 -fsSL \
  https://github.com/cosyncing/cosyncing/releases/latest/download/install.sh | sh
```

```powershell
powershell -NoProfile -c "irm https://github.com/cosyncing/cosyncing/releases/latest/download/install.ps1 | iex"
```

`releases/latest/download/<name>` uses GitHub's latest-release pointer. Broker
promotion sets that pointer to the accepted signed broker release; client
promotion preserves it with `--latest=false`. Installer-owned
brokers use the signed channel; npm installations use their package manager. Swap `install.sh` for `install-server.sh` (or `install.ps1` for
`install-server.ps1`) for the broker-only install. Where this page writes `<base>`, a specific release's
own download base works too, and is what to use when you mean a particular version.

## What the all-in-one does

After the broker's files are in place — the same work `install-server.*` does, verified the same way —
it continues:

1. **Places the desktop client.** Per-user, never elevated: `$COSYNCING_HOME/client` plus a
   `~/.local/share/applications` entry on Linux, `~/Applications/Cosyncing.app` on macOS, and
   `%LOCALAPPDATA%\cosyncing\client` on Windows. The client is verified against the signed checksum list
   and a digest baked into the installer, exactly as the broker's own artifacts are.
2. **Runs `setup`.** With input read from the terminal rather than from the `curl | sh` pipe, so the
   plan-and-confirm prompt still asks and you still answer it. It never passes `--yes` or
   `--accept-managed-runtime-ownership` for you. With no terminal attached — CI, a container, a remote
   command — it prints the `setup` command and stops.
3. **Hands the client a pairing.** It reads the listener URL from `status --json`, asks for an offer with
   `pair --json`, and writes it to `$COSYNCING_HOME/client-pairing.json`, owner-only. The client reads
   that file once on its next launch, imports it, and deletes it. The offer is one-use and expires in
   five minutes, so a file left behind by a client that never started is a dead offer.
4. **Launches the client.**

Two hosts get no client and are told so, and the install still succeeds as a server install: Linux
arm64, for which no client is built, and a Linux machine with neither `DISPLAY` nor `WAYLAND_DISPLAY`
set, where a GUI is a package nothing can start.

## Linux and macOS

```bash
curl --proto '=https' --tlsv1.2 -fsSL <base>/install.sh | sh
```

Supported hosts are Linux x64, Linux arm64, and Apple Silicon macOS. Intel macOS is refused by name.

The installer verifies the signed release manifest and checksum list before it downloads anything
else, then checks each artifact against a digest baked into the script itself. It verifies Ed25519
where the local `openssl` can, and ECDSA P-256 where it cannot — stock macOS ships LibreSSL, which
cannot load an Ed25519 key at all. A signature that *fails* is always fatal. Only a host whose
`openssl` can verify neither algorithm degrades to the embedded digests, and it says so in its output.

## Windows x64

```powershell
powershell -NoProfile -c "irm <base>/install.ps1 | iex"
```

Run it in an ordinary PowerShell window, as the user who will own the broker. An elevated install is
**refused**: the qualified service is a per-user Scheduled Task registered by its owner, and running
elevated makes Windows stamp `BUILTIN\Administrators` as the owner of every file created, which
cosyncing's own security inspection then reports as somebody else's state.

Use the command as written, `powershell -c "…"`, rather than pasting `irm … | iex` into a window you
are already working in. The script runs in the process it is given: pasted into your own session, a
refusal exits *that* window before you can read it, and a successful run leaves strict mode switched
on in it. Under `powershell -c` both effects are confined to a child process that then goes away.

Windows ARM64 is not a qualified broker host yet and is refused — including an x64 PowerShell running
under ARM64 emulation, which reports itself as x64, so the installer asks Windows what the underlying
machine is.

Requirements beyond a supported host: Windows PowerShell 5.1 or newer (what `powershell` invokes on
every Windows box) and `tar.exe`, which has shipped in `System32` since Windows 10 1803. Bun is
installed for you if the host has none new enough; see
[prerequisites](prerequisites.md#required-on-the-broker-host-bun) to install it yourself first.

### Why not `-ExecutionPolicy Bypass`

Execution policy governs script *files*; it does not gate a command passed to `-Command`, nor a string
run through `Invoke-Expression`, so the one-liner never needs `-ExecutionPolicy Bypass`. The flag only
invites trouble: `powershell -ExecutionPolicy Bypass -c "irm … | iex"` is the exact shape Microsoft
Defender's machine-learning model scores as a fileless download-and-run loader, and on a host that has
not yet built reputation for the download URL it is killed outright (`Trojan:Win32/Commando.A!ml`).
The command line is what gets flagged, never the file, so signing the script cannot help. Dropping the
flag and adding `-NoProfile` clears it, and matches what the Claude Code, bun, and Antigravity CLIs
publish. The strictest environments can skip the one-liner and install from npm instead.

Script signing is not the integrity guarantee here and could not be: the script arrives and runs as
text, not as a signed file. The guarantee is the release signature. `install.ps1` carries the
release's ECDSA P-256 public key, verifies the signed manifest and the signed checksum list against it
through Windows CNG, and then requires the manifest, the checksum list, and a digest baked into the
script itself to agree about each artifact by name. Any disagreement, and any signature failure, is
fatal — there is no degraded path on Windows.

The same reasoning applies to `curl | sh`. In both cases the script arrives over TLS, and what it does
after that is verified against a key it carried rather than one fetched alongside the thing being
verified.

### What it places

| Path | What it is |
| --- | --- |
| `%USERPROFILE%\.cosyncing\bin\cosyncing` | the JavaScript application bundle |
| `%USERPROFILE%\.cosyncing\bin\cosyncing-web-<version>` | the web client the broker serves |
| `%USERPROFILE%\.cosyncing\bin\cosy.cmd` | a shim for typing `cosy` by hand |
| `%USERPROFILE%\.cosyncing\bootstrap-receipt` | what was installed, and which runtime runs it |
| `%USERPROFILE%\.bun\bin\bun.exe` | only if the installer had to install Bun |
| `%LOCALAPPDATA%\cosyncing\client` | the desktop client, `install.ps1` only |
| `%USERPROFILE%\.cosyncing\client-pairing.json` | the one-use pairing the client reads once, `install.ps1` only |
| `%APPDATA%\Microsoft\Windows\Start Menu\Programs\cosyncing.lnk` | the Start Menu entry that opens the client, `install.ps1` only |

`COSYNCING_HOME` relocates all of it and must be an absolute path. `BUN_INSTALL` relocates the Bun
prefix. `COSYNCING_BUN_BIN` names a Bun to use instead of searching. `COSYNCING_SKIP_BUN_INSTALL=1`
forbids installing a runtime, and the installer then refuses rather than placing a bundle the host
cannot execute.

Every directory the installer creates is created owner-only, with the same access-control policy the
product enforces and inspects, so `cosyncing doctor` reads them as safe rather than as drifted state.

### Then run setup

`install.ps1` runs `setup` for you when it has a console to ask on. `install-server.ps1` never does, and
neither does an `install.ps1` whose input is redirected; `PATH` is not changed, so it prints the
absolute command to run next:

```powershell
& "$env:USERPROFILE\.bun\bin\bun.exe" "$env:USERPROFILE\.cosyncing\bin\cosyncing" setup
```

`setup` registers the per-user Scheduled Task, copies the application into its own versioned service
root, and prints the broker URL. After that, `cosy.cmd` is the shorthand:

```powershell
& "$env:USERPROFILE\.cosyncing\bin\cosy.cmd" doctor
& "$env:USERPROFILE\.cosyncing\bin\cosy.cmd" status
& "$env:USERPROFILE\.cosyncing\bin\cosy.cmd" pair
```

## Updating

Re-run the installer for the new release, then re-run `setup` so cosyncing copies the new application
into its managed service and reconciles the installation. An install placed this way is owned by
cosyncing rather than by a package manager, so npm's update path does not apply to it.

`cosyncing upgrade` is the other way, on Windows as everywhere else. It downloads the next signed
release, verifies it, switches the application and health-checks the result, restoring the previous
build if that check fails.

Windows takes one extra step inside that sequence, because the Scheduled Task does not run
`%COSYNCING_HOME%\bin\cosyncing` — it runs a versioned copy under
`%COSYNCING_HOME%\service\windows\versions\`. `upgrade` writes the new version root and points the
service at it before restarting, so the broker the health check talks to is the build the swap
installed. A candidate that fails the check is rolled back pointer and all, so the restored service is
the previous build; an interrupted upgrade is undone the same way on the next run.

That step did not exist in 0.5.1, so every upgrade from it rolls itself back and this page used to name
installer-plus-`setup` as the only Windows update path. Nothing is broken when it does — the previous
build is restored and the broker keeps serving — but from a 0.5.1 install, update once with the
installer and `upgrade` works from there.

## Verifying by hand

Every installer does this for you; these are the same files if you would rather check first.

```bash
curl --proto '=https' --tlsv1.2 -fsSLO <base>/release-manifest.json
curl --proto '=https' --tlsv1.2 -fsSLO <base>/release-manifest.json.sig
curl --proto '=https' --tlsv1.2 -fsSLO <base>/release-key.pem
openssl pkeyutl -verify -pubin -inkey release-key.pem -rawin \
  -in release-manifest.json -sigfile release-manifest.json.sig
```

Each release is signed by a key **pair** under one key id: Ed25519 for the manifest a running broker
verifies, and ECDSA P-256 beside it for installers whose crypto library cannot load an Ed25519 key.
The P-256 signature is published in two encodings of the same signature — raw `r||s` for .NET, and a
DER `SEQUENCE` for `openssl dgst -verify`. See
[broker release and signing](../release/broker-release-signing.md).

## Migrating older installer-owned brokers

Published 0.5.2's updater rejects a manifest with an empty native artifact list,
even when `jsApp` and the web metadata are valid. A native-free release therefore
cannot be installed by that build's self-updater. Earlier native installer builds
also require reinstallation to change distribution kind.

After the new release is published and accepted, rerun its version-specific
`install.sh` or `install.ps1`. For a broker-only host, use `install-server.sh` or
`install-server.ps1`, then run the printed `setup` command to reconcile the
installed service. Use a maintenance window for a running installation; keep the
existing state home and credentials, and let the installer/setup manage receipts.
Do not delete state or manually copy a bundle over the installed service.

This acquires the new parser. Subsequent `bootstrap-js` updates can consume the
native-free signed channel with the existing runtime and health-checked rollback.
The manifest still says schema 1, but older parsers do not accept its new empty-
native-list shape. This has no effect on the broker/client wire contract.

For npm-owned (`bun-js`) installations, keep using `npm update --global cosyncing`
followed by `cosyncing setup`; do not use self-update as a migration mechanism.
Rerunning the standalone installer is a change of ownership, for which its
existing interactive takeover confirmation remains required.
