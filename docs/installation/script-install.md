# Installing with cosyncing's own installer

npm is the documented default and remains so; see [Install](../../README.md#install). This page
documents the alternative: cosyncing publishes its own installer beside every signed release, one for
Linux and macOS and one for Windows. Use it when you want the broker without Node.js and npm on the
host, or when you want the release's signature checked before anything is placed.

Both installers place the same two artifacts — the JavaScript application bundle and the web client
sidecar — into `$COSYNCING_HOME/bin`, bootstrap a pinned Bun if the host has none new enough, write an
ownership receipt, and stop. Neither one starts a service, changes `PATH`, or edits a shell startup
file. Installing the files and installing the service are separate steps on purpose: `setup` inspects
the machine, shows exactly what it will change, and applies the whole plan or none of it.

## The URL is per-release

`<base>` below is a release's own download base, which today means a per-release URL. There is no
`…/latest/install.sh` alias yet — publishing one is a decision that covers both installers and both
channels, and this page will name it when it exists. Until then, take `<base>` from the release you
mean to install.

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
powershell -ExecutionPolicy Bypass -c "irm <base>/install.ps1 | iex"
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

### About `-ExecutionPolicy Bypass`

The flag is in the command because that invocation is what makes the one-liner work on a host whose
execution policy would otherwise refuse it. Be clear about what it means: it disables Authenticode
enforcement for this invocation, so **script signing is not the integrity guarantee here and could not
be**. The guarantee is the release signature. `install.ps1` carries the release's ECDSA P-256 public
key, verifies the signed manifest and the signed checksum list against it through Windows CNG, and
then requires the manifest, the checksum list, and a digest baked into the script itself to agree
about each artifact by name. Any disagreement, and any signature failure, is fatal — there is no
degraded path on Windows.

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

`COSYNCING_HOME` relocates all of it and must be an absolute path. `BUN_INSTALL` relocates the Bun
prefix. `COSYNCING_BUN_BIN` names a Bun to use instead of searching. `COSYNCING_SKIP_BUN_INSTALL=1`
forbids installing a runtime, and the installer then refuses rather than placing a bundle the host
cannot execute.

Every directory the installer creates is created owner-only, with the same access-control policy the
product enforces and inspects, so `cosyncing doctor` reads them as safe rather than as drifted state.

### Then run setup

`PATH` is not changed, so the installer prints the absolute command to run next:

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

On Windows, that is the only update path today. `cosyncing upgrade` replaces the application the
installer placed, but the Scheduled Task runs its own versioned copy under
`%COSYNCING_HOME%\service\windows\versions\`, which only `setup` writes — so the post-switch health
check still sees the old version and the upgrade rolls itself back. Nothing is left broken when it
does: the previous application is restored and the running broker keeps serving. Installer plus
`setup` is the supported sequence until that is closed.

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
