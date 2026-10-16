# cosyncing client downloads

These are broker-independent Flutter clients. Install and run the broker first,
then use `cosy pair` to authorize the client.

## Update your client with this release

0.6.6 is a stability release. A long session stays responsive while a reply
streams in: every streamed chunk used to rebuild every message on screen, and
now only the message that changed is rebuilt. Long Claude sessions stay
pageable past the old history limit. Most of the app fixes are about ownership:
a session driven from the app now goes read-only the moment a terminal or
another program writes its transcript, a refused approval or question answer
reads as refused instead of delivered, and an agent that is not installed no
longer makes its sessions disappear from the list.

The broker now opens, forks or renames only sessions that the agent's own store
or server lists, which closes a path where a crafted session id could read
files outside that agent's session folder. It also stops reading a named pipe
in a session folder, deletes a transcript export left behind by a broker that
crashed, and keeps one unknown paired device from disconnecting the others.
Update the Server to get those.

The broker contract stays at revision 30 and the minimum accepted client
revision stays 17, so a 0.6.4 or 0.6.5 native client still drives a 0.6.6
Server. The web client ships with the broker and always matches it. Server-side
fixes such as the Claude history index, the session id checks and readable file
sizes need a 0.6.6 Server; the fixes listed below that are in the app need the
app.

This release is also a bridge for the Server's runtime. A new install gets Bun
1.3.14 from the installer, which now places it in
`~/.cosyncing/runtime/bun-<version>` instead of `~/.bun`, so re-running an
installer no longer replaces the Bun a running broker is using. The minimum
stays at Bun 1.3.8 in this release on purpose: a Server already running 1.3.8
can `cosy update` onto 0.6.6 and so receive the updater that installs a later
release's pinned Bun by itself, rolling the broker and the runtime back
together if the new broker fails its health check. A Bun you chose with
`COSYNCING_BUN_BIN` is never replaced, and `cosyncing uninstall` without
`--purge-data` now removes only the runtimes the installer and `cosy update`
placed.

On a Server installed with the signed one-line installer, `cosy update` now
updates the desktop client too, after asking you to quit it. On Windows and
macOS, a client installed by 0.6.4 or earlier needs the new all-in-one
installer once before `cosy update` can take it over.

## What's new in 0.6.6

- Stop works on a Grok session driven from the app: the turn ends as stopped and
  the session stays drivable. So far this is checked against a stand-in Grok,
  not a real Grok turn.
- A long session stays smoother while a reply streams and while other sessions
  change status. In a 300-message session a streamed chunk rebuilds less than
  half as much as before.
- A long Claude session stays pageable past the former 32 MiB and 50,000-row
  history limit through a persisted disk index, and a history failure now says
  whether it hit a server limit or a decoding limit.
- Generated files, Chinese filenames included, are found beside the files the
  session already used before the whole workspace is searched. Downloads keep
  Unicode filenames, browser transfers show progress as chunks arrive, and file
  sizes read as KB, MB and GB instead of raw bytes.
- A question Claude asks in a synced terminal reaches the app at once and stays
  answerable from either side, also when no device was watching when it was
  asked. In auto mode the transcript no longer fills with read-only cards for
  tool calls nobody is watching.
- A session driven from the app turns read-only in every open view as soon as
  another program rewrites or replaces its transcript, for Pi, OMP, Cline, Kilo
  Code, Grok, Reasonix and Antigravity, and an open view reloads the new history
  once.
- An approval for a request the agent never made, or an answer to a question
  already answered elsewhere, is refused instead of reported as delivered, for
  Codex, Claude, Pi, OMP and Kilo Code.
- A prompt you send keeps one row in every view of a Pi, OMP or Antigravity
  session and leaves the queue as soon as the agent starts it; a Cline prompt
  queued during a turn shows on every device at once.
- Sessions whose agent is not installed stay listed and open read-only with a
  reason instead of vanishing, and when an agent cannot resume a session the app
  names that agent rather than always saying Codex.
- Interrupted sessions recover: Kilo Code and Cline sessions are drivable again
  after their background server crashed, Take over works again after a Codex
  daemon crash left its control socket behind, and a reopened Codex session
  restores Drive on Windows and when terminal sync is off.
- Notifications and the inbox: Review and Reply open the session and switch
  server, Mark read, Dismiss and Clear reach the server at once, ages keep
  counting while the page is open, a phone's held alert no longer delays your
  other devices, and a Dismiss the server never heard of says it will sync.
- A `cosyncing://pair?brokerUrl=` link now pairs the server it carries.
  Switching saved servers loads the new session list at once and keeps its open
  tabs, a server that never answers times out with Retry, and a refused token
  brings up the sign-in screen.
- After Detach the header reads Detached with Attach back in view, F5 and
  Ctrl+R (Cmd+R on macOS) refresh the session list again, and at twice the
  default text size the session list, its drawer and the overview fit their
  width.
- On Windows, restoring Drive for a Codex session reads the process list
  directly, about 20 ms instead of starting PowerShell and taking about 2 s.
- OpenCode: a scheduled or newly created first prompt runs on the model you
  chose, an Observe view is read-only, a failed turn shows its error once, and
  Stop ends the turn as interrupted.

- When the Server runs a Bun that a newer release needs and cannot install by
  itself, the app's settings page says **Needs newer Bun** and explains what to
  do instead of the old "Not checked".

The 0.6.0 features that need both ends of the wire, notifications with every
browser tab closed, per-type notification settings and cross-device read and
clear, still need a 0.6.0 or newer Server. 0.6.6 is one.

## Downloads

- **Android:** `cosyncing-client-*-android.apk` is signed with cosyncing's
  long-lived Android release key. Sideloading requires permission to install
  apps from the browser or file manager you use. Keep the same signing key for
  every update; Android refuses an update signed by a different key.
- **Linux x64:** extract `cosyncing-client-*-linux-x64.tar.gz`, keep the bundle
  together, and run `cosyncing`. GTK 3, WebKitGTK 4.1, libsoup 3, and libsecret
  must be available on the host.
- **macOS Apple Silicon:** the DMG is intentionally not Developer ID signed or
  notarized. Drag Cosyncing to Applications, then Control-click it and choose
  **Open** on first launch. Only continue if you trust this repository and the
  published checksum.
- **Windows x64:** extract the complete ZIP before running `cosyncing.exe`.
  The build is intentionally unsigned and may show a Microsoft Defender
  SmartScreen warning. Choose **More info → Run anyway** only if you trust this
  repository and the published checksum.

iOS is not distributed in this release. TestFlight and App Store distribution
require an active Apple Developer Program membership. The iOS source and
simulator build remain covered by CI.

`SHA256SUMS` detects download corruption or replacement; it does not establish
a trusted publisher identity for the unsigned macOS and Windows builds.
