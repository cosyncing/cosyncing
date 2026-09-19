# cosyncing client downloads

These are broker-independent Flutter clients. Install and run the broker first,
then use `cosy pair` to authorize the client.

## Update your client with this release

0.5.10 is a fix release. It repairs installer pairing on clients whose broker
is still starting, and restores the runtime controls that disappeared from
Settings → Agents when a managed runtime had nothing pending.

0.5.10 keeps the minimum accepted client contract at revision 17, so a 0.5.0 or
0.5.1 client still drives a 0.5.10 broker. Those clients do not expose features
introduced by newer contract revisions. A 0.4.1 or older client remains
read-only against current brokers.

Update the client on every device you use before, or together with, the broker.
The web client needs nothing: it ships inside the broker package and always
matches it.

## What's fixed in 0.5.10

- Installer pairing holds its one-use claim while a newly started broker becomes
  responsive. Clients retry transient startup failures instead of dropping the
  offer and falling through to manual authentication.
- Settings → Agents no longer reports "Activity check unavailable" for a managed
  runtime that is already up to date.
- Force restart is offered on any server-managed runtime when nothing is
  pending. A wedged Codex daemon reports no pending change, which is exactly
  when the control used to disappear.

Use a 0.5.10 native client with a 0.5.10 broker release.

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
