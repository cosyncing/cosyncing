# cosyncing client downloads

These are broker-independent Flutter clients. Install and run the broker first,
then use `cosy pair` to authorize the client.

## Update your client with this release

0.5.4 adds the client surfaces for four provisional adapters. Update the client
before, or together with, the broker if you want to create and drive Grok Build,
Cline, Kilo Code, or Reasonix sessions from the app.

0.5.4 keeps the minimum accepted client contract at revision 17, so a 0.5.0 or
0.5.1 client still drives a 0.5.4 broker. Those clients do not expose features
introduced by newer contract revisions. A 0.4.1 or older client remains
read-only against current brokers.

Update the client on every device you use before, or together with, the broker.
The web client needs nothing: it ships inside the broker package and always
matches it.

## What's new in 0.5.4

- Grok Build 1.0.13 or newer supports app-created sessions, resume, queued
  prompts, approvals, commands, model/effort/mode controls, cancel, context
  display, and shared cross-client Drive. Older builds remain Observe-only.
- App-created Cline sessions use an isolated broker-owned Hub for Create,
  Resume, Stop, approvals, model/mode selection, live output and usage, and
  native rename. Default-profile and subagent sessions remain read-only.
- Kilo Code 7.4.23 or newer supports app-created sessions, prompt/cancel,
  approvals, model selection, native rename, live status, tokens, and cost.
- Reasonix 1.25.2 supports durable create/load, queued prompts, reasoning and
  answer streaming, approvals, and single-writer Drive.
- Composer drafts survive navigation and reconnects. Session creation waits for
  adapter readiness, and a partial roster remains usable while slow discovery
  lanes finish.
- The Usage report no longer treats a finished period as live when the device
  clock or time zone differs from the report window.

For these features, use a 0.5.4 client with a 0.5.4 broker.

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
