# Release verification graph

The source inventory is
`scripts/verification/verification-graph.json`. It is the authority for claim
ownership, canonical commands, focused diagnostics, dependencies, expected
artifacts, resource classes, platform exclusions, and source-test ownership.
`bun run verification:validate` copies the validated inventory to
`output/verification/inventory.json` and writes
`output/verification/validation.json`.

`scripts/verification/verification-completeness-anchor.json` independently
pins the accepted claim IDs and every gate/broker sub-suite execution binding
at the RC1 base. Each binding fingerprint covers its command, recursively
resolved package-script bodies, working directory and claim mapping where
applicable, and sorted source owners. Deleting or relabelling a regression, or
substituting another command/source owner under the same ID, therefore fails
validation. The accepted base must resolve as an ancestor of the checked-out
source. A deliberate future replacement must update both the graph and
reviewed anchor.
Regenerate the anchor with `bun run verification:generate-completeness-anchor
-- --accepted-base <commit>` after an approved graph change; do not edit its
fingerprints by hand.

Completeness anchors are repository-lineage-local. A private-lineage anchor
must never be copied unchanged into the separately initialized public checkout.
Before opening a public PR, regenerate the transferred anchor in that checkout
with `--accepted-base` set to a commit that already belongs to the public
lineage, then run verification there. Validation intentionally fails when the
accepted base does not resolve or is not an ancestor of the candidate.

## Canonical entry points

`bun run check` is the unchanged-source, current-host cumulative gate. It reads
the inventory rather than carrying a second suite list. CI, nightly, and the
tag-release contract job invoke this same command. Its durable evidence is:

- `output/check/report.json`
- `output/check/report.md`
- `output/check/logs/<gate-id>.log`
- `output/check/broker/report.json`
- `output/check/broker/report.md`
- `output/check/logs/broker/<sub-suite-id>.log`

`bun run release:checkpoint` consumes a successful `bun run check` report for
the exact current source fingerprint. It does not rerun contract, broker,
Flutter, Dart, browser, cache, workflow, or sidecar-packaging suites. It builds
one Linux broker and verifies its exact candidate identity against the
canonical web output left by `check`. Clean sidecar packaging remains owned by
the supply-chain gate and protected release workflow. Checkpoint evidence is
under `output/release-checkpoint/`.

`bun run app:rebuild-restart` remains a separate ownership-aware review
deployment. It is not a test alias and is never inferred from either report.

## Scheduling

What may overlap is read from the inventory, never inferred:

- declared dependencies, so a consumer never starts before its producer;
- a group's `mode`, so gates in a serial group never overlap each other;
- `resourceClass: heavyweight`, which takes the host exclusively. `client` and
  `broker-deterministic` are both heavyweight because the broker suites wait a
  fixed number of seconds for a broker to report healthy, and merely running
  the browser gate alongside was enough to produce "broker did not start".

`timeoutClass` plays no part in scheduling: it bounds how long a gate may take,
which is a different question from what it may share a host with. Set
`COSYNCING_CHECK_CONCURRENCY` to pin the width.

A gate whose dependency failed is reported blocked instead of run, so a
consumer can no longer pass against its producer's stale output.

The broker gate has three explicit sub-suite groups:

- `broker-standard-parallel` for suites that own every resource they touch;
- `broker-standard-serial` for ordinary deterministic fixtures;
- `broker-heavyweight-serial` for CLI/package compilation, compiled assets,
  and release supply-chain checks.

Parallel membership is linted, and the lint is enforced against the inventory
by `verification:check`:

```bash
bun run verification:isolation-audit   # report
bun run verification:isolation-check   # fail if the graph claims too much
```

The audit resolves each sub-suite's entry point, walks its in-repo import
closure, and scans the harness — not the product it drives — for a port it did
not lease from the OS, a temp path that is not unique per run, a fixed path
under `output/`, or the host environment handed to a child wholesale.

