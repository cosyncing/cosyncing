# cosyncing client downloads

These are broker-independent Flutter clients. Install and run the broker first,
then use `cosy pair` to authorize the client.

## Update your client with this release

0.5.1 is a compatible patch for the 0.5 series. It keeps the minimum accepted
client contract at revision 17, so a 0.5.0 client can still drive a 0.5.1
broker. A 0.4.1 or older client remains read-only against current brokers.

Update the client on every device you use before, or together with, the broker.
The web client needs nothing: it ships inside the broker package and always
matches it.

## What's new in 0.5.1

- Transcript resync now preserves newer live output and telemetry, avoids
  duplicate raced rows, keeps earlier-history paging available, and no longer
  labels a locally evicted transcript head as the start of the session.
- Claude background-agent notifications keep Drive and working state truthful,
  open distinct continuation turns, and close interrupted or failed live runs.
  The composer context meter follows the current 200K or 1M model window across
  history refreshes and model changes.
- Focused text fields now receive digits, brackets, punctuation, and AltGr input
  when a matching application shortcut is intentionally suppressed.

For the complete behavior above, use a 0.5.1 client with a 0.5.1 broker.

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
