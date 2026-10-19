# cosyncing client downloads

These are broker-independent Flutter clients. Install and run the broker first,
then use `cosy pair` to authorize the client.

## Update your client with this release

0.7.1 is about the session list. You can hide a chat from the roster or from
Status and undo it, a hidden chat stays hidden on your other devices paired to
the same Server, and a compact filter panel adds **Show hidden** plus custom
activity windows such as the last two or three days. On phones the composer
sits just above the keyboard instead of leaving a keyboard-sized gap under it.

Hiding chats needs a 0.7.1 Server, which now owns session visibility and
carries it to a session's subagents; against an older Server the hide action
reads as unavailable. Custom day counts in the filter panel need that Server
too, and fall back to showing everything on an older one. The broker contract
moves to revision 33 and the minimum accepted client revision stays 17, so a
0.6.x or 0.7.0 native client still drives a 0.7.1 Server. The web client ships
with the broker and always matches it.

Update the Server first with `cosy update`; the app then offers the 0.7.1
download, and on an installer-owned desktop `cosy update` takes the client too
once you have quit it. Nothing else about the Server moves in this release: Bun
stays at 1.3.14 and npm distribution stays retired at 0.6.6.

## What's new in 0.7.1

- Hide and unhide a chat from the roster or Status, with Undo. Visibility syncs
  across devices on the same Server and covers a session's subagents, while an
  open tab, agent activity, notifications and approval alerts keep working for
  a hidden session.
- A compact roster filter panel with **Show hidden** and custom activity
  windows, so the last two or three days is a choice next to seven and thirty.
- Session activity cards show compact summaries with scripts in expandable
  details, and Status and chat share dismissal and clear-finished controls.
- Session information opens in a centered dialog with more room for its title.
- Settings → General → Storage now houses device-wide session cache cleanup.
  Status drops Duplicate and Copy transcript and simplifies its cache row;
  per-message copy, Fork and transcript export stay where they were.
- On phones the composer stays just above the keyboard. Tapping Send keeps the
  editor focused, and a long draft uses the available height instead of
  crowding out the conversation.

Hiding chats and the custom day windows are in the Server; the rest is in the
app.

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
