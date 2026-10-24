# Tests and CI

One command runs the tests, locally and in CI:

```bash
bun run check                        # every suite this host can run
bun run check broker adapters        # selected suites
bun run check broker --only pairing  # tasks whose id contains "pairing"
bun run check client --shard 2/3     # one CI shard
bun run check adapters --only kimi-host --repeat 10 # focused stability run, no retry
bun run check broker --no-retry      # expose every first-attempt failure
bun run check --list                 # print the plan
```

## Suites

Each suite owns a feature area. CI runs the suites as jobs, with the client
split across three jobs. The manifest is `scripts/ci/suites.ts`; the shared
runner is `scripts/ci/run.ts`.

| Suite | Covers |
|---|---|
| `policy` | Types, the client contract, public-tree and source-boundary policy, workflow policy |
| `broker` | Install, lifecycle, pairing, sessions, history, attention, artifacts |
| `adapters` | Every agent adapter and the Claude Code mod |
| `packaging` | JavaScript installation, compiled assets, installers, release supply chain |
| `client` | Flutter client (format, analyze, tests, sharded three ways) and the Dart packages |
| `android` | Native Android JVM scenarios; requires an Android SDK and JDK; uses the existing Android build job |
| `web` | The built web client in a real browser against fixture brokers |
| `windows` | The broker on Windows: host primitives, secure files, service, installer |

Broker and adapter feature scenarios live under `e2e/<suite>/`, named
`*.test.ts` and written with `bun:test`. They use a real broker with isolated
state and ports, controlled agent fakes, and the same protocol as the app.
The runner discovers these files automatically. Flutter feature flows live
under `apps/client/test/features/` and use the shared app driver and fake
broker in `apps/client/test/support/feature/`. Older script-style suites remain
in `scripts/ci/legacy-tasks.ts`; justified narrow package tests also remain
discoverable. Discovery is not a reason to add a test file for every source
file.

## Adding or changing a feature

These rules apply to human and coding-agent contributions alike.

1. Start with the observable behavior: what the user, client, agent, CLI, or
   persisted product state should do, including relevant failure and recovery
   paths. Extend an existing feature scenario before creating another suite.
   For example, prove that a saved draft survives reconnect and appears in the
   composer; do not test every helper used to save it.
2. Drive the product boundary through HTTP, WebSocket, CLI, or the app driver.
   Reuse `e2e/harness/`, adapter kits, and Flutter feature support. Do not mock
   the behavior being proved or import private implementation functions into
   feature scenarios. Assert outcomes, not internal call counts or source text.
3. Do not add a test per function, class, widget, or implementation file. A
   refactor with unchanged behavior should normally reuse existing coverage.
   Narrow deterministic cases are exceptions for behavior a feature scenario
   cannot meaningfully reach, such as crypto vectors, recorded-data decoding,
   or a clock-driven policy. Explain the uncovered behavior and why the
   functional suite cannot prove it; existing narrow tests are not a template
   for growing helper-by-helper coverage. Policy checks may inspect source to
   enforce architecture, contracts, or publication rules.
4. When replacing tests, map the retained behavior to its replacement and
   retire duplicate files, legacy task registrations and package scripts in
   the same change. Preserve platform-specific coverage and update any
   capability, trace or conformance references before deleting their evidence.
5. Use the existing suite and shared runner. Do not add a workflow job,
   aggregate gate, `test:*` script, or verification registry for each feature.
   A new lane needs a distinct platform or execution requirement that the
   existing suites cannot serve. The old verification graph and completeness
   anchor are retired; do not recreate them.

## Keep execution fast

- Use `--list` to check the selection, then run the affected feature or suite
  while iterating. `--only` matches substrings of task IDs, so a short filter
  can select several tasks. Run the complete check for the final implementation
  candidate; do not repeat it after every small edit or after a passing run
  unless new changes or unresolved failures justify it.
- Reuse expensive setup within a feature while isolating each scenario's
  mutable state. Keep fixtures representative and small. Avoid repeated broker
  starts, full builds, or large disk writes just to exercise a simple policy.
- Aim for a normal feature task below one minute and the required hosted PR
  checks within ten minutes of execution. These are planning targets, not
  millisecond assertions or reasons to lower hang deadlines. Measure affected
  task duration and the slowest hosted job when adding substantial coverage;
  explain increases and remove redundant work before adding parallelism.
- Keep extended fuzz, stress and repeated stability runs in the existing
  nightly or manual lanes. Keep a representative deterministic regression in
  PR CI. Do not move a correctness regression out of required CI merely because
  it is flaky or slow.
