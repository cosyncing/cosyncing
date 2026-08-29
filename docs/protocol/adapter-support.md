# Adapter support and evidence

The broker presents one protocol across Claude Code, Codex, OpenCode, Pi, Kimi
Code, DeepSeek Harness, and Antigravity. The generated matrix below covers the
four whose claims carry the required evidence; Kimi Code, DeepSeek Harness, and
Antigravity are provisional and are described under
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

| Function | Claude Code | Codex | OpenCode | Pi | omp |
|---|---|---|---|---|---|
| F01 discover/history/reattach | full: JSONL observe plus Drive/resume | full: rollout observe plus app-server resume/live | full: shared-server plus private observe | full: JSONL/RPC observe plus bridge | full: JSONL/RPC observe plus bridge |
| F02 true sync | partial: hooks are answer-only; Drive is app-owned continuation | full: managed app-server live thread | full: shared opencode serve plus attach TUI | full: bridge extension | partial: bridge extension is wired; real OMP TUI true-sync pass remains |
| F03 prompt/queue/stop | full: Drive prompt/stop; hooks sync cannot inject prompts | full: Drive/live; queued steer guarded | full: shared server; private Drive partial but prompt path covered | full: resume/bridge; queue semantics partial but prompt/stop path covered | full: resume/bridge; queue semantics partial but prompt/stop path covered |
| F04 answer/thinking streaming | partial: externally launched hooks are block-level; Drive is fuller | full: app-server streaming; observe rollout limited | full: answer/thinking lanes | partial: live tool-output streaming thinner than RPC history | partial: live tool-output streaming thinner than RPC history |
| F05 tool display | full: common Claude tools, TodoWrite, diffs | full: exec/patch/read/search plus subagent control suppression | full: bash/edit/read/search summaries | full: common built-ins after enrichment | full: common built-ins after shared-engine enrichment |
| F06 permissions | full: PreToolUse hooks and Drive; L3 app-answer exists | full: app-server permission path | full: SSE/REST permission path | full: bridge permission and RPC confirm | full: bridge permission and RPC confirm |
| F07 questions | full: AskUserQuestion and Drive | full: app-server tool/MCP questions | full: SSE/REST question channel | partial: resume/RPC select works; live bridge ask_user works; native TUI dialogs terminal-only | partial: resume/RPC select works; live bridge ask_user works; native TUI dialogs terminal-only |
| F08 model/effort/mode display/override | full: display plus Drive overrides; hooks locked when not injectable | full: display and Drive overrides | full: model/agent display and override | full: model/thinking display and override | full: model/thinking display and override |
| F09 slash commands/skills/templates | partial: native command discovery; hooks cannot inject prompt commands | partial: native slash/skills where app-server exposes them | full: server command registry; documented TUI built-ins tracked separately | full: get_commands registry; TUI/RPC-only gaps tracked separately | full: get_available_commands registry; pinned native drift gate remains follow-up work |
| F10 todo/task list | full: TodoWrite to task-list-state | full: update_plan to task-list-state | full: todowrite to task-list-state | n/a: no native todo tool | n/a: no mapped native todo tool |
| F11 subagents/workflows/activity | full: Task plus UltraCode/workflow activity | full: spawn/wait-derived subagents | full: OpenCode task/subagent progress | n/a: no native subagent/workflow concept | n/a: native subagent events are deliberately outside the v1 adapter |
| F12 user-to-agent files | full: native file/image input through Drive | full: inbox path read by Codex | full: single and multi-file input | full: byte-exact inbox upload | full: byte-exact inbox upload |
| F13 agent-to-user artifacts | partial: maps native SendUserFile transcript records, but local CLI/Drive exposes no callable delivery tool | n/a: no exact session-qualified delivery route; shared cwd outbox fails closed | full: session-qualified send_file plus exact native write events | full: session-qualified bridge send-file route | full: session-qualified bridge send-file route |
| F14 lifecycle/history mutation | partial: resume/Drive/stop; fork/rename/export gaps | partial: observe/resume/live; archive/delete/fork UI gaps | partial: rename/fork plus stop/compact/undo/redo; export mapped (needs L2); timeline gap remains | partial: create/reload/quit/fork/clone/name covered; switch excluded by review; export mapped (needs L2) | partial: create/reload/quit/name/export covered; fork and clone are unavailable through RPC |
| F15 runtime/tokens/context/status | full: runtime/status/token display with hooks caveat | full: runtime/status; no fabricated token split | full: runtime/status/tokens; context meter follow-up | full: runtime/status/tokens; context stats follow-up | full: runtime/status/tokens; context stats follow-up |
| F16 security/auth/boundaries | full: hook path auth/data-loss hardening; broader read auth follow-up | partial: path/id guards; app-server auth follows native daemon | partial: path/artifact guards; shared-server auth is native deployment concern | partial: bridge token/auth plus path guards; broader read auth follow-up | partial: separately scoped bridge token/auth plus path guards; broader read auth follow-up |

<!-- END GENERATED SUPPORT MATRIX -->

The generated table describes protocol support, not a promise that every
upstream agent exposes every feature. A partial or unavailable cell must remain
explicit rather than being inferred from tool names in client code.

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

## Context window reporting

Only Codex currently advertises a context window. Its native `token_count` event
carries `model_context_window` alongside a per-turn `last_token_usage`, so the
adapter emits a reconciled `metadata-update` with key `contextUsage` and value
`{used, max}`. The window is adapter-advertised per event; the client holds no
model-to-window table and must not acquire one.

The client's context meter therefore renders for Codex sessions and renders
**nothing** elsewhere. That absence is deliberate. Claude Code and OpenCode
expose no window size at all, and `ModelOption` carries no field for one. Pi does
report a `contextWindow`, but under a key no consumer matches, and whether its
token figures are resident or cumulative is unverified — wiring it on assumption
is precisely how a cumulative total gets measured against a window and renders a
five-digit percentage. A missing meter beats a confident wrong one.

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
There is no force-after-timeout path. A manual per-runtime restart or global
restart requires explicit confirmation, rechecks lifecycle permission at the
mutation boundary, and re-inspects the runtime afterward.
