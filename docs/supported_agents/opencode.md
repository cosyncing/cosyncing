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
and is detected but not yet supported.

Setup may route terminal `opencode` through cosyncing's managed shared server.
An independently started server remains unowned and is not stopped or replaced.

Verify the installation and runtime:

```bash
opencode --version
cosyncing setup
cosy doctor
```

See the [official OpenCode installation guide](https://opencode.ai/docs/).
