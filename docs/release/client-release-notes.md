# cosyncing client downloads

These are broker-independent Flutter clients. Install and run the broker first,
then use `cosy pair` to authorize the client.

## Update your client with this release

0.5.12 adds Codex background command cards with bounded output and exact exit
results where the runtime supplies them. Reconnect preserves completed results
and clears stale running cards even after recovery records are evicted.

0.5.12 keeps the minimum accepted client contract at revision 17, so a 0.5.0 or
0.5.1 client still drives a 0.5.12 broker. Codex background cards require the new
revision-26 client for safe reconnect reconciliation; older clients retain their
existing Codex functionality. A 0.4.1 or older client
remains read-only against current brokers.

Update the client on every device you use before, or together with, the broker.
The web client needs nothing: it ships inside the broker package and always
matches it.

## What's new in 0.5.12

- Shell commands Codex runs in the background appear as a live card in the
  session, showing the command, available timing and output, and how it ended
  when Codex reports an exact result — including an otherwise unmentioned failure.
  The card stays until dismissed, and a command that goes silent is withdrawn
  rather than left claiming to run.
- Completed command results remain available after reconnect until dismissed.
- Stale running command cards are reconciled after ledger eviction or restart.
- Capability detection preserves broad Codex version compatibility; exact
  offline recovery depends on the runtime's available history endpoints.

For Codex background-command cards, use a 0.5.12 native client with a 0.5.12
broker release. The web client ships with the matching broker.

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
