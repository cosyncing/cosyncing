# DeepSeek Harness (experimental)

The provisional DeepSeek Harness adapter is intended for source contributors.
It connects to a `dsh web` host. The recorded version targets are:
`@deepseek-ai/dsh` 0.1.0-rc.6 and 0.2.0-rc.2. Those are two different wire
contracts, not one contract with an older build behind it, and cosyncing selects
between them by reading the host rather than by trusting a version string.
Other builds in the 0.1 or 0.2 family are reported as unverified;
family recognition does not qualify their behavior. Other versions may be refused.

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

Or pin the older contract, which keeps its separate legacy code path:

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

An already attached session resumes after successful re-enrollment through a fresh
authenticated handshake and session baseline. Disconnect keeps it withdrawn until
a usable credential is supplied again. A retained managed-launch token cannot
undo a withdrawal or a refused enrollment; renewal resumes after successful
re-enrollment. Requests waiting on catalog reads are fenced when event authority
ends or the connection closes. After recovery, submit a new prompt or command;
the old request cannot resume merely because readiness returns.

The cookie outlives both processes. Restart the broker, or restart the host, and
cosyncing is still signed in — no re-paste, and no new launch URL to go hunting
for. A host cosyncing starts for itself needs no `dsh connect` at all: the launch
URL it prints goes straight from the child process to the adapter that configured
that address, and the exchange runs on its own.

`cosyncing doctor` reads the same enrollment the running broker uses, so it never
reports "not enrolled" about a host you are logged into, and it never suggests
re-enrolling when what actually went wrong is something else.

## Current behavior

- Existing sessions, current model selection, workspace association, and history
  are discovered from the host. Ordinary cold sessions remain readable and the
  native command routes resume their agent when needed. Initial history awaits
  the event handshake before paging; compaction replaces its native surface range
  with one checkpoint context. Native archive changes
  withdraw new prompts while preserving history; unarchive reconciles availability.
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
  deployment that composes no permission service shows no control. A selected
  preset is applied before an ordinary native command; a refused change prevents
  that command from executing.
- The host's own slash commands — `compact`, `export`, `feedback`, `goal`,
  `permission`, `plan` on a default install — read from the live registry
  rather than a fixed list, so a deployment's own commands appear too.
- On rc.2, model and reasoning selections submitted with a native command apply
  to the next prompt, matching the native client. The command API has no model
  override parameter. Compaction uses the host's configured summarization model
  or durable request selection, which can differ from that next-prompt choice;
  it does not forward the selected reasoning effort to its summarization request.
- Native catalog changes automatically refresh the attached model, reasoning,
  permission and command choices. Late preset-catalog reads cannot undo a newer
  invalidation. A fresh authenticated handshake reloads presets even when the
  transport's numeric generation repeats after credential renewal.
  Successful empty responses remove stale
  choices; a failed catalog read retains that surface's last successful value.
- Assistant text and reasoning follow the host's transient attempt/revision/index
  stream. Reconnect baselines replace partial output, and durable messages settle
  the same transcript identity. Abandoned attempts reload history; interrupted partial replies settle through the native durable message.
- Blocking approval and question cards survive a follow-only retry while the
  event authority remains healthy. Timed questions hold the native wait claim;
  after timeout, a durable continued question offers a nonblocking late answer
  through `userQuestions/answer`. Ordinary answers use `$events/result`; one
  decision is submitted through one route.
- Ordinary sends queue a follow-up. On `0.2.0-rc.2`, the local `/steer` command
  takes text for the running turn's next step. Queue and steering echoes share
  their native message identity with delivery.
  Native cancellation or editing retracts stale queued bubbles through a history
  refresh.
- rc.2 tool calls and results use cosyncing's generic cards with their arguments,
  output and error state. DSH's specialized client-side tool cards remain native.
- Image attachments are delivered as bytes. Image-only echoes retain their native
  identity. Durable image previews use session-authorized readback and the
  broker's artifact delivery, bounded to 4 MiB per image and 16 previews per
  history read. Larger or unavailable previews are reported explicitly.
- A background resident tab does not keep a DSH subscription. Foregrounding it
  refreshes the roster, reattaches explicitly in live mode and catches up from
  history, while its cached transcript and unsent draft remain resident.
  A visible window retains its subscription when input focus moves elsewhere;
  hiding it releases transport, and returning it to view resumes the session.
  A page restored at browser startup waits for its authoritative roster attach
  instruction before joining, so a delayed roster cannot cause an implicit
  attachment to a live-only host.
  After the last foreground client leaves, the broker's reconnect grace ends
  even when native work or a decision is pending. Its adapter subscription then
  closes and unanswered interactions return to the host; the native session keeps
  running independently.
