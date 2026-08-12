# Supported agents

Install only the coding agents you intend to use. Each desired agent must be
installed on the server and visible in a new login shell before the
`cosyncing setup` run that should enable it. You do not need to install all four.
Setup checks the executable, version, and runtime, then installs only
cosyncing-owned integration files; it does not install the coding agent.

| Agent | Minimum version | Preferred installation for cosyncing | Integration |
| --- | ---: | --- | --- |
| [Codex](codex.md) | 0.144.5 | Official standalone installer | Managed app-server, Drive, and terminal sync |
| [OpenCode](opencode.md) | 1.17.19 | Official install script | Managed shared `serve` |
| [Pi](pi.md) | 0.78.1 | Official install script | Packaged in-session bridge |
| [Claude Code](claude-code.md) | 2.1.207 | Official npm or native installer | Observe and Take over |

These are cosyncing compatibility floors, not the latest upstream releases.
Direct agent-to-user file delivery currently works through OpenCode's native
tool and Pi's cosyncing bridge. Claude Code can render existing native
`SendUserFile` transcript records, but its local CLI/Drive mode does not expose
that tool for cosyncing to invoke. Codex has no direct delivery tool. Filesystem
delivery for Claude Code and Codex is deferred until it can be bound to the
exact broker and native session; the shared `.cosyncing/outbox` path is not
supported.

## Requirements

- Bun 1.3.8 or newer runs cosyncing itself.
- Every agent you want cosyncing to manage must meet the version in the table
  above.
- Pi's actual Node interpreter must satisfy the installed Pi package's
  `engines.node` requirement. If that metadata cannot be read, cosyncing
  requires Node 22.19.0 or newer.

Node is a Pi/npm-agent runtime requirement; it is not cosyncing's runtime.
cosyncing runs with Bun.

## The two PATH environments

There are two related but separate executable searches:

1. `cosyncing setup` detects agents using the current shell's `PATH`. The first
   matching executable wins.
2. Setup writes a separate, bounded `PATH` into the persistent systemd or
   launchd service. It includes the validated executable directories and a
   minimal system path; it does not copy the complete interactive `PATH`.

npm-installed launchers such as Pi commonly begin with
`#!/usr/bin/env node`. The first `node` on the launcher's `PATH` is therefore
Pi's actual runtime, regardless of the directory containing Pi's npm package.

After installing an agent, changing Node, or changing a version-manager setup,
start a new login shell before running setup. Do not leave an obsolete Node or
version-manager directory before the intended Node installation. Do not use
`COSYNCING_PI_BIN` merely to hide an incompatible Node runtime.

## Preflight

`type -a` works in bash and zsh and shows every candidate, in resolution order.
Check the shared runtime and only the agents you intend to use:

```bash
type -a bun cosyncing
bun --version
cosyncing --version

# Run only the relevant lines for your installed agents.
type -a codex
codex --version

type -a opencode
opencode --version

type -a node npm pi
node -p 'process.execPath + " " + process.version'
head -n 1 "$(command -v pi)"
pi --version

type -a claude
claude --version
```

## Apple Silicon macOS example

For a Homebrew-managed Node and Bun:

```bash
brew install node
brew install oven-sh/bun/bun
eval "$(/opt/homebrew/bin/brew shellenv)"
exec zsh -l
```

At the new prompt, install only the npm-managed tools you want:

```bash
npm install --global --ignore-scripts @earendil-works/pi-coding-agent
npm install --global @anthropic-ai/claude-code
npm install --global cosyncing
```

The official native installers linked from the individual agent pages are also
supported and are preferred where stated. In a typical Apple Silicon Homebrew
installation, commands resolve under `/opt/homebrew/bin`; the canonical Node
executable may resolve inside `/opt/homebrew/Cellar/node/...`, which is normal.

## Reconcile cosyncing

Only after the relevant preflight commands pass, run:

```bash
cosyncing setup
cosy restart
cosy doctor
cosy status
```

Setup installs `cosy` as the shorthand used for routine commands in this guide;
the full `cosyncing` command remains valid.

Doctor should report `service.agent-executable-path` and each relevant
`<agent>.broker-create-readiness` check as passing. If Pi is installed,
`pi.node-runtime` should pass too. A managed server such as OpenCode may need a
few seconds after restart before its readiness check passes.

## Migrating from an old Node installation

Global npm packages belong to the Node installation or npm prefix under which
they were installed. Removing an old Node directory can also remove access to
Pi, Claude Code, or cosyncing installed inside it.

Use this order:

1. Activate the new Node installation.
2. Reinstall every required npm CLI under that Node installation.
3. Verify all executable paths and versions with `type -a` and the preflight
   commands above.
4. Run `cosyncing setup`, `cosy restart`, and `cosy doctor`.
5. Open a new terminal and verify again.
6. Remove or archive the old Node tree only after no required command resolves
   through it.

This ordering prevents a common macOS failure: correcting `PATH` selects the
new Node but temporarily hides Claude Code, Pi, or cosyncing because it was
installed only under the old npm prefix.

Environment overrides are available for deliberate nonstandard installations:
`COSYNCING_CODEX_BIN`, `COSYNCING_PI_BIN`, and `COSYNCING_CLAUDE_BIN`. Each
value must resolve to the intended executable; do not use an override to bypass
a failed version or runtime check. OpenCode must be discoverable as `opencode`
on the setup shell's `PATH`.
