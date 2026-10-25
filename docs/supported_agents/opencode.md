# OpenCode

cosyncing supports OpenCode **1.17.19 or newer in the 1.x line** and
**2.1.4 or newer in the 2.x line**. Both use the `opencode` command.

For OpenCode 1, the official install script and the stable npm package are
supported:

```bash
curl -fsSL https://opencode.ai/install | bash
npm install --global opencode-ai
```

OpenCode 2 is published as the `@opencode/cli` npm package. The opencode.ai
website, Homebrew and Scoop now install OpenCode 2, and a Homebrew upgrade
moves an existing install to it. Keep your existing generation unless you
intend to upgrade.

OpenCode discontinued session sharing in 1.19.1. With OpenCode 1.19.1 or newer,
the `/share` and `/unshare` actions are not offered.

Verify the installation and runtime:

```bash
opencode --version
cosyncing setup
cosy doctor
```

## Shared sessions

With OpenCode 1, setup may route terminal `opencode` through cosyncing's
managed shared `serve`. An independently started server remains unowned and
is not stopped or replaced.

With OpenCode 2, first run `opencode` or `opencode service start` on the broker
host. cosyncing discovers that user's running service from its local
registration and uses its credentials. cosyncing does not start, stop,
restart, pair or migrate an OpenCode 2 service. A stopped service appears
unavailable until you start it.

Both generations support live prompts, stop, approvals, model and agent
selection, rename, fork, compact, undo/redo, files and confirmed transcript
export. OpenCode 2 uses its native command catalog; share and unshare are
not offered. Forms that require external input, conditions or patterns stay
visible and ask you to answer in the terminal.

For OpenCode 2, the terminal sync hint opens the same session with:

```bash
opencode <directory> -s <session-id>
```

On Linux and WSL, a matching terminal process lights the synced badge.
Standalone terminals and terminals naming another server do not. Switching
sessions inside a terminal can leave its launch arguments unchanged, so the
badge may under-report presence. Other platforms still support joining the
session through the command, without process-based presence detection.

## Service selection

`OPENCODE_URL` explicitly selects a service for either generation. An explicit
URL takes precedence over discovery; cosyncing does not fall back to another
service when it fails. For OpenCode 2, a local registration supplies credentials
only when its origin matches that URL. An authenticated explicit service has
no pasteable sync command, since the command cannot carry its credentials.
A password-less explicit service uses `opencode --server <url> <directory>
-s <session-id>`.

Automatic OpenCode 2 discovery accepts only a loopback registration. A wildcard
or non-loopback registration, stale process identity, missing credentials or
unsupported service version is explained by `cosy doctor`. Remote
password-protected services without matching local registration credentials
are not supported.

## Upgrading from OpenCode 1

`opencode upgrade --major` replaces the command with OpenCode 2. Running turns
on cosyncing's owned V1 server finish before it retires at idle. The broker
starts no replacement. Starting OpenCode 2 runs OpenCode's own importer;
sessions keep their native IDs. Sessions not yet imported remain read-only
while the import is running. After completion, the V2 roster is authoritative,
and doctor reports any V1 sessions the importer omitted.

OpenCode does not import later V1 writes after that one-time import. Older
imports can also omit non-git sessions. cosyncing does not repair or rerun
that migration.

There is a short terminal routing gap immediately after an upgrade: if the
old V1 server is still listening and V2 has never started, a bare `opencode`
may be routed to the removed `attach` command. The terminal reports an error.
Retry after the old server retires; an idle server is checked every 20 seconds,
and a running turn delays retirement until it finishes.

See the [official OpenCode installation guide](https://opencode.ai/docs/).
