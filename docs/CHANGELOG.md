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

- DeepSeek Harness hosts on the 0.2 contract can be signed in to.
  `cosyncing dsh connect` takes the one-time URL that `dsh web` printed for a
  host you started yourself, exchanges it, and keeps the session cookie the host
  issues; `dsh status` shows what is held, and `dsh disconnect` forgets it. The
  URL is accepted from a hidden prompt or stdin only, never as an argument, so a
  host credential cannot land in shell history or the process list. The cookie
  lives in an owner-only file scoped to that address and that host's profile, and
  outlives a broker restart, so signing in is a one-time act for a host you keep.
  A host cosyncing starts for itself signs itself in from its own launch output.
  `cosyncing doctor` reports the same enrollment the running broker sees, and
  names the fix for each state it finds instead of recommending a re-enrollment
  for an unrelated problem.
- The DeepSeek Harness adapter now speaks the 0.2 contract as well as 0.1:
  roster, session open and history, live output, creation and rename, prompts,
  interruptions, and reconnect. The contract is chosen by what the host answers,
  not by a version string, with recorded targets `0.1.0-rc.6` and `0.2.0-rc.2`.
  The support page distinguishes captured contracts and provider-backed adapter
  outcomes from outstanding browser and platform acceptance.

### Changed

- DSH reconnects remove abandoned partial assistant output even when the durable
  history cursor is unchanged. Continued questions become answerable again when
  a turn ends before its claimed reply is admitted; queued later replies and
  durable answers retain their protection against duplicate submission.
- Model pickers and slash-command catalogs refresh independently, so an optional
  command lookup cannot delay an available model picker or its retry schedule.
- DeepSeek Harness `0.2.0-rc.2` now consumes captured assistant streams and
  timed/continued questions, retains pending decisions through follow-only
  recovery, and resumes already attached sessions after re-enrollment. A fresh
  carrier resets exhausted transient follow retries while terminal session
  refusals remain withdrawn. Native preset catalog refreshes also resist late
  replies that would restore obsolete or removed choices, and a fresh
  authenticated handshake reloads presets after credential renewal.
  Prompts and commands waiting on catalog reads also stop across enrollment
  withdrawal, carrier replacement or connection close; a fresh user action
  remains available after recovery.
  Fresh prompt identities remain distinct across broker restarts, so a surviving
  native session cannot mistake a new queued or steering prompt for an old one.
  Authenticated service faults follow owned-host
  recovery instead of being misclassified as enrollment faults.
  Forwarded native agent errors retain their original failure details.
- Model and reasoning selections submitted with a native DSH rc.2 command now
  apply to the next prompt, matching the native client. Compaction retains the
  host's own summarization-model policy and does not forward the selected effort.
- Non-image DSH attachment refusals now identify cosyncing's adapter limitation;
  the rc.2 host has its own file upload surface.
- DSH current-model and workspace information now reaches cold and attached
  sessions. Native queue cancellation and archive changes converge without
  treating an inactive agent as a deleted durable session. Malformed roster
  responses cannot falsely prove removal or healthy service readiness. Image-only echoes,
  bounded durable image previews, and rc.2 tool-result content are preserved.
  The local `/steer` command sends text to a running rc.2 turn's next step. Native
  settings and plugin changes automatically refresh attached model, permission
  and command choices without reconnecting. Empty catalogs retract stale choices;
  a failed read preserves the last successful value for that surface.
  Cold discovery refreshes durable metadata beyond stale roster hints without
  activating an agent. Initial history waits for the authenticated event handshake,
  and native compaction removes shadowed messages while retaining its checkpoint. Provider-backed adapter turns supplement the scripted
  captures; visible browser, shared-client, and remaining platform acceptance
  are tracked separately.
- DSH tabs release live transport while offstage or hidden and explicitly
  reattach after a fresh foreground roster read, retaining their cached
  transcript and unsent draft. Foreground attachment fences a superseded queued
  background attach and waits for an in-progress transport close.
  Visible windows retain their subscriptions across input focus changes.
  Restored foreground pages also wait for the initial authoritative live-only
  attach instruction, avoiding a refused implicit join while the roster loads.
  The last foreground client's departure also releases the broker subscription
  after its reconnect grace, allowing pending decisions to return to the native
  host instead of retaining an invisible attention lease.
- Native DSH commands apply the selected permission preset before executing;
  a refused preset prevents the requested command. Managed startup keeps launch
  output flowing through enrollment while retaining fresh ownership proof.
- Enrollment takes effect without restarting the broker. `cosyncing dsh connect`
  and `cosyncing dsh disconnect` are read by a running broker the next time it
  needs the credential, so signing a host in connects it and disconnecting it
  withdraws the access rather than leaving a warm connection streaming on an
  authorization nobody holds any more. A replaced credential re-handshakes; a
  withdrawn one does not reconnect, even when its managed-launch token remains
  in memory. A refused enrollment waits for a usable replacement rather than
  silently exchanging that token.
- A DeepSeek Harness host that cosyncing cannot sign in to is left running.
  Missing, expired and refused credentials, an address the host will not answer,
  and an unreadable credential store are reported as their own diagnosis with
  the command that fixes them, instead of being read as a crashed host and
  answered by stopping a process that was working.
- `cosyncing dsh connect`, `dsh status` and `dsh disconnect` honour
  `COSYNCING_DSH_BASE_URL`. They previously targeted the default address even
  when the broker was configured for another one, which made them operate on the
  wrong host.
- Permission presets on a 0.2 host are read from the host's preset catalog.
  The per-session state carries only the preset in force, so the picker was
  empty and selecting the preset a session was already running was refused.
- A DeepSeek Harness session that a host stops following reports that instead of
  waiting out a timeout, and a stream the host keeps refusing is retried on a
  bounded backoff rather than reopened as fast as the process can spin.
- Reopening a DeepSeek Harness session keeps an approval or question that was
  still open on it, and an interaction no client is left to show is handed back
  to the host rather than answered on the user's behalf.
- Reading a DeepSeek Harness session's history twice returns the current
  transcript. A repeated read previously returned the snapshot taken when the
  session was first opened, so a compacted session kept showing its old
  conversation.
- A DeepSeek Harness host that has no workspace registered is no longer told it
  cannot create a session. A 0.2 host with an empty workspace registry creates
  sessions anyway, so the registry no longer answers the creation question;
  naming a directory the host has not registered is still refused.

- An Android update keeps downloading after you leave the app, with its
  progress in a notification. If it finishes while you are away, a
  notification says it is ready, and Android's installer opens when you come
  back to Cosyncing.

### Fixed

- A DeepSeek Harness host started by cosyncing is now reachable. The managed
  start read the child's output once, before waiting for the host to come up, so
  a 0.2 host that printed its sign-in URL a moment later was never signed in to,
  and a healthy host was reported as having failed to start in time.

- Progress bars drew full from the start, so the Android update download,
  the context bar in a session's details and the artifact preview's loading
  bar never showed how far they had got. The bar now fills over a visible
  track.
- Picking another server from the switcher at the bottom of the sidebar did
  nothing: the menu closed and the client stayed on the server it was on. It
  now switches, and says so when a server can no longer be selected.
