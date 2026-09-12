# Third-party license inventory

First-party source is Apache-2.0. Runtime and development dependencies retain
their own licenses as declared in `bun.lock`, `pubspec.lock`, and upstream
packages. Signed JavaScript broker releases generate `software-inventory.json`
and an SPDX SBOM for the broker dependency closure, including the reviewed
`@clack/prompts` dependency closure. They identify web and desktop archives
separately, with their Flutter/plugin notices retained inside each archive.
Candidate assembly emits `THIRD_PARTY_NOTICES.txt` from the exact licence file
of every external JavaScript package. These assets are covered by signed
checksums. Bun is an external requirement installed directly from upstream or
reused on the host; no runtime archive or embedded-runtime broker is distributed
in that release. Its notices therefore omit Bun's licence section.

The optional compiled-notice generator retains the exact pinned Bun 1.3.8
licence for ephemeral native tests and any future approved native distribution.
It does not make that blocked distribution eligible for publication.

The npm package is a separate artifact with a separate notice file. It ships one
JavaScript application bundle and no runtime, so its `THIRD_PARTY_NOTICES.txt`
carries the licence text of every bundled external package and omits Bun's —
Bun is not distributed in it. See
[npm JavaScript distribution readiness](npm-javascript-distribution-readiness.md).

This inventory is not a determination that compiled-binary redistribution
obligations are satisfied. Bun states that its runtime statically links LGPL-2
JavaScriptCore/WebKit and identifies a relinking obligation. Compiled native
broker distribution is fail-closed until the conditions in
[Compiled broker distribution readiness](binary-distribution-readiness.md) are
met and explicitly approved.

The project was informed by the MIT-licensed Happy Coder project, credited in
NOTICE. No third-party research PDFs, papers, screenshots, fonts, archived
plugins, or predecessor `thirdparty/` trees are distributed from this public
lineage. `apps/poc-ui/` is first-party retained test tooling, not a vendored
application.

If copied or adapted third-party material is added later, its source, version,
license, modification status, and required notice must be recorded here before
merge.
