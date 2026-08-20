# Changelog

This file records notable product and contributor-facing changes. Internal
implementation logs and physical evidence are maintained separately and are
not copied here.

The npm broker package and downloadable Flutter clients are separate release
channels. They can share a product version, but each channel retains its own
publication and acceptance controls. Artifact-specific notes and downloads are
available from [GitHub Releases](https://github.com/cosyncing/cosyncing/releases).

## Unreleased

### Added

- Kimi sessions support file and image attachments: images go inline as
  vision input, other files upload through the kimi server's own file API.
- Kimi sessions expose slash commands: `/goal` (set, status, pause, resume,
  clear) and the server's skills as prompt commands.
- Kimi sessions can be renamed; the rename lands in kimi's own session
  metadata.
- Kimi driving sessions show a copyable "Resume in terminal" command
  (`kimi -S <id>`), and observed Claude sessions now show the `claude --resume`
  command the adapter already published.
- DeepSeek Harness sessions can select a model at creation time, from the
  host's global model catalog.
- DeepSeek Harness foreground subagent and workflow tool runs show live
  activity bars, matching the existing codex and OpenCode display. Background
  spawns stay linked through the roster as before.
- Kimi `Agent` tool runs show live subagent activity bars: foreground spawns
  are bracketed by the call/result pair, and detached spawns settle through
  the task-completion path.
- Images attached to kimi prompts echo back as real image rows in history
  instead of a generic `kimi.image` event card.

### Changed

- Claude take-over no longer forks the session. Driving a terminal-owned
  Claude session now resumes it in place: a takeover against a terminal that is
  mid-turn is refused with an explanation, and if the terminal writes later,
  cosyncing stops driving and reverts to observe instead of forking — two
  writers on one transcript would silently split its history. The pre-drive
  fork warning is replaced by a terminal-attached notice, and the fork-specific
  confirmation dialog is retired.
- Every client now sees when a Claude session is being driven, not just the
  client that took it over: drive ownership is tracked by the adapter and
  published on the roster row.
- The `willFork` flag is gone from the session control contract. Nothing forks
  any more, so it had no state left to report; the terminal-attached warning
  travels in the drive `reason` text instead.
- A takeable-but-demoted session now reads "Observing" instead of
  "Unavailable", matching the takeover wording already used elsewhere.

### Fixed

- Kimi Drive no longer falsely reports "another program wrote to this session"
  when the server appends its own harness rows (injections, skill activations,
  scheduled jobs) or when a prompt echo's correlation id is lost.
- Kimi skill and plugin activations no longer render as a giant user message:
  the transcript shows the `/name args` action and the loaded body as a
  collapsible context block.
- Kimi todo lists render in the shared task panel instead of dumping the raw
  tool arguments, and background-task completions are attributed to the
  originating tool call as its result card (or surface as a plain notice when
  the call cannot be found) instead of appearing as messages the operator
  never sent.
- The model and permission mode chosen at kimi session creation are now
  reflected in the composer immediately, seeded at attach instead of waiting
  for the first status poll.
- Untitled kimi sessions show a readable `directory · id` fallback title
  instead of the raw session id, and the session list suppresses placeholder
  titles the same way the header already did.
- Kimi and DeepSeek Harness turns now show the "Ran for … · Finished at …"
  footer; kimi subagent activity frames can no longer close the main turn's
  summary or flip its run state.
- A prompt sent while a turn was running (steering) no longer drags itself and
  every later prompt to the bottom of the transcript: once the prompt's echo
  is known, its canonical position wins over the send-time anchor, and
  delivered position holders retire once their anchor leaves the loaded
  window.
- On Windows, switching a virtual desktop with Ctrl+Win+Arrow no longer latches
  the Ctrl modifier, so the next plain mouse-wheel scroll is not misread as
  Ctrl+scroll text zoom; the latched-key release also covers the composer's
  send chord and the attachment paste chord.
- The expanded task/plan list in session detail now renders its rows roughly
  three times larger — headline-scale titles, 40px status icons — instead of
  the collapsed list's dense presentation.

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
