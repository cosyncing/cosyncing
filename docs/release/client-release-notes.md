# cosyncing client downloads

These are broker-independent Flutter clients. Install and run the broker first,
then use `cosy pair` to authorize the client.

## Update your client with this release

0.8.0 lets one saved server keep several approved addresses, and native clients
can reach them through an HTTP or SOCKS5 proxy profile kept on that device.
Settings now separates what this device stores (cache and downloaded copies)
from what the server stores, and server cleanup is an owner-authorized job that
keeps its identity across reconnects and restarts. HTML previews run their own
scripts by default.

Server addresses and server-side cleanup need a 0.8.0 Server. The broker
contract moves to revision 35 and the minimum accepted client revision stays
17, so a 0.6.x or 0.7.x native client still drives a 0.8.0 Server. The web
client ships with the broker and always matches it.

The Server now needs Bun 1.4.3, up from 1.3.14. A Server installed with the
signed installer on 0.6.6 or later gets it from `cosy update`, which installs
Bun 1.4.3 before switching to 0.8.0 and restores the previous broker and runtime
together if the new broker fails its health check. A Bun you chose with
`COSYNCING_BUN_BIN` is never replaced; upgrade it first. A Server on 0.6.5 or
earlier refuses this update without changing anything: re-run the installer
instead. The new Bun stops buffering a download eagerly when the receiver
pauses, so large files keep bounded memory while active files stay protected
from cleanup.

A desktop update in this release still ends in a **Download**, or in
`cosy update` for a desktop the all-in-one installer placed. The signed release
enables in-place replacement for no platform yet, so the app offers the
download instead of replacing itself.

Update the Server first with `cosy update`; the app then offers the 0.8.0
download.

## What's new in 0.8.0

- A saved server can keep several approved addresses under one identity, with
  Automatic or Fixed selection and readiness checks. Native clients add
  device-local HTTP or SOCKS5 proxy profiles; the browser client uses
  browser-managed networking and explains the bindings it cannot honor.
- Storage separates device cache and downloaded copies from owner-authorized
  server cleanup. File review uses measured snapshots, accepted cleanup jobs
  survive reconnects and restarts, and a removed server artifact leaves a
  non-actionable entry in the conversation.
- Status and error details open from a contextual gesture or the keyboard and
  copy a bounded, sanitized snapshot.
- Select several session and file tabs with Ctrl/Command or Shift and close the
  group with the workspace close shortcut. Undo restores the tabs in order;
  sessions keep running.
- Workspace Overview can show the quota providers you pick on this device, with
  remaining limits and reset times. Usage opens on Day, shows cost beside
  tokens and share in every ranking, and drops the integrations catalog and CSV
  export.
- HTML previews run self-contained scripts by default and keep visible state
  across ordinary updates, releasing execution when hidden or backgrounded.
  Source and Rendered controls remain, remote resources stay blocked, and
  incomplete HTML stays in Source.
- Hiding and unhiding a session responds immediately while the broker saves it;
  Undo does too, and a failed change restores the broker's state with an error.
  The hidden notice dismisses itself and has a close button.
- Subagent sessions, including Codex Guardian reviews, no longer raise
  notifications or count as running or waiting work on Home. Their activity
  stays in the roster and transcript.
- New Codex sessions apply the app's permission default before their first
  prompt, including in untrusted folders, and approval cards show the outcome
  without naming the client that resolved it.
- Codex structured terminal question replies settle their cards after a
  reconnect, and Cline and Grok recover from a failed filesystem watcher
  without leaving session updates stuck.
- Typing an answer to an inline question on a phone keeps the main prompt
  composer out of the answer area and keeps its draft.
- Settings choices highlight only the selected value, dropdowns match their
  button width, and General settings use standard row typography. Updates opens
  from General settings and names the app and server actions, and its
  confirmation sheets show versions and installation effects first.
- Narrow session navigation uses Chat and Files icons, and the mobile session
  menu has one Hide tool calls checkbox. New-session agent choices show logos
  without a search field, and Send shows its shortcut in the tooltip.
- Android QR pairing keeps the ML Kit classes that optimized release builds
  were stripping, which fixes a scanner error after camera permission is
  granted.

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
