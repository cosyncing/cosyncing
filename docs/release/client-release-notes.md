# cosyncing client downloads

These are broker-independent Flutter clients. Install and run the broker first,
then use `cosy pair` to authorize the client.

## What's new in 0.4.1

- **Claude Code:** take-over resumes the existing session instead of forking
  it. A prompt accepted while Claude is busy keeps its queued row through a
  reload, and another authorized client can join the broker's existing Claude
  Drive without starting a second writer.
- **Kimi Code:** file and image attachments, `/goal` and skill commands,
  session rename, and a copyable resume-in-terminal command are available from
  the session UI. Images echo inside the sender's message, model names come from
  the server, and server-authored harness rows no longer trigger a false
  foreign-writer demotion.
- **DeepSeek Harness:** model selection is available during session creation;
  foreground subagent and workflow runs show live activity; subagent sessions
  nest under their parent; and the selected model and permission mode appear as
  soon as the session attaches.
- The expanded task list is taller, uses transcript body text, and stays visible
  until you archive it. Finished cards no longer disappear after three seconds.
- Windows no longer leaves Ctrl latched after Ctrl+Win+Arrow, which previously
  made the next plain wheel gesture change text zoom.
- Claude and Kimi session rows show provider-authored model names, including
  Claude Fable and the Kimi server's display names.

For the complete behavior above, use a 0.4.1 client with a 0.4.1 broker.

## Known issue

Codex transcript events can still appear slightly out of order in some
multi-client sessions. This release does not claim to resolve that separate
ordering and compare-and-swap investigation.

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
