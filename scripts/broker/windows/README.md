# Native Windows broker Phase 0 probes

Run the staging launcher from the repository root in WSL:

```bash
bash scripts/broker/windows/stage-phase0.sh
```

The launcher archives the selected working tree, extracts it with Windows
`tar.exe` into a run-specific directory below `%LOCALAPPDATA%`, and invokes the
PowerShell probe from that NTFS staging tree. It copies the redacted result back
to `output/windows-broker/` after the probe completes.

The initial probe is read-only apart from its staging directory and result file.
It records host, filesystem, tool availability, and Task Scheduler API
evidence. It does not create tasks, task folders, services, or package
installations. External connectivity is operator-owned: no probe here inspects
or changes a proxy, tunnel, VPN, or mesh route.

If `output/windows-broker/candidate/cosyncing` exists, the launcher also stages
that JavaScript bundle and runs the isolated runtime probe. The runtime probe
downloads the official Bun 1.3.8, current Bun 1.4.0, and Node 24.19.0 Windows
x64 archives into the run directory. It does not change machine or user PATH.
It runs the bundle with both Bun versions and uses the portable npm to install
a probe package into a run-local prefix so npm's `cosyncing.cmd` and `cosy.cmd`
shims can be inspected. A subsequent behavior probe records Windows environment
shapes, direct executable and explicit batch invocation, NTFS replacement and
locking behavior, ACL inheritance, listener ownership, and child-tree teardown.
Set `COSYNCING_WINDOWS_PHASE0_MUTATE_SCHEDULER=1` for the reviewed scheduler
pass. It creates a run-specific Task Scheduler folder, SID child, and direct-Bun
task, inspects their separate descriptors and definitions, runs the task, and
removes the complete disposable hierarchy in a `finally` rollback.

Environment controls:

- `COSYNCING_WINDOWS_POWERSHELL`: explicit path to `powershell.exe`.
- `COSYNCING_WINDOWS_PHASE0_RUN_ID`: safe run identifier used for staging and
  output names.
- `COSYNCING_WINDOWS_PHASE0_APPLICATION`: explicit JavaScript bundle to stage
  for runtime and npm-shim probes.
- `COSYNCING_WINDOWS_PHASE0_REQUIRE_CLEAN=1`: refuse the freeze pass unless the
  candidate is an exact clean commit archived with `git archive`.
- `COSYNCING_WINDOWS_PHASE0_MUTATE_SCHEDULER=1`: enable the disposable
  scheduler transaction.

Keep each staging directory until its result has been reviewed. Remove it only
through a later explicit cleanup step.

Phase 2 DACL qualification uses a separate clean-candidate launcher:

```bash
COSYNCING_WINDOWS_BUN='C:\\path\\to\\bun.exe' bash scripts/broker/windows/stage-phase2-dacl.sh
```

It stages the source and probe on NTFS, creates only a run-specific directory
under `%LOCALAPPDATA%\\CosyncingPhase2`, verifies protected SID-based DACLs,
atomic replacement, weakened-ACL detection and repair, and interrupted-write
cleanup, then removes the probe state in `finally`. Set
`COSYNCING_WINDOWS_PHASE2_REQUIRE_CLEAN=0` only for an exploratory dirty-tree
run; checkpoint evidence must use the default clean-commit requirement.

Phase 3 process qualification also stages and runs entirely on NTFS:

```bash
bash scripts/broker/windows/stage-phase3-process.sh
```

It runs the shared provider under Bun 1.3.8 and 1.4.0, proving stable process
identity, listener attribution, fail-closed unreadable executable evidence,
hidden child launch, and complete `taskkill /PID /T /F` tree cleanup. Set
`COSYNCING_WINDOWS_PHASE3_REQUIRE_CLEAN=0` only for an exploratory run.

Phase 4 qualifies the durable Task Scheduler service on NTFS:

```bash
bash scripts/broker/windows/stage-phase4-service.sh
```

It registers a real run-scoped task under Bun 1.3.8 and 1.4.0 and proves first
install convergence, repeated setup and drift repair, start/stop, bounded log
reads, immutable upgrade and rollback, bootstrap failure retry, fatal-start
logging, post-commit prior-version cleanup, and ownership-aware uninstall. It
also proves the service binds only loopback: the staged application binds
through the product's own `BROKER_LISTEN_HOST` and derived internal URL, and
the probe checks that report against Windows' own listener table. Connectivity
is operator-owned, so the probe additionally records that no provider is named
by the registered task XML, the staged environment, the service log, or any
committed receipt. It restores the prior scheduler posture in `finally`.

Phase 6 qualifies one adapter at a time. The Pi slice is:

```bash
bash scripts/broker/windows/stage-phase6.sh
```

