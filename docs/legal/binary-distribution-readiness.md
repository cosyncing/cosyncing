# Compiled broker distribution readiness

Source publication and public pull-request CI do not authorize distribution of
compiled broker executables.

## What this document governs

This control governs distribution of **compiled native broker executables** —
artifacts produced by `bun build --compile`, which embed a copy of the Bun
runtime. Everything below applies to those artifacts and to any distribution
channel that carries them.

It does not govern the Bun-JavaScript npm package or the native-free signed
GitHub JavaScript release. Those distribute a JavaScript application bundle,
executed by a separately installed Bun runtime. The broker payloads contain no
Bun, JavaScriptCore, or WebKit. The compiled
broker relinking control below therefore does not gate that JavaScript packaging
path; this distinction is not a declaration of legal clearance. Each path has
its own control record:
[npm JavaScript distribution readiness](npm-javascript-distribution-readiness.md)
and [Broker release and signing](../release/broker-release-signing.md).

Nothing here is narrowed by that distinction. If a compiled native executable is
ever added back to any channel — including npm — this control applies to that
channel again in full.

The optional native broker builder uses `bun build --compile`. Bun documents
that a standalone executable contains a copy of the Bun runtime. The pinned Bun 1.3.8 licence also
states that Bun statically links JavaScriptCore and WebKit under LGPL-2 and that
static linking requires providing the application in an object form that permits
modification and relinking.

The repository carries the exact upstream Bun 1.3.8 `LICENSE.md` at
`docs/legal/bun-1.3.8-LICENSE.md`. Its SHA-256 is
`7068a9711ef8196d654e143447ed7976b3678ce21145b9da16e1f786528f15bb`.
The compiled-notice generator verifies that pin and includes the file in native
third-party notices. JavaScript release notices omit it because Bun is external.
Preserving the upstream notice does not by itself satisfy or resolve the
relinking obligation.

## Fail-closed release rule

Any candidate creation or stable promotion that distributes an embedded-runtime
broker requires the protected configuration variable
`COSYNCING_BINARY_RELEASE_LEGAL_APPROVED=true`. Keep it absent or set to any
other value until a dated review records one of these outcomes:

- the release provides the required relinkable object materials, corresponding
  source and licence texts, with tested reconstruction instructions;
- the compiled broker no longer embeds the Bun runtime and the replacement
  distribution architecture has its own completed licence review; or
- qualified legal review documents why the proposed compiled distribution and
  accompanying materials satisfy the applicable obligations.

The approval record must identify the reviewed Bun version, targets, release
asset set, source/material retention period, and the person responsible for
future runtime-version reviews. Any Bun version or packaging-model change clears
the approval and requires a new review.

Ephemeral CI compilation and local packaging tests may continue. Do not create a
public prerelease, stable release, package-manager distribution, or other
permanent compiled-binary distribution of a native executable while the gate is
closed.

`scripts/broker/build-broker.ts` remains in the repository and remains buildable
for ephemeral CI and for a future approved standalone release. Neither JavaScript
publication lane calls it: `scripts/release/build-npm-package.ts` refuses any
staged artifact carrying an ELF, Mach-O, or PE header, and
`scripts/ci/audit-workflows.sh`
refuses JavaScript publication workflows that reference the native builder or
`--compile`. Signed GitHub staging, assembly and promotion additionally enforce
flat exact asset inventories and parse the broker payload as JavaScript, so an
executable renamed to `cosyncing-app.js` is rejected. Expected Flutter desktop
client archives are allowed. Bun runtime archives are downloaded directly from
upstream by installers and are never cosyncing release assets.

Keep `COSYNCING_BINARY_RELEASE_LEGAL_APPROVED` unset for this path. Introducing
embedded-runtime broker distribution later requires a reviewed new asset policy
and the protected approval gate above; setting the variable does not bypass the
current JavaScript asset policy. See
[Broker release and signing](../release/broker-release-signing.md) for the
native-free candidate controls and older-installer migration boundary.

This document is an engineering release control, not legal advice.
