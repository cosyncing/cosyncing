# Adapter support and evidence

The broker presents one protocol across Claude Code, Codex, OpenCode, Pi, omp,
Kimi Code, DeepSeek Harness, Antigravity, Reasonix, Grok Build, Cline, and Kilo
Code. The generated matrix below covers the nine whose claims carry the
required evidence. omp, Reasonix, Grok Build, Cline, and Kilo Code remain
experimental because their upstream contracts are version-sensitive, but their
measured shipped postures have completed installed physical acceptance. Kimi
Code, DeepSeek Harness, and Antigravity are also described under
[experimental adapters](#experimental-adapters).
Support claims are generated from `support-matrix-claims.ts` and must have the
evidence level required by `trace-manifest.ts`.

Evidence levels are:

- `L0`: static or unit evidence.
- `L1`: component or browser evidence.
- `L2`: broker and adapter integration evidence.
- `L3`: opt-in real-agent/runtime evidence.
- `D`: capability discovery evidence.

Run these checks from the repository root:

```bash
bun run scripts/broker/tests_traces/check-trace-manifest.ts
bun run scripts/broker/tests_traces/check-support-matrix-coverage.ts
bun run scripts/broker/tests_traces/render-support-matrix.ts --write
```

<!-- BEGIN GENERATED SUPPORT MATRIX -->

| Function | Claude Code | Codex | OpenCode | Pi | omp | Reasonix | Grok Build | Cline | Kilo Code |
|---|---|---|---|---|---|---|---|---|---|
| F01 discover/history/reattach | full: JSONL observe plus Drive/resume | full: rollout observe plus app-server resume/live | full: shared-server plus private observe | full: JSONL/RPC observe plus bridge | full: JSONL/RPC observe plus bridge | full: bounded file-store observe plus ACP create/load and cross-client reattach | full: bounded local-store Observe plus authenticated ACP create/load, Drive, and cross-client reattach on 1.0.13 or newer | partial: bounded parent/subagent Observe plus isolated managed-Hub Create/Drive and cross-client reattach on 3.0.61 or newer; a replacement Hub epoch revokes Drive | full: bounded SQLite Observe plus authenticated managed-server create, live attach, and restart reattach on 7.4.23 or newer |
| F02 true sync | partial: hooks are answer-only; Drive is app-owned continuation | full: managed app-server live thread | full: shared opencode serve plus attach TUI | full: bridge extension | partial: bridge true-sync is physically proved for the measured version; reusable L3 TUI drift coverage remains outside the tracked matrix | n/a: broker-owned ACP has no terminal join; exact --resume session targeting is unpinned | n/a: exact-id terminal resume is a separate handoff process; Grok exposes no measured live terminal-join channel | n/a: cline --id starts a separate handoff process; no measured channel joins that process to the broker-owned Hub Drive | n/a: the broker manages a dedicated authenticated loopback host on port 4097, but no exact-session terminal join has been captured |
| F03 prompt/queue/stop | full: Drive prompt/stop; hooks sync cannot inject prompts | full: Drive/live; queued steer guarded | full: shared server; private Drive partial but prompt path covered | full: resume/bridge; queue semantics partial but prompt/stop path covered | full: resume/bridge; queue semantics partial but prompt/stop path covered | full: ACP prompt FIFO, pending replay, cancel, and detected ownership-loss stop | full: authenticated ACP Drive serializes prompts, reconciles durable echoes, cancels turns, and revokes on ownership loss | full: isolated Hub Drive serializes run.start, reconciles queued echoes after terminal reply plus durable reread, aborts turns, and revokes on ownership loss | full: authenticated prompt_async, abort, echo correlation, and broker-owned single-writer boundaries ship on the managed host |
| F04 answer/thinking streaming | partial: externally launched hooks are block-level; Drive is fuller | full: app-server streaming; observe rollout limited | full: answer/thinking lanes | partial: live tool-output streaming thinner than RPC history | partial: live tool-output streaming thinner than RPC history | partial: ACP answer/thinking lanes converge with flat replay; tool progress is terminal-only | partial: ACP answer/thinking chunks share one live/replay fold; installed streaming/final convergence is proved, while upstream chunk cadence remains undocumented | partial: live Hub answer/reasoning events and stored blocks converge through canonical presentation; native flush granularity remains unverified | partial: live SSE and SQLite replay share answer/reasoning semantics and stable part identity; installed streaming/final convergence is proved, while upstream chunk cadence remains undocumented |
| F05 tool display | full: common Claude tools, TodoWrite, diffs | full: exec/patch/read/search plus subagent control suppression | full: bash/edit/read/search summaries | full: common built-ins after enrichment | full: common built-ins after shared-engine enrichment | partial: ACP tool titles and bounded raw results are preserved without path/diff enrichment | partial: ACP tool metadata, arguments, and bounded results are preserved without unmeasured path/diff promotion | partial: live Hub and stored tool identities, names, bounded payloads, and subagent activity render without guessed path/diff promotion | n/a: a synthetic shared-lineage mapper candidate exists, but no native Kilo tool part has been captured; tool identity, display, paths, and diffs remain unsupported |
| F06 permissions | full: PreToolUse hooks and Drive; L3 app-answer exists | full: app-server permission path | full: SSE/REST permission path | full: bridge permission and RPC confirm | full: bridge permission and RPC confirm | full: per-tool ACP permission cards round-trip canonical allow/reject decisions | partial: the adapter maps allow-once and reject option ids and settles cards, but shipped Grok issues no permission request through this client: cosyncing delegates no fs/terminal execution, so tools run in-process | full: managed-Hub per-tool approval cards round-trip approve/reject and are cancelled on stop, close, or ownership loss | full: authenticated per-tool HTTP/SSE permission requests and replies preserve actionable ownership |
| F07 questions | full: AskUserQuestion and Drive | full: app-server tool/MCP questions | full: SSE/REST question channel | partial: resume/RPC select works; live bridge ask_user works; native TUI dialogs terminal-only | partial: resume/RPC select works; live bridge ask_user works; native TUI dialogs terminal-only | n/a: no measured ACP question request route; unknown requests fail closed | n/a: no measured Grok ACP question request route; unknown requests fail closed | n/a: no measured Cline snapshot block or hub route represents an actionable question request | n/a: no measured Kilo SQLite part or SDK route represents an actionable question request |
| F08 model/effort/mode display/override | full: display plus Drive overrides; hooks locked when not injectable | full: display and Drive overrides | full: model/agent display and override | full: model/thinking display and override | full: model/thinking display and override | partial: durable provider/model identity is displayed; existing-session model switch is unsupported | full: durable labels plus ACP model, effort, and mode selection survive create, relaunch, replay, and restart | partial: durable labels plus configured provider/model and ask/auto/plan mode propagate at managed creation; per-turn switching remains disabled | partial: provider model labels and model selection propagate through create, live SSE, replay, and restart; no measured permission-mode vocabulary exists |
| F09 slash commands/skills/templates | partial: native command discovery; hooks cannot inject prompt commands | partial: native slash/skills where app-server exposes them | full: server command registry; documented TUI built-ins tracked separately | full: get_commands registry; TUI/RPC-only gaps tracked separately | full: get_available_commands registry; pinned native drift gate remains follow-up work | partial: protocol-shaped ACP command snapshots and prompt invocation; native payload/invocation capture remains a gap | partial: ACP command catalogs and invocation ship on 1.0.13 or newer; native command breadth remains narrower than terminal documentation | n/a: rewritten snapshots and the measured Hub expose no slash-command registry; Drive advertises only its lifecycle Stop action | n/a: the measured store exposes no command registry and Observe has no prompt-command path |
| F10 todo/task list | full: TodoWrite to task-list-state | full: update_plan to task-list-state | full: todowrite to task-list-state | n/a: no native todo tool | n/a: no mapped native todo tool | n/a: no native task-list record or mapped todo tool | partial: measured task_completed snapshots map to native task-list state; mutation controls are not exposed | n/a: no measured Cline snapshot block carries a native todo or task-list state | n/a: the shared mapper recognizes OpenCode-lineage todos, but no Kilo todo capture exists to advertise the feature |
| F11 subagents/workflows/activity | full: Task plus UltraCode/workflow activity | full: spawn/wait-derived subagents | full: OpenCode task/subagent progress | n/a: no native subagent/workflow concept | n/a: native subagent events are deliberately outside the v1 adapter | n/a: subagent command exists, but no child-session store shape has been measured | partial: measured background-task activity renders and exact native parent/child metadata publishes a linked child roster row; child sessions remain Observe-only | partial: spawn_agent activity and measured parent/subagent document identities render; team/workflow controls remain unsupported | partial: a live-qualified native parent_id capture publishes linked child rows as Observe-only with no child writer controls |
| F12 user-to-agent files | full: native file/image input through Drive | full: inbox path read by Codex | full: single and multi-file input | full: byte-exact inbox upload | full: byte-exact inbox upload | n/a: native file and image input are disabled until an attachment echo is measured | n/a: native file and image input are disabled until an ACP/store echo capture proves identity and replay | n/a: native file and image input remain disabled until their exact durable attachment echo is captured | n/a: native file and image input remain disabled until an attachment echo and ownership route are captured |
| F13 agent-to-user artifacts | partial: maps native SendUserFile records and auto-surfaces its native Write of a deliverable file inside cwd; still partial because local CLI/Drive exposes no callable delivery tool | n/a: no exact session-qualified delivery route; shared cwd outbox fails closed | full: session-qualified send_file plus exact native write events | full: session-qualified bridge send-file route | full: session-qualified bridge send-file route | n/a: no measured session-qualified artifact delivery route | n/a: no measured session-qualified artifact delivery route | n/a: no measured session-qualified artifact delivery block or callable route | n/a: no measured session-qualified artifact delivery part or callable route |
| F14 lifecycle/history mutation | partial: resume/Drive/stop; fork/rename/export gaps | partial: observe/resume/live; archive/delete/fork UI gaps | partial: rename/fork plus stop/compact/undo/redo; export mapped (needs L2); timeline gap remains | partial: create/reload/quit/fork/clone/name covered; switch excluded by review; export mapped (needs L2) | partial: create/reload/quit/name/export covered; fork and clone are unavailable through RPC | partial: durable create/load/cancel and rewrite reset; rename, fork, and export are unsupported | partial: create, durable load, cancel, history reset, and exact-id terminal handoff ship; rename, fork, clone, and export are unsupported | partial: managed create/resume/stop, Observe rewrite reset, native rename, and exact-id terminal handoff ship; replacement-Hub resume, fork, clone, and export are unsupported | partial: create, live attach, cancel, native rename, and retained-history reset ship; terminal handoff, fork, clone, and export are unsupported |
| F15 runtime/tokens/context/status | full: runtime/status/token display with hooks caveat | full: runtime/status; no fabricated token split | full: runtime/status/tokens; context meter follow-up | full: runtime/status/tokens plus exact native used/max context stats | full: runtime/status/tokens plus exact native used/max context stats | partial: assistant runtime, status, cumulative tokens, and cost map with monotonic partial-update merging; no measured context maximum exists | partial: turn completion, status, per-turn tokens, run summaries, and aggregate context usage map without fabricated cumulative totals | partial: live Hub status/tokens plus durable run summaries, cache-inclusive token metrics, and cost render without double-counting; no trustworthy context maximum exists | partial: live status, run summaries, model identity, cache-aware tokens, and cost render; no measured context used/max pair exists |
| F16 security/auth/boundaries | full: hook path auth/data-loss hardening; broader read auth follow-up | partial: path/id guards; app-server auth follows native daemon | partial: path/artifact guards; shared-server auth is native deployment concern | partial: bridge token/auth plus path guards; broader read auth follow-up | partial: separately scoped bridge token/auth plus path guards; broader read auth follow-up | partial: local stdio, component-checked store reads, schema/path/frame bounds, and ownership fences; native per-write identity is unmeasured | partial: no-follow bounded store reads, authenticated floored-version ACP, path/frame limits, provenance, and foreign-writer demotion ship | partial: no-follow bounded snapshots plus owner-only Hub discovery, isolated profile/port, floored-version gate, frame bounds, epoch fencing, and foreign-run demotion ship | partial: no-follow bounded SQLite, floored-version Basic-auth host, dedicated-port ownership proof, origin-bound credentials, and writer demotion ship |

<!-- END GENERATED SUPPORT MATRIX -->

The generated table describes protocol support, not a promise that every
upstream agent exposes every feature. A partial or unavailable cell must remain
explicit rather than being inferred from tool names in client code.

## Codex background commands

Driven and shared-runtime Codex connections observe background commands on the
app-server connection that already owns their session. The adapter never starts
a server, loads an unrelated thread, or calls `clean` or `terminate` to observe
commands. Rollout-only Observe sessions do not advertise live command cards.
The new surface requires client contract revision 26 for safe reconnect
reconciliation. Older clients keep existing Codex functionality; this does not
raise the minimum supported Codex version or the general client minimum.
Native control-socket symlinks are supported for read-only routing and runtime
identity. Dangling or non-socket targets remain unknown; this does not grant
permission to start, stop or claim the target process.

Capabilities are independent of the general Codex version requirement:

| Evidence available | Behavior |
| --- | --- |
| Validated running-terminal list | Reconcile running commands, including on idle threads |
| Correlated command lifecycle notifications | Record exact exit code, outcome and duration; a command still open when its turn ends can be shown without list support |
| Command output notifications | Show a bounded available tail, marked truncated because Codex may omit output already returned at yield |
| Paginated item history plus a retained command identity | Recover the exact result after reconnecting to the same runtime |
| Missing or stale runtime evidence | Withdraw the running card without claiming success or failure |

Real isolated captures verified live success and failure on Codex 0.142.5 and
0.155.1, and disconnected bounded-history recovery on 0.155.1. The measured
0.142.5 binary lacks `thread/items/list` and advertises a per-turn item endpoint
that replies “not supported yet”; its live command results remain supported,
but bounded offline recovery is unavailable. The adapter probes the declared
legacy endpoint rather than using a version cutoff. This evidence sample is
not a version allowlist. Production-daemon, joined-terminal and phone physical
acceptance remain separate from these isolated captures and fixture tests.

The adapter retains up to 128 identities per session and caches up to 32 active
or recently closed session ledgers for six hours in broker memory. Reconnect recovery is
limited to those identities and the newest 128 native history items; it is not
a complete historical job archive. A broker restart loses this memory. A native
runtime replacement starts a different identity scope. Commands completed before
they were observed cannot safely be reconstructed as background work from the
rollout alone. Existing session, history and control support remain available
when a runtime lacks one of these background capabilities.

Only attached product clients enable reconciliation. The normal interval is five
seconds, with bounded transient-error backoff to ten seconds. One sweep permits
four pages of 32 running rows and, when exact completion is missing, four
history requests of at most 32 items. Legacy history discovery and capability
probes consume the same four-request budget; discovery inspects four recent
turn IDs. Requests are serial, each has a 1.5-second timeout, and
overlapping sweeps coalesce. A response over 128 KiB is rejected after receipt.
Malformed, failed, repeated or capped pagination never counts as an empty list.
Running evidence expires after 30 seconds and is withdrawn on the next sweep.

At most 16 running cards and eight recent finished cards are included in current
overlays. Each output preview is at most 4 KiB and 40 lines; unchanged cards are
not re-emitted, and changing running output has a five-second minimum interval.
Thus steady preview text is bounded to 12.8 KiB/s per attached client, plus
bounded labels, identities and JSON framing. Exact completion and withdrawal
transitions bypass that delay. Every completion is delivered before the result
window is applied. Finished cards remain available for dismissal in the client.
Reconnect replays retained outcomes without automatically dismissing older
results. A bounded `codex.background-running-snapshot` event reconciles missing
running identities even when individual withdrawals were evicted or broker
memory was lost. It never removes completed results or another agent's cards.

Cursor reconnects also replay retained withdrawals and exact outcomes outside
that display window, without withdrawing completed results. Those older catch-up
frames omit output and are bounded by the same 128 retained identities
(at most 129 frames including current cards and running-state reconciliation).
They repair missed live updates without resetting transcript history.
This reconciliation has the same in-memory retention limits described above.
On notification-only runtimes, fresh nonempty output matching an admitted
command and its exact turn can restore a stale card. Empty output, another
turn, replayed starts, and output after a terminal outcome cannot reopen it.

## Experimental adapters

Kimi Code is not yet part of the generated stable support matrix. Its source
adapter is registered by default and served to any client that can decode its
integration kind. It connects to the local server `kimi web` starts, which
cosyncing never installs, and currently covers discovery and read-only observe
for every session on that server, plus Drive — prompts, approvals, question
replies, interruption, model selection, file and image attachments, and the
server's own slash commands — for the sessions cosyncing created, session
creation and rename, explicit takeover for the ones it did not, and returning
Drive to the terminal. Agent and mode switching and the physical acceptance its
claims will rest on remain follow-up work. See
[Kimi Code setup](../supported_agents/kimi.md).

DeepSeek Harness is not yet part of the generated stable support matrix. Its
source adapter is registered by default and served to any client that can decode
its integration kind. It connects to a `dsh web` host that cosyncing never
installs, and currently covers discovery, bounded history, shared foreground
live control, create/rename, prompt resolution, model and permission-preset
selection, the host's own slash commands, image attachments, reconnect, and
session removal. Background resident subscription, non-image file input, and
final UI presentation remain follow-up work.

An installed service may start and restart a locally launchable host, acting
only on a process it can prove it started. See
[DeepSeek Harness setup](../supported_agents/dsh.md).

Antigravity is not yet part of the generated stable support matrix. Its source
adapter is registered by default and served to any client that can decode its
integration kind. It reads the `agy` CLI's own conversation store — there is no
server, and nothing to install beyond the CLI — and currently covers discovery
and read-only observe for every stored conversation, Drive through a
broker-owned `agy` child that starts on the first prompt, a cross-client join
that shares one Drive between two clients, release to a terminal writer,
session creation, and model selection with reasoning efforts read from the
CLI's live catalog. Image and file input remain follow-up work. See
[Antigravity setup](../supported_agents/antigravity.md).

omp has evidence-backed rows in the generated matrix and completed terminal,
wire, and installed-client physical acceptance. It reuses the shared Pi engine
through an omp-specific dialect, store, credentials, and packaged bridge; it
does not alias Pi state. See [omp setup](../supported_agents/omp.md).

Reasonix has evidence-backed rows in the generated matrix and completed its
installed wire/client physical acceptance. Observe reads its bounded local store;
Resume and create use one broker-owned ACP child per driven session. Joined
clients share that writer, and a detectable foreign durable write demotes it.
Native per-write identity remains unmeasured, so an exact same-text collision
remains an explicit coexistence limitation. Reasonix has no verified terminal
join, file input, durable-store usage totals, or context-window maximum; live
ACP usage updates can supply attributable cumulative tokens and cost.
See [Reasonix setup](../supported_agents/reasonix.md).

Grok Build has evidence-backed rows in the generated matrix and completed its
installed wire/client physical acceptance. Observe reads its
bounded local store and starts no process. Version 1.0.13 or newer with
reusable cached authentication adds broker-owned ACP Create/Resume, prompt/cancel, approvals,
commands, model/effort/mode controls, and cross-client Drive. Older versions
stay Observe-only. See
[Grok Build setup](../supported_agents/grok-build.md).

Cline has evidence-backed rows in the generated matrix. Default-profile Observe
reads bounded rewritten parent and subagent snapshots, across every schema
version listed in `CLINE_OBSERVE_VERSIONS`, and starts no
process. App-created sessions use an isolated broker-owned Hub on dedicated
port 25464 for Create/Resume, prompt/Stop, approvals, create-time model/mode,
and shared cross-client Drive. A terminal native reply plus an exact durable
reread replaces the queued echo. A replacement Hub epoch revokes Drive rather
than attempting Cline's unsafe stale-pid same-id reactivation. Setup never
reads Cline provider settings from disk. See
[Cline setup](../supported_agents/cline.md).

Kilo Code has evidence-backed rows in the generated matrix and completed its
managed-host, wire, and installed-client physical acceptance. SQLite Observe starts
no process. Version 7.4.23 or newer adds authenticated Create/Drive, prompt/cancel,
permission replies, model selection, and native rename through a broker-owned
loopback host on dedicated port 4097. A user server on port 4096 remains
unmanaged. Native tool display and terminal handoff remain unsupported. See
[Kilo Code setup](../supported_agents/kilocode.md).

## Context window reporting

Codex, Grok Build 1.0.13, Pi, and omp can supply an attributable
`contextUsage` value with `{used, max}`. Codex derives it from native
token-count events, Grok from its durable signals file, and the Pi-family
adapters from the native `getContextUsage()` result exposed by RPC or bridge.
The client renders the meter only when the adapter supplies a valid pair. It
holds no model-to-window table and must not acquire one.

The client renders **nothing** when the native contract lacks a trustworthy
denominator. That currently includes Claude Code, OpenCode, Reasonix, Cline,
and Kilo. Invalid or incomplete Pi-family context readings are also discarded;
a model catalog's context-window number alone never creates a meter.

Making the meter universal is a protocol change, not a client change: the
denominator should travel with the model as a `contextWindow` on `ModelOption`.
Until then, F15's context follow-ups in the matrix above stay open.

Two derivation hazards are documented on the `token-count` type in
`packages/typescript/protocol/src/index.ts`: cache-bucket semantics differ
per adapter, and cumulative totals must never be forwarded as per-reading
figures. Read that comment before computing anything from token buckets.

## Claude control boundary

Claude opens in read-only Observe. Drive is an explicit broker-owned Take-over
path that resumes the session in place; a takeover against a terminal that is
mid-turn is refused, and a terminal that writes later demotes the drive back to
Observe (two writers on one transcript would fork its history). The experimental
channel path is not a supported true-live control surface because current
runtime evidence does not provide the required permission-answer authority.
Packaged v1 therefore advertises Observe plus Take over, never true terminal
coexistence. Source-only hook and coexistence harnesses are contributor evidence;
they do not change the packaged support claim.

## Managed runtime freshness

Long-lived managed runtimes are inspected through agent-owned providers. Binary
or configuration drift is a freshness condition, not an outage: automatic
restart waits indefinitely until the provider proves its native safety gate.
Unknown state fails closed.

The default Codex policy requires no attached threads. The optional idle policy
requires explicit informed confirmation and still blocks working, needs-input,
or unknown threads. OpenCode uses its own managed-session activity evidence.
Automatic updates have no force-after-timeout path. A manual per-runtime restart
or global restart requires explicit confirmation, rechecks lifecycle permission
at the mutation boundary, and re-inspects the runtime afterward. Confirmed Codex
recovery may terminate a stalled daemon only after independently verifying its
process identity. A missing control socket never proves that the old process
exited or released its thread writer locks. Concurrent restart requests share
one operation, and failed replacement verification remains an error.

The manual restart is a recovery control, not an update control. It stays
offered when the provider reports no pending change, because a wedged runtime
reports none: a terminal that will not start or a session create that fails is
invisible to the freshness probe. Clients gate it on `managed`, never on pending
drift. `managed` is the broker's own claim to the runtime's lifecycle, and it is
the only claim the restart route can honour: a provider that does not own the
runtime can only refuse, and that refusal caches an error state every connected
client then reads. Starting a runtime the broker does not currently own is a
different action and is not offered here.

A client must not describe a runtime as having failed its activity check merely
because the status carries no blocker count. Providers report counts only where
they have them: the Codex provider measures loaded-thread activity solely to
decide whether a pending change may be applied, so a current runtime carries
none, and the OpenCode provider gates on managed-session activity and never
sends counts at all. An absent count is not a probe result.
