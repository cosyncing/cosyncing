# npm JavaScript distribution readiness

This is an engineering distribution-readiness record for the `cosyncing` npm
package. It is not legal advice and it does not authorize anything that
[Compiled broker distribution readiness](binary-distribution-readiness.md)
governs.

Status: **released**. The npm `latest` version is published only through the
protected trusted-publisher and staged-approval path described below. Check the
registry when an exact current version is required; this control record does
not duplicate mutable release metadata.

## What is distributed

One npm package named `cosyncing`, containing:

- `bin/cosyncing` — a single self-contained JavaScript application bundle,
  produced by `scripts/broker/build-broker-bundle.ts` with `bun build
  --target=bun` and **without** `--compile`. It begins with `#!/usr/bin/env bun`
  and is plain text.
- `bin/cosyncing-web-<version>/` — the packaged Flutter web client served at
  `/cosy/`, validated by the same closed-set check the signed release sidecar
  uses.
- `README.md`, `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.txt`.

Both `cosyncing` and `cosy` are npm `bin` entries pointing at that one file.
There are no `dependencies`, no `optionalDependencies`, no platform packages,
and no install or postinstall script.

## What is not distributed

The package contains no Bun runtime, no JavaScriptCore, no WebKit, and no
compiled broker executable for any platform. Bun remains a runtime prerequisite
that the operator installs separately.

This is the material difference from the abandoned native npm design, which
would have carried per-platform `bun build --compile` executables. Those embed a
copy of the Bun runtime, which is what engages the static-linking and relinking
conditions recorded in the compiled-distribution control.

Bun's documentation distinguishes the two outputs: `target: "bun"` produces a
JavaScript bundle intended for the Bun runtime, while `--compile` produces a
standalone executable containing a copy of that runtime:

- [Bun bundler targets](https://bun.sh/docs/bundler#target)
- [Bun single-file executables](https://bun.sh/docs/bundler/executables)

## Third-party notices

The generated notices do not list Bun because Bun is not a component of this
artifact. The package still carries notices for the JavaScript dependencies
bundled into the application.

`createJavaScriptThirdPartyNotices` in
`scripts/broker/release/software-inventory.ts` emits `THIRD_PARTY_NOTICES.txt`
from the exact licence text of every external package in the bundled closure —
the same per-package extraction the compiled lane uses, with the Bun section
omitted because Bun is not being distributed. At the time of writing, that
closure is the `@clack/prompts` and `qrcode` dependency trees, all MIT.

The generated file states plainly that the package contains no Bun runtime,
JavaScriptCore, or WebKit, so the notice cannot drift from what is shipped.

This section records what the packaging lane does. It is not a determination
that every applicable obligation is satisfied; that judgment is the owner's.

## Supported hosts

`linux-x64`, `linux-arm64`, and `darwin-arm64`, single-sourced in
`packages/typescript/broker/src/installation/supported-hosts.ts`.

A universal JavaScript bundle runs anywhere a supported Bun runs, so the
supported set is now stated and enforced rather than implied by which compiled
artifacts happen to exist. npm `os`/`cpu` exclude Windows. They cannot exclude
Intel macOS without also excluding Apple Silicon — the two fields are
independent lists — so `cosyncing doctor` fails `host.platform` with
`host-architecture-unsupported` on `darwin-x64`, and the package README says so
before install.

## Update model

The package manager owns acquisition. `cosyncing upgrade` does not download or
swap a compiled artifact for this distribution; it returns
`upgrade-package-manager-owned` naming `npm update --global cosyncing` followed
by `cosyncing setup`. The same fence blocks the app-triggered update path and
suppresses the signed-release probe, so no surface reports that a native update
is available or was applied.

A signed self-update channel for the JavaScript distribution is explicitly not
implemented and is out of scope for this record.

## Enforcement

These properties are checked, not asserted:

- `scripts/broker/tests/release/test-npm-package.ts` — one staged package, no
  platform packages or dependency fields, no install script, a Bun-shebang
  JavaScript entry, no ELF/Mach-O/PE member anywhere in the tarball, a real
  offline global install running both command names, the bundled `/cosy/` client
  resolving, the upgrade refusal, README contents, and byte-identical rebuilds
  from pinned inputs. It also proves the builder refuses a compiled artifact —
  including a real one built by the native builder.
- `packages/typescript/broker/test/broker/test-application-identity.ts` — the application
  and the runtime never collapse into one path.
- `scripts/ci/audit-workflows.sh` — the npm workflow may not reference the native
  builder or `--compile`, may not carry a stored npm credential, and may not
  publish without an explicit typed confirmation.

## Publication control

`.github/workflows/npm-publish.yml` **stages**; it never makes a version
installable. It runs `npm stage publish` through npm trusted publishing (OIDC),
with `id-token: write` and no stored credential. Staging requires all four of:
the canonical repository at the exact `npm-v<version>` release tag, a `version`
input equal to the committed `package.json`, the literal confirmation phrase
`PUBLISH`, and approval of the protected `npm-production` environment.
Dispatching the workflow alone verifies a candidate and stages nothing.

A staged version sits in npm's staging queue until a maintainer runs
`npm stage approve <stage-id>` and answers a 2FA challenge. That step is
deliberately outside CI: a proof of presence CI could satisfy would not be one.
`npm stage reject <stage-id>` discards a candidate instead.

Owner approval boundary: two, in series — the `npm-production` environment's
required reviewers, then the 2FA approval on npmjs.com. Nothing upstream of
either gate can publish.

Requirements were verified against the official npm documentation:
<https://docs.npmjs.com/trusted-publishers/>,
<https://docs.npmjs.com/staged-publishing/>, and the staged-publishing general
availability announcement at
<https://github.blog/changelog/2026-05-22-staged-publishing-and-new-install-time-controls-for-npm/>.
These record `id-token: write`, npm CLI >= 11.15.0 for `npm stage`,
Node >= 22.14.0, and that provenance for a staged package is at parity with a
direct publish and is generated without a `--provenance` flag.

### Registry-side configuration this workflow requires

Two settings live on the hosting services, not in this repository, and neither
is provable from the tree:

1. the npm trusted publisher for `cosyncing` is bound to this repository and to
   the workflow filename `npm-publish.yml`, and is configured to allow
   **staging only** — so a direct `npm publish` is refused by the registry as
   well as by the workflow audit;
2. the `npm-production` GitHub environment has required reviewers **and** a
   deployment branch/tag rule limiting it to `npm-v*` tags.

The required `npm-production` configuration is environment review plus a custom
deployment tag rule for `npm-v*`. A production release has completed the
trusted staged-publishing and interactive approval path. Registry-side trusted-
publisher permissions remain external state and must be checked before each
release.

The in-repository guard `scripts/ci/require-canonical-npm-release.sh` enforces
the repository and exact release tag independently of the external settings.
This defense remains required: it stops a stray dispatch before the
environment's reviewers are asked. Confirm the registry-side trusted publisher
on npmjs.com before each release.

## Ongoing release rule

Every new version must use the protected trusted-publisher workflow and staged
approval path. Never publish manually, reuse a version, or add a compiled
executable to this package. Any change that redistributes a runtime or native
component, or changes the bundled third-party closure, requires a fresh
engineering and licence review before publication.