- Documentation-only changes need whitespace, relevant link/command checks,
  and the public-tree policy. The existing classifier keeps hosted checks
  lightweight; a prose edit does not require the full product suite.

## Keep execution reliable

- Wait for a condition, protocol frame, or readiness signal with the shared
  bounded helpers. Do not synchronize with fixed sleeps or assert tiny elapsed
  times. Advance a controlled clock for expiry/backoff; use a later sentinel
  event to prove that an earlier unwanted event did not occur.
- Give every process and asynchronous wait a deadline with useful diagnostics.
  Deadlines detect hangs; they are not performance benchmarks. Capture child
  output and clean up fixtures and process trees on success, failure and
  cancellation. Do not kill unrelated listeners or developer processes.
- Use isolated temporary roots, leased ports, explicit fake binaries and
  controlled environment variables. Never depend on a developer's agent CLI,
  credentials, running service, public network response, or production state.
  Gate OS-specific fixtures on the actual host: POSIX mode bits do not model
  Windows ACLs or executable locks.
- For new or substantially changed asynchronous feature coverage, and every
  flake fix, run the affected task ten times without retries (`--repeat 10`)
  and also exercise its suite under normal parallel load. Record selection,
  duration and any failures. This is local acceptance evidence, not ten copies
  of each test in every PR job. Small deterministic or prose changes do not
  need a flake campaign.
- **A retry pass is an open reliability defect, not a fix.** Keep the first
  failure log, command, commit, platform and duration; record an owner and
  follow-up. Diagnose the cause and prove repeated passes without retries
  before closing it. Do not hide a failure by adding retries, arbitrary sleeps,
  inflated timeouts, skips, known-bug exclusions, or weaker assertions. A
  timeout change needs measured evidence; an accepted product limitation must
  stay explicit and tracked separately from passing coverage.

## Pull-request evidence

State the behavior covered, the existing suite extended, commands and results,
affected task duration when coverage changes materially, and any flaky or
uncovered cases. Explain narrow-test exceptions and duplicated coverage removed.
For a refactor or documentation change, say when existing coverage is sufficient.
Do not treat a green aggregate or a skipped known-bug assertion as proof that an
open defect is fixed.

## How a run behaves

- Tasks run in parallel. A task marked `serial` never overlaps another serial
  task.
- Every task has a wall-clock bound (three minutes by default). On timeout
  the runner records the process tree, then kills the task's whole process
  group, so a hang cannot leave a broker or browser behind. Stopping the run
  (Ctrl-C, SIGTERM) stops running tasks and prevents new tasks or retries from
  starting. Windows cancellation terminates the task's process tree. A child
  left in a supervised group after its task exits is reaped and fails that
  attempt, even when the task itself exited successfully.
- A broker the e2e harness starts exits when the test process that started it
  exits, however it ends: the harness gives it a stdin pipe it never writes,
  and a source-run broker with `COSYNCING_TEST_EXIT_ON_STDIN_EOF=1` shuts down
  at end of file, stopping the hosts it manages. The runner also records every
  harness root (`cosyncing-e2e-*` in the temp directory) a task creates. A
  process still running under one of them after the task is a **LEAK**: it is
  stopped, and the task fails. A harness process from an earlier run is only
  reported when a run starts, never signalled.
- A failed task is retried once. A pass on retry is reported as **FLAKY**: it
  is annotated on the pull request and in the job summary, but it does not
  fail the run. Deterministic checks (lint, format, policy) are never retried.
  The nightly workflow runs the broker, adapter and packaging suites three
  times with no retry, so intermittent failures surface there. This runner
  behavior does not close the reliability follow-up described above.
- A failure prints the last lines of its log inline. Full logs and
  `report.json` / `report.md` are written to `output/check/` and kept as a CI
  artifact for seven days in PR CI and fourteen days in nightly CI.
- Tasks run without inherited `COSYNCING_*`, `PORT`, `HOST` or
  `OPENCODE_URL`, so a broker running on the same machine cannot leak into a
  test.

## Releases

`bun run release:checkpoint` requires a passing **complete** `bun run check`
(every suite this host can run, unsharded and unfiltered) for exactly the
current commit. A dirty tree can be rehearsed but is never publication
eligible.

Native Android JVM scenarios run through `bun run check android`; unfiltered
local checks include them when an Android SDK is configured. The existing
Android build job supplies that platform's SDK/JDK and runs the same suite.

Not covered by `bun run check`: release publication, replacing a running
broker, native platform builds (CI builds them in separate jobs), and
physical-device, multi-host or real-agent evidence.
