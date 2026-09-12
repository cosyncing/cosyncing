# Public CI architecture

## Active public profile

The active workflows use standard GitHub-hosted runners, and
`.github/workflow-mode` is `public-hosted`. The audit rejects executable
self-hosted jobs and verifies the public workflow structure. The former private
self-hosted profile and one-time restoration tooling are retired from the
public tree; historical copies live only in the private internal-docs archive.

## Required workflow profile

`ci.yml` runs broker, contract, Flutter analysis/tests, web, Linux, Android,
macOS, iOS simulator, Windows, and reusable Dart-package gates.
`broker-release-gate.yml` builds native package evidence without publishing it.
`nightly.yml` repeats extended deterministic checks on the protected default
branch.

Branch protection requires only the stable `CI required` and
`Broker Release Gate required` aggregate jobs. Each uses `if: always()` and
fails unless every dependency result is `success`; matrix child names are not
repository settings. The broker/contract lane also runs the workflow audit,
the fail-closed tracked-tree/path/content/binary policy, capability coverage,
and trace/support-matrix checks.

`platform-runtime.yml` is an optional scheduled/manual hosted lane for retained
Flutter integration tests on Android emulator, macOS, and iOS simulator. It is
not a required merge check and does not replace packaged physical acceptance.

Pull-request workflows have explicit read-only permissions, do not receive
secrets, disable persisted checkout credentials, cancel stale runs, and never
execute fork code on self-hosted infrastructure. Actions are pinned to full
commit SHAs. Required workflows are deliberately not path-filtered at the
event level. A fail-closed classifier identifies documentation-only changes;
those changes run the tracked public-tree policy while the expensive build,
browser, package, and contract jobs are intentionally skipped. Both aggregate
required jobs verify that every expected child was skipped before accepting
that lightweight path. Any unrecognized or mixed path takes the full profile.

## Release workflows

Release candidate and stable promotion are separate maintainer-controlled
workflows. Only jobs that create or edit a GitHub Release receive
`contents: write`; signing secrets are scoped to protected environments.
Actions artifacts are not a distribution channel or cross-workflow state store.

The npm workflow rebuilds and verifies one exact JavaScript package, then may
submit it to npm's staging queue through trusted publishing. Protected
environment review and a separate interactive npm approval are both required
before it becomes installable. The client workflows build Android, Linux,
macOS, and Windows assets into a matching prerelease; stable promotion verifies
and publishes that exact accepted asset set without rebuilding it. The signed
GitHub broker lane stages JavaScript, the web sidecar and matching desktop
clients, then promotes the exact verified asset set without rebuilding.

The JavaScript lane retains protected signing and acceptance prerequisites in
[broker release and signing](../release/broker-release-signing.md). Its asset
policy rejects compiled brokers and bundled Bun archives. Future embedded-runtime
broker distribution still requires the separate legal approval; source CI and
local package tests do not satisfy that gate.

CI job logs follow the repository's GitHub retention setting. The main,
nightly, and client-release gates upload `output/check` verification evidence
for seven days when it exists. The npm verification job uploads the exact
candidate tarball for its staging job. These short-lived Actions artifacts are
diagnostic or same-run handoff material, not a public distribution channel.
Release assets follow GitHub Release retention and are cryptographically
inventoried by the release workflow.
