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

- The client now offers Japanese, Korean, and Spanish UI locales, with matching
  localized READMEs and social banners. Typed connection, session, and schedule
  errors render in the active locale and update after a language change.
- Gated native-Windows broker foundations now cover command invocation,
  owner-only state, process ownership, Task Scheduler service management, and
  native qualification harnesses. Windows broker hosting remains disabled
  until the remaining adapter, CI, packaging, and enablement gates pass.
- Pairing offers accept an optional, one-time client-reachable broker URL and
  emit provider-neutral version 3 payloads while clients retain legacy QR support.
- Connectivity guides and copyable operator-owned proxy and tunnel examples are
  available under `docs/connectivity/` and `examples/connectivity/`.
- Setup and the READMEs now link directly to the connectivity guides and suggest
  a copyable agent-assisted handoff for Tailscale Serve, EasyTier, and other
  operator-owned routes. The Tailscale guide documents `--bg` reboot behavior.
- Keyboard shortcuts drive the session workspace. Native builds use Ctrl/Cmd
  chords and reset text size with Ctrl/Cmd+0. The web client uses bare keys
  where the browser owns the chord — 1 through 8 select an open session, 9
  jumps to the last, `[` and `]` cycle — and moves close and new session to
  Ctrl/Cmd+Alt+W and Ctrl/Cmd+Alt+N. A shortcuts help page renders from the
  same registry the bindings come from, and hides the chords a browser takes
  for itself.
- File paths in tool cards are clickable. A mention opens the session's Files
  tab on that file, at its line when the mention names one, and absolute and
  `~` paths resolve on the broker. Where the host's filesystem access is
  closed, mentions stay plain text and the Files surface says so once.
- Claude subagent sessions appear in the roster as observe-only child rows
  under the session that spawned them.
- Approval cards advertise only the decisions the agent accepts. Codex command
  requests can offer its persistent matching-command rule as a distinct third
  choice, while session-scoped harnesses retain “Allow for session.” Full
  command and reason text can be expanded and selected.
- Server owners can enable authenticated workspace browsing from Settings
  after confirming the remote file-access risk. The broker persists the gate
  and restarts; paired devices can inspect it but cannot change it.

### Changed

- New sessions open as soon as creation succeeds and the protected Drive attach
  starts. Slow agent bootstrap continues in Session Detail instead of holding
  the full-page creation spinner.

- Paired-device credentials now resolve to explicit principals with observe,
  drive, and file roles. Every broker route has an exhaustive, default-deny
  peer policy. Device administration, durable schedules, agent-only file
  surfacing, broker/runtime changes, restarts, and updates require the owner
  credential.
- Artifact references expire after ten minutes, require the active principal
  they were issued to, and can be refreshed through an authenticated ticket
  endpoint. Only passive images and plain text remain inline; HTML, SVG, XML,
  PDF, and other formats download as sandboxed octet-stream attachments.
- Contract revision 17 requires a revision 17 client because older clients do
  not attach credentials to artifact downloads. Revision 17 clients retain the
  revision 16 broker fallback for client-first rollout.
- Contract revision 18 adds the owner-controlled workspace-browsing setting.
  Revision 18 clients retain the revision 17 broker overlap.
- The revision-17 broker invalidates every revision-16 paired credential,
  cancels active legacy schedules whose creator cannot be proven, and drops
  ownerless legacy wake registrations. Re-pair devices and let clients recreate
  wake registrations after upgrade; review canceled schedules before recreating
  any required automation. Legacy terminal schedules cannot be run or quota-
  recovered in place; recreate reviewed work as an owner-authorized schedule.
- The first revision-17 startup advances broker-instance state to schema 2
  before migrating authorization stores. This one-way fence prevents a restored
  revision-16 broker from loading legacy credentials, schedules, or wake
  destinations after a failed migration; it is a fail-closed authorization
  boundary, not an automatic service rollback. Once crossed, recovery requires
  revision 17 or later.
- The broker now has a strict loopback-only listener and configuration schema 2;
  remote connectivity is no longer configured, diagnosed, repaired, or removed
  by cosyncing.
