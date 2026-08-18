# Implementation status

Last updated: 2026-08-14.

## Publication state

The source repository is public at
[`cosyncing/cosyncing`](https://github.com/cosyncing/cosyncing), with the
project site at [cosyncing.github.io](https://cosyncing.github.io/). English
and Simplified Chinese README layers describe the same supported product and
link to the matching website locale.

Internal plans, physical-host evidence, and maintainer logs live in a separate
private repository checked out locally as the ignored `docs-internal/` tree.
They are not part of the public source lineage.

The public repository uses the `public-hosted` workflow profile. The required
`CI required` and `Broker Release Gate required` checks have passed on a
fork pull request without repository secrets. Branch rules, Discussions, and
private vulnerability reporting are enabled.

## Product state

The Flutter application, reusable Dart packages, broker, adapters, setup and
lifecycle commands, release tooling, and public documentation live in this
monorepo. Linux and Apple Silicon macOS are supported broker hosts. Native
Windows broker hosting remains roadmap work; the Flutter client has separate
desktop and mobile platform build coverage.

Codex, Claude Code, OpenCode, and Pi are registered through the shared adapter
contract. Capabilities remain adapter-specific and are reported by the broker
rather than inferred by the client. Setup, status, doctor, repair, restart, and
uninstall share the persisted setup language and receipt-owned resource model.

The supported cross-device installation path requires Tailscale on the server
and clients. Packaged setup retains loopback-only operation for local diagnosis,
but it is not the documented cross-device path. Tokdash quota tracking remains
optional and consented: setup reuses an existing instance or, when pipx is
available, can install and configure one without making broker installation
depend on it. The web app is mounted at `/cosy`; paired clients receive per-device
credentials, while the raw broker token remains a full-authority bootstrap
credential.

## Verification state

The public tree passes the required source-content policy with every retained
binary pinned to reviewed content. Hosted Linux, Android, macOS, iOS simulator,
Windows, web, broker, contract, and reusable-package jobs pass. The deterministic
broker aggregate contains 66 registered sub-suites.

The local complete check covers every registered gate. Source architecture is
enforced through package dependency direction, adapter isolation, public
facades, platform boundaries, generated-contract checks, and focused behavior
suites. Files have no line-count ceiling; production modules are grouped by
owned broker domain and Flutter user capability instead.

## Release state

Public source publication does not authorize compiled distribution. GitHub
binary releases of the compiled native broker remain blocked by
[compiled broker distribution readiness](../legal/binary-distribution-readiness.md):
the embedded Bun runtime's distribution obligations need a recorded resolution,
and protected signing environments and keys have not been provisioned.

The npm package is a different artifact and is no longer inside that gate. It
ships one self-contained JavaScript application bundle executed by a Bun runtime
the operator installs separately, with no embedded runtime and no compiled
executable — see
[npm JavaScript distribution readiness](../legal/npm-javascript-distribution-readiness.md).
`.github/workflows/npm-publish.yml` builds, verifies, and submits releases
through npm's protected staging and 2FA approval flow. The current JavaScript
package is `cosyncing@0.4.0`. Flutter-only Android, Linux, Apple Silicon macOS,
and Windows client downloads are published separately in the GitHub client
release; iOS/TestFlight remains deferred.

The release workflows fail closed unless the protected
`COSYNCING_BINARY_RELEASE_LEGAL_APPROVED` variable is exactly `true`. Keep it
unset until the documented review is complete. Local builds and ephemeral CI
packaging remain valid engineering evidence, but they are not public releases.
