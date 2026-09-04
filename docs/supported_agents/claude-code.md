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

If Claude Code is npm-managed, it belongs to the active Node/npm prefix.
Changing Node or removing an old version-manager directory can therefore hide
the `claude` command until it is reinstalled. Follow the shared [PATH,
preflight, and Node migration guide](README.md#the-two-path-environments).

Run `claude doctor` to check the upstream installation type. Then reconcile the
broker service:

```bash
type -a claude
claude --version
claude doctor
cosyncing setup
cosy restart
cosy doctor
```

cosyncing reads Claude's local transcripts. Sessions begin in Observe mode and
can be switched to Take over; setup does not edit Claude Code's settings or
install legacy hooks.

Direct agent-to-user file delivery is not currently available from a local
Claude CLI/Drive session because that mode does not expose the native
`SendUserFile` tool. cosyncing can render a `SendUserFile` record when one is
already present in a Claude transcript, but the installed skill cannot create
one.

Ask Claude to write the file into the workspace instead. A successful Write of a
deliverable inside the session's own directory is surfaced as a downloadable
file artifact on that session, bound to the write that produced it. Source
churn, a write outside the session directory, and a write that failed all
surface nothing. Do not use a shared `.cosyncing/outbox` directory.

See Anthropic's [Claude Code setup guide](https://docs.anthropic.com/en/docs/claude-code/getting-started).