- Upgrades preserve legacy Tailscale Serve routes while relinquishing their old
  setup intent and install receipts.
- Client releases containing the version 3 pairing parser must be promoted
  before the npm broker release begins emitting version 3 offers.
- Machine-roster peers running contract revision 16 require an explicit
  broker-token or paired peer-token credential. `cosy doctor` warns about
  URL-only `COSYNCING_MACHINE_PEERS` entries before the peer upgrade.
- The revision-16 client declares revision 15 as its minimum broker contract,
  matching the single-revision compatibility overlap it actually implements.
- The session roster groups rows into three bands: needs input, working, and
  settled. Working rows hold a stable creation-anchored order instead of
  reordering on every activity tick, and the cached roster pane matches.
- A permission card offering only approve and reject labels the approve
  button "Allow"; "Allow once" appears only when a session-scoped option is
  also on screen.

### Fixed

- Claude child rows show their model before the session is opened. Web tabs
  with open sessions request browser close confirmation for Ctrl/Cmd+W and
  other accidental unloads.
- Codex model choices preserve profile boundaries, show the built-in provider
  as Default, load complete per-profile catalogs, and keep a created session's
  exact provider, model, and profile selected. Catalog snapshots also avoid
  redundant app-server launches during session creation. Silent provider-model
  fallback is rejected, and terminal sync commands include the owning profile.
- The Codex "Restart now" action verifies that the managed daemon actually
  changed generation and runs the installed version. If Codex acknowledges a
  restart without replacing the old daemon, the broker uses a verified
  stop/start cycle instead of reporting false success. A legacy directly
  launched daemon is identified separately and migrated only through the
  confirmed setup plan; restart failures keep the last valid Settings status
  visible and show the broker's reason.
- Model-scoped quota rows name their model, distinguishing Sparks and Fable
  weekly limits from the shared Codex and Claude windows.
- Pi `ask_user` prompts appear in both the native terminal and Cosyncing; the
  first answer closes the other surface, and the terminal remains usable when
  the broker is unavailable. New Pi sessions also expose the model's native
  thinking levels and apply the selected level during creation.
- Pi fork and clone now follow Pi's actual RPC contract and refuse a result
  unless it identifies a distinct child session. Windows npm launchers are
  classified through the shared invocation boundary and their installed
  package metadata instead of being mistaken for native executables.
- Managed OpenCode servers now record and re-prove the process that owns the
  listener behind command wrappers, and shutdown waits for the owned listener
  to release its port instead of leaving an orphaned server.
- Peer revocation is persisted before it reaches memory, invalidates unused
  WebSocket tickets, closes active peer sockets, and clears peer upload,
  push-registration, mailbox, and replay state before reporting success.
- Legacy terminal schedule history survives repeated schema-2 loads without
  becoming executable or invalidating new owner schedules. Trailing coalesced
  wakes revalidate their registration at the provider boundary after revocation.
- Artifact and referenced-diff downloads refresh an expired same-origin ticket
  once while preserving authentication and byte ceilings; cross-origin legacy
  references are never authenticated or refreshed.
- Push registrations are scoped to their owner or exact peer generation, peer
  IDs retain monotonic authentication generations across re-pairing, and
  malformed or empty stored role sets fail closed. Peer registrations require
  stable device IDs and enforce per-peer, global, and write-rate limits.
- Remote Tokdash reads use only the locally configured upstream and no longer
  accept a caller-selected loopback URL.
- Transport envelopes reject unknown recipients and enforce bounded field
  grammar, mailbox count, global and per-principal envelope counts, and byte
  budgets.
- App-triggered broker updates no longer accept caller-supplied manifest URLs;
  custom signed-channel testing remains a local operator CLI action.
- Setup now accepts the supported schema-1 broker configuration during an npm
  upgrade, leaving it unchanged until a later confirmed `cosy repair` performs
  the backed-up schema-2 migration. Malformed and unknown schemas still block.
- All HTTP and WebSocket clients are treated as remote, so neither a direct
  browser nor a proxy inherits same-machine privileges from loopback. Packaged
  installs can explicitly enable authenticated workspace browsing and
  transcript export through schema-2 `features` configuration.
