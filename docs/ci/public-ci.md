# Public CI architecture

## Current private-repository mode

The active workflows use repository self-hosted runners during private
development. They select only generic platform labels: Linux/X64,
Linux/ARM64, macOS/ARM64, and Windows/X64. The workflow steps, permissions,
release separation, and check names match the public design.

The exact GitHub-hosted profile is stored outside GitHub's executable workflow
directory at `scripts/ci/github-hosted-workflows/`. The tracked
`.github/workflow-mode` file records which profile is active. The workflow
audit fails if an active private profile contains a GitHub-hosted runner or an
active public profile contains a self-hosted runner.

Repository-level runners must be registered separately with the private
consolidation repository. A runner registered only to a predecessor repository
cannot accept this repository's jobs.

## Public activation

Before changing visibility, run:

    bash scripts/ci/restore-github-hosted-workflows.sh
    bash scripts/ci/audit-workflows.sh

Review and commit that diff before enabling public access. The first command
restores every saved hosted workflow and changes the mode to `public-hosted`.
The second proves that the executable workflow files are byte-identical to the
saved public profile. No workflow redesign is required at visibility time.

## Public workflow profile

All required public checks use standard GitHub-hosted runners. `ci.yml` runs broker,
contract, Flutter analysis/tests, web, Linux, Android, macOS, iOS simulator, and
Windows gates. Reusable Dart packages run independent analysis/test matrix
lanes so their own tests cannot be hidden by the application suite.
`broker-release-gate.yml` builds and hashes native release
packages without repeating the broker suite.
`nightly.yml` repeats extended deterministic checks on the protected repository
default branch.

Branch protection requires only the stable `CI / required` and
`Broker Release Gate / required` aggregate jobs. Each uses `if: always()` and
fails unless every dependency result is `success`; matrix child names are not
repository settings. The broker/contract lane also runs the workflow audit,
the fail-closed tracked-tree/path/content/binary policy, capability coverage,
and trace/support-matrix checks.

In the public profile, `platform-runtime.yml` is an optional scheduled/manual
hosted lane for the retained Flutter integration test on Android emulator,
macOS, and iOS simulator. It replaces personal-device runtime coverage without
making an unvalidated emulator lane a required check. Enable it as a support
claim only after successful private-phase GitHub runs.

Pull-request workflows have explicit read-only permissions, do not receive
secrets, disable persisted checkout credentials, cancel stale runs, and never
execute fork code on self-hosted infrastructure. Actions are pinned to full
commit SHAs. Workflows are deliberately not path-filtered: cross-product and
contract checks cannot be skipped by an incomplete path classification.

Release candidate and stable promotion are separate maintainer-controlled
workflows. Only jobs that create or edit a GitHub Release receive
`contents: write`; signing secrets are scoped to protected environments.
Actions artifacts are not a distribution channel or cross-workflow state store.
Broker binaries stage directly in a draft GitHub Release and only the verified
final asset set is published.

CI logs follow the repository's GitHub retention setting. No workflow uploads
test logs by default. Release assets follow GitHub Release retention and are
cryptographically inventoried.
