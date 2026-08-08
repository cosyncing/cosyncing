# Workflow coverage map

During private development, `.github/workflows` uses the same workflow names,
steps, permissions, and coverage on generic self-hosted platform labels. The
exact public hosted profile is saved under
`scripts/ci/github-hosted-workflows/`. Run
`scripts/ci/restore-github-hosted-workflows.sh` and commit the resulting diff
before visibility changes. The table below describes the required public
destination.

| Predecessor gate | Consolidated destination | Required | Removal condition |
|---|---|---:|---|
| Client hosted analysis/test | `ci.yml` / Flutter analysis and tests | yes | Hosted lane passes on private default branch |
| Reusable Dart package suites | `ci.yml` / Dart package matrix | yes | All package analysis and tests pass independently |
| Client web gate | `ci.yml` / Flutter analysis and tests | yes | Hosted web build passes |
| Client Linux/Android personal lanes | `ci.yml` / Linux and Android matrix | yes | Hosted platform builds pass |
| Client macOS/iOS personal lane | `ci.yml` / Apple matrix | yes | Hosted platform builds pass |
| Client Android/macOS/iOS runtime smoke | `platform-runtime.yml` / hosted emulator and simulator lanes | no | Each hosted lane passes before runtime support is advertised; never depends on a personal runner |
| Client Windows gate | `ci.yml` / Windows build | yes | Hosted Windows build passes |
| Client sibling contract sync | `ci.yml` / broker and contracts | yes | Same-checkout diff gate passes |
| Broker deterministic CI | `ci.yml` / broker and contracts | yes | Hosted aggregate passes 16/16 |
| Broker native package lanes | `broker-release-gate.yml` | yes | Hosted x64/arm64 outputs hash successfully |
| Broker candidate staging | `broker-release.yml` | tag only | Protected draft-release flow succeeds |
| Broker stable promotion | `broker-release-promote.yml` | manual | Protected exact-asset verification succeeds |
| Private-network/hardware evidence | optional maintainer validation | no | Never a merge or release dependency |

No predecessor workflow may be deleted merely because its runner disappeared.
Coverage moves first; the predecessor is retired only after its named hosted
replacement passes.

Repository rulesets require only `CI / required` and `Broker Release Gate /
required`. Their always-running dependency checks cover the matrix rows above.