It resolves the npm `pi` launcher through the shared invocation boundary,
checks Pi runtime readiness against the installed package's own `engines.node`,
installs the bridge asset into a disposable agent directory, and completes one
`--mode rpc` JSONL stdio trace using `get_messages`. It sends no prompt and
contacts no model provider, so it needs no credentials and leaves the
operator's real Pi installation untouched. The runner re-reads machine and user
PATH from the registry, because a PowerShell started from WSL cannot otherwise
see an npm prefix added after that WSL session began.

Slice 2 drives the adapter itself:

```bash
COSYNCING_WINDOWS_PHASE6_PROBE=phase6-pi-trace-probe.ts \
COSYNCING_WINDOWS_PHASE6_REPORT_PREFIX=pi-trace \
COSYNCING_WINDOWS_PHASE6_EXCLUSIVE_AGENT=1 \
bash scripts/broker/windows/stage-phase6.sh
```

Every Phase 6 slice shares this staging script; the two variables above choose which
probe runs and which evidence identity it writes under, and both default to
slice 1. Slice 2 calls `PiAdapter.createSession`, `discoverSessions`,
`attach(..., 'resume')`, `sendPrompt`, `sendFile`, `runCommand('stop')`,
`getHistory`, and `close` against a disposable session root and workspace on
NTFS, then reattaches to prove the transcript resumes and checks that no agent
process outlived the run.

Unlike slice 1 it reads the operator's own Pi agent directory, because
providers, model selection, and credentials live there — a disposable copy has
no providers, and copying their secrets somewhere new is worse than reading
them where they already are. The two writes that would reach it are switched
off: bridge auto-install (`COSYNCING_PI_BRIDGE_AUTOINSTALL=0`, the only write
`discoverSessions` performs) and the session root, so no transcript of the
probe joins the operator's history and none of their sessions is discovered,
attached, or driven. It then checks that directory: kind, size, and mtime of
each top-level entry plus one level of child names, which is enough to see a
nested bridge install or an overwritten `models.json`, and the report names
exactly that comparison rather than claiming more.

Using Pi writes to Pi's own directory, and the probe leaves none of it behind.
Proving model switch persists the chosen model into `settings.json`; asking for
the catalogue refreshes `models-store.json`. Rather than keep an allowlist of
whatever Pi happens to touch, the probe captures the bytes of EVERY top-level
file beforehand, up to a 1 MiB ceiling, and writes back any that changed. It
reports which names needed a restore, which could not be restored, and which
were too large to capture; the bytes themselves are never recorded or sent
anywhere. Restored files are compared by content rather than mtime, since
putting the same bytes back changes the mtime by construction. It records
provider and model identifiers and no credentials, prompts, or transcript
content.

Putting bytes back is only safe under three conditions, and the probe enforces
all three rather than assuming them:

- **Exclusive use.** A second writer's change would be destroyed by the
  restore, not undone. `COSYNCING_WINDOWS_PHASE6_EXCLUSIVE_AGENT=1` is the
  operator declaring that nothing else will write there, and the trace refuses
  to start without it — the staging script checks before staging, so a missing
  declaration costs no round trip. Nothing this harness can observe would tell
  the operator's own `pi` from any other `node.exe`, because the shim IS Node,
  so that half is a human guarantee and the report records it as one. The
  machine half is a lock held for the whole run, in `TEMP` rather than in the
  agent directory: two lanes cannot overlap, and a stale lock is reported
  rather than broken.
- **No reparse points.** `lstat`, never `stat`, decides what an entry is. A
  symlinked entry is captured from its target under `stat` and then restored
  THROUGH it, writing outside the agent directory entirely; links are recorded
  by name and otherwise left alone, and the entry kind is re-checked
  immediately before each write.
- **Created entries are removed, not just reported.** Restoring cannot address
  a file that did not exist before, so the probe deletes it — only a name
  proven absent by a listing that succeeded at capture, only a regular file,
  and only when the removal verifies. A directory or a link that appeared is
  named for the operator and left alone.

The probe declares a fixed list of required assertions and passes only when
every one is present and true, so a trace that stops early fails rather than
passing on the assertions it reached. Recording an observation is deliberately
not the same as requiring it. Turns are still measured rather than asserted in
one direction only: an unreachable provider is recorded as a finding, and the
required assertions it prevents then fail with it.

Slice 3 covers the advertised surface the first two did not touch, and all of it
is deterministic — no model has to answer for any of it:

```bash
COSYNCING_WINDOWS_PHASE6_PROBE=phase6-pi-lifecycle-probe.ts \
COSYNCING_WINDOWS_PHASE6_REPORT_PREFIX=pi-lifecycle \
COSYNCING_WINDOWS_PHASE6_EXCLUSIVE_AGENT=1 \
bash scripts/broker/windows/stage-phase6.sh
```

`attach(..., 'observe')` and every write door behind it, `forkSession` whole and
from a chosen message, `cloneSession`, and `exportTranscript`. Each was
advertised in the Pi capability block with no native Windows evidence behind it,
which is the gap the support matrix exists to keep closed.

Two things it checks that are easy to get wrong:

