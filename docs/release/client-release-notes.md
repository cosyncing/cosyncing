# cosyncing client downloads

These are broker-independent Flutter clients. Install and run the broker first,
then use `cosy pair` to authorize the client.

## What's new in 0.4.0

- Two more agents appear alongside Claude Code, Codex, OpenCode, and Pi. Both
  are provisional, and both need a broker running 0.4.0.
- **Kimi Code**: every session on the local `kimi web` server is discoverable and
  observable, whoever started it. Sessions cosyncing created are drivable —
  prompts, approvals, question replies, interruption, model selection — a
  session it did not create can be taken over explicitly, and Drive can be handed
  back to the terminal. File and image input are not implemented yet.
- **DeepSeek Harness**: session discovery, history, and shared foreground
  control against a `dsh web` host, with model and reasoning-effort selection,
  permission presets, the host's own commands, and image attachments. General
  file attachments are unavailable because the host accepts image content only.
- Neither host needs a terminal left open. An installed broker service starts,
  supervises, and stops a host it owns; one you started yourself is never
  stopped, replaced, or reconfigured.
- The client no longer offers a control the session cannot grant, and a session
  whose attach mode it cannot decode stays read-only instead of arming Drive on
  a guess. The broker enforces that rather than trusting the client.

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