Treat a clean result as "nothing disqualifying was found", not as proof. The
import walker follows relative `import`/`import()` only, so re-exports through
packages, `require`, and computed specifiers are invisible to it, and the port
rule is satisfied per suite, so one `listen(0)` clears a harness that also
starts a second, unsafe server. Static rules also cannot show that a suite
tolerates a loaded host: suites observed flaky under concurrency are demoted by
name in the audit, with the evidence, and `--repeat` runs are what find them.

The heavyweight group cannot be parallel in a valid inventory. Each sub-suite
has its own timeout and stdout/stderr log; there is no aggregate lane deadline
that can starve a later suite. `COSYNCING_ACCEPTANCE_CONCURRENCY` pins the lane
width. Use `--only` for diagnosis and `--repeat 2` or `--repeat 3` for bounded
scheduler probes — repeating the parallel group is how a suite that only fails
under load gets caught:

```bash
bun run test:broker:deterministic --only release-supply-chain --repeat 2
bun run test:broker:deterministic \
  --only pi-tool-result,pi-bridge-reload,claude-hooks,claude-hooks-surface
```

Gate dependencies are cycle-checked and topologically scheduled. Declared
array order is only the stable tie-breaker between otherwise independent
gates; it cannot place a consumer ahead of its dependency.

## Timeouts

Each gate's declared `timeoutClass` sets its wall-clock bound: `short` two
minutes, `medium` fifteen, `cumulative` twenty, `long` thirty. `cumulative` is
below `long` on purpose — cumulative gates aggregate suites that each carry
their own inner timeout, so the outer bound only has to catch an aggregate
wedged as a whole, while `long` covers a single build-and-verify with no inner
bound. `COSYNCING_CHECK_TIMEOUT_SCALE` widens every class on a slow host.

Every gate and sub-suite runs in its own process group, so a bound that expires
kills the whole tree rather than a wrapper whose children keep running. The
group is swept after the leader exits too: a gate that exits cleanly but leaks
a browser or a test host is reported with `strays` in its log and report entry.

Focused commands diagnose the owning gate. They do not create another
release-owning aggregate.

## Fail-closed validation

The graph validator rejects:

- a declared claim with zero or multiple owning gates;
- duplicate gate or execution-group IDs;
- a dangling package command, script path, source owner, gate, or dependency;
- a gate without an expected artifact or log;
- an exclusion not declared in the exclusion registry;
- a heavyweight gate or sub-suite group that is not serial;
- a broker sub-suite that is absent from or duplicated across its groups; and
- removal or execution-binding substitution of a claim, gate, or broker
  sub-suite pinned by the independent completeness anchor;
- a dependency cycle or a profile missing a scheduled dependency; and
- milestone-only round names in release-facing gate IDs, commands, artifacts,
  source-owner paths, or owned script contents.

The cumulative runner checks declared artifacts after each gate and compares a
complete commit/index/tracked/untracked-byte fingerprint before and after the
run. Exact advisory baselines and append-only contract history remain owning
required checks rather than documentation conventions.

## Platform boundaries

The inventory declares four exclusions and their owners:

- protected release publication and promotion;
- broker replacement/restart;
- Linux ARM64, Android, macOS, iOS, and Windows builds;
- physical-device, multi-host, reboot, and real-agent evidence.

CI platform matrices and release workflows own the first and third categories.
The ownership-aware rebuild command owns review deployment. Deterministic
reports never claim the last category.

## Fixture isolation

Pi and Claude broker fixtures use
`packages/typescript/broker/test/helpers/isolated-broker-fixture.ts`. It constructs child
environments from a small process-runtime allowlist, replaces HOME, XDG,
broker, Claude, and Pi roots with throwaway directories, and then applies
explicit fixture values. Provider credentials, helpers, endpoints, proxies,
and inherited `COSYNCING_*` state are absent unless the fixture explicitly
sets them.
Pi extension imports use unique file URLs when a test needs fresh module state,
so a prior text import cannot hide exported approval-policy helpers.
