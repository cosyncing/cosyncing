# Codex

cosyncing requires Codex 0.144.5 or newer. For the managed app-server and
terminal sync, install Codex with OpenAI's official standalone installer on
macOS or Linux:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

The installer can detect an existing npm-managed Codex and offer to remove it.
Open a new terminal after installation so the standalone command is on `PATH`.

The npm package can provide a `codex` executable, but it does not satisfy
cosyncing's standalone-package check. Without the standalone package, cosyncing
can inspect supported local data but reports the broker-managed daemon and
terminal sync as unavailable. A deliberately external app-server socket is the
only supported exception.

Verify the installation and reconcile the broker service:

```bash
codex --version
cosyncing setup
cosyncing doctor
```

Direct agent-to-user file delivery is not currently available in Codex. The
installed skill leaves generated files in the workspace because Codex has no
safe exact-session delivery tool. Do not use a shared `.cosyncing/outbox`
directory.

See the [official Codex CLI documentation](https://developers.openai.com/codex/cli/).
