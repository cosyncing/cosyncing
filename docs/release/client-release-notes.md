# cosyncing client downloads

These are broker-independent Flutter clients. Install and run the broker first,
then use `cosy pair` to authorize the client.

## Update your client with this release

0.5.0 raises the minimum client the broker accepts. A 0.4.1 or older client
cannot drive a 0.5.0 broker: the pairing negotiates read-only and session
controls stay disabled. This is deliberate — the broker no longer accepts the
public artifact download capability older clients rely on — and it cannot be
worked around from the server side.

Update the client on every device you use before, or together with, the broker.
The web client needs nothing: it ships inside the broker package and always
matches it.

## What's new in 0.5.0

- **Antigravity (`agy`) is a supported agent.** Conversations are discovered
  from the CLI's own store and replayed read-only; `?mode=resume` drives one
  through a broker-owned `agy` child that starts on the first prompt rather than
  on attach. Two clients can share one Drive, and a write from a terminal
  releases the session back. New sessions can be created from the app with a
  directory and model, and model selection reads the CLI's live catalog, so a
  model with reasoning efforts offers low, medium, and high instead of a fixed
  variant.
- **Pi:** `ask_user` prompts now appear in both the native terminal and
  cosyncing — the first answer closes the other surface, and the terminal stays
  usable when the broker is unavailable. New Pi sessions expose the model's
  native thinking levels and apply the selected level at creation.
- **Connectivity is transport-agnostic.** The broker has a strict loopback-only
  listener and no longer configures, diagnoses, repairs, or removes remote
  connectivity. Operator-owned proxy and tunnel guides, including Tailscale
  Serve, EasyTier, and WireGuard, live under `docs/connectivity/`.
- **Kimi Code:** subagent sessions appear in the roster as observe-only child
  rows under the session that spawned them. A detached child still writing its
  journal shows as working and keeps its parent marked working.
- **Roster:** subagent subtrees start closed. The parent row keeps its
  linked-session count, opening one is remembered per parent, and a search still
  reveals a matching child. Kimi and DeepSeek Harness rows show their model
  before the session is opened.
- Japanese, Korean, and Spanish UI locales, with typed connection, session, and
  schedule errors rendering in the active locale.
- Keyboard shortcuts drive the session workspace, and file paths in tool cards
  are clickable — a mention opens the session's Files tab at that file.

For the complete behavior above, use a 0.5.0 client with a 0.5.0 broker.

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
