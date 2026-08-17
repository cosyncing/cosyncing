# Changelog

This file records notable product and contributor-facing changes. Internal
implementation logs and physical evidence are maintained separately and are
not copied here.

The npm broker package and downloadable Flutter clients are separate release
channels. They can share a product version, but each channel retains its own
publication and acceptance controls. Artifact-specific notes and downloads are
available from [GitHub Releases](https://github.com/cosyncing/cosyncing/releases).

## Unreleased

## 0.4.0 — 2026-08-18

### Added

- Kimi Code is supported as a provisional source integration: discovery and
  read-only observe for every session on the local `kimi web` server, plus
  Drive — prompts, approvals, model selection — for the sessions cosyncing
  created, explicit takeover for the ones it did not, and handing Drive back to
  the terminal when you are done with it.
- A provisional DeepSeek Harness source adapter connects to a `dsh web` host for
  session discovery, history, and shared foreground control, with model and
  reasoning-effort selection, permission presets, the host's own commands, and
  image attachments. General file attachments are not supported, because the
  host accepts image content only. Control is foreground and live: cosyncing
  holds no background subscription to a dsh session.
- Both are registered by default and served to any client able to decode them —
  neither needs a rollout flag. cosyncing does not install either host, but an
  installed service starts, supervises, and stops one it owns, so neither agent
  needs a terminal left open. A host you started yourself is never stopped,
  replaced, or reconfigured, and setup names every host it will manage before
  you agree to it.

### Changed

- Stopping the broker service now signals only the broker. Processes that merely
  shared its service group are left running, and the agent hosts cosyncing owns
  stop through an ownership-checked release instead.
- The broker declares which controls a session can grant instead of leaving the
  client to infer them (contract revision 15). A client offers terminal handoff
  only where the session actually supports it, a session whose attach mode the
  client cannot decode attaches read-only rather than arming Drive on a guess,
  and the broker enforces that read-only posture on the connection instead of
  trusting the client to honor it.

### Fixed

- Codex 0.147 completed user-message records now appear in transcripts without
  duplicating legacy user-message records.
- Kimi Drive no longer demotes a session when the server's own activity frame
  crosses the first healthy walk after a stream reconnect; activity observed
  since an unattributed row was held now accounts for it, and repeated reads
  inside one interval no longer count as repeated intervals of silence.

## 0.3.0 — 2026-08-14

### Changed

- Codex and Pi clients can join the broker's current Drive owner from another
  client without starting a second native Resume.
- Session ownership is tracked independently from each connection's mutation
  authority. Owner revisions reject stale joins and concurrent handoffs.
- Setup, repair, doctor, and uninstall now share one receipt-based Pi bridge
  ownership decision. A stale bridge updates automatically only when its
  receipt and current contents prove that cosyncing owns it; user edits and
  unsafe targets remain protected.
- The source tree is organized by broker domain, adapter package, and client
  capability, with provider-neutral adapter and session boundaries.

## 0.2.0 — 2026-08-12

### Added

- A unified Servers screen combines saved servers, direct connection, pairing,
  health, and recovery actions.
- File artifacts are isolated by server and native session and provide a
  bounded, authenticated download action.

### Changed

- Session tabs retain recent pages for faster switching. Roster status,
  activity time, transcript messages, and Observe/Drive controls are clearer.

### Fixed

- Refused Codex takeovers remain read-only and explain why control was denied.
- Accepted Codex renames propagate across the roster, header, tabs, refresh,
  and restart.
- Windows speech ownership and responsive-layout transitions no longer trigger
  the native crash found during initial client acceptance.
- OpenCode startup, Pi chronology and runtime readiness, large Codex sessions,
  and broker setup and recovery received reliability corrections.

## 0.1.0 — 2026-08-10

### Added

- Initial public self-hosted broker and packaged web client, distributed as a
  JavaScript npm package that runs with Bun.
- Session discovery, transcripts, prompts, and agent-specific Observe/Drive
  control for Codex, Claude Code, OpenCode, and Pi.
- Device pairing and private-network access for browser and installed clients.
- Initial Android, Linux, Apple Silicon macOS, and Windows Flutter client
  downloads.
