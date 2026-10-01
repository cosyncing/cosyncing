# cosyncing client downloads

These are broker-independent Flutter clients. Install and run the broker first,
then use `cosy pair` to authorize the client.

## Update your client with this release

0.6.3 changes the app. Notifications, Settings, Agents & Quota and Android's
Back button are reworked, and reading or clearing a notification on one device
now carries to your other devices. Update the Server first if you use the quota
page: the reset credits shown under Codex and Claude Code need a 0.6.3 Server,
and behind Tokdash older than 2.6.3 the row stays empty. Everything else in this
client works against a Server it could already reach.

The broker contract stays at revision 28 and the compatibility window stays one
revision wide, so a native client from 0.5.13 or earlier can watch a 0.6.x
Server but cannot drive it: it cannot answer a permission request or send a
prompt. The web client needs nothing: it ships inside the broker package and
always matches it. A 0.4.1 or older client also sits below the minimum accepted
client contract, still revision 17, and stays read-only against current brokers.

## What's new in 0.6.3

- The Notifications page is usable at any length. Notifications that need a
  response, unread completions and problems now dismiss from their row, Clear
  all clears the page in one tap with Undo, and only the rows on screen are
  drawn, so a long history no longer freezes it. Reading one device's
  notification marks it read on your other devices — security alerts excepted,
  which stay unread until read there — and notifications plus their system
  notifications clear themselves 24 hours after they last changed.
- Settings is one reading-width column of plain rows under bold headings. The
  remaining cards, outlines and tinted boxes are gone, chip and segmented
  choices are selects beside their label, and Display is a single page running
  from Appearance through Conversation to Session visibility and the legend.
  The server row at the bottom of the sidebar opens a switcher with Add server
  and Manage servers, and Settings → Servers drops the created and last-used
  dates.
- Agents & Quota lists runtimes as rows with a text Restart action and puts
  providers two to a row on wide screens. Every five-hour window reads "5-hour"
  whatever the provider calls it, shows what remains and when it resets, and
  stays neutral until it runs low. Below the windows, Codex and Claude Code show
  the reset credits they hold and when the soonest expires, in amber in its last
  two days.
- On Android, Back returns to the page Settings, Notifications or Connection was
  opened from instead of closing the app, and on Android 14 and later a dismissed
  "Staying connected for notifications" notification stays dismissed while the
  background connection keeps running.

The 0.6.0 features that need both ends of the wire, notifications with every
browser tab closed, per-type notification settings and cross-device read and
clear, still need a 0.6.0 or newer Server. 0.6.3 is one.

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
