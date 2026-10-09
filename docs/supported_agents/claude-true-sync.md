# Claude true sync

True sync is the cosyncing integration for a Claude Code session that you keep
running in your own terminal. The session stays yours: you type in the
terminal, Claude answers in the terminal, and cosyncing mirrors the same
session so a paired device can read it, send a prompt, stop a turn, and answer
a permission or question prompt. Nothing is started by cosyncing and no second
copy of the session is created.

This page covers how the integration works, the permission rule it follows, and
how to install, refresh, or remove it. For the versions cosyncing expects and
the general Claude Code setup steps, see [Claude Code](claude-code.md).

## What you need

- Claude Code 2.1.288 or newer. Below that version cosyncing does not offer the
  integration at all, and the session keeps the Observe and Take over behaviour.
- A cosyncing broker on Linux, including WSL, or macOS. A broker on native
  Windows does not offer true sync; those sessions keep Observe and Take over.
- A cosyncing client connected to that broker. Prompts and approvals are only
  offered to a device that is actually watching the session.
- An interactive session you started yourself in a terminal. A `claude -p` run
  is mirrored read-only, and sessions cosyncing creates are driven by cosyncing
  already and do not use this path.

## How it works

Setup writes a small Claude Code mod into a directory cosyncing owns under the
broker's state directory, and then asks Claude's own plugin commands to add that
directory as a marketplace and install the mod from it. cosyncing never edits
Claude's files directly. Claude records the install itself, in two places in its
configuration directory: two keys in its settings file
(`extraKnownMarketplaces.cosyncing` and
`enabledPlugins["cosyncing-claude@cosyncing"]`), and its own plugin records in
`plugins/known_marketplaces.json` and `plugins/installed_plugins.json`.

The mod registers each session with the broker over a private Unix socket named
`claude-mod.sock`, in the same state directory as the broker's own state:
`~/.cosyncing/claude-mod.sock`, or `$COSYNCING_HOME/claude-mod.sock` if you moved
the state directory. The socket is filesystem-protected, the broker accepts a
connection only from its own user, and it identifies the Claude process on the
other end from the operating system rather than from anything the mod claims.
The socket is not part of the broker's HTTP port, so exposing the broker to your
devices does not expose it.

Setup writes the broker's socket path into the copy of the mod it installs, so
a terminal finds a broker whose state directory you moved with `COSYNCING_HOME`
even when that terminal does not export `COSYNCING_HOME` itself. The mod looks
for the socket in this order:

1. `COSYNCING_CLAUDE_SOCK`, an override for testing a second broker. It must be
   an absolute path. A relative value turns the mod off in that terminal rather
   than falling back to the paths below, and a broker started with a relative
   value does not open its socket.
2. The path setup wrote into the installed mod.
3. `$COSYNCING_HOME/claude-mod.sock`.
4. `~/.cosyncing/claude-mod.sock`.

A socket path longer than 100 bytes is more than the mod can dial. Setup does
not write such a path, and the broker does not open the socket, so true sync
stays off on that installation.

While the session runs, the mod keeps one request open to the broker. The broker
uses that channel to send a prompt, a stop request, or an answer when one
arrives, and the mod reports turn and tool events back. A session whose mod stops
reporting stops advertising true sync within about a minute and returns to
Observe.

One session has one synced terminal. If a second terminal opens the same
session, for example with `claude --resume` while the first is still running,
the terminal that registered with the broker first keeps it. After a broker
restart both register again, and whichever reaches the new broker first keeps
the session; that is by design, not a fault. The other terminal stays in
Observe: it holds nothing, draws no buttons, and is synced in its place once
the first terminal's Claude exits or stops reporting.

In the app, a synced session is marked as live and has no attach action, because
there is nothing to attach: the terminal already holds the session. A message you
send while a turn is running appears in the transcript as a steering row, so it
reads differently from what you typed in the terminal.

## The permission rule

An approval reaches the app only when all of these are true at the moment Claude
asks:

- the session's permission mode, read from the session's own transcript, is
  `default`, `accept edits` or plan;
- at least one cosyncing client is viewing that session;
- cosyncing's own true-sync switch is on.

A question Claude asks you with its picker reaches the app under the same rules,
and in auto mode too, because auto mode decides tool calls, not your answers.

The app answers each kind of question the picker asks: one choice, which also
takes your own words the way the picker's "Other" does; several choices; typed
text; and a number, written plainly and inside the range Claude gave. Your
answer reaches Claude spelled exactly as its picker would have spelled it, so a
choice whose label contains a comma or a quote is still one choice. An answer
can be up to 8,192 characters, Claude's own limit. A question the app cannot
answer the way the picker would, such as a number with no range or a label that
begins or ends with a space, is shown read-only and answered in your terminal.
A preview Claude draws beside a choice is shown only in the terminal.

