# cosyncing client downloads

These are broker-independent Flutter clients. Install and run the broker first,
then use `cosy pair` to authorize the client.

## Update your client with this release

0.8.1 repairs two regressions in 0.8.0 that left sessions hanging when a
server is reached through an HTTPS reverse proxy such as Tailscale serve. The
web client served through such a proxy opens sessions again, and native clients
open sessions again on an HTTPS address that has no explicit port, such as
`https://host.example`. Nothing else changes: there are no new features, the
broker contract revision stays at 35, and the minimum accepted client revision
stays at 17.

Both fixes are needed. The web client fix lives in the Server, so update the
Server first with `cosy update`; the web client ships with the broker and always
matches it. The native fix lives in this client, so a 0.8.0 native client keeps
reconnecting to a proxied HTTPS address until you install this download. Bun
stays at 1.4.3 and nothing else about the Server moves.

A desktop update in this release still ends in a **Download**, or in
`cosy update` for a desktop the all-in-one installer placed. Update the Server
first with `cosy update`; the app then offers the 0.8.1 download.

## What's fixed in 0.8.1

- The web client served through an HTTPS reverse proxy opens sessions again.
  0.8.0 refused its requests because the page's HTTPS origin differed from the
  plain HTTP address the Server saw. Trusted browser origins now only grant
  cross-origin access; they no longer block other requests.
- Native clients open sessions again on an HTTPS address without an explicit
  port. 0.8.0 rejected the session socket's implied port 443 as a different
  destination and kept reconnecting.

For everything else that changed since 0.7.2, see the 0.8.0 section of the
changelog.

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
