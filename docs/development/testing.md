# Tests and CI

One command runs the tests, locally and in CI:

```bash
bun run check                        # every suite this host can run
bun run check broker adapters        # selected suites
bun run check broker --only pairing  # tasks whose id contains "pairing"
bun run check client --shard 2/3     # one CI shard
bun run check adapters --repeat 5    # flake hunt: every task five times, no retry
bun run check --list                 # print the plan
```

## Suites

Each suite is one feature area and one CI job. The manifest is
`scripts/ci/suites.ts`.

| Suite | Covers |
|---|---|
| `policy` | Types, the client contract, public-tree and source-boundary policy, workflow policy |
| `broker` | Install, lifecycle, pairing, sessions, history, attention, artifacts |
| `adapters` | Every agent adapter and the Claude Code mod |
| `packaging` | npm package, compiled assets, installers, release supply chain |
| `client` | Flutter client (format, analyze, tests, sharded three ways) and the Dart packages |
| `web` | The built web client in a real browser against fixture brokers |
| `windows` | The broker on Windows: host primitives, secure files, service, installer |

Tests are feature-level end-to-end suites under `e2e/<suite>/`, named
`*.test.ts` and written with `bun:test`. Each one starts a real broker on its
own port with its own state directory, fake agent binaries, and a client that
speaks the same protocol as the app. The runner discovers them, so adding a
file is all it takes to add a test. Older script-style suites are listed in
`scripts/ci/legacy-tasks.ts` until their feature suite replaces them.

## How a run behaves

- Tasks run in parallel. A task marked `serial` never overlaps another serial
  task.
- Every task has a wall-clock bound (three minutes by default). On timeout
  the runner records the process tree, then kills the task's whole process
  group, so a hang cannot leave a broker or browser behind.
- A failed task is retried once. A pass on retry is reported as **FLAKY**: it
  is annotated on the pull request and in the job summary, but it does not
  fail the run. Deterministic checks (lint, format, policy) are never retried.
  The nightly workflow runs the broker, adapter and packaging suites three
  times with no retry, so intermittent failures surface there.
- A failure prints the last lines of its log inline. Full logs and
  `report.json` / `report.md` are written to `output/check/` and kept as a CI
  artifact for seven days.
- Tasks run without inherited `COSYNCING_*`, `PORT`, `HOST` or
  `OPENCODE_URL`, so a broker running on the same machine cannot leak into a
  test.

## Releases

`bun run release:checkpoint` requires a passing **complete** `bun run check`
(every suite this host can run, unsharded and unfiltered) for exactly the
current commit. A dirty tree can be rehearsed but is never publication
eligible.

Not covered by `bun run check`: release publication, replacing a running
broker, native platform builds (CI builds them in separate jobs), and
physical-device, multi-host or real-agent evidence.
