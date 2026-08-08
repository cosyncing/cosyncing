# Workflow coverage map

The active `.github/workflows` tree uses the public GitHub-hosted profile.
`.github/workflow-mode` records `public-hosted`, and the workflow audit rejects
self-hosted runner selection. The tracked workflows are the canonical profile;
the retired private profile is preserved only in the private internal-docs
archive. The table below describes the active coverage.

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
| Broker deterministic CI | `ci.yml` / broker and contracts | yes | Every registered deterministic sub-suite passes |
| Broker native package lanes | `broker-release-gate.yml` | yes | Hosted x64/arm64 outputs hash successfully |
| Broker candidate staging | `broker-release.yml` | tag only | Protected draft-release flow succeeds |
| Broker stable promotion | `broker-release-promote.yml` | manual | Protected exact-asset verification succeeds |
| Private-network/hardware evidence | optional maintainer validation | no | Never a merge or release dependency |

No predecessor coverage was retired merely because a runner disappeared.
Each hosted replacement passed before the private workflow profile was removed
from the public lineage.

Repository rulesets require only `CI required` and `Broker Release Gate
required`. Their always-running dependency checks cover the matrix rows above.
