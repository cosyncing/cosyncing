# omp (oh-my-pi, experimental)

cosyncing enables mutable full sync only for the physically verified omp 17.4.2 protocol. Other versions remain available for read-only Observe when their store is readable. Install the verified package with Bun:

```bash
bun install --global @oh-my-pi/pi-coding-agent@17.4.2
```

Confirm the launcher and runtime before setup:

```bash
type -a bun omp
bun --version
omp --version
cosyncing setup
cosy restart
cosy doctor
```

Setup does not install omp. After the binary and its Bun runtime pass the
checks, setup installs cosyncing's packaged in-session bridge into omp's own
agent directory. The bridge, credentials, session store, and ownership receipt
are separate from Pi's. Doctor refuses a configuration where Pi and omp resolve
to the same agent or session path.

## Moving the omp data directory

Set `COSYNCING_OMP_AGENT_DIR` before running `cosyncing setup` when omp uses a
deliberate non-default agent directory. Set
`COSYNCING_OMP_SESSIONS_ROOT` separately when the session store also moves.
Close active omp sessions first, then run setup, restart, and doctor. Repair
does not move bridge ownership between paths; it stops and directs the operator
to setup so the move uses setup's durable crash-recovery journal.

The reconciler moves only the exact bridge leaf proved by the existing install
receipt. It does not move omp sessions, configuration, or other files. The move
is transactional: the destination must be missing, the old bridge must still
match its receipt, and a later failure restores the old path. Modified or unsafe
source bytes, an occupied destination, or ambiguous receipt state block the
service reconfiguration instead of leaving omp without its bridge.

## Current behavior

- Existing JSONL sessions are discovered and replayed.
- Resume uses omp's native stdio RPC mode; the in-session bridge provides live
  app/terminal synchronization.
- Prompts, cancellation, per-tool approvals, model/thinking selection, native
  commands, and byte-exact file input use omp's own RPC names.
- New sessions and session names are supported.
- Multiple clients reuse one bridge/Drive owner.

## Limits

- Fork and clone are not exposed by omp's RPC surface.
- The v1 adapter deliberately omits native subagent events.
- The terminal/bridge and installed browser physical passes are complete. The
  integration remains experimental because omp's upstream RPC and store
  contracts are not a stable public compatibility promise.

See the [upstream oh-my-pi repository](https://github.com/can1357/oh-my-pi).
