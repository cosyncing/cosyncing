# Compiled broker distribution readiness

Source publication and public pull-request CI do not authorize distribution of
compiled broker executables.

## What this document governs

This control governs distribution of **compiled native broker executables** —
artifacts produced by `bun build --compile`, which embed a copy of the Bun
runtime. Everything below applies to those artifacts and to any distribution
channel that carries them.

It does not govern the reviewed Bun-JavaScript npm package, which is a different
artifact: one self-contained JavaScript application bundle, executed by a Bun
runtime the operator installs separately. That package contains no Bun, no
JavaScriptCore, and no WebKit, so the static-linking and relinking obligations
described below are not engaged by it. Its own engineering readiness record is
[npm JavaScript distribution readiness](npm-javascript-distribution-readiness.md).

Nothing here is narrowed by that distinction. If a compiled native executable is
ever added back to any channel — including npm — this control applies to that
channel again in full.

The broker currently uses `bun build --compile`. Bun documents that a standalone
executable contains a copy of the Bun runtime. The pinned Bun 1.3.8 licence also
states that Bun statically links JavaScriptCore and WebKit under LGPL-2 and that
static linking requires providing the application in an object form that permits
modification and relinking.

The repository carries the exact upstream Bun 1.3.8 `LICENSE.md` at
`docs/legal/bun-1.3.8-LICENSE.md`. Its SHA-256 is
`7068a9711ef8196d654e143447ed7976b3678ce21145b9da16e1f786528f15bb`.
The release assembler verifies that hash and includes the file in generated
third-party notices. This preserves the upstream notice; it does not by itself
satisfy or resolve the relinking obligation.

## Fail-closed release rule

Candidate creation and stable promotion require the protected configuration
variable `COSYNCING_BINARY_RELEASE_LEGAL_APPROVED=true`. Keep it absent or set to
any other value until a dated review records one of these outcomes:

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
for ephemeral CI and for a future approved standalone release. The npm lane does
not call it: `scripts/release/build-npm-package.ts` refuses any staged artifact
carrying an ELF, Mach-O, or PE header, and `scripts/ci/audit-workflows.sh`
refuses an npm workflow that references the native builder or `--compile`.

This document is an engineering release control, not legal advice.