- **Read-only means every door.** An observer that still accepts a file upload
  or a slash command is not read-only, and nothing else stands in front of it.
  Prompt, file, and command are each required to be refused.
- **A copy is compared by shape, not by key.** A fork or a clone is a new
  session file and Pi may mint fresh entry ids in it, so a key comparison would
  call a faithful copy a mismatch. Message kind and length travel with the
  content; the length never leaves the process and only the verdict is
  reported.

The fork point is Pi's own transcript entry id, read from the session file
rather than from a mapped history key, because a mapped key can carry a
per-content suffix that Pi would refuse. Whether the id a CLIENT would send is
that same value is recorded as an observation — it is a contract question about
every platform, not a Windows one.

Both probes share `phase6-agent-dir-guard.ts`, which owns the exclusive-use
lock, the capture, and the rollback. One implementation rather than one per
probe: the rollback is the part most able to do harm, and two divergent copies
of it is precisely the defect this replaced.

Interrupting the staging script stops the Windows side too. Killing the WSL
interop process does not: the runner is a separate Win32 process tree that keeps
running, and a later invocation then races it for the operator's agent directory
— which is how two probes once ran at once, the second refused by the
exclusive-use lock rather than by anything else. The runner records its own PID
and the script's `INT`/`TERM` trap terminates that tree.

A successful run removes its own staging — the extracted candidate, the
downloaded Bun runtimes, and the probe state — under
`%LOCALAPPDATA%\CosyncingPhase6\<run id>`. A failed run keeps it, because that
tree is the only place left to diagnose from; `COSYNCING_WINDOWS_PHASE6_KEEP_STAGING=1`
keeps it either way. The Phase 0-4 stage scripts have no equivalent and their
run roots accumulate.

Slice 4 is the last two capabilities, which are one mechanism wearing two hats:

```bash
COSYNCING_WINDOWS_PHASE6_PROBE=phase6-pi-bridge-probe.ts \
COSYNCING_WINDOWS_PHASE6_REPORT_PREFIX=pi-bridge \
COSYNCING_WINDOWS_PHASE6_EXCLUSIVE_AGENT=1 \
bash scripts/broker/windows/stage-phase6.sh
```

`attach(..., 'live')` refuses by construction: a live Pi session reaches
cosyncing only through the bridge extension loaded inside that Pi, which hellos
to a broker and then relays events out and pulls commands back in. So the slice
runs the whole path — a fixture broker on a reserved loopback port with its own
state root, the extension installed by the adapter's own production path, and a
real Pi process — and it asks one Windows question above all others.

**Does the bridge id match the adapter's session id?** The extension hellos with
the session path as Pi sees it: a drive letter, backslashes, whatever case the
shell produced. The broker derives a bridge id from that string; the adapter
derives a session id from its own discovery of the same file. If those disagree
on Windows, the live row and the discovered row are two different sessions and
true-sync silently attaches to nothing. The probe asks `/pi/bridge/status` with
the ADAPTER's id, so a true answer is the two having agreed. None of that risk
exists on a POSIX path.

Approvals are made deterministic rather than hoped for:
`COSYNCING_BRIDGE_APPROVALS=all` makes every tool call ask, so the probe can
prompt for an ordinary file read instead of trying to make a model produce a
dangerous shell command on purpose. Approving is then required to have an
effect — a resolved card with no tool result would mean the decision was
recorded and dropped.

The OpenCode slice qualifies the managed serve rather than a session surface:

```bash
COSYNCING_WINDOWS_PHASE6_PROBE=phase6-opencode-probe.ts \
COSYNCING_WINDOWS_PHASE6_REPORT_PREFIX=opencode \
bash scripts/broker/windows/stage-phase6.sh
```

It asks whether the broker can PROVE the serve it started is its own. Ownership
compares a durable record against the live listener's identity, but the record
is written from the spawn handle — and on Windows `opencode` resolves to
`opencode.cmd`, whose last line CALLS `opencode.exe`, so the spawn handle is the
shell and the listener is its child. Each broker lifetime therefore runs as its
own process (`phase6-opencode-broker.ts`), because module state is what a
restart clears and a second in-process call would just see `managed` still set
and return. The port comes from a real bind rather than the `--port` default of
4096, which is inside a Windows excluded range on this host and is also where
the operator's own serve would be listening.

Not claimed: Pi's interactive TUI. The probe runs Pi in RPC mode, which loads
the same extension and fires the same `tool_call` approval hook; the terminal
shell around it is not exercised and is not evidenced.

For a checkpoint, commit the exact tree first, build the bundle from that clean
commit, and run with `COSYNCING_WINDOWS_PHASE0_REQUIRE_CLEAN=1`. Then run
`verify-phase0.ts` and `generate-phase0-report.ts`; the generator refuses to
produce a verified report unless the clean candidate revision, bundle identity,
lane reports, rollback assertions, and verification revision all agree.
