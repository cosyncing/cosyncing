# cosyncing client downloads

These are broker-independent Flutter clients. Install and run the broker first,
then use `cosy pair` to authorize the client.

## Update your client with this release

0.6.5 opens files from the conversation. A filename or workspace link in a
report, including one inside a table or inline code, opens the file, and
selected text offers Find file in workspace. Delivered Markdown, HTML, source
and other text files open beside the conversation, and on a wide landscape
screen Status and Files sit as tabs in the right panel. Update the Server
first: searching the workspace for a bare filename needs a 0.6.5 Server, while
a link that carries the file's path still opens against an older one.

The broker contract moves to revision 30, which adds that file search and
nothing else, and the compatibility window stays one revision wide, so a 0.6.4
native client can still drive a 0.6.5 Server. A native client from 0.5.13 or
earlier can watch a 0.6.x Server but cannot drive it: it cannot answer a
permission request or send a prompt. The web client needs nothing: it ships
inside the broker package and always matches it. A 0.4.1 or older client also
sits below the minimum accepted client contract, still revision 17, and stays
read-only against current brokers.

On a Server installed with the signed one-line installer, `cosy update` now
updates the desktop client too, after asking you to quit it. On Windows and
macOS, a client installed by 0.6.4 or earlier needs the new all-in-one
installer once before `cosy update` can take it over.

## What's new in 0.6.5

- Workspace file links and filenames in reports open the file. Ctrl/Cmd-click
  and Find file in workspace use the same lookup, show a chooser when a name
  matches more than one file, and say when the search stopped early.
- Delivered Markdown, HTML, source code and other supported text files open
  beside the conversation, with Download still available.
- On wide landscape screens, Status and Files open as session tabs in the right
  panel, with the Files explorer beside the opened previews. Portrait and
  smaller layouts keep the main session view, and resizing a portrait Status or
  Files view keeps that view open.
- Right-click or long-press a session tab or roster row to rename the session.
- The activity band counts what is running, paused, failed and done instead of
  showing a bare "+N". Running work leads, oldest first; finished work follows,
  newest first, and folds behind its count while anything still runs. Dismiss
  one card from the expanded list, or every finished card with Clear finished.
- Workspace dividers can use the whole window width, token counts use compact
  k, M and B units, and the transcript filter is named Hide tool calls. Hiding
  tool calls keeps delivered files and their Open and Download actions visible.
- A Claude session whose background agents are still running reads Working in
  the roster again, and the agents' rows say which ones are still working. The
  app no longer offers Stop or queues a prompt behind a turn that has already
  ended. A Claude session synced through the mod shows Working when you open it
  mid-turn.
- A Codex session you reopen keeps each reply under its own prompt after a
  stopped turn, and its history shows each command's exit status. A terminal
  can join a Codex session the app is running without interrupting it.
- An agent card with nothing more to show no longer opens onto a "remains live"
  placeholder, and delivered filenames stay readable in narrow conversations and
  on phones.

The 0.6.0 features that need both ends of the wire, notifications with every
browser tab closed, per-type notification settings and cross-device read and
clear, still need a 0.6.0 or newer Server. 0.6.5 is one.

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