- Session rosters and other data-bearing API reads now require a broker or
  paired-device credential; public health remains minimal.
- WebSocket URLs contain a short-lived, one-use authorization ticket instead
  of a broker or paired-device credential when connected to a current broker;
  the client retains a revision-gated fallback during the client-first rollout.
- A client connected to a revision-15 broker now re-probes authentication on
  reconnect, so it can cross a live revision-16 upgrade without an app restart.
- Stale revision-15 clients can still load the roster from a revision-16 broker,
  but cannot open sessions until updated because query credentials are retired.
- Before the revision-17 authorization fence is crossed, candidate startup
  leaves configuration schema 1 intact so a pre-migration failure can still
  restore the compatible broker safely.
- Artifact persistence uses a durable installation identity rather than a
  public URL. It retains and resolves legacy advertised-URL records without
  deleting the keys required by the earlier compatible rollback window.
- Version 3 pairing acceptance proves ownership of the identity key committed
  in the QR before the client stores the endpoint or credential.
- Public pairing acceptance now rejects oversized or malformed bodies, weak
  credentials, invalid key algorithms, unsafe device IDs, and endpoint-ID
  collisions without consuming the one-use offer.
- API method routing no longer lets unauthenticated `OPTIONS` requests execute
  roster handlers, and unexpected request failures return content-free responses.
- Artifact URL signing now rejects weak or unsafe secret state, explicit file
  delivery rejects symlinked workspace paths, and the web shell cannot be framed.
- Artifact caches relocated through a symlinked parent remain durable across
  broker restarts; proactive artifact surfacing intentionally rejects symlinked workspace paths.
- Codex approvals offer "approve for this session" and send the session-scoped
  decision on Codex 0.149. The option was gated on a decision list 0.149 never
  sends, so the test failed closed and every real request offered approve and
  reject alone.
- An approval card ignores an advertised option it cannot answer instead of
  rendering a button that does nothing, and a read-only card renders no answer
  buttons at all.
- Codex sessions on a model provider that exists only in a non-default profile
  can be driven: the provider configuration is injected on resume and start. A
  cold-restored session of that kind is no longer labeled openai.
- A Claude session with a recent unnotified background task keeps its roster
  row working. The fallback existed but was unreachable behind live-turn
  evidence, so those rows read idle.
- Closing a session tab from the wide layout, by button or Ctrl/Cmd+W, flushes
  the staged draft before the tab goes; the barrier now lives in the close
  itself, matching the compact path.

## 0.4.1 — 2026-08-21

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
- The expanded task/plan list in session detail is taller, its rows use the
  transcript's body type scale, and a finished list no longer archives itself
  three seconds after it appears: it stays until you archive it.
- A prompt sent to a driven Claude session while a turn is running now survives
  a page reload: the adapter publishes the pending row itself and clears its
  "queued" badge in place once the transcript delivers it. If Claude cannot be
  launched, the send fails instead of leaving the session stuck on Running.
- A reloaded page that can no longer prove it was driving a Claude session
  (cleared browser storage, an expired take-over lease, a different device)
  used to land on the read-only view — an "Observing" header and a vanished
  queued prompt — while the broker's own Claude drive kept running. The broker
  now offers that page its existing Claude drive to join, as it already does
  for Kimi and dsh, and the queued prompt comes back with it.
- Claude session rows show the model for every family the adapter knows,
  including Fable. Kimi rows show the server's own model names (for example
  `K2.7 Coding`, `K3-256k`) instead of a raw alias or a guessed version, and
  the client no longer turns a provider-qualified id into a display name.
- Images sent with a prompt render inside your own message bubble on Kimi and
  Claude sessions instead of as a downloadable artifact card.
- Two cosyncing clients can share one Kimi Drive session: the second client
  joins the existing driver instead of sitting on a read-only view.
- DeepSeek Harness: subagent sessions nest under their parent in the session
  list, a background subagent's completion report renders as a tool card rather
  than a message, and the model and permission mode chosen at creation reach
  the composer at attach instead of after the first prompt.
- A send on an idle session no longer shows a "queued" badge just because a
  subagent activity bar is still visible.

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
