# Claude Code

cosyncing requires Claude Code 2.1.207 or newer. Anthropic's standard npm
installation is supported:

```bash
npm install --global @anthropic-ai/claude-code
```

Anthropic also provides a native installer for macOS, Linux, and WSL:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Run `claude doctor` to check the upstream installation type. Then reconcile the
broker service:

```bash
claude --version
claude doctor
cosyncing setup
cosyncing doctor
```

cosyncing reads Claude's local transcripts. Sessions begin in Observe mode and
can be switched to Take over; setup does not edit Claude Code's settings or
install legacy hooks.

Direct agent-to-user file delivery is not currently available from a local
Claude CLI/Drive session because that mode does not expose the native
`SendUserFile` tool. cosyncing can render a `SendUserFile` record when one is
already present in a Claude transcript, but the installed skill cannot create
one. Leave generated files in the workspace; do not use a shared
`.cosyncing/outbox` directory.

See Anthropic's [Claude Code setup guide](https://docs.anthropic.com/en/docs/claude-code/getting-started).
