# Session titles

The broker resolves `SessionInfo.title`. An empty string means unnamed; clients
provide their localized label. Project names, filenames, slugs and shortened
identifiers are metadata, never invented conversation names. An explicit title
may contain a path, Unicode, or the session's identifier.

Resolution prefers an existing display alias, then the tool's native name or
generated title, its stable picker preview, and finally the first eligible user
prompt. Follow-up prompts and assistant output do not replace that preview.
Prompt previews join text parts, exclude machine context, collapse whitespace
and control characters, and keep at most 160 Unicode characters. They preserve
the prompt's language. Deriving a display preview does not rename native data.

| Adapter | Native authority and automatic fallback |
| --- | --- |
| Pi | Latest `session_info.name`, including clears; first mapped user prompt. |
| OMP | Its own title slot and `title_change` records; migrated Pi names when no OMP slot exists; first mapped user prompt. |
| Codex | Thread name / session index; first real rollout user prompt. |
| Claude Code | Custom title, AI title, then first real user prompt. |
| Kimi | Native metadata title; first `turn.prompt` in the main journal. |
| OpenCode | Native title, including native generated titles. |
| Grok | Native summary/generated title; first mapped user update. |
| Cline | Native metadata title; first mapped user message in the snapshot. |
| Reasonix | Native ACP title; stable metadata preview. |
| Kilo Code | Native session title. |
| Antigravity | Native title, stable native preview, then the first classified user prompt. |
| DeepSeek Harness | Native title projection; workspace names remain project metadata. |

Subagent names and lineage retain their native behavior. When a supported native
format provides no usable title or prompt, the session remains unnamed.

Claude deliberately differs from its native picker for unnamed conversations:
`last-prompt` is activity, not a title. A continuation transcript uses its own
first real prompt, unless it contains a native title. It does not inherit a
predecessor's inferred title or use the continuation summary.

## Codex creation and compatibility

The native 0.164 probe confirms that `thread/start` with legacy history and a
settings update alone leave a zero-turn rollout unmaterialized. A supported
`thread/metadata/update` which replays the thread's existing Git branch field
(including `null` outside Git) materializes it without naming it. Creation
prefers that path. A fork of an unnamed zero-turn rollout also persists without
assigning a name.

When an older runtime cannot materialize the rollout through metadata, creation
assigns `Untitled session`. Before that write, the broker durably records its
exact native identity, value and automatic origin. Cosyncing presents it as
unnamed. Unsettled records are exempt from provenance eviction. An acknowledged
metadata update is followed by a native read barrier and a bounded wait for the
rollout. A failed optional name write preserves an already durable created
thread; native readback settles rejected provenance or retains an ambiguous
write.

Discovery and metadata refresh complete an unsettled name after the first real
prompt, including after a broker restart. A different native name cancels
completion. An unavailable or unidentified native name keeps the record pending.
Native 0.164 rejects both empty and null names, so completion
replaces the still-current provisional value once with the prompt preview.
Local completion and requested renames serialize per thread. An explicit create
title or rename remains authoritative. Existing native names with ambiguous
origins are preserved; matching a directory basename proves nothing.
Completion uses the existing shared daemon in the background, with one attempt
at a time and a bounded exponential cooldown after failure. Roster reads do not
launch private app-servers or wait for completion RPCs. Drive resume uses the
same provisional-name policy.

## Retention and verification

Title facts use bounded incremental reads. Pi/OMP inspect the head and tail on
a cold scan and expose completeness separately from candidate facts; unresolved
reads carry `titlePending: true`, preserving the last known title. Their cache
yields every 128 KiB and limits each refresh to 16 MiB and 250 ms. One forward
cursor covers the original backlog; a separate cursor reads appended bytes.
Growth preserves both positions and the last published title. The initial
backlog receives a reserved share of each pass so appends cannot starve it.
A pending read becomes complete once both cursors cover the captured file size.
Codex, Grok and Kimi stop reading once their first eligible
prompt is known. Claude carries title facts on its existing turn-authority
scanner and shares its 64 MiB/250 ms budget, cache and invalidation policy. Its
cold suffix also feeds title facts, with one forward cursor for earlier records;
custom and AI titles are bounded to 160 Unicode characters.
Replacement, truncation and changed byte anchors invalidate retained facts.
Partial and malformed rows do not hide later complete records. Native clears
are distinct from records that were not observed.
Large image payloads are projected incrementally so a short user prompt beside
an image remains the first-prompt title. Oversized text retains a bounded usable
prefix; unfinished records resume across refreshes. If a record exceeds the
projection's structural bounds or cannot be classified safely, its coverage
remains pending rather than certifying a later prompt as the first.
Pi and OMP derive conversation activity from user/assistant timestamps, falling
back to the session header. Appending a native name alone does not advance it.
Until conversation activity is known, the file modification time keeps a
pending Pi/OMP row dated and eligible for the roster window. Pending title
reads still publish unrelated status changes. Accepted app renames invalidate
roster caches and fence results from older in-flight sweeps. Watcher results
carry their read-start time and are checked again after asynchronous connection
repair. A later terminal rename can supersede an app rename. Pending native
clear responses keep the known title in the broker, client and saved roster.
Initial attaches and promotions capture the same rename ordering before their
native read and recheck it at admission. An accepted explicit Kimi name is
authoritative even when its earlier fallback read was pending.
Bridge and hook
connections register before asynchronous title lookup.
Pi/OMP hello also publishes and acknowledges registration without awaiting
that lookup; deferred title enrichment checks the current owner before delivery.

Persisted client identities carry a title-format marker. Older cached titles
equal to their session ID migrate to unnamed, including while offline. A newly
confirmed title equal to an ID remains a valid name.

The existing adapter conformance scenarios cover title stability, index-only
renames, clears, large output, restart recovery, and provisional-name eviction
pressure. Antigravity's conformance and store scenarios cover first-prompt and
native-title precedence; DeepSeek Harness covers title projections and clears.
Client feature flows cover roster, detail and open-tab reconciliation.

Offline reproduction commands, run from the repository root:

```bash
node scripts/dev/probe-codex-naming.mjs
bun run scripts/dev/probe-codex-conversation.ts
bun run scripts/dev/probe-claude-naming.ts
bun run scripts/dev/probe-pi-naming.ts
bun run scripts/dev/measure-session-naming.ts
bun run check adapters --only conformance/pi,conformance/omp,conformance/claude,conformance/codex
PATH=/snap/bin:$PATH scripts/dev/check-session-naming.sh
```

The native probes use isolated generated state under `output/session-naming/`;
the conversation probes use local model fixtures without credentials or paid
requests. The Pi probe reads the installed native session manager. The Codex
probes use its supported app-server API; the Claude probe uses its installed
headless CLI. The measurement
reports decoded rows and elapsed time for cold, unchanged, append and clear
reads; `NAMING_MEASURE_ROWS` controls fixture size.
