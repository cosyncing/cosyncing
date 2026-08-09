# Supported agents

Install each coding agent on the broker host before running `cosyncing setup`.
cosyncing detects the executable, checks its version and runtime, and installs
only cosyncing-owned integration files. It does not install the coding agent.

| Agent | Minimum version | Preferred installation for cosyncing | Integration |
| --- | ---: | --- | --- |
| [Codex](codex.md) | 0.144.5 | Official standalone installer | Managed app-server, Drive, and terminal sync |
| [OpenCode](opencode.md) | 1.17.19 | Official install script | Managed shared `serve` |
| [Pi](pi.md) | 0.78.1 | Official install script | Packaged in-session bridge |
| [Claude Code](claude-code.md) | 2.1.207 | Official npm or native installer | Observe and Take over |

These are cosyncing compatibility floors, not the latest upstream releases.
After installing or updating an agent, open a new shell and run:

```bash
cosyncing setup
cosyncing doctor
cosyncing status
```

`setup` reconciles the persistent broker service's restricted `PATH`. `doctor`
reports an old version, an incompatible runtime, a stale service path, or a
managed runtime that did not start.

Environment overrides are available for deliberate nonstandard installations:
`COSYNCING_CODEX_BIN`, `COSYNCING_PI_BIN`, and `COSYNCING_CLAUDE_BIN`. Each
value must resolve to the intended executable; do not use an override to bypass
a failed version or runtime check. OpenCode must be discoverable as `opencode`
on the setup shell's `PATH`.
