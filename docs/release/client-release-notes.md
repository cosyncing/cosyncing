# cosyncing client downloads

These are broker-independent Flutter clients. Install and run the broker first,
then use `cosy pair` to authorize the client.

## Update your client with this release

0.9.0 is a Server release. It adds support for OpenCode 2, Kimi Code 2.7 and
omp 19.1.0, and brings cosyncing up to date with the current versions of the
other supported agents. The Android and desktop apps have no changes of their
own; update the Server with `cosy update`. The web client ships with the Server
and always matches it.

The broker contract revision stays at 35, the minimum accepted client revision
stays at 17, and Bun stays at 1.4.3. A 0.8.5 client drives a 0.9.0 Server
unchanged. Standalone desktop apps offer **Download**. For desktops placed by
the all-in-one installer, quit the app before updating it with `cosy update`.

## What's changed in 0.9.0

- OpenCode 2.2.0 and newer: sessions run by your shared OpenCode service are
  listed, live and drivable, with approvals, forms, commands, files, undo and
  redo. OpenCode 1 remains supported.
- Kimi Code 2.7 and newer work over the Kimi Agent Protocol, alongside the 0.x
  versions. omp 19.1.0 is supported alongside 17.4.2, with forms as question
  cards and session fork.
- Reasonix 2.61.0, Claude Code 2.1.330, agy 1.5.16 and 1.5.18, Cline 3.0.75,
  Grok Build 1.0.92, Pi 1.6.0 and DeepSeek Harness 0.2.2-rc.5 are verified.
- Kilo Code questions appear as question cards, and Kilo's own background-task
  and wakeup reports no longer end the app's control of a session.
- Claude Code: Stop ends only the turn and keeps background agents running, and
  the context meter follows the window and count Claude Code reports.
- Antigravity sessions driven from the app run in the mode the app shows, and
  the mode picker offers Auto.
- Version and readiness checks no longer let Claude Code, Kimi Code or agy
  update themselves. The first full session list after a Server start is about
  twice as fast for large Claude Code histories.

For the full list, see the [0.9.0 changelog](../CHANGELOG.md#090--2026-11-27).

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
