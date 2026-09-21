# cosyncing client downloads

These are broker-independent Flutter clients. Install and run the broker first,
then use `cosy pair` to authorize the client.

## Update your client with this release

0.5.11 adds a live card for shell commands an agent runs in the background, and
lets Android share the usage image. An expanded live-state card now reports what
the underlying work is really doing.

0.5.11 keeps the minimum accepted client contract at revision 17, so a 0.5.0 or
0.5.1 client still drives a 0.5.11 broker. Those clients do not expose features
introduced by newer contract revisions; in particular an older client shows the
background-command card without its output preview. A 0.4.1 or older client
remains read-only against current brokers.

Update the client on every device you use before, or together with, the broker.
The web client needs nothing: it ships inside the broker package and always
matches it.

## What's new in 0.5.11

- Shell commands an agent runs in the background appear as a live card in the
  session, showing the command, how long it has been running, the latest output
  lines, and how it ended — including a failure the session never mentioned.
  The card stays until dismissed, and a command that goes silent is withdrawn
  rather than left claiming to run.
- The shareable usage image can now be shared from Android, alongside desktop
  and the web UI.
- Usage rankings show the top five agents, models, and projects, and
  Settings → Agents shows each agent's logo. By agent lists every tool the
  machine reported.
- An expanded live-state card now shows its real state instead of always
  reporting "Running" with a clock that keeps climbing after the work finished.

For the background-command card with its output preview, use a 0.5.11 native
client with a 0.5.11 broker release.

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
