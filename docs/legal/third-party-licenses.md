# Third-party license inventory

First-party source is Apache-2.0. Runtime and development dependencies retain
their own licenses as declared in `bun.lock`, `pubspec.lock`, and upstream
packages. Broker releases generate `software-inventory.json`; the release gate
checks the embedded Bun runtime and the `@clack/prompts` dependency closure.
Candidate assembly also emits `THIRD_PARTY_NOTICES.txt` from the exact,
hash-pinned Bun 1.3.8 `LICENSE.md` and the licence file of every external package
in the compiled inventory; those generated assets are covered by signed
checksums.

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
