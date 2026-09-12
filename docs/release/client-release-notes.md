# cosyncing client downloads

These are broker-independent Flutter clients. Install and run the broker first,
then use `cosy pair` to authorize the client.

## Update your client with this release

0.5.2 keeps the minimum accepted client contract at revision 17, so a 0.5.0 or
0.5.1 client still drives a 0.5.2 broker. Those clients simply do not offer the
features that need a newer contract, the Usage report among them. A 0.4.1 or
older client remains read-only against current brokers.

Update the client on every device you use before, or together with, the broker.
The web client needs nothing: it ships inside the broker package and always
matches it.

## What's new in 0.5.2

- One command installs the broker and this client together. `install.sh` and
  `install.ps1` place the client beside the broker, run `setup`, hand the client
  a one-use pairing offer, and launch it — so a new device is paired without
  copying a token by hand. On Windows the client also gets a Start Menu entry.
- A Usage report under Settings: totals for today, this week, this month, this
  year and all time, with an activity heatmap, top projects, a working-hours
  profile and export cards.
- Artifact downloads resume. A download continues across a cancelled attempt, an
  app restart, and a ticket refresh mid-transfer, rather than starting over, and
  validates each chunk against the file the download began on.
- A file the agent chose to send you carries a "Sent to you" badge, and it
  survives a restart. Files you attached are not badged.
- Scheduled messages work on a paired device. Every paired device previously
  showed a permanent "the server refused this device's access" error in each
  session, which re-pairing could not clear.
- Codex New Session works again on current Codex CLI versions. codex-cli 0.151.0
  stopped persisting an empty session, so creating one failed.
- oh-my-pi (omp) joins the roster as its own agent, with Drive, live sync, model
  and command controls, and New Session. OMP 17.4.2 or newer is required.
- Focused text fields receive digits, brackets, punctuation and AltGr input when
  a matching application shortcut is intentionally suppressed.

For the complete behavior above, use a 0.5.2 client with a 0.5.2 broker.

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
