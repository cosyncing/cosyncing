# Implementation status

Last updated: 2026-09-14.

## Publication state

The source repository is public at
[`cosyncing/cosyncing`](https://github.com/cosyncing/cosyncing), with the
project site at [cosyncing.com](https://cosyncing.com/). English, Simplified
Chinese, Japanese, Korean, and Spanish READMEs describe the same supported
product and link to the matching website locale.

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
monorepo. Linux, Apple Silicon macOS, and Windows x64 are supported broker
hosts. Windows ARM64 is not qualified yet and is refused, including an x64
process emulated on an ARM64 machine; the Flutter client has separate desktop
and mobile platform build coverage.

Codex, Claude Code, OpenCode, and Pi are registered through the shared adapter
contract. Capabilities remain adapter-specific and are reported by the broker
rather than inferred by the client. Setup, status, doctor, repair, restart, and
uninstall share the persisted setup language and receipt-owned resource model.

The broker always listens on `127.0.0.1`. Local operation is complete without
network software; cross-device connectivity is configured and owned separately
through a proxy, tunnel, VPN, mesh, or other forwarding layer. A one-time pairing
URL tells a client where to connect without becoming persisted broker state.
Tokdash quota tracking remains
optional and consented: setup reuses an existing instance or, when pipx is
available, can install and configure one without making broker installation
depend on it. The web app is mounted at `/cosy`; paired clients receive per-device
credentials, while the raw broker token remains a full-authority bootstrap
credential.

## Verification state

The public tree passes the required source-content policy with every retained
binary pinned to reviewed content. Hosted Linux, Android, macOS, iOS simulator,
Windows, web, broker, contract, and reusable-package jobs pass. The deterministic
broker aggregate registers every sub-suite bound by the verification
completeness anchor.

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
independently of the JavaScript distribution path.

The npm package is a different artifact and is no longer inside that gate. It
ships one self-contained JavaScript application bundle executed by a Bun runtime
the operator installs separately, with no embedded runtime and no compiled
executable — see
[npm JavaScript distribution readiness](../legal/npm-javascript-distribution-readiness.md).
`.github/workflows/npm-publish.yml` builds, verifies, and submits releases
through npm's protected staging and 2FA approval flow. Flutter-only Android,
Linux, Apple Silicon macOS, and Windows client downloads are published in the client
release; iOS/TestFlight remains deferred.

The signed JavaScript broker channel is live as of 0.5.3. It publishes a broker
bundle, web sidecar, installers and same-commit desktop clients with signed
metadata. The one-liners use `https://cosyncing.com/install.sh` and
`https://cosyncing.com/install.ps1`; broker-only variants use `install-server.sh`
and `install-server.ps1`. These website copies are version-pinned and must be
refreshed after each stable broker promotion. The release asset policy rejects
embedded-runtime brokers and bundled Bun archives; protected candidate and
promotion environments still apply.

Older `bootstrap-js` 0.5.2 builds must rerun the new installer because their
manifest parser requires a native artifact. Compiled native installations with
schema-1 receipts cannot migrate this way; follow the
[installer migration guidance](../installation/script-install.md#migrating-older-installer-owned-brokers).

Keep `COSYNCING_BINARY_RELEASE_LEGAL_APPROVED` unset. Any future compiled broker
distribution still requires the documented dated approval. Local native builds
and ephemeral CI packaging remain engineering evidence, not public releases.
