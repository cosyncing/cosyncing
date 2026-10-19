# cosyncing client downloads

These are broker-independent Flutter clients. Install and run the broker first,
then use `cosy pair` to authorize the client.

## Update your client with this release

0.7.2 gives the app its own update screen. Settings → Updates checks this
device and each saved server separately, without changing the active
connection, and lists the named components, the exact versions and anything
that interrupted the check before you install what you select. Prepared
downloads and server jobs survive an app restart or a lost response: reopen
Updates and choose **Continue remaining updates**. Server owners can review
which devices may run updates and revoke that permission later.

A desktop update in this release still ends in a **Download**, or in
`cosy update` for a desktop the all-in-one installer placed. The staged
handoff that would replace the app in place exists, but a release advertises
internal installation only for a platform where replacement, relaunch and
recovery have been accepted with the installed helper, and 0.7.2 advertises
none. Existing desktop apps need one manual upgrade to acquire the new screen;
on macOS, running the new signed all-in-one installer once registers the
independent user helper for a later release to use.

The broker contract moves to revision 34 and the minimum accepted client
revision stays 17, so a 0.6.x or 0.7.x native client still drives a 0.7.2
Server. Messages sent from other Claude sessions and subagent reports need both
the 0.7.2 Server and a 0.7.2 client to appear as a collapsible 'Message from
…' row; an older client draws the same delivery as an ordinary event row.
Nothing else about the Server moves in this release: Bun stays at 1.3.14 and
npm distribution stays retired at 0.6.6.

Update the Server first with `cosy update`; the app then offers the 0.7.2
download.

## What's new in 0.7.2

- Settings → Updates checks this app and your saved servers without switching
  to them, shows what each one would install and what got in the way, and lets
  you run only the parts you select. Interrupted work is recoverable, and a
  server that can only be updated by hand reports the available version and the
  installer to run.
- A local desktop update helper carries the in-place install path: it stages
  the signed build, saves drafts, waits for the app to exit fully, replaces it
  and verifies the reopened build. Continuing an update reconciles an
  interrupted helper job before it retries, and a failure after exit reopens
  the unchanged app only when its integrity and stopped state can be
  confirmed. Nothing installs in place until a signed release enables the
  platform.
- Messages from other Claude sessions and subagent reports collapse into a
  'Message from …' row instead of a queued user message, stay visible in
  Final-only mode, and carry their own footer with completion and error
  notifications.
- Compact sessions keep open and pinned files in a slim chat/file strip, and
  file links and browser selections share one reader. Supported documents open
  rendered by default and remember an explicit reader choice.
- Selection controls use anchored popups on phones and desktop, with quieter
  settings rows and borderless dark surfaces.
- Display settings add a default tool-call visibility with persistent
  per-session overrides, kept separate from assistant-message filtering.
- Overview shows Time, Tokens, Cost and Messages in a two-column mobile grid,
  and narrow session navigation uses tighter spacing around the menu, Overview
  and session tabs while keeping usable touch targets.
- Refused-send details scroll inside the narrow chat reading area, so the draft
  and the Send button stay reachable in a short phone window.

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