Otherwise the broker answers the request immediately with a reason and Claude's
own dialog stays on your screen. The app shows a short read-only note with that
reason instead of buttons, so you can tell the difference between "nobody
answered this" and "this was never offered". The note names the mode it read,
because "not held" is not information and "you were bypassing permissions" is.

An approval card shows what the call would do, such as the command or the file
path, shortened, and opens to the whole call under **Show details**: every
argument, such as the rest of a long command or an edit's old and new text, up
to 8,000 characters. An app from an earlier release, which does not draw the
short line, shows the same full text under its details, so no app asks you to
approve a call without showing it.

Newer Claude versions show the default mode as "manual" (`manual mode on`).
That is a label, not a separate mode: the transcript records it as `default`, so
a session in manual mode is held exactly like one in `default`.

In plan mode, a tool call Claude asks you about is held like one in `default`.
Claude's plan itself is shown in the app read-only, with the whole plan under
**Show details**: approving a plan in Claude's dialog also chooses how Claude
carries on, accepting edits or asking about each one, and that choice exists
only in the terminal. You answer the plan there.

The other modes are left alone:

- in auto mode, Claude's classifier decides tool calls. cosyncing does not take
  its seat and shows nothing in the app for them;
- in `dontAsk` mode, Claude refuses anything that would need asking, questions
  included, so nothing is held and nothing is shown;
- in `bypassPermissions` mode, a prompt Claude still shows stays in your
  terminal, with a read-only note in the app;
- a mode cosyncing cannot read, including a mode name it does not know, is left
  alone too, with the same kind of note.

If you switch a session between modes, the rule follows, with no restart needed
on either side. cosyncing reads the mode from the session's transcript, the only
place Claude records it. Claude records the mode with each prompt you send, not
when you press Shift+Tab, so a mode you switch to is read from the next prompt
you send in it, and the app's mode label changes then too. Until then a prompt
is judged by the mode recorded before: it can reach the app in a mode that would
not have sent it there, or stay in your terminal in one that would. Either way
you answer it yourself; cosyncing never answers on your behalf.

Approving a plan moves Claude out of plan mode into the mode you chose in its
dialog, but it may not record that mode. Some Claude versions record it as soon
as you approve, and cosyncing reads it from there. When none is recorded,
cosyncing treats the mode as unread from then until your next prompt: approvals
stay in your terminal with a read-only note, and the app shows no mode.

The on-screen buttons in your terminal appear only after the broker has said
this one is worth holding, so a call in a mode cosyncing leaves alone, a plan, a
session nobody is watching, and a session whose broker is down never show
buttons that were never going to be answered.

To press one of those buttons from the keyboard, press Ctrl+X, then Tab, to move
to them, then the button's number. A number typed while your prompt has the
keyboard goes into your message instead.

Two more rules govern a held request:

- it has no deadline. Like Claude's own dialog, it waits for as long as you
  take, because either side can answer the whole time. It goes back to Claude's
  dialog in your terminal when you choose that dialog from the on-screen
  buttons, when the turn ends or you interrupt it, or when the broker stops
  answering. If the terminal itself goes away, the card in the app closes within
  about 15 seconds. A late answer from either side is dropped rather than
  applied to the next tool call;
- you can always answer in the terminal instead, including by cancelling the
  request. Whoever answers first wins, and the other side's card closes.

cosyncing does not retry, override, or route around a deny rule or an auto-mode
decision. Those outrank it by design, and the result shows in the app.

## Installing it

`cosyncing setup` asks whether to install the mod, with yes as the default. It
is offered only on a supported host with a new enough Claude Code, and the plan
shows the exact directory it will write and the fact that Claude performs the
install.

You can answer on the command line instead, in an interactive run or together
with `--yes --accept-managed-runtime-ownership`:

- `cosyncing setup --install-claude-mod` is an explicit yes. It installs the
  mod in that same run, also after an earlier decline or after you removed the
  mod inside Claude.
- `cosyncing setup --no-install-claude-mod` is an explicit no. It also removes
  a mod that is installed.

Setup refuses the two flags together. With neither, an interactive run asks,
and a plain `--yes` keeps the choice you made before: a decline stays declined,
and a mod you removed inside Claude stays removed. On a machine that has never
been asked, `--yes` installs it.

Declining is remembered. A later `cosyncing repair` or `cosy update` does not
install the mod behind your back. To install it later, run
`cosyncing setup --install-claude-mod`.

Setup skips the mod, with a stated reason, when:

- the broker runs on native Windows;
- the `claude` command is not on the broker's PATH;
- Claude Code is older than 2.1.288;
- `CLAUDE_CONFIG_DIR` is a relative path, which Claude would resolve against
  whichever directory a session starts in. Set it to an absolute path and rerun
  setup;
