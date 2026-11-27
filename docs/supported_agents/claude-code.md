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
can be switched to Take over. On Claude Code 2.1.288 or newer, setup can also
offer [true sync](claude-true-sync.md): a Claude Code mod, installed by Claude's
own plugin commands, that lets cosyncing mirror a session you are running in
your terminal and answer its approvals from the app. That install is a separate,
declinable setup question. Claude's own commands record the install, in two
settings keys and in Claude's plugin records (`plugins/known_marketplaces.json`
and `plugins/installed_plugins.json`), and setup installs no legacy hook.

## Models, effort, and the context meter

The model picker offers Claude's `opus`, `sonnet`, `haiku`, and `fable`
aliases with the effort levels Claude Code 2.1.330 lists for them: low through
max, plus ultracode, with medium preselected. An older Claude Code, where an
alias still named a 4.x model, is shown the same list. When a session runs a
specific older model, cosyncing drops an effort that model does not accept:
Sonnet 4.6 and Opus 4.6 have no extra high or ultracode, and Haiku 4.5 has no
effort setting.

In Take over, on Claude Code 2.1.312 or newer, the composer's context meter
shows Claude Code's own count of the context after each turn, the figure
`/context` shows, and divides by the window Claude Code reports for the
session. That window follows a `[1m]` model name,
`CLAUDE_CODE_DISABLE_1M_CONTEXT`, and a configured compaction window. A
stopped turn keeps the previous reading until Claude Code counts again. In
Observe mode, in true sync, and on an older Claude Code, the meter uses this
order for the window instead:

1. A `[1m]` model name, a model Claude runs at 1M by default, or a reading
   already over 200k: 1M.
2. A model Claude Code lists at 200k: 200k.
3. A model Claude Code does not list: 1M when the transcript was written by
   Claude Code 2.1.323 or newer, which assumes 1M for such a model, and 200k
   before that.

A session cosyncing only reads cannot see `CLAUDE_CODE_DISABLE_1M_CONTEXT`, so
its meter can divide by 1M while Claude compacts at 200k.

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
