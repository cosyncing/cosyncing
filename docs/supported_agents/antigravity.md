# Antigravity (experimental)

cosyncing reads the Antigravity CLI's (`agy`) own on-disk conversation store —
there is no server to connect to and nothing to install beyond the CLI itself.
Conversations are discovered from the CLI's application data and cockpit cache
and replayed read-only; driving happens through a broker-owned `agy` child
process. It was verified against Antigravity CLI 1.1.22. The CLI updates
itself silently, so the floor is the last verified store and wire shape rather
than a pinned binary.

The adapter is registered for every broker. Clients built before the contract
revision that added tolerant agent decoding are not shown it — one row they
cannot decode would cost them their whole agent list.

## Current behavior

- Every conversation in the CLI's store is discovered and observable
  read-only, whoever started it.
- `?mode=resume` drives a session through a broker-owned `agy` child that
  starts on the first prompt rather than on attach, so opening a session never
  spawns anything by itself.
- Two clients can share one Drive: the second is offered the join, receives
  the same connection, and sees prompts the transcript has not recorded yet.
- A write from a terminal releases the session — the Drive demotes itself to
  observing and says so.
- New sessions can be created from the app with directory and model choice;
  the pending roster row resolves to the CLI's own record on the first prompt.
- Model selection reads the CLI's live `agy models` catalog. Reasoning-effort
  variants collapse into one model with selectable low, medium, and high
  efforts; the CLI's frozen cockpit cache is only a fallback when the binary
  is missing.
- Checkpoint summaries and stripped user-row metadata replay as context
  events instead of raw notices.
- `cosy doctor` diagnoses the installation.

## Limits

- Image and file attachments are not supported.
- The store is the CLI's own; cosyncing never writes to it. History appears as
  the CLI records it, so a conversation the CLI has not flushed yet can trail
  the terminal by a moment.