- Claude's own settings file cannot be read as JSON;
- Claude's managed settings restrict where a mod may come from or switch hooks
  off: `strictKnownMarketplaces`, `allowManagedModsOnly`,
  `allowManagedHooksOnly`, `disableAllHooks`, or `disableSideloadFlags`. Setup
  reads the managed settings file, its `managed-settings.d` drop-ins, and the
  server-delivered managed settings Claude keeps in its configuration directory
  before it asks you anything, and the reason it prints names the key it found.
  cosyncing does not try to talk its way past an organisational rule;
- a managed settings file exists but cannot be read. An unreadable policy is
  not taken as permission.

The mod is never the reason setup fails. If Claude's own install command
refuses the mod anyway, for a policy setup could not see or for any other
reason, or it times out, or it answers with something setup cannot read, setup
puts the mod step back the way it was and finishes everything else. It prints
Claude's answer and the command to run once Claude will accept the mod,
`cosy doctor` repeats them, and the next setup tries again.

## Refreshing and removing it

`cosy update` refreshes the mod with the broker, so the mod you run matches the
broker you upgraded to, but only a mod that is installed and switched on in
Claude. A mod you switched off or removed inside Claude, or declined in setup,
stays as it is. Once the new broker is in place, the update stages the new copy
of the mod and asks Claude to take it. If Claude refuses, times out, or answers
with something cosyncing cannot read, the previous copy is put back and keeps
working. That never fails the update: it completes, its message says the mod
was not refreshed and tells you to run `cosyncing setup`, and `cosy doctor`
repeats what is left to do. `cosyncing setup` refreshes an older mod the same
way.

`cosyncing setup --no-install-claude-mod`, `cosyncing uninstall`, and a rollback
remove only what cosyncing wrote: its marketplace directory, and the settings
keys and plugin records Claude made for it, which Claude's own
`claude plugin uninstall` and `claude plugin marketplace remove` take back.
Anything else you have installed or configured in Claude is left alone. If
cosyncing finds a marketplace entry it did not create, it reports that instead
of removing it.

If Claude's commands cannot finish that reversal, because no `claude` command
runs, one times out, or one answers with something cosyncing cannot read, the
rest of the removal still goes ahead. The output names what was left behind
and the commands that remove it, and `cosy doctor` repeats them:

```bash
claude plugin uninstall cosyncing-claude@cosyncing
claude plugin marketplace remove cosyncing
```

When you use `CLAUDE_CONFIG_DIR`, the printed commands set it. Depending on how
far Claude got, cosyncing's own directory may stay as well, and the output then
says how to remove it.

`cosy doctor` reports the state as `state.claude-mod`:

- installed and current;
- older than the broker, which the next setup refreshes;
- switched off inside Claude, which only Claude's own plugin settings switch
  back on;
- removed inside Claude, with both ways forward: run
  `cosyncing setup --install-claude-mod` to use it again, or
  `cosyncing setup --no-install-claude-mod` to finish the removal;
- declined while its files are still there;
- requested but missing;
- not on offer on this host while its files are still there;
- a marketplace entry cosyncing did not write;
- files cosyncing cannot prove are its own, which neither setup nor uninstall
  overwrites.

A mod step that did not finish is reported on its own line,
`state.claude-mod.last-outcome`, with the commands that finish it.

## Turning true sync off without uninstalling

The broker has its own switch in its `config.json`
(`~/.cosyncing/config.json`, or `$COSYNCING_HOME/config.json` if you moved the
state directory), and it is the one cosyncing obeys. It does not read Claude's
settings for this decision:

```json
{
  "features": {
    "claudeTrueSyncMod": false
  }
}
```

Then `cosy restart`. A broker that starts with the switch off does not open the
mod socket at all, so no terminal can register with it. Every Claude session is
mirrored read-only in Observe and can be taken over, Claude's own dialog answers
every permission prompt at once, the terminal draws no cosyncing buttons, and
the app shows no card or note for those prompts. Turning true sync back on also
takes a `cosy restart`.

The broker also reads the setting again while it runs, within a second of a
change, but a change made without a restart reaches only the approvals:

- switched off, the broker stops holding at once. A permission prompt goes
  straight to Claude's dialog, and an app viewing the session shows a read-only
  note that true sync is switched off. The mod learns of it on its next poll,
  within about twenty seconds, and stops asking, so the terminal draws no
  buttons. Prompts, steering and stop keep reaching the session until the next
  restart, which closes the socket as above;
- switched back on, while the socket is still open, the broker holds again at
  once, and the mod asks again from its next poll.

A `config.json` the running broker cannot read or parse counts as the switch
being off: nothing is held until the file is fixed.

