# cosyncing client downloads

These are broker-independent Flutter clients. Install and run the broker first,
then use `cosy pair` to authorize the client.

## Update your client with this release

0.6.1 is a client polish release. The usage views are quieter and stop
explaining themselves in footnotes, pending work has one name per kind, an
Android update offer can be set aside, and a session that finishes more than
once is listed once.

Update the client on every device you use before, or together with, the Server.
The broker contract stays at revision 28 and the compatibility window stays one
revision wide, so a native client from 0.5.13 or earlier can watch a 0.6.x
Server but cannot drive it: it cannot answer a permission request or send a
prompt. The web client needs nothing: it ships inside the broker package and
always matches it. A 0.4.1 or older client also sits below the minimum accepted
client contract, still revision 17, and stays read-only against current brokers.

## What's new in 0.6.1

- Agents & Quota shows only quota windows, and token usage lives in the Usage
  overview. The overview's day view drops the day streak, peak day and weekday
  chart that a single day cannot fill, and the report, its project leaderboard
  and the workspace overview drop their explanatory footnotes; how agent time
  is estimated stays on its tooltip.
- Pending work has one name per kind on both the overview and Notifications:
  "Waiting for you" for questions and approvals, "Unread completions", and
  "Problems" for failed runs and security or server alerts. The "Needs
  attention" grouping is gone, so the same filter is no longer reachable under
  two names.
- On Android a new app release is offered once in a dialog with Later, instead
  of a banner that stayed over every screen and could not be dismissed. Setting
  it aside keeps the update in Settings → General, still carrying its update
  dot.
- On phones and other narrow screens, reopening the sidebar after opening a
  session from it keeps the projects and subagent groups you had open, instead
  of collapsing every project again.
- A session that finishes more than once is listed once in Notifications and in
  the overview's Unread completions: its newest outcome replaces the earlier
  ones, as it already did in the system notification center.

The 0.6.0 features that need both ends of the wire, notifications with every
browser tab closed, per-type notification settings and cross-device read and
clear, still need a 0.6.0 or newer Server. 0.6.1 is one.

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
