# cosyncing client downloads

These are broker-independent Flutter clients. Install and run the broker first,
then use `cosy pair` to authorize the client.

## Update your client with this release

0.5.9 makes the signed stable update channel visible across native clients.
Android can install a verified APK in-app; Linux, macOS, and Windows show their
installed version and open the matching accepted download in the browser.

0.5.9 keeps the minimum accepted client contract at revision 17, so a 0.5.0 or
0.5.1 client still drives a 0.5.9 broker. Those clients do not expose features
introduced by newer contract revisions. A 0.4.1 or older client remains
read-only against current brokers.

Update the client on every device you use before, or together with, the broker.
The web client needs nothing: it ships inside the broker package and always
matches it.

## What's new in 0.5.9

- Native clients check the signed release channel without a broker connection,
  show their installed version under Settings → General, and mark Settings when
  an accepted update is available.
- Android authenticates and installs the verified APK after user confirmation;
  desktop clients open the exact accepted platform download in the browser.
- Linux clients verify that Secret Service can persist credentials before
  consuming an installer's one-use pairing. WSLg retries briefly while its
  keyring becomes ready and reports a recoverable setup error if it cannot.

For these features, use a 0.5.9 native client with a 0.5.9 broker release.

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
