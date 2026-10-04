# DeepSeek Harness (experimental)

The provisional DeepSeek Harness adapter is intended for source contributors.
It connects to a `dsh web` host and was verified against two versions of it:
`@deepseek-ai/dsh` 0.1.0-rc.6 and 0.2.0-rc.2. Those are two different wire
contracts, not one contract with an older build behind it, and cosyncing selects
between them by reading the host rather than by trusting a version string. A
version that is neither of those two is recognized as one of the two families and
reported as unverified; nothing about it is assumed.

cosyncing never installs or configures that host, but it can start, supervise,
and stop one it owns — see [Managed hosts](#managed-hosts).

The adapter is registered by default. It has nothing to talk to until you start
a `dsh web` host, and it reports that rather than disappearing. Point it at a
host other than the default `http://127.0.0.1:3080` with:

```bash
COSYNCING_DSH_BASE_URL=http://127.0.0.1:3080 \
bun run broker
```

## Install the host

Install it globally with npm, so that `dsh` lands on your PATH:

```bash
npm install -g @deepseek-ai/dsh@0.2.0-rc.2
```

Or pin the older contract instead; both are verified, and each selects its own
code path:

```bash
npm install -g @deepseek-ai/dsh@0.1.0-rc.6
```

**An `npx @deepseek-ai/dsh` install is not enough.** npx keeps the package in an
ephemeral cache and puts nothing on your PATH, and cosyncing finds the host
binary by looking for `dsh` there. Without it, cosyncing can still talk to a host
you started yourself — discovery, transcripts, and control all work — but it
cannot start one for you, restart one that crashed, or report which version you
are running. `cosyncing doctor` says so rather than failing: it reports the npx
cache as an advisory and skips the version check instead of failing it.

If the binary is missing, Ubuntu may suggest `sudo apt install dsh`. That is an
unrelated distributed-shell tool and installing it will not give you a DeepSeek
Harness host.

Clients built before the contract revision that added tolerant agent decoding
are not shown this agent at all — one row they cannot decode would cost them
their whole agent list, so the broker withholds it from them and serves it to
everyone else.

Do not start a full source broker alongside an installed broker that owns the
same native agents. Stop the installed service for the review window and
restore it afterward.

## Signing in to a 0.2 host

A 0.2 host protects its API. The address of a host you started yourself answers
nothing until you present the one-time URL that `dsh web` printed when it
started, so cosyncing asks you for that URL once and keeps the session cookie the
host issues for it.

```bash
cosyncing dsh connect
# Paste the URL dsh printed. It is read silently and never stored.

printf '%s' "$DSH_LAUNCH_URL" | cosyncing dsh connect
cosyncing dsh status
cosyncing dsh disconnect
```

The URL is a credential that grants full control of that host, so it is accepted
only from a hidden prompt or from stdin — never from the command line, where it
would sit in your shell history and in the process list. What cosyncing stores is
the cookie the host issued, in its own credential file, scoped to that address and
that host's profile: a second host does not share it, a second cosyncing install
does not read it, and the file is written owner-only.

The cookie outlives both processes. Restart the broker, or restart the host, and
cosyncing is still signed in — no re-paste, and no new launch URL to go hunting
for. A host cosyncing starts for itself needs no `dsh connect` at all: the launch
URL it prints goes straight from the child process to the adapter that configured
that address, and the exchange runs on its own.

`cosyncing doctor` reads the same enrollment the running broker uses, so it never
reports "not enrolled" about a host you are logged into, and it never suggests
re-enrolling when what actually went wrong is something else.

## Current behavior

- Existing sessions and history are discovered from the host.
- Multiple active foreground cosyncing clients share the ordered transcript
  and live control surface.
- Session creation and rename, text prompts, permission and question replies,
  interruption, reconnect, and removal are supported. On 0.2, creating a session
  without naming a directory lets the host choose where it lands — which is what
  a host with no registered workspace does anyway — while naming a directory that
  the host has not registered stays a refusal rather than a silent relocation.
- Model selection, including per-model reasoning effort where the provider
  offers it. DSH stores the choice on the session, so it persists past the
  prompt it was picked for and is what the DSH browser UI shows next.
- Permission presets (`read-only`, `workspace-write`, `danger-full-access` on a
  default install). Only presets the host advertises can be selected, and a
  deployment that composes no permission service shows no control.
- The host's own slash commands — `compact`, `export`, `feedback`, `goal`,
  `permission`, `plan` on a default install — read from the live registry
  rather than a fixed list, so a deployment's own commands appear too.
- Image attachments, delivered as inline bytes on the prompt.
- A background resident tab does not keep a DSH subscription. Foregrounding it
  reattaches and catches up from history.
- The adapter fails closed when host identity cannot be verified or a session
  has been removed.

## What is verified on 0.2, and what is not

The 0.2 contract was captured from a running 0.2.0-rc.2 host and re-checked
against one: starting a host without a browser window opening, becoming
authenticated to it with nothing typed, reading its session roster, opening a
session and reading its history through the snapshot cut, creating a session on a
host that has no workspace registered, keeping the credential across a broker
restart, and enrolling a host cosyncing does not own without touching that host's
process.

What has NOT been verified against 0.2 is anything that needs a real model turn on
that host: prompt echoes, streamed replies, tool output cards, approval and
question payloads, and image attachments. The 0.2 wire carries the same durable-log
format that 0.1 did, and the mappings are shared, but shared code is not shared
evidence — treat those surfaces as unverified on 0.2 until a capture says
otherwise. Two further 0.2 limits are the host's own, not gaps in cosyncing: its
roster carries no model column (its model catalog is host-wide and names no
current selection), and its launch-token exchange is the only sign-in route, so
there is no read-only credential to ask for.

Still deferred: non-image file attachments, background resident subscriptions,
session fork and search, subagents, workspace and settings mutation, goals as a
first-class surface, credential and agent-preset management, and some
DSH-specific message presentation.

Non-image attachments are a host limit rather than a scheduling decision. A DSH
prompt carries text and images and nothing else, and the host has no general
file intake, so cosyncing refuses other types outright instead of sending a
prompt that mentions a file the agent never received. A path is not a
substitute: DSH may run on another machine, where a broker-local path names
nothing it can open.

The upstream host exposes one writable client contract rather than a separate
read-only Observe credential, so cosyncing accepts only an explicit foreground
`live` attach.

## Managed hosts

An installed cosyncing service starts `dsh web` when none is running, restarts
it if it crashes, and stops it when the service stops. A foreground broker does
the same when `COSYNCING_DSH_MANAGED_HOST=1` is set in its environment.

The start passes `--no-open`, verified against a real 0.2 host, and the child runs
without a display handoff, so a managed launch does not pop a browser window every
time the broker restarts. On 0.2 the launch URL that child prints is what signs
cosyncing in, automatically; the token in it is held in memory only, and the
cookie it earns is what persists.

Only a locally launchable configuration is managed. Point the adapter at a host
on another machine and cosyncing observes it without ever trying to start or
stop it.

Authorization is not ownership. The broker acts only on a process it can prove
it started — pid, a start token that survives pid reuse, the boot it started
in, and the address the claim was recorded for must all match, re-proved
immediately before every signal. The command name is recorded as evidence but
is not part of the proof: a process can rename itself at runtime, so a check
that trusted it would reject a host that is genuinely ours. Anything else is left running
and reported: a host you started yourself is never stopped, replaced, or
reconfigured, and neither is one the machine will not let it identify.
`cosyncing doctor` reports what it found either way, but what it tells you to do
depends on the address you are pointed at. Where cosyncing manages that address
it points at the service rather than offering a `dsh web` command, since
starting one by hand would race its recovery. Point the adapter anywhere else —
another port, another machine — and it names that address for you to start, and
still offers no `dsh web`: that command takes no address, so it would start a
host at the default one instead. Not the host you are diagnosing, and possibly
the one the service already manages.
