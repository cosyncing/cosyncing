# cosyncing client downloads

These are broker-independent Flutter clients. Install and run the broker first,
then use `cosy pair` to authorize the client.

## Update your client with this release

0.5.13 corrects how a refused Codex takeover is explained. A session whose
Codex daemon ownership could not be verified no longer claims that Codex
Desktop may still control it; it reports the ownership check that failed,
which is a different problem with a different remedy.

0.5.13 keeps the minimum accepted client contract at revision 17, so a 0.5.0 or
0.5.1 client still drives a 0.5.13 broker. Codex background command cards
require a revision-26 client for safe reconnect reconciliation. A 0.4.1 or older
client remains read-only against current brokers.

Update the client on every device you use before, or together with, the broker.
The web client needs nothing: it ships inside the broker package and always
matches it.

## What's new in 0.5.13

- A refused Codex takeover names its actual cause. When the daemon's ownership
  check could not be answered, the client says so instead of naming Codex
  Desktop or another client as a possible writer; a confirmed competing writer
  keeps the conflict wording. Applies to manual takeover and to automatic
  restoration, in all five locales.
- On the broker side of the same release, `cosyncing doctor` reads a Codex
  control socket that the runtime publishes as a symlink, and a managed Codex
  daemon is recognized on runtimes that append a `--managed-daemon` launch
  marker, so restarts stop refusing a daemon they already own.

For Codex background-command cards, use a 0.5.12 or newer native client with a
0.5.13 broker release. The web client ships with the matching broker.

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
