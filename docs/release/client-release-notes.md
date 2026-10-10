# cosyncing client downloads

These are broker-independent Flutter clients. Install and run the broker first,
then use `cosy pair` to authorize the client.

## Update your client with this release

0.6.4 lets the app drive a Claude Code session. On a Linux or macOS Server, setup
can install a Claude Code mod so the app and your terminal share one session:
prompts, steering and stop work from either side, and Claude's permission and
question prompts arrive as cards you can settle from your phone. Update the
Server first. The mod, the socket it talks to, and the answer detail on a settled
card all come from a 0.6.4 Server; a 0.6.4 client against an older one still
works and simply never sees those prompts.

The other change you notice without opening a session is on Android: an app
update now keeps downloading after you leave Cosyncing, its progress in a
notification, and Android's installer opens when you come back.

The broker contract moves to revision 29 and the compatibility window stays one
revision wide, so a 0.6.0 or newer native client can still drive a 0.6.4 Server.
It draws a settled question card as it always has, without the answer and
attribution this client adds. A native client from 0.5.13 or earlier can watch a
0.6.x Server but cannot drive it: it cannot answer a permission request or send a
prompt. The web client needs nothing: it ships inside the broker package and
always matches it. A 0.4.1 or older client also sits below the minimum accepted
client contract, still revision 17, and stays read-only against current brokers.

## What's new in 0.6.4

- A Claude Code session you are watching answers to the app. Setup offers to
  install a Claude Code mod on Linux and macOS hosts, for Claude Code 2.1.288 or
  newer, and once it is in place the app sends prompts, steers a running turn and
  stops one while you keep the terminal. An approval card leads with the command
  or path and opens to the whole call, and whichever side answers first wins.
  Questions asked with Claude's picker reach the app in `auto` mode too, and the
  app answers each kind the picker asks: one or several choices, typed text, and
  a number within Claude's range. In `bypassPermissions`, `dontAsk`, or a mode
  Cosyncing cannot read, Claude's own dialog keeps answering and the app shows a
  read-only note naming the mode. See
  [Claude true sync](../supported_agents/claude-true-sync.md).
- A settled question card says how it ended: the options picked or checked, any
  typed answer, and whether you answered it in the app or in your terminal. A
  question closed with nothing picked, by Escape in the terminal or Stop in the
  app, says it was closed without an answer.
- The mode and model shown for a Claude session you are watching keep up. A turn
  answered by another model updates the model while the session runs, and a
  subagent's model or mode is no longer shown as the session's.
- An Android update keeps downloading after you leave the app, with its progress
  in a notification, and Android's installer opens when you come back.
- Progress bars fill over a visible track. The Android download, the context bar
  in a session's details and the artifact preview's loading bar all drew full
  from the start.
- The server switcher at the bottom of the sidebar switches servers. It used to
  close the menu and leave you where you were; now it moves, and says so when a
  server can no longer be selected.
- Opening the app at an address it has no page for shows a page in your language
  with one button to Sessions, instead of an English-only error whose Home button
  led nowhere.
- A Codex session whose model no longer matches its profile no longer offers a
  terminal-sync command that would silently relabel it. Driving that session from
  Cosyncing still works.
- When an agent records a session detail this version of Cosyncing does not
  recognize, you get one inbox note naming it rather than the detail silently
  missing from the transcript.
- DeepSeek Harness hosts on the 0.2 contract sign in once, with
  `cosyncing dsh connect`, and a session tab that goes offscreen releases its
  live transport and reattaches when you come back to it, keeping its transcript
  and unsent draft.

The 0.6.0 features that need both ends of the wire, notifications with every
browser tab closed, per-type notification settings and cross-device read and
clear, still need a 0.6.0 or newer Server. 0.6.4 is one.

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
