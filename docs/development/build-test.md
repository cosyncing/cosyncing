# Public build and test instructions

Use Flutter 3.44.3 from `.fvmrc`, Dart supplied by that SDK, and Bun 1.3.8 from
`package.json`. No sibling checkout, private service, or locally preinstalled
agent CLI is required for deterministic gates.

After any implementation, run the round-agnostic current-host evaluation:

```bash
bun run check
```

The canonical claim ownership, scheduling, artifacts, diagnostics, and
exclusions are documented in
[Release verification graph](verification-graph.md).

It continues through independent failures and writes full logs plus
machine-readable and human summaries to `output/check/`. The report includes
complete logs for every broker sub-suite, so a failed aggregate does not need
to be rerun for diagnosis. It covers repository policy, contracts,
capabilities, the deterministic broker lane, the complete Flutter client, all
four reusable Dart packages, and real-browser web startup/cache behavior.

The runner fingerprints the commit, index, tracked changes, and untracked
source bytes before and after all suites. Any difference is the required
`source-stability` failure; a passing report therefore describes one
source state. `public-tree` is a required gate that must report no findings at
all: every tracked binary is pinned in `scripts/ci/public-binary-allowlist.sha256`
and every reviewed text exception in `scripts/ci/public-content-exceptions.sha256`.
Known source-boundary findings are frozen as per-finding hashes in
`scripts/check-advisory-baselines.json`. Only an exact match remains advisory.
Any added, removed, or changed finding fails until the baseline is
intentionally reviewed and updated.

Child suites run without inherited `COSYNCING_*`, `PORT`, `HOST`, or
`OPENCODE_URL` values. This prevents a running review broker or a parent
acceptance fixture from changing authentication, state roots, ports, or adapter
connections inside the deterministic gate.

The command does not publish releases, replace a running broker, claim
cross-platform builds unavailable on the current host, or pay physical,
multi-host, and real-agent evidence debt. Those remain explicit follow-up
gates. The exactly baselined source-size debt remains advisory so unrelated
implementation checks can still produce a useful pass/fail result.

The component commands remain available for focused diagnosis:

```bash
bun install --frozen-lockfile
bun run client:pub-get
bun run client:format
bun run typecheck
bun run ci:audit-workflows
bun run ci:check-boundaries
bun run contract:check
bun run client:analyze
bun run client:test
bun run test:broker:deterministic
```

The four reusable Dart packages have independent analysis and test gates. Run
these commands from each directory under `packages/dart/`: `broker_contract`,
`broker_client`, `broker_client_flutter`, and `broker_crypto`.

```bash
flutter pub get
flutter analyze
flutter test
```

Platform smoke builds mirror CI:

```bash
bun run scripts/client/run-client-command.ts flutter build web --release
bun run scripts/client/run-client-command.ts flutter build linux --debug
bun run scripts/client/run-client-command.ts flutter build apk --debug
bun run scripts/client/run-client-command.ts flutter build macos --debug
bun run scripts/client/run-client-command.ts flutter build ios --simulator --debug
bun run scripts/client/run-client-command.ts flutter build windows --debug
```

Run only commands supported by the current host. GitHub-hosted jobs provide the
authoritative cross-platform result. Tests may create ignored files under
`output/`; they are ephemeral and must not be committed.

Linux desktop builds also require the standard GTK, WebKitGTK 4.1, and libsoup
3 development packages installed by `ci.yml`.
