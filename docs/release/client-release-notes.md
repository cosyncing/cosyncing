# cosyncing client downloads

These are broker-independent Flutter clients. Install and run the broker first,
then use `cosy pair` to authorize the client.

## Update your client with this release

0.8.4 adds navigation through earlier user prompts and improves session names,
reconnection, quota cards and server updates. Update your Android or desktop app
for the client changes and update the Server with `cosy update` for the broker
fixes. The web client ships with the Server and always matches it.

The broker contract revision stays at 35, the minimum accepted client revision
stays at 17, and Bun stays at 1.4.3. A 0.8.3 client can still drive a 0.8.4
Server; updating the app adds the new navigation and interface improvements.
Standalone desktop apps offer **Download**. For desktops placed by the
all-in-one installer, quit the app before updating it with `cosy update`.

## What's changed in 0.8.4

- Transcript arrows step through earlier user prompts, including messages
  outside the loaded history. Searches can be canceled or continued, and the
  down arrow returns to live updates without disturbing your draft or focus.
- Session names stay consistent across lists, tabs, detail views and native
  terminals. Renames survive refreshes and restarts, and unnamed conversations
  keep their localized label until a title is available.
- Network changes reconnect sessions and roster updates more reliably. Home
  retains recent quota readings during refresh, and quota cards use independent
  columns with consistent themed surfaces.
- The session menu has a single-click **Hide tool calls** checkbox on narrow
  and wide screens.
- Pi and OMP bridges recover large histories and tool results while retaining
  the running turn. Updated terminals prevent app actions from starting a second
  writer on the same session. Restart or `/reload` open Pi/OMP terminals after
  updating the Server to load the new bridge extension.
- Background tasks in app-driven Claude Code sessions keep running through
  client disconnects, Stop and settings changes. A setting that requires a
  restart is refused while background tasks run.
- Installer-owned Windows servers can apply updates from **Settings → Updates**
  while preserving a running desktop app. Older servers need one terminal
  upgrade to acquire this support. Windows and Linux report update failures
  and completed rollbacks promptly.

For the full list, see the [0.8.4 changelog](../CHANGELOG.md#084--2026-10-26).

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