- A Codex session whose model no longer matches its profile no longer offers a
  terminal-sync command that would silently relabel it. Rollouts record the
  provider but never the profile name, so when the recorded model stops
  resolving to a profile the command now selects the provider by name when the
  daemon can resolve it from `config.toml`; when the provider lives only inside
  the profile's own file the app explains why no terminal can join it instead
  of offering a command the daemon refuses. Driving the session from
  Cosyncing still works in both cases.

## 0.6.3 — 2026-10-01

### Changed

- Reading a notification on one device now marks it read on your other
  devices too; security alerts stay unread on each device until read there.
  Notifications also clear themselves 24 hours after they last changed, along
  with their system notifications, so the inbox holds about a day of history.
- Settings drop their remaining cards, outlines and tinted boxes for plain
  rows under bold section headings, in one reading-width column. Choices
  that were chips, segmented buttons or radio lists are now a single select
  beside their label, moving under it on phones.
- The server row at the bottom of the sidebar opens a switcher listing every
  saved server, with Add server and Manage servers, instead of jumping to
  Settings. Settings → Servers lists saved servers as quiet rows with their
  address; the created and last-used dates are gone.
- Agents & Quota shows runtimes as single rows with a text Restart action and
  sets quota providers two to a row on wide screens. Every five-hour window,
  whatever the provider calls it ("Session", "Rolling (5h)", "5-hour window"),
  reads "5-hour", and scoped windows read "Sparks 5-hour". Each window shows
  what remains and when it resets; the per-provider "Updated … ago" line is
  gone, and a bar stays neutral until the window runs low.
- Agents & Quota shows the reset credits Codex and Claude Code hold, under
  their windows: how many are available and when the soonest expires, in amber
  in its last two days. The broker now forwards Tokdash's reset-credit block
  (Codex credits, and Claude Code limit resets from Tokdash 2.6.3); an older
  broker or Tokdash simply shows none.
- Settings → Display is one page, from the broadest choice to the finest:
  Appearance (mode, theme, text size, density, language), Conversation
  (message text, spacing, reading width, tool display), Session visibility
  and the indicator legend. Appearance and Tool display no longer need a
  separate page.

### Fixed

- Back on Android no longer closes the app from Settings, Notifications or
  Connection. It returns to the page they were opened from, through Settings
  first when you are on one of its pages. On phones and other narrow windows
  these screens now fill the window with a Close button in place of the menu
  button.
- On Android 14 and later, dismissing the "Staying connected for notifications"
  notification brought it back every time Cosyncing returned to the front. It
  now stays dismissed while the background connection keeps running.
- Notifications that need a response, unread completions, and problems can now
  be dismissed from their row, and Clear all at the top of Notifications clears
  every notification at once, with Undo. Before, only Recent activity could be
  cleared, so stale requests and alerts piled up, and a long history made the
  page freeze because every notification was drawn at once. It now draws only
  the rows on screen.

## 0.6.2 — 2026-09-30

### Fixed

- A broker holding a long notification history no longer stops responding for
  up to half a minute about once a minute. While it was unresponsive, sessions
  showed Reconnecting or failed to load, and every client, request and live
  stream waited. The notification scheduler now skips notifications it has
  already delivered without copying its whole store, combines back-to-back
  runs, and lets other work run while it checks. On a store of about 1,700
  notifications, one check fell from about 14 seconds to about 0.1 seconds.
- Turning on notifications in a new browser no longer makes the broker spend
  about a minute recording, and writing gigabytes to disk for, every retained
  notification the browser would never show. A browser is only alerted to
  what happens after it registers, so the broker now keeps no delivery record
  for anything earlier. Native apps still receive an alert already under way
  when they register.

## 0.6.1 — 2026-09-30

### Changed

- Agents & Quota now shows only quota windows; token usage is in the Usage
  overview. The Usage overview's day view no longer shows a day streak, a peak
  day or a weekday chart, which a single day cannot fill. The report, its
  project leaderboard and share section, and the workspace overview drop their
  footnotes on project attribution, export file counts, day boundaries, the
  agent-time estimate and source counts; the agent-time rule stays on its
  tooltip. Muse Code and Devin CLI rows show their vendors' marks, and MiMo
  shows its two-line favicon instead of a squeezed wordmark.