- The adapter fails closed when host identity cannot be verified or a session
  has been removed. A malformed roster is reported as a contract failure;
  it cannot falsely remove an attached durable session after a native agent
  becomes inactive.

## What is verified on 0.2, and what is not

"0.2" here means one build: `0.2.0-rc.2`, the version the contract was captured
from and the version every 0.2 result below was re-checked against. A different
0.2 build, including stable 0.2.0 or another release
candidate, has not been qualified and is not covered by the statements below.

What was captured from a running `0.2.0-rc.2` host and re-checked against one:
starting a host without a browser window opening, becoming authenticated to it
with nothing typed, reading its session roster, opening a session and reading
its history through the snapshot cut, holding a live follow subscription open on
it while a client reconnects, creating a session on a host that has no workspace
registered, keeping the credential across a broker restart, and enrolling a host
cosyncing does not own without touching that host's process.

Additional contract captures used a disposable `0.2.0-rc.2` host and a local
scripted provider. They exercised user echoes, streamed and settled text,
follow replacement during partial output, read-tool results, approval allow/reject, blocking questions,
timed questions and late answers, and image-only and caption-plus-image admission
and durable readback. These captures made no real model requests and prove the
adapter path, rather than provider-backed or visible browser acceptance.

Native Windows x64 and macOS arm64 passes also exercised basic managed launch,
authentication, roster/history reads and external enrollment without a model request. A separate
Linux pass made the real host fail at startup with disposable invalid configuration:
three recovery attempts failed, then supervision refused further launches. These
results cover basic lifecycle and startup suspension, rather than client UI or
failure during a model turn.

Separate provider-backed turns on a disposable Linux host exercised the actual
adapter prompt path: streamed and settled replies, read-tool results, approval
allow/reject, blocking questions, continued questions with late answers, image-only
and caption-plus-image input, carrier replacement during output, and interruption.
An owned process was also terminated during real streamed output: normal recovery
started a replacement, cleared stale partial output, and completed a new turn after
the consumer read the replacement history baseline. These are adapter outcomes;
they do not qualify visible browser behavior.

A local scripted-provider browser pass verified shared completed turns in two
foreground cosyncing clients and the native browser, visible read-tool input and
output, and an approval answered through cosyncing. Model-backed browser outcomes
and the remaining browser recovery and interaction scenarios remain acceptance
work. A successful login, roster read, or transport test does not qualify those
scenarios. The adapter remains experimental pending that evidence.

Forwarded native errors preserve both scalar messages and error-chain details.
A model-provider failure leaves a healthy authenticated host eligible for the
next turn; it does not itself establish a host-process failure.

Cold discovery refreshes durable model, reasoning effort, title, and permission
projections instead of relying only on a stale cached roster cut. Reads are bounded
to the newest 64 eligible cold sessions; failed reads retain the roster hint.
The host's launch-token exchange remains the enrollment
route; there is no separate read-only credential.

Still deferred: non-image file attachments, background Observe subscriptions,
session fork and search, subagents, workspace and settings mutation, goals as a
first-class surface, credential and agent-preset management, and some
DSH-specific message presentation.

Non-image file attachments are cosyncing's limitation, not the host's. The 0.2
host takes files: its prompt content parts include a `file` part that references
a receipt minted by an upload endpoint, so the intake exists upstream. The
cosyncing adapter ships images and nothing else, and refuses other types
outright rather than sending a prompt that mentions a file the agent never
received. That refusal is the correct behaviour for the types it does not
support and should not be read as a statement about DSH. A path is not a
substitute for uploading either way: DSH may run on another machine, where a
broker-local path names nothing it can open.

New rc.2 prompts use distinct request identities across broker restarts and
connection replacements. The native host deduplicates these identities against
queued and durable user messages. Ambiguous prompt failures still require an
explicit new user action; cosyncing does not automatically retry the prompt.

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

Authenticated service failures such as 5xx responses, service RPC failures, and
timeouts follow the normal owned-host recovery policy. Missing or refused
enrollment, unsafe credential storage, and address/Host-Origin faults require
operator intervention and do not terminate a healthy owned host. An unsupported
optional capability affects its own control rather than restarting the host.
