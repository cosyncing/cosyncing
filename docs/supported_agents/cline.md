# Cline (experimental)

The shipped adapter is measured against Cline CLI 3.0.60 and 3.0.61 and Hub
core 0.0.82. These are supported FLOORS rather than pins: a newer CLI or Hub
is admitted, because the wire contracts that matter -- Hub protocol `v1`, the
ACP agent identity, and the on-disk snapshot schema -- are each checked
structurally at use.

**Drive requires CLI 3.0.61 or newer**, even though 3.0.60 was measured. Drive
runs through the managed Hub, and 3.0.60 ships `@cline/core 0.0.81`, below the
0.0.82 Hub floor. The CLI floor is derived from that relationship rather than
chosen, so it cannot advertise a version whose own Hub the broker would refuse.
3.0.60 remains fully supported for Observe.

The adapter has two deliberately separate paths:

- The user's default Cline profile remains process-free and Observe-only.
- App-created sessions use an isolated Cline profile and a broker-owned Hub on
  dedicated loopback port 25464 for Create, Resume, prompts, Stop, approvals,
  and live output. The broker never adopts or reconfigures a user's Hub.

Versions below the floor, unreadable versions, and unowned Hub processes fail
closed. A snapshot written in a format newer than `CLINE_OBSERVE_VERSIONS`
lists is not replayed until that format is captured, which `cosy doctor`
reports as a warning while leaving Create, Drive and Resume available.

Install the measured official Cline CLI, then confirm that a new login shell can find it:

```bash
type -a cline
cline --version
cosyncing setup
cosy restart
cosy doctor
```

Use Cline's own authentication flow to configure the isolated profile before
enabling Create. `COSYNCING_CLINE_PROFILE_DIR` can select an absolute profile
path; its default is `~/.cosyncing/agents/cline`.
`COSYNCING_CLINE_PROVIDER` and `COSYNCING_CLINE_MODEL` select the exact
non-secret provider/model pair used for managed sessions.
`COSYNCING_CLINE_HUB_PORT` can replace the dedicated port when needed. Run
`cosyncing setup` from that configured shell so the installed service retains
those non-secret values.

Setup does not install or update Cline, copy credentials, or read
`data/settings/providers.json`. `CLINE_DIR` selects a non-default Observe root,
`CLINE_DATA_DIR` selects its Observe data directory, and
`COSYNCING_CLINE_BIN` selects a deliberate nonstandard executable.

## Current behavior

- Parent sessions are discovered from `<data>/sessions/<id>/<id>.json` and
  `<id>.messages.json` through bounded, read-only, no-follow reads.
- Measured `agent_*.messages.json` siblings appear as nested subagent sessions.
  Their native id and parent native id remain separate.
- Answer, thinking, user text, tool calls/results, and `spawn_agent` activity
  map from the rewritten message document. Unknown blocks become named neutral
  context, never user messages.
- A snapshot shrink, reorder, or content rewrite resets history and invalidates
  stale paging instead of joining two transcript versions.
- A row that claims to be running but whose pid is dead is shown as interrupted,
  never as live.
- Token input is already cache-inclusive in the measured store. Cache read and
  write values are retained as subsets and are not added again.
- New Session appears only when a floor-or-newer binary, configured model, ready
  isolated Hub, and broker ownership proof all agree. Provider/model and
  Ask/Auto/Plan mode propagate into native `session.create`.
- Hub Drive serializes prompts. A queued user row becomes durable only after a
  terminal native run reply and an exact transcript reread identify one causal
  native user row. Joined app clients reuse that one writer.
- Native approval cards support approve/reject. Stop aborts the run and retires
  every pending prompt and approval.
- Live answer, reasoning, tool, usage, and status events feed the common client
  surfaces; the bounded native message document remains replay authority.
- Native rename updates a parent title through the exact-id CLI route.
- A replacement broker client can rejoin while the same managed Hub process is
  alive and the durable boundary is unchanged.

## Limits

- Existing sessions outside the isolated managed profile remain Observe-only.
  Subagent rows are also Observe-only.
- A Hub-process replacement changes the native epoch and revokes Drive for its
  old sessions. Their durable snapshots remain observable. Cline can
  seed a same-id runtime from messages, but its persisted pid/status remains
  stale, so cosyncing does not advertise that unsafe restart path.
- Provider/model and permission mode are fixed at session creation. Per-turn
  model switching is not advertised.
- Parent rows offer `cline --id <sessionId>` as a separate terminal handoff.
  It does not join the broker-owned Drive. Subagent rows have no independent
  terminal handoff.
- Pending tools from Observe snapshots are display-only. Actionable approvals
  exist only on the owned managed-Hub writer.
- Native files, images, artifact delivery, questions, todo mutation, slash
  commands, fork, clone, export, and true terminal coexistence remain
  unsupported.
- Cline exposes token/cost data but no trustworthy context-window denominator,
  so the client does not fabricate a context meter.
