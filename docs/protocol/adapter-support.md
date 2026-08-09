# Adapter support and evidence

The broker presents one protocol across Claude Code, Codex, OpenCode, and Pi.
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

| Function | Claude Code | Codex | OpenCode | Pi |
|---|---|---|---|---|
| F01 discover/history/reattach | full: JSONL observe plus Drive/resume | full: rollout observe plus app-server resume/live | full: shared-server plus private observe | full: JSONL/RPC observe plus bridge |
| F02 true sync | partial: hooks are answer-only; Drive is app-owned continuation | full: managed app-server live thread | full: shared opencode serve plus attach TUI | full: bridge extension |
| F03 prompt/queue/stop | full: Drive prompt/stop; hooks sync cannot inject prompts | full: Drive/live; queued steer guarded | full: shared server; private Drive partial but prompt path covered | full: resume/bridge; queue semantics partial but prompt/stop path covered |
| F04 answer/thinking streaming | partial: externally launched hooks are block-level; Drive is fuller | full: app-server streaming; observe rollout limited | full: answer/thinking lanes | partial: live tool-output streaming thinner than RPC history |
| F05 tool display | full: common Claude tools, TodoWrite, diffs | full: exec/patch/read/search plus subagent control suppression | full: bash/edit/read/search summaries | full: common built-ins after enrichment |
| F06 permissions | full: PreToolUse hooks and Drive; L3 app-answer exists | full: app-server permission path | full: SSE/REST permission path | full: bridge permission and RPC confirm |
| F07 questions | full: AskUserQuestion and Drive | full: app-server tool/MCP questions | full: SSE/REST question channel | partial: resume/RPC select works; live bridge ask_user works; native TUI dialogs terminal-only |
| F08 model/effort/mode display/override | full: display plus Drive overrides; hooks locked when not injectable | full: display and Drive overrides | full: model/agent display and override | full: model/thinking display and override |
| F09 slash commands/skills/templates | partial: native command discovery; hooks cannot inject prompt commands | partial: native slash/skills where app-server exposes them | full: server command registry; documented TUI built-ins tracked separately | full: get_commands registry; TUI/RPC-only gaps tracked separately |
| F10 todo/task list | full: TodoWrite to task-list-state | full: update_plan to task-list-state | full: todowrite to task-list-state | n/a: no native todo tool |
| F11 subagents/workflows/activity | full: Task plus UltraCode/workflow activity | full: spawn/wait-derived subagents | full: OpenCode task/subagent progress | n/a: no native subagent/workflow concept |
| F12 user-to-agent files | full: native file/image input through Drive | full: inbox path read by Codex | full: single and multi-file input | full: byte-exact inbox upload |
| F13 agent-to-user artifacts | full: session-qualified SendUserFile transcript mapping | n/a: no exact session-qualified delivery route; shared cwd outbox fails closed | full: session-qualified send_file plus exact native write events | full: session-qualified bridge send-file route |
| F14 lifecycle/history mutation | partial: resume/Drive/stop; fork/rename/export gaps | partial: observe/resume/live; archive/delete/fork UI gaps | partial: rename/fork plus stop/compact/undo/redo; export mapped (needs L2); timeline gap remains | partial: create/reload/quit/fork/clone/name covered; switch excluded by review; export mapped (needs L2) |
| F15 runtime/tokens/context/status | full: runtime/status/token display with hooks caveat | full: runtime/status; no fabricated token split | full: runtime/status/tokens; context meter follow-up | full: runtime/status/tokens; context stats follow-up |
| F16 security/auth/boundaries | full: hook path auth/data-loss hardening; broader read auth follow-up | partial: path/id guards; app-server auth follows native daemon | partial: path/artifact guards; shared-server auth is native deployment concern | partial: bridge token/auth plus path guards; broader read auth follow-up |

<!-- END GENERATED SUPPORT MATRIX -->

The generated table describes protocol support, not a promise that every
upstream agent exposes every feature. A partial or unavailable cell must remain
explicit rather than being inferred from tool names in client code.

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
path and may fork when a live terminal owns the transcript. The experimental
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
