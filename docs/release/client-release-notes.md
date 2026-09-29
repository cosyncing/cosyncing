# cosyncing client downloads

These are broker-independent Flutter clients. Install and run the broker first,
then use `cosy pair` to authorize the client.

## Update your client with this release

0.6.0 is the largest client release to date. Session tabs stay open beside an
overview, the sidebar follows you into Notifications and Settings, each
notification type is configured on its own, notifications reach a browser with
every tab closed, and reading back through a long session keeps its place.

Update the client on every device you use before, or together with, the Server.
This release ships broker contract revisions 27 and 28 together and the
compatibility window stays one revision wide, so a native client from 0.5.13 or
earlier can watch a 0.6.0 Server but cannot drive it: it cannot answer a
permission request or send a prompt. The web client needs nothing: it ships
inside the broker package and always matches it. A 0.4.1 or older client also
sits below the minimum accepted client contract, still revision 17, and stays
read-only against current brokers.

## What's new in 0.6.0

- The workspace keeps session tabs visible, including a single open session,
  and adds an overview plus Close all with Undo. Closing a tab leaves that
  session running. Phones and other narrow screens open the same sidebar as a
  drawer from the menu button.
- The roster starts with every project collapsed and marks one that needs input
  or has finished work with a single dot. Rows use the harness's own logo and
  keep subagent hierarchy, with the parent's status and its descendants' cues
  shown separately.
- Conversations use a compact context header and composer, with model,
  permissions, microphone, context usage, Send and Stop within reach.
  Conversation text size, spacing and reading width persist on their own. Flat
  White Minimalist is the new default palette, with the new Quiet Workspace
  palette and bundled Lato typography.
- Notifications are configured per event type in three families: Sessions,
  Security and Server. On Android each type is its own system channel. Each
  event now notifies once instead of on a ladder of reminders, opening a
  session or tapping its notification clears it, and reading it on one device
  clears it on your other devices.
- Closing the window keeps Cosyncing running on macOS and Windows so
  notifications still arrive. Android has an off-by-default switch that stays
  connected in the background.
- Reading back through a long session no longer loses your place. The client
  holds up to 500 rows and about 4 MiB, unloads whole pages far from where you
  are reading, and restores exactly those rows. Following a reply as it streams
  in now draws almost every frame on time instead of dropping most of them.

For notifications with every browser tab closed, per-type notification settings
and cross-device read/clear, use a 0.6.0 client with a 0.6.0 broker release.

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
