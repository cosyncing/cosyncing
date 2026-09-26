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
lineage. The one adapted package is listed under
[Copied or adapted material](#copied-or-adapted-material). `apps/poc-ui/` is
first-party retained test tooling, not a vendored application.

If copied or adapted third-party material is added later, its source, version,
license, modification status, and required notice must be recorded here before
merge.

## Copied or adapted material

| Path | Source | Version | License | Modified |
| --- | --- | --- | --- | --- |
| `packages/dart/flutter_local_notifications_windows/` | [`flutter_local_notifications_windows`](https://github.com/MaikuB/flutter_local_notifications/tree/master/flutter_local_notifications_windows) (pub.dev) | 3.1.1, forked as `3.1.1+cosyncing.1` | BSD-3-Clause, Copyright 2024 Michael Bui | Yes |

The Windows client uses this fork through `dependency_overrides`. The fork
keeps upstream's `LICENSE` unchanged, and marks every change `cosyncing:` in
the source. Its `README-fork.md` lists the changes, the upstream files it left
out, and how to update it. Flutter bundles the package's `LICENSE` into the
client's licence notices, so the BSD notice ships with the compiled plugin.
