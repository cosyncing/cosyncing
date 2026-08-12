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
cosy doctor
```

## Session control boundaries

Codex permits one active writer for a thread. Codex Desktop uses its own
private app-server connection rather than cosyncing's shared daemon. If
Desktop retains the active writer, **Take over** is refused and the session
stays read-only in cosyncing. Conversely, Desktop cannot drive the same thread
while cosyncing owns it. Use **Detach** or close the current writer before
transferring control.

This is not a blanket restriction on sessions created in Codex Desktop. An
idle Desktop session that no longer has an active writer can be resumed by
cosyncing. The native resume result, not the session title, origin, size, or
contents, decides whether control can transfer.

Live two-way terminal sync is available for Codex CLI sessions joined to the
managed daemon with the **Sync with a terminal** command shown by cosyncing
(`codex resume --remote ...`). A plain Codex Desktop session and a plain
`codex resume` process do not share that synchronized owner.

Direct agent-to-user file delivery is not currently available in Codex. The
installed skill leaves generated files in the workspace because Codex has no
safe exact-session delivery tool. Do not use a shared `.cosyncing/outbox`
directory.

See the [official Codex CLI documentation](https://developers.openai.com/codex/cli/).
