# Store listing — English

Field-by-field submission copy. See [`README.md`](README.md) for the rules these follow.

## App name

```text
Cosyncing
```

Publisher/developer name, where a store asks for one separately:

```text
Tokdash
```

## Subtitle / short description

Apple subtitle (30 characters):

```text
Code anywhere, sync everywhere
```

Google Play short description (75 characters):

```text
Code anywhere, sync everywhere — your agents keep working, you keep moving.
```

Microsoft Store short description (241 characters):

```text
Cosyncing puts your running coding-agent sessions on your phone, tablet, and desktop. Read what an agent is doing, answer its permission and question prompts, steer it, and move files — through a broker you run yourself, on your own network.
```

## Promotional text

Apple promotional text (158 characters). Safe to change without review, so keep release-specific
notes here rather than in the description:

```text
Watch Claude Code, Codex, OpenCode, and Pi sessions from anywhere on your own network. No account, no cloud relay — just a broker you run on your own machine.
```

## Full description

```text
Code anywhere. Sync everywhere.
Your agents keep working. You keep moving.

Cosyncing is a self-hosted way to watch and steer the coding agents already running on your own machine. You start the cosyncing broker where your agents live; the app connects to it over your own network and shows every session it can see. Nothing is relayed through a service we operate, because there isn't one.

WHAT YOU CAN DO

• See every session at once. Sessions group by project, each with its own status, agent, model, and last activity, so a glance tells you what is working and what is waiting.
• Catch what needs you. An attention inbox collects the moments that matter — a run finished, a run failed, an agent is waiting on you — instead of making you re-check each session.
• Read the whole conversation. Prompts, answers, and reasoning render properly, with syntax highlighting, and file edits arrive as real diffs rather than walls of text.
• Follow the work, not just the answer. Commands, file reads, searches, and edits appear as structured tool activity with exit codes, durations, and change counts.
• Answer and steer. Permission requests and questions can be answered from the app. Send a prompt, queue the next one, or stop a turn that is going the wrong way.
• Move files both ways. Send files into a session and open what an agent sends back, with transfers you can review and retry.
• Pick up on any screen. Phone, tablet, laptop, or a browser tab — the layout adapts, and a wide screen shows the roster and the conversation together.

SUPPORTED AGENTS

Claude Code, Codex, OpenCode, and Pi. Cosyncing reads the sessions each one already keeps, so existing work shows up without being migrated or recreated. What each agent exposes differs, and the app shows what is actually available for that session rather than a uniform pretence.

PRIVACY AND SELF-HOSTING

• You run the broker. It is a program on your machine, not a service we host.
• Your prompts, transcripts, and files stay on the machines you already trust. They are not sent to us, because there is nowhere for them to go.
• No account and no sign-up. A device is paired to your broker directly, with a QR code or a pairing link, and can be unpaired again.
• No third-party analytics or advertising SDKs are built into the app.

PLATFORMS AND HONEST LIMITS

• The app runs on Android, iOS and iPadOS, macOS, Windows, Linux, and in a browser.
• The broker runs on Linux and Apple Silicon macOS. Windows broker hosting is not supported.
• You need network access from your device to your broker — a home or office network, a VPN, or a private mesh you already use. Cosyncing does not punch through NAT for you and does not provide a relay.
• Notifications arrive while the app is running. This build includes no push service, so it cannot wake a fully closed app.
• A context-window meter is shown for Codex sessions, because Codex is currently the only agent that reports its window size.

Cosyncing is open source under the Apache License 2.0.
```

Character count: 3,009 — within the 4,000-character Apple and Google Play limits.

## Feature bullets

For consoles that take a separate short bullet list:

```text
• Every session grouped by project, with live status
• An inbox for runs that finished, failed, or need you
• Full transcripts with real diffs and structured tool activity
• Answer permissions and questions from your phone
• Send prompts, queue the next one, or stop a turn
• Two-way file transfer with reviewable history
• Claude Code, Codex, OpenCode, and Pi
• Self-hosted: your broker, your network, no account
```

## Privacy / data-safety answers

Short form for a Play Data Safety or Apple privacy questionnaire:

```text
Cosyncing collects no data. The app talks only to a broker the user runs; the developer operates no server and receives no prompts, transcripts, files, or usage data. Broker credentials are stored on the device to keep the user signed in and are removed when the device is unpaired. The app contains no advertising or analytics SDKs.
```

## Supported-agent wording

Reusable sentence where a store wants the integration list inline:

```text
Works with Claude Code, Codex, OpenCode, and Pi sessions on the machine running your broker.
```

## Screenshot captions

Headlines are the locked campaign lines from doc 14. Sub-lines are optional and may be dropped on
narrow store layouts.

| # | Headline | Optional sub-line |
|---|---|---|
| 1 | Every session, one calm view. | Grouped by project, with the status of each. |
| 2 | See what needs your attention. | Finished, failed, or waiting on you. |
| 3 | Read, steer, and approve. | Full transcripts, real diffs, real commands. |
| 4 | Move files. Inspect artifacts. | Send files in; open what comes back. |
| 5 | Pair with your own broker. | Your machine, your network, no account. |
| 6 | One workspace, every screen. | Phone, tablet, desktop, browser. |

## What must not be claimed

Kept here so a later edit does not reintroduce a claim the product cannot support:

- no terminated-app remote wake, push delivery, or background wake-up;
- no zero-configuration remote access, NAT traversal, hosted relay, or tunnel;
- no Windows or Intel Mac broker host;
- no universal context-window meter;
- no interactive execution of agent-produced artifacts;
- no claim that every agent supports every listed capability identically.
