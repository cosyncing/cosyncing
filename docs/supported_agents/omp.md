# omp (oh-my-pi, experimental)

cosyncing enables mutable full sync only for the measured omp 17.4.2 and
19.1.0 protocols. Other versions remain available for read-only Observe when
their store is readable. Install omp 19.1.0 with Bun:

```bash
bun install --global @oh-my-pi/pi-coding-agent@19.1.0
```

omp 19.1.0 declares `engines.bun >=1.4.4`, so its launcher must run on Bun
1.4.4 or newer; doctor refuses an older Bun. omp 17.4.2 remains supported on
older Bun runtimes.

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
- On omp 19.1.0, extension HTML form dialogs appear as question cards. Radio
  groups and single selects become single-choice questions, checkbox groups
  and multi-selects become multiple-choice questions, and text and number
  inputs become typed answers. A form that omp withdraws (for example when its
  timeout expires) closes its card; omp then submits the form's defaults.
- On omp 19.1.0, a turn that hands work to the background stays running with
  "Waiting for background work…" until the background result's turn ends or
  omp reports the session settled.
- Fork is available on omp 19.1.0: forking a session copies the whole session,
  and forking at a message keeps that message in the copy.

## Limits

- omp 17.4.2 exposes no RPC fork, and neither measured version exposes clone
  through RPC.
- omp's native `ask` tool exists only in its `--mode rpc-ui`; Drive runs
  `--mode rpc`, where the tool is unavailable. The bridge's `ask_user` tool and
  extension form dialogs still reach the app.
- The v1 adapter deliberately omits native subagent events.
- The terminal/bridge and installed browser physical passes are complete for
  omp 17.4.2; omp 19.1.0 is measured from RPC and bridge captures. The
  integration remains experimental because omp's upstream RPC and store
  contracts are not a stable public compatibility promise.

See the [upstream oh-my-pi repository](https://github.com/can1357/oh-my-pi).
