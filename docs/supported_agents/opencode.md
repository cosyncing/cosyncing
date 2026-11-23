# OpenCode

cosyncing requires OpenCode 1.17.19 or newer and the `opencode` command. The
official install script is the simplest installation method:

```bash
curl -fsSL https://opencode.ai/install | bash
```

The stable npm package is also supported:

```bash
npm install --global opencode-ai
```

cosyncing supports OpenCode 1. OpenCode 2 replaces the `opencode` command
and is detected but not yet supported: OpenCode is shown as unavailable and
existing OpenCode 1 sessions stay read-only. The opencode.ai website, Homebrew
and Scoop now install OpenCode 2, and a Homebrew upgrade moves an existing
install to it. Use one of the commands above to stay on OpenCode 1.

OpenCode discontinued session sharing in 1.19.1. With OpenCode 1.19.1 or newer,
the `/share` and `/unshare` actions are not offered.

Setup may route terminal `opencode` through cosyncing's managed shared server.
An independently started server remains unowned and is not stopped or replaced.

Verify the installation and runtime:

```bash
opencode --version
cosyncing setup
cosy doctor
```

The [official OpenCode documentation](https://opencode.ai/docs/) now describes
OpenCode 2; its install commands do not apply until cosyncing supports it.
