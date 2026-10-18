# cosyncing client downloads

These are broker-independent Flutter clients. Install and run the broker first,
then use `cosy pair` to authorize the client.

## Update your client with this release

0.7.0 adds file previews. The files panel shows images, PDFs and videos in
place, and native clients can hand a workspace or delivered file to another app
with **Open with**. Scrolling back through a long session with tool calls
hidden keeps loading earlier messages, and file cards stay beside the messages
that created them after a reconnect.

Image, PDF and video previews need a 0.7.0 Server, which issues the
short-lived link a preview loads from. The broker contract moves to revision
32 and the minimum accepted client revision stays 17, so a 0.6.x native client
still drives a 0.7.0 Server. The web client ships with the broker and always
matches it. A 0.7.0 Server also uses negotiated compression for large session
updates and responses, and refreshes the session list on one shared 15-second
cadence instead of rescanning every session.

The Server now needs Bun 1.3.14, up from 1.3.8. A 0.6.6 Server installed with
the signed installer gets it from `cosy update`, which installs Bun 1.3.14
before switching to 0.7.0 and restores the previous broker and runtime
together if the new broker fails its health check. A Bun you chose with
`COSYNCING_BUN_BIN` is never replaced; upgrade it first. A Server on 0.6.5 or
earlier with an older Bun refuses this update without changing anything:
re-run the installer instead.

npm distribution ended at 0.6.6. A Server installed from npm keeps running but
gets no newer versions there. The shell and PowerShell installers recognize it,
ask before replacing it, and offer to remove the npm package only after setup
succeeds.

## What's new in 0.7.0

- The files panel previews PNG, JPEG, WebP and GIF images with zoom, PDFs with
  page navigation, and MP4, M4V, MOV and WebM videos with playback controls, up
  to 32 MiB, 128 MiB and 2 GiB. Videos play in the app on Android, iOS, macOS
  and the web; on Linux and Windows, **Open with** hands them to your player. A
  preview loads only while its pane is visible and is released when you close,
  hide or background it.
- Native clients offer **Open with** for workspace and delivered files,
  including Word and PowerPoint documents.
- With tool calls hidden, scrolling back through a long session keeps loading
  earlier messages instead of sticking on "Loading earlier messages…" or
  fetching the same page again. When you show tool calls, the message you are
  reading stays in place while they load.
- File cards stay beside the messages that created them after reconnects and
  history refreshes, and old cached files no longer reappear among recent
  messages.
- Subagents started by an open Claude Code or Kimi Code session stay nested
  under it in the session list instead of briefly showing as separate sessions
  each time the parent updates.
- The context meter shows a 1M limit for Claude Code sessions on models with a
  native 1M window, which Claude Code 2.1.300 and later no longer marks.
- A question Claude asks in a session driven from the app becomes answerable
  once Claude is waiting for the answer, so an early answer no longer leaves the
  turn blocked. An answer to a question that is no longer open, for example
  from a second device, is refused instead of sent.
- A question card that asks several questions numbers them.
- An observed Kilo Code session catches up within about two seconds when a
  file-change notification is missed.
- Long-pressing or right-clicking a session tab or roster row opens the rename
  dialog directly. Composer attachments show readable file sizes. The
  notification setup banner keeps phone playback and composer controls
  reachable and its actions readable in light and dark themes.
- Home reuses the session list for its active counts instead of downloading
  every session again.

The subagent nesting, context meter, Claude question and Kilo Code fixes are in
the Server; the others are in the app.

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
