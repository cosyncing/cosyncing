# Kimi Code (experimental)

cosyncing talks to the local server Kimi Code starts with `kimi web --no-open`,
over its REST and WebSocket API. It was verified against Kimi Code 0.38.0 and
2.7.2; the server API is marked experimental upstream, so each bound is a tested
version rather than an inferred one.

The adapter is registered for every broker. Clients built before the contract
revision that added tolerant agent decoding are not shown it — one row they
cannot decode would cost them their whole agent list.

## Supported versions

cosyncing supports two ranges of Kimi Code:

- 0.35.0 and newer, below 2.0.0, over the 0.x local server protocol.
- 2.7.0 and newer, over the Kimi Agent Protocol 1.x, which Kimi Code 2.7.0
  introduced.

Kimi Code 2.0.0 to 2.6.x predate the Kimi Agent Protocol 1.0 and differ from
the 0.x protocol, so they are not supported. When the running `kimi web` reports one of those versions
(prereleases included), cosyncing sends it nothing. cosyncing also checks that
the protocol a server announces in its metadata is the one its version speaks,
and stops after that read when it is not. Either way, Kimi shows as unavailable,
its sessions are not listed, new sessions cannot be created, and
`cosyncing doctor` names the version it found and the supported ranges.

When the Kimi Code installed on the machine is a version cosyncing does not
support, the cosyncing service starts `kimi web` from it once. After that start
is refused, the service does not start it again until the installed `kimi`
changes, for example after an upgrade or a reinstall.

Kimi Code can update itself when you start it interactively, and `kimi update`
installs the newest release, which may be one cosyncing does not support yet.
To stay on a version you know works, set `KIMI_CODE_NO_AUTO_UPDATE=1` in the
environment you start Kimi Code from. cosyncing sets that variable itself when
it starts `kimi web` and when doctor reads the installed version.

## Kimi Code 2.7 and newer

cosyncing maps Kimi Code 2.7's protocol onto the behavior described under
"Current behavior". The differences:

- cosyncing uses the server `kimi web` starts and ignores the separate server
  Kimi Desktop runs, even when both use the same Kimi home.
- A session that a terminal `kimi` or Kimi Desktop has open is listed and can
  be observed through `kimi web`, but Kimi only shows that session's state as
  it was last saved, so it can look idle while the other program works in it.
  Kimi refuses writes to it while the other program holds it. If cosyncing is
  driving such a session, it stops driving it and switches to observing, the
  same as when it detects another writer.
- The model, effort and context-window details of a session appear once the
  session is open in cosyncing, not on the session list.
- An attached file shows as a notice with its name, type and size.

## Current behavior

- Every session on the server is discovered and observable read-only, whoever
  started it.
- Sessions cosyncing creates are additionally drivable: prompts, approvals,
  question replies, interruption, and model selection.
- A session cosyncing did not create can be taken over explicitly. That is a
  decision you make, not something cosyncing infers.
- Model selection is offered at creation time and while driving.
- File and image attachments are supported: images go inline as vision input,
  other files upload through the server's own file API.
- A deliverable the agent writes inside the session's own directory is surfaced
  as a downloadable file artifact. Source churn, a write outside that directory,
  and a write that failed surface nothing.
- The server's slash commands are offered, including `/goal` and its skills as
  prompt commands.
- Subagent runs appear as observe-only child rows under the session that
  spawned them, with live activity while a child is still writing.

Agent and mode switching are not implemented yet.

## Why a session you started elsewhere is read-only

Two processes writing one Kimi session silently fork its journal, and a terminal
`kimi -S <id>` is a writer cosyncing cannot see, negotiate with, or lock out. So
Drive is limited to sessions cosyncing created and can be extended to others only
by an explicit takeover. A drive connection also watches for foreign writes and
demotes itself to observing when it finds one.

## Managed hosts

An installed cosyncing service starts `kimi web` when none is running, restarts
it if it crashes, and stops it when the service stops. A foreground broker does
the same when `COSYNCING_KIMI_MANAGED_HOST=1` is set in its environment.

Authorization is not ownership. The broker acts only on a process it can prove
it started — pid, a start token that survives pid reuse, the boot it started in,
and the address the claim was recorded for must all match, re-proved immediately
before every signal. The command name is recorded as diagnostic evidence but is
not part of the proof: a process can rename itself at runtime. A `kimi web` you
started yourself is never stopped, replaced, or reconfigured, and neither is one
the machine will not let cosyncing identify.

`cosyncing doctor` reports what it found either way, but what it tells you to do
depends on whether cosyncing manages the Kimi home you are pointed at — the one
the service resolves, or one it started and recorded. Set `KIMI_CODE_HOME` to
something else and doctor treats that home as yours: nothing supervises it, so
the manual command is the right answer and you get it. Where it does, doctor never
offers a `kimi web` command — not to start the server and not to restart it,
because stopping a supervised host just opens a window for cosyncing to start a
replacement while you start another. It points at the service instead. Where
nothing manages the host, the direct command is the whole answer and doctor
gives it.
