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

cosyncing currently integrates with the stable OpenCode 1 `opencode serve`
surface. The OpenCode 2 beta installs as `opencode2` and is not a replacement
for the required `opencode` command.

Setup may route terminal `opencode` through cosyncing's managed shared server.
An independently started server remains unowned and is not stopped or replaced.

Verify the installation and runtime:

```bash
opencode --version
cosyncing setup
cosyncing doctor
```

See the [official OpenCode installation guide](https://opencode.ai/docs/).