Your terminal has its own switch: run Claude with `COSYNCING_CLAUDE_DISABLE=1`
and the mod does nothing at all in that session. It does not register, poll,
hold, or draw buttons, whatever the broker's setting says, so the session is
plain Claude and the app mirrors it read-only, like a session without the mod.
It is per terminal, needs no change to the broker, and is the one to reach for
when you want plain Claude in one window and true sync in another.

## When something is wrong

The rule for this whole feature is that a problem costs you the extra control
and never breaks your session. Every failure path ends in ordinary Claude:

| Situation | What you see |
| --- | --- |
| The mod is not installed, or was declined | Ordinary Observe and Take over. Nothing else changes. |
| The mod stopped reporting | The synced marking disappears within about a minute. A process that has really gone raises one attention event for the session, not one per poll. |
| The broker is down or unreachable | The mod asks nothing, draws nothing, and Claude's own dialog opens at once. |
| Claude Code is older than 2.1.288 | No mod and no sync claim. Setup names the version floor as its reason, and `claude update` plus a rerun of setup gets the offer back. |
| Claude's policy blocks the install, or a managed settings file cannot be read | Setup skips the mod with a reason that names the managed setting it found, or says the file could not be read, and completes. |
| Claude's own install or refresh command fails anyway, times out, or answers unreadably | Setup and `cosy update` still complete. The mod step is put back as it was, the output names Claude's answer and the command to finish, `cosy doctor` repeats it, and the next setup tries again. |
| No client is watching the session | The prompt stays in your terminal, with a read-only note in the app. |
| The session is not an interactive terminal, such as a `claude -p` run | The broker keeps it in Observe: the app mirrors it read-only, sends it no prompts, and nothing is held. |
| The permission mode cannot be read yet, or a plan was approved since the last prompt | Approvals are never held; everything else still syncs. |
| The session is in plan mode and Claude presents its plan | The plan as a read-only card in the app, and Claude's plan dialog in your terminal, where you approve it. |
| The session is in auto mode | Tool calls are left to Claude's classifier, with nothing in the app. Questions are still answered from either side. |
| The session is in `dontAsk` mode | Nothing is held and nothing is shown: Claude refuses what would need asking. |
| The session is in `bypassPermissions` mode | A prompt Claude still shows stays in your terminal, with a read-only note in the app naming the mode. |
| A tool call is denied by a Claude rule or by auto mode | The denial stands and is surfaced in the app. cosyncing does not re-ask. |
| cosyncing's own switch was off when the broker started | No mod socket, so no terminal syncs: Observe and Take over, Claude's own dialog for every prompt, and no card or note in the app. |
| cosyncing's own switch is turned off while the broker runs | No holds and, from the mod's next poll, no on-screen buttons. A prompt released by the switch shows a read-only note that true sync is off. Prompts, steering and stop still sync until the broker restarts. |
| cosyncing's `config.json` cannot be read or parsed while the broker runs | Counted as the switch being off: nothing is held. |
| The terminal runs Claude with `COSYNCING_CLAUDE_DISABLE=1` | Plain Claude in that terminal: no registration, no holds, no buttons. The app mirrors the session read-only. |
| Claude recorded a session detail this version of cosyncing does not recognize | The rest of the session shows normally. You get one inbox note per session for each kind of detail, naming it, never one per occurrence, and it does not come back once you have read it. |

A tool call cosyncing stops waiting on, because the broker stopped answering or
the terminal went away, is left to your terminal rather than answered on your
behalf, and a cosyncing answer that arrives too late to be usable is dropped and
logged instead of being applied to something else.

## What true sync does not do

- It does not change sessions you start from the app with Take over. Those run
  Claude in its headless mode, as before, with approvals answered through that
  mode's own channel; the mod stays out of them and holds nothing.
- It does not answer tool calls in auto mode, or anything in a mode it cannot
  read.
- It does not approve Claude's plans. The app shows the plan; you approve it in
  the terminal, where the choice of how Claude carries on is made.
- It does not create a second writer on a session. While a mod is registered and
  reporting, Take over is refused for that session, because two writers on one
  transcript would fork its history.
- It does not deliver files to you. A local Claude session still has no
  agent-to-user file tool; see [Claude Code](claude-code.md).
- It does not touch Claude's own configuration beyond what Claude's install
  command records for the mod, and it installs nothing when you decline.
- It does not read your prompt text into cosyncing's audit records. The approval
  history keeps the session, the tool, the mode, who answered, and how long it
  took.
- It does not change how an older app draws two new kinds of transcript row. An
  app from before this release shows a message you steered into a running turn,
  and the note that Claude wrote a record type cosyncing does not recognise, as
  plain event rows. Updating the app draws the first as your own message and
  keeps the second out of the transcript.
