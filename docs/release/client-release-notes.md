# cosyncing client downloads

These are broker-independent Flutter clients. Install and run the broker first,
then use `cosy pair` to authorize the client.

## Update your client with this release

0.8.2 keeps the app working when the device changes network: completion
notifications, inbox entries and open sessions recover on their own instead of
waiting for an app restart. Android downloads now use the system **Save as**
screen, keep reporting progress, and stay saveable or shareable from the cache.
Quotas move to liquid circles. There is no new Server feature: the broker
contract revision stays at 35, the minimum accepted client revision stays at 17,
and Bun stays at 1.4.3.

Most of what's fixed here lives in this client, so install this download to get
it. Update the Server first anyway with `cosy update`: it ships the web client,
and 0.8.2 is where a Windows Server starts serving that web client and its
version document correctly, which is what lets a signed update pass its web
verification instead of rolling back. The same Server release adds OpenCode 2
compatibility and clearer reporting for failed updates.

A desktop update in this release still ends in a **Download**, or in
`cosy update` for a desktop the all-in-one installer placed. Update the Server
first with `cosy update`; the app then offers the 0.8.2 download.

## What's fixed for clients in 0.8.2

- Android downloads open the system **Save as** screen, and a download that
  finishes while the app is in the background stays available to save later.
  Cached files offer **Save** and **Share**, and the filename you chose survives
  restarts.
- Android workspace downloads keep reporting progress after you switch servers or
  reconnect, instead of staying at 0 bytes.
- Artifact **Technical details** show the underlying save or preview error.
- Completion notifications, inbox entries, Overview counts and session dots keep
  arriving after the device changes network or a session connection drops.
  Previously the feed stopped until the app restarted, while Settings still
  showed the Server as connected.
- Open sessions reconnect after a network change even when a notification or
  another background request needs the new connection at the same moment.
- File-close notices dismiss automatically and have a close button. With
  accessible navigation enabled, **Undo** stays available until you dismiss one.
- Finished sessions move into the correct recent order within their project as
  soon as their completion arrives, without a roster refresh.
- Claude Code skills launched in the background appear as subagents in the
  session roster and activity bar, including their completion state.
- Quotas show each limit as a liquid circle, with two providers per row on phones
  and larger screens. Waves pause for reduced motion and inactive views.

For the Server side of 0.8.2 — Windows update readiness, recovery and
diagnostics, and OpenCode 2 compatibility — see the 0.8.2 section of the
changelog.

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
