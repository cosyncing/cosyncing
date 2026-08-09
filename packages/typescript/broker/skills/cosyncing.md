---
name: cosyncing
description: "Interact with the user's cosyncing app: deliver generated files and artifacts to the user's phone or browser."
---

This skill covers interactions with the user's cosyncing app.

## Send a file to the user

Use the agent's native, session-bound file-delivery tool when one is available:

- OpenCode: `send_file`
- Pi: the cosyncing bridge `send_file` action

Pass the finished workspace file to that tool. The integration binds delivery to
the exact broker, agent, and native session before cosyncing surfaces it.

Do not place files in `<cwd>/.cosyncing/outbox/`; it is shared by every session
using that directory and is not a safe ownership channel. If no native
session-bound delivery tool is available (including Claude Code and Codex
today), tell the user that direct artifact delivery is unavailable and leave
the file in the workspace. Claude transcripts that already contain a native
`SendUserFile` result can still be rendered, but the local CLI/Drive session
does not currently expose that tool for this skill to call.
