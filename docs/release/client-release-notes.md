# cosyncing client downloads

These are broker-independent Flutter clients. Install and run the broker first,
then use `cosy pair` to authorize the client.

## Update your client with this release

0.8.3 fixes a Server problem with Codex custom profiles: when the app attached
to a session the Server still had loaded, that session kept the model it was
actually running instead of being reset to the base configuration's default
model. Nothing in the app itself changes, so this client carries the version
bump and the same behaviour as 0.8.2. The broker contract revision stays at 35,
the minimum accepted client revision stays at 17, and Bun stays at 1.4.3, so a
0.8.2 client keeps driving a 0.8.3 Server.

Get the fix by updating the Server with `cosy update`: that is where it lives,
and the web client ships with the Server and always matches it. A desktop client
update still ends in a **Download**, or in `cosy update` for a desktop the
all-in-one installer placed, once the Server is on 0.8.3.

## What's fixed in 0.8.3

- Loaded Codex custom-profile sessions keep their live model when the app
  attaches, instead of resetting to the base configuration's default model.
  Sessions you start fresh keep the profile model you picked, as they did in
  0.8.2.

Android, Linux, macOS and Windows downloads are otherwise the 0.8.2 app: install
this release if you want every part of your setup on the same version number.
For everything else that changed, see the 0.8.2 section of the changelog.

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
