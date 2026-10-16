# Claude history paging

Claude history uses a disposable disk index rather than retaining the complete
normalized transcript in the broker's paging cache. The client opens a bounded
latest window and requests older or newer pages through the existing cursor
protocol. Its decoded-window and rendering budgets remain in place. Total
transcript size no longer consumes the 32 MiB / 50,000-row in-memory admission
budget.

The first open scans the native JSONL in chunks. It first collects tool-call
definitions, then replays complete records through the existing Claude mapper.
Two passes preserve enrichment when a result appears before its call definition.
Normalized rows and mapper checkpoints are stored in SQLite under
`$COSYNCING_HOME/cache/claude-history` (default `~/.cosyncing/cache/claude-history`).
Task state, tool definitions, block ordinals, token deduplication, queue
correlation, runtime summaries, and parent activity state are persisted too.

An unchanged open reads no native transcript records. An append starts at the
last complete record boundary. A truncated/replaced source or changed prefix
guard rebuilds the cache; a late tool definition that changes earlier result
enrichment also rebuilds it. Concurrent connections share one adapter update.
The source transcript is never changed. Cold indexing still costs time and disk
I/O proportional to history length; this is not a promise of zero first-open
latency.

The broker stores cursor metadata separately in `cache/history-index.sqlite`.
Cursor hashes are checkpointed, and metadata is read in small disk blocks.
Appending does not re-hash the entire prefix. Current state overlays replay
outside the stable stored prefix, including queued prompts and activity cards.
Restarted brokers reuse both caches. Older cursors survive ordinary append and
restart; a source rewrite requires a reset. Cursors issued by the former full
replay implementation reset once when switching to the new index.

Backward and forward pages stop at both the requested row count and a 2 MiB
decoded-message estimate. A byte-shortened page names the actual boundary, so
the next request cannot skip messages. Attach and refresh retain their existing
frame budgets. Stored rows do not mutate as a turn streams, so active-turn
attach does not scan back through the whole running turn. Live tailing and
managed resync use the same stored mapping.

Drive seeds its runtime tracker from the bounded replay checkpoint. Its task
ledger uses a separate file-backed SQLite temporary table, so live updates
preserve earlier tasks without changing the persisted replay state. Refreshing
history does not replace the tracker for a currently streaming turn.

Text and tool-result bodies larger than 128 Ki UTF-16 code units receive a
marked preview plus a file artifact containing the complete body. A single
native JSONL record above 64 MiB is still refused explicitly. The total-history
limit and a pathological individual-record limit are separate concerns.

Caches use private file permissions. Corrupt SQLite files are rebuilt from the
native source. Inactive Claude caches are pruned oldest first when opening a
store exceeds the soft disk quota, configured by
`COSYNCING_HISTORY_CACHE_BYTES` (default 2 GiB). Active caches are excluded, so
this is not a hard limit on a session's readable length. Source files are never
part of eviction. A full disk still prevents indexing and is reported as a
server resource limit. Client copy distinguishes that condition from a page
that exceeds the device's own decoding budget.

## Standalone verification

These checks are intentionally not registered with the CI runner. Run from the
repository root:

```bash
scripts/broker/check-claude-stored-history.sh
scripts/broker/check-claude-stored-history.sh --wire
scripts/broker/check-claude-stored-history.sh --client
```

The wire test owns a temporary synthetic broker, isolated provider homes, and
loopback sockets. It starts no agent/model and does not attach to the installed
production broker. The client option requires the local Flutter toolchain on
`PATH`.

For an explicitly authorized local transcript, set
`COSYNCING_TEST_CLAUDE_TRANSCRIPT` to its absolute path. This optional check reads
the source, writes only temporary caches, walks all older pages, and reports
content-free cold/warm/page timings. It never prints transcript contents.

Coverage includes replay parity, incremental mapping, late enrichment, queued
prompts, partial lines, rewrite invalidation, corruption recovery, oversized
body access, byte-shortened pages in both directions, live completion, bounded
resync, and a fixture exceeding both former cache limits. Wire acceptance adds
attach, refresh, reconnect, and broker restart.
