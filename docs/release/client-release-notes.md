# cosyncing client downloads

These are broker-independent Flutter clients. Install and run the broker first,
then use `cosy pair` to authorize the client.

## What's new in 0.2.0

- A unified Servers screen combines saved servers, direct connection, pairing,
  health, and recovery actions.
- Session tabs retain recent pages for faster switching, while roster status,
  activity time, transcript messages, and Observe/Drive controls are clearer.
- File artifacts are isolated by server and native session and include a bounded,
  authenticated Download action.
- Codex takeover failures remain read-only and explain why control was refused;
  accepted Codex renames now propagate across the roster, header, tabs, refresh,
  and restart.
- Windows speech ownership and responsive-layout transitions no longer trigger
  the native crash found during 0.1.0 acceptance.
- OpenCode startup, Pi chronology and runtime readiness, large Codex sessions,
  and broker setup/recovery received reliability fixes.

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