- Pending work has one name per kind on both the overview and Notifications:
  "Waiting for you" (questions and approvals), "Unread completions", and
  "Problems" (failed runs and security or server alerts, formerly "Action
  required", which read like a second name for requests). The "Needs
  attention" grouping is gone: the overview opens on Waiting for you, and the
  Notifications heading names the selected filter and its count.
- On Android, a new app release is offered once in a dialog with Later, instead
  of a banner that stayed over every screen and could not be dismissed. Closing
  it, including with Back, keeps the update in Settings → General, whose entry
  still carries the update dot.

### Fixed

- On phones and other narrow screens, reopening the sidebar after opening a
  session from it now keeps the projects and subagent groups you had open,
  instead of collapsing every project again.
- A session that finishes more than once is listed once in Notifications and
  in the overview's Unread completions: its newest outcome replaces the earlier
  ones, as it already did in the system notification center.

## 0.6.0 — 2026-09-29

### Changed

- The Flutter workspace now keeps session tabs visible, including a single
  open session, and offers an overview plus Close all with Undo. Closing a tab
  leaves its session running. The sidebar stays beside Notifications and
  Settings too; phones and other narrow screens open the same sidebar as a
  drawer from the menu button instead of a bottom navigation bar.
- The sidebar roster starts with every project collapsed and marks a project
  that needs input or has finished work with a single dot. A project's path
  appears on hover; long-press or right-click opens its menu (new session,
  rename). Compact rows use original harness logos and preserve subagent
  hierarchy with independent parent status and descendant attention cues.
- Conversations use a compact context header and composer with directly
  accessible model, permissions, microphone, context usage, Send and Stop.
  Display settings independently persist conversation text size, spacing and
  reading width. Status indicators are static. Flat White Minimalist is the
  new default palette; the new Quiet Workspace palette and bundled Lato
  typography support light and dark appearances, and previously selected
  palettes remain available.
- Notifications show requests and unread completions above recent activity,
  with independent filters. Activity read/clear actions preserve pending
  requests, and clearing offers Undo before synchronizing its exact event
  snapshot. Opening a session continues to read its completion notifications.
- Settings retain category-to-detail navigation on phones and show a category
  rail on wide screens. Agents & Quota uses branded provider identities;
  Usage overview adds a day range, period-aware charts, ranking details,
  the complete sortable agent table on phones and period-scoped CSV export.
- Notifications are now configurable per type, in three families: Sessions
  (permission requests, questions, finished and failed turns, finished goals,
  failed scheduled messages), Security (security alerts, new devices), and
  Server (server problems, runtime updates, usage running low). On Android each
  type is its own notification channel in system settings; on other platforms
  Settings has a switch, a sound option, and an "event type only" option per
  type. Runtime updates and usage are off by default. The Server no longer
  raises "Session sync degraded", which fired on every ordinary session exit;
  ones left by an earlier version are resolved when the Server starts.
- A notification's title is its event type and its body is the truncated
  session title. A newer turn outcome replaces the session's previous
  notification instead of stacking.
- Each notification is now sent once. An unanswered permission request or
  question used to alert again after 15 minutes, 1 hour and 7 hours, then every
  6 hours for as long as it stayed open, and a pending runtime update or server
  problem every day, so a few forgotten requests could alert every few minutes
  between them. An open request stays in the inbox until it is answered, and a
  server problem that gets worse still alerts. This needs a Server from this
  release.
- Opening a session, or tapping its notification, marks its finished and failed
  turns read and clears their notifications. A permission request or question
  answered anywhere, including in the agent's terminal, clears its
  notification.
- Reading or dismissing a notification's event on one device now clears that
  notification on your other devices, and a Claude session continuing on its
  own after a background task no longer notifies "Turn finished". Both need a
  Server and clients from this release.
- In a browser, notifications now arrive with every Cosyncing tab closed. The
  web app registers with the Server that serves it, which sends each
  notification through the browser's push service, end-to-end encrypted to the
  browser and carrying only what the notification shows. It needs a Server from
  this release, and follows the same per-type choices; other paired Servers
  still notify only while a tab is open.
- A first-run card offers system notifications once a Server is paired, and
  turning them on asks for OS permission in the same tap. Settings shows the
  permission state with guidance when it is refused, sends a test notification,
  and reports what the operating system did with the last one. A permission
  request or question the system refused to show before notifications were
  allowed is shown once they are; finished turns stay in the inbox.
- On macOS and Windows, closing the window now keeps Cosyncing running so
  notifications still arrive: in the Dock on macOS (quit with Command-Q) and in
  the notification area on Windows (quit from its icon's menu). Starting
  Cosyncing again on Windows shows the copy already running instead of opening
  a second one. Settings → Notifications has a switch to quit on close instead.
- On Android, Settings → Notifications has a "Stay connected in the
  background" switch, off by default. While it and notifications are on,
  Cosyncing keeps running after you leave it or swipe it away, so notifications
  arrive without a push service. Android shows a silent notification while it
  runs, and it uses more battery.
- A fling now loads the earlier or unloaded messages it reaches, as a drag
  does, instead of stopping at the edge of what is loaded.
- While newer messages load below you, the loading row says "Loading newer
  messages…", in all five languages.
- Earlier and newer messages now load ahead of you according to how fast you
  scroll and how quickly the Server has been answering, from one to three
  screens before you reach them. They used to load after every short scroll,
  up to five pages ahead, and kept loading while you held still. Nothing more
  loads once you stop. A fling loads at most two pages beyond where you last
  scrolled yourself. After loading in one direction, turning around waits for
  half a screen before loading in the other. A page that timed out or could
  not be sent is asked for again after 0.5, 1, 2 and 4 seconds while you are
  still near it. A page the Server refuses, including for a resource limit,
  waits for you to retry it. In a Linux profile build, a fling through a long
  session asked for up to 20 pages at once and now asks for at most one.

### Fixed

- The macOS shell installers no longer stop with an `unbound variable` error
  after placing the broker in a UTF-8 locale, regardless of the selected
  language. The all-in-one installer can continue to install the desktop
  client and offer setup and pairing.
- Installing a second Server on Windows next to one already running in WSL stopped
  with "port 7734 is already owned", because Windows republishes the WSL broker's port
  on its own loopback and setup read that as a competing broker it must not displace.
  Setup now asks the operating system who owns the listener: proven to be the WSL relay,
  it is treated as a broker in another environment, so the Windows install is offered the
  next port and the WSL broker keeps running. A broker setup cannot place still has to be
  stopped explicitly.
- Switching themes in the Flutter client applies in one step, rather than
  through a fade that re-rendered every screen for each of its frames,
  including hidden session tabs. Settings → Usage overview appears at once,
  adds its lower sections over the next few frames, and no longer lays out its
  share previews again on every rebuild.
- Finished and failed turns of Cline, Grok, Reasonix and Kimi sessions sent
  from Cosyncing now notify. These integrations reported a turn only when it
  ended, which the Server never counts as a turn it saw run, so they never
  raised "Turn finished".
- A session named in Cosyncing, when it was created or renamed where the agent
  has no rename of its own, now notifies under that name instead of the
  agent's own title.
- A Kilo turn that called tools notified "Turn finished" after every tool-calling
  step while the agent kept working. Only the step that ends the turn notifies now.
- After a Server token was pasted on the connect screen or in Settings, notifications
  stayed silent until the page was reloaded or the app restarted: the notification feed
  kept using the Server entry from before the token, so every request it made was refused.
- A device asking a Server with a token the Server refused (a browser tab opened before
  the token was saved in another tab, or a device whose token was revoked) asked again
  every minute for as long as it ran, and the Server raised "Repeated broker
  authentication failures" every hour. It now asks again only when the app returns to
  the foreground, and a token saved in another tab is picked up then.
- Android release builds shipped without the notification icon, so every
  notification failed to post. The icon is now kept, and the Android build
  fails if it is missing.
- Quiet notification types on macOS now show a banner instead of arriving
  silently in Notification Center.
- Windows notifications now leave Action Center once they are read or
  answered, and a newer one replaces the previous one instead of stacking.
  Toasts left by an earlier client are cleared once on the first start.
  Windows toasts show the Cosyncing logo, clicking one brings the window to
  the front, and clicking one after Cosyncing has quit starts it and opens
  that event. Settings reports "Denied" when notifications are turned off for
  Cosyncing in Windows settings, instead of claiming they were shown.
- Browser notifications now work under the app's `/cosy/` address. Clicking one
  focuses the Cosyncing tab and opens its event, or opens Cosyncing on that
  event when no tab is open. Notifications clear when their event is read or
  answered. A tab restored in the background now gets system notifications
  instead of in-app banners nobody sees, and several open tabs no longer
  notify twice for one event. A page served without HTTPS says so instead of
  reporting "Denied".
- Notifications now work on a device whose system language is not one
  Cosyncing ships (English, Chinese, Japanese, Korean, or Spanish) when no
  language is chosen in Settings. The notification service failed to start
  there, so nothing was notified and the notification inbox stopped updating.
  It now uses the first shipped language in the system's list, or English, as
  the rest of the app already did.
- Every Codex goal now notifies when it finishes. Previously only the first
  goal in a session did, because Codex gives each goal in a thread the same
  key. A Codex turn that runs again after it finished also notifies again.
- Scrolling up through a long session no longer loses your place. The session
  view kept only the newest 100 transcript rows, so once the 101st new row
  arrived the row you were reading could leave memory and earlier history was
  replaced with a "reconnect to recover" marker. It now holds up to 500 rows
  and about 4 MiB of decoded content. When it must drop rows, it first drops
  whole pages far from where you are reading and leaves a "Load earlier" marker
  that restores exactly those rows. The row you are reading is kept. Rows no
  reload can return, such as approval cards the agent never saves, stay beside
  that marker and return to their place when the page reloads. Only when the
  window is full of them do they give way, and a notice then says that rows
  that were never saved were released and cannot be restored. An approval or
  question card still waiting for an answer does not give way to the budget: the
  window keeps the newest such cards, up to 16 and a quarter of its decoded
  budget (always at least the newest one), so you can still answer them. A card
  answered or withdrawn while this device was disconnected, which the Server no
  longer sends after the reconnect, shows "No longer waiting for an answer." with
  its controls off and no longer counts toward those 16, until the agent sends it
  again or its answer arrives. Rows that
  arrived live since the last history frame have no reload boundary until the
  broker names one (see the next entry). With an older broker, up to 400 of them
  are kept, and only beyond that do the oldest still need a reconnect. A single
  row with an extremely long body shows a flagged, readable prefix instead of
  crowding out the rest of the transcript.
- With a current broker, ordinary use no longer leaves gaps that need a
  reconnect: long live output while you read far back, repeated reconnects,
  and scrolling back and forth through a long session. The client asks the
  broker to name reload boundaries for rows it received live after 50 rows,
  about 1 MiB, or the end of a turn, so those rows can be dropped and reloaded
  like any other page (broker contract revision 28). It asks once per boundary,
  and when an answer names none for them (the agent has not saved them yet), it
  waits for as many rows again before asking. A live update to a row held
  further back, such as a tool call becoming its result or a plan being updated,
  changes that row where it is instead of adding a copy, and a saved row with no
  key, such as an error card, is shown once. A reconnect that cannot replay
  everything saved while the socket was down keeps the pages you have already
  read. The rows in between load as you scroll toward them from either side.
  Scrolling down toward dropped rows now loads them too, starting with the rows
  next to the ones you are reading. Jumping to the latest rows is still the
  explicit control. Rows that were never saved, such as approval cards or a
  prompt not yet written to history, keep their place through all of this,
  after the saved row they followed, including one shown right after an error
  card. An approval's answer stays below its request after a queued prompt is
  taken. A resync that replaces the transcript drops the approval cards it does
  not restate, and says so. The client uses this only where the broker offers it.
  Older brokers keep the previous behaviour. A Cline session driven through its
  Hub also keeps it once it has streamed a row its saved history keys
  differently: a reply from another client, text after a tool the model runs
  itself, or output after Drive was demoted. A refused history read no longer
  shows a "send failed" error or clears a retry notice. A position the broker
  no longer has, for example after the session was rewound, stops only the
  range it bounds, which says it cannot load and offers no Retry; every other
  range still loads.
- When the broker no longer has the position the transcript would reconnect
  from (the session was rewound or rewritten), the client attaches again at
  once instead of leaving the newest rows without reload boundaries until the
  next reconnect. It does this at most once per connection and at most once
  every two minutes.
- A boundary refresh the broker never answers no longer stops the client asking
  for boundaries for later live rows: after 30 seconds it asks again once more
  rows arrive or the turn ends, and still accepts the late answer if it comes.
- An error card or another saved row without a key is no longer shown twice
  after the broker resyncs the session while you are reading further back.
- Reattach and resync now send the same size of history frame as "Load
  earlier" asks for: at most 100 rows. A resync used to send 500. Attach and
  resync frames also carry at most 2 MiB of decoded content, measured on the
  frame each connection actually receives. "Load earlier" pages are bounded by
  row count only. When the broker cannot index a session's history, it still
  sends the newest rows, up to 4 MiB. A history frame now names the boundary
  after its newest row whenever the broker can page back from it (broker
  contract revision 28). The client can then drop rows from that frame and
  reload them later without a reconnect. Boundaries count only transcript rows.
  The state an agent restates at the end of every read (a queued prompt, an open
  approval, an unfinished run's summary, a token reading) stays out of them
  until a transcript row follows it, and is sent after the frame instead, so an
  idle session keeps its boundaries after a prompt. Rows dropped from a frame
  without the boundary need a reconnect to recover, as before: that includes
  frames from older brokers and the unindexed fallback. The same revision adds a
  `history-refresh` request, which the broker answers with the rows saved since
  the client's reconnect cursor and the boundaries after them, and forward
  paging through a `history-page` with `direction: "newer"`. A history frame
  advertises both with `newerHistory: true`. While a turn runs, every attach,
  reconnect, resync and refresh frame, and every forward page that reaches the
  newest rows, stops before the newest reply and the tool calls before it,
  which the agent may still rewrite, and sends those rows after the frame.
  OpenCode and Kilo reserve each tool's result position as soon as it starts,
  so parallel tools finishing out of order keep every history boundary valid,
  even after hundreds of later rows. Completed tool outputs stay within the
  frame's size limit. Unfinished result positions are hidden and reloaded after
  reconnect to recover completions missed while offline. A
  forward page that would come back empty without reaching the end is refused
  as a changed source, which the client retries after a pause. A run's
  summary counts by its identity, so an OpenCode or Kilo turn of several steps,
  which rewrites each step's summary when the turn ends, keeps every boundary
  named during it. Refreshes of an unchanged history share one read, and forward
  paging works while the agent is still writing the session. An OpenCode
  session saves many writes under one revision, so a history the broker read
  earlier could be missing rows it had since received live: a refresh then came
  back empty, and a boundary another client had been given was refused as gone.
  The broker now reads the session again in those cases. Older clients never
  send either request and are unaffected.
- A finished OpenCode or Kilo tool call no longer stays on screen as running
  after its page reloads: saved history now keeps the call beside its result,
  as the live view shows it.
- Pi, OMP and Cline (Hub) sessions no longer show streamed replies, reasoning or
  sent prompts twice after reconnecting, and refreshing their history is no
  longer refused: live rows now carry the same identity as the saved
  transcript.
- Commands, file edits, image views, MCP calls and web searches that Codex runs
  inside a code-mode step, and shell commands you run yourself in a Codex
  session, now stay in the session history after a reload or reconnect, shown
  as they appeared live, instead of disappearing once the live view is gone.
  After upgrading, a reopened code-mode Codex session reloads its history once.
- Watching a Kilo Code session no longer reloads its whole history on every
  read once a turn has written anything, and paging and refresh keep working
  for it. A Kilo Code session driven from the app is no longer switched to
  watch-only when a step finishes during a turn.
- Reconnecting to an Antigravity session no longer reloads its whole history
  after every new step. Finished background tasks now appear where they
  finished, and a prompt still waiting to be delivered shows as queued.
- Reasonix tool calls no longer disappear from a session's history after a
  reload; each call shows next to its result, as it did live.
- Codex reasoning now appears in session history and when you reconnect, in
  both older and newer Codex rollout formats. It is shown once per reasoning
  step, and no longer disappears or is flagged as never saved once the live view
  is gone. After upgrading, a reopened Codex session reloads its history once.
- A client that reopens a large cached transcript now reattaches with a fresh
  history frame rather than resuming onto rows whose boundaries it no longer
  holds. A cached transcript that was trimmed to fit the local cache no longer
  offers a "Load earlier" cursor that would have skipped the trimmed rows.
- Reading back through a long session no longer moves what you are reading.
  The message on screen stays where it is when earlier or newer messages load
  above or below it, when distant messages are unloaded to keep memory
  bounded, when a message above it grows (a tool result arriving, a tool
  opened), while a reply streams in at the end, and when the window is resized
  or the text size changes.
- Loading history no longer interrupts scrolling: a drag keeps following your
  finger and a fling keeps its speed while a page of messages arrives.
- Selecting text by dragging against the top of the transcript while earlier
  messages load now selects and copies every message in between. The
  selection could lose its start or leave messages out of the copy.
- Following a reply as it streams in no longer drops most frames. Every
  chunk rebuilt the reply from scratch and laid out all of its text again,
  and a thinking row you had opened while it streamed closed on the next
  chunk. The reply now keeps its row and only its growing end is laid out
  again. Formatted text and highlighted code are kept for messages that come
  back into view, within a fixed memory budget. In a Linux profile build,
  frames drawn within 16.7 ms rose from 15% to 99.6% while following a
  streaming reply, and from 81% to 99.3% while reading far back during one.
  In a web profile build without a GPU, the median frame while following a
  reply fell from 60 ms to 20 ms.
- Selecting text while a message with a link was being updated, for example
  while a reply streamed in, no longer fails with an error.

## 0.5.13 — 2026-09-23

### Fixed

- Codex daemon restart recognizes the native `--managed-daemon` launch marker
  while retaining support for older launch formats and all process-ownership
  checks.
- A Take over refusal now distinguishes an unverifiable Codex daemon owner from
  a confirmed competing writer, instead of showing the same Codex Desktop
  warning for both cases.
- `cosyncing doctor` reads a Codex control socket that the runtime publishes as
  a symlink, and proves the live listener by the socket it resolves to. A
  healthy daemon no longer reports an unsafe file type, while an alias that
  dangles or reaches a non-socket still fails.

## 0.5.12 — 2026-09-22

### Added

- Codex background command cards in driven and shared-runtime sessions show
  running work, available output tails, and exact exit results. Commands can
  finish after their turn ends; known results can be recovered after a client
  reconnects to the same runtime. Availability follows native capabilities,
  with no new Codex version minimum. See the [capability limits](protocol/adapter-support.md#codex-background-commands).

### Changed

- The interactive signed-release upgrade confirmation now selects Yes by
  default, so pressing Enter starts the download, verification, switch, and
  health check. Other destructive confirmations continue to default to No.
- Only the most recent background commands carry an output preview. Every
  running command still shows a card with its status and elapsed time; a session
  holding many long-lived jobs at once no longer sends a preview for each of
  them on every history load.
- Managed DeepSeek Harness 0.2 launches include `--no-open`, preventing browser
  tabs during automatic startup and retries. Automatic launch is disabled for
  0.1.x until a browser-suppression flag is verified; existing user-started 0.1
  hosts retain their integration. The new 0.2 transport and isolated contract
  capture tooling are foundations for the migration; session synchronization
  and Drive against 0.2 hosts remain unfinished.

### Fixed

- Codex sessions remain attachable when the native runtime exposes its control
  socket through a symlink. Background reconnects track the resolved runtime
  without weakening process-stop ownership checks.

- Codex command results remain available after reconnect until dismissed.
  Reconnecting also clears stale running command cards after the broker's
  bounded recovery ledger is evicted or restarted. This surface uses client
  contract revision 26; older clients retain their existing Codex functionality.

- A Claude subagent now keeps its Working badge while it is busy but quiet. A subagent's
  session writes nothing for the whole duration of a single long step -- a test suite, a
  build, a long thinking pass -- and the roster read that silence as Idle after two minutes,
  so a subagent reviewing a change set could look finished while it was still reading it,
  even though its parent session correctly showed Working because of that same subagent. It
  now stays Working while its own unfinished step is still open, bounded, so a subagent that
  stops reporting stops claiming to work on its own. The card for that subagent inside the
  parent session already allowed the long step; the roster row no longer disagrees with it.
- A finished background command card stops inventing a duration. A command that
  reported how long it took showed that figure and held it; a command that
  reported none showed a clock that started the moment the card was drawn and
  ran upwards for as long as the card stayed on screen. It now shows no duration
  at all rather than a made-up one, and a running command still counts.
- A background command is no longer marked finished by text that only looks like
  a completion. A pasted transcript line naming a running command could report
  it as successfully finished, because naming it was treated as evidence that it
  had ended. A completion now has to agree with the launch it reports on, and a
  truncated or partial one is ignored.
- Progress output that redraws one line renders as the line a terminal would
  show, instead of every frame it ever overwrote joined into one line long
  enough to fill the command's whole output preview on its own. A download bar,
  a compiler, and a test runner that repaints no longer push each other out of
  view.
- The web UI now shows a background command's result. It rendered a running
  command as a generic background agent and removed the card the moment the
  command stopped, so the exit code and the output tail -- the facts the card
  exists to deliver -- never appeared, and a failed job looked the same as one
  that never started. A finished command now stays until it is dismissed, and a
  card the server withdraws is removed on its own.
- A running subagent is no longer reported finished by a completion notice that
  appeared in another command's output. A background job whose own output quoted
  a completion notice -- a log tailer, or a search over past sessions -- ended an
  unrelated subagent's card. Only a notice the agent itself raised counts.
- A background command started from a driven session can now be withdrawn when
  it goes silent. Driven sessions record no launch time of their own, and the
  rule that retires a command with no remaining sign of life treated a missing
  launch time as no evidence at all, so such a card could sit at Running for the
  rest of the session however long ago the work stopped.
- Dismissing a running background command now also clears the badge that points
  at it from the Status, Files and Terminal views. The badge counted commands
  the band had already been told to hide, so it could not be cleared until the
  command itself ended.
- A background command that finished without writing any output now says so,
  instead of reporting that its progress remains live until the server reports
  completion -- beside the Done pill and measured duration of the completion it
  had already reported.
- A background command's output preview reads only the file the command itself
  writes, and only inside the directory the tool owns for it. A launch that
  pointed its output somewhere else -- including through a link, including at a
  file that had not been created yet -- no longer has that file's contents sent
  to everyone watching the session.

## 0.5.11 — 2026-09-21

### Added

- Two commands for operators and scripts ask the two questions that were being
  conflated. `cosy status --json --readiness` answers only "is this broker
  answering on its own loopback port", and waits a bounded time for the answer;
  `cosy pair --status <pairing-id> [--timeout <seconds>]` asks the broker what
  became of one pairing offer and creates nothing, reporting `accepted`,
  `pending`, `expired`, `not-found`, or `unverifiable`.
- Shell commands an agent runs in the background now appear as a live card in
  the session, alongside goals, plans and subagent activity. The card shows the
  command, how long it has been running and the latest lines of its output, and
  reports how it ended -- including a non-zero exit code, and including a
  failure the session never mentioned. Until now the transcript recorded the
  launch with an empty result and never updated it, so a job that ran for forty
  minutes looked the same as one that never started. The card stays after the
  agent goes idle, because the command does too, and it stays after it finishes
  until dismissed. A command that leaves no sign of life for long enough is
  withdrawn rather than left claiming to run, and a job that finishes after
  several shorter ones still delivers its result. Live completion bursts retain
  every result, and output previews retain the tail of long lines. Available
  for Claude Code in both observed and driven sessions. Broker contract revision
  25; older clients show the card without the output preview.
- The usage report keeps finished windows on disk for up to 24 hours, avoiding
  repeat scans after a restart. Stored reports are checked against the reporting
  runtime and baseline pricing identity before use, with a five-minute identity
  memo. Historical windows are refreshed upstream when rebuilt.
- The shareable usage image can now be shared from Android, alongside desktop
  and the web UI.

### Changed

- Usage rankings show the top five agents, models, and projects, on the usage
  overview, under Settings → Agents, and in the shareable image. Settings →
  Agents shows each agent's logo, matching the overview.
- By agent now lists every tool the machine reported. The table used to lead
  with the coding-agent classification and fold the rest behind an expander,
  which hid a reader's own agent whenever the upstream report did not count it
  as one.
- Cost figures no longer carry the "API list prices — not your bill" note. The
  qualification is explained in [Usage reports](usage-reports.md) rather than
  repeated on every surface.

### Fixed

- The one-line installer's pairing handoff no longer depends on one lucky
  sample. It used to probe the full `status --json` report, which also reads the
  session roster; on a broker in daily use that read opens a whole-roster sweep,
  so the readiness check added to the very load that made the broker look
  unready, and a single multi-second stall could skip the handoff of an install
  that had just succeeded. The client then sat on "Connect this device" while the
  terminal reported a finished install. Readiness is now its own roster-free
  command that waits, `pair` waits out a busy identity read instead of reporting
  the broker absent, an unanswered offer request is named rather than retried as
  though no offer had been created, and after launching the client the installer
  asks the broker whether that specific offer was accepted instead of guessing
  from an offer file the client deletes before it authenticates. It now says
  `the broker accepted peer <device>`, `not paired yet`, or `acceptance could not
  be confirmed`, and leaves the same bounded record in
  `$COSYNCING_HOME/logs/pairing-handoff.log` without the pairing payload. The
  first of those is the broker's own record and not a claim about the client,
  which saves its credential afterwards in its own process. A reply that could
  not be used, and an offer this machine had nowhere to write, are each recorded
  as that failure instead of as an offer created. An offer whose confirmation
  went silent is reported as unverified rather than as still waiting. An endpoint
  that answers as cosyncing without accepting this installation's credential is
  reported as a credential fault on that endpoint rather than as a foreign
  service, and without a claim about whose broker answered: a second installation
  behind a port relay says exactly the same thing, so the guidance points at the
  listener that owns the port instead of at `setup`.
- An expanded live-state card now shows its real state. The card in the session
  band reported "Running" with a running icon whatever the underlying work was
  doing, and its elapsed time kept climbing after the work had finished, so a
  failed subagent read as one still in progress.
- Usage-report caching retries failed identity reads, warms memory after verified
  disk hits, and preserves the original report timestamp. Scans whose runtime or
  pricing identity changes are not saved to disk. Incomplete or malformed stored
  reports are rebuilt, and historical corrections no longer remain hidden by an
  indefinitely cached window.

## 0.5.10 — 2026-09-19

### Fixed

- Installer pairing now keeps an exclusive, recoverable claim while a newly
  started broker becomes responsive. Native clients retry transient startup
  failures instead of losing the one-use offer and falling through to manual
  authentication.
- Settings → Agents no longer reports "Activity check unavailable" for a managed runtime
  that is up to date. The server measures session activity only before applying a pending
  change, so a current runtime has no activity to report.
- The per-runtime restart is now offered on any server-managed runtime when nothing is
  pending, as Force restart. A wedged Codex daemon — one whose terminal will not start, or
  whose new sessions fail — reports no pending change, which is exactly when the control
  used to disappear.

## 0.5.9 — 2026-09-18

### Added

- Native clients now check the signed stable release channel independently of
  broker connectivity and show their installed version under Settings →
  General. Android can install the verified APK in-app; Linux, macOS, and
  Windows open the matching download in the browser. Available updates add an
  attention dot to Settings and General. The web UI remains self-updating and
  does not show native-client controls.

### Changed

- Installation guidance now identifies Windows 11 x64 as the supported Windows host and warns
  Windows 10 users not to disable Microsoft Defender to force an installation it may classify as
  a Trojan.

### Fixed

- Linux desktop clients verify that the system keyring can persist credentials
  before consuming an installer's one-use pairing offer. WSLg startup retries
  briefly while Secret Service becomes ready and shows a recoverable setup
  error instead of falling through to an unexplained unauthenticated state.

- Codex sessions no longer remain Working after the daemon reports Idle when the matching completed
  turn is available only through paged history or the durable rollout.

## 0.5.8 — 2026-09-17

### Added

- The sideloaded Android client checks the stable GitHub release channel at
  startup. When a newer accepted APK exists, it can download the exact signed
  artifact and open Android's installer; Android still requires the user to
  approve the installation and, when needed, allow Cosyncing as an install
  source. Other client update paths are unchanged.

### Fixed

- Session roster rows again show compact model names for harnesses that report
  a model identity without a separate display label. Full technical model IDs
  remain confined to tooltips.
- Standalone installers accept applications replaced by a verified in-app
  upgrade, and future bootstrap JavaScript upgrades keep both ownership
  receipts synchronized across success, rollback, and recovery.

## 0.5.7 — 2026-09-17

### Fixed

- Linux and macOS shell installers register `cosyncing` and `cosy` in Bash/Zsh
  startup files, using the selected Bun runtime and printing an activation
  command for the current terminal. Existing startup content is preserved.
- Agent CLI readiness probes no longer block unrelated broker requests while
  native processes start. Version and write-authority checks remain enforced.
- Large Claude Observe histories yield while reading and mapping records, and
  recently opened histories reuse parsed records when the transcript grows.
- Returning to a session refreshes the roster without waiting for agent
  creation-readiness checks.
- Archived Codex sessions skip irrelevant filesystem presence lookups, and
  replayed resolved requests avoid copying the attention store for no-op updates.

## 0.5.6 — 2026-09-15

### Added

- Codex non-blocking questions (`request_user_input_async`, Codex 0.154+) now
  render as the shared question card while Codex keeps working. The session
  keeps its working/idle status instead of switching to Needs input; answering
  sends the reply as a follow-up user message Codex consumes at its next input
  boundary, and dismissing the card matches the terminal's unrecorded skip.
  Blocking questions (Plan mode `request_user_input`) are unchanged, including
  on older Codex versions. The broker/client contract gains an optional
  `blocking` flag on `question-request` (revision 24); older clients ignore it
  and render the same card.

### Changed

- The all-in-one shell and PowerShell installers ask for language before
  installation and carry the choice into setup without a second language
  prompt.
- Interactive setup offers another broker port when a different process
  occupies the configured port, suggesting the next available port and
  retaining the choice in configuration, service setup, and pairing URLs.

### Fixed

- Codex completion notices retain their opening event when the start response
  arrives before the start notification.
- Desktop installers complete automatic pairing when the local broker is ready
  but an agent-list or service-status check fails. Client handoff results now
  distinguish failed pairing from a saved credential.

## 0.5.4 — 2026-09-14

### Added

- Added provisional Cline support. Captured default-profile parent and subagent
  sessions remain read-only snapshots. Cline 3.0.61 or newer can also run
  app-created sessions through an isolated broker-owned Hub with Create/Resume,
  queued prompt reconciliation, Stop, per-tool approvals, create-time
  model/mode, shared cross-client Drive, live output/usage, and native rename.
  A replacement Hub epoch revokes Drive because native same-id reactivation
  retains unsafe stale pid/status metadata.

- Added provisional Grok Build 1.0.13-or-newer full sync: bounded Observe plus
  authenticated ACP Create/Resume, queued prompts, permissions, commands,
  model/effort/mode controls, cancel, context display, and shared cross-client
  Drive. Builds below the 1.0.13 floor remain Observe-only; newer ones drive.

- Added provisional Kilo Code 7.4.23-or-newer full sync. SQLite Observe remains
  process-free; an authenticated broker-owned host on dedicated port 4097 adds
  Create/Drive, prompt/cancel, per-tool approvals, model selection, native
  rename, live status, run summaries, tokens, cost, and read-only native child
  rows. Native tool display remains unsupported.

- Added provisional Reasonix 1.25.2 support: bounded local-store discovery and
  Observe, durable create/load through a lazy broker-owned ACP child, queued
  prompt reconciliation, answer/reasoning streaming, per-tool approvals, and a
  single cross-client Drive that fails read-only on detectable foreign
  transcript writes. Native per-write identity remains unmeasured.

- The client can create sessions with the new adapters, project their model and
  mode controls, retain composer drafts across navigation and reconnects, and
  keep an incomplete roster usable while slower discovery lanes finish.

### Changed

- Session-roster discovery yields between adapters and stops at a whole-sweep
  deadline. Large local stores no longer make broker health, paired clients, or
  live sessions wait behind a multi-adapter discovery cohort; unfinished lanes
  remain explicitly unconfirmed and use bounded carry.

- Short installer URLs at `cosyncing.com/install.sh` and
  `cosyncing.com/install.ps1`, plus their `install-server` variants. The website
  mirrors the accepted stable release's scripts; install instructions now use
  these URLs across all five README and website languages.

### Fixed

- Codex sessions driven through a private app-server hand control back before
  terminal sync. Restart now verifies that the previous daemon exits, shares
  concurrent restart attempts, preserves known version evidence for an
  unreachable daemon, and never force-stops one during an automatic update.

- `cosy status` preserves the runtime name and pending configuration details
  returned by managed-update checks instead of reducing them to aggregate
  counts.

- The Usage report uses its injected report clock consistently, so a skewed or
  differently-zoned device does not present a finished period as still active.

## 0.5.3 — 2026-09-12

### Added

- The first signed broker release, and with it the installer one-liner the
  installation docs have always named. `install.sh`, `install.ps1` and their
  `install-server` variants are published beside the release and reachable at
  `releases/latest/download/<name>`; until now that URL resolved to nothing,
  because no broker release had ever been published.

### Changed

- A release carries the broker as JavaScript. The signed asset set is
  `cosyncing-app.js`, the web sidecar, the four installers and the matching
  desktop clients — no compiled broker executable and no bundled runtime
  archive. You do not need Bun beforehand: an installer reuses a suitable
  runtime if the host has one and otherwise downloads the pinned upstream
  release, and the broker then runs under that separate Bun installation.
- An npm installation keeps package-manager ownership and updates through npm,
  unchanged. Only an installer-placed broker follows the signed release channel.
- Signed broker promotion stays bound to the trusted workflow revision when it
  verifies an older candidate.

### Fixed

- Shell setup commands print the Bun runtime that will actually run them,
  including when the installer downloaded Bun outside `PATH`.

## 0.5.2 — 2026-09-12

### Added

- One command installs the broker and the desktop client. `install.sh` and
  `install.ps1` now place the GUI client beside the broker, run `setup`, hand the
  client a pairing offer, and launch it. The client artifacts ship inside the
  signed broker release, so `SHA256SUMS` and the digests baked into the installer
  cover them exactly as they cover the broker's own files. A host with no client —
  Linux arm64, or a Linux box with no display server — says so and finishes as a
  server install. `setup` reads from the terminal rather than from the `curl | sh`
  pipe, so its plan-and-confirm still asks; a run with no terminal prints the
  command and stops instead of consenting for you.
- The broker-only installers keep their behaviour under new names,
  `install-server.sh` and `install-server.ps1`. All four are rendered from the two
  templates in one step, so a server installer cannot drift from the all-in-one it
  is a mode of.
- On its first launch after an all-in-one install, the client reads the pairing
  offer the installer left in `$COSYNCING_HOME/client-pairing.json`, imports it,
  and deletes it. The offer is one-use and expires in five minutes, exactly as
  `pair` issues it. An absent, malformed, or expired file is ignored.
- Added `install.ps1`, a PowerShell installer for the Windows x64 broker, published
  beside `install.sh` by the same release step. It verifies the release with the
  ECDSA P-256 signature the manifest is already signed with, places the JavaScript
  application and the web client under `%COSYNCING_HOME%\bin`, installs a
  digest-pinned Bun when the host has none new enough, writes a `cosy.cmd` shim, and
  prints the `setup` command. It refuses an elevated install, and refuses Windows
  ARM64 and an x64 process emulated on ARM64. Both installers are now documented in
  [installing with cosyncing's own installer](installation/script-install.md).
- Added omp (oh-my-pi) session discovery, Drive/resume, live bridge sync, model and
  command controls, New Session, setup/repair ownership, and client roster identity.
  OMP 17.4.2 or newer is required; older clients do not receive OMP roster rows.
- Windows x64 is a supported broker host. The npm package now declares `win32`,
  and setup, doctor, and broker startup all accept the platform natively rather
  than directing you to WSL. WSL remains supported as a Linux host.
- Added a Usage report under Settings: totals for today, this week, this month,
  this year, and all time, read from the host's Tokdash, with an activity
  heatmap, top projects, a working-hours profile, and export cards. The broker
  serves it read-only at `/api/tokdash/report`; project names are shown to the
  owner only. This raises the broker contract to revision 20, which a client
  needs before it can show the report. It does not move the minimum accepted
  client revision, which stays at 17, so a 0.5.0 or 0.5.1 client keeps working
  against this broker and simply does not offer the report until you update it.
- Artifact downloads resume. The broker answers `Range` on artifact downloads,
  so any client that speaks it — `curl -C -`, a download manager — can resume
  one. The app pulls an artifact in 512 KiB chunks instead of buffering the whole
  file, retries a failed chunk from where it stopped, and resumes at the same
  offset when its download ticket has to be refreshed mid-transfer. It also
  continues across attempts: cancel a download and retry it, or kill the app
  and reopen it, and the next attempt asks for the byte the last one reached
  rather than starting over. Each chunk is validated against the representation
  the download started on, so a file that changed underneath restarts cleanly
  rather than splicing two versions.
- A file the agent sent you now carries a "Sent to you" badge in the transcript.
  Files you attached, and files the broker surfaced because the agent wrote them
  into the workspace, are not badged — the badge means the agent chose to hand
  you that file. It survives a restart.

### Changed

- The broker collects session inboxes. A file you attach to a prompt is staged
  in `<workspace>/.cosyncing/inbox` so the agent can read it; until now nothing
  ever removed it, so a workspace accumulated every screenshot you had ever
  pasted. The broker now sweeps hourly: an attachment older than 14 days is
  removed, and an inbox over 256 MB or 200 files is trimmed oldest-first back to
  the cap, never below the newest 8 files. This reaches the inboxes that filled
  up before this release, not only new ones: a workspace with a live session is
  collected whether or not you have attached anything to it since upgrading. A
  file a staged upload still points at is never touched, and neither is an inbox
  reached through a symlink. `COSYNCING_INBOX_RETENTION_MS`,
  `COSYNCING_INBOX_MAX_BYTES`, and `COSYNCING_INBOX_MAX_FILES` override the three
  defaults; `COSYNCING_INBOX_RETENTION_MS=0` turns the sweep off.
- Claude Code and Kimi Code surface a deliverable the agent writes inside the
  session workspace as a file artifact, the way OpenCode already did. The rule
  is unchanged — the write must succeed, must be a deliverable rather than
  source churn, and must land inside the session's own directory — but the
  broker matched the tool name case-sensitively against `write`, and both agents
  report it as `Write`, so neither ever qualified.
- Prompt image attachments are bounded. A prompt carries at most 8 images within
  a 1.5 MB encoded budget, each at most 1 MB decoded, each needing a MIME type
  and canonical raw base64 — the same limits already applied to file
  attachments. An image over the line is refused with `ATTACHMENT_LIMIT_EXCEEDED`
  or `ATTACHMENT_INVALID` before its bytes are decoded, rather than being
  forwarded to the agent unchecked. An adapter without native file input refuses
  images outright instead of silently dropping them.
- Setup no longer reverses a permission repair. Tightening durable-state
  permissions is a monotonic action: it is applied once and is not undone if a
  later step fails, on every platform. Rollback still restores the file contents
  it found. Reversing a security repair would mean widening access again from a
  record written before the repair, which setup will not do.

### Fixed

- Scheduled messages work on a paired device. Reading the queue needs `observe`
  and changing it needs `drive`, instead of the owner credential no paired client
  holds. A scheduled send is a prompt with a clock on it, and `drive` already
  delivers that prompt immediately, so deferring it grants no new authority.
  Every paired device previously showed a permanent "server refused this device"
  error in each session, and re-pairing could not clear it.
- Surfacing a workspace file into a session needs the `files` role rather than the
  owner credential. The path is resolved against the session's own directory and
  checked for containment, so the route was held to a stricter bar than the
  boundary it enforces, and stricter than the uploads route beside it.
- Codex New Session requests JSONL history explicitly, so current Codex CLI
  versions persist empty sessions for discovery and resume before the first
  prompt.
- Broker startup respects the Windows default of disabled Codex terminal sync,
  including when setup persisted an enabled preference. The sync endpoint also
  rejects attempts to enable it on Windows. Explicit startup environment overrides
  still take precedence.
- The shell installers are `sh` scripts and say so. Their shebang read
  `#!/usr/bin/env bash` while the documented one-liner pipes them into `sh`, which
  on Debian and Ubuntu is dash. In the all-in-one, the probe for a terminal ran
  `:` with a redirection that fails when there is none — and a redirection error
  on a POSIX special built-in exits the shell, so dash killed the installer with
  status 2 and no message, after the broker was installed and before the line
  explaining that `setup` had been skipped. Every headless run on those
  distributions hit it. macOS never did, because there `sh` is bash.
- A client promotion no longer breaks every installed broker's update check.
  GitHub keeps one `latest` release per repository, and every broker compiles
  `releases/latest/download/release-manifest.json` in as its update channel, so
  promoting a client release with `--latest` moved the pointer to a release with
  no manifest. Client promotion no longer claims it; the broker release is the
  only release that may hold it.
- `cosyncing upgrade` works on Windows. The Scheduled Task does not run
  `%COSYNCING_HOME%\bin\cosyncing`; it runs a versioned copy under
  `%COSYNCING_HOME%\service\windows\versions\`, and only `setup` ever wrote
  one. So the swap replaced a file the service does not run, the restarted broker
  came back on the version it already had, and the post-switch health check
  rolled every upgrade back. `upgrade` now writes the new version root — the same
  writer `setup` uses, so it carries the new application, web client and service
  environment together — and points the service at it before the restart. If the
  candidate then fails its health check, the pointer goes back before the service
  is restarted, so the rollback restores the previous build rather than starting
  the new one. An interrupted upgrade is undone the same way from its durable
  journal. Installer plus `setup` remains a valid way to update; it is no longer
  the only one. The fix lives in the upgrader, so a host still on 0.5.1 rolls
  back once more; update that host once with the installer and `upgrade` works
  from there.
- A rolled-back upgrade no longer leaves files nothing owns. The rollback copy of
  the binary and the candidate's web client used to survive under
  `<home>/bin` with no receipt naming either, so `uninstall` reported a clean
  removal while both stayed on disk. Both are removed with the rollback, on the
  journal recovery path as well. A rollback copy an *earlier* upgrade left is
  untouched — that one is still measured by a receipt that is true.
- The web client an upgrade installs is owner-only on Windows. Its staging
  directory was created with a POSIX file mode, which Windows ignores, so the
  unpacked tree inherited its parent's access instead of carrying the protected
  descriptor every other directory cosyncing creates has. On Linux and macOS the
  same tree is now 0700/0600 rather than whatever the archive and your umask
  produced.

### Notes

- Windows ARM64 is not qualified yet and is refused, including an x64 process
  running under ARM64 emulation — which reports itself as x64, so the broker asks
  Windows what the underlying machine is rather than trusting the process. npm
  itself may still allow the package to be acquired there, because `os` and `cpu`
  are independent lists and no combination of them can exclude Windows ARM64
  without also excluding the supported Linux and macOS ARM64 hosts. The refusal
  happens before setup changes anything.

## 0.5.1 — 2026-08-29

### Fixed

- Full transcript resyncs now preserve newer live output and telemetry without
  duplicating raced streamed or keyless rows, and capped resets retain a valid
  cursor for loading earlier history.
- Transcript windows no longer label a locally evicted head as the start of
  the session.
- Focused text fields no longer lose bare shortcut characters such as digits,
  brackets, or AltGr input when the matching shortcut is intentionally
  suppressed.
- Claude sessions now keep truthful working and Drive state while background
  agents report back, render notification-led continuations as distinct turns,
  and close interrupted or failed live runs without leaving stale telemetry.
- The Claude composer context meter now reports current 200K or 1M usage across
  history refreshes and model-window changes.

## 0.5.0 — 2026-08-27

This release raises the minimum client contract revision to 17, so a 0.4.1 or
older client cannot drive a 0.5.0 broker — the pairing negotiates read-only and
session controls stay disabled. Update the client on every device. The web
client ships inside the broker package and always matches it.

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
- Antigravity (`agy`) is a shipped agent. Conversations are discovered from the
  CLI's own store and replayed read-only; `?mode=resume` drives one through a
  broker-owned `agy` child that starts on the first prompt rather than on
  attach. Two clients can share one Drive — the second is offered the join,
  receives the same connection, and sees prompts the transcript has not
  recorded yet — and a write from a terminal releases the session to it and
  says so. New sessions can be created from the app with directory and model
  choice; the pending roster row resolves to the CLI's own record on the first
  prompt. Model selection reads the CLI's live catalog: reasoning-effort
  variants collapse into one model with selectable low, medium, and high
  efforts, shown in the roster and the composer. Checkpoint summaries and
  stripped user-row metadata replay as decodable context events, and an
  attached session reports its control state. Doctor diagnoses it. Seven gated
  suites cover the store, the mapper, observe, drive, replay identity,
  registration, and the cross-client join.
- Kimi subagent sessions appear in the roster as observe-only child rows under
  the session that spawned them, replaying the child's own journal. A detached
  child that is still writing its journal shows as working — the child's own
  turn lifecycle decides — and an active child keeps its parent marked
  working.

### Changed

- Subagent subtrees in the session roster default to closed. The parent keeps
  its linked-session count chip, opening one is a saved per-parent choice, a
  search still reveals a matching child under its parent, and a working child
  still rolls its status up to the parent row. The cached startup pane folds
  the same children.
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

- Kimi and DeepSeek Harness roster rows show their model before the session is
  opened: kimi rows read their own journal head, and DeepSeek Harness rows use
  a bounded per-session model read cached by row freshness.
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
