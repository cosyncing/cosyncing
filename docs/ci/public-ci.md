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

Branch protection requires only the stable `CI / required` and
`Broker Release Gate / required` aggregate jobs. Each uses `if: always()` and
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
commit SHAs. Workflows are deliberately not path-filtered: cross-product and
contract checks cannot be skipped by an incomplete path classification.

## Release workflows

Release candidate and stable promotion are separate maintainer-controlled
workflows. Only jobs that create or edit a GitHub Release receive
`contents: write`; signing secrets are scoped to protected environments.
Actions artifacts are not a distribution channel or cross-workflow state store.
Broker binaries stage directly in a draft GitHub Release and only the verified
final asset set is eligible for publication.

The compiled-release workflows are intentionally unusable until the legal and
signing prerequisites in
[broker release and signing](../release/broker-release-signing.md) are met.
Source CI and local package tests do not satisfy that approval gate.

CI logs follow the repository's GitHub retention setting. No workflow uploads
test logs by default. Release assets follow GitHub Release retention and are
cryptographically inventoried by the release workflow.
